/**
 * test-helpers/persona-routing-harness.ts — The real inbound routing module
 * over stub Slack clients, the real registry and the real restart state
 * (b.av2 SR-4.1, SR-4.2 as decided by src/delivery-decision.ts, SR-13.4).
 *
 * `makeRoutingHarness(specs, baseDir, opts?)` builds the real
 * `createPersonaRouting` from src/persona-routing.ts over:
 * - one `makeStubSlack` stub per persona (leak marker on), handed out through
 *   `makePersonaClients` as the injected `clientFor` (`h.clients.setUnavailable`
 *   takes a persona's client away, as before validation or in dry run);
 * - the real persona-keyed registry: each persona named in `sessions` (default
 *   all) gets a registered session with a fake transport (holding `_GET_stream`
 *   unless `streamless`) and a fake MCP server that records
 *   `notifications/claude/channel` calls (or throws, with `throwOnNotify`, an
 *   error whose message carries the leak marker inside a token and a URL).
 *   An `onNotify` hook runs when `notification()` is called and is awaited
 *   before the call is recorded, so a test can put the send in an ordered log,
 *   hold it open or make it fail (a throwing hook: not recorded);
 * - the real restart and backoff state, with `initRestart` given
 *   `makeRestartDeps`: every liveness probe answers the `dead` reading
 *   (`LIVENESS_READING_DEAD`, src/liveness-reading.ts), the kill answers the
 *   success outcome (`killed`, `kill_sent: true`, src/checked-kill.ts), so the
 *   launch follows it (b.jg5 SRJ-701), launches are recorded in
 *   `h.launches`, every relaunch-gate ask (`canRestart`, made when a restart
 *   is scheduled and when its timer fires) in `h.restartAsks`, and the restart
 *   delay is read from `h.restartDelayS` at call time. `launchSession`
 *   replaces the launch outcome (hold a launch open to keep the persona in
 *   flight: it then reads as a launch running); `holdLaunches` holds every
 *   launch's outcome open until `h.releaseLaunches()` settles them;
 * - the real persona notifier as the injected `notify`, built by
 *   `makeNotifierStack` (tests/test-helpers/persona-notifier.ts) over the
 *   same `clientFor` and stubs and the applied config (`h.config`, read at
 *   call time), never in dry run, so a lost-message notice is a
 *   `chat.postMessage` on the persona's own stub at its destination (a
 *   channel, or for `permission_prompts: 'dm'` the DM `conversations.open`
 *   returns). Its destination hold (`h.hold`) runs on a fake clock
 *   (`h.holdClock`), never the real one. A persona whose client is
 *   unavailable has its notices held until `h.notifier.flush(key)`. Every
 *   notice the routing raises is also recorded, body only, in `h.notices`;
 *   the `notify` option replaces the notifier (for example with a throwing
 *   sink);
 * - the user-name lookup, as src/server.ts does it: `users.info` through the
 *   persona's client from `clientFor`, or the user ID when the persona has no
 *   client (`h.clients.setUnavailable`); the `resolveUserName` option
 *   replaces it;
 * - the up predicate (`isPersonaUp`), only when the caller passes one or asks
 *   for the up check (`upCheck`, or `notUp` with persona names), so by
 *   default every persona counts as up. The up check is the real
 *   `createPersonaUpPredicate` over a connection that serves for every
 *   persona and a bring-up outcome that is `up` except for the keys in
 *   `h.notUp` (read at call time; `h.upOutcomes` is that outcome, for a
 *   relaunch gate over the same state); every key it is asked about is
 *   recorded in `h.upAsks`;
 * - the lost-message state inputs (b.jg5 SRJ-1011), each composed as `main()`
 *   binds it and asked with the persona key at call time:
 *   - latched (`held-for-human`): `h.latch`, one real latch instance built by
 *     E13's factory (`createConflictLatch`) bare, with no set observer, so a
 *     set (`h.latch.set`, `h.latch.setFromConflict`) logs one line to
 *     `h.logs` and posts nothing; `h.latch.forget(key)` is its silent drop.
 *     The restart deps are not given the latch, so the routing's own rule
 *     (only `starting-now` restarts) is what keeps a latched persona's
 *     message from restarting it;
 *   - not answering (`not-answering`): `h.tmuxUnresponsive`, E10's real
 *     condition over `h.episodes`, one real episodes instance on its own fake
 *     clock (`h.episodesClock`), whose sink records into `h.episodeNotices`,
 *     never a Slack stub. The condition is built with no alert threshold, so
 *     it arms no timer. The routing asks its `holds`; P's `tmux-unavailable`
 *     and `ad-config-malformed` flags are read by the routing itself from the
 *     real outage state. With the `outageState` option the harness installs
 *     that state (`initOutageState`) with a recording sink (`h.outageNotices`),
 *     never a Slack stub, so `raiseTmuxUnavailable`, `raiseAdConfigMalformed`,
 *     `setOutageFlag` and `clearOutageFlag` work and their notices are not
 *     posts; without it a raise does nothing. An unclassified-error episode
 *     opened in `h.episodes` is not an input (SRJ-1011);
 *   - P's retry timer armed (`isRetryArmed`, b.jg5 SRJ-1011 as amended:
 *     "state 5 applies only while P's retry timer is armed"): whether the key
 *     is in `h.retryArmed`, read at call time, exactly as `main()` reads the
 *     one retry controller's `isArmed`. In production every state-5 source
 *     arms P's timer (E10's condition start, the `tmux-unavailable` and
 *     `ad-config-malformed` raises), so by default every persona's timer is
 *     armed (`retryArmed` replaces that, with persona names: `[]` for none);
 *     a case takes it away with `h.retryArmed.delete(key)`, as a retry that
 *     stopped. The restart cap is the routing's own read of the real backoff
 *     state: `putAtRestartCap(key)` records `RESTART_FAILURE_CAP` real
 *     failures there;
 *   - a launch or dialog approver running (`session-starting`): by default,
 *     as `main()` binds it (`isLaunchInFlight` or `isDialogApproverRunning`,
 *     b.jg5 SRJ-401), whether one of the harness's own restart launches is in
 *     flight for the key (`h.isLaunchInFlight`), so a restart launch held
 *     open (`launchSession`) reads as a launch running, or the session
 *     manager's `isDialogApproverRunning` answers true for it (the approver a
 *     real launch started runs on after its launch call returned; the
 *     harness's own launches are recorded fakes and start none); the
 *     `isLaunchOrApproverRunning` option replaces it;
 *   - held on `ErrInvalidFlags` (`cannot-launch`) and kill failed
 *     (`kill-failed`): the key sets `h.heldOnInvalidFlags` and `h.killFailed`
 *     (seeded by the options of the same names, with persona names);
 *   - a live-row sequence or old-life wait step running (`restarting`): as
 *     `main()` binds it (b.jg5 SRJ-706), the session manager's
 *     `isLiveRowSequenceRunning` for the key, read at call time (false while
 *     no sequence registry is installed, as here unless a case installs
 *     one), or the key in `h.sequenceOrWaitRunning` (seeded by the option of
 *     the same name, with persona names), a case's own arrangement;
 *   - in flight for P (the read gate's `isWorkInFlight`): as `main()`
 *     composes "in flight for P" (`isPersonaWorkInFlight`) from "blocks a
 *     retry" (`isPersonaRetryBlocked`) and a running dialog approver: one of
 *     the harness's own restart launches in flight (`h.isLaunchInFlight`),
 *     the session manager's `isLiveRowSequenceRunning` answering true for the
 *     key (b.jg5 SRJ-706), the key in `h.workInFlight` (seeded by
 *     `workInFlight`, with persona names), work in flight that is not a
 *     launch (a later Epic's wait step), or the session manager's
 *     `isDialogApproverRunning` answering true for the key (b.jg5 SRJ-401).
 *     With no approver and no sequence running, a harness built with no
 *     option behaves as before;
 *   - the one lost-message row read (`readRowLiveness`), only with the
 *     `rowRead` option; without it the routing gets no read and makes none.
 *     Each persona's answer is scripted in `h.rowReadScripts` (by key, read at
 *     call time, seeded from `rowRead` by persona name): a reading from
 *     src/liveness-reading.ts (`pending`, `live`, `dead` for no row,
 *     `unknown`), or `ROW_READ_REJECTS`, a rejection whose message carries
 *     the leak sentinel only through `sentinelInMessage`
 *     (`ROW_READ_REJECTION_MESSAGE`; `ROW_READ_REJECTION_REDACTED` once
 *     redacted) and whose `detail` carries it bare. An unscripted persona
 *     answers `UNSCRIPTED_ROW_READING` (`dead`, as the restart deps' probe).
 *     A script's `during` runs, awaited, after the read is recorded and
 *     before it settles (to latch P or raise an outage during the read, or
 *     hold the read open). Every read is recorded at its start in
 *     `h.rowReads` (its key) and in `h.readOrder` (`read:<key>`), which also
 *     gets `notice:<key>` for every notice the routing raises, so a case sees
 *     each read's place relative to the notices;
 *   - the missing-retry-timer arm (`armRetryTimerIfMissing`, b.jg5 SRJ-311),
 *     only with the `armRetryTimer` option: a member that records every ask,
 *     by key, in `h.retryTimerArms` and then arms P's timer (adds the key to
 *     `h.retryArmed`; nothing new when it is armed already, as production's
 *     check arms only when none is); without it the member is absent, as a
 *     caller that does not wire it leaves it;
 * - the server-wide reply settings source (`getReplySettings`, as src/server.ts
 *   passes its start-time settings): it returns the `ackReaction` option and
 *   the default chunking, so by default there is no ack reaction and a
 *   delivery makes no `reactions.add` call;
 * - `h.reply(name, args)`: persona `name`'s `reply` tool call through the real
 *   session server (`createSessionServer` over an in-memory MCP link) with the
 *   same `clientFor`, the real ack tracker and the same reply settings source
 *   as the routing, as src/server.ts shares one source between the inbound ack
 *   step and the `reply` tool. So an ack-tracker entry the routing recorded is
 *   observed as a `reactions.remove` on the persona's own stub;
 * - a line capture for the module's log seam, the notifier and the hold
 *   (`h.logs`), and an order capture (`h.order`) for ack, archive, config and
 *   identity reads.
 *
 * Every call builds a new routing, so every harness starts with empty
 * per-persona dedupe stores; `dedupeClock` injects their clock (default
 * `Date.now`).
 *
 * The harness calls `initRestart` (and, with `outageState`,
 * `initOutageState`) and registers sessions; reset the registry, restart,
 * backoff, ack-tracker and outage state between tests with
 * `resetRoutingState()`. A case that can hold a notice (a failing destination)
 * calls `h.hold.cancelAll()` in teardown; the hold's timers are on
 * `h.holdClock`, so nothing fires unless the test moves it.
 *
 * Isolation (b.av2 SR-13.2): every path is under the caller's `baseDir`; no
 * I/O of its own, no timers, no token literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { WebClient } from '@slack/web-api'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { replySettingsOf, type Persona, type PersonaConfig, type ReplySettings } from '../../src/config.ts'
import { createPersonaRouting, type PersonaRoutingDeps } from '../../src/persona-routing.ts'
import { formatPersonaNotice, type PersonaNotifier } from '../../src/persona-notifier.ts'
import type { PersonaDestinationHold } from '../../src/persona-destination-hold.ts'
import { LOST_MESSAGE_STATES, STATE_WORDING, type LostMessageState } from '../../src/lost-message.ts'
import { createConflictLatch, type ConflictLatch } from '../../src/conflict-latch.ts'
import {
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
} from '../../src/persona-episodes.ts'
import { _resetOutageState, initOutageState } from '../../src/outage-state.ts'
import { isDialogApproverRunning, isLiveRowSequenceRunning } from '../../src/session-manager.ts'
import { createSessionServer, registerSession, _resetRegistry, type SessionEntry, type SessionToolDeps } from '../../src/registry.ts'
import {
  initRestart,
  isRestartPendingOrActive,
  scheduleRestart,
  _resetRestartState,
  RESTART_FAILURE_CAP,
  type RestartDeps,
} from '../../src/restart.ts'
import { LIVENESS_READING_DEAD, type LivenessReading } from '../../src/liveness-reading.ts'
import { KILL_OUTCOME_KILLED } from '../../src/checked-kill.ts'
import { _resetBackoffState, isAtCap, recordFailure } from '../../src/backoff.ts'
import { LATCH_ROW_STATE_NO_ROW, REFUSED_OPERATION_PLAIN_SPAWN } from '../../src/conflict-latch.ts'
import { createPersonaUpPredicate } from '../../src/persona-start.ts'
import type { PersonaConnectionStatus } from '../../src/persona-connections.ts'
import { _resetAckTracker, consumeAck } from '../../src/ack-tracker.ts'
import {
  archiveSlackMessage,
  createNameResolver,
  type NameResolverWebClient,
  type SlackMessageEvent,
} from '../../src/message-archive.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeStubSlack, type StubSlack, type StubSlackOptions } from './slack-stub.ts'
import { makePersonaClients, posts, type PersonaClients } from './permission-relay-harness.ts'
import { LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeNotifierStack } from './persona-notifier.ts'
import { errTmuxUnresponsive } from './agent-director-stub.ts'
import { conflictForPersona } from './conflict-cases.ts'

/** Default restart delay (seconds): the restart timer fires within a few ms. */
export const FAST_RESTART_DELAY_S = 0.005

