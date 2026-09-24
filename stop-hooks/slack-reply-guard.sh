#!/usr/bin/env bash
# stop-hooks/slack-reply-guard.sh — Claude Code Stop hook that gives a bot a
# one-time reminder to answer in Slack. It fires when the messages that started
# the turn include a delivered Slack message (rendered with a
# <channel source="slack..." ...> envelope at the start of its content, e.g.
# source="slack" or source="slack-channel-router") but the assistant did not
# call the mcp__slack-channel-router__reply tool afterwards.
#
# The reminder is declinable, not a mandate: it states how the message reached
# the bot (its provenance, picked by `via` — see section 4) and tells the bot it
# may simply end the turn when no reply is needed. The five provenance kinds:
#   dm                  — a direct message
#   mention             — a direct @mention in a channel
#   broadcast           — an @here or @channel broadcast in a channel
#   receive_all_shared  — a channel where this bot and other personas receive
#                         every message
#   receive_all         — a channel where only this bot receives every message
# Any other `via` falls back to a generic channel wording. It is shown at most
# once per turn — the retry the harness runs after an exit 2 carries
# stop_hook_active=true, which always exits 0.
#
# Only delivered Slack messages trigger the reminder. The server gives every
# message it delivers from Slack a `via` attribute naming why it was delivered;
# injected prompts (scheduled prompts and /interject messages) reach the bot in
# the same envelope but never carry `via`, and there is no Slack conversation
# waiting on them. Every `via` value can trigger the reminder; none is exempt.
# An injected message delivered right after a delivered one does not hide the
# delivered one.
#
# Fail-open: any error, missing input, malformed transcript, or missing jq
# results in exit 0. The ONLY exit-2 path is a trigger run (see section 4)
# containing a delivered Slack envelope (one carrying `via`), with no matching
# tool_use after the earliest such message and stop_hook_active=false.
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
#   VIOLATION <kind> <chat_id>   — reminder due; <kind> is the provenance
#   VIOLATION <kind>             — reminder due; chat_id absent or not a Slack id
#   OK                           — anything else (non-Slack, injected, reply
#                                  present, no real user msg, etc.)
# <kind> is one of the fixed tokens dm, mention, broadcast, receive_all_shared,
# receive_all or channel (any other `via`); the raw `via` value is never
# emitted.
# Malformed / partially-broken transcripts fall through to OK (fail open).
#
# "Real user message" = type=="user", isSidechain != true,
# isCompactSummary != true, message.content has at least one text block (a
# plain-string content counts as text). tool_result-only entries, sidechain
# entries, and compaction summaries are skipped and never count as the
# trigger. A compaction summary is not a message from Slack, and the
# transcript keeps the pre-compaction entries, so the trigger falls back to the
# actual last real user message.
#
# Trigger run = the real user messages that started the turn. Claude Code can
# write queued channel messages as consecutive user entries with no assistant
# entry between them, so the latest real user message alone is not enough: an
# injected prompt delivered right after a human's Slack message would hide it.
# Walking back from the latest real user message, the run collects every real
# user message up to the first non-sidechain assistant entry. Other entries
# (attachments, system entries, tool_result-only user entries, sidechain
# entries, compaction summaries) neither join nor end the run.
#
# Envelope = the opening `<channel …>` tag at the very start of a message's
# text (after optional leading whitespace). Only a tag in that position counts:
# the harness always puts the envelope first, so a `<channel …>` tag anywhere
# else is text quoted inside the message body and is ignored. That includes a
# Slack tag quoted by a plain message or by another channel plugin's envelope
# (e.g. source="telegram"). A Slack envelope is one whose `source` attribute
# starts with `slack` (covers the legacy `source="slack"` form and the on-wire
# `source="slack-channel-router"` form). Attributes are read by name, so their
# order does not matter.
#
# Delivered envelope = a Slack envelope that carries a `via` attribute, whatever
# its value (an empty or unrecognised `via` still counts). A Slack envelope
# without `via` is injected and never counts, whatever its `user` or `ts`
# looks like.
#
# Reminder due = at least one message in the trigger run has a delivered Slack
# envelope, and no reply tool_use exists after the earliest such message. A run
# of only injected or non-Slack messages is OK.
#
# Provenance comes from the `via` and `chat_id` of the LAST delivered Slack
# envelope in the run. `via` alone picks the wording:
#   dm                  — a direct message
#   mention             — a direct @mention in a channel
#   broadcast           — an @here or @channel broadcast in a channel
#   receive_all_shared  — a channel where this bot and other personas receive
#                         every message
#   receive_all         — a channel where only this bot receives every message
#   anything else       — the generic channel wording (empty included)
# When chat_id matches ^[A-Z0-9]+$ the wording names the conversation
# ("conversation <id>" for dm, "channel <id>" otherwise); when it is absent or
# does not match, the wording omits it.
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
    and (.isCompactSummary != true)
    and ((.message // {}) | type == "object")
    and (((.message.content // null) | text_of_content) | length > 0);

  # An assistant entry of the main conversation; it ends the trigger run.
  def is_main_assistant:
    (.type // "") == "assistant" and (.isSidechain != true);

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

  # Value of attribute $name in an opening tag, or null when absent (the first
  # one wins if a name repeats). The tag is split into whitespace-led
  # name="value" pairs left to right and the name is compared whole, so a name
  # never matches inside a longer one (`ts` inside `thread_ts`, `via` inside
  # e.g. `x_via`), and text inside another attribute value (a sender label
  # such as `x via=`) is consumed as that value, never read as an attribute.
  def attr($name):
    first(scan("\\s([^\\s=\"]+)=\"([^\"]*)\"") | select(.[0] == $name) | .[1])
    // null;

  # The opening <channel …> tag at the start of the text (after optional
  # leading whitespace) when its source attribute starts with "slack", else
  # null. \A anchors to the start of the whole text, never of a later line.
  # Tags anywhere else are quoted body text and are never looked at.
  def slack_envelope:
    ((capture("\\A\\s*(?<tag><channel\\s[^>\n]*>)") | .tag) // null) as $t
    | if $t != null and (($t | attr("source") // "") | startswith("slack"))
      then $t else null end;

  # A delivered Slack envelope carries `via`; an empty value is still present.
  def is_delivered: attr("via") != null;

  # Reminder token for an envelope: a fixed provenance kind (the raw `via` is
  # never passed through) plus the chat_id when it is a Slack id.
  def verdict:
    attr("via") as $via
    | attr("chat_id") as $chat
    | (if ($via == "dm" or $via == "mention" or $via == "broadcast"
           or $via == "receive_all_shared" or $via == "receive_all")
       then $via else "channel" end) as $kind
    | if $chat == null or ($chat | test("^[A-Z0-9]+$") | not) then "VIOLATION \($kind)"
      else "VIOLATION \($kind) \($chat)"
      end;

  ( [ inputs | (fromjson? // empty) ] | entries ) as $es
  | ( [ range(0; $es | length) | . as $i | select($es[$i] | is_real_user) ] ) as $user_idx
  | if ($user_idx | length) == 0 then "OK"
    else
      ($user_idx[-1]) as $last
      # Index of the nearest main assistant entry before the latest real user
      # message (-1 when none); the trigger run is every real user message
      # after it.
      | (first(range($last - 1; -1; -1) | select($es[.] | is_main_assistant)) // -1) as $start
      # Delivered Slack messages in the run, oldest first.
      | [ $user_idx[]
          | select(. > $start)
          | { i: ., w: ($es[.].message.content | text_of_content | slack_envelope) }
          | select(.w != null and (.w | is_delivered))
        ] as $delivered
      | if ($delivered | length) == 0 then "OK"
        elif any($es[($delivered[0].i + 1):][]; is_reply_tool_use) then "OK"
        else $delivered[-1].w | verdict
        end
    end
' "${TRANSCRIPT_PATH}" 2>/dev/null)" || exit 0

# --- 5. Emit result. --------------------------------------------------------
REMINDER_TAIL="and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn."

case "${JQ_OUT}" in
  "VIOLATION "*) ;;
  *) exit 0 ;;
esac

# Split "VIOLATION <kind> [<chat_id>]"; jq only emits a chat_id that matches
# ^[A-Z0-9]+$, so it never contains a space.
VERDICT="${JQ_OUT#VIOLATION }"
KIND="${VERDICT%% *}"
CHAT_ID=""
[ "${KIND}" = "${VERDICT}" ] || CHAT_ID="${VERDICT#* }"

# Fixed provenance wordings; dm names a conversation, the others a channel.
CONVERSATION_LABEL="channel"
case "${KIND}" in
  dm)
    PROVENANCE="This turn started from a Slack direct message"
    CONVERSATION_LABEL="conversation"
    ;;
  mention)
    PROVENANCE="This turn started from a Slack message that @mentioned you directly"
    ;;
  broadcast)
    PROVENANCE="This turn started from an @here or @channel broadcast in a Slack channel"
    ;;
  receive_all_shared)
    PROVENANCE="This turn started from a message in a Slack channel where you and other personas receive every message"
    ;;
  receive_all)
    PROVENANCE="This turn started from a message in a Slack channel where only you receive every message"
    ;;
  channel)
    PROVENANCE="This turn started from a Slack channel message"
    ;;
  *)
    exit 0
    ;;
esac

if [ -n "${CHAT_ID}" ]; then
  PROVENANCE="${PROVENANCE} (${CONVERSATION_LABEL} ${CHAT_ID})"
fi

echo "${PROVENANCE} ${REMINDER_TAIL}" >&2
exit 2
