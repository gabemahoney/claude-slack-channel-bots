/** Durable Slack intake and existing message-triggered recovery. Hybrid-channel
 * decisions, joins, Post Holds and Memory Holds share the queue's writer turn.
 * Holds are acknowledged on storage and enter reporting/preparation only on
 * release; nothing before the ack waits on a post's outcome. */
import {
  CHANNEL_ID_RE,
  DEFAULT_QUEUED_ACK_REACTION,
  channelModeOf,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import type { ChannelMembership, MembershipReading } from './channel-membership.ts'
import type { PersonaEventProvenance } from './persona-connections.ts'
import {
  decideDelivery,
  channelDeliveryFor,
  decideReaction,
  isOwn,
  isThreadTimestamp,
  parseReactionShape,
  REACTION_ADDED_EVENT,
  type DeliveryDecision,
  type DropDecision,
  type FungibleDecisionInputs,
  type FungiblePath,
  type OwnPostsDecisionInput,
  type ReactionAcceptDecision,
  type ReactionDecision,
  type ReactionDecisionOrigin,
  type ReactionDropDecision,
  type ParsedReactionShape,
  type StoredChoices,
} from './delivery-decision.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  formatPersonaDiagnostic,
  buildPostAcceptPreparationFailedLine,
  PERSONA_THREAD_STAMP_UNDECIDED,
  threadStampUndecidedCause,
  fungibleUnclaimedChannelCause,
  openChannelCause,
  PERSONA_DM_DROPPED,
  PERSONA_OPEN_CHANNEL,
  UNCLAIMED_CHANNEL,
  unclaimedChannelCause,
} from './persona-diagnostics.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { isOpenItem, isQueueItemClosed, type DeliveryQueue, type QueueAcceptDecision, type QueueAcceptResult, type QueueDecidedResult, type QueueItem, type AcceptedInput, type ReactionAcceptedInput, type ReactionAcceptedRecord, type ReactionKey, type SlackKey } from './delivery-queue.ts'
import {
  buildBotToolReactionErrorLine,
  buildBotToolReactionStoreFailedLine,
  buildReactionDroppedLine,
  buildReactionEventErrorLine,
  buildReactionAckFailedLine,
  buildReactionPreparationFailedLine,
  buildReactionStoreFailedLine,
  buildReactionReceivedLine,
  type ReactionDroppedInput,
  type ReactionIntakePersona,
} from './reaction-intake-diagnostics.ts'
import { OWN_ROOT_CLOCK_SKEW_MS } from './delivery-constants.ts'
import type { ThreadMemory, ThreadJoin, ThreadMemoryStampState } from './thread-memory.ts'
import type { PostHoldResolver } from './post-holds.ts'
import type { OwnPostJoins } from './own-post.ts'
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
import type { ThreadStampUndecidedEpisodes } from './persona-episodes.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Author shown in a drop line for an event with neither `user` nor `bot_id`. */
const NO_AUTHOR_PLACEHOLDER = '(none)'

/** The `type` of an `app_mention` event. */
const APP_MENTION_EVENT_TYPE = 'app_mention'

/** The channel mode in which a persona serves the channels its app is in. */
const FUNGIBLE_MODE: ChannelMode = 'open'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack `ack` handed over with a Socket Mode event. */
export type SlackAck = () => Promise<void> | void

/**
 * One event's acknowledgement timing. `targets` are the queue items the event
 * stored or matched, ordered by key then seq; `ts` is the event's own `ts`
 * when it has one. `receiveToAckMs` ends when the ack is called, or when a
 * failed store suppresses it; `ackCallMs` is the ack call itself.
 */
export interface AckTiming {
  keys: string[]; ts?: string; targets: Array<{ key: string; seq: number }>
  outcome: 'acked' | 'ack-failed' | 'suppressed'
  receiveToAckMs: number; ackCallMs?: number; atMonoMs: number
}

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
 * delay, and the `channel_mode` switch, read through
 * `channelModeOf` at each event.
 */
