/**
 * liveness-reading.ts — The four readings of a persona's liveness (
 * HO C12), and the map from an agent-director row state to one.
 *
 * The liveness adapter (`_buildIsSessionAliveAdapter`, `src/server.ts`)
 * answers one reading per probe, and `RestartDeps.isSessionAlive`
 * (`src/restart.ts`) and `HealthCheckDeps.isSessionAlive`
 * (`src/health-check.ts`) carry it:
 *
 *   live     a live state other than `pending`
 *   pending  the row reads `pending`: its session has not started
 *   dead     `ended`, `missing` or `ErrSpawnNotFound`; the reading carries
 *            what agent-director read (`rowRead`: `ended`, `missing` or
 *            `no-row`, `deadRowReadOf`)
 *   unknown  any other `status` error, including
 *            `ErrSystemInstallDisappeared`, and any state string that is none of
 *            the above: agent-director could not report on the persona
 *
 * Only `dead` leads to a launch; no kill is sent for a row just read
 * `ended`, `missing` or gone. Installation failure supplies no agent-state
 * observation and cannot authorize recovery. A reading is an object whose
 * `kind` names it; consumers decide on `livenessKindOf(reading)`. A `pending`
 * reading also carries the row's launch start (`launchStartedAt`) when the
 * `status` result showed one: read raw, as
 * agent-director wrote it, by `pendingLaunchStartOf`. Nothing here parses or
 * ages it.
 *
 * The row states come from agent-director's spawn state machine.
 * `AGENT_DIRECTOR_LIVE_STATES` is kept here, the one list of live states, and
 * re-exported by `src/session-manager.ts`, so the restart and health-check
 * modules can import the readings without loading the session manager.
 *
 * Pure: no I/O, clock, module state or log line. The `status` result,
 * launch start field included, is typed by the client's own `StatusResult`
 * (a type-only import).
 *
 * SPDX-License-Identifier: MIT
 */

import type { StatusResult } from 'agent-director'

// ---------------------------------------------------------------------------
// Row states (agent-director's spawn state machine)
// ---------------------------------------------------------------------------

/** The row state of a launch whose session has not started. */
export const AGENT_DIRECTOR_PENDING_STATE = 'pending'

/**
 * Live states (agent-director Spawn state machine), `pending`
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
// Readings
// ---------------------------------------------------------------------------

/** `live`: a live state other than `pending`. */
export const LIVENESS_LIVE = 'live'
/** `pending`: the row reads `pending`; its session has not started. */
export const LIVENESS_PENDING = 'pending'
/** `dead`: `ended`, `missing` or `ErrSpawnNotFound`. The only reading that leads to a launch. */
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

/**
 * The `pending` reading. `launchStartedAt` is the row's launch start as the
 * `status` result showed it (raw: an RFC 3339 UTC timestamp as agent-director
 * wrote it, never parsed here), absent when the result showed none.
 */
export interface PendingLivenessReading {
  readonly kind: typeof LIVENESS_PENDING
  readonly launchStartedAt?: string
}

/**
 * Legacy source retained to recognize obsolete dead-shaped readings from
 * `ErrSystemInstallDisappeared`. `livenessKindOf` rejects these as unknown
 * because no agent state was observed.
 */
export const LIVENESS_DEAD_SOURCE_INSTALL_GONE = 'install-gone'

/** A `dead` row read's `rowRead`: the row read `ended`. */
export const LIVENESS_DEAD_ROW_ENDED = 'ended'
/** A `dead` row read's `rowRead`: the row read `missing`. */
export const LIVENESS_DEAD_ROW_MISSING = 'missing'
/** A `dead` row read's `rowRead`: the read answered `ErrSpawnNotFound`, no row. */
export const LIVENESS_DEAD_ROW_NO_ROW = 'no-row'

/** What a `dead` row read found (the state the path last read). */
export type DeadRowRead = typeof LIVENESS_DEAD_ROW_ENDED | typeof LIVENESS_DEAD_ROW_MISSING | typeof LIVENESS_DEAD_ROW_NO_ROW

