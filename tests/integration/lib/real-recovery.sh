#!/usr/bin/env bash
# Sourced after real-scenario.sh by scenarios that deliberately kill a bot.
require_ci_image real-recovery
require_scenario_home real-recovery

# Kill is not a state transition in AD. Retain its result and complete AD's
# bounded live-row sequence before restarting CSCB. A failed operation stops
# the fixture for operator diagnosis; it never authorizes a replacement.
real_kill_and_reconcile() {
    local instance session row state remaining attempt
    instance="$(real_instance "$1")"
    REAL_KILLED_ROW="${SCENARIO_ROOT}/killed-${1}.json"
    real_ad get --instance-id "${instance}" > "${REAL_KILLED_ROW}"
    jq -e '.session_id | type == "string" and length > 0' "${REAL_KILLED_ROW}" >/dev/null \
        || fail 'kill fixture requires an AD native session identity'
    session="$(jq -r .session_id "${REAL_KILLED_ROW}")"
    _real_checked_kill "${instance}" 1
    stop_server
    # Capture after stop, so even a connection racing shutdown is historical.
    REAL_CONNECTION_LINE_BASE="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
    for attempt in 1 2 3 4; do
        if [[ "${attempt}" == 4 ]]; then
            _real_checked_kill "${instance}" 2
            sleep 5
        fi
        # Use the package's existing AD settings reader, including the
        # configured/derived grace, rather than copying AD's timing rules.
        row="${SCENARIO_ROOT}/kill-status-${1}.json"
        real_ad status --instance-id "${instance}" > "${row}" || fail 'kill status failed; operator inspection required'
        state="$(jq -r .state "${row}")"
        if [[ "${state}" == pending ]]; then
            remaining="$(bun -e '
const { createAdSettingsReader, adGraceMs } = await import(process.env.CSCB_PKG_DIR + "/src/ad-settings.ts")
const reader = createAdSettingsReader({ home: () => process.env.HOME, log: () => {} })
if (reader.read().kind !== "accepted") process.exit(1)
const row = await Bun.file(process.argv[1]).json()
const start = Date.parse(row.launch_started_at)
const grace = adGraceMs(reader.valuesInEffect())
if (!Number.isFinite(start) || !Number.isFinite(grace)) process.exit(1)
console.log(Math.max(0, Math.ceil((start + grace - Date.now()) / 1000)))
' "${row}")" || fail 'pending launch grace could not be established'
            [[ "${remaining}" -le 300 ]] || fail 'pending grace exceeds fixture bound; operator inspection required'
            if [[ "${remaining}" -gt 0 ]]; then sleep "${remaining}"; fi
        fi
        real_ad find-missing > "${SCENARIO_ROOT}/kill-sweep-${1}-${attempt}.json" \
            || fail 'find-missing failed; operator inspection required'
        real_ad status --instance-id "${instance}" > "${row}" || fail 'post-kill status failed; operator inspection required'
        state="$(jq -r .state "${row}")"
        if [[ "${state}" == ended || "${state}" == missing ]]; then
            # launch_started_at is pending-only in AD. Keep the finished
            # row's last hook timestamp instead, before restarting CSCB.
            real_ad get --instance-id "${instance}" > "${REAL_KILLED_ROW}" \
                || fail 'finished row could not be retained'
            jq -e --arg instance "${instance}" --arg session "${session}" \
                '(.state == "ended" or .state == "missing")
                and .instance_id == $instance and .session_id == $session
                and (.last_seen_at | type == "string" and length > 0)' "${REAL_KILLED_ROW}" >/dev/null \
                || fail 'AD row did not remain finished before restart'
            return 0
        fi
        if [[ "${attempt}" -lt 3 ]]; then sleep 5; fi
    done
    fail 'killed AD row remains live after the documented sequence; operator inspection required'
}

_real_checked_kill() {
    local result="${SCENARIO_ROOT}/kill-result-${1}-${2}.json"
    real_ad kill --instance-id "$1" > "${result}" || fail 'AD kill failed; operator inspection required'
    jq -e '.kill_sent | type == "boolean"' "${result}" >/dev/null || fail 'AD kill result has no kill_sent'
}

real_wait_relaunch() {
    wait_until "${REAL_LAUNCH_WAIT_S}" "real persona $1 never relaunched/connected" _real_relaunched "$1"
    real_wait_idle "$1" "${REAL_LAUNCH_WAIT_S}"
}

_real_relaunched() {
    local row="${SCENARIO_ROOT}/relaunch-${1}.json"
    real_ad get --instance-id "$(real_instance "$1")" > "${row}" 2>/dev/null || return 1
    jq -e --slurpfile old "${REAL_KILLED_ROW}" \
        '(.state == "waiting" or .state == "working") and .labels.tag_prompt == "1"
         and .instance_id == $old[0].instance_id
         and (.session_id | type == "string" and length > 0)
         and (.last_seen_at | type == "string" and length > 0)
         and (.session_id != $old[0].session_id
              or .last_seen_at != $old[0].last_seen_at)' "${row}" >/dev/null || return 1
    tail -n "+$((REAL_CONNECTION_LINE_BASE+1))" "${SLACK_STATE_DIR}/server.log" \
        | grep -F 'Session connected: persona ' | grep -qF "(key=$1)"
}
