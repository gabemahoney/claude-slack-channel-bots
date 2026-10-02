/**
 * inbound-recovery-drop-branch.test.ts — lost messages (b.av2 SR-4.6, SR-7.3,
 * SR-7.2 part; b.kvq and b.9cj recovery, keyed per persona). The AC 26
 * verifier: run `bun test tests/inbound-recovery-drop-branch.test.ts -t
 * "AC 26"` for its cases; the AC 68 verifier (no human-triggered restart in
 * states 2 to 6, b.jg5 SRJ-1501): `bun test
 * tests/inbound-recovery-drop-branch.test.ts -t "AC 68"`. Name this file:
 * a bare `-t` also matches other files' "AC 26" and "AC 68" cases.
 *
 * A Slack message that qualifies for persona P but finds no live,
 * stream-bearing session (no session, a disconnected one, or one that has lost
 * its GET stream) is lost. The branch in src/persona-routing.ts decides the
 * recovery state (b.jg5 SRJ-1011, SRJ-1509), the first that applies, in the
 * order src/lost-message.ts exports (`LOST_MESSAGE_STATES`): P not up (b.av2
 * SR-6.4, bug b.g57: its own bring-up recovery launches it); P latched
 * (held for a human); P held on `ErrInvalidFlags` (cannot launch); P's kill
 * failed; P not answering (its `tmux-unresponsive` condition holds, or its
 * `tmux-unavailable` or `ad-config-malformed` outage is raised; never an
 * unclassified-error episode alone; only while P's retry timer is armed and
 * P is below the restart cap, b.jg5 SRJ-1011 as amended, so a P at the cap
 * reports restart limit reached whatever is raised); P's row reading `pending` (session
 * starting: a launch or dialog approver for P running, or the one row read
 * the routing makes when none of states 1 to 5 applies and nothing is in
 * flight for P answering `pending`; a live-row sequence or old-life wait
 * step running for P answers restarting first, with no read; a failed read,
 * `unknown` or rejected, is never `pending`; states 1 to 5 are decided again
 * after the read); then P's restart guards (a
 * restart already pending or running, auto-restart disabled, P at the
 * restart-failure cap). It schedules a human-triggered restart of P only
 * when none applies ("starting now"; b.jg5 SRJ-1501, AC 68), and raises one
 * lost-message notice at P's permission-prompt destination (a channel, or
 * the DM with `dm.contact`), through P's own client and under P's identity.
 * The notice names P, the sender and the recovery state, and never carries
 * the message text. Nothing is posted in the conversation the message came
 * from. In src/restart.ts, `scheduleRestart(…, { humanTrigger: true })`
 * clamps the backoff delay DOWN to HUMAN_TRIGGER_DELAY_CEILING (never up).
 *
 * Every case drives the real module (`createPersonaRouting(deps).receive`)
 * through the shared harness (tests/test-helpers/persona-routing-harness.ts):
 * the real registry, restart.ts and backoff.ts state, one `makeStubSlack`
 * client per persona, and the real persona notifier and destination hold (on
 * a fake clock) as the routing's `notify`. So every notice assertion is on a
 * captured Slack call. No pipeline logic or reply text is copied here. The
 * receiving persona (alpha) is the SECOND persona of the config, its
 * destination is never the conversation a message comes from, and every case
 * also checks the first persona (beta): a recovery, notice or post keyed to
 * the wrong persona fails. Notice text is checked by property (persona,
 * "lost", sender, one recovery state, no mention, no message text); the state
 * is told by the harness's `stateOf`, which matches the wordings
 * src/lost-message.ts exports, so no wording is copied here.
 *
 * The state inputs are the harness's real instances, set through their own
 * entries: E13's latch (`set`, `setFromConflict`, and `forget`, its silent
 * drop), E10's `tmux-unresponsive` condition (`start`, `end`), the real
 * outage state (`raiseTmuxUnavailable`, `raiseAdConfigMalformed`,
 * `clearOutageFlag`, recorded apart from the Slack stubs), and the harness's
 * own restart launch held open (a launch running, as production binds
 * `isLaunchInFlight`). The inputs later Epics bind (held on `ErrInvalidFlags`,
 * kill failed, a live-row sequence or old-life wait step) and a running
 * dialog approver are per-key sets. "No restart" is checked as no relaunch-gate
 * ask (`h.restartAsks`) and no restart pending or launch the message started,
 * with the restart module able to launch (fast delay) and not given the
 * latch, so only the routing's own rule keeps it from restarting. The row
 * read is the harness's scripted `readRowLiveness` (`rowRead`, answers from
 * src/liveness-reading.ts or a rejection; its `during` latches P or raises
 * an outage while the read runs), bound only where a case asks for it. The
 * streamless branch's own cases are in tests/dispatch-get-stream.test.ts;
 * general delivery, and where the read is gated in the pipeline, in
 * tests/persona-routing.test.ts.
 *
 * The read's agent-director side runs on the recovery harness
 * (tests/test-helpers/recovery-harness.ts, its lost-message driver bound as
 * main() binds it): the read is the one liveness adapter's `status` of P's
 * own instance, outside any launch or recovery attempt, so its answers'
 * effects (outage raises, retry timer arms, episodes, the condition) are
 * read from the real modules over the stub client and a fake clock; none is
 * made while a spawn is held open, nor while the persona's dialog approver
 * runs after its launch returned (b.jg5 SRJ-401; driven on the harness
 * clock), and one is made once the approver has stopped; and the restart
 * path's own read still keeps a launch off a `pending` row after a failed
 * routing read. State 4 (b.jg5 SRJ-1011, SRJ-704) runs there too, the
 * driver's kill-failed input bound to the harness's kill-failure alerts'
 * episode: a message lost after the ordinary alert (the restart path's one
 * try, or a live-row sequence's tries ending in `ErrTmuxUnresponsive` after a
 * survivor-naming failure) reports `kill-failed`; after the survivor version,
 * or once the episode ended, it never does; a CONFLICT latch gives
 * `held-for-human` first. A message lost while P's live-row sequence runs
 * (b.jg5 SRJ-706, the driver's sequence/wait input and read gate bound to
 * the session manager's running query) reports `restarting` there with no
 * read and no restart, P's row `pending` and the sequence's own step-6
 * launch included; a latch beats it, and once the sequence has ended the
 * one read is made again. State 3 (b.jg5 SRJ-1011, SRJ-207) runs there too,
 * the driver's held-on-invalid-flags input bound to the harness's one
 * `ErrInvalidFlags` hold: a message lost while P is held through a real
 * reuse reports `cannot-launch` with no restart and no call; above an open
 * kill-failure episode it still does; under a latch `held-for-human` comes
 * first; once the binary's version changes and the hold ends it never does.
 *
 * main() in src/server.ts cannot run in a test (startup gate, real port, real
 * Slack connections), so describe (7) audits its source for the wiring only:
 * server.ts hands inbound events to the routing module through the persona
 * event router and holds no copy of the branch.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  runRestartRetry,
  HUMAN_TRIGGER_DELAY_CEILING,
  RESTART_FAILURE_CAP,
} from '../src/restart.ts'
import { recordFailure, isAtCap } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import { STATE_WORDING, type LostMessageState } from '../src/lost-message.ts'
import {
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_READING_DEAD,
  LIVENESS_READING_LIVE,
  LIVENESS_READING_PENDING,
  LIVENESS_READING_UNKNOWN,
} from '../src/liveness-reading.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
} from '../src/unavailable-retry.ts'
import {
  HOLD_LATCH_CASES,
  LATCH_CASE_LEFTOVER,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  LATCH_ROW_STATE_NO_ROW,
} from '../src/conflict-latch.ts'
import { PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR, TMUX_UNRESPONSIVE_END_TICK } from '../src/persona-episodes.ts'
import {
  OUTAGE_CLASS_ORDER,
  clearOutageFlag,
  getOutageFlags,
  raiseAdConfigMalformed,
  raiseTmuxUnavailable,
  setOutageFlag,
  type OutageClass,
} from '../src/outage-state.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
import {
  makeAppMention,
  makeChannelMessage,
  makeDm,
  makeWebhookPost,
  mentionText,
  stubOpenedDmId,
  type SlackEvent,
  type StubSlackOptions,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'
import { CONFLICT_CASE_ROWS, conflictForPersona } from './test-helpers/conflict-cases.ts'
import {
  cannedErr,
  cannedFindMissing,
  cannedGetResult,
  cannedOk,
  cannedStatusResult,
  errConfigMalformed,
  errInternal,
  errSchemaMismatch,
  errSystemInstallDisappeared,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  holdFindMissing,
  holdSpawns,
  SAMPLE_LAUNCH_START_NONE,
  unavailableForms,
  type FindMissingHold,
} from './test-helpers/agent-director-stub.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  putAtRestartCap,
  resetRoutingState,
  stateOf,
  waitFor,
  LOST_MESSAGE_STATES,
  LOST_STATE_SETUPS,
  NEVER_FIRE_RESTART_DELAY_S,
  ROW_READ_REJECTS,
  ROW_READ_REJECTION_REDACTED,
  type RoutingHarness,
  type RoutingHarnessOptions,
  type RowReadAnswer,
} from './test-helpers/persona-routing-harness.ts'
import {
  APPROVER_STOP_CAP,
  APPROVER_STOP_LIVE,
  APPROVER_STOP_TEARDOWN,
  DIALOG_POLL_INTERVAL_MS,
  TRUST_DIALOG_NEEDLE,
  isLaunchInFlight,
  readPersonaRowState,
  stopDialogApprover,
  type ApproverStopReason,
} from '../src/session-manager.ts'
import {
  expectLostMessageReports,
  holdSequenceReuse,
  launchThroughSequence,
  makeRecoveryHarness,
  ownRowsLiveThenMissing,
  pastSampleGrace,
  personaOf,
  retryNow,
  scriptLiveRowElsewhere,
  rowReadsUntilSpawn,
  startSequenceHeldAtRun,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryRowState,
} from './test-helpers/recovery-harness.ts'
import { collided, personaCallCounts, personaRow, unavailableAt } from './test-helpers/recovery-harness.ts'
import { errInvalidFlags, provenanceNote } from './test-helpers/agent-director-stub.ts'
import { launchForLiveRowSequence, readPersonaOwnRow } from '../src/session-manager.ts'
import { LIVE_ROW_LAUNCH_REUSE } from '../src/live-row-sequence.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01 // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = NEVER_FIRE_RESTART_DELAY_S // never fires during a test
const WAIT_MS = 50

/**
 * Alpha's channels (all `all`): its home (its channel destination), a second
 * channel, and a coordination channel it shares with beta (`mentions` there).
 * Beta's own `mentions` channel (its destination), and a channel nobody lists.
 */
const ALPHA_HOME = 'C0ALPHA01'
const ALPHA_SECOND = 'C0ALPHA02'
const SHARED = 'C0SHARED1'
const BETA_MENTIONS = 'C0BETA001'
const UNCLAIMED = 'C0NOBODY1'

/** Alpha's `dm.contact`, and a DM with alpha from another user (a source conversation). */
const CONTACT = 'U0CONTACT1'
const SOURCE_DM = 'D0SRCDM001'
const DM_SENDER = 'U0DMSENDR1'

/** The event factories' default human author. */
const HUMAN = 'U0STUBUSR1'
/** The name the stub's `users.info` gives every user. */
const STUB_USER_NAME = 'stub-user'

/** In every lost message's text; must never reach a Slack call. */
const MESSAGE_MARKER = 'lost-body-marker-7Kq2'


// ---------------------------------------------------------------------------
// Harness: the shared routing harness over beta (first) and alpha (second,
// the receiving persona), with no session registered unless asked
// ---------------------------------------------------------------------------

/** Alpha's permission-prompt destination: its home channel, or `dm` with its contact. */
type Destination = 'channel' | 'dm'

/** The drop branch: no session at all, or a connected session without its GET stream. */
type Branch = 'no session' | 'streamless'

type Harness = RoutingHarness & {
  /** The receiving persona in every lost-message case: personas[1]. */
  alpha: Persona
  /** The other persona: personas[0]. */
  beta: Persona
  /** Deliver `event` to the receiving persona key(s), as the socket handler does. */
  deliver(event: unknown, keys: string | readonly string[]): Promise<void>
  /** Keys whose dialog approver is running (with `approver`): read with the harness's launches in flight as state 6's input. */
  approverRunning: Set<string>
}

