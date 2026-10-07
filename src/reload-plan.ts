/**
 * reload-plan.ts — The structured change plan and the pending-change preview
 * (b.av2 SR-8.4, SR-8.6, SR-10.3; b.jg5 SRJ-1510, SRJ-1511).
 *
 * `buildChangePlan` classifies a candidate configuration against the applied
 * one, persona by persona and setting by setting, in the terms of the SR-8.6
 * table: added, removed, destructively modified, modified in place, changed
 * credentials, next-launch changes (own or inherited) and unchanged, plus the
 * changed server-wide settings. A persona's section settings are classified
 * by the candidate's section in force: a change to the section the
 * candidate's switch does not select is recorded, with no effect (b.deo
 * SRI-802, SRI-804), and a change of the switch has a line of its own
 * (`modeSwitchLine`, b.deo SRI-803). The reload detection tick builds it every
 * pass, and a confirmed apply (`reload-apply.ts`) acts on the plan that pass
 * built from the confirmed bytes, never a second diff, so what is applied is
 * what was previewed.
 *
 * The preview is rendered from the plan, never from a second diff:
 * - `renderPreview` / `renderPreviewLines`: the body of `config.json.pending`
 *   (b.av2 SR-8.4). A header with the counts (`changePlanCounts`,
 *   `renderChangePlanCounts`, reused by the `reload-applied` line), then one
 *   line per affected persona and changed setting; removals and destructive
 *   modifies start with `DESTRUCTIVE:` and say the persona will be retired:
 *   its session stopped and never resumed, and a destructive modify's brought
 *   up fresh (`removedLine`, `destructiveLine`, b.jg5 SRJ-1510). An invalid
 *   candidate renders one `INVALID` line, a plan with no effect `no effective
 *   change`;
 * - `renderPreviewLogLines`: the same lines, each classed `reload-preview`
 *   (one class label per line, b.av2 SR-10.3);
 * - `renderInvalidLogLine`: the one `reload-invalid` line of an invalid
 *   candidate.
 *
 * Pure (b.av2 SR-13.1): nothing here reads or writes a file, calls Slack or
 * agent-director, arms a timer, logs or holds state, and nothing runs at
 * import. Every fact that needs I/O (real paths, credentials digests and
 * local validity, the bring-up state, whether an added persona can come up)
 * is passed in by the caller. The same plan always renders the same text.
 * The plan and every output hold persona keys and names, paths and setting
 * names only: never a token, credentials content or a digest.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  channelModeOf,
  configReadFailurePredicate,
  PERSONA_TOP_LEVEL_KEYS,
  SERVER_PATH_SETTINGS,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
  type PersonaSections,
} from './config.ts'
import { isCredentialsBroken, type PersonaBringUpState } from './persona-bringup-controller.ts'
import type { CredentialsDigest } from './persona-credentials.ts'
import { escapeCause } from './persona-diagnostics.ts'
import { effectiveClaudeConfigDirs, renderPersonaRef } from './persona-identity.ts'
import { DESTRUCTIVE_PREFIX, DESTRUCTIVE_RETIRED_CLAUSE, REMOVED_RETIRED_CLAUSE } from './reload-preview-clauses.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes (b.av2 SR-10.3); listed in `RELOAD_DIAGNOSTIC_CLASSES`
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
  /** Valid in default mode (full SR-1.5 real-path checks). */
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
 * Why an added persona cannot come up: one failed local bring-up check (b.av2
 * SR-6.1 steps 1 and 2, and the claude_config_dir check its bring-up runs
 * before step 3, bug b.g57).
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
  /**
   * The comparison form of a configured path (b.av2 SR-1.5; production:
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
   * Dry run (b.av2 SR-3.4, SR-8.2): no credentials file is read, and
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
   * run words it (its `problem`, bug b.g57; production: `checkConfigDir`, the
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
 * The settings whose change retires a persona (b.av2 SR-8.6, b.jg5 SRJ-1511):
 * its session is stopped and never resumed, its key recorded as retired at
 * apply step 1 (SRJ-803), and it is brought up fresh. In the order they are
 * reported.
 */
export const DESTRUCTIVE_SETTINGS = ['name', 'credentials_file', 'working_directory'] as const

/** A setting whose change retires the persona and brings it up fresh (SRJ-1511). */
export type DestructiveSetting = (typeof DESTRUCTIVE_SETTINGS)[number]

/**
 * The settings applied in place, immediately (b.av2 SR-8.6, b.deo SRI-802),
 * in the order they are reported. `channels`, `delivery` and
 * `permission_prompts` are in place when the candidate is in declarative
 * mode, `invited.permission_prompts` when it is in fungible mode; `dm.*` in
 * both modes.
 */
