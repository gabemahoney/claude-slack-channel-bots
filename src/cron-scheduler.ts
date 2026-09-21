/**
 * cron-scheduler.ts — The once-per-minute dispatch tick (Task 3 on b.he5;
 * decision 8, D-Q3, PD-4 on b.grx / t2.he5.eu.4q).
 *
 * `createCronScheduler(deps)` returns a handle whose single self-re-arming
 * timer is the ONLY code path that dispatches cron schedules (decision 8). It
 * loads the crontable exactly once at start(), matches the in-memory schedules
 * against the current wall-clock minute in server-local time, and hands every
 * non-duplicate match for a minute to the dispatcher's group entry point in one
 * call. There are NO per-job timers, ever — a single minute-aligned setTimeout
 * chain re-arms itself after each pass.
 *
 * Why a self-re-arming setTimeout chain and NOT setInterval: ticks must be
 * serialized (a pass never overlaps the next) so that E3's future crontable
 * hot-reload — which lands at the marked no-op insertion point at the top of
 * the tick body — mutates the in-memory table between whole passes, never
 * mid-pass. setInterval cannot guarantee that.
 *
 * At-most-once is a LOGGED ASSERTION, not the mechanism (decision 8): the
 * minute-aligned single-pass loop already makes a double-fire structurally
 * impossible; the Map<raw line, epoch minute> exists only to catch a scheduler
 * BUG and shout about it. A would-be duplicate is skipped and logged loudly.
 *
 * Pinned behaviors (do not "fix"):
 *   - Monotonic guard: a pass whose observed minute <= the last-ticked minute
 *     is skipped whole. A backwards clock jump must not re-fire already-fired
 *     minutes (matches Vixie cron's wait-for-catch-up).
 *   - No catch-up (PD-4): a tick fires only the minute observed at its start;
 *     if a pass overruns the next minute top, that minute is simply skipped.
 *   - A minute with no matches does nothing and logs NOTHING.
 *   - NO rate cap, NO fires-per-hour/backlog cap, NO busy-detection, NO
 *     session-state or queue-depth check, NO throttle of any kind (owner gate
 *     answers 1-2). The operator wrote the line; it means what it says.
 *
 * start() is failure-isolated — it reports/logs every error without throwing
 * out to the caller, so a bad crontable can never crash the server.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'

import { Cron } from 'croner'

import { ensureCrontableExists } from './cron-bootstrap.ts'
import { parseCrontable, type CronSchedule } from './crontable.ts'
import type { CronLog } from './cron-log.ts'
import type { CronDispatcher } from './cron-dispatch.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds in one minute — the tick period and the match-window width. */
const MINUTE_MS = 60_000

/** Sentinel for a log field with no channel/identity (parse-error lines). */
const NO_FIELD = '-'

// ---------------------------------------------------------------------------
// Clock seam
// ---------------------------------------------------------------------------

/**
 * The injectable clock. Defaults to the real ones. Tests supply a controllable
 * `now()` plus fake setTimeout/clearTimeout so ticks can be driven with
 * synthetic times and the direct `tick` seam — never by sleeping.
 */
export interface SchedulerClock {
  now(): Date
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const REAL_CLOCK: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** Constructor dependencies for the scheduler. */
export interface CronSchedulerDeps {
  /** The dispatcher (Task 2) — its group entry point is the only fire path. */
  dispatcher: CronDispatcher
  /** The cron-log writer handle (Task 1). */
  cronLog: CronLog
  /** Path to the crontable file (read once at start; bootstrapped if absent). */
  cronTablePath: string
  /** Optional clock override (defaults to real now()/setTimeout/clearTimeout). */
  clock?: SchedulerClock
}

/**
 * The scheduler handle. SINGLE-USE: a handle runs at most one start()→stop()
 * lifecycle. stop() does not re-open it — start() never resets `stopped`, so a
 * stop() then start() would arm at most one tick and then die silently. To
 * restart, construct a NEW scheduler. Calling start() twice, or start() after
 * stop(), is a loud no-op (a `[slack] cron-scheduler` console.error), never a
 * silent one. The current server wiring starts once and stops once at shutdown,
 * so this is documented, not designed around.
 */
export interface CronScheduler {
  /**
   * Bootstrap + load + arm the tick. Failure-isolated: never throws. May be
   * called at most ONCE per handle (see the single-use note above); a second
   * call, or a call after stop(), is a logged no-op.
   */
  start(): void
  /**
   * Cancel the pending tick. Idempotent (stopHealthCheck convention). Does NOT
   * re-open the handle for a later start() — the scheduler is single-use.
   */
  stop(): void
  /**
   * Run exactly one tick pass now (async). A directly callable seam for tests;
   * production arms it via the timer chain. Never throws.
   */
  tick(): Promise<void>
}

// ---------------------------------------------------------------------------
// Compiled schedule — parsed line paired with its croner matcher
// ---------------------------------------------------------------------------

/**
 * A loaded schedule and its compiled croner pattern. The pattern is built ONCE
 * at start() (never per tick) and is only ever queried, never started — no
 * callback is supplied, so it schedules nothing on its own.
 */
interface CompiledSchedule {
  schedule: CronSchedule
  cron: Cron
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the cron scheduler. See the module header for the pinned behaviors.
 */
export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { dispatcher, cronLog, cronTablePath } = deps
  const clock = deps.clock ?? REAL_CLOCK

