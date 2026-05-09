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

# Guard: only relay for bot-managed sessions
if [ -z "${CLAUDE_MANAGED_CHANNEL:-}" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Not a managed Slack session"}}}\n'
  exit 0
fi
CHANNEL="$CLAUDE_MANAGED_CHANNEL"

deny_and_exit() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"%s"}}}\n' "$1"
  exit 0
}

# Read stdin
INPUT=$(cat)

# Extract fields from input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || deny_and_exit "Failed to parse tool_name"
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null) || deny_and_exit "Failed to parse tool_input"

BASE_URL="http://127.0.0.1:${PORT}"

# Phase 1 — Create permission request
PAYLOAD=$(jq -n \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg channel "$CHANNEL" \
  '{tool_name: $tool_name, tool_input: $tool_input, channel: $channel}' 2>/dev/null) || deny_and_exit "Failed to build payload"

RESPONSE=$(curl -s -f -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 10 \
  "${BASE_URL}/permission" 2>/dev/null) || deny_and_exit "Server unreachable"

REQUEST_ID=$(echo "$RESPONSE" | jq -r '.requestId // ""' 2>/dev/null) || deny_and_exit "Failed to parse response"
if [ -z "$REQUEST_ID" ]; then
  deny_and_exit "No requestId in server response"
fi

# Phase 2 — Long-poll loop (curl --max-time 90: 60s server hold + 30s buffer)
while true; do
  POLL_RESPONSE=$(curl -s -f \
    --max-time 90 \
    "${BASE_URL}/permission/${REQUEST_ID}" 2>/dev/null) || deny_and_exit "Server connection lost"

  STATUS=$(echo "$POLL_RESPONSE" | jq -r '.status // ""' 2>/dev/null) || deny_and_exit "Failed to parse response"

  case "$STATUS" in
    "pending")
      # Server is still holding; retry immediately
      continue
      ;;
    "decided")
      BEHAVIOR=$(echo "$POLL_RESPONSE" | jq -r '.decision // ""' 2>/dev/null) || deny_and_exit "Failed to parse decision"
      if [ "$BEHAVIOR" = "allow" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
      else
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied via Slack"}}}\n'
      fi
      exit 0
      ;;
    *)
      # Unknown status — deny to fail closed
      deny_and_exit "Unexpected poll status: $STATUS"
      ;;
  esac
done
