/**
 * atomic-write.test.ts — Tests for durableWriteFileSync in src/atomic-write.ts,
 * the atomic and durable write of the reload files (b.av2 SR-8.1): a uniquely
 * named temporary file, fsync, rename over the target, then fsync of the
 * directory.
 *
 * The happy path runs on the real file system in a mkdtempSync directory. The
 * order of the calls and every failure are driven through the writer's
 * injectable fs seam by `makeRecordingFs`, which records each call, delegates
 * it to the real `node:fs` in the same temp directory (so a failure leaves
 * real files to inspect) and can make a chosen step throw. Injected failures
 * work the same under root, where permission bits do not. A failure before
 * the rename is thrown as raised; a directory open or fsync failure after it
 * is a `DurableWriteUnsyncedError`; a directory close failure is ignored.
 *
 * `durableUnlinkSync`, the durable delete of `config.json.pending` (b.av2
 * SR-8.1, SR-8.3), runs on the same seam: unlink, then fsync of the
 * directory; an absent target (ENOENT, ENOTDIR) returns false and syncs
 * nothing; every other unlink failure reaches the caller as raised, and a
 * directory open or fsync failure after the unlink is a
 * `DurableUnlinkUnsyncedError`.
 *
 * `atomicWriteFileSync` (E10) is covered by the stop-hook and reply-guard
 * suites and is not tested here.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  closeSync,
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
import { basename, dirname, join } from 'node:path'
import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  DurableWriteUnsyncedError,
  type DurableWriteFs,
} from '../src/atomic-write.ts'
import { reloadFilePaths } from '../src/reload.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string
let target: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'))
  target = join(dir, 'config.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const OLD_BYTES = new TextEncoder().encode('{"personas": [{"name": "old", "padding": "longer than the new bytes"}]}\n')
const NEW_BYTES = new TextEncoder().encode('{"personas": []}\n')

/** Run `fn` and return what it threw, or undefined when it returned. */
function caught(fn: () => void): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  return undefined
}

