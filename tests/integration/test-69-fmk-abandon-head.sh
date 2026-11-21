#!/usr/bin/env bash
# b.6cg: real server/CLI, durable queue and receipt engine, stub Claude/Slack.
# Counted swallowed keys hold a threaded Slack head, then an interject head.
# No model, burst, timer override or dependency beyond universal test-1.
# Unfixed-tree proof reaches the first CLI call before reading any new export:
# abandon-message is deliberately literal operator input; unknown command exits 2.
set -euo pipefail
TEST_NAME="test-69-fmk-abandon-head"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"
value() { bun "${PRINTER}" "$@" || fail "value printer: $1"; }
NOT_TAKEN_IN="$(value MESSAGE_NOT_TAKEN_IN)"
RETYPED="$(value MESSAGE_RETYPED)"
DELIVERED="$(value MESSAGE_DELIVERED)"
NAME="${SCENARIO_TAG}abandon"
KEY="$(persona_key "${NAME}")"
REF="$(persona_ref "${NAME}")"
INSTANCE="$(value personaInstanceId "${KEY}")"
LABEL="${SCENARIO_TAG}abandon1"
SOURCE="$(scenario_id C source)"
DESTINATION="$(scenario_id C destination)"
SENDER="$(scenario_id U sender)"
WORK="$(make_workdir abandon)"
stub_mode "${WORK}" at-once
mkdir -p "${SCENARIO_ROOT}/credentials" "${HOME}/.claude"
printf '{}\n' | write_file "${HOME}/.claude/.claude.json" 600
CREDS="${SCENARIO_ROOT}/credentials/persona.json"
printf '{"bot_token":"%s","app_token":"%s"}\n' \
    "$(fake_token bot "${LABEL}")" "$(fake_token app "${LABEL}")" | write_file "${CREDS}" 600
jq -n --arg name "${NAME}" --arg creds "${CREDS}" --arg work "${WORK}" --arg cfg "${HOME}/.claude" \
    --arg source "${SOURCE}" --arg dest "${DESTINATION}" --argjson port "${SCENARIO_PORT}" \
    '{personas:[{name:$name,credentials_file:$creds,working_directory:$work,claude_config_dir:$cfg,
      channels:[{id:$source,delivery:"all"},{id:$dest,delivery:"all"}],permission_prompts:$dest}],
      bind:"127.0.0.1",port:$port,health_check_interval:0,exit_timeout:5}' | write_config

STUB="${SCENARIO_ROOT}/slack-stub"
mkdir "${STUB}"
SCENARIO_SLACK_RECORD="${STUB}/record.jsonl"
jq -n --arg token_label "${LABEL}" --arg source "${SOURCE}" --arg dest "${DESTINATION}" \
    '{tokens:[{suffix:$token_label,"label":$token_label,auth:"ok",connections:"ok",memberships:[$source,$dest]}],
      default:{auth:"invalid_auth",connections:"invalid_auth"}}' > "${STUB}/control.json"
bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
    --control "${STUB}/control.json" --ready-file "${STUB}/ready.json" > "${STUB}/out" 2>&1 &
track_pid "$!"
wait_for_file "${STUB}/ready.json" 30 'Slack stub did not start'
CSCB_SLACK_API_URL="$(jq -r .api_url "${STUB}/ready.json")"
export CSCB_SLACK_API_URL
SCENARIO_SLACK_STUB_URL="${CSCB_SLACK_API_URL%/api/}"
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN CSCB_PERSONA SLACK_DRY_RUN
start_server --live
wait_for_log "$(completion_match 1)" 120 'server startup did not complete'
wait_for_log "$(session_connected_match "${NAME}")" 30 'stub MCP did not connect'
row_waiting() {
    ad_capture get --instance-id "${INSTANCE}"
    (( AD_RC == 0 )) && jq -e '.state == "waiting"' "${AD_OUT}" > /dev/null
}
wait_until 30 'stub did not report waiting to AD' row_waiting

