#!/usr/bin/env bash
# Test 30 (b.smv): the state directory at its first start of this build, from
# each layout an earlier release left, in a fresh HOME each.
#
# The state directory's default is $HOME/.config/claude-slack-channel-bots. An
# earlier release left it elsewhere, in one of three layouts, and the first
# start of this build (src/state-dir-migration.ts migrateStateDirAtStart) moves
# it, whole, and leaves a symbolic link at each old name:
#   up to 0.13  L1 = $HOME/.claude/channels/slack, the one real directory.
#   0.14.0      L1 real, with the configuration and the server's files; L2 =
#               $HOME/.config/cscb real, holding only the crontable and
#               prompts/, which L1's `crontab` and `prompts` link to.
#   0.15.0      L2 real and complete; L1 a symbolic link to L2.
# N is the new directory. Nothing in any layout is seeded at N: the script
# seeds exactly what the release left (a persona-shaped config.json, the
# persona's credentials file, a crontable and its prompts/, server.log and a
# stale server.pid), then starts the build under test in dry run, as a
# customer's first start after the upgrade.
#
# A shared-mode scenario (no `-fmk-` in its name; lib/scenario.sh "Two
# modes"): its own port and persona name (`<tag>_alpha`, from SCENARIO_TAG),
# the container's agent-director store and tmux server, no shim and no closing
# assertions. Only HOME differs: each layout runs in its own, a directory
# under SCENARIO_ROOT, so the container's own state directories are never
# read or written. The agent-director binary is found on PATH
# (/opt/agent-director/bin), as in every shared-mode scenario. Dry run still
# runs the start's agent-director check (the version probe) and installs the
# templates, both through $HOME/.config/agent-director, a symbolic link to the
# container's own, so the start finds what it needs. Neither
# SLACK_STATE_DIR nor XDG_CONFIG_HOME reaches a CSCB process: the harness
# reads N through a shell variable that is never exported, so the build finds
# its directory as a customer's does. No credentials file is read in dry run.
#
# What each layout asserts after the start (the lines are
# src/state-dir-migration.ts's text, matched whole; each layout's list is
# complete and in order):
#   up to 0.13  stateDirRenamedLine(L1, N); L2 is never made.
#   0.14.0      stateDirRenamedLine(L2, N, xdg), then stateDirMergedLine(L1, N)
#               naming the files that moved from L1 (the config, the
#               credentials file, server.log, server.pid; not the two links,
#               which the crontable and prompts/ at N replace).
#   0.15.0      stateDirRenamedLine(L2, N, xdg), then stateDirRepointedLine(L1,
#               L2, N).
# And, in every layout:
# - the files are at N, each a regular file or directory with the seeded
#   content (config.json, the credentials file with its mode, the crontable,
#   prompts/daily.md), and the old server.log lines are in N's server.log;
# - N's server.pid names the bot server this start made (the stale one is gone);
# - L1 is a symbolic link to N itself (the 0.15.0 link to L2 is repointed, so
#   removing ~/.config/cscb leaves it intact), L2 (but for up to 0.13) a
#   symbolic link to N, and each old name reaches N's config.json;
# - server.log holds exactly the layout's `[slack] state-migrate:` lines and no
#   `[slack] Warning: state-migrate:` line (once they match, the script prints
#   each one, `<layout>: state-migrate line <n>: <line>`, as the run's evidence);
# - the CLI's `stop` (no SLACK_STATE_DIR, so it finds the directory itself)
#   finds the server and stops it.
set -euo pipefail

TEST_NAME="test-30-state-dir-upgrade"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on the start's bring-up pass reaching its completion line. Dry run
# makes no Slack call, so it takes about a second.
BRINGUP_WAIT_S=60

REAL_HOME="${HOME}"
ALPHA_NAME="${SCENARIO_TAG}_alpha"
ALPHA_DIR="$(make_workdir alpha)"
# Upper-case letters and digits only (CHANNEL_ID_RE, src/config.ts).
ALPHA_CHANNEL="C0${SCENARIO_TAG^^}ALPHA"
CREDENTIALS_NAME="credentials-${ALPHA_NAME}.json"
OLD_LOG_LINE="a line the old release logged"
SEED="${SCENARIO_ROOT}/seed"
# Neither may reach a CSCB process: the scenario sourced lib/scenario.sh, which
# exports SLACK_STATE_DIR.
unset XDG_CONFIG_HOME
export -n SLACK_STATE_DIR

