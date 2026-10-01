/**
 * test-helpers/recovery-harness.ts — `makeRecoveryHarness`, the recovery
 * harness (b.jg5 SRJ-1304): the UNAVAILABLE retry timer and the recovery
 * paths around it, wired over one fake clock and one stub client.
 *
 * API
 * ---
 * `makeRecoveryHarness(options?)` builds, over one `createFakeClock`:
 *
 * - `controller`: the server's UNAVAILABLE retry controller
 *   (`createUnavailableRetryController`) on the harness clock. Its log lines
 *   go to `lines`. Its retry action is a delegate: every retry is recorded in
 *   `attempts` (persona key, retry number, cause kinds, mode and the clock
 *   time), then answered by the current action. The default action is
 *   `fullModeAction`, the server's retry action for both modes
 *   (`createFullModeRetryAction`) over the real restart module's retry entry
 *   (`runRestartRetry`), wired as `main()` wires it: the session manager's
 *   row read (`readPersonaRowState`, a pending-only retry's one `status`
 *   call), the applied-persona lookup over the live applied set, the
 *   relaunch gate below, the restart cap (`isAtCap` at
 *   `RESTART_FAILURE_CAP`), the harness's shutting-down flag, the latch's
 *   latched query (`latch` below) and the session
 *   manager's `isLaunchInFlight`, and the condition's retry hooks: the
 *   connection and stream probes (`isSessionConnected` and
 *   `hasSessionStream`, both over `setConnected`) and `endTmuxUnresponsive`,
 *   the condition's end with reason `TMUX_UNRESPONSIVE_END_RETRY` and the
 *   retry's reading followed by the clear of the persona's
 *   `tmux-unavailable` outage with that reading (b.jg5 SRJ-311, SRJ-312).
 *   `scriptedAction` is
 *   the scripted action: it answers each persona's queued outcomes
 *   (`answer(key, ...outcomes)`) in order and, once they run out, a bare
 *   refusal (`{ kind: 'again' }`). `options.action` replaces the default
 *   (`'scripted'` picks the scripted action); `setAction(action)` swaps the
 *   current action, and `setAction(undefined)` goes back to the full-mode
 *   one. As in `main()`, the controller's per-fire observer (`onRetryFire`)
 *   is the condition's retry onset check (`tmuxUnresponsive.onsetAtRetry`),
 *   called at every fire, one whose retry is skipped included, before the
 *   action; its stop observer (`onStopped`) is composed as in `main()`: the
 *   condition's `cancelAlert(key, reason)`, so every real stop of a
 *   persona's timer cancels its pending alert check, then the
 *   unclassified-error episodes' `retryStopped(key, reason)`, each isolated.
 *   Every call to it is recorded first in `stops` (`{ key, reason }`).
 * - The restart module is initialised over the configuration
 *   (`initRestart`) with the production adapters: the liveness read
 *   (`_buildIsSessionAliveAdapter` over the applied configuration), the
 *   reconnect and kill adapters (`_buildReconnectSessionAdapter`,
 *   `_buildKillSessionAdapter`, over the applied-persona lookup) and
 *   `launchSession` over the applied configuration with the relaunch gate as
 *   `canLaunch`. `getRestartDelay` answers the configuration's
 *   `session_restart_delay` (0 by default). `onCapReached` records the key in
 *   `capReached` and then, as `main()` binds it, calls
 *   `notifyRestartCapReached`, whose notice lands in `notices`, and ends the
 *   persona's unclassified-error episode
 *   (`end(key, UNCLASSIFIED_ERROR_END_CAPPED)`), each isolated. `serialize` is `serializer.run`, one real per-persona
 *   serializer (`createPersonaSerializer`), which a test may hold a turn on.
 *   `armRetryTimer`, the arm hook, is bound as `main()` binds it (b.jg5
 *   SRJ-314, SRJ-301): every `unknown` liveness reading at the restart work,
 *   the re-probe's included, arms the persona's timer on the controller with
 *   `UNAVAILABLE_RETRY_CAUSE_READ_ERROR`, straight to the controller (it is
 *   not recorded in `triggers`); an arm while the timer is armed or running
 *   keeps its due time. `isLatched` is the latch's latched query (`latch`
 *   below). `options.restartDeps` replaces any of these.
 * - The relaunch gate is the real `createPersonaRelaunchGate` over a serving
 *   connection, with the bring-up outcome `setUp(key, up)` controls (every
 *   configured persona up at first) and the live applied set (its lines go
 *   to `lines`). `setConnected(key, connected)` controls whether the
 *   persona's session is registered as connected with its message stream
 *   (`isSessionConnected` and `hasSessionStream`; none at first).
 * - Drivers, each as the server does it: `shutdown()` raises the
 *   shutting-down flag, closes the controller
 *   (`close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)`) and then the episodes
 *   (`episodes.close()`: every alert check cancelled, a later condition
 *   start answers `closed`); `teardown(key)` is the teardown's submit: it
 *   stops the persona's timer (`stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)`)
 *   and cancels its alert check (`tmuxUnresponsive.cancelAlert(key,
 *   UNAVAILABLE_RETRY_STOP_TORN_DOWN)`, which logs nothing more when the
 *   stop observer has already cancelled it), the condition kept; then it
 *   forgets the persona's latch silently (`latch.forget(key)`: no post, no
 *   set observer call, no line), the turn's step that production's
 *   `forgetConflictLatch` binds (b.jg5 SRJ-504). The teardown's turn then
 *   forgets the persona's episodes, every kind (its unclassified-error and
 *   CONFLICT episodes included), as production's `forgetNoticeEpisodes`
 *   does; a case does that step with `episodes.forget(key)` after
 *   `teardown(key)`, which keeps production's order (the latch, then the
 *   episodes). The harness does not wait for a launch in flight as the turn
 *   does, so a case settles any launch before `teardown(key)`. `remove(key)`
 *   drops the persona from the applied configuration without a teardown.
 * - `stub`: one stub client (`makeStubClient`) with its call log
 *   (`stub.calls`), installed through `installStubSpawnPath` with the spawn
 *   home under the harness's temporary HOME, and handed to the outage state
 *   (`initOutageState`) as its client. The tmux session killer and server
 *   ensurer the launch path can reach are inert, so no tmux runs.
 *   `script(knobs)` sets the stub's answers (`StubClientOptions` knobs such
 *   as `spawnError` or `getQueue`), read at each call.
 * - `triggers`: the outage state's trigger sink (b.jg5 SRJ-301) is the
 *   controller, behind a recorder: every trigger an agent-director error
 *   inside a launch or recovery attempt sends (`{ key, kind }`, the cause
 *   kind) is recorded here, then armed on the controller; an ENVIRONMENT
 *   answer (`ErrTmuxNotAvailable`) or a CONFIG answer (`ErrConfigMalformed`)
 *   from any call for a persona, in or out of an attempt, is sent too (b.jg5
 *   SRJ-311, SRJ-316). With
 *   `options.triggerSink: false` no sink is installed: nothing is recorded or
 *   armed.
 * - `outageClears` (b.jg5 SRJ-305, SRJ-306, SRJ-311): the outage state's
 *   cleared-flag observer (`onFlagCleared`), installed in the same
 *   `initOutageState` call as `main()` binds it: each real clear of a
 *   persona's `tmux-unavailable` outage (never a silent reset, never another
 *   class) calls the controller's condition-end entry once
 *   (`conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
 *   reading)`, the reading the clear brought), recorded here
 *   (`{ key, reading, result }`) with what the controller answered. The
 *   health tick's healthy branch clears it with `LIVENESS_LIVE`; the harness
 *   has no tick, so a case clears it as that branch does
 *   (`clearOutageFlag(key, 'tmux-unavailable', LIVENESS_LIVE)`).
 * - `episodes` and `tmuxUnresponsive` (b.jg5 SRJ-307, SRJ-310, SRJ-1016):
 *   one notice-episodes instance (`createPersonaEpisodes`) on the harness
 *   clock, whose posts land in `episodeNotices` and whose lines go to
 *   `lines`, and the `tmux-unresponsive` condition over it
 *   (`createTmuxUnresponsiveCondition`, its started and ended lines to
 *   `lines`), wired as `main()` wires them: the condition is the outage
 *   state's condition sink in the same `initOutageState` call as the trigger
 *   sink, so a tmux-touching call's UNAVAILABLE inside an attempt starts it
 *   on the harness clock and a tmux-touching success or GONE ends it; each
 *   end of a holding condition calls the controller's condition-end entry
 *   (`conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE,
 *   reading)`), recorded in `conditionEnds` (`{ key, reading, result }`)
 *   with what the controller answered. The condition's mode accessor
 *   (`healthCheckOn`) reads `health_check_interval` in the configuration in
 *   effect at each check (0, the default, is off: the onset comes at a retry
 *   at or past `TMUX_UNRESPONSIVE_ONSET_FLOOR_MS`; `setHealthCheckInterval`
 *   changes it). Its alert threshold accessor is E6's
 *   `adAlertThresholdMsInEffect` over the settings in effect below, so a
 *   start arms an alert check on the harness clock;
 *   `options.alertThresholdMs` replaces the accessor, and `false` arms none.
 *   A case reads the condition with
 *   `tmuxUnresponsive.holds(key)` and `tmuxUnresponsive.firstRefusalAt(key)`.
 *   With `options.conditionSink: false` the condition is not installed in
 *   the outage state (the retry hooks and `tickEnd` still reach it).
 * - The unclassified-error episodes (b.jg5 SRJ-313, SRJ-1009;
 *   `createUnclassifiedErrorEpisodes`) over the same episodes instance,
 *   wired as `main()` wires them: the outage state's unclassified sink in
 *   the same `initOutageState` call, so each UNCLASSIFIED outcome inside a
 *   launch or recovery attempt (a row read's included) begins or continues
 *   the persona's episode; the alert threshold is E6's
 *   `adAlertThresholdMsInEffect` (never `options.alertThresholdMs`, which is
 *   the condition's); the configured-key lookup reads the live applied set,
 *   so after `remove(key)` the alert takes the log-only route, one
 *   `recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, 'persona=<key>:
 *   <text>')` into the harness's `startup-errors.log` (`startupErrors()`);
 *   otherwise the alert lands in `episodeNotices`; their lines go to
 *   `lines`. `unclassifiedErrorOpen(key)` reads whether the persona's
 *   episode is open; nothing sets it by hand.
 * - `latch` and `latchEvents` (b.jg5 SRJ-501, SRJ-502, SRJ-508): one latch
 *   per harness (`createConflictLatch`, its lines to `lines`), composed as
 *   `main()` composes it: installed in the session manager
 *   (`setConflictLatch`), so a CONFLICT at a collision-ladder spawn or
 *   `resume` latches the persona (a `launch` answers `latched`) and a latched
 *   persona's launch makes no agent-director call; its latched query bound
 *   into the full-mode retry action (`isLatched`: a retry of a latched
 *   persona stops with `UNAVAILABLE_RETRY_STOP_LATCHED`, no call) and into
 *   the restart deps (`RestartDeps.isLatched`: the restart work answers
 *   `latched`, no call); and its set observers in `main()`'s order: the
 *   holds (`bindConflictLatchHolds`) and then the CONFLICT notice
 *   (`bindConflictNotice`) over `episodes`, whose post lands in
 *   `episodeNotices`. On every set the holds run in order, each isolated:
 *   the timer's stop (`controller.stop(key,
 *   UNAVAILABLE_RETRY_STOP_LATCHED)`, so a real stop shows in `stops`), the
 *   condition's silent end (`tmuxUnresponsive.end(key,
 *   TMUX_UNRESPONSIVE_END_LATCHED, undefined, { silent: true })`: no recovery
 *   post; a holding condition's end shows in `conditionEnds`) and the
 *   unclassified-error episode's end (`end(key,
 *   UNCLASSIFIED_ERROR_END_LATCHED)`). `latch` is read-only: `isLatched(key)`
 *   and `record(key)`. `latchEvents` holds, in order, each set as the
 *   observers see it (`{ step: 'set', key, outcome, record }`, recorded by an
 *   observer added before the holds), each hold as it is called (`{ step:
 *   'hold', key, hold }`) and each CONFLICT notice posted (`{ step: 'notice',
 *   key, text }`), so a case can read that every hold ran before the notice.
 *   The harness has no health tick, so `HealthCheckDeps.isLatched` is not
 *   bound here; a tick case binds `latch.isLatched` itself. `teardown(key)`
 *   forgets the persona's latch silently (b.jg5 SRJ-504), as production's
 *   teardown does.
 * - The configured-persona query (b.jg5 SRJ-114): installed in the session
 *   manager beside the latch (`setConfiguredPersonaQuery`), as `main()`
 *   installs it, over the live applied set: a key counts as configured while
 *   it is applied, so a `provenance_conflict` note on a configured persona's
 *   own row latches it through `latch`, and a key outside the harness's
 *   personas, or one `remove(key)` dropped, counts as not configured.
 * - `tickEnd(key)`: what a health tick's healthy branch does to the
 *   condition, as `main()` binds `HealthCheckDeps.endTmuxUnresponsive`: the
 *   condition's end with reason `TMUX_UNRESPONSIVE_END_TICK` and the `live`
 *   reading (`LIVENESS_LIVE`). `tickOnset(tickStartedAt?)`: what a health
 *   tick body's end does, as `main()` binds `HealthCheckDeps.onTickEnd`: the
 *   condition's onset check (`onsetAtTick`) for a tick started at
 *   `tickStartedAt`, the harness clock's now by default (a condition whose
 *   first refusal is at that same time gets no onset). The harness has no
 *   health tick of its own.
 * - `launch(key)`: a start-pass launch of the configured persona `key`
 *   through the real `spawnForPersona` (`isStartup` true) over the stub,
 *   resolving with its `SpawnPersonaResult` (`latched` for a CONFLICT at a
 *   ladder spawn or `resume`, and for a persona already latched). Each persona's working directory
 *   exists, so a row the stub answers in it is the persona's own.
 * - `settle()`: awaits every configured persona's launch in flight
 *   (`whenLaunchSettled`) and every retry run in flight (`whenRunSettled`),
 *   with its re-arm or stop. The spawn path polls in real time (the dialog
 *   approver's 1 ms steps; it takes no fake clock), so this is the one
 *   real-time wait: 1 ms steps, bounded by `options.settleMs`, and it throws
 *   when a launch or a run is still in flight at the bound. A retry whose
 *   launch goes on past a spawn needs it before the clock moves on.
 * - `outageNotices`: the outage state's notices, `{ key, text }`, in order.
 * - `episodeNotices`: the notice episodes' posts, `{ key, text }`, in order
 *   (production posts them through the persona notifier).
 * - `notices`: the session manager's notices (`setSessionNotifier`),
 *   `{ key, text }`, in order.
 * - `stateDir` and `startupErrors()`: `SLACK_STATE_DIR` points at a
 *   temporary directory while the harness is live; `startupErrors()` answers
 *   the entries written to its `startup-errors.log`, one per line.
 * - `home` and `settings()`: agent-director's settings in effect, through
 *   the settings install (`installAdSettings`) over the temporary HOME.
 *   `options.adSettings`, when given, is written there first
 *   (`writeAgentDirectorConfig`); otherwise no file exists and the defaults
 *   are in effect. The reader's lines go to `lines`.
 * - `config` and `keys`: a resolved configuration of `options.personas`
 *   (two personas by default) with `session_restart_delay` and
 *   `health_check_interval` from the options, both 0 by default (SRJ-304).
 *   Every persona is applied at first.
 * - `advance(ms)`: moves the clock `ms` forward one due time at a time.
 *   Before and after each firing it awaits every in-flight retry run
 *   (`whenRunSettled`), bounded by `options.settleFlushes` clock flushes, so
 *   a re-arm measured from a run's end lands exactly and a run the test holds
 *   open does not stall the step. Resolves with the number of timers fired.
 * - `errors`: every `console.error` call while the harness is live (the
 *   session manager's and the restart module's lines), its arguments joined
 *   with spaces, in order. `console.error` is replaced at build and put back
 *   by `cleanup()`.
 * - `captured()`: everything captured, for `assertNoLeak`: the lines, the
 *   `console.error` lines, the three notice lists, the startup-errors
 *   entries, the attempts, the triggers, the condition ends, the outage
 *   clears, the stops, the latch events and the state directory as a written
 *   file.
 * - `cleanup()`: stops every retry timer (`stopAll`) and forgets every
 *   episode (`episodes.forgetAll()`, which cancels every alert check), then
 *   undoes every
 *   install and reset the harness made (`console.error`, the restart module's state and the
 *   failure counter, backoff and cap latch, the outage state and its trigger sink, the session notifier,
 *   the session manager's latch install and the latch's set observers,
 *   the configured-persona query (`_resetConfiguredPersonaQuery`), so two
 *   harnesses built one after the other share no query,
 *   the stub spawn path and client with every launch still in flight, the
 *   findMissing memo, the tmux seams, the settings install,
 *   `SLACK_STATE_DIR`) and removes the temporary directory. It throws, after
 *   undoing everything, when a timer is still pending on the clock or a
 *   persona is still armed: the episodes run on the harness clock, so a timer
 *   they armed and left pending fails it too.
 *
 * Shared case helpers, each over a harness: `personaOf` (a configured
 * persona), `collided` (the stub answers of a launch whose optimistic spawn
 * collides), `callCounts` (the stub's calls by verb), `personaCallCounts`
 * (the stub's calls for one persona's instance, those whose
 * `claude_instance_id` is `personaInstanceId(key)`, by verb, leaving out
 * verbs with none; a case wanting the persona's total over every verb sums
 * its values), `callCountsSince` (what one by-verb count holds beyond an
 * earlier one, by verb, leaving out verbs with no increase), `recordCallOrder`
 * (wraps every verb of the stub client, in place, so each call from then on
 * also appends the verb's name to the returned list, in call order: every
 * function the client has, `readPane`, `sendKeys`, `pause`, `decide` and
 * `close` included, so a case can assert exactly the calls a launch makes),
 * `retryNow` (fire a
 * persona's next retry and settle it), `rowReadsUntilSpawn` (each row reads a
 * state until its spawn resolves, then `waiting`), and the condition's log
 * lines: `conditionLinePrefix`, `conditionLines`, `conditionStartedLines`,
 * `conditionEndedLines` and the line builders `conditionOnsetLine`,
 * `conditionAlertLine`, `conditionEndedLine`, `conditionRecoveryLine` and
 * `conditionSilentEndLine`; the unclassified-error episodes' log lines:
 * `unclassifiedLinePrefix`, `unclassifiedLines`, `unclassifiedStartedLines`
 * and the line builders `unclassifiedStartedLine`, `unclassifiedEndedLine`
 * (for any end reason), `unclassifiedPostedLine` and
 * `unclassifiedLoggedLine`; and `adConfigMalformedRaiseLines`, the outage
 * state's `ad-config-malformed` raise lines.
 *
 * Pending-only mode is armed directly (`controller.armPendingOnly`) until
 * covered `pending` rows exist. Later work extends this harness in place.
 *
 * Isolation: no top-level `mock.module()`, no real HOME, `~/.agent-director`,
 * tmux or child process. The retry timer runs on the fake clock only; the one
 * real-time wait is `settle()`'s bounded poll for the spawn path. A retry
 * never arms the restart module's own (real) timer: its entry bypasses it. Every file
 * sits under one `mkdtempSync` directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Client, SpawnResult } from 'agent-director'

import { adAlertThresholdMsInEffect, adSettingsInEffect, installAdSettings, resetAdSettingsForTests, type AdSettingsInEffect } from '../../src/ad-settings.ts'
import { _resetBackoffState, isAtCap } from '../../src/backoff.ts'
import type { Persona, PersonaConfig } from '../../src/config.ts'
import {
  bindConflictLatchHolds,
  bindConflictNotice,
  createConflictLatch,
  type ConflictLatch,
  type ConflictLatchRecord,
  type ConflictLatchSetOutcome,
  type ConflictNoticeEpisodes,
} from '../../src/conflict-latch.ts'
import { LIVENESS_LIVE } from '../../src/liveness-reading.ts'
import { classifyAdError, describeAdErrorClassification } from '../../src/ad-error-class.ts'
import { _resetOutageState, clearOutageFlag, initOutageState, type OutageClass } from '../../src/outage-state.ts'
import type { PersonaConnectionStatus } from '../../src/persona-connections.ts'
import {
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  createUnclassifiedErrorEpisodes,
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  TMUX_UNRESPONSIVE_END_LATCHED,
  TMUX_UNRESPONSIVE_END_RETRY,
  TMUX_UNRESPONSIVE_END_TEXT,
  TMUX_UNRESPONSIVE_END_TICK,
  UNCLASSIFIED_ERROR_END_CAPPED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
  type TmuxUnresponsiveEndReason,
  type TmuxUnresponsiveEndResult,
  type UnclassifiedErrorEndReason,
} from '../../src/persona-episodes.ts'
import { personaInstanceId } from '../../src/persona-identity.ts'
import { createPersonaSerializer, type PersonaSerializer } from '../../src/persona-serializer.ts'
import { createPersonaRelaunchGate } from '../../src/persona-start.ts'
import { _resetRestartState, initRestart, RESTART_FAILURE_CAP, runRestartRetry, type RestartDeps } from '../../src/restart.ts'
import { _buildIsSessionAliveAdapter, _buildKillSessionAdapter, _buildReconnectSessionAdapter } from '../../src/server.ts'
import {
  _resetConfiguredPersonaQuery,
  _resetFindMissingMemo,
  _resetTmuxServerEnsurer,
  _resetTmuxSessionKiller,
  _setTmuxServerEnsurer,
  _setTmuxSessionKiller,
  isLaunchInFlight,
  launchSession,
  notifyRestartCapReached,
  readPersonaRowState,
  setConfiguredPersonaQuery,
  setConflictLatch,
  setSessionNotifier,
  spawnForPersona,
  whenLaunchSettled,
  type SpawnPersonaResult,
} from '../../src/session-manager.ts'
import { recordStartupError } from '../../src/startup-errors.ts'
import {
  createFullModeRetryAction,
  createUnavailableRetryController,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type UnavailableRetryAction,
  type UnavailableRetryConditionEndResult,
  type UnavailableRetryTriggerSink,
  type UnavailableRetryController,
  type UnavailableRetryMode,
  type UnavailableRetryOutcome,
} from '../../src/unavailable-retry.ts'
import { writeAgentDirectorConfig, type AdConfigInput } from './ad-settings.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedStatusResult,
  errInstanceIdCollision,
  errSpawnNotFound,
  installStubSpawnPath,
  resetStubSpawnPath,
  type PersonaGetResultOverrides,
  type StubCallLog,
  type StubClientOptions,
  type StubSpawnPath,
} from './agent-director-stub.ts'
import { writtenFile } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'

/** Clock flushes `advance` waits at most for the in-flight retry runs, before and after each firing. */
const DEFAULT_SETTLE_FLUSHES = 20

