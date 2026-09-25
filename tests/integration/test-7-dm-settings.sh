#!/usr/bin/env bash
# Test 7 (t3.ob2.5e.u7.wa): the DMs switch and a `dm` permission-prompt
# destination load and validate from a clean install, and invalid DM settings
# refuse the start (b.av2 SR-1.2, SR-1.5; E6/E7).
#
# Valid leg: one config in the scenario's own state dir, shaped like the
# README's complete example (a shared channel, a DM-only persona, `dm`
# destinations), with every path under the scenario's scratch root:
#   personas[0] planner    two channels (one shared), DMs off, channel destination
#   personas[1] reviewer   the shared channel (mentions), DMs on, `dm` destination, U contact
#   personas[2] helpdesk   DM-only (no channels), `dm` destination, W contact
#   personas[3] frontdesk  a private (G) channel, DMs on, channel destination, no contact
# A dry-run start loads all four: `Loaded persona config: 4 persona(s)`, no
# `Fatal:` line, the completion line with 0 failed and 0 not brought up, the
# last-applied record written and the daemon running. Then the server is
# stopped. (Per-persona start and spawn-skip lines and /interject by persona
# are test-5's; this leg proves the DM settings load.)
#
# Invalid legs (a table, each in a fresh scratch state dir with no record):
# a valid persona at personas[0] and a bad one at personas[1]. Each `start`
# exits non-zero with a `Fatal: configuration error — ` line that names
# personas[1] by its ref and the offending settings (as tests/config.test.ts
# checks them: the setting names, not the rule's sentence) and not
# personas[0], never echoes the rejected value, and leaves no server process,
# no PID file, no listener and no config.json.last-applied.
#
# Dry run throughout: no credentials file exists or is read (SR-3.4), no
# token is used, no Slack call is made. Nothing here reads or writes HOME's
# state dir; claude_config_dir is left unset so no Claude settings file is
# patched.
set -euo pipefail

TEST_NAME="test-7-dm-settings"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on the start bring-up pass finishing after `start` returned, in s.
BRINGUP_WAIT_S=60

# src/reload.ts CONFIG_REFUSAL_PREFIX.
FATAL_PREFIX='[slack] Fatal: configuration error — '
# src/cli.ts reportDaemonFailure.
START_FAILED_PREFIX='[slack] Server failed to start ('

# Print the PIDs (one per line) of every CSCB `start` process (the CLI or
# the daemon it spawned: argv ends in `start`, src/cli.ts start) whose
# environment names state dir $1 as SLACK_STATE_DIR. The daemon inherits the
# variable (childEnv = process.env). Helper subprocesses (agent-director's
# CLI transport, for example) are not counted. The scan itself runs without
# the variable, and a process's environ is the one it was exec'd with, so
# this shell never matches.
state_dir_pids() {
    env -u SLACK_STATE_DIR python3 - "$1" << 'EOF'
import os, sys
want = b"SLACK_STATE_DIR=" + os.fsencode(sys.argv[1])
me = os.getpid()
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) == me:
        continue
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            env = f.read().split(b"\0")
    except OSError:
        continue
    if want not in env:
        continue
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().rstrip(b"\0").split(b"\0")
    except OSError:
        continue
    if argv and argv[-1] == b"start":
        print(pid)
EOF
}

# True when no process names state dir $1 (a `wait_until` command).
no_state_dir_pids() {
    [[ -z "$(state_dir_pids "$1")" ]]
}

# JSON of one persona entry's common fields: name, credentials file and
# working directory (neither needs to exist for the loader).
persona_head() {
    local name="$1" workdir="$2"
    printf '"name": "%s", "credentials_file": "%s/creds/%s.json", "working_directory": "%s"' \
        "${name}" "${SCENARIO_ROOT}" "${name}" "${workdir}"
}

# ---------------------------------------------------------------------------
# Valid leg
# ---------------------------------------------------------------------------

PLANNER="${SCENARIO_TAG}_planner"
REVIEWER="${SCENARIO_TAG}_reviewer"
HELPDESK="${SCENARIO_TAG}_helpdesk"
FRONTDESK="${SCENARIO_TAG}_frontdesk"
VALID_NAMES=("${PLANNER}" "${REVIEWER}" "${HELPDESK}" "${FRONTDESK}")

declare -A WORKDIR
for name in "${VALID_NAMES[@]}"; do
    dir="$(make_workdir "${name}")"
    WORKDIR[${name}]="${dir}"
