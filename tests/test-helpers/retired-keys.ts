/**
 * test-helpers/retired-keys.ts — The retired-key record for tests (b.jg5
 * SRJ-1304): `writeRetiredKeysRecord` seeds the record in a state directory
 * and `readRetiredKeysRecord` reads it back.
 *
 * Both go through `src/retired-keys.ts` itself: the file's name and path
 * (`retiredKeysPath`), its bytes (`serializeRetiredKeys`) and its parse
 * (`parseRetiredKeys`). No test writes the record by hand: never a JSON
 * literal of the record, never the file name typed as a string. A test that
 * needs a malformed record alters what the serialiser wrote.
 *
 * - `writeRetiredKeysRecord(stateDir, entries)`: the entries by key, each
 *   with its cause and, optionally, its `retired_at` and its
 *   `new_life_begun_at` (a mark, or none). Unset times come from the samples
 *   this module exports (`SAMPLE_RETIRED_AT`, and `SAMPLE_NEW_LIFE_BEGUN_AT`
 *   for a mark), never typed per test. Answers the record's path.
 * - `readRetiredKeysRecord(stateDir)`: the record parsed by the module's
 *   parser, or `null` when there is no file, so an absent file is told apart
 *   from an empty record. A file the parser refuses throws, naming the
 *   parser's problem (which carries no file content).
 *
 * Isolation (b.jg5 SRJ-1301): both take the state directory explicitly and
 * never resolve a default one; the writer writes only the record in that
 * directory, and refuses the real home and any directory not under the OS
 * temp directory. No module-scope state, no process started.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  parseRetiredKeys,
  retiredKeysPath,
  serializeRetiredKeys,
  type RetiredKeyCause,
  type RetiredKeyEntry,
  type RetiredKeyRecord,
} from '../../src/retired-keys.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'

/** The `retired_at` a seeded entry gets when the test gives none (RFC 3339 UTC, ending in `Z`). */
export const SAMPLE_RETIRED_AT = '2026-05-24T12:00:00.000Z'

/** The `new_life_begun_at` a seeded mark gets when the test sets the mark with no time of its own. */
export const SAMPLE_NEW_LIFE_BEGUN_AT = '2026-05-24T12:05:00.000Z'

/** One entry to seed. */
export interface RetiredKeySeed {
  /** What recorded the key. */
  readonly cause: RetiredKeyCause
  /** When it was recorded; `SAMPLE_RETIRED_AT` when unset. */
  readonly retiredAt?: string
  /**
   * The "new life has begun" mark: `true` for `SAMPLE_NEW_LIFE_BEGUN_AT`, a
   * timestamp for that time, `false`, `null` or unset for no mark.
   */
  readonly mark?: boolean | string | null
}

/** The record `entries` describe, as the module holds it in memory. */
export function retiredKeysRecordOf(entries: Readonly<Record<string, RetiredKeySeed>>): RetiredKeyRecord {
  const record = new Map<string, RetiredKeyEntry>()
  for (const [key, seed] of Object.entries(entries)) {
    const mark = seed.mark === true ? SAMPLE_NEW_LIFE_BEGUN_AT : typeof seed.mark === 'string' ? seed.mark : null
    record.set(key, { retiredAt: seed.retiredAt ?? SAMPLE_RETIRED_AT, cause: seed.cause, newLifeBegunAt: mark })
  }
  return record
}

/**
 * Write the record holding `entries` in `stateDir`, through the module's
 * serialiser, and answer its path. Throws, writing nothing, when `stateDir`
 * is the real home or is not under the OS temp directory.
 */
export function writeRetiredKeysRecord(stateDir: string, entries: Readonly<Record<string, RetiredKeySeed>>): string {
  const dir = resolve(stateDir)
  const tempDir = osTempDir()
  if (isRealHome(dir)) throw new Error('writeRetiredKeysRecord: refusing the real home; pass a mkdtempSync state directory')
  if (dir === tempDir || !isUnder(dir, tempDir)) {
    throw new Error('writeRetiredKeysRecord: the state directory must be a directory under the OS temp directory')
  }
  const path = retiredKeysPath(dir)
  writeFileSync(path, serializeRetiredKeys(retiredKeysRecordOf(entries)))
  return path
}

/**
 * The record in `stateDir`, parsed by the module's parser, or `null` when
 * there is no file. Throws when the parser refuses the file.
 */
export function readRetiredKeysRecord(stateDir: string): RetiredKeyRecord | null {
  const path = retiredKeysPath(resolve(stateDir))
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = parseRetiredKeys(bytes)
  if (!parsed.ok) throw new Error(`readRetiredKeysRecord: "${path}" ${parsed.problem}`)
  return parsed.record
}
