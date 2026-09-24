/**
 * persona-event-router.ts — The handler each persona's Slack connection
 * forwards its events to (b.av2 SR-3.1, SR-4.1, SR-7.1).
 *
 * The connection manager (`persona-connections.ts`) calls one injected
 * handler with the key of the persona whose connection received the event,
 * the event name and the library's listener argument unchanged. It never acks
 * on the handler's behalf. `createPersonaEventRouter` builds that handler:
 *
 * - `message` and `app_mention`: one RAW log line carrying the receiving
 *   persona's key, then the event and its `ack` go to the persona-routing
 *   intake (`persona-routing.ts` `receive`) with the receiving persona as the
 *   only receiver. The intake acks first; an event with no body is acked and
 *   dropped there.
 * - `interactive`: the payload is unwrapped (`body`, then `payload`, then the
 *   argument itself); the channel, message `ts` and clicking user are taken
 *   from its envelope; `cscb.block_action.received` is emitted for every
 *   action; each action goes to `handlePermissionClick` with the receiving
 *   persona's key, stopping at the first handled one. An action whose
 *   handling throws is logged (through `describeThrownValue`) and the next
 *   action is still handled. The payload is acked exactly once, after
 *   handling, even when an action throws. The click handler refuses a click
 *   whose action names another persona's instance (`cscb_<other key>`).
 * - Any other event name (defensive: the manager forwards only the three
 *   above) is acked and ignored.
 *
 * Every event is handled only for the persona whose connection received it:
 * no other persona's key, connection or client is consulted here. A throw
 * while handling one event is caught and logged with the persona key through
 * `describeThrownValue` (never the error's message, which can hold a token),
 * and never escapes to the manager.
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no client,
 * reads no file, environment variable or token and starts no timer. Every
 * dependency is injected through `createPersonaEventRouter`.
 *
 * SPDX-License-Identifier: MIT
 */

import type { PersonaEventHandler, PersonaSocketEventPayload } from './persona-connections.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { PersonaRouting } from './persona-routing.ts'
import {
  emitBlockActionReceived,
  handlePermissionClick,
  type ClickDeps,
} from './permission-click-handler.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters of the raw event JSON the RAW log line shows (as before personas). */
const RAW_EVENT_LOG_LENGTH = 300

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into `createPersonaEventRouter`. */
export interface PersonaEventRouterDeps {
  /** The persona-routing intake `message` and `app_mention` events go to. */
  routing: Pick<PersonaRouting, 'receive'>
  /** The persona's Slack client for the click handler (`clientFor`). */
  clientFor: ClickDeps['clientFor']
  /** The applied persona with this key, for the click handler. */
  getPersona: ClickDeps['getPersona']
  /** Writes one log line. */
  log(line: string): void
  /** The click handler; defaults to `handlePermissionClick`. Tests inject a spy. */
  handleClick?: typeof handlePermissionClick
  /**
   * Permission-trail emitter for `cscb.block_action.received` and the click
   * handler's events; defaults to the permission trail. Tests inject a capture.
   */
  emitTrail?: ClickDeps['emitTrail']
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build the handler the connection manager forwards every persona's events to. */
export function createPersonaEventRouter(deps: PersonaEventRouterDeps): PersonaEventHandler {
  const handleClick = deps.handleClick ?? handlePermissionClick

  async function routeInbound(key: string, eventName: string, payload: PersonaSocketEventPayload): Promise<void> {
    const { event, ack } = payload
    deps.log(`[slack] RAW ${eventName} event persona=${key}: ${JSON.stringify(event)?.slice(0, RAW_EVENT_LOG_LENGTH)}`)
    await deps.routing.receive(event, ack, key)
  }

  async function routeInteractive(key: string, payload: PersonaSocketEventPayload): Promise<void> {
    const { ack } = payload
    const p = (payload.body ?? payload['payload'] ?? payload) as Record<string, unknown>
    const actions = (Array.isArray(p['actions']) ? p['actions'] : []) as Array<{ action_id: string }>
    // SR-V-2.6 / SR-V-2.9 envelope: the inbound channel, message ts and
    // clicking user, shared by every action in this payload.
    const channelId = ((p['channel'] as { id?: string } | undefined)?.id) ?? undefined
    const messageTs = ((p['message'] as { ts?: string } | undefined)?.ts) ?? undefined
    const userId = ((p['user'] as { id?: string } | undefined)?.id) ?? undefined

    // The payload is acked exactly once, after handling, whatever happens.
    let acked = false
    const ackOnce = async (): Promise<void> => {
      if (acked) return
      acked = true
      await ack()
    }

    try {
      for (const [index, action] of actions.entries()) {
        try {
          const actionId = action.action_id
          // SR-V-2.9: one cscb.block_action.received per action, whether or
          // not the click handler engages; decode failures are diagnostically
          // critical.
          emitBlockActionReceived(actionId, { channel: channelId, messageTs, user: userId }, deps.emitTrail)
          const handled = await handleClick(
            actionId,
            { receivingPersonaKey: key, clientFor: deps.clientFor, getPersona: deps.getPersona, emitTrail: deps.emitTrail },
            { channel: channelId, messageTs, user: userId },
          )
          if (handled) {
            await ackOnce()
            return
          }
        } catch (err) {
          // One action's failure does not stop the others.
          deps.log(
            `[slack] persona=${key}: interactive action ${index + 1} of ${actions.length} handling failed: ` +
              describeThrownValue(err),
          )
        }
      }
    } finally {
      await ackOnce()
    }
  }

  async function ackAndIgnore(key: string, eventName: string, payload: PersonaSocketEventPayload): Promise<void> {
    deps.log(`[slack] persona=${key}: ignoring unexpected ${eventName} event`)
    await payload.ack()
  }

  return async (key, eventName, payload) => {
    try {
      switch (eventName) {
        case 'message':
        case 'app_mention':
          await routeInbound(key, eventName, payload)
          return
        case 'interactive':
          await routeInteractive(key, payload)
          return
        default:
          await ackAndIgnore(key, String(eventName), payload)
      }
    } catch (err) {
      deps.log(`[slack] persona=${key}: ${String(eventName)} event handling failed: ${describeThrownValue(err)}`)
    }
  }
}
