/**
 * outage-state.ts — Persona-keyed outage-flag state machine + notice emit surface.
 *
 * Tracks four orthogonal outage classes per persona (b.av2 SR-6.3; b.jg5
 * SRJ-316 adds `ad-config-malformed`), keyed by persona key, in the exported
 * stable order `OUTAGE_CLASS_ORDER`, and emits onset / all-clear notices via
 * the injected `notify`
 * hook, which production wires to the per-persona notifier
 * (`src/persona-notifier.ts`): the notice goes to that persona's destination
 * and the notifier adds the persona reference (b.av2 SR-7.2). Each notice
 * carries its phase and the classes it concerns (`OutageNoticeOptions`): the
 * onset its one class, the all-clear every class it lists, so the notifier
 * routes the all-clear of an outage whose onset a persona teardown's window
 * routed as that onset was, whenever it comes (b.jg5 SRJ-1002, SRJ-1003).
 * The module is
 * intentionally free of Date / timestamp logic — operators scroll back to the
 * onset message for timing context.
 *
 * Public API surface (all exported):
 *   - initOutageState(deps)                — install production dependencies
 *   - getOutageFlags(key)                  — read live flag set
 *   - setOutageFlag(key, cls, detail?)     — raise flag + emit onset notice
 *   - raiseTmuxUnavailable(key, err)       — the one raise entry for tmux-unavailable: emits
 *                                            SRJ-1021's onset for the re-bound-socket form
 *                                            (isDifferentTmuxServerError), today's otherwise;
 *                                            records no detail (b.jg5 SRJ-1021)
 *   - raiseAdConfigMalformed(key, err)     — the one raise entry for ad-config-malformed (a CONFIG
 *                                            answer, `ErrConfigMalformed`): emits SRJ-1018's onset
 *                                            quoting the classifier's rendered message, records no
 *                                            detail, logs one raise line (b.jg5 SRJ-316, SRJ-1018)
 *   - clearOutageFlag(key, cls, reading?)  — lower flag; emits all-clear when set empties;
 *                                            a real clear is told to the cleared-flag observer;
 *                                            a real ad-config-malformed clear logs one line
 *   - resetAllToHealthy(keys)              — silent wipe (boot-time reset; one key at a teardown);
 *                                            tells the observer nothing
 *   - withOutageDetection(key, dir, call, fn, options?) — AD verb wrapper; raises/clears flags on error/success;
 *                                            `call` is the verb `fn` calls, declared by the site;
 *                                            clears tmux-unavailable only on a tmux-touching
 *                                            success or GONE, and ad-config-malformed only on a
 *                                            success (b.jg5 SRJ-312); with `armsNothing` (a
 *                                            persona teardown's kill) it reports nothing and
 *                                            raises an ENVIRONMENT or CONFIG outage only for a
 *                                            configured persona (b.jg5 SRJ-110; hatch A3);
 *                                            with `deferUnavailableReport` (one try of a
 *                                            bounded kill retry) an UNAVAILABLE value is not
 *                                            reported (b.jg5 SRJ-702)
 *   - withSpawnDetection(key, dir, call, fn)  — like withOutageDetection + clears cwd-unreachable on success
 *   - reportAgentDirectorError(key, err, call) — report an error to the retry timer's trigger sink
 *                                            (inside a launch or recovery attempt, and for
 *                                            ENVIRONMENT and CONFIG in any context; b.jg5 SRJ-301,
 *                                            SRJ-311, SRJ-316), start or continue the persona's
 *                                            tmux-unresponsive condition (b.jg5 SRJ-307), and
 *                                            report an in-attempt UNCLASSIFIED outcome to the
 *                                            unclassified sink (b.jg5 SRJ-313)
 *   - reportDeferredUnavailable(key, err, call) — the one report of a bounded kill retry's
 *                                            outcome that stands, when it is UNAVAILABLE
 *                                            (b.jg5 SRJ-702, SRJ-301, SRJ-307)
 *   - reportUnclassifiedAtSite(key, err, call, classification) — the site entry for an
 *                                            UNCLASSIFIED outcome a site classifies itself
 *                                            (an ErrInvalidFlags at the resume path, the shared
 *                                            pane reader or the reconnect's send-keys): arms
 *                                            with the UNCLASSIFIED cause and reports it,
 *                                            inside an attempt
 *   - armPendingOnlyAfterLaunchFailure(key) — a launch's ErrTmuxSessionCreate arms the
 *                                            persona's retry timer at once in pending-only
 *                                            mode, inside an attempt, recording no attempt
 *                                            error (b.jg5 SRJ-112, SRJ-113, SRJ-409)
 *   - armPendingOnlyForPendingRow(key)     — a covered `pending` row arms the persona's
 *                                            retry timer in pending-only mode, inside an
 *                                            attempt or outside every one (b.jg5 SRJ-301,
 *                                            SRJ-409)
 *   - endTmuxUnresponsiveForLaunchRow(key, reading) — SRJ-310's third end rule: after a
 *                                            launch timeout, this launch's row read live
 *                                            other than `pending` ends the persona's
 *                                            tmux-unresponsive condition (b.jg5 SRJ-310,
 *                                            SRJ-407)
 *   - _resetOutageState()                  — test-only state reset
 *
 * Template exports (used by tests):
 *   - OUTAGE_CLASS_ORDER                   — the stable class order (read-only)
 *   - ONSET_TEMPLATES
 *   - tmuxServerChangedOnset()             — SRJ-1021's onset for the re-bound socket
 *   - adConfigMalformedOnset(err)          — SRJ-1018's onset for a thrown CONFIG value
 *   - ALL_CLEAR_TEMPLATE
 *
 * `ad-config-malformed` (b.jg5 SRJ-316) is handled as `ad-unreachable` is:
 * the same destination, one onset (its one alert per episode: the flag is
 * its once-per-episode latch, so the `ad-config-malformed` kind in
 * `src/persona-episodes.ts` never posts) and one all-clear, which lists the
 * bare class: agent-director's description appears only in the onset. No
 * action is taken because of it; the retry timer retries the persona.
 *
 * The `tmux-unresponsive` condition (b.jg5 SRJ-307, SRJ-310) is a
 * per-persona condition kept in `src/persona-episodes.ts`, not an
 * `OutageClass`: this module only tells the installed condition sink when it
 * starts (a tmux-touching call's UNAVAILABLE, other than `ErrTmuxKillFailed`,
 * inside a launch or recovery attempt for the persona) and when a
 * tmux-touching call ends it (a success, or a GONE answer, in any context),
 * and offers the end entry of SRJ-310's third rule
 * (`endTmuxUnresponsiveForLaunchRow`).
 * Neither touches a flag, posts a notice or records bad-stretch history.
 *
 * The unclassified-error episode (b.jg5 SRJ-313) is kept in
 * `src/persona-episodes.ts` too: this module only reports to the installed
 * unclassified sink each UNCLASSIFIED outcome met inside a launch or recovery
 * attempt for the persona (at the reporting point, and through the site entry
 * for an outcome a site classifies itself). An UNCLASSIFIED outcome touches
 * no flag; `ErrSystemInstallDisappeared`, which is UNCLASSIFIED, still raises
 * `ad-unreachable` in the wrappers.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Client } from 'agent-director'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  adCallVerb,
  classifyAdError,
  describeAdErrorClassification,
  isDifferentTmuxServerError,
  isLaunchCall,
  isTmuxTouchingCall,
  type AdCall,
  type AdErrorClassification,
  type AdVerb,
} from './ad-error-class.ts'
import {
  ErrSystemInstallDisappeared,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
} from './agent-director-errors.ts'
import { describeThrownValue, renderLogMessageText } from './persona-connection-errors.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import {
  TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE,
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  type TmuxUnresponsiveSink,
  type UnclassifiedErrorSink,
} from './persona-episodes.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_LOST_RACE,
  UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_ROW_PENDING,
  isInsideAttempt,
  reportAttemptCause,
  reportAttemptError,
  unavailableRetryCauseFor,
  type UnavailableRetryTriggerSink,
} from './unavailable-retry.ts'

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Union of all outage classifications. No 'healthy' member — absence == healthy. */
export type OutageClass = 'ad-unreachable' | 'cwd-unreachable' | 'tmux-unavailable' | 'ad-config-malformed'