/** A restart delay (seconds) that never fires during a test. */
export const NEVER_FIRE_RESTART_DELAY_S = 9999

/** A connection that serves, so only the bring-up outcome decides whether a persona is up. */
const SERVING_CONNECTION: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0SERVING', botId: 'B0SERVING' } }

// ---------------------------------------------------------------------------
// Lost-message recovery states
// ---------------------------------------------------------------------------

/**
 * Every recovery state a lost-message notice reports, in SRJ-1011's order:
 * the list `src/lost-message.ts` exports, re-exported, never a copy.
 */
export { LOST_MESSAGE_STATES }

/**
 * The one recovery state a notice text identifies: the state whose exported
 * wording (`STATE_WORDING`) the text contains, or `none` / `several`. Whole
 * wordings are matched, so `session-starting`'s wording is never taken for
 * `starting-now`'s, whose opening words it shares.
 */
export function stateOf(text: string | undefined): LostMessageState | 'none' | 'several' {
  const found = LOST_MESSAGE_STATES.filter((s) => (text ?? '').includes(STATE_WORDING[s]))
  return found.length === 1 ? found[0]! : found.length === 0 ? 'none' : 'several'
}

/**
 * What a recovery state needs of the harness it is arranged on: the up check
 * (`upCheck`, so `arrange` can take P's bring-up outcome off `up`), every
 * restart launch held open (`holdLaunches`, released by
 * `h.releaseLaunches()`), and the server-wide `session_restart_delay` (0:
 * auto-restart disabled). A caller's own harness wrapper takes these three
 * and hands them to `makeRoutingHarness` (the delay through `overrides`).
 */
