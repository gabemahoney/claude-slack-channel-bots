/** Temporary SRD t1.kii.kn surface until AD publishes its E2 client.
 * No runtime shim: 0.12 drops these options. Covered delivery requires the
 * matching client's getDelivery method; package.json deliberately stays pinned.
 */
import 'agent-director'

export interface BusyDeliveryResult {
  caller_uuid?: string; request_id?: string
  class: 'held' | 'queued' | 'delivered_confirmed' | 'sent_unconfirmed' | 'not_started'
  final: boolean; reason: string; resend_safe: boolean; retry_with: 'new_id' | 'none'
  wait: { reason: string; since: string } | null
  instance_id: string; launch_token: string | null
  session_id?: string; evidence_kind?: string | null
}
export interface BusyDeliveryLookup {
  lookup: 'found' | 'unknown' | 'retention_expired'
  result: BusyDeliveryResult | null
}
export interface CantSendDetails {
  class: 'cant_send'; reason: string; resend_safe: boolean; retry_with: string
  limit?: { actual: number; allowed: number }
  result?: BusyDeliveryResult
}
export type NotPausableCause = 'not_waiting' | 'turn_pending' | 'pause_in_progress' | 'pause_uncertain' | 'agent_not_covered'

declare module 'agent-director' {
  interface GetResult {
    busy_send?: 'covered' | 'not_covered'
    launch_token?: string | null
    delivery?: { awaiting_turn_start: number }
  }
  interface SendKeysParams {
    send_mode?: 'wait_turn' | 'steer_turn'
    confirmed_delivery?: boolean
    caller_uuid?: string
    delivery_request_id?: string
  }
  interface PauseParams { only_if_waiting?: boolean }
}

/** Optional until the matching runtime client is installed. Never polyfilled. */
export interface BusySendClient {
  getDelivery?(params: { caller_uuid: string; delivery_request_id: string }): Promise<BusyDeliveryLookup>
}
