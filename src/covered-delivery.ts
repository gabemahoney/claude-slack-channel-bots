/** AD busy-send adapter (SRD t1.kii.kn). No pane reads or transcript receipts.
 * A submitted journal entry is custody uncertainty, never permission to replay.
 * All AD calls use the engine's injected client, outage wrapper and budget.
 */
import type { GetResult, SendKeysParams, SendKeysResult } from 'agent-director'
import { createHash } from 'node:crypto'
import type { BusySendClient, BusyDeliveryResult, BusyDeliveryLookup, CantSendDetails } from './ad-busy-send-types.ts'
import type { DeliveryQueue, QueueItem, SubmittedRecord } from './delivery-queue.ts'
import { cantSendDetailsOf, isInvalidFlagsError, notPausableCauseOf } from './ad-error-class.ts'
import { NOT_NOW_RETRY_MS } from './delivery-constants.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { isLegacyInputCustodyReason, unresolvedInputBlocks } from './ad-input-custody.ts'

/** AD E6 is not released. Flip only after its only_if_waiting capability lands.
 * Never infer this capability from the AD version or busy_send coverage.
 */
export const COVERED_RECONNECT_ONLY_IF_WAITING = false
export const COVERED_DELIVERY_POLL_MS = 1000
export const COVERED_DELIVERY_RETRY_MS = 60000
export function buildCoveredRestartNotice(persona: { key: string; name?: string }): string {
  const ref = persona.name === undefined ? `persona=${persona.key}` : renderPersonaRef(persona.name, persona.key)
  return `:warning: Persona ${ref} is not connected. Restart the persona to reconnect it. Queued messages are kept until it is connected again.`
}
export function buildCoveredDeliveryBlockedNotice(persona: { key: string; name?: string }): string {
  const ref = persona.name === undefined ? `persona=${persona.key}` : renderPersonaRef(persona.name, persona.key)
  return `:warning: Delivery to persona ${ref} is blocked or its hand-over is unconfirmed. CSCB has kept the queued message and will not resend it automatically. Check server.log before recovering the persona.`
}

/** Completed parts and definitely refused attempts no longer hold custody. */
export function hasUnresolvedCoveredCustody(item: QueueItem): boolean {
  const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
  const delivered = new Set(item.records.flatMap(r => r.kind === 'delivered' ? [r.part] : []))
  return item.records.some(r => (r.kind === 'submission-blocked' && !isLegacyInputCustodyReason(r.reason)) || (r.kind === 'submitted' && !refused.has(r.attempt) && !delivered.has(r.part)))
}

export function isCoveredRow(row: GetResult): boolean { return row.busy_send === 'covered' }
export function queueItemId(item: QueueItem): string {
  // Adopt old accepted records without rewriting immutable intake. The digest
  // is stable through compaction/restart and exposes no Slack text or IDs.
  return item.accepted.item_id ?? createHash('sha256').update(JSON.stringify([
    item.accepted.seq, item.accepted.received_at, item.accepted.ts, item.accepted.text,
  ])).digest('hex')
}
export interface CoveredClient extends BusySendClient {
  sendKeys(params: SendKeysParams): Promise<SendKeysResult>
}
export type CoveredDeliveryAction = 'legacy' | 'waiting' | 'delivered' | 'blocked'
export interface CoveredDeliveryStep {
  key: string; row: GetResult; item: QueueItem; part: number
  readRow(): Promise<GetResult | undefined>
  ready(): boolean
  call<T>(verb: 'send-keys' | 'get-delivery', run: (client: CoveredClient) => Promise<T>): Promise<T>
  /** Capability check before journalling or sending with the older client. */
  client(): Promise<CoveredClient>
  delivered(): void
}
export interface CoveredDelivery {
  step(input: CoveredDeliveryStep): Promise<CoveredDeliveryAction>
  forget(key: string): void
}