/** An errno-style error, as `node:fs` throws. */
function errnoError(code: string, step: Step): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${step} failure`), { code })
}

/** The directory's entries, sorted. */
function entries(): string[] {
  return readdirSync(dir).sort()
}

// ---------------------------------------------------------------------------
// Recording fs seam
// ---------------------------------------------------------------------------

/** One call of the seam, named by what it does in the durable write. */
type Step = 'open-temp' | 'write' | 'fsync-temp' | 'close-temp' | 'rename' | 'open-dir' | 'fsync-dir' | 'close-dir' | 'unlink'

interface Op {
  step: Step
  /** The opened, renamed-from or unlinked path. */
  path?: string
  /** The rename's destination. */
  to?: string
  flags?: string
  fd?: number
  offset?: number
  length?: number
}

interface RecordingFsOptions {
  /** Steps that throw an injected errno error (each time they run). */
  failAt?: Step[]
  /** The injected error's errno code per failing step; EIO when not given. */
  codes?: Partial<Record<Step, string>>
  /** A value to throw as is at a failing step, instead of an errno error (not recorded in `errors`). */
  thrown?: Partial<Record<Step, unknown>>
  /** Largest number of bytes one writeSync call writes (a short write). */
  maxChunk?: number
  /** Called before each step is carried out, e.g. to look at the target mid-write. */
  before?: (step: Step) => void
}

interface RecordingFs {
  fs: DurableWriteFs
  ops: Op[]
  /** The injected error thrown at each failing step. */
  errors: Map<Step, NodeJS.ErrnoException>
  /** Descriptors opened through the seam and not yet closed. */
  openFds: Set<number>
}

/**
 * A DurableWriteFs over the real `node:fs` that records every call. `'wx'`
 * opens are the temporary file and `'r'` opens the directory; fsync and close
 * are named by the descriptor's kind. An injected close failure closes the
 * real descriptor first, so no descriptor leaks from the test process.
 */
function makeRecordingFs(opts: RecordingFsOptions = {}): RecordingFs {
  const ops: Op[] = []
  const errors = new Map<Step, NodeJS.ErrnoException>()
  const openFds = new Set<number>()
  const kinds = new Map<number, 'temp' | 'dir'>()
  const fail = (step: Step): void => {
    if (!opts.failAt?.includes(step)) return
    if (opts.thrown !== undefined && step in opts.thrown) throw opts.thrown[step]
    const err = errnoError(opts.codes?.[step] ?? 'EIO', step)
    errors.set(step, err)
    throw err
  }
  const run = (op: Op): void => {
    ops.push(op)
    opts.before?.(op.step)
  }
  const kindOf = (fd: number): 'temp' | 'dir' => {
    const kind = kinds.get(fd)
    if (kind === undefined) throw new Error(`recording fs: unknown descriptor ${fd}`)
    return kind
  }

  const fs: DurableWriteFs = {
    openSync(path, flags) {
      const step: Step = flags === 'r' ? 'open-dir' : 'open-temp'
      run({ step, path, flags })
      fail(step)
      const fd = openSync(path, flags)
      kinds.set(fd, step === 'open-dir' ? 'dir' : 'temp')
      openFds.add(fd)
      return fd
    },
    writeSync(fd, buffer, offset, length) {
      const chunk = Math.min(length, opts.maxChunk ?? length)
      run({ step: 'write', fd, offset, length: chunk })
      fail('write')
      return writeSync(fd, buffer, offset, chunk)
    },
    fsyncSync(fd) {
      const step: Step = kindOf(fd) === 'dir' ? 'fsync-dir' : 'fsync-temp'
      run({ step, fd })
      fail(step)
      fsyncSync(fd)
    },
    closeSync(fd) {
      const step: Step = kindOf(fd) === 'dir' ? 'close-dir' : 'close-temp'
      run({ step, fd })
      closeSync(fd)
      openFds.delete(fd)
      fail(step)
    },
    renameSync(from, to) {
      run({ step: 'rename', path: from, to })
      fail('rename')
      renameSync(from, to)
    },
    unlinkSync(path) {
      run({ step: 'unlink', path })
      fail('unlink')
      unlinkSync(path)
    },
  }
  return { fs, ops, errors, openFds }
}

/** The temporary path the recorded write created. */
function tempPathOf(rec: RecordingFs): string {
  const open = rec.ops.find((op) => op.step === 'open-temp')
  if (open?.path === undefined) throw new Error('no temporary file was opened')
  return open.path
}

// ---------------------------------------------------------------------------
// Real file system
// ---------------------------------------------------------------------------

describe('durableWriteFileSync on the real file system', () => {
  test.each([
    ['JSON text with CRLF line ends', new TextEncoder().encode('{\r\n  "personas": []\r\n}\r\n')],
    ['bytes that are not valid UTF-8', new Uint8Array([0x7b, 0xff, 0x00, 0xc3, 0x28, 0xfe, 0x7d])],
    ['no bytes at all', new Uint8Array(0)],
  ])('a new file holds exactly the given bytes (%s) and no temporary sibling remains', (_label, bytes) => {
    const error = caught(() => durableWriteFileSync(target, bytes))

    expect(error).toBeUndefined()
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes)
    expect(entries()).toEqual(['config.json'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('overwriting a longer file replaces its bytes completely, with no trailing old bytes', () => {
    writeFileSync(target, OLD_BYTES)

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES))

    expect(error).toBeUndefined()
    expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
    expect(entries()).toEqual(['config.json'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('a failure the file system raises itself (parent path is a regular file) reaches the caller and changes nothing', () => {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, OLD_BYTES)

    const error = caught(() => durableWriteFileSync(join(blocker, 'config.json'), NEW_BYTES))

    expect((error as NodeJS.ErrnoException).code).toBe('ENOTDIR')
    expect(new Uint8Array(readFileSync(blocker))).toEqual(OLD_BYTES)
    expect(entries()).toEqual(['not-a-directory'])
    assertNoLeak({ error })
  })

  test('a missing parent directory reaches the caller as ENOENT and creates nothing', () => {
    const error = caught(() => durableWriteFileSync(join(dir, 'missing', 'config.json'), NEW_BYTES))

    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(entries()).toEqual([])
    assertNoLeak({ error })
  })
})

// ---------------------------------------------------------------------------
// Durable order (fs seam)
// ---------------------------------------------------------------------------

describe('durableWriteFileSync order through the fs seam', () => {
  test('writes and fsyncs the temporary file, closes it, renames it over the target, then fsyncs the directory', () => {
    const rec = makeRecordingFs()

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBeUndefined()
    const tmp = tempPathOf(rec)
    const tempFd = rec.ops.find((op) => op.step === 'write')?.fd
    const dirFd = rec.ops.find((op) => op.step === 'fsync-dir')?.fd
    expect(rec.ops).toEqual([
      { step: 'open-temp', path: tmp, flags: 'wx' },
      { step: 'write', fd: tempFd, offset: 0, length: NEW_BYTES.length },
      { step: 'fsync-temp', fd: tempFd },
      { step: 'close-temp', fd: tempFd },
      { step: 'rename', path: tmp, to: target },
      { step: 'open-dir', path: dir, flags: 'r' },
      { step: 'fsync-dir', fd: dirFd },
      { step: 'close-dir', fd: dirFd },
    ])
    expect(rec.openFds.size).toBe(0)
    expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
    expect(entries()).toEqual(['config.json'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('the target keeps its previous bytes until the rename: no partial file is ever visible there', () => {
    writeFileSync(target, OLD_BYTES)
    const seen: Array<[Step, Uint8Array]> = []
    const rec = makeRecordingFs({
      maxChunk: 4,
      before: (step) => seen.push([step, new Uint8Array(readFileSync(target))]),
    })

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBeUndefined()
    const renameAt = seen.findIndex(([step]) => step === 'rename')
    expect(renameAt).toBeGreaterThan(0)
    for (const [, bytes] of seen.slice(0, renameAt + 1)) expect(bytes).toEqual(OLD_BYTES)
    for (const [, bytes] of seen.slice(renameAt + 1)) expect(bytes).toEqual(NEW_BYTES)
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('short writes are continued until every byte is written, each from the next offset', () => {
    const bytes = new TextEncoder().encode('0123456789abc')
    const rec = makeRecordingFs({ maxChunk: 4 })

    const error = caught(() => durableWriteFileSync(target, bytes, rec.fs))

    expect(error).toBeUndefined()
    expect(rec.ops.filter((op) => op.step === 'write').map((op) => [op.offset, op.length])).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 1],
    ])
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes)
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('the temporary file sits beside the target, ends in .tmp, is none of the reload file names and is unique per write', () => {
    const first = makeRecordingFs()
    const second = makeRecordingFs()

    const errors = [
      caught(() => durableWriteFileSync(target, OLD_BYTES, first.fs)),
      caught(() => durableWriteFileSync(target, NEW_BYTES, second.fs)),
    ]

    expect(errors).toEqual([undefined, undefined])
    const temps = [tempPathOf(first), tempPathOf(second)]
    const paths = reloadFilePaths(target)
    for (const tmp of temps) {
      expect(dirname(tmp)).toBe(dir)
      expect(basename(tmp).startsWith('config.json.')).toBe(true)
      expect(tmp.endsWith('.tmp')).toBe(true)
      expect([paths.config, paths.pending, paths.apply, paths.lastApplied]).not.toContain(tmp)
    }
    expect(temps[0]).not.toBe(temps[1])
    expect(entries()).toEqual(['config.json'])
    assertNoLeak({ errors, written: writtenFile(dir) })
  })
})

// ---------------------------------------------------------------------------
// Failure at each step (fs seam)
// ---------------------------------------------------------------------------

/**
 * A directory error with no string errno code: not an Error (so the unsynced
 * error quotes it as a string) and with a numeric code (so its code is
 * undefined). The other no-code shapes of the shared errno-code read are
 * covered by the durableUnlinkSync "reaches the caller as raised" table.
 */
const DIRECTORY_ERROR_WITHOUT_CODE = { code: -5, toString: () => 'EIO: directory sync failed' }

describe('durableWriteFileSync failure at each step', () => {
  test.each<Step>(['open-temp', 'write', 'fsync-temp', 'close-temp', 'rename'])(
    'a %s failure before the rename reaches the caller, keeps the previous bytes, removes the temporary file and closes every descriptor',
    (step) => {
      writeFileSync(target, OLD_BYTES)
      const rec = makeRecordingFs({ failAt: [step] })

      const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

      expect(error).toBe(rec.errors.get(step))
      expect(new Uint8Array(readFileSync(target))).toEqual(OLD_BYTES)
      expect(entries()).toEqual(['config.json'])
      expect(rec.openFds.size).toBe(0)
      expect(rec.ops.map((op) => op.step)).not.toContain('open-dir')
      assertNoLeak({ error, written: writtenFile(dir) })
    },
  )

  test('a rename failure with no previous file leaves the target absent and no temporary file', () => {
    const rec = makeRecordingFs({ failAt: ['rename'] })

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBe(rec.errors.get('rename'))
    expect(entries()).toEqual([])
    assertNoLeak({ error })
  })

  test('when removing the temporary file also fails, the caller still gets the original error', () => {
    writeFileSync(target, OLD_BYTES)
    const rec = makeRecordingFs({ failAt: ['rename', 'unlink'] })

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBe(rec.errors.get('rename'))
    expect(rec.errors.has('unlink')).toBe(true)
    expect(new Uint8Array(readFileSync(target))).toEqual(OLD_BYTES)
    assertNoLeak({ error, written: writtenFile(target) })
  })

  test.each<Step>(['open-dir', 'fsync-dir'])(
    'a %s failure after the rename reaches the caller as DurableWriteUnsyncedError with the new bytes already in place and no temporary file',
    (step) => {
      writeFileSync(target, OLD_BYTES)
      const rec = makeRecordingFs({ failAt: [step] })

      const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

      const injected = rec.errors.get(step)
      expect(injected).toBeDefined()
      expect(error).toBeInstanceOf(DurableWriteUnsyncedError)
      const unsynced = error as DurableWriteUnsyncedError
      expect(unsynced.path).toBe(target)
      expect(unsynced.code).toBe('EIO')
      expect(unsynced.syncError).toBe(injected)
      expect(unsynced.message).toBe(
        `durableWriteFileSync: wrote "${target}" but could not sync its directory: ${injected!.message}`,
      )
      expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
      expect(entries()).toEqual(['config.json'])
      expect(rec.openFds.size).toBe(0)
      expect(rec.ops.map((op) => op.step)).not.toContain('unlink')
      assertNoLeak({ error, written: writtenFile(dir) })
    },
  )

  test('a fsync-dir failure with a non-Error whose code is a number is a DurableWriteUnsyncedError whose code is undefined, quoting it as a string', () => {
    writeFileSync(target, OLD_BYTES)
    const thrown = DIRECTORY_ERROR_WITHOUT_CODE
    const rec = makeRecordingFs({ failAt: ['fsync-dir'], thrown: { 'fsync-dir': thrown } })

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBeInstanceOf(DurableWriteUnsyncedError)
    const unsynced = error as DurableWriteUnsyncedError
    expect(unsynced.code).toBeUndefined()
    expect(unsynced.syncError).toBe(thrown)
    expect(unsynced.message).toBe(
      `durableWriteFileSync: wrote "${target}" but could not sync its directory: EIO: directory sync failed`,
    )
    expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
    expect(rec.openFds.size).toBe(0)
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('a directory close failure after a successful fsync is ignored: the write returns with the new bytes in place', () => {
    writeFileSync(target, OLD_BYTES)
    const rec = makeRecordingFs({ failAt: ['close-dir'] })

    const error = caught(() => durableWriteFileSync(target, NEW_BYTES, rec.fs))

    expect(error).toBeUndefined()
    expect(rec.errors.has('close-dir')).toBe(true)
    expect(rec.ops.map((op) => op.step).slice(-3)).toEqual(['open-dir', 'fsync-dir', 'close-dir'])
    expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
    expect(entries()).toEqual(['config.json'])
    expect(rec.openFds.size).toBe(0)
    assertNoLeak({ error, written: writtenFile(dir) })
  })
})

// ---------------------------------------------------------------------------
// Durable delete (b.av2 SR-8.1, SR-8.3)
// ---------------------------------------------------------------------------

describe('durableUnlinkSync', () => {
  const PENDING_TEXT = 'pending preview\n'

  /** `config.json.pending` beside `config.json` and `config.json.last-applied`; returns the pending path. */
  function seedReloadFiles(): string {
    const paths = reloadFilePaths(target)
    writeFileSync(paths.config, NEW_BYTES)
    writeFileSync(paths.lastApplied, OLD_BYTES)
    writeFileSync(paths.pending, PENDING_TEXT)
    return paths.pending
  }

  /** The siblings of the pending file are exactly as seeded. */
  function expectSiblingsIntact(): void {
    expect(new Uint8Array(readFileSync(target))).toEqual(NEW_BYTES)
    expect(new Uint8Array(readFileSync(reloadFilePaths(target).lastApplied))).toEqual(OLD_BYTES)
  }

  /** Run the delete; its return value, or the error it threw. */
  function unlink(path: string, fs?: DurableWriteFs): { removed?: boolean; error: unknown } {
    let removed: boolean | undefined
    const error = caught(() => {
      removed = durableUnlinkSync(path, fs)
    })
    return { removed, error }
  }

  test('on the real file system: removes the file, returns true and leaves the other files in the directory intact', () => {
    const pending = seedReloadFiles()

    const { removed, error } = unlink(pending)

    expect(error).toBeUndefined()
    expect(removed).toBe(true)
    expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
    expectSiblingsIntact()
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('unlinks the file, then opens, fsyncs and closes its directory, leaving no descriptor open', () => {
    const pending = seedReloadFiles()
    const rec = makeRecordingFs()

    const { removed, error } = unlink(pending, rec.fs)

    expect(error).toBeUndefined()
    expect(removed).toBe(true)
    const dirFd = rec.ops.find((op) => op.step === 'fsync-dir')?.fd
    expect(rec.ops).toEqual([
      { step: 'unlink', path: pending },
      { step: 'open-dir', path: dir, flags: 'r' },
      { step: 'fsync-dir', fd: dirFd },
      { step: 'close-dir', fd: dirFd },
    ])
    expect(rec.openFds.size).toBe(0)
    expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  // The file system raises each code itself: nothing is injected.
  test.each<[string, string, () => string]>([
    ['a file that is already gone', 'ENOENT', () => reloadFilePaths(target).pending],
    ['a missing parent directory', 'ENOENT', () => join(dir, 'missing', 'config.json.pending')],
    ['a parent path that is a regular file', 'ENOTDIR', () => join(dir, 'config.json', 'config.json.pending')],
  ])('%s (%s) is success: returns false, syncs no directory and changes nothing', (_label, _code, pathOf) => {
    writeFileSync(target, NEW_BYTES)
    writeFileSync(reloadFilePaths(target).lastApplied, OLD_BYTES)
    const rec = makeRecordingFs()

    const { removed, error } = unlink(pathOf(), rec.fs)

    expect(error).toBeUndefined()
    expect(removed).toBe(false)
    expect(rec.ops.map((op) => op.step)).toEqual(['unlink'])
    expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
    expectSiblingsIntact()
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  // Every code but ENOENT and ENOTDIR takes the one rethrow branch; two stand for them all.
  test.each(['EIO', 'EACCES'])(
    'an injected %s unlink failure reaches the caller as raised, keeps the file and syncs no directory',
    (code) => {
      const pending = seedReloadFiles()
      const rec = makeRecordingFs({ failAt: ['unlink'], codes: { unlink: code } })

      const { removed, error } = unlink(pending, rec.fs)

      expect(error).toBe(rec.errors.get('unlink'))
      expect(removed).toBeUndefined()
      expect(rec.ops.map((op) => op.step)).toEqual(['unlink'])
      expect(readFileSync(pending, 'utf-8')).toBe(PENDING_TEXT)
      expectSiblingsIntact()
      assertNoLeak({ error, written: writtenFile(dir) })
    },
  )

  test('a directory at the path (the file system raises EISDIR itself) reaches the caller and the directory stays', () => {
    const pending = reloadFilePaths(target).pending
    mkdirSync(pending)
    writeFileSync(join(pending, 'inside'), PENDING_TEXT)

    const { removed, error } = unlink(pending)

    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
    expect(removed).toBeUndefined()
    expect(readFileSync(join(pending, 'inside'), 'utf-8')).toBe(PENDING_TEXT)
    assertNoLeak({ error })
  })

  // Only the errno code decides "already absent": a message naming ENOENT,
  // or a code that is not a string, is some other failure.
  test.each<[string, unknown]>([
    ['an Error with no code whose message names ENOENT', new Error('ENOENT: no such file or directory')],
    ['an Error whose code is a number', Object.assign(new Error('unlink failed'), { code: -2 })],
    ['a thrown string', 'ENOENT'],
  ])('%s reaches the caller as raised', (_label, thrown) => {
    const pending = seedReloadFiles()
    const rec = makeRecordingFs()
    const fs: DurableWriteFs = {
      ...rec.fs,
      unlinkSync: () => {
        throw thrown
      },
    }

    const { removed, error } = unlink(pending, fs)

    expect(error).toBe(thrown)
    expect(removed).toBeUndefined()
    expect(rec.ops).toEqual([])
    expect(readFileSync(pending, 'utf-8')).toBe(PENDING_TEXT)
    assertNoLeak({ error })
  })

  // Rows: the failing step, its errno code (ENOENT after the unlink is not "already absent"), the steps run.
  test.each<[Step, string, Step[]]>([
    ['open-dir', 'EIO', ['unlink', 'open-dir']],
    ['fsync-dir', 'ENOENT', ['unlink', 'open-dir', 'fsync-dir', 'close-dir']],
  ])(
    'an injected %s failure (%s) after the unlink is thrown as DurableUnlinkUnsyncedError keeping its code, with the file already gone, every descriptor closed and no retry',
    (step, code, steps) => {
      const pending = seedReloadFiles()
      const rec = makeRecordingFs({ failAt: [step], codes: { [step]: code } })

      const { removed, error } = unlink(pending, rec.fs)

      const injected = rec.errors.get(step)
      expect(injected).toBeDefined()
      expect(error).toBeInstanceOf(DurableUnlinkUnsyncedError)
      expect(error).toBeInstanceOf(Error)
      const unsynced = error as DurableUnlinkUnsyncedError
      expect(unsynced.name).toBe('DurableUnlinkUnsyncedError')
      expect(unsynced.path).toBe(pending)
      expect(unsynced.code).toBe(code)
      expect(unsynced.syncError).toBe(injected)
      expect(unsynced.message).toBe(
        `durableUnlinkSync: removed "${pending}" but could not sync its directory: ${injected!.message}`,
      )
      expect(removed).toBeUndefined()
      expect(rec.ops.map((op) => op.step)).toEqual(steps)
      expect(rec.ops[0]).toEqual({ step: 'unlink', path: pending })
      expect(rec.openFds.size).toBe(0)
      expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
      expectSiblingsIntact()
      assertNoLeak({ error, written: writtenFile(dir) })
    },
  )

  test('a fsync-dir failure with a non-Error whose code is a number, after the unlink, is a DurableUnlinkUnsyncedError whose code is undefined, quoting it as a string', () => {
    const pending = seedReloadFiles()
    const thrown = DIRECTORY_ERROR_WITHOUT_CODE
    const rec = makeRecordingFs({ failAt: ['fsync-dir'], thrown: { 'fsync-dir': thrown } })

    const { removed, error } = unlink(pending, rec.fs)

    expect(error).toBeInstanceOf(DurableUnlinkUnsyncedError)
    const unsynced = error as DurableUnlinkUnsyncedError
    expect(unsynced.name).toBe('DurableUnlinkUnsyncedError')
    expect(unsynced.path).toBe(pending)
    expect(unsynced.code).toBeUndefined()
    expect(unsynced.syncError).toBe(thrown)
    expect(unsynced.message).toBe(
      `durableUnlinkSync: removed "${pending}" but could not sync its directory: EIO: directory sync failed`,
    )
    expect(removed).toBeUndefined()
    expect(rec.ops.filter((op) => op.step === 'unlink')).toHaveLength(1)
    expect(rec.openFds.size).toBe(0)
    expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })

  test('a directory close failure after a successful fsync is ignored: returns true with the file gone', () => {
    const pending = seedReloadFiles()
    const rec = makeRecordingFs({ failAt: ['close-dir'] })

    const { removed, error } = unlink(pending, rec.fs)

    expect(error).toBeUndefined()
    expect(removed).toBe(true)
    expect(rec.errors.has('close-dir')).toBe(true)
    expect(rec.ops.map((op) => op.step)).toEqual(['unlink', 'open-dir', 'fsync-dir', 'close-dir'])
    expect(rec.openFds.size).toBe(0)
    expect(entries()).toEqual(['config.json', 'config.json.last-applied'])
    assertNoLeak({ error, written: writtenFile(dir) })
  })
})

// ---------------------------------------------------------------------------
// Reload file paths
// ---------------------------------------------------------------------------

describe('reloadFilePaths', () => {
  test('returns config.json.pending, config.json.apply and config.json.last-applied beside <dir>/config.json', () => {
    const paths = reloadFilePaths(target)

    expect(paths).toEqual({
      config: join(dir, 'config.json'),
      pending: join(dir, 'config.json.pending'),
      apply: join(dir, 'config.json.apply'),
      lastApplied: join(dir, 'config.json.last-applied'),
    })
    expect(entries()).toEqual([])
    assertNoLeak({ paths })
  })
})
