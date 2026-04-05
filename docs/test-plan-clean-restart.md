# Test Plan: clean_restart Lifecycle

Covers the 30 test cases (T1–T30) defined in the SRD for the `clean_restart` subcommand and its surrounding startup/shutdown lifecycle. Tests are grouped by functional area.

Files under test:
- `src/cli.ts` — `clean_restart` entry point
- `src/session-manager.ts` — per-route startup state machine
- `src/sessions.ts` — `sessions.json` I/O and rotation
- `src/tmux.ts` — tmux operations
- `src/logging.ts` — log capture

---

## Shutdown Tests

### T1: Graceful Exit — All Sessions Respond to /exit

**Preconditions:**
- Two or more routes are configured in `config.json`.
- Each route has an active tmux session with Claude running inside it.
- The server daemon is running.

**Actions:**
1. Invoke `clean_restart`.
2. The shutdown phase sends `/exit` + Enter to every managed tmux session.
3. Poll each session until `isClaudeRunning()` returns false.

**Expected Outcomes:**
- Every session exits cleanly before the `exit_timeout` elapses.
- Each exit event is recorded in `clean_restart.log`.
- No `killSession()` call is made for any route.
- The startup phase proceeds after all sessions are down.

---

### T2: Hung Session — Force-Kill After Timeout

**Preconditions:**
- At least one route has an active Claude session that will not respond to `/exit` (simulate by having the session ignore the command or sleep indefinitely).
- One additional route has a normally-responsive Claude session.

**Actions:**
1. Invoke `clean_restart`.
2. The `/exit` command is sent to both sessions.
3. The hung session's `isClaudeRunning()` polling runs until `exit_timeout` expires.
4. After the timeout, `killSession()` is called on the hung session.

**Expected Outcomes:**
- The hung session is force-killed and the force-kill is logged.
- The responsive session exits cleanly and its normal exit is logged.
- The force-kill of one session does not affect the other session's handling.
- `clean_restart` continues to the startup phase after all sessions are resolved.

---

### T3: Missing Tmux Session

**Preconditions:**
- A route is configured in `config.json`.
- No tmux session exists for that route (`hasSession()` returns false).

**Actions:**
1. Invoke `clean_restart`.
2. The shutdown phase checks `hasSession()` for each route before attempting `/exit`.

**Expected Outcomes:**
- The missing session is logged as skipped.
- No attempt is made to send `/exit` or call `killSession()` for the missing session.
- `clean_restart` proceeds normally to the startup phase.

---

### T4: clean_restart Survives Invoker Death (Integration Test)

**Preconditions:**
- The invoking terminal process (the shell or parent that ran `clean_restart`) is killed mid-run, after the stop phase has begun but before the start phase completes.

**Actions:**
1. Start `clean_restart` in a tmux session.
2. Kill the invoking process.
3. Observe whether `clean_restart` continues running.

**Expected Outcomes:**
- `clean_restart` is not killed by the invoker's death (it runs as its own process, not dependent on the parent's TTY).
- All phases (stop, session exit, start) complete successfully.
- `clean_restart.log` contains entries from all phases.

---

### T5: Stop Escalates to SIGKILL

**Preconditions:**
- The server daemon is running but has been modified to ignore SIGTERM (simulate by catching SIGTERM without exiting).
- `stop_timeout` is set to a short value (e.g., 3 seconds) to keep the test fast.

**Actions:**
1. Invoke `claude-slack-channel-bots stop`.
2. SIGTERM is sent to the server.
3. The stop command waits `stop_timeout` seconds with no exit.
4. SIGKILL is sent.

**Expected Outcomes:**
- SIGKILL is sent after the timeout elapses.
- The daemon process dies after SIGKILL.
- The stop command logs the escalation.

---

### T6: Stop Handles Already-Stopped Server

**Preconditions:**
- No server daemon is currently running.
- `server.pid` either does not exist or contains a PID for a process that is no longer alive.

