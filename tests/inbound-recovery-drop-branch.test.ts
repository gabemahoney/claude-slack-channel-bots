/**
 * inbound-recovery-drop-branch.test.ts — lost messages (b.av2 SR-4.6, SR-7.3,
 * SR-7.2 part; b.kvq and b.9cj recovery, keyed per persona). The AC 26
 * verifier: run `bun test -t "AC 26"` for its cases.
 *
 * A Slack message that qualifies for persona P but finds no live,
 * stream-bearing session (no session, a disconnected one, or one that has lost
 * its GET stream) is lost. The branch in src/persona-routing.ts asks whether P
 * is up (bug b.g57: a persona that is not up, such as one held for an
 * unresolvable claude_config_dir while its Slack connection serves, is never
 * restarted from here) and applies P's restart guards (a restart already
 * pending or running, auto-restart disabled, P at the restart-failure cap),
 * schedules a human-triggered restart of P only when none applies ("starting
 * now"), and raises one lost-message
 * notice at P's permission-prompt destination (a channel, or the DM with
 * `dm.contact`), through P's own client and under P's identity. The notice
 * names P, the sender and the recovery state, and never carries the message
 * text. Nothing is posted in the conversation the message came from. In
 * src/restart.ts, `scheduleRestart(…, { humanTrigger: true })` clamps the
 * backoff delay DOWN to HUMAN_TRIGGER_DELAY_CEILING (never up).
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
 * "lost", sender, one recovery state, no mention, no message text), never by
 * its full wording. The streamless branch's own cases are in
 * tests/dispatch-get-stream.test.ts; general delivery in
 * tests/persona-routing.test.ts.
 *
 * main() in src/server.ts cannot run in a test (startup gate, real port, real
 * Slack connections), so describe (7) audits its source for the wiring only:
 * server.ts hands inbound events to the routing module through the persona
 * event router and holds no copy of the branch.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  HUMAN_TRIGGER_DELAY_CEILING,
  RESTART_FAILURE_CAP,
} from '../src/restart.ts'
import { recordFailure, isAtCap } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import type { LostMessageState } from '../src/lost-message.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaRelaunchGate, createPersonaUpPredicate } from '../src/persona-start.ts'
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
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  resetRoutingState,
  stateOf,
  waitFor,
  LOST_MESSAGE_STATES,
  NEVER_FIRE_RESTART_DELAY_S,
  type RoutingHarness,
  type RoutingHarnessOptions,
} from './test-helpers/persona-routing-harness.ts'

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
  /** Keys whose bring-up outcome is not `up`, read by the up check at call time (with `upCheck` or `notUp`). */
  notUp: Set<string>
  /** Every key the routing asked the up check about, in order. */
  upAsks: string[]
  /** The bring-up outcomes the up check reads (`isUp`), for a relaunch gate over the same state. */
  outcomes: { isUp(key: string): boolean }
}

interface HarnessOptions {
  destination?: Destination
  branch?: Branch
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
  alphaStub?: StubSlackOptions
  resolveUserName?: RoutingHarnessOptions['resolveUserName']
  notify?: RoutingHarnessOptions['notify']
  /**
   * Give the routing the up check (bug b.g57): the real
   * `createPersonaUpPredicate` over a connection that serves for every
   * persona and a bring-up outcome that is `up` except for the keys in
   * `h.notUp`. Without it (and without `notUp`) the routing has no up check.
   */
  upCheck?: boolean
  /** Names whose bring-up is not `up` (held, as for an unresolvable claude_config_dir); implies `upCheck`. */
  notUp?: readonly string[]
}

/** A connection that serves: a persona held by its bring-up keeps it (b.g57). */
const SERVING: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0SERVING', botId: 'B0SERVING' } }

let dir: string
/** Every harness a case built (cleaned up and leak-checked in teardown). */
let harnesses: RoutingHarness[] = []
/** Launches held open by a case; released in teardown. */
let heldLaunches: Array<(ok: boolean) => void> = []

function makeHarness(opts: HarnessOptions = {}): Harness {
  const streamless = opts.branch === 'streamless'
  const notUp = new Set<string>()
  const upAsks: string[] = []
  const outcomes = { isUp: (key: string) => !notUp.has(key) }
  const isUp = createPersonaUpPredicate({ status: () => SERVING }, outcomes)
  const withUpCheck = opts.upCheck === true || opts.notUp !== undefined
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
      stubOptions: opts.alphaStub ? { alpha: opts.alphaStub } : undefined,
      resolveUserName: opts.resolveUserName,
      notify: opts.notify,
      isPersonaUp: withUpCheck
        ? (key) => {
          upAsks.push(key)
          return isUp(key)
        }
        : undefined,
    },
  )
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  for (const key of h.keys(opts.notUp ?? [])) notUp.add(key)
  const harness = Object.assign(h, {
    alpha,
    beta,
    deliver: (event: unknown, keys: string | readonly string[]) =>
      h.receiveKeys(event, typeof keys === 'string' ? [keys] : keys),
    notUp,
    upAsks,
    outcomes,
  })
  harnesses.push(harness)
  return harness
}

