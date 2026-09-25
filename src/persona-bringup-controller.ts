/**
 * persona-bringup-controller.ts — Per-persona bring-up outcomes and retries
 * (b.av2 SR-6.1 outcomes, SR-6.4, SR-7.2 part, SR-10.3 part, SR-13.1).
 *
 * `createPersonaBringUpController(deps)` runs the SR-6.1 procedure of
 * `persona-start.ts` (steps 1–2 `checkPersonaLocalSteps`, step 3
 * `connectPersonaSlack`) for each applied persona and keeps, per persona, a
 * definite outcome:
 *
 * - `up`: steps 1–3 passed (credentials check, working-directory check, Slack
 *   validation and connection). The launch (step 4) is the caller's at start
 *   (the start pass's worker pool); after a retry succeeds the controller
 *   launches the persona itself through the injected `launch`, which joins a
 *   launch already in flight for the persona (`spawnForPersona`). A launch
 *   failure is not a new outcome: it takes today's spawn-failure path.
 * - `broken` (credentials-broken): the credentials file is missing,
 *   unreadable or locally invalid, or Slack refused a token (at bring-up, on
 *   a reopen of a running persona, or in a Web API call of a running persona,
 *   bug b.ujn; its instance is left running). Not retried: it recovers only
 *   through a confirmed change to its credentials file (b.av2 SR-6.4), which
 *   the apply brings up afresh (`persona-lifecycle.ts`, step 6).
 * - `retrying`: Slack-unreachable (retried by the connection manager on its
 *   own per-persona timer, the SR-3.2 schedule), directory-broken, or held
 *   for an unresolvable claude_config_dir (below).
 *
 * Causes are kept apart (credentials, directory, Slack, claude_config_dir).
 * A persona with both
 * a credentials cause and a directory cause is `broken`; its directory is
 * still re-checked on its own timer and logs its start and cleared lines, but
 * nothing moves on to Slack or the launch while the credentials cause holds.
 *
 * Directory-broken (SR-6.4): no Slack connection is opened. The directory is
 * re-checked on the persona's own timer on the SR-3.2 schedule
 * (`createPersonaRetrySchedule`: 5 s doubling to 300 s, no cap), outside the
 * restart failure counter and cap. Once it is usable the bring-up continues
 * with no confirmation: the claude_config_dir check (below), Slack
 * validation with the held credentials, then the launch. If Slack is then
 * unreachable the persona is Slack-unreachable retrying.
 *
 * Held credentials (SR-6.1): the tokens read at the persona's first bring-up
 * (or at its last confirmed credentials change) are kept in the persona's
 * entry and handed to the manager when a directory or claude_config_dir
 * retry reaches Slack; the
 * credentials file is never read again by a retry, so an edit made meanwhile
 * is not used (it is E11's pending change). The manager itself keeps the same
 * tokens for its own retries and reopens. The tokens are never logged,
 * returned or written, and no query exposes them. Beside them the entry holds
 * the digest of the bytes that read produced, or a missing/unreadable marker
 * (b.av2 SR-8.3); the read-only `credentialsDigest(key)` query exposes only
 * that, for the reload detection tick. A persona broken by a shared
 * credentials file holds the digest of its own file too (read only to be
 * hashed, never parsed), so once the collision is gone a re-save of that
 * file makes a change pending.
 *
 * Confirmed credentials change (b.av2 SR-8.6 credentials row, SR-8.3;
 * `changeCredentials`, apply step 4): for a persona that is up or retrying,
 * the file is read once through the local check, against the applied set
 * now. A locally bad file changes nothing and logs one
 * `persona-credentials-change-failed` line, so the change stays pending. An
 * up persona is reconnected by the manager (new connection first, then the
 * old one closes). Beside the held content the entry keeps the content its
 * own connection uses (`live`): set at each Slack step (bring-up, and a
 * directory or claude_config_dir retry reaching Slack) and at every swap, a
 * late one included. Right before the swap (the manager's `beforeSwap`, before
 * any status listener sees the persona up on the new connection) the held
 * and live content become the new file's and the caller's `beforeSwap` runs
 * (the lifecycle forgets the cached DM conversation there). While the new
 * connection retries the held content is the new file's (nothing pending)
 * and the live one stays. A refusal, at once or later, holds the live
 * content again, so the change is pending again (and so is an earlier change
 * whose retrying reconnect this one replaced) — unless the persona stopped
 * being up meanwhile, which then stays credentials-broken with the confirmed
 * content held. The failed line's "kept" wording and the result are chosen
 * from the persona's state after the attempt. A retrying persona takes the
 * new tokens and digest at once (held and live), and so does the manager's
 * own Slack retry. A persona held for its claude_config_dir is retrying with
 * no connection: it takes the new tokens the same way, opens no connection,
 * and connects with them once the directory resolves. A hold that starts
 * while an up persona's reconnect is in flight or retrying closes that
 * reconnect with the connection; the persona keeps the new content and
 * connects with it on its return. A credentials-broken persona is not
 * changed here: the apply brings it up afresh.
 *
 * Launch on recovery: a persona launches from its own retry path, never
 * waiting for the health check: after a directory or claude_config_dir
 * retry whose Slack step reports `up`, or when the manager reports `up`
 * right after `retrying` a bring-up (`onConnectionStatus`, the manager's
 * status listener). An `up`
 * after `lost` or after `retrying` a reopen launches nothing: the instance is
 * already running. At most one such launch per persona. A persona whose
 * connection Slack had refused (`broken`) and that the manager reports `up`
 * again (a confirmed credentials reconnect left retrying succeeded) is
 * launched the same way, through its launch path's collision ladder.
 *
 * claude_config_dir hold (bug b.g57): a persona whose effective
 * claude_config_dir cannot be resolved to a real path (a symlink on its path
 * pointing to nothing, an unmounted drive, a dropped mount) is held: it is
 * `retrying` with a `configDir` cause and has no Slack connection, like a
 * directory-broken persona. It is checked (`checkConfigDir`) once steps 1
 * and 2 passed, right before step 3, at bring-up and when a directory retry
 * reaches Slack: an unresolvable directory opens the hold there, so the
 * persona never connects. A later launch that finds it unresolvable (the
 * session manager's pre-launch check, after a confirmed claude_config_dir
 * change or a dropped mount) launches nothing and hands the failure to
 * `holdForConfigDir`, which opens the hold and closes the persona's Slack
 * connection (the manager's `stop`); the persona leaves up (below), and its
 * instance and agent-director row are kept. While held it receives no Slack
 * message, and its notices are held by the notifier until its client is
 * validated again. The directory is re-checked on the persona's own timer on
 * the SR-3.2 schedule, outside the restart counter and cap, each attempt
 * through the serializer. The class line (`persona-config-dir-unresolvable`)
 * is logged when the hold starts and a cleared line when the directory
 * resolves. The bring-up then continues with no confirmation: Slack
 * validation and connection with the held credentials, then the launch
 * (which resumes the row through the launch path's collision ladder). If
 * Slack is then unreachable the persona is Slack-unreachable retrying and
 * launches when the manager reports it up:
 *
 *   [slack] persona-config-dir-unresolvable: personas[<i>] "<name>" (key=<key>) path="<dir>": cleared: claude_config_dir resolves to a real path again; continuing the bring-up
 *   [slack] persona "<name>" (key=<key>): up after its claude_config_dir resolved — launching
 *
 * (`…; the persona stays broken until its credentials file is fixed and the
 * change confirmed` for a persona Slack had refused when the hold started:
 * its refusal is kept as its cause, and a reconnect of an earlier change
 * still retrying then is cancelled, so that change is pending again.)
 *
 * Leaving up (SR-6.3, SR-6.4): each time a persona's outcome changes from
 * `up` to `broken` or `retrying` (a refused reopen of a running persona, a
 * Web API call refused for its bot token, or a claude_config_dir hold), the
 * injected `onLeftUp` is told once. A lost connection being
 * reopened (`lost`, `retrying` a reopen) stays `up`. Production wires
 * `createNotUpSessionDropper`, which drops the persona's registered MCP
 * session; its instance and agent-director row are kept.
 * `describePersonaNotUp` renders a state's outcome and cause for the not-up
 * refusal and drop lines.
 *
 * Logging (SR-10.3): one `persona-start` line per persona when its bring-up
 * starts, before its outcome lines:
 *
 *   [slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting
 *
 * A credentials cause is logged once, when it starts (its check's line). A
 * directory cause is logged once when it starts (its check's line, class
 * `persona-directory-missing` / `-unusable`) and once when it clears, with
 * the class that opened it:
 *
 *   [slack] persona-directory-missing: personas[<i>] "<name>" (key=<key>) path="<dir>": cleared: working directory is usable again; continuing the bring-up
 *
 * (`…; the persona stays broken until its credentials file is fixed and the change confirmed` while a
 * credentials cause holds). A change of class between attempts is the same
 * episode and logs nothing. Slack-unreachable start and clear lines come from
 * the connection manager only. A launch after a retry logs:
 *
 *   [slack] persona "<name>" (key=<key>): up after its bring-up retry (<directory|Slack>) — launching
 *
 * Lines go through the injected logger only (the `[slack]` server log), never
 * `startup-errors.log`, and nothing here posts to Slack.
 *
 * Dry run (SR-3.4): no credentials file is read and no Slack call is made
 * (the manager reports every persona up); the directory and
 * claude_config_dir checks and their retries run as in a real start.
 *
 * Applied set (b.av2 SR-8.6): the injected `appliedPersonas` getter is the
 * live applied persona set, read at each use, never a snapshot. A directory
 * or claude_config_dir re-check or a launch after a retry for a key outside
 * it does nothing (no Slack step, no launch): from a confirmed apply's step
 * 1 on, a removed persona is never brought up or launched, even before its
 * teardown cancels it. A re-check checks the directory against the current
 * set, a claude_config_dir check after bring-up checks the current
 * declaration, and a launch after a retry launches the current declaration. `isApplied(key)` answers
 * from the same getter, for the up predicate and the relaunch gate.
 *
 * Isolation (SR-3.3, SR-6.6): each persona's state, timer and in-flight flag
 * live in its own entry; nothing spans two personas, and a directory retry is
 * scheduled only once the previous one has finished, so attempts never
 * overlap. Each retry attempt, through to the launch it triggers, runs
 * through the injected per-persona lifecycle serializer (`serialize`), so it
 * never overlaps a restart's work or an apply's teardown for the persona,
 * and its checks (cancelled, applied, already launched) see the state when
 * it starts.
 *
 * Pure module (b.av2 SR-13.1): nothing is created, read or scheduled at
 * import or at `createPersonaBringUpController`. The clock, logger, checks,
 * file-system seam, connection manager, launch and leaving-up listener are
 * injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona } from './config.ts'
import { checkPersonaConfigDir, checkPersonaWorkingDirectory } from './persona-bringup.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import {
  SYSTEM_PERSONA_CONNECTION_CLOCK,
  type PersonaConnectionClock,
  type PersonaConnectionManager,
  type PersonaConnectionStatus,
} from './persona-connections.ts'
import type { CredentialsDigest, PersonaSlackTokens } from './persona-credentials.ts'
import {
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_START,
  formatCredentialsChangeFailed,
  formatPersonaDiagnostic,
  type CredentialsChangeKept,
  type PersonaCheckFailure,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { createPersonaRetrySchedule, type PersonaRetrySchedule } from './persona-retry-schedule.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import type { SlackCredentialsRefusedOutcome } from './persona-slack-validation.ts'
import {
  checkPersonaLocalSteps,
  connectPersonaSlack,
  personaSlackStatusFailure,
  type PersonaBringUpFailure,
  type PersonaConnectDeps,
} from './persona-start.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bring-up outcome (b.av2 SR-6.1). */
export type PersonaBringUpOutcome = 'up' | 'broken' | 'retrying'

