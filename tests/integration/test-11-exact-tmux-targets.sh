#!/usr/bin/env bash
# Test 11 (b.1ix): the server's raw tmux calls for a persona touch only that
# persona's own session, never a session whose name it prefixes.
#
# tmux resolves a bare `-t <name>` by prefix when no session has that exact
# name, and persona keys can prefix one another: persona `dev`'s session
# `slack_bot_dev` is a prefix of persona `dev_2`'s `slack_bot_dev_2`. The
# server addresses a session exactly instead (`=<name>` for a session,
# `=<name>:` for its pane; src/session-manager.ts, the tmux runner).
#
# Each case starts a tmux server of its own (its own TMUX_TMPDIR under
# SCENARIO_ROOT, so no other script's sessions are in reach) holding the
# sessions it needs, runs one of the installed package's persona paths for
# `dev` through the driver (fixtures/exact-tmux-driver.ts: real tmux, a
# stand-in agent-director), then checks every session:
#   1. only the neighbour `slack_bot_dev_2` exists:
#      - the liveness probe (has-session) reads `dev` as gone;
#      - the dialog approver, for an `ended` row, finds no dialog and
#        presses no Enter, though the neighbour's pane shows one;
#      - the b.vub self-heal kill (after a spawn refused with
#        ErrTmuxSessionCreate) leaves the neighbour running.
#   2. `slack_bot_dev` and `slack_bot_dev_2` both exist:
#      - the probe reads `dev` as alive;
#      - the approver presses Enter in `slack_bot_dev` only;
#      - the self-heal kills `slack_bot_dev` only.
# With bare targets, case 1's approver pressed Enter in `slack_bot_dev_2`
# and its self-heal killed it.
#
# Every session runs `dialog-pane.sh`, which this script writes: it shows the
# dev-channels dialog's option line (the approver's needle,
# src/session-manager.ts DEV_CHANNELS_DIALOG_NEEDLE), logs one line per Enter
# typed into the pane, and clears the dialog at the first.
#
# No server starts and no agent-director row is made (the driver's
# agent-director is a stand-in), so the persona name `dev` needs no
# SCENARIO_TAG. Depends on Test 1 having installed the package.
set -euo pipefail

TEST_NAME="test-11-exact-tmux-targets"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

PKG_DIR="${SCENARIO_REPO}/node_modules/claude-slack-channel-bots"
DRIVER="/tests/integration/fixtures/exact-tmux-driver.ts"
SESSION="slack_bot_dev"
NEIGHBOUR="slack_bot_dev_2"
# src/session-manager.ts DEV_CHANNELS_DIALOG_NEEDLE.
NEEDLE="I am using this for local development"
# Bound on a new session's pane showing the dialog.
PANE_READY_S=10

command -v tmux >/dev/null 2>&1 || fail "tmux not on PATH (see docker/Dockerfile.test.base)"
test -d "${PKG_DIR}" || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"
test -f "${DRIVER}" || fail "driver fixture missing at ${DRIVER}"

unset TMUX
CASE_N=0
CASE_DIR=""

# Stop every tmux server a case started.
kill_case_servers() {
    local dir
    for dir in "${SCENARIO_ROOT}"/case-*/tmux; do
        if [[ -d "${dir}" ]]; then TMUX_TMPDIR="${dir}" tmux kill-server 2>/dev/null || true; fi
    done
    return 0
}
on_exit kill_case_servers

WORKDIR="$(make_workdir dev)"
PANE_SCRIPT="${SCENARIO_ROOT}/dialog-pane.sh"
write_file "${PANE_SCRIPT}" 0755 <<'PANE'
#!/usr/bin/env bash
# dialog-pane.sh <input-log>: show the dev-channels dialog; log one line per
# Enter typed into the pane; clear the dialog at the first.
log="$1"
: > "${log}"
printf '%s\n' 'WARNING: Loading development channels' '' '> 1. I am using this for local development' '  2. Exit'
IFS= read -r _ || exit 0
printf 'enter\n' >> "${log}"
printf '\033[H\033[2J%s\n' 'dialog dismissed'
while IFS= read -r _; do printf 'enter\n' >> "${log}"; done
PANE

