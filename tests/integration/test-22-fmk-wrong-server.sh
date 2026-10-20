#!/usr/bin/env bash
# Verify wrong-server and conflict-latch recovery from AD outcomes.
# One-line outcome probes retain provenance checks and do not classify pane text.

set -euo pipefail

TEST_NAME="test-22-fmk-wrong-server"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values, from src/ through the printer
# ---------------------------------------------------------------------------

STEP_VALUES="values"
PERSONA_NAME="${SCENARIO_TAG}_wrong"
PERSONA_KEY="$(persona_key "${PERSONA_NAME}")"
CHANNEL="C0T22WRG1"
SLACK_SUFFIX="t22wrong"

# src/persona-identity.ts personaInstanceId, personaTmuxSessionName.
INSTANCE_ID="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${PERSONA_KEY}")"
SESSION_NAME="$(_scenario_printed "${STEP_VALUES}" personaTmuxSessionName "${PERSONA_KEY}")"
# src/conflict-latch.ts.
RECHECK_MS="$(_scenario_printed "${STEP_VALUES}" LATCH_RECHECK_INTERVAL_MS)"
OWN_ID_CASE="$(_scenario_printed "${STEP_VALUES}" LATCH_CASE_OWN_ID)"
OWN_ID_SENTENCE="$(_scenario_printed "${STEP_VALUES}" conflictCaseSentence "${OWN_ID_CASE}")"
NOTICE_HEAD="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_NAME}" CONFLICT_NOTICE_FIRST_LINE_HEAD)"
NOTICE_POINTER="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_POINTER_LINE)"
NOTICE_HUMAN_ONLY="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_HUMAN_ONLY_LINE)"
RECOVERY_POST="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_NAME}" \
    conflictRecoveryText "${SESSION_NAME}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)"
CALL_PROBE="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_PROBE)"
CALL_RESUME="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_RESUME)"
STEP_TABLE="$(_scenario_printed "${STEP_VALUES}" RECHECK_STEP_TABLE)"
VERDICT_STILL_LATCHED="$(_scenario_printed "${STEP_VALUES}" RECHECK_VERDICT_STILL_LATCHED)"
# The heads of the persona's latch and relatch lines (conflictLatchSetLine,
# up to and including `case=`).
LATCH_HEAD="$(_scenario_printed "${STEP_VALUES}" conflictLatchSetLineHead "${PERSONA_KEY}" latched)"
RELATCH_HEAD="$(_scenario_printed "${STEP_VALUES}" conflictLatchSetLineHead "${PERSONA_KEY}" relatched)"
# src/pane-read.ts.
PROBE_LINES="$(_scenario_printed "${STEP_VALUES}" PROBE_PANE_READ_LINES)"
READ_PANE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_PANE)"
READ_GONE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_GONE)"
# src/config.ts.
POLL_INTERVAL_MS="$(_scenario_printed "${STEP_VALUES}" MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS)"
# src/ad-description-phrases.ts.
OWN_ID_PHRASE="$(_scenario_printed "${STEP_VALUES}" CONFLICT_OWN_ID_PHRASE)"
STOPPING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STOPPING_PHRASE)"
STARTING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STARTING_PHRASE)"
# src/ad-settings.ts: the stopping window's and the starting-session bound's
# minimums (agent-director's own key names; the printer refuses a key the
# package records no minimum for).
KEY_STOPPING=stopping_window_seconds
KEY_STARTING=starting_session_seconds
MIN_STOPPING="$(_scenario_printed "${STEP_VALUES}" AD_SETTING_MINIMUMS "${KEY_STOPPING}")"
MIN_STARTING="$(_scenario_printed "${STEP_VALUES}" AD_SETTING_MINIMUMS "${KEY_STARTING}")"

