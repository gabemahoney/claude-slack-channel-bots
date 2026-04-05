#!/usr/bin/env bash
# AskUserQuestion relay — intercepts via PreToolUse, posts to Slack, returns answer
set -euo pipefail

# Guard: only relay for bot-managed sessions (must be exactly "1", not empty)
if [ "${SLACK_CHANNEL_BOT_SESSION:-}" != "1" ]; then
  exit 0
fi

# Only handle AskUserQuestion
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
if [ "$TOOL_NAME" != "AskUserQuestion" ]; then
  exit 0
fi

# Extract question and options from tool input
QUESTION=$(echo "$INPUT" | jq -r '.tool_input.question // ""' 2>/dev/null) || exit 0
OPTIONS=$(echo "$INPUT" | jq -c '.tool_input.options // []' 2>/dev/null) || exit 0
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null) || exit 0

if [ -z "$QUESTION" ] || [ "$OPTIONS" = "[]" ] || [ -z "$CWD" ]; then
  exit 0
fi

# Read port from config.json
PORT=$(jq -r '.port // 3100' "${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/config.json" 2>/dev/null) || PORT=3100

# Phase 1: POST question to server
RESPONSE=$(curl -s -f -X POST "http://127.0.0.1:${PORT}/ask" \
  -H 'Content-Type: application/json' \
  -d "{\"question\":$(printf '%s' "$QUESTION" | jq -Rs .),\"options\":${OPTIONS},\"cwd\":$(printf '%s' "$CWD" | jq -Rs .)}" \
  2>/dev/null) || exit 0

REQUEST_ID=$(echo "$RESPONSE" | jq -r '.requestId // ""' 2>/dev/null) || exit 0
if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Phase 2: Long-poll for answer
while true; do
  POLL_RESPONSE=$(curl -s -f --max-time 90 "http://127.0.0.1:${PORT}/ask/${REQUEST_ID}" 2>/dev/null) || exit 0

  STATUS=$(echo "$POLL_RESPONSE" | jq -r '.status // ""' 2>/dev/null) || exit 0

  if [ "$STATUS" = "decided" ]; then
    ANSWER=$(echo "$POLL_RESPONSE" | jq -r '.answer // ""' 2>/dev/null) || exit 0
    # Build the answers object: { "question text": "selected answer" }
    ANSWERS_JSON=$(jq -n --arg q "$QUESTION" --arg a "$ANSWER" '{($q): $a}')
    # Allow the tool and provide the answer via updatedInput
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"answers":%s}}}\n' "$ANSWERS_JSON"
    exit 0
  fi
  # status=pending, retry
done
