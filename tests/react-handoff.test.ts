/**
 * The `react` hand-off (SR-6.2, SR-6.5): B's winning `react` claim is read
 * detached, with B's client as captured, through preparation's shared lookup 2
 * and the real origin classifier, and handed to the other applied persona A's
 * `bot-tool` intake with the fields captured at the claim; `forget` and `stop`
 * cancel and drain it; a failed job writes one content-free line. The line's
 * builder is pinned once here, with its catalogue entries (SR-10.1, SR-10.2).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Persona } from '../src/config.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import type { BotToolReactionInput, BotToolReactionIntakeResult } from '../src/persona-routing.ts'
import {
  buildReactionHandoffFailedLine,
  createReactHandoff,
  REACTION_HANDOFF_FAILED,
  REACTION_HANDOFF_FAILURE_REASONS,
  type ReactHandoff,
  type ReactionHandoffFailure,
  type ReactionHandoffFailureReason,
} from '../src/react-handoff.ts'
import type { ReactClaimContext } from '../src/registry.ts'
import { SERVER_POST_EVENT_TYPE } from '../src/server-post.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage, withoutName } from './test-helpers/credentials.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { classHeading, requiredSection } from './test-helpers/markdown.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { asWebClient, makeDeferredWebApiCall, makeStubSlack, type DeferredWebApiCall, type SettledWebApiOutcome, type StubSlack } from './test-helpers/slack-stub.ts'

const CHANNEL = 'C0GENERAL'
const MESSAGE_TS = '1700000100.000100'
const THREAD_TS = '1700000050.000050'
const NEIGHBOR_TS = '1700000099.000099'
const EMOJI = 'white_check_mark'
/** Virtual time when B's claim arrives, and the event ts A's intake must get for it. */
const START_MS = 1700000000123
const START_EVENT_TS = '1700000000.123000'
const A_USER = 'U0ALPHABOT'
const B_USER = 'U0BETABOT'
const C_USER = 'U0GAMMABOT'
/** A, B and C, in the in-process fixture and the child process alike. */
const PERSONA_SPECS = [{ name: 'Alpha Bot' }, { name: 'Beta Bot' }, { name: 'Gamma Bot' }]
/** A request token of the UUIDv4 shape a permission action ID ends with. */
const REQUEST_TOKEN = '0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766'

/** Plain content markers the read passes over or a failure carries; no diagnostic may hold one. */
const MARKERS = { body: 'reacted-body-marker', block: 'block-text-marker', profile: 'Display Name Marker', file: 'file-name-marker', error: 'raw-error-marker' }

/** The reacted message as `conversations.replies` returns it: content beside the facts, `extra` over it. */
function post(author: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message', ts: MESSAGE_TS, thread_ts: THREAD_TS, text: `${MARKERS.body} ${LEAK_SENTINEL}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${MARKERS.block} ${LEAK_SENTINEL}` } }],
    user_profile: { real_name: MARKERS.profile }, files: [{ name: `${MARKERS.file} ${LEAK_SENTINEL}` }],
    ...(author === undefined ? {} : { user: author }), ...extra,
  }
}

const found = (...messages: Array<Record<string, unknown>>): SettledWebApiOutcome => ({ kind: 'ok', result: { messages } })

function held<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>(r => { settle = r })
  return { promise, resolve: (value: T) => settle(value) }
}

/** Whether `promise` has settled, read without awaiting it. */
function track(promise: Promise<unknown>): { done: boolean } {
  const t = { done: false }
  void promise.then(() => { t.done = true })
  return t
}

interface Intake { key: string; input: BotToolReactionInput }
type Role = 'beta' | 'gamma'

/** A, B and a third persona C, as applied at the start. */
interface Personas {
  alpha: Persona
  beta: Persona
  gamma: Persona
}

interface Fixture extends Personas {
  clock: FakeClock
  /** What getAppliedPersonas answers now. */
  applied: Persona[]
  /** Each persona's confirmed bot user now; a missing key is not serving. */
  identities: Map<string, string>
  stubs: Record<'alpha' | Role, StubSlack>
  /** Every intake call, its input copied when it was made. */
  intakes: Intake[]
  /** The intake's answer; `stored` unless a case sets its own. */
  answer: (key: string, input: BotToolReactionInput) => Promise<BotToolReactionIntakeResult>
  logs: string[]
  shuttingDown: boolean
  /** Settles whatever a case left held, so the owner can be stopped after it. */
  releases: Array<() => void>
  handoff: ReactHandoff
  claim(by?: Role, overrides?: Partial<ReactClaimContext>): ReactClaimContext
}

interface FixtureOptions {
  start?: number
  isShuttingDown?: () => boolean
  lookupTimeoutMs?: number
}

let BASE = ''
beforeAll(() => { BASE = mkdtempSync(join(tmpdir(), 'react-handoff-')) })
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

const open: Fixture[] = []

afterEach(async () => {
  for (const f of open.splice(0)) {
    const stopped = f.handoff.stop()
    for (const release of f.releases.splice(0)) release()
    await stopped
    await f.clock.flush()
    expect(f.clock.pendingCount()).toBe(0)
    assertNoLeak({ logs: f.logs, intakes: f.intakes })
    for (const marker of Object.values(MARKERS)) expect(f.logs.join('\n')).not.toContain(marker)
  }
})

