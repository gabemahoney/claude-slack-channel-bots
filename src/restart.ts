/**
 * restart.ts — Auto-restart logic for managed Claude Code sessions.
 *
 * Schedules a delayed relaunch when an MCP session disconnects. Restart
 * guards, backoff and the failure cap are keyed by persona key (b.av2 SR-6.3):
 * every dependency, the pending-timer map and the in-flight launch set take
 * the key, and log lines name it as `persona=<key>`.
 * A persona that is not up (broken, or retrying its bring-up; b.av2 SR-6.4)
 * is never restarted: `RestartDeps.canRestart` is asked before a timer is
 * armed, again when it fires (before the liveness probe) and once more after
 * the probe (before any reconnect or kill; and after the re-probe that follows
 * an 'escalate-dead' reconnect, b.d61), so its instance and row are left
 * alone and its failure count is unchanged. `launchSession`'s own gate is the
 * backstop for a flip during the kill.
 * A fired timer's work runs through the per-persona lifecycle serializer
 * (b.av2 SR-6.6, `RestartDeps.serialize`), so it never overlaps a teardown or
 * a bring-up retry's launch for the same persona, and its checks see the
 * state when the work starts. The restart timer's work does not ask the
 * restart cap: a timer fired for a persona already at the cap re-attempts the
 * launch (a success resets the cap; a further failure is counted).
 * The work runs as a recovery attempt for the persona (b.jg5 SRJ-301,
 * `runInAttempt`), adapters included: an UNAVAILABLE or ENVIRONMENT outcome
 * from any of its agent-director calls (the liveness read, the reconnect with
 * its reads, the kill, the relaunch), or a `status`, `get` or `list` error,
 * arms the persona's UNAVAILABLE retry timer through the installed trigger
 * sink. A relaunch the timer now owns answers `'refused'`, which is never
 * counted toward the cap (SRJ-302): a persona is never given up on for
 * UNAVAILABLE or ENVIRONMENT alone.
 * The liveness probe answers one of four readings (b.jg5 SRJ-314,
 * `src/liveness-reading.ts`), and only `dead` leads to the kill and the
 * launch. `live` takes the reconnect path. `pending` (the row's session has
 * not started) is handed to the `pending` deferral
 * (`RestartDeps.deferPendingRow`) with the row's launch start, whatever the
 * session's connection shows, and the work returns with no reconnect, kill,
 * launch or accounting. `unknown` (a `status` error the adapter could not
 * read as dead, or a probe that throws) makes the work return with no
 * reconnect, kill, launch or accounting, and call the arm hook
 * (`RestartDeps.armRetryTimer`); so does an `unknown` re-probe after an
 * 'escalate-dead' reconnect (b.d61).
 * The work answers an outcome (`RestartWorkOutcome`, one of the
 * `RESTART_OUTCOME_*` labels); the restart timer ignores it. The retry entry,
 * `runRestartRetry`, is how the UNAVAILABLE retry timer's retries rerun the
 * same decision (SRJ-303): through the same serializer, as the same recovery
 * attempt, with none of `scheduleRestart`'s gates (the restart delay, delay 0
 * included, the pending timer) and no restart timer touched. Its first step,
 * inside its own serialized work, is the caller's in-flight check: while a
 * launch is in flight for the persona it answers `RESTART_OUTCOME_IN_FLIGHT`
 * with no agent-director call. Its second is the restart cap: a retry queued
 * behind other restart work for the persona, whose counted failure reached
 * the cap while the retry waited, answers `RESTART_OUTCOME_CAPPED` with no
 * agent-director call, nothing counted and no notice.
 * Isolated from server.ts side effects — injectable deps make it testable.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  isAtCap,
  recordFailure,
  recordSuccess,
  nextBackoffDelay,
  shouldNotifyCap,
} from './backoff.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { runInAttempt } from './unavailable-retry.ts'
import {
  LIVENESS_DEAD,
  LIVENESS_PENDING,
  LIVENESS_UNKNOWN,
  launchStartOfReading,
  livenessKindOf,
  pendingLivenessReading,
  type LivenessKind,
  type LivenessReading,
  type PendingLivenessReading,
} from './liveness-reading.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consecutive-failure cap before onCapReached fires and restarts stop. */
export const RESTART_FAILURE_CAP = 5

/**
 * Delay ceiling (seconds) for a human-triggered restart. An explicit inbound
 * message is a far stronger signal than a periodic health tick, so we clamp the
 * computed backoff delay down to this small constant instead of making a human
 * wait out the full exponential backoff (up to 900s). We clamp DOWN only —
 * never up — so a base delay smaller than this is left untouched.
 *
 * Crucially this only shortens the wait; it does NOT reset the failure counter
 * and does NOT bypass the re-entrancy guard. Combined with
 * isRestartPendingOrActive at the call site, a chatty persona gets at most one
 * in-flight launch attempt at a time and each failed attempt still counts
 * toward normal backoff/cap accounting (b.kvq).
 */
export const HUMAN_TRIGGER_DELAY_CEILING = 5

// ---------------------------------------------------------------------------
// Outcomes of the restart work and of the retry entry
// ---------------------------------------------------------------------------