**Actions:**
1. Invoke `claude-slack-channel-bots stop`.

**Expected Outcomes:**
- The stop command detects the stale or missing PID file.
- It removes the stale PID file silently.
- It returns exit code 0 (clean return, no error).

---

### T7: /exit Sent Atomically

**Preconditions:**
- A route has an active Claude session in tmux.

**Actions:**
1. Invoke `clean_restart`.
2. Inspect the tmux `sendKeys` call made for the session's exit.

**Expected Outcomes:**
- `/exit` and Enter are sent in a single `sendKeys` call, not two separate calls.
- This prevents a race condition where the session could process the keys separately.

---

### T8: Concurrent /exit During Shutdown

**Preconditions:**
- Three or more routes all have active Claude sessions.
- Each session is configured with a different simulated exit latency (e.g., 1 s, 3 s, 5 s).

**Actions:**
1. Invoke `clean_restart`.
2. The shutdown phase fans out `/exit` to all sessions concurrently via `Promise.allSettled`.

**Expected Outcomes:**
- All sessions receive `/exit` at approximately the same time.
- Total shutdown wall-clock time is bounded by the slowest single session, not the sum of all sessions.
- No session waits for another session to finish before receiving `/exit`.

---

### T9: Force-Killed Session — Stale ID in .last Handled on Next Startup

**Preconditions:**
- A route's Claude session was previously force-killed, leaving a stale `sessionId` in `sessions.json.last`.
- The `sessionId` refers to a conversation that no longer exists on disk.

**Actions:**
1. Invoke `claude-slack-channel-bots start` (or `clean_restart`).
2. Startup reads the stale `sessionId` from `sessions.json.last` and attempts `--resume`.
3. `"No conversation found"` is detected in the pane output.
4. The resume attempt fails and the fallback path kicks in.
5. A fresh launch is attempted with no `--resume` flag.

**Expected Outcomes:**
- The fresh fallback launch succeeds.
- A valid `SessionRecord` is written to `sessions.json` with a new `sessionId`.
- The stale ID from `.last` is not carried forward into the new `sessions.json`.

---

## Startup Resume

### T10: Successful Resume from .last

**Preconditions:**
- `sessions.json.last` contains a valid `sessionId` for a route.
- The Claude conversation referenced by `sessionId` exists on disk.
- No tmux session is currently alive for the route.

**Actions:**
1. Start the server.
2. Startup reads the `sessionId` from `.last` and calls `launchSession()` with `--resume <id>`.
3. The session launches and `--resume` skips the safety prompt.
4. Early detection via `isClaudeRunning()` accepts the running session.
5. PID-based session ID discovery reads `~/.claude/sessions/<pid>.json`.

**Expected Outcomes:**
- The session is resumed (not relaunched fresh).
- The discovered `sessionId` from the PID file matches the one passed via `--resume`.
- A `SessionRecord` with the correct `sessionId` is written to `sessions.json`.

---

### T11: Failed Resume, Successful Fresh Fallback

**Preconditions:**
- `sessions.json.last` contains a `sessionId` that refers to a non-existent conversation.
- No tmux session is alive for the route.

**Actions:**
1. Start the server.
2. `launchSession()` is called with `--resume <id>`.
3. `"No conversation found"` appears in the pane.
4. The tmux session is killed and recreated.
5. `launchSession()` is retried with no `--resume` flag.
6. The fresh session starts, acknowledges the safety prompt, and the session ID is discovered via PID.

**Expected Outcomes:**
- The resume failure is detected quickly (fast-fail on the error text in the pane).
- The fresh launch succeeds.
- The `SessionRecord` written to `sessions.json` contains the new `sessionId` from the fresh launch.

---

### T12: Failed Resume, Failed Fresh Fallback

**Preconditions:**
- `sessions.json.last` contains a `sessionId` that refers to a non-existent conversation.
- The Claude binary is broken or unavailable, causing the fresh fallback to also fail.

