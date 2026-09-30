/**
 * shutdown-deadline.ts — The bounded fallback exit for a shutdown that nothing
 * else ends (b.jg5 SRJ-205: a stop by the runtime version re-check runs the
 * shutdown sequence and exits non-zero).
 *
 * The shutdown sequence awaits the MCP transport closes and the persona Slack
 * disconnects, and none of those awaits has a deadline of its own. After a
 * signal, the CLI's `stop` sends SIGKILL once its `stop_timeout` runs out;
 * after a stop by the runtime version re-check, no outside party does. So
 * `main()` arms this deadline before it runs that shutdown:
 *
 * - `armShutdownDeadline(deps)` arms one timer on the injected clock, after
 *   `deadlineMs` (default {@link SHUTDOWN_DEADLINE_MS}), and returns a cancel
 *   function;
 * - on expiry it logs one token-free line naming the deadline and the exit
 *   code, then calls `exit(exitCode)`, once;
 * - the timer handle is unref'd when it has an `unref` (the real timers do;
 *   a fake clock's handle may not), so the deadline never keeps alive a
 *   process that would otherwise exit. Such an exit (a shutdown hung on a
 *   promise with no open handle behind it) carries code 0 unless the caller
 *   has set `process.exitCode`; `main()`'s re-check stop sets it to the same
 *   code before it runs the shutdown;
 * - cancel clears the timer; it is idempotent, and a cancel after expiry does
 *   nothing.
 *
 * A shutdown that completes exits the process itself, which makes the pending
 * deadline moot.
 *
 * Importable without side effects: nothing is armed, read or logged at
 * import. The clock and the log sink are injected; the real timers are the
 * default.
 *
 * SPDX-License-Identifier: MIT
 */

import type { PersonaConnectionClock } from './persona-connections.ts'

/**
 * The time from the start of a shutdown to the fallback exit: 30 s, the CLI
 * `stop`'s default `stop_timeout` (the grace a signal-driven shutdown gets
 * before SIGKILL). A normal shutdown stops its timers synchronously, then
 * closes local MCP transports and each persona's Slack socket, which takes
 * well under that; each Slack connection attempt's own bound is 10 s. So 30 s
 * comfortably exceeds a normal shutdown while still bounding a hung one.
 */
export const SHUTDOWN_DEADLINE_MS = 30_000

/** The timers the deadline arms (the shared fake clock satisfies it in tests). */
export type ShutdownDeadlineClock = Pick<PersonaConnectionClock, 'setTimeout' | 'clearTimeout'>

/** The real timers. */
const REAL_TIMER_CLOCK: ShutdownDeadlineClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Dependencies of {@link armShutdownDeadline}. */
export interface ShutdownDeadlineDeps {
  /** The exit code the fallback exits with. */
  exitCode: number
  /** Ends the process (`main()`: `process.exit`). Called at most once. */
  exit: (code: number) => void
  /** Receives the one `[slack]` line logged on expiry (the server log). */
  log: (line: string) => void
  /** The deadline in ms; {@link SHUTDOWN_DEADLINE_MS} by default. */
  deadlineMs?: number
  /** Timers; the real ones by default. */
  clock?: ShutdownDeadlineClock
}

/** Cancels an armed shutdown deadline. Idempotent. */
export type CancelShutdownDeadline = () => void

/** The line logged when the deadline runs out; carries only numbers. */
export function buildShutdownDeadlineLine(deadlineMs: number, exitCode: number): string {
  return `[slack] Shutdown did not complete within ${deadlineMs / 1000} s — exiting with code ${exitCode}`
}

/** Call `unref()` on a timer handle when it has one. */
function unrefHandle(handle: unknown): void {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) return
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref !== 'function') return
  try {
    unref.call(handle)
  } catch {
    /* an unref that fails leaves the timer referenced; the exit still runs */
  }
}

/** Arm the fallback exit; see the module comment. Returns its cancel function. */
export function armShutdownDeadline(deps: ShutdownDeadlineDeps): CancelShutdownDeadline {
  const clock = deps.clock ?? REAL_TIMER_CLOCK
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS
  let settled = false

  const handle = clock.setTimeout(() => {
    if (settled) return
    settled = true
    try {
      deps.log(buildShutdownDeadlineLine(deadlineMs, deps.exitCode))
    } catch {
      /* a failing logger must not stop the exit */
    }
    deps.exit(deps.exitCode)
  }, deadlineMs)
  unrefHandle(handle)

  return () => {
    if (settled) return
    settled = true
    clock.clearTimeout(handle)
  }
}