export const IN_PLACE_SETTINGS = [
  'channels',
  'delivery',
  'permission_prompts',
  'invited.permission_prompts',
  'dm.enabled',
  'dm.contact',
] as const

/** A setting applied in place. `channels`: the set of channel IDs; `delivery`: a kept channel's mode. */
export type InPlaceSetting = (typeof IN_PLACE_SETTINGS)[number]

/**
 * The persona keys whose change is recorded, with no effect, when they
 * belong to the section the candidate's switch does not select (b.deo
 * SRI-804): the declarative section's `channels` and `permission_prompts`,
 * and the fungible section, `invited`. In the order they are reported.
 */
export const RECORDED_SECTION_KEYS = ['channels', 'permission_prompts', 'invited'] as const satisfies readonly (keyof PersonaSections)[]

/** A persona key whose change can be recorded (b.deo SRI-804). */
export type RecordedSectionKey = (typeof RECORDED_SECTION_KEYS)[number]

/** The server-wide setting that picks the channel mode (b.deo SRI-101); it has a preview line of its own (SRI-803). */
export const MODE_SWITCH_SETTING = 'allow_invited_channels'

/** The settings that take effect at the persona's next launch (b.av2 SR-8.6), in the order they are reported. */
export const NEXT_LAUNCH_SETTINGS = ['claude_config_dir', 'stop_hook_bootstrap'] as const

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
 * stopped and never resumed), then brought up fresh (b.jg5 SRJ-803, SRJ-1511).
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

/**
 * A persona present in both configurations whose section not in force (by the
 * candidate's switch) changed (b.deo SRI-804): the change is recorded and has
 * no effect until the switch selects that section.
 */
export interface RecordedPersonaChange extends ChangePlanPersonaRef {
  /**
   * The changed keys, in `RECORDED_SECTION_KEYS` order: `channels` and
   * `permission_prompts` when the candidate is in fungible mode, `invited`
   * when it is in declarative mode.
   */
  fields: RecordedSectionKey[]
}