/** The server is shutting down: nothing was probed, reconnected, killed or launched. */
export const RESTART_OUTCOME_SHUTTING_DOWN = 'shutting-down'
/** The persona is not up (or not applied): its instance and row were left as they are. */
export const RESTART_OUTCOME_NOT_UP = 'not-up'
/** The row reads live and the session is connected with its stream: nothing to do. */
export const RESTART_OUTCOME_ALREADY_CONNECTED = 'already-connected'
/** The row read live and the reconnect succeeded (a success was recorded). */
export const RESTART_OUTCOME_RECONNECTED = 'reconnected'
/**
 * The row reads live and the reconnect did not succeed or was deferred
 * (`transient`, no answer, or `escalate-dead` with the row still reading
 * live): no launch, nothing counted.
 */
export const RESTART_OUTCOME_RECONNECT_DEFERRED = 'reconnect-deferred'
/**
 * The row reads `pending` (its session has not started): the liveness probe
 * read it `pending` and the work handed it to the `pending` deferral
 * (`RestartDeps.deferPendingRow`), whatever the session's connection showed
 * (b.jg5 SRJ-314); or the probe read it `live` and the reconnect adapter's
 * own read found it `pending`, so the reconnect typed nothing and was
 * deferred (`pending`); or b.d61's re-probe after an 'escalate-dead'
 * reconnect read it `pending`. No reconnect, kill or launch, nothing counted.
 * Never "nothing left to recover" (SRJ-305).
 */
export const RESTART_OUTCOME_PENDING_DEFERRED = 'pending-deferred'
/** The kill and the launch ran and the launch succeeded (a success was recorded). */
export const RESTART_OUTCOME_LAUNCHED = 'launched'
/**
 * The launch was refused (its UNAVAILABLE retry timer was armed for it), or
 * the kill before it was refused (`KILL_SESSION_REFUSED`), so nothing was
 * launched. Not counted.
 */
export const RESTART_OUTCOME_REFUSED = 'refused'
/** The launch failed and the failure was counted, below the cap. */
export const RESTART_OUTCOME_COUNTED_FAILURE = 'counted-failure'
/**
 * The persona is at the restart cap: the launch failed and its counted
 * failure reached or passed the cap; or (retry entry only) the persona was
 * already at the cap when the retry's serialized work started, so no
 * agent-director call was made and nothing was counted or notified.
 */
export const RESTART_OUTCOME_CAPPED = 'capped'
/** The launch was declined by its own gate (the persona stopped being up, or the server is stopping). Not counted. */
export const RESTART_OUTCOME_LAUNCH_SKIPPED = 'launch-skipped'
/**
 * The liveness probe (or b.d61's re-probe) read `unknown`, or threw
 * (b.jg5 SRJ-314): agent-director could not report on the persona. No
 * reconnect, kill or launch, nothing counted; the arm hook
 * (`RestartDeps.armRetryTimer`) was called for the persona.
 */
export const RESTART_OUTCOME_LIVENESS_UNKNOWN = 'liveness-unknown'
/** Retry entry only: a launch was in flight for the persona, so no agent-director call was made. */
export const RESTART_OUTCOME_IN_FLIGHT = 'in-flight'
/** Retry entry only: `initRestart` has not run, so nothing was done. */
export const RESTART_OUTCOME_NOT_INITIALISED = 'not-initialised'

/** What one run of the restart work answers. The restart timer ignores it. */
export type RestartWorkOutcome =
  | typeof RESTART_OUTCOME_SHUTTING_DOWN
  | typeof RESTART_OUTCOME_NOT_UP
  | typeof RESTART_OUTCOME_ALREADY_CONNECTED
  | typeof RESTART_OUTCOME_RECONNECTED
  | typeof RESTART_OUTCOME_RECONNECT_DEFERRED
  | typeof RESTART_OUTCOME_PENDING_DEFERRED
  | typeof RESTART_OUTCOME_LAUNCHED
  | typeof RESTART_OUTCOME_REFUSED
  | typeof RESTART_OUTCOME_COUNTED_FAILURE
  | typeof RESTART_OUTCOME_CAPPED
  | typeof RESTART_OUTCOME_LAUNCH_SKIPPED
  | typeof RESTART_OUTCOME_LIVENESS_UNKNOWN

