/**
 * retired-keys.ts — The retired-key record (b.jg5 SRJ-801, SRJ-802): which
 * persona keys are retired, so that no launch resumes a life a removal or a
 * destructive modify retired, and whether each retired key's new life has
 * begun.
 *
 * Where (SRJ-801). The file `retired-keys.json` ({@link RETIRED_KEYS_FILE_NAME})
 * in the server's state directory (`resolveServerStateDir()`,
 * `src/config.ts`: `~/.claude/channels/slack/` unless `SLACK_STATE_DIR` is
 * set), beside `config.json.last-applied` ({@link retiredKeysPath}). Only the
 * server writes it, through the one store `main()` builds at start
 * ({@link readRetiredKeysAtStart}); the CLI never builds a store and never
 * writes, creates or removes the file, so no read the CLI makes clears an
 * entry. It survives a server restart: a new store over the same directory
 * reads what an earlier one wrote.
 *
 * Format (SRJ-802). A UTF-8 JSON object, `version` (integer 1) and `keys`,
 * one entry per retired key: `retired_at` (RFC 3339 UTC, ending in `Z`),
 * `cause` ({@link RETIRED_KEY_CAUSES}) and `new_life_begun_at` (such a
 * timestamp, or `null` while the key's row, if any, is the old life).
 * {@link serializeRetiredKeys} writes it; {@link parseRetiredKeys} reads it,
 * strictly: every field is required with its type, only `new_life_begun_at`
 * may be `null`, a field the format does not name is refused at either level,
 * and a key is any non-empty string (the start sweep records the keys of
 * rows' `persona` labels, SRJ-714). A missing file is an empty record. A file
 * that exists but cannot be read (a directory, FIFO or other non-regular file
 * included, refused by the config reader's non-blocking open-then-fstat rule,
 * `readPersonaConfigBytes`, which reads the record whole with no size cap),
 * parsed or validated stops the start with one
 * `retired-keys-unreadable` startup-errors entry naming the file and the
 * move-aside remedy ({@link retiredKeysUnreadableMessage}); the start never
 * guesses, and no partial record is ever used.
 *
 * The store ({@link loadRetiredKeyStore}). Every primitive is synchronous,
 * so a record, rewrite and restore stretch cannot interleave with a mark or a
 * clear. Every write writes the whole record held in memory, atomically and
 * durably (`durableWriteFileSync`, `src/atomic-write.ts`), and the record in
 * memory changes only once that write succeeded. A write that fails (a rename
 * whose directory could not be synced included) leaves the record in memory
 * as it was, and an unsynced rename has the previous bytes written back, best
 * effort. Two changes are held in memory for the server's life instead, each
 * flagged unwritten until a later write that succeeds carries it: the keys of
 * a failed batch recorded with the `absent-at-start` cause (SRJ-714), and a
 * failed mark (SRJ-806). Its users:
 *   - `record` (a batch, one write) and `restore`: the apply's step 1 and its
 *     undo (SRJ-803, SRJ-804), and the start sweep (`absent-at-start`,
 *     SRJ-714). Recording a key already recorded clears its mark; one with no
 *     mark is left as it is and writes nothing, unless it is held only in
 *     memory, which makes the batch write (SRJ-803);
 *   - `isHeldInMemory`: the apply's step 1, which writes the record for a
 *     persona it brings up whose key is held only in memory (SRJ-803);
 *   - `mark`: a reuse spawn that began the key's new life (SRJ-806);
 *   - `clear`: the session manager's shared own-row reads
 *     (`readPersonaOwnRow`, `applyOwnRowStatusStep`) and the persona
 *     teardown kill's read between its tries (`readTeardownKillRow`), on the
 *     row-read rule's clear decision for a marked key's row read live other
 *     than `pending` (SRJ-807);
 *   - `isRecorded`, `isMarked` and `entry`: the launch rule (SRJ-805), the
 *     row-read rule and the old-life hold (SRJ-809);
 *   - `recordGeneration`: a launch attempt, read when it starts and at its
 *     reuse spawn's success, so that a key recorded while the attempt was in
 *     flight gets no mark (SRJ-806).
 *
 * The record generation. Each key has an in-memory count of the `record`
 * calls that named it in this store's life, every one counted: a batch that
 * writes, one that fails, one that writes nothing because the key is already
 * recorded with no mark, and one that records a key held only in memory. It is
 * never written, never read from the file (every key starts at 0 when the
 * store loads), never put back by a `restore` (a count only increases), and
 * changes nothing that is written or what any primitive answers. It is how a
 * reader that held a reading across a wait tells that the key was recorded
 * again in between, which the record itself cannot show when a re-record of
 * an unmarked key leaves it as it was.
 *
 * Log lines (SRJ-1014), one per change of the record and one per failed
 * write, to the injected log (a throwing log is swallowed). They name the
 * file, the keys and the cause or action, and carry no file content, no
 * parser text and no token:
 *
 *   [slack] retired-keys: recorded persona=<key> (cause=<cause>), … in "<path>" …
 *   [slack] retired-keys: persona=<key> marked: its new life has begun …
 *   [slack] retired-keys: persona=<key> entry cleared from "<path>"[ on <read>] …
 *   [slack] retired-keys: restored the record held before the apply …
 *   [slack] retired-keys: cannot <action> …
 *
 * The old-life holds (b.jg5 SRJ-809; {@link createOldLifeHoldSet}). An old
 * life that may still be running holds its working directory until
 * agent-director shows it finished. Holds live in server memory only: one
 * hold set per server, built by `main()` beside the store and shared by the
 * session manager and the reload controller; a restart drops them, and the
 * start sweep rebuilds the ones still needed from its `list` and this record.
 * A hold is keyed by the old row's instance id and carries the old key, the
 * held directory (compared by real path), what began it
 * ({@link OLD_LIFE_HOLD_CAUSES}), whether the old key's kill has failed
 * (SRJ-812) and the personas recorded as waiting on it. It ends only on a
 * read of the old row as `ended` or `missing` (or no row), a listing in a
 * `find-missing` result's `ids`, or the key's new life
 * ({@link OLD_LIFE_HOLD_END_REASONS}); no kill outcome ends it. The hold set
 * never reads or writes `retired-keys.json`: whether a key is recorded
 * without its mark is asked of the store by the hold's starters. One line
 * when a hold begins and one when it ends:
 *
 *   [slack] old-life hold: began on "<real path>" for oldKey=<key> (instanceId="<id>"): <cause> — the old life may still be running (b.jg5 SRJ-809)
 *   [slack] old-life hold: ended on "<real path>" for oldKey=<key> (instanceId="<id>"): <reason>[ (<read>)]; waiting personas: <keys|none> (b.jg5 SRJ-809)
 *
 * Importable with no side effect: nothing reads a file or the environment,
 * arms a timer or logs at import. Loading the store reads the file once and
 * logs nothing; the store has no timer, and neither has the hold set. The
 * module imports nothing from agent-director.
 *
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from 'node:path'

import {
  DurableUnlinkUnsyncedError,
  DurableWriteUnsyncedError,
  durableUnlinkSync,
  durableWriteFileSync,
} from './atomic-write.ts'
import {
  configReadFailurePredicate,
  isMissingConfigCode,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  resolveRealPath,
  resolveServerStateDir,
  type PersonaConfigFs,
} from './config.ts'
import { jsonSyntaxErrorOffset, positionAt } from './json-position.ts'
import { describeThrownValue, renderLogMessageText } from './persona-connection-errors.ts'
import { errnoSuffix } from './persona-credentials.ts'
import { PERSONA_KEY_RE, personaInstanceId } from './persona-identity.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Constants (b.jg5 SRJ-801, SRJ-802, SRJ-1013)
// ---------------------------------------------------------------------------

/** The record's file name, in the server's state directory (SRJ-801). */
export const RETIRED_KEYS_FILE_NAME = 'retired-keys.json'

