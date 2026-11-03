#!/usr/bin/env bash
# Scenario: per-persona `model` and `effort` (b.fx2 SR-8.5), in fmk mode: real
# agent-director launches of the stub Claude, on the scenario's own HOME,
# agent-director install and store, tmux server and shims.
#
# Personas, on one live server against the Slack stub, each with its own fake
# credentials, channel and working directory, its instance id from the
# printer, `claude_config_dir` the scenario HOME's `.claude` (where
# the stub writes every transcript), and the stub mode `exit-on-pause` (it
# reports in at once, writes its transcript at SessionStart so the
# conversation can be resumed, and ends on `pause`'s `/exit` as Claude Code
# does, so a teardown's pause never escalates to a kill):
#   P2  `model` and `effort`. The model value is `--settings=<tag>-no-such-model`:
#       it starts with `-`, is no model Claude Code knows, and is shaped like a
#       start option agent-director refuses, so a value split from `--model`
#       would be refused (or seen whole as its own element) rather than pass.
#       Its effort is the last of EFFORT_LEVELS.
#   P1  `effort` only, the first of EFFORT_LEVELS.
#   P0  neither.
#
# Legs, in order:
#   Fresh launch: a live start. Each row reads `waiting`, and its one launch
#     record (the stub's stub-claude-launches.jsonl, selected by the
#     persona's resolved working directory) carries P2: exactly one element
#     equal to MODEL_ARG_PREFIX<model> and exactly one equal to
#     EFFORT_ARG_PREFIX<effort>; P1: only the effort element; P0: no element
#     starting with `--model` or `--effort`. For every persona: as many
#     elements start with `--model` (`--effort`) as the persona sets the key
#     (0 or 1), none equals bare `--model` or `--effort`, none equals either
#     of P2's model values alone, and none starts with `--resume`. Each row's
#     session_id, and P2's jsonl_path, come from a harness `get`.
#   (a) The instance dies: `end_worker_without_session_end` SIGKILLs every
#     worker's process (the pane its store row records, read with
#     `ad_store_row`: a harness `get` carries no pane id), so no
#     SessionEnd fires and the row still reads live with its process gone;
#     the session's disconnect schedules the server's ordinary restart, which
#     relaunches it after session_restart_delay.
#   (b) `clean_restart <P2> <P1> <P0>`: exit 0, each bot's
#     cleanRestartRelaunchedLine printed once.
#   (c) `stop --stop-bots`, then a live `start` of the same config.
#   After each of (a), (b) and (c), every persona has exactly one more launch
#     record, carrying exactly its elements as at the fresh launch and
#     `--resume` followed by its recorded session_id; its row reads `waiting`
#     with that session_id; its MCP session registers again; and no
#     Fresh-Start Line (any of its three key forms) names any persona after
#     the leg's mark.
#   Confirmed change: on the running server config.json changes P2's model to
#     `--settings=<tag>-another-model` and its effort to the first level; the
#     pending file the reload tick writes is renamed to the apply file, and
#     the apply logs reloadAppliedLogLine 0 0 0 1 0 0 <config.json> (one
#     in-place persona: a Next-Launch Setting). From the apply, for HOLD_S,
#     P2's row reads `waiting` with its old session_id and no persona gets a
#     launch record; then no CSCB `pause`, `kill`, `spawn` or `resume` names
#     P2's id after the change's mark.
#   Next Launch: `clean_restart <P2>`: exit 0 with P2's relaunched line. P2
#     has exactly one new launch record, with no element starting with
#     `--resume` and the new elements; its row reads `waiting` with a
#     session_id other than the old one. After the change's mark: exactly one
#     server.log line is `] ` + freshStartLine(<P2 ref>, model, effort), and
#     none is any other key form for P2 or any form for P0 or P1;
#     startup-errors.log gains no line; the Slack stub records no
#     chat.postMessage for any persona's token; P2's old transcript (its
#     jsonl_path before the change) still exists; P0 and P1 keep their
#     session_ids, get no launch record, and no CSCB pause, kill, spawn or
#     resume names them.
#   Close: `stop --stop-bots` (each worker ends on its pause's `/exit`), every
#     persona's launch count still the expected one, then the three closing
#     assertions.
#
# `clean_restart --server` is not driven as its own leg: src/cli.ts's server
# form runs `stop`, then the same `teardownBots` as `stop --stop-bots`, then
# `start`, so leg (c) exercises the same teardown, server start and
# bring-up. test-21 and test-13 drive the command itself.
#
# Timing (seconds): `health_check_interval` 0, so no health tick launches
# anything; `session_restart_delay` RESTART_DELAY_S (CLEAN_EXIT_RELAUNCH_DELAY
# + 10). A worker's death with no SessionEnd (leg a) relaunches it after the
# full delay. A worker's clean exit (leg b's pause) relaunches it after
# CLEAN_EXIT_RELAUNCH_DELAY, or, within that delay of its last clean-exit
# relaunch (the loop guard), after the full delay; either way one launch per
# exit, which the exact launch counts after every leg (and at the close)
# hold. Unlike test-21's
# named-restart leg, which tells the clean-exit relaunch from the ordinary
# restart by the gap, this scenario checks what each relaunch launched, not
# which timer launched it; each leg waits for its launches before the next
# begins, so no leg's relaunch can land in another's.
#
# Bounds (seconds): START_WAIT_S 120 for a start pass; ROW_WAIT_S 120 for a
# launched row reporting in; RELAUNCH_WAIT_S (RESTART_DELAY_S + ROW_WAIT_S)
# for a relaunch's launch record; CONNECT_WAIT_S 30 for an MCP session
# registering; RELOAD_WAIT_S 60 for the pending file; APPLY_WAIT_S 120 for the
# apply's line; STUB_WAIT_S 30 for the Slack stub; HOLD_S 10 for the hold
# after the apply. `clean_restart <bot>…` waits cleanRestartRelaunchWaitMs of
# RESTART_DELAY_S itself.
#
# Every CSCB value matched comes from fixtures/fmk-texts.ts on the installed
# package: MODEL_ARG_PREFIX and EFFORT_ARG_PREFIX
# (src/agent-director-template.ts), EFFORT_LEVELS (src/config.ts),
# freshStartLine (src/live-row-sequence.ts), personaInstanceId,
# PENDING_FILE_SUFFIX, APPLY_FILE_SUFFIX, reloadAppliedLogLine,
# CLEAN_EXIT_RELAUNCH_DELAY, cleanRestartRelaunchWaitMs and
# cleanRestartRelaunchedLine. The bare `--model` and `--effort` option names
# are those prefixes without their trailing `=`. The persona reference and
# the start pass's completion line come from lib/scenario.sh (`persona_ref`,
# `completion_match`). The session-connected text
# (`[slack] Session connected: persona <ref>`) is typed literally, as test-21
# types it: src/server.ts builds it inline and exports nothing a printer
# entry could print. Agent-director state is read through
# harness `get`/`status`, the shim log and (leg a's pane ids only) a
# read-only store read; no pane or transcript content is
# read (a transcript's existence is a file test).
set -euo pipefail

