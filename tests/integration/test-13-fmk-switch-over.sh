#!/usr/bin/env bash
# AD outcome and lifecycle regression checks; no startup TUI interpretation.
set -euo pipefail

TEST_NAME="test-13-fmk-switch-over"
# The pre-persona fleet runs on agent-director 0.10.0 (read by scenario.sh).
SCENARIO_AD_START=0.10.0
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# The image's fixed files (docker/Dockerfile.test.base) and pinned versions
# ---------------------------------------------------------------------------

REL_RELEASE_JSON=/opt/agent-director/client/release.json
REL_CLIENT_CHECK=/opt/agent-director/check/ad-client-check.sh
AD_010_CLIENT_TGZ=/opt/agent-director-0.10.0/agent-director-0.10.0.tgz
CSCB_010_TGZ=/opt/claude-slack-channel-bots-0.10.0/claude-slack-channel-bots-0.10.0.tgz
PACKAGE_TGZ=/tmp/package.tgz
SWITCH_OVER_TS="${SCENARIO_FIXTURES}/switch-over.ts"

for f in "${REL_RELEASE_JSON}" "${REL_CLIENT_CHECK}" "${AD_010_CLIENT_TGZ}" "${CSCB_010_TGZ}" "${PACKAGE_TGZ}" "${SWITCH_OVER_TS}"; do
    [[ -f "${f}" ]] || fail "setup: ${f} is missing from the image"
done
REL_VERSION="$(jq -r '.version // empty' "${REL_RELEASE_JSON}")" || fail "setup: could not read ${REL_RELEASE_JSON}"
REL_COMMIT="$(jq -r '.commit // empty' "${REL_RELEASE_JSON}")" || fail "setup: could not read ${REL_RELEASE_JSON}"
[[ -n "${REL_VERSION}" && -n "${REL_COMMIT}" ]] || fail "setup: ${REL_RELEASE_JSON} names no version or no commit"

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

# The host's own files: the switch-over log (which holds the operator's
# go-ahead), the staged persona configuration, the crontable prompts, the
# /interject callers, the token variables and the rollback copies.
HOST_DIR="${SCENARIO_ROOT}/host"
SWITCH_LOG="${HOST_DIR}/switch-over.log"
STAGED_CONFIG="${HOST_DIR}/config.persona.json"
INTERJECT_CALLERS="${HOST_DIR}/interject-callers.sh"
TOKEN_VARS="${HOST_DIR}/slack-token-variables.env"
COPIES_DIR="${HOST_DIR}/rollback-copies"
STORE_BACKUP="${HOST_DIR}/state.db.backup"
SUBSTITUTIONS="${HOST_DIR}/substitutions"
# The agent-director settings step 1 records (`switch-over.ts settings`).
STEP1_SETTINGS="${SCENARIO_ROOT}/settings-step1"
# agent-director's trail in the scenario HOME.
AD_TRAIL="${SCENARIO_AD_ROOT}/ad-trail.jsonl"

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

# The two state directories. The old 0.10.0 package keeps everything, config.json
# included, in OLD_STATE_DIR, and its CLI reads config.json from there whatever
# SLACK_STATE_DIR says (it is never exported here anyway). The build under test
# defaults to NEW_STATE_DIR since b.smv and, at its first start (step 10), moves
# OLD_STATE_DIR there and leaves a symbolic link at the old name. Until that
# start the scenario's files are in OLD_STATE_DIR and neither NEW_STATE_DIR nor
# LEGACY_XDG_DIR (0.14.0 and 0.15.0's default, which a 0.13 host never had)
# exists; from it, the files are in NEW_STATE_DIR.
OLD_STATE_DIR="${HOME}/.claude/channels/slack"
LEGACY_XDG_DIR="${HOME}/.config/cscb"
NEW_STATE_DIR="${HOME}/.config/claude-slack-channel-bots"

# The harness helpers (server_pid, count_log, run_start, start_server,
# stop_server, write_config, cscb_run) read the shell variable SLACK_STATE_DIR
# as the directory in use. It is kept as an unexported shell variable, so no
# CSCB process (the old CLI, the new CLI, the server) inherits it: a customer
# sets none, and an exported one would stop the new release migrating.
use_state_dir() {
    SLACK_STATE_DIR="$1"
    export -n SLACK_STATE_DIR
}

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

# src/install-check-labels.ts AD_BELOW_PHASE1_FLOOR: the startup gate's class
# label for the native client's refusal before CSCB's floor check.
AD_SYSTEM_INSTALL_TOO_OLD_LABEL=ad-system-install-too-old

# The runbook's own bound in step 4: "wait at most 5 minutes".
STEP4_WAIT_S=300

# Bound on the Slack stub writing its ready file, in seconds.
SLACK_STUB_WAIT_S=20

# src/cli.ts DAEMON_STARTUP_WAIT_MS, in seconds: how long the CLI's start
# (clean_restart's included) waits for the daemon.
DAEMON_STARTUP_WAIT_S=30

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
POSTS_COMPARED=""

# The runbook's state: the next step, the step being run and the step count.
RUNBOOK_NEXT=1
RUNBOOK_CURRENT=""
RUNBOOK_COUNT=""

# The substitution kinds SRJ-1402 allows (see the table in the header).
SUBSTITUTION_KINDS=(operator-go-ahead container-settings one-socket claude-code-check-skipped
    staging-build-under-test slack-fixtures prompt-wording-skipped autostart-skipped
    harness-stops-agents release-install-script no-agents-restarted container-list expire-skipped)

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
    [[ -n "${title}" ]] || fail "runbook: step ${n} is not in ${RUNBOOK_PKG}/docs/migration.md's runbook"
    if [[ -z "${RUNBOOK_COUNT}" ]]; then
        RUNBOOK_COUNT="${count}"
    fi
    [[ "${count}" == "${RUNBOOK_COUNT}" ]] \
        || fail "runbook: ${RUNBOOK_PKG}/docs/migration.md's runbook has ${count} steps, not the ${RUNBOOK_COUNT} read before"
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
# Deliberate pre-0.12 argv: the first runbook steps drive the old client/store.
row_get() {
    ad_capture get "${SCENARIO_AD_ID_FLAG}" "$2"
    (( AD_RC == 0 )) || fail "$1: harness get of ${2} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
}

