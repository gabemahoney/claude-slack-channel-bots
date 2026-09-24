/**
 * persona-routing.ts — Inbound Slack delivery per persona (b.av2 SR-4.1 and
 * SR-4.2 core, SR-10.3 `unclaimed-channel`).
 *
 * Every `message` and `app_mention` event a persona's connection receives
 * feeds that persona's single pipeline:
 *
 * 1. Intake (`receive`): the event is acked first, before anything else. Then,
 *    for each receiving persona, the archive is written through the archive
 *    seam (unconditionally, before any decision) and that persona's pipeline
 *    runs. Each persona's run is isolated: a throw is caught and logged, naming
 *    the persona, and never stops another persona's run.
 * 2. Decision (`decideDelivery`, pure): the core channel rules against the
 *    receiving persona P, in order: today's subtype handling (a subtype other
 *    than `file_share`, or no `user`, is dropped); P's own messages (author
 *    user = P's bot user) are dropped; DMs are dropped; a channel P is not
 *    configured into is dropped; `delivery: all` delivers; `delivery: mentions`
 *    delivers only on P's direct user mention (`<@U…>`).
 * 3. Drop logging: a channel no applied persona lists logs one
 *    `unclaimed-channel` line naming the channel and P; a channel another
 *    applied persona lists logs nothing; a DM logs one interim
 *    `persona-dm-dropped` line. No drop line carries message text.
 * 4. Dispatch: P's session is looked up by persona key; the ack reaction is
 *    added through P's client; the message goes as `notifications/claude/channel`
 *    to P's session only, with `chat_id` set to the source conversation.
 * 5. Lost message: when P has no live session, or its session has lost its GET
 *    stream, the message is dropped, a human-triggered restart of P is
 *    scheduled when the restart guards allow (b.kvq / b.9cj), and one reply
 *    saying so is posted in the source conversation through P's client.
 *
 * Deferred rules and where they are completed: the full subtype list, bot-ID
 * self-exclusion, broadcasts and dedupe (E4); DM delivery (E6, which replaces
 * the interim DM drop and its line); the lost-message notice to P's
 * destination (E8, which replaces the source-conversation replies below); the
 * ack reaction's source and keying (E9; today it comes from `access.json`).
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no Slack
 * client, reads no token, file or environment variable, starts no timer and
 * logs nothing. Every Slack client, the persona config, the bot identity, the
 * name resolver, the archive writer, the ack-reaction source and the logger
 * are injected through `createPersonaRouting`. The session lookup comes from
 * the registry and the restart guards from the restart and backoff modules,
 * so tests drive their real state. This module never calls agent-director.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import type { ChannelEntry, Persona, PersonaConfig } from './config.ts'
import { hasGetStreamKey, sanitizeFilename, type Access } from './lib.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  formatPersonaDiagnostic,
  PERSONA_DM_DROPPED,
  UNCLAIMED_CHANNEL,
} from './persona-diagnostics.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { getSessionByPersona } from './registry.ts'
import { isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from './restart.ts'
import { isAtCap } from './backoff.ts'
import { trackAck } from './ack-tracker.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one subtype today's rules deliver (a message with a file attached). */
const FILE_SHARE_SUBTYPE = 'file_share'

/** `channel_type` of a direct message. */
const DM_CHANNEL_TYPE = 'im'

/** MCP notification method that carries an inbound message to a session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/** Characters of message text the dispatch log line shows. */
const DISPATCH_LOG_TEXT_LENGTH = 80

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

/** Why a persona does not get a message (`decideDelivery`). */
export type DeliveryDropReason =
  | 'non-message'
  | 'own'
  | 'dm'
  | 'channel-not-configured'
  | 'not-mentioned'

/** Outcome of `decideDelivery` for one receiving persona. */
export type DeliveryDecision =
  | { action: 'deliver' }
  | { action: 'drop'; reason: Exclude<DeliveryDropReason, 'channel-not-configured'> }
  | {
      action: 'drop'
      reason: 'channel-not-configured'
      /** True when no applied persona lists the channel (an `unclaimed-channel` line is due). */
      unclaimed: boolean
    }

/** The receiving persona P as `decideDelivery` sees it. */
export interface DeliveryPersona {
  /** P's bot user ID. Empty (or absent) never matches an author or a mention. */
  botUserId: string | undefined
  /** P's channel entries. */
  channels: readonly ChannelEntry[]
}

/** Which restart-guard outcome a lost message gets (b.kvq / b.9cj). */
export type LostMessageOutcome = 'restarting' | 'auto-restart-disabled' | 'capped' | 'recover'

/** The persona config fields this module reads. */
export type PersonaRoutingConfig = Pick<PersonaConfig, 'personas' | 'session_restart_delay'>

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /** P's bot user ID, or empty / undefined when it is not known. */
  getBotUserId(key: string): string | undefined
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
// Pure core decision (b.av2 SR-4.2 core)
// ---------------------------------------------------------------------------

