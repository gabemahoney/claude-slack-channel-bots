/**
 * retired-keys.test.ts — The retired-key record, src/retired-keys.ts (b.jg5
 * SRJ-801, SRJ-802; the primitives SRJ-803, SRJ-804, SRJ-806, SRJ-807 build
 * on; SRJ-1013's `retired-keys-unreadable` row; SRJ-1304's helper round trip).
 *
 * - Location (SRJ-801): `retired-keys.json` in the given state directory, no
 *   temporary file left; the default directory follows `SLACK_STATE_DIR` at
 *   call time; a new store over the same directory reads what an earlier one
 *   wrote.
 * - Format (SRJ-802): a round trip through the serialiser and the parser and
 *   through the store; `version` 1; RFC 3339 UTC timestamps equal to the
 *   injected clock's time; a key that is no persona key is accepted.
 * - The primitives: a batch record is one write; re-recording a marked key
 *   clears its mark, an unmarked one writes nothing; mark; clear; restore of
 *   the record held before a batch (SRJ-804: the file removed only when that
 *   record is empty, an empty record written when the remove fails, and the
 *   keys and marks held in memory kept).
 * - The start read: a missing file is an empty record and writes nothing; a
 *   valid record grown past the readers' size limit loads whole; a file that
 *   cannot be read, parsed or validated (each form built by altering the
 *   serialiser's output, never a literal) records exactly one
 *   `retired-keys-unreadable` entry, read from a temp `logDir`, whose text is
 *   the module's builder, and no store (an unknown cause's problem lists the
 *   module's causes); a real FIFO is refused without blocking, in a child
 *   process; the entry echoes no file content.
 * - Interrupted writes, through `durableWriteFileSync`'s `DurableWriteFs`
 *   seam (the tests/atomic-write.test.ts pattern): a failure before the rename
 *   leaves the previous bytes and the previous record in memory; a directory
 *   sync failure has the previous bytes written back.
 * - Held changes (SRJ-714, SRJ-806, SRJ-807; hatch A3): the keys of a failed
 *   `absent-at-start` batch and a failed mark stay in memory, the next write
 *   that succeeds carries them, and `isHeldInMemory` tells which keys are held.
 *
 * Isolation: every file sits under a per-test `mkdtempSync` root removed in
 * `afterEach`; the store's clock is a `createFakeClock`; the record is
 * seeded and read only through tests/test-helpers/retired-keys.ts or the
 * module's own serialiser; constants, causes, labels and texts come from
 * src/, but for the one pin case. No `mock.module`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { durableUnlinkSync, durableWriteFileSync, type DurableWriteFs } from '../src/atomic-write.ts'
import {
  CONFIG_NOT_REGULAR_FILE_CODE,
  configReadFailurePredicate,
  MAX_RELOAD_FILE_BYTES,
  type PersonaConfigFs,
} from '../src/config.ts'
import {
  loadRetiredKeyStore,
  parseRetiredKeys,
  readRetiredKeysAtStart,
  RETIRED_KEY_CAUSE_ABSENT_AT_START,
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY,
  RETIRED_KEY_CAUSE_REMOVED,
  RETIRED_KEY_CAUSES,
  RETIRED_KEYS_FILE_NAME,
  RETIRED_KEYS_FORMAT_VERSION,
  RETIRED_KEYS_LOG_PREFIX,
  RETIRED_KEYS_NOT_RECORDED,
  RETIRED_KEYS_REMOVED,
  RETIRED_KEYS_UNCHANGED,
  RETIRED_KEYS_UNREADABLE_LABEL,
  RETIRED_KEYS_WRITE_FAILED,
  RETIRED_KEYS_WRITTEN,
  retiredKeysPath,
  retiredKeysUnreadableMessage,
  serializeRetiredKeys,
  type RetiredKeyEntry,
  type RetiredKeyRecord,
  type RetiredKeyStore,
  type RetiredKeysWriter,
} from '../src/retired-keys.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import {
  readRetiredKeysRecord,
  retiredKeysRecordOf,
  SAMPLE_NEW_LIFE_BEGUN_AT,
  SAMPLE_RETIRED_AT,
  writeRetiredKeysRecord,
  type RetiredKeySeed,
} from './test-helpers/retired-keys.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The fake clock's start: a whole second, so every stamp is distinct from the helper's samples. */
const START_MS = Date.UTC(2026, 9, 2, 9, 30, 0)

/** RFC 3339 UTC, written with `T` and ending in `Z`, as the server writes it. */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

let root: string
/** The state directory under test. */
let dir: string
/** The startup-errors log directory (`recordStartupError`'s `logDir`). */
let logDir: string
let savedStateDirEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cscb-retired-keys-'))
  dir = join(root, 'state')
  logDir = join(root, 'logs')
  mkdirSync(dir)
  savedStateDirEnv = process.env['SLACK_STATE_DIR']
})