# row_state <instance-id>: print the row's state (empty when the get fails).
# Deliberate pre-0.12 argv: select the installed stage on either side of step 8.
row_state() {
    ad_capture get "${SCENARIO_AD_ID_FLAG}" "$1"
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
        _scenario_split_line "${line}" || fail "${log##*/}: a shim line does not split: ${line}"
        _scenario_decode_words || fail "${log##*/}: a shim line's words do not decode: ${line}"
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

# lines_after <file> <n> <out-file>: the lines of <file> after its first <n>
# into <out-file> (none when <file> is missing).
lines_after() {
    if [[ ! -f "$1" ]]; then
        : > "$3"
        return 0
    fi
    tail -n "+$(( $2 + 1 ))" "$1" > "$3"
}

# server_calls_naming <log> <verb> <instance-id> <server-pid> <out-file>: of
# `calls_naming`, the lines whose parent is the bot server <server-pid>.
server_calls_naming() {
    local log="$1" verb="$2" id="$3" pid="$4" out="$5" line
    calls_naming "${log}" "${verb}" "${id}" "${out}.cscb"
    : > "${out}"
    while IFS= read -r line; do
        _scenario_split_line "${line}" || fail "${log##*/}: a shim line does not split: ${line}"
        if [[ "${_L_PPID}" == "${pid}" ]]; then
            printf '%s\n' "${line}" >> "${out}"
        fi
    done < "${out}.cscb"
}

# line_times <file>: print the time (microseconds) of each shim line of <file>, in order.
line_times() {
    local line
    while IFS= read -r line; do
        _scenario_split_line "${line}" || fail "${1##*/}: a shim line does not split: ${line}"
        printf '%s\n' "${_L_US}"
    done < "$1"
}

# recorded_setting <settings-file> <name>: the whole-number value a
# `switch-over.ts settings` output records for <name>.
recorded_setting() {
    local v
    v="$(awk -v n="$2" '$1 == n { print $2; exit }' "$1")"
    [[ "${v}" =~ ^[0-9]+$ ]] || fail "${1##*/} records no whole-number ${2} ('${v}')"
    printf '%s\n' "${v}"
}

# no_repeated_posts <where>: fail unless no two chat.postMessage requests in
# the Slack stub's whole record have the same channel and text; print how
# many posts were compared, and set POSTS_COMPARED to it.
no_repeated_posts() {
    local repeats
    POSTS_COMPARED="$(jq -s '[.[] | select(.event == "api" and .method == "chat.postMessage")] | length' "${SLACK_RECORD}")" \
        || fail "$1: could not read the Slack stub's record ${SLACK_RECORD}"
    repeats="$(jq -rs '[.[] | select(.event == "api" and .method == "chat.postMessage") | {channel, text}]
        | group_by([.channel, .text]) | map(select(length > 1)) | map("\(.[0].channel): \(.[0].text | tostring | .[0:80]) (\(length) times)") | .[]' \
        "${SLACK_RECORD}")" || fail "$1: could not read the Slack stub's record ${SLACK_RECORD}"
    [[ -z "${repeats}" ]] || fail "$1: a post repeats: ${repeats//$'\n'/; }"
    echo "${TEST_NAME}: $1: ${POSTS_COMPARED} post(s) compared by channel and text, none repeated"
}

# A durable proof for the one successful resume after its last invocation.
# Poll publication as well as the row: waiting may become visible first.
t13_resume_reported() {
    local id="$1" session="$2" after_us="$3" proof
    lines_after "${AD_TRAIL}" "${LEG_B_TRAIL_FROM}" "${SCENARIO_ROOT}/leg-b-trail"
    proof="$(jq -er -s --arg id "${id}" --arg session "${session}" --argjson after "${after_us}" '
        def epoch: capture("^(?<s>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")
            | (.s + "Z" | fromdateiso8601) + ("0." + (.f // "0") | tonumber);
        map(select(.instance_id == $id and (.ts | epoch) > ($after / 1000000))) as $events
        | [$events[] | select(.event == "ad.resume.moved_to_pending")] as $pending
        | [$events[] | select(.event == "ad.spawn.state_transition" and .prior_state == "pending"
            and .new_state == "waiting" and .triggering_event_name == "SessionStart")] as $moved
        | [$events[] | select(.event == "ad.hook.fired" and .event_name == "SessionStart"
            and .session_id == $session and .upsert_outcome == "updated")] as $hooks
        | select(($pending | length) == 1 and ($moved | length) == 1 and ($hooks | length) > 0)
        | [$pending[0].ts, $moved[0].ts, $hooks[0].ts] | @tsv' "${SCENARIO_ROOT}/leg-b-trail")" || return 1
    read -r pending_ts moved_ts fired_ts <<< "${proof}"
    moved_to=waiting
}

# The launch-start check's samples (step 10): `agent-director list --state
# pending` through the harness call, from a subshell of the scenario's shell,
# one after another from before the start until the stop file exists. Sample
# <n> leaves <n>.out, <n>.err and <n>.at (its start and end in epoch
# microseconds, and its exit status); a list in flight when the stop file
# appears finishes first.
PENDING_SAMPLES="${SCENARIO_ROOT}/pending-samples"
# Bound on the sampler ending once the stop file exists, in seconds.
SAMPLER_STOP_S=30
pending_sampler() {
    local n=0 from rc
    while [[ ! -e "${PENDING_SAMPLES}/stop" ]]; do
        n=$(( n + 1 ))
        from="$(now_us)"
        rc=0
        ad list --state pending > "${PENDING_SAMPLES}/${n}.out" 2> "${PENDING_SAMPLES}/${n}.err" || rc=$?
        printf '%s %s %s\n' "${from}" "$(now_us)" "${rc}" > "${PENDING_SAMPLES}/${n}.at"
    done
}
sampler_gone() {
    ! pid_alive "${pending_sampler_pid}"
}

# persona_slack_traffic <where> <record-file>: fail unless <record-file> (lines
# of the Slack stub's record) holds, for each persona's label, at least one
# apps.connections.open request and one ws-open, so the record is shown to
# capture its Slack traffic. Sets TRAFFIC to what it counted.
persona_slack_traffic() {
    local where="$1" file="$2" cid name opens sockets
    TRAFFIC=""
    for cid in "${CHANNELS[@]}"; do
        name="${PERSONA_OF[${cid}]}"
        opens="$(jq -s --arg l "${name}" '[.[] | select(.event == "api" and .method == "apps.connections.open" and .label == $l)] | length' "${file}")" \
            || fail "${where}: could not read the Slack stub's record ${SLACK_RECORD}"
        sockets="$(jq -s --arg l "${name}" '[.[] | select(.event == "ws-open" and .label == $l)] | length' "${file}")" \
            || fail "${where}: could not read the Slack stub's record ${SLACK_RECORD}"
        (( opens >= 1 && sockets >= 1 )) \
            || fail "${where}: the Slack stub's record holds ${opens} apps.connections.open and ${sockets} ws-open record(s) labelled ${name}: it shows no Slack connection of persona ${name}"
        TRAFFIC+="${TRAFFIC:+, }${name}: ${opens} apps.connections.open, ${sockets} ws-open"
    done
}

# check_pending_samples: over the sampler's samples, fail unless each exited
# 0 with a spawns array, and every row a sample shows has state pending and a
# launch_started_at. Sets SAMPLES (how many) and SEEN_PENDING (instance id to
# how many samples showed it).
declare -A SEEN_PENDING=()
SAMPLES=0
check_pending_samples() {
    local at from to rc n out bad id
    SAMPLES=0
    SEEN_PENDING=()
    for at in "${PENDING_SAMPLES}"/*.at; do
        [[ -f "${at}" ]] || continue
        n="${at##*/}"
        n="${n%.at}"
        out="${PENDING_SAMPLES}/${n}.out"
        read -r from to rc < "${at}" || fail "step 10: the pending sample ${n} has no times"
        (( rc == 0 )) || fail "step 10: the pending sample ${n} (agent-director list --state pending) exited ${rc}: $(head -c 300 "${PENDING_SAMPLES}/${n}.err")"
        jq -e '.spawns | type == "array"' "${out}" > /dev/null 2>&1 \
            || fail "step 10: the pending sample ${n} printed no spawns array: $(head -c 300 "${out}")"
        bad="$(jq -r '[.spawns[] | select(.state != "pending" or (.launch_started_at // null) == null)
            | "\(.instance_id) (\(.state), launch_started_at \(.launch_started_at // "none"))"] | join(", ")' "${out}")" \
            || fail "step 10: could not read the pending sample ${n}"
        [[ -z "${bad}" ]] || fail "step 10: the pending sample ${n} (${from} to ${to}) shows row(s) not pending with a launch_started_at: ${bad}"
        while IFS= read -r id; do
            [[ -n "${id}" ]] || continue
            SEEN_PENDING["${id}"]=$(( ${SEEN_PENDING[${id}]:-0} + 1 ))
        done < <(jq -r '.spawns[].instance_id' "${out}")
        SAMPLES=$(( SAMPLES + 1 ))
    done
    (( SAMPLES > 0 )) || fail "step 10: the pending sampler took no sample"
}

trail_fresh_pending() {
    local id="$1" file="${SCENARIO_ROOT}/step10-trail" kind ts a b c moved="" keys=0 keys_ts=""
    jq -r --arg id "${id}" 'select(.instance_id == $id)
        | if .event == "ad.spawn.state_transition" then "moved \(.ts) \(.prior_state // "-") \(.new_state // "-") \(.triggering_event_name // "-")"
          elif .event == "ad.send_keys.called" then "keys \(.ts) \(.row_state // "-") - -"
          else empty end' "${file}" > "${file}-${id}" \
        || fail "step 10: could not read the trail ${AD_TRAIL}"
    while read -r kind ts a b c; do
        case "${kind}" in
            moved)
                [[ -n "${moved}" ]] || moved="${ts} ${a} ${b} ${c}"
                ;;
            keys)
                if [[ "${a}" == pending ]]; then
                    keys=$(( keys + 1 ))
                    keys_ts="${keys_ts:-${ts}}"
                fi
                ;;
        esac
    done < "${file}-${id}"
    [[ -n "${moved}" ]] || fail "step 10: the trail holds no ad.spawn.state_transition record for row ${id} after the start"
    read -r ts a b c <<< "${moved}"
    [[ "${a}" == pending && "${b}" == waiting && "${c}" == SessionStart ]] \
        || fail "step 10: row ${id}'s first state transition in the trail after the start (${ts}) is ${a} to ${b} by ${c}, not pending to waiting by SessionStart"
    (( keys == 0 )) || fail "step 10: the trail records ${keys} automatic pending startup key call(s) of ${id}"
    TRAIL_WAITING_US="$(date -u -d "${ts}" +%s%6N)" || fail "step 10: invalid SessionStart transition time ${ts}"
    TRAIL_NOTE="no startup keys; first AD state transition moves pending to waiting by SessionStart at ${ts}"
}

samples_inside_pending() {
    local id="$1" at n from to rc
    PENDING_FROM_US=""
    PENDING_TO_US="${TRAIL_WAITING_US}"
    for at in "${PENDING_SAMPLES}"/*.at; do
        [[ -f "${at}" ]] || continue
        n="${at##*/}"
        n="${n%.at}"
        if jq -e --arg id "${id}" 'any(.spawns[]; .instance_id == $id)' "${PENDING_SAMPLES}/${n}.out" > /dev/null; then
            read -r from to rc < "${at}"
            if [[ -z "${PENDING_FROM_US}" ]] || (( to < PENDING_FROM_US )); then PENDING_FROM_US="${to}"; fi
        fi
    done
    [[ -n "${PENDING_FROM_US}" ]] || fail "step 10: no authoritative pending sample for ${id}"
    INSIDE=0
    for at in "${PENDING_SAMPLES}"/*.at; do
        [[ -f "${at}" ]] || continue
        n="${at##*/}"
        n="${n%.at}"
        read -r from to rc < "${at}" || fail "step 10: the pending sample ${n} has no times"
        (( from >= PENDING_FROM_US && to <= PENDING_TO_US )) || continue
        jq -e --arg id "${id}" 'any(.spawns[]; .instance_id == $id)' "${PENDING_SAMPLES}/${n}.out" > /dev/null \
            || fail "step 10: the pending sample ${n} (${from} to ${to}), taken while row ${id} provably read pending, does not show it"
        INSIDE=$(( INSIDE + 1 ))
    done
}

# ---------------------------------------------------------------------------
# Setup: the pre-persona 0.10.0 starting point
# ---------------------------------------------------------------------------

mkdir -p "${HOST_DIR}" "${COPIES_DIR}" "${OLD_STATE_DIR}" "${STAGING_DIR}" "${BUN_CACHE}" \
    || fail "setup: could not create the scenario's directories"
: > "${SWITCH_LOG}" || fail "setup: could not create ${SWITCH_LOG}"
: > "${SUBSTITUTIONS}" || fail "setup: could not create ${SUBSTITUTIONS}"
# The scenario sourced lib/scenario.sh, which exports SLACK_STATE_DIR (the
# scenario's own state directory, under SCENARIO_ROOT); neither it nor an
# XDG_CONFIG_HOME may reach the CSCB processes. The state is in the old directory.
unset XDG_CONFIG_HOME
use_state_dir "${OLD_STATE_DIR}"
[[ ! -e "${NEW_STATE_DIR}" ]] || fail "setup: ${NEW_STATE_DIR} exists before the new release's first start"

# The operator's go-ahead for the switch-over on this container: the harness,
# playing the operator, records it in the switch-over log before step 1,
# never in a runbook step. Steps 1 and 8 read it from there; with none, the
# run fails there ("no go"). GO_AHEAD_ENTRY is the line `record` writes.
HOST_NAME="$(cat /proc/sys/kernel/hostname)" || fail "setup: could not read the host name"
GO_AHEAD="$(date -u +%F) ${HOST_NAME}: the switch-over to agent-director Phase 1 approved (the operator's, given by the harness)"
record "go-ahead: ${GO_AHEAD}"
GO_AHEAD_ENTRY="[setup] go-ahead: ${GO_AHEAD}"

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
} | write_file "${OLD_STATE_DIR}/crontab"
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
    | write_file "${OLD_STATE_DIR}/access.json" 0600
printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$(fake_token bot "${SCENARIO_TAG}old")" "$(fake_token app "${SCENARIO_TAG}old")" \
    | write_file "${TOKEN_VARS}" 0600

# The pre-persona fleet on 0.10.0.
fleet_args=()
for cid in "${CHANNELS[@]}"; do
    fleet_args+=("${cid}=${SLACK_NAME[${cid}]}")
