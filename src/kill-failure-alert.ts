/**
 * kill-failure-alert.ts — The kill-failure alert's texts and its route
 * selection (b.jg5 SRJ-704, SRJ-1007, SRJ-1013).
 *
 * The alert has two versions:
 *   - the ordinary version (`:rotating_light: *Kill failed*`), for a kill
 *     that still fails after the bounded retry (`src/kill-retry.ts`'s
 *     `ordinary` decision), whose row is kept. It quotes agent-director's
 *     description of the last kill failure; after a survivor-naming
 *     `ErrTmuxKillFailed` earlier in the same retry, the latest
 *     survivor-naming description, and both, in SRJ-1007's two-description
 *     form, when the last outcome is an `ErrTmuxKillFailed` naming no
 *     survivor. With no description it leaves the "agent-director said"
 *     sentence out;
 *   - the survivor version (`:rotating_light: *Process outlived kill*`), for
 *     a bounded retry that ended as a success after a survivor-naming
 *     `ErrTmuxKillFailed` (the retry's `survivor` decision). It quotes the
 *     latest survivor-naming description and lists the pids it names
 *     (`survivorPids`, `src/ad-description-phrases.ts`, the one module that
 *     holds the survivor-naming form), and names no command.
 * Each body is followed by the closing sentence for where the alert goes,
 * from its version's own table (the `KILL_FAILURE_*_CLOSING` constants).
 * Only the ordinary version at a configured persona's destination, when the
 * persona is not latched, says that CSCB keeps retrying.
 *
 * Every quoted description, the session and the instance id go through the
 * shared redaction on one line, capped as every quoted agent-director
 * description is (`renderLogMessageText`, b.jg5 SRJ-1001). The Slack-bound
 * text (`forSlack`) also escapes Slack's control characters
 * (`escapeSlackControlCharacters`, `src/slack-text-escape.ts`), as every
 * notice that quotes agent-director's text does; a log line or a
 * startup-errors entry carries the text unescaped.
 *
 * Every command the texts name (`agent-director read-pane` and
 * `agent-director kill` in the ordinary version) is a human's step, and the
 * text says that no bot, including any persona that sees the post, may run
 * it; the survivor version names no command. The survivor version's pid list
 * rests on SRJ-702's working default for the survivor-naming form
 * (`SURVIVOR_PID_PATTERN`), not yet checked against agent-director's release
 * candidate (b.jg5 E38 checks it).
 *
 * The route selection ({@link selectKillFailureAlertRoute}, SRJ-704, first
 * match wins, for either version):
 *   1. a start-sweep kill: the server log and an `orphan-cleanup` entry;
 *   2. a CLI teardown: printed, the server log and a `persona-kill-failed`
 *      entry;
 *   3. a persona teardown: the server log and a `persona-teardown-notice`
 *      entry;
 *   4. a persona no longer in the applied configuration (an old-life wait's
 *      kill always): the server log and a `persona-kill-failed` entry;
 *   5. any other persona in the applied configuration: its destination; the
 *      ordinary version once per kill-failure episode, the survivor version
 *      once per bounded retry.
 * The survivor version's entry, on every route that writes one, is of its
 * own class, `persona-kill-survivor` (SRJ-1013). The persona teardown's
 * class, `persona-teardown-notice` (`PERSONA_TEARDOWN_NOTICE_LABEL`), is the
 * one constant the persona notifier (`src/persona-notifier.ts`), which owns
 * the teardown route for every notice raised during a persona teardown
 * (SRJ-1003), imports and re-exports. While a persona's teardown window is
 * open, the kill-failure alerts take the persona-teardown route for any
 * alert raised for its key, whatever its context but a start-sweep or CLI
 * teardown kill (`src/persona-episodes.ts`).
 *
 * Who raises which route: the restart path's kill and the live-row
 * sequence's kills (`src/server.ts`, `src/session-manager.ts`, through the
 * kill-failure alerts of `src/persona-episodes.ts`, with the context
 * `recovery` for the server's own paths, a sequence the collision ladder
 * starts included) raise a configured persona's destination route and the
 * not-configured route; the start sweep (`reconcileOrphans`,
 * `src/session-manager.ts`) writes the start-sweep route's entries; the
 * persona teardown (`runTeardown`, `src/persona-lifecycle.ts`, through the
 * `raiseKillFailureAlert` that `main()` binds to the same kill-failure
 * alerts with the context `persona teardown`) raises the persona-teardown
 * route. The CLI teardown's, the old-life wait's and the stuck-launch
 * abort's routes are selected here; no site raises them.
 *
 * Pure module: no module-scope state, no environment or file access, no
 * server-only import (no notifier, Slack client, latch, episodes, outage
 * state or server module), and nothing runs at import, so every process that
 * kills a row can build the same texts.
 *
 * SPDX-License-Identifier: MIT
 */