**Actions:**
1. Start the server.
2. Resume is attempted and fails.
3. The fresh fallback is attempted and also fails (e.g., times out without a prompt).
4. `launchSession()` returns `null`.

**Expected Outcomes:**
- The failure is logged.
- No record is written to `sessions.json` for this route.
- The failure of this route does not block other routes from completing startup.
- The server continues running and handles other routes.

---

### T13: Fresh Launch — No Entry in .last

**Preconditions:**
- `sessions.json.last` does not exist, or exists but has no entry for this route.
- No tmux session is alive for the route.

**Actions:**
1. Start the server.
2. Startup detects no stored `sessionId` for the route.
3. `launchSession()` is called with no `--resume` flag.
4. Claude displays the safety prompt and Enter is sent.
5. Session ID is discovered via PID.

**Expected Outcomes:**
- Claude is launched without `--resume`.
- A new `SessionRecord` is written to `sessions.json` with a fresh `sessionId`.
- The session registers and begins accepting messages.

---

### T14: Claude Running but No Session File After Timeout

**Preconditions:**
- A fresh launch is attempted.
- Claude starts and is detectable via `isClaudeRunning()`, but the PID session file (`~/.claude/sessions/<pid>.json`) never appears within the discovery polling window.

**Actions:**
1. Start the server.
2. `launchSession()` polls for the safety prompt and also attempts PID-based session ID discovery.
3. The total timeout (120 s) elapses without the session file appearing.

**Expected Outcomes:**
- `launchSession()` returns `null`.
- The failure is logged with enough detail to diagnose (e.g., "session file not found after timeout").
- No record is written to `sessions.json` for this route.

---

## Startup Reconnect

### T15: Claude Already Running — Reconnect

**Preconditions:**
- A tmux session exists for the route.
- `isClaudeRunning()` returns true for that session.
- `sessions.json.last` may or may not contain a `sessionId` for the route.

**Actions:**
1. Start the server.
2. Startup detects the running Claude session (reconnect branch).
3. `/mcp reconnect <server-name>` is sent to the tmux session.
4. Session ID is discovered via PID-based lookup.

**Expected Outcomes:**
- Claude is not killed or relaunched.
- The MCP reconnect command is sent to the running session.
- The discovered `sessionId` is written to `sessions.json`.

---

### T16: Claude Running but Session File Missing

**Preconditions:**
- A tmux session exists and `isClaudeRunning()` returns true.
- PID-based session ID discovery fails because `~/.claude/sessions/<pid>.json` does not exist (e.g., Claude was launched without session persistence).

**Actions:**
1. Start the server.
2. The reconnect branch is taken.
3. `/mcp reconnect` is sent.
4. PID discovery polling times out without finding the session file.

**Expected Outcomes:**
- The error is logged.
- No record is written to `sessions.json` for this route.
- The route is effectively offline but the server starts and handles other routes.

---

## Concurrency and Atomicity

### T17: N Sessions Launch Concurrently

**Preconditions:**
- Three or more routes are configured, each requiring a fresh launch.
- Each launch takes a measurable but finite amount of time.

**Actions:**
1. Start the server.
2. All routes are dispatched concurrently via `Promise.allSettled`.
3. Measure total startup wall-clock time.

**Expected Outcomes:**
- All launches proceed in parallel.
- Total startup time is bounded by the slowest single launch, not the sum.
- All sessions appear in the final `sessions.json`.

---

### T18: Atomic sessions.json Write

**Preconditions:**
- Multiple routes are configured and all complete startup successfully.

**Actions:**
1. Start the server.
2. All routes settle (success or failure).
3. `writeSessions()` is called once with the full results map.

**Expected Outcomes:**
- `sessions.json` is written exactly once after all routes settle.
- The file contains records for all successfully launched routes and no partial or intermediate records.
- Individual route completions do not trigger intermediate writes.

---

### T19: sessions.json.last Rotation — File Exists

**Preconditions:**
- `sessions.json` exists from the previous run with valid records.