function appliedPersonas(): Personas {
  const [alpha, beta, gamma] = makeMultiPersonaConfig(PERSONA_SPECS, BASE).personas as [Persona, Persona, Persona]
  return { alpha, beta, gamma }
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const clock = createFakeClock({ start: opts.start ?? START_MS })
  const { alpha, beta, gamma } = appliedPersonas()
  const stubs = { alpha: makeStubSlack({ leakMarker: LEAK_SENTINEL }), beta: makeStubSlack({ leakMarker: LEAK_SENTINEL }), gamma: makeStubSlack({ leakMarker: LEAK_SENTINEL }) }
  const users: Record<Role, string> = { beta: B_USER, gamma: C_USER }
  const f: Omit<Fixture, 'handoff'> & { handoff?: ReactHandoff } = {
    clock, alpha, beta, gamma, stubs,
    applied: [alpha, beta, gamma],
    identities: new Map([[alpha.key, A_USER], [beta.key, B_USER], [gamma.key, C_USER]]),
    intakes: [],
    answer: async () => ({ status: 'stored', seq: 1 }),
    logs: [],
    shuttingDown: false,
    releases: [],
    claim: (by = 'beta', overrides = {}) => ({
      persona: by === 'beta' ? beta : gamma, client: asWebClient(stubs[by].web), botUserId: users[by],
      chatId: CHANNEL, messageId: MESSAGE_TS, emoji: EMOJI, ...overrides,
    }),
  }
  f.handoff = createReactHandoff({
    getAppliedPersonas: () => f.applied,
    getBotIdentity: (key) => {
      const botUserId = f.identities.get(key)
      return botUserId === undefined ? undefined : { botUserId }
    },
    receiveBotToolReaction: (key, input) => {
      f.intakes.push({ key, input: structuredClone(input) })
      return f.answer(key, input)
    },
    clock,
    ...(opts.lookupTimeoutMs === undefined ? {} : { lookupTimeoutMs: opts.lookupTimeoutMs }),
    isShuttingDown: opts.isShuttingDown ?? (() => f.shuttingDown),
    log: (line) => { f.logs.push(line) },
  })
  open.push(f as Fixture)
  return f as Fixture
}

/** B's next read waits for the test; released with no message if the case leaves it held. */
function holdRead(f: Fixture, stub: StubSlack = f.stubs.beta): DeferredWebApiCall {
  const read = makeDeferredWebApiCall()
  stub.script.replies.push(read.outcome)
  f.releases.push(() => { if (!read.settled) read.settle(found()) })
  return read
}

/** The intake's next answers wait for the test; released as stored if the case leaves them held. */
function holdIntake(f: Fixture) {
  const gate = held<BotToolReactionIntakeResult>()
  f.answer = () => gate.promise
  f.releases.push(() => gate.resolve({ status: 'stored', seq: 9 }))
  return gate
}

/** What A's intake gets for B's claim, independently written: `overrides` over it. */
function handedOff(f: Personas, overrides: Partial<BotToolReactionInput> = {}): Intake {
  return {
    key: f.alpha.key,
    input: {
      change: 'added', reactorUserId: B_USER, reactorPersonaName: 'Beta Bot', emoji: EMOJI,
      channel: CHANNEL, messageTs: MESSAGE_TS, eventTs: START_EVENT_TS, messageAuthorUserId: A_USER, ...overrides,
    },
  }
}

/** The one line a failed job of B's (or C's) claim writes, through the exported builder. */
function failedLine(f: Personas, reason: ReactionHandoffFailureReason, opts: { receiver?: boolean; by?: Role } = {}): string {
  const reactor = opts.by === 'gamma' ? f.gamma : f.beta
  return buildReactionHandoffFailedLine({
    reactor: { key: reactor.key, name: reactor.name },
    ...(opts.receiver ? { receiver: { key: f.alpha.key, name: f.alpha.name } } : {}),
    chat_id: CHANNEL, message_ts: MESSAGE_TS, reason,
  })
}

const READ_ARGS = { channel: CHANNEL, ts: MESSAGE_TS, oldest: MESSAGE_TS, latest: MESSAGE_TS, inclusive: true, include_all_metadata: true }
const methods = (stub: StubSlack) => stub.callLog.map(c => c.method)

describe('the claim returns at once; the work runs on its own zero-delay timer', () => {
  test('building the owner starts nothing; the callback returns undefined and nothing is read before the timer fires', async () => {
    const f = makeFixture()
    expect(f.clock.pendingCount()).toBe(0)
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    expect(f.handoff.onReactClaimed(f.claim())).toBeUndefined()
    expect(f.clock.pending().map(t => t.delayMs)).toEqual([0])
    await f.clock.flush()
    expect({ calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ calls: [], intakes: [], logs: [] })
    await f.clock.advance(1)
    expect(methods(f.stubs.beta)).toEqual(['conversations.replies'])
    expect(f.intakes).toStrictEqual([handedOff(f)])
    expect(f.clock.pendingCount()).toBe(0)
  })
})