/** What the retry entry (`runRestartRetry`) answers: the work's outcome, or why it did not run. */
export type RestartRetryOutcome =
  | RestartWorkOutcome
  | typeof RESTART_OUTCOME_IN_FLIGHT
  | typeof RESTART_OUTCOME_NOT_INITIALISED

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Restart dependencies. Every `key` is a persona key. */
export interface RestartDeps {
  /**
   * Whether the persona may be restarted at all: false while it is not up (its
   * bring-up is broken or retrying, or its Slack connection is not serving;
   * b.av2 SR-6.4). Asked when a restart is scheduled, when its timer fires
   * (before `isSessionAlive`) and again after that probe (before
   * `reconnectSession` or `killSession`), and after the second
   * `isSessionAlive` probe that follows an 'escalate-dead' reconnect (b.d61):
   * a not-up persona's instance is
   * never killed, reconnected, deleted or launched, and its failure count is
   * left as it is. The server passes the relaunch gate
   * (`createPersonaRelaunchGate`).
   */
  canRestart(key: string): boolean
  /**
   * The persona's liveness reading (b.jg5 SRJ-314, `src/liveness-reading.ts`):
   * `live`, `pending` (with the row's launch start when the `status` result
   * showed one), `dead` or `unknown`. Only `dead` leads to the kill and the
   * launch. `live` takes the reconnect path; `pending` on the work's first
   * liveness probe goes to `deferPendingRow` and the work returns
   * `RESTART_OUTCOME_PENDING_DEFERRED` with no reconnect, kill, launch or
   * accounting (`pending` on the b.d61 re-probe after an 'escalate-dead'
   * reconnect returns `RESTART_OUTCOME_PENDING_DEFERRED` with its own line
   * and does not call `deferPendingRow`); `unknown`, a probe that
   * throws and an answer that is not a reading all read `unknown`: the work
   * returns `RESTART_OUTCOME_LIVENESS_UNKNOWN` with no reconnect, kill,
   * launch or accounting, and calls `armRetryTimer`.
   */
  isSessionAlive(key: string): Promise<LivenessReading>
  /** Check if the session already has a live MCP connection in the registry. */
  isSessionConnected(key: string): boolean
  /**
   * Check if the session's standalone GET SSE stream (`_GET_stream`) is present
   * in its transport. A session can be `connected === true` in the registry
   * while the SDK has silently deleted the stream map entry — in that state
   * messages cannot reach the bot, so it must NOT count as "already reconnected"
   * (b.9cj). Returns false when there is no session at all.
   */
  hasSessionStream(key: string): boolean
  /**
   * Attempt to reconnect the MCP session. Returns a discriminated result so
   * restart.ts can call recordSuccess on the 'success' path. `'pending'`: the
   * adapter's own read found the row `pending` (the liveness probe had read
   * it `live`), so nothing was typed and the reconnect is deferred, as
   * `'transient'` is; the work answers `RESTART_OUTCOME_PENDING_DEFERRED`
   * for it, so the retry timer knows the row read `pending`.
   *
   * The return type is widened from void: the server.ts adapter already
   * computes reconnectMcp's ReconnectMcpResult union internally and now
   * surfaces it here so restart.ts has a success signal (SR-25.1).
   *
   * Returning void (e.g. from a reconnect that throws and is caught by the
   * adapter) is treated as non-success — no recordSuccess, no recordFailure
   * (see comment below on why failure is NOT counted here).
   */
  reconnectSession(key: string): Promise<ReconnectSessionResult>
  /**
   * Kill the persona's instance before its launch. `KILL_SESSION_REFUSED`:
   * the kill met an UNAVAILABLE outcome (b.jg5 SRJ-105, `ErrTmuxKillFailed`
   * included) or an ENVIRONMENT one (`ErrTmuxNotAvailable`), so the work
   * launches nothing, records no success or failure and answers
   * `RESTART_OUTCOME_REFUSED`. Anything else, `undefined`
   * included, and a kill that throws, means go on to the launch.
   */
  killSession(key: string): Promise<KillSessionResult>
  /**
   * `cwd` is the persona's working directory. `'skipped'`: the launch was
   * declined (the persona stopped being up after the last `canRestart`
   * check, or the server is stopping), which counts as neither a success nor
   * a failure. `'refused'`: the launch failed and its UNAVAILABLE retry timer
   * was armed for it (b.jg5 SRJ-301), so the timer owns the persona; it
   * counts as neither either (SRJ-302).
   */
  launchSession(key: string, cwd: string, sessionId?: string): Promise<LaunchSessionResult>
  getRestartDelay(): number
  isShuttingDown(): boolean
  /**
   * Called exactly once per cap episode when consecutive failures reach the
   * cap (RESTART_FAILURE_CAP). After this fires, scheduleRestart stops
   * queuing new timers for this persona until recordSuccess clears the latch.
   */
  onCapReached(key: string): void
  /**
   * The per-persona lifecycle serializer's `run` (b.av2 SR-6.6,
   * `persona-serializer.ts`): a fired timer's work (every check, the probe,
   * reconnect, kill and launch), and a retry entry's work with its in-flight
   * check and then the restart cap first, is submitted through it, so it
   * starts only after every operation already submitted for the persona has
   * settled. Scheduling, backoff, the cap (apart from the retry entry's own
   * check), the `activeLaunches` guard and the human-trigger clamp are not
   * serialized. Without it the work runs at once.
   * Production passes the server's one shared serializer.
   */
  serialize?: PersonaSerialize
  /**
   * The arm hook (b.jg5 SRJ-314, SRJ-301): called once with the persona key
   * on every `RESTART_OUTCOME_LIVENESS_UNKNOWN` return of the restart work,
   * the re-probe's included, so the persona's UNAVAILABLE retry timer is
   * armed even for a reading the adapter's own report does not arm on (a
   * probe that throws, or a `status` answer in a state CSCB does not know;
   * a CONFIG answer is armed by the report itself, in any context, b.jg5
   * SRJ-316). Production arms the timer through
   * its controller with the `read-error` cause; a call while the timer is
   * armed or running its retry keeps its due time and wait count. A hook
   * that throws is logged and changes nothing else. Absent: nothing is armed.
   */
  armRetryTimer?(key: string): void
  /**
   * The `pending` deferral (b.jg5 SRJ-314; SRJ-409's entry point): called
   * once with the persona key and its `pending` reading, which carries the
   * row's launch start when the probe read one (`launchStartedAt`, raw), when
   * the work's first liveness probe reads `pending`, before the session's
   * connection is looked at. The work then answers
   * `RESTART_OUTCOME_PENDING_DEFERRED` with no reconnect, kill, launch or
   * accounting. The b.d61 re-probe after an 'escalate-dead' reconnect is the
   * exception: its `pending` answers `RESTART_OUTCOME_PENDING_DEFERRED` with
   * its own line and does not call this member. Production binds the
   * server's `deferPendingRow`. A member
   * that throws is logged and changes nothing else. Absent: nothing is
   * called, and the work answers the same.
   */
  deferPendingRow?(key: string, reading: PendingLivenessReading): void
}

