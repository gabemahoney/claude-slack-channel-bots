/**
 * interject.ts — The `/interject` request handler (b.av2 SR-9.1, SR-9.2,
 * SR-10.2).
 *
 * `/interject` injects a message into one persona's live Claude session from
 * localhost. The body names the persona by name or key (`persona`), carries
 * the `message` and an optional `sender` label. The handler answers:
 *
 *   405  any method but POST
 *   403  a remote address other than 127.0.0.1, ::1 or ::ffff:127.*
 *   413  a UTF-8 body over INTERJECT_BODY_CAP_BYTES
 *   400  invalid JSON, or a missing/non-string/empty `persona` or `message`
 *        (a body that still carries only the old `channel` field gets the
 *        `persona` error)
 *   404  no applied persona has that name or key (or no persona config)
 *   503  the persona has no registered, connected session
 *   200  `{ ok: true, persona: <name> }` after one notification is sent
 *
 * The notification goes to the named persona's session only, as
 * `notifications/claude/channel` with meta `user` (the sender label) and `ts`
 * and nothing else: no `chat_id`, `message_id` or `via` (SR-9.2). `ts` keeps
 * the form the b.wr5 reply guard recognises injected messages by.
 *
 * Side-effect free (b.av2 SR-13.1): importing this module reads no file,
 * environment variable or config, binds nothing and logs nothing. The
 * persona config, the session lookup, the clock and the logger are injected
 * per call. It never imports server.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona } from './config.ts'
import type { SessionEntry } from './registry.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
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

/** MCP notification method that carries an injected message to a session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/** Characters of message text the delivery log line shows. */
const DELIVERY_LOG_TEXT_LENGTH = 80

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The persona fields the handler reads. */
export type InterjectPersona = Pick<Persona, 'name' | 'key'>

/** The session fields the handler reads. */
export type InterjectSession = Pick<SessionEntry, 'connected' | 'server'>

/** Dependencies of `handleInterject`, injected per call. */
export interface InterjectDeps {
  /**
   * The current applied persona config, read once per request. Null when
   * there is none (the MCP_HOST / MCP_PORT fallback path until E3 Task 9):
   * every target is then unknown (404).
   */
  getPersonaConfig: () => { personas: readonly InterjectPersona[] } | null
  /** The registry lookup by persona key (`getSessionByPersona` in production). */
  getSessionByPersona: (key: string) => InterjectSession | undefined
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

/** True for a loopback remote address (127.0.0.1, ::1, ::ffff:127.*). */
function isLocalAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
}

/**
 * The `ts` meta value for an injected message: the string form of the epoch
 * milliseconds divided by 1000 (at most three fractional digits). The b.wr5
 * reply guard recognises injected messages by this shape; keep it.
 */
function interjectTs(nowMs: number): string {
  return String(nowMs / 1000)
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

  const session = deps.getSessionByPersona(persona.key)
  if (!session || !session.connected) {
    return jsonResponse(503, { error: 'No active session for this persona' })
  }

  const log = deps.log ?? ((line: string) => console.error(line))
  const senderLabel = typeof sender === 'string' && sender ? sender : DEFAULT_INTERJECT_SENDER
  const meta: Record<string, string> = {
    user: senderLabel,
    ts: interjectTs((deps.now ?? Date.now)()),
  }
  const ref = renderPersonaRef(persona.name, persona.key)

  log(
    `[slack] /interject: delivering to persona ${ref} sender="${senderLabel}" ` +
      `message="${message.slice(0, DELIVERY_LOG_TEXT_LENGTH)}"`,
  )
  const sent = session.server.notification({
    method: CHANNEL_NOTIFICATION_METHOD,
    params: { content: message, meta },
  })
  // Not awaited, as before: the 200 means "handed to the session". A later
  // rejection is logged, never left unhandled.
  void Promise.resolve(sent).catch((err: unknown) => {
    log(`[slack] /interject: notification to persona ${ref} failed: ${describeThrownValue(err)}`)
  })

  return jsonResponse(200, { ok: true, persona: persona.name })
}
