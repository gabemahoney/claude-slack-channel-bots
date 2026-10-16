/** b.omv SR-5/6: production executor over a durable queue and real adapters.
 * Parser permutations live in delivery-screen/receipt, gate lifecycle in its
 * own suite. Every timestamp and retry is driven by the injected fake clock. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createDeliveryCallBudget, DeliveryBudgetWait, deliveryTextWasRefused, LAUNCH_SETTLE_MS, ENTER_DELAY_MS, ENTER_ONLY_RETRY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS, NOT_NOW_RETRY_MS, IDLE_EVIDENCE_MAX_WAIT_MS, DELIVERY_MAX_AD_CALLS_PER_S, RECONNECT_BLOCKED_NOTICE_MS } from '../src/delivery-engine.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { appendTranscript, codexPromptEntry, deliveryPane, promptEntry, queueOperationEntry, replyEntry, writeTranscript } from './test-helpers/working-row-panes.ts'
import { cannedPermissionRequest, errCallTimeout, errConfigMalformed, errDialogMaybeOpen, errInternal, errInvalidFlags, errPaneChanged, errRelayFallenBack, errSendKeysWhileRelayed, errSpawnNotFound, errSpawnNotInteractive, errSystemInstallDisappeared, errTmuxNotAvailable, errTmuxSendKeys, errTmuxSessionConflict, errTmuxUnresponsive, errUnusableName } from './test-helpers/agent-director-stub.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
async function harness(options: Parameters<typeof makeEngineHarness>[0] = {}) { const h = await makeEngineHarness(options); harnesses.push(h); return h }
async function start(h: EngineHarness, key = 'alpha') { await h.tick(key); await h.advance(LAUNCH_SETTLE_MS) }
async function delivered(h: EngineHarness, key = 'alpha') { await h.until(() => h.queue.openCount(key) === 0) }

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
      : ['first', 'Enter', 'first', 'Enter', 'second', 'Enter'])
    const records = h.records()
    expect(records.filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(fault === 'lost-enter' ? ['text', 'enter', 'text'] : ['text', 'retype', 'text'])
    expect(records.filter(r => r.kind === 'sent' || r.kind === 'delivered').map(r => [r.kind, r.seq])).toEqual([
      ['sent', 1], ['sent', 1], ['delivered', 1], ['sent', 2], ['delivered', 2],
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
    h.p().pane = deliveryPane('human draft')
    await h.tick(); await h.tick('beta'); await delivered(h, 'beta')
    expect(h.textCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.textCalls('beta').map(c => c.params.text)).toEqual(['other'])
    h.p().pane = undefined
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
  test('a confirmed leftover is submitted with Enter before another FIFO item can type', async () => {
    const h = await harness(); await h.accept('first'); await h.accept('second')
    let enters = 0
    h.p().keyHook = params => { if (params.key === 'Enter') h.p().retainBox = ++enters === 1; return undefined }
    await start(h); await delivered(h)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['first', 'Enter', 'Enter', 'second', 'Enter'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(2)
  })
})

describe('fresh send guards', () => {
  test.each(['menu', 'input', 'relay', 'pending', 'check_permission', 'ask_user', 'latched', 'held', 'down', 'mcp', 'marker'] as const)('%s blocks and then releases the head', async guard => {
    const h = await harness(), p = h.p()
    await h.accept()
    if (guard === 'menu') p.pane = 'Enter to select'
    else if (guard === 'input') p.box = 'human draft'
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
  test('gate obtains an independent fresh read before typing, even when the prior screen was empty', async () => {
    const h = await harness(), p = h.p()
    await h.accept(); await h.tick()
    p.readHook = () => { if (h.clock.now() >= LAUNCH_SETTLE_MS && p.reads >= 3) p.box = 'a new human draft' }
    await h.advance(LAUNCH_SETTLE_MS + RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toEqual([])
    p.readHook = undefined; p.box = ''
    await delivered(h)
  })
  test('a startup or reconnect gate owner blocks delivery without blocking a sibling persona', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('alpha text'); await h.accept('beta text', 'beta')
    const release = h.lifecycle.acquire('alpha', 'startup')!
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
  test('a first send may reach a working row, but a retype cannot', async () => {
    const h = await harness(), p = h.p()
    await h.accept(); await h.tick(); await h.advance(LAUNCH_SETTLE_MS - 1)
    p.row.state = 'working'; p.running = true; p.autoReceipt = false
    await h.advance(1 + ENTER_DELAY_MS + IDLE_EVIDENCE_MAX_WAIT_MS)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.queue.openCount('alpha')).toBe(1)
    p.row.state = 'waiting'; p.running = false; p.autoReceipt = true
    await delivered(h)
  })
})

describe('deferred reconnect latch guard', () => {
  // b.omv SR-5.5 and b.jg5 SRJ-502: the no-engine timer must leave all
  // agent-director calls to the latch re-check until the latch clears.
  test.each(['before-client', 'during-client'] as const)('a latch set %s pauses reconnect and its screen clock, then the timer retries after clear', async when => {
    let h!: EngineHarness, releaseClient!: () => void
    const clientReady = new Promise<void>(resolve => { releaseClient = resolve })
    const clients: string[] = []
    h = await harness({ keys: ['alpha', 'beta'], clientFor: async key => {
      clients.push(key)
      if (key === 'alpha' && when === 'during-client' && clients.filter(k => k === 'alpha').length === 1) await clientReady
      return h.client(key)
    } })
    const p = h.p()
    p.connected = false
    p.latched = when === 'before-client'
    h.lifecycle.defer('alpha', 'menu')
    try {
      expect(h.engine.running('alpha')).toBe(false)
      await h.clock.advance(NOT_NOW_RETRY_MS[0] - 1)
      expect(clients).toEqual([])
      expect(h.calls).toEqual([])
      await h.clock.advance(1)
      if (when === 'during-client') {
        expect(clients).toEqual(['alpha'])
        p.latched = true
        releaseClient()
        await h.clock.flush()
      }
      const blockedMs = NOT_NOW_RETRY_MS[0]
      expect(h.lifecycle.deferred('alpha')).toEqual({ due: false, screen: undefined, blockedMs })
      await h.clock.advance(RECONNECT_BLOCKED_NOTICE_MS)
      expect(h.calls).toEqual([])
      expect(clients).toEqual(when === 'before-client' ? [] : ['alpha'])
      expect(h.lifecycle.deferred('alpha')).toEqual({ due: false, screen: undefined, blockedMs })

      await h.accept('healthy sibling', 'beta')
      await h.tick('beta'); await delivered(h, 'beta'); await h.tick('beta')
      expect(h.textCalls('beta').map(call => call.params.text)).toEqual(['healthy sibling'])
      expect(h.calls.filter(call => call.key === 'alpha')).toEqual([])
      expect(h.lifecycle.deferred('alpha')?.blockedMs).toBe(blockedMs)

      // Clearing the latch supplies no wake or manual retry: only the
      // already-armed production timer may resume this empty-queue persona.
      p.latched = false
      expect(h.clock.pending()).toHaveLength(1)
      const retryAt = h.clock.pending()[0]!.dueAt
      await h.clock.advanceTo(retryAt - 1)
      expect(h.calls.filter(call => call.key === 'alpha')).toEqual([])
      await h.clock.advance(1)
      expect(h.calls.filter(call => call.key === 'alpha')).toEqual([{ key: 'alpha', verb: 'reconnect', at: retryAt, params: {} }])
      expect(clients.filter(key => key === 'alpha')).toHaveLength(when === 'before-client' ? 1 : 2)
      expect(h.errors).toEqual([])
      p.connected = true
      await h.clock.advance(NOT_NOW_RETRY_MS[0])
      expect(h.lifecycle.deferred('alpha')).toBeUndefined()
      expect(h.calls.filter(call => call.key === 'alpha')).toHaveLength(1)
      expect(h.clock.pending()).toEqual([])
    } finally { releaseClient() }
  })
})

describe('Enter and at-least-once recovery', () => {
  test('lost Enter uses fresh own-text evidence and Enter alone', async () => {
    const h = await harness(); await h.accept(); h.p().lostEnters = 1
    await start(h); await h.advance(ENTER_DELAY_MS)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    await h.advance(RECEIPT_WAIT_MS - 1)
    expect(h.keyCalls()).toHaveLength(2)
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.keyCalls().map(c => c.params.key ?? 'text')).toEqual(['text', 'Enter', 'Enter'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter'])
  })
  test('pull-back prohibits Enter and retypes only after the composer clears', async () => {
    const h = await harness(); await h.accept(); const p = h.p(); p.lostEnters = 1
    await start(h); await h.advance(ENTER_DELAY_MS)
    appendTranscript(p.path, [queueOperationEntry('popOne', 'message'), replyEntry()])
    await h.advance(RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0])
    expect(h.keyCalls()).toHaveLength(2)
    p.box = ''
    await delivered(h)
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'retype'])
    expect(h.keyCalls().map(c => c.params.key ?? 'text')).toEqual(['text', 'Enter', 'text', 'Enter'])
    expect(h.keyCalls().at(-1)!.at - h.textCalls().at(-1)!.at).toBe(ENTER_DELAY_MS)
  })
  test('Enter retries are bounded, spaced and reset when the box changes', async () => {
    const h = await harness(); await h.accept(); h.p().lostEnters = 100
    await start(h); await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS + ENTER_ONLY_RETRY_MS * 5)
    expect(h.keyCalls().filter(c => c.params.key === 'Enter')).toHaveLength(4)
    expect(h.textCalls()).toHaveLength(1)
    const retries = h.records().filter((r): r is import('../src/delivery-queue.ts').SentRecord => r.kind === 'sent' && 'send_kind' in r && r.send_kind === 'enter')
    expect(retries).toHaveLength(3)
    for (let i = 1; i < retries.length; i++) expect(retries[i]!.at! - retries[i - 1]!.at!).toBeGreaterThanOrEqual(ENTER_ONLY_RETRY_MS)
    h.p().box = 'human'; await h.advance(RECEIPT_WAIT_MS); h.p().box = 'message'; h.p().lostEnters = 0
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
  })
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
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'retype', 'text'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })
  test('disconnected startup recovery submits existing own text before reconnect', async () => {
    const h = await harness(); await h.accept(); await start(h); h.p().connected = false
    await h.restartServer()
    h.lifecycle.defer('alpha', 'input')
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.keyCalls().at(-1)?.params.key).toBe('Enter')
    expect(h.calls.filter(c => c.verb === 'reconnect')).toEqual([])
  })
  test('unreadable and not-yet-written transcripts keep the item open and retry indefinitely', async () => {
    const h = await harness(); await h.accept(); const p = h.p(); p.autoReceipt = false
    // A recorded present path that disappeared is unreadable.
    unlinkSync(p.path)
    await start(h); await h.advance(ENTER_DELAY_MS + IDLE_EVIDENCE_MAX_WAIT_MS * 2)
    expect(h.textCalls().length).toBeGreaterThan(1)
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.events.some(e => e.type === 'waiting' && e.reason === 'transcript-unreadable')).toBe(true)
    p.row.transcript_status = 'never_written'
    await h.advance(RECEIPT_WAIT_MS)
    writeTranscript(p.path, [promptEntry('message')])
    await delivered(h)
  })
  test('receipt wait owns the gate, then idle-evidence waiting frees it until the exact cap permits a retype', async () => {
    const h = await harness(); await h.accept(); h.p().autoReceipt = false
    h.p().keyHook = params => { if (params.key === 'Enter') appendTranscript(h.p().path, [promptEntry('unrelated unfinished turn')]); return undefined }
    await start(h); await h.advance(ENTER_DELAY_MS)
    const submittedAt = h.clock.now()
    await h.advance(RECEIPT_WAIT_MS - 1)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    expect(h.lifecycle.acquire('alpha', 'reconnect')).toBeUndefined()
    await h.advance(1)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    const reconnectRelease = h.lifecycle.acquire('alpha', 'reconnect')!
    expect(reconnectRelease).toBeDefined(); reconnectRelease()
    await h.advance(IDLE_EVIDENCE_MAX_WAIT_MS - (h.clock.now() - submittedAt) - 1)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    await h.advance(1)
    expect(h.textCalls()).toHaveLength(2)
    h.p().autoReceipt = true; h.p().keyHook = undefined
    await delivered(h)
  })
  test('retypes follow every growing backoff, stay at the last slot and reset after a bot launch', async () => {
    const h = await harness(); await h.accept(); const p = h.p(); p.autoReceipt = false
    await start(h)
    // Keep positive idle evidence fresh after every submit, without a user receipt.
    const original = p.keyHook
    p.keyHook = params => { if (params.key === 'Enter') appendTranscript(p.path, [replyEntry()]); return undefined }
    await h.until(() => h.textCalls().length >= RETYPE_BACKOFF_MS.length + 3, RETYPE_BACKOFF_MS.reduce((n, t) => n + t, 0) + RETYPE_BACKOFF_MS.at(-1)! * 3)
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
    expect(second[1]!.at - second[0]!.at).toBe(ENTER_DELAY_MS + Math.max(RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS[multipart ? 2 : 0]))
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
