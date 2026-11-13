/** Accepted work survives a failed first fixed append without another event
 * or restart; the unfixed head still owns the FIFO. Reaction Items take the
 * same path: real preparation over the real queue fixes or withdraws each one
 * once, retries the identical record, and leaves final work final. A bot-tool
 * item keeps its stored mode and reactor name through reopen and recovery. */
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryPreparation, type DeliveryPreparation } from '../src/delivery-intake.ts'
import type { DeliveryEngineEvent } from '../src/delivery-engine.ts'
import type { DeliveryQueue, FixedRecord, QueueItem, QueueRecord, ReactionAcceptedInput, WithdrawnRecord } from '../src/delivery-queue.ts'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { RETYPE_BACKOFF_MS } from '../src/delivery-constants.ts'
import { buildReactionMessageUnknownLine, buildReactionWithdrawnLine } from '../src/reaction-preparation-diagnostics.ts'
import { SERVER_POST_EVENT_TYPE } from '../src/server-post.ts'
import { buildTagParts, NAME_LOOKUP_TIMEOUT_MS, tagByteLength, type TagMessage } from '../src/tag-wrapper.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { injectedInput, queuePath, slackInput } from './test-helpers/delivery-queue.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { asWebClient, makeChannelMessage, makeDeferredWebApiCall, makeStubSlack, type DeferredWebApiCall, type SettledWebApiOutcome, type StubSlack } from './test-helpers/slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'

const harnesses: EngineHarness[] = []
const preparations: DeliveryPreparation[] = []
/** Every preparation's captured lines, leak-checked after each case. */
const diagnostics: string[][] = []
/** Releases for answers and appends a case holds, run first after it so a failed case cannot leave stop waiting on them. */
const releases: Array<() => void> = []
afterEach(async () => {
  const lines = diagnostics.splice(0)
  for (const release of releases.splice(0)) release()
  for (const preparation of preparations.splice(0)) await preparation.stop()
  for (const h of harnesses.splice(0)) {
    assertNoLeak([h.errors, h.events, h.calls, h.order, h.records()])
    await h.cleanup()
  }
  assertNoLeak(lines, 'diagnostics')
})

test.each(['slack-post-ack', 'injected', 'startup-accepted-only'] as const)('%s autonomously retries fixation, preserving ack and FIFO boundaries', async source => {
  const h = await makeEngineHarness(); harnesses.push(h)
  h.failAppend('fixed')
  if (source === 'slack-post-ack') {
    const config = makeMultiPersonaConfig([{ name: 'alpha', key: 'alpha' }], h.root)
    const routing = createPersonaRouting({
      queue: h.queue, prepare: h.preparation.prepare, getPersonaConfig: () => config,
      getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
      archive: () => {}, log: line => h.order.push(line), isPersonaUp: () => false, now: h.clock.now,
    })
    await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id, user: 'U0SENDER1', text: 'first' }), () => {
      expect(h.records().filter(r => r.kind === 'accepted')).toHaveLength(1)
      expect(h.order).not.toContain('lookup')
      expect(h.calls).toEqual([])
      h.order.push('ack')
    }, 'alpha')
    expect(h.order.indexOf('ack')).toBeLessThan(h.order.indexOf('lookup'))
  } else if (source === 'injected') {
    const accepted = await h.preparation.accept('alpha', injectedInput({ text: 'first' }))
    expect(accepted.status).toBe('accepted')
    if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
    await Promise.allSettled([h.preparation.prepare('alpha', accepted.item!)])
  } else {
    // Load the durable accepted-only item through the queue's real startup path.
    await h.queue.accept('alpha', injectedInput({ text: 'first' }))
    await h.restartServer()
    await h.preparation.recover()
  }
  const first = h.queue.items('alpha')[0]!
  expect(first.fixed).toBeUndefined()
  expect(h.preparation.owns('alpha', first.accepted.seq)).toBe(true)
  await h.accept('later')
  await h.tick()
  expect(h.engine.running('alpha')).toBe(true)
  await h.advance(RETYPE_BACKOFF_MS[0] - 1)
  expect(h.keyCalls()).toEqual([])
  expect(h.queue.items('alpha')[0]!.fixed).toBeUndefined()
  expect(h.queue.openCount('alpha')).toBe(2)
  await h.until(() => h.queue.openCount('alpha') === 0)
  const parts = h.queue.items('alpha').flatMap(item => item.fixed!.parts)
  expect(h.textCalls().map(call => call.params.text)).toEqual(parts)
  expect(parts[0]).toContain('first')
  expect(parts[1]).toBe('later')
  expect(h.records().filter(r => r.kind === 'fixed').map(r => r.seq)).toEqual([2, 1])
  expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  expect(h.preparation.owns('alpha', first.accepted.seq)).toBe(false)
})

/** A held Slack answer, released after the case if the case did not settle it. */
function heldCall(): DeferredWebApiCall {
  const call = makeDeferredWebApiCall()
  releases.push(() => { if (!call.settled) call.settle() })
  return call
}