/**
 * Decide whether the receiving persona P gets `event`. `applied` is every
 * applied persona's channel entries (P's included), used only to tell an
 * unclaimed channel from one another persona lists. Pure. Rules, in order:
 *
 * 1. Today's subtype handling (E4 completes it): a subtype other than
 *    `file_share`, an event with no `user` and an event with no channel are
 *    `non-message`.
 * 2. The author `user` equals P's bot user ID: `own`.
 * 3. `channel_type` `im`: `dm` (DMs are not delivered yet).
 * 4. The channel is not among P's channel entries: `channel-not-configured`,
 *    with `unclaimed` true when no applied persona lists it.
 * 5. `delivery: all` delivers.
 * 6. `delivery: mentions` delivers only when the text contains `<@P's bot
 *    user ID>`; otherwise `not-mentioned`.
 */
export function decideDelivery(
  event: unknown,
  persona: DeliveryPersona,
  applied: readonly { channels: readonly ChannelEntry[] }[],
): DeliveryDecision {
  if (typeof event !== 'object' || event === null) return { action: 'drop', reason: 'non-message' }
  const ev = event as Record<string, unknown>
  if (ev['subtype'] && ev['subtype'] !== FILE_SHARE_SUBTYPE) return { action: 'drop', reason: 'non-message' }
  if (!ev['user']) return { action: 'drop', reason: 'non-message' }
  const channel = ev['channel']
  if (typeof channel !== 'string' || channel === '') return { action: 'drop', reason: 'non-message' }

  const botUserId = persona.botUserId ?? ''
  if (botUserId !== '' && ev['user'] === botUserId) return { action: 'drop', reason: 'own' }

  if (ev['channel_type'] === DM_CHANNEL_TYPE) return { action: 'drop', reason: 'dm' }

  const entry = persona.channels.find((c) => c.id === channel)
  if (!entry) {
    const claimed = applied.some((p) => p.channels.some((c) => c.id === channel))
    return { action: 'drop', reason: 'channel-not-configured', unclaimed: !claimed }
  }

  if (entry.delivery === 'all') return { action: 'deliver' }
  return mentionsPersona(ev['text'], botUserId)
    ? { action: 'deliver' }
    : { action: 'drop', reason: 'not-mentioned' }
}

/** True when `text` contains the direct user mention `<@botUserId>`; never for an empty ID. */
function mentionsPersona(text: unknown, botUserId: string): boolean {
  if (botUserId === '' || typeof text !== 'string') return false
  return text.includes(`<@${botUserId}>`)
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

  /** Archive, then run P's pipeline; never rejects. */
  async function runIsolated(key: string, event: object): Promise<void> {
    try {
      deps.archive(key, event)
    } catch (err) {
      deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    try {
      await runPipeline(key, event as Record<string, unknown>)
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
    const botUserId = deps.getBotUserId(key) ?? ''
    const decision = decideDelivery(ev, { botUserId, channels: persona.channels }, config.personas)
    if (decision.action === 'drop') {
      logDrop(persona, ev, decision)
      return
    }
    await dispatch(persona, botUserId, ev, config)
  }

  function logDrop(persona: Persona, ev: Record<string, unknown>, decision: Extract<DeliveryDecision, { action: 'drop' }>): void {
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
      case 'dm':
        deps.log(formatPersonaDiagnostic({
          class: PERSONA_DM_DROPPED,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: `direct message in conversation ${channel} dropped: DMs are not delivered yet, whatever dm.enabled says`,
        }))
        return
      default:
        deps.log(
          `[slack] persona ${renderPersonaRef(persona.name, persona.key)} dropped message from ` +
          `channel=${channel} user=${String(ev['user'])}: ${decision.reason}`,
        )
    }
  }

  async function dispatch(
    persona: Persona,
    botUserId: string,
    ev: Record<string, unknown>,
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

    const userName = await deps.resolveUserName(persona.key, ev['user'] as string)
    await addAckReaction(persona.key, chatId, ts)

    const meta = buildMeta(ev, chatId, userName)
    const text = stripMention((ev['text'] as string | undefined) || '', botUserId)

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

/** Today's `<channel>` meta: source conversation, message ID, user, ts, thread and attachments. */
function buildMeta(ev: Record<string, unknown>, chatId: string, userName: string): Record<string, string> {
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: ev['ts'] as string,
    user: userName,
    ts: ev['ts'] as string,
  }
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

/** Remove P's own mention token (and the whitespace after it) from the text, as today. */
function stripMention(text: string, botUserId: string): string {
  if (botUserId === '') return text
  return text.split(`<@${botUserId}>`).map((part, i) => (i === 0 ? part : part.trimStart())).join('').trim()
}