/** A persona's current causes, one per kind; absent when that kind has none. */
export interface PersonaBringUpCauses {
  credentials?: PersonaBringUpFailure
  directory?: PersonaBringUpFailure
  slack?: PersonaBringUpFailure
  /**
   * Held until its claude_config_dir resolves (bug b.g57): no Slack
   * connection, no launch.
   */
  configDir?: PersonaBringUpFailure
}

/** A persona's bring-up state, as the controller reports it. Never holds a token. */
export interface PersonaBringUpState {
  /** The outcome; undefined while the first Slack attempt is in flight. */
  outcome: PersonaBringUpOutcome | undefined
  causes: PersonaBringUpCauses
}

/** What one bring-up resolves with: its outcome and every current cause, credentials first. */
export interface PersonaBringUpResultSummary {
  outcome: PersonaBringUpOutcome
  failures: PersonaBringUpFailure[]
}

/** The connection manager operations a confirmed credentials change uses (`changeCredentials`). */
export type CredentialsChangeConnections = Pick<PersonaConnectionManager, 'reconnectCredentials' | 'replaceRetryTokens'>

/** One swap of a persona's connection to the new file's (`CredentialsChangeHooks.onSwapped`). */
export interface CredentialsSwap {
  /** True when a reconnect left retrying swapped later, after the operation had resolved. */
  late: boolean
  /**
   * Whether the persona was up right before the swap. False when its current
   * connection had been refused meanwhile (a refused reopen, or a Web API
   * call refused for its bot token): it comes up again through the swap and
   * its MCP session, dropped then, registers again.
   */
  wasUp: boolean
}

/** Told when a confirmed credentials change takes effect on the persona's connection. */
export interface CredentialsChangeHooks {
  /**
   * Right before the persona switches to the new file's connection (the
   * manager's `beforeSwap`), synchronously, before any status listener sees
   * it up on the new connection (the notifier's flush of held notices). For
   * what depends on the old app, such as the cached DM conversation. A throw
   * is logged and the swap still happens.
   */
  beforeSwap?: () => void
  /**
   * The persona now uses the new file's connection: right away (`late:
   * false`, before the operation resolves `swapped`), or later, when a
   * reconnect left retrying swaps (`late: true`). A throw is logged.
   */
  onSwapped?: (swap: CredentialsSwap) => void
}

