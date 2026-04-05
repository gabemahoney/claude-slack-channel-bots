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
Verify the binary is available:
```bash
./node_modules/.bin/claude-slack-channel-bots --help
```

### Create routing config
Create the state directory and routing.json:
```bash
mkdir -p ~/.claude/channels/slack
cat > ~/.claude/channels/slack/routing.json << 'EOF'
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
```bash
cd /test-repo
SLACK_DRY_RUN=1 nohup ./node_modules/.bin/claude-slack-channel-bots start > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 10
```

### Verify startup
Check that the server started without error:
```bash
cat /tmp/server.log
```
Expected: log contains "[slack] Running in dry-run mode" and no error stack traces.

Check that the MCP endpoint is responding:
```bash
curl -sf http://127.0.0.1:3100/mcp -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"initialize","id":1}' | head -c 200
```

### Pass criteria
- Server process is running (check with `kill -0 $(cat /tmp/server.pid)`)
- Log contains "[slack] Running in dry-run mode"
- MCP endpoint responds on port 3100
