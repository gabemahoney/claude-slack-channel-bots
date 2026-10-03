/**
 * live-row-sequence.ts — The live-row sequence (b.jg5 SRJ-705, SRJ-706,
 * SRJ-717): the one way persona P's live row `cscb_<key>` (`pending`
 * included) is replaced, or, with no launch at the end, an old life's row
 * ended.
 *
 * The steps, in order (`runLiveRowSequence`):
 *   1. one kill, checked, with the bounded retry (`src/kill-retry.ts`): a
 *      non-success aborts the sequence by its class, and the retry's
 *      kill-failure alert decision is raised (SRJ-702, SRJ-704). A starter
 *      that made the first kill itself enters at step 2.
 *   2. one `get`: a `pending` row is waited on until G past its launch start
 *      (`armPendingRowWait`, `src/pending-row.ts`, with the G accessor
 *      itself; never from `started_at`; SRJ-406, SRJ-210). A
 *      row with no launch start has no wait; a configured persona's own such
 *      row has latched P through the shared read, which stops the sequence
 *      (SRJ-513). A row read `ended`, `missing` or absent here still goes on
 *      to step 3.
 *   3. up to three bypassing `find-missing` runs, 5 s apart, the first at
 *      once, each followed by one `get`: `ended`, `missing` or no row goes to
 *      step 6. A run that puts a `pending` row in neither `ids` nor
 *      `unverified_ids` did not judge it, and the sequence stops that episode
 *      at once (SRJ-717). A run refused by class (SRJ-120's refusal) ends the
 *      sequence without its launch; a run that latched P stops it; any other
 *      failed run judges nothing and the step goes on.
 *   4. one more kill as in step 1, a 5 s pause, one more run and one more
 *      `get`, read as in step 3.
 *   5. the row still live after at least one run that judged it: the
 *      kill-failure alert's ordinary version with no description, and the
 *      sequence ends without its launch. With no run that judged it, no
 *      alert, and the sequence ends without its launch.
 *   6. the launch, for a request that ends in one: a `resume` when the row
 *      has a session id and P keeps its conversation, otherwise a reuse spawn
 *      of the same id (`decideLiveRowLaunchKind`), made through the session
 *      manager's sequence-launch entry, whose reuse is the session manager's
 *      one reuse spawn (SRJ-112). A launch whose result is no success
 *      (`liveRowLaunchSucceeded`: `failed`, `retrying`, `deferred`, `latched`, `held`), a reuse
 *      that collided with a live row (not launched, `reuse-collision`), a
 *      `resume` that answered `ErrSpawnNotResumable` (not launched, after the
 *      entry's one re-read of the row: `not-resumable` for a lost race,
 *      `not-resumable-pending` for a launch in progress; SRJ-710, never a
 *      second sequence) or a launch that throws ends the sequence without
 *      its launch, with no further call: no delete, no kill and no further
 *      launch. A re-read that latched P (`not-resumable-latched`) stops the
 *      sequence as a latch does. The no-launch form (an old-life wait) ends
 *      as "row finished".
 * At most 4 runs and 2 kills (each with its tries) per sequence.
 *
 * What a step may do (SRJ-706): before every agent-director call the
 * sequence asks whether it was stopped (P's latch, its teardown, shutdown:
 * the stop signal) or P is latched, and makes no call when so; no kill is
 * made of a row last read `pending` while P's `ad-config-malformed` outage is
 * raised (SRJ-316); every kill's retry is seeded with the state last read and
 * keeps going only while the sequence is neither stopped nor P latched. An
 * answer that arrives once the stop signal is set for a teardown or shutdown
 * (a kill's, a `get`'s, a run's, the step-6 launch's, a latch's, a
 * dependency's throw) is dropped
 * with one line: the sequence ends stopped, with no further call, no latch,
 * no alert and no arm. A kill whose tries the keep-going check stopped raises
 * only the retry's log-only alert (`stopped`) and ends the sequence stopped:
 * with the stop signal's reason when it is set, else `latched` when P is
 * latched, else `not-up` (the server's keep-going query stopped the tries:
 * P is not up or the server is stopping). A stop for P's latch (the
 * latch's set observer, which also fires for the sequence's own latching
 * call) drops no answer: it is handled as for a latched P, and the sequence
 * makes no call after it. A
 * `get` that fails ends the sequence without its launch; a `get` that
 * latched P stops it. A kill CONFLICT latches P with the refused operation
 * "P's next check or recovery" and is never sent again; an UNUSABLE NAME
 * latches it too; in the no-launch form neither latches (its starter routes
 * them).
 *
 * Every end without the launch arms P's retry timer through the injected arm
 * (SRJ-301): with the not-judged cause after SRJ-717's stop, with the
 * reuse-collision cause after a reuse collision at step 6 (SRJ-112, SRJ-705),
 * with the lost-race cause after a step-6 `resume`'s `ErrSpawnNotResumable`
 * whose re-read found a lost race (SRJ-710), with the other-end cause
 * otherwise, that `ErrSpawnNotResumable` on a row re-read `pending`, a step-6
 * launch that failed or threw
 * included, whether or not the launch's own refusal handling armed it too; a
 * stop for a latch, a teardown, shutdown or a persona that is not up, an
 * abort that latched P, an abort whose version re-check stops the server, a
 * launch that latched P, held it on `ErrInvalidFlags` (SRJ-207) or whose
 * version re-check stops the server, a
 * launch whose `ErrTmuxSessionCreate` armed the timer in pending-only mode
 * itself (SRJ-112, SRJ-113, SRJ-409), and the no-launch form arm nothing
 * here. Nothing here counts a failure: the session manager's
 * sequence-launch entry counts its launch's result once.
 *
 * It runs in the background, through injected dependencies only
 * (`LiveRowSequenceDeps`): every agent-director call, the latch, the alert,
 * the retry arm and the clock are the caller's.
 *
 * The registry (`createLiveRowSequenceRegistry`, SRJ-706, SRJ-811), one per
 * server, schedules the sequences: its start entry starts one without
 * awaiting it and answers at once, at most one per instance id at a time,
 * and at most one ending in a launch per persona; each that ends in a launch
 * runs in its own recovery attempt for P, detached from its starter's (the
 * injected attempt runner), and a no-launch request (an old-life wait, with
 * its own dependencies given at its start) runs outside every attempt; a
 * stop by persona key (P's latch, its teardown) sets the stop signal of P's
 * sequence that ends in a launch and resolves once it has settled, its call
 * in flight returned; a no-launch stop by instance id (the hold's end, the
 * last waiter's teardown) stops only an old-life wait; stop-all and close
 * stop every one, and after close no start is taken. The running query
 * answers by key, and a no-launch query by instance id.
 *
 * A no-launch request's stop for its hold's end (`hold-ended`) drops no
 * answer, as a latch's stop does not: the call in flight is acted on (a
 * kill's tries end as the `hold-ended` success, whose survivor version is
 * raised, SRJ-702; option A), and the wait makes no further call.
 *
 * Its production starters, all through the session manager's start entry
 * `startLiveRowSequence`, are:
 *   - the collision ladder's replacement sites (SRJ-707; the session
 *     manager's replace step, `replacePersonaRow`): a row the ladder cannot
 *     keep (`resume_enabled` false, a `cwd` mismatch, a `config_dir` label
 *     missing or different, the last at a resume and at a `pending` row,
 *     or a retired key's old life: a live row, `pending` included, of a key
 *     recorded as retired with no "new life has begun" mark, SRJ-805)
 *     that it last read live, `pending` included: the collision `get`'s or a
 *     re-read's live state, or a dead-session path's earlier live read only
 *     when that path holds dead evidence (SRJ-609, SRJ-611). Each such
 *     request enters at step 1, seeded with the state the ladder last read,
 *     with the conversation not kept, the retired-key flag set for a retired
 *     key, a launch at the end and the alert context `recovery`, so its
 *     step 6 is a reuse spawn of the same id;
 *   - the collision ladder's `resume` answering `ErrSpawnNotResumable` on a
 *     path that holds dead evidence (SRJ-710, SRJ-611), whose re-read finds
 *     the row in a live state other than `pending`: the same request with
 *     the re-read state as its seed and the conversation kept, so its step 6
 *     is a `resume` when the row has a session id and P may resume it;
 *   - the restart path's reconnect adapter (SRJ-805), for a retired key with
 *     no mark whose row reads live other than `pending`: the same request as
 *     the replacement sites', with the retired-key flag, in place of its
 *     `/mcp reconnect`.
 * The ladder answers `sequence-waiting` whatever the start answers. While
 * P's key is recorded as retired the start entry sets the retired-key flag
 * whatever the starter asked (SRJ-805), and step 6 reads the store again
 * through P's facts, so no sequence ends in a `resume` for a key recorded
 * at its start or while it ran. The request carries the store's reading of
 * the key when its launch attempt began (`retiredAtStart`), which step 6
 * hands its launch unchanged, so a reuse marks a new life only when no
 * recording named the key since (SRJ-806).
 *
 * The module holds no module-scope state, runs nothing at
 * import, and loads neither the session manager, the server, the notifier
 * nor any Slack module. Errors are classified by name through
 * `src/ad-error-class.ts`; agent-director text reaches a line only through
 * the shared redaction.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
} from './ad-error-class.ts'
import { AD_WAIT_NEVER_ENDS, type NeverEarlyWaitClock } from './ad-settings.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  describeKillOutcome,
  killLetsNextStepRun,
  killOutcomeStopsServer,
  type KillFailureClass,
  type KillOutcome,
} from './checked-kill.ts'
import type { KillFailureAlertContext } from './kill-failure-alert.ts'
import {
  KILL_RETRY_END_HOLD_ENDED,
  KILL_RETRY_END_READ_LATCHED,
  KILL_RETRY_END_STOPPED,
  killRetryStopped,
  type KillRetryResult,
  type KillRetryWait,
} from './kill-retry.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
import { describeThrownValue, isSafeIdentifier, renderLogMessageText } from './persona-connection-errors.ts'
import { PENDING_ROW_WAIT_NOT_ARMED, armPendingRowWait, parseLaunchStart, type PendingRowWaitArm } from './pending-row.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The wait between one run's `get` and the next run at step 3, in ms (SRJ-705). */
export const LIVE_ROW_SEQUENCE_RUN_SPACING_MS = 5_000

/** Step 4's pause between its kill and its run, in ms (SRJ-705). */
export const LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS = 5_000

/** The number of runs step 3 makes at most (SRJ-705). */
export const LIVE_ROW_SEQUENCE_STEP3_RUNS = 3

/** The most `find-missing` runs one sequence makes (SRJ-705). */
export const LIVE_ROW_SEQUENCE_MAX_RUNS = 4

/** The most kills one sequence makes, each with its tries (SRJ-705). */
export const LIVE_ROW_SEQUENCE_MAX_KILLS = 2

/** The sequence's site name: its log lines' head and its agent-director calls' log prefix. */
export const LIVE_ROW_SEQUENCE_SITE = 'live-row-sequence'