export interface LostStateOptions {
  upCheck?: boolean
  holdLaunches?: boolean
  sessionRestartDelay?: number
}

/** How one recovery state is arranged for P's next lost message, and what follows once it is handled. */
export interface LostStateSetup {
  /** Harness options the state needs (see `LostStateOptions`), merged over the caller's. */
  opts: LostStateOptions
  /**
   * Put persona `key`, whose launches run in `cwd`, in the state, through the
   * harness's real inputs, on a harness whose restart delay fires fast (so a
   * wrongly scheduled restart would launch). Throws when the input did not
   * take.
   */
  arrange(h: RoutingHarness, key: string, cwd: string): Promise<void> | void
  /** Whether a restart of P is pending or active right after the message (one arranged before it, or its own). */
  pending: boolean
  /** The launches there are once the message is handled, each of P in `cwd`. */
  launches: number
}

/** Throws `what` unless `ok`: an arrangement whose input did not take. */
function arranged(ok: boolean, what: string): void {
  if (!ok) throw new Error(`lost-message state arrangement failed: ${what}`)
}

/**
 * Put persona `key` at the restart cap (SRJ-305) through the real backoff
 * state: `RESTART_FAILURE_CAP` failures recorded with `recordFailure`, as
 * counted launch failures record them. Throws unless `isAtCap` then answers
 * true. `resetRoutingState()` undoes it.
 */
export function putAtRestartCap(key: string): void {
  for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
  arranged(isAtCap(key, RESTART_FAILURE_CAP), 'P is not at the restart cap')
}

/**
 * The one per-state table for a lost message's recovery state (b.jg5
 * SRJ-1011, SRJ-1501): each state of `LOST_MESSAGE_STATES` arranged through
 * the harness's real inputs, with what it leaves. Only `starting-now`
 * schedules a restart from the message; `session-starting`'s launch and
 * `restarting`'s timer were arranged before it.
 */
export const LOST_STATE_SETUPS: Readonly<Record<LostMessageState, LostStateSetup>> = {
  // Bug b.g57: P's bring-up outcome is not up while its connection still
  // delivers the message, through the real up predicate.
  'not-up': {
    opts: { upCheck: true },
    arrange: (h, key) => { h.notUp.add(key) },
    pending: false,
    launches: 0,
  },
  // E13's set entry, on a CONFLICT.
  'held-for-human': {
    opts: {},
    arrange: (h, key) => {
      h.latch.setFromConflict(key, conflictForPersona(key), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW })
      arranged(h.latch.isLatched(key), 'P is not latched')
    },
    pending: false,
    launches: 0,
  },
  'cannot-launch': { opts: {}, arrange: (h, key) => { h.heldOnInvalidFlags.add(key) }, pending: false, launches: 0 },
  'kill-failed': { opts: {}, arrange: (h, key) => { h.killFailed.add(key) }, pending: false, launches: 0 },
  // E10's entry: a refusal from a tmux-touching verb starts the condition,
  // with P's retry timer armed (state 5 applies only while it is, b.jg5
  // SRJ-1011 as amended; production arms it at the same refusal).
  'not-answering': {
    opts: {},
    arrange: (h, key) => {
      arranged(h.tmuxUnresponsive.start(key, 'resume', errTmuxUnresponsive('resume')) === 'started', 'the condition did not start')
      h.retryArmed.add(key)
    },
    pending: false,
    launches: 0,
  },
  // A restart's launch of P in flight and held open: a launch running
  // (production: `isLaunchInFlight`). A stacked launch would make two.
  'session-starting': {
    opts: { holdLaunches: true },
    arrange: async (h, key, cwd) => {
      scheduleRestart(key, cwd)
      await waitFor(() => h.launches.length === 1)
      arranged(h.launches.length === 1 && h.isLaunchInFlight(key), 'no launch of P in flight')
    },
    pending: true,
    launches: 1,
  },
  // A restart of P whose timer never fires; restart.ts can launch again after.
  'restarting': {
    opts: {},
    arrange: (h, key, cwd) => {
      const delay = h.restartDelayS
      h.restartDelayS = NEVER_FIRE_RESTART_DELAY_S
      scheduleRestart(key, cwd)
      h.restartDelayS = delay
      arranged(isRestartPendingOrActive(key), 'no restart of P pending')
    },
    pending: true,
    launches: 0,
  },
  'starting-now': { opts: {}, arrange: () => {}, pending: true, launches: 1 },
  // restart.ts itself would launch (a nonzero restart delay) if it were asked.
  'auto-restart-disabled': { opts: { sessionRestartDelay: 0 }, arrange: () => {}, pending: false, launches: 0 },
  'restart-limit-reached': {
    opts: {},
    arrange: (_h, key) => { putAtRestartCap(key) },
    pending: false,
    launches: 0,
  },
}

