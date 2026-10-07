/**
 * channel-delivery.test.ts — The stored-choice store, src/channel-delivery.ts
 * (b.deo SRI-1303 beside b.av2 SR-14; SRI-401 beside b.av2 SR-8.1; SRI-402;
 * SRI-403 and SRI-407 beside b.av2 SR-8.7; SRI-404; SRI-405; the store part
 * of SRI-502; SRI-904 and SRI-905 beside b.av2 SR-10.3; SRI-907; AC 20, AC 21,
 * AC 23).
 *
 * - Fixed values: the file name, format version 1, the closed class list
 *   (`channel-delivery-unreadable`), the `[slack] channel-delivery:` prefix
 *   and SRI-905's three drop reasons, typed only in their one pin case.
 * - Location (SRI-401): the path under a given state directory; the default
 *   follows `SLACK_STATE_DIR` at call time; no `src/` module but the store's
 *   spells the file name or names its serialiser or parser.
 * - Format (SRI-402): a round trip; the same record always gives the same
 *   bytes; a key with no channels is left out; every refused form, made by
 *   altering the serialiser's output (its bytes, for the UTF-8 rule), reads
 *   as unreadable through the store's load.
 * - The stored-choice helper's contract (tests/test-helpers/channel-delivery.ts).
 * - The read at start (SRI-403, SRI-904): a missing file; a file that cannot
 *   be read, parsed or validated, and the unreadable state it gives for the
 *   run; a directory and a real FIFO (in a child process); no size cap; the
 *   bytes parsed only; the `channel-delivery-unreadable` line.
 * - Writes (SRI-404, SRI-905, SRI-907): whole-record, durable writes; each
 *   failure through the `DurableWriteFs` seam (before the rename, an unsynced
 *   rename, a write-back that fails too); the failed-write line; the
 *   credentials file's path, never its content, in the file.
 * - Drops (SRI-405, SRI-905): at once in memory; one write per batch; a key
 *   named twice dropped once; an unknown reason refused before any change;
 *   unwritten drops and the next successful write that carries them; the
 *   drop line.
 * - Start rules (SRI-407): each rule's drop and its kept control, the
 *   precedence, both channel modes, a failed start-rule write.
 * - Retiring keys (SRI-502's store part): memory only, never written or
 *   logged, none at a fresh start.
 *
 * Isolation: every file sits under a per-case `mkdtempSync` root removed in
 * `afterEach`; `SLACK_STATE_DIR` points at the case's state directory and is
 * restored after every case; the store's clock is a `createFakeClock`; the
 * record is seeded and read only through tests/test-helpers/channel-delivery.ts
 * or the module's own serialiser (a refused form alters the serialiser's
 * output, never a JSON literal); every injected error's message carries
 * `sentinelInMessage(…)`; every case runs `assertNoLeak` over its lines and
 * the files in its state directory. Texts, class labels and drop reasons come
 * from src/, but for the pin cases. No `mock.module`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { durableUnlinkSync, durableWriteFileSync, type DurableWriteFs } from '../src/atomic-write.ts'
import {
  CHANNEL_DELIVERY_DECLARATION_FIELDS,
  CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES,
  CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED,
  CHANNEL_DELIVERY_DROP_NOT_APPLIED,
  CHANNEL_DELIVERY_DROP_REASONS,
  CHANNEL_DELIVERY_DROP_RETIRED,
  CHANNEL_DELIVERY_FILE_NAME,
  CHANNEL_DELIVERY_FORMAT_VERSION,
  CHANNEL_DELIVERY_LOG_PREFIX,
  CHANNEL_DELIVERY_NOTHING_TO_WRITE,
  CHANNEL_DELIVERY_PROBLEM_PARSE,
  CHANNEL_DELIVERY_PROBLEM_VALIDATE,
  CHANNEL_DELIVERY_SET_INVALID,
  CHANNEL_DELIVERY_SET_STORED,
  CHANNEL_DELIVERY_SET_UNREADABLE,
  CHANNEL_DELIVERY_SET_WRITE_FAILED,
  CHANNEL_DELIVERY_UNREADABLE,
  CHANNEL_DELIVERY_UNREADABLE_READ,
  CHANNEL_DELIVERY_WRITE_FAILED,
  CHANNEL_DELIVERY_WRITTEN,
  channelDeliveryDeclarationOf,
  channelDeliveryDropAction,
  channelDeliveryDropLine,
  channelDeliveryPath,
  channelDeliverySetAction,
  channelDeliveryUnreadableLine,
  channelDeliveryWriteFailedLine,
  loadChannelDeliveryAtStart,
  loadChannelDeliveryStore,
  parseChannelDelivery,
  serializeChannelDelivery,
  SET_CHANNEL_DELIVERY_TOOL,
  type ChannelDeliveryAppliedPersona,
  type ChannelDeliveryDeclaration,
  type ChannelDeliveryDropReason,
  type ChannelDeliveryPersonaEntry,
  type ChannelDeliveryRecord,
  type ChannelDeliveryStart,
  type ChannelDeliveryStore,
  type ChannelDeliveryStoreDeps,
  type ChannelDeliveryUnreadableCause,
} from '../src/channel-delivery.ts'
import {
  CONFIG_NOT_REGULAR_FILE_CODE,
  DELIVERY_MODES,
  MAX_RELOAD_FILE_BYTES,
  type DeliveryMode,
  type Persona,
  type PersonaConfigFs,
} from '../src/config.ts'
import { errnoSuffix } from '../src/persona-credentials.ts'
import { loadRetiredKeyStore, RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, RETIRED_KEY_CAUSE_REMOVED, type RetiredKeyStore } from '../src/retired-keys.ts'
import {
  channelDeliveryRecordOf,
  declarationOf,
  readChannelDeliveryRecord,
  SAMPLE_SET_AT,
  writeChannelDeliveryRecord,
  type ChannelDeliveryChannelSeed,
  type ChannelDeliveryPersonaSeed,
} from './test-helpers/channel-delivery.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, makeCredentials, sentinelInMessage, writeCredentialsFile, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'
import { hostSafeChildEnv, osTempDir } from './test-helpers/host-safe-env.ts'
import { lineParts } from './test-helpers/line-parts.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'
import { writeRetiredKeysRecord, type RetiredKeySeed } from './test-helpers/retired-keys.ts'
import { importedSpecifiers, maskLiterals, srcModules, stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/** The fake clock's start: a whole second, distinct from the helper's `SAMPLE_SET_AT`. */
const START_MS = Date.UTC(2026, 9, 7, 8, 0, 0)

/** Channel IDs the fixtures store choices for. */
const C1 = 'C0TEST001'
const C2 = 'C0TEST002'
const G3 = 'G0TEST003'

/** A `set_at` a seed gives, other than the helper's sample. */
const EARLIER_SET_AT = new Date(START_MS - 60_000).toISOString()

let root: string
/** The state directory under test; `SLACK_STATE_DIR` points at it for the case. */
let stateDir: string
let savedStateDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cscb-channel-delivery-'))
  stateDir = join(root, 'state')
  mkdirSync(stateDir)
  savedStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = stateDir
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = savedStateDir
  rmSync(root, { recursive: true, force: true })
})

