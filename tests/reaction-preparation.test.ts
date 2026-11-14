/**
 * Reaction Item preparation (SR-5.2 to SR-5.5): the decision under the mode
 * stored with the item, over normalized facts, and the three bounded lookups
 * on the receiving persona's own client that supply those facts; a bot-tool
 * item's reactor name is the one stored with it.
 */
import { SERVER_POST_METADATA } from './test-helpers/server-post.ts'
import { describe, expect, spyOn, test } from 'bun:test'
import type { WebClient } from '@slack/web-api'
import type { ChannelMode } from '../src/config.ts'
import { isQueueRecord, type ReactionAcceptedRecord } from '../src/delivery-queue.ts'
import {
  decideReactionPreparation,
  lookupReactionMessage,
  lookupReactionPreparation,
  type ReactionConversationFacts,
  type ReactionConversationKind,
  type ReactionMessageFacts,
  type ReactionMessageRead,
  type ReactionPreparationDecision,
} from '../src/reaction-preparation.ts'
import { NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { asWebClient, makeDeferredWebApiCall, makeStubSlack, type SettledWebApiOutcome, type StubSlack, type WebApiOutcome } from './test-helpers/slack-stub.ts'

const CHANNEL = 'C0GENERAL'
const REACTED_TS = '1700000100.000100'
const EVENT_TS = '1700000300.000300'
const ROOT_TS = '1700000050.000050'
const NEIGHBOR_TS = '1700000099.000099'
/** Message content a lookup reads past; it carries the sentinel so a leak of it fails assertNoLeak. */
const BODY = `reacted body ${LEAK_SENTINEL}`

type Expected = ReactionPreparationDecision

function fixed(user: string, channel_name: string, opts: { thread_ts?: string; messageUnknown?: boolean } = {}): Expected {
  return opts.thread_ts === undefined
    ? { kind: 'fixed', user, channel_name, messageUnknown: opts.messageUnknown ?? false }
    : { kind: 'fixed', user, channel_name, thread_ts: opts.thread_ts, messageUnknown: false }
}

function withdrawn(reason: Extract<Expected, { kind: 'withdrawn' }>['reason'], failed_condition?: Extract<Expected, { kind: 'withdrawn' }>['failed_condition']): Expected {
  return failed_condition === undefined ? { kind: 'withdrawn', reason } : { kind: 'withdrawn', reason, failed_condition }
}

describe('decideReactionPreparation: the stored mode and normalized facts decide', () => {
  const found = (thread_ts?: string): ReactionMessageFacts =>
    thread_ts === undefined ? { state: 'found', serverPost: false } : { state: 'found', serverPost: false, thread_ts }
  const serverPost: ReactionMessageFacts = { state: 'found', serverPost: true, thread_ts: ROOT_TS }
  const refused = (code: 'not_in_channel' | 'channel_not_found'): ReactionMessageFacts => ({ state: 'refused', code })
  const noMessage: ReactionMessageFacts = { state: 'unknown' }
  const known = (kind: ReactionConversationKind, externallyShared = false, channel_name = 'general'): ReactionConversationFacts =>
    ({ state: 'known', channel_name, kind, externallyShared })
  const dm: ReactionConversationFacts = { state: 'dm', channel_name: 'dm' }
  const noConversation: ReactionConversationFacts = { state: 'unknown', channel_name: CHANNEL }
  const kept = (channel_name: string, opts: { thread_ts?: string; messageUnknown?: boolean } = {}) => fixed('Ada', channel_name, opts)

  const ROWS: Array<[string, ChannelMode, ReactionMessageFacts, ReactionConversationFacts, Expected]> = [
    // Kept in both modes.
    ['public channel, unthreaded', 'declarative', found(), known('public-channel'), kept('general')],
    ['private channel, threaded', 'declarative', found(ROOT_TS), known('private-channel', false, 'secret'), kept('secret', { thread_ts: ROOT_TS })],
    ['DM, threaded', 'declarative', found(ROOT_TS), dm, kept('dm', { thread_ts: ROOT_TS })],
    ['public channel, unthreaded', 'fungible', found(), known('public-channel'), kept('general')],
    ['private channel, threaded', 'fungible', found(ROOT_TS), known('private-channel', false, 'secret'), kept('secret', { thread_ts: ROOT_TS })],
    ['DM', 'fungible', found(), dm, kept('dm')],
    // Fungible-only conditions do not apply to declarative items.
    ['externally shared listed channel', 'declarative', found(), known('public-channel', true), kept('general')],
    ['conversation that is not a channel', 'declarative', found(), known('other', false, 'odd'), kept('odd')],
    // L1: an unknown message is fixed without thread_ts; a declarative refusal is L1 too.
    ['L1: message unknown', 'declarative', noMessage, known('public-channel'), kept('general', { messageUnknown: true })],
    ['L1: message unknown', 'fungible', noMessage, known('public-channel'), kept('general', { messageUnknown: true })],
    ['L1: not_in_channel refusal', 'declarative', refused('not_in_channel'), known('public-channel'), kept('general', { messageUnknown: true })],
    // L7: a declarative item whose conversation lookup failed is kept, typed with the ID.
    ['L7: conversation unknown', 'declarative', found(ROOT_TS), noConversation, kept(CHANNEL, { thread_ts: ROOT_TS })],
    ['L1 and L7 together', 'declarative', noMessage, noConversation, kept(CHANNEL, { messageUnknown: true })],
    // Each withdrawal reason and each fungible condition.
    ['Server Post', 'declarative', serverPost, known('public-channel'), withdrawn('server-post')],
    ['group DM', 'declarative', found(), known('group-dm', false, 'mpdm-ada--bob-1'), withdrawn('group-dm')],
    ['group DM', 'fungible', found(), known('group-dm', false, 'mpdm-ada--bob-1'), withdrawn('group-dm')],
    ['conversation unknown', 'fungible', found(), noConversation, withdrawn('conversation-unknown')],
    ['not a channel', 'fungible', found(), known('other', false, 'odd'), withdrawn('fungible-refused', 'not-a-channel')],
    ['externally shared', 'fungible', found(), known('public-channel', true), withdrawn('fungible-refused', 'externally-shared')],
    ['not_in_channel refusal', 'fungible', refused('not_in_channel'), known('public-channel'), withdrawn('fungible-refused', 'not_in_channel')],
    ['channel_not_found refusal', 'fungible', refused('channel_not_found'), known('private-channel'), withdrawn('fungible-refused', 'channel_not_found')],
    ['DM whose message read is refused', 'fungible', refused('not_in_channel'), dm, withdrawn('fungible-refused', 'not_in_channel')],
    // Precedence (SR-5.5): server-post, conversation-unknown, group-dm, fungible-refused.
    ['Server Post over conversation unknown', 'fungible', serverPost, noConversation, withdrawn('server-post')],
    ['Server Post over group DM', 'declarative', serverPost, known('group-dm'), withdrawn('server-post')],
    ['conversation unknown over a refusal', 'fungible', refused('not_in_channel'), noConversation, withdrawn('conversation-unknown')],
    ['group DM over fungible conditions', 'fungible', refused('channel_not_found'), known('group-dm', true), withdrawn('group-dm')],
    // Among fungible conditions, the order recorded on the implementation Subtask.
    ['not a channel over sharing and refusal', 'fungible', refused('not_in_channel'), known('other', true), withdrawn('fungible-refused', 'not-a-channel')],
    ['externally shared over a refusal', 'fungible', refused('channel_not_found'), known('public-channel', true), withdrawn('fungible-refused', 'externally-shared')],
  ]

  test.each(ROWS)('%s (%s)', (_label, mode, message, conversation, expected) => {
    expect(decideReactionPreparation(mode, { user: 'Ada', message, conversation })).toStrictEqual(expected)
  })
})

function accepted(overrides: Partial<ReactionAcceptedRecord> = {}): ReactionAcceptedRecord {
  const f = { channel: CHANNEL, message_ts: REACTED_TS, ts: EVENT_TS, change: 'added' as const, emoji: 'white_check_mark', user: 'U0ADA', mode: 'declarative' as ChannelMode, ...overrides }
  return {
    v: 1, kind: 'accepted', seq: 3, received_at: 1, source: 'reaction', text: '', origin: 'slack-event', ...f,
    reaction_key: { chat_id: f.channel, message_ts: f.message_ts, reactor: f.user || f.bot_id || '', emoji: f.emoji, change: f.change, event_ts: f.ts },
  }
}

interface Rig {
  stubs: { alpha: StubSlack; beta: StubSlack }
  clock: ReturnType<typeof createFakeClock>
  /** Every resolveUserName call, as [key, user]. */
  resolved: Array<[string, string]>
  run(item?: ReactionAcceptedRecord, key?: string): Run
}

interface Run { done: boolean; value?: ReactionPreparationDecision; promise: Promise<ReactionPreparationDecision> }

/** Two personas with their own stubs; `alpha` receives unless a case says otherwise. */
function rig(opts: { resolve?: (user: string) => Promise<string>; lookupTimeoutMs?: number; clientFor?: (key: string) => WebClient | undefined } = {}): Rig {
  const stubs = { alpha: makeStubSlack({ leakMarker: LEAK_SENTINEL }), beta: makeStubSlack({ leakMarker: LEAK_SENTINEL }) }
  const clock = createFakeClock()
  const resolved: Array<[string, string]> = []
  const deps = {
    clientFor: opts.clientFor ?? ((key: string) => key === 'alpha' || key === 'beta' ? asWebClient(stubs[key].web) : undefined),
    resolveUserName: (key: string, user: string) => {
      resolved.push([key, user])
      return opts.resolve ? opts.resolve(user) : Promise.resolve(`Name of ${user}`)
    },
    clock,
    lookupTimeoutMs: opts.lookupTimeoutMs ?? NAME_LOOKUP_TIMEOUT_MS,
  }
  return {
    stubs, clock, resolved,
    run(item = accepted(), key = 'alpha') {
      const promise = lookupReactionPreparation(key, item, deps)
      const run: Run = { done: false, promise }
      void promise.then(value => { run.done = true; run.value = value })
      return run
    },
  }
}

const methods = (stub: StubSlack) => stub.callLog.map(c => c.method).sort()
const exactMessage = (extra: Record<string, unknown> = {}): SettledWebApiOutcome => ({ kind: 'ok', result: { messages: [{ ts: REACTED_TS, text: BODY, ...extra }] } })
const channelInfo = (channel: Record<string, unknown>): SettledWebApiOutcome => ({ kind: 'ok', result: { channel: { id: CHANNEL, ...channel } } })
const PUBLIC = { name: 'general', is_channel: true }
const hang = () => new Promise<string>(() => {})

function held<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('lookupReactionPreparation: three concurrent, bounded lookups on the persona\'s own client', () => {
  test('all three lookups start before any settles, only on the receiving persona\'s client', async () => {
    const user = held<string>()
    const r = rig({ resolve: () => user.promise })
    const replies = makeDeferredWebApiCall(), info = makeDeferredWebApiCall()
    r.stubs.beta.script.replies.push(replies.outcome)
    r.stubs.beta.script.info.push(info.outcome)
    const run = r.run(accepted(), 'beta')
    await r.clock.flush()
    expect(methods(r.stubs.beta)).toEqual(['conversations.info', 'conversations.replies'])
    expect(r.resolved).toEqual([['beta', 'U0ADA']])
    expect(r.stubs.alpha.callLog).toEqual([])
    expect(run.done).toBe(false)
    expect(r.clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS, NAME_LOOKUP_TIMEOUT_MS, NAME_LOOKUP_TIMEOUT_MS])
    user.resolve('Ada')
    replies.settle(exactMessage({ thread_ts: ROOT_TS }))
    info.settle(channelInfo(PUBLIC))
    await r.clock.flush()
    expect(run.value).toStrictEqual(fixed('Ada', 'general', { thread_ts: ROOT_TS }))
    expect(r.clock.pendingCount()).toBe(0)
    assertNoLeak(run.value)
  })

  const OVERRIDE_MS = 250
  test.each([
    ['NAME_LOOKUP_TIMEOUT_MS', undefined],
    ['an injected bound', OVERRIDE_MS],
  ] as const)('every hung lookup ends at %s, all together rather than one after another', async (_label, override) => {
    const bound = override ?? NAME_LOOKUP_TIMEOUT_MS
    expect(OVERRIDE_MS).not.toBe(NAME_LOOKUP_TIMEOUT_MS)
    const r = rig({ resolve: hang, lookupTimeoutMs: override })
    r.stubs.alpha.script.replies.push({ kind: 'never' })
    r.stubs.alpha.script.info.push({ kind: 'never' })
    const run = r.run()
    await r.clock.advance(bound - 1)
    expect(run.done).toBe(false)
    await r.clock.advance(1)
    expect(run.value).toStrictEqual(fixed('U0ADA', CHANNEL, { messageUnknown: true }))
    expect(r.clock.now()).toBe(bound)
    expect(r.clock.pendingCount()).toBe(0)
  })

  test.each([
    ['the name lookup', fixed('U0ADA', 'general')],
    ['the message lookup', fixed('Name of U0ADA', 'general', { messageUnknown: true })],
    ['the conversation lookup', fixed('Name of U0ADA', CHANNEL)],
  ] as const)('when only %s hangs, the others\' answers are kept and it ends at its own bound', async (leg, expected) => {
    const r = rig({ resolve: leg === 'the name lookup' ? hang : undefined })
    r.stubs.alpha.script.replies.push(leg === 'the message lookup' ? { kind: 'never' } : exactMessage())
    r.stubs.alpha.script.info.push(leg === 'the conversation lookup' ? { kind: 'never' } : channelInfo(PUBLIC))
    const run = r.run()
    await r.clock.advance(NAME_LOOKUP_TIMEOUT_MS - 1)
    expect(run.done).toBe(false)
    await r.clock.advance(1)
    expect(run.value).toStrictEqual(expected)
  })

  test.each([
    ['a resolved name is used', async () => 'Ada Lovelace', 'Ada Lovelace'],
    ['a failed name lookup falls back to the user ID', async () => { throw new Error(sentinelInMessage('users-info')) }, 'U0ADA'],
    ['an empty name falls back to the user ID', async () => '', 'U0ADA'],
  ] as Array<[string, () => Promise<string>, string]>)('reactor name: %s', async (_label, resolve, user) => {
    const r = rig({ resolve })
    r.stubs.alpha.script.replies.push(exactMessage())
    const decision = await r.run().promise
    expect(decision).toStrictEqual(fixed(user, 'stub-c0general'))
    expect(r.resolved).toEqual([['alpha', 'U0ADA']])
    assertNoLeak(decision)
  })

  test('a user ID is preferred to a bot ID; a bot-only reactor is used as is, with no name lookup', async () => {
    const both = rig()
    both.stubs.alpha.script.replies.push(exactMessage())
    expect(await both.run(accepted({ bot_id: 'B0BOT' })).promise).toStrictEqual(fixed('Name of U0ADA', 'stub-c0general'))
    expect(both.resolved).toEqual([['alpha', 'U0ADA']])
    const botOnly = rig({ resolve: hang })
    botOnly.stubs.alpha.script.replies.push(exactMessage())
    expect(await botOnly.run(accepted({ user: undefined, bot_id: 'B0BOT' })).promise).toStrictEqual(fixed('B0BOT', 'stub-c0general'))
    expect(botOnly.resolved).toEqual([])
    expect(botOnly.clock.now()).toBe(0)
  })
})

