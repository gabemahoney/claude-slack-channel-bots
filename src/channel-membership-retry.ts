/** Membership-only finite bounds. Unrelated posting clients keep their own
 * retry policy. Recovery bound: remaining attempt deadline + next permitted
 * retry (including Retry-After) + successful scan/persistence time. */
import type { PersonaConnectionClock } from './persona-connections.ts'

export const MEMBERSHIP_REQUEST_TIMEOUT_MS = 10_000
/** auth/installation validation and Socket Mode open each retain their own
 * request bound; this outer bound also defeats repeated socket-start signals. */
export const MEMBERSHIP_VALIDATION_TIMEOUT_MS = 20_000
export const MEMBERSHIP_ATTEMPT_TIMEOUT_MS = 120_000
export const MEMBERSHIP_RETRY_MIN_MS = 5_000
export const MEMBERSHIP_RETRY_MAX_MS = 60_000
export const MEMBERSHIP_PAGE_LIMIT = 200
export const MEMBERSHIP_TIMER_MAX_MS = 2_147_483_647
export const MEMBERSHIP_DEADLINE_CODE = 'channel-membership-deadline'

export class MembershipDeadlineError extends Error {
  readonly code = MEMBERSHIP_DEADLINE_CODE
  constructor() { super('Membership request or reconciliation deadline expired.') }
}
export class MembershipCancelledError extends Error {
  constructor() { super('Membership operation was superseded or cancelled.') }
}

/** Abort covers queued HTTP work too (via the manager's request interceptor).
 * Both late fulfillment and late rejection are consumed without effects. */
export function boundedMembershipCall<T>(
  clock: PersonaConnectionClock, parent: AbortSignal, deadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = MEMBERSHIP_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let timer: unknown
    const finish = (success: boolean, value: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clock.clearTimeout(timer)
      parent.removeEventListener('abort', cancel)
      controller.abort()
      if (success) resolve(value as T)
      else reject(value)
    }
    const cancel = () => finish(false, new MembershipCancelledError())
    parent.addEventListener('abort', cancel, { once: true })
    if (parent.aborted) { cancel(); return }
    const wait = Math.min(timeoutMs, deadline - clock.now())
    if (wait <= 0) { finish(false, new MembershipDeadlineError()); return }
    timer = clock.setTimeout(() => finish(false, new MembershipDeadlineError()), wait)
    try { Promise.resolve(operation(controller.signal)).then(value => finish(true, value), error => finish(false, error)) }
    catch (error) { finish(false, error) }
  })
}

export function membershipRetryDelay(failures: number, retryAfterSeconds?: number): number {
  const local = Math.min(MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_RETRY_MIN_MS * 2 ** Math.min(failures, 20))
  return Math.max(local, typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, retryAfterSeconds * 1000) : 0)
}
