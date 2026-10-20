#!/usr/bin/env bash
# AD outcome and lifecycle regression checks; no startup TUI interpretation.

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

# The test-only settings (b.2nr), scenario inputs; every value read back goes
# through the printer in "Values from the installed package", none is retyped:
# the latch re-check interval, in config.json's `test_timer_overrides` block
# (ms; it must stay above SETTLE_S, which the setup checks), and the
# starting-session bound, in agent-director's `[tmux]` table (seconds; the
# stopping window beside it is written at its printed minimum).
OVR_LATCH_RECHECK_MS=45000
OVR_STARTING_SESSION_S=60

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
    stub_mode "${PERSONA_WORK[${key}]}" "${STUB_MODE_AT_ONCE}"
    PERSONA_CREDS[${key}]="${creds}/${key}.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${label}")" "$(fake_token app "${label}")" \
        | write_file "${PERSONA_CREDS[${key}]}" 600
    PERSONA_ID[${key}]="$(fmk_text personaInstanceId "${key}")" || fail "setup: fmk-texts.ts could not print personaInstanceId ${key}"
    PERSONA_NAMED[${key}]="$(fmk_text personaTmuxSessionName "${key}")" \
        || fail "setup: fmk-texts.ts could not print personaTmuxSessionName ${key}"
}

# write_personas_config <key>...: the server's config.json, configuring the
# given personas (in that order) with `health_check_interval` 0 and the
# `test_timer_overrides` block (TEST_TIMER_BLOCK, set in the values section).
write_personas_config() {
    local key personas="[]"
    for key in "$@"; do
        personas="$(jq -c --arg n "${PERSONA_NAME[${key}]}" --arg c "${PERSONA_CREDS[${key}]}" \
            --arg w "${PERSONA_WORK[${key}]}" --arg ch "${PERSONA_CHANNEL[${key}]}" \
            '. + [{name: $n, credentials_file: $c, working_directory: $w,
                   channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}]' <<< "${personas}")" \
            || fail "config: jq could not add persona ${key}"
    done
    [[ -n "${TEST_TIMER_BLOCK}" ]] || fail "config: no test_timer_overrides block (the values section sets it)"
    jq -n --argjson p "${personas}" --argjson port "${SCENARIO_PORT}" --argjson overrides "${TEST_TIMER_BLOCK}" \
        '{personas: $p, bind: "127.0.0.1", port: $port, health_check_interval: 0, exit_timeout: 5,
          test_timer_overrides: $overrides}' \
        | write_config
}

