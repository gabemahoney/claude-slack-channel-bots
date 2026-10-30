/** notice decisions only; engine/intake/ack suites own their transitions. */
import { afterEach, expect, test } from 'bun:test'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from '../src/conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS } from '../src/delivery-constants.ts'
import type { DeliveryReason, DeliveryStatus } from '../src/delivery-engine.ts'
import { buildDeliveryDiagnostic, buildDeliveryStuckNotice, buildMessageNotSavedNotice, buildMessageNotTakenInNotice, buildMessagesWaitingNotice, buildQueueRecordUnreadableNotice, deliveryIdentity, deliveryStuckRemedy, MESSAGE_NOT_TAKEN_IN, MESSAGE_RECEIVED, MESSAGE_RETYPED, QUEUE_KEPT, QUEUE_UNWRITABLE, type DeliveryReportState, type DeliveryStuckReason } from '../src/delivery-notices.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { assertNoLeak, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { makeDeliveryNoticeHarness, type DeliveryNoticeHarness } from './test-helpers/delivery-notices.ts'
import { appendTranscript, replyEntry } from './test-helpers/working-row-panes.ts'
import { MESSAGE_DELIVERED } from '../src/persona-diagnostics.ts'
import { heldSlackInput, memoryHold, slackInput } from './test-helpers/delivery-queue.ts'
import { THREAD_ROOTS } from './test-helpers/thread-memory.ts'
const runs: DeliveryNoticeHarness[] = []
async function run(options: Parameters<typeof makeDeliveryNoticeHarness>[0] = {}) { const h = await makeDeliveryNoticeHarness(options); runs.push(h); return h }
afterEach(async () => { for (const r of runs.splice(0)) { try {
  const path = join(r.root, 'queue')
  assertNoLeak({ logs: r.logs, posts: r.h.allPosts(), lines: r.rig.lines, queue: existsSync(path) ? writtenFile(path) : undefined })
} finally { await r.cleanup() } } })

async function noticeHold(r: DeliveryNoticeHarness, ts: string = THREAD_ROOTS.secondary) {
  const input = heldSlackInput(memoryHold(r.h.clock.now()), { ts, key: { chat_id: 'C0TEST001', ts }, text: 'private held reply' })
  const result = await r.queue.acceptDecided(r.alpha, input.key, () => ({ store: input }))
  if (result.status !== 'accepted') throw new Error('hold fixture acceptance failed')
  return result.item!
}

test('Memory Holds and withdrawals stay quiet through queued reconciliation and late waiting events', async () => {
  const r = await run({ holds: true }), held = await noticeHold(r), withdrawn = await noticeHold(r, THREAD_ROOTS.third)
  await r.queue.resolveHolds(r.alpha, [{ seq: withdrawn.accepted.seq, outcome: 'withdrawn', at: r.h.clock.now() }])
  await r.h.clock.advance(DELIVERY_STUCK_AFTER_MS * 2)
  for (const item of r.queue.items(r.alpha)) {
    r.reporting.received(r.alpha, item)
    r.waiting(item, 'not-now')
    r.waiting(item, 'state', { row: 'ended' })
  }
  r.reporting.reconcileQueued(r.alpha)
  await r.flush()
  expect(r.queued).toEqual([])
  expect(r.logs).toEqual([])
  expect(r.h.totalPosts()).toBe(0)
  expect(r.delivered).toEqual([])

  await r.queue.resolveHolds(r.alpha, [{ seq: held.accepted.seq, outcome: 'released', at: r.h.clock.now() }])
  const released = r.queue.item(r.alpha, held.accepted.seq)!
  r.reporting.received(r.alpha, released)
  r.reporting.reconcileQueued(r.alpha)
  expect(r.queued.map(q => [q.key, q.item.accepted.seq])).toEqual([[r.alpha, held.accepted.seq], [r.alpha, held.accepted.seq]])
  r.waiting(released, 'state', { row: 'ended' }); await r.flush()
  expect(r.h.posts(r.alpha).map(p => p.text)).toEqual([formatPersonaNotice(r.config.personas[0]!, buildMessagesWaitingNotice(r.ref(), 1, 0, 'down'))])
  expect(r.h.posts(r.beta)).toEqual([])
  expect(JSON.stringify({ logs: r.logs, posts: r.h.allPosts() })).not.toContain('private held reply')
  assertNoLeak(r.queued)
})