/** The `ad-config-malformed` class (b.jg5 SRJ-316): agent-director refuses its config file. */
const AD_CONFIG_MALFORMED: OutageClass = 'ad-config-malformed'

/**
 * Detail record for a single outage class in a bad stretch.
 * No `enteredAtIso` — timestamps are intentionally absent from the all-clear template.
 */
export interface ClassRecord {
  detail?: string
}

/** Per-persona state entry. */
interface PersonaEntry {
  /** Currently active outage flags. */
  flags: Set<OutageClass>
  /** Class → detail record for the current bad stretch. Reset to empty Map on all-clear. */
  badStretchClasses: Map<OutageClass, ClassRecord>
}

/** Dependencies injected via `initOutageState` — wires the module to production Slack + AD. */
export interface OutageStateDeps {
  /**
   * Fire-and-forget notice for the persona with this key: synchronous, and
   * errors MUST be handled internally by the caller. Production wires the
   * per-persona notifier, which adds the persona reference to `text`.
   * `options` says whether it is an onset or an all-clear, and of which
   * classes (b.jg5 SRJ-1002, SRJ-1003).
   */
  notify(key: string, text: string, options?: OutageNoticeOptions): void
  /** Return the singleton AD Client. Same semantics as getClient() in agent-director-client.ts. */
  getClient(): Client
  /**
   * Where an agent-director error met inside a launch or recovery attempt is
   * reported (b.jg5 SRJ-301): production passes the UNAVAILABLE retry
   * controller. Without it nothing is armed.
   */
  triggerSink?: UnavailableRetryTriggerSink
  /**
   * Where the persona's `tmux-unresponsive` condition is started and ended
   * (b.jg5 SRJ-307, SRJ-310): production passes the condition built over the
   * notice episodes (`createTmuxUnresponsiveCondition`). Without it nothing
   * starts or ends.
   */
  conditionSink?: TmuxUnresponsiveSink
  /**
   * The cleared-flag observer (b.jg5 SRJ-305, SRJ-311): called once each time
   * `clearOutageFlag` lowers a flag that was raised for persona `key`, with
   * its class and the reading the clear brought, when it came from a check
   * that read the row live (the health tick's healthy branch, a retry's
   * healthy row). Called after the state change and any all-clear notice. A
   * clear of a flag not raised, and `resetAllToHealthy` (boot, teardown),
   * never call it. It is told every class's clear, `ad-config-malformed`
   * included. Production binds it in `main()` so a `tmux-unavailable` clear,
   * and only that class's, reaches the retry timer's condition-end entry: an
   * `ad-config-malformed` clear stops no timer (b.jg5 SRJ-305 gives that
   * outage no stop). A throw is swallowed.
   * Absent: nothing is called.
   */
  onFlagCleared?: (key: string, cls: OutageClass, reading?: string) => void
  /**
   * Where an UNCLASSIFIED outcome in a launch or recovery attempt for the
   * persona is reported (b.jg5 SRJ-313): production passes the
   * unclassified-error episodes (`createUnclassifiedErrorEpisodes`,
   * `src/persona-episodes.ts`). Fed once per outcome by the reporting point
   * (`reportAgentDirectorError`), a row read's included, and by the site
   * entry (`reportUnclassifiedAtSite`). Without it nothing is reported; the
   * arming is unchanged.
   */
  unclassifiedSink?: UnclassifiedErrorSink
}

/**
 * What an outage notice is (b.jg5 SRJ-1002, SRJ-1003): an `onset` of its one
 * class, or an `all-clear` of every class it lists. The persona notifier's
 * `PersonaNoticeOptions.outage` takes it as given. An all-clear also carries
 * `allClearOf`, which renders the all-clear of a subset of its classes (the
 * same template over the same bad-stretch snapshot), so the notifier can
 * split it: the classes whose onset a persona teardown's window routed are
 * written, and the rest posted.
 */
export interface OutageNoticeOptions {
  readonly outage: {
    readonly phase: 'onset' | 'all-clear'
    readonly classes: readonly OutageClass[]
    /** All-clear only: the all-clear text of `classes`, a subset of the notice's (others ignored). Pure; never throws. */
    readonly allClearOf?: (classes: readonly string[]) => string
  }
}

/** Options of {@link reportAgentDirectorError}. */
export interface ReportAgentDirectorErrorOptions {
  /**
   * False keeps an UNCLASSIFIED outcome from the unclassified sink: the
   * liveness adapter's `ErrSystemInstallDisappeared`, which keeps its `dead`
   * reading (b.jg5 SRJ-105, SRJ-314). Its arming is unchanged. Default true.
   */
  reportUnclassified?: boolean
}

