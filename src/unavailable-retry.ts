/**
 * unavailable-retry.ts — The per-persona UNAVAILABLE retry timer (b.jg5
 * SRJ-301 code line, SRJ-302, SRJ-304).
 *
 * `createUnavailableRetryController(deps)` builds a controller that keeps at
 * most one retry timer per persona key:
 *
 * - `arm(key, cause)`: when the persona has no timer, its first retry is due
 *   `UNAVAILABLE_RETRY_BASE_S` after now. When it already has one, waiting or
 *   running its retry, the due time and the wait count stay as they are and
 *   only the cause is recorded. A missing cause is recorded as `unnamed`.
 * - At the due time the injected retry action runs once for the persona. An
 *   `again` answer (a refusal) re-arms the timer at the next wait of the one
 *   sequence, measured from the end of the run: 30, 60, 120, 240, 300, 300 …
 *   s, from `doublingBackoffDelay` over `UNAVAILABLE_RETRY_BASE_S` and
 *   `UNAVAILABLE_RETRY_CEILING_S`, with no attempt cap (so the retries fall at
 *   30, 90, 210, 450 and 750 s after the arm, then every 300 s). A `stop`
 *   answer stops the timer. An action that throws or rejects, or answers
 *   anything else, counts as `again`, and its failure is named in the
 *   re-armed line.
 * - If the clock fails while a timer is being set, the persona is forgotten
 *   rather than left armed with no timer: a failed re-arm logs one
 *   `retry run failed` line, a failed first arm logs one `arm failed … — not
 *   armed` line and returns (`arm` never throws), and either way the next
 *   `arm` starts again at the first wait.
 * - Two runs never overlap for one persona: a timer that falls due while an
 *   earlier run for the same key is still in flight (a run that outlived a
 *   `stop` and a new `arm`) waits for that run to settle first.
 * - `stop(key, reason)` clears the pending timer and forgets the persona, so
 *   the next `arm` starts again at the first wait. A run in flight when it is
 *   stopped finishes, but its answer is dropped: it neither re-arms nor stops
 *   a later timer. `stopAll(reason)` stops every persona.
 * - `view(key)`, `isArmed(key)` and `armedKeys()` are read-only queries;
 *   `whenRunSettled(key)` awaits the persona's in-flight run, with its re-arm
 *   or stop.
 *
 * UNAVAILABLE is never a failure here: the restart module's per-persona
 * failure counter and cap latch (`backoff.ts`) are neither read nor written,
 * and nothing gives a persona up. Only the stateless `doublingBackoffDelay`
 * is imported. The timer runs whatever the persona's restart delay and
 * health-check interval are, 0 included: this module reads neither.
 *
 * Each controller keeps its own per-persona entries, and there is no
 * module-scope state, so nothing spans two personas or two controllers.
 * Nothing is armed, read or logged at import or at creation. The clock and
 * timers, the log sink and the retry action are injected; the real clock is
 * the default.
 *
 * Log lines (`[slack] unavailable-retry: persona=<key> …`), one each for
 * armed, retry, re-armed (with the wait), stopped (with the reason),
 * `retry run failed` (the clock failed at a re-arm) and `arm failed … — not
 * armed` (the clock failed at the first arm), go to the injected log only; nothing is posted to Slack. A cause's thrown value
 * and a failed action reach a line only through `describeThrownValue` (its
 * message redacted by `redactSlackLogText`). A cause kind is a fixed label
 * and a stop reason is CSCB-written text; neither carries agent-director
 * failure text.
 *
 * SPDX-License-Identifier: MIT
 */

import { doublingBackoffDelay } from './backoff.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'

// ---------------------------------------------------------------------------
// SRJ-302 constants
// ---------------------------------------------------------------------------

/** First retry wait after the arming outcome, in seconds (b.jg5 SRJ-302). */
export const UNAVAILABLE_RETRY_BASE_S = 30

