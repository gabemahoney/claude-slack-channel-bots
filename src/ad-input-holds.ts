/** Durable facts about CSCB's manual control input. No agent-state inference. */
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { mkdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, fsyncSync, constants } from 'node:fs'
import { durableWriteFileSync, durableUnlinkSync } from './atomic-write.ts'
import type { SubmissionUnconfirmedFacts } from './ad-error-class.ts'
import { parseLaunchStart } from './pending-row.ts'
import { personaInstanceId } from './persona-identity.ts'

export interface AdInputBinding { readonly instanceId: string; readonly rowStartedAt: string; readonly sessionId: string; readonly launchStartedAt: string | null }
export type AdInputHoldStep = 'text-intent' | 'text-ready' | 'enter-intent' | 'uncertain'
export interface AdInputHoldRecord {
  readonly v: 1; readonly key: string; readonly revision: number; readonly binding: AdInputBinding
  readonly step: AdInputHoldStep; readonly recordedAt: number; readonly outcome: SubmissionUnconfirmedFacts['kind'] | null
}
export type AdInputHoldCode = 'INPUT_HOLD_UNREADABLE' | 'INPUT_HOLD_INVALID' | 'INPUT_HOLD_WRITE_FAILED' | 'INPUT_HOLD_CLEAR_FAILED' | 'INPUT_HOLD_STALE'
export type AdInputHoldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AdInputHoldCode }
export type AdInputHoldReading = { readonly kind: 'clear' } | { readonly kind: 'record'; readonly record: AdInputHoldRecord } | { readonly kind: 'blocked'; readonly code: AdInputHoldCode }
export interface AdInputHoldIo { read(path: string): Uint8Array | null; write(path: string, bytes: Uint8Array): void; remove(path: string): void }
export interface AdInputLaunchObservation { readonly instanceId: string; readonly state: string; readonly rowStartedAt: string; readonly sessionId: string; readonly launchStartedAt?: string | null }
export interface AdInputHoldStore {
  path(key: string): string; load(key: string): AdInputHoldReading; get(key: string): AdInputHoldReading
  begin(key: string, binding: AdInputBinding): AdInputHoldResult<AdInputHoldRecord>
  advance(key: string, expectedRevision: number, step: 'text-ready' | 'enter-intent' | 'uncertain', outcome?: SubmissionUnconfirmedFacts['kind']): AdInputHoldResult<AdInputHoldRecord>
  clear(key: string, expectedRevision: number): AdInputHoldResult<void>
  observeLaunch(key: string, row: AdInputLaunchObservation): AdInputHoldResult<'kept' | 'cleared'>
}
export const AD_INPUT_HOLD_MAX_BYTES = 16_384
const OUTCOMES = ['not_started', 'partial_input_unconfirmed', 'submission_unconfirmed', 'legacy_unconfirmed', 'gateway_refused', 'unknown']
const ownFields = (value: object, fields: readonly string[]): boolean => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
export function adInputHoldPath(stateDir: string, key: string): string { return join(resolve(stateDir), 'ad-input-holds', `${createHash('sha256').update(key).digest('hex')}.json`) }
function valid(value: unknown, key: string): value is AdInputHoldRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as AdInputHoldRecord, b = r.binding
  return ownFields(r, ['v', 'key', 'revision', 'binding', 'step', 'recordedAt', 'outcome']) && r.v === 1 && r.key === key && Number.isSafeInteger(r.revision) && r.revision > 0 &&
    !!b && typeof b === 'object' && !Array.isArray(b) && ownFields(b, ['instanceId', 'rowStartedAt', 'sessionId', 'launchStartedAt']) && b.instanceId === personaInstanceId(key) && parseLaunchStart(b.rowStartedAt) !== undefined && typeof b.sessionId === 'string' &&
    (b.launchStartedAt === null || parseLaunchStart(b.launchStartedAt) !== undefined) &&
    ['text-intent', 'text-ready', 'enter-intent', 'uncertain'].includes(r.step) && typeof r.recordedAt === 'number' && Number.isFinite(r.recordedAt) && r.recordedAt >= 0 &&
    (r.step === 'uncertain' ? r.outcome !== null && r.outcome !== 'not_started' && OUTCOMES.includes(r.outcome) : r.outcome === null)
}
export function createAdInputHoldStore(options: { readonly stateDir: string; readonly now: () => number; readonly io: AdInputHoldIo }): AdInputHoldStore {
  const states = new Map<string, AdInputHoldReading>(), revisions = new Map<string, number>()
  const path = (key: string) => adInputHoldPath(options.stateDir, key)
  const get = (key: string): AdInputHoldReading => states.get(key) ?? { kind: 'blocked', code: 'INPUT_HOLD_UNREADABLE' }
  const blocked = (key: string, code: AdInputHoldCode): AdInputHoldResult<never> => { states.set(key, { kind: 'blocked', code }); return { ok: false, code } }
  function write(key: string, record: AdInputHoldRecord): AdInputHoldResult<AdInputHoldRecord> {
    states.set(key, { kind: 'record', record }); revisions.set(key, record.revision)
    try { options.io.write(path(key), new TextEncoder().encode(JSON.stringify(record) + '\n')); return { ok: true, value: record } }
    catch { return blocked(key, 'INPUT_HOLD_WRITE_FAILED') }
  }
  const store: AdInputHoldStore = {
    path, get,
    load(key) {
      try {
        const bytes = options.io.read(path(key))
        if (bytes === null) { const state = { kind: 'clear' } as const; states.set(key, state); return state }
        let record: unknown
        try { if (bytes.length > AD_INPUT_HOLD_MAX_BYTES) throw new Error(); record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
        catch { blocked(key, 'INPUT_HOLD_INVALID'); return get(key) }
        if (!valid(record, key)) { blocked(key, 'INPUT_HOLD_INVALID'); return get(key) }
        states.set(key, { kind: 'record', record }); revisions.set(key, record.revision)
        return get(key)
      } catch { blocked(key, 'INPUT_HOLD_UNREADABLE'); return get(key) }
    },
    begin(key, binding) {
      if (get(key).kind !== 'clear') return { ok: false, code: 'INPUT_HOLD_STALE' }
      const record: AdInputHoldRecord = { v: 1, key, revision: (revisions.get(key) ?? 0) + 1, binding: { ...binding }, step: 'text-intent', recordedAt: options.now(), outcome: null }
      if (!valid(record, key)) return blocked(key, 'INPUT_HOLD_INVALID')
      return write(key, record)
    },
    advance(key, expectedRevision, step, outcome) {
      const current = get(key)
      if (current.kind !== 'record' || current.record.revision !== expectedRevision) return { ok: false, code: 'INPUT_HOLD_STALE' }
      if (current.record.step === 'uncertain' && step !== 'uncertain') return { ok: false, code: 'INPUT_HOLD_STALE' }
      const record: AdInputHoldRecord = { ...current.record, revision: expectedRevision + 1, step, outcome: outcome ?? null }
      if (!valid(record, key)) return blocked(key, 'INPUT_HOLD_INVALID')
      return write(key, record)
    },
    clear(key, expectedRevision) {
      const current = get(key)
      if (current.kind !== 'record' || current.record.revision !== expectedRevision) return { ok: false, code: 'INPUT_HOLD_STALE' }
      try { options.io.remove(path(key)); states.set(key, { kind: 'clear' }); return { ok: true, value: undefined } }
      catch { return blocked(key, 'INPUT_HOLD_CLEAR_FAILED') }
    },
    observeLaunch(key, row) {
      const current = get(key)
      if (current.kind !== 'record') return { ok: true, value: 'kept' }
      const { record } = current, b = record.binding
      const rowStart = parseLaunchStart(row.rowStartedAt)
      const launchStart = parseLaunchStart(row.launchStartedAt)
      if (row.instanceId !== b.instanceId || rowStart === undefined ||
          (row.launchStartedAt != null && launchStart === undefined)) return { ok: true, value: 'kept' }
      const replacement = rowStart !== parseLaunchStart(b.rowStartedAt)
      const priorLaunchStart = parseLaunchStart(b.launchStartedAt)
      const launch = row.state === 'pending' && launchStart !== undefined &&
        (priorLaunchStart !== undefined ? launchStart !== priorLaunchStart : launchStart > record.recordedAt)
      if (!replacement && !launch) return { ok: true, value: 'kept' }
      const result = store.clear(key, record.revision)
      return result.ok ? { ok: true, value: 'cleared' } : result
    },
  }
  return store
}

/** Bounded, no-follow descriptor reads; nonblocking open rejects special files. */
export function createAdInputHoldIo(): AdInputHoldIo {
  return {
    read(path) {
      let fd: number
      try {
        const parent = lstatSync(dirname(path))
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid hold directory')
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > AD_INPUT_HOLD_MAX_BYTES) throw new Error('Invalid input hold')
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Input hold unreadable') }
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > AD_INPUT_HOLD_MAX_BYTES) throw new Error('Input hold invalid')
        const bytes = new Uint8Array(AD_INPUT_HOLD_MAX_BYTES + 1)
        let offset = 0
        while (offset < bytes.length) { const size = readSync(fd, bytes, offset, bytes.length - offset, null); if (!size) break; offset += size }
        if (offset > AD_INPUT_HOLD_MAX_BYTES) throw new Error('Input hold oversized')
        return bytes.slice(0, offset)
      } finally { closeSync(fd) }
    },
    write(path, bytes) {
      if (bytes.length > AD_INPUT_HOLD_MAX_BYTES) throw new Error('Input hold oversized')
      const directory = dirname(path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const parent = lstatSync(directory)
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid hold directory')
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid hold file')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      // Persist the hold directory's own entry before permitting any input.
      // Sync it on retries too: a prior mkdir may have succeeded before fsync failed.
      const fd = openSync(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(fd) } finally { closeSync(fd) }
      durableWriteFileSync(path, bytes)
    },
    remove(path) {
      try {
        const parent = lstatSync(dirname(path))
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid hold directory')
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid hold file')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      durableUnlinkSync(path)
    },
  }
}
