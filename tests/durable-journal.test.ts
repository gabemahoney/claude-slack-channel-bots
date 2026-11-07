import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDurableJournal, removeTornTail, setDurableAppendTimer, splitJournalLines, yieldToEventLoop,
  type AppendRollback, type DurableAppendTiming,
} from '../src/durable-journal.ts'
import { durableIo, heldStep, type DurableStepForm } from './test-helpers/durable-io.ts'

let root: string, dir: string, path: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'durable-journal-'))
  dir = join(root, 'journals')
  path = join(dir, 'alpha.jsonl')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

type Op = { step: string; path: string; flags?: fs.OpenMode; mode?: fs.Mode; length?: number; form?: DurableStepForm }
/** Real scratch files, with faults before the chosen operation (close faults close first).
 * `sync` and `rename` are recorded in whichever form, callback or blocking, the journal used. */
function recordingFs() {
  const ops: Op[] = [], paths = new Map<number, string>()
  const errors = new Map<string, Error>()
  const control = {
    maxChunk: Infinity,
    stat: undefined as fs.Stats | undefined,
    fail: (_op: Op): boolean => false,
    before: (_op: Op): void => {},
    /** A callback `sync` or `rename` waits for the returned promise. */
    hold: (_op: Op): Promise<void> | undefined => undefined,
  }
  function record(op: Op) {
    ops.push(op)
    control.before(op)
    if (control.fail(op)) {
      const error = Object.assign(new Error(`EIO injected ${op.step}`), { code: 'EIO' })
      errors.set(op.step, error)
      throw error
    }
  }
  const fdPath = (fd: number) => paths.get(fd)!
  const base = { ...fs,
    mkdirSync(p: fs.PathLike, options: fs.MakeDirectoryOptions) { record({ step: 'mkdir', path: String(p), mode: options.mode }); return fs.mkdirSync(p, options) },
    statSync(p: fs.PathLike) { record({ step: 'stat', path: String(p) }); return control.stat ?? fs.statSync(p) },
    chmodSync(p: fs.PathLike, mode: fs.Mode) { record({ step: 'chmod', path: String(p), mode }); fs.chmodSync(p, mode) },
    openSync(p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
      record({ step: 'open', path: String(p), flags, mode })
      const fd = fs.openSync(p, flags, mode); paths.set(fd, String(p)); return fd
    },
    closeSync(fd: number) {
      const p = fdPath(fd); fs.closeSync(fd); paths.delete(fd)
      record({ step: 'close', path: p })
    },
    writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
      record({ step: 'write', path: fdPath(fd), length })
      if (control.maxChunk <= 0) return control.maxChunk
      return fs.writeSync(fd, bytes, offset, Math.min(length, control.maxChunk))
    },
    fchmodSync(fd: number, mode: fs.Mode) { record({ step: 'fchmod', path: fdPath(fd), mode }); fs.fchmodSync(fd, mode) },
    ftruncateSync(fd: number, length = 0) { record({ step: 'truncate', path: fdPath(fd), length }); fs.ftruncateSync(fd, length) },
    unlinkSync(p: fs.PathLike) { record({ step: 'unlink', path: String(p) }); fs.unlinkSync(p) },
  } as typeof fs
  const io = durableIo({ base, before(step) {
    const op: Op = { step: step.op === 'fsync' ? 'sync' : 'rename', path: step.path, form: step.form }
    record(op)
    return control.hold(op)
  } })
  return { fs: io.fs, io, ops, paths, errors, control }
}
function journal(seam: typeof fs = fs, directoryMode = 0o700, fileMode = 0o600) {
  return createDurableJournal({ dir, parentDir: root, directoryMode, fileMode, fs: seam })
}
function seed(bytes: string | Buffer) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, bytes)
}
const read = () => fs.readFileSync(path)
const durableSteps = (ops: Op[]) => ops.filter(op => op.step === 'sync' || op.step === 'rename')

