/** Durable Slack intake and existing message-triggered recovery. */
import {
  CHANNEL_ID_RE,
  DEFAULT_QUEUED_ACK_REACTION,
  channelModeOf,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import {
  decideDelivery,
  decideReaction,
  type DeliveryDecision,
  type DropDecision,
  type FungibleDecisionInputs,
  type FungiblePath,
  type ReactionAcceptDecision,
  type ReactionDecision,
  type ReactionDecisionOrigin,
  type ReactionDropDecision,
  type StoredChoices,
} from './delivery-decision.ts'
import { fungibleDestinationsOf } from './persona-destination.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  formatPersonaDiagnostic,
  fungibleUnclaimedChannelCause,
  invitedChannelCause,
  PERSONA_DM_DROPPED,
  PERSONA_INVITED_CHANNEL,
  UNCLAIMED_CHANNEL,
  unclaimedChannelCause,
} from './persona-diagnostics.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { isQueueItemClosed, isReactionKey, type DeliveryQueue, type QueueAcceptResult, type QueueItem, type AcceptedInput, type ReactionAcceptedInput, type ReactionAcceptedRecord, type ReactionKey } from './delivery-queue.ts'
import {
  buildBotToolReactionErrorLine,
  buildBotToolReactionStoreFailedLine,
  buildReactionDroppedLine,
  buildReactionReceivedLine,
  type ReactionDroppedInput,
} from './reaction-intake-diagnostics.ts'
import { getSessionByPersona } from './registry.ts'
import { isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from './restart.ts'
import { isAtCap } from './backoff.ts'
import {
  decideEarlyLostMessageState,
  decideLostMessageState,
  firesHumanTriggeredRestart,
  type EarlyLostMessageQueries,
} from './lost-message.ts'
import { getOutageFlags } from './outage-state.ts'
import { LIVENESS_PENDING, livenessKindOf, type LivenessReading } from './liveness-reading.ts'
import { describeAgentDirectorFailure } from './ad-error-class.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Author shown in a drop line for an event with neither `user` nor `bot_id`. */
const NO_AUTHOR_PLACEHOLDER = '(none)'

/** The `type` of an `app_mention` event. */
const APP_MENTION_EVENT_TYPE = 'app_mention'

/** The channel mode in which a persona serves the channels its app is in. */
const FUNGIBLE_MODE: ChannelMode = 'fungible'

/** The reaction event type a `bot-tool` reaction's change stands for. */
const BOT_TOOL_EVENT_TYPES: Readonly<Record<BotToolReactionInput['change'], string>> = { added: 'reaction_added' }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack `ack` handed over with a Socket Mode event. */
export type SlackAck = () => Promise<void> | void

/**
 * A reaction persona B made with its own `react` tool on a message of the
 * receiving persona A, as A's reaction intake takes it. `reactorUserId` and
 * `reactorPersonaName` are B's confirmed bot user ID and persona name at
 * hand-off; `messageAuthorUserId` is the reacted message's author as read,
 * which the decision checks against A's confirmed bot user ID; `eventTs` is
 * when CSCB observed B's answer, already formatted.
 */
export interface BotToolReactionInput {
  change: 'added'
  reactorUserId: string
  reactorPersonaName: string
  emoji: string
  channel: string
  messageTs: string
  eventTs: string
  messageAuthorUserId: string
}

/**
 * What A's intake did with a `bot-tool` reaction: `stored` (durably accepted
 * as a new Reaction Item, not yet fixed or delivered), `duplicate` (the queue
 * already holds its reaction key), `dropped` (not accepted for A) or
 * `store-failed` (not stored). It carries no queue item, error or message.
 */
export type BotToolReactionIntakeResult =
  | { status: 'stored'; seq: number }
  | { status: 'duplicate'; seq: number }
  | { status: 'dropped' }
  | { status: 'store-failed' }

/**
 * The persona config fields this module reads: the personas, the restart
 * delay, and the `allow_invited_channels` switch, read through
 * `channelModeOf` at each event.
 */
export type PersonaRoutingConfig = Pick<PersonaConfig, 'personas' | 'session_restart_delay' | 'allow_invited_channels'> & Partial<Pick<PersonaConfig, 'queued_ack_reaction'>>

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /**
   * P's bot identity (bot user ID and bot ID; the placeholder identity in dry
   * run), or undefined when it is not known.
   */
  getBotIdentity(key: string): SlackBotIdentity | undefined
  /** Shared queue; acceptance does no network I/O. */
  queue: Pick<DeliveryQueue, 'accept' | 'lookupSlackKey' | 'lookupReactionKey'>
  /**
   * Whether `id` is one of the Run Bot Identities (production: the
   * connection manager's `isRunBotIdentity`, which keeps every bot user ID
   * confirmed this run, removed personas included). Asked by the reaction
   * decision only. Absent: every reactor counts as one, so no reaction is
   * accepted.
   */
  isRunBotIdentity?(id: string): boolean
  /** Fix stored text after the envelope ack; wake follows durable fixation. */
  prepare(key: string, item: QueueItem): Promise<void>
  /** Durable retained acceptance: after envelope ack, or after partial-fanout
   * failure suppresses it. Reporting must not await Slack or authorize delivery. */
  onReceived?(key: string, item: QueueItem): void
  /** Fire-and-forget archive, before the decision, with no pre-ack await. */
  archive(key: string, event: unknown): void
  /** Writes one log line. */
  log(line: string): void
  /** Intake clock in epoch milliseconds. */
  now?: () => number
  /**
   * The stored choices: the store's readability and
   * its read-only lookup, which the one store `main()` loads
   * (`src/channel-delivery.ts`) satisfies as it is. Read at each
   * fungible-mode event, never held across events; the routing never writes
   * to it or drops from it. Null or undefined (before the store is loaded),
   * or the dep absent: no stored choice applies, so fungible mode serves
   * every channel at `mentions`. Not asked in declarative mode.
   */
  getChannelDelivery?(): StoredChoices | null | undefined
  /**
   * Whether persona P is up (production: the server's one
   * `isPersonaUp` predicate), asked for a lost message only: a message lost
   * for a persona that is not up schedules no restart and reports the
   * `not-up` recovery state. Without it every persona counts as up.
   */
  isPersonaUp?(key: string): boolean
  // The lost-message state inputs, each asked for a lost
  // message only, with P's key at that time. An absent member answers false,
  // except `isRetryArmed`, whose absence leaves state 5 without its
  // armed-timer gate (its restart-cap gate is always asked).
  /**
   * Whether persona P is latched (production: the server's one
   * latch's `isLatched`, which covers every declared case): a message lost
   * while it is latched reports `held-for-human`.
   */
  isLatched?(key: string): boolean
  /**
   * Whether persona P's `tmux-unresponsive` condition holds (
   * production: the condition's `holds`): a message lost while it holds
   * reports `not-answering`, as does one lost while P's `tmux-unavailable` or
   * `ad-config-malformed` outage is raised (read from the outage state), in
   * both cases only while P is below the restart cap and its retry timer is
   * armed (`isRetryArmed`).
   */
  isTmuxUnresponsive?(key: string): boolean
  /**
   * Whether persona P's retry timer is armed, waiting or running (
   * : "state 5 applies only while P's retry timer is
   * armed"; production: the retry controller's `isArmed`, false when there
   * is no controller). State 5 (`not-answering`) is decided only while it
   * answers exactly true and P is below the restart cap, so a P
   * whose retry timer stopped, or one at the cap whose timer is still armed
   * until its next retry, is not reported as being retried and falls
   * through to the later states. Asked by the read gate's check of states 1
   * to 5 and by the final decision, after the cap. Absent (hand-built
   * fixtures): the armed-timer part is not asked, and state 5 is decided
   * from the condition, the flags and the cap.
   */
  isRetryArmed?(key: string): boolean
  /**
   * Whether a launch or dialog approver for persona P is running, so its row
   * reads `pending` (production: the session manager's `isLaunchInFlight`
   * or `isDialogApproverRunning`): a message lost then reports
   * `session-starting`, unless an earlier state applies.
   */
  isLaunchRunning?(key: string): boolean
  /** Whether persona P is held on `ErrInvalidFlags`: reports `cannot-launch`. */
  isHeldOnInvalidFlags?(key: string): boolean
  /**
   * Whether persona P's kill-failure episode is open, or P waits on an
   * old-life hold whose old key's kill failed: reports `kill-failed`.
   */
  isKillFailed?(key: string): boolean
  /**
   * Whether a live-row sequence or old-life wait step is running for persona
   * P: reports `restarting`, after states 1 to 5 and before
   * `session-starting`.
   */
  isSequenceOrWaitRunning?(key: string): boolean
  /**
   * Whether anything is in flight for persona P ("in flight
   * for P"; production: the server's `isPersonaWorkInFlight`, the one the
   * health tick receives, which counts a running dialog approver; the retry
   * timer receives the narrower "blocks a retry" check instead). While it
   * answers true the lost-message row read is not made. Absent: nothing
   * counts as in flight.
   */
  isWorkInFlight?(key: string): boolean
  /**
   * One read of persona P's row, answering one of the four liveness readings
   * (production: the liveness adapter main builds,
   * whose `status` is made outside any launch or recovery attempt here; the
   * answer is read with `livenessKindOf`, so a value that is not a reading
   * counts as `unknown`). Made
   * at most once per lost message, only when none of states 1 to 5 applies
   * and nothing is in flight for P; a `pending` reading is the
   * `session-starting` input, and any other reading, or a rejection, leaves
   * that state out. Absent: no read is made.
   */
  readRowLiveness?(key: string): Promise<LivenessReading>
  /**
   * arm persona P's retry timer when its `tmux-unavailable`
   * outage is raised and it has none (production: the server's one check,
   * shared with the session-disconnect handler, which arms only when no
   * timer is armed, P is not latched and nothing is in flight for P, and
   * logs one line when it arms). Asked for a lost message before the state
   * is decided, only when none of states 1 to 4 applies, state 5's condition
   * holds (P's `tmux-unresponsive` condition, or its `tmux-unavailable` or
   * `ad-config-malformed` flag), P's `tmux-unavailable` flag is raised and P
   * is below the restart cap: so a P whose retry stopped with the
   * flag still raised gets its timer armed and reports `not-answering`
   * (state 5 applies only while P's retry timer is armed, `isRetryArmed`).
   * At the cap nothing is armed: a timer armed there would stop at its first
   * retry, and a P at the cap is never in state 5. It never schedules a
   * restart. Absent: nothing is armed.
   */
  armRetryTimerIfMissing?(key: string): void
}

