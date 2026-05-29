---
id: b.set
type: bee
title: 'Test 3: Cozempic availability and clean server restart'
up_dependencies:
- b.3hy
parent: null
egg: null
created_at: '2026-04-04T21:36:24.881785'
status: pupa
schema_version: '0.1'
guid: setkutjznmwpgemdxschnjtrhqz23kun
---

## Test 3: Cozempic availability and clean server restart

### Prerequisites
Server from Test 1 must be running. Test 2 must have passed.

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
Use the CLI's own `stop` subcommand — it reads the daemon PID from
`~/.claude/channels/slack/server.pid` (the only authoritative location) and
sends SIGTERM, polling until exit:
```bash
./node_modules/.bin/claude-slack-channel-bots stop
sleep 3
```

### Restart server in dry-run mode
```bash
cd /test-repo
SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start
sleep 15
```

### Verify cozempic was probed during startup
`checkCozempicAvailable` runs at the top of `startupSessionManager` on every
boot. In dry-run mode `spawnForRoute` is a no-op so no JSONL files are produced
or cleaned, but the availability probe still logs:
```bash
grep -i cozempic ~/.claude/channels/slack/server.log | tail -5
```
Expected: log contains "[slack] cozempic available" (or, if cozempic was
missing from PATH, the "cozempic not found on PATH" warning — both are valid
evidence that the probe ran).

### Verify server restarted cleanly
```bash
tail -5 ~/.claude/channels/slack/server.log
kill -0 $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
```

### Pass criteria
- Server restarted without an error stack trace
- Daemon process is alive (`kill -0 $(cat ~/.claude/channels/slack/server.pid)`)
- Server log shows "Running in dry-run mode" after the restart
- Server log contains a cozempic probe entry ("cozempic available" or "cozempic not found on PATH")
