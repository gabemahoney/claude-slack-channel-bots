/** The production executor at its per-persona call budget (N3): a key step
 * spends its fresh reads only when the budget also covers its key, and typed
 * text keeps its lease through a budget wait until its Enter. Every timestamp
 * is the injected fake clock's; disk steps settle before virtual time moves. */
import { afterEach, expect, test } from 'bun:test'
import type { SendKeysParams } from 'agent-director'
import { createDeliveryCallBudget, DELIVERY_MAX_AD_CALLS_PER_S, DeliveryBudgetWait, ENTER_DELAY_MS } from '../src/delivery-engine.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { durableIo } from './test-helpers/durable-io.ts'
import type { FakeClock } from './test-helpers/fake-clock.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
async function harness(options: Parameters<typeof makeEngineHarness>[0] = {}) { const h = await makeEngineHarness(options); harnesses.push(h); return h }

const WINDOW_MS = 10000, LIMIT = DELIVERY_MAX_AD_CALLS_PER_S * 10

/** The most calls any 10-second window ending at a call holds. */
function busiestWindow(h: EngineHarness): number {
  const calls = h.calls.filter(c => c.key === 'alpha')
  return Math.max(0, ...calls.map(c => calls.filter(x => x.at > c.at - WINDOW_MS && x.at <= c.at).length))
}
/** Each typed text with its Enter and the AD reads made between them. */
function textToEnter(h: EngineHarness) {
  const calls = h.calls.filter(c => c.key === 'alpha')
  return calls.flatMap((call, at) => {
    const params = call.params as SendKeysParams
    if (call.verb !== 'send-keys' || !params.no_enter) return []
    const next = calls.findIndex((c, i) => i > at && c.verb === 'send-keys')
    const enter = next < 0 ? undefined : calls[next]!
    return [{ text: params.text, typedAt: call.at, enter: (enter?.params as SendKeysParams | undefined)?.key, enterAt: enter?.at, reads: calls.slice(at + 1, next < 0 ? undefined : next).filter(c => c.verb === 'get').length }]
  })
}

test('cover waits for a whole step in age order and records nothing', () => {
  let now = 0
  const budget = createDeliveryCallBudget(() => now)
  for (let n = 0; n < LIMIT - 2; n++) { now = n * 100; budget() }
  expect(() => budget.cover(2)).not.toThrow()
  const waitFor = (calls: number) => { try { budget.cover(calls) } catch (error) { if (error instanceof DeliveryBudgetWait) return error.delayMs; throw error } }
  // Three calls need the oldest (t=0) gone, four the next oldest (t=100).
  expect(waitFor(3)).toBe(WINDOW_MS - now)
  expect(waitFor(4)).toBe(100 + WINDOW_MS - now)
  budget(); budget()
  expect(budget).toThrow(DeliveryBudgetWait)
  now = WINDOW_MS
  expect(waitFor(1)).toBeUndefined()
  expect(waitFor(2)).toBe(100)
})

test('back-to-back receipts at the call budget deliver every item; each Enter costs only its revalidation read', async () => {
  // The first send's durable append separates its gate read from its key.
  // A step retried after a release has no append, so it needs reads and key
  // in a shorter span than the calls leaving a full window: each leaves alone.
  const FSYNC_MS = 3, WAKE_MS = 300, ITEMS = 16, DEADLINE_MS = 120000
  let disk: FakeClock | undefined
  const io = durableIo({ before: () => disk ? new Promise<void>(resolve => { disk!.setTimeout(resolve, FSYNC_MS) }) : undefined })
  const h = await harness({ queueFs: io.fs })
  for (let n = 0; n < ITEMS; n++) await h.accept(`burst ${n}`)
  // Each receipt is released at once, and the next message wakes the engine.
  h.p().keyHook = params => { if (params.key === 'Enter') h.clock.setTimeout(() => h.engine.wake('alpha'), WAKE_MS); return undefined }
  disk = h.clock
  const start = h.clock.now()
  h.engine.wake('alpha')
  const leases: { phase?: string; owner: string }[] = []
  while (h.queue.openCount('alpha') > 0 && h.clock.now() < start + DEADLINE_MS && await h.clock.runNext() > 0) {
    leases.push({ phase: h.engine.snapshot('alpha')?.e.phase, owner: h.lifecycle.owner('alpha') })
  }
  const elapsed = h.clock.now() - start, open = h.queue.openCount('alpha')
  disk = undefined
  await h.clock.advance(FSYNC_MS) // let a held disk step finish before cleanup
  expect(busiestWindow(h)).toBe(LIMIT)
  expect(open).toBe(0)
  // No slower than six calls per delivery at the budget's own rate.
  expect(elapsed).toBeLessThanOrEqual(ITEMS * 6 * 1000 / DELIVERY_MAX_AD_CALLS_PER_S)
  const steps = textToEnter(h)
  expect(steps.map(s => s.text)).toEqual(Array.from({ length: ITEMS }, (_, n) => `burst ${n}`))
  for (const step of steps) expect(step).toMatchObject({ enter: 'Enter', reads: 1 })
  expect(leases.filter(l => l.phase === 'enter').every(l => l.owner === 'delivery')).toBe(true)
  expect(h.events.filter(e => e.type === 'item-delivered').map(e => e.seq)).toEqual(Array.from({ length: ITEMS }, (_, n) => n + 1))
  expect(h.errors).toEqual([])
})

test('typed text keeps its lease through a budget wait until its Enter', async () => {
  const h = await harness()
  for (let n = 0; n < 12; n++) await h.accept(`queued ${n}`)
  const samples: { at: number; phase?: string; owner: string; reconnect: boolean }[] = []
  h.engine.wake('alpha')
  for (let turns = 0; h.queue.openCount('alpha') > 0 && turns < 1000; turns++) {
    await h.advance(100)
    // A reconnect may type only while delivery holds no lease.
    const reconnect = h.lifecycle.acquire('alpha', 'reconnect')
    reconnect?.()
    samples.push({ at: h.clock.now(), phase: h.engine.snapshot('alpha')?.e.phase, owner: h.lifecycle.owner('alpha'), reconnect: !!reconnect })
  }
  expect(h.queue.openCount('alpha')).toBe(0)
  expect(busiestWindow(h)).toBe(LIMIT)
  const steps = textToEnter(h)
  const waited = steps.filter(s => s.enterAt! > s.typedAt + ENTER_DELAY_MS)
  expect(waited.length).toBeGreaterThan(0)
  for (const step of waited) {
    const pause = samples.filter(s => s.at > step.typedAt && s.at < step.enterAt!)
    expect(pause.length).toBeGreaterThan(0)
    expect(pause.every(s => s.phase === 'enter' && s.owner === 'delivery' && !s.reconnect)).toBe(true)
  }
  for (const step of steps) expect(step).toMatchObject({ enter: 'Enter', reads: 1 })
  expect(h.errors).toEqual([])
})
