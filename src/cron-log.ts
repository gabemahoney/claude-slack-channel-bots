/**
 * cron-log.ts — Dedicated append-only cron-fire log (R1/R2 on b.grx,
 * PD-3/PD-4 on b.he5). Records every cron fire outcome — success and failure —
 * as one greppable, human-triageable plain-text line in the file at
 * `cron_log_path`. This module is the single owner of appends to that file.
 *
 * Two halves:
 *
 *   PURE HALF — record types + line formatting, no I/O, importable without
 *   side effects (crontable.ts purity precedent). Deliberately plain text, not
 *   JSONL (the permission-trail.ts precedent): human triage is the point
 *   (`grep no-session cron.log` must yield readable lines). Do NOT "fix" this
 *   back to JSONL.
 *
 *   I/O HALF — `createCronLog(path)` returns a writer handle whose single
 *   internal append function is the only code path that touches the file
 *   (E5's future whole-line pruning choke point). Lazy-open append-mode fd,
 *   mkdir parent on first open (allowed — the log is server-owned output;
 *   D-Q1's no-mkdir rule is crontable-only). Appends never throw into the
 *   caller: on failure one `[slack] cron-log`-prefixed console.error, then the
 *   fd is dropped so the next append retries the open (self-healing — a
 *   deliberate improvement over permission-trail.ts, which keeps its fd).
 *   Append-only: no pruning, no rotation, no size checks, no read-back.
 *
 * Line layout (five space-delimited fields; one record = one physical line):
 *   <ISO-8601 UTC ms timestamp> <identity|-> <target|-> <outcome> <detail>
 * `target` is the persona target exactly as written in the crontable (a
 * persona name or key, b.av2 SR-9.3), or `-` when the line has none.
 * The first four fields are single tokens (internal whitespace escaped) so
 * `grep <outcome-class>` matches exactly that class's records. `detail` leads
 * with key=value tokens (prompt=, status=, errno=, line=) then free text.
 * UTC ISO-8601 with ms matches server.log's convention so cross-correlation
 * with PD-4's outage window works.
 *
 * SPDX-License-Identifier: MIT
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Pure half — record types
// ---------------------------------------------------------------------------

/**
 * The nine cron-fire outcome classes (PD-3 failure taxonomy). Each renders as
 * a single token in the outcome field so `grep <class>` is exact.
 *
 * `fanout-deferred` (the "all-bots fan-out not yet enabled" skip) is emitted by
 * the cron dispatcher for all-bots schedules while fan-out remains deferred to
 * E4. It STAYS in the union even after that so old log lines remain
 * interpretable. Do not omit it.
 */
export type CronOutcome =
  /** Prompt delivered to the target persona's session successfully. */
  | 'delivered'
  /** No live, connected session for the target persona (HTTP 503) — message dropped. */
  | 'no-session'
  /** The target is not a persona in the applied configuration (HTTP 404). */
  | 'unknown-persona'
  /** Prompt file did not exist at fire time. */
  | 'prompt-missing'
  /** Prompt file existed but could not be read. */
  | 'prompt-unreadable'
  /** Prompt file exceeded the size ceiling. */
  | 'prompt-oversize'
  /** The crontable line could not be parsed. */
  | 'parse-error'
  /** Belt-and-braces class for an unexpected HTTP status (503→no-session and 404→unknown-persona are handled separately) or a network failure on the localhost POST. */
  | 'http-error'
  /** All-bots fire skipped while fan-out remains deferred to E4 — emitted by the cron dispatcher. */
  | 'fanout-deferred'

/**
 * Detail fields for an outcome record. Every field is optional; supplied ones
 * render as leading key=value tokens (prompt=, status=, errno=, line=) in the
 * detail field, followed by any free text. Values are newline/whitespace-safe
 * for the free-text token but only the single-token positional fields need
 * whitespace collapsed — see `formatOutcomeLine`.
 */
export interface CronLogDetail {
  /** Full prompt-file path → `prompt=<path>`. */
  promptPath?: string
  /** HTTP status code → `status=<code>`. */
  status?: number
  /** Errno / error code string → `errno=<code>`. */
  errno?: string
  /** Crontable line number → `line=<n>`. */
  line?: number
  /** Free-text trailing note (rendered after the key=value tokens). */
  text?: string
}

