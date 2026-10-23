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
import type { ChannelMembership, MembershipReading } from './channel-membership.ts'
import type { PersonaEventProvenance } from './persona-connections.ts'
import {
  decideDelivery,
  incomingEnrollmentRoot,
  replyThreadRoot,
  type DeliverDecision,
  type DeliveryDecision,
  type DropDecision,
  type FungibleDecisionInputs,
  type FungiblePath,
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
import type { DeliveryQueue, QueueItem, AcceptedInput, QueueStoredResult, SlackKey } from './delivery-queue.ts'
import { slackKeyString } from './delivery-queue.ts'
import type { ThreadObservation, ThreadParticipation } from './thread-participation.ts'
import type { SharedChannelLifetime } from './shared-channels.ts'
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

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  participation?: ThreadParticipation
  getParticipation?(): ThreadParticipation | undefined
  currentProvenance?(key: string): PersonaEventProvenance | undefined
  onParticipationFailure?(key: string, id: string, event: Record<string, unknown>, error: unknown, unaccepted?: boolean): void
  onParticipationSettled?(key: string, id: string): void
  /** Reporting records faults during intake and posts only after its release. */
  beginIntake?(key: string): () => void
  /** Real-path interruption seams; registration always precedes the first one. */
  _afterObservation?(observation: ThreadObservation): Promise<void>
  _afterAcceptance?(key: string, item: QueueItem | undefined): Promise<void>
  membership?: Pick<ChannelMembership, 'read' | 'hasUnresolved' | 'request'>
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /**
   * P's bot identity (bot user ID and bot ID; the placeholder identity in dry
   * run), or undefined when it is not known.
   */
  getBotIdentity(key: string): SlackBotIdentity | undefined
  /** Shared queue; acceptance does no network I/O. */
  queue: Pick<DeliveryQueue, 'accept' | 'lookupSlackKey'>
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
  pendingCandidates(): ThreadCandidate[]
  reevaluate(id: string): Promise<void>
  stop(): void
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
    provenance?: PersonaEventProvenance,
  ): Promise<void>
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

/** Evidence workers resolve only this candidate's thread and captured life. */
export interface ThreadCandidate {
  id: string
  key: string
  channel: string
  root: string
  lifetime: SharedChannelLifetime
}

/** The event-wide half of one intake. Any recipient's hold withholds the
 * aggregate ack; retained recipients still get queued feedback. */
interface Intake {
  event: unknown
  ack: SlackAck
  keys: readonly string[]
  flag: unknown
  provenance?: PersonaEventProvenance
  /** Each recipient's lifetime, captured before any recipient awaits. */
  lifetimes: Map<string, SharedChannelLifetime>
  afterAck: Array<() => Promise<void>>
  accepted: Array<() => void>
  held: boolean
}

/** One recipient's share of an intake. The post-observation reselection
 * replaces `config` and `persona`; post-ack work reads the latest. */
interface Recipient {
  key: string
  ev: Record<string, unknown>
  slackKey?: SlackKey
  id?: string
  threads?: ThreadParticipation
  config: PersonaRoutingConfig | null | undefined
  persona?: Persona
}

/** How one recipient's outcome settles its share of the aggregate ack. */
interface RecipientSettlement {
  hold(): void
  settle(): void
  failed(error: unknown, unaccepted?: boolean): void
  report(item: QueueItem): void
  post(item: QueueItem): () => Promise<void>
  /** Reconcile an already retained item with its original obligation. */
  retained(result: QueueStoredResult): void
  /** Authoritatively discard the logical message, cancelling its shared
   * observation; false while held or when a concurrent acceptance won. */
  discard(): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a persona-routing instance over the injected dependencies. */
export function createPersonaRouting(deps: PersonaRoutingDeps): PersonaRouting {
  const heardSets = new Map<string, Set<string>>()
  const postAcked = new Map<string, Set<number>>()
  const candidates = new Map<string, { candidate: ThreadCandidate; event: unknown; ack: SlackAck;
    keys: readonly string[]; lifetimes: Map<string, SharedChannelLifetime>; flag: unknown; provenance?: PersonaEventProvenance }>()
  const reevaluating = new Map<string, Promise<void>>()
  let stopped = false
  const participation = () => deps.getParticipation?.() ?? deps.participation
  const candidateId = (key: string, slackKey: SlackKey) => JSON.stringify([key, slackKeyString(slackKey)])
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
    provenance?: PersonaEventProvenance,
  ): Promise<void> {
    const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
    const releases = keys.map(key => deps.beginIntake?.(key))
    try { await receiveEvent(event, ack, personaKeys, isExtSharedChannel, provenance) }
    finally { for (const release of releases) release?.() }
  }

