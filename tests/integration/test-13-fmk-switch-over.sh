#!/usr/bin/env bash
# Test 13 (b.jg5 SRJ-1402, SRJ-1108, SRJ-1401, SRJ-1418): scenario 1, the
# switch-over. The script follows the README's switch-over runbook (section
# "Switching over to agent-director Phase 1", steps 1 to 11, each a
# `Step <n>: …` heading) in the container, entering each step once and in
# order, and replaces only the host-only parts SRJ-1402 lists (the
# substitution table below).
#
# Runs only in a cscb-ci image (/ci), after Test 1 (which installs the package
# the default SCENARIO_CLI names). Its TEST_NAME carries `-fmk-` and it sets
# SCENARIO_AD_START=0.10.0 before sourcing lib/scenario.sh, so the scenario
# gets its own HOME, store and tmux server under SCENARIO_ROOT, with
# agent-director 0.10.0 behind the agent-director shim and no store yet
# (0.10.0's first spawn makes it), and the tmux shim in `log` mode in front of
# every CSCB process.
#
# The starting point (setup, before step 1): the pre-persona 0.10.0-era fleet.
# - The published pre-persona CSCB 0.10.0 package (the image's tarball) is
#   installed as the global package, at the scenario's one install path (a bun
#   global install under SCENARIO_ROOT), with agent-director's 0.10.0 client
#   (the image's tarball), never swapped. Its CLI there is the old CLI; the
#   CLI the build under test later has at the same path is the new one.
# - Its pre-persona config.json (two routed channels) sits in the state
#   directory both packages read by default, $HOME/.claude/channels/slack
#   (exported as SLACK_STATE_DIR), with the host's other files the runbook
#   names: a crontable targeting channels, an `/interject` caller file naming
#   channels, access.json, and the Slack token variables (fake tokens, from
#   `fake_token`, in a file never sourced). These are fixtures (ruling Q13).
# - `seed_prepersona_fleet` seeds one row per routed channel on 0.10.0, named
#   and labelled as the old package does (instance id
#   `cscb_<name>_<channel id>`, session `slack_bot_<name>_<channel id>`,
#   labels service=cscb and channel=<channel id>, no persona label), each with
#   a running stub worker. No pre-persona server is started.
# - The loopback Slack stub runs with --record; it maps the personas' fake
#   tokens. The harness writes the fixture install-gate record, holding this
#   container's dated go line; no runbook step writes it.
# - The build under test is unpacked from the image's package-under-test
#   tarball into the staging directory (nothing runs from it), so the runbook
#   the script follows is the staged release's own README; step 1 finishes
#   staging it (its dependencies resolved).
#
# Each step is entered through `runbook_step <n>`, which prints the step's
# heading title as `switch-over.ts steps` reads it from the package in place
# (the staged build up to step 7, the installed build from step 8), fails
# unless <n> is the next step, and, on entering steps 4 to 10, fails if a bot
# server of the scenario runs (a live server.pid, or the port answering). A
# host-only part is replaced only through `runbook_substitute <n> <kind>
# <reason>`, inside step <n>'s section, which records it. Every record a step
# asks for goes to the switch-over log, a file under SCENARIO_ROOT.
#
# SRJ-1402's substitutions (kind: where; what replaces the host-only part):
#   install-gate-fixture       steps 1, 8, 10: the go line is read from, and
#                              the post-install check line written to, the
#                              fixture install-gate record
#   container-settings         steps 1, 8: the timing settings are the
#                              container's (the scenario HOME's
#                              ~/.agent-director/config.toml, through
#                              `switch-over.ts settings`)
#   one-socket                 step 1: C7's socket pinning and its
#                              display-message check run against the
#                              container's one tmux socket
#   claude-code-check-skipped  step 1: the workers are stub-claude.sh
#   staging-build-under-test   steps 1, 7: the release staged, and installed
#                              at step 7, is the build under test (the image's
#                              package-under-test tarball)
#   slack-fixtures             steps 1, 7: the Slack apps and token variables
#                              are the container's fixtures (the loopback
#                              Slack stub); step 7's credentials command
#                              reaches the stub through a curl wrapper first
#                              on its PATH
#   prompt-wording-skipped     steps 1, 10, 11: the §6 orchestrator prompt
#                              wording is skipped
#   autostart-skipped          steps 2, 10: the host's autostart for CSCB
#   harness-stops-agents       step 8: the stop of every other agent is the
#                              harness's (none is seeded)
#   rc-install-script          step 8: the Phase 1 install is the release
#                              candidate's install.sh, and the `serve` restart
#                              and start-time check cover only the container's
#                              agent-director processes
#   no-agents-restarted        step 9: no other agent is started again
#   container-list             step 10: the launch-start check reads the
#                              container's `agent-director list`
#   expire-skipped             step 11: the daily `expire` schedule
#
# The steps (SRJ-1108):
#   1   the go line; `agent-director version` (0.10.0, behind the shim, from
#       the scenario's shell); C7 from the CSCB launcher's environment, the
#       find-missing loop's environment and a seeded worker's environment
#       (one socket path, the pinned one under SCENARIO_ROOT, one HOME); tmux
#       3.2 or later with remain-on-exit off; the staging (dependencies
#       resolved, exact version recorded); the settings on the staged build
#       (no config.toml: the defaults), each window at or above its minimum,
#       the call-timeout need; the persona configuration written to a separate
#       file, its agent_director_call_timeout_ms above the need and its
#       health-check settings set so that health ticks run (Q12); `tmux ls`
#       against `agent-director list`; the rollback copies beside the old
#       version.
#   2   the autostart substitution.
#   3   the old package's own `stop --stop-bots` through the old CLI (a CSCB
#       process, the tmux shim first on its PATH), reading the pre-persona
#       config.json: exit 0, one teardown outcome per routed channel, its
#       agent-director calls through the shim with 0.10.0 behind it.
#   4   `agent-director find-missing`, then at most 5 minutes (the runbook's
#       bound) for every service=cscb row to read ended or missing; each
#       seeded row still present.
#   5   a read-only `tmux ls`: no old session, no live old row.
#   6   not needed (no leftover with a row), recorded.
#   7   the build under test installed over the same install path (no
#       side-by-side path); the release candidate's client swapped in and
#       checked with the image's check; nothing started; the persona
#       configuration put in place as config.json; each persona's credentials
#       file written by the new CLI's `credentials`; the crontable targets and
#       `/interject` callers rewritten to name personas; the new install check
#       passing on the still-installed 0.10.0 with its Phase 1 note.
#   8   the go line; the harness's stop of other agents (none; every non-CSCB
#       row ended or missing, no tmux session left); the store's online
#       backup (`ad_store_backup`); the release candidate's install.sh, run
#       in the scenario HOME as the runbook's install command
#       (`install_ad_rc`: --binary at the image's release-candidate binary,
#       --no-symlink --no-hooks, stdin from /dev/null), then the re-shim;
#       `agent-director version` the release candidate's; no [tmux] table
#       written; no agent-director process older than the install; the
#       settings again on the installed build, with the call-timeout need
#       against config.json; `agent-director list` without
#       ErrConfigMalformed. After the migration a `get` of each seeded row
#       shows no launch_started_at, and the store has its id.
#   9   the no-agents-restarted substitution.
#   10  the new CSCB started live through the CLI at the install path,
#       against the Slack stub, each persona's working directory in the
#       stub's dev-channels mode; each persona's row reads waiting within B,
#       CSCB's launch bound as the installed build computes it from the
#       settings step 8 recorded; `agent-director list --state pending` shows
#       a launch_started_at on every row; the post-install check line is
#       written to the fixture record. Then leg A's checks.
#   11  the expire and prompt-wording substitutions.
#
# Leg A's checks (SRJ-1402, AC 12), each its own `fail` naming the persona or
# row. CSCB's calls are read from the agent-director shim's lines from step
# 10's start on whose parent is a CSCB process (SRJ-1401); a launch's parent
# must be the bot server:
#   - after the migration, a `get` of each seeded row shows no
#     launch_started_at (step 8);
#   - every persona starts fresh once: exactly one plain spawn of its instance
#     id, with no --reuse-finished, no resume and no second launch, and the
#     start pass counts every persona fresh-spawned and none resumed;
#   - pre-persona rows are kept and never resumed: no CSCB call names a
#     seeded instance id, and each seeded row is present (any state);
#   - each persona's dev-channels dialog is cleared through agent-director:
#     read-pane and send-keys calls naming its own row, made by the bot
#     server, before the row read waiting;
#   - no unknown or UNAVAILABLE error leads to a delete, kill or respawn: no
#     CSCB kill or delete and no second launch;
#   - no persona reaches the restart cap: no restart-cap line in server.log
#     and no cap notice in the Slack stub's record;
#   - no post repeats: no two chat.postMessage requests in the stub's record
#     with the same channel and text.
# Health ticks run (Q12): config.json sets health_check_interval, shorter than
# leg A's wait, and session_restart_delay. Once each persona's session is
# connected, the bot server reads each persona's row on at least HEALTH_TICKS
# more ticks, with no reconnect or restart scheduled for it. A tick that
# reconnects or relaunches a persona whose stub holds its MCP session fails
# naming it as a harness defect; no bound, matcher or count is weakened for it.
#
# Text quoted from src/ (and from the published 0.10.0 package), by source:
#   src/persona-identity.ts personaInstanceId: a persona's instance id is
#     `cscb_<key>`
#   src/ad-phase1-types.ts: a reuse spawn carries `--reuse-finished`
#   src/session-manager.ts startupSummaryLine: `[slack]
#     startupSessionManager: complete — <n> persona(s): <n> resumed, <n>
#     fresh-spawned, …` (through scenario.sh's `completion_match`), with
#     `0 not brought up` in its ending
#   src/server.ts: `[slack] Session connected: persona <ref>`
#   src/restart.ts scheduleRestart: `[slack] Scheduling restart for
#     persona=<key>`; the restart path: `[slack] Session alive but
#     disconnected — reconnecting MCP for persona=<key>`; countLaunchFailure:
#     `[slack] Cap reached for persona=`; restartRetryCapSkippedLine: `the
#     persona is at the restart cap`
#   src/health-check.ts: `is at cap — skipping tick`
#   src/session-manager.ts restartCapReachedError: the cap notice's
#     `consecutive session-launch failures — automatic restarts suspended`
#   scripts/install-check.ts renderSuccess: `agent-director install check:
#     OK`, `  version: <version>` and `  note:    <note>`
#   scripts/write-credentials.sh cscb_check: its Slack URL,
#     `https://slack.com/api/<method>`
#   the published 0.10.0 package's src/cli.ts teardownBots: `[slack]
#     teardownBots: channel=<channel id> ` followed by `exited cleanly`,
#     `force-killed` or `already terminal`, and `[slack] teardownBots: pause
#     failed for channel=<channel id> — escalating to kill`
#
# Pinned versions come from the image: the release candidate's from
# /opt/agent-director-rc/client/release.json, 0.10.0 from scenario.sh's
# SCENARIO_AD_010_VERSION, the old CSCB's and the build under test's from
# their tarballs' package.json.
#
# The script ends with the three closing assertions (`assert_no_server_tmux`,
# `assert_no_cscb_include_finished`, `assert_no_cscb_delete`), after checking
# that every runbook step was entered once, in order; the EXIT trap stops the
# bot server (`stop --stop-bots` through the CLI at the install path) and
# enforces the closing assertions.
set -euo pipefail