/** Options of {@link withOutageDetection}. */
export interface OutageDetectionOptions {
  /**
   * Present for a call made outside every launch or recovery attempt that
   * must arm nothing: a persona teardown's kill (b.jg5 SRJ-110, SRJ-301;
   * hatch A3). Its error is then not reported (`reportAgentDirectorError` is
   * not called: no retry timer is armed, no `tmux-unresponsive` condition is
   * started, nothing reaches the unclassified sink), and an ENVIRONMENT or
   * CONFIG answer raises its outage (`tmux-unavailable`,
   * `ad-config-malformed`) only when `personaConfigured()` answers true: the
   * persona is in the applied configuration. A `personaConfigured` that
   * throws counts as false. Everything else (the `ad-unreachable` raise, the
   * clears on a success or on GONE) is unchanged.
   */
  readonly armsNothing?: { readonly personaConfigured: () => boolean }
  /**
   * True for one try of a bounded kill retry made inside a launch or
   * recovery attempt (b.jg5 SRJ-702, SRJ-110: the UNAVAILABLE rows apply
   * "after the tries"): an UNAVAILABLE value (by class through
   * `src/ad-error-class.ts`, `ErrTmuxKillFailed` included) is not reported
   * here, so it arms no retry timer, starts no `tmux-unresponsive` condition
   * and is not recorded as the attempt's last error. The caller reports the
   * outcome that stands, once, through {@link reportDeferredUnavailable}.
   * Every other value is handled as without it: flags (ENVIRONMENT and
   * CONFIG raise their outages at once) and the report, since such an
   * outcome is never tried again and stands at once.
   */
  readonly deferUnavailableReport?: boolean
}

/** `options.armsNothing.personaConfigured()`, a throw counting as false. Never throws. */
function armsNothingPersonaConfigured(armsNothing: NonNullable<OutageDetectionOptions['armsNothing']>): boolean {
  try {
    return armsNothing.personaConfigured() === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: OutageStateDeps | undefined
const entries = new Map<string, PersonaEntry>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazy-create a PersonaEntry for persona `key` on first access. */
function entryFor(key: string): PersonaEntry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { flags: new Set(), badStretchClasses: new Map() }
    entries.set(key, entry)
  }
  return entry
}

// ---------------------------------------------------------------------------
// Notice templates
// ---------------------------------------------------------------------------

/**
 * OUTAGE_CLASS_ORDER — the stable class order: every `OutageClass`, once, in
 * the order the all-clear lists the resolved classes (b.jg5 SRJ-1018:
 * `ad-config-malformed` after `tmux-unavailable`). Read-only; tests and
 * persona-keyed audits iterate it.
 */
export const OUTAGE_CLASS_ORDER: readonly OutageClass[] = Object.freeze([
  'ad-unreachable',
  'cwd-unreachable',
  'tmux-unavailable',
  AD_CONFIG_MALFORMED,
])

/**
 * ONSET_TEMPLATES — one template function per outage class.
 * The optional `detail` parameter carries class-specific context
 * (binary path for ad-unreachable; the persona's working directory for
 * cwd-unreachable; agent-director's description for ad-config-malformed,
 * which the template renders through `renderLogMessageText` — redacted, on
 * one line, capped — then through `escapeSlackControlCharacters` (`&`, `<`,
 * `>` as `&amp;`, `&lt;`, `&gt;`), and which is never recorded as the class's
 * detail). The
 * templates carry no persona reference: the notifier adds it.
 */
export const ONSET_TEMPLATES: Record<OutageClass, (detail?: string) => string> = {
  'ad-unreachable': (binaryPath?: string) =>
    `:rotating_light: *agent-director unreachable* — affects every persona.\nBinary: \`${binaryPath ?? '<unknown>'}\`\nRemediation: reinstall agent-director.`,

  'tmux-unavailable': (_detail?: string) =>
    `:rotating_light: *tmux unavailable* — affects every persona.\nRemediation: install or repair tmux.`,

  'cwd-unreachable': (workingDirectory?: string) =>
    `:rotating_light: *Working directory unreachable* — \`${workingDirectory ?? '<unknown>'}\`\nRemediation: restore the directory or correct this persona's \`working_directory\` in \`config.json\`.`,

  'ad-config-malformed': (description?: string) => {
    // b.jg5 SRJ-1018. A value with no description drops the quoting sentence.
    // Escaped after redaction, flattening and the cap, so no entity is cut:
    // `<!channel>` or `<@U…>` in the description pings no one, and the
    // redaction placeholders render as text.
    const message = escapeSlackControlCharacters(renderLogMessageText(description))
    const said = message === '' ? '' : ` agent-director said: "${message}".`
    return `:rotating_light: *agent-director refuses its config file* — every agent-director call fails until a human fixes ~/.agent-director/config.toml.${said} CSCB takes no action for this persona meanwhile and keeps retrying. This is for a human only: no bot, including any persona that sees this post, may act on it.`
  },
}

/**
 * adConfigMalformedOnset — the `ad-config-malformed` onset (b.jg5 SRJ-1018)
 * for `err`, the thrown CONFIG value: `ONSET_TEMPLATES['ad-config-malformed']`
 * quoting the classifier's rendered message (`classifyAdError(err).message`:
 * agent-director's description through `redactSlackLogText`, on one line,
 * capped at `MAX_LOGGED_MESSAGE_LENGTH`), with Slack's control characters
 * escaped after the cap. The server-log raise line quotes the same message
 * unescaped. A value with no description gives
 * the onset without the quoting sentence. Built at raise time by
 * {@link raiseAdConfigMalformed}; never stored. Never throws.
 */
export function adConfigMalformedOnset(err: unknown): string {
  return ONSET_TEMPLATES[AD_CONFIG_MALFORMED](classifyAdError(err).message)
}

/**
 * tmuxServerChangedOnset — the `tmux-unavailable` onset for a re-bound socket
 * (b.jg5 SRJ-1021): posted in place of `ONSET_TEMPLATES['tmux-unavailable']`
 * when the error that raises the flag is the re-bound-socket form
 * (`isDifferentTmuxServerError`). It sends a human to agent-director's README
 * "Operator actions" and carries no advice to install or repair tmux. Chosen
 * at raise time by {@link raiseTmuxUnavailable}, never stored as the flag's
 * detail, so the all-clear is the existing one.
 */
