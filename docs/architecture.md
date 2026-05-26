# Internal Architecture

## System Overview

The Slack Channel Router is a two-way bridge between Slack and Claude Code sessions via Socket Mode + MCP HTTP (StreamableHTTP). Each Claude Code session connects to its own MCP Server instance, assigned to a Slack channel via routing config.

## Module Map

```
cli.ts                          CLI entry point — start/stop/clean_restart subcommands. clean_restart uses agent-director pause/kill/status verbs (SR-11 Event 12).
└── server.ts                   Main entry point — HTTP server, Socket Mode, message routing. Embeds the SR-5.1 startup gate, SR-3.2 template install, SR-1.6 orphan reconcile, SR-2.1 poller.
    ├── config.ts               Routing configuration — load, validate, defaults, tilde expansion. SR-4.1 agent_director_poll_interval_ms field. SR-4.2 unknown-field rejection.
    ├── registry.ts             Session registry — pending/registered sessions, MCP Server factory, transport routing. No session-id discovery (AD owns it).
    ├── lib.ts                  Pure utilities — gate, access control, chunking, sanitization.
    ├── logging.ts              Log file setup — overrides console.error/console.log with timestamped writeSync to a log file.
    ├── startup-errors.ts       SR-5.1a startup-errors log — append-only to ~/.claude/channels/slack/startup-errors.log + stderr.
    ├── agent-director-client.ts   SR-0.1 singleton Client wrapper. getClient()/closeClient(); MIN_AD_VERSION sourced from package.json.
    ├── agent-director-errors.ts   SR-0.2 typed Err* re-exports for instanceof branching.
    ├── agent-director-startup.ts  SR-5.1 startup gate — import / construct Client / version probe / same-user stat.
    ├── agent-director-template.ts SR-3.1 / SR-3.2 — builds the slack-channel-bot MakeTemplateParams and calls client.makeTemplate({ overwrite: true }) at boot.
    ├── session-manager.ts      SR-1 in full — spawnForRoute (SR-1.4 collision-then-act), reconcileOrphans (SR-1.6), reconnectMcp/waitForWaitingAndReconnect, postSpawnFailureToChannel.
    ├── permission-poller.ts    SR-2.1 polling loop + SR-2.2 Block Kit emitter. Owns the live LivePermission map shared with the click handler.
    ├── permission-click-handler.ts  SR-2.2 click → decide path; coordinates with the poller via finalizedAt claim window.
    ├── permission-action-id.ts SR-2.2 encode/decode helpers; anchored-regex parser (SR-8.6).
    ├── restart.ts              Auto-restart — delayed relaunch on disconnect, failure counting, timer cancellation.
    ├── health-check.ts         Periodic liveness poller — checks routes on a timer via client.status; schedules restarts for dead sessions.
    ├── pid.ts                  PID file management — write, read, conflict detection, isProcessRunning.
    ├── cozempic.ts             Optional cozempic CLI integration — path resolution helpers retained for downstream callers.
    ├── tokens.ts               Token loading — reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from env, validates prefixes.
    ├── ack-tracker.ts          In-memory ack reaction state.
    └── message-archive.ts      Optional SQLite archive of every inbound Slack message.
```

The deleted files from the pre-Epic-2 architecture (`src/tmux.ts`, `src/peer-pid.ts`, `src/sessions.ts`, `hooks/permission-relay.sh`, `hooks/ask-relay.sh`) are absent: agent-director owns the tmux integration and Claude session-id state, the SR-2.1 poller replaces the hook-based long-poll relay, and AskUserQuestion is denied at the template level (SR-3.1).

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

### Permission Relay (SR-2)

Driven by polling against the agent-director Client + Block Kit click → `decide()`. The previous HTTP long-poll + hook script architecture has been deleted.

