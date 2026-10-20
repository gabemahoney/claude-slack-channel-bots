#!/usr/bin/env bash
# AD outcome and lifecycle regression checks; no startup TUI interpretation.
set -euo pipefail

TEST_NAME="test-18-fmk-wedged"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T18_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t18_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t18_value() {
    local -n t18_value_out="$1"
    shift
    t18_value_out="$(bun "${T18_PRINTER}" "$@")" || fail "the value printer failed for $*"
}

# t18_whole <var> <entry>: as t18_value, for a whole number.
t18_whole() {
    t18_value "$1" "$2"
    local -n t18_whole_out="$1"
    [[ "${t18_whole_out}" =~ ^[1-9][0-9]*$ ]] || fail "setup: $2 '${t18_whole_out}' is not a whole number"
}

t18_whole KILL_TRIES KILL_RETRY_TRIES
t18_whole SPACING_MS KILL_RETRY_SPACING_MS
t18_whole CALL_TIMEOUT_MS DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
t18_whole THRESHOLD_MS adAlertThresholdMs.default
t18_whole RETRY_BASE_S UNAVAILABLE_RETRY_BASE_S
t18_whole RETRY_CEILING_S UNAVAILABLE_RETRY_CEILING_S
t18_whole ENTER_DELAY_MS ENTER_DELAY_MS
t18_whole ONSET_FLOOR_MS TMUX_UNRESPONSIVE_ONSET_FLOOR_MS
t18_value SVC_LABEL SERVICE_LABEL
t18_value SUMMARY_HEAD startSweepSummaryLine.head
t18_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX
t18_value CAP_NOTICE restartCapReachedNoticeText
t18_value CAP_STOP_REASON UNAVAILABLE_RETRY_STOP_CAPPED
t18_value TAIL_AGAIN killRetryTryLine.tail KILL_RETRY_NEXT_AGAIN
t18_value TAIL_EXHAUSTED killRetryTryLine.tail KILL_RETRY_NEXT_EXHAUSTED
t18_value TAIL_BUDGET_SPENT killRetryTryLine.tail KILL_RETRY_NEXT_BUDGET_SPENT

# The restart cap's line (src/restart.ts countLaunchFailure, which has no
# exported builder): `[slack] Cap reached for persona=<key> — notifying and
# stopping restarts`; its fixed fragment up to the key.
CAP_REACHED_HEAD='[slack] Cap reached for persona='

THRESHOLD_S=$(( THRESHOLD_MS / 1000 ))

# ---------------------------------------------------------------------------
# Bounds (seconds)
# ---------------------------------------------------------------------------

# A live start's start pass completing (setup, in `log`).
START_WAIT_S=120
# A launched persona's row reporting in (`waiting`).
ROW_WAIT_S=120
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# A persona's first refusal after the wedged start's sweep has ended: its
# start pass's calls, each bounded by CSCB's call timeout.
REFUSAL_WAIT_S=$(( 4 * CALL_TIMEOUT_MS / 1000 + 60 ))
# Past a persona's alert threshold, how long its alert may take to post.
ALERT_SLACK_S=120
# Past one retry interval after the unwedge, how long a recovery may take
# (the retry's own calls).
RECOVERY_SLACK_S=$(( 2 * CALL_TIMEOUT_MS / 1000 + 60 ))

# ---------------------------------------------------------------------------
# Personas: each with its own key, credentials, channel and directories
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
CFG_ROOT="${SCENARIO_ROOT}/claude-config"
mkdir -m 700 "${CREDS_DIR}"
mkdir -p "${CFG_ROOT}"

# t18_persona <prefix> <short> <channel>: set <prefix>_NAME, _LABEL,
# _CHANNEL, _WORK, _CFG, _KEY and _ID for one persona.
t18_persona() {
    local p="$1" short="$2" channel="$3" key id work
    printf -v "${p}_NAME" '%s' "${SCENARIO_TAG}${short}"
    printf -v "${p}_LABEL" '%s' "${SCENARIO_TAG}${short}1"
    printf -v "${p}_CHANNEL" '%s' "${channel}"
    work="$(make_workdir "${SCENARIO_TAG}${short}_work")"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    printf -v "${p}_WORK" '%s' "${work}"
    printf -v "${p}_CFG" '%s' "${CFG_ROOT}/${SCENARIO_TAG}${short}_cfg"
    key="$(persona_key "${SCENARIO_TAG}${short}")"
    printf -v "${p}_KEY" '%s' "${key}"
    t18_value id personaInstanceId "${key}"
    printf -v "${p}_ID" '%s' "${id}"
}

