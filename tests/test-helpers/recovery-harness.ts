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
 *   latched query (`latch` below), the hold's held query (`invalidFlagsHold`
 *   below) and "blocks a retry" (as `main()`'s
 *   `isPersonaRetryBlocked`, b.jg5 SRJ-303: the session manager's
 *   `personaRetryBlockCause` names a cause, `isLaunchInFlight`, its
 *   `isLiveRowSequenceRunning`, SRJ-706, or an old-life wait step for a hold
 *   the persona waits on, SRJ-811; a running dialog approver alone never
 *   skips a retry, SRJ-401), with that cause query as `retryBlockCause` (the
 *   skip's again-reason and the restart retry's skip line), and the condition's
 *   retry hooks: the
 *   connection and stream probes (`isSessionConnected` and
 *   `hasSessionStream`, both over `setConnected`) and `endTmuxUnresponsive`,
 *   the condition's end with reason `TMUX_UNRESPONSIVE_END_RETRY` and the
 *   retry's reading followed by the clear of the persona's
 *   `tmux-unavailable` outage with that reading (b.jg5 SRJ-311, SRJ-312),
 *   and the read-and-step dependency (`stepPendingRow`, b.jg5 SRJ-409,
 *   SRJ-411): the session manager's `retryPendingRowStep` over the
 *   applied-persona lookup, so a pending-only retry whose `status` shows
 *   `pending` makes one `get` and keeps a covered or undecided row armed
 *   pending-only, or starts the live-row sequence for an uncovered one.
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
 *   (`_buildIsSessionAliveAdapter` over the applied configuration, one
 *   instance, as `main()`'s `isSessionAliveAdapter`, which the lost-message
 *   driver's row read is too), the
 *   reconnect and kill adapters (`_buildReconnectSessionAdapter`,
 *   `_buildKillSessionAdapter`, over the applied-persona lookup, the kill
 *   adapter with the kill-retry clock below) and
 *   `launchSession` over the applied configuration with the relaunch gate as
 *   `canLaunch` and, as `main()` binds it, the escalate-dead verdict the
 *   restart work hands a relaunch passed on unchanged as `deadEvidence`
 *   (b.jg5 SRJ-611), so a relaunch after an escalation carries its verdict
 *   into the ladder. `getRestartDelay` answers the configuration's
 *   `session_restart_delay` (0 by default). `onCapReached` records the key in
 *   `capReached` and then, as `main()` binds it, calls
 *   `notifyRestartCapReached`, whose notice lands in `notices`, and ends the
 *   persona's unclassified-error episode
 *   (`end(key, UNCLASSIFIED_ERROR_END_CAPPED)`), and stops its retry timer
 *   in either mode (`controller.stop(key, UNAVAILABLE_RETRY_STOP_CAPPED)`,
 *   b.jg5 SRJ-305, so a real stop shows in `stops`), each isolated. `serialize` is `serializer.run`, one real per-persona
 *   serializer (`createPersonaSerializer`), which a test may hold a turn on.
 *   `armRetryTimer`, the arm hook, is bound as `main()` binds it (b.jg5
 *   SRJ-314, SRJ-301): every `unknown` liveness reading at the restart work,
 *   the re-probe's included, arms the persona's timer on the controller with
 *   `UNAVAILABLE_RETRY_CAUSE_READ_ERROR`, straight to the controller (it is
 *   not recorded in `triggers`); an arm while the timer is armed or running
 *   keeps its due time. `deferPendingRow`, the `pending` deferral (b.jg5
 *   SRJ-314, SRJ-409, SRJ-411), is bound as `main()` binds it: every
 *   `pending` liveness reading at the restart work, the re-probe's included,
 *   is handed, awaited, to the server's `deferPendingRow` with the reading's
 *   launch start and the harness's applied-persona lookup (its lines go to
 *   `errors`). For an applied persona it runs the session manager's
 *   `readAndStepPendingRow`: one `get`, then a covered or undecided row armed
 *   pending-only (through the trigger sink: in `triggers` with
 *   `UNAVAILABLE_RETRY_CAUSE_PENDING_ROW`), an uncovered one sent through the
 *   live-row sequence (conversation not kept, context `recovery`), a latching
 *   row latched; its per-answer lines (row no longer pending, gone, refused)
 *   are written, and a step that throws is logged and still answers
 *   `pending`. The reconnect adapter is given the same lookup, so its own
 *   `pending` answer takes the same deferral.
 *   `isLatched` is the latch's latched query (`latch`
 *   below). `isHeld` is the hold's held query (`invalidFlagsHold` below;
 *   b.jg5 SRJ-207), so the restart work answers `held` with no call for a
 *   held persona and arms no restart timer for it.
 *   `isLiveRowSequenceRunning` is the session manager's gate
 *   (`liveRowSequenceGate(key, 'runRestartWork')`, b.jg5 SRJ-706, SRJ-303,
 *   SRJ-811), as `main()` binds it, so the restart work answers
 *   `sequence-waiting` with no call while the persona's sequence runs, and
 *   while an old-life wait runs on its own `cscb_<key>` the gate also arms
 *   its timer (`held-for-old-life`, through the wait bindings' arm).
 *   `isHeldForOldLife`, the old-life hook (b.jg5 SRJ-810, SRJ-812), is the
 *   session manager's hold step over the applied persona
 *   (`oldLifeHoldStep(persona, 'runRestartWork')`), as `main()` binds it:
 *   while a hold other than one on the persona's own row is on its working
 *   directory, the step records the persona as waiting, starts the hold's
 *   wait unless one runs and arms its timer (`held-for-old-life`, through the
 *   wait bindings' arm, so in `triggers`), and the restart work answers
 *   `sequence-waiting` with no call; a key outside the applied set is never
 *   held there.
 *   `slowRecovery`, the slow-recovery observer, is the harness's
 *   slow-recovery tracker (below), as `main()` binds it (b.jg5 SRJ-610).
 *   `options.restartDeps` replaces any of these. Every ask of the
 *   latched query in effect, a replacement's included, is recorded by key
 *   first (for `loseMessage`'s `restartRequested`); a throw still reaches
 *   the restart module.
 * - The relaunch gate is the real `createPersonaRelaunchGate` over a serving
 *   connection, with the bring-up outcome `setUp(key, up)` controls (every
 *   configured persona up at first) and the live applied set (its lines go
 *   to `lines`). `setConnected(key, connected)` controls whether the
 *   persona's session is registered as connected with its message stream
 *   (`isSessionConnected` and `hasSessionStream`; none at first).
 * - Drivers, each as the server does it: `shutdown()` raises the
 *   shutting-down flag, closes the live-row sequence registry
 *   (`close()`, not awaited: every sequence's stop signal is set, so none
 *   makes a call after the one in progress, and no start is taken after
 *   it; b.jg5 SRJ-706), closes the controller
 *   (`close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)`), then the episodes
 *   (`episodes.close()`: every alert check cancelled, a later condition
 *   start answers `closed`), then stops every dialog approver
 *   (`stopAllDialogApprovers`, not awaited: none makes a call after the one
 *   in progress, and none starts after it); `teardown(key)` is the
 *   teardown's submit: it first stops the persona's dialog approver
 *   (`stopDialogApprover(key, APPROVER_STOP_TEARDOWN)`, not awaited; also the
 *   one a launch in flight would start), then its live-row sequence
 *   (`stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN)`, not awaited: its
 *   signal is set now; b.jg5 SRJ-706, SRJ-715), then
 *   stops the persona's timer (`stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)`)
 *   and cancels its alert check (`tmuxUnresponsive.cancelAlert(key,
 *   UNAVAILABLE_RETRY_STOP_TORN_DOWN)`, which logs nothing more when the
 *   stop observer has already cancelled it), the condition kept; then it
 *   forgets the persona's old-life waits (the session manager's
 *   `forgetOldLifeWaits(key)`, not awaited: the key is forgotten as waiting
 *   on every hold, and a wait no persona left in the applied configuration
 *   waits on is stopped with the teardown reason; b.jg5 SRJ-811), the step
 *   production's turn takes right after the timer's stop; then it
 *   forgets the persona's latch silently (`latch.forget(key)`: no post, no
 *   set observer call, no line), the turn's step that production's
 *   `forgetConflictLatch` binds (b.jg5 SRJ-504), and then its
 *   `ErrInvalidFlags` hold (`forget(key)`: no post, no retry), the step
 *   production's `forgetInvalidFlagsHold` binds (b.jg5 SRJ-207, SRJ-715). The teardown's turn then
 *   forgets the persona's episodes, every kind (its unclassified-error,
 *   CONFLICT and slow-recovery episodes included), and its counts (the
 *   slow-recovery count), as production's `forgetNoticeEpisodes`
 *   does; a case does that step with `episodes.forget(key)` after
 *   `teardown(key)`, which keeps production's order (the latch, then the
 *   episodes). The harness does not wait for a launch in flight as the turn
 *   does, so a case settles any launch before `teardown(key)`. `remove(key)`
 *   drops the persona from the applied configuration without a teardown;
 *   `reAdd(key)` puts one of the harness's personas back.
 * - `teardownDeps()` (b.jg5 SRJ-715): the persona teardown's dependencies
 *   that act on what the harness owns, each bound as `main()` binds it in
 *   `createPersonaLifecycle`, so a case hands them to the real lifecycle
 *   (with recorders or real modules for the rest) and the whole teardown,
 *   submit and turn, runs over the harness: `stopApprover`
 *   (`stopDialogApprover(key, APPROVER_STOP_TEARDOWN)`),
 *   `stopLiveRowSequence` (`stopLiveRowSequence(key,
 *   LIVE_ROW_STOP_TEARDOWN)`), `whenLaunchSettled`, `cancelLaunchWait`
 *   (`cancelWorkingRowWait`), `stopRetryTimer` (the controller's
 *   `stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)`, then the condition's
 *   `cancelAlert` with the same reason), `forgetOldLifeWaits` (the session
 *   manager's teardown member, b.jg5 SRJ-811), `forgetConflictLatch` (`latch`'s
 *   `forget`), `forgetInvalidFlagsHold` (`invalidFlagsHold`'s `forget`),
 *   `forgetNoticeEpisodes` (`episodes.forget`), `resetOutageState`
 *   (`resetAllToHealthy`), `killInstance` (`killPersonaInstanceForTeardown`
 *   with `killRetryClock`, so `drive` moves the clock to its waits) and
 *   `raiseKillFailureAlert` (the harness's kill-failure alerts' `raise`,
 *   not latched, with the context `KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN`).
 *   Each call builds a fresh object over the same instances.
 * - `stub`: one stub client (`makeStubClient`) with its call log
 *   (`stub.calls`), installed through `installStubSpawnPath` with the spawn
 *   home under the harness's temporary HOME, and handed to the outage state
 *   (`initOutageState`) as its client. No launch path kills a tmux session
 *   or runs tmux: every launch reaches only the stub.
 *   `script(knobs)` sets the stub's answers (`StubClientOptions` knobs such
 *   as `spawnError`, `getQueue` or the per-call `spawnFn` and `resumeFn`),
 *   read at each call.
 * - `harnessNow`: with `options.harnessNow`, the session manager's clock
 *   (`_setNow`) is the harness clock, set where the approver's clock is:
 *   each launch call's window (b.jg5 SRJ-407, `launchCallWindowOf`) is
 *   recorded on harness-clock times, and the working-row wait, its deferral
 *   runs and the findMissing memo's window read it too; `cleanup()` restores
 *   the real one (`_resetNow`). Without it the harness leaves that clock
 *   alone (real unless the case sets its own), since a case that bounds the
 *   working-row wait in real ms needs a clock that moves on its own.
 * - `triggers`: the outage state's trigger sink (b.jg5 SRJ-301) is the
 *   controller, behind a recorder: every trigger an agent-director error
 *   inside a launch or recovery attempt sends (`{ key, kind }`, the cause
 *   kind) is recorded here, then armed on the controller; an ENVIRONMENT
 *   answer (`ErrTmuxNotAvailable`) or a CONFIG answer (`ErrConfigMalformed`)
 *   from any call for a persona, in or out of an attempt, is sent too (b.jg5
 *   SRJ-311, SRJ-316). The sink's pending-only arm (`armPendingOnly`, as the
 *   production sink, the controller, has it), which a launch's
 *   `ErrTmuxSessionCreate` reaches through the outage state's launch-failure
 *   arm (`armPendingOnlyAfterLaunchFailure`; b.jg5 SRJ-112, SRJ-113,
 *   SRJ-409), is recorded the same way, with the kind
 *   `UNAVAILABLE_RETRY_CAUSE_PENDING_ROW`, then armed on the controller's
 *   `armPendingOnly`. With
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
 * - `slowRecovery` (b.jg5 SRJ-610, SRJ-1010, SRJ-1016): one slow-recovery
 *   tracker (`createSlowRecoveryTracker`) over the same episodes instance,
 *   built after the unclassified-error episodes as `main()` builds it, its
 *   lines to `lines`; its post (SRJ-1010, `slowRecoveryText`) lands in
 *   `episodeNotices`. It is the restart deps' slow-recovery observer, so the
 *   restart work's runs feed its count, and its latch end (`endForLatch`) is
 *   the latch's fourth hold. `slowRecovery` is read-only: `count(key)` and
 *   `isOpen(key)` (the same state as `episodes.count(key,
 *   PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY)` and `episodes.isOpen`);
 *   a case moves it only through restart runs, a latch, a forget or
 *   `shutdown()`.
 * - The kill-failure alerts (b.jg5 SRJ-704, SRJ-1007, SRJ-1016;
 *   `createKillFailureAlerts`) over the same episodes instance, built and
 *   installed in the session manager (`setKillFailureAlerts`, removed by
 *   `cleanup()`) as `main()` builds and installs them, before any launch:
 *   the restart path's kill adapter and the live-row sequence's kills raise
 *   the bounded retry's decision through them (context `recovery`; the
 *   collision ladder makes no kill), and every own-row read of the session manager that reads
 *   the row `ended` or `missing`, or finds it gone (`ErrSpawnNotFound`), ends
 *   the persona's episode silently. The destination route posts through the
 *   episodes' sink, so the alert lands in `episodeNotices`; the
 *   configured-key lookup reads the live applied set, so after `remove(key)`
 *   (also mid-run, from inside a stub call, e.g. through
 *   `recordCallOrder`'s `during`) the alert takes the log-only route, one
 *   `recordStartupError(<class>, <entry>)` into the harness's
 *   `startup-errors.log` (`startupErrors()`); their lines go to `lines`.
 *   `killFailureOpen(key)` reads whether the persona's episode is open
 *   (the lost-message driver's kill-failed input); nothing sets it by hand.
 *   The applied set is the harness's own, so a removal ends with it.
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
 *   post; a holding condition's end shows in `conditionEnds`), the
 *   unclassified-error episode's end (`end(key,
 *   UNCLASSIFIED_ERROR_END_LATCHED)`) and the slow-recovery tracker's latch
 *   end (`slowRecovery.endForLatch(key)`: the count reset and the episode
 *   ended silently). `latch` is read-only: `isLatched(key)`
 *   and `record(key)`. `latchEvents` holds, in order, each set as the
 *   observers see it (`{ step: 'set', key, outcome, record }`, recorded by an
 *   observer added before the holds), each of the first three holds as it is
 *   called (`{ step: 'hold', key, hold }`; the slow-recovery end is not
 *   recorded, and a case reads it through `slowRecovery`) and each CONFLICT
 *   notice posted (`{ step: 'notice', key, text }`), so a case can read that
 *   every hold ran before the notice.
 *   The harness has no health tick, so `HealthCheckDeps.isLatched` is not
 *   bound here; a tick case binds `latch.isLatched` itself. `teardown(key)`
 *   forgets the persona's latch silently (b.jg5 SRJ-504), as production's
 *   teardown does.
 * - `invalidFlagsHold` (b.jg5 SRJ-207, SRJ-1008, SRJ-1016, SRJ-305): one
 *   `ErrInvalidFlags` hold per harness (`createInvalidFlagsHold`, its lines
 *   to `lines`), composed as `main()` composes it: installed in the session
 *   manager (`setInvalidFlagsHold`, removed by `cleanup()`), so a reuse
 *   spawn's `ErrInvalidFlags` whose re-check did not stop the server holds
 *   the persona (its launch answers `held`) and a held persona's launch makes
 *   no agent-director call; its held query bound into the full-mode retry
 *   action (`isHeld`: a retry of a held persona stops with
 *   `UNAVAILABLE_RETRY_STOP_HELD`, no call), the restart deps
 *   (`RestartDeps.isHeld`) and the lost-message driver's cannot-launch
 *   input; and its set reaction (`bindInvalidFlagsHoldSetReaction`), which
 *   stops the persona's timer through the controller's stop entry with
 *   `UNAVAILABLE_RETRY_STOP_HELD` (a real stop shows in `stops`) and then
 *   posts SRJ-1008's alert once in its episode over `episodes` (in
 *   `episodeNotices`). `invalidFlagsHold` is read-only: `isHeld(key)`,
 *   `beganUnder(key)` and `heldKeys()`; a tick case binds
 *   `invalidFlagsHold.isHeld` as `HealthCheckDeps.isHeld` itself.
 *   `teardown(key)` forgets the persona's hold silently.
 * - The version-changed listener (b.jg5 SRJ-204, SRJ-207), registered as
 *   `main()` registers it (`onAdVersionChanged`): the hold's version-change
 *   reaction (`endInvalidFlagsHoldsOnVersionChange`) over the hold, the
 *   episodes and the live applied set, its retry at once the restart
 *   module's retry entry (`runRestartRetry`, no delay gate) with "blocks a
 *   retry", for each persona still applied. Each retry at once is recorded
 *   in `retriesAtOnce` (`{ key, at, outcome }`: the clock time it was asked
 *   for at and, once settled, the retry entry's outcome), and `settle()`
 *   awaits it. A re-check reset drops every listener, so `recheckAnswers`
 *   registers it again; `cleanup()` removes it.
 * - `versionRecheck(initial?)`: installs agent-director's version re-check
 *   on the harness clock as `main()` installs it (`installAdVersionRecheck`,
 *   its lines to `lines`), with the baseline `PHASE1_RC_VERSION`; its binary
 *   resolve (`makeStubResolveSystemBinary`) answers `initial` (that version
 *   by default) until the case sets another with `answer(outcome)` (a
 *   version, a below-floor version, a failure); its `recordStartupError`
 *   writes into the harness's `startup-errors.log` (`startupErrors()`) and
 *   its stop's exit codes are recorded (`stops`, the server is not stopped).
 *   It answers its `resolves`, `stops`, `nextDueAt()` (its next timed
 *   re-check's due time, none once a stop ended it) and `pendingTimers()`
 *   (its timers among the clock's pending ones: its interval, and a call's
 *   time limit while one runs). Its 120 s timer is pending for as long as it
 *   is installed, so a case counting pending timers subtracts it; `cleanup()`
 *   disposes it before it counts. It throws when a re-check is already
 *   installed.
 * - The configured-persona query (b.jg5 SRJ-114): installed in the session
 *   manager beside the latch (`setConfiguredPersonaQuery`), as `main()`
 *   installs it, over the live applied set: a key counts as configured while
 *   it is applied, so a `provenance_conflict` note on a configured persona's
 *   own row latches it through `latch`, and a key outside the harness's
 *   personas, or one `remove(key)` dropped, counts as not configured.
 * - `retiredKeys` (b.jg5 SRJ-807): the one retired-key store, read at build
 *   over `stateDir` as `main()`'s start read reads it
 *   (`readRetiredKeysAtStart`, its lines to `console.error`, so to `errors`)
 *   and installed in the session manager right after the configured-persona
 *   query (`setRetiredKeyStore`), as `main()` installs it; so any key's own
 *   row read live other than `pending` while its mark is set clears its
 *   entry. The store reads the record once, so a case seeds it through
 *   `options.retiredKeys` (the entries by key, given the persona keys),
 *   which the harness writes with `writeRetiredKeysRecord` into `stateDir`
 *   before the load; with none there is no file. Its writes go through the
 *   production durable writer, each recorded in `retiredKeyWrites` (path,
 *   and whether it went through); `failRetiredKeyWrites(count?)` refuses the
 *   next `count` (1 by default) with `RECOVERY_RETIRED_KEY_WRITE_FAILURE_CODE`
 *   before they touch the file. A record the store refuses to read fails the
 *   build, with everything it installed put back.
 *   `retireKey(key, options?)` (b.jg5 SRJ-805, SRJ-806) records a key after
 *   the build through the installed store's own primitives, never by writing
 *   the file behind it: one `record` batch with the key and its cause
 *   (`removed` by default), then, with `options.mark`, one `mark`; it throws
 *   unless each went through (written, or unchanged for a key already so), so
 *   a case that wants a failing write calls `failRetiredKeyWrites` after it.
 *   Its writes show in `retiredKeyWrites` like any other.
 *   `retiredEntry(key)` reads the key's entry back through the store's
 *   queries: `{ recorded, marked, entry }` (`isRecorded`, `isMarked`, a mark
 *   held in memory after a failed write included, and `entry`).
 * - `oldLifeHolds` (b.jg5 SRJ-809): the one old-life hold set, built right
 *   after the retired-key store as `main()` builds it
 *   (`createOldLifeHoldSet`, its lines to `console.error`, so to `errors`,
 *   directories compared by the production real-path resolver) and
 *   installed in the session manager right after the store
 *   (`setOldLifeHolds`), as `main()` installs it before the start sweep; so
 *   every row read the session manager makes ends or re-points a hold, the
 *   start sweep begins its holds there, and a teardown or sweep kill whose
 *   tries decided the ordinary kill-failure alert marks one. A restart is a
 *   new harness: holds live in memory, so it starts with none. The view is
 *   read-only: `snapshot()` (every hold, in begin order: instance id, old
 *   key, directory and its real path, cause, kill-failed mark, waiting
 *   personas), `holdOf(id)`, `holdsOnDirectory(dir)`,
 *   `holdsWaitedOnBy(persona)` and `waitsOnKillFailed(persona)`.
 *   `beginOldLifeHold(begin)` is apply step 1's begin, the one member of the
 *   set `main()` hands the reload controller (`ReloadControllerDeps.oldLifeHolds`);
 *   a case that needs a hold no sweep began (an apply step 1 hold on
 *   `cscb_<key>` at the old declaration's directory) begins it there. The
 *   start sweep is `startSweep(isShuttingDown?)`: `reconcileOrphans` over the
 *   applied configuration (the live applied set) on `killRetryClock`, driven
 *   with `drive`, its shutdown query the harness's shutting-down flag
 *   (`shutdown()`) as `main()` binds it unless the case passes another; its
 *   rows are the stub's `list` answer (`script({ listResult })`).
 * - The old-life wait (b.jg5 SRJ-811, SRJ-812, SRJ-1512), composed as
 *   `main()` composes it: the registry below takes `runOutsideAttempt`
 *   (`runOutsideAttempts`), so a wait runs outside every attempt, and the
 *   wait's bindings (`setOldLifeWaitBindings`) are installed right after the
 *   kill-failure alerts: each waiting persona's arm through the trigger sink
 *   (in `triggers`, kind `held-for-old-life`, then armed on the controller),
 *   the sequence clock (its waits and its kill's waits between tries are
 *   sequence timers, so `driveSequence` moves the clock to them), `lines` as
 *   its sequence log, the live applied set, the harness's kill-failure
 *   alerts, the startup-errors recorder over `stateDir`, and the wait's own
 *   unclassified-error episodes (`createOldLifeWaitUnclassifiedErrors`, on
 *   the harness clock at E6's alert threshold in effect, keyed by the held
 *   instance id; their lines to `errors`, their alert the log-only
 *   `persona-unclassified-error` entry in `startupErrors()`; read with
 *   `oldLifeWaitUnclassifiedOpen(id)`; closed by `shutdown()` and
 *   `cleanup()`). The wait's own end lines and kill-try lines go to
 *   `console.error` (`errors`).
 *   `startOldLifeWait(id)` starts the wait on a held id through the session
 *   manager's ensure entry (`ensureOldLifeWait`), throwing unless it
 *   answered `started`, and answers the outcome promise (its end handler has
 *   run once it resolves); `runOldLifeWait(id)` starts one and drives it to
 *   its end; `oldLifeWaitRunning(id)` is the registry's no-launch query and
 *   `oldLifeWaitSettled(id)` its settle query by instance id
 *   (`_whenSettledOn`), both read-only. A case holds the wait at a run with
 *   the stub's `holdFindMissing`, as for a sequence. The waiting personas are
 *   computed from the applied configuration (a persona whose working
 *   directory is the held directory, and the persona whose own `cscb_<key>`
 *   is held). `shutdown()`'s close stops every wait.
 * - What a hold refuses (b.jg5 SRJ-810, SRJ-1502, SRJ-1505), composed as
 *   `main()` composes it. Every launch (`launch(key)`, the restart path's
 *   `launchSession`, a live-row sequence's step-6 launch) meets the session
 *   manager's old-life gate in the real `spawnForPersona`: a persona whose
 *   working directory a hold other than one on its own row holds is
 *   recorded as waiting on it, the hold's wait is started unless one runs,
 *   its timer is armed (`held-for-old-life`, in `triggers`) and the launch
 *   answers `sequence-waiting` with no call; the restart work's old-life
 *   hook (above) is the same step. The reconnect guard and the reconnect
 *   adapter's held-own-row branch are the production code's own. The hold
 *   set's end observer that retries the waiting personas
 *   (`createOldLifeHoldEndRetry`) is registered after the session manager's
 *   own, as `main()` registers it: its run-now is the controller's
 *   `runNow(key, { kind: UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD },
 *   UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED)` and its applied query the live
 *   applied set, so once a hold ends each persona recorded as waiting on it,
 *   still applied and not latched, is retried at once, at the clock time of
 *   the end, with no clock advance (the retry's run is awaited by
 *   `settle()`). Each run-now is recorded in `holdEndRetries` (`{ key, at,
 *   result }`). `admitSession(rootsPath)` is the admission driver: one
 *   `decideSessionAdmission` call as `handleInitialized` makes it, over the
 *   applied personas, the real up predicate (`createPersonaUpPredicate` over
 *   the same serving connection, bring-up outcome and live applied set as the
 *   relaunch gate), the not-up description `handleInitialized` passes
 *   (`describePersonaNotUp` of the persona's bring-up state, a persona
 *   `setUp(key, false)` set down being `retrying`), its line to
 *   `console.error` (`errors`) and the session
 *   manager's held-directory query (`oldLifeHeldDirectory`) over the one hold
 *   set; it answers the admission (`held`, `admitted`, `not-up`,
 *   `unmatched`) and registers nothing.
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
 *   exists, so a row the stub answers in it is the persona's own. A launch
 *   that returns success arms the persona's retry timer in pending-only mode
 *   (b.jg5 SRJ-301, SRJ-409: through the trigger sink, so one `triggers`
 *   entry with `UNAVAILABLE_RETRY_CAUSE_PENDING_ROW`, unless the persona is
 *   latched or `options.triggerSink` is false) and starts its dialog
 *   approver on its own (b.jg5 SRJ-401): `launch(key)` resolves before the
 *   approver's first lap, which comes once the launch has settled. Every
 *   other successful launch (the restart path's, a sequence's step-6 reuse,
 *   a retry's hand-off run) arms the same way.
 * - The dialog approver runs on the harness clock (`_setApproverClock`): its
 *   sleeps between laps (`DIALOG_POLL_INTERVAL_MS`) and its cap timer are
 *   harness-clock timers, so it makes no lap until the clock moves. Its cap
 *   is `installStubSpawnPath`'s 200 ms, below the pace, so it makes one lap
 *   and stops at the cap once the clock reaches it; `options.approverCapMs`
 *   sets another (a case that needs a second lap passes one above
 *   `DIALOG_POLL_INTERVAL_MS`). `approverRunning(key)` is the session
 *   manager's `isDialogApproverRunning(key)`, read-only. So a case launches
 *   P, calls `settle()` (the first lap's calls are then made, and P's
 *   approver sleeps until its next lap), and holds P there until it moves the
 *   clock: `advance(ms)` fires the approver's timers due by then, each lap
 *   running before the next firing. `runApproverToStop(key, maxSteps?)` drives
 *   P's approver to its stop: it settles, then advances the clock to the
 *   approver's next timer, until the approver no longer runs (throwing after
 *   `maxSteps` timers, 1000 by default, or when it runs with no timer, held
 *   in a call), and resolves with its outcome (`ApproverOutcome`, through
 *   `_whenDialogApproverStopped`); other timers due on the way fire too, as in
 *   `advance`. A case that counts calls after a launch settles first, or
 *   drives the approver to its stop.
 * - The bounded retry of a kill (b.jg5 SRJ-702, `src/kill-retry.ts`) runs
 *   on the harness clock, bound as `main()` binds it: the restart path's kill
 *   adapter gets the kill-retry clock (its kill is one try, seeded with the
 *   run's `dead` reading), the live-row sequence's kills take the sequence
 *   clock through the session manager's dependency builder (the collision
 *   ladder makes no kill; a live row's kills are the sequence's), and the
 *   kill retry's
 *   keep-going query (`setPersonaKillKeepGoingQuery`, removed by
 *   `cleanup()`) is the up predicate over the same serving connection,
 *   bring-up outcome (`setUp`) and live applied set as the relaunch gate,
 *   with the harness's shutting-down flag. Each try's read between tries is
 *   the session manager's shared own-row `status` read, the one `main()`
 *   uses, so it shows as a stub `status` of the persona's instance. The
 *   kill-retry clock (`killRetryClock`, which a case also hands the start
 *   sweep as `reconcileOrphans(config, h.killRetryClock)`, as `main()` hands
 *   it the production clock) is the harness clock with each 2 s wait
 *   between tries tracked, so `advance(ms)` fires a wait like every other
 *   timer, and
 *   `drive(work)` awaits `work` (a `launch(key)`, a direct restart call)
 *   while moving the clock to each pending wait's end as it is set (every
 *   other timer due by then fires too, as in `advance`), in 1 ms real-time
 *   steps for the spawn path's own file I/O, bounded by `options.settleMs`;
 *   it throws when `work` is still unsettled at the bound with no wait
 *   pending. A wait still pending at `cleanup()` fails it, as any timer does.
 * - The live-row sequence (b.jg5 SRJ-705, SRJ-706, SRJ-717;
 *   `src/live-row-sequence.ts`): its dependencies (`sequenceDeps`) come
 *   from the session manager's one builder (`buildLiveRowSequenceDeps`),
 *   given what `main()` gives it: the harness's kill-failure alerts (over
 *   `episodes`), the trigger sink above as the retry arm (so each end's arm
 *   is recorded in `triggers` and armed on the controller), the live applied
 *   set, `lines` as its log, and the sequence clock: the harness clock with
 *   each sequence timer tracked (the step-2 wait, the run spacing, the
 *   step-4 pause and each wait between a kill's tries). Step 6 runs as
 *   production runs it, through the stub: the `resume` leg and the session
 *   manager's reuse spawn (`reuseSpawnForPersona`, b.jg5 SRJ-112, SRJ-708),
 *   a stub `spawn` of the persona's id carrying the reuse flag, whose
 *   success runs the after-launch step (the `pre_trust` line and the dialog
 *   approver on the harness clock). `reuseSpawns()` is a read-only view of
 *   the reuse spawns: the stub's recorded `spawn` calls that carry the reuse
 *   field (`reuse_finished`), in order (a spawn held by `holdSpawns` is not
 *   in the stub's log, so not in the view). The registry (b.jg5 SRJ-706)
 *   is built and installed as `main()` builds and installs it:
 *   `createLiveRowSequenceRegistry` over those dependencies with
 *   production's attempt runner (`runDetachedRecoveryAttempt`: each sequence
 *   in its own recovery attempt for its persona, detached from its
 *   starter's), installed in the session manager
 *   (`setLiveRowSequenceRegistry`) after the latch (below) and before any
 *   launch, so a latch of a persona stops its sequence through the set
 *   observer the installer registers. `sequenceSettled(key)` is the
 *   registry's test-only settle query (`_whenSettled`): the running
 *   sequence's outcome once it settles, else the last one's.
 *   `sequenceRequest(key, request)` is the start request for persona `key`,
 *   a configured one or one `remove(key)` dropped, with the request's seed
 *   (the state last read), entry step (step 1 by default),
 *   keep-conversation flag and retired-key flag (both false by default),
 *   launch flag (true by default; false is the no-launch form), alert
 *   context (`recovery` by default) and, when given, the retired-key reading
 *   at the attempt's start (`retiredAtStart`, b.jg5 SRJ-806; absent by
 *   default, so the start entry fills it); a case that wants the start entry's own
 *   answer hands it to `startLiveRowSequence`. `startSequence(key, request)`
 *   starts one sequence (steps 1 to 6) through the session manager's start
 *   entry and resolves at once, before the sequence's first call, throwing
 *   unless the entry answered `started`; it answers the outcome promise (the
 *   registry's `_whenSettled`) and a stop through the session manager's stop
 *   entry (`stopLiveRowSequence`: the signal set before it returns,
 *   resolving once the sequence has settled). `sequenceRunning(key)` is the
 *   session manager's running query, read-only: true from the start's answer
 *   until the sequence settles, its step-6 launch included. While it is true
 *   the sequence is in "blocks a retry" and so in "in flight for P" (below),
 *   the restart deps' running query answers true, and every launch path for
 *   the persona (`launch(key)`, the restart path's `launchSession`) answers
 *   `sequence-waiting` with no call.
 *   `runSequence(key, request)` starts one and drives it to its end;
 *   `driveSequence(work)` awaits `work` while moving the clock to each
 *   pending sequence timer as it is set (every other timer due by then fires
 *   too, as in `advance`), in 1 ms real-time steps for the launch's own file
 *   I/O, bounded by `options.settleMs` steps that find no sequence timer
 *   pending; it throws when `work` is still unsettled then. The exported
 *   `runSequenceStoppedAtKill(h, key, step, answer, reason)` runs one whose
 *   step-1 or step-4 kill gets its last try's answer (one of
 *   `LATE_KILL_ANSWERS`) after its stop was set. The exported
 *   `scriptLiveRowElsewhere(h, key, script)` scripts a launch of the persona
 *   to meet its own row read live in another directory, a collision ladder
 *   replacement site (b.jg5 SRJ-707) whose launch starts the persona's
 *   sequence and answers `sequence-waiting`, every later `get` reading the
 *   row `ended`; `launchThroughSequence(h, key)` makes that launch and drives
 *   the sequence it started to its end.
 * - `recheckAnswers(version)`: installs agent-director's version re-check
 *   (b.jg5 SRJ-204; `installAdVersionRecheck`, on its own fake clock, its
 *   lines to `lines`) with its `resolveSystemBinary` answering `version`
 *   (`makeStubResolveSystemBinary`), so an `ErrInvalidFlags` answer's one
 *   immediate re-check reads it: an older version decides that the server
 *   stops. It answers the binary resolves the re-check made and the exit
 *   codes its stop was asked for; `cleanup()` removes the install. It
 *   resets the re-check module first, which drops every version-changed
 *   listener, so it registers the harness's again.
 * - `settle()`: awaits every configured persona's launch in flight
 *   (`whenLaunchSettled`), every retry run in flight (`whenRunSettled`),
 *   with its re-arm or stop, and every retry at once in flight
 *   (`retriesAtOnce`), and then until every running dialog approver
 *   waits for its next lap on the harness clock or has stopped (each holds
 *   its cap timer and, while it sleeps, its sleep timer, so all sleep when
 *   their pending timers number twice the running approvers). The spawn path
 *   does its own file I/O in real event-loop turns, so this is the one
 *   real-time wait: 1 ms steps, bounded by `options.settleMs`, and it throws
 *   when a launch or a run is still in flight at the bound, or an approver
 *   neither sleeps nor has stopped (one held in a call). A retry whose
 *   launch goes on past a spawn needs it before the clock moves on.
 * - `loseMessage(key)`, the lost-message driver (b.jg5 SRJ-1011): one Slack
 *   message, a human's in persona `key`'s first channel, handed to the real
 *   `createPersonaRouting` with no session registered for the persona, so it
 *   takes the no-session branch and is lost. The routing is built at the
 *   first call, bound as `main()` binds it: the up predicate is the real
 *   `createPersonaUpPredicate` over the same serving connection, bring-up
 *   outcome (`setUp`) and live applied set as the relaunch gate; `isLatched`
 *   is `latch`'s latched query; `isTmuxUnresponsive` is the condition's
 *   `holds`; `isRetryArmed` is the controller's `isArmed`, exactly true
 *   (b.jg5 SRJ-1011 as amended: state 5 applies only while P's retry timer
 *   is armed, and never at the restart cap, which the routing reads from the
 *   real backoff state); `isLaunchOrApproverRunning` is the session manager's
 *   `isLaunchInFlight` or `isDialogApproverRunning` (the approver runs after
 *   its launch call returned, SRJ-401); the
 *   restart guards and `scheduleRestart` are the restart module the harness
 *   initialised, and the outage flags are the outage state's. The read gate's
 *   in-flight member (`isWorkInFlight`) is "in flight for P" (as `main()`'s
 *   `isPersonaWorkInFlight`: "blocks a retry", which the full-mode retry
 *   action receives, or a running dialog approver), and the one row read
 *   (`readRowLiveness`) is the harness's liveness adapter, the restart deps'
 *   default `isSessionAlive` (b.jg5 SRJ-1011, SRJ-115); a
 *   `restartDeps.isSessionAlive` replacement does not reach it. So when states
 *   1 to 5 are clear and nothing is in flight for the persona, the message
 *   makes one stub `status` call (in `calls` and in `stub.calls.status`),
 *   outside any launch or recovery attempt, answered by the stub's `status`
 *   knobs (`script({ statusResult })`, `statusQueue`, `statusError` or
 *   `statusFn`; e.g. `cannedStatusResult({ state: 'pending' })` for state 6,
 *   a row that shows the stub's default launch start, so it latches no one);
 *   while a launch's spawn is held open (`holdSpawns(stub.client)` and a
 *   `launch(key)` not yet settled) a launch is in flight, and while P's
 *   dialog approver runs (after a launch, until it stops) the approver is,
 *   so the message reports `session-starting` and no read is made.
 *   Its `armRetryTimerIfMissing` (b.jg5 SRJ-311) is bound as `main()` binds
 *   it: nothing while the harness is shutting down (`shutdown()`), else the
 *   server's one check (`armMissingTmuxUnavailableRetry`) over the harness's
 *   own holders, as `main()`'s `tmuxUnavailableRetryDeps`: the outage
 *   state's `tmux-unavailable` flag, the controller's `isArmed`, `latch`'s
 *   latched query, "in flight for P", and an arm straight to the
 *   controller with `UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT` (not through the
 *   trigger sink, so not in `triggers`), its one line to `console.error`
 *   (`errors`). So a message lost with the persona's `tmux-unavailable`
 *   flag raised, no timer armed, below the restart cap, not latched and
 *   nothing in flight arms its timer before the state is decided, and so
 *   reports `not-answering`, with no restart asked for.
 *   Its `isKillFailed` (b.jg5 SRJ-1011 state 4, SRJ-812) is bound as
 *   `main()` binds it: the harness's kill-failure alerts' "episode open"
 *   query (`killFailureOpen`, below) or the session manager's
 *   `waitsOnKillFailedHold` (P waits on an old-life hold marked kill-failed),
 *   read at call time, so a message lost while P's kill-failure episode is
 *   open, or while P waits on a hold whose old key's kill failed, reports
 *   `kill-failed`.
 *   Its `isSequenceOrWaitRunning` (b.jg5 SRJ-706, SRJ-811, SRJ-1011) is the
 *   session manager's `isSequenceOrOldLifeWaitRunning`, read at call time as
 *   `main()` binds it, so a message lost while P's live-row sequence, or an
 *   old-life wait step for a hold P waits on, runs reports `restarting`, and
 *   since either is in "in flight for P" no row read is made; state 6's
 *   `isLaunchOrApproverRunning` does not include them.
 *   Its `isHeldOnInvalidFlags` (b.jg5 SRJ-1011 state 3, SRJ-207) is the
 *   harness's hold's held query, read at call time as `main()` binds it, so
 *   a message lost while P is held reports `cannot-launch`.
 *   Each persona has its own Slack stub (`slack(key)`, leak marker on) as its
 *   client and bot identity; the routing's `notify` records each notice in
 *   `lostMessageNotices` (`{ key, text }`, the body without the persona
 *   prefix) and hands it to the real persona notifier (`makeNotifierStack`,
 *   its destination hold on the harness clock), which posts it with the
 *   persona's own stub. The routing's lines go to `lines`. It throws when a
 *   session is registered for the persona, or when the message raised no
 *   notice, or one for another persona. It resolves, once the notice is
 *   raised, with `LostMessageOutcome`: the state the notice reports
 *   (`stateOf`, from the routing harness), the notice body, whether the
 *   routing asked the restart module for the persona's restart
 *   (`restartRequested`: `scheduleRestart` asks the restart deps' latched
 *   query first, before any other gate, and the harness records every such
 *   ask, so a request is seen even for a latched persona or with the delay
 *   0, where none is armed), whether a restart of it is pending or running
 *   afterwards (`isRestartPendingOrActive`), and the stub calls the message
 *   made (by verb, as `callCountsSince`). `restartAsks` holds every such ask,
 *   by key, in order, a direct `scheduleRestart` call's included.
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
 *   `rewriteAdSettings(input)` writes the file again and lets the installed
 *   reader read it, as its next 120 s tick's read would.
 * - `config` and `keys`: a resolved configuration of `options.personas`
 *   (two personas by default) with `session_restart_delay` and
 *   `health_check_interval` from the options, both 0 by default (SRJ-304),
 *   and `resume_enabled` from `options.resumeEnabled` when given (the
 *   configuration's default otherwise). Every persona is applied at first.
 * - `advance(ms)`: moves the clock `ms` forward one due time at a time.
 *   Before and after each firing it awaits every in-flight retry run
 *   (`whenRunSettled`) and then every running dialog approver's next sleep,
 *   each bounded by `options.settleFlushes` clock flushes, so a re-arm
 *   measured from a run's end lands exactly, an approver's lap runs at the
 *   time its sleep ended, and a run or approver the test holds open does
 *   not stall the step. Resolves with the number of timers fired.
 * - `errors`: every `console.error` call while the harness is live (the
 *   session manager's and the restart module's lines), its arguments joined
 *   with spaces, in order. `console.error` is replaced at build and put back
 *   by `cleanup()`.
 * - `captured()`: everything captured, for `assertNoLeak`: the lines, the
 *   `console.error` lines, the four notice lists, the startup-errors
 *   entries, the attempts, the triggers, the condition ends, the outage
 *   clears, the stops, the latch events, the stub's recorded spawn calls,
 *   the retries at once, the hold-end retries, the driver's Slack calls and
 *   the state directory as
 *   a written file.
 * - `cleanup()`: first stops and forgets every dialog approver
 *   (`_resetDialogApprovers`, silently: none makes a call after the one in
 *   progress) and clears the timers they left on the harness clock, then
 *   stops every retry timer (`stopAll`), forgets every
 *   episode and clears every count (`episodes.forgetAll()`, which cancels
 *   every alert check; so no slow-recovery count or episode is left behind,
 *   and two harnesses built one after the other, each with its own episodes
 *   and tracker, share none) and
 *   cancels every notice the driver's destination hold holds, then
 *   drops the driver's routing and undoes every
 *   install and reset the harness made (`console.error`, the restart module's state and the
 *   failure counter, backoff and cap latch, the outage state and its trigger sink, the session notifier,
 *   the session manager's latch install and the latch's set observers, the
 *   hold's install and its set reaction, the version-changed listener,
 *   the kill-failure alerts' install,
 *   the kill retry's keep-going query,
 *   the configured-persona query (`_resetConfiguredPersonaQuery`), so two
 *   harnesses built one after the other share no query,
 *   the retired-key store's install (`_resetRetiredKeyStore`), so none is
 *   left installed after it, the hold set's end-retry observer (removed
 *   first, so no hold a later step ends retries anyone) and the old-life
 *   hold set's install (`_resetOldLifeHolds`), so no hold outlives the
 *   harness,
 *   the stub spawn path and client with every launch still in flight and the
 *   approver's clock and cap, the session manager's clock when
 *   `options.harnessNow` set it (`_resetNow`), the
 *   findMissing memo, the tmux seams, the settings install, the version
 *   re-check's install when `recheckAnswers` or `versionRecheck` made one
 *   (disposed first, before the pending timers are counted), the sequence
 *   registry's install (`_resetLiveRowSequenceRegistry`), the old-life wait
 *   bindings (`_resetOldLifeWaitBindings`), `SLACK_STATE_DIR`) and
 *   removes the temporary directory. The registry is closed (every live-row
 *   sequence and old-life wait still running stopped with the shutdown
 *   reason) after the pending timers, the running sequences and the running
 *   waits are counted. It
 *   throws, after undoing everything, when a timer is still pending on the
 *   clock (a sequence or wait timer included, which the message counts
 *   apart), a live-row sequence or an old-life wait still runs (a case
 *   settles every sequence and wait it starts, releasing any call it
 *   holds), or a
 *   persona is still armed: the episodes run on the harness clock, so a timer
 *   they armed and left pending fails it too. Retry timers are the one
 *   exception, by design: `stopAll` runs before the count, so a persona's
 *   armed retry timer (in either mode) is stopped, not counted. That covers
 *   the pending-only timer every successful launch leaves armed (b.jg5
 *   SRJ-301, SRJ-409), which a case need not stop; a case asserts it with
 *   `expectPendingOnlyWatch(h, key)` (or reads `controller.view(key)`, whose
 *   `mode` and `causes` are the timer's mode and recorded cause kinds), and
 *   one that wants it gone mid-case stops it with `controller.stop(key,
 *   reason)` (shown in `stops`). Every other pending timer (an approver's
 *   timer left by a case, a kill's wait, a sequence or old-life wait timer,
 *   an episode's alert check) still fails it.
 *
 * Shared case helpers, each over a harness: `personaOf` (a configured
 * persona), `personaRow` (a persona's own row as a `get` reads it, with
 * overrides), the retired-key store's clear lines (b.jg5 SRJ-807; src
 * exports no builder for them): `retiredEntryClearedLine` and
 * `retiredEntryClearFailedLine` (a write `failRetiredKeyWrites` refused), each
 * for the record's path, the key, the state read and the read's site, and
 * `retiredKeyLinesIn` (the store's lines among some lines), `pastSampleGrace` (the clock moved to G past the stub's sample
 * launch start, so a `pending` row is waited on no longer), `unavailableAt`
 * (an UNAVAILABLE answer of a verb), `expectUntouched` (a persona left
 * alone: no trigger, timer, notice, outage flag or call),
 * `expectPendingOnlyWatch` (a persona's retry timer armed and waiting in
 * pending-only mode with the pending-row cause, and its pending-row trigger
 * recorded), `expectLostMessageReports` (lose one message through the driver
 * and assert its state, its stub calls, by default none in states 1 to 5 and
 * one `status` of the persona's instance after them, and no restart asked
 * for or pending unless `restartRequested`; resolves with the outcome), `collided` (the stub answers of a launch whose optimistic spawn
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
 * persona's next retry and settle it), `reuseSpawnOf` (persona `key`'s reuse
 * spawn as the stub records it, for a comparison: `cscb_<key>` with the reuse
 * flag and the persona's `extra_env`), `startSequenceHeldAtRun` (start a
 * persona's live-row sequence and resolve once its next `find-missing` run
 * is held by the stub's `holdFindMissing`), `ownRowsLiveThenMissing` (each
 * persona's own row live at its first `get`, `missing` after), `holdSequenceReuse` (hold a
 * persona's reuse spawn open at the stub, so a sequence's step-6 launch
 * stays in flight),
 * `rowReadsUntilSpawn` (each row reads a
 * state until its spawn resolves, then `waiting`; a `pending` row shows the
 * stub's default launch start unless the case asks for none; it returns the
 * `statusFn` it scripts), `scriptTimedLaunch` (b.jg5 SRJ-407, on a harness
 * built with `harnessNow`: persona
 * `key`'s next `spawn` or `resume` takes a given time on the harness clock
 * and ends in either launch-timeout form, `LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT`
 * or `LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE`, or `TIMED_LAUNCH_SUCCESS`;
 * from its end on, the persona's `get` reads its row with the launch start
 * placed against the call's window, `TimedLaunchStart`: on either bound,
 * inside, before, after or none; its handle gives the error, the window, the
 * launch start, the row, and a `status` answer with the same launch start
 * for the case's own `statusFn`), and the condition's log
 * lines: `conditionLinePrefix`, `conditionLines`, `conditionStartedLines`,
 * `conditionEndedLines` and the line builders `conditionOnsetLine`,
 * `conditionAlertLine`, `conditionEndedLine`, `conditionRecoveryLine` and
 * `conditionSilentEndLine`; the unclassified-error episodes' log lines:
 * `unclassifiedLinePrefix`, `unclassifiedLines`, `unclassifiedStartedLines`
 * and the line builders `unclassifiedStartedLine`, `unclassifiedEndedLine`
 * (for any end reason), `unclassifiedPostedLine` and
 * `unclassifiedLoggedLine`; `adConfigMalformedRaiseLines`, the outage
 * state's `ad-config-malformed` raise lines; and the kill-failure alert's
 * texts (b.jg5 SRJ-704, SRJ-1007), each built with
 * `src/kill-failure-alert.ts`'s builders for the persona's own session and
 * instance id from the thrown values' raw descriptions:
 * `ordinaryAlertContent`, `survivorAlertContent`, `killFailureNotice` (the
 * destination post as `episodeNotices` holds it), `killFailureRecoveryEntry`
 * (the not-configured route's entry, context `recovery` unless given), with
 * `startupEntriesOf` (one class's entries without their timestamp),
 * `startupEntries` (every entry as its class and text, in order),
 * `killFailureLines` (the alerts' own lines) and the alerts' line builders
 * (context `recovery`; `killFailurePostedLine` takes another):
 * `killFailureEndedLine`, `killFailurePostedLine`,
 * `killFailureHeldLine`, `killFailureLoggedLine`, `killFailureNotRaisedLine`
 * (a stopped retry's one line, b.jg5 SRJ-702, naming the stop's cause it is
 * given: `liveRowStopCauseText` for the live-row sequence's own stop,
 * `PERSONA_KILL_STOP_CAUSE_SHUTDOWN` or `PERSONA_KILL_STOP_CAUSE_NOT_UP` for
 * what the keep-going query told, `PERSONA_KILL_STOP_CAUSE_GENERIC` when it
 * could not tell, or `PERSONA_KILL_STOP_CAUSE_RECHECK`, all from
 * `src/session-manager.ts`; built by `killFailureStoppedRetryText`), `killFailureStoppedEntry` (its
 * `persona-kill-failed` entry, no alert text) and
 * `killFailureStoppedEntryLine`.
 *
 * Pending-only mode is armed by production paths on the harness (b.jg5
 * SRJ-301, SRJ-409, SRJ-411): a successful launch, a launch's
 * `ErrTmuxSessionCreate`, the collision ladder's `pending` branch, the
 * restart path's `pending` deferral and a pending-only retry's read-and-step,
 * each through the trigger sink except the retry's own re-arm; a case may
 * still arm it directly (`controller.armPendingOnly`).
 *
 * Launch starts (b.jg5 SRJ-513): every `pending` row the harness scripts
 * (`rowReadsUntilSpawn`, and a case's own `cannedStatusResult`,
 * `cannedGetResult` or `cannedListRow` row, `collided`'s included) carries
 * the stub's sample launch start (`SAMPLE_LAUNCH_START_DEFAULT`) unless the
 * case asks for none (`launch_started_at: SAMPLE_LAUNCH_START_NONE` or
 * `null`, or `rowReadsUntilSpawn`'s `launchStartedAt` option), since a
 * configured persona's own `pending` row with no launch start latches it.
 * Rows in any other state carry none.
 *
 * Isolation: no top-level `mock.module()`, no real HOME, `~/.agent-director`,
 * tmux, child process or Slack client (the driver's clients are stubs). The
 * retry timer, the dialog approver, the waits between a kill's tries and the
 * live-row sequence's waits run on the fake clock only; the one real-time
 * wait is the bounded poll for the spawn path's own file I/O (`settle()`'s,
 * and `drive`'s and `driveSequence`'s between their timers). A retry
 * never arms the restart module's own (real) timer: its entry bypasses it. Every file
 * sits under one `mkdtempSync` directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebClient } from '@slack/web-api'
import type { Client, SpawnResult } from 'agent-director'

import type { Phase1SpawnParams, Phase1StatusResult } from '../../src/ad-phase1-types.ts'

import {
  adAlertThresholdMsInEffect,
  adGraceMsInEffect,
  adSettingsInEffect,
  installAdSettings,
  resetAdSettingsForTests,
  type AdSettingsInEffect,
  type NeverEarlyWaitClock,
} from '../../src/ad-settings.ts'
import { _resetBackoffState, isAtCap } from '../../src/backoff.ts'
import { replySettingsOf, type Persona, type PersonaConfig } from '../../src/config.ts'
import {
  bindConflictLatchHolds,
  bindConflictNotice,
  createConflictLatch,
  type ConflictLatch,
  type ConflictLatchRecord,
  type ConflictLatchSetOutcome,
  type ConflictNoticeEpisodes,
} from '../../src/conflict-latch.ts'
import { LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING, LIVENESS_LIVE } from '../../src/liveness-reading.ts'
import {
  AD_ERROR_CLASS_UNAVAILABLE,
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT,
  classifyAdError,
  describeAdErrorClassification,
  killFailedDescriptionOf,
  type LaunchTimeoutForm,
} from '../../src/ad-error-class.ts'
import {
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  PERSONA_KILL_FAILED_LABEL,
  killFailureAlertEntryText,
  killFailureAlertText,
  type KillFailureAlertContent,
  type KillFailureAlertContext,
  type KillFailureAlertVersion,
  type KillFailureClosing,
} from '../../src/kill-failure-alert.ts'
import { LOST_MESSAGE_STATES, STATE_WORDING, type LostMessageState } from '../../src/lost-message.ts'
import { parseLaunchStart, type LaunchCallWindow } from '../../src/pending-row.ts'
import { _resetOutageState, clearOutageFlag, getOutageFlags, initOutageState, resetAllToHealthy, type OutageClass } from '../../src/outage-state.ts'
import type { PersonaLifecycleDeps } from '../../src/persona-lifecycle.ts'
import type { PersonaConnectionStatus } from '../../src/persona-connections.ts'
import {
  createKillFailureAlerts,
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  createUnclassifiedErrorEpisodes,
  killFailureStoppedRetryText,
  PERSONA_EPISODE_KIND_KILL_FAILURE,
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  TMUX_UNRESPONSIVE_END_LATCHED,
  TMUX_UNRESPONSIVE_END_RETRY,
  TMUX_UNRESPONSIVE_END_TEXT,
  TMUX_UNRESPONSIVE_END_TICK,
  UNCLASSIFIED_ERROR_END_CAPPED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  type KillFailureEndReason,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
  type TmuxUnresponsiveEndReason,
  type TmuxUnresponsiveEndResult,
  type UnclassifiedErrorEndReason,
} from '../../src/persona-episodes.ts'
import { PERSONA_KEY_RE, personaInstanceId, personaSpawnEnv, personaTmuxSessionName } from '../../src/persona-identity.ts'
import { createPersonaRouting, type PersonaRouting } from '../../src/persona-routing.ts'
import { createPersonaSerializer, type PersonaSerializer } from '../../src/persona-serializer.ts'
import { createPersonaRelaunchGate, createPersonaUpPredicate, type PersonaUpQuery } from '../../src/persona-start.ts'
import { describePersonaNotUp } from '../../src/persona-bringup-controller.ts'
import type { PersonaDestinationHold } from '../../src/persona-destination-hold.ts'
import { createNameResolver, type NameResolverWebClient } from '../../src/message-archive.ts'
import { KILL_RETRY_ALERT_ORDINARY, KILL_RETRY_TRIES, type KillRetryAlert, type KillRetryClock } from '../../src/kill-retry.ts'
import {
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_SEQUENCE_STEP3_RUNS,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_STOP_TEARDOWN,
  createLiveRowSequenceRegistry,
  type LiveRowSequenceDeps,
  type LiveRowSequenceEntryStep,
  type LiveRowSequenceOutcome,
  type LiveRowSequenceRegistry,
  type LiveRowSequenceRequest,
  type LiveRowSequenceStopReason,
  type RetiredKeyAttemptStart,
} from '../../src/live-row-sequence.ts'
import { decideSessionAdmission, getSessionByPersona, type SessionAdmission } from '../../src/registry.ts'
import {
  _resetRestartState,
  initRestart,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  runRestartRetry,
  type RestartDeps,
  type RestartRetryOutcome,
} from '../../src/restart.ts'
import {
  _buildIsSessionAliveAdapter,
  _buildKillSessionAdapter,
  _buildReconnectSessionAdapter,
  armMissingTmuxUnavailableRetry,
  deferPendingRow,
  type TmuxUnavailableRetryDeps,
} from '../../src/server.ts'
import {
  APPROVER_STOP_TEARDOWN,
  DIALOG_POLL_INTERVAL_MS,
  _resetConfiguredPersonaQuery,
  _resetDialogApprovers,
  _resetOldLifeHolds,
  _resetOldLifeWaitBindings,
  createOldLifeWaitUnclassifiedErrors,
  _resetRetiredKeyStore,
  _resetFindMissingMemo,
  _resetInvalidFlagsHold,
  _resetLiveRowSequenceRegistry,
  _resetNow,
  _setApproverClock,
  _setNow,
  _setDialogReadyTimeoutMs,
  _whenDialogApproverStopped,
  buildLiveRowSequenceDeps,
  cancelWorkingRowWait,
  createOldLifeHoldEndRetry,
  ensureOldLifeWait,
  forgetOldLifeWaits,
  isDialogApproverRunning,
  isLaunchInFlight,
  isLiveRowSequenceRunning,
  isSequenceOrOldLifeWaitRunning,
  killPersonaInstanceForTeardown,
  launchSession,
  liveRowSequenceGate,
  notifyRestartCapReached,
  oldLifeHeldDirectory,
  oldLifeHoldStep,
  personaRetryBlockCause,
  readPersonaRowState,
  reconcileOrphans,
  retryPendingRowStep,
  setConfiguredPersonaQuery,
  setConflictLatch,
  setInvalidFlagsHold,
  setKillFailureAlerts,
  setLiveRowSequenceRegistry,
  setOldLifeHolds,
  setOldLifeWaitBindings,
  setPersonaKillKeepGoingQuery,
  setRetiredKeyStore,
  setSessionNotifier,
  spawnForPersona,
  startLiveRowSequence,
  stopAllDialogApprovers,
  stopDialogApprover,
  stopLiveRowSequence,
  waitsOnKillFailedHold,
  whenLaunchSettled,
  type ApproverClock,
  type ApproverOutcome,
  type OrphanReconcileResult,
  type SpawnPersonaResult,
} from '../../src/session-manager.ts'
import { durableWriteFileSync } from '../../src/atomic-write.ts'
import type { OwnRowReadSite } from '../../src/session-manager.ts'
import {
  createOldLifeHoldSet,
  readRetiredKeysAtStart,
  RETIRED_KEY_CAUSE_REMOVED,
  RETIRED_KEYS_LOG_PREFIX,
  RETIRED_KEYS_UNCHANGED,
  RETIRED_KEYS_WRITTEN,
  type OldLifeHold,
  type OldLifeHoldBegin,
  type OldLifeHoldSet,
  type RetiredKeyCause,
  type RetiredKeyEntry,
  type RetiredKeyStore,
  type RetiredKeysWriter,
} from '../../src/retired-keys.ts'
import { createSlowRecoveryTracker, type SlowRecoveryTracker } from '../../src/slow-recovery.ts'
import { recordStartupError } from '../../src/startup-errors.ts'
import {
  createFullModeRetryAction,
  createUnavailableRetryController,
  runDetachedRecoveryAttempt,
  runOutsideAttempts,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_HELD,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type UnavailableRetryAction,
  type UnavailableRetryConditionEndResult,
  type UnavailableRetryTriggerSink,
  type UnavailableRetryController,
  type UnavailableRetryMode,
  type UnavailableRetryOutcome,
  type UnavailableRetryRunNowResult,
} from '../../src/unavailable-retry.ts'
import {
  installAdVersionRecheck,
  lastAdVersionSeen,
  onAdVersionChanged,
  resetAdVersionRecheckForTests,
  type AdVersionRecheckClock,
} from '../../src/ad-version-gate.ts'
import {
  bindInvalidFlagsHoldSetReaction,
  createInvalidFlagsHold,
  endInvalidFlagsHoldsOnVersionChange,
  type InvalidFlagsHold,
} from '../../src/invalid-flags-hold.ts'
import { writeAgentDirectorConfig, type AdConfigInput } from './ad-settings.ts'
import { PHASE1_RC_VERSION } from './agent-director-versions.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedKillResult,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errInstanceIdCollision,
  errInvalidFlags,
  errSpawnNotFound,
  errTmuxKillFailed,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errTmuxUnresponsiveLaunchTimeout,
  holdSpawns,
  installStubSpawnPath,
  makeStubResolveSystemBinary,
  resetStubSpawnPath,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_NONE,
  unavailableForms,
  type CannedGetResult,
  type FindMissingHold,
  type PersonaGetResultOverrides,
  type StubCallLog,
  type StubClientOptions,
  type StubResolveSystemBinaryOutcome,
  type StubSpawnPath,
} from './agent-director-stub.ts'
import { LEAK_SENTINEL, writtenFile } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeNotifierStack } from './persona-notifier.ts'
import { stateOf } from './persona-routing-harness.ts'
import { makeChannelMessage, makeStubSlack, type StubSlack } from './slack-stub.ts'
import { writeRetiredKeysRecord, type RetiredKeySeed } from './retired-keys.ts'

/** Clock flushes `advance` waits at most for the in-flight retry runs, before and after each firing. */
const DEFAULT_SETTLE_FLUSHES = 20

/** How long `settle` waits at most for the launches in flight, in real ms (1 ms steps). */
const DEFAULT_SETTLE_MS = 2000

/** How many approver timers `runApproverToStop` fires at most when the case gives no bound. */
const DEFAULT_APPROVER_STEPS = 1000

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
  /** The configuration's `resume_enabled`; the configuration's default when unset. */
  resumeEnabled?: boolean
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
  /**
   * The dialog approver's cap in ms (`_setDialogReadyTimeoutMs`), on the
   * harness clock from the approver's start: `installStubSpawnPath`'s 200 ms
   * when unset, below the approver's pace (`DIALOG_POLL_INTERVAL_MS`), so it
   * makes one lap and stops at the cap when the clock reaches it. A case
   * that needs later laps passes a larger cap.
   */
  approverCapMs?: number
  /**
   * The retired-key record the store reads at build (b.jg5 SRJ-807): the
   * entries by key, given the harness's persona keys, written into `stateDir`
   * through `writeRetiredKeysRecord` before the store loads; no file (an
   * empty record) when unset.
   */
  retiredKeys?: (keys: readonly string[]) => Readonly<Record<string, RetiredKeySeed>>
  /**
   * Put the session manager's clock (`_setNow`) on the harness clock at
   * build, and back on the real one at `cleanup()` (`_resetNow`), so each
   * launch call's window (b.jg5 SRJ-407, `launchCallWindowOf`) is recorded on
   * harness-clock times; `scriptTimedLaunch` needs it. False when unset: the
   * working-row wait, its deferral runs and the findMissing memo's window
   * read the same clock, and a case that bounds the wait in real ms (a short
   * `_setWaitForWaitingTimeoutMs`) needs the real one.
   */
  harnessNow?: boolean
}

/** One write the harness's retired-key store made: its path, and whether it went through (false: `failRetiredKeyWrites` refused it). */
export interface RecoveryRetiredKeyWrite {
  readonly path: string
  readonly ok: boolean
}

/** The errno a write refused by `failRetiredKeyWrites` throws with, before it touches the file. */
export const RECOVERY_RETIRED_KEY_WRITE_FAILURE_CODE = 'ENOSPC'

/** What `retireKey` records: the key's cause (`removed` when unset) and whether its mark is set (false when unset). */
export interface RecoveryRetireKeyOptions {
  readonly cause?: RetiredKeyCause
  readonly mark?: boolean
}

/** A key's entry as `retiredEntry` reads it through the store's queries. */
export interface RecoveryRetiredEntry {
  /** `isRecorded`. */
  readonly recorded: boolean
  /** `isMarked`: a mark held in memory after a failed write included. */
  readonly marked: boolean
  /** `entry`: undefined when the key is not recorded. */
  readonly entry: RetiredKeyEntry | undefined
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

/**
 * The holds a latch runs that `latchEvents` records, by the names the hold
 * observer logs them under, in its order. The fourth, `'slow-recovery end'`,
 * runs after them and is not recorded.
 */
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

/** What `loseMessage` resolves with: one lost message for one persona, as the driver saw it. */
export interface LostMessageOutcome {
  /** The state the notice reports, identified by `stateOf`. */
  readonly state: ReturnType<typeof stateOf>
  /** The notice body the routing raised (no persona prefix). */
  readonly notice: string
  /** Whether the routing asked the restart module for the persona's restart (`scheduleRestart`), armed or not. */
  readonly restartRequested: boolean
  /** Whether a restart of the persona is pending or running once the message was handled. */
  readonly restartPending: boolean
  /** The stub calls made while the message was handled, by verb, leaving out verbs with none. */
  readonly calls: Record<string, number>
}

/** What a case asks of one live-row sequence (`startSequence`, `runSequence`); see the module comment. */
export interface RecoverySequenceRequest {
  /** The row state the starter last read: the seed of step 1's kill and of the first run's reading. */
  readonly lastReadState: string
  /** The step the sequence enters at; step 1 when unset. */
  readonly entryStep?: LiveRowSequenceEntryStep
  /** Whether the persona keeps its conversation; false when unset. */
  readonly keepsConversation?: boolean
  /** Whether the key is retired; false when unset. */
  readonly retiredKey?: boolean
  /** Whether the sequence ends in a launch; true when unset (false: the no-launch form). */
  readonly launches?: boolean
  /** The kill-failure alert's context; `recovery` when unset. */
  readonly alertContext?: KillFailureAlertContext
  /** The store's reading of the key when the launch attempt began (b.jg5 SRJ-806); absent when unset, so the start entry reads it. */
  readonly retiredAtStart?: RetiredKeyAttemptStart
}

/** One live-row sequence `startSequence` started through the registry: its outcome and its stop. */
export interface RecoverySequenceRun {
  /** Resolves with the sequence's outcome once it has settled (the registry's `_whenSettled`). */
  readonly outcome: Promise<LiveRowSequenceOutcome>
  /**
   * Stop it through the session manager's stop entry (`stopLiveRowSequence`):
   * the signal is set before this returns; resolves true once the sequence
   * has settled, false when none runs for the persona.
   */
  stop(reason: LiveRowSequenceStopReason): Promise<boolean>
}

/** The driver's pieces, built at the first `loseMessage`. */
interface LostMessageDriver {
  readonly routing: PersonaRouting
  readonly hold: PersonaDestinationHold
}

/** The harness's latch, read-only: the latched query and the record. */
export type RecoveryLatchView = Pick<ConflictLatch, 'isLatched' | 'record'>

/** The harness's `ErrInvalidFlags` hold, read-only: the held query, the version a hold began under and the keys held. */
export type RecoveryInvalidFlagsHoldView = Pick<InvalidFlagsHold, 'isHeld' | 'beganUnder' | 'heldKeys'>

/**
 * One retry at once the version-changed listener ran (b.jg5 SRJ-207): the
 * persona, the clock time it was asked for at, and the retry entry's outcome
 * once it settled (undefined until then).
 */
export interface RecoveryRetryAtOnce {
  readonly key: string
  readonly at: number
  outcome?: RestartRetryOutcome
}

/**
 * One retry at once the old-life hold's end observer ran (b.jg5 SRJ-810;
 * `createOldLifeHoldEndRetry` bound to the controller's `runNow`, as `main()`
 * binds it): the persona, the clock time the hold ended at, and what
 * `runNow` answered.
 */
export interface RecoveryHoldEndRetry {
  readonly key: string
  readonly at: number
  readonly result: UnavailableRetryRunNowResult
}

/**
 * The version re-check `versionRecheck` installed on the harness clock
 * (b.jg5 SRJ-204): what its binary resolve answers, set by the case, and what
 * it did.
 */
export interface RecoveryVersionRecheck {
  /** Set what the binary resolve answers from its next call on (a version, a below-floor version, a failure). */
  answer(outcome: StubResolveSystemBinaryOutcome): void
  /** Each binary resolve call made, in order. */
  readonly resolves: readonly unknown[]
  /** The exit codes the re-check's stop was asked for, in order. */
  readonly stops: readonly number[]
  /** The due time of its next timed re-check, or undefined when none is pending. */
  nextDueAt(): number | undefined
  /** How many of the harness clock's pending timers are the re-check's (its interval and a call's time limit). */
  pendingTimers(): number
}

/**
 * The persona teardown's dependencies `teardownDeps()` binds over the
 * harness's own instances, as `main()` binds them (b.jg5 SRJ-715); see the
 * module comment.
 */
export type RecoveryTeardownDeps = Required<
  Pick<
    PersonaLifecycleDeps,
    | 'stopApprover'
    | 'stopLiveRowSequence'
    | 'whenLaunchSettled'
    | 'cancelLaunchWait'
    | 'stopRetryTimer'
    | 'forgetOldLifeWaits'
    | 'forgetConflictLatch'
    | 'forgetInvalidFlagsHold'
    | 'forgetNoticeEpisodes'
    | 'resetOutageState'
    | 'killInstance'
    | 'raiseKillFailureAlert'
  >
>

/**
 * The harness's one old-life hold set, read-only (b.jg5 SRJ-809): its
 * queries, each answering copies (`OldLifeHold`: instance id, old key,
 * directory and its real path, cause, kill-failed mark, waiting personas).
 */
export type RecoveryOldLifeHoldsView = Pick<OldLifeHoldSet, 'snapshot' | 'holdOf' | 'holdsOnDirectory' | 'holdsWaitedOnBy' | 'waitsOnKillFailed'>

/** The harness's slow-recovery tracker, read-only: a persona's count and whether its episode is open. */
export type RecoverySlowRecoveryView = Pick<SlowRecoveryTracker, 'count' | 'isOpen'>

/** What `makeRecoveryHarness` returns; see the module comment. */
export interface RecoveryHarness {
  readonly clock: FakeClock
  /** Whether the session manager's clock (`_setNow`) is the harness clock (`options.harnessNow`). */
  readonly harnessNow: boolean
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
  /** Whether persona `key`'s kill-failure episode is open (read-only; the alerts' `isOpen`, the driver's kill-failed input). */
  killFailureOpen(key: string): boolean
  /** The harness's one latch, read-only (`isLatched`, `record`); composed as `main()` composes it. */
  readonly latch: RecoveryLatchView
  /**
   * The harness's one `ErrInvalidFlags` hold, read-only (`isHeld`,
   * `beganUnder`, `heldKeys`; b.jg5 SRJ-207); composed as `main()` composes
   * it. A tick case binds `invalidFlagsHold.isHeld` as `HealthCheckDeps.isHeld` itself.
   */
  readonly invalidFlagsHold: RecoveryInvalidFlagsHoldView
  /** Every retry at once the version-changed listener ran, in order. */
  readonly retriesAtOnce: RecoveryRetryAtOnce[]
  /**
   * The harness's one retired-key store (b.jg5 SRJ-807), loaded over
   * `stateDir` and installed in the session manager as `main()` loads and
   * installs it; see the module comment.
   */
  readonly retiredKeys: RetiredKeyStore
  /** Every write the retired-key store made, in order. */
  readonly retiredKeyWrites: readonly RecoveryRetiredKeyWrite[]
  /** Refuse the retired-key store's next `count` writes (1 when unset), each before it touches the file. */
  failRetiredKeyWrites(count?: number): void
  /**
   * Record `key` through the installed store's `record` and, with
   * `options.mark`, set its mark through `mark` (b.jg5 SRJ-805, SRJ-806);
   * throws unless each went through. See the module comment.
   */
  retireKey(key: string, options?: RecoveryRetireKeyOptions): void
  /** `key`'s entry read through the store's queries; see the module comment. */
  retiredEntry(key: string): RecoveryRetiredEntry
  /**
   * The harness's one old-life hold set, read-only (b.jg5 SRJ-809), built and
   * installed in the session manager as `main()` builds and installs it; see
   * the module comment.
   */
  readonly oldLifeHolds: RecoveryOldLifeHoldsView
  /**
   * Begin one old-life hold as apply step 1 begins it: the hold set's `begin`,
   * the one member `main()` hands the reload controller. Answers the hold.
   */
  beginOldLifeHold(begin: OldLifeHoldBegin): OldLifeHold
  /**
   * Run the start sweep as `main()` runs it (`reconcileOrphans` over the
   * applied configuration on `killRetryClock`, driven with `drive`), its
   * shutdown query the harness's shutting-down flag unless `isShuttingDown`
   * is given; its rows are the stub's `list` answer.
   */
  startSweep(isShuttingDown?: () => boolean): Promise<OrphanReconcileResult>
  /**
   * Install agent-director's version re-check on the harness clock as
   * `main()` installs it, its binary resolve answering `initial` until the
   * case sets another; see the module comment.
   */
  versionRecheck(initial?: StubResolveSystemBinaryOutcome): RecoveryVersionRecheck
  /** Every latch set, each of the three recorded holds and every CONFLICT notice post, in order. */
  readonly latchEvents: RecoveryLatchEvent[]
  /**
   * The harness's one slow-recovery tracker, read-only (`count`, `isOpen`);
   * built over `episodes` and wired as `main()` wires it.
   */
  readonly slowRecovery: RecoverySlowRecoveryView
  /** Every lost-message notice the driver's routing raised (body, no persona prefix), in order. */
  readonly lostMessageNotices: RecoveryNotice[]
  /** Persona `key`'s Slack stub: its client and bot identity in the driver's routing. */
  slack(key: string): StubSlack
  /**
   * Lose one Slack message for persona `key` through the real routing's
   * no-session branch, bound as `main()` binds it; see the module comment.
   */
  loseMessage(key: string): Promise<LostMessageOutcome>
  /**
   * Every ask of the restart deps' latched query, by key, in order: what
   * `loseMessage`'s `restartRequested` reads (`scheduleRestart` asks it
   * before any other gate, so a request shows here with the delay 0 too).
   */
  readonly restartAsks: readonly string[]
  /** The per-persona serializer the restart module runs its work through. */
  readonly serializer: PersonaSerializer
  /** The server's retry action, for both modes, over the real row read and restart entry (the default). */
  readonly fullModeAction: UnavailableRetryAction
  /** The scripted action (`answer`). */
  readonly scriptedAction: UnavailableRetryAction
  script(knobs: RecoveryStubScript): void
  launch(key: string): Promise<SpawnPersonaResult>
  /**
   * The harness clock with each wait between a kill's tries tracked (b.jg5
   * SRJ-702): the restart kill adapter's, and the one a
   * case hands the start sweep (`reconcileOrphans(config, clock)`), so
   * `drive` moves the clock to its waits.
   */
  readonly killRetryClock: KillRetryClock
  /**
   * Await `work` while moving the clock to each pending wait between a
   * kill's tries as it is set (b.jg5 SRJ-702); see the module comment.
   */
  drive<T>(work: Promise<T>): Promise<T>
  /** The live-row sequence's dependencies, from the session manager's builder; see the module comment. */
  readonly sequenceDeps: LiveRowSequenceDeps
  /**
   * The reuse spawns the stub recorded (b.jg5 SRJ-112, SRJ-708): its `spawn`
   * calls carrying the reuse field (`reuse_finished`), in order; read-only.
   */
  reuseSpawns(): readonly Phase1SpawnParams[]
  /**
   * The sequence-start request for persona `key` that `startSequence` hands
   * the session manager's start entry, with `request`'s fields and the
   * defaults; see the module comment.
   */
  sequenceRequest(key: string, request: RecoverySequenceRequest): LiveRowSequenceRequest
  /**
   * Start one live-row sequence for persona `key` through the session
   * manager's start entry (the registry), resolving at once; throws unless
   * the entry answered `started`. See the module comment.
   */
  startSequence(key: string, request: RecoverySequenceRequest): RecoverySequenceRun
  /** Whether a live-row sequence runs for persona `key` (read-only; the session manager's `isLiveRowSequenceRunning`). */
  sequenceRunning(key: string): boolean
  /** The registry's test-only settle query (`_whenSettled`) for persona `key`; starts and stops nothing. */
  sequenceSettled(key: string): Promise<LiveRowSequenceOutcome | undefined>
  /** Start one live-row sequence for persona `key` and drive it to its end (`driveSequence`); resolves with its outcome. */
  runSequence(key: string, request: RecoverySequenceRequest): Promise<LiveRowSequenceOutcome>
  /** Await `work` while moving the clock to each pending live-row sequence timer as it is set; see the module comment. */
  driveSequence<T>(work: Promise<T>): Promise<T>
  /**
   * Start the old-life wait on held instance id `instanceId` through the
   * session manager's ensure entry (`ensureOldLifeWait`, b.jg5 SRJ-811),
   * resolving at once, before its first call; throws unless the entry
   * answered `started`. Answers the outcome promise (the registry's
   * `_whenSettledOn`), which resolves once the wait has settled and its end
   * handler has run.
   */
  startOldLifeWait(instanceId: string): Promise<LiveRowSequenceOutcome>
  /** Start the old-life wait on `instanceId` (`startOldLifeWait`) and drive it to its end (`driveSequence`). */
  runOldLifeWait(instanceId: string): Promise<LiveRowSequenceOutcome>
  /** Whether an old-life wait runs on `instanceId` (read-only; the registry's `isNoLaunchRunning`). */
  oldLifeWaitRunning(instanceId: string): boolean
  /**
   * Every retry at once the old-life hold's end observer ran, in order
   * (b.jg5 SRJ-810); see the module comment.
   */
  readonly holdEndRetries: readonly RecoveryHoldEndRetry[]
  /**
   * Decide one MCP session whose roots working directory is `rootsPath`, as
   * `handleInitialized` decides it (b.av2 SR-6.3, SR-6.4; b.jg5 SRJ-810,
   * SRJ-1505); see the module comment.
   */
  admitSession(rootsPath: string): SessionAdmission
  /** Whether the old-life wait's unclassified-error episode on held instance id `instanceId` is open (read-only; b.jg5 SRJ-313, SRJ-811). */
  oldLifeWaitUnclassifiedOpen(instanceId: string): boolean
  /**
   * The registry's test-only settle query by instance id (`_whenSettledOn`):
   * the running wait's outcome once it settles (its end handler run), else
   * the last one's on `instanceId`; starts and stops nothing.
   */
  oldLifeWaitSettled(instanceId: string): Promise<LiveRowSequenceOutcome | undefined>
  /**
   * Install agent-director's version re-check with its binary resolve
   * answering `version`; answers the resolves it made and the exit codes its
   * stop was asked for. See the module comment.
   */
  recheckAnswers(version: string): { readonly resolves: readonly unknown[]; readonly stops: readonly number[] }
  settle(): Promise<void>
  /** Whether persona `key`'s dialog approver is running (read-only; the session manager's `isDialogApproverRunning`). */
  approverRunning(key: string): boolean
  /**
   * Drive persona `key`'s dialog approver on the harness clock until it has
   * stopped, and resolve with how it ended (the session manager's
   * `_whenDialogApproverStopped`); see the module comment.
   */
  runApproverToStop(key: string, maxSteps?: number): Promise<ApproverOutcome | undefined>
  answer(key: string, ...outcomes: UnavailableRetryOutcome[]): void
  setAction(action: UnavailableRetryAction | undefined): void
  /** Whether persona `key`'s bring-up outcome is up (the relaunch gate); true at first. */
  setUp(key: string, up: boolean): void
  /** Whether persona `key`'s session is registered as connected with its message stream; false at first. */
  setConnected(key: string, connected: boolean): void
  /**
   * The server's shutdown: raise the shutting-down flag, close the live-row
   * sequence registry (every sequence stopped, none started after it), close
   * the controller, close the episodes, then stop every dialog approver (none
   * starts after it).
   */
  shutdown(): void
  /**
   * The persona teardown's submit (stop its dialog approver, then its
   * live-row sequence, stop the retry timer, cancel the condition's alert
   * check), then its turn's latch forget (silent); its episodes forget is the
   * case's `episodes.forget(key)` after it.
   */
  teardown(key: string): void
  /**
   * The persona teardown's dependencies over the harness's own instances,
   * each bound as `main()` binds it (b.jg5 SRJ-715); see the module comment.
   */
  teardownDeps(): RecoveryTeardownDeps
  /** Drop persona `key` from the applied configuration. */
  remove(key: string): void
  /** Add persona `key`, one of the harness's own, back to the applied configuration (the counterpart of `remove`). */
  reAdd(key: string): void
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
  /** Write agent-director's settings file again and let the installed reader read it (its next tick's read). */
  rewriteAdSettings(input: AdConfigInput): void
  advance(ms: number): Promise<number>
  captured(): Record<string, unknown>
  cleanup(): void
}

/**
 * The line the driver's `armRetryTimerIfMissing` logs when it arms persona
 * `key`'s retry timer: `main()`'s binding's line (pinned in
 * tests/server-startup-wiring.test.ts).
 */
function lostMessageArmLine(key: string): string {
  return `[slack] Lost message: persona=${key} has its tmux-unavailable outage raised with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)`
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
    ...(options.resumeEnabled === undefined ? {} : { resume_enabled: options.resumeEnabled }),
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
  // As main(): the relaunch gate and the up predicate decide over the same
  // connection status, bring-up outcome and live applied set.
  const upQuery: PersonaUpQuery = {
    isUp: (key) => !down.has(key),
    isApplied: (key) => applied.has(key),
  }
  const canRelaunch = createPersonaRelaunchGate({ status: () => SERVING }, log, upQuery)

  // As main()'s two in-flight bindings. "Blocks a retry"
  // (`isPersonaRetryBlocked`, b.jg5 SRJ-303): exactly when the session
  // manager's `personaRetryBlockCause` names a cause: a launch call
  // (`isLaunchInFlight`), a running live-row sequence
  // (`isLiveRowSequenceRunning`, SRJ-706) or an old-life wait step for a
  // hold P waits on (`isOldLifeWaitRunningFor`, SRJ-811), never a running
  // dialog approver (SRJ-401); the full-mode retry action receives it, with
  // the cause query. "In flight for P" (`isPersonaWorkInFlight`, SRJ-315,
  // SRJ-1011), built from it: that, or a running dialog approver
  // (`isDialogApproverRunning`); the driver's read gate and its
  // `tmux-unavailable` retry check receive it.
  const isPersonaRetryBlocked = (key: string): boolean => personaRetryBlockCause(key) !== undefined
  const isPersonaWorkInFlight = (key: string): boolean => isPersonaRetryBlocked(key) || isDialogApproverRunning(key)

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
    // As main() binds it (b.jg5 SRJ-207, SRJ-303, SRJ-305): so does a retry
    // of a persona held on ErrInvalidFlags.
    isHeld: (key) => invalidFlagsHold.isHeld(key),
    // As main() binds it (b.jg5 SRJ-303): only work that blocks a retry
    // skips it; a running dialog approver alone never does (SRJ-401). The
    // skip's again-reason and the restart retry's skip line name the cause.
    isInFlight: isPersonaRetryBlocked,
    retryBlockCause: personaRetryBlockCause,
    isSessionConnected: (key) => connected.has(key),
    hasSessionStream: (key) => connected.has(key),
    endTmuxUnresponsive: (key, reading) => {
      tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading)
      clearOutageFlag(key, 'tmux-unavailable', reading)
    },
    // As main() binds it (b.jg5 SRJ-409, SRJ-411): a pending-only retry whose
    // row read shows `pending` reads the applied persona's row once more and
    // takes the one pending-row step: a covered or undecided row is armed
    // pending-only and kept; one that is not covered starts the live-row
    // sequence, with no launch or approver of the retry's own.
    stepPendingRow: (key) => retryPendingRowStep(key, appliedPersona(key)),
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
  // As main() builds it (b.jg5 SRJ-610, SRJ-1010, SRJ-1016): the one
  // slow-recovery tracker over the same episodes instance, so its count and
  // its episode live there (a case's `episodes.forget(key)` and `shutdown()`'s
  // close drop them, and `cleanup()`'s forget-all clears them); its lines go
  // to `lines`. It is the restart deps' slow-recovery observer below, and its
  // latch end is the latch's fourth hold.
  const slowRecovery = createSlowRecoveryTracker({ episodes, log })
  // As main() builds them (b.jg5 SRJ-704, SRJ-1007, SRJ-1016): the
  // kill-failure alerts over the same episodes instance, so a destination
  // post lands in `episodeNotices` and the episode is forgotten and closed
  // with the others; the configured-key lookup over the live applied set (a
  // persona `remove(key)` dropped takes the log-only route); the log-only
  // route through `recordStartupError` into the harness's startup-errors
  // capture. Installed in the session manager below; the driver's kill-failed
  // input reads its episode.
  const killFailureAlerts = createKillFailureAlerts({
    episodes,
    log,
    isConfigured: (key) => appliedPersona(key) !== undefined,
    logOnly: (classLabel, entry) => recordStartupError(classLabel, entry),
  })

  // As main() builds it (b.jg5 SRJ-501, SRJ-502, SRJ-508): one latch per
  // harness, its lines to `lines`. A recorder observer first (it only records
  // the set in `latchEvents`), then, in main()'s order, the holds (the timer's
  // stop with the latch's reason, the condition's silent end, the
  // unclassified-error episode's end, the slow-recovery tracker's latch end),
  // then the CONFLICT notice over the episodes, so every hold is done before
  // the notice is posted. The first three holds are recorded in
  // `latchEvents`; the slow-recovery end is not (its effect is read through
  // `slowRecovery`), so a latch's events are the set, three holds and the
  // notice. The session manager's installer comes with the other installs
  // below.
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
        // As main() binds it (b.jg5 SRJ-610, SRJ-1016): the count reset and
        // the episode ended silently; not recorded in `latchEvents`.
        endSlowRecovery: (key) => {
          slowRecovery.endForLatch(key)
        },
      },
      log,
    ),
    bindConflictNotice(latch, recordingNoticeEpisodes(episodes, (key, text) => latchEvents.push({ step: 'notice', key, text }))),
  ]

  // As main() builds it (b.jg5 SRJ-207, SRJ-1008, SRJ-305): one hold per
  // harness, its lines to `lines`, its set reaction bound to the controller's
  // stop entry with the hold's reason and to the episodes, so a new hold
  // stops the persona's timer (a real stop shows in `stops`) and then posts
  // SRJ-1008's alert once in its episode (in `episodeNotices`). Installed in
  // the session manager with the other installs below.
  const invalidFlagsHold = createInvalidFlagsHold({ log })
  const unbindHold = bindInvalidFlagsHoldSetReaction(invalidFlagsHold, {
    stopRetryTimer: (key) => controller.stop(key, UNAVAILABLE_RETRY_STOP_HELD),
    episodes,
    log,
  })

  const savedStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = stateDir
  const savedConsoleError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }

  // As main() reads its one retired-key store at start (b.jg5 SRJ-802), over
  // the harness's state directory, its lines to `console.error` (so to
  // `errors`); the record a case asked for is written there first. Its writes
  // go through the production durable writer, each recorded, and the next
  // `failRetiredKeyWrites` ones refused before they touch the file. Installed
  // in the session manager below, beside the configured-persona query.
  const retiredKeyWrites: RecoveryRetiredKeyWrite[] = []
  let refuseRetiredKeyWrites = 0
  const writeRetiredKeys: RetiredKeysWriter = (path, bytes) => {
    if (refuseRetiredKeyWrites > 0) {
      refuseRetiredKeyWrites--
      retiredKeyWrites.push({ path, ok: false })
      throw Object.assign(new Error(`${RECOVERY_RETIRED_KEY_WRITE_FAILURE_CODE}: no space left on device`), { code: RECOVERY_RETIRED_KEY_WRITE_FAILURE_CODE })
    }
    durableWriteFileSync(path, bytes)
    retiredKeyWrites.push({ path, ok: true })
  }
  if (options.retiredKeys !== undefined) writeRetiredKeysRecord(stateDir, options.retiredKeys(keys))
  const retiredKeysStart = readRetiredKeysAtStart(stateDir, { log: (line) => console.error(line), write: writeRetiredKeys })
  if (retiredKeysStart.kind !== 'loaded') {
    console.error = savedConsoleError
    if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = savedStateDir
    rmSync(root, { recursive: true, force: true })
    throw new Error('recovery harness: the retired-key record the case seeded cannot be read')
  }
  const retiredKeys = retiredKeysStart.store
  // As main() builds it (b.jg5 SRJ-809), right after the store: the one
  // old-life hold set, in memory only, its lines to `console.error` (so to
  // `errors`), directories compared by the production real-path resolver.
  // Installed in the session manager below, right after the store.
  const oldLifeHolds = createOldLifeHoldSet({ log: (line) => console.error(line) })

  const stub = installStubSpawnPath(home)
  // The dialog approver runs on the harness clock (b.jg5 SRJ-401): its sleeps
  // between laps and its cap timer are harness-clock timers, tracked here so
  // `settle()` can tell an approver waiting for its next lap and `cleanup()`
  // can clear what a stopped approver left. Undone by `resetStubSpawnPath`.
  const approverTimers = new Set<unknown>()
  const approverClock: ApproverClock = {
    now: () => clock.now(),
    setTimeout: (callback, delayMs) => {
      const handle = clock.setTimeout(() => {
        approverTimers.delete(handle)
        callback()
      }, delayMs)
      approverTimers.add(handle)
      return handle
    },
    clearTimeout: (handle) => {
      approverTimers.delete(handle)
      clock.clearTimeout(handle)
    },
  }
  _setApproverClock(approverClock)
  if (options.approverCapMs !== undefined) _setDialogReadyTimeoutMs(options.approverCapMs)
  // With `options.harnessNow`, the session manager's own clock (`_setNow`) is
  // the harness clock too: each launch call's window (b.jg5 SRJ-407) is read
  // on it, as are the working-row wait, its deferral runs and the findMissing
  // memo's window. Undone by `cleanup()` (`_resetNow`).
  const harnessNow = options.harnessNow === true
  if (harnessNow) _setNow(clock.now)
  // The bounded retry of a kill (b.jg5 SRJ-702) waits on the harness clock,
  // each wait between tries tracked so `drive` can move the clock to it. As
  // main() binds it: the restart kill adapter gets this clock (below); the
  // live-row sequence's kills run on the sequence clock.
  const killRetryTimers = new Set<unknown>()
  const killRetryClock: KillRetryClock = {
    setTimeout: (callback, delayMs) => {
      const handle = clock.setTimeout(() => {
        killRetryTimers.delete(handle)
        callback()
      }, delayMs)
      killRetryTimers.add(handle)
      return handle
    },
  }
  _resetFindMissingMemo()
  const triggerSink: UnavailableRetryTriggerSink = {
    arm(key, cause) {
      triggers.push({ key, kind: cause.kind })
      return controller.arm(key, cause)
    },
    // As the production sink (the controller) has it: a launch's
    // `ErrTmuxSessionCreate`, a successful launch and the one pending-row
    // step arm pending-only through it (b.jg5 SRJ-112, SRJ-113, SRJ-301,
    // SRJ-409), recorded with the cause it arms.
    armPendingOnly(key) {
      triggers.push({ key, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW })
      controller.armPendingOnly(key)
    },
  }
  // The live-row sequence (b.jg5 SRJ-705), composed as main() composes it:
  // its dependencies from the session manager's one builder, with the
  // harness's kill-failure alerts and the trigger sink as its retry arm; its
  // clock is the harness clock with each sequence timer tracked, so
  // `driveSequence` can move the clock to it. Step 6 runs the production
  // `resume` leg and reuse spawn over the stub.
  const sequenceTimers = new Set<unknown>()
  const sequenceClock: NeverEarlyWaitClock = {
    now: () => clock.now(),
    setTimeout: (callback, delayMs) => {
      const handle = clock.setTimeout(() => {
        sequenceTimers.delete(handle)
        callback()
      }, delayMs)
      sequenceTimers.add(handle)
      return handle
    },
    clearTimeout: (handle) => {
      sequenceTimers.delete(handle)
      clock.clearTimeout(handle)
    },
  }
  const sequenceDeps = buildLiveRowSequenceDeps({
    killFailureAlerts,
    retryArm: triggerSink,
    clock: sequenceClock,
    log,
    appliedConfig,
  })
  // As main() builds it (b.jg5 SRJ-706, SRJ-811): the one registry over those
  // dependencies, each sequence that ends in a launch in its own recovery
  // attempt detached from its starter's (`runDetachedRecoveryAttempt`), each
  // old-life wait outside every attempt (`runOutsideAttempts`); installed
  // below, after the latch. Its start is wrapped only to record the instance
  // id of every no-launch request (an old-life wait), so `cleanup()` can tell
  // a wait still running; everything else is the registry's own. Cleanup
  // closes and removes it.
  const registry = createLiveRowSequenceRegistry({
    deps: sequenceDeps,
    runAttempt: runDetachedRecoveryAttempt,
    runOutsideAttempt: (run) => runOutsideAttempts(run),
  })
  const waitIds = new Set<string>()
  const sequences: LiveRowSequenceRegistry = {
    ...registry,
    start(request, startOptions) {
      if (request.launches === false) waitIds.add(request.instanceId)
      return registry.start(request, startOptions)
    },
  }
  /** The instance ids an old-life wait still runs on. */
  const waitsRunning = (): string[] => [...waitIds].filter((id) => sequences.isNoLaunchRunning(id))
  // Set by `recheckAnswers`; cleanup removes the install it made.
  let recheckInstalled = false
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
  // As main() installs it, before any launch (b.jg5 SRJ-207): a reuse
  // spawn's ErrInvalidFlags holds the persona through it, and no held
  // persona's launch makes an agent-director call.
  setInvalidFlagsHold(invalidFlagsHold)
  // As main() installs it (b.jg5 SRJ-706): the sequence registry, after the
  // latch and before any launch, so the latch's set observer stops a latched
  // persona's running sequence.
  setLiveRowSequenceRegistry(sequences)
  // As main() installs it, beside the latch (b.jg5 SRJ-114): a key counts as
  // configured while it is in the live applied set, so a note on a persona's
  // own row latches it and a key outside the set, or removed from it, does not.
  setConfiguredPersonaQuery((key) => appliedPersona(key) !== undefined)
  // As main() installs it, right after the configured-persona query (b.jg5
  // SRJ-807): any key's own row read live other than pending while the store
  // has the key recorded with its mark set clears its entry.
  setRetiredKeyStore(retiredKeys)
  // As main() installs it, right after the store and before the start sweep
  // (b.jg5 SRJ-809): every row read the session manager makes ends or
  // re-points a hold, and the start sweep begins its holds here.
  setOldLifeHolds(oldLifeHolds)
  // As main() installs them, before any launch (b.jg5 SRJ-704, SRJ-1016):
  // the restart path's kill and the live-row sequence's kills raise through
  // them, and the session manager's own-row reads end a persona's episode.
  setKillFailureAlerts(killFailureAlerts)
  // As main() installs them with the registry (b.jg5 SRJ-811, SRJ-812,
  // SRJ-1512): the old-life wait's bindings. Each waiting persona's timer is
  // armed through the trigger sink (recorded in `triggers`, then armed on the
  // controller; main() hands the controller itself), never the old key's; the
  // wait's waits are sequence timers (`driveSequence` moves the clock to
  // them); its sequence lines go to `lines`; the applied configuration is the
  // live applied set; the alerts are the harness's kill-failure alerts, whose
  // log-only route writes the harness's `startup-errors.log`, and the
  // startup-errors recorder writes there too (the `persona-teardown-notice`
  // entries "during the wait" and the old key's unclassified entry). A wait
  // starts only through the session manager's entry (`ensureOldLifeWait`,
  // `startOldLifeWait`); a hold's end and `shutdown()`'s close stop it. The
  // wait's own unclassified-error episodes (b.jg5 SRJ-313), built as main()
  // builds them, on the harness clock: keyed by the held instance id, at E6's
  // alert threshold in effect, their lines to `console.error` (`errors`),
  // their one alert per episode the log-only `persona-unclassified-error`
  // entry in the harness's `startup-errors.log`; `shutdown()` and
  // `cleanup()` close them.
  const waitUnclassifiedErrors = createOldLifeWaitUnclassifiedErrors({
    log: (line) => console.error(line),
    alertThresholdMs: adAlertThresholdMsInEffect,
    recordStartupError: (classLabel, entry) => recordStartupError(classLabel, entry),
    clock,
  })
  setOldLifeWaitBindings({
    retryArm: triggerSink,
    clock: sequenceClock,
    log,
    appliedConfig,
    killFailureAlerts,
    recordStartupError: (classLabel, entry) => recordStartupError(classLabel, entry),
    unclassifiedErrorEpisodes: waitUnclassifiedErrors,
  })
  // As main() registers it (b.jg5 SRJ-810), on the one hold set after the
  // session manager's own end observer (`setOldLifeHolds` above), so the
  // hold's wait is stopped first: each persona recorded as waiting on the
  // hold that ended, still applied and not latched, is retried at once
  // through the controller's run-now entry, armed with the
  // held-for-an-old-life cause when it was not. Each run-now is recorded in
  // `holdEndRetries`. Cleanup removes it.
  const holdEndRetries: RecoveryHoldEndRetry[] = []
  const removeHoldEndRetry = oldLifeHolds.onEnd(
    createOldLifeHoldEndRetry({
      runNow: (key) => {
        const result = controller.runNow(key, { kind: UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD }, UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED)
        holdEndRetries.push({ key, at: clock.now(), result })
        return result
      },
      isApplied: (key) => appliedPersona(key) !== undefined,
    }),
  )
  // As main() installs it (b.jg5 SRJ-702, SRJ-305): a kill's tries stop once
  // the persona is not up (the up predicate over the relaunch gate's
  // connection, bring-up outcome and live applied set) or the server is
  // shutting down; the session manager asks the latch itself.
  setPersonaKillKeepGoingQuery({
    isPersonaUp: createPersonaUpPredicate({ status: () => SERVING }, upQuery),
    isShuttingDown: () => shuttingDown,
  })

  resetAdSettingsForTests()
  if (options.adSettings !== undefined) writeAgentDirectorConfig(home, options.adSettings)
  const adSettingsReader = installAdSettings({ home: () => home, log })

  _resetRestartState()
  _resetBackoffState()
  // As main()'s `isSessionAliveAdapter`: one liveness adapter over the applied
  // configuration, the restart path's read and the driver's lost-message read.
  const isSessionAliveAdapter = _buildIsSessionAliveAdapter(appliedConfig)
  const restartDeps: RestartDeps = {
    canRestart: canRelaunch,
    isSessionAlive: isSessionAliveAdapter,
    isSessionConnected: (key) => connected.has(key),
    hasSessionStream: (key) => connected.has(key),
    reconnectSession: _buildReconnectSessionAdapter(appliedPersona, undefined, appliedPersona),
    killSession: _buildKillSessionAdapter(appliedPersona, killRetryClock),
    // As main() binds it: the verdict an escalate-dead relaunch carries is
    // passed on unchanged, into the ladder (b.jg5 SRJ-611).
    launchSession: (key, _cwd, _sessionId, deadEvidence) => launchSession(key, appliedConfig(), { canLaunch: canRelaunch, deadEvidence }),
    getRestartDelay: () => config.session_restart_delay,
    isShuttingDown: () => shuttingDown,
    // As main() binds it, after recording the key: the cap notice, the
    // silent end of the persona's unclassified-error episode, then the stop
    // of its retry timer in either mode (b.jg5 SRJ-305; a real stop shows in
    // `stops`), each isolated.
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
      try {
        controller.stop(key, UNAVAILABLE_RETRY_STOP_CAPPED)
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
    // As main() binds it (b.jg5 SRJ-314, SRJ-409, SRJ-411): a restart run
    // whose liveness reads `pending` (its first probe or the re-probe) hands
    // the reading to the server's `pending` deferral, awaited, with its launch
    // start, over the harness's applied-persona lookup. For an applied persona
    // the deferral takes the session manager's read-and-step: one `get`, then
    // a covered or undecided row armed pending-only (through the trigger
    // sink, so in `triggers`) or an uncovered one sent through the live-row
    // sequence, with the deferral's per-answer lines (row no longer pending,
    // gone, refused) in `errors`; a step that throws is logged there and the
    // deferral still answers `pending`.
    deferPendingRow: async (key, reading) => {
      await deferPendingRow(key, reading.launchStartedAt, appliedPersona)
    },
    // As main() binds it (b.jg5 SRJ-502): a latched persona's restart work
    // makes no agent-director call.
    isLatched: (key) => latch.isLatched(key),
    // As main() binds it (b.jg5 SRJ-207, SRJ-303): nor does a held persona's.
    isHeld: (key) => invalidFlagsHold.isHeld(key),
    // As main() binds it (b.jg5 SRJ-706, SRJ-303, SRJ-811): while the
    // persona's live-row sequence runs, its restart work makes no
    // agent-director call; when what runs on its own row is an old-life
    // wait, the gate also arms its retry timer (`held-for-old-life`).
    isLiveRowSequenceRunning: (key) => liveRowSequenceGate(key, 'runRestartWork'),
    // As main() binds it (b.jg5 SRJ-810, SRJ-812): while an old life may
    // still run in the applied persona's working directory (a hold on its
    // own row excepted), the session manager's hold step records it as
    // waiting, starts the hold's wait and arms its timer, and the restart
    // work answers sequence-waiting with no agent-director call.
    isHeldForOldLife: (key) => {
      const persona = appliedPersona(key)
      return persona !== undefined && oldLifeHoldStep(persona, 'runRestartWork')
    },
    // As main() binds it (b.jg5 SRJ-610): each run's readings and verdicts
    // feed the slow-recovery tracker.
    slowRecovery,
    ...options.restartDeps,
  }
  // Every ask of the latched query in effect is recorded first (the driver's
  // `restartRequested`: `scheduleRestart` asks it before any other gate); its
  // answer, or its throw, reaches the restart module unchanged (an absent
  // query answers false, as the restart module reads an absent one).
  const restartLatchedAsks: string[] = []
  const latchedQuery = restartDeps.isLatched
  initRestart({
    ...restartDeps,
    isLatched: (key) => {
      restartLatchedAsks.push(key)
      return latchedQuery?.(key) ?? false
    },
  })

  // As main() registers it (b.jg5 SRJ-204, SRJ-207): the one version-changed
  // listener, the hold's version-change reaction over the episodes, the
  // live applied set and a retry at once through the restart module's retry
  // entry (no delay gate) with "blocks a retry". Each retry is recorded in
  // `retriesAtOnce` and awaited by `settle()`. Registered again after a
  // re-check reset (`recheckAnswers`); removed by `cleanup()`.
  const retriesAtOnce: RecoveryRetryAtOnce[] = []
  const retriesAtOnceInFlight = new Set<Promise<unknown>>()
  function registerVersionChangedListener(): () => void {
    return onAdVersionChanged((_previousVersion, newVersion) => {
      endInvalidFlagsHoldsOnVersionChange(invalidFlagsHold, newVersion, {
        episodes,
        isApplied: (key) => appliedPersona(key) !== undefined,
        retryAtOnce: (key) => {
          const persona = appliedPersona(key)
          if (persona === undefined) return undefined
          const record: RecoveryRetryAtOnce = { key, at: clock.now() }
          retriesAtOnce.push(record)
          const run = runRestartRetry(key, persona.working_directory, isPersonaRetryBlocked).then((outcome) => {
            record.outcome = outcome
          })
          retriesAtOnceInFlight.add(run)
          const done = (): void => {
            retriesAtOnceInFlight.delete(run)
          }
          void run.then(done, done)
          return run
        },
        log,
      })
    })
  }
  let unsubscribeVersionChanged = registerVersionChangedListener()

  // The version re-check on the harness clock (`versionRecheck`), its timers
  // tracked so a case can tell them from the others.
  const recheckTimers = new Set<unknown>()
  const recheckClock: AdVersionRecheckClock = {
    setTimeout: (callback, delayMs) => {
      const handle = clock.setTimeout(() => {
        recheckTimers.delete(handle)
        callback()
      }, delayMs)
      recheckTimers.add(handle)
      return handle
    },
    clearTimeout: (handle) => {
      recheckTimers.delete(handle)
      clock.clearTimeout(handle)
    },
  }

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

  /** The configured personas whose dialog approver is running. */
  function runningApproverKeys(): string[] {
    return keys.filter((key) => isDialogApproverRunning(key))
  }

  /**
   * Whether every running dialog approver waits for its next lap on the
   * harness clock: each holds at most two harness-clock timers (its cap and,
   * while it sleeps between laps, its sleep), so all sleep exactly when the
   * approvers' pending timers number twice the running approvers. True when
   * none runs and none left a timer.
   */
  function approversQuiet(): boolean {
    return approverTimers.size === 2 * runningApproverKeys().length
  }

  /** Let the running approvers reach their next sleep, for at most `settleFlushes` clock flushes. */
  async function settleApprovers(): Promise<void> {
    for (let flushes = 0; flushes < settleFlushes && !approversQuiet(); flushes++) await clock.flush()
  }

  /**
   * Await every configured persona's launch in flight and every retry run in
   * flight, and then every running dialog approver's next sleep on the
   * harness clock (or its stop), in 1 ms real-time steps, for at most
   * `settleMs`.
   */
  async function settleLaunches(): Promise<void> {
    let settled = false
    const all = Promise.all([
      ...keys.map((key) => whenLaunchSettled(key)),
      ...runKeys().map((key) => controller.whenRunSettled(key)),
      ...retriesAtOnceInFlight,
    ]).then(() => {
      settled = true
    })
    const realTurn = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 1))
    for (let waited = 0; waited < settleMs && !(settled && approversQuiet()); waited++) {
      if (!settled) {
        await Promise.race([all, realTurn()])
        continue
      }
      await clock.flush()
      if (!approversQuiet()) await realTurn()
    }
    if (!settled) throw new Error(`recovery harness: a launch or a retry run was still in flight after ${settleMs} ms`)
    if (!approversQuiet()) {
      throw new Error(
        `recovery harness: a dialog approver was neither stopped nor waiting for its next lap after ${settleMs} ms (running for ${JSON.stringify(runningApproverKeys())})`,
      )
    }
  }

  /**
   * Move the clock `ms` forward one due time at a time; before and after each
   * firing, await the retry runs and the approvers (flush-bounded).
   */
  async function advance(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`recovery harness: advance needs a finite, non-negative ms, got ${ms}`)
    const target = clock.now() + ms
    let fired = 0
    await settleRuns()
    await settleApprovers()
    for (let next = clock.pending()[0]; next !== undefined && next.dueAt <= target; next = clock.pending()[0]) {
      fired += await clock.advanceTo(next.dueAt)
      await settleRuns()
      await settleApprovers()
    }
    await clock.advanceTo(target)
    return fired
  }

  /** The earliest due time of a pending timer among `handles` (a tracked clock's), or undefined. */
  function nextDueOf(handles: ReadonlySet<unknown>): number | undefined {
    let due: number | undefined
    for (const timer of clock.pending()) {
      if (![...handles].some((handle) => (handle as { id?: unknown }).id === timer.id)) continue
      if (due === undefined || timer.dueAt < due) due = timer.dueAt
    }
    return due
  }

  /** The earliest due time of a pending wait between a kill's tries, or undefined. */
  function nextKillRetryDue(): number | undefined {
    return nextDueOf(killRetryTimers)
  }

  /**
   * Await `work`, moving the clock to each pending wait between a kill's
   * tries (b.jg5 SRJ-702) as it is set, in 1 ms real-time steps for at most
   * `settleMs` steps that find no wait pending.
   */
  async function drive<T>(work: Promise<T>): Promise<T> {
    let settled = false
    void work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const realTurn = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 1))
    for (let idle = 0; idle < settleMs && !settled; ) {
      await clock.flush()
      if (settled) break
      const due = nextKillRetryDue()
      if (due !== undefined) {
        await advance(due - clock.now())
        continue
      }
      await Promise.race([work, realTurn()])
      idle++
    }
    if (!settled) throw new Error(`recovery harness: the driven work was still unsettled after ${settleMs} ms with no kill-retry wait pending`)
    return work
  }

  /** The earliest due time of a pending approver timer, or undefined. */
  function nextApproverDue(): number | undefined {
    return nextDueOf(approverTimers)
  }

  /**
   * Await `work`, moving the clock to each pending live-row sequence timer as
   * it is set, in 1 ms real-time steps for at most `settleMs` steps that find
   * no sequence timer pending.
   */
  async function driveSequence<T>(work: Promise<T>): Promise<T> {
    let settled = false
    void work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const realTurn = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 1))
    for (let idle = 0; idle < settleMs && !settled; ) {
      await clock.flush()
      if (settled) break
      const due = nextDueOf(sequenceTimers)
      if (due !== undefined) {
        await advance(due - clock.now())
        continue
      }
      await Promise.race([work, realTurn()])
      idle++
    }
    if (!settled) throw new Error(`recovery harness: the driven sequence was still unsettled after ${settleMs} ms with no sequence timer pending`)
    return work
  }

  /** The start request for persona `key`'s sequence: `request`'s fields, with the defaults. */
  function sequenceRequest(key: string, request: RecoverySequenceRequest): LiveRowSequenceRequest {
    if (!keys.includes(key)) throw new Error(`recovery harness: no configured persona ${JSON.stringify(key)}`)
    return {
      key,
      instanceId: personaInstanceId(key),
      lastReadState: request.lastReadState,
      entryStep: request.entryStep ?? LIVE_ROW_SEQUENCE_ENTRY_KILL,
      keepsConversation: request.keepsConversation ?? false,
      retiredKey: request.retiredKey ?? false,
      launches: request.launches ?? true,
      alertContext: request.alertContext ?? KILL_FAILURE_CONTEXT_RECOVERY,
      ...(request.retiredAtStart === undefined ? {} : { retiredAtStart: request.retiredAtStart }),
    }
  }

  /** Start one live-row sequence for persona `key` through the session manager's start entry; throws unless it started. */
  function startSequence(key: string, request: RecoverySequenceRequest): RecoverySequenceRun {
    const answer = startLiveRowSequence(sequenceRequest(key, request))
    if (answer !== LIVE_ROW_START_STARTED) throw new Error(`recovery harness: the start entry answered ${answer} for ${key}, not ${LIVE_ROW_START_STARTED}`)
    const outcome = sequences._whenSettled(key).then((settled) => {
      if (settled === undefined) throw new Error(`recovery harness: persona ${key}'s sequence settled with no outcome`)
      return settled
    })
    return { outcome, stop: (reason) => stopLiveRowSequence(key, reason) }
  }

  /** Start the old-life wait on `instanceId` through the session manager's ensure entry; throws unless it started. */
  function startOldLifeWait(instanceId: string): Promise<LiveRowSequenceOutcome> {
    const answer = ensureOldLifeWait(instanceId)
    if (answer !== LIVE_ROW_START_STARTED) {
      throw new Error(`recovery harness: the ensure entry answered ${answer} for ${instanceId}, not ${LIVE_ROW_START_STARTED}`)
    }
    return sequences._whenSettledOn(instanceId).then((settled) => {
      if (settled === undefined) throw new Error(`recovery harness: the old-life wait on ${instanceId} settled with no outcome`)
      return settled
    })
  }

  function startupErrors(): string[] {
    const path = join(stateDir, 'startup-errors.log')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line !== '')
  }

  // The lost-message driver (b.jg5 SRJ-1011): one Slack stub per persona,
  // and the routing and notifier, built at the first `loseMessage`.
  const lostMessageNotices: RecoveryNotice[] = []
  const slackStubs = new Map<string, StubSlack>(keys.map((key) => [key, makeStubSlack({ leakMarker: LEAK_SENTINEL })]))
  let lostMessageDriver: LostMessageDriver | undefined
  let lostMessageCount = 0

  function slackStubOf(key: string): StubSlack {
    const stub = slackStubs.get(key)
    if (stub === undefined) throw new Error(`recovery harness: no configured persona ${JSON.stringify(key)}`)
    return stub
  }

  /** The persona's Slack client in the driver's routing and notifier: its own stub. */
  const slackClientFor = (key: string): WebClient | undefined => slackStubs.get(key)?.web as unknown as WebClient | undefined

  // As main()'s `tmuxUnavailableRetryDeps` (b.jg5 SRJ-311): the outage
  // state's flag, the controller's armed read, the latch's latched query,
  // "in flight for P" (a running dialog approver included) and the
  // ENVIRONMENT arm, straight to the
  // controller (not through the trigger sink, so not in `triggers`), with
  // its line to `console.error` (`errors`).
  const tmuxUnavailableRetryDeps: TmuxUnavailableRetryDeps = {
    isTmuxUnavailable: (key) => getOutageFlags(key).has('tmux-unavailable'),
    isRetryArmed: (key) => controller.isArmed(key),
    isLatched: (key) => latch.isLatched(key) === true,
    isWorkInFlight: isPersonaWorkInFlight,
    armRetryTimer: (key) => {
      controller.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT })
    },
    log: (line) => console.error(line),
  }

  /**
   * The driver's routing, built once, bound as `main()` binds it, its one
   * lost-message row read and its in-flight gate included (b.jg5 SRJ-1011).
   */
  function driver(): LostMessageDriver {
    if (lostMessageDriver !== undefined) return lostMessageDriver
    const { notifier, hold } = makeNotifierStack({ getPersona: appliedPersona, clientFor: slackClientFor, clock, log })
    const routing = createPersonaRouting({
      getPersonaConfig: appliedConfig,
      getBotIdentity: (key) => slackStubs.get(key)?.identity,
      clientFor: slackClientFor,
      // As server.ts: `users.info` through the persona's client.
      resolveUserName: async (key, userId) => {
        const client = slackClientFor(key)
        return client ? createNameResolver(client as unknown as NameResolverWebClient).resolveUserName(userId) : userId
      },
      archive: () => {},
      getReplySettings: () => replySettingsOf(appliedConfig()),
      notify: (key, text, noticeOptions) => {
        lostMessageNotices.push({ key, text })
        return notifier.notify(key, text, noticeOptions)
      },
      log,
      dedupeClock: () => clock.now(),
      isPersonaUp: createPersonaUpPredicate({ status: () => SERVING }, upQuery),
      isLatched: (key) => latch.isLatched(key),
      isTmuxUnresponsive: (key) => tmuxUnresponsive.holds(key),
      // As main() binds it (b.jg5 SRJ-1011 as amended: state 5 applies only
      // while P's retry timer is armed): the one controller's `isArmed`,
      // exactly true.
      isRetryArmed: (key) => controller.isArmed(key) === true,
      // As main() binds it (b.jg5 SRJ-1011, SRJ-401): state 6's member is a
      // launch call or the dialog approver that runs after it returned.
      isLaunchOrApproverRunning: (key) => isLaunchInFlight(key) || isDialogApproverRunning(key),
      // As main() binds them (b.jg5 SRJ-1011, SRJ-115): the read gate's
      // "in flight for P" (a running dialog approver included), and the one row
      // read is the harness's liveness adapter, so it shows as a stub `status`.
      isWorkInFlight: isPersonaWorkInFlight,
      readRowLiveness: isSessionAliveAdapter,
      // As main() binds it (b.jg5 SRJ-706, SRJ-811, SRJ-1011): while P's
      // live-row sequence, or an old-life wait step for a hold P waits on,
      // runs, the message reports `restarting`, read at call time.
      isSequenceOrWaitRunning: (key) => isSequenceOrOldLifeWaitRunning(key),
      // As main() binds it (b.jg5 SRJ-1011 state 4, SRJ-812): P's
      // kill-failure episode is open, read at call time from the harness's
      // alerts, or P waits on an old-life hold marked kill-failed.
      isKillFailed: (key) => killFailureAlerts.isOpen(key) === true || waitsOnKillFailedHold(key),
      // As main() binds it (b.jg5 SRJ-1011 state 3, SRJ-207): P is held on
      // ErrInvalidFlags, read at call time from the harness's hold.
      isHeldOnInvalidFlags: (key) => invalidFlagsHold.isHeld(key) === true,
      // As main() binds it (b.jg5 SRJ-311): nothing while shutting down, else
      // the server's one check over the harness's own holders.
      armRetryTimerIfMissing: (key) => {
        if (shuttingDown) return
        armMissingTmuxUnavailableRetry(key, tmuxUnavailableRetryDeps, lostMessageArmLine(key))
      },
    })
    lostMessageDriver = { routing, hold }
    return lostMessageDriver
  }

  /** The stub's call counts, by verb, leaving out verbs never called. */
  function stubCallCounts(): Record<string, number> {
    return Object.fromEntries(Object.entries(stub.calls).filter(([, calls]) => calls.length > 0).map(([verb, calls]) => [verb, calls.length]))
  }

  async function loseMessage(key: string): Promise<LostMessageOutcome> {
    const persona = appliedPersona(key)
    if (persona === undefined) throw new Error(`recovery harness: no applied persona ${JSON.stringify(key)}`)
    if (getSessionByPersona(key) !== undefined) {
      throw new Error(`recovery harness: persona ${key} has a registered session; the driver loses a message through the no-session branch`)
    }
    const channel = persona.channels[0]?.id
    if (channel === undefined) throw new Error(`recovery harness: persona ${key} lists no channel to receive a message in`)
    const { routing } = driver()
    const noticesBefore = lostMessageNotices.length
    const asksBefore = restartLatchedAsks.length
    const callsBefore = stubCallCounts()
    lostMessageCount += 1
    const event = makeChannelMessage({ channel, ts: `1700000000.${String(lostMessageCount).padStart(6, '0')}` })
    await routing.receive(event, () => {}, key)
    const raised = lostMessageNotices.slice(noticesBefore)
    if (raised.length !== 1 || raised[0]!.key !== key) {
      throw new Error(`recovery harness: losing a message for ${key} raised ${JSON.stringify(raised.map((n) => n.key))}, not one notice for it`)
    }
    const notice = raised[0]!.text
    return {
      state: stateOf(notice),
      notice,
      restartRequested: restartLatchedAsks.slice(asksBefore).includes(key),
      restartPending: isRestartPendingOrActive(key),
      calls: callCountsSince(stubCallCounts(), callsBefore),
    }
  }

  return {
    clock,
    harnessNow,
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
    killFailureOpen: (key) => killFailureAlerts.isOpen(key),
    latch: Object.freeze({ isLatched: (key: string) => latch.isLatched(key), record: (key: string) => latch.record(key) }),
    invalidFlagsHold: Object.freeze({
      isHeld: (key: string) => invalidFlagsHold.isHeld(key),
      beganUnder: (key: string) => invalidFlagsHold.beganUnder(key),
      heldKeys: () => invalidFlagsHold.heldKeys(),
    }),
    retriesAtOnce,
    retiredKeys,
    retiredKeyWrites,
    failRetiredKeyWrites(count = 1) {
      refuseRetiredKeyWrites = count
    },
    retireKey(key, retire = {}) {
      // Through the store's own primitives, so the record in memory and the
      // file agree; never a file written behind the loaded store.
      const recorded = retiredKeys.record([{ key, cause: retire.cause ?? RETIRED_KEY_CAUSE_REMOVED }]).outcome
      if (recorded !== RETIRED_KEYS_WRITTEN && recorded !== RETIRED_KEYS_UNCHANGED) {
        throw new Error(`recovery harness: recording ${key} as retired answered ${recorded}`)
      }
      if (retire.mark !== true) return
      const marked = retiredKeys.mark(key)
      if (marked !== RETIRED_KEYS_WRITTEN && marked !== RETIRED_KEYS_UNCHANGED) {
        throw new Error(`recovery harness: marking ${key} answered ${marked}`)
      }
    },
    retiredEntry: (key) => ({ recorded: retiredKeys.isRecorded(key), marked: retiredKeys.isMarked(key), entry: retiredKeys.entry(key) }),
    oldLifeHolds: Object.freeze({
      snapshot: () => oldLifeHolds.snapshot(),
      holdOf: (instanceId: string) => oldLifeHolds.holdOf(instanceId),
      holdsOnDirectory: (directory: string) => oldLifeHolds.holdsOnDirectory(directory),
      holdsWaitedOnBy: (persona: Parameters<OldLifeHoldSet['holdsWaitedOnBy']>[0]) => oldLifeHolds.holdsWaitedOnBy(persona),
      waitsOnKillFailed: (persona: Parameters<OldLifeHoldSet['waitsOnKillFailed']>[0]) => oldLifeHolds.waitsOnKillFailed(persona),
    }),
    // As main() hands the reload controller the set (b.jg5 SRJ-809): apply
    // step 1 begins its holds through `begin` alone.
    beginOldLifeHold: (begin) => oldLifeHolds.begin(begin),
    // As main() runs it (b.jg5 SRJ-714): over the applied configuration, on
    // the kill-retry clock, its shutdown query the shutting-down flag.
    startSweep: (isShuttingDown = () => shuttingDown) => drive(reconcileOrphans(appliedConfig(), killRetryClock, isShuttingDown)),
    versionRecheck(initial = { version: PHASE1_RC_VERSION }) {
      // As main() installs it: one re-check, never two (a leftover install
      // would answer the triggers instead of this one).
      if (lastAdVersionSeen() !== undefined) throw new Error('recovery harness: a version re-check is already installed')
      let current: StubResolveSystemBinaryOutcome = initial
      const resolves: Array<object | undefined> = []
      const stops: number[] = []
      const installed = installAdVersionRecheck({
        resolveSystemBinary: () => makeStubResolveSystemBinary({ calls: resolves, outcomes: [current] })(),
        baselineVersion: PHASE1_RC_VERSION,
        // As main() binds it: the startup-errors entry, written under the
        // harness's state directory (`startupErrors()`).
        recordStartupError: (classLabel, message) => recordStartupError(classLabel, message),
        stop: (exitCode) => {
          stops.push(exitCode)
        },
        log,
        clock: recheckClock,
      })
      if (installed === undefined) throw new Error('recovery harness: the version re-check was not installed')
      recheckInstalled = true
      return {
        answer(outcome) {
          current = outcome
        },
        resolves,
        stops,
        nextDueAt: () => nextDueOf(recheckTimers),
        pendingTimers: () => recheckTimers.size,
      }
    },
    latchEvents,
    slowRecovery: Object.freeze({ count: (key: string) => slowRecovery.count(key), isOpen: (key: string) => slowRecovery.isOpen(key) }),
    lostMessageNotices,
    slack: slackStubOf,
    loseMessage,
    restartAsks: restartLatchedAsks,
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

    killRetryClock,

    drive,

    sequenceDeps,

    reuseSpawns: () => stub.calls.spawnCalls.filter((params) => 'reuse_finished' in params),

    recheckAnswers(version) {
      const resolves: Array<object | undefined> = []
      const stops: number[] = []
      resetAdVersionRecheckForTests()
      // The reset drops every version-changed listener: register main()'s again.
      unsubscribeVersionChanged = registerVersionChangedListener()
      installAdVersionRecheck({
        resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolves, outcomes: [{ version }] }),
        baselineVersion: PHASE1_RC_VERSION,
        recordStartupError: () => {},
        stop: (exitCode) => {
          stops.push(exitCode)
        },
        log,
        clock: createFakeClock(),
      })
      recheckInstalled = true
      return { resolves, stops }
    },

    sequenceRequest,

    startSequence,

    sequenceRunning: (key) => isLiveRowSequenceRunning(key),

    sequenceSettled: (key) => sequences._whenSettled(key),

    runSequence: (key, request) => driveSequence(startSequence(key, request).outcome),

    driveSequence,

    startOldLifeWait,

    runOldLifeWait: (instanceId) => driveSequence(startOldLifeWait(instanceId)),

    oldLifeWaitRunning: (instanceId) => sequences.isNoLaunchRunning(instanceId),

    holdEndRetries,

    // As handleInitialized decides it (b.av2 SR-6.3, SR-6.4; b.jg5 SRJ-810,
    // SRJ-1505): the applied personas, the real up predicate over the same
    // serving connection, bring-up outcome and live applied set as the
    // relaunch gate, its line to `console.error` (`errors`), and the session
    // manager's held-directory query over the one hold set.
    admitSession: (rootsPath) =>
      decideSessionAdmission(rootsPath, appliedConfig().personas, {
        isPersonaUp: createPersonaUpPredicate({ status: () => SERVING }, upQuery),
        // As handleInitialized's `describePersonaNotUpByKey`: the persona's
        // bring-up state rendered by `describePersonaNotUp`; the harness's
        // bring-up outcome is `setUp`'s, a persona set down `retrying`.
        describeNotUp: (key) => describePersonaNotUp({ outcome: down.has(key) ? 'retrying' : 'up', causes: {} }),
        log: (line) => console.error(line),
        heldDirectory: oldLifeHeldDirectory,
      }),
    oldLifeWaitUnclassifiedOpen: (instanceId) => waitUnclassifiedErrors.isOpen(instanceId),

    oldLifeWaitSettled: (instanceId) => sequences._whenSettledOn(instanceId),

    settle: settleLaunches,

    approverRunning: (key) => isDialogApproverRunning(key),

    async runApproverToStop(key, maxSteps = DEFAULT_APPROVER_STEPS) {
      for (let steps = 0; ; steps++) {
        await settleLaunches()
        if (!isDialogApproverRunning(key)) return _whenDialogApproverStopped(key)
        if (steps >= maxSteps) throw new Error(`recovery harness: persona ${key}'s dialog approver still ran after ${maxSteps} steps`)
        const due = nextApproverDue()
        if (due === undefined) throw new Error(`recovery harness: persona ${key}'s dialog approver runs with no timer on the harness clock`)
        await advance(due - clock.now())
      }
    },

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
      // As main()'s shutdown (b.jg5 SRJ-706): every live-row sequence is
      // stopped now, not awaited, and none starts after it; before the
      // controller closes.
      void sequences.close()
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      episodes.close()
      waitUnclassifiedErrors.close()
      // As main()'s shutdown (b.jg5 SRJ-404): every approver is marked and
      // woken now, not awaited; none starts after it.
      void stopAllDialogApprovers()
    },

    teardown(key) {
      // As production's teardown submit (b.jg5 SRJ-404, SRJ-715): its dialog
      // approver first, and the one a launch in flight would start; not
      // awaited here (the teardown's turn awaits it).
      void stopDialogApprover(key, APPROVER_STOP_TEARDOWN)
      // As production's teardown submit (b.jg5 SRJ-706, SRJ-715): its
      // live-row sequence right after, its stop signal set now; not awaited
      // here (the teardown's turn awaits it).
      void stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN)
      controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      tmuxUnresponsive.cancelAlert(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      // As main()'s `forgetOldLifeWaits` (b.jg5 SRJ-811), right after the
      // timer's stop: the key is forgotten as waiting, and a wait no persona
      // left in the applied configuration waits on is stopped; not awaited
      // here (the teardown's turn awaits it; `oldLifeWaitSettled` reads it).
      void forgetOldLifeWaits(key)
      // As main()'s `forgetConflictLatch` (b.jg5 SRJ-504): silently, before
      // the turn's episodes forget (the case's `episodes.forget(key)`).
      latch.forget(key)
      // As main()'s `forgetInvalidFlagsHold` (b.jg5 SRJ-207, SRJ-715): right
      // after the latch, silently: no post and no retry.
      invalidFlagsHold.forget(key)
    },

    teardownDeps: () => ({
      // As main() binds them in createPersonaLifecycle (b.jg5 SRJ-404,
      // SRJ-706, SRJ-715): the approver first, then the live-row sequence.
      stopApprover: (key) => stopDialogApprover(key, APPROVER_STOP_TEARDOWN),
      stopLiveRowSequence: (key) => stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN),
      whenLaunchSettled: (key) => whenLaunchSettled(key),
      cancelLaunchWait: (key) => cancelWorkingRowWait(key),
      // b.jg5 SRJ-305, SRJ-309: the timer's stop, then the condition's alert check.
      stopRetryTimer: (key) => {
        controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
        tmuxUnresponsive.cancelAlert(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      },
      // b.jg5 SRJ-811: the session manager's teardown member, over the harness's one hold set and registry.
      forgetOldLifeWaits: (key) => forgetOldLifeWaits(key),
      // b.jg5 SRJ-504, SRJ-207, SRJ-1016: silently, each over the harness's one instance.
      forgetConflictLatch: (key) => latch.forget(key),
      forgetInvalidFlagsHold: (key) => invalidFlagsHold.forget(key),
      forgetNoticeEpisodes: (key) => episodes.forget(key),
      resetOutageState: (keys) => resetAllToHealthy(keys),
      // b.jg5 SRJ-715, SRJ-110, SRJ-702: the bounded retry on the harness's kill-retry clock.
      killInstance: (key) => killPersonaInstanceForTeardown(key, { clock: killRetryClock }),
      // b.jg5 SRJ-704: not latched, on the persona-teardown route.
      raiseKillFailureAlert: (key, decision) =>
        killFailureAlerts.raise({ key, decision, latched: false, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN }),
    }),

    remove(key) {
      applied.delete(key)
    },

    reAdd(key) {
      applied.add(key)
    },

    tickEnd: (key) => tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE),

    tickOnset: (tickStartedAt = clock.now()) => tmuxUnresponsive.onsetAtTick(tickStartedAt),

    setHealthCheckInterval(seconds) {
      config.health_check_interval = seconds
    },

    startupErrors,

    settings: () => adSettingsInEffect(),

    rewriteAdSettings(input) {
      writeAgentDirectorConfig(home, input)
      adSettingsReader.read()
    },

    advance,

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
      retriesAtOnce: [...retriesAtOnce],
      holdEndRetries: [...holdEndRetries],
      spawnCalls: [...stub.calls.spawnCalls],
      lostMessageNotices: [...lostMessageNotices],
      slackCalls: Object.fromEntries([...slackStubs].map(([key, slack]) => [key, slack.callLog])),
      stateDir: writtenFile(stateDir),
    }),

    cleanup() {
      // Every dialog approver first, so none makes a call (or arms a timer
      // through the trigger sink) after this; their timers go with them.
      _resetDialogApprovers()
      for (const handle of approverTimers) clock.clearTimeout(handle)
      approverTimers.clear()
      controller.stopAll('the recovery harness is cleaned up')
      episodes.forgetAll()
      waitUnclassifiedErrors.close()
      lostMessageDriver?.hold.cancelAll()
      lostMessageDriver = undefined
      // The version re-check first, so its own timer is not counted as left
      // pending (it is armed for as long as it is installed).
      if (recheckInstalled) resetAdVersionRecheckForTests()
      else unsubscribeVersionChanged()
      const pendingTimers = clock.pendingCount()
      const sequenceTimersPending = sequenceTimers.size
      const armed = controller.armedKeys()
      const sequencesRunning = keys.filter((key) => sequences.isRunning(key))
      const oldLifeWaitsRunning = waitsRunning()
      // A sequence or wait still running is stopped, so it makes no call after this.
      void sequences.close()
      _resetLiveRowSequenceRegistry()
      _resetOldLifeWaitBindings()
      _resetRestartState()
      _resetBackoffState()
      _resetOutageState()
      setSessionNotifier(undefined)
      setConflictLatch(undefined)
      _resetInvalidFlagsHold()
      unbindHold()
      setKillFailureAlerts(undefined)
      _resetConfiguredPersonaQuery()
      _resetRetiredKeyStore()
      removeHoldEndRetry()
      _resetOldLifeHolds()
      setPersonaKillKeepGoingQuery(undefined)
      for (const unbind of unbindLatch) unbind()
      resetStubSpawnPath()
      _resetFindMissingMemo()
      if (harnessNow) _resetNow()
      resetAdSettingsForTests()
      console.error = savedConsoleError
      if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
      else process.env['SLACK_STATE_DIR'] = savedStateDir
      rmSync(root, { recursive: true, force: true })
      if (pendingTimers !== 0 || armed.length !== 0 || sequencesRunning.length !== 0 || oldLifeWaitsRunning.length !== 0) {
        throw new Error(
          `recovery harness: ${pendingTimers} timer(s) still pending (${sequenceTimersPending} of them live-row sequence or old-life wait timers), ${armed.length} persona(s) still armed after stopAll, live-row sequences still running for ${JSON.stringify(sequencesRunning)} and old-life waits still running on ${JSON.stringify(oldLifeWaitsRunning)} at cleanup`,
        )
      }
    },
  }
}

