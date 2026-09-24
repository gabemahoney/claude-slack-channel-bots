/**
 * persona-routing.ts — Inbound Slack delivery per persona (b.av2 SR-4.1,
 * SR-4.2, SR-4.3, SR-4.4, SR-10.3 `unclaimed-channel` and `persona-dm-dropped`).
 *
 * Every `message` and `app_mention` event a persona's connection receives
 * feeds that persona's single pipeline:
 *
 * 1. Intake (`receive`): the event is acked first, before anything else. Then,
 *    for each receiving persona, the archive is written through the archive
 *    seam (unconditionally, before dedupe and any decision) and that persona's
 *    pipeline runs. Each persona's run is isolated: a throw is caught and
 *    logged, naming the persona, and never stops another persona's run.
 * 2. Dedupe (b.av2 SR-4.1): P's own store (`src/inbound-dedupe.ts`), kept
 *    per persona key for the life of this routing instance (so it survives a
 *    reopen of P's connection), records the event's (channel, ts), or
 *    (channel, ts, edited.ts) when the event carries a top-level `edited.ts`
 *    (an edit that adds a mention arrives as an `app_mention` with the
 *    original ts and an `edited` object). A key P already saw within the
 *    retention window, such as the second of the `message` / `app_mention`
 *    pair or a Slack redelivery, stops here with no decision, dispatch,
 *    reaction, recovery, post or log line. An event without a channel or ts
 *    is not keyed and carries on.
 * 3. Decision: one call to `decideDelivery` (`src/delivery-decision.ts`, the
 *    only module holding delivery rules) with P's key, bot user ID, bot ID,
 *    channel entries and DMs switch (`dm.enabled`) and the applied personas.
 *    It returns deliver with `via`, or drop with a reason. A DM is decided
 *    only against the persona whose connection received it.
 * 4. Drop logging: a channel no applied persona lists logs one
 *    `unclaimed-channel` line naming the channel and P; a channel another
 *    applied persona lists logs nothing; a DM to P with its DMs switch off
 *    logs one `persona-dm-dropped` line naming P and `dm.enabled`, and makes
 *    no Slack call; any other reason logs one plain line naming the author
 *    ID. No drop line carries message text.
 * 5. Dispatch: P's session is looked up by persona key; the ack reaction is
 *    added through P's client; the message goes as `notifications/claude/channel`
 *    to P's session only, with `chat_id` set to the source conversation (the
 *    channel, or the DM conversation). The
 *    meta `user` is the author's display name, or for an author without
 *    `user` (webhook, `bot_message`) the event's `username`, else its
 *    `bot_profile.name`, else its bot ID. The meta also carries the author's
 *    `user_id` (or, for an author without `user`, its `bot_id`; never both)
 *    and `via`, how the message reached P (b.av2 SR-4.4).
 * 6. Lost message: when P has no live session, or its session has lost its GET
 *    stream, the message is dropped, a human-triggered restart of P is
 *    scheduled when the restart guards allow (b.kvq / b.9cj), and one reply
 *    saying so is posted in the source conversation through P's client.
 *
 * Deferred rules and where they are completed: the lost-message notice to P's
 * destination (E8, which replaces the source-conversation replies below); the
 * ack reaction's source and keying (E9; today it comes from `access.json`).
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no Slack
 * client, reads no token, file or environment variable, starts no timer and
 * logs nothing. Every Slack client, the persona config, the bot identity, the
 * name resolver, the archive writer, the ack-reaction source, the logger and
 * (optionally) the dedupe clock are injected through `createPersonaRouting`. The session lookup comes from
 * the registry and the restart guards from the restart and backoff modules,
 * so tests drive their real state. This module never calls agent-director.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { Persona, PersonaConfig } from './config.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import {
  decideDelivery,
  stripPersonaMention,
  type DeliverDecision,
  type DropDecision,
} from './delivery-decision.ts'
import { hasGetStreamKey, sanitizeFilename, type Access } from './lib.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  formatPersonaDiagnostic,
  PERSONA_DM_DROPPED,
  UNCLAIMED_CHANNEL,
} from './persona-diagnostics.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { createInboundDedupeStore, type InboundDedupeStore } from './inbound-dedupe.ts'
import { getSessionByPersona } from './registry.ts'
import { isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from './restart.ts'
import { isAtCap } from './backoff.ts'
import { trackAck } from './ack-tracker.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MCP notification method that carries an inbound message to a session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/** Characters of message text the dispatch log line shows. */
const DISPATCH_LOG_TEXT_LENGTH = 80

