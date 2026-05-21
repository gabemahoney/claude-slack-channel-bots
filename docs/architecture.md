# Internal Architecture

## System Overview

The Slack Channel Router is a two-way bridge between Slack and Claude Code sessions via Socket Mode + MCP HTTP (StreamableHTTP). Each Claude Code session connects to its own MCP Server instance, assigned to a Slack channel via routing config.

## Module Map

```
cli.ts                          CLI entry point for the claude-slack-channel-bots command, dispatches start/stop/clean_restart subcommands, performs prerequisite checks, thin wrapper around server.ts main()
└── server.ts                   Main entry point — HTTP server, Socket Mode, session lifecycle, message routing
    ├── config.ts                   Routing configuration — load, validate, defaults, tilde expansion
    ├── registry.ts                 Session registry — keyed by channelId; pending/registered sessions, MCP Server factory, transport routing
    ├── lib.ts                      Pure utilities — gate, access control, chunking, sanitization
    ├── logging.ts                  Log file setup — overrides console.error/console.log with timestamped writeSync to a log file
    ├── claude-director-cli.ts      Typed wrappers around the claude-director binary — spawn, resume, list, get, status, kill, delete, send-keys, pause, decide verbs
    ├── claude-director-probe.ts    Startup gates — CE1 binary version probe, CE2 state.db same-user ownership check, runStartupGates orchestrator
    ├── claude-director-template.ts TOML template writer — builds and atomically writes ~/.claude-director/templates/slack-channel-bot.toml on every server start
    ├── startup-errors.ts           Startup error recorder — writes timestamped lines to stderr and startup-errors.log via direct fd writes (never console.error)
    ├── session-manager.ts          Startup orchestration — spawnForRoute collision-then-act dispatcher, reconcileOrphans, startupSessionManager
    ├── restart.ts                  Auto-restart — delayed relaunch via spawnForRoute on disconnect, failure counting, timer cancellation
    ├── health-check.ts             Periodic liveness poller — checks routes on a timer via cliStatus, schedules restarts for dead sessions
    ├── trust-bootstrap.ts          Pre-accepts folder-trust dialogs — patches .claude.json for each route CWD before startupSessionManager runs
    ├── permission-action-id.ts     Anchored parser for perm_<allow|deny>_<claudeInstanceId>_<requestId> action_id strings; requestId kept as string (bigint-safe)
    ├── permission-poller.ts        Permission relay poller — polls cliList(check_permission, service=cscb), posts Block Kit to Slack, manages livePrompts map
    ├── permission-click-handler.ts Click handler — parsePermissionActionId → markFinalized → cliDecide → chat.update
    ├── sessions.ts                 sessions.json I/O — readSessions/writeSessions, SessionRecord, SessionsMap
    ├── pid.ts                      PID file management — write, read, conflict detection, isProcessRunning
    ├── cozempic.ts                 Optional cozempic CLI integration: PATH check, JSONL path resolution, file size helpers, async session cleaner
    ├── tokens.ts                   Token loading — reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from env, validates prefixes
    ├── ack-tracker.ts              In-memory ack reaction state — Map keyed by channelId:messageTs, trackAck/consumeAck API, 30-day expiry pruning
    └── message-archive.ts          Optional SQLite archive of every inbound Slack message — opened when `message_archive_db` is set in config, writes fire-and-forget from socket.on('message'|'app_mention'), schema compatible with the Python nightly backfill script
```

## Data Flow

### Inbound (Slack → Claude Code)

