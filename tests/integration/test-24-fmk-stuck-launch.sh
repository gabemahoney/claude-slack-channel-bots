#!/usr/bin/env bash
# Test 24 (HO §7 scenario 21; b.jg5 SRJ-1423, SRJ-410, SRJ-412, SRJ-404,
# SRJ-405, SRJ-406, SRJ-1017, SRJ-120, SRJ-705, SRJ-1401, SRJ-1418; AC 9): a
# launch stuck at a startup prompt CSCB's approver does not recognise, in
# legs run in this order:
# - the own-launch leg (`leg_own_stuck_launch`): a resumed launch this server
#   started, held at the stub's unrecognised dialog, stays `pending`; CSCB
#   makes no `find-missing` run before G from its launch start; after G its
#   pending-row rule's runs, at most one per retry-timer interval, leave the
#   row unjudged (the worker's process is seen), and each is treated as not
#   judged; at B the approver stops with a log line only, the rule's run at
#   that stop makes one relaunching post, then one `kill` with `kill_sent`
#   true, which ends the worker; a `find-missing` run after the kill marks the
#   row `missing`, and a `resume` of the same session id follows, with no
#   counted failure and no other post;
# - the other-process leg (`leg_other_process`): a `pending` row the server
#   did not launch (the harness's own `resume`, playing another process) gets
#   one held post naming the session and a human's remedies, no second held
#   post at a later retry, and no `kill`.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml, so no `[tmux]` table);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`: `dev-channels` (no selection) in a working
#   directory until a leg selects `unrecognised-dialog` (a startup dialog no
#   approver needle matches; it reports in on the first line that reaches its
#   stdin) or `at-once` there (`stub_mode`; a stub reads its directory's
#   selection when it starts, so a selection holds from the next launch);
# - CSCB's config: `health_check_interval` 0 (ruling S3: no tick is needed;
#   the retry timer drives every pending-row run), `session_restart_delay` 5,
#   `exit_timeout` 5;
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record), one stub per leg,
#   each answering ok only for that leg's persona's token pair;
# - each leg in its own state dir (`new_state_dir`), with one persona, so the
#   leg's persona's `pending` row is the only one the pending-row rule runs
#   on (`find-missing` carries no instance id).
#
# The own-launch leg (`leg_own_stuck_launch`), in run order, persona P
# (working directory `own`). Steps marked [harness] are the harness playing a
# human from the scenario's own shell; no CSCB process makes them.
#   1. The live start brings P up: the stub holds at the dev-channels dialog,
#      the approver clears it, the row reads `waiting` with a
#      claude_session_id, the server registers the stub's MCP session as P's,
#      and the bring-up's approver has stopped (no bot-server pane read of P
#      for APPROVER_QUIET_S).
#   2. A plain `stop` (ruling S4), which leaves the worker running; [harness]
#      the worker ends with the stub's sentinel, sent into P's pane with the
#      real tmux, and a harness `get` reads the row `ended` (or `missing`)
#      with its claude_session_id.
#   3. [harness] P's working directory is selected for `unrecognised-dialog`,
#      then a live start: its start pass resumes P (the collision ladder's
#      plain spawn collides, its `get` reads the finished row, then one
#      `resume`), a launch this server makes.
#   4. [harness] The row reads `pending` with the same claude_session_id and a
#      launch start L that parses; P's pane shows neither approver needle;
#      the worker's process (the pane's process) is noted.
#   5. [harness] P's working directory is selected for `at-once`: the held
#      stub keeps its dialog, and the relaunch, the next launch in the
#      directory, reports in at once.
#   6. [harness] The row is read every HOLD_POLL_S until the bot server's
#      `kill` of P's row is in the shim's log, bounded at ABORT_WAIT_S from L.
#   7. [harness] The row is read until it is live, bounded at RELAUNCH_WAIT_S
#      from L: it reads `waiting` with the same claude_session_id, and the
#      server registers the relaunched stub's session as P's.
#   8. Checks, over the bot server's agent-director calls (`call_table`) and
#      its log lines from the start of step 3:
#      - every harness read before the kill reads `pending` with launch
#        start L, the last within HOLD_READ_GAP_S of the kill;
#      - no bot-server `find-missing` from L to G after it;
#      - the bot server's `find-missing` runs from G to the kill: the run at
#        the approver's stop is the first after the approver's line at B, and
#        the last before the kill; every other run is a retry's, at least one,
#        each with one pending-row rule line of origin
#        PENDING_ROW_RULE_ORIGIN_RETRY whose run reads
#        PENDING_ROW_RUN_NOT_JUDGED, and consecutive runs are at least
#        2 × UNAVAILABLE_RETRY_BASE_S apart (see the waits), the gap that
#        ends at the approver's stop's run excepted;
#      - exactly one server.log line equal to the approver's line at B
#        (`approverBoundLine`), measured from the launch start;
#      - the rule's run at that stop: one line of origin
#        PENDING_ROW_RULE_ORIGIN_APPROVER_STOP whose run reads
#        PENDING_ROW_RUN_NOT_JUDGED, and exactly one line equal to
#        `pendingRowRuleApproverStopRelaunchLine` (the relaunching post, the
#        abort, the live-row sequence started);
#      - exactly one relaunching poster line (`stuckLaunchPostLine`, mark
#        `relaunching`, answer `posted`), written before the kill, and no
#        held poster line;
#      - exactly one post in the Slack stub's record from the start on: the
#        relaunching post, equal to `stuckLaunchRelaunchingPost` (so no post
#        from the approver, no spawn-failure post and no held post);
#      - exactly one `kill` of P's row from any CSCB process in the leg, the
#        bot server's, carrying no `--include-finished`; one abort kill line
#        starting with `stuckLaunchAbortKillSucceededHead` (`kill_sent`
#        true); P's worker process is gone after it;
#      - a bot-server `find-missing` after the kill, then one live-row
#        sequence run line marking the row `missing`
#        (`liveRowSequenceStep3MarkedMissingLines`), then a bot-server `get`
#        of the row, then the leg's second bot-server `resume` of the row,
#        after its last `find-missing`;
#      - exactly two bot-server `resume`s of P's row in the leg (the start
#        pass's, before the kill, and the relaunch, after it); no reuse spawn
#        of P's row, and no spawn of it after the start pass's `resume`;
#      - no counted failure: no server.log line naming P with a counted
#        launch failure or the restart cap.
#   The server is then stopped with a plain `stop`, and [harness] P's worker
#   ends with the sentinel.
# Recorded, not asserted (ruling S8): the start pass's summary, the bot
# server's calls of P's row and its `find-missing` runs with their times from
# L, P's pending-row rule, retry-timer, abort and live-row sequence lines,
# the startup-errors.log lines naming P, the trail's kill records for P's row
# (`ad.kill.called`), and the relaunched worker's process.
#
# The other-process leg (`leg_other_process`), in run order, persona Q
# (working directory `other`); the leg's server launches nothing for Q's
# held row, so its `pending` row is never CSCB's own (SRJ-412).
#   1. The live start brings Q up as in the own-launch leg's step 1.
#   2. A plain `stop`; [harness] the worker ends with the sentinel, and the
#      row reads `ended` (or `missing`) with its claude_session_id.
#   3. [harness] Q's working directory is selected for `unrecognised-dialog`.
#   4. [harness, playing another process] The harness resumes Q's row from
#      the scenario's own shell (`resume --claude-instance-id cscb_<Q>`
#      through the harness call). The row reads `pending` with the same
#      claude_session_id and a launch start L; Q's pane shows neither
#      approver needle.
#   5. [harness] At L + OTHER_START_AFTER_S, a live start: its start pass
#      finds Q's row `pending` (its collision ladder's plain spawn collides,
#      and its collision line reads `pending`), which arms Q's retry timer.
#   6. [harness] The leg waits for the held poster line (`stuckLaunchPostLine`,
#      mark `held`, answer `posted`), bounded at HELD_WAIT_S from L, then for
#      a later retry's held poster line with the answer `already-posted`,
#      bounded at AGAIN_WAIT_S from the first.
#   7. Checks, over every process's agent-director calls of Q's row and the
#      leg's log lines and posts:
#      - the only `resume` of Q's row is the harness's: one `call` line, whose
#        parent is the scenario's own shell;
#      - no CSCB process makes a reuse spawn or a `resume` of Q's row; the
#        bot server's one plain spawn of it is its start pass's ladder's
#        first step, followed by its collision line reading `pending`;
#      - no `kill` of Q's row from any CSCB process;
#      - exactly one post in the Slack stub's record from the start of step
#        5 on: the held post, equal to `stuckLaunchHeldPost` for Q's launch
#        start L with the attach remedy (`false`); no relaunching poster line
#        names Q.
#   8. [harness, playing a human] Enter is sent into Q's pane
#      (`stub_press_enter`): the stub reports in and the row reads `waiting`
#      within REPORT_WAIT_S. The record still holds the one held post. The
#      server is then stopped with a plain `stop`, and [harness] Q's worker
#      ends with the sentinel.
# Recorded, not asserted (ruling S8): the start pass's summary, the bot
# server's calls of Q's row and its `find-missing` runs with their times from
# L, Q's pending-row rule and retry-timer lines.
#
# Waits and their derivation (seconds). G is agent-director's default pending
# grace period (60 s), B CSCB's launch bound at agent-director's default
# settings (300 s), UNAVAILABLE_RETRY_BASE_S (30 s) and
# UNAVAILABLE_RETRY_CEILING_S (300 s) the retry timer's first and longest
# waits, all printed from the installed package (below):
# - the retry timer's waits double from UNAVAILABLE_RETRY_BASE_S after each
#   retry that finds the row still `pending` (b.jg5 SRJ-302); its first retry
#   comes UNAVAILABLE_RETRY_BASE_S after the launch returned, before G
#   (checked: G > UNAVAILABLE_RETRY_BASE_S), so it finds the row `pending`,
#   and every wait after it is at least 2 × UNAVAILABLE_RETRY_BASE_S: the
#   bound the own-launch leg's runs from G to the abort are held to (SRJ-410:
#   "at least 60 s apart once a retry has found the row pending");
# - APPROVER_QUIET_S is three laps at the approver's pace before G
#   (DIALOG_POLL_INTERVAL_MS), rounded up to whole seconds: a running
#   approver reads the pane every lap while the row is pending, so that long
#   with no pane read after the row read `waiting` means it has stopped;
# - ABORT_WAIT_S = B + ABORT_SLACK_S from L: the approver stops at B from the
#   launch start, and the rule's run at that stop makes its lap, its run, its
#   `get`, the post and the kill;
# - RELAUNCH_WAIT_S = B + UNAVAILABLE_RETRY_CEILING_S + RELAUNCH_SLACK_S from
#   L: the abort comes at B, and no retry wait is longer than the ceiling;
#   RELAUNCH_SLACK_S covers the sequence's `find-missing` runs (5 s apart),
#   its `resume`, the stub's report-in and the harness's read;
# - HOLD_POLL_S is the harness's read interval while the row is held, and
#   HOLD_READ_GAP_S bounds the last read before the kill;
# - OTHER_START_AFTER_S = B − 3 × UNAVAILABLE_RETRY_BASE_S +
#   OTHER_START_MARGIN_S from L: the start arms Q's retry timer, whose second
#   retry comes 3 × UNAVAILABLE_RETRY_BASE_S after it, so at B from L or
#   later (step 3 of the rule, the held post); its first retry comes at
#   B − 2 × UNAVAILABLE_RETRY_BASE_S + OTHER_START_MARGIN_S from L or later,
#   at or after G (checked), so it makes the rule's lap and run; its third
#   retry comes 4 × UNAVAILABLE_RETRY_BASE_S after the second;
# - HELD_WAIT_S = B + UNAVAILABLE_RETRY_CEILING_S + HELD_SLACK_S from L, and
#   AGAIN_WAIT_S = UNAVAILABLE_RETRY_CEILING_S + HELD_SLACK_S from the held
#   post: no retry wait is longer than the ceiling.
#
# Matched values. CSCB's values are printed by fixtures/fmk-texts.ts from
# the installed package, never retyped: APPROVER_LOG_PREFIX,
# DEV_CHANNELS_DIALOG_NEEDLE, TRUST_DIALOG_NEEDLE and DIALOG_POLL_INTERVAL_MS
# (src/session-manager.ts); G (src/ad-settings.ts
# DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds) and B (src/ad-settings.ts
# adLaunchBoundMs over DEFAULT_AD_SETTINGS_IN_EFFECT);
# UNAVAILABLE_RETRY_BASE_S and UNAVAILABLE_RETRY_CEILING_S
# (src/unavailable-retry.ts); PENDING_ROW_RULE_LOG_HEAD,
# PENDING_ROW_RUN_NOT_JUDGED, PENDING_ROW_RULE_ORIGIN_RETRY and
# PENDING_ROW_RULE_ORIGIN_APPROVER_STOP (src/pending-row.ts); the approver's
# line at B (`approverBoundLine`: src/session-manager.ts approverLogLine over
# approverBoundMessage with APPROVER_BOUND_FROM_LAUNCH_START); the rule's
# approver-stop line (`pendingRowRuleApproverStopRelaunchLine`:
# src/session-manager.ts pendingRowRuleApproverStopLine); the relaunching
# and held posts (`stuckLaunchRelaunchingPost`, `stuckLaunchHeldPost`:
# src/persona-notifier.ts formatPersonaNotice over src/pending-row.ts
# stuckLaunchRelaunchingText and stuckLaunchHeldText, whose launch start is
# rendered by describeLaunchStartForLog, recorded through the entry of that
# name); the poster's lines (`stuckLaunchPostLine`, src/pending-row.ts); the
# abort kill's line up to what follows (`stuckLaunchAbortKillSucceededHead`:
# src/pending-row.ts stuckLaunchAbortKillLine over src/checked-kill.ts
# describeKillOutcome, the source of `kill_sent`); and the live-row
# sequence's marked-missing run lines (`liveRowSequenceStep3MarkedMissingLines`:
# src/live-row-sequence.ts liveRowSequenceRunLine). Fragments with no
# exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - `[slack] spawnForPersona: collision resolved, state=pending for <ref>`
#   (src/session-manager.ts runPersonaLadder's collision line; `pending` is
#   agent-director's state name);
# - ` rule (` after PENDING_ROW_RULE_LOG_HEAD and the reference, and
#   `find-missing: ` before the run's placement (src/pending-row.ts, the
#   rule's round line, pendingRowRuleRoundLine and createPendingRowRule's
#   step words);
# - `[slack] unavailable-retry: persona=<key> ` (src/unavailable-retry.ts,
#   the retry timer's lines), `[slack] live-row-sequence: <ref>`
#   (src/live-row-sequence.ts LIVE_ROW_SEQUENCE_LOG_PREFIX) and
#   `[slack] pending-row: persona=<key> stuck-launch` (src/pending-row.ts
#   stuckLaunchLineHead), for the recorded lines;
# - `[slack] Session relaunch failed for persona=<key>`, `[slack] Launch
#   failed for persona=<key>` and `[slack] Cap reached for persona=<key>`
#   (src/restart.ts runRestartWork, recordLaunchResultOutsideRestartWork and
#   countLaunchFailure: a counted launch failure and the restart cap);
# - the stub's sentinel `__CSCB_TEST_EXIT__` (fixtures/stub-claude.sh);
# - `ad.kill.called` and `claude_instance_id` (agent-director's trail record
#   of a kill, ADSRD SR-6.4), for the recorded trail;
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef) and the instance id
#   `cscb_<key>` (src/persona-identity.ts personaInstanceId).
#
# Closing: the script ends with `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell. Every count of CSCB's agent-director calls reads only shim lines
# whose parent is a CSCB process (the bot server); the harness's calls (its
# reads and its `resume`), the stub's own status reads and its stop lines
# never count, apart from the other-process leg's check that the harness's
# `resume` is the only one of Q's row, which reads every process's calls.
set -euo pipefail

