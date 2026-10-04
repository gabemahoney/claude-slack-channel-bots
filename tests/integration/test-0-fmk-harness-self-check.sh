#!/usr/bin/env bash
# Test 0 (b.jg5 SRJ-1306): the fmk harness's self-check. It runs the parts of
# lib/scenario.sh and fixtures/agent-director-shim.sh that every fmk scenario
# (test-13 to test-28) stands on, and checks their effect. tests/runner.sh
# finds it by name and, in version order, runs it right after Tests 1 to 4
# and before every fmk scenario. Its TEST_NAME carries `-fmk-`, so sourcing
# lib/scenario.sh gives it its own HOME, agent-director install (the release
# candidate, through its install.sh, behind the shim), store and tmux server,
# all under SCENARIO_ROOT.
#
# The release candidate's version and commit come from the image's recorded
# release identity (/opt/agent-director-rc/client/release.json), never from a
# literal. The shim log is read as the shim's header states its line format:
# only lines whose first field is `call` are invocations, and a quoted field
# gives back its words through `eval`.
#
# Legs (each a function `leg_<name>`, run in the order LEGS lists them; a
# failing leg prints one FAIL line naming the leg and what it saw):
#   isolation        HOME and TMUX_TMPDIR are under SCENARIO_ROOT and are not
#                    the container user's; TMUX and TMUX_PANE are unset; every
#                    PATH entry is absolute, the scenario's bin directory is
#                    first, no entry holds an `agent-director` (the image's
#                    default binary's directory is gone) and the shell finds
#                    none; `claude` is the stub; bun is still found; the shim
#                    and its log are at the scenario HOME's standard path, and
#                    the container user's own ~/.agent-director/bin holds no
#                    shim log and no `.real` binary.
#   real_binary      the binary behind the shim, run by its own name, reports
#                    the recorded version and commit, and adds no log line.
#   setup_install    after the setup's install the standard path holds the
#                    shim (a regular file, the fixture byte for byte, with its
#                    marker), the release candidate's binary is behind it, a
#                    call through it reports the recorded version, and the
#                    install made the HOME's store.
#   harness_call_log a harness call (`ad_capture`, an argument holding a
#                    space) adds one `call` line: its time is the call's, its
#                    parent is the scenario's own shell ($$) with that shell's
#                    command line, and its words give back the argv exactly.
#   version_probe    bun runs under the scenario HOME: the installed package's
#                    agent-director client resolves the shim at the standard
#                    path, and its version probe (cwd /, scrubbed environment)
#                    gets the recorded version and is logged, its parent bun.
#   tmux_and_store   a harness spawn (the stub as `claude`) runs on the
#                    scenario's own tmux server: the row's socket is under
#                    TMUX_TMPDIR, the scenario shell's tmux reaches the session
#                    on that socket, and the server's environment carries this
#                    SCENARIO_ROOT. `ad_store_id` prints 16 lowercase hex
#                    characters, and an `ad_store_edit` of the spawned row's
#                    labels is what a later harness `get` returns.
#   swap             after a swap to 0.10.0 the shim is in place with 0.10.0
#                    behind it and a call through it reports 0.10.0; after the
#                    swap back, the release candidate again.
#   reinstall        after a second run of the release candidate's install.sh
#                    and its re-shim, the shim is in place with the release
#                    candidate behind it, and the store id is unchanged.
#   hide_restore     hide leaves no file at the standard path and none behind
#                    it, and keeps the log; restore puts the shim back with the
#                    release candidate behind it.
#   log_kept         the harness call's line is still in the log after every
#                    install, swap, hide and restore, and every line of the log
#                    has the format's six fields and a known kind.
#   start_on_010     a nested fmk run written into SCENARIO_ROOT, set to start
#                    on 0.10.0 (SCENARIO_AD_START=0.10.0), holds 0.10.0 behind
#                    the shim, no release-candidate binary anywhere in its HOME
#                    and no store; `install_ad_rc` then puts the release
#                    candidate behind the shim and makes a store with a store
#                    id. The nested run cleans up its own SCENARIO_ROOT.
#   guard_refusals   in subshells, with HOME outside SCENARIO_ROOT (a scratch
#                    directory under /tmp holding a decoy install and store,
#                    and a symlink under SCENARIO_ROOT that resolves to it),
#                    every install, re-shim, swap, hide and restore helper,
#                    `ad`, `ad_store_edit` and `ad_store_id` fails with the
#                    guard's reason, and the decoy is left exactly as it was.
#   shim_check       `check_ad_shim` passes a correct layout and fails, with
#                    its reason, on a symlink to the shim and on a copy of the
#                    shim without its marker line.
# Teardown: an exit hook confirms that the trap stopped the scenario's tmux
# server (its PID gone, no socket under SCENARIO_ROOT answering).
set -euo pipefail

