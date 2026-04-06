#!/usr/bin/env bash
# permission-relay.sh - Claude Code PermissionRequest hook
# Implements two-phase long-poll to relay permission decisions via Slack channel server

# Check dependencies
if ! command -v jq &>/dev/null; then
  exit 0
fi
if ! command -v curl &>/dev/null; then
  exit 0
fi

# Read port from config.json, default to 3100
CONFIG_FILE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/config.json"
PORT=3100
if [ -f "$CONFIG_FILE" ]; then
  ROUTED_PORT=$(jq -r '.port // empty' "$CONFIG_FILE" 2>/dev/null) || true
  if [ -n "${ROUTED_PORT:-}" ]; then
    PORT="$ROUTED_PORT"
  fi
fi

# Guard: only relay for bot-managed sessions (server PID check)
HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/is-managed?pid=$PPID" 2>/dev/null) || HTTP_STATUS="000"
if [ "$HTTP_STATUS" != "200" ]; then
  exit 0
fi

# Read stdin
INPUT=$(cat)

# Extract fields from input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null) || exit 0
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null) || exit 0

BASE_URL="http://127.0.0.1:${PORT}"

# Phase 1 — Create permission request
PAYLOAD=$(jq -n \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg cwd "$CWD" \
  '{tool_name: $tool_name, tool_input: $tool_input, cwd: $cwd}' 2>/dev/null) || exit 0

RESPONSE=$(curl -s -f -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 10 \
  "${BASE_URL}/permission" 2>/dev/null) || exit 0

REQUEST_ID=$(echo "$RESPONSE" | jq -r '.requestId // ""' 2>/dev/null) || exit 0
if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Phase 2 — Long-poll loop (curl --max-time 90: 60s server hold + 30s buffer)
while true; do
  POLL_RESPONSE=$(curl -s -f \
    --max-time 90 \
    "${BASE_URL}/permission/${REQUEST_ID}" 2>/dev/null) || exit 0

  STATUS=$(echo "$POLL_RESPONSE" | jq -r '.status // ""' 2>/dev/null) || exit 0

  case "$STATUS" in
    "pending")
      # Server is still holding; retry immediately
      continue
      ;;
    "decided")
      BEHAVIOR=$(echo "$POLL_RESPONSE" | jq -r '.decision // ""' 2>/dev/null) || exit 0
      if [ "$BEHAVIOR" = "allow" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
      else
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied via Slack"}}}\n'
      fi
      exit 0
      ;;
    *)
      # Unknown status — fall through to TUI
      exit 0
      ;;
  esac
done