/** The head of every line the sequence logs. */
export const LIVE_ROW_SEQUENCE_LOG_PREFIX = `[slack] ${LIVE_ROW_SEQUENCE_SITE}:`

/** Entry at step 1: the sequence makes the first kill. */
export const LIVE_ROW_SEQUENCE_ENTRY_KILL = 1
/** Entry at step 2: the starter made the first kill itself (the stuck-launch abort, SRJ-412). */
export const LIVE_ROW_SEQUENCE_ENTRY_GET = 2

/** The step a sequence enters at. */
export type LiveRowSequenceEntryStep = typeof LIVE_ROW_SEQUENCE_ENTRY_KILL | typeof LIVE_ROW_SEQUENCE_ENTRY_GET

/** What the sequence last read of the row when it read no row (`ErrSpawnNotFound`). */
export const LIVE_ROW_SEQUENCE_NO_ROW = 'no-row'

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * What the installed retired-key store said of a persona's key when a launch
 * attempt started (SRJ-806): whether the key was recorded, whether its "new
 * life has begun" mark was set, and its record generation (undefined when
 * the key was not recorded or the generation could not be read). A reuse
 * spawn made in that attempt sets the mark at its success only when the key
 * was recorded then and no recording has named it since, so a launch decided
 * before a recording never marks the life it began as the new one. The
 * sequence never reads it; it hands it to step 6's launch unchanged.
 */
export interface RetiredKeyAttemptStart {
  readonly recorded: boolean
  readonly marked: boolean
  readonly generation: number | undefined
}

/** What a starter asks for. */
export interface LiveRowSequenceRequest {
  /** Persona P's key. */
  readonly key: string
  /** P's reference for the log lines; `persona=<key>` when absent. */
  readonly ref?: string
  /** The row's instance id, `cscb_<key>`. */
  readonly instanceId: string
  /** The row state the starter last read (the seed of step 1's kill retry and of the first run's reading). */
  readonly lastReadState: string
  /** The step the sequence enters at. */
  readonly entryStep: LiveRowSequenceEntryStep
  /** Whether P keeps its conversation (a recovery holding dead evidence, or the abort of its own stuck resumed launch). */
  readonly keepsConversation: boolean
  /** Whether P's key is retired. */
  readonly retiredKey: boolean
  /**
   * The retired-key store's reading of P's key when the launch attempt that
   * started the sequence began (the collision ladder's start, or the start
   * entry's own read, `startLiveRowSequence`), handed to step 6's launch
   * (SRJ-806). Absent: the launch reads the store just before its reuse call.
   */
  readonly retiredAtStart?: RetiredKeyAttemptStart
  /** Whether the sequence ends in a launch; false only for an old-life wait's steps (the no-launch form). */
  readonly launches: boolean
  /** The kill-failure alert's context, one of `src/kill-failure-alert.ts`'s. */
  readonly alertContext: KillFailureAlertContext
}

// ---------------------------------------------------------------------------
// What the dependencies answer
// ---------------------------------------------------------------------------

/** What the sequence reads of a row from a `get`. */
export interface LiveRowSequenceRow {
  readonly state: string
  /** The row's session id; a resume needs a non-empty one. */
  readonly claude_session_id?: unknown
  /** The row's raw launch start, shown on a `pending` row only. */
  readonly launch_started_at?: unknown
  readonly cwd?: string
  readonly labels?: Record<string, string>
}

/** The row last read: its state, or no row. */
export type LiveRowSequenceLastRead =
  | { readonly kind: 'state'; readonly state: string; readonly row?: LiveRowSequenceRow }
  | { readonly kind: typeof LIVE_ROW_SEQUENCE_NO_ROW }

/** A `get` read the row. */
export const LIVE_ROW_READ_ROW = 'row'
/** A `get` answered `ErrSpawnNotFound`: no row. */
export const LIVE_ROW_READ_ABSENT = 'absent'
/** A `get` failed (any error but `ErrSpawnNotFound` and an UNUSABLE NAME answer). */
export const LIVE_ROW_READ_REFUSED = 'refused'
/** A `get` latched P (a `provenance_conflict` note, a `pending` row with no launch start, an UNUSABLE NAME answer). */
export const LIVE_ROW_READ_LATCHED = 'latched'

/** What one `get` of P's row through the shared own-row read answered. */
export type LiveRowSequenceRead =
  | { readonly kind: typeof LIVE_ROW_READ_ROW; readonly row: LiveRowSequenceRow }
  | { readonly kind: typeof LIVE_ROW_READ_ABSENT }
  | { readonly kind: typeof LIVE_ROW_READ_REFUSED; readonly error: unknown }
  | { readonly kind: typeof LIVE_ROW_READ_LATCHED }

/** The run marked the row `missing` (it is in `ids`). */
export const LIVE_ROW_RUN_MARKED_MISSING = 'marked-missing'
/** The run judged the row and left it live (it is in `unverified_ids`). */
export const LIVE_ROW_RUN_LEFT_LIVE = 'judged-left-live'
/** The run judged a row last read live other than `pending` alive (it is in neither list). */
export const LIVE_ROW_RUN_JUDGED_ALIVE = 'judged-alive'
/** The run did not judge a row last read `pending` (it is in neither list; SRJ-717). */
export const LIVE_ROW_RUN_NOT_JUDGED = 'not-judged'
/** The run was refused by class (UNAVAILABLE, ENVIRONMENT, CONFIG, UNCLASSIFIED; SRJ-120). */
export const LIVE_ROW_RUN_REFUSED = 'refused'
/** P is latched once the run is done. */
export const LIVE_ROW_RUN_LATCHED = 'latched'
/** The run failed otherwise: it judged nothing. */
export const LIVE_ROW_RUN_FAILED = 'run-failed'

/** Where one bypassing run put the row, or how it failed. */
export type LiveRowSequenceRunPlacement =
  | typeof LIVE_ROW_RUN_MARKED_MISSING
  | typeof LIVE_ROW_RUN_LEFT_LIVE
  | typeof LIVE_ROW_RUN_JUDGED_ALIVE
  | typeof LIVE_ROW_RUN_NOT_JUDGED
  | typeof LIVE_ROW_RUN_REFUSED
  | typeof LIVE_ROW_RUN_LATCHED
  | typeof LIVE_ROW_RUN_FAILED

const JUDGED_PLACEMENTS: ReadonlySet<string> = new Set<string>([
  LIVE_ROW_RUN_MARKED_MISSING,
  LIVE_ROW_RUN_LEFT_LIVE,
  LIVE_ROW_RUN_JUDGED_ALIVE,
])

// ---------------------------------------------------------------------------
// The launch kind (SRJ-705 step 6)
// ---------------------------------------------------------------------------

/** Step 6 resumes the row. */
export const LIVE_ROW_LAUNCH_RESUME = 'resume'
/** Step 6 spawns the same id with the reuse flag. */
export const LIVE_ROW_LAUNCH_REUSE = 'reuse'

/** Step 6's launch kind. */
export type LiveRowSequenceLaunchKind = typeof LIVE_ROW_LAUNCH_RESUME | typeof LIVE_ROW_LAUNCH_REUSE

/** Resume: every condition holds. */
export const LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION = 'the row has a session id and the persona keeps its conversation'
/** Reuse: the key is retired. */
export const LIVE_ROW_LAUNCH_REASON_RETIRED_KEY = 'the key is retired'
/** Reuse: the starter does not keep the conversation. */
export const LIVE_ROW_LAUNCH_REASON_NOT_KEPT = 'the persona does not keep its conversation'
/** Reuse: the last read found no row. */
export const LIVE_ROW_LAUNCH_REASON_NO_ROW = 'there is no row'
/** Reuse: the row has no session id. */
export const LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID = 'the row has no session id'
/** Reuse: the persona is not in the applied configuration. */
export const LIVE_ROW_LAUNCH_REASON_NOT_APPLIED = 'the persona is not in the applied configuration'
/** Reuse: `resume_enabled` is false. */
export const LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED = 'resume_enabled is false'
/** Reuse: the row's `cwd` differs from the persona's working directory. */
export const LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH = "the row's cwd differs from the persona's working directory"
/** Reuse: the row's `config_dir` label is missing or differs. */
export const LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH = "the row's config_dir label is missing or differs"

/** Why step 6 launches as it does. */
export type LiveRowSequenceLaunchReason =
  | typeof LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION
  | typeof LIVE_ROW_LAUNCH_REASON_RETIRED_KEY
  | typeof LIVE_ROW_LAUNCH_REASON_NOT_KEPT
  | typeof LIVE_ROW_LAUNCH_REASON_NO_ROW
  | typeof LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID
  | typeof LIVE_ROW_LAUNCH_REASON_NOT_APPLIED
  | typeof LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED
  | typeof LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH
  | typeof LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH

/**
 * P's facts for step 6, from the applied configuration and the existing row
 * comparison (`compareRowToPersona`): `resume_enabled`, and whether the
 * row's `cwd` and `config_dir` label match P. A comparison that cannot be
 * made (no row) answers both as matching. `retired` is the installed
 * retired-key store's reading at step 6 (SRJ-805): true while P's key is
 * recorded, marked or not, so a key recorded after the sequence started
 * still ends in a reuse, never a `resume`; absent reads as not recorded.
 */
export interface LiveRowSequencePersonaFacts {
  readonly resumeEnabled: boolean
  readonly cwdMatches: boolean
  readonly configDirMatches: boolean
  readonly retired?: boolean
}

/** What step 6's decision is given. */
export interface LiveRowLaunchKindInput {
  readonly keepsConversation: boolean
  readonly retiredKey: boolean
  /** The row the last `get` read; absent when it read no row. */
  readonly row: Pick<LiveRowSequenceRow, 'claude_session_id'> | undefined
  /** P's facts; absent when P is not in the applied configuration. */
  readonly persona: LiveRowSequencePersonaFacts | undefined
}

/** Step 6's decision: the kind and the reason, for the log line. */
export interface LiveRowLaunchKindDecision {
  readonly kind: LiveRowSequenceLaunchKind
  readonly reason: LiveRowSequenceLaunchReason
}

/**
 * Step 6's launch kind (SRJ-705): `resume` only when the request keeps P's
 * conversation, the key is not retired, a row was read and carries a
 * non-empty session id, P is applied with `resume_enabled` true, and the
 * row's `cwd` and `config_dir` label match P; `reuse` in every other case,
 * with the first reason that holds. Pure; never throws.
 */
export function decideLiveRowLaunchKind(input: LiveRowLaunchKindInput): LiveRowLaunchKindDecision {
  const reuse = (reason: LiveRowSequenceLaunchReason): LiveRowLaunchKindDecision => ({ kind: LIVE_ROW_LAUNCH_REUSE, reason })
  try {
    if (input.retiredKey !== false) return reuse(LIVE_ROW_LAUNCH_REASON_RETIRED_KEY)
    if (input.keepsConversation !== true) return reuse(LIVE_ROW_LAUNCH_REASON_NOT_KEPT)
    if (input.row === undefined) return reuse(LIVE_ROW_LAUNCH_REASON_NO_ROW)
    const sessionId = input.row.claude_session_id
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return reuse(LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID)
    const facts = input.persona
    if (facts === undefined) return reuse(LIVE_ROW_LAUNCH_REASON_NOT_APPLIED)
    if (facts.resumeEnabled !== true) return reuse(LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED)
    if (facts.cwdMatches !== true) return reuse(LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH)
    if (facts.configDirMatches !== true) return reuse(LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH)
    return { kind: LIVE_ROW_LAUNCH_RESUME, reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION }
  } catch {
    return reuse(LIVE_ROW_LAUNCH_REASON_NOT_KEPT)
  }
}