TEST_NAME="test-49-fmk-model-effort"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T49_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t49_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t49_value() {
    local var="$1" out
    shift
    out="$(bun "${T49_PRINTER}" "$@")" || fail "the value printer failed for $*"
    printf -v "${var}" '%s' "${out}"
}

# t49_whole <var> <entry> [<arg>...]: as t49_value, for a whole number.
t49_whole() {
    t49_value "$@"
    [[ "${!1}" =~ ^[1-9][0-9]*$ ]] || fail "setup: $2 '${!1}' is not a whole number"
}

t49_value MODEL_PREFIX MODEL_ARG_PREFIX
t49_value EFFORT_PREFIX EFFORT_ARG_PREFIX
t49_value LEVELS_LINE EFFORT_LEVELS
read -r -a LEVELS <<< "${LEVELS_LINE}"
(( ${#LEVELS[@]} >= 2 )) || fail "setup: EFFORT_LEVELS '${LEVELS_LINE}' holds fewer than two levels"
[[ "${MODEL_PREFIX}" == --?*= && "${EFFORT_PREFIX}" == --?*= ]] \
    || fail "setup: the argument prefixes '${MODEL_PREFIX}' and '${EFFORT_PREFIX}' are not both --<option>="
# The bare option names, from the printed prefixes.
MODEL_OPT="${MODEL_PREFIX%=}"
EFFORT_OPT="${EFFORT_PREFIX%=}"
t49_value PENDING_SUFFIX PENDING_FILE_SUFFIX
t49_value APPLY_SUFFIX APPLY_FILE_SUFFIX
t49_whole CLEAN_EXIT_DELAY_S CLEAN_EXIT_RELAUNCH_DELAY

# ---------------------------------------------------------------------------
# Bounds (seconds; see the header)
# ---------------------------------------------------------------------------

START_WAIT_S=120
ROW_WAIT_S=120
STUB_WAIT_S=30
CONNECT_WAIT_S=30
RELOAD_WAIT_S=60
APPLY_WAIT_S=120
HOLD_S=10
RESTART_DELAY_S=$(( CLEAN_EXIT_DELAY_S + 10 ))
RELAUNCH_WAIT_S=$(( RESTART_DELAY_S + ROW_WAIT_S ))
t49_whole CLEAN_WAIT_MS cleanRestartRelaunchWaitMs "${RESTART_DELAY_S}"

# ---------------------------------------------------------------------------
# Personas
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
T49_CFG="${HOME}/.claude"
mkdir -p "${T49_CFG}"
if [[ ! -e "${T49_CFG}/.claude.json" ]]; then
    printf '{}\n' | write_file "${T49_CFG}/.claude.json" 600
fi

# The stub's per-launch record (fixtures/stub-claude.sh), beside the stub.
LAUNCHES="${SCENARIO_BIN}/stub-claude-launches.jsonl"

# P2's two model values, built from the scenario tag.
P2_MODEL_ONE="--settings=${SCENARIO_TAG}-no-such-model"
P2_MODEL_TWO="--settings=${SCENARIO_TAG}-another-model"

t49_persona() {
    local p="$1" short="$2" channel="$3" key value work
    printf -v "${p}_NAME" '%s' "${SCENARIO_TAG}${short}"
    printf -v "${p}_LABEL" '%s' "${SCENARIO_TAG}${short}1"
    printf -v "${p}_CHANNEL" '%s' "${channel}"
    work="$(make_workdir "${SCENARIO_TAG}${short}_work")"
    stub_mode "${work}" "${STUB_MODE_EXIT_ON_PAUSE}"
    printf -v "${p}_WORK" '%s' "${work}"
    value="$(realpath -e -- "${work}")" || fail "setup: no real path for ${work}"
    printf -v "${p}_REAL" '%s' "${value}"
    key="$(persona_key "${SCENARIO_TAG}${short}")"
    printf -v "${p}_KEY" '%s' "${key}"
    t49_value value personaInstanceId "${key}"
    printf -v "${p}_ID" '%s' "${value}"
    value="$(persona_ref "${SCENARIO_TAG}${short}")" || exit 1
    printf -v "${p}_REF" '%s' "${value}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' \
        "$(fake_token bot "${SCENARIO_TAG}${short}1")" "$(fake_token app "${SCENARIO_TAG}${short}1")" \
        | write_file "${CREDS_DIR}/${SCENARIO_TAG}${short}1.json" 600
}

t49_persona P2 both C0T49BTH1
t49_persona P1 effort C0T49EFF1
t49_persona P0 plain C0T49PLN1
ALL_PERSONAS=(P2 P1 P0)

# t49_set_values <prefix> <model|""> <effort|"">: the persona's values now,
# which config.json and every later launch check read ("" for a key it does
# not set).
t49_set_values() {
    printf -v "$1_MODEL" '%s' "$2"
    printf -v "$1_EFFORT" '%s' "$3"
}

# Each persona's values now (P2's change at the confirmed change).
t49_set_values P2 "${P2_MODEL_ONE}" "${LEVELS[-1]}"
t49_set_values P1 "" "${LEVELS[0]}"
t49_set_values P0 "" ""
P2_NEW_EFFORT="${LEVELS[0]}"
[[ "${P2_NEW_EFFORT}" != "${LEVELS[-1]}" ]] || fail "setup: P2's new effort equals its first one"

# Every Fresh-Start Line form for each persona: one key each, then both.
declare -A FRESH_FORMS
t49_line=""
for t49_p in "${ALL_PERSONAS[@]}"; do
    t49_ref_var="${t49_p}_REF"
    t49_value t49_line freshStartLine "${!t49_ref_var}" model
    FRESH_FORMS["${t49_p}.model"]="${t49_line}"
    t49_value t49_line freshStartLine "${!t49_ref_var}" effort
    FRESH_FORMS["${t49_p}.effort"]="${t49_line}"
    t49_value t49_line freshStartLine "${!t49_ref_var}" model effort
    FRESH_FORMS["${t49_p}.both"]="${t49_line}"
done

# t49_persona_json <prefix>: one persona entry, with `model` and `effort`
# only when the persona sets them.
t49_persona_json() {
    local n="$1_NAME" l="$1_LABEL" w="$1_WORK" ch="$1_CHANNEL" m="$1_MODEL" e="$1_EFFORT"
    jq -nc --arg name "${!n}" --arg creds "${CREDS_DIR}/${!l}.json" --arg work "${!w}" --arg cfg "${T49_CFG}" \
        --arg channel "${!ch}" --arg model "${!m}" --arg effort "${!e}" \
        '{name: $name, credentials_file: $creds, working_directory: $work, claude_config_dir: $cfg,
          channels: [{id: $channel, delivery: "all"}], permission_prompts: $channel}
         + (if $model == "" then {} else {model: $model} end)
         + (if $effort == "" then {} else {effort: $effort} end)' \
        || fail "setup: could not build $1's persona entry"
}

# t49_write_config: config.json holds the three personas with their values now.
t49_write_config() {
    local joined="" p entry
    for p in "${ALL_PERSONAS[@]}"; do
        entry="$(t49_persona_json "${p}")" || exit 1
        joined+="${joined:+, }${entry}"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "session_restart_delay": ${RESTART_DELAY_S},
  "exit_timeout": 5
}
EOF
}

# ---------------------------------------------------------------------------
# The Slack stub
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
t49_labels=()
for t49_p in "${ALL_PERSONAS[@]}"; do
    t49_label_var="${t49_p}_LABEL"
    t49_labels+=("${!t49_label_var}")
done
python3 - "${t49_labels[@]}" << 'EOF' | write_file "${STUB_DIR}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
(cd "${STUB_DIR}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${STUB_RECORD}" \
    --control "${STUB_DIR}/control.json" --ready-file "${STUB_DIR}/ready.json") > "${STUB_DIR}/stub.out" 2>&1 &
SLACK_STUB_PID=$!
track_pid "${SLACK_STUB_PID}"
wait_for_file "${STUB_DIR}/ready.json" "${STUB_WAIT_S}" "setup: the Slack stub never wrote its ready file"
CSCB_SLACK_API_URL="$(jq -r '.api_url' "${STUB_DIR}/ready.json")"
[[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
    || fail "setup: the Slack stub's api_url '${CSCB_SLACK_API_URL}' is not loopback"
export CSCB_SLACK_API_URL

# ---------------------------------------------------------------------------
# Reading the rows, the launch records, the logs and the calls
# ---------------------------------------------------------------------------

# t49_row_state <id>: the row's state (a harness `status`), or nothing when
# the read fails.
t49_row_state() {
    ad_capture status --instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t49_row_is() {
    [[ "$(t49_row_state "$1")" == "$2" ]]
}

# t49_row_field <id> <field> <step>: a field of the row's harness `get`.
t49_row_field() {
    ad_capture get --instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "$3: harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    jq -r --arg f "$2" '.[$f] // empty' "${AD_OUT}" || fail "$3: could not read $2 from $1's row"
}

# t49_launches_of <prefix>: the persona's launch records, as one JSON array
# in record order (`[]` when the stub has recorded none). It reads under a
# shared lock on the file the stubs append to under an exclusive one, so a
# record still being written is never read in part.
t49_launches_of() {
    local real="$1_REAL"
    if [[ -f "${LAUNCHES}" ]]; then
        # shellcheck disable=SC2016 # a jq filter, not shell text
        /usr/bin/flock -s "${LAUNCHES}" jq -sc --arg c "${!real}" '[.[] | select(.cwd == $c)]' "${LAUNCHES}" \
            || fail "could not read ${LAUNCHES}"
    else
        echo '[]'
    fi
}

t49_launch_count() {
    local all
    all="$(t49_launches_of "$1")" || exit 1
    jq -r 'length' <<< "${all}"
}

t49_launches_reached() {
    (( $(t49_launch_count "$1") >= $2 ))
}

# t49_elements <record> <eq|prefix> <text>: how many of the record's argument
# elements equal (start with) <text>.
t49_elements() {
    jq -r --arg m "$2" --arg t "$3" \
        '[.argv[] | select(if $m == "eq" then . == $t else startswith($t) end)] | length' <<< "$1"
}

# t49_resume_ids <record>: the session each `--resume` element names: the
# element after a bare `--resume`, or the text after `--resume=`.
t49_resume_ids() {
    jq -r '.argv as $a | [range(0; $a | length) as $i
        | if $a[$i] == "--resume" then ($a[$i + 1] // "")
          elif ($a[$i] | startswith("--resume=")) then ($a[$i] | ltrimstr("--resume="))
          else empty end] | join(" ")' <<< "$1"
}

# Each persona's expected launch count, recorded session_id and registered
# MCP sessions.
declare -A EXPECT_LAUNCHES SID CONNECTED
for t49_p in "${ALL_PERSONAS[@]}"; do
    EXPECT_LAUNCHES["${t49_p}"]=0
    CONNECTED["${t49_p}"]=0
done

# t49_check_counts <step>: every persona has exactly its expected launches.
t49_check_counts() {
    local p n
    for p in "${ALL_PERSONAS[@]}"; do
        n="$(t49_launch_count "${p}")" || exit 1
        [[ "${n}" == "${EXPECT_LAUNCHES[${p}]}" ]] \
            || fail "$1: ${p} has ${n} launch record(s), not ${EXPECT_LAUNCHES[${p}]}"
    done
}

# t49_check_launch <step> <prefix> <record> <resume-sid|"">: the record
# carries exactly the persona's model and effort elements, nothing that
# splits a value from its option, and `--resume <resume-sid>` (or no
# `--resume` element at all when <resume-sid> is empty).
t49_check_launch() {
    local step="$1" p="$2" record="$3" sid="$4" m_var="${2}_MODEL" e_var="${2}_EFFORT" model effort want n bare
    model="${!m_var}"
    effort="${!e_var}"
    want=0
    [[ -z "${model}" ]] || want=1
    n="$(t49_elements "${record}" prefix "${MODEL_OPT}")"
    [[ "${n}" == "${want}" ]] || fail "${step}: ${p}'s launch has ${n} element(s) starting with ${MODEL_OPT}, not ${want}: ${record}"
    if [[ -n "${model}" ]]; then
        n="$(t49_elements "${record}" eq "${MODEL_PREFIX}${model}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${p}'s launch has ${n} element(s) equal to '${MODEL_PREFIX}${model}', not 1: ${record}"
    fi
    want=0
    [[ -z "${effort}" ]] || want=1
    n="$(t49_elements "${record}" prefix "${EFFORT_OPT}")"
    [[ "${n}" == "${want}" ]] || fail "${step}: ${p}'s launch has ${n} element(s) starting with ${EFFORT_OPT}, not ${want}: ${record}"
    if [[ -n "${effort}" ]]; then
        n="$(t49_elements "${record}" eq "${EFFORT_PREFIX}${effort}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${p}'s launch has ${n} element(s) equal to '${EFFORT_PREFIX}${effort}', not 1: ${record}"
    fi
    for bare in "${MODEL_OPT}" "${EFFORT_OPT}" "${P2_MODEL_ONE}" "${P2_MODEL_TWO}"; do
        n="$(t49_elements "${record}" eq "${bare}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${p}'s launch has ${n} element(s) equal to '${bare}' alone: ${record}"
    done
    n="$(t49_elements "${record}" prefix --resume)"
    if [[ -z "${sid}" ]]; then
        [[ "${n}" == 0 ]] || fail "${step}: ${p}'s launch, a fresh conversation, has ${n} element(s) starting with --resume: ${record}"
    else
        [[ "${n}" == 1 ]] || fail "${step}: ${p}'s launch has ${n} element(s) starting with --resume, not 1: ${record}"
        n="$(t49_resume_ids "${record}")"
        [[ "${n}" == "${sid}" ]] || fail "${step}: ${p}'s launch resumes '${n}', not its session ${sid}: ${record}"
    fi
}

# t49_lines <file>: how many lines <file> has (0 when missing).
t49_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t49_count_after <file> <line> <matcher>: lines after <line> that match.
t49_count_after() {
    local tmp="${SCENARIO_ROOT}/count-after.tmp"
    if [[ -f "$1" ]]; then
        tail -n "+$(( $2 + 1 ))" "$1" > "${tmp}"
    else
        : > "${tmp}"
    fi
    count_in "${tmp}" "$3"
}

# t49_mark: the leg's mark: the agent-director shim log's mark, the lines
# server.log and startup-errors.log hold, and the Slack stub record's last seq.
t49_mark() {
    MARK_AD="$(ad_shim_mark)" || exit 1
    MARK_LOG="$(t49_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_ERRORS="$(t49_lines "${SLACK_STATE_DIR}/startup-errors.log")"
    MARK_SLACK="$(slack_record_mark "${STUB_RECORD}")" || exit 1
}

# t49_fresh_lines_after <prefix> [<form>...]: server.log lines after the mark
# that are one of the persona's Fresh-Start Line forms (default: all three).
t49_fresh_lines_after() {
    local p="$1" form total=0
    shift
    (( $# > 0 )) || set -- model effort both
    for form in "$@"; do
        total=$(( total + $(t49_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${FRESH_FORMS[${p}.${form}]}") ))
    done
    echo "${total}"
}

# t49_check_no_fresh_lines <step>: no Fresh-Start Line for any persona after
# the mark.
t49_check_no_fresh_lines() {
    local p n
    for p in "${ALL_PERSONAS[@]}"; do
        n="$(t49_fresh_lines_after "${p}")"
        [[ "${n}" == 0 ]] || fail "$1: ${n} Fresh-Start Line(s) for ${p} after the mark"
    done
}

# t49_check_no_lifecycle_calls <step> <prefix>: no CSCB pause, kill, spawn or
# resume named the persona's id in the agent-director shim log after the mark.
t49_check_no_lifecycle_calls() {
    local id_var="${2}_ID" verb n
    for verb in pause kill spawn resume; do
        n="$(cscb_ad_count_between "${MARK_AD}" - "${verb}" "${!id_var}")" || exit 1
        [[ "${n}" == 0 ]] || fail "$1: ${n} CSCB ${verb} call(s) of ${!id_var} after the mark"
    done
}

# t49_cli <out-file> <cli-arg>...: a CLI command of the package under test,
# run as a CSCB process (`cscb_run`) with no Slack token, no CSCB_PERSONA and
# SLACK_DRY_RUN unset; its output in <out-file>, its status in T49_RC.
t49_cli() {
    local out="$1" rc=0
    shift
    cscb_run env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u SLACK_DRY_RUN \
        "${SCENARIO_CLI}" "$@" < /dev/null > "${out}" 2>&1 || rc=$?
    T49_RC="${rc}"
    echo "${TEST_NAME}: ${*} exited ${T49_RC}"
}

# t49_show <file> <what>: print <file> indented on stderr, for a failing step.
t49_show() {
    echo "  | ${2}:" >&2
    sed 's/^/  | /' "$1" >&2 || true
}

# t49_clean_restart <step> <prefix>...: `clean_restart` of these personas'
# keys exits 0 with each one's relaunched line once and no other persona's.
t49_clean_restart() {
    local step="$1" out p name_var key_var line n named
    shift
    local keys=()
    for p in "$@"; do
        key_var="${p}_KEY"
        keys+=("${!key_var}")
    done
    out="${SCENARIO_ROOT}/clean_restart-$(date +%s%N).out"
    t49_cli "${out}" clean_restart "${keys[@]}"
    (( T49_RC == 0 )) || { t49_show "${out}" "the command's output"; fail "${step}: clean_restart exited ${T49_RC}, not 0 (its relaunch wait ${CLEAN_WAIT_MS}ms)"; }
    for p in "${ALL_PERSONAS[@]}"; do
        name_var="${p}_NAME"
        t49_value line cleanRestartRelaunchedLine "${!name_var}"
        n="$(grep -cxF -- "${line}" "${out}" || true)"
        named=0
        [[ " $* " == *" ${p} "* ]] && named=1
        [[ "${n:-0}" == "${named}" ]] \
            || { t49_show "${out}" "the command's output"; fail "${step}: ${n:-0} relaunched line(s) for ${!name_var}, not ${named}"; }
    done
}

# t49_relaunched <step> <prefix> <resume|fresh>: the persona's next launch
# record arrives (EXPECT_LAUNCHES already counts it), its row reads
# `waiting`, its MCP session registers again; the record carries its elements
# and resumes its recorded session (resume), or none (fresh: the row's
# session_id is a new one, which SID then records).
t49_relaunched() {
    local step="$1" p="$2" kind="$3" id_var="${2}_ID" ref_var="${2}_REF" all record sid want
    wait_until "${RELAUNCH_WAIT_S}" "${step}: ${p} never got launch record ${EXPECT_LAUNCHES[${p}]}" \
        t49_launches_reached "${p}" "${EXPECT_LAUNCHES[${p}]}"
    wait_until "${ROW_WAIT_S}" "${step}: ${!id_var} never reported in (waiting)" t49_row_is "${!id_var}" waiting
    CONNECTED["${p}"]=$(( CONNECTED[${p}] + 1 ))
    wait_for_count "$(matcher "[slack] Session connected: persona ${!ref_var}")" "${CONNECTED[${p}]}" "${CONNECT_WAIT_S}" \
        "${step}: the server never registered ${!ref_var}'s session"
    all="$(t49_launches_of "${p}")" || exit 1
    record="$(jq -c 'last' <<< "${all}")"
    sid="$(t49_row_field "${!id_var}" session_id "${step}")" || exit 1
    [[ -n "${sid}" ]] || fail "${step}: ${!id_var}'s row has no session_id"
    if [[ "${kind}" == resume ]]; then
        [[ "${sid}" == "${SID[${p}]}" ]] || fail "${step}: ${!id_var}'s session is ${sid}, not its conversation's ${SID[${p}]}"
        want="${SID[${p}]}"
    else
        [[ "${sid}" != "${SID[${p}]}" ]] || fail "${step}: ${!id_var}'s session is still ${sid}: the next launch resumed"
        want=""
    fi
    t49_check_launch "${step}" "${p}" "${record}" "${want}"
    SID["${p}"]="${sid}"
    echo "${TEST_NAME}: ${step}: ${p} launched (${kind}) with session ${sid}: $(jq -c '.argv' <<< "${record}")"
}

# t49_start_and_wait: a live start, and its start pass completing (its own
# completion line: server.log is appended across starts).
t49_start_and_wait() {
    local m before
    m="$(completion_match "${#ALL_PERSONAS[@]}")" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "the start pass never completed"
}

# ---------------------------------------------------------------------------
# The legs
# ---------------------------------------------------------------------------

t49_fresh_leg() {
    local step="fresh launch" p
    t49_mark
    t49_write_config
    t49_start_and_wait
    for p in "${ALL_PERSONAS[@]}"; do
        EXPECT_LAUNCHES["${p}"]=1
        SID["${p}"]=""
        t49_relaunched "${step}" "${p}" fresh
    done
    t49_check_counts "${step}"
    t49_check_no_fresh_lines "${step}"
    P2_JSONL="$(t49_row_field "${P2_ID}" jsonl_path "${step}")" || exit 1
    [[ -n "${P2_JSONL}" && -f "${P2_JSONL}" ]] || fail "${step}: ${P2_ID}'s jsonl_path '${P2_JSONL}' is not a file"
}

# t49_resume_leg <step> <how>: every persona relaunched into its session.
t49_resume_leg() {
    local step="$1" how="$2" p id_var pane ended
    t49_mark
    t49_check_counts "${step}: before"
    case "${how}" in
        dies)
            for p in "${ALL_PERSONAS[@]}"; do
                id_var="${p}_ID"
                pane="$(ad_store_row "${!id_var}")" || exit 1
                pane="$(jq -r '.[0].pane_id // empty' <<< "${pane}")" || fail "${step}: could not read ${!id_var}'s pane_id"
                [[ "${pane}" =~ ^%[0-9]+$ ]] || fail "${step}: ${!id_var}'s row records pane '${pane}', not a pane id"
                ended="$(end_worker_without_session_end "${pane}")" || exit 1
                echo "${TEST_NAME}: ${step}: ${p} ended with no SessionEnd: ${ended}"
            done
            ;;
        clean_restart)
            t49_clean_restart "${step}" "${ALL_PERSONAS[@]}"
            ;;
        stop_start)
            stop_server --stop-bots
            t49_start_and_wait
            ;;
    esac
    for p in "${ALL_PERSONAS[@]}"; do
        EXPECT_LAUNCHES["${p}"]=$(( EXPECT_LAUNCHES[${p}] + 1 ))
        t49_relaunched "${step}" "${p}" resume
    done
    t49_check_counts "${step}"
    t49_check_no_fresh_lines "${step}"
}

# t49_applied_logged <line>: the apply's line logged after the mark.
t49_applied_logged() {
    [[ "$(t49_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] $1")" != 0 ]]
}

# t49_untouched <step> <old-sid>: P2 reads waiting in its old session and no
# persona has a new launch record.
t49_untouched() {
    local sid
    t49_row_is "${P2_ID}" waiting || fail "$1: ${P2_ID} no longer reads waiting"
    sid="$(t49_row_field "${P2_ID}" session_id "$1")" || exit 1
    [[ "${sid}" == "$2" ]] || fail "$1: ${P2_ID}'s session is now ${sid}, not $2"
    t49_check_counts "$1"
}

t49_change_leg() {
    local step="confirmed change" pending apply line deadline old_sid old_jsonl n p label_var posts sid
    t49_mark
    t49_check_counts "${step}: before"
    old_sid="${SID[P2]}"
    old_jsonl="$(t49_row_field "${P2_ID}" jsonl_path "${step}")" || exit 1
    [[ -n "${old_jsonl}" && -f "${old_jsonl}" ]] || fail "${step}: ${P2_ID}'s jsonl_path '${old_jsonl}' is not a file"
    pending="${SLACK_STATE_DIR}/config.json${PENDING_SUFFIX}"
    apply="${SLACK_STATE_DIR}/config.json${APPLY_SUFFIX}"
    [[ ! -e "${pending}" ]] || fail "${step}: ${pending} exists before the edit"
    t49_set_values P2 "${P2_MODEL_TWO}" "${P2_NEW_EFFORT}"
    t49_write_config
    wait_for_file "${pending}" "${RELOAD_WAIT_S}" "${step}: no pending file after the config.json edit"
    mv -f -- "${pending}" "${apply}" || fail "${step}: could not rename ${pending} to ${apply}"
    t49_value line reloadAppliedLogLine 0 0 0 1 0 0 "${SLACK_STATE_DIR}/config.json"
    if ! wait_until "${APPLY_WAIT_S}" "${step}: the apply never logged its line" t49_applied_logged "${line}"; then
        echo "  | expected: ${line}" >&2
        fail "${step}: the apply never logged its line (not within ${APPLY_WAIT_S}s)"
    fi
    echo "${TEST_NAME}: ${step}: the operator confirmed the apply; it logged its line"
    deadline=$(( SECONDS + HOLD_S ))
    while :; do
        t49_untouched "${step}: hold" "${old_sid}"
        (( SECONDS < deadline )) || break
        sleep 0.2
    done
    t49_check_no_fresh_lines "${step}: hold"
    t49_check_no_lifecycle_calls "${step}" P2
    echo "${TEST_NAME}: ${step}: ${P2_ID} kept its session ${old_sid} for ${HOLD_S}s after the apply"

    step="next launch"
    t49_clean_restart "${step}" P2
    EXPECT_LAUNCHES[P2]=$(( EXPECT_LAUNCHES[P2] + 1 ))
    t49_relaunched "${step}" P2 fresh
    t49_check_counts "${step}"
    n="$(t49_fresh_lines_after P2 both)"
    [[ "${n}" == 1 ]] || { echo "  | expected: ${FRESH_FORMS[P2.both]}" >&2; fail "${step}: ${n} Fresh-Start Line(s) for P2's model and effort after the change's mark, not 1"; }
    n="$(t49_fresh_lines_after P2 model effort)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} one-key Fresh-Start Line(s) for P2 after the change's mark"
    for p in P1 P0; do
        n="$(t49_fresh_lines_after "${p}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} Fresh-Start Line(s) for ${p} after the change's mark"
    done
    n="$(t49_lines "${SLACK_STATE_DIR}/startup-errors.log")"
    [[ "${n}" == "${MARK_ERRORS}" ]] || fail "${step}: startup-errors.log has $(( n - MARK_ERRORS )) new line(s) after the change's mark"
    for p in "${ALL_PERSONAS[@]}"; do
        label_var="${p}_LABEL"
        posts="$(slack_label_posts "${STUB_RECORD}" "${!label_var}" "${MARK_SLACK}")" || exit 1
        [[ -z "${posts}" ]] || fail "${step}: the Slack stub recorded post(s) for ${p} after the change's mark: ${posts}"
    done
    [[ -f "${old_jsonl}" ]] || fail "${step}: P2's old transcript ${old_jsonl} is gone"
    for p in P1 P0; do
        local id_var="${p}_ID"
        sid="$(t49_row_field "${!id_var}" session_id "${step}")" || exit 1
        [[ "${sid}" == "${SID[${p}]}" ]] || fail "${step}: ${!id_var}'s session is ${sid}, not ${SID[${p}]}"
        t49_row_is "${!id_var}" waiting || fail "${step}: ${!id_var} no longer reads waiting"
        t49_check_no_lifecycle_calls "${step}" "${p}"
    done
    echo "${TEST_NAME}: ${step}: P2 started a fresh conversation ${SID[P2]}; its old transcript ${old_jsonl} is kept"
}

t49_fresh_leg
t49_resume_leg "the instance dies" dies
t49_resume_leg "clean_restart <bot>" clean_restart
t49_resume_leg "stop --stop-bots, then start" stop_start
t49_change_leg

stop_server --stop-bots
t49_check_counts "close"

# The closing assertions.
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