TEST_NAME="test-0-fmk-harness-self-check"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

SCENARIO_LIB="$(cd "$(dirname "$0")" && pwd)/lib/scenario.sh"

# The release candidate's identity, recorded in the image
# (docker/Dockerfile.test.base).
RC_RELEASE_JSON=/opt/agent-director-rc/client/release.json
[[ -f "${RC_RELEASE_JSON}" ]] || fail "setup: the release candidate's identity ${RC_RELEASE_JSON} is missing"
RC_VERSION="$(jq -r '.version // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .version from ${RC_RELEASE_JSON}"
RC_COMMIT="$(jq -r '.commit // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .commit from ${RC_RELEASE_JSON}"
[[ -n "${RC_VERSION}" && -n "${RC_COMMIT}" ]] \
    || fail "setup: ${RC_RELEASE_JSON} names no version or no commit"

# The row and tmux session the tmux_and_store leg spawns.
T0_ROW_ID="t0-self-check"
T0_SESSION="t0-self-check"

# Set by the legs: the harness call's log line, the store id, and the
# scenario's tmux server PID.
HARNESS_CALL_LINE=""
T0_STORE_ID=""
T0_TMUX_PID=""
OUTSIDE_HOME=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the number of `call` lines in the shim log (0 when there is none).
call_count() {
    if [[ ! -f "${SCENARIO_AD_SHIM_LOG}" ]]; then
        echo 0
        return 0
    fi
    awk -F'\t' '$1 == "call" { n++ } END { print n + 0 }' "${SCENARIO_AD_SHIM_LOG}"
}

# Print the shim log's last `call` line.
last_call_line() {
    awk -F'\t' '$1 == "call" { l = $0 } END { print l }' "${SCENARIO_AD_SHIM_LOG}"
}

# read_call <step> <line>: split one `call` line into CALL_TIME, CALL_PID,
# CALL_PPID, CALL_PARENT (the parent's command line, an array) and CALL_WORDS
# (the argv after argv[0], an array); fail unless it has the format's six
# fields.
read_call() {
    local step="$1" line="$2" nf kind parent words
    nf="$(awk -F'\t' '{ print NF }' <<< "${line}")"
    [[ "${nf}" == 6 ]] || fail "${step}: shim log line has ${nf} field(s), not 6: ${line}"
    IFS=$'\t' read -r kind CALL_TIME CALL_PID CALL_PPID parent words <<< "${line}"
    [[ "${kind}" == call ]] || fail "${step}: shim log line's kind is '${kind}', not call"
    [[ "${CALL_TIME}" =~ ^[0-9]+\.[0-9]{6}$ ]] \
        || fail "${step}: shim log line's time '${CALL_TIME}' is not seconds with six decimals"
    [[ "${CALL_PID}" =~ ^[0-9]+$ && "${CALL_PPID}" =~ ^[0-9]+$ ]] \
        || fail "${step}: shim log line's pid '${CALL_PID}' or ppid '${CALL_PPID}' is not a number"
    CALL_PARENT=()
    if [[ "${parent}" != '?' ]]; then
        eval "CALL_PARENT=(${parent})"
    fi
    CALL_WORDS=()
    eval "CALL_WORDS=(${words})"
}

