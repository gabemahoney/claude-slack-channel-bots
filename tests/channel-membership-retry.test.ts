import { expect, test } from 'bun:test'
import { boundedMembershipCall, membershipRetryDelay, MembershipDeadlineError, MembershipCancelledError,
  MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_VALIDATION_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS,
  MEMBERSHIP_RETRY_MIN_MS, MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_PAGE_LIMIT, MEMBERSHIP_TIMER_MAX_MS,
} from '../src/channel-membership-retry.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

test('pins the finite request, composite validation, attempt, retry and pagination contract', () => {
  expect([MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_VALIDATION_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MIN_MS, MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_PAGE_LIMIT, MEMBERSHIP_TIMER_MAX_MS]).toEqual([10_000, 20_000, 120_000, 5_000, 60_000, 200, 2_147_483_647])
})
test('local retry is positive, doubles to a finite ceiling, and never truncates longer Retry-After', () => {
  for (let failures = 0; failures < 30; failures++) {
    expect(membershipRetryDelay(failures)).toBe(Math.min(MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_RETRY_MIN_MS * 2 ** failures))
    expect(membershipRetryDelay(failures, MEMBERSHIP_RETRY_MAX_MS / 1000 + 1)).toBe(MEMBERSHIP_RETRY_MAX_MS + 1000)
  }
})
test.each(['request', 'attempt', 'abort'] as const)('%s boundary aborts exactly once and consumes late completion without retry or timers', async boundary => {
  const clock = createFakeClock(), parent = new AbortController()
  let finish!: (value: string) => void, signal!: AbortSignal, started = 0, aborted = 0
  const limit = boundary === 'attempt' ? MEMBERSHIP_REQUEST_TIMEOUT_MS / 2 : MEMBERSHIP_ATTEMPT_TIMEOUT_MS
  const work = boundedMembershipCall(clock, parent.signal, limit, current => {
    started++; signal = current; signal.addEventListener('abort', () => { aborted++ })
    return new Promise<string>(resolve => { finish = resolve })
  }).then(value => ({ value }), error => ({ error }))
  expect(started).toBe(1)
  if (boundary === 'abort') parent.abort()
  else {
    await clock.advance(Math.min(limit, MEMBERSHIP_REQUEST_TIMEOUT_MS) - 1)
    expect(signal.aborted).toBe(false)
    await clock.advance(1)
  }
  const result = await work
  expect('error' in result && result.error instanceof (boundary === 'abort' ? MembershipCancelledError : MembershipDeadlineError)).toBe(true)
  expect(aborted).toBe(1); expect(clock.pendingCount()).toBe(0)
  finish('late'); await clock.flush(); expect(started).toBe(1); expect(clock.pendingCount()).toBe(0)
})