TEST_NAME="test-24-fmk-stuck-launch"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona P (the own-launch leg). src/persona-identity.ts personaInstanceId: `cscb_<key>`.
P_NAME="${SCENARIO_TAG}_p"
P_KEY="$(persona_key "${P_NAME}")"
P_REF="$(persona_ref "${P_NAME}")"
P_ID="cscb_${P_KEY}"
P_CHANNEL="C0T24OWN1"
P_SUFFIX=t24p

# Persona Q (the other-process leg).
Q_NAME="${SCENARIO_TAG}_q"
Q_KEY="$(persona_key "${Q_NAME}")"
Q_REF="$(persona_ref "${Q_NAME}")"
Q_ID="cscb_${Q_KEY}"
Q_CHANNEL="C0T24OTH1"
Q_SUFFIX=t24q

# Bounds and slacks (seconds; see the header).
STUB_WAIT_S=20        # the Slack stub writing its ready file
START_WAIT_S=120      # a start pass: one bring-up or one launch
REPORT_WAIT_S=60      # after a start pass or an Enter: the row reporting in
CONNECT_WAIT_S=30     # after the row reported in: the server registering the stub's session
APPROVER_STOP_WAIT_S=20  # after the session connected: the bring-up's approver stopping
ENDED_WAIT_S=20       # after the sentinel: the row reading ended or missing
SESSION_WAIT_S=10     # after the first pending read: the session present
ABORT_SLACK_S=30
RELAUNCH_SLACK_S=60
HOLD_POLL_S=1
HOLD_READ_GAP_S=5
GONE_WAIT_S=10        # after the kill: the worker's process gone
OTHER_START_MARGIN_S=15
HELD_SLACK_S=40