test('Memory Hold release starts the real engine stuck clock at release', async () => {
  let r: DeliveryNoticeHarness | undefined
  const e = await makeEngineHarness({ onEvent: event => r?.reporting.engineEvent(event) })
  r = await run({ queue: e.queue, holds: true })
  try {
    const held = await noticeHold(r), withdrawn = await noticeHold(r, THREAD_ROOTS.third)
    await e.queue.resolveHolds(r.alpha, [{ seq: withdrawn.accepted.seq, outcome: 'withdrawn', at: e.clock.now() }])
    e.p().row.relay_mode = 'off'
    await e.tick()
    await e.advance(DELIVERY_STUCK_AFTER_MS * 2)
    expect(r.h.totalPosts()).toBe(0)
    const releasedAt = e.clock.now()
    await e.queue.resolveHolds(r.alpha, [{ seq: held.accepted.seq, outcome: 'released', at: releasedAt }])
    await e.preparation.recover()
    await e.tick()
    await e.advance(DELIVERY_STUCK_AFTER_MS)
    expect(e.engine.status(r.alpha)).toMatchObject({ count: 1, ageMs: DELIVERY_STUCK_AFTER_MS })
    await r.flush()
    expect(r.h.totalPosts()).toBe(0)
    await e.advance(1); await e.tick(); await r.flush()
    expect(r.h.posts(r.alpha).map(p => p.text)).toEqual([formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, 1, DELIVERY_STUCK_AFTER_MS + 1, 'relay-off', 1))])
    expect(e.keyCalls()).toEqual([])
    expect(e.errors).toEqual([])
    expect(r.h.posts(r.beta)).toEqual([])
    expect(JSON.stringify({ logs: r.logs, posts: r.h.allPosts() })).not.toContain('private held reply')
    assertNoLeak([e.events, e.calls, e.errors])
  } finally { await e.cleanup() }
})

test('later in-flight completion does not move a released head back to an unresolved or withdrawn hold', async () => {
  const r = await run({ holds: true })
  const unresolved = await noticeHold(r), withdrawn = await noticeHold(r, THREAD_ROOTS.third)
  const released = await noticeHold(r, THREAD_ROOTS.primary)
  const later = await r.accept({ key: { chat_id: 'C0TEST001', ts: 'later' } })
  await r.queue.resolveHolds(r.alpha, [
    { seq: withdrawn.accepted.seq, outcome: 'withdrawn', at: r.h.clock.now() },
    { seq: released.accepted.seq, outcome: 'released', at: r.h.clock.now() },
  ])
  const head = r.queue.item(r.alpha, released.accepted.seq)!
  r.waiting(head, 'state', { row: 'ended' }); await r.flush()
  expect(r.rig.episodes.isOpen(r.alpha, 'messages-waiting')).toBe(true)
  // Completion of an item already in flight can follow release of this older head.
  await r.complete(later)
  expect(r.rig.episodes.isOpen(r.alpha, 'messages-waiting')).toBe(true)
  r.waiting(head, 'state', { row: 'ended' }); await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(1)
  expect(r.delivered.map(d => d.item.accepted.seq)).toEqual([later.accepted.seq])
  expect(r.queue.item(r.alpha, unresolved.accepted.seq)?.fixed).toBeUndefined()
  expect(r.queue.item(r.alpha, withdrawn.accepted.seq)?.fixed).toBeUndefined()
  expect(r.queued).toEqual([])
})

