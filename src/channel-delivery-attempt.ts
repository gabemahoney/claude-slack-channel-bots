/** Logical bot attempts are metadata in the shared authority. This module
 * defines and validates evidence; it owns no persistence or runtime state. */
import { createHash } from 'node:crypto'
import { CHANNEL_ID_RE, DELIVERY_MODES, type DeliveryMode } from './config.ts'
import type { SharedChannelState, SharedPersona } from './shared-channels.ts'

export const CHANNEL_DELIVERY_INTENTS = ['assignment', 'retry'] as const
export type ChannelDeliveryIntent = typeof CHANNEL_DELIVERY_INTENTS[number]
export interface ChannelDeliveryAttemptRequest {
  attempt_id: string
  intent: ChannelDeliveryIntent
  channel: string
  delivery: DeliveryMode
}
export function validChannelDeliveryAttemptId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
export function validChannelDeliveryAttempt(value: unknown): value is ChannelDeliveryAttemptRequest {
  if (!object(value) || Object.keys(value).some(key => !['attempt_id', 'intent', 'channel', 'delivery'].includes(key))) return false
  return validChannelDeliveryAttemptId(value.attempt_id) &&
    CHANNEL_DELIVERY_INTENTS.includes(value.intent as ChannelDeliveryIntent) &&
    typeof value.channel === 'string' && CHANNEL_ID_RE.test(value.channel) &&
    DELIVERY_MODES.includes(value.delivery as DeliveryMode)
}
export interface ChannelDeliveryFacts {
  saved: DeliveryMode
  effective: DeliveryMode
}
export const BOT_ATTEMPT_REJECTIONS = ['membership', 'inactive', 'strict', 'dry-run', 'write-failed'] as const
export type BotAttemptRejection = typeof BOT_ATTEMPT_REJECTIONS[number]
export type BotAttemptAuthorization =
  | { kind: 'authorized'; facts: ChannelDeliveryFacts }
  | { kind: 'refused'; reason: BotAttemptRejection }
export interface BotAttemptBinding {
  key: string
  incarnation: string
  /** The identifier itself is never persisted or rendered. */
  identifierHash: string
  channel: string
  delivery: DeliveryMode
}
interface BotAttemptStart extends BotAttemptBinding { startedOrder: number }
export type SharedBotAttempt = BotAttemptStart & (
  | { status: 'pending' }
  | { status: 'not-applied'; resolvedOrder: number; reason: BotAttemptRejection }
  | { status: 'applied'; resolvedOrder: number; facts: ChannelDeliveryFacts; previous?: DeliveryMode }
)
export type BotAttemptResult =
  | { kind: 'applied'; historical: boolean; outcome: Extract<SharedBotAttempt, { status: 'applied' }> }
  | { kind: 'not-applied'; reason: BotAttemptRejection }
  | { kind: 'pending' | 'unresolved' | 'binding-conflict' | 'invalid' | 'inactive' }

