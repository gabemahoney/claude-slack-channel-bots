#!/usr/bin/env bash
# Test 23 (HO §7 scenario 20; b.jg5 SRJ-1422, SRJ-505, SRJ-506, SRJ-507,
# SRJ-714, SRJ-1004, SRJ-1005, SRJ-1019, SRJ-1020, SRJ-1401; AC 1, AC 8,
# AC 43, AC 44): each latch case is
# re-checked every 120 s with exactly its call.
#
# With `health_check_interval` 0, every latched persona's re-check, one
# interval apart, makes one read of its row (`status`) and exactly the call
# SRJ-505's table names for its latch, and no other call, as the
# agent-director shim's log shows (CSCB-parented lines only):
#   - a same-case re-refusal, or a probe that still finds the condition,
#     posts nothing;
#   - a retry at the cadence that succeeds has no `find-missing` before it;
#   - a probe cleared by hand leads to exactly one `find-missing` and exactly
#     one retry;
#   - each clear makes one recovery post;
#   - the unusable recorded name stays latched to the end, re-checked by
#     `status` alone;
#   - for "not this launch's session" the refused call is never retried and
#     a live reading never clears the latch; once the harness's find-missing
#     loop marks the row `missing`, the finished-row retry relatches with
#     "left over from an earlier life" while the leftover runs (leg 1), or
#     clears with one recovery post (leg 2);
#   - "launch start not recorded" is re-checked by `status` alone and clears
#     once the row reads `missing`, with one "Hold cleared" post and one
#     bring-up retry;
#   - "conflicting labels" from a `provenance_conflict` note on a live row
#     (Part 1) is re-checked by `get` alone while the note shows, and clears
#     once it is gone with one recovery post;
#   - "conflicting labels" on a `pending` row (AC 43, Part 1) is re-checked
#     by `get` then a one-line `read-pane` with allow_pending, and once the
#     row reports in, the next `get` alone clears it with one recovery post
#     ("its agent-director row reads waiting") and no relatch post.
# The cases were built and unit-tested on makeRecoveryHarness (E30); this
# script shows the same rows on a real agent-director, from the shim's log.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`: `dev-channels` (no selection, the default) in every
#   persona's working directory, so it prints the dev-channels dialog and
#   reports in only on Enter (CSCB's approver), except the pane-not-found
#   persona's, set to `at-once` before its clear, for its relaunch, Part 1's
#   note persona's, `at-once` (its pane then shows no answered dialog, which
#   the restart path's reconnect would take for a prompt), and Part 1's
#   held-dialog persona's, `unrecognised-dialog` for Part 1's latch life
#   (answered only by the harness's `stub_press_enter`), then `at-once`;
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record with `slack_posts`, on
#   each persona's own channel, PERSONA_CHANNEL), `health_check_interval` 0,
#   `session_restart_delay` at its default.
# The harness runs no `find-missing` in Part 2 until it starts its
# find-missing loop (`run_find_missing_loop`, every
# SCENARIO_FIND_MISSING_INTERVAL_S, 30 s), after the last clearing round of
# the cases it does not serve, so the loop adds no `find-missing` to those
# rounds' windows. The loop is for latched personas' rows (b.jg5 SRJ-1401:
# CSCB makes no extra call for a latched persona); its calls are the
# harness's, never counted as CSCB's. Persona keys must not prefix one
# another (CSCB rejects that).
#
# Parts. Part 2, below, is every latch case whose re-check retries the
# latched operation or probes the pane, and the unusable recorded name. A
# part whose legs need the scenario's tmux server free of Part 2's personas
# (a global `@ad_owner` value is per tmux server) runs before Part 2's first
# life: Part 1, "conflicting labels" from a global `@ad_owner` value. Part
# 1's personas stay configured in Part 2's lives (each in a state dir of its
# own), and their checks end at their clears.
#
# Part 1 (b.jg5 SRJ-1422; AC 8, AC 43), its personas the note persona
# (labelnote) and the held-dialog persona (helddialog); each of their rounds
# reads the row with `get` (only `get` shows a `provenance_conflict` note).
# Part 1's per-case table (case -> set-up -> each round's call -> the clear):
#   labelnote: "conflicting labels" from the row's note, row `waiting`.
#     Set-up: the note (step 2). Round: `get` alone.
#     Clear: once the note is gone, `get` then one run of the restart path's
#     decision (step 5).
#   helddialog: "conflicting labels" met by the approver's `read-pane`, row
#   `pending`.
#     Set-up: the stub in `unrecognised-dialog`; the global value set after
#     the approver's first `read-pane` (step 3). Round: `get`, then one
#     `read-pane` with `--n-lines 1` and `--allow-pending`.
#     Clear: the row reported in; `get` alone reads `waiting` (step 4).
# Steps, in run order:
#   1. First life (p1_life1): the note persona alone (its stub `at-once`)
#      reports in and reads `waiting`, and the server registers its MCP
#      session; a plain `stop`; its session and `waiting` row stay.
#   2. The note (p1_note) [harness]: agent-director 0.11.0's find-missing
#      writes a liveness note only on a live row whose agent process it
#      cannot check (a pid-only identity, among others), deciding that row by
#      its tmux lookup; a row whose process it finds alive is left with no
#      note. So, with the server stopped, the harness's statement
#      (p1_proc_starttime) sets the live row's proc_starttime NULL; with no
#      Part 2 persona on the store or the tmux server (p1_only, a fail check
#      whenever the global value is set), the global `@ad_owner` value is set
#      (ad_owner_global_set); one harness `find-missing` leaves the row
#      `waiting` with the note (a harness `get` shows `liveness_note`
#      LATCHING_LIVENESS_NOTE); the value is unset (ad_owner_global_unset)
#      and the statement puts proc_starttime back; the note stays.
#   3. The latch life (p1_latch_life), in a state dir of its own
#      (`new_state_dir`: this life adds the held-dialog persona), both
#      personas configured, the held-dialog persona's stub in
#      `unrecognised-dialog`: the start sweep's
#      `list` latches the note persona ("conflicting labels", refused
#      operation P's bring-up, row `waiting`) before any call of its id, with
#      exactly one post, the printed CONFLICT notice with no description line
#      (no `agent-director said` line), its session the package's
#      personaTmuxSessionName (`slack_bot_<key>`); the held-dialog persona's
#      one plain spawn leaves its row `pending`, and right after the
#      approver's first `read-pane` of it (`--allow-pending`, seen in the shim
#      log) the harness, with no Part 2 persona present (p1_only), sets the
#      global value; the approver's next
#      `read-pane` answers CONFLICT and latches it ("conflicting labels",
#      refused operation P's next check or recovery, row `pending`), with
#      exactly one post (its description holding the case phrase).
#   4. AC 43 (p1_ac43) [harness]: right after the held-dialog persona's round
#      k (k = MIN_LATCHED_ROUNDS; each round one `get` then one `read-pane`
#      with `--n-lines 1` and `--allow-pending`, answering the same CONFLICT,
#      with no post), by which the note persona has had at least k note
#      rounds, the harness unsets the global value, then sends Enter into the
#      stub's pane (stub_press_enter); a harness read shows the row `waiting`.
#      Checked in step 6: shim-log marks and times show, in order: round k's
#      calls, the unset (within one interval of round k's `get`), the Enter,
#      the harness read, then round k+1's `get`, with no call of the id
#      between round k and the Enter. Round k+1's `get` reads `waiting` and
#      clears the latch (step 1, `clear-reported-in`): no other call of the
#      id before the after-clear run's `find-missing` (so no `read-pane` in
#      the round), the clear line and the round line once each, exactly one
#      recovery post, the printed one for latchRecoveryReasonRowReads
#      `waiting` ("its agent-director row reads waiting"), and no relatch
#      line or post to Part 1's end. The after-clear run's calls of the id
#      and its retry's line (in practice answering `already-connected`) are
#      logged, not asserted (ruling S8).
#   5. The note's removal (p1_note_clear) [harness]: after AC 43's clear and
#      its after-clear run's `find-missing` (waited for up to SETTLE_S), the
#      harness starts its find-missing loop; once a harness `get` shows no
#      note, the note persona's next round is its `get`, then one run of the
#      restart path's decision on the live row, which clears the latch; the
#      loop is stopped once the note persona clears. Which run removed the
#      note (in practice the store-wide `find-missing` after AC 43's clear,
#      else the harness's loop) is logged, not asserted (ruling S8).
#   6. The checks, from the logs (p1_checks), in this order:
#        - the note persona's rounds while the note showed: each one `get`
#          alone at the cadence, no post beyond the latch's, at least
#          MIN_LATCHED_ROUNDS before the unset, the row's state as at the
#          latch;
#        - its clearing round: one `get` at the cadence, then one run of the
#          restart path's decision on the live row (no `resume`, `kill`,
#          `kill-finished` or `delete`, at most the ladder's plain spawn,
#          which meets the row; in practice the reconnect: `get`, `status`,
#          `status`, `read-pane`, `send-keys`; its calls logged), with no
#          CSCB `find-missing` between them; the round line once; the clear
#          line, one recovery post ("a retry of the refused operation was not
#          refused"), the row `waiting` on its first life's
#          claude_session_id, a new MCP registration;
#        - the held-dialog persona's rounds up to round k, as step 4 says,
#          each answering the same CONFLICT, no post beyond the latch's;
#        - AC 43's order and clear, as step 4 says;
#        - for each Part 1 persona: one latch-set line, no relatch line, no
#          round line saying relatched, exactly two posts (the notice and
#          the recovery post), and no CSCB `kill`, `kill-finished` or
#          `delete` naming it in its latch life.
#   7. A plain `stop` (p1_end); then [harness] the held-dialog persona's stub
#      set to `at-once` and its worker ended by its exit line, so its row is
#      finished and Part 2's first life resumes it with no dialog.
#
# A leg that joins Part 2 adds its personas to P2_KEYS (and to
# P2_LIFE1_KEYS when it needs a row), a row to the per-case table, its set-up
# step to p2_setup, and its clearing event to the clearing schedule
# (p2_clearing_schedule), in a round of its own when its clear is counted by
# a window (a `find-missing` carries no instance id).
#
# Part 2's per-case table (case -> the harness's set-up step -> each round's
# call -> the clear). Each set-up step is made in the set-up stop; each
# persona's bring-up launch in the latch life is refused and latches it with
# exactly one post; each still-latched round is one `status`, then the call
# shown, and nothing else.
#   nolabel: "no valid instance id", a refused `resume`.
#     Set-up: row finished; a session with no label holds the name the row
#     records (seed_unlabelled).
#     Round: `status` (`ended`), then the `resume`, refused again.
#     Clear: batched round; the session is ended by its id.
#   foreign: "a different instance id", a refused `resume`.
#     Set-up: row finished; another row's session (seed_borrowed_name, made
#     under its own name, its label naming its own row's id) is renamed to
#     the persona's session name.
#     Round: `status` (`ended`), then the `resume`, refused again.
#     Clear: batched round; the session is renamed back to its own name, so
#     another row's session is never ended.
#   otherstore: "another agent-director store", a refused `resume`.
#     Set-up: row finished; a session labelled with another store's id holds
#     the name (seed_other_store).
#     Round: `status` (`ended`), then the `resume`, refused again.
#     Clear: batched round; the session is ended by its id.
#   leftover: "left over from an earlier life", a refused `resume`.
#     Set-up: row finished; a leftover of an earlier launch of its id holds
#     the name (seed_leftover: this store's id, `@ad_pane`).
#     Round: `status` (`ended`), then the `resume`, refused again.
#     Clear: batched round; the session is ended by its id.
#   scanleft: "left over from an earlier life", a plain spawn refused by its
#   pre-spawn scan, no row written.
#     Set-up: no row; a leftover of an earlier launch of its id (seed_leftover).
#     Round: `status` (no row: step `spawn-retry`), then the plain spawn.
#     Clear: batched round; the session is ended by its id.
#   dupnone: "no valid instance id", a plain spawn refused at "duplicate
#   session", its new row `ended`.
#     Set-up: no row; a session with no label (seed_unlabelled).
#     Round: `status` (`ended`), then a spawn with `--reuse-finished`.
#     Clear: batched round; the session is ended by its id.
#   ownid: "this row's own id", a refused `resume`.
#     Set-up: live row, its session at least the starting-session bound old
#     and its worker running; E39's scenario 10 part B statement
#     (ad_store_mark_finished, `missing`).
#     Round: `status` (`missing`), then one `read-pane` with one line, which
#     returns a pane.
#     Clear: its own round; right after a round the session is ended by its
#     id; the next probe answers ErrTmuxCaptureFailed, then one
#     `find-missing`, then one `resume`.
#   panegone: "the agent's pane was not found", met by the bring-up's pane
#   verb on its `waiting` row (the reconnect's `send-keys`), so the refused
#   operation is P's next check or recovery.
#     Set-up: live `waiting` row; its worker's pane respawned with `sleep`
#     (respawn_worker_pane), its session and pane kept.
#     Round: `status` (`waiting`, or `missing` once a store-wide
#     `find-missing` marks its dead worker), then one `read-pane` with one
#     line and no allow_pending, which answers the same CONFLICT.
#     Clear: its own round, a later one; right after a round the stub is set
#     to report in at once and the session is ended by its id; the next probe
#     answers ErrTmuxCaptureFailed, then one `find-missing`, then one run of
#     the restart path's decision (on the `missing` row with a session id: a
#     `status`, the ladder's plain spawn, which meets the row, a `get`, then
#     the `resume` that launches; the reads are recorded, not asserted).
#   badname: "unusable recorded name" (refused operation none).
#     Set-up: row finished; E39's scenario 25 statement
#     (ad_store_unusable_name, a `.` in the recorded name).
#     Round: `status` only.
#     Clear: none; it stays latched to the end (this script makes no
#     `delete`).
#   relabelone, relabeltwo: "not this launch's session", met by the
#   bring-up's reconnect `send-keys` on the `waiting` row, refused with
#   nothing typed (refused operation P's next check or recovery).
#     Set-up: live `waiting` row, its worker running; its own session
#     relabelled with an earlier launch's token (relabel_session: @ad_owner
#     with that token and the store's id, the worker pane's @ad_pane with the
#     same token).
#     Round: `status` (`waiting`) only; the refused call is never retried.
#     Clear: leg 1 (relabelone): right after a round once the last clearing
#     round above is over, the harness respawns its worker pane with
#     `sleep` (the relabelled session stays); the loop marks the row
#     `missing`; the next round is one `status`, one `get`, then one
#     `resume` (the finished-row retry), refused with "left over from an
#     earlier life": it relatches with one new post and no recovery post,
#     and each following round is one `status` then one `resume`, refused
#     the same way; it stays latched to the end. Leg 2 (relabeltwo): at the
#     same point the harness ends its session by its id, before the loop's
#     first run; the loop marks the row; the next round's `status`, `get`
#     and `resume` launch, and it clears with one recovery post ("its row
#     finished and a relaunch was not refused").
#   nostart: "launch start not recorded", latched by the start sweep's
#   `list` before any bring-up call (refused operation none).
#     Set-up: live row, its worker running; E39's statement
#     (ad_store_pending_no_launch): `pending` with no launch start. The row
#     never reports in by itself (it records no pane); the harness never
#     ends its session.
#     Round: `status` (`pending`) only.
#     Clear: once a store-wide `find-missing` marks the row `missing`
#     (whichever runs first: in practice CSCB's own, in the own-id probe
#     round's clear, ahead of the harness's loop; the script accepts either
#     and logs whose run it was), the next round's `status` clears it with
#     one "Hold cleared" post ("its agent-director row reads missing") and
#     one bring-up retry by the restart path's decision, with no CSCB
#     `find-missing` between that `status` and the retry's first call. What
#     the retry meets beside the still-running session, and any post after
#     it, are logged, not asserted (ruling S8).
#
# Finished rows (this script's working default, a Hatch gap): a row is left
# finished by the human ending its worker as a human ends Claude Code, the
# stub's exit line typed into its pane with the real tmux (`stub_type_exit`:
# `__CSCB_TEST_EXIT__`, the stub's `/exit`, fixtures/stub-claude.sh), which
# fires the worker's SessionEnd hooks, so agent-director itself marks the row
# `ended` and the session ends with it. A harness `kill` of a named row
# changes no row's state in agent-director 0.11.0 (only a `find-missing` or
# a SessionEnd marks a row), `stop --stop-bots` leaves the stub's rows
# `waiting`, and the harness runs no `find-missing` in Part 2 before its
# loop. No step
# passes `--include-finished`.
#
# Part 2's lives, each a function below:
#   1. First life (p2_life1), in a state dir of its own, Part 1's personas
#      still configured: one live start launches every persona that
#      needs a row (P2_LIFE1_KEYS); the approver clears each dialog; each row
#      reads `waiting` (a harness `get`), on the session name the package
#      gives its launches (`personaTmuxSessionName`), and the server registers
#      each stub's MCP session.
#   2. The age wait (p2_age_wait): until the own-id persona's session is at
#      least the starting-session bound old (agent-director's default
#      `[tmux] starting_session_seconds`, 300 s, printed from
#      src/ad-settings.ts DEFAULT_AD_SETTINGS) plus AGE_MARGIN_S, read from
#      tmux's session_created. Before that bound agent-director may answer
#      "still starting" (UNAVAILABLE), which latches nothing.
#   3. A plain `stop` (no --stop-bots; p2_stop): the bots keep running and
#      their rows stay live.
#   4. The set-up stop (p2_setup), with the server stopped: the finished
#      rows (above), then each case's seeding, statement or respawn as the
#      table says. The pane-not-found persona's row still reads `waiting`
#      after its respawn, and keeps reading it for HOLD_S: the stub fires no
#      SessionEnd when its pane is respawned (it fires SessionEnd only on its
#      exit line); a SessionEnd would mark the row and fail this step. Each
#      relabelled leg's row keeps its own launch token and reads `waiting`;
#      the "launch start not recorded" row reads `pending` with no launch
#      start (the statement's own harness `status` read).
#   5. The latch life (p2_latch_life), in a state dir of its own
#      (`new_state_dir`: a start runs its state dir's last-applied record, and
#      this life adds the personas with no row): every Part 2 persona is
#      configured; each latches at its bring-up (p2_check_latch): its
#      latch-set line (`conflictLatchSetLine`: its case, refused operation and
#      recorded state, the quoted session read from the line), logged once;
#      the bring-up's refused call, the bot server's (a `resume`, a plain
#      spawn, the pane verb, or for the relabelled legs the `send-keys`, as
#      the table says; exactly one, but for the own-id persona, whose earlier
#      `resume`s may get "still starting"; the bring-up ladder's other calls,
#      on a finished row `get`, `spawn`, `get` before the `resume`, are
#      recorded, not asserted), and no CSCB `kill` before the latch; for
#      "launch start not recorded", no CSCB call of its id at all before the
#      latch, the bot server's first `list` of the life (the start sweep's)
#      being the round timer's starting point, and its row recording no
#      launch start; exactly one post on its channel in this life, the
#      CONFLICT notice (SRJ-1004's lines in order: the persona prefix and the
#      case's first line quoting the session; the description line, holding
#      the case phrase; for "a different instance id" its must-not-be-ended
#      line in place of the pointer; for "another agent-director store" its
#      must-not-be-ended line, then the pointer; for every other case the
#      pointer; the list line; the human-only line; every line but the
#      description line equal to the printed line, so no command is named),
#      or, for the unusable recorded name, SRJ-1019's notice (the persona
#      prefix, then `unusableNameNoticeText`'s text for its key around the
#      quoted description: the head, `cscb_<key>`, the pointer to "Operator
#      actions"; the description holding agent-director's unusable-name
#      phrase and the unusable name), or, for "launch start not recorded",
#      SRJ-1020's notice exactly as printed (`launchStartNotRecordedNoticeText`
#      with the persona prefix); the harness reads the row (none for the
#      scan's refusal).
#   6. The clearing schedule (p2_clearing_schedule): one clearing event per
#      round, each made right after the round before it settled (its round
#      line logged), with no heavy check between a round and its event:
#        R1, R2: every persona still latched;
#        batched round (R3): right after R2 of every batched persona, the
#          harness ends the no-label, another-store, leftover, scan-refusal
#          and no-label-new-id sessions by their ids and renames the borrowed
#          session back to its own name; their R3 retries launch;
#        own-id round (R4): right after the own-id persona's R3, the harness
#          ends its session by its id;
#        "launch start not recorded" needs no harness event: the first
#          store-wide `find-missing` marks its row `missing` (in practice the
#          own-id round's, CSCB's own; the harness's loop if none ran
#          before it), and its next round clears it;
#        pane-not-found round (R5): right after that persona's R4, the
#          harness selects `at-once` for its stub and ends its session by
#          its id;
#        the unusable recorded name keeps its rounds to the end; its rounds
#          so far are taken right after its round in R5;
#        the relabelled legs' events (p2_relabel_events): right after one
#          more round of each leg, the harness respawns leg 1's worker pane
#          with `sleep` and ends leg 2's session by its id (END_MARK), then
#          starts the find-missing loop (LOOP_MARK);
#        the legs' rounds (p2_relabel_rounds): a harness read shows each
#          leg's row `missing` (the loop's mark); leg 1's next round's line
#          (the finished-row retry, relatched with "left over from an earlier
#          life") and its following round's line (the new case, still
#          latched) are seen; leg 2's next round's line (the finished-row
#          retry, cleared) is seen.
#      Then the checks, from the logs (p2_checks, then p2_relabel_checks):
#        - the round checker (check_latched_rounds), for every latched
#          persona between its latch and its clearing event (for the unusable
#          recorded name, its round in R5): its
#          CSCB-parented shim lines naming its id are exactly, round by round,
#          one `status` then the table's call (`latch_rounds`; read from the
#          shim's argv: a `spawn` with or without `--reuse-finished`, a
#          `read-pane` with `--n-lines 1` and no `--allow-pending`); as many
#          rounds as still-latched round lines (`latchRecheckRoundLine`, at
#          least MIN_LATCHED_ROUNDS); the first round's `status` at least one
#          interval (LATCH_RECHECK_INTERVAL_MS) after the persona's last call
#          before the latch and within the interval plus SETTLE_S, each next
#          one at least one interval after the previous and within the
#          interval plus SETTLE_S, each round's call within SETTLE_S of its
#          `status`; no post beyond the latch's in those rounds; for the
#          launch retries, the row (none for the scan's refusal) keeps the
#          state and row_version read at the latch;
#        - each batched clear (check_retry_clear): the round's first two calls
#          of the id are one `status` then the table's call, at the cadence,
#          with no CSCB `find-missing` between them; the call launches: the
#          clear line (`latchClearedLine`, reason "a retry of the refused
#          operation was not refused", posted), once; the row reads `waiting`
#          on its session name; the server registers its stub's MCP session;
#          exactly one recovery post, the printed recovery notice
#          (`conflictRecoveryText`), and no other post since the latch;
#        - each probe clear (check_probe_clear): the round's calls of the id
#          start with one `status` then one `read-pane` (one line, no
#          allow_pending), at the cadence; exactly one CSCB `find-missing` in
#          the round's window (from that `status` to the moment its round line
#          was seen), after the `read-pane` and before the retry, and no
#          call of the id between the two; then exactly one retry, which
#          launches: the own-id persona's one `resume`, its first call after
#          the `find-missing`; the pane-not-found persona's one run of the
#          restart path's decision, one `resume`, before which at most one
#          spawn comes, the ladder's plain spawn (meeting the row), besides
#          its reads;
#          the round line names the probe, the `find-missing` and the retry,
#          cleared; the clear line, the row `waiting`, the MCP session and one
#          recovery post, as above;
#        - no CSCB `kill`, `kill-finished` or `delete` names a Part 2
#          persona's id in the latch life; the borrowed session still runs;
#          positive control for the probe's "no `--allow-pending`": the
#          reader shows that flag on a CSCB `read-pane` of Part 2's first life
#          (the approver's read of a `pending` row);
#        - the loop (check_loop_runs): its `find-missing` lines have the
#          loop's subshell as their parent, none reads as a CSCB process's,
#          the first comes after leg 2's end; the harness ran no
#          `find-missing` in Part 2 before the loop;
#        - AC 44 (check_nothing_typed): from the latch life's start to each
#          leg's event, no tmux send-keys, send-prefix or paste-buffer
#          reached the relabelled worker pane (by pane id, session id or
#          name; the tmux shim's log); positive control: the first life's
#          approver's send-keys into it;
#        - each leg's rounds up to its event: the round checker (each
#          `status` alone, at the cadence, no post) and the row's state and
#          row_version as read at the latch (a live reading never clears);
#        - leg 1 (check_relabel_relatch): after its event, any rounds of
#          `status` alone come before the harness's read showed the row
#          `missing`; the next round is one `status` (after the loop's first
#          `find-missing`), one `get` and one `resume`, at the cadence; its
#          line says relatched with "left over from an earlier life", once;
#          the relatch's latch-set line (refused operation `resume`, row
#          `missing`, the previous case named), once; exactly one new post,
#          the CONFLICT notice of the new case; each following round one
#          `status` then one `resume`, at the cadence, as many as their round
#          lines, with no post; no recovery post;
#        - leg 2 (check_relabel_clear): the same rounds up to its `status`,
#          `get` and `resume`, which launches: its line says cleared, once;
#          the clear line (reason "its row finished and a relaunch was not
#          refused"), the row `waiting` on its first life's session id, the
#          MCP session and one recovery post, with no post between the
#          latch's notice and it;
#        - "launch start not recorded" (check_launch_start): every
#          still-latched round one `status` alone at the cadence (at least
#          MIN_LATCHED_ROUNDS); a `find-missing` (whose run it was is logged)
#          between the last of them and the clearing round's `status`; the
#          clear line (reason "its agent-director row reads missing") and
#          the clearing round's line, once each; the retry's first call
#          within SETTLE_S of that `status`, with no CSCB `find-missing`
#          between them; one after-clear retry line; one "Hold cleared"
#          post, the printed one, right after the latch's notice. The
#          retry's calls and answer, any later post and the row's state are
#          logged (ruling S8).
#   7. The loop stopped, then a plain `stop` (no --stop-bots, so no `pause`
#      of any stub: each would wait out its 30 s timeout and the stop would
#      pass its 90 s bound), then the closing assertions. The bots keep
#      running; the trap ends them with the scenario's tmux server. The
#      persona still latched with the unusable name keeps its row, which
#      still records that name, and its latch never cleared (no clear line);
#      leg 1 stayed latched (no clear line, no recovery post); every row is
#      present; no counted launch-failure line names a Part 2 persona but
#      "launch start not recorded"'s, whose count is logged (ruling S8).
#
# Waits and their derivation (seconds): STUB_WAIT_S (20) for the Slack
# stub's ready file; START_WAIT_S (120) per start pass and for each latch-set
# line after it; REPORT_WAIT_S (60) for the approver's Enter (it reads the
# pane every lap, about 1 s apart) and the stub's report-in; CONNECT_WAIT_S
# (30) for the server to register the stub's MCP session; EXIT_WAIT_S (30)
# for the stub's SessionEnd hooks and its session's end after the exit line;
# NOTICE_WAIT_S (30) for a post after the line that causes it; AGE_MARGIN_S
# (5) past the starting-session bound for the own-id persona's session;
# HOLD_S (10) that the pane-not-found persona's row keeps reading `waiting`
# after its respawn (a SessionEnd hook runs within a second or two). The
# re-check interval is fixtures/fmk-texts.ts's LATCH_RECHECK_INTERVAL_MS
# (120 s). SETTLE_S (30) is the stated settle: a round's own calls (one
# `status` and one call, each one agent-director process, a few seconds at
# most), the timer's start after the previous round settled, and the shim's
# process start. Each round line is waited for within n times the sum of the
# interval and twice SETTLE_S for its n-th round from the latch. A leg's row is read
# `missing` within the loop's interval (SCENARIO_FIND_MISSING_INTERVAL_S, 30)
# plus 60 of the loop's start (its first run is at once); each leg's next
# round line is waited for within twice the interval plus twice SETTLE_S.
# Part 1: the approver's first `read-pane` of the held-dialog persona's row
# within START_WAIT_S of the note persona's latch-set line; its report-in
# after the Enter within REPORT_WAIT_S; round k+1's line within the sum of
# the interval and twice SETTLE_S of the harness read showing `waiting`; the
# after-clear run's `find-missing` for up to SETTLE_S after that line (not
# asserted there; its presence is checked in step 6); a harness `get` with no note
# within the loop's interval plus 60 of the loop's start; the note persona's
# clearing round line within twice the sum of the interval and twice
# SETTLE_S; the held-dialog persona's worker's end within EXIT_WAIT_S.
# Expected runtime: about 32 minutes. Part 1 about 8.5 (its first life and
# the note under 0.5, the held-dialog persona's rounds k and k+1 and the note
# persona's clearing round about 6, the checks and the end under 2); Part 2
# about 24 (the first life and the age wait about 5.5, the set-up stop under
# 1, the latch life's rounds to the last clearing round about 11, one more
# leg round, the retry round and the following round about 6, and the
# checks).
#
# Matched values. CSCB's values come from fixtures/fmk-texts.ts, printed from
# the installed package, never retyped:
# - personaInstanceId and personaTmuxSessionName (src/persona-identity.ts),
#   personaNoticePrefix and formatPersonaNotice (src/persona-notifier.ts);
# - from src/conflict-latch.ts: the LATCH_CASE_*, REFUSED_OPERATION_* and
#   RECHECK_STEP_* / RECHECK_CALL_* values the table names,
#   LATCH_ROW_STATE_KIND_NO_ROW, LATCH_RECHECK_INTERVAL_MS,
#   RECHECK_VERDICT_STILL_LATCHED, the CONFLICT_NOTICE_* lines,
#   CONFLICT_RECOVERY_HEAD, UNUSABLE_NAME_NOTICE_HEAD, and the builders
#   unusableNameNoticeText (with a placeholder description, split there into
#   the text before and after it), conflictNoticeFirstLine, conflictNoticeListLine,
#   conflictRecoveryText, conflictLatchSetLine (cut at a placeholder
#   session, the fragments a latch line is waited for by), latchClearedLine
#   and latchRecheckRoundLine; LAUNCH_START_NOTICE_HEAD, HOLD_RECOVERY_HEAD,
#   launchStartNotRecordedNoticeText and holdRecoveryText (with
#   latchRecoveryReasonRowReads);
# - latchClearRetryAtOnceLineHead (src/session-manager.ts), the head of the
#   after-clear retry's lines;
# - the case phrases CONFLICT_*_PHRASE and UNUSABLE_RECORDED_NAME_PHRASE
#   (src/ad-description-phrases.ts);
# - PANE_READ_PANE, PANE_READ_CONFLICT and PANE_READ_GONE (src/pane-read.ts),
#   the answer kinds a probe round's line names;
# - LATCHING_LIVENESS_NOTE (src/row-read-rules.ts), the note a harness `get`
#   shows on Part 1's note persona's row;
# - agent-director's default `[tmux] starting_session_seconds`
#   (src/ad-settings.ts DEFAULT_AD_SETTINGS).
# Fragments with no exported value, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - a launch round's answer `still-latched`, and a cleared probe's answer
#   `probe-cleared (<kind>); cleared (` with its call
#   `read-pane+find-missing+<retry>` (src/session-manager.ts
#   runLatchRecheckRound, latchRecheckClearedProbeRetry); a finished-row
#   retry's call `<RECHECK_CALL_FINISHED_ROW>:<launch>` and its answers
#   `relatched (case=<case>)` and `cleared (`, and a table clear's answer
#   `cleared (<step>)` (runLatchRecheckRound);
# - the counted launch-failure lines' heads `[slack] Launch failed for
#   persona=` and `[slack] Session relaunch failed for persona=`, each
#   followed by the key (src/restart.ts countLaunchFailure's lines); the
#   script first finds each in the installed package's src/restart.ts, so a
#   rewording fails the script rather than leaving a zero count vacuous;
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef);
# - `--reuse-finished`, `--n-lines` and `--allow-pending`, the agent-director
#   client's flags for a spawn's reuse_finished and a read-pane's n_lines and
#   allow_pending (the agent-director 0.11.0 npm client);
# - agent-director's row states `ended`, `missing`, `pending` and `waiting`,
#   and its row fields `liveness_note` and `proc_starttime`.
#
# Closing: the script ends with a plain `stop`, then `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell, and no `delete` at all in the shim's log. Every count of CSCB's
# agent-director calls reads only shim lines whose parent is a CSCB process;
# no step reads a pane's text.
#
# Hatch gaps and recorded outcomes:
# - AC 44's waiting-row check: the `read-pane` a health tick makes before it
#   returns the relabelled pane is not shown here (`health_check_interval`
#   0; the reconnect that meets "not this launch's session" comes from the
#   latch life's bring-up after a server restart, the working default); it
#   needs health ticks against the stub;
# - what the "launch start not recorded" retry meets beside the
#   still-running session is logged, not asserted (ruling S8);
# - the stub fires no SessionEnd when its pane is respawned, which the
#   pane-not-found persona's hold and leg 1 rely on;
# - Part 1's note (a working default): agent-director 0.11.0's find-missing
#   writes a liveness note only on a live row whose agent process it cannot
#   check, so the harness's statement (p1_proc_starttime, one guarded
#   `ad_store_edit` UPDATE of proc_starttime and row_version) gives the note
#   persona's row a pid-only identity for the one harness `find-missing`
#   that writes it, and puts it back; this statement is script-local, beyond
#   SRJ-1306's list of harness-only store statements;
# - which run removed the note persona's note (the store-wide `find-missing`
#   after AC 43's clear, or the harness's loop) is logged, not asserted
#   (ruling S8);
# - the held-dialog persona's after-clear retry's answer (in practice
#   `already-connected`) is logged, not asserted (ruling S8);
# - the note persona's clearing run of the restart path's decision, on its
#   live row, is recorded, not asserted beyond its bounds (no `resume`, no
#   `kill`, at most one plain spawn).
set -euo pipefail