/** How a confirmed credentials change of one persona settled (its first attempt, for an up persona). */
export type PersonaCredentialsChangeResult =
  /**
   * Up persona: the new connection is in use, the old one closed; the new
   * file's content is held. `cameBackUp` when the persona was not up right
   * before the swap (its current connection was refused while the attempt
   * ran): it is up again, and its MCP session registers again.
   */
  | { kind: 'swapped'; cameBackUp?: true }
  /**
   * The new file's content is held and retried with: an up persona whose new
   * connection is retrying while its old one stays in use (`connection:
   * 'kept'`), one whose current connection was refused while the attempt ran
   * and that stays broken by its credentials until the new connection is in
   * use (`'broken'`), or a retrying persona that has no connection
   * (`'none'`: Slack-unreachable, directory-broken, or held for its
   * claude_config_dir, the last two connecting with it once their directory
   * resolves).
   */
  | { kind: 'retrying'; connection: 'kept' | 'broken' | 'none' }
  /**
   * The new file cannot be used: locally (missing, unreadable, invalid,
   * another applied persona's file) or refused by Slack. Nothing changed and
   * one `persona-credentials-change-failed` line was logged; `cause` is its
   * cause. The change stays pending.
   */
  | { kind: 'failed'; cause: string }
  /** Broken by its credentials now: not changed here; the apply brings it up afresh (step 6). */
  | { kind: 'credentials-broken' }
  /**
   * Nothing done: dry run, a persona unknown, cancelled or no longer applied,
   * one neither up nor retrying (for example broken by a failed Slack
   * bring-up), or its connection stopped or superseded meanwhile.
   */
  | { kind: 'skipped' }

/**
 * Whether a bring-up state is credentials-broken (b.av2 SR-6.4): its outcome
 * is `broken` and either its local credentials check failed (missing,
 * unreadable or locally invalid, or another applied persona's file) or Slack
 * refused a token (`persona-credentials-refused`: at bring-up, on a reopen,
 * or in a Web API call of the running persona). A persona retrying because
 * Slack is unreachable or its directory is unusable, or broken for another
 * reason, is not. Such a persona recovers only through a confirmed change to
 * its credentials file, which the apply brings up rather than reconnects
 * (SR-8.6 step 6). Pure.
 */
export function isCredentialsBroken(state: Pick<PersonaBringUpState, 'outcome' | 'causes'> | undefined): boolean {
  if (state?.outcome !== 'broken') return false
  return state.causes.credentials !== undefined || state.causes.slack?.class === PERSONA_CREDENTIALS_REFUSED
}

/** Dependencies of `createPersonaBringUpController`. */
export interface PersonaBringUpControllerDeps
  extends Pick<PersonaConnectDeps, 'dryRun' | 'log' | 'checkLocal' | 'checkDirectory' | 'fs'> {
  /**
   * The connection manager: step 3, the Slack side of each persona's outcome,
   * and `stop`, which closes the connection of a persona a claude_config_dir
   * hold starts for (`holdForConfigDir`). Production passes the manager.
   */
  connections: Pick<PersonaConnectionManager, 'bringUp' | 'status' | 'stop'>
  /**
   * Launch a persona that reached `up` through a retry: the persona launch
   * path, which joins a launch already in flight for it. Its result is not
   * inspected; a throw or rejection is logged.
   */
  launch: (persona: Persona) => Promise<unknown>
  /**
   * Told once each time a persona's outcome changes from `up` to `broken` or
   * `retrying` (b.av2 SR-6.3, SR-6.4), with the persona and its new state.
   * A persona that was never up is never reported; a lost connection being
   * reopened stays `up` and is not reported. A throw or rejection is logged.
   * Production drops the persona's registered MCP session
   * (`createNotUpSessionDropper`).
   */
  onLeftUp?: (persona: Persona, state: PersonaBringUpState) => unknown
  /** Clock and timers for the directory re-checks; default the real clock. */
  clock?: PersonaConnectionClock
  /**
   * The applied persona set now (b.av2 SR-8.6), read at each use: production
   * reads the server's `personaConfig`, which a confirmed apply's step 1
   * swaps. Without it every known persona counts as applied and a re-check
   * uses the set the persona was brought up with.
   */
  appliedPersonas?: () => readonly Persona[]
  /**
   * Check a persona's claude_config_dir (bug b.g57): right before step 3 (at
   * bring-up, and when a directory retry reaches Slack) and on each re-check
   * of a held persona (`holdForConfigDir`), with the persona's current
   * applied declaration. Production passes the session manager's pre-launch
   * check (`checkLaunchConfigDir`), so these checks and the launch resolve
   * the directory the same way; default `checkPersonaConfigDir` with the OS
   * home and the real file system.
   */
  checkConfigDir?: (persona: Persona) => { ok: true } | PersonaCheckFailure
  /**
   * The per-persona lifecycle serializer's `run` (b.av2 SR-6.6,
   * `persona-serializer.ts`). Each retry attempt runs through it, through to
   * the launch it triggers: a directory re-check (with its Slack step and
   * launch), a claude_config_dir re-check (with its Slack step and launch)
   * and the launch
   * after a Slack retry reached `up`. Its checks (the
   * persona is cancelled, no longer applied, already launched) run when the
   * attempt starts. Not the first bring-up (`bringUp`). Without it the work
   * runs at once. Production passes the server's one shared serializer.
   */
  serialize?: PersonaSerialize
}

