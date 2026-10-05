#!/usr/bin/env bash
# Test 17 (HO §7 scenarios 5, 11 and 13; b.jg5 SRJ-1406, SRJ-1413,
# SRJ-1415, SRJ-401, SRJ-402, SRJ-404, SRJ-406, SRJ-407, SRJ-409, SRJ-410,
# SRJ-120, SRJ-308, SRJ-310, SRJ-710, SRJ-713, SRJ-1112, SRJ-1306, SRJ-1401,
# SRJ-1418; AC 3, AC 6, AC 29, AC 32): a launch in progress, and a resume
# right after an exit, in five legs, run in this order:
# - scenario 5's leg (`leg_launch_pending`): a resume held at the
#   dev-channels dialog reads `pending` with its kept claude_session_id and a
#   launch start; health ticks and a `resume` forced meanwhile change nothing
#   (no launch, kill, counted failure or post; the forced `resume` gets
#   ErrSpawnNotResumable, not counted and not posted); the approver clears
#   the dialog through agent-director `read-pane` and `send-keys` with
#   `--allow-pending` on the `pending` row, the row reaches `waiting`, and the
#   bot server starts no tmux process (AC 3);
# - the launch-timeout legs (`leg_launch_timeouts`): a plain spawn, a reuse
#   and a `resume` whose session-creating tmux call outlasts agent-director's
#   create timeout (the tmux shim's `slow-create`) each end in a launch
#   timeout; one `get` follows, the row reads `pending`, and the approver
#   answers the dialog through `read-pane` and `send-keys` with
#   `--allow-pending`, whose `send-keys` adopts the pane after the lost
#   reply; the stub then reports in and the row reaches `waiting`, with no
#   launch, kill or post over it (AC 29);
# - the restart leg (`leg_restart_mid_launch`): a launch held at its starting
#   screen across a server restart (a plain `stop`, then a start) is found
#   `pending` by the new server, which made no launch for it and runs no
#   approver of its own; the pending-row rule's lap from G clears the dialog
#   and the row reaches `waiting`, with no launch, kill or post (AC 32);
# - scenario 11's leg (`leg_fail_create`): a fresh spawn whose
#   session-creating tmux call fails (the tmux shim's `fail-create`) ends in
#   ErrTmuxSessionCreate and leaves a `pending` row; CSCB never kills it or
#   launches over it, its own pending-row rule's `find-missing` marks it
#   `missing` from G, and the persona is then brought up, with no post
#   calling it a dispatcher bug and no escalation (AC 6);
# - scenario 13's leg (`leg_still_stopping`): a bot the harness pauses
#   reads `ended` while its worker still runs; the bot server's immediate
#   `resume` is refused once as "still stopping" (UNAVAILABLE), followed by
#   one `get`, and posts nothing; once the harness releases the worker, the
#   retry timer's retry resumes the bot, before the next health tick.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml, so no `[tmux]` table);
# - the tmux shim first on every CSCB process's PATH, in `log` mode apart
#   from the launch-timeout legs' start and scenario 11's start (below);
# - the stub as `claude`, in `dev-channels` (no selection) in every persona's
#   working directory but scenario 13's, with the dialog delay
#   (`stub_dialog_delay`) where a leg sets it; scenario 13's working
#   directory is selected for `linger-on-exit` (`stub_mode`; the stub's
#   header, LINGERING);
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record), one stub per leg,
#   each answering ok only for that leg's personas' token pairs;
# - each leg in its own state dir (`new_state_dir`); a start reads its state
#   dir's last-applied configuration, so a leg that changes a persona's
#   working directory between two starts makes the second start in a new
#   state dir.
#
# Scenario 5's leg's set-up: one persona P, with CSCB's config shortened:
# `health_check_interval` HEALTH_TICK_S and `session_restart_delay`
# RESTART_DELAY_S; the dialog delay set in P's working directory to
# DIALOG_DELAY_S before the resume.
#
# Scenario 5's leg (`leg_launch_pending`), in run order. Steps marked
# [harness] are the harness playing a human from the scenario's own shell;
# no CSCB process makes them.
#   1. The live start brings P up: the stub holds at the dev-channels dialog
#      (no delay yet), the approver clears it, the row reads `waiting`, the
#      server registers the stub's MCP session as P's, and the bring-up's
#      approver has stopped (no bot-server pane read of P for
#      APPROVER_QUIET_S), so its stop is the silent one, on the live row.
#   2. [harness] The dialog delay is set in P's working directory.
#   3. [harness] P's worker is ended with the stub's sentinel, sent into P's
#      pane with the real tmux: the stub fires SessionEnd and exits, and a
#      harness `get` reads the row `ended` (or `missing`) with its
#      claude_session_id.
#   4. The bot server resumes P through its restart path (the session's
#      disconnect, or a health tick that reads the row dead, schedules the
#      restart; ruling S4): one `resume` of P's row, whose parent is the bot
#      server. The resumed stub shows its starting screen for DIALOG_DELAY_S.
#   5. During the hold:
#      - [harness] a harness `get` reads `pending`, the same
#        claude_session_id and a launch_started_at that parses, and P's pane
#        shows neither approver needle;
#      - fixtures/fmk-driver.ts forces one `resume` of P (through
#        `cscb_run`, a CSCB process): its outcome line names
#        ErrSpawnNotResumable, `called=true` and `counted=false`, and it is
#        the driver's only launch call; it posted nothing: the driver installs
#        no notifier, so a notice would be logged on its standard error, and
#        that holds neither the no-notifier line for P
#        (src/session-manager.ts sendPersonaNotice) nor the driver's own
#        outage-notice line for P;
#      - the row still reads `pending` and the pane still shows neither
#        needle once the driver has returned;
#      - health ticks run: in the hold, from its first read to the last pane
#        read with no needle (D seconds), the bot server's `status` reads of
#        P whose next call of P's row (`status` or `read-pane`) is not a
#        `read-pane` (an approver lap reads status, then the pane; a tick
#        reads status only) number at least ⌊D / HEALTH_TICK_S⌋ - 1 (see
#        Waits).
#   6. [harness] The pane is read until it shows the dev-channels needle (the
#      delay's end), then the row is read until it leaves `pending`: it reads
#      `waiting` with the same claude_session_id. The last pane read with no
#      needle is the one after the forced resume when the first read of this
#      step already shows the dialog.
#   7. Checks over the leg, counting only shim lines whose parent is the bot
#      server (or, for the forced call, the driver):
#      - exactly one `resume` of P by the bot server, and no `spawn`
#        (reuses included), `resume` or `kill` of P by it after that one;
#      - no `send-keys` of P from any process between the resume and the
#        delay's end; every `send-keys` of P after the resume is the bot
#        server's and carries `--allow-pending`; after the delay's end a
#        bot-server `read-pane` of P with `--allow-pending`, then its
#        `send-keys`, both before the first harness read that is not
#        `pending`;
#      - no post (chat.* or files.* method) reaches the Slack stub's record
#        from the hold's first `pending` read to that first read that is not
#        `pending`;
#      - no server.log line in the hold names P with a reconnect, relaunch,
#        restart scheduling or not-connected text (ruling S3: a health tick
#        acting on the stub's missing MCP session stops the run);
#      - no server.log line across the leg starts with APPROVER_LOG_PREFIX
#        and names P (ruling S7: the approver writes no line when it sends
#        Enter or when it stops because the row went live).
#   The server is then stopped with `stop --stop-bots`.
# Outcomes the SRD leaves open are recorded in the script's output, not
# asserted (ruling S8): what scheduled the restart, the driver's `latched`,
# `class` and `action`, the hold's status and pane-read counts beside the
# tick reads' count, and every post across the leg.
#
# The launch-timeout legs (`leg_launch_timeouts`), in run order, with
# `health_check_interval` 0 (ruling S3: no tick is needed). Three personas,
# by role: `spawn` (no row: a plain spawn), `reuse` (a finished row whose
# `cwd` differs from the persona's working directory: the ladder's replace
# step makes a reuse spawn, `spawn --reuse-finished`) and `resume` (a
# finished row holding its claude_session_id: a `resume`).
#   1. In state dir `bringup`, the live start brings the reuse and resume
#      personas up (working directories `reuse-a` and `resume`): each row
#      reads `waiting` with a claude_session_id, each session is registered,
#      and the bring-up's approvers have stopped (APPROVER_QUIET_S with no
#      pane read). A plain `stop` follows (the workers keep running and no
#      restart path runs); [harness] each worker then ends with the stub's
#      sentinel, and its row reads `ended` (or `missing`) with its
#      claude_session_id.
#   2. In state dir `launch`, the config names the three personas, the reuse
#      persona now in `reuse-b`; [harness] the dialog delay
#      LT_DIALOG_DELAY_S is set in the three working directories.
#   3. [harness] The tmux shim is set to `slow-create` with CREATE_DELAY_S,
#      then the live start makes the three launches: each launch's
#      `new-session` creates the session with its labels and the stub, and
#      agent-director's create timeout ends the launch call with an
#      ErrTmuxUnresponsive carrying LAUNCH_TIMEOUT_PHRASE.
#   4. [harness] The three rows are read in turn, every SCENARIO_POLL_S, from
#      the start until each has left `pending`; once each persona's
#      post-timeout get line is in server.log (every launch call has ended),
#      the shim is set back to `log`.
#   5. Each row reads `waiting`, its session is registered, and the resume's
#      row keeps the resumed claude_session_id.
#   6. The leg waits until each persona's retry timer has a stopped line
#      (recorded, not asserted, when one has not within LT_RETRY_WAIT_S).
#   7. Checks per persona, over the bot server's agent-director calls of its
#      row (`call_table`):
#      - its launch is of its kind: the spawn persona's plain spawn carries
#        no `--reuse-finished` (and it has no reuse spawn or `resume`); the
#        reuse persona's `spawn` carries `--reuse-finished` (and it has no
#        `resume`); the resume persona's launch is a `resume` (and it has no
#        reuse spawn); the reuse and resume personas' own plain spawn, the
#        ladder's first step, collided first (recorded);
#      - the launch timeout: a server.log line naming the persona carries
#        LAUNCH_TIMEOUT_PHRASE, or its get line names the ErrCallTimeout form
#        (E28 T3; FORM_CALL_TIMEOUT); exactly one post-timeout get line, which
#        names a launch timeout (FORM_CALL_TIMEOUT or FORM_TMUX_UNRESPONSIVE
#        right after the persona's reference) and OUTCOME_APPROVER (the
#        approver started);
#      - exactly one bot-server `get` of the row between the launch and the
#        first bot-server `read-pane` with `--allow-pending`, then a
#        bot-server `send-keys` with `--allow-pending`, the only `send-keys`
#        of the row from any CSCB process up to it; no bot-server `spawn`
#        (reuses included) or `resume` of the row after the launch, and no
#        `kill` of it from any CSCB process;
#      - [harness] a harness read after that `get` reads `pending`;
#      - the stub reports in only after the `send-keys`: the persona's
#        session registration line and the first harness read out of
#        `pending` both come after it;
#      - one of the persona's tmux-unresponsive ended lines
#        (`tmuxUnresponsiveEndedLines`) comes no later than the first harness
#        read out of `pending`;
#      - every retry line of the persona's retry timer (the retry builder's
#        line exactly, so never the re-armed line) is followed within
#        LT_RETRY_READ_S by a bot-server `status` or `get` of the row (and no
#        launch, above); how many there are is recorded, not asserted: a
#        retry is not certain, as the tmux-unresponsive condition ends before
#        the timer's first wait (UNAVAILABLE_RETRY_BASE_S) from the launch
#        timeout has passed, and that end keeps the timer only while the
#        row's last read is `pending` (src/unavailable-retry.ts
#        `conditionEnded`): an end that brings a live reading stops it;
#      - no conflict-latch line names the persona;
#      and no post reaches the Slack stub's record from the start on (no
#      spawn-failure or CONFLICT notice among them).
#   The server is then stopped with a plain `stop`, and [harness] each worker
#   ends with the sentinel (`stop --stop-bots` would wait out each persona's
#   pause, which the stub never answers, before its kill).
# Recorded, not asserted (ruling S8): the start pass's summary line, each
# persona's agent-director calls with their times, the plain spawns'
# collision lines, the timeout-phrase and get lines, its tmux-unresponsive
# and retry-timer lines, its number of retries, and the reuse row's
# claude_session_id before and after.
#
# The restart leg (`leg_restart_mid_launch`), in run order, in state dir
# `restart`, `health_check_interval` 0, one persona Q (working directory
# `restart`) with the dialog delay RESTART_DIALOG_DELAY_S:
#   1. The live start launches Q (the old server); [harness] Q's row reads
#      `pending` with a launch start L; the old server's approver has read
#      Q's pane, which shows no dialog yet.
#   2. [harness] A plain `stop` (no `--stop-bots`), then a live start (the
#      new server), both inside the delay (checked: the new start pass has
#      completed before L + RESTART_DIALOG_DELAY_S); the row still reads
#      `pending` with launch start L.
#   3. [harness] The row is read every RESTART_POLL_S until it leaves
#      `pending`, bounded at RESTART_CLEAR_BOUND_S from L; it reads `waiting`
#      with a claude_session_id.
#   4. Checks, over the CSCB processes' agent-director calls of Q's row:
#      - the new server launched nothing: its one plain spawn of Q (its start
#        pass's ladder's first step) is followed by its collision line
#        reading the row `pending`, and it made no reuse spawn, `resume` or
#        `kill` of Q;
#      - no approver of its own: no line of the new server's starts with
#        APPROVER_LOG_PREFIX and names Q, and its first `read-pane` of Q
#        comes at or after L + G;
#      - its lap's `send-keys` with `--allow-pending` follows that
#        `read-pane` before the first read out of `pending`, and it is the
#        only `send-keys` of Q from any CSCB process before then (the old
#        server's approver typed nothing);
#      - the old server's approver stopped at shutdown and armed nothing
#        (SRJ-404): the old server's log holds its shutdown stop line for Q
#        once, and no arm line for Q after it, neither armed nor not armed
#        (shutdown closes the retry controller before it stops the
#        approvers, so an arm after the stop would log the not-armed line).
#        The pending-row rule's run, which shutdown also rules out, is not
#        checked: for a row younger than G it writes no line;
#      - no post reaches the Slack stub's record in the leg.
#   The server is then stopped with a plain `stop`, and [harness] Q's worker
#   ends with the sentinel.
# Recorded, not asserted (ruling S8): the stop's and the start's times from
# L, both servers' calls of Q with their times, the old server's approver
# lines, and the new server's retry-timer and pending-row rule lines.
#
# Scenario 11's leg (`leg_fail_create`), in run order, in state dir
# `failcreate`, `health_check_interval` 0 (ruling S3: the failure arms the
# retry timer at once, so no tick is needed), one persona F (working
# directory `failcreate`, no dialog delay), the only persona the server
# launches while the shim is in `fail-create`. The harness runs no
# `find-missing` (SRJ-1401: F is not latched, so its row is marked by CSCB's
# own pending-row runs).
#   1. [harness] F's row is absent (a harness `get` answers ErrSpawnNotFound).
#   2. [harness] The tmux shim is set to `fail-create`, then the live start
#      makes F's plain spawn: agent-director writes the row, its
#      `new-session` call fails (the shim logs it, creates nothing and exits
#      1), and the spawn ends in ErrTmuxSessionCreate.
#   3. [harness] Once server.log holds the plain spawn's ErrTmuxSessionCreate
#      line for F (the launch call has ended), the shim is set back to `log`;
#      at least one `new-session` call reached the shim in `fail-create`.
#   4. [harness] A `get` reads F's row `pending` with a launch start L that
#      parses; a `list --state pending` lists F's row alone.
#   5. [harness] F's row is read every FC_POLL_S until it is live, bounded at
#      FC_BRINGUP_BOUND_S from L; each read before G that finds the row
#      `pending` with launch start L is followed by `list --state pending`,
#      which must list F's row alone. The row comes up `waiting` and the
#      server registers F's session.
#   6. Checks, over the bot server's agent-director calls (`call_table`):
#      - its one launch call (spawn or `resume`, any row) while the shim was
#        in `fail-create` is F's plain spawn (no `--reuse-finished`);
#      - no `find-missing` of its between L and G after it;
#      - F's next launch (the bot server's first spawn or `resume` of F's row
#        after the failed spawn) comes after its last `find-missing` before
#        that launch, which is at or after G, and after a `get` of F's row
#        between the two;
#      - exactly one PENDING_ROW_RULE_LOG_HEAD round line for F names its run
#        PENDING_ROW_RUN_MARKED_MISSING and its get `missing`, written no
#        later than F's next launch;
#      - [harness] a harness read of `missing`, when one caught it, comes
#        after that `find-missing`;
#      - no `kill` of F's row from any CSCB process, and no `find-missing` in
#        the leg from any process but the bot server (the scenario's shell
#        makes none);
#      - no post in the Slack stub's record holds "dispatcher bug" (matched
#        case-insensitively over the whole recorded post); at most one post
#        holds the spawn-failure notice's first line, and that one holds the
#        notice's head for ErrTmuxSessionCreate; no other post (no cap,
#        alert or stuck-launch post).
#   The server is then stopped with a plain `stop`, and [harness] F's worker
#   ends with the sentinel.
# Recorded, not asserted (ruling S8): the failure line and how many
# `new-session` calls failed, the start pass's summary, the harness reads in
# order (whether one caught `missing`), the bot server's calls of F's row
# and its `find-missing` runs with their times from L, F's retry-timer,
# pending-row rule and collision lines, the startup-errors.log lines naming
# F, and whether the counted failure posted a spawn-failure notice.
#
# Scenario 13's leg (`leg_still_stopping`), in run order, in state dir
# `paused`, one persona S (working directory `paused`, selected for the
# stub's `linger-on-exit`: the stub reports in at once, and answers the `/exit`
# that agent-director's `pause` types by firing SessionEnd, ending its MCP
# session and lingering, its process and tmux session still running, until
# `stub_release`, by its tmux session), with health ticks on (ruling S3): `health_check_interval`
# ST_TICK_S and `session_restart_delay` ST_RESTART_DELAY_S, through the
# config.
#   1. The live start brings S up: the row reads `waiting` with a
#      claude_session_id, the server registers the stub's MCP session as
#      S's, the bring-up's approver has stopped (APPROVER_QUIET_S with no
#      pane read), and the bring-up launch's pending-only retry timer has
#      stopped (as many stopped lines as armed lines), so the refusal below
#      arms a fresh timer.
#   2. A health tick reads S: the bot server's next `status` of S (with the
#      approver and the timer stopped, only a tick reads it) at T0.
#   3. [harness] At once, a harness `pause` of S from the scenario's own
#      shell, through the agent-director shim (a human's `pause`): it
#      returns success no later than ST_PAUSE_S after T0 (checked), the row
#      reads `ended` with the same claude_session_id, and the worker's tmux
#      session and pane process still run.
#   4. The stub's MCP session ended with SessionEnd, so the server schedules
#      S's restart; after the restart delay the restart path resumes S, and
#      agent-director refuses the resume: the row ended less than the
#      stopping window ago and its agent still runs.
#   5. [harness] Once server.log holds that refusal, `stub_release` releases
#      the worker at once (it waits for the stub's process to end); its tmux
#      session is gone within
#      ST_SESSION_END_WAIT_S.
#   6. The row reads `waiting` again with the same claude_session_id, and
#      the server registers the resumed stub's session as S's.
#   7. The next tick's read of S: the bot server's first `status` of S from
#      T0 + ST_TICK_S - ST_TICK_JITTER_S on, no later than T0 + ST_TICK_S +
#      ST_TICK_JITTER_S (checked).
#   8. Checks, over the bot server's agent-director calls of S's row
#      (`call_table`) and server.log:
#      - exactly two bot-server `resume`s of S after the pause, and no reuse
#        spawn (`spawn --reuse-finished`) or `kill` of S from any CSCB
#        process (each `resume` follows its ladder's plain spawn, which
#        collides with S's row: recorded);
#      - the first `resume` came inside the stopping window from the pause;
#      - exactly one server.log refusal of S's `resume` carries
#        STILL_STOPPING_PHRASE, between the two `resume`s;
#      - exactly one post-UNAVAILABLE get line for S's `resume` (SRJ-407),
#        and exactly one bot-server `get` of S from the refused `resume` to
#        that line;
#      - the retry timer's first retry line for S after the refusal comes
#        after the release and after the worker's session ended, and the
#        second `resume` follows it within ST_LAUNCH_SLACK_S, before the
#        next tick's read and before the row read `waiting` again: the
#        success is a retry's, not a tick's (SRD over the Epic and HO);
#      - no post reaches the Slack stub's record from the pause on: none
#        holds S's tmux-unresponsive onset (`tmuxUnresponsiveOnsetText`) or
#        the spawn-failure notice's first line, and there is no alert or
#        other post (SRJ-308: the single refusal cleared before the next
#        tick); checked here and again once the server has stopped (any post
#        the next tick's onset check made is in the record by then, as
#        shutdown ends every episode silently; the Slack stub still runs);
#      - no server.log line after the second `resume` names S with a
#        reconnect, relaunch, restart scheduling or not-connected text
#        (ruling S3: a tick acting on a stub with no MCP session stops the
#        run).
#   The server is then stopped with a plain `stop` (the record checks above
#   run again), and [harness] S's worker ends with the sentinel (`stop
#   --stop-bots` would pause it, and the stub would linger).
# Recorded, not asserted (ruling S8): what scheduled the resume (the
# restart-scheduling lines), the bot server's calls of S from the pause with
# their times from T0, the plain spawns' count and collision lines, the
# refusal line and every line naming S that carries
# STILL_STOPPING_PHRASE, the get line, S's retry-timer and tmux-unresponsive
# lines, and the times of the pause, the refused resume, the release, the
# retry, the second resume and the next tick from T0.
#
# Waits and their derivation (seconds):
# - Scenario 5's tick reads: health ticks fire every HEALTH_TICK_S, so a
#   hold of D seconds holds at least ⌊D / HEALTH_TICK_S⌋ tick instants, each
#   reading P's status once; one is allowed lost at the window's end (a tick
#   whose read lands just after its last pane read with no needle). An
#   approver lap's status read is followed by its `read-pane`, so among the
#   status reads not followed by a `read-pane` each tick read adds exactly
#   one (when it falls between a lap's two reads, the lap's status read is
#   the one counted) and a lap adds none by itself; other status-only reads,
#   such as a retry's, only raise the count.
# - DIALOG_DELAY_S = HEALTH_TICK_S + FORCED_RESUME_S + HOLD_SLACK_S: longer
#   than one health tick interval plus the forced `resume` (bounded at
#   FORCED_RESUME_S, checked) plus HOLD_SLACK_S for the resume's launch call
#   to the hold's first harness read; the run fails unless DIALOG_DELAY_S +
#   APPROVER_CLEAR_S is shorter than G, agent-director's default pending
#   grace period (DEFAULT_AD_SETTINGS), so the approver clears the dialog
#   at its 1 s pace, before G.
# - RESTART_DELAY_S is long enough for the harness to read the row `ended`
#   before the restart resumes it; RESUME_WAIT_S bounds the resume after the
#   sentinel (the restart delay, two health ticks and the launch call).
# - APPROVER_CLEAR_S bounds the dialog's clear after the delay's end: the
#   approver's next lap (its pace before G), its Enter and the stub's
#   report-in.
# - APPROVER_QUIET_S is three laps at the approver's pace before G
#   (DIALOG_POLL_INTERVAL_MS), rounded up to whole seconds: a running
#   approver reads the pane every lap while the row is pending, so that long
#   with no pane read after the row read `waiting` means it has stopped.
# - CREATE_DELAY_S = ⌈create_timeout_ms / 1000⌉ + CREATE_DELAY_MARGIN_S: the
#   slow-create wait, above agent-director's create timeout (so each launch
#   call ends in a launch timeout) and below CSCB's agent-director call
#   timeout (checked, so the call is not cut first).
# - LAUNCH_END_WAIT_S = the call timeout + 30: every launch call has ended
#   and its get line is logged (each call is bounded by the call timeout).
# - LT_DIALOG_DELAY_S = (number of personas) × ⌈create_timeout_ms / 1000⌉ +
#   LT_HOLD_SLACK_S: agent-director makes one launch's session-creating call
#   at a time, so the last launch call ends about one create timeout per
#   persona after the first launch start, and each get follows; the stub's
#   starting screen outlasts that, so a harness read after each get still
#   finds the row `pending` (without a delay the approver answers the dialog
#   within a fraction of a second of the get); it is shorter than G
#   (checked), so the approver answers at its 1 s pace.
# - LT_REPORT_WAIT_S bounds every row leaving `pending` after the launch
#   calls ended (the dialog delay, the approver's lap and the report-in).
# - LT_RETRY_WAIT_S = UNAVAILABLE_RETRY_BASE_S + LT_RETRY_SLACK_S: each
#   persona's retry timer, armed at its launch timeout, has run its first
#   retry and stopped. LT_RETRY_READ_S bounds a retry's row read after its
#   retry line.
# - RESTART_DIALOG_DELAY_S: longer than the stop and the start take (checked
#   against L), so the old server's approver finds no dialog to answer, and
#   shorter than G (checked), so the dialog shows when the lap from G reads
#   the pane.
# - RESTART_CLEAR_BOUND_S = G + UNAVAILABLE_RETRY_CEILING_S +
#   RESTART_LAP_SLACK_S, from L: the pending-row rule laps at the first retry
#   at or after G, and no retry wait is longer than the ceiling;
#   RESTART_LAP_SLACK_S covers the lap's calls, the stub's report-in and the
#   harness's read. OLD_APPROVER_WAIT_S bounds the old server's approver's
#   first pane read after the row read `pending`.
# - FC_BRINGUP_BOUND_S = G + UNAVAILABLE_RETRY_CEILING_S +
#   FC_BRINGUP_SLACK_S, from L: the failure armed F's retry timer, whose
#   retries run the pending-row rule; the first retry at or after G runs the
#   rule's `find-missing`, and no retry wait is longer than the ceiling;
#   FC_BRINGUP_SLACK_S covers the rule's calls, the restart path's launch
#   after the `missing` read (with `session_restart_delay`, 5 s in this
#   config, should it wait), the approver's Enter, the stub's report-in and
#   the harness's read. The failure itself is awaited within START_WAIT_S of
#   the start.
# - Scenario 13: ST_TICK_S = ST_PAUSE_S + ST_RESTART_DELAY_S +
#   ST_LAUNCH_SLACK_S + UNAVAILABLE_RETRY_BASE_S + ST_LAUNCH_SLACK_S. From
#   T0 (a tick's read) come the pause (bounded at ST_PAUSE_S, checked), the
#   restart delay, the restart path's calls up to its refused `resume`
#   (ST_LAUNCH_SLACK_S), the retry timer's first wait from the refusal
#   (UNAVAILABLE_RETRY_BASE_S) and the retry's calls up to its `resume`
#   (ST_LAUNCH_SLACK_S, checked), so the tick interval exceeds
#   UNAVAILABLE_RETRY_BASE_S (checked) and the retry after the release comes
#   before the next tick. The refused `resume` is due within ST_PAUSE_S +
#   ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S of T0, shorter than the stopping
#   window (DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds; checked, and
#   the first `resume`'s time from the pause is checked against it), so it
#   meets "still stopping". The release follows the refusal at once, well
#   inside the retry's first wait (checked: the retry line comes after the
#   release and the session's end). ST_TIMER_WAIT_S = UNAVAILABLE_RETRY_BASE_S
#   + LT_RETRY_SLACK_S bounds the bring-up timer's stop.
#
# Matched values. CSCB's values are printed by fixtures/fmk-texts.ts from
# the installed package, never retyped: APPROVER_LOG_PREFIX,
# DEV_CHANNELS_DIALOG_NEEDLE, TRUST_DIALOG_NEEDLE, DIALOG_POLL_INTERVAL_MS and
# LAUNCH_UNAVAILABLE_OUTCOME_APPROVER (src/session-manager.ts); G and
# create_timeout_ms (src/ad-settings.ts DEFAULT_AD_SETTINGS.tmux
# .pending_grace_seconds and .create_timeout_ms); the call timeout
# (src/config.ts DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS);
# LAUNCH_TIMEOUT_PHRASE (src/ad-description-phrases.ts);
# UNAVAILABLE_RETRY_BASE_S and UNAVAILABLE_RETRY_CEILING_S
# (src/unavailable-retry.ts); PENDING_ROW_RULE_LOG_HEAD and
# PENDING_ROW_RUN_MARKED_MISSING (src/pending-row.ts); each persona's
# tmux-unresponsive ended lines (src/persona-episodes.ts
# tmuxUnresponsiveEndedLine over the reasons of TMUX_UNRESPONSIVE_END_TEXT,
# entry `tmuxUnresponsiveEndedLines`); and the spawn-failure notice's head
# for ErrTmuxSessionCreate (src/session-manager.ts spawnFailureNoticeText,
# the body notifySpawnFailure posts; entry `spawnFailureNoticeHead`), whose
# first line is matched on its own to find any spawn-failure post. Scenario
# 13's: STILL_STOPPING_PHRASE (src/ad-description-phrases.ts), the stopping
# window (src/ad-settings.ts DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds)
# and S's tmux-unresponsive onset body (src/persona-episodes.ts
# tmuxUnresponsiveOnsetText, entry `tmuxUnresponsiveOnsetText`).
# Log lines with an exported builder are matched by what fmk-texts.ts cuts
# from the builder, per persona key or reference, a variable part cut at a
# marker:
# - the head of every retry-timer line (RT_LINE_HEAD, entry
#   `unavailableRetryLineHead`: the head unavailableRetryArmedLine,
#   unavailableRetryRetryLine, unavailableRetryReArmedLine and
#   unavailableRetryStoppedLine share), for the recorded lines; the arm
#   line's head in either mode (RT_ARMED, `unavailableRetryArmedHead`), the
#   stop line's (RT_STOPPED, `unavailableRetryStoppedHead`) and the
#   not-armed line's (RT_NOT_ARMED, `unavailableRetryNotArmedHead`, from
#   unavailableRetryNotArmedClosedLine); the retry line in its parts
#   (`unavailableRetryRetryLineParts`), matched whole (`retry_hits`: the
#   head, a number and one of its two tails, so the re-armed line, which
#   starts the same way, never matches) (all src/unavailable-retry.ts);
# - the post-UNAVAILABLE get line's head before the call's name (GET_HEAD)
#   and its text from after the name to the form (GET_OF, entry
#   `launchUnavailableGetLineParts`, src/session-manager.ts
#   launchUnavailableGetLine); the form right after it: each launch-timeout
#   form's text (FORM_CALL_TIMEOUT and FORM_TMUX_UNRESPONSIVE, entry
#   `launchUnavailableFormText` with the src/ad-error-class.ts export names
#   LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT and LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE)
#   or a plain UNAVAILABLE's head (FORM_UNAVAILABLE_HEAD, `none`;
#   src/session-manager.ts launchUnavailableFormText);
# - the head of the tmux-unresponsive lines (TU_HEAD, entry
#   `tmuxUnresponsiveLineHead`, src/persona-episodes.ts
#   tmuxUnresponsiveLine), for the recorded condition lines;
# - the approver's shutdown stop line for Q (entry `approverShutdownStopLine`:
#   src/session-manager.ts approverLogLine of approverStopRequestedMessage
#   with APPROVER_STOP_SHUTDOWN), matched as a whole line.
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - `resume` (RESUME_WHAT), the call's name the post-UNAVAILABLE get line
#   gives a `resume` (src/session-manager.ts, the resume site's literal);
# - `[slack] spawnForPersona: collision resolved, state=` and `for <ref>`
#   (src/session-manager.ts runPersonaLadder's collision line);
# - `[slack] conflict-latch: persona=<key> ` (src/conflict-latch.ts, the
#   latch record's lines);
# - `[slack] spawnForPersona: `, `failed for <ref>: ` and ErrTmuxSessionCreate
#   (src/session-manager.ts plainSpawnFailedAt, the LAUNCH FAILURE line, with
#   describeAgentDirectorFailure's error name; ErrTmuxSessionCreate is
#   agent-director's error name);
# - `find-missing: ` and `get: missing` in the pending-row rule's round line
#   (src/pending-row.ts createPendingRowRule's step words and describeRuleGet;
#   `missing` is agent-director's state name);
# - "dispatcher bug", quoted from b.jg5 SRJ-1413 for the absence check;
# - ` rule (` after PENDING_ROW_RULE_LOG_HEAD and the reference
#   (src/pending-row.ts, the rule's run line);
# - `Scheduling restart for persona=<key>` (src/restart.ts scheduleRestart);
# - the hold's trouble words `reconnect`, `relaunch`, `Scheduling restart`
#   and `not connected` (src/restart.ts, src/session-manager.ts; matched
#   case-insensitively on lines naming P's key or reference, and S's in
#   scenario 13);
# - `[slack] spawnForPersona: resume refused for <ref>: ` (src/session-manager.ts
#   logRefusal, the refusal line, with `resume` as the call);
# - the forced resume's notice lines on the driver's standard error:
#   `no notifier installed — notice for persona=<key> not posted`
#   (src/session-manager.ts sendPersonaNotice, ruling S7) and
#   `[fmk-driver] outage-notice persona=<key>: ` (fixtures/fmk-driver.ts);
# - the driver's outcome fields `called=`, `counted=`, `error=` (the
#   fmk-driver.ts outcome line) and ErrSpawnNotResumable (agent-director's
#   error name); ErrSpawnNotFound (agent-director's error name; a harness
#   `get` of a row not yet made reads `absent`);
# - the stub's sentinel `__CSCB_TEST_EXIT__` (fixtures/stub-claude.sh);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef) and the instance id
#   `cscb_<key>` (src/persona-identity.ts personaInstanceId).
# Every match on a persona is whole: no persona's name, key or row id is a
# prefix of another's, a key is matched as `persona=<key>` followed by no
# key character (`naming_persona`) or with the text after it, and a row id as
# a whole word of the call (` --claude-instance-id <id> `).
#
# Closing: the script ends with `assert_no_server_tmux` (AC 3's "the bot
# server starts no tmux process", over every leg's servers, the slow-create
# and fail-create starts' included), `assert_no_cscb_include_finished` and
# `assert_no_cscb_delete` in its own shell. Every count of CSCB's
# agent-director calls reads only shim lines whose parent is a CSCB process;
# the harness's calls, the stub's own status reads and its stop lines never
# count.
set -euo pipefail

