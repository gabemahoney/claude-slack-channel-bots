# Internal Architecture

## System Overview

The Slack Channel Router is a two-way bridge between Slack and Claude Code sessions via Socket Mode + MCP HTTP (StreamableHTTP). Each Claude Code session connects to its own MCP Server instance, assigned to a Slack channel via routing config.

## Module Map

```
cli.ts                  CLI entry point for the claude-slack-channel-bots command, dispatches start/stop subcommands, performs prerequisite checks, thin wrapper around server.ts main()
└── server.ts           Main entry point — HTTP server, Socket Mode, session lifecycle, message routing
    ├── config.ts           Routing configuration — load, validate, defaults, tilde expansion
    ├── registry.ts         Session registry — pending/registered sessions, MCP Server factory, transport routing
    ├── lib.ts              Pure utilities — gate, access control, chunking, sanitization
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
4. Message is routed to the correct session via `getSessionByChannel()` or `getSessionByCwd()`
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
   - **Reconnect** — tmux session exists AND `isClaudeRunning()` returns true → send `/mcp reconnect` to the running session; no relaunch
   - **Resume** — dead or missing process with a stored `sessionId` in sessions.json → kill any stale tmux session, call `launchSession()` with the stored session ID (passes `--resume <id>` to Claude)
   - **Fresh** — dead or missing process without a stored session ID → kill any stale tmux session, call `launchSession()` with no session ID
3. **Launch flow** (`launchSession()`) — accepts an optional `sessionId`:
   - `tmuxClient.newSession(name, cwd)` creates a detached session
   - If a `sessionId` is present in sessions.json for this channel, appends `--resume <id>` to the CLI command; otherwise launches fresh
   - Polls `capturePane()` with exponential backoff (500 ms start, 2× per step, 5 s cap, 60 s total timeout) waiting for the safety prompt text
   - On prompt found: sends Enter to acknowledge
   - Fallback: if the prompt is not found but `isClaudeRunning()` returns true, records success anyway (forward-compatible)
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
4. **Liveness check** — `isSessionAlive()` checks whether Claude is already running in tmux; if alive, restart is skipped
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

### access.json (~/.claude/channels/slack/access.json)

Access control policy: DM policy, allowlist, channel policies, ack reaction. chmod 600.

## Security Model

- **Gate layer**: All inbound messages pass through `gate()` — drops bot messages, enforces DM policy, validates allowlist
- **Outbound scoping**: Each session can only send to channels it has received messages from (per-session `deliveredChannels` Set)
- **File exfiltration guard**: `assertSendable()` blocks uploading files from the state directory
- **Localhost restriction**: `/permission` and `/ask` endpoints only accept requests from 127.0.0.1/::1/::ffff:127.*
