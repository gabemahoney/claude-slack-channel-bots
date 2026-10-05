#!/usr/bin/env bash
# Test 16 (HO §7 scenarios 4 and 19; b.jg5 SRJ-1405, SRJ-1420, SRJ-504,
# SRJ-505, SRJ-506, SRJ-507, SRJ-713, SRJ-1004, SRJ-1005, SRJ-1401; AC 2,
# AC 7, AC 45): a session holding a persona's name latches it.
#
# Scenario 4: a session with no label, made by hand, holds the name of
# persona `nolabel`, whose row is finished. The bring-up's `resume` gets
# CONFLICT "no valid instance id" naming that session; the persona latches
# with one post that points to "Operator actions" and names no command;
# nothing is killed or deleted. Each re-check, one interval apart, reads the
# row (`status`, `ended` or `missing`) and only then retries the `resume`,
# which agent-director refuses again before its move, writing nothing, and
# nothing is posted. Once the harness ends the session, the next re-check's
# `resume` launches, the persona reaches `waiting` and one recovery post
# follows.
#
# Scenario 19: a session holds the name of a persona with no row, or with a
# `pending` row, and each variant latches with one post and is retried at the
# cadence with exactly the call its row state allows, until the harness ends
# the session and one recovery post follows; CSCB never kills:
#   - the scan refusal (persona `scanleft`): a leftover labelled with an
#     earlier launch of the id; the plain spawn's pre-spawn scan refuses it
#     and writes no row; rounds are `status` (no row) then the plain spawn;
#     the persona stays latched through phase 4, and phase 5's restart
#     relatches it with one post before the harness ends the leftover;
#   - the environment-only session (`envonly`): "no valid instance id" at
#     "duplicate session", the new row `ended`; rounds are `status` then a
#     spawn with `--reuse-finished`;
#   - another store's session (`otherstore`): "another agent-director
#     store" at "duplicate session", the new row `ended`; the post's
#     must-not-be-ended, pointer, list and human-only lines; reuse rounds;
#   - a `pending` row beside a leftover (`pendleft`), seeded as a spawn whose
#     process stopped before its create (so with no claude_session_id):
#     CSCB's own pending-row runs mark the row `missing` (`tmux_name_held`);
#     the restart path's reuse spawn is refused as "left over from an earlier
#     life"; rounds are `status` then a spawn with `--reuse-finished`.
#
# The script is built in five phases, each a function below, every
# scenario's personas joining the same phases:
#   1. first life, for the personas that need a row (`nolabel`, `pendleft`);
#   2. `stop --stop-bots`, each persona's row left as its leg needs it;
#   3. harness seeding, with the server stopped;
#   4. second life, with every persona configured, in a state dir of its own
#      (`new_state_dir`: a start runs its state dir's last-applied record,
#      and this life adds scenario 19's personas): latches, rounds and the
#      harness's clears (every one but the scan refusal's);
#   5. the restart leg: a plain `stop`, a start, the scan refusal's relatch
#      and its clear.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`, in `dev-channels` (no selection, the default) in
#   every persona's working directory: it prints the dev-channels dialog and
#   reports in only on Enter (CSCB's approver);
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record with `slack_posts`, on
#   each persona's own channel, PERSONA_CHANNEL), `health_check_interval` 0,
#   `session_restart_delay` at its default.
# The harness runs no `find-missing` anywhere in this script (SRJ-1401).
# Persona keys must not prefix one another (CSCB rejects that).
#
# Scenario 4's leg (persona `nolabel`, key `nolabel`). Steps marked
# [harness] are the harness playing a human from the scenario's own shell;
# no CSCB process makes them.
#   Phase 1. The live start spawns `nolabel` fresh; the approver clears the
#      dialog; a harness `get` reads the row `waiting`; its
#      claude_session_id and tmux session name are recorded.
#   Phase 2. [harness] The human ends `nolabel`'s worker as a human ends
#      Claude Code: the stub's exit line typed into its pane with the real
#      tmux (`__CSCB_TEST_EXIT__`, the stub's `/exit`, fixtures/stub-claude.sh),
#      which fires the worker's SessionEnd hooks, so agent-director itself
#      marks the row `ended`, and the worker's session ends with it. This is
#      how the row is left finished: a harness `kill` changes no row's state
#      in agent-director 0.11.0, the teardown's `kill` ends the stub with no
#      SessionEnd (the stub ignores the `/exit` that `pause` types), so a row
#      ended that way keeps reading `waiting`, and the harness runs no
#      `find-missing`; `ad_store_mark_finished` needs the worker's session
#      still there. The server's disconnect handler arms its restart after
#      `session_restart_delay` (60 s); `stop --stop-bots` follows at once and
#      stops the server first, and a check below shows no CSCB `resume` or
#      `spawn` of the row between the exit and the second life. Then
#      `stop --stop-bots`; a harness `get` reads the row `ended` or
#      `missing`, with the same claude_session_id, and its session is gone.
#   Phase 3. [harness] With the server stopped, a session with no label and
#      no @ad_pane, named as the row records (`slack_bot_<key>`), its pane
#      running `sleep` (`seed_unlabelled`). The row still reads finished.
#   Phase 4. The live start:
#      - the bring-up's one `resume` of `nolabel`'s row (parent: the bot
#        server; its earlier calls, a `spawn` that meets the finished row
#        among them, are recorded, not asserted) is refused: server.log
#        holds the latch-set line for case
#        `no-valid-id`, the session, refused operation `resume` and the
#        state read (`conflictLatchSetLine`, followed by agent-director's
#        description), once;
#      - exactly one post on its channel holds the CONFLICT notice head, and
#        its lines, in SRJ-1004's order, are: the persona prefix and the
#        first line for that case quoting the session; the description line
#        (head and tail as printed, holding agent-director's "no valid
#        instance id" phrase and the session name); the pointer line; the
#        list line; the human-only line. Every line but the description
#        line equals the printed line, so the post names no command;
#      - the harness reads the row's state and row_version (the store,
#        read-only) right after the latch;
#      - REFUSED_ROUNDS (2) re-check rounds: `persona_rounds` reads the
#        persona's CSCB calls after the latch, which must be exactly one
#        `status` then one `resume` per round, no `read-pane` and no other
#        call; the first round's `status` comes at least one interval
#        (LATCH_RECHECK_INTERVAL_MS) after the refused bring-up `resume` and
#        within the interval plus SETTLE_S, each next round's at least one
#        interval after the previous round's and within the interval plus
#        SETTLE_S, and each round's `resume` within SETTLE_S of its
#        `status`; after each, the round line (`latchRecheckRoundLine`, step
#        `step-2`, call `resume`, answer `still-latched`) is logged, the row
#        reads the same state and row_version, the seeded session is still
#        there with the same id, and the channel holds no new post;
#      - [harness] the human ends the seeded session by its session id
#        (`end_session`);
#      - the next round: its first two calls are one `status` then one
#        `resume`, at the cadence, with no CSCB `find-missing` between them
#        (`ad_cscb_verb_between`); the `resume` launches: the latch clears
#        (`latchClearedLine`, reason "a retry of the refused operation was
#        not refused", posted), the approver clears the dialog and the row
#        reads `waiting` with the first life's claude_session_id; the server
#        registers the stub's MCP session; exactly one post holds the
#        recovery head, and it equals the printed recovery notice
#        (`conflictRecoveryText`, reason LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED);
#      - no CSCB `kill`, `kill-finished` or `delete` names `nolabel`'s row
#        in the second life; no tmux command CSCB caused reads from, types
#        into, kills or respawns the seeded session (by its session id, pane
#        id or name) up to the harness's end of it (`tmux_shim_targets`;
#        tmux numbers sessions and panes from $0 and %0 again once its
#        server, left with no session, exits and a new one starts); positive
#        control: such commands act on the resumed session after it.
#
# Scenario 19's legs (personas `scanleft`, `envonly`, `otherstore` and
# `pendleft`, keys the same). Each seeded session is named as the package
# names the persona's launches (`personaTmuxSessionName`, `slack_bot_<key>`),
# made in the persona's working directory, its pane running `sleep`, and
# follows the seeding rules (lib/scenario.sh): every `@ad_owner` label ends
# with the scenario store's id (`ad_store_id`) except the other-store
# variant's (`ad_other_store_id`), and every seeded leftover's worker pane
# carries `@ad_pane` (its label's token and its pane id).
#   Phase 1. `pendleft` joins `nolabel`'s first life (its statement in phase 3
#      edits that row): spawned fresh, the approver clears the dialog, a
#      harness `get` reads `waiting`; its claude_session_id and session name
#      (which must be `personaTmuxSessionName`'s) are recorded.
#   Phase 2. `stop --stop-bots`'s teardown ends `pendleft`'s worker: its
#      session is gone within EXIT_WAIT_S; a harness `get` reads the row with
#      its first life's claude_session_id (its state is recorded, not
#      asserted: 0.11.0's `kill` changes no row's state).
#   Phase 3. [harness] With the server stopped, in this order:
#      - `scanleft`: `seed_leftover` (a label naming an earlier launch of
#        `cscb_scanleft` with this store's id, `@ad_pane` on its pane); the
#        store holds no row for the id;
#      - `envonly`: `seed_env_only` (only `AGENT_DIRECTOR_INSTANCE_ID=
#        cscb_envonly` in its tmux environment, no label); no row;
#      - `otherstore`: `seed_other_store` (a leftover-style label naming
#        `cscb_otherstore`, ending with another 16-hex store id); no row;
#      - `pendleft`: `seed_leftover`, then E39's scenario 19 statement
#        (`ad_store_seed_pending`, given the leftover's token): the row reads
#        `pending` with a launch start (recorded, PEND_LAUNCH_MS) and a launch
#        token other than the leftover's, and still holds its first life's
#        claude_session_id; then one script-local `ad_store_edit` UPDATE
#        (s19_pend_no_session) clears that claude_session_id, since the
#        seeded launch is a spawn whose process stopped before its create and
#        so recorded no Claude session (b.jg5 SRJ-1420): claude_session_id
#        NULL and row_version + 1, named by its id, its `pending` state and
#        its row_version as read just before; a store read after it shows
#        every other column as the seed set it.
#   Phase 4, in run order (scenario 4's latch checks come first):
#      - each of `scanleft`, `envonly` and `otherstore` latches at the
#        bring-up (s19_latch): the latch-set line (`conflictLatchSetLine`: case
#        `leftover`, `no-valid-id` and `another-store`, refused operation
#        `plain-spawn`, recorded state `no-row`, `ended` and `ended`) is
#        waited for within START_WAIT_S and logged once; the shim mark is then
#        taken; the bot server's one refused plain spawn (a `spawn` with no
#        `--reuse-finished`) lies between the second life's start and that
#        mark (the other calls are recorded, not asserted), with no CSCB
#        `kill` of the id; exactly one post on the persona's channel since the
#        second life began, the CONFLICT notice, whose lines are, in
#        SRJ-1004's order, the persona prefix and the case's first line
#        quoting the session; the description line (holding the case phrase
#        and the session name); for `otherstore` the another-store
#        must-not-be-ended line; the pointer line; the list line for the
#        session name; the human-only line, every line but the description
#        line equal to the printed line, so no command is named; the harness
#        reads the row (for `scanleft` the store holds none; the others read
#        `ended`, their row_version recorded); the seeded session is still
#        there. For `scanleft` the session name and tmux id come from the
#        trail (s19_scan_trail), never from the capped post: its
#        `ad.launch.name_held` records with row_result `not_inserted` (source
#        `ad_spawn`, launch `spawn`) number CSCB's `spawn` calls of the id
#        since the second life began (one here), each naming the session name
#        and the seeded leftover's tmux id;
#      - `pendleft`'s row is marked `missing` by CSCB's own pending-row runs
#        (s19_pending_marked): the retry timer the start pass armed for the
#        covered `pending` row runs 30, 90 and 210 s after the arm, and from
#        G (pending_grace_seconds, 60 s at the defaults, `adGraceMs`) after
#        the launch start a retry makes its lap (the leftover's pane, carrying
#        `@ad_pane`, is read) and its `find-missing` run. Bound: the
#        `ad.find_missing.tick` record (reconciliation_reason
#        `tmux_name_held`, prior state `pending`, the session name) is waited
#        for until B (`adLaunchBoundMs`, 300 s) plus SETTLE_S after the launch
#        start, and its `ts` lies no earlier than G and no later than that
#        bound after it; one `ad.launch.name_held` record from
#        `ad_find_missing` (row_result `marked_missing`) names the leftover's
#        session name and tmux id (the session the latch quotes is read from
#        it); a CSCB `find-missing` call started at or before the mark; no
#        `find-missing` call in the whole shim log has a parent other than a
#        CSCB process (the harness runs none); no CSCB `kill` of the id;
#      - `pendleft` then latches (s19_latch, waited for within SETTLE_S): the
#        restart path's launch on the `missing` row with no claude_session_id
#        is one reuse spawn (a `spawn` carrying `--reuse-finished`, read from
#        the shim's argv; a `resume` before it, which agent-director answers
#        `ErrNoSessionId`, and the server's line for it, the no-transcript
#        step's (SRJ-707), are recorded, not asserted), refused as "left over
#        from an earlier life": case
#        `leftover`, refused operation `reuse-spawn`, state `missing`; one
#        post, the CONFLICT notice; the store reads `missing`;
#      - scenario 4's refused rounds;
#      - the refused rounds (s19_rounds): two each for `scanleft`, `envonly`
#        and `otherstore`, at least one for `pendleft` (each next round line
#        waited for within the interval plus twice SETTLE_S). `latch_rounds`
#        reads the persona's CSCB calls after the latch mark: exactly one
#        `status` then one call per round, and no other call: for `scanleft`
#        the plain spawn (round line step `spawn-retry`, call `plain-spawn`:
#        the `status` found no row), for `envonly` and `otherstore` a `spawn`
#        carrying `--reuse-finished` (read from the shim's argv; step
#        `step-2`, call `reuse-spawn`), for `pendleft` the same reuse spawn
#        (step `step-2`, call `reuse-spawn`, after a `status` reading
#        `missing`); every round line answers `still-latched`;
#        cadence as scenario 4's (`check_cadence`, the first round from the
#        refused launch); the store still holds no row for `scanleft`, whose
#        not_inserted records still number its spawns, and the others' rows
#        keep their state and row_version; the seeded session is still there;
#        no post beyond the CONFLICT notice;
#      - [harness] the human ends `envonly`'s, `otherstore`'s and
#        `pendleft`'s seeded sessions by their session ids (`end_session`);
#        then scenario 4's clear, whose `end_session` ends `nolabel`'s;
#      - each of the three clears (s19_clear): the next round line, waited
#        for within the interval plus twice SETTLE_S; that round's first two
#        calls are one `status` then the round's call, at the cadence, with no
#        CSCB `find-missing` between them; the call launches: the clear line
#        (`latchClearedLine`, reason "a retry of the refused operation was not
#        refused", posted) within SETTLE_S, once; the row reads `waiting`
#        within REPORT_WAIT_S, on its session name (`pendleft`'s on a fresh
#        claude_session_id, not its first life's); the server registers the
#        stub's MCP
#        session; exactly one post holds the recovery head, equal to the
#        printed recovery notice; the channel holds only the CONFLICT notice
#        and that post;
#      - `scanleft` stays latched: s19_rounds again, with three rounds, all
#        refused plain spawns;
#      - scenario 4's no-kill checks; no CSCB `kill`, `kill-finished` or
#        `delete` names a scenario 19 persona's id in the second life.
#   Phase 5, the restart leg (SRJ-504; E13): with `scanleft` latched, a plain
#      `stop` (the bots keep running; the leftover is still there), then a
#      live start, its start pass waited for within START_WAIT_S:
#      - `scanleft` relatches at the bring-up's plain spawn (s19_latch over
#        the new server's calls: the latch-set line now logged twice; one
#        refused plain spawn by the new server; exactly one new post, the
#        CONFLICT notice, as in phase 4; the store holds no row; the
#        not_inserted records number all its spawns);
#      - [harness] the human ends the leftover by its session id; the next
#        round's plain spawn launches and the latch clears (s19_clear: one
#        `status`, then the plain spawn, with no CSCB `find-missing` between
#        them; the persona starts fresh and reaches `waiting`; one recovery
#        post; the launching spawn wrote no not_inserted record);
#      - no other persona got a post or a conflict-latch line since the
#        restart; no CSCB `kill`, `kill-finished` or `delete` of a scenario
#        19 persona's id; no `find-missing` call from a process other than
#        CSCB's.
#   Then [harness] the human ends every persona's worker with the stub's
#   exit line, as in phase 2 (each row reads `ended` or `missing` and its
#   session is gone within EXIT_WAIT_S), so the closing `stop --stop-bots`
#   pauses no live stub (each such pause waits out its 30 s timeout, one
#   persona after another); then `stop --stop-bots`, and every persona's row
#   is present at the end (`nolabel`'s with its first life's
#   claude_session_id, `pendleft`'s with the one its reuse started).
#
# Waits and their derivation (seconds): STUB_WAIT_S (20) for the Slack
# stub's ready file; START_WAIT_S (120) per start pass (one bring-up, one
# launch call); REPORT_WAIT_S (60) for the approver's Enter (it reads the
# pane every lap, about 1 s apart) and the stub's report-in; CONNECT_WAIT_S
# (30) for the server to register the stub's MCP session; EXIT_WAIT_S (30)
# for the stub's SessionEnd hooks and its session's end after the exit
# line, and for a teardown's end of a session; NOTICE_WAIT_S (30) for a post
# after the line that causes it. The re-check interval is
# fixtures/fmk-texts.ts's LATCH_RECHECK_INTERVAL_MS (120 s). SETTLE_S (30) is
# the stated settle: a round's own calls (one `status` and one launch call,
# each one agent-director process, a few seconds at most), the timer's start
# after the previous round settled, and the shim's process start. The
# cadence checks hold each round's `status` to the interval plus SETTLE_S;
# each round's server-log line, written once the round settled, is waited
# for within the interval plus twice SETTLE_S from the previous round's
# checks (n times that for n rounds); a clear line within SETTLE_S of its
# round line. `pendleft`'s mark is bounded by B plus SETTLE_S from its launch
# start, as above, and its latch, made in the same retry, by SETTLE_S after
# that. Expected runtime: about 9 minutes (phases 1 to 3 under a minute,
# phase 4's rounds about 6 minutes, phase 5's relatch and clear about 2).
#
# Matched values. CSCB's values come from fixtures/fmk-texts.ts, printed from
# the installed package, never retyped:
# - personaInstanceId and personaTmuxSessionName (src/persona-identity.ts),
#   personaNoticePrefix and formatPersonaNotice (src/persona-notifier.ts);
# - from src/conflict-latch.ts: LATCH_CASE_NO_VALID_ID, LATCH_CASE_LEFTOVER,
#   LATCH_CASE_ANOTHER_STORE, REFUSED_OPERATION_RESUME,
#   REFUSED_OPERATION_PLAIN_SPAWN, REFUSED_OPERATION_REUSE_SPAWN,
#   LATCH_ROW_STATE_KIND_NO_ROW,
#   LATCH_RECHECK_INTERVAL_MS, RECHECK_STEP_TABLE, RECHECK_STEP_SPAWN_RETRY,
#   RECHECK_CALL_RESUME, RECHECK_CALL_PLAIN_SPAWN, RECHECK_CALL_REUSE_SPAWN,
#   CONFLICT_NOTICE_FIRST_LINE_HEAD, CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD and
#   _TAIL, CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
#   CONFLICT_NOTICE_POINTER_LINE, CONFLICT_NOTICE_HUMAN_ONLY_LINE,
#   CONFLICT_NOTICE_LINE_SEPARATOR, CONFLICT_RECOVERY_HEAD, and the builders
#   conflictNoticeFirstLine, conflictNoticeListLine, conflictRecoveryText,
#   conflictLatchSetLine (also, cut at a placeholder session or at its
#   `latched`, the fragments a latch line is waited for or counted by),
#   latchClearedLine and latchRecheckRoundLine;
# - CONFLICT_NO_VALID_ID_PHRASE, CONFLICT_LEFTOVER_PHRASE and
#   CONFLICT_ANOTHER_STORE_PHRASE (src/ad-description-phrases.ts);
# - G and B at agent-director's default settings, `adGraceMs` and
#   `adLaunchBoundMs` (src/ad-settings.ts).
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - the round answer `still-latched` (src/session-manager.ts
#   runLatchRecheckRound's answerAfter, for a retry that left the persona
#   latched);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef);
# - `--reuse-finished`, the agent-director client's flag for a spawn's
#   reuse_finished (the agent-director 0.11.0 npm client);
# - agent-director's trail values (agent-director 0.11.0): the events
#   `ad.launch.name_held` and `ad.find_missing.tick`, the sources `ad_spawn`
#   and `ad_find_missing`, the row results `not_inserted` and
#   `marked_missing`, the reason `tmux_name_held`
#   (pkg/api/name_held_trail.go, pkg/api/find_missing.go,
#   pkg/api/find_missing_writes.go); its row states `pending`, `ended`,
#   `missing` and `waiting`.
#
# Closing: the script ends with `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell. Every count of CSCB's agent-director calls reads only shim lines
# whose parent is a CSCB process; no step reads a pane's text.
set -euo pipefail

TEST_NAME="test-16-fmk-conflict"
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

# Scenario 4's refused rounds before the harness ends the session.
REFUSED_ROUNDS=2

FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Personas: one table entry per persona, by key
# ---------------------------------------------------------------------------

# Scenario 4's persona.
S4_NAME="nolabel"
S4_KEY="$(persona_key "${S4_NAME}")"

# Scenario 19's personas, one per variant: the scan refusal (with the
# restart leg), the environment-only session, another store's session and the
# `pending` row beside a leftover.
SCAN_NAME="scanleft"
SCAN_KEY="$(persona_key "${SCAN_NAME}")"
ENV_NAME="envonly"
ENV_KEY="$(persona_key "${ENV_NAME}")"
STORE_NAME="otherstore"
STORE_KEY="$(persona_key "${STORE_NAME}")"
PEND_NAME="pendleft"
PEND_KEY="$(persona_key "${PEND_NAME}")"

declare -A PERSONA_NAME=([${S4_KEY}]="${S4_NAME}" [${SCAN_KEY}]="${SCAN_NAME}" [${ENV_KEY}]="${ENV_NAME}"
    [${STORE_KEY}]="${STORE_NAME}" [${PEND_KEY}]="${PEND_NAME}")
# The post reader's channel table: each persona's one channel, which is also
# where its permission prompts and notices go.
declare -A PERSONA_CHANNEL=([${S4_KEY}]="C0T16NL01" [${SCAN_KEY}]="C0T16SL01" [${ENV_KEY}]="C0T16EO01"
    [${STORE_KEY}]="C0T16OS01" [${PEND_KEY}]="C0T16PL01")
# The Slack token label of each persona's fake token pair.
declare -A PERSONA_TOKEN=([${S4_KEY}]="t16nolabel" [${SCAN_KEY}]="t16scanleft" [${ENV_KEY}]="t16envonly"
    [${STORE_KEY}]="t16otherstore" [${PEND_KEY}]="t16pendleft")
# Filled in by the phases. PERSONA_NAMED is the session name the package
# gives the persona's launches (personaTmuxSessionName).
declare -A PERSONA_ID=() PERSONA_WORK=() PERSONA_CREDS=() PERSONA_SID=() PERSONA_SESSION=() PERSONA_NAMED=()

# The personas of the first life, and of the second (every persona). Of
# scenario 19's, only the `pending` variant has a first life: its statement
# edits the row that life leaves.
LIFE1_KEYS=("${S4_KEY}" "${PEND_KEY}")
LIFE2_KEYS=("${S4_KEY}" "${SCAN_KEY}" "${ENV_KEY}" "${STORE_KEY}" "${PEND_KEY}")
# Scenario 19's personas, in run order.
S19_KEYS=("${SCAN_KEY}" "${ENV_KEY}" "${STORE_KEY}" "${PEND_KEY}")

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

# server_rows <pid> <rows>: print the rows whose ppid (field 3) is <pid>.
server_rows() {
    [[ -z "$2" ]] || awk -F'\t' -v p="$1" '$3 == p' <<< "$2"
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
# instance id from the package.
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

# persona_rounds <step> <instance-id> <from-mark> [<to-mark>]: the re-check
# rounds of a persona latched on a `resume`, from E42 T1's reader
# (`ad_cscb_calls`): its CSCB-parented calls after <from-mark> (up to
# <to-mark>) must be, in log order, one `status` then one `resume` per
# round, and no other call; fails otherwise, and on a `status` with no
# `resume` after it. Prints one line per round,
# `<status-pos> <status-us> <resume-pos> <resume-us>`.
persona_rounds() {
    local step="$1" id="$2" from="$3" to="${4:--}" rows pos time verb us want=status s_pos="" s_us=""
    rows="$(ad_cscb_calls "${id}" "${from}" "${to}")"
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _; do
        if [[ "${verb}" != "${want}" ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${verb} of ${id} at shim line ${pos}, where a round's ${want} belongs (a round is one status then one resume, and nothing else)"
        fi
        us="$(us_of "${time}")"
        if [[ "${verb}" == status ]]; then
            s_pos="${pos}"
            s_us="${us}"
            want=resume
        else
            printf '%s %s %s %s\n' "${s_pos}" "${s_us}" "${pos}" "${us}"
            want=status
        fi
    done <<< "${rows}"
    [[ "${want}" == status ]] || fail "${step}: the status of ${id} at shim line ${s_pos} has no resume after it"
}

# check_cadence <step> <previous-us> <status-us> <call-us> [<call>]: fail
# unless the round's status comes at least one interval after <previous-us>
# and within the interval plus SETTLE_S, and its call (<call>, default
# `resume`) within SETTLE_S of its status.
check_cadence() {
    local step="$1" gap call="${5:-resume}"
    gap=$(( $3 - $2 ))
    (( gap >= INTERVAL_US )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, less than the ${INTERVAL_S} s interval"
    (( gap <= INTERVAL_US + SETTLE_S * 1000000 )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, more than the ${INTERVAL_S} s interval plus the ${SETTLE_S} s settle"
    (( $4 - $3 <= SETTLE_S * 1000000 )) \
        || fail "${step}: the round's ${call} came $(secs_of $(( $4 - $3 ))) s after its status, more than the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: status $(secs_of "${gap}") s after the previous point, ${call} $(secs_of $(( $4 - $3 ))) s after it"
}

# round_call_is <call> <verb> <args>: true when a CSCB call of <verb> with
# the arguments <args> (a reader row's `printf %q`-quoted words) is the
# re-check call <call> (RECHECK_CALL_RESUME: a `resume`;
# RECHECK_CALL_PLAIN_SPAWN: a `spawn` with no `--reuse-finished`;
# RECHECK_CALL_REUSE_SPAWN: a `spawn` carrying `--reuse-finished`, read from
# the agent-director shim's argv).
round_call_is() {
    case "$1" in
        "${CALL_RESUME}") [[ "$2" == resume ]] ;;
        "${CALL_PLAIN_SPAWN}") [[ "$2" == spawn && " $3 " != *" --reuse-finished "* ]] ;;
        "${CALL_REUSE_SPAWN}") [[ "$2" == spawn && " $3 " == *" --reuse-finished "* ]] ;;
        *) fail "round_call_is: '$1' is not a re-check call this script reads" ;;
    esac
}

# latch_rounds <step> <instance-id> <call> <from-mark> [<to-mark>]: the
# re-check rounds of a persona latched with the re-check call <call> (as
# round_call_is reads it), from E42 T1's reader (`ad_cscb_calls`): its
# CSCB-parented calls after <from-mark> (up to <to-mark>) must be, in log
# order, one `status` then one <call> per round, and no other call; fails
# otherwise, and on a `status` with no <call> after it. Prints one line per
# round, `<status-pos> <status-us> <call-pos> <call-us>`.
latch_rounds() {
    local step="$1" id="$2" call="$3" from="$4" to="${5:--}" rows pos time verb args want=status s_pos="" s_us=""
    rows="$(ad_cscb_calls "${id}" "${from}" "${to}")"
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _ args; do
        if [[ "${want}" == status && "${verb}" == status ]]; then
            s_pos="${pos}"
            s_us="$(us_of "${time}")"
            want="${call}"
        elif [[ "${want}" == "${call}" ]] && round_call_is "${call}" "${verb}" "${args}"; then
            printf '%s %s %s %s\n' "${s_pos}" "${s_us}" "${pos}" "$(us_of "${time}")"
            want=status
        else
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${verb} of ${id} at shim line ${pos}, where a round's ${want} belongs (a round is one status then one ${call}, and nothing else)"
        fi
    done <<< "${rows}"
    [[ "${want}" == status ]] || fail "${step}: the status of ${id} at shim line ${s_pos} has no ${call} after it"
}

# store_rows_of <step> <instance-id>: print how many rows the store holds
# with <instance-id> (the harness's read-only store read, both guards first).
store_rows_of() {
    _scenario_store_read "$1" "SELECT COUNT(*) FROM spawns WHERE claude_instance_id = '$2'"
}

# name_held_records <instance-id> <source> <row-result>: print the trail's
# ad.launch.name_held records of <instance-id> (`ad_trail_events`) whose
# source and row_result are the given ones, one JSON object per line.
name_held_records() {
    local out
    out="$(ad_trail_events ad.launch.name_held "$1")" || exit 1
    [[ -z "${out}" ]] || jq -c --arg s "$2" --arg r "$3" 'select(.source == $s and .row_result == $r)' <<< "${out}"
}

# name_held_tmux_marks <instance-id>: print the trail's ad.find_missing.tick
# records of <instance-id> that marked its row `missing` with reason
# `tmux_name_held`, one JSON object per line.
name_held_tmux_marks() {
    local out
    out="$(ad_trail_events ad.find_missing.tick "$1")" || exit 1
    [[ -z "${out}" ]] \
        || jq -c 'select(.reconciliation_reason == "tmux_name_held" and .new_state == "missing")' <<< "${out}"
}

# has_name_held_tmux_mark <instance-id>: true once such a record exists.
has_name_held_tmux_mark() {
    [[ -n "$(name_held_tmux_marks "$1")" ]]
}

# non_cscb_find_missing: print the agent-director shim's `find-missing` call
# lines whose parent is no CSCB process (the harness's, or any other's), over
# the whole log, with lib/scenario.sh's line readers.
non_cscb_find_missing() {
    local lines=() i
    _scenario_query_prep non_cscb_find_missing
    _scenario_read_log non_cscb_find_missing "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        if _scenario_role_at "${_L_PPID}" "${_L_US}"; then
            continue
        fi
        _scenario_decode_words
        _scenario_ad_verb
        if [[ "${_L_VERB}" == find-missing ]]; then
            printf '%s\n' "${lines[i]}"
        fi
    done
    return 0
}

# latch_lines_of <key>: print persona <key>'s conflict-latch server-log lines
# (its latch, clear and round lines), indented, on stderr (for a failure's
# diagnosis).
latch_lines_of() {
    grep -F -e "conflict-latch: persona=$1 " -e "conflict-latch: re-check of $(persona_ref "${PERSONA_NAME[$1]}")" \
        "${SLACK_STATE_DIR}/server.log" | sed 's/^/  | /' >&2 || true
}

# now_ms: the time now, in milliseconds since the epoch.
now_ms() {
    date +%s%3N
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

INTERVAL_MS="$(fmk_text LATCH_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print LATCH_RECHECK_INTERVAL_MS"
[[ "${INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: LATCH_RECHECK_INTERVAL_MS is '${INTERVAL_MS}'"
INTERVAL_US=$(( INTERVAL_MS * 1000 ))
INTERVAL_S=$(( (INTERVAL_MS + 999) / 1000 ))
CASE_NO_VALID_ID="$(fmk_text LATCH_CASE_NO_VALID_ID)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_NO_VALID_ID"
OP_RESUME="$(fmk_text REFUSED_OPERATION_RESUME)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_RESUME"
STEP_TABLE="$(fmk_text RECHECK_STEP_TABLE)" || fail "setup: fmk-texts.ts could not print RECHECK_STEP_TABLE"
CALL_RESUME="$(fmk_text RECHECK_CALL_RESUME)" || fail "setup: fmk-texts.ts could not print RECHECK_CALL_RESUME"
NO_VALID_ID_PHRASE="$(fmk_text CONFLICT_NO_VALID_ID_PHRASE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NO_VALID_ID_PHRASE"
CONFLICT_HEAD="$(fmk_text CONFLICT_NOTICE_FIRST_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_FIRST_LINE_HEAD"
DESC_HEAD="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD"
DESC_TAIL="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL"
POINTER_LINE="$(fmk_text CONFLICT_NOTICE_POINTER_LINE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_POINTER_LINE"
HUMAN_LINE="$(fmk_text CONFLICT_NOTICE_HUMAN_ONLY_LINE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_HUMAN_ONLY_LINE"
RECOVERY_HEAD="$(fmk_text CONFLICT_RECOVERY_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_RECOVERY_HEAD"
NOTICE_SEP="$(fmk_text CONFLICT_NOTICE_LINE_SEPARATOR && printf x)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_LINE_SEPARATOR"
NOTICE_SEP="${NOTICE_SEP%x}"
[[ -n "${NOTICE_SEP}" && -n "${CONFLICT_HEAD}" && -n "${POINTER_LINE}" && -n "${HUMAN_LINE}" && -n "${RECOVERY_HEAD}" ]] \
    || fail "setup: fmk-texts.ts printed an empty notice part"
(( INTERVAL_S > SETTLE_S )) || fail "setup: the ${SETTLE_S} s settle is not shorter than the ${INTERVAL_S} s re-check interval"
echo "${TEST_NAME}: re-check interval ${INTERVAL_MS} ms, settle ${SETTLE_S} s"

# Scenario 19's values.
CASE_LEFTOVER="$(fmk_text LATCH_CASE_LEFTOVER)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_LEFTOVER"
CASE_ANOTHER_STORE="$(fmk_text LATCH_CASE_ANOTHER_STORE)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_ANOTHER_STORE"
OP_PLAIN_SPAWN="$(fmk_text REFUSED_OPERATION_PLAIN_SPAWN)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_PLAIN_SPAWN"
OP_REUSE_SPAWN="$(fmk_text REFUSED_OPERATION_REUSE_SPAWN)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_REUSE_SPAWN"
ROW_NO_ROW="$(fmk_text LATCH_ROW_STATE_KIND_NO_ROW)" || fail "setup: fmk-texts.ts could not print LATCH_ROW_STATE_KIND_NO_ROW"
STEP_SPAWN_RETRY="$(fmk_text RECHECK_STEP_SPAWN_RETRY)" || fail "setup: fmk-texts.ts could not print RECHECK_STEP_SPAWN_RETRY"
CALL_PLAIN_SPAWN="$(fmk_text RECHECK_CALL_PLAIN_SPAWN)" || fail "setup: fmk-texts.ts could not print RECHECK_CALL_PLAIN_SPAWN"
CALL_REUSE_SPAWN="$(fmk_text RECHECK_CALL_REUSE_SPAWN)" || fail "setup: fmk-texts.ts could not print RECHECK_CALL_REUSE_SPAWN"
LEFTOVER_PHRASE="$(fmk_text CONFLICT_LEFTOVER_PHRASE)" || fail "setup: fmk-texts.ts could not print CONFLICT_LEFTOVER_PHRASE"
ANOTHER_STORE_PHRASE="$(fmk_text CONFLICT_ANOTHER_STORE_PHRASE)" || fail "setup: fmk-texts.ts could not print CONFLICT_ANOTHER_STORE_PHRASE"
STORE_MUST_NOT_END_LINE="$(fmk_text CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE)" \
    || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE"
GRACE_MS="$(fmk_text adGraceMs)" || fail "setup: fmk-texts.ts could not print adGraceMs"
BOUND_MS="$(fmk_text adLaunchBoundMs)" || fail "setup: fmk-texts.ts could not print adLaunchBoundMs"
[[ "${GRACE_MS}" =~ ^[1-9][0-9]*$ && "${BOUND_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: G '${GRACE_MS}' ms and B '${BOUND_MS}' ms are not whole numbers"
[[ -n "${STORE_MUST_NOT_END_LINE}" ]] || fail "setup: fmk-texts.ts printed an empty must-not-be-ended line"
echo "${TEST_NAME}: G ${GRACE_MS} ms, B ${BOUND_MS} ms (agent-director's default settings)"

# Each scenario 19 persona's latch: its case, the operation the bring-up's
# refused launch was (and so the latch-set line's refused operation), the
# row state that line records, its re-check rounds' step and call (one
# `status`, then that call), and the case phrase agent-director's
# description carries.
declare -A S19_CASE=([${SCAN_KEY}]="${CASE_LEFTOVER}" [${ENV_KEY}]="${CASE_NO_VALID_ID}"
    [${STORE_KEY}]="${CASE_ANOTHER_STORE}" [${PEND_KEY}]="${CASE_LEFTOVER}")
declare -A S19_OP=([${SCAN_KEY}]="${OP_PLAIN_SPAWN}" [${ENV_KEY}]="${OP_PLAIN_SPAWN}"
    [${STORE_KEY}]="${OP_PLAIN_SPAWN}" [${PEND_KEY}]="${OP_REUSE_SPAWN}")
declare -A S19_REFUSED_CALL=([${SCAN_KEY}]="${CALL_PLAIN_SPAWN}" [${ENV_KEY}]="${CALL_PLAIN_SPAWN}"
    [${STORE_KEY}]="${CALL_PLAIN_SPAWN}" [${PEND_KEY}]="${CALL_REUSE_SPAWN}")
declare -A S19_LATCH_ROW=([${SCAN_KEY}]="${ROW_NO_ROW}" [${ENV_KEY}]=ended [${STORE_KEY}]=ended [${PEND_KEY}]=missing)
declare -A S19_STEP=([${SCAN_KEY}]="${STEP_SPAWN_RETRY}" [${ENV_KEY}]="${STEP_TABLE}"
    [${STORE_KEY}]="${STEP_TABLE}" [${PEND_KEY}]="${STEP_TABLE}")
declare -A S19_CALL=([${SCAN_KEY}]="${CALL_PLAIN_SPAWN}" [${ENV_KEY}]="${CALL_REUSE_SPAWN}"
    [${STORE_KEY}]="${CALL_REUSE_SPAWN}" [${PEND_KEY}]="${CALL_REUSE_SPAWN}")
declare -A S19_PHRASE=([${SCAN_KEY}]="${LEFTOVER_PHRASE}" [${ENV_KEY}]="${NO_VALID_ID_PHRASE}"
    [${STORE_KEY}]="${ANOTHER_STORE_PHRASE}" [${PEND_KEY}]="${LEFTOVER_PHRASE}")
# Filled in by the phases, by key: the seeded session's id and pane, the
# session name the latch quotes, the post count before phase 4, the latch's
# shim mark, refused call's time and row reads, the round lines, and the
# rounds' progress.
declare -A S19_SID=() S19_PANE=() S19_SESSION=() S19_POSTS_BEFORE=() S19_LATCH_MARK=() S19_LATCH_US=()
declare -A S19_LATCH_STATE=() S19_LATCH_RV=() S19_ROUND_HEAD=() S19_ROUND_REFUSED=() S19_ROUND_BASE=()
declare -A S19_REFUSED_BASE=() S19_ROUNDS=() S19_PREV_US=() S19_LAST_POS=() S19_CONNECTS=() S19_CONFLICTS=()

# ---------------------------------------------------------------------------
# Phase 1: first life, for the personas that need a row
# ---------------------------------------------------------------------------

phase1_first_life() {
    local step="phase 1: first life" key ref rows
    for key in "${LIFE2_KEYS[@]}"; do
        prepare_persona "${key}"
    done
    write_personas_config "${LIFE1_KEYS[@]}"
    start_server --live
    LIFE1_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${#LIFE1_KEYS[@]}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion "${#LIFE1_KEYS[@]}" "${step}" "0 not brought up"
    for key in "${LIFE1_KEYS[@]}"; do
        ref="$(persona_ref "${PERSONA_NAME[${key}]}")"
        wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${PERSONA_ID[${key}]}" waiting
        [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} has no claude_session_id"
        [[ -n "${ROW_SESSION}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} names no tmux session"
        PERSONA_SID[${key}]="${ROW_SID}"
        PERSONA_SESSION[${key}]="${ROW_SESSION}"
        wait_for_count "[slack] Session connected: persona ${ref}" 1 "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the stub's session as ${key}'s"
        rows="$(server_rows "${LIFE1_PID}" "$(verb_rows send-keys "$(ad_cscb_calls "${PERSONA_ID[${key}]}")")")"
        (( $(rows_count "${rows}") >= 1 )) || fail "${step}: no bot-server send-keys of ${PERSONA_ID[${key}]} (the approver's Enter)"
        echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]} reads waiting, claude_session_id ${ROW_SID}, session ${ROW_SESSION}"
    done
}

# ---------------------------------------------------------------------------
# Phase 2: stop --stop-bots, each row left as its leg needs it
# ---------------------------------------------------------------------------

# Scenario 4 [harness]: the human ends the worker as a human ends Claude
# Code (the stub's exit line), so agent-director marks the row ended.
s4_human_exit() {
    local step="phase 2: ${S4_KEY}'s worker ended by hand" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    S4_EXIT_MARK="$(ad_shim_mark)"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" -l __CSCB_TEST_EXIT__ \
        || fail "${step}: could not type the stub's exit line into ${session}"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" Enter \
        || fail "${step}: could not send Enter into ${session}"
    wait_row "${step}" "${EXIT_WAIT_S}" "${id}" ended missing
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after the worker's exit" session_gone "${session}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE}; ${session} is gone"
}

phase2_stop_bots() {
    local step="phase 2: stop --stop-bots" id rows n verb
    s4_human_exit
    stop_server --stop-bots
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    # Scenario 4: the row stays finished, with its session id, and nothing
    # relaunched it after the exit (the disconnect's restart never ran).
    id="${PERSONA_ID[${S4_KEY}]}"
    row_reads "${step}" "${id}" ended missing || fail "${step}: ${id} reads '${ROW_STATE}', not ended or missing"
    [[ "${ROW_SID}" == "${PERSONA_SID[${S4_KEY}]}" ]] \
        || fail "${step}: ${id}'s claude_session_id is '${ROW_SID}', not ${PERSONA_SID[${S4_KEY}]}"
    ! has_session "${PERSONA_SESSION[${S4_KEY}]}" || fail "${step}: session ${PERSONA_SESSION[${S4_KEY}]} is there"
    rows="$(ad_cscb_calls "${id}" "${S4_EXIT_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} after the exit (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    for verb in resume spawn; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${id} after the worker's exit"
    done
    S4_FINISHED_STATE="${ROW_STATE}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE} with claude_session_id ${ROW_SID}"
    s19_pend_stopped
}

# Scenario 19, the `pending` variant: the teardown ended the persona's
# worker's session; its row keeps its claude_session_id (its state is
# recorded, not asserted: the teardown's `kill` changes no row's state).
s19_pend_stopped() {
    local step="phase 2: ${PEND_KEY}'s worker ended by the teardown" id="${PERSONA_ID[${PEND_KEY}]}" session="${PERSONA_SESSION[${PEND_KEY}]}"
    [[ "${session}" == "${PERSONA_NAMED[${PEND_KEY}]}" ]] \
        || fail "${step}: the row records session '${session}', not ${PERSONA_NAMED[${PEND_KEY}]}"
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after stop --stop-bots" session_gone "${session}"
    read_row "${step}" "${id}"
    [[ -n "${ROW_STATE}" && "${ROW_SID}" == "${PERSONA_SID[${PEND_KEY}]}" ]] \
        || fail "${step}: ${id} reads '${ROW_STATE}' with claude_session_id '${ROW_SID}', not its first life's ${PERSONA_SID[${PEND_KEY}]}"
    echo "${TEST_NAME}: ${step}: ${session} is gone; ${id} reads ${ROW_STATE} (recorded, not asserted)"
}

# ---------------------------------------------------------------------------
# Phase 3: harness seeding, with the server stopped
# ---------------------------------------------------------------------------

# Scenario 4 [harness]: a session with no label holds the row's name.
s4_seed() {
    local step="phase 3: ${S4_KEY}'s name held" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    seed_unlabelled -c "${PERSONA_WORK[${S4_KEY}]}" "${session}" sleep 86400 > "${SCENARIO_ROOT}/s4-seed.out"
    S4_SEEDED_SID="${SEEDED_SESSION_ID}"
    S4_SEEDED_PANE="${SEEDED_PANE_ID}"
    [[ "${S4_SEEDED_SID}" =~ ^\$[0-9]+$ ]] || fail "${step}: the seeded session id is '${S4_SEEDED_SID}'"
    row_reads "${step}" "${id}" "${S4_FINISHED_STATE}" || fail "${step}: ${id} reads '${ROW_STATE}', not ${S4_FINISHED_STATE}"
    echo "${TEST_NAME}: ${step}: ${session} (${S4_SEEDED_SID}, pane ${S4_SEEDED_PANE}) has no label; ${id} reads ${ROW_STATE}"
}

# Scenario 19 [harness]: s19_seed <key> <seed helper>: the helper seeds a
# session named as the persona's launches name theirs, in its working
# directory, its pane running `sleep`; the session's id and pane are
# recorded. With no row for the id (every variant but `pending`), the
# harness's store read finds none.
s19_seed() {
    local key="$1" helper="$2" step id session rows
    step="phase 3: ${key}'s name held (${helper})"
    id="${PERSONA_ID[${key}]}"
    session="${PERSONA_NAMED[${key}]}"
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    "${helper}" -c "${PERSONA_WORK[${key}]}" "${session}" "${id}" sleep 86400 > "${SCENARIO_ROOT}/s19-${key}-seed.out"
    S19_SID[${key}]="${SEEDED_SESSION_ID}"
    S19_PANE[${key}]="${SEEDED_PANE_ID}"
    [[ "${S19_SID[${key}]}" =~ ^\$[0-9]+$ && "${S19_PANE[${key}]}" =~ ^%[0-9]+$ ]] \
        || fail "${step}: the seeded session is '${S19_SID[${key}]}', pane '${S19_PANE[${key}]}'"
    if [[ "${key}" != "${PEND_KEY}" ]]; then
        rows="$(store_rows_of "${step}" "${id}")" || exit 1
        [[ "${rows}" == 0 ]] || fail "${step}: the store holds ${rows} row(s) with id ${id}, not none"
    fi
    echo "${TEST_NAME}: ${step}: ${session} (${S19_SID[${key}]}, pane ${S19_PANE[${key}]}${SEEDED_TOKEN:+, token ${SEEDED_TOKEN}}${SEEDED_STORE_ID:+, store ${SEEDED_STORE_ID}})"
}

# Scenario 19, the `pending` variant [harness]: the leftover, then E39's
# scenario 19 statement makes the persona's row `pending` beside it, with a
# launch start and a launch token other than the leftover's, and then
# s19_pend_no_session clears the row's claude_session_id. Records the launch
# start (PEND_LAUNCH_MS).
s19_seed_pending() {
    local step="phase 3: ${PEND_KEY}'s row pending beside a leftover" id="${PERSONA_ID[${PEND_KEY}]}" token json
    s19_seed "${PEND_KEY}" seed_leftover
    token="$(ad_store_seed_pending "${id}" "${SEEDED_TOKEN}")" || exit 1
    json="$(_scenario_row_json "${step}" "${id}")" || exit 1
    PEND_LAUNCH_MS="$(jq -r '.[0].launch_started_at' <<< "${json}")"
    [[ "${PEND_LAUNCH_MS}" =~ ^[0-9]+$ ]] || fail "${step}: the row's launch_started_at reads '${PEND_LAUNCH_MS}'"
    [[ "$(jq -r '.[0].state' <<< "${json}")" == pending && "$(jq -r '.[0].launch_token' <<< "${json}")" == "${token}" ]] \
        || fail "${step}: the row does not read pending with launch token ${token}: ${json}"
    [[ "${token}" != "${SEEDED_TOKEN}" ]] || fail "${step}: the row's launch token is the leftover's"
    # E39's statement keeps the first life's claude_session_id; the launch it
    # seeds recorded none, so s19_pend_no_session clears it.
    [[ "$(jq -r '.[0].claude_session_id // ""' <<< "${json}")" == "${PERSONA_SID[${PEND_KEY}]}" ]] \
        || fail "${step}: after E39's statement the row's claude_session_id is not its first life's ${PERSONA_SID[${PEND_KEY}]}"
    s19_pend_no_session "${step}" "${id}"
    echo "${TEST_NAME}: ${step}: ${id} pending with no claude_session_id, launch start ${PEND_LAUNCH_MS} ms, token ${token}; the leftover's token ${SEEDED_TOKEN}"
}

# s19_pend_no_session <step> <instance-id> [harness]: the seeded `pending`
# row is a spawn whose process stopped before its create, so its launch
# recorded no Claude session: one `ad_store_edit` UPDATE (container only;
# lib/scenario.sh's store-statement rules) sets claude_session_id NULL and
# advances row_version by one, naming the row by its id, its `pending` state
# and its row_version as read just before; the store read after it shows
# those two columns changed and every other as the seed set it. With no
# claude_session_id, the restart path's decision on the row once it reads
# `missing` is a reuse spawn (b.jg5 SRJ-1420).
s19_pend_no_session() {
    local step="$1: claude_session_id cleared" id="$2" before after rv out
    before="$(_scenario_row_json "${step}" "${id}")" || exit 1
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    out="$(ad_store_edit "UPDATE spawns SET claude_session_id = NULL, row_version = row_version + 1 WHERE claude_instance_id = '${id}' AND state = 'pending' AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row is no longer pending at row_version ${rv}, and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${id}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" "{\"claude_session_id\": null, \"row_version\": $(( rv + 1 ))}"
}

phase3_seed() {
    s4_seed
    s19_seed "${SCAN_KEY}" seed_leftover
    s19_seed "${ENV_KEY}" seed_env_only
    s19_seed "${STORE_KEY}" seed_other_store
    s19_seed_pending
}

# ---------------------------------------------------------------------------
# Phase 4: second life, every persona configured
# ---------------------------------------------------------------------------

# Scenario 4: the latch, its one notice, and the harness's reads at the latch.
s4_latch() {
    local step="phase 4: ${S4_KEY} latches" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    local name="${PERSONA_NAME[${S4_KEY}]}" set_line rows notice prefix first list desc
    set_line="$(fmk_text conflictLatchSetLine "${S4_KEY}" "${CASE_NO_VALID_ID}" "${session}" "${OP_RESUME}" "${S4_FINISHED_STATE}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    wait_for_count "${set_line}" 1 "${START_WAIT_S}" "${step}: no latch-set line '${set_line}'"
    S4_LATCH_MARK="$(ad_shim_mark)"
    S4_LATCH_TMUX_MARK="$(tmux_shim_mark)"
    expect_count "${set_line}" 1 "${step}: latch-set lines"

    # The bring-up's one resume, the bot server's, was refused.
    rows="$(ad_cscb_calls "${id}" "${LIFE2_MARK}" "${S4_LATCH_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} up to the latch (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    rows="$(verb_rows resume "${rows}")"
    (( $(rows_count "${rows}") == 1 )) || fail "${step}: $(rows_count "${rows}") CSCB resume call(s) of ${id} before the latch, not one"
    [[ -n "$(server_rows "${LIFE2_PID}" "${rows}")" ]] || fail "${step}: the resume of ${id} is not the bot server's"
    S4_LATCH_US="$(us_of "$(field_of 2 "${rows}")")"

    # One CONFLICT notice, in SRJ-1004's order, naming no command.
    wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${S4_KEY}]}" \
        posts_holding_at_least "${S4_KEY}" "${S4_POSTS_BEFORE}" "${CONFLICT_HEAD}" 1
    posts_holding "${S4_KEY}" 0 "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${S4_KEY}]} hold the CONFLICT notice head, not one"
    notice="${HOLDING[0]}"
    prefix="$(fmk_text personaNoticePrefix "${name}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    first="$(fmk_text conflictNoticeFirstLine "${CASE_NO_VALID_ID}" "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeFirstLine"
    list="$(fmk_text conflictNoticeListLine "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeListLine"
    split_on "${notice}" "${NOTICE_SEP}"
    if (( ${#PARTS[@]} != 5 )) || [[ "${PARTS[0]}" != "${prefix}${first}" || "${PARTS[2]}" != "${POINTER_LINE}" \
        || "${PARTS[3]}" != "${list}" || "${PARTS[4]}" != "${HUMAN_LINE}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${notice}" "${prefix}${first}${NOTICE_SEP}${DESC_HEAD}…${DESC_TAIL}${NOTICE_SEP}${POINTER_LINE}${NOTICE_SEP}${list}${NOTICE_SEP}${HUMAN_LINE}" >&2
        fail "${step}: the CONFLICT notice is not the prefix and first line, the description line, the pointer line, the list line and the human-only line"
    fi
    desc="${PARTS[1]}"
    [[ "${desc}" == "${DESC_HEAD}"*"${DESC_TAIL}" ]] || fail "${step}: the notice's second line is not a description line: ${desc}"
    desc="${desc#"${DESC_HEAD}"}"
    desc="${desc%"${DESC_TAIL}"}"
    [[ "${desc}" == *"${NO_VALID_ID_PHRASE}"* ]] || fail "${step}: agent-director's description does not say '${NO_VALID_ID_PHRASE}': ${desc}"
    [[ "${desc}" == *"${session}"* ]] || fail "${step}: agent-director's description does not name ${session}: ${desc}"
    S4_POSTS_AT_LATCH="$(post_count "${S4_KEY}")"
    echo "${TEST_NAME}: ${step}: one CONFLICT notice; agent-director said: ${desc}"

    # The harness's reads at the latch: the row and the seeded session.
    store_row "${step}" "${id}"
    [[ "${STORE_STATE}" == ended || "${STORE_STATE}" == missing ]] || fail "${step}: ${id} reads ${STORE_STATE} in the store at the latch"
    S4_LATCH_STATE="${STORE_STATE}"
    S4_LATCH_RV="${STORE_RV}"
    has_session_id "${S4_SEEDED_SID}" || fail "${step}: the seeded session ${S4_SEEDED_SID} is gone"
    echo "${TEST_NAME}: ${step}: ${id} reads ${S4_LATCH_STATE} at row_version ${S4_LATCH_RV}"
}

# Scenario 4: REFUSED_ROUNDS rounds, each one status then one resume,
# refused, posting nothing and writing nothing.
s4_refused_rounds() {
    local id="${PERSONA_ID[${S4_KEY}]}" name="${PERSONA_NAME[${S4_KEY}]}" n step rounds prev status_us resume_us status_pos resume_pos
    local line
    line="$(fmk_text latchRecheckRoundLine "${name}" "${CASE_NO_VALID_ID}" "${STEP_TABLE}" "${CALL_RESUME}" ANSWER)" \
        || fail "phase 4: fmk-texts.ts could not print latchRecheckRoundLine"
    S4_ROUND_HEAD="${line%ANSWER}"
    S4_ROUND_REFUSED="${S4_ROUND_HEAD}still-latched"
    prev="${S4_LATCH_US}"
    for (( n = 1; n <= REFUSED_ROUNDS; n++ )); do
        step="phase 4: ${S4_KEY}'s round ${n} (refused)"
        wait_for_count "${S4_ROUND_HEAD}" "${n}" $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no round line ${n}"
        expect_count "${S4_ROUND_REFUSED}" "${n}" "${step}: refused round lines"
        rounds="$(persona_rounds "${step}" "${id}" "${S4_LATCH_MARK}")"
        (( $(rows_count "${rounds}") == n )) || fail "${step}: $(rows_count "${rounds}") rounds of ${id} after the latch, not ${n}"
        read -r status_pos status_us resume_pos resume_us <<< "$(tail -n 1 <<< "${rounds}")"
        check_cadence "${step}" "${prev}" "${status_us}" "${resume_us}"
        prev="${status_us}"
        S4_LAST_ROUND_POS="${resume_pos}"
        store_row "${step}" "${id}"
        [[ "${STORE_STATE}" == "${S4_LATCH_STATE}" && "${STORE_RV}" == "${S4_LATCH_RV}" ]] \
            || fail "${step}: ${id} reads ${STORE_STATE} at row_version ${STORE_RV}, not ${S4_LATCH_STATE} at ${S4_LATCH_RV}"
        has_session_id "${S4_SEEDED_SID}" || fail "${step}: the seeded session ${S4_SEEDED_SID} is gone"
        (( $(post_count "${S4_KEY}") == S4_POSTS_AT_LATCH )) \
            || fail "${step}: the channel holds $(post_count "${S4_KEY}") posts, not the ${S4_POSTS_AT_LATCH} it held at the latch"
        echo "${TEST_NAME}: ${step}: status at shim line ${status_pos}, resume at ${resume_pos}; ${id} still ${STORE_STATE} at row_version ${STORE_RV}"
    done
    S4_PREV_STATUS_US="${prev}"
}

# Scenario 4: the harness ends the session; the next round's resume launches
# and the latch clears with one recovery post.
s4_clear() {
    local step="phase 4: ${S4_KEY}'s clear" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    local name="${PERSONA_NAME[${S4_KEY}]}" ref rows s_pos s_time s_verb r_pos r_time r_verb s_us r_us between cleared recovery n
    ref="$(persona_ref "${name}")"
    S4_CONNECTS="$(count_log "[slack] Session connected: persona ${ref}")"
    # [harness] The human ends the session by its id.
    end_session "${S4_SEEDED_SID}"
    S4_END_TMUX_MARK="$(tmux_shim_mark)"
    echo "${TEST_NAME}: ${step}: the harness ended ${session} (${S4_SEEDED_SID})"

    wait_for_count "${S4_ROUND_HEAD}" $(( REFUSED_ROUNDS + 1 )) $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no round line after the session ended"
    rows="$(ad_cscb_calls "${id}" "${S4_LAST_ROUND_POS}")"
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    IFS=$'\t' read -r r_pos r_time _ r_verb _ <<< "$(sed -n 2p <<< "${rows}")"
    if [[ "${s_verb}" != status || "${r_verb}" != resume ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round's first calls of ${id} are '${s_verb}' and '${r_verb}', not status then resume"
    fi
    s_us="$(us_of "${s_time}")"
    r_us="$(us_of "${r_time}")"
    check_cadence "${step}" "${S4_PREV_STATUS_US}" "${s_us}" "${r_us}"
    between="$(ad_cscb_verb_between find-missing "${s_pos}" "${r_pos}")"
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the round's status and its resume"; }

    # The retry was not refused: the latch clears, posted.
    cleared="$(fmk_text latchClearedLine "${S4_KEY}" "${CASE_NO_VALID_ID}" "${session}" posted LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    expect_count "${cleared}" 1 "${step}: the clear line '${cleared}'"
    expect_count "${S4_ROUND_REFUSED}" "${REFUSED_ROUNDS}" "${step}: refused round lines"
    echo "${TEST_NAME}: ${step}: round line: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${S4_ROUND_HEAD}" | sed 's/^.*\] //')"

    # The resume launched: the persona comes back on its conversation.
    wait_row "${step}: the resume's report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ "${ROW_SID}" == "${PERSONA_SID[${S4_KEY}]}" ]] \
        || fail "${step}: the resumed row's claude_session_id is '${ROW_SID}', not ${PERSONA_SID[${S4_KEY}]}"
    [[ "${ROW_SESSION}" == "${session}" ]] || fail "${step}: the resumed row records session '${ROW_SESSION}', not ${session}"
    wait_for_count "[slack] Session connected: persona ${ref}" $(( S4_CONNECTS + 1 )) "${CONNECT_WAIT_S}" \
        "${step}: the server never registered the resumed stub's session as ${S4_KEY}'s"
    read -r S4_RESUMED_SID S4_RESUMED_PANE <<< "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id} #{pane_id}' 2> /dev/null || true)"
    [[ "${S4_RESUMED_SID}" =~ ^\$[0-9]+$ && "${S4_RESUMED_PANE}" =~ ^%[0-9]+$ ]] \
        || fail "${step}: tmux gives no session id and pane for the resumed ${session}"

    # Exactly one recovery post, the printed notice.
    recovery="$(fmk_text formatPersonaNotice "${name}" conflictRecoveryText "${session}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    wait_until "${NOTICE_WAIT_S}" "${step}: no recovery post on ${PERSONA_CHANNEL[${S4_KEY}]}" \
        posts_holding_at_least "${S4_KEY}" "${S4_POSTS_AT_LATCH}" "${RECOVERY_HEAD}" 1
    posts_holding "${S4_KEY}" 0 "${RECOVERY_HEAD}"
    n="${#HOLDING[@]}"
    (( n == 1 )) || fail "${step}: ${n} posts hold the recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed recovery notice"
    fi
    posts_holding "${S4_KEY}" 0 "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the CONFLICT notice head, not one"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with claude_session_id ${ROW_SID}; one recovery post"
}

# Scenario 4: nothing killed or deleted for the persona, and the seeded
# session never acted on.
s4_no_kill() {
    local step="phase 4: ${S4_KEY} nothing killed" id="${PERSONA_ID[${S4_KEY}]}" rows verb n found target control=""
    rows="$(ad_cscb_calls "${id}" "${LIFE2_MARK}")"
    for verb in kill kill-finished delete; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${id} in the second life"
    done
    # Up to the harness's end of the seeded session: once the scenario's tmux
    # server has no session left it exits, and the next server numbers its
    # sessions and panes from $0 and %0 again.
    found="$(tmux_shim_targets "${S4_SEEDED_SID}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on the seeded session ${S4_SEEDED_SID}"; }
    found="$(tmux_shim_targets "${S4_SEEDED_PANE}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on the seeded pane ${S4_SEEDED_PANE}"; }
    found="$(tmux_shim_targets "${PERSONA_SESSION[${S4_KEY}]}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on ${PERSONA_SESSION[${S4_KEY}]} while the seeded session held it"; }
    # Positive control: the approver typed into the resumed session.
    for target in "${PERSONA_SESSION[${S4_KEY}]}" "${S4_RESUMED_SID}" "${S4_RESUMED_PANE}"; do
        found="$(tmux_shim_targets "${target}" "${S4_END_TMUX_MARK}")"
        [[ -z "${found}" ]] || control+="${target}: $(field_of 4 "${found}" | sort | uniq -c | tr -s ' \n' ' ')"
    done
    [[ -n "${control}" ]] \
        || fail "${step}: positive control: tmux_shim_targets finds no command acting on the resumed ${PERSONA_SESSION[${S4_KEY}]}, ${S4_RESUMED_SID} or ${S4_RESUMED_PANE}"
    echo "${TEST_NAME}: ${step}: tmux commands acting on the resumed session: ${control}"
    echo "${TEST_NAME}: ${step}: no kill, kill-finished or delete of ${id}; the seeded session untouched"
}

# ---------------------------------------------------------------------------
# Scenario 19's legs (phase 4, and phase 5's restart leg)
# ---------------------------------------------------------------------------

# posts_since <key> <from-index>: print how many posts persona <key>'s channel
# holds from index <from-index> on.
posts_since() {
    echo $(( $(post_count "$1") - $2 ))
}

# s19_check_notice <step> <key> <session> <from-index>: exactly one post on
# persona <key>'s channel from <from-index> on holds the CONFLICT notice head,
# and its lines are, in SRJ-1004's order: the persona prefix and the first
# line for the persona's case quoting <session>; the description line (head
# and tail as printed, holding the case's phrase and <session>); for
# "another agent-director store", its must-not-be-ended line; the pointer
# line; the list line for <session>; the human-only line. Every line but the
# description line equals its printed line, so the post names no command.
s19_check_notice() {
    local step="$1" key="$2" session="$3" from="$4" lcase notice prefix first list desc i bad=0 expected=()
    lcase="${S19_CASE[${key}]}"
    wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${from}" "${CONFLICT_HEAD}" 1
    posts_holding "${key}" "${from}" "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) \
        || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${key}]} hold the CONFLICT notice head, not one"
    notice="${HOLDING[0]}"
    prefix="$(fmk_text personaNoticePrefix "${PERSONA_NAME[${key}]}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    first="$(fmk_text conflictNoticeFirstLine "${lcase}" "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeFirstLine"
    list="$(fmk_text conflictNoticeListLine "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeListLine"
    expected=("${prefix}${first}" "${DESC_HEAD}…${DESC_TAIL}")
    if [[ "${lcase}" == "${CASE_ANOTHER_STORE}" ]]; then
        expected+=("${STORE_MUST_NOT_END_LINE}")
    fi
    expected+=("${POINTER_LINE}" "${list}" "${HUMAN_LINE}")
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
        fail "${step}: the CONFLICT notice's lines are not, in order, the prefix and first line, the description line,$( [[ "${lcase}" != "${CASE_ANOTHER_STORE}" ]] || printf ' the must-not-be-ended line,') the pointer line, the list line and the human-only line"
    fi
    desc="${PARTS[1]}"
    [[ "${desc}" == "${DESC_HEAD}"*"${DESC_TAIL}" ]] || fail "${step}: the notice's second line is not a description line: ${desc}"
    desc="${desc#"${DESC_HEAD}"}"
    desc="${desc%"${DESC_TAIL}"}"
    [[ "${desc}" == *"${S19_PHRASE[${key}]}"* ]] || fail "${step}: agent-director's description does not say '${S19_PHRASE[${key}]}': ${desc}"
    [[ "${desc}" == *"${session}"* ]] || fail "${step}: agent-director's description does not name ${session}: ${desc}"
    echo "${TEST_NAME}: ${step}: one CONFLICT notice; agent-director said: ${desc}"
}

# s19_scan_trail <step> [<want>]: the scan-refusal persona's trail. The
# ad.launch.name_held records of its id with row_result `not_inserted` (source
# `ad_spawn`, launch `spawn`; agent-director 0.11.0 pkg/api/name_held_trail.go)
# number <want> (default: CSCB's `spawn` calls of the id since the second
# life began, every one a plain spawn the scan refused), and each names the
# persona's session name and the seeded leftover's tmux id. The session the
# latch quotes is read from them (S19_SESSION), never from the capped post.
s19_scan_trail() {
    local step="$1" id="${PERSONA_ID[${SCAN_KEY}]}" recs n spawns want named
    recs="$(name_held_records "${id}" ad_spawn not_inserted)" || exit 1
    n="$(rows_count "${recs}")"
    spawns="$(rows_count "$(verb_rows spawn "$(ad_cscb_calls "${id}" "${LIFE2_MARK}")")")"
    want="${2:-${spawns}}"
    (( n == want )) \
        || fail "${step}: ${n} ad.launch.name_held record(s) of ${id} with row_result not_inserted, not ${want} (CSCB made ${spawns} spawn(s) of it since the second life began)"
    (( n > 0 )) || fail "${step}: no ad.launch.name_held record of ${id} with row_result not_inserted"
    named="$(jq -r '"\(.tmux_session_name) \(.tmux_session_id) \(.launch)"' <<< "${recs}" | sort -u)"
    [[ "${named}" == "${PERSONA_NAMED[${SCAN_KEY}]} ${S19_SID[${SCAN_KEY}]} spawn" ]] \
        || fail "${step}: the not_inserted records name '${named//$'\n'/; }', not ${PERSONA_NAMED[${SCAN_KEY}]} ${S19_SID[${SCAN_KEY}]} spawn"
    S19_SESSION[${SCAN_KEY}]="$(tail -n 1 <<< "${recs}" | jq -r '.tmux_session_name')"
    echo "${TEST_NAME}: ${step}: ${n} not_inserted record(s) of ${id}, naming ${S19_SESSION[${SCAN_KEY}]} (${S19_SID[${SCAN_KEY}]})"
}

# s19_pending_marked: the `pending` variant's row is marked `missing` by
# CSCB's own pending-row runs: one ad.find_missing.tick record (reason
# tmux_name_held, pending to missing) no earlier than G after the seeded
# launch start and no later than B plus SETTLE_S after it, one
# ad.launch.name_held record from `ad_find_missing` (row_result
# `marked_missing`) naming the leftover's session name and tmux id, a CSCB
# `find-missing` call at or before that mark, no `find-missing` from any
# other process (the harness runs none), and no CSCB `kill` of the id.
s19_pending_marked() {
    local step="phase 4: ${PEND_KEY}'s row marked missing" id="${PERSONA_ID[${PEND_KEY}]}" session="${PERSONA_NAMED[${PEND_KEY}]}"
    local deadline_ms timeout_s marks tick_ms recs named fm pos time found="" other n
    deadline_ms=$(( PEND_LAUNCH_MS + BOUND_MS + SETTLE_S * 1000 ))
    timeout_s=$(( (deadline_ms - $(now_ms)) / 1000 + 1 ))
    (( timeout_s > 0 )) || timeout_s=1
    if ! _scenario_poll_until "${timeout_s}" has_name_held_tmux_mark "${id}"; then
        latch_lines_of "${PEND_KEY}"
        fail "${step}: no ad.find_missing.tick record marked ${id} missing with reason tmux_name_held within B plus the settle (${BOUND_MS} ms + ${SETTLE_S} s) of its launch start"
    fi
    marks="$(name_held_tmux_marks "${id}")" || exit 1
    n="$(rows_count "${marks}")"
    (( n == 1 )) || fail "${step}: ${n} tmux_name_held marks of ${id}, not one"
    [[ "$(jq -r '"\(.prior_state) \(.tmux_session_name)"' <<< "${marks}")" == "pending ${session}" ]] \
        || fail "${step}: the mark is not of a pending row named ${session}: ${marks}"
    tick_ms="$(date -u -d "$(jq -r '.ts' <<< "${marks}")" +%s%3N)" || fail "${step}: the mark's ts does not read as a time: ${marks}"
    (( tick_ms >= PEND_LAUNCH_MS + GRACE_MS )) \
        || fail "${step}: the row was marked $(( tick_ms - PEND_LAUNCH_MS )) ms after its launch start, before G (${GRACE_MS} ms)"
    (( tick_ms <= deadline_ms )) \
        || fail "${step}: the row was marked $(( tick_ms - PEND_LAUNCH_MS )) ms after its launch start, later than B plus the settle"
    recs="$(name_held_records "${id}" ad_find_missing marked_missing)" || exit 1
    n="$(rows_count "${recs}")"
    (( n == 1 )) || fail "${step}: ${n} ad.launch.name_held records of ${id} from ad_find_missing with row_result marked_missing, not one"
    named="$(jq -r '"\(.tmux_session_name) \(.tmux_session_id)"' <<< "${recs}")"
    [[ "${named}" == "${session} ${S19_SID[${PEND_KEY}]}" ]] \
        || fail "${step}: the find-missing record names '${named}', not the leftover ${session} ${S19_SID[${PEND_KEY}]}"
    S19_SESSION[${PEND_KEY}]="$(jq -r '.tmux_session_name' <<< "${recs}")"
    # The mark is a CSCB run's: a CSCB find-missing call started at or before
    # it, and no other process ran one.
    fm="$(ad_cscb_verb_between find-missing "${LIFE2_MARK}" -)"
    while IFS=$'\t' read -r pos time _; do
        [[ -n "${pos}" ]] || continue
        if (( $(us_of "${time}") / 1000 <= tick_ms )); then
            found="${pos}"
        fi
    done <<< "${fm}"
    [[ -n "${found}" ]] || fail "${step}: no CSCB find-missing call at or before the mark"
    other="$(non_cscb_find_missing)"
    [[ -z "${other}" ]] || { sed 's/^/  | /' <<< "${other}" >&2; fail "${step}: a find-missing call whose parent is not a CSCB process"; }
    n="$(rows_count "$(verb_rows kill "$(ad_cscb_calls "${id}" "${LIFE2_MARK}")")")"
    (( n == 0 )) || fail "${step}: ${n} CSCB kill call(s) of ${id}"
    echo "${TEST_NAME}: ${step}: marked $(( tick_ms - PEND_LAUNCH_MS )) ms after its launch start (G ${GRACE_MS} ms, B ${BOUND_MS} ms), naming ${S19_SESSION[${PEND_KEY}]} (${S19_SID[${PEND_KEY}]}); CSCB find-missing at shim line ${found}"
}

# s19_latch <key> <label> <from-mark> <server-pid> <set-count> <posts-from> <timeout-s>:
# scenario 19's latch of persona <key> by the launch the server <server-pid>
# made after <from-mark>: the latch-set line (the persona's case, refused
# operation and recorded row state) is logged within <timeout-s>, and now
# <set-count> times; the server's one refused launch of the id (the
# persona's S19_REFUSED_CALL) lies after <from-mark>, and no CSCB `kill` of
# the id; exactly one post on its channel from <posts-from> on, the CONFLICT
# notice (s19_check_notice); the harness's read of the row: none for the
# scan refusal (its trail, s19_scan_trail), else its state and row_version;
# the seeded session is still there. Sets the latch's mark, time, row reads
# and round lines.
s19_latch() {
    local key="$1" step="$2: $1 latches" from="$3" pid="$4" sets="$5" posts_from="$6" timeout_s="$7"
    local id="${PERSONA_ID[$1]}" name="${PERSONA_NAME[$1]}" template head tail session set_line rows refused="" pos time ppid verb args n line
    template="$(fmk_text conflictLatchSetLine "${key}" "${S19_CASE[${key}]}" SESSIONSLOT "${S19_OP[${key}]}" "${S19_LATCH_ROW[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    head="${template%%SESSIONSLOT*}"
    tail="${template#*SESSIONSLOT}"
    if ! _scenario_poll_until "${timeout_s}" _scenario_log_count_at_least "$(matcher "${head}" "${tail}")" "${sets}"; then
        latch_lines_of "${key}"
        fail "${step}: no latch-set line '${head}…${tail}' (${sets} wanted, not within ${timeout_s}s)"
    fi
    S19_LATCH_MARK[${key}]="$(ad_shim_mark)"

    # The session the latch quotes: the scan refusal's and the pending
    # variant's from agent-director's trail, the others' the persona's name.
    case "${key}" in
        "${SCAN_KEY}") s19_scan_trail "${step}" ;;
        "${PEND_KEY}") ;;
        *) S19_SESSION[${key}]="${PERSONA_NAMED[${key}]}" ;;
    esac
    session="${S19_SESSION[${key}]}"
    set_line="$(fmk_text conflictLatchSetLine "${key}" "${S19_CASE[${key}]}" "${session}" "${S19_OP[${key}]}" "${S19_LATCH_ROW[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    expect_count "${set_line}" "${sets}" "${step}: latch-set lines"

    # The server's one refused launch, and no kill.
    rows="$(ad_cscb_calls "${id}" "${from}" "${S19_LATCH_MARK[${key}]}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} up to the latch (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    n=0
    while IFS=$'\t' read -r pos time ppid verb _ args; do
        [[ -n "${pos}" ]] || continue
        round_call_is "${S19_REFUSED_CALL[${key}]}" "${verb}" "${args}" || continue
        n=$(( n + 1 ))
        [[ "${ppid}" == "${pid}" ]] || fail "${step}: the ${verb} of ${id} at shim line ${pos} is not the bot server's (${pid})"
        refused="${time}"
    done <<< "${rows}"
    (( n == 1 )) || fail "${step}: ${n} CSCB ${S19_REFUSED_CALL[${key}]} call(s) of ${id} before the latch, not one"
    S19_LATCH_US[${key}]="$(us_of "${refused}")"
    if [[ "${key}" == "${PEND_KEY}" ]]; then
        # Recorded, not asserted: the server's line for a `resume` before the
        # reuse (the no-transcript step, src/session-manager.ts).
        echo "${TEST_NAME}: ${step}: server-log lines on a resume of ${id} (recorded, not asserted):"
        grep -F "on resume for $(persona_ref "${name}")" "${SLACK_STATE_DIR}/server.log" | sed 's/^/  | /' || true
    fi
    n="$(rows_count "$(verb_rows kill "${rows}")")"
    (( n == 0 )) || fail "${step}: ${n} CSCB kill call(s) of ${id} before the latch"

    # One post, the CONFLICT notice.
    s19_check_notice "${step}" "${key}" "${session}" "${posts_from}"
    n="$(posts_since "${key}" "${posts_from}")"
    (( n == 1 )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} new posts, not only the CONFLICT notice"
    S19_CONFLICTS[${key}]=$(( ${S19_CONFLICTS[${key}]:-0} + 1 ))

    # The harness's reads at the latch.
    if [[ "${key}" == "${SCAN_KEY}" ]]; then
        n="$(store_rows_of "${step}" "${id}")" || exit 1
        [[ "${n}" == 0 ]] || fail "${step}: the store holds ${n} row(s) with id ${id}, not none"
        S19_LATCH_STATE[${key}]="no row"
    else
        store_row "${step}" "${id}"
        [[ "${STORE_STATE}" == "${S19_LATCH_ROW[${key}]}" ]] || fail "${step}: ${id} reads ${STORE_STATE} in the store, not ${S19_LATCH_ROW[${key}]}"
        S19_LATCH_STATE[${key}]="${STORE_STATE}"
        S19_LATCH_RV[${key}]="${STORE_RV}"
    fi
    has_session_id "${S19_SID[${key}]}" || fail "${step}: the seeded session ${S19_SID[${key}]} is gone"

    line="$(fmk_text latchRecheckRoundLine "${name}" "${S19_CASE[${key}]}" "${S19_STEP[${key}]}" "${S19_CALL[${key}]}" ANSWER)" \
        || fail "${step}: fmk-texts.ts could not print latchRecheckRoundLine"
    S19_ROUND_HEAD[${key}]="${line%ANSWER}"
    S19_ROUND_REFUSED[${key}]="${line%ANSWER}still-latched"
    S19_ROUND_BASE[${key}]="$(count_log "${S19_ROUND_HEAD[${key}]}")"
    S19_REFUSED_BASE[${key}]="$(count_log "${S19_ROUND_REFUSED[${key}]}")"
    S19_ROUNDS[${key}]=0
    S19_PREV_US[${key}]="${S19_LATCH_US[${key}]}"
    S19_LAST_POS[${key}]="${S19_LATCH_MARK[${key}]}"
    echo "${TEST_NAME}: ${step}: case ${S19_CASE[${key}]}, refused ${S19_OP[${key}]}; ${id}: ${S19_LATCH_STATE[${key}]}${S19_LATCH_RV[${key}]:+ at row_version ${S19_LATCH_RV[${key}]}}"
}

# s19_rounds <key> <min>: once at least <min> rounds of persona <key> have
# run since its latch (each next round's line waited for within
# INTERVAL_S plus twice SETTLE_S), every round since the latch: one `status`
# then the persona's re-check call (latch_rounds), each refused (its round
# line's answer `still-latched`), at the cadence (check_cadence: the first
# from the refused launch, each next from the previous round's status);
# nothing written (no row for the scan refusal, with one not_inserted trail
# record per refused plain spawn; else the same state and row_version); the
# seeded session still there; no post beyond the CONFLICT notices.
s19_rounds() {
    local key="$1" min="$2" step="phase 4: $1's rounds (refused)" id="${PERSONA_ID[$1]}" rounds n i=0 s_pos s_us c_pos c_us prev last
    wait_for_count "${S19_ROUND_HEAD[${key}]}" $(( S19_ROUND_BASE[${key}] + min )) $(( min * (INTERVAL_S + 2 * SETTLE_S) )) \
        "${step}: fewer than ${min} round lines"
    n=$(( $(count_log "${S19_ROUND_HEAD[${key}]}") - S19_ROUND_BASE[${key}] ))
    expect_count "${S19_ROUND_REFUSED[${key}]}" $(( S19_REFUSED_BASE[${key}] + n )) "${step}: refused round lines"
    rounds="$(latch_rounds "${step}" "${id}" "${S19_CALL[${key}]}" "${S19_LATCH_MARK[${key}]}")"
    (( $(rows_count "${rounds}") == n )) || fail "${step}: $(rows_count "${rounds}") rounds of ${id} after the latch, not ${n}"
    prev="${S19_LATCH_US[${key}]}"
    last="${S19_LATCH_MARK[${key}]}"
    while read -r s_pos s_us c_pos c_us; do
        i=$(( i + 1 ))
        check_cadence "${step}: round ${i}" "${prev}" "${s_us}" "${c_us}" "${S19_CALL[${key}]}"
        echo "${TEST_NAME}: ${step}: round ${i}: status at shim line ${s_pos}, ${S19_CALL[${key}]} at ${c_pos}"
        prev="${s_us}"
        last="${c_pos}"
    done <<< "${rounds}"
    if [[ "${key}" == "${SCAN_KEY}" ]]; then
        n="$(store_rows_of "${step}" "${id}")" || exit 1
        [[ "${n}" == 0 ]] || fail "${step}: the store holds ${n} row(s) with id ${id}, not none"
        s19_scan_trail "${step}"
    else
        store_row "${step}" "${id}"
        [[ "${STORE_STATE}" == "${S19_LATCH_STATE[${key}]}" && "${STORE_RV}" == "${S19_LATCH_RV[${key}]}" ]] \
            || fail "${step}: ${id} reads ${STORE_STATE} at row_version ${STORE_RV}, not ${S19_LATCH_STATE[${key}]} at ${S19_LATCH_RV[${key}]}"
    fi
    has_session_id "${S19_SID[${key}]}" || fail "${step}: the seeded session ${S19_SID[${key}]} is gone"
    n="$(posts_since "${key}" "${S19_POSTS_BEFORE[${key}]}")"
    (( n == S19_CONFLICTS[${key}] )) \
        || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the second life began, not the ${S19_CONFLICTS[${key}]} CONFLICT notice(s)"
    S19_ROUNDS[${key}]="${i}"
    S19_PREV_US[${key}]="${prev}"
    S19_LAST_POS[${key}]="${last}"
    echo "${TEST_NAME}: ${step}: ${i} refused round(s); ${id}: ${S19_LATCH_STATE[${key}]}${S19_LATCH_RV[${key}]:+ at row_version ${S19_LATCH_RV[${key}]}}"
}

# s19_end <key> [harness]: the human ends persona <key>'s seeded session by
# its session id (`end_session`).
s19_end() {
    local key="$1"
    S19_CONNECTS[${key}]="$(count_log "[slack] Session connected: persona $(persona_ref "${PERSONA_NAME[${key}]}")")"
    end_session "${S19_SID[${key}]}"
    echo "${TEST_NAME}: $2: the harness ended ${PERSONA_NAMED[${key}]} (${S19_SID[${key}]}) of ${key}"
}

# s19_clear <key> <label>: the round after the harness ended the session:
# its first two calls are one `status` then the persona's re-check call, at
# the cadence, with no CSCB find-missing between them; the call launches: the
# latch clears (latchClearedLine, reason "a retry of the refused operation
# was not refused", posted), the persona reaches `waiting` (the pending
# variant on a fresh claude_session_id, recorded as PEND_REUSED_SID, not its
# first life's) and the server registers its
# MCP session; exactly one recovery post, the printed recovery notice, and
# no post beyond it and the CONFLICT notices.
s19_clear() {
    local key="$1" step="$2: $1's clear" id="${PERSONA_ID[$1]}" name="${PERSONA_NAME[$1]}" session="${S19_SESSION[$1]}"
    local rows s_pos s_time s_verb c_pos c_time c_verb c_args between cleared recovery n ref
    ref="$(persona_ref "${name}")"
    wait_for_count "${S19_ROUND_HEAD[${key}]}" $(( S19_ROUND_BASE[${key}] + S19_ROUNDS[${key}] + 1 )) $(( INTERVAL_S + 2 * SETTLE_S )) \
        "${step}: no round line after the session ended"
    rows="$(ad_cscb_calls "${id}" "${S19_LAST_POS[${key}]}")"
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    IFS=$'\t' read -r c_pos c_time _ c_verb _ c_args <<< "$(sed -n 2p <<< "${rows}")"
    if [[ "${s_verb}" != status ]] || ! round_call_is "${S19_CALL[${key}]}" "${c_verb}" "${c_args}"; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round's first calls of ${id} are '${s_verb}' and '${c_verb}', not status then ${S19_CALL[${key}]}"
    fi
    check_cadence "${step}" "${S19_PREV_US[${key}]}" "$(us_of "${s_time}")" "$(us_of "${c_time}")" "${S19_CALL[${key}]}"
    between="$(ad_cscb_verb_between find-missing "${s_pos}" "${c_pos}")"
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the round's status and its ${S19_CALL[${key}]}"; }

    # The retry was not refused: the latch clears, posted.
    cleared="$(fmk_text latchClearedLine "${key}" "${S19_CASE[${key}]}" "${session}" posted LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    if ! _scenario_poll_until "${SETTLE_S}" _scenario_log_has "${cleared}"; then
        latch_lines_of "${key}"
        fail "${step}: no clear line '${cleared}'"
    fi
    expect_count "${cleared}" 1 "${step}: the clear line"
    expect_count "${S19_ROUND_REFUSED[${key}]}" $(( S19_REFUSED_BASE[${key}] + S19_ROUNDS[${key}] )) "${step}: refused round lines"

    # The launch: the persona reaches waiting on its own session.
    wait_row "${step}: the launch's report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ -n "${ROW_SID}" ]] || fail "${step}: the launched row has no claude_session_id"
    if [[ "${key}" == "${PEND_KEY}" ]]; then
        # The reuse starts a fresh session, not the first life's.
        [[ "${ROW_SID}" != "${PERSONA_SID[${key}]}" ]] \
            || fail "${step}: the reused row's claude_session_id is the first life's ${PERSONA_SID[${key}]}, not a fresh session's"
        PEND_REUSED_SID="${ROW_SID}"
    fi
    [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the launched row records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
    wait_for_count "[slack] Session connected: persona ${ref}" $(( S19_CONNECTS[${key}] + 1 )) "${CONNECT_WAIT_S}" \
        "${step}: the server never registered the launched stub's session as ${key}'s"

    # Exactly one recovery post, the printed notice; nothing else posted.
    recovery="$(fmk_text formatPersonaNotice "${name}" conflictRecoveryText "${session}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    wait_until "${NOTICE_WAIT_S}" "${step}: no recovery post on ${PERSONA_CHANNEL[${key}]}" \
        posts_holding_at_least "${key}" "${S19_POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}" 1
    posts_holding "${key}" "${S19_POSTS_BEFORE[${key}]}" "${RECOVERY_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed recovery notice"
    fi
    posts_holding "${key}" "${S19_POSTS_BEFORE[${key}]}" "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == S19_CONFLICTS[${key}] )) \
        || fail "${step}: ${#HOLDING[@]} posts hold the CONFLICT notice head, not ${S19_CONFLICTS[${key}]}"
    n="$(posts_since "${key}" "${S19_POSTS_BEFORE[${key}]}")"
    (( n == S19_CONFLICTS[${key}] + 1 )) \
        || fail "${step}: ${PERSONA_CHANNEL[${key}]} holds ${n} posts since the second life began, not the CONFLICT notice(s) and the recovery post"
    if [[ "${key}" == "${SCAN_KEY}" ]]; then
        # The launching plain spawn met no leftover: no not_inserted record.
        s19_scan_trail "${step}" "$(( $(rows_count "$(verb_rows spawn "$(ad_cscb_calls "${id}" "${LIFE2_MARK}")")") - 1 ))"
    fi
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with claude_session_id ${ROW_SID}; one recovery post"
}

# s19_no_kill <label>: no CSCB `kill`, `kill-finished` or `delete` names a
# scenario 19 persona's id from the second life on.
s19_no_kill() {
    local key id rows verb n
    for key in "${S19_KEYS[@]}"; do
        id="${PERSONA_ID[${key}]}"
        rows="$(ad_cscb_calls "${id}" "${LIFE2_MARK}")"
        for verb in kill kill-finished delete; do
            n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
            (( n == 0 )) || fail "$1: ${n} CSCB ${verb} call(s) of ${id} from the second life on"
        done
    done
    echo "${TEST_NAME}: $1: no kill, kill-finished or delete of a scenario 19 persona's row"
}

phase4_second_life() {
    local step="phase 4: second life" completions key
    S4_POSTS_BEFORE="$(post_count "${S4_KEY}")"
    for key in "${S19_KEYS[@]}"; do
        S19_POSTS_BEFORE[${key}]="$(post_count "${key}")"
    done
    # A start runs the state dir's last-applied record, so the second life,
    # which adds scenario 19's personas, starts in a state dir of its own.
    new_state_dir second-life
    write_personas_config "${LIFE2_KEYS[@]}"
    LIFE2_MARK="$(ad_shim_mark)"
    LIFE2_TMUX_MARK="$(tmux_shim_mark)"
    completions="$(count_log "$(completion_match "${#LIFE2_KEYS[@]}")")"
    start_server --live
    LIFE2_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${#LIFE2_KEYS[@]}")" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${#LIFE2_KEYS[@]}")" | sed 's/^.*\] //')"
    s4_latch
    for key in "${SCAN_KEY}" "${ENV_KEY}" "${STORE_KEY}"; do
        s19_latch "${key}" "phase 4" "${LIFE2_MARK}" "${LIFE2_PID}" 1 "${S19_POSTS_BEFORE[${key}]}" "${START_WAIT_S}"
    done
    s19_pending_marked
    s19_latch "${PEND_KEY}" "phase 4" "${LIFE2_MARK}" "${LIFE2_PID}" 1 "${S19_POSTS_BEFORE[${PEND_KEY}]}" "${SETTLE_S}"
    s4_refused_rounds
    s19_rounds "${SCAN_KEY}" 2
    s19_rounds "${ENV_KEY}" 2
    s19_rounds "${STORE_KEY}" 2
    s19_rounds "${PEND_KEY}" 1
    # [harness] The human ends the environment-only, another store's and the
    # pending variant's sessions; scenario 4's follows in s4_clear.
    for key in "${ENV_KEY}" "${STORE_KEY}" "${PEND_KEY}"; do
        s19_end "${key}" "phase 4"
    done
    s4_clear
    for key in "${ENV_KEY}" "${STORE_KEY}" "${PEND_KEY}"; do
        s19_clear "${key}" "phase 4"
    done
    # The scan refusal stays latched, retried as a plain spawn.
    s19_rounds "${SCAN_KEY}" 3
    s4_no_kill
    s19_no_kill "phase 4"
}

# ---------------------------------------------------------------------------
# Phase 5: the restart leg (scenario 19, E13; AC 45)
# ---------------------------------------------------------------------------

# latch_line_count <key>: how many conflict-latch lines name persona <key>
# (its latch-set, relatch and clear lines; the head is the package's
# conflictLatchSetLine up to its `latched`).
latch_line_count() {
    local line
    line="$(fmk_text conflictLatchSetLine "$1" "${CASE_LEFTOVER}" SESSIONSLOT "${OP_PLAIN_SPAWN}" "${ROW_NO_ROW}")" \
        || fail "phase 5: fmk-texts.ts could not print conflictLatchSetLine"
    count_log "${line%%latched*}"
}

phase5_restart_leg() {
    local label="phase 5" step="phase 5: restart" key completions n
    local -A posts=() lines=()
    for key in "${LIFE2_KEYS[@]}"; do
        posts[${key}]="$(post_count "${key}")"
        lines[${key}]="$(latch_line_count "${key}")"
    done
    # A plain stop: the bots keep running.
    stop_server
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    has_session_id "${S19_SID[${SCAN_KEY}]}" || fail "${step}: the seeded leftover ${S19_SID[${SCAN_KEY}]} is gone"
    RESTART_MARK="$(ad_shim_mark)"
    completions="$(count_log "$(completion_match "${#LIFE2_KEYS[@]}")")"
    start_server --live
    RESTART_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${#LIFE2_KEYS[@]}")" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${#LIFE2_KEYS[@]}")" | sed 's/^.*\] //')"

    # The bring-up's plain spawn meets the scan again: one new post.
    s19_latch "${SCAN_KEY}" "${label}" "${RESTART_MARK}" "${RESTART_PID}" 2 "${posts[${SCAN_KEY}]}" "${START_WAIT_S}"
    # [harness] The human ends the leftover; the next round's plain spawn
    # launches.
    s19_end "${SCAN_KEY}" "${label}"
    s19_clear "${SCAN_KEY}" "${label}"

    # No other persona latched or got a post at this start.
    for key in "${LIFE2_KEYS[@]}"; do
        [[ "${key}" != "${SCAN_KEY}" ]] || continue
        n="$(post_count "${key}")"
        (( n == posts[${key}] )) || fail "${step}: ${PERSONA_CHANNEL[${key}]} (${key}) got $(( n - posts[${key}] )) post(s) since the restart"
        n="$(latch_line_count "${key}")"
        (( n == lines[${key}] )) || { latch_lines_of "${key}"; fail "${step}: ${key} has $(( n - lines[${key}] )) new conflict-latch line(s) since the restart"; }
    done
    echo "${TEST_NAME}: ${step}: no other persona latched or got a post"
    s19_no_kill "${label}"
    n="$(rows_count "$(non_cscb_find_missing)")"
    (( n == 0 )) || fail "${step}: ${n} find-missing call(s) whose parent is not a CSCB process"
}

# end_workers [harness]: the human ends every persona's worker as a human
# ends Claude Code (the stub's exit line typed into its session's pane, as in
# phase 2), so each row reads `ended` or `missing` and the closing
# `stop --stop-bots` skips it: that stop's `pause` of a stub, which ignores
# the `/exit` a pause types, waits out its 30 s timeout before its kill, one
# persona after another, longer than the stop's 90 s bound for five.
end_workers() {
    local step="end: every worker ended by hand" key session
    for key in "${LIFE2_KEYS[@]}"; do
        session="${PERSONA_NAMED[${key}]}"
        "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" -l __CSCB_TEST_EXIT__ \
            || fail "${step}: could not type the stub's exit line into ${session}"
        "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" Enter || fail "${step}: could not send Enter into ${session}"
    done
    for key in "${LIFE2_KEYS[@]}"; do
        wait_row "${step}" "${EXIT_WAIT_S}" "${PERSONA_ID[${key}]}" ended missing
        wait_until "${EXIT_WAIT_S}" "${step}: session ${PERSONA_NAMED[${key}]} is still there after the worker's exit" \
            session_gone "${PERSONA_NAMED[${key}]}"
    done
    echo "${TEST_NAME}: ${step}: every row reads ended or missing; every persona's session is gone"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

slack_labels=()
for key in "${LIFE2_KEYS[@]}"; do
    slack_labels+=("${PERSONA_TOKEN[${key}]}")
done
start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${slack_labels[@]}"
phase1_first_life
phase2_stop_bots
phase3_seed
phase4_second_life
phase5_restart_leg

end_workers
stop_server --stop-bots
# The session each row ends on, where the script knows it: `nolabel`'s first
# life's (its resume kept the conversation), `pendleft`'s the one its reuse
# started.
declare -A END_SID=([${S4_KEY}]="${PERSONA_SID[${S4_KEY}]}" [${PEND_KEY}]="${PEND_REUSED_SID}")
for key in "${LIFE2_KEYS[@]}"; do
    read_row "end" "${PERSONA_ID[${key}]}"
    [[ -n "${ROW_STATE}" ]] && [[ -z "${END_SID[${key}]:-}" || "${ROW_SID}" == "${END_SID[${key}]}" ]] \
        || fail "end: ${PERSONA_ID[${key}]} reads '${ROW_STATE}' (${ROW_SID}) at the end"
    echo "${TEST_NAME}: end: ${PERSONA_ID[${key}]} is present, reading ${ROW_STATE}"
done
stop_tracked_pid "${SLACK_STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
