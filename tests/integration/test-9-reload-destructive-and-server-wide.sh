#!/usr/bin/env bash
# Test 9 (t3.ob2.5e.u7.9n; E13 dry-run leg): a destructive modify and a
# server-wide change through the confirmed reload, in dry run.
#
# A running server with two personas, alpha and bravo:
# 1. Destructive modify. alpha's working_directory moves to another directory.
#    The preview (config.json.pending, each of whose lines is logged as a
#    `reload-preview` line) holds exactly one `DESTRUCTIVE:` line, naming
#    alpha, working_directory and the new directory, and nothing is torn down
#    before the confirmation. Renaming the pending file to config.json.apply
#    confirms it: alpha gets one teardown, then one bring-up (its
#    `persona-start` count goes up by one, and its dry-run spawn skip line
#    shows the new cwd), then `reload-applied`; bravo gets no line.
# 2. Server-wide change. `port` moves to another free port. The preview names
#    the setting and has no `DESTRUCTIVE:` line. After the confirmation, the
#    record (config.json.last-applied) holds the new port, no persona is torn
#    down or brought up, the server still answers on the old port (/interject
#    returns 404 for an unknown persona) and nothing listens on the new one.
# 3. Restart. `stop`, then `start` from the same state dir: the start runs the
#    record, listens on the new port (not the old one) and brings alpha up in
#    its new directory. Then `stop` again.
#
# Lines are matched by class prefix, persona ref and distinguishing fragments
# (E14 decision 14; lib/scenario.sh "Matchers"), each quoted from src/: the
# reload file names (src/reload.ts reloadFilePaths) and start line
# (resolveStart), the preview lines (src/reload-plan.ts renderPreviewLines:
# destructiveLine, settingLine; renderPreviewLogLines), the applied line
# (src/reload-apply.ts renderAppliedLogLine), the teardown and apply bring-up
# lines (src/persona-lifecycle.ts runTeardown, runBringUp), the persona-start
# line (src/persona-bringup-controller.ts bringUp, src/persona-diagnostics.ts
# formatPersonaDiagnostic), the dry-run spawn skip (src/session-manager.ts
# spawnForPersona) and the listening line (src/server.ts main). The preview's
# log lines are checked against the pending file's own lines, not retyped. A
# running server keeps its start-time server-wide settings after an apply
# (src/reload.ts configInEffect).
#
# health_check_interval is 0 (the health check never starts,
# src/health-check.ts startHealthCheck), so no restart it might schedule adds
# a line for either persona while the counts below are compared.
#
# The detection tick runs 5 s after the previous pass (src/reload-timer.ts
# RELOAD_TICK_INTERVAL_MS, not overridable), so each wait below is bounded by
# a few tick intervals. Runs in its own state dir and ports (the shared
# helper); the helper's EXIT trap stops any server left running and removes
# the scratch root. Expected runtime: about 45 s.
set -euo pipefail

TEST_NAME="test-9-reload-destructive-and-server-wide"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on one change showing up (a preview, or an apply after the rename):
# the first pass runs 5 s after the start bring-up returns, each later pass
# 5 s after the previous one ends.
TICK_WAIT_S=30
# Bound on a line the start writes once the daemon's PID file is live.
START_LINE_WAIT_S=30
# Bound on a file or listener settling after an apply or a stop.
SETTLE_WAIT_S=15

CONFIG="${SLACK_STATE_DIR}/config.json"
PENDING="${CONFIG}.pending"
APPLY="${CONFIG}.apply"
LAST="${CONFIG}.last-applied"

ALPHA="${SCENARIO_TAG}_alpha"
BRAVO="${SCENARIO_TAG}_bravo"
ALPHA_KEY="$(persona_key "${ALPHA}")"
BRAVO_KEY="$(persona_key "${BRAVO}")"
ALPHA_REF="$(persona_ref "${ALPHA}")"

CH_TAG="${SCENARIO_TAG^^}"
A1="C0${CH_TAG}A1"
B1="C0${CH_TAG}B1"

# Neither directory name is a prefix of the other, so a `cwd=` count for one
# never matches the other.
ALPHA_OLD_DIR="$(make_workdir alpha-old)"
ALPHA_NEW_DIR="$(make_workdir alpha-new)"
BRAVO_DIR="$(make_workdir bravo)"