1. Slack message arrives via Socket Mode (`message` or `app_mention` event)
2. `gate()` checks access control (bot messages, subtypes, DM policy, allowlist)
3. If `ackReaction` is configured, the ack emoji is applied to the message and `trackAck(channelId, messageTs)` records the pending ack for later removal
4. Message is routed to the correct session via `getSessionByChannel()` (O(1) direct `registry.get(channelId)` lookup) or `getSessionByCwd()` (O(n) linear scan, used only for `default_route` and `default_dm_session` lookups). If the channel has an entry in `routes` but its session is not yet registered (e.g. still starting up), the message is not delivered to Claude — instead, the server posts `"Message not delivered — session starting up, please retry in a moment."` back to the channel. `default_route` does not apply for configured channels; it is only consulted for channels with no entry in `routes` at all.
5. Session's MCP Server sends `notifications/claude/channel` to the Claude Code client

### Outbound (Claude Code → Slack)

1. Claude Code calls MCP tools (`reply`, `react`, `edit_message`, etc.)
2. Tool handler checks `assertOutboundAllowed()` — session can only send to channels it has received messages from
3. Tool calls the Slack Web API (`web.chat.postMessage`, `web.reactions.add`, etc.)
4. After the first chunk posts, if `message_id` was provided and `consumeAck(channelId, messageTs)` finds a tracked entry, the ack reaction is removed via `reactions.remove`

### Permission Relay

Permission relay is driven entirely by `claude-director` and `permission-poller.ts`. There are no hook scripts.

1. Claude Code hits a permission prompt → `claude-director` records the request in its state DB and transitions the spawn to `check_permission` state.
2. `permission-poller.ts` polls `cliList({ state: 'check_permission', labels: { service: 'cscb' } })` on every `claude_director_poll_interval_ms` tick.
3. For each new `check_permission` spawn, the poller calls `cliGet({ claudeInstanceId })` to read `permissionRequest` (tool name, tool input, request_id) and the spawn's `channel` label.
4. The poller calls `deps.postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId)` → Block Kit message with Allow/Deny buttons is posted to the bot's Slack channel. The `messageTs` is recorded in the `livePrompts` map.
5. User clicks Allow or Deny → Socket Mode `interactive` event → `handlePermissionClick` in `permission-click-handler.ts`.
6. Click handler calls `parsePermissionActionId(actionId)` to extract `decision`, `claudeInstanceId`, and `requestId`. The `requestId` is always kept as a raw digit string (bigint-safe; never coerced through `Number` or `parseInt`).
7. Click handler refetches via `cliGet` to verify the open `request_id` matches (stale-button check).
8. Click handler calls `markFinalized(claudeInstanceId)` (sets `finalizedAt = Date.now()` on the live-prompts entry) then calls `cliDecide({ claudeInstanceId, requestId, decision })`.
9. On success, `chat.update` replaces the Block Kit message with a decision label. The live-prompts entry is dropped.
10. **finalized_at ownership protocol**: when the click handler has set `finalizedAt`, the poller's disappeared-instance path skips calling `expireMessage` for up to 30 s, allowing the click handler's `chat.update` to win the race.

**AskUserQuestion**: AUQ is denied at the template level (`permissions = { deny = ["AskUserQuestion"] }` in `slack-channel-bot.toml`). No relay path exists for AUQ; it is blocked before Claude Code can invoke it.

## Session Lifecycle

### Connection

1. Claude Code sends POST to `/mcp` (no session ID) → `initPendingSession()` creates a pending session
2. MCP handshake completes → `server.oninitialized` fires → `handleInitialized()` calls `roots/list`
3. CWD from roots is matched against `routingConfig.routes` to resolve the `channelId` → session promoted from pending to registered, keyed by `channelId` in the registry
4. Session receives messages from its assigned Slack channel
5. A keep-alive timer is started (`startSseKeepAlive`) that writes SSE comment frames (`:ping\n\n`) every ~30 s to prevent idle connection drops from proxies or load balancers

### Server-Managed Startup

Called from `main()` in `server.ts`. The startup sequence is:

`runStartupGates` (T-C: binary probe + same-user check) → `loadConfig` → `writeTemplate` (T-D) → `bootstrapTrust` → `reconcileOrphans` → `startupSessionManager` → `startPermissionPoller` → Socket Mode