JOURNAL="${SLACK_STATE_DIR}/queue/${KEY}.jsonl"
FAULTS="${SCENARIO_AD_SHIM_LOG%.log}.faults"
# The harness and shim share the stable lock through count changes/replacement.
set_key_faults() {
    { flock -x 8
      if [[ "$1" == on ]]; then printf 'send-keys * swallow 999999\n'; fi > "${FAULTS}"
    } 8> "${FAULTS}.lock"
}
accepted_pair() {
    [[ -f "${JOURNAL}" ]] || return 1
    jq -e -s --arg a "$1" --arg b "$2" '
      [.[] | select(.kind=="accepted" and .compact==null)] as $items |
      ([$items[] | select(.text==$a)] | length)==1 and
      ([$items[] | select(.text==$b)] | length)==1' "${JOURNAL}" > /dev/null
}
snapshot_head() {
    jq -ce -s --arg text "$1" '[.[] | select(.kind=="accepted" and .compact==null and .text==$text)] |
      if length==1 then .[0] else error("head acceptance is not unique") end' "${JOURNAL}" > "${SCENARIO_ROOT}/head.json"
    HEAD_SEQ="$(jq -r .seq "${SCENARIO_ROOT}/head.json")"
}
blocked_head() {
    local source="$1" a="$2" b="$3" match line ts_pattern=' ts="([0-9]+\.[0-9]{6})"'
    wait_until 30 'both inputs were not durably accepted' accepted_pair "${a}" "${b}"
    match="$(matcher "[slack] ${NOT_TAKEN_IN}: persona=${REF} source=${source}")"
    # This line follows an unconfirmed retype at the production receipt deadline.
    wait_for_log "${match}" 120 'head was not retyped and reported untaken'
    line="$(sed -n "$(last_log_line "${match}")p" "${SLACK_STATE_DIR}/server.log")"
    [[ "${line}" =~ ${ts_pattern} ]] || fail 'operator log line has no head timestamp'
    HEAD_TS="${BASH_REMATCH[1]}"
    snapshot_head "${a}"
    [[ "${HEAD_TS}" == "$(jq -r .ts "${SCENARIO_ROOT}/head.json")" ]] || fail 'log timestamp identifies another item'
    (( $(cscb_ad_count send-keys "${a}") >= 2 )) || fail 'no positive control: head was not offered twice'
    [[ "$(cscb_ad_count send-keys "${b}")" == 0 ]] || fail 'successor was typed before abandonment'
    wait_for_log "$(matcher "[slack] ${RETYPED}: persona=${REF}" "ts=\"${HEAD_TS}\"")" 10 'head lacks a retype diagnostic'
    expect_count "$(matcher "[slack] ${DELIVERED}: persona=${REF}" "ts=\"${HEAD_TS}\"")" 0 'blocked head delivered'
    echo "${TEST_NAME}: ${source} head ${HEAD_TS} blocks its successor after repeated swallowed sends"
}