/**
 * What the latch's notice reaction gets: `episodes`' own `begin`, `post` and
 * `end` (the reaction's silent end of the other latch kinds' episodes on a
 * set, b.jg5 SRJ-512), with each post that went out (a CONFLICT or a hold
 * notice) also handed to `posted` once the episodes' sink has it. Nothing
 * else changes.
 */
function recordingNoticeEpisodes(
  episodes: PersonaEpisodes,
  posted: (key: string, text: string) => void,
): ConflictNoticeEpisodes {
  return {
    begin: (key, kind, caseLabel) => episodes.begin(key, kind, caseLabel),
    end: (key, kind) => episodes.end(key, kind),
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
 * Persona `key`'s own row as a `get` reads it (`cannedGetResult` in persona
 * form: its `cwd`, labels and instance id, live `waiting` by default), with
 * `overrides`.
 */
export function personaRow(h: RecoveryHarness, key: string, overrides: PersonaGetResultOverrides = {}): CannedGetResult {
  return cannedGetResult(overrides, personaOf(h, key), h.home)
}

/** How the retired-key store's lines name key `key`: `persona=<key>`, the key JSON-quoted unless it is a persona key. */
function retiredKeyRef(key: string): string {
  return `persona=${PERSONA_KEY_RE.test(key) ? key : JSON.stringify(key)}`
}

/** How the retired-key store's clear lines name the read that cleared (b.jg5 SRJ-807): the state it read and the site's `<site>: <what>`. */
function retiredClearReadText(state: string, at: Pick<OwnRowReadSite, 'site' | 'what'>): string {
  return `its row read ${state} with its mark set (${at.site}: ${at.what})`
}

/**
 * The retired-key store's one line for a clear of persona `key`'s entry from
 * the record at `path`, on its row read `state` at `at` (b.jg5 SRJ-807).
 */
export function retiredEntryClearedLine(path: string, key: string, state: string, at: Pick<OwnRowReadSite, 'site' | 'what'>): string {
  return `${RETIRED_KEYS_LOG_PREFIX} ${retiredKeyRef(key)} entry cleared from ${JSON.stringify(path)} on ${retiredClearReadText(state, at)} (b.jg5 SRJ-807)`
}

/**
 * The retired-key store's one line for that clear when its write was refused
 * before it touched the file (`failRetiredKeyWrites`): the entry stays.
 */
export function retiredEntryClearFailedLine(path: string, key: string, state: string, at: Pick<OwnRowReadSite, 'site' | 'what'>): string {
  return (
    `${RETIRED_KEYS_LOG_PREFIX} cannot clear ${retiredKeyRef(key)} from ${JSON.stringify(path)} on ${retiredClearReadText(state, at)} ` +
    `(${RECOVERY_RETIRED_KEY_WRITE_FAILURE_CODE}); the file is unchanged; the entry stays, and the next qualifying read clears it again (b.jg5 SRJ-807)`
  )
}

/** The retired-key store's lines among `lines`, in order. */
export function retiredKeyLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${RETIRED_KEYS_LOG_PREFIX} `))
}

/**
 * Move the harness clock, with no timer pending yet, to G (the grace in
 * effect, `adGraceMsInEffect`) past the stub's sample launch start
 * (`SAMPLE_LAUNCH_START_DEFAULT`): a `pending` row read from then on is waited
 * on no longer.
 */
export async function pastSampleGrace(h: RecoveryHarness): Promise<void> {
  expect(h.clock.pendingCount()).toBe(0)
  await h.clock.advanceTo(parseLaunchStart(SAMPLE_LAUNCH_START_DEFAULT)! + adGraceMsInEffect())
}

/** An UNAVAILABLE answer (`ErrCallTimeout`, built by name) of a call of `verb`. */
export function unavailableAt(verb: string): Error {
  return unavailableForms('ErrCallTimeout')[0]![1](verb)
}

/**
 * Persona `other` was left alone: no trigger, no armed timer, no outage or
 * session-manager notice, no outage flag, and no stub call of its instance.
 */
export function expectUntouched(h: RecoveryHarness, other: string): void {
  expect(h.triggers.filter((t) => t.key === other)).toEqual([])
  expect(h.controller.isArmed(other)).toBe(false)
  expect(h.outageNotices.filter((n) => n.key === other)).toEqual([])
  expect(h.notices.filter((n) => n.key === other)).toEqual([])
  expect(getOutageFlags(other).size).toBe(0)
  const otherId = personaInstanceId(other)
  const calls = Object.values(h.stub.calls).flat() as Array<{ claude_instance_id?: unknown }>
  expect(calls.filter((params) => params?.claude_instance_id === otherId)).toEqual([])
}

/**
 * Persona `key`'s retry timer watches a `pending` row (b.jg5 SRJ-301,
 * SRJ-409): armed and waiting in pending-only mode with the pending-row
 * cause among its recorded causes, and a pending-row trigger recorded for it
 * (the trigger sink's pending-only arm). A timer already in full mode keeps
 * its mode on a pending-only arm, so a case expecting that reads
 * `controller.view(key)` itself.
 */
export function expectPendingOnlyWatch(h: RecoveryHarness, key: string): void {
  const view = h.controller.view(key)
  expect(view).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY })
  expect(view?.causes).toContain(UNAVAILABLE_RETRY_CAUSE_PENDING_ROW)
  expect(h.triggers).toContainEqual({ key, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW })
}

/** States 1 to 5 of SRJ-1011: those that apply before the lost-message row read is made. */
const EARLY_LOST_MESSAGE_STATES: readonly LostMessageState[] = LOST_MESSAGE_STATES.slice(0, LOST_MESSAGE_STATES.indexOf('session-starting'))

/**
 * Lose one message for persona `key` through the driver (`h.loseMessage`)
 * and assert what it reports: `state`, with its exported wording; exactly
 * the stub calls `opts.calls` (by verb), by default none in states 1 to 5
 * and, in any later state, one `statusCalls`, the routing's row read (b.jg5
 * SRJ-1011; nothing in flight for the persona), every `status` among them of
 * the persona's own instance; and no restart asked for or pending, unless
 * `opts.restartRequested` (then the ask must be seen, and whether one is
 * pending is the case's to check on the outcome). Resolves with the outcome.
 */
export async function expectLostMessageReports(
  h: RecoveryHarness,
  key: string,
  state: LostMessageState,
  opts: { calls?: Record<string, number>; restartRequested?: boolean } = {},
): Promise<LostMessageOutcome> {
  const calls = opts.calls ?? (EARLY_LOST_MESSAGE_STATES.includes(state) ? {} : { statusCalls: 1 })
  const restartRequested = opts.restartRequested ?? false
  const statusBefore = h.stub.calls.statusCalls.length
  const outcome = await h.loseMessage(key)
  expect([key, outcome]).toEqual([key, {
    state,
    notice: expect.stringContaining(STATE_WORDING[state]),
    restartRequested,
    restartPending: restartRequested ? expect.any(Boolean) : false,
    calls,
  }])
  const instance = { claude_instance_id: personaInstanceId(key) }
  expect(h.stub.calls.statusCalls.slice(statusBefore)).toEqual(Array.from({ length: calls['statusCalls'] ?? 0 }, () => instance))
  return outcome
}

/**
 * Install, in the harness registry's place, a live-row sequence registry that
 * records each start request and answers started, running nothing; answers
 * the record, so a case reads the whole request a start was given. The
 * harness's cleanup removes it.
 */
export function recordSequenceStarts(): LiveRowSequenceRequest[] {
  const starts: LiveRowSequenceRequest[] = []
  setLiveRowSequenceRegistry({
    start: (request) => {
      starts.push(request)
      return LIVE_ROW_START_STARTED
    },
    stop: async () => false,
    stopNoLaunch: async () => false,
    stopAll: async () => {},
    close: async () => {},
    isRunning: () => false,
    isNoLaunchRunning: () => false,
    _whenSettled: async () => undefined,
    _whenSettledOn: async () => undefined,
  })
  return starts
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

/**
 * Script persona `key`'s next launch (b.jg5 SRJ-207): its optimistic spawn
 * collides and the collision `get` reads its row `ended` in another
 * directory (the harness HOME), so the launch replaces the row by a reuse
 * spawn of the same id, which answers `err` (an `ErrInvalidFlags` of
 * `spawn` by default).
 */
export function scriptReuseInvalidFlags(h: RecoveryHarness, key: string, err: Error = errInvalidFlags('spawn')): void {
  h.script(collided(h, personaOf(h, key), { cwd: h.home, state: LIVENESS_DEAD_ROW_ENDED }, err))
}

/**
 * Hold persona `key` through a real reuse (b.jg5 SRJ-207): its start-pass
 * launch (`h.launch`) over the row `scriptReuseInvalidFlags` scripts, whose
 * reuse spawn answers `ErrInvalidFlags`. Asserts the launch answered `held`
 * and the harness's hold holds `key`.
 */
export async function holdThroughReuse(h: RecoveryHarness, key: string): Promise<void> {
  scriptReuseInvalidFlags(h, key)
  expect(await h.launch(key)).toStrictEqual({ key, action: 'held' })
  expect(h.invalidFlagsHold.isHeld(key)).toBe(true)
}

/**
 * Script persona `key`'s next launch to meet its own row read `waiting`
 * (live) in another directory (the harness HOME) at a collision ladder
 * replacement site (b.jg5 SRJ-707): the optimistic spawn collides and the
 * collision `get` reads that row, so the ladder starts the persona's
 * live-row sequence and answers `sequence-waiting` with no call of its own;
 * every later `get` of the row (the sequence's) reads it `ended` in the
 * persona's own directory, so a sequence whose kill succeeds goes on to its
 * one run and a reuse spawn of the same id. `script` is applied on top.
 */
export function scriptLiveRowElsewhere(h: RecoveryHarness, key: string, script: RecoveryStubScript = {}): void {
  const persona = personaOf(h, key)
  h.script({
    spawnQueue: [cannedErr<SpawnResult>(errInstanceIdCollision())],
    getQueue: [cannedOk(cannedGetResult({ cwd: h.home, state: cannedStatusResult().state }, persona, h.home))],
    getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, persona, h.home),
    ...script,
  })
}

/**
 * Launch persona `key` (`h.launch`, the start pass's launch) over the row
 * `scriptLiveRowElsewhere` scripted: the launch answers `sequence-waiting` at
 * once; then the sequence it started is driven on the clock to its end
 * (`driveSequence`). Resolves with the sequence's outcome.
 */
export async function launchThroughSequence(h: RecoveryHarness, key: string): Promise<LiveRowSequenceOutcome> {
  expect(await h.launch(key)).toStrictEqual({ key, action: 'sequence-waiting' })
  const outcome = await h.driveSequence(h.sequenceSettled(key))
  expect(h.sequenceRunning(key)).toBe(false)
  if (outcome === undefined) throw new Error(`launchThroughSequence: persona ${key}'s sequence settled with no outcome`)
  return outcome
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
 *
 * With `during`, the call at position `during.at` of the list runs
 * `during.run` once it has its answer, before its caller gets it (for
 * example, to latch a persona elsewhere while that call is in progress).
 */
export function recordCallOrder(h: RecoveryHarness, during?: { readonly at: number; run(): void }): string[] {
  const order: string[] = []
  const client = h.stub.client as unknown as Record<string, unknown>
  for (const name of Object.keys(client)) {
    const verb = client[name]
    if (typeof verb !== 'function') continue
    client[name] = (...args: unknown[]): unknown => {
      const position = order.push(name) - 1
      const result = (verb as (...a: unknown[]) => unknown).apply(client, args)
      return position === during?.at ? Promise.resolve(result).finally(() => during.run()) : result
    }
  }
  return order
}

/**
 * A kill answer the live-row sequence gets after it was stopped (b.jg5
 * SRJ-706): its label, its builder, and the tries the bounded retry makes of
 * a row read live before that answer stands (an UNAVAILABLE one is tried
 * again until its tries are used; a CONFLICT never is).
 */
export type LateKillAnswer = readonly [label: string, make: () => Error, tries: number]

/** The late kill answers a stop must drop: UNAVAILABLE and `ErrTmuxKillFailed` with their tries used, and CONFLICT. */
export const LATE_KILL_ANSWERS: readonly LateKillAnswer[] = [
  ['UNAVAILABLE (ErrTmuxUnresponsive), its tries used', () => errTmuxUnresponsive('kill'), KILL_RETRY_TRIES],
  ['ErrTmuxKillFailed, its tries used', () => errTmuxKillFailed(), KILL_RETRY_TRIES],
  ['CONFLICT', () => errTmuxSessionConflict('kill', 'not-this-launch'), 1],
]

/** The calls a live-row sequence over a row read live makes before its step-`step` kill: none, or step 1's kill, the step-2 get and step 3's runs, each with its get. */
export function callsBeforeSequenceKill(step: 1 | 4): string[] {
  if (step === 1) return []
  return ['kill', 'get', ...Array.from({ length: LIVE_ROW_SEQUENCE_STEP3_RUNS }, () => ['findMissing', 'get']).flat()]
}

/** Every kill answers success but the step-`step` kill of a live-row sequence, which answers `err()` at each try. */
export function scriptSequenceKillFailure(h: RecoveryHarness, step: 1 | 4, err: () => Error): void {
  h.script(step === 1 ? { killError: err() } : { killQueue: [cannedOk(cannedKillResult(true))], killError: err() })
}

/**
 * Run one live-row sequence for persona `key` over its own row read live
 * (`waiting`) at every `get`, every run judging it alive, whose step-`step`
 * kill answers `answer` at each try (`scriptSequenceKillFailure`); the
 * sequence's stop is set with `reason` as that kill's last try gets its
 * answer, before the sequence reads it. Resolves, once the sequence is
 * driven to its end, with its outcome and every stub call in order
 * (`recordCallOrder`).
 */
export async function runSequenceStoppedAtKill(
  h: RecoveryHarness,
  key: string,
  step: 1 | 4,
  answer: LateKillAnswer,
  reason: LiveRowSequenceStopReason,
): Promise<{ readonly outcome: LiveRowSequenceOutcome; readonly order: string[] }> {
  const [, make, tries] = answer
  h.script({ getResult: personaRow(h, key) })
  scriptSequenceKillFailure(h, step, make)
  let run: RecoverySequenceRun | undefined
  // Each further try follows one status read: the last try is the call at this position.
  const lastTry = callsBeforeSequenceKill(step).length + 2 * (tries - 1)
  const order = recordCallOrder(h, { at: lastTry, run: () => void run?.stop(reason) })
  run = h.startSequence(key, { lastReadState: cannedStatusResult().state })
  const outcome = await h.driveSequence(run.outcome)
  return { outcome, order }
}

/**
 * Start persona `key`'s live-row sequence through the harness's start entry
 * (`startSequence`, a row last read live and the request's other defaults
 * unless `request` says otherwise) and resolve once its next `find-missing`
 * run is held by `hold` (`holdFindMissing` over the harness's stub client),
 * moving the clock to each sequence timer on the way (`driveSequence`: a
 * `pending` row's wait until G), so the sequence is running with that run
 * outstanding (b.jg5 SRJ-706). The case scripts the sequence's `get`
 * answers.
 */
export async function startSequenceHeldAtRun(
  h: RecoveryHarness,
  key: string,
  hold: FindMissingHold,
  request: Partial<RecoverySequenceRequest> = {},
): Promise<RecoverySequenceRun> {
  const runsBefore = hold.calls.length
  const run = h.startSequence(key, { lastReadState: cannedStatusResult().state, ...request })
  await h.driveSequence(hold.entered(runsBefore + 1))
  return run
}

/**
 * Script every persona's own row at each `get` of it (`cannedGetResult` in
 * its own directory with its labels): live (`waiting`) at its first `get`,
 * `missing` from then on. A sequence held at its first run
 * (`startSequenceHeldAtRun`) whose run is released with the row placed in
 * `ids` then reads it missing and goes on to its launch, a reuse of the id.
 */
export function ownRowsLiveThenMissing(h: RecoveryHarness): void {
  const read = new Set<string>()
  h.script({
    getFn: (params) => {
      const key = h.keys.find((k) => personaInstanceId(k) === params.claude_instance_id)
      if (key === undefined) throw new Error(`recovery harness: no configured persona has the instance id ${String(params.claude_instance_id)}`)
      const first = !read.has(key)
      read.add(key)
      return personaRow(h, key, first ? {} : { state: LIVENESS_DEAD_ROW_MISSING })
    },
  })
}

/**
 * Persona `key`'s reuse spawn as the stub records it (b.jg5 SRJ-112,
 * SRJ-708), for `toEqual`: a `spawn` of `cscb_<key>` with the reuse flag set
 * and the persona's `extra_env` (`personaSpawnEnv`, prompt suggestions off).
 */
export function reuseSpawnOf(h: RecoveryHarness, key: string): Phase1SpawnParams {
  const persona = personaOf(h, key)
  return expect.objectContaining({
    claude_instance_id: personaInstanceId(key),
    reuse_finished: true,
    extra_env: personaSpawnEnv({ key, crontablePath: h.config.cron_table_path, claudeConfigDir: persona.claude_config_dir }),
  })
}

/**
 * Hold persona `key`'s spawns open at the stub (`holdSpawns` over the
 * harness's stub client, only `cscb_<key>`) until `release()`, which answers
 * the held spawn with success: `entered` resolves once a live-row sequence's
 * step-6 reuse spawn of `key` has been made, so the sequence's own launch is
 * in flight (`isLaunchInFlight`) while the case drives other work. `calls`
 * holds the spawns the hold received, the held reuse's parameters included
 * (a held spawn is not in the stub's own log).
 */
export function holdSequenceReuse(
  h: RecoveryHarness,
  key: string,
): { readonly entered: Promise<void>; readonly calls: readonly Phase1SpawnParams[]; release(): void } {
  const id = personaInstanceId(key)
  const hold = holdSpawns(h.stub.client, (spawned) => spawned === id)
  return { entered: hold.entered(id), calls: hold.calls, release: () => hold.release(id) }
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
 * that instance resolves, and `waiting` from then on. A `pending` `before`
 * row shows the stub's default launch start unless `options` has a
 * `launchStartedAt` key: its value is the row's launch start then
 * (`SAMPLE_LAUNCH_START_NONE` leaves the field out, `null` shows it as
 * `null`). Returns the `statusFn` it scripts, so a case that scripts one
 * persona's reads itself can hand every other persona's to it.
 */
export function rowReadsUntilSpawn(
  h: RecoveryHarness,
  before: RecoveryRowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT,
  options: { launchStartedAt?: string | null } = {},
): NonNullable<RecoveryStubScript['statusFn']> {
  const beforeRow = 'launchStartedAt' in options ? { state: before, launch_started_at: options.launchStartedAt } : { state: before }
  const live = new Set<string>()
  const client = h.stub.client
  const spawn = client.spawn.bind(client)
  client.spawn = async (params) => {
    const result = await spawn(params)
    live.add(String(params.claude_instance_id))
    return result
  }
  const statusFn: NonNullable<RecoveryStubScript['statusFn']> = (params) => {
    if (live.has(String(params.claude_instance_id))) return cannedStatusResult()
    return before === UNAVAILABLE_RETRY_ROW_ABSENT ? errSpawnNotFound() : cannedStatusResult(beforeRow)
  }
  h.script({ statusFn })
  return statusFn
}

/** `scriptTimedLaunch`'s end for a call that succeeds (answered by the verb's other knobs). */
export const TIMED_LAUNCH_SUCCESS = 'success'

/** How `scriptTimedLaunch`'s call ends: either launch-timeout form (`src/ad-error-class.ts`), or success. */
export type TimedLaunchEnd = LaunchTimeoutForm | typeof TIMED_LAUNCH_SUCCESS

/**
 * Where `scriptTimedLaunch` places the row's launch start against the call's
 * window `[start, end]` (b.jg5 SRJ-407; both ends belong to the window):
 * `at-start` and `at-end` on a bound, `inside` at `start + floor(takes / 2)`,
 * `before` at `start - offMs`, `after` at `end + offMs`, `none` with no
 * launch start (`SAMPLE_LAUNCH_START_NONE`: the field left out).
 */
export type TimedLaunchStart = 'at-start' | 'inside' | 'at-end' | 'before' | 'after' | 'none'

/** Options of `scriptTimedLaunch`; every one is optional. */
export interface TimedLaunchOptions {
  /** The launch verb to time: `spawn` (plain or reuse) by default, or `resume`. */
  readonly verb?: 'spawn' | 'resume'
  /** For `spawn`: time only a reuse spawn (true) or only a plain one (false); either when unset. */
  readonly reuse?: boolean
  /** How long the call takes on the harness clock, in ms (0 by default). */
  readonly takesMs?: number
  /** How the call ends: `LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT` by default. */
  readonly end?: TimedLaunchEnd
  /** Where the row's launch start lies against the call's window: `inside` by default. */
  readonly launchStart?: TimedLaunchStart
  /** How far `before` and `after` lie outside the window, in ms (1 by default). */
  readonly offMs?: number
  /** The persona's row as `get` reads it from the call's end on (`personaRow` overrides); `{ state: 'pending' }` by default. */
  readonly row?: PersonaGetResultOverrides
}

/** The handle `scriptTimedLaunch` returns. */
export interface TimedLaunch {
  /** What the call ends with: the error it rejects with, or undefined for success. */
  readonly error: Error | undefined
  /** The call's window as the stub saw it on the harness clock (no `endMs` while the call is in progress); undefined before the call. */
  window(): LaunchCallWindow | undefined
  /** The launch start the row carries (ISO 8601), placed once the call ends; undefined before that or for `none`. */
  launchStartedAt(): string | undefined
  /** The persona's row as `get` reads it now; throws before the call ends. */
  row(): CannedGetResult
  /** Replace the row overrides `get` reads from now on; the placed launch start stays unless `overrides` give `launch_started_at`. */
  setRow(overrides: PersonaGetResultOverrides): void
  /**
   * A `status` answer for the row (`cannedStatusResult`): `pending` with the
   * placed launch start, with `overrides`. The driver scripts no `status`;
   * a case hands this to its own `statusFn` or `statusQueue` (an approver's
   * lap reads `status`). Throws before the call ends.
   */
  statusRow(overrides?: Partial<Phase1StatusResult>): Phase1StatusResult
}

/**
 * Script persona `key`'s next launch call of `options.verb` (b.jg5 SRJ-407)
 * through the stub's per-call knobs (`spawnFn`, `resumeFn`, `getFn`):
 *
 * - The first matching call (persona `key`'s instance; for `spawn`, of the
 *   kind `options.reuse` asks for) takes `takesMs` on the harness clock: the
 *   stub moves the clock (`clock.advance`, so harness-clock timers due by
 *   then fire) while the call is in progress, then ends it with `end`:
 *   `errCallTimeout(verb)`, `errTmuxUnresponsiveLaunchTimeout(verb, id)`, or
 *   success, which leaves the answer to the verb's other knobs (the stub's
 *   default success when none). The harness must be built with
 *   `harnessNow` (it throws otherwise), so the harness clock is the session
 *   manager's `_setNow` clock and the window the session manager records
 *   for the call (`launchCallWindowOf`) is the handle's `window()`.
 * - Every other call of the verb goes to the knob scripted before (its
 *   `spawnFn` or `resumeFn`), then to the verb's other knobs.
 * - From the call's end on, every `get` of persona `key`'s instance reads
 *   `personaRow(h, key, row)` with the launch start placed by
 *   `options.launchStart` against the window, as an ISO 8601 string. Every
 *   other `get` goes to the `getFn` scripted before, then to the other `get`
 *   knobs. A case that scripts its own `getFn` afterwards replaces this.
 *
 * A row in the `pending` state with its launch start inside the window
 * (`at-start`, `inside`, `at-end`) is this launch's row; `before`, `after`
 * and `none` are not. Script it before the launch, then drive the launch
 * (`h.launch(key)`, a retry, a restart path call).
 */
export function scriptTimedLaunch(h: RecoveryHarness, key: string, options: TimedLaunchOptions = {}): TimedLaunch {
  if (!h.harnessNow) throw new Error('scriptTimedLaunch: build the harness with { harnessNow: true }, so the session manager reads the launch window on the harness clock')
  const id = personaInstanceId(key)
  const verb = options.verb ?? 'spawn'
  const takesMs = options.takesMs ?? 0
  const end = options.end ?? LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT
  const offMs = options.offMs ?? 1
  const placement = options.launchStart ?? 'inside'
  const error =
    end === TIMED_LAUNCH_SUCCESS ? undefined
    : end === LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT ? errCallTimeout(verb)
    : errTmuxUnresponsiveLaunchTimeout(verb, id)
  const knobs = h.stub.calls as StubClientOptions
  let rowOverrides: PersonaGetResultOverrides = options.row ?? { state: 'pending' }
  let window: LaunchCallWindow | undefined
  let launchStartMs: number | undefined
  let timed = false

  const placedStart = (startMs: number, endMs: number): number | undefined => {
    switch (placement) {
      case 'at-start': return startMs
      case 'inside': return startMs + Math.floor((endMs - startMs) / 2)
      case 'at-end': return endMs
      case 'before': return startMs - offMs
      case 'after': return endMs + offMs
      case 'none': return undefined
    }
  }
  const launchStartedAt = (): string | undefined => (launchStartMs === undefined ? undefined : new Date(launchStartMs).toISOString())
  const ended = (): boolean => window?.endMs !== undefined
  const row = (): CannedGetResult => {
    if (!ended()) throw new Error(`scriptTimedLaunch: persona ${key}'s timed ${verb} has not ended`)
    return personaRow(h, key, { launch_started_at: launchStartedAt() ?? SAMPLE_LAUNCH_START_NONE, ...rowOverrides })
  }
  // The timed call: take `takesMs` on the harness clock, place the launch
  // start, then end the call as asked.
  const timedCall = async (): Promise<Error | undefined> => {
    timed = true
    const startMs = h.clock.now()
    window = { startMs }
    if (takesMs > 0) await h.clock.advance(takesMs)
    const endMs = h.clock.now()
    launchStartMs = placedStart(startMs, endMs)
    window = { startMs, endMs }
    return error
  }

  if (verb === 'spawn') {
    const before = knobs.spawnFn
    h.script({
      spawnFn: (params) => {
        const kind = options.reuse === undefined || (params.reuse_finished === true) === options.reuse
        if (!timed && String(params.claude_instance_id) === id && kind) return timedCall()
        return before?.(params)
      },
    })
  } else {
    const before = knobs.resumeFn
    h.script({
      resumeFn: (params) => {
        if (!timed && String(params.claude_instance_id) === id) return timedCall()
        return before?.(params)
      },
    })
  }
  const beforeGet = knobs.getFn
  h.script({
    getFn: (params) => (ended() && params.claude_instance_id === id ? row() : beforeGet?.(params)),
  })

  return {
    error,
    window: () => window,
    launchStartedAt,
    row,
    setRow(overrides) {
      rowOverrides = overrides
    },
    statusRow(overrides = {}) {
      if (!ended()) throw new Error(`scriptTimedLaunch: persona ${key}'s timed ${verb} has not ended`)
      return cannedStatusResult({ state: 'pending', launch_started_at: launchStartedAt() ?? SAMPLE_LAUNCH_START_NONE, ...overrides })
    },
  }
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

// The kill-failure alert's texts as the harness captures them (b.jg5
// SRJ-704, SRJ-1007), each built with `src/kill-failure-alert.ts`'s builders
// for persona `key`'s own session and instance id; every description is the
// thrown value's own (`killFailedDescriptionOf`), raw, so the builders redact
// it as the alert does.

/** The raw description an `ErrTmuxKillFailed` carries; throws when `err` carries none. */
function killFailedDescription(err: Error): string {
  const description = killFailedDescriptionOf(err)
  if (description === undefined) throw new Error('recovery harness: the value is no ErrTmuxKillFailed with a description')
  return description
}

/**
 * The ordinary version's content for persona `key`'s own row: quoting the
 * description of `last` (the standing `ErrTmuxKillFailed`) and of
 * `earlierSurvivor` (an earlier try's survivor-naming one), each when given;
 * neither leaves the "agent-director said" sentence out.
 */
export function ordinaryAlertContent(key: string, quoted: { last?: Error; earlierSurvivor?: Error } = {}): KillFailureAlertContent {
  return {
    version: KILL_FAILURE_VERSION_ORDINARY,
    session: personaTmuxSessionName(key),
    instanceId: personaInstanceId(key),
    quotes: {
      ...(quoted.last === undefined ? {} : { lastKillFailedDescription: killFailedDescription(quoted.last) }),
      ...(quoted.earlierSurvivor === undefined ? {} : { earlierSurvivorDescription: killFailedDescription(quoted.earlierSurvivor) }),
    },
  }
}

/** The survivor version's content for persona `key`'s own session, quoting `survivor`'s description. */
export function survivorAlertContent(key: string, survivor: Error): KillFailureAlertContent {
  return { version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(key), survivorDescription: killFailedDescription(survivor) }
}

/**
 * The alert at persona `key`'s destination, as `episodeNotices` holds it:
 * the Slack text with `closing` (the destination sentence by default; the
 * latched one with `KILL_FAILURE_CLOSING_DESTINATION_LATCHED`).
 */
export function killFailureNotice(key: string, content: KillFailureAlertContent, closing: KillFailureClosing = KILL_FAILURE_CLOSING_DESTINATION): RecoveryNotice {
  return { key, text: killFailureAlertText(content, closing, true) }
}

/**
 * The startup-errors entry of an alert the restart path or a live-row
 * sequence (one the collision ladder started included) raised for persona `key` no longer in the
 * applied configuration: `persona=<key> (<context>): <text>`, the context
 * `recovery` by default, the unescaped text with the log-only closing
 * sentence of its version.
 */
export function killFailureRecoveryEntry(
  key: string,
  content: KillFailureAlertContent,
  context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY,
): string {
  return killFailureAlertEntryText(`persona=${key}`, context, killFailureAlertText(content, KILL_FAILURE_CLOSING_LOG_ONLY, false))
}

/** The harness's startup-errors entries of class `classLabel`, each the text after its timestamp and class, in order. */
export function startupEntriesOf(h: RecoveryHarness, classLabel: string): string[] {
  const marker = `] [${classLabel}] `
  return h.startupErrors().flatMap((line) => {
    const at = line.indexOf(marker)
    return at === -1 ? [] : [line.slice(at + marker.length)]
  })
}

/** Every startup-errors entry the harness wrote, each as its class and its text (no timestamp), in order; a line that is no entry throws. */
export function startupEntries(h: RecoveryHarness): Array<readonly [string, string]> {
  return h.startupErrors().map((line) => {
    const match = /^\[[^\]]+\] \[([^\]]+)\] (.*)$/.exec(line)
    if (match === null) throw new Error(`recovery harness: not a startup-errors entry: ${line}`)
    return [match[1]!, match[2]!] as const
  })
}

/** The prefix of every line persona `key`'s kill-failure alerts log. */
function killFailureLinePrefix(key: string): string {
  return `[slack] persona-episodes: persona=${key} ${PERSONA_EPISODE_KIND_KILL_FAILURE} `
}

/** Persona `key`'s kill-failure alert lines (the alerts' own, in `lines`), in order. */
export function killFailureLines(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.startsWith(killFailureLinePrefix(key)))
}