interface HarnessOptions {
  destination?: Destination
  branch?: Branch
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
  /** Hold every restart launch open until teardown (the harness's `holdLaunches`), keeping the persona in flight. */
  holdLaunches?: boolean
  alphaStub?: StubSlackOptions
  resolveUserName?: RoutingHarnessOptions['resolveUserName']
  notify?: RoutingHarnessOptions['notify']
  /**
   * Give the routing the harness's up check (the real up predicate, not up
   * for the keys in `h.notUp`, asks recorded in `h.upAsks`). Without it (and
   * without `notUp`) the routing has no up check.
   */
  upCheck?: boolean
  /**
   * Names whose bring-up outcome is not `up` although their connection still
   * delivers a message (a persona that stopped being up while the message
   * was in flight, or the old half of a destructive modify); implies `upCheck`.
   */
  notUp?: readonly string[]
  /** Install the real outage state with a recording sink (the harness's `outageState`). */
  outageState?: boolean
  /**
   * State 6's input is a launch of the harness in flight OR a key in
   * `h.approverRunning` (a dialog approver running). Without it the harness's
   * default (its launches in flight) is bound.
   */
  approver?: boolean
  /**
   * Bind the routing's one lost-message row read, scripted per persona name
   * (the harness's `rowRead`). Without it no read is bound and none is made.
   */
  rowRead?: RoutingHarnessOptions['rowRead']
  /** Bind the routing's missing-retry-timer arm (the harness's `armRetryTimer`: each ask recorded, P's timer armed). */
  armRetryTimer?: boolean
  /** Names whose retry timer is armed first (the harness's `retryArmed`); default every persona. */
  retryArmed?: readonly string[]
}

/** A connection that serves, so only the bring-up outcome decides whether a persona is up. */
const SERVING: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0SERVING', botId: 'B0SERVING' } }

let dir: string
/** Every harness a case built (cleaned up and leak-checked in teardown). */
let harnesses: RoutingHarness[] = []
/** Server-log lines the modules wrote (restart.ts, the outage state), captured and leak-checked in teardown. */
let consoleLines: string[] = []
let consoleSpy: ReturnType<typeof spyOn> | undefined
/** Every recovery harness a case built (leak-checked, then cleaned up, in teardown). */
let recoveries: RecoveryHarness[] = []

/** A recovery harness (tests/test-helpers/recovery-harness.ts), cleaned up in teardown. */
function makeRecovery(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const h = makeRecoveryHarness(options)
  recoveries.push(h)
  return h
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const streamless = opts.branch === 'streamless'
  const approverRunning = new Set<string>()
  const h = makeRoutingHarness(
    [
      { name: 'beta', channels: [{ id: BETA_MENTIONS, delivery: 'mentions' }, { id: SHARED, delivery: 'mentions' }] },
      {
        name: 'alpha',
        channels: [
          { id: ALPHA_HOME, delivery: 'all' },
          { id: ALPHA_SECOND, delivery: 'all' },
          { id: SHARED, delivery: 'all' },
        ],
        // DMs on (so a DM to alpha qualifies) whatever the destination is.
        dm: { enabled: true, contact: CONTACT },
        permission_prompts: (opts.destination ?? 'channel') === 'dm' ? 'dm' : ALPHA_HOME,
      },
    ],
    dir,
    {
      sessions: streamless ? ['alpha'] : [],
      streamless: streamless ? ['alpha'] : undefined,
      overrides: { session_restart_delay: opts.sessionRestartDelay ?? 60 },
      restartDelayS: opts.restartDelayS ?? FAST_DELAY_S,
      launchSession: opts.launchSession,
      holdLaunches: opts.holdLaunches,
      stubOptions: opts.alphaStub ? { alpha: opts.alphaStub } : undefined,
      resolveUserName: opts.resolveUserName,
      notify: opts.notify,
      upCheck: opts.upCheck,
      notUp: opts.notUp,
      outageState: opts.outageState,
      isLaunchOrApproverRunning: opts.approver === true
        ? (key) => h.isLaunchInFlight(key) || approverRunning.has(key)
        : undefined,
      rowRead: opts.rowRead,
      armRetryTimer: opts.armRetryTimer,
      retryArmed: opts.retryArmed,
    },
  )
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  const harness = Object.assign(h, {
    alpha,
    beta,
    deliver: (event: unknown, keys: string | readonly string[]) =>
      h.receiveKeys(event, typeof keys === 'string' ? [keys] : keys),
    approverRunning,
  })
  harnesses.push(harness)
  return harness
}

/** The conversation alpha's notices go to for `destination`. */
function destinationId(destination: Destination): string {
  return destination === 'dm' ? stubOpenedDmId(CONTACT) : ALPHA_HOME
}

/** Where alpha's session (if any) runs: the restart of a streamless session uses its cwd. */
function expectedLaunchCwd(h: Harness, branch: Branch): string {
  return branch === 'streamless' ? h.p('alpha').sessionCwd! : h.alpha.working_directory
}

/** A human's message in `channel`, carrying the message marker. */
function messageIn(channel: string, text = `hello, anyone there? ${MESSAGE_MARKER}`): SlackEvent {
  return makeChannelMessage({ channel, text })
}

/** A DM to alpha in `channel` from `user`, carrying the message marker. */
function dmFrom(user: string, channel: string): SlackEvent {
  return makeDm({ channel, user, text: `a direct question ${MESSAGE_MARKER}` })
}

/** Every captured post as (persona whose stub posted, conversation, recovery state). */
function lostNotices(h: Harness): { key: string; channel: string; state: string }[] {
  return h.allPosts().map((p) => ({ key: p.key, channel: p.channel, state: stateOf(p.text) }))
}

/** The first persona (beta) got no restart and made no Slack call of any kind. */
function expectBetaUntouched(h: Harness): void {
  expect(isRestartPendingOrActive(h.beta.key)).toBe(false)
  expect(h.p('beta').stub.callLog).toEqual([])
}

/**
 * The properties every lost-message notice has: it names alpha (b.av2
 * SR-7.2), says a message was lost, names `sender` with no mention, identifies
 * `state` and no other, and no Slack call anywhere carries the message text.
 */
function expectNoticeText(h: Harness, text: string | undefined, sender: string, state: LostMessageState): void {
  expect(text).toContain(renderPersonaRef(h.alpha.name, h.alpha.key))
  expect(text).toMatch(/\blost\b/i)
  expect(text).toContain(sender)
  expect(text).not.toContain('<@')
  expect(stateOf(text)).toBe(state)
  expect(JSON.stringify(h.all.map((x) => x.stub.callLog))).not.toContain(MESSAGE_MARKER)
}

/**
 * AC 26: the lost message made exactly one Slack post, alpha's notice, at its
 * destination (for `dm`, the conversation `conversations.open` returned for
 * the contact), through alpha's own client with no username or icon override,
 * and nothing in `source`. Beta made no Slack call.
 */
function expectOneLostNotice(
  h: Harness,
  want: { destination: Destination; source: string; sender: string; state: LostMessageState },
): void {
  const posts = h.allPosts()
  expect(posts.map((p) => ({ key: p.key, channel: p.channel }))).toEqual([
    { key: h.alpha.key, channel: destinationId(want.destination) },
  ])
  expect(h.postsTo(want.source)).toEqual([])
  const stub = h.p('alpha').stub
  for (const args of stub.calls.postMessage) {
    expect(Object.keys(args ?? {}).filter((k) => /^(username|icon_emoji|icon_url)$/.test(k))).toEqual([])
  }
  expect(stub.calls.conversationsOpen).toEqual(want.destination === 'dm' ? [{ users: CONTACT }] : [])
  expectBetaUntouched(h)
  expectNoticeText(h, posts[0]!.text, want.sender, want.state)
}

/** `persona-destination-failed` start lines, and its `cleared:` lines. */
const failedLines = (h: Harness) => h.logs.filter((l) => l.includes('persona-destination-failed:') && !l.includes('cleared:'))
const clearedLines = (h: Harness) => h.logs.filter((l) => l.includes('persona-destination-failed:') && l.includes('cleared:'))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lost-message-drop-branch-'))
  harnesses = []
  recoveries = []
  consoleLines = []
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
  resetRoutingState()
})

afterEach(async () => {
  try {
    // A recovery harness is leak-checked, then cleaned up (it puts back the
    // console.error it replaced, and throws when a fake-clock timer is left).
    for (const r of recoveries.splice(0)) {
      try {
        assertNoLeak(r.captured())
      } finally {
        r.cleanup()
      }
    }
    for (const h of harnesses) h.hold.cancelAll()
    // Let a held launch settle while restart.ts still has its deps.
    let released = 0
    for (const h of harnesses) released += h.releaseLaunches()
    if (released > 0) await Bun.sleep(1)
    // Every log line, post and notice the module produced is free of token material.
    assertNoLeak([...harnesses.map((h) => h.captured()), consoleLines])
  } finally {
    consoleSpy?.mockRestore()
    consoleSpy = undefined
    resetRoutingState()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// AC 26 — a lost message produces exactly one post: the notice, at the
// persona's destination, naming the sender. Both drop branches × a channel or
// DM source × a channel or `dm` destination. A channel source is the shared
// coordination channel, never the destination; a DM source is a DM from a
// user other than the contact, so it is never the destination DM either.
// ===========================================================================

describe('AC 26: a lost message is reported once, at the persona\'s destination, never in the source conversation', () => {
  const matrix: [Branch, 'channel' | 'DM', Destination][] = []
  for (const branch of ['no session', 'streamless'] as const) {
    for (const source of ['channel', 'DM'] as const) {
      for (const destination of ['channel', 'dm'] as const) matrix.push([branch, source, destination])
    }
  }

  test.each(matrix)(
    'AC 26: %s, a %s source, a %s destination: one notice through alpha\'s client at the destination, nothing in the source, recovery in the right cwd',
    async (branch, source, destination) => {
      const h = makeHarness({ branch, destination })
      const [event, sourceId] = source === 'channel'
        ? [messageIn(SHARED), SHARED]
        : [dmFrom(DM_SENDER, SOURCE_DM), SOURCE_DM]

      await h.deliver(event, h.alpha.key)

      expectOneLostNotice(h, { destination, source: sourceId, sender: STUB_USER_NAME, state: 'starting-now' })
      // The sender's name came from users.info on alpha's own stub.
      expect(h.p('alpha').stub.calls.usersInfo.map((c) => c?.user)).toEqual([source === 'channel' ? HUMAN : DM_SENDER])
      // A lost message is never handed to a session.
      expect(h.p('alpha').notifications).toEqual([])
      await waitFor(() => h.launches.length > 0)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: expectedLaunchCwd(h, branch) }])
    },
  )

  test('AC 26: the contact DMs a persona whose destination is `dm`: that one conversation gets exactly one post, the notice', async () => {
    const h = makeHarness({ destination: 'dm' })
    const conversation = stubOpenedDmId(CONTACT)

    await h.deliver(dmFrom(CONTACT, conversation), h.alpha.key)

    expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: conversation, state: 'starting-now' }])
    expectNoticeText(h, h.allPosts()[0]!.text, STUB_USER_NAME, 'starting-now')
    expectBetaUntouched(h)
  })

  test('AC 26: one message lost on both personas\' connections: each persona posts its own notice through its own client at its own destination, nothing in the shared channel', async () => {
    const h = makeHarness()
    // Beta is `mentions` in the shared channel, so it gets the message by mention.
    const event = messageIn(SHARED, `${mentionText(h.p('beta').stub.identity.botUserId)} ${MESSAGE_MARKER}`)

    await h.deliver(event, [h.beta.key, h.alpha.key])

    expect(lostNotices(h)).toEqual([
      { key: h.beta.key, channel: BETA_MENTIONS, state: 'starting-now' },
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' },
    ])
    expect(h.postsTo(SHARED)).toEqual([])
    const [betaPost, alphaPost] = h.allPosts()
    expect(betaPost!.text).toContain(renderPersonaRef(h.beta.name, h.beta.key))
    expect(betaPost!.text).not.toContain(renderPersonaRef(h.alpha.name, h.alpha.key))
    expect(alphaPost!.text).not.toContain(renderPersonaRef(h.beta.name, h.beta.key))
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(isRestartPendingOrActive(h.beta.key)).toBe(true)
  })
})

// ===========================================================================
// The state inputs (b.jg5 SRJ-1011), each set for one persona key through its
// real entry and cleared through its real end, clear or forget. Every input
// is keyed: setting it for beta never changes alpha's state.
// ===========================================================================

