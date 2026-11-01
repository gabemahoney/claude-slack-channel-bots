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
  isOwn,
  isThreadTimestamp,
  type DeliveryDecision,
  type DropDecision,
  type FungibleDecisionInputs,
  type FungiblePath,
  type OwnPostsDecisionInput,
  type StoredChoices,
} from './delivery-decision.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  formatPersonaDiagnostic,
  PERSONA_THREAD_STAMP_UNDECIDED,
  threadStampUndecidedCause,
  fungibleUnclaimedChannelCause,
  invitedChannelCause,
  PERSONA_DM_DROPPED,
  PERSONA_INVITED_CHANNEL,
  UNCLAIMED_CHANNEL,
  unclaimedChannelCause,
} from './persona-diagnostics.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import type { DeliveryQueue, QueueItem, AcceptedInput, SlackKey } from './delivery-queue.ts'
import { isOpenItem } from './delivery-queue.ts'
import { OWN_ROOT_CLOCK_SKEW_MS } from './delivery-constants.ts'
import type { ThreadMemory, ThreadJoin, ThreadMemoryStampState } from './thread-memory.ts'
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

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** Read the live Thread Memory view only when the decision needs a reply's membership. */
  threadMemory?: FungibleDecisionInputs['threadMemory']
  /** P's in-memory Pending Own Posts, read only for a reply not known to be joined. No I/O. */
  pendingOwnPosts?: OwnPostsDecisionInput['pending']
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
  queue: Pick<DeliveryQueue, 'accept' | 'acceptDecided' | 'lookupSlackKey'>
  /** Fix stored text after the envelope ack; wake follows durable fixation. */
  prepare(key: string, item: QueueItem): Promise<void>
  /** Durable retained acceptance: after envelope ack, or after partial-fanout
   * failure suppresses it. Reporting must not await Slack or authorize delivery. */
  onReceived?(key: string, item: QueueItem, mode?: 'live' | 'recovered'): void
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

  async function receive(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
    provenance?: PersonaEventProvenance,
  ): Promise<void> {
    if (provenance?.candidate) { deps.membership?.request(provenance.key); return }
    if (provenance?.applied && !provenance.isCurrent()) { await ack(); return }
    if (provenance && !provenance.applied) return
    const afterAck: Array<() => Promise<void>> = []
    const accepted: Array<() => void> = []
    const saveJoins: Array<() => void> = []
    const heldKeys = new Set<string>()
    let storeFailed = false
    if (typeof event === 'object' && event !== null) {
      const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
      await Promise.all(keys.map(async key => {
        try { deps.archive(key, event) } catch (err) {
          deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
        }
        // One entry for both intake paths, outside the serial decision callback.
        try {
          const ev = event as Record<string, unknown>, identity = identityFor(key, provenance)
          if (deps.onOwnMessage && identity && isOwn(typeof ev['user'] === 'string' ? ev['user'] : undefined,
            typeof ev['bot_id'] === 'string' ? ev['bot_id'] : undefined, identity)) deps.onOwnMessage(key, ev, identity)
        } catch { /* the event is handled as before */ }
        try {
          const ev = event as Record<string, unknown>
          const config = deps.getPersonaConfig()
          const mode = channelModeOf(config)
          if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
          const slackKey = typeof ev['channel'] === 'string' && typeof ev['ts'] === 'string'
            ? { chat_id: ev['channel'], ts: ev['ts'], ...(typeof editedTs(ev) === 'string' ? { edited_ts: editedTs(ev) as string } : {}) } : undefined
          const persona = config?.personas.find(p => p.key === key)
          const report = (item: QueueItem) => accepted.push(() => reportReceived(key, item))
          const post = (item: QueueItem) => () => postAccepted(key, item, 'live')
          if (usesSerialIntake(key, ev, mode, isExtSharedChannel)) {
            let selection: SerialSelection | undefined
            const result = await deps.queue.acceptDecided<SerialSelection>(key, slackKey, () => {
              selection = decideSerialIntake(key, ev, slackKey, isExtSharedChannel, provenance)
              if (!selection.input) return { skip: selection }
              const fact = selection.join
              return { store: selection.input, ...(fact ? { afterStore: () => { deps.joins?.addJoin(key, fact) } } : {}) }
            })
            if (selection) reportSerialSelection(key, ev, slackKey, selection)
            if (selection?.requestMembership || result.status === 'failed') storeFailed = true
            if (result.status === 'skipped' || result.status === 'failed') return
            if (result.status === 'accepted' && selection?.join) {
              const fact = selection.join
              saveJoins.push(() => {
                try { void deps.joins?.saveJoins(key, [fact]).catch(() => {}) } catch { /* kept join is recovered independently */ }
              })
            }
            // Any unresolved hold, Post or Memory, is acknowledged but not open work.
            if (result.item?.hold?.state === 'unresolved') heldKeys.add(key)
            if (result.item && isOpenItem(result.item) && (result.status !== 'duplicate' || !result.item.fixed)) {
              report(result.item); afterAck.push(post(result.item))
            }
            if (result.status === 'duplicate' && slackKey && deps.membership?.hasUnresolved(key, slackKey.chat_id)) {
              storeFailed = true
              deps.membership.request(key)
            }
            return
          }
          // A retry after partial fanout must prepare the already retained, unfixed target too.
          const duplicate = slackKey ? deps.queue.lookupSlackKey(key, slackKey) : undefined
          if (duplicate && duplicate.status !== 'failed') {
            if (duplicate.item?.hold?.state === 'unresolved') heldKeys.add(key)
            if (duplicate.item && !duplicate.item.fixed && isOpenItem(duplicate.item)) {
              report(duplicate.item)
              afterAck.push(post(duplicate.item))
            }
            if (slackKey && deps.membership?.hasUnresolved(key, slackKey.chat_id)) {
              storeFailed = true
              deps.membership.request(key)
            }
            return
          }
          if (!config || !persona) return
          if (slackKey && deps.threadStampUndecided?.(key, slackKey.chat_id) !== true) deps.threadStampEpisodes?.end(key, slackKey.chat_id)
          const identity = identityFor(key, provenance)
          const decision = decideDelivery(ev, { key, botUserId: identity?.botUserId, botId: identity?.botId, channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, fungibleInputs(config, mode, isExtSharedChannel, slackKey?.chat_id))
          if (decision.action === 'unresolved') {
            if (decision.reason === 'thread-stamp-undecided' && slackKey && deps.threadStampEpisodes?.begin(key, slackKey.chat_id)) {
              deps.log(formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: persona.name, key, index: persona.index, cause: threadStampUndecidedCause(slackKey.chat_id) }))
            }
            storeFailed = true
            deps.membership?.request(key)
            return
          }
          const path = fungiblePathOf(decision)
          if (path !== undefined) logFirstHeard(persona, String(ev['channel']), path)
          if (decision.action === 'drop') { logDrop(persona, ev, decision); return }
          // A plain-path choice raced into thread_hybrid. Re-enter on Slack's
          // retry so a dependent reply is always decided in the writer turn.
          if (decision.action === 'hold') { storeFailed = true; return }
          if (!slackKey) return
          if (decision.via !== 'dm' && deps.membership) {
            const membership = deps.membership.read(key, slackKey.chat_id, mode)
            if (membership.kind === 'ineligible') return
            if (membership.kind === 'unresolved' || (provenance && !provenance.isCurrent())) {
              storeFailed = true
              deps.membership.request(key)
              return
            }
          }
          const input = acceptedInput(ev, slackKey, config, decision.via)
          try {
            const result = await deps.queue.accept(key, input)
            if (result.status === 'failed') { storeFailed = true; return }
            if (result.item && isOpenItem(result.item)) { report(result.item); afterAck.push(post(result.item)) }
          } catch { storeFailed = true }
        } catch (err) {
          // A failed selection is undecidable, never permission to discard.
          storeFailed = true
          deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
        }
      }))
    }
    // A failed sibling suppresses the aggregate ack, but retained targets still
    // deserve queued feedback. Preparation/recovery continue only after ack.
    if (storeFailed) { for (const save of saveJoins) save(); for (const report of accepted) report(); return }
    try { await ack() } catch (err) { deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`) }
    for (const save of saveJoins) save()
    for (const report of accepted) report()
    for (const key of heldKeys) {
      try { void Promise.resolve(deps.onHoldStored?.(key)).catch(() => {}) } catch { /* durable holds recover independently */ }
    }
    await Promise.all(afterAck.map(async work => {
      try { await work() } catch (err) { deps.log(`[slack] persona-routing: post-accept preparation failed${describeSlackCallFailure(err)}`) }
    }))
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
      if (decision.reason === 'thread-stamp-undecided' && slackKey && deps.threadStampEpisodes?.begin(key, slackKey.chat_id)) {
        deps.log(formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: persona.name, key, index: persona.index, cause: threadStampUndecidedCause(slackKey.chat_id) }))
      }
    } else {
      const path = fungiblePathOf(decision)
      if (path) logFirstHeard(persona, String(ev['channel']), path)
      if (decision.action === 'drop') logDrop(persona, ev, decision)
    }
    if (selection.requestMembership) deps.membership?.request(key)
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

  /** Applied choices and current membership, read for each event in both modes. */
  function fungibleInputs(
    config: PersonaRoutingConfig,
    mode: ChannelMode,
    isExtSharedChannel: unknown,
    channel: string | undefined,
  ): FungibleDecisionInputs | undefined {
    const memberships = new Map<string, MembershipReading>()
    if (channel && CHANNEL_ID_RE.test(channel)) {
      for (const persona of config.personas) {
        let reading: MembershipReading = { kind: 'unresolved', reason: 'current-membership-missing' }
        try { reading = deps.membership?.read(persona.key, channel, mode) ?? reading } catch { /* only this projection is unresolved */ }
        memberships.set(persona.key, reading)
      }
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
    async releaseHeld(key, item, mode) {
      if (!isOpenItem(item) || (item.hold?.state !== 'released' && item.accepted.released_at === undefined)) return
      reportReceived(key, item, mode)
      await postAccepted(key, item, mode)
    },
    forget: (key) => {
      heardSets.delete(key)
      postAcked.delete(key)
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
