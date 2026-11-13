/** notice decisions only; engine/intake/ack suites own their transitions. */
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from '../src/conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS, DELIVERY_ROW_POLL_MS, ENTER_DELAY_MS, THREAD_REPLY_HOLD_MS } from '../src/delivery-constants.ts'
import { NOTICE_CORRECTION_TIMEOUT_MS, type NoticeCorrectionOutcome } from '../src/notice-correction.ts'
import type { SlackKey } from '../src/delivery-queue.ts'
import type { DeliveryReason, DeliveryStatus } from '../src/delivery-engine.ts'
import { buildDeliveryDiagnostic, buildDeliveryStuckNotice, buildMessageNotSavedNotice, buildMessageSavedAfterRetryNotice, buildStorageNoticeRecoveryLine, buildMessageNotTakenInNotice, buildMessagesWaitingNotice, buildQueueRecordUnreadableNotice, deliveryIdentity, deliveryStuckRemedy, MESSAGE_NOT_TAKEN_IN, MESSAGE_RECEIVED, MESSAGE_RETYPED, QUEUE_KEPT, QUEUE_UNWRITABLE, type DeliveryReportState, type DeliveryStuckReason } from '../src/delivery-notices.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { MESSAGE_NOT_SAVED, MESSAGE_PARTIAL_RECEIPT, PERSONA_DESTINATION_FAILED } from '../src/persona-diagnostics.ts'
import { OWN_POST_CANCELLED } from '../src/persona-destination.ts'
import { holdOwnPostReady, makeRecordingOwnPostObserver, type OwnPostStep } from './test-helpers/own-post.ts'
import { assertNoLeak, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { existsSync } from 'node:fs'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { makeDeliveryNoticeHarness, makeStorageNoticeHarness, STORAGE_NOTICE_IDS, type DeliveryNoticeHarness, type StorageNoticeHarness } from './test-helpers/delivery-notices.ts'
import { injectedInput, readQueue } from './test-helpers/delivery-queue.ts'
import { partialReceiptText, partialReceiptSuffix } from './test-helpers/partial-receipt.ts'
import { openedDm } from './test-helpers/slack-stub.ts'
import { appendTranscript, pastedText, promptEntry, replyEntry } from './test-helpers/working-row-panes.ts'
import { MESSAGE_DELIVERED } from '../src/persona-diagnostics.ts'
import { heldSlackInput, HOLD_FIELDS, memoryHold, postHold, slackInput } from './test-helpers/delivery-queue.ts'
import type { HoldField } from '../src/delivery-queue.ts'
import { THREAD_ROOTS } from './test-helpers/thread-memory.ts'
const runs: DeliveryNoticeHarness[] = []
async function run(options: Parameters<typeof makeDeliveryNoticeHarness>[0] = {}) { const h = await makeDeliveryNoticeHarness(options); runs.push(h); return h }
afterEach(async () => { for (const r of runs.splice(0)) { try {
  const path = join(r.root, 'queue')
  assertNoLeak({ logs: r.logs, posts: r.h.allPosts(), lines: r.rig.lines, queue: existsSync(path) ? writtenFile(path) : undefined })
} finally { await r.cleanup() } } })

async function noticeHold(r: DeliveryNoticeHarness, ts: string = THREAD_ROOTS.secondary, field: (at: number) => HoldField = memoryHold) {
  const input = heldSlackInput(field(r.h.clock.now()), { ts, key: { chat_id: 'C0TEST001', ts }, text: 'private held reply' })
  const result = await r.queue.acceptDecided(r.alpha, input.key, () => ({ store: input }))
  if (result.status !== 'accepted') throw new Error('hold fixture acceptance failed')
  return result.item!
}

test.each(['memory', 'post'] as const)('%s holds and withdrawals stay quiet through queued reconciliation and late waiting events', async kind => {
  const field = HOLD_FIELDS[kind]
  const r = await run({ holds: true }), held = await noticeHold(r, THREAD_ROOTS.secondary, field), withdrawn = await noticeHold(r, THREAD_ROOTS.third, field)
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

test.each(['memory', 'post'] as const)('%s hold release starts the real engine stuck clock at release', async kind => {
  let r: DeliveryNoticeHarness | undefined
  const e = await makeEngineHarness({ onEvent: event => r?.reporting.engineEvent(event) })
  r = await run({ queue: e.queue, holds: true })
  try {
    const held = await noticeHold(r, THREAD_ROOTS.secondary, HOLD_FIELDS[kind]), withdrawn = await noticeHold(r, THREAD_ROOTS.third, HOLD_FIELDS[kind])
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

test('items behind an unresolved Post Hold keep their queued reactions and stuck notice, counted and timed without it', async () => {
  const r = await run({ holds: true }), held = await noticeHold(r, THREAD_ROOTS.secondary, postHold)
  const behind = [await r.accept({ key: { chat_id: 'C0TEST001', ts: 'behind-one' } }), await r.accept({ key: { chat_id: 'C0TEST001', ts: 'behind-two' } })]
  const seqs = behind.map(i => i.accepted.seq)
  for (const item of [held, ...behind]) r.reporting.received(r.alpha, item)
  r.reporting.reconcileQueued(r.alpha)
  expect(r.queued.map(q => q.item.accepted.seq)).toEqual([...seqs, ...seqs])
  await r.h.clock.advance(DELIVERY_STUCK_AFTER_MS + 1)
  r.waiting(held, 'not-now'); r.waiting(held, 'state', { row: 'ended' }); await r.flush()
  expect(r.h.totalPosts()).toBe(0)
  r.waiting(behind[0]!, 'not-now', { ageMs: DELIVERY_STUCK_AFTER_MS }); await r.flush()
  expect(r.h.totalPosts()).toBe(0)
  r.waiting(behind[0]!, 'not-now'); await r.flush()
  expect(r.h.posts(r.alpha).map(p => p.text)).toEqual([formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, behind.length, DELIVERY_STUCK_AFTER_MS + 1, 'refused', 1))])
  expect(r.h.posts(r.beta)).toEqual([])
  expect(JSON.stringify({ logs: r.logs, posts: r.h.allPosts() })).not.toContain('private held reply')
})

test.each(['memory', 'post'] as const)('later in-flight completion does not move a released head back to an unresolved or withdrawn %s hold', async kind => {
  const r = await run({ holds: true }), field = HOLD_FIELDS[kind]
  const unresolved = await noticeHold(r, THREAD_ROOTS.secondary, field), withdrawn = await noticeHold(r, THREAD_ROOTS.third, field)
  const released = await noticeHold(r, THREAD_ROOTS.primary, field)
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
  expect(buildDeliveryStuckNotice('Alpha', 'alpha', 2, DELIVERY_STUCK_AFTER_MS, 'refused', 3, true)).toBe(
    ':warning: *Delivery stuck* — 2 message(s) for Alpha are waiting; the oldest has waited 5m. The text arrived cut off; the full message is still queued. ' + deliveryStuckRemedy('refused', 'alpha', 3) + ' ' + CONFLICT_NOTICE_HUMAN_ONLY_LINE)
  expect(buildMessageNotSavedNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not saved* — a message from U0SENDER1 for Alpha could not be saved. Slack will send it again a few times; it is delivered if one copy is saved, otherwise it is lost and should be sent again. Further messages to this persona may fail the same way until storing works; server.log counts them. Check the server's disk.")
  expect(buildMessageSavedAfterRetryNotice('Alpha', 'U0SENDER1')).toBe(':white_check_mark: *Message saved after retry* — the message from U0SENDER1 for Alpha was saved after a retry. No resend is needed.')
  expect(buildMessageNotTakenInNotice('Alpha', 'U0SENDER1')).toBe(":warning: *Message not taken in* — the message from U0SENDER1 for Alpha is still queued. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.")
  expect(buildMessageNotTakenInNotice('Alpha', 'U0SENDER1', true)).toBe(":warning: *Message not taken in* — the message from U0SENDER1 for Alpha is still queued. The text arrived cut off; the full message is kept. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.")
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

test.each(reasons)('b.x4j partial evidence retains the %s remedy and episode deduplication', async (reason, engineReason, patch) => {
  const r = await run(), item = await r.accept(), ageMs = DELIVERY_STUCK_AFTER_MS + 1
  const status = { ageMs, ...patch, partialReceipt: { part: 1, expectedBytes: Buffer.byteLength(partialReceiptText), receivedBytes: Buffer.byteLength(partialReceiptSuffix) } }
  r.waiting(item, engineReason, status); await r.flush()
  r.waiting(item, engineReason, status); await r.flush()
  expect(r.h.posts(r.alpha).map(post => post.text)).toEqual([
    formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, 1, ageMs, reason, (patch.retypeCount ?? 0) + 1, true)),
  ])
  expect(r.h.posts(r.beta)).toEqual([])
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

describe('b.x4j transcript-to-notice partial receipt guard', () => {
  async function compose() {
    let r: DeliveryNoticeHarness | undefined
    const e = await makeEngineHarness({ onEvent: event => r?.reporting.engineEvent(event) })
    r = await makeDeliveryNoticeHarness({ queue: e.queue }); runs.push(r)
    e.p().autoReceipt = false
    return { e, r, async resetReporting() {
      r!.rig.episodes.close()
      r = await makeDeliveryNoticeHarness({ queue: e.queue }); runs.push(r)
      return r
    } }
  }
  const partialLines = (r: DeliveryNoticeHarness) => r.logs.filter(line => line.includes(MESSAGE_PARTIAL_RECEIPT))

  test.each(['raw', 'paste'] as const)('%s suffix: retain full FIFO head, report cut-off text, then accept late full receipt', async framing => {
    const { e, r } = await compose()
    try {
      // Put a fake secret inside the surviving suffix, not only the lost prefix.
      const text = partialReceiptText.replace('END-round2-trial.', `END-round2-trial. ${sentinelInMessage('partial-receipt')}`)
      const suffix = text.slice(-349), fragment = promptEntry(framing === 'paste' ? `\n\n${pastedText(suffix)}\n\n` : suffix)
      const head = await e.accept(text), next = await e.accept('FIFO successor')
      e.p().keyHook = params => { if (params.key === 'Enter') appendTranscript(e.p().path, [fragment]); return undefined }
      await e.tick(); await e.advance(ENTER_DELAY_MS + DELIVERY_ROW_POLL_MS)
      expect(e.keyCalls().map(call => call.params.key ?? call.params.text)).toEqual([text, 'Enter'])
      expect(e.queue.openCount('alpha')).toBe(2)
      expect(head.accepted.text).toBe(text)
      expect(e.queue.items('alpha')[0]!.fixed?.parts).toEqual([text])
      expect(e.records().filter(record => record.kind === 'delivered')).toEqual([])
      expect(r.delivered).toEqual([])
      expect(e.engine.status('alpha')?.row).toBe('waiting')
      await e.until(() => e.events.some(event => event.type === 'retyped'))
      // The existing recovery Enter and full retype remain the only key path.
      expect(e.keyCalls().map(call => call.params.key ?? call.params.text)).toEqual([text, 'Enter', 'Enter', text, 'Enter'])
      await e.advance(DELIVERY_STUCK_AFTER_MS + DELIVERY_ROW_POLL_MS - e.clock.now())
      await r.flush()
      const notices = [...r.h.posts(r.alpha)], diagnostics = [...partialLines(r)], typedCount = e.queue.items('alpha')[0]!.retypeCount + 1
      expect(notices).toHaveLength(2)
      expect(e.records().filter(record => record.kind === 'noticed')).toHaveLength(1)
      expect(e.records().filter(record => record.kind === 'delivered')).toEqual([])
      expect(e.textCalls().every(call => call.params.text === text)).toBe(true)
      expect(r.h.posts(r.beta)).toEqual([])
      assertNoLeak({ logs: r.logs, notices })
      expect(JSON.stringify({ logs: r.logs, notices })).not.toContain('END-round2-trial')
      expect(JSON.stringify({ logs: r.logs, notices })).not.toContain('Inert numbered transport data')

      e.p().keyHook = undefined; e.p().autoReceipt = true
      const full = promptEntry(pastedText(text))
      appendTranscript(e.p().path, [full])
      const textsBeforeFull = e.textCalls().length
      await e.until(() => e.queue.openCount('alpha') === 0)
      expect(e.textCalls().slice(textsBeforeFull).map(call => call.params.text)).toEqual(['FIFO successor'])
      expect(r.delivered.map(({ item }) => item.accepted.seq)).toEqual([head.accepted.seq, next.accepted.seq])
      expect(e.records().filter(record => record.kind === 'delivered')).toMatchObject([
        { seq: head.accepted.seq, part: 1, receipt: { uuid: full.uuid } }, { seq: next.accepted.seq, part: 1 },
      ])
      expect(e.calls.filter(call => call.verb === 'read-pane')).toEqual([])
      expect(e.errors).toEqual([])
      // Keep all safety/progression assertions above the expected pre-fix failure.
      expect({ diagnosticCount: diagnostics.length, afterFullCount: partialLines(r).length,
        notTakenIn: /cut off/i.test(notices[0]!.text), stuck: /cut off/i.test(notices[1]!.text) })
        .toEqual({ diagnosticCount: 1, afterFullCount: 1, notTakenIn: true, stuck: true })
      expect(diagnostics[0]).toContain(deliveryIdentity(head.accepted))
      expect(diagnostics[0]).toContain('part=1')
      expect(diagnostics[0]).toContain(`expected_bytes=${Buffer.byteLength(text)}`)
      expect(diagnostics[0]).toContain(`received_bytes=${Buffer.byteLength(suffix)}`)
      expect(notices[0]!.text).toBe(formatPersonaNotice(r.config.personas[0]!, buildMessageNotTakenInNotice(r.ref(), 'interject', true)))
      expect(notices[1]!.text).toContain(deliveryStuckRemedy('not-taken-in', r.alpha, typedCount))
      expect(diagnostics[0]).not.toContain(e.p().path)
      expect(diagnostics[0]).not.toContain(fragment.uuid as string)
    } finally { await e.cleanup() }
  })

  test.each(['part', 'item', 'launch', 'session', 'launch-timestamp', 'replay', 'timestamped-replay'] as const)('%s scopes cut-off reporting to applicable evidence', async scope => {
    const composition = await compose(), e = composition.e
    let r = composition.r
    try {
      if (scope === 'launch-timestamp' || scope === 'timestamped-replay') e.p().row.launch_started_at = new Date(e.clock.now()).toISOString()
      await e.accept(partialReceiptText, 'alpha', scope === 'part' ? [partialReceiptText, 'later part'] : undefined)
      if (scope === 'item') await e.accept('later item')
      await e.tick(); await e.advance(ENTER_DELAY_MS + DELIVERY_ROW_POLL_MS)
      appendTranscript(e.p().path, [promptEntry(partialReceiptSuffix)])
      await e.advance(DELIVERY_ROW_POLL_MS)
      const firstDiagnostics = partialLines(r).length
      if (scope === 'part' || scope === 'item') {
        appendTranscript(e.p().path, [promptEntry(partialReceiptText)])
      } else if (scope === 'launch') {
        // Same conversation, new AD launch; the old fragment precedes this send.
        e.p().row.state = 'pending'; await e.advance(DELIVERY_ROW_POLL_MS)
        e.p().row.state = 'waiting'; await e.advance(DELIVERY_ROW_POLL_MS)
      } else if (scope === 'session') {
        e.p().row.session_id = 'new-session'; await e.advance(DELIVERY_ROW_POLL_MS)
      } else if (scope === 'launch-timestamp') {
        e.p().row.launch_started_at = new Date(e.clock.now()).toISOString(); await e.advance(DELIVERY_ROW_POLL_MS)
      } else {
        if (scope === 'timestamped-replay') e.p().row.launch_started_at = new Date(e.clock.now()).toISOString()
        await e.restartServer() // Evidence is rebuilt from journal + transcript.
        r = await composition.resetReporting()
      }
      await e.until(() => e.records().some(record => record.kind === 'noticed'))
      await e.advance(DELIVERY_STUCK_AFTER_MS + DELIVERY_ROW_POLL_MS - e.clock.now())
      await r.flush()
      const notices = r.h.posts(r.alpha)
      expect(notices).toHaveLength(2)
      expect(notices.map(post => /cut off/i.test(post.text))).toEqual(scope === 'replay' ? [true, true] : [false, false])
      expect(e.queue.openCount('alpha')).toBe(1)
      expect(e.calls.filter(call => call.verb === 'read-pane')).toEqual([])
      expect(e.errors).toEqual([])
      expect(firstDiagnostics).toBe(1)
    } finally { await e.cleanup() }
  })

  test('b.x4j replay reconstructs a partial diagnostic once while retaining the durable not-taken-in notice', async () => {
    const composition = await compose(), e = composition.e
    let r = composition.r
    try {
      await e.accept(partialReceiptText)
      await e.tick(); await e.advance(ENTER_DELAY_MS + DELIVERY_ROW_POLL_MS)
      appendTranscript(e.p().path, [promptEntry(partialReceiptSuffix)])
      await e.until(() => e.records().some(record => record.kind === 'noticed'))
      await r.flush()
      expect(r.h.posts(r.alpha).map(post => post.text)).toEqual([
        formatPersonaNotice(r.config.personas[0]!, buildMessageNotTakenInNotice(r.ref(), 'interject', true)),
      ])
      expect(partialLines(r)).toHaveLength(1)
      await e.restartServer(); r = await composition.resetReporting()
      await e.advance(DELIVERY_STUCK_AFTER_MS + DELIVERY_ROW_POLL_MS - e.clock.now()); await r.flush()
      expect(e.records().filter(record => record.kind === 'noticed')).toHaveLength(1)
      expect(r.logs.filter(line => line.includes(MESSAGE_NOT_TAKEN_IN))).toEqual([])
      expect(partialLines(r)).toHaveLength(1)
      const posts = r.h.posts(r.alpha)
      expect(posts).toHaveLength(1)
      expect(posts[0]!.text).toBe(formatPersonaNotice(r.config.personas[0]!, buildDeliveryStuckNotice(r.ref(), r.alpha, 1, e.clock.now(), 'not-taken-in', e.queue.items('alpha')[0]!.retypeCount + 1, true)))
    } finally { await e.cleanup() }
  })
})

test.each([false, true])('b.eh9 an aged head awaiting its receipt on a waiting row posts no stuck notice (gone prior session: %p)', async gonePrior => {
  let r: DeliveryNoticeHarness | undefined
  const e = await makeEngineHarness({ onEvent: event => r?.reporting.engineEvent(event) })
  try {
    r = await makeDeliveryNoticeHarness({ queue: e.queue }); runs.push(r)
    const p = e.p()
    if (gonePrior) p.row.prior_sessions = [{ jsonl_path: join(e.root, 'gone-prior.jsonl'), session_id: 'gone-prior' }]
    p.autoReceipt = false; p.row.state = 'working'
    const item = await e.accept('hello from slack')
    e.engine.wake('alpha')
    await e.advance(DELIVERY_STUCK_AFTER_MS + 5_000)
    const before = e.events.length
    p.row.state = 'waiting'
    await e.until(() => e.keyCalls().some(call => call.params.key === 'Enter'))
    await e.advance(4_000); await r.flush()
    const waits = e.events.slice(before).filter(event => event.type === 'waiting')
    expect(waits.at(-1)?.status?.ageMs).toBeGreaterThan(DELIVERY_STUCK_AFTER_MS)
    expect([...new Set(waits.map(event => event.reason))]).toEqual(['receipt'])
    expect(r.h.posts(r.alpha)).toEqual([])
    expect(r.logs.filter(line => line.includes('delivery-stuck'))).toEqual([])
    appendTranscript(p.path, [promptEntry('hello from slack')])
    await e.until(() => e.queue.items('alpha').find(i => i.accepted.seq === item.accepted.seq)?.delivered === true, 60_000)
    expect({ textSends: e.textCalls().length, retyped: e.events.filter(event => event.type === 'retyped').length }).toEqual({ textSends: 1, retyped: 0 })
    expect(e.errors).toEqual([])
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

describe('b.vki storage-warning recovery through real intake and Slack destination', () => {
  const storageRuns: StorageNoticeHarness[] = []
  async function storage(options: Parameters<typeof makeStorageNoticeHarness>[0] = {}) {
    const r = await makeStorageNoticeHarness(options); storageRuns.push(r); return r
  }
  afterEach(async () => {
    for (const r of storageRuns.splice(0)) {
      try {
        for (const stub of r.h.stubs.values()) {
          expect(stub.calls.delete).toEqual([])
          expect(stub.calls.apiCall.filter(call => call.method === 'chat.delete')).toEqual([])
        }
      } finally { await r.cleanup() }
    }
  })
  const warningTs = '1800000000.000001', noticeDm = 'D0NOTICE1'
  const edited = { edited: { ts: '1700000001.000001' } }
  function warning(r: StorageNoticeHarness) {
    return formatPersonaNotice(r.config.personas[0]!, buildMessageNotSavedNotice(r.ref(), 'U0SENDER1'))
  }
  function noticeText(args: object): string | undefined {
    return 'text' in args && typeof args.text === 'string' ? args.text : undefined
  }
  function recovered(r: StorageNoticeHarness, args: object) {
    expect(noticeText(args)).toBe(formatPersonaNotice(r.config.personas[0]!, buildMessageSavedAfterRetryNotice(r.ref(), 'U0SENDER1')))
  }
  function recoveryLines(r: StorageNoticeHarness) {
    return r.logs.filter(line => line.includes(' recovery='))
  }
  function destinationLines(r: StorageNoticeHarness) {
    const lines = r.h.logs.filter(line => line.includes(`${PERSONA_DESTINATION_FAILED}:`))
    return { failed: lines.filter(line => !line.includes(': cleared:')), cleared: lines.filter(line => line.includes(': cleared:')) }
  }
  function recoveryLine(r: StorageNoticeHarness, operation: 'edit' | 'correction', result: NoticeCorrectionOutcome, editedTs?: string) {
    const { channel, ts } = r.event
    if (typeof channel !== 'string' || typeof ts !== 'string') throw new Error('storage notice fixture requires a channel and timestamp')
    const identity: SlackKey = { chat_id: channel, ts, ...(editedTs === undefined ? {} : { edited_ts: editedTs }) }
    return buildStorageNoticeRecoveryLine(r.ref(), identity, operation, result)
  }
  async function fail(r: StorageNoticeHarness, overrides: Record<string, unknown> = {}) {
    r.failStores(); await r.receive(overrides)
    expect(r.acks).toEqual([])
    expect(r.queue.items(r.alpha)).toEqual([])
    expect(readQueue(r.root, r.alpha)).toEqual([])
    expect(r.logs.some(line => line.includes('code=ENOSPC'))).toBe(true)
  }
  async function posted(r: StorageNoticeHarness, overrides: Record<string, unknown> = {}) {
    r.h.stub(r.alpha).script.open.push(openedDm(noticeDm))
    r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: warningTs } })
    await fail(r, overrides)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.posts(r.alpha)[0]!.text).toBe(warning(r))
  }
  async function retry(r: StorageNoticeHarness, overrides: Record<string, unknown> = {}) {
    r.failStores(false); await r.receive(overrides)
    expect(r.acks).toHaveLength(1)
    expect(r.acks[0]!.records.filter(record => record.kind === 'accepted')).toHaveLength(1)
    expect(r.queue.items(r.alpha)).toHaveLength(1)
    expect(r.queue.items(r.alpha)[0]!.fixed).toBeDefined()
    // Slack redelivery must neither append another acceptance nor repeat recovery.
    await r.receive(overrides)
    expect(r.acks).toHaveLength(2)
    expect(readQueue(r.root, r.alpha).filter(record => record.kind === 'accepted')).toHaveLength(1)
  }

  test.each([
    ['strict original', 'strict', {}], ['strict edit', 'strict', edited],
    ['open original', 'open', {}], ['open edit', 'open', edited],
  ] as const)('pending DM, %s: exact durable retry cancels at the post boundary', async (_label, channel_mode, edit) => {
    const r = await storage({ channel_mode }), opening = r.hold('open')
    await fail(r, edit)
    expect(r.h.stub(r.alpha).calls.conversationsOpen).toHaveLength(1)
    expect(r.h.totalPosts()).toBe(0)
    await retry(r, edit) // Must finish even though Slack has not answered open.
    opening.settle(openedDm(noticeDm)); await r.flush()
    expect(r.h.totalPosts()).toBe(0)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.stub(r.beta).callLog).toEqual([])
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test.each(['dm', 'channel'] as const)('posted to %s: arbitrarily late exact retry edits that warning once', async destination => {
    const r = await storage({ destination })
    await posted(r, edited)
    // A scenario horizon, not a retry deadline: no source timeout is assumed.
    await r.h.clock.advance(90 * 24 * 60 * 60 * 1000)
    await retry(r, edited)
    const updates = r.h.stub(r.alpha).calls.update
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ channel: destination === 'dm' ? noticeDm : 'C0NOTICE1', ts: warningTs })
    recovered(r, updates[0]!)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.stub(r.beta).callLog).toEqual([])
    expect(recoveryLines(r)).toEqual([recoveryLine(r, 'edit', { outcome: 'success' }, edited.edited.ts)])
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('retry while chat.postMessage is in flight waits for its identity, then edits once', async () => {
    const r = await storage({ destination: 'channel' }), posting = r.hold('post')
    await fail(r)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    posting.settle({ kind: 'ok', result: { ts: warningTs } }); await r.flush()
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update[0]).toMatchObject({ channel: 'C0NOTICE1', ts: warningTs })
    recovered(r, r.h.stub(r.alpha).calls.update[0]!)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
  })

  test.each([
    ['dm', false], ['channel', false], ['dm', true], ['channel', true],
  ] as const)('edit failure at %s: one correction in the original place, log both outcomes (correction fails=%p)', async (destination, correctionFails) => {
    const r = await storage({ destination })
    await posted(r)
    r.h.stub(r.alpha).script.update.push({ kind: 'platform', error: 'cant_update_message' })
    if (correctionFails) r.h.stub(r.alpha).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    // The correction belongs to the old post even if the current destination changed.
    r.h.personas[0] = { ...r.h.personas[0]!, permission_prompts: 'C0MOVED01', dm: { enabled: true, contact: 'U0MOVED01' } }
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update[0]).toMatchObject({ channel: destination === 'dm' ? noticeDm : 'C0NOTICE1', ts: warningTs })
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    const correction = r.h.stub(r.alpha).calls.postMessage[1]!
    expect(correction.channel).toBe(r.h.posts(r.alpha)[0]!.channel)
    expect(correction.thread_ts).toBe(r.h.stub(r.alpha).calls.postMessage[0]!.thread_ts)
    recovered(r, correction)
    expect(noticeText(correction)!.length).toBeLessThan(warning(r).length)
    expect(recoveryLines(r)).toEqual([
      expect.stringContaining(recoveryLine(r, 'edit', { outcome: 'failed', reason: '' })),
      correctionFails ? expect.stringContaining(recoveryLine(r, 'correction', { outcome: 'failed', reason: '' })) : recoveryLine(r, 'correction', { outcome: 'success' }),
    ])
    expect(recoveryLines(r)[0]).toContain('reason=cant_update_message')
    if (correctionFails) expect(recoveryLines(r)[1]).toContain('reason=not_in_channel')
    await r.h.clock.advance(90 * 24 * 60 * 60 * 1000)
    await r.receive()
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.beta).callLog).toEqual([])
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  const unrelated = [
    ['another edit', { edited: { ts: '1700000002.000001' } }],
    ['unedited original', { edited: undefined }],
    ['another timestamp', { ts: '1700000000.000002' }],
    ['another chat', { channel: 'C0OTHER01' }],
  ] as const
  test.each(unrelated)('pending edited warning survives a successful store of %s', async (_label, other) => {
    const r = await storage(), opening = r.hold('open')
    await fail(r, edited)
    r.failStores(false); await r.receive({ ...edited, ...other })
    expect(r.acks).toHaveLength(1)
    expect(r.queue.items(r.alpha)).toHaveLength(1)
    opening.settle(openedDm(noticeDm)); await r.flush()
    expect(r.h.posts(r.alpha)).toEqual([{ channel: noticeDm, text: warning(r) }])
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
  })
  test.each(unrelated)('posted edited warning survives %s, then the exact edit still corrects it', async (_label, other) => {
    const r = await storage()
    await posted(r, edited)
    r.failStores(false); await r.receive({ ...edited, ...other })
    expect(r.acks).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    await r.receive(edited)
    expect(r.queue.items(r.alpha)).toHaveLength(2)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update[0]).toMatchObject({ channel: noticeDm, ts: warningTs })
    recovered(r, r.h.stub(r.alpha).calls.update[0]!)
  })

  test.each(['other persona', 'interject', 'cron'] as const)('%s storage cannot recover or forget the posted Slack failure', async source => {
    const r = await storage()
    await posted(r)
    r.failStores(false)
    if (source === 'other persona') {
      await r.receive({}, r.beta)
      const accepted = readQueue(r.root, r.beta).filter(record => record.kind === 'accepted')
      expect(accepted).toEqual([expect.objectContaining({ source: 'slack', key: { chat_id: r.event.channel, ts: r.event.ts } })])
      expect(r.acks).toEqual([{ key: r.beta, records: expect.arrayContaining(accepted) }])
      expect(accepted).toEqual(r.queue.items(r.beta).map(item => item.accepted))
      expect(r.queue.items(r.alpha)).toEqual([])
      expect(readQueue(r.root, r.alpha)).toEqual([])
    } else expect((await r.queue.accept(r.alpha, injectedInput({ source, sender: source }))).status).toBe('accepted')
    await r.flush()
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    await r.receive()
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update[0]).toMatchObject({ channel: noticeDm, ts: warningTs })
  })

  test('persistent disk failures retain one unchanged warning, no ack or durable acceptance, and count every failure', async () => {
    const r = await storage()
    await posted(r)
    await r.receive(); await r.receive()
    await r.h.clock.advance(90 * 24 * 60 * 60 * 1000)
    await r.receive()
    expect(r.h.posts(r.alpha)).toEqual([{ channel: noticeDm, text: warning(r) }])
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.acks).toEqual([])
    expect(r.queue.items(r.alpha)).toEqual([])
    expect(readQueue(r.root, r.alpha)).toEqual([])
    expect(r.logs.filter(line => line.includes('code=ENOSPC')).map(line => line.match(/count=(\d+)/)?.[1])).toEqual(['1', '2', '3', '4'])
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('edit and fallback each time out once without blocking intake; late answers cannot restart correction', async () => {
    const r = await storage({ destination: 'channel' })
    await posted(r)
    const editing = r.hold('update'), correcting = r.hold('post')
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.clock.pending().map(timer => timer.delayMs)).toEqual([NOTICE_CORRECTION_TIMEOUT_MS])
    await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS - 1)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(recoveryLines(r)).toEqual([])
    await r.h.clock.advance(1)
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    recovered(r, r.h.stub(r.alpha).calls.postMessage[1]!)
    expect(r.h.stub(r.alpha).calls.postMessage[1]!.channel).toBe('C0NOTICE1')
    const editTimeout = recoveryLine(r, 'edit', { outcome: 'failed', reason: 'timeout' })
    expect(recoveryLines(r)).toEqual([editTimeout])
    expect(r.h.clock.pending().map(timer => timer.delayMs)).toEqual([NOTICE_CORRECTION_TIMEOUT_MS])
    await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS - 1)
    expect(recoveryLines(r)).toEqual([editTimeout])
    await r.h.clock.advance(1)
    const outcomes = [editTimeout, recoveryLine(r, 'correction', { outcome: 'failed', reason: 'timeout' })]
    expect(recoveryLines(r)).toEqual(outcomes)
    expect(r.h.clock.pendingCount()).toBe(0)
    // A late rejection and a late success are both observed but do not alter the bounded result.
    editing.settle({ kind: 'platform', error: 'cant_update_message' })
    correcting.settle(); await r.flush()
    await r.receive(); await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS * 2)
    expect(recoveryLines(r)).toEqual(outcomes)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(0)
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('a posted warning without a Slack timestamp falls back once to the original destination', async () => {
    const r = await storage({ destination: 'channel' })
    r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: undefined } })
    await fail(r)
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    expect(r.h.posts(r.alpha)[1]!.channel).toBe('C0NOTICE1')
    recovered(r, r.h.stub(r.alpha).calls.postMessage[1]!)
    expect(recoveryLines(r)).toEqual([
      recoveryLine(r, 'edit', { outcome: 'failed', reason: 'missing_message_ts' }),
      recoveryLine(r, 'correction', { outcome: 'success' }),
    ])
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test.each([false, true])('exact retry removes a destination-held warning, preserving another queued notice=%p', async keepOther => {
    const r = await storage({ destination: 'channel' })
    r.h.stub(r.alpha).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    await fail(r)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(1)
    expect(destinationLines(r).failed).toHaveLength(1)
    expect(destinationLines(r).cleared).toEqual([])
    const other = buildMessagesWaitingNotice(r.ref(), 1, 0, 'down')
    if (keepOther) await r.h.notifier.notify(r.alpha, other)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(keepOther ? 2 : 1)
    await retry(r)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(keepOther ? 1 : 0)
    expect(r.h.clock.pendingCount()).toBe(keepOther ? 1 : 0)
    if (keepOther) {
      await r.h.clock.runNext()
      expect(r.h.posts(r.alpha)[1]).toEqual({ channel: 'C0NOTICE1', text: formatPersonaNotice(r.config.personas[0]!, other) })
    }
    await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS * 2)
    expect(r.h.posts(r.alpha)).toHaveLength(keepOther ? 2 : 1)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(recoveryLines(r)).toEqual([])
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(0)
    expect(r.h.clock.pendingCount()).toBe(0)
    expect(destinationLines(r).failed).toHaveLength(1)
    expect(destinationLines(r).cleared).toHaveLength(keepOther ? 1 : 0)
  })

  test.each(['success', 'failure'] as const)('b.vki F1: cancelling during a held DM retry releases a later notice before the old open returns %s', async late => {
    const r = await storage()
    r.h.stub(r.alpha).script.open.push({ kind: 'platform', error: 'missing_scope' })
    await fail(r, edited)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(1)
    expect(r.h.stub(r.alpha).calls.conversationsOpen).toHaveLength(1)
    expect(destinationLines(r).failed).toHaveLength(1)
    expect(destinationLines(r).cleared).toEqual([])

    const opening = r.hold('open')
    await r.h.clock.runNext()
    // Cancellation must happen DURING the retry, after its second open began.
    expect(r.h.stub(r.alpha).calls.conversationsOpen).toHaveLength(2)
    expect(opening.settled).toBe(false)
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(1)
    expect(r.h.totalPosts()).toBe(0)
    await retry(r, edited)
    const { channel, ts } = r.event
    if (typeof channel !== 'string' || typeof ts !== 'string') throw new Error('storage notice fixture requires a channel and timestamp')
    expect(r.queue.items(r.alpha)[0]!.accepted.key).toEqual({
      chat_id: channel, ts, edited_ts: edited.edited.ts,
    })
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(0)

    r.h.personas[0] = { ...r.h.personas[0]!, permission_prompts: 'C0FIXED01' }
    const other = buildMessagesWaitingNotice(r.ref(), 1, 0, 'down')
    await r.h.notifier.notify(r.alpha, other)
    // The fake clock runs an already-due retry after 1 ms. Do not advance to
    // an open timeout: abort itself must release this persona's drain.
    await r.h.clock.advance(1)
    expect(opening.settled).toBe(false)
    const expectedPosts = [{ channel: 'C0FIXED01', text: formatPersonaNotice(r.h.personas[0]!, other) }]
    expect(r.h.posts(r.alpha)).toEqual(expectedPosts)
    expect(r.h.hold.view(r.alpha)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    const destinationOutcomes = destinationLines(r)
    expect(destinationOutcomes.failed).toHaveLength(1)
    expect(destinationOutcomes.cleared).toHaveLength(1)

    opening.settle(late === 'success' ? openedDm(noticeDm) : { kind: 'platform', error: 'missing_scope' })
    await r.flush()
    // Reviewer probe's horizon: a late answer cannot revive the warning,
    // start a correction, reopen the hold or schedule another retry.
    await r.h.clock.advance(3_600_000)
    expect(r.h.posts(r.alpha)).toEqual(expectedPosts)
    expect(r.h.stub(r.alpha).calls.conversationsOpen).toHaveLength(2)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.stub(r.beta).callLog).toEqual([])
    expect(recoveryLines(r)).toEqual([])
    expect(destinationLines(r)).toEqual(destinationOutcomes)
    expect(r.h.hold.view(r.alpha)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('a warning post failing after the durable retry is not enqueued for destination retry', async () => {
    const r = await storage({ destination: 'channel' }), posting = r.hold('post')
    await fail(r)
    await retry(r)
    posting.settle({ kind: 'platform', error: 'not_in_channel' }); await r.flush()
    expect(r.h.hold.view(r.alpha).heldNotices).toBe(0)
    expect(r.h.clock.pendingCount()).toBe(0)
    await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS * 2)
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(recoveryLines(r)).toEqual([])
  })

  test.each(['open', 'post', 'update', 'correction'] as const)('shutdown during %s invalidates late Slack responses and clears correction timers', async stage => {
    const r = await storage({ destination: stage === 'open' ? 'dm' : 'channel' })
    if (stage === 'update' || stage === 'correction') await posted(r)
    const pending = r.hold(stage === 'correction' ? 'post' : stage)
    if (stage === 'correction') r.h.stub(r.alpha).script.update.push({ kind: 'platform', error: 'cant_update_message' })
    if (stage === 'open' || stage === 'post') await fail(r)
    else await retry(r) // Recovery ended the episode; shutdown must still forget its retained identity.
    r.rig.episodes.close()
    const calls = [...r.captured().calls], outcomes = [...recoveryLines(r)]
    expect(r.h.clock.pendingCount()).toBe(0)
    pending.settle(stage === 'open' ? openedDm(noticeDm) : stage === 'post'
      ? { kind: 'ok', result: { ts: warningTs } }
      : { kind: 'platform', error: 'not_in_channel' })
    await r.flush()
    r.failStores(false); await r.receive()
    await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS * 2)
    expect(r.captured().calls).toEqual(calls)
    expect(recoveryLines(r)).toEqual(outcomes)
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('teardown cancels an open-DM warning and preserves another persona\'s already-retained warning for exact recovery', async () => {
    const r = await storage(), opening = r.hold('open')
    await fail(r)
    const betaDm = 'D0BETA001', betaTs = '1800000000.000002'
    r.h.stub(r.beta).script.open.push(openedDm(betaDm))
    r.h.stub(r.beta).script.post.push({ kind: 'ok', result: { ts: betaTs } })
    await r.receive(edited, r.beta)
    expect(r.acks).toEqual([])
    expect(readQueue(r.root, r.beta)).toEqual([])
    expect(r.h.posts(r.beta)).toEqual([{ channel: betaDm,
      text: formatPersonaNotice(r.config.personas[1]!, buildMessageNotSavedNotice(r.ref(r.beta), 'U0SENDER1')) }])
    expect(opening.settled).toBe(false)
    // Both warning registrations exist before only alpha is forgotten.
    r.forget()
    r.failStores(false)
    await r.receive(edited, r.beta)
    await r.receive(edited, r.beta)
    expect(readQueue(r.root, r.beta).filter(record => record.kind === 'accepted')).toEqual([
      expect.objectContaining({ source: 'slack', key: { chat_id: r.event.channel, ts: r.event.ts, edited_ts: edited.edited.ts } }),
    ])
    expect(r.queue.items(r.alpha)).toEqual([])
    const betaUpdates = [{ channel: betaDm, ts: betaTs,
      text: formatPersonaNotice(r.config.personas[1]!, buildMessageSavedAfterRetryNotice(r.ref(r.beta), 'U0SENDER1')) }]
    expect(r.h.stub(r.beta).calls.update).toEqual(betaUpdates)
    opening.settle(openedDm(noticeDm)); await r.flush()
    expect(r.h.posts(r.alpha)).toEqual([])
    expect(r.h.stub(r.alpha).calls.update).toEqual([])
    expect(r.h.posts(r.beta)).toHaveLength(1)
    expect(r.h.stub(r.beta).calls.update).toEqual(betaUpdates)
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('teardown forgets the old posted warning; re-added persona corrects only its new warning', async () => {
    const r = await storage({ destination: 'channel' }), newTs = '1800000000.000002'
    await posted(r)
    r.forget()
    r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: newTs } })
    await r.receive()
    expect(r.h.posts(r.alpha)).toHaveLength(2)
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    expect(r.h.stub(r.alpha).calls.update[0]).toMatchObject({ channel: 'C0NOTICE1', ts: newTs })
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  test('teardown while an edit is in flight prevents its late failure posting a correction', async () => {
    const r = await storage({ destination: 'channel' })
    await posted(r)
    const editing = r.hold('update')
    await retry(r)
    expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
    r.forget()
    editing.settle({ kind: 'platform', error: 'cant_update_message' }); await r.flush()
    expect(r.h.posts(r.alpha)).toHaveLength(1)
    expect(r.h.clock.pendingCount()).toBe(0)
  })

  // Ruling 3 of fix Task t2.yiv.5c.zc: the same exact-message tracking through the branch's own posts and Post Holds.
  describe('composed with own posts and Post Holds', () => {
    const IDS = STORAGE_NOTICE_IDS
    /** The fixture message as an unmentioned reply in the earlier root, held while P's own post there is pending. */
    const reply = (r: StorageNoticeHarness, ts?: string) => ({ thread_ts: IDS.root, text: r.body, ...(ts === undefined ? {} : { ts }) })
    /** P's own post into the earlier root through the real owner, its Slack answer never given. */
    async function pendingPost(r: StorageNoticeHarness) {
      const started = r.observer.start(r.alpha, 'text', { channel: IDS.source, parent: IDS.root }, { kind: 'text', text: 'posted before Slack answers' })
      if (!started?.ready) throw new Error('fixture own post was not started')
      await started.ready
      expect(r.threads!.memory.view(r.alpha, IDS.source, IDS.root)).toBe('not-joined')
    }
    const holds = (r: StorageNoticeHarness): unknown[][] => r.queue.items(r.alpha).map(item => [item.accepted.ts, item.hold?.kind, item.hold?.state])
    /** Flush both fake clocks until `done` holds: real Thread Memory appends settle over several turns. */
    async function until(r: StorageNoticeHarness, done: () => boolean) {
      for (let turn = 0; turn < 50 && !done(); turn++) { await r.flush(); await r.threads?.clock.flush() }
      expect(done()).toBe(true)
    }
    const correctionText = (r: StorageNoticeHarness) => formatPersonaNotice(r.config.personas[0]!, buildMessageSavedAfterRetryNotice(r.ref(), IDS.sender))
    const editFailed = (r: StorageNoticeHarness) => expect.stringContaining(recoveryLine(r, 'edit', { outcome: 'failed', reason: '' }))
    /** A warning posted to the channel destination, then an edit Slack will refuse: the exact save's
     * correction falls back to a same-place post, whose Slack answer the caller scripts next. */
    async function failedEdit(options: Parameters<typeof storage>[0] = {}) {
      const r = await storage({ destination: 'channel', ...options })
      r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: IDS.warningTs } })
      await fail(r)
      r.h.stub(r.alpha).script.update.push({ kind: 'platform', error: 'cant_update_message' })
      return r
    }

    test('a pending warning is dropped, never posted, when its exact message is saved as a Post Hold', async () => {
      const r = await storage({ threads: true }), opening = r.hold('open')
      await pendingPost(r)
      await fail(r, reply(r))
      expect(r.h.stub(r.alpha).calls.conversationsOpen).toHaveLength(1)
      r.failStores(false); await r.receive(reply(r))
      expect(r.acks).toHaveLength(1)
      expect(holds(r)).toEqual([[IDS.ts, 'post', 'unresolved']])
      opening.settle(openedDm(noticeDm)); await r.flush()
      expect(r.h.totalPosts()).toBe(0)
      expect(r.h.stub(r.alpha).calls.update).toEqual([])
      expect(recoveryLines(r)).toEqual([])
    })

    test('a warning waiting for its own-post intent is dropped when its exact message is saved meanwhile; its operation ends unposted', async () => {
      const intent = holdOwnPostReady(), recording = makeRecordingOwnPostObserver([{ ready: intent.ready }])
      const r = await storage({ destination: 'channel', ownPosts: recording.observer })
      await fail(r)
      expect(recording.calls).toEqual([expect.objectContaining({ kind: 'start', key: r.alpha, surface: 'notice', target: { channel: IDS.notice } })])
      await retry(r)
      intent.resolve(); await r.flush()
      expect(r.h.totalPosts()).toBe(0)
      expect(r.h.stub(r.alpha).calls.update).toEqual([])
      const operation = recording.calls[0]!.kind === 'start' ? recording.calls[0]!.operation : undefined
      expect(recording.calls.slice(1)).toEqual([{ kind: 'end', operation, answer: { kind: 'failed', code: OWN_POST_CANCELLED } }])
      expect(recoveryLines(r)).toEqual([])
    })

    test.each(['answered', 'answered after its bound', 'torn down during its intent'] as const)('an edit failure\'s same-place correction is an own-post operation of the warning\'s kind, ended by Slack\'s answer: %s', async scenario => {
      const intent = holdOwnPostReady()
      const recording = makeRecordingOwnPostObserver([{}, scenario === 'torn down during its intent' ? { ready: intent.ready } : {}])
      const r = await failedEdit({ ownPosts: recording.observer }), correcting = r.hold('post')
      const web = r.h.stub(r.alpha).web, original = web.chat.postMessage, atCall: string[][] = []
      web.chat.postMessage = ((...args: Parameters<typeof original>) => {
        atCall.push(recording.calls.map(call => call.kind)); return original(...args)
      }) as typeof original
      await retry(r)
      // The warning's own operation, then the correction's, started before its Slack call.
      expect(recording.calls.slice(0, 3)).toEqual([
        expect.objectContaining({ kind: 'start', surface: 'notice', target: { channel: IDS.notice }, content: { kind: 'text', text: warning(r) } }),
        expect.objectContaining({ kind: 'end', answer: expect.objectContaining({ kind: 'confirmed', ts: IDS.warningTs }) }),
        expect.objectContaining({ kind: 'start', key: r.alpha, surface: 'notice', target: { channel: IDS.notice }, content: { kind: 'text', text: correctionText(r) } }),
      ])
      const correction = recording.calls[2]!.kind === 'start' ? recording.calls[2]!.operation : undefined
      if (scenario === 'torn down during its intent') {
        r.forget(); intent.resolve(); await r.flush()
        expect(atCall).toEqual([])
        expect(r.h.posts(r.alpha)).toHaveLength(1)
        expect(recording.calls.slice(3)).toEqual([{ kind: 'end', operation: correction, answer: { kind: 'failed', code: OWN_POST_CANCELLED } }])
        expect(recoveryLines(r)).toEqual([editFailed(r)])
        return
      }
      expect(atCall).toEqual([['start', 'end', 'start']])
      if (scenario === 'answered after its bound') {
        await r.h.clock.advance(NOTICE_CORRECTION_TIMEOUT_MS)
        expect(recoveryLines(r)).toEqual([editFailed(r), recoveryLine(r, 'correction', { outcome: 'failed', reason: 'timeout' })])
        expect(recording.calls).toHaveLength(3)
      }
      correcting.settle({ kind: 'ok', result: { ts: IDS.correctionTs } }); await r.flush()
      expect(recording.calls.slice(3)).toEqual([{ kind: 'end', operation: correction, answer: expect.objectContaining({ kind: 'confirmed', channel: IDS.notice, ts: IDS.correctionTs }) }])
      expect(recoveryLines(r)).toEqual([editFailed(r), scenario === 'answered'
        ? recoveryLine(r, 'correction', { outcome: 'success' }) : recoveryLine(r, 'correction', { outcome: 'failed', reason: 'timeout' })])
      expect(r.h.posts(r.alpha)).toHaveLength(2)
      expect(r.h.clock.pendingCount()).toBe(0)
    })

    // Slack's refusal ends the correction's operation as a failed post, and no fault in its own
    // bookkeeping (on the second operation) changes the correction or its log (SR-3.2.5).
    test.each(['control', 'refused by Slack', 'start throws', 'ready rejects', 'end throws'] as const)('the correction\'s own operation, %s: one start, then one end with Slack\'s own answer, and the control\'s post and log unless Slack refused it', async scenario => {
      const fault = new Error('injected own-post bookkeeping fault'), ready = holdOwnPostReady()
      const correctionStep: OwnPostStep = scenario === 'start throws' ? { throwStart: fault } : scenario === 'end throws' ? { throwEnd: fault }
        : scenario === 'ready rejects' ? { ready: ready.ready } : {}
      const recording = makeRecordingOwnPostObserver([{}, correctionStep])
      const r = await failedEdit({ ownPosts: recording.observer })
      r.h.stub(r.alpha).script.post.push(scenario === 'refused by Slack' ? { kind: 'platform', error: 'is_archived' } : { kind: 'ok', result: { ts: IDS.correctionTs } })
      await retry(r)
      if (scenario === 'ready rejects') {
        // The correction waits for its intent; a failed intent save must not stop it.
        expect(r.h.posts(r.alpha)).toHaveLength(1)
        ready.reject(fault); await r.flush()
      }
      expect(r.h.posts(r.alpha)).toEqual([{ channel: IDS.notice, text: warning(r) }, { channel: IDS.notice, text: correctionText(r) }])
      expect(recoveryLines(r)).toEqual([editFailed(r), scenario === 'refused by Slack'
        ? expect.stringContaining(recoveryLine(r, 'correction', { outcome: 'failed', reason: '' })) : recoveryLine(r, 'correction', { outcome: 'success' })])
      if (scenario === 'refused by Slack') expect(recoveryLines(r)[1]).toContain('reason=is_archived')
      const [, , start, ...ends] = recording.calls
      expect(start).toMatchObject({ kind: 'start', key: r.alpha, surface: 'notice', target: { channel: IDS.notice }, content: { kind: 'text', text: correctionText(r) } })
      // A throwing start leaves no operation to end; the observer still hears Slack's answer once.
      const operation = start?.kind === 'start' ? start.operation : undefined
      expect(operation === undefined).toBe(scenario === 'start throws')
      expect(ends).toEqual([{ kind: 'end', operation, answer: scenario === 'refused by Slack'
        ? { kind: 'failed', code: 'is_archived' } : expect.objectContaining({ kind: 'confirmed', channel: IDS.notice, ts: IDS.correctionTs }) }])
      expect(r.h.clock.pendingCount()).toBe(0)
    })

    test('in a thread_hybrid notice channel the correction is P\'s own post there: a reply racing it is held, released via thread once Slack confirms it, and a later reply needs no hold', async () => {
      const r = await failedEdit({ threads: true, noticeDelivery: 'thread_hybrid' })
      // The real owner keeps the warning's intent before posting it, and its confirmation joins the warning's thread.
      await until(r, () => r.h.posts(r.alpha).length === 1 && r.threads!.memory.view(r.alpha, IDS.notice, IDS.warningTs) === 'joined')
      const correcting = r.hold('post')
      await retry(r)
      await until(r, () => r.h.posts(r.alpha).length === 2)
      expect(r.h.posts(r.alpha)[1]).toEqual({ channel: IDS.notice, text: correctionText(r) })
      // A reply in the correction's thread, before Slack has answered the correction.
      const inThread = (ts: string) => ({ channel: IDS.notice, thread_ts: IDS.correctionTs, ts, text: r.body })
      await r.receive(inThread(IDS.replyTs))
      expect(r.acks).toHaveLength(3)
      expect(holds(r)).toEqual([[IDS.ts, undefined, undefined], [IDS.replyTs, 'post', 'unresolved']])
      expect(r.threads!.memory.view(r.alpha, IDS.notice, IDS.correctionTs)).toBe('not-joined')
      correcting.settle({ kind: 'ok', result: { ts: IDS.correctionTs } })
      await until(r, () => holds(r)[1]![2] === 'released')
      expect(r.threads!.memory.view(r.alpha, IDS.notice, IDS.correctionTs)).toBe('joined')
      expect(r.queue.items(r.alpha)[1]!.accepted.via).toBe('thread')
      await r.receive(inThread(IDS.laterReplyTs))
      expect(r.acks).toHaveLength(4)
      expect(holds(r).at(-1)).toEqual([IDS.laterReplyTs, undefined, undefined])
      expect(r.queue.items(r.alpha).at(-1)!.accepted.via).toBe('thread')
      expect(recoveryLines(r)).toEqual([editFailed(r), recoveryLine(r, 'correction', { outcome: 'success' })])
      expect(r.h.posts(r.alpha)).toHaveLength(2)
    })

    test('a posted warning is corrected once after the ack of its exact save as a Post Hold, before release; the release adds nothing', async () => {
      const r = await storage({ threads: true, destination: 'channel' })
      await pendingPost(r)
      r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: IDS.warningTs } })
      await fail(r, reply(r))
      expect(r.h.posts(r.alpha)).toEqual([{ channel: IDS.notice, text: warning(r) }])
      r.failStores(false); await r.receive(reply(r))
      // Nothing before the ack waits on Slack; the held save corrects after it.
      expect(r.editsAtAck).toEqual([0])
      const updates = r.h.stub(r.alpha).calls.update
      expect(updates).toEqual([expect.objectContaining({ channel: IDS.notice, ts: IDS.warningTs })])
      recovered(r, updates[0]!)
      expect(recoveryLines(r)).toEqual([recoveryLine(r, 'edit', { outcome: 'success' })])
      expect(holds(r)).toEqual([[IDS.ts, 'post', 'unresolved']])
      // A redelivery stores and corrects nothing more.
      await r.receive(reply(r))
      expect(r.acks).toHaveLength(2)
      expect(readQueue(r.root, r.alpha).filter(record => record.kind === 'accepted')).toHaveLength(1)
      // The post's answer never comes: the hold releases at its deadline, joining nothing.
      await r.threads!.clock.advance(THREAD_REPLY_HOLD_MS)
      for (let turn = 0; turn < 20 && holds(r)[0]![2] !== 'released'; turn++) await r.flush()
      expect(holds(r)).toEqual([[IDS.ts, 'post', 'released']])
      await r.flush()
      expect(r.h.stub(r.alpha).calls.update).toHaveLength(1)
      expect(r.h.posts(r.alpha)).toHaveLength(1)
      expect(recoveryLines(r)).toHaveLength(1)
    })

    test('a held save of another message corrects nothing; the exact held save corrects the posted warning once', async () => {
      const r = await storage({ threads: true })
      await pendingPost(r)
      await posted(r, reply(r))
      r.failStores(false); await r.receive(reply(r, IDS.otherTs))
      expect(holds(r)).toEqual([[IDS.otherTs, 'post', 'unresolved']])
      expect(r.h.stub(r.alpha).calls.update).toEqual([])
      await r.receive(reply(r))
      expect(r.acks).toHaveLength(2)
      expect(holds(r)).toEqual([[IDS.otherTs, 'post', 'unresolved'], [IDS.ts, 'post', 'unresolved']])
      const updates = r.h.stub(r.alpha).calls.update
      expect(updates).toEqual([expect.objectContaining({ channel: noticeDm, ts: warningTs })])
      recovered(r, updates[0]!)
      expect(r.h.posts(r.alpha)).toHaveLength(1)
    })

    test('a failed store of a mention that joins its thread posts only the ordinary warning, and its exact save corrects it', async () => {
      const r = await storage({ threads: true, destination: 'channel' })
      r.h.stub(r.alpha).script.post.push({ kind: 'ok', result: { ts: IDS.warningTs } })
      await fail(r)
      // The failed store kept no join; the warning is the plain storage warning.
      expect(r.threads!.memory.view(r.alpha, IDS.source, IDS.ts)).toBe('not-joined')
      expect(r.h.posts(r.alpha)).toEqual([{ channel: IDS.notice, text: warning(r) }])
      await retry(r)
      expect(r.queue.items(r.alpha)[0]!.accepted.thread_join).toMatchObject({ thread_ts: IDS.ts })
      expect(r.threads!.memory.view(r.alpha, IDS.source, IDS.ts)).toBe('joined')
      const updates = r.h.stub(r.alpha).calls.update
      expect(updates).toEqual([expect.objectContaining({ channel: IDS.notice, ts: IDS.warningTs })])
      recovered(r, updates[0]!)
      expect(r.h.posts(r.alpha)).toHaveLength(1)
      expect(r.logs.filter(line => line.includes(MESSAGE_NOT_SAVED))).toEqual([
        expect.stringContaining('count=1'), recoveryLine(r, 'edit', { outcome: 'success' }),
      ])
      expect(JSON.stringify(r.captured())).not.toMatch(/participation/i)
    })
  })
})