/** Pure refusal policy. A retry additionally requires AD's explicit safety facts. */
export function cantSendAction(details: CantSendDetails): 'reread' | 'retry' | 'blocked' {
  if (!details.resend_safe) return 'blocked'
  if (details.reason === 'agent_not_covered' && details.retry_with === 'new_send') return 'reread'
  if (['held_count', 'held_bytes'].includes(details.reason) && details.retry_with === 'new_send') return 'retry'
  // agent_command, steer_unsupported, text_bytes, prompt_size, text_kind,
  // id_conflict, retention_expired and unknown future reasons require repair.
  return 'blocked'
}
function deliveryResult(value: unknown): BusyDeliveryResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  // SR-5.1 returns the current Result. Accept the client's envelope too until
  // E2 settles its return type; never fall back to legacy success semantics.
  const r = ('result' in value ? value.result : value) as BusyDeliveryResult | undefined
  if (!r || !['held', 'queued', 'delivered_confirmed', 'sent_unconfirmed', 'not_started'].includes(r.class) ||
    typeof r.final !== 'boolean' || typeof r.resend_safe !== 'boolean' || typeof r.reason !== 'string') return undefined
  return r
}
export function createCoveredDelivery(deps: {
  queue: DeliveryQueue; now(): number
  log(key: string, reason: string): void
  info?(key: string, message: string): void
  notify?(key: string, reason: string): void
}): CoveredDelivery {
  const after = new Map<string, number>(), logged = new Set<string>(), retrySteps = new Map<string, number>(), heads = new Map<string, string>()
  function clearLogs(key: string): void { for (const id of logged) if (id.startsWith(`${key}/`)) logged.delete(id) }
  function log(key: string, identity: string, reason: string, level: 'error' | 'info' = 'error'): boolean {
    const id = `${key}/${identity}/${reason}`
    if (logged.has(id)) return false
    logged.add(id)
    if (level === 'info') deps.info?.(key, reason)
    else deps.log(key, reason)
    return true
  }
  async function blocked(input: CoveredDeliveryStep, submitted: SubmittedRecord, reason: string): Promise<CoveredDeliveryAction> {
    log(input.key, submitted.delivery_request_id, reason)
    await deps.queue.append(input.key, { v: 1, kind: 'submission-blocked', seq: submitted.seq, attempt: submitted.attempt, at: deps.now(), reason })
    deps.notify?.(input.key, reason)
    return 'blocked'
  }
  async function refused(input: CoveredDeliveryStep, submitted: SubmittedRecord): Promise<void> {
    await deps.queue.append(input.key, { v: 1, kind: 'refused', seq: submitted.seq, attempt: submitted.attempt, at: deps.now() })
  }
  async function result(input: CoveredDeliveryStep, submitted: SubmittedRecord, r: BusyDeliveryResult): Promise<CoveredDeliveryAction> {
    const handover = r.class === 'sent_unconfirmed' && ['handed_over_not_proven', 'wait_turn_raced'].includes(r.reason)
    if (r.final && (r.class === 'delivered_confirmed' || handover)) {
      if (r.reason === 'wait_turn_raced') log(input.key, submitted.delivery_request_id, 'wait_turn_raced: AD completed the hand-over with its documented turn-boundary race', 'info')
      await deps.queue.append(input.key, { v: 1, kind: 'delivered', seq: submitted.seq, part: submitted.part, at: deps.now(), receipt: { path: 'agent-director:get-delivery', uuid: submitted.delivery_request_id }, ad: { launch_token: r.launch_token, session_id: r.session_id ?? submitted.session_id, evidence_kind: r.evidence_kind ?? null } })
      input.delivered()
      return 'delivered'
    }
    if (r.class === 'not_started' && r.final && r.resend_safe && r.retry_with === 'new_id') {
      await refused(input, submitted)
      after.set(input.key, deps.now() + COVERED_DELIVERY_RETRY_MS)
      return 'waiting'
    }
    if (r.final) return blocked(input, submitted, `final-${r.class}`)
    const reason = r.wait?.reason ?? r.reason
    if (reason === 'route_unavailable') log(input.key, submitted.delivery_request_id, 'route_unavailable: holding; no automatic relaunch')
    // Row reads, performed by the engine on every tick, alone drive recovery.
    // launch_ended is a reason to read the row, never proof of agent death.
    return 'waiting'
  }
  return {
    async step(input) {
      const { key, item, part, row } = input
      const headId = queueItemId(item)
      if (heads.get(key) !== headId) { clearLogs(key); heads.set(key, headId); retrySteps.delete(key) }
      if (unresolvedInputBlocks(item).length || item.records.some(r => r.kind === 'submission-blocked' && !isLegacyInputCustodyReason(r.reason))) return 'blocked'
      const refusedAttempts = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
      const submitted = item.records.filter((r): r is SubmittedRecord => r.kind === 'submitted' && r.part === part && !refusedAttempts.has(r.attempt) && !item.records.some(done => done.kind === 'delivered' && done.part === r.part)).at(-1)
      if (!submitted && !isCoveredRow(row)) return hasUnresolvedCoveredCustody(item) ? 'blocked' : 'legacy'
      if ((after.get(key) ?? 0) > deps.now()) return 'waiting'
      after.set(key, deps.now() + COVERED_DELIVERY_POLL_MS)
      const client = await input.client()
      if (typeof client.getDelivery !== 'function') {
        if (log(key, headId, 'CSCB compatibility bug: covered delivery requires AD E2 client getDelivery; install the matching client')) deps.notify?.(key, 'matching AD client required')
        return 'blocked'
      }
      if (submitted) {
        // A restart always looks up, even if the process died between durable
        // intent and send-keys. Unknown/expired is never permission to resend.
        let lookup: BusyDeliveryLookup
        try {
          lookup = await input.call('get-delivery', c => c.getDelivery!({ caller_uuid: submitted.caller_uuid, delivery_request_id: submitted.delivery_request_id }))
        } catch (error) {
          if (isInvalidFlagsError(error)) return blocked(input, submitted, 'CSCB bug: malformed covered get-delivery')
          throw error
        }
        const r = deliveryResult(lookup.result)
        if (lookup.lookup === 'found' && r) return result(input, submitted, r)
        if (log(key, submitted.delivery_request_id, `lookup-${lookup.lookup}: outcome unknown; automatic resend forbidden`)) deps.notify?.(key, 'delivery lookup is unknown; automatic resend forbidden')
        after.set(key, deps.now() + COVERED_DELIVERY_RETRY_MS)
        return 'waiting'
      }
      if (!item.fixed || !input.ready()) return 'waiting'
      // Old ambiguous raw input cannot be converted into a fresh busy send.
      if (item.unknownSend || item.records.some(r => r.kind === 'sent' && !refusedAttempts.has(r.attempt) && (!('part' in r) || r.part === part))) {
        log(key, queueItemId(item), 'unresolved legacy input: covered delivery held for operator review')
        return 'blocked'
      }
      const fresh = await input.readRow()
      if (!fresh || !input.ready()) return 'waiting'
      if (!isCoveredRow(fresh)) return 'legacy'
      // AD owns conversation custody across pause/resume. A waiting/working row has
      // no launch identity; only a handed-over Result supplies launch_token.
      const caller = deps.queue.callerUuid?.()
      if (!caller) { log(key, headId, 'covered delivery held: durable caller UUID unavailable'); return 'blocked' }
      const attempt = item.nextAttempt
      const earlier = item.records.some(r => r.kind === 'submitted' && r.part === part)
      const id = `cscb/${key}/${queueItemId(item)}/${part}${earlier ? `/retry-${attempt}` : ''}`
      const intent: SubmittedRecord = { v: 1, kind: 'submitted', seq: item.accepted.seq, attempt, part, at: deps.now(), caller_uuid: caller, delivery_request_id: id, instance_id: fresh.instance_id, session_id: fresh.session_id }
      await deps.queue.append(key, intent)
      // This live caller can prove it has not invoked send-keys yet. Retire
      // that intent if a guard/read/budget refuses before dispatch. A crash
      // here instead leaves the durable intent lookup-only on recovery.
      if (!input.ready()) { await refused(input, intent); return 'waiting' }
      let beforeSend: GetResult | undefined
      try { beforeSend = await input.readRow() }
      catch (error) { await refused(input, intent); throw error }
      if (!beforeSend || !input.ready() || !isCoveredRow(beforeSend)) {
        await refused(input, intent); return 'waiting'
      }
      let dispatched = false
      try {
        const answer = await input.call('send-keys', c => {
          dispatched = true
          return c.sendKeys({ instance_id: intent.instance_id, text: item.fixed!.parts[part - 1]!, send_mode: 'wait_turn', confirmed_delivery: true, caller_uuid: caller, delivery_request_id: id })
        })
        retrySteps.delete(key)
        const r = deliveryResult(answer)
        return r ? result(input, intent, r) : 'waiting'
      } catch (error) {
        if (!dispatched) { await refused(input, intent); throw error }
        if (isInvalidFlagsError(error)) return blocked(input, intent, 'CSCB bug: malformed covered send-keys; automatic retry disabled')
        const details = cantSendDetailsOf(error)
        if (!details) throw error // uncertain submission: next step only polls
        const action = cantSendAction(details)
        if (action === 'blocked') return blocked(input, intent, `cant_send:${details.reason}`)
        if (action === 'reread') {
          await refused(input, intent)
          const current = await input.readRow()
          if (!current || isCoveredRow(current)) {
            log(key, id, 'agent_not_covered: waiting for a fresh uncovered row before fallback')
            after.set(key, deps.now() + COVERED_DELIVERY_RETRY_MS)
            return 'waiting'
          }
          return 'legacy'
        }
        await refused(input, intent)
        const step = retrySteps.get(key) ?? 0
        retrySteps.set(key, step + 1)
        after.set(key, deps.now() + NOT_NOW_RETRY_MS[Math.min(step, NOT_NOW_RETRY_MS.length - 1)]!)
        return 'waiting'
      }
    },
    forget(key) { after.delete(key); retrySteps.delete(key); heads.delete(key); clearLogs(key) },
  }
}

