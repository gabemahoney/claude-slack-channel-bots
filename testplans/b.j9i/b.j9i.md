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

### Create routing config
Create the state directory and config.json (the live filename — `routing.json` is
only a migration source the postinstall renames):
```bash
mkdir -p ~/.claude/channels/slack
cat > ~/.claude/channels/slack/config.json << 'EOF'
{
  "routes": {
    "C_TEST1": { "cwd": "/tmp/test-repo-a" }
  },
  "bind": "127.0.0.1",
  "port": 3100,
  "cozempic_prescription": "standard"
}
EOF
```

Create the test repo with git init:
```bash
mkdir -p /tmp/test-repo-a
git -C /tmp/test-repo-a init
```

### Start server in dry-run mode
The `start` subcommand daemonizes: the parent process forks a detached child and
exits. The child writes its own PID to `~/.claude/channels/slack/server.pid` and
appends all stderr/stdout to `~/.claude/channels/slack/server.log`. So we do NOT
need `nohup`, do NOT shell-redirect stderr, and do NOT trust `$!` — those refer
to the parent which has already exited.
```bash
cd /test-repo
SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start
sleep 10
```

### Verify startup
Check that the daemon started without error:
```bash
cat ~/.claude/channels/slack/server.log
```
Expected: log contains "[slack] Running in dry-run mode" and no error stack traces.

Check that the MCP endpoint is responding:
```bash
curl -sf http://127.0.0.1:3100/mcp -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"initialize","id":1}' | head -c 200
```

### Pass criteria
- Daemon PID file exists and points at a live process:
  `kill -0 $(cat ~/.claude/channels/slack/server.pid)`
- `~/.claude/channels/slack/server.log` contains "[slack] Running in dry-run mode"
- MCP endpoint responds on port 3100
