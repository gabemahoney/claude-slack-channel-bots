import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableJournal, removeTornTail, splitJournalLines, type AppendRollback } from '../src/durable-journal.ts'

let root: string, dir: string, path: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'durable-journal-'))
  dir = join(root, 'journals')
  path = join(dir, 'alpha.jsonl')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

type Op = { step: string; path: string; flags?: fs.OpenMode; mode?: fs.Mode; length?: number }
/** Real scratch files, with faults before the chosen operation (close faults close first). */
function recordingFs() {
  const ops: Op[] = [], paths = new Map<number, string>()
  const errors = new Map<string, Error>()
  const control = {
    maxChunk: Infinity,
    stat: undefined as fs.Stats | undefined,
    fail: (_op: Op): boolean => false,
    before: (_op: Op): void => {},
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
  const seam = { ...fs,
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
    fsyncSync(fd: number) { record({ step: 'sync', path: fdPath(fd) }); fs.fsyncSync(fd) },
    fchmodSync(fd: number, mode: fs.Mode) { record({ step: 'fchmod', path: fdPath(fd), mode }); fs.fchmodSync(fd, mode) },
    ftruncateSync(fd: number, length = 0) { record({ step: 'truncate', path: fdPath(fd), length }); fs.ftruncateSync(fd, length) },
    renameSync(from: fs.PathLike, to: fs.PathLike) { record({ step: 'rename', path: String(from) }); fs.renameSync(from, to) },
    unlinkSync(p: fs.PathLike) { record({ step: 'unlink', path: String(p) }); fs.unlinkSync(p) },
  } as typeof fs
  return { fs: seam, ops, paths, errors, control }
}
function journal(seam: typeof fs = fs, directoryMode = 0o700, fileMode = 0o600) {
  return createDurableJournal({ dir, parentDir: root, directoryMode, fileMode, fs: seam })
}
function seed(bytes: string | Buffer) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, bytes)
}
const read = () => fs.readFileSync(path)

describe('directory durability and modes', () => {
  test('construction does no filesystem work', () => {
    const r = recordingFs()
    journal(r.fs)
    expect(r.ops).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
  })

  test.each([[0o700, 0o600], [0o750, 0o640]])('honours directory %s and file %s modes, including existing permissive files', (directoryMode, fileMode) => {
    const r = recordingFs(), j = journal(r.fs, directoryMode, fileMode)
    j.durableAppend(path, Buffer.from('first\n'))
    expect(r.ops.find(op => op.step === 'mkdir')?.mode).toBe(directoryMode)
    expect(r.ops.find(op => op.step === 'open' && op.path === path)?.mode).toBe(fileMode)
    fs.chmodSync(dir, 0o777); fs.chmodSync(path, 0o666)
    j.durableAppend(path, Buffer.from('second\n'))
    expect(fs.statSync(dir).mode & 0o7777).toBe(directoryMode)
    expect(fs.statSync(path).mode & 0o7777).toBe(fileMode)
    expect(read()).toEqual(Buffer.from('first\nsecond\n'))
    j.rewrite(path, Buffer.from('rewritten\n'))
    expect(fs.statSync(path).mode & 0o7777).toBe(fileMode)
    expect(read()).toEqual(Buffer.from('rewritten\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['mkdir', 'stat', 'chmod', 'open', 'sync'] as const)('a failed ensure at %s stays retryable before append', step => {
    const r = recordingFs(), j = journal(r.fs)
    r.control.fail = op => op.step === step
    expect(() => j.durableAppend(path, Buffer.from('new\n'))).toThrow(`EIO injected ${step}`)
    expect(fs.existsSync(path)).toBe(false)
    r.control.fail = () => false; r.ops.length = 0
    j.durableAppend(path, Buffer.from('new\n'))
    expect(read()).toEqual(Buffer.from('new\n'))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root, path, dir])
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700)
    expect(r.paths.size).toBe(0)
  })

  test.each(['replacement', 'recreation with reused identity', 'changed mode'] as const)('revalidates directory durability after %s', change => {
    const r = recordingFs()
    const j = journal(r.fs)
    j.ensureDir()
    const identity = fs.statSync(dir)
    r.ops.length = 0
    j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync')).toEqual([])
    if (change === 'changed mode') fs.chmodSync(dir, 0o755)
    else {
      fs.renameSync(dir, join(root, 'old-journals'))
      if (change === 'replacement') fs.mkdirSync(dir, { mode: 0o700 })
      // Model inode reuse even on filesystems that do not reuse it in this run.
      else r.control.stat = identity
    }
    r.control.fail = op => op.step === 'sync' && op.path === root
    expect(() => j.ensureDir()).toThrow('EIO injected sync')
    r.control.fail = () => false; r.ops.length = 0
    j.ensureDir()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root])
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700)
    expect(r.paths.size).toBe(0)
  })
})

