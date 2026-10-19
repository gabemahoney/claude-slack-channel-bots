#!/usr/bin/env bash
# b.omv SR-14.8 / R55, authoritative decision 15: exact safe downgrade order.
set -euo pipefail
TEST_NAME="test-40-fmk-real-downgrade"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
real_prepare 2.1.280
real_persona downgrade
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
# No DM: the previous release's channel delivery is deliberately not exercised.
[[ ! -e "${SLACK_STATE_DIR}/queue/${REAL_KEY}.jsonl" || ! -s "${SLACK_STATE_DIR}/queue/${REAL_KEY}.jsonl" ]] || fail 'downgrade requires empty queues'
echo 'recorded: R55 step 1 queues empty'
real_write_config '{"resume_enabled":false}'
jq 'del(.test_mcp_drop_endpoint)' "${SLACK_STATE_DIR}/config.json" | write_config
wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'resume=false preview absent'
mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
wait_until 30 'resume=false was not confirmed' jq -e '.resume_enabled == false' "${SLACK_STATE_DIR}/config.json.last-applied"
echo 'recorded: R55 step 2 resume_enabled=false confirmed'
stop_server --stop-bots
PREVIOUS="/opt/claude-slack-channel-bots-0.16.1/claude-slack-channel-bots-0.16.1.tgz"
[[ -f "${PREVIOUS}" ]] || fail 'previous release tarball missing'
INSTALL="${SCENARIO_ROOT}/downgrade-install"
mkdir -p "${INSTALL}"
printf '{"private":true,"dependencies":{"claude-slack-channel-bots":"file:%s"}}\n' "${PREVIOUS}" > "${INSTALL}/package.json"
(cd "${INSTALL}" && bun install --ignore-scripts > "${SCENARIO_ROOT}/downgrade-install.log" 2>&1)
SCENARIO_CLI="${INSTALL}/node_modules/.bin/claude-slack-channel-bots"
OLD_MARK="$(ad_shim_mark)"
echo 'recorded: R55 step 3 server and bot stopped; prior release installed; native 2.1.280 pin restored'
start_server --live
real_wait_launch "${REAL_KEY}"
# Its actual recorded template must carry channels; resume=false means no resume.
[[ "$(cscb_ad_count_between "${OLD_MARK}" - resume)" == 0 ]] || fail 'previous release resumed instead of starting fresh'
python3 - "${SCENARIO_AD_SHIM_LOG}" "${OLD_MARK}" <<'CHECK'
import sys
lines=open(sys.argv[1]).read().splitlines()[int(sys.argv[2]):]
templates=[l.split('\t',5)[5].split() for l in lines if l.startswith('call\t') and 'make-template' in l.split('\t',5)[5].split()]
assert any('--dangerously-load-development-channels' in words and 'server:slack-channel-router' in words for words in templates), 'prior release template has no channels flag and router target'
CHECK
! grep -Ei 'failed to load config|invalid persona config|load error' "${START_OUT}" || fail 'previous release load error'
echo 'recorded: R55 step 4 prior release started fresh with channels'
jq '.resume_enabled = true' "${SLACK_STATE_DIR}/config.json" | write_config
wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'resume=true preview absent'
mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
wait_until 30 'resume=true was not confirmed' jq -e '.resume_enabled == true' "${SLACK_STATE_DIR}/config.json.last-applied"
echo 'recorded: R55 resume_enabled=true confirmed'
# The shared EXIT hook reports launch usage once, after bot teardown.
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