// ---------------------------------------------------------------------------
// The launch's answer
// ---------------------------------------------------------------------------

/** A launch's result as the session manager answers it (its launch result type). */
export interface LiveRowSequenceLaunchResult {
  readonly key: string
  readonly action: string
  readonly stopping?: true
  /**
   * The launch's `ErrTmuxSessionCreate` armed P's retry timer at once in
   * pending-only mode (SRJ-112, SRJ-113, SRJ-409): the sequence arms no
   * cause of its own after it.
   */
  readonly pendingOnlyArmed?: true
}

/**
 * Not launched: the reuse spawn answered `ErrInstanceIdCollision`, so the row
 * is live and nothing was launched (SRJ-112, SRJ-705). Nothing is counted;
 * the end arms the reuse-collision cause.
 */
export const LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION = 'reuse-collision'
/**
 * Not launched: the `resume` answered `ErrSpawnNotFound` and the plain spawn
 * after it answered `ErrInstanceIdCollision`, so the row is live and nothing
 * was launched (SRJ-111, SRJ-713). Nothing is counted; the end arms the
 * collision cause, as for a reuse collision, and that retry's run is the
 * get-then-act (SRJ-705, SRJ-706: none runs inside the sequence).
 */
export const LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION = 'spawn-collision'
/**
 * Not launched: the `resume` answered `ErrSpawnNotResumable` and the re-read
 * of the row found a lost race: a live state other than `pending`, `ended`,
 * `missing` or no row, or the read failed (SRJ-710: no second sequence).
 * Nothing is counted; the end arms the lost-race cause.
 */
export const LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE = 'not-resumable'
/**
 * Not launched: the `resume` answered `ErrSpawnNotResumable` and the re-read
 * found the row `pending`, a launch in progress (SRJ-710: no second
 * sequence). Nothing is counted or posted; the end arms the other-end cause.
 */
export const LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING = 'not-resumable-pending'
/**
 * Not launched: the `resume` answered `ErrSpawnNotResumable` and the re-read
 * latched P (SRJ-710, SRJ-706): the sequence ends stopped for the latch, with
 * nothing armed.
 */
export const LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_LATCHED = 'not-resumable-latched'
/** Not launched: P is not in the applied configuration. */
export const LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED = 'not-applied'
/**
 * Not launched: the sequence was stopped (its teardown, shutdown, P's latch)
 * while its launch waited for another launch of P to settle (SRJ-706: no call
 * once the sequence is stopped).
 */
export const LIVE_ROW_NOT_LAUNCHED_STOPPED = 'stopped'

/** Why step 6 made no launch. */
export type LiveRowSequenceNotLaunchedReason =
  | typeof LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION
  | typeof LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION
  | typeof LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE
  | typeof LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING
  | typeof LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_LATCHED
  | typeof LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED
  | typeof LIVE_ROW_NOT_LAUNCHED_STOPPED

/** The launch call answered. */
export const LIVE_ROW_LAUNCH_ANSWER_LAUNCHED = 'launched'

/**
 * The launch results that are a success: the session manager's launch result
 * actions that leave P's session running (`launchSession` maps each to true).
 * Every other answer of a launch call (`failed`, `deferred`, `latched`,
 * `held`) ends the sequence without its launch. `fresh-retired` is the
 * session manager's `SPAWN_ACTION_FRESH_RETIRED`: a reuse spawn for a
 * retired key that began its new life (SRJ-806, SRJ-112), a success as
 * `spawned` is.
 */
export const LIVE_ROW_LAUNCH_SUCCESS_ACTIONS: ReadonlySet<string> = new Set([
  'spawned',
  'fresh-retired',
  'resumed',
  'reconnected',
  'not-reconnected',
  'no-op',
  'fresh-after-amnesia',
  'fresh-after-inconclusive-amnesia',
])

/** The launch result action of a latched P: the launch latched it, or found it latched. */
export const LIVE_ROW_LAUNCH_RESULT_LATCHED = 'latched'

/**
 * The launch result action of a P held on `ErrInvalidFlags` (SRJ-207): the
 * launch's reuse spawn held it, or the launch found it held. The sequence
 * ends with nothing armed, as for a latch: the hold stops P's retry timer.
 */
export const LIVE_ROW_LAUNCH_RESULT_HELD = 'held'

/**
 * The successes that are a launch call's own (a spawn, a reuse spawn or a
 * `resume` that returned success): the session manager's after-launch step
 * arms P's retry timer in pending-only mode after each (SRJ-301, SRJ-409).
 * A reconnect or a no-op made no launch call.
 */
export const LIVE_ROW_LAUNCH_CALL_SUCCESS_ACTIONS: ReadonlySet<string> = new Set([
  'spawned',
  'fresh-retired',
  'resumed',
  'fresh-after-amnesia',
  'fresh-after-inconclusive-amnesia',
])

/** Whether a launch call's result is a success (`LIVE_ROW_LAUNCH_SUCCESS_ACTIONS`). */
export function liveRowLaunchSucceeded(result: LiveRowSequenceLaunchResult): boolean {
  return LIVE_ROW_LAUNCH_SUCCESS_ACTIONS.has(result.action)
}

/**
 * What the injected launch answers: the launch call's result, or that no
 * launch was made (the session manager's entry answers its own action
 * `LIVE_ROW_OUTCOME_NOT_LAUNCHED` for it).
 */
export type LiveRowSequenceLaunchAnswer =
  | { readonly kind: typeof LIVE_ROW_LAUNCH_ANSWER_LAUNCHED; readonly result: LiveRowSequenceLaunchResult }
  | { readonly kind: typeof LIVE_ROW_OUTCOME_NOT_LAUNCHED; readonly reason: LiveRowSequenceNotLaunchedReason }

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/**
 * Step 6 made its launch call; `result` is the launch's own. A result that is
 * no success (`liveRowLaunchSucceeded`) is an end without the launch.
 */
export const LIVE_ROW_OUTCOME_LAUNCHED = 'launched'
/** Step 6 made no launch (`reason`). An end without the launch. */
export const LIVE_ROW_OUTCOME_NOT_LAUNCHED = 'not-launched'
/** The no-launch form reached step 6: the row is finished. */
export const LIVE_ROW_OUTCOME_ROW_FINISHED = 'row-finished'
/** A run did not judge a `pending` row: the episode stops (SRJ-717). */
export const LIVE_ROW_OUTCOME_NOT_JUDGED = 'not-judged'
/** A kill's standing non-success aborted the sequence by its class. */
export const LIVE_ROW_OUTCOME_ABORTED = 'aborted'
/** Step 5: the row stayed live after runs that judged it; the alert was raised. */
export const LIVE_ROW_OUTCOME_ESCALATED = 'escalated'
/** Step 5 with no run that judged the row: no alert. */
export const LIVE_ROW_OUTCOME_NO_JUDGED_RUN = 'no-judged-run'
/** No kill: the row was last read `pending` while P's `ad-config-malformed` outage is raised (SRJ-316). */
export const LIVE_ROW_OUTCOME_CONFIG_MALFORMED = 'config-malformed-no-kill'
/** A `get` failed. */
export const LIVE_ROW_OUTCOME_READ_REFUSED = 'read-refused'
/** A run was refused by class (SRJ-120). */
export const LIVE_ROW_OUTCOME_RUN_REFUSED = 'run-refused'
/** The sequence was stopped (`reason`). */
export const LIVE_ROW_OUTCOME_STOPPED = 'stopped'
/** A dependency threw; the sequence ends without its launch. */
export const LIVE_ROW_OUTCOME_INTERNAL_ERROR = 'internal-error'

/** P latched (by the sequence's own call, or elsewhere). */
export const LIVE_ROW_STOP_LATCHED = 'latched'
/** P's teardown began. */
export const LIVE_ROW_STOP_TEARDOWN = 'teardown'
/** The server is shutting down. */
export const LIVE_ROW_STOP_SHUTDOWN = 'shutdown'
/** A kill's tries were stopped because P is not up or the server is stopping (the server's keep-going query). */
export const LIVE_ROW_STOP_NOT_UP = 'not-up'
/**
 * A no-launch request only (an old-life wait, SRJ-811): the hold it serves
 * ended. Like a stop for a latch it drops no answer: the call in flight is
 * acted on, a kill's tries end as the `hold-ended` success (SRJ-702; option
 * A), and no further call is made.
 */
export const LIVE_ROW_STOP_HOLD_ENDED = 'hold-ended'

/** Why a sequence stopped. */
export type LiveRowSequenceStopReason =
  | typeof LIVE_ROW_STOP_LATCHED
  | typeof LIVE_ROW_STOP_TEARDOWN
  | typeof LIVE_ROW_STOP_SHUTDOWN
  | typeof LIVE_ROW_STOP_NOT_UP
  | typeof LIVE_ROW_STOP_HOLD_ENDED

/**
 * The stop's cause for a kill retry the sequence's own stop ended (b.jg5
 * SRJ-702), for the stopped retry's one line and entry. Never throws.
 */
export function liveRowStopCauseText(reason: LiveRowSequenceStopReason): string {
  switch (reason) {
    case LIVE_ROW_STOP_TEARDOWN:
      return "its live-row sequence was stopped: the persona's teardown began"
    case LIVE_ROW_STOP_SHUTDOWN:
      return 'its live-row sequence was stopped: the server is shutting down'
    case LIVE_ROW_STOP_NOT_UP:
      return 'its live-row sequence was stopped: the persona is not up'
    case LIVE_ROW_STOP_LATCHED:
      return 'its live-row sequence was stopped: the persona latched'
    case LIVE_ROW_STOP_HOLD_ENDED:
      return 'its old-life wait ended: its hold ended'
    default:
      return 'its live-row sequence was stopped'
  }
}

/**
 * Arm P's retry timer with the not-judged cause (SRJ-717). The same string
 * as the retry controller's cause label for it
 * (`UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED` in `src/unavailable-retry.ts`,
 * not imported here: that module loads Slack modules), so the end line and
 * the controller's lines name the cause alike.
 */
export const LIVE_ROW_ARM_NOT_JUDGED = 'sequence-not-judged'
/**
 * Arm P's retry timer with the other-end cause (SRJ-301). The same string as
 * the retry controller's cause label for it
 * (`UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED`), as for the not-judged cause.
 */