/**
 * One cron-fire outcome record. `timestamp` is a UTC ISO-8601 string with ms
 * precision (e.g. `new Date().toISOString()`). `identity` is the schedule
 * identity or `-`; `target` is the persona target as written in the crontable
 * (a name or key) or `-` (pre-fan-out failures have no target yet).
 */
export interface CronLogRecord {
  timestamp: string
  identity: string
  target: string
  outcome: CronOutcome
  detail?: CronLogDetail
}

// ---------------------------------------------------------------------------
// Pure half — field sanitization
// ---------------------------------------------------------------------------

/** Sentinel used for an absent identity/target. */
const ABSENT = '-'

/**
 * Escape embedded CR/LF in any value so a record can never span physical
 * lines. Applied to EVERY value — the whole-line-pruning invariant (E5)
 * depends on one record being exactly one line.
 */
function escapeNewlines(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

/**
 * Render a single-token positional field (timestamp, identity, target,
 * outcome). Newlines are escaped and any remaining internal whitespace run is
 * replaced with a single `_` so the token cannot shift later fields —
 * `grep <outcome>` stays exact and field position is preserved. An
 * empty/whitespace-only value collapses to the `-` sentinel.
 */
function sanitizeToken(value: string): string {
  const escaped = escapeNewlines(value).replace(/\s+/g, '_')
  return escaped === '' ? ABSENT : escaped
}

/**
 * Render a free-text (multi-token) value. Newlines are escaped so the record
 * stays one physical line; internal spaces/tabs are preserved (the detail
 * field is the last field, so extra whitespace shifts nothing).
 */
function sanitizeText(value: string): string {
  return escapeNewlines(value)
}

// ---------------------------------------------------------------------------
// Pure half — detail assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the detail field: key=value tokens (prompt=, status=, errno=,
 * line=) in a fixed order, then any free text. Empty when nothing supplied.
 */
function formatDetail(detail: CronLogDetail | undefined): string {
  if (detail === undefined) return ''
  const parts: string[] = []
  if (detail.promptPath !== undefined) parts.push(`prompt=${sanitizeToken(detail.promptPath)}`)
  if (detail.status !== undefined) parts.push(`status=${detail.status}`)
  if (detail.errno !== undefined) parts.push(`errno=${sanitizeToken(detail.errno)}`)
  if (detail.line !== undefined) parts.push(`line=${detail.line}`)
  if (detail.text !== undefined && detail.text !== '') parts.push(sanitizeText(detail.text))
  return parts.join(' ')
}

/**
 * Join the positional fields, trimming a trailing empty detail so a record
 * with no detail renders as four fields without a dangling space.
 */
function joinFields(fields: readonly string[], detail: string): string {
  return detail === '' ? fields.join(' ') : `${fields.join(' ')} ${detail}`
}

// ---------------------------------------------------------------------------
// Pure half — line formatting
// ---------------------------------------------------------------------------

/**
 * Format one outcome record as a single physical line (no trailing newline —
 * the writer adds it). Five fields:
 *   <ts> <identity|-> <target|-> <outcome> <detail>
 */
export function formatOutcomeLine(record: CronLogRecord): string {
  const fields = [
    sanitizeToken(record.timestamp),
    sanitizeToken(record.identity),
    sanitizeToken(record.target),
    sanitizeToken(record.outcome),
  ]
  return joinFields(fields, formatDetail(record.detail))
}

/**
 * Format a per-fire summary line. Shares the five-field layout with `summary`
 * in the outcome position — a LINE KIND, not an outcome class, so it is
 * deliberately absent from `CronOutcome`:
 *   <ts> <identity> - summary delivered=N failed=M
 */
export function formatSummaryLine(
  timestamp: string,
  identity: string,
  delivered: number,
  failed: number,
): string {
  const fields = [
    sanitizeToken(timestamp),
    sanitizeToken(identity),
    ABSENT,
    'summary',
  ]
  return joinFields(fields, `delivered=${delivered} failed=${failed}`)
}

