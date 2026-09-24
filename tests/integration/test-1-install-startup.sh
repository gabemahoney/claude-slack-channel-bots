#!/usr/bin/env bash
# Test 1 (b.j9i): install package, start daemon in dry-run, verify startup.
#
# The config is a persona config (b.av2 SR-13.5): persona "alpha" in two
# channels (delivery all, prompts to the first), and the zero-channel persona
# "bravo" with DMs on and prompts to its DM contact. Neither credentials file
# exists: dry run reads no credentials file (SR-3.4). Every `start` runs with
# SLACK_BOT_TOKEN and SLACK_APP_TOKEN unset (AC 47).
#
# Before the main flow, a pre-persona leg starts against a `routes` config in
# its own temp SLACK_STATE_DIR and must fail with the SR-1.7 conversion error.
set -euo pipefail

TEST_NAME="test-1-install-startup"
STATE_DIR="${HOME}/.claude/channels/slack"
LOG="${STATE_DIR}/server.log"
PID_FILE="${STATE_DIR}/server.pid"
CLI="./node_modules/.bin/claude-slack-channel-bots"

# The SR-1.7 conversion error for a "routes" key (src/config.ts
# prePersonaConversionMessage), as the server logs it.
CONVERSION_ERROR='"routes" belongs to the pre-persona configuration shape, which is no longer accepted. The configuration must be converted to personas: rewrite it by hand as a "personas" array. Nothing is converted automatically and the file has not been changed.'

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

cd /test-repo

bun install /tmp/package.tgz >/tmp/bun-install.log 2>&1 \
    || fail "bun install /tmp/package.tgz failed (see /tmp/bun-install.log)"

test -x "${CLI}" \
    || fail "binary ${CLI} not installed or not executable"

# --- Pre-persona leg: a `routes` config must stop `start` ----------------
PRE_STATE_DIR="$(mktemp -d /tmp/test-1-pre-persona.XXXXXX)"
cat > "${PRE_STATE_DIR}/config.json" << 'EOF'
{
  "routes": {
    "C0TEST1": { "cwd": "/tmp/test-repo-a" }
  },
  "bind": "127.0.0.1",
  "port": 3100
}
EOF

set +e
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_STATE_DIR="${PRE_STATE_DIR}" SLACK_DRY_RUN=1 \
    "${CLI}" start > /tmp/test-1-pre-persona.out 2> /tmp/test-1-pre-persona.err
PRE_RC=$?
set -e

[ "${PRE_RC}" -ne 0 ] \
    || fail "pre-persona leg: start exited 0 for a routes config (expected non-zero)"

grep -qF "[slack] Server failed to start (" /tmp/test-1-pre-persona.err \
    || fail "pre-persona leg: start stderr missing '[slack] Server failed to start ('"

grep -qF "[slack] Fatal: configuration error — " /tmp/test-1-pre-persona.err \
    || fail "pre-persona leg: start stderr missing '[slack] Fatal: configuration error — '"

grep -qF "${CONVERSION_ERROR}" /tmp/test-1-pre-persona.err \
    || fail "pre-persona leg: start stderr missing the SR-1.7 conversion error"

test ! -e "${PRE_STATE_DIR}/server.pid" \
    || fail "pre-persona leg: PID file ${PRE_STATE_DIR}/server.pid exists"

# No daemon is serving: nothing else listens on the port before the main start.
if curl -s -o /dev/null --max-time 5 http://127.0.0.1:3100/mcp; then
    fail "pre-persona leg: something is listening on 127.0.0.1:3100 after the failed start"
fi

# --- Main flow: persona config, dry run ----------------------------------
mkdir -p "${STATE_DIR}"
cat > "${STATE_DIR}/config.json" << 'EOF'
{
  "personas": [
    {
      "name": "alpha",
      "credentials_file": "~/.claude/channels/slack/credentials-alpha.json",
      "working_directory": "/tmp/test-repo-a",
      "channels": [
        { "id": "C0TEST1", "delivery": "all" },
        { "id": "C0TEST2", "delivery": "all" }
      ],
      "permission_prompts": "C0TEST1"
    },
    {
      "name": "bravo",
      "credentials_file": "~/.claude/channels/slack/credentials-bravo.json",
      "working_directory": "/tmp/test-repo-b",
      "dm": { "enabled": true, "contact": "U0TEST1" },
      "permission_prompts": "dm"
    }
  ],
  "bind": "127.0.0.1",
  "port": 3100,
  "cozempic_prescription": "standard"
}
EOF

for repo in /tmp/test-repo-a /tmp/test-repo-b; do
    mkdir -p "${repo}"
    git -C "${repo}" init -q
done

env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_DRY_RUN=1 "${CLI}" start \
    || fail "claude-slack-channel-bots start exited non-zero"

sleep 10

test -f "${PID_FILE}" || fail "daemon PID file ${PID_FILE} not written"

PID=$(cat "${PID_FILE}")
kill -0 "${PID}" 2>/dev/null \
    || fail "daemon PID ${PID} from ${PID_FILE} is not a live process"

test -f "${LOG}" || fail "server log ${LOG} not written"

grep -q "\[slack\] Running in dry-run mode" "${LOG}" \
    || fail "server.log missing '[slack] Running in dry-run mode'"

if grep -qE 'Error:|Traceback|Uncaught' "${LOG}"; then
    fail "server.log contains error stack trace"
fi

if grep -qF "${CONVERSION_ERROR}" "${LOG}"; then
    fail "server.log carries the pre-persona leg's conversion error"
fi

curl -sf -X POST \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cscb-test","version":"1.0"}}}' \
    http://127.0.0.1:3100/mcp \
    | grep -q '"result"' \
    || fail "MCP endpoint on 127.0.0.1:3100 did not return a JSON-RPC result"

echo "PASS: ${TEST_NAME}"
