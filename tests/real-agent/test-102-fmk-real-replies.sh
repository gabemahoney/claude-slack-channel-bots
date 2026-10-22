#!/usr/bin/env bash
# heavy scenario, outside /ci gate discovery.
set -euo pipefail
TEST_NAME="test-102-fmk-real-replies"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare "${REAL_AGENT_CLAUDE_VERSION:-2.1.296}" mcp__slack-channel-router__reply
real_persona peer
PEER_KEY="${REAL_KEY}"
PEER_LABEL="${REAL_LABEL}"
PEER_BOT="${REAL_BOT_USER_ID}"
real_persona reply 'For every relayed channel message use mcp__slack-channel-router__reply exactly once with text E6-REPLY: followed immediately by the outer message_id, passing its chat_id, message_id and thread_ts when present. Do not just answer in the terminal.'
real_write_config '{"resume_enabled":false}'
real_start_stub
touch "${SCENARIO_ROOT}/expected-posts.jsonl"
for trial in {1..3}; do
    MARK="$(date +%s%3N)"
    start_server --live
    real_wait_launch "${REAL_KEY}"
    TS="$(date +%s.%6N)"
    real_dm "${REAL_LABEL}" "fresh launch ${trial} reply" "${TS}"
    jq -cn --arg dm "D0${REAL_LABEL^^}" --arg text "E6-REPLY:${TS}" '{channel:$dm,text:$text}' >> "${SCENARIO_ROOT}/expected-posts.jsonl"
    real_wait_delivery "${REAL_KEY}" "${trial}"
    real_wait_idle "${REAL_KEY}"
    case_assert first-launch "${MARK}"
    if [[ "${trial}" != 3 ]]; then stop_server --stop-bots; fi
done
real_dm "${PEER_LABEL}" 'peer receives independently'
real_wait_delivery "${PEER_KEY}" 1
TS="$(date +%s.%6N)"
slack_stub_push "${REAL_LABEL}" "$(jq -cn --arg ch "${REAL_CHANNEL}" --arg u "${REAL_USER}" --arg bot "${REAL_BOT_USER_ID}" --arg ts "${TS}" --arg peer "${PEER_BOT}" '{type:"app_mention",channel:$ch,user:$u,ts:$ts,text:("<@"+$bot+"> <@"+$peer+"> <!here> &lt;b&gt; <https://example.com|link>")}')"
jq -cn --arg ch "${REAL_CHANNEL}" --arg text "E6-REPLY:${TS}" '{channel:$ch,text:$text}' >> "${SCENARIO_ROOT}/expected-posts.jsonl"
real_wait_delivery "${REAL_KEY}" 4
real_wait_idle "${REAL_KEY}"
THREAD="$(date +%s.%6N)"
THREAD_MESSAGE="$(date +%s.%6N)"
slack_stub_push "${REAL_LABEL}" "$(jq -cn --arg ch "${REAL_CHANNEL}" --arg u "${REAL_USER}" --arg ts "${THREAD_MESSAGE}" --arg thread "${THREAD}" '{type:"message",channel:$ch,channel_type:"channel",user:$u,ts:$ts,thread_ts:$thread,text:"thread reply"}')"
real_wait_delivery "${REAL_KEY}" 5
jq -cn --arg ch "${REAL_CHANNEL}" --arg text "E6-REPLY:${THREAD_MESSAGE}" --arg th "${THREAD}" '{channel:$ch,thread_ts:$th,text:$text}' >> "${SCENARIO_ROOT}/expected-posts.jsonl"
jq -s '.' "${SCENARIO_ROOT}/expected-posts.jsonl" > "${SCENARIO_ROOT}/expected-posts.json"
wait_until 180 'replies not posted in their exact destinations/threads' case_assert posts "${SCENARIO_SLACK_RECORD}" "${SCENARIO_ROOT}/expected-posts.json"
case_assert mention-body "${PEER_BOT}"

case_assert launches
real_finish "${REAL_KEY}" "${PEER_KEY}"
echo "PASS: ${TEST_NAME}"
