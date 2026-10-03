/**
 * restart.ts — Auto-restart logic for managed Claude Code sessions.
 *
 * Schedules a delayed relaunch when an MCP session disconnects. Restart
 * guards, backoff and the failure cap are keyed by persona key (b.av2 SR-6.3):
 * every dependency, the pending-timer map and the in-flight launch set take
 * the key, and log lines name it as `persona=<key>`.
 * A persona that is not up (broken, or retrying its bring-up; b.av2 SR-6.4)
 * is never restarted: `RestartDeps.canRestart` is asked before a timer is
 * armed, again when it fires (before the liveness probe) and once more after
 * the probe (before any reconnect or kill; and after the re-probe that follows
 * an 'escalate-dead' reconnect, b.d61), so its instance and row are left
 * alone and its failure count is unchanged. `launchSession`'s own gate is the
 * backstop for a flip during the kill.
 * A fired timer's work runs through the per-persona lifecycle serializer
 * (b.av2 SR-6.6, `RestartDeps.serialize`), so it never overlaps a teardown or
 * a bring-up retry's launch for the same persona, and its checks see the
 * state when the work starts. The restart timer's work does not ask the
 * restart cap: a timer fired for a persona already at the cap re-attempts the
 * launch (a success resets the cap; a further failure is counted).
 * The work runs as a recovery attempt for the persona (b.jg5 SRJ-301,
 * `runInAttempt`), adapters included: an UNAVAILABLE, ENVIRONMENT or CONFIG
 * (`ErrConfigMalformed`, SRJ-316) outcome from any of its agent-director
 * calls (the liveness read, the reconnect with its reads, the kill, the
 * relaunch), an UNCLASSIFIED one (SRJ-313, `ErrSystemInstallDisappeared`
 * included) from any of them but a `status`, `get` or `list`, or any other
 * `status`, `get` or `list` error, arms the persona's UNAVAILABLE retry timer
 * through the installed trigger sink. The kill is a checked kill (b.jg5
 * SRJ-110, SRJ-701): only its success (GONE included) lets the relaunch
 * follow; a kill that meets UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED
 * (a class the kill has no row for included) is refused, one that meets a
 * CONFLICT or an UNUSABLE NAME latches the persona, one whose
 * `ErrInvalidFlags` re-check decides that the server stops ends the work
 * with nothing more called, and a relaunch
 * the timer now owns answers `'refused'`; none is ever counted toward the cap
 * (SRJ-302): a persona is never given up on for UNAVAILABLE, ENVIRONMENT,
 * CONFIG or UNCLASSIFIED alone.
 * The liveness probe answers one of four readings (b.jg5 SRJ-314,
 * `src/liveness-reading.ts`), and only `dead` leads to the kill and the
 * launch; after an escalate-dead verdict that is not dead evidence (b.jg5
 * SRJ-611), to the launch alone. `live` takes the reconnect path; for a key
 * recorded as retired with no "new life has begun" mark the server's
 * reconnect adapter types nothing into that old life, starts the live-row
 * sequence (with the retired-key flag) and answers 'transient' (b.jg5
 * SRJ-805), so the work counts nothing; and the relaunch after a `dead`
 * reading of any key recorded as retired, marked or not, is the session
 * manager's reuse spawn, never a `resume`. `pending` (the row's session has
 * not started) is handed to the `pending` deferral
 * (`RestartDeps.deferPendingRow`) with the row's launch start, whatever the
 * session's connection shows, and the work returns with no reconnect, kill,
 * launch or accounting. `unknown` (a `status` error the adapter could not
 * read as dead, or a probe that throws) makes the work return with no
 * reconnect, kill, launch or accounting, and call the arm hook
 * (`RestartDeps.armRetryTimer`); so does an `unknown` re-probe after an
 * 'escalate-dead' reconnect (b.d61).
 * A row the reconnect's escalate-dead sweep leaves live may stay live for
 * further ticks (b.jg5 SRJ-610): its re-probe then reads `live`, the run ends
 * with no kill, launch or accounting, and each later escalate-dead tick
 * sweeps again with no step beyond the sweep. The optional slow-recovery
 * observer (`RestartDeps.slowRecovery`) is told each run's readings and
 * verdicts, so the server counts such re-probes and posts SRJ-1010 once per
 * episode after the third in a row.
 * The work answers an outcome (`RestartWorkOutcome`, one of the
 * `RESTART_OUTCOME_*` labels); the restart timer ignores it. The retry entry,
 * `runRestartRetry`, is how the UNAVAILABLE retry timer's retries rerun the
 * same decision (SRJ-303): through the same serializer, as the same recovery
 * attempt, with none of `scheduleRestart`'s gates (the restart delay, delay 0
 * included, the pending timer) and no restart timer touched. Its first step,
 * inside its own serialized work, after the latched gate below, is the
 * caller's in-flight check: while a
 * launch is in flight for the persona it answers `RESTART_OUTCOME_IN_FLIGHT`
 * with no agent-director call. Its second is the restart cap: a retry queued
 * behind other restart work for the persona, whose counted failure reached
 * the cap while the retry waited, answers `RESTART_OUTCOME_CAPPED` with no
 * agent-director call, nothing counted and no notice.
 * A latched persona gets no attempt (b.jg5 SRJ-502): the optional latched
 * query (`RestartDeps.isLatched`) is the first step of the serialized work,
 * before the liveness read, so a fired restart timer, the retry entry (before
 * its in-flight and cap checks) and a human-triggered restart all answer
 * `RESTART_OUTCOME_LATCHED` with no agent-director call and nothing recorded.
 * The query is asked again before the instance is reconnected or killed
 * (after the liveness probe, right after an 'escalate-dead' reconnect before
 * its re-probe, and right before the kill), since a launch outside the
 * serializer, or the reconnect's findMissing sweep, can latch the persona
 * during those awaits.
 * A launch that answers `'skipped'` for a persona that latched at it answers
 * the same. A latched query that throws counts as latched (fail safe).
 * A persona held on `ErrInvalidFlags` gets no attempt either (b.jg5 SRJ-207,
 * SRJ-303): the optional held query (`RestartDeps.isHeld`) is asked right
 * after each latched gate, so a fired restart timer, the retry entry (before
 * its in-flight and cap checks) and a human-triggered restart all answer
 * `RESTART_OUTCOME_HELD` with no agent-director call, nothing recorded and
 * nothing toward the cap, and so does a launch that answers `'skipped'` for a
 * persona held at it (its reuse spawn met `ErrInvalidFlags`). A held query
 * that throws counts as held (fail safe). `scheduleRestart` arms no timer for
 * a held persona.
 * Right after that first latched gate comes the live-row sequence gate
 * (b.jg5 SRJ-706, SRJ-303; the optional `RestartDeps.isLiveRowSequenceRunning`):
 * while P's sequence runs, a fired restart timer, the retry entry and a
 * human-triggered restart answer `RESTART_OUTCOME_SEQUENCE_WAITING` with no
 * agent-director call and nothing recorded, which a retry takes as a refusal.
 * The sequence gate is asked again wherever the latched gate is (after each
 * liveness probe, after an 'escalate-dead' reconnect, right before the kill)
 * and once more right before the launch, since a launch outside the
 * serializer can start P's sequence during the work's awaits (a collision
 * ladder's replacement site, b.jg5 SRJ-707); a sequence found running then
 * ends the work with `RESTART_OUTCOME_SEQUENCE_WAITING` and nothing more
 * called. A launch that answers `'refused'` while P's sequence runs (its own
 * ladder started the sequence, or met it, and answered `sequence-waiting`)
 * answers `RESTART_OUTCOME_SEQUENCE_WAITING` too, so a retry's re-armed line
 * names the sequence.
 * Isolated from server.ts side effects — injectable deps make it testable.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  isAtCap,
  recordFailure,
  recordSuccess,
  nextBackoffDelay,
  shouldNotifyCap,
} from './backoff.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { readRetryBlockCause, retryBlockSkipText, runInAttempt, type RetryBlockCause } from './unavailable-retry.ts'
import { AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_UNUSABLE_NAME } from './ad-error-class.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  describeKillOutcome,
  isKillOutcome,
  killLetsNextStepRun,
  killOutcomeStopsServer,
  type KillOutcome,
  type KillSuccess,
} from './checked-kill.ts'
import {
  LIVENESS_DEAD,
  LIVENESS_LIVE,
  LIVENESS_PENDING,
  LIVENESS_READING_DEAD_INSTALL_GONE,
  LIVENESS_UNKNOWN,
  deadLivenessReading,
  deadRowReadOf,
  isInstallGoneDeadReading,
  launchStartOfReading,
  livenessKindOf,
  pendingLivenessReading,
  type DeadLivenessReading,
  type DeadRowRead,
  type LivenessKind,
  type LivenessReading,
  type PendingLivenessReading,
} from './liveness-reading.ts'
// Type only: the carried verdict crosses the restart dependencies as an
// opaque value, and nothing of the session manager is loaded here.
import type { CarriedDeadEvidence } from './session-manager.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consecutive-failure cap before onCapReached fires and restarts stop. */
export const RESTART_FAILURE_CAP = 5

/**
 * Delay ceiling (seconds) for a human-triggered restart. An explicit inbound
 * message is a far stronger signal than a periodic health tick, so we clamp the
 * computed backoff delay down to this small constant instead of making a human
 * wait out the full exponential backoff (up to 900s). We clamp DOWN only —
 * never up — so a base delay smaller than this is left untouched.
 *
 * Crucially this only shortens the wait; it does NOT reset the failure counter
 * and does NOT bypass the re-entrancy guard. Combined with
 * isRestartPendingOrActive at the call site, a chatty persona gets at most one
 * in-flight launch attempt at a time and each failed attempt still counts
 * toward normal backoff/cap accounting (b.kvq).
 */
export const HUMAN_TRIGGER_DELAY_CEILING = 5

// ---------------------------------------------------------------------------
// Outcomes of the restart work and of the retry entry
// ---------------------------------------------------------------------------

/**
 * The server is shutting down: nothing was probed, reconnected, killed or
 * launched; or the kill before the relaunch answered `ErrInvalidFlags` and
 * its immediate version re-check decided that the server stops (b.jg5
 * SRJ-104, SRJ-204, SRJ-205), so nothing more was called and nothing was
 * recorded.
 */
export const RESTART_OUTCOME_SHUTTING_DOWN = 'shutting-down'
/** The persona is not up (or not applied): its instance and row were left as they are. */
export const RESTART_OUTCOME_NOT_UP = 'not-up'
/** The row reads live and the session is connected with its stream: nothing to do. */
export const RESTART_OUTCOME_ALREADY_CONNECTED = 'already-connected'
/** The row read live and the reconnect succeeded (a success was recorded). */
export const RESTART_OUTCOME_RECONNECTED = 'reconnected'
/**
 * The row reads live and the reconnect did not succeed or was deferred
 * (`transient`, no answer, or `escalate-dead` with the row still reading
 * live): no launch, nothing counted.
 */
export const RESTART_OUTCOME_RECONNECT_DEFERRED = 'reconnect-deferred'
/**
 * The row reads `pending` (its session has not started): the liveness probe
 * read it `pending` and the work handed it to the `pending` deferral
 * (`RestartDeps.deferPendingRow`), whatever the session's connection showed
 * (b.jg5 SRJ-314); or the probe read it `live` and the reconnect adapter's
 * own read found it `pending`, so the reconnect typed nothing and was
 * deferred (`pending`); or b.d61's re-probe after an 'escalate-dead'
 * reconnect read it `pending`. No reconnect, kill or launch, nothing counted.
 * Never "nothing left to recover" (SRJ-305).
 */
