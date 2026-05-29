---
id: b.3hy
type: bee
title: 'Test 2: Dry-run startup spawn-skip verification'
up_dependencies:
- b.j9i
down_dependencies:
- b.set
parent: null
egg: null
created_at: '2026-04-04T21:36:15.184642'
status: pupa
schema_version: '0.1'
guid: 3hywfx89ra34w1vgokq1z8orjccznbti
---

## Test 2: Dry-run startup spawn-skip verification

### Prerequisites
Server from Test 1 must be running. Check it is still alive using the daemon's
own PID file (CSCB writes it to `~/.claude/channels/slack/server.pid` from inside
the forked child — `/tmp/server.pid` is not used):
```bash
kill -0 $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
```
If not running, fail this test.

### Verify dry-run spawn-skip
Per-channel session state is now owned by agent-director (SR-7.1) — CSCB no
longer maintains its own `sessions.json` registry, and in dry-run mode
`spawnForRoute` is a no-op (the WebClient is not authenticated). Instead of
inspecting a sessions file, verify directly from the server log that the
startup session manager ran and that the spawn was skipped for the configured
route:
```bash
grep "startupSessionManager: 1 route" ~/.claude/channels/slack/server.log
grep "dry-run: skipping spawn for channel=C_TEST1" ~/.claude/channels/slack/server.log
grep "startupSessionManager: complete" ~/.claude/channels/slack/server.log
```

### Pass criteria
- `~/.claude/channels/slack/server.log` contains "startupSessionManager: 1 route(s)"
- `~/.claude/channels/slack/server.log` contains "[slack] dry-run: skipping spawn for channel=C_TEST1"
- `~/.claude/channels/slack/server.log` contains "startupSessionManager: complete"