describe("the reacted message's origin and author decide the hand-off", () => {
  const PERMISSION_BUTTON = (f: Fixture) => ({ blocks: [{ type: 'actions', elements: [{ type: 'button', action_id: encodePermissionActionId('allow', `cscb_${f.alpha.key}`, REQUEST_TOKEN) }] }] })
  const AUTHORS: Array<[string, (f: Fixture) => Record<string, unknown>, 'alpha' | 'gamma' | null]> = [
    ["another applied persona's confirmed bot user wrote a Tool Post", () => post(A_USER), 'alpha'],
    ['the third applied persona wrote it: the hand-off goes to that persona', () => post(C_USER), 'gamma'],
    ['B wrote it, by the bot user captured with the claim', () => post(B_USER), null],
    ["B wrote it, by B's own persona's current identity", (f) => { f.identities.set(f.beta.key, 'U0BETANEW'); return post('U0BETANEW') }, null],
    ['a user that is no applied persona wrote it', () => post('U0HUMAN'), null],
    ['it has no author', () => post(undefined, { bot_id: 'B0WEBHOOK' }), null],
    ["A's bot user wrote it but A is not confirmed now", (f) => { f.identities.delete(f.alpha.key); return post(A_USER) }, null],
    ["A's bot user wrote it but A is not applied now", (f) => { f.applied = [f.beta, f.gamma]; return post(A_USER) }, null],
    ["A's Server Post, by the Server Post Marker", () => post(A_USER, { metadata: { event_type: SERVER_POST_EVENT_TYPE, event_payload: {} } }), null],
    ["A's Server Post, by an open permission prompt's decision button", (f) => post(A_USER, PERMISSION_BUTTON(f)), null],
  ]

  test.each(AUTHORS)('%s', async (_label, message, receiver) => {
    const f = makeFixture()
    // A neighbour A wrote, so only the exact-ts message can decide.
    f.stubs.beta.script.replies.push(found(post(A_USER, { ts: NEIGHBOR_TS }), message(f)))
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    const expected = receiver === 'alpha' ? [handedOff(f)]
      : receiver === 'gamma' ? [{ key: f.gamma.key, input: handedOff(f, { messageAuthorUserId: C_USER }).input }]
      : []
    expect(f.intakes).toStrictEqual(expected)
    expect(f.logs).toEqual([])
    expect(f.stubs.beta.calls.conversationsReplies).toStrictEqual([READ_ARGS])
    expect(methods(f.stubs.beta)).toEqual(['conversations.replies'])
    expect([...f.stubs.alpha.callLog, ...f.stubs.gamma.callLog]).toEqual([])
    expect(f.clock.pendingCount()).toBe(0)
  })
})

describe('the hand-off carries what was captured at the claim', () => {
  test('one whole snapshot: the claim, B and the clock all change after the callback, and the intake still gets the claim as it was', async () => {
    const f = makeFixture()
    const read = holdRead(f)
    const intake = holdIntake(f)
    const claim = f.claim()
    f.handoff.onReactClaimed(claim)
    // After the callback: B's persona renamed in place, B's identity replaced, every claim field and the client swapped.
    Object.assign(claim.persona, { name: 'Beta Renamed' })
    f.identities.set(f.beta.key, 'U0BETANEW')
    Object.assign(claim, { persona: f.gamma, client: asWebClient(f.stubs.gamma.web), botUserId: 'U0BETANEW', chatId: 'C0OTHER', messageId: NEIGHBOR_TS, emoji: 'x' })
    await f.clock.advance(1)
    expect(f.stubs.beta.calls.conversationsReplies).toStrictEqual([READ_ARGS])
    expect(f.stubs.gamma.callLog).toEqual([])
    await f.clock.advance(NAME_LOOKUP_TIMEOUT_MS - 2)
    read.settle(found(post(A_USER)))
    await f.clock.flush()
    expect(f.intakes).toStrictEqual([handedOff(f)])
    await f.clock.advance(60_000)
    intake.resolve({ status: 'stored', seq: 4 })
    await f.clock.flush()
    expect(f.intakes).toStrictEqual([handedOff(f)])
    expect(f.logs).toEqual([])
  })

  test("B's identity already replaced when the claim arrives: the intake gets the claim's paired bot user, not B's current one", async () => {
    const f = makeFixture()
    f.identities.set(f.beta.key, 'U0BETANEW')
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.intakes).toStrictEqual([handedOff(f)])
    expect(f.logs).toEqual([])
  })

  test.each([
    ['whole seconds pad six zeros', 1700000000000, '1700000000.000000'],
    ['one millisecond is a thousand microseconds', 1700000000007, '1700000000.007000'],
    ['tens of milliseconds keep their leading zero', 1700000000050, '1700000000.050000'],
    ["a second's last millisecond", 1700000000999, '1700000000.999000'],
  ] as const)('the event ts is the observed time: %s', async (_label, start, eventTs) => {
    const f = makeFixture({ start })
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.intakes).toStrictEqual([handedOff(f, { eventTs })])
  })

  test('claims a millisecond apart cross the second; two in the same millisecond keep that time', async () => {
    const f = makeFixture({ start: 1700000000999 })
    f.stubs.beta.script.replies.push(found(post(A_USER)), found(post(A_USER)), found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim('beta', { emoji: 'one' }))
    await f.clock.advance(1)
    f.handoff.onReactClaimed(f.claim('beta', { emoji: 'two' }))
    f.handoff.onReactClaimed(f.claim('beta', { emoji: 'three' }))
    await f.clock.advance(1)
    expect(f.intakes.map(i => [i.input.emoji, i.input.eventTs]).sort()).toEqual([
      ['one', '1700000000.999000'],
      ['three', '1700000001.000000'],
      ['two', '1700000001.000000'],
    ])
  })

  test.each([
    ['A leaves the applied personas', () => {}, (f: Fixture) => { f.applied = [f.beta, f.gamma] }, false],
    ["A's confirmed identity is replaced", () => {}, (f: Fixture) => { f.identities.set(f.alpha.key, 'U0ALPHANEW') }, false],
    ['A stops serving', () => {}, (f: Fixture) => { f.identities.delete(f.alpha.key) }, false],
    ['A is applied only once the read is under way', (f: Fixture) => { f.applied = [f.beta, f.gamma] }, (f: Fixture) => { f.applied = [f.alpha, f.beta, f.gamma] }, true],
  ] as const)('A is resolved from the facts in effect after the read: %s', async (_label, before, during, handed) => {
    const f = makeFixture()
    before(f)
    const read = holdRead(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    during(f)
    read.settle(found(post(A_USER)))
    await f.clock.flush()
    expect(f.intakes).toStrictEqual(handed ? [handedOff(f)] : [])
    expect(f.logs).toEqual([])
  })
})