/** The controller handle. */
export interface PersonaBringUpController {
  /**
   * Bring one persona up (steps 1–3): log its `persona-start` line, run the
   * local checks, then, when both pass, the claude_config_dir check (an
   * unresolvable one holds the persona with no connection, as
   * `holdForConfigDir` describes), then Slack. Resolves once the persona has an
   * outcome; retries continue on the persona's own timers. Launches nothing
   * (the caller launches an `up` persona). A persona already known is left as
   * it is and its current result returned.
   */
  bringUp(persona: Persona, applied: readonly Persona[]): Promise<PersonaBringUpResultSummary>
  /** The connection manager's status listener: launches a persona that reached `up` from `retrying` its bring-up. */
  onConnectionStatus(key: string, status: PersonaConnectionStatus): void
  /** Whether the persona's outcome is `up`. False for an unknown or cancelled persona. */
  isUp(key: string): boolean
  /**
   * Whether the key is in the applied persona set now (`appliedPersonas`),
   * known to the controller or not; true for every key without the getter.
   */
  isApplied(key: string): boolean
  /** The persona's outcome and causes, or undefined for an unknown or cancelled persona. */
  state(key: string): PersonaBringUpState | undefined
  /**
   * The digest or marker of the credentials bytes the persona's bring-up read
   * (b.av2 SR-8.3): what it connected with, is retrying with or broke with.
   * `sha256:<hex>`, or `CREDENTIALS_MISSING_MARKER` /
   * `CREDENTIALS_UNREADABLE_MARKER`. A persona broken by a credentials file
   * another applied persona shares holds the digest of its own file (hashed,
   * never parsed). Undefined when nothing is held: dry run (no file is read)
   * and an unknown or cancelled persona. Retries never re-read the file, so
   * it changes only at a confirmed credentials change (`changeCredentials`).
   * Read-only; never logged.
   */
  credentialsDigest(key: string): CredentialsDigest | undefined
  /**
   * Apply a confirmed change of the persona's credentials file (b.av2 SR-8.6
   * credentials row, SR-8.3), for a persona that is up or retrying, as it is
   * declared in the applied set now; see the module comment. Re-checks the
   * persona's state when it runs: a persona credentials-broken now is left
   * alone (`credentials-broken`). Reads the file once, through the local
   * check against the applied set now (the `appliedPersonas` getter; without
   * it `applied`, the set the confirmed apply made current, never the set the
   * persona was first brought up with); reconnects an up persona through
   * `connections.reconnectCredentials` and hands a Slack-retrying one's new
   * tokens to `connections.replaceRetryTokens`. A retrying persona with no
   * connection (directory-broken, or held for its claude_config_dir) takes
   * the new tokens for its later Slack step and opens no connection; so does
   * a persona whose hold started while its reconnect was in flight (the hold
   * cancelled it). Resolves once an up
   * persona's first attempt settled. Touches no other persona. Run it
   * through the persona's serializer turn (the lifecycle does). Never
   * rejects except through a throwing injected dependency.
   */
  changeCredentials(
    persona: Persona,
    applied: readonly Persona[],
    connections: CredentialsChangeConnections,
    hooks?: CredentialsChangeHooks,
  ): Promise<PersonaCredentialsChangeResult>
  /**
   * Hold back a persona whose launch found its claude_config_dir unresolvable
   * (bug b.g57; the session manager's hook, `setConfigDirUnresolvableHook`).
   * The persona becomes `retrying` with a `configDir` cause and its Slack
   * connection is closed (`connections.stop`, not awaited): `onLeftUp` fires
   * once if it was up, and nothing is delivered to it. A persona Slack had
   * refused keeps that refusal as its cause and stays broken. The failure's
   * line is logged when the episode starts, not again while it lasts. The
   * directory is re-checked on the persona's own timer (SR-3.2 schedule: 5 s
   * doubling to 300 s, no cap), each attempt through the serializer; once it
   * resolves, one cleared line, then Slack validation and connection with
   * the held credentials, then the launch. The instance and its row are left
   * as they are. Synchronous; never awaits the serializer or the close.
   * Returns false, doing nothing, for a persona the controller does not know
   * (never brought up, or cancelled): the caller then logs the line itself.
   */
  holdForConfigDir(persona: Persona, failure: PersonaCheckFailure): boolean
  /** Stop one persona's retries and forget it; a retry already running does nothing more. Idempotent. */
  cancel(key: string): void
  /** Cancel every persona. */
  cancelAll(): void
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/**
 * An open directory or claude_config_dir episode: the cause that opened it
 * (for its cleared line) and the latest one.
 */
interface DirectoryEpisode {
  readonly opened: PersonaCheckFailure
  latest: PersonaCheckFailure
}

/** Credentials content held in memory: tokens and the digest of the bytes they came from. Never logged. */
interface HeldCredentials {
  readonly tokens: PersonaSlackTokens | undefined
  readonly digest: CredentialsDigest | undefined
}

/** Everything the controller holds for one persona. Nothing here is shared with another persona. */
interface BringUpEntry {
  readonly persona: Persona
  /**
   * The applied personas at bring-up, for the directory collision rule on
   * re-checks when no `appliedPersonas` getter is injected.
   */
  readonly applied: readonly Persona[]
  /**
   * Step 1's tokens from the first read, or from the last confirmed
   * credentials change; undefined in dry run or when step 1 failed. Never
   * logged.
   */
  tokens: PersonaSlackTokens | undefined
  /** Step 1's failure. A credentials-broken persona recovers only through a fresh bring-up (a new entry). */
  readonly credentials: PersonaCheckFailure | undefined
  /**
   * The digest or marker of the bytes step 1 read (a collision included), or
   * of the last confirmed credentials change's; undefined in dry run, where
   * none are read. Never logged.
   */
  credentialsDigest: CredentialsDigest | undefined
  /**
   * The content the persona's own connection uses (the manager entry's
   * tokens): set at each Slack step (bring-up, and a directory or
   * claude_config_dir retry reaching Slack), on every swap to a confirmed change's new
   * connection (a late one included) and when a retrying persona takes a
   * change. It differs from `tokens`/`credentialsDigest` only while an up
   * persona's reconnect is retrying with newer content, and is what they go
   * back to when that reconnect ends without a swap (refused, or cancelled
   * by a later change that was refused). Never logged.
   */
  live: HeldCredentials
  directory: DirectoryEpisode | undefined
  readonly directorySchedule: PersonaRetrySchedule
  directoryTimer: TimerBox | undefined
  /**
   * Held until its claude_config_dir resolves (bug b.g57): no Slack
   * connection, no launch. Undefined when not held.
   */
  configDir: DirectoryEpisode | undefined
  /** The claude_config_dir re-check schedule, reset when an episode opens. */
  readonly configDirSchedule: PersonaRetrySchedule
  configDirTimer: TimerBox | undefined
  /**
   * Set once step 3 was handed to the manager: the Slack side is then the
   * manager's status. Cleared when a claude_config_dir hold closes the
   * connection; set again when the persona's return reaches Slack.
   */
  slackStarted: boolean
  /**
   * A Slack failure the manager no longer reports: step 3 threw (a
   * programming error), or Slack had refused the persona when a
   * claude_config_dir hold closed its connection. Broken, not retried.
   */
  slackError: PersonaBringUpFailure | undefined
  /** The last status the manager reported, for the retrying → up transition. */
  lastStatus: PersonaConnectionStatus | undefined
  /**
   * Set once a launch after a retry was started; cleared when a
   * claude_config_dir hold closes the connection, so the persona's return
   * launches it once.
   */
  retryLaunched: boolean
  /** Whether the outcome was `up` when last observed, for the up → not-up notification. */
  wasUp: boolean
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cause of the `persona-start` line. */
const PERSONA_START_CAUSE = 'bring-up starting'

/** Cause of a directory cleared line, by whether the credentials cause still holds. */
const DIRECTORY_CLEARED_CONTINUING = 'cleared: working directory is usable again; continuing the bring-up'
const DIRECTORY_CLEARED_STILL_BROKEN =
  'cleared: working directory is usable again; the persona stays broken until its credentials file is fixed and the change confirmed'

/** Cause of a claude_config_dir cleared line (bug b.g57), by whether the persona stays broken. */
const CONFIG_DIR_CLEARED_CONTINUING = 'cleared: claude_config_dir resolves to a real path again; continuing the bring-up'
const CONFIG_DIR_CLEARED_STILL_BROKEN =
  'cleared: claude_config_dir resolves to a real path again; the persona stays broken until its credentials file is fixed and the change confirmed'

/**
 * How the persona's open Slack episode (unreachable, refused or lost) ends
 * when a claude_config_dir hold closes its connection: the manager's line
 * carries its class label and `cleared: <this>`.
 */
const CONFIG_DIR_HOLD_CONNECTION_CLOSED =
  'the persona\'s Slack connection was closed while its claude_config_dir cannot be resolved'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the bring-up controller. Creates, reads and schedules nothing until `bringUp`. */
export function createPersonaBringUpController(deps: PersonaBringUpControllerDeps): PersonaBringUpController {
  const { connections } = deps
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const checkDirectory = deps.checkDirectory ?? checkPersonaWorkingDirectory
  const checkConfigDir = deps.checkConfigDir ?? ((persona: Persona) => checkPersonaConfigDir(persona))
  const entries = new Map<string, BringUpEntry>()
  const serialize: PersonaSerialize = deps.serialize ?? (async (_key, operation) => operation())

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a persona's bring-up */
    }
  }