/** The format version this server reads and writes (SRJ-802). */
export const RETIRED_KEYS_FORMAT_VERSION = 1

/** A removed persona's key (a renamed persona's old key included), recorded at the apply's step 1 (SRJ-803). */
export const RETIRED_KEY_CAUSE_REMOVED = 'removed'
/** A destructive modify's old half, recorded at the apply's step 1 (SRJ-803). */
export const RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY = 'destructive-modify'
/** A row's persona absent from the applied configuration, recorded by the start sweep (SRJ-714). */
export const RETIRED_KEY_CAUSE_ABSENT_AT_START = 'absent-at-start'

/** Every cause the record holds, in the format's order (SRJ-802). */
export const RETIRED_KEY_CAUSES = [
  RETIRED_KEY_CAUSE_REMOVED,
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY,
  RETIRED_KEY_CAUSE_ABSENT_AT_START,
] as const

/** What recorded a key last. */
export type RetiredKeyCause = (typeof RETIRED_KEY_CAUSES)[number]

/** The startup-errors class of a record the start cannot read, parse or validate (SRJ-802, SRJ-1013). */
export const RETIRED_KEYS_UNREADABLE_LABEL = 'retired-keys-unreadable'

/** The start of every line the store logs. */
export const RETIRED_KEYS_LOG_PREFIX = '[slack] retired-keys:'

/**
 * The record's path: {@link RETIRED_KEYS_FILE_NAME} in `stateDir`, the
 * server's state directory (`resolveServerStateDir()` when omitted, read at
 * call time).
 */
export function retiredKeysPath(stateDir: string = resolveServerStateDir()): string {
  return join(stateDir, RETIRED_KEYS_FILE_NAME)
}

// ---------------------------------------------------------------------------
// The record in memory
// ---------------------------------------------------------------------------

/** One retired key's entry. */
export interface RetiredKeyEntry {
  /** When the key was last recorded: RFC 3339 UTC, ending in `Z`. */
  readonly retiredAt: string
  /** What recorded it last. */
  readonly cause: RetiredKeyCause
  /** When a reuse for the key began its new life (SRJ-806), or null while its row, if any, is the old life. */
  readonly newLifeBegunAt: string | null
}

/**
 * A retired-key record: each entry keyed by its key. A `Map`, so a key such
 * as `__proto__` is an ordinary key.
 */
export type RetiredKeyRecord = ReadonlyMap<string, RetiredKeyEntry>

// ---------------------------------------------------------------------------
// Serialiser and parser (b.jg5 SRJ-802)
// ---------------------------------------------------------------------------

/**
 * The record's bytes: UTF-8 JSON, two-space indented with a final newline,
 * `version` then `keys`, the keys in sorted order and each entry's fields in
 * the format's order. Pure: the same record always gives the same bytes. The
 * one writer of the format; a test writes a record only through it.
 */
export function serializeRetiredKeys(record: RetiredKeyRecord): Uint8Array {
  // Object.fromEntries defines each key as an own property, `__proto__` included.
  const keys = Object.fromEntries(
    [...record.keys()].sort().map((key) => {
      const entry = record.get(key)!
      return [key, { retired_at: entry.retiredAt, cause: entry.cause, new_life_begun_at: entry.newLifeBegunAt }]
    }),
  )
  return new TextEncoder().encode(JSON.stringify({ version: RETIRED_KEYS_FORMAT_VERSION, keys }, null, 2) + '\n')
}

/**
 * What {@link parseRetiredKeys} answers: the record, or the problem, worded
 * as the predicate after the file's name ("is not valid JSON at line 1,
 * column 1"). The problem carries no file content and no parser text.
 */
export type RetiredKeysParseResult =
  | { readonly ok: true; readonly record: RetiredKeyRecord }
  | { readonly ok: false; readonly problem: string }

/** The fields of the top level, in the format's order. */
const TOP_LEVEL_FIELDS: readonly string[] = ['version', 'keys']
/** The fields of an entry, in the format's order. */
const ENTRY_FIELDS: readonly string[] = ['retired_at', 'cause', 'new_life_begun_at']

/** An RFC 3339 UTC timestamp written with `T` and `Z`, fraction optional. */
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/

/** Whether `value` is an RFC 3339 UTC timestamp ending in `Z` with an existing date and time (a leap second allowed). */
function isRfc3339UtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = RFC3339_UTC_RE.exec(value)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false
  return hour <= 23 && minute <= 59 && second <= 60
}

/** The number of days in `month` (1-12) of `year`, by the Gregorian rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Whether `value` is a JSON object (not null, not an array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is one of the causes. */
function isRetiredKeyCause(value: unknown): value is RetiredKeyCause {
  return typeof value === 'string' && (RETIRED_KEY_CAUSES as readonly string[]).includes(value)
}

/** Whether every one of `fields` is in `expected` (a missing field is checked apart). */
function hasOnlyFields(fields: readonly string[], expected: readonly string[]): boolean {
  return fields.every((field) => expected.includes(field))
}

/**
 * Parse and validate the record's bytes (SRJ-802), strictly: valid UTF-8 (a
 * byte order mark is refused), a JSON object with exactly `version` (the
 * integer 1) and `keys` (an object); each key a non-empty string; each entry
 * an object with exactly `retired_at` (an RFC 3339 UTC timestamp ending in
 * `Z`), `cause` (one of {@link RETIRED_KEY_CAUSES}) and `new_life_begun_at`
 * (such a timestamp, or `null`). A failure names the first problem, an entry
 * by its position in `keys`, never by its key. Pure; never throws.
 */
