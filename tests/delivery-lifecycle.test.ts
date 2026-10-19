/** Shared typing ownership and the no-engine reconnect driver (b.omv SR-5.5/6.6). */
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryLifecycle, NOT_NOW_RETRY_MS, RECONNECT_BLOCKED_NOTICE_MS, type DeliveryLifecycle, type TypingOwner } from '../src/delivery-lifecycle.ts'
import { createDeliveryAdScope } from '../src/delivery-ad-scope.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'

const lives: DeliveryLifecycle[] = []
const unblocks: (() => void)[] = []
afterEach(async () => {
  for (const unblock of unblocks.splice(0)) unblock()
  for (const life of lives.splice(0)) await life.stop()
})
function harness() {
  const clock = createFakeClock(), calls: { key: string; at: number }[] = [], screens: unknown[] = []
  const life = createDeliveryLifecycle({ startId: 'server-run', clock, onReconnectScreen: (key, screen, blockedMs) => screens.push({ key, screen, blockedMs }) })
  lives.push(life)
  life.setReconnect(async key => { calls.push({ key, at: clock.now() }) })
  return { clock, life, calls, screens }
}

describe('launch identity and typing leases', () => {
  test('identity follows normalized launch stamps, pending transitions and sessions, independently of server start', () => {
    const { life } = harness()
    const first = life.launchId('alpha')
    expect(life.hasWaited('alpha')).toBe(false)
    const stamped = life.observeRow('alpha', { state: 'waiting', session_id: 's1', launch_started_at: '2026-10-15T01:00:00Z' })
    expect(stamped).not.toBe(first)
    expect(life.hasWaited('alpha')).toBe(true)
    expect(life.observeRow('alpha', { state: 'working', session_id: 's1', launch_started_at: '2026-10-15T01:00:00.000Z' })).toBe(stamped)
    const pending = life.observeRow('alpha', { state: 'pending', session_id: 's1' })
    expect(pending).not.toBe(stamped)
    expect(life.hasWaited('alpha')).toBe(false)
    expect(life.observeRow('alpha', { state: 'pending', session_id: 's1', launch_started_at: 'bad-stamp' })).toBe(pending)
    const resumed = life.observeRow('alpha', { state: 'working', session_id: 's2' })
    expect(resumed).not.toBe(pending)
    expect(life.beforeLaunch('alpha')).not.toBe(resumed)
    expect(life.launchId('beta')).toBe(first)
    const nextServer = createDeliveryLifecycle({ startId: 'another-run' }); lives.push(nextServer)
    expect(nextServer.launchId('alpha')).not.toBe(first)
  })
  test.each(['delivery', 'reconnect', 'startup'] as const)('%s holds one persona gate; stale releases cannot free a replacement lease', owner => {
    const { life } = harness()
    const release = life.acquire('alpha', owner)!
    expect(life.owner('alpha')).toBe(owner)
    for (const contender of ['delivery', 'reconnect', 'startup'] as TypingOwner[]) expect(life.acquire('alpha', contender)).toBeUndefined()
    const sibling = life.acquire('beta', 'delivery')!
    expect(life.owner('beta')).toBe('delivery')
    life.forget('alpha')
    expect(life.acquire('alpha', owner)).toBeUndefined()
    life.beforeLaunch('alpha')
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
    life.defer('alpha', 'menu'); life.defer('beta', 'input')
    if (reason === 'typed-or-connected') life.clearDeferred('alpha')
    else if (reason === 'ended' || reason === 'missing') life.observeRow('alpha', { state: reason })
    else if (reason === 'teardown') life.forget('alpha')
    else await life.stop()
    await clock.advance(NOT_NOW_RETRY_MS[0])
    expect(calls.map(call => call.key)).toEqual(reason === 'shutdown' ? [] : ['beta'])
    if (reason !== 'shutdown') expect(life.deferred('alpha')).toBeUndefined()
    if (reason === 'teardown' || reason === 'shutdown') expect(life.acquire('alpha', 'delivery')).toBeUndefined()
  })
  test('screen-only blocked time and events pause across failed reads and reset after the episode clears', async () => {
    const { life, clock, screens } = harness()
    life.engineRunning('alpha', true)
    life.defer('alpha', 'menu')
    await clock.advance(RECONNECT_BLOCKED_NOTICE_MS)
    life.defer('alpha', 'menu')
    expect(screens.at(-1)).toEqual({ key: 'alpha', screen: 'menu', blockedMs: RECONNECT_BLOCKED_NOTICE_MS })
    life.defer('alpha') // A failed read has no screen evidence.
    await clock.advance(RECONNECT_BLOCKED_NOTICE_MS)
    expect(life.deferred('alpha')?.blockedMs).toBe(RECONNECT_BLOCKED_NOTICE_MS)
    expect(screens).toHaveLength(2)
    life.defer('alpha', 'input')
    expect(screens.at(-1)).toEqual({ key: 'alpha', screen: 'input', blockedMs: RECONNECT_BLOCKED_NOTICE_MS })
    life.clearDeferred('alpha'); life.defer('alpha', 'input')
    expect(screens.at(-1)).toEqual({ key: 'alpha', screen: 'input', blockedMs: 0 })
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
