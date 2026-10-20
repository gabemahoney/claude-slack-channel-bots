/** Durable one-part-at-a-time delivery executor (b.omv SR-5/6).
 * All environment access is injected; importing this module does no I/O. */
import type { Client, GetResult, SendKeysParams } from 'agent-director'
import type { DeliveryQueue, QueueItem, QueueRecord, SentRecord } from './delivery-queue.ts'
import { createDeliveryReceiptReader, effectiveSends, type DeliveryReceiptReader, type ReceiptObservation } from './delivery-receipt.ts'
import { type DeliveryLifecycle, type DeliveryClock, systemDeliveryClock, NOT_NOW_RETRY_MS } from './delivery-lifecycle.ts'
import { decideEngine, decideGate, firstSendGate, recoveryEnterGate, latestDeliveryAttempt, retypeGate, selectDeliveryTarget, NO_DELIVERY_PAIR, createDeliveryReading, createDeliveryPolicyState, type DeliveryPair, type DeliveryPolicyEngine, type DeliveryPolicyKnowledge, type DeliveryReading, type DeliveryTimer } from './delivery-policy.ts'
import { classifyAdError, isAdErrorInstance, classifyWithInvalidFlagsRecheck, type AdCall } from './ad-error-class.ts'
import { ErrInvalidFlags, ErrSpawnNotFound, ErrSpawnNotInteractive, ErrSendKeysWhileRelayed, ErrRelayFallenBack, ErrDialogMaybeOpen, ErrPaneChanged, ErrSystemInstallDisappeared } from './agent-director-errors.ts'
import { LAUNCH_SETTLE_MS, ENTER_DELAY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS, DELIVERY_MAX_AD_CALLS_PER_S, DELIVERY_ROW_POLL_MS } from './delivery-constants.ts'
import type { DeliveryAgent } from './delivery-receipt.ts'

export * from './delivery-policy.ts'
export { createDeliveryLifecycle, NOT_NOW_RETRY_MS } from './delivery-lifecycle.ts'
export type { DeliveryLifecycle, DeliveryClock } from './delivery-lifecycle.ts'

export * from './delivery-constants.ts'
export type DeliveryReason = 'state' | 'marker' | 'mcp' | 'launch-settle' | 'relay-off' | 'held' | 'dialog-hold' | 'transcript-unreadable' | 'queue-unwritable' | 'not-now' | 'receipt' | 'backoff'
/** Safe operational facts; never composer or message body text (b.omv SR-8). */
export interface DeliveryStatus {
  key: string; seq: number; count: number; ageMs: number; retypeCount: number
  row?: string; marker: boolean; relay: boolean; connected: boolean; up: boolean
  latched: boolean; held: boolean; receiptWorking: boolean; dialogMaybeOpen: boolean
  reconnectDeferred: boolean
}
export type DeliveryEngineEvent =
  | { type: 'launch-observed'; key: string; launchId: string; sessionId: string; at: number }
  | { type: 'launch-first-waiting'; key: string; launchId: string; sessionId: string; at: number }
  | { type: 'delivered'; key: string; seq: number; part: number }
  | { type: 'item-delivered'; key: string; seq: number; at: number; waitMs: number }
  | { type: 'first-typed'; key: string; seq: number; part: number }
  | { type: 'retyped' | 'first-unconfirmed-retype'; key: string; seq: number; part: number; count: number }
  | { type: 'waiting'; key: string; seq: number; reason: DeliveryReason; ageMs: number; status?: DeliveryStatus }
  | { type: 'marker-missing'; key: string }