/** An errno-style error, as `node:fs` throws, whose message carries the sentinel the way a quoted message would. */
function injected(code: string, label: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected failure (${sentinelInMessage(label)})`), { code })
}

/**
 * One failing call of the durable writer's file system: the `call`-th call
 * (1 by default) of `step`, counted from the last `fail`, throws an
 * `injected` error with `code` (`EIO` by default). The temporary file's
 * fsync is `fsyncSync` call 1 and the directory's is call 2, so
 * {@link UNSYNCED} is a rename whose directory sync failed.
 */
interface FsFailure {
  readonly step: keyof DurableWriteFs
  readonly call?: number
  readonly code?: string
}

/** A rename whose directory sync failed: the new bytes are in place, and the writer throws `DurableWriteUnsyncedError`. */
const UNSYNCED: FsFailure = { step: 'fsyncSync', call: 2 }

/** Each failing step before the rename: the path is left as it was. */
const BEFORE_RENAME: readonly FsFailure[] = [
  { step: 'openSync' },
  { step: 'writeSync' },
  { step: 'fsyncSync' },
  { step: 'closeSync' },
  { step: 'renameSync' },
]

/** A store over the case's state directory and what it did. */
interface Rig {
  store: ChannelDeliveryStore
  /** Every line the store logged. */
  logs: string[]
  /** The bytes of every writer call, failed ones and write-backs included. */
  writes: Uint8Array[]
  clock: FakeClock
  /** Every error the seam threw, in order. */
  thrown: NodeJS.ErrnoException[]
  /** Replace the seam's failures (none: every call passes) and restart its call counts. */
  fail(...failures: FsFailure[]): void
}

interface RigOptions {
  /** The read's seam. */
  readFs?: Partial<PersonaConfigFs>
  /** Load through `loadChannelDeliveryAtStart` with these applied personas and retired keys. */
  start?: ChannelDeliveryStart
  /** The seam's failures from the load on. */
  failures?: readonly FsFailure[]
  clock?: FakeClock
}

/**
 * Load the store over `stateDir`, logging into `logs`, with a fake clock, and
 * a writer and remover built on the real `durableWriteFileSync` and
 * `durableUnlinkSync` over a `DurableWriteFs` seam that passes every call to
 * `node:fs` unless a failure is set.
 */
function openRig(opts: RigOptions = {}): Rig {
  const counts = new Map<keyof DurableWriteFs, number>()
  let failures: readonly FsFailure[] = opts.failures ?? []
  const rig: Rig = {
    store: undefined as unknown as ChannelDeliveryStore,
    logs: [],
    writes: [],
    clock: opts.clock ?? createFakeClock({ start: START_MS }),
    thrown: [],
    fail: (...next) => {
      failures = next
      counts.clear()
    },
  }
  const at = (step: keyof DurableWriteFs): void => {
    const call = (counts.get(step) ?? 0) + 1
    counts.set(step, call)
    const failure = failures.find((f) => f.step === step && (f.call ?? 1) === call)
    if (failure === undefined) return
    const err = injected(failure.code ?? 'EIO', `${step}-${call}`)
    rig.thrown.push(err)
    throw err
  }
  const fs: DurableWriteFs = {
    openSync: (path, flags) => {
      at('openSync')
      return openSync(path, flags)
    },
    writeSync: (fd, buffer, offset, length) => {
      at('writeSync')
      return writeSync(fd, buffer, offset, length)
    },
    fsyncSync: (fd) => {
      at('fsyncSync')
      fsyncSync(fd)
    },
    closeSync: (fd) => {
      closeSync(fd)
      at('closeSync')
    },
    renameSync: (from, to) => {
      at('renameSync')
      renameSync(from, to)
    },
    unlinkSync: (path) => {
      at('unlinkSync')
      unlinkSync(path)
    },
  }
  const deps: ChannelDeliveryStoreDeps = {
    log: (line) => rig.logs.push(line),
    readFs: opts.readFs,
    now: () => rig.clock.now(),
    write: (path, bytes) => {
      rig.writes.push(bytes)
      durableWriteFileSync(path, bytes, fs)
    },
    remove: (path) => durableUnlinkSync(path, fs),
  }
  rig.store = opts.start === undefined ? loadChannelDeliveryStore(stateDir, deps) : loadChannelDeliveryAtStart(stateDir, opts.start, deps)
  return rig
}

/** The stored-choice file's path in the case's state directory. */
const filePath = (): string => channelDeliveryPath(stateDir)

/** The file's bytes, or null when there is none. */
function fileBytes(): Uint8Array | null {
  return existsSync(filePath()) ? new Uint8Array(readFileSync(filePath())) : null
}

/** The state directory's entries, sorted. */
const stateEntries = (): string[] => readdirSync(stateDir).sort()

/** Every regular file in the state directory, marked for `assertNoLeak`. */
function filesWritten(): ReturnType<typeof writtenFile>[] {
  return readdirSync(stateDir)
    .filter((name) => lstatSync(join(stateDir, name)).isFile())
    .map((name) => writtenFile(join(stateDir, name)))
}

/**
 * `assertNoLeak` over the rig's lines, `extra` and, unless `files` is false
 * (a case that seeded a token into the file itself), every file in the state
 * directory.
 */
function expectNoLeak(rig: Rig | undefined, extra: Record<string, unknown> = {}, files = true): void {
  assertNoLeak({ logs: rig?.logs ?? [], ...extra, files: files ? filesWritten() : [] })
}

/** Resolved personas of the case, their paths under its root (declarative mode unless `fungible`). */
function personasOf(specs: PersonaSpec[], fungible = false): Persona[] {
  return makeMultiPersonaConfig(specs, root, fungible ? { allow_invited_channels: true } : {}).personas
}

/** The persona named `name`, in declarative mode. */
const personaNamed = (name: string): Persona => personasOf([{ name }])[0]!

/** Create a persona's working directory and credentials file (fake tokens), so its paths resolve. */
function onDisk(persona: Persona): Persona {
  mkdirSync(persona.working_directory, { recursive: true })
  writeCredentialsFile(dirname(persona.credentials_file), basename(persona.credentials_file))
  return persona
}

/** A seed for `persona` with `channels`. */
function seedFor(persona: Persona, channels: Record<string, ChannelDeliveryChannelSeed>): ChannelDeliveryPersonaSeed {
  return { declaration: declarationOf(persona), channels }
}

/** Two keys: `alpha` in two channels (`all`, `mentions`), `beta` in one (`all`). */
function baseSeeds(): Record<string, ChannelDeliveryPersonaSeed> {
  return {
    alpha: seedFor(personaNamed('alpha'), { [C1]: { delivery: 'all' }, [C2]: { delivery: 'mentions', set_at: EARLIER_SET_AT } }),
    beta: seedFor(personaNamed('beta'), { [G3]: { delivery: 'all' } }),
  }
}

/** The base seeds' bytes, as the serialiser writes them. */
const seededBytes = (): Uint8Array => serializeChannelDelivery(channelDeliveryRecordOf(baseSeeds()))

/** The base seeds' serialised record, parsed, altered by `alter` (which may return a replacement) and written back as JSON. */
function altered(alter: (doc: Record<string, any>) => unknown): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(seededBytes()))
  const out = alter(doc)
  return new TextEncoder().encode(JSON.stringify(out === undefined ? doc : out, null, 2))
}

/** The unreadable cause the parser gives for `bytes`; fails when they parse. */
function refusalOf(bytes: Uint8Array): ChannelDeliveryUnreadableCause {
  const parsed = parseChannelDelivery(bytes)
  if (parsed.ok) throw new Error('the bytes parsed; the case needs a refused form')
  return { stage: parsed.stage, problem: parsed.problem }
}

/** The retired-key record holding `seeds`, loaded through src/retired-keys.ts from its own directory under the root. */
function retiredKeysOf(seeds: Readonly<Record<string, RetiredKeySeed>> = {}): RetiredKeyStore {
  const dir = join(root, 'retired')
  mkdirSync(dir, { recursive: true })
  if (Object.keys(seeds).length > 0) writeRetiredKeysRecord(dir, seeds)
  const loaded = loadRetiredKeyStore(dir, { log: () => {} })
  if (loaded.kind !== 'loaded') throw new Error('the retired-key record did not load')
  return loaded.store
}

/** The applied personas as the start rules see them. */
const appliedOf = (personas: readonly Persona[]): ChannelDeliveryAppliedPersona[] =>
  personas.map((persona) => ({ key: persona.key, declaration: declarationOf(persona) }))

/** What the start rules run over: `personas` applied, `retired` in the retired-key record. */
function startOf(personas: readonly Persona[], retired: Readonly<Record<string, RetiredKeySeed>> = {}): ChannelDeliveryStart {
  return { applied: appliedOf(personas), retiredKeys: retiredKeysOf(retired) }
}

/**
 * `line` is the failed-write line `build` makes around its detail: the
 * builder's own text before and after it, with each injected error's errno
 * code (`errnoSuffix`) inside the detail, in order.
 */
function expectWriteFailedLine(line: string, build: (detail: string) => string, errors: readonly NodeJS.ErrnoException[]): void {
  const [head, tail] = lineParts(build) as [string, string]
  expect(line.startsWith(head)).toBe(true)
  expect(line.endsWith(tail)).toBe(true)
  let detail = line.slice(head.length, line.length - tail.length)
  for (const err of errors) {
    const code = errnoSuffix(err)
    expect(code).not.toBe('')
    expect(detail).toContain(code)
    detail = detail.slice(detail.indexOf(code) + code.length)
  }
}

/** What `act` throws; fails when it returns. */
function thrownBy(act: () => unknown): NodeJS.ErrnoException {
  try {
    act()
  } catch (err) {
    return err as NodeJS.ErrnoException
  }
  throw new Error('expected a throw; none came')
}

/** Every entry the store holds is one `seeds` held, as it was: the rules only remove (b.deo SRI-407). */
function expectOnlyRemoved(store: ChannelDeliveryStore, seeds: Readonly<Record<string, ChannelDeliveryPersonaSeed>>): void {
  const seeded = channelDeliveryRecordOf(seeds)
  for (const [key, entry] of store.record()) expect(entry).toEqual(seeded.get(key)!)
}

/** Whether `line`, with `path` taken out, names a delivery value as a word. */
function namesAChoice(line: string, path: string): boolean {
  const words = line.replaceAll(path, '')
  return DELIVERY_MODES.some((mode) => new RegExp(`\\b${mode}\\b`).test(words))
}

/**
 * What breaks "the bytes are parsed only" (b.deo SRI-403) in comment-stripped
 * `code`: each imported specifier naming a crypto module, and each hashing,
 * digest or byte-comparison name in its code outside literals. Empty when the
 * module only parses.
 */
function parsedOnlyFindings(code: string): string[] {
  const imports = importedSpecifiers(code).filter((spec) => /crypto/.test(spec)).map((spec) => `imports ${spec}`)
  const names = [...maskLiterals(code).matchAll(/\b(?:createHash|createHmac|digest|timingSafeEqual|sha256Hex)\b|\bBuffer\.compare\b|\.equals\s*\(/g)]
    .map((m) => `names ${m[0]}`)
  return [...imports, ...names]
}

// ---------------------------------------------------------------------------
// S1: fixed values, location, format, refused forms, the helper's contract
// ---------------------------------------------------------------------------

describe('the store\'s fixed values (b.deo SRI-401, SRI-402, SRI-901, SRI-905)', () => {
  test('pin: the file name, format version 1, the class list holding only channel-delivery-unreadable, the line prefix and SRI-905\'s three drop reasons', () => {
    const values = {
      file: CHANNEL_DELIVERY_FILE_NAME,
      version: CHANNEL_DELIVERY_FORMAT_VERSION,
      classes: [...CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES],
      unreadable: CHANNEL_DELIVERY_UNREADABLE,
      prefix: CHANNEL_DELIVERY_LOG_PREFIX,
      reasons: [CHANNEL_DELIVERY_DROP_RETIRED, CHANNEL_DELIVERY_DROP_NOT_APPLIED, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED],
    }
    expect(values).toEqual({
      file: 'channel-delivery.json',
      version: 1,
      classes: ['channel-delivery-unreadable'],
      unreadable: 'channel-delivery-unreadable',
      prefix: '[slack] channel-delivery:',
      reasons: ['retired by a confirmed change', 'not an applied persona at start', 'its declaration changed'],
    })
    expect<string[]>([...CHANNEL_DELIVERY_DROP_REASONS]).toEqual(values.reasons)
    assertNoLeak(values)
  })
})

describe('where the file lives (b.deo SRI-401 beside b.av2 SR-8.1)', () => {
  test('a store over a state directory has <dir>/<file name> as its path, and its first accepted write creates exactly that file, with no temporary file', () => {
    const rig = openRig()
    expect(rig.store.path).toBe(join(stateDir, CHANNEL_DELIVERY_FILE_NAME))
    expect(channelDeliveryPath(stateDir)).toBe(rig.store.path)

    expect(rig.store.set('alpha', C1, 'all', declarationOf(personaNamed('alpha'))).kind).toBe(CHANNEL_DELIVERY_SET_STORED)

    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expectNoLeak(rig)
  })

  test('with no directory given, the path follows SLACK_STATE_DIR as it is at call time; a given directory wins', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    process.env['SLACK_STATE_DIR'] = first
    expect(channelDeliveryPath()).toBe(join(first, CHANNEL_DELIVERY_FILE_NAME))
    process.env['SLACK_STATE_DIR'] = second
    expect(channelDeliveryPath()).toBe(join(second, CHANNEL_DELIVERY_FILE_NAME))
    expect(channelDeliveryPath(stateDir)).toBe(join(stateDir, CHANNEL_DELIVERY_FILE_NAME))
    expectNoLeak(undefined)
  })

  test('no src/ module but src/channel-delivery.ts spells the file name or names the serialiser or the parser (comment-stripped code)', () => {
    const helpers = /\b(?:serializeChannelDelivery|parseChannelDelivery)\b/
    const modules = srcModules()
    const own = modules.get('channel-delivery.ts')!
    // The module itself holds all three, so the check can match.
    expect(own).toContain(CHANNEL_DELIVERY_FILE_NAME)
    expect(maskLiterals(own)).toMatch(helpers)

    const offenders = [...modules]
      .filter(([name]) => name !== 'channel-delivery.ts')
      .filter(([, code]) => code.includes(CHANNEL_DELIVERY_FILE_NAME) || helpers.test(maskLiterals(code)))
      .map(([name]) => name)
    expect(offenders).toEqual([])
    expectNoLeak(undefined)
  })
})

describe('the file\'s format (b.deo SRI-402)', () => {
  test('a full record round-trips through the serialiser and the parser, and loads whole through the store', () => {
    const seeds = {
      ...baseSeeds(),
      ['__proto__']: seedFor(personaNamed('__proto__'), { [C2]: { delivery: 'mentions' } }),
      gamma: seedFor(personaNamed('gamma'), { [G3]: { delivery: 'mentions', set_at: EARLIER_SET_AT }, [C1]: { delivery: 'all' } }),
    }
    const record = channelDeliveryRecordOf(seeds)
    expect(record.size).toBe(4)

    expect(parseChannelDelivery(serializeChannelDelivery(record))).toEqual({ ok: true, record })

    writeChannelDeliveryRecord(stateDir, seeds)
    const rig = openRig()
    expect(rig.store.readable).toBe(true)
    expect(rig.store.record()).toEqual(record)
    expect(rig.logs).toEqual([])
    expectNoLeak(rig)
  })

  test('the same record always gives the same bytes, whatever order its keys and channels were added in', () => {
    const seeds = baseSeeds()
    const reversed: Record<string, ChannelDeliveryPersonaSeed> = {}
    for (const key of Object.keys(seeds).reverse()) {
      const seed = seeds[key]!
      reversed[key] = { declaration: seed.declaration, channels: Object.fromEntries(Object.entries(seed.channels).reverse()) }
    }
    const bytes = serializeChannelDelivery(channelDeliveryRecordOf(seeds))

    expect(serializeChannelDelivery(channelDeliveryRecordOf(seeds))).toEqual(bytes)
    expect(serializeChannelDelivery(channelDeliveryRecordOf(reversed))).toEqual(bytes)
    expectNoLeak(undefined, { bytes })
  })

  test('the serialiser leaves out a key with no channels', () => {
    const record = new Map(channelDeliveryRecordOf(baseSeeds()))
    const withEmpty = new Map<string, ChannelDeliveryPersonaEntry>(record)
    withEmpty.set('gamma', { declaration: declarationOf(personaNamed('gamma')), channels: new Map() })

    expect(serializeChannelDelivery(withEmpty)).toEqual(serializeChannelDelivery(record))
    expectNoLeak(undefined)
  })

  /** An alteration that respells `alpha`'s C1 `set_at` (the serialiser's `SAMPLE_SET_AT`, 2026-06-01T09:30:00.000Z). */
  const respellSetAt = (respell: (setAt: string) => string) => (doc: Record<string, any>): void => {
    doc.personas.alpha.channels[C1].set_at = respell(doc.personas.alpha.channels[C1].set_at)
  }

  // Every form SRI-402 refuses, each the base seeds' serialised record altered.
  const REFUSED: Array<[string, (doc: Record<string, any>) => unknown]> = [
    ['a record with no `version`', (doc) => { delete doc.version }],
    ['a record with no `personas`', (doc) => { delete doc.personas }],
    ['an entry with no `declaration`', (doc) => { delete doc.personas.alpha.declaration }],
    ['an entry with no `channels`', (doc) => { delete doc.personas.alpha.channels }],
    ...CHANNEL_DELIVERY_DECLARATION_FIELDS.map((field): [string, (doc: Record<string, any>) => unknown] => [
      `a declaration with no \`${field}\``,
      (doc) => { delete doc.personas.beta.declaration[field] },
    ]),
    ['a channel entry with no `delivery`', (doc) => { delete doc.personas.alpha.channels[C2].delivery }],
    ['a channel entry with no `set_at`', (doc) => { delete doc.personas.beta.channels[G3].set_at }],
    ['an unknown top-level field', (doc) => { doc.note = 1 }],
    ['an unknown field in an entry', (doc) => { doc.personas.alpha.note = 1 }],
    ['an unknown field in a declaration', (doc) => { doc.personas.alpha.declaration.note = 'x' }],
    ['an unknown field in a channel entry', (doc) => { doc.personas.beta.channels[G3].note = 'x' }],
    ['version 2', (doc) => { doc.version = CHANNEL_DELIVERY_FORMAT_VERSION + 1 }],
    ['a version given as a string', (doc) => { doc.version = String(doc.version) }],
    ['`personas` given as an array', (doc) => { doc.personas = Object.values(doc.personas) }],
    ['a key that is not a persona key', (doc) => { doc.personas['Not A Key'] = doc.personas.beta; delete doc.personas.beta }],
    ['a malformed channel ID', (doc) => { doc.personas.beta.channels['c0lower'] = doc.personas.beta.channels[G3] }],
    ['a `delivery` of "none"', (doc) => { doc.personas.alpha.channels[C1].delivery = 'none' }],
    ['a `set_at` without the trailing Z', respellSetAt((setAt) => setAt.replace(/Z$/, ''))],
    ['a `set_at` with an offset in place of Z', respellSetAt((setAt) => setAt.replace(/Z$/, '+00:00'))],
    ['a `set_at` in month 13', respellSetAt((setAt) => setAt.replace(/^(\d{4})-\d{2}/, '$1-13'))],
    ['a `set_at` on 30 February', respellSetAt((setAt) => setAt.replace(/^(\d{4})-\d{2}-\d{2}/, '$1-02-30'))],
    ['a `set_at` at hour 24', respellSetAt((setAt) => setAt.replace(/T\d{2}/, 'T24'))],
    ['a `set_at` at minute 60', respellSetAt((setAt) => setAt.replace(/T(\d{2}):\d{2}/, 'T$1:60'))],
    ['a `set_at` at second 61', respellSetAt((setAt) => setAt.replace(/T(\d{2}):(\d{2}):\d{2}/, 'T$1:$2:61'))],
    ['a declaration field that is not a string', (doc) => { doc.personas.alpha.declaration.name = 7 }],
    ['an entry with no channel in `channels`', (doc) => { doc.personas.beta.channels = {} }],
  ]

  // SRI-402's UTF-8 rule, as raw bytes: each would read as the base seeds if
  // the decoder dropped a byte order mark or replaced a bad byte. The bad
  // byte sits inside a declaration path, where a replacement character would
  // still validate.
  const NOT_UTF8: Array<[string, () => Uint8Array]> = [
    ['a UTF-8 byte order mark before the record', () => new Uint8Array([0xef, 0xbb, 0xbf, ...seededBytes()])],
    ['a byte that is not UTF-8 (0xFF) inside a declaration path', () => {
      const bytes = seededBytes()
      // The record is ASCII, so the path's text offset is its byte offset.
      const at = new TextDecoder().decode(bytes).indexOf(root)
      if (at < 0) throw new Error('the case root is not in the record')
      bytes[at + 1] = 0xff
      return bytes
    }],
  ]

  test.each([...REFUSED.map(([label, alter]): [string, () => Uint8Array] => [label, () => altered(alter)]), ...NOT_UTF8])('%s reads as unreadable through the store\'s load: one line, the file left byte-identical', (_label, build) => {
    const bytes = build()
    writeFileSync(filePath(), bytes)

    const rig = openRig()

    expect(rig.store.readable).toBe(false)
    expect(rig.logs).toEqual([channelDeliveryUnreadableLine(filePath(), refusalOf(bytes))])
    expect(fileBytes()).toEqual(bytes)
    expectNoLeak(rig)
  })

  // SRI-402's `set_at` is an RFC 3339 UTC timestamp ending in `Z`; the
  // fraction of a second is optional and of any width.
  test.each<[string, (setAt: string) => string, string]>([
    ['one fraction digit', (setAt) => setAt.replace(/\.\d+Z$/, '.5Z'), '2026-06-01T09:30:00.5Z'],
    ['no fraction of a second', (setAt) => setAt.replace(/\.\d+Z$/, 'Z'), '2026-06-01T09:30:00Z'],
    ['six fraction digits', (setAt) => setAt.replace(/\.\d+Z$/, '.123456Z'), '2026-06-01T09:30:00.123456Z'],
  ])('a `set_at` with %s is accepted: the store loads readable, with the choice and the timestamp as written, and no line', (_label, respell, expected) => {
    const bytes = altered(respellSetAt(respell))
    writeFileSync(filePath(), bytes)

    const rig = openRig()

    expect(rig.store.readable).toBe(true)
    expect(rig.store.storedChoice('alpha', C1)).toBe('all')
    expect(rig.store.record().get('alpha')!.channels.get(C1)).toEqual({ delivery: 'all', set_at: expected })
    expect(rig.logs).toEqual([])
    expect(fileBytes()).toEqual(bytes)
    expectNoLeak(rig)
  })
})

