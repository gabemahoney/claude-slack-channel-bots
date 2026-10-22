/**
 * reload-plan.ts — The structured change plan and the pending-change preview
 *
 *
 * `buildChangePlan` classifies a candidate configuration against the applied
 * one, persona by persona and setting by setting, in the terms of the
 * table: added, removed, destructively modified, modified in place, changed
 * credentials, next-launch changes (own or inherited) and unchanged, plus the
 * changed server-wide settings. Both channel modes use the same list and
 * destination; a change of the switch has a line of its own
 * (`modeSwitchLine`). The reload detection tick builds it every
 * pass, and a confirmed apply (`reload-apply.ts`) acts on the plan that pass
 * built from the confirmed bytes, never a second diff, so what is applied is
 * what was previewed.
 *
 * The preview is rendered from the plan, never from a second diff:
 * - `renderPreview` / `renderPreviewLines`: the body of `config.json.pending`.
 * A header with the counts (`changePlanCounts`,
 *   `renderChangePlanCounts`, reused by the `reload-applied` line), then one
 *   line per affected persona and changed setting; removals and destructive
 *   modifies start with `DESTRUCTIVE:` and say the persona will be retired:
 *   its session stopped and never resumed, and a destructive modify's brought
 * up fresh (`removedLine`, `destructiveLine`). An invalid
 *   candidate renders one `INVALID` line, a plan with no effect `no effective
 *   change`;
 * - `renderPreviewLogLines`: the same lines, each classed `reload-preview`
 * (one class label per line);
 * - `renderInvalidLogLine`: the one `reload-invalid` line of an invalid
 *   candidate.
 *
 * Pure: nothing here reads or writes a file, calls Slack or
 * agent-director, arms a timer, logs or holds state, and nothing runs at
 * import. Every fact that needs I/O (real paths, credentials digests and
 * local validity, the bring-up state, whether an added persona can come up)
 * is passed in by the caller. The same plan always renders the same text.
 * The plan and every output hold persona keys and names, paths and setting
 * names only: never a token, credentials content or a digest.
 *
 * SPDX-License-Identifier: MIT
 */

