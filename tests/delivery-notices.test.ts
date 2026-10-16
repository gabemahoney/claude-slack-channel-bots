/** b.omv SR-8: notice decisions only; engine/intake/ack suites own their transitions. */
import { afterEach, expect, test } from 'bun:test'
import { DELIVERY_STUCK_AFTER_MS, RECONNECT_BLOCKED_NOTICE_MS } from '../src/delivery-constants.ts'
import { deliveryStuckRemedy, buildDeliveryDiagnostic, buildMessageNotTakenInNotice, deliveryIdentity, QUEUE_UNWRITABLE, QUEUE_KEPT, MESSAGE_RECEIVED, MESSAGE_RETYPED, MESSAGE_NOT_TAKEN_IN, buildDeliveryStuckNotice, buildMessagesWaitingNotice, buildMessageNotSavedNotice, buildQueueRecordUnreadableNotice, type DeliveryStuckReason, type DeliveryReportState } from '../src/delivery-notices.ts'
import type { DeliveryReason, DeliveryStatus } from '../src/delivery-engine.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from '../src/conflict-latch.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { replyEntry, appendTranscript } from './test-helpers/working-row-panes.ts'
import { makeDeliveryNoticeHarness, type DeliveryNoticeHarness } from './test-helpers/delivery-notices.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
const runs: DeliveryNoticeHarness[] = []
async function run() { const h = await makeDeliveryNoticeHarness(); runs.push(h); return h }
afterEach(async () => { for (const r of runs.splice(0)) { try { assertNoLeak({ logs: r.logs, posts: r.h.allPosts(), lines: r.rig.lines }) } finally { await r.cleanup() } } })

// The sole literal wording pin for this notice module; behavior uses its builders.
test('SR-8 delivery notices and all nine fixed remedies keep their required wording', () => {
  expect(reasons.map(([reason]) => deliveryStuckRemedy(reason, 'alpha', 3))).toEqual([
    'A menu, overlay or dialog is open in its terminal. Attach with `tmux attach -t =slack_bot_alpha` and close it.',
    'Text is left in its input box. Attach with `tmux attach -t =slack_bot_alpha` and submit or clear it.',
    "Its permission relay is off. Restart the persona's bot.",
    "It is not connected to this server over MCP. Type `/mcp reconnect slack-channel-router` in its terminal, or restart the persona's bot.",
    'agent-director keeps refusing to type into it. Check its state with `agent-director get --instance-id cscb_alpha`.',
    "Its transcript can't be read, so CSCB can't confirm delivery and keeps offering the message. Check that the transcript exists and that the server's user can read it.",
    "CSCB can't write its queue file, so it types nothing more for this persona until it can. Check the server's disk.",
    "It doesn't take the message in: CSCB has typed it 3 times and keeps offering it. Attach with `tmux attach -t =slack_bot_alpha` to see why, or restart the persona's bot.",
    "agent-director won't type into it until it can prove an answered permission prompt is gone; a subagent's denied prompt stays held until the bot ends. Restart the persona's bot.",
  ])
  expect(buildDeliveryStuckNotice('Alpha', 'alpha', 2, DELIVERY_STUCK_AFTER_MS, 'menu', 3)).toBe(
    ':warning: *Delivery stuck* — 2 message(s) for Alpha are waiting; the oldest has waited 5m. ' + deliveryStuckRemedy('menu', 'alpha', 3) + ' ' + CONFLICT_NOTICE_HUMAN_ONLY_LINE)
  expect(buildMessageNotSavedNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not saved* — a message from U0SENDER1 for Alpha could not be saved. Slack will send it again a few times; it is delivered if one copy is saved, otherwise it is lost and should be sent again. Further messages to this persona may fail the same way until storing works; server.log counts them. Check the server's disk.")
  expect(buildMessageNotTakenInNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not taken in* — the message from U0SENDER1 for Alpha is still queued. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.")
  expect(buildMessagesWaitingNotice('Alpha', 2, DELIVERY_STUCK_AFTER_MS, 'down')).toBe(':warning: *Messages waiting* — 2 message(s) for Alpha are waiting; the oldest has waited 5m. The persona is down. The messages are kept and delivered once the persona is up.')
  expect(buildQueueRecordUnreadableNotice('Alpha', 2, '/scratch/quarantine')).toBe(':warning: *Queue record unreadable* — 2 queued message(s) for Alpha could not be read at start and will not be delivered. Their bytes are kept in `/scratch/quarantine`. Ask the senders to send them again.')
})

const reasons: [DeliveryStuckReason, DeliveryReason, Partial<DeliveryStatus>][] = [
  ['menu', 'menu', {}], ['input', 'input', {}], ['relay-off', 'relay-off', {}], ['mcp', 'mcp', {}],
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
  r.waiting(item, 'input', { ageMs: DELIVERY_STUCK_AFTER_MS + 100 }); await r.flush()
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
  ['bring-up not up', { up: false }, {}, 'menu'], ['not-up down persona', { up: false }, { row: 'ended' }, 'menu'], ['outage', { outage: true }, {}, 'menu'],
  ['native prompt or waiting/not-connected episode', { prompt: true }, {}, 'menu'], ['launch episode', { launch: true }, {}, 'menu'],
  ['pending row', {}, { row: 'pending' }, 'menu'], ['permission row', {}, { row: 'check_permission' }, 'menu'],
  ['working with dialog uncertainty', {}, { row: 'working', dialogMaybeOpen: true }, 'dialog-hold'],
  ['working with typed text', {}, { row: 'working', receiptWorking: true }, 'receipt'],
  ['working receipt wait', {}, { row: 'working' }, 'receipt'], ['deferred reconnect', {}, { reconnectDeferred: true, reconnectScreen: 'input' }, 'mcp'],
  ['waiting takes precedence', { latched: true }, {}, 'menu'],
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
  await r.accept()
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

test.each(['menu', 'input'] as const)('%s reconnect block reports at five minutes even with no queued item', async reason => {
  const r = await run()
  r.reporting.engineEvent({ type: 'reconnect-screen', key: r.alpha, reason, blockedMs: RECONNECT_BLOCKED_NOTICE_MS - 1 })
  expect(r.blocked).toEqual([])
  r.reporting.engineEvent({ type: 'reconnect-screen', key: r.alpha, reason, blockedMs: RECONNECT_BLOCKED_NOTICE_MS })
  expect(r.blocked).toEqual([{ key: r.alpha, rule: reason }])
  expect(r.queue.openCount(r.alpha)).toBe(0)
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
