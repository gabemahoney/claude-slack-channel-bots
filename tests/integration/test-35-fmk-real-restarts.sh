#!/usr/bin/env bash
# real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-35-fmk-real-restarts"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona restarts
real_write_config '{"session_restart_delay":0}'
real_start_stub
sha256sum "${REAL_CLAUDE}" "${HOME}/.claude/settings.json" > "${SCENARIO_ROOT}/native-before.sha256"
start_server --live
real_wait_launch "${REAL_KEY}"
COUNT=0
MODE_COUNT=0
for mode in restart resume fresh upgrade; do
    real_wait_idle "${REAL_KEY}"
    if [[ "${mode}" == fresh || "${mode}" == upgrade ]]; then
        RESUME=true
        if [[ "${mode}" == fresh ]]; then RESUME=false; fi
        real_write_config "{\"resume_enabled\":${RESUME},\"session_restart_delay\":0}"
        wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'resume setting not previewed'
        mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
        wait_until 30 'resume setting not applied' jq -e --argjson resume "${RESUME}" '.resume_enabled == $resume' "${SLACK_STATE_DIR}/config.json.last-applied"
    fi
    # Block a pending head so the lifecycle transition really is mid-queue.
    real_fault send-keys no_enter swallow 1
    for n in {1..3}; do real_dm "${REAL_LABEL}" "${mode} item ${n}"; done
    MODE_COUNT=$((MODE_COUNT+1))
    wait_until 180 'lifecycle items not accepted' case_assert accepted "$((COUNT+3))"
    wait_until 180 'old head fault not consumed' case_assert no-enter-fault "${MODE_COUNT}"
    case_assert open "$((COUNT+1))"
    OLD_SESSION="$(real_ad get --instance-id "$(real_instance "${REAL_KEY}")" | jq -r .session_id)"
    [[ -n "${OLD_SESSION}" && "${OLD_SESSION}" != null ]] || fail 'old conversation was not reported by AD'
    if [[ "${mode}" == upgrade ]]; then stop_server; else stop_server --stop-bots; fi
    # Capture after stop so a connection racing shutdown is historical too.
    CONNECTION_LINE_BASE="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
    if [[ "${mode}" == upgrade ]]; then
        ad_store_edit "UPDATE spawns SET labels = json_remove(labels, '$.tag_prompt'), row_version = row_version + 1 WHERE instance_id = '$(real_instance "${REAL_KEY}")'" >/dev/null
    fi
    start_server --live
    REPLACED_SESSION=''
    if [[ "${mode}" == fresh || "${mode}" == upgrade ]]; then REPLACED_SESSION="${OLD_SESSION}"; fi
    real_wait_launch "${REAL_KEY}" "${REPLACED_SESSION}" "${CONNECTION_LINE_BASE}"
    NEW_SESSION="$(real_ad get --instance-id "$(real_instance "${REAL_KEY}")" | jq -r .session_id)"
    if [[ "${mode}" == resume ]]; then [[ "${NEW_SESSION}" == "${OLD_SESSION}" ]] || fail 'resume changed conversation'; fi
    if [[ "${mode}" == fresh || "${mode}" == upgrade ]]; then [[ "${NEW_SESSION}" != "${OLD_SESSION}" ]] || fail 'replacement kept old conversation'; fi
    COUNT=$((COUNT+3))
    real_wait_delivery "${REAL_KEY}" "${COUNT}"
done
case_assert launches resume
sha256sum -c "${SCENARIO_ROOT}/native-before.sha256"
echo 'recorded: native binary and scenario operator settings unchanged across launch/resume/replacement'

real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