/** How long `settle` waits at most for the launches in flight, in real ms (1 ms steps). */
const DEFAULT_SETTLE_MS = 2000

/** What the scripted action answers once a persona's queued outcomes run out: a bare refusal. */
const SCRIPTED_REFUSAL: UnavailableRetryOutcome = Object.freeze({ kind: 'again' })

/** The connection status the relaunch gate reads for every persona: serving. */
const SERVING: PersonaConnectionStatus = Object.freeze({ state: 'up', identity: Object.freeze({ botUserId: 'U0RECOVERY', botId: 'B0RECOVERY' }) })

/** Options of `makeRecoveryHarness`; every one is optional. */
export interface RecoveryHarnessOptions {
  /** The retry action: `'scripted'` for the scripted action; the full-mode action when unset. */
  action?: UnavailableRetryAction | 'scripted'
  /** The personas (`makeMultiPersonaConfig` specs); two default personas when unset. */
  personas?: PersonaSpec[]
  /** `session_restart_delay` in seconds; 0 by default. */
  sessionRestartDelay?: number
  /**
   * `health_check_interval` in seconds; 0 by default, so the health check is
   * off and the condition's onset comes at a retry. Any other value turns it
   * on (the onset comes at `tickOnset`). `setHealthCheckInterval` changes it
   * later.
   */
  healthCheckInterval?: number
  /**
   * The condition's alert threshold accessor, in ms, read at the arm and at
   * every check: E6's `adAlertThresholdMsInEffect` (over `adSettings`) when
   * unset; `false` arms no alert check.
   */
  alertThresholdMs?: (() => number) | false
  /** agent-director's settings file, written under the temporary HOME; none (the defaults) when unset. */
  adSettings?: AdConfigInput
  /** Restart dependencies that replace the harness's production adapters and controls. */
  restartDeps?: Partial<RestartDeps>
  /** Clock flushes `advance` waits at most for in-flight runs; `DEFAULT_SETTLE_FLUSHES` when unset. */
  settleFlushes?: number
  /** Install the controller as the outage state's trigger sink (b.jg5 SRJ-301); true when unset. */
  triggerSink?: boolean
  /** Install the `tmux-unresponsive` condition as the outage state's condition sink (b.jg5 SRJ-307); true when unset. */
  conditionSink?: boolean
  /** Real ms `settle` waits at most for the launches in flight; `DEFAULT_SETTLE_MS` when unset. */
  settleMs?: number
}

