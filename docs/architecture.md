# Internal Architecture

## System Overview

The Slack Channel Router is a two-way bridge between Slack and Claude Code sessions via Socket Mode + MCP HTTP (StreamableHTTP). Each Claude Code session connects to its own MCP Server instance, assigned to a Slack channel via routing config.

## Module Map

```
cli.ts                  CLI entry point for the claude-slack-channel-bots command, dispatches start/stop/clean_restart subcommands, performs prerequisite checks, thin wrapper around server.ts main()
└── server.ts           Main entry point — HTTP server, Socket Mode, session lifecycle, message routing
    ├── config.ts           Routing configuration — load, validate, defaults, tilde expansion
    ├── registry.ts         Session registry — pending/registered sessions, MCP Server factory, transport routing
    ├── lib.ts              Pure utilities — gate, access control, chunking, sanitization
    ├── logging.ts          Log file setup — overrides console.error/console.log with timestamped writeSync to a log file
    ├── session-manager.ts  Startup orchestration — per-route state detection, kill/relaunch logic
    ├── restart.ts          Auto-restart — delayed relaunch on disconnect, failure counting, timer cancellation
    ├── health-check.ts     Periodic liveness poller — checks routes on a timer, schedules restarts for dead sessions
    ├── tmux.ts             TmuxClient interface and defaultTmuxClient — tmux shell ops, isClaudeRunning
    ├── sessions.ts         sessions.json I/O — readSessions/writeSessions, SessionRecord, SessionsMap
    ├── pid.ts              PID file management — write, read, conflict detection, isProcessRunning
    ├── peer-pid.ts         Post-call session ID discovery — getPeerPidByPort (ss -tnp) + getSessionIdForPid (~/.claude/sessions/<pid>.json)
    ├── cozempic.ts         Optional cozempic CLI integration: PATH check, JSONL path resolution, file size helpers, async session cleaner
    ├── tokens.ts           Token loading — reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from env, validates prefixes
    ├── ack-tracker.ts      In-memory ack reaction state — Map keyed by channelId:messageTs, trackAck/consumeAck API, 30-day expiry pruning
    ├── message-archive.ts  Optional SQLite archive of every inbound Slack message — opened when `message_archive_db` is set in config, writes fire-and-forget from socket.on('message'|'app_mention'), schema compatible with the Python nightly backfill script
    └── hooks/
        ├── permission-relay.sh   PermissionRequest hook — POST + long-poll for Allow/Deny
        └── ask-relay.sh          AskUserQuestion hook — POST + long-poll for option selection
```

## Data Flow

### Inbound (Slack → Claude Code)

1. Slack message arrives via Socket Mode (`message` or `app_mention` event)
2. `gate()` checks access control (bot messages, subtypes, DM policy, allowlist)
3. If `ackReaction` is configured, the ack emoji is applied to the message and `trackAck(channelId, messageTs)` records the pending ack for later removal
4. Message is routed to the correct session via `getSessionByChannel()` or `getSessionByCwd()`. If the channel has an entry in `routes` but its session is not yet registered (e.g. still starting up), the message is not delivered to Claude — instead, the server posts `"Message not delivered — session starting up, please retry in a moment."` back to the channel. `default_route` does not apply for configured channels; it is only consulted for channels with no entry in `routes` at all.
5. Session's MCP Server sends `notifications/claude/channel` to the Claude Code client

### Outbound (Claude Code → Slack)

1. Claude Code calls MCP tools (`reply`, `react`, `edit_message`, etc.)
2. Tool handler checks `assertOutboundAllowed()` — session can only send to channels it has received messages from
3. Tool calls the Slack Web API (`web.chat.postMessage`, `web.reactions.add`, etc.)
4. After the first chunk posts, if `message_id` was provided and `consumeAck(channelId, messageTs)` finds a tracked entry, the ack reaction is removed via `reactions.remove`

### Permission Relay

1. Claude Code hits a permission prompt → `PermissionRequest` hook fires
2. `permission-relay.sh` POSTs to `/permission` → server posts Block Kit message to Slack
3. Hook long-polls `GET /permission/<requestId>` (60s per poll)
4. User clicks Allow/Deny button → Socket Mode interactive event → server resolves the decision
5. Hook returns decision to Claude Code

### AskUserQuestion Relay

Same pattern as permission relay but via `PreToolUse` hook on `AskUserQuestion`:
1. `ask-relay.sh` intercepts via PreToolUse → POSTs question + options to `/ask`
2. Server posts Block Kit message with option buttons
3. Hook long-polls `GET /ask/<requestId>`
4. User clicks option → server resolves
5. Hook returns `allow` with `updatedInput.answers` containing the user's selection

