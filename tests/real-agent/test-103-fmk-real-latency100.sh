#!/usr/bin/env bash
# heavy scenario, outside /ci gate discovery.
set -euo pipefail
TEST_NAME="test-103-fmk-real-latency100"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona latency100
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
for n in {1..100}; do
    real_wait_idle "${REAL_KEY}"
    real_dm "${REAL_LABEL}" "heavy ready-state latency ${n}"
    real_wait_delivery "${REAL_KEY}" "${n}"
done
real_assert_latency "${REAL_KEY}" 100

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
