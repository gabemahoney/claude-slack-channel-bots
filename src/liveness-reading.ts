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
 *            (the adapter decides those errors); the last reads no row, so
 *            its reading carries the source `install-gone`
 *            (`isInstallGoneDeadReading`), which the slow-recovery count
 *            tells apart from a row read (b.jg5 SRJ-610); a row read's
 *            reading carries what it read (`rowRead`: `ended`, `missing`
 *            or `no-row`, `deadRowReadOf`), so the restart path's kill can
 *            record the state its path last read in a latch (b.jg5 SRJ-501)
 *   unknown  any other `status` error, and any state string that is none of
 *            the above: agent-director could not report on the persona
 *
 * Only `dead` leads to a launch, and only its `ErrSystemInstallDisappeared`
 * form, which reads no row, to a kill before it (b.jg5 SRJ-110, SRJ-314):
 * no kill is sent for a row just read `ended`, `missing` or gone. A reading is an object whose
 * `kind` names it; consumers decide on `livenessKindOf(reading)`. A `pending`
 * reading also carries the row's launch start (`launchStartedAt`) when the
 * `status` result showed one (b.jg5 SRJ-115, SRJ-406): read raw, as
 * agent-director wrote it, by `pendingLaunchStartOf`. Nothing here parses or
 * ages it.
 *
 * The row states come from agent-director's spawn state machine (SR-11).
 * `AGENT_DIRECTOR_LIVE_STATES` is kept here, the one list of live states, and
 * re-exported by `src/session-manager.ts`, so the restart and health-check
 * modules can import the readings without loading the session manager.
 *
 * Pure: no I/O, clock, module state or log line. The `status` result's
 * launch start field is typed through CSCB's own Phase 1 declarations
 * (`src/ad-phase1-types.ts`, a type-only import), never through the client.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Phase1StatusResult } from './ad-phase1-types.ts'

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
/** `dead`: `ended`, `missing`, `ErrSpawnNotFound` or `ErrSystemInstallDisappeared`. The only reading that leads to a launch; only its `ErrSystemInstallDisappeared` form leads to a kill before it (b.jg5 SRJ-314). */
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
 * The `dead` reading's source when it came from `ErrSystemInstallDisappeared`
 * (b.jg5 SRJ-314), which reads no row: the reading is `dead` all the same,
 * but it is not a row read of `ended`, `missing` or no row, so it ends no
 * slow-recovery episode (SRJ-610, SRJ-1016; hatch A2).
 */
export const LIVENESS_DEAD_SOURCE_INSTALL_GONE = 'install-gone'

/** A `dead` row read's `rowRead`: the row read `ended`. */
export const LIVENESS_DEAD_ROW_ENDED = 'ended'
/** A `dead` row read's `rowRead`: the row read `missing`. */
export const LIVENESS_DEAD_ROW_MISSING = 'missing'
/** A `dead` row read's `rowRead`: the read answered `ErrSpawnNotFound`, no row. */
export const LIVENESS_DEAD_ROW_NO_ROW = 'no-row'

/** What a `dead` row read found (b.jg5 SRJ-501: the state the path last read). */
export type DeadRowRead = typeof LIVENESS_DEAD_ROW_ENDED | typeof LIVENESS_DEAD_ROW_MISSING | typeof LIVENESS_DEAD_ROW_NO_ROW

/**
 * The `dead` reading. `source` is `LIVENESS_DEAD_SOURCE_INSTALL_GONE` when the
 * reading came from `ErrSystemInstallDisappeared`; absent for a row read
 * (`ended`, `missing`, `ErrSpawnNotFound`). `rowRead` is what a row read
 * found (`ended`, `missing`, or `no-row` for `ErrSpawnNotFound`); absent when
 * no row was read (`ErrSystemInstallDisappeared`, or a reading made with no
 * `status` call).
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

/** What one liveness probe answers (b.jg5 SRJ-314). */
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
/** The `dead` reading from `ErrSystemInstallDisappeared`, which reads no row, as a value. */
export const LIVENESS_READING_DEAD_INSTALL_GONE: DeadLivenessReading = Object.freeze({
  kind: LIVENESS_DEAD,
  source: LIVENESS_DEAD_SOURCE_INSTALL_GONE,
})
/** The `unknown` reading, as a value. */
export const LIVENESS_READING_UNKNOWN: UnknownLivenessReading = Object.freeze({ kind: LIVENESS_UNKNOWN })

const KINDS: ReadonlySet<unknown> = new Set<unknown>(LIVENESS_KINDS)

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * The reading for a row state `status` answered: `pending` gives `pending`;
 * every other state in `AGENT_DIRECTOR_LIVE_STATES` gives `live`; `ended` and
 * `missing` (`AGENT_DIRECTOR_DEAD_STATES`) give `dead` carrying that state as
 * its `rowRead`; any other value gives `unknown` (SRJ-314's `dead`
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
    return KINDS.has(kind) ? (kind as LivenessKind) : LIVENESS_UNKNOWN
  } catch {
    return LIVENESS_UNKNOWN
  }
}

/**
 * Whether a probe's answer is the `dead` reading from
 * `ErrSystemInstallDisappeared` (its `source` is
 * `LIVENESS_DEAD_SOURCE_INSTALL_GONE`); false for every other answer, a row
 * read's `dead` included. Never throws.
 */
export function isInstallGoneDeadReading(reading: unknown): boolean {
  try {
    if (livenessKindOf(reading) !== LIVENESS_DEAD) return false
    return (reading as { readonly source?: unknown }).source === LIVENESS_DEAD_SOURCE_INSTALL_GONE
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
// A `pending` row's launch start (b.jg5 SRJ-115, SRJ-406)
// ---------------------------------------------------------------------------

/**
 * The launch start a `status` result shows for a `pending` row: its
 * `launch_started_at`, raw, when the row reads `pending` and the field is a
 * non-empty string; absent otherwise (no field, `null`, a value that is not a
 * string, or a row in any other state, whose field is ignored). No parsing or
 * ageing. Never throws.
 */
export function pendingLaunchStartOf(result: Phase1StatusResult | null | undefined): string | undefined {
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
export function livenessReadingForStatus(result: Phase1StatusResult | null | undefined): LivenessReading {
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