interface StateInput {
  /** Harness options the input needs. */
  opts?: HarnessOptions
  /** Put persona `key` under the input. */
  set(h: Harness, key: string): void
  /** Take persona `key` out of it again (absent where no case needs it). */
  clear?(h: Harness, key: string): void
}

/** Persona `key`'s working directory. */
function cwdOf(h: Harness, key: string): string {
  return h.config!.personas.find((p) => p.key === key)!.working_directory
}

const INPUTS = {
  'not up': {
    opts: { upCheck: true },
    set: (h, key) => { h.notUp.add(key) },
    clear: (h, key) => { h.notUp.delete(key) },
  },
  // E13's set entry with a real CONFLICT error; `forget` is its silent drop.
  'latched on a CONFLICT': {
    set: (h, key) => {
      expect(h.latch.setFromConflict(key, conflictForPersona(key), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW })).toBeDefined()
      expect(h.latch.isLatched(key)).toBe(true)
    },
    clear: (h, key) => { expect(h.latch.forget(key)).toBe(true) },
  },
  // E23's set, as a reuse spawn's ErrInvalidFlags sets it; `forget` is its silent end.
  'held on ErrInvalidFlags': {
    set: (h, key) => {
      expect(h.invalidFlagsHold.set(key)).toBe(true)
      expect(h.invalidFlagsHold.isHeld(key)).toBe(true)
    },
    clear: (h, key) => { expect(h.invalidFlagsHold.forget(key)).toBe(true) },
  },
  'kill failed': {
    set: (h, key) => { h.killFailed.add(key) },
    clear: (h, key) => { h.killFailed.delete(key) },
  },
  // E10's entry: a refusal from a tmux-touching verb starts the condition; a
  // health tick that reads the row live ends it.
  'tmux-unresponsive holds': {
    set: (h, key) => {
      expect(h.tmuxUnresponsive.start(key, 'resume', errTmuxUnresponsive('resume'))).toBe('started')
    },
    clear: (h, key) => { expect(h.tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_TICK)).not.toBe('not-holding') },
  },
  // E11's one raise entry and the real clear.
  'tmux-unavailable raised': {
    opts: { outageState: true },
    set: (_h, key) => {
      raiseTmuxUnavailable(key, errTmuxNotAvailable())
      expect(getOutageFlags(key).has('tmux-unavailable')).toBe(true)
    },
    clear: (_h, key) => {
      clearOutageFlag(key, 'tmux-unavailable')
      expect(getOutageFlags(key).size).toBe(0)
    },
  },
  // E12's one raise entry and the real clear.
  'ad-config-malformed raised': {
    opts: { outageState: true },
    set: (_h, key) => {
      raiseAdConfigMalformed(key, errConfigMalformed())
      expect(getOutageFlags(key).has('ad-config-malformed')).toBe(true)
    },
    clear: (_h, key) => {
      clearOutageFlag(key, 'ad-config-malformed')
      expect(getOutageFlags(key).size).toBe(0)
    },
  },
  'a dialog approver running': {
    opts: { approver: true },
    set: (h, key) => { h.approverRunning.add(key) },
    clear: (h, key) => { h.approverRunning.delete(key) },
  },
  'a live-row sequence running': {
    set: (h, key) => { h.sequenceOrWaitRunning.add(key) },
    clear: (h, key) => { h.sequenceOrWaitRunning.delete(key) },
  },
  // A restart whose timer has not fired: armed at a delay that never fires,
  // then the restart module is able to launch again (fast delay).
  'a pending restart': {
    set: (h, key) => {
      const delay = h.restartDelayS
      h.restartDelayS = SLOW_DELAY_S
      scheduleRestart(key, cwdOf(h, key), undefined, { humanTrigger: true })
      h.restartDelayS = delay
      expect(isRestartPendingOrActive(key)).toBe(true)
    },
  },
  'auto-restart disabled': {
    opts: { sessionRestartDelay: 0 },
    set: () => {},
  },
} satisfies Record<string, StateInput>

type InputName = keyof typeof INPUTS

/** State 5's three sources (b.jg5 SRJ-1011). */
const STATE_5_SOURCES = ['tmux-unresponsive holds', 'tmux-unavailable raised', 'ad-config-malformed raised'] as const satisfies readonly InputName[]

/** The harness options of every named input together. */
function inputOpts(...names: InputName[]): HarnessOptions {
  return Object.assign({}, ...names.map((n) => (INPUTS[n] as StateInput).opts ?? {}))
}

// ===========================================================================
// AC 26 x SR-7.3 x b.jg5 SRJ-1011 — the recovery state. Every state
// (`LOST_MESSAGE_STATES`) × a channel or `dm` destination, on the no-session
// branch. Each notice identifies its state and no other (so the ten texts are
// pairwise distinct); only "starting now" asks for, schedules or launches a
// restart (b.jg5 SRJ-1501, AC 68), while restart.ts itself could launch (fast
// delay). The rows from `held-for-human` to `restart-limit-reached` run with
// no up check, so a routing without `isPersonaUp` counts every persona as up.
// ===========================================================================

/**
 * Arrange alpha in `state` for the next lost message on the no-session
 * branch, as the shared table (`LOST_STATE_SETUPS`) arranges it, its launches
 * in its working directory.
 */
function arrangeState(h: Harness, state: LostMessageState): Promise<void> | void {
  return LOST_STATE_SETUPS[state].arrange(h, h.alpha.key, h.alpha.working_directory)
}

describe('AC 26: the notice reports the recovery state', () => {
  const table: [LostMessageState, Destination][] = LOST_MESSAGE_STATES.flatMap((s) => (['channel', 'dm'] as const).map((d): [LostMessageState, Destination] => [s, d]))

  test.each(table)(
    'AC 26, AC 68: state %s, a %s destination: one notice at the destination naming the sender and that state\'s wording only, nothing in the source; a restart is asked for only when starting now',
    async (state, destination) => {
      const setup = LOST_STATE_SETUPS[state]
      const h = makeHarness({ destination, ...setup.opts })
      await arrangeState(h, state)
      const asksBefore = h.restartAsks.length

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination, source: SHARED, sender: STUB_USER_NAME, state })
      // Only "starting now" asks the relaunch gate (it schedules the restart).
      expect(h.restartAsks.slice(asksBefore)).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(setup.pending)
      await Bun.sleep(WAIT_MS) // a launch the message scheduled would have fired by now
      expect(h.launches).toHaveLength(setup.launches)
      for (const launch of h.launches) expect(launch).toEqual({ key: h.alpha.key, cwd: h.alpha.working_directory })
    },
  )
})

// ===========================================================================
// b.jg5 SRJ-1011 state 5 (hatch notes E11, E12) — a message lost while P is
// not answering, from each of its three sources: its `tmux-unresponsive`
// condition holding (E10), its `tmux-unavailable` outage raised (SRJ-311) or
// its `ad-config-malformed` outage raised (SRJ-316). No restart is asked for,
// scheduled or launched, and the source's own notice (the outage onset) goes
// to the outage state's sink, not to Slack. After the source's real end or
// clear, the next lost message starts a restart. An open unclassified-error
// episode, or another outage class, is not a source.
// ===========================================================================

describe('b.jg5 SRJ-1011 state 5: a message lost while the persona is not answering starts no restart', () => {
  const SOURCES: [typeof STATE_5_SOURCES[number]][] = STATE_5_SOURCES.map((source) => [source])

  test.each(SOURCES)(
    'AC 68: %s: the notice says not answering and no restart is asked for or launched; after its real end the next lost message starts now with one launch',
    async (source) => {
      const h = makeHarness(inputOpts(source))
      INPUTS[source].set(h, h.alpha.key)
      const asksBefore = h.restartAsks.length

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'not-answering' })
      expect(h.restartAsks.slice(asksBefore)).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([])

      INPUTS[source].clear(h, h.alpha.key)
      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(lostNotices(h)).toEqual([
        { key: h.alpha.key, channel: ALPHA_HOME, state: 'not-answering' },
        { key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' },
      ])
      expect(h.postsTo(SHARED)).toEqual([])
      await waitFor(() => h.launches.length > 0)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
      expectBetaUntouched(h)
    },
  )

  test.each<[string, LostMessageState, InputName | undefined, number]>([
    ['alone', 'starting-now', undefined, 1],
    ['with a dialog approver running', 'session-starting', 'a dialog approver running', 0],
    ['with auto-restart disabled', 'auto-restart-disabled', 'auto-restart disabled', 0],
  ])(
    'hatch A2: an open unclassified-error episode %s never reports not answering; the message reports %s',
    async (_label, state, other, launches) => {
      const h = makeHarness(other === undefined ? {} : inputOpts(other))
      expect(h.episodes.begin(h.alpha.key, PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR)).toBe('begun')
      if (other !== undefined) INPUTS[other].set(h, h.alpha.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(h.episodes.isOpen(h.alpha.key, PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR)).toBe(true)
      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toHaveLength(launches)
    },
  )

  test.each(OUTAGE_CLASS_ORDER.filter((cls) => cls !== 'tmux-unavailable' && cls !== 'ad-config-malformed'))(
    'the %s outage raised for the persona is not a not-answering source: the message starts now',
    async (cls) => {
      const h = makeHarness({ outageState: true })
      setOutageFlag(h.alpha.key, cls, 'detail')
      expect(getOutageFlags(h.alpha.key).has(cls)).toBe(true)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
      // The outage's onset went to the outage state's sink, never to Slack.
      expect(h.outageNotices.map((n) => n.key)).toEqual([h.alpha.key])
    },
  )
})

// ===========================================================================
// b.jg5 SRJ-1011 as amended (orchestrator ruling): "A persona whose retry
// timer is stopped at the restart cap reports restart-limit-reached, never
// state 5's 'CSCB is retrying', whatever condition or flag is raised. In
// SRJ-1011's order, state 5 applies only while P's retry timer is armed."
// Through the real routing, with the restart delay above 0 (so auto-restart
// disabled does not come first) and the row read bound (answering live, a
// restart's input): alpha at the restart cap (SRJ-305, the real backoff
// state) with each state-5 source, its retry timer still armed (the window
// the cap closes: that timer stops at its next retry) or none, reports
// restart limit reached; no restart is asked for, scheduled or launched,
// and the missing-retry-timer arm is never asked. Below the cap, state 5
// needs the timer: armed, not answering; `tmux-unavailable` raised with
// none armed, the arm is asked before the decision and its timer makes the
// message not answering, with no read; the condition or `ad-config-malformed`
// alone with none armed is not state 5, so the message falls through to the
// next state that applies (here starting now, with its read and restart).
// ===========================================================================

describe('b.jg5 SRJ-1011 as amended: state 5 applies only while the retry timer is armed, and never at the restart cap', () => {
  /** Alpha under `source`, its retry timer armed first or not, the arm member bound and the row read answering live. */
  function gateHarness(source: typeof STATE_5_SOURCES[number], armed: boolean): Harness {
    const h = makeHarness({
      ...inputOpts(source),
      armRetryTimer: true,
      retryArmed: armed ? ['alpha'] : [],
      rowRead: { alpha: LIVENESS_READING_LIVE },
    })
    INPUTS[source].set(h, h.alpha.key)
    return h
  }

  const CAPPED = STATE_5_SOURCES.flatMap((source) => ([true, false] as const).map(
    (armed): [typeof STATE_5_SOURCES[number], string, boolean] => [source, armed ? 'still armed' : 'none armed', armed],
  ))

  test.each(CAPPED)(
    'AC 68: alpha at the restart cap with %s, its retry timer %s: the notice says restart limit reached, never not answering; no restart is asked for, scheduled or launched, and no retry timer is asked for or armed',
    async (source, _timer, armed) => {
      const h = gateHarness(source, armed)
      putAtRestartCap(h.alpha.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'restart-limit-reached' })
      // States 1 to 5 did not apply, so the one read was made.
      expect(h.rowReads).toEqual([h.alpha.key])
      expect(h.retryTimerArms).toEqual([])
      expect(h.retryArmed.has(h.alpha.key)).toBe(armed)
      expect(h.restartAsks).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
      expect(h.launches).toEqual([])
      expectNoFakeTimerLeft(h)
    },
  )

  test.each<[typeof STATE_5_SOURCES[number], string, LostMessageState, boolean, readonly string[]]>([
    ['tmux-unresponsive holds', 'armed', 'not-answering', true, []],
    ['tmux-unavailable raised', 'armed', 'not-answering', true, ['alpha']],
    ['ad-config-malformed raised', 'armed', 'not-answering', true, []],
    ['tmux-unavailable raised', 'none armed (the arm, asked before the decision, arms it)', 'not-answering', false, ['alpha']],
    ['tmux-unresponsive holds', 'none armed', 'starting-now', false, []],
    ['ad-config-malformed raised', 'none armed', 'starting-now', false, []],
  ])(
    'below the cap, %s, the retry timer %s: the notice says %s; only starting now asks for a restart',
    async (source, _timer, state, armed, armAsks) => {
      const h = gateHarness(source, armed)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
      expect(h.retryTimerArms).toEqual(h.keys(armAsks))
      expect(h.retryArmed.has(h.alpha.key)).toBe(state === 'not-answering')
      // Not answering is decided at the read gate's check, with no read; a
      // fall-through makes the one read (live) and then starts now.
      expect(h.rowReads).toEqual(state === 'not-answering' ? [] : [h.alpha.key])
      expect(h.restartAsks).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(state === 'starting-now')
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual(state === 'starting-now' ? [{ key: h.alpha.key, cwd: h.alpha.working_directory }] : [])
    },
  )
})

