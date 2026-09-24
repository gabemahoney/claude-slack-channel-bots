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

Runs only inside the docker CI container (`/ci`), never on a host with a real
CSCB install or against a real HOME. Script: `tests/integration/test-3-cozempic-restart.sh`.

### Prerequisites
Server from Test 1 must be running with its two-persona config. Test 2 must have passed.

### Check cozempic is available
```bash
command -v cozempic && cozempic --version
```
If cozempic is not found, or `--version` fails, fail this test.

### Record the spawn-skip lines before the restart
The log is appended across boots. Count each persona's spawn-skip line now, so
the restart's own lines can be told apart:
```bash
LOG=~/.claude/channels/slack/server.log
SKIP_ALPHA='[slack] dry-run: skipping spawn for "alpha" (key=alpha) cwd=/tmp/test-repo-a'
SKIP_BRAVO='[slack] dry-run: skipping spawn for "bravo" (key=bravo) cwd=/tmp/test-repo-b'
ALPHA_BEFORE=$(grep -cF "$SKIP_ALPHA" "$LOG")
BRAVO_BEFORE=$(grep -cF "$SKIP_BRAVO" "$LOG")
```

### Stop server and bots
Use the CLI's `stop --stop-bots`. It stops the daemon named in
`~/.claude/channels/slack/server.pid`, then reads the persona config from the
path the server loads and tears down each persona's instance `cscb_<key>`. Dry
run never spawned one, so it reports no spawn row for each persona:
```bash
cd /test-repo
./node_modules/.bin/claude-slack-channel-bots stop --stop-bots > /tmp/test-3-stop.out 2>&1
echo "exit=$?"
sleep 3
```
Expected: exit 0, and `/tmp/test-3-stop.out` contains both of these lines (`grep -F`):
```
[slack] teardownBots: no spawn row for persona "alpha" (key=alpha) — skipping
[slack] teardownBots: no spawn row for persona "bravo" (key=bravo) — skipping
```

### Restart server in dry-run mode
Restart with both token variables unset:
```bash
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start
sleep 15
```
`start` must exit 0.

### Verify cozempic was probed during startup
`checkCozempicAvailable` runs at the top of `startupSessionManager` on every
boot. In dry-run mode `spawnForPersona` is a no-op so no JSONL files are produced
or cleaned, but the availability probe still logs:
```bash
grep -E "cozempic (available|not found on PATH)" "$LOG" | tail -5
```
Expected: log contains "[slack] cozempic available" (or, if cozempic was
missing from PATH, the "cozempic not found on PATH" warning — both are valid
evidence that the probe ran).

### Verify server restarted cleanly
```bash
tail -5 "$LOG"
kill -0 $(cat ~/.claude/channels/slack/server.pid 2>/dev/null) 2>/dev/null && echo "server running" || echo "server not running"
[ "$(grep -cF "$SKIP_ALPHA" "$LOG")" -gt "$ALPHA_BEFORE" ] && echo "alpha skipped again"
[ "$(grep -cF "$SKIP_BRAVO" "$LOG")" -gt "$BRAVO_BEFORE" ] && echo "bravo skipped again"
```

### Pass criteria
- `stop --stop-bots` exits 0 and names both personas in a `no spawn row for persona` line
- The restart `start`, with both token variables unset, exits 0
- Daemon process is alive (`kill -0 $(cat ~/.claude/channels/slack/server.pid)`)
- Server log shows "[slack] Running in dry-run mode" and no line matching `Error:|Traceback|Uncaught`
- Server log contains a cozempic probe entry ("cozempic available" or "cozempic not found on PATH")
- Each persona's spawn-skip line appears more times than before the restart