describe('the stored-choice helper\'s contract (tests/test-helpers/channel-delivery.ts; b.deo SRI-1204)', () => {
  test('writeChannelDeliveryRecord writes exactly the serialiser\'s bytes at the module\'s path, a given set_at kept and an unset one SAMPLE_SET_AT', () => {
    const alpha = personaNamed('alpha')
    const expected: ChannelDeliveryRecord = new Map([
      [
        'alpha',
        {
          declaration: declarationOf(alpha),
          channels: new Map([
            [C1, { delivery: 'all' as DeliveryMode, set_at: SAMPLE_SET_AT }],
            [C2, { delivery: 'mentions' as DeliveryMode, set_at: EARLIER_SET_AT }],
          ]),
        },
      ],
    ])

    const path = writeChannelDeliveryRecord(stateDir, { alpha: seedFor(alpha, { [C1]: { delivery: 'all' }, [C2]: { delivery: 'mentions', set_at: EARLIER_SET_AT } }) })

    expect(path).toBe(filePath())
    expect(fileBytes()).toEqual(serializeChannelDelivery(expected))
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expectNoLeak(undefined)
  })

  test('writeChannelDeliveryRecord refuses the real home (the launch-time home), the OS temp directory itself and a directory outside it, writing nothing', () => {
    // When the launch-time home is a scratch HOME under the OS temp directory
    // (`HOME=$(mktemp -d)`), only the real-home rule refuses it.
    const errors: Error[] = []
    for (const refused of [homedir(), osTempDir(), '/']) {
      const path = channelDeliveryPath(refused)
      const existed = existsSync(path)
      errors.push(thrownBy(() => writeChannelDeliveryRecord(refused, baseSeeds())))
      expect(existsSync(path)).toBe(existed)
    }
    for (const err of errors) expect(err.message).toContain(writeChannelDeliveryRecord.name)
    expectNoLeak(undefined, { errors })
  })

  test('readChannelDeliveryRecord answers null for no file and the parsed record for a file', () => {
    expect(readChannelDeliveryRecord(stateDir)).toBeNull()

    writeChannelDeliveryRecord(stateDir, baseSeeds())

    expect(readChannelDeliveryRecord(stateDir)).toEqual(channelDeliveryRecordOf(baseSeeds()))
    expectNoLeak(undefined)
  })

  test('readChannelDeliveryRecord throws on a refused file, naming the path and the parser\'s problem and no file content; another read failure is rethrown', () => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'helper')
    const bytes = altered((doc) => { doc.personas.alpha.channels[C1].delivery = token })
    writeFileSync(filePath(), bytes)
    const { problem } = refusalOf(bytes) as { problem: string }

    const refused = thrownBy(() => readChannelDeliveryRecord(stateDir))

    expect(refused.message).toContain(readChannelDeliveryRecord.name)
    expect(refused.message).toContain(filePath())
    expect(refused.message).toContain(problem)
    expectNoLeak(undefined, { refused }, false)

    rmSync(filePath())
    mkdirSync(filePath())
    const rethrown = thrownBy(() => readChannelDeliveryRecord(stateDir))
    expect(rethrown.code).toBe('EISDIR')
    expectNoLeak(undefined, { rethrown })
  })

  test('declarationOf(persona) equals the declaration the store records for that persona, as the server builds it', () => {
    const [alpha] = personasOf([{ name: 'alpha' }])
    const rig = openRig()

    rig.store.set(alpha!.key, C1, 'all', channelDeliveryDeclarationOf(alpha!))

    expect(readChannelDeliveryRecord(stateDir)!.get(alpha!.key)!.declaration).toEqual(declarationOf(alpha!))
    expect(declarationOf(alpha!)).toEqual({ name: alpha!.name, credentials_file: alpha!.credentials_file, working_directory: alpha!.working_directory })
    expectNoLeak(rig)
  })
})