/** The shared lookup 2 read on alpha's client, bounded by NAME_LOOKUP_TIMEOUT_MS on the rig's clock. */
function readMessage(r: Rig, signal?: AbortSignal): Promise<ReactionMessageRead> {
  return lookupReactionMessage(asWebClient(r.stubs.alpha.web), CHANNEL, REACTED_TS, { clock: r.clock, lookupTimeoutMs: NAME_LOOKUP_TIMEOUT_MS, ...(signal ? { signal } : {}) })
}

/** `promise`'s value once it settles, read without awaiting it. */
function watch<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const w: { done: boolean; value?: T } = { done: false }
  void promise.then(value => { w.done = true; w.value = value })
  return w
}

/** A test-owned abort signal whose `abort` listeners are recorded as they are added and removed. */
function watchedSignal() {
  const controller = new AbortController()
  const signal = controller.signal
  const added: unknown[] = []
  const removed: unknown[] = []
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  Object.assign(signal, {
    addEventListener: (...args: Parameters<AbortSignal['addEventListener']>) => { if (args[0] === 'abort') added.push(args[1]); add(...args) },
    removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => { if (args[0] === 'abort') removed.push(args[1]); remove(...args) },
  })
  return { controller, signal, added, attached: () => added.filter(l => !removed.includes(l)).length }
}

