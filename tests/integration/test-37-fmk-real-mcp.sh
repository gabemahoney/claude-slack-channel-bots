#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-37-fmk-real-mcp"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona mcp
real_write_config '{"health_check_interval":0}'
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
# Server start reconnect with a running native bot.
stop_server
RESTART_MARK="$(date +%s%3N)"
start_server --live
real_dm "${REAL_LABEL}" 'server restart reconnect'
real_wait_delivery "${REAL_KEY}" 1
case_assert reconnect-proof 1 "${RESTART_MARK}"
real_wait_idle "${REAL_KEY}"
DROP_MARK="$(date +%s%3N)"
real_drop_mcp "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'message-triggered reconnect'
# Counts and reconnect targets follow original Slack inputs, skipping reminder sequence numbers.
real_wait_delivery "${REAL_KEY}" 2
case_assert reconnect-proof 2 "${DROP_MARK}"
# Session loss while the delivery attempt owns the typing gate.
real_wait_idle "${REAL_KEY}"
real_fault send-keys key=Enter delay=5000 1
real_dm "${REAL_LABEL}" 'gate held first'
wait_until 180 'delivery gate delay not applied' case_assert fault delay=5000
real_drop_mcp "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'gate held second'
real_wait_delivery "${REAL_KEY}" 4
GATE_RELEASE="$(case_assert fault-at delay=5000)"
GATE_RELEASE="$(python3 -c 'import sys; print(float(sys.argv[1])+5000)' "${GATE_RELEASE}")"
case_assert reconnect-proof 4 "${GATE_RELEASE}"
# Empty queue, health checks off, unrelated human text at server start.
real_wait_idle "${REAL_KEY}"
DRAFT='human draft remains intact'
real_ad send-keys --instance-id "$(real_instance "${REAL_KEY}")" --text "${DRAFT}" --no-enter >/dev/null
stop_server
MARK="$(date +%s%3N)"
start_server --live
real_dm "${REAL_LABEL}" 'deferred reconnect after human draft'
wait_until 180 'held DM not accepted' case_assert accepted 5
case_assert no-send "${MARK}"
real_record_pane "${REAL_KEY}"
CLEAR_MARK="$(date +%s%3N)"
real_clear_draft "${REAL_KEY}" "${DRAFT}"
real_wait_delivery "${REAL_KEY}" 5
case_assert reconnect-proof 5 "${CLEAR_MARK}"
case_assert reconnects

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