export function parseRetiredKeys(bytes: Uint8Array): RetiredKeysParseResult {
  const fail = (problem: string): RetiredKeysParseResult => ({ ok: false, problem })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('is not valid UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const offset = jsonSyntaxErrorOffset(text)
    if (offset === undefined) return fail('is not valid JSON')
    const { line, column } = positionAt(text, offset)
    return fail(`is not valid JSON at line ${line}, column ${column}`)
  }
  if (!isJsonObject(parsed)) return fail('is invalid: its top level is not a JSON object')
  if (!hasOnlyFields(Object.keys(parsed), TOP_LEVEL_FIELDS)) {
    return fail('is invalid: it has a top-level field the format does not name')
  }
  if (!Object.hasOwn(parsed, 'version')) return fail('is invalid: it has no `version`')
  if (parsed['version'] !== RETIRED_KEYS_FORMAT_VERSION) {
    return fail(`is invalid: its \`version\` is not ${RETIRED_KEYS_FORMAT_VERSION}`)
  }
  if (!Object.hasOwn(parsed, 'keys')) return fail('is invalid: it has no `keys`')
  const keys = parsed['keys']
  if (!isJsonObject(keys)) return fail('is invalid: its `keys` is not a JSON object')

  const record = new Map<string, RetiredKeyEntry>()
  let position = 0
  for (const [key, value] of Object.entries(keys)) {
    position++
    const problem = entryProblem(key, value)
    if (problem !== undefined) return fail(`is invalid: entry ${position} of \`keys\` ${problem}`)
    const entry = value as Record<string, unknown>
    record.set(key, {
      retiredAt: entry['retired_at'] as string,
      cause: entry['cause'] as RetiredKeyCause,
      newLifeBegunAt: entry['new_life_begun_at'] as string | null,
    })
  }
  return { ok: true, record }
}

/** What is wrong with one entry, as the predicate after "entry <n> of `keys`", or undefined when it is valid. */
function entryProblem(key: string, value: unknown): string | undefined {
  if (key === '') return 'has an empty key'
  if (!isJsonObject(value)) return 'is not a JSON object'
  if (!hasOnlyFields(Object.keys(value), ENTRY_FIELDS)) return 'has a field the format does not name'
  for (const field of ENTRY_FIELDS) {
    if (!Object.hasOwn(value, field)) return `has no \`${field}\``
  }
  if (!isRfc3339UtcTimestamp(value['retired_at'])) {
    return 'has a `retired_at` that is not an RFC 3339 UTC timestamp ending in Z'
  }
  if (!isRetiredKeyCause(value['cause'])) {
    return `has a \`cause\` that is not one of ${RETIRED_KEY_CAUSES.slice(0, -1).join(', ')} or ${RETIRED_KEY_CAUSES.at(-1)}`
  }
  const begun = value['new_life_begun_at']
  if (begun !== null && !isRfc3339UtcTimestamp(begun)) {
    return 'has a `new_life_begun_at` that is neither an RFC 3339 UTC timestamp ending in Z nor null'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The refusal (b.jg5 SRJ-802, SRJ-1013)
// ---------------------------------------------------------------------------

/**
 * The `retired-keys-unreadable` entry's text: names the file and what is
 * wrong with it (`problem`, the predicate after its name: "cannot be read
 * (EACCES)", "is not valid JSON at line 2, column 5", …), that the server
 * does not start, and that moving the file aside lets it start, at the cost
 * that the keys it held are no longer retired. Carries no file content.
 */
export function retiredKeysUnreadableMessage(path: string, problem: string): string {
  return (
    `The retired-key record "${path}" ${problem}, so the server does not start: it never guesses which persona keys are retired. ` +
    'Moving the file aside (for example, renaming it) lets the server start, at the cost that the keys it held are no longer ' +
    'retired, so a persona whose key it held may resume the conversation of the life that was retired.'
  )
}

// ---------------------------------------------------------------------------
// The store (b.jg5 SRJ-802, SRJ-803, SRJ-804, SRJ-806, SRJ-807)
// ---------------------------------------------------------------------------

/**
 * Writes bytes atomically and durably (`durableWriteFileSync` in production).
 * Throws on failure: a `DurableWriteUnsyncedError` when the bytes reached the
 * path but its directory could not be synced, any other error when the path
 * was left unchanged.
 */
export type RetiredKeysWriter = (path: string, bytes: Uint8Array) => void

/**
 * Deletes a file durably (`durableUnlinkSync` in production): true when a
 * file was removed, false when it was already absent. Throws on any other
 * failure: a `DurableUnlinkUnsyncedError` when the file was removed but its
 * directory could not be synced, any other error when the file is still there.
 */
export type RetiredKeysRemover = (path: string) => boolean

/** Dependencies of {@link loadRetiredKeyStore}. */
export interface RetiredKeyStoreDeps {
  /** Receives each `[slack]` line the store logs (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: RetiredKeysWriter
  /** The durable delete; `durableUnlinkSync` by default. */
  remove?: RetiredKeysRemover
  /** The read's file-system calls (`readPersonaConfigBytes`'s seam); unset ones are the real file system's. */
  readFs?: Partial<PersonaConfigFs>
  /** The clock for `retired_at` and `new_life_begun_at`, in milliseconds since the epoch; `Date.now` by default. */
  now?: () => number
}

/** One key to record and its cause. */
export interface RetiredKeyToRecord {
  readonly key: string
  readonly cause: RetiredKeyCause
}

/**
 * The record held in memory at one moment, unwritten changes included, for
 * {@link RetiredKeyStore.restore}. Opaque to callers.
 */
export interface RetiredKeysSnapshot {
  readonly entries: RetiredKeyRecord
  readonly heldKeys: ReadonlySet<string>
  readonly heldMarks: ReadonlySet<string>
}

/** The record was written. */
export const RETIRED_KEYS_WRITTEN = 'written'
/** Nothing changed, so nothing was written. */
export const RETIRED_KEYS_UNCHANGED = 'unchanged'
/** The key is not recorded, so nothing was written (a mark or a clear). */
export const RETIRED_KEYS_NOT_RECORDED = 'not-recorded'
/** The write failed; the record in memory is as it was, apart from the changes held in memory. */
export const RETIRED_KEYS_WRITE_FAILED = 'failed'
/** A restore of an empty record removed the file (or found it absent). */
export const RETIRED_KEYS_REMOVED = 'removed'

/** What a batch record did, and the record in memory before it, for a restore. */
export interface RetiredKeysRecordResult {
  readonly outcome: typeof RETIRED_KEYS_WRITTEN | typeof RETIRED_KEYS_UNCHANGED | typeof RETIRED_KEYS_WRITE_FAILED
  readonly snapshot: RetiredKeysSnapshot
}

/** What a mark or a clear did. */
export type RetiredKeysChangeOutcome =
  | typeof RETIRED_KEYS_WRITTEN
  | typeof RETIRED_KEYS_UNCHANGED
  | typeof RETIRED_KEYS_NOT_RECORDED
  | typeof RETIRED_KEYS_WRITE_FAILED

/** What a restore did. */
export type RetiredKeysRestoreOutcome =
  | typeof RETIRED_KEYS_WRITTEN
  | typeof RETIRED_KEYS_REMOVED
  | typeof RETIRED_KEYS_WRITE_FAILED

/** One server's retired-key record. Every member is synchronous and never throws, but `record` on an invalid key or cause. */
export interface RetiredKeyStore {
  /** The record's file. */
  readonly path: string
  /** Whether `key` is recorded (in memory, a key held only in memory included). */
  isRecorded(key: string): boolean
  /** Whether `key` is recorded with its "new life has begun" mark set (a mark held only in memory included). */
  isMarked(key: string): boolean
  /**
   * Whether `key` is held only in memory: recorded by a failed batch with the
   * `absent-at-start` cause that no write has carried yet (SRJ-714, SRJ-803).
   */
  isHeldInMemory(key: string): boolean
  /** `key`'s entry in memory, or undefined when it is not recorded. */
  entry(key: string): RetiredKeyEntry | undefined
  /** The recorded keys, sorted. */
  keys(): string[]
  /**
   * `key`'s record generation: how many `record` calls named it in this
   * store's life (0 for a key no `record` has named, a key loaded from the
   * file included). Every such call counts, whatever it wrote or did not
   * write, its failure included; a key named twice in one batch counts once.
   * Held in memory only: never written, never restored, it only increases.
   * A reader that captures it before a wait and finds it unchanged after
   * knows no `record` named the key in between (SRJ-806).
   */
  recordGeneration(key: string): number
  /**
   * Record a batch with one write (SRJ-803). A new key gets an entry
   * (`retired_at` now, the cause, no mark); a recorded key whose mark is set
   * gets the mark cleared, `retired_at` now and the new cause; a recorded key
   * with no mark is left as it is. A batch that changes nothing writes nothing,
   * unless one of its keys is held only in memory. A failed write leaves the
   * record in memory as it was, except that the keys it recorded with the
   * `absent-at-start` cause stay recorded, held only in memory (SRJ-714).
   * Answers the outcome and the record before the batch. Throws a `RangeError`
   * on an empty key or an unknown cause, before any change. Every key of a
   * batch that does not throw has its record generation increased by one,
   * whatever the outcome ({@link RetiredKeyStore.recordGeneration}).
   */
  record(batch: readonly RetiredKeyToRecord[]): RetiredKeysRecordResult
  /**
   * Set `key`'s "new life has begun" mark, now, with one write (SRJ-806).
   * Writes nothing for a key not recorded, or already marked with the mark
   * written. A mark held only in memory is written again, with its time. A
   * failed write keeps the mark set in memory, held for a later write.
   */
  mark(key: string): RetiredKeysChangeOutcome
  /**
   * Remove `key`'s entry with one write (SRJ-807). Writes nothing for a key
   * not recorded; a failed write keeps the entry. `onRead`, when given, says
   * which read cleared it, and the one line the clear logs carries it.
   */
  clear(key: string, onRead?: string): RetiredKeysChangeOutcome
  /** The record in memory now, unwritten changes included. */
  snapshot(): RetiredKeysSnapshot
  /**
   * Put `snapshot` back (SRJ-804): write it, keys and marks held only in memory
   * included, or, when it is empty, remove the file durably, writing an empty
   * record when the remove fails. A failure leaves the record in memory as it
   * is now, so the keys it could not remove stay retired.
   */
  restore(snapshot: RetiredKeysSnapshot): RetiredKeysRestoreOutcome
}

/** What {@link loadRetiredKeyStore} answers. */
export type RetiredKeysLoadOutcome =
  | { readonly kind: 'loaded'; readonly store: RetiredKeyStore }
  | {
      readonly kind: 'unreadable'
      readonly path: string
      /** The refusal text ({@link retiredKeysUnreadableMessage}). */
      readonly message: string
    }

/** What one write did, for the caller's log line. */
type WriteAttempt = { readonly ok: true } | { readonly ok: false; readonly detail: string }

/** A key as a log line shows it: `persona=<key>`, the key JSON-quoted unless it is a persona key. */
function keyRef(key: string): string {
  return `persona=${PERSONA_KEY_RE.test(key) ? key : JSON.stringify(key)}`
}

/** Log `line`, swallowing a throwing log. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what the store does */
  }
}