**Actions:**
1. Start the server.
2. `rotateSessions()` is called as the first action in `main()`.
3. `sessions.json` is renamed to `sessions.json.last`.

**Expected Outcomes:**
- `sessions.json.last` contains the previous run's session records.
- The original `sessions.json` no longer exists before startup writes a new one.
- The rename is atomic (no window where both files are stale or both are missing).

---

### T20: sessions.json.last Rotation — File Doesn't Exist

**Preconditions:**
- `sessions.json` does not exist (first run, or was manually deleted).

**Actions:**
1. Start the server.
2. `rotateSessions()` attempts to rename `sessions.json` → `sessions.json.last`.
3. The rename fails with `ENOENT`.

**Expected Outcomes:**
- The `ENOENT` error is caught and silently ignored.
- Any existing `sessions.json.last` from a prior run is preserved (not deleted).
- Startup continues normally; the startup manager treats the missing file as an empty sessions map.

---

## Mixed Scenarios

### T21: Mixed Resume + Fallback + Reconnect

**Preconditions:**
- Three routes are configured:
  - Route A: has a stored `sessionId` in `.last` and no running tmux session → resume path.
  - Route B: has a stored `sessionId` in `.last`, but the conversation no longer exists, and no running tmux session → failed resume → fresh fallback path.
  - Route C: has a running Claude session in tmux → reconnect path.

**Actions:**
1. Start the server.
2. All three routes are launched concurrently.
3. Route A resumes successfully.
4. Route B's resume fails and the fallback fresh launch succeeds.
5. Route C reconnects to the existing session.

**Expected Outcomes:**
- `sessions.json` contains correct records for all three routes.
- Route A's record has the resumed `sessionId`.
- Route B's record has the new `sessionId` from the fresh launch.
- Route C's record has the `sessionId` discovered from the reconnected session.

---

## Fast-Fail Detection

### T22: Claude Exits Immediately — Fast Failure

**Preconditions:**
- A fresh launch is attempted.
- Claude exits immediately after being launched (e.g., due to a configuration error), before the safety prompt appears.

**Actions:**
1. Start the server.
2. `launchSession()` begins polling for the safety prompt.
3. After `earlyDetectAfterMs` (5 s) have elapsed, each poll also calls `isClaudeRunning()`.
4. `isClaudeRunning()` returns false, indicating Claude has already exited.

**Expected Outcomes:**
- The fast failure is detected within `earlyDetectAfterMs` of the exit occurring.
- `launchSession()` returns `null` promptly rather than waiting the full 120 s timeout.
- The failure is logged.

---

### T23: Bare Bash Prompt Detected

**Preconditions:**
- A `--resume` launch is attempted.
- The Claude session exits unexpectedly and the tmux pane shows a bare shell prompt instead of Claude output.

**Actions:**
1. Start the server.
2. `launchSession()` polls `capturePane()`.
3. A bare bash/shell prompt is detected in the pane output (indicating Claude exited).
4. The resume is treated as a failure.
5. The session is killed, recreated, and a fresh launch is attempted.

**Expected Outcomes:**
- The bare bash prompt detection triggers a relaunch.
- The fresh fallback launch succeeds.
- The `SessionRecord` from the fresh launch is written to `sessions.json`.

---

## Crash Recovery

### T24: Server Crash Before sessions.json Write

**Preconditions:**
- The server starts normally, launches all sessions, but crashes (or is killed) between the point where sessions are live and the point where `writeSessions()` completes.
- The running tmux sessions survive the crash.

**Actions:**
1. Start the server.
2. Crash the server process after sessions are running but before `sessions.json` is written.
3. Restart the server.
4. Startup detects running Claude sessions via `isClaudeRunning()` → reconnect branch.
5. Session IDs are discovered via PID-based lookup.

**Expected Outcomes:**
- The reconnect path recovers the sessions without relaunching them.
- No conversation context is lost (Claude was still running).
- `sessions.json` is written on the new startup with the reconnected records.

---

### T25: Server Crash Before Rotation

