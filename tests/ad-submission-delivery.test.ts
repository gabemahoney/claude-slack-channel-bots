import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryLifecycle, deliveryTextWasRefused, DELIVERY_ROW_POLL_MS, ENTER_DELAY_MS, NOT_NOW_RETRY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS } from '../src/delivery-engine.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { errCallTimeout, errSubmissionUnconfirmed, errTmuxSessionConflict } from './test-helpers/agent-director-stub.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'
import { sentRecord } from './test-helpers/delivery-queue.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { createQueueDeliveryReceiptReader } from '../src/delivery-receipt.ts'
import { makeInputHoldFixture } from './test-helpers/ad-input-holds.ts'
import { buildAdDeliveryUnconfirmedNotice } from '../src/ad-input-notices.ts'
import { AD_INPUT_HOLD_MAX_BYTES } from '../src/ad-input-holds.ts'
import { AD_INPUT_NEW_LAUNCH, AD_INPUT_UNCONFIRMED } from '../src/ad-input-custody.ts'
import * as session from '../src/session-manager.ts'
import { makeRecoveryHarness } from './test-helpers/recovery-harness.ts'

const harnesses: EngineHarness[] = []
const holdRoots: string[] = []
afterEach(async () => {
  try { for (const h of harnesses.splice(0).reverse()) await h.cleanup() }
  finally { for (const root of holdRoots.splice(0)) rmSync(root, { recursive: true, force: true }) }
})
const uncertain = { outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true }
const noInput = { outcome: 'not_started', keys_sent: false, submission_confirmed: false, enter_may_have_been_sent: false }
const holdWindow = RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0] + NOT_NOW_RETRY_MS[0] + ENTER_DELAY_MS
const allRetryDeadlines = RECEIPT_WAIT_MS + Math.max(...RETYPE_BACKOFF_MS, ...NOT_NOW_RETRY_MS) + ENTER_DELAY_MS
const failedReadCases = (['text', 'enter'] as const).flatMap(step => [
  { step, fault: 'timeout', error: () => errCallTimeout('get') },
  { step, fault: 'refusal', error: () => errTmuxSessionConflict('get', 'different-id') },
])

async function fixture(step: 'text' | 'enter' = 'text', options: Parameters<typeof makeEngineHarness>[0] = {}, details: unknown = uncertain, readFailure?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'submission-delivery-')); holdRoots.push(root)
  let h!: EngineHarness
  const disk = await makeInputHoldFixture(root, () => h.clock.now())
  for (const key of options.keys ?? ['alpha']) disk.store.load(key)
  let holds = disk.store
  h = await makeEngineHarness({ ...options, stateDir: root, get inputHolds() { return holds } }); harnesses.push(h)
  h.p().row.started_at = new Date(0).toISOString()
  h.p().row.launch_started_at = new Date(0).toISOString()
  await h.accept('retained message')
  h.p().autoReceipt = false
  let fired = false, failedAt = -1, rejectNextRead = false, failedReads = 0
  if (readFailure) h.p().getHook = () => {
    h.p().getError = rejectNextRead ? readFailure : undefined
    if (rejectNextRead) { failedReads++; rejectNextRead = false }
  }
  h.p().keyHook = params => {
    if (!fired && (step === 'text' ? params.no_enter : params.key === 'Enter')) {
      fired = true; failedAt = h.calls.length
      rejectNextRead = true
      if (params.no_enter) h.p().box = params.text!
      return errSubmissionUnconfirmed(details)
    }
    return undefined
  }
  return { h, disk, reloadHolds() { holds = disk.fresh(); for (const key of options.keys ?? ['alpha']) holds.load(key); return holds }, dispatch: async () => { await h.tick(); if (step === 'enter') await h.advance(ENTER_DELAY_MS); await h.clock.flush() }, failedAt: () => failedAt, failedReads: () => failedReads }
}