t18_persona A wedgeda C0T18WGA1
t18_persona B wedgedb C0T18WGB1
t18_persona X1 absentone C0T18ABS1
t18_persona X2 absenttwo C0T18ABS2
t18_persona X3 absentthree C0T18ABS3
KEPT=(A B)
ABSENT=(X1 X2 X3)

for t18_p in "${KEPT[@]}" "${ABSENT[@]}"; do
    t18_label_var="${t18_p}_LABEL"
    t18_cfg_var="${t18_p}_CFG"
    t18_work_var="${t18_p}_WORK"
    mkdir -p "${!t18_cfg_var}"
    stub_mode "${!t18_work_var}" "${STUB_MODE_AT_ONCE}"
    t18_bot="$(fake_token bot "${!t18_label_var}")"
    t18_app="$(fake_token app "${!t18_label_var}")"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "${t18_bot}" "${t18_app}" \
        | write_file "${CREDS_DIR}/${!t18_label_var}.json" 600
done

# t18_persona_json <prefix>: one persona entry: its credentials file, working
# directory, claude_config_dir and one channel, which also takes its
# permission prompts (its destination).
t18_persona_json() {
    local n="$1_NAME" l="$1_LABEL" w="$1_WORK" c="$1_CFG" ch="$1_CHANNEL"
    printf '{"name": "%s", "credentials_file": "%s", "working_directory": "%s", "claude_config_dir": "%s", "channels": [{"id": "%s", "delivery": "all"}], "permission_prompts": "%s"}' \
        "${!n}" "${CREDS_DIR}/${!l}.json" "${!w}" "${!c}" "${!ch}" "${!ch}"
}

# t18_write_config <prefix>...: the operator's config.json holding these
# personas, with `health_check_interval` 0.
t18_write_config() {
    local joined="" p
    for p in "$@"; do
        joined+="${joined:+, }$(t18_persona_json "${p}")"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF
}

# ---------------------------------------------------------------------------
# The Slack stub (one for the script)
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
python3 - "${A_LABEL}" "${B_LABEL}" "${X1_LABEL}" "${X2_LABEL}" "${X3_LABEL}" << 'EOF' | write_file "${STUB_DIR}/control.json"
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
# Reading the rows, the logs, the record and the times
# ---------------------------------------------------------------------------

# t18_row_state <id>: print the row's state (a harness `status`), or nothing
# when the read fails.
t18_row_state() {
    ad_capture status --instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t18_row_is() {
    [[ "$(t18_row_state "$1")" == "$2" ]]
}

# t18_row_get <id> <step>: a harness `get` of the row (AD_OUT holds it); fail
# when it fails.
t18_row_get() {
    ad_capture get --instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "$2: harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
}

# t18_lines <file>: how many lines <file> has (0 when missing).
t18_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t18_after <file> <line>: <file>'s lines after line <line>.
t18_after() {
    [[ -f "$1" ]] || return 0
    tail -n "+$(( $2 + 1 ))" "$1"
}

# t18_log_after <matcher>: server.log's lines after the mark that match.
t18_log_after() {
    local tmp="${SCENARIO_ROOT}/log-after.tmp"
    t18_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" > "${tmp}"
    LC_ALL=C awk -v sep="${SCENARIO_SEP}" -v m="$1" '
        BEGIN { n = split(m, frags, sep) }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            print
        }' "${tmp}"
}

# t18_count_log_after <matcher>: how many server.log lines after the mark match.
t18_count_log_after() {
    local tmp="${SCENARIO_ROOT}/log-after.tmp"
    t18_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" > "${tmp}"
    count_in "${tmp}" "$1"
}

t18_log_after_at_least() {
    (( $(t18_count_log_after "$1") >= $2 ))
}