OLD_PORT="${SCENARIO_PORT}"
NEW_PORT="$(free_port)"
while [[ "${NEW_PORT}" == "${OLD_PORT}" ]]; do
    NEW_PORT="$(free_port)"
done

# --- Expected text (fragments quoted from src/, see the header) -----------
PREVIEW='[slack] reload-preview: '
DESTRUCTIVE_LOG="${PREVIEW}DESTRUCTIVE:"
# alpha's DESTRUCTIVE: line, with the new directory (JSON-quoted).
destructive_m="$(destructive_match "${ALPHA}" working_directory)"
ALPHA_DESTRUCTIVE="$(matcher "${destructive_m}" "\"${ALPHA_NEW_DIR}\"")"
# The port's setting line, with its next-start effect.
PORT_SETTING="$(matcher 'server-wide setting port changed:' 'next server start')"
PORT_LOG="$(matcher "${PREVIEW}" "${PORT_SETTING}")"
HEADER_DESTRUCTIVE="$(preview_header_match destructive=1)"
HEADER_PORT="$(preview_header_match settings=1)"
APPLIED_DESTRUCTIVE="$(applied_match destructive=1)"
APPLIED_PORT="$(applied_match settings=1)"
APPLIED_CLASS='[slack] reload-applied:'

TEARDOWN_PREFIX="[slack] persona teardown of ${ALPHA_REF}"
TEARDOWN_START="${TEARDOWN_PREFIX}: starting"
TEARDOWN_DRY_RUN="$(matcher "[slack] dry-run: persona teardown of ${ALPHA_REF}:" 'skipping' "cscb_${ALPHA_KEY}")"
TEARDOWN_COMPLETE="${TEARDOWN_PREFIX}: complete"
TEARDOWN_FAILED_STEPS="${TEARDOWN_PREFIX}: complete, with"
ALPHA_START="$(persona_start_match 0 "${ALPHA}")"
ALPHA_UP_AT_APPLY="$(matcher "[slack] persona ${ALPHA_REF}:" 'up at apply')"
ALPHA_SKIP_OLD="$(skip_match "${ALPHA}" "${ALPHA_OLD_DIR}")"
ALPHA_SKIP_NEW="$(skip_match "${ALPHA}" "${ALPHA_NEW_DIR}")"
BRAVO_SKIP="$(skip_match "${BRAVO}" "${BRAVO_DIR}")"
STARTUP_COMPLETE="$(completion_match 2)"
FROM_RECORD="$(matcher '[slack] Starting from the last-applied record' "\"${LAST}\"")"
# Lines no step here may log.
STALE='[slack] reload-stale-confirmation:'
INVALID='[slack] reload-invalid:'
APPLY_STEP_FAILED='[slack] reload: apply step'

# Ports here are 5 digits (20000-29999), so `:<port>/` names one port.
listening_match() {
    matcher '[slack] MCP server listening on ' "//127.0.0.1:$1/mcp"
}
LISTENING_OLD="$(listening_match "${OLD_PORT}")"
LISTENING_NEW="$(listening_match "${NEW_PORT}")"

# --- Helpers ---------------------------------------------------------------

# The two-persona config: $1 alpha's working directory, $2 the port.
emit_config() {
    cat << EOF
{
  "personas": [
    {
      "name": "${ALPHA}",
      "credentials_file": "${SCENARIO_ROOT}/credentials-alpha.json",
      "working_directory": "$1",
      "channels": [{ "id": "${A1}", "delivery": "all" }],
      "permission_prompts": "${A1}"
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${SCENARIO_ROOT}/credentials-bravo.json",
      "working_directory": "${BRAVO_DIR}",
      "channels": [{ "id": "${B1}", "delivery": "all" }],
      "permission_prompts": "${B1}"
    }
  ],
  "bind": "127.0.0.1",
  "port": $2,
  "health_check_interval": 0
}
EOF
}

set_config() {
    emit_config "$1" "$2" | write_config
}

expect_log() {
    (( $(count_log "$1") > 0 )) || fail "$2"
}

pending_gone() {
    [[ ! -e "${PENDING}" ]]
}