  async function receiveEvent(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
    provenance?: PersonaEventProvenance,
  ): Promise<void> {
    if (stopped) return
    if (provenance?.candidate) { deps.membership?.request(provenance.key); return }
    if (provenance?.applied && !provenance.isCurrent()) { await ack(); return }
    if (provenance && !provenance.applied) return
    const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
    const intake: Intake = {
      event, ack, keys, flag: isExtSharedChannel, provenance, lifetimes: new Map(), afterAck: [], accepted: [], held: false,
    }
    if (typeof event === 'object' && event !== null) {
      const channel = (event as Record<string, unknown>)['channel']
      if (typeof channel === 'string') for (const key of keys) {
        const lifetime = participation()?.lifetime(key, channel)
        if (lifetime) intake.lifetimes.set(key, structuredClone(lifetime))
      }
      await Promise.all(keys.map(key => receiveForRecipient(intake, key)))
    }
    // A failed sibling suppresses the aggregate ack, but retained targets still
    // deserve queued feedback. Preparation/recovery continue only after ack.
    if (intake.held || stopped) { for (const report of intake.accepted) report(); return }
    try { await ack() } catch (err) { deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`) }
    for (const report of intake.accepted) report()
    await Promise.all(intake.afterAck.map(async work => {
      try { await work() } catch (err) { deps.log(`[slack] persona-routing: post-accept preparation failed${describeSlackCallFailure(err)}`) }
    }))
  }

  /**
   * One recipient's selection, observation and acceptance. Everything before
   * the first await here runs synchronously inside the caller's map, so every
   * recipient of an event publishes its observation before any persists.
   */
  async function receiveForRecipient(intake: Intake, key: string): Promise<void> {
    try { deps.archive(key, intake.event) } catch (err) {
      deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    try {
      const ev = structuredClone(intake.event) as Record<string, unknown>
      const receivedAt = (deps.now ?? Date.now)()
      const config = deps.getPersonaConfig()
      const mode = channelModeOf(config)
      if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
      const slackKey = slackKeyOf(ev)
      // A retry after partial fanout must prepare the already retained, unfixed target too.
      const duplicate = slackKey ? deps.queue.lookupSlackKey(key, slackKey) : undefined
      const threads = participation()
      const r: Recipient = {
        key, ev, slackKey, id: slackKey ? candidateId(key, slackKey) : undefined, threads,
        config, persona: config?.personas.find(p => p.key === key),
      }
      const s = settlementFor(intake, r)
      if (duplicate && duplicate.status !== 'failed') { s.retained(duplicate); return }
      const selected = selectRecipient(intake, r, s, mode)
      if (!selected) return
      const { persona, decision } = selected
      const path = fungiblePathOf(decision)
      if (path !== undefined) logFirstHeard(persona, String(ev['channel']), path)
      if (decision.action === 'drop') {
        if (await s.discard()) logDrop(persona, ev, decision)
        return
      }
      if (!slackKey) return
      const root = incomingEnrollmentRoot(ev, decision)
      const delivery = root ? selected.inputs.storedChoices?.storedChoice(key, slackKey.chat_id) : undefined
      if (root && threads && delivery === undefined) { s.hold(); return }
      // All receivers reach this publication synchronously, before the
      // first persistence/test await. Pending evidence is not enrollment.
      const observation = root && threads ? threads.observeIncoming(key, slackKey, root, {
        mode, delivery: delivery!,
      }) : undefined
      if (root && threads && !observation) { s.hold(); return }
      if (decision.via !== 'dm' && deps.membership) {
        const membership = deps.membership.read(key, slackKey.chat_id, mode)
        if (membership.kind === 'ineligible') { await s.discard(); return }
        if (membership.kind === 'unresolved' || deps.isPersonaUp?.(key) === false || (intake.provenance && !intake.provenance.isCurrent())) {
          s.hold()
          deps.membership.request(key)
          return
        }
      }
      let current = { config: selected.config, decision }
      if (observation) {
        const reselected = await persistAndReselect(intake, r, s, observation, selected.identity)
        if (!reselected) return
        current = reselected
      }
      await acceptRecipient(intake, r, s, acceptedInput(ev, slackKey, current.config, current.decision, observation, receivedAt), observation)
    } catch (err) {
      // A failed selection is undecidable, never permission to discard.
      intake.held = true
      deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
  }

  /** The callbacks through which one recipient settles, holds or reports. */
  function settlementFor(intake: Intake, r: Recipient): RecipientSettlement {
    const { key, ev, slackKey, id, threads } = r
    const s: RecipientSettlement = {
      hold() { intake.held = true },
      settle() {
        if (id) { candidates.delete(id); deps.onParticipationSettled?.(key, id) }
      },
      failed(error, unaccepted = false) {
        s.hold()
        if (id) deps.onParticipationFailure?.(key, id, ev, error, unaccepted)
      },
      report(item) {
        intake.accepted.push(() => {
          try { void Promise.resolve(deps.onReceived?.(key, item)).catch(() => {}) } catch { /* reporting cannot prevent preparation */ }
        })
      },
      post: item => async () => {
        const posted = postAcked.get(key) ?? new Set<number>()
        if (posted.has(item.accepted.seq)) return
        // Claim only after the aggregate ack: retained partial fanout can
        // retry here, but concurrent/redelivered copies recover just once.
        posted.add(item.accepted.seq)
        postAcked.set(key, posted)
        const session = getSessionByPersona(key)
        const { persona, config } = r
        if (persona && config && (!session || !session.connected)) await handleLostMessage(persona, persona.working_directory, config)
        await deps.prepare(key, item)
      },
      retained(result) {
        if (result.durabilityPending) { s.hold(); return }
        if (result.item && !result.item.delivered) {
          s.report(result.item)
          if (!result.item.fixed) intake.afterAck.push(s.post(result.item))
        }
        if (result.enrollment) {
          // The original obligation, including a compacted duplicate, is
          // reconciled without selecting old text under today's policy.
          try {
            if (!threads || threads.recover(key, result.enrollment.id) === 'unresolved') { s.hold(); return }
          } catch (error) { s.failed(error); return }
        }
        if (slackKey && deps.membership?.hasUnresolved(key, slackKey.chat_id)) {
          s.hold()
          deps.membership.request(key)
          return
        }
        s.settle()
      },
      async discard() {
        const lifetime = intake.lifetimes.get(key)
        if (threads && slackKey && lifetime) {
          if (threads.lifetimeStatus(lifetime) === 'unresolved') { s.hold(); return false }
          try {
            const accepted = await threads.discardIncoming(lifetime, slackKey)
            if (accepted) { s.retained(accepted); return false }
          } catch (error) { s.failed(error); return false }
        }
        s.settle()
        return true
      },
    }
    return s
  }

  /**
   * The first selection, reading participation only for a dependent reply.
   * Undefined when the recipient has no applied persona or is held; an
   * undecidable reply is registered as a re-evaluation candidate.
   */
  function selectRecipient(intake: Intake, r: Recipient, s: RecipientSettlement, mode: ChannelMode) {
    const { key, ev, slackKey, threads, config, persona } = r
    if (!config || !persona) return
    const identity = intake.provenance?.key === key ? intake.provenance.identity : deps.getBotIdentity(key)
    const inputs = fungibleInputs(config, mode, intake.flag, slackKey?.chat_id)
    const decide = () => decideDelivery(ev, { key, botUserId: identity?.botUserId, botId: identity?.botId, channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, inputs)
    let decision = decide()
    if (decision.action === 'unresolved' && decision.reason === 'participation-unresolved' && slackKey && threads) {
      const root = replyThreadRoot(ev)!
      try {
        const reading = threads.read(key, slackKey.chat_id, root)
        inputs.participation = new Map([[key, reading]])
        if (reading.failure) s.failed(new Error('Thread participation storage is unavailable'))
      }
      catch (error) { s.failed(error); return }
      decision = decide()
    }
    if (decision.action === 'unresolved') {
      s.hold()
      if (decision.reason === 'participation-unresolved' && slackKey) holdCandidate(intake, r, slackKey)
      else deps.membership?.request(key)
      return
    }
    return { config, persona, identity, inputs, decision }
  }

  /** Protect an undecidable reply's exact thread for re-evaluation, keeping the latest ack. */
  function holdCandidate(intake: Intake, r: Recipient, slackKey: SlackKey): void {
    const { key, threads, id } = r
    const root = replyThreadRoot(r.ev), lifetime = threads?.lifetime(key, slackKey.chat_id)
    if (!id || !root || !lifetime) return
    const previous = candidates.get(id)
    if (!previous || threads?.lifetimeStatus(previous.candidate.lifetime) === 'superseded') candidates.set(id, {
      candidate: { id, key, channel: slackKey.chat_id, root, lifetime: structuredClone(lifetime) },
      event: structuredClone(intake.event), ack: intake.ack, keys: [...intake.keys], lifetimes: intake.lifetimes,
      flag: intake.flag, provenance: intake.provenance,
    })
    else previous.ack = intake.ack
  }

  /**
   * Persist the observation, then select again under what is applied now:
   * choices, membership and the receiving identity can change during the
   * waits, and the observation's own policy authorizes nothing. Undefined
   * when the recipient is held, discarded or excluded.
   */
  async function persistAndReselect(
    intake: Intake,
    r: Recipient,
    s: RecipientSettlement,
    observation: ThreadObservation,
    identity: SlackBotIdentity | undefined,
  ): Promise<{ config: PersonaRoutingConfig; decision: DeliverDecision } | undefined> {
    const { key, ev, slackKey, threads } = r
    try {
      await deps._afterObservation?.(observation)
      if (await threads!.persist(observation) !== 'current' || stopped) { s.hold(); return }
    } catch (error) { s.failed(error, true); return }
    const config = r.config = deps.getPersonaConfig()
    const persona = r.persona = config?.personas.find(p => p.key === key)
    const { provenance } = intake
    if (!config || !persona || (provenance && !provenance.isCurrent())) { s.hold(); return }
    const currentIdentity = provenance?.key === key ? provenance.identity : deps.getBotIdentity(key)
    if (currentIdentity?.botUserId !== identity?.botUserId || currentIdentity?.botId !== identity?.botId) { s.hold(); return }
    const mode = channelModeOf(config)
    // Excluding this envelope decides nothing about the logical message: its
    // paired message copy shares the observation and remains the deciding event.
    if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
    const decision = decideDelivery(ev, { key, botUserId: currentIdentity?.botUserId, botId: currentIdentity?.botId,
      channels: persona.channels, dmEnabled: persona.dm.enabled }, config.personas, fungibleInputs(config, mode, intake.flag, slackKey!.chat_id))
    if (decision.action === 'unresolved') { s.hold(); deps.membership?.request(key); return }
    if (decision.action === 'drop') {
      if (await s.discard()) logDrop(persona, ev, decision)
      return
    }
    if (deps.isPersonaUp?.(key) === false) { s.hold(); return }
    return { config, decision }
  }

  /** Accept through the queue's joint acceptance/enrollment boundary. */
  async function acceptRecipient(
    intake: Intake,
    r: Recipient,
    s: RecipientSettlement,
    input: AcceptedInput,
    observation: ThreadObservation | undefined,
  ): Promise<void> {
    const { key, threads } = r
    try {
      const result = await deps.queue.accept(key, input)
      if (result.status === 'failed') {
        if (result.reason === 'cancelled') { s.settle(); return }
        if (observation) s.failed(result.error, true); else s.hold()
        return
      }
      if (result.durabilityPending) { s.hold(); return }
      if (result.item && !result.item.delivered) { s.report(result.item); intake.afterAck.push(s.post(result.item)) }
      await deps._afterAcceptance?.(key, result.item)
      if (result.enrollment && (!threads || threads.recover(key, result.enrollment.id) === 'unresolved')) { s.hold(); return }
      s.settle()
    } catch (error) { s.failed(error) }
  }

  /** Applied shared choices and independent membership readings in both modes.
   * Participation is read separately, only for a dependent selection. */
  function fungibleInputs(
    config: PersonaRoutingConfig,
    mode: ChannelMode,
    isExtSharedChannel: unknown,
    channel: string | undefined,
  ): FungibleDecisionInputs {
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
      fungibleDestinations: fungibleDestinationsOf(config, config.personas),
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
    pendingCandidates: () => [...candidates.values()].filter(c => participation()?.lifetimeStatus(c.candidate.lifetime) !== 'superseded').map(c => structuredClone(c.candidate)),
    reevaluate(id) {
      const running = reevaluating.get(id)
      if (running) return running
      const work = reevaluate(id).finally(() => { reevaluating.delete(id) })
      reevaluating.set(id, work)
      return work
    },
    stop() { stopped = true; candidates.clear() },
    forget: (key) => {
      heardSets.delete(key)
    },
    heardChannels: (key) => new Set(heardSets.get(key)),
  }
  async function reevaluate(id: string): Promise<void> {
      const held = candidates.get(id), threads = participation()
      if (!held || !threads || stopped) return
      const status = threads.lifetimeStatus(held.candidate.lifetime)
      if (status === 'superseded') { candidates.delete(id); deps.onParticipationSettled?.(held.candidate.key, id); return }
      if (status !== 'current') return
      const provenance = deps.currentProvenance?.(held.candidate.key) ?? held.provenance
      if (provenance && (!provenance.applied || !provenance.isCurrent())) return
      // Same receive/dedupe/fanout boundary as Socket redelivery. No lookup or
      // parallel enqueue path is owned by this interface.
      const keys = held.keys.filter(key => {
        const lifetime = held.lifetimes.get(key)
        return !lifetime || threads.lifetimeStatus(lifetime) !== 'superseded'
      })
      await receive(held.event, held.ack, keys, held.flag, provenance)
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

/** The event's Slack dedupe key, or undefined without a string channel and ts. */
function slackKeyOf(ev: Record<string, unknown>): SlackKey | undefined {
  const channel = ev['channel'], ts = ev['ts'], edited = editedTs(ev)
  if (typeof channel !== 'string' || typeof ts !== 'string') return undefined
  return { chat_id: channel, ts, ...(typeof edited === 'string' ? { edited_ts: edited } : {}) }
}

/** The queue input for an accepted event: its original text and attachment context. */
function acceptedInput(
  ev: Record<string, unknown>,
  slackKey: SlackKey,
  config: PersonaRoutingConfig,
  decision: DeliverDecision,
  observation: ThreadObservation | undefined,
  receivedAt: number,
): AcceptedInput {
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
    text: stringField('text') ?? '', files, via: decision.via, received_at: receivedAt,
    ...(observation ? { thread_enrollment: observation } : {}),
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