export const RESTART_OUTCOME_PENDING_DEFERRED = 'pending-deferred'
/**
 * The launch ran and succeeded (a success was recorded), after the kill, or
 * with no kill after an escalate-dead verdict that is not dead evidence
 * (b.jg5 SRJ-611).
 */
export const RESTART_OUTCOME_LAUNCHED = 'launched'
/**
 * The launch was refused (its UNAVAILABLE retry timer was armed for it), or
 * the kill before it did not succeed and latched nothing (b.jg5 SRJ-110,
 * SRJ-701: UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED, a class the kill
 * has no row for included, no kill outcome, or a kill that threw), so nothing
 * was launched. Not counted.
 */
export const RESTART_OUTCOME_REFUSED = 'refused'
/** The launch failed and the failure was counted, below the cap. */
export const RESTART_OUTCOME_COUNTED_FAILURE = 'counted-failure'
/**
 * The persona is at the restart cap: the launch failed and its counted
 * failure reached or passed the cap; or (retry entry only) the persona was
 * already at the cap when the retry's serialized work started, so no
 * agent-director call was made and nothing was counted or notified.
 */
export const RESTART_OUTCOME_CAPPED = 'capped'
/** The launch was declined by its own gate (the persona stopped being up, or the server is stopping). Not counted. */
export const RESTART_OUTCOME_LAUNCH_SKIPPED = 'launch-skipped'
/**
 * The liveness probe (or b.d61's re-probe) read `unknown`, or threw
 * (b.jg5 SRJ-314): agent-director could not report on the persona. No
 * reconnect, kill or launch, nothing counted; the arm hook
 * (`RestartDeps.armRetryTimer`) was called for the persona.
 */
export const RESTART_OUTCOME_LIVENESS_UNKNOWN = 'liveness-unknown'
/**
 * The persona is latched (b.jg5 SRJ-502, `RestartDeps.isLatched`): the work's
 * first step found it so, and nothing was probed, reconnected, killed or
 * launched, and nothing was recorded; or it latched while a liveness probe
 * (or the 'escalate-dead' reconnect, or its re-probe) ran, the probe's own
 * `status` read included (an UNUSABLE NAME answer, b.jg5 SRJ-512, or the
 * persona's own row reading `pending` with no launch start, SRJ-513), and the
 * latched query asked again right after each probe and before the instance
 * is reconnected, re-probed or killed found it so, and nothing more was done
 * or recorded (no `pending` deferral, no arm hook); or its launch answered
 * `'skipped'` because the persona latched at that launch (a CONFLICT or an
 * UNUSABLE NAME at a spawn or resume), after which nothing was recorded
 * either; or the kill before the relaunch answered a CONFLICT or an UNUSABLE
 * NAME, which latched the persona (b.jg5 SRJ-110, SRJ-501, SRJ-512), and
 * nothing was launched or recorded. A latched query that
 * threw answers this too (fail safe). The retry timer stops on it.
 */
export const RESTART_OUTCOME_LATCHED = 'latched'
/**
 * The persona is held on `ErrInvalidFlags` (b.jg5 SRJ-207, SRJ-303,
 * `RestartDeps.isHeld`): the gate right after a latched gate found it so, so
 * nothing was probed, reconnected, killed or launched, or nothing more was
 * called; or its launch answered `'skipped'` because its reuse spawn met
 * `ErrInvalidFlags` and held it. Nothing was recorded and nothing counts
 * toward the cap. A held query that threw answers this too (fail safe). The
 * retry timer stops on it (SRJ-305).
 */
export const RESTART_OUTCOME_HELD = 'held'
/**
 * A live-row sequence runs for the persona (b.jg5 SRJ-706, SRJ-303,
 * `RestartDeps.isLiveRowSequenceRunning`): the work's gate right after the
 * latched gate found it so, so nothing was probed, reconnected, killed or
 * launched; or the gate asked again (after a probe, after an 'escalate-dead'
 * reconnect, before the kill, before the launch) found it so, and nothing
 * more was called; or the launch answered `'refused'` while the sequence ran
 * (the launch's ladder started it at a replacement site, or met it, and
 * answered `sequence-waiting`, b.jg5 SRJ-707). Nothing was recorded and
 * nothing counts toward the cap. A refusal at a retry (SRJ-302): the retry
 * timer re-arms at the doubled wait.
 */
export const RESTART_OUTCOME_SEQUENCE_WAITING = 'sequence-waiting'
/** Retry entry only: a launch was in flight for the persona, so no agent-director call was made. */
export const RESTART_OUTCOME_IN_FLIGHT = 'in-flight'
/** Retry entry only: `initRestart` has not run, so nothing was done. */
export const RESTART_OUTCOME_NOT_INITIALISED = 'not-initialised'

/** What one run of the restart work answers. The restart timer ignores it. */
export type RestartWorkOutcome =
  | typeof RESTART_OUTCOME_SHUTTING_DOWN
  | typeof RESTART_OUTCOME_NOT_UP
  | typeof RESTART_OUTCOME_ALREADY_CONNECTED
  | typeof RESTART_OUTCOME_RECONNECTED
  | typeof RESTART_OUTCOME_RECONNECT_DEFERRED
  | typeof RESTART_OUTCOME_PENDING_DEFERRED
  | typeof RESTART_OUTCOME_LAUNCHED
  | typeof RESTART_OUTCOME_REFUSED
  | typeof RESTART_OUTCOME_COUNTED_FAILURE
  | typeof RESTART_OUTCOME_CAPPED
  | typeof RESTART_OUTCOME_LAUNCH_SKIPPED
  | typeof RESTART_OUTCOME_LIVENESS_UNKNOWN
  | typeof RESTART_OUTCOME_LATCHED
  | typeof RESTART_OUTCOME_HELD
  | typeof RESTART_OUTCOME_SEQUENCE_WAITING