[[ "${RECHECK_MS}" =~ ^[1-9][0-9]*$ && "${PROBE_LINES}" =~ ^[1-9][0-9]*$ && "${POLL_INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the re-check interval '${RECHECK_MS}', the probe's line count '${PROBE_LINES}' or the poll interval '${POLL_INTERVAL_MS}' is not a whole number"
[[ "${MIN_STOPPING}" =~ ^[1-9][0-9]*$ && "${MIN_STARTING}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the minimums '${MIN_STOPPING}' (${KEY_STOPPING}) and '${MIN_STARTING}' (${KEY_STARTING}) are not whole numbers above 0"
RECHECK_S=$(( (RECHECK_MS + 999) / 1000 ))
TMUX_PAIRS=("${KEY_STOPPING}=${MIN_STOPPING}" "${KEY_STARTING}=${MIN_STARTING}")
BOUND_S="${MIN_STOPPING}"
(( MIN_STARTING <= BOUND_S )) || BOUND_S="${MIN_STARTING}"

# Waits, in seconds (see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
LATCH_WAIT_S=120
POST_WAIT_S=30
KILL_END_WAIT_S=15
SETTLE_S=3
HOLD_EXTRA_S=5
AGE_MARGIN_S=2
RECHECK_ALLOWANCE_S=60
HELD_RECHECKS=2

# Set by the legs.
SLACK_STUB_PID=""
RECORD=""
WORKER_PID=""
PANE_PID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair ending in <suffix> (label <suffix>) and
# refusing any other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and RECORD.
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

# row_json <step>: print the persona's row (one JSON object) from a read-only
# store read.
row_json() {
    local out
    out="$(ad_store_row "${INSTANCE_ID}")" || exit 1
    jq -c '.[0]' <<< "${out}"
}

# True when the persona's row reads <state> (a read-only store read, which
# adds no line to the shim's log).
row_reads() {
    local state
    state="$(_scenario_store_read "row state" "SELECT state FROM spawns WHERE instance_id = '${INSTANCE_ID}'")" || exit 1
    [[ "${state}" == "$1" ]]
}

# expect_status <step> <state>: a harness `status` read of the persona's row
# reads <state>.
expect_status() {
    local step="$1" want="$2" got
    ad_capture status --instance-id "${INSTANCE_ID}"
    (( AD_RC == 0 )) || fail "${step}: the harness status read exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: the row reads '${got}', not ${want}"
}

# note_worker <step>: set WORKER_PID and PANE_PID from the row; fail unless
# both run and the pane's process is the stub.
note_worker() {
    local step="$1" row
    row="$(row_json "${step}")"
    WORKER_PID="$(jq -r '.pid // empty' <<< "${row}")"
    PANE_PID="$(jq -r '.pane_pid // empty' <<< "${row}")"
    [[ "${WORKER_PID}" =~ ^[0-9]+$ && "${PANE_PID}" =~ ^[0-9]+$ ]] \
        || fail "${step}: the row records worker pid '${WORKER_PID}' and pane pid '${PANE_PID}'"
    expect_worker_runs "${step}"
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/${PANE_PID}/cmdline" 2> /dev/null \
        || fail "${step}: the pane's process ${PANE_PID} is not the stub ${SCENARIO_BIN}/claude"
}

# expect_worker_runs <step>: the worker's process and the pane's process run.
expect_worker_runs() {
    if ! pid_alive "${WORKER_PID}" || ! pid_alive "${PANE_PID}"; then
        fail "$1: the worker (pid ${WORKER_PID}, pane pid ${PANE_PID}) no longer runs"
    fi
}

# True when neither the worker's process nor the pane's process runs.
worker_gone() {
    ! pid_alive "${WORKER_PID}" && ! pid_alive "${PANE_PID}"
}

# True when the scenario's tmux server holds a session named exactly <name>.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

no_session() {
    ! has_session "$1"
}

# post_count <after-seq>: print how many posts the Slack record holds for the
# persona's label after <after-seq>.
post_count() {
    local out
    out="$(slack_label_posts "${RECORD}" "${SLACK_SUFFIX}" "$1")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

posts_at_least() {
    local n
    n="$(post_count "$1")" || exit 1
    (( n >= $2 ))
}

# post_text <after-seq> <n>: print the text of the <n>th post (from 1) after
# <after-seq>, with a sentinel so trailing newlines are kept (strip the last
# `x`).
post_text() {
    local out
    out="$(slack_label_posts "${RECORD}" "${SLACK_SUFFIX}" "$1")" || exit 1
    sed -n "$2p" <<< "${out}" | jq -j '.' && printf x
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

# True when the agent-director shim's log holds, after line <mark>, a line
# holding <verb> and the persona's instance id (a cheap scan; the windows
# below read whose call it is).
shim_line_after() {
    tail -n "+$(( $1 + 1 ))" "${SCENARIO_AD_SHIM_LOG}" 2> /dev/null | grep -F -- "$2" | grep -qF -- "${INSTANCE_ID}"
}

# window_calls <step> <from-mark> <to-mark|->: set WIN_VERBS, WIN_ARGS (the
# arguments joined by single spaces) and WIN_PPIDS to each CSCB-parented
# agent-director call in the shim log's window, in log order, leaving out
# `version`.
window_calls() {
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
        WIN_VERBS+=("${_L_VERB}")
        printf -v a '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        WIN_ARGS+=("${a% }")
        WIN_PPIDS+=("${_L_PPID}")
    done <<< "${out}"
}

# expect_window <step> <verb>...: the window's calls (window_calls) are
# exactly <verb>..., in order, each by the bot server; each but find-missing
# names the persona's instance id, and a read-pane reads PROBE_LINES lines.
expect_window() {
    local step="$1" i want
    shift
    want="$*"
    [[ "${WIN_VERBS[*]-}" == "${want}" ]] \
        || fail "${step}: the bot server's calls were '${WIN_VERBS[*]-}', not '${want}'"
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] \
            || fail "${step}: its ${WIN_VERBS[i]} has parent ${WIN_PPIDS[i]}, not the bot server ${SERVER_PID}"
        if [[ "${WIN_VERBS[i]}" != find-missing ]]; then
            [[ " ${WIN_ARGS[i]} " == *" --instance-id ${INSTANCE_ID} "* ]] \
                || fail "${step}: its ${WIN_VERBS[i]} names no --instance-id ${INSTANCE_ID}: ${WIN_ARGS[i]}"
        fi
        if [[ "${WIN_VERBS[i]}" == read-pane ]]; then
            [[ " ${WIN_ARGS[i]} " == *" --n-lines ${PROBE_LINES} "* ]] \
                || fail "${step}: its read-pane does not read ${PROBE_LINES} line(s): ${WIN_ARGS[i]}"
        fi
    done
}

# harness_find_missing <step> <mark>: the harness's last `ad_capture
# find-missing` exited 0 with a JSON object whose `ids` is an array without
# the persona's instance id, and the shim logged it, after <mark>, with the
# scenario's shell as parent.
harness_find_missing() {
    local step="$1" mark="$2" lines=() i n=0 answer
    (( AD_RC == 0 )) || fail "${step}: find-missing exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    jq -e 'type == "object" and (.ids | type) == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: find-missing printed no JSON object with an ids array: $(head -c 300 "${AD_OUT}")"
    jq -e --arg id "${INSTANCE_ID}" '.ids | index($id) == null' "${AD_OUT}" > /dev/null \
        || fail "${step}: find-missing listed ${INSTANCE_ID} in its ids: $(tr '\n' ' ' < "${AD_OUT}")"
    answer="$(jq -c '.' "${AD_OUT}")" || fail "${step}: jq could not read find-missing's answer"
    echo "${TEST_NAME}: ${step}: find-missing answered ${answer}"
    mapfile -t lines < <(tail -n "+$(( mark + 1 ))" "${SCENARIO_AD_SHIM_LOG}")
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}" && [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words || continue
        _scenario_ad_verb
        [[ "${_L_VERB}" == find-missing && "${_L_PPID}" == "$$" && "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] \
            && n=$(( n + 1 ))
    done
    (( n == 1 )) || fail "${step}: the shim logged ${n} find-missing call(s) from the scenario's shell since the call, not 1"
}

# The persona's own-id latch line: its printed head and case, then
# agent-director's description, which carries the own-id phrase.
LATCH_OWN_ID="$(matcher "${LATCH_HEAD}${OWN_ID_CASE} " "${OWN_ID_PHRASE}")"
# The re-check round lines (src/conflict-latch.ts latchRecheckRoundLine, printed
# whole), with the answers src/session-manager.ts runLatchRecheckRound composes
# inline: `<verdict> (<pane read kind>)` for a probe that holds, and
# `probe-cleared (<pane read kind>); …` with the call
# `<probe>+find-missing+<retry>` (latchRecheckClearedProbeRetry's call label)
# for one that cleared, of which the line up to the `;` is matched.
ROUND_HELD="$(_scenario_printed "${STEP_VALUES}" latchRecheckRoundLine "${PERSONA_NAME}" "${OWN_ID_CASE}" \
    "${STEP_TABLE}" "${CALL_PROBE}" "${VERDICT_STILL_LATCHED} (${READ_PANE})")"
ROUND_CLEARED="$(_scenario_printed "${STEP_VALUES}" latchRecheckRoundLine "${PERSONA_NAME}" "${OWN_ID_CASE}" \
    "${STEP_TABLE}" "${CALL_PROBE}+find-missing+${CALL_RESUME}" "probe-cleared (${READ_GONE});")"

# ---------------------------------------------------------------------------
# Leg 1: set-up and start
# ---------------------------------------------------------------------------

STEP="set-up"
CREDS="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS}" || fail "${STEP}: could not create ${CREDS}"
CONFIG_DIR="${SCENARIO_ROOT}/claude-config"
mkdir -p "${CONFIG_DIR}" || fail "${STEP}: could not create ${CONFIG_DIR}"
WORK="$(make_workdir wrong)"
stub_mode "${WORK}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK}" "${STUB_MODE_AT_ONCE}"

# The [tmux] table, before the server starts: both keys at their minimums.
write_ad_settings "${TMUX_PAIRS[@]}"
echo "${TEST_NAME}: ${STEP}: [tmux] ${TMUX_PAIRS[*]} (session must pass ${BOUND_S}s); re-check every ${RECHECK_S}s"

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${SLACK_SUFFIX}"
BOT_TOKEN="$(fake_token bot "${SLACK_SUFFIX}")"
APP_TOKEN="$(fake_token app "${SLACK_SUFFIX}")"
printf '{"bot_token": "%s", "app_token": "%s"}\n' "${BOT_TOKEN}" "${APP_TOKEN}" | write_file "${CREDS}/wrong.json" 600
write_config << EOF
{
  "personas": [
    {
      "name": "${PERSONA_NAME}",
      "credentials_file": "${CREDS}/wrong.json",
      "working_directory": "${WORK}",
      "claude_config_dir": "${CONFIG_DIR}",
      "channels": [{ "id": "${CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "agent_director_poll_interval_ms": ${POLL_INTERVAL_MS},
  "exit_timeout": 5
}
EOF

STEP="leg 1 (start)"
start_server --live
COMPLETE_1="$(completion_match 1)"
wait_for_log "${COMPLETE_1}" "${START_WAIT_S}" "${STEP}: the start pass never completed"
expect_completion 1 "${STEP}" "0 not brought up"
wait_until "${REPORT_WAIT_S}" "${STEP}: row ${INSTANCE_ID} never reported in (waiting)" row_reads waiting
expect_status "${STEP}" waiting
note_worker "${STEP}"
n="$(cscb_ad_count send-keys "--instance-id ${INSTANCE_ID}")"
(( n >= 1 )) || fail "${STEP}: no CSCB send-keys cleared the stub's dialog"

# ---------------------------------------------------------------------------
# Leg 2: part A, find-missing from another tmux environment
# ---------------------------------------------------------------------------

STEP="leg 2 (part A)"
MARK_A="$(ad_shim_mark)"
start_second_tmux_server > /dev/null
EMPTY_TMPDIR="${SCENARIO_ROOT}/tmux-empty"
mkdir -m 700 "${EMPTY_TMPDIR}" || fail "${STEP}: could not create ${EMPTY_TMPDIR}"

# The human's run with TMUX_TMPDIR set to an empty directory, for this call only.
mark="$(ad_shim_mark)"
TMUX_TMPDIR="${EMPTY_TMPDIR}" ad_capture find-missing
harness_find_missing "${STEP}: TMUX_TMPDIR=${EMPTY_TMPDIR}" "${mark}"
[[ "${TMUX_TMPDIR}" == "${SCENARIO_ROOT}/tmux" ]] || fail "${STEP}: TMUX_TMPDIR outlived the call: ${TMUX_TMPDIR}"

# The human's run with TMUX pointing at the second tmux server, for this call only.
mark="$(ad_shim_mark)"
TMUX="${SECOND_TMUX}" ad_capture find-missing
harness_find_missing "${STEP}: TMUX=${SECOND_TMUX}" "${mark}"
[[ -z "${TMUX:-}" ]] || fail "${STEP}: TMUX outlived the call: ${TMUX}"

expect_status "${STEP}: after both runs" waiting
expect_worker_runs "${STEP}: after both runs"

echo "${TEST_NAME}: ${STEP}: holding $(( RECHECK_S + HOLD_EXTRA_S ))s (one re-check interval and ${HOLD_EXTRA_S}s)"
sleep "$(( RECHECK_S + HOLD_EXTRA_S ))"
for verb in resume spawn kill read-pane send-keys; do
    n="$(cscb_ad_count_between "${MARK_A}" - "${verb}" "--instance-id ${INSTANCE_ID}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) for ${INSTANCE_ID} after part A"
done
n="$(cscb_ad_count_between "${MARK_A}" - find-missing)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} find-missing call(s) after part A"
n="$(post_count 0)"
[[ "${n}" == 0 ]] || fail "${STEP}: the Slack record holds ${n} post(s) for ${PERSONA_NAME}"
for head in "${LATCH_HEAD}" "${RELATCH_HEAD}"; do
    n="$(count_log "${head}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} line(s) '${head}' for ${PERSONA_KEY}"
done
expect_status "${STEP}: after the hold" waiting
expect_worker_runs "${STEP}: after the hold"

# ---------------------------------------------------------------------------
# Leg 3: part B, the store statement, the restart and the own-id latch
# ---------------------------------------------------------------------------

STEP="leg 3 (part B: latch)"
POSTS_B="$(slack_record_mark "${RECORD}")"
created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${SESSION_NAME}:" '#{session_created}')" \
    || fail "${STEP}: no session ${SESSION_NAME} on the scenario's tmux server"
wait_s=$(( created + BOUND_S + AGE_MARGIN_S - $(date +%s) ))
if (( wait_s > 0 )); then
    echo "${TEST_NAME}: ${STEP}: waiting ${wait_s}s until session ${SESSION_NAME} is more than ${BOUND_S}s old"
    sleep "${wait_s}"
fi

# The human's one store statement (the harness's only sqlite3 write here).
ENDED_AT="$(ad_store_mark_finished "${INSTANCE_ID}" missing)"
ad_capture status --instance-id "${INSTANCE_ID}"
if (( AD_RC != 0 )) || ! jq -e '.state == "missing" and (has("launch_started_at") | not)' "${AD_OUT}" > /dev/null; then
    fail "${STEP}: after the statement the harness status read answered $(tr '\n' ' ' < "${AD_OUT}") (exit ${AD_RC})"
fi
expect_worker_runs "${STEP}: after the statement"
echo "${TEST_NAME}: ${STEP}: row marked missing, ended_at ${ENDED_AT}"

# The bot server restarted without teardown (ruling S4).
OLD_SERVER_PID="${SERVER_PID}"
LOG_B="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
stop_server
expect_worker_runs "${STEP}: after the plain stop"
start_server --live
[[ "${SERVER_PID}" != "${OLD_SERVER_PID}" ]] || fail "${STEP}: the restart kept bot server ${SERVER_PID}"
wait_for_log "${LATCH_OWN_ID}" "${LATCH_WAIT_S}" "${STEP}: ${PERSONA_KEY} never latched on '${OWN_ID_PHRASE}'"

# The new bot server's resume met the own-id CONFLICT; any still-stopping or
# still-starting UNAVAILABLE came first.
out="$(cscb_ad_calls resume "--instance-id ${INSTANCE_ID}")"
lines=()
[[ -z "${out}" ]] || mapfile -t lines <<< "${out}"
n=0
for line in ${lines[@]+"${lines[@]}"}; do
    [[ "$(cut -f4 <<< "${line}")" == "${SERVER_PID}" ]] && n=$(( n + 1 ))
done
(( n >= 1 )) || fail "${STEP}: the new bot server ${SERVER_PID} made no resume for ${INSTANCE_ID}"
conflict_line="$(first_log_line "${OWN_ID_PHRASE}")"
(( conflict_line > LOG_B )) || fail "${STEP}: '${OWN_ID_PHRASE}' first shows at server.log line ${conflict_line}, before the restart (line ${LOG_B})"
for phrase in "${STOPPING_PHRASE}" "${STARTING_PHRASE}"; do
    last="$(last_log_line "${phrase}")"
    if [[ -n "${last}" ]]; then
        (( last < conflict_line )) \
            || fail "${STEP}: an UNAVAILABLE line carrying '${phrase}' (line ${last}) comes after the CONFLICT (line ${conflict_line})"
        phrase_n="$(count_log "${phrase}")"
        echo "${TEST_NAME}: ${STEP}: UNAVAILABLE '${phrase}' ${phrase_n} time(s) before the CONFLICT"
    fi
done
echo "${TEST_NAME}: ${STEP}: ${n} resume(s) by the new bot server before the latch"

# One latch post, with the CONFLICT notice's CSCB-authored parts and no
# session-ending command.
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_NAME} after the latch" posts_at_least "${POSTS_B}" 1
sleep "${SETTLE_S}"
n="$(post_count "${POSTS_B}")"
[[ "${n}" == 1 ]] || fail "${STEP}: ${n} posts for ${PERSONA_NAME} after the latch, not 1"
LATCH_POST="$(post_text "${POSTS_B}" 1)"
LATCH_POST="${LATCH_POST%x}"
# The session name between double quotes (src/conflict-latch.ts slackQuotedSession).
expect_in_order "${STEP}: the latch post" "${LATCH_POST}" \
    "${NOTICE_HEAD}\"${SESSION_NAME}\"" "${OWN_ID_SENTENCE}" "${NOTICE_POINTER}" "${NOTICE_HUMAN_ONLY}"
[[ "${LATCH_POST}" == "${NOTICE_HEAD}"* ]] || fail "${STEP}: the latch post does not open with the persona prefix and the notice's head"
forms="$(printf '%s' "${LATCH_POST}" | bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sessionEndingCommandsIn)" \
    || fail "${STEP}: fmk-texts could not read the latch post"
[[ -z "${forms}" ]] || fail "${STEP}: the latch post's own lines name a session-ending command: ${forms//$'\n'/, }"

# ---------------------------------------------------------------------------
# Leg 4: the held latch, two re-checks of one status and one one-line read-pane
# ---------------------------------------------------------------------------

STEP="leg 4 (held latch)"
mark="$(ad_shim_mark)"
MARK_LATCH="${mark}"
for (( round = 1; round <= HELD_RECHECKS; round++ )); do
    wait_until "$(( RECHECK_S + RECHECK_ALLOWANCE_S ))" "${STEP}: re-check ${round} made no read-pane" \
        shim_line_after "${mark}" read-pane
    sleep "${SETTLE_S}"
    next="$(ad_shim_mark)"
    window_calls "${STEP}: re-check ${round}" "${mark}" "${next}"
    expect_window "${STEP}: re-check ${round}" status read-pane
    wait_for_count "${ROUND_HELD}" "${round}" "${SETTLE_S}" "${STEP}: re-check ${round} logged no held probe"
    n="$(post_count "${POSTS_B}")"
    [[ "${n}" == 1 ]] || fail "${STEP}: re-check ${round}: ${n} posts for ${PERSONA_NAME} since part B, not 1"
    expect_worker_runs "${STEP}: re-check ${round}"
    row_reads missing || fail "${STEP}: re-check ${round}: the row no longer reads missing"
    echo "${TEST_NAME}: ${STEP}: re-check ${round} held (status, read-pane --n-lines ${PROBE_LINES})"
    mark="${next}"
done
MARK_HELD="${mark}"

# ---------------------------------------------------------------------------
# Leg 5: the human's finished-row kill
# ---------------------------------------------------------------------------

STEP="leg 5 (finished-row kill)"
# The whole row, before and after (one-element JSON arrays).
before="$(ad_store_row "${INSTANCE_ID}")"
ad_kill_include_finished "${INSTANCE_ID}" > /dev/null
jq -e '.kill_sent == true' "${AD_KILL_OUT}" > /dev/null \
    || fail "${STEP}: the kill answered $(tr '\n' ' ' < "${AD_KILL_OUT}"), not kill_sent true"
wait_until "${KILL_END_WAIT_S}" "${STEP}: session ${SESSION_NAME} outlived the kill" no_session "${SESSION_NAME}"
wait_until "${KILL_END_WAIT_S}" "${STEP}: the worker outlived the kill" worker_gone
after="$(ad_store_row "${INSTANCE_ID}")"
# Every column keeps its value (an empty object: no column may change); a
# failure names each changed column with its value before and after.
_scenario_row_diff_check "${STEP}: the row is unchanged by the kill" "${before}" "${after}" '{}'
answer="$(jq -c '.' "${AD_KILL_OUT}")"
echo "${TEST_NAME}: ${STEP}: kill-finished answered ${answer}"

# ---------------------------------------------------------------------------
# Leg 6: the cleared probe, fresh provenance get and resume, one recovery post
# ---------------------------------------------------------------------------

STEP="leg 6 (cleared probe)"
wait_until "$(( RECHECK_S + RECHECK_ALLOWANCE_S ))" "${STEP}: no resume after the kill" \
    shim_line_after "${MARK_HELD}" resume
window_calls "${STEP}" "${MARK_HELD}" -
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == resume ]]; then
        WIN_VERBS=("${WIN_VERBS[@]:0:i+1}")
        WIN_ARGS=("${WIN_ARGS[@]:0:i+1}")
        WIN_PPIDS=("${WIN_PPIDS[@]:0:i+1}")
        break
    fi
done
expect_window "${STEP}: from the second re-check to its resume" status read-pane find-missing get resume
wait_for_log "${ROUND_CLEARED}" "${POST_WAIT_S}" "${STEP}: the round logged no probe cleared on ${READ_GONE}"
wait_until "${REPORT_WAIT_S}" "${STEP}: the resumed row never reported in (waiting)" row_reads waiting
expect_status "${STEP}" waiting
wait_until "${POST_WAIT_S}" "${STEP}: no recovery post" posts_at_least "${POSTS_B}" 2
sleep "${SETTLE_S}"
n="$(post_count "${POSTS_B}")"
[[ "${n}" == 2 ]] || fail "${STEP}: ${n} posts for ${PERSONA_NAME} in part B, not 2"
got="$(post_text "${POSTS_B}" 2)"
got="${got%x}"
[[ "${got}" == "${RECOVERY_POST}" ]] \
    || fail "${STEP}: the recovery post reads '${got}', not '${RECOVERY_POST}'"
# One find-missing and one resume over the whole window from the second
# re-check on, not only up to the first resume.
n="$(cscb_ad_count_between "${MARK_HELD}" - resume "--instance-id ${INSTANCE_ID}")"
[[ "${n}" == 1 ]] || fail "${STEP}: CSCB made ${n} resume call(s) of ${INSTANCE_ID} since the second re-check, not 1"
n="$(cscb_ad_count_between "${MARK_HELD}" - find-missing)"
[[ "${n}" == 1 ]] || fail "${STEP}: CSCB made ${n} find-missing call(s) since the second re-check, not 1"

# ---------------------------------------------------------------------------
# Leg 7: close
# ---------------------------------------------------------------------------

STEP="leg 7 (close)"
mapfile -t lines < "${SCENARIO_AD_SHIM_LOG}"
kills=0
for line in "${lines[@]}"; do
    _scenario_split_line "${line}" && [[ "${_L_KIND}" == call ]] || continue
    _scenario_decode_words || fail "${STEP}: a shim log line does not parse: ${line}"
    _scenario_finished_kill_words || continue
    kills=$(( kills + 1 ))
    [[ "${_L_PPID}" == "$$" && "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] \
        || fail "${STEP}: a finished-row kill's parent is ${_L_PPID}, not the scenario's shell $$: ${line}"
done
(( kills == 1 )) || fail "${STEP}: the shim's log holds ${kills} finished-row kill(s), not the harness's one"
n="$(cscb_ad_count kill)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} kill call(s)"
n="$(cscb_ad_count_between "${MARK_LATCH}" - spawn)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} spawn call(s) from the latch on"

stop_server --stop-bots
stop_tracked_pid "${SLACK_STUB_PID}" 10 "${STEP}: the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
