#!/usr/bin/env bash
# AD provenance under renamed sessions, another tmux directory, replaced sockets,
# server restart, remain-on-exit and missing launch starts. Automatic readiness
# comes from AD rows; outcome-only explicit/teardown/latch probes keep coverage.

set -euo pipefail

TEST_NAME="test-28-fmk-provenance"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values, from src/ through the printer
# ---------------------------------------------------------------------------

STEP_VALUES="values"
PERSONA_A="${SCENARIO_TAG}_alpha"
PERSONA_B="${SCENARIO_TAG}_beta"
SUFFIX_A="t28alpha"
SUFFIX_B="t28beta"
CHANNEL_A="C0T28ALP1"
CHANNEL_B="C0T28BET1"
KEY_A="$(persona_key "${PERSONA_A}")"
KEY_B="$(persona_key "${PERSONA_B}")"

# src/persona-identity.ts personaInstanceId, personaTmuxSessionName.
ID_A="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${KEY_A}")"
ID_B="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${KEY_B}")"
SESSION_A="$(_scenario_printed "${STEP_VALUES}" personaTmuxSessionName "${KEY_A}")"
# src/pane-read.ts.
PROBE_LINES="$(_scenario_printed "${STEP_VALUES}" PROBE_PANE_READ_LINES)"
ENTER_DELAY_MS="$(_scenario_printed "${STEP_VALUES}" ENTER_DELAY_MS)"
READ_PANE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_PANE)"
# src/config.ts.
POLL_INTERVAL_MS="$(_scenario_printed "${STEP_VALUES}" MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS)"
# src/unavailable-retry.ts over src/backoff.ts doublingBackoffDelay: when the
# retry timer's third and fourth retries fall due after its arm (the first
# refusal), each later wait doubling the one before up to its ceiling.
RETRY_THIRD_S="$(_scenario_printed "${STEP_VALUES}" unavailableRetryDueS 3)"
RETRY_FOURTH_S="$(_scenario_printed "${STEP_VALUES}" unavailableRetryDueS 4)"
# src/ad-description-phrases.ts.
DIFFERENT_SERVER_PHRASE="$(_scenario_printed "${STEP_VALUES}" DIFFERENT_TMUX_SERVER_PHRASE)"
# src/outage-state.ts, as each persona's notice (src/persona-notifier.ts formatPersonaNotice).
CHANGED_ONSET_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" tmuxServerChangedOnset)"
CHANGED_ONSET_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" tmuxServerChangedOnset)"
GENERIC_ONSET_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" ONSET_TEMPLATES tmux-unavailable)"
GENERIC_ONSET_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" ONSET_TEMPLATES tmux-unavailable)"
ALL_CLEAR_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" ALL_CLEAR_TEMPLATE tmux-unavailable)"
ALL_CLEAR_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" ALL_CLEAR_TEMPLATE tmux-unavailable)"
ESCALATE_HEAD_A="$(_scenario_printed "${STEP_VALUES}" escalateDeadSweepLineHead "${KEY_A}")"
RECONNECT_GONE_HEAD="$(_scenario_printed "${STEP_VALUES}" reconnectGoneLineHead)"


# Legs 5 to 7 .
REF_B="$(persona_ref "${PERSONA_B}")"
SESSION_B="$(_scenario_printed "${STEP_VALUES}" personaTmuxSessionName "${KEY_B}")"
# src/pane-read.ts.
READ_GONE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_GONE)"
# src/ad-description-phrases.ts.
OWN_ID_PHRASE="$(_scenario_printed "${STEP_VALUES}" CONFLICT_OWN_ID_PHRASE)"
STOPPING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STOPPING_PHRASE)"
STARTING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STARTING_PHRASE)"
# src/ad-settings.ts: agent-director's defaults (no `[tmux]` table here), in
# the package's `[tmux]` table under agent-director's own key names (the
# printer refuses a key the package records no default for).
TMUX_TABLE="$(_scenario_printed "${STEP_VALUES}" AD_TMUX_TABLE)"
STOPPING_WINDOW_S="$(_scenario_printed "${STEP_VALUES}" DEFAULT_AD_SETTINGS "${TMUX_TABLE}" stopping_window_seconds)"
STARTING_BOUND_S="$(_scenario_printed "${STEP_VALUES}" DEFAULT_AD_SETTINGS "${TMUX_TABLE}" starting_session_seconds)"
# src/conflict-latch.ts.
RECHECK_MS="$(_scenario_printed "${STEP_VALUES}" LATCH_RECHECK_INTERVAL_MS)"
OWN_ID_CASE="$(_scenario_printed "${STEP_VALUES}" LATCH_CASE_OWN_ID)"
OWN_ID_SENTENCE="$(_scenario_printed "${STEP_VALUES}" conflictCaseSentence "${OWN_ID_CASE}")"
NOTICE_HEAD_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" CONFLICT_NOTICE_FIRST_LINE_HEAD)"
NOTICE_POINTER="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_POINTER_LINE)"
NOTICE_HUMAN_ONLY="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_HUMAN_ONLY_LINE)"
CONFLICT_RECOVERY_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" \
    conflictRecoveryText "${SESSION_A}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)"
# src/persona-episodes.ts: the tmux-unresponsive onset and alert,
# which an UNAVAILABLE of leg 6's resume may post before the latch.
UNRESPONSIVE_ONSET_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" tmuxUnresponsiveOnsetText "${KEY_A}")"
UNRESPONSIVE_ALERT_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" tmuxUnresponsiveAlertText "${KEY_A}")"
CALL_PROBE="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_PROBE)"
CALL_RESUME="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_RESUME)"
CALL_NONE="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_NONE)"
STEP_TABLE="$(_scenario_printed "${STEP_VALUES}" RECHECK_STEP_TABLE)"
VERDICT_STILL_LATCHED="$(_scenario_printed "${STEP_VALUES}" RECHECK_VERDICT_STILL_LATCHED)"
HOLD_CASE="$(_scenario_printed "${STEP_VALUES}" LATCH_CASE_LAUNCH_START_NOT_RECORDED)"
HOLD_NOTICE_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" launchStartNotRecordedNoticeText "${KEY_B}")"
HOLD_RECOVERY_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" \
    holdRecoveryText latchRecoveryReasonRowReads missing)"
# src/session-manager.ts restartCapReachedNoticeText: the restart-cap notice,
# a spawn-failure notice (spawnFailureNoticeText), whose first line every
# spawn-failure notice opens with.
CAP_NOTICE="$(_scenario_printed "${STEP_VALUES}" restartCapReachedNoticeText)"
SPAWN_FAILURE_HEAD="${CAP_NOTICE%%$'\n'*}"
# src/session-manager.ts latchClearRetryAnsweredLine: the head of the
# after-clear retry's answer line, before the outcome it carries.
RETRY_AT_ONCE_HEAD_B="$(_scenario_printed "${STEP_VALUES}" latchClearRetryAtOnceLineHeadForRef "${REF_B}")"
# src/conflict-latch.ts conflictLatchSetLine: the head of A's and B's latch
# lines, up to and including `case=` (agent-director's description follows
# the case).
LATCH_HEAD_A="$(_scenario_printed "${STEP_VALUES}" conflictLatchSetLineHead "${KEY_A}" latched)"
LATCH_HEAD_B="$(_scenario_printed "${STEP_VALUES}" conflictLatchSetLineHead "${KEY_B}" latched)"
# src/conflict-latch.ts latchRecheckRoundLine, printed whole: leg 6's probe
# cleared (the answer src/session-manager.ts runLatchRecheckRound composes
# inline, `probe-cleared (<pane read kind>); …`, matched up to the `;`, and
# the call `<probe>+find-missing+<retry>`, latchRecheckClearedProbeRetry's
# label), and leg 7's status-only rounds (the answers `still-latched` and
# `cleared (<step>)`, composed inline there too).
ROUND_CLEARED_A="$(_scenario_printed "${STEP_VALUES}" latchRecheckRoundLine "${PERSONA_A}" "${OWN_ID_CASE}" \
    "${STEP_TABLE}" "${CALL_PROBE}+find-missing+${CALL_RESUME}" "probe-cleared (${READ_GONE});")"
ROUND_HELD_B="$(_scenario_printed "${STEP_VALUES}" latchRecheckRoundLine "${PERSONA_B}" "${HOLD_CASE}" \
    "${STEP_TABLE}" "${CALL_NONE}" "${VERDICT_STILL_LATCHED}")"
ROUND_CLEARED_B="$(_scenario_printed "${STEP_VALUES}" latchRecheckRoundLine "${PERSONA_B}" "${HOLD_CASE}" \
    "${STEP_TABLE}" "${CALL_NONE}" "cleared (${STEP_TABLE})")"