done
seed_prepersona_fleet "${OLD_STATE_DIR}/config.json" "${fleet_args[@]}" > "${SCENARIO_ROOT}/fleet.out"
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
    jq -e --arg key "${SCENARIO_AD_ID_COLUMN}" --arg id "${id}" --arg s "${OLD_SESSIONS[i]}" --arg c "${cid}" \
        '.[$key] == $id and .tmux_session_name == $s and .labels.service == "cscb" and .labels.channel == $c and (.labels | has("persona") | not)' \
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
# script follows is its docs/migration.md's.
tar -xzf "${PACKAGE_TGZ}" -C "${STAGING_DIR}" --no-same-owner || fail "setup: could not unpack ${PACKAGE_TGZ}"
[[ -f "${STAGED_PKG}/docs/migration.md" ]] || fail "setup: ${PACKAGE_TGZ} holds no package/docs/migration.md"

# ---------------------------------------------------------------------------
# Step 1
# ---------------------------------------------------------------------------

runbook_step 1

grep -qxF "${GO_AHEAD_ENTRY}" "${SWITCH_LOG}" \
    || fail "step 1: the switch-over log holds no go-ahead for ${HOST_NAME}: no go, stopping before anything goes down"
record "go-ahead confirmed: ${GO_AHEAD}"
runbook_substitute 1 operator-go-ahead "the operator's go-ahead is the switch-over log entry the harness recorded before step 1"

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

[[ ! -e "${SCENARIO_AD_ROOT}/config.toml" ]] || fail "step 1: the scenario HOME has an agent-director config.toml"
read_settings "${STAGED_PKG}" "${STEP1_SETTINGS}"
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
        --arg creds "${OLD_STATE_DIR}/credentials-${name}.json" --arg cfg "${SCENARIO_ROOT}/claude-config/${name}" \
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
for f in "${OLD_STATE_DIR}/config.json" "${OLD_STATE_DIR}/crontab" "${INTERJECT_CALLERS}" "${OLD_STATE_DIR}/access.json" "${TOKEN_VARS}"; do
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
got="$("${SCENARIO_AD_ROOT}/bin/agent-director.real" version | jq -r '.version // empty')"
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
live="$(jq -r --arg key "${SCENARIO_AD_ID_COLUMN}" '[.[] | select(.state != "ended" and .state != "missing") | .[$key]] | join(" ")' "${SCENARIO_ROOT}/rows-step5.json")"
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
# The release's client in place of 0.10.0's: the global install's override
# now names the image's release client tarball (the npm tarball the base
# fetched and pinned), so the build under test resolves the release's client
# as an operator's install from the registry would.
REL_CLIENT_TGZ="$(jq -r '.client_tarball // empty' "${REL_RELEASE_JSON}")" \
    || fail "step 7: could not read ${REL_RELEASE_JSON}"
[[ -f "${REL_CLIENT_TGZ}" ]] || fail "step 7: the release's client tarball '${REL_CLIENT_TGZ}' is missing from the image"
global_pkg_json="$(jq --arg ad "file:${REL_CLIENT_TGZ}" '.overrides["agent-director"] = $ad' \
    "${CSCB_GLOBAL}/install/global/package.json")" \
    || fail "step 7: could not read the global install's package.json"
write_file "${CSCB_GLOBAL}/install/global/package.json" <<< "${global_pkg_json}"
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
# The release's client, checked by the image's check.
# The scenario HOME still runs 0.10.0 here, so the check, which probes the
# first agent-director on PATH and Client.create() under HOME, runs with a
# HOME of its own and the release's binary first on PATH.
mkdir "${SCENARIO_ROOT}/ad-check-home" || fail "step 7: could not create the check's HOME"
if ! env HOME="${SCENARIO_ROOT}/ad-check-home" PATH="$(dirname -- "${SCENARIO_RELEASE_BIN}"):${PATH}" \
    "${REL_CLIENT_CHECK}" --package "${CSCB_PKG_DIR}" > "${SCENARIO_ROOT}/ad-client-check.out" 2>&1; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/ad-client-check.out" >&2
    fail "step 7: the release's client check on ${CSCB_PKG_DIR} failed: $(grep -m1 '^ERROR:' "${SCENARIO_ROOT}/ad-client-check.out" || echo 'no ERROR line')"
fi
record "$(cat "${SCENARIO_ROOT}/ad-client-check.out")"
# The CLI at the one install path is the build under test's from here on.
export SCENARIO_CLI="${CSCB_CLI}"
RUNBOOK_PKG="${CSCB_PKG_DIR}"
record "installed: ${PKG_NAME} ${STAGED_VERSION} at ${CSCB_PKG_DIR} (CLI ${CSCB_CLI}), the release's client"
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
    creds="${OLD_STATE_DIR}/credentials-${name}.json"
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
    sed -i -e "s/\(^\|[ ,]\)${cid}\([ ,]\|\$\)/\1${PERSONA_OF[${cid}]}\2/g" "${OLD_STATE_DIR}/crontab" \
        || fail "step 7: could not rewrite the crontable"
    sed -i -e "s/\"channel\": \"${cid}\"/\"persona\": \"${PERSONA_OF[${cid}]}\"/g" "${INTERJECT_CALLERS}" \
        || fail "step 7: could not rewrite the /interject callers"
done
for cid in "${CHANNELS[@]}"; do
    ! grep -qF -- "${cid}" "${OLD_STATE_DIR}/crontab" || fail "step 7: the crontable still targets channel ${cid}"
    ! grep -qF -- "${cid}" "${INTERJECT_CALLERS}" || fail "step 7: an /interject caller still names channel ${cid}"
done
[[ "$(grep -c '"persona": ' "${INTERJECT_CALLERS}")" == "${#CHANNELS[@]}" ]] \
    || fail "step 7: the /interject callers do not each name a persona"
record "crontable targets and /interject callers rewritten to name personas"

# The release check deliberately refuses the still-installed pre-0.12 binary;
# the upgrade remains step 8, after backup and operator authorization.
rc=0
cscb_run env PATH="${SCENARIO_AD_ROOT}/bin:${PATH}" bun "${CSCB_PKG_DIR}/scripts/install-check.ts" < /dev/null > "${SCENARIO_ROOT}/install-check.out" 2>&1 || rc=$?
(( rc != 0 )) || fail "step 7: the release install check accepted the pre-0.12 install"
grep -qF 'agent-director install check: FAILED (ad-system-install-too-old)' "${SCENARIO_ROOT}/install-check.out" \
    || fail "step 7: the failed check printed no install diagnostic"
record "install check refuses the pre-0.12 install (exit ${rc}); step 8 installs the release"

# E4_EARLIER_RELEASE_PROVENANCE
# b.omv SR-7.6/SR-13.6: create real 0.10.0 worker conversations, with persona
# identity but no tag_prompt and no appended system prompt. Merely relabelling
# a current-build conversation would not establish earlier-release provenance.
declare -A E4_OLD_SESSION=() E4_MEMORY=()
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    key="$(persona_key "${name}")"
    id="cscb_${key}"
    mapfile -t e4_labels < <(CSCB_PKG_DIR="${CSCB_PKG_DIR}" bun --no-install "${SCENARIO_FIXTURES}/fmk-texts.ts" personaDefaultConfigDirLabels "${key}" "${HOME}")
    e4_old_labels=()
    for e4_label in "${e4_labels[@]}"; do
        [[ "${e4_label}" == tag_prompt=* ]] || e4_old_labels+=("${e4_label}")
    done
    stub_mode "${WORKDIR_OF[${name}]}" "${STUB_MODE_AT_ONCE}"
    seed_010_row "${id}" "slack_bot_${key}" "${WORKDIR_OF[${name}]}" "${e4_old_labels[@]}" > "${SCENARIO_ROOT}/e4-seed-${key}"
    row_get "E4 earlier-release provenance" "${id}"
    jq -e --arg args_key "${SCENARIO_AD_ARGS_KEY}" \
        '.labels.tag_prompt == null and (.[$args_key] | type == "array" and (index("--append-system-prompt-file") | not))' "${AD_OUT}" >/dev/null \
        || fail "E4: seed ${id} unexpectedly has the current contract"
    E4_OLD_SESSION["${id}"]="$(jq -er --arg session_key "${SCENARIO_AD_SESSION_KEY}" '.[$session_key] | select(type == "string" and length > 0)' "${AD_OUT}")" \
        || fail "E4: seed ${id} has no earlier-release conversation id"
    E4_MEMORY["${id}"]="${HOME}/.claude/projects/${WORKDIR_OF[${name}]//\//-}/memory/MEMORY.md"
    mkdir -p "$(dirname "${E4_MEMORY[${id}]}")"
    printf 'Retained earlier-release memory for %s\n' "${id}" | write_file "${E4_MEMORY[${id}]}" 0600
    cp -- "${E4_MEMORY[${id}]}" "${SCENARIO_ROOT}/e4-memory-${key}.before"
    stub_type_exit "slack_bot_${key}"
    wait_until "${SCENARIO_SEED_REPORT_S}" "E4: seed ${id} never ended" row_state_is "${id}" ended missing
    record "E4: genuine ${SCENARIO_AD_010_VERSION} markerless conversation ${E4_OLD_SESSION[${id}]} seeded for ${id} without an appended prompt; memory saved"
done

# ---------------------------------------------------------------------------
# Step 8
# ---------------------------------------------------------------------------

runbook_step 8
grep -qxF "${GO_AHEAD_ENTRY}" "${SWITCH_LOG}" \
    || fail "step 8: the switch-over log no longer holds the go-ahead for ${HOST_NAME}: no go, no Phase 1 install"
record "go-ahead still stands: ${GO_AHEAD}"
runbook_substitute 8 operator-go-ahead "the operator's go-ahead is the switch-over log entry the harness recorded before step 1"