# Assert stdout empty and stderr exactly the production result line, newline too.
# Expected builders are read only AFTER checking the CLI exit: an unfixed tree
# fails here for unknown command (2), never earlier for an absent new export.
check_cli() {
    local want="$1" persona="$2" ts="$3" status="$4" body="$5" rc=0 expected
    cscb_run "${SCENARIO_CLI}" abandon-message "${persona}" "${ts}" < /dev/null \
        > "${SCENARIO_ROOT}/cli.stdout" 2> "${SCENARIO_ROOT}/cli.stderr" || rc=$?
    [[ "${rc}" == "${want}" ]] || fail "abandon-message exited ${rc}, expected ${want}"
    [[ ! -s "${SCENARIO_ROOT}/cli.stdout" ]] || fail 'abandon-message wrote unexpected stdout'
    expected="$(value abandonMessageReport "${status}" "${body}")"
    printf '%s\n' "${expected}" > "${SCENARIO_ROOT}/cli.expected"
    cmp -s "${SCENARIO_ROOT}/cli.expected" "${SCENARIO_ROOT}/cli.stderr" || fail 'abandon-message stderr differs from its exact result line'
}
assert_retained() {
    jq -e -s --slurpfile original "${SCENARIO_ROOT}/head.json" --argjson seq "${HEAD_SEQ}" '
      [.[] | select(.seq==$seq)] as $item |
      ([$item[] | select(.kind=="accepted")] == $original) and
      ([$item[] | select(.kind=="abandoned" and .v==1 and (.at|type)=="number")] | length)==1 and
      ([$item[] | select(.kind=="delivered")] | length)==0' "${JOURNAL}" > /dev/null \
        || fail 'journal lost accepted bytes, failed to abandon, or forged delivery'
}
notice_count() {
    jq -s --arg text "${NOTICE}" '[.[] | select(.event=="api" and .method=="chat.postMessage" and .text==$text)] | length' "${SCENARIO_SLACK_RECORD}"
}
notice_seen() { [[ "$(notice_count)" == 1 ]]; }
assert_abandoned() {
    local channel="$1" thread="$2" match line
    match="$(matcher "[slack] ${ABANDONED}: persona=${REF}" "ts=\"${HEAD_TS}\"")"
    expect_count "${match}" 1 'abandonment diagnostic is not unique'
    line="$(sed -n "$(last_log_line "${match}")p" "${SLACK_STATE_DIR}/server.log")"
    [[ "${line}" != *"${HEAD_BODY}"* && "${line}" != *'text='* ]] || fail 'abandonment diagnostic contains message text'
    wait_until 15 'abandonment notice missing or duplicated' notice_seen
    jq -e -s --arg text "${NOTICE}" --arg token_label "${LABEL}" --arg channel "${channel}" --arg thread "${thread}" '
      [.[] | select(.event=="api" and .method=="chat.postMessage" and .text==$text)] |
      length==1 and .[0]["label"]==$token_label and .[0].channel==$channel and (.[0].thread_ts // "")==$thread' \
        "${SCENARIO_SLACK_RECORD}" > /dev/null || fail 'notice used the wrong client or conversation'
    assert_retained
}
abandon_and_advance() {
    local next_body="$1" next_ts="$2" sender="$3" channel="$4" thread="$5" sends
    sends="$(cscb_ad_count send-keys "${HEAD_BODY}")"
    check_cli 0 "${KEY}" "${HEAD_TS}" 200 "$(jq -cn --arg p "${NAME}" --argjson seq "${HEAD_SEQ}" '{ok:true,persona:$p,seq:$seq}')"
    ABANDONED="$(value MESSAGE_ABANDONED)"
    if [[ "${channel}" == "${DESTINATION}" ]]; then
        NOTICE="$(value formatPersonaNotice "${NAME}" buildMessageAbandonedNotice "${REF}" "${sender}")"
    else
        NOTICE="$(value buildMessageAbandonedNotice "${REF}" "${sender}")"
    fi
    assert_abandoned "${channel}" "${thread}"
    set_key_faults off
    wait_for_log "$(matcher "[slack] ${DELIVERED}: persona=${REF}" "ts=\"${next_ts}\"")" 120 'successor did not deliver after fault release'
    (( $(cscb_ad_count send-keys "${next_body}") >= 1 )) || fail 'successor delivery has no real send'
    [[ "$(cscb_ad_count send-keys "${HEAD_BODY}")" == "${sends}" ]] || fail 'abandoned head was typed again'
    expect_count "$(matcher "[slack] ${DELIVERED}: persona=${REF}" "ts=\"${HEAD_TS}\"")" 0 'abandoned head delivered'
    expect_count "$(matcher "[slack] ${DELIVERED}: persona=${REF}" "ts=\"${next_ts}\"")" 1 'successor delivery duplicated'
    check_cli 1 "${KEY}" "${HEAD_TS}" 409 '{"reason":"already-abandoned"}'
    assert_abandoned "${channel}" "${thread}"
    echo "${TEST_NAME}: abandoned ${HEAD_TS}; successor ${next_ts} delivered; accepted bytes retained"
}

