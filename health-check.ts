/**
 * health-check.ts — Periodic liveness poller for managed Claude Code sessions.
 *
 * On each tick, checks every configured route and schedules a restart if the
 * session is dead and not already pending/failed. Follows the same pattern as
 * restart.ts: module-scoped state, injectable deps, no server.ts imports.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheckDeps {
  isSessionAlive(channelId: string): Promise<boolean>
  isRestartPendingOrActive(channelId: string): boolean
  hasReachedMaxFailures(channelId: string): boolean
  scheduleRestart(channelId: string, cwd: string): void
  isShuttingDown(): boolean
  getRoutes(): Record<string, string>
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: HealthCheckDeps | null = null
let intervalId: ReturnType<typeof setInterval> | null = null

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

    const routes = deps.getRoutes()

    for (const [channelId, cwd] of Object.entries(routes)) {
      try {
        if (deps.isRestartPendingOrActive(channelId)) continue
        if (deps.hasReachedMaxFailures(channelId)) continue

        const alive = await deps.isSessionAlive(channelId)
        if (!alive) {
          deps.scheduleRestart(channelId, cwd)
        }
      } catch (err) {
        console.error(`[slack] health-check: error checking channel=${channelId}:`, err)
      }
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
}