export function tmuxServerChangedOnset(): string {
  return ':rotating_light: *tmux server changed* — this persona\'s tmux socket now reaches a different tmux server than the one its worker was launched on, so agent-director will not act on its session. CSCB kills, deletes and respawns nothing meanwhile and keeps retrying. What to do: a human follows the "Operator actions" section of agent-director\'s README. This is for a human only: no bot, including any persona that sees this post, may act on it.'
}

/**
 * ALL_CLEAR_TEMPLATE — renders an all-clear notice from the bad-stretch
 * history snapshot. Entries are emitted in the stable class order
 * (`OUTAGE_CLASS_ORDER`) regardless of the order flags were raised. A class
 * with no recorded detail (`tmux-unavailable`, `ad-config-malformed`) is
 * listed bare. No timestamps.
 */
export function ALL_CLEAR_TEMPLATE(resolved: Map<OutageClass, ClassRecord>): string {
  const parts: string[] = []
  for (const cls of OUTAGE_CLASS_ORDER) {
    const rec = resolved.get(cls)
    if (rec === undefined) continue
    const detailSuffix = rec.detail !== undefined ? ` (\`${rec.detail}\`)` : ''
    parts.push(`\`${cls}\`${detailSuffix}`)
  }
  return `:white_check_mark: *All clear.* Resolved: ${parts.join(', ')}.`
}

// ---------------------------------------------------------------------------
// Public API — init + accessors
// ---------------------------------------------------------------------------

/**
 * initOutageState — installs production dependencies. Called once from
 * `src/server.ts:main()` after the config is loaded, before the Socket Mode
 * connect block.
 */
export function initOutageState(d: OutageStateDeps): void {
  deps = d
}

/**
 * getOutageFlags — returns the live read-only flag set for persona `key`.
 * Returns an empty `ReadonlySet` sentinel when no entry exists yet.
 */
