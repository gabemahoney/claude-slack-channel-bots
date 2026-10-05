#!/usr/bin/env bash
# Test 17 (HO §7 scenario 5; b.jg5 SRJ-1406, SRJ-401, SRJ-402, SRJ-404,
# SRJ-406, SRJ-407, SRJ-409, SRJ-410, SRJ-310, SRJ-710, SRJ-1306, SRJ-1401,
# SRJ-1418; AC 3, AC 29, AC 32): a launch in progress, in three legs, run in
# this order:
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
#   and the row reaches `waiting`, with no launch, kill or post (AC 32).
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml, so no `[tmux]` table);
# - the tmux shim first on every CSCB process's PATH, in `log` mode apart
#   from the launch-timeout legs' start (below);
# - the stub as `claude`, in `dev-channels` (no selection) in every persona's
#   working directory, with the dialog delay (`stub_dialog_delay`) where a
#   leg sets it;
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
#        the driver's only launch call;
#      - the row still reads `pending` and the pane still shows neither
#        needle once the driver has returned;
#      - health ticks run: the bot server reads P's status more often than
#        the approver reads the pane (each approver lap reads both; a tick
#        reads status only).
#   6. [harness] The pane is read until it shows the dev-channels needle (the
#      delay's end), then the row is read until it leaves `pending`: it reads
#      `waiting` with the same claude_session_id.
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
# `class` and `action`, the hold's status and pane-read counts, and every
# post across the leg.
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
#        LAUNCH_TIMEOUT_PHRASE, or its get line names CALL_TIMEOUT_NAME (E28
#        T3's ErrCallTimeout form); exactly one post-timeout get line, which
#        names a launch timeout and OUTCOME_APPROVER (the approver started);
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
#      - every retry line of the persona's retry timer is followed within
#        LT_RETRY_READ_S by a bot-server `status` or `get` of the row (and no
#        launch, above);
#      - no conflict-latch line names the persona;
#      and no post reaches the Slack stub's record from the start on (no
#      spawn-failure or CONFLICT notice among them).
#   The server is then stopped with a plain `stop`, and [harness] each worker
#   ends with the sentinel (`stop --stop-bots` would wait out each persona's
#   pause, which the stub never answers, before its kill).
# Recorded, not asserted (ruling S8): the start pass's summary line, each
# persona's agent-director calls with their times, the plain spawns'
# collision lines, the timeout-phrase and get lines, its tmux-unresponsive
# and retry-timer lines, and the reuse row's claude_session_id before and
# after.
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
#      - the old server's approver stopped at shutdown with no pending-row
#        rule run after it (SRJ-404): no PENDING_ROW_RULE_LOG_HEAD line names
#        Q in the old server's log lines;
#      - no post reaches the Slack stub's record in the leg.
#   The server is then stopped with a plain `stop`, and [harness] Q's worker
#   ends with the sentinel.
# Recorded, not asserted (ruling S8): the stop's and the start's times from
# L, both servers' calls of Q with their times, the old server's approver
# lines, and the new server's retry-timer and pending-row rule lines.
#
# Waits and their derivation (seconds):
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
#
# Matched values. CSCB's values are printed by fixtures/fmk-texts.ts from
# the installed package, never retyped: APPROVER_LOG_PREFIX,
# DEV_CHANNELS_DIALOG_NEEDLE, TRUST_DIALOG_NEEDLE, DIALOG_POLL_INTERVAL_MS and
# LAUNCH_UNAVAILABLE_OUTCOME_APPROVER (src/session-manager.ts); G and
# create_timeout_ms (src/ad-settings.ts DEFAULT_AD_SETTINGS.tmux
# .pending_grace_seconds and .create_timeout_ms); the call timeout
# (src/config.ts DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS);
# LAUNCH_TIMEOUT_PHRASE (src/ad-description-phrases.ts); CALL_TIMEOUT_NAME
# (src/ad-error-class.ts LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT);
# UNAVAILABLE_RETRY_BASE_S and UNAVAILABLE_RETRY_CEILING_S
# (src/unavailable-retry.ts); PENDING_ROW_RULE_LOG_HEAD (src/pending-row.ts);
# and each persona's tmux-unresponsive ended lines (src/persona-episodes.ts
# tmuxUnresponsiveEndedLine over the reasons of TMUX_UNRESPONSIVE_END_TEXT,
# entry `tmuxUnresponsiveEndedLines`).
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - the post-timeout get line's `[slack] spawnForPersona: one get after the `
#   (GET_LINE_HEAD), `of <ref> ended in ` and `a launch timeout (`
#   (LAUNCH_TIMEOUT_FORM) (src/session-manager.ts launchUnavailableGetLine
#   and LAUNCH_TIMEOUT_FORM_TEXT);
# - `[slack] spawnForPersona: collision resolved, state=` and `for <ref>`
#   (src/session-manager.ts runPersonaLadder's collision line);
# - `[slack] unavailable-retry: persona=<key> ` with `retry ` and `stopped`
#   (src/unavailable-retry.ts unavailableRetryRetryLine and
#   unavailableRetryStoppedLine);
# - `[slack] conflict-latch: persona=<key> ` (src/conflict-latch.ts, the
#   latch record's lines);
# - ` rule (` after PENDING_ROW_RULE_LOG_HEAD and the reference
#   (src/pending-row.ts, the rule's run line);
# - `persona=<key> ` with ` tmux-unresponsive ` (src/persona-episodes.ts
#   tmuxUnresponsiveLine), for the recorded condition lines;
# - `Scheduling restart for persona=<key>` (src/restart.ts scheduleRestart);
# - the hold's trouble words `reconnect`, `relaunch`, `Scheduling restart`
#   and `not connected` (src/restart.ts, src/session-manager.ts; matched
#   case-insensitively on lines naming P's key or reference);
# - the driver's outcome fields `called=`, `counted=`, `error=` (the
#   fmk-driver.ts outcome line) and ErrSpawnNotResumable (agent-director's
#   error name); ErrSpawnNotFound (agent-director's error name; a harness
#   `get` of a row not yet made reads `absent`);
# - the stub's sentinel `__CSCB_TEST_EXIT__` (fixtures/stub-claude.sh);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef) and the instance id
#   `cscb_<key>` (src/persona-identity.ts personaInstanceId).
#
# Closing: the script ends with `assert_no_server_tmux` (AC 3's "the bot
# server starts no tmux process", over every leg's servers, the slow-create
# start's included), `assert_no_cscb_include_finished` and
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

