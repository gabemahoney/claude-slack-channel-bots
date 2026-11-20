import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AD_INPUT_HOLD_MAX_BYTES, createAdInputHoldIo, createAdInputHoldStore, type AdInputHoldRecord, type AdInputHoldResult } from '../src/ad-input-holds.ts'
import { inputBinding } from './test-helpers/ad-input-holds.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeFifo, mkfifoAvailable, MKFIFO_TIMEOUT_MS } from './test-helpers/fifo.ts'
import { runInFakeHome, type FakeHomeRunResult } from './test-helpers/fake-home-subprocess.ts'

const FIFO_CHILD_TIMEOUT_MS = 2_000
// Allow the mkfifo bound, the reader child's bound and 5 s for startup/cleanup.
const FIFO_TEST_TIMEOUT_MS = MKFIFO_TIMEOUT_MS + FIFO_CHILD_TIMEOUT_MS + 5_000

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ad-input-real-io-')); roots.push(root)
  const io = createAdInputHoldIo(), now = () => Date.parse('2026-11-20T02:00:00Z')
  const fresh = () => createAdInputHoldStore({ stateDir: root, now, io })
  const store = fresh()
  expect(store.load('alpha')).toEqual({ kind: 'clear' })
  return { root, io, store, fresh }
}
function record(result: AdInputHoldResult<AdInputHoldRecord>): AdInputHoldRecord {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result.value
}

test('production IO saves a regular hold, reloads it and durably deletes only that persona', () => {
  const f = fixture(), first = record(f.store.begin('alpha', inputBinding()))
  f.store.load('beta')
  const sibling = record(f.store.begin('beta', inputBinding({ instanceId: 'cscb_beta' })))
  expect(lstatSync(f.store.path('alpha')).isFile()).toBe(true)
  expect(f.fresh().load('alpha')).toEqual({ kind: 'record', record: first })
  expect(f.store.clear('alpha', first.revision)).toEqual({ ok: true, value: undefined })
  expect(existsSync(f.store.path('alpha'))).toBe(false)
  expect(f.io.read(f.store.path('alpha'))).toBeNull()
  expect(f.fresh().load('alpha')).toEqual({ kind: 'clear' })
  expect(f.fresh().load('beta')).toEqual({ kind: 'record', record: sibling })
  expect(() => f.io.remove(f.store.path('alpha'))).not.toThrow()
  assertNoLeak([first, sibling, f.store.get('alpha')])
})

test.each(['symlink', 'directory'] as const)('production IO rejects a %s without reading, replacing or deleting it', kind => {
  const f = fixture(), path = f.store.path('alpha'), other = join(f.root, 'other.json')
  mkdirSync(dirname(path), { recursive: true })
  const original = JSON.stringify({ private_text: sentinelInMessage('hold-special-target') })
  writeFileSync(other, original)
  if (kind === 'symlink') symlinkSync(other, path)
  if (kind === 'directory') mkdirSync(path)
  expect(() => f.io.read(path)).toThrow()
  expect(() => f.io.write(path, new TextEncoder().encode('{}'))).toThrow()
  expect(() => f.io.remove(path)).toThrow()
  const reading = f.fresh().load('alpha')
  expect(reading).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_UNREADABLE' })
  expect(lstatSync(path).isSymbolicLink()).toBe(kind === 'symlink')
  expect(lstatSync(path).isDirectory()).toBe(kind === 'directory')
  expect(lstatSync(path).isFIFO()).toBe(false)
  expect(readFileSync(other, 'utf8')).toBe(original)
  assertNoLeak(reading)
})

test.skipIf(!mkfifoAvailable())('production IO rejects a FIFO in a bounded child (requires mkfifo)', () => {
  const f = fixture(), path = f.store.path('alpha'), other = join(f.root, 'other.json')
  mkdirSync(dirname(path), { recursive: true })
  const original = JSON.stringify({ private_text: sentinelInMessage('hold-special-target') })
  writeFileSync(other, original)
  makeFifo(path)
  expect(lstatSync(path).isFIFO()).toBe(true)
  let child!: FakeHomeRunResult
  // runInFakeHome throws on a timeout or signal; this assertion rules out a
  // blocking reader being mistaken for successful regular-file rejection.
  expect(() => { child = runInFakeHome({
    home: f.root, stateDir: f.root, tools: [], timeoutMs: FIFO_CHILD_TIMEOUT_MS,
    modulePath: join(import.meta.dir, '../src/ad-input-holds.ts'), input: { root: f.root, path },
    call: `
      const io = mod.createAdInputHoldIo();
      const rejects = action => { try { action(); return false } catch { return true } };
      const readRejected = rejects(() => io.read(input.path));
      const writeRejected = rejects(() => io.write(input.path, new TextEncoder().encode('{}')));
      const removeRejected = rejects(() => io.remove(input.path));
      const reading = mod.createAdInputHoldStore({ stateDir: input.root, now: () => 0, io }).load('alpha');
      console.log(JSON.stringify({ readRejected, writeRejected, removeRejected, reading }));
    `,
  }) }).not.toThrow()
  expect(child.observedHomedir).toBe(f.root)
  expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  expect(JSON.parse(child.payloadStdout)).toEqual({ readRejected: true, writeRejected: true, removeRejected: true,
    reading: { kind: 'blocked', code: 'INPUT_HOLD_UNREADABLE' } })
  expect(lstatSync(path).isSymbolicLink()).toBe(false)
  expect(lstatSync(path).isDirectory()).toBe(false)
  expect(lstatSync(path).isFIFO()).toBe(true)
  expect(readFileSync(other, 'utf8')).toBe(original)
  assertNoLeak(child)
}, FIFO_TEST_TIMEOUT_MS)

