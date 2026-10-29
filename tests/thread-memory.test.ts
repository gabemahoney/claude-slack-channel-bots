/**
 * thread-memory.test.ts — Thread Memory (src/thread-memory.ts): for now the
 * bounded, revocable metadata call its lookups use, the classification of
 * its failures and its retry spacing, asserted directly against the module.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { THREAD_MEMORY_LOOKUP_METHODS, MetadataCancelledError, classifyMetadataFailure, createMetadataAttempts, metadataRetryDelay,
  type MetadataFailure } from '../src/thread-memory.ts'
import { THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS } from '../src/delivery-constants.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { slackHttpError, slackPlatformError, slackRateLimited } from './test-helpers/slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'

const T0 = 1_700_000_000_000

/** Operations answered in call order, each recording the signal its attempt gave it. */
function scripted() {
  const signals: AbortSignal[] = [], answers: Array<() => Promise<unknown>> = []
  const operation = (signal: AbortSignal) => { signals.push(signal); return answers.shift()!() }
  const hang = () => {
    let settle!: (value: unknown) => void, fail!: (error: unknown) => void
    const pending = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    answers.push(() => pending)
    return { settle, fail }
  }
  return { signals, answers, operation, hang }
}

describe('the bounded metadata call', () => {
  test('Thread Memory\'s lookups may call exactly conversations.replies and conversations.history (SR-3.4.2)', () => {
    expect(THREAD_MEMORY_LOOKUP_METHODS).toEqual(['conversations.replies', 'conversations.history'])
  })

  test('a hung first and a hung later attempt each end at the lookup deadline, abort their request and leave nothing in flight; late answers change nothing', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const run = () => attempts.run('alpha', () => true, s.operation)
    const first = s.hang()
    const one = run()
    await clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS - 1)
    expect([attempts.inFlight('alpha'), s.signals[0]!.aborted]).toEqual([1, false])
    await clock.advance(1)
    expect(await one).toEqual({ kind: 'deadline' })
    expect([attempts.inFlight('alpha'), s.signals[0]!.aborted]).toEqual([0, true])
    // The abandoned attempt's late answer is consumed; a fresh attempt starts at once and decides from its own answer.
    first.settle({ ok: true, late: true })
    const fresh = { ok: true, fresh: true }
    s.answers.push(async () => fresh)
    expect(await run()).toEqual({ kind: 'ok', value: fresh })
    const later = s.hang()
    const three = run()
    await clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS)
    expect(await three).toEqual({ kind: 'deadline' })
    later.fail(slackPlatformError('internal_error'))
    await clock.flush()
    expect([s.signals.length, s.signals[2]!.aborted, attempts.inFlight('alpha'), clock.pendingCount()]).toEqual([3, true, 0, 0])
  })

  test('a guard turning false, revocation or shutdown cancels the attempt; another persona\'s attempt is untouched', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const answer = { ok: true }
    let current = true
    const guarded = s.hang(), revoked = s.hang(), other = s.hang()
    const a = attempts.run('alpha', () => current, s.operation)
    const b = attempts.run('alpha', () => true, s.operation)
    const c = attempts.run('beta', () => true, s.operation)
    current = false; guarded.settle(answer)
    expect(await a).toEqual({ kind: 'cancelled' })
    attempts.revoke('alpha')
    expect(await b).toEqual({ kind: 'cancelled' })
    expect([s.signals[1]!.aborted, s.signals[2]!.aborted, attempts.inFlight('beta')]).toEqual([true, false, 1])
    revoked.settle(answer); other.settle(answer)
    expect(await c).toEqual({ kind: 'ok', value: answer })
    attempts.stop()
    expect(await attempts.run('beta', () => true, s.operation)).toEqual({ kind: 'cancelled' })
    expect(s.signals).toHaveLength(3)
  })

  test.each<[string, unknown, MetadataFailure]>([
    ['a missing scope', slackPlatformError('missing_scope'), { kind: 'capability', slackError: 'missing_scope' }],
    ['a refused token type', slackPlatformError('not_allowed_token_type'), { kind: 'capability', slackError: 'not_allowed_token_type' }],
    ['a denied access', slackPlatformError('access_denied'), { kind: 'capability', slackError: 'access_denied' }],
    ['a missing permission', slackPlatformError('no_permission'), { kind: 'capability', slackError: 'no_permission' }],
    ['an unauthorized call', slackPlatformError('not_authorized'), { kind: 'capability', slackError: 'not_authorized' }],
    ['a revoked token', slackPlatformError('token_revoked'), { kind: 'credentials', slackError: 'token_revoked' }],
    ['lost access', slackPlatformError('channel_not_found'), { kind: 'access-lost', slackError: 'channel_not_found' }],
    ['a deleted message', slackPlatformError('thread_not_found'), { kind: 'not-found', slackError: 'thread_not_found' }],
    ['ratelimited with Retry-After', slackPlatformError('ratelimited', 30), { kind: 'transient', retryAfter: 30 }],
    ['a rate-limited rejection', slackRateLimited(120), { kind: 'transient', retryAfter: 120 }],
    ['a server error', slackPlatformError('internal_error'), { kind: 'transient' }],
    ['an unknown Slack error', slackPlatformError('something_new'), { kind: 'rejected', slackError: 'something_new' }],
    ['a service outage', slackPlatformError('service_unavailable'), { kind: 'transient' }],
    ['an HTTP 400', slackHttpError(400), { kind: 'rejected' }],
    ['an HTTP 404', slackHttpError(404), { kind: 'rejected' }],
    ['an HTTP 408', slackHttpError(408), { kind: 'transient' }],
    ['an HTTP 429', slackHttpError(429), { kind: 'transient' }],
    ['an HTTP 503', slackHttpError(503), { kind: 'transient' }],
    ['a malformed Slack error code', slackPlatformError('Not A Code!'), { kind: 'malformed' }],
    ['a transport error', Object.assign(new Error('socket hang up'), { code: 'slack_webapi_request_error' }), { kind: 'transient' }],
    ['a cancellation', new MetadataCancelledError(), { kind: 'cancelled' }],
  ])('%s is classified apart, never as authorship, deletion or recovery', (_name, error, expected) => {
    expect(classifyMetadataFailure(error)).toEqual(expected)
  })

  test('a sentinel-bearing failure keeps only its safe Slack code and Retry-After', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock)
    const results = [
      await attempts.run('alpha', () => true, async () => { throw slackPlatformError('something_new', undefined, LEAK_SENTINEL) }),
      await attempts.run('alpha', () => true, async () => { throw slackPlatformError('ratelimited', 30, LEAK_SENTINEL) }),
      await attempts.run('alpha', () => true, async () => { throw slackRateLimited(120, LEAK_SENTINEL) }),
    ]
    expect(results).toEqual([{ kind: 'rejected', slackError: 'something_new' }, { kind: 'transient', retryAfter: 30 }, { kind: 'transient', retryAfter: 120 }])
    assertNoLeak({ results })
  })

  test('retry spacing: the minimum doubling to the local maximum; Retry-After below the cap changes nothing, above it is honored, and huge or invalid waits stay safe', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(n => metadataRetryDelay(n))).toEqual([1, 2, 4, 8, 16, 32, 32].map(m => Math.min(THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS * m)))
    expect(metadataRetryDelay(50)).toBe(THREAD_MEMORY_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, 1)).toBe(THREAD_MEMORY_RETRY_MIN_MS)
    expect(metadataRetryDelay(50, THREAD_MEMORY_RETRY_MAX_MS / 1000 - 1)).toBe(THREAD_MEMORY_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, THREAD_MEMORY_RETRY_MAX_MS / 1000 * 3)).toBe(THREAD_MEMORY_RETRY_MAX_MS * 3)
    expect(metadataRetryDelay(1, 1e300)).toBe(Number.MAX_SAFE_INTEGER)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(metadataRetryDelay(1, bad)).toBe(THREAD_MEMORY_RETRY_MIN_MS)
  })

  test('pin: a lookup attempt\'s deadline is 15 s, and its retries are spaced from 5 s to 60 s (SR-5.1.1, SR-5.1.3)', () => {
    expect([THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_RETRY_MAX_MS]).toEqual([15_000, 5_000, 60_000])
  })
})