// ===========================================================================
// b.jg5 SRJ-1011 state 2 (hatch note E13; SRJ-502) — a message lost while P
// is latched reads E13's latch instance: a CONFLICT and E13's two declared
// hold cases each give `held-for-human`, and no restart. After the latch's
// silent forget, the next lost message starts a restart.
// ===========================================================================

describe('b.jg5 SRJ-1011 state 2: a message lost while the persona is latched starts no restart', () => {
  const conflictRow = CONFLICT_CASE_ROWS.find((row) => row.latchCase === LATCH_CASE_LEFTOVER)!
  const LATCHES: [string, (h: Harness) => void][] = [
    [
      `a CONFLICT (${conflictRow.name})`,
      (h) => { h.latch.setFromConflict(h.alpha.key, conflictRow.build(), { refusedOperation: conflictRow.refusedOperation, rowState: conflictRow.rowState }) },
    ],
    ...HOLD_LATCH_CASES.map((latchCase): [string, (h: Harness) => void] => [
      `the hold case ${latchCase}`,
      (h) => { h.latch.set(h.alpha.key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE }) },
    ]),
  ]

  test.each(LATCHES)(
    'AC 68, SRJ-502: latched on %s: the notice says held for a human, no restart is asked for or launched and the latch posts nothing; after the latch is forgotten the next lost message starts now',
    async (_label, latch) => {
      const h = makeHarness()
      latch(h)
      expect(h.latch.isLatched(h.alpha.key)).toBe(true)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'held-for-human' })
      expect(h.restartAsks).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([])

      expect(h.latch.forget(h.alpha.key)).toBe(true)
      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(lostNotices(h).map((n) => n.state)).toEqual(['held-for-human', 'starting-now'])
      await waitFor(() => h.launches.length > 0)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
      expectBetaUntouched(h)
    },
  )

  test('one message lost on both connections, alpha latched and beta not: beta reports starting now and is restarted, alpha reports held for a human and is not, each at its own destination', async () => {
    const h = makeHarness()
    INPUTS['latched on a CONFLICT'].set(h, h.alpha.key)
    // Beta is `mentions` in the shared channel, so it gets the message by mention.
    const event = messageIn(SHARED, `${mentionText(h.p('beta').stub.identity.botUserId)} ${MESSAGE_MARKER}`)

    await h.deliver(event, [h.beta.key, h.alpha.key])

    expect(lostNotices(h)).toEqual([
      { key: h.beta.key, channel: BETA_MENTIONS, state: 'starting-now' },
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'held-for-human' },
    ])
    expect(h.postsTo(SHARED)).toEqual([])
    expect(h.restartAsks).toEqual([h.beta.key])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(true)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.beta.key, cwd: h.beta.working_directory }])
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 order, through the real routing, as adjacent pairs: with
// both inputs set, the earlier state is reported; with the earlier input
// cleared, the later one. The live-row sequence or old-life wait input
// answers `restarting` before a launch running (Task ruling; SRJ-706). No
// message asks for, schedules or launches a restart.
// ===========================================================================