// ---------------------------------------------------------------------------
// S2: the read at start and the unreadable state (SRI-403, SRI-904)
// ---------------------------------------------------------------------------

describe('the read at start (b.deo SRI-403 beside b.av2 SR-8.7; SRI-905)', () => {
  test('a missing file reads as an empty, readable record: nothing written or created, no line', () => {
    const alpha = personaNamed('alpha')
    const rig = openRig({ start: startOf([alpha]) })

    expect(rig.store.readable).toBe(true)
    expect(rig.store.record().size).toBe(0)
    expect(rig.store.storedChoice(alpha.key, C1)).toBeUndefined()
    expect(rig.writes).toEqual([])
    expect(stateEntries()).toEqual([])
    expect(rig.logs).toEqual([])
    expectNoLeak(rig)
  })

  // Each cause of an unreadable file. The file always holds keys no applied
  // persona has, so a start rule that ran would drop them.
  const UNREADABLE: Array<[string, () => { readFs?: Partial<PersonaConfigFs>; cause: ChannelDeliveryUnreadableCause }]> = [
    ['a read error (EACCES at the open, through the read seam)', () => {
      writeChannelDeliveryRecord(stateDir, baseSeeds())
      const err = injected('EACCES', 'open')
      return { readFs: { openFile: () => { throw err } }, cause: { stage: CHANNEL_DELIVERY_UNREADABLE_READ, code: err.code } }
    }],
    ['a read error (EIO at the read, through the read seam)', () => {
      writeChannelDeliveryRecord(stateDir, baseSeeds())
      const err = injected('EIO', 'read')
      return { readFs: { readFileFd: () => { throw err } }, cause: { stage: CHANNEL_DELIVERY_UNREADABLE_READ, code: err.code } }
    }],
    ['invalid JSON (the record cut short)', () => {
      const bytes = seededBytes().slice(0, 80)
      writeFileSync(filePath(), bytes)
      return { cause: refusalOf(bytes) }
    }],
    ['a record the parser refuses (version 2)', () => {
      const bytes = altered((doc) => { doc.version = CHANNEL_DELIVERY_FORMAT_VERSION + 1 })
      writeFileSync(filePath(), bytes)
      return { cause: refusalOf(bytes) }
    }],
  ]

  test.each(UNREADABLE)('%s: the file left in place, one line, and an unreadable store for the run that stores, drops and writes nothing, and runs no start rule', (_label, setUp) => {
    const { readFs, cause } = setUp()
    const before = fileBytes()
    const alpha = personaNamed('alpha')

    const rig = openRig({ readFs, start: startOf([]) })

    expect(rig.store.readable).toBe(false)
    expect(rig.logs).toEqual([channelDeliveryUnreadableLine(filePath(), cause)])
    const results = {
      choice: rig.store.storedChoice('alpha', C1),
      channels: rig.store.storedChannels('alpha'),
      size: rig.store.record().size,
      set: rig.store.set('alpha', C1, 'mentions', declarationOf(alpha)),
      drop: rig.store.drop([{ key: 'alpha', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED }]),
      unwritten: rig.store.hasUnwrittenDrop('alpha'),
      writeUnwritten: rig.store.writeUnwrittenDrops(),
      rules: rig.store.applyStartRules(startOf([])),
    }
    expect(results).toEqual({
      choice: undefined,
      channels: [],
      size: 0,
      set: { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path: filePath() },
      drop: CHANNEL_DELIVERY_NOTHING_TO_WRITE,
      unwritten: false,
      writeUnwritten: CHANNEL_DELIVERY_NOTHING_TO_WRITE,
      rules: CHANNEL_DELIVERY_NOTHING_TO_WRITE,
    })
    expect(rig.writes).toEqual([])
    expect(rig.logs).toHaveLength(1)
    expect(fileBytes()).toEqual(before)
    // No startup-errors file under SLACK_STATE_DIR, which is the state directory.
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expectNoLeak(rig, { results })
  })

  test('a directory at the path reads as unreadable (EISDIR) and is left in place', () => {
    mkdirSync(filePath())

    const rig = openRig({ start: startOf([]) })

    expect(rig.store.readable).toBe(false)
    expect(rig.logs).toEqual([channelDeliveryUnreadableLine(filePath(), { stage: CHANNEL_DELIVERY_UNREADABLE_READ, code: 'EISDIR' })])
    expect(lstatSync(filePath()).isDirectory()).toBe(true)
    expectNoLeak(rig)
  })

  test.skipIf(!mkfifoAvailable())('a real FIFO at the path with no writer reads as unreadable at once (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    makeFifo(filePath())
    const home = join(root, 'home')
    mkdirSync(home)
    const modulePath = join(import.meta.dir, '..', 'src', 'channel-delivery.ts')
    const script = `
      const mod = await import(${JSON.stringify(modulePath)})
      const logs = []
      const store = mod.loadChannelDeliveryStore(${JSON.stringify(stateDir)}, { log: (line) => logs.push(line) })
      console.log(JSON.stringify({ readable: store.readable, logs }))
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      timeout: 10_000,
      encoding: 'utf-8',
      env: hostSafeChildEnv(home, { tools: [], extras: { SLACK_STATE_DIR: join(home, 'state') } }),
    })

    expect(child.signal).toBeNull()
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    const out = JSON.parse(child.stdout.trim())
    expect(out).toEqual({
      readable: false,
      logs: [channelDeliveryUnreadableLine(filePath(), { stage: CHANNEL_DELIVERY_UNREADABLE_READ, code: CONFIG_NOT_REGULAR_FILE_CODE })],
    })
    assertNoLeak({ out, stderr: child.stderr })
  }, 15_000)

  test('a valid record over 64 KiB is read whole, with every entry present and no line', () => {
    const alpha = personaNamed('alpha')
    const seeds: Record<string, ChannelDeliveryPersonaSeed> = {}
    for (let i = 0; serializeChannelDelivery(channelDeliveryRecordOf(seeds)).length <= MAX_RELOAD_FILE_BYTES; i++) {
      seeds[`persona_${String(i).padStart(5, '0')}`] = seedFor(alpha, { [C1]: { delivery: DELIVERY_MODES[i % DELIVERY_MODES.length]! } })
    }
    writeChannelDeliveryRecord(stateDir, seeds)
    expect(fileBytes()!.length).toBeGreaterThan(MAX_RELOAD_FILE_BYTES)

    const rig = openRig()

    expect(rig.store.readable).toBe(true)
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(seeds))
    expect(rig.logs).toEqual([])
    expectNoLeak(rig)
  })

  test('the file\'s bytes are parsed only: comment-stripped src/channel-delivery.ts imports no hashing module and digests or compares no bytes, and the check fails on altered source', () => {
    const code = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'channel-delivery.ts'), 'utf-8'))
    expect(parsedOnlyFindings(code)).toEqual([])

    for (const added of ['import { createHash } from \'node:crypto\'', 'Buffer.compare(a, b)', 'x.equals(y)']) {
      expect(parsedOnlyFindings(`${code}\n${added}\n`)).not.toEqual([])
    }
    expectNoLeak(undefined)
  })

  // SRI-904 gives no exact text: this case pins the logged line to its
  // builder for each kind and checks each part SRI-904 requires.
  test('pin: the channel-delivery-unreadable line for each kind (read, parse, validate) is its builder\'s, and names the file, the kind with its errno code or position, the fungible-mode effect and the fix', () => {
    const kinds: Array<[string, () => { readFs?: Partial<PersonaConfigFs>; cause: ChannelDeliveryUnreadableCause }]> = [UNREADABLE[0]!, UNREADABLE[2]!, UNREADABLE[3]!]
    const lines: string[] = []
    const stages: string[] = []
    for (const [, setUp] of kinds) {
      rmSync(filePath(), { force: true })
      const { readFs, cause } = setUp()
      const rig = openRig({ readFs })
      expect(rig.logs).toEqual([channelDeliveryUnreadableLine(filePath(), cause)])
      lines.push(rig.logs[0]!)
      stages.push(cause.stage)
    }
    expect(stages).toEqual([CHANNEL_DELIVERY_UNREADABLE_READ, CHANNEL_DELIVERY_PROBLEM_PARSE, CHANNEL_DELIVERY_PROBLEM_VALIDATE])
    const [read, parse, validate] = lines as [string, string, string]

    for (const line of lines) {
      expect(line.startsWith(`[slack] ${CHANNEL_DELIVERY_UNREADABLE}:`)).toBe(true)
      expect(line).toContain(JSON.stringify(filePath()))
      expect(line).toContain('in fungible mode every channel is served at mentions')
      expect(line).toContain(`${SET_CHANNEL_DELIVERY_TOOL} is refused`)
      expect(line).toContain('To fix: move the file aside, then restart')
    }
    expect(read).toContain('could not be read (EACCES)')
    expect(parse).toContain('could not be parsed')
    expect(parse).toMatch(/at line \d+, column \d+/)
    expect(validate).toContain('could not be validated')
    expect(validate).toContain(`\`version\` is not ${CHANNEL_DELIVERY_FORMAT_VERSION}`)
    assertNoLeak(lines)
  })

  test.each<[string, () => Uint8Array]>([
    ['a parse failure over bytes cut short right after a fake token', () => {
      const token = fakeToken(BOT_TOKEN_PREFIX, 'cut')
      const text = new TextDecoder().decode(altered((doc) => { doc.personas.alpha.declaration.name = token }))
      return new TextEncoder().encode(text.slice(0, text.indexOf(token) + token.length))
    }],
    ['a validation failure whose refused key is a fake token', () => altered((doc) => { doc.personas[fakeToken(BOT_TOKEN_PREFIX, 'key')] = doc.personas.alpha })],
    ['a validation failure whose refused value is a fake token', () => altered((doc) => { doc.personas.alpha.channels[C1].delivery = fakeToken(BOT_TOKEN_PREFIX, 'value') })],
  ])('%s: the one line carries no file content', (_label, build) => {
    const bytes = build()
    writeFileSync(filePath(), bytes)

    const rig = openRig()

    expect(rig.store.readable).toBe(false)
    expect(rig.logs).toEqual([channelDeliveryUnreadableLine(filePath(), refusalOf(bytes))])
    // The seeded file itself holds the token, so only the line is checked.
    expectNoLeak(rig, {}, false)
  })
})