// ---------------------------------------------------------------------------
// The lost-message row read (b.jg5 SRJ-1011)
// ---------------------------------------------------------------------------

/** A scripted row read that rejects (see `ROW_READ_REJECTION_MESSAGE`). */
export const ROW_READ_REJECTS = 'rejects'

/** What one scripted row read answers: a reading from src/liveness-reading.ts, or a rejection. */
export type RowReadAnswer = LivenessReading | typeof ROW_READ_REJECTS

/**
 * Runs, awaited, after a scripted read of persona `key` is recorded and
 * before it settles: latch P, raise an outage or hold the read open.
 */
export type RowReadDuring = (h: RoutingHarness, key: string) => void | Promise<void>

/** One persona's scripted row read. */
export interface RowReadScript {
  answer: RowReadAnswer
  during?: RowReadDuring
}

/** What a persona with no script answers: the `dead` reading (no row), as the restart deps' probe. */
export const UNSCRIPTED_ROW_READING: LivenessReading = LIVENESS_READING_DEAD

/**
 * The message of a scripted rejection's error: the leak sentinel only inside
 * a fake token and a ticket URL (`sentinelInMessage`), the shapes
 * `redactSlackLogText` removes.
 */
export const ROW_READ_REJECTION_MESSAGE = `status read failed (${sentinelInMessage('row-read')})`

/** `ROW_READ_REJECTION_MESSAGE` as a log line keeps it once redacted. */
export const ROW_READ_REJECTION_REDACTED = `status read failed (${REDACTED_SENTINEL_TAIL})`

/** The error a scripted rejection throws: its message as above, its `detail` the bare sentinel (never to be logged). */
function rowReadRejection(): Error {
  return Object.assign(new Error(ROW_READ_REJECTION_MESSAGE), { detail: LEAK_SENTINEL })
}