afterEach(() => {
  if (savedStateDirEnv === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = savedStateDirEnv
  rmSync(root, { recursive: true, force: true })
})

/** An errno-style error, as `node:fs` throws. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected failure`), { code })
}

/** The record file's bytes, or null when there is none. */
function fileBytes(): Uint8Array | null {
  const path = retiredKeysPath(dir)
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null
}

/** A store over `dir` and what it did: its writer's and remover's calls, its log lines. */
interface Rig {
  store: RetiredKeyStore
  clock: FakeClock
  logs: string[]
  /** The bytes of every writer call, failed ones included. */
  writes: Uint8Array[]
  removes: string[]
  /** Thrown by every writer call while set, before the file is touched. */
  writeFails: Error | undefined
  /** Thrown by every remover call while set, before the file is touched. */
  removeFails: Error | undefined
  /** The clock's time as the store writes it. */
  stamp(): string
}

/**
 * Load the store over `dir` with a fake clock and recording writer and
 * remover over the real durable primitives. `write` replaces the writer (a
 * `DurableWriteFs` seam). Fails unless the store loads.
 */
function openStore(opts: { write?: RetiredKeysWriter; clock?: FakeClock } = {}): Rig {
  const clock = opts.clock ?? createFakeClock({ start: START_MS })
  const rig: Rig = {
    store: undefined as unknown as RetiredKeyStore,
    clock,
    logs: [],
    writes: [],
    removes: [],
    writeFails: undefined,
    removeFails: undefined,
    stamp: () => new Date(clock.now()).toISOString(),
  }
  const loaded = loadRetiredKeyStore(dir, {
    log: (line) => rig.logs.push(line),
    now: () => clock.now(),
    write: (path, bytes) => {
      rig.writes.push(bytes)
      if (rig.writeFails !== undefined) throw rig.writeFails
      ;(opts.write ?? durableWriteFileSync)(path, bytes)
    },
    remove: (path) => {
      rig.removes.push(path)
      if (rig.removeFails !== undefined) throw rig.removeFails
      return durableUnlinkSync(path)
    },
  })
  if (loaded.kind !== 'loaded') throw new Error(`the store did not load: ${loaded.message}`)
  rig.store = loaded.store
  return rig
}

/** The record a fresh store over `dir` reads (SRJ-801: a new server instance). */
function freshRecord(): RetiredKeyRecord {
  return openStore().store.snapshot().entries
}

/** Two retired keys: `alpha` marked, `beta` not. */
const SEED: Readonly<Record<string, RetiredKeySeed>> = {
  alpha: { cause: RETIRED_KEY_CAUSE_REMOVED, mark: true },
  beta: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY },
}

// ---------------------------------------------------------------------------
// The SRD's values (the one place they are typed)
// ---------------------------------------------------------------------------

describe('the record\'s fixed values (b.jg5 SRJ-801, SRJ-802, SRJ-1013)', () => {
  test('pin: the file name, the format version, the three causes in the format\'s order and the startup-errors class', () => {
    expect([RETIRED_KEYS_FILE_NAME, RETIRED_KEYS_FORMAT_VERSION, [...RETIRED_KEY_CAUSES], RETIRED_KEYS_UNREADABLE_LABEL]).toEqual([
      'retired-keys.json',
      1,
      ['removed', 'destructive-modify', 'absent-at-start'],
      'retired-keys-unreadable',
    ])
  })
})

// ---------------------------------------------------------------------------
// Location (SRJ-801)
// ---------------------------------------------------------------------------

