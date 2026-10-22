/** Bounded recovery grammar and evidence in the existing shared authority.
 * No snapshot-import path: restoration requires the running owner's anchor. */
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
export interface SharedRecoveryRecord {
  boundary: string
  phase: 'review' | 'active'
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
  activation?: { fingerprint: string; order: number }
}
const HASH = /^[a-f0-9]{64}$/
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
export function parseSharedRecoveryRequest(value: unknown): SharedRecoveryRequest | undefined {
  if (!object(value) || value['format'] !== REVIEW_REQUEST_FORMAT ||
      typeof value['request_id'] !== 'string' || !REVIEW_ID_RE.test(value['request_id']) ||
      typeof value['evidence_sha256'] !== 'string' || !HASH.test(value['evidence_sha256'])) return undefined
  const replacement = value['action'] === 'replace'
  if ((!replacement && value['action'] !== 'restore') ||
      !fields(value, ['format', 'request_id', 'evidence_sha256', 'action', ...(replacement ? ['replacement_source_base64'] : [])]) ||
      (replacement && !recoveryBytes(value['replacement_source_base64']))) return undefined
  return structuredClone(value) as SharedRecoveryRequest
}
export function readSharedRecoveryRequest(bytes: Uint8Array): SharedRecoveryRequest | undefined {
  try { return parseSharedRecoveryRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { return undefined }
}
export function validateSharedRecovery(value: unknown): asserts value is SharedRecoveryRecord {
  if (!object(value) || !fields(value, ['boundary', 'phase', 'request', 'evidenceBase64', 'preparedBase64',
    ...(Object.hasOwn(value, 'cancelled') ? ['cancelled'] : []), ...(Object.hasOwn(value, 'supersededRequestIds') ? ['supersededRequestIds'] : []),
    ...(Object.hasOwn(value, 'anchorBase64') ? ['anchorBase64'] : []), ...(Object.hasOwn(value, 'activation') ? ['activation'] : [])]) ||
      typeof value['boundary'] !== 'string' || !REVIEW_ID_RE.test(value['boundary']) ||
      !['review', 'active'].includes(value['phase'] as string)) throw new Error('Invalid shared recovery boundary.')
  const request = parseSharedRecoveryRequest(value['request'])
  const evidence = recoveryBytes(value['evidenceBase64'])
  if (!request || !evidence || recoveryHash(evidence) !== request.evidence_sha256 || !recoveryBytes(value['preparedBase64']) ||
      (request.action === 'restore' ? !recoveryBytes(value['anchorBase64']) : Object.hasOwn(value, 'anchorBase64'))) {
    throw new Error('Invalid shared recovery evidence.')
  }
  if (Object.hasOwn(value, 'cancelled') && (value['cancelled'] !== true || value['phase'] !== 'review' || request.action !== 'replace')) {
    throw new Error('Invalid shared recovery cancellation.')
  }
  const superseded = value['supersededRequestIds']
  if (superseded !== undefined && (request.action !== 'replace' || !Array.isArray(superseded) ||
      superseded.some(id => typeof id !== 'string' || !REVIEW_ID_RE.test(id) || id === request.request_id) ||
      new Set(superseded).size !== superseded.length)) throw new Error('Invalid shared recovery request history.')
  const activation = value['activation']
  if (value['phase'] === 'review' ? activation !== undefined :
      !object(activation) || !fields(activation, ['fingerprint', 'order']) || typeof activation['fingerprint'] !== 'string' ||
      !HASH.test(activation['fingerprint']) || !Number.isSafeInteger(activation['order']) || (activation['order'] as number) < 1) {
    throw new Error('Invalid shared recovery activation.')
  }
}
