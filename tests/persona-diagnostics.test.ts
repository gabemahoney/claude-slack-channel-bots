import { describe, expect, test } from 'bun:test'
import { channelDeliverySetCause, deliveryIdentity, formatPersonaDiagnostic, NO_STORED_CHOICE, openChannelCause, PERSONA_OPEN_CHANNEL, PERSONA_THREAD_STAMP_UNDECIDED, threadStampUndecidedCause } from '../src/persona-diagnostics.ts'
import { threadMemoryLoadAtApplyFailedLine } from '../src/persona-lifecycle.ts'
import { assertNoLeak, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { injectedInput, slackInput } from './test-helpers/delivery-queue.ts'

describe('open channel and delivery choice diagnostics', () => {
  test('pins the first-heard class and complete cause', () => {
    expect(PERSONA_OPEN_CHANNEL).toBe('persona-open-channel')
    expect(openChannelCause('C0PUBLIC1', 'public', 'mentions')).toBe('hears public channel C0PUBLIC1 in open mode, at channel delivery mentions')
    expect(openChannelCause('G0PRIVATE', 'private', 'thread_hybrid')).toBe('hears private channel G0PRIVATE in open mode, at channel delivery thread_hybrid')
  })

  test('pins the absent choice marker and complete before/after/delivery fields', () => {
    expect(NO_STORED_CHOICE).toBe('none')
    expect(channelDeliverySetCause('C0PUBLIC1', undefined, 'mentions', 'mentions')).toBe('delivery choice for channel C0PUBLIC1 set from none to mentions, at channel delivery mentions')
    expect(channelDeliverySetCause('G0PRIVATE', 'off', 'thread_hybrid', 'all')).toBe('delivery choice for channel G0PRIVATE set from off to thread_hybrid, at channel delivery all')
  })
})

describe('delivery identity thread reason', () => {
  test('pins the fixed thread suffix on Slack identities', () => {
    const identity = deliveryIdentity({ ...slackInput({ via: 'thread' }), ts: '1700000000.000001' })
    expect(identity).toBe('source=slack chat_id="C0TEST001" ts="1700000000.000001" sender_id="U0TEST001" via=thread')
  })
  test.each([undefined, 'dm', 'mention', 'broadcast', 'receive_all', 'receive_all_shared', 'thread-extra', LEAK_SENTINEL])('Slack via %p leaves the identity unchanged and never echoes arbitrary values', via => {
    const identity = deliveryIdentity({ ...slackInput({ via }), ts: '1700000000.000001' })
    expect(identity).toBe('source=slack chat_id="C0TEST001" ts="1700000000.000001" sender_id="U0TEST001"')
    assertNoLeak(identity)
  })
  test.each(['cron', 'interject'] as const)('%s with a thread reason keeps its existing identity', source => {
    const identity = deliveryIdentity({ ...injectedInput({ source, via: 'thread' }), ts: '1700000000.000001' })
    expect(identity).toBe(`source=${source} sender="interject" ts="1700000000.000001" sender_id="interject"`)
    assertNoLeak(identity)
  })
})

describe('undecided Thread Memory stamp diagnostic', () => {
  test('pins the exported cause, review/apply remedy and finite-Slack-retry limitation', () => {
    const cause = threadStampUndecidedCause('C123')
    expect(cause).toBe("channel=C123: thread-dependent replies remain unacknowledged until the shared-state restoration is reviewed and applied; finite Slack retries do not guarantee recovery of never-accepted events. Check the app's event subscriptions and resend missing replies after recovery.")
    const line = formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: 'Alpha', key: 'alpha', index: 0, cause })
    expect(line).toBe(`[slack] ${PERSONA_THREAD_STAMP_UNDECIDED}: personas[0] "Alpha" (key=alpha): ${cause}`)
    assertNoLeak({ cause, line })
  })

  test('redacts token and URL-shaped input and keeps the diagnostic on one line', () => {
    const cause = threadStampUndecidedCause(`C123\r\n${sentinelInMessage('stamp')}\u2028\u001b`)
    const line = formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: 'Alpha', key: 'alpha', index: 0, cause })
    expect(cause).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).not.toMatch(/[\r\n\u2028\u001b]/)
    expect(line).toContain('\\u2028\\u001b')
    assertNoLeak({ cause, line })
  })
})

describe('Thread Memory load failure diagnostic', () => {
  test('pins the exported apply-load failure line', () => {
    const error = Object.assign(new Error('journal unavailable'), { code: 'EIO', stack: undefined })
    const line = threadMemoryLoadAtApplyFailedLine({ name: 'Alpha Desk', key: 'alpha' }, error)
    expect(line).toBe('[slack] persona "Alpha Desk" (key=alpha): Thread Memory load at apply failed: Error code=EIO message="journal unavailable"')
    assertNoLeak({ line })
  })

  test('keeps a described failure while redacting tokens and ticket URLs and ignoring raw error payloads', () => {
    const error = Object.assign(new Error(sentinelInMessage('load-builder')), {
      code: 'EACCES', stack: undefined, data: LEAK_SENTINEL, original: LEAK_SENTINEL,
    })
    const line = threadMemoryLoadAtApplyFailedLine({ name: 'Alpha Desk', key: 'alpha' }, error)
    expect(line).toContain(`Error code=EACCES message="${REDACTED_SENTINEL_TAIL}"`)
    assertNoLeak({ line })
  })
})
