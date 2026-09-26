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
 * state when the work starts.
 * Isolated from server.ts side effects — injectable deps make it testable.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  recordFailure,
  recordSuccess,
  nextBackoffDelay,
  shouldNotifyCap,
} from './backoff.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import { describeThrownValue } from './persona-connection-errors.ts'

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
  isSessionAlive(key: string): Promise<boolean>
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
   * restart.ts can call recordSuccess on the 'success' path.
   *
   * The return type is widened from void: the server.ts adapter already
   * computes reconnectMcp's ReconnectMcpResult union internally and now
   * surfaces it here so restart.ts has a success signal (SR-25.1).
   *
   * Returning void (e.g. from a reconnect that throws and is caught by the
   * adapter) is treated as non-success — no recordSuccess, no recordFailure
   * (see comment below on why failure is NOT counted here).
   */
  reconnectSession(key: string): Promise<'success' | 'escalate-dead' | 'transient' | void>
  killSession(key: string): Promise<void>
  /**
   * `cwd` is the persona's working directory. `'skipped'`: the launch was
   * declined (the persona stopped being up after the last `canRestart`
   * check), which counts as neither a success nor a failure.
   */
  launchSession(key: string, cwd: string, sessionId?: string): Promise<boolean | 'skipped'>
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
   * reconnect, kill and launch) is submitted through it, so it starts only
   * after every operation already submitted for the persona has settled.
   * Scheduling, backoff, the cap, the `activeLaunches` guard and the
   * human-trigger clamp are not serialized. Without it the work runs at once.
   * Production passes the server's one shared serializer.
   */
  serialize?: PersonaSerialize
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

const pendingRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeLaunches = new Set<string>()
let deps: RestartDeps | null = null

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
    activeLaunches.add(key)

    try {
      const d = deps
      if (!d) return
      // b.av2 SR-6.6: the timer body's work runs through the per-persona
      // lifecycle serializer, after any operation already running or queued
      // for this persona (a teardown, a bring-up retry's launch). Every check
      // below runs when the work starts, not when the timer fired. The
      // `activeLaunches` entry covers the wait, so the health check and the
      // lost-message path see the restart as active meanwhile.
      await (d.serialize ?? runNow)(key, () => runRestartWork(d, key, cwd, sessionId))
    } finally {
      activeLaunches.delete(key)
    }
  }, delay * 1000)

  pendingRestartTimers.set(key, timer)
}

/** Run an operation at once (synchronously up to its first await): the timer body without an injected serializer. */
async function runNow<T>(_key: string, operation: () => T | Promise<T>): Promise<T> {
  return operation()
}

/**
 * The work a restart timer does when it fires, run through the serializer:
 * the shutdown and not-up checks, the liveness probe, then a reconnect, or a
 * kill and a launch, and the success or failure accounting. A reconnect whose
 * verdict is 'escalate-dead' is followed by a second liveness probe; when the
 * row now reads dead, the same run goes on to the kill and launch (b.d61).
 */