# Snapshot the pending file, so every check below reads one version of it.
snapshot_pending() {
    local copy="${SCENARIO_ROOT}/pending.$1"
    [[ -f "${PENDING}" ]] || fail "$1: ${PENDING} missing after its preview was logged"
    cp "${PENDING}" "${copy}" || fail "$1: could not copy ${PENDING}"
    printf '%s\n' "${copy}"
}

# True when every preview line of the pending-file copy <file> (line 4 on:
# after the header, the fingerprint and a blank line, src/reload-fingerprint.ts
# composePendingFile) is in server.log as `[slack] reload-preview: <line>`
# (the header's log line goes on with the pending file's path, which the
# unanchored match allows).
preview_logged() {
    local file="$1" line n=0
    while IFS= read -r line; do
        n=$(( n + 1 ))
        (( $(count_log "${PREVIEW}${line}") > 0 )) || return 1
    done < <(tail -n +4 -- "${file}")
    (( n > 0 ))
}

# Confirm the pending change as the operator does: rename it to .apply.
confirm_pending() {
    mv -f "${PENDING}" "${APPLY}" || fail "$1: could not rename ${PENDING} to ${APPLY}"
}

record_port() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["port"])' "${LAST}" 2> /dev/null || true
}

expect_no_reload_errors() {
    expect_count "${STALE}" 0 "$1: reload-stale-confirmation lines"
    expect_count "${INVALID}" 0 "$1: reload-invalid lines"
    expect_count "${APPLY_STEP_FAILED}" 0 "$1: failed apply step lines"
}

# --- Start: two personas, dry run ------------------------------------------
set_config "${ALPHA_OLD_DIR}" "${OLD_PORT}"
# shellcheck disable=SC2119 # dry-run start: no --live
start_server
wait_for_log "${LISTENING_OLD}" "${START_LINE_WAIT_S}" \
    "start: server.log never showed the listener on port ${OLD_PORT}"
wait_for_log "${STARTUP_COMPLETE}" "${START_LINE_WAIT_S}" \
    "start: startupSessionManager never completed for 2 personas"
port_listening "${OLD_PORT}" || fail "start: nothing answers on port ${OLD_PORT}"
cmp -s "${CONFIG}" "${LAST}" || fail "start: ${LAST} does not hold config.json's bytes"
expect_count "${ALPHA_START}" 1 "start: persona-start lines for ${ALPHA}"
expect_count "${ALPHA_SKIP_OLD}" 1 "start: dry-run spawn skip lines for ${ALPHA} in ${ALPHA_OLD_DIR}"
expect_count "${BRAVO_SKIP}" 1 "start: dry-run spawn skip lines for ${BRAVO}"

# --- 1. Destructive modify: alpha's working_directory ----------------------
bravo_lines="$(count_log "(key=${BRAVO_KEY})")"

set_config "${ALPHA_NEW_DIR}" "${OLD_PORT}"
wait_for_log "${DESTRUCTIVE_LOG}" "${TICK_WAIT_S}" \
    "destructive: no DESTRUCTIVE: reload-preview line for the working_directory change"
expect_count "${DESTRUCTIVE_LOG}" 1 "destructive: DESTRUCTIVE: reload-preview lines"
expect_log "${HEADER_DESTRUCTIVE}" "destructive: reload-preview header lacks '$(counts destructive=1)'"

wait_for_file "${PENDING}" "${SETTLE_WAIT_S}" "destructive: ${PENDING} never appeared"
check_pending_layout destructive destructive=1
pending_copy="$(snapshot_pending destructive)"
n="$(grep -c '^DESTRUCTIVE:' "${pending_copy}" || true)"
[[ "${n}" == 1 ]] || fail "destructive: pending file holds ${n} DESTRUCTIVE: line(s), expected 1"
(( $(count_in "${pending_copy}" "${ALPHA_DESTRUCTIVE}") == 1 )) \
    || fail "destructive: pending file's DESTRUCTIVE: line does not name ${ALPHA}, working_directory and ${ALPHA_NEW_DIR}"
if grep -qF -- "(key=${BRAVO_KEY})" "${pending_copy}"; then
    fail "destructive: pending file names ${BRAVO}, which did not change"