/** A launch outcome that stays pending until teardown, keeping the persona in flight. */
function holdLaunchOpen(): Promise<boolean> {
  return new Promise<boolean>((resolve) => { heldLaunches.push(resolve) })
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
  heldLaunches = []
  resetRoutingState()
})

afterEach(async () => {
  try {
    for (const h of harnesses) h.hold.cancelAll()
    // Let a held launch settle while restart.ts still has its deps.
    for (const release of heldLaunches) release(true)
    if (heldLaunches.length > 0) await Bun.sleep(1)
    // Every log line, post and notice the module produced is free of token material.
    assertNoLeak(harnesses.map((h) => h.captured()))
  } finally {
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
// AC 26 x SR-7.3 — the recovery state. Five states (not up, from bug b.g57,
// and the four restart-guard states) × a channel or `dm` destination, on the
// no-session branch. Each notice identifies its state and no other (so the
// five texts are pairwise distinct); only "starting now" schedules a launch.
// The four restart-guard rows run with no up check, so a routing without
// `isPersonaUp` counts every persona as up.
// ===========================================================================

/**
 * How each recovery state is arranged for the next lost message on the
 * no-session branch, and the launches there are once it is handled.
 */
const STATE_SETUPS: Record<LostMessageState, { opts: HarnessOptions; arrange(h: Harness): Promise<void> | void; launches: number }> = {
  // Bug b.g57: alpha's bring-up is held while its connection serves;
  // restart.ts itself would launch (fast delay) if it were asked.
  'not-up': { opts: { notUp: ['alpha'] }, arrange: () => {}, launches: 0 },
  // A launch of alpha is already in flight; a stacked one would make two.
  'restarting': {
    opts: { launchSession: holdLaunchOpen },
    arrange: async (h) => {
      scheduleRestart(h.alpha.key, h.alpha.working_directory, undefined, { humanTrigger: true })
      await waitFor(() => h.launches.length === 1)
      expect(h.launches).toHaveLength(1)
    },
    launches: 1,
  },
  'starting-now': { opts: {}, arrange: () => {}, launches: 1 },
  // restart.ts itself would launch (nonzero restart delay) if it were asked.
  'auto-restart-disabled': { opts: { sessionRestartDelay: 0 }, arrange: () => {}, launches: 0 },
  'restart-limit-reached': {
    opts: {},
    arrange: (h) => { for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(h.alpha.key) },
    launches: 0,
  },
}

describe('AC 26: the notice reports the recovery state', () => {
  const table: [LostMessageState, Destination][] = LOST_MESSAGE_STATES.flatMap((s) => (['channel', 'dm'] as const).map((d): [LostMessageState, Destination] => [s, d]))

  test.each(table)(
    'AC 26: state %s, a %s destination: one notice at the destination naming the sender and that state only, nothing in the source',
    async (state, destination) => {
      const setup = STATE_SETUPS[state]
      const h = makeHarness({ destination, ...setup.opts })
      await setup.arrange(h)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination, source: SHARED, sender: STUB_USER_NAME, state })
      await Bun.sleep(WAIT_MS) // a launch the message scheduled would have fired by now
      expect(h.launches).toHaveLength(setup.launches)
      for (const launch of h.launches) expect(launch).toEqual({ key: h.alpha.key, cwd: h.alpha.working_directory })
    },
  )
})

// ===========================================================================
// Bug b.g57 — a persona that is not up (its bring-up held, as for an
// unresolvable claude_config_dir) keeps its Slack connection, so its messages
// still arrive and are lost. Each one used to report "starting now" and ask
// for a restart the relaunch gate refused. Now the notice says "not up" and
// nothing is scheduled: its own recovery launches it. The up check is the
// real `createPersonaUpPredicate` over a serving connection; the production
// wiring (the routing gets the server's one `isPersonaUp`) is pinned in
// tests/server-startup-wiring.test.ts.
// ===========================================================================

describe('b.g57: a lost message for a persona that is not up starts no restart', () => {
  test.each(['no session', 'streamless'] as const)(
    'b.g57 REGRESSION: %s, alpha held with its connection serving: three messages each get exactly the not-up notice at the destination, no restart is asked for, scheduled or launched and nothing is delivered; once alpha is up, the next lost message starts now',
    async (branch) => {
      const h = makeHarness({ branch, notUp: ['alpha'] })
      // The relaunch gate over the same bring-up state: before the fix every
      // message asked it for a restart, and it refused with a line.
      const gateLines: string[] = []
      const deps = makeRestartDeps({ restartDelayS: FAST_DELAY_S })
      deps.canRestart = createPersonaRelaunchGate({ status: () => SERVING }, (line) => { gateLines.push(line) }, h.outcomes)
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

  test('b.g57: one message lost on both connections, beta up and alpha not up: beta reports starting now and is restarted, alpha reports not up and is not, each at its own destination', async () => {
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

  test('b.g57: the up check is asked with the persona\'s key, not its name', async () => {
    const asked: string[] = []
    const h = makeRoutingHarness([{ name: 'Held Persona', channels: [{ id: SHARED, delivery: 'all' }] }], dir, {
      sessions: [],
      restartDelayS: FAST_DELAY_S,
      isPersonaUp: (key) => {
        asked.push(key)
        return false
      },
    })
    harnesses.push(h)
    const held = h.config!.personas[0]!
    expect(held.key).not.toBe(held.name)

    await h.receiveKeys(messageIn(SHARED), [held.key])

    expect(asked).toEqual([held.key])
    expect(h.allPosts().map((p) => stateOf(p.text))).toEqual(['not-up'])
    expect(isRestartPendingOrActive(held.key)).toBe(false)
  })

  // An up persona passing the check to "starting now" is the beta side of the
  // two-persona case above; the AC 26 state table (no up check at all) fails
  // if an absent check counted as not up. This one row shows an up persona
  // still falls through to a later restart-guard state.
  test('b.g57: alpha up through the up check and at the restart-failure cap: the notice says restart limit reached and nothing launches', async () => {
    const setup = STATE_SETUPS['restart-limit-reached']
    const h = makeHarness({ ...setup.opts, upCheck: true })
    await setup.arrange(h)

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
    'AC 26: %s, the user-name lookup rejects: the human-triggered restart still starts and exactly one notice names the user ID, with one token-safe line',
    async (branch) => {
      const h = makeHarness({
        branch,
        resolveUserName: async () => { throw new Error(`users.info failed ${LEAK_SENTINEL}`) },
      })

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectOneLostNotice(h, { destination: 'channel', source: SHARED, sender: HUMAN, state: 'starting-now' })
      expect(h.notices).toHaveLength(1)
      const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
      expect(h.logs.filter((l) => l.includes(`user-name lookup for persona ${ref} failed, using the user ID`))).toHaveLength(1)
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
// Required behavior 3 — a second message while restarting does not stack
// ===========================================================================

describe('b.kvq (3) second message while restart pending/active does not stack a launch', () => {
  test('two messages in quick succession: a "starting now" notice, then a "restarting" notice', async () => {
    // SLOW delay keeps the first restart pending across the second message.
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(lostNotices(h)).toEqual([
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'starting-now' },
      { key: h.alpha.key, channel: ALPHA_HOME, state: 'restarting' },
    ])
    expectBetaUntouched(h)
  })

  test('while a launch is actively in flight, a new message does not stack another launch', async () => {
    // Hold launchSession open so the persona is in activeLaunches (not just a
    // pending timer) when the second message arrives.
    const h = makeHarness({ restartDelayS: FAST_DELAY_S, launchSession: holdLaunchOpen })

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await Bun.sleep(WAIT_MS) // timer fired; launchSession is now awaiting
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.launches).toHaveLength(1)

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await Bun.sleep(WAIT_MS) // a stacked timer would have fired by now

    // Still exactly one launch despite the second message.
    expect(h.launches).toHaveLength(1)
    expect(lostNotices(h).map((n) => n.state)).toEqual(['starting-now', 'restarting'])
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
    ['throws', () => { throw new Error(`notice sink failed ${LEAK_SENTINEL}`) }],
    ['rejects', async () => { throw new Error(`notice sink failed ${LEAK_SENTINEL}`) }],
  ])('a notice sink that %s is logged once naming the persona, token-safe and never thrown, and recovery still happens', async (_label, notify) => {
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S, notify })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.notices).toHaveLength(1)
    expect(h.allPosts()).toEqual([])
    const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
    expect(h.logs.filter((l) => l.includes(`lost-message notice for persona ${ref} failed`))).toHaveLength(1)
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
  const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')
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
