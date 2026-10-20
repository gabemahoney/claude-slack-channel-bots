/** Delivery reporting consumes durable facts and never authorizes keys (b.omv SR-8). */
import type { QueueEvent, QueueItem, DeliveryQueue, AcceptedRecord } from './delivery-queue.ts'
import type { DeliveryEngineEvent, DeliveryReason, DeliveryStatus } from './delivery-engine.ts'
import type { PersonaEpisodes } from './persona-episodes.ts'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from './conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS } from './delivery-constants.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { MESSAGE_NOT_SAVED, MESSAGE_RECEIVED, MESSAGE_DELIVERED, MESSAGE_RETYPED, MESSAGE_NOT_TAKEN_IN, DELIVERY_STUCK, QUEUE_RECORD_UNREADABLE, QUEUE_UNWRITABLE, QUEUE_KEPT, deliveryIdentity, buildDeliveryDiagnostic, queueErrorCode, type DeliveryDiagnosticClass } from './persona-diagnostics.ts'

export { DELIVERY_DIAGNOSTIC_CLASSES, MESSAGE_NOT_SAVED, MESSAGE_RECEIVED, MESSAGE_DELIVERED, MESSAGE_RETYPED, MESSAGE_NOT_TAKEN_IN, DELIVERY_STUCK, MESSAGES_WAITING, QUEUE_RECORD_UNREADABLE, QUEUE_UNWRITABLE, QUEUE_KEPT, SYSTEM_PROMPT_UNWRITABLE, deliveryIdentity, buildDeliveryDiagnostic, queueErrorCode } from './persona-diagnostics.ts'
const safe = (text: string): string => redactSlackLogText(text).replace(/[\r\n]/g, ' ')
const slack = (text: string): string => escapeSlackControlCharacters(safe(text))
export function deliveryAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
/** The one permitted dispatch excerpt, at first actual Slack typing (b.omv SR-8.6). */
export function buildDeliveryDispatchLine(persona: string, accepted: AcceptedRecord): string {
  return `[slack] dispatch: persona=${safe(persona)} ${deliveryIdentity(accepted)} text=${JSON.stringify(safe(accepted.text.slice(0, 80)))}`
}
export function buildMessageNotSavedNotice(persona: string, sender: string): string {
  return `:warning: *Message not saved* — a message from ${slack(sender)} for ${slack(persona)} could not be saved. Slack will send it again a few times; it is delivered if one copy is saved, otherwise it is lost and should be sent again. Further messages to this persona may fail the same way until storing works; server.log counts them. Check the server's disk.`
}
export type DeliveryStuckReason = 'relay-off' | 'mcp' | 'refused' | 'transcript' | 'queue-unwritable' | 'not-taken-in' | 'dialog-hold'
export function deliveryStuckRemedy(reason: DeliveryStuckReason, key: string, count: number): string {
  const attach = `\`tmux attach -t =slack_bot_${key}\``
  switch (reason) {
    case 'relay-off': return `Its permission relay is off. Restart the persona's bot.`
    case 'mcp': return `It is not connected to this server over MCP. Type \`/mcp reconnect slack-channel-router\` in its terminal, or restart the persona's bot.`
    case 'refused': return `agent-director keeps refusing to type into it. Check its state with \`agent-director get --instance-id cscb_${key}\`.`
    case 'transcript': return `Its transcript can't be read, so CSCB can't confirm delivery and keeps offering the message. Check that the transcript exists and that the server's user can read it.`
    case 'queue-unwritable': return `CSCB can't write its queue file, so it types nothing more for this persona until it can. Check the server's disk.`
    case 'not-taken-in': return `It doesn't take the message in: CSCB has typed it ${count} times and keeps offering it. Attach with ${attach} to see why, or restart the persona's bot.`
    case 'dialog-hold': return `agent-director won't type into it until it can prove an answered permission prompt is gone; a subagent's denied prompt stays held until the bot ends. Restart the persona's bot.`
  }
}
export function buildDeliveryStuckNotice(persona: string, key: string, count: number, ageMs: number, reason: DeliveryStuckReason, typedCount: number): string {
  return `:warning: *Delivery stuck* — ${count} message(s) for ${slack(persona)} are waiting; the oldest has waited ${deliveryAge(ageMs)}. ${deliveryStuckRemedy(reason, key, typedCount)} ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`
}
export function buildMessageNotTakenInNotice(persona: string, sender: string): string {
  return `:warning: *Message not taken in* — the message from ${slack(sender)} for ${slack(persona)} is still queued. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.`
}
export const MESSAGES_WAITING_STATES = ['down', 'down at its restart limit', 'down with automatic restarts off', 'latched', 'held on invalid flags', 'held after a failed kill', 'waiting on an old life', 'waiting for its upgrade replacement'] as const
export type MessagesWaitingState = typeof MESSAGES_WAITING_STATES[number]
export interface DeliveryReportState {
  up: boolean; latched?: boolean; invalidFlags?: boolean; killFailed?: boolean; oldLife?: boolean; upgrade?: boolean
  atRestartLimit?: boolean; restartsOff?: boolean; outage?: boolean; prompt?: boolean; launch?: boolean
}
export function messagesWaitingState(status: DeliveryStatus, state: DeliveryReportState): MessagesWaitingState | undefined {
  if (!state.up) return undefined
  if (state.latched || status.latched) return 'latched'
  if (state.invalidFlags) return 'held on invalid flags'
  if (state.killFailed) return 'held after a failed kill'
  if (state.oldLife) return 'waiting on an old life'
  if (state.upgrade) return 'waiting for its upgrade replacement'
  if (status.row !== 'ended' && status.row !== 'missing' && status.row !== 'absent') return undefined
  return state.atRestartLimit ? 'down at its restart limit' : state.restartsOff ? 'down with automatic restarts off' : 'down'
}
export function buildMessagesWaitingNotice(persona: string, count: number, ageMs: number, state: MessagesWaitingState): string {
  return `:warning: *Messages waiting* — ${count} message(s) for ${slack(persona)} are waiting; the oldest has waited ${deliveryAge(ageMs)}. The persona is ${state}. The messages are kept and delivered once the persona is up.`
}
export function buildQueueRecordUnreadableNotice(persona: string, count: number, path: string): string {
  return `:warning: *Queue record unreadable* — ${count} queued message(s) for ${slack(persona)} could not be read at start and will not be delivered. Their bytes are kept in \`${slack(path)}\`. Ask the senders to send them again.`
}
function stuckReason(reason: DeliveryReason, status: DeliveryStatus): DeliveryStuckReason | undefined {
  if (reason === 'transcript-unreadable') return 'transcript'
  if (reason === 'not-now') return 'refused'
  if ((reason === 'receipt' || reason === 'backoff') && status.retypeCount > 0) return 'not-taken-in'
  return ['relay-off', 'mcp', 'queue-unwritable', 'dialog-hold'].includes(reason) ? reason as DeliveryStuckReason : undefined
}
export interface DeliveryReportingDeps {
  queue: DeliveryQueue; episodes: PersonaEpisodes
  persona(key: string): { name: string; key: string } | undefined
  state(key: string): DeliveryReportState
  log(line: string): void
  notify(key: string, text: string): void | Promise<unknown>
  delivered?(key: string, item: QueueItem): void | Promise<void>
  stuckAfterMs?: number
  now?: () => number
}
export function createDeliveryReporting(deps: DeliveryReportingDeps) {
  const alertedAtStartup = new Set<string>()
  const pendingFindings: QueueEvent[] = []
  let findingFlushPending = false
  const received = new Set<string>(), completed = new Set<string>(), failures = new Map<string, number>(), unwritable = new Set<string>(), heads = new Map<string, number>()
  const ref = (key: string) => { const p = deps.persona(key); return p ? renderPersonaRef(p.name, key) : `key=${key}` }
  const protect = (run: () => unknown) => { try { const result = run(); if (result && typeof (result as Promise<unknown>).catch === 'function') void (result as Promise<unknown>).catch(() => {}) } catch { /* reporting cannot interrupt durability */ } }
  function log(kind: DeliveryDiagnosticClass, key: string, identity: string, detail = '') { protect(() => deps.log(buildDeliveryDiagnostic(kind, ref(key), identity, detail))) }
  function move(key: string, seq?: number) {
    if (heads.get(key) === seq) return
    heads.delete(key); if (seq !== undefined) heads.set(key, seq)
    deps.episodes.end(key, 'delivery-stuck'); deps.episodes.end(key, 'messages-waiting')
  }
  function receivedItem(key: string, item: QueueItem): void {
    const id = `${key}:${item.accepted.seq}`
    if (received.has(id)) return
    received.add(id); log(MESSAGE_RECEIVED, key, deliveryIdentity(item.accepted))
  }
  function queueEvent(event: QueueEvent): void {
    const key = event.key
    switch (event.type) {
      case 'stored': failures.delete(key); deps.episodes.end(key, 'message-not-saved'); return
      case 'writable': unwritable.delete(key); return
      case 'store-failed': {
        const count = (failures.get(key) ?? 0) + 1; failures.set(key, count)
        const source = event.source ?? 'slack'
        const identity = deliveryIdentity({ ...event, source, ts: event.ts ?? '' })
        log(MESSAGE_NOT_SAVED, key, identity, `count=${count} path=${JSON.stringify(event.path ?? '')} code=${queueErrorCode(event.error)}`)
        if (source === 'slack') { deps.episodes.begin(key, 'message-not-saved'); deps.episodes.post(key, 'message-not-saved', buildMessageNotSavedNotice(ref(key), event.user ?? event.bot_id ?? 'unknown')) }
        return
      }
      case 'append-failed':
        if (!unwritable.has(key)) { unwritable.add(key); log(QUEUE_UNWRITABLE, key, `path=${JSON.stringify(event.path ?? '')} code=${queueErrorCode(event.error)}`) }
        return
      case 'record-unreadable':
        log(QUEUE_RECORD_UNREADABLE, key, `line=${event.line} path=${JSON.stringify(event.quarantinePath)}`)
        pendingFindings.push(event)
        if (!findingFlushPending) {
          findingFlushPending = true
          queueMicrotask(() => { findingFlushPending = false; protect(() => startupFindings(pendingFindings.splice(0))) })
        }
        return
      case 'retained': log(QUEUE_KEPT, key, `count=${event.count}`); return
      case 'recovery-failed': case 'compaction-failed': return
    }
  }
  function startupFindings(events: readonly QueueEvent[]): void {
    const groups = new Map<string, { count: number; path: string }>()
    for (const e of events) if (e.type === 'record-unreadable' && e.alert) { const g = groups.get(e.key) ?? { count: 0, path: e.quarantinePath }; g.count++; groups.set(e.key, g) }
    for (const [key, g] of groups) if (!alertedAtStartup.has(key)) { alertedAtStartup.add(key); protect(() => deps.notify(key, buildQueueRecordUnreadableNotice(ref(key), g.count, g.path))) }
  }
  function engineEvent(event: DeliveryEngineEvent): void {
    const key = event.key
    if (event.type === 'launch-observed' || event.type === 'launch-first-waiting') {
      deps.log(`[slack] delivery-${event.type}: ${JSON.stringify({ key, session_id: event.sessionId, at: event.at })}`)
      return
    }
    if (event.type === 'marker-missing' || event.type === 'delivered') return
    const item = deps.queue.items(key).find(i => i.accepted.seq === event.seq)
    if (!item) return
    const identity = deliveryIdentity(item.accepted), id = `${key}:${event.seq}`
    if (event.type === 'item-delivered') {
      if (!item.delivered || completed.has(id)) return
      completed.add(id)
      receivedItem(key, item)
      log(MESSAGE_DELIVERED, key, identity, `at=${event.at} wait_ms=${event.waitMs}`)
      move(key, deps.queue.items(key).find(i => !i.delivered)?.accepted.seq)
      protect(() => deps.delivered?.(key, item)); return
    }
    if (event.type === 'first-typed') {
      if (item.accepted.source === 'slack') protect(() => deps.log(buildDeliveryDispatchLine(ref(key), item.accepted)))
      return
    }
    if (event.type === 'retyped') { log(MESSAGE_RETYPED, key, identity, `retype_count=${event.count}`); return }
    if (event.type === 'first-unconfirmed-retype') {
      log(MESSAGE_NOT_TAKEN_IN, key, identity)
      protect(() => deps.notify(key, buildMessageNotTakenInNotice(ref(key), item.accepted.user ?? item.accepted.bot_id ?? item.accepted.sender ?? 'unknown'))); return
    }
    if (event.type !== 'waiting' || !event.status) return
    const status = event.status, state = deps.state(key)
    move(key, event.seq)
    if (!state.up) return
    const waiting = messagesWaitingState(status, state)
    if (waiting) { deps.episodes.begin(key, 'messages-waiting'); deps.episodes.post(key, 'messages-waiting', buildMessagesWaitingNotice(ref(key), status.count, status.ageMs, waiting)); return }
    if (state.outage || state.prompt || state.launch || status.row === 'pending' || status.row === 'check_permission' || status.row === 'working' && (status.receiptWorking || status.dialogMaybeOpen || event.reason === 'receipt')) return
    const reason = stuckReason(event.reason, status)
    if (!reason || status.ageMs <= (deps.stuckAfterMs ?? DELIVERY_STUCK_AFTER_MS)) return
    const begun = deps.episodes.begin(key, 'delivery-stuck')
    if (begun === 'begun') log(DELIVERY_STUCK, key, identity, `reason=${reason} age_ms=${status.ageMs}`)
    deps.episodes.post(key, 'delivery-stuck', buildDeliveryStuckNotice(ref(key), key, status.count, status.ageMs, reason, status.retypeCount + 1))
  }
  return { received: (key: string, item: QueueItem) => protect(() => receivedItem(key, item)), queueEvent: (event: QueueEvent) => protect(() => queueEvent(event)), engineEvent: (event: DeliveryEngineEvent) => protect(() => engineEvent(event)), startupFindings, forget(key: string) { failures.delete(key); unwritable.delete(key); heads.delete(key) } }
}
