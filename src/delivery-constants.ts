
/** Production timing and load bounds; replay injects these. */
export const ENTER_DELAY_MS = 500
export const RECEIPT_WAIT_MS = 10000
export const RETYPE_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000, 900000] as const
export const NOT_NOW_RETRY_MS = [5000, 10000, 20000, 40000, 60000] as const
export const DELIVERY_MAX_AD_CALLS_PER_S = 4
export const DELIVERY_ROW_POLL_MS = 1000

export const DELIVERY_STUCK_AFTER_MS = 300000

/**
 * Enrollment metadata (root lookup, `files.info`, `conversations.info`): one
 * end-to-end deadline per attempt, covering SDK queueing, retries and
 * rate-limit waits as well as the HTTP request. Root lookup gets no longer
 * bound than any other metadata.
 */
export const ENROLLMENT_METADATA_DEADLINE_MS = 15_000
/** Retry spacing after a failed or expired attempt: bounded exponential from the minimum. */
export const ENROLLMENT_RETRY_MIN_MS = 5_000
export const ENROLLMENT_RETRY_MAX_MS = 60_000
/** Longest single timer; a longer wait (a large Retry-After) is re-armed in chunks. */
export const ENROLLMENT_TIMER_MAX_MS = 2_147_483_647
/**
 * Fallback only: allowance between the host clock and Slack's message
 * timestamps when a looked-up own root can only be matched to the
 * issue-to-confirmation window of a root-level text post Slack returned no
 * timestamp for (an upload is matched by its file ID, without a clock). The
 * window never starts before the lifetime's start. A root outside it is left
 * undecided and reported, never recorded as not the persona's own.
 */
export const OWN_ROOT_CLOCK_SKEW_MS = 120_000

/**
 * The SR-4.3 repair bound for unresolved enrollment evidence, once the
 * missing fact is available: the remaining in-flight deadline, plus the next
 * permitted retry wait (the local maximum or a greater Retry-After), plus one
 * successful resolution attempt. A recovery pass ends at its first expired
 * deadline or failure showing the dependency is down (a server or
 * rate-limit error, or a transport failure), so at most one in-flight
 * deadline precedes the next wait however many items are pending. A request
 * Slack rejects for a reason of its own (an unrecognised error) ends only
 * that item, which is retried at the same spacing, so it never holds back
 * the items after it. Once the dependency answers, one pass resolves a
 * persona's items one after another, so the k-th item of a pass adds the
 * (k − 1) resolutions or rejections before it, each itself within one
 * deadline. Persistence after a successful resolution is the queue's
 * serialized fsync write and is not included. Expiry alone proves no missing
 * fact and reports no recovery.
 */
export function enrollmentRepairBoundMs(remainingDeadlineMs = ENROLLMENT_METADATA_DEADLINE_MS, retryAfterSeconds?: number): number {
  const retryAfter = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : 0
  return Math.max(0, remainingDeadlineMs) + Math.max(ENROLLMENT_RETRY_MAX_MS, retryAfter) + ENROLLMENT_METADATA_DEADLINE_MS
}