TEST_NAME="test-13-fmk-switch-over"
# The pre-persona fleet runs on agent-director 0.10.0 (read by scenario.sh).
SCENARIO_AD_START=0.10.0
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# The image's fixed files (docker/Dockerfile.test.base) and pinned versions
# ---------------------------------------------------------------------------

RC_RELEASE_JSON=/opt/agent-director-rc/client/release.json
RC_CLIENT_CHECK=/opt/agent-director-rc/check/rc-client-check.sh
AD_010_CLIENT_TGZ=/opt/agent-director-0.10.0/agent-director-0.10.0.tgz
CSCB_010_TGZ=/opt/claude-slack-channel-bots-0.10.0/claude-slack-channel-bots-0.10.0.tgz
PACKAGE_TGZ=/tmp/package.tgz
SWITCH_OVER_TS="${SCENARIO_FIXTURES}/switch-over.ts"

for f in "${RC_RELEASE_JSON}" "${RC_CLIENT_CHECK}" "${AD_010_CLIENT_TGZ}" "${CSCB_010_TGZ}" "${PACKAGE_TGZ}" "${SWITCH_OVER_TS}"; do
    [[ -f "${f}" ]] || fail "setup: ${f} is missing from the image"
done
RC_VERSION="$(jq -r '.version // empty' "${RC_RELEASE_JSON}")" || fail "setup: could not read ${RC_RELEASE_JSON}"
RC_COMMIT="$(jq -r '.commit // empty' "${RC_RELEASE_JSON}")" || fail "setup: could not read ${RC_RELEASE_JSON}"
[[ -n "${RC_VERSION}" && -n "${RC_COMMIT}" ]] || fail "setup: ${RC_RELEASE_JSON} names no version or no commit"

# tarball_field <tgz> <jq-filter>: a field of the package.json a package tarball holds.
tarball_field() {
    local out
    out="$(tar -xzOf "$1" package/package.json | jq -r "$2 // empty")" || fail "setup: could not read package/package.json from $1"
    [[ -n "${out}" ]] || fail "setup: $1's package.json has no $2"
    printf '%s\n' "${out}"
}
OLD_CSCB_VERSION="$(tarball_field "${CSCB_010_TGZ}" .version)"
PKG_NAME="$(tarball_field "${PACKAGE_TGZ}" .name)"
PKG_VERSION="$(tarball_field "${PACKAGE_TGZ}" .version)"
CLI_NAME="$(tarball_field "${PACKAGE_TGZ}" '.bin | keys[0]')"
[[ "$(tarball_field "${CSCB_010_TGZ}" .name)" == "${PKG_NAME}" ]] \
    || fail "setup: ${CSCB_010_TGZ} is not a ${PKG_NAME} tarball"

# ---------------------------------------------------------------------------
# The scenario's names, files and bounds
# ---------------------------------------------------------------------------

# The host's own files: the install-gate record, the switch-over log, the
# staged persona configuration, the crontable prompts, the /interject callers,
# the token variables and the rollback copies.
HOST_DIR="${SCENARIO_ROOT}/host"
INSTALL_GATE_RECORD="${HOST_DIR}/install-gate-record"
SWITCH_LOG="${HOST_DIR}/switch-over.log"
STAGED_CONFIG="${HOST_DIR}/config.persona.json"
INTERJECT_CALLERS="${HOST_DIR}/interject-callers.sh"
TOKEN_VARS="${HOST_DIR}/slack-token-variables.env"
COPIES_DIR="${HOST_DIR}/rollback-copies"
STORE_BACKUP="${HOST_DIR}/state.db.backup"
SUBSTITUTIONS="${HOST_DIR}/substitutions"

# The global install (bun's global directory and bin directory under
# SCENARIO_ROOT): the scenario's one install path, the old package's and then
# the build under test's.
CSCB_GLOBAL="${SCENARIO_ROOT}/bun-global"
CSCB_PKG_DIR="${CSCB_GLOBAL}/install/global/node_modules/${PKG_NAME}"
CSCB_CLI="${CSCB_GLOBAL}/bin/${CLI_NAME}"
BUN_CACHE="${SCENARIO_ROOT}/bun-cache"

# The staging directory: the build under test unpacked, nothing run from it.
STAGING_DIR="${SCENARIO_ROOT}/staging"
STAGED_PKG="${STAGING_DIR}/package"

# The package `runbook_step` reads the runbook from: the staged build, then
# the installed one from step 8.
RUNBOOK_PKG="${STAGED_PKG}"

# The state directory both packages read by default.
STATE_DIR="${HOME}/.claude/channels/slack"

# The routed channels, their Slack names (the old package reads them from
# Slack, never from config.json) and the persona each becomes.
CHANNELS=(C0T13A01 C0T13B01)
declare -A SLACK_NAME=([C0T13A01]="t13-ops-room" [C0T13B01]="T13 Build Feed")
declare -A PERSONA_OF=([C0T13A01]="${SCENARIO_TAG}_alpha" [C0T13B01]="${SCENARIO_TAG}_bravo")
# Each persona's fake-token label (letters and digits; the Slack stub maps it).
declare -A TOKEN_LABEL=([C0T13A01]="${SCENARIO_TAG}alpha" [C0T13B01]="${SCENARIO_TAG}bravo")

# CSCB's own timings for the new build, set through config.json (SRJ-1401):
# health ticks run (Q12), a restart would come soon enough to be seen, and a
# stop waits briefly for a bot to exit.
HEALTH_CHECK_INTERVAL_S=5
SESSION_RESTART_DELAY_S=30
EXIT_TIMEOUT_S=5
# Health ticks watched once every persona's session is connected.
HEALTH_TICKS=3
# What the persona configuration's agent_director_call_timeout_ms adds to the
# call-timeout need the settings give.
CALL_TIMEOUT_HEADROOM_MS=6000

# The old package's teardown and stop waits, in its pre-persona config.json.
OLD_EXIT_TIMEOUT_S=5
OLD_STOP_TIMEOUT_S=5

# The runbook's own bound in step 4: "wait at most 5 minutes".
STEP4_WAIT_S=300

# Bound on the Slack stub writing its ready file, in seconds.
SLACK_STUB_WAIT_S=20

# Filled in by the steps.
OLD_IDS=()
OLD_SESSIONS=()
OLD_PANES=()
PERSONA_IDS=()
declare -A WORKDIR_OF=()
declare -A WAITING_US=()
declare -A SETTINGS=()
sessions=()
LEG_A_WAIT_S=""
SLACK_STUB_DIR=""
SLACK_RECORD=""

# The runbook's state: the next step, the step being run and the step count.
RUNBOOK_NEXT=1
RUNBOOK_CURRENT=""
RUNBOOK_COUNT=""

# The substitution kinds SRJ-1402 allows (see the table in the header).
SUBSTITUTION_KINDS=(install-gate-fixture container-settings one-socket claude-code-check-skipped
    staging-build-under-test slack-fixtures prompt-wording-skipped autostart-skipped
    harness-stops-agents rc-install-script no-agents-restarted container-list expire-skipped)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# record <text>: one line in the switch-over log, under the step being run.
record() {
    local where=setup
    if [[ -n "${RUNBOOK_CURRENT}" ]]; then
        where="step ${RUNBOOK_CURRENT}"
    fi
    printf '[%s] %s\n' "${where}" "$*" >> "${SWITCH_LOG}" \
        || fail "could not write the switch-over log ${SWITCH_LOG}"
}

# runbook_steps_file <pkg-dir>: print the path of a file holding
# `switch-over.ts steps` for <pkg-dir>; fail with the fixture's reason.
runbook_steps_file() {
    local out="${SCENARIO_ROOT}/runbook-steps.out" err="${SCENARIO_ROOT}/runbook-steps.err"
    if ! bun --no-install "${SWITCH_OVER_TS}" steps "$1" > "${out}" 2> "${err}"; then
        sed 's/^/  | /' "${err}" >&2
        fail "runbook: switch-over.ts steps on $1 failed: $(grep -m1 '^FAIL:' "${err}" || echo 'no FAIL line')"
    fi
    printf '%s\n' "${out}"
}

# no_bot_server <step>: fail if a bot server of the scenario runs.
no_bot_server() {
    local pid
    pid="$(server_pid)"
    if [[ -n "${pid}" ]] && pid_alive "${pid}"; then
        fail "$1: a bot server runs (PID ${pid} in ${SLACK_STATE_DIR}/server.pid)"
    fi
    port_closed "${SCENARIO_PORT}" || fail "$1: something answers on 127.0.0.1:${SCENARIO_PORT}"
}

