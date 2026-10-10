/**
 * cron-log.ts — Dedicated cron-fire log (R1/R2 on b.grx, PD-3/PD-4/PD-5 on
 * b.he5). Records every cron fire outcome — success and failure — as one
 * greppable, human-triageable plain-text line in the file at
 * `cron_log_path`, and keeps that file under `cron_log_max_bytes` when the key
 * is set. This module is the single owner of appends to (and prunes of) that
 * file.
 *
 * Two halves:
 *
 *   PURE HALF — record types + line formatting + the prune's cut
 *   (`cronLogPruneOffset`), no I/O, importable without side effects
 *   (crontable.ts purity precedent). Deliberately plain text, not
 *   JSONL (the permission-trail.ts precedent): human triage is the point
 *   (`grep no-session cron.log` must yield readable lines). Do NOT "fix" this
 *   back to JSONL.
 *
 *   I/O HALF — `createCronLog(path, { maxBytes })` returns a writer handle
 *   whose single internal append function is the only code path that touches
 *   the file, and the choke point E5's whole-line pruning hangs off.
 *   Lazy-open append-mode fd, mkdir parent on first open (allowed — the log is
 *   server-owned output; D-Q1's no-mkdir rule is crontable-only). Appends
 *   never throw into the caller: on failure one `[slack] cron-log`-prefixed
 *   console.error, then the fd is dropped so the next append retries the open
 *   (self-healing — a deliberate improvement over permission-trail.ts, which
 *   keeps its fd).
 *
 *   Size cap (E5, `cron_log_max_bytes`, PD-5). With no `maxBytes` the log is
 *   append-only: no size check, no read-back, no rewrite. With one, each
 *   successful append is followed by one `fstat` of the fd; only when the file
 *   is over the cap is it read back and rewritten without its OLDEST whole
 *   lines, until what is kept fits the cap (`cronLogPruneOffset`). It is never
 *   cut mid-line, never emptied, and the line just written is always kept: a
 *   cap smaller than that line keeps that line alone. No rotation — a rotated
 *   file would break the single size-on-disk cap. Only this log is pruned;
 *   the crontable is never touched here.
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

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname } from 'node:path'

import { DurableWriteUnsyncedError, durableWriteFileSync } from './atomic-write.ts'
import { describeThrownValueWithoutStack } from './persona-connection-errors.ts'

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
// Pure half — whole-line prune (E5)
// ---------------------------------------------------------------------------

/** The byte that ends every record (`\n`). */
const NEWLINE = 0x0a

/**
 * Where to cut the cron log's `bytes` so what is kept fits `maxBytes` (E5,
 * PD-5): the offset of the first byte to KEEP; 0 means drop nothing. Only
 * whole lines are dropped, oldest first: the cut is the earliest line start
 * (0, or just after a `\n`) that leaves at most `maxBytes` bytes, so the kept
 * bytes never start mid-line and are never empty. The newest line (the last
 * one — the line just written) is never dropped: when it alone is larger
 * than `maxBytes` (a cap smaller than one line), the cut is its start and it
 * is kept by itself, and when it is the whole file the answer is 0 (nothing
 * to rewrite, so no thrash). One pass over the bytes, no loop to converge.
 * Pure; never throws.
 */
export function cronLogPruneOffset(bytes: Uint8Array, maxBytes: number): number {
  const end = bytes.length
  if (!(end > maxBytes)) return 0
  // The newest line starts just after the last `\n` before its own
  // terminator (or at 0 when there is none).
  const newestStart = end < 2 ? 0 : bytes.lastIndexOf(NEWLINE, end - 2) + 1
  // At least `end - maxBytes` bytes must go: the earliest line start at or
  // after that offset follows the first `\n` at or after the byte before it.
  const firstNewline = bytes.indexOf(NEWLINE, end - maxBytes - 1)
  const cut = firstNewline === -1 ? newestStart : firstNewline + 1
  return Math.min(cut, newestStart)
}

// ---------------------------------------------------------------------------
// I/O half — writer handle
// ---------------------------------------------------------------------------

/**
 * Writer handle returned by `createCronLog`. All four append methods funnel
 * through one internal append function (the choke point E5's pruning hangs
 * off) — they differ only in which pure formatter builds the line.
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
 * The prune's rewrite: replaces `path` with exactly `bytes`, atomically and
 * durably (`durableWriteFileSync` in production). Throws on failure: a
 * `DurableWriteUnsyncedError` when the bytes reached `path` but its directory
 * could not be synced, any other error when `path` was left unchanged.
 */
export type CronLogWriter = (path: string, bytes: Uint8Array) => void

/** Options of {@link createCronLog}. */
export interface CronLogOptions {
  /**
   * The size cap in bytes (`cron_log_max_bytes`, a positive integer the config
   * loader validated). Absent: append-only, exactly as before E5 — no size
   * check, no read-back, no rewrite.
   */
  maxBytes?: number
  /** The prune's rewrite; `durableWriteFileSync` by default. A seam for tests to observe or fail it. */
  write?: CronLogWriter
}

