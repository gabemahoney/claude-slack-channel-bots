import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryLifecycle, deliveryTextWasRefused, ENTER_DELAY_MS, NOT_NOW_RETRY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS } from '../src/delivery-engine.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { errCallTimeout, errSubmissionUnconfirmed, errTmuxSessionConflict } from './test-helpers/agent-director-stub.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'
import { sentRecord } from './test-helpers/delivery-queue.ts'
import { statSync } from 'node:fs'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
const uncertain = { outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true }
const noInput = { outcome: 'not_started', keys_sent: false, submission_confirmed: false, enter_may_have_been_sent: false }
const holdWindow = RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0] + NOT_NOW_RETRY_MS[0] + ENTER_DELAY_MS
const allRetryDeadlines = RECEIPT_WAIT_MS + Math.max(...RETYPE_BACKOFF_MS, ...NOT_NOW_RETRY_MS) + ENTER_DELAY_MS
const failedReadCases = (['text', 'enter'] as const).flatMap(step => [
  { step, fault: 'timeout', error: () => errCallTimeout('get') },
  { step, fault: 'refusal', error: () => errTmuxSessionConflict('get', 'different-id') },
])

async function fixture(step: 'text' | 'enter' = 'text', options: Parameters<typeof makeEngineHarness>[0] = {}, details: unknown = uncertain, readFailure?: Error) {
  const h = await makeEngineHarness(options); harnesses.push(h)
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
  return { h, dispatch: async () => { await h.tick(); if (step === 'enter') await h.advance(ENTER_DELAY_MS); await h.clock.flush() }, failedAt: () => failedAt, failedReads: () => failedReads }
}

describe('native uncertain delivery owns a durable receipt-only hold', () => {
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
        if (restart) await h.restartServer()
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
    if (restart) await f.h.restartServer()
    await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toEqual(before)
    expect(f.h.queue.openCount('alpha')).toBe(1)
    expect(f.h.restarts).toEqual([])
  })

  test('a fresh engine loaded after uncertainty never retypes or sends recovery Enter', async () => {
    const f = await fixture(); await f.dispatch()
    const before = [...f.h.keyCalls()]
    await f.h.restartServer()
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

  test('an unrefused sent intent recovered without a block record is receipt-only', async () => {
    const h = await makeEngineHarness(); harnesses.push(h)
    await h.accept('retained message')
    await h.queue.append('alpha', sentRecord(1, 1, 'text', { part: 1, at: h.clock.now(), session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size }))
    await h.restartServer(); await h.advance(holdWindow)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
  })

  test('a new AD launch does not count as delivery proof for the retained queued message', async () => {
    const f = await fixture(); await f.dispatch()
    const before = [...f.h.keyCalls()]
    f.h.p().row.state = 'pending'; f.h.p().row.launch_started_at = '2026-11-20T03:00:00Z'
    await f.h.advance(NOT_NOW_RETRY_MS[0])
    f.h.p().row.state = 'waiting'; await f.h.advance(holdWindow)
    expect(f.h.keyCalls()).toEqual(before)
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
