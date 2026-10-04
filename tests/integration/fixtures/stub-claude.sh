#!/usr/bin/env bash
# stub-claude.sh — a fake `claude` binary for the integration tests that launch
# a real bot through agent-director and tmux (Test 4, Test 10 and Test 12).
#
# Each of those tests copies this file first on PATH as `claude`, so the real
# agent-director and tmux launch path runs without the Anthropic API or a
# model. agent-director starts `claude` in a tmux pane with at least two argv
# elements, so no shell stands between tmux and this script: the stub's own
# process is the pane's main process.
#
# BEHAVIOR
# --------
#   1. Print the exact dev-channels warning dialog, including the needle
#      "I am using this for local development" that CSCB's approver matches
#      (src/session-manager.ts:DEV_CHANNELS_DIALOG_NEEDLE, byte-identical to
#      tests/fixtures/dev-channels-pane-2.1.120.txt).
#   2. Block on stdin. CSCB's approver sends a bare Enter through
#      `agent-director send-keys` when it sees the needle; Enter arrives here
#      as a line on stdin.
#   3. On that first line, write a minimal transcript JSONL at Claude Code's
#      canonical location and fire every SessionStart hook the `--settings`
#      JSON registers. agent-director derives the row's session_id from the
#      payload's `transcript_path` basename, so a later
#      `claude --resume <session_id>` finds that transcript.
#   4. Print a live-session banner and keep reading stdin, so the process and
#      its tmux pane stay alive. Further lines are ignored.
#   5. On the sentinel line, fire every SessionEnd hook the `--settings` JSON
#      registers and exit.
#
# HOOK FIRING
# -----------
# agent-director applies a hook only when the hook's parent process is the
# pane's recorded main process, so every hook runs as a direct child of this
# script's process: the script runs the hook's argv as a simple command, with
# the payload on stdin by redirect from a file, never through `sh -c`, `eval`,
# a subshell, a pipeline or a command substitution.
#
#   - Every group of the event and every `"type": "command"` entry in it is
#     fired, in the order `--settings` lists them.
#   - An entry with an `args` array (exec form) runs `command` verbatim with
#     those `args`.
#   - An entry with no `args` (shell form) runs the words of its `command`.
#   - An entry's `timeout` is not acted on: each hook runs until it exits.
#   - The payload carries `hook_event_name`, `session_id`, `cwd`,
#     `transcript_path` and `source` (SessionStart) or `reason` (SessionEnd),
#     and no `agent_id`.
#
# The entries are read once, at start-up, into one flat array per event: for
# each entry its argv length, then its argv elements.
#
# RESUME
# ------
# agent-director resume re-execs `claude --resume <session_id> …`. The stub
# reuses that session_id and its transcript, prints the dialog again and
# repeats the handshake, so the approver must answer the resumed launch's
# dialog too.
set -uo pipefail

# ---------------------------------------------------------------------------
# Parse the args we care about: --settings <json> and --resume <session_id>.
# ---------------------------------------------------------------------------
SETTINGS_JSON=""
RESUME_SID=""
prev=""
for arg in "$@"; do
    case "${prev}" in
        --settings) SETTINGS_JSON="${arg}" ;;
        --resume)   RESUME_SID="${arg}" ;;
    esac
    prev="${arg}"
done

# ---------------------------------------------------------------------------
# session_id + transcript path. On a fresh launch, mint a new id; on resume,
# reuse the id agent-director passed. Claude Code stores transcripts at
# ~/.claude/projects/<cwd-with-slashes-and-dots-as-dashes>/<session_id>.jsonl.
# ---------------------------------------------------------------------------
SESSION_ID="${RESUME_SID}"
if [[ -z "${SESSION_ID}" ]]; then
    SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null \
        || python3 -c 'import uuid;print(uuid.uuid4())' 2>/dev/null \
        || echo "11111111-1111-4111-8111-111111111111")"
fi

REALCWD="$(pwd -P)"
PROJ_KEY="$(printf '%s' "${REALCWD}" | sed 's#[/._]#-#g')"
PROJ_DIR="${HOME}/.claude/projects/${PROJ_KEY}"
TRANSCRIPT="${PROJ_DIR}/${SESSION_ID}.jsonl"