/** Retry wait ceiling, in seconds (b.jg5 SRJ-302). There is no attempt cap. */
export const UNAVAILABLE_RETRY_CEILING_S = 300

/** A cause kind that is not a short lower-case label is logged as this. */
const UNNAMED_CAUSE_KIND = 'unnamed'

/** A cause kind as logged: a short lower-case label (`unavailable`, `status-error`). */
const CAUSE_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/

/** What `arm` records when it is given no cause (possible from untyped callers). */
const UNNAMED_CAUSE: UnavailableRetryCause = { kind: UNNAMED_CAUSE_KIND }

/** The refusal named in a re-armed line when the answer gave no cause and none was recorded during the run. */
const NO_CAUSE_GIVEN = 'no cause given'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The clock and timers the controller uses (the shared fake clock satisfies it in tests). */
export type UnavailableRetryClock = PersonaConnectionClock

/** What armed a persona's timer, or what a refused retry met. */
export interface UnavailableRetryCause {
  /**
   * A fixed, token-free label for the cause, lower case with hyphens (for
   * example `unavailable` or `status-error`). Recorded once per timer in the
   * order first seen; logged as `unnamed` when it is not such a label.
   */
  readonly kind: string
  /** The thrown value behind the cause, if any. Logged only through `describeThrownValue`, never kept. */
  readonly error?: unknown
}

/** A retry's answer: `again` is a refusal (re-arm at the next wait), `stop` ends the timer. */
export type UnavailableRetryOutcome =
  | { readonly kind: 'again'; readonly cause?: UnavailableRetryCause }
  | { readonly kind: 'stop'; readonly reason: string }

/** What the retry action is told about the retry it runs. */
export interface UnavailableRetryAttempt {
  /** Which retry of this timer this is, from 1. */
  readonly retry: number
  /** The cause kinds recorded since the arm, in the order first seen. */
  readonly causes: readonly string[]
}

/**
 * The retry action: one retry for persona `key`. Answers `again` (a refusal)
 * or `stop` with a CSCB-written reason. A throw or rejection counts as
 * `again`.
 */
export type UnavailableRetryAction = (
  key: string,
  attempt: UnavailableRetryAttempt,
) => UnavailableRetryOutcome | Promise<UnavailableRetryOutcome>

/** Dependencies of `createUnavailableRetryController`. */
export interface UnavailableRetryDeps {
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The retry action run at each due time. */
  action: UnavailableRetryAction
  /** Clock and timers; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  clock?: UnavailableRetryClock
}

/** A read-only view of one persona's timer. */
export interface UnavailableRetryView {
  /** `waiting` for its due time, or `running` its retry. */
  readonly phase: 'waiting' | 'running'
  /** When the next retry is due, in clock milliseconds; absent while running. */
  readonly dueAt?: number
  /** The wait that `dueAt` ends, in milliseconds; absent while running. */
  readonly waitMs?: number
  /** Retries answered `again` (refusals) since the arm. */
  readonly refusals: number
  /** The cause kinds recorded since the arm, in the order first seen. */
  readonly causes: readonly string[]
}

/** The per-persona UNAVAILABLE retry timers of one server. */
export interface UnavailableRetryController {
  /**
   * Arm persona `key`'s timer with `cause`. When not armed, its first retry
   * is due `UNAVAILABLE_RETRY_BASE_S` from now and one armed line is logged.
   * When armed or running, the due time and wait count are kept and only the
   * cause is recorded (no line). A missing cause is recorded as `unnamed`.
   * Never throws: if the clock throws while setting the first timer, the
   * persona is forgotten and one arm failed line is logged.
   */
  arm(key: string, cause: UnavailableRetryCause): void
  /**
   * Stop persona `key`'s timer: clear the pending timer and forget the
   * persona, logging one stopped line with `reason` (CSCB-written text).
   * A no-op, with no line, when it is not armed. A run in flight finishes,
   * but its answer is dropped.
   */
  stop(key: string, reason: string): void
  /** Stop every persona's timer, as `stop` does for each. */
  stopAll(reason: string): void
  /** A snapshot of persona `key`'s timer, or `undefined` when not armed. */
  view(key: string): UnavailableRetryView | undefined
  /** True while persona `key` has a timer, waiting or running. */
  isArmed(key: string): boolean
  /** The keys of every armed persona, in arming order. */
  armedKeys(): string[]
  /**
   * Resolves once persona `key`'s in-flight retry run has settled and its
   * re-arm or stop is done; at once when none is in flight. Never rejects.
   */
  whenRunSettled(key: string): Promise<void>
}

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/** One persona's timer. Replaced, never reused, after a stop. */
interface RetryEntry {
  readonly key: string
  /** The pending timer while waiting; `undefined` while running. */
  timer: TimerBox | undefined
  dueAt: number | undefined
  waitMs: number | undefined
  refusals: number
  /** Cause kinds recorded since the arm, first seen first. */
  readonly causes: string[]
  /** The description of the last cause recorded during the current run, for the re-armed line. */
  runCause: string | undefined
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Build one server's UNAVAILABLE retry controller; see the module comment. */
export function createUnavailableRetryController(deps: UnavailableRetryDeps): UnavailableRetryController {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const entries = new Map<string, RetryEntry>()
  /** Each persona's latest retry run, until it settles. Kept apart from `entries` so a run outlives a stop. */
  const runs = new Map<string, Promise<void>>()

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a persona's retries */
    }
  }