export type PersonaRoutingConfig = Pick<PersonaConfig, 'personas' | 'session_restart_delay' | 'channel_mode'> & Partial<Pick<PersonaConfig, 'queued_ack_reaction'>>
export interface RoutingThreadJoins extends Pick<ThreadMemory, 'hasSavedJoin' | 'clock' | 'addJoin' | 'saveJoins'> {
  stamp(key: string, channel: string): ThreadMemoryStampState | undefined
}
interface SerialSelection {
  persona?: Persona
  decision?: DeliveryDecision
  stampDecided?: boolean
  requestMembership?: boolean
  input?: AcceptedInput
  join?: ThreadJoin
}
/** One event's intake across its receiving personas, gathered for the common completion. */
interface IntakeRun {
  isExtSharedChannel: unknown
  provenance: PersonaEventProvenance | undefined
  /** Receipt on `monotonicNow`: the Post Hold deadline's start and the ack timing's. */
  receivedAt: number | undefined
  /** The stored or matched targets, kept only for the ack timing observer. */
  ackTargets: Array<{ key: string; seq: number }> | undefined
  /** Retained targets' queued feedback and join saves, on either completion path. */
  accepted: Array<() => void>
  saveJoins: Array<() => void>
  /** Retained targets' recovery and preparation, only after an ack attempt. */
  afterAck: Array<() => Promise<void>>
  /** Keys whose target is a stored, unresolved hold. */
  heldKeys: Set<string>
  /** A failed or undecidable target suppresses the aggregate ack. */
  storeFailed: boolean
}
/** The outcome retention a Post Hold's decision took. Intake owns it until `held` takes it. */
interface DecidedRetention { release?: () => void }
type StoredResult = Extract<QueueAcceptResult, { status: 'accepted' | 'duplicate' }>

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** Receipt time for the Post Hold deadline, before the serial intake wait. */
  monotonicNow?: () => number
  /**
   * Test-only (`test_measurement_timings`): the observer told, after the ack attempt
   * or its suppression, how long the event took from receipt on
   * `monotonicNow`. Asked once at receipt; with none (the default), receive
   * reads no further clock. The observer's throw is ignored.
   */
  ackTiming?(): ((timing: AckTiming) => void) | undefined
  /**
   * Registers each stored Post Hold in its store's synchronous turn, with
   * monotonicNow's receipt time, handing over the outcome retention its
   * decision took. A throw releases that retention; it cannot undo the store.
   */
  postHolds?: Pick<PostHoldResolver, 'held'>
  /** Read the live Thread Memory view only when the decision needs a reply's membership. */
  threadMemory?: FungibleDecisionInputs['threadMemory']
  /** P's in-memory Pending Own Posts, read only for a reply not known to be joined. No I/O. */
  pendingOwnPosts?: OwnPostsDecisionInput['pending']
  /**
   * The same owner's outcome retention, taken in a Post Hold's decision
   * callback before its store so an outcome landing during the store is kept.
   * The successful store hands it to `postHolds.held`; every other ending
   * releases it. Absent: nothing is retained.
   */
  retainOwnPostOutcomes?: OwnPostJoins['retainOutcomes']
  /** Join reads/additions are synchronous; saves run only after the ack attempt. */
  joins?: RoutingThreadJoins
  /** Pure stamp observation; independent selection never depends on it. */
  threadStampUndecided?(key: string, channel: string): boolean
  /** Shared log-only episode owner. Absent fixtures still hold intake, without the diagnostic. */
  threadStampEpisodes?: ThreadStampUndecidedEpisodes
  membership?: Pick<ChannelMembership, 'read' | 'hasUnresolved' | 'request'>
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /**
   * P's bot identity (bot user ID and bot ID; the placeholder identity in dry
   * run), or undefined when it is not known.
   */
  getBotIdentity(key: string): SlackBotIdentity | undefined
  /** Shared queue; acceptance does no network I/O. */
  queue: Pick<DeliveryQueue, 'accept' | 'acceptDecided' | 'lookupSlackKey' | 'lookupReactionKey'>
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
  onReceived?(key: string, item: QueueItem, mode?: 'live' | 'recovered'): void
  /** Once per key with a stored, unresolved hold, after the ack attempt or when
   * a sibling's failed store suppresses the ack. Not awaited; its throw is ignored. */
  onHoldStored?(key: string): void | Promise<unknown>
  /** Fire-and-forget archive, before the decision, with no pre-ack await. */
  archive(key: string, event: unknown): void
  /**
   * P's own message on P's connection, with the identity the decision uses.
   * Called synchronously inside intake, once per recipient and event, before
   * the decision; it reads and updates in-memory state and may start Thread
   * Memory appends without awaiting them (Task rb Decision 3). It awaits
   * nothing, calls no Slack method, and its throw is ignored. The decision
   * still drops the event as P's own.
   */
  onOwnMessage?(key: string, event: Record<string, unknown>, identity: SlackBotIdentity): void
  /** Writes one log line. */
  log(line: string): void
  /** Intake clock in epoch milliseconds. */
  now?: () => number
  /**
   * The shared authority's read-only choice projection. Read in both modes
   * for each event; routing never writes or drops from it. An absent or
   * unreadable projection leaves channel selection unresolved. DMs depend
   * only on their own applied settings, not a channel choice or membership.
   */
  getChannelDelivery?(): StoredChoices | null | undefined
  /**
   * Whether persona P is up (production: the server's one
   * `isPersonaUp` predicate), asked for a lost message only: a message lost
   * for a persona that is not up schedules no restart and reports the
   * `not-up` recovery state. Intake does not ask it: a not-up persona's
   * new messages are stored, acknowledged and queued. Without it
   * every persona counts as up.
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
   * targets, add any in-memory join, ack only after every store succeeds, then
   * save joins, report, recover and fix text. Hybrid-channel key checks,
   * decisions, stores and joins share each persona's serial queue turn;
   * other events retain their outside key check and decision. Stored Post and
   * Memory Holds get the ack, but no reporting or preparation until release.
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
    provenance?: PersonaEventProvenance,
  ): Promise<void>
  releaseHeld(key: string, item: QueueItem, mode: 'live' | 'recovered'): Promise<void>
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
   * events took its open path in its current persona life. Empty for an
   * unknown or forgotten key; creates no state. Diagnostic only: it
   * establishes neither current membership nor `set_channel_delivery`
   * authorization.
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
  /** Diagnostics must never interrupt intake, ack, reporting or preparation. */
  function log(line: string): void {
    try { deps.log(line) } catch { /* non-critical */ }
  }
  function reportReceived(key: string, item: QueueItem, mode: 'live' | 'recovered' = 'live'): void {
    try { void Promise.resolve(deps.onReceived?.(key, item, mode)).catch(() => {}) } catch { /* reporting cannot prevent preparation */ }
  }
  async function postAccepted(key: string, item: QueueItem, mode: 'live' | 'recovered'): Promise<void> {
    if (!isOpenItem(item)) return
    const posted = postAcked.get(key) ?? new Set<number>()
    if (posted.has(item.accepted.seq)) return
    posted.add(item.accepted.seq); postAcked.set(key, posted)
    const config = deps.getPersonaConfig(), persona = config?.personas.find(p => p.key === key)
    const session = getSessionByPersona(key)
    if (mode === 'live' && persona && config && (!session || !session.connected)) await handleLostMessage(persona, persona.working_directory, config)
    if (postAcked.get(key) !== posted) return
    await deps.prepare(key, item)
  }
  /** The persona reference for a key: its rendered name when applied, else the bare key. */
  function refForKey(key: string): string {
    const persona = deps.getPersonaConfig()?.personas.find((p) => p.key === key)
    return persona ? renderPersonaRef(persona.name, persona.key) : `key=${key}`
  }
  /** The identity the decision uses for a key: the provenance's when it is that key's, else the current one. */
  function identityFor(key: string, provenance: PersonaEventProvenance | undefined): SlackBotIdentity | undefined {
    return provenance?.key === key ? provenance.identity : deps.getBotIdentity(key)
  }

  /** Hand one event's ack timing to the test-only observer; the second reading ends the ack call or the suppression. */
  function reportAckTiming(
    observer: (timing: AckTiming) => void, event: unknown, personaKeys: string | readonly string[], receivedAt: number,
    targets: Array<{ key: string; seq: number }>, outcome: AckTiming['outcome'], ackCalledAt?: number,
  ): void {
    try {
      const atMonoMs = deps.monotonicNow!()
      const ts = typeof event === 'object' && event !== null ? (event as Record<string, unknown>)['ts'] : undefined
      observer({
        keys: typeof personaKeys === 'string' ? [personaKeys] : [...personaKeys],
        ...(typeof ts === 'string' ? { ts } : {}),
        targets: [...targets].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.seq - b.seq),
        outcome, receiveToAckMs: (ackCalledAt ?? atMonoMs) - receivedAt,
        ...(ackCalledAt !== undefined ? { ackCallMs: atMonoMs - ackCalledAt } : {}), atMonoMs,
      })
    } catch { /* a measurement cannot change intake */ }
  }

  /** Reaction builders own persona rendering, including the key-only fallback. */
  function reactionPersonaForKey(key: string): ReactionIntakePersona {
    const persona = deps.getPersonaConfig()?.personas.find(p => p.key === key)
    return { key, name: persona?.name }
  }

  async function receive(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
    provenance?: PersonaEventProvenance,
  ): Promise<void> {
    const receivedAt = deps.monotonicNow?.()
    if (provenance?.candidate) { deps.membership?.request(provenance.key); return }
    if (provenance?.applied && !provenance.isCurrent()) { await ack(); return }
    if (provenance && !provenance.applied) return
    const ackTiming = receivedAt !== undefined ? deps.ackTiming?.() : undefined
    const run: IntakeRun = {
      isExtSharedChannel, provenance, receivedAt, ackTargets: ackTiming ? [] : undefined,
      accepted: [], saveJoins: [], afterAck: [], heldKeys: new Set(), storeFailed: false,
    }
    if (typeof event === 'object' && event !== null) {
      const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
      await Promise.all(keys.map(key => intakeFor(run, key, event as Record<string, unknown>)))
    }
    // A failed sibling suppresses the aggregate ack, but retained targets still
    // deserve queued feedback, and stored holds still resolve. Preparation and
    // recovery continue only after an ack.
    if (run.storeFailed) {
      if (ackTiming) reportAckTiming(ackTiming, event, personaKeys, receivedAt!, run.ackTargets!, 'suppressed')
      completeRetained(run)
      return
    }
    const ackCalledAt = ackTiming ? deps.monotonicNow!() : undefined
    let ackFailed = false
    try { await ack() } catch (err) { ackFailed = true; log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`) }
    if (ackTiming) reportAckTiming(ackTiming, event, personaKeys, receivedAt!, run.ackTargets!, ackFailed ? 'ack-failed' : 'acked', ackCalledAt)
    completeRetained(run)
    await Promise.all(run.afterAck.map(async work => {
      try { await work() } catch (err) { log(buildPostAcceptPreparationFailedLine(describeSlackCallFailure(err))) }
    }))
  }

  /** One receiving persona: archive, the own-message hook, then its target's intake path. */
  async function intakeFor(run: IntakeRun, key: string, ev: Record<string, unknown>): Promise<void> {
    try { deps.archive(key, ev) } catch (err) {
      log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    // One entry for both intake paths, outside the serial decision callback.
    try {
      const identity = identityFor(key, run.provenance)
      if (deps.onOwnMessage && identity && isOwn(typeof ev['user'] === 'string' ? ev['user'] : undefined,
        typeof ev['bot_id'] === 'string' ? ev['bot_id'] : undefined, identity)) deps.onOwnMessage(key, ev, identity)
    } catch { /* the event is handled as before */ }
    try { await routeTarget(run, key, ev) } catch (err) {
      // A failed selection is undecidable, never permission to discard.
      run.storeFailed = true
      log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
  }

  /** The target's path: the serial writer turn, a retained duplicate, or the independent decision. */
  function routeTarget(run: IntakeRun, key: string, ev: Record<string, unknown>): Promise<void> | undefined {
    const config = deps.getPersonaConfig()
    const mode = channelModeOf(config)
    if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
    const slackKey = typeof ev['channel'] === 'string' && typeof ev['ts'] === 'string'
      ? { chat_id: ev['channel'], ts: ev['ts'], ...(typeof editedTs(ev) === 'string' ? { edited_ts: editedTs(ev) as string } : {}) } : undefined
    if (usesSerialIntake(key, ev, mode, run.isExtSharedChannel)) return serialIntake(run, key, ev, slackKey)
    // A retry after partial fanout must prepare the already retained, unfixed target too.
    const duplicate = slackKey ? deps.queue.lookupSlackKey(key, slackKey) : undefined
    if (duplicate && duplicate.status !== 'failed') { noteStored(run, key, slackKey, duplicate); return }
    const persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return
    return independentIntake(run, key, ev, slackKey, config, persona, mode)
  }

  /**
   * Hybrid-channel intake: key check, decision, store and join share P's
   * writer turn. A Post Hold's outcome retention is intake's until its
   * store's afterStore hands it to `held`; any other ending releases it.
   */
  async function serialIntake(run: IntakeRun, key: string, ev: Record<string, unknown>, slackKey: SlackKey | undefined): Promise<void> {
    let selection: SerialSelection | undefined
    let result: QueueDecidedResult<SerialSelection>
    const retention: DecidedRetention = {}
    try {
      result = await deps.queue.acceptDecided<SerialSelection>(key, slackKey, () => {
        selection = decideSerialIntake(key, ev, slackKey, run.isExtSharedChannel, run.provenance)
        return selection.input ? serialStore(key, selection.input, selection.join, run.receivedAt, retention) : { skip: selection }
      }, typeof ev['channel'] === 'string' && typeof (ev['thread_ts'] ?? ev['ts']) === 'string'
        ? { channel: ev['channel'], root: (ev['thread_ts'] ?? ev['ts']) as string } : undefined)
    } finally { releaseDecided(retention) }
    if (selection) reportSerialSelection(key, ev, slackKey, selection)
    if (selection?.requestMembership || result.status === 'failed') run.storeFailed = true
    if (result.status === 'skipped' || result.status === 'failed') return
    if (result.status === 'accepted' && selection?.join) {
      const fact = selection.join
      run.saveJoins.push(() => {
        try { void deps.joins?.saveJoins(key, [fact]).catch(() => {}) } catch { /* kept join is recovered independently */ }
      })
    }
    noteStored(run, key, slackKey, result)
  }

  /** The selected input's store and its applied afterStore effect, in the writer turn. */
  function serialStore(
    key: string, input: AcceptedInput, join: ThreadJoin | undefined, receivedAt: number | undefined, retention: DecidedRetention,
  ): QueueAcceptDecision<SerialSelection> {
    const hold = input.hold, postHolds = deps.postHolds
    if (hold?.on === 'post' && postHolds && receivedAt !== undefined) {
      // Before the store: an outcome that lands during its fsync must survive it.
      retainDecided(retention, key, hold.operations)
      return { store: input, effectThread: { channel: input.channel!, root: hold.thread_ts }, afterStore: ({ seq }) => {
        const handed = retention.release ?? NO_RETENTION
        retention.release = undefined
        try {
          postHolds.held(key, { seq, operations: hold.operations, threadRoot: hold.thread_ts, rootUnknown: hold.root_unknown, receivedAt }, handed)
        } catch { releaseQuietly(handed) /* cannot undo the store or suppress its ack */ }
      } }
    }
    return { store: input, ...(join ? { effectThread: { channel: join.channel, root: join.root }, afterStore: () => { deps.joins?.addJoin(key, join) } } : {}) }
  }

  /** Take the owner's outcome retention for a Post Hold's operations, replacing any earlier one. */
  function retainDecided(retention: DecidedRetention, key: string, operations: readonly string[]): void {
    releaseDecided(retention)
    try { retention.release = deps.retainOwnPostOutcomes?.(key, operations) } catch { /* the hold still resolves by its deadline */ }
  }

  /** Release a retention `held` did not take. The owner's handle is idempotent and life-scoped. */
  function releaseDecided(retention: DecidedRetention): void {
    const release = retention.release
    retention.release = undefined
    if (release) releaseQuietly(release)
  }

  /** A stored or matched target's ack timing, hold notification, queued feedback and preparation. */
  function noteStored(run: IntakeRun, key: string, slackKey: SlackKey | undefined, result: StoredResult): void {
    const item = result.item
    if (item) run.ackTargets?.push({ key, seq: item.accepted.seq })
    // Any unresolved hold, Post or Memory, is acknowledged but not open work.
    if (item?.hold?.state === 'unresolved') run.heldKeys.add(key)
    if (item && isOpenItem(item) && (result.status !== 'duplicate' || !item.fixed)) retainTarget(run, key, item)
    if (result.status === 'duplicate' && slackKey && deps.membership?.hasUnresolved(key, slackKey.chat_id)) requestMembership(run, key)
  }

  /** A retained target: queued feedback on either completion path, recovery and preparation after an ack. */
  function retainTarget(run: IntakeRun, key: string, item: QueueItem): void {
    run.accepted.push(() => reportReceived(key, item))
    run.afterAck.push(() => postAccepted(key, item, 'live'))
  }

  /** An undecided membership withholds the aggregate ack until Slack's retry. */
  function requestMembership(run: IntakeRun, key: string): void {
    run.storeFailed = true
    deps.membership?.request(key)
  }

  /** The decision outside the writer turn, for a target the serial path does not take. */
  async function independentIntake(
    run: IntakeRun, key: string, ev: Record<string, unknown>, slackKey: SlackKey | undefined,
    config: PersonaRoutingConfig, persona: Persona, mode: ChannelMode,
  ): Promise<void> {
    if (slackKey && deps.threadStampUndecided?.(key, slackKey.chat_id) !== true) deps.threadStampEpisodes?.end(key, slackKey.chat_id)
    const identity = identityFor(key, run.provenance)
    const decision = decideDelivery(ev, { key, botUserId: identity?.botUserId, botId: identity?.botId, channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, fungibleInputs(config, mode, run.isExtSharedChannel, slackKey?.chat_id))
    if (decision.action === 'unresolved') {
      if (decision.reason === 'thread-stamp-undecided') beginStampUndecided(persona, slackKey)
      requestMembership(run, key)
      return
    }
    const path = fungiblePathOf(decision)
    if (path !== undefined) logFirstHeard(persona, String(ev['channel']), path)
    if (decision.action === 'drop') { logDrop(persona, ev, decision); return }
    // A plain-path choice raced into thread_hybrid. Re-enter on Slack's
    // retry so a dependent reply is always decided in the writer turn.
    if (decision.action === 'hold') { run.storeFailed = true; return }
    if (!slackKey) return
    if (decision.via !== 'dm' && deps.membership) {
      const membership = deps.membership.read(key, slackKey.chat_id, mode)
      if (membership.kind === 'ineligible') return
      if (membership.kind === 'unresolved' || (run.provenance && !run.provenance.isCurrent())) { requestMembership(run, key); return }
    }
    const input = acceptedInput(ev, slackKey, config, decision.via)
    try {
      const result = await deps.queue.accept(key, input)
      if (result.status === 'failed') { run.storeFailed = true; return }
      if (result.item) run.ackTargets?.push({ key, seq: result.item.accepted.seq })
      if (result.item && isOpenItem(result.item)) retainTarget(run, key, result.item)
    } catch { run.storeFailed = true }
  }

  /** Retained targets' effects on both completion paths, none awaited: join
   * saves, queued feedback, then each stored hold's notification. */
  function completeRetained(run: IntakeRun): void {
    for (const save of run.saveJoins) save()
    for (const report of run.accepted) report()
    for (const key of run.heldKeys) {
      try { void Promise.resolve(deps.onHoldStored?.(key)).catch(() => {}) } catch { /* durable holds recover independently */ }
    }
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
      safeLog(() => buildReactionEventErrorLine(reactionPersonaForKey(key), describeSlackCallFailure(err)))
    }
    try { await ack() } catch (err) {
      // The stored item waits for a redelivery or startup recovery to prepare it.
      safeLog(() => buildReactionAckFailedLine(reactionPersonaForKey(key), describeSlackCallFailure(err)))
      return
    }
    if (retained === undefined || retained.fixed || isQueueItemClosed(retained)) return
    try { await deps.prepare(key, retained) } catch (err) {
      safeLog(() => buildReactionPreparationFailedLine(reactionPersonaForKey(key), describeSlackCallFailure(err)))
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
    const reaction = parseReactionShape(event)
    const reactionKey = reaction?.reactionKey
    const duplicate = reactionKey ? deps.queue.lookupReactionKey(key, reactionKey) : undefined
    if (duplicate && duplicate.status !== 'failed') return duplicate.item
    const config = deps.getPersonaConfig()
    const persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return undefined
    const decision = decideReactionFor(event, key, config, persona, 'slack-event', isExtSharedChannel)
    if (decision.action === 'drop') { logReactionDrop(persona, reaction, decision); return undefined }
    if (reactionKey === undefined) return undefined
    let result: QueueAcceptResult
    try { result = await deps.queue.accept(key, reactionAcceptedInputOf(decision, reactionKey, (deps.now ?? Date.now)())) } catch (err) {
      safeLog(() => buildReactionStoreFailedLine(reactionPersonaForKey(key), describeSlackCallFailure(err)))
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
      safeLog(() => buildReactionPreparationFailedLine(reactionPersonaForKey(key), describeSlackCallFailure(err)))
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
    const reaction = parseReactionShape(event)
    const reactionKey = reaction?.reactionKey
    const duplicate = reactionKey ? deps.queue.lookupReactionKey(key, reactionKey) : undefined
    if (duplicate?.status === 'failed') return { result: { status: 'store-failed' } }
    if (duplicate) return { result: { status: 'duplicate', seq: duplicate.seq }, retained: duplicate.item }
    const config = deps.getPersonaConfig()
    const persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return { result: { status: 'dropped' } }
    const decision = decideReactionFor(event, key, config, persona, 'bot-tool')
    if (decision.action === 'drop') { logReactionDrop(persona, reaction, decision); return { result: { status: 'dropped' } } }
    if (reactionKey === undefined) return { result: { status: 'dropped' } }
    let result: QueueAcceptResult
    try {
      result = await deps.queue.accept(key, { ...reactionAcceptedInputOf(decision, reactionKey, (deps.now ?? Date.now)()), reactor_persona_name: reactorPersonaName })
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
   * its channels, DMs switch, `reaction_notices` switch and confirmed bot
   * user ID, the mode,
   * `CHANNEL_ID_RE`, the stored choices, P's current membership of the
   * reaction's channel and the Run Bot Identities. A `bot-tool` reaction has
   * no envelope flag.
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
    const mode = channelModeOf(config)
    const channel = parseReactionShape(event)?.channel
    const memberships = new Map<string, MembershipReading>()
    if (channel && CHANNEL_ID_RE.test(channel)) memberships.set(key, membershipReadingOf(key, channel, mode))
    return decideReaction(event, { key, botUserId: identity?.botUserId, channels: persona.channels, dmEnabled: persona.dm.enabled, reaction_notices: persona.reaction_notices }, {
      mode,
      origin,
      channelIdPattern: CHANNEL_ID_RE,
      isExtSharedChannel,
      storedChoices: deps.getChannelDelivery?.() ?? undefined,
      memberships,
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
  function logReactionDrop(persona: Persona, reaction: ParsedReactionShape | undefined, decision: ReactionDropDecision): void {
    const at = reaction === undefined ? {} : { chat_id: reaction.channel, message_ts: reaction.messageTs }
    let drop: ReactionDroppedInput
    switch (decision.reason) {
      case 'not-a-message-reaction':
      case 'not-own-message':
      case 'own-reaction':
      case 'bot-reaction':
        return
      case 'open-refused':
        drop = { reason: decision.reason, refusal: decision.refusal, ...at }
        break
      default:
        drop = { reason: decision.reason, ...at }
    }
    safeLog(() => buildReactionDroppedLine({ key: persona.key, name: persona.name }, drop))
  }

  /** Path choice only; selection re-reads these facts in the writer turn. */
  function usesSerialIntake(key: string, ev: Record<string, unknown>, mode: ChannelMode, extShared: unknown): boolean {
    const channel = ev['channel'], kind = ev['channel_type']
    if (typeof channel !== 'string' || !CHANNEL_ID_RE.test(channel) || kind === 'im' || kind === 'mpim') return false
    if (mode === FUNGIBLE_MODE && (extShared !== false || (kind !== 'channel' && kind !== 'group'))) return false
    if (channelDeliveryFor(key, channel, { storedChoices: deps.getChannelDelivery?.() ?? undefined }).delivery !== 'thread_hybrid') return false
    return deps.membership?.read(key, channel, mode).kind !== 'ineligible'
  }

  /** No effects: the queue can run this even when its journal cannot load. */
  function decideSerialIntake(
    key: string, ev: Record<string, unknown>, slackKey: SlackKey | undefined,
    extShared: unknown, provenance: PersonaEventProvenance | undefined,
  ): SerialSelection {
    const config = deps.getPersonaConfig(), persona = config?.personas.find(p => p.key === key)
    if (!config || !persona) return {}
    const mode = channelModeOf(config), identity = identityFor(key, provenance)
    const inputs = fungibleInputs(config, mode, extShared, slackKey?.chat_id)
    const decision = decideDelivery(ev, { key, botUserId: identity?.botUserId, botId: identity?.botId, channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, inputs)
    const selection: SerialSelection = { persona, decision, stampDecided: !!slackKey && deps.threadStampUndecided?.(key, slackKey.chat_id) !== true }
    if (decision.action === 'unresolved') return { ...selection, requestMembership: true }
    if (decision.action === 'drop' || !slackKey) return selection
    const membership = deps.membership?.read(key, slackKey.chat_id, mode)
    if (membership?.kind === 'ineligible') return selection
    if (membership?.kind === 'unresolved' || (provenance && !provenance.isCurrent())) return { ...selection, requestMembership: true }
    selection.input = acceptedInput(ev, slackKey, config, decision.via)
    const joins = deps.joins, root = ev['thread_ts'] === undefined ? ev['ts'] : ev['thread_ts']
    if (decision.action === 'hold') {
      const stamp = joins?.stamp(key, slackKey.chat_id)
      if (!joins || stamp?.kind !== 'decided' || !stamp.threadHybridSince) {
        delete selection.input
        return { ...selection, requestMembership: true }
      }
      const holdStamp = { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }, arrived_at = joins.clock(key)
      selection.input.hold = decision.hold === 'post'
        ? { on: 'post', operations: [...decision.operations], thread_ts: decision.threadRoot, stamp: holdStamp, root_unknown: decision.rootUnknown, arrived_at }
        : { on: 'memory', thread_ts: decision.threadRoot, stamp: holdStamp, arrived_at }
      return selection
    }
    if (!joins || (decision.via !== 'mention' && decision.via !== 'broadcast') || 'edited' in ev || ev['subtype'] === 'message_changed' ||
      !isThreadTimestamp(root) || channelDeliveryFor(key, slackKey.chat_id, inputs ?? {}).delivery !== 'thread_hybrid') return selection
    const stamp = joins.stamp(key, slackKey.chat_id)
    if (stamp?.kind !== 'decided' || !stamp.threadHybridSince) return selection
    const channelStamp = { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }
    if (joins.hasSavedJoin(key, slackKey.chat_id, root, channelStamp)) return selection
    const at = joins.clock(key)
    selection.input.thread_join = { thread_ts: root, stamp: channelStamp, at }
    selection.join = { channel: slackKey.chat_id, root, stamp: channelStamp, at, source: decision.via }
    return selection
  }

  /** Delayed effects from the serial decision; never run inside the queue turn. */
  function reportSerialSelection(key: string, ev: Record<string, unknown>, slackKey: SlackKey | undefined, selection: SerialSelection): void {
    const { persona, decision } = selection
    if (!persona || !decision) return
    if (slackKey && selection.stampDecided) deps.threadStampEpisodes?.end(key, slackKey.chat_id)
    if (decision.action === 'unresolved') {
      if (decision.reason === 'thread-stamp-undecided') beginStampUndecided(persona, slackKey)
    } else {
      const path = fungiblePathOf(decision)
      if (path) logFirstHeard(persona, String(ev['channel']), path)
      if (decision.action === 'drop') logDrop(persona, ev, decision)
    }
    if (selection.requestMembership) deps.membership?.request(key)
  }

  /** One line when a decision first waits on the channel's undecided stamp in this episode. */
  function beginStampUndecided(persona: Persona, slackKey: SlackKey | undefined): void {
    if (!slackKey || !deps.threadStampEpisodes?.begin(persona.key, slackKey.chat_id)) return
    log(formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: persona.name, key: persona.key, index: persona.index, cause: threadStampUndecidedCause(slackKey.chat_id) }))
  }

  function acceptedInput(ev: Record<string, unknown>, slackKey: SlackKey, config: PersonaRoutingConfig, via: string): AcceptedInput {
    const stringField = (field: string) => typeof ev[field] === 'string' ? ev[field] as string : undefined
    const profile = ev['bot_profile']
    const files = Array.isArray(ev['files']) ? ev['files'].filter(f => typeof f === 'object' && f !== null).map(f => ({
      name: typeof f.name === 'string' ? f.name : 'unnamed',
      mimetype: typeof f.mimetype === 'string' ? f.mimetype : undefined,
      size: typeof f.size === 'number' ? f.size : undefined,
    })) : undefined
    return {
      source: 'slack', key: slackKey, channel: slackKey.chat_id, ts: slackKey.ts,
      queued_ack_reaction: config.queued_ack_reaction ?? DEFAULT_QUEUED_ACK_REACTION,
      channel_type: stringField('channel_type'), thread_ts: stringField('thread_ts'), edited_ts: slackKey.edited_ts,
      user: stringField('user'), bot_id: stringField('bot_id'), username: stringField('username'),
      bot_profile_name: typeof profile === 'object' && profile !== null && 'name' in profile && typeof profile.name === 'string' ? profile.name : undefined,
      text: stringField('text') ?? '', files, via, received_at: (deps.now ?? Date.now)(),
    }
  }

  /** Persona `key`'s current membership of `channel`; a failed read leaves only it unresolved. */
  function membershipReadingOf(key: string, channel: string, mode: ChannelMode): MembershipReading {
    try {
      return deps.membership?.read(key, channel, mode) ?? { kind: 'unresolved', reason: 'current-membership-missing' }
    } catch {
      return { kind: 'unresolved', reason: 'current-membership-missing' }
    }
  }

  /** Applied choices and current membership, read for each event in both modes. */
  function fungibleInputs(
    config: PersonaRoutingConfig,
    mode: ChannelMode,
    isExtSharedChannel: unknown,
    channel: string | undefined,
  ): FungibleDecisionInputs | undefined {
    const memberships = new Map<string, MembershipReading>()
    if (channel && CHANNEL_ID_RE.test(channel)) {
      for (const persona of config.personas) memberships.set(persona.key, membershipReadingOf(persona.key, channel, mode))
    }
    return {
      mode,
      isExtSharedChannel,
      channelIdPattern: CHANNEL_ID_RE,
      storedChoices: deps.getChannelDelivery?.() ?? undefined,
      threadMemory: deps.threadMemory,
      ...(deps.pendingOwnPosts ? { ownPosts: { pending: deps.pendingOwnPosts, clockSkewMs: OWN_ROOT_CLOCK_SKEW_MS } } : {}),
      threadStampUndecided: deps.threadStampUndecided,
      memberships,
    }
  }

  /**
   * the first event in P's life that took P's open path
   * for `channel` adds it to P's heard set and logs one
   * `persona-open-channel` line, before any drop line or dispatch. Later
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
    log(formatPersonaDiagnostic({
      class: PERSONA_OPEN_CHANNEL,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      cause: openChannelCause(channel, path.channelType, path.channelDelivery),
    }))
  }

  function logDrop(persona: Persona, ev: Record<string, unknown>, decision: DropDecision): void {
    const channel = String(ev['channel'])
    switch (decision.reason) {
      case 'channel-not-configured':
        // A channel another applied persona lists is that persona's: no line.
        if (!decision.unclaimed) return
        log(formatPersonaDiagnostic({
          class: UNCLAIMED_CHANNEL,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: unclaimedChannelCause(channel),
        }))
        return
      case 'open-refused':
        // one line naming the refusal's reason.
        log(formatPersonaDiagnostic({
          class: UNCLAIMED_CHANNEL,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: fungibleUnclaimedChannelCause(channel, decision.refusal),
        }))
        return
      case 'dm-disabled':
        log(formatPersonaDiagnostic({
          class: PERSONA_DM_DROPPED,
          name: persona.name,
          key: persona.key,
          index: persona.index,
          cause: `direct message in conversation ${channel}${describeTs(ev)} dropped: dm.enabled is off for this persona`,
        }))
        return
      default:
        log(
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
      log(
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
    async releaseHeld(key, item, mode) {
      if (!isOpenItem(item) || (item.hold?.state !== 'released' && item.accepted.released_at === undefined)) return
      reportReceived(key, item, mode)
      await postAccepted(key, item, mode)
    },
    receiveReaction,
    receiveBotToolReaction,
    forget: (key) => {
      heardSets.delete(key)
      postAcked.delete(key)
    },
    heardChannels: (key) => new Set(heardSets.get(key)),
  }
}

/** The open-path part of a decision, or undefined when the event did not take the path. */
function fungiblePathOf(decision: DeliveryDecision): FungiblePath | undefined {
  return 'fungible' in decision ? decision.fungible : undefined
}

/** The retention handed to `held` when its decision took none. */
const NO_RETENTION = (): void => {}

/** Release an outcome retention; the owner's failure cannot reach intake. */
function releaseQuietly(release: () => void): void {
  try { release() } catch { /* isolated owner */ }
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
 * A `bot-tool` reaction as the Slack-shaped event the decision and the
 * reaction key read, with no envelope: each field copied from `input` now.
 */
function botToolReactionEventOf(input: BotToolReactionInput): Record<string, unknown> {
  return {
    type: input.change === 'added' ? REACTION_ADDED_EVENT : undefined,
    item: { type: 'message', channel: input.channel, ts: input.messageTs },
    item_user: input.messageAuthorUserId,
    user: input.reactorUserId,
    reaction: input.emoji,
    event_ts: input.eventTs,
  }
}

/**
 * The Reaction Item an accepted reaction is stored as: the decision's facts,
 * one reactor field, its origin and mode, the parser's reaction key, empty
 * text and `receivedAt`.
 */
function reactionAcceptedInputOf(decision: ReactionAcceptDecision, reactionKey: ReactionKey, receivedAt: number): ReactionAcceptedInput {
  const reactorId = decision.user ?? decision.bot_id
  return {
    source: 'reaction', text: '', channel: decision.channel, message_ts: decision.message_ts, ts: decision.ts,
    change: decision.change, emoji: decision.emoji, ...(decision.user !== undefined ? { user: decision.user } : { bot_id: reactorId }),
    origin: decision.origin, mode: decision.mode,
    reaction_key: reactionKey,
    received_at: receivedAt,
  }
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
