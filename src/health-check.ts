/**
 * health-check.ts — Periodic liveness poller for managed Claude Code sessions.
 *
 * On each tick, checks every applied persona and schedules a restart if its
 * session reads `dead` and is not already pending/failed. The liveness probe
 * answers one of four readings (b.jg5 SRJ-314): only `dead` schedules the
 * kill-and-launch path at once; `live` and `pending` take the alive branches,
 * but only `live` is ever counted healthy: a `pending` row connected with its
 * stream takes the not-deliverable path (its session has not started, and the
 * restart run it schedules defers it); `unknown` (a `status` error, or a
 * probe that threw) skips the persona for the tick, with nothing scheduled or
 * posted, and arms no retry timer. With auto-restart disabled,
 * an alive persona it would reconnect is reported through the not-connected
 * notice instead of being left down silently (b.f2b). The work list, the
 * disconnected streaks, every guard call and the `cwd-unreachable` flag are
 * keyed by persona key (b.av2 SR-6.3); log lines name it as `persona=<key>`.
 * The healthy branch (`live`, connected, stream present) is the tick's only
 * clear of the persona's `tmux-unavailable` outage (b.jg5 SRJ-312), with the
 * `live` reading passed on to the cleared-flag observer; the liveness read
 * itself never clears it. It also resets the persona's slow-recovery count
 * (b.jg5 SRJ-610).
 * A persona with a restart pending or active, or at the cap, is skipped
 * before any read. The cap is asked again right after the liveness read
 * (b.4q8): that read can settle the persona's resumed launch as ended before
 * reporting in, a counted failure that may reach the cap, and a persona it
 * took to the cap is skipped the same way, with nothing scheduled.
 * A persona with a no-attempt reason (`noAttemptReason`:
 * it is latched, b.jg5 SRJ-502; it is held on `ErrInvalidFlags`, b.jg5
 * SRJ-207; work in flight for it; or its `tmux-unavailable` outage raised;
 * b.jg5 SRJ-315, SRJ-311) is still read: the working-directory check runs, and its
 * liveness, connection and stream are read, so a healthy one takes the
 * healthy branch. Any other reading clears its streak, with no
 * `scheduleRestart` and no not-connected notice: the tick makes no attempt
 * of its own for it. When that reason is `tmux-unavailable` and the persona
 * has no retry timer (`isRetryArmed`), the tick arms one (`armRetryTimer`,
 * the ENVIRONMENT cause), so the outage's retry is still its attempt.
 * Follows the same pattern as restart.ts: module-scoped state, injectable
 * deps, no server.ts imports.
 *
 * SPDX-License-Identifier: MIT
 */

import type { PersonaConfig } from './config.ts'
import { setOutageFlag, clearOutageFlag, getOutageFlags } from './outage-state.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import {
  LIVENESS_DEAD,
  LIVENESS_LIVE,
  LIVENESS_PENDING,
  LIVENESS_UNKNOWN,
  livenessKindOf,
  type LivenessKind,
  type LivenessReading,
} from './liveness-reading.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health-check dependencies. Every `key` is a persona key. */
export interface HealthCheckDeps {
  /**
   * The persona's liveness reading (b.jg5 SRJ-314, `src/liveness-reading.ts`):
   * `live`, `pending`, `dead` or `unknown`. `dead` schedules the restart at
   * once; `live` and `pending` take the alive branches, and only `live` is
   * counted healthy (a `pending` row connected with its stream takes the
   * not-deliverable path, with no not-connected notice); `unknown`, a probe
   * that throws and an answer that is not a reading skip the persona for this
   * tick.
   */
  isSessionAlive(key: string): Promise<LivenessReading>
  /**
   * Returns true when the persona's MCP session is currently connected
   * (registry entry with `connected === true`). Used to catch the
   * alive-but-disconnected stranding (b.9a7): a row in an AD live state whose
   * MCP transport is gone reads alive (`live` or `pending`) but
   * `isSessionConnected === false`, and without this the tick would never act.
   * Wraps the `isSessionConnected` adapter that `main()` in src/server.ts
   * passes to `initHealthCheck` (registry entry with `connected === true`).
   */
  isSessionConnected(key: string): boolean