done

write_config << EOF
{
  "personas": [
    {
      $(persona_head "${PLANNER}" "${WORKDIR[${PLANNER}]}"),
      "channels": [
        { "id": "C0T7HOME1", "delivery": "all" },
        { "id": "C0T7SHARED", "delivery": "all" }
      ],
      "dm": { "enabled": false },
      "permission_prompts": "C0T7HOME1"
    },
    {
      $(persona_head "${REVIEWER}" "${WORKDIR[${REVIEWER}]}"),
      "channels": [
        { "id": "C0T7SHARED", "delivery": "mentions" }
      ],
      "dm": { "enabled": true, "contact": "U0T7CONTACT1" },
      "permission_prompts": "dm"
    },
    {
      $(persona_head "${HELPDESK}" "${WORKDIR[${HELPDESK}]}"),
      "dm": { "enabled": true, "contact": "W0T7CONTACT2" },
      "permission_prompts": "dm"
    },
    {
      $(persona_head "${FRONTDESK}" "${WORKDIR[${FRONTDESK}]}"),
      "channels": [
        { "id": "G0T7PRIVATE", "delivery": "all" }
      ],
      "dm": { "enabled": true },
      "permission_prompts": "G0T7PRIVATE"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT}
}
EOF

# shellcheck disable=SC2119 # dry-run start: no --live
start_server

wait_for_log "$(completion_match "${#VALID_NAMES[@]}")" "${BRINGUP_WAIT_S}" \
    "valid: the start bring-up pass never logged its completion line for ${#VALID_NAMES[@]} personas"
expect_completion "${#VALID_NAMES[@]}" "valid" '0 failed' '0 not brought up'

expect_count '[slack] Running in dry-run mode' 1 "valid: dry-run mode line"
expect_count "[slack] Loaded persona config: ${#VALID_NAMES[@]} persona(s)" 1 "valid: config load"
expect_count '[slack] Fatal: ' 0 "valid: a Fatal: line"

[[ -f "${SLACK_STATE_DIR}/config.json.last-applied" ]] \
    || fail "valid: config.json.last-applied was not written"

pid_alive "${SERVER_PID}" || fail "valid: daemon PID ${SERVER_PID} is not running after the bring-up pass"
scanned_pids="$(state_dir_pids "${SLACK_STATE_DIR}")"
grep -qx -- "${SERVER_PID}" <<< "${scanned_pids}" \
    || fail "valid: the process scan does not find daemon PID ${SERVER_PID} (the no-process check would be vacuous)"

# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server

no_state_dir_pids "${SLACK_STATE_DIR}" \
    || fail "valid: a process with this state dir is still running after stop"
wait_until 10 "valid: something still answers on port ${SCENARIO_PORT} after stop" \
    port_closed "${SCENARIO_PORT}"

# ---------------------------------------------------------------------------
# Invalid legs
# ---------------------------------------------------------------------------

# Each case: a name suffix, the bad persona's fields after its head, and the
# settings the refusal names for it, in the order the loader names them
# (src/config.ts parseDm and checkPersonaCrossSettings; the same setting
# names tests/config.test.ts checks).
INVALID_CASES=(
    dm_no_contact
    dm_not_enabled
    dm_neither
    no_channels_dms_off
    no_channels_dm_omitted
    bad_contact
)

# The rejected dm.contact value of the bad_contact case: a lowercase user ID.
# It must never be echoed.
BAD_CONTACT="u0t7lowercase"

invalid_fields() {
    case "$1" in
        dm_no_contact)
            printf '%s' '"dm": { "enabled": true }, "permission_prompts": "dm"' ;;
        dm_not_enabled)
            printf '%s' '"channels": [ { "id": "C0T7HOME2", "delivery": "all" } ], "dm": { "enabled": false, "contact": "U0T7CONTACT3" }, "permission_prompts": "dm"' ;;
        dm_neither)
            printf '%s' '"channels": [ { "id": "C0T7HOME2", "delivery": "all" } ], "permission_prompts": "dm"' ;;
        no_channels_dms_off)
            printf '%s' '"channels": [], "dm": { "enabled": false, "contact": "U0T7CONTACT3" }, "permission_prompts": "dm"' ;;
        no_channels_dm_omitted)
            printf '%s' '"permission_prompts": "C0T7HOME2"' ;;
        bad_contact)
            printf '"dm": { "enabled": true, "contact": "%s" }, "permission_prompts": "dm"' "${BAD_CONTACT}" ;;
        *) fail "invalid_fields: unknown case '$1'" ;;
    esac
}

