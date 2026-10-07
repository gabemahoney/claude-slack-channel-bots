/**
 * persona-routing.ts — Inbound Slack delivery per persona, in both channel
 * modes (b.av2 SR-4.1 with b.deo SRI-301 and SRI-302, SR-4.2 with b.deo
 * SRI-303 to SRI-309, SR-4.3, SR-4.4 with b.deo SRI-306, SR-10.3 `unclaimed-channel`,
 * `persona-dm-dropped` and, with b.deo SRI-901 to SRI-903,
 * `persona-invited-channel`).
 *
 * Every `message` and `app_mention` event a persona's connection receives
 * feeds that persona's single pipeline:
 *
 * 1. Intake (`receive`; b.av2 SR-4.1, b.deo SRI-301): the event is acked
 *    first, before anything else. Then, for each receiving persona, the
 *    archive is written through the archive seam (unconditionally, in both
 *    modes, before dedupe and any decision) and that persona's pipeline runs
 *    with the envelope flag the event router passed, unchanged. Each
 *    persona's run is isolated: a throw is caught and logged, naming the
 *    persona, and never stops another persona's run.
 * 2. Mode (b.deo SRI-201, SRI-302): the channel mode is read once for the
 *    event, through `channelModeOf`, from the configuration in effect as the
 *    event arrives; no copy is kept across events. In fungible mode an
 *    `app_mention` (a group-DM one included) ends here, after its archive
 *    write: no dedupe record, decision, line, dispatch, reaction or report.
 *    The `message` event carrying the same mention decides, so one @mention
 *    is delivered once whichever event arrives first. In declarative mode an
 *    `app_mention` carries on.
 * 3. Dedupe (b.av2 SR-4.1, b.deo SRI-302): P's own store (`src/inbound-dedupe.ts`), kept
 *    per persona key for the life of this routing instance (so it survives a
 *    reopen of P's connection), records the event's (channel, ts), or
 *    (channel, ts, edited.ts) when the event carries a top-level `edited.ts`
 *    (an edit that adds a mention arrives as an `app_mention` with the
 *    original ts and an `edited` object). A key P already saw within the
 *    retention window, such as the second of the `message` / `app_mention`
 *    pair or a Slack redelivery, stops here with no decision, dispatch,
 *    reaction, recovery, post or log line. An event without a channel or ts
 *    is not keyed and carries on. A record made under the mode in force
 *    before a switch change stands.
 * 4. Decision (b.av2 SR-4.2, b.deo SRI-309): one call to `decideDelivery`
 *    (`src/delivery-decision.ts`, the only module holding delivery rules)
 *    with P's key, bot user ID, bot ID, channel entries and DMs switch
 *    (`dm.enabled`) and the applied personas. In fungible mode it also gets
 *    the fungible-mode inputs, built at the event: the mode, the envelope
 *    flag, `CHANNEL_ID_RE`, the stored choices read through
 *    `getChannelDelivery` (readability and lookup only; the routing never
 *    writes to the store or drops from it), and each applied persona's
 *    destination through the one destination rule (`personaDestinationOf`).
 *    In declarative mode it gets none of them. It returns deliver with
 *    `via`, or drop with a reason, and says whether the event took the
 *    fungible path. A DM is decided only against the persona whose
 *    connection received it.
 * 5. Audit line (b.deo SRI-307): the first event in P's persona life that
 *    took P's fungible path for a channel adds the channel to P's heard set
 *    and logs one `persona-invited-channel` line, before any drop line or
 *    dispatch, so a `not-mentioned` drop and a lost message log it too.
 *    Later events from that channel in the same life log none. The heard set
 *    is kept per persona key beside the dedupe stores, in memory only, and
 *    read through `heardChannels`; every routing instance starts with empty
 *    heard sets and a switch change keeps them. Nothing about membership is
 *    written anywhere (b.deo SRI-304).
 * 6. Drop logging (b.av2 SR-10.3, b.deo SRI-903): in declarative mode a
 *    channel no applied persona lists logs one `unclaimed-channel` line
 *    naming the channel and P, and a channel another applied persona lists
 *    logs nothing; in fungible mode a `message` event refused on the
 *    fungible path logs one `unclaimed-channel` line naming the channel, P
 *    and the reason. A DM to P with its DMs switch off logs one
 *    `persona-dm-dropped` line naming P and `dm.enabled`, and makes no Slack
 *    call; any other reason logs one plain line naming the author ID. One
 *    event logs at most one drop line. No drop line carries message text.
 * 7. Dispatch: the author's label is resolved, then P's session is looked up by
 *    persona key and its GET stream probed. The message goes as
 *    `notifications/claude/channel` to P's session only, with `chat_id` set
 *    to the source conversation (the channel, or the DM conversation).
 *    Nothing is awaited between the session read and the send. Only once the
 *    send has succeeded does P record its ack-tracker entry (keyed by P's key,
 *    the conversation and the ts) and add the ack reaction through its own
 *    client (b.av2 SR-4.5); a send that throws gets neither. The meta `user`
 *    is the author's display name, or for an author without `user` (webhook,
 *    `bot_message`) the event's `username`, else its `bot_profile.name`, else
 *    its bot ID. The meta also carries the author's
 *    `user_id` (or, for an author without `user`, its `bot_id`; never both)
 *    and `via`, how the message reached P (b.av2 SR-4.4).
 * 8. Lost message (b.av2 SR-4.6, SR-7.3; b.jg5 SRJ-1011, SRJ-1509): when P
 *    has no live session, or its session has lost its GET stream, the
 *    message is dropped with no ack reaction or ack-tracker entry, a
 *    human-triggered restart of P is scheduled only in the "starting now"
 *    state, and one lost-message notice naming the sender and the state goes
 *    to P's destination through the injected `notify` (which resolves the
 *    destination of the mode in force). `src/lost-message.ts`
 *    decides the state, the first that applies, from whether P is up, whether
 *    P is latched (held for a human), whether P is not answering (its
 *    `tmux-unresponsive` condition holds, or its `tmux-unavailable` or
 *    `ad-config-malformed` outage is raised, P is below the restart cap and
 *    P's retry timer is armed), whether P's row reads `pending` (a launch for
 *    P is running, or the one row read below answered `pending`: starting),
 *    and the restart guards. State 5 ("not answering", whose notice says CSCB
 *    is retrying) applies only while P's retry timer is armed (b.jg5 SRJ-1011
 *    as amended: "state 5 applies only while P's retry timer is armed"; the
 *    injected `isRetryArmed`) and never at the restart cap (SRJ-305), so a P
 *    at the cap reports "restart limit reached", whatever condition or flag
 *    is raised, even while a timer that will stop at its next retry is still
 *    armed for it. Before the state is decided, a P that would be "not answering"
 *    but for the gate, with its `tmux-unavailable` outage raised and below
 *    the restart cap, has its retry timer armed when it has none (the
 *    injected `armRetryTimerIfMissing`, b.jg5 SRJ-311), so it reports "not
 *    answering". When none of states 1 to 5 applies and nothing is in flight
 *    for P, one row read of P is made (the injected `readRowLiveness`), and
 *    the state is decided again after it. A P in any state but "starting
 *    now" is never restarted from here (b.jg5 SRJ-1501). Nothing is posted in
 *    the source conversation, and the message text is never in the notice.
 *
 * The ack reaction's name comes from the server-wide `ack_reaction` setting
 * (b.av2 SR-1.6); with it absent, no persona reacts or records an entry.
 *
 * A fungible-path event makes the same Slack calls as any other (b.deo
 * SRI-304, SRI-309): none is added to learn membership.
 *
 * Teardown (b.av2 SR-6.5 as amended by b.jg5 SRJ-1507; b.deo SRI-307): the
 * persona teardown calls `forget(key)`, which drops the key's dedupe store and
 * heard set, so a persona torn down and brought back in one server run starts
 * with empty ones and logs its `persona-invited-channel` lines again.
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no Slack
 * client, reads no token, file or environment variable, starts no timer and
 * logs nothing. Every Slack client, the persona config, the bot identity, the
 * name resolver, the archive writer, the ack-reaction source, the notice sink,
 * the logger and (optionally) the dedupe clock, the stored choices, the up
 * predicate and the lost-message state inputs are injected through
 * `createPersonaRouting`. The
 * session lookup comes from the registry, the restart guards from the restart
 * and backoff modules and the outage flags from the outage state, so tests
 * drive their real state. This module makes no agent-director call itself;
 * its one lost-message row read is injected (`readRowLiveness`).
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import {
  CHANNEL_ID_RE,
  channelModeOf,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
  type ReplySettings,
} from './config.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'
import {
  decideDelivery,
  stripPersonaMention,
  type DeliverDecision,
  type DeliveryDecision,
  type DropDecision,
  type FungibleDecisionInputs,
  type FungiblePath,
  type StoredChoices,
} from './delivery-decision.ts'
import { personaDestinationOf } from './persona-destination.ts'
import { hasGetStreamKey, sanitizeFilename } from './lib.ts'
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
import { describeSlackCallFailure, describeThrownValue } from './persona-connection-errors.ts'
import { createInboundDedupeStore, type InboundDedupeStore } from './inbound-dedupe.ts'
import { getSessionByPersona } from './registry.ts'
import { isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from './restart.ts'
import { isAtCap } from './backoff.ts'
import { trackAck } from './ack-tracker.ts'
import {
  buildLostMessageNotice,
  decideEarlyLostMessageState,
  decideLostMessageState,
  firesHumanTriggeredRestart,
  type EarlyLostMessageQueries,
} from './lost-message.ts'
import { getOutageFlags } from './outage-state.ts'
import { LIVENESS_PENDING, livenessKindOf, type LivenessReading } from './liveness-reading.ts'
import { describeAgentDirectorFailure } from './ad-error-class.ts'
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
  /**
   * The server-wide reply settings (b.av2 SR-1.6), read for the ack reaction
   * name; absent `ack_reaction` means no reaction. Their start-time values.
   */
  getReplySettings(): Pick<ReplySettings, 'ack_reaction'>
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
  isLaunchOrApproverRunning?(key: string): boolean
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
   * `personaKeys`: ack it, then archive it and run the pipeline for each
   * receiving persona, each run isolated from the others. Resolves once every
   * run has settled. Never rejects.
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
   * Drop the persona's inbound dedupe store and its heard set (b.av2 SR-6.5
   * as amended by b.jg5 SRJ-1507, a teardown; b.deo SRI-307), so a persona
   * added later with the same key starts with empty ones and logs its
   * `persona-invited-channel` lines again. Another event received for the key
   * creates a new store, so the teardown stops the persona's connection
   * first. Other personas' stores and heard sets are untouched; logs nothing.
   * A no-op for an unknown key.
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

  /**
   * Each persona's heard set, by persona key (b.deo SRI-307): the channels
   * whose events took its fungible path in its current persona life. In
   * memory only; dropped with the dedupe store by `forget`.
   */
  const heardSets = new Map<string, Set<string>>()

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

  async function receive(
    event: unknown,
    ack: SlackAck,
    personaKeys: string | readonly string[],
    isExtSharedChannel?: unknown,
  ): Promise<void> {
    try {
      await ack()
    } catch (err) {
      deps.log(`[slack] persona-routing: failed to ack event${describeSlackCallFailure(err)}`)
    }
    if (typeof event !== 'object' || event === null) return
    const keys = typeof personaKeys === 'string' ? [personaKeys] : personaKeys
    await Promise.all(keys.map((key) => runIsolated(key, event, isExtSharedChannel)))
  }

  /**
   * Archive, then read the mode once for the event; in fungible mode end an
   * `app_mention` there; drop a duplicate silently; else run P's pipeline.
   * Never rejects.
   */
  async function runIsolated(key: string, event: object, isExtSharedChannel: unknown): Promise<void> {
    try {
      deps.archive(key, event)
    } catch (err) {
      deps.log(`[slack] persona-routing: archive write failed for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
    try {
      const ev = event as Record<string, unknown>
      // b.deo SRI-201, SRI-302: the mode in force as this event arrives.
      const mode = channelModeOf(deps.getPersonaConfig())
      // b.deo SRI-302: in fungible mode the `message` event carrying the same
      // mention decides, so an `app_mention` (a group-DM one included) ends
      // after its archive write, with no dedupe record and no decision.
      if (mode === FUNGIBLE_MODE && ev['type'] === APP_MENTION_EVENT_TYPE) return
      if (dedupeStoreFor(key).record(ev['channel'], ev['ts'], editedTs(ev)) === 'duplicate') return
      await runPipeline(key, ev, mode, isExtSharedChannel)
    } catch (err) {
      deps.log(`[slack] persona-routing: error handling event for persona ${refForKey(key)}${describeSlackCallFailure(err)}`)
    }
  }

  async function runPipeline(
    key: string,
    ev: Record<string, unknown>,
    mode: ChannelMode,
    isExtSharedChannel: unknown,
  ): Promise<void> {
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
      fungibleInputs(config, mode, isExtSharedChannel),
    )
    const path = fungiblePathOf(decision)
    if (path !== undefined) logFirstHeard(persona, String(ev['channel']), path)
    if (decision.action === 'drop') {
      logDrop(persona, ev, decision)
      return
    }
    await dispatch(persona, identity?.botUserId, ev, decision, config)
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
      fungibleDestinations: config.personas.map((p) => ({ key: p.key, destination: personaDestinationOf(config, p) })),
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
    // The ack reaction comes only after the send (below).
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

    // A throwing send propagates (the caller logs it): no entry, no reaction.
    await session.server.notification({
      method: CHANNEL_NOTIFICATION_METHOD,
      params: { content: text, meta },
    })
    // The message is dispatched: only now does P react to it (b.av2 SR-4.5).
    addAckReaction(persona.key, chatId, ts)
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
   * P's ack reaction and ack-tracker entry for a message whose notification
   * P's session has accepted, through P's own client; skipped when there is
   * no reaction or P has no client. The entry (keyed by P's key, the
   * conversation and the ts) is recorded first and the reaction call issued,
   * not awaited, so P's first reply always finds the entry. A failed reaction
   * is non-critical: swallowed, the entry kept, the message still delivered.
   */
  function addAckReaction(key: string, channel: string, ts: string): void {
    const reaction = deps.getReplySettings().ack_reaction
    if (!reaction) return
    const client = deps.clientFor(key)
    if (!client) return
    trackAck(key, channel, ts)
    try {
      client.reactions.add({ channel, timestamp: ts, name: reaction }).catch(() => { /* non-critical */ })
    } catch { /* non-critical */ }
  }

  /**
   * b.av2 SR-4.6, SR-7.3; b.jg5 SRJ-1011: the message is lost. Decide the
   * recovery state, the first that applies, from: whether P is up
   * (`isPersonaUp`: a persona that is not up, such as one that stopped being
   * up while this message was being handled, is launched by its own
   * recovery, never restarted from here); whether P is latched (`isLatched`,
   * `held-for-human`); whether P is not answering (`not-answering`: its
   * `tmux-unresponsive` condition holds, or its `tmux-unavailable` or
   * `ad-config-malformed` outage flag is raised, P is below the restart cap
   * and P's retry timer is armed, `isRetryArmed`; an unclassified-error
   * episode is not consulted);
   * whether P's row reads `pending` (`session-starting`: a launch for P is
   * running, `isLaunchOrApproverRunning`, or the one row read answered
   * `pending`); and P's real restart guards (pending, auto-restart disabled,
   * cap). The held-on-invalid-flags, kill-failed and sequence/wait members
   * are asked too, when supplied.
   *
   * The retry-timer gate (b.jg5 SRJ-1011 as amended: "state 5 applies only
   * while P's retry timer is armed"): state 5's notice says CSCB is
   * retrying, so a P whose retry timer is not armed, or that is at the
   * restart cap (SRJ-305; `isAtCap(key, RESTART_FAILURE_CAP)`, asked even
   * when `isRetryArmed` is absent), is not in state 5, whatever condition or
   * flag is raised. A timer still armed at the cap stops at its next retry,
   * so the cap wins over it. Such a P gets no early state and falls through
   * to the later ones: `session-starting` when the row reads `pending`,
   * `restarting` when a restart is pending, `auto-restart-disabled` at delay
   * 0, else `restart-limit-reached` at the cap, none of which fires a
   * restart. So a P at the cap reports `restart-limit-reached` (unless an
   * earlier of those applies), never state 5. The gate applies wherever
   * state 5 is asked: the read gate's check of states 1 to 5 and the final
   * decision.
   *
   * The missing retry timer (b.jg5 SRJ-311): before the read gate's check,
   * and again before the final decision when a row read was awaited (a
   * retry may have stopped during it), when none of states 1 to 4 applies,
   * state 5's condition holds, P's `tmux-unavailable` flag is raised and P
   * is below the restart cap, `armRetryTimerIfMissing` is asked for P
   * (`armStoppedRetryBeforeDecision`). Then the gated decision sees the timer
   * it armed, so a P whose retry stopped with the flag still raised is
   * retried, even with `health_check_interval` 0, and reports
   * `not-answering`. At the cap nothing is armed: a timer armed there would
   * stop at its first retry, and the notice must not say CSCB is retrying.
   * That arm is the outage's own retry, never a restart.
   *
   * The read gate (b.jg5 SRJ-1011): one row read of P (`readRowLiveness`) is
   * made only when none of states 1 to 5 applies (asked through the same
   * helper the decision asks first, gated as above), no launch or approver
   * for P runs, no live-row sequence or old-life wait step runs for P and
   * nothing is in flight for P (`isWorkInFlight`). Never more than one read,
   * no retry, no timer. The read is outside any launch or recovery attempt
   * (see `readRowOnce`).
   *
   * Decide again after the read: the state is decided once, after the read,
   * over fresh answers to every query, so a latch or outage that began during
   * the read, or that the read raised itself, reports state 2 or 5 (state 5
   * only while P's retry timer is armed and P is below the restart cap).
   *
   * The no-restart rule (b.jg5 SRJ-1501): a human-triggered restart of P in
   * `cwd` is scheduled only when that final state fires one
   * (`firesHumanTriggeredRestart`: `starting-now` only), so none fires in
   * states 2 to 6; in state 6 it would be a launch over the `pending` row.
   * Nothing is awaited between the final decision and `scheduleRestart`, so
   * messages lost together schedule at most one restart.
   *
   * Then one lost-message notice naming `senderLabel` and the state is
   * raised at P's destination. Nothing is posted in the source conversation.
   * The notice is awaited so it is issued before dispatch returns; a failing
   * sink is logged, never thrown.
   */
  async function handleLostMessage(
    persona: Persona,
    cwd: string,
    senderLabel: string,
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
      isRowPending: () => rowReadPending || deps.isLaunchOrApproverRunning?.(key) === true,
      isRestartPending: () => isRestartPendingOrActive(key),
      isAutoRestartDisabled: () => config.session_restart_delay === 0,
      isAtRestartLimit: () => isAtCap(key, RESTART_FAILURE_CAP),
    })
    // Nothing is awaited between the decision above and this call.
    if (firesHumanTriggeredRestart(state)) scheduleRestart(key, cwd, undefined, { humanTrigger: true })
    try {
      await deps.notify(persona.key, buildLostMessageNotice(senderLabel, state))
    } catch (err) {
      deps.log(
        `[slack] persona-routing: lost-message notice for persona ${renderPersonaRef(persona.name, persona.key)} ` +
        `failed: ${describeThrownValue(err)}`,
      )
    }
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
    if (deps.isLaunchOrApproverRunning?.(key) === true) return false
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
      dedupeStores.delete(key)
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