function reactionInput(overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput {
  const fields = { channel: 'C0TEST001', message_ts: '1700000000.000001', ts: '1700000000.000002', change: 'added' as const, emoji: 'thumbsup', user: 'U0REACTOR', ...overrides }
  return { source: 'reaction', text: '', origin: 'slack-event', mode: 'declarative', ...fields, reaction_key: { chat_id: fields.channel, message_ts: fields.message_ts, reactor: fields.user || fields.bot_id || '', emoji: fields.emoji, change: fields.change, event_ts: fields.ts } }
}

/** Where each case's shared clock starts, so a withdrawal's `at` is never the clock's zero. */
const START = 1_000

async function harness(options: Parameters<typeof makeEngineHarness>[0] = {}): Promise<EngineHarness> {
  const h = await makeEngineHarness(options); harnesses.push(h)
  await h.clock.advanceTo(START)
  return h
}

async function acceptReaction(h: EngineHarness, input: ReactionAcceptedInput = reactionInput(), key = 'alpha'): Promise<QueueItem> {
  const result = await h.queue.accept(key, input)
  if (result.status !== 'accepted') throw new Error('fixture reaction acceptance failed')
  return result.item!
}

const CHANNEL = 'C0GENERAL'
const REACTED_TS = '1700000100.000100'
const EVENT_TS = '1700000300.000300'
const LATER_EVENT_TS = '1700000400.000400'
const ROOT_TS = '1700000050.000050'
const PERSONA = { name: 'Alpha Bot', key: 'alpha' }
/** A second persona of the same preparation, whose work a forgotten persona must not touch. */
const BETA = { name: 'Beta Bot', key: 'beta' }
const PERSONAS: Readonly<Record<string, { name: string; key: string }>> = { [PERSONA.key]: PERSONA, [BETA.key]: BETA }
/** The persona and reacted message every expected line names. */
const SUBJECT = { key: PERSONA.key, name: PERSONA.name, chat_id: CHANNEL, message_ts: REACTED_TS }
const BETA_SUBJECT = { ...SUBJECT, key: BETA.key, name: BETA.name }
/** Reacted-message content that preparation reads past: the sentinel fails the leak checks if it reaches a record, line or send. */
const BODY = `reacted body ${LEAK_SENTINEL}`
const PUBLIC = { name: 'general', is_channel: true }
const SERVER_POST = { metadata: { event_type: SERVER_POST_EVENT_TYPE, event_payload: {} } }
const DELIVERY_EVENTS: readonly DeliveryEngineEvent['type'][] = ['delivered', 'item-delivered', 'first-typed', 'partial-receipt', 'retyped', 'first-unconfirmed-retype']

/** A reaction on the reacted message of these cases, with distinct reacted, event and root timestamps. */
const reaction = (overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput =>
  reactionInput({ channel: CHANNEL, message_ts: REACTED_TS, ts: EVENT_TS, ...overrides })
/** BETA's bot user, and the persona name stored with a bot-tool item at hand-off, unlike any name a lookup gives. */
const B_USER = 'U0BETABOT'
const STORED_B_NAME = 'Beta Bot as handed off'
/** reaction() made by BETA's react tool: origin bot-tool, BETA's bot user the reactor and its stored name. */
const botToolReaction = (overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput =>
  reaction({ origin: 'bot-tool', user: B_USER, reactor_persona_name: STORED_B_NAME, ...overrides })
/** Slack's answer holding the reacted message, with a body and files that never reach the tag. */
const exact = (extra: Record<string, unknown> = {}): SettledWebApiOutcome =>
  ({ kind: 'ok', result: { messages: [{ ts: REACTED_TS, text: BODY, files: [{ name: `${BODY}.txt`, mimetype: 'text/plain', size: 3 }], ...extra }] } })
const conversation = (channel: Record<string, unknown>): SettledWebApiOutcome => ({ kind: 'ok', result: { channel: { id: CHANNEL, ...channel } } })
/** SR-7.1's Reaction Notice fields for reaction(), written out independently of the preparer. */
const notice = (overrides: TagMessage = {}): TagMessage => ({
  chat_id: CHANNEL, channel_name: 'general', message_id: REACTED_TS, user: 'Name of U0REACTOR', user_id: 'U0REACTOR',
  ts: EVENT_TS, via: 'reaction', reaction: 'added', emoji: 'thumbsup', text: '', ...overrides,
})
const withdrawal = (seq: number, reason: WithdrawnRecord['reason'], at: number, failed_condition?: WithdrawnRecord['failed_condition']): WithdrawnRecord =>
  failed_condition === undefined ? { v: 1, kind: 'withdrawn', seq, reason, at } : { v: 1, kind: 'withdrawn', seq, reason, at, failed_condition }
const outcomes = (h: EngineHarness, seq = 1, key = 'alpha'): QueueRecord[] => h.records(key).filter(r => r.seq === seq && r.kind !== 'accepted')
/** Appends, lines and wakes in the order they happened. */
const effects = (h: EngineHarness): string[] => h.order.filter(e => /^(append:(fixed|withdrawn):|log$|wake:)/.test(e))

interface Preparer {
  preparation: DeliveryPreparation
  /** The first persona's stub and reactor-name resolutions; `stubs` and `resolvedBy` hold each persona's. */
  stub: StubSlack; resolved: string[]
  stubs: Record<string, StubSlack>; resolvedBy: Record<string, string[]>
  logs: string[]; wakes: string[]
}

/** A real preparation over the harness queue and shared clock, with one Slack stub per persona. Its lines and wakes go into `h.order`, after the queue's durable appends. */
function preparer(h: EngineHarness, opts: { resolve?: (user: string) => Promise<string>; log?: (line: string) => unknown; tagMaxBytes?: number
  /** Each outcome append waits for this before it reaches the harness queue. */
  holdAppend?: (record: QueueRecord) => Promise<void>
  /** The receiving persona's display identity; PERSONAS by default. */
  persona?: (key: string) => { name: string; key: string } | undefined } = {}): Preparer {
  const stubs: Record<string, StubSlack> = {}, resolvedBy: Record<string, string[]> = {}
  for (const key of Object.keys(PERSONAS)) { stubs[key] = makeStubSlack({ leakMarker: LEAK_SENTINEL }); resolvedBy[key] = [] }
  const logs: string[] = [], wakes: string[] = []
  diagnostics.push(logs)
  const hold = opts.holdAppend
  // A copy of the harness queue serves the cases that hold an append, since none of them reopens it.
  const queue: DeliveryQueue = hold ? { ...h.queue, async append(key, record) { await hold(record); await h.queue.append(key, record) } } : h.queue
  const preparation = createDeliveryPreparation({ queue, clock: h.clock,
    clientFor: key => { const stub = stubs[key]; return stub ? asWebClient(stub.web) : undefined },
    resolveUserName: async (key, user) => { resolvedBy[key]?.push(user); return opts.resolve ? opts.resolve(user) : `Name of ${user}` },
    now: h.clock.now,
    log: line => { logs.push(line); h.order.push('log'); return opts.log?.(line) },
    persona: opts.persona ?? (key => PERSONAS[key]),
    wake: key => { wakes.push(key); h.order.push(`wake:${key}`) },
    tagMaxBytes: opts.tagMaxBytes,
  })
  preparations.push(preparation)
  return { preparation, stub: stubs[PERSONA.key]!, resolved: resolvedBy[PERSONA.key]!, stubs, resolvedBy, logs, wakes }
}
/** Lookups made so far for one persona: Slack calls and reactor-name resolutions. */
const lookups = (p: Preparer, key = PERSONA.key): number => p.stubs[key]!.callLog.length + p.resolvedBy[key]!.length
/** The Slack methods called on one stub, sorted. */
const methods = (stub: StubSlack): string[] => stub.callLog.map(c => c.method).sort()

describe('reaction preparation fixes or withdraws through the real queue', () => {
  const ASSEMBLY: Array<[string, Partial<ReactionAcceptedInput>, SettledWebApiOutcome, SettledWebApiOutcome, TagMessage, string[]]> = [
    ['a user adds a reaction to a threaded message', { change: 'added', emoji: 'white_check_mark' }, exact({ thread_ts: ROOT_TS }), conversation(PUBLIC),
      notice({ thread_ts: ROOT_TS, emoji: 'white_check_mark' }), ['U0REACTOR']],
    ['a bot with no user removes a reaction from an unthreaded message', { user: undefined, bot_id: 'B0OTHER01', change: 'removed', emoji: 'eyes', mode: 'fungible' }, exact(),
      conversation({ name: 'secret', is_group: true, is_private: true }),
      notice({ channel_name: 'secret', user: 'B0OTHER01', user_id: undefined, bot_id: 'B0OTHER01', reaction: 'removed', emoji: 'eyes' }), []],
  ]
  test.each(ASSEMBLY)('%s: the durable parts are its Reaction Notice, with an empty body and nothing inherited', async (_label, input, replies, info, expected, resolved) => {
    const h = await harness(), p = preparer(h)
    p.stub.script.replies.push(replies)
    p.stub.script.info.push(info)
    const item = await acceptReaction(h, reaction(input))
    await p.preparation.prepare('alpha', item)
    const parts = buildTagParts(expected)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatch(/><\/channel>$/)
    expect(parts[0]).not.toContain('attachment')
    expect(h.records().slice(1)).toEqual([{ v: 1, kind: 'fixed', seq: item.accepted.seq, parts }])
    expect(p.resolved).toEqual(resolved)
    expect(p.stub.calls.conversationsReplies.map(args => args.ts)).toEqual([REACTED_TS])
    expect(p.logs).toEqual([])
    expect(effects(h)).toEqual([`append:fixed:${item.accepted.seq}`, 'wake:alpha'])
    expect(p.preparation.owns('alpha', item.accepted.seq)).toBe(false)
  })

  test('the injected part limit reaches the tag builder', async () => {
    const LIMIT = 800, name = 'Reactor '.repeat(80)
    const h = await harness(), p = preparer(h, { tagMaxBytes: LIMIT, resolve: async () => name })
    p.stub.script.replies.push(exact())
    p.stub.script.info.push(conversation(PUBLIC))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction()))
    const parts = h.queue.item('alpha', 1)!.fixed!.parts
    expect(parts).toEqual(buildTagParts(notice({ user: name }), LIMIT))
    expect(parts).not.toEqual(buildTagParts(notice({ user: name })))
    for (const part of parts) expect(tagByteLength(part)).toBeLessThanOrEqual(LIMIT)
  })

  const RETRIED: Array<['fixed' | 'withdrawn', ReactionAcceptedInput['mode'], SettledWebApiOutcome, QueueRecord, string[], [SettledWebApiOutcome, SettledWebApiOutcome]]> = [
    ['fixed', 'declarative', exact({ thread_ts: ROOT_TS }), { v: 1, kind: 'fixed', seq: 1, parts: buildTagParts(notice({ thread_ts: ROOT_TS })) }, [],
      [exact(SERVER_POST), conversation({ ...PUBLIC, is_ext_shared: true })]],
    ['withdrawn', 'fungible', { kind: 'platform', error: 'not_in_channel' }, withdrawal(1, 'fungible-refused', START, 'not_in_channel'),
      [buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'not_in_channel')], [exact({ thread_ts: ROOT_TS }), conversation(PUBLIC)]],
  ]
  test.each(RETRIED)('a failed %s append keeps ownership and its decided record, then retries it unchanged at the backoff step', async (kind, mode, replies, record, lines, changed) => {
    const h = await harness(), p = preparer(h)
    p.stub.script.replies.push(replies)
    p.stub.script.info.push(conversation(PUBLIC))
    h.failAppend(kind)
    const item = await acceptReaction(h, reaction({ mode }))
    await expect(p.preparation.prepare('alpha', item)).rejects.toThrow('injected append failure')
    const decided = lookups(p)
    expect(decided).toBe(3)
    expect(p.preparation.owns('alpha', 1)).toBe(true)
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(effects(h)).toEqual([])
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([RETYPE_BACKOFF_MS[0]])
    // Slack's facts change and the clock moves on before the retry; the decided record must not.
    p.stub.script.replies.push(changed[0])
    p.stub.script.info.push(changed[1])
    await h.clock.advance(RETYPE_BACKOFF_MS[0] - 1)
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(p.preparation.owns('alpha', 1)).toBe(true)
    await h.clock.advance(1)
    expect(h.clock.now()).toBe(START + RETYPE_BACKOFF_MS[0])
    expect(outcomes(h)).toEqual([record])
    expect(lookups(p)).toBe(decided)
    expect([p.stub.script.replies.length, p.stub.script.info.length]).toEqual([1, 1])
    expect(p.logs).toEqual(lines)
    expect(effects(h)).toEqual([`append:${kind}:1`, ...lines.map(() => 'log'), 'wake:alpha'])
    expect(p.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.queue.openCount('alpha')).toBe(kind === 'fixed' ? 1 : 0)
  })

  test.each(['fixed', 'withdrawn'] as const)('an unresolved reaction head whose %s append failed holds its successor until the retry, then the FIFO goes on in sequence', async kind => {
    const stub = makeStubSlack({ leakMarker: LEAK_SENTINEL }), logs: string[] = []
    diagnostics.push(logs)
    const h: EngineHarness = await harness({ preparation: {
      clientFor: () => asWebClient(stub.web), resolveUserName: async (_key, user) => `Name of ${user}`,
      now: () => h.clock.now(), log: line => { logs.push(line) }, persona: key => key === PERSONA.key ? PERSONA : undefined,
    } })
    stub.script.replies.push(exact({ thread_ts: ROOT_TS }))
    stub.script.info.push(conversation(kind === 'withdrawn' ? { ...PUBLIC, is_ext_shared: true } : PUBLIC))
    h.failAppend(kind)
    const head = await acceptReaction(h, reaction({ mode: kind === 'withdrawn' ? 'fungible' : 'declarative' }))
    await expect(h.preparation.prepare('alpha', head)).rejects.toThrow('injected append failure')
    await h.accept('later')
    await h.tick()
    expect(h.engine.running('alpha')).toBe(true)
    await h.advance(RETYPE_BACKOFF_MS[0] - 1)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.preparation.owns('alpha', 1)).toBe(true)
    const decided = stub.callLog.length
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(stub.callLog).toHaveLength(decided)
    expect(h.preparation.owns('alpha', 1)).toBe(false)
    if (kind === 'fixed') {
      expect(h.textCalls().map(c => c.params.text)).toEqual([...buildTagParts(notice({ thread_ts: ROOT_TS })), 'later'])
      expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
      expect(logs).toEqual([])
    } else {
      expect(h.textCalls().map(c => c.params.text)).toEqual(['later'])
      // Decided before the backoff and retried after it, the withdrawal keeps its first time.
      expect(h.clock.now()).toBeGreaterThanOrEqual(START + RETYPE_BACKOFF_MS[0])
      expect(outcomes(h)).toEqual([withdrawal(1, 'fungible-refused', START, 'externally-shared')])
      expect(h.events.filter(e => DELIVERY_EVENTS.includes(e.type) && 'seq' in e && e.seq === 1)).toEqual([])
      expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([2])
      expect(logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'externally-shared')])
    }
  })

  test('overlapping prepare and recover calls share one decision, one append, one line and one wake', async () => {
    const h = await harness(), p = preparer(h)
    const replies = heldCall()
    p.stub.script.replies.push(replies.outcome)
    p.stub.script.info.push(conversation(PUBLIC))
    const item = await acceptReaction(h, reaction())
    const calls = [p.preparation.prepare('alpha', item), p.preparation.recover(), p.preparation.prepare('alpha', item), p.preparation.recover(['alpha'])]
    await h.clock.flush()
    expect(lookups(p)).toBe(3)
    replies.settle({ kind: 'ok', result: { messages: [] } })
    await Promise.all(calls)
    expect(lookups(p)).toBe(3)
    expect(outcomes(h)).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: buildTagParts(notice()) }])
    expect(p.logs).toEqual([buildReactionMessageUnknownLine(SUBJECT)])
    expect(effects(h)).toEqual(['append:fixed:1', 'log', 'wake:alpha'])
    // Final work prepared again is neither decided nor reported again.
    await p.preparation.prepare('alpha', item)
    await p.preparation.recover()
    expect(lookups(p)).toBe(3)
    expect(p.logs).toHaveLength(1)
    expect(outcomes(h)).toHaveLength(1)
  })
})