# Set by `enter_layout`: the layout's HOME and its three directories.
L1="" L2="" N=""

# --- The text the build logs (src/state-dir-migration.ts) --------------------

# stateDirRenamedLine <old> <new> <xdg: 0|1>
renamed_line() {
    local why="its new default location outside ~/.claude, where Claude Code does not ask before a write"
    [[ "$3" == 1 ]] && why="its new default location, named after the package"
    printf '[slack] state-migrate: moved the state directory from %s to %s, %s. %s is now a symbolic link to it, so a session, script or configuration path that still names the old directory reaches the same files.' \
        "$1" "$2" "${why}" "$1"
}

# stateDirMergedLine <old> <new> <entry>... (not xdg)
merged_line() {
    local old="$1" new="$2" entries="" name
    shift 2
    for name in "$@"; do
        entries+="${entries:+, }\"${name}\""
    done
    printf "[slack] state-migrate: the state directory's new default location is %s, outside ~/.claude, where Claude Code does not ask before a write; moved %s from %s. %s is now a symbolic link to %s, so a session, script or configuration path that still names the old directory reaches the same files." \
        "${new}" "${entries}" "${old}" "${old}" "${new}"
}

# stateDirRepointedLine <L1> <L2> <new>
repointed_line() {
    printf '[slack] state-migrate: %s was a symbolic link to %s, which is now a link to %s; it is now a symbolic link to %s itself, so removing %s does not leave it dangling.' \
        "$1" "$2" "$3" "$3" "$2"
}

# --- Seeding ------------------------------------------------------------------

# A PID no process has, for the stale server.pid the old release left.
stale_pid() {
    local pid
    for pid in $(seq 4194000 -1 4193000); do
        if ! kill -0 "${pid}" 2> /dev/null; then
            echo "${pid}"
            return 0
        fi
    done
    fail "setup: no unused PID found for the stale server.pid"
}

# The files the old release's server and operator made, written once under
# SEED: what each layout seeds and what N must hold after the start.
# The configuration names its credentials file at $1.
make_seed() {
    local credentials_path="$1"
    mkdir -p "${SEED}/prompts" || fail "setup: could not create ${SEED}"
    python3 - "${ALPHA_NAME}" "${credentials_path}" "${ALPHA_DIR}" "${ALPHA_CHANNEL}" "${SCENARIO_PORT}" << 'EOF' | write_file "${SEED}/config.json"
import json, sys
name, credentials, workdir, channel, port = sys.argv[1:]
print(json.dumps({
    "personas": [
        {
            "name": name,
            "credentials_file": credentials,
            "working_directory": workdir,
            "channels": [{"id": channel, "delivery": "all"}],
            "permission_prompts": channel,
        },
    ],
    "bind": "127.0.0.1",
    "port": int(port),
}, indent=2))
EOF
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot t30seed)" "$(fake_token app t30seed)" \
        | write_file "${SEED}/${CREDENTIALS_NAME}" 600
    # Its schedule falls on 1 January only; the prompt path is relative to the
    # crontable's directory.
    {
        echo "# The host's scheduled prompts."
        echo "0 0 1 1 * prompts/daily.md ${ALPHA_NAME}"
    } | write_file "${SEED}/crontab"
    printf 'Summarize the day.\n' | write_file "${SEED}/prompts/daily.md"
    printf '%s\n' "${OLD_LOG_LINE}" | write_file "${SEED}/server.log"
    printf '%s\n' "$(stale_pid)" | write_file "${SEED}/server.pid"
}

# Copy the seeded <name>s into <dir>, keeping modes.
seed_into() {
    local dir="$1" name
    shift
    mkdir -p "${dir}" || fail "setup: could not create ${dir}"
    for name in "$@"; do
        cp -a -- "${SEED}/${name}" "${dir}/${name}" || fail "setup: could not seed ${dir}/${name}"
    done
}