1. **Startup gates** — `runStartupGates()` (from `claude-director-probe.ts`) runs two fatal checks in order: CE1 version probe (`claude-director --version`) confirms the binary is on PATH; CE2 same-user check stats `~/.claude-director/state.db` and confirms the file is owned by the current process UID. Either failure records a startup error and calls `process.exit(1)`.
2. **Load config** — `loadConfig()` reads and validates `config.json`. Config load failure is fatal.
3. **Write template** — `writeTemplate(routingConfig)` (from `claude-director-template.ts`) atomically overwrites `~/.claude-director/templates/slack-channel-bot.toml`. Template write failure is fatal.
4. **Trust bootstrap** — `bootstrapTrust(routingConfig)` (from `trust-bootstrap.ts`) pre-accepts folder-trust dialogs for each route CWD. Non-fatal; exceptions are caught and logged.
5. **Reconcile orphans** — `reconcileOrphans(routingConfig)` (from `session-manager.ts`) lists all `service=cscb` spawns and kills+deletes any whose `channel` label is not a configured route. Non-fatal per channel; the server continues even if cleanup fails.
6. **Start sessions** — `startupSessionManager(routingConfig)` (from `session-manager.ts`) iterates all routes concurrently and calls `spawnForRoute` for each.
7. **Start permission poller** — `startPermissionPoller()` (from `permission-poller.ts`) begins the polling interval after Socket Mode is connected.

### spawnForRoute — collision-then-act dispatch (SR-1.4)

`spawnForRoute(channelId, route, routingConfig, web)` is the per-route spawn dispatcher. It uses the instance ID convention `cscb_<channelId>`.

1. **Attempt spawn** — calls `cliSpawn({ channelId, cwd })`. If successful → done (`spawned`).
2. **Collision** — if `ErrInstanceIdCollision` is returned, an existing spawn is present. Calls `cliGet` to read current state.
3. **State-based action**:
   - **`ended` / `missing`** (terminal):
     - If `resume_enabled` is `false`: `cliKill` + `cliDelete` + fresh spawn.
     - If `resume_enabled` is `true`: optional cozempic clean + `cliResume`. On `ErrNoSessionId` or `ErrJsonlMissing`: `cliDelete` + fresh spawn.
   - **`waiting`**: calls `reconnectMcp(channelId)` — sends `/mcp reconnect <MCP_SERVER_NAME>` + Enter via `cliSendKeys`.
   - **`working`**: calls `waitForWaitingAndReconnect(channelId)` — polls `cliStatus` until state transitions to `waiting`, then reconnects.
   - **`pending` / `check_permission` / `ask_user`**: no-op (session is alive and mid-interaction).
4. **Failure handling**: spawn failures are posted to the bot's Slack channel when a `WebClient` is available.

### Trust Bootstrap

Before `startupSessionManager` is called, `main()` in `src/server.ts` calls `bootstrapTrust(routingConfig)` (from `src/trust-bootstrap.ts`) inside the same `if (routingConfig) { ... }` block. Any exception is caught and logged; failure is non-fatal and startup continues.

**Why it exists.** Claude Code shows a "Do you trust the files in this folder?" interactive dialog the first time it opens a project directory. This dialog appears before the safety prompt, so the `attemptLaunch` poll loop in `session-manager.ts` would never see the safety prompt text — the session would time out. `bootstrapTrust` pre-accepts trust at server startup so the dialog never appears for managed sessions.

**What it touches.** For each route, it resolves the effective `claude_config_dir` using the same precedence as the launcher: per-route `routes[id].claude_config_dir` → top-level `claude_config_dir` → `~/.claude`. It then patches `<claude_config_dir>/.claude.json` so that `projects[<absolute-cwd>].hasTrustDialogAccepted` and `projects[<absolute-cwd>].hasCompletedProjectOnboarding` are both `true`. Routes that share a `claude_config_dir` are grouped so each `(configDir, cwd)` pair is processed once; the `.claude.json` is read (and atomically rewritten, if a change is needed) once per CWD in that dir. The write is atomic (write to `.claude.json.tmp`, then rename).