1. agent-director moves a spawn into `check_permission` when Claude requests a tool permission. CSCB's poller (`permission-poller.ts`) runs `client.list({ state: ['check_permission'], label: ['service=cscb'] })` every `agent_director_poll_interval_ms` (default 1000 ms).
2. For each newly-seen `claude_instance_id`, `client.get(...)` returns the row's typed `permission_request` payload (`tool_name`, raw-JSON `tool_input`, integer `request_id`). The poller posts the SR-2.2 Block Kit message to the channel from the spawn's `channel` label and records the live entry `(messageTs, channelId, request_id)`.
3. Action IDs follow SR-2.2's shape `perm_(allow|deny)_<claude_instance_id>_<request_id>` (parsed by the anchored regex in `permission-action-id.ts`).
4. On click, `permission-click-handler.ts` claims the live entry (`finalizedAt = now()`), `client.get(...)` to verify the encoded `request_id` still matches the open prompt's, calls `client.decide({ claude_instance_id, decision })`, and `chat.update`s the Slack message to "Allowed/Denied by <user>". `ErrAlreadyDecided` is treated as success.
5. If a tracked instance drops out of the next list result (timeout / external decide / crash) and the `finalizedAt` claim is older than 30 s, the poller `chat.update`s the message to "expired" and removes the buttons.
6. Slack-side UX (Block Kit structure, decision-update text) is byte-identical to the pre-Epic-2 implementation. Only the action_id shape and the polling/decide machinery differ.