describe('lookup 2: the reacted message, read with its metadata', () => {  test('one conversations.replies with the reacted ts as ts, oldest and latest, inclusive, with all metadata', async () => {
    const r = rig()
    await r.run().promise
    expect(r.stubs.alpha.calls.conversationsReplies).toStrictEqual([
      { channel: CHANNEL, ts: REACTED_TS, oldest: REACTED_TS, latest: REACTED_TS, inclusive: true, include_all_metadata: true },
    ])
  })

  const MARKER = { metadata: SERVER_POST_METADATA }
  test.each([
    ['the exact message\'s thread, not a Server Post neighbour\'s', [{ ts: NEIGHBOR_TS, thread_ts: NEIGHBOR_TS, ...MARKER }, { ts: REACTED_TS, thread_ts: ROOT_TS, text: BODY }], fixed('Name of U0ADA', 'general', { thread_ts: ROOT_TS })],
    ['an unthreaded Tool Post beside a threaded neighbour is found, not unknown', [{ ts: NEIGHBOR_TS, thread_ts: ROOT_TS }, { ts: REACTED_TS, text: BODY, files: [{ name: BODY }] }], fixed('Name of U0ADA', 'general')],
    ['the Server Post marker on the exact message withdraws it', [{ ts: NEIGHBOR_TS, thread_ts: ROOT_TS, text: BODY }, { ts: REACTED_TS, thread_ts: ROOT_TS, text: BODY, ...MARKER }], withdrawn('server-post')],
    ['other metadata on an ordinary message does not', [{ ts: REACTED_TS, text: BODY, metadata: { event_type: 'deploy_finished', event_payload: { by: BODY } } }], fixed('Name of U0ADA', 'general')],
  ] as const)('%s', async (_label, messages, expected) => {
    const r = rig()
    r.stubs.alpha.script.replies.push({ kind: 'ok', result: { messages } })
    r.stubs.alpha.script.info.push(channelInfo(PUBLIC))
    const decision = await r.run().promise
    expect(decision).toStrictEqual(expected)
    assertNoLeak(decision)
  })

  test.each([
    ['a Tool Post', { user: 'U0AUTHOR', thread_ts: ROOT_TS }, { state: 'found', author: 'U0AUTHOR', serverPost: false, thread_ts: ROOT_TS }],
    ['a Server Post', { user: 'U0AUTHOR', ...MARKER }, { state: 'found', author: 'U0AUTHOR', serverPost: true }],
    ['a message with no user', { bot_id: 'B0WEBHOOK', thread_ts: ROOT_TS }, { state: 'found', serverPost: false, thread_ts: ROOT_TS }],
    ['a message with an empty user and thread_ts', { user: '', thread_ts: '' }, { state: 'found', serverPost: false }],
  ] as Array<[string, Record<string, unknown>, ReactionMessageRead]>)('the shared read keeps only the exact message\'s normalized facts: %s', async (_label, exact, expected) => {
    const r = rig()
    const content = { text: BODY, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: BODY } }], files: [{ name: BODY }], user_profile: { real_name: BODY } }
    r.stubs.alpha.script.replies.push({ kind: 'ok', result: { messages: [{ ts: NEIGHBOR_TS, user: 'U0NEIGHBOR', thread_ts: NEIGHBOR_TS, ...content, ...MARKER }, { ts: REACTED_TS, ...content, ...exact }] } })
    const signal = watchedSignal()
    const read = await readMessage(r, signal.signal)
    expect(read).toStrictEqual(expected)
    expect(r.stubs.alpha.calls.conversationsReplies).toStrictEqual([{ channel: CHANNEL, ts: REACTED_TS, oldest: REACTED_TS, latest: REACTED_TS, inclusive: true, include_all_metadata: true }])
    expect({ timers: r.clock.pendingCount(), listeners: signal.attached() }).toStrictEqual({ timers: 0, listeners: 0 })
    assertNoLeak(read)
  })

  test('the message\'s author alone never changes the decision', async () => {
    const decisions: ReactionPreparationDecision[] = []
    for (const user of ['U0ADA', 'U0ALPHABOT', undefined]) {
      const r = rig()
      r.stubs.alpha.script.replies.push(exactMessage({ thread_ts: ROOT_TS, ...(user === undefined ? {} : { user }) }))
      r.stubs.alpha.script.info.push(channelInfo(PUBLIC))
      decisions.push(await r.run(accepted({ mode: 'fungible' })).promise)
    }
    const kept = fixed('Name of U0ADA', 'general', { thread_ts: ROOT_TS })
    expect(decisions).toStrictEqual([kept, kept, kept])
  })

  test.each([
    ['no messages field', { kind: 'ok', result: { messages: undefined } }, 'failed'],
    ['a messages field that is not a list', { kind: 'ok', result: { messages: REACTED_TS } }, 'failed'],
    ['malformed entries', { kind: 'ok', result: { messages: [null, 7, REACTED_TS, [REACTED_TS]] } }, 'missing'],
    ['an array entry carrying the exact ts and trusted message facts', { kind: 'ok', result: { messages: [Object.assign([], { ts: REACTED_TS, user: 'U0AUTHOR', thread_ts: ROOT_TS, text: BODY, ...MARKER })] } }, 'missing'],
    ['no message with the reacted ts', { kind: 'ok', result: { messages: [{ ts: NEIGHBOR_TS, thread_ts: ROOT_TS, text: BODY }] } }, 'missing'],
    ['a network failure', { kind: 'network' }, 'failed'],
    ['another Slack refusal', { kind: 'platform', error: 'missing_scope' }, 'failed'],
    ['a thrown error whose text names not_in_channel', { kind: 'reject', value: new Error(`not_in_channel ${sentinelInMessage('replies')}`) }, 'failed'],
    ['a thrown string channel_not_found', { kind: 'reject', value: 'channel_not_found' }, 'failed'],
    ['a read that never answers', { kind: 'never' }, 'timeout'],
  ] as Array<[string, WebApiOutcome, ReactionMessageRead['state']]>)('L1 in both modes: %s fixes the notice without thread_ts', async (_label, outcome, state) => {
    for (const mode of ['declarative', 'fungible'] as const) {
      const r = rig()
      r.stubs.alpha.script.replies.push(outcome)
      r.stubs.alpha.script.info.push(channelInfo(PUBLIC))
      const run = r.run(accepted({ mode }))
      await r.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
      expect(run.value).toStrictEqual(fixed('Name of U0ADA', 'general', { messageUnknown: true }))
      expect(r.clock.pendingCount()).toBe(0)
      assertNoLeak(run.value)
    }
    // The shared read tells the cases apart, keeps nothing of the answer or error, and leaves no bound or listener.
    const r = rig()
    r.stubs.alpha.script.replies.push(outcome)
    const signal = watchedSignal()
    const read = watch(readMessage(r, signal.signal))
    await r.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect(read.value).toStrictEqual({ state } as ReactionMessageRead)
    expect({ timers: r.clock.pendingCount(), listeners: signal.attached() }).toStrictEqual({ timers: 0, listeners: 0 })
    assertNoLeak(read.value)
  })

  test.each(['not_in_channel', 'channel_not_found'] as const)('Slack refusing the read with %s refuses a fungible item and is L1 for a declarative one', async code => {
    const decisions: ReactionPreparationDecision[] = []
    for (const mode of ['fungible', 'declarative'] as const) {
      const r = rig()
      r.stubs.alpha.script.replies.push({ kind: 'platform', error: code })
      r.stubs.alpha.script.info.push(channelInfo(PUBLIC))
      decisions.push(await r.run(accepted({ mode })).promise)
    }
    expect(decisions).toStrictEqual([withdrawn('fungible-refused', code), fixed('Name of U0ADA', 'general', { messageUnknown: true })])
    assertNoLeak(decisions)
    const r = rig()
    r.stubs.alpha.script.replies.push({ kind: 'platform', error: code })
    const signal = watchedSignal()
    const read = await readMessage(r, signal.signal)
    expect(read).toStrictEqual({ state: 'refused', code })
    expect({ timers: r.clock.pendingCount(), listeners: signal.attached() }).toStrictEqual({ timers: 0, listeners: 0 })
    assertNoLeak(read)
  })

  test('an already-aborted signal settles the shared read as cancelled, with no read, bound or listener', async () => {
    const r = rig()
    r.stubs.alpha.script.replies.push(exactMessage())
    const signal = watchedSignal()
    signal.controller.abort()
    expect(await readMessage(r, signal.signal)).toStrictEqual({ state: 'cancelled' })
    expect({ calls: r.stubs.alpha.callLog, timers: r.clock.pendingCount(), added: signal.added.length }).toStrictEqual({ calls: [], timers: 0, added: 0 })
  })

  test.each([
    ['success', exactMessage({ thread_ts: ROOT_TS, ...MARKER })],
    ['refusal', { kind: 'platform', error: 'not_in_channel' }],
  ] as Array<[string, SettledWebApiOutcome]>)('aborting a held read settles it as cancelled at once and removes its bound and listener; a late %s changes nothing, and the next read is independent', async (_label, late) => {
    const r = rig()
    const replies = makeDeferredWebApiCall()
    r.stubs.alpha.script.replies.push(replies.outcome, exactMessage({ thread_ts: ROOT_TS }))
    const signal = watchedSignal()
    try {
      const read = watch(readMessage(r, signal.signal))
      await r.clock.flush()
      expect({ calls: methods(r.stubs.alpha), bounds: r.clock.pending().map(t => t.delayMs), listeners: signal.attached(), done: read.done })
        .toStrictEqual({ calls: ['conversations.replies'], bounds: [NAME_LOOKUP_TIMEOUT_MS], listeners: 1, done: false })
      signal.controller.abort()
      await r.clock.flush()
      expect({ value: read.value, timers: r.clock.pendingCount(), listeners: signal.attached() }).toStrictEqual({ value: { state: 'cancelled' }, timers: 0, listeners: 0 })
      replies.settle(late)
      await r.clock.flush()
      expect(read.value).toStrictEqual({ state: 'cancelled' })
      expect(await readMessage(r)).toStrictEqual({ state: 'found', serverPost: false, thread_ts: ROOT_TS })
      expect(r.clock.pendingCount()).toBe(0)
    } finally {
      if (!replies.settled) replies.settle()
    }
  })
})
describe('lookup 3: the conversation, read fresh for every item', () => {
  test('a non-DM item makes one conversations.info and no other conversation or membership call', async () => {
    const r = rig()
    r.stubs.alpha.script.replies.push(exactMessage())
    await r.run(accepted({ mode: 'fungible' })).promise
    expect(r.stubs.alpha.calls.conversationsInfo).toStrictEqual([{ channel: CHANNEL }])
    expect(methods(r.stubs.alpha)).toEqual(['conversations.info', 'conversations.replies'])
    expect(r.stubs.beta.callLog).toEqual([])
  })

  test.each(['declarative', 'fungible'] as const)('a D… conversation is a DM with no conversation call (%s)', async mode => {
    const r = rig()
    r.stubs.alpha.script.replies.push(exactMessage({ thread_ts: ROOT_TS }))
    const decision = await r.run(accepted({ channel: 'D0DM0001', mode })).promise
    expect(decision).toStrictEqual(fixed('Name of U0ADA', 'dm', { thread_ts: ROOT_TS }))
    expect(methods(r.stubs.alpha)).toEqual(['conversations.replies'])
    expect(r.stubs.alpha.calls.conversationsReplies[0]!.channel).toBe('D0DM0001')
  })

  const kept = (channel_name: string) => fixed('Name of U0ADA', channel_name)
  const unknownConversation = { declarative: kept(CHANNEL), fungible: withdrawn('conversation-unknown') }
  test.each([
    ['a leading # is stripped', channelInfo({ name: '#general', is_channel: true }), { declarative: kept('general'), fungible: kept('general') }],
    ['no name falls back to the ID', channelInfo({ is_channel: true }), { declarative: kept(CHANNEL), fungible: kept(CHANNEL) }],
    ['an empty name falls back to the ID', channelInfo({ name: '', is_channel: true }), { declarative: kept(CHANNEL), fungible: kept(CHANNEL) }],
    ['a private channel (is_group)', channelInfo({ name: 'secret', is_group: true, is_private: true }), { declarative: kept('secret'), fungible: kept('secret') }],
    ['a private channel (is_channel, is_private)', channelInfo({ name: 'secret', is_channel: true, is_private: true }), { declarative: kept('secret'), fungible: kept('secret') }],
    ['a group DM', channelInfo({ name: 'mpdm-ada--bob-1', is_mpim: true, is_group: true, is_private: true }), { declarative: withdrawn('group-dm'), fungible: withdrawn('group-dm') }],
    ['a conversation that is not a channel', channelInfo({ name: 'odd', is_im: true }), { declarative: kept('odd'), fungible: withdrawn('fungible-refused', 'not-a-channel') }],
    ['an externally shared channel', channelInfo({ ...PUBLIC, is_ext_shared: true }), { declarative: kept('general'), fungible: withdrawn('fungible-refused', 'externally-shared') }],
    ['an answer with no channel', { kind: 'ok', result: { channel: undefined } }, unknownConversation],
    ['a channel that is not an object', { kind: 'ok', result: { channel: 'general' } }, unknownConversation],
    ['a channel array carrying a valid channel name and flags', { kind: 'ok', result: { channel: Object.assign([], { id: CHANNEL, ...PUBLIC }) } }, unknownConversation],
    ['a Slack refusal', { kind: 'platform', error: 'missing_scope' }, unknownConversation],
    ['a network failure', { kind: 'network' }, unknownConversation],
  ] as Array<[string, WebApiOutcome, Record<ChannelMode, Expected>]>)('%s', async (_label, info, expected) => {
    for (const mode of ['declarative', 'fungible'] as const) {
      const r = rig()
      r.stubs.alpha.script.replies.push(exactMessage())
      r.stubs.alpha.script.info.push(info)
      const decision = await r.run(accepted({ mode })).promise
      expect(decision).toStrictEqual(expected[mode])
      expect(methods(r.stubs.alpha)).toEqual(['conversations.info', 'conversations.replies'])
      assertNoLeak(decision)
    }
  })

  test.each(['message', 'conversation'] as const)('an array-shaped %s response cannot supply trusted lookup facts', async leg => {
    const r = rig()
    r.stubs.alpha.script.replies.push(exactMessage())
    r.stubs.alpha.script.info.push(channelInfo(PUBLIC))
    // Scripted results merge into record responses; return the malformed outer array directly.
    const intercepted = leg === 'message'
      ? spyOn(r.stubs.alpha.web.conversations, 'replies').mockResolvedValue(Object.assign([], { ok: true, messages: [{ ts: REACTED_TS, user: 'U0AUTHOR', thread_ts: ROOT_TS, text: BODY, metadata: { event_type: SERVER_POST_METADATA.event_type } }] }))
      : spyOn(r.stubs.alpha.web.conversations, 'info').mockResolvedValue(Object.assign([], { ok: true, channel: { id: CHANNEL, ...PUBLIC } }))
    try {
      const decision = await r.run(accepted({ mode: 'fungible' })).promise
      expect(decision).toStrictEqual(leg === 'message' ? fixed('Name of U0ADA', 'general', { messageUnknown: true }) : withdrawn('conversation-unknown'))
      expect(r.stubs.beta.callLog).toEqual([])
      expect(r.clock.pendingCount()).toBe(0)
      assertNoLeak(decision)
    } finally {
      intercepted.mockRestore()
    }
  })

  test('repeated items on one conversation see its current kind and sharing', async () => {
    const r = rig()
    r.stubs.alpha.script.info.push(channelInfo(PUBLIC), channelInfo({ ...PUBLIC, is_ext_shared: true }), channelInfo({ name: 'mpdm-ada--bob-1', is_mpim: true }))
    const decisions: ReactionPreparationDecision[] = []
    for (let i = 0; i < 3; i++) {
      r.stubs.alpha.script.replies.push(exactMessage())
      decisions.push(await r.run(accepted({ mode: 'fungible' })).promise)
    }
    expect(decisions).toStrictEqual([kept('general'), withdrawn('fungible-refused', 'externally-shared'), withdrawn('group-dm')])
    expect(r.stubs.alpha.calls.conversationsInfo).toStrictEqual([{ channel: CHANNEL }, { channel: CHANNEL }, { channel: CHANNEL }])
  })

  test.each([
    ['fails', { kind: 'platform', error: 'internal_error' }],
    ['times out', { kind: 'never' }],
  ] as Array<[string, WebApiOutcome]>)('a read that %s caches nothing: the next item reads again', async (_label, first) => {
    const r = rig()
    r.stubs.alpha.script.info.push(first, channelInfo(PUBLIC))
    r.stubs.alpha.script.replies.push(exactMessage(), exactMessage())
    const one = r.run()
    await r.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect(one.value).toStrictEqual(kept(CHANNEL))
    expect(await r.run().promise).toStrictEqual(kept('general'))
    expect(r.stubs.alpha.calls.conversationsInfo).toHaveLength(2)
  })

  test('answers arriving after their bound change neither that result nor the next item\'s', async () => {
    const r = rig()
    const lateReplies = makeDeferredWebApiCall(), lateInfo = makeDeferredWebApiCall()
    r.stubs.alpha.script.replies.push(lateReplies.outcome, exactMessage())
    r.stubs.alpha.script.info.push(lateInfo.outcome, channelInfo(PUBLIC))
    const first = r.run()
    await r.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    const decided = structuredClone(first.value)
    expect(decided).toStrictEqual(fixed('Name of U0ADA', CHANNEL, { messageUnknown: true }))
    lateReplies.settle(exactMessage({ thread_ts: ROOT_TS, metadata: { event_type: SERVER_POST_METADATA.event_type } }))
    lateInfo.settle(channelInfo({ name: 'late', is_channel: true, is_ext_shared: true }))
    await r.clock.flush()
    expect(first.value).toStrictEqual(decided)
    expect(await r.run(accepted({ mode: 'fungible' })).promise).toStrictEqual(kept('general'))
  })

  const NO_CLIENT: Array<[string, (key: string) => WebClient | undefined]> = [
    ['no client', () => undefined],
    ['a client lookup that throws', () => { throw new Error(sentinelInMessage('client-for')) }],
  ]
  test.each(NO_CLIENT)('with %s, lookups 2 and 3 fail at once and the fallbacks decide', async (_label, clientFor) => {
    const cases: Array<[ReactionAcceptedRecord, Expected]> = [
      [accepted(), fixed('Name of U0ADA', CHANNEL, { messageUnknown: true })],
      [accepted({ mode: 'fungible' }), withdrawn('conversation-unknown')],
      [accepted({ channel: 'D0DM0001', mode: 'fungible' }), fixed('Name of U0ADA', 'dm', { messageUnknown: true })],
    ]
    for (const [item, expected] of cases) {
      const r = rig({ clientFor })
      const decision = await r.run(item).promise
      expect(decision).toStrictEqual(expected)
      expect(r.clock.now()).toBe(0)
      assertNoLeak(decision)
    }
    const hung = rig({ clientFor, resolve: hang })
    const run = hung.run()
    await hung.clock.flush()
    expect(hung.clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    await hung.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect(run.value).toStrictEqual(fixed('U0ADA', CHANNEL, { messageUnknown: true }))
    expect([...hung.stubs.alpha.callLog, ...hung.stubs.beta.callLog]).toEqual([])
  })

  test('a credential in a Slack failure never reaches the decision', async () => {
    const r = rig()
    r.stubs.alpha.script.replies.push({ kind: 'reject', value: Object.assign(new Error(sentinelInMessage('replies')), { data: { error: 'not_in_channel', token: fakeToken(BOT_TOKEN_PREFIX, 'data') } }) })
    r.stubs.alpha.script.info.push({ kind: 'reject', value: new Error(sentinelInMessage('info')) })
    const decision = await r.run(accepted({ mode: 'fungible' })).promise
    expect(decision).toStrictEqual(withdrawn('conversation-unknown'))
    assertNoLeak(decision)
  })
})

/** B, the persona whose react tool made a bot-tool reaction: its bot user, and the persona name stored with the item at hand-off. */
const B_USER = 'U0BETABOT'
const STORED_B_NAME = 'Beta Bot as handed off'

/** A bot-tool item as the queue admits it: B's bot user the reactor and B's name stored with it, `overrides` over it. */
function botToolAccepted(overrides: Partial<ReactionAcceptedRecord> = {}): ReactionAcceptedRecord {
  const record = accepted({ origin: 'bot-tool', user: B_USER, reactor_persona_name: STORED_B_NAME, ...overrides })
  if (!isQueueRecord(record)) throw new Error('the bot-tool fixture is not a record the queue admits')
  return record
}

describe('lookup 1 for a bot-tool item: the persona name stored with it, with no lookup', () => {
  test('the stored name is the reactor name, with no name lookup or bound, while lookups 2 and 3 run on the receiving persona\'s client', async () => {
    // A resolver that would answer B's current name, so a lookup would also show in the decision.
    const r = rig({ resolve: async () => 'Beta Bot renamed' })
    const replies = makeDeferredWebApiCall(), info = makeDeferredWebApiCall()
    r.stubs.alpha.script.replies.push(replies.outcome)
    r.stubs.alpha.script.info.push(info.outcome)
    const run = r.run(botToolAccepted())
    await r.clock.flush()
    expect(methods(r.stubs.alpha)).toEqual(['conversations.info', 'conversations.replies'])
    expect(r.clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS, NAME_LOOKUP_TIMEOUT_MS])
    expect(run.done).toBe(false)
    replies.settle(exactMessage({ thread_ts: ROOT_TS }))
    info.settle(channelInfo(PUBLIC))
    await r.clock.flush()
    expect({ decision: run.value, resolved: r.resolved, beta: r.stubs.beta.callLog, timers: r.clock.pendingCount() })
      .toStrictEqual({ decision: fixed(STORED_B_NAME, 'general', { thread_ts: ROOT_TS }), resolved: [], beta: [], timers: 0 })
    assertNoLeak(run.value)
  })

  const GROUP_DM_INFO = channelInfo({ name: 'mpdm-ada--bob-1', is_mpim: true, is_group: true, is_private: true })
  test.each([
    ['an externally shared channel', 'fungible', exactMessage(), channelInfo({ ...PUBLIC, is_ext_shared: true }), withdrawn('fungible-refused', 'externally-shared')],
    ['a reacted-message read refused with not_in_channel', 'fungible', { kind: 'platform', error: 'not_in_channel' }, channelInfo(PUBLIC), withdrawn('fungible-refused', 'not_in_channel')],
    ['a group DM', 'fungible', exactMessage(), GROUP_DM_INFO, withdrawn('group-dm')],
    ['a group DM', 'declarative', exactMessage(), GROUP_DM_INFO, withdrawn('group-dm')],
  ] as Array<[string, ChannelMode, WebApiOutcome, WebApiOutcome, Expected]>)('%s still withdraws a %s bot-tool item, read with no membership call', async (_label, mode, replies, info, expected) => {
    const r = rig()
    r.stubs.alpha.script.replies.push(replies)
    r.stubs.alpha.script.info.push(info)
    const decision = await r.run(botToolAccepted({ mode })).promise
    expect({ decision, calls: methods(r.stubs.alpha), beta: r.stubs.beta.callLog, resolved: r.resolved })
      .toStrictEqual({ decision: expected, calls: ['conversations.info', 'conversations.replies'], beta: [], resolved: [] })
    assertNoLeak(decision)
  })
})
