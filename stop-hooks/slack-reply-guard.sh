#!/usr/bin/env bash
# stop-hooks/slack-reply-guard.sh — Claude Code Stop hook that blocks a turn
# from ending when the most recent real user message came from Slack (rendered
# via the <channel source="slack" ...> wrapper) but the assistant did not call
# the mcp__slack-channel-router__reply tool afterwards.
#
# Fail-open: any error, missing input, malformed transcript, or missing jq
# results in exit 0. The ONLY exit-2 path is a Slack-originated latest real
# user message with no subsequent matching tool_use and stop_hook_active=false.
#
# Input (stdin, single read): JSON from the Claude Code Stop hook harness with
# at minimum session_id, transcript_path, stop_hook_active.
#
# SPDX-License-Identifier: MIT

set -u

# --- 1. Read stdin exactly once. --------------------------------------------
INPUT="$(cat)" || exit 0
[ -n "${INPUT}" ] || exit 0

# --- 2. jq is required for transcript parsing. Fail open if absent. ---------
if ! command -v jq >/dev/null 2>&1; then
  echo "slack-reply-guard: jq not found on PATH; failing open" >&2
  exit 0
fi

# --- 3. Extract the three fields we care about. -----------------------------
STOP_HOOK_ACTIVE="$(printf '%s' "${INPUT}" | jq -r '.stop_hook_active // false' 2>/dev/null)" || exit 0
if [ "${STOP_HOOK_ACTIVE}" = "true" ]; then
  # One-retry-loop protection: never block a retry.
  exit 0
fi

TRANSCRIPT_PATH="$(printf '%s' "${INPUT}" | jq -r '.transcript_path // ""' 2>/dev/null)" || exit 0
[ -n "${TRANSCRIPT_PATH}" ] || exit 0
[ -r "${TRANSCRIPT_PATH}" ] || exit 0
[ -s "${TRANSCRIPT_PATH}" ] || exit 0

# --- 4. Single-pass jq program. ---------------------------------------------
# Reads the transcript exactly once. Emits one line:
#   VIOLATION   — Slack-originated latest real user msg, no reply tool_use after
#   OK          — anything else (non-Slack, reply present, no real user msg, etc.)
# Malformed / partially-broken transcripts fall through to OK (fail open).
#
# "Real user message" = type=="user", isSidechain != true, message.content has
# at least one text block (a plain-string content counts as text). tool_result-
# only entries and sidechain entries are skipped and do NOT displace an earlier
# real user message as the trigger.
#
# Slack-origination predicate = concatenated text contains the substring
# `<channel source="slack"` (prefix match; tolerant of attributes after).
#
# Reply predicate = later assistant entry has a content block with
# type=="tool_use" and name=="mcp__slack-channel-router__reply".
JQ_OUT="$(jq -rRn '
  # Read the JSONL transcript once via `inputs`; drop unparseable lines and
  # any non-object entries (transcripts contain "last-prompt", "mode",
  # "permission-mode", attachment entries, etc.).
  def entries: map(select(type == "object"));

  def text_of_content:
    if type == "string" then .
    elif type == "array" then
      [ .[]
        | select(type == "object")
        | if (.type // "") == "text" then (.text // "")
          else empty
          end
      ] | join("\n")
    else "" end;

  def is_real_user:
    (.type // "") == "user"
    and (.isSidechain != true)
    and ((.message // {}) | type == "object")
    and (((.message.content // null) | text_of_content) | length > 0);

  def is_reply_tool_use:
    (.type // "") == "assistant"
    and ((.message // {}) | type == "object")
    and ((.message.content // []) | type == "array")
    and (
      (.message.content // [])
      | any(
          (type == "object")
          and ((.type // "") == "tool_use")
          and ((.name // "") == "mcp__slack-channel-router__reply")
        )
    );

  ( [ inputs | (fromjson? // empty) ] | entries ) as $es
  | ( [ range(0; $es | length) | . as $i | select($es[$i] | is_real_user) ] ) as $user_idx
  | if ($user_idx | length) == 0 then "OK"
    else
      ($user_idx[-1]) as $trigger
      | ($es[$trigger].message.content | text_of_content) as $txt
      | if ($txt | contains("<channel source=\"slack\"")) then
          if any($es[($trigger + 1):][]; is_reply_tool_use) then "OK"
          else "VIOLATION"
          end
        else "OK"
        end
    end
' "${TRANSCRIPT_PATH}" 2>/dev/null)" || exit 0

# --- 5. Emit result. --------------------------------------------------------
if [ "${JQ_OUT}" = "VIOLATION" ]; then
  echo "Slack user is waiting for a reply. You must respond by calling the mcp__slack-channel-router__reply tool before ending your turn." >&2
  exit 2
fi

exit 0