fi
wait_until 10 "destructive: the pending file's lines were not all logged as reload-preview lines" \
    preview_logged "${pending_copy}"

# Nothing is applied before the confirmation.
expect_count "${TEARDOWN_START}" 0 "destructive: ${ALPHA}'s teardown lines before the confirmation"
grep -qF -- "${ALPHA_OLD_DIR}" "${LAST}" || fail "destructive: ${LAST} changed before the confirmation"

confirm_pending destructive
wait_for_log "${APPLIED_CLASS}" "${TICK_WAIT_S}" "destructive: no reload-applied line after the confirmation"
expect_count "${APPLIED_CLASS}" 1 "destructive: reload-applied lines"
expect_log "${APPLIED_DESTRUCTIVE}" "destructive: reload-applied line lacks '$(counts destructive=1)' or the record path"

# One teardown, then one bring-up, of alpha only.
expect_count "${TEARDOWN_START}" 1 "destructive: teardown-starting lines for ${ALPHA}"
expect_count "${TEARDOWN_DRY_RUN}" 1 "destructive: dry-run teardown lines for ${ALPHA}"
expect_count "${TEARDOWN_COMPLETE}" 1 "destructive: teardown-complete lines for ${ALPHA}"
expect_count "${TEARDOWN_FAILED_STEPS}" 0 "destructive: ${ALPHA}'s teardown lines with failed steps"
expect_count "${ALPHA_START}" 2 "destructive: persona-start lines for ${ALPHA}"
expect_count "${ALPHA_UP_AT_APPLY}" 1 "destructive: up-at-apply lines for ${ALPHA}"
expect_count "${ALPHA_SKIP_NEW}" 1 "destructive: dry-run spawn skip lines for ${ALPHA} in ${ALPHA_NEW_DIR}"
expect_count "${ALPHA_SKIP_OLD}" 1 "destructive: dry-run spawn skip lines for ${ALPHA} in ${ALPHA_OLD_DIR}"

# In order: teardown complete, then the new persona-start, then reload-applied.
teardown_ln="$(first_log_line "${TEARDOWN_COMPLETE}")"
start_ln="$(last_log_line "${ALPHA_START}")"
applied_ln="$(first_log_line "${APPLIED_CLASS}")"
if [[ -z "${teardown_ln}" || -z "${start_ln}" || -z "${applied_ln}" ]] \
    || (( teardown_ln >= start_ln || start_ln >= applied_ln )); then
    fail "destructive: expected teardown complete < persona-start < reload-applied, got lines ${teardown_ln}, ${start_ln}, ${applied_ln}"
fi

got="$(count_log "(key=${BRAVO_KEY})")"
[[ "${got}" == "${bravo_lines}" ]] \
    || fail "destructive: ${BRAVO} got $(( got - bravo_lines )) new line(s) from ${ALPHA}'s change"

[[ ! -e "${APPLY}" ]] || fail "destructive: ${APPLY} still present after the apply"
wait_until "${SETTLE_WAIT_S}" "destructive: ${PENDING} still present after the apply" pending_gone
cmp -s "${CONFIG}" "${LAST}" || fail "destructive: ${LAST} does not hold config.json's bytes after the apply"
expect_no_reload_errors destructive

# --- 2. Server-wide change: port ------------------------------------------
alpha_lines="$(count_log "(key=${ALPHA_KEY})")"
bravo_lines="$(count_log "(key=${BRAVO_KEY})")"

set_config "${ALPHA_NEW_DIR}" "${NEW_PORT}"
wait_for_log "${PORT_LOG}" "${TICK_WAIT_S}" "port: no reload-preview line for the port change"
expect_log "${HEADER_PORT}" "port: reload-preview header lacks '$(counts settings=1)'"
expect_count "${DESTRUCTIVE_LOG}" 1 "port: DESTRUCTIVE: reload-preview lines (only the first change's)"

wait_for_file "${PENDING}" "${SETTLE_WAIT_S}" "port: ${PENDING} never appeared"
check_pending_layout port settings=1
pending_copy="$(snapshot_pending port)"
(( $(count_in "${pending_copy}" "${PORT_SETTING}") == 1 )) || fail "port: pending file lacks the port setting line"
if grep -qF 'DESTRUCTIVE:' "${pending_copy}"; then
    fail "port: pending file holds a DESTRUCTIVE: line"
