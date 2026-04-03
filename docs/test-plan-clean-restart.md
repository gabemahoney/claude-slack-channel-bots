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
- Two or more routes are configured in `routing.json`.
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
- A route is configured in `routing.json`.
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

### T9: Force-Killed Session — Stale JSONL Handled on Next Startup

**Preconditions:**
- A route's Claude session was previously force-killed.
- JSONL files exist on disk for the route's CWD, but the conversation they reference no longer exists in Claude's state.

**Actions:**
1. Invoke `claude-slack-channel-bots start` (or `clean_restart`).
2. `launchSession()` calls `findLatestJsonlSessionId()`, finds a stale JSONL file, and attempts `--resume <id>`.
3. `"No conversation found"` is detected in the pane output.
4. The resume attempt fails and the fallback path kicks in.
5. A fresh launch is attempted with no `--resume` flag.

**Expected Outcomes:**
- The fresh fallback launch succeeds.
- A valid `SessionRecord` is written to `sessions.json`.
- The stale JSONL session ID is not carried forward into `sessions.json`.

---

## Startup Resume

### T10: Successful Resume via JSONL Discovery

**Preconditions:**
- A `.jsonl` file exists in `~/.claude/projects/<slug>/` for the route's CWD.
- The Claude conversation referenced by the JSONL filename UUID exists on disk.
- No tmux session is currently alive for the route.

**Actions:**
1. Start the server.
2. `launchSession()` calls `findLatestJsonlSessionId()`, finds the UUID, and calls Claude with `--resume <id>`.
3. The session launches and `--resume` skips the safety prompt.
4. `isClaudeRunning()` detects Claude running and accepts the session.

**Expected Outcomes:**
- The session is resumed (not relaunched fresh).
- A `SessionRecord` is written to `sessions.json` for the route.

---

### T11: Failed Resume, Successful Fresh Fallback

**Preconditions:**
- A JSONL file exists for the route but refers to a non-existent conversation.
- No tmux session is alive for the route.

**Actions:**
1. Start the server.
2. `launchSession()` finds the JSONL UUID and calls Claude with `--resume <id>`.
3. `"No conversation found"` appears in the pane.
4. The tmux session is killed and recreated.
5. `launchSession()` is retried with no `--resume` flag.
6. The fresh session starts and acknowledges the safety prompt.

**Expected Outcomes:**
- The resume failure is detected quickly (fast-fail on the error text in the pane).
- The fresh launch succeeds.
- A `SessionRecord` is written to `sessions.json` for the route.

---

### T12: Failed Resume, Failed Fresh Fallback

**Preconditions:**
- A JSONL file exists for the route but refers to a non-existent conversation.
- The Claude binary is broken or unavailable, causing the fresh fallback to also fail.

**Actions:**
1. Start the server.
2. Resume is attempted and fails (`"No conversation found"` detected).
3. The fresh fallback is attempted and also fails (e.g., times out without a prompt).
4. `launchSession()` returns `null`.

**Expected Outcomes:**
- The failure is logged.
- No record is written to `sessions.json` for this route.
- The failure of this route does not block other routes from completing startup.
- The server continues running and handles other routes.

---

### T13: Fresh Launch — No JSONL Files

**Preconditions:**
- No `.jsonl` files exist in `~/.claude/projects/<slug>/` for the route's CWD (first run or previously cleaned up).
- No tmux session is alive for the route.

**Actions:**
1. Start the server.
2. `launchSession()` calls `findLatestJsonlSessionId()`, which returns `null`.
3. `launchSession()` is called with no `--resume` flag.
4. Claude displays the safety prompt and Enter is sent.

**Expected Outcomes:**
- Claude is launched without `--resume`.
- A new `SessionRecord` is written to `sessions.json`.
- The session registers and begins accepting messages.

---

### T14: Launch Times Out — Claude Never Starts

**Preconditions:**
- A fresh launch is attempted.
- Claude fails to start (e.g., the binary hangs or is unavailable) — neither the safety prompt nor a running Claude process is detected.

**Actions:**
1. Start the server.
2. `launchSession()` polls `capturePane()` with exponential backoff.
3. The total timeout (120 s) elapses without the safety prompt or `isClaudeRunning()` returning true.

**Expected Outcomes:**
- `launchSession()` returns `null`.
- The timeout is logged.
- No record is written to `sessions.json` for this route.

---

## Startup Reconnect

### T15: Claude Already Running — Reconnect

**Preconditions:**
- A tmux session exists for the route.
- `isClaudeRunning()` returns true for that session.

**Actions:**
1. Start the server.
2. Startup detects the running Claude session (reconnect branch).
3. `/mcp reconnect <server-name>` is sent to the tmux session.

**Expected Outcomes:**
- Claude is not killed or relaunched.
- The MCP reconnect command is sent to the running session.
- A `SessionRecord` with the current timestamp is written to `sessions.json`.

---

### T16: JSONL Directory Does Not Exist — Fresh Launch

**Preconditions:**
- No JSONL project directory exists for the route's CWD (e.g., `~/.claude/projects/<slug>/` is absent).
- No tmux session is alive for the route.

**Actions:**
1. Start the server.
2. `launchSession()` calls `findLatestJsonlSessionId()`.
3. `readdirSync` throws (directory not found); `findLatestJsonlSessionId()` returns `null`.
4. Claude is launched without `--resume`.

**Expected Outcomes:**
- The fresh launch proceeds normally.
- Claude is launched without `--resume`.
- A `SessionRecord` is written to `sessions.json` once Claude is confirmed running.

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
  - Route A: JSONL files exist for the CWD with a valid conversation; no running tmux session → resume path.
  - Route B: JSONL files exist for the CWD but the conversation no longer exists; no running tmux session → failed resume → fresh fallback path.
  - Route C: has a running Claude session in tmux → reconnect path.

**Actions:**
1. Start the server.
2. All three routes are launched concurrently.
3. Route A resumes successfully via JSONL-discovered session ID.
4. Route B's resume fails and the fallback fresh launch succeeds.
5. Route C reconnects to the existing session.

**Expected Outcomes:**
- `sessions.json` contains correct records for all three routes.
- Route A's record reflects the resumed session.
- Route B's record reflects the fresh launch.
- Route C's record reflects the reconnected session.

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
- Startup proceeds normally; session IDs for resume are discovered via JSONL scanning.

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
- `server.log` contains entries for: startup rotation, route launch decisions (resume/reconnect/fresh), JSONL session ID discovery, and `sessions.json` write.
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