export function getOutageFlags(key: string): ReadonlySet<OutageClass> {
  return entries.get(key)?.flags ?? (new Set<OutageClass>() as ReadonlySet<OutageClass>)
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/**
 * setOutageFlag — raises `cls` for persona `key` and emits an onset notice.
 * Same-flag re-raise is a silent no-op (dedupe).
 *
 * State mutates BEFORE the emit so a synchronous throw in `notify`
 * cannot cause double-emission on the next observation.
 *
 * `ad-config-malformed` is raised through {@link raiseAdConfigMalformed}; a
 * `detail` given here for it renders in the onset only and is never recorded,
 * so the all-clear lists the bare class.
 */
export function setOutageFlag(key: string, cls: OutageClass, detail?: string): void {
  raiseFlag(key, cls, cls === AD_CONFIG_MALFORMED ? undefined : detail, () => ONSET_TEMPLATES[cls](detail))
}

/**
 * raiseTmuxUnavailable — the one raise entry for `tmux-unavailable` (b.jg5
 * SRJ-311, SRJ-1021), for every site that raises it on an ENVIRONMENT answer
 * (`ErrTmuxNotAvailable`): the wrappers, the liveness adapter's bare `status`
 * and the shared findMissing sweep's joiner. `err` is the error that raises
 * the flag. The onset is chosen here, from `err`: `tmuxServerChangedOnset()`
 * when `isDifferentTmuxServerError(err)` holds, else
 * `ONSET_TEMPLATES['tmux-unavailable']`. No detail is recorded, so the
 * all-clear is the existing one. Same-flag dedupe as `setOutageFlag`: while
 * the flag is raised, a second error of either form posts nothing.
 */
export function raiseTmuxUnavailable(key: string, err: unknown): void {
  raiseFlag(key, 'tmux-unavailable', undefined, () =>
    isDifferentTmuxServerError(err) ? tmuxServerChangedOnset() : ONSET_TEMPLATES['tmux-unavailable'](),
  )
}

/**
 * raiseAdConfigMalformed — the one raise entry for `ad-config-malformed`
 * (b.jg5 SRJ-316, SRJ-1018), for every site that raises it on a CONFIG answer
 * (`ErrConfigMalformed`, decided by the caller through `src/ad-error-class.ts`
 * by name): the wrappers and the liveness adapter's bare `status`. `err` is
 * the thrown value. The flag is set first, then one server-log line names
 * the persona and the classification (`describeAdErrorClassification`: the
 * reported name and the rendered message, no token), then the onset
 * (`adConfigMalformedOnset(err)`) is emitted. No detail is recorded, so the
 * all-clear lists the bare class. Same-flag dedupe as `setOutageFlag`: while
 * the flag is raised, a second CONFIG answer logs and posts nothing.
 *
 * The onset goes out through {@link notifyIsolated}: a `notify` that throws
 * or rejects is logged once and the onset counts as posted (the flag stays
 * raised, so it is not posted again this episode), and this entry never
 * throws. A wrapper raising it from its catch block therefore still reports
 * the CONFIG value (`reportAgentDirectorError`, which arms the retry timer)
 * and rethrows that value, not the notify failure.
 */
export function raiseAdConfigMalformed(key: string, err: unknown): void {
  raiseFlag(
    key,
    AD_CONFIG_MALFORMED,
    undefined,
    () => adConfigMalformedOnset(err),
    () => logAdConfigMalformedRaised(key, classifyAdError(err)),
    notifyIsolated,
  )
}

/**
 * Post `text` to persona `key` through `deps.notify` without letting it throw
 * or reject: a synchronous throw, or a returned promise that rejects, is
 * logged once (`describeThrownValue`) and otherwise ignored, so the notice
 * counts as posted (the precedent of `src/persona-episodes.ts`). Never throws.
 */
function notifyIsolated(key: string, text: string, options?: OutageNoticeOptions): void {
  const logFailure = (failure: unknown): void => {
    console.error(
      `[slack] outage-state: onset notice for persona=${key} failed: ${describeThrownValue(failure)} — the flag stays raised; the notice counts as posted`,
    )
  }
  try {
    const pending: unknown = deps?.notify(key, text, options)
    if (pending instanceof Promise) pending.catch(logFailure)
  } catch (failure) {
    logFailure(failure)
  }
}

/**
 * The `ad-config-malformed` raise line (b.jg5 SRJ-1014), built from the
 * classification's own fields only (`describeAdErrorClassification`: the
 * class, the reported name when safe, the rendered message), never from the
 * thrown value.
 */
function logAdConfigMalformedRaised(key: string, classification: AdErrorClassification): void {
  console.error(
    `[slack] outage-state: ad-config-malformed raised for persona=${key}: ${describeAdErrorClassification(classification)} — no action is taken; the retry timer retries the persona (b.jg5 SRJ-316)`,
  )
}

/**
 * Raise `cls` for persona `key` with `detail` recorded for the all-clear, and
 * emit the onset `onset` renders. Same-flag re-raise is a silent no-op
 * (dedupe); state mutates before the emit. `onRaised`, when given, runs once
 * on a real raise, after the state change and before the emit. The onset is
 * emitted through `post` when given, else `deps.notify` directly (so a
 * synchronous throw there reaches the caller).
 */
function raiseFlag(
  key: string,
  cls: OutageClass,
  detail: string | undefined,
  onset: () => string,
  onRaised?: () => void,
  post?: (key: string, text: string, options?: OutageNoticeOptions) => void,
): void {
  if (!deps) return
  const entry = entryFor(key)
  if (entry.flags.has(cls)) return // same-flag dedupe
  // Mutate state BEFORE emit (SR-V-2.x state-before-emit contract).
  entry.flags.add(cls)
  entry.badStretchClasses.set(cls, { detail })
  onRaised?.()
  const options: OutageNoticeOptions = { outage: { phase: 'onset', classes: [cls] } }
  if (post !== undefined) post(key, onset(), options)
  else deps.notify(key, onset(), options)
}

/**
 * clearOutageFlag — lowers `cls` for persona `key`. Emits the all-clear
 * notice ONLY when the clear leaves the flag set empty and there is a
 * non-empty bad-stretch history (i.e., at least one onset was recorded).
 * Intermediate clears (flag set still non-empty after removal) are silent.
 *
 * State mutates BEFORE the emit (same contract as setOutageFlag). After it,
 * a real clear (the flag was raised) is told to the cleared-flag observer
 * (`OutageStateDeps.onFlagCleared`) with `reading`: the row reading a check
 * that found the row live brings (b.jg5 SRJ-305), absent otherwise.
 *
 * A real `ad-config-malformed` clear logs one server-log line naming the
 * persona (b.jg5 SRJ-1014) after the state change and before any all-clear.
 * Its callers clear it only on an answer that shows agent-director read its
 * store: a wrapped call's success, and the liveness adapter's `status`
 * success or `ErrSpawnNotFound` (b.jg5 SRJ-312).
 */
export function clearOutageFlag(key: string, cls: OutageClass, reading?: string): void {
  if (!deps) return
  const entry = entries.get(key)
  if (!entry) return
  if (!entry.flags.has(cls)) return // same-state dedupe
  // Mutate state BEFORE emit.
  entry.flags.delete(cls)
  if (cls === AD_CONFIG_MALFORMED) {
    console.error(
      `[slack] outage-state: ad-config-malformed cleared for persona=${key} — agent-director read its store again (b.jg5 SRJ-312)`,
    )
  }
  if (entry.flags.size === 0 && entry.badStretchClasses.size > 0) {
    // Snapshot history and reset BEFORE the notify call.
    const snapshot = new Map(entry.badStretchClasses)
    entry.badStretchClasses = new Map()
    const allClearOf = (classes: readonly string[]): string =>
      ALL_CLEAR_TEMPLATE(new Map([...snapshot].filter(([cls]) => classes.includes(cls))))
    deps.notify(key, ALL_CLEAR_TEMPLATE(snapshot), { outage: { phase: 'all-clear', classes: [...snapshot.keys()], allClearOf } })
  }
  flagCleared(key, cls, reading)
}

/** Tell the cleared-flag observer of a real clear. Never throws. */
function flagCleared(key: string, cls: OutageClass, reading: string | undefined): void {
  try {
    deps?.onFlagCleared?.(key, cls, reading)
  } catch {
    /* an observer must not change what a clear does */
  }
}

/**
 * resetAllToHealthy — silently wipes each given persona's flag set and
 * bad-stretch history to a clean slate. No `notify` calls. Called at boot by
 * server.ts with the applied persona keys, before any persona is brought up,
 * as a defensive boundary for pre-start observations (added in Epic 2), and
 * with one key by a teardown (b.av2 SR-6.5), which clears that persona's
 * flags with no all-clear notice; other personas' entries are untouched. It
 * never calls the cleared-flag observer, so it stops no retry timer.
 */
export function resetAllToHealthy(keys: string[]): void {
  for (const key of keys) {
    entries.set(key, { flags: new Set(), badStretchClasses: new Map() })
  }
}

// ---------------------------------------------------------------------------
// Public API — AD verb wrappers
// ---------------------------------------------------------------------------

/**
 * withOutageDetection — centralized wrapper for AD verb calls that should
 * participate in outage detection. `call` is the verb `fn` calls, declared by
 * the site (`AdCall` in `src/ad-error-class.ts`; a `kill` also declares
 * whether it kills a row the site read live).
 *
 * On error:
 *   - ErrSystemInstallDisappeared → raises 'ad-unreachable' (detail = binaryPath)
 *   - ENVIRONMENT (`ErrTmuxNotAvailable`, by class through
 *     `src/ad-error-class.ts`) → raises 'tmux-unavailable' through
 *     `raiseTmuxUnavailable` with the error, which picks the onset
 *   - ErrCwdNotFound / ErrCwdNotADirectory → raises 'cwd-unreachable' (detail =
 *     workingDirectory, the persona's working directory) UNLESS
 *     workingDirectory is undefined, in which case logs loudly and rethrows
 *     WITHOUT raising the flag (defensive carve-out for verb-class drift).
 *   - CONFIG (`ErrConfigMalformed`, by class through `src/ad-error-class.ts`)
 *     from any declared verb, in or out of an attempt → raises
 *     'ad-config-malformed' through `raiseAdConfigMalformed` with the error
 *     (b.jg5 SRJ-316)
 *   - Other errors → no flag change; rethrow unchanged.
 * No error answer clears 'ad-config-malformed': not `ErrSpawnNotFound`, not
 * GONE (b.jg5 SRJ-312).
 * Then, every error is reported (`reportAgentDirectorError`) with the
 * declared call, which arms the persona's retry timer when the call ran
 * inside a launch or recovery attempt for it and the error is a trigger, or
 * the error is ENVIRONMENT or CONFIG (in any context, b.jg5 SRJ-311,
 * SRJ-316), and, inside such
 * an attempt, starts or continues its `tmux-unresponsive` condition when the
 * call is tmux-touching and the error is UNAVAILABLE (not
 * `ErrTmuxKillFailed`), and reports an UNCLASSIFIED error to the unclassified
 * sink (b.jg5 SRJ-313). A GONE answer (`ErrTmuxSendKeys`,
 * `ErrTmuxCaptureFailed`, by class) from a tmux-touching call clears
 * 'tmux-unavailable' and ends the condition, in any context, before the same
 * value is rethrown; a GONE-classed value from a call that is not
 * tmux-touching does neither.
 *
 * On success (b.jg5 SRJ-312):
 *   - 'ad-unreachable' clears on any call;
 *   - 'ad-config-malformed' clears on any call: every wrapped verb reads
 *     agent-director's store (`version` and `help` are never wrapped);
 *   - 'tmux-unavailable' clears only when the declared call is tmux-touching
 *     (`isTmuxTouchingCall`: `spawn`, plain or reuse, `resume`, `read-pane`,
 *     `send-keys`, `pause`, and a `kill` only when declared as a kill of a
 *     row read live). A successful `status`, `get`, `list`, `find-missing`,
 *     `delete`, `get-permission`, `decide` or undeclared-live `kill` leaves it
 *     raised: tmux did not answer them;
 *   - a tmux-touching call ends the persona's `tmux-unresponsive` condition,
 *     in any context. A launch call (`isLaunchCall`: `spawn`, plain or reuse,
 *     or `resume`) ends it, and clears 'tmux-unavailable', with the reading
 *     `pending`, the state its success leaves the row in, so the retry
 *     timer's `pending` exception keeps the timer (b.jg5 SRJ-305, SRJ-306);
 *     every other tmux-touching success, and a GONE answer, ends and clears
 *     with no reading.
 * Returns result.
 *
 * With `options.armsNothing` (a persona teardown's kill, b.jg5 SRJ-110,
 * SRJ-301; hatch A3) the error is not reported, so nothing is armed, started
 * or reported, and an ENVIRONMENT or CONFIG answer raises its outage only for
 * a persona in the applied configuration (`OutageDetectionOptions`).
 *
 * The original error is always rethrown so callers can handle it normally.
 */
export async function withOutageDetection<T>(
  key: string,
  workingDirectory: string | undefined,
  call: AdCall,
  fn: (client: Client) => Promise<T>,
  options?: OutageDetectionOptions,
): Promise<T> {
  if (!deps) {
    throw new Error(
      'outage-state: withOutageDetection called before initOutageState — caller-site bug',
    )
  }
  try {
    const result = await fn(deps.getClient())
    clearOutageFlag(key, 'ad-unreachable')
    clearOutageFlag(key, AD_CONFIG_MALFORMED)
    if (isTmuxTouchingCall(call)) {
      // A launch's success leaves its row `pending`: both ends bring that reading.
      const reading = isLaunchCall(call) ? UNAVAILABLE_RETRY_ROW_PENDING : undefined
      clearOutageFlag(key, 'tmux-unavailable', reading)
      endTmuxUnresponsive(key, reading)
    }
    return result
  } catch (err) {
    const { errorClass } = classifyAdError(err)
    const armsNothing = options?.armsNothing
    // b.jg5 SRJ-110 (hatch A3): a call that arms nothing raises an
    // ENVIRONMENT or CONFIG outage only for a configured persona.
    const raisesOutage = armsNothing === undefined || armsNothingPersonaConfigured(armsNothing)
    if (err instanceof ErrSystemInstallDisappeared) {
      setOutageFlag(key, 'ad-unreachable', err.binaryPath)
    } else if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
      if (raisesOutage) raiseTmuxUnavailable(key, err)
    } else if (errorClass === AD_ERROR_CLASS_CONFIG) {
      if (raisesOutage) raiseAdConfigMalformed(key, err)
    } else if (err instanceof ErrCwdNotFound || err instanceof ErrCwdNotADirectory) {
      if (workingDirectory !== undefined) {
        setOutageFlag(key, 'cwd-unreachable', workingDirectory)
      } else {
        console.error(
          `[slack] outage-state: withOutageDetection: cwd error on persona=${key} but workingDirectory is undefined — verb-class drift; rethrowing without raising flag: ${describeThrownValue(err)}`,
        )
      }
    }
    // b.jg5 SRJ-702: a deferred try's UNAVAILABLE is reported once, by its
    // caller, only when it is the outcome that stands.
    const deferred = options?.deferUnavailableReport === true && errorClass === AD_ERROR_CLASS_UNAVAILABLE
    if (armsNothing === undefined && !deferred) reportAgentDirectorError(key, err, call)
    if (isTmuxTouchingCall(call) && errorClass === AD_ERROR_CLASS_GONE) {
      // b.jg5 SRJ-312: GONE from a tmux-touching call is tmux answering.
      clearOutageFlag(key, 'tmux-unavailable')
      endTmuxUnresponsive(key)
    }
    throw err
  }
}