describe('where the record lives (b.jg5 SRJ-801)', () => {
  test('a store over a state directory writes exactly <dir>/<file name> and leaves no temporary file', () => {
    const rig = openStore()
    expect(rig.store.path).toBe(join(dir, RETIRED_KEYS_FILE_NAME))

    expect(rig.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome).toBe(RETIRED_KEYS_WRITTEN)

    expect(readdirSync(dir)).toEqual([RETIRED_KEYS_FILE_NAME])
  })

  test('with no directory given, the path follows SLACK_STATE_DIR as it is at call time; a given directory wins', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    process.env['SLACK_STATE_DIR'] = first
    expect(retiredKeysPath()).toBe(join(first, RETIRED_KEYS_FILE_NAME))
    process.env['SLACK_STATE_DIR'] = second
    expect(retiredKeysPath()).toBe(join(second, RETIRED_KEYS_FILE_NAME))
    expect(retiredKeysPath(dir)).toBe(join(dir, RETIRED_KEYS_FILE_NAME))
  })

  test('a new store over the same directory reads what an earlier one wrote (a server restart)', async () => {
    const earlier = openStore()
    earlier.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED }, { key: 'beta', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY }])
    await earlier.clock.advance(1_000)
    earlier.store.mark('alpha')

    const later = openStore()
    expect(later.store.keys()).toEqual(['alpha', 'beta'])
    expect(later.store.snapshot().entries).toEqual(earlier.store.snapshot().entries)
    expect(later.store.isMarked('alpha')).toBe(true)
    expect(later.store.isMarked('beta')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Format and round trip (SRJ-802, SRJ-1304)
// ---------------------------------------------------------------------------

describe('the record\'s format and round trip (b.jg5 SRJ-802, SRJ-1304)', () => {
  test('the parser reads back exactly what the serialiser writes: every cause, a mark and none, and keys that are no persona key', () => {
    const record = retiredKeysRecordOf({
      ...Object.fromEntries(RETIRED_KEY_CAUSES.map((cause) => [`key-${cause}`, { cause }])),
      'Not A Persona Key!': { cause: RETIRED_KEY_CAUSE_ABSENT_AT_START, mark: true },
      ['__proto__']: { cause: RETIRED_KEY_CAUSE_REMOVED },
    })
    const parsed = parseRetiredKeys(serializeRetiredKeys(record))
    expect(parsed).toEqual({ ok: true, record })
    expect(parseRetiredKeys(serializeRetiredKeys(new Map()))).toEqual({ ok: true, record: new Map() })
  })

  test('the store\'s record, mark and clear read back through a fresh store and the helper: version 1, the clock\'s RFC 3339 UTC times, a new key unmarked', async () => {
    const rig = openStore()
    const recordedAt = rig.stamp()
    rig.store.record([...RETIRED_KEY_CAUSES.map((cause) => ({ key: `key-${cause}`, cause })), { key: 'gone', cause: RETIRED_KEY_CAUSE_REMOVED }])
    await rig.clock.advance(5_000)
    const markedAt = rig.stamp()
    const marked = `key-${RETIRED_KEY_CAUSE_REMOVED}`
    rig.store.mark(marked)
    rig.store.clear('gone')

    const expected = new Map(
      RETIRED_KEY_CAUSES.map((cause) => [`key-${cause}`, { retiredAt: recordedAt, cause, newLifeBegunAt: `key-${cause}` === marked ? markedAt : null }]),
    )
    expect(freshRecord()).toEqual(expected)
    expect(readRetiredKeysRecord(dir)).toEqual(expected)
    expect(JSON.parse(new TextDecoder().decode(fileBytes()!)).version).toBe(RETIRED_KEYS_FORMAT_VERSION)
    for (const stamp of [recordedAt, markedAt]) expect(stamp).toMatch(RFC3339_UTC)
    expect(rig.store.entry(`key-${RETIRED_KEY_CAUSE_ABSENT_AT_START}`)!.newLifeBegunAt).toBeNull()
  })

  test('helper round trip: what writeRetiredKeysRecord writes the store reads, and what the store writes readRetiredKeysRecord reads; an absent file reads null, an empty record an empty map', () => {
    expect(readRetiredKeysRecord(dir)).toBeNull()
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()
    expect(rig.store.snapshot().entries).toEqual(retiredKeysRecordOf(SEED))
    expect(rig.store.entry('alpha')!.newLifeBegunAt).toBe(SAMPLE_NEW_LIFE_BEGUN_AT)

    rig.store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START }])
    expect(readRetiredKeysRecord(dir)).toEqual(rig.store.snapshot().entries)

    for (const key of rig.store.keys()) rig.store.clear(key)
    expect(readRetiredKeysRecord(dir)).toEqual(new Map())
  })
})

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

describe('record, mark and clear (b.jg5 SRJ-803, SRJ-806, SRJ-807)', () => {
  test('a batch is one write; a new key gets the clock\'s time, its cause and no mark', () => {
    const rig = openStore()
    const result = rig.store.record([
      { key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED },
      { key: 'beta', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY },
      { key: 'gamma', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START },
    ])
    expect(result.outcome).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.writes).toHaveLength(1)
    expect(rig.store.entry('beta')).toEqual({ retiredAt: rig.stamp(), cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, newLifeBegunAt: null })
  })

  test('re-recording a marked key clears its mark and updates retired_at and cause, in one write', async () => {
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()
    await rig.clock.advance(60_000)

    expect(rig.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY }]).outcome).toBe(RETIRED_KEYS_WRITTEN)

    expect(rig.writes).toHaveLength(1)
    const now: RetiredKeyEntry = { retiredAt: rig.stamp(), cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, newLifeBegunAt: null }
    expect(rig.store.entry('alpha')).toEqual(now)
    expect(readRetiredKeysRecord(dir)!.get('alpha')).toEqual(now)
  })

  test('re-recording an unmarked key with any cause makes no writer call and leaves its entry', () => {
    writeRetiredKeysRecord(dir, SEED)
    const before = fileBytes()
    const rig = openStore()

    const result = rig.store.record([{ key: 'beta', cause: RETIRED_KEY_CAUSE_REMOVED }])

    expect(result.outcome).toBe(RETIRED_KEYS_UNCHANGED)
    expect(rig.writes).toEqual([])
    expect(rig.store.entry('beta')).toEqual(retiredKeysRecordOf(SEED).get('beta'))
    expect(fileBytes()).toEqual(before)
    expect(rig.logs).toEqual([])
  })

  test.each([
    ['an empty key', '', RETIRED_KEY_CAUSE_REMOVED],
    ['an unknown cause', 'alpha', 'retired'],
  ])('record throws a RangeError on %s before any change or write', (_label, key, cause) => {
    const rig = openStore()
    expect(() => rig.store.record([{ key: 'ok', cause: RETIRED_KEY_CAUSE_REMOVED }, { key, cause } as never])).toThrow(RangeError)
    expect(rig.writes).toEqual([])
    expect(rig.store.keys()).toEqual([])
  })

  test('mark sets the clock\'s time in one write; a key not recorded, or already marked, writes nothing', async () => {
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()
    await rig.clock.advance(1_000)

    expect(rig.store.mark('gamma')).toBe(RETIRED_KEYS_NOT_RECORDED)
    expect(rig.store.mark('alpha')).toBe(RETIRED_KEYS_UNCHANGED)
    expect(rig.writes).toEqual([])

    expect(rig.store.mark('beta')).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.writes).toHaveLength(1)
    expect(readRetiredKeysRecord(dir)!.get('beta')!.newLifeBegunAt).toBe(rig.stamp())
  })

  test('clear removes only that key\'s entry in one write; a key not recorded writes nothing; clearing the last entry writes an empty record', () => {
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()

    expect(rig.store.clear('gamma')).toBe(RETIRED_KEYS_NOT_RECORDED)
    expect(rig.writes).toEqual([])

    expect(rig.store.clear('alpha')).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.writes).toHaveLength(1)
    expect(readRetiredKeysRecord(dir)).toEqual(new Map([['beta', retiredKeysRecordOf(SEED).get('beta')!]]))

    expect(rig.store.clear('beta')).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.removes).toEqual([])
    expect(readRetiredKeysRecord(dir)).toEqual(new Map())
  })

  test('each change and each failed write logs one line naming the file; a change that writes nothing logs nothing; a throwing log changes nothing', () => {
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()
    rig.store.record([{ key: 'beta', cause: RETIRED_KEY_CAUSE_REMOVED }])
    rig.store.mark('alpha')
    rig.store.clear('gamma')
    expect(rig.logs).toEqual([])

    rig.store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }])
    rig.store.mark('gamma')
    rig.writeFails = errnoError('EIO')
    rig.store.clear('gamma')
    expect(rig.logs).toHaveLength(3)
    for (const line of rig.logs) {
      expect(line.startsWith(RETIRED_KEYS_LOG_PREFIX)).toBe(true)
      expect(line).toContain(rig.store.path)
    }

    const loaded = loadRetiredKeyStore(dir, { log: () => { throw new Error('log down') } })
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') expect(loaded.store.clear('gamma')).toBe(RETIRED_KEYS_WRITTEN)
  })
})

