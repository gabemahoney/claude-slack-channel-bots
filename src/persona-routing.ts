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
 * 5. Dispatch: the author's label is resolved, then P's session is looked up by
 *    persona key and its GET stream probed. Only a message that will actually
 *    be sent gets the ack reaction (through P's client) and an ack-tracker
 *    entry; then it goes as `notifications/claude/channel` to P's session
 *    only, with `chat_id` set to the source conversation (the channel, or the
 *    DM conversation). Nothing is awaited between the session read and the
 *    send. The meta `user` is the author's display name, or for an author
 *    without `user` (webhook, `bot_message`) the event's `username`, else its
 *    `bot_profile.name`, else its bot ID. The meta also carries the author's
 *    `user_id` (or, for an author without `user`, its `bot_id`; never both)
 *    and `via`, how the message reached P (b.av2 SR-4.4).
 * 6. Lost message (b.av2 SR-4.6, SR-7.3): when P has no live session, or its
 *    session has lost its GET stream, the message is dropped with no ack
 *    reaction, a human-triggered restart of P is scheduled only in the
 *    "starting now" state (`src/lost-message.ts` decides the state from the
 *    restart guards), and one lost-message notice naming the sender and the
 *    state goes to P's destination through the injected `notify`. Nothing is
 *    posted in the source conversation, and the message text is never in the
 *    notice.
 *
 * Deferred rule and where it is completed: the ack reaction's source and
 * keying (E9; today it comes from `access.json`).
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no Slack
 * client, reads no token, file or environment variable, starts no timer and
 * logs nothing. Every Slack client, the persona config, the bot identity, the
 * name resolver, the archive writer, the ack-reaction source, the notice sink,
 * the logger and (optionally) the dedupe clock are injected through
 * `createPersonaRouting`. The session lookup comes from
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
import { describeSlackCallFailure, describeThrownValue } from './persona-connection-errors.ts'
import { createInboundDedupeStore, type InboundDedupeStore } from './inbound-dedupe.ts'
import { getSessionByPersona } from './registry.ts'
import { isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from './restart.ts'
import { isAtCap } from './backoff.ts'
import { trackAck } from './ack-tracker.ts'
import { buildLostMessageNotice, decideLostMessageState } from './lost-message.ts'
import type { PersonaNotify } from './persona-notifier.ts'

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack `ack` handed over with a Socket Mode event. */
export type SlackAck = () => Promise<void> | void

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
  /**
   * A user's display name, looked up through P's client. Should resolve to the
   * user ID when no name is found; a rejection is tolerated and treated the
   * same way (the label falls back to the user ID).
   */
  resolveUserName(key: string, userId: string): Promise<string>
  /**
   * Write the event to the message archive on behalf of P (name lookups on
   * P's client). Fire-and-forget: a no-op when the archive is disabled, and
   * must not throw.
   */
  archive(key: string, event: unknown): void
  /** The ack-reaction source (`access.json` until E9). */
  getAccess(): Pick<Access, 'ackReaction'>
  /**
   * Raise a notice at persona P's destination (the persona notifier's
   * `notify`, which adds P's reference and posts through the shared
   * destination hold). Used for the lost-message notice.
   */
  notify: PersonaNotify
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
// Factory
// ---------------------------------------------------------------------------

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

    // The author label is resolved first, for the meta of a delivered message
    // and for the notice of a lost one alike.
    const userName = await resolveAuthorLabel(persona, ev)

    // Read P's session after the await above, so a session replaced or dropped
    // during the lookup is seen. From here to notification() nothing is
    // awaited, so the stream probe and the send act on this one session (b.9cj).
    const session = getSessionByPersona(persona.key)
    if (!session || !session.connected) {
      deps.log(`[slack] No live session for persona ${ref} chat_id=${chatId} — dropping message`)
      await handleLostMessage(persona, persona.working_directory, userName, config)
      return
    }

    const meta = buildMeta(ev, chatId, userName, delivery)
    const text = stripPersonaMention((ev['text'] as string | undefined) || '', botUserId)
    const hasStream = hasGetStreamKey(session.transport)
    const mcpSessionId = session.transport.sessionId ?? '(unset)'
    deps.log(
      `[slack] Dispatching to persona ${ref} chat_id=${chatId} cwd="${session.cwd}" ` +
      `mcpSessionId=${mcpSessionId} hasGetStream=${hasStream} connected=${session.connected} ` +
      `text="${text.slice(0, DISPATCH_LOG_TEXT_LENGTH)}"`,
    )
    if (!hasStream) {
      // b.9cj: the SDK has dropped the GET stream, so notification() would
      // vanish without a throw. Do not send it; recover and tell P's
      // destination instead.
      deps.log(
        `[slack] DROP: no _GET_stream for persona ${ref} chat_id=${chatId} cwd="${session.cwd}" ` +
        `mcpSessionId=${mcpSessionId} — message will not reach the bot; triggering recovery`,
      )
      await handleLostMessage(persona, session.cwd, userName, config)
      return
    }

    // The message is dispatched: only now does it get the ack reaction.
    addAckReaction(persona.key, chatId, ts)
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
  async function resolveAuthorLabel(persona: Persona, ev: Record<string, unknown>): Promise<string> {
    const user = ev['user']
    if (typeof user !== 'string' || user === '') return botAuthorLabel(ev)
    try {
      return await deps.resolveUserName(persona.key, user)
    } catch (err) {
      // A failed lookup must not lose the message: the label falls back to the
      // user ID, as a lookup that finds no name does.
      deps.log(
        `[slack] persona-routing: user-name lookup for persona ${renderPersonaRef(persona.name, persona.key)} ` +
        `failed, using the user ID: ${describeThrownValue(err)}`,
      )
      return user
    }
  }

  /**
   * Today's ack reaction and ack tracking, through P's client, for a message
   * being dispatched; skipped when there is no reaction or P has no client.
   * Synchronous: the entry is recorded and the reaction call issued, not
   * awaited, so nothing is awaited between the stream probe and the send. A
   * failed reaction is non-critical.
   */
  function addAckReaction(key: string, channel: string, ts: string): void {
    const reaction = deps.getAccess().ackReaction
    if (!reaction) return
    const client = deps.clientFor(key)
    if (!client) return
    trackAck(channel, ts)
    try {
      client.reactions.add({ channel, timestamp: ts, name: reaction }).catch(() => { /* non-critical */ })
    } catch { /* non-critical */ }
  }

  /**
   * b.av2 SR-4.6, SR-7.3: the message is lost. Decide the recovery state from
   * P's real restart guards (pending, auto-restart disabled, cap), schedule a
   * human-triggered restart of P in `cwd` only when the state is
   * `starting-now`, and raise one lost-message notice naming `senderLabel`
   * and the state at P's destination. Nothing is posted in the source
   * conversation. The notice is awaited so it is issued before dispatch
   * returns; a failing sink is logged, never thrown.
   */
  async function handleLostMessage(
    persona: Persona,
    cwd: string,
    senderLabel: string,
    config: PersonaRoutingConfig,
  ): Promise<void> {
    const state = decideLostMessageState({
      isRestartPending: () => isRestartPendingOrActive(persona.key),
      isAutoRestartDisabled: () => config.session_restart_delay === 0,
      isAtRestartLimit: () => isAtCap(persona.key, RESTART_FAILURE_CAP),
    })
    if (state === 'starting-now') scheduleRestart(persona.key, cwd, undefined, { humanTrigger: true })
    try {
      await deps.notify(persona.key, buildLostMessageNotice(senderLabel, state))
    } catch (err) {
      deps.log(
        `[slack] persona-routing: lost-message notice for persona ${renderPersonaRef(persona.name, persona.key)} ` +
        `failed: ${describeThrownValue(err)}`,
      )
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