# read_row <step> <instance-id>: a harness `get` of the row. Sets ROW_STATE,
# ROW_SID (session_id) and ROW_SESSION (tmux_session_name), each
# empty when absent.
read_row() {
    local fields
    ad_capture get --instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .session_id // "", .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
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
# row (lib/scenario.sh's `ad_store_row`, both guards first). Sets
# STORE_STATE and STORE_RV (row_version).
store_row() {
    local json
    json="$(ad_store_row "$2")" || exit 1
    STORE_STATE="$(jq -r '.[0].state' <<< "${json}")"
    STORE_RV="$(jq -r '.[0].row_version' <<< "${json}")"
    [[ "${STORE_RV}" =~ ^[0-9]+$ ]] || fail "$1: the row's row_version reads '${STORE_RV}'"
}

# store_rows_of <step> <instance-id>: print how many rows the store holds
# with <instance-id> (the harness's read-only store read, both guards first).
store_rows_of() {
    _scenario_store_read "$1" "SELECT COUNT(*) FROM spawns WHERE instance_id = '$2'"
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
# alone per round. A resume has exactly one fresh provenance `get` between
# the read and the resume. No other call is allowed; fails otherwise, and on a read with no
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
                [[ "${call}" != "${CALL_RESUME}" ]] || want=get
            fi
        elif [[ "${want}" == get && "${verb}" == get ]]; then
            want="${call}"
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

# The test-only timer overrides' block and loud line (the printer's, from the
# scenario input above): the latch re-check interval.
OVR_PAIRS=("latch_recheck_interval_ms=${OVR_LATCH_RECHECK_MS}")
TEST_TIMER_BLOCK="$(fmk_text testTimerOverridesBlock "${OVR_PAIRS[@]}")" || fail "setup: fmk-texts.ts could not print testTimerOverridesBlock ${OVR_PAIRS[*]}"
[[ "${TEST_TIMER_BLOCK}" == '{'*'}' && "${TEST_TIMER_BLOCK}" != '{}' ]] \
    || fail "setup: the printer gives no override block for ${OVR_PAIRS[*]}: '${TEST_TIMER_BLOCK}'"
OVERRIDES_LINE="$(fmk_text buildTestTimerOverridesLine "${OVR_PAIRS[@]}")" || fail "setup: fmk-texts.ts could not print buildTestTimerOverridesLine ${OVR_PAIRS[*]}"
# The line's text up to its colon: the match for the line of any set.
OVERRIDES_STEM="$(overrides_stem "${OVERRIDES_LINE}")" || exit 1

# The re-check interval in effect: the block's value, through the package's own
# helper.
INTERVAL_MS="$(fmk_text effectiveTestTimer latch_recheck_interval_ms "${OVR_PAIRS[@]}")" \
    || fail "setup: fmk-texts.ts could not print effectiveTestTimer latch_recheck_interval_ms"
[[ "${INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the latch re-check interval in effect is '${INTERVAL_MS}'"
INTERVAL_US=$(( INTERVAL_MS * 1000 ))
INTERVAL_S=$(( (INTERVAL_MS + 999) / 1000 ))
(( INTERVAL_S > SETTLE_S )) || fail "setup: the ${SETTLE_S} s settle is not shorter than the ${INTERVAL_S} s re-check interval"

# The `[tmux]` table written to the scenario HOME's agent-director settings
# file before any start (both keys among the package's AD_TMUX_KEYS): the
# starting-session bound (the value at or above its minimum) and the stopping
# window at its minimum. BOUND_S and STOPPING_S are read back from the written
# table. The own-id persona's session must be older than both before the
# set-up statement (ad_store_mark_finished refuses unless the session is
# older than the stopping window; agent-director answers "still starting"
# before the starting-session bound), so the age wait is for
# max(BOUND_S, STOPPING_S) plus AGE_MARGIN_S. No CSCB or harness call of this
# script meets a stopping row, so the window bears on nothing else here.
TMUX_KEYS_TEXT="$(fmk_text AD_TMUX_KEYS)" || fail "setup: fmk-texts.ts could not print AD_TMUX_KEYS"
read -r -a TMUX_KEYS <<< "${TMUX_KEYS_TEXT}"
KEY_STARTING=starting_session_seconds
KEY_STOPPING=stopping_window_seconds
for want_key in "${KEY_STARTING}" "${KEY_STOPPING}"; do
    found=0
    for key in "${TMUX_KEYS[@]}"; do
        [[ "${key}" == "${want_key}" ]] && found=1
    done
    (( found )) || fail "setup: ${want_key} is not one of the package's AD_TMUX_KEYS (${TMUX_KEYS_TEXT})"
done
MIN_STARTING="$(fmk_text AD_SETTING_MINIMUMS "${KEY_STARTING}")" || fail "setup: fmk-texts.ts could not print AD_SETTING_MINIMUMS ${KEY_STARTING}"
MIN_STOPPING="$(fmk_text AD_SETTING_MINIMUMS "${KEY_STOPPING}")" || fail "setup: fmk-texts.ts could not print AD_SETTING_MINIMUMS ${KEY_STOPPING}"
[[ "${MIN_STARTING}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the minimum of ${KEY_STARTING} is '${MIN_STARTING}'"
[[ "${MIN_STOPPING}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the minimum of ${KEY_STOPPING} is '${MIN_STOPPING}'"
(( OVR_STARTING_SESSION_S >= MIN_STARTING )) \
    || fail "setup: ${KEY_STARTING} ${OVR_STARTING_SESSION_S} is below its minimum ${MIN_STARTING}"
AD_SETTINGS_FILE=""
write_ad_settings "${KEY_STARTING}=${OVR_STARTING_SESSION_S}" "${KEY_STOPPING}=${MIN_STOPPING}"
BOUND_S="$(sed -n "s/^${KEY_STARTING} = \([0-9][0-9]*\)\$/\1/p" "${AD_SETTINGS_FILE}")" \
    || fail "setup: could not read ${KEY_STARTING} back from ${AD_SETTINGS_FILE}"
STOPPING_S="$(sed -n "s/^${KEY_STOPPING} = \([0-9][0-9]*\)\$/\1/p" "${AD_SETTINGS_FILE}")" \
    || fail "setup: could not read ${KEY_STOPPING} back from ${AD_SETTINGS_FILE}"
[[ "${BOUND_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the starting-session bound read back from ${AD_SETTINGS_FILE} is '${BOUND_S}'"
[[ "${STOPPING_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the stopping window read back from ${AD_SETTINGS_FILE} is '${STOPPING_S}'"
# The age the own-id persona's session must pass: the larger of the two.
AGE_BASE_S="${BOUND_S}"
(( STOPPING_S <= AGE_BASE_S )) || AGE_BASE_S="${STOPPING_S}"
echo "${TEST_NAME}: re-check interval ${INTERVAL_MS} ms, settle ${SETTLE_S} s, starting-session bound ${BOUND_S} s, stopping window ${STOPPING_S} s"

# fmk_value <entry> [<arg>...]: print fixtures/fmk-texts.ts's value, failing
# the scenario when the printer fails or prints nothing.
fmk_value() {
    local v
    v="$(fmk_text "$@")" || fail "setup: fmk-texts.ts could not print $*"
    [[ -n "${v}" ]] || fail "setup: fmk-texts.ts printed an empty $*"
    printf '%s' "${v}"
}

# start_live <step>: start the server (live) and require its one loud TEST
# TIMER OVERRIDES ACTIVE line.
start_live() {
    local step="$1" before
    before="$(count_log "${OVERRIDES_STEM}")"
    start_server --live
    expect_one_overrides_line "${step}: startup" "${before}" "${START_WAIT_S}"
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
# The "not this launch's session" legs, by key: the relabelled worker pane and
# its window; the tmux shim's mark at the harness's event (the pane respawn,
# or the session's end); the shim mark once a harness read showed the row
# missing.
declare -A SEED_PANE=() SEED_WID=() EVENT_TMUX_MARK=() MISSING_MARK=()

echo "${TEST_NAME}: Part 2's per-case table:"
for key in "${P2_KEYS[@]}"; do
    printf '%s:   %-10s case=%s refused=%s round=%s+%s clear=%s; set-up: %s\n' "${TEST_NAME}" "${key}" "${CASE_OF[${key}]}" \
        "${OP_OF[${key}]}" "${STEP_OF[${key}]}" "${CALL_OF[${key}]}" "${CLEAR_OF[${key}]}" "${SETUP_OF[${key}]}"
done

# ---------------------------------------------------------------------------
# Part 1: "conflicting labels", from a global @ad_owner value
# ---------------------------------------------------------------------------

CN_KEY="$(persona_key labelnote)"
P1_KEYS=("${CN_KEY}")
PERSONA_NAME[${CN_KEY}]=labelnote
PERSONA_CHANNEL[${CN_KEY}]=C0T23CN01
PERSONA_TOKEN[${CN_KEY}]=t23labelnote

CASE_CONFLICTING_LABELS="$(fmk_value LATCH_CASE_CONFLICTING_LABELS)"
OP_BRING_UP="$(fmk_value REFUSED_OPERATION_BRING_UP)"
CALL_PENDING_READ="$(fmk_value RECHECK_CALL_PENDING_READ_PANE)"
CONFLICTING_LABELS_PHRASE="$(fmk_value CONFLICT_CONFLICTING_LABELS_PHRASE)"
LATCHING_NOTE="$(fmk_value LATCHING_LIVENESS_NOTE)"

# Part 1's per-case rows (the header's Part 1): the case; the refused
# operation and row state the latch-set line records; each round's read and
# call; a still-latched round's answer.
CASE_OF[${CN_KEY}]="${CASE_CONFLICTING_LABELS}"
OP_OF[${CN_KEY}]="${OP_BRING_UP}"
LATCH_ROW_OF[${CN_KEY}]=waiting
STEP_OF[${CN_KEY}]="${STEP_TABLE}"
CALL_OF[${CN_KEY}]="${CALL_NONE}"
ANSWER_OF[${CN_KEY}]=still-latched
PHRASE_BY_CASE[${CASE_CONFLICTING_LABELS}]="${CONFLICTING_LABELS_PHRASE}"
# Each round's read of the row: `get` for a "conflicting labels" latch (only
# `get` shows the note); `status` for every other latch (latch_rounds' default).
declare -A READ_OF=([${CN_KEY}]=get)
# The calls the round checker reads from: after the reads that come within
# one interval of the latch's starting point (no round can), by key.
declare -A ROUNDS_FROM=()

echo "${TEST_NAME}: Part 1's per-case table:"
printf '%s:   %-10s case=%s refused=%s row=%s round=%s+%s clear=%s; set-up: %s\n' "${TEST_NAME}" "${CN_KEY}" \
    "${CASE_OF[${CN_KEY}]}" "${OP_OF[${CN_KEY}]}" waiting get "${CALL_NONE}" "restart path's decision once the note is gone" \
    "live waiting; ${LATCHING_NOTE} from a harness find-missing under a global @ad_owner"


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
# session on the scenario's tmux server is a Part 1 persona's; fails when
# tmux cannot list the sessions. Positive controls: the note persona's row
# and its session are among them (both exist at every call).
p1_only() {
    local step="$1" ids id names name key ok err="${SCENARIO_ROOT}/p1-only-tmux.err"
    ids="$(_scenario_store_read "${step}" "SELECT instance_id FROM spawns")" || exit 1
    grep -q -x -F -e "${PERSONA_ID[${CN_KEY}]}" <<< "${ids}" \
        || fail "${step}: positive control: the store's ids ($(tr '\n' ' ' <<< "${ids}")) do not hold the note persona's ${PERSONA_ID[${CN_KEY}]}"
    while IFS= read -r id; do
        [[ -n "${id}" ]] || continue
        ok=0
        for key in "${P1_KEYS[@]}"; do
            [[ "${id}" == "${PERSONA_ID[${key}]}" ]] && ok=1
        done
        (( ok )) || fail "${step}: the store holds row ${id}, not a Part 1 persona's"
    done <<< "${ids}"
    names="$("${SCENARIO_REAL_TMUX}" list-sessions -F '#{session_name}' 2> "${err}")" \
        || fail "${step}: tmux list-sessions failed: $(head -c 300 "${err}")"
    grep -q -x -F -e "${PERSONA_NAMED[${CN_KEY}]}" <<< "${names}" \
        || fail "${step}: positive control: the scenario's tmux sessions ($(tr '\n' ' ' <<< "${names}")) do not hold the note persona's ${PERSONA_NAMED[${CN_KEY}]}"
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
    start_live "${step}"
    wait_for_count "$(completion_match 1)" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${id} has no session_id"
    [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
        || fail "${step}: the live row ${id} records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
    PERSONA_SID[${key}]="${ROW_SID}"
    wait_for_count "$(connected_match "${key}")" 1 "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as ${key}'s"
    stop_server
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    has_session "${PERSONA_NAMED[${key}]}" || fail "${step}: ${PERSONA_NAMED[${key}]} is gone after a plain stop"
    row_reads "${step}" "${id}" waiting || fail "${step}: ${id} reads '${ROW_STATE}' after a plain stop, not waiting"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting (session_id ${ROW_SID}) in ${ROW_SESSION} after a plain stop"
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
    _scenario_check_instance_id "${step}" "${id}"
    case "${value}" in
        null) sql=NULL ;;
        *) [[ "${value}" =~ ^\"?([0-9]+)\"?$ ]] || fail "${step}: proc_starttime '${value}' is not null or a whole number"
           sql="${BASH_REMATCH[1]}"
           [[ "${value}" != \"* ]] || sql="'${sql}'" ;;
    esac
    before="$(ad_store_row "${id}")" || exit 1
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    old="$(jq -c '.[0].proc_starttime' <<< "${before}")"
    out="$(ad_store_edit "UPDATE spawns SET proc_starttime = ${sql}, row_version = row_version + 1 WHERE instance_id = '${id}' AND row_version = ${rv} RETURNING instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row's row_version is no longer ${rv}: agent-director wrote it in between, and the edit wrote nothing"
    after="$(ad_store_row "${id}")" || exit 1
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
    # A start runs its state dir's last-applied record, so this life, which
    # adds the held-dialog persona, starts in a state dir of its own.
    new_state_dir p1-latch-life
    write_personas_config "${P1_KEYS[@]}"
    LATCH_LIFE_MARK="$(ad_shim_mark)"
    start_live "${step}"
    LATCH_PID="${SERVER_PID}"
    wait_latch_set "${CN_KEY}" "${step}"
    wait_for_count "$(completion_match "${#P1_KEYS[@]}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${#P1_KEYS[@]}")" | sed 's/^.*\] //')"
    p1_check_note_latch
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
p1_note_release() {
    local step="part 1: release global owner conflict"
    wait_rounds "part 1" "${CN_KEY}" "${STILL_LINE[${CN_KEY}]}" "${MIN_LATCHED_ROUNDS}" "${MIN_LATCHED_ROUNDS}"
    p1_only "${step}: before the unset"
    CN_ROUNDS_AT_UNSET="$(count_log "${STILL_LINE[${CN_KEY}]}")"
    ad_owner_global_unset
    P1_ENTER_MARK="$(ad_shim_mark)"
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
    # The row's state once the note is gone, before the clearing round
    # (checked against the latch's in p1_check_note_rounds).
    store_row "${step}" "${id}"
    FREE_STATE[${CN_KEY}]="${STORE_STATE}"
    FREE_RV[${CN_KEY}]="${STORE_RV}"
    echo "${TEST_NAME}: ${step}: [S8, recorded] the note was removed by ${who}; a harness get shows none (shim mark ${P1_NOTE_GONE_MARK}; ${id} reads ${STORE_STATE} at row_version ${STORE_RV} in the store; the loop's runs so far: $(find_missing_loop_runs))"
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
# the unset; the row keeps the state read at the latch (the store read taken
# when the note was gone, before the clearing round: p1_note_clear).
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
    [[ "${FREE_STATE[${key}]}" == "${LATCH_STATE[${key}]}" ]] \
        || fail "${step}: ${id} read ${FREE_STATE[${key}]} in the store once the note was gone, not ${LATCH_STATE[${key}]} as at the latch"
    echo "${TEST_NAME}: ${step}: ${i} round(s) while the note showed (${CN_ROUNDS_AT_UNSET} before the unset), each one get alone; no post beyond the latch's; ${id} read ${FREE_STATE[${key}]} once the note was gone, as at the latch"
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

# p1_check_ac43: the order proof (round k's lines, the unset, the Enter, a
# harness read showing `waiting`, then round k+1's get, by shim marks and
# times; both harness steps within one interval of round k's get), and round
# k+1: its get reads `waiting` and clears the latch: no other call of the id
# before the after-clear run's find-missing (so no read-pane in the round),
# the clear line and the round line once each, exactly one recovery post
# giving latchRecoveryReasonRowReads waiting, and no relatch.

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
    stop_server
    P2_START_MARK="$(ad_shim_mark)"
    P2_START_TMUX_MARK="$(tmux_shim_mark)"
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
    start_live "${step}"
    wait_for_count "$(completion_match "${n}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion "${n}" "${step}" "0 not brought up"
    for key in "${P2_LIFE1_KEYS[@]}"; do
        ref="$(persona_ref "${PERSONA_NAME[${key}]}")"
        wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${PERSONA_ID[${key}]}" waiting
        [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} has no session_id"
        [[ "${ROW_SESSION}" == "${PERSONA_NAMED[${key}]}" ]] \
            || fail "${step}: the live row ${PERSONA_ID[${key}]} records session '${ROW_SESSION}', not ${PERSONA_NAMED[${key}]}"
        PERSONA_SID[${key}]="${ROW_SID}"
        wait_for_count "[slack] Session connected: persona ${ref}" 1 "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the stub's session as ${key}'s"
        echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]} reads waiting, session_id ${ROW_SID}, session ${ROW_SESSION}"
    done
}

# ---------------------------------------------------------------------------
# Part 2: the age wait
# ---------------------------------------------------------------------------

p2_age_wait() {
    local step="part 2: the own-id persona's session age" session="${PERSONA_NAMED[${OI_KEY}]}" created age want timeout_s
    created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_created}')" \
        || fail "${step}: tmux gives no creation time for ${session}"
    [[ "${created}" =~ ^[0-9]+$ ]] || fail "${step}: tmux gave session_created '${created}' for ${session}"
    want=$(( AGE_BASE_S + AGE_MARGIN_S ))
    age=$(( $(date +%s) - created ))
    # The wait's bound, at least 0 (a session already old enough is checked
    # once).
    timeout_s=$(( want - age + 10 ))
    (( timeout_s >= 0 )) || timeout_s=0
    echo "${TEST_NAME}: ${step}: ${session} is ${age} s old; waiting until it is more than ${want} s old"
    wait_until "${timeout_s}" "${step}: ${session} never became more than ${want} s old" \
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
        || fail "${step}: ${id}'s session_id is '${ROW_SID}', not ${PERSONA_SID[${key}]}"
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
    session_older_than "${session}" "${AGE_BASE_S}" || fail "${step}: ${session} is not more than ${AGE_BASE_S} s old"
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
    SEED_WID[${key}]="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${SEEDED_PANE_ID}" '#{window_id}')" \
        || fail "${step}: tmux gives no window id for ${SEEDED_PANE_ID}"
    [[ "${SEED_WID[${key}]}" =~ ^@[0-9]+$ ]] || fail "${step}: tmux gave window id '${SEED_WID[${key}]}' for ${SEEDED_PANE_ID}"
    current="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_token, '') FROM spawns WHERE instance_id = '${id}'")" \
        || exit 1
    [[ "${current}" =~ ^[0-9a-f]{16}$ && "${current}" != "${SEEDED_TOKEN}" ]] \
        || fail "${step}: ${id} records launch token '${current}', not one other than the label's ${SEEDED_TOKEN}"
    row_reads "${step}" "${id}" waiting || fail "${step}: ${id} reads '${ROW_STATE}' after the relabel, not waiting"
    echo "${TEST_NAME}: ${step}: ${session} (${SEEDED_SESSION_ID}, window ${SEED_WID[${key}]}, worker pane ${SEEDED_PANE_ID}) labelled with token ${SEEDED_TOKEN}; the row records ${current} and reads waiting"
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
    started="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_started_at, '') FROM spawns WHERE instance_id = '${id}'")" \
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
    start_live "${step}"
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

# wait_rounds <part> <key> <matcher> <n> <round>: wait for <n> lines matching
# <matcher>, the persona's <round>-th round from its latch (or from the
# caller's starting point) being the last; <part> (`part 1`, `part 2`, `end`)
# heads the failure's step.
wait_rounds() {
    local part="$1" key="$2" m="$3" n="$4" round="$5"
    if ! _scenario_poll_until $(( round * (INTERVAL_S + 2 * SETTLE_S) )) _scenario_log_count_at_least "${m}" "${n}"; then
        latch_lines_of "${key}"
        fail "${part}: ${key}'s round ${round}: fewer than ${n} round line(s) '$(matcher_text "${m}")'"
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
        wait_rounds "part 2" "${key}" "${ROUND_HEAD[${key}]}" "${MIN_LATCHED_ROUNDS}" "${MIN_LATCHED_ROUNDS}"
    done
    step="part 2: the batched round's clearing event"
    # The shim mark right before the event: the end of the window from the
    # last latch in which every round is still latched (no CSCB find-missing).
    BATCH_EVENT_MARK="$(ad_shim_mark)"
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
        wait_rounds "part 2" "${key}" "${ROUND_HEAD[${key}]}" $(( MIN_LATCHED_ROUNDS + 1 )) $(( MIN_LATCHED_ROUNDS + 1 ))
    done
    wait_rounds "part 2" "${OI_KEY}" "${STILL_LINE[${OI_KEY}]}" $(( MIN_LATCHED_ROUNDS + 1 )) $(( MIN_LATCHED_ROUNDS + 1 ))
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
    wait_rounds "part 2" "${OI_KEY}" "$(matcher "${ROUND_END_HEAD[${OI_KEY}]}" "cleared (")" 1 $(( MIN_LATCHED_ROUNDS + 2 ))
    ROUND_END_MARK[${OI_KEY}]="$(ad_shim_mark)"
    wait_rounds "part 2" "${PN_KEY}" "${STILL_LINE[${PN_KEY}]}" $(( MIN_LATCHED_ROUNDS + 2 )) $(( MIN_LATCHED_ROUNDS + 2 ))
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
    wait_rounds "part 2" "${PN_KEY}" "$(matcher "${ROUND_END_HEAD[${PN_KEY}]}" "cleared (")" 1 $(( MIN_LATCHED_ROUNDS + 3 ))
    ROUND_END_MARK[${PN_KEY}]="$(ad_shim_mark)"

    # The unusable recorded name, still latched: its rounds so far (as many
    # as the pane-not-found persona's), taken right after its last.
    wait_rounds "part 2" "${UN_KEY}" "${STILL_LINE[${UN_KEY}]}" $(( MIN_LATCHED_ROUNDS + 3 )) $(( MIN_LATCHED_ROUNDS + 3 ))
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
        wait_rounds "part 2" "${key}" "${STILL_LINE[${key}]}" "${want[${key}]}" "${want[${key}]}"
    done
    # The agent-director shim's mark right before the events: from here to
    # each leg's MISSING_MARK, every find-missing is checked (no CSCB one; the
    # loop's marked the rows).
    RELABEL_EVENTS_MARK="$(ad_shim_mark)"
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
    # The loop's log is shared with Part 1's loop: Part 2's runs are those
    # logged after this count.
    P2_LOOP_RUNS_BEFORE="$(find_missing_loop_runs)"
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

# check_latched_rounds <key> [<part>]: the round checker (see the header,
# life 6), from the persona's latch to its clearing event's mark (FREE_MARK),
# with FREE_ROUNDS still-latched round lines and FREE_POSTS posts then
# (<part>, by default `part 2`, heads the step). Sets PREV_US to the last
# round's status time.
check_latched_rounds() {
    local key="$1" step="${2:-part 2}: $1's still-latched rounds" id="${PERSONA_ID[$1]}" rounds n i=0 prev to posts
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
# session_id (its `resume` kept the conversation); the server
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
    [[ -n "${ROW_SID}" ]] || fail "${step}: the launched row has no session_id"
    [[ -z "${PERSONA_SID[${key}]:-}" || "${ROW_SID}" == "${PERSONA_SID[${key}]}" ]] \
        || fail "${step}: the resumed row's session_id is '${ROW_SID}', not its first life's ${PERSONA_SID[${key}]}"
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
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with session_id ${ROW_SID}; one recovery post"
}

# check_retry_clear <key>: the batched round: its first calls of the id
# are one `status`, a fresh provenance `get` for a resume, then the table's call, at the cadence, with no CSCB
# `find-missing` between them; the call launches (check_launched).
check_retry_clear() {
    local key="$1" step="part 2: $1's clear (the batched round)" id="${PERSONA_ID[$1]}" rows s_pos s_time s_verb c_pos c_time c_verb c_args between call_line=2 g_verb
    rows="$(ad_cscb_calls "${id}" "${FREE_MARK[${key}]}")" || exit 1
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    if [[ "${CALL_OF[${key}]}" == "${CALL_RESUME}" ]]; then
        IFS=$'\t' read -r _ _ _ g_verb _ <<< "$(sed -n 2p <<< "${rows}")"
        [[ "${g_verb}" == get ]] || { sed 's/^/  | /' <<< "${rows}" >&2; fail "${step}: the resume has no fresh provenance get after its status"; }
        call_line=3
    fi
    IFS=$'\t' read -r c_pos c_time _ c_verb _ c_args <<< "$(sed -n "${call_line}p" <<< "${rows}")"
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
    # find-missing. The own-id persona's retry is one fresh provenance `get`
    # then one `resume` after the find-missing. The pane-not-found persona's is one run
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
        [[ -z "${spawns}" && "$(field_of 4 "${r_rows}" | head -n 2 | tr '\n' ' ')" == "get resume " ]] \
            || { sed 's/^/  | /' <<< "${r_rows}" >&2; fail "${step}: the retry after the find-missing is not one fresh provenance get then one resume"; }
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


# check_no_cscb_find_missing <step> <from-mark> <to-mark> <window>: the
# agent-director shim's log holds no CSCB find-missing in the window (named
# <window> in the messages). A find-missing carries no instance id, so a
# window holding only still-latched rounds is checked whole.
check_no_cscb_find_missing() {
    local step="$1" from="$2" to="$3" window="$4" rows
    rows="$(ad_cscb_verb_between find-missing "${from}" "${to}")" || exit 1
    if [[ -n "${rows}" ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: $(rows_count "${rows}") CSCB find-missing call(s) ${window} (shim marks ${from} to ${to}), where every round is still latched"
    fi
    echo "${TEST_NAME}: ${step}: no CSCB find-missing ${window} (shim marks ${from} to ${to})"
}

p2_checks() {
    local key rows found verb n from=0
    # From the last latch to the batched round's clearing event every Part 2
    # persona's rounds are still latched: no CSCB find-missing in that window.
    for key in "${P2_KEYS[@]}"; do
        (( LATCH_MARK[${key}] <= from )) || from="${LATCH_MARK[${key}]}"
    done
    check_no_cscb_find_missing "part 2: the still-latched rounds before the batched clearing event" "${from}" "${BATCH_EVENT_MARK}" \
        "from the last latch to the batched round's clearing event"
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
    # Exercise both sides of the flag reader without an automatic startup answer.
    round_call_is "${CALL_PROBE}" read-pane '--n-lines 1' || fail "part 2: ordinary outcome probe rejected"
    if round_call_is "${CALL_PROBE}" read-pane '--n-lines 1 --allow-pending'; then
        fail "part 2: ordinary outcome probe accepted --allow-pending"
    fi

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
# CSCB-parented; at least one run in the loop's log since Part 2's loop
# started (the log is shared with Part 1's loop); and the harness ran no
# find-missing before the loop. Sets LOOP_FIRST_POS.
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
    runs=$(( $(find_missing_loop_runs) - P2_LOOP_RUNS_BEFORE ))
    (( runs > 0 )) || fail "${step}: the loop's log holds no run of Part 2's loop (${P2_LOOP_RUNS_BEFORE} run(s) of Part 1's before it)"
    echo "${TEST_NAME}: ${step}: ${runs} run(s) of Part 2's loop logged, ${n} find-missing line(s) parented by the loop, the first at shim line ${LOOP_FIRST_POS}, after leg 2's end (mark ${END_MARK}); none CSCB's; ${cscb_after} CSCB find-missing call(s) since (recorded)"
}

check_nothing_typed() {
    local key="$1" step="part 2: $1's relabelled session: nothing typed" target rows hits n=0 ctl=0
    for target in "${SEED_PANE[${key}]}" "${SEED_WID[${key}]}" "${SEED_SID[${key}]}" "${PERSONA_NAMED[${key}]}"; do
        rows="$(tmux_shim_targets "${target}" "${LATCH_LIFE_TMUX_MARK}" "${EVENT_TMUX_MARK[${key}]}")" || exit 1
        hits="$([[ -z "${rows}" ]] || awk -F'\t' '$4 == "send-keys" || $4 == "send-prefix" || $4 == "paste-buffer"' <<< "${rows}")"
        if [[ -n "${hits}" ]]; then
            sed 's/^/  | /' <<< "${hits}" >&2
            n=$(( n + $(rows_count "${hits}") ))
        fi
    done
    (( n == 0 )) || fail "${step}: ${n} tmux call(s) typed into ${SEED_PANE[${key}]} (${SEED_WID[${key}]}, ${SEED_SID[${key}]}, ${PERSONA_NAMED[${key}]}) in the latch life"
    echo "${TEST_NAME}: ${step}: no tmux typing reached ${SEED_PANE[${key}]} in the latch life up to its event"
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
# round: one `status`, one finished-row `get`, one fresh provenance `get`,
# then one `resume`, at the cadence, its
# status after the loop's first find-missing; advances CALL_I and PREV_US.
relabel_retry_round() {
    local step="$1" key="$2" i="${CALL_I}"
    if [[ "${CALL_VERB[i]:-}" != status || "${CALL_VERB[i + 1]:-}" != get || "${CALL_VERB[i + 2]:-}" != get || "${CALL_VERB[i + 3]:-}" != resume ]]; then
        calls_of "${key}" "${FREE_MARK[${key}]}"
        fail "${step}: the round after the row read missing is '${CALL_VERB[i]:-} ${CALL_VERB[i + 1]:-} ${CALL_VERB[i + 2]:-} ${CALL_VERB[i + 3]:-}', not status, get, get, resume"
    fi
    (( CALL_POS[i] > LOOP_FIRST_POS )) \
        || fail "${step}: the finished-row retry's status (shim line ${CALL_POS[i]}) is not after the loop's first find-missing (${LOOP_FIRST_POS})"
    check_cadence "${step}: the finished-row retry (get)" "${PREV_US[${key}]}" "${CALL_US[i]}" "${CALL_US[i + 1]}" get
    (( CALL_US[i + 3] - CALL_US[i] <= SETTLE_S * 1000000 )) \
        || fail "${step}: the finished-row retry's resume came $(secs_of $(( CALL_US[i + 3] - CALL_US[i] ))) s after its status, more than the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: the finished-row retry: status at shim line ${CALL_POS[i]}, get at ${CALL_POS[i + 1]}, provenance get at ${CALL_POS[i + 2]}, resume at ${CALL_POS[i + 3]}"
    PREV_US[${key}]="${CALL_US[i]}"
    CALL_I=$(( i + 4 ))
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
        if [[ "${CALL_VERB[CALL_I]}" != status || "${CALL_VERB[CALL_I + 1]:-}" != get || "${CALL_VERB[CALL_I + 2]:-}" != resume ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: a round after the relatch is '${CALL_VERB[CALL_I]} ${CALL_VERB[CALL_I + 1]:-} ${CALL_VERB[CALL_I + 2]:-}', not status, get, resume"
        fi
        check_cadence "${step}: a round of the new case" "${PREV_US[${key}]}" "${CALL_US[CALL_I]}" "${CALL_US[CALL_I + 2]}" "${CALL_RESUME}"
        PREV_US[${key}]="${CALL_US[CALL_I]}"
        CALL_I=$(( CALL_I + 3 ))
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

# check_relabel_marked <key>: from the legs' events (RELABEL_EVENTS_MARK) to
# the harness read that showed the leg's row `missing` (MISSING_MARK), a
# window holding only still-latched rounds: no CSCB find-missing in it, and
# the harness's loop marked the row (at least one of its find-missing lines
# in it); every find-missing line in it is logged with whose it was.
check_relabel_marked() {
    local key="$1" step="part 2: $1's row marked missing" fm pos ppid role marked="" loop=0
    check_no_cscb_find_missing "${step}" "${RELABEL_EVENTS_MARK}" "${MISSING_MARK[${key}]}" \
        "from the legs' events to the harness read showing ${PERSONA_ID[${key}]} missing"
    fm="$(shim_verb_rows find-missing)" || exit 1
    while IFS=$'\t' read -r pos _ ppid role; do
        [[ -n "${pos}" ]] || continue
        (( pos > RELABEL_EVENTS_MARK && pos <= MISSING_MARK[${key}] )) || continue
        if [[ "${ppid}" == "${FIND_MISSING_LOOP_PID}" ]]; then
            loop=$(( loop + 1 ))
            marked+="${marked:+, }shim line ${pos} (the harness's loop)"
        elif [[ "${role}" != - ]]; then
            marked+="${marked:+, }shim line ${pos} (CSCB's ${role})"
        else
            marked+="${marked:+, }shim line ${pos} (the harness)"
        fi
    done <<< "${fm}"
    (( loop > 0 )) \
        || fail "${step}: no find-missing of the harness's loop (${FIND_MISSING_LOOP_PID}) from the legs' events (shim mark ${RELABEL_EVENTS_MARK}) to the read showing ${PERSONA_ID[${key}]} missing (mark ${MISSING_MARK[${key}]}); find-missing lines there: ${marked:-none}"
    echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]} marked missing by the harness's loop; the find-missing lines from the legs' events to the harness read: ${marked}"
}

# latch_state_of <key>: print `latched` when the persona's last conflict-latch
# set or clear line in server.log is a latch-set or relatch line, `cleared`
# when it is a clear line, `none` when it has neither (the heads cut from the
# package's conflictLatchSetLine and latchClearedLine at their ` — `).
latch_state_of() {
    local key="$1" step="end: $1's latch" set_head re_head clear_head last
    set_head="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" SESSIONSLOT "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    re_head="$(fmk_text conflictLatchSetLine "${key}" "${CASE_OF[${key}]}" SESSIONSLOT "${OP_OF[${key}]}" "${LATCH_ROW_OF[${key}]}" "${CASE_OF[${key}]}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    clear_head="$(fmk_text latchClearedLine "${key}" "${CASE_OF[${key}]}" SESSIONSLOT posted LATCH_RECOVERY_REASON_ROW_GONE)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    set_head="${set_head%% — *} — "
    re_head="${re_head%% — *} — "
    clear_head="${clear_head%% — *} — "
    [[ "${set_head}" == *"=${key} latched — " && "${re_head}" == *"=${key} relatched — " && "${clear_head}" == *"=${key} cleared — " ]] \
        || fail "${step}: the heads '${set_head}', '${re_head}' and '${clear_head}' are not ${key}'s latch, relatch and clear"
    last="$(grep -F -e "${set_head}" -e "${re_head}" -e "${clear_head}" "${SLACK_STATE_DIR}/server.log" | tail -n 1)" || true
    if [[ -z "${last}" ]]; then
        echo none
    elif [[ "${last}" == *"${clear_head}"* ]]; then
        echo cleared
    else
        echo latched
    fi
}

# p2_relabel_checks: the legs' and the loop's checks, from the logs.
p2_relabel_checks() {
    local key
    check_loop_runs
    for key in "${P2_RELABEL_KEYS[@]}"; do
        check_relabel_marked "${key}"
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
p1_note_release
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

# The unusable recorded name's rounds to the end: right after its next round
# (so no round is in flight), its snapshot, then the round checker over its
# whole latched span (each round one status alone, at the cadence, and its
# latch's notice the only post).
n="$(count_log "${STILL_LINE[${UN_KEY}]}")"
wait_rounds end "${UN_KEY}" "${STILL_LINE[${UN_KEY}]}" $(( n + 1 )) 1
n="$(count_log "${STILL_LINE[${UN_KEY}]}")"
free_snapshot "${UN_KEY}" "${n}"
check_latched_rounds "${UN_KEY}" end

# A plain stop, then the closing assertions. The persona still latched keeps
# its row; every row is present.
stop_server
sed "s/^/${TEST_NAME}: end: stop said: /" "${STOP_OUT}"
for key in "${P2_KEYS[@]}"; do
    read_row "end" "${PERSONA_ID[${key}]}"
    [[ -n "${ROW_STATE}" ]] || fail "end: ${PERSONA_ID[${key}]} has no row at the end"
    echo "${TEST_NAME}: end: ${PERSONA_ID[${key}]} is present, reading ${ROW_STATE}"
done
# The personas still latched keep their rows (above) and sessions: the
# unusable recorded name and leg 1 stay latched to the end; "launch start not
# recorded" is checked when its retry left it latched (what the retry met is
# ruling S8's). Leg 1's and "launch start not recorded"'s sessions, never
# ended by the harness, still run under their names; the unusable recorded
# name had no session at its latch (its worker ended in the set-up stop), and
# none was made for it.
for key in "${UN_KEY}" "${R1_KEY}" "${NS_KEY}"; do
    state="$(latch_state_of "${key}")" || exit 1
    if [[ "${key}" != "${NS_KEY}" ]]; then
        [[ "${state}" == latched ]] || { latch_lines_of "${key}"; fail "end: ${key}'s last conflict-latch line reads ${state}, not a latch"; }
    elif [[ "${state}" != latched ]]; then
        echo "${TEST_NAME}: end: [S8, recorded] ${key} is not latched at the end (its last conflict-latch line reads ${state})"
        continue
    fi
    if [[ "${key}" == "${UN_KEY}" ]]; then
        session_gone "${PERSONA_NAMED[${key}]}" \
            || fail "end: a session named ${PERSONA_NAMED[${key}]} runs for the latched ${key}, though none was there at its latch"
        echo "${TEST_NAME}: end: ${key} is still latched; its row is present and no session was made for it"
    else
        has_session_id "${SEED_SID[${key}]}" || fail "end: the latched ${key}'s session ${SEED_SID[${key}]} is gone"
        sid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${PERSONA_NAMED[${key}]}:" '#{session_id}' 2> /dev/null)" || sid=""
        [[ "${sid}" == "${SEED_SID[${key}]}" ]] \
            || fail "end: ${PERSONA_NAMED[${key}]} is held by '${sid}', not the latched ${key}'s session ${SEED_SID[${key}]}"
        echo "${TEST_NAME}: end: ${key} is still latched; its row is present and its session ${PERSONA_NAMED[${key}]} (${SEED_SID[${key}]}) still runs"
    fi
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