describe('restore puts back the record held before a batch (b.jg5 SRJ-804)', () => {
  test('after a written batch: the keys it recorded removed, the mark it cleared restored, earlier keys kept, the previous bytes exactly', async () => {
    writeRetiredKeysRecord(dir, SEED)
    const before = fileBytes()
    const rig = openStore()
    await rig.clock.advance(1_000)
    const { outcome, snapshot } = rig.store.record([
      { key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED },
      { key: 'gamma', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY },
    ])
    expect(outcome).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.store.isMarked('alpha')).toBe(false)

    expect(rig.store.restore(snapshot)).toBe(RETIRED_KEYS_WRITTEN)

    expect(fileBytes()).toEqual(before)
    expect(rig.store.snapshot().entries).toEqual(retiredKeysRecordOf(SEED))
    expect(freshRecord()).toEqual(retiredKeysRecordOf(SEED))
  })

  test.each([
    ['an absent file stays absent', false],
    ['a file holding an empty record is removed', true],
  ])('to a record that was empty: %s', (_label, emptyFile) => {
    if (emptyFile) writeRetiredKeysRecord(dir, {})
    const rig = openStore()
    const { snapshot } = rig.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED }])

    expect(rig.store.restore(snapshot)).toBe(RETIRED_KEYS_REMOVED)

    expect(readdirSync(dir)).toEqual([])
    expect(rig.store.keys()).toEqual([])
  })

  test('to an empty record whose file cannot be removed: an empty record is written in its place', () => {
    const rig = openStore()
    const { snapshot } = rig.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED }])
    rig.removeFails = errnoError('EACCES')

    expect(rig.store.restore(snapshot)).toBe(RETIRED_KEYS_WRITTEN)

    expect(readRetiredKeysRecord(dir)).toEqual(new Map())
    expect(rig.store.keys()).toEqual([])
  })

  test('a restore that cannot remove or write leaves the keys it could not remove retired, in memory and in the file', () => {
    const rig = openStore()
    const { snapshot } = rig.store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_REMOVED }])
    const written = fileBytes()
    rig.removeFails = errnoError('EACCES')
    rig.writeFails = errnoError('EIO')

    expect(rig.store.restore(snapshot)).toBe(RETIRED_KEYS_WRITE_FAILED)

    expect(rig.store.isRecorded('alpha')).toBe(true)
    expect(fileBytes()).toEqual(written)
  })

  test('the restored record keeps the keys and marks held only in memory before the batch', async () => {
    writeRetiredKeysRecord(dir, { beta: { cause: RETIRED_KEY_CAUSE_REMOVED } })
    const rig = openStore()
    rig.writeFails = errnoError('EIO')
    rig.store.record([{ key: 'held', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START }])
    const heldAt = rig.stamp()
    await rig.clock.advance(1_000)
    rig.store.mark('beta')
    const markedAt = rig.stamp()
    rig.writeFails = undefined
    await rig.clock.advance(1_000)

    const { outcome, snapshot } = rig.store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }])
    expect(outcome).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.store.restore(snapshot)).toBe(RETIRED_KEYS_WRITTEN)

    const expected = new Map<string, RetiredKeyEntry>([
      ['beta', { retiredAt: SAMPLE_RETIRED_AT, cause: RETIRED_KEY_CAUSE_REMOVED, newLifeBegunAt: markedAt }],
      ['held', { retiredAt: heldAt, cause: RETIRED_KEY_CAUSE_ABSENT_AT_START, newLifeBegunAt: null }],
    ])
    expect(rig.store.snapshot().entries).toEqual(expected)
    expect(freshRecord()).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// The start read (SRJ-802, SRJ-1013)
// ---------------------------------------------------------------------------