  // In-memory table, loaded once at start(), in crontable line order.
  let compiled: CompiledSchedule[] = []

  // At-most-once bookkeeping: raw line text → epoch minute it last fired in.
  // In-memory only, pruned every tick. A LOGGED ASSERTION (decision 8), not the
  // dispatch mechanism.
  const firedAtMinute = new Map<string, number>()

  // The single pending timer, and the last minute a pass actually processed
  // (the monotonic guard's high-water mark). -Infinity so the first observed
  // minute always passes the guard.
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastTickedMinute = Number.NEGATIVE_INFINITY

  // stop() sets this to true so a pass in flight does not re-arm after we
  // cancel. Once true it is never cleared — the handle is single-use.
  let stopped = false
  // start() sets this so a second start() (or a start() after stop()) is a
  // loud no-op rather than a silently dead second arm.
  let started = false

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  function start(): void {
    // The handle is SINGLE-USE (see the CronScheduler interface docs): start()
    // does not reset `stopped`, so a stop()→start() sequence would arm at most
    // one tick and then die silently. Reject re-entry loudly instead; to
    // restart, construct a fresh scheduler.
    if (started) {
      console.error('[slack] cron-scheduler: start() called more than once — ignoring (handle is single-use; construct a new scheduler to restart)')
      return
    }
    if (stopped) {
      console.error('[slack] cron-scheduler: start() called after stop() — ignoring (handle is single-use; construct a new scheduler to restart)')
      return
    }
    started = true
    try {
      // (1) Bootstrap FIRST — this start() is the ONLY caller of ensure-exists
      // (server wiring removed its own call per PM review). A missing crontable
      // is created rather than surfacing as a read error below.
      const bootstrap = ensureCrontableExists(cronTablePath)
      if (bootstrap.outcome === 'created') {
        cronLog.info(clock.now().toISOString(), `crontable created at ${cronTablePath}`)
      } else if (bootstrap.outcome === 'failed') {
        console.error(
          `[slack] cron-scheduler: failed to create crontable at ${cronTablePath}: ${bootstrap.cause}`,
        )
        // Continue — the read below will surface as zero schedules.
      }

      // (2) Read + parse EXACTLY ONCE. A read failure logs loudly and proceeds
      // with zero schedules (the tick then does nothing every minute).
      let text = ''
      try {
        text = readFileSync(cronTablePath, 'utf-8')
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err)
        console.error(
          `[slack] cron-scheduler: failed to read crontable at ${cronTablePath}: ${cause}`,
        )
      }

      const { schedules, errors } = parseCrontable(text)

      // Each parse error → one outcome record (identity '-', channel '-') with
      // line=<n> and the reason; rawLine goes in free text (operator-authored,
      // not secret).
      for (const e of errors) {
        cronLog.outcome({
          timestamp: clock.now().toISOString(),
          identity: NO_FIELD,
          channel: NO_FIELD,
          outcome: 'parse-error',
          detail: { line: e.lineNumber, text: `${e.reason} rawLine=${e.rawLine}` },
        })
      }

      // Compile each good schedule's pattern once. parseCrontable already
      // validated the expression via croner, so construction here does not
      // throw; guard anyway so one bad line cannot abort the load.
      compiled = []
      for (const schedule of schedules) {
        try {
          compiled.push({ schedule, cron: new Cron(schedule.expression) })
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err)
          console.error(
            `[slack] cron-scheduler: skipping schedule with uncompilable expression ` +
              `"${schedule.expression}": ${cause}`,
          )
        }
      }

      // (3) Exactly ONE started marker (PD-4 outage-window marker).
      cronLog.info(
        clock.now().toISOString(),
        `scheduler started, ${compiled.length} schedules loaded`,
      )