export function botAttemptBinding(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest): BotAttemptBinding {
  return { key, incarnation, identifierHash: createHash('sha256').update(JSON.stringify(request.attempt_id)).digest('hex'),
    channel: request.channel, delivery: request.delivery }
}
export function botAttemptKey(binding: BotAttemptBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.key, binding.incarnation, binding.identifierHash])).digest('hex')
}
export function sameBotAttempt(a: BotAttemptBinding, b: BotAttemptBinding): boolean {
  return botAttemptKey(a) === botAttemptKey(b) && a.channel === b.channel && a.delivery === b.delivery
}
export function botAttemptResult(outcome: SharedBotAttempt): BotAttemptResult {
  if (outcome.status === 'applied') return { kind: 'applied', historical: true, outcome: structuredClone(outcome) }
  if (outcome.status === 'not-applied') return { kind: 'not-applied', reason: outcome.reason }
  return { kind: 'pending' }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function order(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
}
function validFacts(value: unknown, delivery: DeliveryMode): value is ChannelDeliveryFacts {
  return object(value) && Object.keys(value).length === 2 && value.saved === delivery && value.effective === delivery
}
function reserveAttemptPosition(positions: Map<number, SharedBotAttempt>, position: number, record: SharedBotAttempt): void {
  if (positions.has(position)) throw new Error('Invalid durable bot attempt order.')
  positions.set(position, record)
}
/** Bot starts and rejections write metadata only; an application writes just
 * its own assignment. Other writers may batch effects at one position, but
 * none of those transactions can also be a bot attempt transaction. Compare
 * write positions, not observed revisions or references to older assignments. */
function validateAttemptEffects(state: SharedChannelState, positions: Map<number, SharedBotAttempt>): void {
  const unrelated = (position: number) => {
    if (positions.has(position)) throw new Error('Inconsistent durable bot attempt effect.')
  }
  for (const [key, life] of Object.entries(state.personas)) {
    unrelated(life.resetOrder ?? 1)
    for (const [channel, assignment] of Object.entries(life.assignments)) {
      const record = positions.get(assignment.order)
      if (record && (record.status !== 'applied' || record.resolvedOrder !== assignment.order ||
          record.key !== key || record.incarnation !== life.incarnation || record.channel !== channel ||
          record.delivery !== assignment.delivery)) throw new Error('Inconsistent durable bot assignment effect.')
    }
    // Leave/destination boundaries refer back to these retained event orders.
    for (const event of Object.values(life.membershipEvents)) unrelated(event.order)
    for (const evidence of Object.values(life.membershipEvidence ?? {})) unrelated(evidence.recordedOrder)
    for (const conflict of Object.values(life.membershipAbsenceConflicts ?? {})) unrelated(conflict.recordedOrder)
    for (const setup of Object.values(life.installationReadiness ?? {})) unrelated(setup.order)
    if (life.membershipInventory) unrelated(life.membershipInventory.recordedOrder)
  }
  for (const retired of Object.values(state.retiredIdentities)) unrelated(retired.order)
  for (const outcome of Object.values(state.outcomes.operatorReviews?.outcomes ?? {})) unrelated(outcome.revision)
}
/** Validate both shape and relationships. Old history may outlive a leave,
 * newer assignment or retirement; it cannot describe a future/nonexistent life. */
export function validateBotAttempts(state: SharedChannelState): void {
  const records = state.outcomes.botAttempts
  if (records === undefined) return
  if (!object(records)) throw new Error('Invalid durable bot attempt history.')
  const positions = new Map<number, SharedBotAttempt>()
  for (const [id, record] of Object.entries(records)) {
    validateBotAttemptRecord(state, id, record)
    reserveAttemptPosition(positions, record.startedOrder, record)
    if (record.status !== 'pending') reserveAttemptPosition(positions, record.resolvedOrder, record)
  }
  validateAttemptEffects(state, positions)
}

/** Shared by the full reader and a scoped write of one normalized record. */
export function validateBotAttemptRecord(state: SharedChannelState, id: string, record: SharedBotAttempt): void {
  if (!object(record) || typeof record.key !== 'string' || typeof record.incarnation !== 'string' ||
      typeof record.identifierHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.identifierHash) ||
      typeof record.channel !== 'string' || !CHANNEL_ID_RE.test(record.channel) || !DELIVERY_MODES.includes(record.delivery) ||
      !order(record.startedOrder, state.revision) || id !== botAttemptKey(record)) throw new Error('Invalid durable bot attempt binding.')
  const life = Object.hasOwn(state.personas, record.key) ? state.personas[record.key] : undefined
  const active = life?.incarnation === record.incarnation
  const retired = Object.hasOwn(state.retiredIdentities, record.incarnation) ? state.retiredIdentities[record.incarnation] : undefined
  if ((!active && retired?.key !== record.key) || (active && record.startedOrder <= (life?.resetOrder ?? 1)) ||
      (!active && record.startedOrder >= retired!.order)) throw new Error('Invalid durable bot attempt incarnation.')
  const fields = ['key', 'incarnation', 'identifierHash', 'channel', 'delivery', 'startedOrder', 'status']
  if (record.status !== 'pending') {
    fields.push('resolvedOrder')
    if (!order(record.resolvedOrder, state.revision) || record.resolvedOrder <= record.startedOrder ||
        (!active && record.resolvedOrder >= retired!.order)) throw new Error('Invalid durable bot attempt order.')
  }
  if (record.status === 'applied') {
    fields.push('facts', 'previous')
    if (!validFacts(record.facts, record.delivery) || (record.previous !== undefined && !DELIVERY_MODES.includes(record.previous))) throw new Error('Invalid durable bot application facts.')
    if (active) checkBotApplication(life!, record)
  } else if (record.status === 'not-applied') {
    fields.push('reason')
    if (!BOT_ATTEMPT_REJECTIONS.includes(record.reason)) throw new Error('Invalid durable bot rejection.')
  } else if (record.status !== 'pending') throw new Error('Invalid durable bot attempt outcome.')
  if (Object.keys(record).some(field => !fields.includes(field))) throw new Error('Invalid durable bot attempt fields.')
}

