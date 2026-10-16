/** The production engine and gate's I/O-free choices (b.omv SR-1.2/15.6).
 * Observations are values: receipt records and saved key readings are never
 * replaced with a newer environment while an owned operation completes. */
export const ENGINE_ACTIONS = ['expireTimers', 'commitAppend', 'observeLaunch', 'observeCompaction', 'readReceipt', 'fixText', 'recordSend', 'typeText', 'pressEnter', 'recordRefusal', 'recordEnterRetry', 'retryEnter', 'releaseAttempt', 'requestGate', 'deferReconnect', 'recordNotice', 'leftoverEnter', 'stopAbsent', 'compactQueueRename', 'compactQueueFinish', 'ignoreDuplicate'] as const
export type EngineAction = typeof ENGINE_ACTIONS[number] | 'wait'
export type GateAction = 'grantDelivery' | 'cancelRequest' | 'release' | 'runReconnect' | 'wait'
export type DeliveryPair = readonly [number, number]
export const NO_DELIVERY_PAIR: DeliveryPair = [0, 0]
export type DeliveryTimer = 'settle' | 'receipt' | 'backoff' | 'idleEvidence' | 'enterDelay' | 'notNow' | 'reconnect'
export type PolicyTimers = Record<DeliveryTimer, number>
export interface PolicySend { item: number; part: number; offset: number; how?: string }
export interface PolicyRecord { kind: string; text: unknown }
export interface DeliveryReading {
  row: string; screen: string; box: unknown; relay: boolean; marker: boolean; mcp: boolean
  up: boolean; latched: boolean; held: boolean; readable: boolean; receipts: readonly number[]
  idleEvidence: boolean; launch: string | number; session: string | number; compactions: string | number
  gate: string; offset: number; records: readonly PolicyRecord[]
}
export interface DeliveryPolicyEngine {
  phase: string; target: DeliveryPair; attempt: number; launchSeen: string | number; sessionSeen: string | number
  compactionSeen: string | number; enterRetries: number; retypes: Record<number, number>; timers: PolicyTimers
  restartCheck: boolean; lastDelivered: DeliveryPair; appendBlocked: boolean; noticed: readonly number[]; request: string
  keyReading: DeliveryReading
}
export interface DeliveryPolicyKnowledge {
  p: { accepted: readonly number[]; fixed: readonly number[]; sent: readonly PolicySend[]; refused: readonly number[]; delivered: readonly DeliveryPair[] }
  e: DeliveryPolicyEngine; r: DeliveryReading
  g: { owner: string; stage: string; deferred: boolean; due: boolean; typed?: boolean; reading?: DeliveryReading }
  writer: { kind: string; how?: string; item?: number }; compact: string; acked?: readonly number[]
  /** Real queues have variable part counts; bounded replay injects MaxParts. */
  parts?: Readonly<Record<number, number>>; MaxParts?: number; EnterRetries?: number; MaxRetypes?: number
  textFor?: (pair: DeliveryPair) => unknown
}
export function sameDeliveryText(a: unknown, b: unknown): boolean {
  return a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]))
}
export function hasDeliveryPair(pairs: readonly DeliveryPair[], pair: DeliveryPair): boolean { return pairs.some(p => p[0] === pair[0] && p[1] === pair[1]) }
export function selectDeliveryTarget(k: DeliveryPolicyKnowledge): DeliveryPair {
  for (const item of [...k.p.accepted].sort((a, b) => a - b)) {
    const count = k.parts?.[item] ?? (item === 1 ? k.MaxParts ?? 1 : 1)
    for (let part = 1; part <= count; part++) if (!hasDeliveryPair(k.p.delivered, [item, part])) return [item, part]
  }
  return NO_DELIVERY_PAIR
}
const textOf = (k: DeliveryPolicyKnowledge, pair: DeliveryPair): unknown => k.textFor?.(pair) ?? pair
function made(k: DeliveryPolicyKnowledge, pair: DeliveryPair): number[] {
  return k.p.sent.flatMap((s, index) => s.item === pair[0] && s.part === pair[1] && !k.p.refused.includes(index + 1) ? [index] : [])
}
export function policyOwnText(k: DeliveryPolicyKnowledge, pair: DeliveryPair): boolean {
  const box = Array.isArray(k.r.box) && k.r.box.length === 2 ? textOf(k, k.r.box as unknown as DeliveryPair) : k.r.box
  return k.r.screen === 'item' && sameDeliveryText(box, textOf(k, pair))
}
export function policyNotTakenIn(k: DeliveryPolicyKnowledge, pair: DeliveryPair): boolean {
  const sends = made(k, pair), last = sends.at(-1)
  if (last === undefined) return false
  const offset = k.p.sent[last]!.offset
  return k.r.records.some((r, n) => n + 1 > offset && sameDeliveryText(r.text, textOf(k, pair)) && ['queue-operation:remove:dropped_by_hook', 'queue-operation:remove:cleared_on_cancel', 'queue-operation:remove:not_carried_to_background', 'queue-operation:remove:agent_stopped', 'queue-operation:remove:resume_failed', 'queue-operation:popAll', 'queue-operation:popOne'].includes(r.kind))
}
export function policyReceipt(k: DeliveryPolicyKnowledge, pair: DeliveryPair): number | undefined {
  const first = made(k, pair)[0]
  if (first === undefined) return undefined
  return k.r.receipts.find(n => n > k.p.sent[first]!.offset && k.r.records[n - 1]?.kind === 'take-in' && sameDeliveryText(k.r.records[n - 1]?.text, textOf(k, pair)))
}
export function firstSendGate(r: DeliveryReading, e: DeliveryPolicyEngine): boolean {
  return r.up && !r.latched && !r.held && r.marker && r.relay && r.mcp && ['waiting', 'working'].includes(r.row) && ['empty', 'running'].includes(r.screen) && e.timers.settle === 0
}
export function retypeGate(r: DeliveryReading, e: DeliveryPolicyEngine): boolean {
  return firstSendGate(r, e) && r.row === 'waiting' && r.screen === 'empty' && r.receipts.length === 0 && e.timers.backoff === 0 && (r.idleEvidence || e.timers.idleEvidence === 0)
}
export function reconnectGate(r: DeliveryReading): boolean {
  return r.up && !r.latched && !r.held && r.relay && r.marker && r.screen === 'empty' && (r.row === 'waiting' || (r.row === 'working' && r.idleEvidence))
}
export function decideEngine(k: DeliveryPolicyKnowledge): EngineAction {
  const ip = selectDeliveryTarget(k), e = k.e, r = k.r, hasTarget = ip[0] !== 0, retype = hasTarget && made(k, ip).length > 0
  if (k.compact === 'prepared') return 'compactQueueRename'
  if (k.writer.kind === 'accepted' && k.writer.how === 'slack-redelivery') return 'ignoreDuplicate'
  if (k.compact === 'renamed') return 'compactQueueFinish'
  if (k.writer.kind !== 'none') return !e.appendBlocked || e.timers.backoff === 0 ? 'commitAppend' : 'expireTimers'
  if (!r.up) return 'stopAbsent'
  if (r.launch !== e.launchSeen || r.session !== e.sessionSeen) return 'observeLaunch'
  if (r.compactions !== e.compactionSeen) return 'observeCompaction'
  if (e.phase === 'text') return r.gate === 'delivery' ? 'typeText' : r.gate === 'free' ? 'requestGate' : 'wait'
  if (['enter', 'retry'].includes(e.phase) && policyNotTakenIn(k, e.target)) return 'releaseAttempt'
  if (e.phase === 'enter' && e.timers.enterDelay === 0) return r.gate === 'delivery' ? 'pressEnter' : r.gate === 'free' ? 'requestGate' : 'wait'
  if (e.phase === 'retry' && e.timers.enterDelay === 0) return r.gate === 'delivery' ? 'retryEnter' : r.gate === 'free' ? 'requestGate' : 'wait'
  if (e.phase === 'refused') return 'recordRefusal'
  if (hasTarget && policyReceipt(k, ip) !== undefined) return 'readReceipt'
  if (e.phase === 'receipt' && e.timers.receipt === 0) return 'releaseAttempt'
  if (e.phase === 'ready' && e.lastDelivered[0] !== 0 && policyOwnText(k, e.lastDelivered) && !policyNotTakenIn(k, e.lastDelivered) && ['waiting', 'working'].includes(r.row) && ['free', 'delivery'].includes(r.gate)) return r.gate === 'free' ? 'requestGate' : 'leftoverEnter'
  if (hasTarget && !k.p.fixed.includes(ip[0])) return 'fixText'
  if (hasTarget && e.phase === 'ready' && ['waiting', 'working'].includes(r.row) && policyOwnText(k, ip) && e.enterRetries < (k.EnterRetries ?? Infinity) && !policyNotTakenIn(k, ip) && e.timers.enterDelay === 0 && ['free', 'delivery'].includes(r.gate)) return r.gate === 'free' ? 'requestGate' : 'recordEnterRetry'
  if (k.g.deferred && !r.mcp && k.g.due && r.gate === 'free') return 'deferReconnect'
  if (hasTarget && e.phase === 'ready' && e.timers.notNow === 0 && (retype ? retypeGate(r, e) : firstSendGate(r, e)) && (!retype || (e.retypes[ip[0]] ?? 0) < (k.MaxRetypes ?? Infinity))) return r.gate === 'delivery' ? 'recordSend' : 'requestGate'
  if (hasTarget && retype && (e.retypes[ip[0]] ?? 0) >= 1 && !e.noticed.includes(ip[0])) return 'recordNotice'
  if (Object.values(e.timers).some(t => t > 0)) return 'expireTimers'
  return 'wait'
}
export function decideGate(k: DeliveryPolicyKnowledge): GateAction {
  const needed = k.e.request === 'granted' || ['text', 'enter', 'retry', 'receipt'].includes(k.e.phase) || k.writer.kind === 'sent'
  const blocked = k.e.appendBlocked || !k.r.up || k.r.latched || k.r.held
  if (k.g.owner === 'delivery' && blocked) return 'release'
  if (k.g.owner === 'delivery' && !needed) return 'release'
  if (k.g.owner === 'free' && k.e.request === 'delivery') {
    const operation = decideEngine({ ...k, r: { ...k.r, gate: 'delivery' } })
    return (needed || ['recordSend', 'recordEnterRetry', 'leftoverEnter'].includes(operation)) && !blocked ? 'grantDelivery' : 'cancelRequest'
  }
  if (k.g.owner === 'reconnect' && k.g.stage === 'done') return 'release'
  if (k.g.owner === 'free' && k.g.deferred && k.g.due && !k.r.mcp && reconnectGate(k.r)) return 'runReconnect'
  return 'wait'
}

export function createDeliveryReading(): DeliveryReading { return { row: 'missing', screen: 'menu', box: NO_DELIVERY_PAIR, relay: false, marker: false, mcp: false, up: false, latched: false, held: false, readable: true, receipts: [], idleEvidence: false, launch: '', session: '', compactions: '', gate: 'free', offset: 0, records: [] } }
export function createDeliveryPolicyState(): DeliveryPolicyEngine { return { phase: 'ready', target: NO_DELIVERY_PAIR, attempt: 0, launchSeen: '', sessionSeen: '', compactionSeen: '', enterRetries: 0, retypes: {}, timers: { settle: 0, receipt: 0, backoff: 0, idleEvidence: 0, enterDelay: 0, notNow: 0, reconnect: 0 }, restartCheck: true, lastDelivered: NO_DELIVERY_PAIR, appendBlocked: false, noticed: [], request: 'none', keyReading: createDeliveryReading() } }