# same_words <array-name> <array-name>: true when both arrays hold the same
# elements in the same order.
same_words() {
    local -n same_a="$1" same_b="$2"
    local i
    (( ${#same_a[@]} == ${#same_b[@]} )) || return 1
    for i in "${!same_a[@]}"; do
        [[ "${same_a[i]}" == "${same_b[i]}" ]] || return 1
    done
}

# Print the words, each `printf %q`-quoted, so a failure shows where they differ.
quoted() {
    local q
    printf -v q '%q ' "$@"
    printf '%s\n' "${q% }"
}

# expect_shim_in_place <step> <binary>: the standard path holds the shim (a
# regular executable file, not a symlink, the fixture byte for byte, carrying
# its marker line) and the file behind it is <binary>, byte for byte.
expect_shim_in_place() {
    local step="$1" binary="$2" path="${SCENARIO_AD_BIN}"
    [[ -f "${path}" && ! -L "${path}" ]] || fail "${step}: ${path} is not a regular file"
    grep -qxF -- "${SCENARIO_AD_SHIM_MARKER}" "${path}" || fail "${step}: ${path} does not carry the shim's marker"
    cmp -s -- "${SCENARIO_AD_SHIM_SRC}" "${path}" || fail "${step}: ${path} is not the shim ${SCENARIO_AD_SHIM_SRC}"
    [[ -x "${path}" ]] || fail "${step}: the shim at ${path} is not executable"
    [[ -f "${path}.real" && ! -L "${path}.real" && -x "${path}.real" ]] \
        || fail "${step}: no executable regular file behind the shim at ${path}.real"
    cmp -s -- "${binary}" "${path}.real" || fail "${step}: the binary behind the shim is not ${binary}"
}

# expect_ad_version <step> <version> [<commit>]: a harness call of `version`
# through the shim answers <version> (and <commit>, when given).
expect_ad_version() {
    local step="$1" want="$2" want_commit="${3:-}" got got_commit
    ad_capture version
    (( AD_RC == 0 )) || fail "${step}: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    got="$(jq -r '.version // empty' "${AD_OUT}")" || fail "${step}: version printed no JSON: $(head -c 300 "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: a call through the shim reports version '${got}', not ${want}"
    if [[ -n "${want_commit}" ]]; then
        got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
        [[ "${got_commit}" == "${want_commit}" ]] \
            || fail "${step}: a call through the shim reports commit '${got_commit}', not ${want_commit}"
    fi
}

# expect_fails_in_home <step> <home> <reason> <command> [<arg>...]: run the
# command in a subshell with HOME=<home>; fail unless it exits non-zero with
# a FAIL line of this test carrying <reason>.
expect_fails_in_home() {
    local step="$1" home="$2" reason="$3"
    shift 3
    local out="${SCENARIO_ROOT}/expect-fails.out" rc=0 line
    ( export HOME="${home}"; "$@" ) > "${out}" 2>&1 || rc=$?
    if (( rc == 0 )); then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} succeeded"
    fi
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if [[ "${line}" != "FAIL: ${TEST_NAME}: "*"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} failed without '${reason}'"
    fi
}

# Print a digest of everything under <dir>: each entry's path, type, size,
# mode and modification time, and each file's SHA-256.
tree_digest() {
    (
        cd "$1" || exit 1
        find . -printf '%p %y %s %m %T@\n' | LC_ALL=C sort
        find . -type f -exec sha256sum {} + | LC_ALL=C sort
    )
}

# ---------------------------------------------------------------------------
# Exit hooks
# ---------------------------------------------------------------------------

# The trap stopped the scenario's tmux server: the PID the tmux_and_store leg
# saw is gone and no tmux server answers on any socket under SCENARIO_ROOT.
tmux_server_gone() {
    local sock
    if [[ -n "${T0_TMUX_PID}" ]] && pid_alive "${T0_TMUX_PID}"; then
        fail "teardown: the scenario's tmux server (PID ${T0_TMUX_PID}) is still running after the trap"
    fi
    while IFS= read -r -d '' sock; do
        if timeout 5 "${SCENARIO_REAL_TMUX}" -S "${sock}" list-sessions > /dev/null 2>&1; then
            fail "teardown: a tmux server still answers on ${sock} after the trap"
        fi
    done < <(find "${SCENARIO_ROOT}" -type s -print0 2> /dev/null)
}

remove_outside_home() {
    if [[ -n "${OUTSIDE_HOME}" && "${OUTSIDE_HOME}" == /tmp/test-0-outside-home.* ]]; then
        rm -rf -- "${OUTSIDE_HOME}"
    fi
}

on_exit tmux_server_gone
on_exit remove_outside_home

# ---------------------------------------------------------------------------
# Legs
# ---------------------------------------------------------------------------

leg_isolation() {
    local step="isolation" passwd_home real_root real_home rc_dir dir found entries=()
    [[ "${HOME}" == "${SCENARIO_ROOT}/home" && "${HOME}" == "${SCENARIO_HOME}" && -d "${HOME}" ]] \
        || fail "${step}: HOME '${HOME}' is not the scenario HOME ${SCENARIO_ROOT}/home"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}")"
    real_home="$(realpath -e -- "${HOME}")"
    [[ "${real_home}" == "${real_root}"/* ]] \
        || fail "${step}: HOME resolves to ${real_home}, outside SCENARIO_ROOT ${real_root}"
    passwd_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    [[ -n "${passwd_home}" && "${real_home}" != "${passwd_home}" ]] \
        || fail "${step}: HOME is the container user's own home '${passwd_home}'"
    [[ "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}/tmux" && -d "${TMUX_TMPDIR}" ]] \
        || fail "${step}: TMUX_TMPDIR '${TMUX_TMPDIR:-}' is not ${SCENARIO_ROOT}/tmux"
    [[ -z "${TMUX+set}" && -z "${TMUX_PANE+set}" ]] || fail "${step}: TMUX or TMUX_PANE is set"

    rc_dir="${SCENARIO_RC_BIN%/*}"
    IFS=: read -r -a entries <<< "${PATH}"
    [[ "${entries[0]:-}" == "${SCENARIO_BIN}" ]] \
        || fail "${step}: PATH starts with '${entries[0]:-}', not the scenario's bin ${SCENARIO_BIN}"
    for dir in "${entries[@]}"; do
        [[ "${dir}" == /* ]] || fail "${step}: PATH holds the relative or empty entry '${dir}'"
        [[ "${dir}" != "${rc_dir}" ]] || fail "${step}: PATH holds the image's default agent-director directory ${rc_dir}"
        [[ ! -e "${dir}/agent-director" && ! -L "${dir}/agent-director" ]] \
            || fail "${step}: PATH entry ${dir} holds an agent-director"
    done
    found="$(type -a -P agent-director || true)"
    [[ -z "${found}" ]] || fail "${step}: the scenario shell finds an agent-director: ${found}"
    [[ "$(type -P claude || true)" == "${SCENARIO_BIN}/claude" ]] \
        || fail "${step}: claude resolves to '$(type -P claude || true)', not ${SCENARIO_BIN}/claude"
    cmp -s -- "${SCENARIO_FIXTURES}/stub-claude.sh" "${SCENARIO_BIN}/claude" \
        || fail "${step}: ${SCENARIO_BIN}/claude is not the stub"
    [[ "$(type -P bun || true)" == /* ]] || fail "${step}: bun is not found on the scenario's PATH"

    [[ "${SCENARIO_AD_BIN}" == "${HOME}/.agent-director/bin/agent-director" ]] \
        || fail "${step}: SCENARIO_AD_BIN ${SCENARIO_AD_BIN} is not the scenario HOME's standard path"
    [[ "${SCENARIO_AD_SHIM_LOG}" == "${HOME}/.agent-director/bin/agent-director-shim.log" ]] \
        || fail "${step}: SCENARIO_AD_SHIM_LOG ${SCENARIO_AD_SHIM_LOG} is not beside the standard path"
    for found in agent-director-shim.log agent-director.real; do
        [[ ! -e "${passwd_home}/.agent-director/bin/${found}" ]] \
            || fail "${step}: the container user's own ${passwd_home}/.agent-director/bin holds ${found}"
    done
}

leg_real_binary() {
    local step="real binary" before out got got_commit
    before="$(call_count)"
    out="$("${SCENARIO_AD_BIN}.real" version)" || fail "${step}: ${SCENARIO_AD_BIN}.real version failed"
    got="$(jq -r '.version // empty' <<< "${out}")"
    got_commit="$(jq -r '.commit // empty' <<< "${out}")"
    [[ "${got}" == "${RC_VERSION}" && "${got_commit}" == "${RC_COMMIT}" ]] \
        || fail "${step}: the binary behind the shim reports ${got} ${got_commit}, not the recorded ${RC_VERSION} ${RC_COMMIT}"
    [[ "$(call_count)" == "${before}" ]] || fail "${step}: running the real binary by its own name added a shim log line"
}

leg_setup_install() {
    local step="setup install"
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    [[ -f "${HOME}/.agent-director/state.db" ]] || fail "${step}: no store at ${HOME}/.agent-director/state.db"
}

leg_harness_call_log() {
    local step="harness call log" before t_before t_after mine=()
    local want=(get --claude-instance-id "t0 no such row")
    before="$(call_count)"
    t_before="${EPOCHREALTIME/,/.}"
    ad_capture "${want[@]}"
    t_after="${EPOCHREALTIME/,/.}"
    grep -qF '"err_name"' "${AD_OUT}" "${AD_ERR}" \
        || fail "${step}: the call got no answer from agent-director (exit ${AD_RC})"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the call did not add exactly one call line"
    HARNESS_CALL_LINE="$(last_call_line)"
    read_call "${step}" "${HARNESS_CALL_LINE}"
    awk -v a="${t_before}" -v t="${CALL_TIME}" -v b="${t_after}" 'BEGIN { exit !(a <= t && t <= b) }' \
        || fail "${step}: the line's time ${CALL_TIME} is not between ${t_before} and ${t_after}"
    [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the line's parent is ${CALL_PPID}, not the scenario's shell $$"
    [[ "${CALL_PID}" != "$$" ]] || fail "${step}: the line's pid is the scenario's shell"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    same_words CALL_PARENT mine \
        || fail "${step}: the line's parent command line $(quoted "${CALL_PARENT[@]}") is not the shell's $(quoted "${mine[@]}")"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv $(quoted "${want[@]}")"
}

leg_version_probe() {
    local step="version probe" probe="${SCENARIO_ROOT}/version-probe.ts" out err before rc=0 got
    out="${SCENARIO_ROOT}/version-probe.out"
    err="${SCENARIO_ROOT}/version-probe.err"
    cat > "${probe}" << 'EOF'
// The installed package's agent-director client, resolved from its src/:
// discovery and the version probe, as a CSCB process makes them.
import { homedir } from 'node:os'
const [pkgSrc] = process.argv.slice(2)
const client = await import(Bun.resolveSync('agent-director', pkgSrc))
const found = await client.resolveSystemBinary()
console.log(JSON.stringify({ home: homedir(), path: found.path, version: found.version }))
EOF
    before="$(call_count)"
    bun --no-install "${probe}" "${SCENARIO_REPO}/node_modules/claude-slack-channel-bots/src" > "${out}" 2> "${err}" || rc=$?
    if (( rc != 0 )); then
        sed 's/^/  | /' "${out}" "${err}" >&2
        fail "${step}: bun exited ${rc}"
    fi
    got="$(jq -r '.home' "${out}")"
    [[ "${got}" == "${HOME}" ]] || fail "${step}: bun's home is '${got}', not the scenario HOME ${HOME}"
    got="$(jq -r '.path' "${out}")"
    [[ "${got}" == "${SCENARIO_AD_BIN}" ]] || fail "${step}: the client resolved '${got}', not the shim at ${SCENARIO_AD_BIN}"
    got="$(jq -r '.version' "${out}")"
    [[ "${got}" == "${RC_VERSION}" ]] || fail "${step}: the probe got version '${got}', not the recorded ${RC_VERSION}"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the probe did not add exactly one call line"
    read_call "${step}" "$(last_call_line)"
    [[ "${CALL_WORDS[0]:-}" == version ]] || fail "${step}: the probe's line has words $(quoted "${CALL_WORDS[@]}"), not version …"
    [[ "${CALL_PPID}" != "$$" && ( "${CALL_PARENT[0]:-}" == */bun || "${CALL_PARENT[0]:-}" == bun ) ]] \
        || fail "${step}: the probe's line has parent $(quoted "${CALL_PARENT[@]}") (${CALL_PPID}), not bun"
}

leg_tmux_and_store() {
    local step="tmux and store" work row_socket info sock_path store_id got
    work="$(make_workdir self-check)"
    ad_capture spawn --cwd "${work}" --claude-instance-id "${T0_ROW_ID}" \
        --tmux-session-name "${T0_SESSION}" --no-pre-trust --label "t0=spawned"
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: harness spawn exited ${AD_RC}"
    fi
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    row_socket="$(jq -r '.tmux_socket // empty' "${AD_OUT}")"
    [[ "${row_socket}" == "${TMUX_TMPDIR}"/* && -S "${row_socket}" ]] \
        || fail "${step}: the row's tmux socket '${row_socket}' is not a socket under ${TMUX_TMPDIR}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == spawned ]] || fail "${step}: the spawned row's label t0 is '${got}', not spawned"

    # The scenario shell's tmux (by TMUX_TMPDIR) reaches the session, on the
    # row's socket, and the server is this scenario's.
    info="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${T0_SESSION}" '#{socket_path} #{pid}')" \
        || fail "${step}: the scenario shell's tmux does not reach session ${T0_SESSION}"
    sock_path="${info% *}"
    T0_TMUX_PID="${info##* }"
    [[ "${sock_path}" == "${row_socket}" ]] \
        || fail "${step}: the scenario shell's tmux talks to ${sock_path}, not the row's ${row_socket}"
    [[ "${T0_TMUX_PID}" =~ ^[0-9]+$ ]] || fail "${step}: tmux reported server PID '${T0_TMUX_PID}'"
    grep -qzxF -- "SCENARIO_ROOT=${SCENARIO_ROOT}" "/proc/${T0_TMUX_PID}/environ" \
        || fail "${step}: tmux server ${T0_TMUX_PID} does not carry this scenario's SCENARIO_ROOT"

    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    T0_STORE_ID="${store_id}"
    ad_store_edit "UPDATE spawns SET labels = '{\"t0\":\"edited\"}' WHERE claude_instance_id = '${T0_ROW_ID}'"
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get after the edit exited ${AD_RC}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == edited ]] || fail "${step}: harness get after ad_store_edit shows label t0 '${got}', not edited"
}

leg_swap() {
    local step="swap" got_commit
    swap_ad_binary 0.10.0 "${step}: to 0.10.0"
    expect_shim_in_place "${step}: after the swap to 0.10.0" "${SCENARIO_AD_010_BIN}"
    expect_ad_version "${step}: after the swap to 0.10.0" 0.10.0
    got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
    [[ "${got_commit}" != "${RC_COMMIT}" ]] || fail "${step}: 0.10.0 reports the release candidate's commit"
    swap_ad_binary rc "${step}: back to the release candidate"
    expect_shim_in_place "${step}: after the swap back" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the swap back" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_reinstall() {
    local step="reinstall" store_id
    install_ad_rc "${step}: install.sh again"
    expect_shim_in_place "${step}: after install.sh and its re-shim" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    store_id="$(ad_store_id)"
    [[ "${store_id}" == "${T0_STORE_ID}" ]] || fail "${step}: the store id changed from ${T0_STORE_ID} to ${store_id}"
}

leg_hide_restore() {
    local step="hide and restore"
    hide_ad_install "${step}: hide"
    [[ ! -e "${SCENARIO_AD_BIN}" && ! -L "${SCENARIO_AD_BIN}" ]] || fail "${step}: a file is at ${SCENARIO_AD_BIN} after the hide"
    [[ ! -e "${SCENARIO_AD_BIN}.real" && ! -L "${SCENARIO_AD_BIN}.real" ]] \
        || fail "${step}: a file is at ${SCENARIO_AD_BIN}.real after the hide"
    [[ -f "${SCENARIO_AD_SHIM_LOG}" ]] || fail "${step}: the shim log went with the hide"
    restore_ad_install "${step}: restore"
    expect_shim_in_place "${step}: after the restore" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the restore" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_log_kept() {
    local step="log kept" bad
    grep -qxF -- "${HARNESS_CALL_LINE}" "${SCENARIO_AD_SHIM_LOG}" \
        || fail "${step}: the harness call's line is gone from the shim log"
    bad="$(awk -F'\t' 'NF != 6 || ($1 != "call" && $1 != "stop") { print NR; exit }' "${SCENARIO_AD_SHIM_LOG}")"
    [[ -z "${bad}" ]] || fail "${step}: shim log line ${bad} does not have the format's six fields and a known kind"
}

# The body of the nested fmk run of leg_start_on_010 (written into its script
# with `declare -f`, after it sourced lib/scenario.sh with
# SCENARIO_AD_START=0.10.0).
nested_start_on_010() {
    local step="0.10.0 start" file store_id
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_AD_010_BIN}"
    while IFS= read -r -d '' file; do
        ! cmp -s -- "${SCENARIO_RC_BIN}" "${file}" || fail "${step}: ${file} is the release candidate's binary"
    done < <(find "${HOME}" -type f -print0)
    [[ ! -e "${HOME}/.agent-director/state.db" ]] || fail "${step}: a store exists before the release candidate's install"
    expect_ad_version "${step}: a call through the shim" 0.10.0
    install_ad_rc "${step}: install_ad_rc"
    expect_shim_in_place "${step}: after install_ad_rc" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after install_ad_rc" "${RC_VERSION}" "${RC_COMMIT}"
    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    echo "PASS: ${TEST_NAME}"
}

leg_start_on_010() {
    local step="0.10.0 start" nested="${SCENARIO_ROOT}/nested-start-on-010.sh" out rc=0 line
    local name="test-0-fmk-nested-start-on-010"
    out="${SCENARIO_ROOT}/nested-start-on-010.out"
    {
        printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
        printf 'TEST_NAME=%q\n' "${name}"
        printf '%s\n' 'SCENARIO_AD_START=0.10.0'
        printf 'source %q\n' "${SCENARIO_LIB}"
        printf 'RC_VERSION=%q\nRC_COMMIT=%q\n' "${RC_VERSION}" "${RC_COMMIT}"
        declare -f expect_shim_in_place expect_ad_version nested_start_on_010
        printf '%s\n' 'nested_start_on_010'
    } > "${nested}"
    bash "${nested}" > "${out}" 2>&1 || rc=$?
    if (( rc != 0 )) || ! grep -qxF "PASS: ${name}" "${out}"; then
        sed 's/^/  | /' "${out}" >&2
        line="$(grep -m1 '^FAIL:' "${out}" || true)"
        fail "${step}: the nested run exited ${rc}: ${line#FAIL: }"
    fi
}

leg_guard_refusals() {
    local step="guard refusals" link real_outside before home reason
    OUTSIDE_HOME="$(mktemp -d /tmp/test-0-outside-home.XXXXXX)" || fail "${step}: could not make a HOME outside SCENARIO_ROOT"
    # A decoy install and store each helper would act on, were it not refused.
    mkdir -p "${OUTSIDE_HOME}/.agent-director/bin"
    cp -- "${SCENARIO_AD_010_BIN}" "${OUTSIDE_HOME}/.agent-director/bin/agent-director"
    sqlite3 "${OUTSIDE_HOME}/.agent-director/state.db" \
        "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO store_meta VALUES ('store_id', '0123456789abcdef'); CREATE TABLE spawns (claude_instance_id TEXT PRIMARY KEY, labels TEXT NOT NULL DEFAULT '{}');" \
        || fail "${step}: could not make the decoy store"
    link="${SCENARIO_ROOT}/home-link-outside"
    ln -s -- "${OUTSIDE_HOME}" "${link}"
    real_outside="$(realpath -e -- "${OUTSIDE_HOME}")"
    before="$(tree_digest "${OUTSIDE_HOME}")"

    for home in "${OUTSIDE_HOME}" "${link}"; do
        if [[ "${home}" == "${link}" ]]; then
            reason="refused: HOME ${link} resolves to ${real_outside}, which is not under SCENARIO_ROOT"
        else
            reason="refused: HOME '${OUTSIDE_HOME}' is not under SCENARIO_ROOT"
        fi
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_shim
        expect_fails_in_home "${step}" "${home}" "${reason}" reshim_ad
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_rc
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_010
        expect_fails_in_home "${step}" "${home}" "${reason}" swap_ad_binary rc
        expect_fails_in_home "${step}" "${home}" "${reason}" hide_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" restore_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" ad version
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_edit "UPDATE spawns SET labels = '{}'"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_id
    done
    [[ "$(tree_digest "${OUTSIDE_HOME}")" == "${before}" ]] \
        || fail "${step}: the HOME outside SCENARIO_ROOT changed under the refused helpers"
}

leg_shim_check() {
    local step="shim check" home="${SCENARIO_ROOT}/home-shim-check" bin
    bin="${home}/.agent-director/bin"
    mkdir -p "${bin}"
    cp -- "${SCENARIO_RC_BIN}" "${bin}/agent-director.real"
    cp -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director.real" "${bin}/agent-director"
    ( export HOME="${home}"; check_ad_shim "${step}: a correct layout" ) \
        || fail "${step}: check_ad_shim refused a correct layout"

    rm -f -- "${bin}/agent-director"
    ln -s -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "is a symlink, not the shim" check_ad_shim

    rm -f -- "${bin}/agent-director"
    grep -vxF -- "${SCENARIO_AD_SHIM_MARKER}" "${SCENARIO_AD_SHIM_SRC}" > "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "does not carry the shim's marker" check_ad_shim
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

LEGS=(
    isolation
    real_binary
    setup_install
    harness_call_log
    version_probe
    tmux_and_store
    swap
    reinstall
    hide_restore
    log_kept
    start_on_010
    guard_refusals
    shim_check
)

for leg in "${LEGS[@]}"; do
    echo "${TEST_NAME}: leg ${leg}"
    "leg_${leg}"
done

echo "PASS: ${TEST_NAME}"
