/** Durable one-part-at-a-time delivery executor.
 * All environment access is injected; importing this module does no I/O. */
import type { Client, GetResult, SendKeysParams } from 'agent-director'
import type { DeliveryQueue, QueueItem, QueueRecord, SentRecord } from './delivery-queue.ts'
import { createQueueItemReader, isOpenItem, itemOpenedAt } from './delivery-queue.ts'
import { createQueueDeliveryReceiptReader, effectiveSends, type DeliveryReceiptReader, type ReceiptObservation } from './delivery-receipt.ts'
import { type DeliveryLifecycle, type DeliveryClock, systemDeliveryClock, NOT_NOW_RETRY_MS } from './delivery-lifecycle.ts'
import { decideEngine, decideGate, firstSendGate, recoveryEnterGate, latestDeliveryAttempt, retypeGate, selectDeliveryTarget, NO_DELIVERY_PAIR, createDeliveryReading, createDeliveryPolicyState, type DeliveryPair, type DeliveryPolicyEngine, type DeliveryPolicyKnowledge, type DeliveryReading, type DeliveryTimer } from './delivery-policy.ts'
import { classifyAdError, isAdErrorInstance, classifyWithInvalidFlagsRecheck, type AdCall } from './ad-error-class.ts'
import { ErrInvalidFlags, ErrSpawnNotFound, ErrSpawnNotInteractive, ErrSendKeysWhileRelayed, ErrRelayFallenBack, ErrDialogMaybeOpen, ErrPaneChanged, ErrSystemInstallDisappeared } from './agent-director-errors.ts'
import { ENTER_DELAY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS, DELIVERY_MAX_AD_CALLS_PER_S, DELIVERY_ROW_POLL_MS } from './delivery-constants.ts'
import type { DeliveryAgent } from './delivery-receipt.ts'

export * from './delivery-policy.ts'
export { createDeliveryLifecycle, NOT_NOW_RETRY_MS } from './delivery-lifecycle.ts'
export type { DeliveryLifecycle, DeliveryClock } from './delivery-lifecycle.ts'

export * from './delivery-constants.ts'
export type DeliveryReason = 'state' | 'marker' | 'mcp' | 'relay-off' | 'held' | 'dialog-hold' | 'transcript-unreadable' | 'queue-unwritable' | 'not-now' | 'receipt' | 'backoff'
/** Safe operational facts; never composer or message body text. */
export interface DeliveryStatus {
  key: string; seq: number; count: number; ageMs: number; retypeCount: number
  row?: string; marker: boolean; relay: boolean; connected: boolean; up: boolean
  latched: boolean; held: boolean; receiptWorking: boolean; dialogMaybeOpen: boolean
  reconnectDeferred: boolean
}
export type DeliveryEngineEvent =
  | { type: 'launch-observed'; key: string; sessionId: string; at: number }
  | { type: 'launch-first-waiting'; key: string; sessionId: string; at: number }
  | { type: 'transcript-reference'; key: string; instanceId: string; sessionId: string; path: string; at: number }
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
  persona(key: string): { cwd: string; agent?: DeliveryAgent } | undefined
  isUp(key: string): boolean; isLatched(key: string): boolean; isHeld(key: string): boolean; isConnected(key: string): boolean
  prepare(key: string, item: QueueItem): Promise<void>
  onRow?(key: string, row: GetResult): boolean
  /** shared replacement when a fresh own-row marker is unproved, under the engine's client and call budget. */
  inspectUpgrade?(key: string, row: GetResult, client: DeliveryClient, beforeCall: () => void): Promise<void>
  /** Ask AD's shared sweep to publish a provisional Claude transcript reference. */
  refreshTranscript?(key: string, client: DeliveryClient, beforeCall: () => void): Promise<boolean>
  onReadError?(key: string, error: unknown, verb: 'get'): Promise<void>
  onError?(key: string, error: unknown): void
  onEvent?(event: DeliveryEngineEvent): void
  onKeyError?(key: string, error: unknown, row: GetResult): Promise<void>
  isRestartPendingOrActive(key: string): boolean
  scheduleRestart(key: string, cwd: string): void
  /** Hand actual AD GONE evidence to checked recovery; true transfers ownership. */
  recoverGone?(key: string, row: GetResult): boolean
  /** A fresh get found no row after GONE; true transfers to ordinary recovery. */
  recoverAbsent?(key: string): boolean
  reconnect(key: string, client: DeliveryClient, beforeCall: () => void): Promise<void>
  receiptReader?(): DeliveryReceiptReader
  clock?: DeliveryClock
  /** Optional bounded replay constants. Production never caps retypes. */
  constants?: Partial<{ ENTER_DELAY_MS: number; RECEIPT_WAIT_MS: number; RETYPE_BACKOFF_MS: readonly number[]; NOT_NOW_RETRY_MS: readonly number[]; MaxRetypes: number }>
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
/** First position with an item number at least `seq`. Appends to these ordered
 * summaries are constant work; a changed item never rereads its neighbours. */