**Preconditions:**
- The server has a valid `sessions.json` from the previous run.
- The server starts and crashes before `rotateSessions()` completes (e.g., crashes immediately on startup).

**Actions:**
1. Attempt to start the server; it crashes before rotation.
2. Restart the server normally.
3. `rotateSessions()` runs on the second startup attempt.

**Expected Outcomes:**
- `sessions.json` from the pre-crash run is still valid and readable.
- The second startup rotates it to `sessions.json.last` normally.
- Startup proceeds to read stored IDs from `sessions.json.last` and resume sessions.

---

## Health Check

### T26: Health Check Starts Only After sessions.json Written

**Preconditions:**
- The server is configured with a short `health_check_interval`.
- Multiple routes require time-consuming launches.

**Actions:**
1. Start the server and observe when the health-check poller first fires.
2. Verify whether the health check runs during phases 7–11 (the concurrent route launch phase).

**Expected Outcomes:**
- The health-check poller does not start until after `writeSessions()` completes (phase 12 is complete).
- No health-check ticks fire while routes are still launching.
- This prevents the health check from scheduling redundant restarts for sessions that are still starting up.

---

### T27: Health Check Detects Dead Session After Phase 12

**Preconditions:**
- The server has started normally and `sessions.json` has been written.
- The health-check interval is set to a short value (e.g., 5 s).
- One session's Claude process dies externally after startup (e.g., killed with `kill`), without triggering an MCP disconnect event.

**Actions:**
1. Start the server.
2. Wait for `sessions.json` to be written.
3. Kill the Claude process for one route externally.
4. Wait for the next health-check tick.

**Expected Outcomes:**
- The health-check poller detects `isClaudeRunning()` returning false for the affected route.
- `scheduleRestart()` is called for the dead route.
- The route is relaunched after `session_restart_delay`.
- Other healthy routes are not restarted.

---

## Message Delivery

### T28: Slack Message During Startup Gets "Not Delivered" Reply

**Preconditions:**
- The server is running but a route's session has not yet registered (startup is still in progress).
- A Slack message arrives for the channel associated with the unready route.

**Actions:**
1. Start the server with a slow-starting route.
2. Send a Slack message to the route's channel while the session is still initializing.
3. The router attempts to deliver the message but finds no registered session.

**Expected Outcomes:**
- The message is not silently dropped.
- A "not delivered" (or equivalent) reply is posted back to the Slack channel.
- The server does not crash or enter an error state.
- Once the session registers, subsequent messages are delivered normally.

---

## Logging

### T29: All Lifecycle Events Logged

**Preconditions:**
- `clean_restart.log` and `server.log` are either empty or contain prior entries.
- A full `clean_restart` run is performed with at least two routes (one per path: resume success, reconnect).

**Actions:**
1. Invoke `clean_restart`.
2. After completion, inspect `clean_restart.log` and `server.log`.

**Expected Outcomes:**
- `clean_restart.log` contains timestamped entries for: init, config load, server stop, session exit (per route), server start, and completion.
- `server.log` contains entries for: startup rotation, route launch decisions (resume/reconnect/fresh), session ID discovery, and `sessions.json` write.
- Both files are in append mode — existing prior entries are preserved.
- All timestamps are valid ISO-8601 format.

---

### T30: Logging Works Under Bun

**Preconditions:**
- The server and `clean_restart` command are run under the Bun runtime (not Node.js).
- `initLogging()` has been called with the correct log file path before any logging occurs.

**Actions:**
1. Start the server under Bun.
2. Generate log output via `console.error` and `console.log` calls throughout the lifecycle.
3. Inspect the log file.

**Expected Outcomes:**
- All `console.error` and `console.log` output appears in the log file with timestamps.
- No output is lost due to Bun's direct file-descriptor writes bypassing `process.stderr.write`.
- The override is in effect before any logging calls are made (captured at module load time).
- If a write fails, the fallback to Bun's native console output fires and does not throw.