/**
 * reportAgentDirectorError — the one reporting point for an agent-director
 * error met by persona `key`'s call, declared as `call` (b.jg5 SRJ-301,
 * SRJ-307, SRJ-311). The wrappers call it for every wrapped call that throws,
 * and two unwrapped calls for their own errors: the liveness adapter's bare
 * `status` and the shared findMissing sweep's `find-missing`.
 *
 * - An ENVIRONMENT answer (`ErrTmuxNotAvailable`) or a CONFIG answer
 *   (`ErrConfigMalformed`) from any verb, `kill` included, is sent once to
 *   the installed trigger sink with its cause (ENVIRONMENT, b.jg5 SRJ-311;
 *   CONFIG, SRJ-316) in any context: inside an attempt for `key`, inside
 *   another persona's attempt, or outside every attempt
 *   (`reportAttemptError` in `src/unavailable-retry.ts`).
 * - Inside a launch or recovery attempt for `key`, any other error the
 *   arming predicate answers a cause for is sent once to the trigger sink,
 *   and the attempt records the error (ENVIRONMENT and CONFIG included) as
 *   its last, so a launch it ends is never counted and answers `retrying`
 *   when the timer was armed.
 * - Inside such an attempt, when the call is tmux-touching
 *   (`isTmuxTouchingCall`) and the arming predicate answers the UNAVAILABLE
 *   cause (never the kill-failure, ENVIRONMENT, CONFIG or UNCLASSIFIED
 *   cause), the installed condition sink starts or continues the persona's
 *   `tmux-unresponsive` condition.
 * - Inside such an attempt, an UNCLASSIFIED answer (by class, through
 *   `src/ad-error-class.ts`) from any verb, a `status`, `get` or `list`
 *   included, is reported once to the installed unclassified sink with the
 *   value and its classification (b.jg5 SRJ-313), unless
 *   `options.reportUnclassified` is false (the liveness adapter's
 *   `ErrSystemInstallDisappeared`). An `ErrInternal` carrying the unusable
 *   recorded name is UNUSABLE NAME, and is not reported. Outside an attempt
 *   for `key` nothing is reported.
 *
 * With no sink installed, nothing is armed, started or reported. Flags and notices are
 * untouched, and it never throws, so the caller's own handling and rethrow
 * are as without it.
 */