// The kill-failure alerts' own log lines (`createKillFailureAlerts`,
// `src/persona-episodes.ts`), each for the context `recovery` unless a
// builder takes another (a live-row sequence's request context). As the
// condition's lines above, the fixed words are held here (pinned as literals
// only in tests/persona-episodes.test.ts); the kind, the versions, the
// closings, the classes and the rendering of the descriptions come from `src/`.

/** The line of persona `key`'s episode ended silently for `reason`. */
export function killFailureEndedLine(key: string, reason: KillFailureEndReason): string {
  return `${killFailureLinePrefix(key)}ended — ${reason}`
}

/**
 * The line of `content`'s alert posted at persona `key`'s destination with
 * `context` (`recovery` by default): the ordinary version names its
 * `closing` (the not-latched one by default); the survivor version names
 * none.
 */
export function killFailurePostedLine(
  key: string,
  content: KillFailureAlertContent,
  closing: KillFailureClosing = KILL_FAILURE_CLOSING_DESTINATION,
  context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY,
): string {
  const where = content.version === KILL_FAILURE_VERSION_ORDINARY ? `${context}; ${closing}` : context
  return `${killFailureLinePrefix(key)}${content.version} alert posted to its destination (${where})`
}

/** The line of an ordinary alert held back: its episode's alert already posted. */
export function killFailureHeldLine(key: string): string {
  return `${killFailureLinePrefix(key)}${KILL_FAILURE_VERSION_ORDINARY} alert not posted — its episode's alert already posted`
}