/** The stub's answer knobs: every `StubClientOptions` field but the capture lists. */
export type RecoveryStubScript = Omit<StubClientOptions, keyof StubCallLog | 'callLog'>

/** One trigger the outage state sent to the sink: the persona key and the cause kind. */
export interface RecoveryTrigger {
  readonly key: string
  readonly kind: string
}

/** One retry the controller ran, as the action delegate saw it. */
export interface RecoveryAttempt {
  readonly key: string
  readonly retry: number
  readonly causes: readonly string[]
  /** The mode the retry ran in. */
  readonly mode: UnavailableRetryMode
  /** The clock time the retry ran at, in ms. */
  readonly at: number
}

/** One notice, in the order it was sent. */
export interface RecoveryNotice {
  readonly key: string
  readonly text: string
}

/**
 * One call to the controller's condition-end entry: an end of a holding
 * `tmux-unresponsive` condition (`conditionEnds`) or a real clear of the
 * `tmux-unavailable` outage (`outageClears`).
 */
export interface RecoveryConditionEnd {
  readonly key: string
  /**
   * The reading the end brought (a tick's or a retry's, or a launch call's
   * `pending` clear), or undefined (a tmux-touching success or GONE).
   */
  readonly reading: string | undefined
  /** What `controller.conditionEnded` answered. */
  readonly result: UnavailableRetryConditionEndResult
}