/** What the retry entry (`runRestartRetry`) answers: the work's outcome, or why it did not run. */
export type RestartRetryOutcome =
  | RestartWorkOutcome
  | typeof RESTART_OUTCOME_IN_FLIGHT
  | typeof RESTART_OUTCOME_NOT_INITIALISED

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Restart dependencies. Every `key` is a persona key. */
export interface RestartDeps {
  /**
   * Whether the persona may be restarted at all: false while it is not up (its
   * bring-up is broken or retrying, or its Slack connection is not serving;
   * b.av2 SR-6.4). Asked when a restart is scheduled, when its timer fires
   * (before `isSessionAlive`) and again after that probe (before
   * `reconnectSession` or `killSession`), and after the second
   * `isSessionAlive` probe that follows an 'escalate-dead' reconnect (b.d61):
   * a not-up persona's instance is
   * never killed, reconnected, deleted or launched, and its failure count is
   * left as it is. The server passes the relaunch gate
   * (`createPersonaRelaunchGate`).
   */
  canRestart(key: string): boolean
  /**
   * The persona's liveness reading (b.jg5 SRJ-314, `src/liveness-reading.ts`):
   * `live`, `pending` (with the row's launch start when the `status` result
   * showed one), `dead` or `unknown`. Only `dead` leads to the kill and the
   * launch. `live` takes the reconnect path; `pending` on the work's first
   * liveness probe goes to `deferPendingRow` and the work returns
   * `RESTART_OUTCOME_PENDING_DEFERRED` with no reconnect, kill, launch or
   * accounting (`pending` on the b.d61 re-probe after an 'escalate-dead'
   * reconnect returns `RESTART_OUTCOME_PENDING_DEFERRED` with its own line
   * and does not call `deferPendingRow`); `unknown`, a probe that
   * throws and an answer that is not a reading all read `unknown`: the work
   * returns `RESTART_OUTCOME_LIVENESS_UNKNOWN` with no reconnect, kill,
   * launch or accounting, and calls `armRetryTimer`.
   */
  isSessionAlive(key: string): Promise<LivenessReading>
  /** Check if the session already has a live MCP connection in the registry. */
  isSessionConnected(key: string): boolean
  /**
   * Check if the session's standalone GET SSE stream (`_GET_stream`) is present
   * in its transport. A session can be `connected === true` in the registry
   * while the SDK has silently deleted the stream map entry — in that state
   * messages cannot reach the bot, so it must NOT count as "already reconnected"
   * (b.9cj). Returns false when there is no session at all.
   */
  hasSessionStream(key: string): boolean
  /**
   * Attempt to reconnect the MCP session. Returns a discriminated result so
   * restart.ts can call recordSuccess on the 'success' path. `'pending'`: the
   * adapter's own read found the row `pending` (the liveness probe had read
   * it `live`), so nothing was typed and the reconnect is deferred, as
   * `'transient'` is; the work answers `RESTART_OUTCOME_PENDING_DEFERRED`
   * for it, so the retry timer knows the row read `pending`.
   * The escalate-dead answer carries the verdict the adapter swept with
   * (`ReconnectEscalateDead`, b.jg5 SRJ-611); a bare 'escalate-dead'
   * carries none. After a `dead` re-probe only a verdict that is dead
   * evidence leads to the kill; any other relaunches with no kill (b.jg5
   * SRJ-609, SRJ-611, `ReconnectSessionResult`).
   *
   * The return type is widened from void: the server.ts adapter already
   * computes reconnectMcp's ReconnectMcpResult union internally and now
   * surfaces it here so restart.ts has a success signal (SR-25.1).
   *
   * Returning void (e.g. from a reconnect that throws and is caught by the
   * adapter) is treated as non-success — no recordSuccess, no recordFailure
   * (see comment below on why failure is NOT counted here).
   */
  reconnectSession(key: string): Promise<ReconnectSessionResult>
  /**
   * Kill the persona's instance before its launch, with one checked kill
   * (b.jg5 SRJ-110, SRJ-701), and answer its outcome (`KillOutcome`,
   * `kill_sent` included), or `KILL_SESSION_NOT_KILLED_GUARD` when a guard
   * made no call. Required: every kill reports its outcome. `lastRead` is
   * the run's last liveness reading, the `dead` one that led to the kill:
   * it carries the row state the run read (`ended`, `missing` or no row,
   * `deadRowReadOf`), or none (`ErrSystemInstallDisappeared`), and is the
   * state a latch the kill sets records (b.jg5 SRJ-501), with no further
   * `status` read when it carries one. The work launches only after a
   * success form (`killed`, any `kill_sent`; `row-gone`, `ErrSpawnNotFound`;
   * `session-gone`, GONE; `row-finished`) or the guard answer. A CONFLICT or
   * an UNUSABLE NAME (which the adapter latched), and any other non-success
   * after which the persona is latched (b.jg5 SRJ-702: a `status` read
   * between the kill's tries latched it), answer
   * `RESTART_OUTCOME_LATCHED`; an `ErrInvalidFlags` whose re-check decided
   * that the server stops answers `RESTART_OUTCOME_SHUTTING_DOWN` (b.jg5
   * SRJ-205); every other non-success (UNAVAILABLE, `ErrTmuxKillFailed`
   * included, ENVIRONMENT, CONFIG, UNCLASSIFIED, `ErrSystemInstallDisappeared`
   * and a class the kill has no row for included), an answer that is not an
   * outcome and a kill that throws answer `RESTART_OUTCOME_REFUSED`; none of
   * them launches, records a success or a failure, or reaches the cap.
   */
  killSession(key: string, lastRead: DeadLivenessReading): Promise<KillSessionResult>
  /**
   * `cwd` is the persona's working directory. `'skipped'`: the launch was
   * declined (the persona stopped being up after the last `canRestart`
   * check, or the server is stopping), which counts as neither a success nor
   * a failure. `'refused'`: the launch answered `retrying` (b.jg5 SRJ-1015:
   * its retry timer was armed for it, SRJ-301, so the timer owns the
   * persona) or `sequence-waiting`; it counts as neither either (SRJ-302). `deadEvidence`: the verdict an
   * escalate-dead answer carried (`ReconnectEscalateDead`, b.jg5 SRJ-611),
   * passed on unchanged to the relaunch after it, which carries it into the
   * ladder; absent for any other launch, and for a bare 'escalate-dead'.
   */
  launchSession(key: string, cwd: string, sessionId?: string, deadEvidence?: CarriedDeadEvidence): Promise<LaunchSessionResult>
  getRestartDelay(): number
  isShuttingDown(): boolean
  /**
   * Called exactly once per cap episode when consecutive failures reach the
   * cap (RESTART_FAILURE_CAP). After this fires, scheduleRestart stops
   * queuing new timers for this persona until recordSuccess clears the latch.
   */
  onCapReached(key: string): void
  /**
   * The per-persona lifecycle serializer's `run` (b.av2 SR-6.6,
   * `persona-serializer.ts`): a fired timer's work (every check, the probe,
   * reconnect, kill and launch), and a retry entry's work with its in-flight
   * check and then the restart cap first, is submitted through it, so it
   * starts only after every operation already submitted for the persona has
   * settled. Scheduling, backoff, the cap (apart from the retry entry's own
   * check), the `activeLaunches` guard and the human-trigger clamp are not
   * serialized. Without it the work runs at once.
   * Production passes the server's one shared serializer.
   */
  serialize?: PersonaSerialize
  /**
   * The arm hook (b.jg5 SRJ-314, SRJ-301): called once with the persona key
   * on every `RESTART_OUTCOME_LIVENESS_UNKNOWN` return of the restart work,
   * the re-probe's included, so the persona's UNAVAILABLE retry timer is
   * armed even for a reading the adapter's own report does not arm on (a
   * probe that throws, or a `status` answer in a state CSCB does not know;
   * a CONFIG answer is armed by the report itself, in any context, b.jg5
   * SRJ-316). Production arms the timer through
   * its controller with the `read-error` cause; a call while the timer is
   * armed or running its retry keeps its due time and wait count. A hook
   * that throws is logged and changes nothing else. Absent: nothing is armed.
   */
  armRetryTimer?(key: string): void
  /**
   * The `pending` deferral (b.jg5 SRJ-314; SRJ-409's entry point): called
   * once with the persona key and its `pending` reading, which carries the
   * row's launch start when the probe read one (`launchStartedAt`, raw), when
   * the work's first liveness probe reads `pending`, before the session's
   * connection is looked at. The work then answers
   * `RESTART_OUTCOME_PENDING_DEFERRED` with no reconnect, kill, launch or
   * accounting. The b.d61 re-probe after an 'escalate-dead' reconnect is the
   * exception: its `pending` answers `RESTART_OUTCOME_PENDING_DEFERRED` with
   * its own line and does not call this member. Production binds the
   * server's `deferPendingRow`. A member
   * that throws is logged and changes nothing else. Absent: nothing is
   * called, and the work answers the same.
   */
  deferPendingRow?(key: string, reading: PendingLivenessReading): void
  /**
   * The latched query (b.jg5 SRJ-502): true while the persona is latched
   * (production: the server's latch's `isLatched`). Asked first inside the
   * serialized work, before the shutdown and not-up checks and the liveness
   * read, by every path that reaches it (a fired restart timer, the retry
   * entry before its in-flight and cap checks, a human-triggered restart):
   * for a latched persona the work makes no agent-director call, records no
   * success or failure, and answers `RESTART_OUTCOME_LATCHED`. Asked again
   * before the instance is touched, since a launch outside the serializer can
   * latch the persona during the work's awaits: after the liveness probe
   * (with the second `canRestart` check, before `reconnectSession` or
   * `killSession`), right after an 'escalate-dead' reconnect (before its
   * re-probe: the reconnect's findMissing sweep may latch the persona, b.jg5
   * SRJ-120) and right before `killSession` (after that re-probe); a persona
   * latched then answers the same with nothing more done. Asked again
   * when the launch answers `'skipped'`, so a persona that latched at that
   * launch answers the same. An answer of exactly `true` is latched, and so
   * is a query that throws (fail safe: logged in the one latched line, with
   * what it threw); any other answer is not. Absent: no persona is latched.
   */
  isLatched?(key: string): boolean
  /**
   * The held query (b.jg5 SRJ-207, SRJ-303): true while the persona is held
   * on `ErrInvalidFlags` (production: the server's hold's `isHeld`). Asked
   * right after each latched gate, by every path that reaches the work (a
   * fired restart timer, the retry entry before its in-flight and cap
   * checks, a human-triggered restart): for a held persona the work makes no
   * agent-director call (`status`, kill, `send-keys`, spawn or `resume`),
   * records no success or failure, adds nothing toward the cap and answers
   * `RESTART_OUTCOME_HELD`. Asked again wherever the latched query is asked
   * again, and when the launch answers `'skipped'`, so a persona held at that
   * launch answers the same. `scheduleRestart` asks it right after the
   * latched query and arms no timer for a held persona. An answer of exactly
   * `true` is held, and so is a query that throws (fail safe, logged in the
   * one line); any other answer is not. Absent: no persona is held.
   */
  isHeld?(key: string): boolean
  /**
   * Whether a live-row sequence runs for the persona (b.jg5 SRJ-706, SRJ-303;
   * production: the session manager's running query,
   * `isLiveRowSequenceRunning`). Asked right after the first latched gate of
   * the serialized work, before the shutdown and not-up checks and the
   * liveness read, by every path that reaches it (a fired restart timer, the
   * retry entry, a human-triggered restart): while it answers true the work
   * makes no agent-director call, records no success or failure, adds nothing
   * toward the cap and answers `RESTART_OUTCOME_SEQUENCE_WAITING`. Asked
   * again wherever the latched query is asked again (after each liveness
   * probe, after an 'escalate-dead' reconnect, right before the kill), once
   * more right before the launch, and after a launch that answered
   * `'refused'`: a sequence running then ends the work with the same answer
   * and nothing more called. It is the
   * backstop for restart work queued before the sequence started; the retry
   * entry's own in-flight check (the server's "blocks a retry", which counts a
   * running sequence) answers first there. An answer of exactly `true` is
   * running, and so is a query that throws (fail safe, logged in the one
   * line); any other answer is not. Absent: no sequence runs.
   */
  isLiveRowSequenceRunning?(key: string): boolean
  /**
   * The slow-recovery observer (b.jg5 SRJ-610, SRJ-1016; production: the
   * server's slow-recovery tracker, `src/slow-recovery.ts`). It is told what
   * each run read, after the gates that follow each probe (shutdown, not up,
   * latched) have passed, so a run those gates stop tells it nothing:
   * - after an escalate-dead reconnect (bare, or carrying its verdict), the
   *   re-probe reports once: `live`
   *   → `noteLive`; `pending` → `noteOther` with
   *   `RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE`; `dead` from a row read
   *   (`ended`, `missing`, `ErrSpawnNotFound`) → `noteDead`, and `dead` from
   *   `ErrSystemInstallDisappeared` (`isInstallGoneDeadReading`) →
   *   `noteInstallGone`, each before the same run's kill (made only after a
   *   verdict that is dead evidence, b.jg5 SRJ-611) and relaunch;
   *   `unknown` or a thrown probe → nothing; a persona latched by that read
   *   → nothing (the latch's own end applies);
   * - at the run's first liveness probe, `dead` from a row read →
   *   `noteDead`, and `dead` from `ErrSystemInstallDisappeared` →
   *   `noteInstallGone`;
   * - at the run's first liveness probe, `pending` → `noteOther` with
   *   `RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE`;
   * - a run whose reconnect ends with any verdict other than an
   *   escalate-dead one (a success, 'transient', 'pending', no answer or a reconnect that
   *   throws), and a run that finds the session already connected with its
   *   stream → `noteOther` with `RESTART_SLOW_RECOVERY_OTHER_VERDICT`;
   * - a run that stops before the reconnect for any other reason (an
   *   `unknown` first probe, a latch, a launch in flight, shutdown, not up)
   *   → nothing.
   * After a live re-probe nothing else changes: no kill, no launch and no
   * accounting; the next escalate-dead tick sweeps again through the
   * reconnect adapter's ordinary sweep. A note that throws is logged and
   * changes nothing else. Absent: nothing is told, and the work behaves the
   * same.
   */
  slowRecovery?: RestartSlowRecoveryObserver
}

/** `RestartSlowRecoveryObserver.noteOther`'s reason: a run whose reconnect ended with a verdict other than 'escalate-dead', or that found the session already connected with its stream. */
export const RESTART_SLOW_RECOVERY_OTHER_VERDICT = 'other-verdict'
/** `RestartSlowRecoveryObserver.noteOther`'s reason: an 'escalate-dead' verdict whose re-probe read `pending` (not counted, b.jg5 SRJ-610). */
export const RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE = 'pending-reprobe'
/** `RestartSlowRecoveryObserver.noteOther`'s reason: a run whose first liveness probe read `pending` (b.jg5 SRJ-610). */
export const RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE = 'pending-probe'

/** Why the restart work told the slow-recovery observer `noteOther`. */
export type SlowRecoveryOtherReason =
  | typeof RESTART_SLOW_RECOVERY_OTHER_VERDICT
  | typeof RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE
  | typeof RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE

/**
 * What the restart work tells about each run, for the slow dead-session
 * recovery count (b.jg5 SRJ-610; `RestartDeps.slowRecovery` says when).
 * Answers are ignored.
 */
export interface RestartSlowRecoveryObserver {
  /** An 'escalate-dead' verdict whose re-probe reads the row `live`. */
  noteLive(key: string): unknown
  /** A row read of `ended` or `missing`, or no row (`ErrSpawnNotFound`). */
  noteDead(key: string): unknown
  /** The `dead` reading from `ErrSystemInstallDisappeared`, which reads no row. */
  noteInstallGone(key: string): unknown
  /** A run whose reconnect ended with another verdict or that found the session already connected with its stream, a run whose first probe read `pending`, or an 'escalate-dead' verdict whose re-probe read `pending`. */
  noteOther(key: string, reason: SlowRecoveryOtherReason): unknown
}

/**
 * `RestartDeps.reconnectSession`'s escalate-dead answer that carries the
 * verdict the adapter swept with (b.jg5 SRJ-611): `deadEvidence`, built by
 * the session manager (`carriedDeadEvidenceOf`) and carried here as an
 * opaque value, of which the work reads only whether it is dead evidence
 * (`evidence === true`). The work handles every escalate-dead answer alike
 * (the latch check, the re-probe and its slow-recovery note); when the
 * re-probe reads `dead`:
 *   - a GONE-based verdict (dead evidence) leads to the checked kill, then
 *     the relaunch, which carries the verdict;
 *   - any other verdict (`row-not-interactive`, a row read such as
 *     `row-absent-at-pane-read`) leads to the relaunch alone, carrying the
 *     verdict, with no kill: it never by itself leads to a kill (b.jg5
 *     SRJ-609, SRJ-611), and the ladder's collision `get` reads the row
 *     itself.
 */
export interface ReconnectEscalateDead {
  readonly outcome: 'escalate-dead'
  readonly deadEvidence: CarriedDeadEvidence
}

/**
 * What `RestartDeps.reconnectSession` answers; `void` is a non-success. The
 * escalate-dead answers are `ReconnectEscalateDead`, carrying its verdict,
 * and the bare 'escalate-dead', which carries none and so is read as no dead
 * evidence (fail safe: a `dead` re-probe after it relaunches with no kill,
 * b.jg5 SRJ-611).
 */
export type ReconnectSessionResult =
  | 'success'
  | 'escalate-dead'
  | ReconnectEscalateDead
  | 'transient'
  | 'pending'
  | void

/**
 * The escalate-dead answer in `result`: `{}` for a bare 'escalate-dead'
 * (no verdict carried), `{ deadEvidence }` for `ReconnectEscalateDead`, and
 * `undefined` for every other answer.
 */