/** The line of a `version` alert written through the log-only route as one `classLabel` entry, naming `route`. */
export function killFailureLoggedLine(key: string, version: KillFailureAlertVersion, classLabel: string, route: string): string {
  return `${killFailureLinePrefix(key)}${version} alert written to the server log and startup-errors.log (${classLabel}) — ${route}`
}

/**
 * The stopped-retry text (`killFailureStoppedRetryText`, b.jg5 SRJ-702) of an
 * ordinary decision whose tries were stopped for `cause`, at the restart path
 * (context `recovery`): the decision quotes `quoted`'s descriptions, as
 * `ordinaryAlertContent` takes them, and the last outcome's class is
 * `lastOutcomeClass` (`AD_ERROR_CLASS_UNAVAILABLE` for a standing
 * `ErrTmuxKillFailed` by default).
 */
function killFailureStoppedRecovery(
  key: string,
  cause: string,
  quoted: { last?: Error; earlierSurvivor?: Error },
  lastOutcomeClass: string,
): { readonly line: string; readonly entry: string } {
  const decision: KillRetryAlert = {
    kind: KILL_RETRY_ALERT_ORDINARY,
    ...(quoted.last === undefined ? {} : { lastKillFailedDescription: killFailedDescription(quoted.last) }),
    ...(quoted.earlierSurvivor === undefined ? {} : { earlierSurvivorDescription: killFailedDescription(quoted.earlierSurvivor) }),
  }
  return killFailureStoppedRetryText({ key, decision, context: KILL_FAILURE_CONTEXT_RECOVERY, lastOutcomeClass, stopCause: cause })
}