## Session Lifecycle

### Connection

1. Claude Code sends POST to `/mcp` (no session ID) → `initPendingSession()` creates a pending session
2. MCP handshake completes → `server.oninitialized` fires → `handleInitialized()` calls `roots/list`
3. CWD from roots is matched against `routingConfig.routes` → session promoted from pending to registered
4. Session receives messages from its assigned Slack channel
5. A keep-alive timer is started (`startSseKeepAlive`) that writes SSE comment frames (`:ping\n\n`) every ~30 s to prevent idle connection drops from proxies or load balancers

### Server-Managed Startup

Called from `main()` in `server.ts`. `rotateSessions()` runs as the very first action, renaming `sessions.json` → `sessions.json.last` to preserve last-known session IDs before any state is overwritten.

1. **Rotate sessions** — `rotateSessions()` renames `sessions.json` → `sessions.json.last`. If `sessions.json` does not exist, this is a no-op.
2. **Read stored IDs** — `sessions.json.last` is read via `readSessions(lastPath)` to obtain the previous session IDs used for `--resume` logic.
3. **tmux availability check** — `startupSessionManager()` calls `tmuxClient.checkAvailability()` (`tmux -V`). If tmux is not installed, startup is skipped with a warning and the server continues.
4. **Concurrent route launch** — all routes are processed concurrently via `Promise.allSettled`. Each route applies a three-branch decision tree:
   - **Reconnect** — tmux session exists AND `isClaudeRunning()` returns true → send `/mcp reconnect <server-name>` (from `MCP_SERVER_NAME` in `config.ts`) to the running session; the stored `sessionId` from `sessions.json.last` is carried forward (or `"pending"` if absent); no relaunch
   - **Resume** — dead or missing process with a stored `sessionId` in `sessions.json.last` → verify `~/.claude/projects/<slug>/<sessionId>.jsonl` exists; if the file is absent, fall through to **Fresh** immediately (no tmux launch attempted); otherwise kill any stale tmux session, call `cleanSession()` if cozempic is available (cleans the JSONL file before resume to reduce load times), then call `launchSession()` with the stored session ID (passes `--resume <id>` to Claude)
   - **Fresh** — dead or missing process without a stored session ID → kill any stale tmux session, call `launchSession()` with no session ID
5. **Atomic sessions.json write** — after all routes settle, results are collected into a `SessionsMap` and written atomically via `writeSessions()`. This is the only write to `sessions.json` during startup.
6. **Launch flow** (`launchSession()`) — signature: `(channelId, cwd, routingConfig, tmuxClient, options?) → Promise<SessionRecord | null>`:
   - `tmuxClient.newSession(name, cwd)` creates a detached tmux session
   - If `options.cleanSession` is provided and `options.sessionId` is set, `cleanSession()` is called before the tmux launch to clean the JSONL file (cozempic integration; no-op if cozempic is not installed)
   - The `claude` CLI command is launched directly (no env var prefix); hook scripts identify managed sessions via the `/is-managed` endpoint instead
   - If `options.sessionId` is provided, appends `--resume <id>` to the CLI command; otherwise launches fresh
   - If `system_prompt_mode` is `"append"` and `append_system_prompt_file` is set, appends `--append-system-prompt-file <path>` to the CLI command; if `system_prompt_mode` is `"none"`, the flag is omitted and only `CLAUDE.md` is used
   - Polls `capturePane()` with exponential backoff (500 ms start, 2× per step, 5 s cap, 120 s total timeout) waiting for the safety prompt text
   - On prompt found: sends Enter to acknowledge
   - Early detection: after 5 s have elapsed since launch, each poll iteration also calls `isClaudeRunning()`; if Claude is running with no prompt (e.g. `--resume` skips the safety prompt), the session is accepted immediately
   - **Session ID** — fresh launches write `sessionId: "pending"` immediately after the safety prompt ACK. The real UUID is discovered later, after the session's first MCP tool call, via the post-call discovery path in `registry.ts` (see [Session ID Discovery](#session-id-discovery)). Resume launches carry the stored UUID from `sessions.json.last` directly and `sessionId` is never `"pending"`.
   - **Resume failure fallback** — if `"No conversation found"` is detected in the pane, or if the `--resume` attempt times out, the tmux session is killed, recreated, and retried once with a fresh launch (no `--resume`). Note: the JSONL pre-check in the startup decision tree gates this path — if the file is absent, startup falls through to Fresh before any tmux launch is attempted
   - Returns a `SessionRecord` on success, or `null` on failure

### Session ID Discovery