TEST_NAME="test-17-fmk-launch-pending"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona P, its key, row and channel. src/persona-identity.ts
# personaInstanceId: `cscb_<key>`.
P_NAME="${SCENARIO_TAG}_p"
P_KEY="$(persona_key "${P_NAME}")"
P_REF="$(persona_ref "${P_NAME}")"
P_ID="cscb_${P_KEY}"
P_CHANNEL="C0T17PND1"

# CSCB's config for the leg (seconds), and the derived dialog delay.
HEALTH_TICK_S=3
RESTART_DELAY_S=5
FORCED_RESUME_S=20
HOLD_SLACK_S=7
DIALOG_DELAY_S=$(( HEALTH_TICK_S + FORCED_RESUME_S + HOLD_SLACK_S ))
APPROVER_CLEAR_S=15

# Bounds (seconds).
STUB_WAIT_S=20        # the Slack stub writing its ready file
START_WAIT_S=120      # the start pass: one bring-up and one launch
REPORT_WAIT_S=60      # after the start pass: the approver's Enter and the row reporting in
CONNECT_WAIT_S=30     # after the row reported in: the server registering the stub's session
APPROVER_STOP_WAIT_S=20  # after the session connected: the bring-up's approver stopping
ENDED_WAIT_S=20       # after the sentinel: the row reading ended or missing
RESUME_WAIT_S=$(( RESTART_DELAY_S + 2 * HEALTH_TICK_S + 30 ))
SESSION_WAIT_S=10     # after the hold's first pending read: P's tmux session present
DIALOG_WAIT_S=$(( DIALOG_DELAY_S + 10 ))

