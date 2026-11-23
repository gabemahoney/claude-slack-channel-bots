import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloneJournalData, createDurableJournal, removeTornTail, setDurableAppendTimer, splitJournalLines, yieldToEventLoop,
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
 * `sync` and `rename` are recorded in whichever form, callback or blocking, the journal used.
 * A `readFile` fault fails before any real call and names no syscall; `failReadAfterOpen`
 * opens the file for real, then fails with the given code and syscall. */
function recordingFs() {
  const ops: Op[] = [], paths = new Map<number, string>()
  const errors = new Map<string, Error>()
  const control = {
    maxChunk: Infinity,
    stat: undefined as fs.Stats | undefined,
    fileStat: undefined as fs.Stats | undefined,
    failReadAfterOpen: undefined as { code: string; syscall: string } | undefined,
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
    fstatSync(fd: number) { record({ step: 'fstat', path: fdPath(fd) }); return control.fileStat ?? fs.fstatSync(fd) },
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
    readSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: number) {
      record({ step: 'read', path: fdPath(fd), length }); return fs.readSync(fd, bytes, offset, length, position)
    },
    fchmodSync(fd: number, mode: fs.Mode) { record({ step: 'fchmod', path: fdPath(fd), mode }); fs.fchmodSync(fd, mode) },
    ftruncateSync(fd: number, length = 0) { record({ step: 'truncate', path: fdPath(fd), length }); fs.ftruncateSync(fd, length) },
    unlinkSync(p: fs.PathLike) { record({ step: 'unlink', path: String(p) }); fs.unlinkSync(p) },
    readFileSync(p: fs.PathLike) {
      record({ step: 'readFile', path: String(p) })
      const failure = control.failReadAfterOpen
      if (!failure) return fs.readFileSync(p)
      fs.closeSync(fs.openSync(p, 'r'))
      throw Object.assign(new Error(`${failure.code} injected ${failure.syscall}`), failure)
    },
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
const syncs = (ops: Op[]) => ops.filter(op => op.step === 'sync').map(op => op.path)
/** Lets every unheld durable step finish, so each operation has settled or waits on a hold. */
async function quiesce(r: ReturnType<typeof recordingFs>) { do { await r.io.idle(); await yieldToEventLoop() } while (r.io.busy()) }

test('compaction sync scope crosses no-op reconciliation and pauses only after rewrite prelude reaches native I/O', async () => {
  const r = recordingFs(), j = journal(r.fs), events: string[] = []
  const scope = { phase() {}, stop() {}, pause() { events.push('pause') }, resume() { events.push('resume') } }
  await j.ensureDir(); r.ops.length = 0
  await j.reconcileRollback(path, {}, scope)
  expect(events).toEqual([]) // an already-resolved promise is not a macrotask boundary
  const gate = Promise.withResolvers<void>()
  r.control.hold = op => op.step === 'sync' && op.path.endsWith('.tmp') ? gate.promise : undefined
  r.control.before = op => { if (op.step === 'write') expect(events).toEqual([]) }
  const pending = j.rewrite(path, Buffer.from('new-image\n'), scope)
  expect(events).toEqual(['pause'])
  expect(fs.existsSync(path)).toBe(false)
  gate.resolve(); await pending
  expect(events).toEqual(['pause', 'resume', 'pause', 'resume', 'pause', 'resume'])
  expect(read().toString()).toBe('new-image\n')
  expect(durableSteps(r.ops).map(op => op.step)).toEqual(['sync', 'rename', 'sync'])
})

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
      // Model inode reuse even on filesystems that do not reuse it in this run:
      // the directory the ensure's mkdir recreates reports the old identity.
      else r.control.before = op => { if (op.step === 'mkdir') r.control.stat = identity }
    }
    r.control.fail = op => op.step === 'sync' && op.path === root
    await expect(j.ensureDir()).rejects.toThrow('EIO injected sync')
    r.control.fail = () => false; r.ops.length = 0
    await j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root])
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700)
    expect(r.paths.size).toBe(0)
  })

  // t2.yiv.sf.ws (fix round 2): every append also ran mkdir on a directory
  // already known durable, which could only report that it exists.
  test('an append to a directory still known durable stats it once and runs no mkdir; any change takes the full ensure', async () => {
    const r = recordingFs(), j = journal(r.fs)
    await j.durableAppend(path, Buffer.from('first\n'))
    const steps = async (bytes: string) => { r.ops.length = 0; await j.durableAppend(path, Buffer.from(bytes)); return r.ops.filter(op => op.path === dir || op.path === root).map(op => `${op.step} ${op.path === dir ? 'dir' : 'root'}`) }
    expect(await steps('second\n')).toEqual(['stat dir'])
    // A changed mode, a missing directory and a replaced one each take mkdir, the mode and the parent sync, as before.
    const synced = (name: string) => [`open ${name}`, `sync ${name}`, `close ${name}`]
    fs.chmodSync(dir, 0o755)
    expect(await steps('third\n')).toEqual(['stat dir', 'mkdir dir', 'stat dir', 'chmod dir', ...synced('root')])
    fs.renameSync(dir, join(root, 'moved'))
    expect(await steps('fourth\n')).toEqual(['stat dir', 'mkdir dir', 'stat dir', 'chmod dir', ...synced('root'), ...synced('dir')])
    expect(read()).toEqual(Buffer.from('fourth\n'))
    fs.renameSync(dir, join(root, 'moved-again')); fs.mkdirSync(dir, { mode: 0o700 })
    expect(await steps('fifth\n')).toEqual(['stat dir', 'mkdir dir', 'stat dir', 'chmod dir', ...synced('root'), ...synced('dir')])
    // A failed stat falls back to the full ensure, whose own stat decides.
    r.control.fail = op => op.step === 'stat' && r.ops.filter(o => o.step === 'stat').length === 1
    expect(await steps('sixth\n')).toEqual(['stat dir', 'mkdir dir', 'stat dir'])
    expect(read()).toEqual(Buffer.from('fifth\nsixth\n'))
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

describe('directory sync only while a file entry may not be durable', () => {
  type Journal = ReturnType<typeof journal>
  type Recording = ReturnType<typeof recordingFs>
  const other = () => join(dir, 'beta.jsonl')
  /** Another path's creating append: a directory sync of `dir` that begins and succeeds now. */
  const otherSync = (j: Journal) => j.durableAppend(other(), Buffer.from('beta\n'))

  test.each(['async', 'sync'] as const)('a creating %s append syncs the file and then the directory; later appends sync the file only', async form => {
    const r = recordingFs(), j = journal(r.fs)
    const append = (text: string) => form === 'async' ? j.durableAppend(path, Buffer.from(text)) : j.durableAppendSync(path, Buffer.from(text))
    await j.ensureDir(); r.ops.length = 0
    await append('first\n')
    expect(syncs(r.ops)).toEqual([path, dir])
    r.ops.length = 0
    await append('second\n'); await append('third\n')
    expect(syncs(r.ops)).toEqual([path, path])
    expect(read()).toEqual(Buffer.from('first\nsecond\nthird\n'))
  })

  /** A read that opens the file and then fails with `code` naming `syscall`, then another path's directory sync. */
  const failedRead = (code: string, syscall: string) => async (j: Journal, r: Recording) => {
    r.control.failReadAfterOpen = { code, syscall }
    expect(() => j.read(path)).toThrow(`${code} injected ${syscall}`)
    r.control.failReadAfterOpen = undefined
    await otherSync(j)
  }
  // Only a successful read, or one failing at a step after the open (read, fstat), is an opening;
  // anything else leaves the opening to the append, so the path is never tracked before it exists.
  test.each([
    ['another path\'s directory sync, then the file\'s first opening by its own append', 'and the directory', async (j: Journal) => { await otherSync(j) }],
    ['a read, then another path\'s directory sync', 'only', async (j: Journal) => { j.read(path); await otherSync(j) }],
    ['a read that opens the file and fails at read, then another path\'s directory sync', 'only', failedRead('EIO', 'read')],
    ['a read that opens the file and fails at fstat, then another path\'s directory sync', 'only', failedRead('EIO', 'fstat')],
    ['a read failing at an unrecognised step, then another path\'s directory sync', 'and the directory', failedRead('EIO', 'mmap')],
    ['a read failing with ENOENT after its open, then another path\'s directory sync', 'and the directory', failedRead('ENOENT', 'read')],
    ['a read that fails before opening the file, then another path\'s directory sync', 'and the directory', async (j: Journal, r: Recording) => {
      r.control.fail = op => op.step === 'readFile'
      expect(() => j.read(path)).toThrow('EIO injected readFile')
      r.control.fail = () => false
      await otherSync(j)
    }],
    ['a read finding no file, then another path\'s directory sync', 'and the directory', async (j: Journal) => {
      fs.rmSync(path)
      expect(() => j.read(path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
      await otherSync(j)
    }],
    ['a rewrite whose rename onto the missing file fails, then another path\'s directory sync', 'and the directory', async (j: Journal, r: Recording) => {
      fs.rmSync(path)
      r.control.fail = op => op.step === 'rename'
      await expect(j.rewrite(path, Buffer.from('new\n'))).rejects.toThrow('EIO injected rename')
      r.control.fail = () => false
      expect(fs.existsSync(path)).toBe(false)
      await otherSync(j)
    }],
    ['a notified opening, then another path\'s directory sync', 'only', async (j: Journal) => { j.opened(path); await otherSync(j) }],
    ['a rollback reconciliation, then another path\'s directory sync', 'only', async (j: Journal) => {
      await j.reconcileRollback(path, { pendingRollback: 'old\n'.length }); await otherSync(j)
    }],
    ['a read, then only the parent directory sync', 'and the directory', async (j: Journal) => { j.read(path); await j.ensureDir() }],
    ['a read, another path\'s directory sync and a second read', 'only', async (j: Journal) => { j.read(path); await otherSync(j); j.read(path) }],
  ] as const)('%s: the first append syncs the file %s', async (_, expected, open) => {
    seed('old\n')
    const r = recordingFs(), j = journal(r.fs)
    await open(j, r)
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('alpha\n'))
    expect(syncs(r.ops)).toEqual(expected === 'only' ? [path] : [path, dir])
  })

  test.each(['created', 'replaced by a rename whose own directory sync fails', 'opened, as notified'] as const)('a directory sync already in flight when the file is %s cannot vouch for it, even when it succeeds afterwards', async event => {
    const r = recordingFs(), j = journal(r.fs), dirGates: ReturnType<typeof heldStep>[] = [], fileGate = heldStep()
    if (event !== 'created') seed('old\n')
    await j.ensureDir()
    r.control.hold = op => {
      if (op.step !== 'sync') return undefined
      if (op.path === path) return fileGate.promise
      if (op.path !== dir) return undefined
      const gate = heldStep(); dirGates.push(gate); return gate.promise
    }
    const older = otherSync(j)
    await quiesce(r)
    expect(dirGates).toHaveLength(1)
    let pending: Promise<void> | undefined
    if (event === 'created') pending = j.durableAppend(path, Buffer.from('alpha\n'))
    else if (event === 'opened, as notified') j.opened(path)
    else {
      const rewriting = j.rewrite(path, Buffer.from('new\n'))
      await quiesce(r)
      expect(dirGates).toHaveLength(2)
      dirGates[1]!.fail(Object.assign(new Error('EIO held directory sync'), { code: 'EIO' }))
      await expect(rewriting).rejects.toThrow('EIO held directory sync')
    }
    dirGates[0]!.release(); await older
    // The append checks its entry only after the older sync has returned.
    pending ??= j.durableAppend(path, Buffer.from('alpha\n'))
    let settled = false
    void pending.then(() => { settled = true })
    const issued = dirGates.length
    fileGate.release()
    await quiesce(r)
    expect(settled).toBe(false)
    expect(dirGates).toHaveLength(issued + 1)
    dirGates[issued]!.release(); await pending
    expect(settled).toBe(true)
  })

  test.each(['succeeds', 'fails'] as const)('another path\'s held directory sync, begun after a read, closes the read file\'s entry only if it %s', async outcome => {
    seed('old\n')
    const r = recordingFs(), j = journal(r.fs), gate = heldStep()
    await j.ensureDir(); j.read(path)
    r.control.hold = op => op.step === 'sync' && op.path === dir ? gate.promise : undefined
    const synced = otherSync(j)
    await quiesce(r)
    expect(r.io.held()).toBe(1)
    r.control.hold = () => undefined
    if (outcome === 'succeeds') { gate.release(); await synced }
    else { gate.fail(Object.assign(new Error('EIO held directory sync'), { code: 'EIO' })); await expect(synced).rejects.toThrow('EIO held directory sync') }
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('alpha\n'))
    expect(syncs(r.ops)).toEqual(outcome === 'succeeds' ? [path] : [path, dir])
  })

  test.each(['replaced', 'recreated with its old identity', 'given a new mode'] as const)('after the journal directory is %s, the next append syncs the parent and the file, and the directory unless only its mode changed', async change => {
    const r = recordingFs(), j = journal(r.fs), moved = join(root, 'old-journals')
    await j.durableAppend(path, Buffer.from('one\n'))
    const identity = fs.statSync(dir)
    if (change === 'given a new mode') fs.chmodSync(dir, 0o755)
    else {
      // The file is moved, keeping its own identity, so only the directory's change can reopen its entry.
      fs.renameSync(dir, moved)
      if (change === 'replaced') { fs.mkdirSync(dir, { mode: 0o700 }); fs.renameSync(join(moved, 'alpha.jsonl'), path) }
      else {
        r.control.stat = identity
        r.control.before = op => { if (op.step === 'stat' && !fs.existsSync(path)) fs.renameSync(join(moved, 'alpha.jsonl'), path) }
      }
    }
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('two\n'))
    expect(syncs(r.ops)).toEqual(change === 'given a new mode' ? [root, path] : [root, path, dir])
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('three\n'))
    expect(syncs(r.ops)).toEqual([path])
    expect(read()).toEqual(Buffer.from('one\ntwo\nthree\n'))
  })
})

