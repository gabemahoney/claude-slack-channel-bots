/** Shared ownership of every automatic keystroke (b.omv SR-5.5/6.6). */
import { NOT_NOW_RETRY_MS } from './delivery-constants.ts'
import { parseLaunchStart } from './pending-row.ts'

export { NOT_NOW_RETRY_MS } from './delivery-constants.ts'
export interface DeliveryClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export const systemDeliveryClock: DeliveryClock = {
  now: Date.now, setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
}
export type TypingOwner = 'delivery' | 'reconnect'
export interface DeliveryLifecycle {
  active(key?: string): boolean
  pause(ms: number): Promise<void>
  launchId(key: string): string
  beforeLaunch(key: string): string
  observeRow(key: string, row: { state: string; session_id?: string; launch_started_at?: string | null }): string
  hasWaited(key: string): boolean
  owner(key: string): TypingOwner | 'free'
  acquire(key: string, owner: TypingOwner): (() => void) | undefined
  deferred(key: string): { due: boolean } | undefined
  defer(key: string): void
  clearDeferred(key: string): void
  engineRunning(key: string, running: boolean): void
  setReconnect(callback: (key: string) => Promise<void>): void
  retryReconnect(key: string): Promise<void>
  setRecovery(callback: (key: string) => Promise<boolean>): void
  recoverBeforeReconnect(key: string): Promise<boolean>
  forget(key: string): void
  stop(): Promise<void>
}
export function createDeliveryLifecycle(options: {
  startId: string; clock?: DeliveryClock; parseLaunchStart?: (value: unknown) => number | undefined
  onError?: (error: unknown) => void
}): DeliveryLifecycle {
  const clock = options.clock ?? systemDeliveryClock
  interface State { n: number; state?: string; session?: string; stamps: Set<number>; waited: boolean; owner: TypingOwner | 'free'; lease?: object; running: boolean; disabled?: boolean; deferred?: { dueAt: number }; timer?: unknown; reconnecting?: Promise<void> }
  const states = new Map<string, State>()
  let stopped = false, reconnect: ((key: string) => Promise<void>) | undefined, recovery: ((key: string) => Promise<boolean>) | undefined
  const pauses = new Map<unknown, () => void>()
  function state(key: string): State { let s = states.get(key); if (!s) { s = { n: 0, stamps: new Set(), waited: false, owner: 'free', running: false }; states.set(key, s) }; return s }
  function cancel(s: State): void { if (s.timer !== undefined) clock.clearTimeout(s.timer); s.timer = undefined }
  function arm(key: string, s: State): void {
    cancel(s)
    if (stopped || s.disabled || !s.deferred || s.running || !reconnect) return
    s.timer = clock.setTimeout(() => { s.timer = undefined; void api.retryReconnect(key).catch(error => options.onError?.(error)).finally(() => arm(key, s)) }, Math.max(1, s.deferred.dueAt - clock.now()))
  }
  const api: DeliveryLifecycle = {
    active: key => !stopped && (key === undefined || !state(key).disabled),
    pause(ms) { return new Promise<void>(resolve => { if (stopped) { resolve(); return }; const timer = clock.setTimeout(() => { pauses.delete(timer); resolve() }, ms); pauses.set(timer, resolve) }) },
    launchId: key => `${options.startId}:${state(key).n}`,
    beforeLaunch(key) { const s = state(key); s.disabled = false; s.n++; s.waited = false; s.state = 'pending'; return api.launchId(key) },
    observeRow(key, row) {
      const s = state(key), stamp = (options.parseLaunchStart ?? parseLaunchStart)(row.launch_started_at)
      const changed = (s.state !== undefined && row.state === 'pending' && s.state !== 'pending') || (stamp !== undefined && !s.stamps.has(stamp)) || (s.session !== undefined && row.session_id !== undefined && row.session_id !== s.session)
      if (changed) { s.n++; s.waited = false }
      if (stamp !== undefined) s.stamps.add(stamp)
      s.state = row.state; if (row.session_id !== undefined) s.session = row.session_id
      if (row.state === 'waiting') s.waited = true
      if (row.state === 'ended' || row.state === 'missing') api.clearDeferred(key)
      return api.launchId(key)
    },
    hasWaited: key => state(key).waited,
    owner: key => state(key).owner,
    acquire(key, owner) {
      const s = state(key)
      if (stopped || s.disabled || s.owner !== 'free') return undefined
      const lease = {}; s.owner = owner; s.lease = lease
      return () => { if (s.lease === lease) { s.owner = 'free'; s.lease = undefined } }
    },
    deferred(key) { const d = state(key).deferred; return d ? { due: clock.now() >= d.dueAt } : undefined },
    defer(key) {
      if (stopped || state(key).disabled) return
      const s = state(key)
      s.deferred = { dueAt: clock.now() + NOT_NOW_RETRY_MS[0] }
      arm(key, s)
    },
    clearDeferred(key) { const s = state(key); cancel(s); s.deferred = undefined },
    engineRunning(key, running) { const s = state(key); s.running = running; if (running) { s.disabled = false; cancel(s) } else arm(key, s) },
    setReconnect(callback) { reconnect = callback; for (const [key, s] of states) arm(key, s) },
    async retryReconnect(key) {
      const s = state(key)
      if (stopped || s.disabled || !s.deferred || s.deferred.dueAt > clock.now() || !reconnect) return
      if (s.reconnecting) return s.reconnecting
      s.deferred.dueAt = clock.now() + NOT_NOW_RETRY_MS[0]
      s.reconnecting = Promise.resolve().then(() => reconnect!(key)).finally(() => { s.reconnecting = undefined })
      await s.reconnecting
    },
    setRecovery(callback) { recovery = callback },
    recoverBeforeReconnect: key => recovery?.(key) ?? Promise.resolve(true),
    forget(key) { const s = state(key); s.disabled = true; cancel(s); s.deferred = undefined; s.running = false; s.lease = undefined; s.owner = 'free' },
    async stop() { stopped = true; for (const s of states.values()) cancel(s); for (const [timer, resolve] of pauses) { clock.clearTimeout(timer); resolve() }; pauses.clear(); await Promise.allSettled([...states.values()].flatMap(s => s.reconnecting ? [s.reconnecting] : [])) },
  }
  return api
}
