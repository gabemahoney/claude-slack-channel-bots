#!/usr/bin/env bash
# Verify exact persona/session targeting, prefix neighbours, resume and restart.
# SessionStart reports readiness; CSCB never answers startup UI.

set -euo pipefail

TEST_NAME="test-15-fmk-prefix-neighbour"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona dev and its channel; the control channel of step 0.
DEV_NAME="dev"
DEV_KEY="$(persona_key "${DEV_NAME}")"
DEV_REF="$(persona_ref "${DEV_NAME}")"
DEV_CHANNEL="C0T15DEV1"
CONTROL_CHANNEL="C0T15CTL1"
TOKEN_LABEL="t15dev"

# The neighbour's instance id: outside CSCB's namespace.
NB_ID="${SCENARIO_TAG}_neighbour"

# Bounds (seconds; see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
CONNECT_WAIT_S=30
NB_WAIT_S=10
RECONNECT_WAIT_S=60

FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# The start pass's completion line for one persona.
COMPLETED="$(completion_match 1)" || exit 1

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
}

# common_prefix <a> <b>: print the longest common start of <a> and <b>.
common_prefix() {
    local a="$1" b="$2" i=0
    while (( i < ${#a} && i < ${#b} )) && [[ "${a:i:1}" == "${b:i:1}" ]]; do
        i=$(( i + 1 ))
    done
    printf '%s' "${a:0:i}"
}

# rows_count <text>: print how many lines <text> holds (0 when empty).
rows_count() {
    if [[ -z "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l <<< "$1" | tr -d ' '
}

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair ending in <suffix> and refusing any other;
# wait for its ready file; export CSCB_SLACK_API_URL; set SLACK_STUB_PID and
# SCENARIO_SLACK_RECORD (slack_posts' default record).
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

# read_row <step> <instance-id>: a harness `get` of the row. Sets ROW_STATE,
# ROW_SID (session_id), ROW_SESSION (tmux_session_name) and
# ROW_LABELS (the labels as JSON), each empty when absent.
read_row() {
    local fields
    ad_capture get --instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .session_id // "", .tmux_session_name // "", (.labels // null | tojson)] | join("\u001f")' "${AD_OUT}")" \
        || fail "$1: the harness get of $2 printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_SESSION ROW_LABELS <<< "${fields}"
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

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# session_parts <step> <name>: set PART_SID, PART_WID, PART_PANE and
# PART_PID to the session id, its window id, its pane id and the pane's
# process, read with the real tmux.
session_parts() {
    local out
    out="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=$2:" '#{session_id} #{window_id} #{pane_id} #{pane_pid}' 2> /dev/null)" \
        || fail "$1: no session $2 on the scenario's tmux server"
    read -r PART_SID PART_WID PART_PANE PART_PID <<< "${out}"
    [[ "${PART_SID}" =~ ^\$[0-9]+$ && "${PART_WID}" =~ ^@[0-9]+$ && "${PART_PANE}" =~ ^%[0-9]+$ && "${PART_PID}" =~ ^[0-9]+$ ]] \
        || fail "$1: tmux gave '${out}' for session $2"
}

# True when <pid> runs the scenario's stub `claude`.
stub_running() {
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/$1/cmdline" 2> /dev/null
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

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

DEV_ID="$(fmk_text personaInstanceId "${DEV_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId"
ID_NAMESPACE="${DEV_ID%"${DEV_KEY}"}"
[[ -n "${ID_NAMESPACE}" && "${DEV_ID}" == "${ID_NAMESPACE}${DEV_KEY}" ]] \
    || fail "setup: ${DEV_KEY}'s instance id ${DEV_ID} does not end with its key"
[[ "${NB_ID}" != "${ID_NAMESPACE}"* ]] || fail "setup: the neighbour's id ${NB_ID} is inside CSCB's namespace ${ID_NAMESPACE}"

CASE_LEFTOVER="$(fmk_text LATCH_CASE_LEFTOVER)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_LEFTOVER"
CASE_OWN_ID="$(fmk_text LATCH_CASE_OWN_ID)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_OWN_ID"
CASE_NO_VALID_ID="$(fmk_text LATCH_CASE_NO_VALID_ID)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_NO_VALID_ID"
OP_RESUME="$(fmk_text REFUSED_OPERATION_RESUME)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_RESUME"
CONFLICT_HEAD="$(fmk_text CONFLICT_NOTICE_FIRST_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_FIRST_LINE_HEAD"
UNUSABLE_HEAD="$(fmk_text UNUSABLE_NAME_NOTICE_HEAD)" || fail "setup: fmk-texts.ts could not print UNUSABLE_NAME_NOTICE_HEAD"
LAUNCH_START_HEAD="$(fmk_text LAUNCH_START_NOTICE_HEAD)" || fail "setup: fmk-texts.ts could not print LAUNCH_START_NOTICE_HEAD"

# The latch lines' fragments for dev: what the set and the clear line share,
# and what two re-check round lines that differ only in the case share.
LINE_A="$(fmk_text conflictLatchSetLine "${DEV_KEY}" "${CASE_LEFTOVER}" "${NB_ID}" "${OP_RESUME}" ended)" \
    || fail "setup: fmk-texts.ts could not print conflictLatchSetLine"
LINE_B="$(fmk_text latchClearedLine "${DEV_KEY}" "${CASE_LEFTOVER}" "${NB_ID}" posted LATCH_RECOVERY_REASON_ROW_GONE)" \
    || fail "setup: fmk-texts.ts could not print latchClearedLine"
LATCH_HEAD="$(common_prefix "${LINE_A}" "${LINE_B}")"
[[ "${LATCH_HEAD}" == ?*"=${DEV_KEY} " ]] \
    || fail "setup: the latch set and clear lines share '${LATCH_HEAD}', which does not end with dev's key"
LINE_A="$(fmk_text latchRecheckRoundLine "${DEV_NAME}" "${CASE_LEFTOVER}" x x x)" \
    || fail "setup: fmk-texts.ts could not print latchRecheckRoundLine"
LINE_B="$(fmk_text latchRecheckRoundLine "${DEV_NAME}" "${CASE_OWN_ID}" x x x)" \
    || fail "setup: fmk-texts.ts could not print latchRecheckRoundLine"
RECHECK_HEAD="$(common_prefix "${LINE_A}" "${LINE_B}")"
[[ "${RECHECK_HEAD}" == *"${DEV_REF}"* ]] \
    || fail "setup: the re-check round lines share '${RECHECK_HEAD}', which does not name ${DEV_REF}"
echo "${TEST_NAME}: latch line fragments for ${DEV_KEY}: '${LATCH_HEAD}' and '${RECHECK_HEAD}'"

# ---------------------------------------------------------------------------
# Scenario 3
# ---------------------------------------------------------------------------

# Step 0 [harness]: slack_posts' positive control, on the control channel.
step_posts_control() {
    local step="step 0: slack_posts control" desc notice prefix sep first dhead dtail pointer list human
    local expect body code posts=() file="${SCENARIO_ROOT}/control-posts.bin"
    desc="$(fmk_text CONFLICT_NO_VALID_ID_PHRASE)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NO_VALID_ID_PHRASE"
    notice="$(fmk_text formatPersonaNotice "${DEV_NAME}" conflictNoticeText "${CASE_NO_VALID_ID}" "${DEV_ID}_x" "${desc}")" \
        || fail "${step}: fmk-texts.ts could not print the notice"
    prefix="$(fmk_text personaNoticePrefix "${DEV_NAME}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    sep="$(fmk_text CONFLICT_NOTICE_LINE_SEPARATOR && printf x)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NOTICE_LINE_SEPARATOR"
    sep="${sep%x}"
    first="$(fmk_text conflictNoticeFirstLine "${CASE_NO_VALID_ID}" "${DEV_ID}_x")" || fail "${step}: fmk-texts.ts could not print conflictNoticeFirstLine"
    dhead="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD"
    dtail="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL"
    pointer="$(fmk_text CONFLICT_NOTICE_POINTER_LINE)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NOTICE_POINTER_LINE"
    list="$(fmk_text conflictNoticeListLine "${DEV_ID}_x")" || fail "${step}: fmk-texts.ts could not print conflictNoticeListLine"
    human="$(fmk_text CONFLICT_NOTICE_HUMAN_ONLY_LINE)" || fail "${step}: fmk-texts.ts could not print CONFLICT_NOTICE_HUMAN_ONLY_LINE"
    [[ -n "${sep}" && -n "${first}" && -n "${list}" && -n "${human}" ]] || fail "${step}: fmk-texts.ts printed an empty part"
    expect="${prefix}${first}${sep}${dhead}${desc}${dtail}${sep}${pointer}${sep}${list}${sep}${human}"
    if [[ "${notice}" != "${expect}" ]]; then
        printf '  | built:    %q\n  | composed: %q\n' "${notice}" "${expect}" >&2
        fail "${step}: the notice conflictNoticeText builds is not the one its per-line entries compose"
    fi
    body="$(jq -n --arg c "${CONTROL_CHANNEL}" --arg t "${notice}" '{channel: $c, text: $t}')"
    code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $(fake_token bot "${TOKEN_LABEL}")" -H 'Content-Type: application/json' \
        -d "${body}" "${CSCB_SLACK_API_URL}chat.postMessage" || true)"
    [[ "${code}" == 200 ]] || fail "${step}: the Slack stub answered ${code} to the control post"
    slack_posts "${CONTROL_CHANNEL}" > "${file}"
    mapfile -d '' -t posts < "${file}"
    (( ${#posts[@]} == 1 )) || fail "${step}: slack_posts found ${#posts[@]} post(s) on ${CONTROL_CHANNEL}, not the one control post"
    [[ "${posts[0]}" == "${notice}" ]] || fail "${step}: slack_posts did not return the control notice whole"
    [[ "${posts[0]}" == *"${sep}${human}" ]] || fail "${step}: the control notice slack_posts returned does not end with its human-only line"
    echo "${TEST_NAME}: ${step}: slack_posts returned the ${#notice}-character control notice whole"
}

# Steps 1 and 2: the configuration and the first life.
step_first_life() {
    local step="step 2: first life" creds work calls rows
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    work="$(make_workdir dev)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${TOKEN_LABEL}")" "$(fake_token app "${TOKEN_LABEL}")" \
        | write_file "${creds}/dev.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${DEV_NAME}",
      "credentials_file": "${creds}/dev.json",
      "working_directory": "${work}",
      "channels": [{ "id": "${DEV_CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${DEV_CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF
    CONNECTED="$(matcher "[slack] Session connected: persona ${DEV_REF}")"
    start_server --live
    LIFE1_PID="${SERVER_PID}"
    wait_for_count "${COMPLETED}" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_row "${step}: the report-in" "${REPORT_WAIT_S}" "${DEV_ID}" waiting
    DEV_SID="${ROW_SID}"
    DEV_SESSION="${ROW_SESSION}"
    [[ -n "${DEV_SID}" ]] || fail "${step}: the live row ${DEV_ID} has no session_id"
    [[ -n "${DEV_SESSION}" ]] || fail "${step}: the live row ${DEV_ID} names no tmux session"
    wait_for_count "${CONNECTED}" 1 "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as dev's"
    calls="$(ad_cscb_calls "${DEV_ID}")" || exit 1
    rows="$(verb_rows send-keys "${calls}")"
    rows="$(server_rows "${LIFE1_PID}" "${rows}")"
    (( $(rows_count "${rows}") == 0 )) || fail "${step}: automatic startup keys reached ${DEV_ID}"
    echo "${TEST_NAME}: ${step}: ${DEV_ID} reads waiting, session_id ${DEV_SID}, session ${DEV_SESSION}"
}

# Step 3: stop --stop-bots ends dev's first life.
step_stop_bots() {
    local step="step 3: stop --stop-bots"
    stop_server --stop-bots
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    ! has_session "${DEV_SESSION}" || fail "${step}: session ${DEV_SESSION} is still there"
    row_reads "${step}" "${DEV_ID}" ended missing waiting \
        || fail "${step}: ${DEV_ID} reads '${ROW_STATE}', not ended, missing or waiting"
    [[ "${ROW_SID}" == "${DEV_SID}" ]] || fail "${step}: the row's session_id is '${ROW_SID}', not ${DEV_SID}"
    echo "${TEST_NAME}: ${step}: ${DEV_ID} reads ${ROW_STATE}; ${DEV_SESSION} is gone"
}

# Step 4 [harness]: the neighbour, made by hand with the server stopped.
step_make_neighbour() {
    local step="step 4: the neighbour" dir
    NB_SESSION="${DEV_SESSION}_x"
    dir="$(make_workdir neighbour)"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    TMUX_MARK="$(tmux_shim_mark)"
    ad_capture spawn --agent claude --cwd "${dir}" --instance-id "${NB_ID}" --tmux-session-name "${NB_SESSION}" --no-pre-trust
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: the harness spawn of ${NB_ID} exited ${AD_RC}"
    fi
    session_parts "${step}" "${NB_SESSION}"
    NB_SID="${PART_SID}"
    NB_WID="${PART_WID}"
    NB_PANE="${PART_PANE}"
    NB_PID="${PART_PID}"
    wait_until "${NB_WAIT_S}" "${step}: the neighbour's pane process ${NB_PID} never became the stub" stub_running "${NB_PID}"
    read_row "${step}" "${NB_ID}"
    [[ "${ROW_STATE}" == pending ]] || fail "${step}: ${NB_ID} reads '${ROW_STATE}', not pending"
    [[ "${ROW_SESSION}" == "${NB_SESSION}" ]] || fail "${step}: ${NB_ID} records session '${ROW_SESSION}', not ${NB_SESSION}"
    [[ "$(jq -n --argjson l "${ROW_LABELS:-null}" '$l // [] | length')" == 0 ]] \
        || fail "${step}: ${NB_ID} carries labels ${ROW_LABELS}"
    echo "${TEST_NAME}: ${step}: ${NB_ID} reads pending in ${NB_SESSION} (${NB_SID}, window ${NB_WID}, pane ${NB_PANE}, stub ${NB_PID}); tmux shim mark ${TMUX_MARK}"
}

# Step 5: the second life resumes dev beside the neighbour.
step_second_life() {
    local step="step 5: second life" mark completions connections rows resumes resume_pos n
    mark="$(ad_shim_mark)"
    LIFE2_MARK="${mark}"
    completions="$(count_log "${COMPLETED}")"
    connections="$(count_log "${CONNECTED}")"
    start_server --live
    LIFE2_PID="${SERVER_PID}"
    wait_for_count "${COMPLETED}" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_row "${step}: the resume's report-in" "${REPORT_WAIT_S}" "${DEV_ID}" waiting
    [[ "${ROW_SID}" == "${DEV_SID}" ]] || fail "${step}: the resumed row's session_id is '${ROW_SID}', not ${DEV_SID}"
    [[ "${ROW_SESSION}" == "${DEV_SESSION}" ]] || fail "${step}: the resumed row records session '${ROW_SESSION}', not ${DEV_SESSION}"
    wait_for_count "${CONNECTED}" "$(( connections + 1 ))" "${CONNECT_WAIT_S}" "${step}: the server never registered the resumed stub's session as dev's"
    rows="$(ad_cscb_calls "${DEV_ID}" "${mark}")" || exit 1
    echo "${TEST_NAME}: ${step}: CSCB calls of ${DEV_ID} (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    resumes="$(verb_rows resume "${rows}")"
    n="$(rows_count "${resumes}")"
    (( n == 1 )) || fail "${step}: ${n} resume call(s) of ${DEV_ID} by CSCB, not one"
    [[ -n "$(server_rows "${LIFE2_PID}" "${resumes}")" ]] \
        || fail "${step}: the resume of ${DEV_ID} is not the bot server's"
    resume_pos="$(field_of 1 "${resumes}")"
    rows="$(ad_cscb_calls "${DEV_ID}" "${resume_pos}")" || exit 1
    rows="$(server_rows "${LIFE2_PID}" "${rows}")"
    for verb in read-pane send-keys; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} bot-server ${verb} call(s) after resume; startup needs no automatic answer"
    done
    session_parts "${step}" "${DEV_SESSION}"
    DEV_SID2="${PART_SID}"
    DEV_WID2="${PART_WID}"
    DEV_PANE2="${PART_PANE}"
    echo "${TEST_NAME}: ${step}: ${DEV_ID} resumed with session_id ${ROW_SID} in ${DEV_SESSION} (${DEV_SID2}, window ${DEV_WID2}, pane ${DEV_PANE2})"
}

# Step 6: the restart leg, then stop --stop-bots.
step_restart() {
    local step="step 6: restart" mark completions connections keys calls rows n verb
    stop_server
    has_session "${DEV_SESSION}" || fail "${step}: a plain stop ended ${DEV_SESSION}"
    read_row "${step}" "${DEV_ID}"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: after a plain stop ${DEV_ID} reads ${ROW_STATE}, not waiting"
    mark="$(ad_shim_mark)"
    RESTART_MARK="${mark}"
    completions="$(count_log "${COMPLETED}")"
    connections="$(count_log "${CONNECTED}")"
    calls="$(ad_cscb_calls "${DEV_ID}")" || exit 1
    keys="$(rows_count "$(verb_rows send-keys "${calls}")")"
    start_server --live
    LIFE3_PID="${SERVER_PID}"
    wait_for_count "${COMPLETED}" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_for_ad_cscb_call "${DEV_ID}" send-keys "$(( keys + 1 ))" "${RECONNECT_WAIT_S}" \
        "${step}: no reconnect send-keys of ${DEV_ID} after the restart"
    wait_for_count "${CONNECTED}" "$(( connections + 1 ))" "${CONNECT_WAIT_S}" "${step}: the server never registered dev's session again"
    rows="$(ad_cscb_calls "${DEV_ID}" "${mark}")" || exit 1
    echo "${TEST_NAME}: ${step}: CSCB calls of ${DEV_ID} (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    [[ -n "$(server_rows "${LIFE3_PID}" "$(verb_rows send-keys "${rows}")")" ]] \
        || fail "${step}: the reconnect send-keys of ${DEV_ID} is not the bot server's"
    for verb in resume kill; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} ${verb} call(s) of ${DEV_ID} by CSCB in the restart leg"
    done
    read_row "${step}" "${DEV_ID}"
    [[ "${ROW_STATE}" == waiting && "${ROW_SID}" == "${DEV_SID}" ]] \
        || fail "${step}: after the restart ${DEV_ID} reads ${ROW_STATE} (${ROW_SID}), not waiting with ${DEV_SID}"
    echo "${TEST_NAME}: ${step}: ${DEV_ID} reconnected, still waiting with session_id ${ROW_SID}"
    stop_server --stop-bots
}

# Step 7: the checks.
step_checks() {
    local step="step 7: checks" rows ids n target found control="" posts=() post file="${SCENARIO_ROOT}/dev-posts.bin"
    local events completed

    # CSCB's agent-director calls name dev's id only. Each reader's output is
    # saved by its own assignment, so a reader that fails stops the script.
    rows="$(ad_cscb_calls '*')" || exit 1
    (( $(rows_count "${rows}") > 0 )) || fail "${step}: positive control: no CSCB call carries an instance id"
    ids="$(field_of 5 "${rows}" | sort -u | tr '\n' ' ')"
    [[ "${ids}" == "${DEV_ID} " ]] || fail "${step}: CSCB calls carry the instance ids '${ids% }', not only ${DEV_ID}"
    n="$(cscb_ad_count "" "${DEV_ID}")" || exit 1
    (( n > 0 )) || fail "${step}: positive control: no CSCB call's arguments hold ${DEV_ID}"
    for target in "${NB_ID}" "${NB_SESSION}"; do
        n="$(cscb_ad_count "" "${target}")" || exit 1
        (( n == 0 )) || { cscb_ad_calls "" "${target}" | sed 's/^/  | /' >&2; fail "${step}: ${n} CSCB call(s) name ${target}"; }
    done
    echo "${TEST_NAME}: ${step}: $(rows_count "${rows}") CSCB call(s) carry an instance id, every one ${DEV_ID}"

    # The id-less reader: each start's sweep lists the store, between the marks.
    found="$(ad_cscb_verb_between list "${LIFE2_MARK}" "${RESTART_MARK}")" || exit 1
    (( $(rows_count "${found}") >= 1 )) || fail "${step}: positive control: no CSCB list call in the second life"
    found="$(ad_cscb_verb_between list "${RESTART_MARK}" -)" || exit 1
    (( $(rows_count "${found}") >= 1 )) || fail "${step}: positive control: no CSCB list call in the restart leg"

    # The trail: dev's worker reported in; the neighbour's never did.
    events="$(ad_trail_events ad.hook.fired "${DEV_ID}")" || exit 1
    (( $(rows_count "${events}") >= 1 )) || fail "${step}: positive control: the trail holds no ad.hook.fired record for ${DEV_ID}"
    events="$(ad_trail_events ad.hook.fired "${NB_ID}")" || exit 1
    n="$(rows_count "${events}")"
    (( n == 0 )) || fail "${step}: the trail holds ${n} ad.hook.fired record(s) for the neighbour ${NB_ID}"

    # No tmux command CSCB caused reads from, types into, kills or respawns
    # the neighbour, by its session name, session id, window id or pane id.
    for target in "${NB_SESSION}" "${NB_SID}" "${NB_WID}" "${NB_PANE}"; do
        found="$(tmux_shim_targets "${target}" "${TMUX_MARK}")" || exit 1
        [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on the neighbour's ${target}"; }
    done
    for target in "${DEV_SESSION}" "${DEV_SID2}" "${DEV_WID2}" "${DEV_PANE2}"; do
        found="$(tmux_shim_targets "${target}" "${TMUX_MARK}")" || exit 1
        [[ -z "${found}" ]] || control+="${target}: $(field_of 4 "${found}" | sort | uniq -c | tr -s ' \n' ' ')"
    done
    [[ -n "${control}" ]] || fail "${step}: positive control: tmux_shim_targets found no command acting on dev's ${DEV_SESSION}, ${DEV_SID2}, ${DEV_WID2} or ${DEV_PANE2}"
    echo "${TEST_NAME}: ${step}: tmux commands acting on dev from the neighbour's creation on: ${control}"

    # The neighbour is untouched: pending, the same session, pane and stub.
    read_row "${step}" "${NB_ID}"
    [[ "${ROW_STATE}" == pending ]] || fail "${step}: the neighbour ${NB_ID} reads '${ROW_STATE}', not pending"
    session_parts "${step}" "${NB_SESSION}"
    [[ "${PART_SID} ${PART_WID} ${PART_PANE} ${PART_PID}" == "${NB_SID} ${NB_WID} ${NB_PANE} ${NB_PID}" ]] \
        || fail "${step}: the neighbour's session reads ${PART_SID} ${PART_WID} ${PART_PANE} ${PART_PID}, not ${NB_SID} ${NB_WID} ${NB_PANE} ${NB_PID}"
    stub_running "${NB_PID}" || fail "${step}: the neighbour's stub ${NB_PID} no longer runs"

    # No latch notice on dev's channel, no latch line for dev.
    slack_posts "${DEV_CHANNEL}" > "${file}"
    mapfile -d '' -t posts < "${file}"
    for post in ${posts[@]+"${posts[@]}"}; do
        if [[ "${post}" == *"${CONFLICT_HEAD}"* || "${post}" == *"${UNUSABLE_HEAD}"* || "${post}" == *"${LAUNCH_START_HEAD}"* ]]; then
            printf '  | %q\n' "${post}" >&2
            fail "${step}: dev's channel ${DEV_CHANNEL} holds a latch notice"
        fi
    done
    echo "${TEST_NAME}: ${step}: ${#posts[@]} post(s) on ${DEV_CHANNEL}, none a latch notice"
    expect_count "${LATCH_HEAD}" 0 "${step}: latch set or clear lines for dev"
    expect_count "${RECHECK_HEAD}" 0 "${step}: latch re-check lines for dev"
    completed="$(count_log "${COMPLETED}")"
    (( completed == 3 )) || fail "${step}: positive control: server.log holds ${completed} start completion line(s), not 3"

    # dev's row is present at the end.
    read_row "${step}" "${DEV_ID}"
    [[ -n "${ROW_STATE}" && "${ROW_SID}" == "${DEV_SID}" ]] \
        || fail "${step}: ${DEV_ID} reads '${ROW_STATE}' (${ROW_SID}) at the end"
    echo "${TEST_NAME}: ${step}: ${DEV_ID} is present at the end, reading ${ROW_STATE}"
}

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${TOKEN_LABEL}"
step_posts_control
step_first_life
step_stop_bots
step_make_neighbour
step_second_life
step_restart
step_checks
stop_tracked_pid "${SLACK_STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