export const LIVE_ROW_ARM_ENDED = 'sequence-ended-without-launch'
/**
 * Arm P's retry timer with the reuse-collision cause (SRJ-112, SRJ-301): a
 * reuse collision at step 6, or a collision of the plain spawn after the
 * `resume`'s `ErrSpawnNotFound` (SRJ-111), ended the sequence without its
 * launch. The same
 * string as the retry controller's cause label for it
 * (`UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION`), as for the other causes.
 */
export const LIVE_ROW_ARM_REUSE_COLLISION = 'reuse-collision'
/**
 * Arm P's retry timer with the lost-race cause (SRJ-710, SRJ-301): step 6's
 * `resume` answered `ErrSpawnNotResumable` and the re-read found a lost race
 * (`LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE`). The same string as the retry
 * controller's cause label for it (`UNAVAILABLE_RETRY_CAUSE_LOST_RACE`), as
 * for the other causes.
 */
export const LIVE_ROW_ARM_LOST_RACE = 'spawn-not-resumable-lost-race'

/** Which retry cause an end arms with; the dependency builder maps it to the retry controller's label, the same string. */
export type LiveRowSequenceArmCause =
  | typeof LIVE_ROW_ARM_NOT_JUDGED
  | typeof LIVE_ROW_ARM_ENDED
  | typeof LIVE_ROW_ARM_REUSE_COLLISION
  | typeof LIVE_ROW_ARM_LOST_RACE

/** What every outcome carries: the counts, and the cause it armed (absent when it armed nothing). */
interface OutcomeCounts {
  /** `find-missing` runs made. */
  readonly runs: number
  /** Kills made (each with its tries). */
  readonly kills: number
  /** Runs that judged the row. */
  readonly judgedRuns: number
  /** The retry cause the end armed, if any. */
  readonly armed?: LiveRowSequenceArmCause
}

/** How a sequence ended. */
export type LiveRowSequenceOutcome = OutcomeCounts &
  (
    | {
        readonly kind: typeof LIVE_ROW_OUTCOME_LAUNCHED
        readonly launchKind: LiveRowSequenceLaunchKind
        readonly reason: LiveRowSequenceLaunchReason
        readonly result: LiveRowSequenceLaunchResult
      }
    | {
        readonly kind: typeof LIVE_ROW_OUTCOME_NOT_LAUNCHED
        readonly launchKind: LiveRowSequenceLaunchKind
        readonly notLaunched: LiveRowSequenceNotLaunchedReason
      }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_ROW_FINISHED }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_NOT_JUDGED; readonly step: 3 | 4 }
    | {
        readonly kind: typeof LIVE_ROW_OUTCOME_ABORTED
        readonly step: 1 | 4
        readonly errorClass: KillFailureClass
        /** True when the abort latched P (a CONFLICT or UNUSABLE NAME in a request that ends in a launch). */
        readonly latched: boolean
      }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_ESCALATED }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_NO_JUDGED_RUN }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_CONFIG_MALFORMED; readonly step: 1 | 4 }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_READ_REFUSED; readonly step: 2 | 3 | 4 }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_RUN_REFUSED; readonly step: 3 | 4 }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_STOPPED; readonly reason: LiveRowSequenceStopReason }
    | { readonly kind: typeof LIVE_ROW_OUTCOME_INTERNAL_ERROR }
  )

/** An outcome before its counts and arm are added. */
type OutcomeBody = DistributiveOmit<LiveRowSequenceOutcome, keyof OutcomeCounts>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// ---------------------------------------------------------------------------
// The stop signal
// ---------------------------------------------------------------------------

/** A sequence's stop signal, as the sequence reads it. */
export interface LiveRowSequenceStopSignal {
  /** Why it was stopped; undefined while not stopped. */
  readonly reason: LiveRowSequenceStopReason | undefined
  /** Call `listener` once when the signal is set (at once when it is set already). Answers an unsubscribe. */
  onStop(listener: () => void): () => void
}

/** A stop signal with its setter (the starter's or the registry's). */
export interface LiveRowSequenceStopHandle extends LiveRowSequenceStopSignal {
  /** Set the signal with `reason`; a second call changes nothing. Answers whether this call set it. */
  stop(reason: LiveRowSequenceStopReason): boolean
}