// ---------------------------------------------------------------------------
// S3: whole-record durable writes and their failures (SRI-404, SRI-905, SRI-907)
// ---------------------------------------------------------------------------

describe('an accepted set writes the whole record, durably (b.deo SRI-404)', () => {
  test('with the production writer: the given declaration and the clock\'s set_at stored, the file parsing back to the record in memory, the earlier choice answered', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const clock = createFakeClock({ start: START_MS })
    const logs: string[] = []
    const store = loadChannelDeliveryStore(stateDir, { log: (line) => logs.push(line), now: () => clock.now() })
    const moved = { ...personaNamed('beta'), working_directory: join(root, 'elsewhere') }

    const first = store.set('beta', C1, 'mentions', declarationOf(moved))
    const second = store.set('beta', C1, 'all', declarationOf(moved))

    expect([first, second]).toEqual([
      { kind: CHANNEL_DELIVERY_SET_STORED, previous: undefined },
      { kind: CHANNEL_DELIVERY_SET_STORED, previous: 'mentions' },
    ])
    expect(store.storedChoice('beta', C1)).toBe('all')
    // The channel added last comes first: storedChannels answers the IDs sorted.
    expect(store.storedChannels('beta')).toEqual([C1, G3])
    expect(store.record().get('beta')).toEqual({
      declaration: declarationOf(moved),
      channels: new Map([
        [C1, { delivery: 'all', set_at: new Date(START_MS).toISOString() }],
        [G3, { delivery: 'all', set_at: SAMPLE_SET_AT }],
      ]),
    })
    expect(store.record().get('alpha')).toEqual(channelDeliveryRecordOf(baseSeeds()).get('alpha')!)
    expect(readChannelDeliveryRecord(stateDir)).toEqual(store.record())
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expect(logs).toEqual([])
    assertNoLeak({ logs, files: filesWritten() })
  })

  test('one set is one write of the whole record held in memory, with the change', async () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig()
    await rig.clock.advance(5_000)

    rig.store.set('alpha', C1, 'mentions', declarationOf(personaNamed('alpha')))

    expect(rig.writes).toHaveLength(1)
    expect(rig.writes[0]).toEqual(serializeChannelDelivery(rig.store.record()))
    expect(rig.store.record().get('alpha')!.channels.get(C1)).toEqual({ delivery: 'mentions', set_at: new Date(START_MS + 5_000).toISOString() })
    expect(rig.store.record().get('beta')).toEqual(channelDeliveryRecordOf(baseSeeds()).get('beta')!)
    expectNoLeak(rig)
  })

  test.each<[string, (rig: Rig, decl: ChannelDeliveryDeclaration) => unknown, string]>([
    ['a key that is not a persona key', (rig, decl) => rig.store.set('Not A Key', C1, 'all', decl), 'key'],
    ['a malformed channel ID', (rig, decl) => rig.store.set('alpha', 'c0lower', 'all', decl), 'channel'],
    ['a delivery that is not a delivery value', (rig, decl) => rig.store.set('alpha', C1, 'none' as DeliveryMode, decl), 'delivery'],
    ['a declaration missing a field', (rig, decl) => rig.store.set('alpha', C1, 'all', { name: decl.name } as ChannelDeliveryDeclaration), 'declaration'],
    ['a clock that gives no timestamp', (rig, decl) => {
      rig.clock = { ...rig.clock, now: () => Number.NaN }
      return rig.store.set('alpha', C1, 'all', decl)
    }, 'set_at'],
  ])('only an accepted set creates a missing file: %s is refused with no write and no file', (_label, act, field) => {
    const decl = declarationOf(personaNamed('alpha'))
    const rig = openRig()

    const refused = act(rig, decl)

    expect(refused).toEqual({ kind: CHANNEL_DELIVERY_SET_INVALID, field })
    expect(rig.writes).toEqual([])
    expect(stateEntries()).toEqual([])

    rig.clock = createFakeClock({ start: START_MS })
    expect(rig.store.set('alpha', C1, 'all', decl).kind).toBe(CHANNEL_DELIVERY_SET_STORED)
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expectNoLeak(rig, { refused })
  })

  test('no store operation returns a promise', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const alpha = personaNamed('alpha')
    const rig = openRig()
    const store = rig.store
    const results: unknown[] = [
      store.storedChoice('alpha', C1),
      store.storedChannels('alpha'),
      store.record(),
      store.set('alpha', C1, 'mentions', declarationOf(alpha)),
      store.drop([{ key: 'beta', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED }]),
      store.hasUnwrittenDrop('beta'),
      store.writeUnwrittenDrops(),
      store.applyStartRules(startOf([alpha])),
      store.beginRetiring(['alpha']),
      store.isRetiring('alpha'),
      store.endRetiring(['alpha']),
    ]

    for (const result of results) expect(typeof (result as { then?: unknown } | undefined)?.then).toBe('undefined')
    expectNoLeak(rig, { results })
  })
})

