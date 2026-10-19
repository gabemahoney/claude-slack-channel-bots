#!/usr/bin/env bash
# b.omv SR-14.2 case 3, decision 16: native idle variant is heavy-only.
set -euo pipefail
TEST_NAME="test-104-fmk-real-idle-compact"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_idle_environment
real_prepare "${REAL_AGENT_CLAUDE_VERSION:-2.1.296}" 'Read(./idle-budget/**)'
real_persona idlecompact 'For an explicit Read request, read the entire named file with Read, then answer OK. Otherwise answer OK. Do not use any other tools.'
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
# A genuine delivery establishes current-session transcript-directory ownership.
real_dm "${REAL_LABEL}" 'bootstrap native idle observation'
real_wait_delivery "${REAL_KEY}" 1
real_wait_idle "${REAL_KEY}"
if ! real_idle_capability; then
    case_assert launches
    real_finish "${REAL_KEY}"
    echo "PASS: ${TEST_NAME} (native idle step skipped with recorded capability reason)"
    exit 0
fi

# Tool responses build actual native request context. These files contain only
# deterministic test data; neither transcripts nor rollout settings are seeded.
python3 - "${REAL_WORK}/idle-budget" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1])
root.mkdir()
for index in range(24):
    (root/f'chunk-{index}.txt').write_text(''.join(
        hashlib.sha256(f'{index}:{line}'.encode()).hexdigest()+'\n' for line in range(400)))
PY
COUNT=1
for n in {0..23}; do
    OBSERVATION="$(real_idle_observation "${REAL_KEY}")"
    if jq -e --argjson minimum "${REAL_IDLE_MIN_TOKENS}" '.contextTokens >= $minimum' <<< "${OBSERVATION}" >/dev/null; then break; fi
    READ_PATH="${REAL_WORK}/idle-budget/chunk-${n}.txt"
    real_dm "${REAL_LABEL}" "Use Read to read the entire file ${READ_PATH}, then answer OK."
    COUNT=$((COUNT+1))
    real_wait_delivery "${REAL_KEY}" "${COUNT}"
    real_wait_idle "${REAL_KEY}"
    case_assert idle-read "${READ_PATH}"
done
OBSERVATION="$(real_idle_observation "${REAL_KEY}")"
jq -e --argjson minimum "${REAL_IDLE_MIN_TOKENS}" '.contextTokens >= $minimum and .usageAt != null' <<< "${OBSERVATION}" >/dev/null \
    || fail 'real current-request context never reached the native idle token floor'
printf 'recorded: native idle prepared %s\n' "${OBSERVATION}"
BASELINE="${OBSERVATION}"

idle_compacting() {
    real_pane "${REAL_KEY}" 40 > "${SCENARIO_ROOT}/idle-compact-pane.json" || return 1
    case_assert compact-active "${SCENARIO_ROOT}/idle-compact-pane.json" || return 1
    COMPACT_STARTED_AT="$(date +%s%3N)"
}
wait_until "${REAL_IDLE_WAIT_S}" 'native idle compaction never started within 45 minutes' idle_compacting
printf 'recorded: native idle compaction start observed_at=%s\n' "${COMPACT_STARTED_AT}"
real_record_pane "${REAL_KEY}"
for n in {1..3}; do real_dm "${REAL_LABEL}" "during native idle compact ${n}"; done
COUNT=$((COUNT+3))
native_completed() {
    local observation
    observation="$(real_idle_observation "${REAL_KEY}")" || return 1
    jq -e --argjson before "${BASELINE}" --argjson started "${COMPACT_STARTED_AT}" \
        '.sessionId == $before.sessionId and .boundaries > $before.boundaries and .lastBoundaryAt >= $started' \
        <<< "${observation}" >/dev/null || return 1
    bun "${REAL_RECEIPTS}" ready "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${COUNT}"
}
# The boundary and every queued delivery share one deadline from observed start.
wait_until "${REAL_COMPACT_WAIT_S}" 'native idle boundary/delivery exceeded 120 seconds from start' native_completed
FINISHED_AT="$(date +%s%3N)"
(( FINISHED_AT - COMPACT_STARTED_AT <= REAL_COMPACT_WAIT_S * 1000 )) \
    || fail 'native idle completion exceeded its shared 120 second deadline'
printf 'recorded: native idle boundary and deliveries completed elapsed_ms=%s\n' "$((FINISHED_AT-COMPACT_STARTED_AT))"
case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