async function runRestartWork(d: RestartDeps, key: string, cwd: string, sessionId: string | undefined): Promise<void> {
  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return
  }

  // b.av2 SR-6.4: the persona stopped being up after this restart was
  // scheduled (e.g. Slack refused a token on a reopen). Leave its instance
  // and its row alone: no liveness probe, reconnect, kill or launch, and
  // no success or failure recorded.
  if (skipIfNotUp(d, key)) return

  let alive: boolean
  try {
    alive = await d.isSessionAlive(key)
  } catch (err) {
    console.error(`[slack] restart: isSessionAlive failed for persona=${key}: ${describeThrownValue(err)}`)
    alive = false
  }

  // Asked again after the liveness probe: it is an async agent-director
  // call, and the persona may have stopped being up while it ran. This is
  // the last check before `reconnectSession` or `killSession` touch the
  // instance; `launchSession`'s own gate (`'skipped'` below) covers a flip
  // during the kill.
  if (skipIfNotUp(d, key)) return

  if (alive) {
    // If the session already re-established its MCP connection (e.g. Claude
    // Code refreshed the SSE stream on its own), skip the reconnect. A
    // session is only truly healed when it is connected AND its standalone
    // GET SSE stream is present: a connected-but-streamless session (b.9cj)
    // cannot receive messages, so it must proceed to recovery rather than be
    // waved through as "already reconnected".
    if (d.isSessionConnected(key) && d.hasSessionStream(key)) {
      console.error(`[slack] Session already reconnected — skipping restart for persona=${key}`)
      return
    }
    console.error(`[slack] Session alive but disconnected — reconnecting MCP for persona=${key}`)
    let reconnectResult: 'success' | 'escalate-dead' | 'transient' | void
    try {
      reconnectResult = await d.reconnectSession(key)
    } catch (err) {
      console.error(`[slack] restart: reconnectSession failed for persona=${key}: ${describeThrownValue(err)}`)
      reconnectResult = undefined
    }

    if (reconnectResult === 'success') {
      // Reconnect succeeded — reset the failure counter and cap latch.
      recordSuccess(key)
      return
    }
    // Non-success/non-void branches ('escalate-dead', 'transient', or undefined):
    // do NOT recordFailure here. SR-25.1 / single counting site: counting
    // lives only at the launchSession boolean below. restart.ts does not
    // re-enter scheduleRestart on any of these outcomes. Post-b.9a7 that is
    // safe: the periodic health-check tick is now the retry driver. On the
    // next tick the persona is re-observed; if it is still alive &&
    // !connected (or has since gone dead), the tick calls scheduleRestart
    // again, so a failed/deferred reconnect is retried without any re-entry
    // here. ('transient' also covers the b.9a7 hazard-2 `working` defer: the
    // tick retries once the turn settles.) Not counting here keeps the
    // failure count tied to actual launch attempts, not this reconnect site.
    //
    // For the dead-tmux 'escalate-dead' verdicts ('dead-session' from
    // reconnectMcp, and b.d61's `working` row whose tmux session is gone)
    // CSCB recovers itself (b.sv7 / Epic t1.tkk.e4): the reconnectSession
    // adapter fires the internal memoized findMissing sweep before returning,
    // so the frozen `working` row reconciles to `missing`. b.d61: rather than
    // wait for the next tick (a full health interval plus another backoff
    // delay), this run probes liveness again and, when the row now reads
    // dead, falls through to the kill+relaunch branch below at once, with the
    // same accounting as any dead-session relaunch. When the row still reads
    // alive (e.g. the sweep failed or a memoized result predates the kill),
    // it returns as before and the next tick retries. The external
    // ~/startup/find-missing-loop.sh is belt-and-braces only — recovery no
    // longer depends on it, and removing it is a separate operator decision.
    if (reconnectResult !== 'escalate-dead') return
    if (!(await reprobeDeadAfterEscalate(d, key))) return
  }

  // Kill zombie if needed (ignore errors — session may not exist)
  try {
    await d.killSession(key)
  } catch { /* ignore */ }

  console.error(`[slack] Relaunching session for persona=${key} cwd="${cwd}"`)

  let ok: boolean | 'skipped'
  try {
    ok = await d.launchSession(key, cwd, sessionId)
  } catch (err) {
    console.error(`[slack] restart: launchSession threw for persona=${key}: ${describeThrownValue(err)}`)
    ok = false
  }

  if (ok === 'skipped') {
    // Declined, not attempted: the persona stopped being up between the
    // last `canRestart` check above and the launch, and the launch's own
    // gate (the same relaunch gate) logged why. The instance was already
    // killed by then; the failure counter, backoff and cap latch are left
    // exactly as they were.
    return
  }

  if (ok) {
    // Successful launch — reset consecutive-failure counter and cap latch.
    recordSuccess(key)
  } else {
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
      // activeLaunches entry is removed in the timer's finally block.
      // The tick guard (isAtCap in health-check.ts) prevents future ticks
      // from re-scheduling while capped (SR-25.3/25.4).
      return
    }
  }
}

/**
 * b.d61: after an 'escalate-dead' reconnect verdict (whose adapter already ran
 * the findMissing sweep), probe the persona's liveness again. Returns true when
 * the row now reads dead and this restart run should go on to the
 * kill+relaunch branch; false when it should return as before (the row still
 * reads alive, so the next tick retries; the server is shutting down; or the
 * persona is no longer up). The probe is guarded as the first one is: a thrown
 * probe counts as not alive. Shutdown and the not-up gate are asked after the
 * probe, since it is an async agent-director call; `killSession`'s
 * launch-in-flight guard and `launchSession`'s own gate still apply after it.
 * Records no success or failure.
 */
async function reprobeDeadAfterEscalate(d: RestartDeps, key: string): Promise<boolean> {
  let alive: boolean
  try {
    alive = await d.isSessionAlive(key)
  } catch (err) {
    console.error(`[slack] restart: isSessionAlive failed after escalate-dead for persona=${key}: ${describeThrownValue(err)}`)
    alive = false
  }

  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return false
  }
  if (skipIfNotUp(d, key)) return false

  if (alive) {
    console.error(`[slack] Session still reads alive after escalate-dead — leaving the relaunch to a later tick for persona=${key}`)
    return false
  }
  console.error(`[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=${key} (b.d61)`)
  return true
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