/**
 * Create a cron-log writer bound to `path`. Lazy-opens an append-mode fd on
 * first write, creating the parent directory (recursive) at that point. All
 * writes route through one internal `append` — the single code path that
 * touches the file, and the one that prunes it when `options.maxBytes` is set.
 *
 * Appends never throw into the caller. On a write/open failure: exactly one
 * `[slack] cron-log`-prefixed console.error carrying the schedule identity and
 * outcome class (so the failure survives in server.log), then the fd is
 * dropped (closed best-effort, set null) so the NEXT append retries the open —
 * self-healing, a deliberate improvement over permission-trail.ts which keeps
 * its fd across failures.
 *
 * Pruning (E5, PD-5), only with `maxBytes`: after each successful append, one
 * `fstat` of the fd. Only when the file is over the cap is it read back, and
 * only while `path` still names the fd's file (same device and inode): when
 * `path` was replaced or removed while the server runs (log rotation, a move,
 * an editor's save), the fd is dropped without an error line and nothing is
 * pruned, so the next append reopens `path` and the cap follows it. The
 * bytes to keep are chosen by `cronLogPruneOffset` (oldest whole lines
 * dropped, the newest line always kept) and written over the log's real path
 * through `write` — `durableWriteFileSync`: a uniquely named temp file beside
 * the log, fsync, rename, directory fsync — so a reader sees the old log or
 * the pruned one, never a partial or empty file, even after a crash. The real
 * path is written so a symlinked `cron_log_path` keeps pointing at the log
 * instead of being replaced by a regular file. The fd still points at the
 * replaced file, so it is dropped and the next append reopens `path`. A
 * rename whose directory could not be synced (`DurableWriteUnsyncedError`)
 * counts as done: the pruned log is in place, and a crash that undoes the
 * rename only brings back the longer log, which the next append prunes again.
 *
 * A prune never throws into the caller and never loses the line just written
 * (it is on disk before the prune starts). On a prune failure: exactly one
 * `[slack] cron-log: prune failed` console.error carrying the identity and
 * outcome of the line just written, the fd is dropped so the next append
 * reopens `path`, and the log stays over the cap until a later append prunes
 * it.
 *
 * Race tolerance: the read-back and the rename are not atomic with respect to
 * any OTHER writer. A line appended through another fd between the read and
 * the rename is lost with the replaced file, and that other fd goes on writing
 * into the replaced file until it is reopened. The scheduler is the log's
 * single writer (one handle per server, synchronous appends), so this is
 * belt-and-braces; a log tolerates losing such a line.
 */
export function createCronLog(path: string, options: CronLogOptions = {}): CronLog {
  const { maxBytes } = options
  const write = options.write ?? durableWriteFileSync
  let fd: number | null = null

  /** Close the fd (best effort) and forget it, so the next append reopens `path`. */
  function dropFd(): void {
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      /* best-effort close */
    }
    fd = null
  }

  /**
   * The single choke point. `identity`/`outcome` are carried only for the
   * failure log lines. Synchronous `writeSync` (per permission-trail.ts /
   * logging.ts) so lines are whole and never interleaved. The line is written
   * BEFORE any prune, so a prune can never lose it.
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
      dropFd()
      return
    }
    if (maxBytes !== undefined) pruneOverCap(maxBytes, identity, outcome)
  }

  /**
   * Prune the log back under `cap` when the append just made left it over
   * (see `createCronLog`). Never throws; on failure one console.error and the
   * fd is dropped.
   */
  function pruneOverCap(cap: number, identity: string, outcome: string): void {
    if (fd === null) return
    try {
      const held = fstatSync(fd)
      if (held.size <= cap) return
      // The size above is the fd's file, but the read and the rewrite below go
      // to `path`. When `path` was replaced or removed while the server runs
      // (logrotate `create`, `mv cron.log x && touch cron.log`, an editor's
      // save), the fd still appends to the old file: kept, it would grow that
      // file without bound while `path` stays under the cap, and re-read
      // `path` on every append. Not a failure (no error line): drop the fd so
      // the next append reopens `path`, and prune nothing now.
      let target: string
      let atPath: Stats
      try {
        target = realpathSync(path)
        atPath = statSync(target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
        dropFd()
        return
      }
      if (atPath.dev !== held.dev || atPath.ino !== held.ino) {
        dropFd()
        return
      }
      const bytes = readFileSync(target)
      const cut = cronLogPruneOffset(bytes, cap)
      if (cut === 0) {
        // Nothing to drop, nothing to rewrite. Either the newest line is the
        // whole file (a cap smaller than one line: keep the fd), or what
        // `path` holds is already within the cap although the fd's file was
        // over it: `path` was replaced after the check above (or truncated in
        // place), so drop the fd — at worst one needless reopen.
        if (bytes.length <= cap) dropFd()
        return
      }
      try {
        write(target, bytes.subarray(cut))
      } catch (err) {
        // Renamed but unsynced: the pruned log is in place (see above).
        if (!(err instanceof DurableWriteUnsyncedError)) throw err
      } finally {
        // The fd points at the file the rename replaced (or, after a failed
        // write, at the unchanged log): reopen on the next append either way.
        dropFd()
      }
    } catch (err) {
      console.error(
        `[slack] cron-log: prune failed identity=${identity} outcome=${outcome} — the line is written, the log is not pruned: ${describeThrownValueWithoutStack(err)}`,
      )
      dropFd()
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
