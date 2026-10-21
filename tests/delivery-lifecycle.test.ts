/** Shared typing ownership and the no-engine reconnect driver (b.omv SR-5.5/6.6). */
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryAdScope } from '../src/delivery-ad-scope.ts'
import { createDeliveryLifecycle, NOT_NOW_RETRY_MS, type DeliveryLifecycle, type TypingOwner } from '../src/delivery-lifecycle.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

const lives: DeliveryLifecycle[] = []
const unblocks: (() => void)[] = []
afterEach(async () => {
  for (const unblock of unblocks.splice(0)) unblock()
  for (const life of lives.splice(0)) await life.stop()
})
function harness() {
  const clock = createFakeClock(), calls: { key: string; at: number }[] = []
  const life = createDeliveryLifecycle({ clock })
  lives.push(life)
  life.setReconnect(async key => { calls.push({ key, at: clock.now() }) })
  return { clock, life, calls }
}

describe('AD relaunch observations and typing leases', () => {
  test.each(['pending', 'ended', 'missing'])('entry into %s resets readiness and reports relaunch once, per persona', state => {
    const { life } = harness()
    const events: unknown[] = []
    life.setRelaunchObserver((key, row) => events.push({ key, row }))
    life.observeRow('alpha', { state: 'waiting', session_id: 'same-session' })
    life.observeRow('beta', { state: 'waiting', session_id: 'sibling' })
    expect(life.hasWaited('alpha')).toBe(true)
    const oldLease = life.acquire('alpha', 'delivery')!
    const siblingLease = life.acquire('beta', 'delivery')!
    const row = { state, session_id: 'same-session' }
    life.observeRow('alpha', row)
    life.observeRow('alpha', row)
    expect(events).toEqual([{ key: 'alpha', row }])
    expect(life.hasWaited('alpha')).toBe(false)
    expect(life.hasWaited('beta')).toBe(true)
    expect(life.owner('alpha')).toBe('free')
    expect(life.owner('beta')).toBe('delivery')
    const replacementLease = life.acquire('alpha', 'reconnect')!
    oldLease()
    expect(life.owner('alpha')).toBe('reconnect')
    replacementLease(); siblingLease()
    life.observeRow('alpha', { state: 'waiting', session_id: 'same-session' })
    expect(life.hasWaited('alpha')).toBe(true)
  })
  test('session_id change reports relaunch; working cannot establish readiness; waiting establishes it immediately', () => {
    const { life } = harness()
    const events: unknown[] = []
    life.setRelaunchObserver((key, row) => events.push({ key, row }))
    life.observeRow('alpha', { state: 'working', session_id: 's1' })
    expect(life.hasWaited('alpha')).toBe(false)
    life.observeRow('alpha', { state: 'waiting', session_id: 's1' })
    expect(life.hasWaited('alpha')).toBe(true)
    life.observeRow('alpha', { state: 'working', session_id: 's1' })
    expect(events).toEqual([])
    const row = { state: 'working', session_id: 's2' }
    life.observeRow('alpha', row)
    expect(events).toEqual([{ key: 'alpha', row }])
    expect(life.hasWaited('alpha')).toBe(false)
    life.observeRow('alpha', { state: 'waiting', session_id: 's2' })
    expect(life.hasWaited('alpha')).toBe(true)
  })
  test('first waiting observer fires once for each AD readiness episode and keeps personas separate', () => {
    const { life } = harness()
    const events: Array<{ key: string; row: { state: string; session_id?: string } }> = []
    life.setFirstWaitingObserver((key, row) => events.push({ key, row }))
    const waiting = { state: 'waiting', session_id: 's1' }
    life.observeRow('alpha', { state: 'working', session_id: 's1' })
    expect(events).toEqual([])
    life.observeRow('alpha', waiting)
    life.observeRow('alpha', waiting)
    life.observeRow('alpha', { state: 'working', session_id: 's1' })
    life.observeRow('alpha', waiting)
    life.observeRow('beta', waiting)
    expect(events).toEqual([{ key: 'alpha', row: waiting }, { key: 'beta', row: waiting }])
    life.observeRow('alpha', { state: 'missing' })
    life.observeRow('alpha', { state: 'working', session_id: 's1' })
    expect(life.hasWaited('alpha')).toBe(false)
    life.observeRow('alpha', waiting)
    const replacement = { state: 'waiting', session_id: 's2' }
    life.observeRow('alpha', replacement)
    expect(events).toEqual([
      { key: 'alpha', row: waiting }, { key: 'beta', row: waiting },
      { key: 'alpha', row: waiting }, { key: 'alpha', row: replacement },
    ])
    expect(life.hasWaited('beta')).toBe(true)
  })
  test('activation supplies no fabricated relaunch evidence and preserves an in-flight lease', () => {
    const { life } = harness()
    const events: unknown[] = []
    life.setRelaunchObserver((key, row) => events.push({ key, row }))
    life.observeRow('alpha', { state: 'waiting', session_id: 's1' })
    const release = life.acquire('alpha', 'delivery')!
    life.activate('alpha')
    expect(events).toEqual([])
    expect(life.hasWaited('alpha')).toBe(true)
    expect(life.acquire('alpha', 'reconnect')).toBeUndefined()
    release()
    expect(life.owner('alpha')).toBe('free')
  })
  test.each(['delivery', 'reconnect'] as const)('%s holds one persona gate; stale releases cannot free a replacement lease', owner => {
    const { life } = harness()
    const release = life.acquire('alpha', owner)!
    expect(life.owner('alpha')).toBe(owner)
    for (const contender of ['delivery', 'reconnect'] as TypingOwner[]) expect(life.acquire('alpha', contender)).toBeUndefined()
    const sibling = life.acquire('beta', 'delivery')!
    expect(life.owner('beta')).toBe('delivery')
    life.forget('alpha')
    expect(life.acquire('alpha', owner)).toBeUndefined()
    life.activate('alpha')
    const replacement = life.acquire('alpha', 'reconnect')!
    release()
    expect(life.owner('alpha')).toBe('reconnect')
    replacement(); sibling()
    expect(life.owner('alpha')).toBe('free')
    expect(life.owner('beta')).toBe('free')
  })
})