/** One real stop of a persona's retry timer, as the controller's stop observer saw it. */
export interface RecoveryStop {
  readonly key: string
  readonly reason: string
}

/** The three holds a latch runs, by the names the hold observer logs them under, in its order. */
export type RecoveryLatchHold = 'retry timer stop' | 'tmux-unresponsive end' | 'unclassified-error end'

/**
 * One step of a latch's reaction, in the order it happened: the set itself
 * (as the latch's set observers see it), each hold as it is called, and each
 * CONFLICT notice the notice reaction posted.
 */
export type RecoveryLatchEvent =
  | {
      readonly step: 'set'
      readonly key: string
      readonly outcome: ConflictLatchSetOutcome
      readonly record: ConflictLatchRecord
    }
  | { readonly step: 'hold'; readonly key: string; readonly hold: RecoveryLatchHold }
  | { readonly step: 'notice'; readonly key: string; readonly text: string }

/** The harness's latch, read-only: the latched query and the record. */
export type RecoveryLatchView = Pick<ConflictLatch, 'isLatched' | 'record'>

/** What `makeRecoveryHarness` returns; see the module comment. */
export interface RecoveryHarness {
  readonly clock: FakeClock
  readonly controller: UnavailableRetryController
  readonly config: PersonaConfig
  readonly keys: readonly string[]
  readonly home: string
  readonly stateDir: string
  readonly stub: StubSpawnPath
  readonly lines: string[]
  /** Every `console.error` line while the harness is live, in order. */
  readonly errors: string[]
  readonly attempts: RecoveryAttempt[]
  readonly notices: RecoveryNotice[]
  readonly outageNotices: RecoveryNotice[]
  readonly triggers: RecoveryTrigger[]
  /** The notice episodes' posts, in order. */
  readonly episodeNotices: RecoveryNotice[]
  /** The notice-episodes instance, on the harness clock. */
  readonly episodes: PersonaEpisodes
  /** The `tmux-unresponsive` condition over `episodes`, wired as `main()` wires it. */
  readonly tmuxUnresponsive: TmuxUnresponsiveCondition
  /** Every call the condition made to the controller's condition-end entry, in order. */
  readonly conditionEnds: RecoveryConditionEnd[]
  /** Every call a real `tmux-unavailable` clear made to the controller's condition-end entry, in order. */
  readonly outageClears: RecoveryConditionEnd[]
  /** Keys `onCapReached` was called for, in order. */
  readonly capReached: string[]
  /** Every call to the controller's stop observer (`onStopped`), in order. */
  readonly stops: RecoveryStop[]
  /** Whether persona `key`'s unclassified-error episode is open (read-only). */
  unclassifiedErrorOpen(key: string): boolean
  /** The harness's one latch, read-only (`isLatched`, `record`); composed as `main()` composes it. */
  readonly latch: RecoveryLatchView
  /** Every latch set, hold and CONFLICT notice post, in order. */
  readonly latchEvents: RecoveryLatchEvent[]
  /** The per-persona serializer the restart module runs its work through. */
  readonly serializer: PersonaSerializer
  /** The server's retry action, for both modes, over the real row read and restart entry (the default). */
  readonly fullModeAction: UnavailableRetryAction
  /** The scripted action (`answer`). */
  readonly scriptedAction: UnavailableRetryAction
  script(knobs: RecoveryStubScript): void
  launch(key: string): Promise<SpawnPersonaResult>
  settle(): Promise<void>
  answer(key: string, ...outcomes: UnavailableRetryOutcome[]): void
  setAction(action: UnavailableRetryAction | undefined): void
  /** Whether persona `key`'s bring-up outcome is up (the relaunch gate); true at first. */
  setUp(key: string, up: boolean): void
  /** Whether persona `key`'s session is registered as connected with its message stream; false at first. */
  setConnected(key: string, connected: boolean): void
  /** The server's shutdown: raise the shutting-down flag, close the controller, then close the episodes. */
  shutdown(): void
  /**
   * The persona teardown's submit (stop the retry timer, cancel the
   * condition's alert check), then its turn's latch forget (silent); its
   * episodes forget is the case's `episodes.forget(key)` after it.
   */
  teardown(key: string): void
  /** Drop persona `key` from the applied configuration. */
  remove(key: string): void
  /** A health tick's end of the condition, as `main()` binds it: reason `tick`, reading `live`. */
  tickEnd(key: string): TmuxUnresponsiveEndResult
  /**
   * A health tick body's end, as `main()` binds `HealthCheckDeps.onTickEnd`:
   * the condition's onset check (`onsetAtTick`) for the tick started at
   * `tickStartedAt` (the harness clock's now when unset).
   */
  tickOnset(tickStartedAt?: number): void
  /** Set `health_check_interval` in the configuration in effect (0: the health check is off). */
  setHealthCheckInterval(seconds: number): void
  startupErrors(): string[]
  settings(): AdSettingsInEffect
  advance(ms: number): Promise<number>
  captured(): Record<string, unknown>
  cleanup(): void
}

