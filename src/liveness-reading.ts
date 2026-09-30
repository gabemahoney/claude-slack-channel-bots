/**
 * liveness-reading.ts — The four readings of a persona's liveness (b.jg5
 * SRJ-314, HO C12), and the map from an agent-director row state to one.
 *
 * The liveness adapter (`_buildIsSessionAliveAdapter`, `src/server.ts`)
 * answers one reading per probe, and `RestartDeps.isSessionAlive`
 * (`src/restart.ts`) and `HealthCheckDeps.isSessionAlive`
 * (`src/health-check.ts`) carry it:
 *
 *   live     a live state other than `pending`
 *   pending  the row reads `pending`: its session has not started
 *   dead     `ended` or `missing`; also `ErrSpawnNotFound`, and
 *            `ErrSystemInstallDisappeared` with its `ad-unreachable` outage
 *            (the adapter decides those errors)
 *   unknown  any other `status` error, and any state string that is none of
 *            the above: agent-director could not report on the persona
 *
 * Only `dead` leads to a kill and a launch. A reading is an object whose
 * `kind` names it, so a `pending` reading can later carry more (its launch
 * start) without changing the consumers of the other three; consumers decide
 * on `livenessKindOf(reading)`.
 *
 * The row states come from agent-director's spawn state machine (SR-11).
 * `AGENT_DIRECTOR_LIVE_STATES` is kept here, the one list of live states, and
 * re-exported by `src/session-manager.ts`, so the restart and health-check
 * modules can import the readings without loading the session manager.
 *
 * Pure: no I/O, clock, module state or log line.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Row states (agent-director's spawn state machine, SR-11)
// ---------------------------------------------------------------------------

/** The row state of a launch whose session has not started. */
export const AGENT_DIRECTOR_PENDING_STATE = 'pending'

/**
 * Live states per SR-11 (agent-director Spawn state machine), `pending`
 * included. Terminal states (`AGENT_DIRECTOR_DEAD_STATES`) and the typed
 * `ErrSpawnNotFound` rejection from `client.status(...)` are treated as dead
 * by callers.
 */
export const AGENT_DIRECTOR_LIVE_STATES: ReadonlySet<string> = new Set([
  AGENT_DIRECTOR_PENDING_STATE,
  'waiting',
  'working',
  'ask_user',
  'check_permission',
])

/** The terminal row states: the persona's claude process is gone. */
export const AGENT_DIRECTOR_DEAD_STATES: ReadonlySet<string> = new Set(['ended', 'missing'])

// ---------------------------------------------------------------------------
// Readings (b.jg5 SRJ-314)
// ---------------------------------------------------------------------------

/** `live`: a live state other than `pending`. */
export const LIVENESS_LIVE = 'live'
/** `pending`: the row reads `pending`; its session has not started. */
export const LIVENESS_PENDING = 'pending'
/** `dead`: `ended`, `missing`, `ErrSpawnNotFound` or `ErrSystemInstallDisappeared`. The only reading that leads to a kill and a launch. */
export const LIVENESS_DEAD = 'dead'
/** `unknown`: agent-director could not report on the persona. Never read as dead. */
export const LIVENESS_UNKNOWN = 'unknown'

/** Every reading's kind. */
export const LIVENESS_KINDS = [LIVENESS_LIVE, LIVENESS_PENDING, LIVENESS_DEAD, LIVENESS_UNKNOWN] as const

/** One reading's kind. */
export type LivenessKind = (typeof LIVENESS_KINDS)[number]

/** The `live` reading. */
export interface LiveLivenessReading {
  readonly kind: typeof LIVENESS_LIVE
}

/** The `pending` reading. */
export interface PendingLivenessReading {
  readonly kind: typeof LIVENESS_PENDING
}

/** The `dead` reading. */
export interface DeadLivenessReading {
  readonly kind: typeof LIVENESS_DEAD
}

/** The `unknown` reading. */
export interface UnknownLivenessReading {
  readonly kind: typeof LIVENESS_UNKNOWN
}

/** What one liveness probe answers (b.jg5 SRJ-314). */
export type LivenessReading =
  | LiveLivenessReading
  | PendingLivenessReading
  | DeadLivenessReading
  | UnknownLivenessReading

/** The `live` reading, as a value. */
export const LIVENESS_READING_LIVE: LiveLivenessReading = Object.freeze({ kind: LIVENESS_LIVE })
/** The `pending` reading, as a value. */
export const LIVENESS_READING_PENDING: PendingLivenessReading = Object.freeze({ kind: LIVENESS_PENDING })
/** The `dead` reading, as a value. */
export const LIVENESS_READING_DEAD: DeadLivenessReading = Object.freeze({ kind: LIVENESS_DEAD })
/** The `unknown` reading, as a value. */
export const LIVENESS_READING_UNKNOWN: UnknownLivenessReading = Object.freeze({ kind: LIVENESS_UNKNOWN })

const KINDS: ReadonlySet<unknown> = new Set<unknown>(LIVENESS_KINDS)

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * The reading for a row state `status` answered: `pending` gives `pending`;
 * every other state in `AGENT_DIRECTOR_LIVE_STATES` gives `live`; `ended` and
 * `missing` give `dead`; any other value gives `unknown` (SRJ-314's `dead`
 * list is closed, so a state CSCB does not know is never read as dead).
 */
export function livenessReadingForState(state: unknown): LivenessReading {
  if (typeof state !== 'string') return LIVENESS_READING_UNKNOWN
  if (state === AGENT_DIRECTOR_PENDING_STATE) return LIVENESS_READING_PENDING
  if (AGENT_DIRECTOR_LIVE_STATES.has(state)) return LIVENESS_READING_LIVE
  if (AGENT_DIRECTOR_DEAD_STATES.has(state)) return LIVENESS_READING_DEAD
  return LIVENESS_READING_UNKNOWN
}

/**
 * The kind of a probe's answer: its `kind` when it is one of the four,
 * otherwise `unknown` (an answer that is not a reading is never read as
 * dead). Never throws.
 */
export function livenessKindOf(reading: unknown): LivenessKind {
  try {
    if (typeof reading !== 'object' || reading === null) return LIVENESS_UNKNOWN
    const kind = (reading as { readonly kind?: unknown }).kind
    return KINDS.has(kind) ? (kind as LivenessKind) : LIVENESS_UNKNOWN
  } catch {
    return LIVENESS_UNKNOWN
  }
}
