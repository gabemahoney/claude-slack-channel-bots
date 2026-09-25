#!/usr/bin/env bash
# Test 6 (E5, b.av2 SR-6.4 directory-broken; bug b.g57 claude_config_dir hold):
# a persona whose working directory does not exist stays down and is
# re-checked on its own timer while a healthy persona serves; it comes up,
# with no confirmation, once the directory is created. A second leg does the
# same for a persona whose claude_config_dir is a dangling symlink: it is held
# (no Slack connection, no launch) and comes up once the symlink's target
# exists. Both checks and their retries run in dry run as in a real start
# (src/persona-bringup-controller.ts, "Dry run").
#
# One config, in the scenario's own state dir and port, with:
#   personas[0] "<tag>_ready"   existing working directory: up, spawn skipped;
#   personas[1] "<tag>_nodir"   working directory not created yet;
#   personas[2] "<tag>_cfgheld" existing working directory, claude_config_dir
#                               a symlink to a directory not created yet.
# health_check_interval 0: no health tick, so nothing but the bring-up and
# its retries launches (each skip line is counted).
#
# Retry timing (createPersonaRetrySchedule, src/persona-retry-schedule.ts):
# re-checks 5 s, 10 s, 20 s, 40 s … after the failed check (at bring-up +5,
# +15, +35, +75 s), up to 300 s, no cap. A re-check that still fails logs
# nothing, so the wait past the first re-check is timed from the failure
# line's own timestamp (server.log lines are "[<ISO time>] <message>").
#
# Lines are matched by class prefix, persona ref and distinguishing fragments
# (E14 decision 14; lib/scenario.sh "Matchers"), never as whole sentences.
# "…" marks text the match skips:
#   [slack] Loaded persona config: 3 persona(s)                      src/server.ts
#   [slack] persona-start: personas[<i>] "<name>" (key=<key>) …
#               src/persona-bringup-controller.ts bringUp; format src/persona-diagnostics.ts
#   [slack] persona-directory-missing: personas[<i>] "<name>" (key=<key>) path="<dir>": … does not exist
#               src/persona-bringup.ts checkPersonaWorkingDirectory
#   [slack] persona-config-dir-unresolvable: personas[<i>] "<name>" (key=<key>) path="<dir>": … cannot be resolved …
#               src/persona-bringup.ts checkPersonaConfigDir (logged by the controller's holdBeforeSlack)
#   [slack] startupSessionManager: complete — 3 persona(s): … 1 no-op, 0 failed, 2 not brought up
#               src/session-manager.ts startupSessionManager
#   [slack] dry-run: skipping spawn for "<name>" (key=<key>) cwd=<dir>
#               src/session-manager.ts spawnForPersona
#   [slack] /interject: refused for persona "<name>" (key=<key>) …
#               src/interject.ts handleInterject
#   <either diagnostic prefix above> cleared: … continuing the bring-up
#   [slack] persona "<name>" (key=<key>): up after … (directory) … — launching
#   [slack] persona "<name>" (key=<key>): up after … claude_config_dir … — launching
#               src/persona-bringup-controller.ts recheckDirectory / recheckConfigDir / launchUp
# /interject bodies (src/interject.ts): "Persona is not up" (503) for a
# persona that is not up, "No active session for this persona" (503) for one
# that is up with no session (dry run launches none).
set -euo pipefail

TEST_NAME="test-6-missing-working-dir"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on the start's bring-up pass reaching its completion line (dry run:
# about a second).
BRINGUP_WAIT_S=60
# How long after a persona's failure line the script waits before checking
# that the first re-check (at +5 s) logged nothing: 3 s of margin.
PAST_FIRST_RETRY_MS=8000
# Bound on recovery after the directories are created. Created about 8 s
# after bring-up, the next re-check is at +15 s (about 7 s later); a script
# delayed past +15 s meets the one at +35 s (at most 27 s later).
RECOVERY_WAIT_S=40