/** Build a recovery harness; see the module comment. Call `cleanup()` in `afterEach`. */
export function makeRecoveryHarness(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const root = mkdtempSync(join(tmpdir(), 'cscb-recovery-harness-'))
  const home = join(root, 'home')
  const stateDir = join(root, 'state')
  mkdirSync(home)
  mkdirSync(stateDir)

  const clock = createFakeClock()
  const lines: string[] = []
  const errors: string[] = []
  const attempts: RecoveryAttempt[] = []
  const notices: RecoveryNotice[] = []
  const outageNotices: RecoveryNotice[] = []
  const triggers: RecoveryTrigger[] = []
  const episodeNotices: RecoveryNotice[] = []
  const conditionEnds: RecoveryConditionEnd[] = []
  const outageClears: RecoveryConditionEnd[] = []
  const settleFlushes = options.settleFlushes ?? DEFAULT_SETTLE_FLUSHES
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const log = (line: string): void => {
    lines.push(line)
  }

  const config = makeMultiPersonaConfig(options.personas ?? [{}, {}], root, {
    session_restart_delay: options.sessionRestartDelay ?? 0,
    health_check_interval: options.healthCheckInterval ?? 0,
  })
  const keys = config.personas.map((persona) => persona.key)
  for (const persona of config.personas) mkdirSync(persona.working_directory, { recursive: true })

  const capReached: string[] = []
  const stops: RecoveryStop[] = []
  const applied = new Set(keys)
  const down = new Set<string>()
  const connected = new Set<string>()
  let shuttingDown = false
  const serializer = createPersonaSerializer()

  const appliedPersona = (key: string): Persona | undefined =>
    applied.has(key) ? config.personas.find((persona) => persona.key === key) : undefined
  const appliedConfig = (): PersonaConfig => ({ ...config, personas: config.personas.filter((persona) => applied.has(persona.key)) })
  const canRelaunch = createPersonaRelaunchGate({ status: () => SERVING }, log, {
    isUp: (key) => !down.has(key),
    isApplied: (key) => applied.has(key),
  })

  const queued = new Map<string, UnavailableRetryOutcome[]>()
  const scripted: UnavailableRetryAction = (key) => queued.get(key)?.shift() ?? SCRIPTED_REFUSAL
  const fullMode = createFullModeRetryAction({
    readRow: readPersonaRowState,
    retry: runRestartRetry,
    appliedPersona,
    canRelaunch,
    isAtCap: (key) => isAtCap(key, RESTART_FAILURE_CAP),
    isShuttingDown: () => shuttingDown,
    // As main() binds it (b.jg5 SRJ-303, SRJ-305): a retry of a latched
    // persona makes no call and stops the timer.
    isLatched: (key) => latch.isLatched(key),
    isInFlight: isLaunchInFlight,
    isSessionConnected: (key) => connected.has(key),
    hasSessionStream: (key) => connected.has(key),
    endTmuxUnresponsive: (key, reading) => {
      tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading)
      clearOutageFlag(key, 'tmux-unavailable', reading)
    },
  })
  let current: UnavailableRetryAction = options.action === 'scripted' ? scripted : (options.action ?? fullMode)
  const controller = createUnavailableRetryController({
    log,
    clock,
    // As main() binds it: every fire, a skipped one included, is the
    // condition's onset check with the health check off.
    onRetryFire: (key, firedAt) => tmuxUnresponsive.onsetAtRetry(key, firedAt),
    // As main() binds it: every real stop of a persona's timer cancels the
    // condition's pending alert check, with the stop's reason, and then tells
    // the unclassified-error episodes (b.jg5 SRJ-313), each step isolated.
    // Each call is recorded in `stops` first.
    onStopped: (key, reason) => {
      stops.push({ key, reason })
      try {
        tmuxUnresponsive.cancelAlert(key, reason)
      } catch {
        /* isolated, as in main() */
      }
      try {
        unclassifiedErrors.retryStopped(key, reason)
      } catch {
        /* isolated, as in main() */
      }
    },
    action: (key, attempt) => {
      attempts.push({ key, retry: attempt.retry, causes: attempt.causes, mode: attempt.mode, at: clock.now() })
      return current(key, attempt)
    },
  })

  // As main() builds them: the one episodes instance, and the condition over
  // it, whose every end is reported to the controller's condition-end entry.
  const alertThresholdMs = options.alertThresholdMs ?? adAlertThresholdMsInEffect
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      episodeNotices.push({ key, text })
    },
    log,
    clock,
  })
  const tmuxUnresponsive = createTmuxUnresponsiveCondition({
    episodes,
    log,
    conditionEnded: (key, reading) => {
      const result = controller.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, reading)
      conditionEnds.push({ key, reading, result })
      return result
    },
    healthCheckOn: () => appliedConfig().health_check_interval !== 0,
    ...(alertThresholdMs === false ? {} : { alertThresholdMs }),
  })
  // As main() builds them (b.jg5 SRJ-313, SRJ-1009): the unclassified-error
  // episodes over the same episodes instance, at E6's alert threshold in
  // effect, the configured-key lookup over the live applied set, and the
  // log-only route through `recordStartupError` into the harness's
  // startup-errors capture.
  const unclassifiedErrors = createUnclassifiedErrorEpisodes({
    episodes,
    log,
    alertThresholdMs: adAlertThresholdMsInEffect,
    isConfigured: (key) => applied.has(key),
    logOnly: (key, text) => recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, `persona=${key}: ${text}`),
  })

  // As main() builds it (b.jg5 SRJ-501, SRJ-502, SRJ-508): one latch per
  // harness, its lines to `lines`. A recorder observer first (it only records
  // the set in `latchEvents`), then, in main()'s order, the holds (the timer's
  // stop with the latch's reason, the condition's silent end, the
  // unclassified-error episode's end), then the CONFLICT notice over the
  // episodes, so every hold is done before the notice is posted. The
  // session manager's installer comes with the other installs below.
  const latchEvents: RecoveryLatchEvent[] = []
  const latch = createConflictLatch({ log })
  const hold = (key: string, name: RecoveryLatchHold): void => {
    latchEvents.push({ step: 'hold', key, hold: name })
  }
  const unbindLatch = [
    latch.addSetObserver(({ key, outcome, record }) => {
      latchEvents.push({ step: 'set', key, outcome, record })
    }),
    bindConflictLatchHolds(
      latch,
      {
        stopRetryTimer: (key) => {
          hold(key, 'retry timer stop')
          controller.stop(key, UNAVAILABLE_RETRY_STOP_LATCHED)
        },
        endTmuxUnresponsive: (key) => {
          hold(key, 'tmux-unresponsive end')
          tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_LATCHED, undefined, { silent: true })
        },
        endUnclassifiedError: (key) => {
          hold(key, 'unclassified-error end')
          unclassifiedErrors.end(key, UNCLASSIFIED_ERROR_END_LATCHED)
        },
      },
      log,
    ),
    bindConflictNotice(latch, recordingNoticeEpisodes(episodes, (key, text) => latchEvents.push({ step: 'notice', key, text }))),
  ]

  const savedStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = stateDir
  const savedConsoleError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }

  const stub = installStubSpawnPath(home)
  _setTmuxSessionKiller(async () => {})
  _setTmuxServerEnsurer(async () => {})
  _resetFindMissingMemo()
  const triggerSink: UnavailableRetryTriggerSink = {
    arm(key, cause) {
      triggers.push({ key, kind: cause.kind })
      return controller.arm(key, cause)
    },
  }
  _resetOutageState()
  initOutageState({
    notify: (key, text) => {
      outageNotices.push({ key, text })
    },
    getClient: () => stub.client as unknown as Client,
    ...(options.triggerSink === false ? {} : { triggerSink }),
    ...(options.conditionSink === false ? {} : { conditionSink: tmuxUnresponsive }),
    unclassifiedSink: unclassifiedErrors,
    // As main() binds it: each real clear of the persona's `tmux-unavailable`
    // outage reaches the controller's condition-end entry once, with the
    // reading the clear brought.
    onFlagCleared: (key, cls, reading) => {
      if (cls !== 'tmux-unavailable') return
      const result = controller.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE, reading)
      outageClears.push({ key, reading, result })
    },
  })
  setSessionNotifier((key, text) => {
    notices.push({ key, text })
  })
  // As main() installs it, before any launch: the collision ladder latches
  // through it and launches no latched persona.
  setConflictLatch(latch)
  // As main() installs it, beside the latch (b.jg5 SRJ-114): a key counts as
  // configured while it is in the live applied set, so a note on a persona's
  // own row latches it and a key outside the set, or removed from it, does not.
  setConfiguredPersonaQuery((key) => appliedPersona(key) !== undefined)

  resetAdSettingsForTests()
  if (options.adSettings !== undefined) writeAgentDirectorConfig(home, options.adSettings)
  installAdSettings({ home: () => home, log })

  _resetRestartState()
  _resetBackoffState()
  initRestart({
    canRestart: canRelaunch,
    isSessionAlive: _buildIsSessionAliveAdapter(appliedConfig),
    isSessionConnected: (key) => connected.has(key),
    hasSessionStream: (key) => connected.has(key),
    reconnectSession: _buildReconnectSessionAdapter(appliedPersona),
    killSession: _buildKillSessionAdapter(appliedPersona),
    launchSession: (key) => launchSession(key, appliedConfig(), { canLaunch: canRelaunch }),
    getRestartDelay: () => config.session_restart_delay,
    isShuttingDown: () => shuttingDown,
    // As main() binds it, after recording the key: the cap notice, then the
    // silent end of the persona's unclassified-error episode, each isolated.
    onCapReached: (key) => {
      capReached.push(key)
      try {
        notifyRestartCapReached(key)
      } catch {
        /* isolated, as in main() */
      }
      try {
        unclassifiedErrors.end(key, UNCLASSIFIED_ERROR_END_CAPPED)
      } catch {
        /* isolated, as in main() */
      }
    },
    serialize: serializer.run,
    // As main() binds it (b.jg5 SRJ-314, SRJ-301): every `unknown` liveness
    // reading at the restart work arms the persona's timer on the controller
    // with the read-error cause, straight to the controller (not through the
    // trigger sink, so it is not recorded in `triggers`).
    armRetryTimer: (key) => {
      controller.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    },
    // As main() binds it (b.jg5 SRJ-502): a latched persona's restart work
    // makes no agent-director call.
    isLatched: (key) => latch.isLatched(key),
    ...options.restartDeps,
  })

  /** Every key a run may be in flight for: the configured, the armed and those a retry ran for. */
  function runKeys(): string[] {
    return [...new Set([...keys, ...controller.armedKeys(), ...attempts.map((a) => a.key)])]
  }

  /** Await every in-flight retry run, for at most `settleFlushes` clock flushes. */
  async function settleRuns(): Promise<void> {
    let settled = false
    const all = Promise.all(runKeys().map((key) => controller.whenRunSettled(key))).then(() => {
      settled = true
    })
    for (let flushes = 0; flushes < settleFlushes && !settled; flushes++) await clock.flush()
    void all
  }

  /**
   * Await every configured persona's launch in flight and every retry run in
   * flight, in 1 ms real-time steps, for at most `settleMs`.
   */
  async function settleLaunches(): Promise<void> {
    let settled = false
    const all = Promise.all([
      ...keys.map((key) => whenLaunchSettled(key)),
      ...runKeys().map((key) => controller.whenRunSettled(key)),
    ]).then(() => {
      settled = true
    })
    for (let waited = 0; waited < settleMs && !settled; waited++) {
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 1))])
    }
    if (!settled) throw new Error(`recovery harness: a launch or a retry run was still in flight after ${settleMs} ms`)
  }

  function startupErrors(): string[] {
    const path = join(stateDir, 'startup-errors.log')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line !== '')
  }

  return {
    clock,
    controller,
    config,
    keys,
    home,
    stateDir,
    stub,
    lines,
    errors,
    attempts,
    notices,
    outageNotices,
    triggers,
    episodeNotices,
    episodes,
    tmuxUnresponsive,
    conditionEnds,
    outageClears,
    capReached,
    stops,
    unclassifiedErrorOpen: (key) => unclassifiedErrors.isOpen(key),
    latch: Object.freeze({ isLatched: (key: string) => latch.isLatched(key), record: (key: string) => latch.record(key) }),
    latchEvents,
    serializer,
    fullModeAction: fullMode,
    scriptedAction: scripted,

    script(knobs) {
      // The installed stub reads its knobs, at each call, from the object it
      // records its calls in. Non-enumerable, so `callCount` and a comparison
      // of `stub.calls` still see only the capture lists.
      for (const [name, value] of Object.entries(knobs)) {
        Object.defineProperty(stub.calls, name, { value, writable: true, configurable: true, enumerable: false })
      }
    },

    launch(key) {
      const persona = config.personas.find((p) => p.key === key)
      if (persona === undefined) throw new Error(`recovery harness: no configured persona ${JSON.stringify(key)}`)
      return spawnForPersona(persona, config, true)
    },

    settle: settleLaunches,

    answer(key, ...outcomes) {
      queued.set(key, [...(queued.get(key) ?? []), ...outcomes])
    },

    setAction(action) {
      current = action ?? fullMode
    },

    setUp(key, up) {
      if (up) down.delete(key)
      else down.add(key)
    },

    setConnected(key, isConnected) {
      if (isConnected) connected.add(key)
      else connected.delete(key)
    },

    shutdown() {
      shuttingDown = true
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      episodes.close()
    },

    teardown(key) {
      controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      tmuxUnresponsive.cancelAlert(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      // As main()'s `forgetConflictLatch` (b.jg5 SRJ-504): silently, before
      // the turn's episodes forget (the case's `episodes.forget(key)`).
      latch.forget(key)
    },

    remove(key) {
      applied.delete(key)
    },

    tickEnd: (key) => tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE),

    tickOnset: (tickStartedAt = clock.now()) => tmuxUnresponsive.onsetAtTick(tickStartedAt),

    setHealthCheckInterval(seconds) {
      config.health_check_interval = seconds
    },

    startupErrors,

    settings: () => adSettingsInEffect(),

    async advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`recovery harness: advance needs a finite, non-negative ms, got ${ms}`)
      const target = clock.now() + ms
      let fired = 0
      await settleRuns()
      for (let next = clock.pending()[0]; next !== undefined && next.dueAt <= target; next = clock.pending()[0]) {
        fired += await clock.advanceTo(next.dueAt)
        await settleRuns()
      }
      await clock.advanceTo(target)
      return fired
    },

    captured: () => ({
      lines: [...lines],
      errors: [...errors],
      notices: [...notices],
      outageNotices: [...outageNotices],
      episodeNotices: [...episodeNotices],
      startupErrors: startupErrors(),
      attempts: [...attempts],
      triggers: [...triggers],
      conditionEnds: [...conditionEnds],
      outageClears: [...outageClears],
      stops: [...stops],
      latchEvents: [...latchEvents],
      stateDir: writtenFile(stateDir),
    }),

    cleanup() {
      controller.stopAll('the recovery harness is cleaned up')
      episodes.forgetAll()
      const pendingTimers = clock.pendingCount()
      const armed = controller.armedKeys()
      _resetRestartState()
      _resetBackoffState()
      _resetOutageState()
      setSessionNotifier(undefined)
      setConflictLatch(undefined)
      _resetConfiguredPersonaQuery()
      for (const unbind of unbindLatch) unbind()
      resetStubSpawnPath()
      _resetTmuxSessionKiller()
      _resetTmuxServerEnsurer()
      _resetFindMissingMemo()
      resetAdSettingsForTests()
      console.error = savedConsoleError
      if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
      else process.env['SLACK_STATE_DIR'] = savedStateDir
      rmSync(root, { recursive: true, force: true })
      if (pendingTimers !== 0 || armed.length !== 0) {
        throw new Error(
          `recovery harness: ${pendingTimers} timer(s) still pending and ${armed.length} persona(s) still armed after stopAll`,
        )
      }
    },
  }
}