# The fixtures.
FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# The stub's sentinel (fixtures/stub-claude.sh).
SENTINEL=__CSCB_TEST_EXIT__

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

# plus_s <time> <seconds>: print <time> + <seconds>, three decimals.
plus_s() {
    awk -v t="$1" -v d="$2" 'BEGIN { printf "%.3f\n", t + d }'
}

# before <a> <b>: true when time <a> is earlier than time <b>.
before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'
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

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# record_posts <from-line>: print the Slack stub record's posts (chat.* and
# files.* methods), one JSON object per line, from record line <from-line> on.
record_posts() {
    [[ -f "${SLACK_RECORD}" ]] || return 0
    tail -n "+$1" "${SLACK_RECORD}" \
        | jq -c 'select(.event == "api" and ((.method // "") | test("^(chat|files)\\.")))'
}

# persona_json <name> <credentials-file> <working-dir> <channel>: one persona
# object of the config.
persona_json() {
    jq -n -c --arg n "$1" --arg c "$2" --arg w "$3" --arg ch "$4" \
        '{name: $n, credentials_file: $c, working_directory: $w, channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}'
}

# write_personas_config <persona-json>...: the config with those personas,
# the health check off (`health_check_interval` 0, ruling S3).
write_personas_config() {
    printf '%s\n' "$@" | jq -s --argjson port "${SCENARIO_PORT}" \
        '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: 0, session_restart_delay: 5, exit_timeout: 5}' \
        | write_config
}

# write_credentials <dir> <suffix>: a credentials file for the token pair
# ending in <suffix>, at <dir>/<suffix>.json; print its path.
write_credentials() {
    local file="$1/$2.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "$2")" "$(fake_token app "$2")" \
        | write_file "${file}" 600
    printf '%s\n' "${file}"
}

# poll_row_of <id> <step>: a harness `get` of row <id>. Sets ROW_READ_AT (the
# time just before the call), ROW_STATE (`absent` for ErrSpawnNotFound),
# ROW_SID (claude_session_id), ROW_LAUNCH (launch_started_at as printed) and
# ROW_SESSION (tmux_session_name), each empty when absent.
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

# row_of_reads <id> <step> <state>...: read row <id>; true when its state is
# one of the <state>s.
row_of_reads() {
    local id="$1" step="$2" s
    shift 2
    poll_row_of "${id}" "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# launch_ms <text>: print a launch_started_at as epoch milliseconds; false
# when it does not parse.
launch_ms() {
    local ms
    ms="$(date -u -d "$1" +%s%3N 2> /dev/null)" && [[ "${ms}" =~ ^[0-9]+$ ]] && printf '%s\n' "${ms}"
}

# ms_to_s <ms>: print epoch milliseconds as seconds, three decimals.
ms_to_s() {
    awk -v m="$1" 'BEGIN { printf "%.3f\n", m / 1000 }'
}

# pane_capture <step> <session> <file>: a pane on the scenario's tmux server,
# read with the real tmux from the scenario's own shell, into <file>.
pane_capture() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -t "=$2:" > "$3" 2> "$3.err" \
        || fail "$1: tmux could not read the pane of session $2: $(head -c 300 "$3.err")"
}

# has_session <session>: true when the scenario's tmux server holds it.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# pane_pid_of <step> <session>: print the process of the session's pane (the
# stub, which is the pane's own process), read with the real tmux.
pane_pid_of() {
    local pids
    pids="$("${SCENARIO_REAL_TMUX}" list-panes -t "=$2:" -F '#{pane_pid}' 2> /dev/null)" \
        || fail "$1: tmux could not list the panes of session $2"
    [[ "${pids}" =~ ^[0-9]+$ ]] || fail "$1: session $2 has no single pane process ('${pids}')"
    printf '%s\n' "${pids}"
}

# expect_no_needle <step> <file>: fail when <file> holds either approver needle.
expect_no_needle() {
    local needle
    for needle in "${DEV_NEEDLE}" "${TRUST_NEEDLE}"; do
        ! grep -qF -- "${needle}" "$2" || fail "$1: the pane holds the approver needle '${needle}'"
    done
}

# hold_at_unrecognised_dialog <step> <session>: the session is present, and
# its pane shows neither approver needle.
hold_at_unrecognised_dialog() {
    local pane="${SCENARIO_ROOT}/pane-$2.txt"
    wait_until "${SESSION_WAIT_S}" "$1: no tmux session $2 for the held row" has_session "$2"
    pane_capture "$1" "$2" "${pane}"
    expect_no_needle "$1" "${pane}"
}

