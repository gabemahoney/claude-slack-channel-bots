/**
 * restart.ts — Auto-restart logic for managed Claude Code sessions.
 *
 * Schedules a delayed relaunch when an MCP session disconnects.
 * Isolated from server.ts side effects — injectable deps make it testable.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestartDeps {
  isSessionAlive(channelId: string): Promise<boolean>
  reconnectSession(channelId: string): Promise<void>
  killSession(channelId: string): Promise<void>
  launchSession(channelId: string, cwd: string, sessionId?: string): Promise<boolean>
  getRestartDelay(): number
  isShuttingDown(): boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CONSECUTIVE_FAILURES = 3

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

const failureCounters = new Map<string, number>()
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

export function scheduleRestart(channelId: string, cwd: string, sessionId?: string): void {
  if (!deps) {
    console.error('[slack] scheduleRestart: deps not initialized — skipping')
    return
  }

  const delay = deps.getRestartDelay()
  if (delay === 0) {
    console.error(`[slack] Auto-restart disabled (delay=0) — skipping restart for channel=${channelId}`)
    return
  }

  const failures = failureCounters.get(channelId) ?? 0
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    console.error(
      `[slack] Max consecutive failures (${MAX_CONSECUTIVE_FAILURES}) reached — giving up on channel=${channelId} cwd="${cwd}"`,
    )
    return
  }

  // Cancel any existing timer for this channel
  const existing = pendingRestartTimers.get(channelId)
  if (existing !== undefined) {
    clearTimeout(existing)
    pendingRestartTimers.delete(channelId)
  }

  console.error(`[slack] Scheduling restart for channel=${channelId} in ${delay}s`)

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
        console.error(`[slack] Session alive but disconnected — reconnecting MCP for channel=${channelId}`)
        try {
          await deps.reconnectSession(channelId)
        } catch (err) {
          console.error(`[slack] restart: reconnectSession failed for channel=${channelId}:`, err)
        }
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

      if (!ok) {
        const count = (failureCounters.get(channelId) ?? 0) + 1
        failureCounters.set(channelId, count)
        console.error(
          `[slack] Session relaunch failed for channel=${channelId} (failure ${count}/${MAX_CONSECUTIVE_FAILURES})`,
        )
      }
    } finally {
      activeLaunches.delete(channelId)
    }
  }, delay * 1000)

  pendingRestartTimers.set(channelId, timer)
}

// ---------------------------------------------------------------------------
// resetFailureCounter
// ---------------------------------------------------------------------------

export function resetFailureCounter(channelId: string): void {
  failureCounters.set(channelId, 0)
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
// isRestartPendingOrActive / hasReachedMaxFailures — query functions
// ---------------------------------------------------------------------------

export function isRestartPendingOrActive(channelId: string): boolean {
  return pendingRestartTimers.has(channelId) || activeLaunches.has(channelId)
}

export function hasReachedMaxFailures(channelId: string): boolean {
  return (failureCounters.get(channelId) ?? 0) >= MAX_CONSECUTIVE_FAILURES
}

// ---------------------------------------------------------------------------
// _resetRestartState — exported for test cleanup
// ---------------------------------------------------------------------------

export function _resetRestartState(): void {
  for (const timer of pendingRestartTimers.values()) {
    clearTimeout(timer)
  }
  failureCounters.clear()
  pendingRestartTimers.clear()
  activeLaunches.clear()
  deps = null
}
