/** Durable Slack intake and existing message-triggered recovery (b.omv SR-4.1/4.2). */
import {
  CHANNEL_ID_RE,
  channelModeOf,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
} from './config.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import {
  decideDelivery,
  stripPersonaMention,
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
import type { DeliveryQueue, QueueItem, AcceptedInput } from './delivery-queue.ts'
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

/** The channel mode in which a persona serves the channels its app is in (b.deo SRI-101). */
const FUNGIBLE_MODE: ChannelMode = 'fungible'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack `ack` handed over with a Socket Mode event. */
export type SlackAck = () => Promise<void> | void

/**
 * The persona config fields this module reads: the personas, the restart
 * delay, and the `allow_invited_channels` switch, read through
 * `channelModeOf` at each event (b.deo SRI-201).
 */
export type PersonaRoutingConfig = Pick<PersonaConfig, 'personas' | 'session_restart_delay' | 'allow_invited_channels'>

/** Dependencies injected into `createPersonaRouting`. */
export interface PersonaRoutingDeps {
  /** The applied persona config, read at call time; null or undefined when there is none. */
  getPersonaConfig(): PersonaRoutingConfig | null | undefined
  /**
   * P's bot identity (bot user ID and bot ID; the placeholder identity in dry
   * run), or undefined when it is not known.
   */
  getBotIdentity(key: string): SlackBotIdentity | undefined
  /** Shared queue; acceptance does no network I/O (b.omv SR-3.3). */
  queue: Pick<DeliveryQueue, 'accept' | 'lookupSlackKey'>
  /** Fix stored text after the envelope ack; E3's wake follows durable fixation. */
  prepare(key: string, item: QueueItem): Promise<void>
  onReceived?(key: string, item: QueueItem): void
  /** Fire-and-forget archive, before the decision, with no pre-ack await. */
  archive(key: string, event: unknown): void
  /** Writes one log line. */
  log(line: string): void
  /** Intake clock in epoch milliseconds. */
  now?: () => number
  /**
   * The stored choices (b.deo SRI-305, SRI-403): the store's readability and
   * its read-only lookup, which the one store `main()` loads
   * (`src/channel-delivery.ts`) satisfies as it is. Read at each
   * fungible-mode event, never held across events; the routing never writes
   * to it or drops from it. Null or undefined (before the store is loaded),
   * or the dep absent: no stored choice applies, so fungible mode serves
   * every channel at `mentions`. Not asked in declarative mode.
   */
  getChannelDelivery?(): StoredChoices | null | undefined
  /**
   * Whether persona P is up (b.av2 SR-6.4; production: the server's one
   * `isPersonaUp` predicate), asked for a lost message only: a message lost
   * for a persona that is not up schedules no restart and reports the
   * `not-up` recovery state. Without it every persona counts as up.
   */
  isPersonaUp?(key: string): boolean
  // The lost-message state inputs (b.jg5 SRJ-1011), each asked for a lost
  // message only, with P's key at that time. An absent member answers false,
  // except `isRetryArmed`, whose absence leaves state 5 without its
  // armed-timer gate (its restart-cap gate is always asked).
  /**
   * Whether persona P is latched (b.jg5 SRJ-502; production: the server's one
   * latch's `isLatched`, which covers every declared case): a message lost
   * while it is latched reports `held-for-human`.
   */
  isLatched?(key: string): boolean
  /**
   * Whether persona P's `tmux-unresponsive` condition holds (b.jg5 SRJ-307;
   * production: the condition's `holds`): a message lost while it holds
   * reports `not-answering`, as does one lost while P's `tmux-unavailable` or
   * `ad-config-malformed` outage is raised (read from the outage state), in
   * both cases only while P is below the restart cap and its retry timer is
   * armed (`isRetryArmed`).
   */
  isTmuxUnresponsive?(key: string): boolean
  /**
   * Whether persona P's retry timer is armed, waiting or running (b.jg5
   * SRJ-1011 as amended: "state 5 applies only while P's retry timer is
   * armed"; production: the retry controller's `isArmed`, false when there
   * is no controller). State 5 (`not-answering`) is decided only while it
   * answers exactly true and P is below the restart cap (SRJ-305), so a P
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
   * or `isDialogApproverRunning`, b.jg5 SRJ-401): a message lost then reports
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
   * Whether anything is in flight for persona P (b.jg5 SRJ-1011, "in flight
   * for P"; production: the server's `isPersonaWorkInFlight`, the one the
   * health tick receives, which counts a running dialog approver; the retry
   * timer receives the narrower "blocks a retry" check instead). While it
   * answers true the lost-message row read is not made. Absent: nothing
   * counts as in flight.
   */
  isWorkInFlight?(key: string): boolean
  /**
   * One read of persona P's row, answering one of the four liveness readings
   * (b.jg5 SRJ-314, SRJ-1011; production: the liveness adapter main() builds,
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
   * b.jg5 SRJ-311: arm persona P's retry timer when its `tmux-unavailable`
   * outage is raised and it has none (production: the server's one check,
   * shared with the session-disconnect handler, which arms only when no
   * timer is armed, P is not latched and nothing is in flight for P, and
   * logs one line when it arms). Asked for a lost message before the state
   * is decided, only when none of states 1 to 4 applies, state 5's condition
   * holds (P's `tmux-unresponsive` condition, or its `tmux-unavailable` or
   * `ad-config-malformed` flag), P's `tmux-unavailable` flag is raised and P
   * is below the restart cap (SRJ-305): so a P whose retry stopped with the
   * flag still raised gets its timer armed and reports `not-answering`
   * (state 5 applies only while P's retry timer is armed, `isRetryArmed`).
   * At the cap nothing is armed: a timer armed there would stop at its first
   * retry, and a P at the cap is never in state 5. It never schedules a
   * restart (SRJ-1501). Absent: nothing is armed.
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
   * `isExtSharedChannel` is the envelope flag (b.deo SRI-301): the Events API
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
   * Forget ephemeral heard-channel state on teardown. Durable queue records
   * and Slack keys remain under their original persona key (b.omv SR-3.7).
   */
  forget(key: string): void
  /**
   * A snapshot of the persona's heard set (b.deo SRI-307): the channels whose
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
          const post = (item: QueueItem) => async () => {
            const posted = postAcked.get(key) ?? new Set<number>()
            if (posted.has(item.accepted.seq)) return
            // Claim only after the aggregate ack: retained partial fanout can
            // retry here, but concurrent/redelivered copies recover just once.
            posted.add(item.accepted.seq)
            postAcked.set(key, posted)
            try { void Promise.resolve(deps.onReceived?.(key, item)).catch(() => {}) } catch { /* reporting cannot prevent preparation */ }
            const session = getSessionByPersona(key)
            if (persona && config && (!session || !session.connected)) await handleLostMessage(persona, persona.working_directory, config)
            await deps.prepare(key, item)
          }
          if (duplicate && duplicate.status !== 'failed') {
            if (duplicate.item && !duplicate.item.fixed && !duplicate.item.delivered) afterAck.push(post(duplicate.item))
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
            channel_type: stringField('channel_type'), thread_ts: stringField('thread_ts'), edited_ts: slackKey.edited_ts,
            user: stringField('user'), bot_id: stringField('bot_id'), username: stringField('username'),
            bot_profile_name: typeof profile === 'object' && profile !== null && 'name' in profile && typeof profile.name === 'string' ? profile.name : undefined,
            text: stripPersonaMention(stringField('text') || '', identity?.botUserId), files, via: decision.via, received_at: (deps.now ?? Date.now)(),
          }
          try {
            const result = await deps.queue.accept(key, input)
            if (result.status === 'failed') { storeFailed = true; return }
            if (result.item && !result.item.delivered) afterAck.push(post(result.item))
          } catch { storeFailed = true }
        } catch (err) {
          // Decision/routing failures keep the historical ack behavior (SR-4.1).
          deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
        }
      }))
    }
    if (storeFailed) return
    try { await ack() } catch (err) { deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`) }
    await Promise.all(afterAck.map(async work => {
      try { await work() } catch (err) { deps.log(`[slack] persona-routing: post-accept preparation failed${describeSlackCallFailure(err)}`) }
    }))
  }

  /**
   * The decision's fungible-mode inputs (b.deo SRI-301, SRI-305, SRI-309),
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
   * b.deo SRI-307: the first event in P's life that took P's fungible path
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
        // A channel another applied persona lists is that persona's: no line (AC 52).
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
        // b.deo SRI-903: one line naming the refusal's reason.
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

  /** Existing recovery state/row read, only after durable acceptance and ack (SR-4.2). */
  async function handleLostMessage(
    persona: Persona,
    cwd: string,
    config: PersonaRoutingConfig,
  ): Promise<void> {
    const key = persona.key
    const early = earlyQueries(key)
    // b.jg5 SRJ-311: arm a stopped retry first, so the gated check sees it.
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
   * The queries of states 1 to 5 (b.jg5 SRJ-1011) for persona `key`, each
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

  /** The queries of states 1 to 4 (b.jg5 SRJ-1011) for persona `key`, each asked at call time. */
  function earlyQueriesBeforeState5(key: string): EarlyLostMessageQueries {
    return {
      isNotUp: () => deps.isPersonaUp?.(key) === false,
      isLatched: () => deps.isLatched?.(key) === true,
      isHeldOnInvalidFlags: () => deps.isHeldOnInvalidFlags?.(key) === true,
      isKillFailed: () => deps.isKillFailed?.(key) === true,
    }
  }

  /**
   * b.jg5 SRJ-311, asked before a lost message's state is decided: when the
   * state would be `not-answering` but for the retry-timer gate (none of
   * states 1 to 4 applies and state 5's condition holds), P's
   * `tmux-unavailable` flag is raised and P is below the restart cap
   * (SRJ-305), ask `armRetryTimerIfMissing` for P, so the gated decision
   * that follows sees the timer it armed. At the cap nothing is armed: a
   * timer armed there would stop at its first retry, and P reports
   * `restart-limit-reached`. Never schedules a restart (SRJ-1501).
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
   * The read gate (b.jg5 SRJ-1011): true when the row read is injected, none
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
   * The one row read of P for a lost message (b.jg5 SRJ-1011): true when it
   * answers `pending` (the `session-starting` input). Any other reading
   * (`live`, `dead`, `unknown`) leaves that state out, and so does a
   * rejection, which is caught, logged once with its description redacted
   * (`describeAgentDirectorFailure`) and never thrown. The read is outside
   * any launch or recovery attempt (b.jg5 SRJ-105, SRJ-115): the reader
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
   * b.jg5 SRJ-1011 state 5 (as amended: "state 5 applies only while P's
   * retry timer is armed"): state 5's condition holds for persona `key`
   * (`notAnsweringConditionHolds`), P is below the restart cap (SRJ-305,
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
   * State 5's condition (b.jg5 SRJ-1011), before the cap and retry-timer gates:
   * persona `key`'s `tmux-unresponsive` condition holds, or its
   * `tmux-unavailable` or `ad-config-malformed` outage flag is raised (b.jg5
   * SRJ-311, SRJ-316). No other outage class and no unclassified-error
   * episode counts.
   */
  function notAnsweringConditionHolds(key: string): boolean {
    if (deps.isTmuxUnresponsive?.(key) === true) return true
    const flags = getOutageFlags(key)
    return flags.has('tmux-unavailable') || flags.has('ad-config-malformed')
  }

  return {
    receive,
    forget: (key) => {
      heardSets.delete(key)
    },
    heardChannels: (key) => new Set(heardSets.get(key)),
  }
}

/** The fungible-path part of a decision (b.deo SRI-309), or undefined when the event did not take the path. */
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