# end_worker <id> <step>: a plain stop has left row <id>'s worker running;
# end it with the stub's sentinel, sent into its pane with the real tmux, and
# wait until the row reads ended or missing.
end_worker() {
    poll_row_of "$1" "$2"
    [[ -n "${ROW_SESSION}" ]] || fail "$2: row $1 names no tmux session"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${ROW_SESSION}:" "${SENTINEL}" Enter \
        || fail "$2: could not send the sentinel into ${ROW_SESSION}"
    wait_until "${ENDED_WAIT_S}" "$2: row $1 never read ended or missing after the sentinel" \
        row_of_reads "$1" "$2" ended missing
}

# call_table <file>: write <file>, one TAB-separated line per agent-director
# shim `call` line whose parent is a CSCB process (`cscb_ad_calls`), in log
# order: its time, its PPID (the CSCB process), its verb, the row id its
# `--claude-instance-id` names (`-` when none) and its arguments joined by
# single spaces.
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

# server_calls_of <id> <verb>: print the agent-director shim's `call` lines
# naming row <id> whose parent is the bot server (SERVER_PID) and whose verb
# is <verb> (`cscb_ad_calls`).
server_calls_of() {
    local lines=()
    mapfile -t lines < <(cscb_ad_calls "$2" "--claude-instance-id $1")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" '$4 == p'
}

# approver_quiet_of <id>: true once the bot server's last pane read of row
# <id> (if any) is at least APPROVER_QUIET_S old.
approver_quiet_of() {
    local last
    last="$(server_calls_of "$1" read-pane | tail -n 1 | cut -f2)"
    [[ -z "${last}" ]] && return 0
    awk -v t="${last}" -v n="$(now_s)" -v q="${APPROVER_QUIET_S}" 'BEGIN { exit !(n - t >= q) }'
}