# The fixtures the leg runs.
FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"
FMK_DRIVER="${SCENARIO_FIXTURES}/fmk-driver.ts"
PKG_DIR="${SCENARIO_REPO}/node_modules/claude-slack-channel-bots"

# agent-director's error name the forced `resume` gets on a `pending` row.
NOT_RESUMABLE=ErrSpawnNotResumable

# The hold's trouble words (case-insensitive ERE; see the header).
HOLD_TROUBLE='reconnect|relaunch|Scheduling restart|not[- ]connected'

# The launch-timeout legs' personas, by role: `spawn` (no row: a plain
# spawn), `reuse` (a finished row in another working directory: a reuse
# spawn) and `resume` (a finished row with its claude_session_id: a resume).
LT_ROLES=(spawn reuse resume)
declare -A LT_NAME=([spawn]="${SCENARIO_TAG}_spawn" [reuse]="${SCENARIO_TAG}_reuse" [resume]="${SCENARIO_TAG}_resume")
declare -A LT_CHANNEL=([spawn]=C0T17SPN1 [reuse]=C0T17REU1 [resume]=C0T17RSM1)
declare -A LT_SUFFIX=([spawn]=t17s [reuse]=t17u [resume]=t17m)
declare -A LT_KEY=() LT_REF=() LT_ID=() LT_WORK=()
for role in "${LT_ROLES[@]}"; do
    LT_KEY[${role}]="$(persona_key "${LT_NAME[${role}]}")"
    LT_REF[${role}]="$(persona_ref "${LT_NAME[${role}]}")"
    LT_ID[${role}]="cscb_${LT_KEY[${role}]}"
done

# The restart leg's persona Q.
Q_NAME="${SCENARIO_TAG}_restart"
Q_KEY="$(persona_key "${Q_NAME}")"
Q_REF="$(persona_ref "${Q_NAME}")"
Q_ID="cscb_${Q_KEY}"
Q_CHANNEL="C0T17RST1"
Q_SUFFIX=t17q

# The launch-timeout legs (seconds).
CREATE_DELAY_MARGIN_S=10  # the slow-create delay past agent-director's create timeout
LT_HOLD_SLACK_S=8         # the dialog delay past the last launch call's end
LT_REPORT_WAIT_S=60       # after the launch calls ended: every row out of pending
LT_RETRY_READ_S=5         # after a retry line: that retry's read of the row
LT_RETRY_SLACK_S=30       # past the retry timer's first wait: each persona's timer stopped

# The restart leg (seconds).
RESTART_DIALOG_DELAY_S=30 # longer than the stop and the start take, shorter than G (checked)
RESTART_LAP_SLACK_S=10    # past G and the retry ceiling: the lap's calls, the report-in, the harness read
OLD_APPROVER_WAIT_S=15    # after the row read pending: the old server's approver reading the pane
RESTART_POLL_S=1          # the harness's read of the row while it waits for the lap

# Scenario 11's persona F (no row before its leg).
F_NAME="${SCENARIO_TAG}_failed"
F_KEY="$(persona_key "${F_NAME}")"
F_REF="$(persona_ref "${F_NAME}")"
F_ID="cscb_${F_KEY}"
F_CHANNEL="C0T17FCR1"
F_SUFFIX=t17f

# Scenario 11's leg (seconds).
FC_BRINGUP_SLACK_S=40     # past G and the retry ceiling: the rule's calls, the bring-up's launch, the approver, the report-in
FC_POLL_S=1               # the harness's read of the row while it waits

# agent-director's error name for a launch whose session-creating call failed.
SESSION_CREATE_ERR=ErrTmuxSessionCreate

# The words SRJ-1413 says no post holds.
DISPATCHER_BUG='dispatcher bug'

# Scenario 13's persona S (working directory `paused`, selected for the
# stub's linger-on-exit). No persona's name, key or row id is a prefix of
# another's.
S_NAME="${SCENARIO_TAG}_stopping"
S_KEY="$(persona_key "${S_NAME}")"
S_REF="$(persona_ref "${S_NAME}")"
S_ID="cscb_${S_KEY}"
S_CHANNEL="C0T17PSE1"
S_SUFFIX=t17z

# Scenario 13's leg (seconds; see the header for ST_TICK_S's derivation).
ST_RESTART_DELAY_S=3      # session_restart_delay: the restart the session's end schedules
ST_PAUSE_S=5              # from the tick read the pause follows to the pause's return (checked)
ST_LAUNCH_SLACK_S=10      # a restart run's or a retry's calls before its resume (checked for the retry)
ST_TICK_JITTER_S=2        # the next tick's read, against the first read plus the interval
ST_SESSION_END_WAIT_S=10  # after the release: the lingering worker's tmux session gone

# The call's name (`what`) the post-UNAVAILABLE get line gives a `resume`
# (src/session-manager.ts, the resume site's literal; no export).
RESUME_WHAT=resume

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the time now, epoch seconds with microseconds (the shim logs' clock).
now_s() {
    printf '%s\n' "${EPOCHREALTIME/,/.}"
}

# Print <b> - <a>, both seconds with decimals.
seconds_between() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", b - a }'
}

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value for
# <entry>, read from the package the server and the driver run (PKG_DIR).
fmk_text() {
    CSCB_PKG_DIR="${PKG_DIR}" bun --no-install "${FMK_TEXTS}" "$@"
}