/**
 * The `dead` reading. `rowRead` is what agent-director found (`ended`,
 * `missing`, or `no-row` for `ErrSpawnNotFound`); absent for caller lifecycle
 * bookkeeping made without a `status` call. The optional `source` accepts
 * the legacy shape for compatibility only: its kind is normalized to
 * `unknown`, so it cannot authorize recovery.
 */
export interface DeadLivenessReading {
  readonly kind: typeof LIVENESS_DEAD
  readonly source?: typeof LIVENESS_DEAD_SOURCE_INSTALL_GONE
  readonly rowRead?: DeadRowRead
}

/** The `unknown` reading. */
export interface UnknownLivenessReading {
  readonly kind: typeof LIVENESS_UNKNOWN
}

/** What one liveness probe answers. */
export type LivenessReading =
  | LiveLivenessReading
  | PendingLivenessReading
  | DeadLivenessReading
  | UnknownLivenessReading

/** The `live` reading, as a value. */
export const LIVENESS_READING_LIVE: LiveLivenessReading = Object.freeze({ kind: LIVENESS_LIVE })
/** The `pending` reading with no launch start, as a value. */
export const LIVENESS_READING_PENDING: PendingLivenessReading = Object.freeze({ kind: LIVENESS_PENDING })
/** The `dead` reading with no row state read (no `status` call was made), as a value. */
export const LIVENESS_READING_DEAD: DeadLivenessReading = Object.freeze({ kind: LIVENESS_DEAD })
/** The `dead` reading of a row read `ended`, as a value. */
export const LIVENESS_READING_DEAD_ENDED: DeadLivenessReading = Object.freeze({
  kind: LIVENESS_DEAD,
  rowRead: LIVENESS_DEAD_ROW_ENDED,
})
/** The `dead` reading of a row read `missing`, as a value. */
export const LIVENESS_READING_DEAD_MISSING: DeadLivenessReading = Object.freeze({
  kind: LIVENESS_DEAD,
  rowRead: LIVENESS_DEAD_ROW_MISSING,
})
/** The `dead` reading of a `status` that answered `ErrSpawnNotFound` (no row), as a value. */
export const LIVENESS_READING_DEAD_NO_ROW: DeadLivenessReading = Object.freeze({
  kind: LIVENESS_DEAD,
  rowRead: LIVENESS_DEAD_ROW_NO_ROW,
})
/** The `unknown` reading, as a value. */
export const LIVENESS_READING_UNKNOWN: UnknownLivenessReading = Object.freeze({ kind: LIVENESS_UNKNOWN })
/** @deprecated Legacy name; installation failure is unknown, never dead. */
export const LIVENESS_READING_DEAD_INSTALL_GONE: UnknownLivenessReading = LIVENESS_READING_UNKNOWN

const KINDS: ReadonlySet<unknown> = new Set<unknown>(LIVENESS_KINDS)

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * The reading for a row state `status` answered: `pending` gives `pending`;
 * every other state in `AGENT_DIRECTOR_LIVE_STATES` gives `live`; `ended` and
 * `missing` (`AGENT_DIRECTOR_DEAD_STATES`) give `dead` carrying that state as
 * its `rowRead`; any other value gives `unknown` (`dead`
 * list is closed, so a state CSCB does not know is never read as dead).
 */
export function livenessReadingForState(state: unknown): LivenessReading {
  if (typeof state !== 'string') return LIVENESS_READING_UNKNOWN
  if (state === AGENT_DIRECTOR_PENDING_STATE) return LIVENESS_READING_PENDING
  if (AGENT_DIRECTOR_LIVE_STATES.has(state)) return LIVENESS_READING_LIVE
  if (state === LIVENESS_DEAD_ROW_ENDED) return LIVENESS_READING_DEAD_ENDED
  if (state === LIVENESS_DEAD_ROW_MISSING) return LIVENESS_READING_DEAD_MISSING
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
    if (kind === LIVENESS_DEAD &&
        (reading as { readonly source?: unknown }).source === LIVENESS_DEAD_SOURCE_INSTALL_GONE) {
      return LIVENESS_UNKNOWN
    }
    return KINDS.has(kind) ? (kind as LivenessKind) : LIVENESS_UNKNOWN
  } catch {
    return LIVENESS_UNKNOWN
  }
}