# server_killed <id> <srv>: true once the shim's log holds a `call` line whose
# parent is the bot server <srv> and whose words hold `kill` and row <id>.
server_killed() {
    awk -F'\t' -v p="$2" -v id="$1" '
        $1 == "call" && $4 == p && $6 ~ /(^| )kill( |$)/ && index($6, id) { found = 1 }
        END { exit !found }' "${SCENARIO_AD_SHIM_LOG}"
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

# log_lines_equal <from-line> <text>: print `<line number> TAB <time>` for
# each server.log line after <from-line> whose text after its time head is
# exactly <text>.
log_lines_equal() {
    local hit text
    while IFS= read -r hit; do
        text="${hit#*$'\t'*$'\t'}"
        text="${text#*] }"
        [[ "${text}" == "$2" ]] && printf '%s\n' "${hit%$'\t'*}"
    done < <(log_hits "$1" "$2")
    return 0
}

# log_lines_starting <from-line> <head>: as `log_lines_equal`, for each line
# whose text after its time head starts with <head>.
log_lines_starting() {
    local hit text
    while IFS= read -r hit; do
        text="${hit#*$'\t'*$'\t'}"
        text="${text#*] }"
        [[ "${text}" == "$2"* ]] && printf '%s\n' "${hit%$'\t'*}"
    done < <(log_hits "$1" "$2")
    return 0
}

# poster_line_seen <from-line> <text>: true once server.log holds a line
# equal to <text> after line <from-line>.
poster_line_seen() {
    [[ -n "$(log_lines_equal "$1" "$2")" ]]
}

# log_fragment_seen <from-line> <fragment>: true once server.log holds a line
# holding <fragment> after line <from-line>.
log_fragment_seen() {
    [[ -n "$(log_hits "$1" "$2")" ]]
}

# pid_gone <pid>: true once <pid> is not a live process.
pid_gone() {
    ! pid_alive "$1"
}

# bring_up <step> <id> <ref>: after a live start of one persona, the start
# pass completes with it brought up, its row reads `waiting` with a
# claude_session_id (BROUGHT_UP_SID), the server registers its session, and
# the bring-up's approver has stopped.
bring_up() {
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "$1: the start pass never completed"
    expect_completion 1 "$1" "0 not brought up"
    wait_until "${REPORT_WAIT_S}" "$1: row $2 never reported in (waiting) after the start" \
        row_of_reads "$2" "$1: bring-up" waiting
    BROUGHT_UP_SID="${ROW_SID}"
    [[ -n "${BROUGHT_UP_SID}" ]] || fail "$1: the live row $2 has no claude_session_id"
    # src/server.ts: the MCP session's registration line.
    wait_for_log "$(matcher "[slack] Session connected: persona $3")" "${CONNECT_WAIT_S}" \
        "$1: the server never registered the stub's session"
    wait_until "${APPROVER_STOP_WAIT_S}" "$1: the bot server still reads the pane of $2 ${APPROVER_STOP_WAIT_S}s after the bring-up" \
        approver_quiet_of "$2"
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

APPROVER_PREFIX="$(fmk_text APPROVER_LOG_PREFIX)" || fail "setup: fmk-texts.ts could not print APPROVER_LOG_PREFIX"
DEV_NEEDLE="$(fmk_text DEV_CHANNELS_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print DEV_CHANNELS_DIALOG_NEEDLE"
TRUST_NEEDLE="$(fmk_text TRUST_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print TRUST_DIALOG_NEEDLE"
PACE_MS="$(fmk_text DIALOG_POLL_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print DIALOG_POLL_INTERVAL_MS"
G_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds"
B_MS="$(fmk_text 'adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)')" \
    || fail "setup: fmk-texts.ts could not print adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)"
RETRY_BASE_S="$(fmk_text UNAVAILABLE_RETRY_BASE_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_BASE_S"
RETRY_CEILING_S="$(fmk_text UNAVAILABLE_RETRY_CEILING_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_CEILING_S"
PENDING_ROW_HEAD="$(fmk_text PENDING_ROW_RULE_LOG_HEAD)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_LOG_HEAD"
NOT_JUDGED="$(fmk_text PENDING_ROW_RUN_NOT_JUDGED)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RUN_NOT_JUDGED"
ORIGIN_RETRY="$(fmk_text PENDING_ROW_RULE_ORIGIN_RETRY)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_ORIGIN_RETRY"
ORIGIN_APPROVER_STOP="$(fmk_text PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)" \
    || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_ORIGIN_APPROVER_STOP"
[[ -n "${APPROVER_PREFIX}" && -n "${DEV_NEEDLE}" && -n "${TRUST_NEEDLE}" && -n "${PENDING_ROW_HEAD}" ]] \
    || fail "setup: fmk-texts.ts printed an empty value"
[[ -n "${NOT_JUDGED}" && -n "${ORIGIN_RETRY}" && -n "${ORIGIN_APPROVER_STOP}" ]] || fail "setup: fmk-texts.ts printed an empty value"
[[ "${PACE_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the approver's pace '${PACE_MS}' is not a whole number of milliseconds"
[[ "${G_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: G '${G_S}' is not a whole number of seconds"
[[ "${B_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: B '${B_MS}' is not a whole number of milliseconds"
[[ "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ && "${RETRY_CEILING_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the retry base '${RETRY_BASE_S}' or ceiling '${RETRY_CEILING_S}' is not a whole number of seconds"
B_S=$(( (B_MS + 999) / 1000 ))
# Three approver laps' worth of time, in whole seconds (at least one).
APPROVER_QUIET_S=$(( (3 * PACE_MS + 999) / 1000 ))
# The first retry, UNAVAILABLE_RETRY_BASE_S after the launch, comes before G,
# so every later retry wait is at least twice the base (see the header).
(( G_S > RETRY_BASE_S )) || fail "setup: G ${G_S}s is not longer than the retry timer's first wait ${RETRY_BASE_S}s"
(( B_S > G_S )) || fail "setup: B ${B_S}s is not longer than G ${G_S}s"
RUN_GAP_MIN_S=$(( 2 * RETRY_BASE_S ))
ABORT_WAIT_S=$(( B_S + ABORT_SLACK_S ))
RELAUNCH_WAIT_S=$(( B_S + RETRY_CEILING_S + RELAUNCH_SLACK_S ))
OTHER_START_AFTER_S=$(( B_S - 3 * RETRY_BASE_S + OTHER_START_MARGIN_S ))
(( OTHER_START_AFTER_S > 0 && OTHER_START_AFTER_S + RETRY_BASE_S >= G_S )) \
    || fail "setup: the other-process leg's start ${OTHER_START_AFTER_S}s after the launch start leaves its first retry before G ${G_S}s"
HELD_WAIT_S=$(( B_S + RETRY_CEILING_S + HELD_SLACK_S ))
AGAIN_WAIT_S=$(( RETRY_CEILING_S + HELD_SLACK_S ))
echo "${TEST_NAME}: G ${G_S}s, B ${B_S}s (${B_MS}ms), retry base ${RETRY_BASE_S}s, ceiling ${RETRY_CEILING_S}s; own-launch leg: abort bound ${ABORT_WAIT_S}s, relaunch bound ${RELAUNCH_WAIT_S}s, runs at least ${RUN_GAP_MIN_S}s apart; other-process leg: start ${OTHER_START_AFTER_S}s after the launch start, held-post bound ${HELD_WAIT_S}s, next-retry bound ${AGAIN_WAIT_S}s"

APPROVER_BOUND_LINE="$(fmk_text approverBoundLine "${P_REF}" "${B_MS}")" || fail "setup: fmk-texts.ts could not print approverBoundLine"
APPROVER_STOP_RELAUNCH_LINE="$(fmk_text pendingRowRuleApproverStopRelaunchLine "${P_REF}")" \
    || fail "setup: fmk-texts.ts could not print pendingRowRuleApproverStopRelaunchLine"
RELAUNCHING_POST="$(fmk_text stuckLaunchRelaunchingPost "${P_NAME}" "${P_KEY}" "${B_MS}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchRelaunchingPost"
P_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${P_KEY}" relaunching posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for P"
P_HELD_POSTED="$(fmk_text stuckLaunchPostLine "${P_KEY}" held posted)" || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for P"
ABORT_KILL_HEAD="$(fmk_text stuckLaunchAbortKillSucceededHead "${P_KEY}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchAbortKillSucceededHead"
MARKED_MISSING_LINES="$(fmk_text liveRowSequenceStep3MarkedMissingLines "${P_REF}")" \
    || fail "setup: fmk-texts.ts could not print liveRowSequenceStep3MarkedMissingLines"
Q_HELD_POSTED="$(fmk_text stuckLaunchPostLine "${Q_KEY}" held posted)" || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
Q_HELD_AGAIN="$(fmk_text stuckLaunchPostLine "${Q_KEY}" held already-posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
Q_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${Q_KEY}" relaunching posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
for v in APPROVER_BOUND_LINE APPROVER_STOP_RELAUNCH_LINE RELAUNCHING_POST P_RELAUNCHING_POSTED P_HELD_POSTED ABORT_KILL_HEAD \
    MARKED_MISSING_LINES Q_HELD_POSTED Q_HELD_AGAIN Q_RELAUNCHING_POSTED; do
    [[ -n "${!v}" ]] || fail "setup: fmk-texts.ts printed an empty ${v}"
done

# ---------------------------------------------------------------------------
# The own-launch leg: CSCB's own resumed launch, aborted once at B and resumed
# ---------------------------------------------------------------------------

leg_own_stuck_launch() {
    local step="own stuck launch" creds="${SCENARIO_ROOT}/credentials-own" creds_file work sid session srv log0 posts0 leg_start
    local l_ms l_s g_at b_at worker deadline kill_at live_at="" reads="${SCENARIO_ROOT}/own-reads.tsv"
    local table="${SCENARIO_ROOT}/own-calls.tsv" lines=() fms=() hits=() n i t bound_at stop_run_at gap
    local post_at resume_at fm_after get_at relaunch_at marked_at relaunched="" retry_rounds stop_rounds read_state read_launch

    new_state_dir own
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-own" "${P_SUFFIX}"
    work="$(make_workdir own)"
    creds_file="$(write_credentials "${creds}" "${P_SUFFIX}")"
    write_personas_config "$(persona_json "${P_NAME}" "${creds_file}" "${work}" "${P_CHANNEL}")"

    # Step 1: the live start brings P up.
    start_server --live
    bring_up "${step}: the bring-up" "${P_ID}" "${P_REF}"
    sid="${BROUGHT_UP_SID}"

    # Step 2: a plain stop, then [harness] the worker ends with the sentinel.
    stop_server
    end_worker "${P_ID}" "${step}: the worker"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the ${ROW_STATE} row's claude_session_id is '${ROW_SID}', not the live row's ${sid}"
    echo "${TEST_NAME}: ${step}: after the sentinel the row reads ${ROW_STATE} with claude_session_id ${ROW_SID}"

    # Step 3 [harness]: the unrecognised dialog, then the start pass's resume.
    stub_mode "${work}" unrecognised-dialog
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Step 4 [harness]: pending, the same session id, a launch start L; the pane holds no needle.
    wait_until "${START_WAIT_S}" "${step}: row ${P_ID} never read pending after the start" \
        row_of_reads "${P_ID}" "${step}: the resume" pending
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the pending row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(ms_to_s "${l_ms}")"
    g_at="$(plus_s "${l_s}" "${G_S}")"
    b_at="$(ms_to_s "$(( l_ms + B_MS ))")"
    session="${ROW_SESSION}"
    [[ -n "${session}" ]] || fail "${step}: the pending row names no tmux session"
    echo "${TEST_NAME}: ${step}: the held row reads pending, claude_session_id ${ROW_SID}, launch_started_at ${ROW_LAUNCH}"
    hold_at_unrecognised_dialog "${step}: the held launch" "${session}"
    worker="$(pane_pid_of "${step}" "${session}")"

    # Step 5 [harness]: the next launch in P's directory reports in at once.
    stub_mode "${work}" at-once

    # Step 6 [harness]: read the row until the bot server's kill, bounded from L.
    : > "${reads}"
    deadline=$(( l_ms + ABORT_WAIT_S * 1000 ))
    while ! server_killed "${P_ID}" "${srv}"; do
        poll_row_of "${P_ID}" "${step}: the hold"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: no bot-server kill of ${P_ID} within ${ABORT_WAIT_S}s of its launch start (B and ${ABORT_SLACK_S}s)"
        sleep "${HOLD_POLL_S}"
    done

    # Step 7 [harness]: read the row until it is live, bounded from L.
    deadline=$(( l_ms + RELAUNCH_WAIT_S * 1000 ))
    while :; do
        poll_row_of "${P_ID}" "${step}: the relaunch"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        case "${ROW_STATE}" in
            absent | ended | missing | pending) ;;
            *)
                live_at="${ROW_READ_AT}"
                break ;;
        esac
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: row ${P_ID} not live ${RELAUNCH_WAIT_S}s after its launch start (B, the retry ceiling and ${RELAUNCH_SLACK_S}s)"
        sleep "${HOLD_POLL_S}"
    done
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: the relaunched row came up ${ROW_STATE}, not waiting"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the relaunched row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered the relaunched stub's session as P's" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${P_REF}"
    echo "${TEST_NAME}: ${step}: the row read ${ROW_STATE} $(seconds_between "${l_s}" "${live_at}")s after its launch start, claude_session_id ${ROW_SID}; the harness reads in order (recorded): $(cut -f2 "${reads}" | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"

    # Step 8: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} in the leg, by verb (recorded): $(calls "${table}" "${srv}" "${P_ID}" - "${leg_start}" - | cut -f3 | sort | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} other than status and read-pane, from L (recorded): $(calls "${table}" "${srv}" "${P_ID}" - "${leg_start}" - | awk -F'\t' -v l="${l_s}" '$3 != "status" && $3 != "read-pane" { a = $5; sub(/ --label .*/, " …", a); printf "%+.1fs %s [%s]; ", $1 - l, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | awk -F'\t' -v l="${l_s}" '{ printf "%+.1fs ", $1 - l }')"

    # The one kill: the bot server's, no --include-finished.
    n="$(count_calls "${table}" - "${P_ID}" kill "${leg_start}" -)"
    (( n == 1 )) || fail "${step}: ${n} kill call(s) of ${P_ID} by a CSCB process in the leg, not one"
    kill_at="$(first_call_at "${table}" "${srv}" "${P_ID}" kill "${leg_start}" -)"
    [[ -n "${kill_at}" ]] || fail "${step}: the leg's kill of ${P_ID} is not the bot server's"
    n="$(calls "${table}" "${srv}" "${P_ID}" kill "${leg_start}" - | cut -f5 | grep -cE -- '(^| )--?include-finished(=| |$)' || true)"
    (( n == 0 )) || fail "${step}: the bot server's kill of ${P_ID} carries --include-finished"
    echo "${TEST_NAME}: ${step}: the abort kill at +$(seconds_between "${l_s}" "${kill_at}")s from L (B is +${B_S}s)"

    # The row stayed pending with launch start L until the kill.
    n="$(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0' "${reads}" | wc -l | tr -d ' ')"
    (( n > 0 )) || fail "${step}: no harness read of ${P_ID} before the kill"
    while IFS=$'\t' read -r t read_state read_launch; do
        [[ "${read_state}" == pending && "$(launch_ms "${read_launch}")" == "${l_ms}" ]] \
            || fail "${step}: a harness read at +$(seconds_between "${l_s}" "${t}")s, before the kill, reads ${read_state} (launch ${read_launch}), not pending with launch start L"
    done < <(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0' "${reads}")
    t="$(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0 { t = $1 } END { print t }' "${reads}")"
    awk -v t="${t}" -v k="${kill_at}" -v g="${HOLD_READ_GAP_S}" 'BEGIN { exit !(k - t <= g) }' \
        || fail "${step}: the last harness read before the kill came $(seconds_between "${t}" "${kill_at}")s before it, more than ${HOLD_READ_GAP_S}s"

    # No bot-server find-missing from L to G after it.
    n="$(count_calls "${table}" "${srv}" - find-missing "${l_s}" "$(plus_s "${g_at}" -0.001)")"
    (( n == 0 )) || fail "${step}: the bot server ran find-missing ${n} time(s) between P's launch start and G after it"

    # The approver's one line at B, measured from the launch start.
    mapfile -t hits < <(log_lines_equal "${log0}" "${APPROVER_BOUND_LINE}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} server.log line(s) equal to the approver's line at B, not one: ${APPROVER_BOUND_LINE}"
    bound_at="$(cut -f2 <<< "${hits[0]}")"
    awk -v a="${bound_at}" -v b="${b_at}" 'BEGIN { exit !(a + 0.5 >= b + 0) }' \
        || fail "${step}: the approver's line at B came $(seconds_between "${l_s}" "${bound_at}")s after the launch start, before B"
    before "${bound_at}" "${kill_at}" || fail "${step}: the approver's line at B came after the kill"
    echo "${TEST_NAME}: ${step}: the approver stopped at +$(seconds_between "${l_s}" "${bound_at}")s from L. Its lines naming P (recorded): $(log_hits "${log0}" "${APPROVER_PREFIX}" | cut -f3 | grep -F -- "${P_REF}" | cut -c1-220 | tr '\n' '|')"

    # The find-missing runs from G to the kill.
    mapfile -t fms < <(calls "${table}" "${srv}" - find-missing "${g_at}" "${kill_at}" | cut -f1)
    stop_run_at="$(calls "${table}" "${srv}" - find-missing "${bound_at}" "${kill_at}" | head -n 1 | cut -f1)"
    [[ -n "${stop_run_at}" ]] || fail "${step}: no bot-server find-missing between the approver's stop at B and the kill"
    [[ "${fms[-1]}" == "${stop_run_at}" ]] \
        || fail "${step}: $(( ${#fms[@]} )) find-missing run(s) from G to the kill, and the one at the approver's stop is not the last before the kill"
    (( ${#fms[@]} >= 2 )) || fail "${step}: no retry's find-missing run between G and the approver's stop at B"
    for (( i = 1; i < ${#fms[@]}; i++ )); do
        [[ "${fms[i]}" == "${stop_run_at}" ]] && continue
        gap="$(seconds_between "${fms[i - 1]}" "${fms[i]}")"
        awk -v g="${gap}" -v m="${RUN_GAP_MIN_S}" 'BEGIN { exit !(g + 0 >= m + 0) }' \
            || fail "${step}: two bot-server find-missing runs before the abort only ${gap}s apart, closer than ${RUN_GAP_MIN_S}s"
    done
    # Each retry's run: one pending-row rule line of origin retry, its run not judged.
    retry_rounds="$(log_hits "${log0}" "${PENDING_ROW_HEAD} ${P_REF} rule (${ORIGIN_RETRY})" "find-missing: " \
        | awk -F'\t' -v k="${kill_at}" '$2 + 0 <= k + 0')"
    n="$(grep -c . <<< "${retry_rounds}" || true)"
    (( n == ${#fms[@]} - 1 )) || {
        sed 's/^/  | /' <<< "${retry_rounds}" >&2
        fail "${step}: ${n} retry-origin pending-row rule round line(s) with a run before the kill, for $(( ${#fms[@]} - 1 )) retry run(s)"
    }
    n="$(grep -cvF -- "find-missing: ${NOT_JUDGED}" <<< "${retry_rounds}" || true)"
    (( n == 0 )) || fail "${step}: ${n} retry-origin rule round(s) before the abort did not read the run as not judged"
    # The rule's run at the approver's stop: its run not judged, then the relaunching post and the abort.
    stop_rounds="$(log_hits "${log0}" "${PENDING_ROW_HEAD} ${P_REF} rule (${ORIGIN_APPROVER_STOP})" "find-missing: ")"
    n="$(grep -c . <<< "${stop_rounds}" || true)"
    (( n == 1 )) || fail "${step}: ${n} approver-stop rule round line(s) for P with a run, not one"
    [[ "${stop_rounds}" == *"find-missing: ${NOT_JUDGED}"* ]] \
        || fail "${step}: the rule's run at the approver's stop did not read its find-missing as not judged: ${stop_rounds}"
    mapfile -t hits < <(log_lines_equal "${log0}" "${APPROVER_STOP_RELAUNCH_LINE}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} line(s) equal to the rule's approver-stop relaunch line, not one: ${APPROVER_STOP_RELAUNCH_LINE}"
    echo "${TEST_NAME}: ${step}: ${#fms[@]} bot-server find-missing run(s) from G to the kill, the approver's stop's at +$(seconds_between "${l_s}" "${stop_run_at}")s"

    # The relaunching post, before the kill, the leg's only post.
    mapfile -t hits < <(log_lines_equal "${log0}" "${P_RELAUNCHING_POSTED}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} relaunching poster line(s) for P, not one"
    post_at="$(cut -f2 <<< "${hits[0]}")"
    awk -v p="${post_at}" -v k="${kill_at}" 'BEGIN { exit !(p + 0 <= k + 0) }' || fail "${step}: the relaunching post came after the kill"
    mapfile -t hits < <(log_lines_equal "${log0}" "${P_HELD_POSTED}")
    (( ${#hits[@]} == 0 )) || fail "${step}: ${#hits[@]} held poster line(s) for P"
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) in the Slack stub's record from the start on, not the relaunching post alone"
    }
    jq -e --arg want "${RELAUNCHING_POST}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: the leg's post is not the relaunching post for P: ${RELAUNCHING_POST}"
    }

    # kill_sent true (the abort kill's line), and the worker's process gone.
    mapfile -t hits < <(log_lines_starting "${log0}" "${ABORT_KILL_HEAD}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} abort kill line(s) starting '${ABORT_KILL_HEAD}', not one"
    echo "${TEST_NAME}: ${step}: the abort's lines (recorded): $(log_hits "${log0}" "[slack] pending-row: persona=${P_KEY} stuck-launch" | cut -f3 | cut -c1-260 | tr '\n' '|')"
    wait_until "${GONE_WAIT_S}" "${step}: P's worker process ${worker} still runs ${GONE_WAIT_S}s after the kill" \
        pid_gone "${worker}"
    if [[ -f "${HOME}/.agent-director/ad-trail.jsonl" ]]; then
        echo "${TEST_NAME}: ${step}: the trail's kill records for ${P_ID} (recorded): $(jq -c --arg id "${P_ID}" 'select(.event == "ad.kill.called" and .claude_instance_id == $id)' "${HOME}/.agent-director/ad-trail.jsonl" 2> /dev/null | cut -c1-400 | tr '\n' '|')"
    fi

    # After the kill: a find-missing, the sequence's run marking the row missing, a get, then the resume.
    n="$(count_calls "${table}" "${srv}" "${P_ID}" resume "${leg_start}" "${kill_at}")"
    (( n == 1 )) || fail "${step}: ${n} bot-server resume(s) of ${P_ID} before the kill, not the start pass's one"
    resume_at="$(first_call_at "${table}" "${srv}" "${P_ID}" resume "${kill_at}" -)"
    [[ -n "${resume_at}" ]] || fail "${step}: no bot-server resume of ${P_ID} after the kill"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" resume "${kill_at}" -)"
    (( n == 1 )) || fail "${step}: ${n} bot-server resume(s) of ${P_ID} after the kill, not one"
    fm_after="$(calls "${table}" "${srv}" - find-missing "${kill_at}" "${resume_at}" | tail -n 1 | cut -f1)"
    [[ -n "${fm_after}" ]] || fail "${step}: no bot-server find-missing between the kill and the resume"
    get_at="$(first_call_at "${table}" "${srv}" "${P_ID}" get "${fm_after}" "${resume_at}")"
    [[ -n "${get_at}" ]] || fail "${step}: no bot-server get of ${P_ID} between its last find-missing and the resume"
    mapfile -t hits < <(grep -nxF -f <(printf '%s\n' "${MARKED_MISSING_LINES}") <(sed -n "$(( log0 + 1 )),\$p" "${SLACK_STATE_DIR}/server.log" | sed 's/^\[[^]]*\] //') || true)
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} live-row sequence run line(s) marking P's row missing, not one"
    marked_at="$(log_hits "$(( log0 + ${hits[0]%%:*} - 1 ))" "" | head -n 1 | cut -f2)"
    awk -v m="${marked_at}" -v k="${kill_at}" -v r="${resume_at}" 'BEGIN { exit !(m + 0 >= k + 0 && m + 0 <= r + 0) }' \
        || fail "${step}: the sequence's marked-missing run line is not between the kill and the resume"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" spawn "${leg_start}" - --reuse-finished)"
    (( n == 0 )) || fail "${step}: the bot server made ${n} reuse spawn(s) of ${P_ID}"
    relaunch_at="$(first_call_at "${table}" "${srv}" "${P_ID}" resume "${leg_start}" -)"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" spawn "${relaunch_at}" -)"
    (( n == 0 )) || fail "${step}: the bot server made ${n} spawn(s) of ${P_ID} after the start pass's resume"
    echo "${TEST_NAME}: ${step}: after the kill: find-missing +$(seconds_between "${kill_at}" "${fm_after}")s, marked missing +$(seconds_between "${kill_at}" "${marked_at}")s, get +$(seconds_between "${kill_at}" "${get_at}")s, resume +$(seconds_between "${kill_at}" "${resume_at}")s"
    echo "${TEST_NAME}: ${step}: the live-row sequence's lines (recorded): $(log_hits "${log0}" "[slack] live-row-sequence: ${P_REF}" | cut -f3 | cut -c1-240 | tr '\n' '|')"

    # No counted failure.
    for t in "[slack] Session relaunch failed for persona=${P_KEY}" "[slack] Launch failed for persona=${P_KEY}" "[slack] Cap reached for persona=${P_KEY}"; do
        n="$(log_hits "${log0}" "${t}" | grep -c . || true)"
        (( n == 0 )) || fail "${step}: ${n} server.log line(s) holding '${t}'"
    done

    # Recorded, not asserted.
    relaunched="$(pane_pid_of "${step}" "${session}" 2> /dev/null || true)"
    echo "${TEST_NAME}: ${step}: the relaunched worker's process (recorded): ${relaunched:-none} (the held one was ${worker})"
    echo "${TEST_NAME}: ${step}: P's retry-timer and pending-row rule lines (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "[slack] unavailable-retry: persona=${P_KEY} " -e "${PENDING_ROW_HEAD} ${P_REF} rule (" | cut -c1-300 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: startup-errors.log lines naming P (recorded): $(grep -F -- "${P_REF}" "${SLACK_STATE_DIR}/startup-errors.log" 2> /dev/null | cut -c1-300 | tr '\n' '|')"

    stop_server
    end_worker "${P_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The other-process leg: a pending row the server did not launch, one held
# post and no kill
# ---------------------------------------------------------------------------

leg_other_process() {
    local step="other process" creds="${SCENARIO_ROOT}/credentials-other" creds_file work sid session srv log0 posts0
    local l_ms l_s start_at resume_lines=() lines=() hits=() n table="${SCENARIO_ROOT}/other-calls.tsv"
    local held_at again_at spawn_at wait_s held_post

    new_state_dir other
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-other" "${Q_SUFFIX}"
    work="$(make_workdir other)"
    creds_file="$(write_credentials "${creds}" "${Q_SUFFIX}")"
    write_personas_config "$(persona_json "${Q_NAME}" "${creds_file}" "${work}" "${Q_CHANNEL}")"

    # Step 1: the live start brings Q up.
    start_server --live
    bring_up "${step}: the bring-up" "${Q_ID}" "${Q_REF}"
    sid="${BROUGHT_UP_SID}"

    # Step 2: a plain stop, then [harness] the worker ends with the sentinel.
    stop_server
    end_worker "${Q_ID}" "${step}: the worker"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the ${ROW_STATE} row's claude_session_id is '${ROW_SID}', not the live row's ${sid}"

    # Step 3 [harness]: the unrecognised dialog in Q's directory.
    stub_mode "${work}" unrecognised-dialog

    # Step 4 [harness, playing another process]: the harness's own resume of Q,
    # from the scenario's own shell.
    ad_capture resume --claude-instance-id "${Q_ID}"
    (( AD_RC == 0 )) || fail "${step}: the harness's resume of ${Q_ID} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read pending after the harness's resume" \
        row_of_reads "${Q_ID}" "${step}: the harness's resume" pending
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the pending row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(ms_to_s "${l_ms}")"
    session="${ROW_SESSION}"
    [[ -n "${session}" ]] || fail "${step}: the pending row names no tmux session"
    echo "${TEST_NAME}: ${step}: the harness's resume left the row pending, launch_started_at ${ROW_LAUNCH} (rendered $(fmk_text describeLaunchStartForLog "${ROW_LAUNCH}"))"
    hold_at_unrecognised_dialog "${step}: the held launch" "${session}"
    held_post="$(fmk_text stuckLaunchHeldPost "${Q_NAME}" "${Q_KEY}" "${ROW_LAUNCH}" false)" \
        || fail "${step}: fmk-texts.ts could not print stuckLaunchHeldPost"

    # Step 5 [harness]: the live start at L + OTHER_START_AFTER_S.
    wait_s="$(awk -v l="${l_s}" -v d="${OTHER_START_AFTER_S}" -v n="$(now_s)" 'BEGIN { w = l + d - n; printf "%.3f\n", (w > 0 ? w : 0) }')"
    echo "${TEST_NAME}: ${step}: the start comes ${OTHER_START_AFTER_S}s after the launch start (in ${wait_s}s)"
    sleep "${wait_s}"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"
    start_at="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" 2 "${START_WAIT_S}" "${step}: the start pass never completed"

    # Step 6 [harness]: the held post, then a later retry's held text not posted again.
    wait_until "$(( HELD_WAIT_S - OTHER_START_AFTER_S ))" "${step}: no held post for Q within ${HELD_WAIT_S}s of its launch start" \
        poster_line_seen "${log0}" "${Q_HELD_POSTED}"
    held_at="$(log_lines_equal "${log0}" "${Q_HELD_POSTED}" | head -n 1 | cut -f2)"
    echo "${TEST_NAME}: ${step}: the held post at +$(seconds_between "${l_s}" "${held_at}")s from L"
    wait_until "${AGAIN_WAIT_S}" "${step}: no later retry reached the held text within ${AGAIN_WAIT_S}s of the held post" \
        poster_line_seen "${log0}" "${Q_HELD_AGAIN}"
    again_at="$(log_lines_equal "${log0}" "${Q_HELD_AGAIN}" | head -n 1 | cut -f2)"
    echo "${TEST_NAME}: ${step}: a later retry reached the held text at +$(seconds_between "${held_at}" "${again_at}")s after the held post and posted nothing"

    # Step 7: the checks.
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${Q_ID} from L (recorded): $(calls "${table}" "${srv}" "${Q_ID}" - - - | awk -F'\t' -v l="${l_s}" '{ a = $5; sub(/ --label .*/, " …", a); printf "%+.1fs %s [%s]; ", $1 - l, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | awk -F'\t' -v l="${l_s}" '{ printf "%+.1fs ", $1 - l }')"
    # The only resume of Q's row: the harness's, its parent the scenario's own shell.
    mapfile -t resume_lines < <(awk -F'\t' -v id="${Q_ID}" '$1 == "call" && $6 ~ /(^| )resume( |$)/ && index($6, id)' "${SCENARIO_AD_SHIM_LOG}")
    (( ${#resume_lines[@]} == 1 )) || {
        printf '  | %s\n' "${resume_lines[@]}" >&2
        fail "${step}: ${#resume_lines[@]} resume call(s) of ${Q_ID} from any process, not the harness's one"
    }
    [[ "$(cut -f4 <<< "${resume_lines[0]}")" == "$$" ]] \
        || fail "${step}: the one resume of ${Q_ID} is not the scenario shell's ($$): ${resume_lines[0]}"
    # No reuse spawn, resume or kill from a CSCB process; the one plain spawn collided.
    n="$(count_calls "${table}" - "${Q_ID}" resume - -)"
    (( n == 0 )) || fail "${step}: ${n} resume(s) of ${Q_ID} by a CSCB process"
    n="$(count_calls "${table}" - "${Q_ID}" spawn - - --reuse-finished)"
    (( n == 0 )) || fail "${step}: ${n} reuse spawn(s) of ${Q_ID} by a CSCB process"
    n="$(count_calls "${table}" - "${Q_ID}" kill "${start_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${Q_ID} by a CSCB process in the leg"
    n="$(count_calls "${table}" "${srv}" "${Q_ID}" spawn - - '!--reuse-finished')"
    (( n == 1 )) || fail "${step}: the bot server made ${n} plain spawn(s) of ${Q_ID}, not its start pass's ladder's one"
    spawn_at="$(first_call_at "${table}" "${srv}" "${Q_ID}" spawn - -)"
    mapfile -t hits < <(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=pending for ${Q_REF}" | cut -f2)
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} collision line(s) reading Q's row pending, not one"
    before "${spawn_at}" "${hits[0]}" || fail "${step}: the collision line came before the bot server's plain spawn"
    # One held post, equal to the builder's for Q's launch start, with the attach remedy.
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) in the Slack stub's record from the start on, not the held post alone"
    }
    jq -e --arg want "${held_post}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: the leg's post is not the held post for Q's launch start: ${held_post}"
    }
    mapfile -t hits < <(log_lines_equal "${log0}" "${Q_HELD_POSTED}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} held poster line(s) for Q, not one"
    mapfile -t hits < <(log_lines_equal "${log0}" "${Q_RELAUNCHING_POSTED}")
    (( ${#hits[@]} == 0 )) || fail "${step}: ${#hits[@]} relaunching poster line(s) for Q"
    echo "${TEST_NAME}: ${step}: Q's retry-timer and pending-row rule lines (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "[slack] unavailable-retry: persona=${Q_KEY} " -e "${PENDING_ROW_HEAD} ${Q_REF} rule (" -e "[slack] pending-row: persona=${Q_KEY} stuck-launch" | cut -c1-300 | tr '\n' '|')"

    # Step 8 [harness, playing a human]: Enter into Q's pane; the row reports in.
    stub_press_enter "${session}"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read waiting after the harness's Enter" \
        row_of_reads "${Q_ID}" "${step}: after the Enter" waiting
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the waiting row's claude_session_id is '${ROW_SID}', not the kept ${sid}"
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} post(s) in the leg after the Enter, not the one held post"
    call_table "${table}"
    n="$(count_calls "${table}" - "${Q_ID}" kill "${start_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${Q_ID} by a CSCB process in the leg"

    stop_server
    end_worker "${Q_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_own_stuck_launch
leg_other_process

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