/**
 * Load the record at `stateDir` and build the store over it (SRJ-801,
 * SRJ-802): read once, through the config reader's non-blocking
 * open-then-fstat rule, whole, with no size cap (`uncapped`): only the server
 * writes the record and entries leave it only by a clear or a restore, so a
 * record grown past the readers' 64 KiB cap is still one the server wrote
 * and must not stop the next start. A missing file is an empty record and writes
 * nothing; a file that cannot be read, parsed or validated answers
 * `unreadable` with the refusal text, and no store. Logs nothing.
 */
export function loadRetiredKeyStore(stateDir: string, deps: RetiredKeyStoreDeps): RetiredKeysLoadOutcome {
  const path = retiredKeysPath(stateDir)
  const unreadable = (problem: string): RetiredKeysLoadOutcome => ({
    kind: 'unreadable',
    path,
    message: retiredKeysUnreadableMessage(path, problem),
  })
  let bytes: Uint8Array | null
  try {
    bytes = readPersonaConfigBytes(path, deps.readFs, { uncapped: true })
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    if (!isMissingConfigCode(code)) return unreadable(configReadFailurePredicate(code))
    bytes = null
  }
  let entries: RetiredKeyRecord = new Map()
  if (bytes !== null) {
    const parsed = parseRetiredKeys(bytes)
    if (!parsed.ok) return unreadable(parsed.problem)
    entries = parsed.record
  }
  return { kind: 'loaded', store: createRetiredKeyStore(path, entries, bytes, deps) }
}

