/** Complete synthetic SR-5 Result contract. Validation is fixture-only. */
import assert from 'node:assert/strict'
export function assertBusyFixtureResult(value: any): void {
  assert(value && typeof value === 'object')
  for (const key of ['caller_uuid', 'request_id', 'instance_id', 'session_id', 'reason']) assert.equal(typeof value[key], 'string', key)
  assert(['held', 'queued', 'delivered_confirmed', 'sent_unconfirmed', 'not_started'].includes(value.class))
  assert.equal(typeof value.final, 'boolean')
  assert.equal(typeof value.resend_safe, 'boolean')
  assert(['none', 'new_id'].includes(value.retry_with))
  assert(value.launch_token === null || typeof value.launch_token === 'string', 'launch_token must be explicit')
  assert(value.evidence_kind === null || typeof value.evidence_kind === 'string', 'evidence_kind must be explicit')
  assert(value.wait === null || (typeof value.wait?.reason === 'string' && typeof value.wait?.since === 'string'), 'wait must be explicit')
}
export function fixtureBusyResult(identity: { instance_id: string; caller_uuid: string; request_id: string }, final: boolean) {
  const value = { ...identity, session_id: 'fixture-session', launch_token: null, evidence_kind: null,
    class: final ? 'delivered_confirmed' : 'held', final, resend_safe: false, retry_with: 'none',
    reason: final ? 'fixture_confirmation' : 'route_unavailable',
    wait: final ? null : { reason: 'route_unavailable', since: '2026-11-13T00:00:00Z' } }
  assertBusyFixtureResult(value)
  return value
}
