# Claude Slack Channel Bots

A single HTTP MCP server that holds one Slack Socket Mode connection and routes messages to multiple independent Claude Code sessions, each scoped to a different repo and reachable via its own Slack channel. Inbound messages are dispatched to whichever session owns the channel they arrived on; outbound tool calls are restricted to channels that session has previously received a message from.

---

## Quick Start

1. **Install globally via bun:**

   ```sh
   bun install -g claude-slack-channel-bots
   ```

   The postinstall script creates skeleton config files in `~/.claude/channels/slack/`.

2. **Run the setup skill:**

   The package includes a Claude Code skill at `skills/setup-slack-channel-bots/` that walks you through the entire configuration. Copy or symlink it into `~/.claude/skills/`, then run:

   ```sh
   claude /setup-slack-channel-bots
   ```

   It handles Slack app creation, tokens, routing, access control, hooks, and validation — and skips anything already configured.

3. **Start the server:**

   ```sh
   claude-slack-channel-bots start
   ```

See the sections below for manual configuration details if you prefer not to use the skill.

---

## Prerequisites

- [Bun](https://bun.sh) `>= 1.0.21` (agent-director minimum)
- [tmux](https://github.com/tmux/tmux) (required for server-managed sessions)
- [Claude Code](https://claude.ai/code) installed and authenticated
- [`agent-director`](https://github.com/gabemahoney/agent-director) **runtime dependency** — pulled in transitively when you install this package. Hard required at server boot: CSCB refuses to start if the library is missing, the host platform is unsupported, Bun is too old, or the installed version is below `MIN_AD_VERSION` (`^0.4.3`).
- `ss` from [iproute2](https://github.com/iproute2/iproute2) on your `PATH` (required for session ID discovery; pre-installed on most Linux distributions)
- `curl` and `jq` on your `PATH` (required for the permission relay hooks)
- Slack workspace admin access (to create and configure the Slack app)
- **cozempic** (optional) — Python 3.10+ and `pip install cozempic` — enables session file cleaning before `--resume` for faster load times

### Supported platforms (inherited from agent-director)

| Platform | Status |
|---|---|
| `linux-x64` | Supported |
| `darwin-arm64` (Apple Silicon Mac) | Supported |
| `linux-arm64` | **Not supported** by agent-director |
| `darwin-x64` (Intel Mac) | **Not supported** by agent-director |
| Windows | **Not supported** by agent-director |

If the host is unsupported, the SR-5.1 startup gate exits non-zero at server boot with a typed error from agent-director (`ErrPlatformPackageMissing` or `ErrUnsupportedPlatform`) and writes the failure to `~/.claude/channels/slack/startup-errors.log` and stderr. See [Startup errors](#startup-errors) below.

> **Note on agent-director versions.** v0.4.1 is a zombie release (the published tarball is missing `dist/` and cannot be imported). v0.4.2 lacks the `MakeTemplateParams.overwrite` field CSCB needs for the boot-time template refresh. CSCB pins `^0.4.3` to get past both.

---

## Configuration

### Environment Variables

Tokens and runtime options are read from environment variables. There is no `.env` file — export these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Required. Granted by the OAuth install flow. |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`). Required. Generated under Basic Information → App-Level Tokens with the `connections:write` scope. |
| `SLACK_STATE_DIR` | Override the directory where `config.json`, `access.json`, and runtime state are stored. Defaults to `~/.claude/channels/slack`. |
| `SLACK_ACCESS_MODE` | Set to `static` to load `access.json` once at startup and cache it for the lifetime of the process rather than re-reading it on every event. Useful in high-throughput environments where disk reads are a concern. |
| `SLACK_DRY_RUN` | Set to `1` to start the server without Slack credentials. Token validation is skipped, Socket Mode and `web.auth.test()` are not called, and MCP tool calls (`reply`, `react`, etc.) are logged instead of sent. Useful for integration testing. |

Shell profile example:

```sh
export SLACK_BOT_TOKEN=xoxb-your-bot-token
export SLACK_APP_TOKEN=xapp-your-app-token
# Optional overrides:
export SLACK_STATE_DIR=~/.config/slack-channel-bots
export SLACK_ACCESS_MODE=static
# Dry-run mode (no Slack credentials needed):
export SLACK_DRY_RUN=1
```

---

### Routing (config.json)

`config.json` is read from `~/.claude/channels/slack/config.json` by default. Override the directory with `SLACK_STATE_DIR`.

A skeleton file is created by postinstall. Populate it before running `start`.

#### Complete example

```json
{
  "routes": {
    "C0123456789": { "cwd": "~/projects/alpha" },
    "C9876543210": { "cwd": "~/projects/beta" }
  },
  "default_route": "~/projects/alpha",
  "default_dm_session": "~/projects/alpha",
  "bind": "127.0.0.1",
  "port": 3100,
  "session_restart_delay": 60,
  "health_check_interval": 120,
  "exit_timeout": 120,
  "stop_timeout": 30,
  "mcp_config_path": "~/.claude/slack-mcp.json",
  "cozempic_prescription": "standard"
}
```

#### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `routes` | object | required | Map of Slack channel ID → route entry. Each entry requires a `cwd` field: the working directory for that session. Used to identify sessions via `roots/list` after MCP handshake. `~` is expanded. Each `cwd` must be unique across all routes. May also include an optional `claude_config_dir` string (see below). |
| `default_route` | string | — | CWD path to use when a message arrives on a channel with no explicit entry in `routes`. Must match an existing route `cwd`. Channels that are in `routes` but whose session is not yet registered have their messages dropped — they do not fall back to `default_route`. |
| `default_dm_session` | string | — | CWD path of the session that handles direct messages. Must match an existing route `cwd`. |
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | number | `60` | Seconds to wait before auto-restarting a dead session. Set to `0` to disable auto-restart. Must be non-negative. |
| `health_check_interval` | number | `120` | Seconds between periodic liveness polls. Set to `0` to disable. Must be non-negative. |
| `exit_timeout` | number | `120` | Seconds to wait for a managed Claude Code session to exit gracefully during `clean_restart` before force-killing its tmux session. |
| `stop_timeout` | number | `30` | Seconds to wait for the server process to exit after `SIGTERM` before escalating to `SIGKILL`. |
| `mcp_config_path` | string | `~/.claude/slack-mcp.json` | Path to the MCP config file passed to Claude Code when launching managed sessions. |
| `append_system_prompt_file` | string | — | Path to a file appended to every managed session's system prompt via `--append-system-prompt-file`. Missing file silently skipped. See `skills/EXAMPLE_CLAUDE.md` for a template. |
| `system_prompt_mode` | string | `"append"` | Controls how `append_system_prompt_file` is applied. `"append"`: the custom prompt file is appended on top of `CLAUDE.md` (default, current behavior). `"none"`: only `CLAUDE.md` is used; `append_system_prompt_file` is ignored even if set. Use `"none"` when the project's `CLAUDE.md` already contains everything the bot needs. |
| `cozempic_prescription` | string | `"standard"` | Cozempic cleaning intensity before resume. Valid values: `gentle`, `standard`, `aggressive`. Has no effect if cozempic is not installed. |
| `message_archive_db` | string | — | Path to a SQLite DB where every inbound Slack message is archived in real time. Parent directories are created if missing; schema is initialized on first open. Compatible with the `archive-messages.py` backfill script — both can write concurrently. Feature is disabled when absent. |
| `claude_config_dir` | string | — | Path to a Claude on-disk config directory. When set, managed sessions launch with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the bot authenticates against a specific account. `~` is expanded and the path is resolved to absolute. Per-route `routes[id].claude_config_dir` overrides this top-level value for individual channels. When neither is set, Claude's own default applies. Must be non-empty when set. |
| `resume_enabled` | boolean | `true` | When `false`, the session manager always performs a fresh Claude session launch instead of resuming, both on startup and on runtime auto-restart, even when a stored session ID exists. Disabling this skips the `--resume` flag entirely. Use this as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on `--resume` (a known regression in v2.1.120). |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. Replaces the pre-rename `claude_director_poll_interval_ms` — the old name is rejected at startup. Unknown top-level config fields are also rejected to surface stale configs after the rename. |

#### Per-route `claude_config_dir` override

When you want different bot sessions to authenticate as different Claude accounts (e.g. one channel runs as a personal Max account, another as a corporate account), set `claude_config_dir` on the individual route. Per-route values take priority over the top-level `claude_config_dir`; routes without their own override fall back to the top-level value.

```json
{
  "routes": {
    "C_PERSONAL": {
      "cwd": "~/projects/alpha",
      "claude_config_dir": "~/.claude-maxauth"
    },
    "C_CORPORATE": {
      "cwd": "~/projects/beta"
    }
  },
  "claude_config_dir": "~/.claude-corp"
}
```

`C_PERSONAL` launches with the Max account; `C_CORPORATE` falls through to the top-level value and uses the corporate account. Use `claude auth login --claudeai` (or `--console`) with `CLAUDE_CONFIG_DIR` set to the same directory to populate each config dir before starting the server.

---

### Access Control (access.json)

`access.json` is read from `~/.claude/channels/slack/access.json` by default (same directory as `config.json`). A skeleton file with defaults is created by postinstall. The file is written with `0600` permissions.

Channels in `config.json` are automatically allowed — you do not need to list them here. The `channels` map is only needed for per-channel overrides like requiring @mentions or restricting which users can trigger the bot.

The `slack-channel-access` skill manages pairings and allowlist entries at runtime.

#### Complete example

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["U0123456789"],
  "channels": {
    "C9876543210": {
      "requireMention": true,
      "allowFrom": ["U0123456789", "U9876543210"]
    }
  },
  "pending": {},
  "ackReaction": "eyes",
  "textChunkLimit": 3000,
  "chunkMode": "newline"
}
```

#### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"disabled"` | `"pairing"` | Controls who can DM the bot. `pairing`: unknown users receive a one-time code and are added to `allowFrom` after verification. `allowlist`: only users in `allowFrom` are accepted. `disabled`: all DMs are dropped. |
| `allowFrom` | string[] | `[]` | Slack user IDs allowed to DM the bot unconditionally (regardless of `dmPolicy`). |
| `channels` | object | `{}` | Optional per-channel overrides. Channels in `config.json` are allowed automatically — only add entries here to customize behavior (e.g. require @mention or restrict users). Each entry is a `ChannelPolicy`. |
| `channels[id].requireMention` | boolean | `false` | When `true`, messages in that channel are only delivered if the bot is `@mentioned`. |
| `channels[id].allowFrom` | string[] | `[]` | When non-empty, restricts delivery to the listed Slack user IDs for that channel. |
| `pending` | object | `{}` | Managed by the server. Stores in-flight pairing codes indexed by code string. Do not edit manually. |
| `ackReaction` | string | — | Emoji name (without colons) to react with when a message is received and dispatched. Automatically removed when the bot sends its first reply. |
| `textChunkLimit` | number | — | Maximum character count per Slack message when chunking long replies. Controlled by the `reply` tool. |
| `chunkMode` | `"length"` \| `"newline"` | — | How to split overlong replies. `length`: hard split at `textChunkLimit` characters. `newline`: split at newline boundaries without exceeding `textChunkLimit`. |

---

### MCP Server Config (slack-mcp.json)

Claude Code sessions need a config file pointing at the MCP server. A skeleton is created by postinstall at `~/.claude/slack-mcp.json`.

```json
{
  "mcpServers": {
    "slack-channel-router": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

If you changed `port` or `bind` in `config.json`, update the `url` here to match. The server-managed session launcher uses `mcp_config_path` from `config.json` to locate this file.

---

## CLI Reference

The `claude-slack-channel-bots` binary exposes three subcommands.

### `claude-slack-channel-bots start`

Checks prerequisites, then daemonizes the server.

**Prerequisite checks (in order):**

1. `tmux` is on `PATH` — fails with `missing prerequisite: tmux` if not found.
2. `SLACK_BOT_TOKEN` is set — fails with `missing prerequisite: SLACK_BOT_TOKEN environment variable` if absent.
3. `SLACK_APP_TOKEN` is set — fails with `missing prerequisite: SLACK_APP_TOKEN environment variable` if absent.
4. `config.json` exists at `STATE_DIR/config.json` — fails with the full path if not found.

If all checks pass, the parent process spawns a detached child process and exits immediately, printing the child PID. The child starts the server and writes its PID to `STATE_DIR/server.pid`. Conversation context is preserved across server restarts when possible.

```
[slack] Server starting in background (PID 12345)
```

### `claude-slack-channel-bots stop`

Reads `STATE_DIR/server.pid` and sends `SIGTERM` to the process.

Behavior by case:

- **PID file missing:** prints `server is not running` and exits 0.
- **Stale PID file** (process no longer running): removes the PID file, prints `server is not running (removed stale PID file)`, exits 0.
- **Live process:** sends `SIGTERM`, polls for exit for up to `stop_timeout` seconds (default 30s). Prints `[slack] Server stopped.` on clean exit. Escalates to `SIGKILL` if the process does not exit within `stop_timeout`.

### `claude-slack-channel-bots clean_restart`

Gracefully exits all managed Claude Code sessions, then stops and starts the server.

```sh
claude-slack-channel-bots clean_restart
```

For each session in `sessions.json`, sends `/exit` to the tmux session and polls until Claude exits. All sessions are processed in parallel. If a session does not exit within `exit_timeout` seconds (default 120s), its tmux session is force-killed. Individual session errors are logged and do not abort the restart. After the server restarts, sessions are relaunched using the stored session IDs in `sessions.json`. When `resume_enabled` is `true` (the default), sessions resume with `--resume`, preserving conversation context. When `resume_enabled` is `false`, sessions always launch fresh without `--resume`.

Behavior by case:

- **No sessions.json or no sessions:** skips the shutdown phase and proceeds directly to stop/start.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.

### PID file

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.claude/channels/slack/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

### Direct invocation for development

Skip the CLI and run the server directly with Bun for development or debugging:

```sh
bun server.ts
```

On startup the server prints the MCP endpoint and example config:

```
[slack] Loaded routing config: 2 route(s)
[slack] Socket Mode connected
[slack] MCP server listening on http://127.0.0.1:3100/mcp

{
  "mcpServers": {
    "slack-channel-router": { "type": "http", "url": "http://127.0.0.1:3100/mcp" }
  }
}
```

---

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to a Slack channel or DM. Auto-chunks long text according to `textChunkLimit` and `chunkMode` in `access.json`. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message. |
| `edit_message` | Edit a previously sent message (bot's own messages only). |
| `fetch_messages` | Fetch message history from a channel or thread. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message. Saves files to `STATE_DIR/inbox/`. Returns local file paths. |

---

## Interject

POST to `/interject` to inject a message into an active Claude session from localhost. Only requests from `127.0.0.1` or `::1` are accepted — external callers are rejected with 403.

### Request

```sh
curl -X POST http://localhost:<port>/interject \
  -H "Content-Type: application/json" \
  -d '{"channel": "C1234567890", "message": "Hello from a script", "sender": "my-cron-job"}'
```

| Field | Required | Description |
|---|---|---|
| `channel` | yes | Slack channel ID matching an entry in `config.json → routes`. |
| `message` | yes | Text to inject into the session. |
| `sender` | no | Label attached to the injected message. Defaults to `"interject"`. |

### Response

On success, returns HTTP 200:

```json
{ "ok": true, "channel": "C1234567890", "cwd": "/path/to/session" }
```

### Error conditions

| Status | Meaning |
|---|---|
| 400 | Invalid JSON or missing required field (`channel` or `message`). |
| 403 | Request did not originate from localhost. |
| 404 | Channel not found in `config.json → routes`. |
| 405 | Must use POST method. |
| 413 | Request body exceeds 32KB. |
| 503 | Channel is routed but no active session is connected. |

### Example: crontab reminder

```sh
# crontab -e
0 9 * * 1 curl -s -X POST http://localhost:3100/interject \
  -H "Content-Type: application/json" \
  -d '{"channel": "C1234567890", "message": "Weekly reminder: update the changelog before standup.", "sender": "cron"}'
```

---

## Permission Relay

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. The Claude Code hook POSTs the pending request to the server, then long-polls for the user's response. Once the user clicks a button, the result is returned to Claude Code and execution continues.

The `ask-relay.sh` hook intercepts `AskUserQuestion` tool calls via `PreToolUse`, posts the question and its options to Slack as interactive buttons, and waits for the user's selection. The answer is returned to Claude Code via `updatedInput` without blocking the TUI.

Both hooks are **scope-guarded**: they check the `CLAUDE_MANAGED_CHANNEL` environment variable, which is set as an inline env var (no `export`) on the `claude` command at launch. If the variable is absent, the hooks exit silently (no-op). This means installing the hooks globally in `settings.json` is safe — they will not activate for Claude sessions you run outside the bot. If the variable is present but the server is unreachable, hooks fail closed (deny the tool call) to prevent indefinite hangs in headless sessions.

Both hooks use a **two-phase long-poll protocol**:

1. **Phase 1 — Create request:** The hook POSTs to `/permission` (or `/ask`) with the tool name, input, and channel ID (from `$CLAUDE_MANAGED_CHANNEL`). The server posts an interactive Slack message and returns a `requestId`.
2. **Phase 2 — Long-poll:** The hook GETs `/permission/{requestId}` (or `/ask/{requestId}`) in a loop with a 90-second `curl` timeout. The server holds the connection for up to 60 seconds waiting for a button click, then returns `{"status":"pending"}` if no decision has arrived. The hook retries immediately. Once the user clicks, the server returns `{"status":"decided","decision":"allow"|"deny"}` and the hook exits.

### Slack app prerequisites

The Slack app must have **interactivity enabled** with **Socket Mode** as the delivery method. Without this, button-click payloads are never delivered and the relay will not work.

To enable it: open your Slack app config → **Interactivity & Shortcuts** → toggle **Interactivity** on. No Request URL is needed — Socket Mode delivers interaction payloads over the existing socket connection. This is included automatically if you created the app from `slack-app-manifest.yml`.

### Hook installation

1. Copy the hook scripts from the repo to `~/.claude/hooks/`:

   ```sh
   cp hooks/permission-relay.sh hooks/ask-relay.sh ~/.claude/hooks/
   chmod +x ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh
   ```

   Alternatively, symlink them so updates to the repo are reflected automatically:

   ```sh
   ln -sf /path/to/repo/hooks/permission-relay.sh ~/.claude/hooks/permission-relay.sh
   ln -sf /path/to/repo/hooks/ask-relay.sh ~/.claude/hooks/ask-relay.sh
   ```

2. Ensure `curl` and `jq` are on your `PATH`.

3. Add the following to your Claude Code `settings.json`:

   ```jsonc
   "PermissionRequest": [
     {
       "matcher": ".*",
       "timeout": 2000000,
       "hooks": [{ "type": "command", "command": "~/.claude/hooks/permission-relay.sh" }]
     }
   ],
   "PreToolUse": [
     {
       "matcher": "AskUserQuestion",
       "timeout": 2000000,
       "hooks": [{ "type": "command", "command": "~/.claude/hooks/ask-relay.sh" }]
     }
   ]
   ```

   `permission-relay.sh` relays tool permission requests (Allow/Deny) to Slack via `PermissionRequest`. `ask-relay.sh` relays `AskUserQuestion` calls to Slack via `PreToolUse`, returning the user's selection without blocking the TUI.

Both hooks auto-detect the server port from `config.json`. They read `${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/config.json` and use the `port` field (defaulting to `3100`), so they stay in sync if you change the port in routing config.

### Setup skill

The `update-config` skill can automate hook installation. It copies or symlinks the hooks and writes the `settings.json` entries in one step — use it if you prefer not to configure hooks manually.

---

## Troubleshooting

**Missing environment variables**
`start` exits with `missing prerequisite: SLACK_BOT_TOKEN environment variable` or `SLACK_APP_TOKEN environment variable`. Export both tokens in your shell profile and open a new terminal before running `start`.

**config.json not found**
`start` exits with `missing prerequisite: config.json not found at <path>`. Run `bun postinstall.ts` to create a skeleton, or create the file manually. Verify `SLACK_STATE_DIR` matches the directory you populated.

**config.json CWD mismatch**
If a Claude Code session connects but immediately disconnects, the session's actual CWD does not match any `cwd` in `config.json`. Confirm the session's working directory matches the entry exactly (after tilde expansion). Duplicate CWDs across multiple routes are rejected at startup.

**Bot not receiving messages in a new channel**
After inviting the bot to a channel, Slack may not deliver messages until the bot is @mentioned for the first time. This is a Slack Socket Mode behavior — the first @mention activates event delivery for that channel. After that, all messages flow normally regardless of `requireMention` settings.

**Channel not in access.json**
Messages to channels not listed in `access.json → channels` and not present in `config.json → routes` are silently dropped. Use the `claude-slack-channels-config` skill or edit `access.json` directly to add the channel ID with a `ChannelPolicy` entry.

**Permission relay not working**
Check that the Slack app has interactivity enabled (Interactivity & Shortcuts → toggle on). Verify `curl` and `jq` are on your `PATH`. Confirm the hook scripts are executable (`chmod +x`). If the port was changed in `config.json`, ensure `SLACK_STATE_DIR` is set correctly so the hooks can read the updated port. If the hooks are silently doing nothing, confirm the session was launched by the server — the hooks check the `CLAUDE_MANAGED_CHANNEL` env var and exit silently if it is not set. Sessions launched manually will not have this variable and will not trigger the relay.

**Session not restarting after crash**
After 3 consecutive launch failures for a route, auto-restart is suspended until the server is restarted. Restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`. To disable auto-restart entirely, set `session_restart_delay` to `0` in `config.json`.

**Session stuck during clean_restart**
If a session does not exit within `exit_timeout` seconds (default 120s), `clean_restart` force-kills its tmux session and proceeds. To manually recover, run `tmux kill-session -t <session-name>` for any remaining sessions, then `claude-slack-channel-bots stop && claude-slack-channel-bots start`.

**Session crashes on resume with "sandbox required but unavailable"**
This is a known regression in certain Claude Code releases (e.g. v2.1.120) where `--resume` triggers a sandbox check that fails in headless environments. Set `resume_enabled: false` in `config.json` to disable `--resume` entirely — the bot will always start a fresh Claude session instead of resuming a prior conversation, both on startup and on runtime auto-restart:

```json
{
  "routes": { ... },
  "resume_enabled": false
}
```

---

## Startup errors

CSCB writes fatal startup errors to `~/.claude/channels/slack/startup-errors.log` (override the directory with `SLACK_STATE_DIR`) in addition to stderr. Each entry is a single timestamped line. The file is append-only and never rotated by CSCB — copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` if you want host-level rotation.

Classes you may see:

- `ad-platform-package-missing` — agent-director's platform-native peer dependency is absent. The host is unsupported by agent-director.
- `ad-unsupported-platform` — agent-director's runtime check rejected the host's `process.platform`/`process.arch` tuple.
- `ad-bun-version-too-old` — agent-director needs Bun `>= 1.0.21`. Upgrade Bun.
- `ad-version-probe` — `agent-director` was loaded but the `version()` probe failed (FFI handle, native lib, etc.).
- `ad-version-stale` — installed `agent-director` is below the minimum version this CSCB requires. Run `bun add agent-director@^<minimum>`.
- `ad-same-user` — `~/.agent-director/state.db` is owned by a different UID than the CSCB process. Reinstall agent-director as the correct user or remove the mismatched file.
- `ad-same-user-stat` — Non-ENOENT stat error on the state DB (permissions, I/O). Investigate the file before re-launching.
- `ad-template-install` — `client.makeTemplate(...)` rejected the boot-time refresh of the `slack-channel-bot` template. The line includes the agent-director `errName`.

---

## Migration

> **Stub (finalized in Epic 2).** Epic 1 has wired CSCB onto the typed `agent-director` library at boot — every install now pulls AD in transitively, the SR-5.1 startup gate runs before anything else, and the SR-3.2 template refresh writes `~/.agent-director/templates/slack-channel-bot.toml` on every boot. The spawn path and the permission-relay path are unchanged in Epic 1; they still use the homegrown tmux + HTTP long-poll code and continue to work byte-identically. Epic 2 atomically swaps both paths onto the library and finalizes this section with the full operator migration checklist (remove old hooks, configure AD's `find-missing` sweep, rename `claude_director_poll_interval_ms`, etc).