/** What `RestartDeps.reconnectSession` answers; `void` is a non-success. */
export type ReconnectSessionResult = 'success' | 'escalate-dead' | 'transient' | 'pending' | void

/** `RestartDeps.killSession`'s report that the kill was refused (b.jg5 SRJ-105): no launch follows. */
export const KILL_SESSION_REFUSED = 'refused'

/**
 * What `RestartDeps.killSession` answers: `KILL_SESSION_REFUSED` stops the
 * work before its launch; `void` (a kill that resolves with nothing) goes on.
 */
export type KillSessionResult = void | typeof KILL_SESSION_REFUSED

/**
 * What a restart's launch answers: true launched, false a counted failure,
 * `'skipped'` declined and `'refused'` handed to the retry timer, neither of
 * which is counted.
 */
export type LaunchSessionResult = boolean | 'skipped' | 'refused'

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

const pendingRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Per persona key, how many restart works (a fired timer's, a retry entry's)
 * are running or waiting for their serializer turn. A key is active while its
 * count is above 0, so one work that ends never hides another still running.
 */
const activeLaunches = new Map<string, number>()
let deps: RestartDeps | null = null

function markActive(key: string): void {
  activeLaunches.set(key, (activeLaunches.get(key) ?? 0) + 1)
}

function unmarkActive(key: string): void {
  const count = (activeLaunches.get(key) ?? 0) - 1
  if (count > 0) activeLaunches.set(key, count)
  else activeLaunches.delete(key)
}

// ---------------------------------------------------------------------------
// initRestart
// ---------------------------------------------------------------------------

export function initRestart(d: RestartDeps): void {
  deps = d
}

// ---------------------------------------------------------------------------
// scheduleRestart
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed relaunch of the persona with this key. `cwd` is the
 * persona's working directory.
 */
export function scheduleRestart(
  key: string,
  cwd: string,
  sessionId?: string,
  opts?: { humanTrigger?: boolean },
): void {
  if (!deps) {
    console.error('[slack] scheduleRestart: deps not initialized — skipping')
    return
  }

  const baseDelay = deps.getRestartDelay()
  if (baseDelay === 0) {
    console.error(`[slack] Auto-restart disabled (delay=0) — skipping restart for persona=${key}`)
    return
  }

  // At shutdown every persona's bring-up is cancelled (so none is up) and the
  // HTTP server's stop aborts every MCP stream, which lands here: arm no timer,
  // and do not ask the relaunch gate, which would log a healthy persona as
  // not relaunched.
  if (deps.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return
  }

  // b.av2 SR-6.4: a persona that is not up gets no timer at all.
  if (!deps.canRestart(key)) {
    console.error(`[slack] Not scheduling restart for persona=${key} — the relaunch gate refused it (the persona is not up, or is no longer in the applied configuration)`)
    return
  }

  // Compute exponential backoff delay from the pre-failure count (SR-25.2).
  // nextBackoffDelay reads the CURRENT count (before this attempt's failure is
  // recorded) so the first failure uses base*2^0 = base, the second base*2^1, etc.
  let delay = nextBackoffDelay(key, baseDelay)

  // b.kvq: an explicit human message clamps the wait DOWN to a small ceiling so
  // a message lost to a down persona doesn't leave it down for a 900s backoff. This
  // does not touch the failure counter — each attempt still counts toward
  // backoff/cap accounting — and the re-entrancy guard at the call site keeps a
  // chatty persona to one in-flight launch at a time.
  if (opts?.humanTrigger) {
    delay = Math.min(delay, HUMAN_TRIGGER_DELAY_CEILING)
  }

  // Cancel any existing timer for this persona
  const existing = pendingRestartTimers.get(key)
  if (existing !== undefined) {
    clearTimeout(existing)
    pendingRestartTimers.delete(key)
  }

  console.error(`[slack] Scheduling restart for persona=${key} in ${delay}s (backoff)`)

  const timer = setTimeout(async () => {
    pendingRestartTimers.delete(key)
    markActive(key)

    try {
      const d = deps
      if (!d) return
      // b.av2 SR-6.6: the timer body's work runs through the per-persona
      // lifecycle serializer, after any operation already running or queued
      // for this persona (a teardown, a bring-up retry's launch). Every check
      // below runs when the work starts, not when the timer fired. The
      // `activeLaunches` entry covers the wait, so the health check and the
      // lost-message path see the restart as active meanwhile. The work's
      // outcome is not used here.
      await (d.serialize ?? runNow)(key, () => runRestartWork(d, key, cwd, sessionId))
    } finally {
      unmarkActive(key)
    }
  }, delay * 1000)

  pendingRestartTimers.set(key, timer)
}