/** The store over `path`, whose file holds `initialBytes` (null: no file), parsed as `initial`. */
function createRetiredKeyStore(
  path: string,
  initial: RetiredKeyRecord,
  initialBytes: Uint8Array | null,
  deps: RetiredKeyStoreDeps,
): RetiredKeyStore {
  const write = deps.write ?? durableWriteFileSync
  const remove = deps.remove ?? durableUnlinkSync
  const now = deps.now ?? Date.now
  const file = JSON.stringify(path)

  /** The record in memory. Replaced, never mutated, so a snapshot shares it safely. */
  let entries: RetiredKeyRecord = initial
  /** Keys recorded by a failed `absent-at-start` batch that no write has carried yet. */
  let heldKeys: ReadonlySet<string> = new Set()
  /** Keys whose mark a failed mark write set, that no write has carried yet. */
  let heldMarks: ReadonlySet<string> = new Set()
  /** What the file is believed to hold (null: no file), for writing it back after an unsynced rename. */
  let fileBytes: Uint8Array | null = initialBytes
  /** Each key's record generation (absent: 0). In memory only; never written, never restored, only increased. */
  const generations = new Map<string, number>()

  const timestamp = (): string => new Date(now()).toISOString()

  /** ` carrying <keys> held only in memory` when a write carries held changes, else nothing. */
  function carriedSuffix(): string {
    const held = [...new Set([...heldKeys, ...heldMarks])].sort()
    return held.length === 0 ? '' : `; it carries the changes held only in memory for ${held.map(keyRef).join(', ')}`
  }

  /** The record in memory becomes `next`, all of it written. */
  function committed(next: RetiredKeyRecord): void {
    entries = next
    heldKeys = new Set()
    heldMarks = new Set()
  }

  /**
   * Put `previous` (null: no file) back after an unsynced write of `current`,
   * best effort, and say what the file holds now.
   */
  function writeBack(previous: Uint8Array | null, current: Uint8Array): string {
    const putBack = previous === null ? 'the file, absent before, was removed again' : 'the previous record was written back'
    try {
      if (previous === null) remove(path)
      else write(path, previous)
      fileBytes = previous
      return putBack
    } catch (backErr) {
      if (backErr instanceof DurableWriteUnsyncedError || backErr instanceof DurableUnlinkUnsyncedError) {
        fileBytes = previous
        return `${putBack}, though its directory could not be synced either`
      }
      fileBytes = current
      return `putting the previous state back failed too${errnoSuffix(backErr)}, so the file holds the new record`
    }
  }

  /** Write `next` whole, durably. On failure, the file is as it was where it can be. */
  function writeWhole(next: RetiredKeyRecord): WriteAttempt {
    const bytes = serializeRetiredKeys(next)
    try {
      write(path, bytes)
      fileBytes = bytes
      return { ok: true }
    } catch (err) {
      if (!(err instanceof DurableWriteUnsyncedError)) {
        return { ok: false, detail: `${errnoSuffix(err)}; the file is unchanged` }
      }
      const restored = writeBack(fileBytes, bytes)
      return { ok: false, detail: `: the new record was written but its directory could not be synced${errnoSuffix(err)}; ${restored}` }
    }
  }

  function snapshot(): RetiredKeysSnapshot {
    return { entries, heldKeys, heldMarks }
  }

  function record(batch: readonly RetiredKeyToRecord[]): RetiredKeysRecordResult {
    for (const { key, cause } of batch) {
      if (typeof key !== 'string' || key === '') throw new RangeError('retired-keys: a key to record must be a non-empty string')
      if (!isRetiredKeyCause(cause)) throw new RangeError('retired-keys: a key to record needs a known cause')
    }
    // SRJ-806: every recording of a key counts, a re-record that writes nothing included.
    for (const key of new Set(batch.map(({ key }) => key))) generations.set(key, (generations.get(key) ?? 0) + 1)
    const before = snapshot()
    const next = new Map(entries)
    const changed: RetiredKeyToRecord[] = []
    // What the line says of each key the batch writes: changed, or held only in memory and written now.
    const writing: string[] = []
    const at = timestamp()
    for (const { key, cause } of batch) {
      const existing = next.get(key)
      if (existing !== undefined && existing.newLifeBegunAt === null) {
        // SRJ-803: a key held only in memory makes the batch write; any other unmarked key is left as it is.
        if (heldKeys.has(key) && !changed.some((c) => c.key === key)) {
          writing.push(`${keyRef(key)} (cause=${existing.cause}, held only in memory)`)
        }
        continue
      }
      next.set(key, { retiredAt: at, cause, newLifeBegunAt: null })
      changed.push({ key, cause })
      writing.push(`${keyRef(key)} (cause=${cause}${existing !== undefined ? ', its "new life has begun" mark cleared' : ''})`)
    }
    if (writing.length === 0) return { outcome: RETIRED_KEYS_UNCHANGED, snapshot: before }

    const described = [...new Set(writing)].join(', ')
    const carried = carriedSuffix()
    const attempt = writeWhole(next)
    if (attempt.ok) {
      committed(next)
      safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} recorded ${described} in ${file}${carried} (b.jg5 SRJ-803)`)
      return { outcome: RETIRED_KEYS_WRITTEN, snapshot: before }
    }

    // SRJ-714: the keys of a failed `absent-at-start` recording stay recorded, held only in memory.
    const held = changed.filter(({ cause }) => cause === RETIRED_KEY_CAUSE_ABSENT_AT_START).map(({ key }) => key)
    if (held.length > 0) {
      const kept = new Map(entries)
      const keptMarks = new Set(heldMarks)
      for (const key of held) {
        kept.set(key, next.get(key)!)
        keptMarks.delete(key)
      }
      entries = kept
      heldKeys = new Set([...heldKeys, ...held])
      heldMarks = keptMarks
    }
    const inMemory =
      held.length > 0
        ? `this server holds ${held.map(keyRef).join(', ')} as retired in memory for its life, and the next write of the record that succeeds carries them (b.jg5 SRJ-803, SRJ-714)`
        : 'the record in memory is unchanged (b.jg5 SRJ-803)'
    safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} cannot record ${described} in ${file}${attempt.detail}; ${inMemory}`)
    return { outcome: RETIRED_KEYS_WRITE_FAILED, snapshot: before }
  }

  function mark(key: string): RetiredKeysChangeOutcome {
    const existing = entries.get(key)
    if (existing === undefined) return RETIRED_KEYS_NOT_RECORDED
    if (existing.newLifeBegunAt !== null && !heldMarks.has(key)) return RETIRED_KEYS_UNCHANGED
    const next = new Map(entries)
    next.set(key, { ...existing, newLifeBegunAt: existing.newLifeBegunAt ?? timestamp() })
    const carried = carriedSuffix()
    const attempt = writeWhole(next)
    if (attempt.ok) {
      committed(next)
      safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} ${keyRef(key)} marked: its new life has begun, in ${file}${carried} (b.jg5 SRJ-806)`)
      return RETIRED_KEYS_WRITTEN
    }
    // SRJ-806: a mark whose write fails stays set in memory for this server's life.
    entries = next
    heldMarks = new Set([...heldMarks, key])
    safeLog(
      deps.log,
      `${RETIRED_KEYS_LOG_PREFIX} cannot mark ${keyRef(key)} in ${file}${attempt.detail}; this server holds its mark in memory, ` +
        'and its next launch decision writes it again (b.jg5 SRJ-806)',
    )
    return RETIRED_KEYS_WRITE_FAILED
  }

  function clear(key: string, onRead?: string): RetiredKeysChangeOutcome {
    if (!entries.has(key)) return RETIRED_KEYS_NOT_RECORDED
    const next = new Map(entries)
    next.delete(key)
    const carried = carriedSuffix()
    const read = onRead === undefined || onRead === '' ? '' : ` on ${onRead}`
    const attempt = writeWhole(next)
    if (attempt.ok) {
      committed(next)
      safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} ${keyRef(key)} entry cleared from ${file}${read}${carried} (b.jg5 SRJ-807)`)
      return RETIRED_KEYS_WRITTEN
    }
    safeLog(
      deps.log,
      `${RETIRED_KEYS_LOG_PREFIX} cannot clear ${keyRef(key)} from ${file}${read}${attempt.detail}; the entry stays, and the next ` +
        'qualifying read clears it again (b.jg5 SRJ-807)',
    )
    return RETIRED_KEYS_WRITE_FAILED
  }

  /** Restore an empty record: remove the file, or write an empty record when the remove fails. */
  function restoreEmpty(): RetiredKeysRestoreOutcome {
    const empty: RetiredKeyRecord = new Map()
    let removeDetail: string
    try {
      remove(path)
      fileBytes = null
      committed(empty)
      safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} restored the record held before the apply: it was empty, so ${file} was removed (b.jg5 SRJ-804)`)
      return RETIRED_KEYS_REMOVED
    } catch (err) {
      if (err instanceof DurableUnlinkUnsyncedError) {
        fileBytes = null
        committed(empty)
        safeLog(
          deps.log,
          `${RETIRED_KEYS_LOG_PREFIX} restored the record held before the apply: it was empty, so ${file} was removed, but its ` +
            `directory could not be synced${errnoSuffix(err)}, so it may reappear after a crash (b.jg5 SRJ-804)`,
        )
        return RETIRED_KEYS_REMOVED
      }
      removeDetail = errnoSuffix(err)
    }
    const attempt = writeWhole(empty)
    if (attempt.ok) {
      committed(empty)
      safeLog(
        deps.log,
        `${RETIRED_KEYS_LOG_PREFIX} restored the record held before the apply: it was empty, and removing ${file} failed` +
          `${removeDetail}, so an empty record was written (b.jg5 SRJ-804)`,
      )
      return RETIRED_KEYS_WRITTEN
    }
    safeLog(
      deps.log,
      `${RETIRED_KEYS_LOG_PREFIX} cannot restore the record held before the apply: removing ${file} failed${removeDetail}, and ` +
        `writing an empty record failed${attempt.detail}; the keys it holds stay retired (b.jg5 SRJ-804)`,
    )
    return RETIRED_KEYS_WRITE_FAILED
  }

  function restore(target: RetiredKeysSnapshot): RetiredKeysRestoreOutcome {
    if (target.entries.size === 0) return restoreEmpty()
    const attempt = writeWhole(target.entries)
    if (attempt.ok) {
      committed(target.entries)
      safeLog(deps.log, `${RETIRED_KEYS_LOG_PREFIX} restored the record held before the apply in ${file} (b.jg5 SRJ-804)`)
      return RETIRED_KEYS_WRITTEN
    }
    safeLog(
      deps.log,
      `${RETIRED_KEYS_LOG_PREFIX} cannot restore the record held before the apply in ${file}${attempt.detail}; the keys it ` +
        'could not remove stay retired (b.jg5 SRJ-804)',
    )
    return RETIRED_KEYS_WRITE_FAILED
  }

  return {
    path,
    isRecorded: (key) => entries.has(key),
    isMarked: (key) => (entries.get(key)?.newLifeBegunAt ?? null) !== null,
    isHeldInMemory: (key) => heldKeys.has(key),
    entry: (key) => entries.get(key),
    keys: () => [...entries.keys()].sort(),
    recordGeneration: (key) => generations.get(key) ?? 0,
    record,
    mark,
    clear,
    snapshot,
    restore,
  }
}

// ---------------------------------------------------------------------------
// The start read (b.jg5 SRJ-801, SRJ-802)
// ---------------------------------------------------------------------------

/** Dependencies of {@link readRetiredKeysAtStart}: the store's, and the startup-errors recorder. */
export interface RetiredKeysStartDeps extends RetiredKeyStoreDeps {
  /** Records one startup-errors entry; `recordStartupError` by default, which also writes the server-log line. */
  recordStartupError?: (classLabel: string, message: string) => void
}

/** What the start read answers: the loaded store, or a refused start. */
export type RetiredKeysStartOutcome =
  | { readonly kind: 'loaded'; readonly store: RetiredKeyStore }
  | { readonly kind: 'refused'; readonly path: string }

/**
 * The start's read of the record (SRJ-802): load the store over `stateDir`.
 * A record that cannot be read, parsed or validated records exactly one
 * {@link RETIRED_KEYS_UNREADABLE_LABEL} entry with the refusal text and
 * answers `refused`; the caller stops the start. Never exits the process.
 */
export function readRetiredKeysAtStart(stateDir: string, deps: RetiredKeysStartDeps): RetiredKeysStartOutcome {
  const loaded = loadRetiredKeyStore(stateDir, deps)
  if (loaded.kind === 'loaded') return loaded
  ;(deps.recordStartupError ?? recordStartupError)(RETIRED_KEYS_UNREADABLE_LABEL, loaded.message)
  return { kind: 'refused', path: loaded.path }
}

// ---------------------------------------------------------------------------
// The old-life holds (b.jg5 SRJ-809)
// ---------------------------------------------------------------------------

/** The start of the two lines the hold set logs. */
export const OLD_LIFE_HOLD_LOG_PREFIX = '[slack] old-life hold:'

/** Apply step 1 recorded the key as retired, and the last-applied rewrite succeeded (SRJ-809's first start). */
export const OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 = 'apply-step-1'
/** A start-sweep kill of a live row did not succeed (SRJ-809's second start). */
export const OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL = 'start-sweep-kill-not-succeeded'
/** The start sweep listed a live row of a key recorded as retired without the "new life has begun" mark (SRJ-809's third start). */
export const OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING = 'start-sweep-listing'

/** What begins a hold, in SRJ-809's order. */
export const OLD_LIFE_HOLD_CAUSES = [
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING,
] as const

/** What began a hold. */
export type OldLifeHoldCause = (typeof OLD_LIFE_HOLD_CAUSES)[number]

/** A read of the old row answered `ended`. */
export const OLD_LIFE_HOLD_END_READ_ENDED = 'read-ended'
/** A read of the old row answered `missing`, or found no row (`ErrSpawnNotFound`). */
export const OLD_LIFE_HOLD_END_READ_MISSING = 'read-missing'
/** A completed `find-missing` run listed the old row in its `ids`. */
export const OLD_LIFE_HOLD_END_FIND_MISSING_IDS = 'find-missing-ids'
/** A reuse for the key began its new life (SRJ-806), which implies the old row was finished. */
export const OLD_LIFE_HOLD_END_NEW_LIFE = 'new-life'

/** What ends a hold (SRJ-809): nothing else does, and no kill outcome is among them. */
export const OLD_LIFE_HOLD_END_REASONS = [
  OLD_LIFE_HOLD_END_READ_ENDED,
  OLD_LIFE_HOLD_END_READ_MISSING,
  OLD_LIFE_HOLD_END_FIND_MISSING_IDS,
  OLD_LIFE_HOLD_END_NEW_LIFE,
] as const

/** What ended a hold. */
export type OldLifeHoldEndReason = (typeof OLD_LIFE_HOLD_END_REASONS)[number]

/** The tail of the began-again line: a second begin keeps the one hold on its held directory. */
export const OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL = 'one hold is kept, on its held directory'

/** Each cause in the begin line's words. */
const OLD_LIFE_HOLD_CAUSE_WORDS: Readonly<Record<OldLifeHoldCause, string>> = Object.freeze({
  [OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1]: 'apply step 1 recorded its key as retired',
  [OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL]: 'its start-sweep kill did not succeed',
  [OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING]:
    'the start sweep listed it live while its key is recorded as retired without the "new life has begun" mark',
})

/** Each end reason in the end line's words. */
const OLD_LIFE_HOLD_END_WORDS: Readonly<Record<OldLifeHoldEndReason, string>> = Object.freeze({
  [OLD_LIFE_HOLD_END_READ_ENDED]: 'the old row read ended',
  [OLD_LIFE_HOLD_END_READ_MISSING]: 'the old row read missing, or no row',
  [OLD_LIFE_HOLD_END_FIND_MISSING_IDS]: "a find-missing run listed the old row in its ids",
  [OLD_LIFE_HOLD_END_NEW_LIFE]: "a reuse for the key began its new life",
})

/**
 * The old key of a row an old-life hold is begun on (SRJ-809): the key in the
 * row's `persona` label when the row's instance id is that key's own
 * (`cscb_<key>`); otherwise (no label, an empty one, or an instance id that
 * is not the label's `cscb_<key>`) the instance id itself takes the place of
 * the old key. Pure; never throws.
 */
export function oldLifeKeyOf(instanceId: string, personaLabel: unknown): string {
  if (typeof personaLabel === 'string' && personaLabel !== '' && personaInstanceId(personaLabel) === instanceId) {
    return personaLabel
  }
  return instanceId
}

/** One hold as the hold set's queries answer it: a copy, never the set's own state. */
export interface OldLifeHold {
  /** The old row's instance id: the hold's key. */
  readonly instanceId: string
  /** The old key: the row's `persona` label key, or the instance id in its place (`oldLifeKeyOf`). */
  readonly oldKey: string
  /** The held directory, as given at the begin or replaced by a later-read `cwd`. */
  readonly directory: string
  /** `directory`'s real path when this copy was made (its lexical path when it cannot be resolved). */
  readonly realDirectory: string
  /** What began it (the latest begin's cause). */
  readonly cause: OldLifeHoldCause
  /** True once a kill of the old row decided the ordinary kill-failure alert (SRJ-812); until the hold ends. */
  readonly killFailed: boolean
  /** The persona keys recorded as having waited on it, sorted. */
  readonly waiting: readonly string[]
}

/** What `begin` is given. */
export interface OldLifeHoldBegin {
  readonly instanceId: string
  readonly oldKey: string
  /** The held directory (the old declaration's working directory, or the row's `cwd`). */
  readonly directory: string
  readonly cause: OldLifeHoldCause
}

/** A persona as the waits query reads it: its key and its working directory (a `Persona` fits). */
export interface OldLifeHoldPersona {
  readonly key: string
  readonly working_directory: string
}

/** Told each hold that ends, with the reason; registered with `onEnd`. */
export type OldLifeHoldEndObserver = (hold: OldLifeHold, reason: OldLifeHoldEndReason) => void

/** Dependencies of {@link createOldLifeHoldSet}. */
export interface OldLifeHoldSetDeps {
  /** Receives each line the set logs (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /**
   * The real-path resolver directories are compared by; `resolveRealPath`
   * (`src/config.ts`) by default, so a directory that no longer exists
   * compares by its lexical path. A throw counts as the lexical path.
   */
  realPath?: (path: string) => string
}

/**
 * One server's old-life holds (SRJ-809), in memory. Every member is
 * synchronous and never throws. No member ends a hold on a kill outcome:
 * only `end`, which its callers call on a read of the old row as `ended` or
 * `missing` (or no row), a `find-missing` result's `ids`, or the key's new
 * life.
 */
export interface OldLifeHoldSet {
  /**
   * Begin a hold on `input.instanceId`, logging one begin line. A begin on an
   * instance id already held keeps that one hold: only its cause becomes the
   * new one, and its directory, old key, kill-failed mark and waiting personas
   * stay (`input.directory` is not used). Its one began-again line names the
   * kept directory. Only `replaceDirectory` moves a held directory. Answers
   * the hold.
   */
  begin(input: OldLifeHoldBegin): OldLifeHold
  /**
   * Replace the held directory of `instanceId`'s hold with `cwd`, a `cwd` read
   * later from its row. No line. Answers true when the directory changed;
   * false when the id is not held or `cwd` is the same string.
   */
  replaceDirectory(instanceId: string, cwd: string): boolean
  /**
   * End `instanceId`'s hold for `reason`: it is removed, one end line is
   * logged (`read`, when given, names the read that ended it), then each end
   * observer is told once, in registration order; an observer's throw is
   * logged and stops neither the end nor another observer. An id not held
   * does nothing and logs nothing. Answers the hold as it was, or undefined.
   */
  end(instanceId: string, reason: OldLifeHoldEndReason, read?: string): OldLifeHold | undefined
  /** Mark `instanceId`'s hold kill-failed (SRJ-812): it stays so until it ends. True when the id is held. */
  markKillFailed(instanceId: string): boolean
  /** Record persona `key` as waiting on `instanceId`'s hold. True when the id is held. */
  recordWaiting(instanceId: string, key: string): boolean
  /** Forget persona `key` from every hold's waiting record. */
  forgetWaiting(key: string): void
  /** Register an end observer; answers a function that removes it. */
  onEnd(observer: OldLifeHoldEndObserver): () => void
  /** Every hold whose directory is `directory` by real path, in begin order. */
  holdsOnDirectory(directory: string): OldLifeHold[]
  /** The hold on `instanceId`, or undefined. */
  holdOf(instanceId: string): OldLifeHold | undefined
  /**
   * The holds `persona` waits on, in begin order: each hold whose directory
   * is the persona's working directory by real path, and the hold on the
   * persona's own `cscb_<key>`.
   */
  holdsWaitedOnBy(persona: OldLifeHoldPersona): OldLifeHold[]
  /** Whether any hold `persona` waits on is marked kill-failed (SRJ-812's state 4). */
  waitsOnKillFailed(persona: OldLifeHoldPersona): boolean
  /** Every hold, in begin order: for tests and diagnostics. */
  snapshot(): OldLifeHold[]
}

/** A hold's own state in the set. */
interface OldLifeHoldState {
  readonly instanceId: string
  readonly oldKey: string
  directory: string
  cause: OldLifeHoldCause
  killFailed: boolean
  readonly waiting: Set<string>
}

/** A key as the hold lines show it: bare when it is a persona key, else JSON-quoted. */
function holdKeyText(key: string): string {
  return PERSONA_KEY_RE.test(key) ? key : JSON.stringify(renderLogMessageText(key))
}

/** A value of agent-director's (an instance id, a directory) as the hold lines quote it. */
function holdQuoted(text: string): string {
  return JSON.stringify(renderLogMessageText(text))
}

/**
 * The line a hold's begin logs (SRJ-809): the directory as its real path, the
 * old key, the instance id and the cause; `again` when the instance id was
 * already held, so the one hold is kept on its held directory with the new
 * cause:
 *
 *   [slack] old-life hold: began on "<real path>" for oldKey=<key> (instanceId="<id>"): <cause> — the old life may still be running (b.jg5 SRJ-809)
 *   [slack] old-life hold: began again on "<real path>" for oldKey=<key> (instanceId="<id>"): <cause> — one hold is kept, on its held directory (b.jg5 SRJ-809)
 *
 * Carries no token and no file content. Pure.
 */
export function oldLifeHoldBeganLine(hold: OldLifeHold, again = false): string {
  const tail = again ? OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL : 'the old life may still be running'
  return (
    `${OLD_LIFE_HOLD_LOG_PREFIX} began ${again ? 'again ' : ''}on ${holdQuoted(hold.realDirectory)} for oldKey=${holdKeyText(hold.oldKey)} ` +
    `(instanceId=${holdQuoted(hold.instanceId)}): ${OLD_LIFE_HOLD_CAUSE_WORDS[hold.cause] ?? hold.cause} — ${tail} (b.jg5 SRJ-809)`
  )
}

/**
 * The line a hold's end logs (SRJ-809): the directory as its real path, the
 * old key, the instance id, what ended it (with the read that did, when
 * given) and the personas recorded as waiting on it:
 *
 *   [slack] old-life hold: ended on "<real path>" for oldKey=<key> (instanceId="<id>"): <reason>[ (<read>)]; waiting personas: <keys|none> (b.jg5 SRJ-809)
 *
 * Carries no token and no file content. Pure.
 */
export function oldLifeHoldEndedLine(hold: OldLifeHold, reason: OldLifeHoldEndReason, read?: string): string {
  const by = read === undefined || read === '' ? '' : ` (${read})`
  const waiting = hold.waiting.length === 0 ? 'none' : hold.waiting.map(holdKeyText).join(', ')
  return (
    `${OLD_LIFE_HOLD_LOG_PREFIX} ended on ${holdQuoted(hold.realDirectory)} for oldKey=${holdKeyText(hold.oldKey)} ` +
    `(instanceId=${holdQuoted(hold.instanceId)}): ${OLD_LIFE_HOLD_END_WORDS[reason] ?? reason}${by}; waiting personas: ${waiting} (b.jg5 SRJ-809)`
  )
}

/**
 * The line a hold's end logs when one of its end observers threw (SRJ-809);
 * the other observers still run. `failure` is what it threw, rendered
 * (`describeThrownValue`):
 *
 *   [slack] old-life hold: an end observer failed for instanceId="<id>": <failure> (b.jg5 SRJ-809)
 *
 * Pure.
 */
export function oldLifeHoldEndObserverFailedLine(instanceId: string, failure: string): string {
  return `${OLD_LIFE_HOLD_LOG_PREFIX} an end observer failed for instanceId=${holdQuoted(instanceId)}: ${failure} (b.jg5 SRJ-809)`
}

/**
 * Build one server's old-life hold set (SRJ-809): in memory, empty, with no
 * timer, no file read or write and no agent-director call; nothing is shared
 * between two sets. Directories are compared by `deps.realPath` (default
 * `resolveRealPath`), resolved when compared, so a directory created or
 * removed after the begin compares by what it is now.
 */
export function createOldLifeHoldSet(deps: OldLifeHoldSetDeps): OldLifeHoldSet {
  const resolver = deps.realPath ?? resolveRealPath
  /** The holds, by instance id, in begin order. */
  const holds = new Map<string, OldLifeHoldState>()
  const observers: OldLifeHoldEndObserver[] = []

  const realOf = (path: string): string => {
    try {
      const real = resolver(path)
      return typeof real === 'string' ? real : resolve(path)
    } catch {
      return resolve(path)
    }
  }

  const viewOf = (state: OldLifeHoldState): OldLifeHold => ({
    instanceId: state.instanceId,
    oldKey: state.oldKey,
    directory: state.directory,
    realDirectory: realOf(state.directory),
    cause: state.cause,
    killFailed: state.killFailed,
    waiting: [...state.waiting].sort(),
  })

  const log = (line: string): void => safeLog(deps.log, line)

  /** The states the persona waits on: its own `cscb_<key>`'s, and each on its working directory. */
  const waitedOn = (persona: OldLifeHoldPersona): OldLifeHoldState[] => {
    const own = personaInstanceId(persona.key)
    const real = realOf(persona.working_directory)
    return [...holds.values()].filter((state) => state.instanceId === own || realOf(state.directory) === real)
  }

  function begin(input: OldLifeHoldBegin): OldLifeHold {
    const existing = holds.get(input.instanceId)
    if (existing !== undefined) {
      existing.cause = input.cause
      const view = viewOf(existing)
      log(oldLifeHoldBeganLine(view, true))
      return view
    }
    const state: OldLifeHoldState = {
      instanceId: input.instanceId,
      oldKey: input.oldKey,
      directory: input.directory,
      cause: input.cause,
      killFailed: false,
      waiting: new Set<string>(),
    }
    holds.set(input.instanceId, state)
    const view = viewOf(state)
    log(oldLifeHoldBeganLine(view))
    return view
  }

  function replaceDirectory(instanceId: string, cwd: string): boolean {
    const state = holds.get(instanceId)
    if (state === undefined || typeof cwd !== 'string' || cwd === '' || state.directory === cwd) return false
    state.directory = cwd
    return true
  }

  function end(instanceId: string, reason: OldLifeHoldEndReason, read?: string): OldLifeHold | undefined {
    const state = holds.get(instanceId)
    if (state === undefined) return undefined
    holds.delete(instanceId)
    const view = viewOf(state)
    log(oldLifeHoldEndedLine(view, reason, read))
    for (const observer of [...observers]) {
      try {
        observer(view, reason)
      } catch (err) {
        log(oldLifeHoldEndObserverFailedLine(instanceId, describeThrownValue(err)))
      }
    }
    return view
  }

  function markKillFailed(instanceId: string): boolean {
    const state = holds.get(instanceId)
    if (state === undefined) return false
    state.killFailed = true
    return true
  }

  function recordWaiting(instanceId: string, key: string): boolean {
    const state = holds.get(instanceId)
    if (state === undefined) return false
    state.waiting.add(key)
    return true
  }

  function forgetWaiting(key: string): void {
    for (const state of holds.values()) state.waiting.delete(key)
  }

  function onEnd(observer: OldLifeHoldEndObserver): () => void {
    observers.push(observer)
    return () => {
      const at = observers.indexOf(observer)
      if (at >= 0) observers.splice(at, 1)
    }
  }

  function holdsOnDirectory(directory: string): OldLifeHold[] {
    const real = realOf(directory)
    return [...holds.values()].filter((state) => realOf(state.directory) === real).map(viewOf)
  }

  return {
    begin,
    replaceDirectory,
    end,
    markKillFailed,
    recordWaiting,
    forgetWaiting,
    onEnd,
    holdsOnDirectory,
    holdOf: (instanceId) => {
      const state = holds.get(instanceId)
      return state === undefined ? undefined : viewOf(state)
    },
    holdsWaitedOnBy: (persona) => waitedOn(persona).map(viewOf),
    waitsOnKillFailed: (persona) => waitedOn(persona).some((state) => state.killFailed),
    snapshot: () => [...holds.values()].map(viewOf),
  }
}