# runbook_step <n>: enter step <n>, printing its heading title as the package
# in place has it.
runbook_step() {
    local n="$1" file line title="" count=0
    [[ "${n}" == "${RUNBOOK_NEXT}" ]] || fail "runbook: step ${n} entered, but step ${RUNBOOK_NEXT} is the next"
    file="$(runbook_steps_file "${RUNBOOK_PKG}")"
    while IFS= read -r line; do
        [[ "${line}" == "step "* ]] || continue
        count=$(( count + 1 ))
        if [[ "${line}" == "step ${n} "* ]]; then
            title="${line#"step ${n} "}"
        fi
    done < "${file}"
    [[ -n "${title}" ]] || fail "runbook: step ${n} is not in ${RUNBOOK_PKG}/README.md's runbook"
    if [[ -z "${RUNBOOK_COUNT}" ]]; then
        RUNBOOK_COUNT="${count}"
    fi
    [[ "${count}" == "${RUNBOOK_COUNT}" ]] \
        || fail "runbook: ${RUNBOOK_PKG}/README.md's runbook has ${count} steps, not the ${RUNBOOK_COUNT} read before"
    if (( n >= 4 && n <= 10 )); then
        no_bot_server "runbook step ${n}"
    fi
    RUNBOOK_CURRENT="${n}"
    RUNBOOK_NEXT=$(( n + 1 ))
    echo "${TEST_NAME}: runbook ${title}"
    record "entered: ${title}"
}

# runbook_substitute <n> <kind> <reason>: record one SRJ-1402 substitution of
# step <n>, inside that step's section.
runbook_substitute() {
    local n="$1" kind="$2" reason="$3" k known=0
    [[ "${n}" == "${RUNBOOK_CURRENT}" ]] \
        || fail "runbook: a step ${n} substitution declared inside step ${RUNBOOK_CURRENT:-none}'s section"
    for k in "${SUBSTITUTION_KINDS[@]}"; do
        [[ "${k}" == "${kind}" ]] && known=1
    done
    (( known )) || fail "runbook: '${kind}' is not one of SRJ-1402's substitutions"
    printf 'step %s\t%s\t%s\n' "${n}" "${kind}" "${reason}" >> "${SUBSTITUTIONS}"
    record "substitution (${kind}): ${reason}"
    echo "${TEST_NAME}: step ${n}: substitution (${kind}): ${reason}"
}

# global_install <tgz>...: the operator's global install of the given
# tarballs, at the scenario's install path.
global_install() {
    local out="${SCENARIO_ROOT}/bun-global-install.out"
    if ! env BUN_INSTALL="${CSCB_GLOBAL}" BUN_INSTALL_GLOBAL_DIR="${CSCB_GLOBAL}/install/global" \
        BUN_INSTALL_BIN="${CSCB_GLOBAL}/bin" BUN_INSTALL_CACHE_DIR="${BUN_CACHE}" \
        bun add -g "$@" < /dev/null > "${out}" 2>&1; then
        sed 's/^/  | /' "${out}" >&2
        return 1
    fi
}

# client_dir_of <pkg-dir>: print the directory of the agent-director client
# <pkg-dir> resolves (bun's resolver, as the package's own imports resolve it).
client_dir_of() {
    local entry d
    entry="$(cd / && RESOLVE_FROM="$1" bun --no-install -e \
        'process.stdout.write(Bun.resolveSync("agent-director", process.env.RESOLVE_FROM))')" \
        || fail "the package at $1 resolves no agent-director client"
    d="$(dirname -- "${entry}")"
    while [[ "${d}" != / ]]; do
        if [[ -f "${d}/package.json" && "$(jq -r '.name' "${d}/package.json" 2> /dev/null)" == agent-director ]]; then
            realpath -- "${d}"
            return 0
        fi
        d="$(dirname -- "${d}")"
    done
    fail "no agent-director package.json above ${entry}"
}

# read_settings <pkg-dir> <out-file>: `switch-over.ts settings` for <pkg-dir>
# into <out-file> and SETTINGS; record every line.
read_settings() {
    local pkg="$1" out="$2" err="$2.err" name value
    if ! bun --no-install "${SWITCH_OVER_TS}" settings "${pkg}" > "${out}" 2> "${err}"; then
        sed 's/^/  | /' "${err}" >&2
        fail "step ${RUNBOOK_CURRENT}: switch-over.ts settings on ${pkg} failed: $(grep -m1 '^FAIL:' "${err}" || echo 'no FAIL line')"
    fi
    SETTINGS=()
    while IFS=' ' read -r name value; do
        [[ -n "${name}" ]] || continue
        SETTINGS["${name}"]="${value}"
        record "settings: ${name} ${value}"
    done < "${out}"
    [[ "${SETTINGS[call_timeout_need_ms]:-}" =~ ^[0-9]+$ ]] \
        || fail "step ${RUNBOOK_CURRENT}: the settings give no call_timeout_need_ms"
    [[ "${SETTINGS[launch_bound_ms]:-}" =~ ^[0-9]+$ ]] \
        || fail "step ${RUNBOOK_CURRENT}: the settings give no finite launch_bound_ms ('${SETTINGS[launch_bound_ms]:-}')"
}

# check_windows <step>: each window with a minimum is at or above it.
check_windows() {
    local step="$1" name key value n minimums=0
    for name in "${!SETTINGS[@]}"; do
        [[ "${name}" == minimum.* ]] || continue
        minimums=$(( minimums + 1 ))
        key="${name#minimum.}"
        value=""
        for n in "${!SETTINGS[@]}"; do
            if [[ "${n}" == *".${key}" && "${n}" != minimum.* ]]; then
                value="${SETTINGS[${n}]}"
            fi
        done
        [[ "${value}" =~ ^[0-9]+$ ]] || fail "${step}: the settings give no value in effect for ${key}"
        (( value >= SETTINGS[${name}] )) \
            || fail "${step}: ${key} is ${value}, below its minimum ${SETTINGS[${name}]}"
        record "window ${key} ${value}: at or above its minimum ${SETTINGS[${name}]}"
    done
    (( minimums == 3 )) || fail "${step}: the settings give ${minimums} window minimums, not the three windows'"
}

# row_get <step> <instance-id>: a harness get of the row into AD_OUT; fail
# unless it answers.
row_get() {
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: harness get of ${2} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
}

# row_state <instance-id>: print the row's state (empty when the get fails).
row_state() {
    ad_capture get --claude-instance-id "$1"
    (( AD_RC == 0 )) || return 0
    jq -r '.state // empty' "${AD_OUT}"
}

row_state_is() {
    [[ "$(row_state "$1")" == "$2" ]]
}

# list_rows <step> <out-file> [<arg>...]: a harness `list` into <out-file> as
# one JSON array of rows.
list_rows() {
    local step="$1" out="$2"
    shift 2
    ad_capture list "$@"
    (( AD_RC == 0 )) || fail "${step}: harness list $* exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    jq -e '.spawns | type == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: harness list $* printed no spawns array: $(head -c 300 "${AD_OUT}")"
    jq -c '.spawns' "${AD_OUT}" > "${out}"
}

# True when every service=cscb row reads ended or missing.
cscb_rows_finished() {
    local out="${SCENARIO_ROOT}/cscb-rows.json"
    list_rows "step 4" "${out}" --label service=cscb
    jq -e 'all(.[]; .state == "ended" or .state == "missing")' "${out}" > /dev/null
}

# tmux_sessions <array-name>: set the array to the scenario tmux server's
# session names (none when no server runs), read only (`tmux ls`), from the
# scenario's own shell.
tmux_sessions() {
    local -n tmux_sessions_out="$1"
    local out="${SCENARIO_ROOT}/tmux-ls.out" err="${SCENARIO_ROOT}/tmux-ls.err"
    tmux_sessions_out=()
    if "${SCENARIO_REAL_TMUX}" list-sessions -F '#{session_name}' > "${out}" 2> "${err}"; then
        # shellcheck disable=SC2034 # a nameref: this sets the caller's array
        mapfile -t tmux_sessions_out < "${out}"
        return 0
    fi
    grep -qE 'no server running|error connecting to' "${err}" \
        || fail "tmux ls failed: $(tr '\n' ' ' < "${err}")"
}

# now_us: the time now in microseconds.
now_us() {
    _scenario_to_us "${EPOCHREALTIME/,/.}" || fail "could not read the clock"
    printf '%s\n' "${_SCENARIO_US}"
}

# cscb_lines <log> <verb> <out-file>: the CSCB-parented `call` lines of <log>
# whose verb is <verb> (any when empty) into <out-file>.
cscb_lines() {
    # cscb_ad_calls reads the log SCENARIO_AD_SHIM_LOG names, here <log>.
    local SCENARIO_AD_SHIM_LOG="$1"
    cscb_ad_calls "$2" > "$3"
}