function escalateDeadOf(result: ReconnectSessionResult): { deadEvidence?: CarriedDeadEvidence } | undefined {
  if (result === 'escalate-dead') return {}
  if (typeof result === 'object' && result !== null && result.outcome === 'escalate-dead') return { deadEvidence: result.deadEvidence }
  return undefined
}

/**
 * The restart work's line when a `dead` re-probe after an escalate-dead
 * verdict that is not dead evidence relaunches persona `key` with no kill
 * (b.jg5 SRJ-609, SRJ-611): `deadEvidence` is the verdict carried, absent
 * when none was (a bare 'escalate-dead').
 */
export function relaunchWithoutKillLine(key: string, deadEvidence?: CarriedDeadEvidence): string {
  const verdict = deadEvidence === undefined ? 'none carried' : `verdict=${String(deadEvidence.source)}`
  return `[slack] No kill before the relaunch for persona=${key} — its escalate-dead verdict (${verdict}) is not dead evidence, which never by itself leads to a kill; the relaunch's own row read decides (b.jg5 SRJ-609, SRJ-611)`
}

/**
 * `RestartDeps.killSession`'s answer when one of the adapter's guards made no
 * call (b.jg5 SRJ-110: "its guards stay"): a launch is already in flight for
 * the persona, or its `claude_config_dir` cannot be resolved to a real path.
 * Nothing was killed; the work goes on to the launch as it always has (the
 * launch joins the one in flight, or the relaunch gate refuses it).
 */
export const KILL_SESSION_NOT_KILLED_GUARD = 'not-killed-guard'

/**
 * What `RestartDeps.killSession` answers: the kill's outcome
 * (`src/checked-kill.ts`; b.jg5 SRJ-110, SRJ-701), `kill_sent` included, or
 * `KILL_SESSION_NOT_KILLED_GUARD` when a guard made no call.
 */
export type KillSessionResult = KillOutcome | typeof KILL_SESSION_NOT_KILLED_GUARD

/**
 * `relaunchAfterKillLine`'s form for a relaunch with no kill made: after an
 * escalate-dead verdict that is not dead evidence (b.jg5 SRJ-609, SRJ-611).
 */
export const RELAUNCH_KILL_NONE = 'kill-none'

/**
 * The restart work's line naming the kill's outcome, before the relaunch
 * after a kill that succeeded, a guard that made no call, or no kill at all
 * (`RELAUNCH_KILL_NONE`, SRJ-611) (b.jg5 SRJ-701, SRJ-1014): a kill's line
 * is `describeKillOutcome`'s rendering, `kill_sent` included.
 */
export function relaunchAfterKillLine(
  key: string,
  cwd: string,
  killed: KillSuccess | typeof KILL_SESSION_NOT_KILLED_GUARD | typeof RELAUNCH_KILL_NONE,
): string {
  const kill =
    killed === RELAUNCH_KILL_NONE
      ? 'none (b.jg5 SRJ-611)'
      : killed === KILL_SESSION_NOT_KILLED_GUARD
        ? 'not killed (a guard made no call)'
        : describeKillOutcome(killed)
  return `[slack] Relaunching session for persona=${key} cwd="${cwd}" — kill: ${kill}`
}

/**
 * The restart work's line when the kill did not succeed (b.jg5 SRJ-110,
 * SRJ-701): no relaunch and nothing counted. `described` is the outcome's
 * rendering (`describeKillOutcome`), or why the answer was no outcome.
 */
export function killNotSucceededLine(key: string, described: string, latched: boolean): string {
  return latched
    ? `[slack] Session kill for persona=${key} did not succeed (${described}) — the persona is latched; no relaunch; not counted`
    : `[slack] Session kill for persona=${key} did not succeed (${described}) — no relaunch; not counted`
}

/**
 * What a restart's launch answers: true launched, false a counted failure,
 * `'skipped'` declined and `'refused'` handed to the retry timer, neither of
 * which is counted.
 */
export type LaunchSessionResult = boolean | 'skipped' | 'refused'

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

const pendingRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Per persona key, how many restart works (a fired timer's, a retry entry's)
 * are running or waiting for their serializer turn. A key is active while its
 * count is above 0, so one work that ends never hides another still running.
 */
const activeLaunches = new Map<string, number>()
let deps: RestartDeps | null = null

function markActive(key: string): void {
  activeLaunches.set(key, (activeLaunches.get(key) ?? 0) + 1)
}

function unmarkActive(key: string): void {
  const count = (activeLaunches.get(key) ?? 0) - 1
  if (count > 0) activeLaunches.set(key, count)
  else activeLaunches.delete(key)
}

// ---------------------------------------------------------------------------
// initRestart
// ---------------------------------------------------------------------------

export function initRestart(d: RestartDeps): void {
  deps = d
}

// ---------------------------------------------------------------------------
// scheduleRestart
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed relaunch of the persona with this key. `cwd` is the
 * persona's working directory.
 *
 * A latched persona gets no timer (b.jg5 SRJ-502, SRJ-315): the latched query
 * (`RestartDeps.isLatched`) is asked first, before any other gate, and when it
 * answers latched (or throws, which counts as latched: fail safe) this logs
 * one line saying no restart was scheduled and returns without arming a
 * timer, so the health tick, which skips a persona whose restart is pending,
 * keeps reading the latched persona. Any timer already pending for the
 * persona is left as it is (its work asks the same query first and makes no
 * attempt for a latched persona). A persona held on `ErrInvalidFlags` gets no
 * timer either (b.jg5 SRJ-207: `RestartDeps.isHeld`, asked right after).
 */
export function scheduleRestart(
  key: string,
  cwd: string,
  sessionId?: string,
  opts?: { humanTrigger?: boolean },
): void {
  if (!deps) {
    console.error('[slack] scheduleRestart: deps not initialized — skipping')
    return
  }

  // b.jg5 SRJ-502: a latched persona gets no timer, so a pending restart never
  // hides it from the health tick (SRJ-315).
  const latched = readLatched(deps, key)
  if (latched.latched) {
    console.error(`[slack] Not scheduling restart for persona=${key} — the persona is latched${latchedFailure(latched)}; no timer armed (b.jg5 SRJ-502)`)
    return
  }
  // b.jg5 SRJ-207: nor does a persona held on ErrInvalidFlags.
  const held = readHeld(deps, key)
  if (held.held) {
    console.error(`[slack] Not scheduling restart for persona=${key} — the persona is held on ErrInvalidFlags${heldFailure(held)}; no timer armed (b.jg5 SRJ-207)`)
    return
  }

  const baseDelay = deps.getRestartDelay()
  if (baseDelay === 0) {
    console.error(`[slack] Auto-restart disabled (delay=0) — skipping restart for persona=${key}`)
    return
  }

  // At shutdown every persona's bring-up is cancelled (so none is up) and the
  // HTTP server's stop aborts every MCP stream, which lands here: arm no timer,
  // and do not ask the relaunch gate, which would log a healthy persona as
  // not relaunched.
  if (deps.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return
  }

  // b.av2 SR-6.4: a persona that is not up gets no timer at all.
  if (!deps.canRestart(key)) {
    console.error(`[slack] Not scheduling restart for persona=${key} — the relaunch gate refused it (the persona is not up, or is no longer in the applied configuration)`)
    return
  }

  // Compute exponential backoff delay from the pre-failure count (SR-25.2).
  // nextBackoffDelay reads the CURRENT count (before this attempt's failure is
  // recorded) so the first failure uses base*2^0 = base, the second base*2^1, etc.
  let delay = nextBackoffDelay(key, baseDelay)

  // b.kvq: an explicit human message clamps the wait DOWN to a small ceiling so
  // a message lost to a down persona doesn't leave it down for a 900s backoff. This
  // does not touch the failure counter — each attempt still counts toward
  // backoff/cap accounting — and the re-entrancy guard at the call site keeps a
  // chatty persona to one in-flight launch at a time.
  if (opts?.humanTrigger) {
    delay = Math.min(delay, HUMAN_TRIGGER_DELAY_CEILING)
  }

  // Cancel any existing timer for this persona
  const existing = pendingRestartTimers.get(key)
  if (existing !== undefined) {
    clearTimeout(existing)
    pendingRestartTimers.delete(key)
  }

  console.error(`[slack] Scheduling restart for persona=${key} in ${delay}s (backoff)`)

  const timer = setTimeout(async () => {
    pendingRestartTimers.delete(key)
    markActive(key)

    try {
      const d = deps
      if (!d) return
      // b.av2 SR-6.6: the timer body's work runs through the per-persona
      // lifecycle serializer, after any operation already running or queued
      // for this persona (a teardown, a bring-up retry's launch). Every check
      // below runs when the work starts, not when the timer fired. The
      // `activeLaunches` entry covers the wait, so the health check and the
      // lost-message path see the restart as active meanwhile. The work's
      // outcome is not used here.
      await (d.serialize ?? runNow)(key, () => runRestartWork(d, key, cwd, sessionId))
    } finally {
      unmarkActive(key)
    }
  }, delay * 1000)

  pendingRestartTimers.set(key, timer)
}

/** Run an operation at once (synchronously up to its first await): the timer body without an injected serializer. */
async function runNow<T>(_key: string, operation: () => T | Promise<T>): Promise<T> {
  return operation()
}

// ---------------------------------------------------------------------------
// runRestartRetry — the UNAVAILABLE retry timer's entry (b.jg5 SRJ-303)
// ---------------------------------------------------------------------------

/**
 * Rerun the restart path's decision for persona `key` now, for the
 * UNAVAILABLE retry timer's full mode (b.jg5 SRJ-303). `cwd` is the persona's
 * working directory; `isInFlight(key)` is the caller's in-flight check (the
 * server's "blocks a retry": a launch call, the persona's live-row sequence,
 * or an old-life wait step for a hold it waits on), and `blockCause(key)`,
 * when given, names which one in the skip line (`restartRetrySkippedLine`).
 *
 * The key is active (`isRestartPendingOrActive`) while the entry runs. Its
 * work goes through the same per-persona serializer as a fired restart
 * timer's (`RestartDeps.serialize`), so it never overlaps a teardown, a
 * bring-up retry's launch or a restart for the persona. Inside that work,
 * first, the latched query (`RestartDeps.isLatched`, b.jg5 SRJ-502): a
 * latched persona (a query that throws included) answers
 * `RESTART_OUTCOME_LATCHED` with no agent-director call. Then the held query
 * (`RestartDeps.isHeld`, b.jg5 SRJ-207): a persona held on `ErrInvalidFlags`
 * answers `RESTART_OUTCOME_HELD` with no agent-director call. Then `isInFlight(key)`: true answers `RESTART_OUTCOME_IN_FLIGHT` with no
 * agent-director call (a check that throws counts as true). Then the restart
 * cap: at the cap (an earlier restart work's counted failure reached it while
 * this retry waited its turn, although the retry timer checked the cap before
 * calling) it answers `RESTART_OUTCOME_CAPPED` with no agent-director call,
 * nothing counted and no notice (the cap notice went out with the failure
 * that reached the cap). Asking it here is enough: failures are counted only
 * inside the restart work, which the serializer runs one at a time per
 * persona, so the cap cannot be reached while this retry's own work runs.
 * Otherwise the restart work runs, as one recovery attempt, with today's
 * accounting, and its outcome is answered. It bypasses only the restart delay
 * and the restart timer: `getRestartDelay` is never read (it runs with delay
 * 0 too) and no restart timer is armed, cleared or needed. Before `initRestart` it answers
 * `RESTART_OUTCOME_NOT_INITIALISED` and logs. Rejects only when the
 * serializer or an unguarded dependency (`isShuttingDown`, `canRestart`,
 * `isSessionConnected`, `hasSessionStream`, `onCapReached`) throws.
 */