export function reportAgentDirectorError(
  key: string,
  err: unknown,
  call: AdCall,
  options?: ReportAgentDirectorErrorOptions,
): void {
  const verb = adCallVerb(call)
  reportAttemptError(key, err, verb, deps?.triggerSink)
  startTmuxUnresponsive(key, err, call, verb)
  if (options?.reportUnclassified !== false) reportUnclassified(key, err, verb)
}

/**
 * reportDeferredUnavailable — the one report of a bounded kill retry's
 * outcome that stands (b.jg5 SRJ-702, SRJ-301, SRJ-307), for tries made with
 * `OutageDetectionOptions.deferUnavailableReport`: when `err` is UNAVAILABLE
 * (by class through `src/ad-error-class.ts`), it is reported once through
 * the reporting point (`reportAgentDirectorError`) with `call`, the kill's
 * verb and its tmux-touching declaration, so the retry timer is armed once
 * (with the kill-failed cause for `ErrTmuxKillFailed`), the attempt records
 * it, and, for a tmux-touching kill and an UNAVAILABLE other than
 * `ErrTmuxKillFailed`, the `tmux-unresponsive` condition starts or
 * continues, each by the reporting point's own context rule. Any other value
 * reports nothing: its try reported it at once. Called only when the tries
 * end in a failure; a success, and a stop by a latching read or the
 * caller's keep-going check, report nothing. Never throws.
 */
export function reportDeferredUnavailable(key: string, err: unknown, call: AdCall): void {
  try {
    if (classifyAdError(err).errorClass !== AD_ERROR_CLASS_UNAVAILABLE) return
    reportAgentDirectorError(key, err, call)
  } catch {
    /* a failing report changes nothing about the kill's own outcome */
  }
}

/**
 * reportUnclassifiedAtSite — the site entry for an UNCLASSIFIED outcome a
 * site classifies itself (b.jg5 SRJ-104, SRJ-313): an `ErrInvalidFlags` at
 * the resume path, at the shared pane reader (`readPersonaOwnPane` in
 * `src/session-manager.ts`, `call` `read-pane`), at the reconnect's one
 * `send-keys` (`reconnectMcpWithCause`, `call` `send-keys`) or at a kill
 * made in an attempt (`killPersonaInstance`, `call` `kill`), once its
 * immediate re-check answered UNCLASSIFIED without stopping the server; and
 * at such a kill, any other class the kill has no row for (b.jg5 SRJ-110: a
 * STATE name other than `ErrSpawnNotFound`, LAUNCH FAILURE, DIRECTORY).
 * `classification` is the step's answer. Inside a launch or recovery attempt
 * for `key` it arms the persona's retry timer with the UNCLASSIFIED cause
 * through the installed trigger sink (the attempt records it as its last
 * error, so a launch it ends answers `retrying` when the timer was armed)
 * and reports the outcome once to the installed unclassified sink with the
 * classification; outside one it does nothing. The wrapper's own report of
 * the same value armed and reported nothing (`ErrInvalidFlags` is STATE to
 * the arming predicate), so the outcome is reported once. It starts no
 * condition, touches no flag and never throws. Answers whether the timer was
 * armed.
 */
export function reportUnclassifiedAtSite(
  key: string,
  err: unknown,
  call: AdCall,
  classification: AdErrorClassification,
): boolean {
  if (!isInsideAttempt(key)) return false
  const armed = reportAttemptCause(key, { kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, error: err }, adCallVerb(call), deps?.triggerSink)
  sendUnclassified(key, err, classification)
  return armed
}

/**
 * reportReuseCollisionAtSite — a reuse spawn's second collision
 * (`ErrInstanceIdCollision`, b.jg5 SRJ-112, SRJ-301) at a launch site that
 * ends its attempt on it (a collision ladder reuse site, in the one re-run
 * of get-then-act the first collision gave): inside a launch or recovery attempt
 * for `key` it arms the persona's retry timer with the reuse-collision cause
 * (`UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION`) through the installed trigger
 * sink, and the attempt records it as its last error, so a launch it ends is
 * never counted and answers `retrying` when the timer was armed; outside one
 * it does nothing. It starts no condition, posts nothing and never throws.
 * Answers whether the timer was armed.
 */
export function reportReuseCollisionAtSite(key: string): boolean {
  return reportAttemptCause(key, { kind: UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION }, 'spawn', deps?.triggerSink)
}

/**
 * reportLostRaceAtSite — a lost race at the collision ladder (b.jg5
 * SRJ-710, SRJ-609, SRJ-301): `resume`'s `ErrSpawnNotResumable` whose
 * re-read found no reason to act, or a resume site's replacement whose
 * re-read found the row live on a path with no dead evidence. The ladder
 * ends its attempt on it with nothing killed, deleted or launched: inside a launch or
 * recovery attempt for `key` it arms the persona's retry timer with the
 * lost-race cause (`UNAVAILABLE_RETRY_CAUSE_LOST_RACE`) through the
 * installed trigger sink, and the attempt records it as its last error, so
 * a launch it ends is never counted and answers `retrying` when the timer
 * was armed; outside one it does nothing. It starts no condition, posts
 * nothing and never throws. Answers whether the timer was armed.
 */
export function reportLostRaceAtSite(key: string): boolean {
  return reportAttemptCause(key, { kind: UNAVAILABLE_RETRY_CAUSE_LOST_RACE }, 'resume', deps?.triggerSink)
}