describe('directory durability and modes', () => {
  test.each(['async', 'sync'] as const)('%s appends set mode once per journal file, reopen and replacement', async form => {
    const r = recordingFs()
    let j = journal(r.fs)
    const append = () => form === 'async' ? j.durableAppend(path, Buffer.from('saved\n')) : j.durableAppendSync(path, Buffer.from('saved\n'))
    const modes = () => r.ops.filter(op => op.step === 'fchmod').length
    for (let n = 0; n < 8; n++) await append()
    expect(modes()).toBe(1)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
    j = journal(r.fs)
    await append(); await append()
    expect(modes()).toBe(2)
    fs.renameSync(path, join(dir, 'old.jsonl'))
    await append(); await append()
    expect(modes()).toBe(3)
    fs.chmodSync(path, 0o666)
    await append(); await append()
    expect(modes()).toBe(4)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
    expect(read()).toEqual(Buffer.from('saved\n'.repeat(4)))
    expect(r.paths.size).toBe(0)
  })

  test('a failed mode repair is retried before any append, then rollback and retries reuse the repaired mode', async () => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    seed('old\n'); fs.chmodSync(path, 0o666)
    r.control.fail = op => op.step === 'fchmod'
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow('EIO injected fchmod')
    expect(read()).toEqual(Buffer.from('old\n'))
    expect(r.ops.filter(op => op.step === 'write')).toEqual([])
    r.control.fail = op => op.path === path && (op.step === 'sync' || op.step === 'truncate')
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow()
    expect(rollback.pendingRollback).toBe(4)
    r.control.fail = () => false
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
    expect(r.ops.filter(op => op.step === 'fchmod')).toHaveLength(2)
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.paths.size).toBe(0)
  })

  test('rewrite and directory recreation get their own mode check before subsequent appends', async () => {
    const r = recordingFs(), j = journal(r.fs, 0o750, 0o640)
    await j.durableAppend(path, Buffer.from('old\n'))
    await j.rewrite(path, Buffer.from('rewritten\n'))
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('next\n')); await j.durableAppend(path, Buffer.from('last\n'))
    expect(r.ops.filter(op => op.step === 'fchmod')).toHaveLength(1)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o640)
    expect(read()).toEqual(Buffer.from('rewritten\nnext\nlast\n'))
    fs.renameSync(dir, join(root, 'previous'))
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('new\n')); await j.durableAppend(path, Buffer.from('last\n'))
    expect(r.ops.filter(op => op.step === 'fchmod')).toHaveLength(1)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o640)
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o750)
    expect(read()).toEqual(Buffer.from('new\nlast\n'))
    expect(r.paths.size).toBe(0)
  })

  test('construction does no filesystem work', () => {
    const r = recordingFs()
    journal(r.fs)
    expect(r.ops).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
  })

  test.each([[0o700, 0o600], [0o750, 0o640]])('honours directory %s and file %s modes, including existing permissive files', async (directoryMode, fileMode) => {
    const r = recordingFs(), j = journal(r.fs, directoryMode, fileMode)
    await j.durableAppend(path, Buffer.from('first\n'))
    expect(r.ops.find(op => op.step === 'mkdir')?.mode).toBe(directoryMode)
    expect(r.ops.find(op => op.step === 'open' && op.path === path)?.mode).toBe(fileMode)
    fs.chmodSync(dir, 0o777); fs.chmodSync(path, 0o666)
    await j.durableAppend(path, Buffer.from('second\n'))
    expect(fs.statSync(dir).mode & 0o7777).toBe(directoryMode)
    expect(fs.statSync(path).mode & 0o7777).toBe(fileMode)
    expect(read()).toEqual(Buffer.from('first\nsecond\n'))
    await j.rewrite(path, Buffer.from('rewritten\n'))
    expect(fs.statSync(path).mode & 0o7777).toBe(fileMode)
    expect(read()).toEqual(Buffer.from('rewritten\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['mkdir', 'stat', 'chmod', 'open', 'sync'] as const)('a failed ensure at %s stays retryable before append', async step => {
    const r = recordingFs(), j = journal(r.fs)
    r.control.fail = op => op.step === step
    await expect(j.durableAppend(path, Buffer.from('new\n'))).rejects.toThrow(`EIO injected ${step}`)
    expect(fs.existsSync(path)).toBe(false)
    r.control.fail = () => false; r.ops.length = 0
    await j.durableAppend(path, Buffer.from('new\n'))
    expect(read()).toEqual(Buffer.from('new\n'))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root, path, dir])
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700)
    expect(r.paths.size).toBe(0)
  })

  test.each(['replacement', 'recreation with reused identity', 'changed mode'] as const)('revalidates directory durability after %s', async change => {
    const r = recordingFs()
    const j = journal(r.fs)
    await j.ensureDir()
    const identity = fs.statSync(dir)
    r.ops.length = 0
    await j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync')).toEqual([])
    if (change === 'changed mode') fs.chmodSync(dir, 0o755)
    else {
      fs.renameSync(dir, join(root, 'old-journals'))
      if (change === 'replacement') fs.mkdirSync(dir, { mode: 0o700 })
      // Model inode reuse even on filesystems that do not reuse it in this run.
      else r.control.stat = identity
    }
    r.control.fail = op => op.step === 'sync' && op.path === root
    await expect(j.ensureDir()).rejects.toThrow('EIO injected sync')
    r.control.fail = () => false; r.ops.length = 0
    await j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root])
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700)
    expect(r.paths.size).toBe(0)
  })

  test('an ensure still waiting on its parent sync when the directory is recreated never vouches for the recreation', async () => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep()
    r.control.hold = op => op.step === 'sync' && op.path === root ? gate.promise : undefined
    const older = j.ensureDir()
    await yieldToEventLoop()
    expect(r.io.held()).toBe(1)
    const identity = fs.statSync(dir)
    fs.rmdirSync(dir)
    // The recreation reuses the old identity; its own parent sync fails.
    r.control.hold = () => undefined; r.control.stat = identity
    r.control.fail = op => op.step === 'sync' && op.path === root
    await expect(j.ensureDir()).rejects.toThrow('EIO injected sync')
    r.control.fail = () => false
    gate.release(); await older
    r.ops.length = 0
    await j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root])
  })
})