# Switch to a fresh HOME for <layout>, with L1, L2 and N named (none made).
enter_layout() {
    HOME="${SCENARIO_ROOT}/home-$1"
    export HOME
    mkdir -p "${HOME}" || fail "setup: could not create ${HOME}"
    # The container's agent-director install, which the start's check reads.
    if [[ -e "${REAL_HOME}/.config/agent-director" ]]; then
        mkdir -p "${HOME}/.config" || fail "setup: could not create ${HOME}/.config"
        ln -s "${REAL_HOME}/.config/agent-director" "${HOME}/.config/agent-director" \
            || fail "setup: could not link ${HOME}/.config/agent-director"
    fi
    L1="${HOME}/.claude/channels/slack"
    L2="${HOME}/.config/cscb"
    N="${HOME}/.config/claude-slack-channel-bots"
    # The harness reads N through this variable; it is never exported.
    SLACK_STATE_DIR="${N}"
    export -n SLACK_STATE_DIR
}

# <layout>'s state, as the release left it.
seed_layout() {
    case "$1" in
        0.13)
            seed_into "${L1}" config.json "${CREDENTIALS_NAME}" crontab prompts server.log server.pid
            ;;
        0.14.0)
            seed_into "${L1}" config.json "${CREDENTIALS_NAME}" server.log server.pid
            seed_into "${L2}" crontab prompts
            ln -s "${L2}/crontab" "${L1}/crontab" || fail "setup: could not link ${L1}/crontab"
            ln -s "${L2}/prompts" "${L1}/prompts" || fail "setup: could not link ${L1}/prompts"
            ;;
        0.15.0)
            seed_into "${L2}" config.json "${CREDENTIALS_NAME}" crontab prompts server.log server.pid
            mkdir -p "$(dirname "${L1}")" || fail "setup: could not create $(dirname "${L1}")"
            ln -s "${L2}" "${L1}" || fail "setup: could not link ${L1}"
            ;;
        *) fail "seed_layout: unknown layout '$1'" ;;
    esac
}

# --- Checks -------------------------------------------------------------------

# <layout>: the exact `[slack] state-migrate:` lines of the start, in order.
expected_lines() {
    case "$1" in
        0.13)
            renamed_line "${L1}" "${N}" 0
            ;;
        0.14.0)
            renamed_line "${L2}" "${N}" 1
            echo
            # The names that move from L1, in the order the build lists them
            # (code-unit order); the crontable and prompts/ links are not among them.
            merged_line "${L1}" "${N}" config.json "${CREDENTIALS_NAME}" server.log server.pid
            ;;
        0.15.0)
            renamed_line "${L2}" "${N}" 1
            echo
            repointed_line "${L1}" "${L2}" "${N}"
            ;;
    esac
    echo
}