/** A new stop signal, not set. Its listeners run once, each isolated. */
export function createLiveRowSequenceStop(): LiveRowSequenceStopHandle {
  let reason: LiveRowSequenceStopReason | undefined
  const listeners = new Set<() => void>()
  return {
    get reason() {
      return reason
    },
    onStop(listener) {
      if (reason !== undefined) {
        callIsolated(listener)
        return () => {}
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stop(next) {
      if (reason !== undefined) return false
      reason = next
      const toCall = [...listeners]
      listeners.clear()
      for (const listener of toCall) callIsolated(listener)
      return true
    },
  }
}

/** Run `fn`, ignoring a throw. */
function callIsolated(fn: () => void): void {
  try {
    fn()
  } catch {
    /* a listener's failure changes nothing about the stop */
  }
}

// ---------------------------------------------------------------------------
// The dependencies
// ---------------------------------------------------------------------------

/** What step 1's and step 4's kill is given. */
export interface LiveRowSequenceKillOptions {
  /** The row state last read: the kill retry's seed (`killRetrySeedOfState`). */
  readonly lastReadState: string
  /** The wait between tries; it ends early once the sequence is stopped. */
  readonly wait: KillRetryWait
  /** The retry's keep-going check: false once the sequence is stopped or P is latched. */
  readonly keepGoing: () => boolean
  /**
   * True once the sequence was stopped for its hold's end (a no-launch
   * request's `hold-ended` stop, SRJ-811): an old-life wait's kill takes it
   * as its hold ended (SRJ-702; option A), even when a new hold has begun on
   * the same id since. Absent: never.
   */
  readonly stoppedForHoldEnd?: () => boolean
  /** P's reference for the lines. */
  readonly ref: string
}

/** Every call and service the sequence uses, injected (`buildLiveRowSequenceDeps` in `src/session-manager.ts`). */
export interface LiveRowSequenceDeps {
  /** The clock: the waits, the pause and the spacing (`createFakeClock` satisfies it). */
  readonly clock: NeverEarlyWaitClock
  /** Where the sequence's lines go. A throw is ignored. */
  readonly log: (line: string) => void
  /** Whether P is latched now; a throw counts as latched. */
  isLatched(key: string): boolean
  /** Whether P's `ad-config-malformed` outage is raised; a throw counts as raised. */
  isConfigMalformedRaised(key: string): boolean
  /** G in effect, read at every check of the step-2 wait (the accessor itself, never a copy). */
  readonly graceMs: () => number
  /** One `get` of P's row through the shared own-row read. */
  readRow(key: string, ref: string): Promise<LiveRowSequenceRead>
  /** One bypassing `find-missing` run with P's key as its next-step `get`, read for `instanceId` against `stateBefore`. */
  runFindMissing(key: string, instanceId: string, stateBefore: string): Promise<LiveRowSequenceRunPlacement>
  /** One kill through the bounded retry over the deferred-report persona-kill binding. */
  killWithRetry(key: string, options: LiveRowSequenceKillOptions): Promise<KillRetryResult>
  /** Latch P on a kill's CONFLICT or UNUSABLE NAME with the state last read; answers whether it latched. */
  latchOnKillOutcome(key: string, outcome: KillOutcome, lastRead: LiveRowSequenceLastRead, ref: string): Promise<boolean>
  /**
   * Raise a kill retry's alert decision with the request's context. For tries
   * the sequence's own stop ended, `stopCause` names that stop, and for tries
   * P's latch ended (the keep-going check, or a between-try read that
   * latched P), the latch (`liveRowStopCauseText`; b.jg5 SRJ-702: the stop's
   * cause); absent, the binding tells the cause itself.
   */
  raiseKillAlert(key: string, retried: KillRetryResult, context: KillFailureAlertContext, ref: string, stopCause?: string): void
  /** Raise step 5's alert: the ordinary version with no description, with the request's context. */
  raiseEscalationAlert(key: string, context: KillFailureAlertContext, ref: string): void
  /** P's facts for step 6, against the row last read, the store's retired-key reading included; undefined when P is not applied. */
  personaFacts(key: string, row: LiveRowSequenceRow | undefined): LiveRowSequencePersonaFacts | undefined
  /**
   * Step 6's launch through the session manager's sequence-launch entry. The
   * sequence's stop signal goes with it: a launch that waits for another
   * launch of P to settle makes no call once the signal is set (SRJ-706).
   * The sequence always passes it, and the request's `retiredAtStart`
   * (SRJ-806) as it is.
   */
  launch(
    key: string,
    kind: LiveRowSequenceLaunchKind,
    lastRead: LiveRowSequenceLastRead,
    ref: string,
    stop?: LiveRowSequenceStopSignal,
    retiredAtStart?: RetiredKeyAttemptStart,
  ): Promise<LiveRowSequenceLaunchAnswer>
  /** Arm P's retry timer with the cause; never counted. */
  armRetry(key: string, cause: LiveRowSequenceArmCause): void
}

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

/** A state for a line, only when it is a short identifier. */
function renderState(state: unknown): string {
  return isSafeIdentifier(state) ? state : 'unknown'
}

/** An instance id for a line: redacted, one line, capped. */
function renderId(instanceId: unknown): string {
  const rendered = renderLogMessageText(instanceId)
  return rendered === '' ? 'unknown' : rendered
}

/** An instant for a line, only when it is a finite time. */
function renderInstant(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined
  try {
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

/** The line's head: `[slack] live-row-sequence: <ref>`. */
function head(ref: string): string {
  return `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}`
}

/**
 * The start line:
 *   `[slack] live-row-sequence: <ref>: started at step <n> for <id> (last read <state>; <launch form>; alert context <context>) (b.jg5 SRJ-705)`
 */
export function liveRowSequenceStartLine(ref: string, request: LiveRowSequenceRequest): string {
  const form = request.launches ? 'ends in a launch' : 'no launch (old-life form)'
  return `${head(ref)}: started at step ${request.entryStep} for ${renderId(request.instanceId)} (last read ${renderState(request.lastReadState)}; ${form}; alert context ${request.alertContext}) (b.jg5 SRJ-705)`
}

/**
 * A kill's line, after its tries:
 *   `[slack] live-row-sequence: <ref>: step <n> kill: <describeKillOutcome> after <t> kill(s) and <r> read(s) (end=<end>; alert=<kind>) (b.jg5 SRJ-705, SRJ-702)`
 */
export function liveRowSequenceKillLine(ref: string, step: 1 | 4, retried: KillRetryResult): string {
  return `${head(ref)}: step ${step} kill: ${describeKillOutcome(retried.outcome)} after ${retried.tries} kill(s) and ${retried.reads} read(s) (end=${retried.end}; alert=${retried.alert.kind}) (b.jg5 SRJ-705, SRJ-702)`
}

/**
 * The line for a kill not made under SRJ-316's rule:
 *   `[slack] live-row-sequence: <ref>: step <n>: no kill — the row was last read pending and agent-director refuses its config file (ad-config-malformed) (b.jg5 SRJ-706, SRJ-316)`
 */
export function liveRowSequenceNoKillLine(ref: string, step: 1 | 4): string {
  return `${head(ref)}: step ${step}: no kill — the row was last read pending and agent-director refuses its config file (ad-config-malformed) (b.jg5 SRJ-706, SRJ-316)`
}

/**
 * A `get`'s line:
 *   `[slack] live-row-sequence: <ref>: step <n> get: state=<state> | no row (ErrSpawnNotFound) | failed: <describeReadFailure> | the read latched the persona (b.jg5 SRJ-705, SRJ-114)`
 */
export function liveRowSequenceGetLine(ref: string, step: 2 | 3 | 4, read: LiveRowSequenceRead): string {
  return `${head(ref)}: step ${step} get: ${describeRead(read)} (b.jg5 SRJ-705, SRJ-114)`
}

/** A read's answer, in words; a failure through {@link describeReadFailure}. */
function describeRead(read: LiveRowSequenceRead): string {
  switch (read.kind) {
    case LIVE_ROW_READ_ROW:
      return `state=${renderState(read.row.state)}`
    case LIVE_ROW_READ_ABSENT:
      return 'no row (ErrSpawnNotFound)'
    case LIVE_ROW_READ_REFUSED:
      return `failed: ${describeReadFailure(read.error)}`
    case LIVE_ROW_READ_LATCHED:
      return 'the read latched the persona'
  }
}

/**
 * A failed read, as the kill line reports a failure (b.jg5 SRJ-104): the
 * classification's class, reported name and rendered message
 * (`describeAdErrorClassification`) when it carries a name or a message, so
 * an `ErrUnknownErrorName` reports its `unknownName` and agent-director's own
 * description; else the redacting describer's name and message. Never throws.
 */
function describeReadFailure(error: unknown): string {
  const classification = classifyAdError(error)
  if (classification.reportedName !== undefined || classification.message !== undefined) {
    return describeAdErrorClassification(classification)
  }
  return describeAgentDirectorFailure(error)
}

/**
 * The step-2 wait's armed line (no deadline is rendered from a value that is not finite):
 *   `[slack] live-row-sequence: <ref>: step 2: waiting on the pending row until G past its launch start (launch start=<iso>; G=<n> ms[; deadline=<iso>]) (b.jg5 SRJ-705, SRJ-406)`
 */
export function liveRowSequenceWaitArmedLine(ref: string, launchStartMs: number, graceMs: number): string {
  const start = renderInstant(launchStartMs) ?? 'unknown'
  const grace = Number.isFinite(graceMs) ? `${graceMs} ms` : 'beyond any wait (it never ends while so set)'
  const deadline = Number.isFinite(graceMs) ? renderInstant(launchStartMs + graceMs) : undefined
  return `${head(ref)}: step 2: waiting on the pending row until G past its launch start (launch start=${start}; G=${grace}${deadline === undefined ? '' : `; deadline=${deadline}`}) (b.jg5 SRJ-705, SRJ-406)`
}

/**
 * The step-2 wait's end line:
 *   `[slack] live-row-sequence: <ref>: step 2: G has passed since the launch start — the runs begin (b.jg5 SRJ-705, SRJ-406)`
 */
export function liveRowSequenceWaitEndedLine(ref: string): string {
  return `${head(ref)}: step 2: G has passed since the launch start — the runs begin (b.jg5 SRJ-705, SRJ-406)`
}

/**
 * The step-2 line when a `pending` row has no launch start (an old key's row; SRJ-408):
 *   `[slack] live-row-sequence: <ref>: step 2: the pending row has no launch start — no wait (b.jg5 SRJ-705, SRJ-408)`
 */
export function liveRowSequenceNoWaitLine(ref: string): string {
  return `${head(ref)}: step 2: the pending row has no launch start — no wait (b.jg5 SRJ-705, SRJ-408)`
}

/** A placement, in words. */
function describePlacement(placement: LiveRowSequenceRunPlacement): string {
  switch (placement) {
    case LIVE_ROW_RUN_MARKED_MISSING:
      return 'marked missing (in ids)'
    case LIVE_ROW_RUN_LEFT_LIVE:
      return 'judged and left live (in unverified_ids)'
    case LIVE_ROW_RUN_JUDGED_ALIVE:
      return 'judged alive (in neither list; last read live, not pending)'
    case LIVE_ROW_RUN_NOT_JUDGED:
      return 'not judged (a pending row in neither list) — the episode stops'
    case LIVE_ROW_RUN_REFUSED:
      return 'run refused — the sequence ends without its launch'
    case LIVE_ROW_RUN_LATCHED:
      return 'the persona is latched after the run'
    case LIVE_ROW_RUN_FAILED:
      return 'run failed — it judged nothing; the step goes on'
  }
}

/**
 * A run's line, with one tag group (SRJ-717 added for a run that did not judge the row):
 *   `[slack] live-row-sequence: <ref>: step <n> run <k> of <max>: <placement> (b.jg5 SRJ-705, SRJ-120[, SRJ-717])`
 */
export function liveRowSequenceRunLine(ref: string, step: 3 | 4, runNumber: number, placement: LiveRowSequenceRunPlacement): string {
  const tags = placement === LIVE_ROW_RUN_NOT_JUDGED ? 'b.jg5 SRJ-705, SRJ-120, SRJ-717' : 'b.jg5 SRJ-705, SRJ-120'
  return `${head(ref)}: step ${step} run ${runNumber} of ${LIVE_ROW_SEQUENCE_MAX_RUNS}: ${describePlacement(placement)} (${tags})`
}

/**
 * Step 6's line, before the launch:
 *   `[slack] live-row-sequence: <ref>: step 6: <resume|reuse> — <reason> (b.jg5 SRJ-705)`
 */
export function liveRowSequenceLaunchLine(ref: string, decision: LiveRowLaunchKindDecision): string {
  return `${head(ref)}: step 6: ${decision.kind} — ${decision.reason} (b.jg5 SRJ-705)`
}

/** Why a sequence stopped, in words. */
function describeStopReason(reason: LiveRowSequenceStopReason): string {
  switch (reason) {
    case LIVE_ROW_STOP_LATCHED:
      return 'the persona is latched'
    case LIVE_ROW_STOP_TEARDOWN:
      return "the persona's teardown began"
    case LIVE_ROW_STOP_SHUTDOWN:
      return 'the server is shutting down'
    case LIVE_ROW_STOP_NOT_UP:
      return 'the persona is not up or the server is stopping'
    case LIVE_ROW_STOP_HOLD_ENDED:
      return 'the old-life hold it serves ended'
  }
}

/** An outcome, in words. */
function describeOutcome(outcome: LiveRowSequenceOutcome): string {
  switch (outcome.kind) {
    case LIVE_ROW_OUTCOME_LAUNCHED:
      return `${liveRowLaunchSucceeded(outcome.result) ? 'launched' : 'the launch failed'} (${outcome.launchKind}; result=${renderState(outcome.result.action)}${outcome.result.stopping === true ? ', stopping' : ''})`
    case LIVE_ROW_OUTCOME_NOT_LAUNCHED:
      return `not launched (${outcome.launchKind}; ${outcome.notLaunched})`
    case LIVE_ROW_OUTCOME_ROW_FINISHED:
      return 'the row is finished (no launch)'
    case LIVE_ROW_OUTCOME_NOT_JUDGED:
      return `stopped at step ${outcome.step}: a run did not judge the pending row; no alert, no further kill, nothing counted`
    case LIVE_ROW_OUTCOME_ABORTED:
      return `aborted at step ${outcome.step} by the kill's class ${outcome.errorClass}${outcome.latched ? ' (the persona latched)' : ''}`
    case LIVE_ROW_OUTCOME_ESCALATED:
      return 'escalated: the row stayed live after runs that judged it; the kill-failure alert was raised'
    case LIVE_ROW_OUTCOME_NO_JUDGED_RUN:
      return 'ended: the row stayed live, but no run judged it; no alert'
    case LIVE_ROW_OUTCOME_CONFIG_MALFORMED:
      return `ended at step ${outcome.step} with no kill (ad-config-malformed, row last read pending)`
    case LIVE_ROW_OUTCOME_READ_REFUSED:
      return `ended at step ${outcome.step}: the get failed`
    case LIVE_ROW_OUTCOME_RUN_REFUSED:
      return `ended at step ${outcome.step}: the run was refused`
    case LIVE_ROW_OUTCOME_STOPPED:
      return `stopped: ${describeStopReason(outcome.reason)}; no further call`
    case LIVE_ROW_OUTCOME_INTERNAL_ERROR:
      return 'ended: a dependency failed'
  }
}

/**
 * The end line's account of P's retry timer (b.jg5 SRJ-301, SRJ-409), one of:
 *   - `the retry timer armed (<cause>)`: the sequence armed a cause at its end;
 *   - `the retry timer armed by the launch (pending-only)`: a step-6 launch
 *     whose `ErrTmuxSessionCreate` armed the timer in pending-only mode itself
 *     (SRJ-112, SRJ-113);
 *   - `no cause armed by the sequence; the launch's success arms the
 *     pending-only watch (pending-row)`: a launch call that succeeded
 *     (`LIVE_ROW_LAUNCH_CALL_SUCCESS_ACTIONS`), whose after-launch step arms
 *     P's timer in pending-only mode with the `pending-row` cause (a latched
 *     P excepted);
 *   - `no retry timer armed`: any other end.
 */
export function liveRowSequenceEndArmText(outcome: LiveRowSequenceOutcome): string {
  if (outcome.armed !== undefined) return `the retry timer armed (${outcome.armed})`
  if (outcome.kind === LIVE_ROW_OUTCOME_LAUNCHED) {
    if (outcome.result.pendingOnlyArmed === true) return 'the retry timer armed by the launch (pending-only)'
    if (LIVE_ROW_LAUNCH_CALL_SUCCESS_ACTIONS.has(outcome.result.action)) {
      return "no cause armed by the sequence; the launch's success arms the pending-only watch (pending-row)"
    }
  }
  return 'no retry timer armed'
}

/**
 * The end line, one per sequence:
 *   `[slack] live-row-sequence: <ref>: <outcome> — runs=<n> kills=<n> judged=<n>; <timer> (b.jg5 SRJ-705, SRJ-717, SRJ-301)`
 * where `<timer>` is `liveRowSequenceEndArmText`'s.
 */
export function liveRowSequenceEndLine(ref: string, outcome: LiveRowSequenceOutcome): string {
  const armed = liveRowSequenceEndArmText(outcome)
  return `${head(ref)}: ${describeOutcome(outcome)} — runs=${outcome.runs} kills=${outcome.kills} judged=${outcome.judgedRuns}; ${armed} (b.jg5 SRJ-705, SRJ-717, SRJ-301)`
}

/**
 * The line when a result arrives after the sequence was stopped:
 *   `[slack] live-row-sequence: <ref>: the <what> answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)`
 */
export function liveRowSequenceDroppedLine(ref: string, what: string): string {
  return `${head(ref)}: the ${what} answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)`
}

/**
 * The line when a dependency threw; `described` is a redacting describer's
 * output (`describeThrownValue`), never the error:
 *   `[slack] live-row-sequence: <ref>: <what> failed: <described> — the sequence ends without its launch (b.jg5 SRJ-705)`
 */
export function liveRowSequenceFailedLine(ref: string, what: string, described: string): string {
  return `${head(ref)}: ${what} failed: ${described} — the sequence ends without its launch (b.jg5 SRJ-705)`
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A step's answer: go on, or end with this outcome. */
type StepEnd = OutcomeBody | undefined

/** What a `get` step found: the row finished (or gone), the row still live, or an end. */
type GetAnswer = { readonly finished: boolean } | { readonly end: OutcomeBody }

/**
 * Run one live-row sequence (SRJ-705, SRJ-706, SRJ-717) for `request`,
 * through `deps`, until it launches, ends or `stop` is set; see the module
 * comment for the steps. Answers the outcome after its end line, with the
 * retry cause it armed. Never throws or rejects, and leaves no timer of its
 * own pending once it settles.
 */
export async function runLiveRowSequence(
  request: LiveRowSequenceRequest,
  deps: LiveRowSequenceDeps,
  stop: LiveRowSequenceStopSignal,
): Promise<LiveRowSequenceOutcome> {
  const { key } = request
  const ref = request.ref ?? `persona=${key}`
  const counts = { runs: 0, kills: 0, judgedRuns: 0 }
  let lastRead: LiveRowSequenceLastRead = { kind: 'state', state: request.lastReadState }

  const log = (line: string): void => {
    try {
      deps.log(line)
    } catch {
      /* a failing sink changes nothing about the sequence */
    }
  }

  const latchedNow = (): boolean => {
    try {
      return deps.isLatched(key) !== false
    } catch {
      return true
    }
  }

  /** The stop that holds now, if any: the signal's reason, or P's latch. */
  const halted = (): OutcomeBody | undefined => {
    if (stop.reason !== undefined) return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: stop.reason }
    if (latchedNow()) return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED }
    return undefined
  }

  /**
   * The stop that drops an answer arriving after it: a teardown or shutdown
   * stop. A stop for P's latch (the latch's set observer, SRJ-502)
   * drops nothing: the answer is handled as for a latched P (the sequence's
   * own latching call included), and `halted()` ends the sequence before its
   * next call. Nor does a no-launch request's stop for its hold's end
   * (SRJ-811): the answer is acted on, and `halted()` ends the wait before
   * its next call.
   */
  const dropStop = (): LiveRowSequenceStopReason | undefined =>
    stop.reason !== undefined && stop.reason !== LIVE_ROW_STOP_LATCHED && stop.reason !== LIVE_ROW_STOP_HOLD_ENDED
      ? stop.reason
      : undefined

  const lastReadPending = (): boolean => lastRead.kind === 'state' && lastRead.state === AGENT_DIRECTOR_PENDING_STATE

  /** Wait `ms` on the clock; ends early (answering false) once the sequence is stopped. */
  const pause = (ms: number): Promise<boolean> => {
    if (stop.reason !== undefined) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let done = false
      let unsubscribe: () => void = () => {}
      const settle = (elapsed: boolean): void => {
        if (done) return
        done = true
        unsubscribe()
        resolve(elapsed)
      }
      const handle = deps.clock.setTimeout(() => settle(true), ms)
      unsubscribe = stop.onStop(() => {
        deps.clock.clearTimeout(handle)
        settle(false)
      })
    })
  }

  /**
   * Wait until G past the launch start `launchStartedAt` names (raw), through
   * `armPendingRowWait` (`src/pending-row.ts`: never early, with the G
   * accessor read at every fire; SRJ-406, never from `started_at`); ends
   * early (false) once stopped.
   */
  const waitForGrace = (launchStartedAt: unknown): Promise<boolean> => {
    if (stop.reason !== undefined) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let done = false
      let cancel: () => void = () => {}
      let unsubscribe: () => void = () => {}
      const settle = (elapsed: boolean): void => {
        if (done) return
        done = true
        unsubscribe()
        cancel()
        resolve(elapsed)
      }
      let armed: PendingRowWaitArm
      try {
        armed = armPendingRowWait(deps.clock, launchStartedAt, deps.graceMs, () => settle(true))
      } catch {
        // Not reached: G is a number while arming; no wait then.
        settle(true)
        return
      }
      if (armed === PENDING_ROW_WAIT_NOT_ARMED) {
        // Not reached: step 2 read a launch start; a row with none has no wait (SRJ-408).
        settle(true)
        return
      }
      cancel = armed.cancel
      unsubscribe = stop.onStop(() => settle(false))
    })
  }

  /** The end: arm by the rule, log the end line, answer the outcome. */
  const finish = (body: OutcomeBody): LiveRowSequenceOutcome => {
    const cause = armCauseFor(body)
    if (cause !== undefined) {
      try {
        deps.armRetry(key, cause)
      } catch {
        /* a failing arm changes nothing about the outcome */
      }
    }
    const outcome = { ...body, ...counts, ...(cause === undefined ? {} : { armed: cause }) } as LiveRowSequenceOutcome
    log(liveRowSequenceEndLine(ref, outcome))
    return outcome
  }

  /**
   * The retry cause an end arms with (SRJ-301, SRJ-717), or none. A step-6
   * launch whose result is no success ends without the launch and arms with
   * the other-end cause (SRJ-301, SRJ-112, SRJ-113), unless P latched or is
   * held on `ErrInvalidFlags` (SRJ-207), the result says the server is
   * stopping, or the launch's
   * `ErrTmuxSessionCreate` armed the timer in pending-only mode itself
   * (SRJ-112, SRJ-113, SRJ-409: pending-only unless another cause holds); an
   * arm the launch's own refusal handling made already keeps its due time. A
   * reuse collision at step 6, and a collision of the plain spawn after the
   * `resume`'s `ErrSpawnNotFound`, arm the reuse-collision cause (SRJ-112,
   * SRJ-111, SRJ-705); a `resume`'s `ErrSpawnNotResumable` whose re-read found a lost
   * race arms the lost-race cause, and one whose re-read found the row
   * `pending` the other-end cause (SRJ-710).
   */
  const armCauseFor = (body: OutcomeBody): LiveRowSequenceArmCause | undefined => {
    if (!request.launches) return undefined
    // SRJ-301, SRJ-706: a sequence stopped by teardown or shutdown arms nothing, whatever its last step answered.
    if (stop.reason !== undefined) return undefined
    switch (body.kind) {
      case LIVE_ROW_OUTCOME_LAUNCHED:
        if (liveRowLaunchSucceeded(body.result)) return undefined
        // SRJ-502, SRJ-207, SRJ-205: a latch or a hold stops P's retry timer, and a stop ends the server.
        if (body.result.action === LIVE_ROW_LAUNCH_RESULT_LATCHED || body.result.action === LIVE_ROW_LAUNCH_RESULT_HELD) {
          return undefined
        }
        if (body.result.stopping === true) return undefined
        if (body.result.pendingOnlyArmed === true) return undefined
        break
      case LIVE_ROW_OUTCOME_NOT_LAUNCHED:
        if (body.notLaunched === LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION || body.notLaunched === LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION) {
          return latchedNow() ? undefined : LIVE_ROW_ARM_REUSE_COLLISION
        }
        if (body.notLaunched === LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE) {
          return latchedNow() ? undefined : LIVE_ROW_ARM_LOST_RACE
        }
        break
      case LIVE_ROW_OUTCOME_ROW_FINISHED:
      case LIVE_ROW_OUTCOME_STOPPED:
        return undefined
      case LIVE_ROW_OUTCOME_NOT_JUDGED:
        return LIVE_ROW_ARM_NOT_JUDGED
      case LIVE_ROW_OUTCOME_ABORTED:
        if (body.latched) return undefined
        break
      default:
        break
    }
    return latchedNow() ? undefined : LIVE_ROW_ARM_ENDED
  }

  /** Step 1's or step 4's kill: the SRJ-316 rule, then the kill through the bounded retry, then its outcome by class. */
  const killStep = async (step: 1 | 4): Promise<StepEnd> => {
    const stopped = halted()
    if (stopped) return stopped
    if (lastReadPending() && configMalformedRaised()) {
      log(liveRowSequenceNoKillLine(ref, step))
      return { kind: LIVE_ROW_OUTCOME_CONFIG_MALFORMED, step }
    }
    counts.kills++
    const seed = lastRead.kind === 'state' ? lastRead.state : LIVE_ROW_SEQUENCE_NO_ROW
    const retried = await deps.killWithRetry(key, {
      lastReadState: seed,
      wait: (ms: number) => pause(ms).then(() => undefined),
      keepGoing: () => stop.reason === undefined && !latchedNow(),
      stoppedForHoldEnd: () => stop.reason === LIVE_ROW_STOP_HOLD_ENDED,
      ref,
    })
    log(liveRowSequenceKillLine(ref, step, retried))
    const droppedBy = dropStop()
    if (droppedBy !== undefined && retried.end !== KILL_RETRY_END_STOPPED && retried.end !== KILL_RETRY_END_HOLD_ENDED) {
      // SRJ-706: the kill answered after the stop; its answer is dropped:
      // no latch, no alert, no arm. Tries the keep-going check stopped go on
      // below to their log-only alert (`stopped`), which posts nothing; tries
      // an old-life wait's hold's end ended go on to their success, whose
      // survivor version is raised (SRJ-702, SRJ-811: the hold's end wins
      // over a stop in the same window).
      log(liveRowSequenceDroppedLine(ref, `step ${step} kill`))
      return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: droppedBy }
    }
    const { outcome } = retried
    if (killLetsNextStepRun(outcome)) {
      // SRJ-702, SRJ-704: a survivor version is raised before the next step.
      raiseKillAlert(retried)
      return halted()
    }
    if (killRetryStopped(retried)) {
      // SRJ-513, SRJ-502: a between-try read that latched the row's persona ends as a latch.
      const latched = stop.reason === undefined && (retried.end === KILL_RETRY_END_READ_LATCHED || latchedNow())
      // SRJ-702: the stop's cause, when the sequence's own stop or P's latch
      // (the keep-going check's other stop) ended the tries.
      const stoppedBy = stop.reason ?? (latched ? LIVE_ROW_STOP_LATCHED : undefined)
      raiseKillAlert(retried, stoppedBy === undefined ? undefined : liveRowStopCauseText(stoppedBy))
      if (stop.reason !== undefined) return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: stop.reason }
      return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: latched ? LIVE_ROW_STOP_LATCHED : LIVE_ROW_STOP_NOT_UP }
    }
    if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) return halted()
    if (killOutcomeStopsServer(outcome)) {
      raiseKillAlert(retried)
      return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_SHUTDOWN }
    }
    let latched = false
    const latching = outcome.errorClass === AD_ERROR_CLASS_CONFLICT || outcome.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME
    // SRJ-110: the no-launch form latches nothing; its starter routes the answer.
    if (latching && request.launches) {
      latched = await deps.latchOnKillOutcome(key, outcome, lastRead, ref)
      const stoppedBy = dropStop()
      if (stoppedBy !== undefined) {
        // SRJ-706: stopped while the latch ran; nothing follows it.
        log(liveRowSequenceDroppedLine(ref, `step ${step} kill's latch`))
        return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: stoppedBy }
      }
    }
    // SRJ-702, SRJ-704: the ordinary version follows the outcome's own handling.
    raiseKillAlert(retried)
    return { kind: LIVE_ROW_OUTCOME_ABORTED, step, errorClass: outcome.errorClass, latched }
  }

  const raiseKillAlert = (retried: KillRetryResult, stopCause?: string): void => {
    try {
      if (stopCause === undefined) deps.raiseKillAlert(key, retried, request.alertContext, ref)
      else deps.raiseKillAlert(key, retried, request.alertContext, ref, stopCause)
    } catch {
      /* the alert's own failure changes nothing about the sequence */
    }
  }

  const configMalformedRaised = (): boolean => {
    try {
      return deps.isConfigMalformedRaised(key) !== false
    } catch {
      return true
    }
  }

  /** One `get` (step 2, 3 or 4): the row finished or gone, the row live, or an end. */
  const getStep = async (step: 2 | 3 | 4): Promise<GetAnswer> => {
    const stopped = halted()
    if (stopped) return { end: stopped }
    const read = await deps.readRow(key, ref)
    log(liveRowSequenceGetLine(ref, step, read))
    const droppedBy = dropStop()
    if (droppedBy !== undefined) {
      log(liveRowSequenceDroppedLine(ref, `step ${step} get`))
      return { end: { kind: LIVE_ROW_OUTCOME_STOPPED, reason: droppedBy } }
    }
    switch (read.kind) {
      case LIVE_ROW_READ_LATCHED:
        return { end: { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED } }
      case LIVE_ROW_READ_REFUSED:
        return { end: { kind: LIVE_ROW_OUTCOME_READ_REFUSED, step } }
      case LIVE_ROW_READ_ABSENT:
        lastRead = { kind: LIVE_ROW_SEQUENCE_NO_ROW }
        return { finished: true }
      case LIVE_ROW_READ_ROW:
        lastRead = { kind: 'state', state: read.row.state, row: read.row }
        return { finished: AGENT_DIRECTOR_DEAD_STATES.has(read.row.state) }
    }
  }

  /** One bypassing run (step 3 or 4), read against the state last read. */
  const runStep = async (step: 3 | 4): Promise<StepEnd> => {
    const stopped = halted()
    if (stopped) return stopped
    counts.runs++
    const stateBefore = lastRead.kind === 'state' ? lastRead.state : LIVE_ROW_SEQUENCE_NO_ROW
    const placement = await deps.runFindMissing(key, request.instanceId, stateBefore)
    log(liveRowSequenceRunLine(ref, step, counts.runs, placement))
    const droppedBy = dropStop()
    if (droppedBy !== undefined) {
      log(liveRowSequenceDroppedLine(ref, `step ${step} run`))
      return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: droppedBy }
    }
    switch (placement) {
      case LIVE_ROW_RUN_LATCHED:
        return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED }
      case LIVE_ROW_RUN_REFUSED:
        return { kind: LIVE_ROW_OUTCOME_RUN_REFUSED, step }
      case LIVE_ROW_RUN_NOT_JUDGED:
        return { kind: LIVE_ROW_OUTCOME_NOT_JUDGED, step }
      default:
        if (JUDGED_PLACEMENTS.has(placement)) counts.judgedRuns++
        return undefined
    }
  }

  /** Step 2's wait on a `pending` row until G past its launch start. */
  const graceWait = async (): Promise<StepEnd> => {
    if (lastRead.kind !== 'state' || lastRead.state !== AGENT_DIRECTOR_PENDING_STATE) return undefined
    const launchStartedAt = lastRead.row?.launch_started_at
    const launchStartMs = parseLaunchStart(launchStartedAt)
    if (launchStartMs === undefined) {
      log(liveRowSequenceNoWaitLine(ref))
      return undefined
    }
    log(liveRowSequenceWaitArmedLine(ref, launchStartMs, graceInEffect()))
    if (!(await waitForGrace(launchStartedAt))) return halted() ?? stoppedNow()
    log(liveRowSequenceWaitEndedLine(ref))
    return undefined
  }

  const graceInEffect = (): number => {
    try {
      return deps.graceMs()
    } catch {
      return AD_WAIT_NEVER_ENDS
    }
  }

  /**
   * Step 6: the launch, or the no-launch form's end. The launch's result is
   * the outcome's whatever it is; a result that is no success arms at the end
   * (`armCauseFor`), and no further call follows it.
   */
  const launchStep = async (): Promise<OutcomeBody> => {
    if (!request.launches) return { kind: LIVE_ROW_OUTCOME_ROW_FINISHED }
    const stopped = halted()
    if (stopped) return stopped
    const row = lastRead.kind === 'state' ? lastRead.row : undefined
    let facts: LiveRowSequencePersonaFacts | undefined
    try {
      facts = deps.personaFacts(key, row)
    } catch {
      facts = undefined
    }
    // SRJ-805: the store is read again here, so a key recorded while the
    // sequence ran ends in a reuse as one recorded at its start does.
    const decision = decideLiveRowLaunchKind({
      keepsConversation: request.keepsConversation,
      retiredKey: request.retiredKey || facts?.retired === true,
      row,
      persona: facts,
    })
    log(liveRowSequenceLaunchLine(ref, decision))
    const answer = await deps.launch(key, decision.kind, lastRead, ref, stop, request.retiredAtStart)
    const droppedBy = dropStop()
    if (droppedBy !== undefined) {
      // SRJ-706: the launch ran to its end; its result is dropped.
      log(liveRowSequenceDroppedLine(ref, 'step 6 launch'))
      return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: droppedBy }
    }
    if (answer.kind === LIVE_ROW_OUTCOME_NOT_LAUNCHED) {
      // SRJ-710, SRJ-706: a re-read after `ErrSpawnNotResumable` that
      // latched P ends the sequence as any latch does, with nothing armed.
      if (answer.reason === LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_LATCHED) {
        return { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED }
      }
      return { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, launchKind: decision.kind, notLaunched: answer.reason }
    }
    return { kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: decision.kind, reason: decision.reason, result: answer.result }
  }

  /** Step 3's runs and step 4: the row finished (go to step 6), or an end. */
  const runSteps = async (): Promise<OutcomeBody> => {
    for (let run = 1; run <= LIVE_ROW_SEQUENCE_STEP3_RUNS; run++) {
      if (run > 1 && !(await pause(LIVE_ROW_SEQUENCE_RUN_SPACING_MS))) return halted() ?? stoppedNow()
      const runEnd = await runStep(3)
      if (runEnd) return runEnd
      const got = await getStep(3)
      if ('end' in got) return got.end
      if (got.finished) return launchStep()
    }
    const killEnd = await killStep(4)
    if (killEnd) return killEnd
    if (!(await pause(LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS))) return halted() ?? stoppedNow()
    const runEnd = await runStep(4)
    if (runEnd) return runEnd
    const got = await getStep(4)
    if ('end' in got) return got.end
    if (got.finished) return launchStep()
    return escalate()
  }

  const stoppedNow = (): OutcomeBody => ({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: stop.reason ?? LIVE_ROW_STOP_SHUTDOWN })

  /** Step 5: the row is still live after step 4. */
  const escalate = (): OutcomeBody => {
    const stopped = halted()
    if (stopped) return stopped
    if (counts.judgedRuns === 0) return { kind: LIVE_ROW_OUTCOME_NO_JUDGED_RUN }
    try {
      deps.raiseEscalationAlert(key, request.alertContext, ref)
    } catch {
      /* the alert's own failure changes nothing about the sequence */
    }
    return { kind: LIVE_ROW_OUTCOME_ESCALATED }
  }

  log(liveRowSequenceStartLine(ref, request))
  try {
    if (request.entryStep === LIVE_ROW_SEQUENCE_ENTRY_KILL) {
      const killEnd = await killStep(1)
      if (killEnd) return finish(killEnd)
    }
    const got = await getStep(2)
    if ('end' in got) return finish(got.end)
    const waitEnd = await graceWait()
    if (waitEnd) return finish(waitEnd)
    return finish(await runSteps())
  } catch (err) {
    log(liveRowSequenceFailedLine(ref, 'a step', describeThrownValue(err)))
    const droppedBy = dropStop()
    if (droppedBy !== undefined) {
      // SRJ-706: the failure arrived after the stop; it is dropped like any answer.
      log(liveRowSequenceDroppedLine(ref, 'failed step'))
      return finish({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: droppedBy })
    }
    return finish({ kind: LIVE_ROW_OUTCOME_INTERNAL_ERROR })
  }
}

