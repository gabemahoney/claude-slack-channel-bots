#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-33-fmk-real-keys"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
source "$(dirname "$0")/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona keys
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_fault send-keys key=Enter swallow 1
real_dm "${REAL_LABEL}" 'one swallowed Enter'
wait_until 180 'Enter was not swallowed' case_assert enter-fault 1
real_record_state "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 1
case_assert key-proof 1 enter
real_wait_idle "${REAL_KEY}"
real_fault send-keys no_enter swallow 1
real_dm "${REAL_LABEL}" 'one swallowed text'
real_wait_delivery "${REAL_KEY}" 2
case_assert key-proof 2 retype
real_wait_idle "${REAL_KEY}"
real_fault send-keys no_enter swallow 3
real_dm "${REAL_LABEL}" 'three swallowed texts'
# Recovery Enter and receipt timeouts put the fourth text attempt near 202s.
# Bound this leg explicitly without changing the other waits or retry backoff.
REAL_DELIVERY_WAIT_S=300 real_wait_delivery "${REAL_KEY}" 3
case_assert key-proof 3 spacing
# Restart an UNCONFIRMED head during its growing retry episode; the new
# launch restarts at 10s, then uses two guarded 30s recovery stages. Prove
# each durable Enter/text stage and its launch identity, not a text-gap bound.
real_wait_idle "${REAL_KEY}"
real_fault send-keys no_enter swallow 3
real_dm "${REAL_LABEL}" 'restart resets an in-flight retry episode'
wait_until 180 'third swallowed reset text not reached' case_assert fault swallow 8
real_kill_and_reconcile "${REAL_KEY}"
real_fault send-keys no_enter swallow 1
start_server --live
real_wait_relaunch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 4
case_assert reset-spacing 4
UNKNOWN_COUNT=4
for outcome in unknown-typed unknown-untyped; do
    real_wait_idle "${REAL_KEY}"
    real_fault send-keys no_enter "${outcome}" 1
    real_dm "${REAL_LABEL}" "unknown outcome ${outcome}"
    UNKNOWN_COUNT=$((UNKNOWN_COUNT+1))
    real_wait_delivery "${REAL_KEY}" "${UNKNOWN_COUNT}"
    case_assert unknown-proof "${outcome}"
done
real_wait_idle "${REAL_KEY}"
real_fault send-keys key=Enter swallow 1
real_dm "${REAL_LABEL}" "$(python3 -c 'print("x"*5000,end="")')"
wait_until 180 'large-part Enter was not swallowed' case_assert enter-fault 2
real_record_state "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 7
case_assert key-proof 7 enter

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