# t18_epoch <iso>: print <iso> as seconds since the epoch, with milliseconds.
t18_epoch() {
    date -u -d "$1" +%s.%3N || fail "could not read the time '$1'"
}

# t18_line_time <line>: the time a server.log line carries (its leading
# `[<ISO>] `, src/logging.ts), in seconds since the epoch.
t18_line_time() {
    local iso="${1#\[}"
    iso="${iso%%\]*}"
    t18_epoch "${iso}"
}

# t18_gt <a> <b>: true when the decimal <a> is greater than <b>.
t18_gt() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 > b + 0) }'
}

# t18_diff <a> <b>: print <a> - <b>, with three decimals.
t18_diff() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", a - b }'
}

# t18_mark: the wedged start's mark: the time, and the lines server.log and
# the Slack stub's record hold.
t18_mark() {
    MARK_TIME="${EPOCHREALTIME/,/.}"
    MARK_LOG="$(t18_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_RECORD="$(t18_lines "${STUB_RECORD}")"
}

# t18_cscb_calls_since <time> <verb> [<fragment>...]: CSCB's agent-director
# calls of <verb> (any verb when empty) holding every fragment, made at or
# after <time>.
t18_cscb_calls_since() {
    local since="$1" out
    shift
    out="$(cscb_ad_calls "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    awk -F'\t' -v t="${since}" '$2 + 0 >= t + 0' <<< "${out}"
}

