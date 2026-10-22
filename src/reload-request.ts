/** Operator file requests. Pure grammar, durable record types and safe text;
 * there is deliberately no CLI, HTTP, Slack or MCP entry point. */
import { CHANNEL_ID_RE, DELIVERY_MODES, type DeliveryMode, type Persona } from './config.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import type { PersonaDeclaration } from './shared-channels.ts'

export const REVIEW_REQUEST_FORMAT = 'cscb-review-request-v1'
export const REVIEW_REQUEST_SUFFIX = '.request'
export const REVIEW_REQUEST_INVALID = 'reload-request-invalid'
export const REVIEW_REQUEST_RECORDED = 'reload-request-recorded'
export const REVIEW_REQUEST_STORAGE = 'reload-request-storage'
export const REVIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** incarnation is the currently applied life, or null for an absent key.
 * declaration is the intended config.json declaration, including replacements.
 * Thus a held request cannot silently acquire a different target identity. */
export interface OperatorAssignment {
  key: string
  channel: string
  delivery: DeliveryMode
  incarnation: string | null
  declaration: PersonaDeclaration
  /** Explicit reviewed replacement of this exact unresolved absence history. */
  absence_replacement?: string
}
export type ReviewRequest = {
  format: typeof REVIEW_REQUEST_FORMAT
  request_id: string
  intent_generation: number
} & (
  | { action: 'request' | 'revise'; assignments: OperatorAssignment[] }
  | { action: 'refresh' | 'cancel' }
)
export interface OperatorIntent {
  generation: number
  requested: boolean
  assignments: OperatorAssignment[]
  /** Identity tombstones survive cancellation and successful consumption. */
  requests: Record<string, { request: ReviewRequest; generation: number }>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort())
}
export function validOperatorAssignment(value: unknown): value is OperatorAssignment {
  return object(value) && keys(value, ['key', 'channel', 'delivery', 'incarnation', 'declaration', ...(Object.hasOwn(value, 'absence_replacement') ? ['absence_replacement'] : [])]) &&
    (value['absence_replacement'] === undefined || (typeof value['absence_replacement'] === 'string' && /^[a-f0-9]{64}$/.test(value['absence_replacement']))) &&
    typeof value['key'] === 'string' && PERSONA_KEY_RE.test(value['key']) &&
    typeof value['channel'] === 'string' && CHANNEL_ID_RE.test(value['channel']) &&
    DELIVERY_MODES.includes(value['delivery'] as DeliveryMode) &&
    (value['incarnation'] === null || (typeof value['incarnation'] === 'string' && !!value['incarnation'])) &&
    object(value['declaration']) && keys(value['declaration'], ['name', 'credentials_file', 'working_directory']) &&
    Object.values(value['declaration']).every(field => typeof field === 'string' && !!field)
}
export function parseReviewRequest(value: unknown): ReviewRequest | undefined {
  if (!object(value) || value['format'] !== REVIEW_REQUEST_FORMAT ||
      typeof value['request_id'] !== 'string' || !REVIEW_ID_RE.test(value['request_id']) ||
      !Number.isSafeInteger(value['intent_generation']) || (value['intent_generation'] as number) < 0) return undefined
  const declarations = value['action'] === 'request' || value['action'] === 'revise'
  if (!declarations && value['action'] !== 'cancel' && value['action'] !== 'refresh') return undefined
  if (!keys(value, ['format', 'request_id', 'intent_generation', 'action', ...(declarations ? ['assignments'] : [])])) return undefined
  if (declarations) {
    if (!Array.isArray(value['assignments']) || !value['assignments'].every(validOperatorAssignment)) return undefined
    const ids = value['assignments'].map(a => JSON.stringify([a.key, a.channel]))
    if (new Set(ids).size !== ids.length) return undefined
  }
  return structuredClone(value) as ReviewRequest
}
export function parseReviewRequestBytes(bytes: Uint8Array): ReviewRequest | undefined {
  try { return parseReviewRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { return undefined }
}
export function buildOperatorAssignment(persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory'>, incarnation: string | null, channel: string, delivery: DeliveryMode, absenceReplacement?: string): OperatorAssignment {
  const assignment = { key: persona.key, channel, delivery, incarnation,
    ...(absenceReplacement === undefined ? {} : { absence_replacement: absenceReplacement }),
    declaration: { name: persona.name, credentials_file: persona.credentials_file, working_directory: persona.working_directory } }
  if (!validOperatorAssignment(assignment)) throw new Error('Invalid operator assignment.')
  return assignment
}
export function buildReviewRequest(requestId: string, intentGeneration: number, action: ReviewRequest['action'], assignments: OperatorAssignment[] = []): ReviewRequest {
  if ((action === 'cancel' || action === 'refresh') && assignments.length) throw new Error('This operator request takes no assignments.')
  const request = parseReviewRequest({ format: REVIEW_REQUEST_FORMAT, request_id: requestId, intent_generation: intentGeneration, action,
    ...(action === 'request' || action === 'revise' ? { assignments } : {}) })
  if (!request) throw new Error('Invalid operator review request.')
  return request
}
/** Validated builder for operator scripts and production-path fixtures. */
export function composeReviewRequest(request: ReviewRequest): string {
  const parsed = parseReviewRequest(request)
  if (!parsed) throw new Error('Invalid operator review request.')
  return JSON.stringify(parsed, null, 2) + '\n'
}
export function emptyOperatorIntent(): OperatorIntent {
  return { generation: 0, requested: false, assignments: [], requests: {} }
}
export function validateOperatorIntent(value: unknown): asserts value is OperatorIntent {
  if (!object(value) || !keys(value, ['generation', 'requested', 'assignments', 'requests']) ||
      !Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 0 ||
      typeof value['requested'] !== 'boolean' || !Array.isArray(value['assignments']) ||
      !value['assignments'].every(validOperatorAssignment) || !object(value['requests'])) throw new Error('Invalid durable operator intent.')
  const ids = value['assignments'].map(a => JSON.stringify([a.key, a.channel]))
  if (new Set(ids).size !== ids.length || (!value['requested'] && ids.length)) throw new Error('Invalid durable operator intent.')
  for (const [id, record] of Object.entries(value['requests'])) {
    if (!object(record) || !keys(record, ['request', 'generation']) ||
        parseReviewRequest(record['request'])?.request_id !== id ||
        !Number.isSafeInteger(record['generation']) || (record['generation'] as number) < 1 ||
        (record['request'] as ReviewRequest).intent_generation + 1 !== record['generation'] ||
        (record['generation'] as number) > (value['generation'] as number)) throw new Error('Invalid durable operator request identity.')
  }
}
export function reviewRequestDiagnostic(result: 'recorded' | 'duplicate' | 'invalid' | 'stale' | 'failed' | 'unresolved', generation: number): string {
  const code = result === 'recorded' || result === 'duplicate' ? REVIEW_REQUEST_RECORDED :
    result === 'failed' || result === 'unresolved' ? REVIEW_REQUEST_STORAGE : REVIEW_REQUEST_INVALID
  return `[slack] ${code}: ${result}; intent generation=${generation}. Applied configuration is unchanged. ` +
    (result === 'recorded' || result === 'duplicate' ? 'Review the pending file before confirming.' : 'Preserve the request and input; use the current generation and target declaration for a fresh request.')
}
export function reviewIntentLine(generation: number, count: number): string {
  return `Operator intent generation=${generation}; declared assignments=${count}. Requests change intent only; rename the reviewed pending file to the apply name to confirm.`
}
