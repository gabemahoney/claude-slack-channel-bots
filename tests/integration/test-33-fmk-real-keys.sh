#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-33-fmk-real-keys"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
source "$(dirname "$0")/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
# Preserve transport and durable evidence before the isolated HOME is removed.
retain_key_evidence() {
    python3 - "${SCENARIO_AD_SHIM_LOG}" "${SLACK_STATE_DIR}" <<'PY_EVIDENCE'
import json, pathlib, sys
shim, state = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
files = [('shim.log', shim), ('server.log', state / 'server.log')]
for directory in ('queue', 'receipt-history'):
    files.extend((str(path.relative_to(state)), path) for path in sorted((state / directory).glob('*.jsonl')))
for name, path in files:
    for line in path.read_text().splitlines():
        print('recorded: key-evidence ' + json.dumps({'file': name, 'line': line}))
PY_EVIDENCE
}
on_exit retain_key_evidence
# Assign the Slack identity before arming the fault, so an earlier queued
# reminder cannot consume it. Restart retries retain the same identity.
key_fault() {
    KEY_FAULT_TS="${4:-$(date +%s.%6N)}"
    local file="${SCENARIO_AD_SHIM_LOG%.log}.faults"
    # Share the shim's stable lock, as real_fault does for unscoped rules.
    { flock -x 8; printf 'send-keys %s %s %s %s:%s\n' "$1" "$2" "$3" \
        "$(real_instance "${REAL_KEY}")" "${KEY_FAULT_TS}" >> "${file}"; } 8> "${file}.lock"
}
bash "${SCENARIO_FIXTURES}/key-fault-controls.sh" "${SCENARIO_ROOT}"
real_prepare
real_persona keys
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
key_fault key=Enter swallow 1
real_dm "${REAL_LABEL}" 'one swallowed Enter' "${KEY_FAULT_TS}"
wait_until 180 'Enter was not swallowed' case_assert enter-fault 1
real_record_state "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 1
case_assert key-proof 1 enter
real_wait_idle "${REAL_KEY}"
key_fault no_enter swallow 1
real_dm "${REAL_LABEL}" 'one swallowed text' "${KEY_FAULT_TS}"
real_wait_delivery "${REAL_KEY}" 2
case_assert key-proof 2 retype
real_wait_idle "${REAL_KEY}"
key_fault no_enter swallow 3
real_dm "${REAL_LABEL}" 'three swallowed texts' "${KEY_FAULT_TS}"
# Recovery Enter and receipt timeouts put the fourth text attempt near 202s.
# Bound this leg explicitly without changing the other waits or retry backoff.
REAL_DELIVERY_WAIT_S=300 real_wait_delivery "${REAL_KEY}" 3
case_assert key-proof 3 spacing
# Restart an UNCONFIRMED head during its growing retry episode; the new
# launch restarts at 10s, then uses two guarded 30s recovery stages. Prove
# each durable Enter/text stage and its launch identity, not a text-gap bound.
real_wait_idle "${REAL_KEY}"
key_fault no_enter swallow 3
real_dm "${REAL_LABEL}" 'restart resets an in-flight retry episode' "${KEY_FAULT_TS}"
wait_until 180 'third swallowed reset text not reached' case_assert fault swallow 8
real_kill_and_reconcile "${REAL_KEY}"
key_fault no_enter swallow 1 "${KEY_FAULT_TS}"
start_server --live
real_wait_relaunch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 4
case_assert reset-spacing 4
UNKNOWN_COUNT=4
for outcome in unknown-typed unknown-untyped; do
    real_wait_idle "${REAL_KEY}"
    key_fault no_enter "${outcome}" 1
    real_dm "${REAL_LABEL}" "unknown outcome ${outcome}" "${KEY_FAULT_TS}"
    UNKNOWN_COUNT=$((UNKNOWN_COUNT+1))
    real_wait_delivery "${REAL_KEY}" "${UNKNOWN_COUNT}"
    case_assert unknown-proof "${outcome}"
done
real_wait_idle "${REAL_KEY}"
key_fault key=Enter swallow 1
real_dm "${REAL_LABEL}" "$(python3 -c 'print("x"*5000,end="")')" "${KEY_FAULT_TS}"
wait_until 180 'large-part Enter was not swallowed' case_assert enter-fault 2
real_record_state "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 7
case_assert key-proof 7 enter

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