# Fragments with no exported builder (see the header).
GET_LINE_HEAD='[slack] spawnForPersona: one get after the '
LAUNCH_TIMEOUT_FORM='a launch timeout ('

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

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value for <entry>.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
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
# row <id>.
server_calls_of() {
    local id="$1" verb="$2" from="$3" to="$4" lines=()
    shift 4
    mapfile -t lines < <(cscb_ad_calls "${verb}" "--claude-instance-id ${id}" "$@")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" -v a="${from}" -v b="${to}" \
        '$4 == p && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)'
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
# line, from any parent, whose words hold <verb> and P's row id, with a time
# in (<from>, <to>] (`-` for no bound).
any_calls_naming() {
    any_calls_naming_of "${P_ID}" "$@"
}

# any_calls_naming_of <id> <verb> <from> <to>: `any_calls_naming` for row <id>.
any_calls_naming_of() {
    awk -F'\t' -v v="$2" -v id="$1" -v a="$3" -v b="$4" '
        $1 == "call" && index($6, v) && index($6, id) \
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
CALL_TIMEOUT_NAME="$(fmk_text LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT)" || fail "setup: fmk-texts.ts could not print LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT"
PENDING_ROW_HEAD="$(fmk_text PENDING_ROW_RULE_LOG_HEAD)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_LOG_HEAD"
[[ -n "${CALL_TIMEOUT_NAME}" && -n "${PENDING_ROW_HEAD}" ]] || fail "setup: fmk-texts.ts printed an empty value"
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

# ---------------------------------------------------------------------------
# Scenario 5's leg
# ---------------------------------------------------------------------------

leg_launch_pending() {
    local step="scenario 5" creds work connected sid session sentinel_at resume_line resume_at
    local hold_at hold_log0 hold_log1 posts0 launch_ms drv_out drv_err drv_rc=0 drv_at drv_end drv_s
    local drv_line drv_pid outcome=() lines=() line verb launches=0 pane="${SCENARIO_ROOT}/p-pane.txt"
    local deadline last_clear="" dialog_at="" live_at statuses panes n first_send first_read hits
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

    # Step 7: the checks. Health ticks ran in the hold: more bot-server
    # status reads of P than approver pane reads.
    statuses="$(server_count status "${hold_at}" "${last_clear}")"
    panes="$(server_count read-pane "${hold_at}" "${last_clear}")"
    echo "${TEST_NAME}: ${step}: in the hold before the dialog: ${statuses} status read(s) and ${panes} read-pane call(s) of P by the bot server"
    (( statuses > panes )) \
        || fail "${step}: the bot server read P's status ${statuses} time(s) and its pane ${panes} time(s) in the hold: no health tick read it"

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
        | grep -F -e "persona=${P_KEY}" -e "${P_REF}" | grep -iE "${HOLD_TROUBLE}" || true)"
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
        [[ -n "$(log_hits "$1" "${GET_LINE_HEAD}" "of ${LT_REF[${role}]} ended in ")" ]] || return 1
    done
}

# lt_timers_stopped <from-line>: true once each launch-timeout persona's retry
# timer has a stopped line after server.log line <from-line>.
lt_timers_stopped() {
    local role
    for role in "${LT_ROLES[@]}"; do
        [[ -n "$(log_hits "$1" "[slack] unavailable-retry: persona=${LT_KEY[${role}]} stopped")" ]] || return 1
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
        mapfile -t hits < <(log_hits "${log0}" "${TIMEOUT_PHRASE}" | grep -F -e "persona=${key} " -e "${ref}" || true)
        mapfile -t lines < <(log_hits "${log0}" "${GET_LINE_HEAD}" "of ${ref} ended in ")
        (( ${#lines[@]} == 1 )) || fail "${step}: ${role}: ${#lines[@]} post-timeout get line(s) for ${ref}, not one"
        echo "${TEST_NAME}: ${step}: ${role}: ${#hits[@]} server.log line(s) naming it carry the launch-timeout phrase; its get line: $(cut -f3 <<< "${lines[0]}")"
        (( ${#hits[@]} > 0 )) || [[ "${lines[0]}" == *"${LAUNCH_TIMEOUT_FORM}${CALL_TIMEOUT_NAME})"* ]] \
            || fail "${step}: ${role}: no server.log line naming ${ref} carries the launch-timeout phrase, and its get line names no ${CALL_TIMEOUT_NAME}"
        [[ "${lines[0]}" == *"${LAUNCH_TIMEOUT_FORM}"* && "${lines[0]}" == *"${OUTCOME_APPROVER}"* ]] \
            || fail "${step}: ${role}: its get line names no launch timeout or did not start the approver"

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
        echo "${TEST_NAME}: ${step}: ${role}: its tmux-unresponsive condition (recorded): $(log_hits "${log0}" "persona=${key} " | cut -f3 | grep -F " tmux-unresponsive " | cut -c1-200 | tr '\n' '|')"

        # Every retry reads the row (status or get) within LT_RETRY_READ_S and
        # launches nothing (above); the retry lines are recorded.
        echo "${TEST_NAME}: ${step}: ${role}: its retry timer (recorded): $(log_hits "${log0}" "[slack] unavailable-retry: persona=${key} " | cut -f3 | cut -c1-200 | tr '\n' '|')"
        mapfile -t lines < <(log_hits "${log0}" "[slack] unavailable-retry: persona=${key} retry " | cut -f2)
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
    local spawn_at first_pane send posts=() lines=()

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
    # The old server's approver stopped at shutdown with no pending-row run after it (SRJ-404).
    n="$(count_in <(head -n "${log0}" "${SLACK_STATE_DIR}/server.log") "$(matcher "${PENDING_ROW_HEAD} ${Q_REF} rule (")")"
    (( n == 0 )) || fail "${step}: the old server logged ${n} pending-row rule run(s) for Q"
    echo "${TEST_NAME}: ${step}: the old server's approver lines for Q (recorded): $(head -n "${log0}" "${SLACK_STATE_DIR}/server.log" | grep -F -- "${APPROVER_PREFIX}" | grep -F -- "${Q_REF}" | cut -c1-200 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: the new server's retry and pending-row lines for Q (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "persona=${Q_KEY} " -e "${PENDING_ROW_HEAD} ${Q_REF}" | cut -c1-260 | tr '\n' '|')"
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

leg_launch_pending
leg_launch_timeouts
leg_restart_mid_launch

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