describe('append and rollback', () => {
  test.each(['', 'old\n', 'old'])('short writes append exact bytes after %j, with file then directory sync', async old => {
    const r = recordingFs(), j = journal(r.fs), bytes = Buffer.from('new é🙂\n')
    seed(old); r.control.maxChunk = 2
    await j.durableAppend(path, bytes)
    expect(read()).toEqual(Buffer.concat([Buffer.from(old + (old && !old.endsWith('\n') ? '\n' : '')), bytes]))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root, path, dir])
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('next\n'))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([path, dir])
    expect(read().subarray(-5)).toEqual(Buffer.from('next\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['partial write', 'file sync', 'directory sync', 'zero write', 'negative write'] as const)('%s failure restores the original bytes and permits one clean retry', async failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    const old = Buffer.from('old without newline')
    seed(old); await j.ensureDir(); r.control.maxChunk = 2
    let failed = false
    r.control.fail = op => {
      const match = failure === 'partial write' ? op.step === 'write' && read().length > old.length + 1
        : op.step === 'sync' && op.path === (failure === 'file sync' ? path : failure === 'directory sync' ? dir : '')
      if (!failed && match) { failed = true; return true }
      return false
    }
    if (failure === 'zero write' || failure === 'negative write') r.control.maxChunk = failure === 'zero write' ? 0 : -1
    await expect(j.durableAppend(path, Buffer.from('failed\n'), rollback)).rejects.toThrow()
    expect(read()).toEqual(old)
    expect(rollback.pendingRollback).toBeUndefined()
    r.control.fail = () => false; r.control.maxChunk = 2
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old without newline\nretry\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['truncate', 'sync'] as const)('keeps the original rollback through repeated %s failures, then reconciles without append', async failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}, old = Buffer.from('old\n')
    seed(old); await j.ensureDir()
    r.control.fail = op => (op.step === 'sync' || op.step === 'truncate') && op.path === path
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow()
    expect(read()).toEqual(Buffer.from('old\nunaccepted\n'))
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = op => op.path === path && op.step === failure
    await expect(j.durableAppend(path, Buffer.from('also unaccepted\n'), rollback)).rejects.toThrow()
    expect(rollback.pendingRollback).toBe(old.length)
    await expect(j.reconcileRollback(path, rollback)).rejects.toThrow()
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = () => false; r.ops.length = 0
    await j.reconcileRollback(path, rollback)
    expect(read()).toEqual(old)
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([path])
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(r.paths.size).toBe(0)
  })

  test('the next append reconciles a failed rollback before any new byte is written', async () => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    seed('old\n'); await j.ensureDir()
    r.control.fail = op => op.path === path && ['sync', 'truncate'].includes(op.step)
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow()
    r.control.fail = () => false; r.ops.length = 0
    r.control.before = op => { if (op.step === 'write') expect(read()).toEqual(Buffer.from('old\n')) }
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.ops.filter(op => ['truncate', 'write', 'sync'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([['truncate', path], ['sync', path], ['write', path], ['sync', path], ['sync', dir]])
  })

  test('reconciling with nothing pending performs no I/O', async () => {
    const r = recordingFs()
    await journal(r.fs).reconcileRollback(path, {})
    expect(r.ops).toEqual([])
  })
})