describe('deferred reconnect ownership', () => {
  test('a no-engine deferral retries on its own clock with no health tick and deduplicates concurrent retry work', async () => {
    const { life, clock, calls } = harness()
    let finish!: () => void
    life.setReconnect(async key => { calls.push({ key, at: clock.now() }); await new Promise<void>(resolve => { finish = resolve; unblocks.push(resolve) }) })
    life.defer('alpha')
    await clock.advance(NOT_NOW_RETRY_MS[0] - 1)
    expect(calls).toEqual([])
    await clock.advance(1)
    expect(calls).toEqual([{ key: 'alpha', at: NOT_NOW_RETRY_MS[0] }])
    await clock.advance(NOT_NOW_RETRY_MS[0])
    const a = life.retryReconnect('alpha'), b = life.retryReconnect('alpha')
    await clock.flush()
    expect(calls).toHaveLength(1)
    life.clearDeferred('alpha'); finish()
    await Promise.all([a, b]); await clock.flush()
    expect(clock.pendingCount()).toBe(0)
  })
  test('a running engine takes over retries and hands a remaining deferral back when it stops', async () => {
    const { life, clock, calls } = harness()
    life.defer('alpha')
    expect(clock.pendingCount()).toBe(1)
    life.engineRunning('alpha', true)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(NOT_NOW_RETRY_MS[0])
    expect(calls).toEqual([])
    await life.retryReconnect('alpha')
    expect(calls).toEqual([{ key: 'alpha', at: NOT_NOW_RETRY_MS[0] }])
    life.engineRunning('alpha', false)
    await clock.advance(NOT_NOW_RETRY_MS[0] - 1)
    expect(calls).toHaveLength(1)
    await clock.advance(1)
    expect(calls).toHaveLength(2)
  })
  test.each(['typed-or-connected', 'ended', 'missing', 'teardown', 'shutdown'] as const)('%s cancels the deferred timer while preserving a sibling', async reason => {
    const { life, clock, calls } = harness()
    life.defer('alpha'); life.defer('beta')
    if (reason === 'typed-or-connected') life.clearDeferred('alpha')
    else if (reason === 'ended' || reason === 'missing') life.observeRow('alpha', { state: reason })
    else if (reason === 'teardown') life.forget('alpha')
    else await life.stop()
    await clock.advance(NOT_NOW_RETRY_MS[0])
    expect(calls.map(call => call.key)).toEqual(reason === 'shutdown' ? [] : ['beta'])
    if (reason !== 'shutdown') expect(life.deferred('alpha')).toBeUndefined()
    if (reason === 'teardown' || reason === 'shutdown') expect(life.acquire('alpha', 'delivery')).toBeUndefined()
  })

  test('shutdown resolves a delayed key pause and waits for an already running reconnect', async () => {
    const { life, clock } = harness()
    let finish!: () => void, stopped = false, paused = false
    life.setReconnect(() => new Promise<void>(resolve => { finish = resolve; unblocks.push(resolve) }))
    life.defer('alpha'); await clock.advance(NOT_NOW_RETRY_MS[0])
    const pause = life.pause(1000).then(() => { paused = true })
    const stop = life.stop().then(() => { stopped = true })
    await clock.flush()
    expect(paused).toBe(true); expect(stopped).toBe(false)
    expect(clock.pendingCount()).toBe(0)
    finish(); await Promise.all([pause, stop])
    expect(stopped).toBe(true)
  })
})

