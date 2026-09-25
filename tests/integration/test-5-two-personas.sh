#!/usr/bin/env bash
# Test 5 (E3/E4, E9): two personas start from one config, each with its own
# identity and its own working directory, and the start lines name both.
#
# One config, in the scenario's own state dir and port, with:
#   personas[0] "<tag>_alpha"     key form (its key is its name), one channel,
#                                 prompts to that channel;
#   personas[1] "<TAG> Bravo Bot" not in key form (a space and capitals, so
#                                 its key is derived), DM-only (no channels,
#                                 DMs on, prompts by DM);
# and E9's reply settings (`ack_reaction`, `reply_chunk_limit`,
# `reply_chunk_mode`, each set to a non-default value) at the top level, as a
# load smoke: the start is not refused. Each persona has its own working
# directory, made by the script. Dry run: no credentials file is read
# (neither file exists) and spawns are skipped.
#
# There is no single start-summary line naming every persona: the
# per-persona `persona-start` lines plus the startupSessionManager
# completion line are the summary. Each persona's placeholder Slack identity
# is never logged in dry run; test-10 (Slack stub) covers per-persona tokens.
#
# Lines are matched by class prefix, persona ref and distinguishing fragments
# (E14 decision 14; lib/scenario.sh "Matchers"), never as whole sentences:
#   [slack] Loaded persona config: 2 persona(s)                    src/server.ts
#   [slack] No last-applied record: … "<cfg>" … "<cfg>.last-applied"
#                                                                  src/reload.ts resolveStart
#   [slack] startupSessionManager: 2 persona(s), …                 src/session-manager.ts startupSessionManager
#   [slack] persona-start: personas[<i>] "<name>" (key=<key>) …    src/persona-bringup-controller.ts bringUp
#   [slack] dry-run: skipping spawn for "<name>" (key=<key>) cwd=<dir>
#                                                                  src/session-manager.ts spawnForPersona
#   [slack] startupSessionManager: complete — 2 persona(s): … 2 no-op, 0 failed, 0 not brought up
#                                                                  src/session-manager.ts startupSessionManager
#   [slack] Fatal: …  (a refused start; none expected)             src/reload.ts
# /interject (src/interject.ts): 404 for no applied persona with that exact
# name or key, 503 for a known persona that is not up or has no session.
set -euo pipefail

TEST_NAME="test-5-two-personas"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on the start's bring-up pass reaching its completion line. Dry run
# makes no Slack call and the directories exist, so it takes about a second.
BRINGUP_WAIT_S=60

# --- Personas ---------------------------------------------------------------
ALPHA_NAME="${SCENARIO_TAG}_alpha"
BRAVO_NAME="${SCENARIO_TAG^^} Bravo Bot"
ALPHA_KEY="$(persona_key "${ALPHA_NAME}")"
BRAVO_KEY="$(persona_key "${BRAVO_NAME}")"

[[ "${ALPHA_KEY}" == "${ALPHA_NAME}" ]] \
    || fail "setup: persona name '${ALPHA_NAME}' is not in key form (key ${ALPHA_KEY})"
[[ "${BRAVO_KEY}" != "${BRAVO_NAME}" ]] \
    || fail "setup: persona name '${BRAVO_NAME}' was meant to have a derived key"

ALPHA_DIR="$(make_workdir alpha)"
BRAVO_DIR="$(make_workdir bravo)"
[[ "${ALPHA_DIR}" != "${BRAVO_DIR}" ]] || fail "setup: both personas got one working directory"

# Upper-case letters and digits only (CHANNEL_ID_RE / DM_CONTACT_RE, src/config.ts).
TAG_UPPER="${SCENARIO_TAG^^}"
ALPHA_CHANNEL="C0${TAG_UPPER}ALPHA"
BRAVO_CONTACT="U0${TAG_UPPER}BRAVO"

python3 - "${ALPHA_NAME}" "${BRAVO_NAME}" "${ALPHA_DIR}" "${BRAVO_DIR}" \
    "${ALPHA_CHANNEL}" "${BRAVO_CONTACT}" "${SCENARIO_ROOT}" "${SCENARIO_PORT}" << 'EOF' | write_config
import json, sys
alpha, bravo, alpha_dir, bravo_dir, channel, contact, root, port = sys.argv[1:]
print(json.dumps({
    "personas": [
        {
            "name": alpha,
            "credentials_file": root + "/credentials-alpha.json",
            "working_directory": alpha_dir,
            "channels": [{"id": channel, "delivery": "all"}],
            "permission_prompts": channel,
        },
        {
            "name": bravo,
            "credentials_file": root + "/credentials-bravo.json",
            "working_directory": bravo_dir,
            "dm": {"enabled": True, "contact": contact},
            "permission_prompts": "dm",
        },
    ],
    "bind": "127.0.0.1",
    "port": int(port),
    # E9's reply settings (src/config.ts: a non-empty string, a positive
    # integer, "length" or "newline"), each off its default.
    "ack_reaction": "eyes",
    "reply_chunk_limit": 2000,
    "reply_chunk_mode": "length",
}, indent=2))
EOF
[[ -s "${SLACK_STATE_DIR}/config.json" ]] || fail "setup: config.json not written"