interface AttemptLifeSummary {
  first: SharedBotAttempt
  last: SharedBotAttempt
  applications: Map<string, Extract<SharedBotAttempt, { status: 'applied' }>>
}
/** Built only on a full read/fallback. Scoped commits add one already validated
 * record only after durability. Summaries preserve exactly the relationships
 * the full validator reads from old attempts, without revisiting those records. */
export class BotAttemptIndex {
  private positions = new Map<number, SharedBotAttempt>()
  private lives = new Map<string, AttemptLifeSummary>()
  constructor(state: SharedChannelState) {
    for (const record of Object.values(state.outcomes.botAttempts ?? {})) this.add(record)
  }
  add(record: SharedBotAttempt): void {
    this.positions.set(record.startedOrder, record)
    if (record.status !== 'pending') this.positions.set(record.resolvedOrder, record)
    const id = JSON.stringify([record.key, record.incarnation])
    let life = this.lives.get(id)
    if (!life) this.lives.set(id, life = { first: record, last: record, applications: new Map() })
    if (record.startedOrder < life.first.startedOrder) life.first = record
    const end = (r: SharedBotAttempt) => r.status === 'pending' ? r.startedOrder : r.resolvedOrder
    if (end(record) >= end(life.last)) life.last = record
    if (record.status === 'applied') {
      const saved = life.applications.get(record.channel)
      if (!saved || saved.resolvedOrder < record.resolvedOrder) life.applications.set(record.channel, record)
    }
  }
  /** No old position can be reused by fresh scoped changes. Metadata scopes
   * also call this for a ledger that may refer to an earlier position. */
  checkPosition(position: number): void {
    if (this.positions.has(position)) throw new Error('Inconsistent durable bot attempt effect.')
  }
  check(state: SharedChannelState, key?: string): void {
    const own = key === undefined ? undefined : this.lives.get(JSON.stringify([key, state.personas[key]!.incarnation]))
    for (const summary of key === undefined ? this.lives.values() : own ? [own] : []) {
      // Shape, hashes, status and intra-record order were checked on read or
      // insertion. Only incarnation bounds and current effects can change.
      this.checkLife(state, summary)
    }
    const scoped = key === undefined ? state : { ...state, personas: { [key]: state.personas[key]! }, retiredIdentities: {}, outcomes: {} }
    validateAttemptEffects(scoped, this.positions)
  }
  private checkLife(state: SharedChannelState, summary: AttemptLifeSummary): void {
    const { first, last } = summary
    const life = Object.hasOwn(state.personas, first.key) ? state.personas[first.key] : undefined
    const active = life?.incarnation === first.incarnation
    const retired = Object.hasOwn(state.retiredIdentities, first.incarnation) ? state.retiredIdentities[first.incarnation] : undefined
    if ((!active && retired?.key !== first.key) || (active && first.startedOrder <= (life!.resetOrder ?? 1)) ||
        (!active && (last.status === 'pending' ? last.startedOrder : last.resolvedOrder) >= retired!.order)) {
      throw new Error('Invalid durable bot attempt incarnation.')
    }
    if (!active) return
    for (const record of summary.applications.values()) checkBotApplication(life!, record)
  }
}

function checkBotApplication(life: SharedPersona, record: Extract<SharedBotAttempt, { status: 'applied' }>): void {
  const assignment = life.assignments[record.channel], leave = life.leaves[record.channel]
  if (assignment ? assignment.order < record.resolvedOrder ||
      (assignment.order === record.resolvedOrder && assignment.delivery !== record.delivery) :
      !leave || leave.boundary <= record.resolvedOrder) throw new Error('Inconsistent durable bot application.')
}
