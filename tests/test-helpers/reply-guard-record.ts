/**
 * test-helpers/reply-guard-record.ts — Temp state directory with the
 * per-persona reply-guard record directory (b.av2 SR-9.4, SR-13.4).
 *
 * Layout (E10 Director decisions 3 and 5):
 *   - the server-side record code takes the state directory `stateDir`;
 *   - the records live at `<stateDir>/reply-guard/<key>`;
 *   - the guard's argument is the record directory `<stateDir>/reply-guard`,
 *     and the guard reads `<argument>/<CSCB_PERSONA>`.
 *
 * `makeReplyGuardRecordDir(opts?)` creates a fresh `mkdtempSync` state
 * directory and returns its absolute `stateDir` and `recordDir`, plus
 * methods to write, read and remove records. It produces the three setup
 * states the guard and bootstrap tests need:
 *   - record directory absent: the default (nothing but `stateDir` exists);
 *   - record directory present with no record for the key:
 *     `{ createRecordDir: true }`, or `ensureRecordDir()` later;
 *   - record present: `{ records: { [key]: content } }`, or `writeRecord`.
 * Content is written byte-for-byte, so `'true'`, `'false'`, `'true\n'`, `''`
 * and any other text are all expressible (`RECORD_TRUE` etc. name the common
 * ones).
 *
 * `{ spaceAndQuote: true }` places the state directory under a parent whose
 * name contains a space and a single quote, so a test can prove the managed
 * hook command quotes the record-directory argument.
 *
 * Independence: this helper builds the layout itself and imports no source
 * module, so tests can seed records without the code under test.
 *
 * Isolation (b.av2 SR-13.2): every path is under the OS temp directory or the
 * `parentDir` the caller passes (the test's own `mkdtempSync` directory). The
 * helper never reads `SLACK_STATE_DIR` or `HOME` and never resolves
 * `~/.claude/channels/slack`. `cleanup()` removes everything it created and
 * nothing else; call it in `afterEach` or `finally`.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Name of the record directory inside the state directory. */
export const REPLY_GUARD_DIR_NAME = 'reply-guard'

/** Record content meaning "remind" (no trailing newline). */
export const RECORD_TRUE = 'true'

/** Record content meaning "don't remind". */
export const RECORD_FALSE = 'false'

/** `true` followed by a newline, as `echo true >` would write it. */
export const RECORD_TRUE_NEWLINE = 'true\n'

/** An empty record file. */
export const RECORD_EMPTY = ''

/**
 * Prefix of the parent directory `spaceAndQuote` creates. It contains a space
 * and a single quote; `mkdtempSync` appends a random suffix.
 */
export const SPACE_QUOTE_PARENT_PREFIX = "cscb reply guard o'quote-"

/** Options for `makeReplyGuardRecordDir`. */
export interface ReplyGuardRecordDirOptions {
  /**
   * Directory to create the state directory in (or, with `spaceAndQuote`,
   * the space-and-quote parent in). Pass the test's own `mkdtempSync`
   * directory. Made absolute; must already exist. Defaults to the OS temp
   * directory. `cleanup()` never removes `parentDir` itself.
   */
  parentDir?: string
  /**
   * Put the state directory under a helper-created parent whose name
   * contains a space and a single quote (`SPACE_QUOTE_PARENT_PREFIX`).
   * `cleanup()` removes that parent too. Default `false`.
   */
  spaceAndQuote?: boolean
  /**
   * Create the empty record directory up front (setup state "record
   * directory present, no record"). Default `false` (record directory
   * absent). Implied when `records` is non-empty.
   */
  createRecordDir?: boolean
  /** Records to write up front, key to exact file content. */
  records?: Record<string, string>
}

/** A temp state directory with its reply-guard record directory. */
export interface ReplyGuardRecordDir {
  /** Absolute state directory (what the server-side record code takes). */
  stateDir: string
  /** Absolute record directory `<stateDir>/reply-guard` (the guard's argument). */
  recordDir: string
  /** Absolute path of `<recordDir>/<key>`. The file need not exist. */
  recordPath(key: string): string
  /** Create the record directory if absent. Returns `recordDir`. */
  ensureRecordDir(): string
  /**
   * Write `<recordDir>/<key>` with exactly `content`, creating the record
   * directory if needed. Returns the record path.
   */
  writeRecord(key: string, content: string): string
  /** Write several records (key to content). */
  writeRecords(records: Record<string, string>): void
  /** The record's exact content, or `null` when the file does not exist. */
  readRecord(key: string): string | null
  /** Delete `<recordDir>/<key>` if present; the record directory stays. */
  removeRecord(key: string): void
  /** Delete the record directory and every record in it; `stateDir` stays. */
  removeRecordDir(): void
  /** Remove everything the helper created. Safe to call more than once. */
  cleanup(): void
}

/**
 * Refuse a key that is not a single path segment, so a write can never land
 * outside `recordDir`. Any other name is allowed (uppercase, over-long,
 * spaces), because guard tests need records under keys the guard must reject.
 */
function assertSingleSegment(key: string): void {
  if (key === '' || key === '.' || key === '..' || key.includes('/') || key.includes('\\') || key.includes('\0')) {
    throw new Error(`reply-guard-record helper: key ${JSON.stringify(key)} is not a single path segment`)
  }
}

/**
 * Create a temp state directory (see the module comment for the layout,
 * setup states and options). Every returned path is absolute.
 */
export function makeReplyGuardRecordDir(opts: ReplyGuardRecordDirOptions = {}): ReplyGuardRecordDir {
  const base = resolve(opts.parentDir ?? tmpdir())
  // Top-most directory the helper created; cleanup removes exactly this.
  let created: string
  let stateDir: string
  if (opts.spaceAndQuote === true) {
    created = mkdtempSync(join(base, SPACE_QUOTE_PARENT_PREFIX))
    stateDir = mkdtempSync(join(created, 'state-'))
  } else {
    stateDir = mkdtempSync(join(base, 'cscb-reply-guard-state-'))
    created = stateDir
  }
  const recordDir = join(stateDir, REPLY_GUARD_DIR_NAME)

  const recordPath = (key: string): string => {
    assertSingleSegment(key)
    return join(recordDir, key)
  }
  const ensureRecordDir = (): string => {
    mkdirSync(recordDir, { recursive: true })
    return recordDir
  }
  const writeRecord = (key: string, content: string): string => {
    const path = recordPath(key)
    ensureRecordDir()
    writeFileSync(path, content)
    return path
  }
  const writeRecords = (records: Record<string, string>): void => {
    for (const [key, content] of Object.entries(records)) writeRecord(key, content)
  }

  const handle: ReplyGuardRecordDir = {
    stateDir,
    recordDir,
    recordPath,
    ensureRecordDir,
    writeRecord,
    writeRecords,
    readRecord(key) {
      const path = recordPath(key)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    removeRecord(key) {
      rmSync(recordPath(key), { force: true })
    },
    removeRecordDir() {
      rmSync(recordDir, { recursive: true, force: true })
    },
    cleanup() {
      rmSync(created, { recursive: true, force: true })
    },
  }

  try {
    if (opts.createRecordDir === true) ensureRecordDir()
    if (opts.records !== undefined) writeRecords(opts.records)
  } catch (err) {
    handle.cleanup()
    throw err
  }
  return handle
}