describe('fresh lookups and the L1 and L7 fallbacks at the factory', () => {
  test('a reaction reads its conversation fresh, past the channel names cached for ordinary items', async () => {
    const h = await harness(), p = preparer(h)
    async function ordinary(ts: string): Promise<string> {
      const result = await h.queue.accept('alpha', slackInput({ channel: CHANNEL, key: { chat_id: CHANNEL, ts }, ts }))
      if (result.status !== 'accepted') throw new Error('fixture acceptance failed')
      await p.preparation.prepare('alpha', result.item!)
      return h.queue.item('alpha', result.seq)!.fixed!.parts.join('')
    }
    expect(await ordinary('1700000001.000001')).toContain('channel_name="stub-c0general"')
    expect(p.stub.calls.conversationsInfo).toHaveLength(1)
    p.stub.script.replies.push(exact())
    p.stub.script.info.push(conversation({ name: 'renamed', is_channel: true }))
    const kept = await acceptReaction(h, reaction())
    await p.preparation.prepare('alpha', kept)
    expect(h.queue.item('alpha', kept.accepted.seq)!.fixed!.parts).toEqual(buildTagParts(notice({ channel_name: 'renamed' })))
    expect(await ordinary('1700000002.000002')).toContain('channel_name="stub-c0general"')
    expect(p.stub.calls.conversationsInfo).toHaveLength(2)
    p.stub.script.replies.push(exact())
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    const refused = await acceptReaction(h, reaction({ mode: 'fungible', ts: LATER_EVENT_TS }))
    await p.preparation.prepare('alpha', refused)
    expect(h.queue.item('alpha', refused.accepted.seq)!.withdrawn).toEqual(withdrawal(refused.accepted.seq, 'fungible-refused', START, 'externally-shared'))
    expect(p.stub.calls.conversationsInfo).toHaveLength(3)
  })

  test('L1: a reacted message Slack does not return is fixed durably without thread_ts, with one message-unknown line', async () => {
    const h = await harness(), p = preparer(h)
    p.stub.script.replies.push({ kind: 'ok', result: { messages: [{ ts: '1700000099.000099', thread_ts: ROOT_TS, text: BODY }] } })
    p.stub.script.info.push(conversation(PUBLIC))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction()))
    const parts = h.queue.item('alpha', 1)!.fixed!.parts
    expect(parts).toEqual(buildTagParts(notice()))
    expect(parts.join('')).not.toContain('thread_ts')
    expect(p.logs).toEqual([buildReactionMessageUnknownLine(SUBJECT)])
    expect(effects(h)).toEqual(['append:fixed:1', 'log', 'wake:alpha'])
  })

  test('L1 under a withdrawal: the withdrawal line alone, never the message-unknown line', async () => {
    const h = await harness(), p = preparer(h)
    p.stub.script.replies.push({ kind: 'network' })
    p.stub.script.info.push(conversation({ name: 'mpdm-ada--bob-1', is_mpim: true, is_group: true, is_private: true }))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction()))
    expect(outcomes(h)).toEqual([withdrawal(1, 'group-dm', START)])
    expect(p.logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'group-dm')])
    expect(effects(h)).toEqual(['append:withdrawn:1', 'log', 'wake:alpha'])
    assertNoLeak(p.logs)
  })

  test('L7: the same failed conversation lookup keeps a declarative item, typed with the conversation ID, and withdraws a fungible one', async () => {
    const h = await harness(), p = preparer(h)
    for (let i = 0; i < 2; i++) {
      p.stub.script.replies.push(exact({ thread_ts: ROOT_TS }))
      p.stub.script.info.push({ kind: 'platform', error: 'internal_error' })
    }
    const kept = await acceptReaction(h, reaction({ mode: 'declarative' }))
    await p.preparation.prepare('alpha', kept)
    const refused = await acceptReaction(h, reaction({ mode: 'fungible', ts: LATER_EVENT_TS }))
    await p.preparation.prepare('alpha', refused)
    expect(outcomes(h, kept.accepted.seq)).toEqual([{ v: 1, kind: 'fixed', seq: kept.accepted.seq, parts: buildTagParts(notice({ channel_name: CHANNEL, thread_ts: ROOT_TS })) }])
    expect(outcomes(h, refused.accepted.seq)).toEqual([withdrawal(refused.accepted.seq, 'conversation-unknown', START)])
    expect(p.logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'conversation-unknown')])
    assertNoLeak(p.logs)
  })
})