describe('Thread Memory torn-tail removal', () => {
  test.each(['append', 'reconcile'] as const)('%s removes a quarantined partial multibyte character and retries failed truncation', async operation => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    const old = Buffer.from('saved é\n'), fragment = Buffer.from([0x7b, 0x22, 0xe2, 0x82])
    seed(Buffer.concat([old, fragment])); await j.ensureDir()
    const tail = splitJournalLines(read()).at(-1)!
    const quarantine = join(dir, 'alpha.unreadable')
    fs.writeFileSync(quarantine, tail.bytes, { mode: 0o600 })
    removeTornTail(rollback, tail)
    expect(read()).toEqual(Buffer.concat([old, fragment]))
    expect(rollback.pendingRollback).toBe(old.length)
    const act = () => operation === 'append' ? j.durableAppend(path, Buffer.from('new\n'), rollback) : j.reconcileRollback(path, rollback)
    r.control.fail = op => op.step === 'truncate'
    await expect(act()).rejects.toThrow('EIO injected truncate')
    expect(read()).toEqual(Buffer.concat([old, fragment]))
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = () => false
    await act()
    expect(read()).toEqual(Buffer.concat([old, Buffer.from(operation === 'append' ? 'new\n' : '')]))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(fs.readFileSync(quarantine)).toEqual(fragment)
    expect(r.paths.size).toBe(0)
  })

  test('whole invalid lines do not schedule removal; torn lines keep the earliest pending boundary, including zero', () => {
    const rollback: AppendRollback = {}, lines = splitJournalLines(Buffer.from([0xff, 10, 0xe2, 0x82]))
    removeTornTail(rollback, lines[0]!)
    expect(rollback).toEqual({})
    removeTornTail(rollback, lines[1]!)
    expect(rollback.pendingRollback).toBe(2)
    rollback.pendingRollback = 1
    removeTornTail(rollback, lines[1]!)
    expect(rollback.pendingRollback).toBe(1)
    removeTornTail(rollback, splitJournalLines(Buffer.from([0xff]))[0]!)
    expect(rollback.pendingRollback).toBe(0)
  })
})