input_log() { printf '%s/%s.input' "${CASE_DIR}" "$1"; }
has_session() { tmux has-session -t "=$1" 2>/dev/null; }
pane_shows_needle() { tmux capture-pane -p -t "=$1:" 2>/dev/null | grep -qF "${NEEDLE}"; }
enters() { if [[ -f "$(input_log "$1")" ]]; then wc -l < "$(input_log "$1")" | tr -d ' '; else echo 0; fi; }
expect_alive() { has_session "$1" || fail "$2: ${1} is gone"; }
expect_gone() { ! has_session "$1" || fail "$2: ${1} is still running"; }

# arrange <session>...: a new case on a new tmux server (exported
# TMUX_TMPDIR, which the driver inherits) holding exactly these sessions,
# each showing the dialog.
arrange() {
    local s
    CASE_N=$((CASE_N + 1))
    CASE_DIR="${SCENARIO_ROOT}/case-${CASE_N}"
    mkdir -p "${CASE_DIR}/tmux"
    export TMUX_TMPDIR="${CASE_DIR}/tmux"
    for s in "$@"; do
        tmux new-session -d -s "${s}" -x 200 -y 50 "${PANE_SCRIPT} $(input_log "${s}")" \
            || fail "case ${CASE_N}: tmux new-session ${s}"
    done
    for s in "$@"; do
        wait_until "${PANE_READY_S}" "case ${CASE_N}: ${s} shows the dialog" pane_shows_needle "${s}"
    done
}

# drive <action>: run the driver for <action>; print its DRIVER: line.
drive() {
    local action="$1" out rc err="${CASE_DIR}/driver-$1.err"
    set +e
    out="$(env -u SLACK_DRY_RUN CSCB_PKG_DIR="${PKG_DIR}" DRIVER_ACTION="${action}" \
        DRIVER_WORKING_DIRECTORY="${WORKDIR}" bun "${DRIVER}" 2>"${err}")"
    rc=$?
    set -e
    if [[ "${rc}" -ne 0 ]]; then
        printf '%s\n' "${out}" >&2
        tail -n 20 "${err}" >&2 || true
        fail "case ${CASE_N}: driver ${action} exited ${rc}: $(printf '%s\n' "${out}" | grep -m1 '^DRIVER_FAIL:' || echo 'no DRIVER_FAIL line')"
    fi
    printf '%s\n' "${out}" | grep -m1 "^DRIVER: ${action}" || fail "case ${CASE_N}: driver ${action} printed no DRIVER: line"
}

# --- 1. Only the prefix neighbour exists ------------------------------------

arrange "${NEIGHBOUR}"
line="$(drive probe)"
[[ "${line}" == "DRIVER: probe alive=false" ]] || fail "neighbour only: the probe read ${SESSION} as alive (${line})"

arrange "${NEIGHBOUR}"
drive approver > /dev/null
[[ "$(enters "${NEIGHBOUR}")" == 0 ]] || fail "neighbour only: the approver pressed Enter in ${NEIGHBOUR}"
pane_shows_needle "${NEIGHBOUR}" || fail "neighbour only: ${NEIGHBOUR}'s dialog was dismissed"

arrange "${NEIGHBOUR}"
line="$(drive self-heal)"
[[ "${line}" == "DRIVER: self-heal action=spawned" ]] || fail "neighbour only: the self-heal did not end spawned (${line})"
expect_alive "${NEIGHBOUR}" "neighbour only, the self-heal kill"

# --- 2. The persona's own session and its prefix neighbour ------------------

arrange "${SESSION}" "${NEIGHBOUR}"
line="$(drive probe)"
[[ "${line}" == "DRIVER: probe alive=true" ]] || fail "both: the probe read ${SESSION} as gone (${line})"

arrange "${SESSION}" "${NEIGHBOUR}"
drive approver > /dev/null
[[ "$(enters "${SESSION}")" -ge 1 ]] || fail "both: the approver pressed no Enter in ${SESSION}"
[[ "$(enters "${NEIGHBOUR}")" == 0 ]] || fail "both: the approver pressed Enter in ${NEIGHBOUR}"
pane_shows_needle "${NEIGHBOUR}" || fail "both: ${NEIGHBOUR}'s dialog was dismissed"

arrange "${SESSION}" "${NEIGHBOUR}"
line="$(drive self-heal)"
[[ "${line}" == "DRIVER: self-heal action=spawned" ]] || fail "both: the self-heal did not end spawned (${line})"
expect_gone "${SESSION}" "both, the self-heal kill"
expect_alive "${NEIGHBOUR}" "both, the self-heal kill"

echo "PASS: ${TEST_NAME}"
