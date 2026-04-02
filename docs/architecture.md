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
    ├── tokens.ts           Token loading — reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from env, validates prefixes
    ├── ack-tracker.ts      In-memory ack reaction state — Map keyed by channelId:messageTs, trackAck/consumeAck API, 30-day expiry pruning
    └── hooks/
        ├── permission-relay.sh   PermissionRequest hook — POST + long-poll for Allow/Deny
        └── ask-relay.sh          AskUserQuestion hook — POST + long-poll for option selection
```

## Data Flow

### Inbound (Slack → Claude Code)

1. Slack message arrives via Socket Mode (`message` or `app_mention` event)
2. `gate()` checks access control (bot messages, subtypes, DM policy, allowlist)
3. If `ackReaction` is configured, the ack emoji is applied to the message and `trackAck(channelId, messageTs)` records the pending ack for later removal
4. Message is routed to the correct session via `getSessionByChannel()` or `getSessionByCwd()`. If the channel has an entry in `routes` but its session is not yet registered (e.g. still starting up), the message is **dropped** — `default_route` does not apply. `default_route` is only consulted for channels with no entry in `routes` at all.
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

### Server-Managed Startup

Called from `main()` in `server.ts` via `startupSessionManager()` after the HTTP server and Socket Mode listeners are ready.

1. **tmux availability check** — `tmuxClient.checkAvailability()` runs `tmux -V`. If tmux is not installed, startup is skipped with a warning and the server continues.
2. **Iterate routes** — for each `channelId`/`cwd` pair in `routingConfig.routes`, apply a three-branch decision tree:
   - **Reconnect** — tmux session exists AND `isClaudeRunning()` returns true → send `/mcp reconnect <server-name>` (from shared `MCP_SERVER_NAME` constant in `config.ts`) to the running session; no relaunch
   - **Resume** — dead or missing process with a stored `sessionId` in sessions.json → kill any stale tmux session, call `launchSession()` with the stored session ID (passes `--resume <id>` to Claude)
   - **Fresh** — dead or missing process without a stored session ID → kill any stale tmux session, call `launchSession()` with no session ID
3. **Launch flow** (`launchSession()`) — accepts an optional `sessionId`:
   - `tmuxClient.newSession(name, cwd)` creates a detached session
   - The `claude` CLI command is prefixed with `SLACK_CHANNEL_BOT_SESSION=1` so the permission relay hooks activate only inside bot-managed sessions
   - If a `sessionId` is present in sessions.json for this channel, appends `--resume <id>` to the CLI command; otherwise launches fresh
   - Polls `capturePane()` with exponential backoff (500 ms start, 2× per step, 5 s cap, 60 s total timeout) waiting for the safety prompt text
   - On prompt found: sends Enter to acknowledge
   - Early detection: after 5 s have elapsed since launch, each poll iteration also calls `isClaudeRunning()`; if Claude is running with no prompt (e.g. `--resume` skips the safety prompt), accepts the session immediately without waiting for the full timeout
   - Post-loop fallback: if the poll loop times out and `isClaudeRunning()` is still true, records success anyway (forward-compatible)
   - **Resume failure fallback**: if a `--resume` attempt fails (Claude not running after timeout), kills the tmux session, recreates it, and retries once with a fresh launch (no `--resume`) in the same `launchSession()` call
   - After every successful launch: `captureSessionId()` polls `~/.claude/sessions/` for a `.json` file matching the CWD with `startedAt > launchTimestamp`; the captured ID is persisted to sessions.json (capture failure is non-fatal)
   - Otherwise: returns failure and logs a warning

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
6. **Relaunch** — `launchSession()` is called with the stored `sessionId` from sessions.json if one exists; when present, Claude launches with `--resume <id>`, preserving conversation context across the restart. If no stored ID is available, behavior is unchanged (fresh launch). On failure the per-channel failure counter increments.
7. **Success reset** — when a session successfully reconnects and registers, `resetFailureCounter()` clears the counter for that channel

### Health-Check Poller

A periodic backstop that runs alongside the reactive disconnect path. Where `onsessionclosed` handles restarts after MCP disconnects, the health-check poller catches sessions that die without triggering a close event (e.g., a tmux session killed externally).

On each tick:

1. **Route iteration** — for each `channelId`/`cwd` pair in `routingConfig.routes`:
   - **Skip if restart pending/active** — `isRestartPendingOrActive(channelId)` returns true; a relaunch is already in flight
   - **Skip if max failures reached** — `hasReachedMaxFailures(channelId)` returns true; the channel has been abandoned
   - **Liveness check** — `isClaudeRunning()` via `tmux.ts` checks whether Claude is alive in the session's tmux window
2. **Dead session** — if the liveness check fails, `scheduleRestart(channelId, cwd)` is called, delegating to the same restart path used by `onsessionclosed`

The interval is controlled by `health_check_interval` in `routing.json`. If the value is `0`, `startHealthCheck()` returns immediately and no interval is created. `stopHealthCheck()` clears the interval during graceful shutdown, before `cancelAllRestartTimers()` runs.

### clean_restart

`clean_restart` (CLI subcommand) gracefully exits all managed Claude Code sessions before performing a stop/start cycle. It logs to `STATE_DIR/clean_restart.log` via `initLogging()` (see [Logging](#logging)). `CliDeps` is extended with injectable tmux operations (`hasSession`, `sendKeys`, `isClaudeRunning`, `killSession`) and a `readSessions` function.

Algorithm:

1. **Read sessions** — `readSessions()` loads `sessions.json`. If no entries exist, the shutdown phase is skipped.
2. **Send /exit** — for each session record, checks `hasSession(tmuxSession)` and, if present, sends `/exit` + Enter via `sendKeys`. All sessions are fanned out in parallel via `Promise.all`. Per-session errors are caught and logged; they never abort the restart.
3. **Poll for exit** — in a second parallel fan-out, polls `isClaudeRunning(tmuxSession)` with exponential backoff (500 ms start, doubles each step, 5 s cap) for up to 60 seconds per session.
4. **Force-kill on timeout** — if a session does not exit within 60 seconds, `killSession(tmuxSession)` is called. Kill errors are caught and logged.
5. **Stop** — shells out to `claude-slack-channel-bots stop`.
6. **Start** — shells out to `claude-slack-channel-bots start`. A non-zero exit code from `start` is propagated and the process exits with that code.

### Graceful Shutdown

On `SIGTERM` or `SIGINT`, the shutdown handler calls `cancelAllRestartTimers()` before tearing down Socket Mode and the HTTP server. All pending restart timers are cleared so no relaunch fires during shutdown. The PID file (`STATE_DIR/server.pid`) is removed as the final step of shutdown.

## Configuration

### routing.json (~/.claude/channels/slack/routing.json)

Maps Slack channels to project directories. The server uses CWD matching to route sessions.

Key fields:
- `routes` — `Record<channelId, { cwd: string }>` — the channel-to-directory mapping
- `bind` — HTTP server bind address (default: 127.0.0.1)
- `port` — HTTP server port (default: 3100)
- `default_route` — CWD for channels without explicit routes
- `default_dm_session` — CWD for handling direct messages
- `session_restart_delay` — seconds before auto-restarting dead sessions (default: 60, 0 = disabled)
- `health_check_interval` — seconds between health-check polls (default: 120, 0 = disabled)
- `mcp_config_path` — path to MCP config file for Claude launch (default: ~/.claude/slack-mcp.json)
- `append_system_prompt_file` — optional path to a file appended to every managed session's system prompt via `--append-system-prompt-file`; missing file silently skipped

### sessions.json (~/.claude/channels/slack/sessions.json)

Persistent registry of server-managed tmux sessions. Maps channel IDs to session records. Survives server restarts.

Each record has the shape:

```typescript
{
  tmuxSession: string   // tmux session name
  lastLaunch:  string   // ISO-8601 timestamp of the most recent launch
  sessionId?:  string   // Claude session UUID (optional) — captured after each successful launch
}
```

`sessionId` is populated by `captureSessionId()` after every successful launch and used on the next launch attempt to pass `--resume <id>` to Claude Code. Capture failure is non-fatal; the field is simply omitted when capture does not succeed.

If the `sessionId` field is absent, the session is treated as having no resumable state and launches fresh.

### server.pid (STATE_DIR/server.pid)

Written at startup with the server's process ID. Used by the CLI `stop` command to send `SIGTERM` to a running server and by startup to detect a conflicting already-running instance. Removed on graceful shutdown.

### Environment Variables

Required at startup:

- `SLACK_BOT_TOKEN` — bot user OAuth token; must begin with `xoxb-`
- `SLACK_APP_TOKEN` — app-level token for Socket Mode; must begin with `xapp-`

Both values are read directly from the process environment.

Set by the server at session launch:

- `SLACK_CHANNEL_BOT_SESSION` — set to `1` as a prefix on the tmux `claude` launch command (e.g. `SLACK_CHANNEL_BOT_SESSION=1 claude ...`). The permission relay hooks (`permission-relay.sh`, `ask-relay.sh`) exit immediately when this variable is absent, limiting their scope to bot-managed sessions only.

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
- **Session scope guard**: The permission relay hooks (`permission-relay.sh`, `ask-relay.sh`) are no-ops outside bot-managed sessions. `SLACK_CHANNEL_BOT_SESSION` is only set in tmux sessions launched by the server, so the hooks exit immediately when the variable is absent and do not interfere with Claude sessions run outside the bot.