/** The startup-errors entries the real `recordStartupError` wrote to the temp `logDir`. */
function startupEntries(): string[] {
  const path = join(logDir, 'startup-errors.log')
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter((line) => line !== '') : []
}

/** The start read over `dir`, recording through the real `recordStartupError` into the temp `logDir`. */
function startRead(readFs?: Partial<PersonaConfigFs>, logs: string[] = []) {
  return readRetiredKeysAtStart(dir, {
    log: (line) => logs.push(line),
    readFs,
    recordStartupError: (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir }),
  })
}

/** The seed's bytes, as the serialiser writes them. */
const seededBytes = (): Uint8Array => serializeRetiredKeys(retiredKeysRecordOf(SEED))

/** The seed's serialised record, parsed, altered by `alter` (which may return a replacement) and written back as JSON. */
function altered(alter: (doc: Record<string, any>) => unknown): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(seededBytes()))
  const out = alter(doc)
  return new TextEncoder().encode(JSON.stringify(out === undefined ? doc : out))
}

/** `bytes` with `prefix` in front. */
const prefixed = (prefix: number[], bytes: Uint8Array): Uint8Array => new Uint8Array([...prefix, ...bytes])

describe('the start read (b.jg5 SRJ-802, SRJ-1013)', () => {
  test('a missing file: an empty record, nothing written, no startup-errors entry', () => {
    const logs: string[] = []
    const outcome = startRead(undefined, logs)
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind === 'loaded') expect(outcome.store.keys()).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    expect(startupEntries()).toEqual([])
    expect(logs).toEqual([])
  })

  test('a valid record loads, logs nothing and records no entry', () => {
    writeRetiredKeysRecord(dir, SEED)
    const logs: string[] = []
    const outcome = startRead(undefined, logs)
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind === 'loaded') expect(outcome.store.snapshot().entries).toEqual(retiredKeysRecordOf(SEED))
    expect([logs, startupEntries()]).toEqual([[], []])
  })

  test('a valid record grown past the readers\' size limit by real entries loads whole: every entry, no log, no entry, no refusal', () => {
    const seeds: Record<string, RetiredKeySeed> = {}
    for (let i = 0; serializeRetiredKeys(retiredKeysRecordOf(seeds)).length <= MAX_RELOAD_FILE_BYTES; i++) {
      seeds[`persona-${String(i).padStart(5, '0')}`] = { cause: RETIRED_KEY_CAUSES[i % RETIRED_KEY_CAUSES.length]!, mark: i % 2 === 0 }
    }
    writeRetiredKeysRecord(dir, seeds)
    expect(fileBytes()!.length).toBeGreaterThan(MAX_RELOAD_FILE_BYTES)
    const logs: string[] = []

    const outcome = startRead(undefined, logs)

    expect(outcome.kind).toBe('loaded')
    if (outcome.kind === 'loaded') expect(outcome.store.snapshot().entries).toEqual(retiredKeysRecordOf(seeds))
    expect([logs, startupEntries()]).toEqual([[], []])
  })

  test('a cause the format does not name: the problem lists the causes from the module, in the format\'s order, and echoes no file content', () => {
    const unknownCause = 'unlisted-cause-value'
    const bytes = altered((doc) => { doc.keys.beta.cause = unknownCause })
    const causes = `${RETIRED_KEY_CAUSES.slice(0, -1).join(', ')} or ${RETIRED_KEY_CAUSES.at(-1)}`

    const parsed = parseRetiredKeys(bytes)

    // `beta` is the seed's second key, and the problem names an entry by its position.
    expect(parsed).toEqual({ ok: false, problem: `is invalid: entry 2 of \`keys\` has a \`cause\` that is not one of ${causes}` })
    const path = retiredKeysPath(dir)
    writeFileSync(path, bytes)
    expect(startRead()).toEqual({ kind: 'refused', path })
    const entries = startupEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEndWith(retiredKeysUnreadableMessage(path, (parsed as { problem: string }).problem))
    expect(entries[0]).not.toContain(unknownCause)
    expect(entries[0]).not.toContain('beta')
  })

  // Each malformed form is the seed's serialised bytes altered. The problem is
  // the parser's own; the case checks it is refused and how the start reports it.
  const MALFORMED: Array<[string, () => Uint8Array]> = [
    ['not JSON (cut short)', () => seededBytes().slice(0, 40)],
    ['not UTF-8', () => prefixed([0xff], seededBytes())],
    ['a byte order mark', () => prefixed([0xef, 0xbb, 0xbf], seededBytes())],
    ['a top level that is not an object', () => altered((doc) => [doc])],
    ['no version', () => altered((doc) => { delete doc.version })],
    ['a version other than 1', () => altered((doc) => { doc.version = RETIRED_KEYS_FORMAT_VERSION + 1 })],
    ['a version given as a string', () => altered((doc) => { doc.version = String(doc.version) })],
    ['no keys', () => altered((doc) => { delete doc.keys })],
    ['keys that are an array', () => altered((doc) => { doc.keys = Object.values(doc.keys) })],
    ['a top-level field the format does not name', () => altered((doc) => { doc.extra = true })],
    ['an entry that is not an object', () => altered((doc) => { doc.keys.beta = doc.keys.beta.cause })],
    ['an entry field the format does not name', () => altered((doc) => { doc.keys.alpha.note = 'x' })],
    ['an entry with no retired_at', () => altered((doc) => { delete doc.keys.alpha.retired_at })],
    ['an entry with no cause', () => altered((doc) => { delete doc.keys.alpha.cause })],
    ['an entry with no new_life_begun_at', () => altered((doc) => { delete doc.keys.beta.new_life_begun_at })],
    ['a retired_at that does not end in Z', () => altered((doc) => { doc.keys.beta.retired_at = doc.keys.beta.retired_at.replace(/Z$/, '+00:00') })],
    ['a retired_at that is null', () => altered((doc) => { doc.keys.beta.retired_at = null })],
    ['a retired_at on a day that does not exist', () => altered((doc) => { doc.keys.beta.retired_at = doc.keys.beta.retired_at.replace(/^(\d{4})-\d{2}-\d{2}/, '$1-02-30') })],
    ['a new_life_begun_at that is a number', () => altered((doc) => { doc.keys.alpha.new_life_begun_at = 0 })],
    ['a new_life_begun_at that does not end in Z', () => altered((doc) => { doc.keys.alpha.new_life_begun_at = doc.keys.alpha.new_life_begun_at.replace(/Z$/, '+00:00') })],
    ['an empty key', () => altered((doc) => { doc.keys[''] = doc.keys.beta })],
  ]

  test.each(MALFORMED)('%s: refused with exactly one retired-keys-unreadable entry whose text is the builder\'s, and no store', (_label, build) => {
    const bytes = build()
    const parsed = parseRetiredKeys(bytes)
    expect(parsed.ok).toBe(false)
    const path = retiredKeysPath(dir)
    writeFileSync(path, bytes)
    const logs: string[] = []

    expect(startRead(undefined, logs)).toEqual({ kind: 'refused', path })

    const entries = startupEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEndWith(` [${RETIRED_KEYS_UNREADABLE_LABEL}] ${retiredKeysUnreadableMessage(path, (parsed as { problem: string }).problem)}`)
    expect(logs).toEqual([])
    expect(new Uint8Array(readFileSync(path)) as Uint8Array).toEqual(bytes)
  })

  const UNREADABLE: Array<[string, () => Partial<PersonaConfigFs> | undefined, string | undefined]> = [
    ['a directory at the path', () => { mkdirSync(retiredKeysPath(dir)); return undefined }, 'EISDIR'],
    ['an open that fails (EACCES, through the read seam)', () => ({ openFile: () => { throw errnoError('EACCES') } }), 'EACCES'],
    ['a read that fails (EIO, through the read seam)', () => ({ readFileFd: () => { throw errnoError('EIO') } }), 'EIO'],
    ['a path that is not a regular file (as fstat reports it)', () => ({ fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }), CONFIG_NOT_REGULAR_FILE_CODE],
  ]

  test.each(UNREADABLE)('%s: refused with exactly one retired-keys-unreadable entry naming the file and the read failure', (_label, setUp, code) => {
    const readFs = setUp()
    if (!existsSync(retiredKeysPath(dir))) writeRetiredKeysRecord(dir, SEED)
    const path = retiredKeysPath(dir)

    expect(startRead(readFs)).toEqual({ kind: 'refused', path })

    const entries = startupEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEndWith(` [${RETIRED_KEYS_UNREADABLE_LABEL}] ${retiredKeysUnreadableMessage(path, configReadFailurePredicate(code))}`)
  })

  test('the refusal names the file, what is wrong and the move-aside remedy', () => {
    const path = retiredKeysPath(dir)
    const problem = configReadFailurePredicate('EACCES')
    const message = retiredKeysUnreadableMessage(path, problem)
    expect(message).toContain(`"${path}" ${problem}`)
    expect(message).toMatch(/aside/)
  })

  test.skipIf(!mkfifoAvailable())('a real FIFO at the path with no writer: refused at once, unread, with one entry (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    const path = retiredKeysPath(dir)
    makeFifo(path)
    const home = join(root, 'home')
    mkdirSync(home)
    const modulePath = join(import.meta.dir, '..', 'src', 'retired-keys.ts')
    const script = `
      const mod = await import(${JSON.stringify(modulePath)})
      const entries = []
      const outcome = mod.readRetiredKeysAtStart(${JSON.stringify(dir)}, { log: () => {}, recordStartupError: (c, m) => entries.push([c, m]) })
      console.log(JSON.stringify({ outcome, entries }))
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      timeout: 10_000,
      encoding: 'utf-8',
      env: hostSafeChildEnv(home, { tools: [], extras: { SLACK_STATE_DIR: join(home, 'state') } }),
    })

    expect(child.signal).toBeNull()
    expect(JSON.parse(child.stdout.trim())).toEqual({
      outcome: { kind: 'refused', path },
      entries: [[RETIRED_KEYS_UNREADABLE_LABEL, retiredKeysUnreadableMessage(path, configReadFailurePredicate(CONFIG_NOT_REGULAR_FILE_CODE))]],
    })
  }, 15_000)

  test.each<[string, () => Uint8Array]>([
    ['not JSON, cut short right after a token', () => {
      const token = fakeToken(BOT_TOKEN_PREFIX, 'cut')
      const text = new TextDecoder().decode(altered((doc) => { doc.keys.beta.cause = token }))
      return new TextEncoder().encode(text.slice(0, text.indexOf(token) + token.length))
    }],
    ['an unknown field holding a token', () => altered((doc) => { doc.keys.alpha.note = fakeToken(BOT_TOKEN_PREFIX, 'field') })],
    ['a cause that is a token', () => altered((doc) => { doc.keys.alpha.cause = fakeToken(BOT_TOKEN_PREFIX, 'cause') })],
    ['an invalid entry whose key is a token', () => altered((doc) => { doc.keys[fakeToken(BOT_TOKEN_PREFIX, 'key')] = doc.keys.alpha.cause })],
  ])('%s: the entry, the outcome and the log carry no file content', (_label, build) => {
    writeFileSync(retiredKeysPath(dir), build())
    const logs: string[] = []
    const outcome = startRead(undefined, logs)
    expect(outcome.kind).toBe('refused')
    expect(startupEntries()).toHaveLength(1)
    assertNoLeak({ outcome, logs, entries: writtenFile(logDir) })
  })
})

// ---------------------------------------------------------------------------
// Interrupted writes (SRJ-802; the tests/atomic-write.test.ts pattern)
// ---------------------------------------------------------------------------

/** A step of `durableWriteFileSync`, as tests/atomic-write.test.ts names them. */
type Step = 'open-temp' | 'write' | 'fsync-temp' | 'close-temp' | 'rename' | 'open-dir' | 'fsync-dir'

/** A `DurableWriteFs` over the real file system whose `step` throws EIO each time it runs (a close fails after closing). */
function failingAt(step: Step): DurableWriteFs {
  const dirFds = new Set<number>()
  const fail = (at: Step): void => {
    if (at === step) throw errnoError('EIO')
  }
  return {
    openSync(path, flags) {
      fail(flags === 'r' ? 'open-dir' : 'open-temp')
      const fd = openSync(path, flags)
      if (flags === 'r') dirFds.add(fd)
      return fd
    },
    writeSync(fd, buffer, offset, length) {
      fail('write')
      return writeSync(fd, buffer, offset, length)
    },
    fsyncSync(fd) {
      fail(dirFds.has(fd) ? 'fsync-dir' : 'fsync-temp')
      fsyncSync(fd)
    },
    closeSync(fd) {
      closeSync(fd)
      if (!dirFds.delete(fd)) fail('close-temp')
    },
    renameSync: (from, to) => {
      fail('rename')
      renameSync(from, to)
    },
    unlinkSync: (path) => unlinkSync(path),
  }
}

describe('an interrupted write leaves the previous record (b.jg5 SRJ-802)', () => {
  const PRIMITIVES: Array<[string, (store: RetiredKeyStore) => string]> = [
    ['a batch record', (store) => store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome],
    ['a clear', (store) => store.clear('alpha')],
  ]
  const BEFORE_RENAME: Step[] = ['open-temp', 'write', 'fsync-temp', 'close-temp', 'rename']

  test.each(PRIMITIVES.flatMap(([label, act]) => BEFORE_RENAME.map((step) => [label, step, act] as const)))(
    '%s failing at %s: the previous bytes, no temporary file, and the previous record in memory',
    (_label, step, act) => {
      writeRetiredKeysRecord(dir, SEED)
      const before = fileBytes()
      const rig = openStore({ write: (path, bytes) => durableWriteFileSync(path, bytes, failingAt(step)) })

      expect(act(rig.store)).toBe(RETIRED_KEYS_WRITE_FAILED)

      expect(fileBytes()).toEqual(before)
      expect(readdirSync(dir)).toEqual([RETIRED_KEYS_FILE_NAME])
      expect(rig.store.snapshot().entries).toEqual(retiredKeysRecordOf(SEED))
      expect(rig.logs).toHaveLength(1)
    },
  )

  test.each<Step>(['open-dir', 'fsync-dir'])(
    'a %s failure after the rename: the previous bytes written back, the record in memory unchanged',
    (step) => {
      writeRetiredKeysRecord(dir, SEED)
      const before = fileBytes()
      const rig = openStore({ write: (path, bytes) => durableWriteFileSync(path, bytes, failingAt(step)) })

      expect(rig.store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome).toBe(RETIRED_KEYS_WRITE_FAILED)

      expect(fileBytes()).toEqual(before)
      expect(readdirSync(dir)).toEqual([RETIRED_KEYS_FILE_NAME])
      expect(rig.store.isRecorded('gamma')).toBe(false)
    },
  )

  test('a directory-sync failure of the first write: the file, absent before, is removed again', () => {
    const rig = openStore({ write: (path, bytes) => durableWriteFileSync(path, bytes, failingAt('fsync-dir')) })

    expect(rig.store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome).toBe(RETIRED_KEYS_WRITE_FAILED)

    expect(readdirSync(dir)).toEqual([])
    expect(rig.store.keys()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Changes held in memory (SRJ-714, SRJ-803, SRJ-806, SRJ-807; hatch A3)
// ---------------------------------------------------------------------------

describe('changes held in memory after a failed write (b.jg5 SRJ-714, SRJ-803, SRJ-806, SRJ-807)', () => {
  /** A store over the seed whose `absent-at-start` batch of `held` has just failed to write. */
  function afterFailedSweepWrite(): { rig: Rig; before: Uint8Array | null; heldAt: string } {
    writeRetiredKeysRecord(dir, SEED)
    const before = fileBytes()
    const rig = openStore()
    rig.writeFails = errnoError('EIO')
    const result = rig.store.record([{ key: 'held', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START }])
    expect(result.outcome).toBe(RETIRED_KEYS_WRITE_FAILED)
    return { rig, before, heldAt: rig.stamp() }
  }

  test('a failed absent-at-start batch leaves the file unchanged and its keys recorded by this store, held only in memory', () => {
    const { rig, before, heldAt } = afterFailedSweepWrite()

    expect(fileBytes()).toEqual(before)
    expect(rig.store.isRecorded('held')).toBe(true)
    expect(rig.store.entry('held')).toEqual({ retiredAt: heldAt, cause: RETIRED_KEY_CAUSE_ABSENT_AT_START, newLifeBegunAt: null })
    expect(rig.store.isHeldInMemory('held')).toBe(true)
    expect(rig.store.isHeldInMemory('alpha')).toBe(false)
  })

  test('re-recording a held key makes one writer call that writes it; then it is no longer held', () => {
    const { rig } = afterFailedSweepWrite()
    rig.writeFails = undefined
    const calls = rig.writes.length

    expect(rig.store.record([{ key: 'held', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome).toBe(RETIRED_KEYS_WRITTEN)

    expect(rig.writes).toHaveLength(calls + 1)
    expect(readRetiredKeysRecord(dir)!.get('held')!.cause).toBe(RETIRED_KEY_CAUSE_ABSENT_AT_START)
    expect(rig.store.isHeldInMemory('held')).toBe(false)
  })

  test.each<[string, (store: RetiredKeyStore) => string]>([
    ['a record of another key', (store) => store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome],
    ['a mark of another key', (store) => store.mark('beta')],
    ['a clear of another key', (store) => store.clear('alpha')],
  ])('the next write that succeeds, %s, carries the held keys, and a fresh store reads them', (_label, act) => {
    const { rig, heldAt } = afterFailedSweepWrite()
    rig.writeFails = undefined

    expect(act(rig.store)).toBe(RETIRED_KEYS_WRITTEN)

    expect(rig.store.isHeldInMemory('held')).toBe(false)
    expect(freshRecord().get('held')).toEqual({ retiredAt: heldAt, cause: RETIRED_KEY_CAUSE_ABSENT_AT_START, newLifeBegunAt: null })
  })

  test('a failed batch of mixed causes holds only its absent-at-start keys; the others are not recorded', () => {
    const rig = openStore()
    rig.writeFails = errnoError('EIO')

    rig.store.record([
      { key: 'removed', cause: RETIRED_KEY_CAUSE_REMOVED },
      { key: 'modified', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY },
      { key: 'swept', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START },
    ])

    expect(rig.store.keys()).toEqual(['swept'])
    expect(readdirSync(dir)).toEqual([])
  })

  test('a failed mark is held: read as marked by this store, the file unmarked; the next mark writes it with its first time; a fresh store reads it', async () => {
    writeRetiredKeysRecord(dir, SEED)
    const before = fileBytes()
    const rig = openStore()
    rig.writeFails = errnoError('EIO')

    expect(rig.store.mark('beta')).toBe(RETIRED_KEYS_WRITE_FAILED)
    const markedAt = rig.stamp()
    expect(rig.store.isMarked('beta')).toBe(true)
    expect(fileBytes()).toEqual(before)

    rig.writeFails = undefined
    await rig.clock.advance(10_000)
    expect(rig.store.mark('beta')).toBe(RETIRED_KEYS_WRITTEN)
    expect(rig.store.mark('beta')).toBe(RETIRED_KEYS_UNCHANGED)
    expect(freshRecord().get('beta')!.newLifeBegunAt).toBe(markedAt)
  })

  test('a held mark is carried by the next write that succeeds of another primitive', () => {
    writeRetiredKeysRecord(dir, SEED)
    const rig = openStore()
    rig.writeFails = errnoError('EIO')
    rig.store.mark('beta')
    rig.writeFails = undefined

    rig.store.clear('alpha')

    expect(freshRecord().get('beta')!.newLifeBegunAt).toBe(rig.stamp())
  })

  test.each<[string, (store: RetiredKeyStore) => string]>([
    ['a batch with the removed cause', (store) => store.record([{ key: 'gamma', cause: RETIRED_KEY_CAUSE_REMOVED }]).outcome],
    ['a batch with the destructive-modify cause', (store) => store.record([{ key: 'alpha', cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY }]).outcome],
    ['a clear', (store) => store.clear('alpha')],
  ])('%s whose write fails leaves the record in memory and the file unchanged, and holds nothing', (_label, act) => {
    writeRetiredKeysRecord(dir, SEED)
    const before = fileBytes()
    const rig = openStore()
    rig.writeFails = errnoError('EIO')

    expect(act(rig.store)).toBe(RETIRED_KEYS_WRITE_FAILED)

    expect(rig.store.snapshot().entries).toEqual(retiredKeysRecordOf(SEED))
    expect(fileBytes()).toEqual(before)
    for (const key of ['alpha', 'beta', 'gamma']) expect(rig.store.isHeldInMemory(key)).toBe(false)
  })

  test('a key whose absent-at-start recording was written is not held in memory', () => {
    const rig = openStore()
    rig.store.record([{ key: 'swept', cause: RETIRED_KEY_CAUSE_ABSENT_AT_START }])
    expect(rig.store.isRecorded('swept')).toBe(true)
    expect(rig.store.isHeldInMemory('swept')).toBe(false)
  })
})