export async function runRestartRetry(
  key: string,
  cwd: string,
  isInFlight: (key: string) => boolean,
  blockCause?: (key: string) => RetryBlockCause | undefined,
): Promise<RestartRetryOutcome> {
  const d = deps
  if (!d) {
    console.error(`[slack] runRestartRetry: deps not initialized — skipping the retry for persona=${key}`)
    return RESTART_OUTCOME_NOT_INITIALISED
  }
  markActive(key)
  try {
    return await (d.serialize ?? runNow)(key, async (): Promise<RestartRetryOutcome> => {
      // b.jg5 SRJ-502: a latched persona gets no attempt, whatever else holds.
      if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
      // b.jg5 SRJ-207, SRJ-303: nor does a persona held on ErrInvalidFlags.
      if (skipIfHeld(d, key)) return RESTART_OUTCOME_HELD
      if (launchInFlight(key, isInFlight)) {
        // b.jg5 SRJ-303: the skip line names what blocks the retry.
        console.error(restartRetrySkippedLine(key, readRetryBlockCause(key, blockCause)))
        return RESTART_OUTCOME_IN_FLIGHT
      }
      if (isAtCap(key, RESTART_FAILURE_CAP)) {
        console.error(`[slack] Restart retry skipped for persona=${key} — the persona is at the restart cap; nothing killed or launched`)
        return RESTART_OUTCOME_CAPPED
      }
      return runRestartWork(d, key, cwd, undefined)
    })
  } finally {
    unmarkActive(key)
  }
}

/**
 * The retry entry's skip line for work in flight (b.jg5 SRJ-303), naming what
 * blocks the retry (`retryBlockSkipText`: a launch call, the persona's
 * live-row sequence, or an old-life wait step for a hold it waits on; a
 * launch when the cause is not known):
 *
 *   [slack] Restart retry skipped for persona=<key> — <a launch is in flight|its live-row sequence runs|an old-life wait step it waits on runs>; no agent-director call
 *
 * Pure.
 */
export function restartRetrySkippedLine(key: string, cause: RetryBlockCause | undefined): string {
  return `[slack] Restart retry skipped for persona=${key} — ${retryBlockSkipText(cause)}; no agent-director call`
}

/** The retry entry's in-flight check: `isInFlight(key)`, with a throw counted as in flight (logged). */
function launchInFlight(key: string, isInFlight: (key: string) => boolean): boolean {
  try {
    return isInFlight(key)
  } catch (err) {
    console.error(`[slack] restart retry: in-flight check failed for persona=${key}: ${describeThrownValue(err)} — treated as in flight`)
    return true
  }
}

/**
 * The work a restart timer does when it fires, and a retry reruns, run
 * through the serializer: the shutdown and not-up checks, the liveness probe,
 * the not-up check again, then, by the reading (b.jg5 SRJ-314), a return with
 * nothing done (`unknown`, a thrown probe included: the arm hook is called;
 * `pending`, whatever the session's connection shows: the `pending` deferral
 * is called), a reconnect (`live`), or a kill and a launch (`dead`), and the
 * success or failure accounting. A reconnect whose verdict
 * is escalate-dead is followed by a second liveness probe; only when the
 * row now reads `dead` does the same run go on to the launch (b.d61), which
 * carries the verdict the answer carried (`ReconnectEscalateDead`; b.jg5
 * SRJ-611). Only a GONE-based verdict, dead evidence, is preceded by the
 * checked kill; after any other verdict (`row-not-interactive`, a row read,
 * or a bare 'escalate-dead' that carries none) a `dead` re-probe leads to
 * the launch alone, with no kill (`relaunchWithoutKillLine`, b.jg5 SRJ-609,
 * SRJ-611). A run whose first liveness read is `dead` makes its checked kill
 * and then its launch, carrying nothing. When a
 * kill is made, the launch follows only its success, or a guard of the
 * adapter's that made no call (`killBeforeRelaunch`, b.jg5 SRJ-110, SRJ-701);
 * any other answer ends the work with `RESTART_OUTCOME_LATCHED` (a CONFLICT or
 * an UNUSABLE NAME) or `RESTART_OUTCOME_REFUSED`: no launch, nothing counted. The restart cap is not
 * asked here (the retry entry asks it before this work). The whole work is
 * one recovery attempt for the persona (b.jg5 SRJ-301). Answers what it did (`RestartWorkOutcome`).
 */
async function runRestartWork(d: RestartDeps, key: string, cwd: string, sessionId: string | undefined): Promise<RestartWorkOutcome> {
  // b.jg5 SRJ-502: the gate before the liveness read; a latched persona's
  // instance is never probed, reconnected, killed or launched here. The steps
  // ask again after their awaits, before the instance is touched.
  if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
  // b.jg5 SRJ-207, SRJ-303: a persona held on ErrInvalidFlags gets no
  // attempt: no liveness read, kill or launch, nothing recorded or counted.
  if (skipIfHeld(d, key)) return RESTART_OUTCOME_HELD
  // b.jg5 SRJ-706, SRJ-303: while P's live-row sequence runs, no other launch
  // path for P starts: no liveness read, kill or launch, nothing recorded.
  // A key outside the applied set beside the old-life wait on its own row
  // passes this gate with nothing armed (b.jg5 SRJ-1512; main()'s
  // `liveRowSequenceGate`), and the not-up gate below refuses it.
  if (skipIfSequenceRunning(d, key)) return RESTART_OUTCOME_SEQUENCE_WAITING
  return runInAttempt(key, 'recovery', () => restartWorkSteps(d, key, cwd, sessionId))
}