  /** b.omv SR-7.6: inspect even connected rows; true defers ordinary health recovery. */
  inspectUpgrade?(key: string): Promise<boolean>
  isReconnectDeferred?(key: string): boolean
  isRestartPendingOrActive(key: string): boolean
  /**
   * True while lifecycle work owns the persona (a launch, live-row sequence
   * or old-life wait). Health reads still run, but recovery and notices wait
   * for that work. Absent: nothing is in flight.
   */
  isLaunchInFlight?(key: string): boolean
  /**
   * b.jg5 SRJ-315, SRJ-502: true while the persona is latched (production:
   * the server's latch's `isLatched`). A no-attempt reason, checked first:
   * the tick still runs the working-directory check and reads the persona's
   * liveness, connection and a healthy one takes the healthy
   * branch, but for any other reading it never calls `scheduleRestart`,
   * `notifyNotConnected` or `armRetryTimer` for it. Only an answer of exactly
   * `true` is latched; a throw ends the persona's work for the tick (logged),
   * before any read. Absent: no persona is latched.
   */
  isLatched?(key: string): boolean
  /**
   * b.jg5 SRJ-315, SRJ-207: true while the persona is held on
   * `ErrInvalidFlags` (production: the server's hold's `isHeld`). A
   * no-attempt reason, checked right after `isLatched`: the tick still runs
   * the working-directory check and reads the persona's liveness and connection,
   * and a healthy one takes the healthy branch, but for any other
   * reading (`dead`, `pending`, disconnected) it never calls
   * `scheduleRestart`, `notifyNotConnected` or `armRetryTimer` for it. Only an
   * answer of exactly `true` is held; a throw ends the persona's work for the
   * tick (logged), before any read. Absent: no persona is held.
   */
  isHeld?(key: string): boolean
  /**
   * b.jg5 SRJ-311: true while the persona has a retry timer, waiting or
   * running (production: the retry controller's `isArmed`). Read only for a
   * persona whose no-attempt reason is `tmux-unavailable` and that the tick
   * read but did not find healthy: a raised outage does not guarantee a
   * timer (a retry that stopped as not up, on a declined launch or on a
   * failed run leaves the flag raised), and with none armed nothing would
   * ever attempt for it. Only an answer of exactly `false` lets the tick call
   * `armRetryTimer`. Absent: the tick arms nothing.
   */
  isRetryArmed?(key: string): boolean
  /**
   * b.jg5 SRJ-311: arm the persona's retry timer with the ENVIRONMENT cause
   * (production: the retry controller's `arm` with
   * `UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT`), called when `isRetryArmed`
   * answers false for a persona the tick holds off on for `tmux-unavailable`
   * and did not find healthy. The tick still makes no attempt of its own:
   * the timer's retry is the persona's attempt, and its stop checks end it,
   * with no agent-director call, for a persona that is not up, not applied
   * or at the cap. Absent: nothing is armed.
   */
  armRetryTimer?(key: string): void
  /**
   * b.f2b: true when auto-restart is disabled (`session_restart_delay` 0).
   * `scheduleRestart` then does nothing, so an alive persona the tick finds
   * not deliverable on two consecutive ticks is also reported through
   * `notifyNotConnected` rather than left down silently. Absent: false.
   */
  isAutoRestartDisabled?(): boolean
  /**
   * b.f2b: raise the persona's not-connected notice (production:
   * `notifyDisconnectedWithAutoRestartDisabled`, once per episode), worded
   * for `cause`: its MCP session is not connected (`disconnected`). The episode
   * ends when its MCP session registers again, when the tick finds it
   * deliverable again (`endNotConnectedEpisode`) or when it is torn down.
   */
  notifyNotConnected?(key: string, cause: 'disconnected'): void
  /**
   * b.f2b: end the persona's not-connected episode (production:
   * `forgetNotConnectedEpisode`), called on every tick that finds it alive,
   * connected and with its stream: a later episode is reported again.
   * Absent: nothing is called.
   */
  endNotConnectedEpisode?(key: string): void
  /**
   * b.jg5 SRJ-610: reset the persona's slow-recovery count (production: the
   * slow-recovery tracker's `noteHealthy`), called on every tick that finds
   * it `live` (never `pending`), connected and with its stream, so a persona
   * that healed on its own starts a later count from 0. An open slow-recovery
   * episode is left open. Called after the tick's other healthy-branch calls;
   * a throw is the persona's error for the tick (logged). Absent: nothing is
   * called.
   */
  resetSlowRecoveryCount?(key: string): void
  /**
   * b.jg5 SRJ-310 rule 2 (tick half): end the persona's `tmux-unresponsive`
   * condition (production: the condition's end, reason `tick`, with the
   * tick's `live` reading), called on every tick that finds it `live`
   * (never `pending`), connected. A condition that does
   * not hold is left alone by the callee. A `pending`, `unknown` or `dead`
   * reading, and a disconnected session, never call it.
   * Absent: nothing is called.
   */
  endTmuxUnresponsive?(key: string): void
  /**
   * b.jg5 SRJ-308: called once when each tick body ends, after all of the
   * tick's per-persona work, with the tick's start time from `now`
   * (production: the `tmux-unresponsive` condition's `onsetAtTick`, which
   * makes no agent-director call and checks every condition still holding
   * whose first refusal precedes that time, so a persona the tick skipped or
   * left out is still checked, and one the tick found healthy has already
   * ended its condition). It is called however the body ends: a persona's
   * work that throws, or a body that exits early, still calls it (a
   * `finally`). A skipped tick (a body still in flight, or shutting down)
   * does not call it, nor does a tick whose start time could not be read; a
   * shutdown that begins during a tick still calls it at that tick's end,
   * which is harmless because `close()` empties the open conditions. A
   * throw is logged and never breaks the tick. Absent: nothing is called.
   */
  onTickEnd?(tickStartedAt: number): void
  /**
   * b.jg5 SRJ-308: the clock a tick's start time is read from, the one the
   * `onTickEnd` callee compares first-refusal times against (production: the
   * notice episodes' clock). Read once per tick body, as the body starts.
   * Absent: the system clock (`Date.now`).
   */
  now?(): number
  /**
   * Returns true when the persona has reached the consecutive-failure cap.
   * Capped personas are skipped on every tick (SR-25.3/25.4) — the tick
   * must not schedule more restarts once a cap has been signalled.
   * Inbound user messages do NOT re-arm recovery for a capped persona: a
   * capped-dead persona has no registered session, so inbound messages are
   * dropped before reaching scheduleRestart (see the lost-message branch
   * in src/persona-routing.ts, which checks the cap itself).
   * Recovery for such a persona comes from a server restart, which clears the
   * in-process backoff/cap state on boot.
   * Asked before any read and again right after the tick's liveness read
   * (b.4q8: that read may count a resumed launch that ended before reporting
   * in, reaching the cap); either answer of true skips the persona.
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
 * With `include`, only the personas it accepts (the server passes the
 * relaunch gate, so a persona whose Slack connection is not serving is left
 * out of the tick). Pure apart from what `include` does.
 */
export function buildPersonaWorkList(
  config: Pick<PersonaConfig, 'personas'>,
  include?: (key: string) => boolean,
): Record<string, string> {
  return Object.fromEntries(
    config.personas
      .filter((persona) => include === undefined || include(persona.key))
      .map((persona) => [persona.key, persona.working_directory]),
  )
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
 *   - when a tick skips it: pending/active restart, at cap, a liveness
 *     reading of `unknown` or a probe that threw (b.jg5 SRJ-314), or left out
 *     of the tick's work list by the relaunch gate,
 *   - when a tick that has a no-attempt reason for it (`noAttemptReason`:
 *     latched, b.jg5 SRJ-502; held on `ErrInvalidFlags`, b.jg5 SRJ-207; work
 *     in flight, b.f2b; or `tmux-unavailable` raised, b.jg5 SRJ-315) reads
 *     it anything but healthy: the tick makes
 *     no attempt for it, and a human, the work in flight or the outage's
 *     retry owns it meanwhile,
 *   - by `forgetDisconnectedStreak` when the persona is torn down,
 *   - and wholesale by `_resetHealthCheckState` (the test-reset seam and the
 *     production stop path both call it).
 */
const disconnectedStreak = new Map<string, number>()

// ---------------------------------------------------------------------------
// noAttemptReason
// ---------------------------------------------------------------------------

/**
 * Why the tick makes no attempt of its own for a persona this tick (b.jg5
 * SRJ-315): `latched`, the persona is latched (`isLatched`, b.jg5 SRJ-502:
 * a human decides, so no automated attempt is made, and with no retry timer
 * armed for it none is armed here either), `held`, the persona is held on
 * `ErrInvalidFlags` (`isHeld`, b.jg5 SRJ-207: nothing is launched for it until
 * the binary changes, the server restarts or it is torn down, and its hold
 * stopped its retry timer, so none is armed here), `in-flight`, work in
 * flight for it (`isLaunchInFlight`), or
 * `tmux-unavailable`, its `tmux-unavailable` outage raised (b.jg5 SRJ-311:
 * its retry timer is then its only attempt, one per backoff interval; a tick
 * that finds it not healthy with no timer armed arms one,
 * `armMissingRetryTimer`). A
 * new reason is one more member here and one more check in
 * `noAttemptReason`.
 */
type NoAttemptReason = 'latched' | 'held' | 'in-flight' | 'tmux-unavailable'

/**
 * The persona's no-attempt reason for this tick, the first that holds, or
 * `null` when the tick may attempt. Decided once per persona per tick,
 * before any read; only `latched` is asked again after the tick's liveness
 * read (`latchedAfterRead`), since that read may latch the persona. A throw
 * from a dep propagates (the per-persona `catch` logs it and ends the
 * persona's work for the tick).
 */
function noAttemptReason(d: HealthCheckDeps, key: string): NoAttemptReason | null {
  if (d.isLatched?.(key) === true) return 'latched'
  if (d.isHeld?.(key) === true) return 'held'
  if (d.isLaunchInFlight?.(key) === true) return 'in-flight'
  if (getOutageFlags(key).has('tmux-unavailable')) return 'tmux-unavailable'
  return null
}

/**
 * The tick's skip line for persona `key` at the restart cap (SR-25.3/25.4):
 * logged when the cap is met before the persona's reads, and when the tick's
 * own liveness read took it to the cap (b.4q8). Pure.
 *
 *   [slack] health-check: persona=<key> is at cap — skipping tick (SR-25.3/25.4)
 */
export function healthCheckAtCapSkipLine(key: string): string {
  return `[slack] health-check: persona=${key} is at cap — skipping tick (SR-25.3/25.4)`
}

/**
 * The latched no-attempt reason asked again after the tick's liveness read
 * (b.jg5 SRJ-502, SRJ-512, SRJ-513): true when `isLatched` answers exactly `true`,
 * since the read itself may have latched the persona. A throw propagates, as
 * from `noAttemptReason` (the per-persona `catch` logs it and ends the
 * persona's work for the tick).
 */
function latchedAfterRead(d: HealthCheckDeps, key: string): boolean {
  return d.isLatched?.(key) === true
}

/**
 * b.jg5 SRJ-311: for a persona held off on `tmux-unavailable` that the tick
 * did not find healthy, arm its retry timer with the ENVIRONMENT cause when
 * it has none (`isRetryArmed` answers exactly false), with one line saying
 * so. A retry that stopped while the flag stayed raised (not up, a declined
 * launch, a failed run) leaves the persona with no attempt at all otherwise.
 * The tick schedules nothing and posts nothing for it. Called only for a
 * persona in the tick's work list (applied and up), never capped, with no
 * restart pending or active, so at most once per tick per persona. The tick
 * decided its no-attempt reason before awaiting its reads, so the reasons
 * are checked again here, at arm time: nothing is armed unless the reason
 * is still `tmux-unavailable` (the flag may have cleared during those
 * awaits, by a teardown or a real clear, or work may now be in flight), and
 * only while no timer is armed. A timer armed here that then finds the
 * persona not up or capped stops at its first retry with no agent-director
 * call. A throw propagates, as it does from the tick's own check (the
 * per-persona `catch` logs it), so nothing is armed.
 */
function armMissingRetryTimer(d: HealthCheckDeps, key: string): void {
  if (d.armRetryTimer === undefined) return
  if (noAttemptReason(d, key) !== 'tmux-unavailable') return
  if (d.isRetryArmed?.(key) !== false) return
  console.error(`[slack] health-check: persona=${key} has its tmux-unavailable outage raised with no retry timer — arming one`)
  d.armRetryTimer(key)
}

// ---------------------------------------------------------------------------
// initHealthCheck
// ---------------------------------------------------------------------------

export function initHealthCheck(d: HealthCheckDeps): void {
  deps = d
}

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

/**
 * Start the tick: every `intervalSeconds` seconds, one run of the tick body
 * (`runHealthCheckTick`). 0 starts nothing.
 */
export function startHealthCheck(intervalSeconds: number): void {
  if (intervalSeconds === 0) return

  // The callback returns the tick body's promise.
  intervalId = setInterval(() => runHealthCheckTick(), intervalSeconds * 1000)
}

/**
 * Test-only seam: run exactly one tick body (`runHealthCheckTick`) with the
 * deps `initHealthCheck` installed, with no interval armed, and resolve once
 * it has finished. The body is the one the interval runs, with the same
 * guards: nothing runs with no deps or while shutting down, and a body still
 * in flight makes this one a skipped tick.
 */
export function _runHealthCheckTickForTest(): Promise<void> {
  return runHealthCheckTick()
}

/**
 * One tick body (see the module comment): skipped with no deps, while
 * shutting down, or while the previous body is still in flight (the overlap
 * guard, which warns once a streak of skips reaches 5). A throw from the
 * persona work, the work list or the tick-end hook is logged, never
 * rethrown.
 */
async function runHealthCheckTick(): Promise<void> {
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
  // b.jg5 SRJ-308: the tick's start time, read before any of its work; the
  // tick-end hook gets it once the body ends, however it ends. The deps are
  // captured once so the hook that runs is the one whose clock was read,
  // even if `initHealthCheck` swaps the deps mid-tick.
  const tickDeps = deps
  const tickStartedAt = readTickStart(tickDeps)
  try {
    const personas = deps.getPersonas()

    // A persona the relaunch gate left out of this tick's work list (not up)
    // is a third skip, beside pending-restart and cap: drop its streak the
    // same way, so a persona that comes back up starts a fresh consecutive
    // count instead of inheriting one observation from before it went down.
    for (const key of disconnectedStreak.keys()) {
      if (!Object.hasOwn(personas, key)) disconnectedStreak.delete(key)
    }

    for (const [key, cwd] of Object.entries(personas)) {
      try {
        // A restart pending or active owns the session: skip before any read.
        // (Work in flight is not this skip: it is a no-attempt reason below,
        // and the persona is still read; b.jg5 SRJ-315.)
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
        // (the lost-message branch in src/persona-routing.ts, which checks the
        // cap itself) and never reach scheduleRestart. The in-process cap/backoff state clears
        // only on a server restart.
        //
        // b.9a7 design decision 1 (DELIBERATE): this skip covers the new
        // alive-but-disconnected reconnect path too — a capped persona gets NO
        // tick-driven reconnect. The lost-message notice at the persona's
        // destination reports a capped persona as "restart limit reached":
        // automatic restarts are suspended and the operator must restart the
        // server; a quiet tick-driven /mcp reconnect would contradict that.
        // Revisiting this (reconnects are far cheaper than relaunches) is a
        // separate decision — do not silently flip it here.
        if (deps.isAtCap(key)) {
          // A capped persona accumulating a disconnected streak is meaningless
          // state — the tick will not act on it. Clear it so a later, uncapped
          // observation starts a fresh consecutive count rather than inheriting
          // a streak carried across the cap window.
          disconnectedStreak.delete(key)
          console.error(healthCheckAtCapSkipLine(key))
          continue
        }

        // b.jg5 SRJ-315: decided once, before any read. With a reason (the
        // persona latched, which a human decides, SRJ-502; held on
        // ErrInvalidFlags until the binary changes, SRJ-207; work in flight,
        // which owns the session and whose wait reconnects or reports it,
        // b.f2b; or `tmux-unavailable` raised, whose retry timer is the
        // persona's only attempt, SRJ-311), the persona is still
        // read below, so one that recovered on its own takes the healthy
        // branch (clearing the outage and ending `tmux-unresponsive`), but
        // the tick schedules nothing and posts no not-connected notice.
        let reason = noAttemptReason(deps, key)

        if (await deps.statRoute(cwd)) {
          clearOutageFlag(key, 'cwd-unreachable')
        } else {
          setOutageFlag(key, 'cwd-unreachable', cwd)
        }

        // b.jg5 SRJ-314: the probe answers a reading. `unknown` (a `status`
        // error agent-director could not answer, or a probe that threw) is
        // never read as dead: the persona is skipped this tick, with no
        // restart scheduled, nothing posted and no episode ended. Its
        // streak is cleared, as every skip clears it. The tick arms no
        // retry timer.
        let reading: LivenessKind
        let failure = ''
        try {
          reading = livenessKindOf(await deps.isSessionAlive(key))
        } catch (err) {
          reading = LIVENESS_UNKNOWN
          failure = ` (isSessionAlive failed: ${describeThrownValue(err)})`
        }
        // b.jg5 SRJ-502, SRJ-512, SRJ-513: the tick's own liveness read may
        // have latched the persona (an UNUSABLE NAME answer, or its own row
        // reading `pending` with no launch start); its latched
        // no-attempt reason is asked again after the read, so the tick
        // schedules nothing for it.
        if (reason !== 'latched' && latchedAfterRead(deps, key)) reason = 'latched'
        // b.4q8: the read may have settled the persona's resumed launch as
        // ended before reporting in, a counted failure that can reach the cap
        // (with its cap notice, its retry timer stopped). The cap is asked
        // again, so a persona the read took to the cap is skipped as one met
        // at the cap above is: no restart is scheduled for it.
        if (deps.isAtCap(key)) {
          disconnectedStreak.delete(key)
          console.error(healthCheckAtCapSkipLine(key))
          continue
        }
        const holdOff = reason !== null
        if (reading === LIVENESS_UNKNOWN) {
          disconnectedStreak.delete(key)
          console.error(`[slack] health-check: liveness unknown for persona=${key}${failure} — skipping it this tick; not read as dead`)
          continue
        }
        // b.omv SR-7.6: an old connected bot still needs provenance inspection.
        if (!holdOff && reading !== LIVENESS_DEAD && await deps.inspectUpgrade?.(key)) {
          disconnectedStreak.delete(key)
          continue
        }
        // `live` and `pending` take the alive branches below; only `live`
        // is ever counted healthy (b.jg5 SRJ-314).
        const alive = reading !== LIVENESS_DEAD
        const pending = reading === LIVENESS_PENDING

        // b.9a7: a persona can be alive (AD live state — pending, waiting,
        // working, ask_user, check_permission) yet have a dead MCP session.
        // `isSessionAlive` alone reads `live` or `pending` for such a row,
        // so the pre-b.9a7 tick (`if (!alive) scheduleRestart`) did nothing
        // for it forever —
        // there was no time-bounded recovery. Route BOTH dead sessions and
        // alive-but-disconnected sessions through scheduleRestart; restart.ts
        // then does the right thing per case (live+connected → no-op self-
        // heal, live+disconnected → reconnectSession, pending → the
        // `pending` deferral, dead → kill+relaunch).
        //
        // NOTE (b.4vj): a future inbound-delivery retry driver will
        // also poke unreachable sessions. If it lands, reconcile the two poke
        // paths so they don't race on the same persona.
        // (Read once: b.f2b words the delay-0 notice by it.)
        const connected = alive && deps.isSessionConnected(key)
        const deliverable = connected
        if (holdOff && (!alive || !deliverable || pending)) {
          // b.jg5 SRJ-315: a no-attempt reason holds and the persona is not
          // healthy (`dead`, `pending`, disconnected): no
          // `scheduleRestart`, and no not-connected notice, which only
          // accompanies an attempt. Drop the streak, as every skip does, so
          // a later attempt starts a fresh two-tick count. With
          // `tmux-unavailable` and no retry timer armed, arm one.
          disconnectedStreak.delete(key)
          // b.jg5 SRJ-311: the outage's retry timer is the persona's only
          // attempt, but a raised flag does not guarantee one is armed.
          if (reason === 'tmux-unavailable') armMissingRetryTimer(deps, key)
        } else if (!alive) {
          // Dead session: schedule immediately. The disconnected streak is
          // meaningless once the row is not alive, so drop it.
          disconnectedStreak.delete(key)
          deps.scheduleRestart(key, cwd)
        } else if (!deliverable || pending) {
          // b.omv SR-9: disconnected and pending rows share the existing
          // two-consecutive-tick debounce. A pending row is never healthy.
          const streak = (disconnectedStreak.get(key) ?? 0) + 1
          if (streak >= 2) {
            disconnectedStreak.delete(key)
            deps.scheduleRestart(key, cwd)
            // b.f2b: with auto-restart disabled scheduleRestart only logs and
            // returns, so nothing would reconnect this persona: report it
            // (the notice is raised once per episode), worded for why it is
            // disconnected. A connected pending row gets no notice.
            if (!deliverable && deps.isAutoRestartDisabled?.() === true && !deps.isReconnectDeferred?.(key)) {
              deps.notifyNotConnected?.(key, 'disconnected')
            }
          } else {
            disconnectedStreak.set(key, streak)
          }
        } else {
          // `live` and connected — healthy (b.omv SR-9). Reset any pending
          // streak so a transient one-tick blip never accumulates toward the
          // threshold. b.f2b: its not-connected episode, if any, is over.
          // b.jg5 SRJ-310: so is its tmux-unresponsive condition, if it holds.
          // b.jg5 SRJ-311, SRJ-312: a healthy check is the one tick
          // observation that clears `tmux-unavailable` (with its single
          // all-clear when that empties the persona's flags), carrying the
          // tick's `live` reading so the retry timer's stop sees a row live
          // out of `pending`. No other reading or disconnected session clears it.
          disconnectedStreak.delete(key)
          deps.endNotConnectedEpisode?.(key)
          deps.endTmuxUnresponsive?.(key)
          clearOutageFlag(key, 'tmux-unavailable', LIVENESS_LIVE)
          // b.jg5 SRJ-610: a persona healthy on its own resets its
          // slow-recovery count; its episode, if open, stays open.
          deps.resetSlowRecoveryCount?.(key)
        }
      } catch (err) {
        console.error(`[slack] health-check: error checking persona=${key}: ${describeThrownValue(err)}`)
      }
    }
  } catch (err) {
    // A throw outside the per-persona work (e.g. `getPersonas`) ends the
    // tick here: logged, never rethrown, so no unhandled rejection escapes
    // the interval callback.
    console.error(`[slack] health-check: the tick failed: ${describeThrownValue(err)}`)
  } finally {
    // b.jg5 SRJ-308: the onset check runs once the tick's per-persona work
    // is done, however the body ended (never throws).
    runTickEndHook(tickDeps, tickStartedAt)
    tickInFlight = false
  }
}

/** The tick's start time from `d.now` (the system clock when absent); a throwing clock is logged and reads as none. */
function readTickStart(d: HealthCheckDeps): number | undefined {
  try {
    return d.now === undefined ? Date.now() : d.now()
  } catch (err) {
    console.error(`[slack] health-check: the tick's start time could not be read: ${describeThrownValue(err)} — no tick-end hook this tick`)
    return undefined
  }
}

/** Call the tick-end hook of the deps the tick started with, passing the tick's start time. Never throws: a throw is logged. */
function runTickEndHook(d: HealthCheckDeps, tickStartedAt: number | undefined): void {
  if (tickStartedAt === undefined) return
  try {
    d.onTickEnd?.(tickStartedAt)
  } catch (err) {
    console.error(`[slack] health-check: the tick-end hook failed: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// stopHealthCheck
// ---------------------------------------------------------------------------

/**
 * Forget persona `key`'s disconnected streak (b.av2 SR-6.5, a teardown). A
 * persona gone from the work list loses it at the next tick anyway; this
 * drops it at once. Other personas' streaks are untouched; logs nothing.
 */
export function forgetDisconnectedStreak(key: string): void {
  disconnectedStreak.delete(key)
}

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