# The harness's stop of every other agent: none is seeded.
list_rows "step 8" "${SCENARIO_ROOT}/rows-step8.json"
live="$(jq -r --arg key "${SCENARIO_AD_ID_COLUMN}" '[.[] | select(.state != "ended" and .state != "missing") | .[$key]] | join(" ")' "${SCENARIO_ROOT}/rows-step8.json")"
[[ -z "${live}" ]] || fail "step 8: agent rows still live: ${live}"
tmux_sessions sessions
(( ${#sessions[@]} == 0 )) || fail "step 8: tmux sessions are left: ${sessions[*]}"
record "every other agent stopped: no agent row live, no tmux session"
runbook_substitute 8 harness-stops-agents "the harness stops every other agent in the container; none is seeded"

ad_store_backup "${STORE_BACKUP}"
record "store backup: ${STORE_BACKUP} (sqlite3 .backup; integrity check ok)"

install_ticks="$(_scenario_proc_starttime "${BASHPID}")"
[[ "${install_ticks}" =~ ^[0-9]+$ ]] || fail "step 8: could not read the time before the install"
install_ad_release "step 8: install agent-director Phase 1"
AD_TRAIL="${SCENARIO_AD_ROOT}/ad-trail.jsonl"
ad_capture version
(( AD_RC == 0 )) || fail "step 8: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
got="$(jq -r '.version // empty' "${AD_OUT}")"
[[ "${got}" == "${REL_VERSION}" && "$(jq -r '.commit // empty' "${AD_OUT}")" == "${REL_COMMIT}" ]] \
    || fail "step 8: agent-director version reports '${got}', not the release's ${REL_VERSION} (${REL_COMMIT})"
real_v="$("${SCENARIO_AD_ROOT}/bin/agent-director.real" version | jq -r '.version // empty')"
[[ "${real_v}" == "${REL_VERSION}" ]] || fail "step 8: the binary behind the shim reports '${real_v}', not ${REL_VERSION}"
runbook_substitute 8 release-install-script "the Phase 1 install is the release's install.sh, run in the scenario HOME, then the re-shim; the serve restart and start-time check cover the container's agent-director processes"
[[ ! -e "${SCENARIO_AD_ROOT}/config.toml" ]] || fail "step 8: a config.toml was written; the scenario writes no [tmux] table"
older=()
count=0
for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    exe="$(readlink -- "${proc}/exe" 2> /dev/null || true)"
    cmd="$(tr '\0' ' ' < "${proc}/cmdline" 2> /dev/null || true)"
    [[ "${exe}" == "${SCENARIO_AD_ROOT}/"* || "${cmd}" == *"${SCENARIO_AD_ROOT}/bin/agent-director"* ]] || continue
    st="$(_scenario_proc_starttime "${pid}")"
    [[ -n "${st}" ]] || continue
    count=$(( count + 1 ))
    (( st >= install_ticks )) || older+=("${pid}")
done
(( ${#older[@]} == 0 )) || fail "step 8: agent-director process(es) older than the install still run: ${older[*]}"
record "agent-director ${got} (${REL_COMMIT}); ${count} agent-director process(es) of the scenario run, none older than the install"

read_settings "${CSCB_PKG_DIR}" "${SCENARIO_ROOT}/settings-step8"
check_windows "step 8"
NEED_MS="${SETTINGS[call_timeout_need_ms]}"
current="$(jq -r '.agent_director_call_timeout_ms' "${OLD_STATE_DIR}/config.json")"
if (( current <= NEED_MS )); then
    raised=$(( NEED_MS + CALL_TIMEOUT_HEADROOM_MS ))
    jq --argjson v "${raised}" '.agent_director_call_timeout_ms = $v' "${OLD_STATE_DIR}/config.json" > "${SCENARIO_ROOT}/config.raised.json" \
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
# E4_FRESH_UPGRADE_REPLACEMENT

runbook_step 10
runbook_substitute 10 prompt-wording-skipped "the orchestrator prompt's worker-cleanup wording is skipped"
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    stub_mode "${WORKDIR_OF[${name}]}" "${STUB_MODE_AT_ONCE}"
    stub_report_delay "${WORKDIR_OF[${name}]}" 3
    # src/persona-identity.ts personaInstanceId.
    PERSONA_IDS+=("cscb_$(persona_key "${name}")")
done
# Before the first start of the new release, the state is where the old release
# left it (a 0.13-or-earlier layout: the one real directory under ~/.claude),
# and the new default directory does not exist. Nothing in steps 1 to 9 may
# have created it, or the start would merge entries instead of moving the
# directory.
[[ -f "${OLD_STATE_DIR}/config.json" ]] || fail "step 10: ${OLD_STATE_DIR}/config.json is missing before the first start"
[[ ! -e "${NEW_STATE_DIR}" && ! -L "${NEW_STATE_DIR}" ]] \
    || fail "step 10: ${NEW_STATE_DIR} exists before the first start"
[[ -d "${OLD_STATE_DIR}" && ! -L "${OLD_STATE_DIR}" ]] \
    || fail "step 10: ${OLD_STATE_DIR} is not a real directory before the first start"
[[ ! -e "${LEGACY_XDG_DIR}" && ! -L "${LEGACY_XDG_DIR}" ]] \
    || fail "step 10: ${LEGACY_XDG_DIR} exists before the first start"
# From here the harness reads the directory the new release works in (still
# not exported: the release finds it as a customer's does).
use_state_dir "${NEW_STATE_DIR}"
LEG_A_AD_FROM="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
LEG_A_TRAIL_FROM="$(line_count "${AD_TRAIL}")"
LEG_A_RECORD_FROM="$(line_count "${SLACK_RECORD}")"
mkdir "${PENDING_SAMPLES}" || fail "step 10: could not create ${PENDING_SAMPLES}"
pending_sampler &
pending_sampler_pid=$!
track_pid "${pending_sampler_pid}"
leg_a_start_us="$(now_us)"
start_server --live
record "the new CSCB started (bot server PID ${SERVER_PID})"

# The first start migrated the state directory to the new default, and a
# symbolic link to it stays at each old name. The configuration, crontable,
# access.json and each persona's credentials file came along, and the server's
# pid file and log are in the new directory.
for f in config.json crontab access.json server.pid server.log; do
    [[ -f "${NEW_STATE_DIR}/${f}" ]] || fail "step 10: ${NEW_STATE_DIR}/${f} does not exist after the first start"
done
for cid in "${CHANNELS[@]}"; do
    f="credentials-${PERSONA_OF[${cid}]}.json"
    [[ -f "${NEW_STATE_DIR}/${f}" ]] || fail "step 10: ${NEW_STATE_DIR}/${f} does not exist after the first start"
done
[[ -d "${NEW_STATE_DIR}" && ! -L "${NEW_STATE_DIR}" ]] || fail "step 10: ${NEW_STATE_DIR} is not a real directory"
[[ ! -L "${NEW_STATE_DIR}/crontab" ]] || fail "step 10: ${NEW_STATE_DIR}/crontab is a symbolic link, not the file"
for f in "${NEW_STATE_DIR}/config.json" "${NEW_STATE_DIR}/crontab"; do
    [[ -s "${f}" ]] || fail "step 10: ${f} is empty after the first start"
done
# L1 is the one old name, a link to the new directory; L2 was never made.
[[ "$(readlink -- "${OLD_STATE_DIR}")" == "${NEW_STATE_DIR}" ]] \
    || fail "step 10: ${OLD_STATE_DIR} is not a symbolic link to ${NEW_STATE_DIR} after the first start (it links to '$(readlink -- "${OLD_STATE_DIR}" || true)')"
[[ ! -e "${LEGACY_XDG_DIR}" && ! -L "${LEGACY_XDG_DIR}" ]] \
    || fail "step 10: ${LEGACY_XDG_DIR} exists after the first start"
# The old name reaches the new directory's files.
[[ "$(readlink -f -- "${OLD_STATE_DIR}")" == "$(readlink -f -- "${NEW_STATE_DIR}")" ]] \
    || fail "step 10: ${OLD_STATE_DIR} does not reach ${NEW_STATE_DIR} after the first start"
cmp -s -- "${OLD_STATE_DIR}/config.json" "${NEW_STATE_DIR}/config.json" \
    || fail "step 10: ${OLD_STATE_DIR}/config.json is not ${NEW_STATE_DIR}/config.json"
[[ "$(server_pid)" == "${SERVER_PID}" ]] || fail "step 10: ${NEW_STATE_DIR}/server.pid does not name the bot server (PID ${SERVER_PID})"
# The line is src/state-dir-migration.ts stateDirRenamedLine's text: the move
# out of ~/.claude. Test-30 covers the 0.14.0 and 0.15.0 layouts.
renamed_line="[slack] state-migrate: moved the state directory from ${OLD_STATE_DIR} to ${NEW_STATE_DIR}, its new default location outside ~/.claude, where Claude Code does not ask before a write. ${OLD_STATE_DIR} is now a symbolic link to it, so a session, script or configuration path that still names the old directory reaches the same files."
n="$(grep -cF -- "${renamed_line}" "${NEW_STATE_DIR}/server.log" || true)"
if [[ "${n}" != 1 ]]; then
    sed 's/^/  | /' "${NEW_STATE_DIR}/server.log" >&2
    fail "step 10: ${NEW_STATE_DIR}/server.log carries ${n} whole-directory rename line(s) from ${OLD_STATE_DIR}, not one"
fi
merged_lines="$(grep -cF -- "[slack] state-migrate: the state directory's new default location is ${NEW_STATE_DIR}, " "${NEW_STATE_DIR}/server.log" || true)"
[[ "${merged_lines}" == 0 ]] || fail "step 10: ${NEW_STATE_DIR}/server.log carries ${merged_lines} merge line(s), where one rename moves it all"
warns="$(grep -cF -- "[slack] Warning: state-migrate:" "${NEW_STATE_DIR}/server.log" || true)"
[[ "${warns}" == 0 ]] || fail "step 10: ${NEW_STATE_DIR}/server.log carries ${warns} state-migrate warning(s) (a conflict or a leftover)"
record "the first start moved the state to ${NEW_STATE_DIR} (a symbolic link stays at the old name); the configuration, crontable, access.json and credentials files are there, and so are server.pid and server.log"
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
# Every persona row has read waiting: the sampler stops.
: > "${PENDING_SAMPLES}/stop" || fail "step 10: could not write ${PENDING_SAMPLES}/stop"
wait_until "${SAMPLER_STOP_S}" "step 10: the pending sampler did not stop" sampler_gone
sampler_rc=0
wait "${pending_sampler_pid}" || sampler_rc=$?
(( sampler_rc == 0 )) || fail "step 10: the pending sampler exited ${sampler_rc}"
stop_tracked_pid "${pending_sampler_pid}" 5 "step 10: the pending sampler did not end"
left_s=$(( (leg_a_deadline_us - $(now_us)) / 1000000 ))
(( left_s > 0 )) || left_s=0
wait_for_log "$(completion_match "${#PERSONA_IDS[@]}")" "${left_s}" "step 10: the start pass never completed"
expect_completion "${#PERSONA_IDS[@]}" "step 10: every persona starts fresh once" \
    "0 resumed" "${#PERSONA_IDS[@]} fresh-spawned" "0 not brought up"

# The launch-start check: every row a sample showed pending has a launch
# start, and each persona's row was pending from its launch until its
# SessionStart (the trail); every sample taken wholly inside the stretch the
# row provably read pending shows it.
check_pending_samples
lines_after "${SCENARIO_AD_SHIM_LOG}" "${LEG_A_AD_FROM}" "${SCENARIO_ROOT}/step10-shim.log"
lines_after "${AD_TRAIL}" "${LEG_A_TRAIL_FROM}" "${SCENARIO_ROOT}/step10-trail"
seen=""
for id in "${PERSONA_IDS[@]}"; do
    trail_fresh_pending "${id}"
    samples_inside_pending "${id}"
    seen+="${seen:+; }${id}: seen pending in ${SEEN_PENDING[${id}]:-0}, ${INSIDE} of them taken wholly inside its provable pending stretch (${PENDING_FROM_US} to ${PENDING_TO_US} epoch microseconds)"
    record "the trail for row ${id}: ${TRAIL_NOTE}"
done
result="every pending row in ${SAMPLES} sample(s) of agent-director list --state pending has a launch_started_at; ${seen}"
# The post-install check's result goes to the switch-over log, as the runbook
# says, and nowhere else.
record "post-install check: ${result}"
echo "${TEST_NAME}: step 10: ${result}"
runbook_substitute 10 container-list "the launch-start check reads the container's agent-director list"

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
    # One colliding plain spawn and one fresh reuse of the old conversation; no resume.
    calls_naming "${LEG_A_LOG}" spawn "${id}" "${SCENARIO_ROOT}/leg-a-spawn"
    calls_naming "${LEG_A_LOG}" resume "${id}" "${SCENARIO_ROOT}/leg-a-resume"
    n="$(line_count "${SCENARIO_ROOT}/leg-a-spawn")"
    [[ "${n}" == 2 ]] || fail "leg A: persona ${name} (${id}) has ${n} spawn calls, expected one collision and one reuse"
    [[ "$(line_count "${SCENARIO_ROOT}/leg-a-resume")" == 0 ]] || fail "leg A: persona ${name} (${id}) was resumed"
    if ! _scenario_split_line "$(tail -n 1 "${SCENARIO_ROOT}/leg-a-spawn")" || ! _scenario_decode_words; then
        fail "leg A: persona ${name}'s spawn line does not parse"
    fi
    _scenario_ad_verb
    e4_reuse=0
    for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
        [[ "${a}" == --reuse-finished* ]] && e4_reuse=1
    done
    (( e4_reuse == 1 )) || fail "E4: ${id} was not freshly replaced by reuse"
    [[ "${_L_PPID}" == "${SERVER_PID}" ]] || fail "leg A: persona ${name}'s spawn has parent ${_L_PPID}, not the bot server ${SERVER_PID}"
    row_get "E4 replacement" "${id}"
    jq -e '.labels.tag_prompt == "1"' "${AD_OUT}" >/dev/null || fail "E4: replacement ${id} lacks tag_prompt=1"
    e4_new_session="$(jq -er '.session_id | select(length > 0)' "${AD_OUT}")"
    [[ "${e4_new_session}" != "${E4_OLD_SESSION[${id}]}" ]] || fail "E4: ${id} resumed its earlier-release conversation"
    key="$(persona_key "${name}")"
    cmp -s -- "${E4_MEMORY[${id}]}" "${SCENARIO_ROOT}/e4-memory-${key}.before" || fail "E4: ${id}'s memory bytes changed"
    for verb in read-pane send-keys; do
        server_calls_naming "${LEG_A_LOG}" "${verb}" "${id}" "${SERVER_PID}" "${SCENARIO_ROOT}/leg-a-${verb}"
        n="$(line_count "${SCENARIO_ROOT}/leg-a-${verb}")"
        (( n == 0 )) || fail "leg A: ${n} automatic startup ${verb} call(s) of ${id}"
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
(( launches == 2 * ${#PERSONA_IDS[@]} )) || fail "leg A: CSCB made ${launches} launch(es), not one collision plus one fresh reuse per persona (${#PERSONA_IDS[@]})"
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
# No post repeats; nothing in the scenario posts, so the record holds none,
# and it holds each persona's Slack traffic.
no_repeated_posts "leg A"
(( POSTS_COMPARED == 0 )) \
    || fail "leg A: the Slack stub's record holds ${POSTS_COMPARED} post(s), not 0: nothing in the scenario posts"
lines_after "${SLACK_RECORD}" "${LEG_A_RECORD_FROM}" "${SCENARIO_ROOT}/leg-a-record"
persona_slack_traffic "leg A" "${SCENARIO_ROOT}/leg-a-record"
record "leg A: every persona started fresh once; pre-persona rows kept and never named; dialogs cleared through agent-director; no kill, delete or second launch; no restart cap; ${POSTS_COMPARED} post(s), none repeated; the Slack stub's record holds each persona's connection (${TRAFFIC})"

# ---------------------------------------------------------------------------
# Step 11
# ---------------------------------------------------------------------------

runbook_step 11
runbook_substitute 11 expire-skipped "the daily agent-director expire schedule is skipped"
runbook_substitute 11 prompt-wording-skipped "the orchestrator prompt's hold-until-after wording (§6) is skipped"

# ---------------------------------------------------------------------------
# E4_LATER_MARKED_RESUME
# Leg B: a clean_restart on Phase 1
# ---------------------------------------------------------------------------

# The bound on each persona reading waiting again once clean_restart is done:
# the stopping window and G as step 1 recorded them, and one health tick as
# config.json sets it.
LEG_B_STOPPING_S="$(recorded_setting "${STEP1_SETTINGS}" tmux.stopping_window_seconds)"
LEG_B_GRACE_MS="$(recorded_setting "${STEP1_SETTINGS}" grace_ms)"
LEG_B_TICK_S="$(jq -r '.health_check_interval // empty' "${NEW_STATE_DIR}/config.json")"
[[ "${LEG_B_TICK_S}" =~ ^[1-9][0-9]*$ ]] || fail "leg B: config.json sets no health_check_interval ('${LEG_B_TICK_S}')"
LEG_B_WAIT_S=$(( LEG_B_STOPPING_S + LEG_B_TICK_S + (LEG_B_GRACE_MS + 999) / 1000 ))
record "leg B bound: ${LEG_B_WAIT_S}s = the stopping window ${LEG_B_STOPPING_S}s + one health tick ${LEG_B_TICK_S}s + G ${LEG_B_GRACE_MS}ms"

# Each persona's conversation before the restart.
declare -A SID_OF=()
for i in "${!PERSONA_IDS[@]}"; do
    id="${PERSONA_IDS[i]}"
    row_get "leg B: before the restart" "${id}"
    jq -e '.labels.tag_prompt == "1"' "${AD_OUT}" >/dev/null || fail "E4: later resume requires a marked replacement"
    SID_OF["${id}"]="$(jq -r '.session_id // empty' "${AD_OUT}")"
    [[ -n "${SID_OF[${id}]}" ]] || fail "leg B: before the restart, row ${id} has no session_id"
    record "leg B: row ${id} ($(jq -r '.state' "${AD_OUT}")) holds conversation ${SID_OF[${id}]}"
done

LEG_A_SERVER_PID="${SERVER_PID}"
LEG_B_AD_FROM="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
LEG_B_SERVER_LOG_FROM="$(line_count "${SLACK_STATE_DIR}/server.log")"
LEG_B_RESTART_LOG_FROM="$(line_count "${SLACK_STATE_DIR}/clean_restart.log")"
LEG_B_RECORD_FROM="$(line_count "${SLACK_RECORD}")"
LEG_B_TRAIL_FROM="$(line_count "${AD_TRAIL}")"
completions_before="$(count_log "$(completion_match "${#PERSONA_IDS[@]}")")"
declare -A CONNECTED_BEFORE=()
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    CONNECTED_BEFORE["${name}"]="$(count_log "[slack] Session connected: persona $(persona_ref "${name}")")"
done

# The new CLI's clean_restart, through the install path, as a CSCB process
# (the tmux shim first on its PATH), with start's environment. It runs in the
# background so that the harness's status reads see each row through it.
LEG_B_OUT="${SCENARIO_ROOT}/clean-restart.out"
# Bound on clean_restart itself: the installed package's own bounds on its
# precheck and its teardown (src/cli-teardown.ts precheckBoundMs and
# teardownBoundMs, at config.json's agent_director_call_timeout_ms and
# exit_timeout), the harness's bound on the CLI's `stop` for the server's
# stop, and the CLI's daemon startup wait.
leg_b_call_ms="$(jq -r '.agent_director_call_timeout_ms // empty' "${NEW_STATE_DIR}/config.json")"
leg_b_exit_s="$(jq -r '.exit_timeout // empty' "${NEW_STATE_DIR}/config.json")"
[[ "${leg_b_call_ms}" =~ ^[1-9][0-9]*$ && "${leg_b_exit_s}" =~ ^[1-9][0-9]*$ ]] \
    || fail "leg B: config.json sets no agent_director_call_timeout_ms ('${leg_b_call_ms}') or exit_timeout ('${leg_b_exit_s}')"
leg_b_cli_ms="$(cd / && TEARDOWN_MODULE="${CSCB_PKG_DIR}/src/cli-teardown.ts" CALL_MS="${leg_b_call_ms}" EXIT_S="${leg_b_exit_s}" bun --no-install -e \
    'const m = await import(process.env.TEARDOWN_MODULE); const call = Number(process.env.CALL_MS); const exit = Number(process.env.EXIT_S); const ms = m.precheckBoundMs(call) + m.teardownBoundMs(exit, call); if (!Number.isInteger(ms) || ms <= 0) process.exit(1); process.stdout.write(String(ms))')" \
    || fail "leg B: could not read precheckBoundMs and teardownBoundMs from ${CSCB_PKG_DIR}/src/cli-teardown.ts"
[[ "${leg_b_cli_ms}" =~ ^[1-9][0-9]*$ ]] || fail "leg B: the CLI's precheck and teardown bounds read as '${leg_b_cli_ms}'"
LEG_B_RESTART_BOUND_S=$(( (leg_b_cli_ms + 999) / 1000 + SCENARIO_STOP_CLI_S + DAEMON_STARTUP_WAIT_S ))
record "leg B: clean_restart bound ${LEG_B_RESTART_BOUND_S}s = the CLI's precheck and teardown bounds ${leg_b_cli_ms}ms + the stop bound ${SCENARIO_STOP_CLI_S}s + the daemon startup wait ${DAEMON_STARTUP_WAIT_S}s"
restart_from_us="$(now_us)"
(
    rc=0
    cscb_run env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u SLACK_DRY_RUN \
        "${CSCB_CLI}" clean_restart < /dev/null > "${LEG_B_OUT}" 2>&1 || rc=$?
    exit "${rc}"
) &
restart_pid=$!
track_pid "${restart_pid}"
echo "${TEST_NAME}: leg B: clean_restart started"

# Harness status reads, from the scenario's shell, until each row reads
# waiting after its resume. The resume is known from server.log (the bot
# server's resumed line, written once agent-director's resume returned):
# every read that starts after that line must read pending with a launch
# start, until one reads waiting. Once clean_restart says it is starting the
# server (clean_restart.log), the rows are read with no pause between reads.
# Every read is kept in LEG_B_READS for the trail checks after the restart.
declare -A REF_OF=() RESUMED_US=() WAITING_B_US=()
for i in "${!PERSONA_IDS[@]}"; do
    REF_OF["${PERSONA_IDS[i]}"]="$(persona_ref "${PERSONA_OF[${CHANNELS[i]}]}")"
done
LEG_B_LOG="${SCENARIO_ROOT}/leg-b-shim.log"
LEG_B_SERVER_LOG="${SCENARIO_ROOT}/leg-b-server.log"
LEG_B_READS="${SCENARIO_ROOT}/leg-b-reads"
: > "${LEG_B_READS}"
restart_done_us=""
hot=0
while :; do
    left=0
    if (( ! hot )) && LC_ALL=C awk -v n="${LEG_B_RESTART_LOG_FROM}" -v m='[slack] clean_restart: starting server' \
        'NR > n && index($0, m) { found = 1; exit } END { exit !found }' "${SLACK_STATE_DIR}/clean_restart.log" 2> /dev/null; then
        hot=1
    fi
    for id in "${PERSONA_IDS[@]}"; do
        [[ -z "${WAITING_B_US[${id}]:-}" ]] || continue
        left=$(( left + 1 ))
        if (( hot )) && [[ -z "${RESUMED_US[${id}]:-}" ]]; then
            line="$(tail -n "+$(( LEG_B_SERVER_LOG_FROM + 1 ))" "${SLACK_STATE_DIR}/server.log" | grep -m1 -F -- " resumed ${REF_OF[${id}]}" || true)"
            if [[ -n "${line}" ]]; then
                [[ "${line}" =~ ^\[([0-9TZ:.-]+)\]\  ]] || fail "leg B: server.log's resumed line has no time: ${line}"
                us="$(date -u -d "${BASH_REMATCH[1]}" +%s%6N)" || fail "leg B: could not read the time of server.log's resumed line: ${line}"
                # The line's time is in whole milliseconds: one more covers its rounding down.
                RESUMED_US["${id}"]=$(( 10#${us} + 1000 ))
            fi
        fi
        read_from_us="$(now_us)"
        ad_capture status --instance-id "${id}"
        read_us="$(now_us)"
        (( AD_RC == 0 )) || fail "leg B: a harness status read of row ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
        if ! read -r state launch < <(jq -r '[.state // "-", .launch_started_at // "-"] | join(" ")' "${AD_OUT}"); then
            fail "leg B: a harness status read of row ${id} printed no status: $(head -c 300 "${AD_OUT}")"
        fi
        printf '%s %s %s %s %s\n' "${read_from_us}" "${read_us}" "${id}" "${state}" "${launch}" >> "${LEG_B_READS}"
        if [[ -n "${RESUMED_US[${id}]:-}" ]] && (( read_from_us > RESUMED_US[${id}] )); then
            case "${state}" in
                pending)
                    [[ "${launch}" != - ]] || fail "leg B: row ${id} read pending with no launch start after its resume" ;;
                waiting) WAITING_B_US["${id}"]="${read_us}" ;;
                *) fail "leg B: row ${id} read ${state} after its resume, before it read waiting" ;;
            esac
        fi
    done
    (( left > 0 )) || break
    if [[ -z "${restart_done_us}" ]] && ! pid_alive "${restart_pid}"; then
        restart_done_us="$(now_us)"
    fi
    if [[ -z "${restart_done_us}" ]] && (( $(now_us) > restart_from_us + LEG_B_RESTART_BOUND_S * 1000000 )); then
        sed 's/^/  | /' "${LEG_B_OUT}" >&2
        fail "leg B: clean_restart did not end within ${LEG_B_RESTART_BOUND_S}s (the CLI's precheck and teardown bounds ${leg_b_cli_ms}ms + the stop bound ${SCENARIO_STOP_CLI_S}s + the daemon startup wait ${DAEMON_STARTUP_WAIT_S}s)"
    fi
    if [[ -n "${restart_done_us}" ]] && (( $(now_us) > restart_done_us + LEG_B_WAIT_S * 1000000 )); then
        sed 's/^/  | /' "${LEG_B_READS}" | tail -n 20 >&2
        fail "leg B: a row did not read waiting after its resume within ${LEG_B_WAIT_S}s of clean_restart's end"
    fi
    if (( ! hot )); then
        sleep "${SCENARIO_POLL_S}"
    fi
done
restart_rc=0
wait "${restart_pid}" || restart_rc=$?
stop_tracked_pid "${restart_pid}" 5 "leg B: the clean_restart run did not end"
if [[ -z "${restart_done_us}" ]]; then
    restart_done_us="$(now_us)"
fi
if (( restart_rc != 0 )); then
    sed 's/^/  | /' "${LEG_B_OUT}" >&2
    fail "leg B: clean_restart exited ${restart_rc}"
fi
! pid_alive "${LEG_A_SERVER_PID}" || fail "leg B: leg A's bot server (PID ${LEG_A_SERVER_PID}) still runs after clean_restart"
SERVER_PID="$(server_pid)"
[[ -n "${SERVER_PID}" ]] && pid_alive "${SERVER_PID}" || fail "leg B: no bot server runs after clean_restart"
[[ "${SERVER_PID}" != "${LEG_A_SERVER_PID}" ]] || fail "leg B: server.pid still names leg A's server ${LEG_A_SERVER_PID}"
port_listening "${SCENARIO_PORT}" || fail "leg B: nothing answers on 127.0.0.1:${SCENARIO_PORT} after clean_restart"
record "leg B: clean_restart exited 0 after $(( (restart_done_us - restart_from_us) / 1000 ))ms (bound ${LEG_B_RESTART_BOUND_S}s); the bot server is PID ${SERVER_PID} (leg A's ${LEG_A_SERVER_PID} is gone)"

# The new server's start pass and each persona's MCP session.
wait_for_count "$(completion_match "${#PERSONA_IDS[@]}")" "$(( completions_before + 1 ))" "${LEG_B_WAIT_S}" \
    "leg B: the restarted server's start pass never completed"
for cid in "${CHANNELS[@]}"; do
    name="${PERSONA_OF[${cid}]}"
    wait_for_count "[slack] Session connected: persona $(persona_ref "${name}")" "$(( CONNECTED_BEFORE[${name}] + 1 ))" \
        "${LEG_B_WAIT_S}" "leg B: persona ${name}'s resumed session never connected"
done

# Health ticks (Q12) on the restarted server, as in leg A.
leg_b_status_reads() {
    lines_after "${SCENARIO_AD_SHIM_LOG}" "${LEG_B_AD_FROM}" "${LEG_B_LOG}"
    server_calls_naming "${LEG_B_LOG}" status "$1" "${SERVER_PID}" "${SCENARIO_ROOT}/leg-b-status"
    line_count "${SCENARIO_ROOT}/leg-b-status"
}
leg_b_status_reads_at_least() {
    (( $(leg_b_status_reads "$1") >= $2 ))
}
declare -A reads_before_b=()
for id in "${PERSONA_IDS[@]}"; do
    reads_before_b["${id}"]="$(leg_b_status_reads "${id}")"
done
for id in "${PERSONA_IDS[@]}"; do
    wait_until "${tick_wait_s}" "leg B: the restarted server read row ${id} on fewer than ${HEALTH_TICKS} health ticks" \
        leg_b_status_reads_at_least "${id}" "$(( reads_before_b[${id}] + HEALTH_TICKS ))"
done

lines_after "${SCENARIO_AD_SHIM_LOG}" "${LEG_B_AD_FROM}" "${LEG_B_LOG}"
lines_after "${SLACK_STATE_DIR}/server.log" "${LEG_B_SERVER_LOG_FROM}" "${LEG_B_SERVER_LOG}"
refusals_total=0
for i in "${!PERSONA_IDS[@]}"; do
    id="${PERSONA_IDS[i]}"
    name="${PERSONA_OF[${CHANNELS[i]}]}"
    ref="$(persona_ref "${name}")"
    key="$(persona_key "${name}")"
    # "Still stopping" refusals (src/ad-description-phrases.ts STILL_STOPPING_PHRASE).
    refusals="$(grep -F -- "${ref}" "${LEG_B_SERVER_LOG}" | grep -cF 'appears to still be stopping' || true)"
    (( refusals <= 1 )) || fail "leg B: persona ${name} took ${refusals} still-stopping refusals, not at most one"
    refusals_total=$(( refusals_total + refusals ))
    # Q12: no tick reconnects or relaunches the persona, past a refusal's one retry.
    n="$(count_in "${LEG_B_SERVER_LOG}" "[slack] Session alive but disconnected — reconnecting MCP for persona=${key}")"
    if (( n > 0 )); then
        grep -F -- "persona=${key}" "${LEG_B_SERVER_LOG}" | sed 's/^/  | /' >&2
        fail "leg B (Q12): a health tick reconnected persona ${name} while its stub held its MCP session: a harness defect, reported, not worked around"
    fi
    n="$(count_in "${LEG_B_SERVER_LOG}" "[slack] Scheduling restart for persona=${key} ")"
    if (( n > refusals )); then
        grep -F -- "persona=${key}" "${LEG_B_SERVER_LOG}" | sed 's/^/  | /' >&2
        fail "leg B (Q12): the restarted server scheduled ${n} restart(s) of persona ${name} after ${refusals} still-stopping refusal(s): a harness defect, reported, not worked around"
    fi

    # A plain spawn of its id by the bot server, answered by a collision: a
    # resume of the same id follows it (one more after a still-stopping refusal).
    server_calls_naming "${LEG_B_LOG}" spawn "${id}" "${SERVER_PID}" "${SCENARIO_ROOT}/leg-b-spawn"
    server_calls_naming "${LEG_B_LOG}" resume "${id}" "${SERVER_PID}" "${SCENARIO_ROOT}/leg-b-resume"
    spawns="$(line_count "${SCENARIO_ROOT}/leg-b-spawn")"
    resumes="$(line_count "${SCENARIO_ROOT}/leg-b-resume")"
    (( spawns >= 1 )) || fail "leg B: the restarted server made no spawn of persona ${name}'s id ${id}"
    (( refusals == 1 || spawns == 1 )) || fail "leg B: the restarted server made ${spawns} spawns of persona ${name}'s id ${id}, not one"
    (( spawns <= 1 + refusals )) || fail "leg B: the restarted server made ${spawns} spawns of persona ${name}'s id ${id} after ${refusals} refusal(s)"
    (( resumes == 1 + refusals )) \
        || fail "leg B: the restarted server made ${resumes} resume(s) of persona ${name}'s id ${id}, not $(( 1 + refusals )) (${refusals} still-stopping refusal(s))"
    while IFS= read -r line; do
        if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
            fail "leg B: persona ${name}'s spawn line does not parse"
        fi
        _scenario_ad_verb
        for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
            # src/ad-phase1-types.ts: a reuse spawn's flag.
            [[ "${a}" != --reuse-finished* ]] || fail "leg B: persona ${name} (${id}) was spawned with ${a}, not resumed"
        done
    done < "${SCENARIO_ROOT}/leg-b-spawn"
    first_spawn_us="$(line_times "${SCENARIO_ROOT}/leg-b-spawn" | head -n 1)"
    mapfile -t resume_us < <(line_times "${SCENARIO_ROOT}/leg-b-resume")
    (( first_spawn_us < resume_us[0] )) || fail "leg B: persona ${name}'s resume does not follow its spawn"
    last_resume_us="${resume_us[${#resume_us[@]} - 1]}"
    # The spawn answered by a collision: the restarted server's collision line
    # for the persona (src/session-manager.ts spawnForPersona), one per spawn
    # with no refusal, the first written between the first spawn and the
    # first resume (its time in whole milliseconds, taken as rounded down).
    collision_m="[slack] spawnForPersona: ErrInstanceIdCollision for ${ref} — fetching current state"
    collisions="$(count_in "${LEG_B_SERVER_LOG}" "$(matcher "${collision_m}")")"
    (( collisions >= 1 )) \
        || fail "leg B: server.log has no collision line for persona ${name} after the restart: its spawn of ${id} was not answered by a collision"
    (( collisions <= spawns && (refusals == 1 || collisions == spawns) )) \
        || fail "leg B: server.log has ${collisions} collision line(s) for persona ${name} after the restart, for ${spawns} spawn(s) and ${refusals} still-stopping refusal(s)"
    line="$(grep -m1 -F -- "${collision_m}" "${LEG_B_SERVER_LOG}" || true)"
    [[ "${line}" =~ ^\[([0-9TZ:.-]+)\]\  ]] || fail "leg B: server.log's collision line for persona ${name} has no time: ${line}"
    collision_us="$(date -u -d "${BASH_REMATCH[1]}" +%s%6N)" \
        || fail "leg B: could not read the time of server.log's collision line for persona ${name}: ${line}"
    collision_us=$(( 10#${collision_us} ))
    (( collision_us + 1000 > first_spawn_us && collision_us <= resume_us[0] )) \
        || fail "leg B: persona ${name}'s first collision line (${BASH_REMATCH[1]}) does not fall between its first spawn and its first resume"

    # Its row read pending, with a launch start, from the resume until it read
    # waiting: every read after the resume returned did (checked as read).
    [[ -n "${WAITING_B_US[${id}]:-}" ]] || fail "leg B: the harness never read row ${id} waiting after its resume"
    (( WAITING_B_US[${id}] <= restart_done_us + LEG_B_WAIT_S * 1000000 )) \
        || fail "leg B: row ${id} read waiting more than ${LEG_B_WAIT_S}s after clean_restart's end"

    # It read pending until its resumed worker reported in. Require AD's
    # pending transition and an applied SessionStart for this conversation.
    # Hook/transition publication and the harness get are independent observers:
    # their timestamps do not establish the order of the underlying row write.
    wait_until "${LEG_B_WAIT_S}" "leg B: no correlated applied SessionStart/transition for ${id}" \
        t13_resume_reported "${id}" "${SID_OF[${id}]}" "${last_resume_us}"
    first_waiting_us=""
    trail_pending=0
    while read -r from_us at_us rid rstate rlaunch; do
        [[ "${rid}" == "${id}" ]] && (( from_us > last_resume_us )) || continue
        if [[ "${rstate}" == waiting && -z "${first_waiting_us}" ]]; then
            first_waiting_us="${at_us}"
        fi
        if [[ "${rstate}" == pending ]]; then
            [[ "${rlaunch}" != - ]] || fail "leg B: pending row ${id} has no launch start"
            trail_pending=$(( trail_pending + 1 ))
        fi
    done < "${LEG_B_READS}"
    [[ -n "${first_waiting_us}" ]] || fail "leg B: no harness read of row ${id} after the restarted server's last resume call read waiting"

    for verb in read-pane send-keys; do
        server_calls_naming "${LEG_B_LOG}" "${verb}" "${id}" "${SERVER_PID}" "${SCENARIO_ROOT}/leg-b-${verb}"
        while IFS= read -r t; do
            if (( t > last_resume_us && t <= WAITING_B_US[${id}] )); then
                fail "leg B: automatic startup ${verb} call of ${id} after resume"
            fi
        done < <(line_times "${SCENARIO_ROOT}/leg-b-${verb}")
    done

    # Its conversation kept: the same session_id, and a worker started with --resume and that id.
    row_get "leg B: persona ${name}'s row is gone" "${id}"
    got="$(jq -r '.session_id // empty' "${AD_OUT}")"
    [[ "${got}" == "${SID_OF[${id}]}" ]] \
        || fail "leg B: row ${id} holds conversation '${got}' after the restart, not ${SID_OF[${id}]}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "leg B: row ${id} names no tmux session"
    panes="$("${SCENARIO_REAL_TMUX}" list-panes -s -t "=${session}" -F '#{pane_id} #{pane_pid} #{@ad_pane}')" \
        || fail "leg B: could not list the panes of row ${id}'s session ${session}"
    worker_pids=()
    all_pids=()
    while read -r pane pid label; do
        [[ -n "${pane}" ]] || continue
        all_pids+=("${pid}")
        if [[ "${label}" =~ ^[0-9a-f]{16}\ (%[0-9]+)$ && "${BASH_REMATCH[1]}" == "${pane}" ]]; then
            worker_pids+=("${pid}")
        fi
    done <<< "${panes}"
    if (( ${#worker_pids[@]} == 0 && ${#all_pids[@]} == 1 )); then
        worker_pids=("${all_pids[0]}")
    fi
    (( ${#worker_pids[@]} == 1 )) || fail "leg B: row ${id}'s session ${session} has ${#worker_pids[@]} worker pane(s), not one"
    mapfile -d '' -t worker_argv < "/proc/${worker_pids[0]}/cmdline" \
        || fail "leg B: could not read the command line of row ${id}'s worker (PID ${worker_pids[0]})"
    resumed_with=""
    for j in "${!worker_argv[@]}"; do
        if [[ "${worker_argv[j]}" == --resume ]]; then
            resumed_with="${worker_argv[j + 1]:-}"
        elif [[ "${worker_argv[j]}" == --resume=* ]]; then
            resumed_with="${worker_argv[j]#--resume=}"
        fi
    done
    [[ "${resumed_with}" == "${SID_OF[${id}]}" ]] \
        || fail "leg B: row ${id}'s worker (PID ${worker_pids[0]}) was started with --resume '${resumed_with}', not ${SID_OF[${id}]}"
    record "leg B: persona ${name}: ${spawns} spawn(s), ${collisions} answered by a collision, then ${resumes} resume(s) by the bot server, ${refusals} still-stopping refusal(s); its row read pending with a launch start, then waiting; last resume call at ${last_resume_us} (epoch microseconds); the trail: moved to pending ${pending_ts}, out of pending to ${moved_to} by SessionStart ${moved_ts}, SessionStart hook fired ${fired_ts}, first harness read of waiting ended at ${first_waiting_us} (epoch microseconds); ${trail_pending} pending harness read(s) after resume, each with a launch start; SessionStart completed without automatic startup keys; conversation ${SID_OF[${id}]} kept, worker started with --resume"
done
if (( refusals_total == 0 )); then
    expect_completion "${#PERSONA_IDS[@]}" "leg B: every persona comes back resumed" \
        "${#PERSONA_IDS[@]} resumed" "0 fresh-spawned" "0 not brought up"
else
    expect_completion "${#PERSONA_IDS[@]}" "leg B: no persona comes back fresh" "0 fresh-spawned"
fi
# No delete by CSCB and no kill by the restarted server (clean_restart's own
# pause and kill are expected); every row is present.
cscb_lines "${LEG_B_LOG}" delete "${SCENARIO_ROOT}/leg-b-delete"
n="$(line_count "${SCENARIO_ROOT}/leg-b-delete")"
if [[ "${n}" != 0 ]]; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/leg-b-delete" >&2
    fail "leg B: CSCB made ${n} delete call(s)"
fi
cscb_lines "${LEG_B_LOG}" kill "${SCENARIO_ROOT}/leg-b-kill"
n=0
while IFS= read -r line; do
    _scenario_split_line "${line}" || fail "leg B: a shim line does not split: ${line}"
    if [[ "${_L_PPID}" == "${SERVER_PID}" ]]; then
        echo "  | ${line}" >&2
        n=$(( n + 1 ))
    fi
done < "${SCENARIO_ROOT}/leg-b-kill"
(( n == 0 )) || fail "leg B: the restarted server made ${n} kill call(s)"
for id in "${PERSONA_IDS[@]}" "${OLD_IDS[@]}"; do
    row_get "leg B: row ${id} is gone after the restart" "${id}"
done
lines_after "${SLACK_RECORD}" "${LEG_B_RECORD_FROM}" "${SCENARIO_ROOT}/leg-b-record"
posts="$(jq -s '[.[] | select(.event == "api" and .method == "chat.postMessage")] | length' "${SCENARIO_ROOT}/leg-b-record")" \
    || fail "leg B: could not read the Slack stub's record ${SLACK_RECORD}"
(( posts == 0 )) || fail "leg B: the Slack stub's record holds ${posts} post(s) in leg B, not 0: nothing in the scenario posts"
persona_slack_traffic "leg B" "${SCENARIO_ROOT}/leg-b-record"
record "leg B: no CSCB delete, no kill by the restarted server, every row present; ${posts} post(s) in leg B; the Slack stub's record holds each persona's connection (${TRAFFIC})"

# ---------------------------------------------------------------------------
# Leg C: this build refuses agent-director 0.10.0
# ---------------------------------------------------------------------------

# The version the floor requires, as the installed package holds it.
REQUIRED_AD_VERSION="$(cd / && GATE_MODULE="${CSCB_PKG_DIR}/src/ad-version-gate.ts" bun --no-install -e \
    'const m = await import(process.env.GATE_MODULE); if (typeof m.PHASE1_FLOOR_VERSION !== "string") process.exit(1); process.stdout.write(m.PHASE1_FLOOR_VERSION)')" \
    || fail "leg C: could not read PHASE1_FLOOR_VERSION from ${CSCB_PKG_DIR}/src/ad-version-gate.ts"
[[ -n "${REQUIRED_AD_VERSION}" ]] || fail "leg C: ${CSCB_PKG_DIR}/src/ad-version-gate.ts holds an empty PHASE1_FLOOR_VERSION"
CLIENT_MIN_AD_VERSION="$(jq -er '.min_binary_version' "$(client_dir_of "${CSCB_PKG_DIR}")/dist/version-floor.json")"
[[ -n "${CLIENT_MIN_AD_VERSION}" ]] || fail "leg C: the installed client minimum is empty"

# Leg B's server stopped with its bots through the new CLI; every Slack
# socket closed and no worker left to run a hook against 0.10.0.
stop_server --stop-bots
# True when the stub's record holds at least one socket open and as many
# closes as opens.
slack_sockets_closed() {
    jq -se '([.[] | select(.event == "ws-open")] | length) as $opens
        | $opens > 0 and $opens == ([.[] | select(.event == "ws-close")] | length)' \
        "${SLACK_RECORD}" > /dev/null
}
ws_opens="$(jq -s '[.[] | select(.event == "ws-open")] | length' "${SLACK_RECORD}")" \
    || fail "leg C: could not read the Slack stub's record ${SLACK_RECORD}"
(( ws_opens > 0 )) || fail "leg C: the Slack stub's record holds no ws-open, so no socket is seen to close"
wait_until "${SLACK_STUB_WAIT_S}" "leg C: a Slack socket stayed open after leg B's server stopped" slack_sockets_closed
tmux_sessions sessions
(( ${#sessions[@]} == 0 )) || fail "leg C: tmux session(s) left after stop --stop-bots: ${sessions[*]}"
record "leg C: leg B's server and its bots stopped through the new CLI; every Slack socket closed (${ws_opens} opened); no tmux session"

STARTUP_ERRORS="${SLACK_STATE_DIR}/startup-errors.log"
LEG_C_AD_FROM="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
LEG_C_RECORD_FROM="$(line_count "${SLACK_RECORD}")"
LEG_C_ERRORS_FROM="$(line_count "${STARTUP_ERRORS}")"
LEG_C_SERVER_LOG_FROM="$(line_count "${SLACK_STATE_DIR}/server.log")"

# 0.10.0 behind the shim (the swap checks the shim); the binary is compared,
# never run, so the harness makes no 0.10.0 call against the migrated store.
swap_ad_binary 0.10.0 "leg C: agent-director 0.10.0 behind the shim"
cmp -s -- "${SCENARIO_AD_010_BIN}" "${SCENARIO_AD_ROOT}/bin/agent-director.real" \
    || fail "leg C: the binary behind the shim is not agent-director 0.10.0's"
record "leg C: agent-director ${SCENARIO_AD_010_VERSION} behind the shim"

run_start --live
LEG_C_LOG="${SCENARIO_ROOT}/leg-c-shim.log"
lines_after "${STARTUP_ERRORS}" "${LEG_C_ERRORS_FROM}" "${SCENARIO_ROOT}/leg-c-errors"
lines_after "${SLACK_STATE_DIR}/server.log" "${LEG_C_SERVER_LOG_FROM}" "${SCENARIO_ROOT}/leg-c-server.log"
lines_after "${SLACK_RECORD}" "${LEG_C_RECORD_FROM}" "${SCENARIO_ROOT}/leg-c-record"

# It exits non-zero, its daemon having failed.
if (( START_RC == 0 )); then
    sed 's/^/  | /' "${START_OUT}" >&2
    fail "leg C: start against agent-director ${SCENARIO_AD_010_VERSION} exited 0"
fi
if ! grep -qF '[slack] Server failed to start (' "${START_OUT}"; then
    sed 's/^/  | /' "${START_OUT}" >&2
    fail "leg C: start exited ${START_RC} without its server-failed line"
fi

# It alerts once: one startup-errors entry, the native client refusal, naming the version
# found and the version required, and one matching server-log line.
too_old_entry="$(matcher "[${AD_SYSTEM_INSTALL_TOO_OLD_LABEL}] " \
    "agent-director system install is too old: version ${SCENARIO_AD_010_VERSION} is below the agent-director client's minimum; version ${CLIENT_MIN_AD_VERSION} or later is required by the client, and this CSCB release needs ${REQUIRED_AD_VERSION} or later")"
n="$(line_count "${SCENARIO_ROOT}/leg-c-errors")"
if [[ "${n}" != 1 ]]; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/leg-c-errors" >&2
    fail "leg C: ${n} new startup-errors.log entries, not one"
fi
[[ "$(count_in "${SCENARIO_ROOT}/leg-c-errors" "${too_old_entry}")" == 1 ]] \
    || fail "leg C: the new startup-errors.log entry is not an ${AD_SYSTEM_INSTALL_TOO_OLD_LABEL} entry naming ${SCENARIO_AD_010_VERSION} and ${REQUIRED_AD_VERSION}: $(head -c 400 "${SCENARIO_ROOT}/leg-c-errors")"
n="$(count_in "${SCENARIO_ROOT}/leg-c-server.log" "[${AD_SYSTEM_INSTALL_TOO_OLD_LABEL}] ")"
if [[ "${n}" != 1 ]]; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/leg-c-server.log" >&2
    fail "leg C: ${n} new server.log lines carry ${AD_SYSTEM_INSTALL_TOO_OLD_LABEL}, not one"
fi
[[ "$(count_in "${SCENARIO_ROOT}/leg-c-server.log" "${too_old_entry}")" == 1 ]] \
    || fail "leg C: the server.log line does not name ${SCENARIO_AD_010_VERSION} and ${REQUIRED_AD_VERSION}"
record "leg C: start exited ${START_RC}; one ${AD_SYSTEM_INSTALL_TOO_OLD_LABEL} entry and one server.log line naming ${SCENARIO_AD_010_VERSION} and ${REQUIRED_AD_VERSION}"

# Nothing reaches the Slack stub: no auth.test, no apps.connections.open, no
# WebSocket, no post.
n="$(line_count "${SCENARIO_ROOT}/leg-c-record")"
if [[ "${n}" != 0 ]]; then
    sed 's/^/  | /' "${SCENARIO_ROOT}/leg-c-record" >&2
    fail "leg C: the Slack stub's record has ${n} new line(s)"
fi

# No server is left running, and no instance was launched.
pid="$(server_pid)"
if [[ -n "${pid}" ]] && pid_alive "${pid}"; then
    fail "leg C: a bot server runs (PID ${pid} in ${SLACK_STATE_DIR}/server.pid)"
fi
port_closed "${SCENARIO_PORT}" || fail "leg C: something answers on 127.0.0.1:${SCENARIO_PORT}"
tmux_sessions sessions
(( ${#sessions[@]} == 0 )) || fail "leg C: tmux session(s) after the refused start: ${sessions[*]}"

# Every agent-director call while 0.10.0 sat behind the shim: the refused
# server is not in the CSCB process record (it wrote no PID file), so every
# line is read. Each must be a harness call (the scenario's shell or a
# subshell as parent, no CSCB process) or a version call; the harness makes
# none against 0.10.0.
lines_after "${SCENARIO_AD_SHIM_LOG}" "${LEG_C_AD_FROM}" "${LEG_C_LOG}"
cscb_lines "${LEG_C_LOG}" "" "${SCENARIO_ROOT}/leg-c-cscb"
probes=0
harness=0
others=0
while IFS= read -r line; do
    if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
        fail "leg C: a shim line does not parse: ${line}"
    fi
    [[ "${_L_KIND}" == call ]] || continue
    _scenario_ad_verb
    if [[ "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] && ! grep -qxF -- "${line}" "${SCENARIO_ROOT}/leg-c-cscb"; then
        harness=$(( harness + 1 ))
        echo "  | harness: ${line}" >&2
    elif [[ "${_L_VERB}" == version ]]; then
        probes=$(( probes + 1 ))
    else
        others=$(( others + 1 ))
        echo "  | ${line}" >&2
    fi
done < "${LEG_C_LOG}"
(( others == 0 )) || fail "leg C: ${others} agent-director call(s) other than a version probe (a launch, kill or delete) while ${SCENARIO_AD_010_VERSION} sat behind the shim"
(( harness == 0 )) || fail "leg C: the harness made ${harness} agent-director call(s) while ${SCENARIO_AD_010_VERSION} sat behind the shim"
(( probes >= 1 )) || fail "leg C: no version probe reached the shim: the refused server never read agent-director's version"
record "leg C: ${probes} version probe(s), no other agent-director call; nothing reached the Slack stub; no server left running; no tmux session"

# The release back behind the shim (the swap checks the shim).
swap_ad_binary release "leg C: the release back behind the shim"
cmp -s -- "${SCENARIO_RELEASE_BIN}" "${SCENARIO_AD_ROOT}/bin/agent-director.real" \
    || fail "leg C: the binary behind the shim is not the release's"
record "leg C: the release ${REL_VERSION} back behind the shim"

# ---------------------------------------------------------------------------
# Closing
# ---------------------------------------------------------------------------

(( RUNBOOK_NEXT - 1 == RUNBOOK_COUNT )) \
    || fail "runbook: steps 1 to $(( RUNBOOK_NEXT - 1 )) entered, not the runbook's ${RUNBOOK_COUNT}"
entered="$(grep -c '\] entered: ' "${SWITCH_LOG}")"
[[ "${entered}" == "${RUNBOOK_COUNT}" ]] || fail "runbook: ${entered} step entries in the switch-over log, not ${RUNBOOK_COUNT}"

# No post repeats over the Slack stub's whole record (legs A and B, each
# shown to hold its personas' connections; leg C added no line).
no_repeated_posts "end of run"
record "end of run: ${POSTS_COMPARED} post(s) in the Slack stub's whole record compared, none repeated"

echo "${TEST_NAME}: switch-over log:"
sed 's/^/  /' "${SWITCH_LOG}"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