After every MCP tool call by a registered session, `registry.ts` fires a fire-and-forget async block that discovers and persists the real Claude session UUID without blocking the tool call response:

1. **Peer port** — the TCP peer port of the MCP request is recorded on `SessionEntry.peerPort` before each `handleRequest()` call (via `server.requestIP(req)` in `server.ts`).
2. **PID lookup** — `getPeerPidByPort(peerPort, serverPort)` runs `ss -tnp` and finds the Claude process PID by matching the TCP connection's local/peer port pair on the loopback interface.
3. **Session file read** — `getSessionIdForPid(pid)` reads `~/.claude/sessions/<pid>.json` and extracts the `sessionId` string field.
4. **Atomic write** — if the discovered UUID differs from the stored one, `sessions.json` is updated via `writeSessions()`. On the next server startup, the UUID is available immediately for `--resume`.

This path is skipped if `peerPort` is 0 (not yet set), if the `ss` command fails, or if the session file does not yet exist. For resume launches the stored UUID is already correct; for fresh launches `"pending"` is replaced with the real UUID on the first successful discovery.

**Object identity invariant**: the `SessionEntry` stub created by `initPendingSession` in `server.ts` — the object that `createSessionServer`'s tool handlers close over — must be the same object stored in the registry after `registerSession` promotes the pending entry. `registerSession` mutates this stub in place and stores it directly, so that the `peerPort` write from the HTTP fetch handler (step 1 above) is immediately visible to the tool handler closure. If the registry and the closure held separate objects, `peerPort` would remain 0 and peer-PID discovery would never fire.

### Disconnection

1. Transport closes → `onsessionclosed` fires
2. Session removed from registry
3. `onsessionclosed` resolves the session's CWD back to a `channelId` via `routingConfig.routes`
4. If a `channelId` is found, `scheduleRestart(channelId, cwd)` is called

### Auto-Restart

After `scheduleRestart` is called:

1. **Delay check** — if `session_restart_delay` is 0, restart is skipped immediately
2. **Failure guard** — if the channel has reached `MAX_CONSECUTIVE_FAILURES` (3), restart is abandoned
3. **Timer** — a `setTimeout` fires after `session_restart_delay` seconds
4. **Liveness check** — `isSessionAlive()` checks whether Claude is already running in tmux; if alive, `reconnectSession()` sends `/mcp reconnect <server-name>` to the running tmux session and returns — no relaunch needed
5. **Kill zombie** — any dead tmux session for the channel is cleaned up (errors ignored)
6. **Relaunch** — `launchSession()` is called with the stored `sessionId` from sessions.json if one exists and is not `"pending"`; when a real UUID is available, Claude launches with `--resume <id>`, preserving conversation context across the restart. If the stored ID is absent or `"pending"`, a fresh launch is performed. On failure the per-channel failure counter increments.
7. **Success reset** — when a session successfully reconnects and registers, `resetFailureCounter()` clears the counter for that channel

### Health-Check Poller

A periodic backstop that runs alongside the reactive disconnect path. Where `onsessionclosed` handles restarts after MCP disconnects, the health-check poller catches sessions that die without triggering a close event (e.g., a tmux session killed externally).

On each tick:

1. **Route iteration** — for each `channelId`/`cwd` pair in `routingConfig.routes`:
   - **Skip if restart pending/active** — `isRestartPendingOrActive(channelId)` returns true; a relaunch is already in flight
   - **Skip if max failures reached** — `hasReachedMaxFailures(channelId)` returns true; the channel has been abandoned
   - **Liveness check** — `isClaudeRunning()` via `tmux.ts` checks whether Claude is alive in the session's tmux window
2. **Dead session** — if the liveness check fails, `scheduleRestart(channelId, cwd)` is called, delegating to the same restart path used by `onsessionclosed`

The interval is controlled by `health_check_interval` in `config.json`. If the value is `0`, `startHealthCheck()` returns immediately and no interval is created. `stopHealthCheck()` clears the interval during graceful shutdown, before `cancelAllRestartTimers()` runs.

**Ordering invariant**: `startHealthCheck()` is called only after `startupSessionManager()` returns and `sessions.json` has been written. `Promise.allSettled` in startup ensures all route launches have settled before the health-check poller begins. Moving `startHealthCheck()` earlier in the startup sequence would risk the poller racing with in-progress launches.

### stop command

`stop` (CLI subcommand) sends SIGTERM to the running server via the PID file at `STATE_DIR/server.pid`. If the process does not exit within `stop_timeout` seconds (default 30 s, configurable in `config.json`), a SIGKILL is sent. A brief 2 s confirmation poll follows the SIGKILL. Stale PID files (process no longer running) are silently removed. A non-zero exit from this phase causes `stop` to exit 1.

