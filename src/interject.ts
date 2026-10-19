/** Durable localhost injection; 200 means stored, before delivery (b.omv SR-4.3). */
import type { Persona } from './config.ts'
import type { QueueAccept } from './delivery-queue.ts'
import { renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte ceiling for an `/interject` request body. The cron dispatcher
 * measures its serialized POST body against this same constant, so it never
 * sends a body this handler would refuse with 413.
 */
export const INTERJECT_BODY_CAP_BYTES = 32768

/** Sender label used when the body carries no non-empty string `sender`. */
export const DEFAULT_INTERJECT_SENDER = 'interject'

/** Characters of message text the delivery log line shows. */
const DELIVERY_LOG_TEXT_LENGTH = 80

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The persona fields the handler reads. */
export type InterjectPersona = Pick<Persona, 'name' | 'key'>

/** Dependencies of `handleInterject`, injected per call. */
export interface InterjectDeps {
  /**
   * The current applied persona config, read once per request. Null only
   * before the server has loaded its configuration: every target is then
   * unknown (404).
   */
  getPersonaConfig: () => { personas: readonly InterjectPersona[] } | null
  /** Durable shared injected intake (b.omv SR-4.3). */
  accept: QueueAccept
  /** Clock in epoch milliseconds for the `ts` meta value. Defaults to `Date.now`. */
  now?: () => number
  /** Line logger. Defaults to `console.error`. */
  log?: (line: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A JSON response with the given status. */
function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * True for a loopback remote address (127.0.0.1, ::1, ::ffff:127.*): the one
 * loopback rule of `/interject` and `/clear-latch` (`src/clear-latch.ts`).
 */
export function isLocalAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one `/interject` request. `remoteAddress` is the caller's address
 * (from `server.requestIP(req)`); absent means not local (403). Never throws
 * for request content.
 */
export async function handleInterject(
  req: Request,
  remoteAddress: string | null | undefined,
  deps: InterjectDeps,
): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' })
  if (!isLocalAddress(remoteAddress ?? '')) return jsonResponse(403, { error: 'Forbidden' })

  const bodyText = await req.text()
  if (new TextEncoder().encode(bodyText).byteLength > INTERJECT_BODY_CAP_BYTES) {
    return jsonResponse(413, { error: 'Request body too large (max 32KB)' })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' })
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
    persona?: unknown
    message?: unknown
    sender?: unknown
  }

  const { persona: target, message, sender } = body
  if (typeof target !== 'string' || !target) {
    return jsonResponse(400, { error: 'Missing or invalid field: persona (string) required' })
  }
  if (typeof message !== 'string' || !message) {
    return jsonResponse(400, { error: 'Missing or invalid field: message (string) required' })
  }

  const persona = resolvePersonaTarget(deps.getPersonaConfig(), target)
  if (!persona) return jsonResponse(404, { error: 'Persona not found in the applied config' })

  const log = deps.log ?? ((line: string) => console.error(line))
  const ref = renderPersonaRef(persona.name, persona.key)

  const senderLabel = typeof sender === 'string' && sender ? sender : DEFAULT_INTERJECT_SENDER
  try {
    const result = await deps.accept(persona.key, { source: 'interject', sender: senderLabel, text: message, received_at: (deps.now ?? Date.now)() })
    if (result.status === 'failed') return jsonResponse(500, { error: 'Message not stored' })
  } catch {
    return jsonResponse(500, { error: 'Message not stored' })
  }

  log(
    `[slack] /interject: queued for persona ${ref} sender="${senderLabel}" ` +
      `message="${message.slice(0, DELIVERY_LOG_TEXT_LENGTH)}"`,
  )
  return jsonResponse(200, { ok: true, persona: persona.name })
}