  function ref(entry: BringUpEntry): string {
    return renderPersonaRef(entry.persona.name, entry.persona.key)
  }

  /** The persona with `key` in the applied set now; undefined when it is not applied. */
  function appliedPersona(key: string, fallback: Persona): Persona | undefined {
    if (deps.appliedPersonas === undefined) return fallback
    return deps.appliedPersonas().find((p) => p.key === key)
  }

  function isApplied(key: string): boolean {
    return deps.appliedPersonas === undefined || deps.appliedPersonas().some((p) => p.key === key)
  }

  // -------------------------------------------------------------------------
  // Outcome
  // -------------------------------------------------------------------------

  /** The Slack side of an outcome, from the manager's status. */
  function slackOutcome(status: PersonaConnectionStatus | undefined): PersonaBringUpOutcome | undefined {
    if (status === undefined) return undefined
    switch (status.state) {
      case 'up':
      case 'lost':
        return 'up'
      case 'retrying':
        return status.phase === 'reopen' ? 'up' : 'retrying'
      case 'broken':
        return 'broken'
      default:
        return undefined
    }
  }

  function outcomeOf(entry: BringUpEntry): PersonaBringUpOutcome | undefined {
    if (entry.credentials) return 'broken'
    if (entry.directory) return 'retrying'
    if (entry.slackError) return 'broken'
    // Held for its claude_config_dir (b.g57): no connection, retried on its timer.
    if (entry.configDir) return 'retrying'
    if (!entry.slackStarted) return undefined
    return slackOutcome(connections.status(entry.persona.key))
  }

  function causesOf(entry: BringUpEntry): PersonaBringUpCauses {
    const causes: PersonaBringUpCauses = {}
    if (entry.credentials) {
      causes.credentials = { step: 'credentials', class: entry.credentials.class, cause: entry.credentials.cause }
    }
    if (entry.directory) {
      const { latest } = entry.directory
      causes.directory = { step: 'working-directory', class: latest.class, cause: latest.cause }
    }
    if (entry.slackError) {
      causes.slack = entry.slackError
    } else if (entry.slackStarted) {
      // Retrying its bring-up, broken or stopped: the manager's outcome is the cause.
      const status = connections.status(entry.persona.key)
      if (status !== undefined && status.state !== 'up' && status.state !== 'connecting' && slackOutcome(status) !== 'up') {
        causes.slack = personaSlackStatusFailure(status)
      }
    }
    if (entry.configDir) {
      const { latest } = entry.configDir
      causes.configDir = { step: 'claude-config-dir', class: latest.class, cause: latest.cause }
    }
    return causes
  }