function itemPosition<T>(values: readonly T[], seq: number, itemOf: (value: T) => number): number {
  if (!values.length || itemOf(values[values.length - 1]!) < seq) return values.length
  let lo = 0, hi = values.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (itemOf(values[mid]!) < seq) lo = mid + 1; else hi = mid }
  return lo
}
function replaceItemRange<T>(values: T[], seq: number, replacements: T[], itemOf: (value: T) => number) {
  const start = itemPosition(values, seq, itemOf), end = itemPosition(values, seq + 1, itemOf)
  // Insert in slices: a long retype history must not overflow argument limits.
  if (end > start) values.splice(start, end - start)
  for (let at = 0; at < replacements.length; at += 1024) values.splice(start + at, 0, ...replacements.slice(at, at + 1024))
  return { start, end, delta: replacements.length - (end - start) }
}
function setItemMember(values: number[], seq: number, present: boolean): void {
  const at = itemPosition(values, seq, n => n)
  if (values[at] === seq) { if (!present) values.splice(at, 1) }
  else if (present) values.splice(at, 0, seq)
}
function createQueueSummary(queue: DeliveryQueue, key: string) {
  const read = createQueueItemReader(queue, key)
  const items = new Map<number, QueueItem>(), open: number[] = []
  const p = { accepted: [] as number[], fixed: [] as number[], sent: [] as DeliveryPolicyKnowledge['p']['sent'][number][], refused: [] as number[], delivered: [] as DeliveryPair[] }
  const parts: Record<number, number> = {}, holds: { item: number; kind: 'memory' | 'post' }[] = []
  // Immutable between membership changes, so a new executor can inherit the
  // durable notices without copying a queue-sized list on every blocked wake.
  let notices: number[] = []
  function update(item: QueueItem): boolean {
    const seq = item.accepted.seq, included = item.hold?.state !== 'withdrawn'
    items.set(seq, item)
    setItemMember(open, seq, isOpenItem(item))
    setItemMember(p.accepted, seq, included)
    setItemMember(p.fixed, seq, included && !!item.fixed)
    if (included) parts[seq] = item.fixed?.parts.length ?? 1; else delete parts[seq]
    const sends: typeof p.sent = [], refused: number[] = [], delivered: DeliveryPair[] = []
    let noticed = false
    if (included) {
      const noKeys = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
      for (const r of item.records) {
        if (r.kind === 'sent') {
          const part = 'part' in r ? r.part : Array.from({ length: parts[seq]! }, (_, n) => n + 1).find(part => !item.records.some(record => record.kind === 'delivered' && record.part === part)) ?? 1
          sends.push({ item: seq, part, offset: 0, how: 'send_kind' in r ? r.send_kind : 'unknown', attempt: r.attempt })
          if (noKeys.has(r.attempt)) refused.push(sends.length)
        } else if (r.kind === 'delivered') delivered.push([r.seq, r.part])
        else if (r.kind === 'noticed') noticed = true
      }
    }
    const range = replaceItemRange(p.sent, seq, sends, send => send.item)
    const first = itemPosition(p.refused, range.start + 1, n => n), last = itemPosition(p.refused, range.end + 1, n => n)
    p.refused.splice(first, last - first)
    if (range.delta) for (let at = first; at < p.refused.length; at++) p.refused[at]! += range.delta
    for (let at = 0; at < refused.length; at++) p.refused.splice(first + at, 0, range.start + refused[at]!)
    replaceItemRange(p.delivered, seq, delivered, pair => pair[0])
    replaceItemRange(holds, seq, item.hold?.state === 'unresolved' ? [{ item: seq, kind: item.hold.kind }] : [], hold => hold.item)
    const noticeAt = itemPosition(notices, seq, n => n)
    if ((notices[noticeAt] === seq) !== noticed) {
      notices = [...notices]
      setItemMember(notices, seq, noticed)
    }
    return noticed
  }
  function refresh(): number[] {
    const changed = read()
    if (changed.reset) {
      items.clear(); open.length = 0
      for (const values of Object.values(p)) values.length = 0
      for (const seq of Object.keys(parts)) delete parts[Number(seq)]
      holds.length = 0; notices = []
    }
    const noticed: number[] = []
    for (const item of changed.items.sort((a, b) => a.accepted.seq - b.accepted.seq)) if (update(item)) noticed.push(item.accepted.seq)
    return noticed
  }
  let previousReceiptItem: number | undefined
  function receiptOffsets(target: DeliveryPair | undefined, attempt: number, offset: number): void {
    // Only sends for the old/new receipt item can change their window.
    for (const seq of new Set([previousReceiptItem, target?.[0]])) {
      if (seq === undefined) continue
      for (let at = itemPosition(p.sent, seq, send => send.item); p.sent[at]?.item === seq; at++) {
        const send = p.sent[at]!
        send.offset = target?.[0] === seq && target[1] === send.part && send.attempt! > attempt ? offset : 0
      }
    }
    previousReceiptItem = target?.[0]
  }
  return { p, parts, holds, items, open, refresh, receiptOffsets, get notices() { return notices } }
}
export function createDeliveryEngines(deps: DeliveryEngineDeps): DeliveryEngines {
  const clock = deps.clock ?? systemDeliveryClock, life = deps.lifecycle, constants = deps.constants
  const ms = (name: 'ENTER_DELAY_MS' | 'RECEIPT_WAIT_MS', fallback: number): number => constants?.[name] ?? fallback
  interface State {
    queue: ReturnType<typeof createQueueSummary>; noticesInitialized: boolean
    e: DeliveryPolicyEngine; reading: DeliveryReading; row?: GetResult; receipt?: ReceiptObservation
    reader: DeliveryReceiptReader; receiptTarget?: DeliveryPair; receiptAttempt?: number; deadlines: Partial<Record<DeliveryTimer, number>>; budget: () => void
    rowAt: number; notNowStep: number; retryStep: number; appendRetryStep: number; lastSeq?: number; lastPart?: number; transcriptReference?: string
    pending?: { record: QueueRecord; complete(): void }; lease?: () => void; timer?: unknown; busy?: Promise<void>; stopped: boolean
    relaunch: boolean; restarted?: boolean; gone?: { row: GetResult; handedOff?: boolean }; receiptWorking: boolean; pollAfter: number; snapshot?: DeliveryPolicyKnowledge; lastRetypeEvent?: number; dialogHold: boolean; dialogMaybeOpen: boolean; recoveringReconnect?: boolean
  }
  const states = new Map<string, State>(), budgets = new Map<string, () => void>()
  // Blocked/empty executors retire without polling. Their queue-derived facts
  // and change cursor live until persona teardown; rebuilds invalidate the
  // cursor inside createQueueItemReader, including while no executor is active.
  const summaries = new Map<string, ReturnType<typeof createQueueSummary>>()
  let stopped = false
  const typed = new Set<string>()
  function emit(event: DeliveryEngineEvent): void { try { void Promise.resolve(deps.onEvent?.(event)).catch(() => {}) } catch {} }
  function budget(key: string): () => void { let b = budgets.get(key); if (!b) { b = createDeliveryCallBudget(clock.now); budgets.set(key, b) }; return b }
  function create(key: string): State {
    let queue = summaries.get(key)
    if (!queue) { queue = createQueueSummary(deps.queue, key); summaries.set(key, queue) }
    queue.receiptOffsets(undefined, 0, 0)
    const s: State = { queue, noticesInitialized: false, e: createDeliveryPolicyState(), reading: createDeliveryReading(), reader: deps.receiptReader?.() ?? createQueueDeliveryReceiptReader(deps.queue, key), deadlines: {}, budget: budget(key), rowAt: -Infinity, notNowStep: 0, retryStep: 0, appendRetryStep: 0, stopped: false, relaunch: true, receiptWorking: false, pollAfter: 0, dialogHold: false, dialogMaybeOpen: false }
    states.set(key, s); life.engineRunning(key, true); return s
  }
  function release(s: State): void { s.lease?.(); s.lease = undefined; s.e.request = 'none' }
  function timers(s: State): void { for (const name of Object.keys(s.e.timers) as DeliveryTimer[]) s.e.timers[name] = Math.max(0, (s.deadlines[name] ?? 0) - clock.now()) }
  function refreshQueue(s: State): void {
    const noticed = s.queue.refresh()
    if (!s.noticesInitialized) { s.e.noticed = s.queue.notices; s.noticesInitialized = true }
    else if (noticed.length) s.e.noticed = [...new Set([...s.e.noticed, ...noticed])]
  }
  function status(key: string, s: State): DeliveryStatus | undefined {
    refreshQueue(s)
    const head = s.queue.items.get(s.queue.open[0]!)
    if (!head) return undefined
    const deferred = life.deferred(key)
    return { key, seq: head.accepted.seq, count: s.queue.open.length, ageMs: Math.max(0, clock.now() - itemOpenedAt(head)), retypeCount: head.retypeCount,
      row: s.restarted === true ? (s.row?.state === 'ended' || s.row?.state === 'missing' ? s.row.state : 'absent') : s.row?.state, marker: s.row?.labels?.tag_prompt === '1', relay: s.row?.relay_mode === 'on', connected: deps.isConnected(key), up: deps.isUp(key),
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
      // this fresh own-row get already proves the current
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
      return true
    } catch (error) {
      if (error instanceof DeliveryBudgetWait) throw error
      await deps.onReadError?.(key, error, 'get')
      deps.onError?.(key, error)
      if (isAdErrorInstance(error, ErrSpawnNotFound)) {
        const gone = s.gone
        life.observeRow(key, { state: 'missing' })
        life.clearDeferred(key)
        if (gone && deps.recoverAbsent) {
          // Absence supersedes the old live-row evidence. Transfer to the
          // ordinary retry owner, which reads AD again before any launch;
          // never kill a replacement using this retained row.
          if (canHandoffGone(key, s) && deps.recoverAbsent(key)) s.gone = undefined
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
    if (gone.handedOff && !retry) return
    if (!canHandoffGone(key, s)) return
    // The sequence runs detached. Awaiting it here could join this engine
    // again at its launch/reconnect or while teardown waits for this tick.
    if (deps.recoverGone?.(key, gone.row)) { gone.handedOff = true; life.clearDeferred(key) }
  }
  async function refreshGone(key: string, s: State, retry = false): Promise<void> {
    const gone = s.gone
    if (!gone) return
    if ((gone.handedOff && !retry) || !canHandoffGone(key, s)) return
    // A hold or refused sequence can outlive this AD life. Re-read even
    // inside the row cache window before using its old GONE evidence.
    const fresh = await readRow(key, s, true), row = s.row
    if (s.gone !== gone) return
    if ((row && (row.session_id !== gone.row.session_id || row.launch_started_at !== gone.row.launch_started_at))) {
      s.gone = undefined; s.restarted = false; return
    }
    if (fresh && row) { gone.row = row; handoffGone(key, s, retry) }
  }
  function restart(key: string, s: State, goneRow?: GetResult): void {
    const p = deps.persona(key)
    if (!p || s.restarted) return
    // GONE bars every further key in this launch, including when someone
    // else already scheduled its restart.
    s.restarted = true; release(s)
    if (goneRow && deps.recoverGone) {
      s.gone = { row: goneRow }
      handoffGone(key, s)
      return
    }
    if (!deps.isRestartPendingOrActive(key)) deps.scheduleRestart(key, p.cwd)
  }
  function build(key: string, s: State): DeliveryPolicyKnowledge {
    timers(s)
    s.e.appendBlocked = !!s.pending && s.e.appendBlocked || deps.queue.isWritable?.(key) === false
    refreshQueue(s)
    s.queue.receiptOffsets(s.receiptTarget, s.receiptAttempt ?? 0, s.reading.records.length)
    if (deps.isConnected(key) && !life.reconnectInput(key)) life.clearDeferred(key)
    const deferred = life.deferred(key)
    s.reading = { ...s.reading, gate: life.owner(key), up: deps.isUp(key) && !!deps.persona(key), latched: deps.isLatched(key), held: deps.isHeld(key) || s.restarted === true, mcp: deps.isConnected(key), relaunch: s.relaunch }
    const k: DeliveryPolicyKnowledge = { p: s.queue.p, e: s.e, r: s.reading, g: { owner: life.owner(key), stage: 'none', deferred: !!deferred, due: deferred?.due ?? false }, writer: { kind: s.pending?.record.kind ?? 'none' }, compact: 'none', parts: s.queue.parts, holds: s.queue.holds, MaxRetypes: constants?.MaxRetypes, textFor: pair => s.queue.parts[pair[0]] === undefined ? pair : s.queue.items.get(pair[0])?.fixed?.parts[pair[1] - 1] ?? pair }
    if (s.pending) k.writer.item = s.pending.record.seq
    s.snapshot = k; return k
  }
  async function observe(key: string, s: State, head: QueueItem, part: number, force = false): Promise<boolean> {
    if (!await readRow(key, s, force) || !s.row) return false
    const persona = deps.persona(key)
    const agentOf = (row: GetResult): DeliveryAgent => row.agent === 'codex' ? 'codex' : persona?.agent ?? 'claude'
    let row = s.row
    const readReceipt = () => s.reader.read(agentOf(row), row, head, part, deps.receiptReader ? deps.queue.items(key) : undefined)
    let receipt = readReceipt()
    // Claude's SessionStart can precede its first transcript write. AD keeps
    // that reference empty until find-missing heals it; get alone cannot.
    // Keep receipts from recorded/prior paths usable without a sweep. Only
    // reconcile after a durable attempt, never before the first input.
    if (!receipt.receipt && deps.refreshTranscript && row.agent === 'claude' && !row.jsonl_path && row.session_id &&
      row.instance_id === deps.instanceId(key) && !['pending', 'ended', 'missing'].includes(row.state) &&
      (head.unknownSend || effectiveSends(head, part).length > 0)) {
      const client = await deps.clientFor(key)
      if (stopped || s.stopped || !life.active(key) || !deps.isUp(key) || deps.isLatched(key) || deps.isHeld(key)) return false
      if (!await deps.refreshTranscript(key, client, s.budget)) return false
      if (stopped || s.stopped || !life.active(key) || !deps.isUp(key) || deps.isLatched(key) || deps.isHeld(key)) return false
      if (!await readRow(key, s, true) || !s.row) return false
      row = s.row
      receipt = readReceipt()
    }
    // Preserve an AD binding absent from an earlier durable attempt.
    // This is reference evidence, independent of whether a receipt matched.
    if (row.instance_id === deps.instanceId(key) && row.jsonl_path && row.session_id &&
      s.transcriptReference !== row.jsonl_path && effectiveSends(head, part).some(send => send.transcript_path !== row.jsonl_path)) {
      s.transcriptReference = row.jsonl_path
      emit({ type: 'transcript-reference', key, instanceId: row.instance_id, sessionId: row.session_id, path: row.jsonl_path, at: clock.now() })
    }
    s.receipt = receipt
    s.receiptTarget = [head.accepted.seq, part]; s.receiptAttempt = effectiveSends(head, part).at(-1)?.attempt ?? 0
    const text = head.fixed?.parts[part - 1]
    const records = [
      ...(receipt.receipt ? [{ kind: 'take-in', text }] : []),
    ]
    s.reading = { row: row.state, relay: row.relay_mode === 'on', marker: row.labels?.tag_prompt === '1', mcp: deps.isConnected(key), up: deps.isUp(key), latched: deps.isLatched(key), held: deps.isHeld(key), readable: receipt.availability !== 'unreadable', receipts: receipt.receipt ? [records.length] : [], relaunch: s.relaunch, session: row.session_id, gate: life.owner(key), offset: 0, records }
    if (s.restarted === true) s.reading.held = true
    return true
  }
  // A durable append or the text-to-Enter pause may outlive its gate read.
  // Revalidate AD's row and CSCB's lifecycle guards before each unused key.
  async function revalidateKeys(key: string, s: State): Promise<boolean> {
    const fresh = await readRow(key, s, true), row = s.row
    const allowed = fresh && row && life.owner(key) === 'delivery' &&
      !s.relaunch && row.session_id === s.e.sessionSeen &&
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
  function queueRefusal(key: string, s: State): void {
    const [seq] = s.e.target, attempt = s.e.attempt
    queueWrite(s, { v: 1, kind: 'refused', seq, attempt, at: clock.now() }, () => {
      const refused = deps.queue.item(key, seq)?.records.find(r => r.kind === 'sent' && r.attempt === attempt)
      if (refused?.kind === 'sent' && 'send_kind' in refused && refused.send_kind === 'retype') { s.e.retypes[seq] = Math.max(0, (s.e.retypes[seq] ?? 0) - 1); s.retryStep = Math.max(0, s.retryStep - 1) }
      s.e.phase = 'ready'; s.e.request = 'none'; release(s)
    })
  }
  function afterSend(s: State, key: string, sent: SentRecord): void {
    s.e.phase = 'receipt'; s.e.request = 'none'
    const at = clock.now()
    s.deadlines.receipt = at + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS)
    const backoff = constants?.RETYPE_BACKOFF_MS ?? RETYPE_BACKOFF_MS
    s.deadlines.backoff = at + backoff[Math.min(s.retryStep, backoff.length - 1)]!
    if (sent.send_kind === 'retype' && s.lastRetypeEvent !== sent.attempt) { s.lastRetypeEvent = sent.attempt; emit({ type: 'retyped', key, seq: sent.seq, part: sent.part, count: deps.queue.item(key, sent.seq)?.retypeCount ?? s.e.retypes[sent.seq] ?? 0 }) }
  }
  async function keyError(key: string, s: State, error: unknown, textCall: boolean): Promise<void> {
    if (error instanceof DeliveryBudgetWait) throw error
    const row = s.row!
    await deps.onKeyError?.(key, error, row)
    if (isAdErrorInstance(error, ErrInvalidFlags) && !deps.onKeyError) await classifyWithInvalidFlagsRecheck(error)
    if (isAdErrorInstance(error, ErrSpawnNotInteractive) || isAdErrorInstance(error, ErrSpawnNotFound)) {
      if (await readRow(key, s, true)) {
        if (s.row?.state === 'ended' || s.row?.state === 'missing') restart(key, s)
      }
    } else if (classifyAdError(error).errorClass === 'GONE' && !s.relaunch) restart(key, s, row)
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
    else { const sent = effectiveSends(deps.queue.item(key, s.e.target[0])!, s.e.target[1]).at(-1); if (sent) afterSend(s, key, sent); s.e.phase = 'receipt'; s.e.request = 'none'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS) }
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
        let k = build(key, s), pair = selectDeliveryTarget(k), part = pair[1]
        const target = deps.queue.item(key, pair[0])
        const head = target && isOpenItem(target) ? target : undefined
        if (!head && !s.pending) {
          release(s); states.delete(key); life.engineRunning(key, false); return
        }
        if (!s.pending && (!deps.isUp(key) || deps.isLatched(key) || deps.isHeld(key))) { release(s); wait(key, s, 'held'); break }
        if (!s.pending && deps.queue.isWritable?.(key) === false) { release(s); wait(key, s, 'queue-unwritable'); nextDelay = RETYPE_BACKOFF_MS[0]; break }
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
          if (selectDeliveryTarget(k).some((value, i) => value !== pair[i])) { release(s); continue }
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
          if (s.e.phase === 'refused') { queueRefusal(key, s); continue }
          release(s); s.e.phase = 'ready'; s.e.sessionSeen = k.r.session
          s.relaunch = false; s.receiptWorking = false
          s.e.recoveryAttempt = undefined
          s.e.retypes = {}; s.dialogHold = false; s.dialogMaybeOpen = false; s.retryStep = 0; s.notNowStep = 0
          s.deadlines.backoff = 0; s.deadlines.notNow = 0; s.deadlines.enterDelay = 0
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
            const item = deps.queue.item(key, pair[0])
            if (item?.delivered) emit({ type: 'item-delivered', key, seq: pair[0], at: clock.now(), waitMs: Math.max(0, clock.now() - itemOpenedAt(item)) })
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
          if (selectDeliveryTarget(gateKnowledge).some((value, i) => value !== pair[i])) { release(s); continue }
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
          const sent: SentRecord = { v: 1, kind: 'sent', seq: pair[0], part, attempt: head!.nextAttempt, send_kind: kind, at: clock.now(), session_id: s.row!.session_id, transcript_path: s.receipt?.path ?? '', transcript_size: s.receipt?.size ?? 0 }
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
          const sentItem = deps.queue.item(key, s.e.target[0]) ?? head!
          const sent = effectiveSends(sentItem, s.e.target[1]).at(-1)
          if (sent) afterSend(s, key, sent)
          else { s.e.phase = 'receipt'; s.deadlines.receipt = clock.now() + ms('RECEIPT_WAIT_MS', RECEIPT_WAIT_MS) }
          break
        }
        if (action === 'recordRefusal') {
          queueRefusal(key, s); continue
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
          const reason: DeliveryReason = s.dialogHold ? 'dialog-hold' : r.held || r.latched ? 'held' : !r.marker ? 'marker' : !r.relay ? 'relay-off' : r.row !== 'waiting' ? 'state' : !r.mcp ? 'mcp' : s.receipt?.availability === 'unreadable' ? 'transcript-unreadable' : 'backoff'
          wait(key, s, reason); if (reason === 'marker') emit({ type: 'marker-missing', key })
        }
        const due = Object.values(s.deadlines).filter(t => Number.isFinite(t) && t > clock.now()).map(t => t - clock.now())
        nextDelay = Math.min(DELIVERY_ROW_POLL_MS, ...due)
        break
      }
    } catch (error) {
      if (error instanceof DeliveryBudgetWait) { release(s); nextDelay = error.delayMs }
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
      // Recovery may expose retained work while its journal replacement is
      // still pending. Reconnect owns a retry even when there is no open head;
      // neither an empty queue nor AD waiting authorizes keys before repair.
      if (deps.queue.isWritable?.(key) === false) {
        try { await deps.queue.compact(key) } catch { return false }
        if (deps.queue.isWritable?.(key) === false) return false
      }
      const open = deps.queue.items(key).filter(isOpenItem)
      const head = open.find(i => i.unknownSend || i.records.some(r => r.kind === 'sent' && !i.records.some(refusal => refusal.kind === 'refused' && refusal.attempt === r.attempt))) ?? open[0]
      if (!head || (!head.unknownSend && !head.records.some(r => r.kind === 'sent'))) return true
      api.wake(key)
      const s = states.get(key)!
      const reconciled = (): boolean => {
        // Retained GONE must be freshly reconciled by the serialized tick
        // before reconnect may type or retry the checked sequence.
        if (s.gone || deps.queue.isWritable?.(key) === false) return false
        const k = build(key, s), pair = selectDeliveryTarget(k)
        if (pair[0] === 0) return true
        const attempt = latestDeliveryAttempt(k, pair)
        // A failed read can release the lease before the receipt wait ends.
        // Let the engine finish that wait, including a working-row extension.
        return !s.pending && life.owner(key) !== 'delivery' && (attempt === undefined ||
          (s.e.phase === 'ready' && !s.receiptWorking && !s.relaunch &&
            s.e.sessionSeen === s.row?.session_id && s.e.recoveryAttempt === attempt))
      }
      // A reconnect rerun from this engine cannot wait on its own tick.
      if (s.busy) return reconciled()
      s.recoveringReconnect = true
      try { await api.tick(key) } finally { s.recoveringReconnect = false }
      return reconciled()
    },
    async forget(key) {
      const s = states.get(key)
      if (s) { s.stopped = true; if (s.timer !== undefined) clock.clearTimeout(s.timer); release(s); await s.busy; states.delete(key); life.engineRunning(key, false) }
      summaries.delete(key); life.forget(key)
    },
    async stop() { stopped = true; const stoppingLife = life.stop(); for (const [key, s] of states) { s.stopped = true; if (s.timer !== undefined) clock.clearTimeout(s.timer); release(s); life.engineRunning(key, false) }; await Promise.allSettled([...states.values()].flatMap(s => s.busy ? [s.busy] : [])); await stoppingLife; states.clear(); summaries.clear() },
    running: key => states.has(key),
    snapshot(key) {
      const s = states.get(key), k = s?.snapshot
      if (!s || !k) return undefined
      // Diagnostic callers retain independent policy inputs. Only the engine's
      // private summaries are updated in place between synchronous decisions.
      const items = new Map(s.queue.items), parts = { ...k.parts }
      return { ...k, parts, p: { accepted: [...k.p.accepted], fixed: [...k.p.fixed], sent: k.p.sent.map(send => ({ ...send })), refused: [...k.p.refused], delivered: k.p.delivered.map(pair => [pair[0], pair[1]] as const) }, holds: k.holds?.map(hold => ({ ...hold })),
        textFor: pair => parts[pair[0]] === undefined ? pair : items.get(pair[0])?.fixed?.parts[pair[1] - 1] ?? pair }
    },
    status: key => { const s = states.get(key); return s ? status(key, s) : undefined },
  }
  life.setRelaunchObserver((key, row) => {
    const s = states.get(key)
    if (s) {
      s.relaunch = true
      if (row.state === 'pending' || (row.session_id !== undefined && row.session_id !== s.gone?.row.session_id)) s.gone = undefined
      s.restarted = !!s.gone
      if (!s.busy) { release(s); schedule(key, s, 1) }
    }
    emit({ type: 'launch-observed', key, sessionId: row.session_id ?? '', at: clock.now() })
  })
  life.setFirstWaitingObserver((key, row) => {
    const s = states.get(key)
    if (s) { s.restarted = false; s.gone = undefined }
    emit({ type: 'launch-first-waiting', key, sessionId: row.session_id ?? '', at: clock.now() })
  })
  life.setRecovery(api.recoverBeforeReconnect)
  life.setReconnect(async key => {
    if (stopped || !deps.persona(key) || (deps.isConnected(key) && !life.reconnectInput(key))) { life.clearDeferred(key); return }
    // only the latch re-check may call
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
