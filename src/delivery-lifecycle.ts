/** Shared ownership of every automatic keystroke (b.omv SR-5.5/6.6). */
import { NOT_NOW_RETRY_MS } from './delivery-constants.ts'

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
export interface DeliveryRowObservation { state: string; session_id?: string; launch_started_at?: string | null }
export interface ReconnectInput { session: string; launchStartedAt?: string | null }
export interface DeliveryLifecycle {
  active(key?: string): boolean
  pause(ms: number): Promise<void>
  activate(key: string): void
  observeRow(key: string, row: DeliveryRowObservation): void
  setRelaunchObserver(callback: (key: string, row: DeliveryRowObservation) => void): void
  setFirstWaitingObserver(callback: (key: string, row: DeliveryRowObservation) => void): void
  matchesRow(key: string, row: DeliveryRowObservation): boolean
  hasWaited(key: string): boolean
  owner(key: string): TypingOwner | 'free'
  acquire(key: string, owner: TypingOwner): (() => void) | undefined
  reconnectInput(key: string): ReconnectInput | undefined
  rememberReconnectInput(key: string, input: ReconnectInput): void
  clearReconnectInput(key: string): void
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
  clock?: DeliveryClock
  onError?: (error: unknown) => void
}): DeliveryLifecycle {
  const clock = options.clock ?? systemDeliveryClock
  interface State { state?: string; session?: string; launchStartedAt?: string | null; waited: boolean; owner: TypingOwner | 'free'; lease?: object; running: boolean; disabled?: boolean; deferred?: { dueAt: number }; timer?: unknown; reconnecting?: Promise<void>; reconnectInput?: ReconnectInput }
  const states = new Map<string, State>()
  let stopped = false, reconnect: ((key: string) => Promise<void>) | undefined, recovery: ((key: string) => Promise<boolean>) | undefined
  let relaunchObserver: ((key: string, row: DeliveryRowObservation) => void) | undefined
  let firstWaitingObserver: ((key: string, row: DeliveryRowObservation) => void) | undefined
  const pauses = new Map<unknown, () => void>()
  function state(key: string): State { let s = states.get(key); if (!s) { s = { waited: false, owner: 'free', running: false }; states.set(key, s) }; return s }
  function cancel(s: State): void { if (s.timer !== undefined) clock.clearTimeout(s.timer); s.timer = undefined }
  function arm(key: string, s: State): void {
    cancel(s)
    // A retained control draft owns its continuation even if MCP connects
    // before Enter. The engine cannot append delivery text to that draft.
    if (stopped || s.disabled || !s.deferred || (s.running && !s.reconnectInput) || !reconnect) return
    s.timer = clock.setTimeout(() => { s.timer = undefined; void api.retryReconnect(key).catch(error => options.onError?.(error)).finally(() => arm(key, s)) }, Math.max(1, s.deferred.dueAt - clock.now()))
  }
  const api: DeliveryLifecycle = {
    active: key => !stopped && (key === undefined || !state(key).disabled),
    pause(ms) { return new Promise<void>(resolve => { if (stopped) { resolve(); return }; const timer = clock.setTimeout(() => { pauses.delete(timer); resolve() }, ms); pauses.set(timer, resolve) }) },
    activate(key) { state(key).disabled = false },
    observeRow(key, row) {
      const s = state(key)
      const changed = (['pending', 'ended', 'missing'].includes(row.state) && row.state !== s.state) ||
        (s.session !== undefined && row.session_id !== undefined && row.session_id !== s.session)
      if (changed) {
        s.waited = false; s.reconnectInput = undefined
        // An AD-observed transition invalidates any keys awaiting an old lease.
        s.owner = 'free'; s.lease = undefined
      }
      const firstWaiting = row.state === 'waiting' && !s.waited
      s.state = row.state
      if (row.session_id !== undefined) s.session = row.session_id
      if (row.launch_started_at !== undefined) s.launchStartedAt = row.launch_started_at
      if (row.state === 'waiting') s.waited = true
      if (changed) relaunchObserver?.(key, row)
      if (firstWaiting) firstWaitingObserver?.(key, row)
      if (row.state === 'ended' || row.state === 'missing') { api.clearDeferred(key); s.reconnectInput = undefined }
    },
    setRelaunchObserver(callback) { relaunchObserver = callback },
    setFirstWaitingObserver(callback) { firstWaitingObserver = callback },
    matchesRow(key, row) {
      const s = state(key)
      return s.state === row.state && s.session === row.session_id && s.launchStartedAt === row.launch_started_at
    },
    hasWaited: key => state(key).waited,
    owner: key => state(key).owner,
    acquire(key, owner) {
      const s = state(key)
      if (stopped || s.disabled || s.owner !== 'free' || (owner === 'delivery' && s.reconnectInput)) return undefined
      const lease = {}; s.owner = owner; s.lease = lease
      return () => { if (s.lease === lease) { s.owner = 'free'; s.lease = undefined } }
    },
    reconnectInput: key => state(key).reconnectInput,
    rememberReconnectInput(key, input) { if (api.active(key)) state(key).reconnectInput = input },
    clearReconnectInput(key) { state(key).reconnectInput = undefined },
    deferred(key) { const d = state(key).deferred; return d ? { due: clock.now() >= d.dueAt } : undefined },
    defer(key) {
      if (stopped || state(key).disabled) return
      const s = state(key)
      s.deferred = { dueAt: clock.now() + NOT_NOW_RETRY_MS[0] }
      arm(key, s)
    },
    clearDeferred(key) { const s = state(key); cancel(s); s.deferred = undefined },
    engineRunning(key, running) { const s = state(key); s.running = running; if (running) s.disabled = false; arm(key, s) },
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
    forget(key) { const s = state(key); s.disabled = true; cancel(s); s.deferred = undefined; s.reconnectInput = undefined; s.running = false; s.lease = undefined; s.owner = 'free' },
    async stop() { stopped = true; for (const s of states.values()) cancel(s); for (const [timer, resolve] of pauses) { clock.clearTimeout(timer); resolve() }; pauses.clear(); await Promise.allSettled([...states.values()].flatMap(s => s.reconnecting ? [s.reconnecting] : [])) },
  }
  return api
}