export type DeliveryClient = Pick<Client, 'get' | 'sendKeys'>
export interface DeliveryEngineDeps {
  queue: DeliveryQueue; lifecycle: DeliveryLifecycle
  clientFor(key: string): Promise<DeliveryClient>
  /** Production wraps every call in withOutageDetection using this client. */
  call?<T>(key: string, verb: AdCall, client: DeliveryClient, run: (client: DeliveryClient) => Promise<T>): Promise<T>
  instanceId(key: string): string
  persona(key: string): { cwd: string; configDir?: string; agent?: DeliveryAgent } | undefined
  isUp(key: string): boolean; isLatched(key: string): boolean; isHeld(key: string): boolean; isConnected(key: string): boolean
  prepare(key: string, item: QueueItem): Promise<void>
  onRow?(key: string, row: GetResult): boolean
  /** E4's shared replacement when a fresh own-row marker is unproved, under the engine's client and call budget. */
  inspectUpgrade?(key: string, row: GetResult, client: DeliveryClient, beforeCall: () => void): Promise<void>
  onReadError?(key: string, error: unknown, verb: 'get'): Promise<void>
  onError?(key: string, error: unknown): void
  onEvent?(event: DeliveryEngineEvent): void
  onKeyError?(key: string, error: unknown, row: GetResult): Promise<void>
  isRestartPendingOrActive(key: string): boolean
  scheduleRestart(key: string, cwd: string): void
  /** Hand actual AD GONE evidence to checked recovery; true transfers ownership. */
  recoverGone?(key: string, row: GetResult, launch: string): boolean
  /** A fresh get found no row after GONE; true transfers to ordinary recovery. */
  recoverAbsent?(key: string, launch: string): boolean
  reconnect(key: string, client: DeliveryClient, beforeCall: () => void): Promise<void>
  receiptReader?(): DeliveryReceiptReader
  clock?: DeliveryClock
  /** Optional bounded replay constants. Production never caps retypes. */
  constants?: Partial<{ LAUNCH_SETTLE_MS: number; ENTER_DELAY_MS: number; RECEIPT_WAIT_MS: number; RETYPE_BACKOFF_MS: readonly number[]; NOT_NOW_RETRY_MS: readonly number[]; MaxRetypes: number }>
}
export interface DeliveryEngines {
  wake(key: string): void
  tick(key: string): Promise<void>
  recoverBeforeReconnect(key: string): Promise<boolean>
  forget(key: string): Promise<void>
  stop(): Promise<void>
  running(key: string): boolean
  snapshot(key: string): DeliveryPolicyKnowledge | undefined
  status(key: string): DeliveryStatus | undefined
}
export class DeliveryBudgetWait extends Error { constructor(readonly delayMs: number) { super('Delivery call budget') } }
/** The sliding ten-second window counts every engine and deferred call. */
export function createDeliveryCallBudget(now: () => number, callsPerSecond = DELIVERY_MAX_AD_CALLS_PER_S): () => void {
  const calls: number[] = []
  return () => {
    const at = now()
    while (calls.length && calls[0]! <= at - 10000) calls.shift()
    if (calls.length >= callsPerSecond * 10) throw new DeliveryBudgetWait(calls[0]! + 10000 - at)
    calls.push(at)
  }
}
/** A definite refusal of the *text* call; Enter never removes an earlier text. */
export function deliveryTextWasRefused(error: unknown): boolean {
  const cls = classifyAdError(error).errorClass
  return ['CONFLICT', 'UNUSABLE_NAME', 'ENVIRONMENT', 'CONFIG', 'GONE'].includes(cls) || [ErrInvalidFlags, ErrSpawnNotFound, ErrSpawnNotInteractive, ErrSendKeysWhileRelayed, ErrRelayFallenBack, ErrDialogMaybeOpen, ErrPaneChanged, ErrSystemInstallDisappeared].some(c => isAdErrorInstance(error, c))
}
export function createDeliveryEngines(deps: DeliveryEngineDeps): DeliveryEngines {
  const clock = deps.clock ?? systemDeliveryClock, life = deps.lifecycle, constants = deps.constants
  const ms = (name: 'LAUNCH_SETTLE_MS' | 'ENTER_DELAY_MS' | 'RECEIPT_WAIT_MS', fallback: number): number => constants?.[name] ?? fallback
  interface State {
    e: DeliveryPolicyEngine; reading: DeliveryReading; row?: GetResult; receipt?: ReceiptObservation
    reader: DeliveryReceiptReader; receiptTarget?: DeliveryPair; receiptAttempt?: number; deadlines: Partial<Record<DeliveryTimer, number>>; budget: () => void
    rowAt: number; waitingAt?: number; notNowStep: number; retryStep: number; appendRetryStep: number; lastSeq?: number; lastPart?: number
    pending?: { record: QueueRecord; complete(): void }; lease?: () => void; timer?: unknown; busy?: Promise<void>; stopped: boolean
    restarted?: string; gone?: { row: GetResult; launch: string; handedOff?: boolean }; receiptWorking: boolean; pollAfter: number; snapshot?: DeliveryPolicyKnowledge; lastRetypeEvent?: number; dialogHold: boolean; dialogMaybeOpen: boolean; recoveringReconnect?: boolean
  }
  const states = new Map<string, State>(), budgets = new Map<string, () => void>()
  // Empty queues retire their engine, not the already observed launch. Keep
  // its first waiting read without polling an otherwise idle persona.
  const launches = new Map<string, { launchId: string; sessionId: string; waitingAt?: number }>()
  let stopped = false
  const typed = new Set<string>()
  function emit(event: DeliveryEngineEvent): void { try { void Promise.resolve(deps.onEvent?.(event)).catch(() => {}) } catch {} }
  function budget(key: string): () => void { let b = budgets.get(key); if (!b) { b = createDeliveryCallBudget(clock.now); budgets.set(key, b) }; return b }
  function create(key: string): State {
    const s: State = { e: createDeliveryPolicyState(), reading: createDeliveryReading(), reader: deps.receiptReader?.() ?? createDeliveryReceiptReader(), deadlines: {}, budget: budget(key), rowAt: -Infinity, notNowStep: 0, retryStep: 0, appendRetryStep: 0, stopped: false, receiptWorking: false, pollAfter: 0, dialogHold: false, dialogMaybeOpen: false }
    states.set(key, s); life.engineRunning(key, true); return s
  }
  function release(s: State): void { s.lease?.(); s.lease = undefined; s.e.request = 'none' }
  function timers(s: State): void { for (const name of Object.keys(s.e.timers) as DeliveryTimer[]) s.e.timers[name] = Math.max(0, (s.deadlines[name] ?? 0) - clock.now()) }
  function status(key: string, s: State): DeliveryStatus | undefined {
    const items = deps.queue.items(key).filter(i => !i.delivered), head = items[0]
    if (!head) return undefined
    const deferred = life.deferred(key)
    return { key, seq: head.accepted.seq, count: items.length, ageMs: Math.max(0, clock.now() - head.accepted.received_at), retypeCount: head.retypeCount,
      row: s.restarted === life.launchId(key) ? (s.row?.state === 'ended' || s.row?.state === 'missing' ? s.row.state : 'absent') : s.row?.state, marker: s.row?.labels?.tag_prompt === '1', relay: s.row?.relay_mode === 'on', connected: deps.isConnected(key), up: deps.isUp(key),
      latched: deps.isLatched(key), held: deps.isHeld(key), receiptWorking: s.receiptWorking, dialogMaybeOpen: s.dialogMaybeOpen, reconnectDeferred: !!deferred }
  }
  function wait(key: string, s: State, reason: DeliveryReason): void { const facts = status(key, s); if (facts) emit({ type: 'waiting', key, seq: facts.seq, reason, ageMs: facts.ageMs, status: facts }) }
  function schedule(key: string, s: State, delay = DELIVERY_ROW_POLL_MS): void {
    if (stopped || s.stopped) return
    if (s.timer !== undefined) clock.clearTimeout(s.timer)
    s.timer = clock.setTimeout(() => { s.timer = undefined; void api.tick(key) }, Math.max(1, delay))
  }
  async function ad<T>(key: string, s: State, verb: AdCall, run: (client: DeliveryClient) => Promise<T>): Promise<T> {
    if (stopped || s.stopped) throw new Error('Delivery stopped')
    const client = await deps.clientFor(key)
    if (stopped || s.stopped) throw new Error('Delivery stopped')
    s.budget()
    return deps.call ? deps.call(key, verb, client, run) : run(client)
  }
  async function readRow(key: string, s: State, force = false): Promise<boolean> {
    if (clock.now() - s.rowAt < DELIVERY_ROW_POLL_MS && s.row && !force) return true
    s.rowAt = clock.now()
    try {
      const row = await ad(key, s, 'get', client => client.get({ instance_id: deps.instanceId(key) }))
      if (stopped || s.stopped) return false
      s.row = row
      if (row.state !== 'waiting' || !row.unproven_requests?.length || row.unproven_requests.some(r => r.decision === null)) s.dialogHold = false
      life.observeRow(key, row)
      if (row.state === 'ended' || row.state === 'missing') restart(key, s)
      if (deps.onRow?.(key, row)) { wait(key, s, 'held'); return false }
      const markerMissing = row.labels?.tag_prompt !== '1'
      // b.omv SR-7.6: this fresh own-row get already proves the current
      // marker. Independent send-gate reads still recheck it before keys.
      if (deps.inspectUpgrade && (markerMissing || row.instance_id !== deps.instanceId(key))) {
        if (markerMissing) release(s)
        const client = await deps.clientFor(key)
        if (stopped || s.stopped) return false
        await deps.inspectUpgrade(key, row, client, s.budget)
        if (markerMissing) {
          wait(key, s, 'marker')
          // Replacement may have started. Never continue with the old reading.
          return false
        }
      }
      if (s.e.phase === 'receipt' || s.receiptWorking) {
        if (row.state === 'working') s.receiptWorking = true
        else if (s.receiptWorking) { s.e.phase = 'receipt'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS); s.receiptWorking = false }
      }
      if (row.state === 'waiting' && s.waitingAt === undefined && life.launchId(key) === s.e.launchSeen) {
        s.waitingAt = clock.now()
        const launch = launches.get(key)
        if (launch?.launchId === life.launchId(key) && launch.sessionId === row.session_id) launch.waitingAt = s.waitingAt
        emit({ type: 'launch-first-waiting', key, launchId: life.launchId(key), sessionId: row.session_id, at: s.waitingAt })
      }
      return true
    } catch (error) {
      if (error instanceof DeliveryBudgetWait) throw error
      await deps.onReadError?.(key, error, 'get')
      deps.onError?.(key, error)
      if (isAdErrorInstance(error, ErrSpawnNotFound)) {
        life.clearDeferred(key)
        const gone = s.gone
        if (gone && deps.recoverAbsent) {
          // Absence supersedes the old live-row evidence. Transfer to the
          // ordinary retry owner, which reads AD again before any launch;
          // never kill a replacement using this retained row.
          if (gone.launch === life.launchId(key) && canHandoffGone(key, s) && deps.recoverAbsent(key, gone.launch)) s.gone = undefined
        } else restart(key, s)
        wait(key, s, 'state')
      }
      return false
    }
  }
  function canHandoffGone(key: string, s: State): boolean {
    return !stopped && !s.stopped && life.active(key) && deps.isUp(key) && !deps.isLatched(key) && !deps.isHeld(key) && life.owner(key) === 'free'
  }
  function handoffGone(key: string, s: State, retry = false): void {
    const gone = s.gone
    if (!gone) return
    if (gone.launch !== life.launchId(key)) { s.gone = undefined; return }
    if (gone.handedOff && !retry) return
    if (!canHandoffGone(key, s)) return
    // The sequence runs detached. Awaiting it here could join this engine
    // again at its launch/reconnect or while teardown waits for this tick.
    if (deps.recoverGone?.(key, gone.row, gone.launch)) { gone.handedOff = true; life.clearDeferred(key) }
  }
  async function refreshGone(key: string, s: State, retry = false): Promise<void> {
    const gone = s.gone
    if (!gone) return
    if (gone.launch !== life.launchId(key)) { s.gone = undefined; return }
    if ((gone.handedOff && !retry) || !canHandoffGone(key, s)) return
    // A hold or refused sequence can outlive this AD life. Re-read even
    // inside the row cache window before using its old GONE evidence.
    const fresh = await readRow(key, s, true), row = s.row
    if (s.gone !== gone) return
    if (gone.launch !== life.launchId(key) || (row && (row.session_id !== gone.row.session_id || row.launch_started_at !== gone.row.launch_started_at))) {
      s.gone = undefined; return
    }
    if (fresh && row) { gone.row = row; handoffGone(key, s, retry) }
  }
  function restart(key: string, s: State, goneRow?: GetResult): void {
    const id = life.launchId(key), p = deps.persona(key)
    if (!p || s.restarted === id) return
    // GONE bars every further key in this launch, including when someone
    // else already scheduled its restart (SR-5.6).
    s.restarted = id; release(s)
    if (goneRow && deps.recoverGone) {
      s.gone = { row: goneRow, launch: id }
      handoffGone(key, s)
      return
    }
    if (!deps.isRestartPendingOrActive(key)) deps.scheduleRestart(key, p.cwd)
  }
  function build(key: string, s: State): DeliveryPolicyKnowledge {
    timers(s)
    s.e.appendBlocked = !!s.pending && s.e.appendBlocked || deps.queue.isWritable?.(key) === false
    const items = deps.queue.items(key)
    s.e.noticed = [...new Set([...s.e.noticed, ...items.filter(i => i.records.some(r => r.kind === 'noticed')).map(i => i.accepted.seq)])]
    const sends: DeliveryPolicyKnowledge['p']['sent'][number][] = [], refused: number[] = [], delivered: DeliveryPair[] = [], parts: Record<number, number> = {}
    for (const item of items) {
      parts[item.accepted.seq] = item.fixed?.parts.length ?? 1
      const noKeys = new Set(item.records.filter(r => r.kind === 'refused').map(r => r.attempt))
      for (const r of item.records) {
        if (r.kind === 'sent') {
          // The receipt adapter has already applied path/byte windows. Its
          // returned exact receipts are the frozen records.
          const part = 'part' in r ? r.part : Array.from({ length: parts[item.accepted.seq]! }, (_, n) => n + 1).find(p => !item.records.some(record => record.kind === 'delivered' && record.part === p)) ?? 1
          // The frozen observation predates any newly appended send.
          // Receipts for earlier sends of this part remain eligible.
          const offset = s.receiptTarget?.[0] === item.accepted.seq && s.receiptTarget[1] === part && r.attempt > (s.receiptAttempt ?? 0) ? s.reading.records.length : 0
          sends.push({ item: item.accepted.seq, part, offset, how: 'send_kind' in r ? r.send_kind : 'unknown', attempt: r.attempt })
          if (noKeys.has(r.attempt)) refused.push(sends.length)
        } else if (r.kind === 'delivered') delivered.push([r.seq, r.part])
      }
    }
    if (deps.isConnected(key) && !life.reconnectInput(key)) life.clearDeferred(key)
    const deferred = life.deferred(key)
    s.reading = { ...s.reading, gate: life.owner(key), up: deps.isUp(key) && !!deps.persona(key), latched: deps.isLatched(key), held: deps.isHeld(key) || s.restarted === life.launchId(key), mcp: deps.isConnected(key) }
    const k: DeliveryPolicyKnowledge = { p: { accepted: items.map(i => i.accepted.seq), fixed: items.filter(i => i.fixed).map(i => i.accepted.seq), sent: sends, refused, delivered }, e: s.e, r: s.reading, g: { owner: life.owner(key), stage: 'none', deferred: !!deferred, due: deferred?.due ?? false }, writer: { kind: s.pending?.record.kind ?? 'none' }, compact: 'none', parts, MaxRetypes: constants?.MaxRetypes, textFor: pair => items.find(i => i.accepted.seq === pair[0])?.fixed?.parts[pair[1] - 1] ?? pair }
    s.snapshot = k; return k
  }
  async function observe(key: string, s: State, head: QueueItem, part: number, force = false): Promise<boolean> {
    if (!await readRow(key, s, force) || !s.row) return false
    const row = s.row, persona = deps.persona(key), agent: DeliveryAgent = row.agent === 'codex' ? 'codex' : persona?.agent ?? 'claude'
    const receipt = s.reader.read(agent, row, head, part, deps.queue.items(key), persona?.configDir)
    s.receipt = receipt
    s.receiptTarget = [head.accepted.seq, part]; s.receiptAttempt = effectiveSends(head, part).at(-1)?.attempt ?? 0
    const text = head.fixed?.parts[part - 1]
    const records = [
      ...(receipt.receipt ? [{ kind: 'take-in', text }] : []),
    ]
    s.reading = { row: row.state, relay: row.relay_mode === 'on', marker: row.labels?.tag_prompt === '1', mcp: deps.isConnected(key), up: deps.isUp(key), latched: deps.isLatched(key), held: deps.isHeld(key), readable: receipt.availability !== 'unreadable', receipts: receipt.receipt ? [records.length] : [], launch: life.launchId(key), session: row.session_id, gate: life.owner(key), offset: 0, records }
    if (life.launchId(key) === s.e.launchSeen && s.waitingAt !== undefined) s.deadlines.settle = s.waitingAt + ms('LAUNCH_SETTLE_MS', LAUNCH_SETTLE_MS)
    if (s.restarted === life.launchId(key)) s.reading.held = true
    return true
  }
  // A durable append or the text-to-Enter pause may outlive its gate read.
  // Revalidate AD's row and CSCB's lifecycle guards before each unused key.
  async function revalidateKeys(key: string, s: State): Promise<boolean> {
    const fresh = await readRow(key, s, true), row = s.row
    const allowed = fresh && row && life.owner(key) === 'delivery' &&
      life.launchId(key) === s.e.launchSeen && row.session_id === s.e.sessionSeen &&
      (s.e.phase === 'recovery-enter' ? recoveryEnterGate : firstSendGate)({ ...s.reading, row: row.state, marker: row.labels?.tag_prompt === '1',
        relay: row.relay_mode === 'on', up: deps.isUp(key), mcp: deps.isConnected(key),
        held: deps.isHeld(key), latched: deps.isLatched(key) }, s.e)
    if (allowed) return true
    s.e.phase = 'receipt'; s.e.request = 'none'
    s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS)
    release(s)
    return false
  }
  function queueWrite(s: State, record: QueueRecord, complete: () => void): void { s.pending = { record, complete } }
  function afterSend(s: State, key: string, sent: SentRecord): void {
    s.e.phase = 'receipt'; s.e.request = 'none'
    const at = clock.now()
    s.deadlines.receipt = at + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS)
    const backoff = constants?.RETYPE_BACKOFF_MS ?? RETYPE_BACKOFF_MS
    s.deadlines.backoff = at + backoff[Math.min(s.retryStep, backoff.length - 1)]!
    if (sent.send_kind === 'retype' && s.lastRetypeEvent !== sent.attempt) { s.lastRetypeEvent = sent.attempt; emit({ type: 'retyped', key, seq: sent.seq, part: sent.part, count: deps.queue.items(key).find(i => i.accepted.seq === sent.seq)?.retypeCount ?? s.e.retypes[sent.seq] ?? 0 }) }
  }
  async function keyError(key: string, s: State, error: unknown, textCall: boolean): Promise<void> {
    if (error instanceof DeliveryBudgetWait) throw error
    const row = s.row!, launch = s.e.launchSeen
    await deps.onKeyError?.(key, error, row)
    if (isAdErrorInstance(error, ErrInvalidFlags) && !deps.onKeyError) await classifyWithInvalidFlagsRecheck(error)
    if (isAdErrorInstance(error, ErrSpawnNotInteractive) || isAdErrorInstance(error, ErrSpawnNotFound)) {
      if (await readRow(key, s, true)) {
        if (s.row?.state === 'ended' || s.row?.state === 'missing') restart(key, s)
      }
    } else if (classifyAdError(error).errorClass === 'GONE' && life.launchId(key) === launch) restart(key, s, row)
    s.dialogMaybeOpen = isAdErrorInstance(error, ErrDialogMaybeOpen)
    if (s.dialogMaybeOpen) {
      const fresh = await readRow(key, s, true)
      const requests = s.row?.unproven_requests
      s.dialogHold = fresh && s.row?.state === 'waiting' && !!requests?.length && requests.every(r => r.decision !== null)
      if (s.dialogHold) wait(key, s, 'dialog-hold')
    }
    const steps = constants?.NOT_NOW_RETRY_MS ?? NOT_NOW_RETRY_MS
    s.deadlines.notNow = clock.now() + steps[Math.min(s.notNowStep++, steps.length - 1)]!
    if (textCall && deliveryTextWasRefused(error)) s.e.phase = 'refused'
    else { const sent = effectiveSends(deps.queue.items(key).find(i => i.accepted.seq === s.e.target[0])!, s.e.target[1]).at(-1); if (sent) afterSend(s, key, sent); s.e.phase = 'receipt'; s.e.request = 'none'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS) }
    wait(key, s, 'not-now')
  }
  async function run(key: string, s: State): Promise<void> {
    let nextDelay = DELIVERY_ROW_POLL_MS
    let observedPair: DeliveryPair | undefined, readyObserved = false
    try {
      // A concurrent local hold may have delayed the GONE handoff. This
      // engine retains it only for the launch whose key call failed.
      await refreshGone(key, s, s.recoveringReconnect)
      // Finish our own append/call continuations without replacing the key
      // reading. Every new operation obtains a fresh row and gate grant.
      for (let turns = 0; turns < 40 && !stopped && !s.stopped; turns++) {
        const items = deps.queue.items(key), head = items.find(i => !i.delivered)
        if (!head && !s.pending) {
          release(s); states.delete(key); life.engineRunning(key, false); return
        }
        if (!s.pending && (!deps.isUp(key) || deps.isLatched(key) || deps.isHeld(key))) { release(s); wait(key, s, 'held'); break }
        if (!s.pending && deps.queue.isWritable?.(key) === false) { release(s); wait(key, s, 'queue-unwritable'); nextDelay = RETYPE_BACKOFF_MS[0]; break }
        let k = build(key, s), pair = selectDeliveryTarget(k), part = pair[1]
        const observedItem = head
        const observedPart = part
        if (head && (s.lastSeq !== head.accepted.seq || s.lastPart !== part)) {
          // Retype spacing belongs to the FIFO item, spanning its parts.
          if (s.lastSeq !== head.accepted.seq) s.retryStep = 0
          s.lastSeq = head.accepted.seq; s.lastPart = part; s.lastRetypeEvent = undefined; s.e.target = pair; s.notNowStep = 0
          s.e.recoveryAttempt = undefined
        }
        if (!s.pending && observedItem && (s.e.phase === 'ready' || s.e.phase === 'receipt' || !s.row)
          && (!observedPair || observedPair[0] !== observedItem.accepted.seq || observedPair[1] !== observedPart || (s.e.phase === 'ready' && !readyObserved))) {
          if (!await observe(key, s, observedItem, observedPart)) { release(s); break }
          // Pure transitions and durable appends consume this tick's reading.
          // The gate still obtains its own fresh observation below; do not
          // replace the engine reading again after that independent grant.
          observedPair = [observedItem.accepted.seq, observedPart]; readyObserved = true
          k = build(key, s)
        }
        const action = decideEngine(k)
        if (action === 'commitAppend') {
          const pending = s.pending!
          try {
            await deps.queue.append(key, pending.record)
            if (s.pending === pending) s.pending = undefined
            s.e.appendBlocked = false; s.appendRetryStep = 0; pending.complete()
          } catch (error) {
            s.e.appendBlocked = true; release(s); wait(key, s, 'queue-unwritable')
            const backoff = constants?.RETYPE_BACKOFF_MS ?? RETYPE_BACKOFF_MS
            s.deadlines.backoff = clock.now() + backoff[Math.min(s.appendRetryStep++, backoff.length - 1)]!
            deps.onError?.(key, error); nextDelay = s.deadlines.backoff - clock.now(); break
          }
          continue
        }
        if (action === 'observeLaunch') {
          release(s); s.e.phase = 'ready'; s.e.launchSeen = k.r.launch; s.e.sessionSeen = k.r.session
          s.receiptWorking = false
          s.e.recoveryAttempt = undefined
          s.e.retypes = {}; s.dialogHold = false; s.dialogMaybeOpen = false; s.retryStep = 0; s.notNowStep = 0
          s.deadlines.backoff = 0; s.deadlines.notNow = 0; s.deadlines.enterDelay = 0
          const previous = launches.get(key), launchId = life.launchId(key), sessionId = s.row!.session_id
          const sameLaunch = previous?.launchId === launchId && previous.sessionId === sessionId
          s.waitingAt = sameLaunch ? previous.waitingAt : undefined
          const firstWaiting = s.waitingAt === undefined && s.row?.state === 'waiting'
          if (firstWaiting) s.waitingAt = clock.now()
          launches.set(key, { launchId, sessionId, waitingAt: s.waitingAt })
          s.deadlines.settle = s.waitingAt === undefined ? Infinity : s.waitingAt + ms('LAUNCH_SETTLE_MS', LAUNCH_SETTLE_MS)
          if (!sameLaunch) emit({ type: 'launch-observed', key, launchId, sessionId, at: clock.now() })
          if (firstWaiting) emit({ type: 'launch-first-waiting', key, launchId, sessionId, at: s.waitingAt! })
          continue
        }
        if (action === 'readReceipt') {
          const receipt = s.receipt?.receipt
          if (!receipt) break
          queueWrite(s, { v: 1, kind: 'delivered', seq: pair[0], part, at: clock.now(), receipt: { path: receipt.path, uuid: receipt.uuid, offset: receipt.offset } }, () => {
            // The working extension belongs to this confirmed part. Carrying
            // it into the next head makes its first waiting row start a new
            // receipt timeout before that head has sent any keys.
            s.receiptWorking = false; s.deadlines.receipt = 0
            s.e.phase = 'ready'; s.e.target = NO_DELIVERY_PAIR; release(s)
            emit({ type: 'delivered', key, seq: pair[0], part })
            const item = deps.queue.items(key).find(i => i.accepted.seq === pair[0])
            if (item?.delivered) emit({ type: 'item-delivered', key, seq: pair[0], at: clock.now(), waitMs: Math.max(0, clock.now() - item.accepted.received_at) })
          }); continue
        }
        if (action === 'fixText') {
          release(s)
          try { await deps.prepare(key, head!) } catch (error) { wait(key, s, 'queue-unwritable'); deps.onError?.(key, error) }
          break
        }
        if (action === 'requestGate') {
          s.e.request = 'delivery'
          // Revalidate every unused request against a fresh independent gate
          // observation. The engine's prior external reading stays frozen.
          const saved = s.reading
          if (!await observe(key, s, observedItem!, observedPart, true)) { s.e.request = 'none'; s.reading = saved; break }
          const gateKnowledge = build(key, s), choice = decideGate(gateKnowledge)
          // A writer failure may have released an already-recorded attempt's
          // lease for a long time. Recover that durable unknown attempt if
          // fresh guards changed; never turn its old intention into keys in
          // a person's composer or a different launch.
          if (s.e.phase === 'text') {
            const sent = effectiveSends(head!, part).at(-1)
            const safe = sent?.send_kind === 'retype' ? retypeGate(gateKnowledge.r, gateKnowledge.e) : firstSendGate(gateKnowledge.r, gateKnowledge.e)
            if (!safe) { s.e.phase = 'ready'; s.e.request = 'none'; release(s); break }
          } else if (['enter', 'recovery-enter'].includes(s.e.phase) && !(s.e.phase === 'recovery-enter' ? recoveryEnterGate : firstSendGate)(gateKnowledge.r, gateKnowledge.e)) {
            s.e.phase = 'receipt'; s.e.request = 'none'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS); release(s); break
          }
          if (choice === 'grantDelivery') {
            s.lease = life.acquire(key, 'delivery')
            if (s.lease) { s.e.request = 'granted'; s.e.keyReading = { ...s.reading }; continue }
          }
          s.e.request = 'none'; break
        }
        if (action === 'recordSend' || action === 'recordRecoveryEnter') {
          const retype = (effectiveSends(head!, part).length > 0 || head!.unknownSend)
          const kind = action === 'recordRecoveryEnter' ? 'enter' : retype ? 'retype' : 'text'
          const sent: SentRecord = { v: 1, kind: 'sent', seq: pair[0], part, attempt: head!.nextAttempt, send_kind: kind, at: clock.now(), launch_id: life.launchId(key), session_id: s.row!.session_id, transcript_path: s.receipt?.path ?? '', transcript_size: s.receipt?.size ?? 0 }
          s.e.target = pair; s.e.attempt = sent.attempt
          queueWrite(s, sent, () => {
            s.e.phase = kind === 'enter' ? 'recovery-enter' : 'text'; s.e.request = 'none'
            if (kind === 'retype') { s.e.retypes[pair[0]] = (s.e.retypes[pair[0]] ?? 0) + 1; s.retryStep++ }
          }); continue
        }
        if (action === 'typeText') {
          if (!await revalidateKeys(key, s)) break
          try {
            const params: SendKeysParams = { instance_id: deps.instanceId(key), text: head!.fixed!.parts[part - 1], no_enter: true }
            await ad(key, s, 'send-keys', client => client.sendKeys(params))
            if (part === 1 && effectiveSends(head!, part).at(-1)?.send_kind === 'text' && !typed.has(`${key}:${pair[0]}`)) { typed.add(`${key}:${pair[0]}`); emit({ type: 'first-typed', key, seq: pair[0], part }) }
            s.dialogMaybeOpen = false
            s.notNowStep = 0; s.deadlines.notNow = 0; s.e.phase = 'enter'; s.deadlines.enterDelay = clock.now() + ms('ENTER_DELAY_MS', ENTER_DELAY_MS)
          } catch (error) { await keyError(key, s, error, true) }
          if (s.e.phase === 'enter') { nextDelay = ms('ENTER_DELAY_MS', ENTER_DELAY_MS); break }
          continue
        }
        if (action === 'pressEnter') {
          if (!await revalidateKeys(key, s)) break
          const recovery = s.e.phase === 'recovery-enter'
          try {
            await ad(key, s, 'send-keys', client => client.sendKeys({ instance_id: deps.instanceId(key), key: 'Enter' }))
            // The durable intent precedes keys. A restart or any refused or
            // uncertain recovery retries Enter before it can append text.
            if (recovery) s.e.recoveryAttempt = s.e.attempt
          }
          catch (error) { await keyError(key, s, error, false) }
          const sentItem = deps.queue.items(key).find(i => i.accepted.seq === s.e.target[0]) ?? head!
          const sent = effectiveSends(sentItem, s.e.target[1]).at(-1)
          if (sent) afterSend(s, key, sent)
          else { s.e.phase = 'receipt'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS) }
          break
        }
        if (action === 'recordRefusal') {
          queueWrite(s, { v: 1, kind: 'refused', seq: s.e.target[0], attempt: s.e.attempt, at: clock.now() }, () => {
            const refused = head!.records.find(r => r.kind === 'sent' && r.attempt === s.e.attempt)
            if (refused?.kind === 'sent' && 'send_kind' in refused && refused.send_kind === 'retype') { s.e.retypes[s.e.target[0]] = Math.max(0, (s.e.retypes[s.e.target[0]] ?? 0) - 1); s.retryStep = Math.max(0, s.retryStep - 1) }
            s.e.phase = 'ready'; s.e.request = 'none'; release(s)
          }); continue
        }
        if (action === 'releaseAttempt') {
          release(s); s.e.phase = 'ready'
          // Do not poll a working row with its gate held. Its ten-second
          // receipt deadline restarts when it leaves working.
          if (s.receiptWorking) break
          continue
        }
        if (action === 'recordNotice') {
          // Concrete receipt time must elapse before calling a retype
          // unconfirmed; a receipt arriving meanwhile wins the next choice.
          if (s.e.phase === 'receipt' && (s.deadlines.receipt ?? 0) > clock.now()) { nextDelay = Math.min(DELIVERY_ROW_POLL_MS, s.deadlines.receipt! - clock.now()); break }
          queueWrite(s, { v: 1, kind: 'noticed', seq: pair[0], at: clock.now() }, () => { s.e.noticed = [...s.e.noticed, pair[0]]; emit({ type: 'first-unconfirmed-retype', key, seq: pair[0], part, count: head!.retypeCount }) }); continue
        }
        if (action === 'deferReconnect') {
          release(s)
          // This tick may be awaited by that same reconnect's recovery hook.
          // Let the enclosing attempt continue instead of joining its promise.
          if (!s.recoveringReconnect) await life.retryReconnect(key)
          break
        }
        if (action === 'stopAbsent') { release(s); wait(key, s, 'state'); break }
        if (s.e.phase === 'enter') {
          // A wake can run between a text and its delayed Enter. Keep the
          // key sequence's lease until the Enter (including retry delays).
        } else if (s.e.phase === 'receipt' || s.receiptWorking) {
          if (s.deadlines.receipt !== undefined && clock.now() >= s.deadlines.receipt) { release(s); if (!s.receiptWorking) { s.e.phase = 'ready'; continue } }
          wait(key, s, s.receipt?.availability === 'unreadable' ? 'transcript-unreadable' : 'receipt')
        } else {
          release(s)
          const r = s.reading
          const reason: DeliveryReason = s.dialogHold ? 'dialog-hold' : r.held || r.latched ? 'held' : !r.marker ? 'marker' : !r.relay ? 'relay-off' : r.row !== 'waiting' ? 'state' : !r.mcp ? 'mcp' : s.e.timers.settle > 0 ? 'launch-settle' : s.receipt?.availability === 'unreadable' ? 'transcript-unreadable' : 'backoff'
          wait(key, s, reason); if (reason === 'marker') emit({ type: 'marker-missing', key })
        }
        const due = Object.values(s.deadlines).filter(t => Number.isFinite(t) && t > clock.now()).map(t => t - clock.now())
        nextDelay = Math.min(DELIVERY_ROW_POLL_MS, ...due)
        break
      }
    } catch (error) {
      if (error instanceof DeliveryBudgetWait) nextDelay = error.delayMs
      else { release(s); deps.onError?.(key, error) }
    } finally { if (states.get(key) === s && !stopped && !s.stopped) schedule(key, s, nextDelay) }
  }
  const api: DeliveryEngines = {
    wake(key) {
      if (stopped || !deps.persona(key) || deps.queue.openCount(key) === 0) return
      const s = states.get(key) ?? create(key)
      if (!s.busy) schedule(key, s, 1)
    },
    async tick(key) {
      if (stopped || !deps.persona(key)) return
      let s = states.get(key)
      if (!s) { if (!deps.queue.openCount(key)) return; s = create(key) }
      if (s.busy) return s.busy
      if (s.timer !== undefined) clock.clearTimeout(s.timer); s.timer = undefined
      s.busy = run(key, s).finally(() => { s!.busy = undefined })
      await s.busy
    },
    async recoverBeforeReconnect(key) {
      const head = deps.queue.items(key).find(i => !i.delivered)
      if (!head || (!head.unknownSend && !head.records.some(r => r.kind === 'sent'))) return true
      api.wake(key)
      const s = states.get(key)!
      const reconciled = (): boolean => {
        // Retained GONE must be freshly reconciled by the serialized tick
        // before reconnect may type or retry the checked sequence.
        if (s.gone?.launch === life.launchId(key)) return false
        const k = build(key, s), pair = selectDeliveryTarget(k)
        if (pair[0] === 0) return true
        const attempt = latestDeliveryAttempt(k, pair)
        // A failed read can release the lease before the receipt wait ends.
        // Let the engine finish that wait, including a working-row extension.
        return !s.pending && life.owner(key) !== 'delivery' && (attempt === undefined ||
          (s.e.phase === 'ready' && !s.receiptWorking && s.e.launchSeen === life.launchId(key) &&
            s.e.sessionSeen === s.row?.session_id && s.e.recoveryAttempt === attempt))
      }
      // A reconnect rerun from this engine cannot wait on its own tick.
      if (s.busy) return reconciled()
      s.recoveringReconnect = true
      try { await api.tick(key) } finally { s.recoveringReconnect = false }
      return reconciled()
    },
    async forget(key) { launches.delete(key); const s = states.get(key); if (!s) { life.forget(key); return }; s.stopped = true; if (s.timer !== undefined) clock.clearTimeout(s.timer); release(s); await s.busy; states.delete(key); life.engineRunning(key, false); life.forget(key) },
    async stop() { stopped = true; const stoppingLife = life.stop(); for (const [key, s] of states) { s.stopped = true; if (s.timer !== undefined) clock.clearTimeout(s.timer); release(s); life.engineRunning(key, false) }; await Promise.allSettled([...states.values()].flatMap(s => s.busy ? [s.busy] : [])); await stoppingLife; states.clear(); launches.clear() },
    running: key => states.has(key),
    snapshot: key => states.get(key)?.snapshot,
    status: key => { const s = states.get(key); return s ? status(key, s) : undefined },
  }
  life.setRecovery(api.recoverBeforeReconnect)
  life.setReconnect(async key => {
    if (stopped || !deps.persona(key) || (deps.isConnected(key) && !life.reconnectInput(key))) { life.clearDeferred(key); return }
    // b.omv SR-5.5, b.jg5 SRJ-502: only the latch re-check may call
    // agent-director while latched. Keep the reconnect for after the clear,
    // and recheck after client creation awaits.
    if (deps.isLatched(key)) { life.defer(key); return }
    const client = await deps.clientFor(key)
    if (stopped || !life.active(key)) return
    if (deps.isLatched(key)) { life.defer(key); return }
    await deps.reconnect(key, client, () => { if (stopped || !life.active(key)) throw new Error('Delivery stopped'); budget(key)() })
  })
  return api
}