# text_parts <array-name> <count> <entry> <arg>: set the array to the lines
# of fixtures/fmk-texts.ts's value for <entry> <arg>; fail unless there are
# <count> lines, none empty.
text_parts() {
    local -n text_parts_out="$1"
    local value part
    value="$(fmk_text "$3" "$4")" || fail "setup: fmk-texts.ts could not print $3 $4"
    mapfile -t text_parts_out <<< "${value}"
    (( ${#text_parts_out[@]} == $2 )) || fail "setup: fmk-texts.ts printed ${#text_parts_out[@]} line(s) for $3 $4, not $2"
    for part in "${text_parts_out[@]}"; do
        [[ -n "${part}" ]] || fail "setup: fmk-texts.ts printed an empty line for $3 $4"
    done
}

# key_text <array-name> <entry> <key>: set the associative array's element
# <key> to fixtures/fmk-texts.ts's one-line value for <entry> <key> (a head
# cut from the entry's builder); fail when it is empty or cannot be printed.
key_text() {
    local -n key_text_out="$1"
    local value
    value="$(fmk_text "$2" "$3")" || fail "setup: fmk-texts.ts could not print $2 $3"
    [[ -n "${value}" && "${value}" != *$'\n'* ]] || fail "setup: fmk-texts.ts printed no one-line value for $2 $3"
    key_text_out["$3"]="${value}"
}

# naming_persona <key> <ref>: print the lines of standard input that name
# persona <key> whole (`persona=<key>` followed by no key character) or hold
# its reference <ref>, so no other persona's key or reference matches.
naming_persona() {
    awk -v k="persona=$1" -v r="$2" '
        {
            hit = index($0, r) > 0
            s = $0
            while (!hit && (p = index(s, k)) > 0) {
                c = substr(s, p + length(k), 1)
                if (c !~ /[a-z0-9_]/) hit = 1
                s = substr(s, p + length(k))
            }
            if (hit) print
        }'
}

# retry_hits <from-line> <head> <tail>...: `log_hits`'s output for the
# server.log lines after <from-line> whose text after the `[<ISO time>] `
# head is exactly <head>, a whole number and one of the <tail>s: the retry
# lines (fmk-texts.ts `unavailableRetryRetryLineParts`), never the re-armed
# line, which starts the same way.
retry_hits() {
    python3 - "${SLACK_STATE_DIR}/server.log" "$@" << 'EOF'
import datetime, re, sys
path, start, head, tails = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
line_re = re.compile(re.escape(head) + "[0-9]+(?:" + "|".join(re.escape(t) for t in tails) + ")")
try:
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
except FileNotFoundError:
    sys.exit(0)
for n, text in enumerate(lines, 1):
    if n <= start or not text.startswith("[") or "] " not in text:
        continue
    at = text.index("] ")
    if not line_re.fullmatch(text[at + 2:]):
        continue
    try:
        t = datetime.datetime.strptime(text[1:at], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        continue
    print(f"{n}\t{t:.3f}\t{text}")
EOF
}

# start_slack_stub <dir> <suffix>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <suffix> and refusing any
# other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and SLACK_RECORD.
start_slack_stub() {
    local dir="$1" step="slack stub" api_url
    shift
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "$@" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
    SLACK_RECORD="${dir}/record.jsonl"
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SLACK_RECORD}" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# Print the Slack stub record's posts (chat.* and files.* methods), one JSON
# object per line, from record line <from> on (default 1).
record_posts() {
    [[ -f "${SLACK_RECORD}" ]] || return 0
    tail -n "+${1:-1}" "${SLACK_RECORD}" \
        | jq -c 'select(.event == "api" and ((.method // "") | test("^(chat|files)\\.")))'
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# read_row_of <id> <step>: a harness `get` of row <id>. Sets ROW_READ_AT (the
# time just before the call), ROW_STATE, ROW_SID (claude_session_id),
# ROW_LAUNCH (launch_started_at as printed) and ROW_SESSION
# (tmux_session_name), each empty when absent.
read_row_of() {
    local id="$1" fields
    ROW_READ_AT="$(now_s)"
    ad_capture get --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .claude_session_id // "", (.launch_started_at // "" | tostring), .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$2: the harness get of ${id} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_LAUNCH ROW_SESSION <<< "${fields}"
}

# read_row <step>: `read_row_of` for P's row.
read_row() {
    read_row_of "${P_ID}" "$1"
}

# row_of_reads <id> <step> <state>...: read row <id>; true when its state is
# one of the <state>s.
row_of_reads() {
    local id="$1" step="$2" s
    shift 2
    read_row_of "${id}" "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# row_reads <step> <state>...: `row_of_reads` for P's row.
row_reads() {
    row_of_reads "${P_ID}" "$@"
}

# row_left_pending <step>: read the row; true once its state is not `pending`.
row_left_pending() {
    read_row "$1"
    [[ -n "${ROW_STATE}" && "${ROW_STATE}" != pending ]]
}

# pane_capture <step> <session> <file>: P's pane on the scenario's tmux
# server, read with the real tmux from the scenario's own shell, into <file>.
pane_capture() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -t "=$2:" > "$3" 2> "$3.err" \
        || fail "$1: tmux could not read the pane of session $2: $(head -c 300 "$3.err")"
}

# has_session <session>: true when the scenario's tmux server holds it.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# expect_no_needle <step> <file>: fail when <file> holds either approver needle.
expect_no_needle() {
    local needle
    for needle in "${DEV_NEEDLE}" "${TRUST_NEEDLE}"; do
        ! grep -qF -- "${needle}" "$2" || fail "$1: P's pane holds the approver needle '${needle}' during the delay"
    done
}

# server_calls <verb> <from> <to> [<fragment>...]: print the agent-director
# shim's `call` lines naming P's row whose parent is the bot server
# (SERVER_PID), whose verb is <verb> and whose arguments hold every
# <fragment> in order (`cscb_ad_calls`), with a time after <from> and at or
# before <to> (`-` for no bound).
server_calls() {
    server_calls_of "${P_ID}" "$@"
}

# server_calls_of <id> <verb> <from> <to> [<fragment>...]: `server_calls` for
# row <id>, named whole (` --claude-instance-id <id> ` in the line's words),
# so another row whose id <id> is a prefix of is never counted.
server_calls_of() {
    local id="$1" verb="$2" from="$3" to="$4" lines=()
    shift 4
    mapfile -t lines < <(cscb_ad_calls "${verb}" "--claude-instance-id ${id}" "$@")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" -v id="${id}" -v a="${from}" -v b="${to}" '
        $4 == p && index(" " $6 " ", " --claude-instance-id " id " ") \
            && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)'
}

# server_count <verb> <from> <to> [<fragment>...]: how many lines
# `server_calls` prints.
server_count() {
    local out
    out="$(server_calls "$@")"
    if [[ -z "${out}" ]]; then
        echo 0
        return 0
    fi
    wc -l <<< "${out}" | tr -d ' '
}

# approver_quiet: true once the bot server's last pane read of P (if any) is
# at least APPROVER_QUIET_S old: at the approver's pace a running approver
# reads the pane every lap while the row is pending, and stops with no pane
# read once its lap's status read finds the row live.
approver_quiet() {
    approver_quiet_of "${P_ID}"
}

# approver_quiet_of <id>...: `approver_quiet` for every row <id>.
approver_quiet_of() {
    local id last
    for id in "$@"; do
        last="$(server_calls_of "${id}" read-pane - - | tail -n 1 | cut -f2)"
        [[ -z "${last}" ]] && continue
        awk -v t="${last}" -v n="$(now_s)" -v q="${APPROVER_QUIET_S}" 'BEGIN { exit !(n - t >= q) }' || return 1
    done
    return 0
}

# any_calls_naming <verb> <from> <to>: print every agent-director shim `call`
# line, from any parent, whose words hold <verb> and P's row id, each as a
# whole word, with a time in (<from>, <to>] (`-` for no bound).
any_calls_naming() {
    any_calls_naming_of "${P_ID}" "$@"
}

# any_calls_naming_of <id> <verb> <from> <to>: `any_calls_naming` for row <id>.
any_calls_naming_of() {
    awk -F'\t' -v v="$2" -v id="$1" -v a="$3" -v b="$4" '
        $1 == "call" && index(" " $6 " ", " " v " ") && index(" " $6 " ", " " id " ") \
            && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)
    ' "${SCENARIO_AD_SHIM_LOG}"
}

# call_table <file>: write <file>, one TAB-separated line per agent-director
# shim `call` line whose parent is a CSCB process (`cscb_ad_calls`), in log
# order: its time, its PPID (the CSCB process), its verb, the row id its
# `--claude-instance-id` names (`-` when none) and its arguments joined by
# single spaces. Read once per check, so each check reads the shim's log
# once.
call_table() {
    local out="$1" line time id i
    : > "${out}"
    while IFS= read -r line; do
        _scenario_split_line "${line}" && _scenario_decode_words || fail "call_table: a shim log line does not parse: ${line}"
        _scenario_ad_verb
        time="${line#*$'\t'}"
        time="${time%%$'\t'*}"
        id=-
        for (( i = 0; i < ${#_L_ARGS[@]}; i++ )); do
            case "${_L_ARGS[i]}" in
                --claude-instance-id) id="${_L_ARGS[i + 1]:--}" ;;
                --claude-instance-id=*) id="${_L_ARGS[i]#*=}" ;;
            esac
        done
        printf '%s\t%s\t%s\t%s\t%s\n' "${time}" "${_L_PPID}" "${_L_VERB}" "${id}" "${_L_ARGS[*]}" >> "${out}"
    done < <(cscb_ad_calls "")
}

# calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: print the
# `call_table` lines whose PPID is <ppid> (`-` for any CSCB process), whose
# row is <id>, whose verb is <verb> (`-` for any), whose time is in
# (<from>, <to>] (`-` for no bound), whose arguments hold every <word> as a
# whole argument and no `!<word>`.
calls() {
    local table="$1" ppid="$2" id="$3" verb="$4" from="$5" to="$6"
    shift 6
    awk -F'\t' -v p="${ppid}" -v id="${id}" -v v="${verb}" -v a="${from}" -v b="${to}" -v w="$*" '
        BEGIN { n = split(w, want, " ") }
        (p == "-" || $2 == p) && $4 == id && (v == "-" || $3 == v) \
            && (a == "-" || $1 + 0 > a + 0) && (b == "-" || $1 + 0 <= b + 0) {
            m = split($5, args, " ")
            for (k in has) delete has[k]
            for (i = 1; i <= m; i++) has[args[i]] = 1
            ok = 1
            for (i = 1; i <= n; i++) {
                x = want[i]
                if (substr(x, 1, 1) == "!") { if (substr(x, 2) in has) ok = 0 }
                else if (!(x in has)) ok = 0
            }
            if (ok) print
        }' "${table}"
}

# count_calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: how
# many lines `calls` prints.
count_calls() {
    calls "$@" | wc -l | tr -d ' '
}

# first_call_at <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...:
# the time of the first line `calls` prints (empty when none).
first_call_at() {
    calls "$@" | head -n 1 | cut -f1
}

# log_hits <from-line> <fragment>...: print `<line number> TAB <time> TAB
# <text>` for each line of $SLACK_STATE_DIR/server.log after line
# <from-line> that holds every fixed-string <fragment> in order, <time> being
# the line's `[<ISO time>]` head (src/logging.ts) in epoch seconds, three
# decimals.
log_hits() {
    python3 - "${SLACK_STATE_DIR}/server.log" "$@" << 'EOF'
import datetime, sys
path, start, frags = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
try:
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
except FileNotFoundError:
    sys.exit(0)
for n, text in enumerate(lines, 1):
    if n <= start or not text.startswith("[") or "] " not in text:
        continue
    rest, ok = text, True
    for f in frags:
        p = rest.find(f)
        if p < 0:
            ok = False
            break
        rest = rest[p + len(f):]
    if not ok:
        continue
    head = text[1:text.index("] ")]
    try:
        t = datetime.datetime.strptime(head, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        continue
    print(f"{n}\t{t:.3f}\t{text}")
EOF
}

# posts_to <channel> <from-time>: print the Slack stub record's posts
# (`record_posts`) to <channel> (any channel when empty) recorded in the
# second of <from-time> (epoch seconds) or later, one JSON object per line,
# text cut to 200 characters.
posts_to() {
    record_posts 1 | jq -c --arg c "$1" --argjson t "$2" '
        select(($c == "" or (.channel // "") == $c) and ((.ts // "" | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= ($t | floor)))
        | {ts, method, channel, text: ((.text // "") | .[0:200])}'
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

APPROVER_PREFIX="$(fmk_text APPROVER_LOG_PREFIX)" || fail "setup: fmk-texts.ts could not print APPROVER_LOG_PREFIX"
DEV_NEEDLE="$(fmk_text DEV_CHANNELS_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print DEV_CHANNELS_DIALOG_NEEDLE"
TRUST_NEEDLE="$(fmk_text TRUST_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print TRUST_DIALOG_NEEDLE"
G_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds"
PACE_MS="$(fmk_text DIALOG_POLL_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print DIALOG_POLL_INTERVAL_MS"
[[ "${PACE_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the approver's pace '${PACE_MS}' is not a whole number of milliseconds"
# Three approver laps' worth of time, in whole seconds (at least one).
APPROVER_QUIET_S=$(( (3 * PACE_MS + 999) / 1000 ))
[[ -n "${APPROVER_PREFIX}" && -n "${DEV_NEEDLE}" && -n "${TRUST_NEEDLE}" ]] || fail "setup: fmk-texts.ts printed an empty value"
[[ "${G_S}" =~ ^[0-9]+$ ]] || fail "setup: G '${G_S}' is not a whole number of seconds"
(( DIALOG_DELAY_S + APPROVER_CLEAR_S < G_S )) \
    || fail "setup: the dialog delay ${DIALOG_DELAY_S}s plus the approver's clear ${APPROVER_CLEAR_S}s is not shorter than G ${G_S}s"
echo "${TEST_NAME}: G ${G_S}s; dialog delay ${DIALOG_DELAY_S}s (tick ${HEALTH_TICK_S}s + forced resume ${FORCED_RESUME_S}s + slack ${HOLD_SLACK_S}s)"

CREATE_TIMEOUT_MS="$(fmk_text DEFAULT_AD_SETTINGS.tmux.create_timeout_ms)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.create_timeout_ms"
CALL_TIMEOUT_MS="$(fmk_text DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS"
TIMEOUT_PHRASE="$(fmk_text LAUNCH_TIMEOUT_PHRASE)" || fail "setup: fmk-texts.ts could not print LAUNCH_TIMEOUT_PHRASE"
OUTCOME_APPROVER="$(fmk_text LAUNCH_UNAVAILABLE_OUTCOME_APPROVER)" \
    || fail "setup: fmk-texts.ts could not print LAUNCH_UNAVAILABLE_OUTCOME_APPROVER"
RETRY_BASE_S="$(fmk_text UNAVAILABLE_RETRY_BASE_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_BASE_S"
RETRY_CEILING_S="$(fmk_text UNAVAILABLE_RETRY_CEILING_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_CEILING_S"
PENDING_ROW_HEAD="$(fmk_text PENDING_ROW_RULE_LOG_HEAD)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_LOG_HEAD"
# How the post-UNAVAILABLE get line names the outcome: each launch-timeout
# form, and the head of a plain UNAVAILABLE.
FORM_CALL_TIMEOUT="$(fmk_text launchUnavailableFormText LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT)" \
    || fail "setup: fmk-texts.ts could not print launchUnavailableFormText LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT"
FORM_TMUX_UNRESPONSIVE="$(fmk_text launchUnavailableFormText LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE)" \
    || fail "setup: fmk-texts.ts could not print launchUnavailableFormText LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE"
FORM_UNAVAILABLE_HEAD="$(fmk_text launchUnavailableFormText none)" || fail "setup: fmk-texts.ts could not print launchUnavailableFormText none"
[[ -n "${PENDING_ROW_HEAD}" && -n "${FORM_CALL_TIMEOUT}" && -n "${FORM_TMUX_UNRESPONSIVE}" && -n "${FORM_UNAVAILABLE_HEAD}" ]] \
    || fail "setup: fmk-texts.ts printed an empty value"
[[ "${CREATE_TIMEOUT_MS}" =~ ^[1-9][0-9]*$ && "${CALL_TIMEOUT_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the create timeout '${CREATE_TIMEOUT_MS}' or the call timeout '${CALL_TIMEOUT_MS}' is not a whole number of milliseconds"
[[ "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ && "${RETRY_CEILING_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the retry base '${RETRY_BASE_S}' or ceiling '${RETRY_CEILING_S}' is not a whole number of seconds"
[[ -n "${TIMEOUT_PHRASE}" && -n "${OUTCOME_APPROVER}" ]] || fail "setup: fmk-texts.ts printed an empty value"
# The slow-create delay: above agent-director's create timeout, below CSCB's call timeout.
CREATE_DELAY_S=$(( (CREATE_TIMEOUT_MS + 999) / 1000 + CREATE_DELAY_MARGIN_S ))
(( CREATE_DELAY_S * 1000 > CREATE_TIMEOUT_MS && CREATE_DELAY_S * 1000 < CALL_TIMEOUT_MS )) \
    || fail "setup: the slow-create delay ${CREATE_DELAY_S}s is not between the create timeout ${CREATE_TIMEOUT_MS}ms and the call timeout ${CALL_TIMEOUT_MS}ms"
# The start pass's launch calls end within CSCB's call timeout; then each one's get.
LAUNCH_END_WAIT_S=$(( CALL_TIMEOUT_MS / 1000 + 30 ))
# The launch-timeout legs' dialog delay: agent-director makes one launch's
# session-creating call at a time, so the last launch call ends about one
# create timeout per persona after the first launch start, and each get
# follows; the delay outlasts that by LT_HOLD_SLACK_S, so a harness read after
# each get still finds the row pending at its starting screen.
LT_DIALOG_DELAY_S=$(( ${#LT_ROLES[@]} * ((CREATE_TIMEOUT_MS + 999) / 1000) + LT_HOLD_SLACK_S ))
(( LT_DIALOG_DELAY_S < G_S )) || fail "setup: the launch-timeout legs' dialog delay ${LT_DIALOG_DELAY_S}s is not shorter than G ${G_S}s"
# Each persona's retry timer, armed at its launch timeout, has run its first retry or stopped.
LT_RETRY_WAIT_S=$(( RETRY_BASE_S + LT_RETRY_SLACK_S ))
(( RESTART_DIALOG_DELAY_S < G_S )) \
    || fail "setup: the restart leg's dialog delay ${RESTART_DIALOG_DELAY_S}s is not shorter than G ${G_S}s"
# The restart leg's wait: from the launch start, G and one longest retry wait, then the lap and the report-in.
RESTART_CLEAR_BOUND_S=$(( G_S + RETRY_CEILING_S + RESTART_LAP_SLACK_S ))
echo "${TEST_NAME}: slow-create delay ${CREATE_DELAY_S}s (create timeout ${CREATE_TIMEOUT_MS}ms, call timeout ${CALL_TIMEOUT_MS}ms); retry base ${RETRY_BASE_S}s, ceiling ${RETRY_CEILING_S}s; restart leg: dialog delay ${RESTART_DIALOG_DELAY_S}s, clear bound ${RESTART_CLEAR_BOUND_S}s"

MARKED_MISSING="$(fmk_text PENDING_ROW_RUN_MARKED_MISSING)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RUN_MARKED_MISSING"
SPAWN_FAILURE_HEAD="$(fmk_text spawnFailureNoticeHead "${SESSION_CREATE_ERR}")" \
    || fail "setup: fmk-texts.ts could not print spawnFailureNoticeHead"
# The notice's first line, the same for every error.
SPAWN_FAILURE_FIRST="${SPAWN_FAILURE_HEAD%%$'\n'*}"
[[ -n "${MARKED_MISSING}" && -n "${SPAWN_FAILURE_FIRST}" && "${SPAWN_FAILURE_HEAD}" == *"${SESSION_CREATE_ERR}"* ]] \
    || fail "setup: fmk-texts.ts printed an empty value, or a spawn-failure notice head naming no ${SESSION_CREATE_ERR}"
# Scenario 11's wait: from the launch start, G and one longest retry wait, then the bring-up.
FC_BRINGUP_BOUND_S=$(( G_S + RETRY_CEILING_S + FC_BRINGUP_SLACK_S ))
echo "${TEST_NAME}: scenario 11: bring-up bound ${FC_BRINGUP_BOUND_S}s from the launch start"

STILL_STOPPING="$(fmk_text STILL_STOPPING_PHRASE)" || fail "setup: fmk-texts.ts could not print STILL_STOPPING_PHRASE"
STOP_WINDOW_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds"
S_ONSET="$(fmk_text tmuxUnresponsiveOnsetText "${S_KEY}")" || fail "setup: fmk-texts.ts could not print tmuxUnresponsiveOnsetText"
[[ -n "${STILL_STOPPING}" && -n "${S_ONSET}" ]] || fail "setup: fmk-texts.ts printed an empty value"
[[ "${STOP_WINDOW_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the stopping window '${STOP_WINDOW_S}' is not a whole number of seconds"
# Scenario 13's tick interval: from the tick read the pause follows, the
# pause, the restart delay and the restart run's calls before its refused
# resume, then the retry timer's first wait and the retry's calls before its
# resume, all before the next tick.
ST_TICK_S=$(( ST_PAUSE_S + ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S + RETRY_BASE_S + ST_LAUNCH_SLACK_S ))
(( ST_TICK_S > RETRY_BASE_S )) || fail "setup: scenario 13's tick interval ${ST_TICK_S}s is not longer than the retry base ${RETRY_BASE_S}s"
(( ST_PAUSE_S + ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S < STOP_WINDOW_S )) \
    || fail "setup: scenario 13's refused resume is not due inside the stopping window ${STOP_WINDOW_S}s"
# The bring-up launch's pending-only retry timer has run its first retry and stopped.
ST_TIMER_WAIT_S=$(( RETRY_BASE_S + LT_RETRY_SLACK_S ))
echo "${TEST_NAME}: scenario 13: stopping window ${STOP_WINDOW_S}s, health tick ${ST_TICK_S}s, restart delay ${ST_RESTART_DELAY_S}s, retry base ${RETRY_BASE_S}s"

# The log lines with exported builders, per persona key, each printed by
# fmk-texts.ts (see the header): the head of every retry-timer line
# (RT_LINE_HEAD), of the arm line in either mode (RT_ARMED), of the stop line
# (RT_STOPPED), of the not-armed line (RT_NOT_ARMED), the retry line's parts
# (RT_RETRY_HEAD, then RT_RETRY_FULL or RT_RETRY_PENDING after its number),
# the head of the tmux-unresponsive lines (TU_HEAD), and the
# post-UNAVAILABLE get line's text between the call's name and the form
# (GET_OF; GET_HEAD before the call's name, the same for every persona).
declare -A RT_LINE_HEAD=() RT_ARMED=() RT_STOPPED=() RT_NOT_ARMED=() RT_RETRY_HEAD=() RT_RETRY_FULL=() RT_RETRY_PENDING=()
declare -A TU_HEAD=() GET_OF=()
GET_HEAD=""

# retry_texts <key>: RT_LINE_HEAD, RT_STOPPED, the retry line's parts and
# TU_HEAD for <key>.
retry_texts() {
    local parts=()
    key_text RT_LINE_HEAD unavailableRetryLineHead "$1"
    key_text RT_STOPPED unavailableRetryStoppedHead "$1"
    key_text TU_HEAD tmuxUnresponsiveLineHead "$1"
    text_parts parts 3 unavailableRetryRetryLineParts "$1"
    RT_RETRY_HEAD[$1]="${parts[0]}"
    RT_RETRY_FULL[$1]="${parts[1]}"
    RT_RETRY_PENDING[$1]="${parts[2]}"
}

# get_line_texts <key> <ref>: GET_OF for <key> (persona reference <ref>),
# and GET_HEAD, which must be the same for every reference.
get_line_texts() {
    local parts=()
    text_parts parts 2 launchUnavailableGetLineParts "$2"
    [[ -z "${GET_HEAD}" || "${GET_HEAD}" == "${parts[0]}" ]] \
        || fail "setup: the get line's head for $2 is '${parts[0]}', not '${GET_HEAD}'"
    GET_HEAD="${parts[0]}"
    GET_OF[$1]="${parts[1]}"
}

for role in "${LT_ROLES[@]}"; do
    retry_texts "${LT_KEY[${role}]}"
    get_line_texts "${LT_KEY[${role}]}" "${LT_REF[${role}]}"
done
key_text RT_LINE_HEAD unavailableRetryLineHead "${Q_KEY}"
key_text RT_ARMED unavailableRetryArmedHead "${Q_KEY}"
key_text RT_NOT_ARMED unavailableRetryNotArmedHead "${Q_KEY}"
Q_SHUTDOWN_STOP="$(fmk_text approverShutdownStopLine "${Q_REF}")" || fail "setup: fmk-texts.ts could not print approverShutdownStopLine"
[[ -n "${Q_SHUTDOWN_STOP}" ]] || fail "setup: fmk-texts.ts printed an empty approverShutdownStopLine"
key_text RT_LINE_HEAD unavailableRetryLineHead "${F_KEY}"
retry_texts "${S_KEY}"
key_text RT_ARMED unavailableRetryArmedHead "${S_KEY}"
get_line_texts "${S_KEY}" "${S_REF}"

# ---------------------------------------------------------------------------
# Scenario 5's leg
# ---------------------------------------------------------------------------

leg_launch_pending() {
    local step="scenario 5" creds work connected sid session sentinel_at resume_line resume_at
    local hold_at hold_log0 hold_log1 posts0 launch_ms drv_out drv_err drv_rc=0 drv_at drv_end drv_s
    local drv_line drv_pid outcome=() lines=() line verb launches=0 pane="${SCENARIO_ROOT}/p-pane.txt"
    local deadline last_clear="" dialog_at="" live_at statuses panes ticks want_ticks n first_send first_read hits
    local restart_lines

    # Step 1: the live start brings P up.
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    work="$(make_workdir p)"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub" t17p1
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot t17p1)" "$(fake_token app t17p1)" \
        | write_file "${creds}/p.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${P_NAME}",
      "credentials_file": "${creds}/p.json",
      "working_directory": "${work}",
      "channels": [{ "id": "${P_CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${P_CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": ${HEALTH_TICK_S},
  "session_restart_delay": ${RESTART_DELAY_S},
  "exit_timeout": 5
}
EOF
    start_server --live
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${P_ID} never reported in (waiting) after the start" \
        row_reads "${step}: bring-up" waiting
    sid="${ROW_SID}"
    session="${ROW_SESSION}"
    [[ -n "${sid}" ]] || fail "${step}: the live row ${P_ID} has no claude_session_id"
    [[ -n "${session}" ]] || fail "${step}: the live row ${P_ID} names no tmux session"
    # src/server.ts: the MCP session's registration line.
    connected="$(matcher "[slack] Session connected: persona ${P_REF}")"
    wait_for_log "${connected}" "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as P's"
    # The bring-up's approver has stopped (its lap after the Enter read the
    # row live): no bot-server pane read of P for APPROVER_QUIET_S.
    wait_until "${APPROVER_STOP_WAIT_S}" "${step}: the bot server still reads P's pane ${APPROVER_STOP_WAIT_S}s after the bring-up" \
        approver_quiet

    # Step 2 [harness]: the dialog delay in P's working directory.
    stub_dialog_delay "${work}" "${DIALOG_DELAY_S}"

    # Step 3 [harness]: P's worker ends with the stub's sentinel.
    sentinel_at="$(now_s)"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" __CSCB_TEST_EXIT__ Enter \
        || fail "${step}: could not send the sentinel into ${session}"
    wait_until "${ENDED_WAIT_S}" "${step}: row ${P_ID} never read ended or missing after the sentinel" \
        row_reads "${step}: after the sentinel" ended missing
    [[ "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: the ${ROW_STATE} row's claude_session_id is '${ROW_SID}', not the live row's ${sid}"
    echo "${TEST_NAME}: ${step}: after the sentinel the row reads ${ROW_STATE} with claude_session_id ${ROW_SID}"

    # Step 4: the bot server resumes P through its restart path.
    wait_until "${RESUME_WAIT_S}" "${step}: row ${P_ID} never read pending after the sentinel (no resume)" \
        row_reads "${step}: the resume" pending
    hold_at="${ROW_READ_AT}"
    hold_log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"

    # Step 5: the hold. The row: pending, the same session id, a launch start.
    [[ "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: the pending row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    [[ -n "${ROW_LAUNCH}" ]] || fail "${step}: the pending row has no launch_started_at"
    launch_ms="$(date -u -d "${ROW_LAUNCH}" +%s%3N 2> /dev/null)" && [[ "${launch_ms}" =~ ^[0-9]+$ ]] \
        || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    echo "${TEST_NAME}: ${step}: the held row reads pending, claude_session_id ${ROW_SID}, launch_started_at ${ROW_LAUNCH}"
    [[ -z "${ROW_SESSION}" ]] || session="${ROW_SESSION}"
    restart_lines="$(grep -F -- "Scheduling restart for persona=${P_KEY} " "${SLACK_STATE_DIR}/server.log" || true)"
    echo "${TEST_NAME}: ${step}: what scheduled the restart (src/restart.ts scheduleRestart lines): ${restart_lines:-none}"

    # The leg's one resume: the bot server's, after the sentinel.
    mapfile -t lines < <(server_calls resume "${sentinel_at}" -)
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} resume call(s) of ${P_ID} by the bot server after the sentinel, not one"
    resume_line="${lines[0]}"
    resume_at="$(cut -f2 <<< "${resume_line}")"
    (( $(server_count resume - "${sentinel_at}") == 0 )) \
        || fail "${step}: the bot server resumed ${P_ID} before the sentinel"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} from the sentinel to the resume (recorded, not asserted): $(server_calls "" "${sentinel_at}" "${resume_at}" | cut -f6 | tr '\n' ';')"

    # The pane: present, and showing neither needle.
    wait_until "${SESSION_WAIT_S}" "${step}: no tmux session ${session} for the held row" has_session "${session}"
    pane_capture "${step}" "${session}" "${pane}"
    expect_no_needle "${step}: at the hold's first read" "${pane}"

    # The forced resume (fixtures/fmk-driver.ts, a CSCB process).
    drv_out="${SCENARIO_ROOT}/fmk-driver-resume.out"
    drv_err="${SCENARIO_ROOT}/fmk-driver-resume.err"
    drv_at="$(now_s)"
    cscb_run env "CSCB_PKG_DIR=${PKG_DIR}" "DRIVER_PERSONA=${P_NAME}" "DRIVER_PERSONA_CHANNEL=${P_CHANNEL}" \
        "DRIVER_WORKING_DIRECTORY=${work}" bun --no-install "${FMK_DRIVER}" resume \
        < /dev/null > "${drv_out}" 2> "${drv_err}" || drv_rc=$?
    drv_end="$(now_s)"
    drv_s="$(seconds_between "${drv_at}" "${drv_end}")"
    mapfile -t outcome < <(grep -E '^DRIVER(_FAIL)?:' "${drv_out}" || true)
    if (( drv_rc != 0 || ${#outcome[@]} != 1 )) || [[ "${outcome[0]}" != "DRIVER: FORCED resume "* ]]; then
        sed 's/^/  | /' "${drv_out}" >&2
        tail -n 20 "${drv_err}" | sed 's/^/  | /' >&2
        fail "${step}: the forced resume exited ${drv_rc} with ${#outcome[@]} outcome line(s) (first: ${outcome[0]:-none})"
    fi
    drv_line="${outcome[0]}"
    echo "${TEST_NAME}: ${step}: the forced resume (${drv_s}s): ${drv_line:0:600}"
    awk -v s="${drv_s}" -v b="${FORCED_RESUME_S}" 'BEGIN { exit !(s <= b) }' \
        || fail "${step}: the forced resume took ${drv_s}s, longer than FORCED_RESUME_S ${FORCED_RESUME_S}s the dialog delay is derived from"
    [[ "${drv_line}" == *" called=true "* ]] || fail "${step}: the forced resume was not called: ${drv_line}"
    [[ "${drv_line}" == *" error=${NOT_RESUMABLE} "* ]] || fail "${step}: the forced resume did not get ${NOT_RESUMABLE}: ${drv_line}"
    [[ "${drv_line}" == *" counted=false "* ]] || fail "${step}: the forced resume's ${NOT_RESUMABLE} was counted: ${drv_line}"
    echo "${TEST_NAME}: ${step}: the forced resume's own fields (recorded, not asserted):$(grep -oE ' (action|latched|class)=[^ ]+' <<< "${drv_line}" | tr '\n' ' ')"
    # It posted nothing: the driver installs no notifier, so a notice would
    # be logged on its stderr by either sink, never posted: src/session-manager.ts
    # sendPersonaNotice's no-notifier line (no export; ruling S7), or the
    # driver's own outage-notice line (fixtures/fmk-driver.ts).
    hits="$(grep -F -e "no notifier installed — notice for persona=${P_KEY} not posted" \
        -e "[fmk-driver] outage-notice persona=${P_KEY}: " "${drv_err}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: the forced resume tried to post a notice for P (its line on the driver's stderr)"
    fi
    # It is the driver's only launch call (spawn or resume).
    line="$(awk -F'\t' -v w="fmk-driver.ts resume" '$1 == "proc" && $2 == "run" && index($6, w) { l = $0 } END { print l }' "${SCENARIO_CSCB_RECORD}")"
    drv_pid="$(cut -f3 <<< "${line}")"
    [[ "${drv_pid}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    mapfile -t lines < <(awk -F'\t' -v p="${drv_pid}" -v a="${drv_at}" '$1 == "call" && $4 == p && $2 + 0 >= a + 0' "${SCENARIO_AD_SHIM_LOG}")
    for line in "${lines[@]}"; do
        _scenario_split_line "${line}" && _scenario_decode_words || fail "${step}: a driver call line does not parse: ${line}"
        _scenario_ad_verb
        case "${_L_VERB}" in
            spawn) fail "${step}: the driver made a spawn: ${line}" ;;
            resume)
                [[ " ${_L_ARGS[*]} " == *" --claude-instance-id ${P_ID} "* ]] \
                    || fail "${step}: the driver's resume names another row: ${line}"
                launches=$(( launches + 1 )) ;;
        esac
    done
    (( launches == 1 )) || fail "${step}: the driver made ${launches} resume call(s), not one"

    # Still held once the driver returned.
    read_row "${step}: after the forced resume"
    [[ "${ROW_STATE}" == pending && "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: after the forced resume the row reads ${ROW_STATE} (${ROW_SID}), not still pending: the delay ended too soon"
    # This capture, with no needle, is the hold's first known clear read: the
    # delay's end is bounded below from it even when the loop below finds
    # the dialog at its first read.
    last_clear="$(now_s)"
    pane_capture "${step}" "${session}" "${pane}"
    if grep -qF -- "${DEV_NEEDLE}" "${pane}"; then
        fail "${step}: the dialog showed before the forced resume returned (${drv_s}s): the hold did not cover it"
    fi
    expect_no_needle "${step}: after the forced resume" "${pane}"

    # Step 6 [harness]: read the pane until the dialog shows (the delay's end).
    deadline=$(( $(_scenario_now_ms) + DIALOG_WAIT_S * 1000 ))
    while :; do
        line="$(now_s)"
        pane_capture "${step}" "${session}" "${pane}"
        if grep -qF -- "${DEV_NEEDLE}" "${pane}"; then
            dialog_at="${line}"
            break
        fi
        expect_no_needle "${step}: before the dialog" "${pane}"
        last_clear="${line}"
        (( $(_scenario_now_ms) < deadline )) || fail "${step}: P's pane never showed the dev-channels dialog within ${DIALOG_WAIT_S}s"
        sleep "${SCENARIO_POLL_S}"
    done
    echo "${TEST_NAME}: ${step}: the dialog showed between $(seconds_between "${hold_at}" "${last_clear}")s and $(seconds_between "${hold_at}" "${dialog_at}")s after the hold's first read"
    awk -v s="$(seconds_between "${hold_at}" "${last_clear}")" -v t="${HEALTH_TICK_S}" 'BEGIN { exit !(s >= t) }' \
        || fail "${step}: the hold lasted less than one health tick interval (${HEALTH_TICK_S}s)"
    awk -v a="${drv_end}" -v b="${last_clear}" 'BEGIN { exit !(a <= b) }' \
        || fail "${step}: the forced resume did not end inside the hold"

    # ... then the row until it leaves pending: waiting, the same session id.
    wait_until "${APPROVER_CLEAR_S}" "${step}: row ${P_ID} still pending ${APPROVER_CLEAR_S}s after the dialog showed" \
        row_left_pending "${step}: after the dialog"
    live_at="${ROW_READ_AT}"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: the row left pending for ${ROW_STATE}, not waiting"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the waiting row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    hold_log1="$(line_count "${SLACK_STATE_DIR}/server.log")"

    # Step 7: the checks. Health ticks ran in the hold: the bot server's
    # status reads of P whose next call of P's row (status or read-pane) is
    # not a read-pane (an approver lap reads status, then the pane; a tick
    # reads status only) number at least one per health tick interval in the
    # hold, less one (see the header).
    statuses="$(server_count status "${hold_at}" "${last_clear}")"
    panes="$(server_count read-pane "${hold_at}" "${last_clear}")"
    ticks="$({ server_calls status - -; server_calls read-pane - -; } | sort -t $'\t' -k2,2n \
        | awk -F'\t' -v a="${hold_at}" -v b="${last_clear}" '
            { verb = (index(" " $6 " ", " read-pane ") ? "pane" : "status") }
            prev_status && verb != "pane" { n++ }
            { prev_status = (verb == "status" && $2 + 0 > a + 0 && $2 + 0 <= b + 0) }
            END { if (prev_status) n++; print n + 0 }')"
    want_ticks="$(awk -v a="${hold_at}" -v b="${last_clear}" -v t="${HEALTH_TICK_S}" 'BEGIN { n = int((b - a) / t) - 1; print (n < 0 ? 0 : n) }')"
    echo "${TEST_NAME}: ${step}: in the hold before the dialog ($(seconds_between "${hold_at}" "${last_clear}")s): ${statuses} status read(s) and ${panes} read-pane call(s) of P by the bot server, ${ticks} status read(s) with no read-pane after them (at least ${want_ticks} wanted)"
    (( ticks >= want_ticks )) \
        || fail "${step}: only ${ticks} bot-server status read(s) of P in the hold had no read-pane after them, fewer than ${want_ticks}: health ticks did not read it every ${HEALTH_TICK_S}s"

    # No spawn, reuse, resume or kill of P by the bot server after the resume.
    for verb in spawn resume kill; do
        n="$(server_count "${verb}" "${resume_at}" -)"
        (( n == 0 )) || fail "${step}: the bot server made ${n} ${verb} call(s) of ${P_ID} after the leg's resume"
    done

    # No send-keys of P from any process between the resume and the delay's end.
    mapfile -t lines < <(any_calls_naming send-keys "${resume_at}" "${last_clear}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} send-keys call(s) of ${P_ID} before the delay ended"
    }
    # Every send-keys of P after the resume: the bot server's, with --allow-pending.
    mapfile -t lines < <(any_calls_naming send-keys "${resume_at}" -)
    (( ${#lines[@]} >= 1 )) || fail "${step}: no send-keys of ${P_ID} after the resume"
    for line in "${lines[@]}"; do
        [[ "$(cut -f4 <<< "${line}")" == "${SERVER_PID}" && "${line}" == *--allow-pending* ]] || {
            echo "  | ${line}" >&2
            fail "${step}: a send-keys of ${P_ID} after the resume is not the bot server's with --allow-pending"
        }
    done
    # After the delay's end: a bot-server read-pane, then its send-keys, both
    # with --allow-pending, before the first read that is not pending.
    first_send="$(server_calls send-keys "${last_clear}" "${live_at}" --allow-pending | head -n 1 | cut -f2)"
    [[ -n "${first_send}" ]] \
        || fail "${step}: no bot-server send-keys of ${P_ID} with --allow-pending between the delay's end and the first read that is not pending"
    first_read="$(server_calls read-pane "${last_clear}" "${first_send}" --allow-pending | head -n 1 | cut -f2)"
    [[ -n "${first_read}" ]] \
        || fail "${step}: no bot-server read-pane of ${P_ID} with --allow-pending between the delay's end and its send-keys"
    echo "${TEST_NAME}: ${step}: after the delay's end: read-pane at +$(seconds_between "${last_clear}" "${first_read}")s, send-keys at +$(seconds_between "${last_clear}" "${first_send}")s, waiting read at +$(seconds_between "${last_clear}" "${live_at}")s"

    # No post in the hold.
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) reached the Slack stub's record while the row was pending"
    }

    # Ruling S3: no reconnect, relaunch or not-connected line for P in the hold.
    hits="$(sed -n "$(( hold_log0 + 1 )),${hold_log1}p" "${SLACK_STATE_DIR}/server.log" \
        | naming_persona "${P_KEY}" "${P_REF}" | grep -iE "${HOLD_TROUBLE}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: in the hold the server logged a reconnect, relaunch or not-connected line for P (ruling S3: a health tick acted on the stub's missing MCP session)"
    fi

    # Ruling S7: no approver line names P across the leg.
    expect_count "$(matcher "${APPROVER_PREFIX}" "${P_REF}")" 0 "${step}: approver lines naming P"

    # Every post across the leg (recorded, not asserted).
    mapfile -t lines < <(record_posts 1 | jq -c '{method, channel, text: ((.text // "") | .[0:160])}')
    echo "${TEST_NAME}: ${step}: ${#lines[@]} post(s) across the leg"
    for line in "${lines[@]}"; do
        echo "${TEST_NAME}: ${step}:   ${line}"
    done

    stop_server --stop-bots
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}


# ---------------------------------------------------------------------------
# Helpers of the launch-timeout and restart legs
# ---------------------------------------------------------------------------

# persona_json <name> <credentials-file> <working-dir> <channel>: one persona
# object of the config.
persona_json() {
    jq -n -c --arg n "$1" --arg c "$2" --arg w "$3" --arg ch "$4" \
        '{name: $n, credentials_file: $c, working_directory: $w, channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}'
}

# write_personas_config <persona-json>...: the config with those personas and
# the health check off (`health_check_interval` 0, ruling S3).
write_personas_config() {
    printf '%s\n' "$@" | jq -s --argjson port "${SCENARIO_PORT}" \
        '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: 0, session_restart_delay: 5, exit_timeout: 5}' \
        | write_config
}

# poll_row_of <id> <step>: `read_row_of`, except that a row agent-director
# does not know (ErrSpawnNotFound) reads ROW_STATE `absent` instead of
# failing.
poll_row_of() {
    local id="$1" fields
    ROW_READ_AT="$(now_s)"
    ad_capture get --claude-instance-id "${id}"
    if (( AD_RC != 0 )); then
        if grep -qF ErrSpawnNotFound "${AD_OUT}" "${AD_ERR}"; then
            ROW_STATE=absent ROW_SID="" ROW_LAUNCH="" ROW_SESSION=""
            return 0
        fi
        fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fi
    fields="$(jq -r '[.state // "", .claude_session_id // "", (.launch_started_at // "" | tostring), .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$2: the harness get of ${id} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_LAUNCH ROW_SESSION <<< "${fields}"
}

# launch_ms <text>: print a launch_started_at as epoch milliseconds; false
# when it does not parse.
launch_ms() {
    local ms
    ms="$(date -u -d "$1" +%s%3N 2> /dev/null)" && [[ "${ms}" =~ ^[0-9]+$ ]] && printf '%s\n' "${ms}"
}

# plus_s <time> <seconds>: print <time> + <seconds>, three decimals.
plus_s() {
    awk -v t="$1" -v d="$2" 'BEGIN { printf "%.3f\n", t + d }'
}

# timeout_get_lines_seen <from-line>: true once each launch-timeout persona
# has its post-timeout get line after server.log line <from-line>.
timeout_get_lines_seen() {
    local role
    for role in "${LT_ROLES[@]}"; do
        [[ -n "$(log_hits "$1" "${GET_HEAD}" "${GET_OF[${LT_KEY[${role}]}]}")" ]] || return 1
    done
}

# lt_timers_stopped <from-line>: true once each launch-timeout persona's retry
# timer has a stopped line after server.log line <from-line>.
lt_timers_stopped() {
    local role
    for role in "${LT_ROLES[@]}"; do
        [[ -n "$(log_hits "$1" "${RT_STOPPED[${LT_KEY[${role}]}]}")" ]] || return 1
    done
}

# server_read_pane_seen <id>: true once the bot server has read row <id>'s pane.
server_read_pane_seen() {
    [[ -n "$(server_calls_of "$1" read-pane - -)" ]]
}

# end_worker <id> <step>: a plain stop has left row <id>'s worker running;
# end it with the stub's sentinel, sent into its pane with the real tmux, and
# wait until the row reads ended or missing.
end_worker() {
    read_row_of "$1" "$2"
    [[ -n "${ROW_SESSION}" ]] || fail "$2: row $1 names no tmux session"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${ROW_SESSION}:" __CSCB_TEST_EXIT__ Enter \
        || fail "$2: could not send the sentinel into ${ROW_SESSION}"
    wait_until "${ENDED_WAIT_S}" "$2: row $1 never read ended or missing after the sentinel" \
        row_of_reads "$1" "$2" ended missing
}

# ---------------------------------------------------------------------------
# The launch-timeout legs: a plain spawn, a reuse and a resume (slow-create)
# ---------------------------------------------------------------------------

leg_launch_timeouts() {
    local step="launch timeouts" creds="${SCENARIO_ROOT}/credentials-lt" role id ref key verb
    local log0 lt_start reset_at="" deadline left reads="${SCENARIO_ROOT}/lt-reads.tsv" table="${SCENARIO_ROOT}/lt-calls.tsv"
    local -A sid=() out_at=() out_state=() out_sid=() launch_at=() get_at=() send_at=() pane_at=()
    local lines=() hits=() posts=() n t connected_at ended pend srv

    # Step 1: the reuse and resume personas are brought up, then their workers end.
    new_state_dir bringup
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-lt" "${LT_SUFFIX[@]}"
    for role in "${LT_ROLES[@]}"; do
        printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${LT_SUFFIX[${role}]}")" "$(fake_token app "${LT_SUFFIX[${role}]}")" \
            | write_file "${creds}/${role}.json" 600
    done
    LT_WORK[reuse]="$(make_workdir reuse-a)"
    LT_WORK[resume]="$(make_workdir resume)"
    write_personas_config \
        "$(persona_json "${LT_NAME[reuse]}" "${creds}/reuse.json" "${LT_WORK[reuse]}" "${LT_CHANNEL[reuse]}")" \
        "$(persona_json "${LT_NAME[resume]}" "${creds}/resume.json" "${LT_WORK[resume]}" "${LT_CHANNEL[resume]}")"
    start_server --live
    wait_for_log "$(completion_match 2)" "${START_WAIT_S}" "${step}: the bring-up's start pass never completed"
    expect_completion 2 "${step}: the bring-up" "0 not brought up"
    for role in reuse resume; do
        wait_until "${REPORT_WAIT_S}" "${step}: row ${LT_ID[${role}]} never reported in (waiting) at the bring-up" \
            row_of_reads "${LT_ID[${role}]}" "${step}: the bring-up" waiting
        sid[${role}]="${ROW_SID}"
        [[ -n "${sid[${role}]}" ]] || fail "${step}: the live ${role} row ${LT_ID[${role}]} has no claude_session_id"
        wait_for_log "$(matcher "[slack] Session connected: persona ${LT_REF[${role}]}")" "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the ${role} persona's session at the bring-up"
    done
    wait_until "${APPROVER_STOP_WAIT_S}" "${step}: the bot server still reads a bring-up pane ${APPROVER_STOP_WAIT_S}s after the bring-up" \
        approver_quiet_of "${LT_ID[reuse]}" "${LT_ID[resume]}"
    # A plain stop leaves the workers running, and no restart path runs when they end.
    stop_server
    for role in reuse resume; do
        end_worker "${LT_ID[${role}]}" "${step}: the ${role} worker"
        [[ "${ROW_SID}" == "${sid[${role}]}" ]] \
            || fail "${step}: the ${ROW_STATE} ${role} row's claude_session_id is '${ROW_SID}', not the live row's ${sid[${role}]}"
        echo "${TEST_NAME}: ${step}: the ${role} row reads ${ROW_STATE} with claude_session_id ${ROW_SID}"
    done

    # Step 2: the three personas, the reuse persona in another working
    # directory, in a new state dir (a start reads its state dir's
    # last-applied configuration; a change to it waits for a reload). Each
    # working directory has the dialog delay.
    new_state_dir launch
    LT_WORK[spawn]="$(make_workdir spawn)"
    LT_WORK[reuse]="$(make_workdir reuse-b)"
    for role in "${LT_ROLES[@]}"; do
        stub_dialog_delay "${LT_WORK[${role}]}" "${LT_DIALOG_DELAY_S}"
    done
    write_personas_config \
        "$(persona_json "${LT_NAME[spawn]}" "${creds}/spawn.json" "${LT_WORK[spawn]}" "${LT_CHANNEL[spawn]}")" \
        "$(persona_json "${LT_NAME[reuse]}" "${creds}/reuse.json" "${LT_WORK[reuse]}" "${LT_CHANNEL[reuse]}")" \
        "$(persona_json "${LT_NAME[resume]}" "${creds}/resume.json" "${LT_WORK[resume]}" "${LT_CHANNEL[resume]}")"

    # Step 3: slow-create, then the start.
    tmux_shim_mode slow-create "${CREATE_DELAY_S}"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    lt_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Steps 4 and 5 [harness]: read the three rows until each has left
    # pending; once every launch call has ended in its get, the shim goes back
    # to `log`.
    : > "${reads}"
    deadline=$(( $(_scenario_now_ms) + (LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S) * 1000 ))
    while :; do
        if [[ -z "${reset_at}" ]] && timeout_get_lines_seen "${log0}"; then
            tmux_shim_mode log
            reset_at="$(now_s)"
            echo "${TEST_NAME}: ${step}: every launch call ended in its get by $(seconds_between "${lt_start}" "${reset_at}")s after the start; the tmux shim is back in log mode"
        fi
        left=0
        for role in "${LT_ROLES[@]}"; do
            [[ -n "${out_at[${role}]:-}" ]] && continue
            poll_row_of "${LT_ID[${role}]}" "${step}: ${role}"
            printf '%s\t%s\t%s\n' "${role}" "${ROW_READ_AT}" "${ROW_STATE}" >> "${reads}"
            case "${ROW_STATE}" in
                absent | ended | missing | pending) left=1 ;;
                *)
                    out_at[${role}]="${ROW_READ_AT}"
                    out_state[${role}]="${ROW_STATE}"
                    out_sid[${role}]="${ROW_SID}" ;;
            esac
        done
        (( left )) || break
        if (( $(_scenario_now_ms) >= deadline )); then
            [[ -n "${reset_at}" ]] || fail "${step}: the three launch calls had not all ended in their get within ${LAUNCH_END_WAIT_S}s"
            fail "${step}: not every row left pending within ${LT_REPORT_WAIT_S}s of the launch calls' end"
        fi
        sleep "${SCENARIO_POLL_S}"
    done
    [[ -n "${reset_at}" ]] || fail "${step}: a row left pending before every launch call had ended in its get"
    wait_for_log "$(completion_match 3)" "${START_WAIT_S}" "${step}: the timeout start's start pass never completed"
    echo "${TEST_NAME}: ${step}: the timeout start's summary (recorded): $(log_hits "${log0}" "$(completion_match 3)" | tail -n 1 | cut -f3)"
    for role in "${LT_ROLES[@]}"; do
        [[ "${out_state[${role}]}" == waiting ]] || fail "${step}: ${role}: the row left pending for ${out_state[${role}]}, not waiting"
        wait_for_log "$(matcher "[slack] Session connected: persona ${LT_REF[${role}]}")" "${CONNECT_WAIT_S}" \
            "${step}: ${role}: the server never registered the persona's session after its launch timeout"
    done
    [[ "${out_sid[resume]}" == "${sid[resume]}" ]] \
        || fail "${step}: resume: the waiting row's claude_session_id is '${out_sid[resume]}', not the resumed ${sid[resume]}"
    echo "${TEST_NAME}: ${step}: the reuse row's claude_session_id was ${sid[reuse]} and is now ${out_sid[reuse]} (recorded)"

    # Step 6: each persona's retry timer has stopped (recorded when not).
    _scenario_poll_until "${LT_RETRY_WAIT_S}" lt_timers_stopped "${log0}" \
        || echo "${TEST_NAME}: ${step}: not every retry timer had stopped ${LT_RETRY_WAIT_S}s after the launches (recorded)"

    # Step 7: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    for role in "${LT_ROLES[@]}"; do
        id="${LT_ID[${role}]}" ref="${LT_REF[${role}]}" key="${LT_KEY[${role}]}"
        echo "${TEST_NAME}: ${step}: ${role}: the bot server's calls of ${id} (recorded): $(calls "${table}" "${srv}" "${id}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"

        # The launch, of its kind: the plain spawn carries no --reuse-finished,
        # the reuse spawn carries it, the third is a resume. The reuse's and
        # the resume's own plain spawn collided first (recorded).
        case "${role}" in
            spawn)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" spawn - - '!--reuse-finished')"
                n="$(count_calls "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} reuse spawn(s) of ${id}"
                n="$(count_calls "${table}" "${srv}" "${id}" resume - -)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} resume(s) of ${id}" ;;
            reuse)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                n="$(count_calls "${table}" "${srv}" "${id}" resume - -)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} resume(s) of ${id}" ;;
            resume)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" resume - -)"
                n="$(count_calls "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} reuse spawn(s) of ${id}" ;;
        esac
        [[ -n "${launch_at[${role}]}" ]] || fail "${step}: ${role}: the bot server made no launch of its kind for ${id}"
        if [[ "${role}" != spawn ]]; then
            echo "${TEST_NAME}: ${step}: ${role}: its plain spawn's collision (recorded): $(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=" "for ${ref}" | cut -f3 | tr '\n' '|')"
        fi

        # The launch timeout: a server.log line naming the persona carries
        # LAUNCH_TIMEOUT_PHRASE (or the get line names ErrCallTimeout), and
        # its one post-timeout get line started the approver.
        mapfile -t hits < <(log_hits "${log0}" "${TIMEOUT_PHRASE}" | naming_persona "${key}" "${ref}")
        mapfile -t lines < <(log_hits "${log0}" "${GET_HEAD}" "${GET_OF[${key}]}")
        (( ${#lines[@]} == 1 )) || fail "${step}: ${role}: ${#lines[@]} post-timeout get line(s) for ${ref}, not one"
        echo "${TEST_NAME}: ${step}: ${role}: ${#hits[@]} server.log line(s) naming it carry the launch-timeout phrase; its get line: $(cut -f3 <<< "${lines[0]}")"
        (( ${#hits[@]} > 0 )) || [[ "${lines[0]}" == *"${GET_OF[${key}]}${FORM_CALL_TIMEOUT}"* ]] \
            || fail "${step}: ${role}: no server.log line naming ${ref} carries the launch-timeout phrase, and its get line names no '${FORM_CALL_TIMEOUT}'"
        [[ "${lines[0]}" == *"${GET_OF[${key}]}${FORM_CALL_TIMEOUT}"* || "${lines[0]}" == *"${GET_OF[${key}]}${FORM_TMUX_UNRESPONSIVE}"* ]] \
            || fail "${step}: ${role}: its get line names no launch timeout ('${FORM_CALL_TIMEOUT}' or '${FORM_TMUX_UNRESPONSIVE}')"
        [[ "${lines[0]}" == *"${OUTCOME_APPROVER}"* ]] || fail "${step}: ${role}: its get line did not start the approver"

        # One bot-server get after the launch, then read-pane and send-keys
        # with --allow-pending, and no spawn, reuse or resume after it.
        pane_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" read-pane "${launch_at[${role}]}" - --allow-pending)"
        [[ -n "${pane_at[${role}]}" ]] || fail "${step}: ${role}: no bot-server read-pane of ${id} with --allow-pending after its launch"
        n="$(count_calls "${table}" "${srv}" "${id}" get "${launch_at[${role}]}" "${pane_at[${role}]}")"
        (( n == 1 )) || fail "${step}: ${role}: ${n} bot-server get(s) of ${id} between its launch and its first read-pane, not one"
        get_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" get "${launch_at[${role}]}" -)"
        send_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" send-keys "${pane_at[${role}]}" - --allow-pending)"
        [[ -n "${send_at[${role}]}" ]] || fail "${step}: ${role}: no bot-server send-keys of ${id} with --allow-pending after its read-pane"
        n="$(count_calls "${table}" - "${id}" send-keys "${lt_start}" "${send_at[${role}]}")"
        (( n == 1 )) || fail "${step}: ${role}: ${n} send-keys of ${id} by a CSCB process up to the approver's, not one"
        for verb in spawn resume; do
            n="$(count_calls "${table}" "${srv}" "${id}" "${verb}" "${launch_at[${role}]}" -)"
            (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} ${verb} call(s) of ${id} after its timed-out launch"
        done
        n="$(count_calls "${table}" - "${id}" kill "${lt_start}" -)"
        (( n == 0 )) || fail "${step}: ${role}: ${n} kill call(s) of ${id} by a CSCB process"
        echo "${TEST_NAME}: ${step}: ${role}: from the start: launch +$(seconds_between "${lt_start}" "${launch_at[${role}]}")s, get +$(seconds_between "${lt_start}" "${get_at[${role}]}")s, read-pane +$(seconds_between "${lt_start}" "${pane_at[${role}]}")s, send-keys +$(seconds_between "${lt_start}" "${send_at[${role}]}")s, first read out of pending +$(seconds_between "${lt_start}" "${out_at[${role}]}")s"

        # [harness] The row read pending after the get.
        pend="$(awk -F'\t' -v r="${role}" -v a="${get_at[${role}]}" '$1 == r && $3 == "pending" && $2 + 0 > a + 0 { n++ } END { print n + 0 }' "${reads}")"
        (( pend > 0 )) || fail "${step}: ${role}: no harness read of ${id} after the bot server's get read pending"

        # The stub reported in only after the send-keys: its session
        # connected, and the row left pending, after it.
        connected_at="$(log_hits "${log0}" "[slack] Session connected: persona ${ref}" | head -n 1 | cut -f2)"
        awk -v c="${connected_at:-0}" -v s="${send_at[${role}]}" 'BEGIN { exit !(c + 0 > s + 0) }' \
            || fail "${step}: ${role}: the persona's session connected (${connected_at:-never}) before the approver's send-keys (${send_at[${role}]})"
        awk -v o="${out_at[${role}]}" -v s="${send_at[${role}]}" 'BEGIN { exit !(o + 0 > s + 0) }' \
            || fail "${step}: ${role}: the row left pending before the approver's send-keys"

        # The tmux-unresponsive condition's ended line, no later than the
        # first harness read out of pending.
        ended="$(fmk_text tmuxUnresponsiveEndedLines "${key}")" || fail "${step}: fmk-texts.ts could not print tmuxUnresponsiveEndedLines"
        n="$(grep -nF -f <(printf '%s\n' "${ended}") "${SLACK_STATE_DIR}/server.log" | awk -F: -v s="${log0}" '$1 + 0 > s + 0 { print $1; exit }' || true)"
        [[ -n "${n}" ]] || fail "${step}: ${role}: no tmux-unresponsive ended line for ${key}"
        t="$(log_hits "$(( n - 1 ))" "" | head -n 1 | cut -f2)"
        awk -v e="${t:-0}" -v o="${out_at[${role}]}" 'BEGIN { exit !(e + 0 > 0 && e + 0 <= o + 0) }' \
            || fail "${step}: ${role}: the tmux-unresponsive ended line (${t:-no time}) came after the first harness read out of pending (${out_at[${role}]})"
        echo "${TEST_NAME}: ${step}: ${role}: its tmux-unresponsive condition (recorded): $(log_hits "${log0}" "${TU_HEAD[${key}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"

        # Every retry (its retry line exactly, never the re-armed line) reads
        # the row (status or get) within LT_RETRY_READ_S and launches nothing
        # (above); the retry-timer lines and the number of retries are
        # recorded (a retry is not certain; see the header).
        echo "${TEST_NAME}: ${step}: ${role}: its retry timer (recorded): $(log_hits "${log0}" "${RT_LINE_HEAD[${key}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
        mapfile -t lines < <(retry_hits "${log0}" "${RT_RETRY_HEAD[${key}]}" "${RT_RETRY_FULL[${key}]}" "${RT_RETRY_PENDING[${key}]}" | cut -f2)
        echo "${TEST_NAME}: ${step}: ${role}: ${#lines[@]} retry line(s) of its retry timer (recorded)"
        for t in "${lines[@]}"; do
            n=$(( $(count_calls "${table}" "${srv}" "${id}" status "$(plus_s "${t}" -0.001)" "$(plus_s "${t}" "${LT_RETRY_READ_S}")") \
                + $(count_calls "${table}" "${srv}" "${id}" get "$(plus_s "${t}" -0.001)" "$(plus_s "${t}" "${LT_RETRY_READ_S}")") ))
            (( n > 0 )) || fail "${step}: ${role}: the retry at ${t} made no status or get of ${id} within ${LT_RETRY_READ_S}s"
        done

        # No CONFLICT latch.
        expect_count "$(matcher "[slack] conflict-latch: persona=${key} ")" 0 "${step}: ${role}: conflict-latch lines"
    done

    # No post (a spawn-failure or CONFLICT notice among them) from the timeout start on.
    mapfile -t posts < <(posts_to "" "${lt_start}")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "${step}: ${#posts[@]} post(s) reached the Slack stub's record after the timeout start"
    }

    # A plain stop, then each worker ends with the sentinel (`stop
    # --stop-bots` would wait out each persona's pause, which the stub never
    # answers, before its kill).
    stop_server
    for role in "${LT_ROLES[@]}"; do
        end_worker "${LT_ID[${role}]}" "${step}: the end"
    done
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The restart leg: a held dialog with no approver running, cleared by a lap from G
# ---------------------------------------------------------------------------

leg_restart_mid_launch() {
    local step="restart mid-launch" creds="${SCENARIO_ROOT}/credentials-rs" work log0 old_pid new_pid leg_start
    local l_ms l_s stopped_at restarted_at deadline out_at="" table="${SCENARIO_ROOT}/rs-calls.tsv" n verb
    local spawn_at first_pane send old_log posts=() lines=()

    new_state_dir restart
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-rs" "${Q_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${Q_SUFFIX}")" "$(fake_token app "${Q_SUFFIX}")" \
        | write_file "${creds}/q.json" 600
    work="$(make_workdir restart)"
    stub_dialog_delay "${work}" "${RESTART_DIALOG_DELAY_S}"
    write_personas_config "$(persona_json "${Q_NAME}" "${creds}/q.json" "${work}" "${Q_CHANNEL}")"

    # Step 1: the server launches Q, whose stub shows its starting screen.
    leg_start="$(now_s)"
    start_server --live
    old_pid="${SERVER_PID}"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the first start pass never completed"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read pending" row_of_reads "${Q_ID}" "${step}: the launch" pending
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(awk -v m="${l_ms}" 'BEGIN { printf "%.3f\n", m / 1000 }')"
    echo "${TEST_NAME}: ${step}: Q's row reads pending, launch_started_at ${ROW_LAUNCH}"
    # The old server's approver runs: it has read the pane, which shows no dialog yet.
    wait_until "${OLD_APPROVER_WAIT_S}" "${step}: the old server's approver never read Q's pane" server_read_pane_seen "${Q_ID}"

    # Step 2 [harness]: a plain stop, then a start, inside the delay.
    stopped_at="$(now_s)"
    stop_server
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    start_server --live
    new_pid="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" 2 "${START_WAIT_S}" "${step}: the second start pass never completed"
    restarted_at="$(now_s)"
    echo "${TEST_NAME}: ${step}: stopped at +$(seconds_between "${l_s}" "${stopped_at}")s and started again by +$(seconds_between "${l_s}" "${restarted_at}")s from the launch start"
    awk -v r="${restarted_at}" -v l="${l_s}" -v d="${RESTART_DIALOG_DELAY_S}" 'BEGIN { exit !(r - l < d) }' \
        || fail "${step}: the stop and start ended past the dialog delay ${RESTART_DIALOG_DELAY_S}s from the launch start"
    read_row_of "${Q_ID}" "${step}: after the restart"
    [[ "${ROW_STATE}" == pending && "$(launch_ms "${ROW_LAUNCH}")" == "${l_ms}" ]] \
        || fail "${step}: after the restart Q's row reads ${ROW_STATE} (launch ${ROW_LAUNCH}), not the same pending launch"

    # Step 3 [harness]: read the row until it leaves pending, bounded from the launch start.
    deadline=$(( l_ms + RESTART_CLEAR_BOUND_S * 1000 ))
    while :; do
        read_row_of "${Q_ID}" "${step}: the wait"
        if [[ "${ROW_STATE}" != pending ]]; then
            out_at="${ROW_READ_AT}"
            break
        fi
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: Q's row still pending ${RESTART_CLEAR_BOUND_S}s after its launch start (G, the retry ceiling and ${RESTART_LAP_SLACK_S}s)"
        sleep "${RESTART_POLL_S}"
    done
    echo "${TEST_NAME}: ${step}: Q's row left pending for ${ROW_STATE} $(seconds_between "${l_s}" "${out_at}")s after its launch start"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: Q's row left pending for ${ROW_STATE}, not waiting"
    [[ -n "${ROW_SID}" ]] || fail "${step}: Q's waiting row has no claude_session_id"

    # Step 4: the checks, over the CSCB processes' calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the old server's calls of ${Q_ID} (recorded): $(calls "${table}" "${old_pid}" "${Q_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    echo "${TEST_NAME}: ${step}: the new server's calls of ${Q_ID} (recorded): $(calls "${table}" "${new_pid}" "${Q_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    # The new server launched nothing: its start pass's one plain spawn
    # collided with the pending row (the ladder's first step), and no spawn,
    # reuse, resume or kill followed.
    n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" spawn - - '!--reuse-finished')"
    (( n == 1 )) || fail "${step}: the new server made ${n} plain spawn(s) of ${Q_ID}, not its start pass's one"
    spawn_at="$(first_call_at "${table}" "${new_pid}" "${Q_ID}" spawn - -)"
    n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" spawn - - --reuse-finished)"
    (( n == 0 )) || fail "${step}: the new server made ${n} reuse spawn(s) of ${Q_ID}"
    for verb in resume kill; do
        n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" "${verb}" - -)"
        (( n == 0 )) || fail "${step}: the new server made ${n} ${verb} call(s) of ${Q_ID}"
    done
    mapfile -t lines < <(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=pending for ${Q_REF}" | cut -f2)
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} collision line(s) reading Q's row pending in the new server's log, not one"
    awk -v c="${lines[0]}" -v s="${spawn_at}" 'BEGIN { exit !(c + 0 > s + 0) }' \
        || fail "${step}: the new server's collision line came before its plain spawn"
    # No approver of its own: no approver line names Q in its log, and its
    # first read-pane of Q comes at or after G past the launch start.
    n="$(log_hits "${log0}" "${APPROVER_PREFIX}" | grep -cF -- "${Q_REF}" || true)"
    (( n == 0 )) || fail "${step}: ${n} approver line(s) name Q in the new server's log"
    first_pane="$(first_call_at "${table}" "${new_pid}" "${Q_ID}" read-pane - -)"
    [[ -n "${first_pane}" ]] || fail "${step}: the new server never read Q's pane"
    awk -v p="${first_pane}" -v l="${l_s}" -v g="${G_S}" 'BEGIN { exit !(p + 0 >= l + g) }' \
        || fail "${step}: the new server's first read-pane of Q came $(seconds_between "${l_s}" "${first_pane}")s after the launch start, before G ${G_S}s"
    # Its lap's send-keys with --allow-pending cleared the dialog.
    send="$(first_call_at "${table}" "${new_pid}" "${Q_ID}" send-keys "$(plus_s "${first_pane}" -0.001)" "${out_at}" --allow-pending)"
    [[ -n "${send}" ]] || fail "${step}: no new-server send-keys of Q with --allow-pending between its first read-pane and the first read out of pending"
    n="$(count_calls "${table}" - "${Q_ID}" send-keys - "${out_at}")"
    (( n == 1 )) || fail "${step}: ${n} send-keys of ${Q_ID} by a CSCB process before the row left pending, not the lap's one"
    echo "${TEST_NAME}: ${step}: the new server's first read-pane +$(seconds_between "${l_s}" "${first_pane}")s, its send-keys +$(seconds_between "${l_s}" "${send}")s from the launch start"
    # The old server's approver stopped at shutdown and armed nothing
    # (SRJ-404): its shutdown stop line for Q is in the old server's log, and
    # no arm line for Q follows it there, neither armed nor refused as not
    # armed (shutdown closes the retry controller before it stops the
    # approvers, so an arm after the stop would log the not-armed line).
    old_log="${SCENARIO_ROOT}/rs-old-server.log"
    head -n "${log0}" "${SLACK_STATE_DIR}/server.log" > "${old_log}"
    mapfile -t lines < <(grep -nxF -- "${Q_SHUTDOWN_STOP}" <(sed -E 's/^\[[^]]*\] //' "${old_log}") | cut -d: -f1)
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} shutdown stop line(s) of the approver for Q in the old server's log, not one"
    n="$(tail -n "+$(( lines[0] + 1 ))" "${old_log}" | grep -cF -e "${RT_ARMED[${Q_KEY}]}" -e "${RT_NOT_ARMED[${Q_KEY}]}" || true)"
    (( n == 0 )) || {
        tail -n "+$(( lines[0] + 1 ))" "${old_log}" | grep -F -e "${RT_ARMED[${Q_KEY}]}" -e "${RT_NOT_ARMED[${Q_KEY}]}" | sed 's/^/  | /' >&2
        fail "${step}: ${n} arm line(s) for Q after the old approver's shutdown stop"
    }
    echo "${TEST_NAME}: ${step}: the old server's approver lines for Q (recorded): $(grep -F -- "${APPROVER_PREFIX}" "${old_log}" | grep -F -- "${Q_REF}" | cut -c1-200 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: the new server's retry and pending-row lines for Q (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "${RT_LINE_HEAD[${Q_KEY}]}" -e "${PENDING_ROW_HEAD} ${Q_REF}" | cut -c1-260 | tr '\n' '|')"
    # No post in the leg.
    mapfile -t posts < <(posts_to "" "${leg_start}")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "${step}: ${#posts[@]} post(s) reached the Slack stub's record in the leg"
    }

    stop_server
    end_worker "${Q_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# Scenario 11: a failed fresh spawn (fail-create), waited out from G
# ---------------------------------------------------------------------------

# fc_failure_seen <from-line>: true once server.log holds, after line
# <from-line>, the plain spawn's ErrTmuxSessionCreate line for F.
fc_failure_seen() {
    [[ -n "$(log_hits "$1" '[slack] spawnForPersona: ' "failed for ${F_REF}: " "${SESSION_CREATE_ERR}")" ]]
}

# fc_only_pending <step>: a harness `list --state pending`; fail unless F's
# row is the only `pending` row.
fc_only_pending() {
    local ids
    ad_capture list --state pending
    (( AD_RC == 0 )) || fail "$1: the harness list exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    ids="$(jq -r '(if type == "array" then . else .spawns end)[] | .claude_instance_id' "${AD_OUT}" | sort | tr '\n' ' ')" \
        || fail "$1: the harness list printed no row list: $(head -c 300 "${AD_OUT}")"
    [[ "${ids}" == "${F_ID} " ]] || fail "$1: the pending rows are '${ids% }', not ${F_ID} alone"
}

leg_fail_create() {
    local step="scenario 11" creds="${SCENARIO_ROOT}/credentials-fc" work log0 srv leg_start reset_at creates
    local l_ms l_s g_at deadline launch out_at first_missing="" reads="${SCENARIO_ROOT}/fc-reads.tsv"
    local table="${SCENARIO_ROOT}/fc-calls.tsv" n spawn0 next_at fm_at get_at rule_at
    local lines=() notices=()

    new_state_dir failcreate
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-fc" "${F_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${F_SUFFIX}")" "$(fake_token app "${F_SUFFIX}")" \
        | write_file "${creds}/f.json" 600
    work="$(make_workdir failcreate)"
    write_personas_config "$(persona_json "${F_NAME}" "${creds}/f.json" "${work}" "${F_CHANNEL}")"

    # Step 1 [harness]: F has no row.
    poll_row_of "${F_ID}" "${step}: before the start"
    [[ "${ROW_STATE}" == absent ]] || fail "${step}: row ${F_ID} reads ${ROW_STATE} before the start, not absent"

    # Step 2: fail-create, then the start: the server's plain spawn of F.
    tmux_shim_mode fail-create
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Step 3: once the spawn has failed, the tmux shim goes back to `log`.
    wait_until "${START_WAIT_S}" "${step}: no ${SESSION_CREATE_ERR} line for ${F_REF} after the start" \
        fc_failure_seen "${log0}"
    tmux_shim_mode log
    reset_at="$(now_s)"
    echo "${TEST_NAME}: ${step}: the spawn failed by $(seconds_between "${leg_start}" "${reset_at}")s after the start; the tmux shim is back in log mode. Its line (recorded): $(log_hits "${log0}" '[slack] spawnForPersona: ' "failed for ${F_REF}: " "${SESSION_CREATE_ERR}" | head -n 1 | cut -f3 | cut -c1-400)"
    creates="$(awk -F'\t' -v a="${leg_start}" -v b="${reset_at}" \
        '$1 == "call" && $2 + 0 > a + 0 && $2 + 0 <= b + 0 && $6 ~ /(^| )new-session( |$)/ { n++ } END { print n + 0 }' "${SCENARIO_TMUX_SHIM_LOG}")"
    (( creates >= 1 )) || fail "${step}: no new-session call reached the tmux shim while it was in fail-create"
    echo "${TEST_NAME}: ${step}: ${creates} new-session call(s) failed in fail-create (recorded)"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"

    # Step 4 [harness]: the row reads pending with a launch start L, the only pending row.
    read_row_of "${F_ID}" "${step}: after the failure"
    [[ "${ROW_STATE}" == pending ]] || fail "${step}: after the failed spawn row ${F_ID} reads ${ROW_STATE}, not pending"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(awk -v m="${l_ms}" 'BEGIN { printf "%.3f\n", m / 1000 }')"
    g_at="$(plus_s "${l_s}" "${G_S}")"
    echo "${TEST_NAME}: ${step}: F's row reads pending, launch_started_at ${ROW_LAUNCH}"
    fc_only_pending "${step}: after the failure"

    # Step 5 [harness]: read the row every FC_POLL_S until it is live,
    # bounded from L; before G, F's is the only pending row.
    : > "${reads}"
    deadline=$(( l_ms + FC_BRINGUP_BOUND_S * 1000 ))
    while :; do
        poll_row_of "${F_ID}" "${step}: the wait"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        case "${ROW_STATE}" in
            pending)
                launch="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: a pending read's launch_started_at '${ROW_LAUNCH}' does not parse"
                if [[ "${launch}" == "${l_ms}" ]] && awk -v n="$(now_s)" -v g="${g_at}" 'BEGIN { exit !(n + 0 < g + 0) }'; then
                    fc_only_pending "${step}: before G"
                fi ;;
            missing) [[ -n "${first_missing}" ]] || first_missing="${ROW_READ_AT}" ;;
            absent | ended) ;;
            *)
                out_at="${ROW_READ_AT}"
                break ;;
        esac
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: row ${F_ID} not live ${FC_BRINGUP_BOUND_S}s after its launch start (G, the retry ceiling and ${FC_BRINGUP_SLACK_S}s)"
        sleep "${FC_POLL_S}"
    done
    echo "${TEST_NAME}: ${step}: the row read ${ROW_STATE} $(seconds_between "${l_s}" "${out_at}")s after its launch start; the harness reads in order (recorded): $(cut -f2 "${reads}" | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: F's row came up ${ROW_STATE}, not waiting"
    wait_for_log "$(matcher "[slack] Session connected: persona ${F_REF}")" "${CONNECT_WAIT_S}" \
        "${step}: the server never registered F's session after the bring-up"

    # Step 6: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${F_ID} (recorded): $(calls "${table}" "${srv}" "${F_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | cut -f1 | while read -r n; do printf '+%ss ' "$(seconds_between "${l_s}" "${n}")"; done)"
    # While fail-create was set, the server's one launch: F's plain spawn.
    mapfile -t lines < <(awk -F'\t' -v p="${srv}" -v a="${leg_start}" -v b="${reset_at}" \
        '$2 == p && ($3 == "spawn" || $3 == "resume") && $1 + 0 > a + 0 && $1 + 0 <= b + 0' "${table}")
    (( ${#lines[@]} == 1 )) || fail "${step}: the bot server made ${#lines[@]} launch call(s) while the shim was in fail-create, not one"
    [[ "$(cut -f4 <<< "${lines[0]}")" == "${F_ID}" && "$(cut -f3 <<< "${lines[0]}")" == spawn && " $(cut -f5 <<< "${lines[0]}") " != *" --reuse-finished "* ]] \
        || fail "${step}: the launch while the shim was in fail-create is not F's plain spawn: ${lines[0]}"
    spawn0="$(cut -f1 <<< "${lines[0]}")"
    # No bot-server find-missing from L to G after it.
    n="$(count_calls "${table}" "${srv}" - find-missing "${l_s}" "$(plus_s "${g_at}" -0.001)")"
    (( n == 0 )) || fail "${step}: the bot server ran find-missing ${n} time(s) between F's launch start and G after it"
    # F's next launch, and the run and the get before it.
    next_at="$(calls "${table}" "${srv}" "${F_ID}" - "${spawn0}" - | awk -F'\t' '$3 == "spawn" || $3 == "resume"' | head -n 1 | cut -f1)"
    [[ -n "${next_at}" ]] || fail "${step}: the bot server made no launch of ${F_ID} after the failed spawn"
    fm_at="$(calls "${table}" "${srv}" - find-missing - "${next_at}" | tail -n 1 | cut -f1)"
    [[ -n "${fm_at}" ]] || fail "${step}: no bot-server find-missing before F's next launch"
    awk -v f="${fm_at}" -v g="${g_at}" 'BEGIN { exit !(f + 0 >= g + 0) }' \
        || fail "${step}: the last bot-server find-missing before F's next launch came $(seconds_between "${l_s}" "${fm_at}")s after L, before G ${G_S}s"
    get_at="$(first_call_at "${table}" "${srv}" "${F_ID}" get "${fm_at}" "${next_at}")"
    [[ -n "${get_at}" ]] || fail "${step}: no bot-server get of ${F_ID} between its find-missing and its next launch"
    # The rule's round marked the row missing and its get read missing.
    mapfile -t lines < <(log_hits "${log0}" "${PENDING_ROW_HEAD} ${F_REF} rule (" "find-missing: ${MARKED_MISSING}" "get: missing")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} pending-row rule line(s) for F name the row marked and read missing, not one"
    rule_at="$(cut -f2 <<< "${lines[0]}")"
    awk -v r="${rule_at}" -v n="${next_at}" 'BEGIN { exit !(r + 0 <= n + 0) }' \
        || fail "${step}: the pending-row rule's missing line came after F's next launch"
    echo "${TEST_NAME}: ${step}: from L: find-missing +$(seconds_between "${l_s}" "${fm_at}")s, get +$(seconds_between "${l_s}" "${get_at}")s, next launch +$(seconds_between "${l_s}" "${next_at}")s ($(calls "${table}" "${srv}" "${F_ID}" - "$(plus_s "${next_at}" -0.001)" "${next_at}" | cut -f5 | sed 's/ --label .*/ …/'))"
    # The harness's read of missing, when it made one, came after the run.
    if [[ -n "${first_missing}" ]]; then
        awk -v m="${first_missing}" -v f="${fm_at}" 'BEGIN { exit !(m + 0 > f + 0) }' \
            || fail "${step}: the harness read F's row missing ($(seconds_between "${l_s}" "${first_missing}")s from L) before the bot server's find-missing"
        echo "${TEST_NAME}: ${step}: the harness read the row missing at +$(seconds_between "${l_s}" "${first_missing}")s from L (recorded)"
    else
        echo "${TEST_NAME}: ${step}: no harness read caught the row missing (recorded)"
    fi
    # No kill of F's row from any CSCB process.
    n="$(count_calls "${table}" - "${F_ID}" kill - -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${F_ID} by a CSCB process"
    # Only the bot server ran find-missing in the leg: none from the scenario's shell.
    mapfile -t lines < <(awk -F'\t' -v a="${leg_start}" -v p="${srv}" \
        '$1 == "call" && $2 + 0 > a + 0 && $4 != p && $6 ~ /(^| )find-missing( |$)/' "${SCENARIO_AD_SHIM_LOG}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} find-missing call(s) in the leg not made by the bot server"
    }
    echo "${TEST_NAME}: ${step}: F's retry timer (recorded): $(log_hits "${log0}" "${RT_LINE_HEAD[${F_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: F's pending-row rule lines (recorded): $(log_hits "${log0}" "${PENDING_ROW_HEAD} ${F_REF} rule (" | cut -f3 | cut -c1-900 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: F's collision lines (recorded): $(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=" "for ${F_REF}" | cut -f3 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: startup-errors.log lines naming F (recorded): $(grep -F -- "${F_REF}" "${SLACK_STATE_DIR}/startup-errors.log" 2> /dev/null | cut -c1-300 | tr '\n' '|')"

    # Posts: none holds "dispatcher bug"; at most one spawn-failure post,
    # naming ErrTmuxSessionCreate (whether it was made is recorded); no other.
    mapfile -t lines < <(record_posts 1 | jq -c --arg w "${DISPATCHER_BUG}" 'select(tostring | ascii_downcase | contains($w))')
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) hold '${DISPATCHER_BUG}'"
    }
    mapfile -t notices < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h))')
    (( ${#notices[@]} <= 1 )) || {
        printf '  | %s\n' "${notices[@]}" >&2
        fail "${step}: ${#notices[@]} spawn-failure posts, not at most one"
    }
    if (( ${#notices[@]} == 1 )); then
        jq -e --arg h "${SPAWN_FAILURE_HEAD}" '(.text // "") | contains($h)' <<< "${notices[0]}" > /dev/null \
            || fail "${step}: the spawn-failure post names no ${SESSION_CREATE_ERR}: ${notices[0]:0:400}"
        echo "${TEST_NAME}: ${step}: the counted failure posted a spawn-failure notice (recorded): $(jq -c '{method, channel, text: ((.text // "") | .[0:300])}' <<< "${notices[0]}")"
    else
        echo "${TEST_NAME}: ${step}: the counted failure posted no spawn-failure notice (recorded)"
    fi
    mapfile -t lines < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h) | not) | {ts, method, channel, text: ((.text // "") | .[0:300])}')
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) other than the spawn-failure notice (a cap, alert or stuck-launch post among them?)"
    }

    stop_server
    end_worker "${F_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# Scenario 13: a paused bot's immediate resume meets "still stopping"
# ---------------------------------------------------------------------------

# server_status_after <id> <time>: print the time of the bot server's
# (SERVER_PID's) first `status` of row <id> after <time>, read straight from
# the agent-director shim's log (empty when none).
server_status_after() {
    awk -F'\t' -v p="${SERVER_PID}" -v id="$1" -v t="$2" '
        $1 == "call" && $4 == p && $2 + 0 > t + 0 && index(" " $6 " ", " status ") \
            && index(" " $6 " ", " --claude-instance-id " id " ") { print $2; exit }' "${SCENARIO_AD_SHIM_LOG}"
}

# server_status_seen <id> <time>: true once `server_status_after` prints a time.
server_status_seen() {
    [[ -n "$(server_status_after "$1" "$2")" ]]
}

# st_timer_idle <from-line>: true when, after server.log line <from-line>, S's
# retry timer has as many stopped lines as armed lines (none armed, or each
# arm stopped).
st_timer_idle() {
    local armed stopped
    armed="$(log_hits "$1" "${RT_ARMED[${S_KEY}]}" | wc -l)"
    stopped="$(log_hits "$1" "${RT_STOPPED[${S_KEY}]}" | wc -l)"
    (( stopped >= armed ))
}

# st_refusal_seen <from-line>: true once server.log holds, after line
# <from-line>, the refusal of a `resume` of S carrying STILL_STOPPING_PHRASE.
st_refusal_seen() {
    [[ -n "$(log_hits "$1" "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}")" ]]
}

# st_session_gone <session>: true once the scenario's tmux server no longer
# holds <session>.
st_session_gone() {
    ! has_session "$1"
}

# st_no_posts <step> <from-time>: the Slack stub's record holds no post with
# S's tmux-unresponsive onset or the spawn-failure notice's first line, and
# no post at all from <from-time> (epoch seconds) on.
st_no_posts() {
    local posts=()
    mapfile -t posts < <(record_posts 1 | jq -c --arg o "${S_ONSET}" 'select((.text // "") | contains($o))')
    (( ${#posts[@]} == 0 )) || fail "$1: ${#posts[@]} post(s) hold S's tmux-unresponsive onset"
    mapfile -t posts < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h))')
    (( ${#posts[@]} == 0 )) || fail "$1: ${#posts[@]} post(s) hold a spawn-failure notice"
    mapfile -t posts < <(posts_to "" "$2")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "$1: ${#posts[@]} post(s) reached the Slack stub's record after the pause"
    }
}

leg_still_stopping() {
    local step="scenario 13" creds="${SCENARIO_ROOT}/credentials-st" work srv sid session pane_pid
    local t tick0 paused_at refusal_at release_at gone_at live_at next_tick gap retry_at get_at
    local resume1 resume2 table="${SCENARIO_ROOT}/st-calls.tsv" n verb hits connected
    local lines=() resumes=()

    new_state_dir paused
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-st" "${S_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${S_SUFFIX}")" "$(fake_token app "${S_SUFFIX}")" \
        | write_file "${creds}/s.json" 600
    work="$(make_workdir paused)"
    stub_mode "${work}" "${STUB_MODE_LINGER_ON_EXIT}"
    persona_json "${S_NAME}" "${creds}/s.json" "${work}" "${S_CHANNEL}" \
        | jq -s --argjson port "${SCENARIO_PORT}" --argjson tick "${ST_TICK_S}" --argjson delay "${ST_RESTART_DELAY_S}" \
            '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: $tick, session_restart_delay: $delay, exit_timeout: 5}' \
        | write_config

    # Step 1: the live start brings S up; its stub reports in at once.
    start_server --live
    srv="${SERVER_PID}"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${S_ID} never reported in (waiting) after the start" \
        row_of_reads "${S_ID}" "${step}: bring-up" waiting
    sid="${ROW_SID}"
    session="${ROW_SESSION}"
    [[ -n "${sid}" && -n "${session}" ]] || fail "${step}: the live row ${S_ID} has no claude_session_id or names no tmux session"
    # src/server.ts: the MCP session's registration line.
    connected="$(matcher "[slack] Session connected: persona ${S_REF}")"
    wait_for_log "${connected}" "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as S's"
    wait_until "${APPROVER_STOP_WAIT_S}" "${step}: the bot server still reads S's pane ${APPROVER_STOP_WAIT_S}s after the bring-up" \
        approver_quiet_of "${S_ID}"
    # The bring-up launch's retry timer has stopped, so the refusal arms a
    # fresh timer whose first retry is RETRY_BASE_S after it.
    wait_until "${ST_TIMER_WAIT_S}" "${step}: S's retry timer from the bring-up had not stopped ${ST_TIMER_WAIT_S}s after it" \
        st_timer_idle 0

    # Step 2: a health tick's read of S (with the approver and the timer
    # stopped, only a tick reads S's status).
    t="$(now_s)"
    wait_until "$(( ST_TICK_S + 10 ))" "${step}: no health tick read S's status within $(( ST_TICK_S + 10 ))s" \
        server_status_seen "${S_ID}" "${t}"
    tick0="$(server_status_after "${S_ID}" "${t}")"

    # Step 3 [harness]: pause S from the scenario's shell, at once.
    ad_capture pause --claude-instance-id "${S_ID}"
    paused_at="$(now_s)"
    (( AD_RC == 0 )) || fail "${step}: the harness pause of ${S_ID} exited ${AD_RC}: $(head -c 300 "${AD_ERR}") $(head -c 300 "${AD_OUT}")"
    awk -v a="${tick0}" -v b="${paused_at}" -v s="${ST_PAUSE_S}" 'BEGIN { exit !(b - a <= s) }' \
        || fail "${step}: the pause returned $(seconds_between "${tick0}" "${paused_at}")s after the tick read, longer than ST_PAUSE_S ${ST_PAUSE_S}s the tick interval is derived from"
    read_row_of "${S_ID}" "${step}: after the pause"
    [[ "${ROW_STATE}" == ended && "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: after the pause the row reads ${ROW_STATE} (${ROW_SID}), not ended with ${sid}"
    # The worker still runs: its tmux session and the pane's process.
    has_session "${session}" || fail "${step}: the paused worker's tmux session ${session} is gone before its release"
    pane_pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{pane_pid}')" \
        || fail "${step}: tmux could not read ${session}'s pane"
    pid_alive "${pane_pid}" || fail "${step}: the paused worker's process ${pane_pid} is gone before its release"
    echo "${TEST_NAME}: ${step}: paused $(seconds_between "${tick0}" "${paused_at}")s after the tick read; the row reads ended while the worker ${pane_pid} still runs"

    # Step 4: the bot server's resume of S, refused as still stopping.
    wait_until "$(( ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S + 10 ))" "${step}: no still-stopping refusal of S's resume after the pause" \
        st_refusal_seen 0
    refusal_at="$(log_hits 0 "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}" | head -n 1 | cut -f2)"

    # Step 5 [harness]: release the lingering worker, at once.
    stub_release "${session}"
    release_at="$(now_s)"
    wait_until "${ST_SESSION_END_WAIT_S}" "${step}: the worker's tmux session ${session} still runs ${ST_SESSION_END_WAIT_S}s after its release" \
        st_session_gone "${session}"
    gone_at="$(now_s)"
    ! pid_alive "${pane_pid}" || fail "${step}: the released worker's process ${pane_pid} still runs"
    echo "${TEST_NAME}: ${step}: released $(seconds_between "${refusal_at}" "${release_at}")s after the refusal; the session was gone by $(seconds_between "${refusal_at}" "${gone_at}")s"

    # Step 6: a later resume succeeds: S reads waiting with the same session id.
    wait_until "$(( RETRY_BASE_S + ST_LAUNCH_SLACK_S + REPORT_WAIT_S ))" "${step}: row ${S_ID} never read waiting again after the release" \
        row_of_reads "${S_ID}" "${step}: after the release" waiting
    live_at="${ROW_READ_AT}"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the waiting row's claude_session_id is '${ROW_SID}', not the paused row's ${sid}"
    wait_for_count "${connected}" 2 "${CONNECT_WAIT_S}" "${step}: the server never registered the resumed stub's session as S's"

    # Step 7: the next health tick's read (its onset check is covered by the
    # record checks run again after the server's stop).
    wait_until "$(( ST_TICK_S + 10 ))" "${step}: no health tick read S's status near ${ST_TICK_S}s after the first" \
        server_status_seen "${S_ID}" "$(plus_s "${tick0}" "$(( ST_TICK_S - ST_TICK_JITTER_S ))")"
    next_tick="$(server_status_after "${S_ID}" "$(plus_s "${tick0}" "$(( ST_TICK_S - ST_TICK_JITTER_S ))")")"
    gap="$(seconds_between "${tick0}" "${next_tick}")"
    awk -v g="${gap}" -v i="${ST_TICK_S}" -v j="${ST_TICK_JITTER_S}" 'BEGIN { exit !(g <= i + j) }' \
        || fail "${step}: the next tick's read of S came ${gap}s after the first, not within ${ST_TICK_JITTER_S}s of the interval ${ST_TICK_S}s"

    # Step 8: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${S_ID} from the pause, from the tick read (recorded): $(calls "${table}" "${srv}" "${S_ID}" - "${paused_at}" - | awk -F'\t' -v t="${tick0}" '{ a = $5; sub(/ --label .*/, " …", a); printf "+%.3fs %s [%s]; ", $1 - t, $3, a }')"
    echo "${TEST_NAME}: ${step}: what scheduled the resume (recorded): $(log_hits 0 "Scheduling restart for persona=${S_KEY} " | cut -f3 | cut -c1-200 | tr '\n' '|')"
    # Exactly two bot-server resumes of S after the pause; no reuse spawn or
    # kill of S by any CSCB process (each ladder's plain spawn, its first
    # step, collides with the row: recorded).
    mapfile -t resumes < <(calls "${table}" "${srv}" "${S_ID}" resume "${paused_at}" - | cut -f1)
    (( ${#resumes[@]} == 2 )) || fail "${step}: ${#resumes[@]} bot-server resume(s) of ${S_ID} after the pause, not two (the refused one and the retry's)"
    resume1="${resumes[0]}"
    resume2="${resumes[1]}"
    n="$(count_calls "${table}" - "${S_ID}" spawn "${paused_at}" - --reuse-finished)"
    (( n == 0 )) || fail "${step}: ${n} reuse spawn(s) of ${S_ID} by a CSCB process after the pause"
    n="$(count_calls "${table}" - "${S_ID}" kill "${paused_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${S_ID} by a CSCB process after the pause"
    echo "${TEST_NAME}: ${step}: $(count_calls "${table}" "${srv}" "${S_ID}" spawn "${paused_at}" - '!--reuse-finished') plain spawn(s) of S after the pause, each a ladder's first step; their collision lines (recorded): $(log_hits 0 "[slack] spawnForPersona: collision resolved, state=" "for ${S_REF}" | cut -f3 | cut -c1-160 | tr '\n' '|')"
    # The first resume fell inside the stopping window from the pause.
    awk -v a="${paused_at}" -v b="${resume1}" -v w="${STOP_WINDOW_S}" 'BEGIN { exit !(b - a < w) }' \
        || fail "${step}: the first resume came $(seconds_between "${paused_at}" "${resume1}")s after the pause, outside the stopping window ${STOP_WINDOW_S}s"
    # Exactly one refusal of S's resume carries STILL_STOPPING_PHRASE, between the two resumes.
    mapfile -t lines < <(log_hits 0 "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} still-stopping refusal line(s) for S's resume, not one"
    awk -v a="${resume1}" -v r="${refusal_at}" -v b="${resume2}" 'BEGIN { exit !(r + 0 >= a - 0.001 && r + 0 <= b + 0) }' \
        || fail "${step}: the refusal line is not between the two resumes"
    echo "${TEST_NAME}: ${step}: the refusal (recorded): $(cut -f3 <<< "${lines[0]}" | cut -c1-400)"
    echo "${TEST_NAME}: ${step}: every server.log line naming S that carries the still-stopping phrase (recorded): $(log_hits 0 "${STILL_STOPPING}" | cut -f3 | naming_persona "${S_KEY}" "${S_REF}" | cut -c1-200 | tr '\n' '|')"
    # One get after the UNAVAILABLE outcome (SRJ-407): its line, and exactly
    # one bot-server get of S from the refused resume to that line.
    mapfile -t lines < <(log_hits 0 "${GET_HEAD}${RESUME_WHAT}${GET_OF[${S_KEY}]}${FORM_UNAVAILABLE_HEAD}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} post-refusal get line(s) for S's resume, not one"
    get_at="$(cut -f2 <<< "${lines[0]}")"
    echo "${TEST_NAME}: ${step}: the get line (recorded): $(cut -f3 <<< "${lines[0]}" | cut -c1-400)"
    n="$(count_calls "${table}" "${srv}" "${S_ID}" get "${resume1}" "${get_at}")"
    (( n == 1 )) || fail "${step}: ${n} bot-server get(s) of ${S_ID} between the refused resume and its get line, not one"
    # The retry: its line comes after the release (and after the worker's
    # session ended), and the second resume follows it, before the next tick.
    retry_at="$(retry_hits 0 "${RT_RETRY_HEAD[${S_KEY}]}" "${RT_RETRY_FULL[${S_KEY}]}" "${RT_RETRY_PENDING[${S_KEY}]}" \
        | awk -F'\t' -v r="${refusal_at}" '$2 + 0 > r + 0 { print $2; exit }')"
    [[ -n "${retry_at}" ]] || fail "${step}: no retry line for S after the refusal"
    echo "${TEST_NAME}: ${step}: S's retry-timer lines (recorded): $(log_hits 0 "${RT_LINE_HEAD[${S_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    awk -v r="${retry_at}" -v l="${release_at}" -v g="${gone_at}" 'BEGIN { exit !(l + 0 < r + 0 && g + 0 < r + 0) }' \
        || fail "${step}: the retry ($(seconds_between "${refusal_at}" "${retry_at}")s after the refusal) came before the release or before the worker's session ended"
    awk -v r="${retry_at}" -v b="${resume2}" -v s="${ST_LAUNCH_SLACK_S}" 'BEGIN { exit !(b + 0 > r - 0.001 && b - r <= s) }' \
        || fail "${step}: the second resume came $(seconds_between "${retry_at}" "${resume2}")s after the retry line, not within ${ST_LAUNCH_SLACK_S}s after it"
    awk -v b="${resume2}" -v n="${next_tick}" 'BEGIN { exit !(b + 0 < n + 0) }' \
        || fail "${step}: the second resume came after the next health tick's read of S"
    awk -v b="${resume2}" -v l="${live_at}" 'BEGIN { exit !(b + 0 < l + 0) }' \
        || fail "${step}: the row read waiting before the second resume"
    echo "${TEST_NAME}: ${step}: from the tick read: pause +$(seconds_between "${tick0}" "${paused_at}")s, refused resume +$(seconds_between "${tick0}" "${resume1}")s, release +$(seconds_between "${tick0}" "${release_at}")s, retry +$(seconds_between "${tick0}" "${retry_at}")s, resume +$(seconds_between "${tick0}" "${resume2}")s, next tick +${gap}s"
    echo "${TEST_NAME}: ${step}: S's tmux-unresponsive lines (recorded): $(log_hits 0 "${TU_HEAD[${S_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    # No post: no onset, alert or spawn-failure notice, and nothing else.
    st_no_posts "${step}" "${paused_at}"
    # Ruling S3: after the second resume no server.log line naming S has a
    # reconnect, relaunch, restart scheduling or not-connected text.
    hits="$(log_hits 0 "" | awk -F'\t' -v b="${resume2}" '$2 + 0 > b + 0' | cut -f3 \
        | naming_persona "${S_KEY}" "${S_REF}" | grep -iE "${HOLD_TROUBLE}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: after the second resume the server logged a reconnect, relaunch or not-connected line for S (ruling S3)"
    fi

    # The record checks again once the server has stopped: any post the
    # next tick's onset check made is in the record by then (shutdown ends
    # every episode silently, and the Slack stub still runs).
    stop_server
    st_no_posts "${step}: after the server's stop" "${paused_at}"
    end_worker "${S_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_launch_pending
leg_launch_timeouts
leg_restart_mid_launch
leg_fail_create
leg_still_stopping

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