/** The one line of an ordinary decision whose tries were stopped for `cause` (b.jg5 SRJ-702): see `killFailureStoppedRecovery`. */
export function killFailureNotRaisedLine(
  key: string,
  cause: string,
  quoted: { last?: Error; earlierSurvivor?: Error } = {},
  lastOutcomeClass: string = AD_ERROR_CLASS_UNAVAILABLE,
): string {
  return killFailureStoppedRecovery(key, cause, quoted, lastOutcomeClass).line
}

/**
 * The `persona-kill-failed` entry of a stopped retry for persona `key` no
 * longer in the applied configuration (b.jg5 SRJ-702, SRJ-1013): the stop's
 * line content with the context `recovery`, and no alert text.
 */
export function killFailureStoppedEntry(
  key: string,
  cause: string,
  quoted: { last?: Error; earlierSurvivor?: Error } = {},
  lastOutcomeClass: string = AD_ERROR_CLASS_UNAVAILABLE,
): string {
  return killFailureStoppedRecovery(key, cause, quoted, lastOutcomeClass).entry
}

/** The line of a stopped retry's `persona-kill-failed` entry, after its not-raised line (b.jg5 SRJ-702). */
export function killFailureStoppedEntryLine(key: string): string {
  return `${killFailureLinePrefix(key)}stopped retry's log line (no alert text) written to the server log and startup-errors.log (${PERSONA_KILL_FAILED_LABEL}) — stopped`
}

/** The outage class a CONFIG answer raises (b.jg5 SRJ-316). */
const AD_CONFIG_MALFORMED_CLASS: OutageClass = 'ad-config-malformed'

/** The outage state's raise lines for persona `key`'s `ad-config-malformed` outage (one per raise), in `errors`. */
export function adConfigMalformedRaiseLines(h: RecoveryHarness, key: string): string[] {
  return h.errors.filter((line) => line.startsWith(`[slack] outage-state: ${AD_CONFIG_MALFORMED_CLASS} raised for persona=${key}: `))
}