describe('a failed set leaves memory and the file as they were (b.deo SRI-404, SRI-905)', () => {
  /** The failed-write line of a set of `alpha` in C1. */
  const setLine = (detail: string): string => channelDeliveryWriteFailedLine(filePath(), channelDeliverySetAction('alpha', C1), detail, false)

  test.each(BEFORE_RENAME.map((failure) => [failure.step, failure] as const))('a failure at %s, before the rename: write-failed, memory and the file\'s bytes unchanged, no temporary file, one line', (_step, failure) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = fileBytes()
    const rig = openRig({ failures: [failure] })

    const result = rig.store.set('alpha', C1, 'mentions', declarationOf(personaNamed('alpha')))

    expect(result).toEqual({ kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: filePath() })
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(baseSeeds()))
    expect(rig.store.storedChoice('alpha', C1)).toBe('all')
    expect(fileBytes()).toEqual(before)
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expect(rig.logs).toHaveLength(1)
    expectWriteFailedLine(rig.logs[0]!, setLine, [rig.thrown[0]!])
    expectNoLeak(rig, { result })
  })

  test.each<[string, readonly FsFailure[]]>([
    ['the directory\'s fsync fails', [UNSYNCED]],
    ['the directory\'s open fails', [{ step: 'openSync', call: 2 }]],
  ])('an unsynced rename (%s): the replaced bytes are written back, memory unchanged, one line', (_label, failures) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = fileBytes()
    const rig = openRig({ failures })

    const result = rig.store.set('alpha', C1, 'mentions', declarationOf(personaNamed('alpha')))

    expect(result).toEqual({ kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: filePath() })
    expect(rig.writes).toHaveLength(2)
    expect(rig.writes[1]).toEqual(before!)
    expect(fileBytes()).toEqual(before)
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(baseSeeds()))
    expect(rig.logs).toHaveLength(1)
    expect(rig.thrown).toHaveLength(1)
    expectWriteFailedLine(rig.logs[0]!, setLine, rig.thrown)
    expectNoLeak(rig, { result })
  })

  test('an unsynced rename whose write-back\'s directory fsync fails too: the bytes written back, memory unchanged, one line reporting the write-back done without its code; the next unsynced set writes back the same bytes', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = fileBytes()
    const alpha = declarationOf(personaNamed('alpha'))
    const [head, tail] = lineParts(setLine) as [string, string]
    const detailOf = (line: string): string => line.slice(head.length, line.length - tail.length)
    // The store's own line for a write-back that synced, from a store of its own over the same file.
    const synced = openRig({ failures: [UNSYNCED] })
    synced.store.set('alpha', C1, 'mentions', alpha)
    expect(fileBytes()).toEqual(before)
    const writtenBack = synced.logs[0]!
    const rig = openRig({ failures: [UNSYNCED, { step: 'fsyncSync', call: 4, code: 'ENOSPC' }] })

    const result = rig.store.set('alpha', C1, 'mentions', alpha)

    expect(result).toEqual({ kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: filePath() })
    expect(rig.writes).toHaveLength(2)
    expect(rig.writes[1]).toEqual(before!)
    expect(fileBytes()).toEqual(before)
    expect(stateEntries()).toEqual([CHANNEL_DELIVERY_FILE_NAME])
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(baseSeeds()))
    expect(rig.thrown.map((err) => err.code)).toEqual(['EIO', 'ENOSPC'])
    expect(rig.logs).toHaveLength(1)
    // The line names the first failure's code, then the written-back branch,
    // extended; the write-back's own code is not in it (its bytes were
    // restored), so it is not the branch whose putting back failed.
    expectWriteFailedLine(rig.logs[0]!, setLine, [rig.thrown[0]!])
    const detail = detailOf(rig.logs[0]!)
    expect(detail.startsWith(detailOf(writtenBack))).toBe(true)
    expect(detail.length).toBeGreaterThan(detailOf(writtenBack).length)
    expect(detail).not.toContain(errnoSuffix(rig.thrown[1]!))

    // The bytes the store believes the file holds are still the original ones.
    rig.fail(UNSYNCED)
    expect(rig.store.set('alpha', C1, 'mentions', alpha).kind).toBe(CHANNEL_DELIVERY_SET_WRITE_FAILED)
    expect(rig.writes).toHaveLength(4)
    expect(rig.writes[3]).toEqual(before!)
    expect(fileBytes()).toEqual(before)
    expect(rig.logs[1]).toBe(writtenBack)
    expectNoLeak(rig, { result, synced: synced.logs })
  })

  test('an unsynced rename over a file that did not exist: the file removed again, nothing in memory, one line', () => {
    const rig = openRig({ failures: [UNSYNCED] })

    const result = rig.store.set('alpha', C1, 'mentions', declarationOf(personaNamed('alpha')))

    expect(result).toEqual({ kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: filePath() })
    expect(stateEntries()).toEqual([])
    expect(rig.store.record().size).toBe(0)
    expect(rig.logs).toHaveLength(1)
    expectWriteFailedLine(rig.logs[0]!, setLine, [rig.thrown[0]!])
    expectNoLeak(rig, { result })
  })

  test.each<[string, boolean, FsFailure]>([
    ['the previous record\'s write-back fails', true, { step: 'renameSync', call: 2, code: 'ENOSPC' }],
    ['removing the file, absent before, fails', false, { step: 'unlinkSync', call: 1, code: 'EBUSY' }],
  ])('an unsynced rename whose putting back fails (%s): both codes in the one line, the refused choice on disk and not in memory, read by a fresh load, replaced by the next successful write', (_label, seeded, backFailure) => {
    if (seeded) writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = seeded ? channelDeliveryRecordOf(baseSeeds()) : new Map()
    const rig = openRig({ failures: [UNSYNCED, backFailure] })

    const result = rig.store.set('alpha', C1, 'mentions', declarationOf(personaNamed('alpha')))

    expect(result).toEqual({ kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path: filePath() })
    expect(rig.logs).toHaveLength(1)
    expect(rig.thrown).toHaveLength(2)
    expectWriteFailedLine(rig.logs[0]!, setLine, rig.thrown)
    expect(rig.store.record()).toEqual(before)
    expect(readChannelDeliveryRecord(stateDir)!.get('alpha')!.channels.get(C1)!.delivery).toBe('mentions')
    // A restart before the next successful write reads the refused choice.
    const fresh = openRig()
    expect(fresh.store.storedChoice('alpha', C1)).toBe('mentions')

    rig.fail()
    expect(rig.store.set('beta', C2, 'mentions', declarationOf(personaNamed('beta'))).kind).toBe(CHANNEL_DELIVERY_SET_STORED)
    expect(fileBytes()).toEqual(serializeChannelDelivery(rig.store.record()))
    expect(readChannelDeliveryRecord(stateDir)!.get('alpha')?.channels.get(C1)?.delivery).toBe(seeded ? 'all' : undefined)
    expectNoLeak(rig, { result, fresh: fresh.logs })
  })

  // SRI-905 gives no exact text: the one pin of the failed-write line, each
  // variant's detail typed here, every other case building it with the builder.
  test('pin: the failed-write line of a set, of a set whose write-back failed too, and of a drop; each names the file, the action and the codes, and none names a choice', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig({ failures: [{ step: 'renameSync' }] })
    const alpha = declarationOf(personaNamed('alpha'))
    const path = filePath()

    rig.store.set('alpha', C1, 'mentions', alpha)
    rig.fail(UNSYNCED, { step: 'renameSync', call: 2, code: 'ENOSPC' })
    rig.store.set('alpha', C1, 'mentions', alpha)
    rig.fail({ step: 'renameSync' })
    rig.store.drop([{ key: 'beta', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED }])

    const expected = [
      channelDeliveryWriteFailedLine(path, channelDeliverySetAction('alpha', C1), ' (EIO); the file is unchanged', false),
      channelDeliveryWriteFailedLine(
        path,
        channelDeliverySetAction('alpha', C1),
        ': the record was written but its directory could not be synced (EIO); putting the previous state back failed too (ENOSPC), so the file holds the refused choice until the next successful write',
        false,
      ),
      channelDeliveryDropLine('beta', 1, CHANNEL_DELIVERY_DROP_NOT_APPLIED),
      channelDeliveryWriteFailedLine(path, channelDeliveryDropAction(['beta']), ' (EIO); the file is unchanged', true),
    ]
    expect(rig.logs).toEqual(expected)
    const [set, setBack, , drop] = rig.logs as [string, string, string, string]
    for (const line of [set, setBack, drop]) {
      expect(line.startsWith(`${CHANNEL_DELIVERY_LOG_PREFIX} cannot `)).toBe(true)
      expect(line).toContain(JSON.stringify(path))
      expect(line).toContain('(EIO)')
      expect(namesAChoice(line, path)).toBe(false)
    }
    expect(set).toContain(`persona=alpha for channel ${C1}`)
    expect(setBack).toContain('(ENOSPC)')
    expect(drop).toContain('write the drop of persona=beta')
    expect(drop).toContain('the next successful write of the file carries the drop')
    expectNoLeak(rig)
  })
})

describe('the stored-choice file holds the credentials file\'s path, never its content (b.deo SRI-907)', () => {
  test('a persona whose credentials file holds fake tokens has a choice stored: the file holds the path and none of the content', () => {
    const credentials = writeCredentialsFile(join(root, 'secrets'), 'persona.json')
    const [persona] = personasOf([{ name: 'alpha', credentials_file: credentials }])
    const rig = openRig()

    expect(rig.store.set(persona!.key, C1, 'all', declarationOf(persona!)).kind).toBe(CHANNEL_DELIVERY_SET_STORED)

    expect(readChannelDeliveryRecord(stateDir)!.get(persona!.key)!.declaration.credentials_file).toBe(credentials)
    const text = new TextDecoder().decode(fileBytes()!)
    for (const value of Object.values(makeCredentials())) expect(text).not.toContain(String(value))
    expectNoLeak(rig, { file: writtenFile(filePath()) })
  })
})

// ---------------------------------------------------------------------------
// S4: drops and unwritten drops (SRI-405, SRI-905)
// ---------------------------------------------------------------------------