  function summary(entry: BringUpEntry): PersonaBringUpResultSummary {
    const causes = causesOf(entry)
    const failures = [causes.credentials, causes.directory, causes.slack, causes.configDir].filter(
      (f): f is PersonaBringUpFailure => f !== undefined,
    )
    // A persona the manager stopped during its bring-up is not up and is not retried.
    return { outcome: outcomeOf(entry) ?? 'broken', failures }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Step 3 with the held tokens, which become what the persona's own
   * connection uses. The manager logs every Slack outcome itself.
   */
  async function connectSlack(entry: BringUpEntry): Promise<void> {
    entry.slackStarted = true
    entry.live = { tokens: entry.tokens, digest: entry.credentialsDigest }
    const result = await connectPersonaSlack(entry.persona, entry.tokens, { connections, log })
    if ('failure' in result) entry.slackError = result.failure
    observeOutcome(entry)
  }

  // -------------------------------------------------------------------------
  // Leaving up (b.av2 SR-6.3, SR-6.4)
  // -------------------------------------------------------------------------

  /**
   * Record whether the persona is up now; on a change from `up` to `broken`
   * or `retrying`, tell `onLeftUp` once. Any other change out of `up` (the
   * manager stopped the persona) only re-arms the record.
   */
  function observeOutcome(entry: BringUpEntry): void {
    if (entry.cancelled) return
    const outcome = outcomeOf(entry)
    if (outcome === 'up') {
      entry.wasUp = true
      return
    }
    if (!entry.wasUp) return
    entry.wasUp = false
    if (outcome === 'broken' || outcome === 'retrying') notifyLeftUp(entry, outcome)
  }

  function notifyLeftUp(entry: BringUpEntry, outcome: PersonaBringUpOutcome): void {
    const listener = deps.onLeftUp
    if (listener === undefined) return
    const failed = (err: unknown) =>
      log(`[slack] persona ${ref(entry)}: handling its change from up to ${outcome} failed: ${describeThrownValue(err)}`)
    try {
      Promise.resolve(listener(entry.persona, { outcome, causes: causesOf(entry) })).catch(failed)
    } catch (err) {
      failed(err)
    }
  }

  /**
   * Launch after a retry, at most once per persona, with its current applied
   * declaration; nothing for a persona no longer applied, and nothing for one
   * not up when it runs (a queued launch that a claude_config_dir hold
   * overtook: the hold closed its connection). Resolves once the
   * launch settled; a throw is logged, never posted. Runs inside the
   * persona's serialized retry attempt: the caller already holds the
   * persona's turn, so this never submits to the serializer itself (see the
   * re-entrancy rule in `persona-serializer.ts`).
   */
  async function launchAfterRetry(entry: BringUpEntry, via: 'directory' | 'Slack' | 'claude_config_dir'): Promise<void> {
    if (entry.cancelled || entry.retryLaunched || outcomeOf(entry) !== 'up') return
    const after = via === 'claude_config_dir' ? 'its claude_config_dir resolved' : `its bring-up retry (${via})`
    const failedAfter = via === 'claude_config_dir' ? after : 'its bring-up retry'
    await launchUp(entry, after, failedAfter, () => {
      entry.retryLaunched = true
    })
  }

  /**
   * Launch after a pending credentials reconnect brought back a persona whose
   * connection Slack had refused (b.av2 SR-6.4): its instance was kept, so
   * the launch path's collision ladder reaches it. Runs inside the persona's
   * serialized turn, like `launchAfterRetry`.
   */
  async function launchAfterCredentialsChange(entry: BringUpEntry): Promise<void> {
    if (entry.cancelled || outcomeOf(entry) !== 'up') return
    await launchUp(entry, 'its confirmed credentials change', 'its confirmed credentials change')
  }

  /**
   * Launch the persona's current applied declaration, logging the up line
   * (`up after <after> — launching`); nothing but a line for a persona no
   * longer applied. `onLaunching` runs right before the launch. A throw is
   * logged (`launch after <failedAfter> failed: …`), never posted.
   */
  async function launchUp(entry: BringUpEntry, after: string, failedAfter: string, onLaunching?: () => void): Promise<void> {
    const persona = appliedPersona(entry.persona.key, entry.persona)
    if (persona === undefined) {
      log(`[slack] persona ${ref(entry)}: up after ${after} but no longer applied — not launching`)
      return
    }
    onLaunching?.()
    log(`[slack] persona ${ref(entry)}: up after ${after} — launching`)
    try {
      await deps.launch(persona)
    } catch (err) {
      log(`[slack] persona ${ref(entry)}: launch after ${failedAfter} failed: ${describeThrownValue(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Directory retry (SR-6.4)
  // -------------------------------------------------------------------------

  function scheduleDirectoryRecheck(entry: BringUpEntry): void {
    if (entry.cancelled) return
    clearDirectoryTimer(entry)
    const timer: TimerBox = { handle: undefined }
    entry.directoryTimer = timer
    timer.handle = clock.setTimeout(() => {
      if (entry.directoryTimer !== timer) return
      entry.directoryTimer = undefined
      serialize(entry.persona.key, () => recheckDirectory(entry)).catch((err) =>
        log(`[slack] persona ${ref(entry)}: working-directory retry failed: ${describeThrownValue(err)}`),
      )
    }, entry.directorySchedule.nextDelayMs())
  }

  function clearDirectoryTimer(entry: BringUpEntry): void {
    const timer = entry.directoryTimer
    if (timer === undefined) return
    entry.directoryTimer = undefined
    clock.clearTimeout(timer.handle)
  }

  /**
   * One re-check: still broken → the next one on the schedule; usable →
   * cleared line, then the claude_config_dir check (an unresolvable one holds
   * the persona), Slack and the launch. The directory is checked against the
   * applied set now; a persona no longer applied is not re-checked and its
   * re-checks end.
   */
  async function recheckDirectory(entry: BringUpEntry): Promise<void> {
    const episode = entry.directory
    if (entry.cancelled || episode === undefined) return
    if (!isApplied(entry.persona.key)) {
      log(`[slack] persona ${ref(entry)}: no longer applied — its working-directory retry stops`)
      return
    }
    const others = deps.appliedPersonas?.() ?? entry.applied
    const result = checkDirectory(entry.persona, { others, fs: deps.fs })
    if (!result.ok) {
      episode.latest = result
      scheduleDirectoryRecheck(entry)
      return
    }

    entry.directory = undefined
    const { opened } = episode
    log(formatPersonaDiagnostic({
      class: opened.class,
      name: entry.persona.name,
      key: entry.persona.key,
      index: entry.persona.index,
      path: opened.path,
      cause: entry.credentials ? DIRECTORY_CLEARED_STILL_BROKEN : DIRECTORY_CLEARED_CONTINUING,
    }))
    if (entry.credentials) return
    if (holdBeforeSlack(entry)) return

    await connectSlack(entry)
    if (entry.cancelled) return
    // The same mapping as the outcome: `lost` or `retrying` a reopen right
    // after the manager reported up still counts as up. The launch is part
    // of this attempt: awaited here, inside the persona's serialized turn.
    if (outcomeOf(entry) === 'up') await launchAfterRetry(entry, 'directory')
  }

  // -------------------------------------------------------------------------
  // claude_config_dir hold (bug b.g57)
  // -------------------------------------------------------------------------

  /**
   * The claude_config_dir check right before step 3 (at bring-up, and when a
   * directory retry reaches Slack), with the persona's current applied
   * declaration: an unresolvable directory opens the hold, so nothing
   * connects. Returns whether the persona is held.
   */
  function holdBeforeSlack(entry: BringUpEntry): boolean {
    const result = checkConfigDir(appliedPersona(entry.persona.key, entry.persona) ?? entry.persona)
    if (result.ok) return false
    openConfigDirHold(entry, result)
    return true
  }

  /** Open a claude_config_dir episode: its line once, and its re-checks from the start of the schedule. */
  function openConfigDirHold(entry: BringUpEntry, failure: PersonaCheckFailure): void {
    entry.configDir = { opened: failure, latest: failure }
    entry.configDirSchedule.reset()
    log(failure.line)
    scheduleConfigDirRecheck(entry)
  }

  function holdForConfigDir(persona: Persona, failure: PersonaCheckFailure): boolean {
    const entry = entries.get(persona.key)
    if (entry === undefined || entry.cancelled) return false
    if (entry.configDir !== undefined) {
      // The same episode: a launch path found it still unresolvable.
      entry.configDir.latest = failure
      if (entry.configDirTimer === undefined) scheduleConfigDirRecheck(entry)
      return true
    }
    openConfigDirHold(entry, failure)
    closeConnectionForHold(entry)
    // Told once, whether the close's `stopped` status already told it.
    observeOutcome(entry)
    return true
  }

  /**
   * Close the connection of a persona a claude_config_dir hold starts for,
   * as for a directory-broken persona: no socket, no Web API client, so its
   * notices are held until it is validated again. Slack's refusal of it, if
   * any, is kept as its cause (the manager forgets it at the stop), and the
   * content its own connection used is held again: a reconnect of an earlier
   * change still retrying ends here, so that change is pending again. Any
   * other persona keeps its held content (a reconnect's newer content
   * included), which its return connects with. The persona's open Slack
   * episode (a lost connection still reopening, say) ends with its cleared
   * line, since its return starts a fresh connection. The close is not
   * awaited; a failure is logged.
   */
  function closeConnectionForHold(entry: BringUpEntry): void {
    if (!entry.slackStarted) return
    const { key } = entry.persona
    const status = connections.status(key)
    if (entry.slackError === undefined && status?.state === 'broken') {
      entry.slackError = personaSlackStatusFailure(status)
      hold(entry, entry.live)
    }
    // From here the Slack side is the controller's again, before the stop's
    // `stopped` status reaches `onConnectionStatus`.
    entry.slackStarted = false
    entry.retryLaunched = false
    const failed = (err: unknown) =>
      log(`[slack] persona ${ref(entry)}: closing its Slack connection for its claude_config_dir failed: ${describeThrownValue(err)}`)
    try {
      connections.stop(key, CONFIG_DIR_HOLD_CONNECTION_CLOSED).catch(failed)
    } catch (err) {
      failed(err)
    }
    entry.lastStatus = undefined
  }

  function scheduleConfigDirRecheck(entry: BringUpEntry): void {
    if (entry.cancelled) return
    clearConfigDirTimer(entry)
    const timer: TimerBox = { handle: undefined }
    entry.configDirTimer = timer
    timer.handle = clock.setTimeout(() => {
      if (entry.configDirTimer !== timer) return
      entry.configDirTimer = undefined
      serialize(entry.persona.key, () => recheckConfigDir(entry)).catch((err) =>
        log(`[slack] persona ${ref(entry)}: claude_config_dir retry failed: ${describeThrownValue(err)}`),
      )
    }, entry.configDirSchedule.nextDelayMs())
  }

  function clearConfigDirTimer(entry: BringUpEntry): void {
    const timer = entry.configDirTimer
    if (timer === undefined) return
    entry.configDirTimer = undefined
    clock.clearTimeout(timer.handle)
  }

  /**
   * One claude_config_dir re-check, with the persona's current applied
   * declaration: still unresolvable → the next one on the schedule; resolved
   * → cleared line, then Slack validation and connection with the held
   * credentials and the launch, as a directory retry does. A persona that
   * stays broken (Slack had refused it, or its credentials check failed)
   * goes no further; a directory-broken one waits for its directory retry. A
   * persona no longer applied is not re-checked and its re-checks end.
   */
  async function recheckConfigDir(entry: BringUpEntry): Promise<void> {
    const episode = entry.configDir
    if (entry.cancelled || episode === undefined) return
    const persona = appliedPersona(entry.persona.key, entry.persona)
    if (persona === undefined) {
      log(`[slack] persona ${ref(entry)}: no longer applied — its claude_config_dir retry stops`)
      return
    }
    const result = checkConfigDir(persona)
    if (!result.ok) {
      episode.latest = result
      scheduleConfigDirRecheck(entry)
      return
    }

    entry.configDir = undefined
    const stillBroken = entry.credentials !== undefined || entry.slackError !== undefined
    const { opened } = episode
    log(formatPersonaDiagnostic({
      class: opened.class,
      name: entry.persona.name,
      key: entry.persona.key,
      index: entry.persona.index,
      path: opened.path,
      cause: stillBroken ? CONFIG_DIR_CLEARED_STILL_BROKEN : CONFIG_DIR_CLEARED_CONTINUING,
    }))
    if (stillBroken || entry.directory) return

    await connectSlack(entry)
    if (entry.cancelled) return
    // As after a directory retry: the launch is part of this attempt, inside
    // the persona's serialized turn. Slack-unreachable: the manager's `up`
    // launches it (`onConnectionStatus`).
    if (outcomeOf(entry) === 'up') await launchAfterRetry(entry, 'claude_config_dir')
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function bringUp(persona: Persona, applied: readonly Persona[]): Promise<PersonaBringUpResultSummary> {
    const existing = entries.get(persona.key)
    if (existing !== undefined) return summary(existing)

    log(formatPersonaDiagnostic({
      class: PERSONA_START,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      cause: PERSONA_START_CAUSE,
    }))

    // Steps 1 and 2 without a logger: each cause's line is logged once, here.
    const local = checkPersonaLocalSteps(persona, {
      applied,
      dryRun: deps.dryRun,
      checkLocal: deps.checkLocal,
      checkDirectory: deps.checkDirectory,
      fs: deps.fs,
    })
    const entry: BringUpEntry = {
      persona,
      applied,
      tokens: local.tokens,
      credentials: local.credentials,
      credentialsDigest: local.credentialsDigest,
      live: { tokens: local.tokens, digest: local.credentialsDigest },
      directory: local.directory ? { opened: local.directory, latest: local.directory } : undefined,
      directorySchedule: createPersonaRetrySchedule(),
      directoryTimer: undefined,
      configDir: undefined,
      configDirSchedule: createPersonaRetrySchedule(),
      configDirTimer: undefined,
      slackStarted: false,
      slackError: undefined,
      lastStatus: undefined,
      retryLaunched: false,
      wasUp: false,
      cancelled: false,
    }
    entries.set(persona.key, entry)

    if (local.credentials) log(local.credentials.line)
    if (local.directory) {
      log(local.directory.line)
      scheduleDirectoryRecheck(entry)
    }
    if (local.credentials || local.directory) return summary(entry)
    if (holdBeforeSlack(entry)) return summary(entry)

    await connectSlack(entry)
    return summary(entry)
  }

  function onConnectionStatus(key: string, status: PersonaConnectionStatus): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    const previous = entry.lastStatus
    entry.lastStatus = status
    if (status.state === 'up' && previous?.state === 'retrying' && previous.phase === 'bring-up' && !entry.retryLaunched) {
      // The launch waits its turn behind any lifecycle operation for the
      // persona; whether it is still wanted is decided when it starts.
      serialize(key, () => launchAfterRetry(entry, 'Slack')).catch((err) =>
        log(`[slack] persona ${ref(entry)}: launch after its bring-up retry failed: ${describeThrownValue(err)}`),
      )
    } else if (status.state === 'up' && previous?.state === 'broken') {
      // Only a pending credentials reconnect's swap takes a refused
      // connection back to up: the persona comes up again, and its kept
      // instance is launched (reached through the collision ladder).
      serialize(key, () => launchAfterCredentialsChange(entry)).catch((err) =>
        log(`[slack] persona ${ref(entry)}: launch after its confirmed credentials change failed: ${describeThrownValue(err)}`),
      )
    }
    observeOutcome(entry)
  }

  // -------------------------------------------------------------------------
  // Confirmed credentials change (b.av2 SR-8.6 credentials row, SR-8.3)
  // -------------------------------------------------------------------------

  function logChangeFailed(persona: Persona, cause: string, kept: CredentialsChangeKept): void {
    log(formatCredentialsChangeFailed({
      name: persona.name,
      key: persona.key,
      index: persona.index,
      path: persona.credentials_file,
      cause,
      kept,
    }))
  }

  function runHook(entry: BringUpEntry, hook: () => void): void {
    try {
      hook()
    } catch (err) {
      log(`[slack] persona ${ref(entry)}: handling its confirmed credentials change failed: ${describeThrownValue(err)}`)
    }
  }

  /** Hold `content` as what the persona is connected with or retrying with (the pending-change digest). */
  function hold(entry: BringUpEntry, content: HeldCredentials): void {
    entry.tokens = content.tokens
    entry.credentialsDigest = content.digest
  }

  /** What an up persona keeps when its change failed, by its state now (after the attempt). */
  function keptNow(entry: BringUpEntry): CredentialsChangeKept {
    return isCredentialsBroken({ outcome: outcomeOf(entry), causes: causesOf(entry) }) ? 'broken' : 'connection'
  }

  async function changeCredentials(
    persona: Persona,
    applied: readonly Persona[],
    connections: CredentialsChangeConnections,
    hooks: CredentialsChangeHooks = {},
  ): Promise<PersonaCredentialsChangeResult> {
    const entry = entries.get(persona.key)
    if (deps.dryRun || entry === undefined) return { kind: 'skipped' }
    // The declaration step 1 made current, and the persona set it is checked against.
    const current = appliedPersona(persona.key, persona)
    if (current === undefined) return { kind: 'skipped' }
    // Decided now, not at the preview: a Web API call may have broken it since.
    if (isCredentialsBroken({ outcome: outcomeOf(entry), causes: causesOf(entry) })) return { kind: 'credentials-broken' }
    // A persona held for its claude_config_dir (b.g57) has no connection: it
    // is retrying, and takes the new content for its return.
    const outcome = outcomeOf(entry)
    const up = outcome === 'up'
    // An undefined outcome with Slack started: its first attempt is in flight.
    const retrying = outcome === 'retrying' || (outcome === undefined && entry.slackStarted)
    if (!up && !retrying) return { kind: 'skipped' }

    const local = checkPersonaLocalSteps(current, {
      // SR-1.4 at apply: another applied persona's file, after step 1's swap.
      applied: deps.appliedPersonas?.() ?? applied,
      dryRun: false,
      checkLocal: deps.checkLocal,
      checkDirectory: deps.checkDirectory,
      fs: deps.fs,
    })
    if (local.credentials !== undefined || local.tokens === undefined) {
      const cause = local.credentials?.cause ?? 'the credentials file could not be checked'
      logChangeFailed(current, cause, up ? 'connection' : 'content')
      return { kind: 'failed', cause }
    }
    const next: HeldCredentials = { tokens: local.tokens, digest: local.credentialsDigest }

    if (retrying) {
      // A Slack retry runs on the manager's timer with the manager's tokens.
      if (entry.slackStarted && !connections.replaceRetryTokens(current.key, local.tokens)) return { kind: 'skipped' }
      return takeWithoutConnection(entry, next)
    }

    // Whether the persona was up right before the swap, taken in the swap hook.
    let wasUp = true
    const result = await connections.reconnectCredentials(
      current.key,
      local.tokens,
      (later) => {
        if (entry.cancelled) return
        if (later.kind === 'swapped') {
          hold(entry, next)
          entry.live = next
          const swap: CredentialsSwap = { late: true, wasUp }
          runHook(entry, () => hooks.onSwapped?.(swap))
          return
        }
        onLateRefusal(entry, later.outcome)
      },
      () => {
        // Right before the swap (first attempt or later), while the persona
        // still reports its old connection: from here on its own connection
        // uses the new content, so that is both held and live.
        if (entry.cancelled) return
        wasUp = outcomeOf(entry) === 'up'
        hold(entry, next)
        entry.live = next
        if (hooks.beforeSwap !== undefined) runHook(entry, hooks.beforeSwap)
      },
    )
    if (entry.cancelled) return { kind: 'skipped' }
    switch (result.kind) {
      case 'swapped':
        // What it connected with (the swap hook already held it; again here
        // for a manager that did not call the hook).
        hold(entry, next)
        entry.live = next
        runHook(entry, () => hooks.onSwapped?.({ late: false, wasUp }))
        return wasUp ? { kind: 'swapped' } : { kind: 'swapped', cameBackUp: true }
      case 'retrying':
        // What it is retrying with: nothing is pending. Its own connection
        // still uses the live content. Worded by its state now: a refusal of
        // its current connection may have landed during the attempt.
        hold(entry, next)
        return { kind: 'retrying', connection: keptNow(entry) === 'broken' ? 'broken' : 'kept' }
      case 'refused':
        // This reconnect cancelled any earlier one still retrying, so nothing
        // retries newer content now: hold what the persona's own connection
        // uses, and the change (and any earlier one it replaced) is pending.
        hold(entry, entry.live)
        logChangeFailed(current, result.outcome.cause, keptNow(entry))
        return { kind: 'failed', cause: result.outcome.cause }
      case 'cancelled':
        // A claude_config_dir hold that started during the attempt closed
        // the connection, and the reconnect with it: the persona now has no
        // connection, so it takes the new content for its return. Unless
        // Slack had refused it meanwhile: it stays broken, and the change
        // stays pending for the recovery bring-up.
        if (entry.configDir !== undefined && !entry.slackStarted && entry.slackError === undefined) {
          return takeWithoutConnection(entry, next)
        }
        return { kind: 'skipped' }
    }
  }

  /**
   * A persona with no connection (retrying its bring-up, directory-broken,
   * or held for its claude_config_dir) takes a confirmed change's content:
   * every later Slack step uses it, and nothing is pending.
   */
  function takeWithoutConnection(entry: BringUpEntry, next: HeldCredentials): PersonaCredentialsChangeResult {
    hold(entry, next)
    entry.live = next
    return { kind: 'retrying', connection: 'none' }
  }

  /**
   * A reconnect left retrying was refused later. Still up on its own
   * connection: log the failed change and hold the content that connection
   * uses (`live`, which a later swap may have changed since the change was
   * confirmed), so the change is pending again. No longer up (its own
   * connection was refused meanwhile): it stays credentials-broken with the
   * confirmed content held, so nothing is pending, and the refusal is logged
   * as its cause.
   */
  function onLateRefusal(entry: BringUpEntry, refusal: SlackCredentialsRefusedOutcome): void {
    const persona = appliedPersona(entry.persona.key, entry.persona) ?? entry.persona
    // Still up on its own connection.
    if (outcomeOf(entry) === 'up') {
      hold(entry, entry.live)
      logChangeFailed(persona, refusal.cause, 'connection')
      return
    }
    log(formatPersonaDiagnostic({
      class: PERSONA_CREDENTIALS_REFUSED,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      path: persona.credentials_file,
      cause: refusal.cause,
    }))
  }

  function cancel(key: string): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    entry.cancelled = true
    clearDirectoryTimer(entry)
    clearConfigDirTimer(entry)
  }

  return {
    bringUp,
    onConnectionStatus,
    isUp: (key) => {
      const entry = entries.get(key)
      return entry !== undefined && outcomeOf(entry) === 'up'
    },
    isApplied,
    state: (key) => {
      const entry = entries.get(key)
      return entry === undefined ? undefined : { outcome: outcomeOf(entry), causes: causesOf(entry) }
    },
    credentialsDigest: (key) => entries.get(key)?.credentialsDigest,
    changeCredentials,
    holdForConfigDir,
    cancel,
    cancelAll: () => {
      for (const key of [...entries.keys()]) cancel(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Not-up descriptions and the session drop (b.av2 SR-6.3, SR-6.4)
// ---------------------------------------------------------------------------

/**
 * Why a persona is not up, for a log line: its outcome and its first cause
 * (credentials, then directory, then Slack), e.g. `broken: <cause>`. Uses the
 * token-free cause text only, never a diagnostic class label. Pure.
 */
export function describePersonaNotUp(state: PersonaBringUpState | undefined): string {
  if (state === undefined) return 'its bring-up has not run'
  if (state.outcome === undefined || state.outcome === 'up') return 'its Slack connection is not serving'
  const cause = state.causes.credentials ?? state.causes.directory ?? state.causes.slack ?? state.causes.configDir
  return cause === undefined ? state.outcome : `${state.outcome}: ${cause.cause}`
}

/** Dependencies of `createNotUpSessionDropper`. */
export interface NotUpSessionDropperDeps {
  /**
   * Drop the MCP session registered for a persona key (`dropPersonaSession`
   * in `registry.ts`); resolves whether one was registered.
   */
  drop: (key: string) => Promise<boolean>
  log: PersonaDiagnosticLogger
}

/**
 * Build the controller's `onLeftUp` listener: drop the MCP session registered
 * for the persona that stopped being up (b.av2 SR-6.3: a session is
 * registered only while its persona is up) and log one line when a session
 * was dropped:
 *
 *   [slack] persona "<name>" (key=<key>): MCP session dropped — the persona is not up (<outcome>: <cause>); its instance and agent-director row are kept
 *
 * Makes no agent-director call, schedules no restart and posts nothing to
 * Slack; the instance registers again once the persona is up.
 */
export function createNotUpSessionDropper(
  deps: NotUpSessionDropperDeps,
): (persona: Pick<Persona, 'name' | 'key'>, state: PersonaBringUpState) => Promise<void> {
  return async (persona, state) => {
    if (!(await deps.drop(persona.key))) return
    deps.log(
      `[slack] persona ${renderPersonaRef(persona.name, persona.key)}: MCP session dropped — ` +
        `the persona is not up (${describePersonaNotUp(state)}); its instance and agent-director row are kept`,
    )
  }
}
