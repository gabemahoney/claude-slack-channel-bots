#!/usr/bin/env bash
# Exercise queued delivery through uncertain AD outcomes; native idle/compaction compatibility belongs to AD.
set -euo pipefail
TEST_NAME="test-104-fmk-real-idle-compact"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
real_prepare "${REAL_AGENT_CLAUDE_VERSION:-2.1.296}"
real_persona waitingcontract
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_fault send-keys no_enter unknown-untyped 1
for n in {1..3}; do real_dm "${REAL_LABEL}" "queued AD contract delivery ${n}"; done
real_wait_delivery "${REAL_KEY}" 3
bun "${SCENARIO_FIXTURES}/real-case-assertions.ts" fault "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" unknown-untyped 1
real_assert_delivery "${REAL_KEY}" 3
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