ensure_transcript() {
    mkdir -p "${PROJ_DIR}" 2>/dev/null || true
    if [[ ! -f "${TRANSCRIPT}" ]]; then
        # Minimal transcript so `claude --resume` has a file to reference.
        printf '{"type":"summary","summary":"stub-claude session","leafUuid":"%s"}\n' \
            "${SESSION_ID}" > "${TRANSCRIPT}" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# Registered hooks. HOOK_ARGV_JQ emits, for each `"type": "command"` entry of
# event $ev in every group, the entry's argv length and then its argv
# elements, each NUL-terminated. HOOK_FILE holds jq's output while it is read
# into the event's array, and later the payload a hook reads on stdin; it lives
# outside the transcript directory.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016 # $s and $ev are jq variables, not shell ones.
HOOK_ARGV_JQ='
  $s | objects | .hooks | objects | .[$ev] | arrays | .[]
  | objects | .hooks | arrays | .[]
  | objects | select(.type == "command" and (.command | type) == "string")
  | if (.args | type) == "array"
    then [.command] + [.args[] | tostring]
    else [.command | splits("[ \t\n]+") | select(length > 0)]
    end
  | select(length > 0)
  | "\(length)\u0000" + (map(. + "\u0000") | join(""))
'
HOOK_FILE="${TMPDIR:-/tmp}/stub-claude-hook-$$"
START_HOOKS=()
END_HOOKS=()
if [[ -n "${SETTINGS_JSON}" ]]; then
    if jq -nj --argjson s "${SETTINGS_JSON}" --arg ev SessionStart \
        "${HOOK_ARGV_JQ}" > "${HOOK_FILE}" 2>/dev/null; then
        mapfile -d '' -t START_HOOKS < "${HOOK_FILE}"
    fi
    if jq -nj --argjson s "${SETTINGS_JSON}" --arg ev SessionEnd \
        "${HOOK_ARGV_JQ}" > "${HOOK_FILE}" 2>/dev/null; then
        mapfile -d '' -t END_HOOKS < "${HOOK_FILE}"
    fi
    rm -f "${HOOK_FILE}"
fi

# Sentinel line the driver sends via `agent-director send-keys` to request a
# clean session end. Distinct from the bare Enter the dialog approver sends, so
# the resume lap's approval Enter never triggers an exit.
SENTINEL="__CSCB_TEST_EXIT__"

# fire_hooks <len> <argv…> [<len> <argv…> …]
# Runs each argv as a direct child of this process, one after another, with
# HOOK_FILE on stdin. A hook's exit status is not acted on.
fire_hooks() {
    local n
    while (( $# > 0 )); do
        n="$1"
        shift
        if [[ ! "${n}" =~ ^[0-9]+$ ]] || (( n < 1 || n > $# )); then
            return 0
        fi
        "${@:1:n}" < "${HOOK_FILE}" >/dev/null 2>&1
        shift "${n}"
    done
}

fire_session_start() {
    ensure_transcript
    if (( ${#START_HOOKS[@]} > 0 )); then
        printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","transcript_path":"%s","source":"startup"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" > "${HOOK_FILE}" \
            && fire_hooks "${START_HOOKS[@]}"
        rm -f "${HOOK_FILE}"
    fi
}

fire_session_end() {
    if (( ${#END_HOOKS[@]} > 0 )); then
        printf '{"hook_event_name":"SessionEnd","session_id":"%s","cwd":"%s","transcript_path":"%s","reason":"exit"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" > "${HOOK_FILE}" \
            && fire_hooks "${END_HOOKS[@]}"
        rm -f "${HOOK_FILE}"
    fi
}

print_dialog() {
    # MUST stay byte-identical to tests/fixtures/dev-channels-pane-2.1.120.txt.
    cat <<'DIALOG'
WARNING: Loading development channels

--dangerously-load-development-channels is for local channel development only. Do not
use this option to run channels you have downloaded off the internet.

Please use --channels to run a list of approved channels.

Channels: server:slack-channel-router

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
DIALOG
}

print_dialog

# Read loop:
#   - First non-sentinel line = the approver's dialog Enter → fire the
#     SessionStart hooks and show the live banner.
#   - The sentinel line = the driver's clean-exit request → fire the
#     SessionEnd hooks and exit.
#   - Any other line while live is ignored (keeps the pane alive).
approved=0
while IFS= read -r line; do
    if [[ "${line}" == "${SENTINEL}" ]]; then
        fire_session_end
        exit 0
    fi
    if [[ "${approved}" -eq 0 ]]; then
        approved=1
        fire_session_start
        echo "Listening for channel messages from: server:slack-channel-router"
    fi
done

# stdin closed (tmux pane killed) — exit cleanly.
exit 0