/** A script, from an answer alone or a whole script. */
function toRowReadScript(value: RowReadAnswer | RowReadScript): RowReadScript {
  return typeof value === 'object' && 'answer' in value ? value : { answer: value }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One captured `notifications/claude/channel` call. */
export interface ChannelNotification {
  method: string
  params: { content: string; meta: Record<string, string> }
}

/**
 * Runs when a fake session's `notification()` is called, before the call is
 * recorded; awaited, so a pending hook holds the send open and a throwing one
 * fails it (the notification is then not recorded).
 */
export type NotifyHook = (msg: ChannelNotification) => void | Promise<void>

/**
 * A fake MCP server whose `notification()` records into `notifications`, or
 * throws when `throws`. `onNotify`, when given, runs first (see `NotifyHook`).
 * The thrown message carries `LEAK_SENTINEL` only inside a fake token and a
 * `wss://…?ticket=` URL (`sentinelInMessage`): log lines keep a message
 * after `redactSlackLogText`, which removes both shapes, so the sentinel
 * shows only if redaction is skipped.
 */
export function makeSessionServer(notifications: ChannelNotification[], throws = false, onNotify?: NotifyHook): Server {
  return {
    connect: async () => {},
    notification: async (msg: ChannelNotification) => {
      if (throws) throw new Error(`notification failed (${sentinelInMessage('notify')})`)
      if (onNotify) await onNotify(msg)
      notifications.push(msg)
    },
  } as unknown as Server
}

/** A fake transport with MCP session ID `sessionId`; `_streamMapping` holds `_GET_stream` unless `streamless`. */
export function makeTransport(sessionId: string, streamless = false): WebStandardStreamableHTTPServerTransport {
  return {
    sessionId,
    _streamMapping: new Map<string, unknown>(streamless ? [] : [['_GET_stream', {}]]),
    handleRequest: async () => new Response(),
    close: async () => {},
  } as unknown as WebStandardStreamableHTTPServerTransport
}

/** One session the harness registered. */
export interface SessionHandle {
  /** Working directory the session reports. */
  cwd: string
  /** Its transport's MCP session ID. */
  mcpSessionId: string
  /** Notifications its server received. */
  notifications: ChannelNotification[]
}

export interface RegisterSessionOptions {
  /** Distinguishes this session's cwd and MCP session ID from the persona's first one. */
  tag?: string
  /** The session has lost its `_GET_stream` (b.9cj). */
  streamless?: boolean
  /** The session reads `connected: false`. */
  disconnected?: boolean
  /** The session's `notification()` throws. */
  throwOnNotify?: boolean
  /** Runs when the session's `notification()` is called, awaited before it is recorded (see `NotifyHook`). */
  onNotify?: NotifyHook
}

// ---------------------------------------------------------------------------
// Restart deps
// ---------------------------------------------------------------------------

/** One launch the restart module issued. `sessionId` is present only when it passed one. */
export interface LaunchCall {
  key: string
  cwd: string
  sessionId?: string
}

export interface RestartFakeOptions {
  /** Restart delay (seconds), or a getter read at call time. Default `FAST_RESTART_DELAY_S`. */
  restartDelayS?: number | (() => number)
  /** Replaces the launch outcome (default: resolves true). Called after the launch is recorded. */
  launchSession?: (key: string, cwd: string, sessionId?: string) => Promise<boolean>
}

/** What `makeRestartDeps` adds to the restart deps: its captures and its in-flight query. */
export interface RestartFakeCaptures {
  /** Every launch issued, in order. */
  launches: LaunchCall[]
  /** Every key the relaunch gate (`canRestart`) was asked about, in order. */
  restartAsks: string[]
  /** Whether a launch for `key` has been issued and has not settled (production: `isLaunchInFlight`). */
  isLaunchInFlight(key: string): boolean
}

/**
 * Restart deps whose session always reads `dead`, whose kill answers the
 * success outcome (`killed` with `kill_sent: true`, `src/checked-kill.ts`; b.jg5
 * SRJ-701: only a success lets the launch follow), whose launches are recorded
 * in `launches` (and counted in flight until their outcome settles) and whose
 * relaunch-gate asks are recorded in `restartAsks`.
 */
export function makeRestartDeps(opts: RestartFakeOptions = {}): RestartDeps & RestartFakeCaptures {
  const launches: LaunchCall[] = []
  const restartAsks: string[] = []
  const inFlight = new Map<string, number>()
  const delay = opts.restartDelayS ?? FAST_RESTART_DELAY_S
  return {
    launches,
    restartAsks,
    isLaunchInFlight: (key) => (inFlight.get(key) ?? 0) > 0,
    canRestart: (key) => {
      restartAsks.push(key)
      return true
    },
    isSessionAlive: async () => LIVENESS_READING_DEAD,
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    reconnectSession: async () => 'success',
    killSession: async () => ({ kind: KILL_OUTCOME_KILLED, killSent: true }),
    launchSession: async (key, cwd, sessionId) => {
      launches.push(sessionId === undefined ? { key, cwd } : { key, cwd, sessionId })
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      try {
        return opts.launchSession ? await opts.launchSession(key, cwd, sessionId) : true
      } finally {
        const left = (inFlight.get(key) ?? 1) - 1
        if (left > 0) inFlight.set(key, left)
        else inFlight.delete(key)
      }
    },
    getRestartDelay: () => (typeof delay === 'function' ? delay() : delay),
    isShuttingDown: () => false,
    onCapReached: () => {},
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One persona as the harness built it. */
export interface PersonaHandle {
  persona: Persona
  stub: StubSlack
  /** Notifications its first registered session received (empty when it has none). */
  notifications: ChannelNotification[]
  /** Working directory its first registered session reports, when it has one. */
  sessionCwd?: string
}

export interface RoutingHarnessOptions {
  /** Names with a registered session; default every persona. */
  sessions?: readonly string[]
  /** Names whose registered session has lost its `_GET_stream` (b.9cj). */
  streamless?: readonly string[]
  /** Names whose registered session reads `connected: false`. */
  disconnected?: readonly string[]
  /** Names whose session's `notification()` throws. */
  throwOnNotify?: readonly string[]
  /** Per-name hook on the harness-registered session's `notification()` (see `NotifyHook`). */
  onNotify?: Readonly<Record<string, NotifyHook>>
  /** Per-name stub options, merged over the leak marker. */
  stubOptions?: Readonly<Record<string, StubSlackOptions>>
  /** The `ack_reaction` the reply settings source (`getReplySettings`) returns to the routing and `h.reply`; default none. */
  ackReaction?: string
  /** The archive DB the archive seam writes to; the seam is a no-op without one. */
  archiveDb?: Database
  /** Replaces the user-name lookup (default: `users.info` on P's client from `clientFor`, the user ID when it has none). */
  resolveUserName?: PersonaRoutingDeps['resolveUserName']
  /** Server-wide config overrides (e.g. `session_restart_delay`). */
  overrides?: Partial<Omit<PersonaConfig, 'personas'>>
  /** Initial `h.restartDelayS`. Default `FAST_RESTART_DELAY_S`. */
  restartDelayS?: number
  /** Replaces the restart deps' launch outcome, e.g. a promise held open. */
  launchSession?: RestartFakeOptions['launchSession']
  /** Clock for the per-persona dedupe stores (e.g. a fake clock's `now`); default the module's (`Date.now`). */
  dedupeClock?: PersonaRoutingDeps['dedupeClock']
  /** Replaces the routing's `notify` (default: the real notifier, `h.notifier.notify`); calls are still recorded in `h.notices`. */
  notify?: PersonaRoutingDeps['notify']
  /** The routing's up predicate (b.av2 SR-6.4, bug b.g57); absent, as by default (and without `upCheck`), every persona counts as up. */
  isPersonaUp?: PersonaRoutingDeps['isPersonaUp']
  /**
   * Bind the up check (see the file comment): the real up predicate, not up
   * for the keys in `h.notUp`, each ask recorded in `h.upAsks`. `isPersonaUp`
   * replaces it.
   */
  upCheck?: boolean
  /** Names whose bring-up outcome is not up first (`h.notUp`); implies `upCheck`. */
  notUp?: readonly string[]
  /** Hold every restart launch's outcome open until `h.releaseLaunches()` (ignored when `launchSession` is given). */
  holdLaunches?: boolean
  /**
   * Bind the routing's `armRetryTimerIfMissing` (b.jg5 SRJ-311) as a member
   * that records each ask in `h.retryTimerArms` and arms P's timer (adds the
   * key to `h.retryArmed`). Absent, as by default: the member is absent.
   */
  armRetryTimer?: boolean
  /**
   * Names whose retry timer is armed first (`h.retryArmed`, read by the
   * routing's `isRetryArmed`); default every persona, as production arms it
   * at every state-5 source. `[]`: none armed.
   */
  retryArmed?: readonly string[]
  /**
   * Install the real outage state (`initOutageState`) with a recording sink
   * (`h.outageNotices`) and no agent-director client, so a raise or clear
   * works and its notice is not a Slack post. Default off: no outage state is
   * installed, and a raise does nothing. `resetRoutingState()` removes it.
   */
  outageState?: boolean
  /**
   * Replaces the routing's launch-or-approver query (b.jg5 SRJ-1011 state 6);
   * default `h.isLaunchInFlight` (the harness's own restart launches in
   * flight) or the session manager's `isDialogApproverRunning`, as `main()`
   * binds it.
   */
  isLaunchOrApproverRunning?: PersonaRoutingDeps['isLaunchOrApproverRunning']
  /** Names first held on `ErrInvalidFlags` (`h.heldOnInvalidFlags`, `cannot-launch`). */
  heldOnInvalidFlags?: readonly string[]
  /** Names whose kill failed first (`h.killFailed`, `kill-failed`). */
  killFailed?: readonly string[]
  /** Names with a live-row sequence or old-life wait step running first (`h.sequenceOrWaitRunning`, `restarting`). */
  sequenceOrWaitRunning?: readonly string[]
  /**
   * Names with work in flight that is not a launch first (`h.workInFlight`),
   * read by the routing's in-flight gate beside the harness's own launches
   * in flight (b.jg5 SRJ-1011).
   */
  workInFlight?: readonly string[]
  /**
   * Give the routing its lost-message row read (b.jg5 SRJ-1011), scripted
   * per persona name: an answer, or a script with a `during` callback (see
   * the file comment). `{}` binds the read with every persona unscripted
   * (`UNSCRIPTED_ROW_READING`). Absent, as by default: no read is bound, so
   * none is made.
   */
  rowRead?: Readonly<Record<string, RowReadAnswer | RowReadScript>>
}

/** One notice the routing raised: the persona key and the body, without the notifier's persona prefix. */
export interface RaisedNotice {
  key: string
  text: string
}

/** One captured `chat.postMessage`, tagged with the key of the persona whose stub made it. */
export interface HarnessPost {
  key: string
  channel: string
  text: string | undefined
}

export interface RoutingHarness {
  /** The applied config the routing reads at call time; set to null for none, or edit it. */
  config: PersonaConfig | null
  /** The persona handle by name. */
  p(name: string): PersonaHandle
  all: PersonaHandle[]
  clients: PersonaClients
  /** Lines from the module's log seam. */
  logs: string[]
  /** Ordered markers: `ack`, `archive:<key>`, `config`, `identity:<key>`. */
  order: string[]
  /** Launches the restart module issued. */
  launches: LaunchCall[]
  /** Every key the restart module's relaunch gate (`canRestart`) was asked about: one per restart scheduled and one per timer fire. */
  restartAsks: string[]
  /** Whether one of the harness's restart launches for `key` is in flight (issued, outcome not settled). */
  isLaunchInFlight(key: string): boolean
  /** The latch the routing's latched query reads: E13's factory, bare (no set observer, so a set posts nothing). */
  latch: ConflictLatch
  /** The episodes instance on `episodesClock`; its sink records into `episodeNotices`, never a Slack stub. */
  episodes: PersonaEpisodes
  /** The fake clock the episodes run on. */
  episodesClock: FakeClock
  /** Every notice `episodes` handed to its sink (the condition's onset, alert or recovery), in order. */
  episodeNotices: RaisedNotice[]
  /** E10's `tmux-unresponsive` condition over `episodes`; the routing asks its `holds`. No alert threshold, so no timer. */
  tmuxUnresponsive: TmuxUnresponsiveCondition
  /** Every onset or all-clear the outage state emitted (with the `outageState` option), in order; never a Slack post. */
  outageNotices: RaisedNotice[]
  /** Keys held on `ErrInvalidFlags` (`cannot-launch`), read at call time. */
  heldOnInvalidFlags: Set<string>
  /** Keys whose kill failed (`kill-failed`), read at call time. */
  killFailed: Set<string>
  /** Keys with a live-row sequence or old-life wait step running (`restarting`), read at call time. */
  sequenceOrWaitRunning: Set<string>
  /** Keys with work in flight that is not a launch, read by the in-flight gate at call time. */
  workInFlight: Set<string>
  /** Each persona's scripted row read, by key, read at call time (with the `rowRead` option). */
  rowReadScripts: Map<string, RowReadScript>
  /** The key of every row read the routing made, in order, recorded at the read's start. */
  rowReads: string[]
  /** `read:<key>` at each row read's start and `notice:<key>` for each notice the routing raised, in order. */
  readOrder: string[]
  /** Keys whose bring-up outcome is not up, read by the up check at call time (with `upCheck` or `notUp`). */
  notUp: Set<string>
  /** Every key the up check was asked about, in order (with `upCheck` or `notUp`). */
  upAsks: string[]
  /** The bring-up outcome the up check reads (`up` unless the key is in `notUp`), for a relaunch gate over the same state. */
  upOutcomes: { isUp(key: string): boolean }
  /** Settle every launch outcome held open (`holdLaunches`) as `ok`; returns how many were held. */
  releaseLaunches(ok?: boolean): number
  /** Every key `armRetryTimerIfMissing` was asked to arm, in order (with `armRetryTimer`). */
  retryTimerArms: string[]
  /** Keys whose retry timer is armed, read by the routing's `isRetryArmed` at call time (see `retryArmed`). */
  retryArmed: Set<string>
  /** Restart delay (seconds) the restart deps report, read at call time. */
  restartDelayS: number
  /** Archive writes started through the seam. */
  archiveWrites: Promise<boolean>[]
  /** Feed one event to the named personas (default: all), with a recording ack unless `ack` is given. */
  receive(event: unknown, names?: readonly string[], ack?: () => Promise<void> | void): Promise<void>
  /** Feed one event to raw persona keys, with a recording ack. */
  receiveKeys(event: unknown, keys: readonly string[]): Promise<void>
  /** Keys of the named personas. */
  keys(names: readonly string[]): string[]
  /** Register a (further) session for the named persona in the real registry; a live one is replaced. */
  registerFor(name: string, opts?: RegisterSessionOptions): SessionHandle
  /** Every `chat.postMessage` on every stub, tagged with the stub's persona key, in persona order. */
  allPosts(): HarnessPost[]
  /** The `chat.postMessage` calls to conversation `channel` (a `C…` or `D…` ID), on any persona's stub. */
  postsTo(channel: string): HarnessPost[]
  /** The real persona notifier the routing's `notify` defaults to (`flush(key)` posts held notices). */
  notifier: PersonaNotifier
  /** The notifier's destination hold (holds and retries a notice whose destination fails), on `holdClock`. */
  hold: PersonaDestinationHold
  /** The fake clock the destination hold runs on. */
  holdClock: FakeClock
  /** Every notice the routing raised through `notify`, in order (body only). */
  notices: RaisedNotice[]
  /** The text the notifier posts for persona `name` and notice body `body` (its persona prefix, then the body). */
  noticeText(name: string, body: string): string
  /**
   * Persona `name`'s `reply` tool call with `args`, through the real session
   * server over the same clients, the real ack tracker and the same reply
   * settings as the routing (see the file comment). Resolves once the call has
   * returned; rejects when the tool reports an error.
   */
  reply(name: string, args: Record<string, unknown>): Promise<void>
  /** Everything the harness captured, for `assertNoLeak`. */
  captured(): Record<string, unknown>
}

/**
 * Build the real routing module over `specs` (see the file comment). Every
 * persona path is under `baseDir`, the test's own temp directory.
 */
export function makeRoutingHarness(
  specs: PersonaSpec[],
  baseDir: string,
  opts: RoutingHarnessOptions = {},
): RoutingHarness {
  const config = makeMultiPersonaConfig(specs, baseDir, opts.overrides)
  const handles = config.personas.map((persona): PersonaHandle => ({
    persona,
    stub: makeStubSlack({ leakMarker: LEAK_SENTINEL, ...opts.stubOptions?.[persona.name] }),
    notifications: [],
  }))
  const byKey = (key: string) => handles.find((x) => x.persona.key === key)
  const byName = (name: string) => {
    const found = handles.find((x) => x.persona.name === name)
    if (!found) throw new Error(`no persona ${name}`)
    return found
  }
  const clients = makePersonaClients((key) => byKey(key)?.stub)
  const extraNotifications: ChannelNotification[][] = []

  function registerFor(name: string, reg: RegisterSessionOptions = {}): SessionHandle {
    const { persona } = byName(name)
    const suffix = reg.tag ? `-${reg.tag}` : ''
    const session: SessionHandle = {
      cwd: join(baseDir, 'live', `${persona.key}${suffix}`),
      mcpSessionId: `mcp-${persona.key}${suffix}`,
      notifications: [],
    }
    const entry = registerSession(
      session.cwd,
      persona.key,
      makeTransport(session.mcpSessionId, reg.streamless ?? false),
      makeSessionServer(session.notifications, reg.throwOnNotify ?? false, reg.onNotify),
    )
    if (reg.disconnected) entry.connected = false
    return session
  }

  const withSession = new Set(opts.sessions ?? config.personas.map((p) => p.name))
  for (const handle of handles) {
    const { name } = handle.persona
    if (!withSession.has(name)) continue
    const session = registerFor(name, {
      streamless: opts.streamless?.includes(name),
      disconnected: opts.disconnected?.includes(name),
      throwOnNotify: opts.throwOnNotify?.includes(name),
      onNotify: opts.onNotify?.[name],
    })
    handle.notifications = session.notifications
    handle.sessionCwd = session.cwd
  }

  // `holdLaunches`: every launch outcome pending until `h.releaseLaunches()`.
  const heldLaunches: Array<(ok: boolean) => void> = []
  const holdLaunch = (): Promise<boolean> => new Promise<boolean>((resolve) => { heldLaunches.push(resolve) })
  const restartDeps = makeRestartDeps({
    restartDelayS: () => h.restartDelayS,
    launchSession: opts.launchSession ?? (opts.holdLaunches === true ? holdLaunch : undefined),
  })

  // The up check, as main() builds it: a connection that serves for every
  // persona, so only the bring-up outcome (read at call time) decides.
  const notUp = new Set<string>()
  const upOutcomes = { isUp: (key: string) => !notUp.has(key) }
  const isUp = createPersonaUpPredicate({ status: () => SERVING_CONNECTION }, upOutcomes)
  const upAsks: string[] = []
  const upCheck: PersonaRoutingDeps['isPersonaUp'] = opts.upCheck === true || opts.notUp !== undefined
    ? (key) => {
      upAsks.push(key)
      return isUp(key)
    }
    : undefined

  // The lost-message state inputs (b.jg5 SRJ-1011), as main() builds them:
  // one latch, bare; one episodes instance on its own fake clock with the
  // condition over it (no alert threshold, so no timer); the outage state
  // only with `outageState`. Every sink records apart from the Slack stubs.
  // (`h` is read only when they are called.)
  const latch = createConflictLatch({ log: (line) => { h.logs.push(line) } })
  const episodesClock = createFakeClock()
  const episodes = createPersonaEpisodes({
    sink: (key, text) => { h.episodeNotices.push({ key, text }) },
    log: (line) => { h.logs.push(line) },
    clock: episodesClock,
  })
  const tmuxUnresponsive = createTmuxUnresponsiveCondition({ episodes, log: (line) => { h.logs.push(line) } })
  if (opts.outageState === true) {
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { h.outageNotices.push({ key, text }) },
      getClient: () => { throw new Error('the routing harness has no agent-director client') },
    })
  }
  const keySet = (names: readonly string[] | undefined): Set<string> =>
    new Set((names ?? []).map((n) => byName(n).persona.key))

  // The notifier and its hold, as server.ts builds them: the applied persona
  // read at call time, the same client lookup as the routing, one log. (`h`
  // is read only when they are called.)
  const log = (line: string): void => { h.logs.push(line) }
  const getPersona = (key: string): Persona | undefined => h.config?.personas.find((p) => p.key === key)
  const webClientFor = (key: string) => clients.clientFor(key) as unknown as WebClient | undefined
  const { notifier, hold, clock: holdClock } = makeNotifierStack({ getPersona, clientFor: webClientFor, log })
  // The one reply settings source for the inbound ack step and `h.reply`, as server.ts.
  const getReplySettings = (): ReplySettings => ({ ...replySettingsOf(null), ack_reaction: opts.ackReaction })

  async function reply(name: string, args: Record<string, unknown>): Promise<void> {
    const { persona } = byName(name)
    const deps: SessionToolDeps = {
      assertSendable: () => {},
      getReplySettings,
      getPersona,
      clientFor: webClientFor,
      inboxDir: join(baseDir, 'inbox'),
      resolveUserName: async (_key, userId) => userId,
      consumeAck,
      serverPort: 0,
    }
    const entry: SessionEntry = {
      cwd: join(baseDir, 'reply', persona.key),
      personaKey: persona.key,
      transport: makeTransport(`mcp-reply-${persona.key}`),
      server: makeSessionServer([]),
      connected: true,
      peerPort: 0,
    }
    const server = createSessionServer(entry, deps)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'routing-harness-reply', version: '1.0.0' }, { capabilities: {} })
    await client.connect(clientTransport)
    try {
      const result = (await client.callTool({ name: 'reply', arguments: args })) as { isError?: boolean }
      if (result.isError) throw new Error(`reply as ${name} reported an error`)
    } finally {
      await client.close()
    }
  }

  const h: RoutingHarness = {
    config,
    p: byName,
    all: handles,
    clients,
    logs: [],
    order: [],
    launches: restartDeps.launches,
    restartAsks: restartDeps.restartAsks,
    isLaunchInFlight: restartDeps.isLaunchInFlight,
    latch,
    episodes,
    episodesClock,
    episodeNotices: [],
    tmuxUnresponsive,
    outageNotices: [],
    heldOnInvalidFlags: keySet(opts.heldOnInvalidFlags),
    killFailed: keySet(opts.killFailed),
    sequenceOrWaitRunning: keySet(opts.sequenceOrWaitRunning),
    workInFlight: keySet(opts.workInFlight),
    rowReadScripts: new Map(Object.entries(opts.rowRead ?? {}).map(([name, v]) => [byName(name).persona.key, toRowReadScript(v)])),
    rowReads: [],
    readOrder: [],
    notUp,
    upAsks,
    upOutcomes,
    releaseLaunches: (ok = true) => {
      const held = heldLaunches.splice(0)
      for (const settle of held) settle(ok)
      return held.length
    },
    retryTimerArms: [],
    retryArmed: keySet(opts.retryArmed ?? config.personas.map((p) => p.name)),
    restartDelayS: opts.restartDelayS ?? FAST_RESTART_DELAY_S,
    archiveWrites: [],
    receive: (event, names, ack) => routing.receive(
      event,
      ack ?? (() => { h.order.push('ack') }),
      h.keys(names ?? handles.map((x) => x.persona.name)),
    ),
    receiveKeys: (event, keys) => routing.receive(event, () => { h.order.push('ack') }, keys),
    keys: (names) => names.map((n) => byName(n).persona.key),
    registerFor: (name, reg) => {
      const session = registerFor(name, reg)
      extraNotifications.push(session.notifications)
      return session
    },
    allPosts: () => handles.flatMap((x) =>
      posts(x.stub).map((c) => ({ key: x.persona.key, channel: c.channel, text: c.text })),
    ),
    postsTo: (channel) => h.allPosts().filter((c) => c.channel === channel),
    notifier,
    hold,
    holdClock,
    notices: [],
    noticeText: (name, body) => formatPersonaNotice(byName(name).persona, body),
    reply,
    captured: () => ({
      logs: h.logs,
      calls: Object.fromEntries(handles.map((x) => [x.persona.name, x.stub.calls])),
      notifications: [...handles.map((x) => x.notifications), ...extraNotifications],
      posts: h.allPosts(),
      notices: h.notices,
      episodeNotices: h.episodeNotices,
      outageNotices: h.outageNotices,
    }),
  }

  const notify: PersonaRoutingDeps['notify'] = opts.notify ?? ((key, text, options) => notifier.notify(key, text, options))
  const resolver = (key: string) => createNameResolver(byKey(key)!.stub.web as unknown as NameResolverWebClient)
  // As server.ts: the lookup goes through the persona's client, and a persona
  // with no client (not validated yet, dry run) gets the user ID.
  const resolveUserName: PersonaRoutingDeps['resolveUserName'] = async (key, userId) => {
    const client = webClientFor(key)
    return client ? createNameResolver(client as unknown as NameResolverWebClient).resolveUserName(userId) : userId
  }
  // The one lost-message row read (b.jg5 SRJ-1011), only with `rowRead`:
  // recorded at its start, then the script's `during`, then its answer.
  const readRowLiveness: PersonaRoutingDeps['readRowLiveness'] = opts.rowRead === undefined
    ? undefined
    : async (key) => {
      h.rowReads.push(key)
      h.readOrder.push(`read:${key}`)
      const script = h.rowReadScripts.get(key) ?? { answer: UNSCRIPTED_ROW_READING }
      if (script.during) await script.during(h, key)
      if (script.answer === ROW_READ_REJECTS) throw rowReadRejection()
      return script.answer
    }
  const routing = createPersonaRouting({
    getPersonaConfig: () => {
      h.order.push('config')
      return h.config
    },
    getBotIdentity: (key) => {
      h.order.push(`identity:${key}`)
      return byKey(key)?.stub.identity
    },
    clientFor: webClientFor,
    resolveUserName: opts.resolveUserName ?? resolveUserName,
    archive: (key, event) => {
      h.order.push(`archive:${key}`)
      if (opts.archiveDb) h.archiveWrites.push(archiveSlackMessage(opts.archiveDb, event as SlackMessageEvent, resolver(key)))
    },
    getReplySettings,
    notify: (key, text, options) => {
      h.notices.push({ key, text })
      h.readOrder.push(`notice:${key}`)
      return notify(key, text, options)
    },
    log,
    dedupeClock: opts.dedupeClock,
    isPersonaUp: opts.isPersonaUp ?? upCheck,
    // As main() binds them, each asked with the persona key at call time.
    isLatched: (key) => h.latch.isLatched(key),
    isTmuxUnresponsive: (key) => h.tmuxUnresponsive.holds(key),
    isRetryArmed: (key) => h.retryArmed.has(key),
    // As main() binds it (b.jg5 SRJ-401): a launch call, or the dialog
    // approver that runs after it returned.
    isLaunchOrApproverRunning: opts.isLaunchOrApproverRunning ?? ((key) => h.isLaunchInFlight(key) || isDialogApproverRunning(key)),
    // A case's own arrangement of each (production leaves the first unbound
    // and binds the second to its kill-failure alerts' episode).
    isHeldOnInvalidFlags: (key) => h.heldOnInvalidFlags.has(key),
    isKillFailed: (key) => h.killFailed.has(key),
    // As main() binds it (b.jg5 SRJ-706, SRJ-1011): the session manager's
    // running query, read at call time, or a case's own arrangement.
    isSequenceOrWaitRunning: (key) => h.sequenceOrWaitRunning.has(key) || isLiveRowSequenceRunning(key),
    // As main() composes "in flight for P": "blocks a retry" (a launch call
    // or a running live-row sequence, plus the non-launch work a case marks),
    // or a running dialog approver (b.jg5 SRJ-401).
    isWorkInFlight: (key) =>
      h.isLaunchInFlight(key) || isLiveRowSequenceRunning(key) || h.workInFlight.has(key) || isDialogApproverRunning(key),
    readRowLiveness,
    ...(opts.armRetryTimer === true
      ? {
        armRetryTimerIfMissing: (key: string) => {
          h.retryTimerArms.push(key)
          h.retryArmed.add(key)
        },
      }
      : {}),
  })

  for (const key of keySet(opts.notUp)) notUp.add(key)
  initRestart(restartDeps)
  return h
}

/**
 * Reset the registry, restart (timers cancelled), backoff, ack-tracker and
 * outage state the harness drives: afterwards no outage flag is raised and no
 * outage state is installed.
 */
export function resetRoutingState(): void {
  _resetRestartState()
  _resetRegistry()
  _resetBackoffState()
  _resetAckTracker()
  _resetOutageState()
}

/** Poll `cond` every 5 ms for at most `ms` (the fast restart timer fires within this). */
export async function waitFor(cond: () => boolean, ms = 100): Promise<void> {
  for (let waited = 0; !cond() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}