import { survivorPids } from './ad-description-phrases.ts'
import type { KillRetryAlert } from './kill-retry.ts'
import { renderLogMessageText } from './persona-connection-errors.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'

// ---------------------------------------------------------------------------
// Versions, contexts and classes
// ---------------------------------------------------------------------------

/** The ordinary version: a kill that still fails after the bounded retry (SRJ-1007). */
export const KILL_FAILURE_VERSION_ORDINARY = 'ordinary'
/** The survivor version: a bounded retry that ended as a success after a survivor-naming failure (SRJ-1007). */
export const KILL_FAILURE_VERSION_SURVIVOR = 'survivor'

/** Which version of the alert. */
export type KillFailureAlertVersion = typeof KILL_FAILURE_VERSION_ORDINARY | typeof KILL_FAILURE_VERSION_SURVIVOR

/** Context: a start-sweep kill (SRJ-714). */
export const KILL_FAILURE_CONTEXT_START_SWEEP = 'start sweep'
/** Context: a CLI teardown's kill (SRJ-904, SRJ-909). */
export const KILL_FAILURE_CONTEXT_CLI_TEARDOWN = 'CLI teardown'
/** Context: a persona teardown's kill (removal or destructive modify, SRJ-1003). */
export const KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN = 'persona teardown'
/** Context: an old-life wait's kill (SRJ-811). */
export const KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT = 'old-life wait'
/** Context: the abort of CSCB's own stuck launch (SRJ-412). */
export const KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT = 'stuck-launch abort'
/**
 * Context: the server's restart path, its collision ladder, or a live-row
 * sequence one of them started (SRJ-1007). It names the context in the log
 * line and entry of an alert for a persona no longer in the applied
 * configuration; for a configured persona the alert goes to its destination.
 */
export const KILL_FAILURE_CONTEXT_RECOVERY = 'recovery'

/** Every context SRJ-1007 lists, in its order. */
export const KILL_FAILURE_CONTEXTS = [
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
  KILL_FAILURE_CONTEXT_RECOVERY,
] as const

/** Where a kill-failure alert was raised. */
export type KillFailureAlertContext = (typeof KILL_FAILURE_CONTEXTS)[number]

/**
 * The `startup-errors.log` class of the ordinary version with no Slack
 * destination outside a persona teardown and the start sweep: a CLI
 * teardown, a persona no longer in the applied configuration, an old-life
 * wait's kill (SRJ-1013).
 */
export const PERSONA_KILL_FAILED_LABEL = 'persona-kill-failed'

/** The `startup-errors.log` class of the survivor version on every route that writes an entry (SRJ-1013). */
export const PERSONA_KILL_SURVIVOR_LABEL = 'persona-kill-survivor'

/**
 * The `startup-errors.log` class of a notice raised during a persona teardown
 * (SRJ-1003, SRJ-1013): the ordinary version's on the persona-teardown route,
 * and every other notice the persona notifier's teardown window writes. The
 * one constant: the persona notifier (`src/persona-notifier.ts`), which owns
 * the teardown route for every notice, imports and re-exports it, since this
 * module may load no notifier.
 */
export const PERSONA_TEARDOWN_NOTICE_LABEL = 'persona-teardown-notice'

/**
 * The start sweep's class (SRJ-714, SRJ-1013): the ordinary version rides in
 * its entry. The start sweep's own entries (`reconcileOrphans`,
 * `src/session-manager.ts`) are of this class too.
 */
export const ORPHAN_CLEANUP_LABEL = 'orphan-cleanup'

// ---------------------------------------------------------------------------
// Closing sentences (SRJ-1007)
// ---------------------------------------------------------------------------

/** Ordinary version, a configured persona's destination, the persona not latched. */
export const KILL_FAILURE_ORDINARY_DESTINATION_CLOSING = 'CSCB keeps retrying on its own and posts no second alert about this.'

/**
 * Ordinary version, a configured persona's destination, when the retry's last
 * outcome latched the persona, or a `status` read between its tries did
 * (hatch A2); its own hold post goes there too.
 */
export const KILL_FAILURE_ORDINARY_LATCHED_CLOSING =
  'This persona is held for a human (see its hold post); CSCB posts no second alert about this.'

