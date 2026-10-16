#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-34-fmk-real-compact"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
# Guarded container setup is complete before changing the bot launch environment.
export CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS=1
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
if [[ "${REAL_CLAUDE_VERSION}" == 2.1.280 ]]; then
    echo 'recorded: idle compaction setting unsupported by native Claude 2.1.280; step skipped'
else
    real_wait_idle "${REAL_KEY}"
    # Observe the native idle-compaction turn, then queue during it. A
    # completed earlier /compact boundary cannot satisfy this precondition.
    BEFORE="$(case_assert compact-count)"
    idle_compacting() {
        real_pane "${REAL_KEY}" 40 > "${SCENARIO_ROOT}/idle-compact-pane.json"
        case_assert compact-active "${SCENARIO_ROOT}/idle-compact-pane.json"
    }
    wait_until "${REAL_COMPACT_WAIT_S}" 'native idle compaction never started' idle_compacting
    real_record_pane "${REAL_KEY}"
    for n in {1..3}; do real_dm "${REAL_LABEL}" "during idle compact ${n}"; done
    wait_until "${REAL_COMPACT_WAIT_S}" 'idle compaction did not produce a new boundary' case_assert compact-after "${BEFORE}"
    real_wait_delivery "${REAL_KEY}" 7
fi

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