TEST_NAME="test-23-fmk-latch-recheck"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bounds (seconds; see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
CONNECT_WAIT_S=30
EXIT_WAIT_S=30
NOTICE_WAIT_S=30
SETTLE_S=30
AGE_MARGIN_S=5
HOLD_S=10

# The still-latched rounds every latched persona shows before its clearing
# round (SRJ-1422: at least two).
MIN_LATCHED_ROUNDS=2

FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
}

# rows_count <text>: print how many lines <text> holds (0 when empty).
rows_count() {
    if [[ -z "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l <<< "$1" | tr -d ' '
}

# field_of <n> <rows>: print field <n> of each TAB-separated row.
field_of() {
    [[ -z "$2" ]] || cut -f "$1" <<< "$2"
}

# verb_rows <verb> <rows>: print the rows whose verb (field 4) is <verb>.
verb_rows() {
    [[ -z "$2" ]] || awk -F'\t' -v v="$1" '$4 == v' <<< "$2"
}

# us_of <time>: a shim time (seconds, six decimals) in microseconds.
us_of() {
    [[ "$1" =~ ^[0-9]+\.[0-9]{6}$ ]] || fail "us_of: '$1' is not a shim time"
    echo $(( 10#${1/./} ))
}

# secs_of <us>: microseconds as seconds with three decimals (for messages).
secs_of() {
    printf '%d.%03d' $(( $1 / 1000000 )) $(( ($1 % 1000000) / 1000 ))
}

# start_slack_stub <dir> <label>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <label> and refusing any
# other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and SCENARIO_SLACK_RECORD (slack_posts' default record).
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
    SCENARIO_SLACK_RECORD="${dir}/record.jsonl"
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# prepare_persona <key>: its working directory and credentials file, and its
# instance id and launch session name from the package.
prepare_persona() {
    local key="$1" label="${PERSONA_TOKEN[$1]}" creds="${SCENARIO_ROOT}/credentials"
    [[ -d "${creds}" ]] || mkdir -m 700 "${creds}"
    PERSONA_WORK[${key}]="$(make_workdir "${key}")"
    PERSONA_CREDS[${key}]="${creds}/${key}.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${label}")" "$(fake_token app "${label}")" \
        | write_file "${PERSONA_CREDS[${key}]}" 600
    PERSONA_ID[${key}]="$(fmk_text personaInstanceId "${key}")" || fail "setup: fmk-texts.ts could not print personaInstanceId ${key}"
    PERSONA_NAMED[${key}]="$(fmk_text personaTmuxSessionName "${key}")" \
        || fail "setup: fmk-texts.ts could not print personaTmuxSessionName ${key}"
}

# write_personas_config <key>...: the server's config.json, configuring the
# given personas (in that order) with `health_check_interval` 0.
write_personas_config() {
    local key personas="[]"
    for key in "$@"; do
        personas="$(jq -c --arg n "${PERSONA_NAME[${key}]}" --arg c "${PERSONA_CREDS[${key}]}" \
            --arg w "${PERSONA_WORK[${key}]}" --arg ch "${PERSONA_CHANNEL[${key}]}" \
            '. + [{name: $n, credentials_file: $c, working_directory: $w,
                   channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}]' <<< "${personas}")" \
            || fail "config: jq could not add persona ${key}"
    done
    jq -n --argjson p "${personas}" --argjson port "${SCENARIO_PORT}" \
        '{personas: $p, bind: "127.0.0.1", port: $port, health_check_interval: 0, exit_timeout: 5}' \
        | write_config
}

# read_row <step> <instance-id>: a harness `get` of the row. Sets ROW_STATE,
# ROW_SID (claude_session_id) and ROW_SESSION (tmux_session_name), each
# empty when absent.
read_row() {
    local fields
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .claude_session_id // "", .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$1: the harness get of $2 printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_SESSION <<< "${fields}"
}

# row_reads <step> <instance-id> <state>...: read the row; true when its
# state is one of the <state>s.
row_reads() {
    local step="$1" id="$2" s
    shift 2
    read_row "${step}" "${id}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# wait_row <step> <timeout-s> <instance-id> <state>...: read the row until
# its state is one of the <state>s; fail, naming the last state read, when
# it is not within <timeout-s>.
wait_row() {
    local step="$1" timeout_s="$2" id="$3" deadline
    shift 3
    deadline=$(( SECONDS + timeout_s ))
    until row_reads "${step}" "${id}" "$@"; do
        (( SECONDS < deadline )) \
            || fail "${step}: row ${id} never read $* (not within ${timeout_s}s; last read '${ROW_STATE}')"
        sleep "${SCENARIO_POLL_S}"
    done
}

# store_row <step> <instance-id>: the harness's read-only store read of the
# row (lib/scenario.sh's `_scenario_row_json`, both guards first). Sets
# STORE_STATE and STORE_RV (row_version).
store_row() {
    local json
    json="$(_scenario_row_json "$1" "$2")" || exit 1
    STORE_STATE="$(jq -r '.[0].state' <<< "${json}")"
    STORE_RV="$(jq -r '.[0].row_version' <<< "${json}")"
    [[ "${STORE_RV}" =~ ^[0-9]+$ ]] || fail "$1: the row's row_version reads '${STORE_RV}'"
}

# store_rows_of <step> <instance-id>: print how many rows the store holds
# with <instance-id> (the harness's read-only store read, both guards first).
store_rows_of() {
    _scenario_store_read "$1" "SELECT COUNT(*) FROM spawns WHERE claude_instance_id = '$2'"
}

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# True when the scenario's tmux server holds the session with id <$N>.
has_session_id() {
    "${SCENARIO_REAL_TMUX}" has-session -t "$1" 2> /dev/null
}

# True while the scenario's tmux server holds no session named exactly <name>.
session_gone() {
    ! has_session "$1"
}

# session_older_than <name> <seconds>: true once the session <name> was
# created more than <seconds> ago (tmux's session_created).
session_older_than() {
    local created
    created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{session_created}' 2> /dev/null)" || return 1
    [[ "${created}" =~ ^[0-9]+$ ]] || return 1
    (( $(date +%s) - created > $2 ))
}

# posts_of <key> <file>: write the posts on persona <key>'s channel to <file>
# and set POSTS to them (one element per post, in record order).
posts_of() {
    slack_posts "${PERSONA_CHANNEL[$1]}" > "$2"
    POSTS=()
    mapfile -d '' -t POSTS < "$2"
}

# post_count <key>: print how many posts persona <key>'s channel holds.
post_count() {
    posts_of "$1" "${SCENARIO_ROOT}/posts-count.bin"
    echo "${#POSTS[@]}"
}

# posts_since <key> <from-index>: print how many posts persona <key>'s channel
# holds from index <from-index> on.
posts_since() {
    local n
    n="$(post_count "$1")" || exit 1
    echo $(( n - $2 ))
}

# posts_holding <key> <from-index> <text>: set HOLDING to the posts on
# persona <key>'s channel from index <from-index> on that hold <text>.
posts_holding() {
    local post i
    posts_of "$1" "${SCENARIO_ROOT}/posts-holding.bin"
    HOLDING=()
    for (( i = $2; i < ${#POSTS[@]}; i++ )); do
        post="${POSTS[i]}"
        [[ "${post}" != *"$3"* ]] || HOLDING+=("${post}")
    done
}

# posts_holding_at_least <key> <from-index> <text> <n>: true once at least
# <n> posts from <from-index> on hold <text>.
posts_holding_at_least() {
    posts_holding "$1" "$2" "$3"
    (( ${#HOLDING[@]} >= $4 ))
}

# split_on <text> <separator>: set PARTS to <text>'s parts between the
# <separator>s.
split_on() {
    local rest="$1" sep="$2"
    PARTS=()
    while [[ "${rest}" == *"${sep}"* ]]; do
        PARTS+=("${rest%%"${sep}"*}")
        rest="${rest#*"${sep}"}"
    done
    PARTS+=("${rest}")
}

# latch_lines_of <key>: print persona <key>'s conflict-latch server-log lines
# (its latch, clear and round lines), indented, on stderr (for a failure's
# diagnosis).
latch_lines_of() {
    grep -F -e "conflict-latch: persona=$1 " -e "conflict-latch: re-check of $(persona_ref "${PERSONA_NAME[$1]}")" \
        "${SLACK_STATE_DIR}/server.log" | sed 's/^/  | /' >&2 || true
}

# calls_of <key> <from-mark> [<to-mark>]: print persona <key>'s CSCB calls
# between the marks, indented, on stderr (for a failure's diagnosis).
calls_of() {
    ad_cscb_calls "${PERSONA_ID[$1]}" "$2" "${3:--}" | sed 's/^/  | /' >&2 || true
}

# check_cadence <step> <previous-us> <status-us> <call-us> <call>: fail
# unless the round's read of the row (its `status`, or its `get` for a
# "conflicting labels" latch) comes at least one interval after
# <previous-us> and within the interval plus SETTLE_S, and its call within
# SETTLE_S of that read.
check_cadence() {
    local step="$1" gap
    gap=$(( $3 - $2 ))
    (( gap >= INTERVAL_US )) \
        || fail "${step}: the round's read came $(secs_of "${gap}") s after the previous point, less than the ${INTERVAL_S} s interval"
    (( gap <= INTERVAL_US + SETTLE_S * 1000000 )) \
        || fail "${step}: the round's read came $(secs_of "${gap}") s after the previous point, more than the ${INTERVAL_S} s interval plus the ${SETTLE_S} s settle"
    (( $4 - $3 <= SETTLE_S * 1000000 )) \
        || fail "${step}: the round's $5 came $(secs_of $(( $4 - $3 ))) s after its read, more than the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: read $(secs_of "${gap}") s after the previous point, $5 $(secs_of $(( $4 - $3 ))) s after it"
}

# round_call_is <call> <verb> <args>: true when a CSCB call of <verb> with
# the arguments <args> (a reader row's `printf %q`-quoted words) is the
# re-check call <call>, read from the agent-director shim's argv:
# RECHECK_CALL_RESUME, a `resume`; RECHECK_CALL_PLAIN_SPAWN, a `spawn` with
# no `--reuse-finished`; RECHECK_CALL_REUSE_SPAWN, a `spawn` carrying
# `--reuse-finished`; RECHECK_CALL_PROBE, a `read-pane` carrying
# `--n-lines 1` and no `--allow-pending`; RECHECK_CALL_PENDING_READ_PANE, a
# `read-pane` carrying `--n-lines 1` and `--allow-pending`.
round_call_is() {
    case "$1" in
        "${CALL_RESUME}") [[ "$2" == resume ]] ;;
        "${CALL_PLAIN_SPAWN}") [[ "$2" == spawn && " $3 " != *" --reuse-finished "* ]] ;;
        "${CALL_REUSE_SPAWN}") [[ "$2" == spawn && " $3 " == *" --reuse-finished "* ]] ;;
        "${CALL_PROBE}") [[ "$2" == read-pane && " $3 " == *" --n-lines 1 "* && " $3 " != *" --allow-pending "* ]] ;;
        "${CALL_PENDING_READ}") [[ "$2" == read-pane && " $3 " == *" --n-lines 1 "* && " $3 " == *" --allow-pending "* ]] ;;
        *) fail "round_call_is: '$1' is not a re-check call this script reads" ;;
    esac
}

# latch_rounds <step> <key> <from-mark> <to-mark>: the round checker's
# reader. Persona <key>'s CSCB-parented calls after <from-mark> (up to
# <to-mark>), from E42 T1's reader (`ad_cscb_calls`), must be, in log
# order, one read of the row (READ_OF: `get` for a "conflicting labels"
# latch, else `status`) then one call of the persona's table call (CALL_OF,
# as round_call_is reads it) per round, or, for RECHECK_CALL_NONE, one read
# alone per round, and no other call; fails otherwise, and on a read with no
# call after it. Prints one line per round,
# `<status-pos> <status-us> <call-pos> <call-us>` (the read's own for a
# round with no call).
latch_rounds() {
    local step="$1" key="$2" from="$3" to="$4" id="${PERSONA_ID[$2]}" call="${CALL_OF[$2]}" rows pos time verb args
    local read="${READ_OF[$2]:-status}" want=status s_pos="" s_us="" us
    rows="$(ad_cscb_calls "${id}" "${from}" "${to}")" || exit 1
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _ args; do
        if [[ "${want}" == status && "${verb}" == "${read}" ]]; then
            s_pos="${pos}"
            s_us="$(us_of "${time}")" || exit 1
            if [[ "${call}" == "${CALL_NONE}" ]]; then
                printf '%s %s %s %s\n' "${s_pos}" "${s_us}" "${s_pos}" "${s_us}"
            else
                want="${call}"
            fi
        elif [[ "${want}" == "${call}" && "${call}" != "${CALL_NONE}" ]] && round_call_is "${call}" "${verb}" "${args}"; then
            us="$(us_of "${time}")" || exit 1
            printf '%s %s %s %s\n' "${s_pos}" "${s_us}" "${pos}" "${us}"
            want=status
        else
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${verb} of ${id} at shim line ${pos}, where a round's ${want/status/${read}} belongs (a round is one ${read} then ${call}, and nothing else)"
        fi
    done <<< "${rows}"
    [[ "${want}" == status ]] || fail "${step}: the ${read} of ${id} at shim line ${s_pos} has no ${call} after it"
}

# shim_verb_lines <verb>: print the agent-director shim's `call` lines of
# <verb>, whatever their parent, over the whole log, with lib/scenario.sh's
# line readers.
shim_verb_lines() {
    local lines=() i
    _scenario_query_prep shim_verb_lines
    _scenario_read_log shim_verb_lines "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words
        _scenario_ad_verb
        if [[ "${_L_VERB}" == "$1" ]]; then
            printf '%s\n' "${lines[i]}"
        fi
    done
    return 0
}

# The MCP session registration line's matcher for persona <key>.
connected_match() {
    printf '[slack] Session connected: persona %s\n' "$(persona_ref "${PERSONA_NAME[$1]}")"
}

# no_counted_failures <step> <key>...: server.log holds no counted
# launch-failure line (each of LAUNCH_FAILED_LINES followed by the key) for
# any <key>.
no_counted_failures() {
    local step="$1" key frag
    shift
    for key in "$@"; do
        for frag in "${LAUNCH_FAILED_LINES[@]}"; do
            expect_count "${frag}${key}" 0 "${step}: counted launch-failure lines of ${key}"
        done
    done
    echo "${TEST_NAME}: ${step}: no counted launch failure of $*"
}

# row_holds_waiting <instance-id>: true while the row reads `waiting`.
row_holds_waiting() {
    row_reads "part 2: set-up: the respawned row's hold" "$1" waiting
}

# hold_waiting <step> <instance-id>: for HOLD_S, the row keeps reading
# `waiting`; fails, naming what it read, when it does not.
hold_waiting() {
    local step="$1" id="$2" deadline
    deadline=$(( SECONDS + HOLD_S ))
    while (( SECONDS < deadline )); do
        row_holds_waiting "${id}" || fail "${step}: ${id} reads '${ROW_STATE}' within ${HOLD_S} s of its pane's respawn, not waiting (the stub fired SessionEnd?)"
        sleep "${SCENARIO_POLL_S}"
    done
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

INTERVAL_MS="$(fmk_text LATCH_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print LATCH_RECHECK_INTERVAL_MS"
[[ "${INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: LATCH_RECHECK_INTERVAL_MS is '${INTERVAL_MS}'"
INTERVAL_US=$(( INTERVAL_MS * 1000 ))
INTERVAL_S=$(( (INTERVAL_MS + 999) / 1000 ))
(( INTERVAL_S > SETTLE_S )) || fail "setup: the ${SETTLE_S} s settle is not shorter than the ${INTERVAL_S} s re-check interval"
BOUND_S="$(fmk_text DEFAULT_AD_SETTINGS tmux starting_session_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS tmux starting_session_seconds"
[[ "${BOUND_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the starting-session bound is '${BOUND_S}'"
echo "${TEST_NAME}: re-check interval ${INTERVAL_MS} ms, settle ${SETTLE_S} s, starting-session bound ${BOUND_S} s"

# fmk_value <entry> [<arg>...]: print fixtures/fmk-texts.ts's value, failing
# the scenario when the printer fails or prints nothing.
fmk_value() {
    local v
    v="$(fmk_text "$@")" || fail "setup: fmk-texts.ts could not print $*"
    [[ -n "${v}" ]] || fail "setup: fmk-texts.ts printed an empty $*"
    printf '%s' "${v}"
}

CASE_NO_VALID_ID="$(fmk_value LATCH_CASE_NO_VALID_ID)"
CASE_DIFFERENT_ID="$(fmk_value LATCH_CASE_DIFFERENT_ID)"
CASE_ANOTHER_STORE="$(fmk_value LATCH_CASE_ANOTHER_STORE)"
CASE_LEFTOVER="$(fmk_value LATCH_CASE_LEFTOVER)"
CASE_OWN_ID="$(fmk_value LATCH_CASE_OWN_ID)"
CASE_PANE_NOT_FOUND="$(fmk_value LATCH_CASE_PANE_NOT_FOUND)"
CASE_UNUSABLE="$(fmk_value LATCH_CASE_UNUSABLE_RECORDED_NAME)"
OP_RESUME="$(fmk_value REFUSED_OPERATION_RESUME)"
OP_PLAIN_SPAWN="$(fmk_value REFUSED_OPERATION_PLAIN_SPAWN)"
OP_NEXT_CHECK="$(fmk_value REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY)"
OP_NONE="$(fmk_value REFUSED_OPERATION_NONE)"
ROW_NO_ROW="$(fmk_value LATCH_ROW_STATE_KIND_NO_ROW)"
STEP_TABLE="$(fmk_value RECHECK_STEP_TABLE)"
STEP_SPAWN_RETRY="$(fmk_value RECHECK_STEP_SPAWN_RETRY)"
CALL_RESUME="$(fmk_value RECHECK_CALL_RESUME)"
CALL_PLAIN_SPAWN="$(fmk_value RECHECK_CALL_PLAIN_SPAWN)"
CALL_REUSE_SPAWN="$(fmk_value RECHECK_CALL_REUSE_SPAWN)"
CALL_PROBE="$(fmk_value RECHECK_CALL_PROBE)"
CALL_NONE="$(fmk_value RECHECK_CALL_NONE)"
CALL_RESTART_DECISION="$(fmk_value RECHECK_CALL_RESTART_DECISION)"
VERDICT_STILL="$(fmk_value RECHECK_VERDICT_STILL_LATCHED)"
KIND_PANE="$(fmk_value PANE_READ_PANE)"
KIND_CONFLICT="$(fmk_value PANE_READ_CONFLICT)"
KIND_GONE="$(fmk_value PANE_READ_GONE)"
NO_VALID_ID_PHRASE="$(fmk_value CONFLICT_NO_VALID_ID_PHRASE)"
DIFFERENT_ID_PHRASE="$(fmk_value CONFLICT_DIFFERENT_ID_PHRASE)"
ANOTHER_STORE_PHRASE="$(fmk_value CONFLICT_ANOTHER_STORE_PHRASE)"
LEFTOVER_PHRASE="$(fmk_value CONFLICT_LEFTOVER_PHRASE)"
OWN_ID_PHRASE="$(fmk_value CONFLICT_OWN_ID_PHRASE)"
PANE_NOT_FOUND_PHRASE="$(fmk_value CONFLICT_PANE_NOT_FOUND_PHRASE)"
UNUSABLE_PHRASE="$(fmk_value UNUSABLE_RECORDED_NAME_PHRASE)"
CONFLICT_HEAD="$(fmk_value CONFLICT_NOTICE_FIRST_LINE_HEAD)"
DESC_HEAD="$(fmk_value CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)"
DESC_TAIL="$(fmk_value CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)"
POINTER_LINE="$(fmk_value CONFLICT_NOTICE_POINTER_LINE)"
DIFFERENT_ID_MUST_NOT_END_LINE="$(fmk_value CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE)"
STORE_MUST_NOT_END_LINE="$(fmk_value CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE)"
HUMAN_LINE="$(fmk_value CONFLICT_NOTICE_HUMAN_ONLY_LINE)"
RECOVERY_HEAD="$(fmk_value CONFLICT_RECOVERY_HEAD)"
NOTICE_SEP="$(fmk_text CONFLICT_NOTICE_LINE_SEPARATOR && printf x)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_LINE_SEPARATOR"
NOTICE_SEP="${NOTICE_SEP%x}"
[[ -n "${NOTICE_SEP}" ]] || fail "setup: fmk-texts.ts printed an empty CONFLICT_NOTICE_LINE_SEPARATOR"
UNUSABLE_HEAD="$(fmk_value UNUSABLE_NAME_NOTICE_HEAD)"
CASE_NOT_THIS_LAUNCH="$(fmk_value LATCH_CASE_NOT_THIS_LAUNCH)"
CASE_LAUNCH_START="$(fmk_value LATCH_CASE_LAUNCH_START_NOT_RECORDED)"
STEP_FINISHED_ROW="$(fmk_value RECHECK_STEP_FINISHED_ROW_RETRY)"
CALL_FINISHED_ROW="$(fmk_value RECHECK_CALL_FINISHED_ROW)"
NOT_THIS_LAUNCH_PHRASE="$(fmk_value CONFLICT_NOT_THIS_LAUNCH_PHRASE)"
LAUNCH_START_HEAD="$(fmk_value LAUNCH_START_NOTICE_HEAD)"
HOLD_HEAD="$(fmk_value HOLD_RECOVERY_HEAD)"

# The counted launch-failure lines' heads, each followed by the persona key
# (src/restart.ts: countLaunchFailure's lines, each a template literal). No
# export carries them, so each is first found, whole up to the key, in the
# installed package's src/restart.ts: a rewording fails here rather than
# leaving a zero count vacuous.
LAUNCH_FAILED_LINES=("[slack] Launch failed for persona=" "[slack] Session relaunch failed for persona=")
RESTART_SRC="${SCENARIO_REPO}/node_modules/claude-slack-channel-bots/src/restart.ts"
for frag in "${LAUNCH_FAILED_LINES[@]}"; do
    # shellcheck disable=SC2016 # `${key}` is the source's own text.
    grep -q -F -e "\`${frag}"'${key}' "${RESTART_SRC}" \
        || fail "setup: the installed ${RESTART_SRC} logs no counted launch-failure line '${frag}\${key}…'"
done

# ---------------------------------------------------------------------------
# Part 2: personas, by key, and the per-case table
# ---------------------------------------------------------------------------

NL_KEY="$(persona_key nolabel)"
DI_KEY="$(persona_key foreign)"
AS_KEY="$(persona_key otherstore)"
LO_KEY="$(persona_key leftover)"
SL_KEY="$(persona_key scanleft)"
DS_KEY="$(persona_key dupnone)"
OI_KEY="$(persona_key ownid)"
PN_KEY="$(persona_key panegone)"
UN_KEY="$(persona_key badname)"
R1_KEY="$(persona_key relabelone)"
R2_KEY="$(persona_key relabeltwo)"
NS_KEY="$(persona_key nostart)"

declare -A PERSONA_NAME=([${NL_KEY}]=nolabel [${DI_KEY}]=foreign [${AS_KEY}]=otherstore [${LO_KEY}]=leftover
    [${SL_KEY}]=scanleft [${DS_KEY}]=dupnone [${OI_KEY}]=ownid [${PN_KEY}]=panegone [${UN_KEY}]=badname
    [${R1_KEY}]=relabelone [${R2_KEY}]=relabeltwo [${NS_KEY}]=nostart)
# The post reader's channel table: each persona's one channel, which is also
# where its permission prompts and notices go.
declare -A PERSONA_CHANNEL=([${NL_KEY}]=C0T23NL01 [${DI_KEY}]=C0T23DI01 [${AS_KEY}]=C0T23AS01 [${LO_KEY}]=C0T23LO01
    [${SL_KEY}]=C0T23SL01 [${DS_KEY}]=C0T23DS01 [${OI_KEY}]=C0T23OI01 [${PN_KEY}]=C0T23PN01 [${UN_KEY}]=C0T23UN01
    [${R1_KEY}]=C0T23RA01 [${R2_KEY}]=C0T23RB01 [${NS_KEY}]=C0T23NS01)
# The Slack token label of each persona's fake token pair.
declare -A PERSONA_TOKEN=([${NL_KEY}]=t23nolabel [${DI_KEY}]=t23foreign [${AS_KEY}]=t23otherstore [${LO_KEY}]=t23leftover
    [${SL_KEY}]=t23scanleft [${DS_KEY}]=t23dupnone [${OI_KEY}]=t23ownid [${PN_KEY}]=t23panegone [${UN_KEY}]=t23badname
    [${R1_KEY}]=t23relabelone [${R2_KEY}]=t23relabeltwo [${NS_KEY}]=t23nostart)
# Filled in by the lives. PERSONA_NAMED is the session name the package gives
# the persona's launches (personaTmuxSessionName).
declare -A PERSONA_ID=() PERSONA_WORK=() PERSONA_CREDS=() PERSONA_SID=() PERSONA_NAMED=()

# Every Part 2 persona, in config order; those that need a row (the first
# life's); those whose clear is the batched round's.
P2_KEYS=("${NL_KEY}" "${DI_KEY}" "${AS_KEY}" "${LO_KEY}" "${SL_KEY}" "${DS_KEY}" "${OI_KEY}" "${PN_KEY}" "${UN_KEY}"
    "${R1_KEY}" "${R2_KEY}" "${NS_KEY}")
P2_LIFE1_KEYS=("${NL_KEY}" "${DI_KEY}" "${AS_KEY}" "${LO_KEY}" "${OI_KEY}" "${PN_KEY}" "${UN_KEY}"
    "${R1_KEY}" "${R2_KEY}" "${NS_KEY}")
# The "not this launch's session" legs: leg 1 (pane respawned) and leg 2
# (session ended), both marked by the harness's find-missing loop.
P2_RELABEL_KEYS=("${R1_KEY}" "${R2_KEY}")
P2_BATCH_KEYS=("${NL_KEY}" "${DI_KEY}" "${AS_KEY}" "${LO_KEY}" "${SL_KEY}" "${DS_KEY}")
# The personas whose rows the human's exit line leaves finished.
P2_FINISHED_KEYS=("${NL_KEY}" "${DI_KEY}" "${AS_KEY}" "${LO_KEY}" "${UN_KEY}")

# The borrowed session's own row: the instance id its label names and the
# name it is created with and renamed back to (outside the `cscb_` namespace).
LENDER_ID="${SCENARIO_TAG}_lender"
LENDER_SESSION="${SCENARIO_TAG}_lender"

# The per-case table, by key (the header's table): the case; the refused
# operation the latch-set line records; the row state it records (the
# finished rows' is the state read in the set-up stop); the bring-up's
# refused call (`pane` for the pane verb, `-` for any); each still-latched
# round's step, call and answer; the case phrase agent-director's
# description carries; the set-up step; and the clear.
declare -A CASE_OF=([${NL_KEY}]="${CASE_NO_VALID_ID}" [${DI_KEY}]="${CASE_DIFFERENT_ID}" [${AS_KEY}]="${CASE_ANOTHER_STORE}"
    [${LO_KEY}]="${CASE_LEFTOVER}" [${SL_KEY}]="${CASE_LEFTOVER}" [${DS_KEY}]="${CASE_NO_VALID_ID}" [${OI_KEY}]="${CASE_OWN_ID}"
    [${PN_KEY}]="${CASE_PANE_NOT_FOUND}" [${UN_KEY}]="${CASE_UNUSABLE}"
    [${R1_KEY}]="${CASE_NOT_THIS_LAUNCH}" [${R2_KEY}]="${CASE_NOT_THIS_LAUNCH}" [${NS_KEY}]="${CASE_LAUNCH_START}")
declare -A OP_OF=([${NL_KEY}]="${OP_RESUME}" [${DI_KEY}]="${OP_RESUME}" [${AS_KEY}]="${OP_RESUME}" [${LO_KEY}]="${OP_RESUME}"
    [${SL_KEY}]="${OP_PLAIN_SPAWN}" [${DS_KEY}]="${OP_PLAIN_SPAWN}" [${OI_KEY}]="${OP_RESUME}" [${PN_KEY}]="${OP_NEXT_CHECK}"
    [${UN_KEY}]="${OP_NONE}" [${R1_KEY}]="${OP_NEXT_CHECK}" [${R2_KEY}]="${OP_NEXT_CHECK}" [${NS_KEY}]="${OP_NONE}")
declare -A LATCH_ROW_OF=([${SL_KEY}]="${ROW_NO_ROW}" [${DS_KEY}]=ended [${OI_KEY}]=missing [${PN_KEY}]=waiting
    [${R1_KEY}]=waiting [${R2_KEY}]=waiting [${NS_KEY}]=pending)
# `send-keys`: the bring-up's reconnect, agent-director's send-keys verb;
# `none`: no call of the id at all before the latch (the start sweep's `list`
# latches it).
declare -A REFUSED_OF=([${NL_KEY}]="${CALL_RESUME}" [${DI_KEY}]="${CALL_RESUME}" [${AS_KEY}]="${CALL_RESUME}" [${LO_KEY}]="${CALL_RESUME}"
    [${SL_KEY}]="${CALL_PLAIN_SPAWN}" [${DS_KEY}]="${CALL_PLAIN_SPAWN}" [${OI_KEY}]="${CALL_RESUME}" [${PN_KEY}]=pane [${UN_KEY}]=-
    [${R1_KEY}]=send-keys [${R2_KEY}]=send-keys [${NS_KEY}]=none)
declare -A STEP_OF=([${NL_KEY}]="${STEP_TABLE}" [${DI_KEY}]="${STEP_TABLE}" [${AS_KEY}]="${STEP_TABLE}" [${LO_KEY}]="${STEP_TABLE}"
    [${SL_KEY}]="${STEP_SPAWN_RETRY}" [${DS_KEY}]="${STEP_TABLE}" [${OI_KEY}]="${STEP_TABLE}" [${PN_KEY}]="${STEP_TABLE}"
    [${UN_KEY}]="${STEP_TABLE}" [${R1_KEY}]="${STEP_TABLE}" [${R2_KEY}]="${STEP_TABLE}" [${NS_KEY}]="${STEP_TABLE}")
declare -A CALL_OF=([${NL_KEY}]="${CALL_RESUME}" [${DI_KEY}]="${CALL_RESUME}" [${AS_KEY}]="${CALL_RESUME}" [${LO_KEY}]="${CALL_RESUME}"
    [${SL_KEY}]="${CALL_PLAIN_SPAWN}" [${DS_KEY}]="${CALL_REUSE_SPAWN}" [${OI_KEY}]="${CALL_PROBE}" [${PN_KEY}]="${CALL_PROBE}"
    [${UN_KEY}]="${CALL_NONE}" [${R1_KEY}]="${CALL_NONE}" [${R2_KEY}]="${CALL_NONE}" [${NS_KEY}]="${CALL_NONE}")
declare -A ANSWER_OF=([${NL_KEY}]=still-latched [${DI_KEY}]=still-latched [${AS_KEY}]=still-latched [${LO_KEY}]=still-latched
    [${SL_KEY}]=still-latched [${DS_KEY}]=still-latched [${OI_KEY}]="${VERDICT_STILL} (${KIND_PANE})"
    [${PN_KEY}]="${VERDICT_STILL} (${KIND_CONFLICT})" [${UN_KEY}]=still-latched
    [${R1_KEY}]=still-latched [${R2_KEY}]=still-latched [${NS_KEY}]=still-latched)
declare -A PHRASE_OF=([${NL_KEY}]="${NO_VALID_ID_PHRASE}" [${DI_KEY}]="${DIFFERENT_ID_PHRASE}" [${AS_KEY}]="${ANOTHER_STORE_PHRASE}"
    [${LO_KEY}]="${LEFTOVER_PHRASE}" [${SL_KEY}]="${LEFTOVER_PHRASE}" [${DS_KEY}]="${NO_VALID_ID_PHRASE}" [${OI_KEY}]="${OWN_ID_PHRASE}"
    [${PN_KEY}]="${PANE_NOT_FOUND_PHRASE}" [${UN_KEY}]="${UNUSABLE_PHRASE}"
    [${R1_KEY}]="${NOT_THIS_LAUNCH_PHRASE}" [${R2_KEY}]="${NOT_THIS_LAUNCH_PHRASE}")
declare -A SETUP_OF=([${NL_KEY}]="finished; seed_unlabelled" [${DI_KEY}]="finished; seed_borrowed_name, renamed to its name"
    [${AS_KEY}]="finished; seed_other_store" [${LO_KEY}]="finished; seed_leftover" [${SL_KEY}]="no row; seed_leftover"
    [${DS_KEY}]="no row; seed_unlabelled" [${OI_KEY}]="live, session past the bound; ad_store_mark_finished missing"
    [${PN_KEY}]="live waiting; respawn_worker_pane" [${UN_KEY}]="finished; ad_store_unusable_name"
    [${R1_KEY}]="live waiting, worker running; relabel_session" [${R2_KEY}]="live waiting, worker running; relabel_session"
    [${NS_KEY}]="live, worker running; ad_store_pending_no_launch")
declare -A CLEAR_OF=([${NL_KEY}]=batched [${DI_KEY}]=batched [${AS_KEY}]=batched [${LO_KEY}]=batched [${SL_KEY}]=batched
    [${DS_KEY}]=batched [${OI_KEY}]=own-round [${PN_KEY}]=own-round [${UN_KEY}]=never
    [${R1_KEY}]="never (relatches)" [${R2_KEY}]=finished-row-retry [${NS_KEY}]=row-missing)
# The case phrase agent-director's description carries, by case (a relatch's
# notice is checked by its new case).
declare -A PHRASE_BY_CASE=()
for key in "${P2_KEYS[@]}"; do
    [[ -z "${PHRASE_OF[${key}]:-}" ]] || PHRASE_BY_CASE[${CASE_OF[${key}]}]="${PHRASE_OF[${key}]}"
done
# A probe clear's one retry, as its round line names it.
declare -A RETRY_OF=([${OI_KEY}]="${CALL_RESUME}" [${PN_KEY}]="${CALL_RESTART_DECISION}")

# Filled in by the lives, by key: the seeded session's id; the state the
# set-up left; the latch's shim mark, its last call's time, its session and
# the post count before the latch life; the row's state and row_version at
# the latch; the still-latched round line and the head every round of its
# step and call shares; the clearing event's shim mark, post count,
# registration count and row read; the last still-latched round's status
# time; a cleared probe's round line head and the mark taken when it was
# seen.
declare -A SEED_SID=() LATCH_MARK=() LATCH_US=() SESSION_OF=() POSTS_BEFORE=() LATCH_STATE=() LATCH_RV=()
declare -A STILL_LINE=() ROUND_HEAD=() FREE_ROUNDS=() FREE_MARK=() FREE_POSTS=() FREE_CONNECTS=() FREE_STATE=() FREE_RV=()
declare -A PREV_US=()
declare -A ROUND_END_HEAD=() ROUND_END_MARK=()
# The "not this launch's session" legs, by key: the relabelled worker pane;
# the tmux shim's mark at the harness's event (the pane respawn, or the
# session's end); the shim mark once a harness read showed the row missing;
# the shim mark once the leg's last checked round line was seen.
declare -A SEED_PANE=() EVENT_TMUX_MARK=() MISSING_MARK=()

echo "${TEST_NAME}: Part 2's per-case table:"
for key in "${P2_KEYS[@]}"; do
    printf '%s:   %-10s case=%s refused=%s round=%s+%s clear=%s; set-up: %s\n' "${TEST_NAME}" "${key}" "${CASE_OF[${key}]}" \
        "${OP_OF[${key}]}" "${STEP_OF[${key}]}" "${CALL_OF[${key}]}" "${CLEAR_OF[${key}]}" "${SETUP_OF[${key}]}"
done

# ---------------------------------------------------------------------------
# Part 1: "conflicting labels", from a global @ad_owner value
# ---------------------------------------------------------------------------

# Part 1's personas: the note persona (a `provenance_conflict` note on its
# live row) and the held-dialog persona (AC 43: a `pending` launch held at a
# dialog the approver does not recognise). They stay configured in every
# later life, so Part 2's lives bring them up too; their checks end at their
# clears.
CN_KEY="$(persona_key labelnote)"
HD_KEY="$(persona_key helddialog)"
P1_KEYS=("${CN_KEY}" "${HD_KEY}")
PERSONA_NAME[${CN_KEY}]=labelnote
PERSONA_NAME[${HD_KEY}]=helddialog
PERSONA_CHANNEL[${CN_KEY}]=C0T23CN01
PERSONA_CHANNEL[${HD_KEY}]=C0T23HD01
PERSONA_TOKEN[${CN_KEY}]=t23labelnote
PERSONA_TOKEN[${HD_KEY}]=t23helddialog

CASE_CONFLICTING_LABELS="$(fmk_value LATCH_CASE_CONFLICTING_LABELS)"
OP_BRING_UP="$(fmk_value REFUSED_OPERATION_BRING_UP)"
CALL_PENDING_READ="$(fmk_value RECHECK_CALL_PENDING_READ_PANE)"
STEP_REPORTED_IN="$(fmk_value RECHECK_STEP_CLEAR_REPORTED_IN)"
CONFLICTING_LABELS_PHRASE="$(fmk_value CONFLICT_CONFLICTING_LABELS_PHRASE)"
LATCHING_NOTE="$(fmk_value LATCHING_LIVENESS_NOTE)"

# Part 1's per-case rows (the header's Part 1): the case; the refused
# operation and row state the latch-set line records; each round's read and
# call; a still-latched round's answer.
CASE_OF[${CN_KEY}]="${CASE_CONFLICTING_LABELS}"
CASE_OF[${HD_KEY}]="${CASE_CONFLICTING_LABELS}"
OP_OF[${CN_KEY}]="${OP_BRING_UP}"
OP_OF[${HD_KEY}]="${OP_NEXT_CHECK}"
LATCH_ROW_OF[${CN_KEY}]=waiting
LATCH_ROW_OF[${HD_KEY}]=pending
STEP_OF[${CN_KEY}]="${STEP_TABLE}"
STEP_OF[${HD_KEY}]="${STEP_TABLE}"
CALL_OF[${CN_KEY}]="${CALL_NONE}"
CALL_OF[${HD_KEY}]="${CALL_PENDING_READ}"
ANSWER_OF[${CN_KEY}]=still-latched
ANSWER_OF[${HD_KEY}]="${VERDICT_STILL} (${KIND_CONFLICT})"
PHRASE_BY_CASE[${CASE_CONFLICTING_LABELS}]="${CONFLICTING_LABELS_PHRASE}"
# Each round's read of the row: `get` for a "conflicting labels" latch (only
# `get` shows the note); `status` for every other latch (latch_rounds' default).
declare -A READ_OF=([${CN_KEY}]=get [${HD_KEY}]=get)
# The calls the round checker reads from: after the reads that come within
# one interval of the latch's starting point (no round can), by key.
declare -A ROUNDS_FROM=()

echo "${TEST_NAME}: Part 1's per-case table:"
printf '%s:   %-10s case=%s refused=%s row=%s round=%s+%s clear=%s; set-up: %s\n' "${TEST_NAME}" "${CN_KEY}" \
    "${CASE_OF[${CN_KEY}]}" "${OP_OF[${CN_KEY}]}" waiting get "${CALL_NONE}" "restart path's decision once the note is gone" \
    "live waiting; ${LATCHING_NOTE} from a harness find-missing under a global @ad_owner"
printf '%s:   %-10s case=%s refused=%s row=%s round=%s+%s clear=%s; set-up: %s\n' "${TEST_NAME}" "${HD_KEY}" \
    "${CASE_OF[${HD_KEY}]}" "${OP_OF[${HD_KEY}]}" pending get "${CALL_PENDING_READ}" "${STEP_REPORTED_IN} (waiting)" \
    "${STUB_MODE_UNRECOGNISED}; global @ad_owner set after the approver's first read-pane"

# read_note <step> <instance-id>: a harness `get` of the row (read_row); sets
# ROW_NOTE to its liveness_note, empty when it carries none.
read_note() {
    read_row "$1" "$2"
    ROW_NOTE="$(jq -r '.liveness_note // ""' "${AD_OUT}")" || fail "$1: the harness get of $2 printed no row object"
}

# note_gone <instance-id>: true once a harness `get` shows no liveness_note.
note_gone() {
    read_note "part 1: the note's removal" "$1"
    [[ -z "${ROW_NOTE}" ]]
}

# p1_only <step>: no Part 2 persona exists: every row in the store and every
# session on the scenario's tmux server is a Part 1 persona's.
p1_only() {
    local step="$1" ids id names name key ok
    ids="$(_scenario_store_read "${step}" "SELECT claude_instance_id FROM spawns")" || exit 1
    while IFS= read -r id; do
        [[ -n "${id}" ]] || continue
        ok=0
        for key in "${P1_KEYS[@]}"; do
            [[ "${id}" == "${PERSONA_ID[${key}]}" ]] && ok=1
        done
        (( ok )) || fail "${step}: the store holds row ${id}, not a Part 1 persona's"
    done <<< "${ids}"
    names="$("${SCENARIO_REAL_TMUX}" list-sessions -F '#{session_name}' 2> /dev/null)" || names=""
    while IFS= read -r name; do
        [[ -n "${name}" ]] || continue
        ok=0
        for key in "${P1_KEYS[@]}"; do
            [[ "${name}" == "${PERSONA_NAMED[${key}]}" ]] && ok=1
        done
        (( ok )) || fail "${step}: the scenario's tmux server holds session ${name}, not a Part 1 persona's"
    done <<< "${names}"
    echo "${TEST_NAME}: ${step}: only Part 1's rows ($(tr '\n' ' ' <<< "${ids}")) and sessions ($(tr '\n' ' ' <<< "${names}"))"
}

# skip_early_reads <step> <key>: the persona's CSCB calls after its latch mark
# that come before one interval from the round timer's starting point
# (LATCH_US), where no round can be: at most one `get` (the startup
# JSONL-persistence safeguard's, b.jg5 SRJ-122, recorded), and no other call.
# Sets ROUNDS_FROM to the mark the rounds are read from.
skip_early_reads() {
    local step="$1" key="$2" id="${PERSONA_ID[$2]}" rows pos time verb n=0
    ROUNDS_FROM[${key}]="${LATCH_MARK[${key}]}"
    rows="$(ad_cscb_calls "${id}" "${LATCH_MARK[${key}]}")" || exit 1
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _; do
        (( $(us_of "${time}") < LATCH_US[${key}] + INTERVAL_US )) || break
        [[ "${verb}" == get ]] || { calls_of "${key}" "${LATCH_MARK[${key}]}"; fail "${step}: CSCB ${verb} of ${id} at shim line ${pos}, within one interval of its latch"; }
        n=$(( n + 1 ))
        ROUNDS_FROM[${key}]="${pos}"
        echo "${TEST_NAME}: ${step}: [recorded] a get of ${id} at shim line ${pos}, within one interval of its latch (the startup JSONL-persistence safeguard's, SRJ-122)"
    done <<< "${rows}"
    (( n <= 1 )) || fail "${step}: ${n} get(s) of ${id} within one interval of its latch, more than the safeguard's one"
}

# ---------------------------------------------------------------------------
# Part 1, life 1: the note persona alone; then the note
# ---------------------------------------------------------------------------

p1_life1() {
    local step="part 1: first life" key="${CN_KEY}" id
    for key in "${P1_KEYS[@]}"; do
        prepare_persona "${key}"
    done
    key="${CN_KEY}"
    id="${PERSONA_ID[${key}]}"
    # The note persona's stub reports in at once, so its pane shows no
    # answered dialog when the restart path's reconnect reads it.
    stub_mode "${PERSONA_WORK[${key}]}" "${STUB_MODE_AT_ONCE}"
    write_personas_config "${key}"
    start_server --live
    wait_for_count "$(completion_match 1)" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${id} has no claude_session_id"
    [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the live row ${id} records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
    PERSONA_SID[${key}]="${ROW_SID}"
    wait_for_count "$(connected_match "${key}")" 1 "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as ${key}'s"
    stop_server
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    has_session "${PERSONA_NAMED[${key}]}" || fail "${step}: ${PERSONA_NAMED[${key}]} is gone after a plain stop"
    row_reads "${step}" "${id}" waiting || fail "${step}: ${id} reads '${ROW_STATE}' after a plain stop, not waiting"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting (claude_session_id ${ROW_SID}) in ${ROW_SESSION} after a plain stop"
}

# p1_proc_starttime <step> <instance-id> <json>: the harness's statement on
# the live row's SessionStart process identity: one `ad_store_edit` UPDATE
# setting proc_starttime to <json> (`null`, a whole number, or a string of
# digits, as the store's JSON read gives it) and advancing row_version by
# one, guarded on the row_version read just before; the row is read before
# and after, and every other column must keep its value. Prints the
# proc_starttime the row held before, as JSON.
p1_proc_starttime() {
    local step="$1" id="$2" value="$3" before after rv old out sql
    case "${value}" in
        null) sql=NULL ;;
        *) [[ "${value}" =~ ^\"?([0-9]+)\"?$ ]] || fail "${step}: proc_starttime '${value}' is not null or a whole number"
           sql="${BASH_REMATCH[1]}"
           [[ "${value}" != \"* ]] || sql="'${sql}'" ;;
    esac
    before="$(_scenario_row_json "${step}" "${id}")" || exit 1
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    old="$(jq -c '.[0].proc_starttime' <<< "${before}")"
    out="$(ad_store_edit "UPDATE spawns SET proc_starttime = ${sql}, row_version = row_version + 1 WHERE claude_instance_id = '${id}' AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row's row_version is no longer ${rv}: agent-director wrote it in between, and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${id}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" "{\"proc_starttime\": ${value}, \"row_version\": $(( rv + 1 ))}"
    printf '%s\n' "${old}"
}

# p1_note [harness]: with the server stopped and no Part 2 persona, the note
# persona's live row is given a pid-only SessionStart identity (its
# proc_starttime NULL: agent-director then cannot check its agent process,
# so find-missing decides the row by its tmux lookup), a global @ad_owner
# value is set, one harness find-missing leaves the row unverified with the
# note (a harness get shows it), the value is unset and the row's
# proc_starttime is put back (so a later find-missing finds the process
# alive and clears the note).
p1_note() {
    local step="part 1: the note" id="${PERSONA_ID[${CN_KEY}]}" value started back
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    started="$(p1_proc_starttime "${step}: pid-only identity" "${id}" null)" || exit 1
    [[ "${started}" =~ ^\"?[0-9]+\"?$ ]] || fail "${step}: ${id} recorded proc_starttime '${started}', not a whole number"
    echo "${TEST_NAME}: ${step}: ${id}'s proc_starttime ${started} set to NULL (a pid-only identity)"
    p1_only "${step}: before the global value is set"
    value="$(ad_owner_global_set)" || exit 1
    echo "${TEST_NAME}: ${step}: the harness set the global @ad_owner to '${value}'"
    ad_capture find-missing
    (( AD_RC == 0 )) || fail "${step}: the harness find-missing exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    echo "${TEST_NAME}: ${step}: the harness find-missing said: $(tr '\n' ' ' < "${AD_OUT}")"
    read_note "${step}" "${id}"
    [[ "${ROW_NOTE}" == "${LATCHING_NOTE}" ]] || fail "${step}: a harness get of ${id} shows liveness_note '${ROW_NOTE}', not ${LATCHING_NOTE}"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: ${id} reads '${ROW_STATE}' with the note, not waiting"
    p1_only "${step}: while the global value is set"
    ad_owner_global_unset
    back="$(p1_proc_starttime "${step}: identity put back" "${id}" "${started}")" || exit 1
    [[ "${back}" == null ]] || fail "${step}: ${id}'s proc_starttime read '${back}' before it was put back, not NULL"
    read_note "${step}" "${id}"
    [[ "${ROW_NOTE}" == "${LATCHING_NOTE}" ]] || fail "${step}: after the unset ${id} shows liveness_note '${ROW_NOTE}', not ${LATCHING_NOTE}"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with liveness_note ${ROW_NOTE}; the global value is unset; proc_starttime ${started} put back"
}

# ---------------------------------------------------------------------------
# Part 1, the latch life: the note latch, and AC 43's latch
# ---------------------------------------------------------------------------

# p1_check_note_notice <step> <key>: exactly one post on the persona's channel
# since the latch life began, the printed CONFLICT notice for its case and
# session with no description (a note latch has none, so no `agent-director
# said` line).
p1_check_note_notice() {
    local step="$1" key="$2" notice n
    notice="$(fmk_text formatPersonaNotice "${PERSONA_NAME[${key}]}" conflictNoticeText "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print the CONFLICT notice"
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${key}]} hold the CONFLICT notice head, not one"
    if [[ "${HOLDING[0]}" != "${notice}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${notice}" >&2
        fail "${step}: the post is not the printed CONFLICT notice with no description"
    fi
    [[ "${HOLDING[0]}" != *"${DESC_HEAD}"* ]] || fail "${step}: the note latch's notice holds a description line"
    n="$(posts_since "${key}" "${POSTS_BEFORE[${key}]}")" || exit 1
    (( n == 1 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the latch life began, not only the notice"
    echo "${TEST_NAME}: ${step}: one CONFLICT notice, as printed for ${CASE_OF[${key}]} and \"${SESSION_OF[${key}]}\", with no description line"
}

# p1_check_note_latch: the note persona latched by the start sweep's `list`
# (SRJ-714), before any call of its id, with one post.
p1_check_note_latch() {
    local key="${CN_KEY}" step="part 1: latch life: ${CN_KEY} latches" id="${PERSONA_ID[${CN_KEY}]}" set_line rows n
    set_line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    expect_count "${set_line}" 1 "${step}: latch-set lines"
    [[ "${SESSION_OF[${key}]}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the latch quotes session '${SESSION_OF[${key}]}', not ${PERSONA_NAMED[${key}]}"
    rows="$(ad_cscb_calls "${id}" "${LATCH_LIFE_MARK}" "${LATCH_MARK[${key}]}")" || exit 1
    check_sweep_latch "${step}" "${key}" "${rows}"
    n="$(rows_count "$(verb_rows kill "${rows}")")"
    (( n == 0 )) || fail "${step}: ${n} CSCB kill call(s) of ${id} before the latch"
    wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${CONFLICT_HEAD}" 1
    p1_check_note_notice "${step}" "${key}"
    store_row "${step}" "${id}"
    [[ "${STORE_STATE}" == waiting ]] || fail "${step}: ${id} reads ${STORE_STATE} in the store, not waiting"
    LATCH_STATE[${key}]="${STORE_STATE}"
    LATCH_RV[${key}]="${STORE_RV}"
    skip_early_reads "${step}" "${key}"
}

# p1_check_dialog_latch: the held-dialog persona's plain spawn, the
# approver's `read-pane`s of its `pending` row, the first before the global
# value was set (P1_SET_FROM_MARK), and the next refused with "conflicting
# labels", which latched it with one post (the description line holding the
# case phrase); the refused read-pane's time is the round timer's starting
# point.
p1_check_dialog_latch() {
    local key="${HD_KEY}" step="part 1: latch life: ${HD_KEY} latches" id="${PERSONA_ID[${HD_KEY}]}" set_line rows n
    local spawns reads before after refused pos time ppid args
    set_line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    expect_count "${set_line}" 1 "${step}: latch-set lines"
    [[ "${SESSION_OF[${key}]}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the latch quotes session '${SESSION_OF[${key}]}', not ${PERSONA_NAMED[${key}]}"
    rows="$(ad_cscb_calls "${id}" "${LATCH_LIFE_MARK}" "${LATCH_MARK[${key}]}")" || exit 1
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} up to the latch (recorded): $(field_of 4 "${rows}" | tr '\n' ' ')"
    spawns="$(verb_rows spawn "${rows}")" || exit 1
    (( $(rows_count "${spawns}") == 1 )) && round_call_is "${CALL_PLAIN_SPAWN}" spawn "$(field_of 6 "${spawns}")" \
        || { sed 's/^/  | /' <<< "${rows}" >&2; fail "${step}: the launch is not one plain spawn"; }
    reads="$(verb_rows read-pane "${rows}")" || exit 1
    before=0
    after=0
    refused=""
    while IFS=$'\t' read -r pos time ppid _ _ args; do
        [[ -n "${pos}" ]] || continue
        [[ " ${args} " == *" --allow-pending "* ]] || fail "${step}: the approver's read-pane at shim line ${pos} carries no --allow-pending"
        (( pos <= P1_SET_FROM_MARK )) && before=$(( before + 1 ))
        (( pos > P1_SET_MARK )) && after=$(( after + 1 ))
        refused="${pos} ${time} ${ppid}"
    done <<< "${reads}"
    (( before >= 1 )) || fail "${step}: no approver read-pane of ${id} before the global value was set"
    read -r pos time ppid <<< "${refused}"
    (( pos > P1_SET_FROM_MARK )) || fail "${step}: the last read-pane of ${id} before the latch (shim line ${pos}) came before the global value was set"
    (( after <= 1 )) || fail "${step}: ${after} read-pane(s) of ${id} after the global value was set, not only the refused one"
    [[ "${ppid}" == "${LATCH_PID}" ]] || fail "${step}: the refused read-pane at shim line ${pos} is not the bot server's (${LATCH_PID})"
    LATCH_US[${key}]="$(us_of "${time}")" || exit 1
    echo "${TEST_NAME}: ${step}: ${before} approver read-pane(s) before the global value was set; the refused read-pane at shim line ${pos}"
    n="$(rows_count "$(verb_rows kill "${rows}")")"
    (( n == 0 )) || fail "${step}: ${n} CSCB kill call(s) of ${id} before the latch"
    wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${CONFLICT_HEAD}" 1
    check_conflict_notice "${step}" "${key}"
    n="$(posts_since "${key}" "${POSTS_BEFORE[${key}]}")" || exit 1
    (( n == 1 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the latch life began, not only the notice"
    store_row "${step}" "${id}"
    [[ "${STORE_STATE}" == pending ]] || fail "${step}: ${id} reads ${STORE_STATE} in the store, not pending"
    LATCH_STATE[${key}]="${STORE_STATE}"
    LATCH_RV[${key}]="${STORE_RV}"
    skip_early_reads "${step}" "${key}"
}

# p1_round_lines <key>: the persona's still-latched round line and the head
# every round of its step and call shares.
p1_round_lines() {
    local key="$1" line
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${key}]}" "${CASE_OF[${key}]}" "${STEP_OF[${key}]}" "${CALL_OF[${key}]}" ANSWERSLOT)" \
        || fail "part 1: fmk-texts.ts could not print latchRecheckRoundLine"
    ROUND_HEAD[${key}]="${line%ANSWERSLOT}"
    STILL_LINE[${key}]="${ROUND_HEAD[${key}]}${ANSWER_OF[${key}]}"
}

p1_latch_life() {
    local step="part 1: latch life" key
    for key in "${P1_KEYS[@]}"; do
        POSTS_BEFORE[${key}]="$(post_count "${key}")" || exit 1
    done
    stub_mode "${PERSONA_WORK[${HD_KEY}]}" "${STUB_MODE_UNRECOGNISED}"
    # A start runs its state dir's last-applied record, so this life, which
    # adds the held-dialog persona, starts in a state dir of its own.
    new_state_dir p1-latch-life
    write_personas_config "${P1_KEYS[@]}"
    LATCH_LIFE_MARK="$(ad_shim_mark)"
    start_server --live
    LATCH_PID="${SERVER_PID}"
    wait_latch_set "${CN_KEY}" "${step}"
    # [harness] Right after the approver's first read-pane of the held
    # dialog's row, the global value is set.
    wait_for_ad_cscb_call "${PERSONA_ID[${HD_KEY}]}" read-pane 1 "${START_WAIT_S}" \
        "${step}: no approver read-pane of ${PERSONA_ID[${HD_KEY}]}"
    P1_SET_FROM_MARK="$(ad_shim_mark)"
    p1_only "${step}: before the global value is set"
    GLOBAL_VALUE="$(ad_owner_global_set)" || exit 1
    P1_SET_MARK="$(ad_shim_mark)"
    echo "${TEST_NAME}: ${step}: the harness set the global @ad_owner to '${GLOBAL_VALUE}' (shim marks ${P1_SET_FROM_MARK} to ${P1_SET_MARK})"
    wait_latch_set "${HD_KEY}" "${step}"
    wait_for_count "$(completion_match "${#P1_KEYS[@]}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${#P1_KEYS[@]}")" | sed 's/^.*\] //')"
    p1_check_note_latch
    p1_check_dialog_latch
    for key in "${P1_KEYS[@]}"; do
        p1_round_lines "${key}"
    done
}

# ---------------------------------------------------------------------------
# Part 1: AC 43's two harness steps, the clears, and the loop
# ---------------------------------------------------------------------------

# p1_ac43 [harness]: right after the held-dialog persona's round k (k =
# MIN_LATCHED_ROUNDS, by which the note persona has had as many note rounds),
# the harness unsets the global value, then sends Enter into the stub's pane;
# a harness read shows the row `waiting`; then its round k+1's clear.
p1_ac43() {
    local step="part 1: AC 43" k="${MIN_LATCHED_ROUNDS}" id="${PERSONA_ID[${HD_KEY}]}" n line
    wait_rounds "${HD_KEY}" "${STILL_LINE[${HD_KEY}]}" "${k}" "${k}"
    P1_K_MARK="$(ad_shim_mark)"
    n="$(count_log "${ROUND_HEAD[${HD_KEY}]}")"
    (( n == k )) || fail "${step}: ${HD_KEY} has ${n} round lines at the harness's steps, not ${k}"
    FREE_ROUNDS[${HD_KEY}]="${n}"
    FREE_MARK[${HD_KEY}]="${P1_K_MARK}"
    # The note persona latched first, so its round k comes first; it is
    # waited for here (a few seconds at most), inside the interval.
    wait_rounds "${CN_KEY}" "${STILL_LINE[${CN_KEY}]}" "${k}" "${k}"
    p1_only "${step}: before the unset"
    CN_ROUNDS_AT_UNSET="$(count_log "${STILL_LINE[${CN_KEY}]}")"
    ad_owner_global_unset
    P1_UNSET_US="$(( 10#${EPOCHREALTIME/[.,]/} ))"
    P1_UNSET_MARK="$(ad_shim_mark)"
    stub_press_enter "${PERSONA_NAMED[${HD_KEY}]}"
    P1_ENTER_US="$(( 10#${EPOCHREALTIME/[.,]/} ))"
    P1_ENTER_MARK="$(ad_shim_mark)"
    FREE_POSTS[${HD_KEY}]="$(post_count "${HD_KEY}")" || exit 1
    echo "${TEST_NAME}: ${step}: after ${HD_KEY}'s round ${k} (shim mark ${P1_K_MARK}) the harness unset the global value (mark ${P1_UNSET_MARK}) and sent Enter into ${PERSONA_NAMED[${HD_KEY}]} (mark ${P1_ENTER_MARK}); ${CN_KEY} has had ${CN_ROUNDS_AT_UNSET} note round(s)"
    wait_row "${step}: ${HD_KEY}'s report-in" "${REPORT_WAIT_S}" "${id}" waiting
    P1_WAITING_MARK="$(ad_shim_mark)"
    echo "${TEST_NAME}: ${step}: a harness read shows ${id} waiting (shim mark ${P1_WAITING_MARK})"
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${HD_KEY}]}" "${CASE_CONFLICTING_LABELS}" "${STEP_REPORTED_IN}" "${CALL_NONE}" \
        "cleared (${STEP_REPORTED_IN})")" || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    ROUND_END_HEAD[${HD_KEY}]="${line}"
    wait_rounds "${HD_KEY}" "${line}" 1 1
    ROUND_END_MARK[${HD_KEY}]="$(ad_shim_mark)"
}

# p1_note_clear [harness]: after AC 43's clear, the store-wide find-missing
# of its after-clear run (CSCB's; awaited, not asserted here); which run
# removes the note is logged (ruling S8). The harness then starts its
# find-missing loop; once a harness get shows no note, the note persona's
# next round clears it; the loop is then stopped.
p1_note_clear() {
    local step="part 1: the note's removal" id="${PERSONA_ID[${CN_KEY}]}" line bound who
    _scenario_poll_until "${SETTLE_S}" cscb_find_missing_after "${P1_ENTER_MARK}" || true
    read_note "${step}" "${id}"
    if [[ -z "${ROW_NOTE}" ]]; then
        who="the store-wide find-missing after AC 43's clear"
    else
        who="the harness's find-missing loop"
    fi
    echo "${TEST_NAME}: ${step}: [S8, recorded] CSCB find-missing call(s) since the Enter: $(field_of 1 "$(ad_cscb_verb_between find-missing "${P1_ENTER_MARK}" -)" | tr '\n' ' '); ${id}'s note now reads '${ROW_NOTE}'"
    P1_LOOP_MARK="$(ad_shim_mark)"
    run_find_missing_loop
    P1_LOOP_PID="${FIND_MISSING_LOOP_PID}"
    echo "${TEST_NAME}: ${step}: the harness's find-missing loop started (PID ${P1_LOOP_PID}, every ${FIND_MISSING_LOOP_INTERVAL_S} s)"
    wait_until $(( FIND_MISSING_LOOP_INTERVAL_S + 60 )) "${step}: a harness get of ${id} still shows the note" note_gone "${id}"
    P1_NOTE_GONE_MARK="$(ad_shim_mark)"
    echo "${TEST_NAME}: ${step}: [S8, recorded] the note was removed by ${who}; a harness get shows none (shim mark ${P1_NOTE_GONE_MARK}; the loop's runs so far: $(find_missing_loop_runs))"
    FREE_ROUNDS[${CN_KEY}]="$(count_log "${STILL_LINE[${CN_KEY}]}")"
    FREE_MARK[${CN_KEY}]="${P1_NOTE_GONE_MARK}"
    FREE_POSTS[${CN_KEY}]="$(post_count "${CN_KEY}")" || exit 1
    FREE_CONNECTS[${CN_KEY}]="$(count_log "$(connected_match "${CN_KEY}")")"
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${CN_KEY}]}" "${CASE_CONFLICTING_LABELS}" "${STEP_TABLE}" "${CALL_RESTART_DECISION}" ANSWERSLOT)" \
        || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    ROUND_END_HEAD[${CN_KEY}]="${line%ANSWERSLOT}"
    bound=$(( 2 * (INTERVAL_S + 2 * SETTLE_S) ))
    if ! _scenario_poll_until "${bound}" _scenario_log_count_at_least "$(matcher "${ROUND_END_HEAD[${CN_KEY}]}" "cleared (")" 1; then
        latch_lines_of "${CN_KEY}"
        fail "${step}: ${CN_KEY}'s round never cleared it: no line '${ROUND_END_HEAD[${CN_KEY}]}cleared (…' (not within ${bound}s)"
    fi
    ROUND_END_MARK[${CN_KEY}]="$(ad_shim_mark)"
    stop_find_missing_loop
    echo "${TEST_NAME}: ${step}: ${CN_KEY} cleared; the harness's find-missing loop stopped ($(find_missing_loop_runs) run(s))"
}

# True once a CSCB find-missing follows <from-mark> in the shim's log.
cscb_find_missing_after() {
    [[ -n "$(ad_cscb_verb_between find-missing "$1" -)" ]]
}

# ---------------------------------------------------------------------------
# Part 1: the checks, from the logs
# ---------------------------------------------------------------------------

# p1_check_note_rounds: the note persona's rounds while the note showed (up
# to the harness get that showed none): each one `get` alone, at the cadence,
# with no post beyond the latch's; at least MIN_LATCHED_ROUNDS of them before
# the unset; the row keeps the state read at the latch.
p1_check_note_rounds() {
    local key="${CN_KEY}" step="part 1: ${CN_KEY}'s note rounds" id="${PERSONA_ID[${CN_KEY}]}" rounds n i=0 prev s_pos s_us
    n="${FREE_ROUNDS[${key}]}"
    (( CN_ROUNDS_AT_UNSET >= MIN_LATCHED_ROUNDS )) \
        || fail "${step}: ${CN_ROUNDS_AT_UNSET} note round(s) before the unset, fewer than ${MIN_LATCHED_ROUNDS}"
    rounds="$(latch_rounds "${step}" "${key}" "${ROUNDS_FROM[${key}]}" "${FREE_MARK[${key}]}")" || exit 1
    if (( $(rows_count "${rounds}") != n )); then
        latch_lines_of "${key}"
        calls_of "${key}" "${ROUNDS_FROM[${key}]}" "${FREE_MARK[${key}]}"
        fail "${step}: $(rows_count "${rounds}") rounds of ${id} in the shim's log, not the ${n} still-latched round lines"
    fi
    prev="${LATCH_US[${key}]}"
    while read -r s_pos s_us _; do
        i=$(( i + 1 ))
        check_cadence "${step}: round ${i}" "${prev}" "${s_us}" "${s_us}" "${CALL_NONE}"
        echo "${TEST_NAME}: ${step}: round ${i}: get at shim line ${s_pos}, and no other call"
        prev="${s_us}"
    done <<< "${rounds}"
    PREV_US[${key}]="${prev}"
    (( FREE_POSTS[${key}] - POSTS_BEFORE[${key}] == 1 )) \
        || fail "${step}: ${PERSONA_CHANNEL[${key}]} held $(( FREE_POSTS[${key}] - POSTS_BEFORE[${key}] )) posts while the note showed, not only the latch's notice"
    store_row "${step}" "${id}"
    [[ "${STORE_STATE}" == "${LATCH_STATE[${key}]}" ]] || fail "${step}: ${id} reads ${STORE_STATE}, not ${LATCH_STATE[${key}]} as at the latch"
    echo "${TEST_NAME}: ${step}: ${i} round(s) while the note showed (${CN_ROUNDS_AT_UNSET} before the unset), each one get alone; no post beyond the latch's"
}

# p1_check_note_clear: the note persona's round after the note was gone: one
# `get` at the cadence, then one run of the restart path's decision on the
# live row (no resume, no kill, at most the ladder's plain spawn, which meets
# the row; its calls recorded), with no CSCB find-missing between the get and
# it; it clears the latch with one recovery post ("a retry of the refused
# operation was not refused"), and no relatch.
p1_check_note_clear() {
    local key="${CN_KEY}" step="part 1: ${CN_KEY}'s clear" id="${PERSONA_ID[${CN_KEY}]}" rows between n verb
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}" "${ROUND_END_MARK[${key}]}")" || exit 1
    load_calls "${rows}"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} in the clearing round (recorded): ${CALL_VERB[*]:-}"
    if [[ "${CALL_VERB[0]:-}" != get || -z "${CALL_VERB[1]:-}" ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round after the note was gone is not a get then the restart path's decision"
    fi
    check_cadence "${step}" "${PREV_US[${key}]}" "${CALL_US[0]}" "${CALL_US[1]}" "${CALL_RESTART_DECISION}"
    between="$(ad_cscb_verb_between find-missing "${CALL_POS[0]}" "${CALL_POS[1]}")" || exit 1
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the round's get and the restart path's decision"; }
    for verb in resume kill kill-finished delete; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${id} in the round"
    done
    n="$(rows_count "$(verb_rows spawn "${rows}")")"
    (( n <= 1 )) || fail "${step}: ${n} spawns of ${id} in the restart path's decision, more than the ladder's one"
    if (( n == 1 )); then
        round_call_is "${CALL_PLAIN_SPAWN}" spawn "$(field_of 6 "$(verb_rows spawn "${rows}")")" \
            || fail "${step}: the spawn of ${id} in the round is not the ladder's plain spawn"
    fi
    expect_count "$(matcher "${ROUND_END_HEAD[${key}]}" "cleared (")" 1 "${step}: the clearing round's line"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(matcher "${ROUND_END_HEAD[${key}]}" "cleared (")" | sed 's/^.*\] //')"
    check_launched "${step}" "${key}"
}

# p1_check_dialog_rounds: the held-dialog persona's rounds up to round k:
# each one `get` then one one-line `read-pane` with --allow-pending, at the
# cadence, answering the same CONFLICT, with no post and no other call.
p1_check_dialog_rounds() {
    local key="${HD_KEY}" step="part 1: ${HD_KEY}'s rounds" id="${PERSONA_ID[${HD_KEY}]}" rounds n i=0 prev s_pos s_us c_pos c_us
    n="${FREE_ROUNDS[${key}]}"
    rounds="$(latch_rounds "${step}" "${key}" "${ROUNDS_FROM[${key}]}" "${FREE_MARK[${key}]}")" || exit 1
    if (( $(rows_count "${rounds}") != n )); then
        latch_lines_of "${key}"
        calls_of "${key}" "${ROUNDS_FROM[${key}]}" "${FREE_MARK[${key}]}"
        fail "${step}: $(rows_count "${rounds}") rounds of ${id} in the shim's log, not the ${n} still-latched round lines"
    fi
    expect_count "${STILL_LINE[${key}]}" "${n}" "${step}: still-latched round lines (the same CONFLICT)"
    prev="${LATCH_US[${key}]}"
    while read -r s_pos s_us c_pos c_us; do
        i=$(( i + 1 ))
        check_cadence "${step}: round ${i}" "${prev}" "${s_us}" "${c_us}" "${CALL_PENDING_READ}"
        echo "${TEST_NAME}: ${step}: round ${i}: get at shim line ${s_pos}, read-pane (one line, --allow-pending) at ${c_pos}"
        prev="${s_us}"
        P1_K_GET_US="${s_us}"
        P1_K_LAST_POS="${c_pos}"
    done <<< "${rounds}"
    PREV_US[${key}]="${prev}"
    (( FREE_POSTS[${key}] - POSTS_BEFORE[${key}] == 1 )) \
        || fail "${step}: ${PERSONA_CHANNEL[${key}]} held $(( FREE_POSTS[${key}] - POSTS_BEFORE[${key}] )) posts at round ${n}, not only the latch's notice"
    echo "${TEST_NAME}: ${step}: ${i} still-latched round(s), each one get then one read-pane; no post beyond the latch's"
}

# p1_check_ac43: the order proof (round k's lines, the unset, the Enter, a
# harness read showing `waiting`, then round k+1's get, by shim marks and
# times; both harness steps within one interval of round k's get), and round
# k+1: its get reads `waiting` and clears the latch: no other call of the id
# before the after-clear run's find-missing (so no read-pane in the round),
# the clear line and the round line once each, exactly one recovery post
# giving latchRecoveryReasonRowReads waiting, and no relatch.
p1_check_ac43() {
    local key="${HD_KEY}" step="part 1: AC 43" id="${PERSONA_ID[${HD_KEY}]}" rows between fm f_pos cleared recovery head
    (( P1_K_LAST_POS <= P1_K_MARK && P1_K_MARK <= P1_UNSET_MARK && P1_UNSET_MARK <= P1_ENTER_MARK )) \
        || fail "${step}: the marks are out of order: round ${MIN_LATCHED_ROUNDS}'s last call ${P1_K_LAST_POS}, the round's mark ${P1_K_MARK}, the unset ${P1_UNSET_MARK}, the Enter ${P1_ENTER_MARK}"
    rows="$(ad_cscb_calls "${id}" "${P1_K_MARK}" "${P1_ENTER_MARK}")" || exit 1
    [[ -z "${rows}" ]] || { sed 's/^/  | /' <<< "${rows}" >&2; fail "${step}: CSCB call(s) of ${id} between round ${MIN_LATCHED_ROUNDS} and the Enter"; }
    (( P1_UNSET_US - P1_K_GET_US < INTERVAL_US )) \
        || fail "${step}: the unset came $(secs_of $(( P1_UNSET_US - P1_K_GET_US ))) s after round ${MIN_LATCHED_ROUNDS}'s get, not within one interval"
    rows="$(ad_cscb_calls "${id}" "${P1_ENTER_MARK}" "${ROUND_END_MARK[${key}]}")" || exit 1
    load_calls "${rows}"
    if [[ "${CALL_VERB[0]:-}" != get ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the first CSCB call of ${id} after the Enter is '${CALL_VERB[0]:-}', not round $(( MIN_LATCHED_ROUNDS + 1 ))'s get"
    fi
    (( CALL_POS[0] > P1_WAITING_MARK )) \
        || fail "${step}: round $(( MIN_LATCHED_ROUNDS + 1 ))'s get (shim line ${CALL_POS[0]}) is not after the harness read showing waiting (mark ${P1_WAITING_MARK})"
    (( CALL_US[0] > P1_ENTER_US )) || fail "${step}: round $(( MIN_LATCHED_ROUNDS + 1 ))'s get came before the Enter"
    check_cadence "${step}: round $(( MIN_LATCHED_ROUNDS + 1 ))" "${PREV_US[${key}]}" "${CALL_US[0]}" "${CALL_US[0]}" "${CALL_NONE}"
    echo "${TEST_NAME}: ${step}: in order: round ${MIN_LATCHED_ROUNDS}'s last call (shim line ${P1_K_LAST_POS}), the unset (mark ${P1_UNSET_MARK}, $(secs_of $(( P1_UNSET_US - P1_K_GET_US ))) s after its get), the Enter (mark ${P1_ENTER_MARK}), the harness read of waiting (mark ${P1_WAITING_MARK}), round $(( MIN_LATCHED_ROUNDS + 1 ))'s get (shim line ${CALL_POS[0]})"
    # The round is its get alone: the after-clear run's find-missing comes
    # next, with no call of the id between.
    fm="$(ad_cscb_verb_between find-missing "${CALL_POS[0]}" -)" || exit 1
    [[ -n "${fm}" ]] || fail "${step}: no CSCB find-missing after round $(( MIN_LATCHED_ROUNDS + 1 ))'s get (the after-clear run's)"
    f_pos="$(sed -n 1p <<< "${fm}" | cut -f 1)"
    between="$(ad_cscb_calls "${id}" "${CALL_POS[0]}" "$(( f_pos - 1 ))")" || exit 1
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: CSCB call(s) of ${id} in the clearing round after its get"; }
    echo "${TEST_NAME}: ${step}: round $(( MIN_LATCHED_ROUNDS + 1 )): get at shim line ${CALL_POS[0]} alone; the after-clear run's find-missing at ${f_pos}"
    echo "${TEST_NAME}: ${step}: [recorded] the after-clear run's calls of ${id}: $(field_of 4 "$(ad_cscb_calls "${id}" "${f_pos}" "${ROUND_END_MARK[${CN_KEY}]}")" | tr '\n' ' ')"
    expect_count "${ROUND_END_HEAD[${key}]}" 1 "${step}: the clearing round's line"
    cleared="$(fmk_text latchClearedLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" posted latchRecoveryReasonRowReads waiting)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    expect_count "${cleared}" 1 "${step}: the clear line"
    recovery="$(fmk_text formatPersonaNotice "${PERSONA_NAME[${key}]}" conflictRecoveryText "${SESSION_OF[${key}]}" latchRecoveryReasonRowReads waiting)" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed recovery notice for its agent-director row reading waiting"
    fi
    echo "${TEST_NAME}: ${step}: cleared at round $(( MIN_LATCHED_ROUNDS + 1 )) with one recovery post (its agent-director row reads waiting)"
    head="$(fmk_text latchClearRetryAtOnceLineHead "${PERSONA_NAME[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print latchClearRetryAtOnceLineHead"
    echo "${TEST_NAME}: ${step}: [recorded] $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${head}" | sed 's/^.*\] //')"
}

# p1_check_no_relatch <key>: since the latch life began, one latch-set line
# (no relatch), no round line after its clear, and exactly two posts: the
# notice and the recovery post.
p1_check_no_relatch() {
    local key="$1" step="part 1: $1 stays clear" n line
    # The heads of a latch-set line and of a relatch's, cut from the package's
    # conflictLatchSetLine at its ` — `.
    line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    n="$(count_log "${line%% — *} — ")"
    (( n == 1 )) || fail "${step}: ${n} latch-set lines, not the one latch"
    line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}" "${CASE_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    n="$(count_log "${line%% — *} — ")"
    (( n == 0 )) || fail "${step}: ${n} relatch line(s)"
    # No round line answers a relatch (the head every round line of the
    # persona's case shares, cut at its step).
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${key}]}" "${CASE_OF[${key}]}" STEPSLOT CALLSLOT ANSWERSLOT)" \
        || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    n="$(count_log "$(matcher "${line%%STEPSLOT*}" relatched)")"
    (( n == 0 )) || fail "${step}: ${n} round line(s) say relatched"
    n="$(posts_since "${key}" "${POSTS_BEFORE[${key}]}")" || exit 1
    (( n == 2 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the latch life began, not the notice and the recovery post"
    echo "${TEST_NAME}: ${step}: one latch, no relatch, the notice and one recovery post"
}

p1_checks() {
    local key rows verb n
    p1_check_note_rounds
    p1_check_note_clear
    p1_check_dialog_rounds
    p1_check_ac43
    for key in "${P1_KEYS[@]}"; do
        p1_check_no_relatch "${key}"
        rows="$(ad_cscb_calls "${PERSONA_ID[${key}]}" "${LATCH_LIFE_MARK}")" || exit 1
        for verb in kill kill-finished delete; do
            n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
            (( n == 0 )) || fail "part 1: ${n} CSCB ${verb} call(s) of ${PERSONA_ID[${key}]} in the latch life"
        done
    done
}

# p1_end: Part 1's server stopped with a plain stop (no --stop-bots: its
# bots keep running, and stay configured for Part 2's lives); then [harness]
# the held-dialog persona's stub set to report in at once and its worker
# ended by its exit line, so its row is finished and Part 2's first life
# resumes it with no dialog (its pane still shows the answered one, which a
# reconnect's pane read would take for a prompt).
p1_end() {
    local step="part 1: end" id="${PERSONA_ID[${HD_KEY}]}" session="${PERSONA_NAMED[${HD_KEY}]}"
    stop_server
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    stub_mode "${PERSONA_WORK[${HD_KEY}]}" "${STUB_MODE_AT_ONCE}"
    stub_type_exit "${session}"
    wait_row "${step}: ${HD_KEY}'s worker ended" "${EXIT_WAIT_S}" "${id}" ended missing
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after the worker's exit" session_gone "${session}"
    P2_START_MARK="$(ad_shim_mark)"
    P2_START_TMUX_MARK="$(tmux_shim_mark)"
    echo "${TEST_NAME}: ${step}: Part 1's server stopped; ${HD_KEY}'s stub set to ${STUB_MODE_AT_ONCE} and its worker ended (${id} reads ${ROW_STATE}); Part 2 starts at shim mark ${P2_START_MARK}"
}

# ---------------------------------------------------------------------------
# Part 2, life 1: every persona that needs a row
# ---------------------------------------------------------------------------

p2_life1() {
    local step="part 2: first life" key ref n
    for key in "${P2_KEYS[@]}"; do
        prepare_persona "${key}"
    done
    # Part 1's personas stay configured. A start runs its state dir's
    # last-applied record, so this life starts in a state dir of its own.
    new_state_dir p2-life1
    write_personas_config "${P1_KEYS[@]}" "${P2_LIFE1_KEYS[@]}"
    n=$(( ${#P1_KEYS[@]} + ${#P2_LIFE1_KEYS[@]} ))
    start_server --live
    wait_for_count "$(completion_match "${n}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion "${n}" "${step}" "0 not brought up"
    for key in "${P2_LIFE1_KEYS[@]}"; do
        ref="$(persona_ref "${PERSONA_NAME[${key}]}")"
        wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${PERSONA_ID[${key}]}" waiting
        [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} has no claude_session_id"
        [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
            || fail "${step}: the live row ${PERSONA_ID[${key}]} records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
        PERSONA_SID[${key}]="${ROW_SID}"
        wait_for_count "[slack] Session connected: persona ${ref}" 1 "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the stub's session as ${key}'s"
        echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]} reads waiting, claude_session_id ${ROW_SID}, session ${ROW_SESSION}"
    done
}

# ---------------------------------------------------------------------------
# Part 2: the age wait
# ---------------------------------------------------------------------------

p2_age_wait() {
    local step="part 2: the own-id persona's session age" session="${PERSONA_NAMED[${OI_KEY}]}" created age want
    created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_created}')" \
        || fail "${step}: tmux gives no creation time for ${session}"
    [[ "${created}" =~ ^[0-9]+$ ]] || fail "${step}: tmux gave session_created '${created}' for ${session}"
    want=$(( BOUND_S + AGE_MARGIN_S ))
    age=$(( $(date +%s) - created ))
    echo "${TEST_NAME}: ${step}: ${session} is ${age} s old; waiting until it is more than ${want} s old"
    wait_until $(( want - age + 10 )) "${step}: ${session} never became more than ${want} s old" \
        session_older_than "${session}" "${want}"
}

# ---------------------------------------------------------------------------
# Part 2: a plain stop, the live rows staying live
# ---------------------------------------------------------------------------

p2_stop() {
    local step="part 2: plain stop" key
    stop_server
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    for key in "${P2_LIFE1_KEYS[@]}"; do
        has_session "${PERSONA_NAMED[${key}]}" || fail "${step}: ${PERSONA_NAMED[${key}]} is gone after a plain stop"
        row_reads "${step}" "${PERSONA_ID[${key}]}" waiting \
            || fail "${step}: ${PERSONA_ID[${key}]} reads '${ROW_STATE}' after a plain stop, not waiting"
    done
    echo "${TEST_NAME}: ${step}: every first-life persona's session runs and its row reads waiting"
}

# ---------------------------------------------------------------------------
# Part 2: the set-up stop, with the server stopped
# ---------------------------------------------------------------------------

# p2_human_exit <key> [harness]: the human ends the persona's worker as a
# human ends Claude Code (the stub's exit line), so agent-director marks its
# row finished and its session ends; the state read is the one its latch
# records.
p2_human_exit() {
    local key="$1" step="part 2: set-up: $1's worker ended by hand" id="${PERSONA_ID[$1]}" session="${PERSONA_NAMED[$1]}"
    stub_type_exit "${session}"
    wait_row "${step}" "${EXIT_WAIT_S}" "${id}" ended missing
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after the worker's exit" session_gone "${session}"
    [[ "${ROW_SID}" == "${PERSONA_SID[${key}]}" ]] \
        || fail "${step}: ${id}'s claude_session_id is '${ROW_SID}', not ${PERSONA_SID[${key}]}"
    LATCH_ROW_OF[${key}]="${ROW_STATE}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE}; ${session} is gone"
}

# p2_seed <key> <seed helper> [<instance-id>] [<name>]: the helper seeds a
# session named <name> (default: as the persona's launches name theirs) in
# the persona's working directory, its pane running `sleep`, labelled for
# <instance-id> (default: the persona's) unless the helper takes none.
p2_seed() {
    local key="$1" helper="$2" id="${3:-${PERSONA_ID[$1]}}" name="${4:-${PERSONA_NAMED[$1]}}" step
    step="part 2: set-up: $1's name held (${helper})"
    if [[ "${helper}" == seed_unlabelled ]]; then
        "${helper}" -c "${PERSONA_WORK[${key}]}" "${name}" sleep 86400 > "${SCENARIO_ROOT}/p2-${key}-seed.out"
    else
        "${helper}" -c "${PERSONA_WORK[${key}]}" "${name}" "${id}" sleep 86400 > "${SCENARIO_ROOT}/p2-${key}-seed.out"
    fi
    SEED_SID[${key}]="${SEEDED_SESSION_ID}"
    [[ "${SEED_SID[${key}]}" =~ ^\$[0-9]+$ ]] || fail "${step}: the seeded session id is '${SEED_SID[${key}]}'"
    echo "${TEST_NAME}: ${step}: ${name} (${SEEDED_SESSION_ID}, pane ${SEEDED_PANE_ID}${SEEDED_TOKEN:+, token ${SEEDED_TOKEN}}${SEEDED_STORE_ID:+, store ${SEEDED_STORE_ID}})"
}

# p2_no_row <key>: the store holds no row for the persona's id.
p2_no_row() {
    local rows
    rows="$(store_rows_of "part 2: set-up: $1" "${PERSONA_ID[$1]}")" || exit 1
    [[ "${rows}" == 0 ]] || fail "part 2: set-up: the store holds ${rows} row(s) with id ${PERSONA_ID[$1]}, not none"
}

# The own-id persona [harness]: E39's scenario 10 part B statement on its
# live row, its worker running and its session past the bound.
p2_setup_own_id() {
    local step="part 2: set-up: ${OI_KEY}'s row marked finished" id="${PERSONA_ID[${OI_KEY}]}" session="${PERSONA_NAMED[${OI_KEY}]}" ended
    session_older_than "${session}" "${BOUND_S}" || fail "${step}: ${session} is not more than ${BOUND_S} s old"
    ended="$(ad_store_mark_finished "${id}" missing)" || exit 1
    has_session "${session}" || fail "${step}: ${session} is gone"
    row_reads "${step}" "${id}" missing || fail "${step}: ${id} reads '${ROW_STATE}' after the statement, not missing"
    SEED_SID[${OI_KEY}]="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id}')" \
        || fail "${step}: tmux gives no session id for ${session}"
    echo "${TEST_NAME}: ${step}: ${id} reads missing (ended_at ${ended}); ${session} (${SEED_SID[${OI_KEY}]}) and its worker still run"
}

# The pane-not-found persona [harness]: its worker's pane respawned with
# `sleep`, its session and pane kept; its row still reads `waiting` (the
# stub fires no SessionEnd when its pane is respawned).
p2_setup_pane_gone() {
    local step="part 2: set-up: ${PN_KEY}'s pane respawned" id="${PERSONA_ID[${PN_KEY}]}" session="${PERSONA_NAMED[${PN_KEY}]}" out
    out="$(respawn_worker_pane "${session}" sleep 86400)" || exit 1
    SEED_SID[${PN_KEY}]="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id}')" \
        || fail "${step}: tmux gives no session id for ${session}"
    hold_waiting "${step}" "${id}"
    echo "${TEST_NAME}: ${step}: pane and new pid ${out}; ${session} (${SEED_SID[${PN_KEY}]}) kept; ${id} still reads waiting ${HOLD_S} s later (no SessionEnd on the respawn)"
}

# The unusable-name persona [harness]: E39's scenario 25 statement on its
# finished row.
p2_setup_unusable() {
    local step="part 2: set-up: ${UN_KEY}'s recorded name made unusable" id="${PERSONA_ID[${UN_KEY}]}"
    UNUSABLE_NAME="${PERSONA_NAMED[${UN_KEY}]}.held"
    ad_store_unusable_name "${id}" "${UNUSABLE_NAME}"
    read_row "${step}" "${id}"
    [[ "${ROW_STATE}" == "${LATCH_ROW_OF[${UN_KEY}]}" && "${ROW_SESSION}" == "${UNUSABLE_NAME}" ]] \
        || fail "${step}: ${id} reads ${ROW_STATE} in '${ROW_SESSION}', not ${LATCH_ROW_OF[${UN_KEY}]} in ${UNUSABLE_NAME}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE}, recording ${UNUSABLE_NAME}"
}

# A "not this launch's session" leg [harness]: the persona's own session, its
# worker running, relabelled with an earlier launch's token (relabel_session:
# @ad_owner with that token and the store's id, the worker pane's @ad_pane
# with the same token); the row keeps its own launch token and reads
# `waiting`.
p2_setup_relabel() {
    local key="$1" step="part 2: set-up: $1's session relabelled" id="${PERSONA_ID[$1]}" session="${PERSONA_NAMED[$1]}" current
    relabel_session "${session}" > "${SCENARIO_ROOT}/p2-${key}-relabel.out"
    SEED_SID[${key}]="${SEEDED_SESSION_ID}"
    SEED_PANE[${key}]="${SEEDED_PANE_ID}"
    current="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_token, '') FROM spawns WHERE claude_instance_id = '${id}'")" \
        || exit 1
    [[ "${current}" =~ ^[0-9a-f]{16}$ && "${current}" != "${SEEDED_TOKEN}" ]] \
        || fail "${step}: ${id} records launch token '${current}', not one other than the label's ${SEEDED_TOKEN}"
    row_reads "${step}" "${id}" waiting || fail "${step}: ${id} reads '${ROW_STATE}' after the relabel, not waiting"
    echo "${TEST_NAME}: ${step}: ${session} (${SEEDED_SESSION_ID}, worker pane ${SEEDED_PANE_ID}) labelled with token ${SEEDED_TOKEN}; the row records ${current} and reads waiting"
}

# The "launch start not recorded" persona [harness]: E39's statement
# (ad_store_pending_no_launch) on its live row, its worker running; the
# harness never ends this session (PM decision Q1).
p2_setup_no_launch() {
    local step="part 2: set-up: ${NS_KEY}'s row made pending with no launch start" id="${PERSONA_ID[${NS_KEY}]}"
    local session="${PERSONA_NAMED[${NS_KEY}]}"
    ad_store_pending_no_launch "${id}"
    has_session "${session}" || fail "${step}: ${session} is gone"
    SEED_SID[${NS_KEY}]="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id}')" \
        || fail "${step}: tmux gives no session id for ${session}"
    echo "${TEST_NAME}: ${step}: ${id} reads pending with no launch start; ${session} (${SEED_SID[${NS_KEY}]}) and its worker still run"
}

p2_setup() {
    local key
    [[ -z "$(server_pid)" ]] || fail "part 2: set-up: a server is running"
    for key in "${P2_FINISHED_KEYS[@]}"; do
        p2_human_exit "${key}"
    done
    # A leg that joins Part 2 adds its set-up step here.
    p2_seed "${NL_KEY}" seed_unlabelled
    # Another row's session, made under its own name, then given the
    # persona's name.
    p2_seed "${DI_KEY}" seed_borrowed_name "${LENDER_ID}" "${LENDER_SESSION}"
    rename_session "${SEED_SID[${DI_KEY}]}" "${PERSONA_NAMED[${DI_KEY}]}" > /dev/null
    echo "${TEST_NAME}: part 2: set-up: ${LENDER_SESSION} (${SEED_SID[${DI_KEY}]}) renamed ${PERSONA_NAMED[${DI_KEY}]}"
    p2_seed "${AS_KEY}" seed_other_store
    p2_seed "${LO_KEY}" seed_leftover
    p2_seed "${SL_KEY}" seed_leftover
    p2_no_row "${SL_KEY}"
    p2_seed "${DS_KEY}" seed_unlabelled
    p2_no_row "${DS_KEY}"
    p2_setup_own_id
    p2_setup_pane_gone
    p2_setup_unusable
    p2_setup_relabel "${R1_KEY}"
    p2_setup_relabel "${R2_KEY}"
    p2_setup_no_launch
}

# ---------------------------------------------------------------------------
# Part 2, the latch life: every persona latches at its bring-up
# ---------------------------------------------------------------------------

# wait_latch_set <key> [<life>]: wait for the persona's latch-set line (its
# case, refused operation and recorded state; any session), take its shim
# mark, and read the quoted session from the line (<life> names the life in
# the step, by default Part 2's latch life).
wait_latch_set() {
    local key="$1" step="${2:-part 2: latch life}: $1 latches" template head tail line rest
    template="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" SESSIONSLOT "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    head="${template%%SESSIONSLOT*}"
    tail="${template#*SESSIONSLOT}"
    if ! _scenario_poll_until "${START_WAIT_S}" _scenario_log_count_at_least "$(matcher "${head}" "${tail}")" 1; then
        latch_lines_of "${key}"
        calls_of "${key}" "${LATCH_LIFE_MARK}"
        fail "${step}: no latch-set line '${head}…${tail}' (not within ${START_WAIT_S}s)"
    fi
    LATCH_MARK[${key}]="$(ad_shim_mark)"
    line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(matcher "${head}" "${tail}")")"
    rest="${line#*"${head}"}"
    SESSION_OF[${key}]="${rest%%"${tail}"*}"
    [[ -n "${SESSION_OF[${key}]}" ]] || fail "${step}: the latch-set line quotes no session: ${line}"
}

# check_conflict_notice <step> <key> [<case> <from-index>]: exactly one post
# on the persona's channel since the latch life began (or from <from-index>
# on), the CONFLICT notice, its lines in SRJ-1004's order for its case (the
# latch's, or <case> for a relatch); every line but the description line
# equals the printed line; the description holds the case phrase.
check_conflict_notice() {
    local step="$1" key="$2" lcase="${3:-${CASE_OF[$2]}}" from="${4:-${POSTS_BEFORE[$2]}}" session="${SESSION_OF[$2]}"
    local notice prefix first list desc i bad=0 expected=()
    posts_holding "${key}" "${from}" "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) \
        || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${key}]} hold the CONFLICT notice head, not one"
    notice="${HOLDING[0]}"
    prefix="$(fmk_text personaNoticePrefix "${PERSONA_NAME[${key}]}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    first="$(fmk_text conflictNoticeFirstLine "${lcase}" "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeFirstLine"
    list="$(fmk_text conflictNoticeListLine "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeListLine"
    expected=("${prefix}${first}" "${DESC_HEAD}…${DESC_TAIL}")
    case "${lcase}" in
        "${CASE_DIFFERENT_ID}") expected+=("${DIFFERENT_ID_MUST_NOT_END_LINE}") ;;
        "${CASE_ANOTHER_STORE}") expected+=("${STORE_MUST_NOT_END_LINE}" "${POINTER_LINE}") ;;
        *) expected+=("${POINTER_LINE}") ;;
    esac
    expected+=("${list}" "${HUMAN_LINE}")
    split_on "${notice}" "${NOTICE_SEP}"
    (( ${#PARTS[@]} == ${#expected[@]} )) || bad=1
    for (( i = 0; i < ${#expected[@]} && i < ${#PARTS[@]}; i++ )); do
        if (( i != 1 )) && [[ "${PARTS[i]}" != "${expected[i]}" ]]; then
            bad=1
        fi
    done
    if (( bad )); then
        printf '  | posted:   %q\n' "${notice}" >&2
        for i in "${!expected[@]}"; do
            printf '  | expected line %d: %q\n' "$(( i + 1 ))" "${expected[i]}" >&2
        done
        fail "${step}: the CONFLICT notice's lines are not, in order, the ones SRJ-1004 gives case ${lcase}"
    fi
    desc="${PARTS[1]}"
    [[ "${desc}" == "${DESC_HEAD}"*"${DESC_TAIL}" ]] || fail "${step}: the notice's second line is not a description line: ${desc}"
    desc="${desc#"${DESC_HEAD}"}"
    desc="${desc%"${DESC_TAIL}"}"
    [[ "${desc}" == *"${PHRASE_BY_CASE[${lcase}]}"* ]] \
        || fail "${step}: agent-director's description does not say '${PHRASE_BY_CASE[${lcase}]}': ${desc}"
    echo "${TEST_NAME}: ${step}: one CONFLICT notice (case ${lcase}); agent-director said: ${desc}"
}

# check_launch_start_notice <step> <key>: exactly one post on the persona's
# channel since the latch life began holds the launch-start notice head, and
# it is SRJ-1020's notice as printed (`launchStartNotRecordedNoticeText` for
# the key, with the persona prefix), so it names no command.
check_launch_start_notice() {
    local step="$1" key="$2" notice
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${LAUNCH_START_HEAD}"
    (( ${#HOLDING[@]} == 1 )) \
        || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${key}]} hold the launch-start notice head, not one"
    notice="$(fmk_text formatPersonaNotice "${PERSONA_NAME[${key}]}" launchStartNotRecordedNoticeText "${key}")" \
        || fail "${step}: fmk-texts.ts could not print the launch-start notice"
    if [[ "${HOLDING[0]}" != "${notice}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${notice}" >&2
        fail "${step}: the post is not the printed launch-start notice"
    fi
    echo "${TEST_NAME}: ${step}: one launch-start notice, as printed"
}

# check_unusable_notice <step> <key>: exactly one post on the persona's
# channel since the latch life began holds the unusable-name notice head,
# and it is SRJ-1019's notice: the persona prefix, then
# `unusableNameNoticeText`'s text for the key around the quoted description
# (its fixed parts: the head, `cscb_<key>`, the pointer to "Operator
# actions"), the description holding the unusable-name phrase and the
# unusable name. So the post names no command.
check_unusable_notice() {
    local step="$1" key="$2" prefix body before after post desc
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${UNUSABLE_HEAD}"
    (( ${#HOLDING[@]} == 1 )) \
        || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${key}]} hold the unusable-name notice head, not one"
    post="${HOLDING[0]}"
    prefix="$(fmk_text personaNoticePrefix "${PERSONA_NAME[${key}]}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    body="$(fmk_text unusableNameNoticeText "${key}" DESCRIPTIONSLOT)" || fail "${step}: fmk-texts.ts could not print unusableNameNoticeText"
    [[ "${body}" == *DESCRIPTIONSLOT* ]] || fail "${step}: the unusable-name notice does not quote its description: ${body}"
    before="${prefix}${body%%DESCRIPTIONSLOT*}"
    after="${body#*DESCRIPTIONSLOT}"
    [[ "${before}" == "${prefix}${UNUSABLE_HEAD}${PERSONA_ID[${key}]}"* ]] \
        || fail "${step}: the printed unusable-name notice does not start with its head and ${PERSONA_ID[${key}]}: ${body}"
    if [[ "${post}" != "${before}"*"${after}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${post}" "${before}…${after}" >&2
        fail "${step}: the post is not the persona prefix and the unusable-name notice for ${key} around a description"
    fi
    desc="${post#"${before}"}"
    desc="${desc%"${after}"}"
    [[ "${desc}" == *"${UNUSABLE_PHRASE}"* && "${desc}" == *"${UNUSABLE_NAME}"* ]] \
        || fail "${step}: the quoted description does not say '${UNUSABLE_PHRASE}' and name ${UNUSABLE_NAME}: ${desc}"
    echo "${TEST_NAME}: ${step}: one unusable-name notice; agent-director said: ${desc}"
}

# p2_check_bringup_refusal <step> <key> <rows>: the bring-up's refused call,
# the bot server's, among the persona's CSCB calls before its latch (<rows>);
# sets LATCH_US to the last call's time, the round timer's starting point.
p2_check_bringup_refusal() {
    local step="$1" key="$2" rows="$3" id="${PERSONA_ID[$2]}" refused="" pos time ppid verb args n=0
    [[ -n "${rows}" ]] || fail "${step}: no CSCB call of ${id} before the latch"
    while IFS=$'\t' read -r pos time ppid verb _ args; do
        [[ -n "${pos}" ]] || continue
        case "${REFUSED_OF[${key}]}" in
            -) continue ;;
            pane) [[ "${verb}" == send-keys || "${verb}" == read-pane ]] || continue ;;
            send-keys) [[ "${verb}" == send-keys ]] || continue ;;
            *) round_call_is "${REFUSED_OF[${key}]}" "${verb}" "${args}" || continue ;;
        esac
        n=$(( n + 1 ))
        refused="${pos} ${verb} ${ppid}"
    done <<< "${rows}"
    if [[ "${REFUSED_OF[${key}]}" != - ]]; then
        # The own-id persona's earlier `resume`s may get "still starting"
        # (UNAVAILABLE), which latches nothing; every other persona's
        # bring-up makes its refused call once.
        if [[ "${key}" == "${OI_KEY}" ]]; then
            (( n >= 1 )) || fail "${step}: no CSCB ${REFUSED_OF[${key}]} call of ${id} before the latch"
        else
            (( n == 1 )) || fail "${step}: ${n} CSCB ${REFUSED_OF[${key}]} call(s) of ${id} before the latch, not one"
        fi
        read -r pos verb ppid <<< "${refused}"
        [[ "${ppid}" == "${LATCH_PID}" ]] || fail "${step}: the refused ${verb} of ${id} at shim line ${pos} is not the bot server's (${LATCH_PID})"
        echo "${TEST_NAME}: ${step}: the refused call: ${verb} at shim line ${pos} (${n} such call(s))"
    fi
    LATCH_US[${key}]="$(us_of "$(tail -n 1 <<< "${rows}" | cut -f 2)")" || exit 1
}

# log_line_us <line>: a server.log line's own time (`[<ISO-8601 UTC>] …`) in
# microseconds.
log_line_us() {
    local stamp="${1#\[}" us
    stamp="${stamp%%\]*}"
    us="$(date -u -d "${stamp}" +%s%6N 2> /dev/null)" || fail "log_line_us: '${stamp}' is not a time"
    [[ "${us}" =~ ^[0-9]+$ ]] || fail "log_line_us: '${stamp}' gave '${us}'"
    echo "$(( 10#${us} ))"
}

# check_sweep_latch <step> <key> <rows>: the start sweep's `list` latched
# the persona before any bring-up call for it: its latch-set line's time
# (server.log) comes after a `list` of the bot server's in the latch life and
# before every CSCB call of its id up to its latch mark (<rows>, each logged);
# that `list`'s time is the round timer's starting point (LATCH_US); for
# "launch start not recorded", its row records no launch start in the store.
check_sweep_latch() {
    local step="$1" key="$2" rows="$3" id="${PERSONA_ID[$2]}" set_line line latch_us lists sweep="" pos p time ppid started us
    set_line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    line="$(grep -F -m 1 -e "${set_line}" "${SLACK_STATE_DIR}/server.log")" || fail "${step}: no latch-set line in server.log"
    latch_us="$(log_line_us "${line}")" || exit 1
    lists="$(ad_cscb_verb_between list "${LATCH_LIFE_MARK}" "${LATCH_MARK[${key}]}")" || exit 1
    while IFS=$'\t' read -r pos time ppid _; do
        [[ -n "${pos}" && "${ppid}" == "${LATCH_PID}" ]] || continue
        us="$(us_of "${time}")" || exit 1
        (( us < latch_us )) || continue
        sweep="${pos} ${time}"
    done <<< "${lists}"
    [[ -n "${sweep}" ]] || fail "${step}: no CSCB list of the bot server's (${LATCH_PID}) in the latch life before ${id}'s latch ($(secs_of "${latch_us}"))"
    read -r pos time <<< "${sweep}"
    LATCH_US[${key}]="$(us_of "${time}")" || exit 1
    while IFS=$'\t' read -r p time _; do
        [[ -n "${p}" ]] || continue
        us="$(us_of "${time}")" || exit 1
        (( us > latch_us )) || fail "${step}: the CSCB call of ${id} at shim line ${p} ($(secs_of "${us}")) comes before its latch ($(secs_of "${latch_us}"))"
    done <<< "${rows}"
    if [[ -n "${rows}" ]]; then
        echo "${TEST_NAME}: ${step}: [recorded] CSCB call(s) of ${id} after its latch and before its latch mark: $(field_of 4 "${rows}" | tr '\n' ' ')"
        grep -F -e "${PERSONA_NAME[${key}]}\" (key=${key})" -e "persona=${key} " "${SLACK_STATE_DIR}/server.log" \
            | sed "s/^/${TEST_NAME}: ${step}: [recorded] server.log: /" | head -n 20 || true
    fi
    echo "${TEST_NAME}: ${step}: the start sweep's list at shim line ${pos} ($(secs_of "${LATCH_US[${key}]}")), then the latch ($(secs_of "${latch_us}")), before every call of ${id}"
    [[ "${CASE_OF[${key}]}" == "${CASE_LAUNCH_START}" ]] || return 0
    started="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_started_at, '') FROM spawns WHERE claude_instance_id = '${id}'")" \
        || exit 1
    [[ -z "${started}" ]] || fail "${step}: ${id} records launch start '${started}' at its latch"
    echo "${TEST_NAME}: ${step}: ${id} records no launch start"
}

# p2_check_latch <key>: the latch's checks (see the header, life 5).
p2_check_latch() {
    local key="$1" step="part 2: latch life: $1 latches" id="${PERSONA_ID[$1]}" set_line rows n line
    local want kills
    set_line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" "${SESSION_OF[${key}]}" "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    expect_count "${set_line}" 1 "${step}: latch-set lines"
    case "${key}" in
        "${UN_KEY}") want="${UNUSABLE_NAME}" ;;
        *) want="${PERSONA_NAMED[${key}]}" ;;
    esac
    [[ "${SESSION_OF[${key}]}" == "${want}" ]] || fail "${step}: the latch quotes session '${SESSION_OF[${key}]}', not ${want}"

    # The bring-up's refused call, the bot server's; the persona's last call
    # before the latch is the round timer's starting point; no kill.
    rows="$(ad_cscb_calls "${id}" "${LATCH_LIFE_MARK}" "${LATCH_MARK[${key}]}")" || exit 1
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} up to the latch (recorded): $(field_of 4 "${rows}" | tr '\n' ' ')"
    if [[ "${REFUSED_OF[${key}]}" == none ]]; then
        check_sweep_latch "${step}" "${key}" "${rows}"
    else
        p2_check_bringup_refusal "${step}" "${key}" "${rows}"
    fi
    kills="$(verb_rows kill "${rows}")" || exit 1
    n="$(rows_count "${kills}")"
    (( n == 0 )) || fail "${step}: ${n} CSCB kill call(s) of ${id} before the latch"

    # One post, the notice.
    if [[ "${key}" == "${UN_KEY}" ]]; then
        wait_until "${NOTICE_WAIT_S}" "${step}: no unusable-name notice on ${PERSONA_CHANNEL[${key}]}" \
            posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${UNUSABLE_HEAD}" 1
        check_unusable_notice "${step}" "${key}"
    elif [[ "${key}" == "${NS_KEY}" ]]; then
        wait_until "${NOTICE_WAIT_S}" "${step}: no launch-start notice on ${PERSONA_CHANNEL[${key}]}" \
            posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${LAUNCH_START_HEAD}" 1
        check_launch_start_notice "${step}" "${key}"
    else
        wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${key}]}" \
            posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${CONFLICT_HEAD}" 1
        check_conflict_notice "${step}" "${key}"
    fi
    n="$(posts_since "${key}" "${POSTS_BEFORE[${key}]}")" || exit 1
    (( n == 1 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the latch life began, not only the notice"

    # The harness's read of the row at the latch.
    if [[ "${key}" == "${SL_KEY}" ]]; then
        n="$(store_rows_of "${step}" "${id}")" || exit 1
        [[ "${n}" == 0 ]] || fail "${step}: the store holds ${n} row(s) with id ${id}, not none"
        LATCH_STATE[${key}]="no row"
        LATCH_RV[${key}]=""
    else
        store_row "${step}" "${id}"
        [[ "${STORE_STATE}" == "${LATCH_ROW_OF[${key}]}" ]] \
            || fail "${step}: ${id} reads ${STORE_STATE} in the store, not ${LATCH_ROW_OF[${key}]} as the latch records"
        LATCH_STATE[${key}]="${STORE_STATE}"
        LATCH_RV[${key}]="${STORE_RV}"
    fi

    # The round lines: a still-latched round's, and the head every round of
    # its step and call shares.
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${key}]}" "${CASE_OF[${key}]}" "${STEP_OF[${key}]}" "${CALL_OF[${key}]}" ANSWERSLOT)" \
        || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    ROUND_HEAD[${key}]="${line%ANSWERSLOT}"
    STILL_LINE[${key}]="${ROUND_HEAD[${key}]}${ANSWER_OF[${key}]}"
    echo "${TEST_NAME}: ${step}: case ${CASE_OF[${key}]}, refused ${OP_OF[${key}]}, session ${SESSION_OF[${key}]}; ${id}: ${LATCH_STATE[${key}]}${LATCH_RV[${key}]:+ at row_version ${LATCH_RV[${key}]}}"
}

p2_latch_life() {
    local step="part 2: latch life" key n
    for key in "${P2_KEYS[@]}"; do
        POSTS_BEFORE[${key}]="$(post_count "${key}")" || exit 1
    done
    # A start runs its state dir's last-applied record, so this life, which
    # adds the personas with no row, starts in a state dir of its own. Part
    # 1's personas stay configured.
    new_state_dir latch-life
    write_personas_config "${P1_KEYS[@]}" "${P2_KEYS[@]}"
    n=$(( ${#P1_KEYS[@]} + ${#P2_KEYS[@]} ))
    LATCH_LIFE_MARK="$(ad_shim_mark)"
    LATCH_LIFE_TMUX_MARK="$(tmux_shim_mark)"
    start_server --live
    LATCH_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${n}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${n}")" | sed 's/^.*\] //')"
    # Every mark first (a round comes one interval after its latch), then the
    # checks.
    for key in "${P2_KEYS[@]}"; do
        wait_latch_set "${key}"
    done
    for key in "${P2_KEYS[@]}"; do
        p2_check_latch "${key}"
    done
}

# ---------------------------------------------------------------------------
# Part 2: the clearing schedule (light steps only; the checks come after)
# ---------------------------------------------------------------------------

# wait_rounds <key> <matcher> <n> <round>: wait for <n> lines matching
# <matcher>, the persona's <round>-th round from its latch being the last.
wait_rounds() {
    local key="$1" m="$2" n="$3" round="$4"
    if ! _scenario_poll_until $(( round * (INTERVAL_S + 2 * SETTLE_S) )) _scenario_log_count_at_least "${m}" "${n}"; then
        latch_lines_of "${key}"
        fail "part 2: ${key}'s round ${round}: fewer than ${n} round line(s) '$(matcher_text "${m}")'"
    fi
}

# free_snapshot <key> <rounds>: right after the clearing event (or, for the
# persona latched to the end, right after its last round checked), with
# <rounds> still-latched round lines logged: the mark, the post count, the
# MCP registration count and the harness's store read of the row (for the
# scan's refusal, that the store holds none).
free_snapshot() {
    local n
    FREE_ROUNDS[$1]="$2"
    FREE_MARK[$1]="$(ad_shim_mark)"
    FREE_POSTS[$1]="$(post_count "$1")" || exit 1
    FREE_CONNECTS[$1]="$(count_log "$(connected_match "$1")")"
    if [[ "$1" == "${SL_KEY}" ]]; then
        n="$(store_rows_of "part 2: $1's clearing event" "${PERSONA_ID[$1]}")" || exit 1
        FREE_STATE[$1]="${n} row(s)"
        [[ "${n}" != 0 ]] || FREE_STATE[$1]="no row"
        FREE_RV[$1]=""
    else
        store_row "part 2: $1's clearing event" "${PERSONA_ID[$1]}"
        FREE_STATE[$1]="${STORE_STATE}"
        FREE_RV[$1]="${STORE_RV}"
    fi
}

p2_clearing_schedule() {
    local step key n
    # R1 and R2: every batched persona still latched; then [harness] the
    # batched round's clearing event: the names are freed.
    for key in "${P2_BATCH_KEYS[@]}"; do
        wait_rounds "${key}" "${ROUND_HEAD[${key}]}" "${MIN_LATCHED_ROUNDS}" "${MIN_LATCHED_ROUNDS}"
    done
    step="part 2: the batched round's clearing event"
    for key in "${NL_KEY}" "${AS_KEY}" "${LO_KEY}" "${SL_KEY}" "${DS_KEY}"; do
        end_session "${SEED_SID[${key}]}"
    done
    rename_session "${SEED_SID[${DI_KEY}]}" "${LENDER_SESSION}" > /dev/null
    for key in "${P2_BATCH_KEYS[@]}"; do
        n="$(count_log "${ROUND_HEAD[${key}]}")"
        (( n == MIN_LATCHED_ROUNDS )) || fail "${step}: ${key} has ${n} round lines at its clearing event, not ${MIN_LATCHED_ROUNDS}"
        free_snapshot "${key}" "${n}"
    done
    echo "${TEST_NAME}: ${step}: the harness ended the seeded sessions of ${NL_KEY}, ${AS_KEY}, ${LO_KEY}, ${SL_KEY} and ${DS_KEY} and renamed ${PERSONA_NAMED[${DI_KEY}]} back to ${LENDER_SESSION}"

    # The batched round (R3) and the own-id persona's R3; then [harness] the
    # own-id round's clearing event: its session ended by its id.
    for key in "${P2_BATCH_KEYS[@]}"; do
        wait_rounds "${key}" "${ROUND_HEAD[${key}]}" $(( MIN_LATCHED_ROUNDS + 1 )) $(( MIN_LATCHED_ROUNDS + 1 ))
    done
    wait_rounds "${OI_KEY}" "${STILL_LINE[${OI_KEY}]}" $(( MIN_LATCHED_ROUNDS + 1 )) $(( MIN_LATCHED_ROUNDS + 1 ))
    step="part 2: the own-id round's clearing event"
    n="$(count_log "${ROUND_HEAD[${OI_KEY}]}")"
    (( n == MIN_LATCHED_ROUNDS + 1 )) || fail "${step}: ${OI_KEY} has ${n} round lines at its clearing event, not $(( MIN_LATCHED_ROUNDS + 1 ))"
    end_session "${SEED_SID[${OI_KEY}]}"
    free_snapshot "${OI_KEY}" "${n}"
    echo "${TEST_NAME}: ${step}: the harness ended ${PERSONA_NAMED[${OI_KEY}]} (${SEED_SID[${OI_KEY}]})"

    # The own-id round (R4), its line seen and its window closed; the
    # pane-not-found persona's R4; then [harness] that persona's clearing
    # event: its stub set to report in at once, its session ended by its id.
    ROUND_END_HEAD[${OI_KEY}]="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${OI_KEY}]}" "${CASE_OWN_ID}" "${STEP_TABLE}" \
        "${CALL_PROBE}+find-missing+${RETRY_OF[${OI_KEY}]}" "probe-cleared (${KIND_GONE}); ")" \
        || fail "part 2: fmk-texts.ts could not print latchRecheckRoundLine"
    wait_rounds "${OI_KEY}" "$(matcher "${ROUND_END_HEAD[${OI_KEY}]}" "cleared (")" 1 $(( MIN_LATCHED_ROUNDS + 2 ))
    ROUND_END_MARK[${OI_KEY}]="$(ad_shim_mark)"
    wait_rounds "${PN_KEY}" "${STILL_LINE[${PN_KEY}]}" $(( MIN_LATCHED_ROUNDS + 2 )) $(( MIN_LATCHED_ROUNDS + 2 ))
    step="part 2: the pane-not-found round's clearing event"
    n="$(count_log "${ROUND_HEAD[${PN_KEY}]}")"
    (( n == MIN_LATCHED_ROUNDS + 2 )) || fail "${step}: ${PN_KEY} has ${n} round lines at its clearing event, not $(( MIN_LATCHED_ROUNDS + 2 ))"
    stub_mode "${PERSONA_WORK[${PN_KEY}]}" "${STUB_MODE_AT_ONCE}"
    end_session "${SEED_SID[${PN_KEY}]}"
    free_snapshot "${PN_KEY}" "${n}"
    echo "${TEST_NAME}: ${step}: the harness selected ${STUB_MODE_AT_ONCE} for ${PN_KEY}'s stub and ended ${PERSONA_NAMED[${PN_KEY}]} (${SEED_SID[${PN_KEY}]})"

    # The pane-not-found round (R5), its line seen and its window closed.
    ROUND_END_HEAD[${PN_KEY}]="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${PN_KEY}]}" "${CASE_PANE_NOT_FOUND}" "${STEP_TABLE}" \
        "${CALL_PROBE}+find-missing+${RETRY_OF[${PN_KEY}]}" "probe-cleared (${KIND_GONE}); ")" \
        || fail "part 2: fmk-texts.ts could not print latchRecheckRoundLine"
    wait_rounds "${PN_KEY}" "$(matcher "${ROUND_END_HEAD[${PN_KEY}]}" "cleared (")" 1 $(( MIN_LATCHED_ROUNDS + 3 ))
    ROUND_END_MARK[${PN_KEY}]="$(ad_shim_mark)"

    # The unusable recorded name, still latched: its rounds so far (as many
    # as the pane-not-found persona's), taken right after its last.
    wait_rounds "${UN_KEY}" "${STILL_LINE[${UN_KEY}]}" $(( MIN_LATCHED_ROUNDS + 3 )) $(( MIN_LATCHED_ROUNDS + 3 ))
    n="$(count_log "${STILL_LINE[${UN_KEY}]}")"
    free_snapshot "${UN_KEY}" "${n}"
    # A leg that joins Part 2 adds its clearing event here, in a round of its
    # own when its clear is counted by a window.
    p2_relabel_events
}

# ---------------------------------------------------------------------------
# Part 2: the "not this launch's session" legs and the find-missing loop
# ---------------------------------------------------------------------------

# p2_relabel_events: after the last clearing round above (so the loop adds no
# find-missing to those rounds' windows), right after one more round of each
# leg: [harness] leg 1's worker pane respawned with `sleep` (the worker ends,
# the relabelled session stays); [harness] leg 2's relabelled session ended by
# its id, which ends its worker (END_MARK); each leg's snapshot; then
# [harness] the find-missing loop started (LOOP_MARK). Its calls are the
# harness's, never CSCB's.
p2_relabel_events() {
    local step="part 2: the relabelled legs' events" key n out
    local -A want=()
    for key in "${P2_RELABEL_KEYS[@]}"; do
        n="$(count_log "${STILL_LINE[${key}]}")"
        want[${key}]=$(( n + 1 ))
    done
    for key in "${P2_RELABEL_KEYS[@]}"; do
        wait_rounds "${key}" "${STILL_LINE[${key}]}" "${want[${key}]}" "${want[${key}]}"
    done
    EVENT_TMUX_MARK[${R1_KEY}]="$(tmux_shim_mark)"
    out="$(respawn_worker_pane "${SEED_PANE[${R1_KEY}]}" sleep 86400)" || exit 1
    EVENT_TMUX_MARK[${R2_KEY}]="$(tmux_shim_mark)"
    end_session "${SEED_SID[${R2_KEY}]}"
    END_MARK="$(ad_shim_mark)"
    for key in "${P2_RELABEL_KEYS[@]}"; do
        n="$(count_log "${STILL_LINE[${key}]}")"
        (( n == want[${key}] )) || fail "${step}: ${key} has ${n} round lines at its event, not ${want[${key}]}"
        free_snapshot "${key}" "${n}"
    done
    has_session_id "${SEED_SID[${R1_KEY}]}" || fail "${step}: ${R1_KEY}'s relabelled session ${SEED_SID[${R1_KEY}]} is gone after the respawn"
    echo "${TEST_NAME}: ${step}: the harness respawned ${R1_KEY}'s worker pane (pane and new pid ${out}; ${SEED_SID[${R1_KEY}]} stays) and ended ${PERSONA_NAMED[${R2_KEY}]} (${SEED_SID[${R2_KEY}]})"
    LOOP_MARK="$(ad_shim_mark)"
    run_find_missing_loop
    echo "${TEST_NAME}: part 2: the harness's find-missing loop started (PID ${FIND_MISSING_LOOP_PID}, every ${FIND_MISSING_LOOP_INTERVAL_S} s)"
}

# p2_relabel_rounds: once a harness read shows each leg's row `missing`
# (MISSING_MARK), the leg's next round: leg 1's finished-row retry relatches
# with "left over from an earlier life", then its following round
# (FOLLOW_MARK, FOLLOW_ROUNDS); leg 2's finished-row retry clears
# (ROUND_END_MARK).
p2_relabel_rounds() {
    local key bound line
    bound=$(( 2 * (INTERVAL_S + 2 * SETTLE_S) ))
    for key in "${P2_RELABEL_KEYS[@]}"; do
        wait_row "part 2: ${key}'s row marked by the loop" $(( FIND_MISSING_LOOP_INTERVAL_S + 60 )) "${PERSONA_ID[${key}]}" missing
        MISSING_MARK[${key}]="$(ad_shim_mark)"
        echo "${TEST_NAME}: part 2: a harness read shows ${PERSONA_ID[${key}]} missing (shim mark ${MISSING_MARK[${key}]})"
    done
    RETRY_LINE="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${R1_KEY}]}" "${CASE_NOT_THIS_LAUNCH}" "${STEP_FINISHED_ROW}" \
        "${CALL_FINISHED_ROW}:${CALL_RESUME}" "relatched (case=${CASE_LEFTOVER})")" \
        || fail "part 2: fmk-texts.ts could not print latchRecheckRoundLine"
    if ! _scenario_poll_until "${bound}" _scenario_log_count_at_least "${RETRY_LINE}" 1; then
        latch_lines_of "${R1_KEY}"
        fail "part 2: ${R1_KEY}'s finished-row retry never relatched it: no line '${RETRY_LINE}' (not within ${bound}s)"
    fi
    FOLLOW_LINE="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${R1_KEY}]}" "${CASE_LEFTOVER}" "${STEP_TABLE}" "${CALL_RESUME}" still-latched)" \
        || fail "part 2: fmk-texts.ts could not print latchRecheckRoundLine"
    if ! _scenario_poll_until "${bound}" _scenario_log_count_at_least "${FOLLOW_LINE}" 1; then
        latch_lines_of "${R1_KEY}"
        fail "part 2: ${R1_KEY} never made a round of its new case: no line '${FOLLOW_LINE}' (not within ${bound}s)"
    fi
    FOLLOW_MARK="$(ad_shim_mark)"
    FOLLOW_ROUNDS="$(count_log "${FOLLOW_LINE}")"
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${R2_KEY}]}" "${CASE_NOT_THIS_LAUNCH}" "${STEP_FINISHED_ROW}" \
        "${CALL_FINISHED_ROW}:${CALL_RESUME}" ANSWERSLOT)" || fail "part 2: fmk-texts.ts could not print latchRecheckRoundLine"
    ROUND_END_HEAD[${R2_KEY}]="${line%ANSWERSLOT}"
    if ! _scenario_poll_until "${bound}" _scenario_log_count_at_least "$(matcher "${ROUND_END_HEAD[${R2_KEY}]}" "cleared (")" 1; then
        latch_lines_of "${R2_KEY}"
        fail "part 2: ${R2_KEY}'s finished-row retry never cleared it: no line '${ROUND_END_HEAD[${R2_KEY}]}cleared (…' (not within ${bound}s)"
    fi
    ROUND_END_MARK[${R2_KEY}]="$(ad_shim_mark)"
}

# ---------------------------------------------------------------------------
# Part 2: the checks, from the logs
# ---------------------------------------------------------------------------

# check_latched_rounds <key>: the round checker (see the header, life 6),
# from the persona's latch to its clearing event's mark (FREE_MARK), with
# FREE_ROUNDS still-latched round lines and FREE_POSTS posts then. Sets
# PREV_US to the last round's status time.
check_latched_rounds() {
    local key="$1" step="part 2: $1's still-latched rounds" id="${PERSONA_ID[$1]}" rounds n i=0 prev to posts
    local s_pos s_us c_pos c_us
    n="${FREE_ROUNDS[${key}]}"
    to="${FREE_MARK[${key}]}"
    posts="${FREE_POSTS[${key}]}"
    (( n >= MIN_LATCHED_ROUNDS )) || { latch_lines_of "${key}"; fail "${step}: ${n} still-latched round line(s), fewer than ${MIN_LATCHED_ROUNDS}"; }
    rounds="$(latch_rounds "${step}" "${key}" "${LATCH_MARK[${key}]}" "${to}")" || exit 1
    if (( $(rows_count "${rounds}") != n )); then
        latch_lines_of "${key}"
        calls_of "${key}" "${LATCH_MARK[${key}]}" "${to}"
        fail "${step}: $(rows_count "${rounds}") rounds of ${id} in the shim's log, not the ${n} still-latched round lines"
    fi
    prev="${LATCH_US[${key}]}"
    while read -r s_pos s_us c_pos c_us; do
        i=$(( i + 1 ))
        check_cadence "${step}: round ${i}" "${prev}" "${s_us}" "${c_us}" "${CALL_OF[${key}]}"
        echo "${TEST_NAME}: ${step}: round ${i}: status at shim line ${s_pos}, ${CALL_OF[${key}]} at ${c_pos}"
        prev="${s_us}"
    done <<< "${rounds}"
    PREV_US[${key}]="${prev}"
    (( posts - POSTS_BEFORE[${key}] == 1 )) \
        || fail "${step}: ${PERSONA_CHANNEL[${key}]} held $(( posts - POSTS_BEFORE[${key}] )) posts since the latch life began, not only the latch's notice"
    if [[ "${CALL_OF[${key}]}" == "${CALL_NONE}" ]]; then
        echo "${TEST_NAME}: ${step}: ${i} still-latched round(s), each one status alone; no post beyond the latch's"
    else
        echo "${TEST_NAME}: ${step}: ${i} still-latched round(s), each one status then ${CALL_OF[${key}]}; no post beyond the latch's"
    fi
}

# check_retry_unwritten <key>: a launch retry re-refused writes nothing: the
# store read at the clearing event (the end of the still-latched rounds,
# before the clear) gives what it gave at the latch: no row for the scan's
# refusal, else the same state and row_version.
check_retry_unwritten() {
    local key="$1" step="part 2: $1's still-latched rounds"
    [[ "${FREE_STATE[${key}]}" == "${LATCH_STATE[${key}]}" && "${FREE_RV[${key}]}" == "${LATCH_RV[${key}]}" ]] \
        || fail "${step}: ${PERSONA_ID[${key}]} read '${FREE_STATE[${key}]}${FREE_RV[${key}]:+ at row_version ${FREE_RV[${key}]}}' at its clearing event, not '${LATCH_STATE[${key}]}${LATCH_RV[${key}]:+ at row_version ${LATCH_RV[${key}]}}' as at the latch"
    echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]}: ${FREE_STATE[${key}]}${FREE_RV[${key}]:+ at row_version ${FREE_RV[${key}]}}, as at the latch"
}

# check_launched <step> <key> [<reason>]: the clear after a launch that was
# not refused: the clear line (reason <reason>, by default "a retry of the
# refused operation was not refused", posted), once; the row reads `waiting`
# on the persona's session name, a persona with a first life on that life's
# claude_session_id (its `resume` kept the conversation); the server
# registers its stub's MCP session; exactly one recovery post, the printed
# recovery notice, and no post since the latch life began but the latch's
# notice and it.
check_launched() {
    local step="$1" key="$2" reason="${3:-LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED}" id="${PERSONA_ID[$2]}" name="${PERSONA_NAME[$2]}"
    local session="${SESSION_OF[$2]}" cleared recovery n
    cleared="$(fmk_text latchClearedLine "${key}" "${CASE_OF[${key}]}" "${session}" posted "${reason}")" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    if ! _scenario_poll_until "${SETTLE_S}" _scenario_log_has "${cleared}"; then
        latch_lines_of "${key}"
        fail "${step}: no clear line '${cleared}'"
    fi
    expect_count "${cleared}" 1 "${step}: the clear line"
    wait_row "${step}: the launch's report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ -n "${ROW_SID}" ]] || fail "${step}: the launched row has no claude_session_id"
    [[ -z "${PERSONA_SID[${key}]:-}" || "${ROW_SID}" == "${PERSONA_SID[${key}]}" ]] \
        || fail "${step}: the resumed row's claude_session_id is '${ROW_SID}', not its first life's ${PERSONA_SID[${key}]}"
    [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the launched row records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
    wait_for_count "$(connected_match "${key}")" $(( FREE_CONNECTS[${key}] + 1 )) "${CONNECT_WAIT_S}" \
        "${step}: the server never registered the launched stub's session as ${key}'s"
    recovery="$(fmk_text formatPersonaNotice "${name}" conflictRecoveryText "${session}" "${reason}")" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    wait_until "${NOTICE_WAIT_S}" "${step}: no recovery post on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}" 1
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed recovery notice"
    fi
    n="$(posts_since "${key}" "${POSTS_BEFORE[${key}]}")" || exit 1
    (( n == 2 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the latch life began, not the latch's notice and the recovery post"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with claude_session_id ${ROW_SID}; one recovery post"
}

# check_retry_clear <key>: the batched round: its first two calls of the id
# are one `status` then the table's call, at the cadence, with no CSCB
# `find-missing` between them; the call launches (check_launched).
check_retry_clear() {
    local key="$1" step="part 2: $1's clear (the batched round)" id="${PERSONA_ID[$1]}" rows s_pos s_time s_verb c_pos c_time c_verb c_args between
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}")" || exit 1
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    IFS=$'\t' read -r c_pos c_time _ c_verb _ c_args <<< "$(sed -n 2p <<< "${rows}")"
    if [[ "${s_verb}" != status ]] || ! round_call_is "${CALL_OF[${key}]}" "${c_verb}" "${c_args}"; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round's first calls of ${id} are '${s_verb}' and '${c_verb}', not status then ${CALL_OF[${key}]}"
    fi
    check_cadence "${step}" "${PREV_US[${key}]}" "$(us_of "${s_time}")" "$(us_of "${c_time}")" "${CALL_OF[${key}]}"
    between="$(ad_cscb_verb_between find-missing "${s_pos}" "${c_pos}")" || exit 1
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the round's status and its ${CALL_OF[${key}]}"; }
    expect_count "${STILL_LINE[${key}]}" "${MIN_LATCHED_ROUNDS}" "${step}: still-latched round lines"
    check_launched "${step}" "${key}"
}

# check_probe_clear <key>: the probe's own clearing round (see the header,
# life 6).
check_probe_clear() {
    local key="$1" step="part 2: $1's clear (its own round)" id="${PERSONA_ID[$1]}" rows fm s_pos s_time s_verb p_pos p_time p_verb p_args
    local f_pos r_rows r_pos launches spawns pos verb args n
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}" "${ROUND_END_MARK[${key}]}")" || exit 1
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} in the round's window (recorded): $(field_of 4 "${rows}" | tr '\n' ' ')"
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    IFS=$'\t' read -r p_pos p_time _ p_verb _ p_args <<< "$(sed -n 2p <<< "${rows}")"
    if [[ "${s_verb}" != status ]] || ! round_call_is "${CALL_PROBE}" "${p_verb}" "${p_args}"; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round's first calls of ${id} are '${s_verb}' and '${p_verb}', not status then a one-line read-pane"
    fi
    check_cadence "${step}" "${PREV_US[${key}]}" "$(us_of "${s_time}")" "$(us_of "${p_time}")" "${CALL_PROBE}"
    # Exactly one CSCB find-missing in the round's window, after the probe.
    fm="$(ad_cscb_verb_between find-missing "${s_pos}" "${ROUND_END_MARK[${key}]}")" || exit 1
    n="$(rows_count "${fm}")"
    (( n == 1 )) || { sed 's/^/  | /' <<< "${fm}" >&2; fail "${step}: ${n} CSCB find-missing call(s) in the round's window, not one"; }
    f_pos="$(field_of 1 "${fm}")"
    (( f_pos > p_pos )) || fail "${step}: the find-missing at shim line ${f_pos} comes before the probe at ${p_pos}"
    # Then exactly one retry, and no call of the id between the probe and the
    # find-missing. The own-id persona's retry is one `resume`, its first
    # call after the find-missing. The pane-not-found persona's is one run
    # of the restart path's decision: one launch that launches (here a
    # `resume`, the row having a session id), its ladder's first plain spawn
    # before it, which meets the row, recorded.
    rows="$(ad_cscb_calls "${id}" "${p_pos}" "${f_pos}")" || exit 1
    n="$(rows_count "${rows}")"
    (( n == 0 )) || fail "${step}: ${n} CSCB call(s) of ${id} between the probe and the find-missing"
    r_rows="$(ad_cscb_calls "${id}" "${f_pos}" "${ROUND_END_MARK[${key}]}")" || exit 1
    launches="$(verb_rows resume "${r_rows}")" || exit 1
    (( $(rows_count "${launches}") == 1 )) \
        || { sed 's/^/  | /' <<< "${r_rows}" >&2; fail "${step}: $(rows_count "${launches}") resume call(s) of ${id} after the find-missing, not one"; }
    r_pos="$(field_of 1 "${launches}")"
    spawns="$(verb_rows spawn "${r_rows}")" || exit 1
    if [[ "${RETRY_OF[${key}]}" == "${CALL_RESUME}" ]]; then
        [[ -z "${spawns}" && "$(sed -n 1p <<< "${r_rows}" | cut -f 1)" == "${r_pos}" ]] \
            || { sed 's/^/  | /' <<< "${r_rows}" >&2; fail "${step}: the retry after the find-missing is not one resume"; }
    else
        while IFS=$'\t' read -r pos _ _ verb _ args; do
            [[ -n "${pos}" ]] || continue
            if (( pos > r_pos )) || ! round_call_is "${CALL_PLAIN_SPAWN}" "${verb}" "${args}"; then
                sed 's/^/  | /' <<< "${r_rows}" >&2
                fail "${step}: the spawn of ${id} at shim line ${pos} is not the ladder's first plain spawn before the resume"
            fi
        done <<< "${spawns}"
        (( $(rows_count "${spawns}") <= 1 )) || { sed 's/^/  | /' <<< "${r_rows}" >&2; fail "${step}: more than one spawn of ${id} in the restart path's decision"; }
    fi
    echo "${TEST_NAME}: ${step}: status, read-pane at ${p_pos}, find-missing at ${f_pos}, resume at ${r_pos} (the retry's calls: $(field_of 4 "${r_rows}" | tr '\n' ' '))"
    expect_count "$(matcher "${ROUND_END_HEAD[${key}]}" "cleared (")" 1 "${step}: the cleared probe's round line"
    check_launched "${step}" "${key}"
}


p2_checks() {
    local key rows found verb n
    for key in "${P2_BATCH_KEYS[@]}"; do
        check_latched_rounds "${key}"
        check_retry_unwritten "${key}"
        check_retry_clear "${key}"
    done
    check_latched_rounds "${OI_KEY}"
    check_probe_clear "${OI_KEY}"
    check_latched_rounds "${PN_KEY}"
    check_probe_clear "${PN_KEY}"
    # The unusable recorded name: every round `status` alone (its clear, none,
    # is checked at the end).
    check_latched_rounds "${UN_KEY}"
    # Nothing killed or deleted for a Part 2 persona in the latch life; the
    # borrowed session, another row's, still runs.
    for key in "${P2_KEYS[@]}"; do
        rows="$(ad_cscb_calls "${PERSONA_ID[${key}]}" "${LATCH_LIFE_MARK}")" || exit 1
        for verb in kill kill-finished delete; do
            found="$(verb_rows "${verb}" "${rows}")" || exit 1
            n="$(rows_count "${found}")"
            (( n == 0 )) || fail "part 2: ${n} CSCB ${verb} call(s) of ${PERSONA_ID[${key}]} in the latch life"
        done
    done
    has_session_id "${SEED_SID[${DI_KEY}]}" || fail "part 2: the borrowed session ${SEED_SID[${DI_KEY}]} is gone"
    echo "${TEST_NAME}: part 2: no kill, kill-finished or delete of a Part 2 persona's row; ${LENDER_SESSION} still runs"
    # Positive control for round_call_is's "no --allow-pending": the reader
    # shows that flag on the approver's read-pane of a pending row in Part 2's
    # first life.
    rows="$(ad_cscb_calls '*' "${P2_START_MARK}" "${LATCH_LIFE_MARK}")" || exit 1
    found="$(verb_rows read-pane "${rows}")" || exit 1
    n="$(rows_count "${found}")"
    [[ " $(field_of 6 "${found}" | tr '\n' ' ') " == *" --allow-pending "* ]] \
        || fail "part 2: positive control: none of the ${n} CSCB read-pane call(s) of the first life carries --allow-pending in the reader's arguments"
    echo "${TEST_NAME}: part 2: positive control: the first life's CSCB read-pane calls (${n}) carry --allow-pending where the approver read a pending row"
}

# ---------------------------------------------------------------------------
# Part 2: the checks of the "not this launch's session" legs, the loop and
# "launch start not recorded"
# ---------------------------------------------------------------------------

# shim_verb_rows <verb>: print, for each agent-director shim `call` line of
# <verb>, whatever its parent, `<position> TAB <time-us> TAB <ppid> TAB <role>`,
# <role> the CSCB process role that held the parent then, or `-` for none
# (the harness's own calls, the find-missing loop's among them).
shim_verb_rows() {
    local lines=() i role
    _scenario_query_prep shim_verb_rows
    _scenario_read_log shim_verb_rows "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words
        _scenario_ad_verb
        [[ "${_L_VERB}" == "$1" ]] || continue
        role=-
        if _scenario_role_at "${_L_PPID}" "${_L_US}"; then
            role="${_SCENARIO_ROLE}"
        fi
        printf '%s\t%s\t%s\t%s\n' "$(( i + 1 ))" "${_L_US}" "${_L_PPID}" "${role}"
    done
    return 0
}

# load_calls <rows>: split reader rows into CALL_POS, CALL_US, CALL_VERB and
# CALL_ARGS (one element per row, in log order).
load_calls() {
    local pos time verb args us
    CALL_POS=()
    CALL_US=()
    CALL_VERB=()
    CALL_ARGS=()
    [[ -n "$1" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _ args; do
        CALL_POS+=("${pos}")
        us="$(us_of "${time}")" || exit 1
        CALL_US+=("${us}")
        CALL_VERB+=("${verb}")
        CALL_ARGS+=("${args}")
    done <<< "$1"
}

# check_loop_runs: the find-missing loop's runs are the harness's: at least
# one `find-missing` line whose parent is the loop's subshell, the first one
# after LOOP_MARK (which follows leg 2's end, END_MARK), none of them
# CSCB-parented; and the harness ran no find-missing before the loop. Sets
# LOOP_FIRST_POS.
check_loop_runs() {
    local step="part 2: the find-missing loop" rows pos us ppid role n=0 before=0 cscb_after=0 runs
    rows="$(shim_verb_rows find-missing)" || exit 1
    LOOP_FIRST_POS=""
    while IFS=$'\t' read -r pos us ppid role; do
        [[ -n "${pos}" ]] || continue
        if [[ "${ppid}" == "${FIND_MISSING_LOOP_PID}" ]]; then
            [[ "${role}" == - ]] || fail "${step}: the loop's find-missing at shim line ${pos} reads as a CSCB process's (${role})"
            n=$(( n + 1 ))
            [[ -n "${LOOP_FIRST_POS}" ]] || LOOP_FIRST_POS="${pos}"
        elif [[ "${role}" == - ]] && (( pos > P2_START_MARK && pos <= LOOP_MARK )); then
            before=$(( before + 1 ))
        elif [[ "${role}" != - ]] && (( pos > LOOP_MARK )); then
            cscb_after=$(( cscb_after + 1 ))
        fi
    done <<< "${rows}"
    (( n > 0 )) || fail "${step}: no find-missing line in the shim's log has the loop (${FIND_MISSING_LOOP_PID}) as its parent"
    (( before == 0 )) || fail "${step}: ${before} find-missing call(s) not CSCB's in Part 2 before the loop started"
    (( END_MARK <= LOOP_MARK && LOOP_FIRST_POS > LOOP_MARK )) \
        || fail "${step}: the loop's first find-missing (shim line ${LOOP_FIRST_POS}) is not after leg 2's end (mark ${END_MARK}) and the loop's start (mark ${LOOP_MARK})"
    runs="$(find_missing_loop_runs)"
    (( runs > 0 )) || fail "${step}: the loop's log holds no run"
    echo "${TEST_NAME}: ${step}: ${runs} run(s) logged, ${n} find-missing line(s) parented by the loop, the first at shim line ${LOOP_FIRST_POS}, after leg 2's end (mark ${END_MARK}); none CSCB's; ${cscb_after} CSCB find-missing call(s) since (recorded)"
}

# check_nothing_typed <key>: AC 44: from the latch life's start to the leg's
# event, no tmux send-keys, send-prefix or paste-buffer reached the
# relabelled session's worker pane, by its pane id, session id or name (the
# tmux shim's log); positive control: the first life's approver typed into
# it.
check_nothing_typed() {
    local key="$1" step="part 2: $1's relabelled session: nothing typed" target rows hits n=0 ctl=0
    for target in "${SEED_PANE[${key}]}" "${SEED_SID[${key}]}" "${PERSONA_NAMED[${key}]}"; do
        rows="$(tmux_shim_targets "${target}" "${LATCH_LIFE_TMUX_MARK}" "${EVENT_TMUX_MARK[${key}]}")" || exit 1
        hits="$([[ -z "${rows}" ]] || awk -F'\t' '$4 == "send-keys" || $4 == "send-prefix" || $4 == "paste-buffer"' <<< "${rows}")"
        if [[ -n "${hits}" ]]; then
            sed 's/^/  | /' <<< "${hits}" >&2
            n=$(( n + $(rows_count "${hits}") ))
        fi
        rows="$(tmux_shim_targets "${target}" "${P2_START_TMUX_MARK}" "${LATCH_LIFE_TMUX_MARK}")" || exit 1
        hits="$([[ -z "${rows}" ]] || awk -F'\t' '$4 == "send-keys"' <<< "${rows}")"
        ctl=$(( ctl + $(rows_count "${hits}") ))
    done
    (( n == 0 )) || fail "${step}: ${n} tmux call(s) typed into ${SEED_PANE[${key}]} (${SEED_SID[${key}]}, ${PERSONA_NAMED[${key}]}) in the latch life"
    (( ctl > 0 )) || fail "${step}: positive control: the reader finds no send-keys into ${SEED_PANE[${key}]} in the first life"
    echo "${TEST_NAME}: ${step}: no tmux typing reached ${SEED_PANE[${key}]} in the latch life up to its event (positive control: ${ctl} send-keys in the first life)"
}

# relabel_quiet_rounds <step> <key>: from CALL_* (the leg's calls after its
# event) at index CALL_I, the rounds of `status` alone before its row was read
# missing, each at the cadence from PREV_US; advances CALL_I and PREV_US.
relabel_quiet_rounds() {
    local step="$1" key="$2" len="${#CALL_VERB[@]}"
    while (( CALL_I < len )) && [[ "${CALL_VERB[CALL_I]}" == status ]] \
        && { (( CALL_I + 1 == len )) || [[ "${CALL_VERB[CALL_I + 1]}" == status ]]; }; do
        (( CALL_POS[CALL_I] <= MISSING_MARK[${key}] )) \
            || fail "${step}: a round of status alone at shim line ${CALL_POS[CALL_I]}, after the row read missing"
        check_cadence "${step}: a round of status alone" "${PREV_US[${key}]}" "${CALL_US[CALL_I]}" "${CALL_US[CALL_I]}" "${CALL_NONE}"
        PREV_US[${key}]="${CALL_US[CALL_I]}"
        CALL_I=$(( CALL_I + 1 ))
    done
}

# relabel_retry_round <step> <key>: at CALL_I, the finished-row retry's
# round: one `status`, one `get`, then one `resume`, at the cadence, its
# status after the loop's first find-missing; advances CALL_I and PREV_US.
relabel_retry_round() {
    local step="$1" key="$2" i="${CALL_I}"
    if [[ "${CALL_VERB[i]:-}" != status || "${CALL_VERB[i + 1]:-}" != get || "${CALL_VERB[i + 2]:-}" != resume ]]; then
        calls_of "${key}" "${FREE_MARK[${key}]}"
        fail "${step}: the round after the row read missing is '${CALL_VERB[i]:-} ${CALL_VERB[i + 1]:-} ${CALL_VERB[i + 2]:-}', not status, get, resume"
    fi
    (( CALL_POS[i] > LOOP_FIRST_POS )) \
        || fail "${step}: the finished-row retry's status (shim line ${CALL_POS[i]}) is not after the loop's first find-missing (${LOOP_FIRST_POS})"
    check_cadence "${step}: the finished-row retry (get)" "${PREV_US[${key}]}" "${CALL_US[i]}" "${CALL_US[i + 1]}" get
    (( CALL_US[i + 2] - CALL_US[i] <= SETTLE_S * 1000000 )) \
        || fail "${step}: the finished-row retry's resume came $(secs_of $(( CALL_US[i + 2] - CALL_US[i] ))) s after its status, more than the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: the finished-row retry: status at shim line ${CALL_POS[i]}, get at ${CALL_POS[i + 1]}, resume at ${CALL_POS[i + 2]}"
    PREV_US[${key}]="${CALL_US[i]}"
    CALL_I=$(( i + 3 ))
}

# check_relabel_relatch: leg 1 (see the header): after its pane's respawn and
# the loop's mark, the round after the row read missing is one `status`, one
# `get`, then one `resume`, refused with "left over from an earlier life":
# the persona relatches (refused operation `resume`, row `missing`, the
# previous case named) with exactly one new post, the CONFLICT notice of the
# new case; each following round is one `status` then one `resume`, refused
# the same way, with no post; no recovery post at any point.
check_relabel_relatch() {
    local key="${R1_KEY}" step="part 2: ${R1_KEY}'s finished-row retry (leg 1)" id="${PERSONA_ID[${R1_KEY}]}" rows len f=0 n line
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}" "${FOLLOW_MARK}")" || exit 1
    load_calls "${rows}"
    len="${#CALL_VERB[@]}"
    CALL_I=0
    relabel_quiet_rounds "${step}" "${key}"
    relabel_retry_round "${step}" "${key}"
    while (( CALL_I < len )); do
        if [[ "${CALL_VERB[CALL_I]}" != status || "${CALL_VERB[CALL_I + 1]:-}" != resume ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: a round after the relatch is '${CALL_VERB[CALL_I]} ${CALL_VERB[CALL_I + 1]:-}', not status then resume"
        fi
        check_cadence "${step}: a round of the new case" "${PREV_US[${key}]}" "${CALL_US[CALL_I]}" "${CALL_US[CALL_I + 1]}" "${CALL_RESUME}"
        PREV_US[${key}]="${CALL_US[CALL_I]}"
        CALL_I=$(( CALL_I + 2 ))
        f=$(( f + 1 ))
    done
    (( f == FOLLOW_ROUNDS )) || fail "${step}: ${f} round(s) of the new case in the shim's log, not the ${FOLLOW_ROUNDS} round line(s)"
    expect_count "${RETRY_LINE}" 1 "${step}: the finished-row retry's round lines"
    line="$(fmk_text conflictLatchSetLine "${key}" "${CASE_LEFTOVER}" "${SESSION_OF[${key}]}" "${OP_RESUME}" missing "${CASE_NOT_THIS_LAUNCH}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    expect_count "${line}" 1 "${step}: the relatch's latch-set lines"
    wait_until "${NOTICE_WAIT_S}" "${step}: no new CONFLICT notice on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${FREE_POSTS[${key}]}" "${CONFLICT_HEAD}" 1
    check_conflict_notice "${step}" "${key}" "${CASE_LEFTOVER}" "${FREE_POSTS[${key}]}"
    n="$(posts_since "${key}" "${FREE_POSTS[${key}]}")" || exit 1
    (( n == 1 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the leg's event, not only the relatch's notice"
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}"
    (( ${#HOLDING[@]} == 0 )) || fail "${step}: ${#HOLDING[@]} recovery post(s) on ${PERSONA_CHANNEL[${key}]}"
    echo "${TEST_NAME}: ${step}: relatched with case ${CASE_LEFTOVER} and one new post; ${f} following round(s), each status then resume, with no post; no recovery post"
}

# check_relabel_clear: leg 2 (see the header): after the harness ended the
# session and the loop marked the row, the round after the row read missing
# is one `status`, one `get`, then one `resume`, which is not refused and
# launches: the clear (reason "its row finished and a relaunch was not
# refused"), the row `waiting`, and one recovery post, with no post between
# the latch's notice and it.
check_relabel_clear() {
    local key="${R2_KEY}" step="part 2: ${R2_KEY}'s finished-row retry (leg 2)" id="${PERSONA_ID[${R2_KEY}]}" rows
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}" "${ROUND_END_MARK[${key}]}")" || exit 1
    load_calls "${rows}"
    CALL_I=0
    relabel_quiet_rounds "${step}" "${key}"
    relabel_retry_round "${step}" "${key}"
    echo "${TEST_NAME}: ${step}: the calls after the resume (recorded): ${CALL_VERB[*]:CALL_I}"
    expect_count "$(matcher "${ROUND_END_HEAD[${key}]}" "cleared (")" 1 "${step}: the finished-row retry's round line"
    check_launched "${step}" "${key}" LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED
}

# check_launch_start: "launch start not recorded" (see the header): every
# round while the row reads `pending` is one `status`, at the cadence, with
# no post; once a store-wide find-missing has marked the row `missing`, the
# next round is one `status`, which clears the latch: one "Hold cleared"
# post (reason "its agent-director row reads missing"), and one bring-up
# retry by the restart path's decision, its first call within the settle of
# that status, with no CSCB find-missing between them. What the retry meets
# beside the still-running session, and any post after the recovery post,
# are logged, not asserted (ruling S8).
check_launch_start() {
    local key="${NS_KEY}" step="part 2: ${NS_KEY}'s rounds and clear" id="${PERSONA_ID[${NS_KEY}]}" rows k i len cleared line
    local fm pos us ppid role marked="" between head recovery n
    cleared="$(fmk_text latchClearedLine "${key}" "${CASE_LAUNCH_START}" "${SESSION_OF[${key}]}" posted latchRecoveryReasonRowReads missing)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    if ! _scenario_poll_until "${SETTLE_S}" _scenario_log_has "${cleared}"; then
        latch_lines_of "${key}"
        fail "${step}: no clear line '${cleared}'"
    fi
    expect_count "${cleared}" 1 "${step}: the clear line"
    line="$(fmk_text latchRecheckRoundLine "${PERSONA_NAME[${key}]}" "${CASE_LAUNCH_START}" "${STEP_TABLE}" "${CALL_NONE}" "cleared (${STEP_TABLE})")" \
        || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    expect_count "${line}" 1 "${step}: the clearing round's line"
    k="$(count_log "${STILL_LINE[${key}]}")"
    (( k >= MIN_LATCHED_ROUNDS )) || { latch_lines_of "${key}"; fail "${step}: ${k} still-latched round line(s), fewer than ${MIN_LATCHED_ROUNDS}"; }
    rows="$(ad_cscb_calls "${id}" "${LATCH_MARK[${key}]}")" || exit 1
    load_calls "${rows}"
    len="${#CALL_VERB[@]}"
    if (( len < k + 2 )); then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: ${len} CSCB call(s) of ${id} after its latch, fewer than ${k} still-latched rounds, the clearing round and its retry"
    fi
    PREV_US[${key}]="${LATCH_US[${key}]}"
    for (( i = 0; i < k; i++ )); do
        if [[ "${CALL_VERB[i]}" != status ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${CALL_VERB[i]} of ${id} at shim line ${CALL_POS[i]}, where a still-latched round's status belongs (each is status alone)"
        fi
        check_cadence "${step}: round $(( i + 1 ))" "${PREV_US[${key}]}" "${CALL_US[i]}" "${CALL_US[i]}" "${CALL_NONE}"
        PREV_US[${key}]="${CALL_US[i]}"
    done
    [[ "${CALL_VERB[k]}" == status ]] \
        || fail "${step}: the clearing round's first call of ${id} is ${CALL_VERB[k]} at shim line ${CALL_POS[k]}, not status"
    check_cadence "${step}: the clearing round (the retry's first call, ${CALL_VERB[k + 1]})" "${PREV_US[${key}]}" "${CALL_US[k]}" \
        "${CALL_US[k + 1]}" "${CALL_VERB[k + 1]}"
    between="$(ad_cscb_verb_between find-missing "${CALL_POS[k]}" "${CALL_POS[k + 1]}")" || exit 1
    [[ -z "${between}" ]] \
        || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the clearing round's status and the retry's first call"; }
    # The find-missing that marked the row: between the last still-latched
    # round's status and the clearing round's (whose run it was is recorded).
    fm="$(shim_verb_rows find-missing)" || exit 1
    while IFS=$'\t' read -r pos us ppid role; do
        [[ -n "${pos}" ]] || continue
        (( pos > CALL_POS[k - 1] && pos < CALL_POS[k] )) || continue
        if [[ "${ppid}" == "${FIND_MISSING_LOOP_PID:-}" ]]; then
            marked+="${marked:+, }shim line ${pos} (the harness's loop)"
        elif [[ "${role}" != - ]]; then
            marked+="${marked:+, }shim line ${pos} (CSCB's ${role})"
        else
            marked+="${marked:+, }shim line ${pos} (the harness)"
        fi
    done <<< "${fm}"
    [[ -n "${marked}" ]] || fail "${step}: no find-missing between the last still-latched round (shim line ${CALL_POS[k - 1]}) and the clearing round (${CALL_POS[k]})"
    echo "${TEST_NAME}: ${step}: ${k} still-latched round(s), each status alone; the row marked missing by the find-missing at ${marked}; the clearing round's status at shim line ${CALL_POS[k]}, the retry's first call ${CALL_VERB[k + 1]} at ${CALL_POS[k + 1]}"
    # One bring-up retry: one after-clear retry line.
    head="$(fmk_text latchClearRetryAtOnceLineHead "${PERSONA_NAME[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print latchClearRetryAtOnceLineHead"
    expect_count "${head}" 1 "${step}: the after-clear retry's lines"
    # One "Hold cleared" post, right after the latch's notice.
    recovery="$(fmk_text formatPersonaNotice "${PERSONA_NAME[${key}]}" holdRecoveryText latchRecoveryReasonRowReads missing)" \
        || fail "${step}: fmk-texts.ts could not print the hold recovery notice"
    posts_holding "${key}" "${POSTS_BEFORE[${key}]}" "${HOLD_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the hold recovery head, not one"
    posts_of "${key}" "${SCENARIO_ROOT}/posts-ns.bin"
    n=$(( POSTS_BEFORE[${key}] + 1 ))
    if [[ "${POSTS[n]:-}" != "${recovery}" ]]; then
        printf '  | post %d:  %q\n  | expected: %q\n' "${n}" "${POSTS[n]:-}" "${recovery}" >&2
        fail "${step}: the post after the latch's notice is not the printed hold recovery notice"
    fi
    echo "${TEST_NAME}: ${step}: one Hold cleared post (reason: its agent-director row reads missing), right after the notice"
    # Ruling S8: logged, not asserted.
    echo "${TEST_NAME}: ${step}: [S8, recorded] the retry's calls: $(for (( i = k + 1; i < len && CALL_US[i] - CALL_US[k] <= SETTLE_S * 1000000; i++ )); do printf '%s ' "${CALL_VERB[i]}"; done)"
    echo "${TEST_NAME}: ${step}: [S8, recorded] $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${head}" | sed 's/^.*\] //')"
    latch_lines_of "${key}" 2>&1 | sed "s/^/${TEST_NAME}: ${step}: [S8, recorded] /"
    for (( i = n + 1; i < ${#POSTS[@]}; i++ )); do
        echo "${TEST_NAME}: ${step}: [S8, recorded] a later post: ${POSTS[i]//$'\n'/ | }"
    done
    read_row "${step}" "${id}"
    echo "${TEST_NAME}: ${step}: [S8, recorded] ${id} now reads '${ROW_STATE}' in '${ROW_SESSION}'"
    ad_trail_events ad.find_missing.tick "${id}" | sed "s/^/${TEST_NAME}: ${step}: [recorded] trail: /" || true
}

# p2_relabel_checks: the legs' and the loop's checks, from the logs.
p2_relabel_checks() {
    local key
    check_loop_runs
    for key in "${P2_RELABEL_KEYS[@]}"; do
        check_nothing_typed "${key}"
        check_latched_rounds "${key}"
        check_retry_unwritten "${key}"
    done
    check_relabel_relatch
    check_relabel_clear
    check_launch_start
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

slack_labels=()
for key in "${P1_KEYS[@]}" "${P2_KEYS[@]}"; do
    slack_labels+=("${PERSONA_TOKEN[${key}]}")
done
start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${slack_labels[@]}"

# Part 1, before Part 2's first life: a global @ad_owner value is per tmux
# server (see "Parts" in the header).
p1_life1
p1_note
p1_latch_life
p1_ac43
p1_note_clear
p1_checks
p1_end

# Part 2.
p2_life1
p2_age_wait
p2_stop
p2_setup
p2_latch_life
p2_clearing_schedule
p2_relabel_rounds
p2_checks
p2_relabel_checks
stop_find_missing_loop

# A plain stop, then the closing assertions. The persona still latched keeps
# its row; every row is present.
stop_server
sed "s/^/${TEST_NAME}: end: stop said: /" "${STOP_OUT}"
for key in "${P2_KEYS[@]}"; do
    read_row "end" "${PERSONA_ID[${key}]}"
    [[ -n "${ROW_STATE}" ]] || fail "end: ${PERSONA_ID[${key}]} has no row at the end"
    echo "${TEST_NAME}: end: ${PERSONA_ID[${key}]} is present, reading ${ROW_STATE}"
done
# The unusable recorded name stayed latched to the end: its row still records
# the name, and no clear line names it (the clear line's head, cut from the
# package's latchClearedLine at its ` — `; positive control: its latch-set
# line is logged once).
read_row "end" "${PERSONA_ID[${UN_KEY}]}"
[[ "${ROW_SESSION}" == "${UNUSABLE_NAME}" ]] \
    || fail "end: the latched ${PERSONA_ID[${UN_KEY}]} records session '${ROW_SESSION}', not ${UNUSABLE_NAME}"
end_line="$(fmk_text latchClearedLine "${UN_KEY}" "${CASE_UNUSABLE}" "${UNUSABLE_NAME}" posted LATCH_RECOVERY_REASON_ROW_GONE)" \
    || fail "end: fmk-texts.ts could not print latchClearedLine"
end_line="${end_line%% — *}"
[[ "${end_line}" == *"=${UN_KEY} cleared" ]] || fail "end: the clear line's head '${end_line}' does not end with ${UN_KEY}'s clear"
n="$(count_log "${end_line} — ")"
(( n == 0 )) || { latch_lines_of "${UN_KEY}"; fail "end: ${UN_KEY}'s latch cleared"; }
end_line="$(fmk_text conflictLatchSetLine "${UN_KEY}" "${CASE_UNUSABLE}" "${UNUSABLE_NAME}" "${OP_NONE}" "${LATCH_ROW_OF[${UN_KEY}]}")" \
    || fail "end: fmk-texts.ts could not print conflictLatchSetLine"
expect_count "${end_line}" 1 "end: positive control: ${UN_KEY}'s latch-set lines"
n="$(count_log "${STILL_LINE[${UN_KEY}]}")"
echo "${TEST_NAME}: end: ${UN_KEY} stayed latched to the end, ${n} rounds of status alone"
# Leg 1 stayed latched to the end: no clear line names it, and no recovery
# post (positive control: its relatch's latch-set line is logged once).
end_line="$(fmk_text latchClearedLine "${R1_KEY}" "${CASE_LEFTOVER}" "${PERSONA_NAMED[${R1_KEY}]}" posted LATCH_RECOVERY_REASON_ROW_GONE)" \
    || fail "end: fmk-texts.ts could not print latchClearedLine"
end_line="${end_line%% — *}"
[[ "${end_line}" == *"=${R1_KEY} cleared" ]] || fail "end: the clear line's head '${end_line}' does not end with ${R1_KEY}'s clear"
n="$(count_log "${end_line} — ")"
(( n == 0 )) || { latch_lines_of "${R1_KEY}"; fail "end: ${R1_KEY}'s latch cleared"; }
end_line="$(fmk_text conflictLatchSetLine "${R1_KEY}" "${CASE_LEFTOVER}" "${PERSONA_NAMED[${R1_KEY}]}" "${OP_RESUME}" missing "${CASE_NOT_THIS_LAUNCH}")" \
    || fail "end: fmk-texts.ts could not print conflictLatchSetLine"
expect_count "${end_line}" 1 "end: positive control: ${R1_KEY}'s relatch's latch-set lines"
posts_holding "${R1_KEY}" "${POSTS_BEFORE[${R1_KEY}]}" "${RECOVERY_HEAD}"
(( ${#HOLDING[@]} == 0 )) || fail "end: ${#HOLDING[@]} recovery post(s) for ${R1_KEY}"
echo "${TEST_NAME}: end: ${R1_KEY} stayed latched to the end, with no recovery post"
# The counted launch-failure lines: none for any Part 2 persona but the
# "launch start not recorded" one, whose bring-up retry beside its
# still-running session is logged, not asserted (ruling S8).
end_keys=()
for key in "${P2_KEYS[@]}"; do
    [[ "${key}" == "${NS_KEY}" ]] || end_keys+=("${key}")
done
no_counted_failures "end" "${end_keys[@]}"
for frag in "${LAUNCH_FAILED_LINES[@]}"; do
    echo "${TEST_NAME}: end: [S8, recorded] ${NS_KEY}'s counted launch-failure lines '${frag}${NS_KEY}': $(count_log "${frag}${NS_KEY}")"
done
# No delete at all in the shim's log (positive control: the same reader
# finds the scenario's `status` calls).
end_rows="$(shim_verb_lines delete)" || exit 1
n="$(rows_count "${end_rows}")"
(( n == 0 )) || { sed 's/^/  | /' <<< "${end_rows}" >&2; fail "end: ${n} delete call(s) in the agent-director shim's log"; }
end_rows="$(shim_verb_lines status)" || exit 1
n="$(rows_count "${end_rows}")"
(( n > 0 )) || fail "end: positive control: shim_verb_lines finds no status call in the agent-director shim's log"
stop_tracked_pid "${SLACK_STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