**Idempotency and missing files.** If both flags are already `true`, the file is not rewritten. If `.claude.json` is missing, unreadable, or malformed JSON, the route is silently skipped with a log line — the file is never auto-created. A missing file typically means the Claude account for that config dir has not been set up; the operator must run `claude auth login` with `CLAUDE_CONFIG_DIR` set to that path to populate it.

**Defense-in-depth.** Even with trust pre-accepted, the `attemptLaunch` poll loop in `session-manager.ts` also handles the dialog if it appears at launch time (e.g. a route whose CWD was never provisioned, or trust state clobbered on disk). When the pane contains both `'Do you trust the files in this folder'` and `'Yes, I trust this folder'`, the launcher sends `Enter` alone — the dialog's default focus is on the confirm option, so plain Enter accepts. It must NOT send `Down` first: that would move focus to "No, exit" and terminate the session. A one-shot flag (`trustDialogHandled`) prevents re-sending while the pane redraws. The poll loop then continues waiting for the safety prompt or ready banner.

### Session ID Discovery

Session IDs are owned and tracked by `claude-director`. CSCB reads the stored session ID from `sessions.json` when it needs to pass `--resume <id>` during `spawnForRoute` or startup (via `readSessions()[channelId]?.sessionId`).

The `claude-director` `SessionStart` hook writes the `claude_session_id` to the spawn row in its state DB (`~/.claude-director/state.db`) when the Claude process starts. CSCB does not perform any peer-PID discovery (`ss -tnp`) or `~/.claude/sessions/<pid>.json` lookups — those paths are deleted.

### Disconnection

1. Transport closes → `onsessionclosed` fires
2. `unregisterByMcpSessionId()` removes the session from the registry and returns its `channelId` directly (O(1) lookup via `mcpSessionIdToChannelId` index, then `registry.delete(channelId)`)
3. The CWD is resolved from `routingConfig.routes[channelId]` for the restart call
4. If a `channelId` is found, `scheduleRestart(channelId, cwd)` is called

### Auto-Restart

After `scheduleRestart` is called:

1. **Delay check** — if `session_restart_delay` is 0, restart is skipped immediately
2. **Failure guard** — if the channel has reached `MAX_CONSECUTIVE_FAILURES` (3), restart is abandoned
3. **Timer** — a `setTimeout` fires after `session_restart_delay` seconds
4. **Liveness check** — `isSessionAlive()` calls `cliStatus({ channelId })` and returns `true` if the spawn's state is in `CLAUDE_DIRECTOR_LIVE_STATES` (`pending`, `waiting`, `working`, `ask_user`, `check_permission`). If alive, no relaunch is attempted.
5. **Kill zombie** — `killSession(channelId)` calls `cliKill` then `cliDelete` on the dead spawn (errors logged, not fatal).
6. **Relaunch** — `spawnForRoute` is called, which handles the full collision-then-act logic including resume vs. fresh spawn decisions.
7. **Success reset** — when a session successfully reconnects and registers, `resetFailureCounter()` clears the counter for that channel

### Health-Check Poller

A periodic backstop that runs alongside the reactive disconnect path. Where `onsessionclosed` handles restarts after MCP disconnects, the health-check poller catches sessions that die without triggering a close event (e.g., a spawn killed externally via `claude-director kill`).

On each tick:

1. **Route iteration** — for each `channelId`/`cwd` pair in `routingConfig.routes`:
   - **Skip if restart pending/active** — `isRestartPendingOrActive(channelId)` returns true; a relaunch is already in flight
   - **Skip if max failures reached** — `hasReachedMaxFailures(channelId)` returns true; the channel has been abandoned
   - **Liveness check** — `isSessionAlive(channelId)` calls `cliStatus` and checks whether the spawn state is in `CLAUDE_DIRECTOR_LIVE_STATES`