describe('a failed job writes one content-free line and brings nothing else', () => {
  const rawError = (label: string) => Object.assign(new Error(`${MARKERS.error} ${sentinelInMessage(label)}`), { data: { error: 'internal_error', token: fakeToken(BOT_TOKEN_PREFIX, label) } })
  const FAILURES: Array<[string, ReactionHandoffFailureReason, boolean, (f: Fixture) => void]> = [
    ["B's read rejects", 'read-failed', false, (f) => f.stubs.beta.script.replies.push({ kind: 'reject', value: rawError('replies') })],
    ["Slack refuses B's read", 'read-failed', false, (f) => f.stubs.beta.script.replies.push({ kind: 'platform', error: 'not_in_channel' })],
    ["B's read answers with no message list", 'read-failed', false, (f) => f.stubs.beta.script.replies.push({ kind: 'ok', result: { messages: MARKERS.body } })],
    ["B's read never answers", 'read-timeout', false, (f) => f.stubs.beta.script.replies.push({ kind: 'never' })],
    ['no returned message has the reacted ts', 'message-missing', false, (f) => f.stubs.beta.script.replies.push(found(post(A_USER, { ts: NEIGHBOR_TS })))],
    ["A's intake rejects", 'handoff-rejected', true, (f) => {
      f.stubs.beta.script.replies.push(found(post(A_USER)))
      f.answer = async () => { throw rawError('intake') }
    }],
    ["A's intake answers store-failed", 'store-failed', true, (f) => {
      f.stubs.beta.script.replies.push(found(post(A_USER)))
      f.answer = async () => ({ status: 'store-failed' })
    }],
    ["A's intake answers outside its closed set", 'internal-failed', true, (f) => {
      f.stubs.beta.script.replies.push(found(post(A_USER)))
      f.answer = async () => ({ status: MARKERS.error }) as unknown as BotToolReactionIntakeResult
    }],
  ]

  test.each(FAILURES)('%s: one %s line, no retry, no notice, no post', async (_label, reason, receiver, arrange) => {
    const f = makeFixture()
    arrange(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect(f.logs).toEqual([failedLine(f, reason, { receiver })])
    expect(f.intakes).toStrictEqual(receiver ? [handedOff(f)] : [])
    await f.clock.advance(10 * NAME_LOOKUP_TIMEOUT_MS)
    expect({ lines: f.logs.length, intakes: f.intakes.length, timers: f.clock.pendingCount() }).toStrictEqual({ lines: 1, intakes: receiver ? 1 : 0, timers: 0 })
    expect(methods(f.stubs.beta)).toEqual(['conversations.replies'])
    expect([...f.stubs.alpha.callLog, ...f.stubs.gamma.callLog]).toEqual([])
  })

  test('a supplied read bound replaces the default: the read times out at it, with one read-timeout line', async () => {
    const f = makeFixture({ lookupTimeoutMs: 250 })
    f.stubs.beta.script.replies.push({ kind: 'never' })
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.clock.pending().map(t => t.delayMs)).toEqual([250])
    await f.clock.advance(250)
    expect({ logs: f.logs, intakes: f.intakes, timers: f.clock.pendingCount() }).toStrictEqual({ logs: [failedLine(f, 'read-timeout')], intakes: [], timers: 0 })
  })

  test.each([
    ["A's Tool Post", found(post(A_USER))],
    ['a Slack failure', { kind: 'platform', error: 'internal_error' }],
  ] as Array<[string, SettledWebApiOutcome]>)('a read answering after its bound with %s neither hands off nor writes a second line', async (_label, late) => {
    const f = makeFixture()
    const read = holdRead(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect(f.logs).toEqual([failedLine(f, 'read-timeout')])
    read.settle(late)
    await f.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect({ logs: f.logs, intakes: f.intakes }).toStrictEqual({ logs: [failedLine(f, 'read-timeout')], intakes: [] })
  })

  test.each([
    { status: 'stored', seq: 3 },
    { status: 'duplicate', seq: 3 },
    { status: 'dropped' },
  ] as BotToolReactionIntakeResult[])('an intake answering $status is a normal outcome: no line', async (answer) => {
    const f = makeFixture()
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.answer = async () => answer
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ intakes: f.intakes, logs: f.logs }).toStrictEqual({ intakes: [handedOff(f)], logs: [] })
  })
})

/**
 * The timer callback runs the job fire-and-forget, so a throw that escaped it
 * would show only as an unhandled rejection. These cases run in a child `bun`
 * process (`runInFakeHome`: temp HOME and state dir, no token variables, a
 * bounded run) that counts unhandled rejections with its own listener and
 * prints one `RESULT::` JSON line. The child builds the same owner as the
 * in-process fixture: the real module, a fake clock, B's stub client and the
 * three personas, with one seam that throws.
 */
