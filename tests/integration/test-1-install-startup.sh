#!/usr/bin/env bash
# Test 1 (b.j9i): install package, start daemon in dry-run, verify startup.
set -euo pipefail

TEST_NAME="test-1-install-startup"
LOG="${HOME}/.claude/channels/slack/server.log"
PID_FILE="${HOME}/.claude/channels/slack/server.pid"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

cd /test-repo

bun install /tmp/package.tgz >/tmp/bun-install.log 2>&1 \
    || fail "bun install /tmp/package.tgz failed (see /tmp/bun-install.log)"

test -x ./node_modules/.bin/claude-slack-channel-bots \
    || fail "binary ./node_modules/.bin/claude-slack-channel-bots not installed or not executable"

mkdir -p "${HOME}/.claude/channels/slack"
cat > "${HOME}/.claude/channels/slack/config.json" << 'EOF'
{
  "routes": {
    "C_TEST1": { "cwd": "/tmp/test-repo-a" }
  },
  "bind": "127.0.0.1",
  "port": 3100,
  "cozempic_prescription": "standard"
}
EOF

mkdir -p /tmp/test-repo-a
git -C /tmp/test-repo-a init -q

SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start \
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

curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"initialize","id":1}' \
    http://127.0.0.1:3100/mcp \
    | grep -q '"result"' \
    || fail "MCP endpoint on 127.0.0.1:3100 did not return a JSON-RPC result"

echo "PASS: ${TEST_NAME}"