/** Ordinary version, a CLI teardown (printed, the server log, `persona-kill-failed`). */
export const KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING =
  'The CLI does not retry this kill: once the worker is ended, run the command again.'

/** Ordinary version, a start-sweep kill, a persona teardown, or a persona no longer in the applied configuration. */
export const KILL_FAILURE_ORDINARY_LOG_ONLY_CLOSING =
  "CSCB retries this kill only while a persona waits on this worker (its own persona's next launch, or a persona in its working directory); until one does, nothing retries it."

/** Survivor version, a configured persona's destination. */
export const KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING =
  'CSCB takes no further action on this process and posts no second alert about it.'

/** Survivor version, a CLI teardown (printed, the server log, `persona-kill-survivor`). */
export const KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING =
  "This persona's teardown has finished; nothing in CSCB checks this process again."

/** Survivor version, a start-sweep kill, a persona teardown, or a persona no longer in the applied configuration. */
export const KILL_FAILURE_SURVIVOR_LOG_ONLY_CLOSING = 'CSCB does not retry this kill or check this process again.'

/** Closing: a configured persona's destination, not latched (either version). */
export const KILL_FAILURE_CLOSING_DESTINATION = 'destination'
/** Closing: a configured persona's destination, the persona latched (ordinary version only). */
export const KILL_FAILURE_CLOSING_DESTINATION_LATCHED = 'destination-latched'
/** Closing: a CLI teardown. */
export const KILL_FAILURE_CLOSING_CLI_TEARDOWN = 'cli-teardown'
/** Closing: a start-sweep kill, a persona teardown, or a persona no longer in the applied configuration. */
export const KILL_FAILURE_CLOSING_LOG_ONLY = 'log-only'

/** Which row of a version's closing table. */
export type KillFailureClosing =
  | typeof KILL_FAILURE_CLOSING_DESTINATION
  | typeof KILL_FAILURE_CLOSING_DESTINATION_LATCHED
  | typeof KILL_FAILURE_CLOSING_CLI_TEARDOWN
  | typeof KILL_FAILURE_CLOSING_LOG_ONLY

/**
 * The closing sentence of `version` for `closing` (SRJ-1007). The survivor
 * version has no latched row: its destination sentence is used for a latched
 * persona too, since it neither holds the persona nor says CSCB retries.
 */
export function killFailureClosingSentence(version: KillFailureAlertVersion, closing: KillFailureClosing): string {
  if (version === KILL_FAILURE_VERSION_SURVIVOR) {
    switch (closing) {
      case KILL_FAILURE_CLOSING_CLI_TEARDOWN:
        return KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING
      case KILL_FAILURE_CLOSING_LOG_ONLY:
        return KILL_FAILURE_SURVIVOR_LOG_ONLY_CLOSING
      default:
        return KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING
    }
  }
  switch (closing) {
    case KILL_FAILURE_CLOSING_DESTINATION_LATCHED:
      return KILL_FAILURE_ORDINARY_LATCHED_CLOSING
    case KILL_FAILURE_CLOSING_CLI_TEARDOWN:
      return KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING
    case KILL_FAILURE_CLOSING_LOG_ONLY:
      return KILL_FAILURE_ORDINARY_LOG_ONLY_CLOSING
    default:
      return KILL_FAILURE_ORDINARY_DESTINATION_CLOSING
  }
}

// ---------------------------------------------------------------------------
// Route selection (SRJ-704, SRJ-1013)
// ---------------------------------------------------------------------------

/** Route: a start-sweep kill (the server log and an entry). */
export const KILL_FAILURE_ROUTE_START_SWEEP = 'start-sweep'
/** Route: a CLI teardown (printed, the server log and an entry). */
export const KILL_FAILURE_ROUTE_CLI_TEARDOWN = 'cli-teardown'
/** Route: a persona teardown (the server log and an entry). */
export const KILL_FAILURE_ROUTE_PERSONA_TEARDOWN = 'persona-teardown'
/** Route: a persona no longer in the applied configuration (the server log and an entry). */
export const KILL_FAILURE_ROUTE_NOT_CONFIGURED = 'not-configured'
/** Route: a configured persona's destination. */
export const KILL_FAILURE_ROUTE_DESTINATION = 'destination'