/** Run an operation at once (synchronously up to its first await): the timer body without an injected serializer. */
async function runNow<T>(_key: string, operation: () => T | Promise<T>): Promise<T> {
  return operation()
}

// ---------------------------------------------------------------------------
// runRestartRetry — the UNAVAILABLE retry timer's entry (b.jg5 SRJ-303)
// ---------------------------------------------------------------------------

/**
 * Rerun the restart path's decision for persona `key` now, for the
 * UNAVAILABLE retry timer's full mode (b.jg5 SRJ-303). `cwd` is the persona's
 * working directory; `isInFlight(key)` is the caller's in-flight check (a
 * launch call for the persona in flight).
 *
 * The key is active (`isRestartPendingOrActive`) while the entry runs. Its
 * work goes through the same per-persona serializer as a fired restart
 * timer's (`RestartDeps.serialize`), so it never overlaps a teardown, a
 * bring-up retry's launch or a restart for the persona. Inside that work,
 * first, `isInFlight(key)`: true answers `RESTART_OUTCOME_IN_FLIGHT` with no
 * agent-director call (a check that throws counts as true). Then the restart
 * cap: at the cap (an earlier restart work's counted failure reached it while
 * this retry waited its turn, although the retry timer checked the cap before
 * calling) it answers `RESTART_OUTCOME_CAPPED` with no agent-director call,
 * nothing counted and no notice (the cap notice went out with the failure
 * that reached the cap). Asking it here is enough: failures are counted only
 * inside the restart work, which the serializer runs one at a time per
 * persona, so the cap cannot be reached while this retry's own work runs.
 * Otherwise the restart work runs, as one recovery attempt, with today's
 * accounting, and its outcome is answered. It bypasses only the restart delay
 * and the restart timer: `getRestartDelay` is never read (it runs with delay
 * 0 too) and no restart timer is armed, cleared or needed. Before `initRestart` it answers
 * `RESTART_OUTCOME_NOT_INITIALISED` and logs. Rejects only when the
 * serializer or an unguarded dependency (`isShuttingDown`, `canRestart`,
 * `isSessionConnected`, `hasSessionStream`, `onCapReached`) throws.
 */
export async function runRestartRetry(
  key: string,
  cwd: string,
  isInFlight: (key: string) => boolean,
): Promise<RestartRetryOutcome> {
  const d = deps
  if (!d) {
    console.error(`[slack] runRestartRetry: deps not initialized — skipping the retry for persona=${key}`)
    return RESTART_OUTCOME_NOT_INITIALISED
  }
  markActive(key)
  try {
    return await (d.serialize ?? runNow)(key, async (): Promise<RestartRetryOutcome> => {
      if (launchInFlight(key, isInFlight)) {
        console.error(`[slack] Restart retry skipped for persona=${key} — a launch is in flight; no agent-director call`)
        return RESTART_OUTCOME_IN_FLIGHT
      }
      if (isAtCap(key, RESTART_FAILURE_CAP)) {
        console.error(`[slack] Restart retry skipped for persona=${key} — the persona is at the restart cap; nothing killed or launched`)
        return RESTART_OUTCOME_CAPPED
      }
      return runRestartWork(d, key, cwd, undefined)
    })
  } finally {
    unmarkActive(key)
  }
}

/** The retry entry's in-flight check: `isInFlight(key)`, with a throw counted as in flight (logged). */
function launchInFlight(key: string, isInFlight: (key: string) => boolean): boolean {
  try {
    return isInFlight(key)
  } catch (err) {
    console.error(`[slack] restart retry: in-flight check failed for persona=${key}: ${describeThrownValue(err)} — treated as in flight`)
    return true
  }
}

/**
 * The work a restart timer does when it fires, and a retry reruns, run
 * through the serializer: the shutdown and not-up checks, the liveness probe,
 * the not-up check again, then, by the reading (b.jg5 SRJ-314), a return with
 * nothing done (`unknown`, a thrown probe included: the arm hook is called;
 * `pending`, whatever the session's connection shows: the `pending` deferral
 * is called), a reconnect (`live`), or a kill and a launch (`dead`), and the
 * success or failure accounting. A reconnect whose verdict
 * is 'escalate-dead' is followed by a second liveness probe; only when the
 * row now reads `dead` does the same run go on to the kill and launch
 * (b.d61). A kill that answers `KILL_SESSION_REFUSED` (b.jg5 SRJ-105) ends
 * the work with `RESTART_OUTCOME_REFUSED`: no launch, nothing counted. The restart cap is not
 * asked here (the retry entry asks it before this work). The whole work is
 * one recovery attempt for the persona (b.jg5 SRJ-301). Answers what it did (`RestartWorkOutcome`).
 */
async function runRestartWork(d: RestartDeps, key: string, cwd: string, sessionId: string | undefined): Promise<RestartWorkOutcome> {
  return runInAttempt(key, 'recovery', () => restartWorkSteps(d, key, cwd, sessionId))
}