### clean_restart

`clean_restart` (CLI subcommand) stops the server daemon first, then concurrently exits all managed Claude Code sessions, then starts a fresh server. The stop-first ordering prevents the health-check poller and auto-restart logic from interfering with session teardown. It logs to `STATE_DIR/clean_restart.log` via `initLogging()` (see [Logging](#logging)). `CliDeps` is extended with injectable tmux operations (`hasSession`, `sendKeys`, `isClaudeRunning`, `killSession`) and a `loadConfig` function for route and timeout discovery.

Algorithm:

1. **Init logging + load config** — `initLogging()` redirects output to `clean_restart.log`. `loadConfig()` reads `config.json` and provides the `routes` map and `exit_timeout` value used in subsequent phases. Config load failure is fatal.
2. **Stop server daemon** — shells out to `claude-slack-channel-bots stop`, which sends SIGTERM and escalates to SIGKILL after `stop_timeout` (see [stop command](#stop-command)).
3. **Exit sessions** — iterates `routingConfig.routes`. For each route, `sessionName(route.cwd)` derives the tmux session name. `hasSession()` and `isClaudeRunning()` gate the attempt; if either check fails the session is skipped. All routes are fanned out in parallel via `Promise.allSettled`. Per-session errors are caught and logged; they never abort the restart.
4. **Force-kill on timeout** — within each per-session goroutine, `/exit` + Enter is sent as a single atomic `sendKeys` call. `isClaudeRunning()` is then polled with exponential backoff (500 ms start, doubles each step, 5 s cap) for up to `exit_timeout` seconds (default 120 s). If the session does not exit within the timeout, `killSession()` is called.
5. **Start new server daemon** — shells out to `claude-slack-channel-bots start`.
6. **Exit** — a non-zero exit code from `start` is propagated and the process exits with that code.

### Graceful Shutdown

On `SIGTERM` or `SIGINT`, the shutdown handler calls `stopAllKeepAliveTimers()` and `cancelAllRestartTimers()` before tearing down Socket Mode and the HTTP server. All pending keep-alive and restart timers are cleared so no work fires during shutdown. The PID file (`STATE_DIR/server.pid`) is removed as the final step of shutdown.

## Configuration

### config.json (~/.claude/channels/slack/config.json)

Maps Slack channels to project directories. The server uses CWD matching to route sessions.

Key fields:
- `routes` — `Record<channelId, { cwd: string }>` — the channel-to-directory mapping
- `bind` — HTTP server bind address (default: 127.0.0.1)
- `port` — HTTP server port (default: 3100)
- `default_route` — CWD for channels without explicit routes
- `default_dm_session` — CWD for handling direct messages
- `session_restart_delay` — seconds before auto-restarting dead sessions (default: 60, 0 = disabled)
- `health_check_interval` — seconds between health-check polls (default: 120, 0 = disabled)
- `exit_timeout` — seconds `clean_restart` waits for a Claude session to exit cleanly before force-killing it (default: 120)
- `stop_timeout` — seconds the `stop` command waits after SIGTERM before escalating to SIGKILL (default: 30)
- `mcp_config_path` — path to MCP config file for Claude launch (default: ~/.claude/slack-mcp.json)
- `append_system_prompt_file` — optional path to a file appended to every managed session's system prompt via `--append-system-prompt-file`; missing file silently skipped
- `system_prompt_mode` — controls whether `append_system_prompt_file` is applied (default: `"append"`; valid: `append`, `none`). `"append"` passes `--append-system-prompt-file` to Claude when launching sessions; `"none"` skips the flag entirely so only `CLAUDE.md` is used
- `cozempic_prescription` — cozempic cleaning intensity used before `--resume` launches (default: `"standard"`; valid: `gentle`, `standard`, `aggressive`); has no effect if cozempic is not installed

### sessions.json (~/.claude/channels/slack/sessions.json)

Persistent registry of server-managed tmux sessions. Maps channel IDs to session records. Survives server restarts.

Each record has the shape:

```typescript
{
  tmuxSession: string   // tmux session name
  lastLaunch:  string   // ISO-8601 timestamp of the most recent launch
  sessionId:   string   // Claude session UUID, or "pending" for fresh launches awaiting first tool call
}
```

`sessionId` is `"pending"` for fresh launches immediately after startup. It transitions to a real UUID after the session's first MCP tool call, via the post-call discovery path in `registry.ts` (see [Session ID Discovery](#session-id-discovery)). For resume launches, the stored UUID from `sessions.json.last` is used immediately. The UUID is passed as `--resume <id>` on the next startup to preserve conversation context across restarts. The guards in `server.ts` treat `"pending"` as absent — no `--resume` is attempted for sessions that have not yet discovered their UUID.

`sessions.json` is written once atomically after all routes finish launching at startup. Individual route launches do not write to `sessions.json`.

### sessions.json.last (STATE_DIR/sessions.json.last)

Created by `rotateSessions()` at the start of every server startup run. Contains the `sessions.json` snapshot from the previous run, used by the startup manager to read stored session IDs for `--resume` without risking a partially-written current `sessions.json`. Overwritten on each startup. If no `sessions.json` existed when the server last started, this file is absent (treated as an empty map by `readSessions()`).

### server.pid (STATE_DIR/server.pid)

Written at startup with the server's process ID. Used by the CLI `stop` command to send SIGTERM (with SIGKILL escalation after `stop_timeout`) to a running server, and by startup to detect a conflicting already-running instance. Removed on graceful shutdown.

### Environment Variables

Required at startup:

- `SLACK_BOT_TOKEN` — bot user OAuth token; must begin with `xoxb-`
- `SLACK_APP_TOKEN` — app-level token for Socket Mode; must begin with `xapp-`

Both values are read directly from the process environment. When `SLACK_DRY_RUN` is set (see below), `loadTokens()` returns dummy values (`xoxb-dry-run` / `xapp-dry-run`) and validation is skipped.

Optional:

- `SLACK_DRY_RUN` — set to `1`, `true`, or `yes` to enable dry-run mode. Bypasses token validation, skips `socket.start()` and `web.auth.test()`, and stubs all MCP tool calls (`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`) — each returns a `[dry-run]` placeholder and logs the call to the server log. The HTTP/MCP server still starts normally so Claude Code sessions can connect and exercise tool calls without a Slack workspace.

Checked by hook scripts at runtime:

- `GET /is-managed?pid=<pid>` — the permission relay hooks (`permission-relay.sh`, `ask-relay.sh`) call this endpoint with `$PPID` before doing any work. The server iterates all managed routes, resolves the Claude process PID for each tmux session via `getClaudePid()`, and returns 200 if the PID matches a managed session or 404 otherwise. If the server is unreachable or returns 404, the hooks exit silently (no-op). This replaces the former `SLACK_CHANNEL_BOT_SESSION` env var guard.

### access.json (~/.claude/channels/slack/access.json)

Access control policy: DM policy, allowlist, channel policies, ack reaction. chmod 600.

## Logging

### Why console.error/console.log are overridden directly

Bun bypasses `process.stderr.write` overrides — the runtime writes directly to the file descriptor, so patching `process.stderr.write` has no effect. `src/logging.ts` works around this by replacing `console.error` and `console.log` themselves before any logging occurs.

### initLogging()

`initLogging(logFilePath)` in `src/logging.ts` opens the target file in append mode and replaces both `console.error` and `console.log` with wrapper functions that:

1. Format all arguments to a single string (JSON-serializing objects)
2. Prepend an ISO-8601 timestamp: `[2024-01-01T00:00:00.000Z] message`
3. Write the line synchronously via `writeSync` to the open file descriptor
4. Fall back to the original `console.error`/`console.log` if the write fails

The originals are captured at module load time so the fallback always refers to Bun's native output.

### Log file locations

Both paths are rooted in `SLACK_STATE_DIR` (default: `~/.claude/channels/slack/`).

| Process | Log file |
|---------|----------|
| Server daemon (`server.ts`) | `STATE_DIR/server.log` |
| `clean_restart` subcommand | `STATE_DIR/clean_restart.log` |

Both files are opened in append mode — multiple restarts accumulate in the same file rather than overwriting it.

## Security Model

- **Gate layer**: All inbound messages pass through `gate()` — drops bot messages, enforces DM policy, validates allowlist
- **Outbound scoping**: Each session can only send to channels it has received messages from (per-session `deliveredChannels` Set)
- **File exfiltration guard**: `assertSendable()` blocks uploading files from the state directory
- **Localhost restriction**: `/permission` and `/ask` endpoints only accept requests from 127.0.0.1/::1/::ffff:127.*
- **Session scope guard**: The permission relay hooks (`permission-relay.sh`, `ask-relay.sh`) are no-ops outside bot-managed sessions. On each invocation the hooks call `GET /is-managed?pid=$PPID` on the server; the server checks whether the PID belongs to a Claude process in any managed tmux session's process tree and returns 200 or 404. If the server is unreachable or returns 404, the hooks exit silently without interfering. This PID-based check is more reliable than env vars because it cannot leak through tmux's environment inheritance.