AskUserQuestion is denied at the agent-director template (SR-3.1's `deny: ['AskUserQuestion']`) — the tool is unavailable to every CSCB-spawned bot and the prior `/ask` HTTP route + hook script have been removed.

## Session Lifecycle

### Connection

1. Claude Code sends POST to `/mcp` (no session ID) → `initPendingSession()` creates a pending session
2. MCP handshake completes → `server.oninitialized` fires → `handleInitialized()` calls `roots/list`
3. CWD from roots is matched against `routingConfig.routes` → session promoted from pending to registered
4. Session receives messages from its assigned Slack channel
5. A keep-alive timer is started (`startSseKeepAlive`) that writes SSE comment frames (`:ping\n\n`) every ~30 s to prevent idle connection drops from proxies or load balancers

### Server-Managed Startup (SR-11 Event 1)

Called from `main()` in `server.ts`. The order is:

1. **SR-5.1 startup gate** — `runAgentDirectorStartupGate()` imports the library, constructs the singleton Client, runs `client.version()` + semver-gte against `MIN_AD_VERSION`, and stats `~/.agent-director/state.db` against `geteuid()`. Failure writes to `startup-errors.log` and exits non-zero.
2. **PID conflict check** — existing `checkPidConflict(PID_FILE)` invariant. CSCB enforces one instance per host.
3. **SR-3.2 template refresh** — `installSlackChannelBotTemplate(routingConfig)` builds the SR-3.1 `MakeTemplateParams` and calls `client.makeTemplate({ ..., overwrite: true })`. Atomic replacement is the library's responsibility (sibling-tempfile + `rename(2)`). Fatal on rejection.
4. **SR-1.6 orphan reconciliation** — `reconcileOrphans(routingConfig)`. `client.list({ label: ['service=cscb'] })` enumerates every CSCB spawn; rows whose `channel` label is missing or not in `routingConfig.routes` are killed + deleted. Per-orphan failure logged to `startup-errors.log` but does not block.
5. **Per-route reconcile** — `startupSessionManager(routingConfig, { concurrency: 3 })` iterates each configured route concurrently and calls `spawnForRoute` (SR-1.4 collision-then-act dispatcher):
   - Attempt `client.spawn(SR-1.1 params)` — `template: 'slack-channel-bot'`, `relay_mode: 'on'`, `label: ['service=cscb', 'channel=<id>']`, `claude_instance_id: cscb_<channelId>`, optional `extra_env.CLAUDE_CONFIG_DIR`.
   - On `ErrInstanceIdCollision`, call `client.get({claude_instance_id})` and branch on state per the [SR-11 substitution table](#sr-11-substitution-table):
     - `ended` / `missing` + `resume_enabled` → `client.resume(...)`; `ErrNoSessionId` / `ErrJsonlMissing` → `client.delete(...)` + fresh `client.spawn(...)`.
     - `ended` / `missing` + `resume_enabled=false` → `client.kill(...)` + `client.delete(...)` + fresh `client.spawn(...)`.
     - `waiting` → `client.sendKeys({ text: '/mcp reconnect slack-channel-router' })`.
     - `working` → poll `client.status(...)` until `waiting`, then sendKeys.
     - `pending` / `check_permission` / `ask_user` → no-op (poller picks it up).
   - `ErrSpawnNotFound` race after collision → single retry-spawn.
   - Other errors → `postSpawnFailureToChannel(channelId, error)` queues a Slack-channel post (drained after `socket.start()`).
6. **Slack auth + Socket Mode connect** — `web.auth.test()` resolves the bot user; `socket.start()` opens the WebSocket.
7. **SR-2.1 poller start** — `startPermissionPoller({ getClient, web, intervalMs: routingConfig.agent_director_poll_interval_ms })`. Single-threaded interval loop; skipped-tick WARN at 5+ consecutive skips.
8. **Drain pre-auth spawn-failure queue** — `flushSpawnFailureQueue(web)` posts any errors that surfaced during steps 1–5 to their configured channel.
9. **Health-check poller** — `startHealthCheck()` begins backstop liveness checks via `client.status(...)`.

CSCB does NOT maintain its own `sessions.json` registry. agent-director owns Claude session-id state internally, surfaced via `client.resume(...)` and the SR-11 state machine.

### Disconnection

1. Transport closes → `onsessionclosed` fires
2. Session removed from registry
3. `onsessionclosed` resolves the session's CWD back to a `channelId` via `routingConfig.routes`
4. If a `channelId` is found, `scheduleRestart(channelId, cwd)` is called

### Auto-Restart

After `scheduleRestart` is called:

1. **Delay check** — if `session_restart_delay` is 0, restart is skipped immediately.
2. **Failure guard** — if the channel has reached `MAX_CONSECUTIVE_FAILURES` (3), restart is abandoned.
3. **Timer** — a `setTimeout` fires after `session_restart_delay` seconds.
4. **Liveness check** — `isSessionAlive(channelId)` calls `client.status({claude_instance_id})` and returns true when the state is in `AGENT_DIRECTOR_LIVE_STATES`; `ErrSpawnNotFound` → dead. If alive, `reconnectSession()` calls `reconnectMcp(channelId)` which sends `/mcp reconnect slack-channel-router` via `client.sendKeys(...)`.
5. **Kill zombie** — `client.kill({claude_instance_id})` is best-effort; `ErrSpawnNotFound` is ignored.
6. **Relaunch** — `launchSession(channelId, cwd, routingConfig)` collapses `spawnForRoute`'s richer outcome to a boolean. Resume vs fresh is decided by the SR-1.4 collision-then-act dispatch (no separate `sessionId` arg from CSCB — agent-director owns resume state). On failure the per-channel failure counter increments.
7. **Success reset** — when a session successfully reconnects and registers, `resetFailureCounter()` clears the counter for that channel.

### Health-Check Poller

A periodic backstop that runs alongside the reactive disconnect path. Where `onsessionclosed` handles restarts after MCP disconnects, the health-check poller catches sessions that die without triggering a close event (e.g., an externally-killed tmux session).

On each tick:

1. **Route iteration** — for each `channelId`/`cwd` pair in `routingConfig.routes`:
   - **Skip if restart pending/active** — `isRestartPendingOrActive(channelId)` returns true; a relaunch is already in flight.
   - **Skip if max failures reached** — `hasReachedMaxFailures(channelId)` returns true; the channel has been abandoned.
   - **Liveness check** — `isSessionAlive(channelId)` calls `client.status({claude_instance_id})`; the state is checked against `AGENT_DIRECTOR_LIVE_STATES`.
2. **Dead session** — if the liveness check fails, `scheduleRestart(channelId, cwd)` is called, delegating to the same restart path used by `onsessionclosed`.

The interval is controlled by `health_check_interval` in `config.json`. If the value is `0`, `startHealthCheck()` returns immediately and no interval is created. `stopHealthCheck()` clears the interval during graceful shutdown, before `cancelAllRestartTimers()` runs.

**Ordering invariant**: `startHealthCheck()` is called only after `startupSessionManager()` returns. Moving it earlier in the startup sequence would risk the poller racing with in-progress launches.

### stop command

`stop` (CLI subcommand) sends SIGTERM to the running server via the PID file at `STATE_DIR/server.pid`. If the process does not exit within `stop_timeout` seconds (default 30 s, configurable in `config.json`), a SIGKILL is sent. A brief 2 s confirmation poll follows the SIGKILL. Stale PID files (process no longer running) are silently removed. A non-zero exit from this phase causes `stop` to exit 1.

### clean_restart (SR-11 Event 12)

`clean_restart` (CLI subcommand) stops the server daemon first, then concurrently pauses every managed Claude Code spawn via agent-director, then starts a fresh server. The stop-first ordering prevents the health-check poller and auto-restart logic from interfering with the teardown. It logs to `STATE_DIR/clean_restart.log` via `initLogging()`. `CliDeps` exposes injectable `directorStatus`, `directorPause`, and `directorKill` adapters (the production implementations call `getClient().status/pause/kill`).

Algorithm:

1. **Init logging + load config** — `initLogging()` redirects output to `clean_restart.log`. `loadConfig()` provides the `routes` map and `exit_timeout`. Config load failure is fatal.
2. **Stop server daemon** — shells out to `claude-slack-channel-bots stop`, which sends SIGTERM and escalates to SIGKILL after `stop_timeout`.
3. **Per-route precheck** — `directorStatus(channelId)` returns `null` on `ErrSpawnNotFound` (no row → skip); terminal states (`ended`, `missing`) → skip; otherwise proceed.
4. **Pause + poll** — `directorPause(channelId)` is called; if it rejects, escalate immediately to `directorKill(channelId)`. After a successful pause, `directorStatus(channelId)` is polled with exponential backoff (100 ms start, capped at 2 s, total budget `exit_timeout`). The first poll observing `null` / `ended` / `missing` is treated as clean exit. If the budget is exhausted, `directorKill(channelId)` force-terminates the spawn.
5. **Start new server daemon** — shells out to `claude-slack-channel-bots start`.
6. **Exit** — a non-zero exit code from `start` is propagated and the process exits with that code.

Per-channel polling cadence (100 ms → 2 s cap, `exit_timeout` total) is unrelated to the SR-2.1 permission poller's `agent_director_poll_interval_ms`.

### Graceful Shutdown (SR-11 Event 11)

On `SIGTERM` or `SIGINT`, the shutdown handler:
1. Flips the `shuttingDown` flag (idempotent guard).
2. Calls `stopPermissionPoller()` to stop the SR-2.1 tick.
3. Calls `stopHealthCheck()`, `cancelAllRestartTimers()`, `stopAllKeepAliveTimers()`.
4. Stops the HTTP server, drains pending + active MCP transports.
5. Disconnects Socket Mode.
6. Calls `closeClient()` inside a try/catch to release the agent-director Client handle. The library's `close()` is idempotent and never throws; the catch is belt-and-suspenders.
7. Removes the PID file.

The bots themselves are NOT killed or paused on shutdown — same as the prior behavior and consistent with SR-11 Event 11.

## SR-11 Substitution Table

State transitions and event triggers follow `t1.qfc.bg` SR-11 in full. Where the predecessor SRD references a CLI verb, this implementation calls the equivalent typed library method:

| `t1.fp3.63` CLI verb | This implementation's library equivalent |
|---|---|
| `claude-director spawn` | `client.spawn(SpawnParams)` |
| `claude-director resume` | `client.resume({ claude_instance_id })` |
| `claude-director kill` | `client.kill({ claude_instance_id })` |
| `claude-director pause` | `client.pause({ claude_instance_id })` |
| `claude-director delete` | `client.delete({ claude_instance_id: [...] })` |
| `claude-director list --label/--state` | `client.list({ label, state })` |
| `claude-director get` | `client.get({ claude_instance_id })` |
| `claude-director status` | `client.status({ claude_instance_id })` |
| `claude-director send-keys` | `client.sendKeys({ claude_instance_id, text })` |
| `claude-director decide` | `client.decide({ claude_instance_id, decision })` |
| `claude-director version` | `client.version({})` |
| `claude-director find-missing` | `client.findMissing({ timeout_ms })` — operator's responsibility (SR-5.4); CSCB does not invoke. |

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
- `claude_config_dir` — optional path to a Claude on-disk config directory used for managed sessions; when set, launches are prefixed with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the route authenticates against a specific account. `~` is expanded and the path is resolved to absolute. Per-route `routes[id].claude_config_dir` overrides this top-level value. When neither is set, Claude's own default applies.
- `resume_enabled` — boolean (default: `true`). When `false`, the session manager skips `--resume` entirely and always performs a fresh launch, even when a stored session ID exists. Use this to work around versions of Claude Code that crash on `--resume` (e.g. the v2.1.120 "sandbox required but unavailable" regression). Affects both startup (step 4, **Resume** branch) and auto-restart (step 6).

### agent-director state.db (~/.agent-director/state.db)

Persistent CSCB-spawn registry — owned by agent-director, not CSCB. CSCB reads this transitively via `client.list/status/get/resume(...)`. Same-user invariant verified at SR-5.1 startup gate.

### startup-errors.log (~/.claude/channels/slack/startup-errors.log)

Append-only log of fatal startup errors written by `recordStartupError` (`src/startup-errors.ts`). One timestamped line per entry; includes the agent-director `errName` when surfacing typed library errors. Rotation is operator-owned via `docs/logrotate-startup-errors.conf`.

### Removed pre-Epic-2 files

The previous tmux-direct architecture wrote `~/.claude/channels/slack/sessions.json` to persist tmux session names and discovered Claude session UUIDs. Both responsibilities have moved to agent-director — `sessions.json` and `sessions.json.last` no longer exist. Operators upgrading from a pre-Epic-2 install can safely delete the stale files; CSCB will not read them.

### server.pid (STATE_DIR/server.pid)

Written at startup with the server's process ID. Used by the CLI `stop` command to send SIGTERM (with SIGKILL escalation after `stop_timeout`) to a running server, and by startup to detect a conflicting already-running instance. Removed on graceful shutdown.

### Environment Variables

Required at startup:

- `SLACK_BOT_TOKEN` — bot user OAuth token; must begin with `xoxb-`
- `SLACK_APP_TOKEN` — app-level token for Socket Mode; must begin with `xapp-`

Both values are read directly from the process environment. When `SLACK_DRY_RUN` is set (see below), `loadTokens()` returns dummy values (`xoxb-dry-run` / `xapp-dry-run`) and validation is skipped.

Optional:

- `SLACK_DRY_RUN` — set to `1`, `true`, or `yes` to enable dry-run mode. Bypasses token validation, skips `socket.start()` and `web.auth.test()`, and stubs all MCP tool calls (`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`) — each returns a `[dry-run]` placeholder and logs the call to the server log. The HTTP/MCP server still starts normally so Claude Code sessions can connect and exercise tool calls without a Slack workspace.

Optional CLAUDE_CONFIG_DIR (set at spawn time via SpawnParams.extra_env when configured per-route or top-level) is propagated by agent-director to the spawn's tmux session, enabling per-route Claude account selection.

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
- **Localhost restriction**: `/permission`, `/ask`, and `/interject` endpoints only accept requests from 127.0.0.1/::1/::ffff:127.*
- **Session scope guard**: The permission relay hooks (`permission-relay.sh`, `ask-relay.sh`) are no-ops outside bot-managed sessions. They check the `CLAUDE_MANAGED_CHANNEL` inline env var — set at launch without `export`, so it propagates to child processes (subagents) but not to tmux split-panes or separate sessions. If the variable is absent, hooks exit silently. If present but the server is unreachable, hooks fail closed (deny) to prevent indefinite hangs in headless sessions.