/** The steps of `runRestartWork`, inside its recovery attempt. */
async function restartWorkSteps(d: RestartDeps, key: string, cwd: string, sessionId: string | undefined): Promise<RestartWorkOutcome> {
  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return RESTART_OUTCOME_SHUTTING_DOWN
  }

  // b.av2 SR-6.4: the persona stopped being up after this restart was
  // scheduled (e.g. Slack refused a token on a reopen). Leave its instance
  // and its row alone: no liveness probe, reconnect, kill or launch, and
  // no success or failure recorded.
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP

  const probe = await probeLiveness(d, key)

  // Asked again after the liveness probe: it is an async agent-director
  // call, and the persona may have stopped being up while it ran. This is
  // the last check before `reconnectSession` or `killSession` touch the
  // instance; `launchSession`'s own gate (`'skipped'` below) covers a flip
  // during the kill.
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP

  // b.jg5 SRJ-314: agent-director could not report on the persona (a
  // `status` error, or a probe that threw). Never read as dead: no
  // reconnect, kill or launch, nothing counted, and the retry timer is armed.
  if (probe.kind === LIVENESS_UNKNOWN) {
    console.error(`[slack] Liveness unknown for persona=${key}${probeFailure(probe)} — no reconnect, kill or launch; nothing counted`)
    armOnUnknown(d, key)
    return RESTART_OUTCOME_LIVENESS_UNKNOWN
  }

  // b.jg5 SRJ-314: the row reads `pending`, so its session has not started.
  // It goes to the `pending` deferral whatever the session's connection
  // shows (a connected `pending` row is never "already reconnected"): no
  // reconnect, kill or launch, nothing counted.
  if (probe.kind === LIVENESS_PENDING) {
    deferPending(d, key, probe)
    return RESTART_OUTCOME_PENDING_DEFERRED
  }

  // `live` takes the reconnect path; only `dead` falls through to the kill
  // and the launch.
  if (probe.kind !== LIVENESS_DEAD) {
    // If the session already re-established its MCP connection (e.g. Claude
    // Code refreshed the SSE stream on its own), skip the reconnect. A
    // session is only truly healed when it is connected AND its standalone
    // GET SSE stream is present: a connected-but-streamless session (b.9cj)
    // cannot receive messages, so it must proceed to recovery rather than be
    // waved through as "already reconnected".
    if (d.isSessionConnected(key) && d.hasSessionStream(key)) {
      console.error(`[slack] Session already reconnected — skipping restart for persona=${key}`)
      return RESTART_OUTCOME_ALREADY_CONNECTED
    }
    console.error(`[slack] Session alive but disconnected — reconnecting MCP for persona=${key}`)
    let reconnectResult: ReconnectSessionResult
    try {
      reconnectResult = await d.reconnectSession(key)
    } catch (err) {
      console.error(`[slack] restart: reconnectSession failed for persona=${key}: ${describeThrownValue(err)}`)
      reconnectResult = undefined
    }

    if (reconnectResult === 'success') {
      // Reconnect succeeded — reset the failure counter and cap latch.
      recordSuccess(key)
      return RESTART_OUTCOME_RECONNECTED
    }
    // Non-success/non-void branches ('escalate-dead', 'transient', 'pending', or undefined):
    // do NOT recordFailure here. SR-25.1 / single counting site: counting
    // lives only at the launchSession boolean below. restart.ts does not
    // re-enter scheduleRestart on any of these outcomes. Post-b.9a7 that is
    // safe: the periodic health-check tick is now the retry driver. On the
    // next tick the persona is re-observed; if it is still alive &&
    // !connected (or has since gone dead), the tick calls scheduleRestart
    // again, so a failed/deferred reconnect is retried without any re-entry
    // here. ('transient' also covers the b.9a7 hazard-2 `working` defer: the
    // tick retries once the turn settles. b.f2b: it also covers a `working`
    // row whose idle evidence is still being gathered — the tick then retries
    // on its first undeliverable observation, and the adapter reconnects the
    // row once its pane has shown the same idle screen and its transcript has
    // ended with a completed turn, both unchanged, across attempts — a
    // `waiting` row whose pane shows a running turn or a prompt, an
    // `ask_user`/`check_permission` row, which is never typed into, and a
    // failed status call, which types nothing blind.) Not counting here keeps
    // the failure count tied to actual launch attempts, not this reconnect
    // site.
    //
    // For the dead-tmux 'escalate-dead' verdicts ('dead-session' from
    // reconnectMcp, and b.d61's `working` row whose tmux session is gone)
    // CSCB recovers itself (b.sv7 / Epic t1.tkk.e4): the reconnectSession
    // adapter fires the internal memoized findMissing sweep before returning,
    // so the frozen `working` row reconciles to `missing`. b.d61: rather than
    // wait for the next tick (a full health interval plus another backoff
    // delay), this run probes liveness again and, when the row now reads
    // `dead`, falls through to the kill+relaunch branch below at once, with
    // the same accounting as any dead-session relaunch. When the row still
    // reads live or `pending` (e.g. the sweep failed or a memoized result
    // predates the kill), it returns as before and the next tick retries;
    // when the re-probe reads `unknown` (b.jg5 SRJ-314), it returns with no
    // relaunch and the arm hook is called. The external
    // ~/startup/find-missing-loop.sh is belt-and-braces only — recovery no
    // longer depends on it, and removing it is a separate operator decision.
    if (reconnectResult === 'pending') return RESTART_OUTCOME_PENDING_DEFERRED
    if (reconnectResult !== 'escalate-dead') return RESTART_OUTCOME_RECONNECT_DEFERRED
    const held = await reprobeDeadAfterEscalate(d, key)
    if (held !== undefined) return held
  }

  // Kill the zombie session, if any. A refused kill (`KILL_SESSION_REFUSED`,
  // b.jg5 SRJ-105) stops the run below with no launch; any other error (a
  // throw, e.g. the session may not exist) is ignored and the launch follows.
  let killed: KillSessionResult = undefined
  try {
    killed = await d.killSession(key)
  } catch { /* ignore */ }

  if (killed === KILL_SESSION_REFUSED) {
    // b.jg5 SRJ-105: agent-director refused the kill (UNAVAILABLE or
    // ENVIRONMENT), so no launch follows it. Nothing is counted: the failure
    // counter, backoff and cap latch are left exactly as they were, and the
    // refusal is answered as the launch's is (SRJ-302).
    console.error(`[slack] Session kill refused for persona=${key} — no relaunch; not counted`)
    return RESTART_OUTCOME_REFUSED
  }

  console.error(`[slack] Relaunching session for persona=${key} cwd="${cwd}"`)

  let ok: LaunchSessionResult
  try {
    ok = await d.launchSession(key, cwd, sessionId)
  } catch (err) {
    console.error(`[slack] restart: launchSession threw for persona=${key}: ${describeThrownValue(err)}`)
    ok = false
  }

  if (ok === 'skipped') {
    // Declined: the persona stopped being up between the last `canRestart`
    // check above and the launch, and the launch's own gate (the same
    // relaunch gate) logged why; or the launch's version re-check decided
    // the stop, and the server is stopping. The instance was already killed
    // by then; the failure counter, backoff and cap latch are left exactly
    // as they were.
    return RESTART_OUTCOME_LAUNCH_SKIPPED
  }

  if (ok === 'refused') {
    // b.jg5 SRJ-302: refused, not failed. The launch met an UNAVAILABLE
    // outcome (or a read error) that armed the persona's retry timer, which
    // owns the persona from here. A persona is never given up on for
    // UNAVAILABLE alone, so the failure counter, backoff and cap latch are
    // left exactly as they were.
    console.error(`[slack] Session relaunch refused for persona=${key} — not counted; its UNAVAILABLE retry timer owns the persona`)
    return RESTART_OUTCOME_REFUSED
  }

  if (ok) {
    // Successful launch — reset consecutive-failure counter and cap latch.
    recordSuccess(key)
    return RESTART_OUTCOME_LAUNCHED
  }

  // Launch failed — increment the failure counter (SINGLE COUNTING SITE:
  // SR-25.1; counting happens only here at the launchSession boolean).
  recordFailure(key)
  console.error(`[slack] Session relaunch failed for persona=${key}`)

  // Once-per-episode cap notification: fires exactly once when the failure
  // count reaches RESTART_FAILURE_CAP. Subsequent calls return false (latched).
  if (shouldNotifyCap(key, RESTART_FAILURE_CAP)) {
    console.error(`[slack] Cap reached for persona=${key} — notifying and stopping restarts`)
    d.onCapReached(key)
    // Do NOT schedule another timer — the persona is capped. The
    // activeLaunches entry is removed in the caller's finally block.
    // The tick guard (isAtCap in health-check.ts) prevents future ticks
    // from re-scheduling while capped (SR-25.3/25.4).
    return RESTART_OUTCOME_CAPPED
  }
  // A failure past the cap (its notice already sent this episode) is capped too.
  return isAtCap(key, RESTART_FAILURE_CAP) ? RESTART_OUTCOME_CAPPED : RESTART_OUTCOME_COUNTED_FAILURE
}