/**
 * Whether an answer has the obsolete install-gone dead shape. Retained for
 * compatibility and rejection by `livenessKindOf`; it is never evidence of
 * agent death. The legacy constant now answers unknown. Never throws.
 */
export function isInstallGoneDeadReading(reading: unknown): boolean {
  try {
    if (typeof reading !== 'object' || reading === null) return false
    const legacy = reading as { readonly kind?: unknown; readonly source?: unknown }
    return legacy.kind === LIVENESS_DEAD && legacy.source === LIVENESS_DEAD_SOURCE_INSTALL_GONE
  } catch {
    return false
  }
}

/**
 * What a probe's `dead` row read found (`rowRead`: `ended`, `missing` or
 * `no-row`); `undefined` for any other answer, a `dead` reading that read no
 * row included. Never throws.
 */
export function deadRowReadOf(reading: unknown): DeadRowRead | undefined {
  try {
    if (livenessKindOf(reading) !== LIVENESS_DEAD) return undefined
    const rowRead = (reading as { readonly rowRead?: unknown }).rowRead
    return rowRead === LIVENESS_DEAD_ROW_ENDED || rowRead === LIVENESS_DEAD_ROW_MISSING || rowRead === LIVENESS_DEAD_ROW_NO_ROW
      ? rowRead
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The `dead` reading carrying `rowRead` (one of the frozen values), or
 * `LIVENESS_READING_DEAD` when there is none.
 */
export function deadLivenessReading(rowRead?: DeadRowRead): DeadLivenessReading {
  switch (rowRead) {
    case LIVENESS_DEAD_ROW_ENDED:
      return LIVENESS_READING_DEAD_ENDED
    case LIVENESS_DEAD_ROW_MISSING:
      return LIVENESS_READING_DEAD_MISSING
    case LIVENESS_DEAD_ROW_NO_ROW:
      return LIVENESS_READING_DEAD_NO_ROW
    default:
      return LIVENESS_READING_DEAD
  }
}

// ---------------------------------------------------------------------------
// A `pending` row's launch start
// ---------------------------------------------------------------------------

/**
 * The launch start a `status` result shows for a `pending` row: its
 * `launch_started_at`, raw, when the row reads `pending` and the field is a
 * non-empty string; absent otherwise (no field, `null`, a value that is not a
 * string, or a row in any other state, whose field is ignored). No parsing or
 * ageing. Never throws.
 */
export function pendingLaunchStartOf(result: StatusResult | null | undefined): string | undefined {
  try {
    if (result === null || result === undefined) return undefined
    if (result.state !== AGENT_DIRECTOR_PENDING_STATE) return undefined
    return nonEmptyString(result.launch_started_at)
  } catch {
    return undefined
  }
}

/**
 * The `pending` reading carrying `launchStartedAt` (frozen), or
 * `LIVENESS_READING_PENDING` when there is none.
 */
export function pendingLivenessReading(launchStartedAt?: string): PendingLivenessReading {
  const start = nonEmptyString(launchStartedAt)
  if (start === undefined) return LIVENESS_READING_PENDING
  return Object.freeze({ kind: LIVENESS_PENDING, launchStartedAt: start })
}

/**
 * The reading for a `status` result: `livenessReadingForState(result.state)`,
 * with a `pending` reading carrying the row's launch start
 * (`pendingLaunchStartOf`). Never throws.
 */
export function livenessReadingForStatus(result: StatusResult | null | undefined): LivenessReading {
  let state: unknown
  try {
    state = result?.state
  } catch {
    return LIVENESS_READING_UNKNOWN
  }
  const reading = livenessReadingForState(state)
  if (reading.kind !== LIVENESS_PENDING) return reading
  return pendingLivenessReading(pendingLaunchStartOf(result))
}

/**
 * The launch start a probe's answer carries: its `launchStartedAt` when it is
 * a `pending` reading and that is a non-empty string; absent otherwise. Never
 * throws.
 */
export function launchStartOfReading(reading: unknown): string | undefined {
  try {
    if (livenessKindOf(reading) !== LIVENESS_PENDING) return undefined
    return nonEmptyString((reading as { readonly launchStartedAt?: unknown }).launchStartedAt)
  } catch {
    return undefined
  }
}

/** `value` when it is a non-empty string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