test('concurrent and nested reconnect scopes keep each persona client and budget hook across awaits, restoring on rejection', async () => {
  const scope = createDeliveryAdScope(), alpha = makeStubClient(), beta = makeStubClient(), counts = [0, 0]
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = scope.run('alpha', alpha as any, () => { counts[0]++ }, async () => {
    await held
    expect(scope.current('beta')).toBeUndefined()
    expect(scope.current('alpha')?.client).toBe(alpha as any)
    scope.current('alpha')!.beforeCall()
    await expect(scope.run('beta', beta as any, () => { counts[1]++ }, async () => {
      expect(scope.current('alpha')).toBeUndefined()
      scope.current('beta')!.beforeCall()
      throw new Error('scoped refusal')
    })).rejects.toThrow('scoped refusal')
    expect(scope.current('alpha')?.client).toBe(alpha as any)
  })
  await scope.run('beta', beta as any, () => { counts[1]++ }, async () => {
    await Promise.resolve()
    expect(scope.current('alpha')).toBeUndefined()
    expect(scope.current('beta')?.client).toBe(beta as any)
    scope.current('beta')!.beforeCall(); release()
  })
  await first
  expect(counts).toEqual([1, 2])
  expect(scope.current('alpha')).toBeUndefined(); expect(scope.current('beta')).toBeUndefined()
})


describe('retained reconnect input ownership', () => {
  test.each(['new-launch', 'new-session', 'ended', 'missing', 'teardown'] as const)(
    '%s cancels the old command continuation while preserving the sibling', event => {
      const { life } = harness()
      for (const key of ['alpha', 'beta']) {
        life.observeRow(key, { state: 'waiting', session_id: 'old-session', launch_started_at: '2026-10-15T01:00:00Z' })
        life.rememberReconnectInput(key, { session: 'old-session' })
      }
      if (event === 'new-launch') life.observeRow('alpha', { state: 'pending' })
      else if (event === 'teardown') life.forget('alpha')
      else life.observeRow('alpha', { state: event === 'ended' || event === 'missing' ? event : 'waiting', session_id: event === 'new-session' ? 'new-session' : 'old-session', launch_started_at: '2026-10-15T01:00:00Z' })
      expect(life.reconnectInput('alpha')).toBeUndefined()
      expect(life.reconnectInput('beta')).toBeDefined()
      expect(life.acquire('beta', 'delivery')).toBeUndefined()
    },
  )
  test('a pending command keeps its retry timer when a connected engine takes ownership', async () => {
    const { life, clock, calls } = harness()
    life.rememberReconnectInput('alpha', { session: 's1' })
    life.setReconnect(async key => { calls.push({ key, at: clock.now() }); life.clearReconnectInput(key); life.clearDeferred(key) })
    life.defer('alpha')
    life.engineRunning('alpha', true)
    expect(life.acquire('alpha', 'delivery')).toBeUndefined()
    await clock.advance(NOT_NOW_RETRY_MS[0])
    expect(calls).toEqual([{ key: 'alpha', at: NOT_NOW_RETRY_MS[0] }])
    expect(life.reconnectInput('alpha')).toBeUndefined()
    expect(clock.pendingCount()).toBe(0)
    const release = life.acquire('alpha', 'delivery')
    expect(release).toBeDefined()
    release?.()
  })
})
