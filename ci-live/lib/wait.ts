/**
 * wait.ts — bounded polling. Every wait in the runner has a deadline; none
 * sleeps in a loop without one. The clock is injected, so tests drive time.
 */

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
  clock: Clock
}

/**
 * Call `probe` until it returns a value that is not `null`, `undefined` or
 * `false`, or the deadline passes. Returns the value, or `null` on timeout.
 * The probe runs at least once, and is given the deadline (ms on `clock`) so
 * that its own calls can keep to it.
 */
export async function waitFor<T>(
  probe: (deadline: number) => Promise<T | null | undefined | false>,
  options: WaitOptions,
): Promise<T | null> {
  const deadline = options.clock.now() + options.timeoutMs
  for (;;) {
    const value = await probe(deadline)
    if (value !== null && value !== undefined && value !== false) return value
    const left = deadline - options.clock.now()
    if (left <= 0) return null
    await options.clock.sleep(Math.min(options.intervalMs, left))
  }
}

export const SECOND = 1000
export const MINUTE = 60 * SECOND

/** How long a persona has to answer a message (testplan: "wait two minutes", with room). */
export const REPLY_TIMEOUT_MS = 3 * MINUTE
/** Bring-up after a start or restart ("about 3–5 minutes"). */
export const BRINGUP_TIMEOUT_MS = 6 * MINUTE
/** The reload tick notices an edit within about 5 s; allow a few ticks. */
export const RELOAD_TIMEOUT_MS = 45 * SECOND
export const POLL_MS = 5 * SECOND
