/**
 * reload-timer.ts — The production driver of the reload detection tick
 * (b.av2 SR-8.2): one serialized, self-re-arming 5 s timer, in the
 * `cron-scheduler.ts` pattern. There is no file watcher.
 *
 * `createReloadTickDriver(deps)` returns a `ReloadTickDriver` (the interface
 * the reload controller declares; tests use a manual driver instead):
 *
 * - a setTimeout chain, never setInterval: the next pass is armed only after
 *   the previous pass has settled, `RELOAD_TICK_INTERVAL_MS` after its end,
 *   so passes never overlap and exactly one timer is pending between passes;
 * - the first pass runs at the first 5 s mark after `start`, not at once:
 *   `start` itself runs nothing and arms exactly one timer. Five seconds after
 *   the start's bring-up pass returns, the pending state is current with no
 *   operator action;
 * - a pass that throws or rejects is logged once, as one token-free line
 *   (`describeThrownValue`), and the chain carries on;
 * - `stop` cancels the pending timer and ends the chain, including while a
 *   pass is running (it is not re-armed after it settles). Idempotent;
 * - single-use, like `createCronScheduler`'s handle: a second `start`, or a
 *   `start` after `stop`, is a logged no-op. To restart, build a new driver.
 *
 * Importable without side effects (b.av2 SR-13.1): nothing is armed, read or
 * logged at import or at `createReloadTickDriver`. The clock and the log sink
 * are injected; the real timers are the default.
 *
 * SPDX-License-Identifier: MIT
 */

import { describeThrownValue } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'
import type { ReloadTick, ReloadTickDriver } from './reload.ts'

/** Time from the end of one detection pass to the start of the next (b.av2 SR-8.2). */
export const RELOAD_TICK_INTERVAL_MS = 5_000

/** The timers the driver arms (the shared fake clock satisfies it in tests). */
export type ReloadTimerClock = Pick<PersonaConnectionClock, 'setTimeout' | 'clearTimeout'>

/** Dependencies of `createReloadTickDriver`. */
export interface ReloadTickDriverDeps {
  /** Receives each `[slack]` line the driver logs (the server log). */
  log: (line: string) => void
  /** Timers; the real ones by default. */
  clock?: ReloadTimerClock
}

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/** Build the production detection-tick driver; see the module comment. */
export function createReloadTickDriver(deps: ReloadTickDriverDeps): ReloadTickDriver {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  let tick: ReloadTick | undefined
  let timer: TimerBox | undefined
  let started = false
  let stopped = false

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not break the chain */
    }
  }

  function arm(): void {
    const box: TimerBox = { handle: undefined }
    timer = box
    box.handle = clock.setTimeout(() => {
      if (timer !== box) return
      timer = undefined
      void runPass()
    }, RELOAD_TICK_INTERVAL_MS)
  }

  /** One pass, then the next arm unless stopped meanwhile. Never rejects. */
  async function runPass(): Promise<void> {
    try {
      await tick?.()
    } catch (err) {
      log(`[slack] reload: detection check failed: ${describeThrownValue(err)}; checking again in ${RELOAD_TICK_INTERVAL_MS / 1000} s`)
    }
    if (!stopped) arm()
  }

  return {
    start(t) {
      if (started) {
        log('[slack] reload: detection timer start() called more than once — ignoring (the timer is single-use)')
        return
      }
      if (stopped) {
        log('[slack] reload: detection timer start() called after stop() — ignoring (the timer is single-use)')
        return
      }
      started = true
      tick = t
      arm()
    },
    stop() {
      stopped = true
      const box = timer
      if (box === undefined) return
      timer = undefined
      clock.clearTimeout(box.handle)
    },
  }
}