test('production IO enforces the read and write byte bound', () => {
  const f = fixture(), path = f.store.path('alpha')
  mkdirSync(dirname(path), { recursive: true })
  const limit = new Uint8Array(AD_INPUT_HOLD_MAX_BYTES).fill(32)
  writeFileSync(path, limit)
  expect(f.io.read(path)).toEqual(limit)
  const oversized = new Uint8Array(AD_INPUT_HOLD_MAX_BYTES + 1).fill(32)
  writeFileSync(path, oversized)
  expect(() => f.io.read(path)).toThrow()
  expect(() => f.io.write(path, oversized)).toThrow()
  expect(readFileSync(path)).toEqual(Buffer.from(oversized))
  const reading = f.fresh().load('alpha')
  expect(reading).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_UNREADABLE' })
  assertNoLeak(reading)
})

test('production IO rejects a symlinked hold directory', () => {
  const f = fixture(), path = f.store.path('alpha'), target = join(f.root, 'target')
  mkdirSync(target)
  symlinkSync(target, dirname(path))
  expect(() => f.io.read(path)).toThrow()
  expect(() => f.io.write(path, new Uint8Array())).toThrow()
  expect(() => f.io.remove(path)).toThrow()
  expect(readdirSync(target)).toEqual([])
  assertNoLeak(f.fresh().load('alpha'))
})

test.each(['malformed UTF-8', 'truncated JSON', 'trailing JSON', 'top-level content', 'binding content', 'uncertain without outcome', 'ready with outcome', 'unsafe revision', 'fractional revision'] as const)('%s fails closed in the production reader/store', fault => {
  const f = fixture(), valid = record(f.store.begin('alpha', inputBinding()))
  let bytes = Buffer.from(JSON.stringify(valid))
  if (fault === 'malformed UTF-8') {
    // Invalid bytes inside an otherwise valid string distinguish fatal UTF-8
    // decoding from replacement-character decoding followed by valid JSON.
    const offset = bytes.indexOf(valid.binding.sessionId)
    expect(offset).toBeGreaterThan(0)
    bytes[offset] = 0xff
  }
  if (fault === 'truncated JSON') bytes = bytes.subarray(0, bytes.length - 1)
  if (fault === 'trailing JSON') bytes = Buffer.concat([bytes, Buffer.from('{}')])
  if (fault === 'top-level content') bytes = Buffer.from(JSON.stringify({ ...valid, private_text: sentinelInMessage('hold-schema-body') }))
  if (fault === 'binding content') bytes = Buffer.from(JSON.stringify({ ...valid, binding: { ...valid.binding, private_text: sentinelInMessage('hold-binding-body') } }))
  if (fault === 'uncertain without outcome') bytes = Buffer.from(JSON.stringify({ ...valid, step: 'uncertain', outcome: null }))
  if (fault === 'ready with outcome') bytes = Buffer.from(JSON.stringify({ ...valid, step: 'text-ready', outcome: 'submission_unconfirmed' }))
  if (fault === 'unsafe revision') bytes = Buffer.from(JSON.stringify({ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }))
  if (fault === 'fractional revision') bytes = Buffer.from(JSON.stringify({ ...valid, revision: 1.5 }))
  writeFileSync(f.store.path('alpha'), bytes)
  const reading = f.fresh().load('alpha')
  expect(reading).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_INVALID' })
  assertNoLeak(reading)
})

test.each(['advance', 'begin after clear'] as const)('%s cannot overflow a maximum safe revision', operation => {
  const f = fixture(), valid = record(f.store.begin('alpha', inputBinding()))
  const boundary = { ...valid, revision: Number.MAX_SAFE_INTEGER }
  writeFileSync(f.store.path('alpha'), JSON.stringify(boundary))
  const reopened = f.fresh()
  expect(reopened.load('alpha')).toEqual({ kind: 'record', record: boundary })
  if (operation === 'begin after clear') expect(reopened.clear('alpha', boundary.revision).ok).toBe(true)
  const result = operation === 'advance' ? reopened.advance('alpha', boundary.revision, 'text-ready') : reopened.begin('alpha', inputBinding())
  expect(result).toEqual({ ok: false, code: 'INPUT_HOLD_INVALID' })
  expect(reopened.get('alpha')).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_INVALID' })
  assertNoLeak([result, reopened.get('alpha')])
})

test.each(['text-ready', 'enter-intent'] as const)('current-revision uncertainty cannot become %s', step => {
  const f = fixture(), initial = record(f.store.begin('alpha', inputBinding()))
  const uncertain = record(f.store.advance('alpha', initial.revision, 'uncertain', 'submission_unconfirmed'))
  const before = readFileSync(f.store.path('alpha'))
  expect(f.store.advance('alpha', uncertain.revision, step)).toEqual({ ok: false, code: 'INPUT_HOLD_STALE' })
  expect(f.store.get('alpha')).toEqual({ kind: 'record', record: uncertain })
  expect(readFileSync(f.store.path('alpha'))).toEqual(before)
  expect(f.fresh().load('alpha')).toEqual({ kind: 'record', record: uncertain })
  assertNoLeak(uncertain)
})