/** Which of SRJ-704's routes. */
export type KillFailureAlertRouteKind =
  | typeof KILL_FAILURE_ROUTE_START_SWEEP
  | typeof KILL_FAILURE_ROUTE_CLI_TEARDOWN
  | typeof KILL_FAILURE_ROUTE_PERSONA_TEARDOWN
  | typeof KILL_FAILURE_ROUTE_NOT_CONFIGURED
  | typeof KILL_FAILURE_ROUTE_DESTINATION

/** What the route selection is asked. */
export interface KillFailureAlertRouteInput {
  /** Which version is raised. */
  readonly version: KillFailureAlertVersion
  /** Where it was raised. */
  readonly context: KillFailureAlertContext
  /** Whether the persona is in the applied configuration when the alert is raised. */
  readonly configured: boolean
  /**
   * Whether the persona is latched now: by the bounded retry's last outcome
   * (a CONFLICT or an UNUSABLE NAME answer) or by a `status` read between its
   * tries (SRJ-702; hatch A2). Only the ordinary version at a destination
   * reads it.
   */
  readonly latched: boolean
}

/** What the route selection answers. */
export interface KillFailureAlertRoute {
  /** Which route. */
  readonly route: KillFailureAlertRouteKind
  /** True for a configured persona's destination (a Slack post); false for a log-only route. */
  readonly destination: boolean
  /** The startup-errors class of a log-only route's entry; absent at a destination. */
  readonly classLabel?: string
  /** True when the text is printed too (a CLI teardown). */
  readonly printed: boolean
  /** True when raising it opens the persona's kill-failure episode (the ordinary version at a destination). */
  readonly opensEpisode: boolean
  /** Which closing row applies. */
  readonly closing: KillFailureClosing
  /** The closing sentence. */
  readonly closingSentence: string
}

/**
 * SRJ-704's route for an alert, first match wins (see the module comment),
 * with SRJ-1013's class and SRJ-1007's closing sentence. Pure; never throws.
 */
