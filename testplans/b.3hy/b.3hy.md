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

Runs only inside the docker CI container (`/ci`), never on a host with a real
CSCB install or against a real HOME. Script: `tests/integration/test-2-dryrun-spawn-skip.sh`.

### Prerequisites
The server from Test 1 must be running with its two-persona config (`alpha`
and `bravo`). Check it is still alive using the daemon's own PID file (CSCB
writes it to `~/.claude/channels/slack/server.pid` from inside the forked
child — `/tmp/server.pid` is not used):
```bash
kill -0 $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
```
If not running, fail this test.

### Verify the persona load and dry-run spawn-skip
Per-persona session state is owned by agent-director, and in dry-run mode
`spawnForPersona` is a no-op (no Slack client exists). Verify from the server
log that the persona config loaded, that the startup session manager ran over
both personas, and that the spawn was skipped for each one, the zero-channel
persona `bravo` included. The log names each persona as `"<name>" (key=<key>)`.
Match the strings literally (`grep -F`):
```bash
LOG=~/.claude/channels/slack/server.log
grep -F '[slack] Loaded persona config: 2 persona(s)' "$LOG"
grep -F '[slack] startupSessionManager: 2 persona(s)' "$LOG"
grep -F '[slack] dry-run: skipping spawn for "alpha" (key=alpha) cwd=/tmp/test-repo-a' "$LOG"
grep -F '[slack] dry-run: skipping spawn for "bravo" (key=bravo) cwd=/tmp/test-repo-b' "$LOG"
```

Check the startup completion line in parts, so a count added to it later does
not break the test. Take the last line containing
`[slack] startupSessionManager: complete — 2 persona(s):`; it must contain
`2 no-op`, `0 failed` and `0 not brought up`, each preceded by `:` or `,` plus
a space and followed by `,` or the end of the line:
```bash
complete_line="$(grep -F '[slack] startupSessionManager: complete — 2 persona(s):' "$LOG" | tail -n 1)"
for part in '2 no-op' '0 failed' '0 not brought up'; do
    case "$complete_line" in
        *[:,]" $part,"* | *[:,]" $part") echo "ok: $part" ;;
        *) echo "missing: $part" ;;
    esac
done
```

### Verify `/interject` status codes
POST to `/interject` on the daemon's port and read the HTTP status only. Each
call times out after 10 seconds; a call that gets no HTTP response (refused or
timed out) reads as status `000`, so the test fails with
`returned 000, expected …` rather than stopping early:
```bash
interject_status() {
    curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -d "{\"persona\": \"$1\", \"message\": \"test-2 interject\"}" \
        http://127.0.0.1:3100/interject || true
}
interject_status no_such_persona   # expect 404: no such persona
interject_status alpha             # expect 503: known persona, no connected session (dry run launches none)
```

### Pass criteria
- `~/.claude/channels/slack/server.log` contains `[slack] Loaded persona config: 2 persona(s)`
- `~/.claude/channels/slack/server.log` contains `[slack] startupSessionManager: 2 persona(s)`
- `~/.claude/channels/slack/server.log` contains `[slack] dry-run: skipping spawn for "alpha" (key=alpha) cwd=/tmp/test-repo-a`
- `~/.claude/channels/slack/server.log` contains `[slack] dry-run: skipping spawn for "bravo" (key=bravo) cwd=/tmp/test-repo-b`
- The last `~/.claude/channels/slack/server.log` line containing `[slack] startupSessionManager: complete — 2 persona(s):` contains `2 no-op`, `0 failed` and `0 not brought up`, each after `:` or `,` and followed by `,` or the end of the line
- `/interject` with `"persona": "no_such_persona"` returns 404
- `/interject` with `"persona": "alpha"` returns 503