# The settings the refusal names, one per line.
invalid_settings() {
    case "$1" in
        dm_no_contact) printf '%s\n' permission_prompts dm.contact ;;
        dm_not_enabled) printf '%s\n' permission_prompts dm.enabled ;;
        dm_neither) printf '%s\n' permission_prompts dm.contact dm.enabled ;;
        no_channels_dms_off | no_channels_dm_omitted) printf '%s\n' dm.enabled ;;
        bad_contact) printf '%s\n' dm.contact ;;
        *) fail "invalid_settings: unknown case '$1'" ;;
    esac
}

GOOD_NAME="${SCENARIO_TAG}_good"
GOOD_WORKDIR="${SCENARIO_ROOT}/work/${GOOD_NAME}"

for case_name in "${INVALID_CASES[@]}"; do
    step="invalid ${case_name}"
    bad_name="${SCENARIO_TAG}_${case_name}"
    bad_key="$(persona_key "${bad_name}")"
    fields="$(invalid_fields "${case_name}")"
    mapfile -t settings < <(invalid_settings "${case_name}")
    (( ${#settings[@]} > 0 )) || fail "${step}: no settings listed for the case"

    new_state_dir "invalid-${case_name}"
    [[ ! -e "${SLACK_STATE_DIR}/config.json.last-applied" ]] \
        || fail "${step}: the fresh state dir already holds a record"
    port="$(free_port)"

    write_config << EOF
{
  "personas": [
    {
      $(persona_head "${GOOD_NAME}" "${GOOD_WORKDIR}"),
      "channels": [ { "id": "C0T7HOME1", "delivery": "all" } ],
      "dm": { "enabled": true, "contact": "U0T7CONTACT1" },
      "permission_prompts": "dm"
    },
    {
      $(persona_head "${bad_name}" "${SCENARIO_ROOT}/work/${bad_name}"),
      ${fields}
    }
  ],
  "bind": "127.0.0.1",
  "port": ${port}
}
EOF

    run_start

    if [[ "${START_RC}" -eq 0 ]]; then
        cat "${START_OUT}" >&2
        fail "${step}: start exited 0 (expected a refused start)"
    fi

    grep -qF -- "${START_FAILED_PREFIX}" "${START_OUT}" || {
        cat "${START_OUT}" >&2
        fail "${step}: start output lacks '${START_FAILED_PREFIX}'"
    }
    # The refusal: the class prefix, then personas[1]'s ref, then each
    # offending setting (in the loader's order), on one line.
    refusal="$(matcher "${FATAL_PREFIX}" "personas[1] \"${bad_name}\" (key=${bad_key})" "${settings[@]}")"
    (( $(count_in "${START_OUT}" "${refusal}") >= 1 )) || {
        cat "${START_OUT}" >&2
        fail "${step}: start output lacks the refusal naming personas[1] and ${settings[*]}"
    }
    expect_count "${refusal}" 1 "${step}: server.log does not hold the refusal exactly once"
    # Only the bad persona is named.
    expect_count "$(matcher "${FATAL_PREFIX}" 'personas[0]')" 0 "${step}: the refusal names personas[0]"
    expect_count '[slack] Loaded persona config:' 0 "${step}: server.log shows the refused config loaded"

    if [[ "${case_name}" == bad_contact ]]; then
        if grep -qF -- "${BAD_CONTACT}" "${START_OUT}" "${SLACK_STATE_DIR}/server.log"; then
            fail "${step}: the rejected dm.contact value was echoed"
        fi
    fi

    [[ ! -e "${SLACK_STATE_DIR}/config.json.last-applied" ]] \
        || fail "${step}: config.json.last-applied was written for a refused start"
    [[ ! -e "${SLACK_STATE_DIR}/server.pid" ]] \
        || fail "${step}: server.pid was written for a refused start"
    # `start` reported failure only once the daemon exited (src/cli.ts
    # awaitDaemonStartup); still bounded, in case it lingers.
    wait_until 10 "${step}: a process with this state dir is still running" \
        no_state_dir_pids "${SLACK_STATE_DIR}"
    if port_listening "${port}"; then
        fail "${step}: something answers on port ${port} after the refused start"
    fi
done

echo "PASS: ${TEST_NAME}"