// ---------------------------------------------------------------------------
// The registry (SRJ-706, SRJ-811)
// ---------------------------------------------------------------------------

/** The start entry started the sequence; it runs in the background. */
export const LIVE_ROW_START_STARTED = 'started'
/** A sequence already runs on the request's instance id, or for its persona: nothing was started. */
export const LIVE_ROW_START_ALREADY_RUNNING = 'already-running'
/** The registry is closed (shutdown): nothing was started. */
export const LIVE_ROW_START_CLOSED = 'closed'

/** What the registry's start entry answers. */
export type LiveRowSequenceStartAnswer =
  | typeof LIVE_ROW_START_STARTED
  | typeof LIVE_ROW_START_ALREADY_RUNNING
  | typeof LIVE_ROW_START_CLOSED

/**
 * Runs `run` as one recovery attempt for persona `key`, detached from the
 * caller's attempt (production: `runDetachedRecoveryAttempt` in
 * `src/unavailable-retry.ts`), and settles with its result. Injected, so this
 * module loads no module that reaches a Slack module.
 */
export type LiveRowSequenceAttemptRunner = <T>(key: string, run: () => Promise<T>) => Promise<T>

/**
 * Runs `run` outside every launch or recovery attempt (production:
 * `runOutsideAttempts` in `src/unavailable-retry.ts`), and settles with its
 * result: a no-launch request's run (an old-life wait, SRJ-811), so no call
 * it makes is taken as one of its starter's attempt or arms a retry timer for
 * its old key by the attempt rule (SRJ-1512). Injected, as the attempt runner is.
 */