describe('reaction preparation lines', () => {
  test.each(['throws', 'rejects'] as const)('a logger that %s cannot undo, delay or repeat the outcome', async how => {
    const h = await harness()
    let attempts = 0
    const p = preparer(h, { log: () => {
      attempts++
      const error = new Error(sentinelInMessage('logger'))
      if (how === 'throws') throw error
      return Promise.reject(error)
    } })
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction({ mode: 'fungible' })))
    expect(outcomes(h)).toEqual([withdrawal(1, 'fungible-refused', START, 'externally-shared')])
    expect(effects(h)).toEqual(['append:withdrawn:1', 'log', 'wake:alpha'])
    expect(p.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(attempts).toBe(1)
    expect(outcomes(h)).toHaveLength(1)
    expect(lookups(p)).toBe(3)
  })

  test('lines and the journal of withdrawn items hold no message, name or Slack error content', async () => {
    const h = await harness(), p = preparer(h, { resolve: async () => `Reactor ${LEAK_SENTINEL}` })
    p.stub.script.replies.push(exact({ thread_ts: ROOT_TS, username: `Author ${LEAK_SENTINEL}` }))
    p.stub.script.info.push(conversation({ name: `chan-${LEAK_SENTINEL}`, is_channel: true, is_ext_shared: true }))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction({ mode: 'fungible' })))
    p.stub.script.replies.push({ kind: 'platform', error: 'not_in_channel' })
    p.stub.script.info.push(conversation({ name: `chan-${LEAK_SENTINEL}`, is_channel: true }))
    await p.preparation.prepare('alpha', await acceptReaction(h, reaction({ mode: 'fungible', ts: LATER_EVENT_TS })))
    expect(p.resolved).toEqual(['U0REACTOR', 'U0REACTOR'])
    expect(p.logs).toEqual([
      buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'externally-shared'),
      buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'not_in_channel'),
    ])
    assertNoLeak({ logs: p.logs, errors: h.errors, events: h.events, journal: writtenFile(queuePath(h.root)) })
  })
})