# --- Personas ---------------------------------------------------------------
READY_NAME="${SCENARIO_TAG}_ready"
NODIR_NAME="${SCENARIO_TAG}_nodir"
CFG_NAME="${SCENARIO_TAG}_cfgheld"
NODIR_REF="$(persona_ref "${NODIR_NAME}")"
CFG_REF="$(persona_ref "${CFG_NAME}")"

READY_DIR="$(make_workdir ready)"
CFG_WORKDIR="$(make_workdir cfgheld)"
# Not created until the recovery step.
NODIR_DIR="${SCENARIO_ROOT}/work/nodir"
[[ ! -e "${NODIR_DIR}" ]] || fail "setup: ${NODIR_DIR} exists before the start"

# A claude_config_dir symlink whose target does not exist yet.
CFG_TARGET="${SCENARIO_ROOT}/claude-config-target"
CFG_LINK="${SCENARIO_ROOT}/claude-config-link"
ln -s "${CFG_TARGET}" "${CFG_LINK}" || fail "setup: could not create the claude_config_dir symlink"
[[ -L "${CFG_LINK}" && ! -e "${CFG_LINK}" ]] || fail "setup: ${CFG_LINK} is not a dangling symlink"

# Upper-case letters and digits only (CHANNEL_ID_RE, src/config.ts).
TAG_UPPER="${SCENARIO_TAG^^}"
READY_CHANNEL="C0${TAG_UPPER}READY"
NODIR_CHANNEL="C0${TAG_UPPER}NODIR"
CFG_CHANNEL="C0${TAG_UPPER}CFGHELD"

python3 - "${READY_NAME}" "${NODIR_NAME}" "${CFG_NAME}" \
    "${READY_DIR}" "${NODIR_DIR}" "${CFG_WORKDIR}" "${CFG_LINK}" \
    "${READY_CHANNEL}" "${NODIR_CHANNEL}" "${CFG_CHANNEL}" \
    "${SCENARIO_ROOT}" "${SCENARIO_PORT}" << 'EOF' | write_config
import json, sys
(ready, nodir, cfg, ready_dir, nodir_dir, cfg_workdir, cfg_link,
 ready_ch, nodir_ch, cfg_ch, root, port) = sys.argv[1:]
def persona(name, workdir, channel, **extra):
    entry = {
        "name": name,
        "credentials_file": root + "/credentials-" + name + ".json",
        "working_directory": workdir,
        "channels": [{"id": channel, "delivery": "all"}],
        "permission_prompts": channel,
    }
    entry.update(extra)
    return entry
print(json.dumps({
    "personas": [
        persona(ready, ready_dir, ready_ch),
        persona(nodir, nodir_dir, nodir_ch),
        # No Stop hook for a directory that does not resolve yet.
        persona(cfg, cfg_workdir, cfg_ch, claude_config_dir=cfg_link, stop_hook_bootstrap=False),
    ],
    "bind": "127.0.0.1",
    "port": int(port),
    "health_check_interval": 0,
}, indent=2))
EOF
[[ -s "${SLACK_STATE_DIR}/config.json" ]] || fail "setup: config.json not written"

# --- Expected lines (matchers) ---------------------------------------------
LOG="${SLACK_STATE_DIR}/server.log"

READY_SKIP="$(skip_match "${READY_NAME}" "${READY_DIR}")"
NODIR_SKIP="$(skip_match "${NODIR_NAME}" "${NODIR_DIR}")"
CFG_SKIP="$(skip_match "${CFG_NAME}" "${CFG_WORKDIR}")"

NODIR_DIAG="[slack] persona-directory-missing: personas[1] ${NODIR_REF} path=\"${NODIR_DIR}\": "
NODIR_MISSING="$(matcher "${NODIR_DIAG}" 'does not exist')"
NODIR_CLEARED="$(matcher "${NODIR_DIAG}cleared:" 'continuing the bring-up')"
NODIR_UP="$(matcher "[slack] persona ${NODIR_REF}: up after" '(directory)' '— launching')"