/** The steps of `runRestartWork`, inside its recovery attempt. */
async function restartWorkSteps(d: RestartDeps, key: string, cwd: string, sessionId: string | undefined): Promise<RestartWorkOutcome> {
  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return RESTART_OUTCOME_SHUTTING_DOWN
  }

  // b.av2 SR-6.4: the persona stopped being up after this restart was
  // scheduled (e.g. Slack refused a token on a reopen). Leave its instance
  // and its row alone: no liveness probe, reconnect, kill or launch, and
  // no success or failure recorded.
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP

  const probe = await probeLiveness(d, key)

  // Asked again after the liveness probe: it is an async agent-director
  // call, and the persona may have stopped being up while it ran. This is
  // the last check before `reconnectSession` or `killSession` touch the
  // instance; `launchSession`'s own gate (`'skipped'` below) covers a flip
  // during the kill.
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP
  // b.jg5 SRJ-502: the latch is asked again for the same reason. A launch
  // outside the serializer (e.g. the start pass's) may have latched the
  // persona while the probe ran, or the probe's own `status` read did (an
  // UNUSABLE NAME answer, b.jg5 SRJ-512, or its own row reading `pending`
  // with no launch start, SRJ-513, read `unknown`); then nothing is
  // deferred, reconnected or killed, and the arm hook is not called.
  if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
  // b.jg5 SRJ-207: so is the held gate: a launch outside the serializer may
  // have held the persona while the probe ran (its reuse spawn's ErrInvalidFlags).
  if (skipIfHeld(d, key, 'after its liveness probe')) return RESTART_OUTCOME_HELD
  // b.jg5 SRJ-706: the sequence gate is asked again wherever the latched gate
  // is: a launch outside the serializer may have started P's live-row
  // sequence while the probe ran (a collision ladder's replacement site).
  if (skipIfSequenceRunning(d, key, 'after its liveness probe')) return RESTART_OUTCOME_SEQUENCE_WAITING

  // b.jg5 SRJ-314: agent-director could not report on the persona (a
  // `status` error, or a probe that threw). Never read as dead: no
  // reconnect, kill or launch, nothing counted, and the retry timer is armed.
  if (probe.kind === LIVENESS_UNKNOWN) {
    console.error(`[slack] Liveness unknown for persona=${key}${probeFailure(probe)} — no reconnect, kill or launch; nothing counted`)
    armOnUnknown(d, key)
    return RESTART_OUTCOME_LIVENESS_UNKNOWN
  }

  // b.jg5 SRJ-314: the row reads `pending`, so its session has not started.
  // It goes to the `pending` deferral whatever the session's connection
  // shows (a connected `pending` row is never "already reconnected"): no
  // reconnect, kill or launch, nothing counted.
  // b.jg5 SRJ-610: a `pending` first probe resets the slow-recovery count; an
  // open episode stays open.
  if (probe.kind === LIVENESS_PENDING) {
    tellSlowRecovery(d, key, 'noteOther', RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE)
    deferPending(d, key, probe)
    return RESTART_OUTCOME_PENDING_DEFERRED
  }

  // b.jg5 SRJ-610: a `dead` first probe resets the slow-recovery count; a
  // row read of `ended`, `missing` or no row also ends its episode.
  if (probe.kind === LIVENESS_DEAD) noteDeadReading(d, key, probe)

  // `live` takes the reconnect path; only `dead` falls through to the kill
  // and the launch (the kill left out after an escalate-dead verdict that is
  // not dead evidence, b.jg5 SRJ-609, SRJ-611). `deadRead` is the run's last
  // `dead` reading, handed to the kill (b.jg5 SRJ-501: the state the path
  // last read). `deadEvidence` is the verdict an escalate-dead answer
  // carried, handed to the relaunch (b.jg5 SRJ-611); a first `dead` reading
  // carries none.
  let killBeforeLaunch = true
  let deadEvidence: CarriedDeadEvidence | undefined
  let deadRead = deadReadingOf(probe)
  if (probe.kind !== LIVENESS_DEAD) {
    // If the session already re-established its MCP connection (e.g. Claude
    // Code refreshed the SSE stream on its own), skip the reconnect. A
    // session is only truly healed when it is connected AND its standalone
    // GET SSE stream is present: a connected-but-streamless session (b.9cj)
    // cannot receive messages, so it must proceed to recovery rather than be
    // waved through as "already reconnected".
    if (d.isSessionConnected(key) && d.hasSessionStream(key)) {
      console.error(`[slack] Session already reconnected — skipping restart for persona=${key}`)
      // b.jg5 SRJ-610: the persona healed on its own, a verdict other than
      // 'escalate-dead': the slow-recovery count resets; an open episode
      // stays open.
      tellSlowRecovery(d, key, 'noteOther', RESTART_SLOW_RECOVERY_OTHER_VERDICT)
      return RESTART_OUTCOME_ALREADY_CONNECTED
    }
    console.error(`[slack] Session alive but disconnected — reconnecting MCP for persona=${key}`)
    let reconnectResult: ReconnectSessionResult
    try {
      reconnectResult = await d.reconnectSession(key)
    } catch (err) {
      console.error(`[slack] restart: reconnectSession failed for persona=${key}: ${describeThrownValue(err)}`)
      reconnectResult = undefined
    }

    // b.jg5 SRJ-610: a run whose reconnect ends with any verdict other than
    // an escalate-dead one resets the slow-recovery count.
    const escalated = escalateDeadOf(reconnectResult)
    if (escalated === undefined) tellSlowRecovery(d, key, 'noteOther', RESTART_SLOW_RECOVERY_OTHER_VERDICT)

    if (reconnectResult === 'success') {
      // Reconnect succeeded — reset the failure counter and cap latch.
      recordSuccess(key)
      return RESTART_OUTCOME_RECONNECTED
    }
    // Non-success/non-void branches ('escalate-dead', 'transient', 'pending', or undefined):
    // do NOT recordFailure here. SR-25.1 / single counting site: counting
    // lives only at the launchSession boolean below. restart.ts does not
    // re-enter scheduleRestart on any of these outcomes. Post-b.9a7 that is
    // safe: the periodic health-check tick is now the retry driver. On the
    // next tick the persona is re-observed; if it is still alive &&
    // !connected (or has since gone dead), the tick calls scheduleRestart
    // again, so a failed/deferred reconnect is retried without any re-entry
    // here. ('transient' also covers the b.9a7 hazard-2 `working` defer: the
    // tick retries once the turn settles. b.f2b: it also covers a `working`
    // row whose idle evidence is still being gathered — the tick then retries
    // on its first undeliverable observation, and the adapter reconnects the
    // row once its pane has shown the same idle screen and its transcript has
    // ended with a completed turn, both unchanged, across attempts — a
    // `waiting` row whose pane shows a running turn or a prompt, an
    // `ask_user`/`check_permission` row, which is never typed into, and a
    // failed status call, which types nothing blind.) Not counting here keeps
    // the failure count tied to actual launch attempts, not this reconnect
    // site.
    //
    // For the escalate-dead verdicts (a `dead-session` reconnect, whatever its
    // cause, and a row whose read-pane answered GONE or found the row absent)
    // CSCB recovers itself (b.sv7 / Epic t1.tkk.e4): the reconnectSession
    // adapter fires the internal memoized findMissing sweep before returning,
    // which may reconcile the frozen `working` row to `missing`. It may also
    // leave the row live (in `unverified_ids`, or, when `pending`, not judged
    // at all, b.jg5 SRJ-120), and the row may then stay live for further
    // ticks: nothing promises that the re-probe or any later tick reads it
    // dead. After a run the sweep makes, each configured persona's own row
    // left in `unverified_ids` is read with one `get`, and only a
    // `provenance_conflict` note there latches (b.jg5 SRJ-114, SRJ-120). The
    // latch is asked right after the 'escalate-dead' verdict, before the
    // re-probe, so a persona latched that way gets no further agent-director
    // call in this run (b.jg5 SRJ-502); it is asked again right before the
    // kill below. b.d61: this run probes liveness again and, when the row
    // now reads `dead`, falls through to the relaunch branch below at once
    // (its kill only after a verdict that is dead evidence), with the same
    // accounting as any dead-session relaunch. When the
    // row still reads `live` (the sweep failed, left the row live, or a
    // memoized result predates the kill), the run ends with no kill, launch
    // or accounting, and each later escalate-dead tick sweeps again through
    // the adapter's ordinary sweep, with no step beyond it (b.jg5 SRJ-610):
    // the slow-recovery observer counts such re-probes, and the third in a
    // row posts SRJ-1010 once per episode. A `pending` re-probe returns with
    // no relaunch and resets that count; an `unknown` one (b.jg5 SRJ-314)
    // returns with no relaunch, calls the arm hook and leaves the count as it
    // is. The external ~/startup/find-missing-loop.sh is belt-and-braces only
    // — recovery no longer depends on it, and removing it is a separate
    // operator decision. b.jg5 SRJ-609, SRJ-611: only a GONE-based verdict
    // (dead evidence) lets the kill precede the relaunch. A verdict that is
    // not dead evidence (`row-not-interactive`, a row read) or a bare
    // 'escalate-dead' that carries none never by itself leads to a kill, even
    // when the re-probe reads `dead` (a `dead` reading of
    // `ErrSystemInstallDisappeared` reads no row at all): its relaunch makes
    // no kill, the ladder's collision `get` reading the row itself. Either
    // way the relaunch carries the verdict into the ladder.
    if (reconnectResult === 'pending') return RESTART_OUTCOME_PENDING_DEFERRED
    if (escalated === undefined) return RESTART_OUTCOME_RECONNECT_DEFERRED
    deadEvidence = escalated.deadEvidence
    killBeforeLaunch = deadEvidence?.evidence === true
    // b.jg5 SRJ-502: the adapter's sweep may have latched the persona (a
    // post-run `get` of its own row); then no re-probe follows.
    if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
    if (skipIfHeld(d, key, 'after its escalate-dead reconnect')) return RESTART_OUTCOME_HELD
    if (skipIfSequenceRunning(d, key, 'after its escalate-dead reconnect')) return RESTART_OUTCOME_SEQUENCE_WAITING
    const reprobed = await reprobeDeadAfterEscalate(d, key)
    if (typeof reprobed === 'string') return reprobed
    deadRead = reprobed
  }

  // Kill the zombie session, if any, with one checked kill (b.jg5 SRJ-110,
  // SRJ-701): only a success (any `kill_sent`, or `ErrSpawnNotFound`), or a
  // guard of the adapter's that made no call, lets the launch follow.
  // b.jg5 SRJ-502: the latch is asked once more right before the kill, so a
  // persona that latched during the 'escalate-dead' re-probe (or, with the
  // check after the reconnect, during the reconnect) is never killed.
  // b.jg5 SRJ-609, SRJ-611: after an escalate-dead verdict that is not dead
  // evidence no kill is made; the latch is still asked before the relaunch.
  // b.jg5 SRJ-706: so is the sequence gate, before the kill and again before
  // the launch: while P's live-row sequence runs, nothing more is called.
  if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
  if (skipIfHeld(d, key, 'before its kill')) return RESTART_OUTCOME_HELD
  if (skipIfSequenceRunning(d, key, 'before its kill')) return RESTART_OUTCOME_SEQUENCE_WAITING
  if (killBeforeLaunch) {
    const stopped = await killBeforeRelaunch(d, key, cwd, deadRead)
    if (stopped !== undefined) return stopped
  } else {
    console.error(relaunchWithoutKillLine(key, deadEvidence))
    console.error(relaunchAfterKillLine(key, cwd, RELAUNCH_KILL_NONE))
  }
  if (skipIfSequenceRunning(d, key, 'before its launch')) return RESTART_OUTCOME_SEQUENCE_WAITING

  let ok: LaunchSessionResult
  try {
    // b.jg5 SRJ-611: the relaunch after an escalate-dead verdict carries it
    // into the ladder; any other launch is called as it always was.
    ok = deadEvidence === undefined
      ? await d.launchSession(key, cwd, sessionId)
      : await d.launchSession(key, cwd, sessionId, deadEvidence)
  } catch (err) {
    console.error(`[slack] restart: launchSession threw for persona=${key}: ${describeThrownValue(err)}`)
    ok = false
  }

  if (ok === 'skipped') {
    // b.jg5 SRJ-502, SRJ-1015: the launch met a CONFLICT and the persona
    // latched (or it was latched by the time the launch ran). Nothing is
    // recorded, and the outcome says so. A latched query that throws here
    // counts as latched too: `skipped` records nothing either way.
    const reading = readLatched(d, key)
    if (reading.latched) {
      console.error(`[slack] Session relaunch for persona=${key} ended latched${latchedFailure(reading)} — not counted; nothing more is done for it`)
      return RESTART_OUTCOME_LATCHED
    }
    // b.jg5 SRJ-207: the launch's reuse spawn met ErrInvalidFlags and held the
    // persona (or it was held by the time the launch ran). Nothing is recorded.
    const heldReading = readHeld(d, key)
    if (heldReading.held) {
      console.error(`[slack] Session relaunch for persona=${key} ended held on ErrInvalidFlags${heldFailure(heldReading)} — not counted; nothing more is done for it (b.jg5 SRJ-207)`)
      return RESTART_OUTCOME_HELD
    }
    // Declined: the persona stopped being up between the last `canRestart`
    // check above and the launch, and the launch's own gate (the same
    // relaunch gate) logged why; or the launch's version re-check decided
    // the stop, and the server is stopping. The instance was already killed
    // by then, unless the escalate-dead verdict was not dead evidence, which
    // relaunches with no kill (b.jg5 SRJ-611); the failure counter, backoff and cap
    // latch are left exactly as they were.
    return RESTART_OUTCOME_LAUNCH_SKIPPED
  }

  if (ok === 'refused') {
    // b.jg5 SRJ-706, SRJ-707: the launch met P's live-row sequence (its
    // ladder started one at a replacement site, or one was running), so it
    // answered `sequence-waiting`, which `launchSession` reads as refused;
    // the work answers sequence-waiting too, so a retry's re-armed line
    // names the sequence. Nothing is recorded.
    if (skipIfSequenceRunning(d, key, 'after its launch')) return RESTART_OUTCOME_SEQUENCE_WAITING
    // b.jg5 SRJ-302, SRJ-1015: refused, not failed. The launch answered
    // `retrying`: it met an outcome that armed the persona's retry timer,
    // which owns the persona from here. A persona is never given up on for
    // UNAVAILABLE alone, so the failure counter, backoff and cap latch are
    // left exactly as they were.
    console.error(`[slack] Session relaunch refused for persona=${key} — not counted; its UNAVAILABLE retry timer owns the persona`)
    return RESTART_OUTCOME_REFUSED
  }

  if (ok) {
    // Successful launch — reset consecutive-failure counter and cap latch.
    recordSuccess(key)
    return RESTART_OUTCOME_LAUNCHED
  }

  // Launch failed — increment the failure counter (SR-25.1; the restart
  // work's launchSession boolean, and a launch whose result does not come
  // back through it, `recordLaunchResultOutsideRestartWork`, each count their
  // own launch once).
  return countLaunchFailure(d, key, `[slack] Session relaunch failed for persona=${key}`)
}

/**
 * Count one launch failure for persona `key` (SR-25.1): record it, log
 * `failedLine`, and, once per episode when the count reaches the cap, notify
 * through `d.onCapReached` (no further timer is scheduled: the persona is
 * capped, and the tick guard, `isAtCap` in health-check.ts, keeps later
 * ticks from re-scheduling it, SR-25.3/25.4). Answers whether the persona is
 * now at the cap.
 */
function countLaunchFailure(
  d: Pick<RestartDeps, 'onCapReached'> | null,
  key: string,
  failedLine: string,
): typeof RESTART_OUTCOME_CAPPED | typeof RESTART_OUTCOME_COUNTED_FAILURE {
  recordFailure(key)
  console.error(failedLine)
  // Once-per-episode cap notification: fires exactly once when the failure
  // count reaches RESTART_FAILURE_CAP. Subsequent calls return false (latched).
  if (shouldNotifyCap(key, RESTART_FAILURE_CAP)) {
    console.error(`[slack] Cap reached for persona=${key} — notifying and stopping restarts`)
    d?.onCapReached(key)
    return RESTART_OUTCOME_CAPPED
  }
  // A failure past the cap (its notice already sent this episode) is capped too.
  return isAtCap(key, RESTART_FAILURE_CAP) ? RESTART_OUTCOME_CAPPED : RESTART_OUTCOME_COUNTED_FAILURE
}

/**
 * Record the result of a launch for persona `key` whose result does not come
 * back through the restart work's `launchSession` (the live-row sequence's
 * final launch, `launchForLiveRowSequence` in `src/session-manager.ts`; b.jg5
 * SRJ-112, SRJ-113, SRJ-602), as the restart work records its own launch's:
 * a success (`launched` true) resets the persona's failure count and cap
 * latch; a counted failure is recorded, with the cap notice through the
 * installed restart dependencies' `onCapReached` once per episode (none when
 * `initRestart` has not run). The caller decides which results count (a
 * retrying, stopping, latched, held or deferred launch records nothing). Answers
 * `launched`, `counted-failure` or `capped`.
 */
export function recordLaunchResultOutsideRestartWork(
  key: string,
  launched: boolean,
): typeof RESTART_OUTCOME_LAUNCHED | typeof RESTART_OUTCOME_CAPPED | typeof RESTART_OUTCOME_COUNTED_FAILURE {
  if (launched) {
    recordSuccess(key)
    return RESTART_OUTCOME_LAUNCHED
  }
  return countLaunchFailure(deps, key, `[slack] Launch failed for persona=${key} — counted (b.jg5 SRJ-112, SRJ-113, SRJ-602)`)
}