export function selectKillFailureAlertRoute(input: KillFailureAlertRouteInput): KillFailureAlertRoute {
  const { version, context } = input
  const survivor = version === KILL_FAILURE_VERSION_SURVIVOR
  const logOnly = (route: KillFailureAlertRouteKind, ordinaryClass: string, closing: KillFailureClosing, printed = false): KillFailureAlertRoute =>
    Object.freeze({
      route,
      destination: false,
      classLabel: survivor ? PERSONA_KILL_SURVIVOR_LABEL : ordinaryClass,
      printed,
      opensEpisode: false,
      closing,
      closingSentence: killFailureClosingSentence(version, closing),
    })
  if (context === KILL_FAILURE_CONTEXT_START_SWEEP) {
    return logOnly(KILL_FAILURE_ROUTE_START_SWEEP, ORPHAN_CLEANUP_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  }
  if (context === KILL_FAILURE_CONTEXT_CLI_TEARDOWN) {
    return logOnly(KILL_FAILURE_ROUTE_CLI_TEARDOWN, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_CLI_TEARDOWN, true)
  }
  if (context === KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN) {
    return logOnly(KILL_FAILURE_ROUTE_PERSONA_TEARDOWN, PERSONA_TEARDOWN_NOTICE_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  }
  // An old-life wait's kill is of a retired key's old life: always a persona
  // no longer in the applied configuration (SRJ-704).
  if (context === KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT || input.configured !== true) {
    return logOnly(KILL_FAILURE_ROUTE_NOT_CONFIGURED, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  }
  const closing = !survivor && input.latched === true ? KILL_FAILURE_CLOSING_DESTINATION_LATCHED : KILL_FAILURE_CLOSING_DESTINATION
  return Object.freeze({
    route: KILL_FAILURE_ROUTE_DESTINATION,
    destination: true,
    printed: false,
    opensEpisode: !survivor,
    closing,
    closingSentence: killFailureClosingSentence(version, closing),
  })
}

// ---------------------------------------------------------------------------
// Bodies (SRJ-1007)
// ---------------------------------------------------------------------------

/**
 * The descriptions the ordinary version quotes, raw, as the bounded retry's
 * `ordinary` decision carries them (`src/kill-retry.ts`'s `KillRetryAlert`).
 */
export interface KillFailureOrdinaryQuotes {
  /** The standing outcome's `ErrTmuxKillFailed` description. */
  readonly lastKillFailedDescription?: string
  /** The latest survivor-naming description of an earlier try. */
  readonly earlierSurvivorDescription?: string
}

/** What the ordinary body is built from. */
export interface KillFailureOrdinaryBodyInput {
  /** The session the alert concerns, unquoted (`slack_bot_<key>` for a persona's own). */
  readonly session: string
  /** The row's instance id: `cscb_<key>`, an old key's instance id, or a pre-persona row's id. */
  readonly instanceId: string
  /** The descriptions to quote, raw; none leaves the "agent-director said" sentence out. */
  readonly quotes?: KillFailureOrdinaryQuotes
  /** True for a Slack post: Slack's control characters are escaped too. */
  readonly forSlack: boolean
}

/** What the survivor body is built from. */
export interface KillFailureSurvivorBodyInput {
  /** The session the alert concerns, unquoted. */
  readonly session: string
  /** The latest survivor-naming description, raw. */
  readonly survivorDescription: string
  /** True for a Slack post: Slack's control characters are escaped too. */
  readonly forSlack: boolean
}

/**
 * A text CSCB did not write, for an alert: redacted on one line and capped
 * (`renderLogMessageText`), then escaped for Slack when `forSlack`.
 * `fallback` when it renders empty. Never throws.
 */
function renderQuoted(text: unknown, forSlack: boolean, fallback = ''): string {
  const rendered = renderLogMessageText(text)
  const value = rendered === '' ? fallback : rendered
  return forSlack ? escapeSlackControlCharacters(value) : value
}

/** `<session>`: the session name in double quotes (SRJ-1001). */
function renderSession(session: string, forSlack: boolean): string {
  return `"${renderQuoted(session, forSlack, 'unknown')}"`
}

/**
 * The ordinary version's "agent-director said" sentence with its trailing
 * space, or the empty string when there is no description (SRJ-1007): one
 * description quoted; with both, the last kill failure's and then the
 * earlier survivor-naming one, in the stated form.
 */
function agentDirectorSaid(quotes: KillFailureOrdinaryQuotes | undefined, forSlack: boolean): string {
  const last = renderQuoted(quotes?.lastKillFailedDescription, forSlack)
  const earlier = renderQuoted(quotes?.earlierSurvivorDescription, forSlack)
  if (last !== '' && earlier !== '') {
    return `agent-director said: "${last}" and, earlier in these tries, "${earlier}". `
  }
  const one = last !== '' ? last : earlier
  return one === '' ? '' : `agent-director said: "${one}". `
}

/** The ordinary version's body, with no closing sentence (SRJ-1007). Never throws. */
export function killFailureOrdinaryBody(input: KillFailureOrdinaryBodyInput): string {
  const { forSlack } = input
  const session = renderSession(input.session, forSlack)
  const id = renderQuoted(input.instanceId, forSlack, 'unknown')
  return (
    `:rotating_light: *Kill failed* — agent-director could not end the worker in session ${session}: ` +
    "it, or another process in that session's panes, may still be running, and its agent-director row was kept. " +
    agentDirectorSaid(input.quotes, forSlack) +
    `A human's next step: check it with \`agent-director read-pane --claude-instance-id ${id}\`; ` +
    `if the worker still runs, run \`agent-director kill --claude-instance-id ${id}\` and check its result. ` +
    "A read-pane answer of ErrTmuxCaptureFailed does not prove the worker gone when agent-director's description says no session or pane of this launch was found, " +
    'and a pane does not prove it is the worker\'s when kill then answers "not this launch\'s session", ' +
    "because read-pane can return a leftover's pane; " +
    'for these, and for anything beyond kill, follow the "Operator actions" section of agent-director\'s README. ' +
    'These commands are for a human only: no bot, including any persona that sees this post, may run them.'
  )
}

/**
 * `<pid list>` (SRJ-1007): "pid N" for each pid `description` names in the
 * survivor-naming form (`survivorPids`, one per match of
 * `SURVIVOR_PID_PATTERN`), in its order, joined with ", "; the empty string
 * when it names none. Never throws.
 */
export function killFailureSurvivorPidList(description: string): string {
  try {
    return survivorPids(description)
      .map((pid) => `pid ${pid}`)
      .join(', ')
  } catch {
    return ''
  }
}

/** The survivor version's body, with no closing sentence (SRJ-1007). Names no command. Never throws. */
export function killFailureSurvivorBody(input: KillFailureSurvivorBodyInput): string {
  const { forSlack } = input
  const session = renderSession(input.session, forSlack)
  const pids = killFailureSurvivorPidList(input.survivorDescription)
  const quoted = renderQuoted(input.survivorDescription, forSlack)
  return (
    `:rotating_light: *Process outlived kill* — agent-director ended the worker in session ${session}, ` +
    `but a process in that session outlived the kill: ${pids}. ` +
    `agent-director said: "${quoted}". ` +
    'A later `kill` does not check this process again. ' +
    'A human\'s next step: find and end that process by following the "Operator actions" section of agent-director\'s README. ' +
    'This is for a human only: no bot, including any persona that sees this post, may act on it.'
  )
}

// ---------------------------------------------------------------------------
// The full text and the log-only form
// ---------------------------------------------------------------------------

/** What an alert says: either version's body input. */
export type KillFailureAlertContent =
  | ({ readonly version: typeof KILL_FAILURE_VERSION_ORDINARY } & Omit<KillFailureOrdinaryBodyInput, 'forSlack'>)
  | ({ readonly version: typeof KILL_FAILURE_VERSION_SURVIVOR } & Omit<KillFailureSurvivorBodyInput, 'forSlack'>)

/**
 * The bounded retry's decision (`src/kill-retry.ts`'s `KillRetryAlert`, whose
 * kinds are the version names) as what the alert says: the survivor version
 * quoting its survivor-naming description, for `session`; or the ordinary
 * version quoting the descriptions it carries (each when present), for
 * `session` and `instanceId`. Undefined for a `none` decision. Pure.
 */
export function killFailureAlertContentOf(
  decision: KillRetryAlert,
  session: string,
  instanceId: string,
): KillFailureAlertContent | undefined {
  if (decision.kind === KILL_FAILURE_VERSION_SURVIVOR) {
    return { version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription: decision.survivorDescription }
  }
  if (decision.kind !== KILL_FAILURE_VERSION_ORDINARY) return undefined
  return {
    version: KILL_FAILURE_VERSION_ORDINARY,
    session,
    instanceId,
    quotes: {
      ...(decision.lastKillFailedDescription === undefined ? {} : { lastKillFailedDescription: decision.lastKillFailedDescription }),
      ...(decision.earlierSurvivorDescription === undefined ? {} : { earlierSurvivorDescription: decision.earlierSurvivorDescription }),
    },
  }
}

/**
 * The descriptions a decision carries, for a log line, each redacted on one
 * line (`renderLogMessageText`) and JSON-quoted: `last="…"` and
 * `earlier survivor-naming="…"` for the ordinary version, each when present,
 * joined with a space; `survivor-naming="…"` for the survivor version; or
 * `no description` (none carried, or a `none` decision). Pure.
 */
export function describeKillFailureDescriptions(decision: KillRetryAlert): string {
  const quote = (text: string): string => JSON.stringify(renderLogMessageText(text))
  if (decision.kind === KILL_FAILURE_VERSION_SURVIVOR) return `survivor-naming=${quote(decision.survivorDescription)}`
  if (decision.kind !== KILL_FAILURE_VERSION_ORDINARY) return 'no description'
  const parts = [
    ...(decision.lastKillFailedDescription === undefined ? [] : [`last=${quote(decision.lastKillFailedDescription)}`]),
    ...(decision.earlierSurvivorDescription === undefined ? [] : [`earlier survivor-naming=${quote(decision.earlierSurvivorDescription)}`]),
  ]
  return parts.length === 0 ? 'no description' : parts.join(' ')
}

/**
 * The full text of an alert: its version's body, a space, and the closing
 * sentence of `closing`. `forSlack` for a Slack post (a destination); false
 * for a log line, a startup-errors entry or the CLI's print. Never throws.
 */
export function killFailureAlertText(content: KillFailureAlertContent, closing: KillFailureClosing, forSlack: boolean): string {
  const body =
    content.version === KILL_FAILURE_VERSION_SURVIVOR
      ? killFailureSurvivorBody({ session: content.session, survivorDescription: content.survivorDescription, forSlack })
      : killFailureOrdinaryBody({
          session: content.session,
          instanceId: content.instanceId,
          ...(content.quotes === undefined ? {} : { quotes: content.quotes }),
          forSlack,
        })
  return `${body} ${killFailureClosingSentence(content.version, closing)}`
}

/**
 * The log-line and startup-errors form (SRJ-1007): the persona reference or
 * the row's id (`ref`, e.g. `persona=<key>` or `instanceId=<id>`), the
 * context, then the text: `<ref> (<context>): <text>`. `text` is the
 * unescaped full text ({@link killFailureAlertText} with `forSlack` false).
 */
export function killFailureAlertEntryText(ref: string, context: KillFailureAlertContext, text: string): string {
  return `${ref} (${context}): ${text}`
}