/**
 * Format an informational line. Shares the five-field layout with `info` in
 * the outcome position — a deliberate public seam for the scheduler's future
 * "scheduler started, N schedules loaded" marker (PD-4; Task 3 consumes this).
 * `identity` and `target` default to `-` since info lines are not fire-scoped.
 */
export function formatInfoLine(
  timestamp: string,
  text: string,
  identity: string = ABSENT,
  target: string = ABSENT,
): string {
  const fields = [
    sanitizeToken(timestamp),
    sanitizeToken(identity),
    sanitizeToken(target),
    'info',
  ]
  return joinFields(fields, sanitizeText(text))
}

/**
 * Format a warning line. Shares the five-field layout with `warn` in the
 * outcome position — a LINE KIND, not an outcome class, so it is deliberately
 * absent from `CronOutcome`, and the token is distinct from every outcome
 * class so `grep warn` matches exactly warn lines. `identity` and `target`
 * default to `-` since warn lines are not fire-scoped.
 */
export function formatWarnLine(
  timestamp: string,
  text: string,
  identity: string = ABSENT,
  target: string = ABSENT,
): string {
  const fields = [
    sanitizeToken(timestamp),
    sanitizeToken(identity),
    sanitizeToken(target),
    'warn',
  ]
  return joinFields(fields, sanitizeText(text))
}

// ---------------------------------------------------------------------------
// I/O half — writer handle
// ---------------------------------------------------------------------------

/**
 * Writer handle returned by `createCronLog`. All four append methods funnel
 * through one internal append function (the E5 pruning choke point) — they
 * differ only in which pure formatter builds the line.
 */
export interface CronLog {
  /** Append one outcome record. */
  outcome(record: CronLogRecord): void
  /** Append a per-fire summary line. */
  summary(timestamp: string, identity: string, delivered: number, failed: number): void
  /** Append an informational line (scheduler-started seam). */
  info(timestamp: string, text: string, identity?: string, target?: string): void
  /** Append a warning line. */
  warn(timestamp: string, text: string, identity?: string, target?: string): void
}

/**
 * Create a cron-log writer bound to `path`. Lazy-opens an append-mode fd on
 * first write, creating the parent directory (recursive) at that point. All
 * writes route through one internal `append` — the single code path that
 * touches the file and the choke point E5 will hang pruning off.
 *
 * Appends never throw into the caller. On a write/open failure: exactly one
 * `[slack] cron-log`-prefixed console.error carrying the schedule identity and
 * outcome class (so the failure survives in server.log), then the fd is
 * dropped (closed best-effort, set null) so the NEXT append retries the open —
 * self-healing, a deliberate improvement over permission-trail.ts which keeps
 * its fd across failures.
 */
export function createCronLog(path: string): CronLog {
  let fd: number | null = null

  /**
   * The single choke point. `identity`/`outcome` are carried only for the
   * failure log line. Synchronous `writeSync` (per permission-trail.ts /
   * logging.ts) so lines are whole and never interleaved.
   */
  function append(line: string, identity: string, outcome: string): void {
    try {
      if (fd === null) {
        mkdirSync(dirname(path), { recursive: true })
        fd = openSync(path, 'a')
      }
      writeSync(fd, line + '\n')
    } catch (err) {
      console.error(
        `[slack] cron-log: append failed identity=${identity} outcome=${outcome}`,
        err,
      )
      // Drop the fd so the next append retries the open (self-heal).
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* best-effort close */
        }
        fd = null
      }
    }
  }

  return {
    outcome(record: CronLogRecord): void {
      append(formatOutcomeLine(record), record.identity, record.outcome)
    },
    summary(timestamp: string, identity: string, delivered: number, failed: number): void {
      append(formatSummaryLine(timestamp, identity, delivered, failed), identity, 'summary')
    },
    info(timestamp: string, text: string, identity: string = ABSENT, target: string = ABSENT): void {
      append(formatInfoLine(timestamp, text, identity, target), identity, 'info')
    },
    warn(timestamp: string, text: string, identity: string = ABSENT, target: string = ABSENT): void {
      append(formatWarnLine(timestamp, text, identity, target), identity, 'warn')
    },
  }
}