describe('a throwing logger, scheduler or clock read escapes neither synchronously nor as an unhandled rejection', () => {
  const MODULE_PATH = join(import.meta.dir, '..', 'src', 'react-handoff.ts')
  const REPO_ROOT = join(import.meta.dir, '..')
  const CHILD_TIMEOUT_MS = 20_000

  const CHILD = `
    const R = input.root
    const { createFakeClock } = await import(R + '/tests/test-helpers/fake-clock.ts')
    const { asWebClient, makeStubSlack } = await import(R + '/tests/test-helpers/slack-stub.ts')
    const { makeMultiPersonaConfig } = await import(R + '/tests/test-helpers/persona-config.ts')
    const { BOT_TOKEN_PREFIX, LEAK_SENTINEL, fakeToken, sentinelInMessage } = await import(R + '/tests/test-helpers/credentials.ts')

    // Recorded by type only: a reason's message could hold the sentinel.
    const rejections = []
    process.on('unhandledRejection', (reason) => { rejections.push(reason instanceof Error ? reason.name : typeof reason) })

    const clock = createFakeClock({ start: input.start })
    const [alpha, beta, gamma] = makeMultiPersonaConfig(input.specs, input.personaDir).personas
    const identities = new Map([[alpha.key, input.users.alpha], [beta.key, input.users.beta], [gamma.key, input.users.gamma]])
    const stub = makeStubSlack({ leakMarker: LEAK_SENTINEL })
    const thrown = (label) => new Error(sentinelInMessage(label))
    const clocks = {
      logger: clock,
      scheduler: { now: () => clock.now(), setTimeout: () => { throw thrown('timer') }, clearTimeout: (h) => clock.clearTimeout(h) },
      'clock-read': { now: () => { throw thrown('now') }, setTimeout: (cb, ms) => clock.setTimeout(cb, ms), clearTimeout: (h) => clock.clearTimeout(h) },
    }
    const intakes = []
    const lines = []
    let logAttempts = 0
    const handoff = mod.createReactHandoff({
      getAppliedPersonas: () => [alpha, beta, gamma],
      getBotIdentity: (key) => identities.has(key) ? { botUserId: identities.get(key) } : undefined,
      receiveBotToolReaction: async (key, reaction) => { intakes.push({ key, input: structuredClone(reaction) }); return { status: 'stored', seq: 1 } },
      clock: clocks[input.scenario],
      isShuttingDown: () => false,
      log: (line) => {
        logAttempts++
        if (input.scenario === 'logger') throw thrown('log')
        lines.push(line)
      },
    })
    const claim = () => {
      try {
        const returned = handoff.onReactClaimed({ persona: beta, client: asWebClient(stub.web), botUserId: input.users.beta, chatId: input.channel, messageId: input.messageTs, emoji: input.emoji })
        return { threw: false, returned: typeof returned }
      } catch {
        return { threw: true }
      }
    }
    // Two macrotask turns, so a rejection left unhandled reaches the listener.
    const turns = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) }
    const snapshot = () => ({ logAttempts, rejections: rejections.length, intakes: intakes.length, reads: stub.callLog.length, timers: clock.pendingCount() })

    const result = { claims: [], snapshots: [] }
    if (input.scenario === 'logger') {
      // The first job's read rejects, so its failure line goes to the throwing logger.
      const raw = Object.assign(new Error(input.errorMarker + ' ' + sentinelInMessage('replies')), { data: { error: 'internal_error', token: fakeToken(BOT_TOKEN_PREFIX, 'replies') } })
      stub.script.replies.push({ kind: 'reject', value: raw })
      result.claims.push(claim())
      await clock.advance(1)
      await turns()
      result.snapshots.push(snapshot())
    }
    stub.script.replies.push(input.found)
    result.claims.push(claim())
    await clock.advance(1 + input.boundMs)
    await turns()
    result.snapshots.push(snapshot())
    await handoff.stop()
    await clock.flush()
    await turns()
    result.final = snapshot()
    result.rejectionTypes = rejections
    result.lines = lines
    result.intakes = intakes
    result.methods = stub.callLog.map((c) => c.method)
    process.stdout.write('RESULT::' + JSON.stringify(result) + '\\n')
  `

  interface Snapshot { logAttempts: number; rejections: number; intakes: number; reads: number; timers: number }
  interface ChildResult {
    claims: Array<{ threw: boolean; returned?: string }>
    snapshots: Snapshot[]
    final: Snapshot
    rejectionTypes: string[]
    lines: string[]
    intakes: Intake[]
    methods: string[]
  }

  function runScenario(scenario: 'logger' | 'scheduler' | 'clock-read'): ChildResult {
    const home = mkdtempSync(join(tmpdir(), 'react-handoff-home-'))
    try {
      const res = runInFakeHome({
        modulePath: MODULE_PATH,
        call: CHILD,
        input: {
          scenario, root: REPO_ROOT, personaDir: join(home, 'personas'), specs: PERSONA_SPECS,
          users: { alpha: A_USER, beta: B_USER, gamma: C_USER }, start: START_MS, boundMs: NAME_LOOKUP_TIMEOUT_MS,
          channel: CHANNEL, messageTs: MESSAGE_TS, emoji: EMOJI, found: found(post(A_USER)), errorMarker: MARKERS.error,
        },
        home,
        stateDir: join(home, 'state'),
        timeoutMs: CHILD_TIMEOUT_MS,
      })
      expect(res.observedHomedir).toBe(home)
      expect(res.stderr).toBe('')
      expect(res.status).toBe(0)
      const line = res.stdout.split('\n').find(l => l.startsWith('RESULT::'))
      expect(line).toBeDefined()
      assertNoLeak({ stdout: res.stdout, stderr: res.stderr }, `child ${scenario}`)
      const result = JSON.parse(line!.slice('RESULT::'.length)) as ChildResult
      for (const marker of Object.values(MARKERS)) expect(result.lines.join('\n')).not.toContain(marker)
      return result
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  const returned = { threw: false, returned: 'undefined' }

  test("a logger throwing on a failed job's line: no rejection, one attempt, and the next claim is still handed off", () => {
    const r = runScenario('logger')
    const failedAttempt = { logAttempts: 1, rejections: 0, intakes: 0, reads: 1, timers: 0 }
    const handed = { logAttempts: 1, rejections: 0, intakes: 1, reads: 2, timers: 0 }
    expect(r).toStrictEqual({
      claims: [returned, returned],
      snapshots: [failedAttempt, handed],
      final: handed,
      rejectionTypes: [],
      lines: [],
      intakes: [handedOff(appliedPersonas(), { eventTs: '1700000000.124000' })],
      methods: ['conversations.replies', 'conversations.replies'],
    })
  }, 2 * CHILD_TIMEOUT_MS)

  test.each(['scheduler', 'clock-read'] as const)('a throwing %s: the callback returns, no rejection, and the job fails once as internal-failed and reads nothing', (scenario) => {
    const r = runScenario(scenario)
    const failed = { logAttempts: 1, rejections: 0, intakes: 0, reads: 0, timers: 0 }
    expect(r).toStrictEqual({
      claims: [returned],
      snapshots: [failed],
      final: failed,
      rejectionTypes: [],
      lines: [failedLine(appliedPersonas(), 'internal-failed')],
      intakes: [],
      methods: [],
    })
  }, 2 * CHILD_TIMEOUT_MS)
})

describe('forget and stop cancel what has not reached an intake, and stop drains what has', () => {
  test("forget(B) before the timer fires: no read, no line, no timer left", async () => {
    const f = makeFixture()
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    f.handoff.forget(f.beta.key)
    expect(f.clock.pendingCount()).toBe(0)
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ calls: [], intakes: [], logs: [] })
  })

  test("forget(B) during the read ends it and its bound at once; a late answer brings nothing", async () => {
    const f = makeFixture()
    const read = holdRead(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    f.handoff.forget(f.beta.key)
    f.handoff.forget(f.beta.key)
    await f.clock.flush()
    expect(f.clock.pendingCount()).toBe(0)
    read.settle(found(post(A_USER)))
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ intakes: f.intakes, logs: f.logs }).toStrictEqual({ intakes: [], logs: [] })
  })

  test("forget(A) once A's intake has the reaction silences the outcome but does not retract it", async () => {
    const f = makeFixture()
    const intake = holdIntake(f)
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.intakes).toStrictEqual([handedOff(f)])
    f.handoff.forget(f.alpha.key)
    intake.resolve({ status: 'store-failed' })
    await f.clock.flush()
    expect({ intakes: f.intakes, logs: f.logs }).toStrictEqual({ intakes: [handedOff(f)], logs: [] })
  })

  test("one persona's held read, and its forget, neither block nor cancel a sibling's hand-off", async () => {
    const f = makeFixture()
    const bRead = holdRead(f, f.stubs.beta)
    const cRead = holdRead(f, f.stubs.gamma)
    f.handoff.onReactClaimed(f.claim('beta'))
    f.handoff.onReactClaimed(f.claim('gamma'))
    await f.clock.advance(1)
    cRead.settle(found(post(A_USER)))
    await f.clock.flush()
    const fromC = (eventTs: string) => handedOff(f, { reactorUserId: C_USER, reactorPersonaName: 'Gamma Bot', eventTs })
    expect(f.intakes).toStrictEqual([fromC(START_EVENT_TS)])
    const cRead2 = holdRead(f, f.stubs.gamma)
    f.handoff.onReactClaimed(f.claim('gamma'))
    await f.clock.advance(1)
    f.handoff.forget(f.beta.key)
    expect(f.clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    cRead2.settle(found(post(A_USER)))
    bRead.settle(found(post(A_USER)))
    await f.clock.flush()
    expect(f.intakes).toStrictEqual([fromC(START_EVENT_TS), fromC('1700000000.124000')])
    expect(f.logs).toEqual([])
    expect(f.stubs.beta.calls.conversationsReplies).toStrictEqual([READ_ARGS])
  })

  test('a shutdown already under way at the claim admits nothing: no timer, read or line', async () => {
    const f = makeFixture()
    f.shuttingDown = true
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    expect(f.clock.pendingCount()).toBe(0)
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ calls: [], intakes: [], logs: [] })
  })

  test('a shutdown query that throws counts as shutting down', async () => {
    const f = makeFixture({ isShuttingDown: () => { throw new Error(sentinelInMessage('shutdown')) } })
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    expect(() => f.handoff.onReactClaimed(f.claim())).not.toThrow()
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ timers: f.clock.pendingCount(), calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ timers: 0, calls: [], intakes: [], logs: [] })
  })

  test('a shutdown starting before the timer fires: no read', async () => {
    const f = makeFixture()
    f.stubs.beta.script.replies.push(found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    f.shuttingDown = true
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ calls: [], intakes: [], logs: [] })
  })

  test('a shutdown starting during the read: no intake and no line', async () => {
    const f = makeFixture()
    const read = holdRead(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    f.shuttingDown = true
    read.settle(found(post(A_USER)))
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ intakes: f.intakes, logs: f.logs }).toStrictEqual({ intakes: [], logs: [] })
  })

  test('stop before the timer fires cancels the job and settles; a later claim is not admitted', async () => {
    const f = makeFixture()
    f.stubs.beta.script.replies.push(found(post(A_USER)), found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    const stopped = track(f.handoff.stop())
    expect(f.clock.pendingCount()).toBe(0)
    await f.clock.flush()
    expect(stopped.done).toBe(true)
    f.handoff.onReactClaimed(f.claim())
    expect(f.clock.pendingCount()).toBe(0)
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ calls: f.stubs.beta.callLog, intakes: f.intakes, logs: f.logs }).toStrictEqual({ calls: [], intakes: [], logs: [] })
  })

  test('stop during the read ends it and its bound and settles at once; a late answer brings nothing', async () => {
    const f = makeFixture()
    const read = holdRead(f)
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    const stopped = track(f.handoff.stop())
    await f.clock.flush()
    expect({ done: stopped.done, timers: f.clock.pendingCount() }).toStrictEqual({ done: true, timers: 0 })
    read.settle(found(post(A_USER)))
    await f.clock.advance(1 + NAME_LOOKUP_TIMEOUT_MS)
    expect({ intakes: f.intakes, logs: f.logs }).toStrictEqual({ intakes: [], logs: [] })
  })

  test('stop with an intake already invoked: no new claim is admitted, and it settles only once that intake does, which it neither cancels nor repeats', async () => {
    const f = makeFixture()
    const intake = holdIntake(f)
    f.stubs.beta.script.replies.push(found(post(A_USER)), found(post(A_USER)))
    f.handoff.onReactClaimed(f.claim())
    await f.clock.advance(1)
    expect(f.intakes).toStrictEqual([handedOff(f)])
    const stopped = track(f.handoff.stop())
    f.handoff.onReactClaimed(f.claim())
    expect(f.clock.pendingCount()).toBe(0)
    await f.clock.advance(10 * NAME_LOOKUP_TIMEOUT_MS)
    expect({ done: stopped.done, intakes: f.intakes.length, reads: f.stubs.beta.callLog.length }).toStrictEqual({ done: false, intakes: 1, reads: 1 })
    intake.resolve({ status: 'stored', seq: 2 })
    await f.clock.flush()
    expect({ done: stopped.done, intakes: f.intakes, logs: f.logs }).toStrictEqual({ done: true, intakes: [handedOff(f)], logs: [] })
  })
})

