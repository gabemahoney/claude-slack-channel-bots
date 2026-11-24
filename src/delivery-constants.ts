
/** Production timing and load bounds; replay injects these. */
export const ENTER_DELAY_MS = 500
export const RECEIPT_WAIT_MS = 10000
export const RETYPE_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000, 900000] as const
export const NOT_NOW_RETRY_MS = [5000, 10000, 20000, 40000, 60000] as const
export const DELIVERY_MAX_AD_CALLS_PER_S = 4
export const DELIVERY_ROW_POLL_MS = 1000

export const DELIVERY_STUCK_AFTER_MS = 300000

/**
 * A Thread Memory lookup: one end-to-end deadline per attempt, covering SDK
 * queueing, retries and rate-limit waits as well as the HTTP request. No
 * lookup gets a longer bound than another.
 */
export const THREAD_MEMORY_LOOKUP_DEADLINE_MS = 15_000
/** Retry spacing after a failed or expired lookup attempt: bounded exponential from the minimum. */
export const THREAD_MEMORY_RETRY_MIN_MS = 5_000
export const THREAD_MEMORY_RETRY_MAX_MS = 60_000
/**
 * Allowance between the host clock and Slack's message timestamps when an
 * own post's issue time is compared with them: a Post Hold's coverage of a
 * new channel message, and the range an own-post lookup reads.
 */
export const OWN_ROOT_CLOCK_SKEW_MS = 120_000
/** Longest reply wait for an own post, on the monotonic clock from receipt of the stored delivery. */
export const THREAD_REPLY_HOLD_MS = 3_000
/** Bound a Thread Memory loss report, including the notifier's persona prefix. */
export const THREAD_MEMORY_NOTICE_MAX_CHARS = 4000
/** Give acceptance stores a short quiet window without starving maintenance.
 * SR-8.2 burst evidence sets this value under SR-2.4.5; see Bug b.gkw
 * ## Validation. */
export const THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS = 100
/** Bound each synchronous temp-image write before yielding to socket I/O. */
export const THREAD_MEMORY_REWRITE_CHUNK_BYTES = 256 * 1024
/** Bound unsynced temp-image bytes with a separate async fsync every four pieces. */
export const THREAD_MEMORY_REWRITE_FSYNC_BYTES = 4 * THREAD_MEMORY_REWRITE_CHUNK_BYTES
/** Bound shared-state notices; their diagnostics retain the entire channel list. */
export const SHARED_STATE_NOTICE_MAX_CHANNELS = 20