2. **Dead session** — if the liveness check fails, `scheduleRestart(channelId, cwd)` is called, delegating to the same restart path used by `onsessionclosed`

The interval is controlled by `health_check_interval` in `config.json`. If the value is `0`, `startHealthCheck()` returns immediately and no interval is created. `stopHealthCheck()` clears the interval during graceful shutdown, before `cancelAllRestartTimers()` runs.

**Ordering invariant**: `startHealthCheck()` is called only after `startupSessionManager()` returns and `sessions.json` has been written. `Promise.allSettled` in startup ensures all route launches have settled before the health-check poller begins. Moving `startHealthCheck()` earlier in the startup sequence would risk the poller racing with in-progress launches.

### stop command

`stop` (CLI subcommand) sends SIGTERM to the running server via the PID file at `STATE_DIR/server.pid`. If the process does not exit within `stop_timeout` seconds (default 30 s, configurable in `config.json`), a SIGKILL is sent. A brief 2 s confirmation poll follows the SIGKILL. Stale PID files (process no longer running) are silently removed. A non-zero exit from this phase causes `stop` to exit 1.

### clean_restart

`clean_restart` (CLI subcommand) stops the server daemon first, then concurrently exits all managed Claude Code sessions, then starts a fresh server. The stop-first ordering prevents the health-check poller and auto-restart logic from interfering with session teardown. It logs to `STATE_DIR/clean_restart.log` via `initLogging()` (see [Logging](#logging)). `CliDeps` includes injectable `directorPause` and `directorStatus` operations and a `loadConfig` function for route and timeout discovery.

Algorithm:

1. **Init logging + load config** — `initLogging()` redirects output to `clean_restart.log`. `loadConfig()` reads `config.json` and provides the `routes` map and `exit_timeout` value used in subsequent phases. Config load failure is fatal.
2. **Stop server daemon** — shells out to `claude-slack-channel-bots stop`, which sends SIGTERM and escalates to SIGKILL after `stop_timeout` (see [stop command](#stop-command)).
3. **Exit sessions** — iterates `routingConfig.routes`. For each route, a `cliStatus` precheck is performed; if the spawn is already terminal or missing, the route is skipped. All routes are fanned out in parallel via `Promise.allSettled`. Per-session errors are caught and logged; they never abort the restart.
4. **Pause and poll** — for each live session, `directorPause(channelId)` requests a graceful exit. `directorStatus(channelId)` is then polled with exponential backoff (500 ms start, doubles each step, 5 s cap) for up to `exit_timeout` seconds (default 120 s). The session is considered exited when the poll returns `ErrSpawnNotFound` or state `ended`/`missing`. If the session does not exit within the timeout, `cliKill` is called.
5. **Start new server daemon** — shells out to `claude-slack-channel-bots start`.
6. **Exit** — a non-zero exit code from `start` is propagated and the process exits with that code.

### Graceful Shutdown

On `SIGTERM` or `SIGINT`, the shutdown handler calls `stopAllKeepAliveTimers()` and `cancelAllRestartTimers()` before tearing down Socket Mode and the HTTP server. All pending keep-alive and restart timers are cleared so no work fires during shutdown. The PID file (`STATE_DIR/server.pid`) is removed as the final step of shutdown.

## Configuration

### config.json (~/.claude/channels/slack/config.json)

Maps Slack channels to project directories. The session registry is keyed by `channelId`; CWD matching is used only at connection time to identify which route a new session belongs to.

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
- `claude_config_dir` — optional path to a Claude on-disk config directory used for managed sessions; when set, launches are prefixed with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the route authenticates against a specific account. `~` is expanded and the path is resolved to absolute. Per-route `routes[id].claude_config_dir` overrides this top-level value. When neither is set, Claude's own default applies.
- `resume_enabled` — boolean (default: `true`). When `false`, the session manager skips `--resume` entirely and always performs a fresh launch, even when a stored session ID exists. Use this to work around versions of Claude Code that crash on `--resume` (e.g. the v2.1.120 "sandbox required but unavailable" regression). Affects both startup (step 4, **Resume** branch) and auto-restart (step 6).

### sessions.json (~/.claude/channels/slack/sessions.json)

Persistent registry of server-managed sessions. Maps channel IDs to session records. Survives server restarts.

Each record has the shape:

```typescript
{
  tmuxSession:         string    // tmux session name (diagnostics only; lifecycle is owned by claude-director)
  lastLaunch:          string    // ISO-8601 timestamp of the most recent launch
  sessionId:           string    // Claude session UUID, or "pending"; used for --resume
  claude_instance_id?: string    // claude-director instance ID (e.g. cscb_C123); populated post-E2
}
```

`sessionId` is read from `sessions.json` by `spawnForRoute` when deciding whether to attempt `cliResume`. The UUID is passed as the basis for `--resume` in `claude-director resume`. The guards in `server.ts` treat `"pending"` as absent — no `--resume` is attempted for sessions that have not yet resolved their UUID.

`tmuxSession` is present in the schema for backwards compatibility and diagnostics; session lifecycle is owned by `claude-director`, not by CSCB tmux operations.

`sessions.json` is written once atomically after all routes finish launching at startup via `writeSessions()`. Individual route launches do not write to `sessions.json`.

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

Set by the session manager at launch time:

- `CLAUDE_MANAGED_CHANNEL` — previously used by hook scripts to route permission and ask relay requests; those hook scripts are deleted. The variable is no longer set by CSCB directly. Channel routing is now identified via the `channel` label on the `claude-director` spawn (set at spawn time via `--label channel=<channelId>`).

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

## Endpoint Inventory

### POST /interject

Injects a message directly into an active Claude session without going through Slack. Localhost-only.

**Request body** (JSON, max 32 KB)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | yes | Slack channel ID |
| `message` | string | yes | Message content to inject |
| `sender` | string | no | Display name; defaults to `"interject"` |

**Success response**

`200 OK` — `{ ok: true, channel, cwd }`

**Status codes**

| Status | Condition |
|--------|-----------|
| 200 | Notification delivered to session |
| 400 | Invalid JSON or missing required field (`channel`, `message`) |
| 403 | Non-localhost origin |
| 404 | Channel not found in `routingConfig.routes` |
| 405 | Non-POST method |
| 413 | Body exceeds 32 KB |
| 503 | No active session for the channel |

**Behavior**

- Looks up the channel in `routingConfig.routes`; 404 if absent
- Calls `getSessionByChannel()` to resolve the active session; 503 if none or not connected
- Sends `notifications/claude/channel` with `content: message` and `meta: { chat_id, message_id, user, ts }` (timestamps derived from `Date.now()`)
- Does not call `gate()`, the Slack API, or mutate `deliveredChannels`

## Security Model

- **Gate layer**: All inbound messages pass through `gate()` — drops bot messages, enforces DM policy, validates allowlist
- **Outbound scoping**: Each session can only send to channels it has received messages from (per-session `deliveredChannels` Set)
- **File exfiltration guard**: `assertSendable()` blocks uploading files from the state directory
- **Localhost restriction**: `/interject` endpoint only accepts requests from 127.0.0.1/::1/::ffff:127.* (the deleted `/permission` and `/ask` endpoints are no longer present)
- **AUQ denial**: `AskUserQuestion` is denied at the `claude-director` template level (`permissions = { deny = ["AskUserQuestion"] }`). No hook or relay handles AUQ.
- **Permission relay scoping**: Permission requests are scoped to `service=cscb`-labelled spawns. The poller filters by `--label service=cscb --state check_permission`; the click handler verifies `claudeInstanceId` is present in the live-prompts map before calling `cliDecide`.