describe('reaction preparation stop, forget and competing outcomes', () => {
  test.each(['its held answer arrives', 'its lookup bound passes'] as const)('stop during the lookups appends, logs and wakes nothing when %s; the next start decides afresh', async how => {
    const h = await harness(), p = preparer(h)
    const replies = heldCall()
    p.stub.script.replies.push(replies.outcome)
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    const item = await acceptReaction(h, reaction({ mode: 'fungible' }))
    const preparing = p.preparation.prepare('alpha', item)
    await h.clock.flush()
    expect(p.preparation.owns('alpha', 1)).toBe(true)
    const stopping = p.preparation.stop()
    if (how === 'its held answer arrives') replies.settle(exact())
    else await h.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    await stopping
    await preparing
    if (!replies.settled) replies.settle(exact())
    await h.clock.flush()
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(effects(h)).toEqual([])
    expect(p.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    const next = preparer(h), at = h.clock.now()
    next.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    await next.preparation.recover()
    expect(outcomes(h)).toEqual([withdrawal(1, 'fungible-refused', at, 'externally-shared')])
    expect(next.logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'externally-shared')])
    expect(p.logs).toEqual([])
  })

  test.each(['stop', 'forget'] as const)('%s cancels a scheduled retry: nothing is appended, logged or woken later, and the decided outcome is dropped', async how => {
    const h = await harness(), p = preparer(h)
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    h.failAppend('withdrawn')
    const item = await acceptReaction(h, reaction({ mode: 'fungible' }))
    await expect(p.preparation.prepare('alpha', item)).rejects.toThrow('injected append failure')
    expect(h.clock.pendingCount()).toBe(1)
    if (how === 'stop') await p.preparation.stop()
    else p.preparation.forget('alpha')
    expect(h.clock.pendingCount()).toBe(0)
    expect(p.preparation.owns('alpha', 1)).toBe(false)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(effects(h)).toEqual([])
    expect(lookups(p)).toBe(3)
    if (how === 'forget') {
      // The persona added again under the same key decides afresh: no old outcome.
      p.stub.script.replies.push(exact())
      p.stub.script.info.push(conversation(PUBLIC))
      await p.preparation.prepare('alpha', item)
      expect(lookups(p)).toBe(6)
      expect(outcomes(h)).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: buildTagParts(notice()) }])
      expect(p.logs).toEqual([])
    }
  })

  const FORGOTTEN_LOOKUPS = (['its held answer arrives', 'its lookup bound passes'] as const).flatMap(how => (['would land', 'would fail'] as const).map(append => [how, append] as const))
  test.each(FORGOTTEN_LOOKUPS)('forget during the lookups appends, logs, wakes and retries nothing when %s (its append %s); another persona keeps its decided outcome and retry', async (how, append) => {
    const h = await harness(), p = preparer(h)
    // The other persona: a decided withdrawal whose append failed, waiting for its retry.
    p.stubs[BETA.key]!.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    h.failAppend('withdrawn')
    const other = await acceptReaction(h, reaction({ mode: 'fungible' }), BETA.key)
    await expect(p.preparation.prepare(BETA.key, other)).rejects.toThrow('injected append failure')
    const retry = h.clock.pending()
    expect(retry.map(t => t.delayMs)).toEqual([RETYPE_BACKOFF_MS[0]])
    // The forgotten persona: its lookups held; on its own it would fix the notice.
    const replies = heldCall()
    p.stub.script.replies.push(replies.outcome)
    p.stub.script.info.push(conversation(PUBLIC))
    if (append === 'would fail') h.failAppend('fixed')
    const preparing = p.preparation.prepare(PERSONA.key, await acceptReaction(h, reaction()))
    await h.clock.flush()
    expect(lookups(p)).toBe(3)
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(true)
    p.preparation.forget(PERSONA.key)
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(false)
    expect(p.preparation.owns(BETA.key, 1)).toBe(true)
    if (how === 'its held answer arrives') replies.settle(exact({ thread_ts: ROOT_TS }))
    else await h.clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    await preparing
    if (!replies.settled) replies.settle(exact())
    await h.clock.flush()
    expect(h.records(PERSONA.key).map(r => r.kind)).toEqual(['accepted'])
    expect(p.logs).toEqual([])
    expect(p.wakes).toEqual([])
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(false)
    expect(h.clock.pending()).toEqual(retry)
    // The other persona's retry appends its identical decided record, unaffected.
    await h.clock.advanceTo(retry[0]!.dueAt)
    expect(outcomes(h, 1, BETA.key)).toEqual([withdrawal(1, 'fungible-refused', START, 'externally-shared')])
    expect(lookups(p, BETA.key)).toBe(3)
    expect(p.logs).toEqual([buildReactionWithdrawnLine(BETA_SUBJECT, 'fungible-refused', 'externally-shared')])
    expect(p.wakes).toEqual([BETA.key])
    expect(p.preparation.owns(BETA.key, 1)).toBe(false)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(h.records(PERSONA.key).map(r => r.kind)).toEqual(['accepted'])
    expect(lookups(p)).toBe(3)
    expect(h.clock.pendingCount()).toBe(0)
  })

  const HELD_APPENDS = (['forget', 'stop'] as const).flatMap(how => (['lands', 'fails'] as const).map(append => [how, append] as const))
  test.each(HELD_APPENDS)('%s while the outcome append is outstanding: the write that %s stays as it is, with no line, wake or retry after it', async (how, append) => {
    const gate = Promise.withResolvers<void>(), held: QueueRecord[] = []
    releases.push(() => gate.resolve())
    const h = await harness(), p = preparer(h, { holdAppend: record => { held.push(record); return gate.promise } })
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    if (append === 'fails') h.failAppend('withdrawn')
    const record = withdrawal(1, 'fungible-refused', START, 'externally-shared')
    const preparing = p.preparation.prepare(PERSONA.key, await acceptReaction(h, reaction({ mode: 'fungible' })))
    await h.clock.flush()
    expect(held).toEqual([record])
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(true)
    let stopping: Promise<void> = Promise.resolve()
    if (how === 'stop') stopping = p.preparation.stop()
    else p.preparation.forget(PERSONA.key)
    gate.resolve()
    if (append === 'fails') await expect(preparing).rejects.toThrow('injected append failure')
    else await preparing
    await stopping
    expect(outcomes(h)).toEqual(append === 'lands' ? [record] : [])
    expect(p.logs).toEqual([])
    expect(p.wakes).toEqual([])
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(held).toEqual([record])
    expect(outcomes(h)).toEqual(append === 'lands' ? [record] : [])
    expect(lookups(p)).toBe(3)
  })

  test.each(['while its old preparation is still outstanding', 'after its old preparation has ended'] as const)('a persona added again under the same key %s decides afresh on changed facts; the old life adds nothing and leaves the new one in place', async when => {
    const h = await harness(), p = preparer(h)
    // The old life's facts would withdraw the item as externally shared.
    const old = heldCall()
    p.stub.script.replies.push(old.outcome)
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    const item = await acceptReaction(h, reaction({ mode: 'fungible' }))
    const oldWork = p.preparation.prepare(PERSONA.key, item)
    await h.clock.flush()
    p.preparation.forget(PERSONA.key)
    if (when === 'after its old preparation has ended') {
      old.settle(exact())
      await oldWork
    }
    // The new life sees an unshared public conversation and a threaded message: a notice to fix.
    const fresh = heldCall()
    p.stub.script.replies.push(fresh.outcome)
    p.stub.script.info.push(conversation(PUBLIC))
    const newWork = p.preparation.prepare(PERSONA.key, item)
    await h.clock.flush()
    expect(lookups(p)).toBe(6)
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(true)
    if (when === 'while its old preparation is still outstanding') {
      old.settle(exact())
      await oldWork
      expect(p.preparation.owns(PERSONA.key, 1)).toBe(true)
      // The old life's end did not drop the new life's work: a further call shares it.
      expect(p.preparation.prepare(PERSONA.key, item)).toBe(newWork)
    }
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(p.wakes).toEqual([])
    fresh.settle(exact({ thread_ts: ROOT_TS }))
    await newWork
    expect(outcomes(h)).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: buildTagParts(notice({ thread_ts: ROOT_TS })) }])
    expect(lookups(p)).toBe(6)
    expect(p.logs).toEqual([])
    expect(p.wakes).toEqual([PERSONA.key])
    expect(p.preparation.owns(PERSONA.key, 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
  })

  const COMPETING: Array<[string, QueueRecord]> = [
    ['withdrawn', withdrawal(1, 'group-dm', 42)],
    ['fixed', { v: 1, kind: 'fixed', seq: 1, parts: ['competing part'] }],
  ]
  test.each(COMPETING.flatMap(([kind, record]) => (['during the lookups', 'while a retry is scheduled'] as const).map(when => [kind, when, record] as const)))('a competing durable %s record that lands %s wins, with no replacement outcome or line', async (kind, when, record) => {
    const h = await harness(), p = preparer(h)
    // This preparation alone would withdraw the item as externally shared.
    p.stub.script.info.push(conversation({ ...PUBLIC, is_ext_shared: true }))
    const item = await acceptReaction(h, reaction({ mode: 'fungible' }))
    if (when === 'during the lookups') {
      const replies = heldCall()
      p.stub.script.replies.push(replies.outcome)
      const preparing = p.preparation.prepare('alpha', item)
      await h.clock.flush()
      await h.queue.append('alpha', record)
      replies.settle(exact())
      await preparing
    } else {
      h.failAppend('withdrawn')
      await expect(p.preparation.prepare('alpha', item)).rejects.toThrow('injected append failure')
      await h.queue.append('alpha', record)
      await h.clock.advance(RETYPE_BACKOFF_MS[0])
    }
    expect(outcomes(h)).toEqual([record])
    expect(p.logs).toEqual([])
    expect(p.wakes).toEqual(kind === 'fixed' ? ['alpha'] : [])
    expect(lookups(p)).toBe(3)
    expect(p.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
  })
})