/** A persona-routing instance. */
export interface PersonaRouting {
  /**
   * Take one `message` or `app_mention` event received for the persona(s)
   * `personaKeys`: archive without awaiting, decide and store all accepted
   * targets, ack only after every store succeeds, then recover and fix text.
   * Each target is isolated; a failed store suppresses the aggregate ack.
   *
   * `isExtSharedChannel` is the envelope flag: the Events API
   * payload's `is_ext_shared_channel`, exactly as the event router received
   * it (`true`, `false`, any other value), or undefined when it was absent. A
   * caller that omits it passes "absent". It is handed unchanged to the
   * decision for each receiving persona.
   */
  receive(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
  ): Promise<void>
  /**
   * Take one `reaction_added` or `reaction_removed` event received on the
   * connection of the persona `personaKey`, its only receiver: an event whose
   * reaction key the queue holds is a duplicate; otherwise decide it under
   * the configuration in effect now and store an accepted one as a Reaction
   * Item. Ack once, after the store succeeds, or for a drop or duplicate; a
   * failed store is not acked, so Slack sends the event again. A retained
   * item not yet fixed or closed goes to preparation only after a successful
   * ack. Nothing before the ack makes a network call. `isExtSharedChannel`
   * is the envelope flag, as for `receive`.
   */
  receiveReaction(event: unknown, ack: SlackAck, personaKey: string, isExtSharedChannel?: unknown): Promise<void>
  /**
   * Take one reaction another persona's Bot made with its `react` tool on a
   * message of the persona `personaKey`, with origin `bot-tool` and no Slack
   * envelope or ack. As for `receiveReaction`, a reaction key the queue holds
   * is a duplicate; otherwise the reaction is decided under the configuration
   * in effect now, without the Run Bot and envelope-flag conditions, and an
   * accepted one is stored as a Reaction Item with the decision's mode and the
   * reacting persona's name. A retained item not yet fixed or closed then goes
   * to preparation, whose outcome does not change the result. Nothing before
   * the store makes a network call. Never rejects.
   */
  receiveBotToolReaction(personaKey: string, input: BotToolReactionInput): Promise<BotToolReactionIntakeResult>
  /**
   * Forget ephemeral heard-channel state on teardown. Durable queue records
   * and Slack keys remain under their original persona key.
   */
  forget(key: string): void
  /**
   * A snapshot of the persona's heard set: the channels whose
   * events took its fungible path in its current persona life. Empty for an
   * unknown or forgotten key; creates no state. The "heard" half of
   * `set_channel_delivery`'s known channels.
   */
  heardChannels(key: string): ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a persona-routing instance over the injected dependencies. */
export function createPersonaRouting(deps: PersonaRoutingDeps): PersonaRouting {
  const heardSets = new Map<string, Set<string>>()
  const postAcked = new Map<string, Set<number>>()
  /** The persona reference for a key: its rendered name when applied, else the bare key. */
  function refForKey(key: string): string {
    const persona = deps.getPersonaConfig()?.personas.find((p) => p.key === key)
    return persona ? renderPersonaRef(persona.name, persona.key) : `key=${key}`
  }

  async function receive(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
  ): Promise<void> {
    const afterAck: Array<() => Promise<void>> = []
    const accepted: Array<() => void> = []
    let storeFailed = false
    if (typeof event === 'object' && event !== null) {
      const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
      await Promise.all(keys.map(async key => {
        try { deps.archive(key, event) } catch (err) {
          deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
        }
        try {
          const ev = event as Record<string, unknown>
          const config = deps.getPersonaConfig()
          const mode = channelModeOf(config)
          if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
          const slackKey = typeof ev['channel'] === 'string' && typeof ev['ts'] === 'string'
            ? { chat_id: ev['channel'], ts: ev['ts'], ...(typeof editedTs(ev) === 'string' ? { edited_ts: editedTs(ev) as string } : {}) } : undefined
          // A retry after partial fanout must prepare the already retained, unfixed target too.
          const duplicate = slackKey ? deps.queue.lookupSlackKey(key, slackKey) : undefined
          const persona = config?.personas.find(p => p.key === key)
          const report = (item: QueueItem) => accepted.push(() => {
            try { void Promise.resolve(deps.onReceived?.(key, item)).catch(() => {}) } catch { /* reporting cannot prevent preparation */ }
          })
          const post = (item: QueueItem) => async () => {
            const posted = postAcked.get(key) ?? new Set<number>()
            if (posted.has(item.accepted.seq)) return
            // Claim only after the aggregate ack: retained partial fanout can
            // retry here, but concurrent/redelivered copies recover just once.
            posted.add(item.accepted.seq)
            postAcked.set(key, posted)
            const session = getSessionByPersona(key)
            if (persona && config && (!session || !session.connected)) await handleLostMessage(persona, persona.working_directory, config)
            await deps.prepare(key, item)
          }
          if (duplicate && duplicate.status !== 'failed') {
            if (duplicate.item && !duplicate.item.fixed && !duplicate.item.delivered) {
              report(duplicate.item)
              afterAck.push(post(duplicate.item))
            }
            return
          }
          if (!config || !persona) return
          const identity = deps.getBotIdentity(key)
          const decision = decideDelivery(ev, { key, botUserId: identity?.botUserId, botId: identity?.botId, channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, fungibleInputs(config, mode, isExtSharedChannel))
          const path = fungiblePathOf(decision)
          if (path !== undefined) logFirstHeard(persona, String(ev['channel']), path)
          if (decision.action === 'drop') { logDrop(persona, ev, decision); return }
          if (!slackKey) return
          const stringField = (field: string) => typeof ev[field] === 'string' ? ev[field] as string : undefined
          const profile = ev['bot_profile']
          const files = Array.isArray(ev['files']) ? ev['files'].filter(f => typeof f === 'object' && f !== null).map(f => ({
            name: typeof f.name === 'string' ? f.name : 'unnamed',
            mimetype: typeof f.mimetype === 'string' ? f.mimetype : undefined,
            size: typeof f.size === 'number' ? f.size : undefined,
          })) : undefined
          const input: AcceptedInput = {
            source: 'slack', key: slackKey, channel: slackKey.chat_id, ts: slackKey.ts,
            queued_ack_reaction: config.queued_ack_reaction ?? DEFAULT_QUEUED_ACK_REACTION,
            channel_type: stringField('channel_type'), thread_ts: stringField('thread_ts'), edited_ts: slackKey.edited_ts,
            user: stringField('user'), bot_id: stringField('bot_id'), username: stringField('username'),
            bot_profile_name: typeof profile === 'object' && profile !== null && 'name' in profile && typeof profile.name === 'string' ? profile.name : undefined,
            text: stringField('text') ?? '', files, via: decision.via, received_at: (deps.now ?? Date.now)(),
          }
          try {
            const result = await deps.queue.accept(key, input)
            if (result.status === 'failed') { storeFailed = true; return }
            if (result.item && !result.item.delivered) { report(result.item); afterAck.push(post(result.item)) }
          } catch { storeFailed = true }
        } catch (err) {
          // Decision/routing failures keep the historical ack behavior.
          deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
        }
      }))
    }
    // A failed sibling suppresses the aggregate ack, but retained targets still
    // deserve queued feedback. Preparation/recovery continue only after ack.
    if (storeFailed) { for (const report of accepted) report(); return }
    try { await ack() } catch (err) { deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`) }
    for (const report of accepted) report()
    await Promise.all(afterAck.map(async work => {
      try { await work() } catch (err) { deps.log(`[slack] persona-routing: post-accept preparation failed${describeSlackCallFailure(err)}`) }
    }))
  }

  /**
   * Build and write one reaction intake line, best effort: a line that fails
   * to build or to write is dropped, so logging never decides the store, the
   * ack or preparation. Keep the name: the secrecy audit treats `safeLog` as
   * a log sink and checks each call's line.
   */
  function safeLog(line: () => string): void {
    try { deps.log(line()) } catch { /* logging cannot change the store, the ack or preparation */ }
  }

  async function receiveReaction(event: unknown, ack: SlackAck, key: string, isExtSharedChannel?: unknown): Promise<void> {
    let retained: QueueItem | undefined
    try {
      const outcome = await takeReaction(event, key, isExtSharedChannel)
      if (outcome === 'store-failed') return
      retained = outcome
    } catch (err) {
      // A decision or routing failure is acked, as for messages; nothing is stored.
      safeLog(() => `[slack] persona-routing: error handling reaction event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    try { await ack() } catch (err) {
      // The stored item waits for a redelivery or startup recovery to prepare it.
      safeLog(() => `[slack] persona-routing: failed to ack reaction event${describeSlackCallFailure(err)}`)
      return
    }
    if (retained === undefined || retained.fixed || isQueueItemClosed(retained)) return
    try { await deps.prepare(key, retained) } catch (err) {
      safeLog(() => `[slack] persona-routing: post-accept reaction preparation failed${describeSlackCallFailure(err)}`)
    }
  }

  /**
   * Everything before a reaction event's ack: the retained item to prepare
   * (absent for a drop, or a duplicate kept only as its key), or
   * `store-failed`. The queue logs a failed store itself (`store-failed`
   * with source `reaction`), and posts no warning for one.
   */
  async function takeReaction(event: unknown, key: string, isExtSharedChannel: unknown): Promise<QueueItem | undefined | 'store-failed'> {
    // The durable key check comes before the decision: a retained duplicate
    // is acked and prepared under its stored mode, whatever is in effect now.
    const reactionKey = reactionKeyOf(event)
    const duplicate = reactionKey ? deps.queue.lookupReactionKey(key, reactionKey) : undefined
    if (duplicate && duplicate.status !== 'failed') return duplicate.item
    const config = deps.getPersonaConfig()
    const persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return undefined
    const decision = decideReactionFor(event, key, config, persona, 'slack-event', isExtSharedChannel)
    if (decision.action === 'drop') { logReactionDrop(persona, event, decision); return undefined }
    let result: QueueAcceptResult
    try { result = await deps.queue.accept(key, reactionAcceptedInputOf(decision, (deps.now ?? Date.now)())) } catch (err) {
      safeLog(() => `[slack] persona-routing: reaction store failed for persona ${refForKey(key)} — not acked, so Slack sends it again${describeSlackCallFailure(err)}`)
      return 'store-failed'
    }
    if (result.status === 'failed') return 'store-failed'
    // A duplicate here lost a race to a concurrent copy, which logged its line.
    logReactionReceived(persona, result)
    return result.item
  }

  async function receiveBotToolReaction(key: string, input: BotToolReactionInput): Promise<BotToolReactionIntakeResult> {
    let taken: { result: BotToolReactionIntakeResult; retained?: QueueItem }
    try {
      taken = await takeBotToolReaction(key, input)
    } catch (err) {
      safeLog(() => buildBotToolReactionErrorLine(refForKey(key), describeSlackCallFailure(err)))
      return { status: 'store-failed' }
    }
    const { result, retained } = taken
    if (retained === undefined || retained.fixed || isQueueItemClosed(retained)) return result
    try { await deps.prepare(key, retained) } catch (err) {
      safeLog(() => `[slack] persona-routing: post-accept reaction preparation failed${describeSlackCallFailure(err)}`)
    }
    return result
  }

  /**
   * Everything before a `bot-tool` reaction's preparation: its result, and
   * the retained item to prepare (absent for a drop, a failure, or a
   * duplicate kept only as its key). The queue logs a failed store itself.
   */
  async function takeBotToolReaction(key: string, input: BotToolReactionInput): Promise<{ result: BotToolReactionIntakeResult; retained?: QueueItem }> {
    // Copied now, so a later change to the caller's object cannot relabel accepted work.
    const reactorPersonaName = input.reactorPersonaName
    const event = botToolReactionEventOf(input)
    // The durable key check comes before the decision, as for Slack events.
    const reactionKey = reactionKeyOf(event)
    const duplicate = reactionKey ? deps.queue.lookupReactionKey(key, reactionKey) : undefined
    if (duplicate?.status === 'failed') return { result: { status: 'store-failed' } }
    if (duplicate) return { result: { status: 'duplicate', seq: duplicate.seq }, retained: duplicate.item }
    const config = deps.getPersonaConfig()
    const persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return { result: { status: 'dropped' } }
    const decision = decideReactionFor(event, key, config, persona, 'bot-tool')
    if (decision.action === 'drop') { logReactionDrop(persona, event, decision); return { result: { status: 'dropped' } } }
    let result: QueueAcceptResult
    try {
      result = await deps.queue.accept(key, { ...reactionAcceptedInputOf(decision, (deps.now ?? Date.now)()), reactor_persona_name: reactorPersonaName })
    } catch (err) {
      safeLog(() => buildBotToolReactionStoreFailedLine(refForKey(key), describeSlackCallFailure(err)))
      return { result: { status: 'store-failed' } }
    }
    if (result.status === 'failed') return { result: { status: 'store-failed' } }
    if (result.status === 'duplicate') return { result: { status: 'duplicate', seq: result.seq }, retained: result.item }
    logReactionReceived(persona, result)
    return { result: { status: 'stored', seq: result.seq }, retained: result.item }
  }

  /**
   * `decideReaction` for persona `key` under the configuration in effect now:
   * its channels, DMs switch and confirmed bot user ID, the mode,
   * `CHANNEL_ID_RE` and the Run Bot Identities. A `bot-tool` reaction has no
   * envelope flag.
   */
  function decideReactionFor(
    event: unknown,
    key: string,
    config: PersonaRoutingConfig,
    persona: Persona,
    origin: ReactionDecisionOrigin,
    isExtSharedChannel?: unknown,
  ): ReactionDecision {
    const identity = deps.getBotIdentity(key)
    // Extension point. A `notices-off` drop (the persona's reaction notices
    // switch) belongs in decideReaction after its reactor rules and before its
    // conversation rules, for both origins; this then passes the switch in
    // effect, and logReactionDrop logs it with its own reaction-dropped variant.
    return decideReaction(event, { key, botUserId: identity?.botUserId, channels: persona.channels, dmEnabled: persona.dm.enabled }, {
      mode: channelModeOf(config),
      origin,
      channelIdPattern: CHANNEL_ID_RE,
      isExtSharedChannel,
      isRunBotIdentity: (id) => deps.isRunBotIdentity?.(id) ?? true,
    })
  }

  /** One `reaction-received` line for a newly stored Reaction Item; a duplicate logs none. */
  function logReactionReceived(persona: Persona, result: QueueAcceptResult): void {
    if (result.status !== 'accepted') return
    const stored = result.item
    if (stored?.accepted.source === 'reaction') {
      safeLog(() => buildReactionReceivedLine({ key: persona.key, name: persona.name }, stored.accepted as ReactionAcceptedRecord))
    }
  }

  /** One `reaction-dropped` line for a logged reason; the other reasons log nothing. */
  function logReactionDrop(persona: Persona, event: unknown, decision: ReactionDropDecision): void {
    const at = reactedMessageOf(event)
    let drop: ReactionDroppedInput
    switch (decision.reason) {
      case 'not-a-message-reaction':
      case 'not-own-message':
      case 'own-reaction':
      case 'bot-reaction':
        return
      case 'fungible-refused':
        drop = { reason: decision.reason, refusal: decision.refusal, ...at }
        break
      default:
        drop = { reason: decision.reason, ...at }
    }
    safeLog(() => buildReactionDroppedLine({ key: persona.key, name: persona.name }, drop))
  }

  /**
   * The decision's fungible-mode inputs,
   * built only in fungible mode, from the configuration in effect and the
   * stored choices read now: the mode, the envelope flag as received,
   * `CHANNEL_ID_RE`, the stored choices, and each applied persona's
   * destination through the one destination rule. Undefined in declarative
   * mode, so the decision is declarative mode's and nothing of the fungible
   * section is read.
   */
  function fungibleInputs(
    config: PersonaRoutingConfig,
    mode: ChannelMode,
    isExtSharedChannel: unknown,
  ): FungibleDecisionInputs | undefined {
    if (mode !== FUNGIBLE_MODE) return undefined
    return {
      mode,
      isExtSharedChannel,
      channelIdPattern: CHANNEL_ID_RE,
      storedChoices: deps.getChannelDelivery?.() ?? undefined,
      fungibleDestinations: fungibleDestinationsOf(config, config.personas),
    }
  }

  /**
   * the first event in P's life that took P's fungible path
   * for `channel` adds it to P's heard set and logs one
   * `persona-invited-channel` line, before any drop line or dispatch. Later
   * events from that channel log nothing here.
   */
  function logFirstHeard(persona: Persona, channel: string, path: FungiblePath): void {
    let heard = heardSets.get(persona.key)
    if (!heard) {
      heard = new Set()
      heardSets.set(persona.key, heard)
    }
    if (heard.has(channel)) return
    heard.add(channel)
    deps.log(formatPersonaDiagnostic({
      class: PERSONA_INVITED_CHANNEL,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      cause: invitedChannelCause(channel, path.channelType, path.channelDelivery),
    }))
  }

  function logDrop(persona: Persona, ev: Record<string, unknown>, decision: DropDecision): void {
    const channel = String(ev['channel'])
    switch (decision.reason) {
      case 'channel-not-configured':
        // A channel another applied persona lists is that persona's: no line.
        if (!decision.unclaimed) return
        deps.log(formatPersonaDiagnostic({
          class: UNCLAIMED_CHANNEL,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: unclaimedChannelCause(channel),
        }))
        return
      case 'fungible-refused':
        // one line naming the refusal's reason.
        deps.log(formatPersonaDiagnostic({
          class: UNCLAIMED_CHANNEL,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: fungibleUnclaimedChannelCause(channel, decision.refusal),
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

  /** Existing recovery state/row read, only after durable acceptance and ack. */
  async function handleLostMessage(
    persona: Persona,
    cwd: string,
    config: PersonaRoutingConfig,
  ): Promise<void> {
    const key = persona.key
    const early = earlyQueries(key)
    // arm a stopped retry first, so the gated check sees it.
    armStoppedRetryBeforeDecision(key)
    const readRow = shouldReadRow(key, early)
    const rowReadPending = readRow ? await readRowOnce(persona) : false
    // The read was awaited, so P's retry may have stopped meanwhile: ask again.
    if (readRow) armStoppedRetryBeforeDecision(key)
    // The final decision: every query is asked afresh here, after the read.
    const state = decideLostMessageState({
      ...early,
      isSequenceOrWaitRunning: () => deps.isSequenceOrWaitRunning?.(key) === true,
      isRowPending: () => rowReadPending || deps.isLaunchRunning?.(key) === true,
      isRestartPending: () => isRestartPendingOrActive(key),
      isAutoRestartDisabled: () => config.session_restart_delay === 0,
      isAtRestartLimit: () => isAtCap(key, RESTART_FAILURE_CAP),
    })
    // Nothing is awaited between the decision above and this call.
    if (firesHumanTriggeredRestart(state)) scheduleRestart(key, cwd, undefined, { humanTrigger: true })
  }

  /**
   * The queries of states 1 to 5 for persona `key`, each
   * asked at call time, so the gate and the final decision both read fresh
   * answers. State 5's query is gated on the restart cap and P's retry
   * timer (`isNotAnswering`).
   */
  function earlyQueries(key: string): EarlyLostMessageQueries {
    return {
      ...earlyQueriesBeforeState5(key),
      isNotAnswering: () => isNotAnswering(key),
    }
  }

  /** The queries of states 1 to 4 for persona `key`, each asked at call time. */
  function earlyQueriesBeforeState5(key: string): EarlyLostMessageQueries {
    return {
      isNotUp: () => deps.isPersonaUp?.(key) === false,
      isLatched: () => deps.isLatched?.(key) === true,
      isHeldOnInvalidFlags: () => deps.isHeldOnInvalidFlags?.(key) === true,
      isKillFailed: () => deps.isKillFailed?.(key) === true,
    }
  }

  /**
   * asked before a lost message's state is decided: when the
   * state would be `not-answering` but for the retry-timer gate (none of
   * states 1 to 4 applies and state 5's condition holds), P's
   * `tmux-unavailable` flag is raised and P is below the restart cap
   * ask `armRetryTimerIfMissing` for P, so the gated decision
   * that follows sees the timer it armed. At the cap nothing is armed: a
   * timer armed there would stop at its first retry, and P reports
   * `restart-limit-reached`. Never schedules a restart.
   */
  function armStoppedRetryBeforeDecision(key: string): void {
    const arm = deps.armRetryTimerIfMissing
    if (arm === undefined) return
    if (decideEarlyLostMessageState(earlyQueriesBeforeState5(key)) !== undefined) return
    if (!notAnsweringConditionHolds(key)) return
    if (!getOutageFlags(key).has('tmux-unavailable')) return
    if (isAtCap(key, RESTART_FAILURE_CAP)) return
    arm(key)
  }

  /**
   * The read gate: true when the row read is injected, none
   * of states 1 to 5 applies (`decideEarlyLostMessageState`), no launch or
   * approver for P runs, no live-row sequence or old-life wait step runs for
   * P, and nothing is in flight for P.
   */
  function shouldReadRow(key: string, early: EarlyLostMessageQueries): boolean {
    if (deps.readRowLiveness === undefined) return false
    if (decideEarlyLostMessageState(early) !== undefined) return false
    if (deps.isLaunchRunning?.(key) === true) return false
    if (deps.isSequenceOrWaitRunning?.(key) === true) return false
    return deps.isWorkInFlight?.(key) !== true
  }

  /**
   * The one row read of P for a lost message: true when it
   * answers `pending` (the `session-starting` input). Any other reading
   * (`live`, `dead`, `unknown`) leaves that state out, and so does a
   * rejection, which is caught, logged once with its description redacted
   * (`describeAgentDirectorFailure`) and never thrown. The read is outside
   * any launch or recovery attempt: the reader
   * decides what its answer raises or arms, and this module only reads the
   * reading. The restart path's own read still keeps any launch off a
   * `pending` row after a failed read here.
   */
  async function readRowOnce(persona: Persona): Promise<boolean> {
    const read = deps.readRowLiveness
    if (read === undefined) return false
    try {
      const reading = await read(persona.key)
      return livenessKindOf(reading) === LIVENESS_PENDING
    } catch (err) {
      deps.log(
        `[slack] persona-routing: lost-message row read for persona ${renderPersonaRef(persona.name, persona.key)} ` +
        `failed — session-starting left out: ${describeAgentDirectorFailure(err)}`,
      )
      return false
    }
  }

  /**
   * state 5 ("state 5 applies only while P's
   * retry timer is armed"): state 5's condition holds for persona `key`
   * (`notAnsweringConditionHolds`), P is below the restart cap (
   * `isAtCap(key, RESTART_FAILURE_CAP)`) and its retry timer is armed
   * (`isRetryArmed` answers exactly true). A P at the cap is never in state
   * 5, even while a timer is still armed for it (that timer stops at its
   * next retry), and neither is a P whose retry timer is not armed, whatever
   * condition or flag is raised. With `isRetryArmed` absent (hand-built
   * fixtures) the armed-timer part is not asked; the cap part always is.
   */
  function isNotAnswering(key: string): boolean {
    if (!notAnsweringConditionHolds(key)) return false
    if (isAtCap(key, RESTART_FAILURE_CAP)) return false
    return deps.isRetryArmed === undefined || deps.isRetryArmed(key) === true
  }

  /**
   * State 5's condition, before the cap and retry-timer gates:
   * persona `key`'s `tmux-unresponsive` condition holds, or its
   * `tmux-unavailable` or `ad-config-malformed` outage flag is raised. No other outage class and no unclassified-error
   * episode counts.
   */
  function notAnsweringConditionHolds(key: string): boolean {
    if (deps.isTmuxUnresponsive?.(key) === true) return true
    const flags = getOutageFlags(key)
    return flags.has('tmux-unavailable') || flags.has('ad-config-malformed')
  }

  return {
    receive,
    receiveReaction,
    receiveBotToolReaction,
    forget: (key) => {
      heardSets.delete(key)
    },
    heardChannels: (key) => new Set(heardSets.get(key)),
  }
}

/** The fungible-path part of a decision, or undefined when the event did not take the path. */
function fungiblePathOf(decision: DeliveryDecision): FungiblePath | undefined {
  return 'fungible' in decision ? decision.fungible : undefined
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/**
 * The event's top-level `edited.ts`, or undefined when `edited` is absent or
 * not an object. Only the top level is read: a `message_changed` event nests
 * its edit under `message.edited` and keeps its own key.
 */
function editedTs(ev: Record<string, unknown>): unknown {
  const edited = ev['edited']
  return typeof edited === 'object' && edited !== null ? (edited as Record<string, unknown>)['ts'] : undefined
}

/**
 * The reaction key a reaction event names, from its shape alone: `item.channel`,
 * `item.ts`, the reactor (a non-empty `user`, else `bot_id`), `reaction`, the
 * change its type makes and `event_ts`. Undefined when any part is missing or
 * not a non-empty string; the decision then drops it.
 */
function reactionKeyOf(event: unknown): ReactionKey | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const ev = event as Record<string, unknown>
  const change = ev['type'] === 'reaction_added' ? 'added' : ev['type'] === 'reaction_removed' ? 'removed' : undefined
  const { chat_id, message_ts } = reactedMessageOf(event)
  const user = ev['user']
  const reactor = typeof user === 'string' && user !== '' ? user : ev['bot_id']
  const key = { chat_id, message_ts, reactor, emoji: ev['reaction'], change, event_ts: ev['event_ts'] }
  return isReactionKey(key) ? key : undefined
}

/**
 * A `bot-tool` reaction as the Slack-shaped event the decision and the
 * reaction key read, with no envelope: each field copied from `input` now.
 */
function botToolReactionEventOf(input: BotToolReactionInput): Record<string, unknown> {
  return {
    type: BOT_TOOL_EVENT_TYPES[input.change],
    item: { type: 'message', channel: input.channel, ts: input.messageTs },
    item_user: input.messageAuthorUserId,
    user: input.reactorUserId,
    reaction: input.emoji,
    event_ts: input.eventTs,
  }
}

/**
 * The Reaction Item an accepted reaction is stored as: the decision's facts,
 * one reactor field, its origin and mode, the reaction key made of the same
 * facts, empty text and `receivedAt`.
 */
function reactionAcceptedInputOf(decision: ReactionAcceptDecision, receivedAt: number): ReactionAcceptedInput {
  const reactorId = decision.user ?? decision.bot_id
  return {
    source: 'reaction', text: '', channel: decision.channel, message_ts: decision.message_ts, ts: decision.ts,
    change: decision.change, emoji: decision.emoji, ...(decision.user !== undefined ? { user: decision.user } : { bot_id: reactorId }),
    origin: decision.origin, mode: decision.mode,
    reaction_key: { chat_id: decision.channel, message_ts: decision.message_ts, reactor: reactorId, emoji: decision.emoji, change: decision.change, event_ts: decision.ts },
    received_at: receivedAt,
  }
}

/** A reaction event's `item.channel` and `item.ts`, each when it is a string. */
function reactedMessageOf(event: unknown): { chat_id?: string; message_ts?: string } {
  const item = typeof event === 'object' && event !== null ? (event as Record<string, unknown>)['item'] : undefined
  if (typeof item !== 'object' || item === null) return {}
  const channel = (item as Record<string, unknown>)['channel'], ts = (item as Record<string, unknown>)['ts']
  return { ...(typeof channel === 'string' ? { chat_id: channel } : {}), ...(typeof ts === 'string' ? { message_ts: ts } : {}) }
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