describe('append and rollback', () => {
  test.each(['', 'old\n', 'old'])('short writes append exact bytes after %j, with file then directory sync', old => {
    const r = recordingFs(), j = journal(r.fs), bytes = Buffer.from('new é🙂\n')
    seed(old); r.control.maxChunk = 2
    j.durableAppend(path, bytes)
    expect(read()).toEqual(Buffer.concat([Buffer.from(old + (old && !old.endsWith('\n') ? '\n' : '')), bytes]))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([root, path, dir])
    r.ops.length = 0
    j.durableAppend(path, Buffer.from('next\n'))
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([path, dir])
    expect(read().subarray(-5)).toEqual(Buffer.from('next\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['partial write', 'file sync', 'directory sync', 'zero write', 'negative write'] as const)('%s failure restores the original bytes and permits one clean retry', failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    const old = Buffer.from('old without newline')
    seed(old); j.ensureDir(); r.control.maxChunk = 2
    let failed = false
    r.control.fail = op => {
      const match = failure === 'partial write' ? op.step === 'write' && read().length > old.length + 1
        : op.step === 'sync' && op.path === (failure === 'file sync' ? path : failure === 'directory sync' ? dir : '')
      if (!failed && match) { failed = true; return true }
      return false
    }
    if (failure === 'zero write' || failure === 'negative write') r.control.maxChunk = failure === 'zero write' ? 0 : -1
    expect(() => j.durableAppend(path, Buffer.from('failed\n'), rollback)).toThrow()
    expect(read()).toEqual(old)
    expect(rollback.pendingRollback).toBeUndefined()
    r.control.fail = () => false; r.control.maxChunk = 2
    j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old without newline\nretry\n'))
    expect(r.paths.size).toBe(0)
  })

  test.each(['truncate', 'sync'] as const)('keeps the original rollback through repeated %s failures, then reconciles without append', failure => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}, old = Buffer.from('old\n')
    seed(old); j.ensureDir()
    r.control.fail = op => (op.step === 'sync' || op.step === 'truncate') && op.path === path
    expect(() => j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).toThrow()
    expect(read()).toEqual(Buffer.from('old\nunaccepted\n'))
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = op => op.path === path && op.step === failure
    expect(() => j.durableAppend(path, Buffer.from('also unaccepted\n'), rollback)).toThrow()
    expect(rollback.pendingRollback).toBe(old.length)
    expect(() => j.reconcileRollback(path, rollback)).toThrow()
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = () => false; r.ops.length = 0
    j.reconcileRollback(path, rollback)
    expect(read()).toEqual(old)
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.ops.filter(op => op.step === 'sync').map(op => op.path)).toEqual([path])
    j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(r.paths.size).toBe(0)
  })

  test('the next append reconciles a failed rollback before any new byte is written', () => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    seed('old\n'); j.ensureDir()
    r.control.fail = op => op.path === path && ['sync', 'truncate'].includes(op.step)
    expect(() => j.durableAppend(path, Buffer.from('unaccepted\n'), rollback)).toThrow()
    r.control.fail = () => false; r.ops.length = 0
    r.control.before = op => { if (op.step === 'write') expect(read()).toEqual(Buffer.from('old\n')) }
    j.durableAppend(path, Buffer.from('retry\n'), rollback)
    expect(read()).toEqual(Buffer.from('old\nretry\n'))
    expect(rollback.pendingRollback).toBeUndefined()
    expect(r.ops.filter(op => ['truncate', 'write', 'sync'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([['truncate', path], ['sync', path], ['write', path], ['sync', path], ['sync', dir]])
  })

  test('reconciling with nothing pending performs no I/O', () => {
    const r = recordingFs()
    journal(r.fs).reconcileRollback(path, {})
    expect(r.ops).toEqual([])
  })
})

describe('Thread Memory torn-tail removal', () => {
  test.each(['append', 'reconcile'] as const)('%s removes a quarantined partial multibyte character and retries failed truncation', operation => {
    const r = recordingFs(), j = journal(r.fs), rollback: AppendRollback = {}
    const old = Buffer.from('saved é\n'), fragment = Buffer.from([0x7b, 0x22, 0xe2, 0x82])
    seed(Buffer.concat([old, fragment])); j.ensureDir()
    const tail = splitJournalLines(read()).at(-1)!
    const quarantine = join(dir, 'alpha.unreadable')
    fs.writeFileSync(quarantine, tail.bytes, { mode: 0o600 })
    removeTornTail(rollback, tail)
    expect(read()).toEqual(Buffer.concat([old, fragment]))
    expect(rollback.pendingRollback).toBe(old.length)
    const act = () => operation === 'append' ? j.durableAppend(path, Buffer.from('new\n'), rollback) : j.reconcileRollback(path, rollback)
    r.control.fail = op => op.step === 'truncate'
    expect(act).toThrow('EIO injected truncate')
    expect(read()).toEqual(Buffer.concat([old, fragment]))
    expect(rollback.pendingRollback).toBe(old.length)
    r.control.fail = () => false
    act()
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
  test('uses unique exclusive mode-0600 temps, short writes and fsync before rename, then directory fsync', () => {
    const r = recordingFs(), j = journal(r.fs), old = Buffer.from('old longer record\n'), next = Buffer.from('é🙂\n')
    seed(old); j.ensureDir(); r.ops.length = 0; r.control.maxChunk = 2
    r.control.before = op => { if (op.step === 'rename') expect(read()).toEqual(old) }
    j.rewrite(path, next)
    expect(read()).toEqual(next)
    expect(fs.statSync(path).mode & 0o7777).toBe(0o600)
    const first = r.ops.find(op => op.step === 'open' && op.flags === 'wx')!
    expect(first.path.startsWith(`${path}.`)).toBe(true)
    expect(first.path.endsWith('.tmp')).toBe(true)
    expect(first.mode).toBe(0o600)
    expect(r.ops.filter(op => ['sync', 'rename'].includes(op.step)).map(op => [op.step, op.path]))
      .toEqual([['sync', first.path], ['rename', first.path], ['sync', dir]])
    r.control.before = () => {}; r.ops.length = 0
    j.rewrite(path, Buffer.from('again\n'))
    expect(r.ops.find(op => op.step === 'open' && op.flags === 'wx')!.path).not.toBe(first.path)
    expect(read()).toEqual(Buffer.from('again\n'))
    expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    expect(r.paths.size).toBe(0)
  })

  test.each(['open-temp', 'partial-write', 'sync-temp', 'close-temp', 'rename', 'open-directory', 'sync-directory', 'close-directory'] as const)(
    '%s failure cleans the temp; only post-rename failures leave replacement bytes visible', failure => {
      const r = recordingFs(), j = journal(r.fs), old = Buffer.from('old longer record\n'), next = Buffer.from('new\n')
      seed(old); j.ensureDir(); r.control.maxChunk = 2
      r.control.fail = op => {
        const temp = op.path.endsWith('.tmp')
        if (failure === 'partial-write') return op.step === 'write' && fs.statSync(op.path).size > 0
        if (failure === 'rename') return op.step === 'rename'
        const [step, target] = failure.split('-')
        return op.step === step && (target === 'temp' ? temp : op.path === dir)
      }
      expect(() => j.rewrite(path, next)).toThrow('EIO injected')
      expect(read()).toEqual(failure.endsWith('-directory') ? next : old)
      expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
      expect(r.paths.size).toBe(0)
      r.control.fail = () => false
      j.rewrite(path, next)
      expect(read()).toEqual(next)
      expect(fs.readdirSync(dir)).toEqual(['alpha.jsonl'])
    },
  )
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