LOG="${SLACK_STATE_DIR}/server.log"

# --- Start from a clean state dir -------------------------------------------
[[ ! -e "${SLACK_STATE_DIR}/config.json.last-applied" ]] \
    || fail "clean state: config.json.last-applied exists before the first start"
[[ ! -e "${LOG}" ]] || fail "clean state: server.log exists before the first start"

# shellcheck disable=SC2119 # dry-run start: no --live
start_server

wait_for_log "$(completion_match 2)" "${BRINGUP_WAIT_S}" \
    "start: server.log never showed the startupSessionManager completion line for 2 personas"

# --- Config load (E9's settings included) and the last-applied record -------
expect_count '[slack] Running in dry-run mode' 1 "dry run"
expect_count '[slack] Loaded persona config: 2 persona(s)' 1 "config load"
expect_count '[slack] Fatal: ' 0 "config load: the start with E9's reply settings was refused"

CONFIG_FILE="${SLACK_STATE_DIR}/config.json"
RECORD_FILE="${CONFIG_FILE}.last-applied"
[[ -f "${RECORD_FILE}" ]] || fail "last-applied: ${RECORD_FILE} not written at the first start"
cmp -s "${CONFIG_FILE}" "${RECORD_FILE}" \
    || fail "last-applied: ${RECORD_FILE} is not a byte copy of config.json"
expect_count "$(matcher '[slack] No last-applied record:' "\"${CONFIG_FILE}\"" "\"${RECORD_FILE}\"")" 1 \
    "last-applied"

# --- Bring-up: one persona-start and one skip line per persona --------------
expect_count '[slack] startupSessionManager: 2 persona(s),' 1 "startupSessionManager"

expect_count '[slack] persona-start: ' 2 "persona-start: lines in all"
expect_count '[slack] dry-run: skipping spawn for ' 2 "dry-run skip: lines in all"

# <index> <name> <dir> <label>: the persona's persona-start line (its own
# index, name and key) and its skip line (its own cwd), in that order.
check_persona_lines() {
    local index="$1" name="$2" dir="$3" label="$4"
    local start_m skip_m start_no skip_no
    start_m="$(persona_start_match "${index}" "${name}")"
    skip_m="$(skip_match "${name}" "${dir}")"
    expect_count "${start_m}" 1 "persona-start ${label}"
    expect_count "${skip_m}" 1 "dry-run skip ${label}"
    start_no="$(first_log_line "${start_m}")"
    skip_no="$(first_log_line "${skip_m}")"
    (( start_no < skip_no )) \
        || fail "persona ${label}: skip line (line ${skip_no}) came before its persona-start line (line ${start_no})"
}

check_persona_lines 0 "${ALPHA_NAME}" "${ALPHA_DIR}" "alpha"
check_persona_lines 1 "${BRAVO_NAME}" "${BRAVO_DIR}" "bravo (derived key)"

# --- Completion line --------------------------------------------------------
expect_count "$(completion_match 2)" 1 "completion"
expect_completion 2 "completion" '2 no-op' '0 failed' '0 not brought up'

# Neither persona's bring-up reported a problem.
for bad in '[slack] persona-directory-missing: ' '[slack] persona-directory-unusable: ' \
           '[slack] startupSessionManager: unexpected error for '; do
    expect_count "${bad}" 0 "bring-up"
done

n="$(count_token_like "${LOG}" "${START_OUT}")"
[[ "${n}" == 0 ]] || fail "secrecy: ${n} token-like string(s) in server.log or the start output"

# --- /interject: each persona by name and by key, and unknown targets -------
expect_interject "${ALPHA_NAME}" 503 "/interject for alpha by name (= key), known with no session"
expect_interject "${BRAVO_NAME}" 503 "/interject for bravo by name, known with no session"
expect_interject "${BRAVO_KEY}" 503 "/interject for bravo by its derived key, known with no session"
expect_interject "${SCENARIO_TAG}_nobody" 404 "/interject for an unknown persona"
# Names match exactly (case-sensitive): bravo's name lower-cased is unknown.
expect_interject "${BRAVO_NAME,,}" 404 "/interject for bravo's name lower-cased"

# --- Stop -------------------------------------------------------------------
# stop_server fails unless the daemon in server.pid is gone.
# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server
if pid_alive "${SERVER_PID}"; then
    fail "stop: server PID ${SERVER_PID} still running"
fi
wait_until 10 "stop: port ${SCENARIO_PORT} still answering after stop" port_closed "${SCENARIO_PORT}"

echo "PASS: ${TEST_NAME}"