describe('drops and unwritten drops (b.deo SRI-405, SRI-905)', () => {
  /** The failed-write line of a drop of `keys`. */
  const dropLine = (keys: readonly string[]) => (detail: string): string =>
    channelDeliveryWriteFailedLine(filePath(), channelDeliveryDropAction(keys), detail, true)

  test.each<[string, readonly FsFailure[]]>([
    ['its write succeeds', []],
    ['its write fails before the rename', [{ step: 'renameSync' }]],
    ['its rename is unsynced', [UNSYNCED]],
  ])('a drop removes the key\'s choices from memory at once when %s', (_label, failures) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig({ failures })

    rig.store.drop([{ key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED }])

    expect(rig.store.storedChoice('alpha', C1)).toBeUndefined()
    expect(rig.store.storedChannels('alpha')).toEqual([])
    expect(rig.store.record().has('alpha')).toBe(false)
    expect(rig.store.storedChoice('beta', G3)).toBe('all')
    expectNoLeak(rig)
  })

  test('a batch of keys with different reasons is one write, with one drop line per key', () => {
    const seeds = { ...baseSeeds(), gamma: seedFor(personaNamed('gamma'), { [C1]: { delivery: 'all' } }) }
    writeChannelDeliveryRecord(stateDir, seeds)
    const rig = openRig()

    const outcome = rig.store.drop([
      { key: 'alpha', reason: CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED },
      { key: 'beta', reason: CHANNEL_DELIVERY_DROP_RETIRED },
    ])

    expect(outcome).toBe(CHANNEL_DELIVERY_WRITTEN)
    expect(rig.writes).toHaveLength(1)
    expect(rig.logs).toEqual([
      channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED),
      channelDeliveryDropLine('beta', 1, CHANNEL_DELIVERY_DROP_RETIRED),
    ])
    expect(readChannelDeliveryRecord(stateDir)).toEqual(new Map([['gamma', channelDeliveryRecordOf(seeds).get('gamma')!]]))
    expectNoLeak(rig)
  })

  test('a key named twice in a batch is dropped once, with its first reason', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig()

    rig.store.drop([
      { key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED },
      { key: 'alpha', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED },
    ])

    expect(rig.logs).toEqual([channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_RETIRED)])
    expect(rig.writes).toHaveLength(1)
    expectNoLeak(rig)
  })

  test('a batch holding an unknown reason throws a RangeError before any change: memory, the file and the log as they were', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = fileBytes()
    const rig = openRig()

    const thrown = thrownBy(() =>
      rig.store.drop([
        { key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED },
        { key: 'beta', reason: 'unknown' as ChannelDeliveryDropReason },
      ]),
    )

    expect(thrown).toBeInstanceOf(RangeError)
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(baseSeeds()))
    expect(rig.store.hasUnwrittenDrop('alpha')).toBe(false)
    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual([])
    expect(fileBytes()).toEqual(before)
    expectNoLeak(rig, { thrown })
  })

  test.each<[string, boolean]>([
    ['over a file', true],
    ['with no file, which it never creates', false],
  ])('a drop of a key with no entries writes and logs nothing, %s', (_label, seeded) => {
    if (seeded) writeChannelDeliveryRecord(stateDir, baseSeeds())
    const before = fileBytes()
    const rig = openRig()

    expect(rig.store.drop([{ key: 'gamma', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED }])).toBe(CHANNEL_DELIVERY_NOTHING_TO_WRITE)

    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual([])
    expect(fileBytes()).toEqual(before)
    expect(rig.store.hasUnwrittenDrop('gamma')).toBe(false)
    expectNoLeak(rig)
  })

  test.each<[string, FsFailure]>([
    ['a write that fails before the rename', { step: 'renameSync' }],
    ['an unsynced rename', UNSYNCED],
  ])('%s: the drop lines, then one failed-write line naming the file and the keys; each key left with an unwritten drop', (_label, failure) => {
    const seeds = { ...baseSeeds(), gamma: seedFor(personaNamed('gamma'), { [C1]: { delivery: 'all' } }) }
    writeChannelDeliveryRecord(stateDir, seeds)
    const rig = openRig({ failures: [failure] })

    const outcome = rig.store.drop([
      { key: 'beta', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED },
      { key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED },
    ])

    expect(outcome).toBe(CHANNEL_DELIVERY_WRITE_FAILED)
    expect(rig.logs).toHaveLength(3)
    expect(rig.logs.slice(0, 2)).toEqual([
      channelDeliveryDropLine('beta', 1, CHANNEL_DELIVERY_DROP_NOT_APPLIED),
      channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_RETIRED),
    ])
    expectWriteFailedLine(rig.logs[2]!, dropLine(['alpha', 'beta']), [rig.thrown[0]!])
    expect(['alpha', 'beta', 'gamma'].map((key) => rig.store.hasUnwrittenDrop(key))).toEqual([true, true, false])
    // A drop's failed write writes nothing back.
    expect(rig.writes).toHaveLength(1)
    expectNoLeak(rig, { outcome })
  })

  test.each<[string, (rig: Rig) => unknown]>([
    ['an accepted set of another key', (rig) => rig.store.set('beta', C1, 'mentions', declarationOf(personaNamed('beta')))],
    ['writeUnwrittenDrops', (rig) => rig.store.writeUnwrittenDrops()],
  ])('after a failed drop write, the next successful write (%s) leaves no entry of the key on disk and clears its unwritten drop (AC 23)', (_label, act) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig({ failures: [{ step: 'renameSync' }] })
    rig.store.drop([{ key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED }])
    expect(readChannelDeliveryRecord(stateDir)!.has('alpha')).toBe(true)
    rig.fail()

    const result = act(rig)

    expect(rig.writes).toHaveLength(2)
    expect(readChannelDeliveryRecord(stateDir)!.has('alpha')).toBe(false)
    expect(rig.store.hasUnwrittenDrop('alpha')).toBe(false)
    expect(fileBytes()).toEqual(serializeChannelDelivery(rig.store.record()))
    expectNoLeak(rig, { result })
  })

  test('writeUnwrittenDrops with nothing pending writes and logs nothing', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig()

    expect(rig.store.writeUnwrittenDrops()).toBe(CHANNEL_DELIVERY_NOTHING_TO_WRITE)

    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual([])
    expectNoLeak(rig)
  })

  test.each<[string, FsFailure]>([
    ['fails before the rename', { step: 'writeSync' }],
    ['has an unsynced rename', UNSYNCED],
  ])('writeUnwrittenDrops that %s keeps the unwritten drops and logs one failed-write line', (_label, failure) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig({ failures: [{ step: 'renameSync' }] })
    rig.store.drop([{ key: 'alpha', reason: CHANNEL_DELIVERY_DROP_RETIRED }])
    const linesBefore = rig.logs.length
    rig.fail(failure)

    expect(rig.store.writeUnwrittenDrops()).toBe(CHANNEL_DELIVERY_WRITE_FAILED)

    expect(rig.store.hasUnwrittenDrop('alpha')).toBe(true)
    expect(rig.logs).toHaveLength(linesBefore + 1)
    expectWriteFailedLine(rig.logs.at(-1)!, dropLine(['alpha']), [rig.thrown.at(-1)!])
    expectNoLeak(rig)
  })

  test.each(CHANNEL_DELIVERY_DROP_REASONS.map((reason) => [reason] as const))('a drop for "%s" logs one line per key that lost entries, built with the drop-line builder', (reason) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig()

    rig.store.drop([{ key: 'alpha', reason }, { key: 'gamma', reason }])

    expect(rig.logs).toEqual([channelDeliveryDropLine('alpha', 2, reason)])
    expectNoLeak(rig)
  })

  // SRI-905 gives no exact text: the one pin of the drop line.
  test('pin: the drop line is its builder\'s, and names the key, the number of channels and the reason, and never a choice', () => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const rig = openRig()

    rig.store.drop([{ key: 'alpha', reason: CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED }, { key: 'beta', reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED }])

    expect(rig.logs).toEqual([
      channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED),
      channelDeliveryDropLine('beta', 1, CHANNEL_DELIVERY_DROP_NOT_APPLIED),
    ])
    const [alpha, beta] = rig.logs as [string, string]
    expect(alpha.startsWith(CHANNEL_DELIVERY_LOG_PREFIX)).toBe(true)
    expect(alpha).toContain('persona=alpha')
    expect(alpha).toContain('in 2 channels')
    expect(alpha).toContain(CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED)
    expect(beta).toContain('persona=beta')
    expect(beta).toContain('in 1 channel:')
    expect(beta).toContain(CHANNEL_DELIVERY_DROP_NOT_APPLIED)
    for (const line of rig.logs) expect(namesAChoice(line, filePath())).toBe(false)
    expectNoLeak(rig)
  })
})

// ---------------------------------------------------------------------------
// S5: the start rules (SRI-407)
// ---------------------------------------------------------------------------