/** A persona whose credentials file, at the same path, has changed content. */
export interface CredentialsPersonaChange extends ChangePlanPersonaRef {
  /** The credentials file, as the candidate names it. */
  path: string
  /**
   * The persona is currently broken by its credentials: it is brought up at
   * apply rather than reconnected (b.av2 SR-8.6 step 6). Undefined when its
   * bring-up state could not be queried.
   */
  credentialsBroken: boolean | undefined
  /**
   * The persona is retrying its bring-up (Slack-unreachable,
   * directory-broken, or held for its claude_config_dir, bug b.g57), or its
   * first Slack attempt is in flight: it has no connection and retries with
   * the new content (b.av2 SR-8.6), or, when the new content is not locally
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
   * For an inherited default (`claude_config_dir`, `stop_hook_bootstrap`):
   * the personas, present in both configurations and not destructively
   * modified, whose value changes through it, in candidate order. Absent for
   * any other setting.
   */
  inheritedBy?: InheritingPersonaRef[]
  /**
   * For the switch (`allow_invited_channels`, b.deo SRI-803) only: the
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
  valid: true
  /** Candidate personas whose key the applied set lacks, in candidate order. */
  added: AddedPersonaChange[]
  /** Applied personas whose key the candidate lacks, in applied order. */
  removed: ChangePlanPersonaRef[]
  /** In candidate order; never also in `inPlace`, `credentials` or `nextLaunch`. */
  destructive: DestructivePersonaChange[]
  /** In candidate order. */
  inPlace: InPlacePersonaChange[]
  /** In candidate order. Never set in dry run or when nothing is held. */
  credentials: CredentialsPersonaChange[]
  /** In candidate order. */
  nextLaunch: NextLaunchPersonaChange[]
  /**
   * Candidate personas present in both with nothing changed, or with
   * recorded changes only (they are not modified), in candidate order.
   */
  unchanged: ChangePlanPersonaRef[]
  /**
   * Candidate personas present in both, not destructively modified, whose
   * section not in force changed (b.deo SRI-804), in candidate order. Such a
   * change is recorded only: it counts in no header term, makes no apply
   * step act and leaves `noEffectiveChange` as it is. A persona can be here
   * and in another class.
   */
  recorded: RecordedPersonaChange[]
  /** In the fixed order of the top-level keys. */
  settings: ServerSettingChange[]
  /**
   * True exactly when every persona is unchanged and no server-wide setting
   * changed; recorded changes do not count (b.deo SRI-804).
   */
  noEffectiveChange: boolean
  /**
   * The set of effective config directories differs between the applied and
   * the candidate personas (each persona's own `claude_config_dir`, else the
   * inherited one, else `<home>/.claude`): the apply refreshes the
   * agent-director template (b.av2 SR-8.6 step 5). Not rendered in the
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

/** The structured change plan (b.av2 SR-8.4, SR-8.6). */
export type ChangePlan = ValidChangePlan | InvalidChangePlan

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The server-wide settings, in the fixed order they are reported. */
const SERVER_SETTINGS: readonly string[] = PERSONA_TOP_LEVEL_KEYS.filter((key) => key !== 'personas')

/** The server-wide settings that hold a path: compared by real path. */
const SERVER_PATH_SETTING_SET: ReadonlySet<string> = new Set<string>(SERVER_PATH_SETTINGS)

/** The top-level settings a persona inherits when its entry omits them (b.av2 SR-1.2). */
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

/** Whether one section key's written value differs (b.deo SRI-802): by `JSON.stringify`, never validated or resolved. */
function sectionKeyChanged(before: Persona, after: Persona, key: RecordedSectionKey): boolean {
  return JSON.stringify(before.sections[key]) !== JSON.stringify(after.sections[key])
}

/**
 * The in-place settings and the recorded keys that differ between two
 * declarations of one persona (b.av2 SR-8.6, b.deo SRI-802, SRI-804),
 * classified by the candidate's section in force (`mode`, the candidate's
 * channel mode):
 * - when both configurations are in that mode, its section is compared by
 *   resolved values: the declarative section by the set of channel IDs, a
 *   kept channel's `delivery` and `permission_prompts`, as b.av2 SR-8.6
 *   compares them; the fungible section by `fungible_destination`, so an
 *   absent `invited.permission_prompts` equals `dm`;
 * - otherwise (the switch changed), its keys are compared as written
 *   (`sections`), and a changed `channels`, `permission_prompts` or `invited`
 *   is an in-place change of `channels`, `permission_prompts` or
 *   `invited.permission_prompts`;
 * - the keys of the other section are always compared as written, and a
 *   changed one is recorded, never applied;
 * - `dm.enabled` and `dm.contact` are compared by resolved value in both
 *   modes.
 * So a change of the switch alone modifies no persona (b.deo SRI-203).
 */
function personaSectionChanges(
  before: Persona,
  after: Persona,
  mode: ChannelMode,
  sameMode: boolean,
): { inPlace: InPlaceSetting[]; recorded: RecordedSectionKey[] } {
  const changed: Record<InPlaceSetting, boolean> = {
    channels: false,
    delivery: false,
    permission_prompts: false,
    'invited.permission_prompts': false,
    'dm.enabled': before.dm.enabled !== after.dm.enabled,
    'dm.contact': before.dm.contact !== after.dm.contact,
  }
  let recorded: RecordedSectionKey[]
  if (mode === 'declarative') {
    if (sameMode) {
      const was = new Map(before.channels.map((c) => [c.id, c.delivery]))
      const now = new Map(after.channels.map((c) => [c.id, c.delivery]))
      changed.channels = was.size !== now.size || [...now.keys()].some((id) => !was.has(id))
      changed.delivery = [...now].some(([id, delivery]) => was.has(id) && was.get(id) !== delivery)
      changed.permission_prompts = before.permission_prompts !== after.permission_prompts
    } else {
      changed.channels = sectionKeyChanged(before, after, 'channels')
      changed.permission_prompts = sectionKeyChanged(before, after, 'permission_prompts')
    }
    recorded = sectionKeyChanged(before, after, 'invited') ? ['invited'] : []
  } else {
    changed['invited.permission_prompts'] = sameMode
      ? before.fungible_destination !== after.fungible_destination
      : sectionKeyChanged(before, after, 'invited')
    recorded = (['channels', 'permission_prompts'] as const).filter((key) => sectionKeyChanged(before, after, key))
  }
  return { inPlace: IN_PLACE_SETTINGS.filter((setting) => changed[setting]), recorded }
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
 * Whether a persona's current bring-up state is credentials-broken (b.av2
 * SR-6.4); the bring-up controller's rule, which the apply's step bodies and
 * operations use too. Such a persona is brought up at apply rather than
 * reconnected (SR-8.6 step 6).
 */
export { isCredentialsBroken }

/**
 * Whether the set of effective config directories of `candidate`'s personas
 * differs from `applied`'s (b.av2 SR-8.6 step 5). Both sets come from
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
 * Classify `candidate` against the `applied` configuration (b.av2 SR-8.4,
 * SR-8.6; b.deo SRI-802 to SRI-804). Pure: reads no file, calls no Slack or
 * agent-director API, arms no timer and logs nothing; every I/O-derived fact
 * comes from `facts`.
 *
 * Personas are matched by key, so a `name` change that changes the key is a
 * removal of the old key and an addition of the new one. For a persona
 * present in both:
 * - destructively modified: its `name` (same key), `credentials_file` or
 *   `working_directory` (by real path) changed, so the confirmation retires
 *   it and brings it up fresh (b.jg5 SRJ-1511). It is not also listed as
 *   modified in place, credentials-changed or next-launch: the new half reads
 *   everything fresh;
 * - modified in place: a setting of the candidate's section in force changed
 *   (declarative mode: `channels`, the set of IDs, a kept channel's
 *   `delivery` or `permission_prompts`; fungible mode:
 *   `invited.permission_prompts`), or `dm.enabled` or `dm.contact` changed,
 *   compared as `personaSectionChanges` gives it;
 * - recorded (b.deo SRI-804): a key of the section the candidate's switch
 *   does not select changed. Recorded only: a persona with no other change
 *   is unchanged. May come with any class but destructive;
 * - credentials changed: same `credentials_file` by real path, and the
 *   current digest or marker differs from the held one (never in dry run or
 *   with nothing held). May come with in-place changes;
 * - next launch: `claude_config_dir` (by real path) or `stop_hook_bootstrap`
 *   changed, marked own or inherited (see `nextLaunchChanges`);
 * - otherwise unchanged.
 *
 * A persona whose effective `claude_config_dir` changed (a next-launch change,
 * own or inherited, or alongside a destructive modify) carries
 * `configDirUnresolvable` when `facts.configDirProblem` says the new directory
 * cannot be resolved, or could not be checked: the preview warns about it
 * as it does for an added persona that cannot come up (bug b.g57). The change
 * is still applied as previewed.
 *
 * Server-wide settings are compared by resolved value, paths by real path. A
 * changed `claude_config_dir` or `stop_hook_bootstrap` lists the personas
 * that inherit the change. A changed `allow_invited_channels` (absent and
 * `false` are the same value) carries the mode it turns on and every persona
 * present in both configurations (b.deo SRI-803). `noEffectiveChange` holds
 * when nothing but unchanged personas remains: a whitespace or key-order
 * edit, a key added with its default value, or recorded changes only.
 *
 * `configDirsChanged` tells the apply whether to refresh the agent-director
 * template (SR-8.6 step 5); it is not part of the preview.
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
  // b.deo SRI-802: each persona is classified by the candidate's section in
  // force, read from the candidate's own switch.
  const mode = channelModeOf(next)
  const sameMode = channelModeOf(applied) === mode

  const plan: ValidChangePlan = {
    valid: true,
    added: [],
    removed: applied.personas.filter((p) => !nextKeys.has(p.key)).map(refOf),
    destructive: [],
    inPlace: [],
    credentials: [],
    nextLaunch: [],
    unchanged: [],
    recorded: [],
    settings: [],
    noEffectiveChange: false,
    configDirsChanged: configDirsDiffer(applied, next, facts.home),
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
    const sections = personaSectionChanges(before, persona, mode, sameMode)
    if (sections.inPlace.length > 0) {
      plan.inPlace.push({ ...ref, settings: sections.inPlace })
      changed = true
    }
    if (sections.recorded.length > 0) plan.recorded.push({ ...ref, fields: sections.recorded })
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
      // b.deo SRI-803: the mode turned on applies in place to every persona
      // present in both configurations.
      const personas = next.personas.filter((p) => appliedByKey.has(p.key)).map(refOf)
      plan.settings.push({ name, mode, personas })
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
    plan.settings.length === 0
  return plan
}

// ---------------------------------------------------------------------------
// Counts (the preview header's terms, reused by the `reload-applied` line)
// ---------------------------------------------------------------------------

/** The preview header's counts (b.av2 SR-8.4). */
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
// Preview (b.av2 SR-8.4)
// ---------------------------------------------------------------------------

/** Start of the header of a valid candidate's preview. */
export const PENDING_PREVIEW_TITLE = 'A configuration change is pending; nothing has been applied.'

/** The text of a plan with no effect. */
export const NO_EFFECTIVE_CHANGE = 'no effective change'

/**
 * The retiring lines' prefix and clauses (b.jg5 SRJ-1510) live in the
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
 * A removal's preview line (b.jg5 SRJ-1510): `DESTRUCTIVE: persona "<name>"
 * (key=<key>) is removed: the persona will be retired: its session stopped
 * and never resumed.` Pure; unescaped (`renderPreviewLines` escapes).
 */
export function removedLine(p: ChangePlanPersonaRef): string {
  return `${DESTRUCTIVE_PREFIX} ${personaRef(p)} is removed: ${REMOVED_RETIRED_CLAUSE}.`
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
 * A destructive modify's preview line (b.jg5 SRJ-1510): `DESTRUCTIVE: persona
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
 * fresh, so the conversation is not resumed (b.av2 SR-6.2, SR-8.6).
 */
function nextLaunchEffect(settings: readonly string[], whose: 'its' | "each one's"): string {
  return settings.includes('claude_config_dir')
    ? `takes effect at ${whose} next launch, which starts fresh (the conversation is not resumed), instance kept until then`
    : `takes effect at ${whose} next launch, instance kept`
}

/**
 * A credentials change's effect (b.av2 SR-8.6, credentials row), by the
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
 * which it takes from the last-applied record (b.av2 SR-8.7): they take
 * effect for the CLI as soon as an apply rewrites the record, not at the next
 * server start. The running server does not use them.
 */
const CLI_RECORD_SETTINGS: ReadonlySet<string> = new Set<string>(['stop_timeout', 'exit_timeout'])

/**
 * The server-wide settings both the CLI and the running server use
 * (b.jg5 SRJ-213): the CLI takes a change from the last-applied record as
 * soon as an apply rewrites it, as it takes `exit_timeout`, and the running
 * server uses it from its next start.
 */
const CLI_RECORD_AND_SERVER_START_SETTINGS: ReadonlySet<string> = new Set<string>([
  'agent_director_call_timeout_ms',
])

/**
 * The switch's preview line (b.deo SRI-803): a change of
 * `allow_invited_channels` turns `mode` on for every persona, in place at
 * once:
 *
 *   server-wide setting allow_invited_channels changed: turns fungible mode
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
 * A recorded change's preview line (b.deo SRI-804): the persona, its changed
 * keys of the section not in force, and that the change is recorded with no
 * effect until the switch selects that section:
 *
 *   persona "alpha" (key=alpha): channels, permission_prompts changed in the
 *   declarative section: recorded, with no effect until
 *   allow_invited_channels selects declarative mode.
 *
 * The section is the fungible one when the change names `invited`, else the
 * declarative one. Pure; unescaped (`renderPreviewLines` escapes).
 */
export function recordedLine(p: Pick<RecordedPersonaChange, 'name' | 'key' | 'fields'>): string {
  const section: ChannelMode = p.fields.includes('invited') ? 'fungible' : 'declarative'
  return (
    `${personaRef(p)}: ${p.fields.join(', ')} changed in the ${section} section: recorded, with no effect until ` +
    `${MODE_SWITCH_SETTING} selects ${section} mode.`
  )
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
 * The preview's lines (b.av2 SR-8.4, b.deo SRI-803, SRI-804), each on one
 * line (control characters escaped). An invalid plan: one `INVALID:` line
 * with the full error and `Nothing will be applied.`, with no counts and no
 * persona lines. A plan with no effect: the title and `no effective change`,
 * then its recorded lines (`recordedLine`), if any. Otherwise the header
 * (the title and the counts), then the removals, the destructive modifies,
 * the additions, the other affected personas in candidate order (one line
 * each, stating every effect), then the recorded lines in candidate order,
 * then the changed server-wide settings, the switch's line
 * (`modeSwitchLine`) among them.
 * Personas are named by their JSON-quoted name and key, credentials files by
 * path; no token, credentials content, setting value or digest. Pure and
 * deterministic.
 */
export function renderPreviewLines(plan: ChangePlan): string[] {
  if (!plan.valid) return [escapeCause(`${INVALID_PREFIX} ${plan.error} ${NOTHING_WILL_BE_APPLIED}`)]
  if (plan.noEffectiveChange) {
    return [
      `${PENDING_PREVIEW_TITLE} ${NO_EFFECTIVE_CHANGE}: applying it would change no persona and no server-wide setting.`,
      ...plan.recorded.map(recordedLine),
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

  lines.push(...plan.recorded.map(recordedLine))
  lines.push(...plan.settings.map(settingLine))
  return lines.map(escapeCause)
}

/** The preview text: `renderPreviewLines` joined by newlines, the body of `config.json.pending`. Pure. */
export function renderPreview(plan: ChangePlan): string {
  return renderPreviewLines(plan).join('\n')
}

// ---------------------------------------------------------------------------
// Log form (b.av2 SR-10.3: one class label per line)
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
