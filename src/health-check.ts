/**
 * health-check.ts — Periodic liveness poller for managed Claude Code sessions.
 *
 * On each tick, checks every applied persona and schedules a restart if its
 * session is dead and not already pending/failed. The work list, the
 * disconnected streaks, every guard call and the `cwd-unreachable` flag are
 * keyed by persona key (b.av2 SR-6.3); log lines name it as `persona=<key>`.
 * Follows the same pattern as restart.ts: module-scoped state, injectable
 * deps, no server.ts imports.
 *
 * SPDX-License-Identifier: MIT
 */

import type { PersonaConfig } from './config.ts'
import { setOutageFlag, clearOutageFlag } from './outage-state.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health-check dependencies. Every `key` is a persona key. */
export interface HealthCheckDeps {
  isSessionAlive(key: string): Promise<boolean>
  /**
   * Returns true when the persona's MCP session is currently connected
   * (registry entry with `connected === true`). Used to catch the
   * alive-but-disconnected stranding (b.9a7): a row in an AD live state whose
   * MCP transport is gone is `isSessionAlive === true` but
   * `isSessionConnected === false`, and without this the tick would never act.
   * Wraps the `isSessionConnected` adapter that `main()` in src/server.ts
   * passes to `initHealthCheck` (registry entry with `connected === true`).
   */
  isSessionConnected(key: string): boolean
  /**
   * Returns true when the persona's session has its standalone GET SSE stream
   * (`_GET_stream`) present in the transport. A session can be
   * `isSessionConnected === true` while the SDK has silently dropped the stream
   * map entry (b.9cj); such a connected-but-streamless row cannot receive
   * messages and must be routed to recovery, so the tick treats it exactly like
   * the alive-but-disconnected case. Returns false when there is no session.
   */
  hasSessionStream(key: string): boolean
  isRestartPendingOrActive(key: string): boolean
  /**
   * Returns true when the persona has reached the consecutive-failure cap.
   * Capped personas are skipped on every tick (SR-25.3/25.4) — the tick
   * must not schedule more restarts once a cap has been signalled.
   * Inbound user messages do NOT re-arm recovery for a capped persona: a
   * capped-dead persona has no registered session, so inbound messages are
   * dropped before reaching scheduleRestart (see the no-live-session branch
   * of `handleMessage` in src/server.ts).
   * Recovery for such a persona comes from a server restart, which clears the
   * in-process backoff/cap state on boot.
   */
  isAtCap(key: string): boolean
  statRoute(cwd: string): Promise<boolean>
  /** `cwd` is the persona's working directory. */
  scheduleRestart(key: string, cwd: string): void
  isShuttingDown(): boolean
  /** The tick's work list: persona key → working directory (see `buildPersonaWorkList`). */
  getPersonas(): Record<string, string>
}

// ---------------------------------------------------------------------------
// buildPersonaWorkList
// ---------------------------------------------------------------------------

/**
 * The health check's work list for a persona config: one entry per persona,
 * mapping its key to its working directory, however many channels it lists.
 * Pure.
 */