# Threaded Slack A and ordinary Slack B use a source distinct from the notice
# destination, so a mistaken destination post cannot pass the thread assertion.
set_key_faults on
ROOT_TS="$(scenario_ts)"
A_TS="$(scenario_ts)"
B_TS="$(scenario_ts)"
HEAD_BODY="T69-SLACK-HEAD-RETAIN-EXACTLY"
B_BODY="T69-SLACK-SUCCESSOR"
slack_push_reply "${LABEL}" "${SOURCE}" "${ROOT_TS}" "${HEAD_BODY}" "${A_TS}" "${SENDER}" > "${SCENARIO_ROOT}/push-a.json"
slack_push_message "${LABEL}" "${SOURCE}" "${B_BODY}" "${B_TS}" "${SENDER}" > "${SCENARIO_ROOT}/push-b.json"
blocked_head slack "${HEAD_BODY}" "${B_BODY}"
[[ "${HEAD_TS}" == "${A_TS}" ]] || fail 'operator timestamp is not Slack A'
check_cli 1 "${KEY}" "${B_TS}" 409 "$(jq -cn --arg ts "${HEAD_TS}" '{reason:"not-head",head_ts:$ts}')"
check_cli 1 "${KEY}" 1.000001 409 '{"reason":"unknown-item"}'
check_cli 1 "${SCENARIO_TAG}unknown" "${HEAD_TS}" 404 '{}'
abandon_and_advance "${B_BODY}" "${B_TS}" "${SENDER}" "${SOURCE}" "${ROOT_TS}"
SLACK_HEAD_TS="${HEAD_TS}"
SLACK_HEAD_SENDS="$(cscb_ad_count send-keys "${HEAD_BODY}")"

# Live-case shape: injected job-scheduler work at the head, identified solely
# by its logged durable ts. No fixed-record editing or TUI parsing is needed.
set_key_faults on
HEAD_BODY="T69-INTERJECT-HEAD-RETAIN-EXACTLY"
D_BODY="T69-INTERJECT-SUCCESSOR"
D_TS="$(scenario_ts)"
BODY="$(jq -cn --arg p "${KEY}" --arg m "${HEAD_BODY}" '{persona:$p,message:$m,sender:"job-scheduler"}')"
HTTP_STATUS="$(curl -sS --max-time 10 -o "${SCENARIO_ROOT}/interject.json" -w '%{http_code}' \
    -H 'Content-Type: application/json' -d "${BODY}" "http://127.0.0.1:${SCENARIO_PORT}/interject")"
[[ "${HTTP_STATUS}" == 200 ]] || fail 'interject route did not accept head'
jq -e '.ok==true' "${SCENARIO_ROOT}/interject.json" > /dev/null || fail 'interject did not confirm acceptance'
slack_push_message "${LABEL}" "${SOURCE}" "${D_BODY}" "${D_TS}" "${SENDER}" > "${SCENARIO_ROOT}/push-d.json"
blocked_head interject "${HEAD_BODY}" "${D_BODY}"
abandon_and_advance "${D_BODY}" "${D_TS}" job-scheduler "${DESTINATION}" ''

stop_server --stop-bots
[[ "$(cscb_ad_count send-keys T69-SLACK-HEAD-RETAIN-EXACTLY)" == "${SLACK_HEAD_SENDS}" ]] || fail 'Slack head reappeared during the interject leg'
expect_count "$(matcher "[slack] ${DELIVERED}: persona=${REF}" "ts=\"${SLACK_HEAD_TS}\"")" 0 'Slack head delivered later'
expect_count "$(matcher "[slack] ${ABANDONED}: persona=${REF}")" 2 'exactly two operator abandonments required'
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