/**
 * What the CONFLICT notice reaction gets: `episodes`' own `begin` and `post`,
 * with each post that went out (a CONFLICT notice) also handed to `posted`
 * once the episodes' sink has it. Nothing else changes.
 */
function recordingNoticeEpisodes(
  episodes: PersonaEpisodes,
  posted: (key: string, text: string) => void,
): ConflictNoticeEpisodes {
  return {
    begin: (key, kind, caseLabel) => episodes.begin(key, kind, caseLabel),
    post: (key, kind, text, mark) => {
      const sent = episodes.post(key, kind, text, mark)
      if (sent) posted(key, text)
      return sent
    },
  }
}

// ---------------------------------------------------------------------------
// Shared case helpers over a harness
// ---------------------------------------------------------------------------

/** Persona `key` of the harness's configuration. */
export function personaOf(h: RecoveryHarness, key: string): Persona {
  return h.config.personas.find((p) => p.key === key)!
}

/**
 * The stub answers of a launch of `persona` whose optimistic spawn collides,
 * whose collision `get` reads `row` (in the persona's own directory with its
 * current labels, unless `row` says otherwise), and whose later spawns answer
 * `spawns` in order.
 */
export function collided(h: RecoveryHarness, persona: Persona, row: PersonaGetResultOverrides, ...spawns: Error[]): RecoveryStubScript {
  return {
    spawnQueue: [errInstanceIdCollision(), ...spawns].map((err) => cannedErr<SpawnResult>(err)),
    getResult: cannedGetResult(row, persona, h.home),
  }
}