/**
 * The restart work's kill before its relaunch (b.jg5 SRJ-110, SRJ-701):
 * one `RestartDeps.killSession` call with `lastRead`, the run's last `dead`
 * reading. Answers `undefined` when the launch may
 * follow: after a success form (`killed` with any `kill_sent`, `row-gone`,
 * `session-gone`, `row-finished`) or `KILL_SESSION_NOT_KILLED_GUARD`, after logging the
 * relaunch line that names the outcome (`relaunchAfterKillLine`). Otherwise
 * the work's outcome, with no launch and nothing recorded (no success, no
 * failure, no cap): `RESTART_OUTCOME_SHUTTING_DOWN` for an `ErrInvalidFlags`
 * whose re-check decided that the server stops (b.jg5 SRJ-205: nothing more
 * is called), `RESTART_OUTCOME_LATCHED` for a CONFLICT or an UNUSABLE
 * NAME, which the adapter has latched (b.jg5 SRJ-501, SRJ-512; never sent
 * again), and for any other non-success after which the persona is latched
 * (a `status` read between the kill's tries latched it, b.jg5 SRJ-702, or a
 * latch set elsewhere; the latched query, a throw counting as latched), and
 * `RESTART_OUTCOME_REFUSED` for every other non-success
 * (UNAVAILABLE, `ErrTmuxKillFailed` included, ENVIRONMENT, CONFIG,
 * UNCLASSIFIED, `ErrSystemInstallDisappeared` and a class the kill has no
 * row for included, each having armed the retry timer inside the attempt),
 * for an answer that is not a kill outcome, and for a `killSession` that
 * throws: none of them shows the kill succeeded.
 */
async function killBeforeRelaunch(
  d: RestartDeps,
  key: string,
  cwd: string,
  lastRead: DeadLivenessReading,
): Promise<RestartWorkOutcome | undefined> {
  let killed: unknown
  try {
    killed = await d.killSession(key, lastRead)
  } catch (err) {
    console.error(killNotSucceededLine(key, `killSession threw: ${describeThrownValue(err)}`, false))
    return RESTART_OUTCOME_REFUSED
  }
  if (killed === KILL_SESSION_NOT_KILLED_GUARD || killLetsNextStepRun(killed)) {
    console.error(relaunchAfterKillLine(key, cwd, killed))
    return undefined
  }
  if (!isKillOutcome(killed)) {
    console.error(killNotSucceededLine(key, 'killSession answered no kill outcome', false))
    return RESTART_OUTCOME_REFUSED
  }
  // A non-success: no launch follows, and nothing is counted (SRJ-302).
  if (killOutcomeStopsServer(killed)) {
    console.error(killStopsServerLine(key, describeKillOutcome(killed)))
    return RESTART_OUTCOME_SHUTTING_DOWN
  }
  // b.jg5 SRJ-702, SRJ-502: a CONFLICT or an UNUSABLE NAME latched the
  // persona at the adapter; so may a `status` read between the kill's tries,
  // or a latch set elsewhere while the kill ran.
  const latched =
    (killed.kind === KILL_OUTCOME_NOT_KILLED &&
      (killed.errorClass === AD_ERROR_CLASS_CONFLICT || killed.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME)) ||
    readLatched(d, key).latched
  console.error(killNotSucceededLine(key, describeKillOutcome(killed), latched))
  return latched ? RESTART_OUTCOME_LATCHED : RESTART_OUTCOME_REFUSED
}

/**
 * The restart work's line when the kill answered `ErrInvalidFlags` and its
 * immediate version re-check decided that the server stops (b.jg5 SRJ-104,
 * SRJ-204, SRJ-205): no relaunch, nothing counted, nothing more called.
 * `described` is the outcome's rendering (`describeKillOutcome`).
 */
export function killStopsServerLine(key: string, described: string): string {
  return `[slack] Session kill for persona=${key} did not succeed (${described}) — the version re-check decided that the server stops; no relaunch; not counted; nothing more is called`
}

/**
 * The run's `dead` reading handed to the kill (`RestartDeps.killSession`'s
 * `lastRead`) for `probe`: the install-gone reading for
 * `ErrSystemInstallDisappeared`, else the `dead` reading carrying the row
 * state the probe read (`deadLivenessReading`), none when it read none.
 * Only a `dead` probe reaches the kill.
 */
function deadReadingOf(probe: LivenessProbe): DeadLivenessReading {
  if (probe.installGone === true) return LIVENESS_READING_DEAD_INSTALL_GONE
  return deadLivenessReading(probe.deadRowRead)
}

/**
 * b.d61: after an 'escalate-dead' reconnect verdict (whose adapter already ran
 * the findMissing sweep), probe the persona's liveness again. A swept row may
 * stay live for further ticks (b.jg5 SRJ-610): nothing promises this re-probe
 * or a later one reads it dead. Returns
 * the `dead` reading (`deadReadingOf`: the row state it read, for the kill's
 * `lastRead`) only when the row now reads `dead` and this restart run should go
 * on to the relaunch branch; that branch makes the checked kill first only
 * when the verdict is dead evidence, and never after a verdict derived from
 * `ErrSpawnNotInteractive` or a row read, or a bare 'escalate-dead' (b.jg5
 * SRJ-609, SRJ-611): a `dead` reading here may come from
 * `ErrSystemInstallDisappeared`, which reads no row. Otherwise the outcome the run returns with,
 * with no relaunch (b.jg5 SRJ-314): `RESTART_OUTCOME_RECONNECT_DEFERRED` (the
 * row still reads `live`: no kill, launch or accounting; each later
 * escalate-dead tick sweeps again, and the slow-recovery observer counts the
 * reading, the third in a row posting SRJ-1010 once per episode),
 * `RESTART_OUTCOME_PENDING_DEFERRED` (the row reads `pending`: its session
 * has not started), `RESTART_OUTCOME_LIVENESS_UNKNOWN` (the re-probe read
 * `unknown` or threw: agent-director could not report on the persona, and the
 * arm hook is called), `RESTART_OUTCOME_SHUTTING_DOWN`,
 * `RESTART_OUTCOME_NOT_UP`, `RESTART_OUTCOME_RECONNECT_DEFERRED` as well for a
 * reading of a kind none of its cases names (no relaunch, nothing told to the
 * slow-recovery observer; the switch's `never` check makes a new kind fail
 * the typecheck), or `RESTART_OUTCOME_LATCHED` when the persona is
 * latched after the re-probe (its own read latched it, b.jg5 SRJ-512, SRJ-513, or a
 * latch set elsewhere): then the arm hook is not called. Shutdown and the not-up gate are asked after the
 * probe, since it is an async agent-director call; `killSession`'s
 * launch-in-flight guard and `launchSession`'s own gate still apply after it.
 * Records no success or failure. Once those gates pass, the reading is told
 * to the slow-recovery observer (`RestartDeps.slowRecovery`): `live` counts,
 * `pending` resets the count, `dead` resets it (a row read also ends the
 * episode, `ErrSystemInstallDisappeared` leaves it open), and `unknown` is
 * not told. Each reading's line is exported (`reprobeDeadLine`,
 * `reprobeLiveLine`, `reprobePendingLine`, `reprobeUnknownLine`,
 * `reprobeUnhandledLine`).
 */
async function reprobeDeadAfterEscalate(d: RestartDeps, key: string): Promise<RestartWorkOutcome | DeadLivenessReading> {
  const probe = await probeLiveness(d, key)

  if (d.isShuttingDown()) {
    console.error(`[slack] Skipping restart — server is shutting down (persona=${key})`)
    return RESTART_OUTCOME_SHUTTING_DOWN
  }
  if (skipIfNotUp(d, key)) return RESTART_OUTCOME_NOT_UP
  // b.jg5 SRJ-502, SRJ-512, SRJ-513: the re-probe's own `status` read may
  // have latched the persona (an UNUSABLE NAME answer, or its own row
  // reading `pending` with no launch start, read `unknown`): no arm
  // hook, deferral, kill or launch, and nothing recorded.
  if (skipIfLatched(d, key)) return RESTART_OUTCOME_LATCHED
  if (skipIfHeld(d, key, 'after its re-probe')) return RESTART_OUTCOME_HELD
  if (skipIfSequenceRunning(d, key, 'after its re-probe')) return RESTART_OUTCOME_SEQUENCE_WAITING

  switch (probe.kind) {
    case LIVENESS_DEAD:
      console.error(reprobeDeadLine(key))
      noteDeadReading(d, key, probe)
      return deadReadingOf(probe)
    case LIVENESS_UNKNOWN:
      // b.jg5 SRJ-610: neither counts nor resets the slow-recovery count.
      console.error(reprobeUnknownLine(key, probe.failure))
      armOnUnknown(d, key)
      return RESTART_OUTCOME_LIVENESS_UNKNOWN
    case LIVENESS_PENDING:
      console.error(reprobePendingLine(key))
      tellSlowRecovery(d, key, 'noteOther', RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE)
      return RESTART_OUTCOME_PENDING_DEFERRED
    case LIVENESS_LIVE:
      console.error(reprobeLiveLine(key))
      tellSlowRecovery(d, key, 'noteLive')
      return RESTART_OUTCOME_RECONNECT_DEFERRED
    default: {
      // Every reading kind is handled above, so `probe.kind` is `never` here
      // and a new kind fails the typecheck. At runtime a kind none of the
      // cases names relaunches nothing and is not told to the slow-recovery
      // observer: the run ends as a deferral, never with `undefined` (which
      // would take the relaunch branch).
      const unhandled: never = probe.kind
      console.error(reprobeUnhandledLine(key, unhandled))
      return RESTART_OUTCOME_RECONNECT_DEFERRED
    }
  }
}

/**
 * The re-probe's line when its reading has a kind none of the cases names:
 * no relaunch in this run and nothing noted. `kind` is that reading's kind,
 * as `String` renders it.
 */
export function reprobeUnhandledLine(key: string, kind: unknown): string {
  return `[slack] Session re-probe after escalate-dead read an unhandled kind "${String(kind)}" — no relaunch in this restart run for persona=${key}; nothing noted`
}

/** The re-probe's line when the row reads `dead` after an 'escalate-dead' verdict (b.d61): the same run relaunches. */
export function reprobeDeadLine(key: string): string {
  return `[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=${key} (b.d61)`
}

/**
 * The re-probe's line when the row still reads `live` after an
 * 'escalate-dead' verdict (b.jg5 SRJ-610): no relaunch in this run, and the
 * row may stay live for further ticks, each of which sweeps again.
 */
export function reprobeLiveLine(key: string): string {
  return `[slack] Session still reads live after escalate-dead — no relaunch in this restart run for persona=${key}; the row may stay live for further ticks, each escalate-dead tick sweeping again`
}

/** The re-probe's line when the row reads `pending` after an 'escalate-dead' verdict (b.jg5 SRJ-314). */
export function reprobePendingLine(key: string): string {
  return `[slack] Session reads pending after escalate-dead — its session has not started; no relaunch in this restart run for persona=${key}`
}

/**
 * The re-probe's line when it reads `unknown` after an 'escalate-dead'
 * verdict (b.jg5 SRJ-314); `failure` is what a probe that threw threw, as
 * `describeThrownValue` renders it, absent when the probe answered.
 */
export function reprobeUnknownLine(key: string, failure?: string): string {
  return `[slack] Liveness unknown after escalate-dead for persona=${key}${probeFailure({ failure })} — no relaunch in this restart run; nothing counted`
}

/**
 * One liveness probe's result: its reading's kind, why it failed when the
 * probe threw, and a `pending` reading's launch start.
 */
interface LivenessProbe {
  readonly kind: LivenessKind
  /** `describeThrownValue` of what the probe threw; absent when it answered. */
  readonly failure?: string
  /** True for the `dead` reading from `ErrSystemInstallDisappeared`, which reads no row (`isInstallGoneDeadReading`). */
  readonly installGone?: true
  /** A `pending` reading's launch start (raw); absent for any other reading, or when it showed none. */
  readonly launchStartedAt?: string
  /** A `dead` row read's row state (`deadRowReadOf`: `ended`, `missing` or no row); absent for any other reading, or when it read no row. */
  readonly deadRowRead?: DeadRowRead
}