test('launch timing diagnostics preserve structured engine evidence without posting a notice or requiring queued work', async () => {
  // the real-agent timing assertion consumes these JSON facts.
  const r = await run()
  const events = [
    { type: 'launch-observed' as const, key: r.alpha, sessionId: 'session\\one', at: 137 },
    { type: 'launch-first-waiting' as const, key: r.alpha, sessionId: 'session\\one', at: 971 },
    { type: 'launch-observed' as const, key: r.beta, sessionId: 'session-two', at: 2001 },
  ]
  for (const event of events) r.reporting.engineEvent(event)
  await r.flush()
  expect(r.logs).toHaveLength(events.length)
  for (const [i, event] of events.entries()) {
    const prefix = `[slack] delivery-${event.type}: `
    expect(r.logs[i]!.startsWith(prefix)).toBe(true)
    expect(JSON.parse(r.logs[i]!.slice(prefix.length))).toEqual({ key: event.key, session_id: event.sessionId, at: event.at })
  }
  expect(r.h.totalPosts()).toBe(0)
  expect(r.queue.items(r.alpha)).toEqual([])
  expect(r.queue.items(r.beta)).toEqual([])
})

test('late AD transcript references retain their identity in redacted diagnostics without a Slack notice', async () => {
  const r = await run(), prefix = '[slack] delivery-transcript-reference: '
  r.reporting.engineEvent({ type: 'transcript-reference', key: r.alpha, instanceId: `cscb_${r.alpha}`, sessionId: 'native-session', path: '/native/native-session.jsonl', at: 1500 })
  const secret = sentinelInMessage('late-reference')
  r.reporting.engineEvent({ type: 'transcript-reference', key: r.alpha, instanceId: secret, sessionId: secret, path: secret, at: 2500 })
  await r.flush()
  expect(r.logs).toHaveLength(2)
  expect(JSON.parse(r.logs[0]!.slice(prefix.length))).toEqual({
    key: r.alpha, instance_id: `cscb_${r.alpha}`, session_id: 'native-session', jsonl_path: '/native/native-session.jsonl', at: 1500,
  })
  expect(r.logs[1]).not.toContain(secret)
  assertNoLeak(r.logs)
  expect(r.h.totalPosts()).toBe(0)
})