CFG_DIAG="[slack] persona-config-dir-unresolvable: personas[2] ${CFG_REF} path=\"${CFG_LINK}\": "
CFG_HELD="$(matcher "${CFG_DIAG}" 'cannot be resolved')"
CFG_CLEARED="$(matcher "${CFG_DIAG}cleared:" 'continuing the bring-up')"
CFG_UP="$(matcher "[slack] persona ${CFG_REF}: up after" 'claude_config_dir' '— launching')"

# --- Helpers ----------------------------------------------------------------
now_ms() {
    date +%s%3N
}

# The epoch time in ms of the first server.log line matching <matcher>, from
# its "[<ISO time>] " prefix.
log_line_ms() {
    local line_no line ms
    local re='^\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)\] '
    line_no="$(first_log_line "$1")"
    [[ -n "${line_no}" ]] || fail "timing: no server.log line matching '$(matcher_text "$1")'"
    line="$(sed -n "${line_no}p" "${LOG}")"
    [[ "${line}" =~ ${re} ]] || fail "timing: server.log line ${line_no} has no timestamp"
    ms="$(date -d "${BASH_REMATCH[1]}" +%s%3N)" || fail "timing: cannot parse the timestamp '${BASH_REMATCH[1]}'"
    printf '%s\n' "${ms}"
}

now_at_least() {
    (( $(now_ms) >= $1 ))
}

# --- Start: the healthy persona serves, the other two are not brought up ----
# shellcheck disable=SC2119 # dry-run start: no --live
start_server

wait_for_log "$(completion_match 3)" "${BRINGUP_WAIT_S}" \
    "start: server.log never showed the startupSessionManager completion line for 3 personas"

expect_count '[slack] Running in dry-run mode' 1 "dry run"
expect_count '[slack] Loaded persona config: 3 persona(s)' 1 "config load"
expect_count "$(persona_start_match 0 "${READY_NAME}")" 1 "persona-start ready"
expect_count "$(persona_start_match 1 "${NODIR_NAME}")" 1 "persona-start nodir"
expect_count "$(persona_start_match 2 "${CFG_NAME}")" 1 "persona-start cfgheld"

expect_count "${NODIR_MISSING}" 1 "start: missing working directory"
expect_count "${CFG_HELD}" 1 "start: dangling claude_config_dir"
expect_count "${READY_SKIP}" 1 "start: healthy persona's spawn skip"

# Neither held persona got anywhere near a launch.
for line in "${NODIR_CLEARED}" "${NODIR_UP}" "${NODIR_SKIP}" "${CFG_CLEARED}" "${CFG_UP}" "${CFG_SKIP}"; do
    expect_count "${line}" 0 "start: held persona came up early"
done
expect_count "[slack] persona-directory-missing: personas[0] " 0 "start: healthy persona's directory"
expect_count "[slack] persona-directory-missing: personas[2] " 0 "start: cfgheld persona's directory"
expect_count "[slack] persona-config-dir-unresolvable: personas[0] " 0 "start: healthy persona's claude_config_dir"
expect_count "[slack] persona-config-dir-unresolvable: personas[1] " 0 "start: nodir persona's claude_config_dir"

expect_count "$(completion_match 3)" 1 "completion"
expect_completion 3 "completion" '1 no-op' '0 failed' '2 not brought up'

# The healthy persona is up (known, no session); the held ones are not up.
expect_interject "${READY_NAME}" 503 "start: healthy persona" 'No active session for this persona'
expect_interject "${NODIR_NAME}" 503 "start: missing-directory persona" 'Persona is not up'
expect_interject "${CFG_NAME}" 503 "start: held claude_config_dir persona" 'Persona is not up'
expect_count "$(matcher "[slack] /interject: refused for persona ${NODIR_REF}" 'not up')" 1 \
    "start: /interject refusal line for nodir"

# --- Past the first re-check: still down, and no line repeated --------------
nodir_failed_ms="$(log_line_ms "${NODIR_MISSING}")"
cfg_failed_ms="$(log_line_ms "${CFG_HELD}")"
past_ms=$(( (nodir_failed_ms > cfg_failed_ms ? nodir_failed_ms : cfg_failed_ms) + PAST_FIRST_RETRY_MS ))
wait_until 30 "retry: clock never passed the first re-check" now_at_least "${past_ms}"