/**
 * b.d61: after an 'escalate-dead' reconnect verdict (whose adapter already ran
 * the findMissing sweep), probe the persona's liveness again. Returns
 * undefined only when the row now reads `dead` and this restart run should go
 * on to the kill+relaunch branch; otherwise the outcome the run returns with,
 * with no relaunch (b.jg5 SRJ-314): `RESTART_OUTCOME_RECONNECT_DEFERRED` (the
 * row still reads `live`, so the next tick retries),
 * `RESTART_OUTCOME_PENDING_DEFERRED` (the row reads `pending`: its session
 * has not started), `RESTART_OUTCOME_LIVENESS_UNKNOWN` (the re-probe read
 * `unknown` or threw: agent-director could not report on the persona, and the
 * arm hook is called), `RESTART_OUTCOME_SHUTTING_DOWN` or
 * `RESTART_OUTCOME_NOT_UP`. Shutdown and the not-up gate are asked after the
 * probe, since it is an async agent-director call; `killSession`'s
 * launch-in-flight guard and `launchSession`'s own gate still apply after it.
 * Records no success or failure.
 */
async function reprobeDeadAfterEscalate(d: RestartDeps, key: string): Promise<RestartWorkOutcome | undefined> {
  const probe = await probeLiveness(d, key)

  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return RESTART_OUTCOME_SHUTTING_DOWN
  }
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP

  switch (probe.kind) {
    case LIVENESS_DEAD:
      console.error(`[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=${key} (b.d61)`)
      return undefined
    case LIVENESS_UNKNOWN:
      console.error(`[slack] Liveness unknown after escalate-dead for persona=${key}${probeFailure(probe)} — no relaunch in this restart run; nothing counted`)
      armOnUnknown(d, key)
      return RESTART_OUTCOME_LIVENESS_UNKNOWN
    case LIVENESS_PENDING:
      console.error(`[slack] Session reads pending after escalate-dead — its session has not started; no relaunch in this restart run for persona=${key}`)
      return RESTART_OUTCOME_PENDING_DEFERRED
    default:
      console.error(`[slack] Session still reads alive after escalate-dead — leaving the relaunch to a later tick for persona=${key}`)
      return RESTART_OUTCOME_RECONNECT_DEFERRED
  }
}