export type LiveRowSequenceOutsideAttemptRunner = <T>(run: () => Promise<T>) => Promise<T>

/** What the registry is built with. */
export interface LiveRowSequenceRegistryOptions {
  /** Every sequence's dependencies (`buildLiveRowSequenceDeps`), unless a start gives its own; the registry's lines go to its log sink. */
  readonly deps: LiveRowSequenceDeps
  /** The recovery attempt each request that ends in a launch runs in. */
  readonly runAttempt: LiveRowSequenceAttemptRunner
  /** Where a no-launch request runs: outside every attempt. Absent: it is run as it is. */
  readonly runOutsideAttempt?: LiveRowSequenceOutsideAttemptRunner
}

/** What one start may give besides its request. */
export interface LiveRowSequenceStartOptions {
  /**
   * The request's own dependencies (an old-life wait's,
   * `buildOldLifeWaitDeps` in `src/session-manager.ts`, bound to its old
   * row's instance id). Absent: the registry's.
   */
  readonly deps?: LiveRowSequenceDeps
  /**
   * Told the outcome once the started sequence has settled, after its end
   * line and after the registry dropped its entry (the old-life wait's end
   * handler). A throw is ignored. Called only for a start that answered
   * `started`.
   */
  readonly onSettled?: (outcome: LiveRowSequenceOutcome) => void
}