/** The stub's call counts, by verb, leaving out verbs never called. */
export function callCounts(h: RecoveryHarness): Record<string, number> {
  return Object.fromEntries(Object.entries(h.stub.calls).filter(([, calls]) => calls.length > 0).map(([verb, calls]) => [verb, calls.length]))
}

/**
 * The stub's calls for persona `key`'s instance (`claude_instance_id` is
 * `personaInstanceId(key)`), by verb, leaving out verbs with none. Its values
 * summed are the persona's calls over every verb.
 */
export function personaCallCounts(h: RecoveryHarness, key: string): Record<string, number> {
  const id = personaInstanceId(key)
  return Object.fromEntries(
    Object.entries(h.stub.calls)
      .map(([verb, calls]) => [verb, (calls as Array<{ claude_instance_id?: unknown } | undefined>).filter((c) => c?.claude_instance_id === id).length] as const)
      .filter(([, count]) => count > 0),
  )
}

/** The calls `after` holds beyond `before` (two by-verb counts), by verb, leaving out verbs with no increase. */
export function callCountsSince(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(after).map(([verb, n]) => [verb, n - (before[verb] ?? 0)] as const).filter(([, n]) => n > 0))
}

/**
 * Wrap every verb of the harness's stub client, in place, so each call from
 * now on also appends the verb's name to the returned list, in call order.
 * Every function the client has is wrapped (unlike the stub's own `calls`
 * log, which a case reads verb by verb), so the list holds exactly the calls
 * made, a stray `readPane`, `sendKeys`, `pause` or `decide` included.
 */
export function recordCallOrder(h: RecoveryHarness): string[] {
  const order: string[] = []
  const client = h.stub.client as unknown as Record<string, unknown>
  for (const name of Object.keys(client)) {
    const verb = client[name]
    if (typeof verb !== 'function') continue
    client[name] = (...args: unknown[]): unknown => {
      order.push(name)
      return (verb as (...a: unknown[]) => unknown).apply(client, args)
    }
  }
  return order
}