const B_REF = { key: 'beta_bot', name: 'Beta Bot' }
const A_REF = { key: 'alpha_bot', name: 'Alpha Bot' }
const WHERE = { chat_id: CHANNEL, message_ts: MESSAGE_TS }
const WHERE_TEXT = `chat_id=${JSON.stringify(CHANNEL)} message_ts=${JSON.stringify(MESSAGE_TS)}`

describe('pins: the one place the reaction-handoff-failed label and line spelling are written out', () => {
  test('the label and the closed reasons', () => {
    expect(REACTION_HANDOFF_FAILED).toBe('reaction-handoff-failed')
    expect([...REACTION_HANDOFF_FAILURE_REASONS]).toEqual(['read-failed', 'read-timeout', 'message-missing', 'handoff-rejected', 'store-failed', 'internal-failed'])
  })

  test('lines', () => {
    const lines = [
      buildReactionHandoffFailedLine({ reactor: B_REF, receiver: A_REF, ...WHERE, reason: 'store-failed' }),
      buildReactionHandoffFailedLine({ reactor: { key: 'beta_bot' }, ...WHERE, reason: 'read-timeout' }),
    ]
    expect(lines).toEqual([
      '[slack] reaction-handoff-failed: persona="Beta Bot" (key=beta_bot) receiver="Alpha Bot" (key=alpha_bot) chat_id="C0GENERAL" message_ts="1700000100.000100" reason=store-failed',
      '[slack] reaction-handoff-failed: persona=beta_bot chat_id="C0GENERAL" message_ts="1700000100.000100" reason=read-timeout',
    ])
    assertNoLeak(lines)
  })
})