export function buildPersonaWorkList(config: Pick<PersonaConfig, 'personas'>): Record<string, string> {
  return Object.fromEntries(config.personas.map((persona) => [persona.key, persona.working_directory]))
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: HealthCheckDeps | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let skippedTicks = 0

/**
 * Per-persona count of *consecutive* ticks that observed the persona as
 * alive-but-disconnected (b.9a7). We require this to reach 2 before scheduling
 * a reconnect.
 *
 * HAZARD 1 (ticket design decision 2) — freshly-launched false positive: a new
 * session takes seconds to boot and register its MCP connection, and
 * `activeLaunches` (the isRestartPendingOrActive skip) clears BEFORE the SSE
 * connection lands. A naive single-tick `!connected` check would fire
 * `/mcp reconnect` into a still-booting session. Requiring two consecutive
 * ticks (chosen over a post-launch grace window because it needs no launch
 * timestamp plumbed in from restart.ts, and resets cleanly through the seams
 * below) means a booting session that connects between ticks is never poked.
 *
 * This map leaks nothing across contexts because it is cleared:
 *   - the moment a persona is observed connected (streak reset inline below),
 *   - when a reconnect is scheduled for it (consumed on fire, below),
 *   - and wholesale by `_resetHealthCheckState` (the test-reset seam and the
 *     production stop path both call it).
 */
const disconnectedStreak = new Map<string, number>()

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
      const personas = deps.getPersonas()

      for (const [key, cwd] of Object.entries(personas)) {
        try {
          if (deps.isRestartPendingOrActive(key)) {
            // Clear any pending streak: "consecutive" means consecutive
            // *observed* ticks, not observations separated by an entire restart
            // cycle. A stale streak surviving across a restart could otherwise
            // poke a freshly-booting session — the exact false positive the
            // two-tick debounce exists to prevent.
            disconnectedStreak.delete(key)
            continue
          }

          // SR-25.3/25.4: skip capped personas — the tick must not re-schedule
          // restarts for personas that have reached the consecutive-failure cap.
          // The cap is not clearable from the inbound message path: a capped-dead
          // persona has no registered session, so inbound messages are dropped
          // (the no-live-session branch of `handleMessage` in src/server.ts) and
          // never reach scheduleRestart. The in-process cap/backoff state clears
          // only on a server restart.
          //
          // b.9a7 design decision 1 (DELIBERATE): this skip covers the new
          // alive-but-disconnected reconnect path too — a capped persona gets NO
          // tick-driven reconnect. The b.kvq user-facing reply promises a capped
          // persona "will NOT recover on its own — an operator must restart the
          // server"; a quiet tick-driven /mcp reconnect would contradict that.
          // Revisiting this (reconnects are far cheaper than relaunches) is a
          // separate decision — do not silently flip it here.
          if (deps.isAtCap(key)) {
            // A capped persona accumulating a disconnected streak is meaningless
            // state — the tick will not act on it. Clear it so a later, uncapped
            // observation starts a fresh consecutive count rather than inheriting
            // a streak carried across the cap window.
            disconnectedStreak.delete(key)
            console.error(`[slack] health-check: persona=${key} is at cap — skipping tick (SR-25.3/25.4)`)
            continue
          }

          if (await deps.statRoute(cwd)) {
            clearOutageFlag(key, 'cwd-unreachable')
          } else {
            setOutageFlag(key, 'cwd-unreachable', cwd)
          }

          const alive = await deps.isSessionAlive(key)

          // b.9a7: a persona can be alive (AD live state — pending, waiting,
          // working, ask_user, check_permission) yet have a dead MCP session.
          // `isSessionAlive` alone stays true for such a row, so the pre-b.9a7
          // tick (`if (!alive) scheduleRestart`) did nothing for it forever —
          // there was no time-bounded recovery. Route BOTH dead sessions and
          // alive-but-disconnected sessions through scheduleRestart; restart.ts
          // then does the right thing per case (alive+connected → no-op self-
          // heal, alive+disconnected → reconnectSession, dead → kill+relaunch).
          //
          // NOTE (b.4vj, larva): a future inbound-delivery retry driver will
          // also poke unreachable sessions. If it lands, reconcile the two poke
          // paths so they don't race on the same persona.
          if (!alive) {
            // Dead session: schedule immediately. The disconnected streak is
            // meaningless once the row is not alive, so drop it.
            disconnectedStreak.delete(key)
            deps.scheduleRestart(key, cwd)
          } else if (!deps.isSessionConnected(key) || !deps.hasSessionStream(key)) {
            // Alive but not deliverable: either MCP-disconnected (b.9a7) OR
            // connected-but-streamless — the SDK silently dropped the
            // `_GET_stream` map entry so messages cannot reach the bot (b.9cj).
            // Both land here and share the SAME two-consecutive-tick guard:
            // HAZARD 1 — a session between registerSession and its stream
            // re-opening is legitimately streamless for a moment and must not be
            // poked mid-boot. Require two CONSECUTIVE ticks before acting (see
            // disconnectedStreak doc comment). scheduleRestart then does the
            // right thing per case — reconnect a disconnected row, or recover a
            // streamless one (restart.ts:155 no longer waves the latter through).
            const streak = (disconnectedStreak.get(key) ?? 0) + 1
            if (streak >= 2) {
              disconnectedStreak.delete(key)
              deps.scheduleRestart(key, cwd)
            } else {
              disconnectedStreak.set(key, streak)
            }
          } else {
            // Alive, connected, AND stream present — healthy. Reset any pending
            // streak so a transient one-tick blip never accumulates toward the
            // threshold.
            disconnectedStreak.delete(key)
          }
        } catch (err) {
          console.error(`[slack] health-check: error checking persona=${key}:`, err)
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
  disconnectedStreak.clear()
}