describe('append and rollback', () => {
  test.each(['async', 'sync'] as const)('%s appends separate and replay records after a same-size tail edit with unchanged metadata', async form => {
    const r = recordingFs(), j = journal(r.fs)
    const append = (text: string) => form === 'async' ? j.durableAppend(path, Buffer.from(text)) : j.durableAppendSync(path, Buffer.from(text))
    await append('{"a":1}\n')
    // Model coarse inode timestamps: every field compared by the old tail
    // cache stays unchanged, even though a real write replaces the newline.
    const version = fs.statSync(path)
    r.control.fileStat = version
    const fd = fs.openSync(path, 'r+')
    try { fs.writeSync(fd, Buffer.from(' '), 0, 1, version.size - 1) } finally { fs.closeSync(fd) }
    expect(fs.statSync(path).size).toBe(version.size)
    expect(read()).toEqual(Buffer.from('{"a":1} '))

    await append('{"b":2}\n')
    const bytes = read(), lines = splitJournalLines(bytes)
    // Check replay independently of the byte assertion so a merged record is
    // reported as a parse failure too, not just a formatting difference.
    expect(() => lines.map(line => JSON.parse(line.text))).not.toThrow()
    expect(bytes).toEqual(Buffer.from('{"a":1} \n{"b":2}\n'))
    expect(lines.every(line => line.whole && !line.torn)).toBe(true)
    expect(lines.map(line => JSON.parse(line.text))).toEqual([{ a: 1 }, { b: 2 }])
    expect(r.paths.size).toBe(0)
  })

  test('appends read the repaired tail after failed append/rollback, explicit repair, and rewrite', async () => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    await j.durableAppend(path, Buffer.from('saved\n'), rollback)
    r.control.fail = op => op.path === path && (op.step === 'sync' || op.step === 'truncate')
    await expect(j.durableAppend(path, Buffer.from('unaccepted'), rollback)).rejects.toThrow()
    expect(rollback.pendingRollback).toBe(6)
    r.control.fail = () => false
    await j.reconcileRollback(path, rollback)
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('saved\nretry\n'))
    expect(r.ops.filter(op => op.step === 'read')).toHaveLength(2)
    await j.rewrite(path, Buffer.from('replacement'))
    await j.durableAppend(path, Buffer.from('next\n'), rollback)
    expect(read()).toEqual(Buffer.from('replacement\nnext\n'))
    expect(r.ops.filter(op => op.step === 'read')).toHaveLength(3)
    expect(rollback.pendingRollback).toBeUndefined()
  })

  test('appends check the on-disk tail after an edit or caller buffer mutation during file sync', async () => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep()
    await j.durableAppend(path, Buffer.from('saved\n'))
    r.control.hold = op => op.path === path && op.step === 'sync' ? gate.promise : undefined
    const bytes = Buffer.from('next\n'), pending = j.durableAppend(path, bytes)
    await yieldToEventLoop()
    expect(r.io.held()).toBe(1)
    bytes[bytes.length - 1] = 88
    gate.release(); await pending
    r.control.hold = () => undefined
    await j.durableAppend(path, Buffer.from('last\n'))
    expect(read()).toEqual(Buffer.from('saved\nnext\nlast\n'))
    expect(r.ops.filter(op => op.step === 'read')).toHaveLength(2)

    const edit = heldStep()
    r.control.hold = op => op.path === path && op.step === 'sync' ? edit.promise : undefined
    const edited = j.durableAppend(path, Buffer.from('edit\n'))
    await yieldToEventLoop()
    expect(r.io.held()).toBe(1)
    const external = read(); external[external.length - 1] = 88
    fs.writeFileSync(path, external); fs.utimesSync(path, 1, 1)
    edit.release(); await edited
    r.control.hold = () => undefined
    await j.durableAppend(path, Buffer.from('after\n'))
    expect(read()).toEqual(Buffer.from('saved\nnext\nlast\neditX\nafter\n'))
    expect(r.ops.filter(op => op.step === 'read')).toHaveLength(4)
  })

  test.each(['async', 'sync'] as const)('%s appends check each tail through the append descriptor and preserve external changes; only a different file at the path syncs the directory again', async form => {
    const r = recordingFs(), j = journal(r.fs)
    const append = (text = 'new\n') => form === 'async' ? j.durableAppend(path, Buffer.from(text)) : j.durableAppendSync(path, Buffer.from(text))
    const reads = () => r.ops.filter(op => op.step === 'read').length
    seed('old')
    for (let i = 0; i < 8; i++) await append()
    expect(read()).toEqual(Buffer.from('old\n' + 'new\n'.repeat(8)))
    expect(reads()).toBe(8)
    expect(r.ops.filter(op => op.step === 'read').map(op => op.length)).toEqual(Array(8).fill(1))
    expect(r.ops.filter(op => op.step === 'open' && op.path === path).map(op => op.flags)).toEqual(Array(8).fill('a+'))
    expect(r.ops.filter(op => op.step === 'fstat')).toHaveLength(8)
    fs.appendFileSync(path, 'external')
    let at = r.ops.length
    await append(); expect(reads()).toBe(9)
    expect(read().subarray(-13)).toEqual(Buffer.from('external\nnew\n'))
    // The same file still holds the path, so its entry stays known durable.
    expect(syncs(r.ops.slice(at))).toEqual([path])
    // A same-size edit still needs a separating newline.
    const bytes = read(); bytes[bytes.length - 1] = 88
    fs.writeFileSync(path, bytes); fs.utimesSync(path, 1, 1)
    await append(); expect(reads()).toBe(10)
    expect(read().subarray(-9)).toEqual(Buffer.from('newX\nnew\n'))
    fs.renameSync(path, join(dir, 'old.jsonl')); seed('replacement')
    at = r.ops.length
    await append(); expect(reads()).toBe(11)
    expect(read()).toEqual(Buffer.from('replacement\nnew\n'))
    // A different file now holds the path; its entry is new to this journal.
    expect(syncs(r.ops.slice(at))).toEqual([path, dir])
    await append('unterminated'); await append('')
    expect(read()).toEqual(Buffer.from('replacement\nnew\nunterminated\n'))
    expect(reads()).toBe(13)
    expect(r.paths.size).toBe(0)
  })

  test.each(['', 'old\n', 'old'])('short writes append exact bytes after %j; the first append syncs the file then the directory, the next only the file', async old => {
    const r = recordingFs(), j = journal(r.fs), bytes = Buffer.from('new é🙂\n')
    seed(old); r.control.maxChunk = 2
    await j.durableAppend(path, bytes)
    expect(read()).toEqual(Buffer.concat([Buffer.from(old + (old && !old.endsWith('\n') ? '\n' : '')), bytes]))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root, path, dir])
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('next\n'))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([path])
    expect(read().subarray(-5)).toEqual(Buffer.from('next\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['partial write', 'file sync', 'directory sync', 'zero write', 'negative write'] as const)('%s failure restores the original bytes and permits one clean retry, which still syncs the directory', async failure => {
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
    r.control.fail = () => false; r.control.maxChunk = 2; r.ops.length = 0
    await j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old without newline\nretry\n'))
    // No directory sync has succeeded since the failed append first opened the file.
    expect(syncs(r.ops)).toEqual([path, dir])
    r.ops.length = 0
    await j.durableAppend(path, Buffer.from('next\n'), rollback)
    expect(syncs(r.ops)).toEqual([path])
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
  test.each([Infinity, 2])('SR-9.11: chunked image writes yield between bounded contiguous slices, including odd remainder and short writes (%s)', async maxWrite => {
    const r = recordingFs(), chunk = 7, image = Buffer.from('é🙂-odd-image-end!\n')
    r.control.maxChunk = maxWrite
    const writes: Array<{ start: number; requested: number; bytes: Buffer }> = [], turns: number[] = []
    let turn = 0
    const seam = { ...r.fs, writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
      const start = fs.fstatSync(fd).size, n = r.fs.writeSync(fd, bytes, offset, length)
      writes.push({ start, requested: length, bytes: Buffer.from(bytes.subarray(offset, offset + n)) }); turns.push(turn)
      setImmediate(() => { turn++ })
      return n
    } } as typeof fs
    const j = createDurableJournal({ dir, parentDir: root, directoryMode: 0o700, fileMode: 0o600, fs: seam, rewriteChunkBytes: chunk })
    seed('previous image\n'); await j.ensureDir(); r.ops.length = 0
    const pending = j.rewrite(path, image)
    await pending
    expect(image.length % chunk).not.toBe(0)
    let covered = 0
    for (const write of writes) {
      expect(write.start).toBe(covered)
      expect(write.requested).toBeLessThanOrEqual(chunk)
      expect(write.bytes.length).toBeGreaterThan(0)
      expect(write.bytes.equals(image.subarray(covered, covered + write.bytes.length))).toBe(true)
      covered += write.bytes.length
    }
    expect(covered).toBe(image.length)
    expect(Buffer.concat(writes.map(w => w.bytes)).equals(image)).toBe(true)
    const expectedLengths: number[] = []
    for (let offset = 0; offset < image.length; offset += chunk) {
      for (let left = Math.min(chunk, image.length - offset); left > 0; left -= Math.min(left, maxWrite)) expectedLengths.push(left)
    }
    expect(writes.map(w => w.requested)).toEqual(expectedLengths)
    for (let i = 1; i < writes.length; i++) {
      if (writes[i]!.start % chunk === 0) expect(turns[i]!).toBeGreaterThan(turns[i - 1]!)
      else expect(turns[i]).toBe(turns[i - 1])
    }
    expect(read()).toEqual(image)
    const temp = r.ops.find(op => op.step === 'open' && op.flags === 'wx')!.path
    expect(r.ops.filter(op => ['write', 'sync', 'rename'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([...writes.map(() => ['write', temp]), ['sync', temp], ['rename', temp], ['sync', dir]])
    expect(r.paths.size).toBe(0); expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    writes.length = 0
    await j.durableAppend(path, image)
    // The option affects rewrites only; appends still request the entire buffer.
    expect(writes[0]!.requested).toBe(image.length)
    expect(read()).toEqual(Buffer.concat([image, image]))
  })

  test('SR-9.11: a journal without rewriteChunkBytes retains the queue whole-image write', async () => {
    const r = recordingFs(), j = journal(r.fs), image = Buffer.from('a whole queue image\né🙂\n')
    await j.ensureDir(); r.ops.length = 0
    await j.rewrite(path, image)
    expect(r.ops.filter(op => op.step === 'write').map(op => op.length)).toEqual([image.length])
    const temp = r.ops.find(op => op.step === 'open' && op.flags === 'wx')!.path
    expect(r.ops.filter(op => ['write', 'sync', 'rename'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([['write', temp], ['sync', temp], ['rename', temp], ['sync', dir]])
    expect(read()).toEqual(image); expect(r.paths.size).toBe(0)
  })

  test('uses unique exclusive mode-0600 temps, short writes and fsync before rename, then directory fsync, after which appends sync the file only', async () => {
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
    await j.durableAppend(path, Buffer.from('appended\n'))
    expect(syncs(r.ops)).toEqual([path])
    r.ops.length = 0
    await j.rewrite(path, Buffer.from('again\n'))
    expect(r.ops.find(op => op.step === 'open' && op.flags === 'wx')!.path).not.toBe(first.path)
    expect(read()).toEqual(Buffer.from('again\n'))
    expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    expect(r.paths.size).toBe(0)
  })

  const REWRITE_FAILURES = ['open-temp', 'partial-write', 'sync-temp', 'close-temp', 'rename', 'open-directory', 'sync-directory', 'close-directory'] as const
  test.each<[typeof REWRITE_FAILURES[number], 'known durable' | 'not yet durable']>([
    ...REWRITE_FAILURES.map(failure => [failure, 'known durable'] as [typeof failure, 'known durable']),
    ['sync-temp', 'not yet durable'],
  ])(
    '%s failure with the entry %s cleans the temp; only post-rename failures leave replacement bytes visible, and only an attempted rename changes whether the next append syncs the directory', async (failure, entry) => {
      const r = recordingFs(), j = journal(r.fs), old = Buffer.from('old longer record\n'), next = Buffer.from('new\n')
      if (entry === 'known durable') await j.durableAppend(path, old)
      else { seed(old); await j.ensureDir(); j.read(path) }
      r.control.maxChunk = 2
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
      r.control.fail = () => false; r.ops.length = 0
      await j.durableAppend(path, Buffer.from('appended\n'))
      const beforeRename = ['open-temp', 'partial-write', 'sync-temp', 'close-temp'].includes(failure)
      expect(syncs(r.ops)).toEqual(beforeRename && entry === 'known durable' ? [path] : [path, dir])
      await j.rewrite(path, next)
      expect(read()).toEqual(next)
      expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    },
  )
})

describe('chunk-list rewrite', () => {
  const pieceSize = 7
  async function capture(rewriteChunkBytes?: number) {
    const r = recordingFs(), writes: Array<{ bytes: Uint8Array; offset: number; length: number }> = []
    const seam = { ...r.fs, writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
      writes.push({ bytes, offset, length })
      return r.fs.writeSync(fd, bytes, offset, length)
    } } as typeof fs
    const j = createDurableJournal({ dir, parentDir: root, directoryMode: 0o700, fileMode: 0o600, fs: seam, rewriteChunkBytes })
    await j.ensureDir(); r.ops.length = 0
    return { r, j, writes }
  }
  function rewriteTrace(ops: Op[]) {
    return ops.filter(op => ['open', 'write', 'sync', 'close', 'rename', 'unlink'].includes(op.step))
      .map(op => `${op.step}:${op.path.endsWith('.tmp') ? 'temp' : op.path === dir ? 'directory' : 'journal'}`)
  }

  test.each([
    ['aligned boundaries', [7, 7, 7]],
    ['one crossed boundary', [4, 10, 6]],
    ['several crossed boundaries', [1, 2, 1, 1, 1, 1, 2, 3, 4]],
    ['chunk larger than a piece', [19, 3]],
    ['leading, middle and trailing empty chunks', [0, 4, 0, 10, 0, 6, 0]],
    ['empty list', []],
    ['only empty chunks', [0, 0, 0]],
    ['single chunk', [19]],
  ] as const)('rewriteChunks matches bytes, pieces, yields and durability of rewrite, borrowing contained views: %s', async (_name, lengths) => {
    const image = Buffer.from(Array.from({ length: lengths.reduce<number>((sum, n) => sum + n, 0) }, (_, i) => (i * 37 + 128) % 256))
    let at = 0
    // Separate backing allocations and nonzero offsets make a copied Buffer
    // distinguishable from a view, even when Bun pools small Buffer payloads.
    const chunks = Object.freeze(lengths.map(length => {
      const bytes = new Uint8Array(new ArrayBuffer(length + 4), 2, length)
      bytes.set(image.subarray(at, at + length)); at += length; return bytes
    }))
    const { r, j, writes } = await capture(pieceSize)
    const expectedLengths = Array.from({ length: Math.ceil(image.length / pieceSize) }, (_, i) => Math.min(pieceSize, image.length - i * pieceSize))
    const expectedTrace = ['open:temp', ...expectedLengths.map(() => 'write:temp'), 'sync:temp', 'close:temp',
      'rename:temp', 'open:directory', 'sync:directory', 'close:directory', 'unlink:temp']
    const immediate = globalThis.setImmediate
    let yields = 0
    const immediateSpy = spyOn(globalThis, 'setImmediate').mockImplementation(((...args: Parameters<typeof setImmediate>) => {
      yields++; return immediate(...args)
    }) as typeof setImmediate)
    try {
      await j.rewrite(path, image)
      const baseline = { lengths: writes.map(w => w.length), yields, trace: rewriteTrace(r.ops) }
      expect(read()).toEqual(image)
      expect(baseline).toEqual({ lengths: expectedLengths, yields: Math.max(0, expectedLengths.length - 1), trace: expectedTrace })
      writes.length = 0; r.ops.length = 0; yields = 0
      await j.rewriteChunks(path, chunks)
      expect(read()).toEqual(image)
      expect({ lengths: writes.map(w => w.length), yields, trace: rewriteTrace(r.ops) }).toEqual(baseline)
      let position = 0
      for (const write of writes) {
        expect(write.length).toBeLessThanOrEqual(pieceSize)
        expect(Buffer.from(write.bytes.subarray(write.offset, write.offset + write.length))).toEqual(image.subarray(position, position + write.length))
        let start = 0
        for (const source of chunks) {
          if (position >= start && position + write.length <= start + source.length) {
            expect(write.bytes.buffer).toBe(source.buffer)
            expect(write.bytes.byteOffset + write.offset).toBe(source.byteOffset + position - start)
            break
          }
          start += source.length
        }
        position += write.length
      }
      expect(position).toBe(image.length)
      expect(r.paths.size).toBe(0); expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    } finally { immediateSpy.mockRestore() }
  })

  test.each(['write', 'sync', 'rename'] as const)('rewriteChunks preserves the %s failure, closes and removes its temp, and retries like rewrite', async failure => {
    const image = Buffer.from('a replacement image\n'), old = Buffer.from('old image\n')
    const chunks = Object.freeze([image.subarray(0, 2), image.subarray(2, 9), image.subarray(9)])
    const traces: string[][] = []
    for (const form of ['buffer', 'chunks'] as const) {
      const { r, j } = await capture(pieceSize)
      seed(old)
      r.control.maxChunk = failure === 'write' ? 2 : Infinity
      r.control.fail = op => op.path.endsWith('.tmp') && op.step === failure &&
        (failure !== 'write' || fs.statSync(op.path).size > 0)
      let caught: unknown
      try { await (form === 'chunks' ? j.rewriteChunks(path, chunks) : j.rewrite(path, image)) }
      catch (error) { caught = error }
      expect(caught).toBeDefined()
      expect(caught).toBe(r.errors.get(failure))
      expect(caught).toMatchObject({ code: 'EIO', message: `EIO injected ${failure}` })
      const writeCount = failure === 'write' ? 2 : Math.ceil(image.length / pieceSize)
      const expected = ['open:temp', ...Array(writeCount).fill('write:temp'),
        ...(failure === 'write' ? [] : ['sync:temp']), 'close:temp',
        ...(failure === 'rename' ? ['rename:temp'] : []), 'unlink:temp']
      const trace = rewriteTrace(r.ops); expect(trace).toEqual(expected); traces.push(trace)
      expect(read()).toEqual(old)
      expect(r.paths.size).toBe(0); expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
      r.control.fail = () => false
      await (form === 'chunks' ? j.rewriteChunks(path, chunks) : j.rewrite(path, image))
      expect(read()).toEqual(image)
      expect(r.paths.size).toBe(0); expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    }
    expect(traces[1]).toEqual(traces[0])
  })

  test('rewrite without rewriteChunkBytes borrows its whole input without copying or yielding', async () => {
    const { r, j, writes } = await capture()
    const image = new Uint8Array(new ArrayBuffer(31), 3, 23)
    image.set(Buffer.from('a whole queue image\n'))
    const immediate = globalThis.setImmediate, concat = Buffer.concat
    const immediateSpy = spyOn(globalThis, 'setImmediate').mockImplementation(immediate)
    const concatSpy = spyOn(Buffer, 'concat').mockImplementation(concat)
    try {
      await j.rewrite(path, image)
      expect(writes).toHaveLength(1)
      expect(writes[0]!.length).toBe(image.length)
      expect(writes[0]!.bytes.buffer).toBe(image.buffer)
      expect(writes[0]!.bytes.byteOffset + writes[0]!.offset).toBe(image.byteOffset)
      expect(immediateSpy).not.toHaveBeenCalled(); expect(concatSpy).not.toHaveBeenCalled()
      expect(read()).toEqual(Buffer.from(image))
      expect(r.paths.size).toBe(0)
    } finally { immediateSpy.mockRestore(); concatSpy.mockRestore() }
  })
})

describe('disk waits run on the I/O pool; only read-time quarantine blocks', () => {
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
    // A fresh journal: the blocking form's steps, path for path, match the callback form's,
    // the first append syncing the directory and the next only the file.
    const asyncRun = recordingFs()
    fs.rmSync(dir, { recursive: true }); seed('old')
    const asyncJournal = journal(asyncRun.fs)
    await asyncJournal.durableAppend(path, Buffer.from('quarantined\n'))
    await asyncJournal.durableAppend(path, Buffer.from('next\n'))
    const asyncBytes = read()
    expect(syncs(asyncRun.ops)).toEqual([root, path, dir, path])
    const syncRun = recordingFs()
    fs.rmSync(dir, { recursive: true }); seed('old')
    const syncJournal = journal(syncRun.fs)
    syncJournal.durableAppendSync(path, Buffer.from('quarantined\n'))
    syncJournal.durableAppendSync(path, Buffer.from('next\n'))
    expect(read()).toEqual(asyncBytes)
    expect(durableSteps(syncRun.ops).map(op => op.form)).toEqual(durableSteps(asyncRun.ops).map(() => 'sync'))
    expect(durableSteps(syncRun.ops).map(op => [op.step, op.path])).toEqual(durableSteps(asyncRun.ops).map(op => [op.step, op.path]))
    expect(syncRun.ops.map(op => op.step)).toEqual(asyncRun.ops.map(op => op.step))
  })

  test.each(['file sync', 'directory sync', 'truncate'] as const)('a blocking first append whose %s fails throws before returning, with the same rollback the callback form keeps, and its retry syncs the directory', failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}, old = Buffer.from('old\n')
    // The run's first opening of an existing file: the append must sync the directory.
    seed(old)
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
      expect(rollback.pendingRollback).toBe(old.length)
    } else {
      expect(read()).toEqual(old)
      expect(rollback.pendingRollback).toBeUndefined()
    }
    r.control.fail = () => false
    const retry = r.ops.length
    j.durableAppendSync(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(syncs(r.ops.slice(retry))).toEqual(failure === 'truncate' ? [path, path, dir] : [path, dir])
    expect(durableSteps(r.ops).filter(op => op.form !== 'sync')).toEqual([])
    expect(r.paths.size).toBe(0)
  })

  test('the default node:fs backend preserves append, rewrite and rollback bytes; a blocking append is complete on return', async () => {
    const j = createDurableJournal({ dir, parentDir: root, directoryMode: 0o700, fileMode: 0o600 }), rollback: AppendRollback = {}
    await j.durableAppend(path, Buffer.from('first\n'))
    await j.durableAppend(path, Buffer.from('second\n'), rollback)
    expect(read()).toEqual(Buffer.from('first\nsecond\n'))
    await j.rewrite(path, Buffer.from('rewritten\n'))
    expect(read()).toEqual(Buffer.from('rewritten\n'))
    fs.appendFileSync(path, 'unaccepted\n'); rollback.pendingRollback = 'rewritten\n'.length
    await j.reconcileRollback(path, rollback)
    expect(read()).toEqual(Buffer.from('rewritten\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(j.durableAppendSync(path, Buffer.from('quarantined\n'))).toBeUndefined()
    expect(read()).toEqual(Buffer.from('rewritten\nquarantined\n'))
  })

  test.each(['rollback repair', 'rewrite rename', 'new directory sync'] as const)('%s waits for durability while an independent path completes', async boundary => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep(), reached = Promise.withResolvers<void>()
    const other = join(dir, 'beta.jsonl'), rollback: AppendRollback = {}, order: string[] = []
    if (boundary !== 'new directory sync') await j.durableAppend(path, Buffer.from('old\n'))
    if (boundary === 'rollback repair') {
      fs.appendFileSync(path, 'unaccepted\n'); rollback.pendingRollback = 'old\n'.length
    }
    let held = false
    r.control.hold = op => {
      const matches = boundary === 'rollback repair' ? op.step === 'sync' && op.path === path :
        boundary === 'rewrite rename' ? op.step === 'rename' : op.step === 'sync' && op.path === root
      if (held || !matches || op.form !== 'callback') return
      held = true; order.push('held'); reached.resolve(); return gate.promise
    }
    const pending = (boundary === 'rollback repair' ? j.reconcileRollback(path, rollback) :
      boundary === 'rewrite rename' ? j.rewrite(path, Buffer.from('new\n')) : j.ensureDir())
      .then(() => { order.push('complete') })
    try {
      await Promise.race([reached.promise, pending])
      expect(order).toEqual(['held'])
      if (boundary !== 'new directory sync') expect(read()).toEqual(Buffer.from('old\n'))
      await j.durableAppend(other, Buffer.from('beta\n')); order.push('independent')
      expect(fs.readFileSync(other)).toEqual(Buffer.from('beta\n'))
      expect(order).toEqual(['held', 'independent'])
      gate.release(); order.push('released'); await pending
      expect(order).toEqual(['held', 'independent', 'released', 'complete'])
      if (boundary === 'new directory sync') expect(fs.readdirSync(dir)).toEqual(['beta.jsonl'])
      else expect(read()).toEqual(Buffer.from(boundary === 'rollback repair' ? 'old\n' : 'new\n'))
      expect(rollback.pendingRollback).toBeUndefined()
    } finally { gate.release(); await pending }
    expect(r.paths.size).toBe(0)
  })

  test('while a file sync is held, another journal path appends; that path\'s later directory sync vouches for the held append, which resolves only after its file sync, with no directory sync of its own', async () => {
    const r = recordingFs(), j = journal(r.fs), gate = heldStep(), reached = Promise.withResolvers<void>(), other = join(dir, 'beta.jsonl')
    await j.ensureDir()
    r.control.hold = op => {
      if (op.step === 'sync' && op.path === path) { reached.resolve(); return gate.promise }
    }
    const order: string[] = []
    const held = j.durableAppend(path, Buffer.from('held\n')).then(() => { order.push('complete') })
    try {
      await Promise.race([reached.promise, held])
      expect(r.io.held()).toBe(1)
      await j.durableAppend(other, Buffer.from('beta\n')); order.push('independent')
      expect(fs.readFileSync(other)).toEqual(Buffer.from('beta\n'))
      expect(order).toEqual(['independent'])
      expect(r.ops.filter(op => op.step === 'sync' && op.path === dir)).toHaveLength(1)
      r.ops.length = 0
      gate.release(); order.push('released'); await held
      expect(order).toEqual(['independent', 'released', 'complete'])
      // The other path's directory sync began after this file's creation.
      expect(syncs(r.ops)).toEqual([])
      expect(read()).toEqual(Buffer.from('held\n'))
    } finally { gate.release(); await held }
    expect(r.paths.size).toBe(0)
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

  test('each successful append reports its records, bytes, whole time and file/directory fsync split: the creating append with the parent and directory syncs, a later group as one write and one file sync', async () => {
    const h = timedRun(), j = journal(h.r.fs)
    setDurableAppendTimer(h.timer)
    const group = Buffer.from('{"seq":2}\n{"seq":3}\n{"seq":4}\n')
    await j.durableAppend(path, Buffer.from('{"seq":1}\n'))
    h.r.ops.length = 0
    await j.durableAppend(path, group)
    expect(h.timings).toEqual([
      { dir, path, records: 1, bytes: 10, appendMs: 8, fileFsyncMs: 5, dirFsyncMs: 3, fsyncs: 3, atMonoMs: 1008 },
      { dir, path, records: 3, bytes: group.length, appendMs: 5, fileFsyncMs: 5, dirFsyncMs: 0, fsyncs: 1, atMonoMs: 1013 },
    ])
    expect(h.r.ops.filter(op => op.step === 'write')).toHaveLength(1)
    expect(JSON.stringify(h.timings)).not.toContain('seq')
  })

  // t2.yiv.sf.ws (fix round 2): the record count iterated every byte.
  test('records counts each newline byte, as a walk over every byte counted them', async () => {
    const h = timedRun(), j = journal(h.r.fs)
    setDurableAppendTimer(h.timer)
    const inputs: Uint8Array[] = [Buffer.from('no newline'), Buffer.from('\n'), Buffer.from('\n\nmiddle\n\n'), new TextEncoder().encode('é\n🙂\n'), Buffer.from('{"a":1}\n'.repeat(500))]
    // No byte-by-byte walk: count typed-array iterations while appending.
    const iterate = Uint8Array.prototype[Symbol.iterator]
    let walks = 0
    Object.defineProperty(Uint8Array.prototype, Symbol.iterator, { configurable: true, writable: true, value(this: Uint8Array) { walks++; return iterate.call(this) } })
    try { for (const bytes of inputs) await j.durableAppend(path, bytes) } finally { delete (Uint8Array.prototype as { [Symbol.iterator]?: unknown })[Symbol.iterator] }
    expect(Uint8Array.prototype[Symbol.iterator]).toBe(iterate)
    expect(walks).toBe(0)
    let newlines: number[] = []
    for (const bytes of inputs) { let n = 0; for (const byte of bytes) if (byte === 10) n++; newlines = [...newlines, n] }
    expect(h.timings.map(timing => timing.records)).toEqual(newlines)
    expect(newlines).toEqual([0, 1, 4, 2, 500])
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

/** The same values, prototypes, frozenness, property descriptors and
 * aliasing: what `toEqual` cannot see, such as a lost shared reference. */
function sameCopy(a: unknown, b: unknown, pairs = new Map<object, object>(), back = new Map<object, object>()): string | undefined {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? undefined : `${String(a)} vs ${String(b)}`
  if (pairs.has(a)) return pairs.get(a) === b ? undefined : 'aliasing'
  if (back.has(b)) return 'aliasing'
  pairs.set(a, b); back.set(b, a)
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return 'prototype'
  if (Array.isArray(a) !== Array.isArray(b)) return 'array'
  if (Object.isFrozen(a) !== Object.isFrozen(b)) return 'frozen'
  const keys = Reflect.ownKeys(a).map(String), otherKeys = Reflect.ownKeys(b).map(String)
  if (keys.join('\0') !== otherKeys.join('\0')) return `keys ${keys} vs ${otherKeys}`
  for (const key of Reflect.ownKeys(a)) {
    const da = Object.getOwnPropertyDescriptor(a, key)!, db = Object.getOwnPropertyDescriptor(b, key)!
    if (da.writable !== db.writable || da.enumerable !== db.enumerable || da.configurable !== db.configurable || ('get' in da) !== ('get' in db)) return `descriptor ${String(key)}`
    const differs = sameCopy(da.value, db.value, pairs, back)
    if (differs) return `${String(key)}: ${differs}`
  }
  return undefined
}
function copyOutcome(copy: () => unknown): { value?: unknown; error?: string } {
  try { return { value: copy() } } catch (error) { return { error: `${(error as Error).name}: ${(error as Error).message}` } }
}

// Journal copies preserve native clone values, errors, detachment and side effects.
describe('journal data copies', () => {
  const shared = { incarnation: 'life', threadHybridSince: 'since' }
  const fixed = { v: 1, kind: 'fixed', seq: 1, parts: ['a', 'b'] }
  /** Values `cloneJournalData` copies itself. */
  function journalData(): Record<string, unknown> {
    const cyclic: Record<string, unknown> = { a: 1 }; cyclic['self'] = cyclic; cyclic['list'] = [cyclic, { back: cyclic }]
    const hidden = { a: 1 }; Object.defineProperty(hidden, 'hidden', { value: 2, enumerable: false })
    return {
      item: { accepted: { v: 1, kind: 'accepted', seq: 1, text: 'hi 🙂', thread_ts: undefined, key: { chat_id: 'C0TEST001', ts: '1700000000.000001' } },
        fixed, records: [fixed, { kind: 'sent', attempt: 1 }], delivered: false, hold: { field: { stamp: shared, again: shared } }, shared: [shared, shared] },
      scalars: { a: undefined, b: null, c: -0, d: NaN, e: 1n, f: 'x', g: true, h: Infinity },
      cyclic, hidden,
      nullPrototype: Object.assign(Object.create(null), { a: 1, b: { c: 2 } }),
      symbolKey: { a: 1, [Symbol('key')]: 2 },
      order: { b: 1, 2: 2, a: 3, 1: 4 },
      frozen: Object.freeze({ a: Object.freeze([1, Object.freeze({ b: 2 })]) }),
      number: 5, string: 'text', undefined: undefined, null: null, emptyArray: [], emptyObject: {},
    }
  }
  /** Values only `structuredClone` copies (or refuses) as `structuredClone` does. */
  function otherData(): Record<string, unknown> {
    class Thing { x = 1; y = { z: 2 } }
    const named: unknown[] & { name?: string } = [1, 2]; named.name = 'x'
    const holed = [1, , 3]
    const holedNamed: unknown[] & { name?: string } = [1, , 3]; holedNamed.name = 'x'
    // A non-enumerable index beside a named property keeps the key count.
    const hiddenIndex: unknown[] & { name?: string } = [1, 2]; Object.defineProperty(hiddenIndex, 0, { value: 1, enumerable: false }); hiddenIndex.name = 'x'
    const accessorIndex = [1, 2]; Object.defineProperty(accessorIndex, 1, { get: () => 5, enumerable: true })
    const setterOnly = { a: 1 }; Object.defineProperty(setterOnly, 'b', { set: () => {}, enumerable: true })
    return {
      named, holed, holedNamed, hiddenIndex,
      builtIns: { when: new Date(0), map: new Map([[1, { a: 1 }]]), set: new Set([1]), bytes: new Uint8Array([1, 2]), list: [shared, shared] },
      functionValue: { a: 1, f: () => 1 }, topFunction: () => 1,
      symbolValue: { a: Symbol('value') },
      protoKey: JSON.parse('{"__proto__": {"a": 1}, "b": 2}'),
      instance: new Thing(), nestedInstance: { t: new Thing() },
      error: { e: new Error('boom') },
      boxed: { s: new String('x') },
      getter: { get x() { return { n: 1 } } }, accessorIndex, setterOnly,
      proxy: new Proxy({ a: 1 }, {}), arrayProxy: new Proxy([1, 2], {}), nestedProxy: { a: { b: 1 }, p: new Proxy({ c: 3 }, {}) },
    }
  }
  /** Values `structuredClone` already copied, which keep their own prototypes. */
  function nativelyCopied(): Record<string, unknown> {
    return structuredClone({
      record: { accepted: { text: 'hi', key: { chat_id: 'C0TEST001', ts: '1700000000.000001' } }, parts: ['a', 'b'] },
      fromNullPrototype: Object.assign(Object.create(null), { a: { b: 1 } }),
      builtIns: { when: new Date(0), map: new Map([[1, { a: 1 }]]), bytes: new Uint8Array([1, 2]), error: new Error('boom'), boxed: new String('x'), list: [shared, shared] },
      blob: { file: new Blob(['payload'], { type: 'text/plain' }) },
    })
  }

  test.each([['journal data', journalData], ['other values', otherData], ['values structuredClone copied', nativelyCopied]] as const)('copies %s exactly as structuredClone does, errors included', (_, values) => {
    for (const [name, value] of Object.entries(values())) {
      const expected = copyOutcome(() => structuredClone(value)), actual = copyOutcome(() => cloneJournalData(value))
      if (expected.error || actual.error) { expect(`${name}: ${actual.error}`).toBe(`${name}: ${expected.error}`); continue }
      expect(`${name}: ${sameCopy(expected.value, actual.value) ?? 'same'}`).toBe(`${name}: same`)
      if (typeof value === 'object' && value !== null) expect(actual.value).not.toBe(value)
    }
  })

  test('a Blob structuredClone copied keeps its payload and type', async () => {
    const { blob } = nativelyCopied() as { blob: { file: Blob } }
    const copy = cloneJournalData(blob)
    expect(copy.file).toBeInstanceOf(Blob)
    expect(copy.file).not.toBe(blob.file)
    expect([copy.file.type, await copy.file.text()]).toEqual([blob.file.type, 'payload'])
  })

  /** A proxy handler logging every trap a copy could run. */
  function traps(log: string[]): ProxyHandler<object> {
    return {
      get: (target, key, receiver) => { log.push(`get ${String(key)}`); return Reflect.get(target, key, receiver) },
      has: (target, key) => { log.push(`has ${String(key)}`); return Reflect.has(target, key) },
      ownKeys: target => { log.push('ownKeys'); return Reflect.ownKeys(target) },
      getOwnPropertyDescriptor: (target, key) => { log.push(`describe ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key) },
      getPrototypeOf: target => { log.push('prototype'); return Reflect.getPrototypeOf(target) },
      isExtensible: target => { log.push('extensible'); return Reflect.isExtensible(target) },
    }
  }
  class SlackKey { chat_id = 'C0TEST001'; ts = '1700000000.000001' }
  /** Inputs whose reading runs code, each logging what ran. */
  const codeRunning: Array<[string, (log: string[]) => unknown]> = [
    // review-r1 R1: the getter ran in the copy, then again in the fallback the class instance needs.
    ['a getter before a fallback', log => { let n = 0; return { source: 'slack', get text() { log.push('text'); return `message-${++n}` }, key: new SlackKey() } }],
    ['a getter deleting a later property', log => {
      const value: Record<string, unknown> = { get a() { log.push('a'); delete value['b']; return 1 }, b: 2, c: 3 }
      return value
    }],
    ['a getter whose second answer cannot be copied', log => ({ get x() { log.push('x'); return log.length > 1 ? () => 1 : 1 }, when: new Date(0) })],
    ['a throwing getter after data', log => ({ a: { b: 1 }, get c() { log.push('c'); throw new Error('read refused') } })],
    ['an accessor index', log => { const list = [1, { a: 2 }]; Object.defineProperty(list, 0, { get() { log.push('0'); return 5 }, enumerable: true }); return { list } }],
    ['a frozen object with a getter', log => Object.freeze({ a: Object.freeze([1]), get b() { log.push('b'); return { c: 1 } } })],
    ['a proxy', log => new Proxy({ a: 1, b: { c: 2 } }, traps(log))],
    ['an array proxy', log => new Proxy([1, { a: 2 }], traps(log))],
    ['a proxy after data', log => ({ a: { b: 1 }, p: new Proxy({ c: 3 }, traps(log)) })],
  ]
  test.each(codeRunning)('copies %s as structuredClone does, running the same code once', (_, input) => {
    const expectedLog: string[] = [], actualLog: string[] = []
    const expected = copyOutcome(() => structuredClone(input(expectedLog))), actual = copyOutcome(() => cloneJournalData(input(actualLog)))
    expect(actual.error).toBe(expected.error)
    if (!expected.error) expect(sameCopy(expected.value, actual.value) ?? 'same').toBe('same')
    expect(actualLog).toEqual(expectedLog)
  })

  test('frozen plain data keeps its values; frozen data holding code or an unfrozen part is read as given each time', () => {
    const data = Object.freeze({ a: Object.freeze([1, Object.freeze({ b: 'x' })]), c: Object.freeze({}), d: Object.freeze({ e: 1n }) })
    const copies = [cloneJournalData(data), cloneJournalData(data), cloneJournalData({ again: data })]
    expect(copies.map(copy => sameCopy(structuredClone(data), (copy as { again?: unknown }).again ?? copy) ?? 'same')).toEqual(['same', 'same', 'same'])
    // An unfrozen part can change between copies.
    const inner = { b: 1 }, partly = Object.freeze({ inner })
    expect(cloneJournalData(partly)).toEqual({ inner: { b: 1 } })
    inner.b = 2
    expect(cloneJournalData(partly)).toEqual({ inner: { b: 2 } })
    // A getter runs for every copy, as structuredClone's.
    let reads = 0
    const accessor = Object.freeze({ get a() { return ++reads } })
    expect([cloneJournalData(accessor), cloneJournalData(accessor)]).toEqual([{ a: 1 }, { a: 2 }])
    // A proxy in frozen data is refused every time, as structuredClone refuses it, running none of its traps.
    const log: string[] = [], proxied = Object.freeze({ p: new Proxy(Object.freeze({ a: 1 }), traps(log)) })
    for (let i = 0; i < 2; i++) expect(copyOutcome(() => cloneJournalData(proxied))).toEqual(copyOutcome(() => structuredClone(proxied)))
    expect([reads, log]).toEqual([2, []])
  })
})