import { queueRetentionClause } from './reload-preview-clauses.ts'
import { REVIEW_OMISSION_CLAUSE, REVIEW_FUTURE_CLAUSE, REVIEW_RESET_CLAUSE, REVIEW_RETENTION_CLAUSE, REVIEW_ABSENCE_REPLACEMENT } from './reload-preview-clauses.ts'
import type { ReviewedChannelEffect } from './shared-channels.ts'
import type { MembershipReading } from './channel-membership.ts'
import { channelDeliveryFor } from './delivery-decision.ts'
import { reviewIntentLine } from './reload-request.ts'
import {
  channelModeOf,
  configReadFailurePredicate,
  PERSONA_TOP_LEVEL_KEYS,
  SERVER_PATH_SETTINGS,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import { isCredentialsBroken, type PersonaBringUpState } from './persona-bringup-controller.ts'
import type { CredentialsDigest } from './persona-credentials.ts'
import { escapeCause } from './persona-diagnostics.ts'
import { effectiveClaudeConfigDirs, renderPersonaRef } from './persona-identity.ts'
import { DESTRUCTIVE_PREFIX, DESTRUCTIVE_RETIRED_CLAUSE, REMOVED_RETIRED_CLAUSE } from './reload-preview-clauses.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes; listed in `RELOAD_DIAGNOSTIC_CLASSES`
// ---------------------------------------------------------------------------

/**
 * The pending-change preview of a valid candidate, logged once per change of
 * the pending state: every line of the preview carries this class.
 */
export const RELOAD_PREVIEW = 'reload-preview'

/**
 * A pending candidate that is invalid (it fails validation, or the
 * configuration file is missing or unreadable while a record exists): one
 * line with the full validation error, logged once per change of the pending
 * state. Nothing will be applied.
 */
export const RELOAD_INVALID = 'reload-invalid'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What a confirmed apply would apply: the configuration file as it stands. */
export type ChangePlanCandidate =
  /** Valid in default mode (full real-path checks). */
  | { kind: 'valid'; config: PersonaConfig }
  /**
   * Fails validation; `error` is the loader's full message (a parse error
   * with its line and column), which echoes no rejected value and no key
   * name that could be a token.
   */
  | { kind: 'invalid'; error: string }
  /** The configuration file at `path` is missing or cannot be read while a record exists. */
  | { kind: 'unreadable'; path: string; missing: boolean; code: string | undefined }

/**
 * A fact the caller tried to gather and could not (its query or check threw):
 * the plan records it as not known, and the preview says it could not be
 * checked rather than claiming either answer.
 */
export const FACT_UNKNOWN = 'unknown'

/** The marker of a fact that could not be gathered. */
export type FactUnknown = typeof FACT_UNKNOWN

/**
 * Why an added persona cannot come up: one failed local bring-up check (
 * steps 1 and 2, and the claude_config_dir check its bring-up runs
 * before step 3).
 */
export interface AddedPersonaCause {
  step: 'credentials' | 'working-directory' | 'claude-config-dir'
  /** The step's cause, as its check words it: token-free, never file content. */
  cause: string
}

/**
 * The facts `buildChangePlan` needs that depend on I/O, gathered by the
 * caller. Every lookup is pure from the plan's side and may be called any
 * number of times.
 */
export interface ChangePlanFacts {
  sharedReview?: { generation: number; channels: ReviewedChannelEffect[] }
  membership?(key: string, channel: string, mode: ChannelMode): MembershipReading
  /** External open-item fact; this planner performs no queue I/O. */
  queueOpenCount?(key: string): number
  /**
   * The comparison form of a configured path (production:
   * `resolveRealPath`): the only source of path identity. Consulted only to
   * compare two paths written differently; two equal strings are the same
   * path.
   */
  realPath(path: string): string
  /**
   * The home directory Claude's default config directory (`<home>/.claude`)
   * is resolved under for `configDirsChanged`: the one the agent-director
   * template is written with. The OS home, read at call time, when omitted.
   */
  home?: string
  /**
   * Dry run: no credentials file is read, and
   * credentials never count as changed. Default false.
   */
  dryRun?: boolean
  /**
   * The digest or marker of the credentials file at `path` as it stands
   * (`credentialsDigest`), by the path as the configuration names it
   * (absolute, tilde-expanded); undefined when it was not read.
   */
  currentCredentialsDigest?(path: string): CredentialsDigest | undefined
  /**
   * The digest or marker held for an applied persona: what its bring-up
   * connected with, is retrying with or broke with; undefined when nothing is
   * held.
   */
  heldCredentialsDigest?(key: string): CredentialsDigest | undefined
  /**
   * Why the credentials file at `path`, as it stands, is not locally valid
   * (missing, unreadable, or bad shape or prefix), worded as the credentials
   * check words it (production: `credentialsReadProblem` over the bytes the
   * pass already read); undefined when it is valid or was not read. Consulted
   * only for a credentials-changed persona. Token-free: never file content.
   */
  credentialsProblem?(path: string): string | undefined
  /**
   * An applied persona's current bring-up state (its outcome and causes);
   * undefined for a persona the controller does not know (not broken);
   * `FACT_UNKNOWN` when the state could not be queried.
   */
  bringUpState?(key: string): Pick<PersonaBringUpState, 'outcome' | 'causes'> | FactUnknown | undefined
  /**
   * For each added persona, by key, the causes that stop it coming up
   * (credentials first), or `FACT_UNKNOWN` when they could not be checked. An
   * added persona absent here, or with no causes, is taken to come up.
   */
  addedCannotComeUp?: ReadonlyMap<string, readonly AddedPersonaCause[] | FactUnknown>
  /**
   * Why a candidate persona's effective claude_config_dir cannot be resolved
   * to a real path, as the claude_config_dir check its bring-up and launch
   * run words it (its `problem`; production: `checkConfigDir`, the
   * one the added-persona check uses); undefined when it resolves, a
   * directory not created yet under a resolvable ancestor included;
   * `FACT_UNKNOWN` when it could not be checked. Consulted only for a persona
   * present in both configurations whose effective claude_config_dir changed
   * (its own, or through the top-level default it inherits; a destructive
   * modify included). Absent: nothing is known to stop them.
   */
  configDirProblem?(persona: Persona): string | FactUnknown | undefined
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** A persona in a plan: its key, its name and its position in the configuration it comes from. */
export interface ChangePlanPersonaRef {
  key: string
  name: string
  /** Its index in the candidate's `personas` (the applied set's for a removed persona). */
  index: number
}

/**
 * The settings whose change retires a persona:
 * its session is stopped and never resumed, its key recorded as retired at
 * apply step 1, and it is brought up fresh. In the order they are
 * reported.
 */
export const DESTRUCTIVE_SETTINGS = ['name', 'credentials_file', 'working_directory'] as const

/** A setting whose change retires the persona and brings it up fresh. */
export type DestructiveSetting = (typeof DESTRUCTIVE_SETTINGS)[number]

/**
 * The settings applied in place, immediately,
 * in the order they are reported. Both modes use the same channel list,
 * destination, DM and reply reminder settings.
 */
export const IN_PLACE_SETTINGS = [
  'channels',
  'delivery',
  'permission_prompts',
  'dm.enabled',
  'dm.contact',
  'stop_hook_bootstrap',
] as const

/** A setting applied in place. `channels`: the set of channel IDs; `delivery`: a kept channel's mode. */
export type InPlaceSetting = (typeof IN_PLACE_SETTINGS)[number]

/** The server-wide setting that picks the channel mode; it has a preview line of its own. */
export const MODE_SWITCH_SETTING = 'channel_mode'

/** The settings that take effect at the persona's next launch, in the order they are reported. */
export const NEXT_LAUNCH_SETTINGS = ['claude_config_dir'] as const

/** A setting that takes effect at the persona's next launch, set on the persona or inherited. */
export type NextLaunchSetting = (typeof NEXT_LAUNCH_SETTINGS)[number]

/** An added persona. */
export interface AddedPersonaChange extends ChangePlanPersonaRef {
  /**
   * Why it cannot come up, credentials first; empty when nothing known stops
   * it; undefined when whether it can come up could not be checked.
   */
  cannotComeUp: AddedPersonaCause[] | undefined
}

/**
 * Why a persona whose effective claude_config_dir changed cannot come up with
 * the new one: the claude_config_dir check's problem (`ChangePlanFacts.configDirProblem`),
 * or `FACT_UNKNOWN` when it could not be checked. Absent when the directory
 * did not change or resolves.
 */
export type ConfigDirUnresolvable = string | FactUnknown

/**
 * A persona whose `name`, `credentials_file` or `working_directory` (by real
 * path) changed: retired (its key recorded at apply step 1, its session
 * stopped and never resumed), then brought up fresh.
 */
export interface DestructivePersonaChange extends ChangePlanPersonaRef {
  /** The changed settings, in `DESTRUCTIVE_SETTINGS` order. */
  settings: DestructiveSetting[]
  /** The candidate's `credentials_file`. */
  credentials_file: string
  /** The candidate's `working_directory`. */
  working_directory: string
  /**
   * Its effective claude_config_dir changed too (by real path) and cannot be
   * resolved, or could not be checked: the bring-up at apply holds it.
   */
  configDirUnresolvable?: ConfigDirUnresolvable
}

/** A persona with settings applied in place. */
export interface InPlacePersonaChange extends ChangePlanPersonaRef {
  /** The changed settings, in `IN_PLACE_SETTINGS` order. */
  settings: InPlaceSetting[]
}

/** A persona whose credentials file, at the same path, has changed content. */
export interface CredentialsPersonaChange extends ChangePlanPersonaRef {
  /** The credentials file, as the candidate names it. */
  path: string
  /**
   * The persona is currently broken by its credentials: it is brought up at
   * apply rather than reconnected (step 6). Undefined when its
   * bring-up state could not be queried.
   */
  credentialsBroken: boolean | undefined
  /**
   * The persona is retrying its bring-up (Slack-unreachable,
   * directory-broken, or held for its claude_config_dir), or its
   * first Slack attempt is in flight: it has no connection and retries with
   * the new content, or, when the new content is not locally
   * valid, with its current content. Undefined when its bring-up state could
   * not be queried.
   */
  retrying?: boolean
  /**
   * Why the new content is not locally valid (the file is missing, unreadable
   * or locally invalid), as the credentials check words it; undefined when it
   * is valid. For a persona that is up, applying it keeps the current
   * connection and logs `persona-credentials-change-failed`; a
   * credentials-broken persona stays broken. Token-free.
   */
  problem?: string
}

/** A persona whose next launch changes. */
export interface NextLaunchPersonaChange extends ChangePlanPersonaRef {
  /** Settings the persona's own entry changed, in `NEXT_LAUNCH_SETTINGS` order. */
  own: NextLaunchSetting[]
  /** Settings that changed through the top-level default it inherits, in `NEXT_LAUNCH_SETTINGS` order. */
  inherited: NextLaunchSetting[]
  /**
   * Its claude_config_dir changed (own or inherited) to one that cannot be
   * resolved, or could not be checked: at its next launch it is held (its
   * Slack connection closed, its launch waiting until the directory
   * resolves) instead of coming up.
   */
  configDirUnresolvable?: ConfigDirUnresolvable
}

/** A persona an inherited default reaches: its reference, and for `claude_config_dir` whether the new directory stops it. */
export interface InheritingPersonaRef extends ChangePlanPersonaRef {
  /** See `NextLaunchPersonaChange.configDirUnresolvable`; only for `claude_config_dir`. */
  configDirUnresolvable?: ConfigDirUnresolvable
}

/** A changed server-wide setting, compared by resolved value (paths by real path). */
export interface ServerSettingChange {
  /** The top-level key. */
  name: string
  /**
   * For inherited defaults (`claude_config_dir`, `stop_hook_bootstrap`):
   * the personas, present in both configurations and not destructively
   * modified, whose value changes through it, in candidate order. Absent for
   * any other setting.
   */
  inheritedBy?: InheritingPersonaRef[]
  /**
   * For the switch (`channel_mode`, ) only: the
   * channel mode the change turns on. Absent for any other setting.
   */
  mode?: ChannelMode
  /**
   * For the switch only: every persona present in both configurations, in
   * candidate order, each of which the mode turned on applies to in place.
   * Absent for any other setting.
   */
  personas?: ChangePlanPersonaRef[]
}

/** The plan of a valid candidate. */
export interface ValidChangePlan {
  /** Safe, deterministic facts from the same authority merge used at apply. */
  sharedReview?: { generation: number; channels: ReviewedChannelView[] }
  valid: true
  /** Candidate personas whose key the applied set lacks, in candidate order. */
  added: AddedPersonaChange[]
  /** Applied personas whose key the candidate lacks, in applied order. */
  removed: Array<ChangePlanPersonaRef & { queueOpenCount?: number }>
  /** In candidate order; never also in `inPlace`, `credentials` or `nextLaunch`. */
  destructive: DestructivePersonaChange[]
  /** In candidate order. */
  inPlace: InPlacePersonaChange[]
  /** In candidate order. Never set in dry run or when nothing is held. */
  credentials: CredentialsPersonaChange[]
  /** In candidate order. */
  nextLaunch: NextLaunchPersonaChange[]
  /** Candidate personas present in both with nothing changed, in candidate order. */
  unchanged: ChangePlanPersonaRef[]
  /** In the fixed order of the top-level keys. */
  settings: ServerSettingChange[]
  /**
   * True exactly when every persona is unchanged and no server-wide setting
   * changed.
   */
  noEffectiveChange: boolean
  /**
   * The set of effective config directories differs between the applied and
   * the candidate personas (each persona's own `claude_config_dir`, else the
   * inherited one, else `<home>/.claude`): the apply refreshes the
   * agent-director template (step 5). Not rendered in the
   * preview. Compared lexically resolved (`effectiveClaudeConfigDirs`), not by
   * real path: the template's memory-read rules are written from the lexical
   * paths, so a move to another path that is a symlink to the same directory
   * still changes the template text and must refresh it.
   */
  configDirsChanged: boolean
}

/** The plan of an invalid candidate: nothing will be applied. */
export interface InvalidChangePlan {
  valid: false
  candidate: Exclude<ChangePlanCandidate, { kind: 'valid' }>
  /** The full validation error, or the sentence saying the configuration file is missing or unreadable. */
  error: string
  /** Nothing will be applied, so no template refresh either. */
  configDirsChanged: false
}

/** The structured change plan. */
export type ChangePlan = ValidChangePlan | InvalidChangePlan

export interface ReviewedChannelView extends ReviewedChannelEffect {
  membership: MembershipReading
  currentEffective: string
  effective: string
  activatesInStrict: boolean
}
function reviewedChannelViews(applied: PersonaConfig, next: PersonaConfig, facts: ChangePlanFacts): ReviewedChannelView[] {
  return (facts.sharedReview?.channels ?? []).map(effect => {
    const membership: MembershipReading = effect.replacement ? { kind: 'unresolved', reason: 'current-membership-missing' } :
      facts.membership?.(effect.key, effect.channel, next.channel_mode) ?? { kind: 'unresolved', reason: 'current-membership-missing' }
    const delivery = next.channel_mode === 'open' ? channelDeliveryFor(effect.key, effect.channel, {
      fungibleDestinations: next.personas.map(persona => ({ key: persona.key, destination: persona.permission_prompts })),
      storedChoices: { readable: true, storedChoice: () => effect.reviewed },
    }).delivery : effect.reviewed
    const effective = effect.reviewed === undefined ? 'unlisted' : effect.reviewed === 'off' ? 'off' :
      membership.kind === 'eligible' ? delivery! : membership.kind === 'ineligible' ? `inactive (${membership.reason})` : `unverified (${membership.reason})`
    const before = facts.membership?.(effect.key, effect.channel, applied.channel_mode)
    const currentDelivery = applied.channel_mode === 'open' ? channelDeliveryFor(effect.key, effect.channel, {
      fungibleDestinations: applied.personas.map(persona => ({ key: persona.key, destination: persona.permission_prompts })),
      storedChoices: { readable: true, storedChoice: () => effect.saved },
    }).delivery : effect.saved
    const currentEffective = effect.saved === undefined ? 'unlisted' : effect.saved === 'off' ? 'off' :
      before?.kind === 'eligible' ? currentDelivery! : before?.kind === 'ineligible' ? `inactive (${before.reason})` : 'unverified'
    return { ...effect, membership, effective, currentEffective,
      activatesInStrict: applied.channel_mode === 'open' && next.channel_mode === 'strict' &&
        effect.reviewed === 'mentions' && membership.kind === 'eligible' && before?.kind === 'ineligible' && before.reason === 'external-sharing' }
  }).sort((a, b) => a.key.localeCompare(b.key) || a.channel.localeCompare(b.channel) || a.kind.localeCompare(b.kind))
}
export function reviewedChannelLine(channel: ReviewedChannelView): string {
  const { key, kind, saved, reviewed, replacement, membership, effective } = channel
  const intent = kind === 'declared' || kind === 'edited'
  const clauses = kind === 'reset' || (replacement && !intent) ? REVIEW_RESET_CLAUSE : replacement && intent ? REVIEW_RETENTION_CLAUSE :
    intent && membership.kind !== 'eligible' ? REVIEW_FUTURE_CLAUSE : kind === 'omitted' || kind === 'automatic' ? REVIEW_OMISSION_CLAUSE : ''
  const overwrite = intent && saved !== undefined && saved !== reviewed ? ' Deliberately overwrites the current saved choice.' : ''
  const sameValue = intent && (replacement ? channel.inherited : saved) === reviewed ? ' Explicit same-value assignment.' : ''
  return `Channel persona=${key} channel=${channel.channel}: ${kind}; saved=${saved ?? 'none'}; reviewed=${reviewed ?? 'none'}; ` +
    `saved order=${channel.previousOrder ?? 'none'}; membership=${membership.kind}; effective now=${channel.currentEffective}; reviewed effective=${effective}.${overwrite}${sameValue}${clauses ? ` ${clauses}` : ''}` +
    (channel.activatesInStrict ? ' The saved mentions choice becomes eligible in strict; the saved value is unchanged.' : '') +
    (channel.absenceReplacement ? ` ${REVIEW_ABSENCE_REPLACEMENT}` : '')
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The server-wide settings, in the fixed order they are reported. */
const SERVER_SETTINGS: readonly string[] = PERSONA_TOP_LEVEL_KEYS.filter((key) => key !== 'personas')

/** The server-wide settings that hold a path: compared by real path. */
const SERVER_PATH_SETTING_SET: ReadonlySet<string> = new Set<string>(SERVER_PATH_SETTINGS)

/** The top-level settings a persona inherits when its entry omits them. */
const INHERITED_DEFAULTS: ReadonlySet<string> = new Set<string>(NEXT_LAUNCH_SETTINGS)

function refOf(persona: Persona): ChangePlanPersonaRef {
  return { key: persona.key, name: persona.name, index: persona.index }
}

/**
 * The candidate personas whose key the applied set lacks, in candidate order.
 * Pure. These are the personas `buildChangePlan` classifies as added, so a
 * caller gathers the facts about them (`ChangePlanFacts.addedCannotComeUp`)
 * without building the plan first.
 */
export function addedPersonas(applied: PersonaConfig, candidate: PersonaConfig): Persona[] {
  const appliedKeys = new Set(applied.personas.map((p) => p.key))
  return candidate.personas.filter((p) => !appliedKeys.has(p.key))
}

/** The sentence an invalid candidate reports. */
function invalidCandidateError(candidate: Exclude<ChangePlanCandidate, { kind: 'valid' }>): string {
  if (candidate.kind === 'invalid') return candidate.error
  // `missing` decides "does not exist" even when the code alone would not.
  const what = candidate.missing ? 'does not exist' : configReadFailurePredicate(candidate.code)
  return `the configuration file ${JSON.stringify(candidate.path)} ${what}.`
}

/** Path identity through `facts.realPath`: equal strings, or equal comparison forms; an absent path equals only an absent one. */
function samePathWith(facts: ChangePlanFacts): (a: string | undefined, b: string | undefined) => boolean {
  return (a, b) => a === b || (a !== undefined && b !== undefined && facts.realPath(a) === facts.realPath(b))
}

/** Shared channel, destination, DM and reminder settings apply in place in either mode. */
function personaSectionChanges(before: Persona, after: Persona): InPlaceSetting[] {
  const was = new Map(before.channels.map((c) => [c.id, c.delivery]))
  const now = new Map(after.channels.map((c) => [c.id, c.delivery]))
  const changed: Record<InPlaceSetting, boolean> = {
    channels: was.size !== now.size || [...now.keys()].some((id) => !was.has(id)),
    delivery: [...now].some(([id, delivery]) => was.has(id) && was.get(id) !== delivery),
    permission_prompts: before.permission_prompts !== after.permission_prompts,
    'dm.enabled': before.dm.enabled !== after.dm.enabled,
    'dm.contact': before.dm.contact !== after.dm.contact,
    stop_hook_bootstrap: before.stop_hook_bootstrap !== after.stop_hook_bootstrap,
  }
  return IN_PLACE_SETTINGS.filter((setting) => changed[setting])
}

/** Two values of one server-wide setting are equal (paths by real path, anything else by JSON value). */
function sameSetting(name: string, a: unknown, b: unknown, samePath: ReturnType<typeof samePathWith>): boolean {
  if (SERVER_PATH_SETTING_SET.has(name)) {
    return samePath(typeof a === 'string' ? a : undefined, typeof b === 'string' ? b : undefined)
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A top-level setting's resolved value. */
function settingOf(config: PersonaConfig, name: string): unknown {
  return (config as unknown as Record<string, unknown>)[name]
}

/**
 * The own and inherited next-launch changes of a persona present in both
 * configurations. A change counts as inherited when the top-level default
 * changed and the persona's value followed it: equal to the applied default
 * before and to the candidate default after. Any other change is its own.
 */
function nextLaunchChanges(
  before: Persona,
  after: Persona,
  applied: PersonaConfig,
  candidate: PersonaConfig,
  samePath: ReturnType<typeof samePathWith>,
): { own: NextLaunchSetting[]; inherited: NextLaunchSetting[] } {
  const own: NextLaunchSetting[] = []
  const inherited: NextLaunchSetting[] = []
  for (const setting of NEXT_LAUNCH_SETTINGS) {
    const same = (a: unknown, b: unknown): boolean => sameSetting(setting, a, b, samePath)
    if (same(before[setting], after[setting])) continue
    const topBefore = settingOf(applied, setting)
    const topAfter = settingOf(candidate, setting)
    const followsDefault = !same(topBefore, topAfter) && same(before[setting], topBefore) && same(after[setting], topAfter)
    ;(followsDefault ? inherited : own).push(setting)
  }
  return { own, inherited }
}

/**
 * Whether the persona's credentials content changed at the same path: its
 * current digest differs from the one held for it. Never in dry run, and
 * never when nothing is held or the file was not read.
 */
function credentialsChanged(key: string, path: string, facts: ChangePlanFacts): boolean {
  if (facts.dryRun === true) return false
  const held = facts.heldCredentialsDigest?.(key)
  if (held === undefined) return false
  const current = facts.currentCredentialsDigest?.(path)
  return current !== undefined && current !== held
}

/**
 * Whether a persona's current bring-up state is credentials-broken; the bring-up controller's rule, which the apply's step bodies and
 * operations use too. Such a persona is brought up at apply rather than
 * reconnected (step 6).
 */
export { isCredentialsBroken }

/**
 * Whether the set of effective config directories of `candidate`'s personas
 * differs from `applied`'s (step 5). Both sets come from
 * `effectiveClaudeConfigDirs`, the one rule the agent-director template's
 * memory-read rules are written from: lexically resolved, never by real path,
 * because the template text follows the written path. A persona without one
 * contributes `<home>/.claude` (equal to an explicit `<home>/.claude`), and an
 * empty persona set contributes that default alone.
 */
function configDirsDiffer(applied: PersonaConfig, candidate: PersonaConfig, home: string | undefined): boolean {
  const before = effectiveClaudeConfigDirs(applied.personas, home)
  const after = effectiveClaudeConfigDirs(candidate.personas, home)
  return before.length !== after.length || before.some((dir, i) => dir !== after[i])
}

/**
 * Classify `candidate` against the `applied` configuration. Pure: reads no file, calls no Slack or
 * agent-director API, arms no timer and logs nothing; every I/O-derived fact
 * comes from `facts`.
 *
 * Personas are matched by key, so a `name` change that changes the key is a
 * removal of the old key and an addition of the new one. For a persona
 * present in both:
 * - destructively modified: its `name` (same key), `credentials_file` or
 *   `working_directory` (by real path) changed, so the confirmation retires
 * it and brings it up fresh. It is not also listed as
 *   modified in place, credentials-changed or next-launch: the new half reads
 *   everything fresh;
 * - modified in place: `channels` (the set of IDs), a kept channel's
 *   `delivery`, `permission_prompts`, `dm.enabled`, `dm.contact` or
 *   `stop_hook_bootstrap` changed. The same fields apply in both modes;
 * - credentials changed: same `credentials_file` by real path, and the
 *   current digest or marker differs from the held one (never in dry run or
 *   with nothing held). May come with in-place changes;
 * - next launch: `claude_config_dir` (by real path)
 *   changed, marked own or inherited (see `nextLaunchChanges`);
 * - otherwise unchanged.
 *
 * A persona whose effective `claude_config_dir` changed (a next-launch change,
 * own or inherited, or alongside a destructive modify) carries
 * `configDirUnresolvable` when `facts.configDirProblem` says the new directory
 * cannot be resolved, or could not be checked: the preview warns about it
 * as it does for an added persona that cannot come up. The change
 * is still applied as previewed.
 *
 * Server-wide settings are compared by resolved value, paths by real path. A
 * changed `claude_config_dir` lists the personas
 * that inherit the change. A changed `channel_mode` (absent and
 * `strict` are the same value) carries the mode it turns on and every persona
 * present in both configurations. `noEffectiveChange` holds
 * when nothing but unchanged personas remains: a whitespace or key-order
 * edit or a key added with its default value.
 *
 * `configDirsChanged` tells the apply whether to refresh the agent-director
 * template (step 5); it is not part of the preview.
 *
 * A fact the caller could not gather (`FACT_UNKNOWN`) is carried as unknown:
 * an added persona's `cannotComeUp`, or a credentials change's
 * `credentialsBroken` and `retrying`, is undefined.
 */
export function buildChangePlan(applied: PersonaConfig, candidate: ChangePlanCandidate, facts: ChangePlanFacts): ChangePlan {
  if (candidate.kind !== 'valid') {
    return { valid: false, candidate, error: invalidCandidateError(candidate), configDirsChanged: false }
  }

  const next = candidate.config
  const samePath = samePathWith(facts)
  const appliedByKey = new Map(applied.personas.map((p) => [p.key, p]))
  const nextKeys = new Set(next.personas.map((p) => p.key))
  // Both modes use the same fields; the switch has its own in-place line.
  const mode = channelModeOf(next)

  const plan: ValidChangePlan = {
    valid: true,
    added: [],
    removed: applied.personas.filter((p) => !nextKeys.has(p.key)).map(p => ({ ...refOf(p), queueOpenCount: facts.queueOpenCount?.(p.key) ?? 0 })),
    destructive: [],
    inPlace: [],
    credentials: [],
    nextLaunch: [],
    unchanged: [],
    settings: [],
    noEffectiveChange: false,
    configDirsChanged: configDirsDiffer(applied, next, facts.home),
    ...(facts.sharedReview ? { sharedReview: { generation: facts.sharedReview.generation, channels: reviewedChannelViews(applied, next, facts) } } : {}),
  }

  for (const persona of next.personas) {
    const ref = refOf(persona)
    const before = appliedByKey.get(persona.key)
    if (before === undefined) {
      const causes = facts.addedCannotComeUp?.get(persona.key) ?? []
      plan.added.push({ ...ref, cannotComeUp: causes === FACT_UNKNOWN ? undefined : [...causes] })
      continue
    }
    const destructive = DESTRUCTIVE_SETTINGS.filter((setting) =>
      setting === 'name' ? before.name !== persona.name : !samePath(before[setting], persona[setting]),
    )
    if (destructive.length > 0) {
      const change: DestructivePersonaChange = {
        ...ref,
        settings: destructive,
        credentials_file: persona.credentials_file,
        working_directory: persona.working_directory,
      }
      if (!samePath(before.claude_config_dir, persona.claude_config_dir)) {
        const unresolvable = facts.configDirProblem?.(persona)
        if (unresolvable !== undefined) change.configDirUnresolvable = unresolvable
      }
      plan.destructive.push(change)
      continue
    }
    let changed = false
    const settings = personaSectionChanges(before, persona)
    if (settings.length > 0) {
      plan.inPlace.push({ ...ref, settings })
      changed = true
    }
    if (credentialsChanged(persona.key, persona.credentials_file, facts)) {
      const state = facts.bringUpState?.(persona.key)
      const known = state !== FACT_UNKNOWN
      const credentialsBroken = known ? isCredentialsBroken(state) : undefined
      // An undefined outcome: its first Slack attempt is in flight, so it has
      // no connection yet.
      const outcome = known ? state?.outcome : undefined
      const retrying = known ? state !== undefined && (outcome === 'retrying' || outcome === undefined) : undefined
      const problem = facts.credentialsProblem?.(persona.credentials_file)
      plan.credentials.push({ ...ref, path: persona.credentials_file, credentialsBroken, retrying, problem })
      changed = true
    }
    const nextLaunch = nextLaunchChanges(before, persona, applied, next, samePath)
    if (nextLaunch.own.length > 0 || nextLaunch.inherited.length > 0) {
      const change: NextLaunchPersonaChange = { ...ref, ...nextLaunch }
      if ([...nextLaunch.own, ...nextLaunch.inherited].includes('claude_config_dir')) {
        const unresolvable = facts.configDirProblem?.(persona)
        if (unresolvable !== undefined) change.configDirUnresolvable = unresolvable
      }
      plan.nextLaunch.push(change)
      changed = true
    }
    if (!changed) plan.unchanged.push(ref)
  }

  for (const name of SERVER_SETTINGS) {
    if (sameSetting(name, settingOf(applied, name), settingOf(next, name), samePath)) continue
    if (name === MODE_SWITCH_SETTING) {
      // the mode turned on applies in place to every persona
      // present in both configurations.
      const personas = next.personas.filter((p) => appliedByKey.has(p.key)).map(refOf)
      plan.settings.push({ name, mode, personas })
      continue
    }
    if (name === 'stop_hook_bootstrap') {
      const inheritedBy = next.personas.filter(persona => {
        const before = appliedByKey.get(persona.key)
        return before && before.stop_hook_bootstrap === applied.stop_hook_bootstrap
          && persona.stop_hook_bootstrap === next.stop_hook_bootstrap
          && before.stop_hook_bootstrap !== persona.stop_hook_bootstrap
      }).map(refOf)
      plan.settings.push({ name, inheritedBy })
      continue
    }
    if (!INHERITED_DEFAULTS.has(name)) {
      plan.settings.push({ name })
      continue
    }
    const inheritedBy = plan.nextLaunch
      .filter((p) => (p.inherited as readonly string[]).includes(name))
      .map(({ key, name: personaName, index, configDirUnresolvable }): InheritingPersonaRef => {
        const inheriting: InheritingPersonaRef = { key, name: personaName, index }
        if (name === 'claude_config_dir' && configDirUnresolvable !== undefined) {
          inheriting.configDirUnresolvable = configDirUnresolvable
        }
        return inheriting
      })
    plan.settings.push({ name, inheritedBy })
  }

  plan.noEffectiveChange =
    plan.added.length === 0 &&
    plan.removed.length === 0 &&
    plan.destructive.length === 0 &&
    plan.inPlace.length === 0 &&
    plan.credentials.length === 0 &&
    plan.nextLaunch.length === 0 &&
    plan.settings.length === 0 &&
    !plan.sharedReview?.channels.some(channel => channel.kind === 'declared' || channel.kind === 'edited')
  return plan
}

// ---------------------------------------------------------------------------
// Counts (the preview header's terms, reused by the `reload-applied` line)
// ---------------------------------------------------------------------------

/** The preview header's counts. */
export interface ChangePlanCounts {
  added: number
  removed: number
  /** Destructively modified personas. */
  destructive: number
  /**
   * Personas modified in place: with an in-place setting or an own
   * next-launch setting changed. A change inherited from a top-level default
   * counts under `settings` only.
   */
  inPlace: number
  /** Personas whose credentials content changed. */
  credentials: number
  /** Changed server-wide settings, an inherited default included (once). */
  settings: number
}

/** The counts of a valid plan. A persona both modified in place and credentials-changed counts in both. Pure. */
export function changePlanCounts(plan: ValidChangePlan): ChangePlanCounts {
  const inPlaceKeys = new Set([
    ...plan.inPlace.map((p) => p.key),
    ...plan.nextLaunch.filter((p) => p.own.length > 0).map((p) => p.key),
  ])
  return {
    added: plan.added.length,
    removed: plan.removed.length,
    destructive: plan.destructive.length,
    inPlace: inPlaceKeys.size,
    credentials: plan.credentials.length,
    settings: plan.settings.length,
  }
}

/**
 * The counts in the preview header's terms, every term always present:
 * `personas: 1 added, 1 removed, 0 destructively modified, 2 modified in
 * place, 1 with changed credentials; server-wide settings: 1 changed`. Pure.
 */
export function renderChangePlanCounts(counts: ChangePlanCounts): string {
  return (
    `personas: ${counts.added} added, ${counts.removed} removed, ${counts.destructive} destructively modified, ` +
    `${counts.inPlace} modified in place, ${counts.credentials} with changed credentials; ` +
    `server-wide settings: ${counts.settings} changed`
  )
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Start of the header of a valid candidate's preview. */
export const PENDING_PREVIEW_TITLE = 'A configuration change is pending; nothing has been applied.'

/** The text of a plan with no effect. */
export const NO_EFFECTIVE_CHANGE = 'no effective change'

/**
 * The retiring lines' prefix and clauses live in the
 * import-free `reload-preview-clauses.ts`, so the /ci-live checks can build
 * their expected lines from them; re-exported here unchanged.
 */
export { DESTRUCTIVE_PREFIX, DESTRUCTIVE_RETIRED_CLAUSE, REMOVED_RETIRED_CLAUSE }

/** Start of an invalid candidate's preview. */
export const INVALID_PREFIX = 'INVALID:'

/** End of an invalid candidate's preview. */
const NOTHING_WILL_BE_APPLIED = 'Nothing will be applied.'

function personaRef(p: Pick<ChangePlanPersonaRef, 'name' | 'key'>): string {
  return `persona ${renderPersonaRef(p.name, p.key)}`
}

/**
 * A removal's preview line: `DESTRUCTIVE: persona "<name>"
 * (key=<key>) is removed: the persona will be retired: its session stopped
 * and never resumed.` Pure; unescaped (`renderPreviewLines` escapes).
 */
export function removedLine(p: ChangePlanPersonaRef & { queueOpenCount?: number }): string {
  return `${DESTRUCTIVE_PREFIX} ${personaRef(p)} is removed: ${REMOVED_RETIRED_CLAUSE}; ${queueRetentionClause(p.queueOpenCount ?? 0)}.`
}

/**
 * The warning for a changed claude_config_dir that cannot be resolved, worded
 * like an added persona's (`is added but cannot come up: <cause>`), starting
 * `; `: `; but <when> it cannot come up: <problem>`, or `; whether it can
 * come up <when> could not be checked`. Empty when nothing stops it.
 */
function configDirWarning(unresolvable: ConfigDirUnresolvable | undefined, when: string): string {
  if (unresolvable === undefined) return ''
  const at = when === '' ? '' : ` ${when}`
  if (unresolvable === FACT_UNKNOWN) return `; whether it can come up${at} could not be checked`
  return `; but${at} it cannot come up: ${unresolvable}`
}

/**
 * A destructive modify's preview line: `DESTRUCTIVE: persona
 * "<name>" (key=<key>) <what changed>: the persona will be retired and
 * brought up fresh: its session stopped and never resumed<warning>.`, where
 * `<what changed>` is each changed setting in `DESTRUCTIVE_SETTINGS` order
 * (`name changed`, `<setting> changed to "<path>"`) joined by ` and `, and
 * `<warning>` the claude_config_dir warning (`configDirWarning`), empty when
 * nothing stops it. Pure; unescaped (`renderPreviewLines` escapes).
 */
export function destructiveLine(p: DestructivePersonaChange): string {
  const what = p.settings.map((setting) =>
    setting === 'name' ? 'name changed' : `${setting} changed to ${JSON.stringify(p[setting])}`,
  )
  return (
    `${DESTRUCTIVE_PREFIX} ${personaRef(p)} ${what.join(' and ')}: ${DESTRUCTIVE_RETIRED_CLAUSE}` +
    `${configDirWarning(p.configDirUnresolvable, '')}.`
  )
}

function addedLine(p: AddedPersonaChange): string {
  if (p.cannotComeUp === undefined) return `${personaRef(p)} is added; whether it can come up could not be checked.`
  if (p.cannotComeUp.length === 0) return `${personaRef(p)} is added: it will be brought up and launched.`
  return `${personaRef(p)} is added but cannot come up: ${p.cannotComeUp.map((c) => c.cause).join('; ')}.`
}

/**
 * A next-launch effect. A changed `claude_config_dir` (compared by real path,
 * and the session label is a hash of that real path) makes the next launch
 * fresh, so the conversation is not resumed.
 */
function nextLaunchEffect(settings: readonly string[], whose: 'its' | "each one's"): string {
  return settings.includes('claude_config_dir')
    ? `takes effect at ${whose} next launch, which starts fresh (the conversation is not resumed), instance kept until then`
    : `takes effect at ${whose} next launch, instance kept`
}

/**
 * A credentials change's effect (credentials row), by the
 * persona's bring-up state and whether the new content is locally valid.
 */
function credentialsEffect(c: CredentialsPersonaChange): string {
  const changed = `credentials file ${JSON.stringify(c.path)} changed`
  const unusable = c.problem === undefined ? undefined : `${changed}, but it cannot be used (${c.problem})`
  if (c.credentialsBroken === undefined || c.retrying === undefined) {
    return `${unusable ?? changed}; whether it is broken by its credentials now could not be checked`
  }
  if (c.credentialsBroken) {
    return unusable === undefined
      ? `${changed}: it is broken by its credentials now, so it will be brought up`
      : `${unusable}: it stays broken by its credentials`
  }
  if (c.retrying) {
    return unusable === undefined
      ? `${changed}: it has no connection yet, so it retries with the new content, instance kept`
      : `${unusable}: it keeps retrying with its current content, instance kept`
  }
  return unusable === undefined
    ? `${changed}: a new connection opens, then the old one closes, instance kept`
    : `${unusable}: the current connection is kept, instance kept`
}

/** One persona's non-destructive effects, or undefined when it has none with a line of its own. */
function modifiedLine(
  ref: ChangePlanPersonaRef,
  inPlace: InPlacePersonaChange | undefined,
  nextLaunch: NextLaunchPersonaChange | undefined,
  credentials: CredentialsPersonaChange | undefined,
): string | undefined {
  const effects: string[] = []
  if (inPlace !== undefined) {
    effects.push(`${inPlace.settings.join(', ')} changed: applied in place immediately, instance kept`)
  }
  if (nextLaunch !== undefined && nextLaunch.own.length > 0) {
    const warning = nextLaunch.own.includes('claude_config_dir')
      ? configDirWarning(nextLaunch.configDirUnresolvable, 'at that launch')
      : ''
    effects.push(`${nextLaunch.own.join(', ')} changed: ${nextLaunchEffect(nextLaunch.own, 'its')}${warning}`)
  }
  if (credentials !== undefined) effects.push(credentialsEffect(credentials))
  return effects.length === 0 ? undefined : `${personaRef(ref)}: ${effects.join('; ')}.`
}

/**
 * The server-wide settings only the CLI uses (`stop` and `clean_restart`),
 * which it takes from the last-applied record: they take
 * effect for the CLI as soon as an apply rewrites the record, not at the next
 * server start. The running server does not use them.
 */
const CLI_RECORD_SETTINGS: ReadonlySet<string> = new Set<string>(['stop_timeout', 'exit_timeout'])

/**
 * The server-wide settings both the CLI and the running server use
 * the CLI takes a change from the last-applied record as
 * soon as an apply rewrites it, as it takes `exit_timeout`, and the running
 * server uses it from its next start.
 */
const CLI_RECORD_AND_SERVER_START_SETTINGS: ReadonlySet<string> = new Set<string>([
  'agent_director_call_timeout_ms',
])

/**
 * The switch's preview line: a change of
 * `channel_mode` turns `mode` on for every persona, in place at
 * once:
 *
 *   server-wide setting channel_mode changed: turns open mode
 *   on, applied in place at once, from the next event, tool call, prompt and
 *   notice, for "alpha" (key=alpha), "bravo" (key=bravo).
 *
 * The line says nothing of instances: a persona the same change modifies
 * destructively has its own line saying so.
 *
 * or, when no persona is present in both configurations, `…, prompt and
 * notice; no persona is affected.` `personas` are the personas present in
 * both configurations, in candidate order. The one builder of this line: the
 * preview renders it through this, and tests and scenario texts build it
 * here. Pure; unescaped (`renderPreviewLines` escapes).
 */
export function modeSwitchLine(
  mode: ChannelMode,
  personas: readonly Pick<ChangePlanPersonaRef, 'name' | 'key'>[],
): string {
  const head =
    `server-wide setting ${MODE_SWITCH_SETTING} changed: turns ${mode} mode on, applied in place at once, ` +
    'from the next event, tool call, prompt and notice'
  if (personas.length === 0) return `${head}; no persona is affected.`
  return `${head}, for ${personas.map((p) => renderPersonaRef(p.name, p.key)).join(', ')}.`
}

/**
 * A changed server-wide setting's preview line, worded by who uses the
 * setting: the switch (`modeSwitchLine`), only the CLI
 * (`CLI_RECORD_SETTINGS`), both the CLI and the running server
 * (`CLI_RECORD_AND_SERVER_START_SETTINGS`), or only the server (every other
 * setting: from the next server start or, for an inherited default, at each
 * inheriting persona's next launch). Pure.
 */
function settingLine(s: ServerSettingChange): string {
  if (s.name === MODE_SWITCH_SETTING && s.mode !== undefined) return modeSwitchLine(s.mode, s.personas ?? [])
  const prefix = `server-wide setting ${s.name} changed:`
  const recorded = 'once applied, it is recorded'
  if (s.name === 'stop_hook_bootstrap') {
    if (!s.inheritedBy?.length) return `${prefix} ${recorded}; no persona inherits the change, so no reply reminder is affected.`
    const who = s.inheritedBy.map(p => renderPersonaRef(p.name, p.key)).join(', ')
    return `${prefix} inherited by ${who}; once applied, reply reminders use it immediately.`
  }
  if (CLI_RECORD_SETTINGS.has(s.name)) {
    return `${prefix} ${recorded}, and the CLI takes it from the record from then on (the running server does not use it).`
  }
  if (CLI_RECORD_AND_SERVER_START_SETTINGS.has(s.name)) {
    return `${prefix} ${recorded}, the CLI takes it from the record from then on, and the running server uses it from its next start.`
  }
  if (s.inheritedBy === undefined) return `${prefix} ${recorded} and takes effect at the next server start after that.`
  if (s.inheritedBy.length === 0) return `${prefix} ${recorded}; no persona inherits it, so no instance is affected.`
  const who = s.inheritedBy.map((p) => renderPersonaRef(p.name, p.key)).join(', ')
  return `${prefix} inherited by ${who}; ${nextLaunchEffect([s.name], "each one's")}${inheritedConfigDirWarnings(s.inheritedBy)}.`
}

/**
 * The warnings of a changed top-level `claude_config_dir` for the inheriting
 * personas it stops, each starting `; `: `; but at that launch <personas>
 * cannot come up: <problem>` for each distinct problem, then `; whether
 * <personas> can come up at that launch could not be checked`. Personas are
 * listed in candidate order. Empty when it stops none.
 */
function inheritedConfigDirWarnings(inheritedBy: readonly InheritingPersonaRef[]): string {
  const byProblem = new Map<string, string[]>()
  const unknown: string[] = []
  for (const p of inheritedBy) {
    if (p.configDirUnresolvable === undefined) continue
    const ref = renderPersonaRef(p.name, p.key)
    if (p.configDirUnresolvable === FACT_UNKNOWN) unknown.push(ref)
    else byProblem.set(p.configDirUnresolvable, [...(byProblem.get(p.configDirUnresolvable) ?? []), ref])
  }
  const warnings = [...byProblem].map(([problem, refs]) => `; but at that launch ${refs.join(', ')} cannot come up: ${problem}`)
  if (unknown.length > 0) warnings.push(`; whether ${unknown.join(', ')} can come up at that launch could not be checked`)
  return warnings.join('')
}

/**
 * The preview's lines, each on one
 * line (control characters escaped). An invalid plan: one `INVALID:` line
 * with the full error and `Nothing will be applied.`, with no counts and no
 * persona lines. A plan with no effect: the title and `no effective change`.
 * Otherwise the header (the title and the counts), then the removals, the destructive modifies,
 * the additions, the other affected personas in candidate order (one line
 * each, stating every effect), then the changed server-wide settings, the
 * switch's line (`modeSwitchLine`) among them.
 * Personas are named by their JSON-quoted name and key, credentials files by
 * path; no token, credentials content, setting value or digest. Pure and
 * deterministic.
 */
export function renderPreviewLines(plan: ChangePlan): string[] {
  if (!plan.valid) return [escapeCause(`${INVALID_PREFIX} ${plan.error} ${NOTHING_WILL_BE_APPLIED}`)]
  const sharedLines = plan.sharedReview ? [
    reviewIntentLine(plan.sharedReview.generation, plan.sharedReview.channels.filter(channel => channel.kind === 'declared').length),
    ...plan.sharedReview.channels.map(reviewedChannelLine),
  ] : []
  if (plan.noEffectiveChange) {
    return [
      `${PENDING_PREVIEW_TITLE} ${NO_EFFECTIVE_CHANGE}: applying it would change no persona and no server-wide setting.`,
      ...sharedLines,
    ].map(escapeCause)
  }
  const lines = [`${PENDING_PREVIEW_TITLE} ${renderChangePlanCounts(changePlanCounts(plan))}.`]
  lines.push(...plan.removed.map(removedLine))
  lines.push(...plan.destructive.map(destructiveLine))
  lines.push(...plan.added.map(addedLine))

  const inPlaceByKey = new Map(plan.inPlace.map((p) => [p.key, p]))
  const nextLaunchByKey = new Map(plan.nextLaunch.map((p) => [p.key, p]))
  const credentialsByKey = new Map(plan.credentials.map((p) => [p.key, p]))
  const modified = new Map<string, ChangePlanPersonaRef>()
  for (const p of [...plan.inPlace, ...plan.nextLaunch, ...plan.credentials]) modified.set(p.key, p)
  const inCandidateOrder = [...modified.values()].sort((a, b) => a.index - b.index)
  for (const ref of inCandidateOrder) {
    const line = modifiedLine(ref, inPlaceByKey.get(ref.key), nextLaunchByKey.get(ref.key), credentialsByKey.get(ref.key))
    if (line !== undefined) lines.push(line)
  }

  lines.push(...plan.settings.map(settingLine))
  lines.push(...sharedLines)
  return lines.map(escapeCause)
}

/** The preview text: `renderPreviewLines` joined by newlines, the body of `config.json.pending`. Pure. */
export function renderPreview(plan: ChangePlan): string {
  return renderPreviewLines(plan).join('\n')
}

// ---------------------------------------------------------------------------
// Log form (one class label per line)
// ---------------------------------------------------------------------------

/** ` (preview in "<path>")`, or nothing when there is no pending file to point at. */
function previewFileSuffix(pendingFile: string | undefined): string {
  return pendingFile === undefined ? '' : ` (preview in ${JSON.stringify(pendingFile)})`
}

/**
 * The server-log form of a valid plan's preview: every line of
 * `renderPreviewLines`, each as `[slack] reload-preview: <line>`. The first
 * (the header) ends ` (preview in "<pendingFile>")` when `pendingFile` is
 * given; omit it when the pending file could not be written. Pure.
 */
export function renderPreviewLogLines(plan: ValidChangePlan, pendingFile?: string): string[] {
  return renderPreviewLines(plan).map(
    (line, i) => `[slack] ${RELOAD_PREVIEW}: ${line}${i === 0 ? previewFileSuffix(pendingFile) : ''}`,
  )
}

/**
 * The one server-log line of an invalid plan, classed `reload-invalid`, with
 * the full validation error (or the missing or unreadable configuration
 * file); ends ` (preview in "<pendingFile>")` when `pendingFile` is given.
 * Pure.
 */
export function renderInvalidLogLine(plan: InvalidChangePlan, pendingFile?: string): string {
  return (
    `[slack] ${RELOAD_INVALID}: the pending configuration is invalid and nothing will be applied: ` +
    `${escapeCause(plan.error)}${previewFileSuffix(pendingFile)}`
  )
}
