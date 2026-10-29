/**
 * participation-metadata.ts — The chunked wait enrollment uses between
 * metadata attempts. The bounded attempts themselves and their retry spacing
 * live in `thread-memory.ts`.
 *
 * SPDX-License-Identifier: MIT
 */

import { ENROLLMENT_TIMER_MAX_MS } from './delivery-constants.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'

/**
 * Wait `delayMs` on `clock`, re-arming in chunks no longer than one timer
 * can hold, so a large Retry-After neither overflows nor fires early.
 * Resolves false when `signal` aborts first.
 */
export function waitFor(clock: PersonaConnectionClock, delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    if (signal.aborted) { resolve(false); return }
    const until = clock.now() + Math.max(0, delayMs)
    let timer: unknown
    const abort = () => { if (timer !== undefined) clock.clearTimeout(timer); resolve(false) }
    const arm = () => {
      const remaining = until - clock.now()
      if (remaining <= 0) { signal.removeEventListener('abort', abort); resolve(true); return }
      timer = clock.setTimeout(arm, Math.min(remaining, ENROLLMENT_TIMER_MAX_MS))
    }
    signal.addEventListener('abort', abort, { once: true })
    arm()
  })
}