# calls_naming <log> <verb> <instance-id> <out-file>: of `cscb_lines`, the
# lines whose arguments name <instance-id> exactly (a word that is the id or
# ends with `=<id>`) into <out-file>.
calls_naming() {
    local log="$1" verb="$2" id="$3" out="$4" every="$4.all" line a
    cscb_lines "${log}" "${verb}" "${every}"
    : > "${out}"
    while IFS= read -r line; do
        [[ -n "${line}" ]] || continue
        _scenario_split_line "${line}" || fail "leg A: a shim line does not split: ${line}"
        _scenario_decode_words || fail "leg A: a shim line's words do not decode: ${line}"
        _scenario_ad_verb
        for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
            if [[ "${a}" == "${id}" || "${a}" == *"=${id}" ]]; then
                printf '%s\n' "${line}" >> "${out}"
                break
            fi
        done
    done < "${every}"
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# ---------------------------------------------------------------------------
# Setup: the pre-persona 0.10.0 starting point
# ---------------------------------------------------------------------------

mkdir -p "${HOST_DIR}" "${COPIES_DIR}" "${STATE_DIR}" "${STAGING_DIR}" "${BUN_CACHE}" \
    || fail "setup: could not create the scenario's directories"
: > "${SWITCH_LOG}" || fail "setup: could not create ${SWITCH_LOG}"
: > "${SUBSTITUTIONS}" || fail "setup: could not create ${SUBSTITUTIONS}"
export SLACK_STATE_DIR="${STATE_DIR}"

# The fixture install-gate record: this container's dated go line, written by
# the harness, never by a runbook step.
HOST_NAME="$(cat /proc/sys/kernel/hostname)" || fail "setup: could not read the host name"
GO_LINE="$(date -u +%F) ${HOST_NAME} go: agent-director Phase 1 install approved (fixture)"
printf '%s\n' "${GO_LINE}" | write_file "${INSTALL_GATE_RECORD}"

# The loopback Slack stub: each persona's token pair answered ok, any other
# token refused.
SLACK_STUB_DIR="${SCENARIO_ROOT}/slack-stub"
SLACK_RECORD="${SLACK_STUB_DIR}/record.jsonl"
mkdir "${SLACK_STUB_DIR}" || fail "setup: could not create ${SLACK_STUB_DIR}"
control_args=()
for cid in "${CHANNELS[@]}"; do
    control_args+=("${TOKEN_LABEL[${cid}]}" "${PERSONA_OF[${cid}]}")
done
python3 - "${control_args[@]}" << 'EOF' | write_file "${SLACK_STUB_DIR}/control.json"
import json, sys
pairs = sys.argv[1:]
print(json.dumps({
    "tokens": [{"suffix": pairs[i], "label": pairs[i + 1], "auth": "ok", "connections": "ok"}
               for i in range(0, len(pairs), 2)],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
(cd "${SLACK_STUB_DIR}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SLACK_RECORD}" \
    --control "${SLACK_STUB_DIR}/control.json" --ready-file "${SLACK_STUB_DIR}/ready.json") > "${SLACK_STUB_DIR}/stub.out" 2>&1 &
track_pid "$!"
wait_for_file "${SLACK_STUB_DIR}/ready.json" "${SLACK_STUB_WAIT_S}" "setup: the Slack stub never wrote its ready file"
SLACK_API_URL="$(jq -r '.api_url' "${SLACK_STUB_DIR}/ready.json")"
[[ "${SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "setup: the Slack stub's api_url '${SLACK_API_URL}' is not loopback"
export CSCB_SLACK_API_URL="${SLACK_API_URL}"

# The published pre-persona package, installed as the global package, its
# agent-director dependency resolved to the image's 0.10.0 client tarball
# (an override in the global install's package.json).
mkdir -p "${CSCB_GLOBAL}/install/global" || fail "setup: could not create ${CSCB_GLOBAL}/install/global"
jq -n --arg ad "file:${AD_010_CLIENT_TGZ}" '{overrides: {"agent-director": $ad}}' \
    | write_file "${CSCB_GLOBAL}/install/global/package.json"
global_install "${CSCB_010_TGZ}" || fail "setup: the global install of ${CSCB_010_TGZ} failed"
[[ -x "${CSCB_CLI}" ]] || fail "setup: the global install left no executable ${CSCB_CLI}"
[[ "$(jq -r '.version' "${CSCB_PKG_DIR}/package.json")" == "${OLD_CSCB_VERSION}" ]] \
    || fail "setup: ${CSCB_PKG_DIR} is not ${PKG_NAME} ${OLD_CSCB_VERSION}"
[[ "$(realpath -e -- "${CSCB_CLI}")" == "$(realpath -e -- "${CSCB_PKG_DIR}")"/* ]] \
    || fail "setup: ${CSCB_CLI} does not resolve into ${CSCB_PKG_DIR}"
# Its client is agent-director's 0.10.0 client, file for file.
mkdir "${SCENARIO_ROOT}/ad-010-client" || fail "setup: could not create ${SCENARIO_ROOT}/ad-010-client"
tar -xzf "${AD_010_CLIENT_TGZ}" -C "${SCENARIO_ROOT}/ad-010-client" --strip-components=1 --no-same-owner \
    || fail "setup: could not unpack ${AD_010_CLIENT_TGZ}"
OLD_CLIENT_DIR="$(client_dir_of "${CSCB_PKG_DIR}")"
if ! diff -rq --no-dereference "${SCENARIO_ROOT}/ad-010-client" "${OLD_CLIENT_DIR}" > "${SCENARIO_ROOT}/old-client.diff" 2>&1; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/old-client.diff" >&2
    fail "setup: the old package resolves the client at ${OLD_CLIENT_DIR}, which is not agent-director's 0.10.0 client"
fi
record "the old package: ${PKG_NAME} ${OLD_CSCB_VERSION} at ${CSCB_PKG_DIR} (CLI ${CSCB_CLI}), its client agent-director's 0.10.0 client at ${OLD_CLIENT_DIR}"

# The pre-persona config.json and the host's other files.
declare -A CWD_OF=()
for cid in "${CHANNELS[@]}"; do
    CWD_OF["${cid}"]="$(make_workdir "${PERSONA_OF[${cid}]}")"
    WORKDIR_OF["${PERSONA_OF[${cid}]}"]="${CWD_OF[${cid}]}"
done
routes='{}'
for cid in "${CHANNELS[@]}"; do
    routes="$(jq -c --arg c "${cid}" --arg d "${CWD_OF[${cid}]}" '. + {($c): {cwd: $d}}' <<< "${routes}")"
done
jq -n --argjson routes "${routes}" --argjson port "${SCENARIO_PORT}" \
    --argjson exit "${OLD_EXIT_TIMEOUT_S}" --argjson stop "${OLD_STOP_TIMEOUT_S}" \
    '{routes: $routes, bind: "127.0.0.1", port: $port, exit_timeout: $exit, stop_timeout: $stop}' | write_config
# The crontable (the 0.10.0 form: targets are channel IDs) and its prompts;
# its schedules fall on 1 January only.
printf 'Summarize the day.\n' | write_file "${HOST_DIR}/prompt-daily.md"
printf 'Summarize the builds.\n' | write_file "${HOST_DIR}/prompt-builds.md"
{
    echo "# The host's scheduled prompts."
    echo "0 0 1 1 * ${HOST_DIR}/prompt-daily.md ${CHANNELS[0]}"
    echo "30 0 1 1 * ${HOST_DIR}/prompt-builds.md ${CHANNELS[1]},${CHANNELS[0]}"
} | write_file "${STATE_DIR}/crontab"
{
    echo '#!/bin/sh'
    echo "# The host's /interject callers."
    for cid in "${CHANNELS[@]}"; do
        printf "curl -s -X POST -H 'Content-Type: application/json' -d '{\"channel\": \"%s\", \"message\": \"nightly check\"}' http://127.0.0.1:%s/interject\n" \
            "${cid}" "${SCENARIO_PORT}"
    done
} | write_file "${INTERJECT_CALLERS}" 0755
jq -n --arg a "${CHANNELS[0]}" --arg b "${CHANNELS[1]}" \
    '{dmPolicy: "pairing", allowFrom: [], channels: {($a): {requireMention: false, allowFrom: []}, ($b): {requireMention: false, allowFrom: []}}, pending: {}}' \
    | write_file "${STATE_DIR}/access.json" 0600
printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$(fake_token bot "${SCENARIO_TAG}old")" "$(fake_token app "${SCENARIO_TAG}old")" \
    | write_file "${TOKEN_VARS}" 0600

# The pre-persona fleet on 0.10.0.
fleet_args=()
for cid in "${CHANNELS[@]}"; do
    fleet_args+=("${cid}=${SLACK_NAME[${cid}]}")
done
seed_prepersona_fleet "${STATE_DIR}/config.json" "${fleet_args[@]}" > "${SCENARIO_ROOT}/fleet.out"
i=0
while read -r cid id session sid pane; do
    [[ "${cid}" == "${CHANNELS[i]}" ]] || fail "setup: the fleet's row ${i} is for channel ${cid}, not ${CHANNELS[i]}"
    OLD_IDS+=("${id}")
    OLD_SESSIONS+=("${session}")
    OLD_PANES+=("${pane}")
    record "seeded: channel ${cid} row ${id} session ${session} (${sid} ${pane})"
    i=$(( i + 1 ))
done < "${SCENARIO_ROOT}/fleet.out"
(( ${#OLD_IDS[@]} == ${#CHANNELS[@]} )) || fail "setup: the fleet has ${#OLD_IDS[@]} rows, not one per routed channel"

# One row per routed channel, as the old package names and labels it, each
# with its stub worker, read through 0.10.0's get and list behind the shim.
for i in "${!CHANNELS[@]}"; do
    cid="${CHANNELS[i]}"
    id="${OLD_IDS[i]}"
    row_get "setup" "${id}"
    jq -e --arg id "${id}" --arg s "${OLD_SESSIONS[i]}" --arg c "${cid}" \
        '.claude_instance_id == $id and .tmux_session_name == $s and .labels.service == "cscb" and .labels.channel == $c and (.labels | has("persona") | not)' \
        "${AD_OUT}" > /dev/null \
        || fail "setup: row ${id} is not named and labelled as the old package does: $(head -c 400 "${AD_OUT}")"
    [[ "${id}" == cscb_*"_${cid}" && "${OLD_SESSIONS[i]}" == slack_bot_*"_${cid}" ]] \
        || fail "setup: row ${id} (session ${OLD_SESSIONS[i]}) is not cscb_<name>_${cid} with session slack_bot_<name>_${cid}"
    pane_pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${OLD_PANES[i]}" '#{pane_pid}')" \
        || fail "setup: no pane ${OLD_PANES[i]} for row ${id}"
    tr '\0' '\n' < "/proc/${pane_pid}/cmdline" | grep -qxF "${SCENARIO_BIN}/claude" \
        || fail "setup: row ${id}'s worker (pane ${OLD_PANES[i]}, PID ${pane_pid}) is not a running stub"
done
list_rows "setup" "${SCENARIO_ROOT}/fleet-rows.json" --label service=cscb
[[ "$(jq 'length' "${SCENARIO_ROOT}/fleet-rows.json")" == "${#CHANNELS[@]}" ]] \
    || fail "setup: list --label service=cscb shows $(jq 'length' "${SCENARIO_ROOT}/fleet-rows.json") rows, not ${#CHANNELS[@]}"
# No pre-persona server is started.
no_bot_server "setup"

# The build under test, unpacked into the staging directory: the runbook the
# script follows is its README's.
tar -xzf "${PACKAGE_TGZ}" -C "${STAGING_DIR}" --no-same-owner || fail "setup: could not unpack ${PACKAGE_TGZ}"
[[ -f "${STAGED_PKG}/README.md" ]] || fail "setup: ${PACKAGE_TGZ} holds no package/README.md"

# ---------------------------------------------------------------------------
# Step 1
# ---------------------------------------------------------------------------

runbook_step 1

grep -qxF "${GO_LINE}" "${INSTALL_GATE_RECORD}" \
    || fail "step 1: the install-gate record has no dated go line for ${HOST_NAME}"
record "go line: ${GO_LINE}"
runbook_substitute 1 install-gate-fixture "the go line is read from the fixture install-gate record the harness wrote"

ad_capture version
(( AD_RC == 0 )) || fail "step 1: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
got="$(jq -r '.version // empty' "${AD_OUT}")"
[[ "${got}" == "${SCENARIO_AD_010_VERSION}" ]] \
    || fail "step 1: agent-director version reports '${got}', not ${SCENARIO_AD_010_VERSION}"
record "agent-director version: ${got}"

# C7: one socket path, the pinned one, and one HOME, from the CSCB launcher's
# environment, the find-missing loop's and a seeded worker's.
PINNED_SOCKET="${TMUX_TMPDIR}/tmux-$(id -u)/default"
[[ -S "${PINNED_SOCKET}" ]] || fail "step 1: the pinned socket ${PINNED_SOCKET} is not a socket"
[[ "${PINNED_SOCKET}" == "${SCENARIO_ROOT}"/* ]] || fail "step 1: the pinned socket ${PINNED_SOCKET} is not under SCENARIO_ROOT"
cscb_run tmux display-message -p '#{socket_path}' < /dev/null > "${SCENARIO_ROOT}/c7-launcher.sock" \
    || fail "step 1: tmux display-message failed in the CSCB launcher's environment"
cscb_run printenv HOME < /dev/null > "${SCENARIO_ROOT}/c7-launcher.home" \
    || fail "step 1: printenv HOME failed in the CSCB launcher's environment"
( tmux display-message -p '#{socket_path}' ) > "${SCENARIO_ROOT}/c7-loop.sock" \
    || fail "step 1: tmux display-message failed in the find-missing loop's environment"
( printenv HOME ) > "${SCENARIO_ROOT}/c7-loop.home"
worker_pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${OLD_PANES[0]}" '#{pane_pid}')" \
    || fail "step 1: no seeded worker pane ${OLD_PANES[0]}"
mapfile -d '' -t worker_env < "/proc/${worker_pid}/environ" \
    || fail "step 1: could not read the seeded worker's environment"
env -i "${worker_env[@]}" tmux display-message -p '#{socket_path}' > "${SCENARIO_ROOT}/c7-worker.sock" \
    || fail "step 1: tmux display-message failed in a seeded worker's environment"
env -i "${worker_env[@]}" printenv HOME > "${SCENARIO_ROOT}/c7-worker.home" \
    || fail "step 1: printenv HOME failed in a seeded worker's environment"
for where in launcher loop worker; do
    got="$(cat "${SCENARIO_ROOT}/c7-${where}.sock")"
    [[ "${got}" == "${PINNED_SOCKET}" ]] \
        || fail "step 1: C7: the ${where}'s environment prints socket '${got}', not the pinned ${PINNED_SOCKET}"
    got="$(cat "${SCENARIO_ROOT}/c7-${where}.home")"
    [[ "${got}" == "${HOME}" ]] || fail "step 1: C7: the ${where}'s environment has HOME '${got}', not ${HOME}"
done
record "C7: the CSCB launcher, the find-missing loop and a worker print the pinned socket ${PINNED_SOCKET}, with one HOME ${HOME}"
runbook_substitute 1 one-socket "C7 runs against the container's one tmux socket, the scenario's, from the three environments"

tmux_v="$("${SCENARIO_REAL_TMUX}" -V)" || fail "step 1: tmux -V failed"
[[ "${tmux_v}" =~ ^tmux\ ([0-9]+)\.([0-9]+) ]] || fail "step 1: tmux -V printed '${tmux_v}'"
(( BASH_REMATCH[1] > 3 || (BASH_REMATCH[1] == 3 && BASH_REMATCH[2] >= 2) )) \
    || fail "step 1: ${tmux_v} is older than tmux 3.2"
roe="$("${SCENARIO_REAL_TMUX}" show-options -gwv remain-on-exit)" || fail "step 1: could not read remain-on-exit"
[[ "${roe}" == off ]] || fail "step 1: remain-on-exit is '${roe}', not off"
record "tmux: ${tmux_v}, remain-on-exit ${roe}"

runbook_substitute 1 claude-code-check-skipped "the container's workers are stub-claude.sh, not Claude Code"

# Staging: the build under test with its dependencies resolved, not installed.
if ! (cd "${STAGED_PKG}" && env BUN_INSTALL_CACHE_DIR="${BUN_CACHE}" bun install --production --ignore-scripts) \
    < /dev/null > "${SCENARIO_ROOT}/staging-install.out" 2>&1; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/staging-install.out" >&2
    fail "step 1: resolving the staged build's dependencies failed"
fi
STAGED_VERSION="$(jq -r '.version' "${STAGED_PKG}/package.json")"
[[ "${STAGED_VERSION}" == "${PKG_VERSION}" ]] \
    || fail "step 1: the staged build is version '${STAGED_VERSION}', not the tarball's ${PKG_VERSION}"
record "staged release: ${PKG_NAME} ${STAGED_VERSION} from ${PACKAGE_TGZ}, in ${STAGED_PKG}; available to install"
runbook_substitute 1 staging-build-under-test "the release staged is the build under test, the image's ${PACKAGE_TGZ}, unpacked into ${STAGING_DIR}"

[[ ! -e "${HOME}/.agent-director/config.toml" ]] || fail "step 1: the scenario HOME has an agent-director config.toml"
read_settings "${STAGED_PKG}" "${SCENARIO_ROOT}/settings-step1"
[[ "${SETTINGS[file_exists]}" == false ]] || fail "step 1: the settings read found a config.toml"
check_windows "step 1"
NEED_MS="${SETTINGS[call_timeout_need_ms]}"
record "call-timeout need: ${NEED_MS} ms (set by ${SETTINGS[call_timeout_need_set_by]})"
runbook_substitute 1 container-settings "the timing settings are the container's: the scenario HOME's agent-director settings, read by the staged build"

# The persona configuration, in a separate file, never config.json.
CALL_TIMEOUT_MS=$(( NEED_MS + CALL_TIMEOUT_HEADROOM_MS ))
personas='[]'
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    mkdir -p "${SCENARIO_ROOT}/claude-config/${name}" || fail "step 1: could not create ${name}'s Claude config directory"
    personas="$(jq -c --arg n "${name}" --arg cid "${cid}" --arg w "${CWD_OF[${cid}]}" \
        --arg creds "${STATE_DIR}/credentials-${name}.json" --arg cfg "${SCENARIO_ROOT}/claude-config/${name}" \
        '. + [{name: $n, credentials_file: $creds, working_directory: $w, claude_config_dir: $cfg,
               channels: [{id: $cid, delivery: "all"}], permission_prompts: $cid}]' <<< "${personas}")"
done
jq -n --argjson p "${personas}" --argjson port "${SCENARIO_PORT}" --argjson tick "${HEALTH_CHECK_INTERVAL_S}" \
    --argjson delay "${SESSION_RESTART_DELAY_S}" --argjson exit "${EXIT_TIMEOUT_S}" --argjson call "${CALL_TIMEOUT_MS}" \
    '{personas: $p, bind: "127.0.0.1", port: $port, health_check_interval: $tick, session_restart_delay: $delay,
      exit_timeout: $exit, agent_director_call_timeout_ms: $call}' | write_file "${STAGED_CONFIG}"
got="$(jq -r '.agent_director_call_timeout_ms' "${STAGED_CONFIG}")"
(( got > NEED_MS )) || fail "step 1: the persona configuration's agent_director_call_timeout_ms ${got} does not exceed the need ${NEED_MS}"
record "persona configuration staged in ${STAGED_CONFIG}: agent_director_call_timeout_ms ${got} (above the need ${NEED_MS}), health_check_interval ${HEALTH_CHECK_INTERVAL_S}, session_restart_delay ${SESSION_RESTART_DELAY_S}"
runbook_substitute 1 slack-fixtures "the Slack apps and token variables are the container's fixtures: the loopback Slack stub maps each persona's fake tokens"

# Leftover sessions: every slack_bot_ session that no row names.
list_rows "step 1" "${SCENARIO_ROOT}/rows-step1.json"
unnamed=()
tmux_sessions sessions
for s in ${sessions[@]+"${sessions[@]}"}; do
    [[ "${s}" == slack_bot_* ]] || continue
    jq -e --arg s "${s}" 'any(.[]; .tmux_session_name == $s)' "${SCENARIO_ROOT}/rows-step1.json" > /dev/null \
        || unnamed+=("${s}")
done
record "tmux ls: ${sessions[*]:-no session}"
record "slack_bot_ sessions no row names: ${unnamed[*]:-none}"
(( ${#unnamed[@]} == 0 )) || fail "step 1: slack_bot_ session(s) no row names: ${unnamed[*]}"

# Copies for rollback, with the old CSCB's exact version beside them.
for f in "${STATE_DIR}/config.json" "${STATE_DIR}/crontab" "${INTERJECT_CALLERS}" "${STATE_DIR}/access.json" "${TOKEN_VARS}"; do
    [[ -f "${f}" ]] || fail "step 1: ${f} is missing"
    cp -p -- "${f}" "${COPIES_DIR}/" || fail "step 1: could not copy ${f} to ${COPIES_DIR}"
done
printf '%s %s\n' "${PKG_NAME}" "${OLD_CSCB_VERSION}" | write_file "${COPIES_DIR}/old-cscb-version"
record "rollback copies in ${COPIES_DIR}: config.json, crontab, interject callers, access.json, token variables; the old CSCB is ${PKG_NAME} ${OLD_CSCB_VERSION}"
runbook_substitute 1 prompt-wording-skipped "the orchestrator prompt's ship-now wording (§6) is skipped"

# ---------------------------------------------------------------------------
# Step 2
# ---------------------------------------------------------------------------

runbook_step 2
runbook_substitute 2 autostart-skipped "the container has no host autostart for CSCB to disable"

# ---------------------------------------------------------------------------
# Step 3
# ---------------------------------------------------------------------------

runbook_step 3
ad_lines_before_3="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
rc=0
cscb_run "${CSCB_CLI}" stop --stop-bots < /dev/null > "${SCENARIO_ROOT}/step3.out" 2>&1 || rc=$?
if (( rc != 0 )); then
    sed 's/^/  | /' "${SCENARIO_ROOT}/step3.out" >&2
    fail "step 3: the old package's stop --stop-bots exited ${rc}"
fi
for cid in "${CHANNELS[@]}"; do
    n="$(grep -cE "^\[slack\] teardownBots: (channel=${cid} (exited cleanly|force-killed|already terminal)|pause failed for channel=${cid} — escalating to kill)" \
        "${SCENARIO_ROOT}/step3.out" || true)"
    if [[ "${n}" != 1 ]]; then
        sed 's/^/  | /' "${SCENARIO_ROOT}/step3.out" >&2
        fail "step 3: stop --stop-bots reported ${n} teardown outcome(s) for channel ${cid}, not one"
    fi
done
tail -n "+$(( ad_lines_before_3 + 1 ))" "${SCENARIO_AD_SHIM_LOG}" > "${SCENARIO_ROOT}/step3-shim.log"
cscb_lines "${SCENARIO_ROOT}/step3-shim.log" "" "${SCENARIO_ROOT}/step3-calls"
(( $(line_count "${SCENARIO_ROOT}/step3-calls") > 0 )) \
    || fail "step 3: the old CLI made no agent-director call through the shim"
got="$("${HOME}/.agent-director/bin/agent-director.real" version | jq -r '.version // empty')"
[[ "${got}" == "${SCENARIO_AD_010_VERSION}" ]] || fail "step 3: the binary behind the shim reports '${got}', not ${SCENARIO_AD_010_VERSION}"
record "stop --stop-bots (the old ${PKG_NAME} ${OLD_CSCB_VERSION}) exited 0 with one teardown outcome per routed channel; $(line_count "${SCENARIO_ROOT}/step3-calls") agent-director call(s) through the shim, ${got} behind it"

# ---------------------------------------------------------------------------
# Step 4
# ---------------------------------------------------------------------------

runbook_step 4
ad_capture find-missing
(( AD_RC == 0 )) || fail "step 4: agent-director find-missing exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
wait_until "${STEP4_WAIT_S}" "step 4: a service=cscb row did not read ended or missing" cscb_rows_finished
for id in "${OLD_IDS[@]}"; do
    row_get "step 4: seeded row ${id} is gone" "${id}"
    record "row ${id}: $(jq -r '.state' "${AD_OUT}")"
done

# ---------------------------------------------------------------------------
# Step 5
# ---------------------------------------------------------------------------

runbook_step 5
tmux_sessions sessions
for s in ${sessions[@]+"${sessions[@]}"}; do
    for cid in "${CHANNELS[@]}"; do
        if [[ "${s}" == "slack_bot_${cid}" || "${s}" == slack_bot_*"_${cid}" ]]; then
            fail "step 5: an old session ${s} is left"
        fi
    done
done
list_rows "step 5" "${SCENARIO_ROOT}/rows-step5.json" --label service=cscb
live="$(jq -r '[.[] | select(.state != "ended" and .state != "missing") | .claude_instance_id] | join(" ")' "${SCENARIO_ROOT}/rows-step5.json")"
[[ -z "${live}" ]] || fail "step 5: old row(s) still live: ${live}"
record "tmux ls: ${sessions[*]:-no session}; no old session and no live old row"

# ---------------------------------------------------------------------------
# Step 6
# ---------------------------------------------------------------------------

runbook_step 6
record "not needed: step 5 found no leftover with a row"

# ---------------------------------------------------------------------------
# Step 7
# ---------------------------------------------------------------------------

runbook_step 7
global_install "${PACKAGE_TGZ}" || fail "step 7: the global install of ${PACKAGE_TGZ} failed"
[[ "$(jq -r '.version' "${CSCB_PKG_DIR}/package.json")" == "${STAGED_VERSION}" ]] \
    || fail "step 7: ${CSCB_PKG_DIR} is not the staged ${STAGED_VERSION}"
# The version string alone may be the old package's too: the files are the staged build's.
if ! diff -rq --exclude=node_modules "${STAGED_PKG}" "${CSCB_PKG_DIR}" > "${SCENARIO_ROOT}/installed.diff" 2>&1; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/installed.diff" >&2
    fail "step 7: the package installed at ${CSCB_PKG_DIR} is not the staged build"
fi
[[ "$(realpath -e -- "${CSCB_CLI}")" == "$(realpath -e -- "${CSCB_PKG_DIR}")"/* ]] \
    || fail "step 7: ${CSCB_CLI} does not resolve into ${CSCB_PKG_DIR}"
n="$(find "${CSCB_GLOBAL}" -name package.json -path "*/node_modules/${PKG_NAME}/package.json" | wc -l)"
[[ "${n}" == 1 ]] || fail "step 7: ${n} copies of ${PKG_NAME} under ${CSCB_GLOBAL}, not one (no side-by-side install)"
runbook_substitute 7 staging-build-under-test "the staged build under test is installed from its tarball over the global install, not from the registry by version"
# The release candidate's client, swapped in and checked by the image's check.
# The scenario HOME still runs 0.10.0 here, so the check, which probes the
# first agent-director on PATH and Client.create() under HOME, runs with a
# HOME of its own and the release candidate's binary first on PATH.
mkdir "${SCENARIO_ROOT}/rc-check-home" || fail "step 7: could not create the check's HOME"
if ! env HOME="${SCENARIO_ROOT}/rc-check-home" PATH="$(dirname -- "${SCENARIO_RC_BIN}"):${PATH}" \
    "${RC_CLIENT_CHECK}" --package "${CSCB_PKG_DIR}" > "${SCENARIO_ROOT}/rc-client-check.out" 2>&1; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/rc-client-check.out" >&2
    fail "step 7: the release-candidate client check on ${CSCB_PKG_DIR} failed: $(grep -m1 '^ERROR:' "${SCENARIO_ROOT}/rc-client-check.out" || echo 'no ERROR line')"
fi
record "$(cat "${SCENARIO_ROOT}/rc-client-check.out")"
# The CLI at the one install path is the build under test's from here on.
export SCENARIO_CLI="${CSCB_CLI}"
RUNBOOK_PKG="${CSCB_PKG_DIR}"
record "installed: ${PKG_NAME} ${STAGED_VERSION} at ${CSCB_PKG_DIR} (CLI ${CSCB_CLI}), the release candidate's client"
no_bot_server "step 7: nothing is started"

write_config < "${STAGED_CONFIG}"
record "the persona configuration is config.json"

# Each persona's credentials file, written by the new CLI's credentials
# command, which validates the tokens with Slack: a curl wrapper first on its
# PATH sends its Slack requests to the loopback stub.
SLACK_CURL_DIR="${SCENARIO_ROOT}/slack-curl"
mkdir "${SLACK_CURL_DIR}" || fail "step 7: could not create ${SLACK_CURL_DIR}"
real_curl="$(command -v curl)" || fail "step 7: no curl on PATH"
{
    echo '#!/usr/bin/env bash'
    echo "# The loopback Slack stub stands in for Slack: https://slack.com/api/<method> goes to ${SLACK_API_URL}<method>."
    printf 'stub_api_url=%q\nreal_curl=%q\n' "${SLACK_API_URL}" "${real_curl}"
    cat << 'EOF'
args=()
for a in "$@"; do
    case "${a}" in
        https://slack.com/api/*) args+=("${stub_api_url}${a#https://slack.com/api/}") ;;
        *) args+=("${a}") ;;
    esac
done
exec "${real_curl}" "${args[@]}"
EOF
} | write_file "${SLACK_CURL_DIR}/curl" 0755
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    creds="${STATE_DIR}/credentials-${name}.json"
    bot="$(fake_token bot "${TOKEN_LABEL[${cid}]}")"
    app="$(fake_token app "${TOKEN_LABEL[${cid}]}")"
    rc=0
    cscb_run env PATH="${SCENARIO_TMUX_SHIM_BIN}:${SLACK_CURL_DIR}:${PATH}" "${CSCB_CLI}" credentials "${name}" \
        <<< "${bot}"$'\n'"${app}" > "${SCENARIO_ROOT}/credentials-${name}.out" 2>&1 || rc=$?
    if (( rc != 0 )); then
        sed 's/^/  | /' "${SCENARIO_ROOT}/credentials-${name}.out" >&2
        fail "step 7: credentials ${name} exited ${rc}"
    fi
    [[ -f "${creds}" && "$(stat -c '%a' "${creds}")" == 600 ]] || fail "step 7: credentials ${name} wrote no 0600 file at ${creds}"
    jq -e --arg b "${bot}" --arg a "${app}" '.bot_token == $b and .app_token == $a' "${creds}" > /dev/null \
        || fail "step 7: ${creds} does not hold ${name}'s token pair"
    record "credentials file of ${name}: ${creds} (0600), written by the new CLI"
done
runbook_substitute 7 slack-fixtures "the credentials command validates the fake tokens against the loopback Slack stub, through a curl wrapper first on its PATH"

# The crontable targets and the /interject callers name personas.
for cid in "${CHANNELS[@]}"; do
    sed -i -e "s/\(^\|[ ,]\)${cid}\([ ,]\|\$\)/\1${PERSONA_OF[${cid}]}\2/g" "${STATE_DIR}/crontab" \
        || fail "step 7: could not rewrite the crontable"
    sed -i -e "s/\"channel\": \"${cid}\"/\"persona\": \"${PERSONA_OF[${cid}]}\"/g" "${INTERJECT_CALLERS}" \
        || fail "step 7: could not rewrite the /interject callers"
done
for cid in "${CHANNELS[@]}"; do
    ! grep -qF -- "${cid}" "${STATE_DIR}/crontab" || fail "step 7: the crontable still targets channel ${cid}"
    ! grep -qF -- "${cid}" "${INTERJECT_CALLERS}" || fail "step 7: an /interject caller still names channel ${cid}"
done
[[ "$(grep -c '"persona": ' "${INTERJECT_CALLERS}")" == "${#CHANNELS[@]}" ]] \
    || fail "step 7: the /interject callers do not each name a persona"
record "crontable targets and /interject callers rewritten to name personas"

# The new install check passes on the still-installed 0.10.0, with its note.
rc=0
cscb_run bun "${CSCB_PKG_DIR}/scripts/install-check.ts" < /dev/null > "${SCENARIO_ROOT}/install-check.out" 2>&1 || rc=$?
if (( rc != 0 )) || ! grep -qxF 'agent-director install check: OK' "${SCENARIO_ROOT}/install-check.out" \
    || ! grep -qxF "  version: ${SCENARIO_AD_010_VERSION}" "${SCENARIO_ROOT}/install-check.out" \
    || ! grep -q '^  note:    ' "${SCENARIO_ROOT}/install-check.out"; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/install-check.out" >&2
    fail "step 7: the install check did not pass on ${SCENARIO_AD_010_VERSION} with its Phase 1 note (exit ${rc})"
fi
section_title="$(sed -n 's/^section //p' "$(runbook_steps_file "${RUNBOOK_PKG}")")"
grep '^  note:    ' "${SCENARIO_ROOT}/install-check.out" | grep -qF -- "${section_title}" \
    || fail "step 7: the install check's note does not name the section \"${section_title}\""
record "install check: OK on ${SCENARIO_AD_010_VERSION}, with its Phase 1 note"

# ---------------------------------------------------------------------------
# Step 8
# ---------------------------------------------------------------------------

runbook_step 8
grep -qxF "${GO_LINE}" "${INSTALL_GATE_RECORD}" \
    || fail "step 8: the install-gate record has no dated go line for ${HOST_NAME}"
record "go line: ${GO_LINE}"
runbook_substitute 8 install-gate-fixture "the go line is read from the fixture install-gate record"

# The harness's stop of every other agent: none is seeded.
list_rows "step 8" "${SCENARIO_ROOT}/rows-step8.json"
live="$(jq -r '[.[] | select((.labels.service // "") != "cscb") | select(.state != "ended" and .state != "missing") | .claude_instance_id] | join(" ")' "${SCENARIO_ROOT}/rows-step8.json")"
[[ -z "${live}" ]] || fail "step 8: other agents' rows still live: ${live}"
tmux_sessions sessions
(( ${#sessions[@]} == 0 )) || fail "step 8: tmux sessions are left: ${sessions[*]}"
record "every other agent stopped: no non-CSCB row live, no tmux session"
runbook_substitute 8 harness-stops-agents "the harness stops every other agent in the container; none is seeded"

ad_store_backup "${STORE_BACKUP}"
record "store backup: ${STORE_BACKUP} (sqlite3 .backup; integrity check ok)"

install_ticks="$(_scenario_proc_starttime "${BASHPID}")"
[[ "${install_ticks}" =~ ^[0-9]+$ ]] || fail "step 8: could not read the time before the install"
install_ad_rc "step 8: install agent-director Phase 1"
ad_capture version
(( AD_RC == 0 )) || fail "step 8: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
got="$(jq -r '.version // empty' "${AD_OUT}")"
[[ "${got}" == "${RC_VERSION}" && "$(jq -r '.commit // empty' "${AD_OUT}")" == "${RC_COMMIT}" ]] \
    || fail "step 8: agent-director version reports '${got}', not the release candidate's ${RC_VERSION} (${RC_COMMIT})"
real_v="$("${HOME}/.agent-director/bin/agent-director.real" version | jq -r '.version // empty')"
[[ "${real_v}" == "${RC_VERSION}" ]] || fail "step 8: the binary behind the shim reports '${real_v}', not ${RC_VERSION}"
runbook_substitute 8 rc-install-script "the Phase 1 install is the release candidate's install.sh, run in the scenario HOME, then the re-shim; the serve restart and start-time check cover the container's agent-director processes"
[[ ! -e "${HOME}/.agent-director/config.toml" ]] || fail "step 8: a config.toml was written; the scenario writes no [tmux] table"
older=()
count=0
for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    exe="$(readlink -- "${proc}/exe" 2> /dev/null || true)"
    cmd="$(tr '\0' ' ' < "${proc}/cmdline" 2> /dev/null || true)"
    [[ "${exe}" == "${HOME}/.agent-director/"* || "${cmd}" == *"${HOME}/.agent-director/bin/agent-director"* ]] || continue
    st="$(_scenario_proc_starttime "${pid}")"
    [[ -n "${st}" ]] || continue
    count=$(( count + 1 ))
    (( st >= install_ticks )) || older+=("${pid}")
done
(( ${#older[@]} == 0 )) || fail "step 8: agent-director process(es) older than the install still run: ${older[*]}"
record "agent-director ${got} (${RC_COMMIT}); ${count} agent-director process(es) of the scenario run, none older than the install"

read_settings "${CSCB_PKG_DIR}" "${SCENARIO_ROOT}/settings-step8"
check_windows "step 8"
NEED_MS="${SETTINGS[call_timeout_need_ms]}"
current="$(jq -r '.agent_director_call_timeout_ms' "${STATE_DIR}/config.json")"
if (( current <= NEED_MS )); then
    raised=$(( NEED_MS + CALL_TIMEOUT_HEADROOM_MS ))
    jq --argjson v "${raised}" '.agent_director_call_timeout_ms = $v' "${STATE_DIR}/config.json" > "${SCENARIO_ROOT}/config.raised.json" \
        || fail "step 8: could not raise agent_director_call_timeout_ms"
    write_config < "${SCENARIO_ROOT}/config.raised.json"
    record "the need grew to ${NEED_MS} ms: agent_director_call_timeout_ms raised from ${current} to ${raised} in config.json"
    current="${raised}"
fi
(( current > NEED_MS )) || fail "step 8: config.json's agent_director_call_timeout_ms ${current} does not exceed the need ${NEED_MS}"
record "call-timeout need: ${NEED_MS} ms; config.json's agent_director_call_timeout_ms ${current} exceeds it"
LEG_A_WAIT_S=$(( (SETTINGS[launch_bound_ms] + 999) / 1000 ))
(( HEALTH_CHECK_INTERVAL_S < LEG_A_WAIT_S )) \
    || fail "step 8: health_check_interval ${HEALTH_CHECK_INTERVAL_S} s is not shorter than leg A's wait ${LEG_A_WAIT_S} s"
ad_capture list
if (( AD_RC != 0 )) || grep -qF ErrConfigMalformed "${AD_OUT}" "${AD_ERR}"; then
    fail "step 8: agent-director list exited ${AD_RC} or answered ErrConfigMalformed: $(head -c 300 "${AD_ERR}")"
fi
record "agent-director list answers without ErrConfigMalformed"
runbook_substitute 8 container-settings "the timing settings are the container's, read again by the installed build"

# After the migration: an existing row has no launch_started_at.
for id in "${OLD_IDS[@]}"; do
    row_get "step 8: after the migration" "${id}"
    jq -e 'type == "object" and (has("launch_started_at") | not)' "${AD_OUT}" > /dev/null \
        || fail "step 8: after the migration, a get of row ${id} shows a launch_started_at: $(head -c 300 "${AD_OUT}")"
done
store_id="$(ad_store_id)" || exit 1
record "after the migration: no seeded row has a launch_started_at; store id ${store_id}"

# ---------------------------------------------------------------------------
# Step 9
# ---------------------------------------------------------------------------

runbook_step 9
runbook_substitute 9 no-agents-restarted "no other agent runs in the container, so none is started again"

# ---------------------------------------------------------------------------
# Step 10
# ---------------------------------------------------------------------------

runbook_step 10
runbook_substitute 10 prompt-wording-skipped "the orchestrator prompt's worker-cleanup wording is skipped"
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    stub_mode "${WORKDIR_OF[${name}]}" "${STUB_MODE_DEV_CHANNELS}"
    # src/persona-identity.ts personaInstanceId.
    PERSONA_IDS+=("cscb_$(persona_key "${name}")")
done
LEG_A_AD_FROM="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
leg_a_start_us="$(now_us)"
start_server --live
record "the new CSCB started (bot server PID ${SERVER_PID})"
runbook_substitute 10 autostart-skipped "the container has no host autostart for CSCB to re-enable"

leg_a_deadline_us=$(( leg_a_start_us + LEG_A_WAIT_S * 1000000 ))
for i in "${!PERSONA_IDS[@]}"; do
    id="${PERSONA_IDS[i]}"
    left_s=$(( (leg_a_deadline_us - $(now_us)) / 1000000 ))
    (( left_s > 0 )) || left_s=0
    wait_until "${left_s}" "step 10: row ${id} never read waiting within ${LEG_A_WAIT_S}s (B) of the start" row_state_is "${id}" waiting
    WAITING_US["${id}"]="$(now_us)"
    record "row ${id} reads waiting"
done
left_s=$(( (leg_a_deadline_us - $(now_us)) / 1000000 ))
(( left_s > 0 )) || left_s=0
wait_for_log "$(completion_match "${#PERSONA_IDS[@]}")" "${left_s}" "step 10: the start pass never completed"
expect_completion "${#PERSONA_IDS[@]}" "step 10: every persona starts fresh once" \
    "0 resumed" "${#PERSONA_IDS[@]} fresh-spawned" "0 not brought up"

list_rows "step 10" "${SCENARIO_ROOT}/rows-pending.json" --state pending
missing_ls="$(jq -r '[.[] | select((.launch_started_at // null) == null) | .claude_instance_id] | join(" ")' "${SCENARIO_ROOT}/rows-pending.json")"
[[ -z "${missing_ls}" ]] || fail "step 10: pending row(s) with no launch_started_at: ${missing_ls}"
result="every pending row ($(jq 'length' "${SCENARIO_ROOT}/rows-pending.json")) has a launch_started_at"
record "post-install check: ${result}"
printf '%s %s post-install check: %s\n' "$(date -u +%F)" "${HOST_NAME}" "${result}" >> "${INSTALL_GATE_RECORD}" \
    || fail "step 10: could not write the post-install check line"
runbook_substitute 10 container-list "the launch-start check reads the container's agent-director list"
runbook_substitute 10 install-gate-fixture "the post-install check line is written to the fixture install-gate record"

# ---------------------------------------------------------------------------
# Leg A
# ---------------------------------------------------------------------------

# Health ticks (Q12): once each persona's session is connected, the bot server
# reads its row on HEALTH_TICKS more ticks with no reconnect or restart.
tick_wait_s=$(( (HEALTH_TICKS + 2) * HEALTH_CHECK_INTERVAL_S ))
LEG_A_LOG="${SCENARIO_ROOT}/leg-a-shim.log"
leg_a_window() {
    tail -n "+$(( LEG_A_AD_FROM + 1 ))" "${SCENARIO_AD_SHIM_LOG}" > "${LEG_A_LOG}"
}
# status_reads <instance-id>: how many status reads of the row the bot server made in leg A.
status_reads() {
    leg_a_window
    calls_naming "${LEG_A_LOG}" status "$1" "${SCENARIO_ROOT}/leg-a-status"
    line_count "${SCENARIO_ROOT}/leg-a-status"
}
status_reads_at_least() {
    (( $(status_reads "$1") >= $2 ))
}
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    ref="$(persona_ref "${name}")"
    left_s=$(( (leg_a_deadline_us - $(now_us)) / 1000000 ))
    (( left_s > 0 )) || left_s=0
    wait_for_log "[slack] Session connected: persona ${ref}" "${left_s}" "leg A: persona ${name}'s session never connected"
done
declare -A reads_before=()
for id in "${PERSONA_IDS[@]}"; do
    reads_before["${id}"]="$(status_reads "${id}")"
done
ticks_from_us="$(now_us)"
for id in "${PERSONA_IDS[@]}"; do
    wait_until "${tick_wait_s}" "leg A: the bot server read row ${id} on fewer than ${HEALTH_TICKS} health ticks" \
        status_reads_at_least "${id}" "$(( reads_before[${id}] + HEALTH_TICKS ))"
done
while (( $(now_us) < ticks_from_us + HEALTH_TICKS * HEALTH_CHECK_INTERVAL_S * 1000000 )); do
    sleep 1
done
for cid in "${CHANNELS[@]}"; do
    key="$(persona_key "${PERSONA_OF[${cid}]}")"
    for m in "[slack] Scheduling restart for persona=${key} " "[slack] Session alive but disconnected — reconnecting MCP for persona=${key}"; do
        if (( $(count_log "${m}") > 0 )); then
            grep -F -- "${m}" "${SLACK_STATE_DIR}/server.log" | sed 's/^/  | /' >&2
            fail "leg A (Q12): a health tick reconnected or relaunched persona ${PERSONA_OF[${cid}]} while its stub held its MCP session: a harness defect, reported, not worked around"
        fi
    done
done
record "health ticks: each persona's row read on at least ${HEALTH_TICKS} ticks after it connected, with no reconnect or restart"

leg_a_window
for i in "${!PERSONA_IDS[@]}"; do
    id="${PERSONA_IDS[i]}"
    name="${PERSONA_OF[${CHANNELS[i]}]}"
    # Exactly one plain spawn, no reuse, no resume, no second launch.
    calls_naming "${LEG_A_LOG}" spawn "${id}" "${SCENARIO_ROOT}/leg-a-spawn"
    calls_naming "${LEG_A_LOG}" resume "${id}" "${SCENARIO_ROOT}/leg-a-resume"
    n="$(line_count "${SCENARIO_ROOT}/leg-a-spawn")"
    [[ "${n}" == 1 ]] || fail "leg A: persona ${name} (${id}) has ${n} spawn(s) by CSCB, not one fresh start"
    [[ "$(line_count "${SCENARIO_ROOT}/leg-a-resume")" == 0 ]] || fail "leg A: persona ${name} (${id}) was resumed"
    if ! _scenario_split_line "$(cat "${SCENARIO_ROOT}/leg-a-spawn")" || ! _scenario_decode_words; then
        fail "leg A: persona ${name}'s spawn line does not parse"
    fi
    _scenario_ad_verb
    for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
        # src/ad-phase1-types.ts: a reuse spawn's flag.
        [[ "${a}" != --reuse-finished* ]] || fail "leg A: persona ${name} (${id}) was spawned with ${a}, not a plain spawn"
    done
    [[ "${_L_PPID}" == "${SERVER_PID}" ]] || fail "leg A: persona ${name}'s spawn has parent ${_L_PPID}, not the bot server ${SERVER_PID}"
    # Its dev-channels dialog cleared through agent-director, before it read waiting.
    for verb in read-pane send-keys; do
        calls_naming "${LEG_A_LOG}" "${verb}" "${id}" "${SCENARIO_ROOT}/leg-a-${verb}"
        cleared=0
        while IFS= read -r line; do
            _scenario_split_line "${line}" || continue
            if [[ "${_L_PPID}" == "${SERVER_PID}" ]] && (( _L_US <= WAITING_US[${id}] )); then
                cleared=1
            fi
        done < "${SCENARIO_ROOT}/leg-a-${verb}"
        (( cleared )) || fail "leg A: no ${verb} of row ${id} by the bot server before persona ${name}'s row read waiting"
    done
done
# Pre-persona rows: kept, and never named by a CSCB call.
for id in "${OLD_IDS[@]}"; do
    calls_naming "${LEG_A_LOG}" "" "${id}" "${SCENARIO_ROOT}/leg-a-old"
    n="$(line_count "${SCENARIO_ROOT}/leg-a-old")"
    if [[ "${n}" != 0 ]]; then
        sed 's/^/  | /' "${SCENARIO_ROOT}/leg-a-old" >&2
        fail "leg A: ${n} CSCB call(s) name the pre-persona row ${id}"
    fi
    row_get "leg A: the pre-persona row ${id} is gone" "${id}"
done
# No kill, delete or second launch by CSCB.
for verb in kill delete; do
    cscb_lines "${LEG_A_LOG}" "${verb}" "${SCENARIO_ROOT}/leg-a-${verb}"
    n="$(line_count "${SCENARIO_ROOT}/leg-a-${verb}")"
    if [[ "${n}" != 0 ]]; then
        sed 's/^/  | /' "${SCENARIO_ROOT}/leg-a-${verb}" >&2
        fail "leg A: CSCB made ${n} ${verb} call(s)"
    fi
done
launches=0
for verb in spawn resume; do
    cscb_lines "${LEG_A_LOG}" "${verb}" "${SCENARIO_ROOT}/leg-a-all-${verb}"
    launches=$(( launches + $(line_count "${SCENARIO_ROOT}/leg-a-all-${verb}") ))
done
(( launches == ${#PERSONA_IDS[@]} )) || fail "leg A: CSCB made ${launches} launch(es), not one per persona (${#PERSONA_IDS[@]})"
# No persona reaches the restart cap.
for m in '[slack] Cap reached for persona=' 'the persona is at the restart cap' 'is at cap — skipping tick'; do
    if (( $(count_log "${m}") > 0 )); then
        grep -F -- "${m}" "${SLACK_STATE_DIR}/server.log" | sed 's/^/  | /' >&2
        fail "leg A: server.log holds a restart-cap line ('${m}')"
    fi
done
cap_posts="$(jq -r 'select(.event == "api" and (.text // "" | contains("consecutive session-launch failures — automatic restarts suspended"))) | .channel // "-"' \
    "${SLACK_RECORD}")" || fail "leg A: could not read the Slack stub's record ${SLACK_RECORD}"
[[ -z "${cap_posts}" ]] || fail "leg A: the Slack stub's record holds a restart-cap notice (channel ${cap_posts//$'\n'/, })"
# No post repeats.
repeats="$(jq -rs '[.[] | select(.event == "api" and .method == "chat.postMessage") | {channel, text}]
    | group_by([.channel, .text]) | map(select(length > 1)) | map("\(.[0].channel): \(.[0].text | tostring | .[0:80]) (\(length) times)") | .[]' \
    "${SLACK_RECORD}")" || fail "leg A: could not read the Slack stub's record ${SLACK_RECORD}"
[[ -z "${repeats}" ]] || fail "leg A: a post repeats: ${repeats//$'\n'/; }"
posts="$(jq -s '[.[] | select(.event == "api" and .method == "chat.postMessage")] | length' "${SLACK_RECORD}")"
record "leg A: every persona started fresh once; pre-persona rows kept and never named; dialogs cleared through agent-director; no kill, delete or second launch; no restart cap; ${posts} post(s), none repeated"

# ---------------------------------------------------------------------------
# Step 11
# ---------------------------------------------------------------------------

runbook_step 11
runbook_substitute 11 expire-skipped "the daily agent-director expire schedule is skipped"
runbook_substitute 11 prompt-wording-skipped "the orchestrator prompt's hold-until-after wording (§6) is skipped"

# ---------------------------------------------------------------------------
# Closing
# ---------------------------------------------------------------------------

(( RUNBOOK_NEXT - 1 == RUNBOOK_COUNT )) \
    || fail "runbook: steps 1 to $(( RUNBOOK_NEXT - 1 )) entered, not the runbook's ${RUNBOOK_COUNT}"
entered="$(grep -c '\] entered: ' "${SWITCH_LOG}")"
[[ "${entered}" == "${RUNBOOK_COUNT}" ]] || fail "runbook: ${entered} step entries in the switch-over log, not ${RUNBOOK_COUNT}"
echo "${TEST_NAME}: switch-over log:"
sed 's/^/  /' "${SWITCH_LOG}"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