# t18_cscb_count_since <time> <verb> [<fragment>...]
t18_cscb_count_since() {
    local out
    out="$(t18_cscb_calls_since "$@")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

# t18_first_call_time <time> <verb> [<fragment>...]: the time of the first
# such call; empty when none.
t18_first_call_time() {
    local out
    out="$(t18_cscb_calls_since "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    head -n 1 <<< "${out}" | cut -f 2
}

# t18_note_calls <time> <id> <step>: log how many CSCB calls of each verb
# named <id> at or after <time>.
t18_note_calls() {
    local out summary
    out="$(t18_cscb_calls_since "$1" "" "$2")" || exit 1
    summary="$(awk -F'\t' '
        {
            n = split($6, w, " ")
            for (i = 1; i <= n; i++) {
                if (w[i] == "--store-path" || w[i] == "--home" || w[i] == "--tmux-command") { i++; continue }
                c[w[i]]++
                break
            }
        }
        END { for (v in c) printf "%s=%d\n", v, c[v] }' <<< "${out}" | sort | tr '\n' ' ')"
    echo "${TEST_NAME}: NOTE: ${3}: CSCB calls naming $2 after the wedged start: ${summary:-none}"
}

# t18_posts: the Slack stub's chat.postMessage records after the mark, one
# JSON per line. The stub may be writing its last line: a line that does not
# parse (torn) is skipped, so a read never ends the script without a FAIL
# line; a later read finds it whole.
t18_posts() {
    t18_after "${STUB_RECORD}" "${MARK_RECORD}" \
        | jq -R -c 'fromjson? // empty | select(.event == "api" and .method == "chat.postMessage")'
}

# t18_post_times <channel> <text>: the times (seconds since the epoch) of the
# posts after the mark at <channel> (any channel when empty) whose text is
# <text> exactly, one per line.
t18_post_times() {
    local iso
    while IFS= read -r iso; do
        [[ -n "${iso}" ]] && t18_epoch "${iso}"
    done < <(t18_posts | jq -r --arg c "$1" --arg t "$2" 'select(($c == "" or .channel == $c) and .text == $t) | .ts')
}

# t18_count_posts <channel> <text>: posts after the mark at <channel> (any
# channel when empty) whose text is <text> exactly.
t18_count_posts() {
    t18_posts | jq -s --arg c "$1" --arg t "$2" '[.[] | select(($c == "" or .channel == $c) and .text == $t)] | length'
}

t18_post_arrived() {
    (( $(t18_count_posts "$1" "$2") >= 1 ))
}

# t18_count_posts_holding <fragment>: posts after the mark whose text holds <fragment>.
t18_count_posts_holding() {
    t18_posts | jq -s --arg f "$1" '[.[] | select((.text // "") | contains($f))] | length'
}

# t18_note_posts <channel> <step>: log every post at <channel> after the mark.
t18_note_posts() {
    local line
    while IFS= read -r line; do
        echo "${TEST_NAME}: NOTE: ${2}: a post at ${1}: ${line}"
    done < <(t18_posts | jq -r --arg c "$1" 'select(.channel == $c) | "\(.ts) \(.text | gsub("\n"; " "))"')
}

# ---------------------------------------------------------------------------
# Setup: every persona launched in `log` and reported in
# ---------------------------------------------------------------------------

t18_reconnect_identity() {
    local session pane
    t18_row_get "$1" "$2"
    session="$(jq -er '.tmux_session_name | select(type == "string" and length > 0)' "${AD_OUT}")" \
        || fail "$2: the reported fixture has no tmux session name"
    _scenario_tmux_check "$2: fixture identity"
    pane="$(_scenario_tmux display-message -p -t "$(_scenario_session_target "${session}"):" '#{session_id} #{pane_id} #{pane_pid}')" \
        || fail "$2: cannot read the fixture's pane identity"
    [[ "${pane}" =~ ^\$[0-9]+\ %[0-9]+\ [1-9][0-9]*$ ]] \
        || fail "$2: the fixture has incomplete pane identity"
    jq -ce --arg pane "${pane}" '[.session_id, .tmux_session_name, .tmux_socket, .jsonl_path, $pane] |
        select(all(.[]; type == "string" and length > 0))' "${AD_OUT}" \
        || fail "$2: the reported fixture has incomplete identity"
}

t18_setup() {
    local step="setup" m before p id_var identity
    tmux_shim_mode log
    t18_write_config "${KEPT[@]}" "${ABSENT[@]}"
    m="$(completion_match 5)" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    for p in "${KEPT[@]}" "${ABSENT[@]}"; do
        id_var="${p}_ID"
        wait_until "${ROW_WAIT_S}" "${step}: ${!id_var} never reported in (waiting)" t18_row_is "${!id_var}" waiting
        identity="$(t18_reconnect_identity "${!id_var}" "${step}")" || exit 1
        printf -v "${p}_IDENTITY" '%s' "${identity}"
    done

    # The operator: a plain stop (every worker keeps running and every row
    # stays live), X1 to X3 removed from config.json, and the last-applied
    # record moved aside, so the next start applies config.json as it stands.
    stop_server
    for p in "${KEPT[@]}" "${ABSENT[@]}"; do
        id_var="${p}_ID"
        t18_row_is "${!id_var}" waiting \
            || fail "${step}: ${!id_var} reads '$(t18_row_state "${!id_var}")' after the plain stop, not waiting"
    done
    t18_write_config "${KEPT[@]}"
    local record="${SLACK_STATE_DIR}/config.json${LAST_APPLIED_SUFFIX}"
    if [[ -e "${record}" ]]; then
        mv -- "${record}" "${record}.aside" || fail "${step}: could not move ${record} aside"
    fi
}

# ---------------------------------------------------------------------------
# Section 1: the start sweep under `wedge` (AC 56)
# ---------------------------------------------------------------------------

t18_sweep_section() {
    local step="start sweep under wedge" p id_var bound_ms sweep_wait_s summary want n first first_t t
    local list_t summary_t duration first_id="" later=() head id
    local ids=()
    for p in "${ABSENT[@]}"; do
        id_var="${p}_ID"
        ids+=("${!id_var}")
    done

    # The bound (AC 56): one row's KILL_RETRY_TRIES tries and the waits between
    # them, plus one try per later row, each try bounded by CSCB's call timeout.
    bound_ms=$(( (KILL_TRIES + ${#ids[@]} - 1) * CALL_TIMEOUT_MS + (KILL_TRIES - 1) * SPACING_MS ))
    # The wait for the summary line: the bound, plus the sweep's `list`, the
    # reads between the first row's tries and its findMissing run, each
    # bounded by the call timeout.
    sweep_wait_s=$(( (bound_ms + (KILL_TRIES + 1) * CALL_TIMEOUT_MS) / 1000 + 30 ))

    t18_mark
    tmux_shim_mode wedge
    start_server --live
    wait_until "${sweep_wait_s}" "${step}: the start sweep never logged its summary line" \
        t18_log_after_at_least "${SUMMARY_HEAD}" 1

    # The summary: 5 listed, none killed, 5 kept with 3 kills failed, 3 keys
    # recorded as retired, none left for a latch.
    t18_value want startSweepSummaryLine 5 0 5 3 3 0
    n="$(t18_count_log_after "${SUMMARY_HEAD}")"
    if [[ "${n}" != 1 || "$(t18_count_log_after "${want}")" != 1 ]]; then
        t18_log_after "${SUMMARY_HEAD}" | sed 's/^/  | /' >&2
        fail "${step}: ${n} start-sweep summary line(s), not one reading: ${want}"
    fi
    summary="$(t18_log_after "${SUMMARY_HEAD}")"

    # The first swept row: the X row CSCB killed first.
    first_t=""
    for id in "${ids[@]}"; do
        t="$(t18_first_call_time "${MARK_TIME}" kill "${id}")"
        [[ -n "${t}" ]] || fail "${step}: no CSCB kill of ${id} after the wedged start"
        if [[ -z "${first_t}" ]] || t18_gt "${first_t}" "${t}"; then
            first_t="${t}"
            first_id="${id}"
        fi
    done
    for id in "${ids[@]}"; do
        [[ "${id}" == "${first_id}" ]] || later+=("${id}")
    done
    echo "${TEST_NAME}: ${step}: the first swept row is ${first_id}"

    # Its KILL_RETRY_TRIES kills: a per-try line for each, "try again" until
    # the last, which has no tries left.
    n="$(t18_cscb_count_since "${MARK_TIME}" kill "${first_id}")"
    [[ "${n}" == "${KILL_TRIES}" ]] || fail "${step}: ${n} CSCB kill(s) of the first swept row ${first_id}, not ${KILL_TRIES}"
    for (( t = 1; t <= KILL_TRIES; t++ )); do
        t18_value head killRetryTryLine.head "${first_id}" "${t}" "${KILL_TRIES}"
        if (( t < KILL_TRIES )); then
            n="$(t18_count_log_after "$(matcher "${head}" "${TAIL_AGAIN}")")"
        else
            n="$(t18_count_log_after "$(matcher "${head}" "${TAIL_EXHAUSTED}")")"
        fi
        [[ "${n}" == 1 ]] || fail "${step}: ${n} per-try line(s) for try ${t} of ${KILL_TRIES} of ${first_id}, not 1"
    done
    echo "${TEST_NAME}: NOTE: ${step}: status reads between ${first_id}'s tries: $(t18_cscb_count_since "${MARK_TIME}" status "${first_id}")"

    # Every later swept row: one kill, its one per-try line saying the pass's
    # retries are spent.
    for id in "${later[@]}"; do
        n="$(t18_cscb_count_since "${MARK_TIME}" kill "${id}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} CSCB kill(s) of the later swept row ${id}, not 1"
        t18_value head killRetryTryLine.head "${id}" 1 1
        n="$(t18_count_log_after "$(matcher "${head}" "${TAIL_BUDGET_SPENT}")")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} per-try line(s) of ${id} saying the pass's retries are spent, not 1"
    done

    # The sweep's duration: from its CSCB `list` (the one carrying the
    # `service` label) to its summary line.
    list_t="$(t18_first_call_time "${MARK_TIME}" list "${SVC_LABEL}")"
    [[ -n "${list_t}" ]] || fail "${step}: no CSCB list carrying ${SVC_LABEL} after the wedged start"
    summary_t="$(t18_line_time "${summary}")"
    duration="$(t18_diff "${summary_t}" "${list_t}")"
    echo "${TEST_NAME}: ${step}: the sweep took ${duration} s from its list to its summary line (bound $(( bound_ms / 1000 )) s: ${KILL_TRIES} tries and $(( KILL_TRIES - 1 )) waits of ${SPACING_MS} ms for the first row, 1 try for each of ${#later[@]} later row(s), each try at most ${CALL_TIMEOUT_MS} ms)"
    ! t18_gt "${duration}" "$(( bound_ms / 1000 ))" || fail "${step}: the sweep took ${duration} s, over its bound of $(( bound_ms / 1000 )) s"
    t18_gt "${summary_t}" "${list_t}" || fail "${step}: the summary line (${summary_t}) is not after the sweep's list (${list_t})"

    # No delete; every X row present.
    n="$(t18_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the wedged start"
    for id in "${ids[@]}"; do
        t18_row_get "${id}" "${step}"
        echo "${TEST_NAME}: ${step}: ${id}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
    done
}

# ---------------------------------------------------------------------------
# Section 2: the condition, the alert and the recovery
# ---------------------------------------------------------------------------

# t18_first_refusal <prefix> <step>: set <prefix>_REFUSAL_AT to the time of
# the persona's `tmux-unresponsive` started line after the mark (its first
# refusal); fail unless there is exactly one.
t18_first_refusal() {
    local key_var="$1_KEY" head n line
    t18_value head tmuxUnresponsiveStartedLine.head "${!key_var}"
    n="$(t18_count_log_after "${head}")"
    [[ "${n}" == 1 ]] || fail "$2: ${n} tmux-unresponsive started line(s) for ${!key_var}, not 1"
    line="$(t18_log_after "${head}")"
    printf -v "$1_REFUSAL_AT" '%s' "$(t18_line_time "${line}")"
    echo "${TEST_NAME}: $2: ${line}"
}

# t18_texts <prefix>: set <prefix>_ONSET, _ALERT and _RECOVERY to the posted
# texts: the persona notifier's prefix, then the printer's body.
t18_texts() {
    local n="$1_NAME" k="$1_KEY" prefix body
    t18_value prefix personaNoticePrefix "${!n}"
    t18_value body tmuxUnresponsiveOnsetText "${!k}"
    printf -v "$1_ONSET" '%s' "${prefix}${body}"
    t18_value body tmuxUnresponsiveAlertText "${!k}"
    printf -v "$1_ALERT" '%s' "${prefix}${body}"
    t18_value body tmuxUnresponsiveRecoveryText "${!k}"
    printf -v "$1_RECOVERY" '%s' "${prefix}${body}"
}

t18_reconnect_submitted() {
    local events
    events="$(ad_trail_events ad.send_keys.called "$1")" || return 1
    jq -e -s --argjson server "${SERVER_PID}" --argjson since "$2" '
        any(.[]; .caller_pid == $server and .outcome == "ok" and
            ((.ts | (.[0:19] + "Z" | fromdateiso8601) + (("0." + .[20:23]) | tonumber)) + 0.001 >= $since))
    ' <<< "${events}" > /dev/null
}

# Select both audit streams through the same successful Enter. The mark is
# taken before clearing the fault, so post-mark Enters can still be refused.
t18_reconnect_window() {
    local step="$1" server="$2" mark="$3" calls="$4" outcomes="$5" first_key selected count
    first_key="$(awk -F '\t' '$4 == "send-keys" { print $2; exit }' <<< "${calls}")"
    [[ -n "${first_key}" ]] || fail "${step}: reconnect has no originating key"
    selected="$(jq -c -s --argjson since "${first_key}" --argjson server "${server}" '
        map(select(.caller_pid == $server and
            ((.ts | (.[0:19] + "Z" | fromdateiso8601) + (("0." + .[20:23]) | tonumber)) + 0.001 >= $since))) |
        (map(.outcome == "ok") | index(true)) as $ok |
        if $ok == null then [] else .[0:($ok + 1)] end
    ' <<< "${outcomes}")" || fail "${step}: cannot decode AD reconnect outcomes"
    count="$(jq 'length' <<< "${selected}")"
    (( count >= 2 )) || fail "${step}: reconnect has no successful Enter after its originating text"
    T18_RECONNECT_CALLS="$(awk -F '\t' -v count="${count}" '
        $4 == "send-keys" { started = 1; sends++ }
        started { print }
        sends == count { exit }
    ' <<< "${calls}")"
    awk -F '\t' -v mark="${mark}" '
        $4 == "send-keys" { pos = $1; args = $6 }
        END { exit !(pos > mark && args ~ /--key Enter/) }
    ' <<< "${T18_RECONNECT_CALLS}" || fail "${step}: successful reconnect Enter is not after the unwedge mark"
    T18_RECONNECT_OUTCOMES="$(jq -c '.[]' <<< "${selected}")"
}

t18_condition_section() {
    local step="wedged condition" p head n deadline_s wait_s alert_t unwedge_t times t onset_n
    local id_var key_var ch_var at_var alert_var onset_var rec_var verb calls unwedge_mark outcomes identity_var

    # Each persona's first refusal: its condition's started line.
    for p in "${KEPT[@]}"; do
        key_var="${p}_KEY"
        t18_value head tmuxUnresponsiveStartedLine.head "${!key_var}"
        wait_until "${REFUSAL_WAIT_S}" "${step}: ${!key_var}'s tmux-unresponsive condition never started" \
            t18_log_after_at_least "${head}" 1
        t18_first_refusal "${p}" "${step}"
        t18_texts "${p}"
    done

    # `wedge` is kept until each persona's alert has posted, more than the
    # threshold after its first refusal.
    for p in "${KEPT[@]}"; do
        at_var="${p}_REFUSAL_AT"
        ch_var="${p}_CHANNEL"
        alert_var="${p}_ALERT"
        deadline_s="$(awk -v a="${!at_var}" -v s="$(( THRESHOLD_S + ALERT_SLACK_S ))" 'BEGIN { printf "%d", a + s + 1 }')"
        wait_s=$(( deadline_s - $(date +%s) ))
        (( wait_s > 0 )) || wait_s=1
        wait_until "${wait_s}" "${step}: no tmux-unresponsive alert for ${p} reached ${!ch_var} within ${ALERT_SLACK_S} s past its threshold" \
            t18_post_arrived "${!ch_var}" "${!alert_var}"
        times="$(t18_post_times "${!ch_var}" "${!alert_var}")"
        alert_t="$(head -n 1 <<< "${times}")"
        t18_gt "$(t18_diff "${alert_t}" "${!at_var}")" "${THRESHOLD_S}" \
            || fail "${step}: ${p}'s alert posted $(t18_diff "${alert_t}" "${!at_var}") s after its first refusal, not more than ${THRESHOLD_S} s"
        printf -v "${p}_ALERT_AT" '%s' "${alert_t}"
        echo "${TEST_NAME}: ${step}: ${p}'s alert posted $(t18_diff "${alert_t}" "${!at_var}") s after its first refusal"
    done

    # tmux answers again.
    unwedge_mark="$(ad_shim_mark)"
    unwedge_t="${EPOCHREALTIME/,/.}"
    tmux_shim_mode log

    # One recovery per persona, after the unwedge, within one retry interval.
    for p in "${KEPT[@]}"; do
        ch_var="${p}_CHANNEL"
        rec_var="${p}_RECOVERY"
        wait_until "$(( RETRY_CEILING_S + RECOVERY_SLACK_S ))" "${step}: no recovery for ${p} reached ${!ch_var} after the unwedge" \
            t18_post_arrived "${!ch_var}" "${!rec_var}"
    done

    for p in "${KEPT[@]}"; do
        id_var="${p}_ID"
        key_var="${p}_KEY"
        ch_var="${p}_CHANNEL"
        at_var="${p}_ALERT_AT"
        alert_var="${p}_ALERT"
        onset_var="${p}_ONSET"
        rec_var="${p}_RECOVERY"

        # An outage all-clear precedes the reconnect's Enter. Wait for both
        # key calls before inspecting their order, provenance and delay.
        wait_until "${RECOVERY_SLACK_S}" "${step}: ${p}'s reconnect never submitted" \
            t18_reconnect_submitted "${!id_var}" "${unwedge_t}"
        # Retain the originating uncertain text, every refused Enter, and
        # the successful post-unwedge Enter. A suffix of two Enters loses
        # the intent which makes those retries safe.
        calls="$(ad_cscb_calls "${!id_var}" - -)" || exit 1
        outcomes="$(ad_trail_events ad.send_keys.called "${!id_var}")" || exit 1
        t18_reconnect_window "${step}: ${p}" "${SERVER_PID}" "${unwedge_mark}" "${calls}" "${outcomes}"
        _scenario_assert_reconnect_rows "${step}: ${p}" "${SERVER_PID}" "${ENTER_DELAY_MS}" \
            "${T18_RECONNECT_CALLS}" "${T18_RECONNECT_OUTCOMES}"
        identity_var="${p}_IDENTITY"
        [[ "$(t18_reconnect_identity "${!id_var}" "${step}")" == "${!identity_var}" ]] \
            || fail "${step}: ${p}'s reconnect changed its launch/session/pane identity"

        # Exactly one alert and one recovery, the recovery after the unwedge.
        n="$(t18_count_posts "" "${!alert_var}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} tmux-unresponsive alert post(s) for ${p}, not 1"
        n="$(t18_count_posts "" "${!rec_var}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} tmux-unresponsive recovery post(s) for ${p}, not 1"
        t="$(t18_post_times "${!ch_var}" "${!rec_var}")"
        t18_gt "${t}" "${unwedge_t}" || fail "${step}: ${p}'s recovery (${t}) posted before the unwedge (${unwedge_t})"
        echo "${TEST_NAME}: ${step}: ${p}'s recovery posted $(t18_diff "${t}" "${unwedge_t}") s after the unwedge"

        # At most one onset, none after the alert (SRD over Epic: at most one).
        onset_n="$(t18_count_posts "" "${!onset_var}")"
        (( onset_n <= 1 )) || fail "${step}: ${onset_n} tmux-unresponsive onset post(s) for ${p}, not at most 1"
        while IFS= read -r t; do
            [[ -n "${t}" ]] || continue
            t18_gt "${!at_var}" "${t}" || fail "${step}: ${p}'s onset (${t}) posted after its alert (${!at_var})"
        done < <(t18_post_times "" "${!onset_var}")
        echo "${TEST_NAME}: NOTE: ${step}: ${p}'s onset posts: ${onset_n}"
        t18_first_refusal "${p}" "${step}: after the recovery"

        # No cap: no notice, no cap-reached line, no cap-skip line, no retry
        # timer stopped at the cap.
        n="$(t18_count_posts_holding "${CAP_NOTICE}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} restart-cap notice post(s)"
        n="$(t18_count_log_after "${CAP_REACHED_HEAD}${!key_var}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} cap-reached line(s) for ${!key_var}"
        t18_value head restartRetryCapSkippedLine "${!key_var}"
        n="$(t18_count_log_after "${head}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} cap-skip line(s) for ${!key_var}"

        # Calls continue after the alert.
        n="$(t18_cscb_count_since "${!at_var}" "" "${!id_var}")"
        (( n >= 1 )) || fail "${step}: no CSCB call naming ${!id_var} after its alert"
        echo "${TEST_NAME}: ${step}: ${n} CSCB call(s) naming ${!id_var} after its alert"

        # No destructive action, no reuse and no resume; the row present.
        for verb in kill delete resume; do
            n="$(t18_cscb_count_since "${MARK_TIME}" "${verb}" "${!id_var}")"
            [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB ${verb} call(s) naming ${!id_var}"
        done
        calls="$(t18_cscb_calls_since "${MARK_TIME}" spawn "${!id_var}")" || exit 1
        n="$(grep -cF -- '--reuse-finished' <<< "${calls}" || true)"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB reuse spawn(s) of ${!id_var}"
        # No relaunch: the start pass's one plain spawn (it collides and
        # routes to `get`) is the only spawn naming its id.
        n="$(t18_cscb_count_since "${MARK_TIME}" spawn "${!id_var}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} CSCB spawn(s) naming ${!id_var}, not the start pass's one (a relaunch)"
        t18_row_get "${!id_var}" "${step}"
        echo "${TEST_NAME}: ${step}: ${!id_var}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"

        t18_note_calls "${MARK_TIME}" "${!id_var}" "${step}"
        t18_note_posts "${!ch_var}" "${step}"
    done
    n="$(t18_count_log_after "${CAP_STOP_REASON}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} retry-timer stop line(s) at the restart cap"
}

t18_setup
t18_sweep_section
t18_condition_section
stop_server

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
