/**
 * server-startup-wiring.test.ts — The server's start-up wiring after the
 * loader switch (b.av2 SR-3.1, SR-10.2, SR-8.7, SR-13.2).
 *
 * - SR-3.1: no Slack client is built and no token is read at module scope in
 *   src/server.ts; the connection manager is built inside main().
 * - SR-10.2: `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` are neither required nor
 *   read by the server; only src/cli.ts still names them.
 * - SR-8.7: the `MCP_HOST` / `MCP_PORT` fallback is gone; main() resolves the
 *   start through the reload controller (the last-applied record when there
 *   is one, else the required config file), exits on a refused start, sets
 *   the applied config from the outcome, and requests the start bring-up from
 *   the controller, whose lifecycle runs `startupSessionManager` over the
 *   config the controller hands it.
 * - SR-13.2: importing src/server.ts touches nothing under HOME. Before the
 *   switch the import read the token variables (exiting without them) and
 *   created `~/.claude/channels/slack`; main() now creates the state and
 *   inbox directories.
 * - The connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2): the manager's dry
 *   run and up→flush listener, the outage state's notify passing its options
 *   to the persona notifier (b.jg5 SRJ-1002, SRJ-1003), `connections = <manager>`, `clientFor` and
 *   `identityFor` over the connection view, the routing's identity, client,
 *   archive and notice (`notify`, the persona notifier's, SR-7.3) seams, and
 *   the archive writer's per-persona resolver source.
 * - The integration suite's Slack API base URL override (E14 Task 4):
 *   `CSCB_SLACK_API_URL` resolved once in main(), before the manager is
 *   built, from `process.env`, and passed to it as `slackApiUrl`; no other
 *   src file names the variable.
 * - The one destination resolver (SR-7.1): built at module scope and shared
 *   by the persona notifier and the permission poller.
 * - The bring-up controller (SR-6.1, SR-6.4): the start's bring-up, told
 *   every connection status, stored for shutdown and cancelled there before
 *   the connections stop; the health check started only after the start
 *   bring-up returns. Its launch and its live applied set (`appliedPersonas`)
 *   read the applied config at call time (SR-8.6). Bug b.g57: it checks a
 *   persona's claude_config_dir before its Slack step, and re-checks a held
 *   one, with the launch's own check (`checkLaunchConfigDir`), which the
 *   reload preview also gets for an added persona; its
 *   connections are the whole manager, whose `stop` closes a held persona's
 *   connection; its `holdForConfigDir` is the session
 *   manager's hook for an unresolvable one, installed before any launch path,
 *   and the restart module's kill adapter gets `getAppliedPersona`.
 * - The relaunch gate (SR-6.1, SR-6.4): built over the manager and the
 *   bring-up controller and passed to the restart module (`canRestart`), the
 *   restart launch and the health-check work list; the restart delay read
 *   from the applied config; the permission poller not started in dry run.
 * - Not-up personas (SR-6.3, SR-6.4, SR-8.6): the one `isPersonaUp`
 *   predicate (the controller's `isUp` and `isApplied`) handed
 *   to the permission poller, `/interject`, the MCP admission decision and
 *   the persona routing's lost-message branch;
 *   a refused session disconnected and never registered; the controller's
 *   `onLeftUp` dropping the persona's registered session.
 * - SR-5.2: the file guard handed to the session tools protects every persona
 *   credentials file, as the reload controller lists them.
 * - b.jg5 SRJ-203 (AC 20): the agent-director startup gate is called once,
 *   awaited, with no argument, after only the directory creations and the
 *   unhandledRejection install and before the PID check and every later step;
 *   server.ts never names the gate's floor-exempt option, so its start always
 *   runs the Phase 1 floor.
 * - b.jg5 SRJ-204 / SRJ-205: the runtime agent-director version re-check is
 *   installed once, in the statement right after the gate, behind no branch
 *   and with no `health_check_interval` or clock of its own, over the gate's
 *   version, agent-director's `resolveSystemBinary` and `recordStartupError`;
 *   its stop first arms the shutdown deadline (`armShutdownDeadline`, with
 *   the stop's code, `process.exit` and no clock or deadline override; AC
 *   21) and sets `process.exitCode` to that code (nothing else in server.ts
 *   names it), then runs `shutdown` with the code the re-check passes;
 *   `shutdown` disposes it, exits with its code (the signals pass none, so 0,
 *   and arm no deadline) and makes no agent-director call. main() returns
 *   before `Bun.serve`, the start bring-up, the health check and the
 *   detection tick when a shutdown began during an earlier await.
 * - b.jg5 SRJ-209: agent-director's timing settings install
 *   (`installAdSettings`) is called once, with no argument (so the file is
 *   read under the process's own HOME), in main()'s own statement list with
 *   its result dropped, after the startup gate and the start's configuration
 *   resolution and before the start bring-up; nothing else in server.ts
 *   builds a reader, registers on the re-check's tick, or names the settings
 *   file or the TOML parser.
 * - b.jg5 SRJ-213: the call-timeout start step (`_runCallTimeoutStartStep`)
 *   is called once, awaited, in main()'s own statement list (so in dry run
 *   too), after the startup gate (still called once with no argument), the
 *   start's configuration resolution and the settings install, and before the
 *   template install and the start bring-up, with the start-time applied
 *   config as its only argument; it is on no tick and no timer.
 * - b.jg5 SRJ-801 / SRJ-802: the retired-key record's start read
 *   (`readRetiredKeysAtStart`) is called once, bound to a const in main()'s
 *   own statement list (so in dry run too), over the server state directory
 *   (`STATE_DIR`) with only a log of its own, after the startup gate and the
 *   PID check and before the reload controller, its start resolution (which
 *   can write the last-applied record), the start sweep, the start bring-up,
 *   the PID file, the connection manager and `Bun.serve`; a refused read
 *   exits 1 in the next statement, and the loaded store is bound once, the
 *   one store; server.ts names the file only through the module and builds no
 *   other store, and no other src file reads the record at start. The reload
 *   controller gets that store by its binding (`retiredKeys`), so a confirmed
 *   apply's step 1 records through the one store (b.jg5 SRJ-803).
 * - b.jg5 SRJ-301 / SRJ-305: one UNAVAILABLE retry controller is built in
 *   main()'s own statement list on the production clock, held in the one
 *   module-scope handle, and installed as the trigger sink of the one
 *   `initOutageState` call before the start bring-up and the restart module;
 *   its action is the full-mode retry action over `runRestartRetry`,
 *   `getAppliedPersona`, the relaunch gate, the restart cap, the restart
 *   module's shutdown flag, "blocks a retry" (below) and the
 *   session manager's row read `readPersonaRowState` (SRJ-303); the restart
 *   module's arm hook (`armRetryTimer`) arms it with the read-error cause
 *   (SRJ-314); the health check's retry-timer read (`isRetryArmed`) is its
 *   `isArmed` and its arm hook (`armRetryTimer`) is server.ts's one
 *   ENVIRONMENT arm path (`armEnvironmentRetryTimer`), which arms it through
 *   that handle with the environment cause (SRJ-311); shutdown closes it
 *   once, right after `cancelAllRestartTimers`,
 *   after the shutting-down flag and before the HTTP server stops.
 * - b.jg5 SRJ-314 / SRJ-115: the restart module's pending deferral
 *   (`deferPendingRow`) is bound to server.ts's one module-scope
 *   `deferPendingRow` (no import, local shadow or second declaration), passed
 *   the persona's key and the reading's `launchStartedAt`, its answer
 *   returned to the restart work (b.jg5 SRJ-410: a gone answer goes on to the
 *   relaunch).
 * - b.jg5 SRJ-410 / SRJ-404: the one pending-row rule is built once, by the
 *   pending-row module's factory over the session manager's dependency
 *   builder (the live applied-persona lookup, the one notice episodes
 *   instance and the server log), and installed once (`setPendingRowRule`)
 *   in main()'s own statement list with the persona lifecycle serializer's
 *   `run`, after the live-row sequence registry's install and before the
 *   restart module, the start sweep, the start bring-up and the health check;
 *   no other src file builds or installs one.
 * - b.jg5 SRJ-303 / SRJ-305 / SRJ-404: one retry run gate object
 *   (`RetryRunGateDeps`: applied, latched, held, up, cap, shutdown) is
 *   declared once in main(), spread into the full-mode retry action's deps
 *   (no own member overrides it) and installed as the pending-row rule's
 *   `gate`, so the approver-stop run is gated as a retry is.
 * - b.jg5 SRJ-1016: the one set of per-persona notice episodes is built once,
 *   imported from the episodes module, in main()'s own statement list, before
 *   the retry controller, the restart module, the start bring-up and the
 *   health check, on the production clock, with the module-scope persona
 *   notifier's `notify` as its sink (key, text and options passed through)
 *   and that notifier's `teardownWindowState` as its teardown query, read
 *   nowhere else (b.jg5 SRJ-1003), and held in the one module-scope handle
 *   assigned in main(); shutdown closes them once, through that handle,
 *   before it first yields (every episode ends, every alert check is
 *   cancelled, and no episode begins again).
 * - b.jg5 SRJ-307 / SRJ-310 / SRJ-306: the one tmux-unresponsive condition is
 *   built once, in main()'s own statement list, over that episodes instance,
 *   after the retry controller; it is the condition sink of the one
 *   `initOutageState` call (beside the trigger sink, before the start
 *   bring-up); the health check's and the full-mode retry action's
 *   `endTmuxUnresponsive` hooks end it (with the tick's `live` reading and the
 *   retry's own reading), the retry action gets the connectedness and stream
 *   probes the health check reads, and its condition-end hook is the retry
 *   controller's `conditionEnded` for the tmux-unresponsive condition.
 * - b.jg5 SRJ-308 / SRJ-309 / SRJ-210: the condition's onset entries are
 *   bound to the health check's tick-end hook (`onTickEnd`, with the tick's
 *   start read by `now` on the notice episodes' own clock) and to the retry
 *   controller's per-fire observer (`onRetryFire`), and are called nowhere
 *   else; its mode is read at each check from the applied config holder's
 *   `health_check_interval` (the field `startHealthCheck` starts the tick
 *   with), and its alert threshold is E6's `adAlertThresholdMsInEffect`
 *   itself, never a value taken once; its alert is cancelled only by the
 *   teardown's retry-timer stop (pinned in tests/reload-wiring.test.ts) and
 *   by shutdown's close of the episodes.
 * - b.jg5 SRJ-313 / SRJ-1009: the one unclassified-error episodes instance is
 *   built once, imported from the episodes module, in main()'s own statement
 *   list, over the one notice episodes instance (so a teardown's forget and
 *   shutdown's close end it), with the server log, E6's alert threshold
 *   accessor itself, a configured-key lookup over `getAppliedPersona` and a
 *   log-only route through `recordStartupError` with the exported
 *   `persona-unclassified-error` label, the persona's key and the alert's
 *   text, before the retry controller and the start pass; it is the
 *   unclassified sink of the one `initOutageState` call; the retry
 *   controller's stop observer calls the condition's alert cancel and the
 *   instance's `retryStopped`, each isolated; the restart module's
 *   `onCapReached` calls the cap notice and the instance's `end` with the
 *   capped reason, each isolated; the instance is named nowhere else.
 * - b.jg5 SRJ-311 / SRJ-312 / SRJ-305 / SRJ-306: the one `initOutageState`
 *   call (in main()'s own statement list, after the retry controller and
 *   before the start pass) installs the cleared-flag observer
 *   (`onFlagCleared`), named nowhere else, which reports only a
 *   `tmux-unavailable` clear to the retry controller's `conditionEnded` for
 *   the tmux-unavailable condition, with the persona and the clear's reading;
 *   the full-mode retry action's healthy-row hook ends the tmux-unresponsive
 *   condition and clears `tmux-unavailable` through the outage state's
 *   `clearOutageFlag` with the retry's own reading, and that is server.ts's
 *   only `tmux-unavailable` clear (every other clear there is
 *   `ad-unreachable`). These are the only two `conditionEnded` reports in
 *   server.ts.
 * - b.jg5 SRJ-303 / SRJ-315 / SRJ-401 / SRJ-706 / SRJ-811: two named
 *   in-flight bindings, each a module-scope function declared once: "blocks
 *   a retry" is the session manager's `personaRetryBlockCause` answering a
 *   cause (a launch call, a live-row sequence or an old-life wait step) and
 *   is the full-mode retry action's `isInFlight`, beside that cause query as
 *   its `retryBlockCause` (a running dialog approver never skips a retry); "in flight
 *   for P" is built from it and the session manager's
 *   `isDialogApproverRunning`, and is the health check's `isLaunchInFlight`,
 *   the persona routing's read-gate member `isWorkInFlight` (b.jg5 SRJ-1011)
 *   and the `tmux-unavailable` retry check's production deps' `isWorkInFlight`
 *   (b.jg5 SRJ-311); nothing else names either (no no-op, other predicate or
 *   local shadow).
 * - b.jg5 SRJ-404: `shutdown()` stops every dialog approver once, through the
 *   session manager's `stopAllDialogApprovers`, after the shutting-down flag
 *   and `stopAllKeepAliveTimers()`, before it first yields and before
 *   `closeClient()`; nothing else in server.ts calls it. (The teardown's
 *   approver stop is pinned in tests/reload-wiring.test.ts.)
 * - b.jg5 SRJ-706 / SRJ-303: the one live-row sequence registry is built
 *   once in main()'s own statement list over the session manager's
 *   dependency builder (the retry controller's arm, the system clock, the
 *   server log, the applied configuration at call time), production's
 *   detached attempt runner and its outside-every-attempt runner
 *   (`runOutsideAttempts`, b.jg5 SRJ-1512), installed once
 *   (`setLiveRowSequenceRegistry`) after the latch and before the restart
 *   module and the start pass, and held in one module-scope holder that
 *   `shutdown()` closes once, after the shutting-down flag, before the retry
 *   controller closes, before it first yields and before `closeClient()`; the
 *   restart work's running query is the session manager's gate
 *   (`liveRowSequenceGate`, which also arms a persona whose own row carries
 *   an old-life wait, b.jg5 SRJ-811), and server.ts asks the bare
 *   `isLiveRowSequenceRunning` nowhere. (The teardown's sequence stop is
 *   pinned in tests/reload-wiring.test.ts.)
 * - b.jg5 SRJ-811 / SRJ-812 / SRJ-1512: the old-life wait's bindings are
 *   installed once (`setOldLifeWaitBindings`), in main()'s own statement
 *   list, after the registry's install and before the restart module, the
 *   start sweep, the start pass and the health check, with exactly the one
 *   retry controller, the system clock, the server log, the applied
 *   configuration at call time, the one kill-failure alerts instance, one
 *   `recordStartupError(<class>, <entry>)` and the wait's own
 *   unclassified-error episodes (`createOldLifeWaitUnclassifiedErrors`, built
 *   once in main() with the alert threshold in effect, and closed once by
 *   `shutdown()` through its module-scope holder; b.jg5 SRJ-313).
 * - b.jg5 SRJ-501 / SRJ-508: the one per-persona latch is built once,
 *   imported from the latch module, in main()'s own statement list, after the
 *   notice episodes and before the retry controller and the start pass, with
 *   the server log as its only dependency (it is held in server memory: no
 *   option loads it, no statement of main() seeds it and the latch module
 *   imports no file-system module); its CONFLICT notice is bound once, in
 *   main()'s own statement list before the retry controller and the start
 *   pass, to that latch and the one notice episodes instance, and nothing
 *   else in server.ts adds a set observer.
 * - b.jg5 SRJ-502 / SRJ-305 / SRJ-310 / SRJ-313 / SRJ-315: the latch's holds
 *   are bound once (`bindConflictLatchHolds`), in main()'s own statement list,
 *   to that latch and the server log, before its notice is bound (so they run
 *   before the notice) and before the start pass; they are exactly the retry
 *   controller's `stop` with `UNAVAILABLE_RETRY_STOP_LATCHED`, the
 *   tmux-unresponsive condition's silent `end` with
 *   `TMUX_UNRESPONSIVE_END_LATCHED`, the unclassified-error episodes'
 *   `end` with `UNCLASSIFIED_ERROR_END_LATCHED`, the slow-recovery
 *   tracker's latch end and the stuck-launch episode's latch end (both
 *   below). The latch is installed in
 *   the session manager once (`setConflictLatch`), after both bindings and
 *   before the retry controller and the start pass, with no await before the
 *   holds' targets are built; its `isLatched` is bound, as a call-time read,
 *   into the full-mode retry action, `initRestart` and `initHealthCheck`, and
 *   the latch is named nowhere else. The condition's three ends and the
 *   unclassified episodes' two ends are each located in their binding.
 * - b.jg5 SRJ-505: the latch re-check is built exactly once, by the session
 *   manager's builder (`buildLatchRecheck`, which the recovery harness also
 *   calls), bound to a const in main()'s own statement list, over exactly
 *   the one latch, the system clock, the one persona lifecycle serializer's
 *   run (the restart module's), the applied configuration read at each round,
 *   the server log and the one notice episodes instance, after the latch's
 *   holds and CONFLICT notice are bound and before the start pass; it is bound
 *   to the latch once (`bindLatchRecheck`), after both, with no await since
 *   its build. server.ts builds no re-check controller, round or clear of its
 *   own, adds no set or forget observer by hand, and hands the re-check to
 *   nothing else (the health tick, the restart module and the retry
 *   controller included); it is held in one module-scope holder, assigned it
 *   once, that shutdown() stops once (`stopAll()`), after the shutting-down
 *   flag, before it first yields and before `closeClient()`.
 * - b.jg5 SRJ-610 / SRJ-1010 / SRJ-1016 / SRJ-502: the one slow-recovery
 *   tracker (`createSlowRecoveryTracker`) is built once, in main()'s own
 *   statement list, over the one notice episodes instance and the server log,
 *   after the episodes and before the restart module and the start pass, with
 *   no await between the latch's install and its build; it is `initRestart`'s
 *   `slowRecovery` observer, the health check's `resetSlowRecoveryCount`
 *   hook calls its `noteHealthy` for the key, and the latch's
 *   `endSlowRecovery` hold calls its `endForLatch` for the key. It is named
 *   only there; server.ts calls none of its restart-run notes, and no other
 *   src file builds one.
 * - b.jg5 SRJ-1016 / SRJ-1017 / SRJ-502: the stuck-launch episode lives in
 *   the one notice episodes instance. It is installed in the session manager
 *   once (`setStuckLaunchEpisodes`), in main()'s own statement list, with
 *   exactly that instance, after its build and before the start sweep and
 *   the start pass, and never removed; the latch's `endStuckLaunch` hold
 *   ends the episode through `endStuckLaunchEpisodeForLatch` over that same
 *   instance with the server log, server.ts's only call of it.
 * - b.jg5 SRJ-114 / SRJ-501: the session manager's configured-persona query
 *   is installed once (`setConfiguredPersonaQuery`), in main()'s own
 *   statement list, as a call-time read of the live applied-persona lookup
 *   (`(key) => getAppliedPersona(key) !== undefined`), never reset; it and
 *   the latch's install both come before the start sweep (`reconcileOrphans`)
 *   and the start pass, with no await between them.
 * - b.jg5 SRJ-807 / SRJ-802: the one retired-key store (the start read's
 *   binding, the reload controller's `retiredKeys`) is installed for the
 *   session manager's own-row reads once (`setRetiredKeyStore`), in main()'s
 *   own statement list, behind no branch, after its binding and before the
 *   start sweep, every launch path, the liveness adapter, the connection
 *   manager and `Bun.serve`; server.ts never names the test-only reset, and
 *   no other src file (the CLI included) installs a store.
 * - b.jg5 SRJ-809: the one old-life hold set (`createOldLifeHoldSet`) is
 *   built once, bound to a const in main()'s own statement list with only a
 *   log of its own, before the reload controller, which gets it by that
 *   binding (`oldLifeHolds`); it is installed for the session manager once
 *   (`setOldLifeHolds`), behind no branch, beside the retired-key store's
 *   install and before the start sweep, every launch path, the liveness
 *   adapter, the connection manager and `Bun.serve`; server.ts never names
 *   the test-only reset, and no other src file builds or installs a set.
 * - b.jg5 SRJ-810 / SRJ-1505 / SRJ-812: what a hold refuses.
 *   handleInitialized gives `decideSessionAdmission` the session manager's
 *   held-directory query (`oldLifeHeldDirectory`, by its bare name, so the
 *   hold set is read at call time) beside `isPersonaUp`; the restart work's
 *   old-life hook (`isHeldForOldLife`) runs the session manager's hold step
 *   (`oldLifeHoldStep`) over the live applied persona; the end-retry
 *   observer (`createOldLifeHoldEndRetry`) is registered once on the one
 *   hold set's `onEnd`, after its install, over the one retry controller's
 *   `runNow` (held-for-an-old-life cause, hold-ended label) and the live
 *   applied-persona lookup; none of them names `getClient()`.
 * - b.jg5 SRJ-704 / SRJ-1007 / SRJ-1016: the kill-failure alerts are built
 *   exactly once (`createKillFailureAlerts`), in main()'s own statement list,
 *   over the one notice episodes instance and the server log, with the live
 *   applied-persona lookup as their configured-key lookup and one
 *   `recordStartupError(<class>, <entry>)` as their log-only route; they are
 *   installed in the session manager once (`setKillFailureAlerts`), after
 *   their build and before the restart module, the start sweep and the start
 *   pass, and named only at the build, the install, the routing holder's
 *   assignment, the persona teardown's alert raiser (b.jg5 SRJ-715) and the
 *   old-life wait's bindings (b.jg5 SRJ-811); the restart kill adapter raises the kill retry's decision once, after the
 *   outcome's own handling.
 * - b.jg5 SRJ-1011: the module-scope persona routing's lost-message inputs
 *   are read at call time: its latched query through a module-scope holder
 *   assigned the one latch once in main(), its `tmux-unresponsive` query
 *   through one assigned the one condition (its `holds`, server.ts's only
 *   holds query), both before the start bring-up; its launch-or-approver
 *   query asks the session manager's `isLaunchInFlight` and
 *   `isDialogApproverRunning` for the key at call time, and is neither
 *   in-flight binding; its kill-failed query reads the one kill-failure
 *   alerts' `isOpen` through a module-scope holder assigned that instance
 *   once in main() before the start bring-up, or the session manager's
 *   `waitsOnKillFailedHold` (b.jg5 SRJ-812); its held-on-invalid-flags
 *   query (state 3, cannot launch) reads the one `ErrInvalidFlags` hold's
 *   `isHeld` through a module-scope holder assigned that hold once in main()
 *   before the start bring-up, which shutdown's forget-all also reads; its
 *   sequence/wait query asks the session manager's
 *   `isSequenceOrOldLifeWaitRunning` for the key at call time (b.jg5
 *   SRJ-811). Its read gate's in-flight member (`isWorkInFlight`)
 *   is "in flight for P", and its one row read
 *   (`readRowLiveness`) is the one liveness adapter main() builds
 *   (`_buildIsSessionAliveAdapter`, built once, the restart module's and the
 *   health tick's `isSessionAlive`), read at call time through a module-scope
 *   holder assigned it once in main() before the start bring-up, answering
 *   `unknown` (never `pending`) before then (b.jg5 SRJ-1011, SRJ-115).
 * - b.jg5 SRJ-207 / SRJ-1008 / SRJ-305 / SRJ-303 / SRJ-315 / SRJ-204: the one
 *   `ErrInvalidFlags` hold (`createInvalidFlagsHold`) is built once, in
 *   main()'s own statement list, over the server log, and installed in the
 *   session manager once (`setInvalidFlagsHold`) before the retry
 *   controller, the restart module, the start pass and the health check,
 *   with no await before the retry controller is built; its set reaction is
 *   bound once (`bindInvalidFlagsHoldSetReaction`) to the retry controller's
 *   stop entry with `UNAVAILABLE_RETRY_STOP_HELD` and to the one notice
 *   episodes instance; exactly one version-changed listener
 *   (`onAdVersionChanged`) runs the version-change reaction over the hold,
 *   the episodes, the applied-persona lookup and a retry at once through
 *   `runRestartRetry` with "blocks a retry"; its `isHeld` is bound, as a
 *   call-time read, into the full-mode retry action, `initRestart` and
 *   `initHealthCheck`; shutdown forgets every hold through the routing's
 *   holder; server.ts never sets a hold and the hold module reads no file.
 * - b.jg5 SRJ-311: the one session-disconnect handler is built once, at
 *   module scope, by `_buildRestartDisconnectedPersona` over the
 *   `tmux-unavailable` retry check's one set of production deps (spread
 *   first, nothing overriding it), `getAppliedPersona`, the restart module's
 *   `scheduleRestart` and its shutdown flag, and only the session close and
 *   the SSE abort call it; those deps are exactly the outage flag, the one
 *   retry controller's `isArmed` through its handle, the one latch through
 *   the routing's holder, "in flight for P", the health tick's
 *   arm path (`armEnvironmentRetryTimer`) and the server log; the routing's
 *   `armRetryTimerIfMissing` does nothing while shutting down and otherwise
 *   asks the same check (`armMissingTmuxUnavailableRetry`) over the same
 *   deps. The routing's call binds exactly its pinned members.
 *
 * Why part of this file is a static audit: main() cannot run in a unit test
 * (the agent-director startup gate, a real port, real Slack connections), so
 * its wiring is pinned by auditing the comment-stripped source text, anchored
 * on content and never on line numbers (the tests/jsonl-safeguard-wiring
 * precedent). Import-time behaviour is proven for real, in a child `bun`
 * process with a temp HOME that imports the module (never runs it as the
 * entry point, so `import.meta.main` is false and main() never runs).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atMainTopLevel,
  balancedAfter,
  callArguments,
  importSource,
  indicesOf,
  insideMain as insideMainOf,
  loadedConfigName,
  mainBody,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'
import { makeStubCallLog } from './test-helpers/agent-director-stub.ts'
import type { runAgentDirectorStartupGate, StartupGateOptions } from '../src/agent-director-startup.ts'
import { AD_VERSION_RECHECK_STOP_EXIT_CODE, type AdVersionRecheckDeps } from '../src/ad-version-gate.ts'
import type { ShutdownDeadlineDeps } from '../src/shutdown-deadline.ts'
import { AD_SETTINGS_RELATIVE_PATH } from '../src/ad-settings.ts'
import type * as AdSettingsModule from '../src/ad-settings.ts'
import type * as AdVersionGateModule from '../src/ad-version-gate.ts'
import type * as AdStartupModule from '../src/agent-director-startup.ts'
import type * as ServerModule from '../src/server.ts'
import type { RestartDisconnectedPersonaDeps, TmuxUnavailableRetryDeps } from '../src/server.ts'
import type { RestartDeps } from '../src/restart.ts'
import type * as RestartModule from '../src/restart.ts'
import type * as InvalidFlagsHoldModule from '../src/invalid-flags-hold.ts'
import type {
  InvalidFlagsHold,
  InvalidFlagsHoldDeps,
  InvalidFlagsHoldSetReactionDeps,
  InvalidFlagsHoldVersionChangeDeps,
} from '../src/invalid-flags-hold.ts'
import type { PendingLivenessReading } from '../src/liveness-reading.ts'
import type { ReloadControllerDeps } from '../src/reload.ts'
import { RETIRED_KEYS_FILE_NAME } from '../src/retired-keys.ts'
import type * as RetiredKeysModule from '../src/retired-keys.ts'
import type * as ConflictLatchModule from '../src/conflict-latch.ts'
import type { ConflictLatch, ConflictLatchDeps, ConflictLatchHolds, LatchRecheckController } from '../src/conflict-latch.ts'
import type * as PersonaEpisodesModule from '../src/persona-episodes.ts'
import type * as SlowRecoveryModule from '../src/slow-recovery.ts'
import type * as PendingRowModule from '../src/pending-row.ts'
import type { SlowRecoveryTracker, SlowRecoveryTrackerDeps } from '../src/slow-recovery.ts'
import type {
  KillFailureAlerts,
  KillFailureAlertsDeps,
  PersonaEpisodes,
  PersonaEpisodesDeps,
  TmuxUnresponsiveCondition,
  TmuxUnresponsiveConditionDeps,
  UnclassifiedErrorEpisodes,
  UnclassifiedErrorEpisodesDeps,
} from '../src/persona-episodes.ts'
import type * as UnavailableRetryModule from '../src/unavailable-retry.ts'
import type { FullModeRetryDeps, RetryRunGateDeps, UnavailableRetryController, UnavailableRetryDeps } from '../src/unavailable-retry.ts'
import type * as LivenessReadingModule from '../src/liveness-reading.ts'
import type * as KillRetryModule from '../src/kill-retry.ts'
import type * as SessionManagerModule from '../src/session-manager.ts'
import type * as LiveRowSequenceModule from '../src/live-row-sequence.ts'
import type { LiveRowSequenceRegistry, LiveRowSequenceRegistryOptions } from '../src/live-row-sequence.ts'
import type { LatchRecheckInput, OldLifeHoldEndRetryDeps, OldLifeWaitBindings, PendingRowRuleDepsInput, PendingRowRuleInstall } from '../src/session-manager.ts'
import type { SessionAdmissionOptions } from '../src/registry.ts'
import type { OldLifeHoldSet } from '../src/retired-keys.ts'
import type { HealthCheckDeps } from '../src/health-check.ts'
import type * as OutageStateModule from '../src/outage-state.ts'
import type { OutageClass, OutageStateDeps } from '../src/outage-state.ts'
import type * as PersonaConnectionsModule from '../src/persona-connections.ts'
import type * as PersonaNotifierModule from '../src/persona-notifier.ts'
import type { PersonaNotifier } from '../src/persona-notifier.ts'
import type { PersonaConfig } from '../src/config.ts'
import type { PersonaRoutingDeps } from '../src/persona-routing.ts'
import type { PersonaLifecycleDeps } from '../src/persona-lifecycle.ts'

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const SERVER_PATH = join(SRC_DIR, 'server.ts')

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync(SERVER_PATH, 'utf-8'))

/** The production kill-retry clock (b.jg5 SRJ-702); renaming it fails the typecheck. */
const KILL_RETRY_PRODUCTION_CLOCK: keyof typeof KillRetryModule = 'KILL_RETRY_SYSTEM_CLOCK'

/** Offsets of every code call of `name` in server.ts. */
function callsOf(name: string): number[] {
  return indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), SERVER_CODE)
}

/** The offset of the only code call of `name`; fails unless there is exactly one. */
function onlyCallOf(name: string): number {
  const calls = callsOf(name)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

/** The top-level arguments of the only code call of `name` (whitespace collapsed). */
function onlyCallArgs(name: string): string[] {
  return splitTopLevel(onlyCallArguments(SERVER_CODE, name))
}

/**
 * The top-level properties of the object literal passed to the only call of
 * `name`, a spread of a const object merged in (see `spreadConstObject`; an
 * override of a spread member throws).
 */
function onlyCallProps(name: string): Map<string, string> {
  return objectProperties(onlyCallArguments(SERVER_CODE, name), spreadConstObject)
}

/**
 * The object literal a spread `...<name>` in server.ts takes its members
 * from: the one `const <name>(: <Type>)? = { … }` declaration, from its `{`.
 * Fails unless there is exactly one.
 */
function spreadConstObject(name: string): string {
  const decls = indicesOf(new RegExp(`\\bconst\\s+${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*\\{`, 'g'), SERVER_CODE)
  expect([name, decls]).toEqual([name, [expect.any(Number)]])
  return SERVER_CODE.slice(SERVER_CODE.indexOf('{', decls[0]!))
}

/** The retry run's gate type (b.jg5 SRJ-303, SRJ-305, SRJ-404), as imported in server.ts. */
const RETRY_RUN_GATE_TYPE = 'RetryRunGateDeps'

/**
 * b.jg5 SRJ-303, SRJ-305, SRJ-404: the one `const <name>: RetryRunGateDeps =
 * { … }` in main() that both the full-mode retry action and the pending-row
 * rule's approver-stop run are gated on. Fails unless it is declared exactly
 * once in server.ts. Returns its name, its object literal's [start, end)
 * (braces excluded) and its properties.
 */
function retryRunGate(): { name: string; at: number; start: number; end: number; props: Map<string, string> } {
  const decls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)\\s*:\\s*${RETRY_RUN_GATE_TYPE}\\s*=\\s*\\{`, 'g'))]
  expect(decls).toHaveLength(1)
  const name = decls[0]![1]!
  declaredOnce(name)
  const at = decls[0]!.index!
  const [start, end] = balancedAfter(SERVER_CODE, at, '{', '}')
  return { name, at, start, end, props: objectProperties(SERVER_CODE.slice(start - 1)) }
}

/** How many of `offsets` lie inside the retry run's gate object (see `retryRunGate`). */
function withinRetryRunGate(offsets: number[]): number {
  const { start, end } = retryRunGate()
  return offsets.filter((offset) => offset > start && offset < end).length
}

/** The name `const <name> = <call>(` binds, for the only such declaration; fails unless there is exactly one. */
function constOf(call: string): string {
  const decls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)(?:\\s*:\\s*[\\w<>, ]+)?\\s*=\\s*${call}\\s*\\(`, 'g'))]
  expect(decls.map((m) => m[1])).toHaveLength(1)
  return decls[0]![1]!
}

/** `name` is declared exactly once in server.ts (no local shadow, no second instance). */
function declaredOnce(name: string): void {
  expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
}

/** A pattern for the call pattern `call` as the one statement of a `try` whose `catch` swallows (its body empty once comments are stripped). */
function isolated(call: string): string {
  return `try \\{ ${call};? \\} catch(?: \\(\\w+\\))? \\{ \\}`
}

/** The latch's holds binder (b.jg5 SRJ-502); renaming it fails the typecheck. */
const BIND_LATCH_HOLDS: keyof typeof ConflictLatchModule = 'bindConflictLatchHolds'
/** The latch's five holds (b.jg5 SRJ-305, SRJ-310, SRJ-313, SRJ-610, SRJ-1016); renaming one fails the typecheck. */
const HOLD_STOP_RETRY: keyof ConflictLatchHolds = 'stopRetryTimer'
const HOLD_END_TMUX: keyof ConflictLatchHolds = 'endTmuxUnresponsive'
const HOLD_END_UNCLASSIFIED: keyof ConflictLatchHolds = 'endUnclassifiedError'
const HOLD_END_SLOW_RECOVERY: keyof ConflictLatchHolds = 'endSlowRecovery'
const HOLD_END_STUCK_LAUNCH: keyof ConflictLatchHolds = 'endStuckLaunch'

/** `(key) => <call>` or `(key) => { <call> }`, `<call>` given `\1` for the parameter, whose name is free. */
function oneKeyArrow(call: string): RegExp {
  return new RegExp(`^\\(?(\\w+)\\)? => (?:\\{ ${call};? \\}|${call})$`)
}

/**
 * b.jg5 SRJ-502: the holds object main() binds to the latch, as its
 * properties (name → value text). Fails unless the binder is called exactly
 * once, with three arguments (the latch, the holds, the log), and its second
 * is an object literal.
 */
function latchHoldProps(): Map<string, string> {
  const args = onlyCallArgs(BIND_LATCH_HOLDS)
  expect(args).toHaveLength(3)
  expect(args[1]!.startsWith('{')).toBe(true)
  return objectProperties(args[1]!)
}

/** The latch's factory (b.jg5 SRJ-501); renaming it fails the typecheck. */
const LATCH_FACTORY: keyof typeof ConflictLatchModule = 'createConflictLatch'

/** The latch re-check's one builder, the session manager's (b.jg5 SRJ-505); renaming it fails the typecheck. */
const RECHECK_BUILDER: keyof typeof SessionManagerModule = 'buildLatchRecheck'
/** The latch re-check's binder (b.jg5 SRJ-505); renaming it fails the typecheck. */
const RECHECK_BIND: keyof typeof ConflictLatchModule = 'bindLatchRecheck'
/** The builder's latch input (b.jg5 SRJ-505); renaming it fails the typecheck. */
const RECHECK_LATCH: keyof LatchRecheckInput = 'latch'

/** Every path that can launch, and so latch or meet a latched persona (b.jg5 SRJ-501, SRJ-502): the retry controller's retries, the restart module, the start bring-up and the health check. */
function latchStartPass(): number[] {
  return [
    onlyCallOf('createUnavailableRetryController'),
    onlyCallOf('initRestart'),
    startResolution(SERVER_CODE).bringUpAt,
    onlyCallOf('initHealthCheck'),
  ]
}

/** The reconnect adapter's builder (b.f2b, b.jg5 SRJ-502); renaming it fails the typecheck. */
const RECONNECT_ADAPTER: keyof typeof ServerModule = '_buildReconnectSessionAdapter'

/** The offset of the reconnect adapter's only build in server.ts (its declaration aside); fails unless there is exactly one. */
function onlyReconnectAdapterBuild(): number {
  const builds = indicesOf(new RegExp(`(?<![\\w.$]|function\\s+)${RECONNECT_ADAPTER}\\s*\\(`, 'g'), SERVER_CODE)
  expect(builds).toHaveLength(1)
  return builds[0]!
}

/** The top-level arguments of the reconnect adapter's only build (whitespace collapsed). */
function reconnectAdapterArgs(): string[] {
  return splitTopLevel(callArguments(SERVER_CODE, onlyReconnectAdapterBuild()))
}

/** The retry action's in-flight member (b.jg5 SRJ-301); renaming it fails the typecheck. */
const RETRY_IN_FLIGHT_MEMBER: keyof FullModeRetryDeps = 'isInFlight'
/** The health check's in-flight member (b.f2b, b.jg5 SRJ-315); renaming it fails the typecheck. */
const TICK_IN_FLIGHT_MEMBER: keyof HealthCheckDeps = 'isLaunchInFlight'

/** `text` with every string and template literal blanked (offsets kept), so brackets inside a log line never count. */
function blankLiterals(text: string): string {
  return text.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))
}

/**
 * The module-scope function `name` in server.ts. Fails unless it is declared
 * exactly once (no local shadow, no second declaration), as a plain
 * `function <name>(…)` starting a line of its own (so in no other function or
 * block) outside main(). Returns its declaration's offset, its parameters'
 * names, and its body as [start, end) and as text.
 */
function moduleFunction(name: string): { at: number; params: string[]; start: number; end: number; body: string } {
  declaredOnce(name)
  const decls = indicesOf(new RegExp(`^function\\s+${name}\\s*\\(`, 'gm'), SERVER_CODE)
  expect(decls).toHaveLength(1)
  const at = decls[0]!
  expect(insideMain(at)).toBe(false)
  const [paramsStart, paramsEnd] = balancedAfter(SERVER_CODE, at, '(', ')')
  const params = splitTopLevel(SERVER_CODE.slice(paramsStart, paramsEnd)).map((p) => p.match(/^(\w+)/)![1]!)
  const [start, end] = balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
  return { at, params, start, end, body: SERVER_CODE.slice(start, end) }
}

/** The one production session-disconnect handler (b.jg5 SRJ-311): private to server.ts, so named by string. */
const DISCONNECT_HANDLER = 'restartDisconnectedPersona'

/** The `tmux-unavailable` retry check's deps type (b.jg5 SRJ-311), as imported above. */
const CHECK_DEPS_TYPE = 'TmuxUnavailableRetryDeps'
/** The check's latched and in-flight members (b.jg5 SRJ-311, SRJ-502, SRJ-315); renaming one fails the typecheck. */
const CHECK_LATCHED: keyof TmuxUnavailableRetryDeps = 'isLatched'
const CHECK_IN_FLIGHT: keyof TmuxUnavailableRetryDeps = 'isWorkInFlight'

/**
 * b.jg5 SRJ-311: the production deps of the `tmux-unavailable` retry check,
 * the one module-scope `const <name>: TmuxUnavailableRetryDeps = { … }`
 * outside main(), declared once (no second set). Returns its name, its
 * object literal's [start, end) (braces excluded) and its properties.
 */
function retryCheckDeps(): { name: string; start: number; end: number; props: Map<string, string> } {
  const decls = [...SERVER_CODE.matchAll(new RegExp(`^const\\s+(\\w+)\\s*:\\s*${CHECK_DEPS_TYPE}\\s*=\\s*\\{`, 'gm'))]
  expect(decls).toHaveLength(1)
  const name = decls[0]![1]!
  declaredOnce(name)
  expect(insideMain(decls[0]!.index!)).toBe(false)
  const [start, end] = balancedAfter(SERVER_CODE, decls[0]!.index!, '{', '}')
  return { name, start, end, props: objectProperties(SERVER_CODE.slice(start - 1)) }
}

/** [start, end) of the body of server.ts's one module-scope `export function <name>(…)`, braces excluded. */
function exportedFunctionBody(name: string): [number, number] {
  const decls = indicesOf(new RegExp(`^export\\s+function\\s+${name}\\s*\\(`, 'gm'), SERVER_CODE)
  expect(decls).toHaveLength(1)
  const paramsEnd = balancedAfter(SERVER_CODE, decls[0]!, '(', ')')[1]
  return balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
}

/** server.ts's one ENVIRONMENT arm path (b.jg5 SRJ-311): private to server.ts, so named by string. */
const ENVIRONMENT_ARM = 'armEnvironmentRetryTimer'

/** The retry controller's one module-scope handle (assigned only the one controller, once, in main(); pinned in the controller's describe). */
function retryHandle(): string {
  return SERVER_CODE.match(/^let\s+(\w+)\s*:\s*UnavailableRetryController\s*\|\s*undefined\s*$/m)![1]!
}

/** How many of `offsets` lie inside the parentheses of the call (or the declaration's parameter list) at `at`. */
function withinCall(offsets: number[], at: number): number {
  const [open, close] = balancedAfter(SERVER_CODE, at, '(', ')')
  return offsets.filter((offset) => offset > open && offset < close).length
}

/** The session manager's launch-in-flight query (b.f2b, b.jg5 SRJ-303); renaming it fails the typecheck. */
const LAUNCH_IN_FLIGHT: keyof typeof SessionManagerModule = 'isLaunchInFlight'
/** The session manager's approver-running query (b.jg5 SRJ-401); renaming it fails the typecheck. */
const APPROVER_RUNNING: keyof typeof SessionManagerModule = 'isDialogApproverRunning'
/** The session manager's live-row sequence running query (b.jg5 SRJ-706); renaming it fails the typecheck. */
const SEQUENCE_RUNNING: keyof typeof SessionManagerModule = 'isLiveRowSequenceRunning'
/** The session manager's "which work blocks a retry" query (b.jg5 SRJ-303, SRJ-706, SRJ-811); renaming it fails the typecheck. */
const RETRY_BLOCK_CAUSE: keyof typeof SessionManagerModule = 'personaRetryBlockCause'
/** The retry action's cause member (b.jg5 SRJ-303: the again-reason and skip line name the cause); renaming it fails the typecheck. */
const RETRY_BLOCK_CAUSE_MEMBER: keyof FullModeRetryDeps = 'retryBlockCause'

/**
 * The two named in-flight bindings main() hands out (b.jg5 SRJ-303, SRJ-315,
 * SRJ-401, SRJ-1011), each a module-scope function declared exactly once in
 * server.ts (see moduleFunction), not imported, with one parameter, its key:
 * - "blocks a retry" (`retryBlocked`), as the full-mode retry action's
 *   `isInFlight` binds it: its whole body is
 *   `return personaRetryBlockCause(<key>) !== undefined`, the session
 *   manager's cause query (a launch call, a running live-row sequence, or an
 *   old-life wait step for a hold the persona waits on: b.jg5 SRJ-706,
 *   SRJ-811), never a running dialog approver (SRJ-303: a running approver
 *   does not skip a retry). No other function or const/let/var arrow in
 *   server.ts starts by asking `isLaunchInFlight` or `personaRetryBlockCause`
 *   for its own key (no second narrow predicate, none that drops the
 *   sequence or the wait). It is named exactly four times: its declaration,
 *   the retry action's `isInFlight`, the body of "in flight for P" and the
 *   `ErrInvalidFlags` hold's version-changed listener, whose retry at once
 *   runs the restart module's retry entry with it (b.jg5 SRJ-207, SRJ-303).
 *   The cause query itself is named exactly three times: its import, that
 *   body and the retry action's `retryBlockCause` (bare), so the skip's
 *   again-reason names the same cause that blocked it.
 * - "in flight for P" (`workInFlight`), as the health tick's
 *   `isLaunchInFlight` binds it: its whole body is
 *   `return <blocks a retry>(<key>) || isDialogApproverRunning(<key>)`, built
 *   from the narrow one, so later Epics extend one place. It is named exactly
 *   four times: its declaration, the health tick's `isLaunchInFlight`, the
 *   `tmux-unavailable` retry check's production deps' `isWorkInFlight` (the
 *   session-disconnect handler's and the routing's arm, which mirror the
 *   tick's check, b.jg5 SRJ-311) and the persona routing's read-gate member
 *   `isWorkInFlight` (b.jg5 SRJ-1011), each bound to the bare name.
 * The two names differ, and `isLaunchInFlight`, `personaRetryBlockCause` and
 * `isDialogApproverRunning` are the session manager's imports, declared
 * nowhere in server.ts. Replaces
 * the one shared predicate E11 and E15 pinned. Returns both names.
 */
function inFlightBindings(): { retryBlocked: string; workInFlight: string } {
  for (const query of [LAUNCH_IN_FLIGHT, RETRY_BLOCK_CAUSE, APPROVER_RUNNING]) {
    expect([query, importSource(SERVER_CODE, query)]).toEqual([query, './session-manager.ts'])
    expect([query, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${query}\\b`, 'g'), SERVER_CODE)]).toEqual([query, []])
  }

  // "Blocks a retry": the retry action's binding.
  const retryBlocked = onlyCallProps('createFullModeRetryAction').get(RETRY_IN_FLIGHT_MEMBER)
  expect(retryBlocked).toMatch(/^\w+$/)
  expect(importSource(SERVER_CODE, retryBlocked!)).toBeUndefined()
  const narrow = moduleFunction(retryBlocked!)
  expect(narrow.params).toHaveLength(1)
  expect(narrow.body.replace(/\s+/g, ' ').trim()).toBe(`return ${RETRY_BLOCK_CAUSE}(${narrow.params[0]}) !== undefined`)
  // No second narrow predicate: this is server.ts's only declared function or
  // const/let/var arrow whose body starts by calling isLaunchInFlight or the
  // cause query with its own key, so none can block a retry on a launch alone
  // while a sequence or an old-life wait step runs. (The persona routing's
  // launch-or-approver member is an inline arrow, pinned separately, b.jg5
  // SRJ-1011.)
  const narrowCall = `(?:${LAUNCH_IN_FLIGHT}|${RETRY_BLOCK_CAUSE})\\(\\s*\\1\\s*\\)`
  const wrappers = [
    ...indicesOf(new RegExp(`\\bfunction\\s+\\w+\\s*\\(\\s*(\\w+)(?:\\s*:\\s*string)?\\s*\\)(?:\\s*:\\s*boolean)?\\s*\\{\\s*return\\s+${narrowCall}`, 'g'), SERVER_CODE),
    ...indicesOf(new RegExp(`\\b(?:const|let|var)\\s+\\w+(?:\\s*:[^=\\n]+)?\\s*=\\s*\\(?\\s*(\\w+)(?:\\s*:\\s*string)?\\s*\\)?(?:\\s*:\\s*boolean)?\\s*=>\\s*\\{?\\s*(?:return\\s+)?${narrowCall}`, 'g'), SERVER_CODE),
  ]
  expect(wrappers).toEqual([narrow.at])
  // The cause query: its import, the narrow one's body, the retry action's
  // cause member (bare), so the again-reason names what blocked the retry,
  // and the hold's version-changed listener's retry (its 4th argument, so a
  // skip line there names the cause too, b.jg5 SRJ-207).
  const causeNamed = indicesOf(new RegExp(`\\b${RETRY_BLOCK_CAUSE}\\b`, 'g'), SERVER_CODE)
  expect(causeNamed).toHaveLength(4)
  expect(causeNamed.filter((offset) => offset > narrow.start && offset < narrow.end)).toHaveLength(1)
  expect(onlyCallProps('createFullModeRetryAction').get(RETRY_BLOCK_CAUSE_MEMBER)).toBe(RETRY_BLOCK_CAUSE)
  expect(withinCall(causeNamed, onlyCallOf('createFullModeRetryAction'))).toBe(1)
  expect(withinCall(causeNamed, onlyCallOf('onAdVersionChanged'))).toBe(1)

  // "In flight for P": the health tick's binding, built from the narrow one.
  const workInFlight = onlyCallProps('initHealthCheck').get(TICK_IN_FLIGHT_MEMBER)
  expect(workInFlight).toMatch(/^\w+$/)
  expect(workInFlight).not.toBe(retryBlocked)
  expect(importSource(SERVER_CODE, workInFlight!)).toBeUndefined()
  const broad = moduleFunction(workInFlight!)
  expect(broad.params).toHaveLength(1)
  const key = broad.params[0]!
  expect(broad.body.replace(/\s+/g, ' ').trim()).toBe(`return ${retryBlocked}(${key}) || ${APPROVER_RUNNING}(${key})`)

  // The narrow one: its declaration, the retry action, the broad one's body
  // and the hold's version-changed listener (b.jg5 SRJ-207).
  const narrowNamed = indicesOf(new RegExp(`\\b${retryBlocked}\\b`, 'g'), SERVER_CODE)
  expect(narrowNamed).toHaveLength(4)
  expect(narrowNamed[0]).toBe(SERVER_CODE.indexOf(retryBlocked!, narrow.at))
  expect(withinCall(narrowNamed, onlyCallOf('createFullModeRetryAction'))).toBe(1)
  expect(narrowNamed.filter((offset) => offset > broad.start && offset < broad.end)).toHaveLength(1)
  expect(withinCall(narrowNamed, onlyCallOf('onAdVersionChanged'))).toBe(1)

  // The broad one: its declaration, the health tick, the retry check's deps
  // and the persona routing's read gate, once each, and nowhere else.
  const broadNamed = indicesOf(new RegExp(`\\b${workInFlight}\\b`, 'g'), SERVER_CODE)
  expect(broadNamed).toHaveLength(4)
  expect(broadNamed[0]).toBe(SERVER_CODE.indexOf(workInFlight!, broad.at))
  expect(withinCall(broadNamed, onlyCallOf('initHealthCheck'))).toBe(1)
  const check = retryCheckDeps()
  expect(check.props.get(CHECK_IN_FLIGHT)).toBe(workInFlight)
  expect(broadNamed.filter((offset) => offset > check.start && offset < check.end)).toHaveLength(1)
  expect(onlyCallProps('createPersonaRouting').get(ROUTING_WORK_IN_FLIGHT)).toBe(workInFlight)
  expect(withinCall(broadNamed, onlyCallOf('createPersonaRouting'))).toBe(1)
  return { retryBlocked: retryBlocked!, workInFlight: workInFlight! }
}

/** Offsets of every plain assignment to `name` (`name = …`, not `==`, not a declaration or property). */
function assignmentsTo(name: string): Array<{ at: number; value: string }> {
  return [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$]|(?:let|const|var)\\s+)${name}\\s*=(?![=>])\\s*([^\\n;]*)`, 'g'))]
    .map((m) => ({ at: m.index!, value: m[1]!.trim() }))
}

/** Whether `offset` lies inside main()'s body in server.ts. */
function insideMain(offset: number): boolean {
  return insideMainOf(SERVER_CODE, offset)
}

/** The persona routing's read-gate in-flight member (b.jg5 SRJ-1011); renaming it fails the typecheck. */
const ROUTING_WORK_IN_FLIGHT: keyof PersonaRoutingDeps = 'isWorkInFlight'
/** The persona routing's lost-message row read (b.jg5 SRJ-1011, SRJ-115); renaming it fails the typecheck. */
const ROUTING_ROW_READ: keyof PersonaRoutingDeps = 'readRowLiveness'

/** The persona routing's latched member (b.jg5 SRJ-1011, SRJ-502); renaming it fails the typecheck. */
const ROUTING_LATCHED: keyof PersonaRoutingDeps = 'isLatched'
/** The persona routing's `tmux-unresponsive` member (b.jg5 SRJ-1011, SRJ-307); renaming it fails the typecheck. */
const ROUTING_TMUX_UNRESPONSIVE: keyof PersonaRoutingDeps = 'isTmuxUnresponsive'

/**
 * b.jg5 SRJ-1011: the module-scope holder through which the persona routing's
 * `member` reads `query` on one instance main() builds, at call time. The
 * routing is built at module scope, before main() builds the instance, so the
 * member must read the holder at each call:
 * `(key) => <holder>?.<query>(key) ?? false` (or `=== true`). Fails unless
 * the member has that form; the holder is a module-scope `let` declared once
 * with no initializer (no copy taken at import); it is assigned exactly once,
 * in main()'s own statement list, the bare name `instance` (the one instance,
 * never a second one), after that instance is built and before the start
 * bring-up (the first time a persona can connect and lose a message); and it
 * is named nowhere else (its declaration, that assignment and the member),
 * but once in each member in `checkReaders` of the `tmux-unavailable` retry
 * check's production deps (see retryCheckDeps), each the same call-time
 * query for its own parameter, `(key) => <holder>?.<query>(key) === true`
 * (the latch's: the check's `isLatched`, which the session-disconnect handler
 * and the routing's arm ask, b.jg5 SRJ-311, SRJ-502), and once inside each
 * range of `alsoIn` ([start, end) offsets; the `ErrInvalidFlags` hold's:
 * shutdown's body, whose forget-all reads it, b.jg5 SRJ-207). With `orCall`
 * (a call name), the member is that read `|| <orCall>(key)` instead, both
 * halves for the member's own parameter (the kill-failed member's old-life
 * half, b.jg5 SRJ-812). Returns the holder's name and the [start, end) of its
 * assignment.
 */
function routingHolder(
  member: keyof PersonaRoutingDeps,
  query: string,
  instance: string,
  checkReaders: Array<keyof TmuxUnavailableRetryDeps> = [],
  alsoIn: Array<readonly [number, number]> = [],
  orCall?: string,
): { holder: string; at: number; end: number } {
  const binding = onlyCallProps('createPersonaRouting').get(member)
  expect(binding).toBeDefined()
  const tail = orCall === undefined ? '' : ` \\|\\| ${orCall}\\(\\1\\)`
  const form = binding!.match(new RegExp(`^\\(?(\\w+)\\)? => (\\w+)\\?\\.${query}\\(\\1\\) (?:\\?\\? false|=== true)${tail}$`))
  expect(form).not.toBeNull()
  const holder = form![2]!

  declaredOnce(holder)
  const decls = [...SERVER_CODE.matchAll(new RegExp(`^let\\s+${holder}\\s*:[^=\\n]+$`, 'gm'))]
  expect(decls).toHaveLength(1)
  expect(insideMain(decls[0]!.index!)).toBe(false)

  const assigned = [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$]|(?:let|const|var)\\s+)${holder}\\s*=(?![=>])\\s*([^\\n;]*)`, 'g'))]
  expect(assigned.map((m) => m[1]!.trim())).toEqual([instance])
  const at = assigned[0]!.index!
  expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
  const built = SERVER_CODE.search(new RegExp(`\\bconst\\s+${instance}\\s*=`))
  expect(built).toBeGreaterThan(-1)
  expect(at).toBeGreaterThan(built)
  expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)

  const named = indicesOf(new RegExp(`\\b${holder}\\b`, 'g'), SERVER_CODE)
  if (checkReaders.length > 0) {
    const check = retryCheckDeps()
    for (const reader of checkReaders) {
      expect([reader, check.props.get(reader)]).toEqual([reader, expect.stringMatching(new RegExp(`^\\(?(\\w+)\\)? => ${holder}\\?\\.${query}\\(\\1\\) === true$`))])
    }
    expect(named.filter((offset) => offset > check.start && offset < check.end)).toHaveLength(checkReaders.length)
  }
  for (const [start, end] of alsoIn) expect(named.filter((offset) => offset > start && offset < end)).toHaveLength(1)
  expect(named).toHaveLength(3 + checkReaders.length + alsoIn.length)
  return { holder, at, end: at + assigned[0]![0].length }
}

/** Every `.ts` file under src/, as [repo-relative path, source text]. */
function srcFiles(dir = SRC_DIR): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...srcFiles(full))
    else if (full.endsWith('.ts')) out.push([`src/${relative(SRC_DIR, full)}`, readFileSync(full, 'utf-8')])
  }
  return out
}

// ---------------------------------------------------------------------------
// Static audit: no module-scope Slack client or token read
// ---------------------------------------------------------------------------

describe('server.ts builds no Slack client and reads no token itself (SR-3.1, SR-10.2, SR-8.7)', () => {
  test.each(['loadTokens', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'MCP_HOST', 'MCP_PORT', 'routingConfig'])(
    'server.ts code never names %s',
    (name) => {
      expect(indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)).toEqual([])
    },
  )

  test('constructs no WebClient or SocketModeClient and imports Slack library types only', () => {
    expect(indicesOf(/\bnew\s+(?:WebClient|SocketModeClient)\b/g, SERVER_CODE)).toEqual([])
    // A static import of a Slack package must be `import type`; `[^'"]` keeps
    // a match inside one import statement.
    const valueImports = [...SERVER_CODE.matchAll(/\bimport\s+(type\s+)?[^'"]*?\bfrom\s*['"](@slack\/[\w-]+)['"]/g)]
      .filter((m) => m[1] === undefined)
      .map((m) => m[2])
    expect(valueImports).toEqual([])
    expect(indicesOf(/\b(?:import|require)\s*\(\s*['"]@slack\//g, SERVER_CODE)).toEqual([])
  })

  test('builds the persona connection manager once, inside main()', () => {
    expect(insideMain(onlyCallOf('createPersonaConnectionManager'))).toBe(true)
  })

  test('no file under src/ other than cli.ts names a token variable', () => {
    const offenders = srcFiles()
      .filter(([path]) => path !== 'src/cli.ts')
      .filter(([, source]) => /\bSLACK_(?:BOT|APP)_TOKEN\b/.test(stripComments(source)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  test('no file under src/ references the deleted route→persona adapter module', () => {
    expect(existsSync(join(SRC_DIR, 'route-persona-adapter.ts'))).toBe(false)
    const offenders = srcFiles()
      .filter(([, source]) => /route-persona-adapter/.test(source))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the start resolution (SR-1.7, SR-8.7)
// ---------------------------------------------------------------------------

describe('main() resolves the start through the reload controller and exits on a refused start (SR-1.7, SR-8.7)', () => {
  test('imports createReloadController and reloadFilePaths from the reload module, and neither the start loader nor a route loader from the config module', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bcreateReloadController\b[^}]*\}\s*from\s*['"]\.\/reload\.ts['"]/,
    )
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\breloadFilePaths\b[^}]*\}\s*from\s*['"]\.\/reload\.ts['"]/)
    const configImports = [...SERVER_CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.ts['"]/g)]
    expect(configImports).toHaveLength(1)
    const names = configImports[0]![1]!.split(',').map((n) => n.trim().replace(/^type\s+/, ''))
    // The start never reads the config file around the controller.
    for (const loader of ['loadStartPersonaConfig', 'loadPersonaConfig', 'parsePersonaConfigBytes', 'readPersonaConfigBytes']) {
      expect(names).not.toContain(loader)
      expect(callsOf(loader)).toEqual([])
    }
    for (const routeName of ['loadConfig', 'resolveConfig', 'applyDefaults', 'validateConfig']) {
      expect(names).not.toContain(routeName)
    }
    // No route type either (the removed route config types all contained "Rout").
    expect(names.filter((n) => /rout/i.test(n))).toEqual([])
  })

  test('builds the controller once, inside main(), over CONFIG_PATH\'s reload files (the server config path), and resolves the start once', () => {
    expect(SERVER_CODE).toMatch(/\bconst\s+CONFIG_PATH\s*=\s*resolveServerConfigPath\s*\(\s*\)/)
    // startResolution pins one resolveStart and one runStartBringUp, both
    // called on this controller.
    const { createAt, resolveAt } = startResolution(SERVER_CODE)
    expect(onlyCallOf('createReloadController')).toBe(createAt)
    expect(insideMain(createAt)).toBe(true)
    expect(insideMain(resolveAt)).toBe(true)
    expect(onlyCallProps('createReloadController').get('paths')).toBe('reloadFilePaths(CONFIG_PATH)')
  })

  test('a refused start exits 1 right after the resolution, before the applied config is set; on the start path the outcome\'s config is the only applied config, and nothing re-reads the config file into it', () => {
    const { controller, outcome, loaded, resolveAt, assignAt, bringUpAt } = startResolution(SERVER_CODE)
    // `const <outcome> = <controller>.resolveStart()`, then the refusal exit as
    // the whole `if`, then `<loaded> = <outcome>.config`: nothing in between.
    const sequence = new RegExp(
      `\\bconst\\s+${outcome}\\s*=\\s*${controller}\\s*\\.\\s*resolveStart\\s*\\(\\s*\\)\\s*;?\\s*` +
        `if\\s*\\(\\s*${outcome}\\s*\\.\\s*kind\\s*===\\s*'refused'\\s*\\)\\s*\\{?\\s*process\\s*\\.\\s*exit\\s*\\(\\s*1\\s*\\)\\s*;?\\s*\\}?\\s*` +
        `${loaded}\\s*=\\s*${outcome}\\s*\\.\\s*config\\b`,
      'g',
    )
    expect(indicesOf(sequence, SERVER_CODE)).toHaveLength(1)
    // The start path, from the resolution to the start bring-up request (where
    // every start pass reads the applied config), assigns it once: from the
    // outcome. A later assignment outside that window (a confirmed apply,
    // E12/E13) is not the start's.
    const assigns = assignmentsTo(loaded)
    expect(assigns.filter(({ at }) => at > resolveAt && at < bringUpAt).map(({ at }) => at)).toEqual([assignAt])
    // No assignment anywhere reads the config file (the import test above
    // also bans every config loader from server.ts).
    for (const { value } of assigns) {
      expect(value).not.toMatch(/\bCONFIG_PATH\b|\breadFileSync\b|\b(?:load|parse|read)\w*Config\w*\s*\(/)
    }
  })

  test('the start resolution comes AFTER the PID check, so a duplicate start never writes the record', () => {
    const { resolveAt } = startResolution(SERVER_CODE)
    expect(resolveAt).toBeGreaterThan(onlyCallOf('checkPidConflict'))
  })

  test.each([
    ['the PID file', 'writePidFile'],
    ['the template install', 'installSlackChannelBotTemplate'],
    ['the connection manager', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['the per-persona bring-up', 'runStartBringUp'],
  ])('sets the applied config BEFORE %s', (_label, anchor) => {
    const { assignAt } = startResolution(SERVER_CODE)
    const later = callsOf(anchor)
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(assignAt).toBeLessThan(at)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the unhandledRejection handler (SR-3.3)
// ---------------------------------------------------------------------------

describe('main() installs the unhandledRejection handler before any persona connects (SR-3.3)', () => {
  const INSTALL = /\bprocess\.on\s*\(\s*['"]unhandledRejection['"]\s*,\s*createUnhandledRejectionHandler\s*\(/g

  test('installs createUnhandledRejectionHandler from the connection-errors module, once, inside main() and never at module scope', () => {
    expect(SERVER_CODE).toMatch(
      /import\s*\{[^}]*\bcreateUnhandledRejectionHandler\b[^}]*\}\s*from\s*['"]\.\/persona-connection-errors\.ts['"]/,
    )
    const installs = indicesOf(INSTALL, SERVER_CODE)
    expect(installs).toHaveLength(1)
    // Any other mention of the event (a second install in another form) must
    // also sit inside main().
    for (const at of indicesOf(/['"]unhandledRejection['"]/g, SERVER_CODE)) expect(insideMain(at)).toBe(true)
  })

  test.each([
    ['the connection manager is built', 'createPersonaConnectionManager'],
    ['the per-persona bring-up (the start bring-up request)', 'runStartBringUp'],
  ])('installs it BEFORE %s', (_label, anchor) => {
    const [install] = indicesOf(INSTALL, SERVER_CODE)
    expect(install).toBeDefined()
    expect(install!).toBeLessThan(onlyCallOf(anchor))
  })
})

// ---------------------------------------------------------------------------
// Static audit: the agent-director startup gate runs first (b.jg5 SRJ-203)
// ---------------------------------------------------------------------------

describe('main() runs the agent-director startup gate before any other work, always with the Phase 1 floor (b.jg5 SRJ-203, AC 20)', () => {
  /** The gate's floor-exempt option; typed against the gate's options, so a rename fails the typecheck. */
  const FLOOR_EXEMPT_OPTION: keyof StartupGateOptions = 'skipPhase1Floor'

  /** Offset of the only `runAgentDirectorStartupGate(` call; fails unless there is exactly one. */
  const gateCall = (): number => onlyCallOf('runAgentDirectorStartupGate')

  test('imports runAgentDirectorStartupGate from the startup module and calls it exactly once, awaited, in main()\'s own statement list, with no argument', () => {
    expect(importSource(SERVER_CODE, 'runAgentDirectorStartupGate')).toBe('./agent-director-startup.ts')
    const at = gateCall()
    const awaitAt = SERVER_CODE.slice(0, at).search(/\bawait\s+$/)
    expect(awaitAt).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, awaitAt)).toBe(true)
    expect(onlyCallArguments(SERVER_CODE, 'runAgentDirectorStartupGate').trim()).toBe('')
  })

  test('server.ts never names the floor-exempt option and never calls runStartupGate, so the server\'s start always runs the Phase 1 floor', () => {
    expect(indicesOf(new RegExp(`\\b${FLOOR_EXEMPT_OPTION}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(callsOf('runStartupGate')).toEqual([])
  })

  test.each([
    ['the PID check', 'checkPidConflict'],
    ['the start resolution', 'resolveStart'],
    ['the connection manager', 'createPersonaConnectionManager'],
    ['Bun.serve', 'Bun\\.serve'],
    ['the start bring-up', 'runStartBringUp'],
  ])('calls it BEFORE %s', (_label, anchor) => {
    const later = callsOf(anchor)
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(gateCall()).toBeLessThan(at)
  })

  test('inside main(), only the state and inbox directory creations and the unhandledRejection handler install come before it', () => {
    const [mainStart] = mainBody(SERVER_CODE)
    // The gate statement starts at its `await`, or at a single
    // `const <name> = ` that binds the gate's result (E3 reads its `adVersion`
    // for the runtime re-check). Only that binding is admitted: any other code
    // before the gate is still left in `before` and fails the check below.
    const gateStatement = SERVER_CODE.slice(0, gateCall()).search(/(?:\bconst\s+[A-Za-z_$][\w$]*\s*=\s*)?\bawait\s+$/)
    const before = SERVER_CODE.slice(mainStart, gateStatement)
    // Cut out each expected statement: every `mkdirSync(…)` call and the
    // guarded install `if (!unhandledRejectionHandlerInstalled) { … }`.
    const cuts: Array<[number, number]> = []
    const dirs: string[] = []
    for (const at of indicesOf(/\bmkdirSync\s*\(/g, before)) {
      const [argsStart, argsEnd] = balancedAfter(before, at, '(', ')')
      dirs.push(splitTopLevel(before.slice(argsStart, argsEnd))[0]!)
      cuts.push([at, argsEnd + 1])
    }
    const guards = indicesOf(/\bif\s*\(\s*!\s*unhandledRejectionHandlerInstalled\s*\)\s*\{/g, before)
    expect(guards).toHaveLength(1)
    const [, guardEnd] = balancedAfter(before, guards[0]!, '{', '}')
    const guardBlock = before.slice(guards[0]!, guardEnd + 1)
    expect(indicesOf(/\bprocess\.on\s*\(\s*['"]unhandledRejection['"]\s*,\s*createUnhandledRejectionHandler\s*\(/g, guardBlock)).toHaveLength(1)
    cuts.push([guards[0]!, guardEnd + 1])

    expect(dirs.sort()).toEqual(['INBOX_DIR', 'STATE_DIR'])
    const rest = cuts
      .sort((a, b) => b[0] - a[0])
      .reduce((text, [from, to]) => text.slice(0, from) + text.slice(to), before)
    expect(rest.replace(/[\s;]/g, '')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Static audit: the runtime agent-director version re-check (b.jg5 SRJ-204,
// SRJ-205)
//
// What the re-check does (its 120 s timer, each outcome, the stop calling
// `stop(AD_VERSION_RECHECK_STOP_EXIT_CODE)` once, dispose) is driven through
// its real module in tests/ad-version-gate.test.ts. What only server.ts holds
// is where main() installs it, what it is given, and what shutdown does.
// ---------------------------------------------------------------------------

describe('main() installs the runtime agent-director version re-check right after the startup gate, and shutdown disposes it and makes no agent-director call (b.jg5 SRJ-204, SRJ-205)', () => {
  /** The gate result's version field; typed against the gate, so a rename fails the typecheck. */
  const GATE_VERSION_FIELD: keyof Awaited<ReturnType<typeof runAgentDirectorStartupGate>> = 'adVersion'

  /** The options main() passes, and only those: no `clock` (real timers), no interval of its own. */
  const INSTALL_OPTIONS: ReadonlyArray<keyof AdVersionRecheckDeps> = [
    'baselineVersion',
    'log',
    'recordStartupError',
    'resolveSystemBinary',
    'stop',
  ]

  /**
   * The options the stop passes to armShutdownDeadline, and only those: no
   * `clock` (real timers) and no `deadlineMs` (the module's constant).
   */
  const ARM_OPTIONS: ReadonlyArray<keyof ShutdownDeadlineDeps> = ['exit', 'exitCode', 'log']

  /** A parameter name at the start of an arrow function: `(x) =>` or `x =>`. */
  const ARROW_PARAM = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/

  /**
   * Whether the code at `offset` in the block body `body` starts one of that
   * block's own statements, run on every pass: inside no nested bracket, and
   * not the brace-less body of an `if`, `else`, `while` or `for`. String and
   * template literals are blanked first, so a bracket inside one (a log
   * line's "(see …)") never counts.
   */
  function statementOfBlock(body: string, offset: number): boolean {
    const code = body.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (lit) => `"${' '.repeat(lit.length - 2)}"`)
    const before = code.slice(0, offset)
    let depth = 0
    for (const ch of before) {
      if ('({['.includes(ch)) depth++
      else if (')}]'.includes(ch)) depth--
    }
    if (depth !== 0) return false
    const prior = before.trimEnd()
    if (/\belse$/.test(prior)) return false
    if (!prior.endsWith(')')) return true
    // After a `)`: refuse it when that closes a branch or loop header.
    for (const header of indicesOf(/\b(?:if|while|for)\s*\(/g, prior)) {
      if (balancedAfter(code, header, '(', ')')[1] === prior.length - 1) return false
    }
    return true
  }

  /** The body text of `shutdown()` in server.ts. */
  const shutdownCode = (): string => SERVER_CODE.slice(...shutdownBody(SERVER_CODE))

  /** Offsets in `code` of every `process.exit(` call. */
  const exitsIn = (code: string): number[] => indicesOf(/\bprocess\s*\.\s*exit\s*\(/g, code)

  /** Offsets in `code` of every plain `shutdown(` call. */
  const shutdownCallsIn = (code: string): number[] => indicesOf(/(?<![\w.$])shutdown\s*\(/g, code)

  test('imports installAdVersionRecheck and disposeAdVersionRecheck from the version gate module and resolveSystemBinary from agent-director, and declares none of them itself', () => {
    expect(importSource(SERVER_CODE, 'installAdVersionRecheck')).toBe('./ad-version-gate.ts')
    expect(importSource(SERVER_CODE, 'disposeAdVersionRecheck')).toBe('./ad-version-gate.ts')
    expect(importSource(SERVER_CODE, 'resolveSystemBinary')).toBe('agent-director')
    expect(importSource(SERVER_CODE, 'recordStartupError')).toBe('./startup-errors.ts')
    for (const name of ['installAdVersionRecheck', 'disposeAdVersionRecheck', 'resolveSystemBinary', 'recordStartupError']) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
  })

  test('installs it exactly once, in main()\'s own statement list (behind no branch), in the statement right after the awaited startup gate and before the PID check', () => {
    const at = onlyCallOf('installAdVersionRecheck')
    // The import and this call are the only mentions: no second install in
    // another form (an alias, a callback).
    expect(indicesOf(/\binstallAdVersionRecheck\b/g, SERVER_CODE)).toHaveLength(2)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    const gate = onlyCallOf('runAgentDirectorStartupGate')
    expect(at).toBeGreaterThan(gate)
    // Right after: nothing but the gate call itself sits between the two.
    const [, gateEnd] = balancedAfter(SERVER_CODE, gate, '(', ')')
    expect(SERVER_CODE.slice(gateEnd + 1, at).replace(/[\s;]/g, '')).toBe('')
    const pidChecks = callsOf('checkPidConflict')
    expect(pidChecks.length).toBeGreaterThan(0)
    for (const pid of pidChecks) expect(at).toBeLessThan(pid)
  })

  test('its options are exactly the resolve, the baseline, the record hook, the stop and the log: no clock and nothing that names health_check_interval', () => {
    const props = onlyCallProps('installAdVersionRecheck')
    expect([...props.keys()].sort()).toEqual([...INSTALL_OPTIONS])
    expect(onlyCallArguments(SERVER_CODE, 'installAdVersionRecheck')).not.toMatch(/\bhealth_check_interval\b/)
  })

  test('its baseline version is the gate\'s result by name: `const <gate> = await runAgentDirectorStartupGate()`, then baselineVersion: <gate>.adVersion', () => {
    const decls = [...SERVER_CODE.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+runAgentDirectorStartupGate\s*\(/g)]
    expect(decls).toHaveLength(1)
    expect(onlyCallProps('installAdVersionRecheck').get('baselineVersion')).toBe(`${decls[0]![1]}.${GATE_VERSION_FIELD}`)
  })

  test('its resolve is agent-director\'s resolveSystemBinary, its record hook recordStartupError and its log the server log', () => {
    const props = onlyCallProps('installAdVersionRecheck')
    expect(props.get('resolveSystemBinary')).toBe('resolveSystemBinary')
    expect(props.get('recordStartupError')).toBe('recordStartupError')
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
  })

  // The re-check calls `stop(AD_VERSION_RECHECK_STOP_EXIT_CODE)` (driven in
  // tests/ad-version-gate.test.ts); this case pins that main()'s stop hands
  // that code on untouched, to shutdown and to the exit of a rejected shutdown.
  test('its stop runs shutdown with the exit code the re-check passes (AD_VERSION_RECHECK_STOP_EXIT_CODE, non-zero), and a rejected shutdown still exits with it', () => {
    expect(AD_VERSION_RECHECK_STOP_EXIT_CODE).not.toBe(0)
    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const param = stop!.match(ARROW_PARAM)
    expect(param).not.toBeNull()
    const code = param![1]!
    const calls = shutdownCallsIn(stop!)
    expect(calls).toHaveLength(1)
    const args = splitTopLevel(callArguments(stop!, calls[0]!))
    expect(args).toHaveLength(2)
    expect(args[1]).toBe(code)
    // The shutdown promise's rejection is caught with an exit on the same code.
    const [, callEnd] = balancedAfter(stop!, calls[0]!, '(', ')')
    expect(stop!.slice(callEnd + 1)).toMatch(/^\s*\.\s*catch\s*\(/)
    const exits = exitsIn(stop!)
    expect(exits).toHaveLength(1)
    expect(splitTopLevel(callArguments(stop!, exits[0]!))).toEqual([code])
  })

  // No outside party ends a re-check stop (the CLI's SIGKILL follows only its
  // own stop), so the stop arms the fallback exit before it runs shutdown.
  // What the deadline does is driven in tests/shutdown-deadline.test.ts; this
  // case pins that only this stop arms it, first, with the stop's code, the
  // real exit and the module's own clock and deadline.
  test('its stop arms the shutdown deadline first (SRJ-205, AC 21): the one armShutdownDeadline call, from shutdown-deadline.ts, with the stop\'s exit code, process.exit, the server log and no clock or deadline override; the signals and shutdown arm none', () => {
    expect(importSource(SERVER_CODE, 'armShutdownDeadline')).toBe('./shutdown-deadline.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+armShutdownDeadline\b/g, SERVER_CODE)).toEqual([])
    // The import and the one call are its only mentions: no alias, no second arm.
    expect(indicesOf(/\barmShutdownDeadline\b/g, SERVER_CODE)).toHaveLength(2)
    onlyCallOf('armShutdownDeadline')

    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const code = stop!.match(ARROW_PARAM)![1]!
    // The first statement of the stop's body, behind no branch, so it runs
    // before the stop's shutdown call.
    const body = stop!.slice(...balancedAfter(stop!, stop!.indexOf('=>'), '{', '}'))
    expect(body.trimStart()).toMatch(/^armShutdownDeadline\s*\(/)
    const arms = indicesOf(/(?<![\w.$])armShutdownDeadline\s*\(/g, stop!)
    expect(arms).toHaveLength(1)
    const shutdowns = shutdownCallsIn(stop!)
    expect(shutdowns).toHaveLength(1)
    expect(arms[0]!).toBeLessThan(shutdowns[0]!)

    const args = splitTopLevel(callArguments(stop!, arms[0]!))
    expect(args).toHaveLength(1)
    const props = objectProperties(args[0]!)
    expect([...props.keys()].sort()).toEqual([...ARM_OPTIONS])
    expect(props.get('exitCode')).toBe(code)
    expect(props.get('exit')).toMatch(/^process\s*\.\s*exit(?:\s*\.\s*bind\s*\(\s*process\s*\))?$/)
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
      expect(handlers).toHaveLength(1)
      expect([signal, indicesOf(/\barmShutdownDeadline\b/g, callArguments(SERVER_CODE, handlers[0]!))]).toEqual([signal, []])
    }
    expect(indicesOf(/\barmShutdownDeadline\b/g, shutdownCode())).toEqual([])
  })

  // A shutdown that hangs on a promise with no open handle behind it lets the
  // process run out of work and exit on its own, before the unref'd deadline
  // can fire; that exit carries `process.exitCode`. So the stop sets it to its
  // own code before it runs shutdown, and nothing else in server.ts touches it
  // (a signal's shutdown exits 0 through `shutdown`'s own exit).
  test('its stop sets process.exitCode to the stop\'s exit code, as a statement of its body, before its shutdown call; nothing else in server.ts names process.exitCode', () => {
    const exitCodeRefs = indicesOf(/\bprocess\s*\.\s*exitCode\b/g, SERVER_CODE)
    expect(exitCodeRefs).toHaveLength(1)
    const [argsStart, argsEnd] = balancedAfter(SERVER_CODE, onlyCallOf('installAdVersionRecheck'), '(', ')')
    expect(exitCodeRefs[0]! > argsStart && exitCodeRefs[0]! < argsEnd).toBe(true)

    const stop = onlyCallProps('installAdVersionRecheck').get('stop')
    expect(stop).toBeDefined()
    const code = stop!.match(ARROW_PARAM)![1]!
    const [bodyStart, bodyEnd] = balancedAfter(stop!, stop!.indexOf('=>'), '{', '}')
    const body = stop!.slice(bodyStart, bodyEnd)
    const sets = [...body.matchAll(/\bprocess\s*\.\s*exitCode\s*=(?!=)\s*([^;\s]+)/g)]
    expect(sets).toHaveLength(1)
    expect(sets[0]![1]).toBe(code)
    expect(statementOfBlock(body, sets[0]!.index!)).toBe(true)
    const shutdowns = shutdownCallsIn(body)
    expect(shutdowns).toHaveLength(1)
    expect(sets[0]!.index!).toBeLessThan(shutdowns[0]!)

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
      expect(handlers).toHaveLength(1)
      expect([signal, indicesOf(/\bexitCode\b/g, callArguments(SERVER_CODE, handlers[0]!))]).toEqual([signal, []])
    }
    expect(indicesOf(/\bprocess\s*\.\s*exitCode\b/g, shutdownCode())).toEqual([])
  })

  // The stop can come while main() is still starting up (the re-check's
  // timer is armed before the PID check). shutdown() stops what it finds, so
  // main() must not start the HTTP server, the start bring-up, the health
  // check or the detection tick once a shutdown has begun; nor the start
  // sweep or a bootstrap pass after it (trust, JSONL safeguard, Stop hook),
  // so a version re-check's stop changes no agent-director row (b.jg5
  // SRJ-205, SRJ-714). main() can only observe that after it resumes from an
  // await, so each of those calls needs an `if (shuttingDown) return` between
  // the last await before it and the call. Every `await` in main()'s text
  // counts, a closure's included, so the rule errs strict.
  test.each<[string, (controller: string) => RegExp]>([
    ['the HTTP server (Bun.serve)', () => /\bBun\s*\.\s*serve\s*\(/g],
    ['the start bring-up (<controller>.runStartBringUp)', (controller) => new RegExp(`\\b${controller}\\s*\\.\\s*runStartBringUp\\s*\\(`, 'g')],
    ['the health check (startHealthCheck)', () => /(?<![\w.$])startHealthCheck\s*\(/g],
    ['the reload detection tick (<controller>.startDetection)', (controller) => new RegExp(`\\b${controller}\\s*\\.\\s*startDetection\\s*\\(`, 'g')],
    ['the boot template install (installSlackChannelBotTemplate)', () => /(?<![\w.$])installSlackChannelBotTemplate\s*\(/g],
    ['the start sweep (reconcileOrphans)', () => /(?<![\w.$])reconcileOrphans\s*\(/g],
    ['the trust bootstrap (trustBootstrap)', () => /(?<![\w.$])trustBootstrap\s*\(/g],
    ['the JSONL-persistence safeguard (runJsonlPersistenceSafeguard)', () => /(?<![\w.$])runJsonlPersistenceSafeguard\s*\(/g],
    ['the Stop-hook bootstrap (stopHookBootstrap)', () => /(?<![\w.$])stopHookBootstrap\s*\(/g],
  ])('main() starts %s only if no shutdown has begun: an `if (shuttingDown) return` in main()\'s own statement list after the last await before the call', (_what, callPattern) => {
    const [start, end] = mainBody(SERVER_CODE)
    const calls = indicesOf(callPattern(startResolution(SERVER_CODE).controller), SERVER_CODE)
    expect(calls).toHaveLength(1)
    const at = calls[0]!
    expect(at > start && at < end).toBe(true)
    // The call's own `await`, when it has one, is not an await before it.
    const own = SERVER_CODE.slice(start, at).match(/\bawait\s*$/)
    const callStart = own ? at - own[0].length : at
    const awaits = indicesOf(/\bawait\b/g, SERVER_CODE).filter((a) => a > start && a < callStart)
    expect(awaits.length).toBeGreaterThan(0)
    const lastAwait = awaits[awaits.length - 1]!
    const guards = indicesOf(/\bif\s*\(\s*shuttingDown\s*\)\s*return\b/g, SERVER_CODE)
      .filter((g) => g > lastAwait && g < callStart && atMainTopLevel(SERVER_CODE, g))
    expect(guards.length).toBeGreaterThan(0)
  })

  test('shutdown disposes the re-check exactly once, with no argument, before its first await and before it exits', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const at = onlyCallOf('disposeAdVersionRecheck')
    expect(at > start && at < end).toBe(true)
    expect(onlyCallArguments(SERVER_CODE, 'disposeAdVersionRecheck').trim()).toBe('')
    // Before shutdown first yields, so no re-check starts while it closes things.
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
    const exits = exitsIn(SERVER_CODE).filter((exit) => exit > start && exit < end)
    expect(exits.length).toBeGreaterThan(0)
    for (const exit of exits) expect(at).toBeLessThan(exit)
  })

  test('shutdown(reason, exitCode = 0) ends by exiting with its exit code, and exits nowhere else', () => {
    const decl = SERVER_CODE.search(/\basync\s+function\s+shutdown\s*\(/)
    expect(decl).toBeGreaterThan(-1)
    const params = splitTopLevel(callArguments(SERVER_CODE, decl))
    expect(params).toHaveLength(2)
    const exitParam = params[1]!.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*0$/)
    expect(exitParam).not.toBeNull()
    const code = shutdownCode()
    const exits = exitsIn(code)
    expect(exits).toHaveLength(1)
    expect(splitTopLevel(callArguments(code, exits[0]!))).toEqual([exitParam![1]])
    const [, exitEnd] = balancedAfter(code, exits[0]!, '(', ')')
    expect(code.slice(exitEnd + 1).replace(/[\s;]/g, '')).toBe('')
  })

  test.each(['SIGTERM', 'SIGINT'])('the %s handler runs shutdown with no non-zero exit code', (signal) => {
    const handlers = indicesOf(new RegExp(`\\bprocess\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"]${signal}['"]`, 'g'), SERVER_CODE)
    expect(handlers).toHaveLength(1)
    const handler = splitTopLevel(callArguments(SERVER_CODE, handlers[0]!))[1]
    expect(handler).toBeDefined()
    const calls = shutdownCallsIn(handler!)
    expect(calls).toHaveLength(1)
    const args = splitTopLevel(callArguments(handler!, calls[0]!))
    // A reason alone (the default exit code 0) or an explicit 0.
    expect(args.length === 1 || (args.length === 2 && args[1] === '0')).toBe(true)
  })

  test('shutdown makes no agent-director call: no client, no detection wrapper, no resolve and no verb the stub client records', () => {
    const code = shutdownCode()
    for (const name of ['getClient', 'withOutageDetection', 'withSpawnDetection', 'resolveSystemBinary']) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\s*\\(`, 'g'), code)]).toEqual([name, []])
    }
    // The verbs: every key of the stub client's call log, less its `Calls` suffix.
    const keys = Object.keys(makeStubCallLog())
    const verbs = keys.map((key) => key.replace(/Calls$/, ''))
    expect(verbs.length).toBeGreaterThan(0)
    expect(verbs.every((verb, i) => verb !== keys[i] && verb !== '')).toBe(true)
    for (const verb of verbs) {
      // A method call (`x.verb(`, `x?.verb(`) or a plain one.
      expect([verb, indicesOf(new RegExp(`(?<![\\w$])${verb}\\s*\\(`, 'g'), code)]).toEqual([verb, []])
    }
  })
})

// ---------------------------------------------------------------------------
// Static audit: agent-director's timing settings are read at start, and again
// only on the version re-check's tick (b.jg5 SRJ-209)
//
// What the install does (the startup read, the re-read after each 120 s
// re-check tick whatever health_check_interval is, none after the re-check's
// dispose, the file under the process's HOME) is driven through its real
// module in tests/ad-settings.test.ts. What only server.ts holds is where
// main() calls it, with what, and that nothing else in server.ts reads the
// file.
// ---------------------------------------------------------------------------

describe('main() installs agent-director\'s settings read once, after the startup gate and the start\'s configuration resolution and before the start bring-up, under the process\'s own HOME (b.jg5 SRJ-209)', () => {
  /** The install; typed against its module, so a rename fails the typecheck. */
  const INSTALL: keyof typeof AdSettingsModule = 'installAdSettings'

  /**
   * What would read the settings, or re-read them, other than through the
   * install: a reader of its own, the reader's production HOME, the file's
   * path, and a listener of its own on the re-check's tick. Typed against
   * their modules, so a rename fails the typecheck.
   */
  const OTHER_READ_NAMES: ReadonlyArray<keyof typeof AdSettingsModule | keyof typeof AdVersionGateModule> = [
    'createAdSettingsReader',
    'productionAdSettingsHome',
    'AD_SETTINGS_RELATIVE_PATH',
    'onAdVersionRecheckTick',
  ]

  /** src/ad-settings.ts with every comment removed. */
  const AD_SETTINGS_CODE = stripComments(readFileSync(join(SRC_DIR, 'ad-settings.ts'), 'utf-8'))

  test('imports the install from the settings module and declares it nowhere itself; the import and one call are its only mentions', () => {
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./ad-settings.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    // No second install in another form (an alias, a callback, a timer).
    expect(indicesOf(new RegExp(`\\b${INSTALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    onlyCallOf(INSTALL)
  })

  test('calls it in main()\'s own statement list, behind no branch (so in dry run too), as a statement of its own whose result is dropped', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    // Nothing before it on its statement: no binding of the reader it
    // returns (which could be read again on a timer), no await, no operand.
    const before = SERVER_CODE.slice(0, at).trimEnd()
    expect(before).not.toMatch(/(?:[=(,:?&|!+\-*/<>[.]|\b(?:return|await|void|yield|new|typeof|throw|delete))$/)
  })

  test.each<[string, () => number]>([
    ['the startup gate (runAgentDirectorStartupGate)', () => onlyCallOf('runAgentDirectorStartupGate')],
    ['the start resolution (<controller>.resolveStart)', () => startResolution(SERVER_CODE).resolveAt],
    ['the applied config\'s start assignment (<loaded> = <outcome>.config)', () => startResolution(SERVER_CODE).assignAt],
  ])('calls it AFTER %s', (_label, anchor) => {
    expect(onlyCallOf(INSTALL)).toBeGreaterThan(anchor())
  })

  test('calls it BEFORE the start bring-up (<controller>.runStartBringUp)', () => {
    expect(onlyCallOf(INSTALL)).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('passes no argument, so the read takes its production dependencies: the file under the server process\'s own HOME, and no HOME, health_check_interval or persona value from the configuration', () => {
    expect(onlyCallArguments(SERVER_CODE, INSTALL).trim()).toBe('')
  })

  test('nothing else in server.ts reads the settings: no reader or tick listener of its own, no production HOME, and neither the settings file nor the TOML parser named', () => {
    for (const name of OTHER_READ_NAMES) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    for (const path of [AD_SETTINGS_RELATIVE_PATH, basename(AD_SETTINGS_RELATIVE_PATH)]) {
      expect([path, SERVER_CODE.includes(path)]).toEqual([path, false])
    }
    // The parser package is the one the settings module imports its parse from.
    const parser = importSource(AD_SETTINGS_CODE, 'parse')
    expect(parser).toBeDefined()
    expect(indicesOf(new RegExp(`['"\`]${parser}['"\`]`, 'g'), SERVER_CODE)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the call-timeout start step runs once per start, right after
// the settings read and before the start pass (b.jg5 SRJ-213)
//
// What the step does (one startup check, then the persona client built with
// the setting's value, a warning never stopping the start) is driven through
// the exported step in tests/server.test.ts, and the check and the need in
// tests/ad-settings.test.ts. What only server.ts holds is where main() calls
// the step, with what, and that nothing calls it again.
// ---------------------------------------------------------------------------

describe('main() runs the call-timeout start step once, after the startup gate, the start\'s configuration resolution and the settings read, and before the template install and the start bring-up, over the start-time config (b.jg5 SRJ-213)', () => {
  /** The step, the check it runs and the persona-client builder; typed against their modules, so a rename fails the typecheck. */
  const STEP: keyof typeof ServerModule = '_runCallTimeoutStartStep'
  const CHECK: keyof typeof AdSettingsModule = 'checkAdCallTimeoutAtStartup'
  const BUILD: keyof typeof AdStartupModule = 'buildPersonaClientOrExit'
  const SETTINGS_INSTALL: keyof typeof AdSettingsModule = 'installAdSettings'

  /** Offsets of every code call of the step (its declaration excluded). */
  const stepCalls = (): number[] =>
    indicesOf(new RegExp(`(?<![\\w.$]|\\bfunction\\s+)${STEP}\\s*\\(`, 'g'), SERVER_CODE)

  /** Offset of the only call of the step; fails unless there is exactly one. */
  const stepCall = (): number => {
    const calls = stepCalls()
    expect(calls).toHaveLength(1)
    return calls[0]!
  }

  /** [start, end) of the step's own body in server.ts. */
  const stepBody = (): [number, number] => {
    const decls = indicesOf(new RegExp(`\\bexport\\s+async\\s+function\\s+${STEP}\\s*\\(`, 'g'), SERVER_CODE)
    expect(decls).toHaveLength(1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decls[0]!, '(', ')')
    return balancedAfter(SERVER_CODE, paramsEnd, '{', '}')
  }

  test('server.ts declares the step once and calls it exactly once, awaited, in main()\'s own statement list (behind no branch, so in dry run too); its declaration and that call are its only mentions', () => {
    expect(indicesOf(new RegExp(`\\b${STEP}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    stepBody()
    const at = stepCall()
    expect(insideMain(at)).toBe(true)
    const awaitAt = SERVER_CODE.slice(0, at).search(/\bawait\s+$/)
    expect(awaitAt).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, awaitAt)).toBe(true)
  })

  test('the startup gate is still called exactly once, with no argument, and before the step: its version probe keeps the client\'s default call timeout', () => {
    expect(onlyCallArguments(SERVER_CODE, 'runAgentDirectorStartupGate').trim()).toBe('')
    expect(onlyCallOf('runAgentDirectorStartupGate')).toBeLessThan(stepCall())
  })

  test.each<[string, () => number]>([
    ['the start resolution (<controller>.resolveStart)', () => startResolution(SERVER_CODE).resolveAt],
    ['the applied config\'s start assignment (<loaded> = <outcome>.config)', () => startResolution(SERVER_CODE).assignAt],
    ['the settings install (installAdSettings)', () => onlyCallOf(SETTINGS_INSTALL)],
  ])('calls it AFTER %s', (_label, anchor) => {
    expect(stepCall()).toBeGreaterThan(anchor())
  })

  test.each<[string, () => number[]]>([
    ['the template install (installSlackChannelBotTemplate)', () => callsOf('installSlackChannelBotTemplate')],
    ['the start bring-up (<controller>.runStartBringUp)', () => [startResolution(SERVER_CODE).bringUpAt]],
  ])('calls it BEFORE %s', (_label, anchors) => {
    const later = anchors()
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(stepCall()).toBeLessThan(at)
  })

  // The start-time applied config: the variable set once, from the start
  // outcome's config, and never replaced (a confirmed apply replaces the
  // applied persona set, `<loaded>`, not it). So the step takes the
  // configuration the start resolved, never a loader, the file or a literal.
  test('passes one argument, the start-time applied config: a variable whose only assignment is `= <loaded>`, after the start assignment and before the step, and which no declaration initializes', () => {
    const { loaded, assignAt } = startResolution(SERVER_CODE)
    const args = splitTopLevel(callArguments(SERVER_CODE, stepCall()))
    expect(args).toHaveLength(1)
    const config = args[0]!
    expect(config).toMatch(/^[A-Za-z_$][\w$]*$/)
    const assigns = assignmentsTo(config)
    expect(assigns.map(({ value }) => value)).toEqual([loaded])
    expect(assigns[0]!.at).toBeGreaterThan(assignAt)
    expect(assigns[0]!.at).toBeLessThan(stepCall())
    expect(indicesOf(new RegExp(`\\b(?:let|const|var)\\s+${config}\\b\\s*(?:!?\\s*:[^=;\\n]*)?=(?![=>])`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the step and the check are on no tick and no timer: no tick listener, interval, timeout or microtask in server.ts names the step, the check or the persona-client builder, and the check runs only inside the step', () => {
    for (const hook of ['onAdVersionRecheckTick', 'setInterval', 'setTimeout', 'queueMicrotask']) {
      for (const at of callsOf(hook)) {
        const args = callArguments(SERVER_CODE, at)
        for (const name of [STEP, CHECK, BUILD]) {
          expect([hook, name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), args)]).toEqual([hook, name, []])
        }
      }
    }
    // The check: one call in server.ts, inside the step's body, which itself
    // registers nothing on a tick or a timer.
    const [bodyStart, bodyEnd] = stepBody()
    const checks = indicesOf(new RegExp(`(?<![\\w.$])${CHECK}\\s*\\(`, 'g'), SERVER_CODE)
    expect(checks).toHaveLength(1)
    expect(checks[0]! > bodyStart && checks[0]! < bodyEnd).toBe(true)
    const body = SERVER_CODE.slice(bodyStart, bodyEnd)
    for (const hook of ['onAdVersionRecheckTick', 'setInterval', 'setTimeout', 'queueMicrotask', 'installAdVersionRecheck']) {
      expect([hook, indicesOf(new RegExp(`\\b${hook}\\b`, 'g'), body)]).toEqual([hook, []])
    }
  })

  // main() passes the step no deps, so these defaults are what production
  // runs; tests/server.test.ts drives the step only with injected ones.
  test('the step\'s production defaults (PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS), declared once and spread first into the step\'s deps: buildPersonaClient hands the call timeout to buildPersonaClientOrExit, valuesInEffect is adSettingsInEffect, log writes to console.error', () => {
    const decls = indicesOf(/^const\s+PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS\b[^=]*=\s*\{/gm, SERVER_CODE)
    expect(decls).toHaveLength(1)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', decls[0]!)))
    expect([...props.keys()]).toEqual(['buildPersonaClient', 'valuesInEffect', 'log'])
    expect(props.get('buildPersonaClient')).toMatch(new RegExp(`^\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*${BUILD}\\(\\s*\\1\\s*\\)$`))
    const inEffect: keyof typeof AdSettingsModule = 'adSettingsInEffect'
    expect(props.get('valuesInEffect')).toBe(inEffect)
    expect(props.get('log')).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*console\.error\(\s*\1\s*\)$/)
    expect(assignmentsTo('PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS')).toEqual([])

    const body = SERVER_CODE.slice(...stepBody())
    expect(body).toMatch(/\{\s*\.\.\.PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS\s*,\s*\.\.\.deps\s*\}/)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the retired-key record's start read (b.jg5 SRJ-801, SRJ-802)
//
// What the read does (a missing file, each unreadable form and its one
// startup-errors entry, the store) is driven through the module in
// tests/retired-keys.test.ts. What only server.ts holds is where main() reads
// the record, over which directory, that a refusal exits, and that main()
// holds the one store.
// ---------------------------------------------------------------------------

describe('main() reads the retired-key record once, behind no branch, after the PID check and before the start resolution, the start sweep and the start bring-up, exits on a refusal and holds the one store (b.jg5 SRJ-801, SRJ-802)', () => {
  /** The start read; typed against its module, so a rename fails the typecheck. */
  const START_READ: keyof typeof RetiredKeysModule = 'readRetiredKeysAtStart'
  /** What else could build a store, or name or write the file; typed against the module. */
  const OTHER_RECORD_NAMES: ReadonlyArray<keyof typeof RetiredKeysModule> = [
    'loadRetiredKeyStore',
    'retiredKeysPath',
    'serializeRetiredKeys',
    'parseRetiredKeys',
    'RETIRED_KEYS_FILE_NAME',
  ]

  /** The `const <outcome> = readRetiredKeysAtStart(` binding: its name and the call's offset. */
  const startRead = (): { outcome: string; at: number } => ({ outcome: constOf(START_READ), at: onlyCallOf(START_READ) })

  test('imports the start read from the record module, declares it nowhere, and binds its one call to a const in main()\'s own statement list (so in dry run too)', () => {
    expect(importSource(SERVER_CODE, START_READ)).toBe('./retired-keys.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${START_READ}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${START_READ}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    const { outcome, at } = startRead()
    const decl = SERVER_CODE.slice(0, at).search(new RegExp(`\\bconst\\s+${outcome}\\b[^=]*=\\s*$`))
    expect(decl).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
  })

  test('reads over the server state directory (STATE_DIR, resolveServerStateDir()) with only a log to console.error, so production\'s reader, writer, clock and startup-errors recorder are used', () => {
    expect(SERVER_CODE).toMatch(/^const\s+STATE_DIR\s*=\s*resolveServerStateDir\s*\(\s*\)/m)
    const args = onlyCallArgs(START_READ)
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('STATE_DIR')
    const props = objectProperties(args[1]!)
    expect([...props.keys()]).toEqual(['log'])
    expect(props.get('log')).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*console\.error\(\s*\1\s*\)$/)
  })

  test('a refused read exits 1 in the next statement, and the loaded store is bound once, to a const, from the outcome', () => {
    const { outcome, at } = startRead()
    const [, argsEnd] = balancedAfter(SERVER_CODE, at, '(', ')')
    const after = SERVER_CODE.slice(argsEnd + 1)
    const sequence = new RegExp(
      `^\\s*;?\\s*if\\s*\\(\\s*${outcome}\\s*\\.\\s*kind\\s*===\\s*'refused'\\s*\\)\\s*\\{?\\s*process\\s*\\.\\s*exit\\s*\\(\\s*1\\s*\\)\\s*;?\\s*\\}?\\s*` +
        `const\\s+(\\w+)(?:\\s*:\\s*\\w+)?\\s*=\\s*${outcome}\\s*\\.\\s*store\\b`,
    )
    const match = after.match(sequence)
    expect(match).not.toBeNull()
    declaredOnce(match![1]!)
    // The outcome is named only at its binding, the refusal check and the store's binding.
    expect(indicesOf(new RegExp(`\\b${outcome}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
  })

  test.each<[string, () => number]>([
    ['the startup gate (runAgentDirectorStartupGate)', () => onlyCallOf('runAgentDirectorStartupGate')],
    ['the PID check (checkPidConflict)', () => onlyCallOf('checkPidConflict')],
  ])('reads AFTER %s', (_label, anchor) => {
    expect(startRead().at).toBeGreaterThan(anchor())
  })

  // The start sweep (reconcileOrphans) runs inside the start bring-up, which
  // the controller runs after the start resolution; its call is also later in
  // the source.
  test.each<[string, () => number[]]>([
    ['the reload controller (createReloadController)', () => [startResolution(SERVER_CODE).createAt]],
    ['the start resolution, which can write the last-applied record (<controller>.resolveStart)', () => [startResolution(SERVER_CODE).resolveAt]],
    ['the start sweep (reconcileOrphans)', () => callsOf('reconcileOrphans')],
    ['the start bring-up (<controller>.runStartBringUp)', () => [startResolution(SERVER_CODE).bringUpAt]],
    ['the PID file (writePidFile)', () => callsOf('writePidFile')],
    ['the connection manager (createPersonaConnectionManager)', () => callsOf('createPersonaConnectionManager')],
    ['Bun.serve', () => callsOf('Bun\\.serve')],
  ])('reads BEFORE %s', (_label, anchors) => {
    const later = anchors()
    expect(later.length).toBeGreaterThan(0)
    for (const at of later) expect(startRead().at).toBeLessThan(at)
  })

  test('main() builds no second store and server.ts names the file only through the module; no other src file reads the record at start or builds a store', () => {
    for (const name of OTHER_RECORD_NAMES) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    expect(SERVER_CODE.includes(RETIRED_KEYS_FILE_NAME)).toBe(false)
    const builders = srcFiles()
      .filter(([path]) => path !== 'src/retired-keys.ts')
      .filter(([, source]) => new RegExp(`\\b(?:${START_READ}|loadRetiredKeyStore)\\s*\\(`).test(stripComments(source)))
      .map(([path]) => path)
    expect(builders).toEqual(['src/server.ts'])
  })
})

// ---------------------------------------------------------------------------
// Static audit: the bring-up gets the loaded config and the bring-up
// controller; shutdown cancels the controller's retries (SR-6.1, SR-6.4)
// ---------------------------------------------------------------------------

describe('startupSessionManager runs the SR-6.1 bring-up over the loaded persona config through the bring-up controller, which shutdown cancels (SR-6.1, SR-6.4)', () => {
  test('is the reload controller\'s start bring-up: it gets the applied config the controller supplies, as its bring-up the bring-up controller, and as its shutdown query a live read of `shuttingDown` (b.jg5 SRJ-205)', () => {
    // The only startupSessionManager call is the whole body of the controller's
    // lifecycle `startBringUp`, and its first argument is that closure's
    // parameter: the controller's applied config (the record's at a start
    // from the record), never the module-level config or a config read again
    // from the file. main() requests the pass with no argument, so the
    // controller supplies the config.
    const { createAt, bringUpAt, controller } = startResolution(SERVER_CODE)
    const lifecycle = objectProperties(callArguments(SERVER_CODE, createAt)).get('lifecycle')
    expect(lifecycle).toBeDefined()
    const startBringUp = objectProperties(lifecycle!).get('startBringUp')
    expect(startBringUp).toBeDefined()
    const arrow = startBringUp!.match(/^\(?\s*(\w+)\s*\)?\s*=>\s*startupSessionManager\s*\(/)
    expect(arrow).not.toBeNull()
    // The call is the tail of the body: nothing follows its closing bracket.
    const [, close] = balancedAfter(startBringUp!, arrow![0].length - 1, '(', ')')
    expect(close).toBe(startBringUp!.length - 1)
    const [start, end] = balancedAfter(SERVER_CODE, createAt, '(', ')')
    const at = onlyCallOf('startupSessionManager')
    expect(at > start && at < end).toBe(true)

    const args = onlyCallArgs('startupSessionManager')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(arrow![1])
    const options = objectProperties(args[1]!)
    expect([...options.keys()]).toEqual(['bringUp', 'isShuttingDown'])
    expect(options.get('bringUp')).toBe(constOf('createPersonaBringUpController'))
    // b.jg5 SRJ-205 (the E4 gate): the launch pool asks the query before each
    // launch, so it is an arrow reading the flag at call time, never a value
    // captured when the pass began. The flag is server.ts's one module-level
    // `let shuttingDown` (tests/start-sweep-wiring.test.ts pins that).
    expect(options.get('isShuttingDown')).toBe('() => shuttingDown')

    expect(insideMain(bringUpAt)).toBe(true)
    expect(SERVER_CODE.slice(bringUpAt)).toMatch(/^runStartBringUp\s*\(\s*\)/)
    expect(SERVER_CODE.slice(0, bringUpAt)).toMatch(new RegExp(`\\bawait\\s+${controller}\\s*\\.\\s*$`))
  })

  test('the health check starts only after the start bring-up returns: one startHealthCheck, inside main(), after the awaited runStartBringUp(), at the applied config\'s interval', () => {
    // The previous test pins `await <controller>.runStartBringUp()`, so a call
    // after it in main() runs once the pass has returned. The reload detection
    // tick (b.av2 SR-8.2) follows the same rule.
    const { bringUpAt, loaded } = startResolution(SERVER_CODE)
    const at = onlyCallOf('startHealthCheck')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(bringUpAt)
    expect(onlyCallArgs('startHealthCheck')).toEqual([`${loaded}.health_check_interval`])
  })

  test('the bring-up controller is built once, inside main(), over the connection manager, with dry run passed through and spawnForPersona over the applied config as its launch', () => {
    const at = onlyCallOf('createPersonaBringUpController')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaConnectionManager'))
    // Built before the start bring-up runs startupSessionManager with it.
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)

    const props = onlyCallProps('createPersonaBringUpController')
    // The whole manager, so a claude_config_dir hold (bug b.g57) can close
    // the persona's connection with its `stop`.
    expect(props.get('connections')).toBe(constOf('createPersonaConnectionManager'))
    expect(props.get('dryRun')).toBe('isDryRun()')
    // b.av2 SR-8.6: the launch reads the applied config at call time (a
    // confirmed apply's step 1 swaps it), falling back to the start-time one.
    const loaded = loadedConfigName(SERVER_CODE)
    const launch = props.get('launch')
    expect(launch).toMatch(new RegExp(`^\\((\\w+)\\) => spawnForPersona\\(\\1, ${loaded} \\?\\? (\\w+), false\\)$`))
    // The fallback is the start-time applied config getRestartDelay reads.
    const appliedName = launch!.match(/\?\? (\w+), false\)$/)![1]
    expect(appliedName).not.toBe(loaded)
    expect(onlyCallProps('initRestart').get('getRestartDelay')).toBe(`() => ${appliedName}.session_restart_delay`)
  })

  // b.av2 SR-8.6: optional in the controller's type, so only this audit makes
  // sure production binds it. Without it every known persona counts as
  // applied: a removed persona's retry would still launch it, and a re-check
  // would use the set it was brought up with (the E11 stale-set carry).
  test('the bring-up controller reads the live applied persona set: appliedPersonas is () => <applied config>?.personas ?? []', () => {
    const props = onlyCallProps('createPersonaBringUpController')
    const loaded = loadedConfigName(SERVER_CODE)
    expect(props.get('appliedPersonas')).toBe(`() => ${loaded}?.personas ?? []`)
    // The same module-level holder the start sets and the reload controller's onApplied swaps.
    expect(SERVER_CODE).toMatch(new RegExp(`^let\\s+${loaded}\\s*:\\s*PersonaConfig\\s*\\|\\s*null\\s*=\\s*null\\s*$`, 'm'))
  })

  test('main() stores the controller for the manager\'s status listener and for shutdown: `bringUps = <controller>` once, inside main(), right after it is built and before anything connects', () => {
    expect(SERVER_CODE).toMatch(/^let\s+bringUps\s*:\s*PersonaBringUpController\s*\|\s*undefined\s*$/m)
    const controller = constOf('createPersonaBringUpController')
    const assigns = assignmentsTo('bringUps')
    expect(assigns.map((a) => a.value)).toEqual([controller])
    const at = assigns[0]!.at
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaBringUpController'))
    // Nothing connects before the start pass: server.ts never calls a
    // connection manager's bringUp itself, the controller does, from
    // startupSessionManager (the reload controller's start bring-up). So the
    // holder is set before any status can fire. The one `.bringUp(` in
    // server.ts is the reload controller's `lifecycle.bringUp` member (a
    // confirmed apply's step 6), which runs only after the start; what it
    // forwards to is pinned in tests/reload-wiring.test.ts.
    const bringUpCalls = indicesOf(/\.\s*bringUp\s*\(/g, SERVER_CODE)
    expect(bringUpCalls).toHaveLength(1)
    const [optionsStart, optionsEnd] = balancedAfter(SERVER_CODE, onlyCallOf('createReloadController'), '(', ')')
    expect(bringUpCalls[0]!).toBeGreaterThan(optionsStart)
    expect(bringUpCalls[0]!).toBeLessThan(optionsEnd)
    const lifecycle = objectProperties(onlyCallProps('createReloadController').get('lifecycle') ?? '')
    expect(indicesOf(/\.\s*bringUp\s*\(/g, lifecycle.get('bringUp') ?? '')).toHaveLength(1)
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    // Right after it is built: the only code between the controller's
    // construction and the assignment is the construction itself.
    const [, callEnd] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaBringUpController'), '(', ')')
    expect(SERVER_CODE.slice(callEnd + 1, at).trim()).toBe('')
  })

  // Bug b.g57: an unresolvable claude_config_dir is a retrying state the
  // bring-up controller holds, with no Slack connection. Both bindings are
  // optional (the controller's `checkConfigDir` defaults to a check against
  // the OS home and file system, and with no hook a launch only logs and
  // launches nothing), so only this audit makes sure production wires them:
  // without the hook a persona whose directory stops resolving after it came
  // up would keep its connection and never be launched once the directory
  // resolves; with another check, the check before its Slack step or the
  // re-check could pass a directory the launch then refuses.
  test('bug b.g57: the bring-up controller checks and re-checks a persona\'s claude_config_dir with the launch\'s own check, checkLaunchConfigDir from the session manager', () => {
    expect(onlyCallProps('createPersonaBringUpController').get('checkConfigDir')).toBe('checkLaunchConfigDir')
    expect(importSource(SERVER_CODE, 'checkLaunchConfigDir')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+checkLaunchConfigDir\b/g, SERVER_CODE)).toEqual([])
  })

  // Bug b.g57: the reload preview lists an added persona whose
  // claude_config_dir cannot be resolved. Its `checkConfigDir` is optional
  // (default: a check against the OS home and file system), so only this
  // audit makes sure the preview resolves the directory with the same check
  // the persona's bring-up and launch will use; with another check the
  // preview could promise a persona that is then held, or warn about one
  // that comes up.
  test('bug b.g57: the reload preview checks an added persona\'s claude_config_dir with the launch\'s own check, checkLaunchConfigDir from the session manager', () => {
    expect(onlyCallProps('createReloadController').get('checkConfigDir')).toBe('checkLaunchConfigDir')
    expect(importSource(SERVER_CODE, 'checkLaunchConfigDir')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+checkLaunchConfigDir\b/g, SERVER_CODE)).toEqual([])
  })

  test('bug b.g57: a launch hands an unresolvable claude_config_dir to the bring-up controller: setConfigDirUnresolvableHook(<controller>.holdForConfigDir) once, on every start, after `bringUps = <controller>` and before any launch path is wired', () => {
    const controller = constOf('createPersonaBringUpController')
    const at = onlyCallOf('setConfigDirUnresolvableHook')
    expect(onlyCallArgs('setConfigDirUnresolvableHook')).toEqual([`${controller}.holdForConfigDir`])
    expect(importSource(SERVER_CODE, 'setConfigDirUnresolvableHook')).toBe('./session-manager.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+setConfigDirUnresolvableHook\b/g, SERVER_CODE)).toEqual([])
    // In main()'s own statement list, so dry run included and behind no branch.
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    const handoff = assignmentsTo('bringUps')
    expect(handoff).toHaveLength(1)
    expect(at).toBeGreaterThan(handoff[0]!.at)
    // Before the restart module (its launches) and the start bring-up (the
    // start's launches) can launch anything.
    expect(at).toBeLessThan(onlyCallOf('initRestart'))
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('shutdown cancels every persona\'s bring-up retry, once, before the Slack connections stop', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (at: number) => at > start && at < end

    const cancels = indicesOf(/\bbringUps\s*\?\.\s*cancelAll\s*\(\s*\)/g, SERVER_CODE)
    expect(cancels).toHaveLength(1)
    expect(inShutdown(cancels[0]!)).toBe(true)

    const stops = indicesOf(/\bconnections\s*\?\.\s*stopAll\s*\(\s*\)/g, SERVER_CODE)
    expect(stops).toHaveLength(1)
    expect(inShutdown(stops[0]!)).toBe(true)
    expect(cancels[0]!).toBeLessThan(stops[0]!)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the persona connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2)
//
// The seams themselves (clientFor, the identity getter, the up→flush listener,
// the event router, the archive source) are driven through the real connection
// manager in tests/persona-connection-wiring.test.ts; what only main() and the
// module scope hold is which seam gets which argument.
// ---------------------------------------------------------------------------

describe('server.ts wires the persona connection seams (SR-3.1, SR-3.4, SR-4.1, SR-7.2)', () => {
  test('the connection manager takes dry run from isDryRun() and, on each status, flushes on up the notifier every persona notice goes through and tells the bring-up controller', () => {
    const notifier = constOf('createPersonaNotifier')
    // The notices' notifier: the session manager's sink and the outage state's
    // notify. The outage notify passes its options through, so the notifier
    // routes the all-clear of an outage whose onset a persona teardown's
    // window routed as that onset was (b.jg5 SRJ-1002, SRJ-1003); the
    // parameters' names are free.
    expect(onlyCallArgs('setSessionNotifier')).toEqual([`${notifier}.notify`])
    expect(onlyCallProps('initOutageState').get('notify')).toMatch(
      new RegExp(`^\\((\\w+), (\\w+), (\\w+)\\) => \\{ void ${notifier}\\.notify\\(\\1, \\2, \\3\\);? \\}$`),
    )

    const props = onlyCallProps('createPersonaConnectionManager')
    expect(props.get('dryRun')).toBe('isDryRun()')
    expect(props.get('onStatus')).toStartWith('composePersonaStatusListeners(')
    const listeners = onlyCallArgs('composePersonaStatusListeners')
    expect(listeners).toHaveLength(2)
    expect(listeners[0]).toBe(`createPersonaUpFlushListener(${notifier})`)
    // The controller is built after (and over) the manager, so the listener
    // reaches it through the module-scope holder, never the local const (which
    // would be in its temporal dead zone when the manager is built).
    expect(listeners[1]).toMatch(/^\((\w+), (\w+)\) => bringUps\?\.onConnectionStatus\(\1, \2\)$/)
    expect(listeners[1]).not.toContain(constOf('createPersonaBringUpController'))
  })

  test('the Slack API base URL override (E14 Task 4): resolved once, inside main(), from process.env with the manager’s log, before the manager is built, and passed to it as slackApiUrl', () => {
    expect(importSource(SERVER_CODE, 'resolveSlackApiUrlOverride')).toBe('./persona-slack-clients.ts')
    const resolveAt = onlyCallOf('resolveSlackApiUrlOverride')
    expect(insideMain(resolveAt)).toBe(true)
    expect(resolveAt).toBeLessThan(onlyCallOf('createPersonaConnectionManager'))
    const managerProps = onlyCallProps('createPersonaConnectionManager')
    expect(onlyCallArgs('resolveSlackApiUrlOverride')).toEqual(['process.env', managerProps.get('log')!])
    expect(managerProps.get('log')).toBe('(line) => console.error(line)')
    expect(managerProps.get('slackApiUrl')).toBe(constOf('resolveSlackApiUrlOverride'))
  })

  test('only persona-slack-clients.ts names CSCB_SLACK_API_URL or its constant; no other src file reads the variable', () => {
    const offenders = srcFiles()
      .filter(([path]) => path !== 'src/persona-slack-clients.ts')
      .filter(([, source]) => /\bCSCB_SLACK_API_URL\b|\bSLACK_API_URL_OVERRIDE_ENV\b/.test(stripComments(source)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  test('the notifier and the permission poller share one destination resolver: createPersonaDestinations built once, at module scope, and passed as `destinations` to both (b.av2 SR-7.1)', () => {
    const resolver = constOf('createPersonaDestinations')
    expect(insideMain(onlyCallOf('createPersonaDestinations'))).toBe(false)
    expect(onlyCallProps('createPersonaNotifier').get('destinations')).toBe(resolver)
    expect(onlyCallProps('startPermissionPoller').get('destinations')).toBe(resolver)
  })

  // b.jg5 SRJ-1003: a stuck-prompt warning raised in a persona's teardown
  // window goes to the notifier, whose window writes it; the poller is handed
  // the one notifier main() builds.
  test('the permission poller\'s teardownNotices is the one persona notifier (createPersonaNotifier\'s constant), beside its destination hold', () => {
    const poller = onlyCallProps('startPermissionPoller')
    expect(poller.get('teardownNotices')).toBe(constOf('createPersonaNotifier'))
    expect(poller.get('destinationHold')).toBe(constOf('createPersonaDestinationHold'))
  })

  test('main() points the lookups at the manager: `connections = <manager>` once, inside main(), before the bring-up', () => {
    const manager = constOf('createPersonaConnectionManager')
    const assigns = assignmentsTo('connections')
    expect(assigns.map((a) => a.value)).toEqual([manager])
    expect(insideMain(assigns[0]!.at)).toBe(true)
    expect(assigns[0]!.at).toBeGreaterThan(onlyCallOf('createPersonaConnectionManager'))
    expect(assigns[0]!.at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('clientFor and identityFor are the persona-start lookups over the connection view of `connections` and the loaded config', () => {
    const view = SERVER_CODE.search(/\bconst\s+connectionView\b[^=]*=\s*\{/)
    expect(view).toBeGreaterThan(-1)
    const viewProps = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', view)))
    expect([...viewProps.keys()].sort()).toEqual(['identity', 'status', 'webClient'])
    for (const [query, value] of viewProps) {
      expect(value).toMatch(new RegExp(`^\\((\\w+)\\) => connections\\?\\.${query}\\(\\1\\)$`))
    }

    const loaded = loadedConfigName(SERVER_CODE)
    expect(constOf('createPersonaClientLookup')).toBe('clientFor')
    expect(onlyCallArgs('createPersonaClientLookup')).toEqual(['connectionView', `() => ${loaded}`])
    expect(constOf('createPersonaIdentityLookup')).toBe('identityFor')
    expect(onlyCallArgs('createPersonaIdentityLookup')).toEqual(['connectionView', `() => ${loaded}`])
  })

  test('the persona routing reads bot identities through identityFor, clients through clientFor and archives through archiveWrite', () => {
    const props = onlyCallProps('createPersonaRouting')
    expect(props.get('getBotIdentity')).toBe('identityFor')
    expect(props.has('getBotUserId')).toBe(false)
    expect(props.get('clientFor')).toBe('clientFor')
    expect(props.get('archive')).toMatch(/^\((\w+), (\w+)\) => archiveWrite\?\.\(\1, \2\)$/)
  })

  test('the persona routing raises lost-message notices through the one persona notifier\'s notify (b.av2 SR-7.3), with every argument passed on', () => {
    const notifier = constOf('createPersonaNotifier')
    const notify = onlyCallProps('createPersonaRouting').get('notify')
    expect(notify).toBeDefined()
    if (notify === `${notifier}.notify`) {
      // Read at build time: the notifier must already exist (no temporal dead zone at import).
      expect(onlyCallOf('createPersonaRouting')).toBeGreaterThan(onlyCallOf('createPersonaNotifier'))
    } else {
      // Read at call time, so the routing may be built before the notifier.
      expect(notify).toMatch(new RegExp(`^\\((\\w+), (\\w+), (\\w+)\\) => ${notifier}\\.notify\\(\\1, \\2, \\3\\)$`))
    }
  })

  test('archiveWrite is set only inside main(), to the persona archive writer over the name resolver source on clientFor', () => {
    const assigns = assignmentsTo('archiveWrite')
    expect(assigns.length).toBeGreaterThan(0)
    for (const { at } of assigns) expect(insideMain(at)).toBe(true)
    const writers = assigns.filter((a) => a.value !== 'undefined')
    expect(writers).toHaveLength(1)
    expect(writers[0]!.value).toStartWith('createPersonaArchiveWriter(')
    const call = SERVER_CODE.indexOf('createPersonaArchiveWriter', writers[0]!.at)
    const args = splitTopLevel(callArguments(SERVER_CODE, call))
    expect(args).toHaveLength(3)
    expect(args[1]).toBe('createPersonaNameResolverSource(clientFor)')
  })
})

// ---------------------------------------------------------------------------
// Static audit: only a serving persona is relaunched; the restart delay
// ---------------------------------------------------------------------------

describe('server.ts gates every relaunch on the persona\'s connection (SR-6.1) and reads the restart delay from the applied config', () => {
  test('the relaunch gate is built once, inside main(), over the connection manager and the bring-up controller\'s outcomes', () => {
    constOf('createPersonaRelaunchGate')
    const at = onlyCallOf('createPersonaRelaunchGate')
    expect(insideMain(at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('createPersonaBringUpController'))
    const args = onlyCallArgs('createPersonaRelaunchGate')
    expect(args).toHaveLength(3)
    expect(args[0]).toBe(constOf('createPersonaConnectionManager'))
    expect(args[2]).toBe(constOf('createPersonaBringUpController'))
  })

  test('the restart module asks the gate before it touches a persona: canRestart is the gate (b.av2 SR-6.4)', () => {
    expect(onlyCallProps('initRestart').get('canRestart')).toBe(constOf('createPersonaRelaunchGate'))
  })

  test('the restart module\'s launch passes the live applied config (read at call time, SR-8.6), the gate to launchSession as canLaunch, and the escalate-dead verdict it is handed as deadEvidence (b.jg5 SRJ-611)', () => {
    const gate = constOf('createPersonaRelaunchGate')
    const binding = onlyCallProps('initRestart').get('launchSession')!
    expect(binding).toContain('launchSession(')
    const args = onlyCallArgs('launchSession')
    expect(args).toHaveLength(3)
    // The live applied set a confirmed reload swaps, never the start-time config.
    expect(args[1]).toBe(loadedConfigName(SERVER_CODE))
    const options = objectProperties(args[2]!)
    expect(options.get('canLaunch')).toBe(gate)
    // The binding's fourth parameter, `RestartDeps.launchSession`'s verdict,
    // is what it passes on, unchanged: the relaunch after an escalate-dead
    // answer carries that verdict into the ladder.
    const params = splitTopLevel(binding.slice(...balancedAfter(binding, 0, '(', ')')))
    expect(params).toHaveLength(4)
    expect(params[0]).toBe(args[0])
    expect(options.get('deadEvidence')).toBe(params[3])
    expect([...options.keys()].sort()).toEqual(['canLaunch', 'deadEvidence'])
  })

  // Bug b.g57: the adapter's persona lookup is optional; without it a restart
  // of a persona whose claude_config_dir no longer resolves would kill its
  // instance ahead of a launch that cannot be made.
  test('bug b.g57, b.jg5 SRJ-702: the restart module\'s kill is the kill adapter over the live applied persona lookup, getAppliedPersona, and the production kill-retry clock', () => {
    expect(onlyCallProps('initRestart').get('killSession')).toBe(`_buildKillSessionAdapter(getAppliedPersona, ${KILL_RETRY_PRODUCTION_CLOCK})`)
    // The only adapter built (its declaration aside): no other kill path without the lookup.
    expect(indicesOf(/(?<![\w.$]|function\s+)_buildKillSessionAdapter\s*\(/g, SERVER_CODE)).toHaveLength(1)
    // getAppliedPersona reads the holder at call time (pinned in tests/reload-wiring.test.ts).
    expect(indicesOf(/\bfunction\s+getAppliedPersona\s*\(/g, SERVER_CODE)).toHaveLength(1)
  })

  // b.jg5 SRJ-702: the clock the adapter's kill retry waits on is the
  // production one, imported from src/kill-retry.ts: no copy or test clock
  // declared in server.ts.
  test('b.jg5 SRJ-702: the production kill-retry clock is the one src/kill-retry.ts exports, imported, never declared in server.ts', () => {
    expect(importSource(SERVER_CODE, KILL_RETRY_PRODUCTION_CLOCK)).toBe('./kill-retry.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${KILL_RETRY_PRODUCTION_CLOCK}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  // b.jg5 SRJ-702, SRJ-305: main() installs the persona kill retry's
  // keep-going query once, over the server's up predicate and its
  // shutting-down flag, before anything can kill (the start sweep, the
  // restart module, the start bring-up).
  test('b.jg5 SRJ-702: the kill retry\'s keep-going query is installed once in main(), over isPersonaUp and the shutting-down flag, before the start sweep and the restart module', () => {
    const at = onlyCallOf('setPersonaKillKeepGoingQuery')
    expect(insideMain(at)).toBe(true)
    const props = onlyCallProps('setPersonaKillKeepGoingQuery')
    expect([...props.keys()].sort()).toEqual(['isPersonaUp', 'isShuttingDown'])
    expect(props.get('isPersonaUp')).toBe(constOf('createPersonaUpPredicate'))
    expect(props.get('isShuttingDown')).toBe('() => shuttingDown')
    expect(importSource(SERVER_CODE, 'setPersonaKillKeepGoingQuery')).toBe('./session-manager.ts')
    expect(at).toBeLessThan(onlyCallOf('reconcileOrphans'))
    expect(at).toBeLessThan(onlyCallOf('initRestart'))
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
  })

  test('the health check\'s work list is built over the loaded config with the gate', () => {
    expect(onlyCallProps('initHealthCheck').get('getPersonas')).toContain('buildPersonaWorkList(')
    expect(onlyCallArgs('buildPersonaWorkList')).toEqual([loadedConfigName(SERVER_CODE), constOf('createPersonaRelaunchGate')])
  })

  test('getRestartDelay reads session_restart_delay from the config main() loaded', () => {
    const { loaded, assignAt, createAt } = startResolution(SERVER_CODE)
    const delay = onlyCallProps('initRestart').get('getRestartDelay')?.match(/^\(\) => (\w+)\.session_restart_delay$/)
    expect(delay).not.toBeNull()
    // The start-time config: declared once, inside main(), before the reload
    // controller (whose onApplied also reads it), and assigned exactly once,
    // from the loaded config, after the start resolution set it.
    const startTime = delay![1]!
    const decls = [...SERVER_CODE.matchAll(new RegExp(`\\b(?:let|const|var)\\s+${startTime}\\b[^\\n]*`, 'g'))]
    expect(decls.map((d) => d[0].trim())).toEqual([`let ${startTime}!: PersonaConfig`])
    expect(insideMain(decls[0]!.index!)).toBe(true)
    expect(decls[0]!.index!).toBeLessThan(createAt)
    const assignments = assignmentsTo(startTime)
    expect(assignments.map((a) => a.value)).toEqual([loaded])
    expect(insideMain(assignments[0]!.at)).toBe(true)
    expect(assignments[0]!.at).toBeGreaterThan(assignAt)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the UNAVAILABLE retry timers (b.jg5 SRJ-301, SRJ-305)
//
// A trigger reaches a persona's retry timer only through the controller
// main() installs as the outage state's trigger sink, so the install must
// come before the start bring-up's launches (the first attempts that can arm
// one); shutdown stops every timer. What the controller does (the waits, the
// stop rules, close refusing later arms) is driven on a fake clock in
// tests/unavailable-retry.test.ts; the teardown's stop is pinned in
// tests/reload-wiring.test.ts. Pinned here: placement, and which production
// function backs each of the full-mode retry action's stop and in-flight
// reads, and what the restart module's arm hook arms.
// ---------------------------------------------------------------------------

describe('main() installs one UNAVAILABLE retry controller as the trigger sink before the start bring-up, and shutdown stops every retry timer (b.jg5 SRJ-301, SRJ-305)', () => {
  test('the controller is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), on the production clock, and handed to the module-scope handle shutdown reads', () => {
    const at = onlyCallOf('createUnavailableRetryController')
    const controller = constOf('createUnavailableRetryController')
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${controller}\\s*=\\s*createUnavailableRetryController\\s*\\(`))
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, 'createUnavailableRetryController')).toBe('./unavailable-retry.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+createUnavailableRetryController\b/g, SERVER_CODE)).toEqual([])

    // The production clock: none given (the controller's default is the
    // system clock), or the system clock by name.
    const clock = onlyCallProps('createUnavailableRetryController').get('clock')
    expect([undefined, 'SYSTEM_PERSONA_CONNECTION_CLOCK']).toContain(clock)
    if (clock !== undefined) expect(importSource(SERVER_CODE, clock)).toBe('./persona-connections.ts')

    // The one handle shutdown reads: a module-scope `let`, assigned only
    // this controller, once, in main()'s own statement list after it is built.
    const handles = [...SERVER_CODE.matchAll(/^let\s+(\w+)\s*:\s*UnavailableRetryController\s*\|\s*undefined\s*$/gm)]
    expect(handles).toHaveLength(1)
    const handle = handles[0]![1]!
    expect(insideMain(handles[0]!.index!)).toBe(false)
    const assigned = assignmentsTo(handle)
    expect(assigned.map((a) => a.value)).toEqual([controller])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    expect(assigned[0]!.at).toBeGreaterThan(at)
  })

  test('it is the trigger sink of the one initOutageState call, in main()\'s own statement list, after the controller is built and before the start bring-up and the restart module', () => {
    const controller = constOf('createUnavailableRetryController')
    const install = onlyCallOf('initOutageState')
    expect(onlyCallProps('initOutageState').get('triggerSink')).toBe(controller)
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
    expect(install).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    expect(install).toBeLessThan(onlyCallOf('initRestart'))
    // Nothing else names a trigger sink in server.ts.
    expect(indicesOf(/\btriggerSink\b/g, SERVER_CODE)).toHaveLength(1)
  })

  test('shutdown stops every retry timer exactly once, with the shutdown reason: after the shutting-down flag is raised, right after cancelAllRestartTimers, and before the HTTP server stops', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (at: number) => at > start && at < end
    const handle = SERVER_CODE.match(/^let\s+(\w+)\s*:\s*UnavailableRetryController\s*\|\s*undefined\s*$/m)![1]!

    const closes = indicesOf(new RegExp(`\\b${handle}\\s*\\?\\.\\s*close\\s*\\(\\s*UNAVAILABLE_RETRY_STOP_SHUTDOWN\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    const at = closes[0]!
    expect(inShutdown(at)).toBe(true)
    expect(importSource(SERVER_CODE, 'UNAVAILABLE_RETRY_STOP_SHUTDOWN')).toBe('./unavailable-retry.ts')
    // No other stop of every timer anywhere in server.ts.
    expect(indicesOf(new RegExp(`\\b${handle}\\s*[?!]?\\.\\s*(?:close|stopAll)\\s*\\(`, 'g'), SERVER_CODE)).toEqual([at])
    const controller = constOf('createUnavailableRetryController')
    expect(indicesOf(new RegExp(`\\b${controller}\\s*[?!]?\\.\\s*(?:close|stopAll)\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])

    // After the flag is raised (so no launch that meets UNAVAILABLE after it
    // is mistaken for live work), beside the restart timers' cancel.
    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(raises).toHaveLength(1)
    expect(inShutdown(raises[0]!)).toBe(true)
    expect(at).toBeGreaterThan(raises[0]!)
    const cancels = indicesOf(/(?<![\w.$])cancelAllRestartTimers\s*\(\s*\)/g, SERVER_CODE).filter(inShutdown)
    expect(cancels).toHaveLength(1)
    expect(SERVER_CODE.slice(balancedAfter(SERVER_CODE, cancels[0]!, '(', ')')[1] + 1, at).replace(/[\s;]/g, '')).toBe('')

    // Before the HTTP server stops, and before shutdown first yields.
    const httpStops = indicesOf(/\bhttpServer\s*\.\s*stop\s*\(/g, SERVER_CODE).filter(inShutdown)
    expect(httpStops).toHaveLength(1)
    expect(at).toBeLessThan(httpStops[0]!)
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
  })

  // A stub for any of these dependencies type-checks, so only this audit
  // makes sure production binds the real one: a stub in-flight or cap read
  // would still launch over an in-flight launch or past the cap. Only these
  // members are pinned, not the full key set.
  test('the controller\'s action is the full-mode retry action over the restart module\'s retry entry, the live applied persona lookup, the relaunch gate, the restart cap, the restart module\'s shutdown flag, "blocks a retry" (the session manager\'s personaRetryBlockCause answering a cause, never a running dialog approver) with that cause query, and its row read (readPersonaRowState)', () => {
    expect(onlyCallProps('createUnavailableRetryController').get('action')!.startsWith('createFullModeRetryAction(')).toBe(true)
    expect(importSource(SERVER_CODE, 'createFullModeRetryAction')).toBe('./unavailable-retry.ts')
    const props = onlyCallProps('createFullModeRetryAction')

    expect(props.get('retry')).toBe('runRestartRetry')
    expect(importSource(SERVER_CODE, 'runRestartRetry')).toBe('./restart.ts')

    // getAppliedPersona reads the holder at call time (pinned in tests/reload-wiring.test.ts).
    expect(props.get('appliedPersona')).toBe('getAppliedPersona')

    const gate = constOf('createPersonaRelaunchGate')
    // The gate itself, or a call-time wrapper around it (the gate is declared
    // after the controller is built).
    const canRelaunch = props.get('canRelaunch')!
    expect(canRelaunch === gate || new RegExp(`^\\(?(\\w+)\\)? => ${gate}\\(\\1\\)$`).test(canRelaunch)).toBe(true)

    expect(props.get('isAtCap')).toMatch(/^\(?(\w+)\)? => backoffIsAtCap\(\1, RESTART_FAILURE_CAP\)$/)
    expect(importSource(SERVER_CODE, 'backoffIsAtCap')).toBe('./backoff.ts')
    expect(importSource(SERVER_CODE, 'RESTART_FAILURE_CAP')).toBe('./restart.ts')

    expect(props.get('isShuttingDown')).toBeDefined()
    expect(props.get('isShuttingDown')).toBe(onlyCallProps('initRestart').get('isShuttingDown')!)

    // b.jg5 SRJ-303, SRJ-706, SRJ-811: "blocks a retry", a launch call, a
    // running live-row sequence or an old-life wait step, so a running dialog
    // approver alone never skips a retry (SRJ-401), and its cause query for
    // the again-reason (see inFlightBindings).
    expect(props.get(RETRY_IN_FLIGHT_MEMBER)).toBe(inFlightBindings().retryBlocked)
    expect(props.get(RETRY_BLOCK_CAUSE_MEMBER)).toBe(RETRY_BLOCK_CAUSE)

    // b.jg5 SRJ-303, SRJ-115: a pending-only retry's row read is the session
    // manager's, one `status` call through the outage wrapper.
    expect(props.get('readRow')).toBe('readPersonaRowState')
    expect(importSource(SERVER_CODE, 'readPersonaRowState')).toBe('./session-manager.ts')
  })

  // b.jg5 SRJ-314: the restart module's arm hook is optional (absent, nothing
  // is armed), so a production wiring that dropped it, or bound it to a stub
  // or another controller, would type-check and pass every behaviour suite
  // while an `unknown` liveness reading armed no retry. What the hook's call
  // does is tested in tests/restart.test.ts; pinned here: its binding.
  test('the restart module\'s arm hook (armRetryTimer) arms this controller for the persona it is given, with the read-error cause (b.jg5 SRJ-314, SRJ-301)', () => {
    const controller = constOf('createUnavailableRetryController')
    const hook = onlyCallProps('initRestart').get('armRetryTimer')
    expect(hook).toBeDefined()
    // `(key) => { <controller>.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR }) }`,
    // or the same call as an expression body; the parameter's name is free.
    const arm = `${controller}\\.arm\\(\\1, \\{ kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR \\}\\)`
    expect(hook).toMatch(new RegExp(`^\\(?(\\w+)\\)? => (?:\\{ ${arm};? \\}|${arm})$`))
    expect(importSource(SERVER_CODE, 'UNAVAILABLE_RETRY_CAUSE_READ_ERROR')).toBe('./unavailable-retry.ts')
    // The controller is built before the restart module is initialised.
    expect(onlyCallOf('createUnavailableRetryController')).toBeLessThan(onlyCallOf('initRestart'))
  })

  // b.jg5 SRJ-311: the health check's retry-timer read and arm are optional
  // (absent, the tick arms nothing), so a production wiring that dropped
  // either, bound the read to a constant or another controller, or armed with
  // a no-op or another cause would type-check and pass every behaviour suite
  // while a persona whose retry stopped with its tmux-unavailable outage still
  // raised was never attempted again. What the tick does with them is tested
  // in tests/health-check.test.ts; pinned here: their bindings. The arm is
  // server.ts's one ENVIRONMENT arm path (armEnvironmentRetryTimer), which the
  // tmux-unavailable retry check's production deps also bind (b.jg5 SRJ-311).
  test('the health check\'s retry-timer read (isRetryArmed) is this controller\'s isArmed, and its arm (armRetryTimer) is server.ts\'s one ENVIRONMENT arm path, armEnvironmentRetryTimer, which arms this controller, through its one module-scope handle, for the persona it is given, with the environment cause (b.jg5 SRJ-311, SRJ-301)', () => {
    // Tied to src by type: renaming any of these fails the typecheck.
    const TICK_READ: keyof HealthCheckDeps = 'isRetryArmed'
    const TICK_ARM: keyof HealthCheckDeps = 'armRetryTimer'
    const IS_ARMED: keyof UnavailableRetryController = 'isArmed'
    const ARM: keyof UnavailableRetryController = 'arm'
    const CAUSE: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT'

    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    const props = onlyCallProps('initHealthCheck')

    // `(key) => <controller>.isArmed(key)`; the parameter's name is free.
    const read = props.get(TICK_READ)
    expect(read).toBeDefined()
    expect(read).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${controller}\\.${IS_ARMED}\\(\\1\\)$`))

    // The arm is server.ts's one ENVIRONMENT arm path, a module-scope
    // function (not imported) whose whole body arms, with the ENVIRONMENT
    // cause, the persona it is given, on the retry controller's one
    // module-scope handle, read at call time; that handle is assigned exactly
    // once, in main(), this controller (so nothing is armed before it exists,
    // and never on a second controller).
    const hook = props.get(TICK_ARM)
    expect(hook).toBe(ENVIRONMENT_ARM)
    expect(importSource(SERVER_CODE, ENVIRONMENT_ARM)).toBeUndefined()
    const { params, body } = moduleFunction(ENVIRONMENT_ARM)
    expect(params).toHaveLength(1)
    const handle = retryHandle()
    expect(body.replace(/\s+/g, ' ').trim()).toMatch(
      new RegExp(`^${handle}\\?\\.${ARM}\\(${params[0]}, \\{ kind: ${CAUSE} \\}\\);?$`),
    )
    const assigned = assignmentsTo(handle)
    expect(assigned.map((a) => a.value)).toEqual([controller])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    // The one arm path: the ENVIRONMENT cause is named only by its import and
    // this function; server.ts's only other arm is the restart module's
    // read-error hook (pinned above); and the function is named only at its
    // declaration, the tick's binding and the tmux-unavailable retry check's
    // production deps' `armRetryTimer` (b.jg5 SRJ-311, which the
    // session-disconnect handler and the routing's arm decide through).
    expect(indicesOf(new RegExp(`\\b${CAUSE}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    const arms = indicesOf(new RegExp(`\\.\\s*${ARM}\\s*\\(`, 'g'), SERVER_CODE)
    expect(arms).toHaveLength(2)
    expect(withinCall(arms, onlyCallOf('initRestart'))).toBe(1)
    expect(indicesOf(new RegExp(`\\b${ENVIRONMENT_ARM}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
    const CHECK_ARM: keyof TmuxUnavailableRetryDeps = 'armRetryTimer'
    expect(retryCheckDeps().props.get(CHECK_ARM)).toBe(ENVIRONMENT_ARM)
    // The retry module's own cause: imported, never declared or shadowed here.
    expect(importSource(SERVER_CODE, CAUSE)).toBe('./unavailable-retry.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${CAUSE}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // The controller is built before the health check is initialised.
    expect(onlyCallOf('createUnavailableRetryController')).toBeLessThan(onlyCallOf('initHealthCheck'))
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-404 — shutdown stops every dialog approver
//
// The approver runs on its own after its launch returned (b.jg5 SRJ-401), so
// nothing that shutdown already stops ends it: a wiring that dropped the
// stop-all, ran it after the agent-director client is closed, or ran it only
// after shutdown's awaits would type-check and pass every behaviour suite
// while an approver kept reading panes and typing Enter on a row during
// shutdown. What the stop-all does (every approver marked and woken, none
// starts after it) is tested in tests/session-manager.test.ts and through the
// recovery harness; pinned here: where shutdown calls it.
// ---------------------------------------------------------------------------

describe('shutdown stops every dialog approver exactly once, through the session manager\'s stop-all, after the shutting-down flag and the keep-alive stop and before the agent-director client is closed (b.jg5 SRJ-404)', () => {
  // Tied to src by type: renaming it fails the typecheck.
  const STOP_ALL: keyof typeof SessionManagerModule = 'stopAllDialogApprovers'

  test('the stop-all is the session manager\'s import, declared nowhere in server.ts, and called exactly once in server.ts, in shutdown(), with no argument', () => {
    expect(importSource(SERVER_CODE, STOP_ALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${STOP_ALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    // Its import and the one call are its only mentions: no alias, no second stop-all.
    expect(indicesOf(new RegExp(`\\b${STOP_ALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    const at = onlyCallOf(STOP_ALL)
    const [start, end] = shutdownBody(SERVER_CODE)
    expect(at > start && at < end).toBe(true)
    expect(onlyCallArguments(SERVER_CODE, STOP_ALL).trim()).toBe('')
  })

  test('in shutdown(), it comes after the shutting-down flag is raised and after stopAllKeepAliveTimers(), before shutdown first yields and before closeClient()', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (offset: number) => offset > start && offset < end
    const at = onlyCallOf(STOP_ALL)

    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(raises).toHaveLength(1)
    expect(inShutdown(raises[0]!)).toBe(true)
    expect(at).toBeGreaterThan(raises[0]!)

    const keepAlives = indicesOf(/(?<![\w.$])stopAllKeepAliveTimers\s*\(\s*\)/g, SERVER_CODE).filter(inShutdown)
    expect(keepAlives).toHaveLength(1)
    expect(at).toBeGreaterThan(keepAlives[0]!)

    // Before shutdown first yields: every approver is marked and woken before
    // the transports and connections are awaited, so none types meanwhile.
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)

    const closes = indicesOf(/(?<![\w.$])closeClient\s*\(/g, SERVER_CODE).filter(inShutdown)
    expect(closes).toHaveLength(1)
    expect(at).toBeLessThan(closes[0]!)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-706, SRJ-303 — the one live-row sequence registry
//
// The session manager answers "not installed" and false with no registry
// installed, and the restart work's running query is optional (absent, no
// sequence runs), so a wiring that dropped the install, built a second
// registry, installed it after the start pass, dropped the restart query or
// the shutdown close, or closed it after the client is released would
// type-check and pass every behaviour suite while a launch path raced a
// running sequence, a restart ran over it, or a sequence made calls during
// shutdown. What the registry, the gates and the stops do is tested in
// tests/live-row-sequence.test.ts, tests/session-manager.test.ts,
// tests/restart.test.ts and through the recovery and reload harnesses;
// "blocks a retry" is pinned in inFlightBindings, the routing's
// sequence/wait member in the routing describe and the teardown's stop in
// tests/reload-wiring.test.ts; pinned here: the build, the install, the
// restart query and the shutdown close.
// ---------------------------------------------------------------------------

describe('main() builds the one live-row sequence registry and installs it before the start pass, the restart work asks its running query, and shutdown closes it once before the client is released (b.jg5 SRJ-706, SRJ-303)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof LiveRowSequenceModule = 'createLiveRowSequenceRegistry'
  const BUILDER: keyof typeof SessionManagerModule = 'buildLiveRowSequenceDeps'
  const INSTALL: keyof typeof SessionManagerModule = 'setLiveRowSequenceRegistry'
  const ATTEMPT: keyof typeof UnavailableRetryModule = 'runDetachedRecoveryAttempt'
  const CLOSE: keyof LiveRowSequenceRegistry = 'close'
  const RESTART_QUERY: keyof RestartDeps = 'isLiveRowSequenceRunning'
  const DEPS: keyof LiveRowSequenceRegistryOptions = 'deps'
  const RUN_ATTEMPT: keyof LiveRowSequenceRegistryOptions = 'runAttempt'
  const RUN_OUTSIDE_ATTEMPT: keyof LiveRowSequenceRegistryOptions = 'runOutsideAttempt'
  const OUTSIDE_ATTEMPTS: keyof typeof UnavailableRetryModule = 'runOutsideAttempts'
  const RESTART_GATE: keyof typeof SessionManagerModule = 'liveRowSequenceGate'

  /** The module-scope holder shutdown() closes: `let <name>: LiveRowSequenceRegistry | undefined`. */
  function holder(): string {
    const match = SERVER_CODE.match(/^let\s+(\w+)\s*:\s*LiveRowSequenceRegistry\s*\|\s*undefined\s*$/m)
    expect(match).not.toBeNull()
    return match![1]!
  }

  test('the registry is built exactly once, in main()\'s own statement list, from the sequence module, over the session manager\'s one dependency builder (the retry controller\'s arm, the system clock, the server log and the applied configuration read at call time), production\'s detached attempt runner and its outside-every-attempt runner (b.jg5 SRJ-811, SRJ-1512)', () => {
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./live-row-sequence.ts')
    expect(importSource(SERVER_CODE, BUILDER)).toBe('./session-manager.ts')
    expect(importSource(SERVER_CODE, ATTEMPT)).toBe('./unavailable-retry.ts')
    expect(importSource(SERVER_CODE, OUTSIDE_ATTEMPTS)).toBe('./unavailable-retry.ts')
    for (const name of [FACTORY, BUILDER, ATTEMPT, OUTSIDE_ATTEMPTS, INSTALL]) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    const registry = constOf(FACTORY)
    declaredOnce(registry)
    expect(atMainTopLevel(SERVER_CODE, SERVER_CODE.search(new RegExp(`\\bconst\\s+${registry}\\s*=\\s*${FACTORY}\\s*\\(`)))).toBe(true)
    const props = onlyCallProps(FACTORY)
    expect([...props.keys()].sort()).toEqual([DEPS, RUN_ATTEMPT, RUN_OUTSIDE_ATTEMPT].sort())
    expect(props.get(RUN_ATTEMPT)).toBe(ATTEMPT)
    // An old-life wait runs outside every recovery attempt: the unavailable
    // retry module's runner, bare or as a pass-through arrow.
    const outside = props.get(RUN_OUTSIDE_ATTEMPT)!
    expect(outside === OUTSIDE_ATTEMPTS || new RegExp(`^\\(?(\\w+)\\)? => ${OUTSIDE_ATTEMPTS}\\(\\1\\)$`).test(outside)).toBe(true)
    // Named in server.ts only at its import and this member.
    expect(indicesOf(new RegExp(`\\b${OUTSIDE_ATTEMPTS}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    expect(props.get(DEPS)!.startsWith(`${BUILDER}(`)).toBe(true)
    const deps = onlyCallProps(BUILDER)
    // The kill-failure alerts are the builder's default, the installed instance.
    expect([...deps.keys()].sort()).toEqual(['appliedConfig', 'clock', 'log', 'retryArm'])
    expect(deps.get('retryArm')).toBe(constOf('createUnavailableRetryController'))
    expect(deps.get('clock')).toBe('SYSTEM_PERSONA_CONNECTION_CLOCK')
    expect(importSource(SERVER_CODE, 'SYSTEM_PERSONA_CONNECTION_CLOCK')).toBe('./persona-connections.ts')
    expect(deps.get('log')).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    expect(deps.get('appliedConfig')).toBe(`() => ${loadedConfigName(SERVER_CODE)}`)
    // Built after the retry controller whose arm it takes.
    expect(onlyCallOf(FACTORY)).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
  })

  test('it is installed in the session manager exactly once, with that registry, in main()\'s own statement list, after the latch\'s install and before the restart module, the start bring-up and the health check; the shutdown holder is assigned it once there', () => {
    const registry = constOf(FACTORY)
    const at = onlyCallOf(INSTALL)
    expect(onlyCallArguments(SERVER_CODE, INSTALL).trim()).toBe(registry)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf('setConflictLatch'))
    expect(at).toBeGreaterThan(onlyCallOf(FACTORY))
    for (const later of [onlyCallOf('initRestart'), startResolution(SERVER_CODE).bringUpAt, onlyCallOf('initHealthCheck')]) expect(at).toBeLessThan(later)
    // Named in server.ts only at its import and this call.
    expect(indicesOf(new RegExp(`\\b${INSTALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    const assigned = assignmentsTo(holder())
    expect(assigned.map((a) => a.value)).toEqual([registry])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
  })

  // b.jg5 SRJ-811: the bare running query would refuse a restart over an
  // old-life wait on the persona's own row without arming its retry timer,
  // so nothing would retry it once the wait is over.
  test('the restart work\'s running query is the session manager\'s gate (liveRowSequenceGate) for the key it is given and a site of its own, which also arms a persona whose own row carries an old-life wait; server.ts asks the bare running query nowhere', () => {
    const query = onlyCallProps('initRestart').get(RESTART_QUERY)
    expect(query).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${RESTART_GATE}\\(\\1, '[^']+'\\)$`))
    expect(importSource(SERVER_CODE, RESTART_GATE)).toBe('./session-manager.ts')
    // The gate: named only at its import and this member.
    const gates = indicesOf(new RegExp(`\\b${RESTART_GATE}\\b`, 'g'), SERVER_CODE)
    expect(gates).toHaveLength(2)
    expect(withinCall(gates, onlyCallOf('initRestart'))).toBe(1)
    // The bare query is neither imported nor called: its name appears only as
    // the restart deps' member.
    expect(importSource(SERVER_CODE, SEQUENCE_RUNNING)).toBeUndefined()
    expect(callsOf(SEQUENCE_RUNNING)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${SEQUENCE_RUNNING}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
  })

  test('shutdown() closes the registry exactly once, through its holder, after the shutting-down flag, before the retry controller closes, before it first yields and before closeClient(); nothing else closes or stops every sequence', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (offset: number) => offset > start && offset < end
    const name = holder()
    const closes = indicesOf(new RegExp(`(?<![\\w.$])${name}\\s*\\?\\.\\s*${CLOSE}\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    const at = closes[0]!
    expect(inShutdown(at)).toBe(true)
    // The holder is named only at its declaration, its assignment and this close.
    expect(indicesOf(new RegExp(`(?<![\\w.$])${name}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
    // No stop-all of the sequences anywhere in server.ts.
    expect(indicesOf(/\.\s*stopAll\s*\(\s*LIVE_ROW_STOP/g, SERVER_CODE)).toEqual([])

    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(at).toBeGreaterThan(raises[0]!)
    const retryCloses = indicesOf(new RegExp(`(?<![\\w.$])${retryHandle()}\\s*\\?\\.\\s*close\\s*\\(`, 'g'), SERVER_CODE).filter(inShutdown)
    expect(retryCloses).toHaveLength(1)
    expect(at).toBeLessThan(retryCloses[0]!)
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(at).toBeLessThan(start + firstAwait)
    const clientCloses = indicesOf(/(?<![\w.$])closeClient\s*\(/g, SERVER_CODE).filter(inShutdown)
    expect(clientCloses).toHaveLength(1)
    expect(at).toBeLessThan(clientCloses[0]!)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-811 / SRJ-812 / SRJ-1512 — the old-life wait's
// bindings
//
// The bindings' alert sinks are optional (absent, the session manager falls
// back to its installed kill-failure alerts and `recordStartupError`), and
// absent bindings start no wait at all, so a production wiring that dropped
// the install, installed it after the start pass, or bound a second retry
// controller, alerts or episodes instance would type-check and pass every
// behaviour suite while no old life was killed, a waiting persona's timer
// was armed on a controller nothing closes, or the wait's kill-failure entry
// bypassed the one episodes instance a teardown forgets. What the wait does
// is tested in tests/old-life-wait.test.ts and through the recovery harness;
// pinned here: the install and its members.
// ---------------------------------------------------------------------------

describe('main() installs the old-life wait\'s bindings once, beside the live-row sequence registry and before the start pass, over the one retry controller, the system clock, the server log, the applied configuration, the one kill-failure alerts instance and recordStartupError (b.jg5 SRJ-811, SRJ-812, SRJ-1512)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const INSTALL: keyof typeof SessionManagerModule = 'setOldLifeWaitBindings'
  const REGISTRY_INSTALL: keyof typeof SessionManagerModule = 'setLiveRowSequenceRegistry'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const RETRY_ARM: keyof OldLifeWaitBindings = 'retryArm'
  const CLOCK: keyof OldLifeWaitBindings = 'clock'
  const LOG: keyof OldLifeWaitBindings = 'log'
  const APPLIED: keyof OldLifeWaitBindings = 'appliedConfig'
  const ALERTS: keyof OldLifeWaitBindings = 'killFailureAlerts'
  const RECORD: keyof OldLifeWaitBindings = 'recordStartupError'
  const EPISODES: keyof OldLifeWaitBindings = 'unclassifiedErrorEpisodes'
  const EPISODES_FACTORY: keyof typeof SessionManagerModule = 'createOldLifeWaitUnclassifiedErrors'

  test('installed exactly once, in main()\'s own statement list, the session manager\'s import, after the registry\'s install and before the restart module, the start sweep, the start bring-up and the health check', () => {
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf(REGISTRY_INSTALL))
    for (const later of [onlyCallOf('initRestart'), onlyCallOf(START_SWEEP), startResolution(SERVER_CODE).bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }
    // Named in server.ts only at its import and this call.
    expect(indicesOf(new RegExp(`\\b${INSTALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
  })

  test('its members are exactly the one retry controller, the system clock, the server log, the applied configuration read at call time, the one kill-failure alerts instance, one recordStartupError call with the class and entry it is given, and the wait\'s one unclassified-error episodes instance', () => {
    const props = onlyCallProps(INSTALL)
    expect([...props.keys()].sort()).toEqual([RETRY_ARM, CLOCK, LOG, APPLIED, ALERTS, RECORD, EPISODES].sort())
    // b.jg5 SRJ-313: the wait's own episodes instance, built before the install, never a persona's.
    expect(props.get(EPISODES)).toBe(constOf(EPISODES_FACTORY))
    expect(onlyCallOf(INSTALL)).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))
    // Each waiting persona's timer is armed on the one controller shutdown closes.
    expect(props.get(RETRY_ARM)).toBe(constOf('createUnavailableRetryController'))
    expect(props.get(CLOCK)).toBe('SYSTEM_PERSONA_CONNECTION_CLOCK')
    expect(props.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    expect(props.get(APPLIED)).toBe(`() => ${loadedConfigName(SERVER_CODE)}`)
    // The one alerts instance, over the one notice episodes (pinned in the
    // kill-failure alerts' describe), never a second one.
    expect(props.get(ALERTS)).toBe(constOf('createKillFailureAlerts'))
    expect(onlyCallOf(INSTALL)).toBeGreaterThan(onlyCallOf('createKillFailureAlerts'))
    const call = 'recordStartupError\\(\\1, \\2\\)'
    expect(props.get(RECORD)).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
  })

  test('the wait\'s unclassified-error episodes are built exactly once, in main()\'s own statement list, from the session manager, on the system clock, with the server log, E6\'s alert threshold in effect and one recordStartupError call (b.jg5 SRJ-313, SRJ-811)', () => {
    expect(importSource(SERVER_CODE, EPISODES_FACTORY)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${EPISODES_FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(atMainTopLevel(SERVER_CODE, onlyCallOf(EPISODES_FACTORY))).toBe(true)
    const props = onlyCallProps(EPISODES_FACTORY)
    expect([...props.keys()].sort()).toEqual(['alertThresholdMs', 'log', 'recordStartupError'])
    expect(props.get('log')).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    expect(props.get('alertThresholdMs')).toBe('adAlertThresholdMsInEffect')
    const call = 'recordStartupError\\(\\1, \\2\\)'
    expect(props.get('recordStartupError')).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
  })

  test('shutdown() closes the wait\'s unclassified-error episodes exactly once, through the module-scope holder main() assigns them to once, after the shutting-down flag (b.jg5 SRJ-313, SRJ-811)', () => {
    const handles = [...SERVER_CODE.matchAll(/^let\s+(\w+)\s*:\s*OldLifeWaitUnclassifiedErrors\s*\|\s*undefined\s*$/gm)]
    expect(handles).toHaveLength(1)
    const handle = handles[0]![1]!
    const assigned = assignmentsTo(handle)
    expect(assigned.map((a) => a.value)).toEqual([constOf(EPISODES_FACTORY)])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    const [start, end] = shutdownBody(SERVER_CODE)
    const closes = indicesOf(new RegExp(`(?<![\\w.$])${handle}\\s*\\?\\.\\s*close\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    expect(closes[0]! > start && closes[0]! < end).toBe(true)
    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(closes[0]!).toBeGreaterThan(raises[0]!)
    // The holder is named only at its declaration, its assignment and this close.
    expect(indicesOf(new RegExp(`(?<![\\w.$])${handle}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-314 / SRJ-115 — the restart module's `pending`
// deferral is server.ts's one `deferPendingRow`
//
// `RestartDeps.deferPendingRow` is optional (absent, a `pending` liveness
// reading defers silently), so a production wiring that dropped it, bound it
// to a stub or dropped the reading's launch start would type-check and pass
// every behaviour suite while the deferral line lost the launch start or went
// unlogged. What the deferral does is tested in tests/restart.test.ts and
// tests/server.test.ts; pinned here: its binding.
// ---------------------------------------------------------------------------

describe('main() binds the restart module\'s pending deferral (deferPendingRow) to server.ts\'s one deferPendingRow, its answer returned to the restart work, with the reading\'s launch start (b.jg5 SRJ-314, SRJ-115, SRJ-409, SRJ-411, SRJ-410)', () => {
  // Tied to src by type: renaming the member or the reading's field fails the typecheck.
  const DEP: keyof RestartDeps = 'deferPendingRow'
  const LAUNCH_FIELD: keyof PendingLivenessReading = 'launchStartedAt'

  test('the hook returns the one module-scope async deferPendingRow\'s answer for its own key and the reading\'s launch start, and makes no lookup of its own (the deferral\'s default, the server\'s applied config, decides)', () => {
    const hook = onlyCallProps('initRestart').get(DEP)
    expect(hook).toBeDefined()
    // `async (key, reading) => deferPendingRow(key, reading.launchStartedAt)`,
    // or the call returned from a block body; the parameters' names are free.
    // b.jg5 SRJ-410: the restart work reads the deferral's answer (a row read
    // gone at a retry goes on to the relaunch in the same run), so a body that
    // only awaits the call, or drops it, would lose the gone answer.
    const call = `${DEP}\\(\\1, \\2\\.${LAUNCH_FIELD}\\)`
    expect(hook).toMatch(new RegExp(`^(?:async )?\\((\\w+), (\\w+)\\) => (?:\\{ return ${call};? \\}|${call})$`))
    // Not an import, and declared once, at module scope, as an async function.
    expect(importSource(SERVER_CODE, DEP)).toBeUndefined()
    expect(indicesOf(new RegExp(`\\b(?:function|const|let|var)\\s+${DEP}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
    expect(indicesOf(new RegExp(`^export async function ${DEP}\\(`, 'gm'), SERVER_CODE)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-409, SRJ-411 — the pending-only retry's pending-row
// step is the session manager's `retryPendingRowStep` over the applied config
//
// `FullModeRetryDeps.stepPendingRow` is optional (absent, a pending-only
// retry whose row reads `pending` is a refusal with no `get`), so a
// production wiring that dropped it, bound it to a stub or to a lookup other
// than the applied config would type-check and pass every behaviour suite
// while an uncovered row at the retry was never sent through the live-row
// sequence. What the step does is tested in tests/unavailable-retry.test.ts
// and tests/pending-row.test.ts; pinned here: its binding.
// ---------------------------------------------------------------------------

describe('main() passes the full-mode retry action the pending-row step, retryPendingRowStep over getAppliedPersona (b.jg5 SRJ-409, SRJ-411)', () => {
  // Tied to src by type: renaming the member or the step fails the typecheck.
  const DEP: keyof FullModeRetryDeps = 'stepPendingRow'
  const STEP: keyof typeof SessionManagerModule = 'retryPendingRowStep'

  test('the member calls the session manager\'s retryPendingRowStep with the key it is given and the live applied-persona lookup\'s persona for that key', () => {
    // `(key) => retryPendingRowStep(key, getAppliedPersona(key))`; the parameter's name is free.
    expect(onlyCallProps('createFullModeRetryAction').get(DEP)).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${STEP}\\(\\1, getAppliedPersona\\(\\1\\)\\)$`))
    expect(importSource(SERVER_CODE, STEP)).toBe('./session-manager.ts')
    // The one call of the step in server.ts is this binding's.
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createFullModeRetryAction'), '(', ')')
    const step = onlyCallOf(STEP)
    expect(step > open && step < close).toBe(true)
    declaredOnce('getAppliedPersona')
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-303, SRJ-305, SRJ-404 — one retry run gate for the
// retry action and the pending-row rule's approver-stop run
//
// `PendingRowRuleInstall.gate` is optional (absent, the approver-stop run is
// dropped only at shutdown), and the retry action takes any applied, latched,
// held, up, cap and shutdown reads. So a production wiring that dropped the
// install's gate, or gave the approver-stop run a second hand-made gate that
// drifts from the retry action's, would type-check and pass every behaviour
// suite while a run queued behind P's teardown made calls for a key outside
// the applied set. What the gate does is tested in tests/pending-row.test.ts
// and tests/session-manager.test.ts; each member's binding is pinned with the
// retry action's (above, and the latch's and the hold's describes); pinned
// here: one object, shared.
// ---------------------------------------------------------------------------

describe('main() builds one retry run gate, spreads it into the full-mode retry action and installs it as the pending-row rule\'s gate (b.jg5 SRJ-303, SRJ-305, SRJ-404)', () => {
  // Every member of the gate's type; a member added to it fails the typecheck here.
  const GATE_MEMBERS: Record<keyof RetryRunGateDeps, true> = {
    isShuttingDown: true,
    appliedPersona: true,
    isLatched: true,
    isHeld: true,
    canRelaunch: true,
    isAtCap: true,
  }
  const INSTALL: keyof typeof SessionManagerModule = 'setPendingRowRule'
  const GATE: keyof PendingRowRuleInstall = 'gate'

  test('declared once, in main()\'s own statement list, typed by the unavailable-retry module\'s gate type, before the retry controller and the rule\'s install; its members are exactly the gate type\'s', () => {
    const gate = retryRunGate()
    expect(atMainTopLevel(SERVER_CODE, gate.at)).toBe(true)
    expect(SERVER_CODE).toMatch(new RegExp(`\\bimport\\s*\\{[^}]*\\btype\\s+${RETRY_RUN_GATE_TYPE}\\b[^}]*\\}\\s*from\\s*'\\./unavailable-retry\\.ts'`))
    expect(gate.at).toBeLessThan(onlyCallOf('createUnavailableRetryController'))
    expect(gate.at).toBeLessThan(onlyCallOf(INSTALL))
    expect([...gate.props.keys()].sort()).toEqual(Object.keys(GATE_MEMBERS).sort())
  })

  test('named exactly three times: its declaration, one spread into the retry action\'s deps (none of whose own members overrides it) and the install\'s gate, bound by its bare name', () => {
    const { name, at, props } = retryRunGate()
    const named = indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(3)
    expect(named[0]).toBe(SERVER_CODE.indexOf(name, at))
    const actionParts = splitTopLevel(SERVER_CODE.slice(...balancedAfter(SERVER_CODE, onlyCallOf('createFullModeRetryAction'), '{', '}')))
    expect(actionParts.filter((part) => part.startsWith('...'))).toEqual([`...${name}`])
    expect(withinCall(named, onlyCallOf('createFullModeRetryAction'))).toBe(1)
    // An own member of the action named like a gate member would override the
    // spread; the merged read throws on that (objectProperties' duplicate).
    const action = onlyCallProps('createFullModeRetryAction')
    for (const member of Object.keys(GATE_MEMBERS)) expect([member, action.get(member)]).toEqual([member, props.get(member)])
    expect(onlyCallProps(INSTALL).get(GATE)).toBe(name)
    expect(withinCall(named, onlyCallOf(INSTALL))).toBe(1)
  })

  test('the merged read refuses a spread member overridden by an own member', () => {
    const spread = (): string => '{ isLatched: a }'
    expect(() => objectProperties('{ ...g, isLatched: b }', spread)).toThrow(/duplicate property isLatched/)
    expect([...objectProperties('{ ...g, retry: r }', spread)]).toEqual([
      ['isLatched', 'a'],
      ['retry', 'r'],
    ])
    expect(() => objectProperties('{ ...g }')).toThrow(/not a plain property/)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-410, SRJ-404 — main()'s one pending-row rule
//
// The session manager's install is optional (with none installed, a retry or
// an approver's stop that would run the rule logs one line and keeps the
// pending-only arm only), and its dependency builder takes any lookup,
// episodes and log. So a production wiring that dropped the install, built
// the rule over a hand-made deps object, gave its held post episodes other
// than the one notice episodes instance (whose posts the stuck-launch
// episode counts), ran the approver-stop run outside the persona's lifecycle
// serializer, or installed the rule after the start pass would type-check and
// pass every behaviour suite. The rule is reached from the retry action, the
// restart deferral and the approver's stop over this one instance. What it
// does is tested in tests/pending-row.test.ts and through the recovery
// harness, which composes it the same way; pinned here: the build and the
// install.
// ---------------------------------------------------------------------------

describe('main() builds the one pending-row rule through its factory over the session manager\'s dependency builder, and installs it with the persona lifecycle serializer after the live-row sequence registry and before the start pass (b.jg5 SRJ-410, SRJ-404)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PendingRowModule = 'createPendingRowRule'
  const BUILDER: keyof typeof SessionManagerModule = 'buildPendingRowRuleDeps'
  const INSTALL: keyof typeof SessionManagerModule = 'setPendingRowRule'
  const RESET: keyof typeof SessionManagerModule = '_resetPendingRowRule'
  const REGISTRY_INSTALL: keyof typeof SessionManagerModule = 'setLiveRowSequenceRegistry'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const RULE: keyof PendingRowRuleInstall = 'rule'
  const SERIALIZE: keyof PendingRowRuleInstall = 'serialize'
  const GATE: keyof PendingRowRuleInstall = 'gate'
  const APPLIED: keyof PendingRowRuleDepsInput = 'appliedPersona'
  const EPISODES: keyof PendingRowRuleDepsInput = 'episodes'
  const LOG: keyof PendingRowRuleDepsInput = 'log'

  test('installed exactly once, in main()\'s own statement list, the session manager\'s import, after the live-row sequence registry\'s install and before the restart module, the start sweep, the start bring-up and the health check; server.ts never removes it', () => {
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(at).toBeGreaterThan(onlyCallOf(REGISTRY_INSTALL))
    for (const later of [onlyCallOf('initRestart'), onlyCallOf(START_SWEEP), startResolution(SERVER_CODE).bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }
    // Named in server.ts only at its import and this call; the test-only reset never.
    expect(indicesOf(new RegExp(`\\b${INSTALL}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    expect(indicesOf(new RegExp(`\\b${RESET}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the install is exactly the rule, the pending-row module\'s factory called on the session manager\'s one dependency builder, the persona lifecycle serializer\'s run, the turn the approver-stop run takes, and the retry run\'s gate, the very object the retry action spreads (b.jg5 SRJ-404, SRJ-305)', () => {
    const props = onlyCallProps(INSTALL)
    expect([...props.keys()].sort()).toEqual([RULE, SERIALIZE, GATE].sort())
    expect(props.get(SERIALIZE)).toBe(`${constOf('createPersonaSerializer')}.run`)
    // The gate is bound by its bare name: the same object, never a copy.
    expect(props.get(GATE)).toBe(retryRunGate().name)
    const rule = props.get(RULE)!
    expect(rule.startsWith(`${FACTORY}(`)).toBe(true)
    const ruleArgs = splitTopLevel(onlyCallArguments(rule, FACTORY))
    expect(ruleArgs).toHaveLength(1)
    expect(ruleArgs[0]!.startsWith(`${BUILDER}(`)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./pending-row.ts')
    expect(importSource(SERVER_CODE, BUILDER)).toBe('./session-manager.ts')
    for (const name of [FACTORY, BUILDER]) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
      // Called once in server.ts, inside the install.
      expect([name, withinCall([onlyCallOf(name)], onlyCallOf(INSTALL))]).toEqual([name, 1])
    }
  })

  test('the rule\'s dependencies are exactly the live applied-persona lookup, the one notice episodes instance (its held post\'s), built before the install, and the server log', () => {
    const deps = onlyCallProps(BUILDER)
    expect([...deps.keys()].sort()).toEqual([APPLIED, EPISODES, LOG].sort())
    expect(deps.get(APPLIED)).toBe('getAppliedPersona')
    declaredOnce('getAppliedPersona')
    expect(deps.get(EPISODES)).toBe(constOf('createPersonaEpisodes'))
    expect(onlyCallOf(INSTALL)).toBeGreaterThan(onlyCallOf('createPersonaEpisodes'))
    expect(deps.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
  })

  test('no other file under src/ builds or installs a pending-row rule', () => {
    const callers = (name: string): string[] =>
      srcFiles()
        .filter(([, text]) => new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`).test(stripComments(text)))
        .map(([path]) => path)
    expect([FACTORY, INSTALL].map(callers)).toEqual([['src/server.ts'], ['src/server.ts']])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-1016 — the one set of per-persona notice episodes
//
// The episodes' clock is optional (absent, the system clock) and any sink
// type-checks, so a production wiring on a fake clock, with a sink that
// bypasses the persona notifier, built twice (two latches for one episode),
// behind a branch or after the start pass (a first launch's notice with no
// latch to reach) would pass every behaviour suite. What the episodes do is
// tested in tests/persona-episodes.test.ts and the teardown's forget in
// tests/persona-lifecycle.test.ts and tests/reload-wiring.test.ts; pinned
// here: the build, its dependencies (the sink and the teardown query, b.jg5
// SRJ-1003) and shutdown's close. A forget-all in its
// place would end every episode but leave a later begin open: a launch still
// in flight at shutdown could open an episode and arm an alert check after it.
// ---------------------------------------------------------------------------

describe('main() builds the one set of per-persona notice episodes before the start pass, on the production clock, with the persona notifier as its sink, and shutdown closes them (b.jg5 SRJ-1016, SRJ-309)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const SINK: keyof PersonaEpisodesDeps = 'sink'
  const CLOCK: keyof PersonaEpisodesDeps = 'clock'
  const FORGET_ALL: keyof PersonaEpisodes = 'forgetAll'
  const CLOSE: keyof PersonaEpisodes = 'close'
  const SYSTEM_CLOCK: keyof typeof PersonaConnectionsModule = 'SYSTEM_PERSONA_CONNECTION_CLOCK'
  const NOTIFIER_FACTORY: keyof typeof PersonaNotifierModule = 'createPersonaNotifier'
  const NOTIFY: keyof PersonaNotifier = 'notify'
  const TEARDOWN_WINDOW: keyof PersonaEpisodesDeps = 'teardownWindow'
  const WINDOW_STATE: keyof PersonaNotifier = 'teardownWindowState'

  /** The one module-scope `let <handle>: PersonaEpisodes | undefined` shutdown reads. */
  const HANDLE = /^let\s+(\w+)\s*:\s*PersonaEpisodes\s*\|\s*undefined\s*$/gm

  test('the instance is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), before the retry controller, initRestart, the start bring-up and initHealthCheck, and handed to the module-scope handle shutdown reads', () => {
    const at = onlyCallOf(FACTORY)
    const episodes = constOf(FACTORY)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${episodes}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Before every poster can reach it: the retry controller (whose retries
    // post), the restart module, the start bring-up (the first launches) and
    // the health check.
    const { bringUpAt } = startResolution(SERVER_CODE)
    for (const later of [onlyCallOf('createUnavailableRetryController'), onlyCallOf('initRestart'), bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }

    // The one handle shutdown reads: a module-scope `let`, assigned only this
    // instance, once, in main()'s own statement list, after it is built and
    // before the start bring-up.
    const handles = [...SERVER_CODE.matchAll(HANDLE)]
    expect(handles).toHaveLength(1)
    expect(insideMain(handles[0]!.index!)).toBe(false)
    const assigned = assignmentsTo(handles[0]![1]!)
    expect(assigned.map((a) => a.value)).toEqual([episodes])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    expect(assigned[0]!.at).toBeGreaterThan(at)
    expect(assigned[0]!.at).toBeLessThan(bringUpAt)
  })

  test('its clock is the production default and its sink is the module-scope persona notifier\'s notify', () => {
    const props = onlyCallProps(FACTORY)

    // The production clock: none given (the factory's default is the system
    // clock), or the system clock by name.
    const clock = props.get(CLOCK)
    expect<Array<string | undefined>>([undefined, SYSTEM_CLOCK]).toContain(clock)
    if (clock !== undefined) expect(importSource(SERVER_CODE, clock)).toBe('./persona-connections.ts')

    // The one persona notifier, the module-scope const the outage state and
    // the session manager's notices also go through; not a local of main().
    const notifier = constOf(NOTIFIER_FACTORY)
    expect(insideMain(onlyCallOf(NOTIFIER_FACTORY))).toBe(false)
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${notifier}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)

    // Exactly `(key, text, options) => { void <notifier>.notify(key, text, options) }`,
    // the parameters' names free: every argument passed through in order, so
    // the kill-failure survivor version's class reaches the notifier's
    // teardown window (b.jg5 SRJ-1003, SRJ-1013).
    expect(props.get(SINK)).toMatch(new RegExp(`^\\((\\w+), (\\w+), (\\w+)\\) => \\{ void ${notifier}\\.${NOTIFY}\\(\\1, \\2, \\3\\);? \\}$`))
  })

  // b.jg5 SRJ-1003: the teardown query is optional (absent, every key reads
  // `none`), so a production wiring with no query, a stand-in, or another
  // notifier's query would type-check while an old half's posts reached the
  // new half's destination between a teardown's submit and its turn, and the
  // episodes' log-only routes bypassed the window. What the query does is
  // tested in tests/persona-episodes.test.ts and the window in
  // tests/persona-notifier.test.ts.
  test('its teardown query is bound once, to the one module-scope persona notifier\'s teardownWindowState, the key passed through', () => {
    const notifier = constOf(NOTIFIER_FACTORY)
    expect(importSource(SERVER_CODE, NOTIFIER_FACTORY)).toBe('./persona-notifier.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${NOTIFIER_FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(callsOf(NOTIFIER_FACTORY)).toHaveLength(1)
    declaredOnce(notifier)

    // `(key) => <notifier>.teardownWindowState(key)` (an expression body: a
    // block with no return would answer undefined), or the method itself.
    expect(onlyCallProps(FACTORY).get(TEARDOWN_WINDOW)).toMatch(
      new RegExp(`^(?:${notifier}\\.${WINDOW_STATE}|\\(?(\\w+)\\)? => ${notifier}\\.${WINDOW_STATE}\\(\\1\\))$`),
    )
    // The notifier's query is read nowhere else in server.ts.
    expect(indicesOf(new RegExp(`\\b${WINDOW_STATE}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
  })

  test('shutdown closes the episodes exactly once, through the handle, before it first yields, and nothing forgets them all', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const handle = SERVER_CODE.match(new RegExp(HANDLE.source, 'm'))![1]!

    const closes = indicesOf(new RegExp(`\\b${handle}\\s*\\?\\.\\s*${CLOSE}\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(closes).toHaveLength(1)
    const at = closes[0]!
    expect(at > start && at < end).toBe(true)
    // No other close anywhere in server.ts, through the handle or the instance,
    // and no forget-all of the episodes (which would leave a later begin
    // open). The ErrInvalidFlags hold's own forget-all at shutdown is pinned
    // in the hold's describe.
    const episodes = constOf(FACTORY)
    expect(indicesOf(new RegExp(`\\b(?:${handle}|${episodes})\\s*[?!]?\\.\\s*${CLOSE}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([at])
    expect(indicesOf(new RegExp(`\\b(?:${handle}|${episodes})\\s*[?!]?\\.\\s*${FORGET_ALL}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])

    // Before shutdown first yields, so a stalled await never keeps an episode open.
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-307 / SRJ-310 / SRJ-306 — the tmux-unresponsive
// condition's production bindings
//
// Every hook that starts or ends the condition is optional with a no-op
// default (`OutageStateDeps.conditionSink`, `HealthCheckDeps.
// endTmuxUnresponsive`, `FullModeRetryDeps.endTmuxUnresponsive` and its two
// probes, `TmuxUnresponsiveConditionDeps.conditionEnded`), so a production
// wiring that dropped one, bound it to a no-op or a local shadow, built a
// second condition, or installed the sink after the start pass would
// type-check and pass every behaviour suite while a refusal started nothing,
// a healthy tick or retry ended nothing, or an end never reached the retry
// timer. What each hook does is tested in tests/tmux-unresponsive.test.ts,
// tests/outage-state.test.ts, tests/health-check.test.ts and
// tests/unavailable-retry.test.ts; pinned here: the bindings.
// ---------------------------------------------------------------------------

// Shared by this audit and the next. Tied to src by type: renaming either fails the typecheck.
/** The outage state's cleared-flag observer. */
const FLAG_CLEARED: keyof OutageStateDeps = 'onFlagCleared'
/** The class the retry's healthy-row hook clears and the observer reports. */
const TMUX_UNAVAILABLE_CLASS: OutageClass = 'tmux-unavailable'

describe('main() builds the one tmux-unresponsive condition over the notice episodes, installs it as the condition sink before the start pass, and binds the tick\'s and the retry\'s ends to it and its end to the retry controller (b.jg5 SRJ-307, SRJ-310, SRJ-306)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createTmuxUnresponsiveCondition'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const EPISODES: keyof TmuxUnresponsiveConditionDeps = 'episodes'
  const CONDITION_ENDED: keyof TmuxUnresponsiveConditionDeps = 'conditionEnded'
  const END: keyof TmuxUnresponsiveCondition = 'end'
  const END_TICK: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_TICK'
  const END_RETRY: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_RETRY'
  const CONDITION_SINK: keyof OutageStateDeps = 'conditionSink'
  const TRIGGER_SINK: keyof OutageStateDeps = 'triggerSink'
  const TICK_HOOK: keyof HealthCheckDeps = 'endTmuxUnresponsive'
  const RETRY_HOOK: keyof FullModeRetryDeps = 'endTmuxUnresponsive'
  const RETRY_CONNECTED: keyof FullModeRetryDeps = 'isSessionConnected'
  const RETRY_STREAM: keyof FullModeRetryDeps = 'hasSessionStream'
  const TICK_STREAM: keyof HealthCheckDeps = 'hasSessionStream'
  const CONTROLLER_END: keyof UnavailableRetryController = 'conditionEnded'
  const RETRY_CONDITION: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE'
  const LIVE: keyof typeof LivenessReadingModule = 'LIVENESS_LIVE'

  test('the condition is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), over the one notice episodes instance, after the retry controller and before the start bring-up, initRestart and initHealthCheck', () => {
    const at = onlyCallOf(FACTORY)
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${condition}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Over the one episodes instance (so the condition is that instance's
    // tmux-unresponsive episode, forgotten by a teardown and at shutdown).
    const episodes = constOf(EPISODES_FACTORY)
    declaredOnce(episodes)
    expect(onlyCallProps(FACTORY).get(EPISODES)).toBe(episodes)
    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))

    // After the controller its end hook reports to; before every path that
    // can start or end it.
    expect(at).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
    const { bringUpAt } = startResolution(SERVER_CODE)
    for (const later of [onlyCallOf('initRestart'), bringUpAt, onlyCallOf('initHealthCheck')]) {
      expect(at).toBeLessThan(later)
    }
  })

  test('it is the condition sink of the one initOutageState call, beside the retry controller\'s trigger sink, in main()\'s own statement list after it is built and before the start bring-up and initRestart', () => {
    const condition = constOf(FACTORY)
    const install = onlyCallOf('initOutageState')
    const props = onlyCallProps('initOutageState')
    expect(props.get(CONDITION_SINK)).toBe(condition)
    expect(props.get(TRIGGER_SINK)).toBe(constOf('createUnavailableRetryController'))
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf(FACTORY))
    expect(install).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)
    expect(install).toBeLessThan(onlyCallOf('initRestart'))
    // Nothing else names a condition sink in server.ts.
    expect(indicesOf(new RegExp(`\\b${CONDITION_SINK}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
  })

  test('the health check\'s end hook ends this condition for the persona it is given, with the tick reason and the live reading', () => {
    const condition = constOf(FACTORY)
    const hook = onlyCallProps('initHealthCheck').get(TICK_HOOK)
    expect(hook).toBeDefined()
    // `(key) => { <condition>.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE) }`,
    // or the same call as an expression body; the parameter's name is free.
    const call = `${condition}\\.${END}\\(\\1, ${END_TICK}, ${LIVE}\\)`
    expect(hook).toMatch(new RegExp(`^\\(?(\\w+)\\)? => (?:\\{ ${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, END_TICK)).toBe('./persona-episodes.ts')
    expect(importSource(SERVER_CODE, LIVE)).toBe('./liveness-reading.ts')
  })

  test('the full-mode retry action\'s end hook ends this condition for the persona it is given, with the retry reason and the retry\'s own reading, over the connectedness and stream probes the health check reads', () => {
    const condition = constOf(FACTORY)
    const props = onlyCallProps('createFullModeRetryAction')
    const hook = props.get(RETRY_HOOK)
    expect(hook).toBeDefined()
    // `(key, reading) => { ...; <condition>.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading); ... }`:
    // the end is a statement of its own in the block body, never skipped
    // behind a branch (no braces, branch keyword, `?`, `&&` or `||` before
    // it); the parameters' names are free. What else the body does (the
    // healthy-row `tmux-unavailable` clear, b.jg5 SRJ-311, SRJ-312) is pinned
    // in the describe below.
    const call = `${condition}\\.${END}\\(\\1, ${END_RETRY}, \\2\\)`
    const unbranched = `(?:(?!\\b(?:if|else|for|while|do|switch|return|try|catch)\\b)[^{}?&|])*`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => \\{ (?:${unbranched} )?${call};?(?: [^{}]*)? \\}$`))
    expect(importSource(SERVER_CODE, END_RETRY)).toBe('./persona-episodes.ts')

    // Absent, either probe answers "not connected" and a retry ends nothing:
    // the registry entry's connected flag, and the one stream probe the
    // health check also reads.
    expect(props.get(RETRY_CONNECTED)).toMatch(/^\(?(\w+)\)? => getSessionByPersona\(\1\)\?\.connected === true$/)
    expect(importSource(SERVER_CODE, 'getSessionByPersona')).toBe('./registry.ts')
    expect(props.get(RETRY_STREAM)).toBe('hasSessionStream')
    expect(onlyCallProps('initHealthCheck').get(TICK_STREAM)).toBe(props.get(RETRY_STREAM))
    expect(importSource(SERVER_CODE, 'hasSessionStream')).toBe('./persona-routing.ts')
  })

  test('the tick\'s and the retry\'s hooks and the latch\'s silent-end hold (b.jg5 SRJ-310, SRJ-502) are the only ends server.ts calls on the condition, one each', () => {
    const condition = constOf(FACTORY)
    const ends = indicesOf(new RegExp(`\\b${condition}\\s*[?!]?\\.\\s*${END}\\s*\\(`, 'g'), SERVER_CODE)
    expect(ends).toHaveLength(3)
    const tickHook = onlyCallProps('initHealthCheck').get(TICK_HOOK)!
    const retryHook = onlyCallProps('createFullModeRetryAction').get(RETRY_HOOK)!
    // What the hold's end passes is pinned in the latch holds' describe below.
    const latchHold = latchHoldProps().get(HOLD_END_TMUX)!
    const endCall = new RegExp(`\\b${condition}\\.${END}\\(`, 'g')
    expect([tickHook, retryHook, latchHold].map((hook) => (hook.match(endCall) ?? []).length)).toEqual([1, 1, 1])
  })

  test('the condition\'s end hook is the retry controller\'s condition-end entry, for the persona it is given, the tmux-unresponsive condition and the end\'s reading', () => {
    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    const hook = onlyCallProps(FACTORY).get(CONDITION_ENDED)
    expect(hook).toBeDefined()
    // `(key, reading) => <controller>.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, reading)`,
    // or the same call in a block body; the parameters' names are free.
    const call = `${controller}\\.${CONTROLLER_END}\\(\\1, ${RETRY_CONDITION}, \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ (?:return )?${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, RETRY_CONDITION)).toBe('./unavailable-retry.ts')
    // No other report of a condition's end anywhere in server.ts: this hook's
    // and the outage state's cleared-flag observer's (b.jg5 SRJ-305, SRJ-306;
    // pinned in the describe below) are the only two.
    const endEntry = new RegExp(`\\.\\s*${CONTROLLER_END}\\s*\\(`, 'g')
    expect(indicesOf(endEntry, SERVER_CODE)).toHaveLength(2)
    expect(hook!.match(endEntry) ?? []).toHaveLength(1)
    expect(onlyCallProps('initOutageState').get(FLAG_CLEARED)?.match(endEntry) ?? []).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-311 / SRJ-312 / SRJ-305 / SRJ-306 — the
// `tmux-unavailable` clear's production bindings
//
// The outage state's cleared-flag observer (`OutageStateDeps.onFlagCleared`)
// is optional (absent, a clear reaches nobody) and the full-mode retry
// action's healthy-row hook (`FullModeRetryDeps.endTmuxUnresponsive`) takes
// any body, so a production wiring that dropped either, bound the observer to
// a no-op, another controller or the wrong condition, reported every class's
// clear, dropped the clear's reading, installed a second observer or
// installed it after the start pass would type-check and pass every behaviour
// suite while a real `tmux-unavailable` clear never stopped the persona's
// retry timer, or a retry that found the row healthy never cleared the
// outage. What the observer and the clear do is tested in
// tests/outage-state.test.ts and tests/unavailable-retry.test.ts; pinned
// here: the bindings.
// ---------------------------------------------------------------------------

describe('main() binds the outage state\'s cleared-flag observer to the retry controller\'s condition-end entry for a tmux-unavailable clear, and the retry\'s healthy-row hook clears tmux-unavailable, both before the start pass (b.jg5 SRJ-311, SRJ-312, SRJ-305, SRJ-306)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const CLEAR: keyof typeof OutageStateModule = 'clearOutageFlag'
  const INIT: keyof typeof OutageStateModule = 'initOutageState'
  const CONTROLLER_END: keyof UnavailableRetryController = 'conditionEnded'
  const RETRY_CONDITION: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE'
  const RETRY_HOOK: keyof FullModeRetryDeps = 'endTmuxUnresponsive'
  const CONDITION_FACTORY: keyof typeof PersonaEpisodesModule = 'createTmuxUnresponsiveCondition'
  const END: keyof TmuxUnresponsiveCondition = 'end'
  const END_RETRY: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_RETRY'

  /** Every path that can raise, clear or read the flag: the start bring-up, the restart module and the health check. */
  function startPass(): number[] {
    return [startResolution(SERVER_CODE).bringUpAt, onlyCallOf('initRestart'), onlyCallOf('initHealthCheck')]
  }

  test('the observer reports only a tmux-unavailable clear, for the persona it is given and with the clear\'s reading, to the one retry controller\'s condition-end entry for the tmux-unavailable condition', () => {
    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    const hook = onlyCallProps(INIT).get(FLAG_CLEARED)
    expect(hook).toBeDefined()
    // `(key, cls, reading) => { if (cls === 'tmux-unavailable') { <controller>.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE, reading) } }`,
    // the if's body braced or not; the parameters' names are free.
    const call = `${controller}\\.${CONTROLLER_END}\\(\\1, ${RETRY_CONDITION}, \\3\\)`
    expect(hook).toMatch(new RegExp(
      `^\\((\\w+), (\\w+), (\\w+)\\) => \\{ if \\(\\2 === '${TMUX_UNAVAILABLE_CLASS}'\\) (?:\\{ ${call};? \\}|${call};?) \\}$`,
    ))
    expect(importSource(SERVER_CODE, RETRY_CONDITION)).toBe('./unavailable-retry.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${RETRY_CONDITION}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the observer is installed once, through the one initOutageState call, in main()\'s own statement list after the retry controller is built and before the start bring-up, the restart module and the health check', () => {
    const install = onlyCallOf(INIT)
    expect(importSource(SERVER_CODE, INIT)).toBe('./outage-state.ts')
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
    for (const later of startPass()) expect(install).toBeLessThan(later)
    // Nothing else names the observer in server.ts: no second install.
    const named = indicesOf(new RegExp(`\\b${FLAG_CLEARED}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(1)
    const [open, close] = balancedAfter(SERVER_CODE, install, '(', ')')
    expect(named[0]! > open && named[0]! < close).toBe(true)
  })

  test('the full-mode retry action\'s healthy-row hook clears the persona\'s tmux-unavailable outage with the retry\'s own reading, as a statement of its own beside the condition\'s end, through the outage state\'s clearOutageFlag', () => {
    const condition = constOf(CONDITION_FACTORY)
    const hook = onlyCallProps('createFullModeRetryAction').get(RETRY_HOOK)
    expect(hook).toBeDefined()
    // `(key, reading) => { <condition>.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading); clearOutageFlag(key, 'tmux-unavailable', reading) }`,
    // in either order; the parameters' names are free.
    const end = `${condition}\\.${END}\\(\\1, ${END_RETRY}, \\2\\)`
    const clear = `${CLEAR}\\(\\1, '${TMUX_UNAVAILABLE_CLASS}', \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => \\{ (?:${end};? ${clear}|${clear};? ${end});? \\}$`))
    // The outage state's own clear: imported, never declared or shadowed here.
    expect(importSource(SERVER_CODE, CLEAR)).toBe('./outage-state.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${CLEAR}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('that hook\'s clear is server.ts\'s only tmux-unavailable clear, inside the one full-mode retry action built in main() before the start pass; every clear in server.ts names its class as a quoted literal', () => {
    const clears = indicesOf(new RegExp(`\\b${CLEAR}\\s*\\(`, 'g'), SERVER_CODE)
    const classOf = (at: number) => splitTopLevel(callArguments(SERVER_CODE, at))[1]
    // A class held in a variable could be tmux-unavailable unseen: every clear
    // names its class literally.
    for (const at of clears) expect(classOf(at)).toMatch(/^'[a-z-]+'$/)
    const tmuxClears = clears.filter((at) => classOf(at) === `'${TMUX_UNAVAILABLE_CLASS}'`)
    expect(tmuxClears).toHaveLength(1)

    const action = onlyCallOf('createFullModeRetryAction')
    const [open, close] = balancedAfter(SERVER_CODE, action, '(', ')')
    expect(tmuxClears[0]! > open && tmuxClears[0]! < close).toBe(true)
    expect(insideMain(action)).toBe(true)
    for (const later of startPass()) expect(action).toBeLessThan(later)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-308 / SRJ-309 / SRJ-210 — the tmux-unresponsive
// condition's onset hooks, mode, alert threshold and alert stops
//
// The health check's tick-end hook and clock (`HealthCheckDeps.onTickEnd`,
// `now`), the retry controller's per-fire and stop observers
// (`UnavailableRetryDeps.onRetryFire`, `onStopped`) and the condition's mode
// and threshold accessors (`TmuxUnresponsiveConditionDeps.healthCheckOn`,
// `alertThresholdMs`) are all optional: absent, no onset is ever posted, a
// stopped timer leaves its alert check armed, the mode is "on" and no alert
// check is armed. So a production wiring that dropped one, bound it to a
// no-op, a local shadow or another instance, read the tick's start on a clock
// other than the one the first refusal is read on, or copied the mode or the
// threshold once would type-check and pass every behaviour suite. What each
// entry does is tested in tests/tmux-unresponsive.test.ts,
// tests/health-check.test.ts and tests/unavailable-retry.test.ts; the
// teardown's alert cancel in tests/reload-wiring.test.ts; shutdown's close in
// the SRJ-1016 describe above. Pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() binds the tmux-unresponsive condition\'s onset to the tick\'s end and to each retry fire, reads its mode and alert threshold at each check, and cancels its alert only at a retry-timer stop, at a teardown\'s timer stop and at shutdown (b.jg5 SRJ-308, SRJ-309, SRJ-210)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createTmuxUnresponsiveCondition'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const EPISODES_CLOCK: keyof PersonaEpisodes = 'clock'
  const ONSET_AT_TICK: keyof TmuxUnresponsiveCondition = 'onsetAtTick'
  const ONSET_AT_RETRY: keyof TmuxUnresponsiveCondition = 'onsetAtRetry'
  const CANCEL_ALERT: keyof TmuxUnresponsiveCondition = 'cancelAlert'
  const MODE: keyof TmuxUnresponsiveConditionDeps = 'healthCheckOn'
  const THRESHOLD: keyof TmuxUnresponsiveConditionDeps = 'alertThresholdMs'
  const TICK_END: keyof HealthCheckDeps = 'onTickEnd'
  const TICK_NOW: keyof HealthCheckDeps = 'now'
  const RETRY_FIRE: keyof UnavailableRetryDeps = 'onRetryFire'
  const RETRY_STOPPED: keyof UnavailableRetryDeps = 'onStopped'
  const UNCLASSIFIED_FACTORY: keyof typeof PersonaEpisodesModule = 'createUnclassifiedErrorEpisodes'
  const RETRY_STOPPED_ENTRY: keyof UnclassifiedErrorEpisodes = 'retryStopped'
  const TORN_DOWN: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_STOP_TORN_DOWN'
  const THRESHOLD_IN_EFFECT: keyof typeof AdSettingsModule = 'adAlertThresholdMsInEffect'
  const INTERVAL: keyof PersonaConfig = 'health_check_interval'

  test('the health check\'s tick-end hook is the condition\'s tick onset entry, given the tick\'s start, and the tick reads its start on the notice episodes\' own clock', () => {
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const props = onlyCallProps('initHealthCheck')

    // `(t) => <condition>.onsetAtTick(t)` (block or expression body), or the
    // entry itself; the parameter's name is free.
    const call = `${condition}\\.${ONSET_AT_TICK}\\(\\1\\)`
    expect(props.get(TICK_END)).toMatch(
      new RegExp(`^(?:${condition}\\.${ONSET_AT_TICK}|\\(?(\\w+)\\)? => (?:\\{ ${call};? \\}|${call}))$`),
    )

    // The clock the condition reads its first refusal on (the episodes'),
    // read at each tick: not the system clock by another name, not a value.
    const episodes = constOf(EPISODES_FACTORY)
    declaredOnce(episodes)
    expect(props.get(TICK_NOW)).toMatch(new RegExp(`^\\(\\) => ${episodes}\\.${EPISODES_CLOCK}\\.now\\(\\)$`))
  })

  test('the retry controller\'s per-fire observer is the condition\'s retry onset entry, given the persona and the fire time', () => {
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const hook = onlyCallProps('createUnavailableRetryController').get(RETRY_FIRE)
    expect(hook).toBeDefined()
    // `(key, firedAt) => <condition>.onsetAtRetry(key, firedAt)` (block or
    // expression body); the parameters' names are free. Only a wrapper: the
    // condition is declared after the controller is built.
    const call = `${condition}\\.${ONSET_AT_RETRY}\\(\\1, \\2\\)`
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
  })

  test('the two onset entries are called only from those two bindings', () => {
    const condition = constOf(FACTORY)
    for (const [entry, binding] of [
      [ONSET_AT_TICK, onlyCallProps('initHealthCheck').get(TICK_END)!],
      [ONSET_AT_RETRY, onlyCallProps('createUnavailableRetryController').get(RETRY_FIRE)!],
    ]) {
      expect([entry, indicesOf(new RegExp(`\\.\\s*${entry}\\b`, 'g'), SERVER_CODE).length]).toEqual([entry, 1])
      expect(binding).toContain(`${condition}.${entry}`)
    }
  })

  test('the mode is read at each check from the applied config holder\'s health_check_interval (the field startHealthCheck starts the tick with), with the start-time config as the fallback', () => {
    const mode = onlyCallProps(FACTORY).get(MODE)
    expect(mode).toBeDefined()
    // `() => (<holder> ?? <start-time>).health_check_interval !== 0`: read
    // at call time, never a value or a copy of the holder taken once.
    const loaded = loadedConfigName(SERVER_CODE)
    const m = mode!.match(new RegExp(`^\\(\\) => \\(${loaded} \\?\\? (\\w+)\\)\\.${INTERVAL} !== 0$`))
    expect(m).not.toBeNull()
    // The fallback is the start-time applied config the bring-up launch and
    // the restart delay read (pinned in the bring-up describe above).
    const launch = onlyCallProps('createPersonaBringUpController').get('launch')!
    expect(launch.match(/\?\? (\w+), false\)$/)![1]).toBe(m![1])
    expect(m![1]).not.toBe(loaded)
    // The same field the tick is started with.
    expect(onlyCallArgs('startHealthCheck')).toEqual([`${loaded}.${INTERVAL}`])
  })

  test('the alert threshold is E6\'s accessor of the threshold in effect itself, imported from ad-settings, never called (a value taken once) or shadowed in server.ts', () => {
    expect(onlyCallProps(FACTORY).get(THRESHOLD)).toBe(THRESHOLD_IN_EFFECT)
    expect(importSource(SERVER_CODE, THRESHOLD_IN_EFFECT)).toBe('./ad-settings.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${THRESHOLD_IN_EFFECT}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${THRESHOLD_IN_EFFECT}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the retry controller\'s stop observer calls the condition\'s alert cancel and the unclassified-error episodes\' stop entry, each given the persona and the stop reason and each in its own try/catch (b.jg5 SRJ-309, SRJ-313)', () => {
    const condition = constOf(FACTORY)
    declaredOnce(condition)
    const unclassified = constOf(UNCLASSIFIED_FACTORY)
    declaredOnce(unclassified)
    const hook = onlyCallProps('createUnavailableRetryController').get(RETRY_STOPPED)
    expect(hook).toBeDefined()
    // `(key, reason) => { try { <condition>.cancelAlert(key, reason) } catch { }
    // try { <episodes>.retryStopped(key, reason) } catch { } }`, in either
    // order; the parameters' names are free. Only a wrapper: both are
    // declared after the controller is built. Each call is isolated, so one
    // consumer that throws never skips the other.
    const cancel = isolated(`${condition}\\.${CANCEL_ALERT}\\(\\1, \\2\\)`)
    const stopped = isolated(`${unclassified}\\.${RETRY_STOPPED_ENTRY}\\(\\1, \\2\\)`)
    expect(hook).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => \\{ (?:${cancel} ${stopped}|${stopped} ${cancel}) \\}$`))
  })

  test('the alert is cancelled only by the retry controller\'s stop observer and by the lifecycle\'s stopRetryTimer, with the torn-down reason (server.ts\'s two cancelAlert calls)', () => {
    const condition = constOf(FACTORY)
    const cancels = indicesOf(new RegExp(`\\.\\s*${CANCEL_ALERT}\\s*\\(`, 'g'), SERVER_CODE)
    expect(cancels).toHaveLength(2)
    expect(onlyCallProps('createUnavailableRetryController').get(RETRY_STOPPED)).toContain(`${condition}.${CANCEL_ALERT}(`)
    expect(onlyCallProps('createPersonaLifecycle').get('stopRetryTimer')).toMatch(
      new RegExp(`\\b${condition}\\.${CANCEL_ALERT}\\((\\w+), ${TORN_DOWN}\\)`),
    )
    // One call lies inside each factory's argument.
    const inside = (factory: string) => {
      const [start, end] = balancedAfter(SERVER_CODE, onlyCallOf(factory), '(', ')')
      return cancels.filter((at) => at > start && at < end).length
    }
    expect([inside('createUnavailableRetryController'), inside('createPersonaLifecycle')]).toEqual([1, 1])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-313 / SRJ-1009 — the unclassified-error episodes'
// production bindings
//
// The outage state's unclassified sink (`OutageStateDeps.unclassifiedSink`),
// the episodes' configured-key lookup and log-only route
// (`UnclassifiedErrorEpisodesDeps.isConfigured`, `logOnly`), the retry
// controller's stop observer and the restart module's `onCapReached` are all
// optional or take any body: absent, no UNCLASSIFIED outcome reaches an
// episode, every key reads as configured (an alert for a persona no longer
// configured would reach Slack), a log-only alert goes nowhere, and an
// episode never ends at a recovered retry or at the cap. So a production
// wiring that dropped one, bound it to a no-op or a local shadow, built a
// second instance, installed the sink twice or after the start pass would
// type-check and pass every behaviour suite. What the episodes do is tested
// in tests/persona-episodes.test.ts, the reporting point in
// tests/outage-state.test.ts and the end-to-end cases in
// tests/unavailable-retry.test.ts; the stop observer's binding is pinned in
// the describe above. Pinned here: the build and the other bindings.
// ---------------------------------------------------------------------------

describe('main() builds the one unclassified-error episodes instance over the notice episodes before the start pass, installs it as the outage state\'s unclassified sink, routes its log-only alert through recordStartupError, and ends its episode at the restart cap (b.jg5 SRJ-313, SRJ-1009)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createUnclassifiedErrorEpisodes'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const LABEL: keyof typeof PersonaEpisodesModule = 'PERSONA_UNCLASSIFIED_ERROR_LABEL'
  const END_CAPPED: keyof typeof PersonaEpisodesModule = 'UNCLASSIFIED_ERROR_END_CAPPED'
  const EPISODES: keyof UnclassifiedErrorEpisodesDeps = 'episodes'
  const LOG: keyof UnclassifiedErrorEpisodesDeps = 'log'
  const THRESHOLD: keyof UnclassifiedErrorEpisodesDeps = 'alertThresholdMs'
  const IS_CONFIGURED: keyof UnclassifiedErrorEpisodesDeps = 'isConfigured'
  const LOG_ONLY: keyof UnclassifiedErrorEpisodesDeps = 'logOnly'
  const END: keyof UnclassifiedErrorEpisodes = 'end'
  const RETRY_STOPPED_ENTRY: keyof UnclassifiedErrorEpisodes = 'retryStopped'
  const REPORT: keyof UnclassifiedErrorEpisodes = 'report'
  const SINK: keyof OutageStateDeps = 'unclassifiedSink'
  const CAP_REACHED: keyof RestartDeps = 'onCapReached'
  const RETRY_STOPPED: keyof UnavailableRetryDeps = 'onStopped'
  const THRESHOLD_IN_EFFECT: keyof typeof AdSettingsModule = 'adAlertThresholdMsInEffect'

  /** Every path that can report an UNCLASSIFIED outcome: the start bring-up, the restart module and the health check. */
  function startPass(): number[] {
    return [startResolution(SERVER_CODE).bringUpAt, onlyCallOf('initRestart'), onlyCallOf('initHealthCheck')]
  }

  test('the instance is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), over the one notice episodes instance, after it and before the retry controller, the outage state\'s install and the start pass', () => {
    const at = onlyCallOf(FACTORY)
    const unclassified = constOf(FACTORY)
    declaredOnce(unclassified)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${unclassified}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Over the one episodes instance: a teardown's forget and shutdown's
    // close reach its episode.
    const episodes = constOf(EPISODES_FACTORY)
    expect(onlyCallProps(FACTORY).get(EPISODES)).toBe(episodes)
    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))

    for (const later of [onlyCallOf('createUnavailableRetryController'), onlyCallOf('initOutageState'), ...startPass()]) {
      expect(at).toBeLessThan(later)
    }
  })

  test('its log is the server log and its alert threshold is E6\'s accessor of the threshold in effect itself, never a value taken once', () => {
    const props = onlyCallProps(FACTORY)
    expect(props.get(LOG)).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
    expect(props.get(THRESHOLD)).toBe(THRESHOLD_IN_EFFECT)
    expect(importSource(SERVER_CODE, THRESHOLD_IN_EFFECT)).toBe('./ad-settings.ts')
  })

  test('its configured-key lookup asks the live applied-persona lookup, getAppliedPersona, for the key it is given, at each check', () => {
    // `(key) => getAppliedPersona(key) !== undefined`; the parameter's name is free.
    expect(onlyCallProps(FACTORY).get(IS_CONFIGURED)).toMatch(/^\(?(\w+)\)? => getAppliedPersona\(\1\) !== undefined$/)
    declaredOnce('getAppliedPersona')
    expect(importSource(SERVER_CODE, 'getAppliedPersona')).toBeUndefined()
  })

  test('its log-only route is one recordStartupError call with the exported persona-unclassified-error label and a text naming the persona\'s key and the alert\'s text', () => {
    const route = onlyCallProps(FACTORY).get(LOG_ONLY)
    expect(route).toBeDefined()
    // `(key, text) => recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, `…${key}…${text}…`)`
    // (block or expression body); the parameters' names are free.
    const call = `recordStartupError\\(${LABEL}, \`[^\`]*\\$\\{\\1\\}[^\`]*\\$\\{\\2\\}[^\`]*\`\\)`
    expect(route).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, 'recordStartupError')).toBe('./startup-errors.ts')
    expect(importSource(SERVER_CODE, LABEL)).toBe('./persona-episodes.ts')
    for (const name of ['recordStartupError', LABEL]) {
      expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)).toEqual([])
    }
  })

  test('it is the unclassified sink of the one initOutageState call, in main()\'s own statement list before the start pass; nothing else names an unclassified sink', () => {
    const install = onlyCallOf('initOutageState')
    expect(onlyCallProps('initOutageState').get(SINK)).toBe(constOf(FACTORY))
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    for (const later of startPass()) expect(install).toBeLessThan(later)
    const named = indicesOf(new RegExp(`\\b${SINK}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(1)
    const [open, close] = balancedAfter(SERVER_CODE, install, '(', ')')
    expect(named[0]! > open && named[0]! < close).toBe(true)
  })

  test('the restart module\'s onCapReached raises the cap notice, ends the persona\'s episode with the capped reason and stops its retry timer with the capped reason (b.jg5 SRJ-305), for the key it is given, each in its own try/catch', () => {
    // Tied to src by type: renaming either fails the typecheck.
    const STOP: keyof UnavailableRetryController = 'stop'
    const STOP_CAPPED: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_STOP_CAPPED'
    const unclassified = constOf(FACTORY)
    const controller = constOf('createUnavailableRetryController')
    const hook = onlyCallProps('initRestart').get(CAP_REACHED)
    expect(hook).toBeDefined()
    // `(key) => { try { notifyRestartCapReached(key) } catch { } try { <episodes>.end(key, UNCLASSIFIED_ERROR_END_CAPPED) } catch { }
    // try { <controller>.stop(key, UNAVAILABLE_RETRY_STOP_CAPPED) } catch { } }`, in any order; the parameter's name is free.
    const steps = [
      isolated('notifyRestartCapReached\\(\\1\\)'),
      isolated(`${unclassified}\\.${END}\\(\\1, ${END_CAPPED}\\)`),
      isolated(`${controller}\\.${STOP}\\(\\1, ${STOP_CAPPED}\\)`),
    ]
    const orders = steps.flatMap((a) => steps.filter((b) => b !== a).flatMap((b) => steps.filter((c) => c !== a && c !== b).map((c) => `${a} ${b} ${c}`)))
    expect(orders).toHaveLength(6)
    expect(hook).toMatch(new RegExp(`^\\(?(\\w+)\\)? => \\{ (?:${orders.join('|')}) \\}$`))
    expect(importSource(SERVER_CODE, 'notifyRestartCapReached')).toBe('./session-manager.ts')
    expect(importSource(SERVER_CODE, END_CAPPED)).toBe('./persona-episodes.ts')
    expect(importSource(SERVER_CODE, STOP_CAPPED)).toBe('./unavailable-retry.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+(?:notifyRestartCapReached|${END_CAPPED}|${STOP_CAPPED})\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the instance is named only at its build, as the sink, in the stop observer, in onCapReached and in the latch\'s unclassified hold (b.jg5 SRJ-502): its end and stop entries are called from those bindings alone, and server.ts reports to it directly nowhere', () => {
    const unclassified = constOf(FACTORY)
    const named = indicesOf(new RegExp(`\\b${unclassified}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(5)
    // Each use located: the declaration, and one inside each binding (the
    // latch's hold names it before its declaration, as a call-time read).
    const decl = SERVER_CODE.match(new RegExp(`\\bconst\\s+${unclassified}\\b`))!
    expect(named).toContain(decl.index! + decl[0].length - unclassified.length)
    const within = (call: string) => {
      const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf(call), '(', ')')
      return named.filter((at) => at > open && at < close).length
    }
    expect([within('initOutageState'), within('createUnavailableRetryController'), within('initRestart'), within(BIND_LATCH_HOLDS)]).toEqual([1, 1, 1, 1])

    const calls = (entry: string) => indicesOf(new RegExp(`\\b${unclassified}\\s*[?!]?\\.\\s*${entry}\\s*\\(`, 'g'), SERVER_CODE)
    expect(calls(REPORT)).toEqual([])
    expect(calls(END)).toHaveLength(2)
    expect(calls(RETRY_STOPPED_ENTRY)).toHaveLength(1)
    expect(onlyCallProps('initRestart').get(CAP_REACHED)).toContain(`${unclassified}.${END}(`)
    expect(latchHoldProps().get(HOLD_END_UNCLASSIFIED)).toContain(`${unclassified}.${END}(`)
    expect(onlyCallProps('createUnavailableRetryController').get(RETRY_STOPPED)).toContain(`${unclassified}.${RETRY_STOPPED_ENTRY}(`)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-704 / SRJ-1007 / SRJ-1016 — the kill-failure
// alerts' production bindings
//
// `KillFailureAlertsDeps.isConfigured` and `logOnly` are optional (absent,
// every key reads as configured, so an alert for a persona no longer in the
// applied configuration would reach Slack, and a log-only alert goes
// nowhere), the session manager's install is optional (absent, every alert is
// one log line and no episode ever opens or ends), and any episodes object
// type-checks as `episodes` (one a teardown never forgets and shutdown never
// closes). So a production wiring that dropped one, bound it to a constant or
// a second instance, installed the alerts after the start sweep or the start
// pass, or kept a module-scope copy would type-check and pass every behaviour
// suite. What the alerts do is tested in tests/persona-episodes.test.ts and
// end to end on the recovery harness (tests/restart.test.ts,
// tests/session-manager.test.ts); the routing's kill-failed query is pinned in
// the routing's describe below. Pinned here: the build, the install, the
// restart adapter's raise and where the persona teardown's alert raiser names
// the instance (its form is pinned in tests/reload-wiring.test.ts).
// ---------------------------------------------------------------------------

describe('main() builds the one kill-failure alerts instance over the notice episodes, with the live applied-persona lookup and recordStartupError as its log-only route, and installs it in the session manager before the restart module, the start sweep and the start pass (b.jg5 SRJ-704, SRJ-1007, SRJ-1016)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof PersonaEpisodesModule = 'createKillFailureAlerts'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const INSTALL: keyof typeof SessionManagerModule = 'setKillFailureAlerts'
  const RAISE: keyof typeof SessionManagerModule = 'raisePersonaKillFailureAlert'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const KILL_ADAPTER: keyof typeof ServerModule = '_buildKillSessionAdapter'
  const EPISODES: keyof KillFailureAlertsDeps = 'episodes'
  const LOG: keyof KillFailureAlertsDeps = 'log'
  const IS_CONFIGURED: keyof KillFailureAlertsDeps = 'isConfigured'
  const LOG_ONLY: keyof KillFailureAlertsDeps = 'logOnly'

  test('the instance is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), over the one notice episodes instance, after it; its deps are exactly these four', () => {
    const at = onlyCallOf(FACTORY)
    const alerts = constOf(FACTORY)
    declaredOnce(alerts)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${alerts}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // Over the one episodes instance: a teardown's forget and shutdown's
    // close reach its episode, and its destination post is the notifier's.
    expect(onlyCallProps(FACTORY).get(EPISODES)).toBe(constOf(EPISODES_FACTORY))
    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))
    expect([...onlyCallProps(FACTORY).keys()].sort()).toEqual([EPISODES, IS_CONFIGURED, LOG, LOG_ONLY].sort())
  })

  test('its log is the server log; its configured-key lookup asks the live applied-persona lookup, getAppliedPersona, for the key it is given, at each raise', () => {
    const props = onlyCallProps(FACTORY)
    expect(props.get(LOG)).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
    // `(key) => getAppliedPersona(key) !== undefined`; the parameter's name is free.
    expect(props.get(IS_CONFIGURED)).toMatch(/^\(?(\w+)\)? => getAppliedPersona\(\1\) !== undefined$/)
    declaredOnce('getAppliedPersona')
    expect(importSource(SERVER_CODE, 'getAppliedPersona')).toBeUndefined()
  })

  test('its log-only route is one recordStartupError call with the class and the entry it is given, unchanged', () => {
    // `(classLabel, entry) => recordStartupError(classLabel, entry)` (block or
    // expression body); the parameters' names are free.
    const call = 'recordStartupError\\(\\1, \\2\\)'
    expect(onlyCallProps(FACTORY).get(LOG_ONLY)).toMatch(new RegExp(`^\\((\\w+), (\\w+)\\) => (?:\\{ ${call};? \\}|${call})$`))
    expect(importSource(SERVER_CODE, 'recordStartupError')).toBe('./startup-errors.ts')
  })

  test('it is installed in the session manager exactly once, in main()\'s own statement list, after its build and before the restart module, the start sweep and the start pass; the install is the session manager\'s import', () => {
    const alerts = constOf(FACTORY)
    const install = onlyCallOf(INSTALL)
    expect(onlyCallArgs(INSTALL)).toEqual([alerts])
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    expect(install).toBeGreaterThan(onlyCallOf(FACTORY))
    for (const later of [onlyCallOf('initRestart'), onlyCallOf(START_SWEEP), startResolution(SERVER_CODE).bringUpAt]) {
      expect(install).toBeLessThan(later)
    }
    for (const name of [INSTALL, RAISE]) {
      expect([name, importSource(SERVER_CODE, name)]).toEqual([name, './session-manager.ts'])
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
  })

  test('the instance is named only at its build, its install, the routing holder\'s assignment, the persona teardown\'s alert raiser and the old-life wait\'s bindings (no module-scope copy, no second use)', () => {
    const alerts = constOf(FACTORY)
    const ALERT_RAISE: keyof KillFailureAlerts = 'raise'
    const TEARDOWN_RAISER: keyof PersonaLifecycleDeps = 'raiseKillFailureAlert'
    const WAIT_ALERTS: keyof OldLifeWaitBindings = 'killFailureAlerts'
    const named = indicesOf(new RegExp(`\\b${alerts}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(5)
    // The fifth is the old-life wait's alert sink (b.jg5 SRJ-811): that one
    // member of its bindings and nothing else there (its install is pinned in
    // the old-life wait's describe).
    const waitProps = onlyCallProps('setOldLifeWaitBindings')
    expect(withinCall(named, onlyCallOf('setOldLifeWaitBindings'))).toBe(1)
    expect([...waitProps].filter(([, value]) => new RegExp(`\\b${alerts}\\b`).test(value)).map(([prop]) => prop)).toEqual([WAIT_ALERTS])
    // The install's one argument starts right at its opening parenthesis.
    expect(named).toContain(balancedAfter(SERVER_CODE, onlyCallOf(INSTALL), '(', ')')[0])
    // The third is the routing holder's assignment (pinned in the routing's describe below).
    // The fourth is the persona teardown's raiser (b.jg5 SRJ-704, SRJ-715): one
    // raise on the instance inside createPersonaLifecycle's call, as the value
    // of its alert raiser and nothing else (its whole form is pinned in
    // tests/reload-wiring.test.ts).
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaLifecycle'), '(', ')')
    expect(named.filter((at) => at > open && at < close)).toHaveLength(1)
    const lifecycleProps = onlyCallProps('createPersonaLifecycle')
    expect(lifecycleProps.get(TEARDOWN_RAISER)).toContain(`${alerts}.${ALERT_RAISE}(`)
    expect([...lifecycleProps].filter(([, value]) => new RegExp(`\\b${alerts}\\b`).test(value)).map(([prop]) => prop)).toEqual([TEARDOWN_RAISER])
    for (const at of named) expect(insideMain(at)).toBe(true)
  })

  test('the restart kill adapter raises the kill retry\'s decision once, for its key and the retry\'s result, after the outcome\'s own handling (latchOnRestartKillOutcome) and before it answers the outcome; server.ts raises it nowhere else', () => {
    const [start, end] = exportedFunctionBody(KILL_ADAPTER)
    const raises = callsOf(RAISE)
    expect(raises).toHaveLength(1)
    const at = raises[0]!
    expect(at > start && at < end).toBe(true)
    const body = SERVER_CODE.slice(start, end)
    // The adapter's key (the returned arrow's first parameter; its name is free) and the retry's result.
    const key = body.match(/\breturn\s+async\s+\(\s*(\w+)/)![1]!
    const retried = body.match(/\bconst\s+(\w+)\s*=\s*await\s+retryPersonaKill\s*\(/)![1]!
    const [first, second] = splitTopLevel(callArguments(SERVER_CODE, at))
    expect([first, second]).toEqual([key, retried])
    expect(at).toBeGreaterThan(callsOf('latchOnRestartKillOutcome').find((offset) => offset > start && offset < end)!)
    expect(at).toBeLessThan(start + body.lastIndexOf('return outcome'))
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-501 / SRJ-508 — the one per-persona latch and its
// CONFLICT notice binding
//
// Nothing makes main() build the latch or bind its notice, and any episodes
// object with `begin` and `post` type-checks as the binding's target. So a
// production wiring that dropped the build or the binding, built a second
// latch (one a launch sets, another the notice watches), built or bound it
// after the start pass (a first launch's CONFLICT with no latch, or no
// notice, to reach), bound the notice twice (two posts in one episode) or to
// episodes other than the one instance (which a teardown never forgets and
// shutdown never closes), or seeded the latch from a file (SRJ-501: it is
// held in server memory only) would pass every behaviour suite. What the
// latch and its notice do is tested in tests/conflict-latch.test.ts; pinned
// here: the build and the binding.
// ---------------------------------------------------------------------------

describe('main() builds the one per-persona latch, in server memory only, before the start pass, and binds its CONFLICT notice once to the one set of notice episodes (b.jg5 SRJ-501, SRJ-508)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const BIND: keyof typeof ConflictLatchModule = 'bindConflictNotice'
  const OBSERVER_FACTORY: keyof typeof ConflictLatchModule = 'createConflictNoticeObserver'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const LOG: keyof ConflictLatchDeps = 'log'
  const ADD_OBSERVER: keyof ConflictLatch = 'addSetObserver'
  const SET: keyof ConflictLatch = 'set'
  const SET_FROM_CONFLICT: keyof ConflictLatch = 'setFromConflict'

  const LATCH_PATH = join(SRC_DIR, 'conflict-latch.ts')

  test('the latch is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), after the notice episodes and before the retry controller and the start pass', () => {
    const at = onlyCallOf(LATCH_FACTORY)
    const latch = constOf(LATCH_FACTORY)
    declaredOnce(latch)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${latch}\\s*=\\s*${LATCH_FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(at)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, LATCH_FACTORY)).toBe('./conflict-latch.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${LATCH_FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
  })

  test('its only dependency is the server log: no option loads latch state from anywhere', () => {
    const props = onlyCallProps(LATCH_FACTORY)
    expect([...props.keys()]).toEqual([LOG])
    expect(props.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
  })

  test('its CONFLICT notice is bound exactly once, in main()\'s own statement list after the build and before the retry controller and the start pass, to the latch and the one notice episodes instance; nothing else in server.ts adds a set observer', () => {
    const at = onlyCallOf(BIND)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(importSource(SERVER_CODE, BIND)).toBe('./conflict-latch.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${BIND}\\b`, 'g'), SERVER_CODE)).toEqual([])

    expect(onlyCallArgs(BIND)).toEqual([constOf(LATCH_FACTORY), constOf(EPISODES_FACTORY)])
    expect(at).toBeGreaterThan(onlyCallOf(LATCH_FACTORY))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)

    // No second binding by hand: the notice's observer is built only inside
    // the binding, and no set observer is added in server.ts.
    expect(callsOf(OBSERVER_FACTORY)).toEqual([])
    expect(indicesOf(new RegExp(`\\.\\s*${ADD_OBSERVER}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('nothing in main() loads latch state from a file: no statement of main() sets the latch, the instance is named only at its build, its two bindings, its install, the latch re-check\'s build and binding, its four latched queries in main() (the retry action\'s, the restart work\'s, the reconnect adapter\'s inside the restart module\'s call, and the health tick\'s), the persona routing\'s holder assignment and the teardown\'s forget, and the latch module imports no file-system module', () => {
    const latch = constOf(LATCH_FACTORY)
    const IS_LATCHED: keyof ConflictLatch = 'isLatched'

    // No seed: no statement in main()'s own list records a latch, and nothing
    // in server.ts calls a set entry on it at all.
    const sets = indicesOf(new RegExp(`\\b${latch}\\s*[?!]?\\.\\s*(?:${SET}|${SET_FROM_CONFLICT})\\s*\\(`, 'g'), SERVER_CODE)
    for (const set of sets) expect(atMainTopLevel(SERVER_CODE, set)).toBe(false)
    expect(sets).toEqual([])

    // Named only at its build, then once inside each of: the holds' binding
    // and the notice's binding (b.jg5 SRJ-502, SRJ-508), the latch
    // re-check's build (its `latch` input) and its binding (b.jg5 SRJ-505;
    // both pinned in the re-check's describe below), the session
    // manager's install, the retry run's gate's latched query (the retry
    // action's and the approver-stop run's, b.jg5 SRJ-404), the health
    // check's latched query, and the persona teardown's latch forget (b.jg5 SRJ-504; its
    // form is pinned in tests/reload-wiring.test.ts); twice inside the restart
    // module's call: its own latched query and the reconnect adapter's, asked
    // right before /mcp reconnect is typed (b.jg5 SRJ-502); and once as the
    // value of the persona routing's module-scope holder, which the routing's
    // lost-message latched query reads at call time (b.jg5 SRJ-1011). The
    // queries' forms are pinned in the describe below; the holder's in the
    // persona routing's describe.
    const named = indicesOf(new RegExp(`\\b${latch}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(12)
    const decl = SERVER_CODE.match(new RegExp(`\\bconst\\s+${latch}\\b`))!
    expect(named[0]).toBe(decl.index! + decl[0].length - latch.length)
    const withinAt = (at: number) => {
      const [open, close] = balancedAfter(SERVER_CODE, at, '(', ')')
      return named.filter((offset) => offset >= open && offset < close).length
    }
    const within = (call: string) => withinAt(onlyCallOf(call))
    expect(
      [BIND_LATCH_HOLDS, BIND, RECHECK_BUILDER, RECHECK_BIND, 'setConflictLatch', 'createFullModeRetryAction', 'initRestart', 'initHealthCheck', 'createPersonaLifecycle'].map(within),
    ).toEqual([1, 1, 1, 1, 1, 0, 2, 1, 1])
    expect(onlyCallProps(RECHECK_BUILDER).get(RECHECK_LATCH)).toBe(latch)
    expect(withinRetryRunGate(named)).toBe(1)
    // The restart module's second: the reconnect adapter's, built inside its call.
    const [restartOpen, restartClose] = balancedAfter(SERVER_CODE, onlyCallOf('initRestart'), '(', ')')
    const adapter = onlyReconnectAdapterBuild()
    expect(adapter > restartOpen && adapter < restartClose).toBe(true)
    expect(withinAt(adapter)).toBe(1)
    expect(onlyCallProps('createPersonaLifecycle').get('forgetConflictLatch')).toContain(`${latch}.`)
    // The twelfth: the routing holder's one assignment, the bare latch.
    const routing = routingHolder(ROUTING_LATCHED, IS_LATCHED, latch, [CHECK_LATCHED])
    expect(named.filter((offset) => offset > routing.at && offset < routing.end)).toHaveLength(1)

    // The factory itself reads no file: the latch module imports no
    // file-system module and opens no file through Bun.
    const latchCode = stripComments(readFileSync(LATCH_PATH, 'utf-8'))
    expect(indicesOf(/\bfrom\s*['"](?:node:)?fs(?:\/promises)?['"]/g, latchCode)).toEqual([])
    expect(indicesOf(/\brequire\s*\(/g, latchCode)).toEqual([])
    expect(indicesOf(/\bBun\s*\.\s*file\s*\(/g, latchCode)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-502 / SRJ-305 / SRJ-310 / SRJ-313 / SRJ-315 — what
// the latch holds back: its hold observer, its install in the session
// manager and its latched query
//
// Every one of these bindings is optional or takes any body: absent, the
// session manager has no latch (a CONFLICT logs one line and nothing is
// latched for later launches to ask), the restart work, the retry action and
// the health tick read every persona as not latched (each attempts again for
// a latched persona), and a latch leaves its retry timer running, its
// tmux-unresponsive condition open (a recovery posted later, or never) and its
// unclassified-error episode open. Observers run in the order they are added,
// so holds bound after the notice would post the CONFLICT notice with the
// timer still armed. A production wiring that dropped one, bound it twice,
// bound it to a no-op, the wrong reason or the condition-end entry (whose
// SRJ-306 exceptions must not apply to a latch), or installed the latch after
// the start pass would type-check and pass every behaviour suite. What each
// does is tested in tests/conflict-latch.test.ts, tests/session-manager.test.ts,
// tests/restart.test.ts, tests/unavailable-retry.test.ts and
// tests/health-check.test.ts; pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() binds the latch\'s holds before its CONFLICT notice, installs the latch in the session manager before the start pass, and binds its latched query into the retry action, the restart work and the health tick (b.jg5 SRJ-502, SRJ-305, SRJ-310, SRJ-313, SRJ-315)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const BIND_NOTICE: keyof typeof ConflictLatchModule = 'bindConflictNotice'
  const HOLD_OBSERVER_FACTORY: keyof typeof ConflictLatchModule = 'createConflictLatchHoldObserver'
  const IS_LATCHED: keyof ConflictLatch = 'isLatched'
  const RETRY_LATCHED: keyof FullModeRetryDeps = 'isLatched'
  const RESTART_LATCHED: keyof RestartDeps = 'isLatched'
  const TICK_LATCHED: keyof HealthCheckDeps = 'isLatched'
  const STOP: keyof UnavailableRetryController = 'stop'
  const CONDITION_END: keyof TmuxUnresponsiveCondition = 'end'
  const EPISODE_END: keyof UnclassifiedErrorEpisodes = 'end'
  const STOP_LATCHED: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_STOP_LATCHED'
  const TMUX_END_LATCHED: keyof typeof PersonaEpisodesModule = 'TMUX_UNRESPONSIVE_END_LATCHED'
  const UNCLASSIFIED_END_LATCHED: keyof typeof PersonaEpisodesModule = 'UNCLASSIFIED_ERROR_END_LATCHED'
  const INSTALL: keyof typeof SessionManagerModule = 'setConflictLatch'

  /** `name` is imported from `module` and declared nowhere in server.ts. */
  function importedOnly(name: string, module: string): void {
    expect(importSource(SERVER_CODE, name)).toBe(module)
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)).toEqual([])
  }

  test('the holds are bound exactly once, in main()\'s own statement list, to the one latch with the server log, after the latch is built and BEFORE its CONFLICT notice is bound (set observers run in the order they are added), and before the start pass; server.ts builds no hold observer by hand', () => {
    const at = onlyCallOf(BIND_LATCH_HOLDS)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    importedOnly(BIND_LATCH_HOLDS, './conflict-latch.ts')

    const [latch, , log] = onlyCallArgs(BIND_LATCH_HOLDS)
    expect(latch).toBe(constOf(LATCH_FACTORY))
    expect(log).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)

    expect(at).toBeGreaterThan(onlyCallOf(LATCH_FACTORY))
    expect(at).toBeLessThan(onlyCallOf(BIND_NOTICE))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)

    expect(callsOf(HOLD_OBSERVER_FACTORY)).toEqual([])
  })

  test('the holds are exactly five: the retry timer stop, the silent end of tmux-unresponsive, the end of the unclassified-error episode, the slow-recovery end and the stuck-launch end (b.jg5 SRJ-610, SRJ-1016; the last two bindings are pinned in their describes below)', () => {
    expect([...latchHoldProps().keys()].sort()).toEqual([HOLD_STOP_RETRY, HOLD_END_TMUX, HOLD_END_UNCLASSIFIED, HOLD_END_SLOW_RECOVERY, HOLD_END_STUCK_LAUNCH].sort())
  })

  test('the retry-timer hold stops the persona\'s timer on the one retry controller through its stop entry, with the latch\'s own stop reason, never through the condition-end entry (b.jg5 SRJ-305)', () => {
    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    const hold = latchHoldProps().get(HOLD_STOP_RETRY)
    expect(hold).toMatch(oneKeyArrow(`${controller}\\.${STOP}\\(\\1, ${STOP_LATCHED}\\)`))
    expect(hold).not.toContain('conditionEnded')
    importedOnly(STOP_LATCHED, './unavailable-retry.ts')
    // The latch's reason is named only by its import and this hold.
    expect(indicesOf(new RegExp(`\\b${STOP_LATCHED}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
  })

  test('the tmux-unresponsive hold ends the one condition silently (no recovery notice), for the persona it is given, with the latch\'s end reason and no reading (b.jg5 SRJ-310)', () => {
    const condition = constOf('createTmuxUnresponsiveCondition')
    declaredOnce(condition)
    const hold = latchHoldProps().get(HOLD_END_TMUX)
    expect(hold).toMatch(oneKeyArrow(`${condition}\\.${CONDITION_END}\\(\\1, ${TMUX_END_LATCHED}, undefined, \\{ silent: true \\}\\)`))
    importedOnly(TMUX_END_LATCHED, './persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b${TMUX_END_LATCHED}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    // The hold's is server.ts's only silent end.
    expect(indicesOf(/\bsilent\s*:/g, SERVER_CODE)).toHaveLength(1)
  })

  test('the unclassified hold ends the persona\'s episode on the one unclassified-error episodes instance, with the latch\'s end reason (b.jg5 SRJ-313)', () => {
    const unclassified = constOf('createUnclassifiedErrorEpisodes')
    declaredOnce(unclassified)
    const hold = latchHoldProps().get(HOLD_END_UNCLASSIFIED)
    expect(hold).toMatch(oneKeyArrow(`${unclassified}\\.${EPISODE_END}\\(\\1, ${UNCLASSIFIED_END_LATCHED}\\)`))
    importedOnly(UNCLASSIFIED_END_LATCHED, './persona-episodes.ts')
    expect(indicesOf(new RegExp(`\\b${UNCLASSIFIED_END_LATCHED}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
  })

  test('the latch is installed in the session manager exactly once (nothing uninstalls it), in main()\'s own statement list, after its holds and its notice are bound and before the retry controller and the start pass', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    importedOnly(INSTALL, './session-manager.ts')
    expect(onlyCallArgs(INSTALL)).toEqual([constOf(LATCH_FACTORY)])

    expect(at).toBeGreaterThan(onlyCallOf(BIND_LATCH_HOLDS))
    expect(at).toBeGreaterThan(onlyCallOf(BIND_NOTICE))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
  })

  // The holds name the retry controller, the condition and the unclassified
  // episodes, all built after the latch is installed: a hold run before they
  // exist would throw (and be logged) and hold nothing back. Only a launch
  // can latch, and none starts before main() first yields.
  test('no statement awaits between the latch\'s install and the build of the last of the holds\' targets', () => {
    const install = onlyCallOf(INSTALL)
    const built = ['createUnavailableRetryController', 'createTmuxUnresponsiveCondition', 'createUnclassifiedErrorEpisodes'].map(onlyCallOf)
    const last = Math.max(...built)
    expect(last).toBeGreaterThan(install)
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(install, last))).toEqual([])
  })

  test('five latched queries and one read: the latched query is bound exactly once into each of the full-mode retry action, the restart work, the reconnect adapter (its second argument, after the persona lookup) and the health tick, as a call-time read of the one latch\'s isLatched for the key it is given, and once into the persona routing, through its module-scope holder of that one latch (b.jg5 SRJ-1011), which the tmux-unavailable retry check\'s production deps also ask once (b.jg5 SRJ-311)', () => {
    const latch = constOf(LATCH_FACTORY)
    declaredOnce(latch)
    const query = oneKeyArrow(`${latch}\\.${IS_LATCHED}\\(\\1\\)`)
    expect(onlyCallProps('createFullModeRetryAction').get(RETRY_LATCHED)).toMatch(query)
    expect(onlyCallProps('initRestart').get(RESTART_LATCHED)).toMatch(query)
    expect(onlyCallProps('initHealthCheck').get(TICK_LATCHED)).toMatch(query)
    // b.jg5 SRJ-502: the reconnect adapter asks it right before typing /mcp reconnect.
    const [lookup, adapterQuery, ...extra] = reconnectAdapterArgs()
    expect([lookup, extra]).toEqual(['getAppliedPersona', []])
    expect(adapterQuery).toMatch(query)

    // b.jg5 SRJ-1011: the persona routing, built at module scope before the
    // latch exists, reads it through its holder, whose one assignment is this
    // same latch (no second latch, no copy; see routingHolder). The
    // tmux-unavailable retry check's production deps read the same holder
    // once, for the key they are given.
    routingHolder(ROUTING_LATCHED, IS_LATCHED, latch, [CHECK_LATCHED])

    // No other latched member or query anywhere in server.ts: one member
    // inside each of the three calls in main(), one inside the module-scope
    // routing's call and one in the retry check's production deps, and one
    // query inside each of the three calls, the reconnect adapter's build
    // (the one inside the restart module's call), the routing's call and the
    // retry check's deps, which the check itself asks once (its `deps`
    // parameter's, b.jg5 SRJ-311). Outside main(), `isLatched:` is otherwise only a
    // parameter's type annotation (the reconnect adapter's latched gate), no
    // binding.
    const within = withinCall
    // The retry action's member and query sit in the retry run's gate, which
    // the action spreads (b.jg5 SRJ-404; see the gate's describe).
    const allMembers = indicesOf(new RegExp(`\\b${IS_LATCHED}\\s*:`, 'g'), SERVER_CODE)
    const members = allMembers.filter(insideMain)
    expect(members).toHaveLength(3)
    expect(['createFullModeRetryAction', 'initRestart', 'initHealthCheck'].map((call) => within(members, onlyCallOf(call)))).toEqual([0, 1, 1])
    expect(withinRetryRunGate(members)).toBe(1)
    const outside = allMembers.filter((offset) => !insideMain(offset))
    const check = retryCheckDeps()
    const inCheck = (offsets: number[]) => offsets.filter((offset) => offset > check.start && offset < check.end).length
    expect(outside).toHaveLength(3)
    expect(within(outside, onlyCallOf('createPersonaRouting'))).toBe(1)
    expect(inCheck(outside)).toBe(1)
    expect(within(outside, SERVER_CODE.search(/\bfunction\s+reconnectLatchedAt\s*\(/))).toBe(1)
    const queries = indicesOf(new RegExp(`\\.\\s*${IS_LATCHED}\\s*\\(`, 'g'), SERVER_CODE)
    expect(queries).toHaveLength(7)
    expect(['createFullModeRetryAction', 'initRestart', 'initHealthCheck', 'createPersonaRouting'].map((call) => within(queries, onlyCallOf(call)))).toEqual([0, 2, 1, 1])
    expect(withinRetryRunGate(queries)).toBe(1)
    expect(within(queries, onlyReconnectAdapterBuild())).toBe(1)
    expect(inCheck(queries)).toBe(1)
    const CHECK: keyof typeof ServerModule = 'armMissingTmuxUnavailableRetry'
    const [checkStart, checkEnd] = exportedFunctionBody(CHECK)
    expect(queries.filter((offset) => offset > checkStart && offset < checkEnd)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-505 — the latch re-check
//
// Nothing in the type system makes main() build the re-check, build it once,
// over the one latch and the one persona serializer, bind it (its set
// observer arms a persona's timer at a new latch; its forget observer stops
// the timer at a teardown's forget), bind it after the holds and the notice
// (set observers run in the order they are added), before the start pass (a
// launch there can latch), or stop it at shutdown before the client is
// released. A wiring that dropped, doubled or reordered any of these would
// type-check and pass every behaviour suite while a latched persona was never
// looked at again, its rounds ran on a second serializer beside the
// lifecycle's (overlapping a teardown or a restart), or a round fired during
// shutdown. What the re-check does is tested in tests/conflict-latch.test.ts,
// tests/session-manager.test.ts and tests/restart.test.ts; pinned here: the
// build, its input, the binding, the holder and the shutdown stop.
// ---------------------------------------------------------------------------

describe('main() builds the latch re-check once, through the session manager\'s builder over the one latch, the system clock and the one persona serializer, binds it after the latch\'s holds and CONFLICT notice and before the start pass, and shutdown stops every re-check timer before the client is released (b.jg5 SRJ-505)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const BIND_NOTICE: keyof typeof ConflictLatchModule = 'bindConflictNotice'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const CONTROLLER_FACTORY: keyof typeof ConflictLatchModule = 'createLatchRecheckController'
  const CLEAR: keyof typeof ConflictLatchModule = 'createLatchClear'
  const ROUND: keyof typeof SessionManagerModule = 'runLatchRecheckRound'
  const CLEAR_SEQUENCE: keyof typeof SessionManagerModule = 'runLatchClearSequence'
  const IN_TURN: keyof typeof RestartModule = 'runRestartWorkInTurn'
  const RETRY_IN_TURN: keyof typeof RestartModule = 'runRestartRetryInTurn'
  const HOLD_ACTIVE: keyof typeof RestartModule = 'holdRestartActive'
  const ADD_SET: keyof ConflictLatch = 'addSetObserver'
  const ADD_FORGET: keyof ConflictLatch = 'addForgetObserver'
  const STOP_ALL: keyof LatchRecheckController = 'stopAll'
  const STOP: keyof LatchRecheckController = 'stop'
  const ARM: keyof LatchRecheckController = 'arm'
  const CLOCK: keyof LatchRecheckInput = 'clock'
  const SERIALIZE: keyof LatchRecheckInput = 'serialize'
  const APPLIED_CONFIG: keyof LatchRecheckInput = 'appliedConfig'
  const LOG: keyof LatchRecheckInput = 'log'
  const EPISODES: keyof LatchRecheckInput = 'episodes'

  /** The module-scope holder shutdown() stops: the one `let <name>: LatchRecheckController | undefined`, outside main(). */
  function holder(): string {
    const decls = [...SERVER_CODE.matchAll(/^let\s+(\w+)\s*:\s*LatchRecheckController\s*\|\s*undefined\s*$/gm)]
    expect(decls).toHaveLength(1)
    expect(insideMain(decls[0]!.index!)).toBe(false)
    declaredOnce(decls[0]![1]!)
    return decls[0]![1]!
  }

  test('the re-check is built exactly once, by the session manager\'s builder, bound to a const in main()\'s own statement list (not at module scope, behind no branch), after the latch, the notice episodes and both the holds\' and the notice\'s bindings, and before the start pass; server.ts declares neither name and builds no re-check controller, round, clear entry, after-clear sequence, in-turn run or in-turn retry, nor holds a persona active, of its own (b.jg5 SRJ-506: the clear is the builder\'s)', () => {
    expect(importSource(SERVER_CODE, RECHECK_BUILDER)).toBe('./session-manager.ts')
    for (const name of [RECHECK_BUILDER, RECHECK_BIND]) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    // The composition lives in the builder only, so main() and the recovery harness run the same re-check.
    for (const name of [CONTROLLER_FACTORY, CLEAR, ROUND, CLEAR_SEQUENCE, IN_TURN, RETRY_IN_TURN, HOLD_ACTIVE]) {
      expect([name, indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    // Named only at its import and the one call.
    expect(indicesOf(new RegExp(`\\b${RECHECK_BUILDER}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
    const at = onlyCallOf(RECHECK_BUILDER)
    const recheck = constOf(RECHECK_BUILDER)
    declaredOnce(recheck)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${recheck}\\s*=\\s*${RECHECK_BUILDER}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)

    for (const earlier of [LATCH_FACTORY, EPISODES_FACTORY, BIND_LATCH_HOLDS, BIND_NOTICE]) {
      expect([earlier, at > onlyCallOf(earlier)]).toEqual([earlier, true])
    }
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
  })

  test('its input is exactly the one latch, the system clock, the one persona lifecycle serializer\'s run (the restart module\'s too, so a round never overlaps a teardown, a bring-up or a restart for the persona), the applied configuration read at each round, the server log and the one notice episodes instance', () => {
    const props = onlyCallProps(RECHECK_BUILDER)
    expect([...props.keys()].sort()).toEqual([APPLIED_CONFIG, CLOCK, EPISODES, RECHECK_LATCH, LOG, SERIALIZE].sort())
    expect(props.get(RECHECK_LATCH)).toBe(constOf(LATCH_FACTORY))
    expect(props.get(CLOCK)).toBe('SYSTEM_PERSONA_CONNECTION_CLOCK')
    expect(importSource(SERVER_CODE, 'SYSTEM_PERSONA_CONNECTION_CLOCK')).toBe('./persona-connections.ts')
    const serialize = `${constOf('createPersonaSerializer')}.run`
    expect(props.get(SERIALIZE)).toBe(serialize)
    expect(onlyCallProps('initRestart').get('serialize')).toBe(serialize)
    expect(props.get(APPLIED_CONFIG)).toBe(`() => ${loadedConfigName(SERVER_CODE)}`)
    expect(props.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    expect(props.get(EPISODES)).toBe(constOf(EPISODES_FACTORY))
  })

  test('it is bound exactly once, in main()\'s own statement list, to the one latch, after its build with no await between, after the holds\' and the notice\'s bindings (so a set runs the holds, the notice, then the timer\'s arm) and before the start pass; server.ts adds no set or forget observer by hand', () => {
    const at = onlyCallOf(RECHECK_BIND)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(importSource(SERVER_CODE, RECHECK_BIND)).toBe('./conflict-latch.ts')
    expect(onlyCallArgs(RECHECK_BIND)).toEqual([constOf(LATCH_FACTORY), constOf(RECHECK_BUILDER)])
    // Named only at its import and the one call.
    expect(indicesOf(new RegExp(`\\b${RECHECK_BIND}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)

    const built = onlyCallOf(RECHECK_BUILDER)
    expect(at).toBeGreaterThan(built)
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(built, at))).toEqual([])
    expect(at).toBeGreaterThan(onlyCallOf(BIND_LATCH_HOLDS))
    expect(at).toBeGreaterThan(onlyCallOf(BIND_NOTICE))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)

    expect(indicesOf(new RegExp(`\\.\\s*(?:${ADD_SET}|${ADD_FORGET})\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the re-check is named only at its build, the holder\'s one assignment and its binding (the health tick, the restart module and the retry controller are not handed it); the holder is assigned it once, in main()\'s own statement list after the build, and named only at its declaration, that assignment and shutdown\'s stop', () => {
    const recheck = constOf(RECHECK_BUILDER)
    const named = indicesOf(new RegExp(`\\b${recheck}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(3)
    expect(withinCall(named, onlyCallOf(RECHECK_BIND))).toBe(1)
    for (const call of ['initHealthCheck', 'initRestart', 'createUnavailableRetryController']) {
      expect([call, withinCall(named, onlyCallOf(call))]).toEqual([call, 0])
    }

    const name = holder()
    const assigned = assignmentsTo(name)
    expect(assigned.map((a) => a.value)).toEqual([recheck])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    expect(assigned[0]!.at).toBeGreaterThan(onlyCallOf(RECHECK_BUILDER))
    expect(indicesOf(new RegExp(`(?<![\\w.$])${name}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
  })

  test('shutdown() stops every re-check timer exactly once, through the holder, with no argument, after the shutting-down flag is raised, before it first yields and before closeClient(); nothing else in server.ts stops, or arms, a re-check timer', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const inShutdown = (offset: number) => offset > start && offset < end
    const name = holder()
    const stops = indicesOf(new RegExp(`(?<![\\w.$])${name}\\s*\\?\\.\\s*${STOP_ALL}\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(stops).toHaveLength(1)
    const at = stops[0]!
    expect(inShutdown(at)).toBe(true)
    const recheck = constOf(RECHECK_BUILDER)
    expect(indicesOf(new RegExp(`\\b(?:${name}|${recheck})\\s*[?!]?\\.\\s*(?:${STOP_ALL}|${STOP}|${ARM})\\s*\\(`, 'g'), SERVER_CODE)).toEqual([at])

    const raises = indicesOf(/(?<![\w.$])shuttingDown\s*=\s*true\b/g, SERVER_CODE)
    expect(raises).toHaveLength(1)
    expect(at).toBeGreaterThan(raises[0]!)
    const firstAwait = SERVER_CODE.slice(start, end).search(/\bawait\b/)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(at).toBeLessThan(start + firstAwait)
    const clientCloses = indicesOf(/(?<![\w.$])closeClient\s*\(/g, SERVER_CODE).filter(inShutdown)
    expect(clientCloses).toHaveLength(1)
    expect(at).toBeLessThan(clientCloses[0]!)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-610 / SRJ-1010 / SRJ-1016 / SRJ-502 — the one
// slow-recovery tracker
//
// `RestartDeps.slowRecovery`, `HealthCheckDeps.resetSlowRecoveryCount` and
// `ConflictLatchHolds.endSlowRecovery` are optional, and absent the restart
// work, the health check and the latch behave the same. So a production
// wiring that dropped any binding, built a second tracker (one the restart
// work counts on, another the health check resets or the latch ends), built
// it over episodes
// other than the one instance (which a teardown never forgets and shutdown
// never closes, so its count and episode would outlive the persona), or built
// it after the start pass would type-check and pass every behaviour suite
// while no slow-recovery notice was ever posted, a persona healed between
// ticks kept its count, or a latch left P's episode open. What the tracker does is tested in tests/slow-recovery.test.ts and
// tests/restart.test.ts, its healthy reset's call in
// tests/health-check.test.ts, and its latch end in
// tests/conflict-latch.test.ts; pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() builds the one slow-recovery tracker over the notice episodes before the start pass, hands it to the restart work as its slow-recovery observer, binds its healthy reset into the health check and its latch end into the latch\'s holds (b.jg5 SRJ-610, SRJ-1010, SRJ-1016, SRJ-502)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof SlowRecoveryModule = 'createSlowRecoveryTracker'
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const EPISODES: keyof SlowRecoveryTrackerDeps = 'episodes'
  const LOG: keyof SlowRecoveryTrackerDeps = 'log'
  const OBSERVER: keyof RestartDeps = 'slowRecovery'
  const LATCH_END: keyof SlowRecoveryTracker = 'endForLatch'
  const HEALTHY_RESET: keyof SlowRecoveryTracker = 'noteHealthy'
  const TICK_RESET: keyof HealthCheckDeps = 'resetSlowRecoveryCount'
  /** Every other entry of the tracker: the restart work's notes and the read-only queries. */
  const OTHER_ENTRIES: ReadonlyArray<keyof SlowRecoveryTracker> = ['noteLive', 'noteDead', 'noteInstallGone', 'noteOther', 'count', 'isOpen']
  const INSTALL: keyof typeof SessionManagerModule = 'setConflictLatch'

  test('the tracker is built exactly once, in main()\'s own statement list (not at module scope, behind no branch), from the slow-recovery module, after the notice episodes and before the restart module and the start pass, with no await between the latch\'s install and its build', () => {
    const at = onlyCallOf(FACTORY)
    const tracker = constOf(FACTORY)
    declaredOnce(tracker)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${tracker}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    expect(importSource(SERVER_CODE, FACTORY)).toBe('./slow-recovery.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${FACTORY}\\b`, 'g'), SERVER_CODE)).toEqual([])

    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
    // The latch's hold names the tracker before its declaration, as a call-time
    // read: nothing may yield between the latch's install and the tracker's
    // build, so no latch is set before the hold's target exists.
    const install = onlyCallOf(INSTALL)
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(Math.min(install, at), Math.max(install, at)))).toEqual([])
  })

  test('its dependencies are exactly the one notice episodes instance, which holds its count and episode, and the server log', () => {
    const props = onlyCallProps(FACTORY)
    expect([...props.keys()].sort()).toEqual([EPISODES, LOG].sort())
    expect(props.get(EPISODES)).toBe(constOf(EPISODES_FACTORY))
    expect(props.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
  })

  test('the restart module\'s slow-recovery observer is this tracker, by name', () => {
    expect(onlyCallProps('initRestart').get(OBSERVER)).toBe(constOf(FACTORY))
  })

  test('the health check\'s slow-recovery reset hook calls this tracker\'s healthy reset for the persona it is given', () => {
    expect(onlyCallProps('initHealthCheck').get(TICK_RESET)).toMatch(oneKeyArrow(`${constOf(FACTORY)}\\.${HEALTHY_RESET}\\(\\1\\)`))
  })

  test('the latch\'s slow-recovery hold calls this tracker\'s latch end for the persona it is given', () => {
    expect(latchHoldProps().get(HOLD_END_SLOW_RECOVERY)).toMatch(oneKeyArrow(`${constOf(FACTORY)}\\.${LATCH_END}\\(\\1\\)`))
  })

  test('the tracker is named only at its build, in the restart module\'s call, in the health check\'s call and in the latch\'s holds; server.ts calls its healthy reset once, its latch end once and none of its other entries (the restart work tells it each run), and no other file under src/ builds one', () => {
    const tracker = constOf(FACTORY)
    const named = indicesOf(new RegExp(`\\b${tracker}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(4)
    const decl = SERVER_CODE.match(new RegExp(`\\bconst\\s+${tracker}\\b`))!
    expect(named).toContain(decl.index! + decl[0].length - tracker.length)
    const within = (call: string) => {
      const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf(call), '(', ')')
      return named.filter((offset) => offset > open && offset < close).length
    }
    expect([within('initRestart'), within('initHealthCheck'), within(BIND_LATCH_HOLDS)]).toEqual([1, 1, 1])

    const calls = (entry: string) => indicesOf(new RegExp(`\\.\\s*${entry}\\s*\\(`, 'g'), SERVER_CODE)
    expect(indicesOf(new RegExp(`\\b${tracker}\\s*[?!]?\\.\\s*${LATCH_END}\\s*\\(`, 'g'), SERVER_CODE)).toHaveLength(1)
    expect(calls(LATCH_END)).toHaveLength(1)
    expect(indicesOf(new RegExp(`\\b${tracker}\\s*[?!]?\\.\\s*${HEALTHY_RESET}\\s*\\(`, 'g'), SERVER_CODE)).toHaveLength(1)
    expect(calls(HEALTHY_RESET)).toHaveLength(1)
    expect(OTHER_ENTRIES.filter((entry) => indicesOf(new RegExp(`\\b${tracker}\\s*[?!]?\\.\\s*${entry}\\b`, 'g'), SERVER_CODE).length > 0)).toEqual([])

    const builders = srcFiles().filter(([, text]) => new RegExp(`\\b${FACTORY}\\s*\\(`).test(stripComments(text)))
    expect(builders.map(([path]) => path).sort()).toEqual(['src/server.ts', 'src/slow-recovery.ts'])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-1016 / SRJ-1017 / SRJ-502 — the stuck-launch
// episode's production bindings
//
// The session manager's install is optional (absent, no own-row read ever
// ends a stuck-launch episode) and so is `ConflictLatchHolds.endStuckLaunch`
// (absent, a latch leaves the episode open), and any episodes object
// type-checks as either's target. So a production wiring that dropped
// either, bound it to episodes other than the one notice episodes instance
// (whose posts the episode counts, and which a teardown forgets and shutdown
// closes), installed it after the start sweep or the start pass, or removed
// it would type-check and pass every behaviour suite while a persona's
// stuck-launch episode never ended. What the end does is tested in
// tests/session-manager.test.ts and tests/server.test.ts (the reads) and
// tests/conflict-latch.test.ts (the latch); pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() installs the one notice episodes instance in the session manager for the stuck-launch episode before the start sweep and the start pass, and binds the latch\'s stuck-launch hold to end that episode over the same instance (b.jg5 SRJ-1016, SRJ-1017, SRJ-502)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const EPISODES_FACTORY: keyof typeof PersonaEpisodesModule = 'createPersonaEpisodes'
  const INSTALL: keyof typeof SessionManagerModule = 'setStuckLaunchEpisodes'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const LATCH_END: keyof typeof PendingRowModule = 'endStuckLaunchEpisodeForLatch'

  test('the episodes are installed exactly once (nothing removes them), in main()\'s own statement list, with exactly the one notice episodes instance, after its build and before the start sweep and the start pass; the install is the session manager\'s import', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(onlyCallArgs(INSTALL)).toEqual([constOf(EPISODES_FACTORY)])
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])

    expect(at).toBeGreaterThan(onlyCallOf(EPISODES_FACTORY))
    for (const later of [onlyCallOf(START_SWEEP), ...latchStartPass()]) expect(at).toBeLessThan(later)
  })

  test('the latch\'s stuck-launch hold ends the persona\'s episode through endStuckLaunchEpisodeForLatch over the one notice episodes instance, for the key it is given, with the server log', () => {
    const hold = latchHoldProps().get(HOLD_END_STUCK_LAUNCH)!
    const shape = hold.match(oneKeyArrow(`${LATCH_END}\\(.*\\)`))
    expect(shape).not.toBeNull()
    const [episodes, key, log, ...extra] = splitTopLevel(onlyCallArguments(hold, LATCH_END))
    expect([episodes, key, extra]).toEqual([constOf(EPISODES_FACTORY), shape![1]!, []])
    expect(log).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
  })

  test('endStuckLaunchEpisodeForLatch is the pending-row module\'s import, declared nowhere in server.ts, and called once, inside the latch\'s holds binding', () => {
    expect(importSource(SERVER_CODE, LATCH_END)).toBe('./pending-row.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${LATCH_END}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(withinCall([onlyCallOf(LATCH_END)], onlyCallOf(BIND_LATCH_HOLDS))).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-207 / SRJ-1008 / SRJ-305 / SRJ-303 / SRJ-315 /
// SRJ-204 — the ErrInvalidFlags hold's production bindings
//
// The session manager's hold install, the held queries of the retry action,
// the restart work and the health tick, and the routing's cannot-launch
// member are all optional: absent, no persona is held (a reuse spawn's
// ErrInvalidFlags still answers `held`, but nothing holds the persona back,
// so the next tick, retry or restart calls agent-director again), and a
// hold's set reaction and version-change reaction take any body. A
// production wiring that dropped one, bound it twice, to a second hold, to
// the condition-end entry (whose SRJ-306 exceptions must not apply to a
// hold), registered no version-changed listener (a hold that never ends) or
// two (two retries), installed the hold after the start pass, or seeded it
// from anywhere (a hold that survives a restart) would type-check and pass
// every behaviour suite. What each does is tested in
// tests/ad-version-gate.test.ts, tests/session-manager.test.ts,
// tests/restart.test.ts, tests/unavailable-retry.test.ts,
// tests/health-check.test.ts and tests/inbound-recovery-drop-branch.test.ts;
// pinned here: the bindings. The routing's member is pinned in the routing's
// describe below; the teardown's forget in tests/reload-wiring.test.ts.
// ---------------------------------------------------------------------------

describe('main() builds the one ErrInvalidFlags hold before the start pass, installs it in the session manager, binds its set reaction to the retry controller\'s stop entry and the notice episodes, ends it on the one version-changed listener, binds its held query into the retry action, the restart work and the health tick, and shutdown forgets every hold (b.jg5 SRJ-207, SRJ-1008, SRJ-305, SRJ-303, SRJ-315, SRJ-204)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const FACTORY: keyof typeof InvalidFlagsHoldModule = 'createInvalidFlagsHold'
  const BIND_SET: keyof typeof InvalidFlagsHoldModule = 'bindInvalidFlagsHoldSetReaction'
  const REACTION_FACTORY: keyof typeof InvalidFlagsHoldModule = 'createInvalidFlagsHoldSetReaction'
  const VERSION_CHANGE: keyof typeof InvalidFlagsHoldModule = 'endInvalidFlagsHoldsOnVersionChange'
  const LOG: keyof InvalidFlagsHoldDeps = 'log'
  const SET_STOP: keyof InvalidFlagsHoldSetReactionDeps = 'stopRetryTimer'
  const SET_EPISODES: keyof InvalidFlagsHoldSetReactionDeps = 'episodes'
  const SET_LOG: keyof InvalidFlagsHoldSetReactionDeps = 'log'
  const VC_EPISODES: keyof InvalidFlagsHoldVersionChangeDeps = 'episodes'
  const VC_APPLIED: keyof InvalidFlagsHoldVersionChangeDeps = 'isApplied'
  const VC_RETRY: keyof InvalidFlagsHoldVersionChangeDeps = 'retryAtOnce'
  const VC_LOG: keyof InvalidFlagsHoldVersionChangeDeps = 'log'
  const IS_HELD: keyof InvalidFlagsHold = 'isHeld'
  const SET: keyof InvalidFlagsHold = 'set'
  const VERSION_CHANGED: keyof InvalidFlagsHold = 'versionChanged'
  const FORGET_ALL: keyof InvalidFlagsHold = 'forgetAll'
  const ADD_SET_OBSERVER: keyof InvalidFlagsHold = 'addSetObserver'
  const ADD_END_OBSERVER: keyof InvalidFlagsHold = 'addEndObserver'
  const RETRY_HELD: keyof FullModeRetryDeps = 'isHeld'
  const RESTART_HELD: keyof RestartDeps = 'isHeld'
  const TICK_HELD: keyof HealthCheckDeps = 'isHeld'
  const ROUTING_HELD: keyof PersonaRoutingDeps = 'isHeldOnInvalidFlags'
  const STOP: keyof UnavailableRetryController = 'stop'
  const STOP_HELD: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_STOP_HELD'
  const INSTALL: keyof typeof SessionManagerModule = 'setInvalidFlagsHold'
  const RESET: keyof typeof SessionManagerModule = '_resetInvalidFlagsHold'
  const ON_CHANGED: keyof typeof AdVersionGateModule = 'onAdVersionChanged'
  const RETRY_ENTRY: keyof typeof RestartModule = 'runRestartRetry'
  const HOLD_PATH = join(SRC_DIR, 'invalid-flags-hold.ts')

  /** `name` is imported from `module` and declared nowhere in server.ts. */
  function importedOnly(name: string, module: string): void {
    expect(importSource(SERVER_CODE, name)).toBe(module)
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)).toEqual([])
  }

  /** The routing member's module-scope holder (its form and assignment are pinned in the routing's describe). */
  function holderName(): string {
    return onlyCallProps('createPersonaRouting').get(ROUTING_HELD)!.match(new RegExp(`=> (\\w+)\\?\\.${IS_HELD}\\(`))![1]!
  }

  test('the hold is built exactly once, in main()\'s own statement list, its only dependency the server log, and installed in the session manager exactly once (nothing uninstalls it), after its build and its set reaction\'s binding and before the retry controller, initRestart, the start bring-up and initHealthCheck', () => {
    const at = onlyCallOf(FACTORY)
    const hold = constOf(FACTORY)
    declaredOnce(hold)
    const decl = SERVER_CODE.search(new RegExp(`\\bconst\\s+${hold}\\s*=\\s*${FACTORY}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    importedOnly(FACTORY, './invalid-flags-hold.ts')
    const props = onlyCallProps(FACTORY)
    expect([...props.keys()]).toEqual([LOG])
    expect(props.get(LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)

    const install = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, install)).toBe(true)
    importedOnly(INSTALL, './session-manager.ts')
    expect(onlyCallArgs(INSTALL)).toEqual([hold])
    expect(install).toBeGreaterThan(at)
    expect(install).toBeGreaterThan(onlyCallOf(BIND_SET))
    for (const later of latchStartPass()) expect(install).toBeLessThan(later)
    expect(callsOf(RESET)).toEqual([])
  })

  test('its set reaction is bound exactly once, in main()\'s own statement list after the build and before the start pass, to the one hold: it stops the persona\'s timer on the one retry controller through its stop entry with the hold\'s own reason, never through the condition-end entry, and posts through the one notice episodes instance, with the server log; server.ts builds no reaction by hand and adds no hold observer (b.jg5 SRJ-305, SRJ-1008, SRJ-1016)', () => {
    const at = onlyCallOf(BIND_SET)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    importedOnly(BIND_SET, './invalid-flags-hold.ts')
    const args = onlyCallArgs(BIND_SET)
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(constOf(FACTORY))
    expect(at).toBeGreaterThan(onlyCallOf(FACTORY))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)

    const props = objectProperties(args[1]!)
    expect([...props.keys()].sort()).toEqual([SET_STOP, SET_EPISODES, SET_LOG].sort())
    const controller = constOf('createUnavailableRetryController')
    declaredOnce(controller)
    expect(props.get(SET_STOP)).toMatch(oneKeyArrow(`${controller}\\.${STOP}\\(\\1, ${STOP_HELD}\\)`))
    expect(props.get(SET_STOP)).not.toContain('conditionEnded')
    expect(props.get(SET_EPISODES)).toBe(constOf('createPersonaEpisodes'))
    expect(props.get(SET_LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    importedOnly(STOP_HELD, './unavailable-retry.ts')
    // The hold's reason is named only by its import and this binding.
    expect(indicesOf(new RegExp(`\\b${STOP_HELD}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)

    expect(callsOf(REACTION_FACTORY)).toEqual([])
    for (const add of [ADD_SET_OBSERVER, ADD_END_OBSERVER]) {
      expect([add, indicesOf(new RegExp(`\\b${constOf(FACTORY)}\\s*[?!]?\\.\\s*${add}\\b`, 'g'), SERVER_CODE)]).toEqual([add, []])
    }
  })

  // The reaction names the retry controller, built after the hold is
  // installed: a set before it exists would throw (and be logged) and leave
  // the timer running. Only a launch can hold, and none starts before main()
  // first yields.
  test('no statement awaits between the hold\'s install and the retry controller\'s build', () => {
    const install = onlyCallOf(INSTALL)
    const built = onlyCallOf('createUnavailableRetryController')
    expect(built).toBeGreaterThan(install)
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(install, built))).toEqual([])
  })

  test('exactly one version-changed listener is registered (onAdVersionChanged), in main()\'s own statement list after the hold is built and before the start bring-up: it ends the one hold\'s holds on the new version through the version-change reaction, ending each episode on the one notice episodes instance, asking the live applied-persona lookup, and retrying each ended persona at once through the restart module\'s retry entry with "blocks a retry" (b.jg5 SRJ-204, SRJ-207)', () => {
    const hold = constOf(FACTORY)
    const at = onlyCallOf(ON_CHANGED)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    importedOnly(ON_CHANGED, './ad-version-gate.ts')
    expect(at).toBeGreaterThan(onlyCallOf(FACTORY))
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)

    // One listener, whose whole body is the version-change reaction over the
    // one hold and the listener's new version (its second parameter).
    const listener = onlyCallArgs(ON_CHANGED)
    expect(listener).toHaveLength(1)
    const form = listener[0]!.match(new RegExp(`^\\((\\w+), (\\w+)\\) => \\{ ${VERSION_CHANGE}\\(([\\s\\S]*)\\);? \\}$`))
    expect(form).not.toBeNull()
    expect(withinCall([onlyCallOf(VERSION_CHANGE)], at)).toBe(1)
    importedOnly(VERSION_CHANGE, './invalid-flags-hold.ts')
    const args = onlyCallArgs(VERSION_CHANGE)
    expect(args).toHaveLength(3)
    expect([args[0], args[1]]).toEqual([hold, form![2]])

    const props = objectProperties(args[2]!)
    expect([...props.keys()].sort()).toEqual([VC_EPISODES, VC_APPLIED, VC_RETRY, VC_LOG].sort())
    expect(props.get(VC_EPISODES)).toBe(constOf('createPersonaEpisodes'))
    expect(props.get(VC_APPLIED)).toMatch(/^\(?(\w+)\)? => getAppliedPersona\(\1\) !== undefined$/)
    expect(props.get(VC_LOG)).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)
    // Retried at once: the restart module's retry entry (no delay gate) for
    // the key, in the applied persona's working directory, with "blocks a
    // retry" and its cause query (so a skip line names what blocks it), only
    // while the persona is applied.
    const { retryBlocked } = inFlightBindings()
    const retry = props.get(VC_RETRY)!
    expect(retry).toMatch(
      new RegExp(
        `^\\(?(\\w+)\\)? => \\{ const (\\w+) = getAppliedPersona\\(\\1\\);? if \\(\\2 === undefined\\) return undefined;? ` +
          `return ${RETRY_ENTRY}\\(\\1, \\2\\.working_directory, ${retryBlocked}, ${RETRY_BLOCK_CAUSE}\\)`,
      ),
    )
    expect(indicesOf(new RegExp(`\\b${RETRY_ENTRY}\\s*\\(`, 'g'), retry)).toHaveLength(1)
    importedOnly(RETRY_ENTRY, './restart.ts')

    // The reaction is the hold's only end on a version change: nothing else
    // calls it, and server.ts asks no hold's versionChanged itself.
    expect(indicesOf(new RegExp(`\\.\\s*${VERSION_CHANGED}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the held query is bound exactly once into each of the full-mode retry action, the restart work and the health tick, as a call-time read of the one hold\'s isHeld for the key it is given; with the routing\'s member (through its holder) these are server.ts\'s only held members and queries (b.jg5 SRJ-303, SRJ-315)', () => {
    const hold = constOf(FACTORY)
    const query = oneKeyArrow(`${hold}\\.${IS_HELD}\\(\\1\\)`)
    expect(onlyCallProps('createFullModeRetryAction').get(RETRY_HELD)).toMatch(query)
    expect(onlyCallProps('initRestart').get(RESTART_HELD)).toMatch(query)
    expect(onlyCallProps('initHealthCheck').get(TICK_HELD)).toMatch(query)

    // The retry action's member and query sit in the retry run's gate, which
    // the action spreads (b.jg5 SRJ-404; see the gate's describe).
    const members = indicesOf(new RegExp(`\\b${IS_HELD}\\s*:`, 'g'), SERVER_CODE)
    expect(members).toHaveLength(3)
    expect(['createFullModeRetryAction', 'initRestart', 'initHealthCheck'].map((call) => withinCall(members, onlyCallOf(call)))).toEqual([0, 1, 1])
    expect(withinRetryRunGate(members)).toBe(1)
    const queries = indicesOf(new RegExp(`\\.\\s*${IS_HELD}\\s*\\(`, 'g'), SERVER_CODE)
    expect(queries).toHaveLength(4)
    expect(['createFullModeRetryAction', 'initRestart', 'initHealthCheck', 'createPersonaRouting'].map((call) => withinCall(queries, onlyCallOf(call)))).toEqual([0, 1, 1, 1])
    expect(withinRetryRunGate(queries)).toBe(1)
    expect(indicesOf(new RegExp(`\\b${ROUTING_HELD}\\s*:`, 'g'), SERVER_CODE)).toHaveLength(1)
  })

  test('shutdown forgets every hold exactly once, through the routing\'s holder of the one hold; nothing else in server.ts forgets them all', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const holder = holderName()
    const forgets = indicesOf(new RegExp(`\\b${holder}\\s*\\?\\.\\s*${FORGET_ALL}\\s*\\(\\s*\\)`, 'g'), SERVER_CODE)
    expect(forgets).toHaveLength(1)
    expect(forgets[0]! > start && forgets[0]! < end).toBe(true)
    expect(indicesOf(new RegExp(`\\b(?:${holder}|${constOf(FACTORY)})\\s*[?!]?\\.\\s*${FORGET_ALL}\\b`, 'g'), SERVER_CODE)).toEqual(forgets)
  })

  test('nothing loads a hold: server.ts never sets one, the instance is named only at its build, its set reaction\'s binding, its install, the routing holder\'s assignment, the version-change reaction, its three held queries and the teardown\'s forget, and the hold module imports no file-system module (a server restart holds nothing)', () => {
    const hold = constOf(FACTORY)
    expect(indicesOf(new RegExp(`\\b${hold}\\s*[?!]?\\.\\s*${SET}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${holderName()}\\s*[?!]?\\.\\s*${SET}\\s*\\(`, 'g'), SERVER_CODE)).toEqual([])

    const named = indicesOf(new RegExp(`\\b${hold}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(9)
    const decl = SERVER_CODE.match(new RegExp(`\\bconst\\s+${hold}\\b`))!
    expect(named[0]).toBe(decl.index! + decl[0].length - hold.length)
    const within = (call: string) => {
      const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf(call), '(', ')')
      return named.filter((offset) => offset >= open && offset < close).length
    }
    expect([BIND_SET, INSTALL, VERSION_CHANGE, 'createFullModeRetryAction', 'initRestart', 'initHealthCheck', 'createPersonaLifecycle'].map(within)).toEqual([1, 1, 1, 0, 1, 1, 1])
    // The retry action's held query sits in the retry run's gate, which it spreads.
    expect(withinRetryRunGate(named)).toBe(1)
    expect(onlyCallProps('createPersonaLifecycle').get('forgetInvalidFlagsHold')).toContain(`${hold}.`)
    // The ninth: the routing holder's one assignment, the bare hold.
    const assigned = assignmentsTo(holderName())
    expect(assigned.map((a) => a.value)).toEqual([hold])
    expect(named.filter((offset) => offset >= assigned[0]!.at && offset < assigned[0]!.at + holderName().length + hold.length + 4)).toHaveLength(1)

    const holdCode = stripComments(readFileSync(HOLD_PATH, 'utf-8'))
    expect(indicesOf(/\bfrom\s*['"](?:node:)?fs(?:\/promises)?['"]/g, holdCode)).toEqual([])
    expect(indicesOf(/\brequire\s*\(/g, holdCode)).toEqual([])
    expect(indicesOf(/\bBun\s*\.\s*file\s*\(/g, holdCode)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-1011 — the persona routing's lost-message state
// inputs
//
// Every lost-message input of `PersonaRoutingDeps` is optional and answers
// false when absent, so a production wiring that dropped one, bound it to a
// constant, to a second latch or condition, or to a copy taken at import
// (before main() builds the one instance, so it stays empty for good) would
// type-check and pass every behaviour suite while a message lost for a
// latched, not-answering or starting persona reported `starting-now` and
// fired a restart. The routing is built at module scope and the latch and the
// condition in main(), so each is read through a module-scope holder at call
// time. State 5's outage flags are read by the routing from the outage state
// itself, so they have no binding here. What the routing does with each input
// is tested in tests/inbound-recovery-drop-branch.test.ts,
// tests/dispatch-get-stream.test.ts and tests/lost-message.test.ts; pinned
// here: the bindings.
// ---------------------------------------------------------------------------

describe('server.ts binds the persona routing\'s lost-message state inputs to the one latch, the one tmux-unresponsive condition, the one kill-failure alerts\' episode or the old-life hold\'s kill-failed mark, and the session manager\'s launch-in-flight, approver-running and sequence-or-wait queries, each read at call time (b.jg5 SRJ-1011, SRJ-502, SRJ-307, SRJ-401, SRJ-704, SRJ-812)', () => {
  /** The session manager's old-life kill-failed query (b.jg5 SRJ-812); renaming it fails the typecheck. */
  const KILL_FAILED_HOLD: keyof typeof SessionManagerModule = 'waitsOnKillFailedHold'
  /** The session manager's sequence-or-wait query (b.jg5 SRJ-811, SRJ-1011); renaming it fails the typecheck. */
  const SEQUENCE_OR_WAIT: keyof typeof SessionManagerModule = 'isSequenceOrOldLifeWaitRunning'
  // Tied to src by type: renaming any of these fails the typecheck.
  const IS_LATCHED: keyof ConflictLatch = 'isLatched'
  const HOLDS: keyof TmuxUnresponsiveCondition = 'holds'
  const LAUNCH_RUNNING: keyof PersonaRoutingDeps = 'isLaunchOrApproverRunning'
  const KILL_FAILED: keyof PersonaRoutingDeps = 'isKillFailed'
  const IS_OPEN: keyof KillFailureAlerts = 'isOpen'
  /** The sequence/wait input (b.jg5 SRJ-706, SRJ-1011): a running live-row sequence (or an old-life wait step) reports `restarting`. */
  const SEQUENCE_WAIT: keyof PersonaRoutingDeps = 'isSequenceOrWaitRunning'
  /** The cannot-launch input (b.jg5 SRJ-207, SRJ-1011 state 3): P is held on ErrInvalidFlags. */
  const HELD_ON_INVALID_FLAGS: keyof PersonaRoutingDeps = 'isHeldOnInvalidFlags'
  const IS_HELD: keyof InvalidFlagsHold = 'isHeld'

  test('the latched query reads the one latch at call time, through a module-scope holder assigned that latch once in main(), before the start bring-up (state 2, held for a human)', () => {
    const latch = constOf(LATCH_FACTORY)
    declaredOnce(latch)
    const { at } = routingHolder(ROUTING_LATCHED, IS_LATCHED, latch, [CHECK_LATCHED])
    // After the latch is built (the one the collision ladder sets), and before
    // every path that can launch, and so latch.
    expect(at).toBeGreaterThan(onlyCallOf(LATCH_FACTORY))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
  })

  test('the tmux-unresponsive query reads the one condition\'s holds at call time, through a module-scope holder assigned that condition once in main(), before the start bring-up (state 5, not answering)', () => {
    const condition = constOf('createTmuxUnresponsiveCondition')
    declaredOnce(condition)
    const { at } = routingHolder(ROUTING_TMUX_UNRESPONSIVE, HOLDS, condition)
    expect(at).toBeGreaterThan(onlyCallOf('createTmuxUnresponsiveCondition'))
    // The holder's read is server.ts's only holds query: no second condition
    // or copy is asked anywhere.
    const holdsQueries = indicesOf(new RegExp(`\\.\\s*${HOLDS}\\s*\\(`, 'g'), SERVER_CODE)
    expect(holdsQueries).toHaveLength(1)
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaRouting'), '(', ')')
    expect(holdsQueries[0]! > open && holdsQueries[0]! < close).toBe(true)
  })

  // b.jg5 SRJ-1011 ruling ("two separate inputs"): state 6's input is a
  // launch call or the dialog approver that runs after it returned, in its own
  // registry (SRJ-401), each asked of the session manager for the key at call
  // time; it is neither named in-flight binding main() builds (see
  // inFlightBindings), which later Epics widen with work that must report
  // `restarting` instead. "In flight for P" is named in the routing's call
  // only as its read gate's in-flight member (see the read-gate describe
  // below), and "blocks a retry" not at all.
  test('the launch-or-approver query answers, for the key it is given, from the session manager\'s isLaunchInFlight and its isDialogApproverRunning, read at call time, separate from both in-flight bindings (state 6, starting)', () => {
    const binding = onlyCallProps('createPersonaRouting').get(LAUNCH_RUNNING)
    expect(binding).toBeDefined()
    const launch = `${LAUNCH_IN_FLIGHT}\\(\\1\\)`
    const approver = `${APPROVER_RUNNING}\\(\\1\\)`
    expect(binding).toMatch(new RegExp(`^\\(?(\\w+)\\)? => (?:${launch} \\|\\| ${approver}|${approver} \\|\\| ${launch})$`))
    // inFlightBindings also pins both queries to the session manager's
    // imports, declared nowhere in server.ts.
    const { retryBlocked, workInFlight } = inFlightBindings()
    const props = onlyCallProps('createPersonaRouting')
    const naming = (name: string) => [...props].filter(([, value]) => new RegExp(`\\b${name}\\b`).test(value)).map(([member]) => member)
    expect(naming(workInFlight)).toEqual([ROUTING_WORK_IN_FLIGHT])
    expect(naming(retryBlocked)).toEqual([])
    // The approver-running query is asked only here and in "in flight for P".
    const asked = indicesOf(new RegExp(`(?<![\\w.$])${APPROVER_RUNNING}\\s*\\(`, 'g'), SERVER_CODE)
    expect(asked).toHaveLength(2)
    expect(withinCall(asked, onlyCallOf('createPersonaRouting'))).toBe(1)
  })

  // b.jg5 SRJ-1011 state 4, SRJ-704 (E20), SRJ-812 (E27): P's kill-failure
  // episode is open, or P waits on an old-life hold whose old key's kill
  // failed. The alerts are built in main() over the notice episodes (pinned
  // in the kill-failure alerts' describe below); the routing reads their
  // episode through a holder assigned that one instance, never a second one
  // or a copy, and the hold's mark through the session manager's query, each
  // for the key it is given, at call time.
  test('the kill-failed query reads the one kill-failure alerts\' isOpen at call time, through a module-scope holder assigned that instance once in main(), after its build and before the start bring-up, or the session manager\'s old-life kill-failed query (state 4, kill failed)', () => {
    const alerts = constOf('createKillFailureAlerts')
    declaredOnce(alerts)
    const { at } = routingHolder(KILL_FAILED, IS_OPEN, alerts, [], [], KILL_FAILED_HOLD)
    expect(at).toBeGreaterThan(onlyCallOf('createKillFailureAlerts'))
    expect(importSource(SERVER_CODE, KILL_FAILED_HOLD)).toBe('./session-manager.ts')
    // Named in server.ts only at its import and this member.
    const named = indicesOf(new RegExp(`\\b${KILL_FAILED_HOLD}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(2)
    expect(withinCall(named, onlyCallOf('createPersonaRouting'))).toBe(1)
  })

  // b.jg5 SRJ-706, SRJ-811, SRJ-1011: the sequence/wait input is the session
  // manager's sequence-or-wait query for the key it is given, read at call
  // time (the registry, the hold set and the wait's bindings are installed in
  // main(), after the routing is built), never the bare sequence query (which
  // misses a wait step for a hold P waits on) nor the state-6
  // launch-or-approver member (whose exact form is pinned above).
  test('the sequence/wait query answers, for the key it is given, from the session manager\'s isSequenceOrOldLifeWaitRunning at call time; the state-6 launch-or-approver member does not include it', () => {
    const props = onlyCallProps('createPersonaRouting')
    expect(props.get(SEQUENCE_WAIT)).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${SEQUENCE_OR_WAIT}\\(\\1\\)$`))
    expect(props.get(LAUNCH_RUNNING)).not.toContain(SEQUENCE_OR_WAIT)
    expect(importSource(SERVER_CODE, SEQUENCE_OR_WAIT)).toBe('./session-manager.ts')
    // Named in server.ts only at its import and this member.
    expect(indicesOf(new RegExp(`\\b${SEQUENCE_OR_WAIT}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)
  })

  // b.jg5 SRJ-1011 state 3, SRJ-207: P is held on ErrInvalidFlags. The
  // hold is built in main() (pinned in the hold's describe above); the
  // routing reads it through a holder assigned that one instance, never a
  // second one or a copy. Shutdown's forget-all of every hold reads the same
  // holder, once, and nothing else does.
  test('the held-on-invalid-flags query reads the one ErrInvalidFlags hold\'s isHeld at call time, through a module-scope holder assigned that hold once in main(), after its build and before the start bring-up, and named elsewhere only by shutdown\'s forget-all (state 3, cannot launch)', () => {
    const hold = constOf('createInvalidFlagsHold')
    declaredOnce(hold)
    const { at } = routingHolder(HELD_ON_INVALID_FLAGS, IS_HELD, hold, [], [shutdownBody(SERVER_CODE)])
    expect(at).toBeGreaterThan(onlyCallOf('createInvalidFlagsHold'))
    for (const later of latchStartPass()) expect(at).toBeLessThan(later)
    // The member is named once in server.ts: in the routing's call.
    expect(indicesOf(new RegExp(`\\b${HELD_ON_INVALID_FLAGS}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
    // Every lost-message input is bound (each pinned above or in the read-gate describe below).
    const props = onlyCallProps('createPersonaRouting')
    for (const member of [ROUTING_LATCHED, ROUTING_TMUX_UNRESPONSIVE, LAUNCH_RUNNING, KILL_FAILED, ROUTING_WORK_IN_FLIGHT, ROUTING_ROW_READ, SEQUENCE_WAIT, HELD_ON_INVALID_FLAGS]) expect(props.has(member)).toBe(true)
  })

  // b.jg5 SRJ-1011 as amended ("state 5 applies only while P's retry timer is
  // armed"): `isRetryArmed` is optional, and absent the routing decides state
  // 5 without the armed-timer gate, so a wiring that dropped it, bound it to a
  // constant, to a copy of the controller taken at import (before main()
  // builds it) or to a second controller would type-check and pass every
  // behaviour suite while a persona whose retry timer stopped reported CSCB
  // retrying. What the routing does with it is tested in
  // tests/inbound-recovery-drop-branch.test.ts and through the recovery
  // harness in tests/unavailable-retry.test.ts; pinned here: the binding.
  test('the retry-timer query (isRetryArmed) reads the one retry controller\'s isArmed at call time, through its one module-scope handle (assigned that controller once, in main()), true only when it answers exactly true (state 5, not answering)', () => {
    const IS_ARMED: keyof UnavailableRetryController = 'isArmed'
    const ROUTING_RETRY_ARMED: keyof PersonaRoutingDeps = 'isRetryArmed'
    const handle = retryHandle()
    expect(onlyCallProps('createPersonaRouting').get(ROUTING_RETRY_ARMED)).toMatch(
      new RegExp(`^\\(?(\\w+)\\)? => ${handle}\\?\\.${IS_ARMED}\\(\\1\\) === true$`),
    )
    // The handle is the one controller, assigned once in main() (no copy, no second controller).
    const assigned = assignmentsTo(handle)
    expect(assigned.map((a) => a.value)).toEqual([constOf('createUnavailableRetryController')])
    expect(atMainTopLevel(SERVER_CODE, assigned[0]!.at)).toBe(true)
    // The routing's call names the handle only in this member.
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaRouting'), '(', ')')
    expect(indicesOf(new RegExp(`\\b${handle}\\b`, 'g'), SERVER_CODE.slice(open, close))).toHaveLength(1)
  })

  // A new routing input (one reading the unclassified-error episode, say)
  // fails here until it is pinned like the others.
  test('the routing\'s call binds exactly these members, no more', () => {
    const MEMBERS: Array<keyof PersonaRoutingDeps> = [
      'getPersonaConfig', 'getBotIdentity', 'clientFor', 'resolveUserName', 'archive', 'getReplySettings', 'notify', 'log',
      'isPersonaUp', ROUTING_LATCHED, ROUTING_TMUX_UNRESPONSIVE, LAUNCH_RUNNING, KILL_FAILED, ROUTING_WORK_IN_FLIGHT, ROUTING_ROW_READ,
      'isRetryArmed', 'armRetryTimerIfMissing', SEQUENCE_WAIT, HELD_ON_INVALID_FLAGS,
    ]
    expect([...onlyCallProps('createPersonaRouting').keys()].sort()).toEqual([...MEMBERS].sort())
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-1011, SRJ-115, SRJ-315 — the persona routing's
// lost-message read gate and its one row read
//
// Both members are optional: absent, nothing counts as in flight and no read
// is made. A wiring that dropped the read, or bound it to a copy taken at
// import (before main() builds the adapter), would type-check and pass every
// behaviour suite while a message lost on a `pending` row reported a later
// state and fired a restart over the row; one that bound the gate to a second
// in-flight predicate would read the row while work the retry timer and the
// health tick count as in flight runs, and miss what later Epics add to the
// shared one (E17, E21, E27); and one that built a second adapter, or called
// the client itself, would read the row outside the one adapter's raise and
// clear rules (E9, E11, E12) and what later Epics add there (E16, E24). The
// routing is built at module scope and the adapter in main(), so the read
// goes through a module-scope holder at call time. What the routing does with
// the read is tested in tests/persona-routing.test.ts and through the
// recovery harness's lost-message driver; pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('server.ts binds the persona routing\'s read gate to "in flight for P" and its one row read to the one liveness adapter main() builds, read at call time through a module-scope holder (b.jg5 SRJ-1011, SRJ-115, SRJ-315)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const ADAPTER: keyof typeof ServerModule = '_buildIsSessionAliveAdapter'
  const RESTART_ALIVE: keyof RestartDeps = 'isSessionAlive'
  const TICK_ALIVE: keyof HealthCheckDeps = 'isSessionAlive'
  const UNKNOWN: keyof typeof LivenessReadingModule = 'LIVENESS_READING_UNKNOWN'

  /** The offsets of every build of the liveness adapter in server.ts, its declaration aside. */
  function adapterBuilds(): number[] {
    return indicesOf(new RegExp(`(?<![\\w.$]|function\\s+)${ADAPTER}\\s*\\(`, 'g'), SERVER_CODE)
  }

  /** The routing's row-read binding, `(key) => <holder>?.(key) ?? Promise.resolve(<unknown>)`; returns the holder's name. */
  function rowReadHolder(): string {
    const binding = onlyCallProps('createPersonaRouting').get(ROUTING_ROW_READ)
    expect(binding).toBeDefined()
    const form = binding!.match(new RegExp(`^\\(?(\\w+)\\)? => (\\w+)\\?\\.\\(\\1\\) \\?\\? Promise\\.resolve\\(${UNKNOWN}\\)$`))
    expect(form).not.toBeNull()
    return form![2]!
  }

  // b.jg5 SRJ-1011, SRJ-401: the gate reads no row while a launch call or a
  // running dialog approver is in flight for P, as the health tick makes no
  // attempt then; the retry action gets the narrow "blocks a retry", since a
  // running approver never skips a retry (SRJ-303).
  test('the read gate\'s in-flight member is "in flight for P", bound by its bare name: the very binding the health tick\'s isLaunchInFlight gets, not "blocks a retry", which the full-mode retry action\'s isInFlight gets (see inFlightBindings)', () => {
    const { retryBlocked, workInFlight } = inFlightBindings()
    expect([
      onlyCallProps('createPersonaRouting').get(ROUTING_WORK_IN_FLIGHT),
      onlyCallProps('initHealthCheck').get(TICK_IN_FLIGHT_MEMBER),
      onlyCallProps('createFullModeRetryAction').get(RETRY_IN_FLIGHT_MEMBER),
    ]).toEqual([workInFlight, workInFlight, retryBlocked])
  })

  test('the liveness adapter is built exactly once, in main()\'s own statement list, as one const that the restart module\'s and the health tick\'s isSessionAlive both get', () => {
    const builds = adapterBuilds()
    expect(builds).toHaveLength(1)
    expect(atMainTopLevel(SERVER_CODE, builds[0]!)).toBe(true)
    const adapter = constOf(ADAPTER)
    declaredOnce(adapter)
    expect([onlyCallProps('initRestart').get(RESTART_ALIVE), onlyCallProps('initHealthCheck').get(TICK_ALIVE)]).toEqual([adapter, adapter])
  })

  test('the row read reads that one adapter at call time, through a module-scope holder declared once with no initializer and assigned the adapter exactly once, in main()\'s own statement list, after its build and before the start bring-up; before then the read answers the unknown reading, never pending, and the holder is named nowhere else', () => {
    const holder = rowReadHolder()
    expect(importSource(SERVER_CODE, UNKNOWN)).toBe('./liveness-reading.ts')

    declaredOnce(holder)
    const decls = [...SERVER_CODE.matchAll(new RegExp(`^let\\s+${holder}\\s*:(.+)$`, 'gm'))]
    expect(decls).toHaveLength(1)
    expect(insideMain(decls[0]!.index!)).toBe(false)
    // No initializer: once the type's arrows are set aside, no `=` is left.
    expect(decls[0]![1]!.replace(/=>/g, '')).not.toContain('=')

    const adapter = constOf(ADAPTER)
    const assigned = assignmentsTo(holder)
    expect(assigned.map((a) => a.value)).toEqual([adapter])
    const at = assigned[0]!.at
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(at).toBeGreaterThan(adapterBuilds()[0]!)
    expect(at).toBeLessThan(startResolution(SERVER_CODE).bringUpAt)

    // Its declaration, that assignment and the routing's member.
    expect(indicesOf(new RegExp(`\\b${holder}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
  })

  test('the routing\'s call reaches agent-director only through that holder: it names no client and builds no adapter (no new getClient() site)', () => {
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaRouting'), '(', ')')
    const call = SERVER_CODE.slice(open, close)
    expect(indicesOf(/\bgetClient\b/g, call)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${ADAPTER}\\b`, 'g'), call)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${rowReadHolder()}\\b`, 'g'), call)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-311 — the session-disconnect handler's and the
// lost-message routing's `tmux-unavailable` retry check: production bindings
//
// While a persona's `tmux-unavailable` outage is raised, the only attempts
// made for it are its retry timer's (SRJ-311), and a raised flag with no
// timer (a retry that stopped as not up, on a declined launch or on a failed
// run) must still get one. The session-disconnect handler and the routing's
// `armRetryTimerIfMissing` both decide through `armMissingTmuxUnavailableRetry`
// over one set of production deps. What the handler and the check do with
// their deps is tested in tests/session-disconnect.test.ts, and what the
// routing's arm does through the real controller in
// tests/unavailable-retry.test.ts; both inject their deps, so a production
// wiring that built a second handler, overrode a check member, bound a deps
// member to a constant, a copy or a second latch, predicate or controller,
// or dropped the routing's shutdown guard would pass them. Pinned here: the
// one handler's build and its two callers, the deps' members, and the
// routing's arm binding.
// ---------------------------------------------------------------------------

describe('the session-disconnect handler and the routing\'s retry-timer arm decide through one tmux-unavailable retry check over one set of production deps: the outage flag, the one controller, the one latch, "in flight for P" and the one ENVIRONMENT arm path (b.jg5 SRJ-311)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const BUILD: keyof typeof ServerModule = '_buildRestartDisconnectedPersona'
  const CHECK: keyof typeof ServerModule = 'armMissingTmuxUnavailableRetry'
  const ROUTING_ARM: keyof PersonaRoutingDeps = 'armRetryTimerIfMissing'
  const GET_FLAGS: keyof typeof OutageStateModule = 'getOutageFlags'
  const IS_ARMED: keyof UnavailableRetryController = 'isArmed'
  const IS_LATCHED: keyof ConflictLatch = 'isLatched'
  const CHECK_MEMBERS: Array<keyof TmuxUnavailableRetryDeps> = [
    'isTmuxUnavailable', 'isRetryArmed', CHECK_LATCHED, CHECK_IN_FLIGHT, 'armRetryTimer', 'log',
  ]
  const HANDLER_MEMBERS: Array<Exclude<keyof RestartDisconnectedPersonaDeps, keyof TmuxUnavailableRetryDeps>> = [
    'getPersona', 'scheduleRestart', 'isShuttingDown',
  ]

  /** The restart module's shutdown-flag binding, `() => <flag>`; returns the flag's name. */
  function shutdownFlag(): string {
    const binding = onlyCallProps('initRestart').get('isShuttingDown')
    const flag = binding?.match(/^\(\) => (\w+)$/)?.[1]
    expect(flag).toBeDefined()
    declaredOnce(flag!)
    expect(insideMain(SERVER_CODE.search(new RegExp(`\\blet\\s+${flag}\\b`)))).toBe(false)
    return flag!
  }

  test('the handler is built once, at module scope, as the one const restartDisconnectedPersona, over the production deps spread first (no member after it overrides one), getAppliedPersona, the restart module\'s scheduleRestart and the restart module\'s shutdown flag, each read at call time; its only callers are the session close and the SSE abort', () => {
    const builds = indicesOf(new RegExp(`(?<![\\w.$]|function\\s+)${BUILD}\\s*\\(`, 'g'), SERVER_CODE)
    expect(builds).toHaveLength(1)
    expect(insideMain(builds[0]!)).toBe(false)
    expect(constOf(BUILD)).toBe(DISCONNECT_HANDLER)
    declaredOnce(DISCONNECT_HANDLER)
    expect(importSource(SERVER_CODE, BUILD)).toBeUndefined()
    expect(indicesOf(new RegExp(`\\b${BUILD}\\b`, 'g'), SERVER_CODE)).toHaveLength(2)

    const args = splitTopLevel(callArguments(SERVER_CODE, builds[0]!))
    expect(args).toHaveLength(1)
    const parts = splitTopLevel(args[0]!.slice(...balancedAfter(args[0]!, 0, '{', '}')))
    expect(parts[0]).toBe(`...${retryCheckDeps().name}`)
    const props = objectProperties(`{ ${parts.slice(1).join(', ')} }`)
    expect([...props.keys()].sort()).toEqual([...HANDLER_MEMBERS].sort())
    expect(props.get('getPersona')).toBe('getAppliedPersona')
    expect(importSource(SERVER_CODE, 'getAppliedPersona')).toBeUndefined()
    expect(props.get('scheduleRestart')).toMatch(/^(?:scheduleRestart|\((\w+), (\w+)\) => scheduleRestart\(\1, \2\))$/)
    expect(importSource(SERVER_CODE, 'scheduleRestart')).toBe('./restart.ts')
    expect(props.get('isShuttingDown')).toBe(`() => ${shutdownFlag()}`)

    // Named at its declaration and in the two session-close paths, with their `via`.
    expect(indicesOf(new RegExp(`\\b${DISCONNECT_HANDLER}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
    const calls = callsOf(DISCONNECT_HANDLER).map((at) => splitTopLevel(callArguments(SERVER_CODE, at)))
    expect(calls.map((callArgs) => callArgs[1]).sort()).toEqual(["' (SSE abort)'", "''"])
    for (const callArgs of calls) expect(callArgs).toHaveLength(2)
  })

  test('the production deps are exactly the six members, each read at call time: the outage state\'s tmux-unavailable flag, the one retry controller\'s isArmed through its handle, the one latch through the routing\'s holder (=== true), "in flight for P" as the health tick takes it (a running dialog approver included), the one ENVIRONMENT arm path and the server log; nothing else names them but the handler\'s build and the routing\'s arm', () => {
    const { name, props } = retryCheckDeps()
    expect([...props.keys()].sort()).toEqual([...CHECK_MEMBERS].sort())

    expect(props.get('isTmuxUnavailable')).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${GET_FLAGS}\\(\\1\\)\\.has\\('${TMUX_UNAVAILABLE_CLASS}'\\)$`))
    expect(importSource(SERVER_CODE, GET_FLAGS)).toBe('./outage-state.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${GET_FLAGS}\\b`, 'g'), SERVER_CODE)).toEqual([])

    // The handle is assigned only the one controller (pinned in the controller's describe).
    expect(props.get('isRetryArmed')).toMatch(new RegExp(`^\\(?(\\w+)\\)? => ${retryHandle()}\\?\\.${IS_ARMED}\\(\\1\\)$`))
    routingHolder(ROUTING_LATCHED, IS_LATCHED, constOf(LATCH_FACTORY), [CHECK_LATCHED])
    // It mirrors the health tick's own check, so it follows the tick (b.jg5 SRJ-315, SRJ-401).
    expect(props.get(CHECK_IN_FLIGHT)).toBe(inFlightBindings().workInFlight)
    expect(props.get('armRetryTimer')).toBe(ENVIRONMENT_ARM)
    expect(props.get('log')).toMatch(/^\(?(\w+)\)? => console\.error\(\1\)$/)

    // Its declaration, the handler build's spread and the routing's arm.
    expect(indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE)).toHaveLength(3)
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaRouting'), '(', ')')
    expect(indicesOf(new RegExp(`\\b${name}\\b`, 'g'), SERVER_CODE.slice(open, close))).toHaveLength(1)
  })

  test('the routing\'s armRetryTimerIfMissing does nothing while shutting down (the restart module\'s flag, asked first), else asks the check for the key it is given over the production deps, with the lost-message arm line; the check is called nowhere else but in the handler\'s builder', () => {
    const binding = onlyCallProps('createPersonaRouting').get(ROUTING_ARM)
    expect(binding).toBeDefined()
    const flag = shutdownFlag()
    const shape = blankLiterals(binding!).replace(/\s+/g, ' ').trim()
    expect(shape).toMatch(new RegExp(`^\\(?(\\w+)\\)? => \\{ if \\(${flag}\\) return;? ${CHECK}\\([^()]*\\);? \\}$`))
    const key = shape.match(/^\(?(\w+)\)?/)![1]!
    const args = splitTopLevel(callArguments(binding!, binding!.indexOf(`${CHECK}(`)))
    expect(args.slice(0, 2)).toEqual([key, retryCheckDeps().name])
    expect(args[2]).toBe(`\`[slack] Lost message: persona=\${${key}} has its tmux-unavailable outage raised with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)\``)

    // The check: its declaration, the builder's call and the routing's.
    expect(importSource(SERVER_CODE, CHECK)).toBeUndefined()
    const named = indicesOf(new RegExp(`\\b${CHECK}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(3)
    const [bodyStart, bodyEnd] = exportedFunctionBody(BUILD)
    expect(named.filter((offset) => offset > bodyStart && offset < bodyEnd)).toHaveLength(1)
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('createPersonaRouting'), '(', ')')
    expect(named.filter((offset) => offset > open && offset < close)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-114 / SRJ-501 — the configured-persona query
//
// The note rule latches a persona only when the session manager's
// configured-persona query counts its key as configured. The install is
// optional: absent, no key counts and no `provenance_conflict` note latches
// anyone; installed over a copy of the configuration taken once, a persona a
// reload adds is never latched by its note and one it removes still is;
// installed after the start sweep or the start pass, a note read there
// latches no one. Any of these would type-check and pass every behaviour
// suite. What the rule does is tested in tests/session-manager.test.ts and
// tests/conflict-latch.test.ts; pinned here: the install.
// ---------------------------------------------------------------------------

describe('main() installs the configured-persona query over the live applied configuration, beside the latch, before the start sweep and the start pass (b.jg5 SRJ-114, SRJ-501)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const QUERY_INSTALL: keyof typeof SessionManagerModule = 'setConfiguredPersonaQuery'
  const QUERY_RESET: keyof typeof SessionManagerModule = '_resetConfiguredPersonaQuery'
  const LATCH_INSTALL: keyof typeof SessionManagerModule = 'setConflictLatch'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'

  test('the query is installed in the session manager exactly once (nothing uninstalls or resets it), in main()\'s own statement list, through the session manager\'s own install', () => {
    const at = onlyCallOf(QUERY_INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(importSource(SERVER_CODE, QUERY_INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${QUERY_INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    // The test-only reset is never named in server.ts.
    expect(indicesOf(new RegExp(`\\b${QUERY_RESET}\\b`, 'g'), SERVER_CODE)).toEqual([])
  })

  test('the query reads the live applied configuration at each call: `(key) => getAppliedPersona(key) !== undefined` over the one applied-persona lookup, never a copy of the configuration taken once', () => {
    const args = onlyCallArgs(QUERY_INSTALL)
    expect(args).toHaveLength(1)
    // The parameter's name is free; its type annotation is optional.
    expect(args[0]).toMatch(/^\(?(\w+)(?:\s*:\s*string)?\)?(?:\s*:\s*boolean)?\s*=>\s*getAppliedPersona\(\1\) !== undefined$/)
    // getAppliedPersona reads the holder at call time (pinned in tests/reload-wiring.test.ts).
    declaredOnce('getAppliedPersona')
    expect(importSource(SERVER_CODE, 'getAppliedPersona')).toBeUndefined()
  })

  test('the query\'s and the latch\'s installs both come before the start sweep (reconcileOrphans) and the start pass, with no await between them', () => {
    const query = onlyCallOf(QUERY_INSTALL)
    const latch = onlyCallOf(LATCH_INSTALL)
    const sweep = onlyCallOf(START_SWEEP)
    expect(insideMain(sweep)).toBe(true)
    for (const install of [query, latch]) {
      for (const later of [sweep, ...latchStartPass()]) expect(install).toBeLessThan(later)
    }
    // Installed together: nothing else runs between the two installs.
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(Math.min(query, latch), Math.max(query, latch)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-807 / SRJ-802 — the retired-key store for the
// session manager's own-row reads
//
// The session manager's install is optional: with no store installed no read
// clears an entry, so an entry whose new life reads live stays retired. A
// store of its own (a second in-memory view beside the one the reload
// controller records through), an install after the start sweep or a launch
// path, or an install behind a branch would type-check and pass every
// behaviour suite. What the clear does is tested in tests/retired-keys.test.ts
// and through the shared reads in tests/session-manager.test.ts and
// tests/server.test.ts; pinned here: the install.
// ---------------------------------------------------------------------------

describe('main() installs the one retired-key store for the session manager once, behind no branch, before the start sweep and every launch path (b.jg5 SRJ-807, SRJ-802)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const INSTALL: keyof typeof SessionManagerModule = 'setRetiredKeyStore'
  const RESET: keyof typeof SessionManagerModule = '_resetRetiredKeyStore'
  const START_READ: keyof typeof RetiredKeysModule = 'readRetiredKeysAtStart'
  const STORE_DEP: keyof ReloadControllerDeps = 'retiredKeys'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const LIVENESS_ADAPTER: keyof typeof ServerModule = '_buildIsSessionAliveAdapter'

  /** The `const <store> = <outcome>.store` binding of the one start read: its name and offset. */
  function storeBinding(): { store: string; at: number } {
    const outcome = constOf(START_READ)
    const bindings = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)(?:\\s*:\\s*\\w+)?\\s*=\\s*${outcome}\\s*\\.\\s*store\\b`, 'g'))]
    expect(bindings).toHaveLength(1)
    return { store: bindings[0]![1]!, at: bindings[0]!.index! }
  }

  test('the store is installed exactly once, in main()\'s own statement list (behind no branch), through the session manager\'s own install; no other src file installs one and the test-only reset is never named', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${RESET}\\b`, 'g'), SERVER_CODE)).toEqual([])
    // b.jg5 SRJ-801: only the server writes the record, so the CLI and every
    // other module install no store; the session manager only declares it.
    const installers = srcFiles()
      .filter(([path]) => path !== 'src/server.ts' && path !== 'src/session-manager.ts')
      .filter(([, source]) => indicesOf(new RegExp(`\\b${INSTALL}\\s*\\(`, 'g'), stripComments(source)).length > 0)
      .map(([path]) => path)
    expect(installers).toEqual([])
  })

  test('its one argument is the one store main() loaded, by the binding the start read\'s store was bound to: the very binding the reload controller records through, never a second store', () => {
    const { store } = storeBinding()
    declaredOnce(store)
    expect(onlyCallArgs(INSTALL)).toEqual([store])
    expect(onlyCallProps('createReloadController').get(STORE_DEP)).toBe(store)
  })

  test('it is installed after the store is bound and before the start sweep, every launch path (the retry controller, the restart module, the start bring-up, the health check), the liveness adapter, the connection manager and Bun.serve', () => {
    const install = onlyCallOf(INSTALL)
    expect(install).toBeGreaterThan(storeBinding().at)
    const sweep = onlyCallOf(START_SWEEP)
    expect(insideMain(sweep)).toBe(true)
    const adapterBuilds = indicesOf(new RegExp(`(?<![\\w.$]|function\\s+)${LIVENESS_ADAPTER}\\s*\\(`, 'g'), SERVER_CODE)
    expect(adapterBuilds).toHaveLength(1)
    const later = [
      sweep,
      ...latchStartPass(),
      ...adapterBuilds,
      onlyCallOf('createPersonaConnectionManager'),
      onlyCallOf('Bun\\.serve'),
    ]
    for (const at of later) expect(install).toBeLessThan(at)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-809 — the one old-life hold set
//
// Holds live in server memory: the reload controller's apply step 1 begins
// them, and the session manager's reads end them, its start sweep begins its
// own and its teardown kill marks them. The controller's set and the session
// manager's install are both optional: a second set (each side its own), a
// missing binding, or an install after the start sweep (whose holds would
// begin in no set) would type-check and pass every behaviour suite, as the
// harnesses compose one set themselves. What the holds do is tested in
// tests/old-life-wait.test.ts, tests/reload-apply.test.ts and
// tests/session-manager.test.ts; pinned here: the one set, its install and
// the controller's binding.
// ---------------------------------------------------------------------------

describe('main() builds one old-life hold set, installs it for the session manager before the start sweep and gives the same set to the reload controller (b.jg5 SRJ-809)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const BUILD: keyof typeof RetiredKeysModule = 'createOldLifeHoldSet'
  const INSTALL: keyof typeof SessionManagerModule = 'setOldLifeHolds'
  const RESET: keyof typeof SessionManagerModule = '_resetOldLifeHolds'
  const HOLDS_DEP: keyof ReloadControllerDeps = 'oldLifeHolds'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'
  const STORE_INSTALL: keyof typeof SessionManagerModule = 'setRetiredKeyStore'

  test('the set is built exactly once, imported from the record module, bound to a const in main()\'s own statement list (behind no branch), with only a log to console.error; no other src file builds one', () => {
    expect(importSource(SERVER_CODE, BUILD)).toBe('./retired-keys.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${BUILD}\\b`, 'g'), SERVER_CODE)).toEqual([])
    const at = onlyCallOf(BUILD)
    const holds = constOf(BUILD)
    declaredOnce(holds)
    const decl = SERVER_CODE.slice(0, at).search(new RegExp(`\\bconst\\s+${holds}\\b[^=]*=\\s*$`))
    expect(decl).toBeGreaterThanOrEqual(0)
    expect(atMainTopLevel(SERVER_CODE, decl)).toBe(true)
    const args = onlyCallArgs(BUILD)
    expect(args).toHaveLength(1)
    const props = objectProperties(args[0]!)
    expect([...props.keys()]).toEqual(['log'])
    expect(props.get('log')).toMatch(/^\(\s*(\w+)\s*\)\s*=>\s*console\.error\(\s*\1\s*\)$/)
    // One set per server: no other src file (the session manager and the CLI included) builds one.
    const builders = srcFiles()
      .filter(([path]) => path !== 'src/server.ts' && path !== 'src/retired-keys.ts')
      .filter(([, source]) => indicesOf(new RegExp(`\\b${BUILD}\\s*\\(`, 'g'), stripComments(source)).length > 0)
      .map(([path]) => path)
    expect(builders).toEqual([])
  })

  test('the set is installed exactly once, in main()\'s own statement list (behind no branch), through the session manager\'s own install, by its binding; no other src file installs one and the test-only reset is never named', () => {
    const at = onlyCallOf(INSTALL)
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    expect(importSource(SERVER_CODE, INSTALL)).toBe('./session-manager.ts')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${INSTALL}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(indicesOf(new RegExp(`\\b${RESET}\\b`, 'g'), SERVER_CODE)).toEqual([])
    expect(onlyCallArgs(INSTALL)).toEqual([constOf(BUILD)])
    const installers = srcFiles()
      .filter(([path]) => path !== 'src/server.ts' && path !== 'src/session-manager.ts')
      .filter(([, source]) => indicesOf(new RegExp(`\\b${INSTALL}\\s*\\(`, 'g'), stripComments(source)).length > 0)
      .map(([path]) => path)
    expect(installers).toEqual([])
  })

  test('the reload controller gets the same set, by its binding, as its oldLifeHolds', () => {
    expect(onlyCallProps('createReloadController').get(HOLDS_DEP)).toBe(constOf(BUILD))
  })

  test('the set is built before the reload controller and its install, and installed beside the retired-key store, before the start sweep (reconcileOrphans), every launch path, the liveness adapter, the connection manager and Bun.serve', () => {
    const build = onlyCallOf(BUILD)
    const install = onlyCallOf(INSTALL)
    expect(build).toBeLessThan(startResolution(SERVER_CODE).createAt)
    expect(build).toBeLessThan(install)
    const sweep = onlyCallOf(START_SWEEP)
    expect(insideMain(sweep)).toBe(true)
    const adapterBuilds = indicesOf(/(?<![\w.$]|function\s+)_buildIsSessionAliveAdapter\s*\(/g, SERVER_CODE)
    expect(adapterBuilds).toHaveLength(1)
    const later = [sweep, ...latchStartPass(), ...adapterBuilds, onlyCallOf('createPersonaConnectionManager'), onlyCallOf('Bun\\.serve')]
    for (const at of later) expect(install).toBeLessThan(at)
    // Beside the store's install: nothing awaited between the two.
    const store = onlyCallOf(STORE_INSTALL)
    expect(indicesOf(/\bawait\b/g, SERVER_CODE.slice(Math.min(store, install), Math.max(store, install)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.jg5 SRJ-810, SRJ-1505, SRJ-812 — what a hold refuses
//
// The held-directory query, the restart path's old-life hook and the
// end-retry observer are all optional where main() binds them (absent: no
// session is held, no restart is held back, a hold's end retries no one), so
// a production wiring that dropped one, bound a stub or captured the hold
// set at build time would type-check and pass every behaviour suite while a
// session from a held directory was served, a restart launched into an old
// life's directory, or a waiting persona waited for its timer. What each
// does is tested in tests/registry.test.ts, tests/restart.test.ts,
// tests/session-manager.test.ts and, end to end, tests/reload-apply.test.ts
// and tests/old-life-wait.test.ts; pinned here: the bindings.
// ---------------------------------------------------------------------------

describe('main() binds what a hold refuses: the held-directory query into the MCP admission, the old-life hook into the restart work, and the end-retry observer over the retry controller\'s run-now entry on the one hold set (b.jg5 SRJ-810, SRJ-1505, SRJ-812)', () => {
  // Tied to src by type: renaming any of these fails the typecheck.
  const HELD_QUERY: keyof typeof SessionManagerModule = 'oldLifeHeldDirectory'
  const ADMISSION_HELD: keyof SessionAdmissionOptions = 'heldDirectory'
  const HOLD_STEP: keyof typeof SessionManagerModule = 'oldLifeHoldStep'
  const RESTART_HOOK: keyof RestartDeps = 'isHeldForOldLife'
  const END_RETRY: keyof typeof SessionManagerModule = 'createOldLifeHoldEndRetry'
  const RUN_NOW_DEP: keyof OldLifeHoldEndRetryDeps = 'runNow'
  const APPLIED_DEP: keyof OldLifeHoldEndRetryDeps = 'isApplied'
  const RUN_NOW: keyof UnavailableRetryController = 'runNow'
  const ON_END: keyof OldLifeHoldSet = 'onEnd'
  const HOLD_CAUSE: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD'
  const HOLD_ENDED: keyof typeof UnavailableRetryModule = 'UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED'
  const HOLDS_INSTALL: keyof typeof SessionManagerModule = 'setOldLifeHolds'
  const START_SWEEP: keyof typeof SessionManagerModule = 'reconcileOrphans'

  /** `name` is imported from `module` and declared nowhere in server.ts. */
  function importedOnly(name: string, module: string): void {
    expect([name, importSource(SERVER_CODE, name)]).toEqual([name, module])
    expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
  }

  test('handleInitialized gives decideSessionAdmission the session manager\'s held-directory query, by its bare name (the hold set read at call time), beside isPersonaUp; the options are exactly these four, and server.ts names the query nowhere else', () => {
    const props = objectProperties(onlyCallArgs('decideSessionAdmission')[2]!)
    expect([...props.keys()].sort()).toEqual(['describeNotUp', ADMISSION_HELD, 'isPersonaUp', 'log'].sort())
    expect(props.get(ADMISSION_HELD)).toBe(HELD_QUERY)
    expect(props.get('isPersonaUp')).toBe('isPersonaUp')
    importedOnly(HELD_QUERY, './session-manager.ts')
    // Named only at its import and this member: never called with a captured set, never wrapped.
    const named = indicesOf(new RegExp(`\\b${HELD_QUERY}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(2)
    expect(withinCall(named, onlyCallOf('decideSessionAdmission'))).toBe(1)
  })

  test('the restart work\'s old-life hook runs the session manager\'s hold step over the live applied persona for the key it is given, with a site of its own, and answers false for a key that is not applied; the step is named nowhere else', () => {
    const hook = onlyCallProps('initRestart').get(RESTART_HOOK)
    expect(hook).toBeDefined()
    const shape = new RegExp(
      `^\\(?(\\w+)\\)? => \\{ const (\\w+) = getAppliedPersona\\(\\1\\);? return \\2 !== undefined && ${HOLD_STEP}\\(\\2, '[^']+'\\);? \\}$`,
    )
    expect(hook).toMatch(shape)
    importedOnly(HOLD_STEP, './session-manager.ts')
    const named = indicesOf(new RegExp(`\\b${HOLD_STEP}\\b`, 'g'), SERVER_CODE)
    expect(named).toHaveLength(2)
    expect(withinCall(named, onlyCallOf('initRestart'))).toBe(1)
  })

  test('the end-retry observer is built once, as the one argument of its registration on the one hold set\'s onEnd, a statement of main()\'s own list, after the set\'s install (so after the session manager\'s own end observer) and before the start sweep and the start bring-up', () => {
    importedOnly(END_RETRY, './session-manager.ts')
    const at = onlyCallOf(END_RETRY)
    const holds = constOf('createOldLifeHoldSet')
    const registrations = indicesOf(new RegExp(`(?<![\\w.$])${holds}\\s*\\.\\s*${ON_END}\\s*\\(`, 'g'), SERVER_CODE)
    expect(registrations).toHaveLength(1)
    // The observer is the registration's one argument, and nothing else in server.ts registers an end observer.
    expect(indicesOf(new RegExp(`\\.\\s*${ON_END}\\s*\\(`, 'g'), SERVER_CODE)).toHaveLength(1)
    expect(withinCall([at], registrations[0]!)).toBe(1)
    expect(splitTopLevel(callArguments(SERVER_CODE, registrations[0]!))).toHaveLength(1)
    expect(atMainTopLevel(SERVER_CODE, registrations[0]!)).toBe(true)
    expect(registrations[0]!).toBeGreaterThan(onlyCallOf(HOLDS_INSTALL))
    for (const later of [onlyCallOf(START_SWEEP), startResolution(SERVER_CODE).bringUpAt]) expect(registrations[0]!).toBeLessThan(later)
  })

  test('its members are exactly the one retry controller\'s run-now entry for the key, with the held-for-an-old-life cause and the hold-ended label, and the live applied-persona lookup', () => {
    const props = onlyCallProps(END_RETRY)
    expect([...props.keys()].sort()).toEqual([RUN_NOW_DEP, APPLIED_DEP].sort())
    const controller = constOf('createUnavailableRetryController')
    expect(props.get(RUN_NOW_DEP)).toMatch(
      new RegExp(`^\\(?(\\w+)\\)? => ${controller}\\.${RUN_NOW}\\(\\1, \\{ kind: ${HOLD_CAUSE} \\}, ${HOLD_ENDED}\\)$`),
    )
    expect(props.get(APPLIED_DEP)).toMatch(/^\(?(\w+)\)? => getAppliedPersona\(\1\) !== undefined$/)
    importedOnly(HOLD_CAUSE, './unavailable-retry.ts')
    importedOnly(HOLD_ENDED, './unavailable-retry.ts')
    // Built after the controller whose entry it calls.
    expect(onlyCallOf(END_RETRY)).toBeGreaterThan(onlyCallOf('createUnavailableRetryController'))
  })

  test('no binding above reaches agent-director itself: none names getClient() or builds a client (no new getClient() site)', () => {
    const bindings = [
      objectProperties(onlyCallArgs('decideSessionAdmission')[2]!).get(ADMISSION_HELD)!,
      onlyCallProps('initRestart').get(RESTART_HOOK)!,
      onlyCallArguments(SERVER_CODE, END_RETRY),
    ]
    for (const binding of bindings) expect(binding).not.toMatch(/\bgetClient\b|\bnew\s+Client\b|\binitClient\b/)
  })
})

// ---------------------------------------------------------------------------
// Static audit: b.f2b — a stale `working` row must not strand a persona
//
// The health check's b.f2b dependencies are optional (a test deps object
// without them keeps the old behaviour), and so is nothing else that ends a
// not-connected episode, so only these audits make sure production binds
// them: the launch-in-flight skip, the delay-0 not-connected notice read from
// the same restart delay the restart module uses, the pending working-row
// evidence, the end of the episode on a healthy tick and when the persona's
// MCP session registers, and the reconnect adapter's persona lookup (without
// it a fresh session's transcript is never found). What each does is tested in tests/health-check.test.ts and
// tests/session-manager.test.ts.
// ---------------------------------------------------------------------------

describe('server.ts wires the b.f2b stale-working-row recovery', () => {
  test('the health check gets "in flight for P" ("blocks a retry" or the session manager\'s isDialogApproverRunning), hasPendingWorkingRowEvidence, notifyDisconnectedWithAutoRestartDisabled and forgetNotConnectedEpisode, and reads session_restart_delay 0 from the config the restart module reads', () => {
    const props = onlyCallProps('initHealthCheck')
    // b.jg5 SRJ-315, SRJ-401: "in flight for P", built from "blocks a retry"
    // and the approver-running query (see inFlightBindings), so the tick makes
    // no attempt while only P's dialog approver runs.
    expect(props.get(TICK_IN_FLIGHT_MEMBER)).toBe(inFlightBindings().workInFlight)
    // A module-scope function declaration (the helper pins it), so the tick's
    // binding reads the one declaration in scope wherever main() binds it.
    for (const [dep, value] of [
      ['hasPendingWorkingRowEvidence', 'hasPendingWorkingRowEvidence'],
      ['notifyNotConnected', 'notifyDisconnectedWithAutoRestartDisabled'],
      // A healthy tick ends the persona's not-connected episode.
      ['endNotConnectedEpisode', 'forgetNotConnectedEpisode'],
    ] as const) {
      expect([dep, props.get(dep)]).toEqual([dep, value])
      expect([value, importSource(SERVER_CODE, value)]).toEqual([value, './session-manager.ts'])
    }
    const delay = onlyCallProps('initRestart').get('getRestartDelay')?.match(/^\(\) => (\w+)\.session_restart_delay$/)
    expect(delay).not.toBeNull()
    expect(props.get('isAutoRestartDisabled')).toBe(`() => ${delay![1]}.session_restart_delay === 0`)
  })

  test('the restart module\'s reconnect is the reconnect adapter over the live applied persona lookup, getAppliedPersona, which locates a working row\'s transcript under the persona\'s claude_config_dir, and the one latch\'s latched query, asked right before /mcp reconnect is typed (b.jg5 SRJ-502)', () => {
    // Tied to src by type: renaming it fails the typecheck.
    const IS_LATCHED: keyof ConflictLatch = 'isLatched'
    const latch = constOf(LATCH_FACTORY)
    const reconnect = onlyCallProps('initRestart').get('reconnectSession')!
    expect(reconnect).toMatch(new RegExp(`^${RECONNECT_ADAPTER}\\(getAppliedPersona, \\(?(\\w+)\\)? => ${latch}\\.${IS_LATCHED}\\(\\1\\)\\)$`))
    // The only adapter built (its declaration aside), and it is the one the
    // restart module gets: no reconnect path without the lookup or the latch.
    const adapter = onlyReconnectAdapterBuild()
    const [open, close] = balancedAfter(SERVER_CODE, onlyCallOf('initRestart'), '(', ')')
    expect(adapter > open && adapter < close).toBe(true)
    expect(reconnectAdapterArgs()).toHaveLength(2)
  })

  test('handleInitialized ends the persona\'s not-connected episode once its session is registered: forgetNotConnectedEpisode(persona.key), the session manager\'s, right after registerSession', () => {
    const decl = SERVER_CODE.search(/\basync\s+function\s+handleInitialized\s*\(/)
    expect(decl).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decl, '(', ')')
    const [start, end] = balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
    const forget = onlyCallOf('forgetNotConnectedEpisode')
    expect(forget > start && forget < end).toBe(true)
    expect(onlyCallArgs('forgetNotConnectedEpisode')).toEqual(['persona.key'])
    const register = onlyCallOf('registerSession')
    expect(register > start && register < forget).toBe(true)
    expect(importSource(SERVER_CODE, 'forgetNotConnectedEpisode')).toBe('./session-manager.ts')
  })
})

// ---------------------------------------------------------------------------
// Static audit: a persona that is not up is refused service (SR-6.3, SR-6.4)
//
// The admission decision, the drop and the up predicate are driven through
// their real imports in tests/registry.test.ts; what only server.ts holds is
// which call gets the predicate, the drop listener, and what handleInitialized
// does with a refused session.
// ---------------------------------------------------------------------------

describe('server.ts refuses service to a persona that is not up (b.av2 SR-6.3, SR-6.4)', () => {
  /** [start, end) of the body of `async function <name>(…)`. */
  function asyncFunctionBody(name: string): [number, number] {
    const decl = SERVER_CODE.search(new RegExp(`\\basync\\s+function\\s+${name}\\s*\\(`))
    expect(decl).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, decl, '(', ')')
    return balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')
  }

  // b.av2 SR-8.6: `isApplied` is optional in PersonaUpQuery (a query without it
  // counts every key as applied), so this audit is what makes sure production
  // binds it: a removed persona must stop being up for MCP admission, the
  // permission poller and /interject from a confirmed apply's step 1 on.
  test('isPersonaUp is built once, at module scope, from createPersonaUpPredicate over the connection view and the controller\'s isUp and isApplied (both false before main() builds it); server.ts has no up check of its own', () => {
    expect(constOf('createPersonaUpPredicate')).toBe('isPersonaUp')
    expect(insideMain(onlyCallOf('createPersonaUpPredicate'))).toBe(false)
    const args = onlyCallArgs('createPersonaUpPredicate')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('connectionView')
    const outcomes = objectProperties(args[1]!)
    expect([...outcomes.keys()]).toEqual(['isUp', 'isApplied'])
    expect(outcomes.get('isUp')).toMatch(/^\((\w+)\) => bringUps\?\.isUp\(\1\) \?\? false$/)
    expect(outcomes.get('isApplied')).toMatch(/^\((\w+)\) => bringUps\?\.isApplied\(\1\) \?\? false$/)
    // Never called directly, and no serving check copied in.
    expect(callsOf('isPersonaUp')).toEqual([])
    expect(indicesOf(/\bisPersonaClientServing\b/g, SERVER_CODE)).toEqual([])
  })

  test('the permission poller, /interject and the MCP admission decision each get isPersonaUp', () => {
    expect(onlyCallProps('startPermissionPoller').get('isPersonaUp')).toBe('isPersonaUp')
    const interject = onlyCallArgs('handleInterject')
    expect(interject).toHaveLength(3)
    expect(objectProperties(interject[2]!).get('isPersonaUp')).toBe('isPersonaUp')
    expect(onlyCallProps('decideSessionAdmission').get('isPersonaUp')).toBe('isPersonaUp')
  })

  // `isPersonaUp` is optional in PersonaRoutingDeps (without it every
  // persona counts as up), so only this audit makes sure production binds it:
  // a message that reaches a persona which is no longer up (it stopped being
  // up mid-dispatch, or the old half of a destructive modify) must get the
  // not-up notice and no restart.
  test('the persona routing gets the one isPersonaUp predicate, built before it, so a lost message for a persona that is not up restarts nothing', () => {
    expect(onlyCallProps('createPersonaRouting').get('isPersonaUp')).toBe('isPersonaUp')
    // Read when the routing is built: the predicate must already exist.
    expect(onlyCallOf('createPersonaRouting')).toBeGreaterThan(onlyCallOf('createPersonaUpPredicate'))
  })

  test('handleInitialized decides admission over the roots path and the loaded personas, with the controller\'s not-up description, and no longer matches personas itself', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const at = onlyCallOf('decideSessionAdmission')
    expect(at > start && at < end).toBe(true)
    expect(callsOf('matchPersonaByRootsPath')).toEqual([])

    const args = onlyCallArgs('decideSessionAdmission')
    expect(args).toHaveLength(3)
    expect(args[0]).toBe('rootsPath')
    expect(args[1]).toBe(`${loadedConfigName(SERVER_CODE)}?.personas ?? []`)
    const props = objectProperties(args[2]!)
    expect(props.get('describeNotUp')).toBe('describePersonaNotUpByKey')
    expect(props.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)
    const describe = SERVER_CODE.search(/\bfunction\s+describePersonaNotUpByKey\s*\(/)
    expect(describe).toBeGreaterThan(-1)
    const [, paramsEnd] = balancedAfter(SERVER_CODE, describe, '(', ')')
    const body = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, paramsEnd + 1, '{', '}')).trim()
    expect(body).toMatch(/^return describePersonaNotUp\(bringUps\?\.state\((\w+)\)\)$/)
  })

  /** The top-level arguments of every `closePendingSession(…)` call in `code`, in order. */
  function closeCallsIn(code: string): string[][] {
    return indicesOf(/(?<![\w.$])closePendingSession\s*\(/g, code).map((at) => splitTopLevel(callArguments(code, at)))
  }

  /** A hand-rolled pending close: the pieces `closePendingSession` does, called directly. */
  const HAND_ROLLED_CLOSE = /\bremovePendingSession\s*\(|\bstopSseKeepAlive\s*\(|\.close\s*\(/

  test('pendingSessionCloseDeps is one module-scope object wiring exactly removePending: removePendingSession and stopKeepAlive: stopSseKeepAlive, and closePendingSession is the registry\'s', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bclosePendingSession\b[^}]*\}\s*from\s*['"]\.\/registry\.ts['"]/)
    expect(SERVER_CODE).not.toMatch(/\bfunction\s+closePendingSession\b|\b(?:const|let|var)\s+closePendingSession\b/)

    const decls = indicesOf(/^const\s+pendingSessionCloseDeps\b[^=]*=\s*\{/gm, SERVER_CODE)
    expect(decls).toHaveLength(1)
    expect(indicesOf(/\b(?:const|let|var)\s+pendingSessionCloseDeps\b/g, SERVER_CODE)).toEqual(decls)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', decls[0]!)))
    expect([...props.entries()]).toEqual([
      ['removePending', 'removePendingSession'],
      ['stopKeepAlive', 'stopSseKeepAlive'],
    ])
    expect(assignmentsTo('pendingSessionCloseDeps')).toEqual([])
  })

  test('a refused or unmatched session is closed through closePendingSession(pendingId, <pending>.transport, pendingSessionCloseDeps), awaited, and handleInitialized returns before it could be promoted or mapped', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const code = SERVER_CODE.slice(start, end)
    const decl = code.match(/\bconst\s+(\w+)\s*=\s*decideSessionAdmission\s*\(/)
    expect(decl).not.toBeNull()
    const admission = decl![1]!
    const guards = indicesOf(new RegExp(`\\bif\\s*\\(\\s*${admission}\\.kind\\s*!==\\s*'admitted'\\s*\\)\\s*\\{`, 'g'), code)
    expect(guards).toHaveLength(1)
    const [blockStart, blockEnd] = balancedAfter(code, guards[0]!, '{', '}')
    const block = code.slice(blockStart, blockEnd)

    const pending = block.match(/\bconst\s+(\w+)\s*=\s*getPendingSession\s*\(\s*pendingId\s*\)/)
    expect(pending).not.toBeNull()
    const p = pending![1]!
    expect(block).toMatch(new RegExp(`\\bif\\s*\\(\\s*${p}\\s*\\)\\s*await\\s+closePendingSession\\s*\\(`))
    expect(closeCallsIn(block)).toEqual([['pendingId', `${p}.transport`, 'pendingSessionCloseDeps']])
    expect(block).not.toMatch(HAND_ROLLED_CLOSE)
    expect(block.trim()).toMatch(/\breturn\s*;?$/)
    // Nothing in the refusal registers the session.
    expect(block).not.toMatch(/\bregisterSession\s*\(|\bregisterMcpSessionId\s*\(/)
    // Only after the guard is the session promoted and mapped (the admitted persona).
    for (const call of ['registerSession', 'registerMcpSessionId']) {
      const at = indicesOf(new RegExp(`\\b${call}\\s*\\(`, 'g'), code)
      expect(at).toHaveLength(1)
      expect(at[0]!).toBeGreaterThan(blockEnd)
    }
    expect(code.slice(blockEnd)).toMatch(new RegExp(`\\bconst\\s*\\{\\s*persona\\s*\\}\\s*=\\s*${admission}\\b`))
  })

  /**
   * The body of each of handleInitialized's other close branches, and the
   * pending entry whose transport it must close.
   */
  const OTHER_CLOSE_BRANCHES: Array<[string, (code: string) => { block: string; entry: string }]> = [
    [
      'the SSE stream never opened',
      (code) => {
        const wait = code.match(/\bconst\s+(\w+)\s*=\s*await\s+waitForSseStream\s*\(\s*(\w+)\.transport\s*\)/)
        expect(wait).not.toBeNull()
        const guard = code.search(new RegExp(`\\bif\\s*\\(\\s*!\\s*${wait![1]}\\s*\\)\\s*\\{`))
        expect(guard).toBeGreaterThan(-1)
        return { block: code.slice(...balancedAfter(code, guard, '{', '}')), entry: wait![2]! }
      },
    ],
    [
      'roots/list failed',
      (code) => {
        const list = code.search(/\.listRoots\s*\(/)
        expect(list).toBeGreaterThan(-1)
        const tryAt = indicesOf(/\btry\s*\{/g, code).filter((at) => at < list).pop()!
        const [, tryEnd] = balancedAfter(code, tryAt, '{', '}')
        expect(list).toBeLessThan(tryEnd)
        const rest = code.slice(tryEnd + 1)
        expect(rest).toMatch(/^\s*catch\s*\([^)]*\)\s*\{/)
        return pendingBranch(rest.slice(...balancedAfter(rest, rest.indexOf(')'), '{', '}')))
      },
    ],
    [
      'the client reported no roots',
      (code) => {
        const guard = code.search(/\bif\s*\(\s*!\s*\w+\.length\s*\)\s*\{/)
        expect(guard).toBeGreaterThan(-1)
        return pendingBranch(code.slice(...balancedAfter(code, guard, '{', '}')))
      },
    ],
  ]

  /** A branch that re-reads the pending entry (`const <p> = getPendingSession(pendingId)`) and closes it only when present. */
  function pendingBranch(block: string): { block: string; entry: string } {
    const pending = block.match(/\bconst\s+(\w+)\s*=\s*getPendingSession\s*\(\s*pendingId\s*\)/)
    expect(pending).not.toBeNull()
    expect(block).toMatch(new RegExp(`\\bif\\s*\\(\\s*${pending![1]}\\s*\\)\\s*await\\s+closePendingSession\\s*\\(`))
    return { block, entry: pending![1]! }
  }

  test.each(OTHER_CLOSE_BRANCHES)('when %s, handleInitialized closes the pending session through closePendingSession with pendingSessionCloseDeps, awaited, and returns', (_label, branchOf) => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const { block, entry } = branchOf(SERVER_CODE.slice(start, end))
    expect(closeCallsIn(block)).toEqual([['pendingId', `${entry}.transport`, 'pendingSessionCloseDeps']])
    expect(block).toMatch(/\bawait\s+closePendingSession\s*\(/)
    expect(block).not.toMatch(HAND_ROLLED_CLOSE)
    expect(block.trim()).toMatch(/\breturn\s*;?$/)
  })

  test('handleInitialized has no other close path: exactly the four closePendingSession calls, and no direct pending remove, keep-alive stop or transport close', () => {
    const [start, end] = asyncFunctionBody('handleInitialized')
    const code = SERVER_CODE.slice(start, end)
    const calls = closeCallsIn(code)
    expect(calls).toHaveLength(OTHER_CLOSE_BRANCHES.length + 1)
    for (const args of calls) {
      expect(args).toHaveLength(3)
      expect(args[0]).toBe('pendingId')
      expect(args[2]).toBe('pendingSessionCloseDeps')
    }
    expect(code).not.toMatch(HAND_ROLLED_CLOSE)
  })

  test('the bring-up controller\'s onLeftUp drops the persona\'s MCP session through createNotUpSessionDropper over dropPersonaSessionAndKeepAlive, which stops the keep-alive and then calls dropPersonaSession', () => {
    expect(onlyCallProps('createPersonaBringUpController').get('onLeftUp')).toStartWith('createNotUpSessionDropper(')
    const dropper = onlyCallProps('createNotUpSessionDropper')
    expect([...dropper.keys()].sort()).toEqual(['drop', 'log'])
    expect(dropper.get('drop')).toBe('dropPersonaSessionAndKeepAlive')
    expect(dropper.get('log')).toMatch(/^\((\w+)\) => console\.error\(\1\)$/)

    const [start, end] = asyncFunctionBody('dropPersonaSessionAndKeepAlive')
    const body = SERVER_CODE.slice(start, end)
    const session = body.match(/\bconst\s+(\w+)\s*=\s*getSessionByPersona\s*\(\s*(\w+)\s*\)/)
    expect(session).not.toBeNull()
    const [, s, key] = session!
    const stop = body.search(new RegExp(`\\bstopSseKeepAlive\\s*\\(\\s*${s}\\.transport\\s*\\)`))
    const drop = body.search(new RegExp(`\\breturn\\s+dropPersonaSession\\s*\\(\\s*${key}\\s*\\)`))
    expect(stop).toBeGreaterThan(-1)
    expect(drop).toBeGreaterThan(stop)
    // The one drop call in server.ts.
    const drops = callsOf('dropPersonaSession')
    expect(drops).toHaveLength(1)
    expect(drops[0]! > start && drops[0]! < end).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static audit: start-up side effects (SR-13.2) and dry run (SR-3.4)
// ---------------------------------------------------------------------------

describe('main() owns the start-up side effects', () => {
  test('creates the state and inbox directories inside main(), before the PID check and the PID file', () => {
    const calls = callsOf('mkdirSync')
    expect(calls.map((at) => splitTopLevel(callArguments(SERVER_CODE, at))[0]).sort()).toEqual(['INBOX_DIR', 'STATE_DIR'])
    for (const at of calls) {
      expect(insideMain(at)).toBe(true)
      expect(at).toBeLessThan(onlyCallOf('checkPidConflict'))
      expect(at).toBeLessThan(onlyCallOf('writePidFile'))
    }
  })

  test('starts the permission poller only outside dry run (the else branch of `if (isDryRun())`)', () => {
    const poller = onlyCallOf('startPermissionPoller')
    const inElse = indicesOf(/\bif\s*\(\s*isDryRun\s*\(\s*\)\s*\)\s*\{/g, SERVER_CODE).some((at) => {
      const [, thenEnd] = balancedAfter(SERVER_CODE, at, '{', '}')
      if (!/^\s*else\s*\{/.test(SERVER_CODE.slice(thenEnd + 1))) return false
      const [elseStart, elseEnd] = balancedAfter(SERVER_CODE, thenEnd + 1, '{', '}')
      return poller > elseStart && poller < elseEnd
    })
    expect(inElse).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static audit: the file guard refuses every persona credentials file (SR-5.2)
// ---------------------------------------------------------------------------

describe('server.ts\'s file guard refuses every persona credentials file (b.av2 SR-5.2; E3 Task 5 carry)', () => {
  test('assertSendable builds its protected list per call from the reload controller (the applied personas and the config file), with the config file\'s paths before main() builds it, and the session tools get it with clientFor', () => {
    expect(SERVER_CODE).toMatch(/import\s*\{[^}]*\bassertSendable\s+as\s+libAssertSendable\b[^}]*\}\s*from\s*['"]\.\/lib\.ts['"]/)
    const fn = SERVER_CODE.search(/\bfunction\s+assertSendable\s*\(/)
    expect(fn).toBeGreaterThan(-1)
    const body = SERVER_CODE.slice(...balancedAfter(SERVER_CODE, fn, '{', '}'))
    const list = body.match(
      /\bconst\s+(\w+)\s*=\s*reloadController\s*\?\.\s*protectedCredentialsFiles\s*\(\s*\)\s*\?\?\s*credentialsFilesToProtect\s*\(/,
    )
    expect(list).not.toBeNull()
    const fallback = list!.index! + list![0].lastIndexOf('credentialsFilesToProtect')
    expect(splitTopLevel(callArguments(body, fallback))).toEqual(['[]', 'CONFIG_PATH'])
    // The holder is the module-scope controller main() builds, set once, inside
    // main(), before the MCP server (and so any session tool) can run.
    expect(SERVER_CODE).toMatch(/^let\s+reloadController\s*:\s*ReloadController\s*\|\s*undefined\s*$/m)
    const { controller } = startResolution(SERVER_CODE)
    const holder = assignmentsTo('reloadController')
    expect(holder.map((a) => a.value)).toEqual([controller])
    expect(insideMain(holder[0]!.at)).toBe(true)
    expect(holder[0]!.at).toBeLessThan(onlyCallOf('Bun\\.serve'))
    const guard = body.search(/\blibAssertSendable\s*\(/)
    expect(guard).toBeGreaterThan(-1)
    expect(splitTopLevel(callArguments(body, guard))).toEqual(['filePath', 'resolve(STATE_DIR)', 'resolve(INBOX_DIR)', list![1]])

    const deps = SERVER_CODE.search(/\bconst\s+sessionToolDeps\s*:\s*SessionToolDeps\s*=\s*\{/)
    expect(deps).toBeGreaterThan(-1)
    const props = objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', deps)))
    expect(props.get('assertSendable')).toBe('assertSendable')
    expect(props.get('clientFor')).toBe('clientFor')
  })

  // The 64 KiB cap exempts two reads: the file guard's read of the config
  // file, so an oversized config still protects the credentials files it
  // names (behaviour in tests/config.test.ts), and the start's read of the
  // retired-key record, which only the server writes, so a record grown past
  // the cap never stops a start (behaviour in tests/retired-keys.test.ts).
  // Every other reader (the start's config, the last-applied record, the
  // pending and apply files, the reload tick) must stay capped; this audit
  // fails if any other call site passes the option, or names it.
  test('readPersonaConfigBytes is called uncapped only by credentialsFilesToProtect and loadRetiredKeyStore, and nothing else names the option', () => {
    const files = srcFiles().map(([path, source]) => [path, stripComments(source)] as const)
    const UNCAPPED_SITES: ReadonlyArray<[string, RegExp]> = [
      ['src/config.ts', /\bexport\s+function\s+credentialsFilesToProtect\s*\(/],
      ['src/retired-keys.ts', /\bexport\s+function\s+loadRetiredKeyStore\s*\(/],
    ]
    const sitePaths = UNCAPPED_SITES.map(([path]) => path)
    // src/config.ts declares the option; any other file may name it only at its one allowed call.
    const namesOutsideCalls = files
      .filter(([path]) => path !== 'src/config.ts')
      .map(([path, code]) => [path, indicesOf(/\buncapped\b/g, code).length] as const)
      .filter(([path, count]) => count > (sitePaths.includes(path) ? 1 : 0))
    expect(namesOutsideCalls).toEqual([])

    const withOptions = files.flatMap(([path, code]) =>
      indicesOf(/(?<![\w.$]|function\s+)readPersonaConfigBytes\s*\(/g, code)
        .map((at) => ({ path, code, at, args: splitTopLevel(callArguments(code, at)) }))
        .filter((call) => call.args.length > 2),
    )
    expect(withOptions.map((c) => [c.path, c.args[2]]).sort()).toEqual(sitePaths.map((path) => [path, '{ uncapped: true }']).sort())
    for (const [path, fnRe] of UNCAPPED_SITES) {
      const { code, at } = withOptions.find((c) => c.path === path)!
      const fn = code.search(fnRe)
      expect([path, fn]).not.toEqual([path, -1])
      const [bodyStart, bodyEnd] = balancedAfter(code, balancedAfter(code, fn, '(', ')')[1], '{', '}')
      expect([path, at > bodyStart && at < bodyEnd]).toEqual([path, true])
    }
  })
})

// ---------------------------------------------------------------------------
// Import-time behaviour, in a child process with a temp HOME (SR-13.2)
// ---------------------------------------------------------------------------

/**
 * Every path created under `home`, relative to it, except Bun's own
 * transpiler cache (`.bun/install/cache`), which the child runtime writes for
 * any module it loads under a fresh HOME, whatever the module does.
 */
function createdUnder(home: string, dir = home): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relative(home, full)
    const bunCache = ['.bun', join('.bun', 'install'), join('.bun', 'install', 'cache')]
    if (rel.startsWith(join('.bun', 'install', 'cache') + '/')) continue
    if (!bunCache.includes(rel)) out.push(rel)
    if (statSync(full).isDirectory()) out.push(...createdUnder(home, full))
  }
  return out
}

describe('importing src/server.ts has no side effect (SR-3.1, SR-10.2, SR-13.2)', () => {
  let home: string | undefined

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  test(
    'with a temp HOME and no token variables, the import completes, exits 0, installs no rejection handler, prints no token error and creates nothing under HOME',
    () => {
      home = mkdtempSync(join(tmpdir(), 'cscb-server-import-'))
      const stateDir = join(home, 'state')
      // The child's env comes from hostSafeChildEnv: only HOME, PATH,
      // TMUX_TMPDIR, SLACK_STATE_DIR and FAKE_HOME_INPUT_JSON (no token,
      // CSCB_*, CLAUDE_* or AGENT_DIRECTOR_* variable). It imports server.ts
      // from an eval script, so server.ts is never the entry point.
      const res = runInFakeHome({
        modulePath: SERVER_PATH,
        call: `process.stdout.write('IMPORTED::' + typeof mod.main + ' LISTENERS::' + process.listenerCount('unhandledRejection') + '\\n')`,
        input: null,
        home,
        stateDir,
        timeoutMs: 60_000,
      })

      expect(res.observedHomedir).toBe(home)
      // The import finished (no exit on the way) and installed no rejection handler.
      expect(res.stdout).toContain('IMPORTED::function LISTENERS::0')
      expect(res.status).toBe(0)
      expect(`${res.stdout}\n${res.stderr}`).not.toMatch(/SLACK_(?:BOT|APP)_TOKEN/)
      expect(existsSync(stateDir)).toBe(false)
      expect(createdUnder(home)).toEqual([])
    },
    90_000,
  )
})