describe('whole-file rewrite', () => {
  test('uses unique exclusive mode-0600 temps, short writes and fsync before rename, then directory fsync', async () => {
    const r = recordingFs(), j = journal(r.fs), old = Buffer.from('old longer record\n'), next = Buffer.from('é🙂\n')
    seed(old); await j.ensureDir(); r.ops.length = 0; r.control.maxChunk = 2
    r.control.before = op => { if (op.step === 'rename') expect(read()).toEqual(old) }
    await j.rewrite(path, next)
    expect(read()).toEqual(next)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
    const first = r.ops.find(op => op.step === 'open' && op.flags === 'wx')!
    expect(first.path.startsWith(`${path}.`)).toBe(true)
    expect(first.path.endsWith('.tmp')).toBe(true)
    expect(first.mode).toBe(0o600)
    expect(r.ops.filter(op => ['sync', 'rename'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([['sync', first.path], ['rename', first.path], ['sync', dir]])
    r.control.before = () => {}; r.ops.length = 0
    await j.rewrite(path, Buffer.from('again\n'))
    expect(r.ops.find(op => op.step === 'open' && op.flags === 'wx')!.path).not.toBe(first.path)
    expect(read()).toEqual(Buffer.from('again\n'))
    expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    expect(r.paths.size).toBe(0)
  })

  test.each(['open-temp', 'partial-write', 'sync-temp', 'close-temp', 'rename', 'open-directory', 'sync-directory', 'close-directory'] as const)(
    '%s failure cleans the temp; only post-rename failures leave replacement bytes visible', async failure => {
      const r = recordingFs(), j = journal(r.fs), old = Buffer.from('old longer record\n'), next = Buffer.from('new\n')
      seed(old); await j.ensureDir(); r.control.maxChunk = 2
      r.control.fail = op => {
        const temp = op.path.endsWith('.tmp')
        if (failure === 'partial-write') return op.step === 'write' && fs.statSync(op.path).size > 0
        if (failure === 'rename') return op.step === 'rename'
        const [step, target] = failure.split('-')
        return op.step === step && (target === 'temp' ? temp : op.path === dir)
      }
      await expect(j.rewrite(path, next)).rejects.toThrow('EIO injected')
      expect(read()).toEqual(failure.endsWith('-directory') ? next : old)
      expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
      expect(r.paths.size).toBe(0)
      r.control.fail = () => false
      await j.rewrite(path, next)
      expect(read()).toEqual(next)
      expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    },
  )
})

describe('disk waits run on the I/O pool; only read-time quarantine blocks', () => {
  /** Event-loop turns (immediates) that run while `work` is outstanding. */
  async function turnsDuring(work: () => Promise<void> | void): Promise<number> {
    let turns = 0, done = false
    const tick = () => { if (done) return; turns++; setImmediate(tick) }
    setImmediate(tick)
    try { await work() } finally { done = true }
    return turns
  }

  test('every promise operation waits only through callback fsync and rename; the blocking append runs the same steps through the Sync forms', async () => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    seed('old\n')
    r.control.fail = op => op.path === path && (op.step === 'sync' || op.step === 'truncate')
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow()
    expect(rollback.pendingRollback).toBe('old\n'.length)
    r.control.fail = () => false
    await j.reconcileRollback(path, rollback)
    expect(read()).toEqual(Buffer.from('old\n'))
    await j.durableAppend(path, Buffer.from('second\n'))
    await j.rewrite(path, Buffer.from('rewritten\n'))
    await j.ensureDir()
    expect(durableSteps(r.ops).length).toBeGreaterThan(0)
    expect(durableSteps(r.ops).filter(op => op.form !== 'callback')).toEqual([])
    // A fresh journal: the blocking form's steps, path for path, match the callback form's.
    const asyncRun = recordingFs()
    fs.rmSync(dir, { recursive: true }); seed('old')
    await journal(asyncRun.fs).durableAppend(path, Buffer.from('quarantined\n'))
    const asyncBytes = read()
    const syncRun = recordingFs()
    fs.rmSync(dir, { recursive: true }); seed('old')
    journal(syncRun.fs).durableAppendSync(path, Buffer.from('quarantined\n'))
    expect(read()).toEqual(asyncBytes)
    expect(durableSteps(syncRun.ops).map(op => op.form)).toEqual(durableSteps(asyncRun.ops).map(() => 'sync'))
    expect(durableSteps(syncRun.ops).map(op => [op.step, op.path])).toEqual(durableSteps(asyncRun.ops).map(op => [op.step, op.path]))
    expect(syncRun.ops.map(op => op.step)).toEqual(asyncRun.ops.map(op => op.step))
  })

  test.each(['file sync', 'directory sync', 'truncate'] as const)('a blocking append whose %s fails throws before returning, with the same rollback the callback form keeps', failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}, old = Buffer.from('old\n')
    seed(old); j.durableAppendSync(path, Buffer.from('first\n'), rollback)
    let failed = false
    r.control.fail = op => {
      if (failure === 'truncate') return op.path === path && (op.step === 'sync' || op.step === 'truncate')
      if (failed || op.step !== 'sync' || op.path !== (failure === 'file sync' ? path : dir)) return false
      failed = true; return true
    }
    let failedWith: unknown
    try { j.durableAppendSync(path, Buffer.from('unaccepted\n'), rollback) } catch (error) { failedWith = error }
    expect(failedWith).toBeInstanceOf(Error)
    expect(r.io.busy()).toBe(false)
    if (failure === 'truncate') {
      expect(rollback.pendingRollback).toBe(old.length + 'first\n'.length)
      r.control.fail = () => false
      j.durableAppendSync(path, Buffer.from('retry\n'), rollback)
    } else {
      expect(read()).toEqual(Buffer.from('old\nfirst\n'))
      expect(rollback.pendingRollback).toBeUndefined()
      r.control.fail = () => false
      j.durableAppendSync(path, Buffer.from('retry\n'), rollback)
    }
    expect(read()).toEqual(Buffer.from('old\nfirst\nretry\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(durableSteps(r.ops).filter(op => op.form !== 'sync')).toEqual([])
    expect(r.paths.size).toBe(0)
  })

  test('with the default node:fs backend, the event loop runs while append, rollback repair, rewrite and a new directory wait for the disk; the blocking append gives it no turn', async () => {
    const j = createDurableJournal({ dir, parentDir: root, directoryMode: 0o700, fileMode: 0o600 }), rollback: AppendRollback = {}
    expect(await turnsDuring(() => j.durableAppend(path, Buffer.from('first\n')))).toBeGreaterThan(0)
    expect(await turnsDuring(() => j.durableAppend(path, Buffer.from('second\n'), rollback))).toBeGreaterThan(0)
    expect(await turnsDuring(() => j.rewrite(path, Buffer.from('rewritten\n')))).toBeGreaterThan(0)
    fs.appendFileSync(path, 'unaccepted\n'); rollback.pendingRollback = 'rewritten\n'.length
    expect(await turnsDuring(() => j.reconcileRollback(path, rollback))).toBeGreaterThan(0)
    expect(read()).toEqual(Buffer.from('rewritten\n'))
    expect(await turnsDuring(() => j.durableAppendSync(path, Buffer.from('quarantined\n')))).toBe(0)
    expect(read()).toEqual(Buffer.from('rewritten\nquarantined\n'))
  })

  test('while a file sync is held, timers fire and another journal path appends; the held append resolves only after its directory sync', async () => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep(), other = join(dir, 'beta.jsonl')
    await j.ensureDir()
    r.control.hold = op => op.step === 'sync' && op.path === path ? gate.promise : undefined
    let settled = false
    const held = j.durableAppend(path, Buffer.from('held\n')).then(() => { settled = true })
    const fired = await new Promise<boolean>(resolve => setTimeout(() => resolve(true), 0))
    expect(fired).toBe(true)
    expect(r.io.held()).toBe(1)
    await j.durableAppend(other, Buffer.from('beta\n'))
    expect(fs.readFileSync(other)).toEqual(Buffer.from('beta\n'))
    expect(settled).toBe(false)
    expect(r.ops.filter(op => op.step === 'sync' && op.path === dir)).toHaveLength(1)
    r.ops.length = 0
    gate.release(); await held
    expect(settled).toBe(true)
    // The held step was recorded when it began; its directory sync ran only after release.
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([dir])
    expect(read()).toEqual(Buffer.from('held\n'))
  })

  test('a held file sync that fails rolls back the append before it rejects', async () => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep(), rollback: AppendRollback = {}
    seed('old\n'); await j.ensureDir()
    r.control.hold = op => op.step === 'sync' && op.path === path && op.form === 'callback' && !r.ops.some(o => o.step === 'truncate') ? gate.promise : undefined
    const held = j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)
    await yieldToEventLoop()
    expect(read()).toEqual(Buffer.from('old\nunaccepted\n'))
    gate.fail(Object.assign(new Error('EIO held sync'), { code: 'EIO' }))
    await expect(held).rejects.toThrow('EIO held sync')
    expect(read()).toEqual(Buffer.from('old\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.paths.size).toBe(0)
  })
})

describe('test-only append timing', () => {
  afterEach(() => setDurableAppendTimer(undefined))
  /** A clock that each sync advances by its path's cost, so file and directory times are distinct. */
  function timedRun() {
    const r = recordingFs(), timings: DurableAppendTiming[] = []
    let t = 1000, reads = 0
    const cost = (p: string) => p === path ? 5 : p === dir ? 2 : p === root ? 1 : 0
    r.control.before = op => { if (op.step === 'sync') t += cost(op.path) }
    return { r, timings, reads: () => reads, timer: { now: () => { reads++; return t }, record: (timing: DurableAppendTiming) => { timings.push(timing) } } }
  }

  test('unset by default: an append reads no clock and runs the same steps as a timed one', async () => {
    const plain = recordingFs()
    await journal(plain.fs).durableAppend(path, Buffer.from('a\nb\n'))
    fs.rmSync(dir, { recursive: true })
    const timed = timedRun()
    setDurableAppendTimer(timed.timer)
    await journal(timed.r.fs).durableAppend(path, Buffer.from('a\nb\n'))
    expect(timed.r.ops.map(op => [op.step, op.path])).toEqual(plain.ops.map(op => [op.step, op.path]))
    expect(read()).toEqual(Buffer.from('a\nb\n'))
    setDurableAppendTimer(undefined)
    const before = timed.reads()
    await journal(timed.r.fs).durableAppend(path, Buffer.from('c\n'))
    expect(timed.reads()).toBe(before)
    expect(timed.timings).toHaveLength(1)
  })

  test('each successful append reports its records, bytes, whole time and file/directory fsync split, first with the parent sync', async () => {
    const h = timedRun(), j = journal(h.r.fs)
    setDurableAppendTimer(h.timer)
    const group = Buffer.from('{"seq":1}\n{"seq":2}\n{"seq":3}\n')
    await j.durableAppend(path, group)
    await j.durableAppend(path, Buffer.from('{"seq":4}\n'))
    expect(h.timings).toEqual([
      { dir, path, records: 3, bytes: group.length, appendMs: 8, fileFsyncMs: 5, dirFsyncMs: 3, fsyncs: 3, atMonoMs: 1008 },
      { dir, path, records: 1, bytes: 10, appendMs: 7, fileFsyncMs: 5, dirFsyncMs: 2, fsyncs: 2, atMonoMs: 1015 },
    ])
    expect(JSON.stringify(h.timings)).not.toContain('seq')
  })

  test('a failed append reports nothing, its rollback sync is a file sync of the next append, and a throwing timer cannot fail an append', async () => {
    const h = timedRun(), j = journal(h.r.fs), rollback: AppendRollback = {}
    seed('old\n'); await j.ensureDir()
    setDurableAppendTimer(h.timer)
    h.r.control.fail = op => op.path === path && (op.step === 'sync' || op.step === 'truncate')
    await expect(j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).rejects.toThrow()
    expect(h.timings).toEqual([])
    h.r.control.fail = () => false
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(h.timings).toEqual([{ dir, path, records: 1, bytes: 6, appendMs: 12, fileFsyncMs: 10, dirFsyncMs: 2, fsyncs: 3, atMonoMs: h.timings[0]!.atMonoMs }])
    setDurableAppendTimer({ now: h.timer.now, record: () => { throw new Error('observer failed') } })
    await j.durableAppend(path, Buffer.from('next\n'))
    expect(read()).toEqual(Buffer.from('old\nretry\nnext\n'))
  })

  test('only promise appends are timed: rewrite, reconcile, ensure and the blocking append read no clock', async () => {
    const h = timedRun(), j = journal(h.r.fs)
    setDurableAppendTimer(h.timer)
    await j.ensureDir()
    await j.rewrite(path, Buffer.from('rewritten\n'))
    fs.appendFileSync(path, 'unaccepted\n')
    await j.reconcileRollback(path, { pendingRollback: 'rewritten\n'.length })
    j.durableAppendSync(path, Buffer.from('quarantined\n'))
    expect(h.reads()).toBe(0)
    expect(h.timings).toEqual([])
  })
})

describe('exact byte line splitting', () => {
  test('retains byte offsets, blank lines, CRLF, invalid UTF-8 and a torn multibyte tail', () => {
    const bytes = Buffer.concat([Buffer.from('é\n'), Buffer.from([0xff, 10, 10]), Buffer.from('🙂\r\n'), Buffer.from([0xe2, 0x82])])
    expect(splitJournalLines(bytes)).toEqual([
      { bytes: Buffer.from('é\n'), start: 0, line: 1, text: 'é', whole: true, torn: false },
      { bytes: Buffer.from([0xff, 10]), start: 3, line: 2, text: '\ufffd', whole: false, torn: false },
      { bytes: Buffer.from([10]), start: 5, line: 3, text: '', whole: true, torn: false },
      { bytes: Buffer.from('🙂\r\n'), start: 6, line: 4, text: '🙂\r', whole: true, torn: false },
      { bytes: Buffer.from([0xe2, 0x82]), start: 12, line: 5, text: '\ufffd', whole: false, torn: true },
    ])
    expect(Buffer.concat(splitJournalLines(bytes).map(line => line.bytes))).toEqual(bytes)
  })

  test.each([
    ['unterminated valid text', 'é', false, true],
    ['a valid replacement character', '\ufffd\n', true, false],
    ['a final newline', 'last\n', true, false],
  ] as const)('%s', (_, text, whole, torn) => {
    expect(splitJournalLines(Buffer.from(text))).toEqual([
      { bytes: Buffer.from(text), start: 0, line: 1, text: text.endsWith('\n') ? text.slice(0, -1) : text, whole, torn },
    ])
  })
  test('an empty file has no lines', () => expect(splitJournalLines(Buffer.alloc(0))).toEqual([]))
})
