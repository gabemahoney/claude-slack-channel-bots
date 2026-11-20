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
  readonly finished?: true
  readonly delivery?: { readonly seq: number; readonly part: number; readonly attempt: number }
}
export type AdInputHoldCode = 'INPUT_HOLD_UNREADABLE' | 'INPUT_HOLD_INVALID' | 'INPUT_HOLD_WRITE_FAILED' | 'INPUT_HOLD_CLEAR_FAILED' | 'INPUT_HOLD_STALE'
export type AdInputHoldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AdInputHoldCode }
export type AdInputHoldReading = { readonly kind: 'clear' } | { readonly kind: 'record'; readonly record: AdInputHoldRecord } | { readonly kind: 'blocked'; readonly code: AdInputHoldCode }
export interface AdInputHoldIo { read(path: string): Uint8Array | null; write(path: string, bytes: Uint8Array): void; remove(path: string): void }
export interface AdInputLaunchObservation { readonly instanceId: string; readonly state: string; readonly rowStartedAt: string; readonly sessionId: string; readonly launchStartedAt?: string | null }
/** Status can record a finished observation, but cannot prove a new launch. */
export type AdInputObservation = AdInputLaunchObservation | { readonly state: string }
export interface AdInputHoldStore {
  path(key: string): string; load(key: string): AdInputHoldReading; get(key: string): AdInputHoldReading
  releasedDelivery(key: string): AdInputHoldRecord['delivery']
  begin(key: string, binding: AdInputBinding): AdInputHoldResult<AdInputHoldRecord>
  markUncertain(key: string, binding: AdInputBinding, outcome: SubmissionUnconfirmedFacts['kind'], delivery?: AdInputHoldRecord['delivery']): AdInputHoldResult<AdInputHoldRecord>
  advance(key: string, expectedRevision: number, step: 'text-ready' | 'enter-intent' | 'uncertain', outcome?: SubmissionUnconfirmedFacts['kind']): AdInputHoldResult<AdInputHoldRecord>
  clear(key: string, expectedRevision: number): AdInputHoldResult<void>
  observeLaunch(key: string, row: AdInputObservation, beforeRead?: AdInputHoldReading): AdInputHoldResult<'kept' | 'cleared'>
}
export const AD_INPUT_HOLD_MAX_BYTES = 16_384
const OUTCOMES = ['not_started', 'partial_input_unconfirmed', 'submission_unconfirmed', 'legacy_unconfirmed', 'gateway_refused', 'unknown']
const ownFields = (value: object, fields: readonly string[]): boolean => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
export function adInputHoldPath(stateDir: string, key: string): string { return join(resolve(stateDir), 'ad-input-holds', `${createHash('sha256').update(key).digest('hex')}.json`) }
function valid(value: unknown, key: string): value is AdInputHoldRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as AdInputHoldRecord, b = r.binding
  const fields = ['v', 'key', 'revision', 'binding', 'step', 'recordedAt', 'outcome', ...(Object.hasOwn(r, 'finished') ? ['finished'] : []), ...(Object.hasOwn(r, 'delivery') ? ['delivery'] : [])]
  return ownFields(r, fields) && (r.finished === undefined || r.finished === true) &&
    (r.delivery === undefined || (!!r.delivery && typeof r.delivery === 'object' && ownFields(r.delivery, ['seq', 'part', 'attempt']) && Object.values(r.delivery).every(n => Number.isSafeInteger(n) && n > 0))) &&
    r.v === 1 && r.key === key && Number.isSafeInteger(r.revision) && r.revision > 0 &&
    !!b && typeof b === 'object' && !Array.isArray(b) && ownFields(b, ['instanceId', 'rowStartedAt', 'sessionId', 'launchStartedAt']) && b.instanceId === personaInstanceId(key) && parseLaunchStart(b.rowStartedAt) !== undefined && typeof b.sessionId === 'string' &&
    (b.launchStartedAt === null || parseLaunchStart(b.launchStartedAt) !== undefined) &&
    ['text-intent', 'text-ready', 'enter-intent', 'uncertain'].includes(r.step) && typeof r.recordedAt === 'number' && Number.isFinite(r.recordedAt) && r.recordedAt >= 0 &&
    (r.step === 'uncertain' ? r.outcome !== null && r.outcome !== 'not_started' && OUTCOMES.includes(r.outcome) : r.outcome === null)
}
interface DeliveryInputRelease { readonly hold: AdInputHoldRecord; readonly row: AdInputLaunchObservation }
function provesNewLaunch(record: AdInputHoldRecord, row: AdInputLaunchObservation): boolean {
  const b = record.binding, rowStart = parseLaunchStart(row.rowStartedAt), launchStart = parseLaunchStart(row.launchStartedAt)
  if (row.instanceId !== b.instanceId || rowStart === undefined || typeof row.sessionId !== 'string' ||
      (row.launchStartedAt != null && launchStart === undefined) || !['pending', 'waiting', 'working', 'ask_user', 'check_permission'].includes(row.state)) return false
  const prior = parseLaunchStart(b.launchStartedAt)
  return record.finished === true || rowStart !== parseLaunchStart(b.rowStartedAt) || (row.sessionId !== '' && row.sessionId !== b.sessionId) ||
    (row.state === 'pending' && launchStart !== undefined && (prior !== undefined ? launchStart !== prior : launchStart > record.recordedAt))
}
function validRelease(value: unknown, key: string): value is DeliveryInputRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ownFields(value, ['hold', 'row'])) return false
  const proof = value as DeliveryInputRelease, row = proof.row
  return valid(proof.hold, key) && proof.hold.step === 'uncertain' && !!proof.hold.delivery &&
    !!row && typeof row === 'object' && !Array.isArray(row) &&
    ownFields(row, ['instanceId', 'state', 'rowStartedAt', 'sessionId', ...(Object.hasOwn(row, 'launchStartedAt') ? ['launchStartedAt'] : [])]) &&
    provesNewLaunch(proof.hold, row)
}
export function createAdInputHoldStore(options: { readonly stateDir: string; readonly now: () => number; readonly io: AdInputHoldIo }): AdInputHoldStore {
  const states = new Map<string, AdInputHoldReading>(), revisions = new Map<string, number>()
  const releases = new Map<string, DeliveryInputRelease>()
  const path = (key: string) => adInputHoldPath(options.stateDir, key)
  const get = (key: string): AdInputHoldReading => states.get(key) ?? { kind: 'blocked', code: 'INPUT_HOLD_UNREADABLE' }
  const blocked = (key: string, code: AdInputHoldCode): AdInputHoldResult<never> => { states.set(key, { kind: 'blocked', code }); return { ok: false, code } }
  function write(key: string, record: AdInputHoldRecord): AdInputHoldResult<AdInputHoldRecord> {
    states.set(key, { kind: 'record', record }); revisions.set(key, record.revision)
    try { options.io.write(path(key), new TextEncoder().encode(JSON.stringify(record) + '\n')); return { ok: true, value: record } }
    catch { return blocked(key, 'INPUT_HOLD_WRITE_FAILED') }
  }
  const store: AdInputHoldStore = {
    path, get, releasedDelivery: key => releases.get(key)?.hold.delivery,
    load(key) {
      try {
        // A delivery release is written before unlinking its hold, because a
        // shared session-manager read may observe the launch before the queue
        // engine does. Keep this exact-attempt proof across CSCB restarts.
        releases.delete(key)
        try {
          const released = options.io.read(`${path(key)}.released`)
          if (released !== null && released.length <= AD_INPUT_HOLD_MAX_BYTES) {
            const proof: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(released))
            if (validRelease(proof, key)) releases.set(key, proof)
          }
        } catch { /* Unusable release evidence never releases queued custody. */ }
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
    markUncertain(key, binding, outcome, delivery) {
      const current = get(key)
      // A concurrent/newer control record must never be overwritten by a
      // delayed delivery response. It already holds this persona closed.
      if (current.kind !== 'clear') return { ok: false, code: 'INPUT_HOLD_STALE' }
      const record: AdInputHoldRecord = { v: 1, key, revision: (revisions.get(key) ?? 0) + 1, binding: { ...binding },
        step: 'uncertain', recordedAt: options.now(), outcome, ...(delivery ? { delivery: { ...delivery } } : {}) }
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
    observeLaunch(key, row, beforeRead = get(key)) {
      const current = get(key)
      // Capture before starting an awaited AD read. Object identity also
      // rejects a reload/replacement and a finished fact saved during it.
      // An omitted snapshot is only for an immediate, synchronous observation.
      if (current.kind !== 'record' || beforeRead.kind !== 'record' || current.record !== beforeRead.record) return { ok: true, value: 'kept' }
      const { record } = current, b = record.binding
      if ('instanceId' in row && (row.instanceId !== b.instanceId || parseLaunchStart(row.rowStartedAt) === undefined ||
          (row.launchStartedAt != null && parseLaunchStart(row.launchStartedAt) === undefined))) return { ok: true, value: 'kept' }
      if (row.state === 'ended' || row.state === 'missing') {
        if (!record.finished) {
          const saved = write(key, { ...record, revision: record.revision + 1, finished: true })
          if (!saved.ok) return saved
        }
        return { ok: true, value: 'kept' }
      }
      if (!('instanceId' in row) || !provesNewLaunch(record, row)) return { ok: true, value: 'kept' }
      if (record.delivery) {
        const proof: DeliveryInputRelease = { hold: record, row: { ...row } }
        try { options.io.write(`${path(key)}.released`, new TextEncoder().encode(JSON.stringify(proof) + '\n')); releases.set(key, proof) }
        catch { return blocked(key, 'INPUT_HOLD_WRITE_FAILED') }
      }
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
