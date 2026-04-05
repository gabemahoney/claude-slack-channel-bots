---
id: b.3hy
type: bee
title: 'Test 2: Session ID discovery after MCP tool call'
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

## Test 2: Session ID discovery after MCP tool call

### Prerequisites
Server from Test 1 must be running. Check it is still alive:
```bash
kill -0 $(cat /tmp/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
```
If not running, fail this test.

### Read sessions.json
Sessions are stored at ~/.claude/channels/slack/sessions.json (the default SLACK_STATE_DIR):
```bash
cat ~/.claude/channels/slack/sessions.json
```

### Check session IDs
The sessions.json should have an entry for channel C_TEST1. The sessionId may be "pending" initially — that's expected. The important thing is the entry exists.

If sessionId is "pending", that means no MCP tool call has been made yet. The session ID gets populated on the first tool call. Check the server log for session launch:
```bash
grep "startupSessionManager" ~/.claude/channels/slack/server.log | tail -5
```

### Pass criteria
- sessions.json exists and contains valid JSON
- There is an entry for channel C_TEST1 (or at least one channel entry)
- The server log shows sessions were launched (startupSessionManager entries)