/** One server's live-row sequences: at most one per instance id, and at most one ending in a launch per persona. */
export interface LiveRowSequenceRegistry {
  /**
   * Start a sequence for `request` without awaiting it (SRJ-706, SRJ-811).
   * Answers `started` when nothing runs on the request's instance id and, for
   * a request that ends in a launch, no other such request runs for its
   * persona (the sequence's first call comes after this answer);
   * `already-running` otherwise, starting nothing; `closed` after `close`,
   * with one line. A no-launch request (an old-life wait) is refused only by
   * its instance id, so a wait keyed by an old key never refuses a persona's
   * own sequence on another id, and one wait runs per held instance id. A
   * request that ends in a launch runs inside its own recovery attempt for its
   * persona (`runAttempt`); a no-launch request runs outside every attempt
   * (`runOutsideAttempt`). Never throws and never blocks on the sequence.
   */
  start(request: LiveRowSequenceRequest, options?: LiveRowSequenceStartOptions): LiveRowSequenceStartAnswer
  /**
   * Stop persona `key`'s running sequence that ends in a launch, with
   * `reason` (SRJ-706): its stop signal is set before this returns, so it
   * makes no further call and holds no timer once its call in flight, if
   * any, has returned. A no-launch request keyed by `key` is not stopped here
   * (`stopNoLaunch`): a latch or a persona's stop never stops an old-life
   * wait (SRJ-811). Resolves true once the sequence has settled (that call
   * returned and its end logged), so a caller that awaits it waits for the
   * call in flight as it waits for a launch in flight; false at once when
   * none runs. Never rejects.
   */
  stop(key: string, reason: LiveRowSequenceStopReason): Promise<boolean>
  /**
   * Stop the no-launch request running on `instanceId` (an old-life wait,
   * SRJ-811), with `reason`: its hold's end (`hold-ended`), or the teardown
   * of the last persona waiting on its hold (`teardown`). A request that ends
   * in a launch on that id is never stopped here. Resolves true once it has
   * settled; false at once when no no-launch request runs there. Never rejects.
   */
  stopNoLaunch(instanceId: string, reason: LiveRowSequenceStopReason): Promise<boolean>
  /** Stop every running sequence with `reason`; resolves once all have settled. Never rejects. */
  stopAll(reason: LiveRowSequenceStopReason): Promise<void>
  /**
   * Stop every running sequence, no-launch requests included, for shutdown,
   * and refuse every later start (`closed`, one line). Resolves once all have
   * settled. Never rejects.
   */
  close(): Promise<void>
  /**
   * True while a sequence runs keyed by `key`: from its start's answer until
   * it settles, its step-6 launch included. A no-launch request keyed by a
   * persona's key (an old-life wait on the persona's own `cscb_<key>`)
   * counts too.
   */
  isRunning(key: string): boolean
  /** True while a no-launch request (an old-life wait) runs on `instanceId`. */
  isNoLaunchRunning(instanceId: string): boolean
  /**
   * Test-only: resolves with how persona `key`'s latest sequence ended: the
   * running one's outcome once it settles, else at once the last one's;
   * undefined when none ran. Starts and stops nothing.
   */
  _whenSettled(key: string): Promise<LiveRowSequenceOutcome | undefined>
  /**
   * Test-only: as `_whenSettled`, by instance id: the running sequence's
   * outcome on `instanceId` once it settles, else at once the last one's on
   * it; undefined when none ran there. Starts and stops nothing.
   */
  _whenSettledOn(instanceId: string): Promise<LiveRowSequenceOutcome | undefined>
}

/** One running sequence, by instance id. */
interface RegisteredSequence {
  readonly key: string
  readonly instanceId: string
  readonly ref: string
  /** False for a no-launch request (an old-life wait). */
  readonly launches: boolean
  readonly stop: LiveRowSequenceStopHandle
  /** Resolves with the outcome once the sequence settled; never rejects. */
  readonly settled: Promise<LiveRowSequenceOutcome>
}

/**
 * The line when a start is refused:
 *   `[slack] live-row-sequence: <ref>: not started for <id> — <a sequence already runs | the server is shutting down> (b.jg5 SRJ-706)`
 */
export function liveRowSequenceNotStartedLine(ref: string, instanceId: string, answer: Exclude<LiveRowSequenceStartAnswer, typeof LIVE_ROW_START_STARTED>): string {
  const why =
    answer === LIVE_ROW_START_CLOSED
      ? 'the server is shutting down; no sequence starts'
      : 'a sequence already runs for this persona or instance id; nothing more is started'
  return `${head(ref)}: not started for ${renderId(instanceId)} — ${why} (b.jg5 SRJ-706)`
}

/**
 * The line when a stop is asked of a running sequence:
 *   `[slack] live-row-sequence: <ref>: stop asked — <reason>; no further call (b.jg5 SRJ-706)`
 */
export function liveRowSequenceStopAskedLine(ref: string, reason: LiveRowSequenceStopReason): string {
  return `${head(ref)}: stop asked — ${describeStopReason(reason)}; no further call (b.jg5 SRJ-706)`
}

/**
 * Build one server's live-row sequence registry (SRJ-706, SRJ-811). Holds its
 * state in the returned object only; reads, starts and schedules nothing when
 * built. Each entry is keyed by its instance id and records its key and
 * whether it ends in a launch; it is removed when its sequence settles,
 * whatever the outcome, which the sequence's own end line logs once.
 */
export function createLiveRowSequenceRegistry(options: LiveRowSequenceRegistryOptions): LiveRowSequenceRegistry {
  const { deps, runAttempt } = options
  const runOutside: LiveRowSequenceOutsideAttemptRunner = options.runOutsideAttempt ?? ((run) => run())
  const running = new Map<string, RegisteredSequence>()
  const lastOutcomes = new Map<string, LiveRowSequenceOutcome>()
  const lastOutcomesOn = new Map<string, LiveRowSequenceOutcome>()
  let closed = false

  const log = (line: string): void => {
    try {
      deps.log(line)
    } catch {
      /* a failing sink changes nothing about the registry */
    }
  }

  const entriesFor = (key: string): RegisteredSequence[] => [...running.values()].filter((entry) => entry.key === key)
  const launchingEntriesFor = (key: string): RegisteredSequence[] => entriesFor(key).filter((entry) => entry.launches)

  /** Run the sequence after the start answered, inside its attempt rule; never rejects. */
  const runEntry = async (
    entry: RegisteredSequence,
    request: LiveRowSequenceRequest,
    sequenceDeps: LiveRowSequenceDeps,
  ): Promise<LiveRowSequenceOutcome> => {
    let outcome: LiveRowSequenceOutcome
    try {
      // Always awaited, so the sequence's first call comes after the start entry answered.
      await Promise.resolve()
      const run = (): Promise<LiveRowSequenceOutcome> => runLiveRowSequence(request, sequenceDeps, entry.stop)
      // SRJ-811, SRJ-1512: a no-launch request runs outside every attempt, so
      // nothing it meets is taken as an attempt's for its old key.
      outcome = entry.launches ? await runAttempt(entry.key, run) : await runOutside(run)
    } catch (err) {
      // Not reached: the sequence never rejects; the runners only wrap it.
      log(liveRowSequenceFailedLine(entry.ref, 'the sequence', describeThrownValue(err)))
      outcome = { kind: LIVE_ROW_OUTCOME_INTERNAL_ERROR, runs: 0, kills: 0, judgedRuns: 0 }
    }
    if (running.get(entry.instanceId) === entry) running.delete(entry.instanceId)
    lastOutcomes.set(entry.key, outcome)
    lastOutcomesOn.set(entry.instanceId, outcome)
    return outcome
  }

  const stopEntries = (entries: readonly RegisteredSequence[], reason: LiveRowSequenceStopReason): Promise<void> => {
    for (const entry of entries) {
      if (entry.stop.stop(reason)) log(liveRowSequenceStopAskedLine(entry.ref, reason))
    }
    return Promise.all(entries.map((entry) => entry.settled)).then(() => undefined)
  }

  return {
    start(request, startOptions) {
      const ref = request.ref ?? `persona=${request.key}`
      if (closed) {
        log(liveRowSequenceNotStartedLine(ref, request.instanceId, LIVE_ROW_START_CLOSED))
        return LIVE_ROW_START_CLOSED
      }
      const launches = request.launches !== false
      if (running.has(request.instanceId) || (launches && launchingEntriesFor(request.key).length > 0)) {
        log(liveRowSequenceNotStartedLine(ref, request.instanceId, LIVE_ROW_START_ALREADY_RUNNING))
        return LIVE_ROW_START_ALREADY_RUNNING
      }
      let resolveSettled!: (outcome: LiveRowSequenceOutcome) => void
      const settled = new Promise<LiveRowSequenceOutcome>((resolve) => {
        resolveSettled = resolve
      })
      const entry: RegisteredSequence = {
        key: request.key,
        instanceId: request.instanceId,
        ref,
        launches,
        stop: createLiveRowSequenceStop(),
        settled,
      }
      running.set(request.instanceId, entry)
      const onSettled = startOptions?.onSettled
      void runEntry(entry, request, startOptions?.deps ?? deps).then((outcome) => {
        resolveSettled(outcome)
        if (onSettled !== undefined) {
          try {
            onSettled(outcome)
          } catch {
            /* a failing end handler changes nothing about the registry */
          }
        }
      })
      return LIVE_ROW_START_STARTED
    },
    stop(key, reason) {
      const entries = launchingEntriesFor(key)
      if (entries.length === 0) return Promise.resolve(false)
      return stopEntries(entries, reason).then(() => true)
    },
    stopNoLaunch(instanceId, reason) {
      const entry = running.get(instanceId)
      if (entry === undefined || entry.launches) return Promise.resolve(false)
      return stopEntries([entry], reason).then(() => true)
    },
    stopAll(reason) {
      return stopEntries([...running.values()], reason)
    },
    close() {
      closed = true
      return stopEntries([...running.values()], LIVE_ROW_STOP_SHUTDOWN)
    },
    isRunning(key) {
      for (const entry of running.values()) if (entry.key === key) return true
      return false
    },
    isNoLaunchRunning(instanceId) {
      const entry = running.get(instanceId)
      return entry !== undefined && !entry.launches
    },
    _whenSettled(key) {
      const entry = entriesFor(key)[0]
      return entry !== undefined ? entry.settled : Promise.resolve(lastOutcomes.get(key))
    },
    _whenSettledOn(instanceId) {
      const entry = running.get(instanceId)
      return entry !== undefined ? entry.settled : Promise.resolve(lastOutcomesOn.get(instanceId))
    },
  }
}
