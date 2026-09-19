/**
 * agent-director-logger.ts — Verbosity filter for the `agent-director`
 * library's diagnostic logger (b.brv).
 *
 * The AD Client is handed a `logger` at `Client.create()` time and emits a
 * per-poll success dump for every verb it dispatches, e.g.
 *
 *   SubprocessClient: list ok { ...full multiline JSON... elapsedMs: N }
 *   SubprocessClient: status ok { ... }
 *   SubprocessClient: get ok { ... }
 *
 * CSCB polls agent-director continuously (permission poller, health check),
 * so at `info` level these routine `<verb> ok` blocks dominate server.log —
 * millions of lines, no forensic value (see the 2 GB / 137 MB observations in
 * b.brv). This wrapper drops those routine success dumps at the default
 * verbosity while leaving failures, warnings, and errors untouched so
 * incident forensics still works.
 *
 * Verbosity is OFF by default. Set CSCB_AD_VERBOSE to a truthy value
 * (`1`, `true`, `yes`, `on`, case-insensitive) to pass the AD logger through
 * unfiltered — restoring the full per-poll chatter for debugging.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Minimal structural shape of the logger AD accepts. We forward the four
 * standard console methods; AD only calls these. Kept structural (not
 * `Console`) so the filtered wrapper is assignable to AD's `logger` option.
 */
export interface AdLogger {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Env var that, when truthy, disables filtering (full AD chatter). */
export const AD_VERBOSE_ENV = 'CSCB_AD_VERBOSE'

/**
 * Matches the routine per-poll success dumps AD emits at info/log level:
 * `SubprocessClient: <verb> ok { ... }`. Anchored on the `SubprocessClient:`
 * prefix and the ` ok` success marker so failure lines (`<verb> failed`,
 * `<verb> error`) never match and always pass through.
 */
const ROUTINE_SUCCESS_RE = /SubprocessClient:\s+\w+\s+ok\b/

function isVerbose(env: NodeJS.ProcessEnv): boolean {
  const raw = env[AD_VERBOSE_ENV]
  if (raw === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/**
 * Return true if this log record is a routine per-poll AD success dump that
 * should be suppressed at default verbosity. Only the first argument (AD's
 * message string) is inspected; the trailing payload object is what makes the
 * line expensive, but the message prefix alone identifies the record.
 */
function isRoutineSuccessDump(args: unknown[]): boolean {
  const first = args[0]
  return typeof first === 'string' && ROUTINE_SUCCESS_RE.test(first)
}

/**
 * Wrap a base logger (typically `console`) with the b.brv verbosity filter.
 *
 * - `warn` / `error` always pass through unfiltered.
 * - `log` / `info` pass through UNLESS the record is a routine
 *   `SubprocessClient: <verb> ok` success dump AND verbosity is off.
 *
 * When CSCB_AD_VERBOSE is truthy the base logger is returned unwrapped.
 */
export function makeFilteredAdLogger(
  base: AdLogger = console,
  env: NodeJS.ProcessEnv = process.env,
): AdLogger {
  if (isVerbose(env)) return base

  const gate = (
    method: (...args: unknown[]) => void,
  ): ((...args: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      if (isRoutineSuccessDump(args)) return
      method(...args)
    }
  }

  return {
    log: gate(base.log.bind(base)),
    info: gate(base.info.bind(base)),
    warn: base.warn.bind(base),
    error: base.error.bind(base),
  }
}