export type CoveredReconnectAction = 'legacy' | 'ok' | 'deferred' | 'restart-required'
/** E6 path has an explicit test seam. Production uses the default-off flag.
 * Session IDs guard conversation changes, not launches. After conditional pause,
 * only a fresh ended/missing row of that conversation permits resume. Revisit
 * this path against E6's final contract before enabling it.
 */
export function createCoveredReconnect(options: { onlyIfWaiting?: boolean } = {}) {
  const states = new Map<string, { session: string; disabled: boolean; announced: boolean }>()
  const run = async (input: {
    key: string; row: GetResult; readRow(): Promise<GetResult | undefined>
    pause(): Promise<unknown>; resume(): Promise<unknown>; ready(): boolean
    log(reason: string): void; notify(text: string): void
  }): Promise<CoveredReconnectAction> => {
    if (!isCoveredRow(input.row)) { states.delete(input.key); return 'legacy' }
    const session = input.row.session_id
    let state = states.get(input.key)
    if (!state || state.session !== session) { state = { session, disabled: false, announced: false }; states.set(input.key, state) }
    const current = state
    const ready = () => states.get(input.key) === current && input.ready()
    const announce = () => {
      if (states.get(input.key) !== current) return 'deferred' as const
      if (!current.announced) { current.announced = true; input.log('covered reconnect unavailable: restart the persona'); input.notify(buildCoveredRestartNotice({ key: input.key })) }
      return 'restart-required' as const
    }
    if (!(options.onlyIfWaiting ?? COVERED_RECONNECT_ONLY_IF_WAITING) || current.disabled) return announce()
    if (!ready()) return 'deferred'
    let row = await input.readRow()
    if (!row || row.session_id !== session || !ready()) return 'deferred'
    if (!isCoveredRow(row)) return 'legacy'
    try { await input.pause() }
    catch (error) {
      if (!ready()) return 'deferred'
      if (isInvalidFlagsError(error)) { current.disabled = true; input.log('CSCB bug: malformed covered pause; retry disabled'); return announce() }
      const cause = notPausableCauseOf(error)
      if (cause === 'not_waiting' || cause === 'turn_pending') return 'deferred'
      if (!cause) throw error
      row = await input.readRow()
      if (!row || !ready()) return 'deferred'
      if (cause === 'agent_not_covered') return !isCoveredRow(row) ? 'legacy' : announce()
      // pause_in_progress/pause_uncertain: only the row can prove completion.
      if (row.session_id !== session || !['ended', 'missing'].includes(row.state)) return 'deferred'
    }
    row = await input.readRow()
    if (!row || !ready() || row.session_id !== session || !['ended', 'missing'].includes(row.state)) return 'deferred'
    await input.resume()
    return 'ok'
  }
  return Object.assign(run, {
    forget(key: string): void { states.delete(key) },
    clear(): void { states.clear() },
  })
}