describe('closed and fixed reaction preparation recovery', () => {
  /** A new preparation with spied lookups over the harness queue, clock and engine. */
  function spied(h: EngineHarness) {
    const lookups: string[] = [], wakes: string[] = [], logs: string[] = []
    diagnostics.push(logs)
    const preparation = createDeliveryPreparation({ queue: h.queue, clock: h.clock,
      resolveUserName: async (_key, user) => { lookups.push(`user:${user}`); return 'sender' },
      clientFor: key => { lookups.push(`client:${key}`); return undefined },
      wake: key => { wakes.push(key); h.engine.wake(key) },
      log: line => { logs.push(line) }, persona: () => PERSONA,
    })
    preparations.push(preparation)
    return { preparation, lookups, wakes, logs }
  }

  const WITHDRAWN_VIA = ['recover live', 'recover reopened', 'prepare a stale snapshot'] as const
  test.each((['appended', 'decided by a stopped preparation'] as const).flatMap(made => WITHDRAWN_VIA.map(via => [via, made] as const)))('a durably withdrawn reaction: %s causes no lookup, fixation, retry, wake or line (%s)', async (via, made) => {
    const h = await harness()
    let stale: QueueItem
    if (made === 'appended') {
      stale = await acceptReaction(h)
      await h.queue.append('alpha', { v: 1, kind: 'withdrawn', seq: 1, reason: 'server-post', at: h.clock.now() })
    } else {
      const first = preparer(h)
      first.stub.script.replies.push(exact(SERVER_POST))
      stale = await acceptReaction(h, reaction())
      await first.preparation.prepare('alpha', stale)
      await first.preparation.stop()
      expect(outcomes(h)).toEqual([withdrawal(1, 'server-post', START)])
      expect(first.logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'server-post')])
    }
    if (via === 'recover reopened') await h.restartServer()
    const s = spied(h), journal = h.records(), timers = h.clock.pendingCount()
    if (via === 'prepare a stale snapshot') await s.preparation.prepare('alpha', stale)
    else await s.preparation.recover()
    await h.clock.flush()
    expect(s.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(timers)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(s.lookups).toEqual([])
    expect(s.wakes).toEqual([])
    expect(s.logs).toEqual([])
    expect(h.records()).toEqual(journal)
    expect(h.queue.openCount('alpha')).toBe(0)
    expect(h.queue.item('alpha', 1)?.fixed).toBeUndefined()
  })

  const FIXED_MADE = ['appended', 'decided by a stopped preparation', 'decided for a bot-tool item by a stopped preparation'] as const
  test.each(FIXED_MADE.flatMap(made => (['recover', 'prepare a stale snapshot'] as const).map(via => [via, made] as const)))('a durably fixed reaction keeps its exact parts through reopen and %s, without lookups or a line, and its wake delivers them (%s)', async (via, made) => {
    const h = await harness()
    let stale: QueueItem, parts: string[]
    if (made === 'appended') {
      parts = ['reaction part one 🙂', 'reaction part two']
      stale = await acceptReaction(h, reactionInput({ origin: 'bot-tool', reactor_persona_name: 'Reactor Bot', user: undefined, bot_id: 'B0BOT001' }))
      await h.queue.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: [...parts] })
    } else {
      const botTool = made === 'decided for a bot-tool item by a stopped preparation'
      const first = preparer(h)
      first.stub.script.replies.push({ kind: 'ok', result: { messages: [] } })
      first.stub.script.info.push(conversation(PUBLIC))
      stale = await acceptReaction(h, botTool ? botToolReaction() : reaction())
      await first.preparation.prepare('alpha', stale)
      await first.preparation.stop()
      parts = buildTagParts(botTool ? notice({ user: STORED_B_NAME, user_id: B_USER }) : notice())
      expect(first.logs).toEqual([buildReactionMessageUnknownLine(SUBJECT)])
      expect(first.resolvedBy).toEqual({ [PERSONA.key]: botTool ? [] : ['U0REACTOR'], [BETA.key]: [] })
    }
    const fixed: FixedRecord = { v: 1, kind: 'fixed', seq: 1, parts }
    await h.restartServer()
    const s = spied(h)
    if (via === 'recover') await s.preparation.recover()
    else await s.preparation.prepare('alpha', stale)
    expect(s.lookups).toEqual([])
    expect(s.wakes).toEqual(['alpha'])
    expect(s.preparation.owns('alpha', 1)).toBe(false)
    expect(h.queue.item('alpha', 1)!.fixed).toEqual(fixed)
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.textCalls().map(c => c.params.text)).toEqual(parts)
    expect(h.records().filter(r => r.kind === 'fixed')).toEqual([fixed])
    expect(s.lookups).toEqual([])
    expect(s.logs).toEqual([])
    expect(h.errors).toEqual([])
  })

  const ACCEPTED_ONLY = (['fungible', 'declarative'] as const).flatMap(mode => (['slack-event', 'bot-tool'] as const).map(origin => [mode, origin] as const))
  test.each(ACCEPTED_ONLY)('an accepted-only %s %s reaction whose append failed before a stop is decided afresh, under its stored mode and with its stored name, by a new preparation after reopen', async (mode, origin) => {
    const botTool = origin === 'bot-tool'
    const h = await harness()
    const first = preparer(h)
    first.stub.script.replies.push(exact({ thread_ts: ROOT_TS }))
    first.stub.script.info.push(conversation(PUBLIC))
    h.failAppend('fixed')
    const item = await acceptReaction(h, botTool ? botToolReaction({ mode }) : reaction({ mode }))
    await expect(first.preparation.prepare('alpha', item)).rejects.toThrow('injected append failure')
    await first.preparation.stop()
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    await h.restartServer()
    const reopened = h.queue.item('alpha', 1)!.accepted
    expect([reopened.mode, reopened.origin, reopened.reactor_persona_name]).toEqual([mode, origin, botTool ? STORED_B_NAME : undefined])
    // The new start sees different facts: the conversation lookup now fails. Every reactor
    // now resolves to a new name and BETA is no longer a persona, so only a stored name survives.
    const asked: string[] = []
    const second = preparer(h, {
      resolve: async user => `Renamed ${user}`,
      persona: key => { asked.push(key); return key === PERSONA.key ? PERSONA : undefined },
    })
    second.stub.script.replies.push(exact({ thread_ts: ROOT_TS }))
    second.stub.script.info.push({ kind: 'platform', error: 'internal_error' })
    const at = h.clock.now()
    await second.preparation.recover()
    expect(methods(second.stub)).toEqual(['conversations.info', 'conversations.replies'])
    expect([first.resolvedBy, second.resolvedBy, second.stubs[BETA.key]!.callLog]).toEqual([
      { [PERSONA.key]: botTool ? [] : ['U0REACTOR'], [BETA.key]: [] },
      { [PERSONA.key]: botTool ? [] : ['U0REACTOR'], [BETA.key]: [] },
      [],
    ])
    expect(asked).not.toContain(BETA.key)
    if (mode === 'fungible') {
      expect(outcomes(h)).toEqual([withdrawal(1, 'conversation-unknown', at)])
      expect(second.logs).toEqual([buildReactionWithdrawnLine(SUBJECT, 'conversation-unknown')])
    } else {
      const reactor = botTool ? { user: STORED_B_NAME, user_id: B_USER } : { user: 'Renamed U0REACTOR' }
      expect(outcomes(h)).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: buildTagParts(notice({ channel_name: CHANNEL, thread_ts: ROOT_TS, ...reactor })) }])
      expect(second.logs).toEqual([])
    }
    expect(first.logs).toEqual([])
    expect(second.preparation.owns('alpha', 1)).toBe(false)
    assertNoLeak({ journal: writtenFile(queuePath(h.root)) })
  })
})