describe('b.jg5 SRJ-1011: the first state that applies is reported', () => {
  test.each<[InputName, InputName, LostMessageState, LostMessageState]>([
    ['not up', 'latched on a CONFLICT', 'not-up', 'held-for-human'],
    ['latched on a CONFLICT', 'held on ErrInvalidFlags', 'held-for-human', 'cannot-launch'],
    ['held on ErrInvalidFlags', 'kill failed', 'cannot-launch', 'kill-failed'],
    ['kill failed', 'tmux-unresponsive holds', 'kill-failed', 'not-answering'],
    ['tmux-unresponsive holds', 'a dialog approver running', 'not-answering', 'session-starting'],
    ['a live-row sequence running', 'a dialog approver running', 'restarting', 'session-starting'],
    ['a dialog approver running', 'a pending restart', 'session-starting', 'restarting'],
    ['tmux-unresponsive holds', 'auto-restart disabled', 'not-answering', 'auto-restart-disabled'],
  ])('%s over %s: %s, then, once the first is cleared, %s', async (first, second, firstState, secondState) => {
    const h = makeHarness(inputOpts(first, second))
    INPUTS[second].set(h, h.alpha.key)
    INPUTS[first].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length
    const pendingBefore = isRestartPendingOrActive(h.alpha.key)

    await h.deliver(messageIn(SHARED), h.alpha.key)
    ;(INPUTS[first] as StateInput).clear!(h, h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(lostNotices(h)).toEqual([
      { key: h.alpha.key, channel: ALPHA_HOME, state: firstState },
      { key: h.alpha.key, channel: ALPHA_HOME, state: secondState },
    ])
    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(pendingBefore)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
    expectBetaUntouched(h)
  })

  // Every keyed input (auto-restart disabled is server-wide).
  const KEYED = (Object.keys(INPUTS) as InputName[]).filter((n) => n !== 'auto-restart disabled')

  test.each(KEYED.map((n): [InputName] => [n]))(
    'another persona\'s input is not the persona\'s: with beta under "%s", alpha\'s lost message starts now and alpha is restarted',
    async (input) => {
      const h = makeHarness(inputOpts(input))
      INPUTS[input].set(h, h.beta.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' }])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      await waitFor(() => h.launches.some((l) => l.key === h.alpha.key))
      expect(h.launches.filter((l) => l.key === h.alpha.key)).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
    },
  )
})

// ===========================================================================
// b.jg5 SRJ-1011 state 6 by the read (E15 T2) — with states 1 to 5 clear and
// nothing in flight for P, the routing makes one row read of P (the
// harness's scripted `readRowLiveness`). A `pending` answer is state 6, which
// comes before every restart guard: no restart is asked for, scheduled or
// launched (SRJ-1501; AC 68, state 6 from the read). A `live` reading or no
// row (`dead`) is not `pending`: the state is the next that applies, here
// starting now, AC 68's control. A launch running is state 6 with no read
// (the AC 68 describe); a dialog approver running, likewise (the order pairs
// above, and the read gate in tests/persona-routing.test.ts).
// ===========================================================================

/** No fake-clock timer is left: the destination hold's and the episodes'. */
function expectNoFakeTimerLeft(h: Harness): void {
  expect(h.holdClock.pendingCount()).toBe(0)
  expect(h.episodesClock.pendingCount()).toBe(0)
}

/** States 2 to 6 of b.jg5 SRJ-1011, where no human-triggered restart fires (SRJ-1501). */
const NO_RESTART_STATES = LOST_MESSAGE_STATES.slice(
  LOST_MESSAGE_STATES.indexOf('held-for-human'),
  LOST_MESSAGE_STATES.indexOf('session-starting') + 1,
)

describe('b.jg5 SRJ-1011 state 6 by the read: a row reading `pending` reports session starting and starts no restart', () => {
  test.each<[string, InputName | undefined, boolean]>([
    ['nothing else applies', undefined, false],
    ['a restart timer is pending (state 6 comes before restarting)', 'a pending restart', true],
    ['auto-restart is disabled (state 6 comes before auto-restart disabled)', 'auto-restart disabled', false],
  ])('AC 68: %s: one read of alpha, then the session-starting notice; no restart is asked for, scheduled or launched', async (_label, input, pending) => {
    const h = makeHarness({ ...(input === undefined ? {} : inputOpts(input)), rowRead: { alpha: LIVENESS_READING_PENDING } })
    if (input !== undefined) INPUTS[input].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'session-starting' })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`, `notice:${h.alpha.key}`])
    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(pending)
    await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
    expect(h.launches).toEqual([])
    expectNoFakeTimerLeft(h)
  })

  test.each<[string, RowReadAnswer]>([
    ['a live reading', LIVENESS_READING_LIVE],
    ['no row (the dead reading)', LIVENESS_READING_DEAD],
  ])('AC 68 control: %s is not `pending`: one read, then starting now, which asks the relaunch gate once and launches once', async (_label, answer) => {
    const h = makeHarness({ rowRead: { alpha: answer } })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`, `notice:${h.alpha.key}`])
    expect(h.restartAsks).toEqual([h.alpha.key])
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 — a failed read (an `unknown` reading, or a read that
// rejects) is never taken for `pending`: state 6 is left out and the state
// is the next that applies. A rejection is caught and logged once, naming the
// persona, its message redacted (the teardown leak check covers the rest).
// ===========================================================================

describe('b.jg5 SRJ-1011: a failed row read leaves state 6 out', () => {
  const FAILED: [string, RowReadAnswer][] = [
    ['an unknown reading', LIVENESS_READING_UNKNOWN],
    ['a read that rejects', ROW_READ_REJECTS],
  ]
  const NEXT: [string, InputName | undefined, LostMessageState][] = [
    ['nothing else', undefined, 'starting-now'],
    ['a restart timer pending', 'a pending restart', 'restarting'],
    ['auto-restart disabled (delay 0)', 'auto-restart disabled', 'auto-restart-disabled'],
  ]
  const table = FAILED.flatMap(([label, answer]) =>
    NEXT.map(([nextLabel, input, state]): [string, string, LostMessageState, RowReadAnswer, InputName | undefined] => [label, nextLabel, state, answer, input]),
  )

  test.each(table)('%s, with %s: the notice reports %s; only starting now asks for a restart, which launches once', async (_label, _nextLabel, state, answer, input) => {
    const h = makeHarness({ ...(input === undefined ? {} : inputOpts(input)), rowRead: { alpha: answer } })
    if (input !== undefined) INPUTS[input].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
    expect(h.rowReads).toEqual([h.alpha.key])
    expect(h.restartAsks.slice(asksBefore)).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(state !== 'auto-restart-disabled')
    const failedLines = h.logs.filter((l) => l.includes(ROW_READ_REJECTION_REDACTED))
    if (answer === ROW_READ_REJECTS) {
      expect(failedLines).toHaveLength(1)
      expect(failedLines[0]).toContain(renderPersonaRef(h.alpha.name, h.alpha.key))
      // The thrown value's type, then its redacted message.
      expect(failedLines[0]).toContain(`Error message="${ROW_READ_REJECTION_REDACTED}"`)
    } else {
      expect(failedLines).toEqual([])
    }
    expect(h.logs.filter((l) => l.includes('error handling event'))).toEqual([])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual(state === 'starting-now' ? [{ key: h.alpha.key, cwd: h.alpha.working_directory }] : [])
    expectNoFakeTimerLeft(h)
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 (Task ruling: decide again after the read) — states 1 to 5
// are decided again over fresh answers once the read settles, so a latch or
// an outage that begins while the read runs gives state 2 or 5, whatever
// the read answers. (A live-row sequence or old-life wait step running for
// P answers `restarting` with no read, SRJ-706: the read gate in
// tests/persona-routing.test.ts.) Two messages lost together,
// both reads in flight at once, schedule one restart: nothing is awaited
// between the final decision and `scheduleRestart`.
// ===========================================================================

describe('b.jg5 SRJ-1011: the state is decided again after the read', () => {
  const DURING: [string, InputName, LostMessageState][] = [
    ['alpha is latched', 'latched on a CONFLICT', 'held-for-human'],
    ['alpha\'s tmux-unavailable outage is raised', 'tmux-unavailable raised', 'not-answering'],
    ['alpha\'s ad-config-malformed outage is raised', 'ad-config-malformed raised', 'not-answering'],
  ]
  const table = DURING.flatMap(([label, input, state]) =>
    ([['live', LIVENESS_READING_LIVE], ['pending', LIVENESS_READING_PENDING]] as const).map(
      ([name, answer]): [string, string, InputName, LostMessageState, RowReadAnswer] => [label, name, input, state, answer],
    ),
  )

  test.each(table)('AC 68: %s while the read runs, which then answers %s: the notice reports the earlier state, and no restart is asked for, scheduled or launched', async (_label, _answerName, input, state, answer) => {
    const h = makeHarness({
      ...inputOpts(input),
      rowRead: { alpha: { answer, during: (hh, key) => INPUTS[input].set(hh as Harness, key) } },
    })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`, `notice:${h.alpha.key}`])
    expect(h.restartAsks).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
    expectNoFakeTimerLeft(h)
  })

  test('two messages lost together for alpha, both reads in flight at once and answering live: exactly one restart is scheduled; one notice says starting now, the other restarting', async () => {
    // Each read waits until both have started, so both decisions follow both reads.
    let started = 0
    let bothStarted!: () => void
    const both = new Promise<void>((resolve) => { bothStarted = resolve })
    const during = async (): Promise<void> => {
      started += 1
      if (started === 2) bothStarted()
      await both
    }
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S, rowRead: { alpha: { answer: LIVENESS_READING_LIVE, during } } })

    await Promise.all([
      h.deliver(messageIn(SHARED, `first ${MESSAGE_MARKER}`), h.alpha.key),
      h.deliver(messageIn(ALPHA_SECOND, `second ${MESSAGE_MARKER}`), h.alpha.key),
    ])

    expect(h.readOrder.slice(0, 2)).toEqual([`read:${h.alpha.key}`, `read:${h.alpha.key}`])
    expect(h.rowReads).toEqual([h.alpha.key, h.alpha.key])
    // One scheduleRestart reached the relaunch gate (a second would have asked it again).
    expect(h.restartAsks).toEqual([h.alpha.key])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(lostNotices(h).map((n) => n.state).sort()).toEqual(['restarting', 'starting-now'])
    expect(lostNotices(h).every((n) => n.key === h.alpha.key && n.channel === ALPHA_HOME)).toBe(true)
    expectBetaUntouched(h)
  })
})

// ===========================================================================
// AC 68 (b.jg5 SRJ-1501, the b.av2 SR-4.6 amendment) — the verifier: run
// `bun test tests/inbound-recovery-drop-branch.test.ts -t "AC 68"` (a bare
// `-t "AC 68"` also matches b.av2's AC 68 cases in reload-apply.test.ts).
// In each of states 2 to 6 (state 6 from a launch
// running here; from the read, and the `starting-now` control, which
// launches once, in the state-6-by-read describe above), arranged as the
// shared state table (`LOST_STATE_SETUPS`) arranges it, with the restart
// module able to launch (fast delay) and its relaunch gate recording every
// ask, a lost message asks for, schedules and launches nothing. The row read
// is bound in every row and would answer live (a restart's input): only the
// early state keeps it from being made.
// ===========================================================================

describe('AC 68: no human-triggered restart fires in states 2 to 6 (b.jg5 SRJ-1501)', () => {
  const rows = NO_RESTART_STATES.map((state): [string, LostMessageState] => [
    state === 'session-starting' ? 'session-starting (a launch running)' : state,
    state,
  ])

  test.each(rows)('AC 68: %s: no read, and the message asks the relaunch gate nothing, schedules nothing and launches nothing', async (_label, state) => {
    const h = makeHarness({ ...LOST_STATE_SETUPS[state].opts, rowRead: { alpha: LIVENESS_READING_LIVE } })
    await arrangeState(h, state)
    const asksBefore = h.restartAsks.length
    const launchesBefore = h.launches.length
    const pendingBefore = isRestartPendingOrActive(h.alpha.key)

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
    expect(h.rowReads).toEqual([])
    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(pendingBefore)
    await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
    expect(h.launches).toHaveLength(launchesBefore)
  })
})

// ===========================================================================
// b.jg5 SRJ-1011, SRJ-115 through the recovery harness (its lost-message
// driver, bound as main() binds it): the routing's row read is the one
// liveness adapter's `status` of P's own instance, made outside any launch or
// recovery attempt. Nothing in flight: one `status` call; a spawn held open
// (a launch in flight): none. An ENVIRONMENT or CONFIG answer raises its
// outage (and arms the retry timer, as from any verb), and the decision
// after the read reports not answering. An UNAVAILABLE or UNCLASSIFIED answer
// is a failed read: nothing raised or armed, no `tmux-unresponsive`
// condition, no unclassified-error episode. `ErrSystemInstallDisappeared`
// raises `ad-unreachable` and reads `dead`. None of them is state 6. Both
// settings are 0 unless a case says otherwise, so a failed read reports
// auto-restart disabled.
// ===========================================================================

/** Nothing raised or armed for `key`: no outage flag, no trigger, no armed timer, no condition, no episode, no fake-clock timer. */
function expectNothingRaisedOrArmed(h: RecoveryHarness, key: string): void {
  expect([...getOutageFlags(key)]).toEqual([])
  expect(h.triggers).toEqual([])
  expect(h.controller.armedKeys()).toEqual([])
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.unclassifiedErrorOpen(key)).toBe(false)
  expect(h.clock.pendingCount()).toBe(0)
}

describe('b.jg5 SRJ-1011 through the recovery harness: the read is the liveness adapter\'s one `status`, outside any attempt', () => {
  test('AC 68: a spawn held open, and then P’s dialog approver running after the launch returned (the row `pending`, a dialog shown), each report session starting with no `status` call from the routing and no restart; Q beside it makes its read', async () => {
    const h = makeRecovery()
    const [key, other] = h.keys as [string, string]
    const id = personaInstanceId(key)
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(key)
    await hold.entered(id)
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }), readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }] })

    // A launch running is state 6 with no read.
    await expectLostMessageReports(h, key, 'session-starting', { calls: {} })

    // The spawn returns and the launch with it; P's approver makes its first
    // lap (it reads the row `pending` and answers the dialog) and then waits
    // for its next one on the harness clock.
    hold.release(id)
    expect(await launch).toMatchObject({ key, action: 'spawned' })
    await h.settle()
    expect(h.approverRunning(key)).toBe(true)
    expect(h.stub.calls.sendKeysCalls).toHaveLength(1)
    const spawnsBefore = h.stub.calls.spawnCalls.length

    // The approver running is state 6 with no read, never starting now.
    await expectLostMessageReports(h, key, 'session-starting', { calls: {} })
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toHaveLength(spawnsBefore)
    // Q has no approver: its message makes its one read, which finds its row `pending`.
    await expectLostMessageReports(h, other, 'session-starting')

    expect(await h.runApproverToStop(key)).toMatchObject({ reason: APPROVER_STOP_CAP })
    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, string, RecoveryRowState, ApproverStopReason, LostMessageState]>([
    ['its stop entry', 'the row still `pending`', AGENT_DIRECTOR_PENDING_STATE, APPROVER_STOP_TEARDOWN, 'session-starting'],
    ['its ready cap', 'the row still `pending`', AGENT_DIRECTOR_PENDING_STATE, APPROVER_STOP_CAP, 'session-starting'],
    ['a lap that reads the row live', 'the row live', 'waiting', APPROVER_STOP_LIVE, 'auto-restart-disabled'],
  ])('AC 68: after P’s dialog approver stopped at %s, %s, the next lost message makes exactly one `status` call and reports %s, with no restart and no spawn', async (_how, _row, state, reason, lostState) => {
    // A cap past the pace, so a second lap reads the row before it.
    const h = makeRecovery({ approverCapMs: 2 * DIALOG_POLL_INTERVAL_MS })
    const [key] = h.keys as [string]
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }) })
    await h.launch(key)
    await h.settle()
    expect(h.approverRunning(key)).toBe(true)

    h.script({ statusResult: cannedStatusResult({ state }) })
    if (reason === APPROVER_STOP_TEARDOWN) expect(await stopDialogApprover(key, APPROVER_STOP_TEARDOWN)).toBe(true)
    expect(await h.runApproverToStop(key)).toMatchObject({ reason })
    expect(h.approverRunning(key)).toBe(false)
    const spawnsBefore = h.stub.calls.spawnCalls.length

    await expectLostMessageReports(h, key, lostState)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toHaveLength(spawnsBefore)
    expectNothingRaisedOrArmed(h, key)
  })

  test('with `session_restart_delay` above 0, a routing read that fails reports starting now; the restart path\'s own read then finds the row `pending` and spawns nothing', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    const id = personaInstanceId(key)
    h.script({ statusQueue: [cannedErr(errInternal()), cannedOk(cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }))] })

    const lost = await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })

    expect(lost.restartPending).toBe(true)
    await waitFor(() => !isRestartPendingOrActive(key), 1000)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: id }, { claude_instance_id: id }])
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.killCalls).toEqual([])
    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, () => Error, OutageClass, string]>([
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'status'), 'tmux-unavailable', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed(), 'ad-config-malformed', UNAVAILABLE_RETRY_CAUSE_CONFIG],
  ])('AC 68: a read answering %s raises %s, which this message reports as not answering; no restart is asked for, and the retry timer is armed as from any verb', async (_label, make, flag, cause) => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key, other] = h.keys as [string, string]
    h.script({ statusError: make() })

    await expectLostMessageReports(h, key, 'not-answering', { calls: { statusCalls: 1 } })

    expect([...getOutageFlags(key)]).toEqual([flag])
    expect(h.triggers).toEqual([{ key, kind: cause }])
    expect(h.controller.armedKeys()).toEqual([key])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect([...getOutageFlags(other)]).toEqual([])
    // The teardown's stop leaves no timer on the fake clock.
    h.teardown(key)
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each([
    ...unavailableForms('ErrTmuxUnresponsive', 'ErrCallTimeout', 'a wrapped UnknownError', 'a plain Error'),
    ...unavailableForms(['ErrUnknownErrorName', 'an unknown error name']),
  ])('SRJ-1011: a read answering %s (UNAVAILABLE) raises nothing, arms no retry timer, starts no tmux-unresponsive condition and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make('status') })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, () => Error]>([
    ['ErrInternal with no recognised phrase', () => errInternal()],
    ['ErrSchemaMismatch', () => errSchemaMismatch()],
  ])('SRJ-1011, hatch A2: a read answering %s (UNCLASSIFIED) arms no retry timer, opens no unclassified-error episode and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make() })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test('SRJ-1011, SRJ-115, hatch A2: a read answering ErrSystemInstallDisappeared raises ad-unreachable and reads dead, not pending: state 6 is left out, nothing is armed and no episode opens', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: errSystemInstallDisappeared('status') })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expect([...getOutageFlags(key)]).toEqual(['ad-unreachable'])
    expect(h.triggers).toEqual([])
    expect(h.controller.armedKeys()).toEqual([])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 state 4, SRJ-704 (E20 T3): a message lost while P's
// kill-failure episode is open reports `kill-failed`
//
// Through the recovery harness's lost-message driver, whose `isKillFailed` is
// bound to the harness's kill-failure alerts' episode as main() binds it. The
// restart path's kill is one try (its `dead` seed), so an `ErrTmuxKillFailed`
// there stands at once; the multi-try legs run at the step-1 kill of the
// live-row sequence P's launch starts at a collision ladder replacement site
// over a row read live (`scriptLiveRowElsewhere`, `launchThroughSequence`, on
// the sequence clock; the ladder makes no kill, b.jg5 SRJ-707). States
// and wordings come from src/lost-message.ts (`expectLostMessageReports`).
// ===========================================================================

describe('b.jg5 SRJ-1011 state 4: a message lost after the kill-failure alert reports kill failed, through the real routing', () => {
  /** P's launch meeting its row read `waiting` in another directory, the step-1 kill of the sequence it starts answering `kills` in order; the sequence is driven to its end. */
  async function sequenceKill(h: RecoveryHarness, key: string, ...kills: Error[]): Promise<void> {
    scriptLiveRowElsewhere(h, key, { killQueue: kills.map((err) => cannedErr(err)) })
    await launchThroughSequence(h, key)
  }

  test('ErrTmuxKillFailed that stands at the restart path\'s kill: after the ordinary alert, a lost message reports kill failed with its wording; no human-triggered restart fires, with the delay above 0', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    rowReadsUntilSpawn(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })
    await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)
    expect(h.episodeNotices).toHaveLength(1)

    await expectLostMessageReports(h, key, 'kill-failed')

    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toEqual([])
  })

  test('a survivor-naming failure, then ErrTmuxUnresponsive twice, at the live-row sequence\'s kill of a row read live, started at a replacement site: the ordinary alert, then a lost message reports kill failed', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'), errTmuxUnresponsive('kill'), errTmuxUnresponsive('kill'))

    expect(h.killFailureOpen(key)).toBe(true)
    await expectLostMessageReports(h, key, 'kill-failed')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('a survivor-naming failure, then a read of ended, at the live-row sequence\'s kill of a row read live, started at a replacement site: the survivor version opens no episode, and a message lost afterwards reports the state the launch left, never kill failed', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusQueue: [cannedOk(cannedStatusResult({ state: 'ended' }))] })

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'))
    await h.runApproverToStop(key)

    expect(h.episodeNotices).toHaveLength(1)
    expect(h.killFailureOpen(key)).toBe(false)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
  })

  test('a survivor-naming failure, then CONFLICT, at the live-row sequence\'s kill of a row read live, started at a replacement site: P latched and its kill-failure episode open, a lost message reports held for a human, not kill failed', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'), errTmuxSessionConflict('kill', 'not-this-launch'))

    expect(h.latch.isLatched(key)).toBe(true)
    expect(h.killFailureOpen(key)).toBe(true)
    await expectLostMessageReports(h, key, 'held-for-human')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('after the episode ends (a later restart run\'s liveness read of ended, whose kill then succeeds), a lost message no longer reports kill failed', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    rowReadsUntilSpawn(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })
    await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)
    expect(h.killFailureOpen(key)).toBe(true)

    h.script({ killError: undefined })
    await retryNow(h, key)
    await h.runApproverToStop(key)

    expect(h.killFailureOpen(key)).toBe(false)
    expect(h.episodeNotices).toHaveLength(1)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 state 3, SRJ-207 (E23 T3): a message lost while P is held
// on ErrInvalidFlags reports `cannot-launch`
//
// Through the recovery harness's lost-message driver, whose held-on-invalid-
// flags input is bound to the harness's one hold as main() binds it. P is
// held through a real reuse spawn of its id answering ErrInvalidFlags, its
// version re-check on the harness clock passing; the restart delay is above
// 0, so a restart the message wrongly asked for would launch. `cannot-launch`
// comes after `held-for-human` and before `kill-failed`; once the binary's
// version changes the hold ends and the message is decided as before. States
// and wordings come from src/lost-message.ts (`expectLostMessageReports`).
// ===========================================================================

describe('b.jg5 SRJ-1011 state 3, SRJ-207: a message lost while P is held on ErrInvalidFlags reports cannot launch, through the real routing', () => {
  /** A finished row of P's in another directory, so P's next launch replaces it by a reuse spawn of the same id that answers ErrInvalidFlags. */
  function scriptHeldReuse(h: RecoveryHarness, key: string): void {
    h.script(collided(h, personaOf(h, key), { cwd: h.home, state: LIVENESS_DEAD_ROW_ENDED }, errInvalidFlags('spawn')))
  }

  test('P held through a reuse: a lost message reports cannot launch with its wording; no restart is asked for, scheduled or launched, and no stub call is made for P', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    h.versionRecheck()
    scriptHeldReuse(h, key)
    expect(await h.launch(key)).toEqual({ key, action: 'held' })
    const before = personaCallCounts(h, key)

    const outcome = await expectLostMessageReports(h, key, 'cannot-launch')

    expect(outcome.notice).toContain(STATE_WORDING['cannot-launch'])
    expect(h.restartAsks).toEqual([])
    expect(isRestartPendingOrActive(key)).toBe(false)
    await Bun.sleep(FAST_DELAY_S * 1000 * 4)
    await h.settle()
    expect(personaCallCounts(h, key)).toEqual(before)
    expect(h.invalidFlagsHold.isHeld(key)).toBe(true)
  })

  test('P held with its kill-failure episode open: cannot launch is reported, not kill failed', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    rowReadsUntilSpawn(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })
    await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)
    expect(h.killFailureOpen(key)).toBe(true)
    // The sequence-launch entry's reuse (no row read first, which would end the episode) holds P.
    h.script({ killError: undefined, spawnError: errInvalidFlags('spawn') })
    expect(await launchForLiveRowSequence(personaOf(h, key), h.config, { kind: LIVE_ROW_LAUNCH_REUSE, lastRead: latchRowStateRead(LIVENESS_DEAD_ROW_ENDED) })).toEqual({ key, action: 'held' })
    expect([h.invalidFlagsHold.isHeld(key), h.killFailureOpen(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'cannot-launch')

    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('P latched and held: held for a human is reported, not cannot launch', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    scriptHeldReuse(h, key)
    expect(await h.launch(key)).toEqual({ key, action: 'held' })
    // A provenance_conflict note on P's own row, read by the session manager's shared own-row read, latches P.
    h.script({ getResult: personaRow(h, key, { liveness_note: provenanceNote }) })
    expect(await readPersonaOwnRow(key, { site: 'inbound-recovery-drop-branch.test', what: 'own-row get' })).toMatchObject({ latched: true })
    expect([h.latch.isLatched(key), h.invalidFlagsHold.isHeld(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'held-for-human')

    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('after the binary\'s version changes and the hold ends (P retried at once, its launch refused), a lost message no longer reports cannot launch', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    const rc = h.versionRecheck()
    scriptHeldReuse(h, key)
    expect(await h.launch(key)).toEqual({ key, action: 'held' })
    await expectLostMessageReports(h, key, 'cannot-launch')

    // The retry at once meets an UNAVAILABLE answer at its first spawn: refused, P's timer armed, P not up.
    rc.answer({ version: PHASE1_FLOOR_VERSION })
    h.script({ spawnQueue: [], spawnError: unavailableAt('spawn'), statusResult: cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED }) })
    await h.advance(rc.nextDueAt()! - h.clock.now())
    await h.settle()
    expect(h.invalidFlagsHold.isHeld(key)).toBe(false)
    expect(h.retriesAtOnce.map((retry) => retry.key)).toEqual([key])

    const outcome = await h.loseMessage(key)
    expect(outcome.state).not.toBe('cannot-launch')
    h.teardown(key)
  })
})

// ===========================================================================
// b.jg5 SRJ-706, SRJ-1011 (E21 T2): a message lost while P's live-row
// sequence runs reports `restarting`
//
// Through the recovery harness's lost-message driver, whose sequence/wait
// input is the session manager's running query and whose read gate's "in
// flight for P" counts the sequence, both as main() binds them, with P's
// sequence started through the registry and its first run held (the stub's
// `holdFindMissing`). Restarting is decided with no `status` read and no
// human-triggered restart, even while P's row reads `pending` and during the
// sequence's own step-6 launch; a latch beats it; once the sequence has
// ended the message is decided as before, with the one read.
// ===========================================================================

describe('b.jg5 SRJ-706, SRJ-1011: a message lost while P\'s live-row sequence runs reports restarting, with no status read and no restart, through the real routing', () => {
  /** Release P's held run with its row placed in `ids` and drive the sequence to its end (its next `get` reads the row missing). */
  async function endHeldSequence(h: RecoveryHarness, key: string, hold: FindMissingHold, outcome: Promise<unknown>): Promise<void> {
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(key)]: 'ids' } }))
    await h.driveSequence(outcome)
    expect(h.sequenceRunning(key)).toBe(false)
  }

  test('restarting with no read while P\'s first run is held; Q\'s message beside it is decided as before; once P\'s sequence has ended, P\'s next message makes its one read again', async () => {
    const h = makeRecovery()
    const [key, other] = h.keys as [string, string]
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, key, hold)

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })
    await expectLostMessageReports(h, other, 'auto-restart-disabled')

    await endHeldSequence(h, key, hold, run.outcome)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('the row the sequence last read `pending`, and the stub\'s `status` answering `pending`: restarting, never session starting, with no read', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    await pastSampleGrace(h)
    const persona = personaOf(h, key)
    h.script({
      statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }),
      getQueue: [
        cannedOk(cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE }, persona, h.home)),
        cannedOk(cannedGetResult({ state: LIVENESS_DEAD_ROW_MISSING }, persona, h.home)),
      ],
    })
    const hold = holdFindMissing(h.stub.client)
    const run = await startSequenceHeldAtRun(h, key, hold, { lastReadState: AGENT_DIRECTOR_PENDING_STATE })

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })

    await endHeldSequence(h, key, hold, run.outcome)
  })

  test('during the sequence\'s own step-6 launch (a launch in flight for P): restarting, never session starting, with no read', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, key), h.home) })
    const reuse = holdSequenceReuse(h, key)
    const run = h.startSequence(key, { lastReadState: cannedStatusResult().state })
    await h.driveSequence(reuse.entered)
    expect(isLaunchInFlight(key)).toBe(true)

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })

    reuse.release()
    await h.driveSequence(run.outcome)
  })

  test('P latched while its stopped sequence\'s run is still held: held for a human beats restarting', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, key, hold)
    // Another path's own-row read latches P (SRJ-513); the sequence still runs until its run returns.
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    await readPersonaRowState(key)
    expect([h.latch.isLatched(key), h.sequenceRunning(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'held-for-human')

    await endHeldSequence(h, key, hold, run.outcome)
  })
})

// ===========================================================================
// Not up (b.av2 SR-6.4; regression guard for bug b.g57) — a message can
// still reach a persona whose bring-up outcome is not up: one that stopped
// being up while the message was being handled, or the old half of a
// destructive modify after its bring-up was cancelled and before its
// connection is stopped. Such a message used to report "starting now" and ask
// for a restart the relaunch gate refused. Now the notice says "not up" and
// nothing is scheduled: the persona's own recovery launches it. The up check
// is the real `createPersonaUpPredicate` over a serving connection, with the
// bring-up outcome injected as not up; the production wiring (the routing
// gets the server's one `isPersonaUp`) is pinned in
// tests/server-startup-wiring.test.ts.
// ===========================================================================

describe('not up: a lost message for a persona that is not up starts no restart', () => {
  test.each(['no session', 'streamless'] as const)(
    'b.g57 REGRESSION: %s, alpha not up while its connection still delivers: three messages each get exactly the not-up notice at the destination, no restart is asked for, scheduled or launched and nothing is delivered; once alpha is up, the next lost message starts now',
    async (branch) => {
      const h = makeHarness({ branch, notUp: ['alpha'] })
      // The relaunch gate over the same bring-up state: before the fix every
      // message asked it for a restart, and it refused with a line.
      const gateLines: string[] = []
      const deps = makeRestartDeps({ restartDelayS: FAST_DELAY_S })
      deps.canRestart = createPersonaRelaunchGate({ status: () => SERVING }, (line) => { gateLines.push(line) }, h.upOutcomes)
      initRestart(deps)

      for (let i = 0; i < 3; i++) await h.deliver(messageIn(SHARED, `message ${i} ${MESSAGE_MARKER}`), h.alpha.key)

      expect(lostNotices(h)).toEqual(Array.from({ length: 3 }, () => ({ key: h.alpha.key, channel: ALPHA_HOME, state: 'not-up' })))
      for (const post of h.allPosts()) expectNoticeText(h, post.text, STUB_USER_NAME, 'not-up')
      expect(h.postsTo(SHARED)).toEqual([])
      expect(h.upAsks).toEqual([h.alpha.key, h.alpha.key, h.alpha.key])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      expect(gateLines).toEqual([])
      expect(h.p('alpha').notifications).toEqual([])
      expectBetaUntouched(h)
      await Bun.sleep(WAIT_MS) // a restart scheduled anyway would have launched by now
      expect(deps.launches).toEqual([])

      // Control: the same persona, up again, is restarted by its next lost message.
      h.notUp.delete(h.alpha.key)
      await h.deliver(messageIn(SHARED), h.alpha.key)
      expect(lostNotices(h).map((n) => n.state)).toEqual(['not-up', 'not-up', 'not-up', 'starting-now'])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      await waitFor(() => deps.launches.length > 0)
      expect(deps.launches).toEqual([{ key: h.alpha.key, cwd: expectedLaunchCwd(h, branch) }])
      expect(gateLines).toEqual([])
    },
  )

  test('one message lost on both connections, beta up and alpha not up: beta reports starting now and is restarted, alpha reports not up and is not, each at its own destination', async () => {
    const h = makeHarness({ notUp: ['alpha'] })
    // Beta is `mentions` in the shared channel, so it gets the message by mention.
    const event = messageIn(SHARED, `${mentionText(h.p('beta').stub.identity.botUserId)} ${MESSAGE_MARKER}`)

    await h.deliver(event, [h.beta.key, h.alpha.key])

    expect(lostNotices(h)).toEqual([
      { key: h.beta.key, channel: BETA_MENTIONS, state: 'starting-now' },
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'not-up' },
    ])
    expect(h.postsTo(SHARED)).toEqual([])
    expect(h.upAsks).toEqual([h.beta.key, h.alpha.key])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(true)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.beta.key, cwd: h.beta.working_directory }])
  })

  test('the up check is asked with the persona\'s key, not its name', async () => {
    const asked: string[] = []
    const h = makeRoutingHarness([{ name: 'Not Up Persona', channels: [{ id: SHARED, delivery: 'all' }] }], dir, {
      sessions: [],
      restartDelayS: FAST_DELAY_S,
      isPersonaUp: (key) => {
        asked.push(key)
        return false
      },
    })
    harnesses.push(h)
    const notUp = h.config!.personas[0]!
    expect(notUp.key).not.toBe(notUp.name)

    await h.receiveKeys(messageIn(SHARED), [notUp.key])

    expect(asked).toEqual([notUp.key])
    expect(h.allPosts().map((p) => stateOf(p.text))).toEqual(['not-up'])
    expect(isRestartPendingOrActive(notUp.key)).toBe(false)
  })

  // An up persona passing the check to "starting now" is the beta side of the
  // two-persona case above; the AC 26 state table (no up check at all) fails
  // if an absent check counted as not up. This one row shows an up persona
  // still falls through to a later restart-guard state.
  test('alpha up through the up check and at the restart-failure cap: the notice says restart limit reached and nothing launches', async () => {
    const h = makeHarness({ ...LOST_STATE_SETUPS['restart-limit-reached'].opts, upCheck: true })
    await arrangeState(h, 'restart-limit-reached')

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'restart-limit-reached' })
    expect(h.upAsks).toEqual([h.alpha.key])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
  })
})

// ===========================================================================
// AC 26 — the sender. A readable name: the `users.info` name through the
// persona's own client; the user ID when the lookup fails; a webhook or bot
// post's username, bot profile name or bot ID. Slack's control characters in
// a sender-chosen name are escaped, so the notice never mentions anyone.
// ===========================================================================

describe('AC 26: the notice names the sender readably, with no mention', () => {
  test.each<[string, () => SlackEvent, string]>([
    ['a webhook post, by its username', () => makeWebhookPost({ channel: SHARED, text: MESSAGE_MARKER }), 'stub-webhook'],
    [
      'a bot post with no username, by its bot profile name',
      () => makeWebhookPost({ channel: SHARED, text: MESSAGE_MARKER, username: undefined, bot_profile: { name: 'stub-hook-profile' } }),
      'stub-hook-profile',
    ],
    ['a bot post with no name at all, by its bot ID', () => makeWebhookPost({ channel: SHARED, text: MESSAGE_MARKER, username: undefined }), 'B0STUBHOOK'],
  ])('AC 26: %s', async (_label, build, sender) => {
    const h = makeHarness()

    await h.deliver(build(), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender, state: 'starting-now' })
  })

  test('AC 26: a sender-chosen name carrying `<!channel>`, a user mention and `&` is escaped in the notice, so it pings no one', async () => {
    const h = makeHarness()
    const username = '<!channel> <@U0VICTIM1> & co'

    await h.deliver(makeWebhookPost({ channel: SHARED, text: MESSAGE_MARKER, username }), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: '&lt;!channel&gt; &lt;@U0VICTIM1&gt; &amp; co', state: 'starting-now' })
    const text = h.allPosts()[0]!.text!
    expect(text).not.toContain('<!channel>')
    expect(text).not.toContain('<@U0VICTIM1>')
  })

  test.each(['no session', 'streamless'] as const)(
    'AC 26: %s, the user-name lookup rejects: the human-triggered restart still starts and exactly one notice names the user ID, with one token-safe line that keeps the error\'s message, redacted',
    async (branch) => {
      const h = makeHarness({
        branch,
        resolveUserName: async () => { throw new Error(`users.info failed (${sentinelInMessage('users-info')})`) },
      })

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: HUMAN, state: 'starting-now' })
      expect(h.notices).toHaveLength(1)
      const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
      const lookupLines = h.logs.filter((l) => l.includes(`user-name lookup for persona ${ref} failed, using the user ID`))
      expect(lookupLines).toHaveLength(1)
      // The error's message is kept, redacted (the sentinel is in no log line: the teardown leak check).
      expect(lookupLines[0]).toContain('users.info failed')
      expect(h.logs.filter((l) => l.includes('error handling event'))).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      await waitFor(() => h.launches.length > 0)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: expectedLaunchCwd(h, branch) }])
    },
  )
})

// ===========================================================================
// Required behavior 1 — a qualifying message with no live session recovers P
// ===========================================================================

describe('b.kvq (1) a qualifying message for a sessionless persona triggers recovery', () => {
  // REGRESSION GUARD: before b.kvq, the drop branch never called
  // scheduleRestart for a sessionless recipient, so no launch was ever
  // scheduled and nothing recovered from a human typing to the persona.
  test('REGRESSION: a message in the persona\'s SECOND channel schedules a launch keyed to the persona, not the source channel, in its working directory, and it fires; the notice goes to the destination', async () => {
    const h = makeHarness()

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    // Real side effect: a restart is now pending for the persona …
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    // … not under the source channel …
    expect(isRestartPendingOrActive(ALPHA_SECOND)).toBe(false)
    // … and for no other persona.
    expectBetaUntouched(h)
    expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' }])

    // And the timer really fires and launches in the persona's working directory.
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })

  test('a registered but disconnected session counts as no session: recovery in the persona\'s working directory', async () => {
    const h = makeHarness()
    h.registerFor('alpha', { disconnected: true })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    await Bun.sleep(WAIT_MS)
    expect(h.launches.map((c) => c.cwd)).toEqual([h.alpha.working_directory])
  })

  test.each([ALPHA_SECOND, SHARED])(
    'a pending restart on the persona suppresses a launch triggered from %s',
    async (channel) => {
      // SLOW delay keeps the persona's restart pending across the message.
      const h = makeHarness({ restartDelayS: SLOW_DELAY_S })
      scheduleRestart(h.alpha.key, h.alpha.working_directory, undefined, { humanTrigger: true })

      await h.deliver(messageIn(channel), h.alpha.key)

      // The guard read the persona's pending state: "restarting", not "starting now".
      // Keyed on the source channel, it would have found nothing pending.
      expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'restarting' }])
      expectBetaUntouched(h)
    },
  )

  test.each([ALPHA_SECOND, SHARED])(
    'a cap on the persona suppresses recovery triggered from %s',
    async (channel) => {
      const h = makeHarness()
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(h.alpha.key)
      // The source channel is NOT at cap — keying on it would wrongly launch.
      expect(isAtCap(channel, RESTART_FAILURE_CAP)).toBe(false)

      await h.deliver(messageIn(channel), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      expect(isRestartPendingOrActive(channel)).toBe(false)
      expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'restart-limit-reached' }])
      expectBetaUntouched(h)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toHaveLength(0)
    },
  )
})

// ===========================================================================
// Required behavior 2 — a message that does not qualify for P triggers nothing
// ===========================================================================

describe('b.kvq (2) a message the persona does not get triggers nothing and raises no notice, with no session anywhere', () => {
  test.each<[string, 'two' | 'none', (h: Harness) => SlackEvent, 'alpha' | 'beta' | 'none']>([
    ['a channel no persona lists', 'two', () => messageIn(UNCLAIMED), 'alpha'],
    ['an unmentioned message in a `mentions` channel', 'two', () => messageIn(BETA_MENTIONS), 'beta'],
    ['a channel the persona is not configured into (another persona\'s)', 'two', () => messageIn(BETA_MENTIONS), 'alpha'],
    ['the persona\'s own message in its `all` channel', 'two', (h) => makeChannelMessage({ channel: SHARED, user: h.p('alpha').stub.identity.botUserId }), 'alpha'],
    ['an intake call with no applied personas (zero-persona config)', 'none', () => messageIn(SHARED), 'none'],
    ['a key that is not an applied persona (zero-persona config)', 'none', () => messageIn(SHARED), 'alpha'],
  ])('%s', async (_label, personas, build, receiver) => {
    const h = makeHarness()
    if (personas === 'none') h.config = { ...h.config!, personas: [] }
    const keys = receiver === 'none' ? [] : [receiver === 'alpha' ? h.alpha.key : h.beta.key]
    const event = build(h)

    await h.deliver(event, keys)

    for (const key of [h.alpha.key, h.beta.key, event.channel as string]) {
      expect(isRestartPendingOrActive(key)).toBe(false)
    }
    expect(h.notices).toEqual([])
    expect(h.allPosts()).toEqual([])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 3 — a second message while restarting does not stack.
// While the first message's restart timer is pending, the second reports
// "restarting"; once its launch is in flight (held open), the persona's row
// reads `pending`, so the second reports "starting" (b.jg5 SRJ-1011 state 6),
// never "starting now", and stacks no launch.
// ===========================================================================

describe('b.kvq (3) second message while restart pending/active does not stack a launch', () => {
  test('two messages in quick succession: a "starting now" notice, then, while the restart timer is pending, a "restarting" notice', async () => {
    // SLOW delay keeps the first restart pending across the second message.
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(lostNotices(h)).toEqual([
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' },
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'restarting' },
    ])
    // Only the first message asked for a restart.
    expect(h.restartAsks).toEqual([h.alpha.key])
    expectBetaUntouched(h)
  })

  test('while the first message\'s launch is actively in flight, a new message reports session starting and does not stack another launch', async () => {
    // Hold launchSession open so the persona is in activeLaunches (not just a
    // pending timer) when the second message arrives.
    const h = makeHarness({ restartDelayS: FAST_DELAY_S, holdLaunches: true })

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await waitFor(() => h.launches.length > 0) // timer fired; launchSession is now awaiting
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.isLaunchInFlight(h.alpha.key)).toBe(true)
    expect(h.launches).toHaveLength(1)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await Bun.sleep(WAIT_MS) // a stacked timer would have fired by now

    // Still exactly one launch despite the second message, which asked for no restart.
    expect(h.launches).toHaveLength(1)
    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(lostNotices(h).map((n) => n.state)).toEqual(['starting-now', 'session-starting'])
    expectBetaUntouched(h)
  })
})

// ===========================================================================
// b.av2 SR-4.1 — a duplicate of a lost message triggers nothing more.
// A channel mention reaches the persona as a `message` and an `app_mention`
// with the same (channel, ts), and Slack may redeliver either. The persona's
// dedupe store sits before the lost-message branch, so the pair and any later
// redelivery give one notice and one recovery.
// ===========================================================================

describe('b.kvq x SR-4.1 a duplicated mention for a sessionless persona recovers once', () => {
  test('AC 26: a `message` then `app_mention` of the same mention: one notice and one launch; a redelivery after the launch adds nothing', async () => {
    const h = makeHarness()
    const text = `${mentionText(h.p('alpha').stub.identity.botUserId)} are you there? ${MESSAGE_MARKER}`
    const message = makeChannelMessage({ channel: SHARED, text })
    const mention = makeAppMention({ channel: SHARED, text, ts: message.ts })
    expect(mention.ts).toBe(message.ts)

    await h.deliver(message, h.alpha.key)
    await h.deliver(mention, h.alpha.key)

    // Without dedupe the app_mention would find the restart pending and raise
    // a second, "restarting" notice.
    expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
    // The launch has finished, so no restart guard would stop a second recovery.
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)

    // Slack redelivers both events: a duplicate does nothing and logs nothing.
    const logsBefore = [...h.logs]
    await h.deliver(message, h.alpha.key)
    await h.deliver(mention, h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(h.notices).toHaveLength(1)
    expect(h.allPosts()).toHaveLength(1)
    expect(h.launches).toHaveLength(1)
    expect(h.logs).toEqual(logsBefore)
    expectBetaUntouched(h)
  })
})

// ===========================================================================
// Required behavior 4 — b.av2 SR-7.2: the lost-message notice joins the
// persona's notice set. Raised before the persona's client is validated, it is
// held and posted once the persona is flushed; a destination that fails holds
// and retries it on the destination hold (on its fake clock). Either way it
// lands once at the destination and never in the source conversation, and
// recovery does not wait for it.
// ===========================================================================

describe('b.kvq (4) SR-7.2: the lost-message notice is held and retried like every persona notice', () => {
  test.each(['channel', 'dm'] as const)(
    'AC 26: raised before the persona\'s client is validated (%s destination): nothing is posted, recovery still starts, and the flush posts it once at the destination, naming the sender by user ID',
    async (destination) => {
      const h = makeHarness({ destination, restartDelayS: SLOW_DELAY_S })
      h.clients.setUnavailable(h.alpha.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      expect(h.notices).toHaveLength(1)
      // With no client there is no Slack call at all: no post, no open, no
      // users.info (the sender is its user ID, as in src/server.ts).
      expect(h.p('alpha').stub.callLog).toEqual([])

      h.clients.setUnavailable(h.alpha.key, false)
      await h.notifier.flush(h.alpha.key)

      expectOneLostNotice(h, { destination, source: SHARED, sender: HUMAN, state: 'starting-now' })
      expect(h.p('alpha').stub.calls.usersInfo).toEqual([])
      expect(h.holdClock.pendingCount()).toBe(0)
    },
  )

  test.each<[Destination, WebApiOutcome, 'post' | 'open']>([
    ['channel', { kind: 'platform', error: 'not_in_channel' }, 'post'],
    ['dm', { kind: 'platform', error: 'missing_scope' }, 'open'],
  ])(
    'AC 26: a %s destination that fails (%j) holds the notice under one persona-destination-failed line; the retry on the fake clock posts it once there, never in the source',
    async (destination, failure, queue) => {
      const h = makeHarness({ destination, restartDelayS: SLOW_DELAY_S })
      h.p('alpha').stub.script[queue].push(failure)
      const dest = destinationId(destination)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      expect(failedLines(h)).toHaveLength(1)
      expect(h.hold.view(h.alpha.key)).toMatchObject({ held: true, heldNotices: 1 })
      expect(h.holdClock.pending().map((t) => t.delayMs)).toEqual([5_000])
      // Any attempt so far (the failed channel post) was at the destination.
      const attempted = h.allPosts().length
      expect(h.allPosts().every((p) => p.key === h.alpha.key && p.channel === dest)).toBe(true)

      await h.holdClock.runNext()

      expect(lostNotices(h).slice(attempted)).toEqual([{ key: h.alpha.key, channel: dest, state: 'starting-now' }])
      expect(h.allPosts().every((p) => p.key === h.alpha.key && p.channel === dest)).toBe(true)
      expect(h.postsTo(SHARED)).toEqual([])
      expectBetaUntouched(h)
      expectNoticeText(h, h.allPosts().at(-1)!.text, STUB_USER_NAME, 'starting-now')
      expect(failedLines(h)).toHaveLength(1)
      expect(clearedLines(h)).toHaveLength(1)
      expect(h.hold.view(h.alpha.key)).toMatchObject({ held: false, heldNotices: 0 })
      expect(h.holdClock.pendingCount()).toBe(0)
    },
  )

  test.each<[string, RoutingHarnessOptions['notify']]>([
    ['throws', () => { throw new Error(`notice sink failed (${sentinelInMessage('notice-sink')})`) }],
    ['rejects', async () => { throw new Error(`notice sink failed (${sentinelInMessage('notice-sink')})`) }],
  ])('a notice sink that %s is logged once naming the persona and keeping the error\'s message, redacted and token-safe; never thrown, and recovery still happens', async (_label, notify) => {
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S, notify })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.notices).toHaveLength(1)
    expect(h.allPosts()).toEqual([])
    const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
    const sinkLines = h.logs.filter((l) => l.includes(`lost-message notice for persona ${ref} failed`))
    expect(sinkLines).toHaveLength(1)
    // The error's message is kept, redacted (the sentinel is in no log line: the teardown leak check).
    expect(sinkLines[0]).toContain('notice sink failed')
    expect(h.logs.filter((l) => l.includes('error handling event'))).toEqual([])
    expectBetaUntouched(h)
  })
})

// ===========================================================================
// Required behavior 5 — auto-restart disabled (session_restart_delay 0)
// ===========================================================================

describe('b.kvq (5) auto-restart disabled (delay 0) path', () => {
  test('the disabled branch schedules no launch, even with restart.ts itself able to launch', async () => {
    // The restart deps report a nonzero delay, so had the branch called
    // scheduleRestart anyway, the launch would really fire.
    const h = makeHarness({ sessionRestartDelay: 0, restartDelayS: FAST_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'auto-restart-disabled' }])
    expectBetaUntouched(h)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })

  test('scheduleRestart with humanTrigger still early-returns when base delay is 0', async () => {
    // Pin the restart.ts gate directly: humanTrigger does not bypass it.
    const deps = makeRestartDeps({ restartDelayS: 0 })
    initRestart(deps)

    scheduleRestart('kvq_disabled', join(dir, 'kvq-session'), undefined, { humanTrigger: true })
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('kvq_disabled')).toBe(false)
    expect(deps.launches).toHaveLength(0)
  })
})

// ===========================================================================
// b.av2 SR-8.6 — a key outside the applied set is never restarted. The drop
// branch reaches the guard through `scheduleRestart`, whose `canRestart` is
// the real relaunch gate; the gate's applied check (`isApplied`) refuses a
// removed key even while its connection serves and its bring-up outcome is
// `up`. RestartDeps is unchanged. The notice is E8's and not asserted here.
// ===========================================================================

describe('SR-8.6: a message dropped for a key outside the applied set arms no restart timer', () => {
  test('alpha removed from the applied set (still up and serving): a lost message schedules nothing and launches nothing; once applied again, a lost message arms the timer and launches', async () => {
    const h = makeHarness()
    const UP: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0APPLIED', botId: 'B0APPLIED' } }
    const applied = new Set([h.beta.key])
    const gateLines: string[] = []
    const gate = createPersonaRelaunchGate(
      { status: () => UP },
      (line) => { gateLines.push(line) },
      { isUp: () => true, isApplied: (key) => applied.has(key) },
    )
    const deps = makeRestartDeps({ restartDelayS: FAST_DELAY_S })
    deps.canRestart = gate
    initRestart(deps)

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(gateLines).toEqual([`[slack] persona=${h.alpha.key}: not relaunched — it is no longer in the applied configuration`])
    await Bun.sleep(WAIT_MS)
    expect(deps.launches).toEqual([])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(false)

    // Control: the same branch arms the timer once the key is applied.
    applied.add(h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    await Bun.sleep(WAIT_MS)
    expect(deps.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })
})

// ===========================================================================
// Required behavior 6 — humanTrigger clamps delay DOWN only
//
// These tests capture the delay argument passed to global setTimeout by
// scheduleRestart, so they read the ACTUAL scheduled delay rather than waiting
// out multi-second timers. restart.ts uses the global setTimeout, so wrapping
// it here is a legitimate observation seam.
// ===========================================================================

describe('b.kvq (6) humanTrigger delay clamp (DOWN only)', () => {
  const realSetTimeout = globalThis.setTimeout
  let capturedDelayMs: number | null = null

  beforeEach(() => {
    capturedDelayMs = null
    // Capture the delay, but do NOT actually arm a real timer (return a stub
    // handle) so the launch never fires during these timing-only tests.
    globalThis.setTimeout = ((_fn: (...a: unknown[]) => void, ms?: number) => {
      capturedDelayMs = ms ?? 0
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
  })

  test('a 900s-cap-regime backoff is clamped down to HUMAN_TRIGGER_DELAY_CEILING', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    // Drive failure count high enough that nextBackoffDelay saturates at 900s:
    // 60 * 2^4 = 960 → clamped to 900 by backoff.ts.
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session', undefined, { humanTrigger: true })

    // Computed backoff was 900s; humanTrigger clamps it to the 5s ceiling.
    expect(capturedDelayMs).toBe(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })

  test('a lost message is a human trigger: in the 900s regime, the restart it starts waits only HUMAN_TRIGGER_DELAY_CEILING', async () => {
    const h = makeHarness({ restartDelayS: 60 })
    // Four failures (one below the cap): the plain backoff would be 900s.
    for (let i = 0; i < 4; i++) recordFailure(h.alpha.key)

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(lostNotices(h)).toEqual([{ key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' }])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(capturedDelayMs).toBe(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })

  test('a NON-human trigger in the same 900s regime is NOT clamped', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session') // no opts → not human

    expect(capturedDelayMs).toBe(900 * 1000)
  })

  test('a delay already below the ceiling is NOT raised by humanTrigger', () => {
    // base 1s, zero failures → nextBackoffDelay = 1s, which is below the 5s
    // ceiling. Math.min must leave it at 1s (clamp DOWN only).
    initRestart(makeRestartDeps({ restartDelayS: 1 }))

    scheduleRestart('kvq_small', '/tmp/kvq-session', undefined, { humanTrigger: true })

    expect(capturedDelayMs).toBe(1 * 1000)
    expect(capturedDelayMs).toBeLessThan(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })
})

// ===========================================================================
// Required behavior 7 — one tested copy: server.ts takes the branch from the
// routing module and holds no copy of its own
//
// main() cannot run in a test, so this audits the comment-stripped source
// (see tests/start-sweep-wiring.test.ts) for wiring only. If the drop branch
// were re-inlined in server.ts, the behavioural tests above would keep passing
// against the module while production ran an untested copy. The routing's
// `notify` wiring is pinned in tests/server-startup-wiring.test.ts.
// ===========================================================================

describe('b.kvq (7) server.ts holds no copy of the lost-message branch', () => {
  const SERVER_SRC = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8')
  const SERVER_CODE = stripComments(SERVER_SRC)

  test('server.ts code builds no lost-message notice, decides no recovery state and has no human-triggered scheduleRestart call site', () => {
    expect(indicesOf(/\b(?:buildLostMessageNotice|decideLostMessageState)\b/g, SERVER_CODE)).toEqual([])
    expect(indicesOf(/not delivered/gi, SERVER_CODE)).toEqual([])
    expect(indicesOf(/\bhumanTrigger\b/g, SERVER_CODE)).toEqual([])
  })

  test('server.ts builds one persona-routing instance and gives it to the persona event router', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bcreatePersonaRouting\b[^}]*\}\s*from\s*['"]\.\/persona-routing\.ts['"]/,
    )
    const routing = [...SERVER_CODE.matchAll(/\bconst\s+(\w+)\s*=\s*createPersonaRouting\s*\(/g)]
    expect(routing).toHaveLength(1)
    expect(indicesOf(/\bcreatePersonaRouting\s*\(/g, SERVER_CODE)).toHaveLength(1)
    const router = SERVER_CODE.match(/\bcreatePersonaEventRouter\s*\(\s*\{[^}]*\}/)
    expect(router).not.toBeNull()
    expect(router![0]).toMatch(new RegExp(`\\brouting\\s*:\\s*${routing[0]![1]}\\b`))
  })

  test('server.ts never calls receive itself: inbound events reach the routing only through the event router', () => {
    // What the router hands `receive` (the receiving connection's key as the
    // only receiver) is driven end to end in
    // tests/persona-connection-wiring.test.ts.
    expect(indicesOf(/\.receive\s*\(/g, SERVER_CODE)).toEqual([])
  })

  test('the restart guard and the health check take the stream probe from the routing module', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bhasSessionStream\b[^}]*\}\s*from\s*['"]\.\/persona-routing\.ts['"]/,
    )
    // No local probe that could drift from the module's.
    expect(indicesOf(/(?:function|const|let)\s+hasSessionStream\w*\b/g, SERVER_CODE)).toEqual([])
    for (const init of ['initRestart', 'initHealthCheck']) {
      const block = SERVER_CODE.match(new RegExp(`\\b${init}\\(\\{[\\s\\S]*?\\n\\s*\\}\\)`))
      expect(block).not.toBeNull()
      expect(block![0]).toMatch(/\bhasSessionStream\s*(?:,|:\s*hasSessionStream\b)/)
    }
  })
})
