#!/usr/bin/env bash
# stub-claude.sh — a fake `claude` binary for the b.vub integration test
# (test-4-resume-dialog).
#
# WHY THIS EXISTS
# ---------------
# b.vub shipped because every integration test ran under SLACK_DRY_RUN=1, so a
# real bot was never spawned, never hit the real --dangerously-load-development-
# channels dialog, and was never resumed. test-4 exercises the real
# agent-director + real tmux spawn/resume path, but we do NOT want to burn the
# live Anthropic API (or depend on a model) just to prove CSCB drives the
# dialog. This stub stands in for `claude` on PATH.
#
# BEHAVIOR (mimics the pre-SessionStart handshake agent-director relies on)
# ------------------------------------------------------------------------
#   1. Print the EXACT dev-channels warning dialog, including the needle
#      "I am using this for local development" that CSCB's approver matches
#      (src/session-manager.ts:DEV_CHANNELS_DIALOG_NEEDLE, kept byte-identical
#      to tests/fixtures/dev-channels-pane-2.1.120.txt).
#   2. Block on stdin. agent-director spawned us inside a tmux pane; CSCB's
#      approvePreSessionDialogs sends a bare Enter via `agent-director send-keys`
#      when it sees the needle. Enter arrives here as a line on stdin.
#   3. On that first line, fire the SessionStart lifecycle hook exactly as real
#      Claude Code would — by extracting the hook command agent-director injected
#      into our own `--settings` arg and piping a SessionStart payload into it.
#      agent-director derives the row's session_id from the hook's
#      `transcript_path` basename, so we write a real (minimal) transcript
#      JSONL at Claude Code's canonical location and point transcript_path at
#      it. That makes a later `claude --resume <session_id>` possible AND flips
#      the agent-director row pending -> waiting.
#   4. Replace the dialog with a live-session banner and keep reading stdin so
#      the process (and its tmux pane) stays alive in the `waiting` state.
#
# RESUME LAP
# ----------
# agent-director resume re-execs `claude --resume <session_id> …`. We detect the
# --resume arg, reuse that session_id (and its existing transcript), re-print the
# dialog, and repeat the handshake. That second lap is the b.vub regression:
# pre-fix, CSCB's resume-success path never ran the approver, so the dialog stuck
# forever and the launcher fell into an ErrTmuxSessionCreate respawn loop.
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
# Extract the SessionStart / SessionEnd hook commands agent-director injected
# into --settings. Firing these is how we deterministically move the AD row
# (pending→waiting on SessionStart, waiting→ended on SessionEnd) — pure DB
# writes, no /proc probe (b.vub: find-missing is unreliable under Linux/gosu).
# ---------------------------------------------------------------------------
START_HOOK_CMD=""
END_HOOK_CMD=""
if [[ -n "${SETTINGS_JSON}" ]]; then
    START_HOOK_CMD=$(printf '%s' "${SETTINGS_JSON}" \
        | jq -r '.hooks.SessionStart[0].hooks[0].command // empty' 2>/dev/null || true)
    END_HOOK_CMD=$(printf '%s' "${SETTINGS_JSON}" \
        | jq -r '.hooks.SessionEnd[0].hooks[0].command // empty' 2>/dev/null || true)
fi

# Sentinel line the driver sends via `agent-director send-keys` to request a
# clean session end. Distinct from the bare Enter the dialog approver sends, so
# the resume lap's approval Enter never triggers an exit.
SENTINEL="__CSCB_TEST_EXIT__"

fire_session_start() {
    ensure_transcript
    if [[ -n "${START_HOOK_CMD}" ]]; then
        printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","transcript_path":"%s","source":"startup"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" \
            | ${START_HOOK_CMD} >/dev/null 2>&1 || true
    fi
}

fire_session_end() {
    if [[ -n "${END_HOOK_CMD}" ]]; then
        printf '{"hook_event_name":"SessionEnd","session_id":"%s","cwd":"%s","transcript_path":"%s","reason":"exit"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" \
            | ${END_HOOK_CMD} >/dev/null 2>&1 || true
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
#   - First non-sentinel line = the approver's dialog Enter → fire SessionStart
#     (row → waiting) and show the live banner.
#   - The sentinel line = the driver's clean-exit request → fire SessionEnd
#     (row → ended, deterministically) and exit.
#   - Any other line while live is ignored (keeps the pane alive at `waiting`).
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
