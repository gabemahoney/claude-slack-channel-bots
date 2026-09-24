/**
 * cron-scheduler.ts — The once-per-minute dispatch tick (Task 3 on b.he5;
 * decision 8, D-Q3, PD-4 on b.grx / t2.he5.eu.4q).
 *
 * `createCronScheduler(deps)` returns a handle whose single self-re-arming
 * timer is the ONLY code path that dispatches cron schedules (decision 8). It
 * loads the crontable at start() and re-loads it at the top of any tick whose
 * (mtimeMs, size) stat differs from the last successful load, matches the
 * in-memory schedules against the current wall-clock minute in server-local
 * time, and dispatches
 * every match for a minute to the dispatcher one schedule at a time, in
 * crontable line order — plain cron: N same-minute lines produce N separate
 * fire()s. There are NO per-job timers, ever — a single minute-aligned
 * setTimeout chain re-arms itself after each pass.
 *
 * Why a self-re-arming setTimeout chain and NOT setInterval: ticks must be
 * serialized (a pass never overlaps the next) so that the crontable hot-reload
 * at the top of the tick body mutates the in-memory table between whole passes,
 * never mid-pass. setInterval cannot guarantee that.
 *
 * Hot-reload (E3): the crontable file — not the in-memory copy — is the runtime
 * source of truth. Freshness is a per-tick (mtimeMs, size) stat compared for
 * INEQUALITY (not ordering — a backwards touch still reloads) against the last
 * SUCCESSFUL load. There is deliberately NO fs.watch/watcher/dirty flag: a swap
 * can only take effect at a tick anyway, and single-file watches drop the
 * atomic-save rename that is the mandated write pattern. A reload re-parses,
 * re-compiles and swaps the array; it NEVER dispatches and NEVER re-arms
 * timers. A missing file drops to ZERO schedules immediately (never keep stale
 * schedules behind a deleted crontable, D-Q1) and the following pass re-creates
 * it via the bootstrap. Errors are latched so a persistent condition warns once,
 * not once a minute.
 *
 * At-most-once is a LOGGED ASSERTION, not the mechanism (decision 8): the
 * minute-aligned single-pass loop already makes a double-fire structurally
 * impossible; the Map<schedule instance, epoch minute> exists only to catch a
 * scheduler BUG (the SAME loaded schedule fired twice in one pass) and shout
 * about it. It is keyed on the compiled-schedule INSTANCE, not raw line text,
 * so two identical operator lines are two distinct schedules that EACH fire —
 * plain cron semantics (PD-6). A would-be re-fire of one instance in the same
 * minute is skipped and logged loudly.
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

import { readFileSync, statSync, type Stats } from 'node:fs'

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

/** Sentinel for a log field with no target/identity (parse-error lines). */
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
  /** The dispatcher (Task 2) — its fire() is the only fire path. */
  dispatcher: CronDispatcher
  /** The cron-log writer handle (Task 1). */
  cronLog: CronLog
  /** Path to the crontable file (bootstrapped if absent; re-read on change). */
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
 * A loaded schedule and its compiled croner pattern. The pattern is built once
 * per load (at start() and at each detected crontable change — never per tick)
 * and is only ever queried, never started — no callback is supplied, so it
 * schedules nothing on its own.
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

  // In-memory table, loaded at start() and re-loaded by the tick's reload step,
  // in crontable line order.
  let compiled: CompiledSchedule[] = []

  // (mtimeMs, size) of the last SUCCESSFUL load — the reload freshness gate.
  // null means "nothing loaded yet", so the next reachable file always loads.
  // A failed stat/read never updates it, so the stat stays stale and the next
  // successful read reloads (this is what picks up a chmod recovery).
  let lastLoadStat: { mtimeMs: number; size: number } | null = null

  // Latch: a non-ENOENT stat/read failure (EACCES, EIO, …) warns on first
  // appearance only, and clears on the next successful load.
  let readErrorLatched = false

  // Latch: the crontable is currently missing. Set on the pass that detects the
  // deletion (which also drops to zero schedules); the NEXT pass attempts the
  // bootstrap re-create. While set, neither the vanish WARN nor a repeated
  // bootstrap failure is logged again. Cleared by the next successful load.
  let vanished = false

  // At-most-once bookkeeping: compiled-schedule INSTANCE → epoch minute it last
  // fired in. In-memory only, pruned every tick. A LOGGED ASSERTION (decision
  // 8), not the dispatch mechanism. Keyed on the instance (identity), NOT raw
  // line text, so two identical operator lines are two distinct schedules that
  // each fire (PD-6) — only the SAME loaded schedule reappearing twice in one
  // minute is the bug this catches.
  const firedAtMinute = new Map<CompiledSchedule, number>()

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
  // Shared load path — used by start() AND by the tick's reload step
  // -------------------------------------------------------------------------

  /** A stat attempt: the Stats on success, or the errno/message on failure. */
  type StatProbe =
    | { ok: true; stat: Stats }
    | { ok: false; missing: boolean; cause: string }

  /** Stat the crontable. `missing` distinguishes ENOENT from every other error. */
  function probeStat(): StatProbe {
    try {
      return { ok: true, stat: statSync(cronTablePath) }
    } catch (err) {
      return { ok: false, missing: isEnoent(err), cause: describe(err) }
    }
  }

  function isEnoent(err: unknown): boolean {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
  }

  function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  /**
   * Read + parse + compile + swap, using `stat` (the stat that gated this load)
   * as the recorded freshness marker. The ONLY place parse errors are logged
   * and the ONLY place `compiled` is replaced with loaded content.
   *
   * The stat is recorded on every SUCCESSFUL read — including a read whose
   * content has parse errors, so those errors are not re-emitted on unchanged
   * ticks — and NEVER on a failed read (which also leaves `compiled` untouched,
   * so a mid-run read failure keeps the current schedules firing).
   *
   * It deliberately does NOT log the "crontable reloaded" INFO: that line
   * belongs to the tick-reload caller only, so start() never emits it.
   */
  function loadAndSwap(stat: Stats): { ok: true; count: number } | { ok: false; missing: boolean; cause: string } {
    let text: string
    try {
      text = readFileSync(cronTablePath, 'utf-8')
    } catch (err) {
      return { ok: false, missing: isEnoent(err), cause: describe(err) }
    }
    lastLoadStat = { mtimeMs: stat.mtimeMs, size: stat.size }

    const { schedules, errors } = parseCrontable(text)

    // Each parse error → one outcome record (identity '-', target '-') with
    // line=<n> and the reason; rawLine goes in free text (operator-authored,
    // not secret). Emitted once per load, hence once per detected change.
    for (const e of errors) {
      cronLog.outcome({
        timestamp: clock.now().toISOString(),
        identity: NO_FIELD,
        target: NO_FIELD,
        outcome: 'parse-error',
        detail: { line: e.lineNumber, text: `${e.reason} rawLine=${e.rawLine}` },
      })
    }

    // Compile each good schedule's pattern once. parseCrontable already
    // validated the expression via croner, so construction here does not
    // throw; guard anyway so one bad line cannot abort the load.
    const next: CompiledSchedule[] = []
    for (const schedule of schedules) {
      try {
        next.push({ schedule, cron: new Cron(schedule.expression) })
      } catch (err) {
        console.error(
          `[slack] cron-scheduler: skipping schedule with uncompilable expression ` +
            `"${schedule.expression}": ${describe(err)}`,
        )
      }
    }
    compiled = next
    return { ok: true, count: compiled.length }
  }

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

      // (2) Initial load through the SHARED load path (the same helper the
      // tick's reload step uses, so parse-error logging and the schedule swap
      // are single-sited). A stat or read failure logs loudly and proceeds with
      // zero schedules (the tick then does nothing until the file becomes
      // readable, at which point the stale recorded stat makes it reload).
      // start() emits no reload INFO — that line is the tick caller's alone.
      const probe = probeStat()
      const loaded = probe.ok ? loadAndSwap(probe.stat) : probe
      if (!loaded.ok) {
        console.error(
          `[slack] cron-scheduler: failed to read crontable at ${cronTablePath}: ${loaded.cause}`,
        )
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
  // Hot-reload — tick step (1)
  // -------------------------------------------------------------------------

  /**
   * Re-load the crontable if its (mtimeMs, size) differs IN ANY WAY from the
   * last successful load. An unchanged file does nothing and logs nothing.
   *
   * A mid-write read needs no special handling: the parser is line-tolerant, so
   * healthy lines survive, and the completed write is a further stat change the
   * next tick picks up.
   *
   * Note the at-most-once map is deliberately NOT touched here — it is tick
   * state keyed on schedule instances, not schedule state, and it is an
   * assertion rather than the double-fire protection (see the module header).
   */
  function reloadIfChanged(): void {
    // Missing since a previous pass: this is the pass that tries to bring the
    // file back (detect+zero happened on the pass that saw it disappear).
    if (vanished) {
      recreateAndLoad()
      return
    }

    const probe = probeStat()
    if (!probe.ok) {
      noteLoadFailure(probe)
      return
    }
    if (
      lastLoadStat !== null &&
      lastLoadStat.mtimeMs === probe.stat.mtimeMs &&
      lastLoadStat.size === probe.stat.size
    ) {
      return
    }

    const loaded = loadAndSwap(probe.stat)
    if (!loaded.ok) {
      noteLoadFailure(loaded)
      return
    }
    readErrorLatched = false
    cronLog.info(clock.now().toISOString(), `crontable reloaded, ${loaded.count} schedules`)
  }

  /**
   * Map a failed stat/read onto its latched log line. ENOENT is the deletion
   * case (D-Q1: drop to zero rather than keep stale schedules behind a missing
   * file); every other errno keeps the current schedules and warns once.
   */
  function noteLoadFailure(failure: { missing: boolean; cause: string }): void {
    if (failure.missing) {
      // Detected the deletion: zero schedules IMMEDIATELY (nothing stale ever
      // fires post-delete), forget the recorded stat, warn once. The bootstrap
      // re-create happens on the NEXT pass.
      compiled = []
      lastLoadStat = null
      vanished = true
      cronLog.warn(
        clock.now().toISOString(),
        `crontable vanished at ${cronTablePath} — 0 schedules until it is restored`,
      )
      return
    }
    if (readErrorLatched) return
    readErrorLatched = true
    cronLog.warn(
      clock.now().toISOString(),
      `crontable unreadable at ${cronTablePath}, keeping ${compiled.length} loaded schedules: ${failure.cause}`,
    )
  }

  /**
   * The pass after a vanish: re-create the crontable via the bootstrap, then
   * load it. 'created' → log the re-creation (wording distinct from start()'s
   * first-install line) and load the empty template (zero schedules).
   * 'already-exists' → something else restored the file first; no create log,
   * and its content loads intact. 'failed' (e.g. the config directory is gone)
   * → silent, because the vanish WARN already latched this condition and a
   * persistent failure must not log once a minute.
   */
  function recreateAndLoad(): void {
    const bootstrap = ensureCrontableExists(cronTablePath)
    if (bootstrap.outcome === 'failed') return
    if (bootstrap.outcome === 'created') {
      cronLog.info(clock.now().toISOString(), `crontable re-created at ${cronTablePath} after deletion`)
    }

    const probe = probeStat()
    if (!probe.ok) {
      // Still gone (or now unreadable) — stay vanished and stay quiet; the
      // latch is what suppresses the per-tick repeat.
      if (!probe.missing) noteLoadFailure(probe)
      return
    }
    const loaded = loadAndSwap(probe.stat)
    if (!loaded.ok) {
      if (!loaded.missing) noteLoadFailure(loaded)
      return
    }
    vanished = false
    readErrorLatched = false
    cronLog.info(clock.now().toISOString(), `crontable reloaded, ${loaded.count} schedules`)
  }

  // -------------------------------------------------------------------------
  // tick() — one dispatch pass
  // -------------------------------------------------------------------------

  async function tick(): Promise<void> {
    try {
      // (1) Crontable hot-reload — BEFORE the monotonic-minute guard and before
      // matching, in the same serialized pass, so a swap happens between whole
      // passes and the guard below still owns double-fire protection across a
      // reload. Never dispatches, never re-arms timers.
      reloadIfChanged()

      // (2) Stamp the current wall-clock minute (epoch minute). Skip the whole
      // pass if it is not strictly after the last-ticked minute (MONOTONIC
      // guard — a backwards clock jump must not re-fire fired minutes).
      const nowMs = clock.now().getTime()
      const minuteStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
      const observedMinute = minuteStart / MINUTE_MS
      if (observedMinute <= lastTickedMinute) return
      lastTickedMinute = observedMinute

      // (3) Match every in-memory schedule against that minute in server-local
      // time, in parse (= crontable line) order so dispatch is line order. An
      // occurrence exists within [minuteStart, minuteStart+60s) iff the next
      // run at-or-after minuteStart falls before the next minute top. Each
      // match is dispatched immediately, one fire() per schedule (plain cron:
      // N same-minute lines → N separate fires, in line order).
      const windowStart = new Date(minuteStart - 1)
      const windowEndMs = minuteStart + MINUTE_MS
      for (const entry of compiled) {
        const { schedule, cron } = entry
        const occurrence = cron.nextRun(windowStart)
        if (occurrence !== null && occurrence.getTime() < windowEndMs) {
          // (4) At-most-once assertion, keyed on the compiled-schedule INSTANCE
          // + this minute. Two identical operator lines are two distinct
          // `entry` instances, so both fire (PD-6); only the SAME instance
          // reappearing this minute trips the guard.
          const already = firedAtMinute.get(entry)
          if (already === observedMinute) {
            // Structurally impossible via the once-per-minute loop; reaching
            // here means one loaded schedule fired twice in a single pass — a
            // SCHEDULER BUG, not operator error (a duplicated line is a
            // different instance and cannot reach here). Shout and skip. This
            // is an info LINE KIND, not an outcome class — a bug signal must not
            // pollute the 'http-error' network-failure triage view
            // (`grep http-error cron.log`).
            cronLog.info(
              new Date(nowMs).toISOString(),
              `SCHEDULER BUG: at-most-once violation — schedule already fired ` +
                `this minute (minute=${observedMinute}); skipping re-fire. ` +
                `rawLine=${schedule.rawLine}`,
              schedule.identity,
              NO_FIELD,
            )
            continue
          }
          firedAtMinute.set(entry, observedMinute)

          // Dispatch this one schedule. The dispatcher never throws; wrap
          // anyway (belt-and-braces, per-schedule isolation) so one bad
          // schedule can never kill the pass or the timer chain, and siblings
          // still fire.
          try {
            await dispatcher.fire(schedule)
          } catch (err) {
            console.error('[slack] cron-scheduler: fire threw (isolated):', err)
          }
        }
      }
      // A minute with no matches does NOTHING and logs NOTHING (above loop was
      // empty of dispatches).

      // (5) Prune map entries older than the current minute.
      for (const [entry, minute] of firedAtMinute) {
        if (minute < observedMinute) firedAtMinute.delete(entry)
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