/**
 * Probe persona `key`'s liveness (b.jg5 SRJ-314): the reading's kind, with a
 * probe that throws, or answers something that is not a reading, read
 * `unknown` (never `dead`), a `pending` reading's launch start, and a `dead`
 * row read's row state. Logs nothing; never rejects.
 */
async function probeLiveness(d: RestartDeps, key: string): Promise<LivenessProbe> {
  let reading: LivenessReading
  try {
    reading = await d.isSessionAlive(key)
  } catch (err) {
    return { kind: LIVENESS_UNKNOWN, failure: describeThrownValue(err) }
  }
  const kind = livenessKindOf(reading)
  if (isInstallGoneDeadReading(reading)) return { kind, installGone: true }
  const deadRowRead = deadRowReadOf(reading)
  if (deadRowRead !== undefined) return { kind, deadRowRead }
  const launchStartedAt = launchStartOfReading(reading)
  return launchStartedAt === undefined ? { kind } : { kind, launchStartedAt }
}

/**
 * Hand persona `key`'s `pending` reading, with the launch start its probe
 * read, to the `pending` deferral (`RestartDeps.deferPendingRow`) once
 * (b.jg5 SRJ-314). Absent, nothing is called. A member that throws is
 * logged; never throws.
 */
function deferPending(d: RestartDeps, key: string, probe: LivenessProbe): void {
  if (d.deferPendingRow === undefined) return
  try {
    d.deferPendingRow(key, pendingLivenessReading(probe.launchStartedAt))
  } catch (err) {
    console.error(`[slack] restart: the pending deferral failed for persona=${key}: ${describeThrownValue(err)}`)
  }
}

/** ` (isSessionAlive failed: <why>)` for a probe that threw, else empty: the part of an unknown line that names the failure. */
function probeFailure(probe: Pick<LivenessProbe, 'failure'>): string {
  return probe.failure === undefined ? '' : ` (isSessionAlive failed: ${probe.failure})`
}

/**
 * Tell the slow-recovery observer (`RestartDeps.slowRecovery`) a `dead`
 * reading (b.jg5 SRJ-610): `noteInstallGone` for one from
 * `ErrSystemInstallDisappeared`, `noteDead` for a row read. Never throws.
 */
function noteDeadReading(d: RestartDeps, key: string, probe: LivenessProbe): void {
  if (probe.installGone === true) tellSlowRecovery(d, key, 'noteInstallGone')
  else tellSlowRecovery(d, key, 'noteDead')
}

/**
 * Call one note of the slow-recovery observer for persona `key` (b.jg5
 * SRJ-610). Absent, nothing is told. A note that throws is logged; never
 * throws.
 */
function tellSlowRecovery(
  d: RestartDeps,
  key: string,
  note: 'noteLive' | 'noteDead' | 'noteInstallGone' | 'noteOther',
  reason?: SlowRecoveryOtherReason,
): void {
  const observer = d.slowRecovery
  if (observer === undefined) return
  try {
    if (note === 'noteOther') observer.noteOther(key, reason ?? RESTART_SLOW_RECOVERY_OTHER_VERDICT)
    else observer[note](key)
  } catch (err) {
    console.error(`[slack] restart: the slow-recovery ${note} failed for persona=${key}: ${describeThrownValue(err)}`)
  }
}

/**
 * Call the arm hook (`RestartDeps.armRetryTimer`) for persona `key` once, on
 * an `unknown` reading (b.jg5 SRJ-314). Absent, nothing is armed. A hook that
 * throws is logged; never throws.
 */
function armOnUnknown(d: RestartDeps, key: string): void {
  if (d.armRetryTimer === undefined) return
  try {
    d.armRetryTimer(key)
  } catch (err) {
    console.error(`[slack] restart: arming the retry timer failed for persona=${key}: ${describeThrownValue(err)}`)
  }
}

/**
 * What `RestartDeps.isLatched` answered for a persona: `latched` (exactly
 * `true`, or a query that threw, which counts as latched so the work fails
 * safe), with `failure`, `describeThrownValue` of what it threw, when it
 * threw.
 */
interface LatchedReading {
  readonly latched: boolean
  readonly failure?: string
}

/**
 * `RestartDeps.isLatched` for persona `key` (`LatchedReading`): exactly
 * `true` is latched; an absent query is not; a query that throws counts as
 * latched (b.jg5 SRJ-502: never kill or launch a persona that may be
 * latched). Logs nothing (the caller logs one line); never throws.
 */
function readLatched(d: RestartDeps, key: string): LatchedReading {
  if (d.isLatched === undefined) return { latched: false }
  try {
    return { latched: d.isLatched(key) === true }
  } catch (err) {
    return { latched: true, failure: describeThrownValue(err) }
  }
}

/** ` (the latched query failed: <why> — taken as latched)` for a query that threw, else empty. */
function latchedFailure(reading: LatchedReading): string {
  return reading.failure === undefined ? '' : ` (the latched query failed: ${reading.failure} — taken as latched)`
}

/**
 * The latched gate (b.jg5 SRJ-502): when persona `key` is latched, or the
 * latched query throws, log one line saying the restart work makes no
 * attempt for it (naming what the query threw, if it did) and return true,
 * so the caller returns `RESTART_OUTCOME_LATCHED` before any agent-director
 * call. Records neither a success nor a failure.
 */
function skipIfLatched(d: RestartDeps, key: string): boolean {
  const reading = readLatched(d, key)
  if (!reading.latched) return false
  console.error(
    `[slack] Skipping restart for persona=${key} — the persona is latched${latchedFailure(reading)}; no agent-director call, nothing recorded (b.jg5 SRJ-502)`,
  )
  return true
}

/**
 * What `RestartDeps.isHeld` answered for a persona: `held` (exactly `true`,
 * or a query that threw, which counts as held so the work fails safe), with
 * `failure`, `describeThrownValue` of what it threw, when it threw.
 */
interface HeldReading {
  readonly held: boolean
  readonly failure?: string
}

/**
 * `RestartDeps.isHeld` for persona `key` (`HeldReading`): exactly `true` is
 * held; an absent query is not; a query that throws counts as held (b.jg5
 * SRJ-207: never launch a persona that may be held). Logs nothing; never
 * throws.
 */
function readHeld(d: RestartDeps, key: string): HeldReading {
  if (d.isHeld === undefined) return { held: false }
  try {
    return { held: d.isHeld(key) === true }
  } catch (err) {
    return { held: true, failure: describeThrownValue(err) }
  }
}

/** ` (the held query failed: <why> — taken as held)` for a query that threw, else empty. */
function heldFailure(reading: HeldReading): string {
  return reading.failure === undefined ? '' : ` (the held query failed: ${reading.failure} — taken as held)`
}

/**
 * The held gate (b.jg5 SRJ-207, SRJ-303): when persona `key` is held on
 * `ErrInvalidFlags`, or the held query throws, log one line saying the
 * restart work makes no attempt for it (naming what the query threw, if it
 * did) and return true, so the caller returns `RESTART_OUTCOME_HELD` before
 * any agent-director call. Records neither a success nor a failure. With
 * `askedAgain` (where the work asks it again, wherever it asks the latched
 * gate again) the line says the work goes no further.
 */
function skipIfHeld(d: RestartDeps, key: string, askedAgain?: string): boolean {
  const reading = readHeld(d, key)
  if (!reading.held) return false
  console.error(
    askedAgain === undefined
      ? `[slack] Skipping restart for persona=${key} — the persona is held on ErrInvalidFlags${heldFailure(reading)}; no agent-director call, nothing recorded (b.jg5 SRJ-207)`
      : `[slack] Restart for persona=${key} goes no further ${askedAgain} — the persona is held on ErrInvalidFlags${heldFailure(reading)}; nothing more is called for it, nothing recorded (b.jg5 SRJ-207)`,
  )
  return true
}

/**
 * The live-row sequence gate (b.jg5 SRJ-706, SRJ-303): when a live-row
 * sequence runs for persona `key`, or the running query throws (counted as
 * running: fail safe), log one line saying the restart work makes no attempt
 * and return true, so the caller returns `RESTART_OUTCOME_SEQUENCE_WAITING`
 * before any agent-director call. Records neither a success nor a failure.
 * With `askedAgain` (where the work asks it again, wherever it asks the
 * latched gate again: after a probe, before the kill, before the launch, or
 * after a launch that came back refused) the line says the work goes no
 * further: nothing more is called for the persona.
 */
function skipIfSequenceRunning(d: RestartDeps, key: string, askedAgain?: string): boolean {
  if (d.isLiveRowSequenceRunning === undefined) return false
  let failure = ''
  try {
    if (d.isLiveRowSequenceRunning(key) !== true) return false
  } catch (err) {
    failure = ` (the running query failed: ${describeThrownValue(err)} — taken as running)`
  }
  console.error(
    askedAgain === undefined
      ? `[slack] Skipping restart for persona=${key} — its live-row sequence runs${failure}; no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)`
      : `[slack] Restart for persona=${key} goes no further ${askedAgain} — its live-row sequence runs${failure}; nothing more is called for it, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)`,
  )
  return true
}

/**
 * The timer-time not-up check (b.av2 SR-6.4): when `canRestart` answers false,
 * log that the restart is skipped and the instance left as it is, and return
 * true so the caller returns before touching the persona. Records neither a
 * success nor a failure. `canRestart` answers false for a key outside the
 * applied set too (b.av2 SR-8.6): the restart path does nothing for it. Its
 * one exception, an old-life wait's kill and find-missing steps on a retired
 * key (b.jg5 SRJ-1512, SRJ-811), runs in the session manager's live-row
 * sequence registry, never through this path, and never launches that key.
 */
function skipIfNotUp(d: RestartDeps, key: string): boolean {
  if (d.canRestart(key)) return false
  console.error(`[slack] Skipping restart for persona=${key} — the persona is no longer up; its instance is left as it is`)
  return true
}

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

export function cancelAllRestartTimers(): void {
  for (const [key, timer] of pendingRestartTimers) {
    clearTimeout(timer)
    console.error(`[slack] Cancelled restart timer for persona=${key}`)
  }
  pendingRestartTimers.clear()
}

// ---------------------------------------------------------------------------
// cancelRestartTimer — one persona's pending timer
// ---------------------------------------------------------------------------

/**
 * Cancel the pending restart timer for persona `key`, if any, so it never
 * fires (b.av2 SR-6.5, a teardown). Other personas' timers are untouched.
 * A work already started (its `activeLaunches` entry) is left alone: the
 * teardown waits for it through the lifecycle serializer. Records no success
 * or failure and posts nothing; logs the cancelled-timer line only when a
 * timer was pending. Returns whether one was.
 */
export function cancelRestartTimer(key: string): boolean {
  const timer = pendingRestartTimers.get(key)
  if (timer === undefined) return false
  clearTimeout(timer)
  pendingRestartTimers.delete(key)
  console.error(`[slack] Cancelled restart timer for persona=${key}`)
  return true
}

// ---------------------------------------------------------------------------
// isRestartPendingOrActive — query function
// ---------------------------------------------------------------------------

export function isRestartPendingOrActive(key: string): boolean {
  return pendingRestartTimers.has(key) || activeLaunches.has(key)
}

// ---------------------------------------------------------------------------
// _resetRestartState — exported for test cleanup
// ---------------------------------------------------------------------------

export function _resetRestartState(): void {
  for (const timer of pendingRestartTimers.values()) {
    clearTimeout(timer)
  }
  pendingRestartTimers.clear()
  activeLaunches.clear()
  deps = null
}