fi
wait_until 10 "port: the pending file's lines were not all logged as reload-preview lines" \
    preview_logged "${pending_copy}"

confirm_pending port
wait_for_count "${APPLIED_CLASS}" 2 "${TICK_WAIT_S}" "port: no reload-applied line after the confirmation"
expect_count "${APPLIED_CLASS}" 2 "port: reload-applied lines"
expect_log "${APPLIED_PORT}" "port: reload-applied line lacks '$(counts settings=1)' or the record path"

got="$(record_port)"
[[ "${got}" == "${NEW_PORT}" ]] || fail "port: ${LAST} holds port '${got}', expected ${NEW_PORT}"
cmp -s "${CONFIG}" "${LAST}" || fail "port: ${LAST} does not hold config.json's bytes after the apply"
[[ ! -e "${APPLY}" ]] || fail "port: ${APPLY} still present after the apply"
wait_until "${SETTLE_WAIT_S}" "port: ${PENDING} still present after the apply" pending_gone

# The listener stays on the start-time port until the next start.
status="$(interject_status "${SCENARIO_TAG}_no_such_persona" "${OLD_PORT}")"
[[ "${status}" == 404 ]] \
    || fail "port: /interject on the old port ${OLD_PORT} returned ${status}, expected 404"
if port_listening "${NEW_PORT}"; then
    fail "port: something answers on the new port ${NEW_PORT} before a restart"
fi
expect_count "${LISTENING_NEW}" 0 "port: listener lines for the new port before a restart"

# No persona is torn down or brought up for a server-wide change.
got="$(count_log "(key=${ALPHA_KEY})")"
[[ "${got}" == "${alpha_lines}" ]] || fail "port: ${ALPHA} got $(( got - alpha_lines )) new line(s)"
got="$(count_log "(key=${BRAVO_KEY})")"
[[ "${got}" == "${bravo_lines}" ]] || fail "port: ${BRAVO} got $(( got - bravo_lines )) new line(s)"
expect_no_reload_errors port

# --- 3. Restart from the record: the new port takes effect -----------------
# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server
wait_until "${SETTLE_WAIT_S}" "stop: port ${OLD_PORT} still answers after stop" port_closed "${OLD_PORT}"

completes="$(count_log "${STARTUP_COMPLETE}")"
from_record="$(count_log "${FROM_RECORD}")"
# shellcheck disable=SC2119 # dry-run start: no --live
start_server
wait_for_count "${FROM_RECORD}" $(( from_record + 1 )) "${START_LINE_WAIT_S}" \
    "restart: the start did not run the last-applied record"
wait_for_log "${LISTENING_NEW}" "${START_LINE_WAIT_S}" \
    "restart: server.log never showed the listener on the new port ${NEW_PORT}"
wait_until "${SETTLE_WAIT_S}" "restart: nothing answers on the new port ${NEW_PORT}" port_listening "${NEW_PORT}"
if port_listening "${OLD_PORT}"; then
    fail "restart: something answers on the old port ${OLD_PORT}"
fi
status="$(interject_status "${SCENARIO_TAG}_no_such_persona" "${NEW_PORT}")"
[[ "${status}" == 404 ]] \
    || fail "restart: /interject on the new port ${NEW_PORT} returned ${status}, expected 404"
wait_for_count "${STARTUP_COMPLETE}" $(( completes + 1 )) "${START_LINE_WAIT_S}" \
    "restart: startupSessionManager never completed for 2 personas"
expect_count "${ALPHA_SKIP_NEW}" 2 "restart: dry-run spawn skip lines for ${ALPHA} in ${ALPHA_NEW_DIR}"
expect_count "${ALPHA_SKIP_OLD}" 1 "restart: dry-run spawn skip lines for ${ALPHA} in ${ALPHA_OLD_DIR}"
expect_no_reload_errors restart

# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server
wait_until "${SETTLE_WAIT_S}" "stop: port ${NEW_PORT} still answers after stop" port_closed "${NEW_PORT}"

echo "PASS: ${TEST_NAME}"