describe('native uncertain delivery owns a durable receipt-only hold', () => {
  test.each(['text', 'enter'] as const)('%s uncertainty persists the hold before the queue block, AD state read and notice', async step => {
    const order: string[] = []
    const f = await fixture(step, { onSubmissionUnconfirmed: () => { order.push('notice') } })
    const mark = f.disk.store.markUncertain
    f.disk.store.markUncertain = (...args) => {
      const result = mark(...args)
      expect(result.ok).toBe(true)
      expect(f.disk.fresh().load('alpha')).toEqual(f.disk.store.get('alpha'))
      order.push('durable-uncertain')
      return result
    }
    const append = f.h.queue.append
    f.h.queue.append = async (key, record) => {
      await append(key, record)
      if (record.kind === 'submission-blocked') order.push('durable-block')
    }
    f.h.p().getHook = () => { if (f.failedAt() >= 0) order.push('get') }
    await f.dispatch()
    expect(order).toEqual(['durable-uncertain', 'durable-block', 'get', 'notice'])
    expect(f.disk.fresh().load('alpha')).toMatchObject({ kind: 'record', record: { step: 'uncertain', delivery: { seq: 1, part: 1, attempt: 1 } } })
    assertNoLeak([f.h.errors, f.h.events, f.h.records(), writtenFile(f.h.root)])
  })

  test.each(['text', 'enter'] as const)('crash after the first durable %s uncertainty write holds before the queue block exists', async step => {
    const notices: unknown[] = [], crash = new Error('simulated crash after first durable hold')
    const f = await fixture(step, { onSubmissionUnconfirmed: (...args) => { notices.push(args) } })
    const mark = f.disk.store.markUncertain
    let stopped: Promise<void> | undefined
    f.disk.store.markUncertain = (...args) => {
      const result = mark(...args)
      expect(result.ok).toBe(true)
      // A crash ends the old executor; dispatch's clock driver must not
      // perform another tick of that executor after the injected interruption.
      stopped = f.h.engine.stop()
      throw crash
    }
    await f.dispatch()
    await stopped
    expect(f.h.errors).toEqual([crash])
    expect(f.h.calls.slice(f.failedAt()).filter(c => c.verb === 'get')).toEqual([])
    expect(notices).toEqual([])
    expect(f.h.records().filter(r => r.kind === 'submission-blocked')).toEqual([])
    expect(f.h.clock.pending()).toEqual([])
    const before = [...f.h.keyCalls()]
    const holds = f.reloadHolds()
    expect(holds.get('alpha')).toMatchObject({ kind: 'record', record: { step: 'uncertain' } })
    await f.h.restartServer(); await f.h.advance(allRetryDeadlines)
    expect(f.h.lifecycle.inputHeld('alpha')).toBe(true)
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.queue.openCount('alpha')).toBe(1)
    expect(f.h.restarts).toEqual([])
    assertNoLeak([notices, f.h.errors, f.h.events, f.h.records(), writtenFile(f.h.root)])
  })

  test.each(failedReadCases)('$step uncertainty stays held across a fresh-get $fault, retry deadlines and queue reload', async ({ step, error }) => {
    const info: string[] = [], reports: unknown[] = []
    const f = await fixture(step, { onInfo: (_key, message) => info.push(message), onSubmissionUnconfirmed: (...args) => reports.push(args) }, uncertain, error())
    const h = f.h
    try {
      await f.dispatch()
      expect(f.failedReads()).toBe(1)
      expect(h.calls.slice(f.failedAt())[0]?.verb).toBe('get')
      expect(h.calls.slice(f.failedAt()).filter(call => call.verb === 'get')).toHaveLength(1)
      expect(reports).toHaveLength(1)
      const calls = [...h.keyCalls()]
      const blocks = h.records().filter(record => record.kind === 'submission-blocked')
      expect(blocks).toHaveLength(1)
      expect(h.records().filter(record => record.kind === 'refused')).toEqual([])
      // Further reads return ordinary waiting; that is never release evidence.
      h.p().row.state = 'waiting'
      for (const restart of [false, true]) {
        if (restart) { f.reloadHolds(); await h.restartServer() }
        await h.advance(allRetryDeadlines)
        expect(h.keyCalls()).toEqual(calls)
        expect(h.records().filter(record => record.kind === 'submission-blocked')).toEqual(blocks)
        expect(h.records().filter(record => record.kind === 'delivered')).toEqual([])
        expect(h.queue.openCount('alpha')).toBe(1)
        expect(h.restarts).toEqual([])
        expect(JSON.stringify({ info, errors: h.errors, events: h.events })).not.toContain('nothing was typed')
      }
      expect(f.failedReads()).toBe(1)
      expect(h.calls.slice(f.failedAt()).filter(call => call.verb === 'get').length).toBeGreaterThan(1)
      expect(h.calls.filter(call => call.verb === 'read-pane' || call.verb === 'reconnect')).toEqual([])
    } finally { assertNoLeak({ info, reports, events: h.events, errors: h.errors, records: h.records(), state: writtenFile(h.root) }) }
  })

  test.each(['text', 'enter'] as const)('%s refusal appends submission-blocked for the actual sent attempt and reads AD once', async step => {
    const reports: unknown[] = []
    const f = await fixture(step, { onSubmissionUnconfirmed: (...args: unknown[]) => reports.push(args) })
    await f.dispatch()
    const sent = f.h.records().filter(r => r.kind === 'sent').at(-1)!
    expect(f.h.records()).toContainEqual(expect.objectContaining({ v: 1, kind: 'submission-blocked', seq: 1, attempt: sent.attempt, reason: 'ad-input-unconfirmed' }))
    expect(f.h.calls.slice(f.failedAt()).filter(c => c.verb === 'get')).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(f.h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test.each(['text', 'enter'] as const)('%s uncertainty survives waiting/working and retry deadlines without any more keys', async step => {
    const f = await fixture(step); await f.dispatch()
    const before = [...f.h.keyCalls()]
    for (const state of ['working', 'waiting'] as const) { f.h.p().row.state = state; await f.h.advance(holdWindow) }
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.restarts).toEqual([])
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test('gateway_refused never enters generic recovery Enter or automatic resubmission', async () => {
    const f = await fixture('text', {}, { ...uncertain, outcome: 'gateway_refused', reason: 'capacity' })
    await f.dispatch(); await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toHaveLength(1)
    expect(deliveryTextWasRefused(errSubmissionUnconfirmed({ ...uncertain, outcome: 'gateway_refused', reason: 'capacity' }))).toBe(false)
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test.each([
    ['partial', { ...uncertain, outcome: 'partial_input_unconfirmed', enter_may_have_been_sent: false }],
    ['legacy', { keys_sent: true, submission_confirmed: false, row_state: 'pending' }],
    ['malformed', { outcome: 'not_started', keys_sent: true }],
    ['unknown', { ...uncertain, outcome: 'future_outcome' }],
  ] as const)('%s uncertainty also blocks every automatic key', async (_name, details) => {
    const f = await fixture('text', {}, details); await f.dispatch(); await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toHaveLength(1)
    expect(f.h.records().filter(r => r.kind === 'submission-blocked')).toHaveLength(1)
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test('an exact late receipt settles the retained part without more keys', async () => {
    const f = await fixture()
    await f.dispatch()
    const before = [...f.h.keyCalls()]
    appendTranscript(f.h.p().path, [promptEntry('unrelated message')])
    await f.h.tick()
    expect(f.h.queue.openCount('alpha')).toBe(1)
    appendTranscript(f.h.p().path, [promptEntry('retained message')])
    await f.h.until(() => f.h.queue.openCount('alpha') === 0)
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.records().filter(r => r.kind === 'submission-blocked')).toHaveLength(1)
    expect(f.h.records().filter(r => r.kind === 'delivered')).toHaveLength(1)
  })

  test('a delivered uncertain first part does not block the same item second part', async () => {
    const h = await makeEngineHarness(); harnesses.push(h)
    await h.accept('firstsecond', 'alpha', ['first', 'second'])
    h.p().autoReceipt = false
    let refused = false
    h.p().keyHook = params => { if (!refused && params.no_enter) { refused = true; return errSubmissionUnconfirmed(uncertain) }; return undefined }
    await h.tick()
    expect(h.records().filter(r => r.kind === 'submission-blocked')).toHaveLength(1)
    appendTranscript(h.p().path, [promptEntry('first')])
    h.p().autoReceipt = true
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['first', 'second'])
    expect(h.records().filter(r => r.kind === 'delivered').map(r => r.part)).toEqual([1, 2])
  })

  test.each([['same process', false], ['fresh engine', true]] as const)('queue block append failure holds keys in %s and closes the error-to-append crash window', async (_name, restart) => {
    const f = await fixture()
    f.h.failAppend('submission-blocked', Number.MAX_SAFE_INTEGER)
    await f.dispatch()
    const before = [...f.h.keyCalls()]
    if (restart) { f.reloadHolds(); await f.h.restartServer() }
    await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.queue.openCount('alpha')).toBe(1)
    expect(f.h.restarts).toEqual([])
  })

  test('a fresh engine loaded after uncertainty never retypes or sends recovery Enter', async () => {
    const f = await fixture(); await f.dispatch()
    const before = [...f.h.keyCalls()]
    f.reloadHolds(); await f.h.restartServer()
    await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test('failed submission-blocked persistence retries only the append', async () => {
    const f = await fixture(); f.h.failAppend('submission-blocked')
    await f.dispatch()
    const keys = [...f.h.keyCalls()]
    await f.h.until(() => f.h.records().some(r => r.kind === 'submission-blocked'))
    expect(f.h.keyCalls()).toEqual(keys)
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test('an ordinary sent intent without uncertainty recovers Enter after restart (test-41)', async () => {
    const h = await makeEngineHarness(); harnesses.push(h)
    await h.accept('retained message')
    h.p().box = 'retained message'
    await h.queue.append('alpha', sentRecord(1, 1, 'text', { part: 1, at: h.clock.now(), session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size }))
    await h.restartServer(); await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['Enter'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter'])
  })

  test('a new AD launch releases uncertainty into recovery but is never delivery proof', async () => {
    const f = await fixture(); await f.dispatch()
    const before = [...f.h.keyCalls()]
    f.h.p().row.state = 'pending'; f.h.p().row.launch_started_at = '2026-11-20T03:00:00Z'
    await f.h.advance(NOT_NOW_RETRY_MS[0])
    f.h.p().row.state = 'waiting'; await f.h.advance(holdWindow)
    expect(f.h.keyCalls().length).toBeGreaterThan(before.length)
    expect(f.h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(f.h.queue.openCount('alpha')).toBe(1)
  })

  test('not_started text records a refusal and retries the text only after fresh AD guards', async () => {
    const f = await fixture('text', {}, noInput); await f.dispatch()
    expect(f.h.records().filter(r => r.kind === 'refused')).toHaveLength(1)
    expect(deliveryTextWasRefused(errSubmissionUnconfirmed(noInput))).toBe(true)
    f.h.p().row.state = 'working'; await f.h.advance(NOT_NOW_RETRY_MS[0])
    expect(f.h.keyCalls()).toHaveLength(1)
    f.h.p().row.state = 'waiting'; f.h.p().autoReceipt = true
    await f.h.until(() => f.h.queue.openCount('alpha') === 0)
    expect(f.h.textCalls()).toHaveLength(2)
  })

  test('not_started Enter keeps the known text and retries only Enter', async () => {
    const f = await fixture('enter', {}, noInput); await f.dispatch()
    f.h.p().autoReceipt = true
    await f.h.until(() => f.h.queue.openCount('alpha') === 0)
    expect(f.h.textCalls()).toHaveLength(1)
    expect(f.h.keyCalls().map(c => c.params.key ?? 'text')).toEqual(['text', 'Enter', 'Enter'])
    expect(f.h.records().filter(r => r.kind === 'refused')).toEqual([])
  })

  test('a held persona does not block its sibling and no empty queue starts polling', async () => {
    const f = await fixture('text', { keys: ['alpha', 'beta'] }); await f.dispatch()
    await f.h.accept('sibling', 'beta'); await f.h.tick('beta')
    await f.h.until(() => f.h.queue.openCount('beta') === 0)
    expect(f.h.textCalls('alpha')).toHaveLength(1)
    expect(f.h.textCalls('beta').map(c => c.params.text)).toEqual(['sibling'])
    const betaCalls = f.h.calls.filter(c => c.key === 'beta')
    await f.h.advance(holdWindow)
    expect(f.h.calls.filter(c => c.key === 'beta')).toEqual(betaCalls)
    expect(f.h.keyCalls('alpha')).toHaveLength(1)
  })
})

describe('option A crash recovery uses receipts before input', () => {
  async function observedHarness() {
    const observations: string[] = []
    const notices: string[] = []
    let h!: EngineHarness
    h = await makeEngineHarness({ onSubmissionUnconfirmed: () => notices.push(buildAdDeliveryUnconfirmedNotice({ key: 'alpha' })), receiptReader: () => {
      const real = createQueueDeliveryReceiptReader(h.queue, 'alpha')
      return { forget: () => real.forget(), read(...args) {
        observations.push('receipt')
        return real.read(...args)
      } }
    } })
    harnesses.push(h)
    h.p().getHook = () => { observations.push('get') }
    h.p().keyHook = params => { observations.push(params.key ?? 'text'); return undefined }
    h.p().row.started_at = new Date(0).toISOString()
    h.p().row.launch_started_at = new Date(0).toISOString()
    return { h, observations, notices }
  }

  test.each([false, true])('ordinary text-before-Enter restart reads the receipt first; existing receipt=%s', async receipted => {
    const { h, observations, notices } = await observedHarness()
    await h.accept('crash draft'); await h.tick()
    expect(h.keyCalls().map(c => c.params.text ?? c.params.key)).toEqual(['crash draft'])
    expect(h.records().filter(r => r.kind === 'submission-blocked')).toEqual([])
    expect(notices).toEqual([])
    if (receipted) appendTranscript(h.p().path, [promptEntry('crash draft')])
    observations.length = 0
    await h.restartServer(); await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(receipted ? ['crash draft'] : ['crash draft', 'Enter'])
    expect(observations).toContain('receipt')
    if (!receipted) {
      expect(observations).toContain('get')
      expect(observations).toContain('Enter')
      expect(observations.indexOf('receipt')).toBeLessThan(observations.indexOf('Enter'))
      expect(observations.indexOf('get')).toBeLessThan(observations.indexOf('Enter'))
    }
    await h.engine.stop()
    expect(h.clock.pending()).toEqual([])
    expect(h.errors).toEqual([])
  })

  test('a retry episode restarted on a same-session resume resets recovery spacing (test-33)', async () => {
    const { h, observations } = await observedHarness(), p = h.p()
    await h.accept('retry draft'); p.autoReceipt = false
    await h.tick()
    await h.until(() => h.textCalls().length === 3)
    await h.advance(ENTER_DELAY_MS)
    const oldCalls = h.keyCalls().length, sessionId = p.row.session_id
    p.row.state = 'missing'; await h.advance(DELIVERY_ROW_POLL_MS)
    await h.restartServer(); await h.tick()
    p.row.state = 'waiting'; p.row.launch_started_at = new Date(h.clock.now()).toISOString()
    await h.until(() => h.keyCalls().length > oldCalls)
    const firstWaiting = h.events.filter(e => e.type === 'launch-first-waiting').at(-1)!
    expect(firstWaiting).toMatchObject({ sessionId })
    expect(h.keyCalls()[oldCalls]!.params.key).toBe('Enter')
    expect(h.keyCalls()[oldCalls]!.at).toBe(firstWaiting.at)
    await h.until(() => h.textCalls().length === 4)
    expect(h.textCalls().at(-1)!.at - firstWaiting.at).toBe(RETYPE_BACKOFF_MS[0])
    expect(observations).toContain('receipt')
    p.autoReceipt = true
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.records().filter(r => r.kind === 'submission-blocked')).toEqual([])
    expect(h.errors).toEqual([])
  })

  test.each(['same-live', 'spawn', 'missing-resume', 'ended-resume'] as const)('durable submission-blocked after restart: %s', async launch => {
    const { h, observations, notices } = await observedHarness()
    await h.accept('held draft'); h.p().box = 'held draft'
    await h.queue.append('alpha', sentRecord(1, 1, 'text', { part: 1, at: 0, session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size }))
    await h.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq: 1, attempt: 1, at: 0, reason: 'ad-input-unconfirmed' })
    await h.restartServer(); await h.tick()
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(notices).toEqual([buildAdDeliveryUnconfirmedNotice({ key: 'alpha' })])
    if (launch === 'same-live') {
      await h.advance(allRetryDeadlines)
      expect(h.keyCalls()).toEqual([])
      expect(h.queue.openCount('alpha')).toBe(1)
    } else {
      await h.advance(1)
      h.p().autoReceipt = false
      const sessionId = h.p().row.session_id
      if (launch === 'spawn') h.p().row.session_id = 'fresh-spawn-session'
      else { h.p().row.state = launch === 'missing-resume' ? 'missing' : 'ended'; await h.advance(DELIVERY_ROW_POLL_MS) }
      h.p().row.state = 'waiting'
      // Keep the stamp unchanged: a missed pending sample cannot hide either
      // the fresh session or the previously observed finished row.
      observations.length = 0
      await h.until(() => h.keyCalls().length > 0)
      expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['Enter'])
      expect(h.queue.openCount('alpha')).toBe(1)
      expect(h.p().row.session_id).toBe(launch === 'spawn' ? 'fresh-spawn-session' : sessionId)
      expect(observations).toContain('receipt')
      expect(observations).toContain('Enter')
      expect(observations.indexOf('receipt')).toBeLessThan(observations.indexOf('Enter'))
      // Restart before any receipt: the old uncertainty must stay released.
      h.p().box = 'held draft'; h.p().autoReceipt = true
      await h.restartServer(); await h.until(() => h.queue.openCount('alpha') === 0)
      expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['Enter', 'Enter'])
    }
    expect(h.records().filter(r => r.kind === 'submission-blocked' && r.reason === 'ad-input-unconfirmed')).toHaveLength(1)
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
    expect(h.errors).toEqual([])
  })
})

describe('shared launch observations preserve exact-attempt release across restart', () => {
  async function sharedRelease(dead: 'ended' | 'missing') {
    const reads: string[] = []
    let h!: EngineHarness
    const f = await fixture('text', { receiptReader: () => {
      const reader = createQueueDeliveryReceiptReader(h.queue, 'alpha')
      return { forget: () => reader.forget(), read(...args) { reads.push('receipt'); return reader.read(...args) } }
    } })
    h = f.h
    await f.dispatch()
    await h.engine.stop()
    expect(h.clock.pending()).toEqual([])
    expect(h.records().filter(r => r.kind === 'submission-blocked')).toMatchObject([{ attempt: 1, reason: AD_INPUT_UNCONFIRMED }])
    const notices: string[] = [], logs: string[] = [], row = h.p().row
    const shared = makeRecoveryHarness({ personas: [{ key: 'alpha' }] })
    shared.script({ getFn: () => ({ ...row }) })
    session.setDeliveryLifecycle(h.lifecycle)
    session.setSubmissionInputServices({ holds: f.disk.store, notify: (_key, text) => { notices.push(text) }, log: line => logs.push(line) })
    try {
      row.state = dead
      await session.readPersonaOwnRow('alpha', { site: 'test', what: 'get' })
      expect(f.disk.fresh().load('alpha')).toMatchObject({ kind: 'record', record: { finished: true, delivery: { seq: 1, part: 1, attempt: 1 } } })
      row.state = 'waiting'; row.launch_started_at = null
      await session.readPersonaOwnRow('alpha', { site: 'test', what: 'get' })
      expect(shared.stub.callCount()).toBe(2)
      expect(shared.stub.calls.getCalls).toEqual(Array(2).fill({ instance_id: row.instance_id }))
      expect(f.disk.store.get('alpha')).toEqual({ kind: 'clear' })
      expect(h.lifecycle.inputHeld('alpha')).toBe(false)
      const proofPath = `${f.disk.store.path('alpha')}.released`
      expect(existsSync(f.disk.store.path('alpha'))).toBe(false)
      expect(existsSync(proofPath)).toBe(true)
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
      expect(proof).toMatchObject({ hold: { finished: true, step: 'uncertain', delivery: { seq: 1, part: 1, attempt: 1 } }, row: { state: 'waiting', sessionId: row.session_id, launchStartedAt: null } })
      // The engine never saw either shared reading; its queue has no finished
      // or release marker when both stores and the executor are restarted.
      expect(h.records().filter(r => r.kind === 'submission-blocked')).toHaveLength(1)
      assertNoLeak([notices, logs, proof, h.errors])
      return { ...f, reads, proofPath }
    } finally {
      session.setSubmissionInputServices(undefined)
      session.setDeliveryLifecycle(undefined)
      shared.cleanup()
    }
  }

  test.each(['ended', 'missing'] as const)('shared %s then same-session waiting without a pending stamp releases only after a receipt read', async dead => {
    const f = await sharedRelease(dead), h = f.h
    const keys = [...h.keyCalls()]
    const holds = f.reloadHolds()
    expect(holds.get('alpha')).toEqual({ kind: 'clear' })
    expect(holds.releasedDelivery('alpha')).toEqual({ seq: 1, part: 1, attempt: 1 })
    f.reads.length = 0
    h.p().keyHook = params => { f.reads.push(params.key ?? 'text'); return undefined }
    h.p().autoReceipt = true
    await h.restartServer()
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.keyCalls().slice(keys.length).map(c => c.params.key ?? c.params.text)).toEqual(['Enter'])
    expect(h.textCalls()).toHaveLength(1)
    expect(f.reads.indexOf('receipt')).toBeGreaterThanOrEqual(0)
    expect(f.reads).toContain('Enter')
    expect(f.reads.indexOf('receipt')).toBeLessThan(f.reads.indexOf('Enter'))
    expect(h.records().filter(r => r.kind === 'submission-blocked' && r.reason === AD_INPUT_NEW_LAUNCH)).toMatchObject([{ seq: 1, attempt: 1 }])
    expect(h.records().filter(r => r.kind === 'delivered')).toHaveLength(1)
    await h.engine.stop()
    expect(h.clock.pending()).toEqual([])
    expect(h.errors).toEqual([])
    assertNoLeak([h.errors, h.events, h.records(), writtenFile(h.root)])
  })

  test.each(['malformed', 'unreadable', 'oversized', 'foreign-persona', 'foreign-instance', 'same-launch', 'invalid-binding-timestamp'] as const)('%s released proof grants no input or release marker', async fault => {
    const f = await sharedRelease('missing'), h = f.h
    if (fault === 'malformed') writeFileSync(f.proofPath, '{')
    if (fault === 'oversized') writeFileSync(f.proofPath, ' '.repeat(AD_INPUT_HOLD_MAX_BYTES + 1))
    if (fault === 'unreadable') { rmSync(f.proofPath); mkdirSync(f.proofPath) }
    if (fault === 'foreign-persona' || fault === 'foreign-instance' || fault === 'same-launch' || fault === 'invalid-binding-timestamp') {
      const proof = JSON.parse(readFileSync(f.proofPath, 'utf8'))
      if (fault === 'foreign-persona') {
        proof.hold.key = 'beta'
        proof.hold.binding.instanceId = 'cscb_beta'
        proof.row.instanceId = 'cscb_beta'
      }
      if (fault === 'foreign-instance') {
        proof.hold.binding.instanceId = 'cscb_beta'
        proof.row.instanceId = 'cscb_beta'
      }
      if (fault === 'same-launch') {
        delete proof.hold.finished
        const binding = proof.hold.binding
        proof.row = { instanceId: binding.instanceId, state: 'waiting', rowStartedAt: binding.rowStartedAt, sessionId: binding.sessionId, launchStartedAt: binding.launchStartedAt }
      }
      if (fault === 'invalid-binding-timestamp') proof.hold.binding.rowStartedAt = '2026-11-31T03:00:00Z'
      const bytes = JSON.stringify(proof)
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(AD_INPUT_HOLD_MAX_BYTES)
      writeFileSync(f.proofPath, bytes)
      expect(JSON.parse(readFileSync(f.proofPath, 'utf8'))).toEqual(proof)
    }
    const holds = f.reloadHolds(), keys = [...h.keyCalls()]
    expect(holds.get('alpha')).toEqual({ kind: 'clear' })
    expect(holds.releasedDelivery('alpha')).toBeUndefined()
    await h.restartServer(); await h.advance(allRetryDeadlines)
    expect(h.keyCalls()).toEqual(keys)
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.lifecycle.inputHeld('alpha')).toBe(true)
    expect(h.records().filter(r => r.kind === 'submission-blocked')).toMatchObject([{ attempt: 1, reason: AD_INPUT_UNCONFIRMED }])
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(h.errors).toEqual([])
    assertNoLeak([h.errors, h.events, h.records(), writtenFile(h.root)])
  })

  test('a newer blocked attempt cannot borrow an older released proof for the same item and part', async () => {
    const f = await sharedRelease('ended'), h = f.h
    await h.queue.append('alpha', sentRecord(1, 2, 'retype', { at: h.clock.now(), part: 1, session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size }))
    await h.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq: 1, attempt: 2, at: h.clock.now(), reason: AD_INPUT_UNCONFIRMED })
    const holds = f.reloadHolds(), keys = [...h.keyCalls()]
    expect(holds.releasedDelivery('alpha')).toEqual({ seq: 1, part: 1, attempt: 1 })
    await h.restartServer(); await h.advance(allRetryDeadlines)
    expect(h.keyCalls()).toEqual(keys)
    expect(h.lifecycle.inputHeld('alpha')).toBe(true)
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.records().filter(r => r.kind === 'submission-blocked' && r.reason === AD_INPUT_NEW_LAUNCH)).toMatchObject([{ seq: 1, attempt: 1 }])
    expect(h.records().flatMap(r => r.kind === 'submission-blocked' && r.reason === AD_INPUT_UNCONFIRMED ? [r.attempt] : [])).toEqual([1, 2])
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(h.errors).toEqual([])
    assertNoLeak([h.errors, h.events, h.records(), writtenFile(h.root)])
  })
})

test('empty queues remain silent even when their personas have input holds', async () => {
  const h = await makeEngineHarness({ keys: ['alpha', 'beta'] }); harnesses.push(h)
  h.lifecycle.holdInput('alpha')
  await h.tick('alpha'); await h.tick('beta'); await h.advance(holdWindow)
  expect(h.calls).toEqual([])
})

test('input hold is distinct from typing ownership, connection observations and deferred work', async () => {
  const clock = createFakeClock(), life = createDeliveryLifecycle({ clock })
  try {
    const release = life.acquire('alpha', 'delivery')!
    life.holdInput('alpha'); release()
    for (const state of ['working', 'waiting']) life.observeRow('alpha', { state, session_id: 'alpha-session' })
    life.clearDeferred('alpha')
    expect(life.inputHeld('alpha')).toBe(true)
    expect(life.acquire('alpha', 'delivery')).toBeUndefined()
    expect(life.acquire('alpha', 'reconnect')).toBeUndefined()
    const sibling = life.acquire('beta', 'delivery'); expect(sibling).toBeDefined(); sibling?.()
    life.releaseInput('alpha')
    const resumed = life.acquire('alpha', 'delivery'); expect(resumed).toBeDefined(); resumed?.()
  } finally { await life.stop() }
})