/**
 * armPendingOnlyAfterLaunchFailure — a launch's `ErrTmuxSessionCreate`
 * (b.jg5 SRJ-112, SRJ-113, SRJ-301, SRJ-409): arm persona `key`'s retry
 * timer at once, with no `get` first, in pending-only mode with the
 * `pending-row` cause, through the installed trigger sink's optional
 * `armPendingOnly` (production: the retry controller), so that the retry's
 * read of the row decides what the failure left (agent-director's restore
 * may not have applied, HO rev 28). A timer already in full mode stays in
 * full mode (another SRJ-301 cause holds). Only inside a launch or recovery
 * attempt for `key`; outside one, or with no sink or none with
 * `armPendingOnly`, it arms nothing. It records no attempt error, so the
 * launch's counted `failed` result is never answered as `retrying`. Answers
 * whether the sink was asked to arm. Never throws.
 */
export function armPendingOnlyAfterLaunchFailure(key: string): boolean {
  try {
    if (!isInsideAttempt(key)) return false
    const sink = deps?.triggerSink
    if (sink?.armPendingOnly === undefined) return false
    sink.armPendingOnly(key)
    return true
  } catch {
    return false
  }
}

/**
 * armPendingOnlyForPendingRow — a covered `pending` row of persona `key`
 * (b.jg5 SRJ-301, SRJ-409): arm its retry timer in pending-only mode with
 * the `pending-row` cause through the installed trigger sink's optional
 * `armPendingOnly` (production: the retry controller), inside an attempt or
 * outside every one: the row a launch that returned left, a row the
 * collision ladder, the restart path's deferral or the pending-only retry
 * read `pending` and found covered or undecided, and the row a dialog
 * approver leaves when it stops. A timer already in full mode stays in full
 * mode. Records no attempt error and starts no condition. With no sink, or
 * none with `armPendingOnly`, it arms nothing. The caller decides whether
 * the persona may be armed (a latched persona never is). Answers whether
 * the sink was asked to arm. Never throws.
 */
export function armPendingOnlyForPendingRow(key: string): boolean {
  try {
    const sink = deps?.triggerSink
    if (sink?.armPendingOnly === undefined) return false
    sink.armPendingOnly(key)
    return true
  } catch {
    return false
  }
}

/**
 * Report `err` to the installed unclassified sink once when the current call
 * runs inside a launch or recovery attempt for `key` and the classifier
 * answers UNCLASSIFIED (from any declared verb, the reads included; b.jg5
 * SRJ-313). A call with no known verb is not reported, as it arms nothing.
 * Never throws.
 */
function reportUnclassified(key: string, err: unknown, verb: AdVerb | undefined): void {
  try {
    if (deps?.unclassifiedSink === undefined || verb === undefined || !isInsideAttempt(key)) return
    if (classifyAdError(err).errorClass !== AD_ERROR_CLASS_UNCLASSIFIED) return
    // The sink classifies the value itself (`UnclassifiedErrorSink.report`).
    sendUnclassified(key, err)
  } catch {
    /* a failing sink changes nothing about the call's own outcome */
  }
}

/** Hand one outcome to the installed unclassified sink, with the site's own classification when given. Never throws. */
function sendUnclassified(key: string, err: unknown, classification?: AdErrorClassification): void {
  try {
    deps?.unclassifiedSink?.report(key, err, classification)
  } catch {
    /* a failing sink changes nothing about the call's own outcome */
  }
}

/**
 * Start or continue persona `key`'s `tmux-unresponsive` condition for `err`
 * from `call`, when the call ran inside an attempt for `key`, is
 * tmux-touching and the arming predicate answers the UNAVAILABLE cause (so
 * never for ENVIRONMENT or CONFIG, b.jg5 SRJ-307). Never throws.
 */
function startTmuxUnresponsive(key: string, err: unknown, call: AdCall, verb: AdVerb | undefined): void {
  try {
    const sink = deps?.conditionSink
    if (sink === undefined || verb === undefined) return
    if (!isInsideAttempt(key) || !isTmuxTouchingCall(call)) return
    if (unavailableRetryCauseFor(err, verb)?.kind !== UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE) return
    sink.start(key, verb, err)
  } catch {
    /* a failing condition sink changes nothing about the call's own outcome */
  }
}

/**
 * End persona `key`'s `tmux-unresponsive` condition (a tmux-touching success
 * or GONE), with `reading` (`pending` for a launch's success, else none).
 * Never throws.
 */
function endTmuxUnresponsive(key: string, reading?: string): void {
  try {
    deps?.conditionSink?.end(key, TMUX_UNRESPONSIVE_END_TMUX_VERB, reading)
  } catch {
    /* a failing condition sink changes nothing about the call's own outcome */
  }
}

/**
 * endTmuxUnresponsiveForLaunchRow — SRJ-310's third end rule (b.jg5 SRJ-310,
 * SRJ-407): after a launch timeout, this launch's row (its launch start
 * inside the launch call's window) was read in `reading`, a live state other
 * than `pending`, so persona `key`'s `tmux-unresponsive` condition ends
 * through the installed condition sink with the end reason
 * `TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE` and that reading, which the
 * condition hands to its condition-end hook (the retry controller's
 * condition-end entry, so SRJ-306's exceptions apply). The condition posts
 * its recovery only when an onset or alert was posted, and does nothing for
 * a persona it does not hold. Works in any context. The caller decides that
 * the rule applies (the session manager's shared own-row reads, once a
 * `pending` read established this launch's row). With no sink installed
 * nothing ends. Answers whether the sink was asked to end it. Never throws.
 */
export function endTmuxUnresponsiveForLaunchRow(key: string, reading: string): boolean {
  try {
    const sink = deps?.conditionSink
    if (sink === undefined) return false
    sink.end(key, TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE, reading)
    return true
  } catch {
    return false
  }
}

/**
 * withSpawnDetection — like `withOutageDetection` but also clears
 * 'cwd-unreachable' on success. Spawn and resume verbs are the only calls
 * that actually exercise the persona's working directory, so its health is
 * only confirmed by a successful spawn/resume.
 */
export async function withSpawnDetection<T>(
  key: string,
  workingDirectory: string | undefined,
  call: AdCall,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const result = await withOutageDetection(key, workingDirectory, call, fn)
  clearOutageFlag(key, 'cwd-unreachable')
  return result
}

// ---------------------------------------------------------------------------
// Test-only
// ---------------------------------------------------------------------------

/**
 * _resetOutageState — clears all module-scoped state. For tests only.
 * Production code must not call this.
 */
export function _resetOutageState(): void {
  deps = undefined
  entries.clear()
}