check_layout_after_start() {
    local layout="$1" step="$1: after the first start" name f
    local want=() got=() i n

    # Nothing but N is a directory now; the old names are links to it.
    [[ -d "${N}" && ! -L "${N}" ]] || fail "${step}: ${N} is not a real directory"
    [[ -L "${L1}" && "$(readlink -- "${L1}")" == "${N}" ]] \
        || fail "${step}: ${L1} is not a symbolic link to ${N} itself (it links to '$(readlink -- "${L1}" || true)')"
    if [[ "${layout}" == 0.13 ]]; then
        [[ ! -e "${L2}" && ! -L "${L2}" ]] || fail "${step}: ${L2} exists on a layout that never had it"
    else
        [[ -L "${L2}" && "$(readlink -- "${L2}")" == "${N}" ]] \
            || fail "${step}: ${L2} is not a symbolic link to ${N} (it links to '$(readlink -- "${L2}" || true)')"
    fi

    # The files, each the seeded content, real at N.
    for name in config.json "${CREDENTIALS_NAME}" crontab; do
        [[ -f "${N}/${name}" && ! -L "${N}/${name}" ]] || fail "${step}: ${N}/${name} is not a regular file"
        cmp -s -- "${SEED}/${name}" "${N}/${name}" || fail "${step}: ${N}/${name} is not the seeded file"
    done
    [[ "$(stat -c '%a' "${N}/${CREDENTIALS_NAME}")" == 600 ]] || fail "${step}: ${N}/${CREDENTIALS_NAME} is not mode 0600"
    [[ -d "${N}/prompts" && ! -L "${N}/prompts" ]] || fail "${step}: ${N}/prompts is not a real directory"
    cmp -s -- "${SEED}/prompts/daily.md" "${N}/prompts/daily.md" || fail "${step}: ${N}/prompts/daily.md is not the seeded file"
    grep -qxF -- "${OLD_LOG_LINE}" "${N}/server.log" || fail "${step}: ${N}/server.log lost the old release's line"
    [[ "$(server_pid)" == "${SERVER_PID}" ]] \
        || fail "${step}: ${N}/server.pid does not name the bot server (PID ${SERVER_PID})"

    # Each old name reaches the files.
    for f in "${L1}" "${L2}"; do
        [[ -e "${f}" ]] || continue
        cmp -s -- "${SEED}/config.json" "${f}/config.json" || fail "${step}: ${f}/config.json is not the seeded configuration"
        cmp -s -- "${SEED}/crontab" "${f}/crontab" || fail "${step}: ${f}/crontab is not the seeded crontable"
        cmp -s -- "${SEED}/prompts/daily.md" "${f}/prompts/daily.md" || fail "${step}: ${f}/prompts/daily.md is not the seeded prompt"
    done

    # The state-migrate lines: exactly this layout's, in order, and no warning.
    mapfile -t want < <(expected_lines "${layout}")
    mapfile -t got < <(grep -F -- "[slack] state-migrate:" "${N}/server.log" || true)
    if (( ${#got[@]} != ${#want[@]} )); then
        sed 's/^/  | /' "${N}/server.log" >&2
        fail "${step}: server.log carries ${#got[@]} state-migrate line(s), not ${#want[@]}"
    fi
    for i in "${!want[@]}"; do
        # The build's text, whole; a prefix the log adds (a time) is allowed.
        if [[ "${got[i]}" != *"${want[i]}" ]]; then
            printf '  | want: %s\n  | got:  %s\n' "${want[i]}" "${got[i]}" >&2
            fail "${step}: state-migrate line $(( i + 1 )) is not the expected one"
        fi
    done
    n="$(grep -cF -- "[slack] Warning: state-migrate:" "${N}/server.log" || true)"
    if [[ "${n}" != 0 ]]; then
        grep -F -- "[slack] Warning: state-migrate:" "${N}/server.log" | sed 's/^/  | /' >&2
        fail "${step}: server.log carries ${n} state-migrate warning(s)"
    fi
    # The evidence: the lines matched, in the scenario's log.
    for i in "${!got[@]}"; do
        printf '%s: state-migrate line %d: %s\n' "${layout}" "$(( i + 1 ))" "${got[i]}"
    done
}

# --- The layouts ----------------------------------------------------------------

for layout in 0.13 0.14.0 0.15.0; do
    enter_layout "${layout}"
    # The credentials file is named where the release kept it: L1 up to 0.14.0, L2 on 0.15.0.
    if [[ "${layout}" == 0.15.0 ]]; then
        credentials_path="${L2}/${CREDENTIALS_NAME}"
    else
        credentials_path="${L1}/${CREDENTIALS_NAME}"
    fi
    make_seed "${credentials_path}"
    seed_layout "${layout}"
    [[ ! -e "${N}" && ! -L "${N}" ]] || fail "${layout}: setup: ${N} exists before the first start"

    # shellcheck disable=SC2119 # dry-run start: no --live
    start_server
    wait_for_log "$(completion_match 1)" "${BRINGUP_WAIT_S}" \
        "${layout}: start: server.log never showed the startupSessionManager completion line for 1 persona"
    check_layout_after_start "${layout}"

    # The CLI's own `stop`, with no SLACK_STATE_DIR, finds the server through
    # the directory it resolves.
    stop_server
    echo "PASS: ${TEST_NAME}: ${layout}"
    HOME="${REAL_HOME}"
    export HOME
done

echo "PASS: ${TEST_NAME}"
