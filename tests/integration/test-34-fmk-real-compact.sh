#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-34-fmk-real-compact"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
# Decision 16: explicit /compact proves AC42 on every gate invocation.
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona compact
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'before explicit compaction'
real_wait_delivery "${REAL_KEY}" 1
real_wait_idle "${REAL_KEY}"
real_ad send-keys --instance-id "$(real_instance "${REAL_KEY}")" --text '/compact' >/dev/null
for n in {1..3}; do real_dm "${REAL_LABEL}" "during compact ${n}"; done
wait_until "${REAL_COMPACT_WAIT_S}" 'explicit compact not observed in transcript' case_assert compacted
real_wait_delivery "${REAL_KEY}" 4
case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
