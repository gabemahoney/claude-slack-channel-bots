#!/usr/bin/env bash
# Test 17 (HO §7 scenario 5; b.jg5 SRJ-1406 first bullet, SRJ-402, SRJ-406,
# SRJ-710, SRJ-1401, SRJ-1418; AC 3): a launch in progress. A resume held at
# the dev-channels dialog reads `pending` with its kept claude_session_id and
# a launch start; health ticks and a `resume` forced meanwhile change nothing
# (no launch, kill, counted failure or post; the forced `resume` gets
# ErrSpawnNotResumable, not counted and not posted); the approver clears the
# dialog through agent-director `read-pane` and `send-keys` with
# `--allow-pending` on the `pending` row, the row reaches `waiting`, and the
# bot server starts no tmux process.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml, so no `[tmux]` table);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`, in `dev-channels` (no selection) in persona P's
#   working directory, with the dialog delay (`stub_dialog_delay`) set there
#   to DIALOG_DELAY_S before the resume;
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record), one persona P, with
#   CSCB's config shortened: `health_check_interval` HEALTH_TICK_S and
#   `session_restart_delay` RESTART_DELAY_S.
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
#
# Matched values. CSCB's values are printed by fixtures/fmk-texts.ts from
# the installed package, never retyped: APPROVER_LOG_PREFIX,
# DEV_CHANNELS_DIALOG_NEEDLE, TRUST_DIALOG_NEEDLE and DIALOG_POLL_INTERVAL_MS
# (src/session-manager.ts), and G (src/ad-settings.ts
# DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds).
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - `Scheduling restart for persona=<key>` (src/restart.ts scheduleRestart);
# - the hold's trouble words `reconnect`, `relaunch`, `Scheduling restart`
#   and `not connected` (src/restart.ts, src/session-manager.ts; matched
#   case-insensitively on lines naming P's key or reference);
# - the driver's outcome fields `called=`, `counted=`, `error=` (the
#   fmk-driver.ts outcome line) and ErrSpawnNotResumable (agent-director's
#   error name);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef) and the instance id
#   `cscb_<key>` (src/persona-identity.ts personaInstanceId).
#
# Closing: the script ends with `assert_no_server_tmux` (AC 3's "the bot
# server starts no tmux process"), `assert_no_cscb_include_finished` and
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

# fmk_text <entry>: print fixtures/fmk-texts.ts's value for <entry>.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$1"
}

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair ending in <suffix> and refusing any other;
# wait for its ready file; export CSCB_SLACK_API_URL; set SLACK_STUB_PID and
# SLACK_RECORD.
start_slack_stub() {
    local dir="$1" suffix="$2" step="slack stub" api_url
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "${suffix}" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": sys.argv[1], "label": sys.argv[1], "auth": "ok", "connections": "ok"}],
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

# read_row <step>: a harness `get` of P's row. Sets ROW_READ_AT (the time
# just before the call), ROW_STATE, ROW_SID (claude_session_id), ROW_LAUNCH
# (launch_started_at as printed) and ROW_SESSION (tmux_session_name), each
# empty when absent.
read_row() {
    local fields
    ROW_READ_AT="$(now_s)"
    ad_capture get --claude-instance-id "${P_ID}"
    (( AD_RC == 0 )) || fail "$1: the harness get of ${P_ID} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .claude_session_id // "", (.launch_started_at // "" | tostring), .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$1: the harness get of ${P_ID} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_LAUNCH ROW_SESSION <<< "${fields}"
}

# row_reads <step> <state>...: read the row; true when its state is one of
# the <state>s.
row_reads() {
    local step="$1" s
    shift
    read_row "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
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
    local verb="$1" from="$2" to="$3" lines=()
    shift 3
    mapfile -t lines < <(cscb_ad_calls "${verb}" "--claude-instance-id ${P_ID}" "$@")
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
    local last
    last="$(server_calls read-pane - - | tail -n 1 | cut -f2)"
    [[ -z "${last}" ]] && return 0
    awk -v t="${last}" -v n="$(now_s)" -v q="${APPROVER_QUIET_S}" 'BEGIN { exit !(n - t >= q) }'
}

# any_calls_naming <verb> <from> <to>: print every agent-director shim `call`
# line, from any parent, whose words hold <verb> and P's row id, with a time
# in (<from>, <to>] (`-` for no bound).
any_calls_naming() {
    awk -F'\t' -v v="$1" -v id="${P_ID}" -v a="$2" -v b="$3" '
        $1 == "call" && index($6, v) && index($6, id) \
            && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)
    ' "${SCENARIO_AD_SHIM_LOG}"
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

leg_launch_pending

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
