---
id: b.set
type: bee
title: 'Test 3: Cozempic cleaning and session resume after restart'
up_dependencies:
- b.3hy
parent: null
egg: null
created_at: '2026-04-04T21:36:24.881785'
status: pupa
schema_version: '0.1'
guid: setkutjznmwpgemdxschnjtrhqz23kun
---

## Test 3: Cozempic cleaning and session resume after restart

### Prerequisites
Server from Test 1 must be running. Sessions from Test 2 must exist.

### Check cozempic is available
```bash
which cozempic && cozempic --version
```
If cozempic is not found, fail this test.

### Record server log state
```bash
wc -l ~/.claude/channels/slack/server.log
```

### Stop server
```bash
kill $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null || true
sleep 3
```

### Restart server (cozempic runs before --resume on startup)
```bash
cd /test-repo
SLACK_DRY_RUN=1 nohup ./node_modules/.bin/claude-slack-channel-bots start > /tmp/server-restart.log 2>&1 &
echo $! > /tmp/server.pid
sleep 15
```

### Verify cozempic ran
Check restart log for cozempic activity:
```bash
cat ~/.claude/channels/slack/server.log | grep -i cozempic
```
If sessions had JSONL files, expected: log shows "cozempic: cleaning started" or "cozempic not found on PATH" (warning is OK if no JSONL exists to clean).

### Verify server restarted
```bash
cat /tmp/server-restart.log | tail -5
kill -0 $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
```

### Pass criteria
- Server restarted without errors
- Server process is alive after restart
- Server log shows dry-run mode on restart
- If session JSONL files existed, cozempic cleaning entries appear in log (or warning that cozempic was not found)