      // (4) Arm the tick.
      arm()
    } catch (err) {
      // Failure isolation: start() never throws out to the server.
      console.error('[slack] cron-scheduler: start() failed (scheduler inactive):', err)
    }
  }

  // -------------------------------------------------------------------------
  // Timer chain — minute-aligned, self-re-arming, serialized
  // -------------------------------------------------------------------------

  /** Milliseconds from `from` to the top of the next minute (>0, <= MINUTE_MS). */
  function msToNextMinute(from: Date): number {
    const rem = from.getTime() % MINUTE_MS
    return MINUTE_MS - rem
  }

  /**
   * Schedule the next tick at the top of the next minute, computed from a FRESH
   * now(). Any existing timer is cleared first so arm() is safe to call
   * repeatedly (start, and re-arm after each pass).
   */
  function arm(): void {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
    const delay = msToNextMinute(clock.now())
    timer = clock.setTimeout(() => {
      // The timer fired; drop the handle before running so stop() during the
      // pass cannot double-clear, then re-arm from a fresh now() AFTER the pass
      // completes (serialized ticks; a slow pass shifts the next arm, never
      // overlaps). tick() never throws, so re-arming is unconditional.
      timer = null
      void tick().finally(() => {
        // Only re-arm if we have not been stopped during the pass. stop() sets
        // `stopped = true`; check it here so a stop() mid-pass ends the chain.
        if (!stopped) arm()
      })
    }, delay)
  }

  // -------------------------------------------------------------------------
  // tick() — one dispatch pass
  // -------------------------------------------------------------------------

  async function tick(): Promise<void> {
    try {
      // (1) E3 insertion point — crontable hot-reload lands HERE in E3. It MUST
      // remain a no-op in this Epic (the table loads once at start()).

      // (2) Stamp the current wall-clock minute (epoch minute). Skip the whole
      // pass if it is not strictly after the last-ticked minute (MONOTONIC
      // guard — a backwards clock jump must not re-fire fired minutes).
      const nowMs = clock.now().getTime()
      const minuteStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
      const observedMinute = minuteStart / MINUTE_MS
      if (observedMinute <= lastTickedMinute) return
      lastTickedMinute = observedMinute

      // (3) Match every in-memory schedule against that minute in server-local
      // time, in parse (= crontable line) order so downstream ordering is line
      // order. An occurrence exists within [minuteStart, minuteStart+60s) iff
      // the next run at-or-after minuteStart falls before the next minute top.
      const windowStart = new Date(minuteStart - 1)
      const windowEndMs = minuteStart + MINUTE_MS
      const matches: CronSchedule[] = []
      for (const { schedule, cron } of compiled) {
        const occurrence = cron.nextRun(windowStart)
        if (occurrence !== null && occurrence.getTime() < windowEndMs) {
          // (4) At-most-once assertion, keyed on raw line text + this minute.
          const already = firedAtMinute.get(schedule.rawLine)
          if (already === observedMinute) {
            // Structurally impossible via the once-per-minute loop; reaching
            // here is a SCHEDULER BUG, not operator error. Shout and skip. This
            // is an info LINE KIND, not an outcome class — a bug signal must not
            // pollute the 'http-error' network-failure triage view
            // (`grep http-error cron.log`).
            cronLog.info(
              new Date(nowMs).toISOString(),
              `SCHEDULER BUG: at-most-once violation — line already fired this ` +
                `minute (minute=${observedMinute}); skipping re-fire. rawLine=${schedule.rawLine}`,
              schedule.identity,
              NO_FIELD,
            )
            continue
          }
          firedAtMinute.set(schedule.rawLine, observedMinute)
          matches.push(schedule)
        }
      }

      // Hand ALL non-duplicate matches, in line order, to the dispatcher's
      // group entry point in ONE call. The dispatcher never throws; wrap anyway
      // (belt-and-braces) so a pass can never kill the timer chain. A minute
      // with no matches does NOTHING and logs NOTHING.
      if (matches.length > 0) {
        try {
          await dispatcher.fireGroup(matches)
        } catch (err) {
          console.error('[slack] cron-scheduler: fireGroup threw (isolated):', err)
        }
      }

      // (5) Prune map entries older than the current minute.
      for (const [rawLine, minute] of firedAtMinute) {
        if (minute < observedMinute) firedAtMinute.delete(rawLine)
      }
    } catch (err) {
      // A tick never throws — one loud line, timer chain survives.
      console.error('[slack] cron-scheduler: tick() failed (isolated):', err)
    }
  }

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  function stop(): void {
    stopped = true
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  return { start, stop, tick }
}