// The sole literal wording pin for this notice module; behavior uses its builders.
test('delivery notices and all nine fixed remedies keep their required wording', () => {
  expect(reasons.map(([reason]) => deliveryStuckRemedy(reason, 'alpha', 3))).toEqual([
    "Its permission relay is off. Restart the persona's bot.",
    "It is not connected to this server over MCP. Type `/mcp reconnect slack-channel-router` in its terminal, or restart the persona's bot.",
    'agent-director keeps refusing to type into it. Check its state with `agent-director get --instance-id cscb_alpha`.',
    "Its transcript can't be read, so CSCB can't confirm delivery and keeps offering the message. Check that the transcript exists and that the server's user can read it.",
    "CSCB can't write its queue file, so it types nothing more for this persona until it can. Check the server's disk.",
    "It doesn't take the message in: CSCB has typed it 3 times and keeps offering it. Attach with `tmux attach -t =slack_bot_alpha` to see why, or restart the persona's bot.",
    "agent-director won't type into it until it can prove an answered permission prompt is gone; a subagent's denied prompt stays held until the bot ends. Restart the persona's bot.",
  ])
  expect(buildDeliveryStuckNotice('Alpha', 'alpha', 2, DELIVERY_STUCK_AFTER_MS, 'refused', 3)).toBe(
    ':warning: *Delivery stuck* — 2 message(s) for Alpha are waiting; the oldest has waited 5m. ' + deliveryStuckRemedy('refused', 'alpha', 3) + ' ' + CONFLICT_NOTICE_HUMAN_ONLY_LINE)
  expect(buildMessageNotSavedNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not saved* — a message from U0SENDER1 for Alpha could not be saved. Slack will send it again a few times; it is delivered if one copy is saved, otherwise it is lost and should be sent again. Further messages to this persona may fail the same way until storing works; server.log counts them. Check the server's disk.")
  expect(buildMessageNotTakenInNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not taken in* — the message from U0SENDER1 for Alpha is still queued. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.")
  expect(buildMessagesWaitingNotice('Alpha', 2, DELIVERY_STUCK_AFTER_MS, 'down')).toBe(':warning: *Messages waiting* — 2 message(s) for Alpha are waiting; the oldest has waited 5m. The persona is down. The messages are kept and delivered once the persona is up.')
  expect(buildQueueRecordUnreadableNotice('Alpha', 2, '/scratch/quarantine')).toBe(':warning: *Queue record unreadable* — 2 queued message(s) for Alpha could not be read at start and will not be delivered. Their bytes are kept in `/scratch/quarantine`. Ask the senders to send them again.')
})

const reasons: [DeliveryStuckReason, DeliveryReason, Partial<DeliveryStatus>][] = [
  ['relay-off', 'relay-off', {}], ['mcp', 'mcp', {}],
  ['refused', 'not-now', {}], ['transcript', 'transcript-unreadable', {}], ['queue-unwritable', 'queue-unwritable', {}],
  ['not-taken-in', 'receipt', { retypeCount: 3 }], ['dialog-hold', 'dialog-hold', {}],
]
test.each(reasons)('%s: over five minutes, once until queue progress; only the owning destination sees it', async (reason, engineReason, patch) => {
  const r = await run(), body = 'ordinary body must stay private', item = await r.accept({ text: body, channel: 'C0SOURCE1' })
  r.waiting(item, engineReason, { ageMs: DELIVERY_STUCK_AFTER_MS, ...patch }); await r.flush()
  expect(r.h.totalPosts()).toBe(0)
  r.waiting(item, engineReason, { ageMs: DELIVERY_STUCK_AFTER_MS + 1, ...patch }); await r.flush()
  const posts = r.h.posts(r.alpha)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ channel: 'C0ALPHA01', text: formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, 1, DELIVERY_STUCK_AFTER_MS + 1, reason, (patch.retypeCount ?? 0) + 1)) })
  expect(posts[0]!.text.endsWith(CONFLICT_NOTICE_HUMAN_ONLY_LINE)).toBe(true)
  expect(JSON.stringify({ logs: r.logs, posts })).not.toContain(body)
  await r.accept({ key: { chat_id: 'C0SOURCE1', ts: 'later' } })
  r.waiting(item, 'not-now', { ageMs: DELIVERY_STUCK_AFTER_MS + 100 }); await r.flush()
  expect(posts).toHaveLength(1)
  expect(r.h.posts(r.beta)).toEqual([])
  expect(posts.filter(p => p.channel === 'C0SOURCE1')).toEqual([])
  const next = r.queue.items(r.alpha)[1]!
  await r.complete(item)
  r.waiting(next, engineReason, { ageMs: DELIVERY_STUCK_AFTER_MS + 1, ...patch }); await r.flush()
  expect(posts).toHaveLength(2)
})

