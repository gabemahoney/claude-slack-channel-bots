/**
 * health-check.ts — Periodic liveness poller for managed Claude Code sessions.
 *
 * On each tick, checks every configured route and schedules a restart if the
 * session is dead and not already pending/failed. Follows the same pattern as
 * restart.ts: module-scoped state, injectable deps, no server.ts imports.
 *
 * SPDX-License-Identifier: MIT
 */

import { setOutageFlag, clearOutageFlag } from './outage-state.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheckDeps {
  isSessionAlive(channelId: string): Promise<boolean>
  isRestartPendingOrActive(channelId: string): boolean
  statRoute(cwd: string): Promise<boolean>
  scheduleRestart(channelId: string, cwd: string): void
  isShuttingDown(): boolean
  getRoutes(): Record<string, string>
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: HealthCheckDeps | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let skippedTicks = 0

// ---------------------------------------------------------------------------
// initHealthCheck
// ---------------------------------------------------------------------------

export function initHealthCheck(d: HealthCheckDeps): void {
  deps = d
}

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

export function startHealthCheck(intervalSeconds: number): void {
  if (intervalSeconds === 0) return

  intervalId = setInterval(async () => {
    if (!deps) return
    if (deps.isShuttingDown()) return
    if (tickInFlight) {
      skippedTicks++
      // Fire exactly once when the streak crosses 5 (4 → 5 transition). At the
      // 120 s interval, five consecutive skips represents ~10 minutes of
      // tick-budget exhaustion — long enough to indicate genuine health-check
      // wedging (e.g., a persistently hung statRoute or isSessionAliveAdapter)
      // rather than transient slowness. Further skips within the same streak
      // are silent; the next successfully-started tick body resets the counter
      // and re-arms the warning for a future streak.
      if (skippedTicks === 5) {
        console.error('[slack] health-check: tick body in flight; skipped 5 consecutive ticks — investigate budget exhaustion')
      }
      return
    }
    tickInFlight = true
    skippedTicks = 0
    try {
      const routes = deps.getRoutes()

      for (const [channelId, cwd] of Object.entries(routes)) {
        try {
          if (deps.isRestartPendingOrActive(channelId)) continue

          if (await deps.statRoute(cwd)) {
            clearOutageFlag(channelId, 'cwd-unreachable')
          } else {
            setOutageFlag(channelId, 'cwd-unreachable', cwd)
          }

          const alive = await deps.isSessionAlive(channelId)
          if (!alive) {
            deps.scheduleRestart(channelId, cwd)
          }
        } catch (err) {
          console.error(`[slack] health-check: error checking channel=${channelId}:`, err)
        }
      }
    } finally {
      tickInFlight = false
    }
  }, intervalSeconds * 1000)
}

// ---------------------------------------------------------------------------
// stopHealthCheck
// ---------------------------------------------------------------------------

export function stopHealthCheck(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

// ---------------------------------------------------------------------------
// _resetHealthCheckState — exported for test cleanup
// ---------------------------------------------------------------------------

export function _resetHealthCheckState(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
  deps = null
  tickInFlight = false
  skippedTicks = 0
}
