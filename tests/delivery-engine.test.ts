/** b.omv SR-5/6: production executor over a durable queue and real adapters.
 * Receipt permutations and gate lifecycle live in their
 * own suite. Every timestamp and retry is driven by the injected fake clock. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { createDeliveryCallBudget, DELIVERY_MAX_AD_CALLS_PER_S, DELIVERY_ROW_POLL_MS, DeliveryBudgetWait, deliveryTextWasRefused, ENTER_DELAY_MS, LAUNCH_SETTLE_MS, NOT_NOW_RETRY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS } from '../src/delivery-engine.ts'
import { cannedPermissionRequest, errCallTimeout, errConfigMalformed, errDialogMaybeOpen, errInternal, errInvalidFlags, errPaneChanged, errRelayFallenBack, errSendKeysWhileRelayed, errSpawnNotFound, errSpawnNotInteractive, errSystemInstallDisappeared, errTmuxNotAvailable, errTmuxSendKeys, errTmuxSessionConflict, errTmuxUnresponsive, errUnusableName } from './test-helpers/agent-director-stub.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { appendTranscript, codexPromptEntry, endedTurn, promptEntry, queueOperationEntry, replyEntry, writeTranscript } from './test-helpers/working-row-panes.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
async function harness(options: Parameters<typeof makeEngineHarness>[0] = {}) { const h = await makeEngineHarness(options); harnesses.push(h); return h }
async function start(h: EngineHarness, key = 'alpha') { await h.tick(key); await h.advance(LAUNCH_SETTLE_MS) }
async function delivered(h: EngineHarness, key = 'alpha') { await h.until(() => h.queue.openCount(key) === 0) }
async function drainTimers(h: EngineHarness) {
  for (let turns = 0; h.engine.running('alpha') && turns < 1000; turns++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await h.clock.runNext()
  }
  expect(h.queue.openCount('alpha')).toBe(0)
  expect(h.engine.running('alpha')).toBe(false)
}

describe('durable FIFO and send sequence', () => {
  test.each([
    ['claude', 'lost-enter'],
    ['claude', 'missing-receipt'],
    ['codex', 'lost-enter'],
  ] as const)('one wake autonomously recovers %s / %s and delivers the FIFO successor', async (agent, fault) => {
    // The row must select Codex even when configured fallback says Claude.
    const h = await harness({ configuredAgent: 'claude' })
    await h.accept('first'); await h.accept('second')
    const p = h.p()
    p.row.agent = agent
    if (fault === 'lost-enter') p.lostEnters = 1
    else {
      let enters = 0
      p.keyHook = params => { if (params.key === 'Enter') p.autoReceipt = ++enters > 1; return undefined }
    }
    h.engine.wake('alpha')
    // Drive only the injected timers. Yield the real file writer's pending
    // I/O without calling tick, advance, until or another wake on the harness.
    for (let turns = 0; h.queue.openCount('alpha') > 0 && turns < 1000; turns++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await h.clock.runNext()
    }
    expect(h.queue.openCount('alpha')).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(fault === 'lost-enter'
      ? ['first', 'Enter', 'Enter', 'second', 'Enter']
      : ['first', 'Enter', 'Enter', 'first', 'Enter', 'second', 'Enter'])
    const records = h.records()
    expect(records.filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(fault === 'lost-enter' ? ['text', 'enter', 'text'] : ['text', 'enter', 'retype', 'text'])
    expect(records.filter(r => r.kind === 'sent' || r.kind === 'delivered').map(r => [r.kind, r.seq])).toEqual([
      ['sent', 1], ['sent', 1], ...(fault === 'missing-receipt' ? [['sent' as const, 1]] : []), ['delivered', 1], ['sent', 2], ['delivered', 2],
    ])
    if (agent === 'codex') {
      const transcript = readFileSync(p.path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(transcript.filter(record => record.type === 'response_item')).toEqual([codexPromptEntry('first'), codexPromptEntry('second')])
    }
    const calls = h.calls.length
    await h.clock.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(calls)
    expect(h.clock.pending()).toEqual([])
  })

  test('30 items, multipart, retries, server reload and bot restart retain strict one-in-flight order', async () => {
    const h = await harness()
    const expected: string[] = []
    for (let n = 0; n < 30; n++) {
      const parts = n === 4 ? [`part ${n}/1`, `part ${n}/2`] : [`message ${n}`]
      expected.push(...parts)
      await h.accept(`message ${n}`, 'alpha', parts)
    }
    const p = h.p(), attempts: string[] = []
    p.keyHook = params => {
      if (params.no_enter) {
        const head = h.queue.items('alpha').find(i => !i.delivered)!
        const pending = head.fixed!.parts.find((_, i) => !head.records.some(r => r.kind === 'delivered' && r.part === i + 1))
        expect(params.text).toBe(pending)
        attempts.push(params.text!)
      }
      return undefined
    }
    p.lostEnters = 1
    await start(h)
    await h.until(() => h.events.filter(e => e.type === 'delivered').length >= 7)
    await h.restartServer()
    h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(attempts).toEqual(expected)
    expect(h.events.filter(e => e.type === 'delivered').map(e => [e.seq, e.part])).toEqual(expected.flatMap((_, i) => i < 4 ? [[i + 1, 1]] : i === 4 ? [[5, 1]] : i === 5 ? [[5, 2]] : [[i, 1]]))
    expect(h.queue.items('alpha').every(i => i.delivered)).toBe(true)
  })
  test('first text waits for waiting settle; Enter is separate and delayed', async () => {
    const h = await harness()
    await h.accept()
    await h.tick()
    const launch = { key: 'alpha', launchId: h.lifecycle.launchId('alpha'), sessionId: h.p().row.session_id, at: h.clock.now() }
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toEqual([
      { type: 'launch-observed', ...launch }, { type: 'launch-first-waiting', ...launch },
    ])
    await h.advance(LAUNCH_SETTLE_MS - 1)
    expect(h.keyCalls()).toEqual([])
    await h.advance(1)
    expect(h.keyCalls()).toHaveLength(1)
    const text = h.keyCalls()[0]!
    expect(text.params).toEqual({ instance_id: 'cscb_alpha', text: 'message', no_enter: true })
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(1)
    await h.advance(ENTER_DELAY_MS - 1)
    expect(h.keyCalls()).toHaveLength(1)
    await h.advance(1)
    expect(h.keyCalls()[1]).toMatchObject({ at: text.at + ENTER_DELAY_MS, params: { instance_id: 'cscb_alpha', key: 'Enter' } })
    await delivered(h)
    expect(h.events).toContainEqual({ type: 'delivered', key: 'alpha', seq: 1, part: 1 })
    const count = h.calls.length
    await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(count)
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toHaveLength(2)
  })
  test('first-waiting diagnostics start the settle window once per launch, including a replacement session', async () => {
    // b.omv SR-14.2: launch timing evidence must report the same origin that
    // actually gates typing, even when the first observed row is still busy.
    const h = await harness()
    await h.clock.advance(137)
    for (const [i, state] of (['working', 'pending'] as const).entries()) {
      h.p().row.state = state
      h.p().row.session_id = `session-${i}`
      h.p().path = `${h.root}/session-${i}.jsonl`
      h.p().row.jsonl_path = h.p().path
      writeTranscript(h.p().path, endedTurn())
      await h.accept(`message-${i}`)
      await h.tick()
      await h.until(() => h.events.filter(e => e.type === 'launch-observed').length === i + 1)
      const observed = h.events.filter(e => e.type === 'launch-observed')[i]!
      expect(observed).toEqual({ type: 'launch-observed', key: 'alpha', launchId: h.lifecycle.launchId('alpha'), sessionId: `session-${i}`, at: h.clock.now() })
      await h.advance(LAUNCH_SETTLE_MS + DELIVERY_ROW_POLL_MS)
      expect(h.textCalls()).toHaveLength(i)
      expect(h.events.filter(e => e.type === 'launch-first-waiting')).toHaveLength(i)

      const beforeWaiting = h.calls.length
      h.p().row.state = 'waiting'
      await h.until(() => h.events.filter(e => e.type === 'launch-first-waiting').length === i + 1)
      const firstWaiting = h.events.filter(e => e.type === 'launch-first-waiting')[i]!
      expect(firstWaiting).toEqual({ ...observed, type: 'launch-first-waiting', at: h.calls.slice(beforeWaiting).find(c => c.verb === 'get')!.at })
      await h.advance(firstWaiting.at + LAUNCH_SETTLE_MS - h.clock.now() - 1)
      expect(h.textCalls()).toHaveLength(i)
      await h.advance(1)
      expect(h.textCalls()[i]).toMatchObject({ at: firstWaiting.at + LAUNCH_SETTLE_MS, params: { text: `message-${i}`, no_enter: true } })
      await delivered(h)
      expect(h.events.filter(e => e.type.startsWith('launch-'))).toHaveLength((i + 1) * 2)
    }
    const launches = h.events.filter(e => e.type === 'launch-observed')
    expect(launches[0]!.launchId).not.toBe(launches[1]!.launchId)
    expect(h.errors).toEqual([])
  })
  test('20 sequential idle-ready messages meet AC76 with autonomous timers across empty queues', async () => {
    const h = await harness(), typing: number[] = [], confirmation: number[] = []
    for (let n = 0; n < 20; n++) {
      // A real idle gap, rather than a permanently nonempty batch, exercises
      // retirement of each engine while the native launch stays the same.
      const calls = h.calls.length
      await h.clock.advance(50)
      expect(h.calls).toHaveLength(calls)
      expect(h.clock.pending()).toEqual([])
      expect(h.p().row.state).toBe('waiting')
      expect(h.p().connected).toBe(true)
      expect(h.p().box).toBe('')
      const at = h.clock.now()
      await h.accept(`latency ${n}`)
      h.engine.wake('alpha')
      await drainTimers(h)
      typing.push(h.textCalls()[n]!.at - at)
      confirmation.push(h.clock.now() - at)
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!
    // PRD N2 / AC76: these are latency requirements, independent of retry
    // or receipt-wait constants that happen to have similar values.
    expect(p95(typing)).toBeLessThanOrEqual(2000)
    expect(p95(confirmation)).toBeLessThanOrEqual(10000)
    expect(h.events.filter(e => e.type.startsWith('launch-')).map(e => e.type)).toEqual(['launch-observed', 'launch-first-waiting'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(h.textCalls().map(c => c.params.text)).toEqual(Array.from({ length: 20 }, (_, i) => `latency ${i}`))
    for (const c of h.calls) expect(h.calls.filter(x => x.at > c.at - 10000 && x.at <= c.at).length).toBeLessThanOrEqual(DELIVERY_MAX_AD_CALLS_PER_S * 10)
    const calls = h.calls.length
    await h.clock.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(calls)
    expect(h.clock.pending()).toEqual([])
    expect(h.errors).toEqual([])
  })
  test.each(['launch', 'session', 'forget', 'server'] as const)('%s after an empty queue starts a new first-waiting settle window', async change => {
    const h = await harness()
    await h.accept('before'); h.engine.wake('alpha'); await drainTimers(h)
    const prior = h.events.filter(e => e.type === 'launch-first-waiting')[0]!
    await h.clock.advance(50)
    if (change === 'launch') h.lifecycle.beforeLaunch('alpha')
    else if (change === 'session') {
      h.p().row.session_id = 'replacement-session'
      h.p().path = `${h.root}/replacement-session.jsonl`
      h.p().row.jsonl_path = h.p().path
      writeTranscript(h.p().path, endedTurn())
    }
    else if (change === 'forget') await h.engine.forget('alpha')
    else await h.restartServer()
    await h.accept('after'); await h.tick()
    const waiting = h.events.filter(e => e.type === 'launch-first-waiting').at(-1)!
    expect(h.events.filter(e => e.type === 'launch-observed')).toHaveLength(2)
    expect(h.events.filter(e => e.type === 'launch-first-waiting')).toHaveLength(2)
    expect(waiting.at).toBe(h.clock.now())
    expect(waiting.at).toBeGreaterThan(prior.at)
    await h.clock.advance(LAUNCH_SETTLE_MS - 1)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before'])
    await drainTimers(h)
    expect(h.textCalls()[1]!.at).toBeGreaterThanOrEqual(waiting.at + LAUNCH_SETTLE_MS)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before', 'after'])
    expect(h.errors).toEqual([])
  })
  test('a working row after queue retirement keeps its real first-waiting evidence without inventing another', async () => {
    const h = await harness()
    await h.accept('before'); h.engine.wake('alpha'); await drainTimers(h)
    const launchEvents = h.events.filter(e => e.type.startsWith('launch-'))
    await h.clock.advance(50)
    h.p().row.state = 'working'
    const at = h.clock.now()
    await h.accept('while working'); h.engine.wake('alpha')
    await h.advance(LAUNCH_SETTLE_MS * 2)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before'])
    h.p().row.state = 'waiting'
    await drainTimers(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before', 'while working'])
    expect(h.textCalls()[1]!.at - at).toBeGreaterThanOrEqual(LAUNCH_SETTLE_MS * 2)
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toEqual(launchEvents)
    expect(h.errors).toEqual([])
  })
  test('an intake wake during the text-to-Enter pause keeps delivery ownership until the separate Enter', async () => {
    const h = await harness(); await h.accept()
    let notifyText!: () => void
    const textTyped = new Promise<void>(resolve => { notifyText = resolve })
    h.p().keyHook = params => { if (params.no_enter) notifyText(); return undefined }
    await h.tick()
    // Use only the production timer here, without the harness's explicit laps.
    const advancing = h.clock.advance(LAUNCH_SETTLE_MS)
    await textTyped; await advancing; await h.clock.flush()
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    h.engine.wake('alpha') // Another accepted event can wake this same engine.
    await h.clock.advance(1)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    await h.advance(ENTER_DELAY_MS - 1)
    expect(h.keyCalls()[1]?.params.key).toBe('Enter')
    await delivered(h)
  })
  test('stuck persona holds its own head while another persona delivers', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('stuck'); await h.accept('later'); await h.accept('other', 'beta')
    h.p().row.state = 'working'
    await h.tick(); await h.tick('beta'); await delivered(h, 'beta')
    expect(h.textCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.textCalls('beta').map(c => c.params.text)).toEqual(['other'])
    h.p().row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['stuck', 'later'])
  })
  test('accepted sends never confirm without a transcript record', async () => {
    const h = await harness()
    await h.accept('first'); await h.accept('second')
    h.p().autoReceipt = false
    await start(h); await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS)
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.events.filter(e => e.type === 'delivered')).toEqual([])
    expect(h.textCalls().every(c => c.params.text === 'first')).toBe(true)
    h.p().autoReceipt = true
    await delivered(h)
    expect(h.textCalls().at(-1)?.params.text).toBe('second')
  })

})

describe('fresh send guards', () => {

  test.each(['working', 'relay', 'pending', 'check_permission', 'ask_user', 'latched', 'held', 'down', 'mcp', 'marker'] as const)('%s blocks and then releases the head', async guard => {
    const h = await harness(), p = h.p()
    await h.accept()
    if (guard === 'working') p.row.state = 'working'
    else if (guard === 'relay') p.row.relay_mode = 'off'
    else if (['pending', 'check_permission', 'ask_user'].includes(guard)) p.row.state = guard as typeof p.row.state
    else if (guard === 'latched') p.latched = true
    else if (guard === 'held') p.held = true
    else if (guard === 'down') p.up = false
    else if (guard === 'mcp') p.connected = false
    else p.row.labels.tag_prompt = '0'
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    if (guard === 'marker') expect(h.events.some(e => e.type === 'marker-missing')).toBe(true)
    p.pane = undefined; p.box = ''; p.row.relay_mode = 'on'; p.row.state = 'waiting'; p.latched = false; p.held = false; p.up = true; p.connected = true; p.row.labels.tag_prompt = '1'
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
  })

  test('a reconnect gate owner blocks delivery without blocking a sibling persona', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('alpha text'); await h.accept('beta text', 'beta')
    const release = h.lifecycle.acquire('alpha', 'reconnect')!
    await h.tick(); await h.tick('beta'); await delivered(h, 'beta')
    expect(h.keyCalls()).toEqual([])
    release()
    const reconnectRelease = h.lifecycle.acquire('alpha', 'reconnect')!
    await h.advance(RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toEqual([])
    reconnectRelease(); await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['alpha text'])
  })
  test('a key outside the applied set cannot start delivery while its applied sibling continues', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('retired'); await h.accept('live', 'beta')
    h.p().applied = false
    h.engine.wake('alpha'); h.engine.wake('not-configured')
    await h.tick(); await h.tick('not-configured'); await h.tick('beta')
    await delivered(h, 'beta')
    expect(h.keyCalls()).toEqual([])
    expect(h.calls.filter(c => c.key === 'alpha' || c.key === 'not-configured')).toEqual([])
    expect(h.restarts).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    h.p().applied = true; h.engine.wake('alpha')
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['retired'])
  })

})

describe('Enter and at-least-once recovery', () => {

  test.each(['text-typed', 'text-untyped', 'enter'] as const)('unknown %s outcome is checked before another text', async fault => {
    const h = await harness(); await h.accept(); const p = h.p(); let failed = false
    p.keyHook = params => {
      if (!failed && ((fault === 'enter') === (params.key === 'Enter'))) {
        failed = true
        if (fault === 'text-typed') p.box = params.text!
        return errTmuxUnresponsive('send-keys')
      }
      return undefined
    }
    await start(h); await delivered(h)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.textCalls()).toHaveLength(fault === 'text-untyped' ? 2 : 1)
  })
  test.each(['server-between-text-and-Enter', 'server-after-Enter', 'session', 'compaction'] as const)('%s checks existing receipts before retyping', async change => {
    const h = await harness(); await h.accept(); await start(h)
    const p = h.p()
    if (change !== 'server-between-text-and-Enter') await h.advance(ENTER_DELAY_MS)
    if (change.startsWith('server-')) await h.restartServer()
    else if (change === 'session') p.row.session_id = 'resumed-session'
    else appendTranscript(p.path, [{ type: 'system', subtype: 'compact_boundary' }])
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
  })
  test('a server crash after durable sent but before the first key recovers the unknown attempt and retypes its head', async () => {
    const h = await harness(); await h.accept('first'); await h.accept('second')
    await h.queue.append('alpha', { v: 1, kind: 'sent', seq: 1, part: 1, attempt: 1, send_kind: 'text', at: h.clock.now(), launch_id: h.lifecycle.launchId('alpha'), session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size })
    expect(h.keyCalls()).toEqual([])
    await h.restartServer()
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['first', 'second'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter', 'retype', 'text'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('retypes follow every growing backoff, stay at the last slot and reset after a bot launch', async () => {
    const h = await harness(); await h.accept(); const p = h.p(); p.autoReceipt = false
    await start(h)
    // Unrelated replies never supply a user receipt.
    const original = p.keyHook
    p.keyHook = params => { if (params.key === 'Enter') appendTranscript(p.path, [replyEntry()]); return undefined }
    await h.until(() => h.textCalls().length >= RETYPE_BACKOFF_MS.length + 3, 3 * (RETYPE_BACKOFF_MS.reduce((n, t) => n + t, 0) + RETYPE_BACKOFF_MS.at(-1)! * 3))
    const texts = h.textCalls()
    for (let n = 1; n < texts.length; n++) {
      expect(texts[n]!.at - (texts[n - 1]!.at + ENTER_DELAY_MS)).toBeGreaterThanOrEqual(RETYPE_BACKOFF_MS[Math.min(n - 1, RETYPE_BACKOFF_MS.length - 1)]!)
    }
    expect(h.events.filter(e => e.type === 'first-unconfirmed-retype')).toHaveLength(1)
    await h.advance(ENTER_DELAY_MS)
    expect(h.events.filter(e => e.type === 'retyped')).toHaveLength(texts.length - 1)
    h.lifecycle.beforeLaunch('alpha'); p.autoReceipt = true; p.keyHook = original
    await delivered(h)
    expect(h.textCalls().at(-1)!.at - texts.at(-1)!.at).toBeLessThan(RETYPE_BACKOFF_MS.at(-1)!)
  }, 30000)
})

describe('per-keystroke refusal and storage recovery', () => {
  const refusals = [
    ['invalid flags', () => errInvalidFlags('send-keys')], ['not found', errSpawnNotFound],
    ['pending', () => errSpawnNotInteractive('send-keys')], ['relayed', errSendKeysWhileRelayed],
    ['fallback', errRelayFallenBack], ['dialog', errDialogMaybeOpen], ['pane changed', errPaneChanged],
    ['conflict', () => errTmuxSessionConflict('send-keys', 'not-this-launch')], ['unusable', errUnusableName], ['environment', () => errTmuxNotAvailable(undefined, 'send-keys')],
    ['config', errConfigMalformed], ['binary gone', errSystemInstallDisappeared], ['pane gone', errTmuxSendKeys],
  ] as const
  test.each(refusals)('%s text refusal is durably recorded and never delivered from send success', async (_label, error) => {
    const h = await harness(); await h.accept(); let refused = false
    h.p().keyHook = params => { if (params.no_enter && !refused) { refused = true; return error() }; return undefined }
    await start(h)
    expect(h.records().filter(r => r.kind === 'refused')).toHaveLength(1)
    expect(h.queue.openCount('alpha')).toBe(1)
    if (h.restarts.length) h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
    expect(deliveryTextWasRefused(error())).toBe(true)
  })
  test.each(refusals)('%s at Enter preserves the accepted text as an unknown outcome and checks it before retyping', async (_label, error) => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => { if (params.key === 'Enter' && !failed) { failed = true; return error() }; return undefined }
    await start(h); await h.advance(ENTER_DELAY_MS)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.p().box).toBe('message')
    if (h.restarts.length) h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.keyCalls().map(c => c.params.key ?? 'text')).toEqual(['text', 'Enter', 'Enter'])
  })
  test('SpawnNotInteractive re-reads pending as a launch in progress, without scheduling a restart', async () => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => {
      if (params.no_enter && !failed) { failed = true; h.p().row.state = 'pending'; return errSpawnNotInteractive('send-keys') }
      return undefined
    }
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toEqual([])
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.records().filter(r => r.kind === 'refused')).toHaveLength(1)
    h.p().row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
  })
  test.each(['waiting', 'working'] as const)('a denied subagent request on %s reports the appropriate hold reason without giving up', async state => {
    const h = await harness(); await h.accept()
    h.p().row.unproven_requests = [cannedPermissionRequest({ decision: 'deny' })]
    h.p().keyHook = params => {
      if (params.no_enter) { h.p().row.state = state; return errDialogMaybeOpen() }
      return undefined
    }
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.events.some(e => e.type === 'waiting' && e.reason === 'dialog-hold')).toBe(state === 'waiting')
    expect(h.queue.openCount('alpha')).toBe(1)
    h.p().keyHook = undefined; h.p().row.state = 'waiting'; h.p().row.unproven_requests = []
    await delivered(h)
  })
  test.each([['timeout', () => errCallTimeout('send-keys')], ['unclassified', errInternal]] as const)('%s has an unknown outcome, never a refused text', async (_label, error) => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; h.p().box = params.text!; return error() }; return undefined }
    await start(h); await delivered(h)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.textCalls()).toHaveLength(1)
  })
  test('GONE schedules at most one restart under each launch id', async () => {
    const h = await harness(); await h.accept(); h.p().row.state = 'ended'
    await h.tick(); await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toEqual([{ key: 'alpha', cwd: h.root }])
    h.p().row.state = 'pending'; await h.advance(LAUNCH_SETTLE_MS); h.p().row.state = 'ended'; await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toHaveLength(2)
  })
  test.each([false, true])('a GONE text result bars all keys in that launch, restart already pending=%s', async pending => {
    const h = await harness(); await h.accept()
    h.p().restartPending = pending
    let failed = false
    h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; return errTmuxSendKeys() }; return undefined }
    await start(h)
    expect(h.restarts).toEqual(pending ? [] : [{ key: 'alpha', cwd: h.root }])
    const launch = h.lifecycle.launchId('alpha')
    await h.advance(NOT_NOW_RETRY_MS.at(-1)! + RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.lifecycle.launchId('alpha')).toBe(launch)
    expect(h.queue.openCount('alpha')).toBe(1)
    h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
    expect(h.restarts).toHaveLength(pending ? 0 : 1)
  })
  test.each([false, true])('retype spacing resets for new items and spans same-item parts, multipart=%s', async multipart => {
    const h = await harness(); await h.accept('first', 'alpha', multipart ? ['first', 'second'] : ['first'])
    if (!multipart) await h.accept('second')
    h.p().autoReceipt = false
    h.p().keyHook = params => { if (params.key === 'Enter') appendTranscript(h.p().path, [replyEntry()]); return undefined }
    await start(h)
    await h.until(() => h.textCalls().filter(c => c.params.text === 'first').length === 3)
    await h.advance(ENTER_DELAY_MS)
    appendTranscript(h.p().path, [promptEntry('first')])
    await h.until(() => h.textCalls().filter(c => c.params.text === 'second').length === 2)
    const second = h.textCalls().filter(c => c.params.text === 'second')
    expect(second[1]!.at - second[0]!.at).toBe(ENTER_DELAY_MS + 2 * Math.max(RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS[multipart ? 2 : 0]))
    h.p().autoReceipt = true
    await delivered(h)
  })
  test.each(['sent', 'delivered', 'refused'] as const)('failed %s append releases the gate, retries durably, and prevents overtaking', async kind => {
    const h = await harness(); await h.accept('first'); await h.accept('second'); h.failAppend(kind)
    if (kind === 'refused') { let failed = false; h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; return errDialogMaybeOpen() }; return undefined } }
    await start(h); await h.advance(ENTER_DELAY_MS + 1000)
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.textCalls().every(c => c.params.text === 'first')).toBe(true)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    await delivered(h)
    expect(h.textCalls().at(-1)?.params.text).toBe('second')
  })
  test('NOT_NOW backoff grows through every slot and resets on accepted text', async () => {
    const h = await harness(); await h.accept(); let remaining = NOT_NOW_RETRY_MS.length + 2
    h.p().keyHook = params => params.no_enter && remaining-- > 0 ? errPaneChanged() : undefined
    await start(h); await delivered(h)
    const texts = h.textCalls()
    for (let n = 1; n < texts.length; n++) expect(texts[n]!.at - texts[n - 1]!.at).toBeGreaterThanOrEqual(NOT_NOW_RETRY_MS[Math.min(n - 1, NOT_NOW_RETRY_MS.length - 1)]!)
  })
})

describe('rolling load bound and lifecycle', () => {
  test.each(['forget', 'stop'] as const)('%s between text and Enter cancels further keys and retains the undelivered queue', async action => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('alpha text'); await h.accept('beta text', 'beta')
    await start(h)
    expect(h.keyCalls()).toHaveLength(1)
    if (action === 'forget') { h.p().applied = false; await h.engine.forget('alpha') }
    else await h.engine.stop()
    const calls = h.calls.filter(c => c.key === 'alpha').length
    await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.calls.filter(c => c.key === 'alpha')).toHaveLength(calls)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.events.filter(e => e.type === 'delivered' && e.key === 'alpha')).toEqual([])
    if (action === 'forget') { await h.tick('beta'); await delivered(h, 'beta'); expect(h.textCalls('beta').map(c => c.params.text)).toEqual(['beta text']) }
    else expect(h.keyCalls('beta')).toEqual([])
  })
  test('call budget includes its exact sliding-window boundary', () => {
    let now = 0
    const budget = createDeliveryCallBudget(() => now)
    for (let i = 0; i < DELIVERY_MAX_AD_CALLS_PER_S * 10; i++) budget()
    expect(budget).toThrow(DeliveryBudgetWait)
    now = 9999; expect(budget).toThrow(DeliveryBudgetWait)
    now = 10000; expect(budget).not.toThrow()
  })
  test('runtime never exceeds the per-persona call budget and empty queues make no calls', async () => {
    const h = await harness()
    h.engine.wake('alpha'); await h.tick(); await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toEqual([])
    for (let i = 0; i < 25; i++) await h.accept(`m${i}`)
    await start(h); await delivered(h)
    for (const c of h.calls) expect(h.calls.filter(x => x.at > c.at - 10000 && x.at <= c.at).length).toBeLessThanOrEqual(DELIVERY_MAX_AD_CALLS_PER_S * 10)
    expect(h.textCalls()).toHaveLength(25)
    const before = h.calls.length
    await h.engine.forget('alpha'); await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(before)
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// b.omv SR-8.6: events distinguish a confirmed part from durable item completion.
describe('operational delivery events', () => {
  test('failed final append emits neither part nor whole-item completion until the receipt is durable', async () => {
    const h = await harness()
    await h.accept('body')
    h.failAppend('delivered')
    await start(h)
    await h.until(() => h.errors.length > 0)
    expect(h.events.filter(e => e.type === 'item-delivered' || e.type === 'delivered')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    await delivered(h)
    expect(h.events.filter(e => e.type === 'item-delivered')).toEqual([{ type: 'item-delivered', key: 'alpha', seq: 1, at: expect.any(Number), waitMs: expect.any(Number) }])
    expect(h.events.filter(e => e.type === 'delivered')).toHaveLength(1)
    expect(h.textCalls()).toHaveLength(1)
  })
  test('first typing happens once across retries and later parts', async () => {
    const h = await harness()
    await h.accept('message', 'alpha', ['part one', 'part two'])
    h.p().row.state = 'working'
    await start(h)
    expect(h.events.filter(e => e.type === 'first-typed')).toEqual([])
    const status = h.engine.status('alpha')!
    expect(status).toMatchObject({ key: 'alpha', seq: 1, count: 1, row: 'working', marker: true, relay: true, connected: true, ageMs: expect.any(Number), retypeCount: 0 })
    expect(JSON.stringify(status)).not.toContain('message')
    expect(JSON.stringify(status)).not.toContain('operator text')
    h.p().row.state = 'waiting'; h.p().lostEnters = 1
    await delivered(h)
    expect(h.events.filter(e => e.type === 'first-typed')).toEqual([{ type: 'first-typed', key: 'alpha', seq: 1, part: 1 }])
    expect(h.events.filter(e => e.type === 'delivered').map(e => 'part' in e && e.part)).toEqual([1, 2])
    expect(h.events.filter(e => e.type === 'item-delivered')).toHaveLength(1)
    expect(h.keyCalls().filter(c => c.params.key === 'Enter')).toHaveLength(3)
  })
})

describe('AD authority regressions', () => {
  test.each(['claude', 'codex'] as const)('%s waiting permits delivery without reading arbitrary pane contents', async agent => {
    const h = await harness(), p = h.p()
    p.row.agent = agent
    p.pane = 'arbitrary private terminal content with no supported markers'
    p.paneError = new Error('pane must not be consulted for delivery')
    await h.accept('exact queued text')
    await start(h); await delivered(h)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['exact queued text', 'Enter'])
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(0)
  })

  test.each(['claude', 'codex'] as const)('%s working never types from transcript completion or elapsed idle deadlines', async agent => {
    const h = await harness(), p = h.p()
    p.row.agent = agent; p.row.state = 'working'
    writeTranscript(p.path, agent === 'claude' ? endedTurn() : [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ])
    await h.accept('waiting for AD')
    await start(h); await h.advance(240000)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
    p.row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['waiting for AD'])
  })

  test('Enter rechecks AD waiting after text and keeps the head queued while AD reports working', async () => {
    const h = await harness(), p = h.p()
    p.keyHook = params => { if (params.no_enter) p.row.state = 'working'; return undefined }
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0])
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['head'])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    p.keyHook = undefined; p.row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('a recovery Enter is durable before the key and an append failure keeps the FIFO head queued', async () => {
    const h = await harness(), p = h.p()
    p.lostEnters = 1
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.advance(ENTER_DELAY_MS)
    h.failAppend('sent')
    await h.until(() => h.errors.length > 0)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['head', 'Enter'])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(1)
    p.keyHook = params => {
      if (params.key === 'Enter' && h.textCalls().length === 1) {
        expect(h.records().filter(r => r.kind === 'sent').at(-1)).toMatchObject({ seq: 1, part: 1, send_kind: 'enter', attempt: 2 })
      }
      return undefined
    }
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
  })

  test('a restart after an uncertain recovery Enter retries the retained text with Enter before the successor', async () => {
    const h = await harness(), p = h.p()
    p.lostEnters = 1
    let enters = 0
    p.keyHook = params => params.key === 'Enter' && ++enters === 2 ? errTmuxUnresponsive('send-keys') : undefined
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.until(() => enters === 2)
    expect(h.records().filter(r => r.kind === 'sent').at(-1)).toMatchObject({ seq: 1, send_kind: 'enter', attempt: 2 })
    expect(h.queue.openCount('alpha')).toBe(2)
    p.keyHook = undefined
    await h.restartServer(); await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter', 'enter', 'text'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('non-receipt transcript records neither confirm delivery nor change the launch identity', async () => {
    const h = await harness(), p = h.p()
    p.autoReceipt = false
    await h.accept('exact head'); await start(h); await h.advance(ENTER_DELAY_MS)
    const launch = h.lifecycle.launchId('alpha')
    p.row.state = 'working'
    appendTranscript(p.path, [
      promptEntry('different message'), replyEntry(),
      queueOperationEntry('remove', 'exact head', 'delivered_to_agent'),
      { type: 'system', subtype: 'compact_boundary' },
    ])
    await h.advance(240000)
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(h.lifecycle.launchId('alpha')).toBe(launch)
    expect(h.textCalls()).toHaveLength(1)
    appendTranscript(p.path, [promptEntry('exact head')])
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.records().filter(r => r.kind === 'delivered')).toHaveLength(1)
  })
})