/**
 * Move the clock to persona `key`'s due time, firing its retry, and (unless
 * `options.settle` is false) let the retry, with any launch it makes, settle.
 * Resolves with the due time; throws when no retry is pending.
 */
export async function retryNow(h: RecoveryHarness, key: string, options: { settle?: boolean } = {}): Promise<number> {
  const dueAt = h.controller.view(key)?.dueAt
  if (dueAt === undefined) throw new Error(`retryNow: persona ${key} has no pending retry`)
  await h.advance(dueAt - h.clock.now())
  if (options.settle !== false) await h.settle()
  return dueAt
}

/** A row state `cannedStatusResult` reads. */
export type RecoveryRowState = NonNullable<NonNullable<Parameters<typeof cannedStatusResult>[0]>['state']>

/**
 * Each persona's row as the stub's `status` reports it: `before` (no row,
 * `ErrSpawnNotFound`, for `UNAVAILABLE_RETRY_ROW_ABSENT`) until a spawn of
 * that instance resolves, and `waiting` from then on.
 */
export function rowReadsUntilSpawn(h: RecoveryHarness, before: RecoveryRowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT): void {
  const live = new Set<string>()
  const client = h.stub.client
  const spawn = client.spawn.bind(client)
  client.spawn = async (params) => {
    const result = await spawn(params)
    live.add(String(params.claude_instance_id))
    return result
  }
  h.script({
    statusFn: (params) => {
      if (live.has(String(params.claude_instance_id))) return cannedStatusResult({ state: 'waiting' })
      return before === UNAVAILABLE_RETRY_ROW_ABSENT ? errSpawnNotFound() : cannedStatusResult({ state: before })
    },
  })
}

// The `tmux-unresponsive` condition's log lines (SRJ-307 to SRJ-310). The
// lines have no exported builder, so these hold their fixed words; a case
// gives the seconds from its clock and the threshold in effect.

/** The prefix of every line persona `key`'s condition logs. */
export function conditionLinePrefix(key: string): string {
  return `[slack] persona-episodes: persona=${key} ${PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE} `
}

/** Persona `key`'s condition lines, in order. */
export function conditionLines(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.startsWith(conditionLinePrefix(key)))
}

/** Persona `key`'s condition started lines. */
export function conditionStartedLines(h: RecoveryHarness, key: string): string[] {
  return conditionLines(h, key).filter((line) => line.startsWith(`${conditionLinePrefix(key)}started`))
}

/** Persona `key`'s condition ended lines. */
export function conditionEndedLines(h: RecoveryHarness, key: string): string[] {
  return conditionLines(h, key).filter((line) => line.startsWith(`${conditionLinePrefix(key)}ended`))
}

/** Whole seconds, rounded down, of `ms`: how the lines give a span. */
function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000)
}

/** The onset's line: posted at `where`, `sinceMs` after the first refusal. */
export function conditionOnsetLine(key: string, where: 'a health tick' | 'a retry', sinceMs: number): string {
  return `${conditionLinePrefix(key)}onset posted — still not answering at ${where}, ${wholeSeconds(sinceMs)} s after its first refusal`
}

/** The alert's line: posted `lastedMs` after the first refusal, over `thresholdMs`. */
export function conditionAlertLine(key: string, lastedMs: number, thresholdMs: number): string {
  return `${conditionLinePrefix(key)}alert posted — not answering for ${wholeSeconds(lastedMs)} s, over its alert threshold of ${wholeSeconds(thresholdMs)} s`
}

/** The ended line for `reason`. */
export function conditionEndedLine(key: string, reason: TmuxUnresponsiveEndReason): string {
  return `${conditionLinePrefix(key)}ended — ${TMUX_UNRESPONSIVE_END_TEXT[reason]}`
}

/** The recovery's line, after the ended line. */
export function conditionRecoveryLine(key: string): string {
  return `${conditionLinePrefix(key)}recovery posted`
}

/** A silent end's line after an onset, after the ended line. */
export function conditionSilentEndLine(key: string): string {
  return `${conditionLinePrefix(key)}recovery not posted — a silent end (a CONFLICT answer ended it)`
}

// The unclassified-error episodes' log lines (b.jg5 SRJ-313, SRJ-1009). As
// above, the fixed words are held here; the kind, the startup-errors label and
// the rendering of an outcome come from `src/`. Each outcome builder takes the
// thrown value and renders it as the episodes do when the site gives no
// classification of its own (`classifyAdError`).

/** The prefix of every line persona `key`'s unclassified-error episode logs. */
export function unclassifiedLinePrefix(key: string): string {
  return `[slack] persona-episodes: persona=${key} ${PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR} `
}

/** Persona `key`'s unclassified-error lines, in order. */
export function unclassifiedLines(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.startsWith(unclassifiedLinePrefix(key)))
}

/** Persona `key`'s unclassified-error started lines. */
export function unclassifiedStartedLines(h: RecoveryHarness, key: string): string[] {
  return unclassifiedLines(h, key).filter((line) => line.startsWith(`${unclassifiedLinePrefix(key)}started — `))
}

/** The rendering of the thrown value `err` an unclassified-error line quotes. */
function unclassifiedQuote(err: unknown): string {
  return describeAdErrorClassification(classifyAdError(err))
}

/** The started line of an episode whose first outcome is `err`. */
export function unclassifiedStartedLine(key: string, err: unknown): string {
  return `${unclassifiedLinePrefix(key)}started — ${unclassifiedQuote(err)}`
}

/** The ended line for `reason`. */
export function unclassifiedEndedLine(key: string, reason: UnclassifiedErrorEndReason): string {
  return `${unclassifiedLinePrefix(key)}ended — ${reason}`
}

/** What an alert line says of the outcome `err` met `elapsedMs` after the episode's first, over `thresholdMs`. */
function unclassifiedMet(elapsedMs: number, thresholdMs: number, err: unknown): string {
  return `an UNCLASSIFIED outcome met ${wholeSeconds(elapsedMs)} s after the episode's first, over its alert threshold of ${wholeSeconds(thresholdMs)} s: ${unclassifiedQuote(err)}`
}

/** The line of an alert posted to the persona's destination. */
export function unclassifiedPostedLine(key: string, elapsedMs: number, thresholdMs: number, err: unknown): string {
  return `${unclassifiedLinePrefix(key)}alert posted to its destination — ${unclassifiedMet(elapsedMs, thresholdMs, err)}`
}

/** The line of an alert for a persona not in the applied configuration, written only to the logs. */
export function unclassifiedLoggedLine(key: string, elapsedMs: number, thresholdMs: number, err: unknown): string {
  return `${unclassifiedLinePrefix(key)}alert written to the server log and startup-errors.log (${PERSONA_UNCLASSIFIED_ERROR_LABEL}) — the persona is not in the applied configuration; ${unclassifiedMet(elapsedMs, thresholdMs, err)}`
}

/** The outage class a CONFIG answer raises (b.jg5 SRJ-316). */
const AD_CONFIG_MALFORMED_CLASS: OutageClass = 'ad-config-malformed'

/** The outage state's raise lines for persona `key`'s `ad-config-malformed` outage (one per raise), in `errors`. */
export function adConfigMalformedRaiseLines(h: RecoveryHarness, key: string): string[] {
  return h.errors.filter((line) => line.startsWith(`[slack] outage-state: ${AD_CONFIG_MALFORMED_CLASS} raised for persona=${key}: `))
}