describe('ordinary items when a persona is forgotten or the preparation stops', () => {
  const info = (name: string): SettledWebApiOutcome => ({ kind: 'ok', result: { channel: { id: CHANNEL, name, is_channel: true } } })
  async function acceptOrdinary(h: EngineHarness): Promise<QueueItem> {
    const result = await h.queue.accept(PERSONA.key, slackInput({ channel: CHANNEL, key: { chat_id: CHANNEL, ts: REACTED_TS }, ts: REACTED_TS, text: 'ordinary text' }))
    if (result.status !== 'accepted') throw new Error('fixture acceptance failed')
    return result.item!
  }

  test.each(['forget', 'stop'] as const)('%s while a Slack item\'s lookups are held: forget appends, wakes and retries nothing and the key added again looks up afresh; stop still appends but wakes nothing', async how => {
    const h = await harness(), p = preparer(h)
    const held = heldCall()
    p.stub.script.info.push(held.outcome)
    const item = await acceptOrdinary(h), seq = item.accepted.seq
    const preparing = p.preparation.prepare(PERSONA.key, item)
    await h.clock.flush()
    expect(p.stub.calls.conversationsInfo).toHaveLength(1)
    let stopping: Promise<void> = Promise.resolve()
    if (how === 'stop') stopping = p.preparation.stop()
    else {
      p.preparation.forget(PERSONA.key)
      expect(p.preparation.owns(PERSONA.key, seq)).toBe(false)
    }
    held.settle(info('old-name'))
    await preparing
    await stopping
    expect(p.wakes).toEqual([])
    expect(p.preparation.owns(PERSONA.key, seq)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    if (how === 'stop') {
      // Shutdown drains the lookup to its append, as it always has.
      expect(outcomes(h, seq).map(r => r.kind)).toEqual(['fixed'])
      expect(h.queue.item(PERSONA.key, seq)!.fixed!.parts.join('')).toContain('channel_name="old-name"')
    } else {
      expect(h.records().map(r => r.kind)).toEqual(['accepted'])
      await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
      expect(h.records().map(r => r.kind)).toEqual(['accepted'])
      // The persona added again keeps none of the old life's channel names.
      p.stub.script.info.push(info('new-name'))
      await p.preparation.prepare(PERSONA.key, item)
      expect(p.stub.calls.conversationsInfo).toHaveLength(2)
      const parts = h.queue.item(PERSONA.key, seq)!.fixed!.parts.join('')
      expect(parts).toContain('channel_name="new-name"')
      expect(parts).toContain('ordinary text')
      expect(p.wakes).toEqual([PERSONA.key])
    }
    expect(p.logs).toEqual([])
  })

  test('injected work accepted just before its persona is forgotten is not prepared by the forgotten life; the key added again prepares it', async () => {
    const h = await harness(), p = preparer(h)
    const result = await p.preparation.accept(PERSONA.key, injectedInput({ text: 'injected text' }))
    if (result.status === 'failed') throw new Error('fixture acceptance failed')
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([0])
    p.preparation.forget(PERSONA.key)
    await h.clock.advance(1)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.records().map(r => r.kind)).toEqual(['accepted'])
    expect(p.wakes).toEqual([])
    expect(p.preparation.owns(PERSONA.key, result.seq)).toBe(false)
    await p.preparation.prepare(PERSONA.key, result.item!)
    expect(outcomes(h, result.seq).map(r => r.kind)).toEqual(['fixed'])
    expect(h.queue.item(PERSONA.key, result.seq)!.fixed!.parts.join('')).toContain('injected text')
    expect(p.wakes).toEqual([PERSONA.key])
  })
})
