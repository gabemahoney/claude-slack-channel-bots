/**
 * restart.ts — Auto-restart logic for managed Claude Code sessions.
 *
 * Schedules a delayed relaunch when an MCP session disconnects.
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
 * isRestartPendingOrActive at the call site, a chatty channel gets at most one
 * in-flight launch attempt at a time and each failed attempt still counts
 * toward normal backoff/cap accounting (b.kvq).
 */
export const HUMAN_TRIGGER_DELAY_CEILING = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestartDeps {
  isSessionAlive(channelId: string): Promise<boolean>
  /** Check if the session already has a live MCP connection in the registry. */
  isSessionConnected(channelId: string): boolean
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
  reconnectSession(channelId: string): Promise<'success' | 'escalate-dead' | 'transient' | void>
  killSession(channelId: string): Promise<void>
  launchSession(channelId: string, cwd: string, sessionId?: string): Promise<boolean>
  getRestartDelay(): number
  isShuttingDown(): boolean
  /**
   * Called exactly once per cap episode when consecutive failures reach the
   * cap (RESTART_FAILURE_CAP). After this fires, scheduleRestart stops
   * queuing new timers for this channel until recordSuccess clears the latch.
   */
  onCapReached(channelId: string): void
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

export function scheduleRestart(
  channelId: string,
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
    console.error(`[slack] Auto-restart disabled (delay=0) — skipping restart for channel=${channelId}`)
    return
  }

  // Compute exponential backoff delay from the pre-failure count (SR-25.2).
  // nextBackoffDelay reads the CURRENT count (before this attempt's failure is
  // recorded) so the first failure uses base*2^0 = base, the second base*2^1, etc.
  let delay = nextBackoffDelay(channelId, baseDelay)

  // b.kvq: an explicit human message clamps the wait DOWN to a small ceiling so
  // a person typing in the channel isn't told to wait out a 900s backoff. This
  // does not touch the failure counter — each attempt still counts toward
  // backoff/cap accounting — and the re-entrancy guard at the call site keeps a
  // chatty channel to one in-flight launch at a time.
  if (opts?.humanTrigger) {
    delay = Math.min(delay, HUMAN_TRIGGER_DELAY_CEILING)
  }

  // Cancel any existing timer for this channel
  const existing = pendingRestartTimers.get(channelId)
  if (existing !== undefined) {
    clearTimeout(existing)
    pendingRestartTimers.delete(channelId)
  }

  console.error(`[slack] Scheduling restart for channel=${channelId} in ${delay}s (backoff)`)

  const timer = setTimeout(async () => {
    pendingRestartTimers.delete(channelId)
    activeLaunches.add(channelId)

    try {
      if (!deps) return

      if (deps.isShuttingDown()) {
        console.error(`[slack] Skipping restart — server is shutting down (channel=${channelId})`)
        return
      }

      let alive: boolean
      try {
        alive = await deps.isSessionAlive(channelId)
      } catch (err) {
        console.error(`[slack] restart: isSessionAlive failed for channel=${channelId}:`, err)
        alive = false
      }

      if (alive) {
        // If the session already re-established its MCP connection (e.g. Claude
        // Code refreshed the SSE stream on its own), skip the reconnect.
        if (deps.isSessionConnected(channelId)) {
          console.error(`[slack] Session already reconnected — skipping restart for channel=${channelId}`)
          return
        }
        console.error(`[slack] Session alive but disconnected — reconnecting MCP for channel=${channelId}`)
        let reconnectResult: 'success' | 'escalate-dead' | 'transient' | void
        try {
          reconnectResult = await deps.reconnectSession(channelId)
        } catch (err) {
          console.error(`[slack] restart: reconnectSession failed for channel=${channelId}:`, err)
          reconnectResult = undefined
        }

        if (reconnectResult === 'success') {
          // Reconnect succeeded — reset the failure counter and cap latch.
          recordSuccess(channelId)
        }
        // Non-success/non-void branches ('escalate-dead', 'transient', or undefined):
        // do NOT recordFailure here. SR-25.1 / single counting site: counting
        // lives only at the launchSession boolean below. restart.ts does not
        // re-enter scheduleRestart on any of these outcomes — it simply returns.
        // Post-b.9a7 that is safe: the periodic health-check tick is now the
        // retry driver. On the next tick the channel is re-observed; if it is
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
        await deps.killSession(channelId)
      } catch { /* ignore */ }

      console.error(`[slack] Relaunching session for channel=${channelId} cwd="${cwd}"`)

      let ok: boolean
      try {
        ok = await deps.launchSession(channelId, cwd, sessionId)
      } catch (err) {
        console.error(`[slack] restart: launchSession threw for channel=${channelId}:`, err)
        ok = false
      }

      if (ok) {
        // Successful launch — reset consecutive-failure counter and cap latch.
        recordSuccess(channelId)
      } else {
        // Launch failed — increment the failure counter (SINGLE COUNTING SITE:
        // SR-25.1; counting happens only here at the launchSession boolean).
        recordFailure(channelId)
        console.error(`[slack] Session relaunch failed for channel=${channelId}`)

        // Once-per-episode cap notification: fires exactly once when the failure
        // count reaches RESTART_FAILURE_CAP. Subsequent calls return false (latched).
        if (shouldNotifyCap(channelId, RESTART_FAILURE_CAP)) {
          console.error(`[slack] Cap reached for channel=${channelId} — notifying and stopping restarts`)
          deps.onCapReached(channelId)
          // Do NOT schedule another timer — the channel is capped. The
          // activeLaunches entry is removed in the finally block below.
          // The tick guard (isAtCap in health-check.ts) prevents future ticks
          // from re-scheduling while capped (SR-25.3/25.4).
          return
        }
      }
    } finally {
      activeLaunches.delete(channelId)
    }
  }, delay * 1000)

  pendingRestartTimers.set(channelId, timer)
}

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

export function cancelAllRestartTimers(): void {
  for (const [channelId, timer] of pendingRestartTimers) {
    clearTimeout(timer)
    console.error(`[slack] Cancelled restart timer for channel=${channelId}`)
  }
  pendingRestartTimers.clear()
}

// ---------------------------------------------------------------------------
// isRestartPendingOrActive — query function
// ---------------------------------------------------------------------------

export function isRestartPendingOrActive(channelId: string): boolean {
  return pendingRestartTimers.has(channelId) || activeLaunches.has(channelId)
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