/** Meta `user` label when an author carries no name and no bot ID (unreachable after the decision). */
const UNKNOWN_AUTHOR = 'unknown'

/** Author shown in a drop line for an event with neither `user` nor `bot_id`. */
const NO_AUTHOR_PLACEHOLDER = '(none)'

// Lost-message replies (b.kvq / b.9cj), posted in the source conversation.
// Kept byte-identical to the pre-persona replies until E8 replaces them.

/** A restart of the persona is already pending or running. */
export const LOST_MESSAGE_RESTARTING_REPLY =
  'Your message was not delivered. The session is restarting — please retry in a moment.'

/** `session_restart_delay` is 0: nothing will restart the persona. */
export const LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY =
  'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ' +
  'so it will NOT recover on its own — an operator must restart the server.'

/** The persona is at the restart-failure cap. */
export const LOST_MESSAGE_CAPPED_REPLY =
  'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ' +
  'and will NOT recover on its own — an operator must restart the server.'

/** No session: a human-triggered restart was just scheduled. */
export const LOST_MESSAGE_STARTED_REPLY =
  'Your message was not delivered and was not saved. I have started the session for this channel — ' +
  'please retry in a moment.'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack `ack` handed over with a Socket Mode event. */
export type SlackAck = () => Promise<void> | void

/** Which restart-guard outcome a lost message gets (b.kvq / b.9cj). */
export type LostMessageOutcome = 'restarting' | 'auto-restart-disabled' | 'capped' | 'recover'

/** The persona config fields this module reads. */
export type PersonaRoutingConfig = Pick<PersonaConfig, 'personas' | 'session_restart_delay'>

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /**
   * P's bot identity (bot user ID and bot ID; the placeholder identity in dry
   * run), or undefined when it is not known.
   */
  getBotIdentity(key: string): SlackBotIdentity | undefined
  /** P's validated Slack Web client, or undefined when it has none (before validation, dry run). */
  clientFor(key: string): WebClient | undefined
  /** A user's display name, looked up through P's client. */
  resolveUserName(key: string, userId: string): Promise<string>
  /**
   * Write the event to the message archive on behalf of P (name lookups on
   * P's client). Fire-and-forget: a no-op when the archive is disabled, and
   * must not throw.
   */
  archive(key: string, event: unknown): void
  /** The ack-reaction source (`access.json` until E9). */
  getAccess(): Pick<Access, 'ackReaction'>
  /** Writes one log line. */
  log(line: string): void
  /** Clock for the per-persona dedupe stores, in milliseconds; defaults to `Date.now`. */
  dedupeClock?: () => number
}

/** A persona-routing instance. */
export interface PersonaRouting {
  /**
   * Take one `message` or `app_mention` event received for the persona(s)
   * `personaKeys`: ack it, then archive it and run the pipeline for each
   * receiving persona, each run isolated from the others. Resolves once every
   * run has settled. Never rejects.
   */
  receive(event: unknown, ack: SlackAck, personaKeys: string | readonly string[]): Promise<void>
}

// ---------------------------------------------------------------------------
// Session stream-presence probe (b.9cj; b.av2 SR-11 unchanged)
// ---------------------------------------------------------------------------

/**
 * True when the session registered for persona `key` has its standalone GET
 * SSE stream (`_GET_stream`); false when it has none, or when no session is
 * registered. A session can read `connected` in the registry while the SDK
 * has silently dropped the stream, and then a notification never reaches the
 * bot. Used by the restart guard and the health check. Dispatch does not use
 * it: it probes the transport of the exact session it sends to, so a session
 * registered in between cannot pass the probe on another session's behalf.
 */
export function hasSessionStream(key: string): boolean {
  const session = getSessionByPersona(key)
  return session ? hasGetStreamKey(session.transport) : false
}

// ---------------------------------------------------------------------------
// Lost-message restart guard (b.kvq / b.9cj)
// ---------------------------------------------------------------------------