describe('the start rules (b.deo SRI-407 beside b.av2 SR-8.7; AC 20)', () => {
  /** A start's personas: `keep` (always applied, unchanged) and the subject `alpha`, both on disk. */
  function startPersonas(): { keep: Persona; alpha: Persona } {
    const [keep, alpha] = personasOf([{ name: 'keep' }, { name: 'alpha' }])
    return { keep: onDisk(keep!), alpha: onDisk(alpha!) }
  }

  /** The seeds of a start: `keep` and `alpha` as recorded, each in two channels. */
  function startSeeds(keep: Persona, alpha: Persona): Record<string, ChannelDeliveryPersonaSeed> {
    return {
      keep: seedFor(keep, { [C1]: { delivery: 'all' }, [G3]: { delivery: 'mentions', set_at: EARLIER_SET_AT } }),
      alpha: seedFor(alpha, { [C1]: { delivery: 'all' }, [C2]: { delivery: 'all' } }),
    }
  }

  /** A start scenario: the applied personas (by the recorded `alpha` and `keep`) and the retired-key record. */
  interface Scenario {
    applied: (keep: Persona, alpha: Persona) => Persona[]
    retired?: Readonly<Record<string, RetiredKeySeed>>
  }

  const DROPPED: Array<[string, Scenario, ChannelDeliveryDropReason]> = [
    ['an orphan key', { applied: (keep) => [keep] }, CHANNEL_DELIVERY_DROP_NOT_APPLIED],
    ['an applied key whose name changed only in case', { applied: (keep, alpha) => [keep, { ...alpha, name: 'Alpha' }] }, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED],
    ['an applied key whose credentials_file changed', {
      applied: (keep, alpha) => [keep, { ...alpha, credentials_file: writeCredentialsFile(join(root, 'other'), 'credentials.json') }],
    }, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED],
    ['an applied key whose working_directory changed', {
      applied: (keep, alpha) => {
        const other = join(root, 'other-work')
        mkdirSync(other)
        return [keep, { ...alpha, working_directory: other }]
      },
    }, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED],
    ['an applied key held in the retired-key record with new_life_begun_at null', {
      applied: (keep, alpha) => [keep, alpha],
      retired: { alpha: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY } },
    }, CHANNEL_DELIVERY_DROP_RETIRED],
  ]

  test.each(DROPPED)('%s is dropped at start, in one write, with one line naming its reason; the kept key\'s entries are unchanged', (_label, scenario, reason) => {
    const { keep, alpha } = startPersonas()
    const seeds = startSeeds(keep, alpha)
    writeChannelDeliveryRecord(stateDir, seeds)

    const rig = openRig({ start: startOf(scenario.applied(keep, alpha), scenario.retired) })

    expect(rig.writes).toHaveLength(1)
    expect(rig.logs).toEqual([channelDeliveryDropLine('alpha', 2, reason)])
    expect(rig.store.record().has('alpha')).toBe(false)
    expect(readChannelDeliveryRecord(stateDir)).toEqual(new Map([['keep', channelDeliveryRecordOf(seeds).get('keep')!]]))
    expectOnlyRemoved(rig.store, seeds)
    expectNoLeak(rig)
  })

  const KEPT: Array<[string, Scenario]> = [
    ['a key held in the retired-key record with its mark set', {
      applied: (keep, alpha) => [keep, alpha],
      retired: { alpha: { cause: RETIRED_KEY_CAUSE_REMOVED, mark: true } },
    }],
    ['a working_directory given through a symlink to the same directory', {
      applied: (keep, alpha) => {
        const link = join(root, 'links', 'work')
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(alpha.working_directory, link)
        return [keep, { ...alpha, working_directory: link }]
      },
    }],
    ['a credentials_file given through a symlink to the same file', {
      applied: (keep, alpha) => {
        const link = join(root, 'links', 'credentials.json')
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(alpha.credentials_file, link)
        return [keep, { ...alpha, credentials_file: link }]
      },
    }],
    ['both paths respelled with the same real paths', {
      applied: (keep, alpha) => [keep, {
        ...alpha,
        working_directory: `${alpha.working_directory}/../${basename(alpha.working_directory)}/`,
        credentials_file: `${dirname(alpha.credentials_file)}/./${basename(alpha.credentials_file)}`,
      }],
    }],
  ]

  test.each(KEPT)('%s keeps the entries byte-identical: no write, no line', (_label, scenario) => {
    const { keep, alpha } = startPersonas()
    const seeds = startSeeds(keep, alpha)
    writeChannelDeliveryRecord(stateDir, seeds)
    const before = fileBytes()

    const rig = openRig({ start: startOf(scenario.applied(keep, alpha), scenario.retired) })

    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual([])
    expect(fileBytes()).toEqual(before)
    expect(rig.store.record()).toEqual(channelDeliveryRecordOf(seeds))
    expectNoLeak(rig)
  })

  test('a path respelled through a symlink whose target later changes reads as changed at the next start and is dropped', () => {
    const { keep, alpha } = startPersonas()
    const seeds = startSeeds(keep, alpha)
    writeChannelDeliveryRecord(stateDir, seeds)
    const link = join(root, 'links', 'work')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(alpha.working_directory, link)
    const respelled = { ...alpha, working_directory: link }

    const first = openRig({ start: startOf([keep, respelled]) })
    expect(first.logs).toEqual([])

    const retargeted = join(root, 'retargeted')
    mkdirSync(retargeted)
    rmSync(link)
    symlinkSync(retargeted, link)
    const second = openRig({ start: startOf([keep, respelled]) })

    expect(second.logs).toEqual([channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED)])
    expect(readChannelDeliveryRecord(stateDir)!.has('alpha')).toBe(false)
    expectOnlyRemoved(second.store, seeds)
    expectNoLeak(second, { first: first.logs })
  })

  test.each<[string, Scenario, ChannelDeliveryDropReason]>([
    ['an orphan key also held unmarked in the retired-key record is dropped as not applied', {
      applied: (keep) => [keep],
      retired: { alpha: { cause: RETIRED_KEY_CAUSE_REMOVED } },
    }, CHANNEL_DELIVERY_DROP_NOT_APPLIED],
    ['a changed declaration also held unmarked in the retired-key record is dropped as declaration changed', {
      applied: (keep, alpha) => [keep, { ...alpha, name: 'Alpha' }],
      retired: { alpha: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY } },
    }, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED],
  ])('precedence: %s, with exactly one line', (_label, scenario, reason) => {
    const { keep, alpha } = startPersonas()
    writeChannelDeliveryRecord(stateDir, startSeeds(keep, alpha))

    const rig = openRig({ start: startOf(scenario.applied(keep, alpha), scenario.retired) })

    expect(rig.logs).toEqual([channelDeliveryDropLine('alpha', 2, reason)])
    expect(rig.writes).toHaveLength(1)
    expectNoLeak(rig)
  })

  test.each<[string, boolean]>([
    ['a declarative', false],
    ['a fungible', true],
  ])('applied personas from %s configuration give the same result', (_label, fungible) => {
    const [keep, alpha, beta] = personasOf([{ name: 'keep' }, { name: 'alpha' }, { name: 'beta' }], fungible).map(onDisk)
    const seeds = {
      ...startSeeds(keep!, alpha!),
      beta: seedFor(beta!, { [C2]: { delivery: 'mentions' } }),
      gone: seedFor(personaNamed('gone'), { [G3]: { delivery: 'all' } }),
    }
    writeChannelDeliveryRecord(stateDir, seeds)

    const rig = openRig({ start: startOf([keep!, { ...alpha!, name: 'Alpha' }, beta!], { beta: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY } }) })

    expect(rig.logs).toEqual([
      channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED),
      channelDeliveryDropLine('beta', 1, CHANNEL_DELIVERY_DROP_RETIRED),
      channelDeliveryDropLine('gone', 1, CHANNEL_DELIVERY_DROP_NOT_APPLIED),
    ])
    expect(rig.writes).toHaveLength(1)
    expect(readChannelDeliveryRecord(stateDir)).toEqual(new Map([['keep', channelDeliveryRecordOf(seeds).get('keep')!]]))
    expectNoLeak(rig)
  })

  test.each<[string, boolean]>([
    ['a file whose every key matches its applied persona', true],
    ['a missing file', false],
  ])('when nothing matches (%s): no write, no line, the bytes unchanged', (_label, seeded) => {
    const { keep, alpha } = startPersonas()
    if (seeded) writeChannelDeliveryRecord(stateDir, startSeeds(keep, alpha))
    const before = fileBytes()

    const rig = openRig({ start: startOf([keep, alpha], { other: { cause: RETIRED_KEY_CAUSE_REMOVED } }) })

    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual([])
    expect(fileBytes()).toEqual(before)
    expect(stateEntries()).toEqual(seeded ? [CHANNEL_DELIVERY_FILE_NAME] : [])
    expectNoLeak(rig)
  })

  test('a failed start-rule write logs the drop lines and one failed-write line, and leaves each dropped key with an unwritten drop', () => {
    const { keep, alpha } = startPersonas()
    const seeds = { ...startSeeds(keep, alpha), gone: seedFor(personaNamed('gone'), { [G3]: { delivery: 'all' } }) }
    writeChannelDeliveryRecord(stateDir, seeds)
    const before = fileBytes()

    const rig = openRig({ start: startOf([keep, { ...alpha, name: 'Alpha' }]), failures: [{ step: 'renameSync' }] })

    expect(rig.logs).toHaveLength(3)
    expect(rig.logs.slice(0, 2)).toEqual([
      channelDeliveryDropLine('alpha', 2, CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED),
      channelDeliveryDropLine('gone', 1, CHANNEL_DELIVERY_DROP_NOT_APPLIED),
    ])
    expectWriteFailedLine(
      rig.logs[2]!,
      (detail) => channelDeliveryWriteFailedLine(filePath(), channelDeliveryDropAction(['alpha', 'gone']), detail, true),
      [rig.thrown[0]!],
    )
    expect(['alpha', 'gone', 'keep'].map((key) => rig.store.hasUnwrittenDrop(key))).toEqual([true, true, false])
    expect(rig.store.record()).toEqual(new Map([['keep', channelDeliveryRecordOf(seeds).get('keep')!]]))
    expect(fileBytes()).toEqual(before)
    expectNoLeak(rig)
  })
})

// ---------------------------------------------------------------------------
// S6: the in-memory retiring-key set (SRI-502's store part)
// ---------------------------------------------------------------------------

describe('the store\'s retiring keys are held in memory only (b.deo SRI-502)', () => {
  test.each<[string, boolean]>([
    ['a readable store', true],
    ['an unreadable store', false],
  ])('%s: a key is retiring from beginRetiring until endRetiring, other keys are not, nothing is written or logged, and a fresh store has none', (_label, readable) => {
    writeChannelDeliveryRecord(stateDir, baseSeeds())
    const readFs: Partial<PersonaConfigFs> | undefined = readable ? undefined : { readFileFd: () => { throw injected('EIO', 'read') } }
    const rig = openRig({ readFs })
    expect(rig.store.readable).toBe(readable)
    const linesAtLoad = [...rig.logs]
    const before = fileBytes()

    rig.store.beginRetiring(['alpha', 'beta'])
    const begun = ['alpha', 'beta', 'gamma'].map((key) => rig.store.isRetiring(key))
    rig.store.endRetiring(['alpha'])
    const ended = ['alpha', 'beta', 'gamma'].map((key) => rig.store.isRetiring(key))

    expect(begun).toEqual([true, true, false])
    expect(ended).toEqual([false, true, false])
    expect(rig.writes).toEqual([])
    expect(rig.logs).toEqual(linesAtLoad)
    expect(fileBytes()).toEqual(before)

    // The readable store writes the file while `beta` is retiring.
    if (readable) expect(rig.store.set('gamma', C1, 'all', declarationOf(personaNamed('gamma'))).kind).toBe(CHANNEL_DELIVERY_SET_STORED)
    const fresh = openRig()

    expect(fresh.store.readable).toBe(true)
    expect(['alpha', 'beta', 'gamma'].map((key) => fresh.store.isRetiring(key))).toEqual([false, false, false])
    expectNoLeak(rig, { fresh: fresh.logs })
  })
})