const waiting: [string, Partial<DeliveryReportState>, Partial<DeliveryStatus>][] = [
  ['down', {}, { row: 'ended' }], ['down at its restart limit', { atRestartLimit: true }, { row: 'missing' }],
  ['down with automatic restarts off', { restartsOff: true }, { row: 'absent' }], ['latched', { latched: true }, {}],
  ['held on invalid flags', { invalidFlags: true }, {}], ['held after a failed kill', { killFailed: true }, {}],
  ['waiting on an old life', { oldLife: true }, {}], ['waiting for its upgrade replacement', { upgrade: true }, {}],
]
test.each(waiting)('%s: waiting immediately, extra work/state alone does not start another episode', async (state, report, status) => {
  const r = await run(), item = await r.accept()
  Object.assign(r.states.get(r.alpha)!, report)
  r.waiting(item, 'state', status); await r.flush()
  expect(r.h.posts(r.alpha)).toMatchObject([{ channel: 'C0ALPHA01', text: formatPersonaNotice(r.config.personas[0]!, buildMessagesWaitingNotice(r.ref(), 1, 0, state as Parameters<typeof buildMessagesWaitingNotice>[3])) }])
  await r.accept({ key: { chat_id: 'C0SOURCE1', ts: 'later' } })
  Object.assign(r.states.get(r.alpha)!, { latched: true })
  r.waiting(item, 'held', { row: 'missing', ageMs: DELIVERY_STUCK_AFTER_MS + 1 }); await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(1)
  expect(r.h.posts(r.beta)).toEqual([])
})

const suppressions: [string, Partial<DeliveryReportState>, Partial<DeliveryStatus>, DeliveryReason][] = [
  ['bring-up not up', { up: false }, {}, 'not-now'], ['not-up down persona', { up: false }, { row: 'ended' }, 'not-now'], ['outage', { outage: true }, {}, 'not-now'],
  ['native prompt or waiting/not-connected episode', { prompt: true }, {}, 'not-now'], ['launch episode', { launch: true }, {}, 'not-now'],
  ['pending row', {}, { row: 'pending' }, 'not-now'], ['permission row', {}, { row: 'check_permission' }, 'not-now'],
  ['working with dialog uncertainty', {}, { row: 'working', dialogMaybeOpen: true }, 'dialog-hold'],
  ['working with typed text', {}, { row: 'working', receiptWorking: true }, 'receipt'],
  ['working receipt wait', {}, { row: 'working' }, 'receipt'],
  ['waiting takes precedence', { latched: true }, {}, 'not-now'],
]
test.each(suppressions)('%s suppresses delivery stuck', async (_label, state, status, reason) => {
  const r = await run(), item = await r.accept()
  Object.assign(r.states.get(r.alpha)!, state)
  r.waiting(item, reason, { ageMs: DELIVERY_STUCK_AFTER_MS + 1, ...status }); await r.flush()
  expect(r.h.posts(r.alpha).filter(p => p.text.includes('*Delivery stuck*'))).toEqual([])
})
test('a generic reconnect deferral still reports MCP delivery stuck after the threshold', async () => {
  const r = await run(), item = await r.accept()
  r.waiting(item, 'mcp', { ageMs: DELIVERY_STUCK_AFTER_MS + 1, reconnectDeferred: true })
  await r.flush()
  expect(r.h.posts(r.alpha).map(post => post.text)).toEqual([formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, 1, DELIVERY_STUCK_AFTER_MS + 1, 'mcp', 1))])
  expect(r.h.posts(r.beta)).toEqual([])
})
test.each([{ atRestartLimit: true }, { restartsOff: true }])('a live persona with %j has no waiting notice', async state => {
  const r = await run(), item = await r.accept()
  Object.assign(r.states.get(r.alpha)!, state)
  r.waiting(item, 'state'); await r.flush()
  expect(r.h.totalPosts()).toBe(0)
})

