---
id: b.j9i
type: bee
title: 'Test 1: Package install and server startup in dry-run mode'
down_dependencies:
- b.3hy
parent: null
egg: null
created_at: '2026-04-04T21:36:06.958341'
status: pupa
schema_version: '0.1'
guid: j9ieuurbhzsbscd8ag78yx3cb2pbrqfu
---

## Test 1: Package install and server startup in dry-run mode

Runs only inside the docker CI container (`/ci`), never on a host with a real
CSCB install or against a real HOME. Script: `tests/integration/test-1-install-startup.sh`.

The config is a dry-run persona config. No token variable is set: every
`start` runs with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` unset. In dry run no
credentials file is read, so the credentials files the config names are never
created.

### Setup
Install the package from the pre-built tarball:
```bash
cd /test-repo
bun install /tmp/package.tgz
```
Verify the binary was installed:
```bash
test -x ./node_modules/.bin/claude-slack-channel-bots && echo "binary OK"
```

### Pre-persona leg: a `routes` config stops `start`
Write a pre-persona config into its own temp state directory, so the main
state directory is never touched:
```bash
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
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_STATE_DIR="${PRE_STATE_DIR}" SLACK_DRY_RUN=1 \
    ./node_modules/.bin/claude-slack-channel-bots start > /tmp/test-1-pre-persona.out 2> /tmp/test-1-pre-persona.err
echo "exit=$?"
```

Expected:
- `start` exits non-zero.
- `/tmp/test-1-pre-persona.err` contains each of these strings (match with `grep -F`):
  - `[slack] Server failed to start (`
  - `[slack] Fatal: configuration error — `
  - `"routes" belongs to the pre-persona configuration shape, which is no longer accepted. The configuration must be converted to personas: rewrite it by hand as a "personas" array. Nothing is converted automatically and the file has not been changed.`
- `${PRE_STATE_DIR}/server.pid` does not exist.
- Nothing answers on `http://127.0.0.1:3100/mcp` (`curl -s -o /dev/null --max-time 5` fails).

### Create the persona config
Create the state directory and `config.json`. Persona `alpha` is in two
channels with `delivery: all` and takes its prompts in the first. Persona
`bravo` has no channels, DMs on, a DM contact and a `dm` destination. The two
working directories differ:
```bash
mkdir -p ~/.claude/channels/slack
cat > ~/.claude/channels/slack/config.json << 'EOF'
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
```

Create both working directories as git repos:
```bash
for repo in /tmp/test-repo-a /tmp/test-repo-b; do
    mkdir -p "${repo}"
    git -C "${repo}" init -q
done
```

### Start server in dry-run mode
The `start` subcommand daemonizes: the parent process forks a detached child and
exits. The child writes its own PID to `~/.claude/channels/slack/server.pid` and
appends all stderr/stdout to `~/.claude/channels/slack/server.log`. So we do NOT
need `nohup`, do NOT shell-redirect stderr, and do NOT trust `$!` — those refer
to the parent which has already exited.
```bash
cd /test-repo
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start
sleep 10
```
`start` must exit 0.

### Verify startup
Check that the daemon started without error:
```bash
cat ~/.claude/channels/slack/server.log
```
Expected: the log contains "[slack] Running in dry-run mode", no line matching
`Error:|Traceback|Uncaught`, and not the pre-persona leg's conversion error.

Check that the MCP endpoint is responding. The server uses `StreamableHTTPServerTransport`, which requires both an `Accept: application/json, text/event-stream` header AND a `params` block on `initialize` (protocolVersion, capabilities, clientInfo). Without them the server returns HTTP 406 or a "Server not initialized" error.
```bash
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cscb-test","version":"1.0"}}}' \
  http://127.0.0.1:3100/mcp | grep -q '"result"' && echo "MCP OK"
```

### Pass criteria
- Pre-persona leg: `start` exits non-zero, its stderr carries the three strings above, no PID file is written in the temp state directory, and nothing listens on port 3100 afterwards
- Persona config: `start` with both token variables unset exits 0
- Daemon PID file exists and points at a live process:
  `kill -0 $(cat ~/.claude/channels/slack/server.pid)`
- `~/.claude/channels/slack/server.log` contains "[slack] Running in dry-run mode", no error stack trace and no conversion error
- MCP `initialize` on port 3100 returns a JSON-RPC `result`