/**
 * The shared restart-guard decision for a message persona `key` could not
 * take, in today's order: a restart already pending or running; auto-restart
 * disabled (`restartDelaySeconds` 0); the persona at `RESTART_FAILURE_CAP`;
 * otherwise `recover` (the caller schedules a human-triggered restart). Reads
 * the real restart and backoff state; changes nothing.
 */
export function decideLostMessageRecovery(key: string, restartDelaySeconds: number): LostMessageOutcome {
  if (isRestartPendingOrActive(key)) return 'restarting'
  if (restartDelaySeconds === 0) return 'auto-restart-disabled'
  if (isAtCap(key, RESTART_FAILURE_CAP)) return 'capped'
  return 'recover'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Which lost-message branch applies: no live session (b.kvq), or a streamless one (b.9cj). */
type LostMessageBranch = 'no-session' | 'streamless'

/** Build a persona-routing instance over the injected dependencies. */
export function createPersonaRouting(deps: PersonaRoutingDeps): PersonaRouting {
  /** Each persona's dedupe store, by persona key; never shared between personas. */
  const dedupeStores = new Map<string, InboundDedupeStore>()

  /** P's dedupe store, created on first use. */
  function dedupeStoreFor(key: string): InboundDedupeStore {
    let store = dedupeStores.get(key)
    if (!store) {
      store = createInboundDedupeStore(deps.dedupeClock)
      dedupeStores.set(key, store)
    }
    return store
  }

  /** The persona reference for a key: its rendered name when applied, else the bare key. */
  function refForKey(key: string): string {
    const persona = deps.getPersonaConfig()?.personas.find((p) => p.key === key)
    return persona ? renderPersonaRef(persona.name, persona.key) : `key=${key}`
  }

  async function receive(event: unknown, ack: SlackAck, personaKeys: string | readonly string[]): Promise<void> {
    try {
      await ack()
    } catch (err) {
      deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`)
    }
    if (typeof event !== 'object' || event === null) return
    const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
    await Promise.all(keys.map((key) => runIsolated(key, event)))
  }

  /** Archive, drop a duplicate silently, else run P's pipeline; never rejects. */
  async function runIsolated(key: string, event: object): Promise<void> {
    try {
      deps.archive(key, event)
    } catch (err) {
      deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    try {
      const ev = event as Record<string, unknown>
      if (dedupeStoreFor(key).record(ev['channel'], ev['ts'], editedTs(ev)) === 'duplicate') return
      await runPipeline(key, ev)
    } catch (err) {
      deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
  }

  async function runPipeline(key: string, ev: Record<string, unknown>): Promise<void> {
    const config = deps.getPersonaConfig()
    const persona = config?.personas.find((p) => p.key === key)
    if (!config || !persona) {
      deps.log(`[slack] persona-routing: no applied persona with key=${key} — event not delivered to it`)
      return
    }
    const identity = deps.getBotIdentity(key)
    const decision = decideDelivery(
      ev,
      {
        key,
        botUserId: identity?.botUserId,
        botId: identity?.botId,
        channels: persona.channels,
        dmEnabled: persona.dm.enabled,
      },
      config.personas,
    )
    if (decision.action === 'drop') {
      logDrop(persona, ev, decision)
      return
    }
    await dispatch(persona, identity?.botUserId, ev, decision, config)
  }

  function logDrop(persona: Persona, ev: Record<string, unknown>, decision: DropDecision): void {
    const channel = String(ev['channel'])
    switch (decision.reason) {
      case 'channel-not-configured':
        // A channel another applied persona lists is that persona's: no line (AC 52).
        if (!decision.unclaimed) return
        deps.log(formatPersonaDiagnostic({
          class: UNCLAIMED_CHANNEL,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: `message in channel ${channel} not delivered: no applied persona lists this channel`,
        }))
        return
      case 'dm-disabled':
        deps.log(formatPersonaDiagnostic({
          class: PERSONA_DM_DROPPED,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: `direct message in conversation ${channel}${describeTs(ev)} dropped: dm.enabled is off for this persona`,
        }))
        return
      default:
        deps.log(
          `[slack] persona ${renderPersonaRef(persona.name, persona.key)} dropped message from ` +
          `channel=${channel} ${describeAuthor(ev)}: ${decision.reason}`,
        )
    }
  }

  async function dispatch(
    persona: Persona,
    botUserId: string | undefined,
    ev: Record<string, unknown>,
    delivery: DeliverDecision,
    config: PersonaRoutingConfig,
  ): Promise<void> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const chatId = ev['channel'] as string
    const ts = ev['ts'] as string

    const noLiveSession = async (): Promise<void> => {
      deps.log(`[slack] No live session for persona ${ref} chat_id=${chatId} — dropping message`)
      await handleLostMessage(persona, chatId, persona.working_directory, 'no-session', config)
    }

    const initial = getSessionByPersona(persona.key)
    if (!initial || !initial.connected) {
      await noLiveSession()
      return
    }

    const userName = await resolveAuthorLabel(persona.key, ev)
    await addAckReaction(persona.key, chatId, ts)

    const meta = buildMeta(ev, chatId, userName, delivery)
    const text = stripPersonaMention((ev['text'] as string | undefined) || '', botUserId)

    // Re-read P's session after the awaits above: the session may have been
    // replaced or dropped meanwhile. From here to notification() nothing is
    // awaited, so the stream probe and the send act on this one session (b.9cj).
    const session = getSessionByPersona(persona.key)
    if (!session || !session.connected) {
      await noLiveSession()
      return
    }
    const hasStream = hasGetStreamKey(session.transport)
    const mcpSessionId = session.transport.sessionId ?? '(unset)'
    deps.log(
      `[slack] Dispatching to persona ${ref} chat_id=${chatId} cwd="${session.cwd}" ` +
      `mcpSessionId=${mcpSessionId} hasGetStream=${hasStream} connected=${session.connected} ` +
      `text="${text.slice(0, DISPATCH_LOG_TEXT_LENGTH)}"`,
    )
    if (!hasStream) {
      // b.9cj: the SDK has dropped the GET stream, so notification() would
      // vanish without a throw. Do not send it; recover and say so instead.
      deps.log(
        `[slack] DROP: no _GET_stream for persona ${ref} chat_id=${chatId} cwd="${session.cwd}" ` +
        `mcpSessionId=${mcpSessionId} — message will not reach the bot; triggering recovery`,
      )
      await handleLostMessage(persona, chatId, session.cwd, 'streamless', config)
      return
    }

    await session.server.notification({
      method: CHANNEL_NOTIFICATION_METHOD,
      params: { content: text, meta },
    })
  }

  /**
   * The meta `user` label: the author's display name through P's client when
   * the event has a `user`; otherwise (webhook, `bot_message`) a name the
   * event carries, with no Slack call (see `botAuthorLabel`).
   */
  async function resolveAuthorLabel(key: string, ev: Record<string, unknown>): Promise<string> {
    const user = ev['user']
    if (typeof user === 'string' && user !== '') return deps.resolveUserName(key, user)
    return botAuthorLabel(ev)
  }

  /** Today's ack reaction and ack tracking, through P's client; skipped when P has none. */
  async function addAckReaction(key: string, channel: string, ts: string): Promise<void> {
    const reaction = deps.getAccess().ackReaction
    if (!reaction) return
    const client = deps.clientFor(key)
    if (!client) return
    try {
      await client.reactions.add({ channel, timestamp: ts, name: reaction })
    } catch { /* non-critical */ }
    trackAck(channel, ts)
  }

  /**
   * b.kvq / b.9cj: the message is lost. Apply the shared restart guards for P,
   * schedule a human-triggered restart of P in `cwd` when they allow it, and
   * reply in the source conversation. The message itself is never delivered
   * or replayed, and the reply never implies otherwise.
   */
  async function handleLostMessage(
    persona: Persona,
    chatId: string,
    cwd: string,
    branch: LostMessageBranch,
    config: PersonaRoutingConfig,
  ): Promise<void> {
    let reply: string
    switch (decideLostMessageRecovery(persona.key, config.session_restart_delay)) {
      case 'restarting':
        reply = LOST_MESSAGE_RESTARTING_REPLY
        break
      case 'auto-restart-disabled':
        reply = LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY
        break
      case 'capped':
        reply = LOST_MESSAGE_CAPPED_REPLY
        break
      case 'recover':
        scheduleRestart(persona.key, cwd, undefined, { humanTrigger: true })
        reply = branch === 'no-session' ? LOST_MESSAGE_STARTED_REPLY : LOST_MESSAGE_RESTARTING_REPLY
        break
    }
    await postLostMessageReply(persona, chatId, reply)
  }

  /** Post one top-level reply through P's client. Failures are logged, never thrown. */
  async function postLostMessageReply(persona: Persona, chatId: string, text: string): Promise<void> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const client = deps.clientFor(persona.key)
    if (!client) {
      deps.log(`[slack] persona ${ref} has no validated Slack client — lost-message reply to chat_id=${chatId} not posted`)
      return
    }
    try {
      await client.chat.postMessage({ channel: chatId, text })
    } catch (err) {
      deps.log(`[slack] failed to post lost-message reply for persona ${ref} to chat_id=${chatId}${describeSlackCallFailure(err)}`)
    }
  }

  return { receive }
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Label for an author without `user`: the event's `username`, else its
 * `bot_profile.name`, else its bot ID. The decision drops an event with
 * neither `user` nor `bot_id`, so the bot ID is always there when this runs;
 * `unknown` only guards the type.
 */
function botAuthorLabel(ev: Record<string, unknown>): string {
  const profile = ev['bot_profile']
  const profileName = typeof profile === 'object' && profile !== null
    ? (profile as Record<string, unknown>)['name']
    : undefined
  for (const candidate of [ev['username'], profileName, ev['bot_id']]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return UNKNOWN_AUTHOR
}

/**
 * The event's top-level `edited.ts`, or undefined when `edited` is absent or
 * not an object. Only the top level is read: a `message_changed` event nests
 * its edit under `message.edited` and keeps its own key.
 */
function editedTs(ev: Record<string, unknown>): unknown {
  const edited = ev['edited']
  return typeof edited === 'object' && edited !== null ? (edited as Record<string, unknown>)['ts'] : undefined
}

/** ` ts=<ts>` for a drop line when the event has a non-empty string ts; otherwise empty. */
function describeTs(ev: Record<string, unknown>): string {
  const ts = ev['ts']
  return typeof ts === 'string' && ts !== '' ? ` ts=${ts}` : ''
}

/** The author ID for a drop line: `user=<U…>`, else `bot_id=<B…>`, else `user=(none)`. */
function describeAuthor(ev: Record<string, unknown>): string {
  const user = ev['user']
  if (typeof user === 'string' && user !== '') return `user=${user}`
  const botId = ev['bot_id']
  if (typeof botId === 'string' && botId !== '') return `bot_id=${botId}`
  return `user=${NO_AUTHOR_PLACEHOLDER}`
}

/**
 * The `<channel>` meta of a delivered Slack message: source conversation,
 * message ID, user label, the author's ID (`user_id`, or `bot_id` for an
 * author without `user`; never both), ts, `via` from the decision that let the
 * message through (b.av2 SR-4.4), thread and attachments. Injected prompts
 * (`/interject`, cron) build their own meta and never come through here.
 */
function buildMeta(
  ev: Record<string, unknown>,
  chatId: string,
  userName: string,
  delivery: DeliverDecision,
): Record<string, string> {
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: ev['ts'] as string,
    user: userName,
  }
  const user = ev['user']
  const botId = ev['bot_id']
  if (typeof user === 'string' && user !== '') meta.user_id = user
  else if (typeof botId === 'string' && botId !== '') meta.bot_id = botId
  meta.ts = ev['ts'] as string
  meta.via = delivery.via
  if (ev['thread_ts']) meta.thread_ts = ev['thread_ts'] as string

  const files = ev['files'] as Array<Record<string, unknown>> | undefined
  if (files?.length) {
    meta.attachment_count = String(files.length)
    meta.attachments = files
      .map((f) => {
        const name = sanitizeFilename((f['name'] as string | undefined) || 'unnamed')
        return `${name} (${f['mimetype'] || 'unknown'}, ${f['size'] || '?'} bytes)`
      })
      .join('; ')
  }
  return meta
}