test('injected failures count safely without consuming the first Slack notice; successful store resets', async () => {
  const r = await run(), error = Object.assign(new Error(sentinelInMessage('disk')), { code: 'ENOSPC' })
  for (const source of ['interject', 'cron'] as const) r.reporting.queueEvent({ type: 'store-failed', key: r.alpha, source, user: 'injected-sender', ts: '1', path: '/scratch/queue', error })
  await r.flush()
  expect(r.h.totalPosts()).toBe(0)
  for (const user of ['U0SENDER1', 'U0LATER01']) r.reporting.queueEvent({ type: 'store-failed', key: r.alpha, source: 'slack', user, ts: '2', path: '/scratch/queue', error })
  await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(1)
  expect(r.h.posts(r.alpha)).toMatchObject([{ channel: 'C0ALPHA01', text: formatPersonaNotice(r.config.personas[0]!, buildMessageNotSavedNotice(r.ref(), 'U0SENDER1')) }])
  expect(r.logs).toHaveLength(4)
  expect(r.logs.map(line => line.match(/count=(\d+)/)?.[1])).toEqual(['1', '2', '3', '4'])
  expect(r.rig.episodes.isOpen(r.alpha, 'message-not-saved')).toBe(true)
  await r.accept()
  expect(r.rig.episodes.isOpen(r.alpha, 'message-not-saved')).toBe(false)
  r.reporting.queueEvent({ type: 'store-failed', key: r.alpha, source: 'slack', user: 'U0SENDER2', error })
  await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(2)
  expect(r.h.posts(r.alpha)[1]!.text).toBe(formatPersonaNotice(r.config.personas[0]!, buildMessageNotSavedNotice(r.ref(), 'U0SENDER2')))
  expect(r.logs.at(-1)).toContain('count=1')
  expect(r.h.posts(r.beta)).toEqual([])
})

test('startup corruption aggregates each persona once and excludes torn tails/readable accepts', async () => {
  const r = await run()
  const findings = [true, true, false].map((alert, i) => ({ type: 'record-unreadable' as const, key: r.alpha, line: i + 1, quarantinePath: '/scratch/quarantine', alert }))
  r.reporting.startupFindings(findings); r.reporting.startupFindings(findings); await r.flush()
  expect(r.h.posts(r.alpha)).toMatchObject([{ channel: 'C0ALPHA01', text: formatPersonaNotice(r.config.personas[0]!, buildQueueRecordUnreadableNotice(r.ref(), 2, '/scratch/quarantine')) }])
  expect(r.h.posts(r.beta)).toEqual([])
})