  function isCurrent(entry: RetryEntry): boolean {
    return entries.get(entry.key) === entry
  }

  /** The wait after `refusals` refused retries, in milliseconds. */
  function waitAfter(refusals: number): number {
    return doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, refusals, UNAVAILABLE_RETRY_CEILING_S) * 1000
  }

  /**
   * Set `entry`'s timer for `waitMs`. The entry's timer fields change only
   * once the clock has returned a handle, so a clock that throws leaves them
   * untouched for the caller to forget the entry.
   */
  function schedule(entry: RetryEntry, waitMs: number): void {
    const dueAt = clock.now() + waitMs
    const box: TimerBox = { handle: undefined }
    box.handle = clock.setTimeout(() => {
      if (!isCurrent(entry) || entry.timer !== box) return
      fire(entry)
    }, waitMs)
    entry.timer = box
    entry.waitMs = waitMs
    entry.dueAt = dueAt
  }

  /** Forget `entry` if it is still current, clearing any timer it holds. Never throws. */
  function forget(entry: RetryEntry): void {
    if (!isCurrent(entry)) return
    entries.delete(entry.key)
    try {
      clearTimer(entry)
    } catch {
      /* the entry is gone, so a timer the clock failed to clear fires into a no-op */
    }
  }

  function clearTimer(entry: RetryEntry): void {
    const box = entry.timer
    entry.timer = undefined
    entry.dueAt = undefined
    entry.waitMs = undefined
    if (box !== undefined) clock.clearTimeout(box.handle)
  }

  /** Record `cause`'s kind once, and return its description for a line. */
  function record(entry: RetryEntry, cause: UnavailableRetryCause | undefined): string | undefined {
    if (cause === undefined) return undefined
    const kind = causeKind(cause)
    if (!entry.causes.includes(kind)) entry.causes.push(kind)
    return describeCause(cause)
  }

  function fire(entry: RetryEntry): void {
    clearTimer(entry)
    const prior = runs.get(entry.key)
    const run = (prior ?? Promise.resolve())
      .then(() => runRetry(entry))
      .catch((err) => {
        forget(entry)
        log(`[slack] unavailable-retry: persona=${entry.key} retry run failed: ${describeThrownValue(err)}`)
      })
    runs.set(entry.key, run)
    void run.then(() => {
      if (runs.get(entry.key) === run) runs.delete(entry.key)
    })
  }

  /** One retry: the action once, then a re-arm or a stop. Never rejects. */
  async function runRetry(entry: RetryEntry): Promise<void> {
    if (!isCurrent(entry)) return
    const retry = entry.refusals + 1
    log(`[slack] unavailable-retry: persona=${entry.key} retry ${retry} — rerunning its recovery`)
    let outcome: UnavailableRetryOutcome | undefined
    let failure: string | undefined
    try {
      outcome = await deps.action(entry.key, { retry, causes: [...entry.causes] })
    } catch (err) {
      failure = `the retry failed: ${describeThrownValue(err)}`
    }
    if (!isCurrent(entry)) return
    if (outcome?.kind === 'stop') {
      stopEntry(entry, outcome.reason)
      return
    }
    const answered = outcome?.kind === 'again' ? record(entry, outcome.cause) : undefined
    const unexpected = failure === undefined && outcome?.kind !== 'again' ? 'the retry gave no answer' : undefined
    const refusal = failure ?? unexpected ?? answered ?? entry.runCause ?? NO_CAUSE_GIVEN
    entry.runCause = undefined
    entry.refusals += 1
    const waitMs = waitAfter(entry.refusals)
    schedule(entry, waitMs)
    log(`[slack] unavailable-retry: persona=${entry.key} retry ${retry} refused (${refusal}) — re-armed, next retry in ${waitMs / 1000} s`)
  }

  function stopEntry(entry: RetryEntry, reason: string): void {
    clearTimer(entry)
    entries.delete(entry.key)
    log(`[slack] unavailable-retry: persona=${entry.key} stopped — ${reason}`)
  }

  return {
    arm(key, given) {
      const cause = given ?? UNNAMED_CAUSE
      const existing = entries.get(key)
      if (existing !== undefined) {
        const description = record(existing, cause)
        if (existing.timer === undefined) existing.runCause = description
        return
      }
      const entry: RetryEntry = {
        key,
        timer: undefined,
        dueAt: undefined,
        waitMs: undefined,
        refusals: 0,
        causes: [],
        runCause: undefined,
      }
      entries.set(key, entry)
      const description = record(entry, cause)
      const waitMs = waitAfter(0)
      try {
        schedule(entry, waitMs)
      } catch (err) {
        forget(entry)
        log(`[slack] unavailable-retry: persona=${key} arm failed: ${describeThrownValue(err)} — not armed`)
        return
      }
      log(`[slack] unavailable-retry: persona=${key} armed (${description}) — first retry in ${waitMs / 1000} s`)
    },

    stop(key, reason) {
      const entry = entries.get(key)
      if (entry !== undefined) stopEntry(entry, reason)
    },

    stopAll(reason) {
      for (const entry of [...entries.values()]) stopEntry(entry, reason)
    },

    view(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      const causes = [...entry.causes]
      if (entry.timer === undefined) return { phase: 'running', refusals: entry.refusals, causes }
      return { phase: 'waiting', dueAt: entry.dueAt, waitMs: entry.waitMs, refusals: entry.refusals, causes }
    },

    isArmed: (key) => entries.has(key),

    armedKeys: () => [...entries.keys()],

    async whenRunSettled(key) {
      await runs.get(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A cause's kind as recorded and logged: the label, or `unnamed` when it is not one. */
function causeKind(cause: UnavailableRetryCause): string {
  try {
    const kind = cause.kind
    return typeof kind === 'string' && CAUSE_KIND_RE.test(kind) ? kind : UNNAMED_CAUSE_KIND
  } catch {
    return UNNAMED_CAUSE_KIND
  }
}

/** `<kind>`, or `<kind>: <describeThrownValue(error)>` when the cause carries a thrown value. Never throws. */
function describeCause(cause: UnavailableRetryCause): string {
  const kind = causeKind(cause)
  try {
    return 'error' in cause && cause.error !== undefined ? `${kind}: ${describeThrownValue(cause.error)}` : kind
  } catch {
    return kind
  }
}
