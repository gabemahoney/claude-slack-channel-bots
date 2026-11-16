/** Bounded recovery grammar and evidence in the existing shared authority.
 * No snapshot-import path: restoration requires the running owner's anchor.
 * A staged record keeps every byte its review, revision and activation read;
 * activation reduces it to its identity. */
import { createHash } from 'node:crypto'
import { REVIEW_ID_RE, REVIEW_REQUEST_FORMAT } from './reload-request.ts'

export type SharedRecoveryRequest = {
  format: typeof REVIEW_REQUEST_FORMAT
  request_id: string
  evidence_sha256: string
} & (
  | { action: 'restore' }
  | { action: 'replace'; replacement_source_base64: string }
)
/** What an activated recovery keeps of its request: never a replacement's
 * configuration. A replacement identity lacks the replacement input, so it is
 * never a valid operator request; a restore identity has the full restore
 * request's shape. */
export interface SharedRecoveryIdentity {
  format: typeof REVIEW_REQUEST_FORMAT
  action: SharedRecoveryRequest['action']
  request_id: string
  evidence_sha256: string
}
interface StagedSharedRecovery {
  boundary: string
  phase: 'review'
  request: SharedRecoveryRequest
  /** Exact damaged bytes and separately prepared input, never printed. */
  evidenceBase64: string
  preparedBase64: string
  /** Cold proposals stay inert after cancellation, including request replay. */
  cancelled?: true
  /** A previously superseded request ID can never propose another revision. */
  supersededRequestIds?: string[]
  /** The owner's last validated proposal, not an operator-supplied snapshot. */
  anchorBase64?: string
}
/** Nothing after activation reads the stage's bytes or request history, so an
 * activated repair is a fixed-size record later applications rewrite as is. */
interface ActiveSharedRecovery {
  boundary: string
  phase: 'active'
  request: SharedRecoveryIdentity
  activation: { fingerprint: string; order: number }
}
export type SharedRecoveryRecord = StagedSharedRecovery | ActiveSharedRecovery
const HASH = /^[a-f0-9]{64}$/
const IDENTITY_FIELDS = ['format', 'request_id', 'evidence_sha256', 'action']
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function fields(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort())
}
export function recoveryHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function recoveryBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : undefined
}
/** The grammar a request and an activated identity share. */
function validIdentity(value: Record<string, unknown>): boolean {
  return value['format'] === REVIEW_REQUEST_FORMAT &&
    typeof value['request_id'] === 'string' && REVIEW_ID_RE.test(value['request_id']) &&
    typeof value['evidence_sha256'] === 'string' && HASH.test(value['evidence_sha256']) &&
    (value['action'] === 'restore' || value['action'] === 'replace')
}
export function parseSharedRecoveryRequest(value: unknown): SharedRecoveryRequest | undefined {
  if (!object(value) || !validIdentity(value)) return undefined
  const replacement = value['action'] === 'replace'
  if (!fields(value, [...IDENTITY_FIELDS, ...(replacement ? ['replacement_source_base64'] : [])]) ||
      (replacement && !recoveryBytes(value['replacement_source_base64']))) return undefined
  return structuredClone(value) as SharedRecoveryRequest
}
export function readSharedRecoveryRequest(bytes: Uint8Array): SharedRecoveryRequest | undefined {
  try { return parseSharedRecoveryRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { return undefined }
}
/** The identity activation keeps, selected field by field. */
export function recoveryIdentity(request: SharedRecoveryRequest): SharedRecoveryIdentity {
  return { format: request.format, action: request.action, request_id: request.request_id, evidence_sha256: request.evidence_sha256 }
}
export function validateSharedRecovery(value: unknown): asserts value is SharedRecoveryRecord {
  if (!object(value) || typeof value['boundary'] !== 'string' || !REVIEW_ID_RE.test(value['boundary']) ||
      !['review', 'active'].includes(value['phase'] as string)) throw new Error('Invalid shared recovery boundary.')
  if (value['phase'] === 'active') validateActiveRecovery(value)
  else validateStagedRecovery(value)
}
function validateStagedRecovery(value: Record<string, unknown>): void {
  const request = parseSharedRecoveryRequest(value['request'])
  const evidence = recoveryBytes(value['evidenceBase64'])
  if (!fields(value, ['boundary', 'phase', 'request', 'evidenceBase64', 'preparedBase64',
      ...['cancelled', 'supersededRequestIds', 'anchorBase64'].filter(field => Object.hasOwn(value, field))]) ||
      !request || !evidence || recoveryHash(evidence) !== request.evidence_sha256 || !recoveryBytes(value['preparedBase64']) ||
      (request.action === 'restore' ? !recoveryBytes(value['anchorBase64']) : Object.hasOwn(value, 'anchorBase64'))) {
    throw new Error('Invalid shared recovery evidence.')
  }
  if (Object.hasOwn(value, 'cancelled') && (value['cancelled'] !== true || request.action !== 'replace')) {
    throw new Error('Invalid shared recovery cancellation.')
  }
  const superseded = value['supersededRequestIds']
  if (superseded !== undefined && (request.action !== 'replace' || !Array.isArray(superseded) ||
      superseded.some(id => typeof id !== 'string' || !REVIEW_ID_RE.test(id) || id === request.request_id) ||
      new Set(superseded).size !== superseded.length)) throw new Error('Invalid shared recovery request history.')
}
/** Only the identity: any stage byte, request history or cancellation left
 * on an activated record, even empty, makes it unreadable. */
function validateActiveRecovery(value: Record<string, unknown>): void {
  const activation = value['activation']
  if (!object(activation) || !fields(activation, ['fingerprint', 'order']) || typeof activation['fingerprint'] !== 'string' ||
      !HASH.test(activation['fingerprint']) || !Number.isSafeInteger(activation['order']) || (activation['order'] as number) < 1) {
    throw new Error('Invalid shared recovery activation.')
  }
  const request = value['request']
  if (!fields(value, ['boundary', 'phase', 'request', 'activation']) ||
      !object(request) || !fields(request, [...IDENTITY_FIELDS]) || !validIdentity(request)) throw new Error('Invalid shared recovery evidence.')
}
