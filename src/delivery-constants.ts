/** Production timing and load bounds (b.omv SR-5/6); replay injects these. */
export const LAUNCH_SETTLE_MS = 1000
export const ENTER_DELAY_MS = 500
export const ENTER_ONLY_RETRY_MS = 2000
export const RECEIPT_WAIT_MS = 10000
export const RETYPE_BACKOFF_MS = [10000, 30000, 60000, 120000, 300000, 900000] as const
export const NOT_NOW_RETRY_MS = [5000, 10000, 20000, 40000, 60000] as const
export const IDLE_EVIDENCE_MAX_WAIT_MS = 120000
export const DELIVERY_MAX_AD_CALLS_PER_S = 4
export const DELIVERY_ROW_POLL_MS = 1000
export const RECONNECT_BLOCKED_NOTICE_MS = 300000

export const DELIVERY_STUCK_AFTER_MS = 300000