describe('buildReactionHandoffFailedLine', () => {
  test.each([...REACTION_HANDOFF_FAILURE_REASONS])('reason %s: named or key-only references, and the receiver only when given', (reason) => {
    const lines = [
      buildReactionHandoffFailedLine({ reactor: B_REF, receiver: A_REF, ...WHERE, reason }),
      buildReactionHandoffFailedLine({ reactor: { key: B_REF.key }, receiver: { key: A_REF.key }, ...WHERE, reason }),
      buildReactionHandoffFailedLine({ reactor: B_REF, ...WHERE, reason }),
    ]
    expect(lines).toEqual([
      `[slack] ${REACTION_HANDOFF_FAILED}: persona=${renderPersonaRef(B_REF.name, B_REF.key)} receiver=${renderPersonaRef(A_REF.name, A_REF.key)} ${WHERE_TEXT} reason=${reason}`,
      `[slack] ${REACTION_HANDOFF_FAILED}: persona=${B_REF.key} receiver=${A_REF.key} ${WHERE_TEXT} reason=${reason}`,
      `[slack] ${REACTION_HANDOFF_FAILED}: persona=${renderPersonaRef(B_REF.name, B_REF.key)} ${WHERE_TEXT} reason=${reason}`,
    ])
    assertNoLeak(lines)
  })

  test('external fields stay on one line, with tokens and URLs redacted', () => {
    const line = buildReactionHandoffFailedLine({
      reactor: B_REF, receiver: A_REF, reason: 'read-failed',
      chat_id: `C0GENERAL\r\n[slack] forged line ${fakeToken(BOT_TOKEN_PREFIX, 'chat')}`,
      message_ts: `1700000100.000100\u2028https://files.slack.com/files-pri/T0/F0/x?pub_secret=${LEAK_SENTINEL}`,
    })
    expect(line.split(/[\r\n\u2028\u2029]/)).toHaveLength(1)
    expect(line).toStartWith(`[slack] ${REACTION_HANDOFF_FAILED}: persona=${renderPersonaRef(B_REF.name, B_REF.key)} receiver=${renderPersonaRef(A_REF.name, A_REF.key)} chat_id="C0GENERAL`)
    expect(line).toContain(REDACTED_TOKEN_PLACEHOLDER)
    expect(line).toContain(REDACTED_URL_PLACEHOLDER)
    expect(line).toEndWith(' reason=read-failed')
    assertNoLeak(line)
  })

  test('only the failure reaches the line: planted content, emoji and errors never do', () => {
    const planted = {
      reactor: { ...B_REF, botUserId: B_USER }, receiver: A_REF, ...WHERE, reason: 'handoff-rejected',
      text: `${MARKERS.body} ${LEAK_SENTINEL}`, emoji: 'emoji-marker', user_profile: { real_name: MARKERS.profile },
      error: new Error(`${MARKERS.error} ${sentinelInMessage('intake')}`),
    } as ReactionHandoffFailure
    const line = buildReactionHandoffFailedLine(planted)
    expect(line).toBe(buildReactionHandoffFailedLine({ reactor: B_REF, receiver: A_REF, ...WHERE, reason: 'handoff-rejected' }))
    for (const marker of [...Object.values(MARKERS), 'emoji-marker', B_USER]) expect(line).not.toContain(marker)
    assertNoLeak(line)
  })

  test.each(['reactor', 'receiver'] as const)('a token-shaped %s persona name appears as configured and leaks nothing else', (role) => {
    const name = fakeToken(BOT_TOKEN_PREFIX, 'persona-name')
    const key = personaKey(name)
    const shaped = { key, name }
    const line = buildReactionHandoffFailedLine({ reactor: role === 'reactor' ? shaped : B_REF, receiver: role === 'receiver' ? shaped : A_REF, ...WHERE, reason: 'store-failed' })
    const refs = role === 'reactor'
      ? `persona=${renderPersonaRef(name, key)} receiver=${renderPersonaRef(A_REF.name, A_REF.key)}`
      : `persona=${renderPersonaRef(B_REF.name, B_REF.key)} receiver=${renderPersonaRef(name, key)}`
    expect(line).toBe(`[slack] ${REACTION_HANDOFF_FAILED}: ${refs} ${WHERE_TEXT} reason=store-failed`)
    expect(line).not.toContain(REDACTED_TOKEN_PLACEHOLDER)
    assertNoLeak(withoutName(line, name, key))
  })

  test('a persona name with quotes, control characters and a URL keeps its JSON-quoted configured form on one line', () => {
    const name = 'Ops "Night"\r\nDesk\t\\ https://ops.example.test/desk'
    const key = personaKey(name)
    const line = buildReactionHandoffFailedLine({ reactor: { key, name }, ...WHERE, reason: 'message-missing' })
    expect(line).toBe(`[slack] ${REACTION_HANDOFF_FAILED}: persona=${renderPersonaRef(name, key)} ${WHERE_TEXT} reason=message-missing`)
    expect(line.split(/[\r\n]/)).toHaveLength(1)
    expect(line).not.toContain(REDACTED_URL_PLACEHOLDER)
  })

  test.each(['reactor', 'receiver'] as const)('a %s persona name holding U+2028, U+2029, a C1 control and DEL is escaped onto one line, as configured and unredacted', (role) => {
    const name = 'Ops\u2028[slack] forged\u2029Night\u0085Desk\u007fBot'
    const key = personaKey(name)
    const escaped = `"Ops\\u2028[slack] forged\\u2029Night\\u0085Desk\\u007fBot" (key=${key})`
    const shaped = { key, name }
    const line = buildReactionHandoffFailedLine({ reactor: role === 'reactor' ? shaped : B_REF, receiver: role === 'receiver' ? shaped : A_REF, ...WHERE, reason: 'read-failed' })
    const refs = role === 'reactor'
      ? `persona=${escaped} receiver=${renderPersonaRef(A_REF.name, A_REF.key)}`
      : `persona=${renderPersonaRef(B_REF.name, B_REF.key)} receiver=${escaped}`
    expect(line).toBe(`[slack] ${REACTION_HANDOFF_FAILED}: ${refs} ${WHERE_TEXT} reason=read-failed`)
    // C0 and C1 controls, DEL and the two Unicode separators.
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
  })
})

describe('catalogue entries in the same change (SR-10.2)', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..')
  const SKILL_FILE = 'skills/debug-slack-channel-bots/SKILL.md'
  const ARCHITECTURE_FILE = 'docs/architecture.md'
  const read = (file: string) => readFileSync(resolve(REPO_ROOT, file), 'utf-8')

  test(`the debugging skill has a ${REACTION_HANDOFF_FAILED} entry quoting its line`, () => {
    expect(requiredSection(read(SKILL_FILE), classHeading(REACTION_HANDOFF_FAILED), SKILL_FILE)).toContain(`[slack] ${REACTION_HANDOFF_FAILED}:`)
  })

  test(`the architecture Logging section lists the ${REACTION_HANDOFF_FAILED} line`, () => {
    expect(requiredSection(read(ARCHITECTURE_FILE), '## Logging', ARCHITECTURE_FILE)).toContain(`\`[slack] ${REACTION_HANDOFF_FAILED}:`)
  })
})
