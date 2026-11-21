/** Operator-only loopback request. Importing this module performs no I/O. */
import { request as httpRequest } from 'node:http'
import type { ClearLatchDialAnswer, ClearLatchPersona, ClearLatchRequest } from './clear-latch.ts'
import type { DeliveryEngines } from './delivery-engine.ts'
import { isOpenItem, type DeliveryQueue } from './delivery-queue.ts'
import { INTERJECT_BODY_CAP_BYTES, isLocalAddress } from './interject.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { personaKey, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'

export const ABANDON_MESSAGE_COMMAND = 'abandon-message'
export const ABANDON_MESSAGE_ROUTE = '/abandon-message'
export const ABANDON_MESSAGE_WAIT_MS = 30_000
export const ABANDON_MESSAGE_USAGE = `Usage: claude-slack-channel-bots ${ABANDON_MESSAGE_COMMAND} <persona name or key> <ts>`
export const ABANDON_MESSAGE_USAGE_ENTRY = `  ${ABANDON_MESSAGE_COMMAND} <persona name or key> <ts>: abandon one undelivered head message; its text is kept`

/** Absolute end, including rejection of a trailing newline (unlike `$`). */
export function isAbandonTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d{6}(?![\s\S])/.test(value)
}

export interface AbandonMessageDeps {
  getPersonaConfig(): { personas: readonly ClearLatchPersona[] } | null
  isUp(key: string): boolean
  queue: DeliveryQueue
  abandonHead: DeliveryEngines['abandonHead']
  log(line: string): void
}
const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export function abandonMessageFailedLine(description: string): string {
  return `[slack] ${ABANDON_MESSAGE_COMMAND}: the request failed: ${description}`
}

export async function handleAbandonMessage(req: Request, remoteAddress: string | null | undefined, deps: AbandonMessageDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
  if (!isLocalAddress(remoteAddress ?? '')) return json(403, { error: 'Forbidden' })
  let parsed: unknown
  try {
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > INTERJECT_BODY_CAP_BYTES) return json(400, { error: 'Request body too large (max 32KB)' })
    parsed = JSON.parse(text)
  } catch { return json(400, { error: 'Invalid request body' }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'Invalid request body' })
  const { persona: target, ts } = parsed as { persona?: unknown; ts?: unknown }
  if (typeof target !== 'string' || !target || !isAbandonTimestamp(ts)) return json(400, { error: 'Invalid persona or ts' })
  try {
    const persona = resolvePersonaTarget(deps.getPersonaConfig(), target)
    if (!persona) return json(404, { error: 'Persona not found in the applied config' })
    if (!deps.isUp(persona.key)) return json(409, { reason: 'persona-down' })
    const items = deps.queue.items(persona.key), head = items.find(isOpenItem)
    const matches = items.filter(item => item.accepted.ts === ts)
    // Slack edits retain the original ts. Resolve current work before retained
    // revisions; the serialized queue decision still validates this exact seq.
    const item = head?.accepted.ts === ts ? head : matches.find(isOpenItem) ??
      matches.find(item => !item.delivered && !item.abandoned) ?? matches.at(-1)
    if (!item) return json(409, { reason: 'unknown-item' })
    const outcome = await deps.abandonHead(persona.key, item.accepted.seq)
    if (outcome === 'abandoned') return json(200, { ok: true, persona: persona.name, seq: item.accepted.seq })
    // Re-read after the serialized decision. No await separates this current
    // head snapshot from the response, so a head saved before the call cannot leak through.
    return json(409, { reason: outcome === 'unknown' ? 'unknown-item' : outcome,
      ...(outcome === 'not-head' ? { head_ts: deps.queue.items(persona.key).find(isOpenItem)?.accepted.ts } : {}) })
  } catch (error) {
    try { deps.log(abandonMessageFailedLine(describeThrownValue(error))) } catch { /* logging cannot change the answer */ }
    return json(500, { error: 'Internal Server Error' })
  }
}

/** One direct HTTP request; no proxy environment, pool or automatic retry. */
export function dialAbandonMessage(port: number, persona: string, ts: string,
  requestFn: ClearLatchRequest = (options, onResponse) => httpRequest(options, onResponse),
): Promise<ClearLatchDialAnswer> {
  const body = Buffer.from(JSON.stringify({ persona, ts }), 'utf8')
  return new Promise((resolve, reject) => {
    try {
      const req = requestFn({ host: '127.0.0.1', port, path: ABANDON_MESSAGE_ROUTE, method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.byteLength },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk))
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('the response was aborted before its end')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body)
    } catch (error) { reject(error) }
  })
}

export const abandonMessageNoServerLine = (): string => `${ABANDON_MESSAGE_COMMAND}: no server is running`
export const abandonMessageNotAnsweredLine = (cause: string): string => `${ABANDON_MESSAGE_COMMAND}: the server did not answer: ${cause}`
export const abandonMessageNotConfirmedLine = (): string => `${ABANDON_MESSAGE_COMMAND}: the server did not confirm within 30 s; the request may still run. Check the server log before trying again.`

/** Trust only recognized status/body pairs; never echo an unexpected body. */
export function abandonMessageReport(answer: ClearLatchDialAnswer): { line: string; exitCode: number } {
  const line = (text: string, exitCode = 1) => ({ line: `${ABANDON_MESSAGE_COMMAND}: ${text}`, exitCode })
  if (answer.status === 404) return line('no persona in the running configuration has that name or key')
  let parsed: unknown
  try { parsed = JSON.parse(answer.body) } catch { /* status-only failure below */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const { ok, persona, seq, reason, head_ts } = parsed as Record<string, unknown>
    if (answer.status === 200 && ok === true && typeof persona === 'string' && persona && typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0)
      return line(`abandoned message ${seq} for persona ${renderPersonaRef(persona, personaKey(persona))}; its text is kept`, 0)
    if (answer.status === 409) {
      switch (reason) {
        case 'persona-down': return line('the persona is not up; nothing abandoned')
        case 'unknown-item': return line('no queued message has that ts')
        case 'delivered': return line('the message was already delivered; nothing abandoned')
        case 'not-head': if (isAbandonTimestamp(head_ts)) return line(`the message is not the head; the head has ts ${head_ts}`); break
        case 'already-abandoned': return line('the message was already abandoned; nothing changed')
        case 'busy': return line('a key operation is in flight; retry after it finishes')
      }
    }
  }
  return { line: abandonMessageNotAnsweredLine(`HTTP ${answer.status}`), exitCode: 1 }
}
