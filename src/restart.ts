/**
 * restart.ts — Auto-restart logic for managed Claude Code sessions.
 *
 * Schedules a delayed relaunch when an MCP session disconnects. Restart
 * guards, backoff and the failure cap are keyed by persona key (b.av2 SR-6.3):
 * every dependency, the pending-timer map and the in-flight launch set take
 * the key, and log lines name it as `persona=<key>`.
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
  /** `cwd` is the persona's working directory. */
  launchSession(key: string, cwd: string, sessionId?: string): Promise<boolean>
  getRestartDelay(): number
  isShuttingDown(): boolean
  /**
   * Called exactly once per cap episode when consecutive failures reach the
   * cap (RESTART_FAILURE_CAP). After this fires, scheduleRestart stops
   * queuing new timers for this persona until recordSuccess clears the latch.
   */
  onCapReached(key: string): void
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

  // Compute exponential backoff delay from the pre-failure count (SR-25.2).
  // nextBackoffDelay reads the CURRENT count (before this attempt's failure is
  // recorded) so the first failure uses base*2^0 = base, the second base*2^1, etc.
  let delay = nextBackoffDelay(key, baseDelay)

  // b.kvq: an explicit human message clamps the wait DOWN to a small ceiling so
  // a person messaging the persona isn't told to wait out a 900s backoff. This
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
      if (!deps) return

      if (deps.isShuttingDown()) {
        console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
        return
      }

      let alive: boolean
      try {
        alive = await deps.isSessionAlive(key)
      } catch (err) {
        console.error(`[slack] restart: isSessionAlive failed for persona=${key}:`, err)
        alive = false
      }

      if (alive) {
        // If the session already re-established its MCP connection (e.g. Claude
        // Code refreshed the SSE stream on its own), skip the reconnect. A
        // session is only truly healed when it is connected AND its standalone
        // GET SSE stream is present: a connected-but-streamless session (b.9cj)
        // cannot receive messages, so it must proceed to recovery rather than be
        // waved through as "already reconnected".
        if (deps.isSessionConnected(key) && deps.hasSessionStream(key)) {
          console.error(`[slack] Session already reconnected — skipping restart for persona=${key}`)
          return
        }
        console.error(`[slack] Session alive but disconnected — reconnecting MCP for persona=${key}`)
        let reconnectResult: 'success' | 'escalate-dead' | 'transient' | void
        try {
          reconnectResult = await deps.reconnectSession(key)
        } catch (err) {
          console.error(`[slack] restart: reconnectSession failed for persona=${key}:`, err)
          reconnectResult = undefined
        }

        if (reconnectResult === 'success') {
          // Reconnect succeeded — reset the failure counter and cap latch.
          recordSuccess(key)
        }
        // Non-success/non-void branches ('escalate-dead', 'transient', or undefined):
        // do NOT recordFailure here. SR-25.1 / single counting site: counting
        // lives only at the launchSession boolean below. restart.ts does not
        // re-enter scheduleRestart on any of these outcomes — it simply returns.
        // Post-b.9a7 that is safe: the periodic health-check tick is now the
        // retry driver. On the next tick the persona is re-observed; if it is
        // still alive && !connected (or has since gone dead), the tick calls
        // scheduleRestart again, so a failed/deferred reconnect is retried
        // without any re-entry here. ('transient' also covers the b.9a7 hazard-2
        // `working` defer: the tick retries once the turn settles.) For the
        // dead-tmux 'escalate-dead' case CSCB now recovers itself (b.sv7 / Epic
        // t1.tkk.e4): the reconnectSession adapter fires the internal memoized
        // findMissing sweep before returning 'escalate-dead', so the frozen
        // `working` row reconciles to `missing` and the NEXT tick observes
        // alive === false and falls through to the kill+relaunch branch below.
        // The external ~/startup/find-missing-loop.sh is belt-and-braces only —
        // recovery no longer depends on it, and removing it is a separate
        // operator decision. Not counting here keeps the failure count tied to
        // actual launch attempts, not this reconnect site.
        return
      }

      // Kill zombie if needed (ignore errors — session may not exist)
      try {
        await deps.killSession(key)
      } catch { /* ignore */ }

      console.error(`[slack] Relaunching session for persona=${key} cwd="${cwd}"`)

      let ok: boolean
      try {
        ok = await deps.launchSession(key, cwd, sessionId)
      } catch (err) {
        console.error(`[slack] restart: launchSession threw for persona=${key}:`, err)
        ok = false
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
          deps.onCapReached(key)
          // Do NOT schedule another timer — the persona is capped. The
          // activeLaunches entry is removed in the finally block below.
          // The tick guard (isAtCap in health-check.ts) prevents future ticks
          // from re-scheduling while capped (SR-25.3/25.4).
          return
        }
      }
    } finally {
      activeLaunches.delete(key)
    }
  }, delay * 1000)

  pendingRestartTimers.set(key, timer)
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