expect_count "${NODIR_MISSING}" 1 "retry: missing-directory line logged again on a re-check"
expect_count "${CFG_HELD}" 1 "retry: claude_config_dir line logged again on a re-check"
for line in "${NODIR_CLEARED}" "${NODIR_UP}" "${NODIR_SKIP}" "${CFG_CLEARED}" "${CFG_UP}" "${CFG_SKIP}"; do
    expect_count "${line}" 0 "retry: held persona came up before its directory existed"
done
expect_interject "${NODIR_NAME}" 503 "retry: missing-directory persona" 'Persona is not up'
expect_interject "${CFG_NAME}" 503 "retry: held claude_config_dir persona" 'Persona is not up'

# --- Create the directories: both come up with no confirmation --------------
created_dir="$(make_workdir nodir)"
[[ "${created_dir}" == "${NODIR_DIR}" ]] || fail "recover: created ${created_dir}, expected ${NODIR_DIR}"
mkdir "${CFG_TARGET}" || fail "recover: could not create ${CFG_TARGET}"
[[ -d "${CFG_LINK}" ]] || fail "recover: ${CFG_LINK} does not resolve to a directory"

wait_for_log "${NODIR_SKIP}" "${RECOVERY_WAIT_S}" \
    "recover: the missing-directory persona never launched after its directory was created"
wait_for_log "${CFG_SKIP}" "${RECOVERY_WAIT_S}" \
    "recover: the held persona never launched after its claude_config_dir resolved"

expect_count "${NODIR_CLEARED}" 1 "recover: directory cleared line"
expect_count "${NODIR_UP}" 1 "recover: up after the directory retry"
expect_count "${NODIR_SKIP}" 1 "recover: missing-directory persona's spawn skip"
expect_count "${CFG_CLEARED}" 1 "recover: claude_config_dir cleared line"
expect_count "${CFG_UP}" 1 "recover: up after the claude_config_dir resolved"
expect_count "${CFG_SKIP}" 1 "recover: held persona's spawn skip"

# Nothing repeated and nothing else relaunched.
expect_count "${NODIR_MISSING}" 1 "recover: missing-directory line"
expect_count "${CFG_HELD}" 1 "recover: claude_config_dir line"
expect_count "${READY_SKIP}" 1 "recover: healthy persona's spawn skip"
expect_count '[slack] persona-start: ' 3 "recover: persona-start lines"

# Each recovery line order: cleared, then up, then the spawn skip.
# <label> <cleared> <up> <skip> (matchers).
check_recovery_order() {
    local label="$1" cleared_no up_no skip_no
    cleared_no="$(first_log_line "$2")"
    up_no="$(first_log_line "$3")"
    skip_no="$(first_log_line "$4")"
    (( cleared_no < up_no && up_no < skip_no )) \
        || fail "recover ${label}: lines out of order (cleared ${cleared_no}, up ${up_no}, skip ${skip_no})"
}
check_recovery_order nodir "${NODIR_CLEARED}" "${NODIR_UP}" "${NODIR_SKIP}"
check_recovery_order cfgheld "${CFG_CLEARED}" "${CFG_UP}" "${CFG_SKIP}"

expect_interject "${NODIR_NAME}" 503 "recover: missing-directory persona" 'No active session for this persona'
expect_interject "${CFG_NAME}" 503 "recover: held claude_config_dir persona" 'No active session for this persona'
expect_interject "${READY_NAME}" 503 "recover: healthy persona" 'No active session for this persona'

n="$(count_token_like "${LOG}" "${START_OUT}")"
[[ "${n}" == 0 ]] || fail "secrecy: ${n} token-like string(s) in server.log or the start output"

# --- Stop -------------------------------------------------------------------
# stop_server fails unless the daemon in server.pid is gone.
# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server
wait_until 10 "stop: port ${SCENARIO_PORT} still answering after stop" port_closed "${SCENARIO_PORT}"

echo "PASS: ${TEST_NAME}"