[[ "${PROBE_LINES}" =~ ^[1-9][0-9]*$ && "${POLL_INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the probe's line count '${PROBE_LINES}' or the poll interval '${POLL_INTERVAL_MS}' is not a whole number"
[[ "${RETRY_THIRD_S}" =~ ^[1-9][0-9]*$ && "${RETRY_FOURTH_S}" =~ ^[1-9][0-9]*$ && "${RETRY_THIRD_S}" -lt "${RETRY_FOURTH_S}" ]] \
    || fail "${STEP_VALUES}: the third and fourth retries' due times '${RETRY_THIRD_S}' and '${RETRY_FOURTH_S}' are not rising whole numbers"
[[ -n "${SPAWN_FAILURE_HEAD}" && "${SPAWN_FAILURE_HEAD}" != "${CAP_NOTICE}" ]] \
    || fail "${STEP_VALUES}: the restart-cap notice '${CAP_NOTICE}' has no first line of its own"
[[ "${RECHECK_MS}" =~ ^[1-9][0-9]*$ && "${STOPPING_WINDOW_S}" =~ ^[1-9][0-9]*$ && "${STARTING_BOUND_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the re-check interval '${RECHECK_MS}', the stopping window '${STOPPING_WINDOW_S}' or the starting-session bound '${STARTING_BOUND_S}' is not a whole number"
RECHECK_S=$(( (RECHECK_MS + 999) / 1000 ))
[[ "${CHANGED_ONSET_A}" != "${GENERIC_ONSET_A}" && "${CHANGED_ONSET_B}" != "${GENERIC_ONSET_B}" ]] \
    || fail "${STEP_VALUES}: the tmux-server-changed onset is the generic tmux-unavailable onset"
# Leg 6's resume meets the own-id CONFLICT once the session is older than the
# starting-session bound and the row ended more than the stopping window ago;
# the retry timer's fourth retry is past both, from any start.
(( STARTING_BOUND_S < RETRY_FOURTH_S && STOPPING_WINDOW_S < RETRY_FOURTH_S )) \
    || fail "${STEP_VALUES}: the starting-session bound (${STARTING_BOUND_S}s) or the stopping window (${STOPPING_WINDOW_S}s) is not below the fourth retry (${RETRY_FOURTH_S}s)"

# Waits, in seconds (see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
POST_WAIT_S=60
KILL_END_WAIT_S=15
SETTLE_S=3
RETRY_ALLOWANCE_S=30
TICK_S=10
RESTART_DELAY_S=5
FM_INTERVAL_S=10
MARK_WAIT_S=90
RELAUNCH_WAIT_S=120
RECHECK_ALLOWANCE_S=60
APPLY_WAIT_S=30
AGE_MARGIN_S=2

# Set by the legs.
SLACK_STUB_PID=""
RECORD=""
START_COUNT=0
declare -A WORKER_PID=() PANE_PID=() LAUNCH_TOKEN=() MCP_PID=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# start_slack_stub <dir> <suffix>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <suffix> (labelled <suffix>)
# and refusing any other; wait for its ready file; export CSCB_SLACK_API_URL;
# set SLACK_STUB_PID and RECORD.
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
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${dir}/record.jsonl" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
    RECORD="${dir}/record.jsonl"
}

# row_json <step> <id>: print the row (one JSON object) from a read-only
# store read.
row_json() {
    local out
    out="$(ad_store_row "$2")" || exit 1
    jq -c '.[0]' <<< "${out}"
}

# True when row <id> reads <state> (a read-only store read, which adds no
# line to the shim's log).
row_reads() {
    local state
    state="$(_scenario_store_read "row state" "SELECT state FROM spawns WHERE instance_id = '$1'")" || exit 1
    [[ "${state}" == "$2" ]]
}

both_rows_read() {
    row_reads "${ID_A}" "$1" && row_reads "${ID_B}" "$1"
}

# expect_status <step> <id> <state>: a harness `status` read of row <id>
# reads <state>.
expect_status() {
    local step="$1" id="$2" want="$3" got
    ad_capture status --instance-id "${id}"
    (( AD_RC == 0 )) || fail "${step}: the harness status read of ${id} exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: row ${id} reads '${got}', not ${want}"
}

# note_worker <step> <id>: record row <id>'s worker pid, pane pid and launch
# token; fail unless both processes run and the pane's process is the stub.
note_worker() {
    local step="$1" id="$2" row
    row="$(row_json "${step}" "${id}")"
    WORKER_PID[${id}]="$(jq -r '.pid // empty' <<< "${row}")"
    PANE_PID[${id}]="$(jq -r '.pane_pid // empty' <<< "${row}")"
    LAUNCH_TOKEN[${id}]="$(jq -r '.launch_token // empty' <<< "${row}")"
    [[ "${WORKER_PID[${id}]}" =~ ^[0-9]+$ && "${PANE_PID[${id}]}" =~ ^[0-9]+$ && -n "${LAUNCH_TOKEN[${id}]}" ]] \
        || fail "${step}: row ${id} records worker pid '${WORKER_PID[${id}]}', pane pid '${PANE_PID[${id}]}' and launch token '${LAUNCH_TOKEN[${id}]}'"
    expect_worker_runs "${step}" "${id}"
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/${PANE_PID[${id}]}/cmdline" 2> /dev/null \
        || fail "${step}: row ${id}'s pane process ${PANE_PID[${id}]} is not the stub ${SCENARIO_BIN}/claude"
}

# expect_worker_runs <step> <id>: row <id>'s noted worker and pane process run.
expect_worker_runs() {
    if ! pid_alive "${WORKER_PID[$2]}" || ! pid_alive "${PANE_PID[$2]}"; then
        fail "$1: row $2's worker (pid ${WORKER_PID[$2]}, pane pid ${PANE_PID[$2]}) no longer runs"
    fi
}

# expect_same_launch <step> <id>: nothing launched for row <id>: its noted
# worker and pane process run, and the row records them and its launch token.
expect_same_launch() {
    local step="$1" id="$2" row
    expect_worker_runs "${step}" "${id}"
    row="$(row_json "${step}" "${id}")"
    [[ "$(jq -r '.pid // empty' <<< "${row}")" == "${WORKER_PID[${id}]}" \
        && "$(jq -r '.pane_pid // empty' <<< "${row}")" == "${PANE_PID[${id}]}" \
        && "$(jq -r '.launch_token // empty' <<< "${row}")" == "${LAUNCH_TOKEN[${id}]}" ]] \
        || fail "${step}: row ${id} now records another launch: $(jq -c '{state, pid, pane_pid, launch_token}' <<< "${row}")"
}

# mcp_session_pid <id>: print the PID of the MCP session client
# (fixtures/stub-mcp-session.ts) row <id>'s stub runs as its child; empty
# when none runs.
mcp_session_pid() {
    pgrep -P "${PANE_PID[$1]}" -f stub-mcp-session.ts | head -n 1 || true
}

# True when row <id>'s stub runs an MCP session client other than the one
# noted in MCP_PID before the restart (the stub opens one on `/mcp reconnect`
# typed into its pane when none runs).
new_mcp_session() {
    local pid
    pid="$(mcp_session_pid "$1")"
    [[ -n "${pid}" && "${pid}" != "${MCP_PID[$1]:-}" ]]
}

# True when neither of row <id>'s noted processes runs.
worker_gone() {
    ! pid_alive "${WORKER_PID[$1]}" && ! pid_alive "${PANE_PID[$1]}"
}

# True when the scenario's tmux server holds a session named exactly <name>.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

no_session() {
    ! has_session "$1"
}

# start_and_settle <step>: start the server live, wait for its start pass to
# complete for both personas and both rows to read `waiting`, then note both
# workers.
start_and_settle() {
    local step="$1"
    start_server --live
    START_COUNT=$(( START_COUNT + 1 ))
    wait_for_count "${COMPLETE_2}" "${START_COUNT}" "${START_WAIT_S}" "${step}: start pass ${START_COUNT} never completed"
    wait_until "${REPORT_WAIT_S}" "${step}: the rows never both read waiting" both_rows_read waiting
}

# log_slice <from-line>: print the path of a copy of server.log's lines after
# <from-line>.
log_slice() {
    local file
    file="$(mktemp "${SCENARIO_ROOT}/log-slice.XXXXXX")" || fail "log_slice: could not create a file"
    tail -n "+$(( $1 + 1 ))" "${SLACK_STATE_DIR}/server.log" > "${file}" || fail "log_slice: could not copy server.log"
    printf '%s\n' "${file}"
}

# window_calls <step> <from-mark> <to-mark|-> <id>: set WIN_VERBS, WIN_ARGS
# (the arguments joined by single spaces), WIN_PPIDS and WIN_US (the line's
# time, in microseconds since the epoch) to each CSCB-parented agent-director
# call in the shim log's window that names `--instance-id <id>`, in
# log order.
window_calls() {
    local step="$1" out line a
    WIN_VERBS=()
    WIN_ARGS=()
    WIN_PPIDS=()
    WIN_US=()
    out="$(cscb_ad_calls_between "$2" "$3" "" "--instance-id $4")" || exit 1
    [[ -n "${out}" ]] || return 0
    while IFS= read -r line; do
        if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
            fail "${step}: a shim log line does not parse: ${line}"
        fi
        _scenario_ad_verb
        WIN_VERBS+=("${_L_VERB}")
        printf -v a '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        WIN_ARGS+=("${a% }")
        WIN_PPIDS+=("${_L_PPID}")
        WIN_US+=("${_L_US}")
    done <<< "${out}"
}

# echo_window_timed <step> <from-us>: print each call of the last
# window_calls on one line, with its time in seconds after <from-us>
# (microseconds since the epoch), its parent and its arguments.
echo_window_timed() {
    local i d
    for i in "${!WIN_VERBS[@]}"; do
        d=$(( WIN_US[i] - $2 ))
        printf '%s: %s: +%d.%03ds %s (parent %s) %s\n' "${TEST_NAME}" "$1" $(( d / 1000000 )) $(( (d % 1000000) / 1000 )) \
            "${WIN_VERBS[i]}" "${WIN_PPIDS[i]}" "${WIN_ARGS[i]:0:200}"
    done
}

# window_has <verb> <ppid> [<fragment>]: true when the last window_calls holds
# a <verb> by <ppid> whose arguments hold <fragment>.
window_has() {
    local i
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_VERBS[i]}" == "$1" && "${WIN_PPIDS[i]}" == "$2" && " ${WIN_ARGS[i]} " == *"${3:-}"* ]] && return 0
    done
    return 1
}

# window_count <verb>: print how many calls of the last window_calls are <verb>.
window_count() {
    local v n=0
    for v in ${WIN_VERBS[@]+"${WIN_VERBS[@]}"}; do
        [[ "${v}" == "$1" ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# expect_nothing_launched <step> <from-mark> <id>: since <from-mark> no CSCB
# process made a `resume`, `kill` or `delete` of row <id>, and at most the
# restart's one plain `spawn`, which launched nothing (expect_same_launch).
expect_nothing_launched() {
    local step="$1" id="$3" verb n
    window_calls "${step}" "$2" - "${id}"
    for verb in resume kill delete; do
        n="$(window_count "${verb}")"
        [[ "${n}" == 0 ]] || fail "${step}: a CSCB process made ${n} ${verb} call(s) of ${id}"
    done
    n="$(window_count spawn)"
    (( n <= 1 )) || fail "${step}: CSCB processes made ${n} spawn calls of ${id}, more than the restart's one refused plain spawn"
    expect_same_launch "${step}" "${id}"
}

# last_record_pid <role> [<word-fragment>]: print the PID of the last CSCB
# process record entry of <role> whose words hold <word-fragment>.
last_record_pid() {
    awk -F'\t' -v r="$1" -v w="${2:-}" '$1 == "proc" && $2 == r && index($6, w) { p = $3 } END { print p }' "${SCENARIO_CSCB_RECORD}"
}

# posts_of <label> <after-seq>: set POSTS to the text of each post the Slack
# record holds for <label> after <after-seq>, in order.
posts_of() {
    local out raw=() line text
    POSTS=()
    out="$(slack_label_posts "${RECORD}" "$1" "$2")" || exit 1
    [[ -n "${out}" ]] || return 0
    mapfile -t raw <<< "${out}"
    for line in "${raw[@]}"; do
        text="$(jq -j '.' <<< "${line}" && printf x)" || fail "posts_of $1: a post's text does not decode: ${line}"
        POSTS+=("${text%x}")
    done
}

posts_at_least() {
    posts_of "$1" "$2"
    (( ${#POSTS[@]} >= $3 ))
}

# True when the last post for <label> after <after-seq> is <text>.
last_post_is() {
    posts_of "$1" "$2"
    (( ${#POSTS[@]} > 0 )) && [[ "${POSTS[${#POSTS[@]}-1]}" == "$3" ]]
}

# expect_outage_posts <step> <label> <after-seq> <onset> <all-clear> <generic>:
# the posts for <label> after <after-seq> run <onset>, then any number of
# <all-clear> and <onset> pairs, and an <all-clear> last only when the
# sequence ends there; none is <generic>. Prints the sequence's length.
expect_outage_posts() {
    local step="$1" label="$2" onset="$4" clear="$5" generic="$6" i want
    posts_of "${label}" "$3"
    (( ${#POSTS[@]} >= 1 )) || fail "${step}: no post for ${label}"
    for i in "${!POSTS[@]}"; do
        [[ "${POSTS[i]}" != "${generic}" ]] || fail "${step}: post $(( i + 1 )) for ${label} is the generic tmux-unavailable onset"
        if (( i % 2 == 0 )); then
            want="${onset}"
        else
            want="${clear}"
        fi
        [[ "${POSTS[i]}" == "${want}" ]] \
            || fail "${step}: post $(( i + 1 )) for ${label} reads '${POSTS[i]}', not '${want}' (onset, then all-clear and onset pairs)"
    done
    echo "${#POSTS[@]}"
}

# run_driver <step> <persona> <channel> <workdir> <other-tmpdir>:
# fixtures/fmk-driver.ts's read-pane-other-tmux-tmpdir for <persona>, through
# `cscb_run`. Fails unless it exits 0 with exactly one outcome line
# `DRIVER: FORCED read-pane-other-tmux-tmpdir …` (DRIVER_LINE). Sets
# DRIVER_PID, the run's recorded PID.
run_driver() {
    local step="$1" call=read-pane-other-tmux-tmpdir out err rc=0 outcome=()
    out="${SCENARIO_ROOT}/fmk-driver-$2.out"
    err="${SCENARIO_ROOT}/fmk-driver-$2.err"
    cscb_run env "CSCB_PKG_DIR=${SCENARIO_REPO}/node_modules/claude-slack-channel-bots" \
        "DRIVER_PERSONA=$2" "DRIVER_PERSONA_CHANNEL=$3" "DRIVER_WORKING_DIRECTORY=$4" "DRIVER_OTHER_TMUX_TMPDIR=$5" \
        bun --no-install "${SCENARIO_FIXTURES}/fmk-driver.ts" "${call}" < /dev/null > "${out}" 2> "${err}" || rc=$?
    mapfile -t outcome < <(grep -E '^DRIVER(_FAIL)?:' "${out}" || true)
    if (( rc != 0 || ${#outcome[@]} != 1 )) || [[ "${outcome[0]}" != "DRIVER: FORCED ${call} "* ]]; then
        sed 's/^/  | /' "${out}" >&2
        tail -n 20 "${err}" | sed 's/^/  | /' >&2
        fail "${step}: the driver exited ${rc} with ${#outcome[@]} outcome line(s) (first: ${outcome[0]:-none}), not one 'DRIVER: FORCED ${call} …' line"
    fi
    DRIVER_LINE="${outcome[0]}"
    DRIVER_PID="$(last_record_pid run "fmk-driver.ts ${call}")"
    [[ "${DRIVER_PID}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    echo "${TEST_NAME}: ${step}: ${DRIVER_LINE:0:300}"
}

# ad_parented_tmux_count <fragment>: print how many tmux shim `call` lines
# hold <fragment> in their words and have an agent-director process as their
# parent (its argv[0] agent-director, or the binary behind the shim).
ad_parented_tmux_count() {
    local lines=() line parent=() n=0 w rest
    [[ -f "${SCENARIO_TMUX_SHIM_LOG}" ]] || { echo 0; return 0; }
    mapfile -t lines < "${SCENARIO_TMUX_SHIM_LOG}"
    for line in ${lines[@]+"${lines[@]}"}; do
        _scenario_split_line "${line}" && [[ "${_L_KIND}" == call && "${_L_PARENT}" != '?' ]] || continue
        _scenario_decode_words || continue
        printf -v rest '%s ' ${_L_WORDS[@]+"${_L_WORDS[@]}"}
        [[ "${rest}" == *"$1"* ]] || continue
        _scenario_eval_words parent "${_L_PARENT}" || continue
        w="${parent[0]:-}"
        [[ "${w##*/}" == agent-director || "${w##*/}" == agent-director.real ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# A tmux shim line (or its words) that ends a session or a pane.
TMUX_KILL_RE='(^|[[:space:]])kill-(session|pane)([[:space:]]|$)'

# tmux_shim_mark: print how many lines the tmux shim's log holds now (0 when
# it holds none).
tmux_shim_mark() {
    if [[ -f "${SCENARIO_TMUX_SHIM_LOG}" ]]; then
        wc -l < "${SCENARIO_TMUX_SHIM_LOG}" | tr -d ' '
    else
        echo 0
    fi
}

# tmux_kill_lines <from-mark>: print how many of the tmux shim log's lines
# after <from-mark>, whatever their parent, match TMUX_KILL_RE.
tmux_kill_lines() {
    local lines=() line n=0
    [[ -f "${SCENARIO_TMUX_SHIM_LOG}" ]] || fail "tmux_kill_lines: no tmux shim log at ${SCENARIO_TMUX_SHIM_LOG}"
    mapfile -t lines < <(tail -n "+$(( $1 + 1 ))" "${SCENARIO_TMUX_SHIM_LOG}")
    for line in ${lines[@]+"${lines[@]}"}; do
        [[ "${line}" =~ ${TMUX_KILL_RE} ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# ad_parented_tmux_kills <from-mark> <to-mark>: print how many tmux shim
# `call` lines after <from-mark> up to <to-mark> match TMUX_KILL_RE (the line
# as tmux_kill_lines reads it) and have an agent-director process as their
# parent (as for ad_parented_tmux_count).
ad_parented_tmux_kills() {
    local lines=() line parent=() n=0 w
    [[ -f "${SCENARIO_TMUX_SHIM_LOG}" ]] || fail "ad_parented_tmux_kills: no tmux shim log at ${SCENARIO_TMUX_SHIM_LOG}"
    (( $2 > $1 )) || { echo 0; return 0; }
    mapfile -t lines < <(sed -n "$(( $1 + 1 )),$2p" "${SCENARIO_TMUX_SHIM_LOG}")
    for line in ${lines[@]+"${lines[@]}"}; do
        [[ "${line}" =~ ${TMUX_KILL_RE} ]] || continue
        _scenario_split_line "${line}" && [[ "${_L_KIND}" == call && "${_L_PARENT}" != '?' ]] || continue
        _scenario_eval_words parent "${_L_PARENT}" || continue
        w="${parent[0]:-}"
        [[ "${w##*/}" == agent-director || "${w##*/}" == agent-director.real ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# write_personas_config <health-check-interval> [<session-restart-delay>]:
# the scenario's config for both personas, with the given
# `health_check_interval` and, when given, `session_restart_delay`.
write_personas_config() {
    local delay=""
    if [[ -n "${2:-}" ]]; then
        delay="\"session_restart_delay\": $2,"
    fi
    write_config << EOF
{
  "personas": [
    {
      "name": "${PERSONA_A}",
      "credentials_file": "${CREDS}/alpha.json",
      "working_directory": "${WORK_A}",
      "claude_config_dir": "${SCENARIO_ROOT}/claude-config-a",
      "channels": [{ "id": "${CHANNEL_A}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL_A}"
    },
    {
      "name": "${PERSONA_B}",
      "credentials_file": "${CREDS}/beta.json",
      "working_directory": "${WORK_B}",
      "claude_config_dir": "${SCENARIO_ROOT}/claude-config-b",
      "channels": [{ "id": "${CHANNEL_B}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL_B}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": $1,
  ${delay}
  "agent_director_poll_interval_ms": ${POLL_INTERVAL_MS},
  "exit_timeout": 5
}
EOF
}

# apply_personas_config <step> <health-check-interval> [<session-restart-delay>]:
# a human's confirmed edit of two server-wide settings while the server runs
#: config.json rewritten (write_personas_config), its
# pending file renamed to config.json.apply once the server previewed it, and
# the apply logged (`applied_match settings=2`). A changed server-wide setting
# takes effect at the next start, which runs the record.
apply_personas_config() {
    local step="$1" pending="${SLACK_STATE_DIR}/config.json.pending" m n
    shift
    m="$(applied_match settings=2)"
    n="$(count_log "${m}")"
    write_personas_config "$@"
    wait_for_file "${pending}" "${APPLY_WAIT_S}" "${step}: the server previewed no pending change"
    mv -f -- "${pending}" "${SLACK_STATE_DIR}/config.json.apply" || fail "${step}: could not confirm the pending change"
    wait_for_count "${m}" $(( n + 1 )) "${APPLY_WAIT_S}" "${step}: the server applied no change of two server-wide settings"
}

# restart_and_reconnect <step>: the bot server restarted without teardown (a
# plain `stop`, then `start`), its start pass completed for both personas,
# both rows reading `waiting`, and each stub running a new MCP session (the
# start pass's reconnect reached it); then both workers noted.
restart_and_reconnect() {
    local step="$1" id old="${SERVER_PID}"
    for id in "${ID_A}" "${ID_B}"; do
        MCP_PID[${id}]="$(mcp_session_pid "${id}")"
    done
    stop_server
    start_and_settle "${step}"
    [[ "${SERVER_PID}" != "${old}" ]] || fail "${step}: the restart kept bot server ${SERVER_PID}"
    for id in "${ID_A}" "${ID_B}"; do
        wait_until "${REPORT_WAIT_S}" "${step}: ${id}'s stub opened no new MCP session after the restart" new_mcp_session "${id}"
        expect_status "${step}" "${id}" waiting
        note_worker "${step}" "${id}"
    done
}

# window_any <step> <from-mark> <to-mark|-> <id>: set WIN_VERBS, WIN_ARGS and
# WIN_PPIDS to each CSCB-parented agent-director call in the shim log's
# window that names `--instance-id <id>` or is a `find-missing` (which
# names no instance id), in log order, leaving out `version`.
window_any() {
    local step="$1" out line a
    WIN_VERBS=()
    WIN_ARGS=()
    WIN_PPIDS=()
    out="$(cscb_ad_calls_between "$2" "$3" "")" || exit 1
    [[ -n "${out}" ]] || return 0
    while IFS= read -r line; do
        if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
            fail "${step}: a shim log line does not parse: ${line}"
        fi
        _scenario_ad_verb
        [[ "${_L_VERB}" == version ]] && continue
        printf -v a '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        [[ "${_L_VERB}" == find-missing || " ${a}" == *" --instance-id $4 "* ]] || continue
        WIN_VERBS+=("${_L_VERB}")
        WIN_ARGS+=("${a% }")
        WIN_PPIDS+=("${_L_PPID}")
    done <<< "${out}"
}

# window_until <verb>: cut the last window (window_calls or window_any) after
# its first <verb>; fail when it holds none.
window_until() {
    local i
    for i in "${!WIN_VERBS[@]}"; do
        if [[ "${WIN_VERBS[i]}" == "$1" ]]; then
            WIN_VERBS=("${WIN_VERBS[@]:0:i+1}")
            WIN_ARGS=("${WIN_ARGS[@]:0:i+1}")
            WIN_PPIDS=("${WIN_PPIDS[@]:0:i+1}")
            return 0
        fi
    done
    fail "window_until: the window holds no ${1}: ${WIN_VERBS[*]-none}"
}

# window_launches: print how many calls of the last window are a `resume` or
# a `spawn` (plain or reuse).
window_launches() {
    echo $(( $(window_count resume) + $(window_count spawn) ))
}

# expect_in_order <step> <text> <fragment>...: <text> holds every fragment,
# in order.
expect_in_order() {
    local step="$1" rest="$2" frag
    shift 2
    for frag in "$@"; do
        [[ "${rest}" == *"${frag}"* ]] || fail "${step}: the post lacks, in its order, '${frag}'"
        rest="${rest#*"${frag}"}"
    done
}

# echo_posts <step> <label> <after-seq>: print each post for <label> after
# <after-seq>, on one line each.
echo_posts() {
    local i
    posts_of "$2" "$3"
    for i in "${!POSTS[@]}"; do
        echo "${TEST_NAME}: $1: post $(( i + 1 )) for $2: ${POSTS[i]//$'\n'/ \\n }"
    done
}

# echo_log_lines <step> <slice-file> <fragment>: print the slice's lines that
# hold <fragment>, each cut to 400 characters.
echo_log_lines() {
    local line
    while IFS= read -r line; do
        echo "${TEST_NAME}: $1: | ${line:0:400}"
    done < <(grep -F -- "$3" "$2" || true)
}

# True when the agent-director shim's log holds, after line <mark>, a line
# holding <verb> and instance id <id> (a cheap scan; the windows read whose
# call it is).
shim_line_after() {
    tail -n "+$(( $1 + 1 ))" "${SCENARIO_AD_SHIM_LOG}" 2> /dev/null | grep -F -- "$2" | grep -qF -- "$3"
}

# expect_one_relaunch <step> <id>: the last window holds exactly one resume of
# <id>, by the bot server, no spawn with --reuse-finished, and at most one
# plain spawn, before the resume (the launch's collision path).
expect_one_relaunch() {
    local step="$1" i resumes=0 spawns=0
    for i in "${!WIN_VERBS[@]}"; do
        case "${WIN_VERBS[i]}" in
            resume)
                [[ "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] || fail "${step}: a resume of $2 has parent ${WIN_PPIDS[i]}, not the bot server ${SERVER_PID}"
                resumes=$(( resumes + 1 ))
                ;;
            spawn)
                [[ " ${WIN_ARGS[i]} " != *" --reuse-finished "* ]] || fail "${step}: a CSCB process made a reuse spawn of $2"
                (( resumes == 0 )) || fail "${step}: a spawn of $2 came after its resume"
                spawns=$(( spawns + 1 ))
                ;;
        esac
    done
    (( resumes == 1 && spawns <= 1 )) || fail "${step}: $2 got ${resumes} resume(s) and ${spawns} plain spawn(s), not one launch"
}

# True when a post for <label> after <after-seq> opens with <head>.
post_opening_with() {
    local p
    posts_of "$1" "$2"
    for p in ${POSTS[@]+"${POSTS[@]}"}; do
        [[ "${p}" == "$3"* ]] && return 0
    done
    return 1
}

# session_id_of <name>: print the id ($N) of the session named exactly <name>
# on the scenario's tmux server (empty when none).
session_id_of() {
    "${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{session_id}' 2> /dev/null || true
}

# row_token <step> <id>: print row <id>'s launch token (empty when it has
# none); fail when the row cannot be read.
row_token() {
    local row
    row="$(row_json "$1" "$2")" || exit 1
    [[ -n "${row}" && "${row}" != null ]] || fail "$1: no row ${2} to read"
    jq -r '.launch_token // empty' <<< "${row}" || fail "$1: jq could not read row ${2}"
}

# marked_missing <id> <old-token> <runs-before>: true when row <id> has been
# marked `missing` since <old-token> was noted: it reads `missing`, a
# find-missing loop run after run <runs-before> (each run's output,
# run.<n>.out, a JSON object) lists it in its `ids`, or it records another
# launch (a relaunch after the mark may already have moved it on). A run
# whose output is not yet whole JSON lists nothing.
marked_missing() {
    local id="$1" old="$2" from="$3" runs n token
    row_reads "${id}" missing && return 0
    runs="$(find_missing_loop_runs)" || exit 1
    for (( n = from + 1; n <= runs; n++ )); do
        jq -e --arg id "${id}" '.ids | index($id) != null' "${SCENARIO_ROOT}/find-missing-loop/run.${n}.out" > /dev/null 2>&1 \
            && return 0
    done
    token="$(row_token marked_missing "${id}")" || exit 1
    [[ "${token}" != "${old}" ]]
}

# True when row <id> reads `waiting` with a launch token other than <old-token>.
relaunched_waiting() {
    local token
    row_reads "$1" waiting || return 1
    token="$(row_token relaunched_waiting "$1")" || exit 1
    [[ "${token}" != "$2" ]]
}

# ---------------------------------------------------------------------------
# Leg 1: set-up and start
# ---------------------------------------------------------------------------

STEP="set-up"
CREDS="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS}" || fail "${STEP}: could not create ${CREDS}"
mkdir -p "${SCENARIO_ROOT}/claude-config-a" "${SCENARIO_ROOT}/claude-config-b" \
    || fail "${STEP}: could not create the personas' config dirs"
WORK_A="$(make_workdir alpha)"
stub_mode "${WORK_A}" "${STUB_MODE_AT_ONCE}"
WORK_B="$(make_workdir beta)"
stub_mode "${WORK_B}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK_A}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK_B}" "${STUB_MODE_AT_ONCE}"
# The other TMUX_TMPDIR of the driver's pane reads: empty, under SCENARIO_ROOT.
EMPTY_TMPDIR="${SCENARIO_ROOT}/tmux-empty"
mkdir -m 700 "${EMPTY_TMPDIR}" || fail "${STEP}: could not create ${EMPTY_TMPDIR}"

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${SUFFIX_A}" "${SUFFIX_B}"
for suffix in "${SUFFIX_A}" "${SUFFIX_B}"; do
    BOT_TOKEN="$(fake_token bot "${suffix}")"
    APP_TOKEN="$(fake_token app "${suffix}")"
    file="${CREDS}/alpha.json"
    [[ "${suffix}" == "${SUFFIX_B}" ]] && file="${CREDS}/beta.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "${BOT_TOKEN}" "${APP_TOKEN}" | write_file "${file}" 600
done
# The start pass's completion line for both personas.
COMPLETE_2="$(completion_match 2)"
write_personas_config 0

STEP="leg 1 (start)"
start_and_settle "${STEP}"
expect_completion 2 "${STEP}" "0 not brought up"
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    note_worker "${STEP}" "${id}"
done

# ---------------------------------------------------------------------------
# Leg 2: a renamed session; the restart's reconnect, the health check's pane
# read (ticks on for this leg), a driver's pane read and the teardown's kill
# ---------------------------------------------------------------------------

STEP="leg 2 (renamed session)"
RENAMED_A="${SCENARIO_TAG}_renamed_alpha"
SID_A="$(rename_session "${SESSION_A}" "${RENAMED_A}")"
no_session "${SESSION_A}" || fail "${STEP}: a session named ${SESSION_A} still exists after the rename"
echo "${TEST_NAME}: ${STEP}: session ${SID_A} renamed ${SESSION_A} -> ${RENAMED_A}"

# Ticks on for this leg (decision D4: the health check's pane read): the
# confirmed edit, as leg 5 makes it, which takes effect at the restart below.
apply_personas_config "${STEP}: ticks on" "${TICK_S}" "${RESTART_DELAY_S}"

# The bot server restarted without teardown (ruling S4, decided).
MARK_R="$(ad_shim_mark)"
LOG_R="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
OLD_SERVER_PID="${SERVER_PID}"
MCP_PID[${ID_A}]="$(mcp_session_pid "${ID_A}")"
[[ -n "${MCP_PID[${ID_A}]}" ]] || fail "${STEP}: A's stub runs no MCP session client before the restart"
stop_server
expect_worker_runs "${STEP}: after the plain stop" "${ID_A}"
start_and_settle "${STEP}"
[[ "${SERVER_PID}" != "${OLD_SERVER_PID}" ]] || fail "${STEP}: the restart kept bot server ${SERVER_PID}"

# The start pass's reconnect of A's live `waiting` row: guarded keys that
# reaches the renamed session's pane, where the stub opens a new MCP session.
window_calls "${STEP}" "${MARK_R}" - "${ID_A}"
window_has send-keys "${SERVER_PID}" \
    || fail "${STEP}: the new bot server ${SERVER_PID} made no send-keys of ${ID_A} after the rename (its calls: ${WIN_VERBS[*]-none})"
wait_until "${REPORT_WAIT_S}" "${STEP}: A's stub opened no new MCP session after the restart's reconnect" \
    new_mcp_session "${ID_A}"
sleep "${SETTLE_S}"
_scenario_assert_reconnect_rows "${STEP}" "${SERVER_PID}" "${ENTER_DELAY_MS}" \
    "$(ad_cscb_calls "${ID_A}" "${MARK_R}" -)"
window_calls "${STEP}" "${MARK_R}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_A} since the restart: ${WIN_VERBS[*]-none}; A's stub reconnected"
SLICE="$(log_slice "${LOG_R}")"
# src/session-manager.ts reconnectGoneLine: the head, then the persona's
# reference (renderPersonaRef's or the bare key's form), which holds the key.
RECONNECT_GONE_A="$(matcher "${RECONNECT_GONE_HEAD}" "${KEY_A}")"
for m in "${ESCALATE_HEAD_A}" "${RECONNECT_GONE_A}"; do
    n="$(count_in "${SLICE}" "${m}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} line(s) '$(matcher_text "${m}")' since the restart"
done
expect_nothing_launched "${STEP}" "${MARK_R}" "${ID_A}"
expect_status "${STEP}" "${ID_A}" waiting

# The health check's pane read of the renamed session (bullet 2,
# decision D4): A's stub's MCP session ends from the client's side
# (`end_stub_mcp_session`); the server schedules a restart for the
# disconnected persona, and the restart path's reconnect of A's live
# `waiting` row reads its pane (src/session-manager.ts checkWaitingRowPane:
# its existing waiting-row proof), finds no prompt; reconnect rechecks the
# row/pane and fresh screen before its delayed keys reach the renamed pane.
STEP="leg 2 (health check's pane read)"
expect_same_launch "${STEP}" "${ID_B}"
for id in "${ID_A}" "${ID_B}"; do
    MCP_PID[${id}]="$(mcp_session_pid "${id}")"
    [[ -n "${MCP_PID[${id}]}" ]] || fail "${STEP}: ${id}'s stub runs no MCP session client"
done
row="$(row_json "${STEP}" "${ID_A}")"
pane_a="$(jq -r '.pane_id // empty' <<< "${row}")"
[[ "${pane_a}" =~ ^%[0-9]+$ ]] || fail "${STEP}: row ${ID_A} records pane '${pane_a}', not a pane id"
[[ "$("${SCENARIO_REAL_TMUX}" display-message -p -t "${pane_a}" '#{session_name}')" == "${RENAMED_A}" ]] \
    || fail "${STEP}: A's pane ${pane_a} is not in the renamed session ${RENAMED_A}"
FROM_US="${EPOCHREALTIME//[!0-9]/}"
MARK_H="$(ad_shim_mark)"
LOG_H="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
ended="$(end_stub_mcp_session "${pane_a}")" || exit 1
ENDED_US="${EPOCHREALTIME//[!0-9]/}"
echo "${TEST_NAME}: ${STEP}: ended (pane, stub, client): ${ended}"
wait_until $(( 2 * TICK_S + RESTART_DELAY_S + REPORT_WAIT_S )) \
    "${STEP}: A's stub opened no new MCP session after its session ended" new_mcp_session "${ID_A}"
sleep "${SETTLE_S}"
window_calls "${STEP}" "${MARK_H}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: the client ended at +$(( (ENDED_US - FROM_US) / 1000 ))ms; CSCB calls of ${ID_A} since:"
echo_window_timed "${STEP}" "${FROM_US}"
SLICE="$(log_slice "${LOG_H}")"
echo_log_lines "${STEP}" "${SLICE}" "${KEY_A}"
n=0
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == read-pane ]]; then
        n=$(( n + 1 ))
    fi
done
# AD state owns both restart readiness and reconnect readiness.
(( n == 0 )) || fail "${STEP}: automatic reconnect made ${n} pane read(s) after the MCP session ended"
_scenario_assert_reconnect_rows "${STEP}" "${SERVER_PID}" "${ENTER_DELAY_MS}" \
    "$(ad_cscb_calls "${ID_A}" "${MARK_H}" -)"
for verb in spawn resume kill delete; do
    n="$(window_count "${verb}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${ID_A} after its MCP session ended"
done
for m in "${ESCALATE_HEAD_A}" "${RECONNECT_GONE_A}"; do
    n="$(count_in "${SLICE}" "${m}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} line(s) '$(matcher_text "${m}")' since A's MCP session ended"
done
expect_same_launch "${STEP}" "${ID_A}"
expect_status "${STEP}" "${ID_A}" waiting
has_session "${RENAMED_A}" || fail "${STEP}: the renamed session ${RENAMED_A} is gone"
# B is untouched: no call beyond a tick's read, the same MCP session and worker.
window_calls "${STEP}" "${MARK_H}" - "${ID_B}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_B} since A's MCP session ended: ${WIN_VERBS[*]-none}"
for verb in read-pane send-keys spawn resume kill delete; do
    n="$(window_count "${verb}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${ID_B}"
done
[[ "$(mcp_session_pid "${ID_B}")" == "${MCP_PID[${ID_B}]}" ]] \
    || fail "${STEP}: B's MCP session client changed from ${MCP_PID[${ID_B}]} to '$(mcp_session_pid "${ID_B}")'"
expect_same_launch "${STEP}" "${ID_B}"
row_reads "${ID_B}" waiting || fail "${STEP}: row ${ID_B} no longer reads waiting"

# Ticks off again, as leg 5 leaves them: the confirmed edit, which takes
# effect at the start after the teardown below.
apply_personas_config "${STEP}: ticks off" 0

# A CSCB pane read of the renamed session (the package's readPersonaOwnPane,
# through fmk-driver.ts) returns A's pane.
STEP="leg 2 (driver's pane read)"
mark="$(ad_shim_mark)"
run_driver "${STEP}" "${PERSONA_A}" "${CHANNEL_A}" "${WORK_A}" "${EMPTY_TMPDIR}"
[[ "${DRIVER_LINE}" == *" restored=true outcome=${READ_PANE} "* ]] \
    || fail "${STEP}: the driver's pane read of the renamed session did not answer a pane: ${DRIVER_LINE}"
window_calls "${STEP}" "${mark}" - "${ID_A}"
window_has read-pane "${DRIVER_PID}" || fail "${STEP}: no read-pane of ${ID_A} has the driver ${DRIVER_PID} as its parent"
expect_nothing_launched "${STEP}" "${MARK_R}" "${ID_A}"

# The teardown: its precheck's pane read and its kill, both by the CLI.
STEP="leg 2 (teardown)"
MARK_T="$(ad_shim_mark)"
# The tmux shim's log before the teardown: the window in which
# agent-director's own kill of A's session (on the teardown's `kill`) is
# leg 6's positive control.
TMUX_MARK_T="$(tmux_shim_mark)"
stop_server --stop-bots
STOP_PID="$(last_record_pid stop)"
[[ "${STOP_PID}" =~ ^[0-9]+$ ]] || fail "${STEP}: the record holds no stop run"
window_calls "${STEP}" "${MARK_T}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_A} by the teardown: ${WIN_VERBS[*]-none}"
window_has read-pane "${STOP_PID}" "--n-lines ${PROBE_LINES} " \
    || fail "${STEP}: the stop run ${STOP_PID} made no one-line (${PROBE_LINES}) read-pane of ${ID_A}"
window_has kill "${STOP_PID}" \
    || fail "${STEP}: the stop run ${STOP_PID} made no kill of ${ID_A}"
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == read-pane || "${WIN_VERBS[i]}" == kill ]]; then
        [[ "${WIN_PPIDS[i]}" == "${STOP_PID}" ]] \
            || fail "${STEP}: a ${WIN_VERBS[i]} of ${ID_A} has parent ${WIN_PPIDS[i]}, not the stop run ${STOP_PID}"
    fi
    if [[ "${WIN_VERBS[i]}" == kill && " ${WIN_ARGS[i]} " == *include-finished* ]]; then
        fail "${STEP}: the teardown's kill of ${ID_A} carries --include-finished: ${WIN_ARGS[i]}"
    fi
done
wait_until "${KILL_END_WAIT_S}" "${STEP}: the renamed session ${RENAMED_A} outlived the teardown" no_session "${RENAMED_A}"
wait_until "${KILL_END_WAIT_S}" "${STEP}: A's worker outlived the teardown" worker_gone "${ID_A}"
TMUX_MARK_T_END="$(tmux_shim_mark)"
# Leg 6's positive control: the tmux kill form agent-director uses for a
# kill, seen through the same regex leg 6 scans with.
TEARDOWN_TMUX_KILLS="$(ad_parented_tmux_kills "${TMUX_MARK_T}" "${TMUX_MARK_T_END}")"
(( TEARDOWN_TMUX_KILLS >= 1 )) \
    || fail "${STEP}: positive control: no agent-director-parented tmux shim line matching '${TMUX_KILL_RE}' during the teardown's kill"
echo "${TEST_NAME}: ${STEP}: ${TEARDOWN_TMUX_KILLS} agent-director-parented tmux line(s) matching '${TMUX_KILL_RE}' during the teardown"

STEP="leg 2 (start again)"
start_and_settle "${STEP}"
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    note_worker "${STEP}" "${id}"
done

# ---------------------------------------------------------------------------
# Leg 3: a CSCB call made with another TMUX_TMPDIR
# ---------------------------------------------------------------------------

STEP="leg 3 (another TMUX_TMPDIR)"
MARK_D="$(ad_shim_mark)"
for persona in "${PERSONA_A}" "${PERSONA_B}"; do
    if [[ "${persona}" == "${PERSONA_A}" ]]; then
        id="${ID_A}" channel="${CHANNEL_A}" work="${WORK_A}"
    else
        id="${ID_B}" channel="${CHANNEL_B}" work="${WORK_B}"
    fi
    mark="$(ad_shim_mark)"
    run_driver "${STEP}: ${persona}" "${persona}" "${channel}" "${work}" "${EMPTY_TMPDIR}"
    [[ "${DRIVER_LINE}" == *" tmux_tmpdir=\"${EMPTY_TMPDIR}\" restored=true outcome=${READ_PANE} "* ]] \
        || fail "${STEP}: ${persona}: the driver's pane read did not answer a pane under TMUX_TMPDIR ${EMPTY_TMPDIR}: ${DRIVER_LINE}"
    window_calls "${STEP}: ${persona}" "${mark}" - "${id}"
    window_has read-pane "${DRIVER_PID}" || fail "${STEP}: ${persona}: no read-pane of ${id} has the driver ${DRIVER_PID} as its parent"
    [[ "${TMUX_TMPDIR}" == "${SCENARIO_ROOT}/tmux" ]] || fail "${STEP}: TMUX_TMPDIR changed in the scenario's shell: ${TMUX_TMPDIR}"
done
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    expect_nothing_launched "${STEP}" "${MARK_D}" "${id}"
    n="$(window_count spawn)"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} spawn call(s) of ${id}"
done

# ---------------------------------------------------------------------------
# Leg 4: a re-bound socket onset, nothing killed, deleted or launched
# ---------------------------------------------------------------------------

STEP="leg 4 (re-bound socket)"
POSTS_S="$(slack_record_mark "${RECORD}")"
MARK_S="$(ad_shim_mark)"
rebind_tmux_socket > "${SCENARIO_ROOT}/rebind.out"
MOVED_SOCKET="${REBOUND_SOCKET}"
rebound="$(cat -- "${SCENARIO_ROOT}/rebind.out")" || fail "${STEP}: could not read rebind_tmux_socket's output"
echo "${TEST_NAME}: ${STEP}: re-bound: ${rebound}"

LOG_S="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
for id in "${ID_A}" "${ID_B}"; do
    MCP_PID[${id}]="$(mcp_session_pid "${id}")"
done
stop_server
start_server --live
START_COUNT=$(( START_COUNT + 1 ))
wait_for_count "${COMPLETE_2}" "${START_COUNT}" "${START_WAIT_S}" "${STEP}: start pass ${START_COUNT} never completed"
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_A} after the restart" posts_at_least "${SUFFIX_A}" "${POSTS_S}" 1
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_B} after the restart" posts_at_least "${SUFFIX_B}" "${POSTS_S}" 1
ONSET_AT="$(date +%s)"
for label in "${SUFFIX_A}" "${SUFFIX_B}"; do
    posts_of "${label}" "${POSTS_S}"
    want="${CHANGED_ONSET_A}"
    [[ "${label}" == "${SUFFIX_B}" ]] && want="${CHANGED_ONSET_B}"
    [[ "${POSTS[0]}" == "${want}" ]] || fail "${STEP}: the first post for ${label} reads '${POSTS[0]}', not '${want}'"
done

hold_s=$(( ONSET_AT + RETRY_THIRD_S + RETRY_ALLOWANCE_S - $(date +%s) ))
echo "${TEST_NAME}: ${STEP}: onsets posted; holding ${hold_s}s, past the third retry (${RETRY_THIRD_S}s) and ${RETRY_ALLOWANCE_S}s more"
(( hold_s <= 0 )) || sleep "${hold_s}"

n_a="$(expect_outage_posts "${STEP}" "${SUFFIX_A}" "${POSTS_S}" "${CHANGED_ONSET_A}" "${ALL_CLEAR_A}" "${GENERIC_ONSET_A}")"
n_b="$(expect_outage_posts "${STEP}" "${SUFFIX_B}" "${POSTS_S}" "${CHANGED_ONSET_B}" "${ALL_CLEAR_B}" "${GENERIC_ONSET_B}")"
echo "${TEST_NAME}: ${STEP}: posts during the hold: ${n_a} for ${PERSONA_A}, ${n_b} for ${PERSONA_B}"
SLICE="$(log_slice "${LOG_S}")"
n="$(count_in "${SLICE}" "${DIFFERENT_SERVER_PHRASE}")"
(( n >= 1 )) || fail "${STEP}: server.log holds no line carrying '${DIFFERENT_SERVER_PHRASE}' since the restart"
for id in "${ID_A}" "${ID_B}"; do
    expect_nothing_launched "${STEP}" "${MARK_S}" "${id}"
    echo "${TEST_NAME}: ${STEP}: CSCB calls of ${id} since the re-bind: ${WIN_VERBS[*]-none}"
    # AD refuses the key calls while the recorded tmux server is unavailable.
    n=0
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_VERBS[i]}" == send-keys && "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] && n=$(( n + 1 ))
    done
    (( n >= 3 )) || fail "${STEP}: the bot server made ${n} send-keys call(s) of ${id} during the hold, not one per retry for three retries"
    row_reads "${id}" waiting || fail "${STEP}: row ${id} no longer reads waiting"
done

STEP="leg 4 (restore)"
restore_tmux_socket "${MOVED_SOCKET}" > /dev/null
clear_s=$(( ONSET_AT + RETRY_FOURTH_S + RETRY_ALLOWANCE_S - $(date +%s) ))
(( clear_s > POST_WAIT_S )) || clear_s="${POST_WAIT_S}"
wait_until "${clear_s}" "${STEP}: no all-clear for ${PERSONA_A} after the restore" last_post_is "${SUFFIX_A}" "${POSTS_S}" "${ALL_CLEAR_A}"
wait_until "${clear_s}" "${STEP}: no all-clear for ${PERSONA_B} after the restore" last_post_is "${SUFFIX_B}" "${POSTS_S}" "${ALL_CLEAR_B}"
sleep "${SETTLE_S}"
n_a="$(expect_outage_posts "${STEP}" "${SUFFIX_A}" "${POSTS_S}" "${CHANGED_ONSET_A}" "${ALL_CLEAR_A}" "${GENERIC_ONSET_A}")"
n_b="$(expect_outage_posts "${STEP}" "${SUFFIX_B}" "${POSTS_S}" "${CHANGED_ONSET_B}" "${ALL_CLEAR_B}" "${GENERIC_ONSET_B}")"
echo "${TEST_NAME}: ${STEP}: all-clear $(( $(date +%s) - ONSET_AT ))s after the onsets; posts since the re-bind: ${n_a} for ${PERSONA_A}, ${n_b} for ${PERSONA_B}"
last_post_is "${SUFFIX_A}" "${POSTS_S}" "${ALL_CLEAR_A}" || fail "${STEP}: ${PERSONA_A}'s last post is not its all-clear"
last_post_is "${SUFFIX_B}" "${POSTS_S}" "${ALL_CLEAR_B}" || fail "${STEP}: ${PERSONA_B}'s last post is not its all-clear"
for id in "${ID_A}" "${ID_B}"; do
    # The retry that cleared the outage reconnected the persona: its stub
    # runs a new MCP session.
    wait_until "${REPORT_WAIT_S}" "${STEP}: ${id}'s stub opened no new MCP session after the all-clear" new_mcp_session "${id}"
    expect_status "${STEP}" "${id}" waiting
    expect_nothing_launched "${STEP}" "${MARK_S}" "${id}"
done

# ---------------------------------------------------------------------------
# Leg 5: a restarted tmux server; both rows marked missing, both personas
# brought up by the restart path's decision with nothing counted (health
# ticks on for this leg)
# ---------------------------------------------------------------------------

STEP="leg 5 (ticks on)"
apply_personas_config "${STEP}" "${TICK_S}" "${RESTART_DELAY_S}"
restart_and_reconnect "${STEP}"
# Q12's control: over two ticks a healthy persona, its stub holding its MCP
# session, gets no reconnect, launch or kill.
MARK_Q="$(ad_shim_mark)"
sleep $(( 2 * TICK_S + SETTLE_S ))
for id in "${ID_A}" "${ID_B}"; do
    window_calls "${STEP}" "${MARK_Q}" - "${id}"
    echo "${TEST_NAME}: ${STEP}: CSCB calls of ${id} over two ticks: ${WIN_VERBS[*]-none}"
    for verb in send-keys spawn resume kill delete; do
        n="$(window_count "${verb}")"
        [[ "${n}" == 0 ]] || fail "${STEP}: Q12: a health tick made ${n} ${verb} call(s) of ${id}, whose stub holds its MCP session"
    done
    (( $(window_count status) >= 1 )) || fail "${STEP}: no health tick read ${id} over two tick intervals"
    expect_same_launch "${STEP}" "${id}"
done

STEP="leg 5 (restarted tmux server)"
POSTS_T="$(slack_record_mark "${RECORD}")"
MARK_T="$(ad_shim_mark)"
LOG_T="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
declare -A OLD_TOKEN=()
for id in "${ID_A}" "${ID_B}"; do
    OLD_TOKEN[${id}]="${LAUNCH_TOKEN[${id}]}"
done
restarted="$(restart_tmux_server)" || exit 1
echo "${TEST_NAME}: ${STEP}: restarted: ${restarted}"
FM_RUNS_BEFORE="$(find_missing_loop_runs)"
run_find_missing_loop "${FM_INTERVAL_S}"
for id in "${ID_A}" "${ID_B}"; do
    wait_until "${MARK_WAIT_S}" "${STEP}: row ${id} was never marked missing" \
        marked_missing "${id}" "${OLD_TOKEN[${id}]}" "${FM_RUNS_BEFORE}"
done
stop_find_missing_loop
sed 's/^/  loop| /' "${FIND_MISSING_LOOP_LOG}"
for id in "${ID_A}" "${ID_B}"; do
    wait_until "${RELAUNCH_WAIT_S}" "${STEP}: row ${id} was not brought up again (waiting, a new launch)" \
        relaunched_waiting "${id}" "${OLD_TOKEN[${id}]}"
done
sleep "${SETTLE_S}"
SLICE="$(log_slice "${LOG_T}")"
for persona in "${PERSONA_A}" "${PERSONA_B}"; do
    if [[ "${persona}" == "${PERSONA_A}" ]]; then
        id="${ID_A}" key="${KEY_A}" work="${WORK_A}" label="${SUFFIX_A}"
    else
        id="${ID_B}" key="${KEY_B}" work="${WORK_B}" label="${SUFFIX_B}"
    fi
    note_worker "${STEP}" "${id}"
    window_calls "${STEP}" "${MARK_T}" - "${id}"
    echo "${TEST_NAME}: ${STEP}: CSCB calls of ${id} since the tmux restart: ${WIN_VERBS[*]-none} (parents ${WIN_PPIDS[*]-none})"
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_VERBS[i]}" == resume || "${WIN_VERBS[i]}" == spawn ]] \
            && echo "${TEST_NAME}: ${STEP}: ${id}: ${WIN_VERBS[i]} ${WIN_ARGS[i]:0:300}"
    done
    for verb in kill delete; do
        n="$(window_count "${verb}")"
        [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${id}"
    done
    # One launch: one resume by the bot server; a plain spawn before it is the
    # launch's own collision `get` path (refused, ErrInstanceIdCollision).
    expect_one_relaunch "${STEP}" "${id}"
    # The restart path's decision: its liveness read found the row missing,
    # then its launch with no kill (src/restart.ts killBeforeRelaunch).
    without_kill="$(_scenario_printed "${STEP}" relaunchWithoutKillLine "${key}" RELAUNCH_NO_KILL_ROW_READ LIVENESS_READING_DEAD_MISSING)"
    after_kill="$(_scenario_printed "${STEP}" relaunchAfterKillLine "${key}" "${work}" RELAUNCH_KILL_NONE)"
    for m in "${without_kill}" "${after_kill}"; do
        n="$(count_in "${SLICE}" "${m}")"
        [[ "${n}" == 1 ]] || fail "${STEP}: server.log holds ${n} line(s) '${m}' for ${persona} since the tmux restart, not 1"
    done
    echo_log_lines "${STEP}" "${SLICE}" "persona=${key} "
    # src/restart.ts runRestartWork and countLaunchFailure: the counted-failure
    # and cap lines, inline literals with no exported builder (ruling S7).
    for m in "[slack] Session relaunch failed for persona=${key}" "[slack] Cap reached for persona=${key} "; do
        n="$(count_in "${SLICE}" "${m}")"
        [[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} line(s) '${m}' since the tmux restart"
    done
    echo_posts "${STEP}" "${label}" "${POSTS_T}"
    for p in ${POSTS[@]+"${POSTS[@]}"}; do
        [[ "${p}" != *"${SPAWN_FAILURE_HEAD}"* ]] || fail "${STEP}: a spawn-failure or restart-cap post for ${persona}: ${p}"
    done
done

STEP="leg 5 (ticks off)"
apply_personas_config "${STEP}" 0
restart_and_reconnect "${STEP}"

# ---------------------------------------------------------------------------
# Leg 6: remain-on-exit; UNAVAILABLE, then the own-id CONFLICT and one latch
# post with no kill sent; cleared once the harness removes the dead session
# ---------------------------------------------------------------------------

STEP="leg 6 (remain-on-exit)"
# The worker ends once its session is older than the starting-session bound,
# so the resume's UNAVAILABLE is the stopping window's and its CONFLICT comes
# at the retry after that window.
created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${SESSION_A}:" '#{session_created}')" \
    || fail "${STEP}: no session ${SESSION_A} on the scenario's tmux server"
wait_s=$(( created + STARTING_BOUND_S + AGE_MARGIN_S - $(date +%s) ))
if (( wait_s > 0 )); then
    echo "${TEST_NAME}: ${STEP}: waiting ${wait_s}s until session ${SESSION_A} is more than ${STARTING_BOUND_S}s old"
    sleep "${wait_s}"
fi
POSTS_E="$(slack_record_mark "${RECORD}")"
MARK_E="$(ad_shim_mark)"
TMUX_MARK_E="$(tmux_shim_mark)"
set_remain_on_exit "${SESSION_A}"
SID_A_DEAD="$(session_id_of "${SESSION_A}")"
[[ "${SID_A_DEAD}" =~ ^\$[0-9]+$ ]] || fail "${STEP}: no session ${SESSION_A} on the scenario's tmux server"
row="$(row_json "${STEP}" "${ID_A}")"
pane_a="$(jq -r '.pane_id // empty' <<< "${row}")"
[[ "${pane_a}" =~ ^%[0-9]+$ ]] || fail "${STEP}: row ${ID_A} records pane '${pane_a}', not a pane id"
ended="$(end_worker_without_session_end "${pane_a}")" || exit 1
echo "${TEST_NAME}: ${STEP}: ended: ${ended}"
row_reads "${ID_A}" waiting || fail "${STEP}: row ${ID_A} no longer reads waiting right after its worker ended"
has_session "${SESSION_A}" || fail "${STEP}: session ${SESSION_A} did not remain after its worker ended"
run_find_missing_loop "${FM_INTERVAL_S}"
wait_until "${MARK_WAIT_S}" "${STEP}: the find-missing loop never marked row ${ID_A} missing" row_reads "${ID_A}" missing
stop_find_missing_loop
has_session "${SESSION_A}" || fail "${STEP}: session ${SESSION_A} is gone, though remain-on-exit is on"
row_reads "${ID_B}" waiting || fail "${STEP}: row ${ID_B} no longer reads waiting"
expect_worker_runs "${STEP}" "${ID_B}"
echo "${TEST_NAME}: ${STEP}: row ${ID_A} reads missing beside its dead session ${SID_A_DEAD}"

# The bot server restarted without teardown (ruling S4) provokes A's resume.
LOG_E="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
stop_server
start_server --live
START_COUNT=$(( START_COUNT + 1 ))
RESTART_AT="$(date +%s)"
wait_for_count "${COMPLETE_2}" "${START_COUNT}" "${START_WAIT_S}" "${STEP}: start pass ${START_COUNT} never completed"
# A's own-id latch line: its printed head and case, then agent-director's
# description, which carries the own-id phrase.
LATCH_OWN_ID_A="$(matcher "${LATCH_HEAD_A}${OWN_ID_CASE} " "${OWN_ID_PHRASE}")"
wait_for_log "${LATCH_OWN_ID_A}" $(( RETRY_FOURTH_S + RETRY_ALLOWANCE_S )) "${STEP}: ${PERSONA_A} never latched on '${OWN_ID_PHRASE}'"
echo "${TEST_NAME}: ${STEP}: latched $(( $(date +%s) - RESTART_AT ))s after the restart"
SLICE="$(log_slice "${LOG_E}")"
conflict_line="$(_scenario_scan first "${SLICE}" "${OWN_ID_PHRASE}")"
[[ -n "${conflict_line}" ]] || fail "${STEP}: server.log holds no '${OWN_ID_PHRASE}' line since the restart"
unavailable=0
for phrase in "${STOPPING_PHRASE}" "${STARTING_PHRASE}"; do
    first="$(_scenario_scan first "${SLICE}" "${phrase}")"
    last="$(_scenario_scan last "${SLICE}" "${phrase}")"
    [[ -n "${first}" ]] || continue
    (( last < conflict_line )) \
        || fail "${STEP}: an UNAVAILABLE line carrying '${phrase}' (line ${last} since the restart) comes after the CONFLICT (line ${conflict_line})"
    n="$(count_in "${SLICE}" "${phrase}")"
    unavailable=$(( unavailable + n ))
    echo "${TEST_NAME}: ${STEP}: UNAVAILABLE '${phrase}' ${n} time(s) before the CONFLICT"
    echo_log_lines "${STEP}" "${SLICE}" "${phrase}"
done
(( unavailable >= 1 )) \
    || fail "${STEP}: no UNAVAILABLE line ('${STOPPING_PHRASE}' or '${STARTING_PHRASE}') came before the CONFLICT"

# One latch post, with the CONFLICT notice's CSCB-authored parts and no
# session-ending command. Before it, only the tmux-unresponsive onset and
# alert the UNAVAILABLE answers may post, each at most once.
wait_until "${POST_WAIT_S}" "${STEP}: no latch post for ${PERSONA_A}" \
    post_opening_with "${SUFFIX_A}" "${POSTS_E}" "${NOTICE_HEAD_A}"
sleep "${SETTLE_S}"
echo_posts "${STEP}" "${SUFFIX_A}" "${POSTS_E}"
posts_of "${SUFFIX_A}" "${POSTS_E}"
UNRESPONSIVE_POSTS=0
for i in "${!POSTS[@]}"; do
    if (( i == ${#POSTS[@]} - 1 )); then
        [[ "${POSTS[i]}" == "${NOTICE_HEAD_A}"* ]] \
            || fail "${STEP}: the last post for ${PERSONA_A} is not the latch post: ${POSTS[i]}"
    elif [[ "${POSTS[i]}" == "${UNRESPONSIVE_ONSET_A}" || "${POSTS[i]}" == "${UNRESPONSIVE_ALERT_A}" ]]; then
        for (( j = 0; j < i; j++ )); do
            [[ "${POSTS[j]}" != "${POSTS[i]}" ]] || fail "${STEP}: a tmux-unresponsive post for ${PERSONA_A} came twice: ${POSTS[i]}"
        done
        UNRESPONSIVE_POSTS=$(( UNRESPONSIVE_POSTS + 1 ))
    else
        fail "${STEP}: post $(( i + 1 )) for ${PERSONA_A} before the latch is neither the latch post nor a tmux-unresponsive notice: ${POSTS[i]}"
    fi
done
LATCH_POST="${POSTS[${#POSTS[@]}-1]}"
echo "${TEST_NAME}: ${STEP}: one latch post, after ${UNRESPONSIVE_POSTS} tmux-unresponsive post(s)"
# The session name between double quotes (src/conflict-latch.ts slackQuotedSession).
expect_in_order "${STEP}: the latch post" "${LATCH_POST}" \
    "${NOTICE_HEAD_A}\"${SESSION_A}\"" "${OWN_ID_SENTENCE}" "${NOTICE_POINTER}" "${NOTICE_HUMAN_ONLY}"
forms="$(printf '%s' "${LATCH_POST}" | bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sessionEndingCommandsIn)" \
    || fail "${STEP}: fmk-texts could not read the latch post"
[[ -z "${forms}" ]] || fail "${STEP}: the latch post's own lines name a session-ending command: ${forms//$'\n'/, }"

# No launch, no delete and no kill sent (D3).
window_calls "${STEP}" "${MARK_E}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_A} up to the latch: ${WIN_VERBS[*]-none}"
for verb in kill delete; do
    n="$(window_count "${verb}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${ID_A}"
done
window_has resume "${SERVER_PID}" || fail "${STEP}: the bot server ${SERVER_PID} made no resume of ${ID_A}"
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == spawn && " ${WIN_ARGS[i]} " == *" --reuse-finished "* ]]; then
        fail "${STEP}: a CSCB process made a reuse spawn of ${ID_A}: ${WIN_ARGS[i]}"
    fi
done
row="$(row_json "${STEP}" "${ID_A}")"
[[ "$(jq -r '.state' <<< "${row}")" == missing && "$(jq -r '.launch_token // empty' <<< "${row}")" == "${LAUNCH_TOKEN[${ID_A}]}" ]] \
    || fail "${STEP}: row ${ID_A} no longer reads missing with its launch token: $(jq -c '{state, launch_token}' <<< "${row}")"
# Leg 2's teardown showed agent-director's kill through this regex (its
# positive control, TEARDOWN_TMUX_KILLS); none since this leg began.
n="$(tmux_kill_lines "${TMUX_MARK_E}")"
[[ "${n}" == 0 ]] || fail "${STEP}: the tmux shim's log holds ${n} line(s) matching '${TMUX_KILL_RE}' since the leg began"
[[ "$(session_id_of "${SESSION_A}")" == "${SID_A_DEAD}" ]] || fail "${STEP}: the dead session ${SID_A_DEAD} is no longer ${SESSION_A}"

STEP="leg 6 (dead session removed)"
MARK_H="$(ad_shim_mark)"
end_session "${SID_A_DEAD}"
wait_until $(( RECHECK_S + RECHECK_ALLOWANCE_S )) "${STEP}: no resume of ${ID_A} after the dead session's removal" \
    shim_line_after "${MARK_H}" resume "${ID_A}"
window_any "${STEP}" "${MARK_H}" - "${ID_A}"
window_until resume
[[ "${WIN_VERBS[*]}" == "status read-pane find-missing get resume" ]] \
    || fail "${STEP}: the bot server's calls up to the resume were '${WIN_VERBS[*]}', not 'status read-pane find-missing get resume'"
for i in "${!WIN_VERBS[@]}"; do
    [[ "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] \
        || fail "${STEP}: its ${WIN_VERBS[i]} has parent ${WIN_PPIDS[i]}, not the bot server ${SERVER_PID}"
done
[[ " ${WIN_ARGS[1]} " == *" --n-lines ${PROBE_LINES} "* ]] || fail "${STEP}: its read-pane does not read ${PROBE_LINES} line(s): ${WIN_ARGS[1]}"
# The re-check round line (ROUND_CLEARED_A, printed with the values).
wait_for_log "${ROUND_CLEARED_A}" "${POST_WAIT_S}" "${STEP}: the round logged no probe cleared on ${READ_GONE}"
wait_until "${REPORT_WAIT_S}" "${STEP}: the resumed row never reported in (waiting)" row_reads "${ID_A}" waiting
expect_status "${STEP}" "${ID_A}" waiting
want=$(( UNRESPONSIVE_POSTS + 2 ))
wait_until "${POST_WAIT_S}" "${STEP}: no recovery post" posts_at_least "${SUFFIX_A}" "${POSTS_E}" "${want}"
sleep "${SETTLE_S}"
posts_of "${SUFFIX_A}" "${POSTS_E}"
(( ${#POSTS[@]} == want )) || fail "${STEP}: ${#POSTS[@]} posts for ${PERSONA_A} in the leg, not ${want} (the latch post and the recovery post after ${UNRESPONSIVE_POSTS} tmux-unresponsive post(s))"
[[ "${POSTS[want-2]}" == "${LATCH_POST}" ]] || fail "${STEP}: the latch post changed: ${POSTS[want-2]}"
[[ "${POSTS[want-1]}" == "${CONFLICT_RECOVERY_A}" ]] || fail "${STEP}: the recovery post reads '${POSTS[want-1]}', not '${CONFLICT_RECOVERY_A}'"
# One find-missing and one resume over the whole window since the dead
# session's removal, not only up to the first resume.
n="$(cscb_ad_count_between "${MARK_H}" - resume "--instance-id ${ID_A}")"
[[ "${n}" == 1 ]] || fail "${STEP}: CSCB made ${n} resume call(s) of ${ID_A} since the dead session's removal, not 1"
n="$(cscb_ad_count_between "${MARK_H}" - find-missing)"
[[ "${n}" == 1 ]] || fail "${STEP}: CSCB made ${n} find-missing call(s) since the dead session's removal, not 1"
note_worker "${STEP}" "${ID_A}"

# ---------------------------------------------------------------------------
# Leg 7: a pending row with no launch start; no keys, no kill, one post and
# status-only re-checks; cleared with one bring-up retry once the harness's
# loop marks it missing
# ---------------------------------------------------------------------------

STEP="leg 7 (pending row with no launch start)"
POSTS_P="$(slack_record_mark "${RECORD}")"
MARK_P="$(ad_shim_mark)"
LOG_P="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
SID_B_OLD="$(session_id_of "${SESSION_B}")"
[[ "${SID_B_OLD}" =~ ^\$[0-9]+$ ]] || fail "${STEP}: no session ${SESSION_B} on the scenario's tmux server"
ad_store_pending_no_launch "${ID_B}"
expect_worker_runs "${STEP}" "${ID_B}"
# B's latch line: its printed head and the hold case. The status-only
# re-check's round lines are ROUND_HELD_B and ROUND_CLEARED_B (printed with
# the values).
LATCH_HOLD_B="${LATCH_HEAD_B}${HOLD_CASE} "
held_before="$(count_log "${ROUND_HELD_B}")"
stop_server
start_server --live
START_COUNT=$(( START_COUNT + 1 ))
wait_for_count "${COMPLETE_2}" "${START_COUNT}" "${START_WAIT_S}" "${STEP}: start pass ${START_COUNT} never completed"
wait_for_log "${LATCH_HOLD_B}" "${START_WAIT_S}" "${STEP}: ${PERSONA_B} never latched with '${HOLD_CASE}'"
MARK_L="$(ad_shim_mark)"
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_B} after the latch" posts_at_least "${SUFFIX_B}" "${POSTS_P}" 1
sleep "${SETTLE_S}"
posts_of "${SUFFIX_B}" "${POSTS_P}"
(( ${#POSTS[@]} == 1 )) || fail "${STEP}: ${#POSTS[@]} posts for ${PERSONA_B} after the latch, not 1"
[[ "${POSTS[0]}" == "${HOLD_NOTICE_B}" ]] || fail "${STEP}: the latch post reads '${POSTS[0]}', not '${HOLD_NOTICE_B}'"
window_calls "${STEP}" "${MARK_P}" - "${ID_B}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_B} up to the latch: ${WIN_VERBS[*]-none}"

STEP="leg 7 (held)"
wait_for_count "${ROUND_HELD_B}" $(( held_before + 1 )) $(( RECHECK_S + RECHECK_ALLOWANCE_S )) "${STEP}: no status-only re-check held the latch"
sleep "${SETTLE_S}"
MARK_HELD="$(ad_shim_mark)"
window_any "${STEP}" "${MARK_L}" "${MARK_HELD}" "${ID_B}"
[[ "${WIN_VERBS[*]-}" == status ]] || fail "${STEP}: the re-check's calls were '${WIN_VERBS[*]-}', not one status"
[[ "${WIN_PPIDS[0]}" == "${SERVER_PID}" ]] || fail "${STEP}: its status has parent ${WIN_PPIDS[0]}, not the bot server ${SERVER_PID}"
window_calls "${STEP}" "${MARK_P}" "${MARK_HELD}" "${ID_B}"
for verb in send-keys kill; do
    n="$(window_count "${verb}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${ID_B} while it was latched"
done
expect_worker_runs "${STEP}" "${ID_B}"
row_reads "${ID_B}" pending || fail "${STEP}: row ${ID_B} no longer reads pending"

STEP="leg 7 (the loop marks the row)"
run_find_missing_loop "${FM_INTERVAL_S}"
wait_until "${MARK_WAIT_S}" "${STEP}: the find-missing loop never marked row ${ID_B} missing" row_reads "${ID_B}" missing
stop_find_missing_loop
sed 's/^/  loop| /' "${FIND_MISSING_LOOP_LOG}"
wait_for_log "${ROUND_CLEARED_B}" $(( RECHECK_S + RECHECK_ALLOWANCE_S )) "${STEP}: no re-check cleared the latch on missing"
wait_for_log "${RETRY_AT_ONCE_HEAD_B}" "${START_WAIT_S}" "${STEP}: no bring-up retry followed the clear"
MARK_R="$(ad_shim_mark)"
window_any "${STEP}" "${MARK_HELD}" "${MARK_R}" "${ID_B}"
echo "${TEST_NAME}: ${STEP}: CSCB calls from the held re-check to the retry's answer: ${WIN_VERBS[*]-none}"
[[ "${WIN_VERBS[0]:-}" == status ]] || fail "${STEP}: the clearing re-check made '${WIN_VERBS[0]:-none}' first, not status"
n="$(window_count find-missing)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} find-missing call(s) before the bring-up retry"
for verb in send-keys kill; do
    n="$(window_count "${verb}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) of ${ID_B}"
done
for i in "${!WIN_VERBS[@]}"; do
    [[ "${WIN_VERBS[i]}" == resume || "${WIN_VERBS[i]}" == spawn ]] \
        && echo "${TEST_NAME}: ${STEP}: ${ID_B}: ${WIN_VERBS[i]} ${WIN_ARGS[i]:0:300}"
done
wait_until "${POST_WAIT_S}" "${STEP}: no recovery post" posts_at_least "${SUFFIX_B}" "${POSTS_P}" 2
sleep "${SETTLE_S}"
posts_of "${SUFFIX_B}" "${POSTS_P}"
[[ "${POSTS[1]}" == "${HOLD_RECOVERY_B}" ]] || fail "${STEP}: the second post reads '${POSTS[1]}', not '${HOLD_RECOVERY_B}'"
n=0
for p in "${POSTS[@]}"; do
    [[ "${p}" == "${HOLD_RECOVERY_B}" ]] && n=$(( n + 1 ))
done
(( n == 1 )) || fail "${STEP}: ${n} recovery posts for ${PERSONA_B}, not 1"
n="$(count_log "${RETRY_AT_ONCE_HEAD_B}")"
[[ "${n}" == 1 ]] || fail "${STEP}: server.log holds ${n} after-clear retry line(s) for ${PERSONA_B}, not 1"
# The one bring-up retry is the restart path's decision: one resume, after
# its liveness read found the row missing and with no kill.
window_any "${STEP}" "${MARK_HELD}" "${MARK_R}" "${ID_B}"
expect_one_relaunch "${STEP}" "${ID_B}"
SLICE="$(log_slice "${LOG_P}")"
without_kill="$(_scenario_printed "${STEP}" relaunchWithoutKillLine "${KEY_B}" RELAUNCH_NO_KILL_ROW_READ LIVENESS_READING_DEAD_MISSING)"
after_kill="$(_scenario_printed "${STEP}" relaunchAfterKillLine "${KEY_B}" "${WORK_B}" RELAUNCH_KILL_NONE)"
for m in "${without_kill}" "${after_kill}"; do
    n="$(count_in "${SLICE}" "${m}")"
    [[ "${n}" == 1 ]] || fail "${STEP}: server.log holds ${n} line(s) '${m}' since the leg began, not 1"
done

# Ruling S8: what the retry met beside the still-running old session is
# recorded, not asserted.
STEP="leg 7 (S8 record)"
SLICE="$(log_slice "${LOG_P}")"
echo_log_lines "${STEP}" "${SLICE}" "${RETRY_AT_ONCE_HEAD_B}"
echo_log_lines "${STEP}" "${SLICE}" "persona=${KEY_B} "
echo_posts "${STEP}" "${SUFFIX_B}" "${POSTS_P}"
row="$(row_json "${STEP}" "${ID_B}")"
summary="$(jq -c '{state, launch_token, pid}' <<< "${row}")" || fail "${STEP}: jq could not read row ${ID_B}"
echo "${TEST_NAME}: ${STEP}: row ${ID_B}: ${summary}"
if [[ "$(session_id_of "${SESSION_B}")" == "${SID_B_OLD}" ]]; then
    end_session "${SID_B_OLD}"
    echo "${TEST_NAME}: ${STEP}: the old session ${SID_B_OLD} ended by the harness"
fi

# ---------------------------------------------------------------------------
# Leg 8: close
# ---------------------------------------------------------------------------

STEP="leg 8 (close)"
stop_server --stop-bots
stop_tracked_pid "${SLACK_STUB_PID}" 10 "${STEP}: the Slack stub did not exit on SIGTERM"

# No fragment: every line whose parent is a CSCB process.
# shellcheck disable=SC2119
n="$(cscb_tmux_count)"
if [[ "${n}" != 0 ]]; then
    # shellcheck disable=SC2119
    cscb_tmux_calls | sed 's/^/  | /' >&2
    fail "${STEP}: the tmux shim's log holds ${n} line(s) whose parent is a CSCB process"
fi
# The filter's own control, over a copy of the log with five lines added, each
# carrying SCENARIO_AD_OWNER_OPTION at the start of a recorded process's
# window: it counts the lines whose parent is the last bot server, the last
# `stop` run and the last fmk-driver.ts run, and not the ones whose parent is
# the scenario's shell or a process the record does not hold.
ctl="${SCENARIO_ROOT}/tmux-filter-control.log"
cp -- "${SCENARIO_TMUX_SHIM_LOG}" "${ctl}" || fail "${STEP}: could not copy the tmux shim's log"
for role in server stop run; do
    entry="$(awk -F'\t' -v r="${role}" '$1 == "proc" && $2 == r { e = $3 "\t" $5 } END { print e }' "${SCENARIO_CSCB_RECORD}")"
    [[ "${entry}" =~ ^[0-9]+$'\t'[0-9]+\.[0-9]{6}$ ]] || fail "${STEP}: the record holds no ${role} entry for the filter's control"
    printf 'call\t%s\t1\t%s\t?\tshow-options -v %s\n' "${entry#*$'\t'}" "${entry%%$'\t'*}" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
done
printf 'call\t%s\t1\t%s\t?\tshow-options -v %s\n' "${EPOCHREALTIME/,/.}" "$$" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
printf 'call\t%s\t1\t1\t?\tshow-options -v %s\n' "${EPOCHREALTIME/,/.}" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
n="$(SCENARIO_TMUX_SHIM_LOG="${ctl}" cscb_tmux_count "${SCENARIO_AD_OWNER_OPTION}")"
[[ "${n}" == 3 ]] || fail "${STEP}: the filter's control: cscb_tmux_count counted ${n} of the added lines, not the bot server's, the stop run's and the driver's 3"
for option in "${SCENARIO_AD_OWNER_OPTION}" "${SCENARIO_AD_PANE_OPTION}"; do
    n="$(ad_parented_tmux_count "${option}")"
    (( n >= 1 )) || fail "${STEP}: positive control: no tmux shim line carrying ${option} has an agent-director parent"
    echo "${TEST_NAME}: ${STEP}: ${n} agent-director tmux call(s) carry ${option}; none by a CSCB process"
done

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