/**
 * One liveness probe's result: its reading's kind, why it failed when the
 * probe threw, and a `pending` reading's launch start.
 */
interface LivenessProbe {
  readonly kind: LivenessKind
  /** `describeThrownValue` of what the probe threw; absent when it answered. */
  readonly failure?: string
  /** A `pending` reading's launch start (raw); absent for any other reading, or when it showed none. */
  readonly launchStartedAt?: string
}

/**
 * Probe persona `key`'s liveness (b.jg5 SRJ-314): the reading's kind, with a
 * probe that throws, or answers something that is not a reading, read
 * `unknown` (never `dead`), and a `pending` reading's launch start. Logs
 * nothing; never rejects.
 */
async function probeLiveness(d: RestartDeps, key: string): Promise<LivenessProbe> {
  let reading: LivenessReading
  try {
    reading = await d.isSessionAlive(key)
  } catch (err) {
    return { kind: LIVENESS_UNKNOWN, failure: describeThrownValue(err) }
  }
  const kind = livenessKindOf(reading)
  const launchStartedAt = launchStartOfReading(reading)
  return launchStartedAt === undefined ? { kind } : { kind, launchStartedAt }
}

/**
 * Hand persona `key`'s `pending` reading, with the launch start its probe
 * read, to the `pending` deferral (`RestartDeps.deferPendingRow`) once
 * (b.jg5 SRJ-314). Absent, nothing is called. A member that throws is
 * logged; never throws.
 */
function deferPending(d: RestartDeps, key: string, probe: LivenessProbe): void {
  if (d.deferPendingRow === undefined) return
  try {
    d.deferPendingRow(key, pendingLivenessReading(probe.launchStartedAt))
  } catch (err) {
    console.error(`[slack] restart: the pending deferral failed for persona=${key}: ${describeThrownValue(err)}`)
  }
}

/** ` (isSessionAlive failed: <why>)` for a probe that threw, else empty: the part of an unknown line that names the failure. */
function probeFailure(probe: LivenessProbe): string {
  return probe.failure === undefined ? '' : ` (isSessionAlive failed: ${probe.failure})`
}

/**
 * Call the arm hook (`RestartDeps.armRetryTimer`) for persona `key` once, on
 * an `unknown` reading (b.jg5 SRJ-314). Absent, nothing is armed. A hook that
 * throws is logged; never throws.
 */
function armOnUnknown(d: RestartDeps, key: string): void {
  if (d.armRetryTimer === undefined) return
  try {
    d.armRetryTimer(key)
  } catch (err) {
    console.error(`[slack] restart: arming the retry timer failed for persona=${key}: ${describeThrownValue(err)}`)
  }
}

/**
 * The timer-time not-up check (b.av2 SR-6.4): when `canRestart` answers false,
 * log that the restart is skipped and the instance left as it is, and return
 * true so the caller returns before touching the persona. Records neither a
 * success nor a failure.
 */
function skipIfNotUp(d: RestartDeps, key: string): boolean {
  if (d.canRestart(key)) return false
  console.error(`[slack] Skipping restart for persona=${key} — the persona is no longer up; its instance is left as it is`)
  return true
}

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

export function cancelAllRestartTimers(): void {
  for (const [key, timer] of pendingRestartTimers) {
    clearTimeout(timer)
    console.error(`[slack] Cancelled restart timer for persona=${key}`)
  }
  pendingRestartTimers.clear()
}

// ---------------------------------------------------------------------------
// cancelRestartTimer — one persona's pending timer
// ---------------------------------------------------------------------------

/**
 * Cancel the pending restart timer for persona `key`, if any, so it never
 * fires (b.av2 SR-6.5, a teardown). Other personas' timers are untouched.
 * A work already started (its `activeLaunches` entry) is left alone: the
 * teardown waits for it through the lifecycle serializer. Records no success
 * or failure and posts nothing; logs the cancelled-timer line only when a
 * timer was pending. Returns whether one was.
 */
export function cancelRestartTimer(key: string): boolean {
  const timer = pendingRestartTimers.get(key)
  if (timer === undefined) return false
  clearTimeout(timer)
  pendingRestartTimers.delete(key)
  console.error(`[slack] Cancelled restart timer for persona=${key}`)
  return true
}

// ---------------------------------------------------------------------------
// isRestartPendingOrActive — query function
// ---------------------------------------------------------------------------

export function isRestartPendingOrActive(key: string): boolean {
  return pendingRestartTimers.has(key) || activeLaunches.has(key)
}

// ---------------------------------------------------------------------------
// _resetRestartState — exported for test cleanup
// ---------------------------------------------------------------------------

export function _resetRestartState(): void {
  for (const timer of pendingRestartTimers.values()) {
    clearTimeout(timer)
  }
  pendingRestartTimers.clear()
  activeLaunches.clear()
  deps = null
}