test('unwritable and retained diagnostics contain only safe facts; one line until writability recovers', async () => {
  const r = await run(), error = Object.assign(new Error(sentinelInMessage('append')), { code: 'ENOSPC' })
  const failed = { type: 'append-failed' as const, key: r.alpha, path: '/scratch/queue', error }
  r.reporting.queueEvent(failed); r.reporting.queueEvent(failed)
  expect(r.logs).toEqual([buildDeliveryDiagnostic(QUEUE_UNWRITABLE, r.ref(), 'path="/scratch/queue" code=ENOSPC')])
  r.reporting.queueEvent({ type: 'writable', key: r.alpha }); r.reporting.queueEvent(failed)
  expect(r.logs).toHaveLength(2)
  r.reporting.queueEvent({ type: 'retained', key: r.alpha, count: 4 })
  expect(r.logs.at(-1)).toBe(buildDeliveryDiagnostic(QUEUE_KEPT, r.ref(), 'count=4'))
  expect(r.h.totalPosts()).toBe(0)
})
test('received is once per accepted identity, including replay preparation and final completion fallback', async () => {
  const r = await run(), item = await r.accept({ text: 'private accepted body' })
  r.reporting.received(r.alpha, item); r.reporting.received(r.alpha, item)
  expect(r.logs).toEqual([buildDeliveryDiagnostic(MESSAGE_RECEIVED, r.ref(), deliveryIdentity(item.accepted))])
  expect(JSON.stringify(r.logs)).not.toContain('private accepted body')
})
test.each([false, true])('received and delivered logs retain via=thread through real delivery (restart before delivery=%p)', async restart => {
  let reporting: DeliveryNoticeHarness | undefined
  const engine = await makeEngineHarness({ onEvent: event => reporting?.reporting.engineEvent(event) })
  const r = await makeDeliveryNoticeHarness({ queue: engine.queue }); runs.push(r)
  reporting = r
  try {
    const result = await engine.queue.accept('alpha', slackInput({ via: 'thread', thread_ts: THREAD_ROOTS.primary, text: 'private thread reply' }))
    if (result.status !== 'accepted') throw new Error('thread fixture acceptance failed')
    if (restart) await engine.restartServer()
    const item = engine.queue.items('alpha')[0]!
    expect(item.accepted.via).toBe('thread')
    expect(item.fixed).toBeUndefined()
    // Recovered accepted-only work enters the same preparation/reporting path.
    r.reporting.received('alpha', item)
    await engine.preparation.prepare('alpha', item)
    await engine.tick()
    await engine.until(() => engine.queue.openCount('alpha') === 0)
    await r.flush()
    const received = r.logs.filter(line => line.includes(MESSAGE_RECEIVED))
    const delivered = r.logs.filter(line => line.includes(MESSAGE_DELIVERED))
    expect(received).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    for (const line of [...received, ...delivered]) {
      expect(line).toContain(' via=thread')
      expect(line).toContain(`chat_id="${item.accepted.channel}"`)
      expect(line).not.toContain('private thread reply')
    }
    expect(engine.textCalls().map(call => call.params.text)).toEqual(engine.queue.items('alpha')[0]!.fixed!.parts)
    expect(engine.textCalls()[0]!.params.text).toContain('via="thread"')
    expect(engine.errors).toEqual([])
    assertNoLeak(r.logs)
  } finally { await engine.cleanup() }
})
test('the durable per-item not-taken-in notice survives server restart while retyping continues', async () => {
  let r: DeliveryNoticeHarness | undefined
  const e = await makeEngineHarness({ onEvent: event => r?.reporting.engineEvent(event) })
  r = await makeDeliveryNoticeHarness({ queue: e.queue }); runs.push(r)
  try {
    const item = await e.accept('not yet taken in')
    e.p().autoReceipt = false
    e.p().keyHook = params => { if (params.key === 'Enter') appendTranscript(e.p().path, [replyEntry()]); return undefined }
    await e.tick()
    await e.until(() => e.records().some(record => record.kind === 'noticed'))
    await r.flush()
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.posts(r.alpha)[0]!.text).toBe(formatPersonaNotice(r.config.personas[0]!, buildMessageNotTakenInNotice(r.ref(), 'interject')))
    expect(e.records().filter(record => record.kind === 'noticed')).toHaveLength(1)
    expect(r.logs.filter(line => line.includes(MESSAGE_NOT_TAKEN_IN))).toEqual([buildDeliveryDiagnostic(MESSAGE_NOT_TAKEN_IN, r.ref(), deliveryIdentity(item.accepted))])
    expect(r.logs.filter(line => line.includes(MESSAGE_RETYPED))).toEqual(e.events.flatMap(event => event.type === 'retyped' ? [buildDeliveryDiagnostic(MESSAGE_RETYPED, r!.ref(), deliveryIdentity(item.accepted), `retype_count=${event.count}`)] : []))
    expect(JSON.stringify(r.logs)).not.toContain('not yet taken in')
    const typedBefore = e.textCalls().length
    await e.restartServer()
    await e.until(() => e.textCalls().length > typedBefore)
    await r.flush()
    expect(e.records().filter(record => record.kind === 'noticed')).toHaveLength(1)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.posts(r.beta)).toEqual([])
  } finally { await e.cleanup() }
})

test('emptying the queue ends the waiting episode before new accepted work arrives', async () => {
  const r = await run(), item = await r.accept()
  Object.assign(r.states.get(r.alpha)!, { latched: true })
  r.waiting(item, 'held'); await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(1)
  await r.complete(item)
  expect(r.queue.openCount(r.alpha)).toBe(0)
  const next = await r.accept({ key: { chat_id: 'C0SOURCE1', ts: 'later' } })
  r.waiting(next, 'held'); await r.flush()
  expect(r.h.posts(r.alpha)).toHaveLength(2)
  expect(r.h.posts(r.beta)).toEqual([])
})
