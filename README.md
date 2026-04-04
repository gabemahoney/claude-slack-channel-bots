# Slack Channel Router

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

- [Bun](https://bun.sh) v1.0+
- [tmux](https://github.com/tmux/tmux) (required for server-managed sessions)
- [Claude Code](https://claude.ai/code) installed and authenticated
- `ss` from [iproute2](https://github.com/iproute2/iproute2) on your `PATH` (required for session ID discovery; pre-installed on most Linux distributions)
- `curl` and `jq` on your `PATH` (required for the permission relay hooks)
- Slack workspace admin access (to create and configure the Slack app)

---

## Configuration

### Environment Variables

Tokens and runtime options are read from environment variables. There is no `.env` file — export these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Required. Granted by the OAuth install flow. |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`). Required. Generated under Basic Information → App-Level Tokens with the `connections:write` scope. |
| `SLACK_STATE_DIR` | Override the directory where `routing.json`, `access.json`, and runtime state are stored. Defaults to `~/.claude/channels/slack`. |
| `SLACK_ACCESS_MODE` | Set to `static` to load `access.json` once at startup and cache it for the lifetime of the process rather than re-reading it on every event. Useful in high-throughput environments where disk reads are a concern. |

Shell profile example:

```sh
export SLACK_BOT_TOKEN=xoxb-your-bot-token
export SLACK_APP_TOKEN=xapp-your-app-token
# Optional overrides:
export SLACK_STATE_DIR=~/.config/slack-channel-bots
export SLACK_ACCESS_MODE=static
```

---

### Routing (routing.json)

`routing.json` is read from `~/.claude/channels/slack/routing.json` by default. Override the directory with `SLACK_STATE_DIR`.

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
  "mcp_config_path": "~/.claude/slack-mcp.json"
}
```

#### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `routes` | object | required | Map of Slack channel ID → route entry. Each entry requires a `cwd` field: the working directory for that session. Used to identify sessions via `roots/list` after MCP handshake. `~` is expanded. Each `cwd` must be unique across all routes. |
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

---

### Access Control (access.json)

`access.json` is read from `~/.claude/channels/slack/access.json` by default (same directory as `routing.json`). A skeleton file with defaults is created by postinstall. The file is written with `0600` permissions.

Channels in `routing.json` are automatically allowed — you do not need to list them here. The `channels` map is only needed for per-channel overrides like requiring @mentions or restricting which users can trigger the bot.

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
| `channels` | object | `{}` | Optional per-channel overrides. Channels in `routing.json` are allowed automatically — only add entries here to customize behavior (e.g. require @mention or restrict users). Each entry is a `ChannelPolicy`. |
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

If you changed `port` or `bind` in `routing.json`, update the `url` here to match. The server-managed session launcher uses `mcp_config_path` from `routing.json` to locate this file.

---

## CLI Reference

The `claude-slack-channel-bots` binary exposes three subcommands.

### `claude-slack-channel-bots start`

Checks prerequisites, then daemonizes the server.

**Prerequisite checks (in order):**

1. `tmux` is on `PATH` — fails with `missing prerequisite: tmux` if not found.
2. `SLACK_BOT_TOKEN` is set — fails with `missing prerequisite: SLACK_BOT_TOKEN environment variable` if absent.
3. `SLACK_APP_TOKEN` is set — fails with `missing prerequisite: SLACK_APP_TOKEN environment variable` if absent.
4. `routing.json` exists at `STATE_DIR/routing.json` — fails with the full path if not found.

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

For each session in `sessions.json`, sends `/exit` to the tmux session and polls until Claude exits. All sessions are processed in parallel. If a session does not exit within `exit_timeout` seconds (default 120s), its tmux session is force-killed. Individual session errors are logged and do not abort the restart. After the server restarts, sessions are relaunched with `--resume` using the stored session IDs in `sessions.json`, preserving conversation context.

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

## Permission Relay

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. The Claude Code hook POSTs the pending request to the server, then long-polls for the user's response. Once the user clicks a button, the result is returned to Claude Code and execution continues.

The `ask-relay.sh` hook intercepts `AskUserQuestion` tool calls via `PreToolUse`, posts the question and its options to Slack as interactive buttons, and waits for the user's selection. The answer is returned to Claude Code via `updatedInput` without blocking the TUI.

Both hooks are **scope-guarded**: they check for the `SLACK_CHANNEL_BOT_SESSION` environment variable and exit immediately (no-op) if it is not set. The server sets this variable on every Claude session it launches. This means installing the hooks globally in `settings.json` is safe — they will not activate for Claude sessions you run outside the bot.

Both hooks use a **two-phase long-poll protocol**:

1. **Phase 1 — Create request:** The hook POSTs to `/permission` (or `/ask`) with the tool name, input, and CWD. The server posts an interactive Slack message and returns a `requestId`.
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

Both hooks auto-detect the server port from `routing.json`. They read `${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/routing.json` and use the `port` field (defaulting to `3100`), so they stay in sync if you change the port in routing config.

### Setup skill

The `update-config` skill can automate hook installation. It copies or symlinks the hooks and writes the `settings.json` entries in one step — use it if you prefer not to configure hooks manually.

---

## Troubleshooting

**Missing environment variables**
`start` exits with `missing prerequisite: SLACK_BOT_TOKEN environment variable` or `SLACK_APP_TOKEN environment variable`. Export both tokens in your shell profile and open a new terminal before running `start`.

**routing.json not found**
`start` exits with `missing prerequisite: routing.json not found at <path>`. Run `bun postinstall.ts` to create a skeleton, or create the file manually. Verify `SLACK_STATE_DIR` matches the directory you populated.

**routing.json CWD mismatch**
If a Claude Code session connects but immediately disconnects, the session's actual CWD does not match any `cwd` in `routing.json`. Confirm the session's working directory matches the entry exactly (after tilde expansion). Duplicate CWDs across multiple routes are rejected at startup.

**Bot not receiving messages in a new channel**
After inviting the bot to a channel, Slack may not deliver messages until the bot is @mentioned for the first time. This is a Slack Socket Mode behavior — the first @mention activates event delivery for that channel. After that, all messages flow normally regardless of `requireMention` settings.

**Channel not in access.json**
Messages to channels not listed in `access.json → channels` and not present in `routing.json → routes` are silently dropped. Use the `claude-slack-channels-config` skill or edit `access.json` directly to add the channel ID with a `ChannelPolicy` entry.

**Permission relay not working**
Check that the Slack app has interactivity enabled (Interactivity & Shortcuts → toggle on). Verify `curl` and `jq` are on your `PATH`. Confirm the hook scripts are executable (`chmod +x`). If the port was changed in `routing.json`, ensure `SLACK_STATE_DIR` is set correctly so the hooks can read the updated port. If the hooks are silently doing nothing, confirm the session was launched by the server — the hooks only activate when `SLACK_CHANNEL_BOT_SESSION=1` is present in the environment. Sessions launched manually will not trigger the relay.

**Session not restarting after crash**
After 3 consecutive launch failures for a route, auto-restart is suspended until the server is restarted. Restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`. To disable auto-restart entirely, set `session_restart_delay` to `0` in `routing.json`.

**Session stuck during clean_restart**
If a session does not exit within `exit_timeout` seconds (default 120s), `clean_restart` force-kills its tmux session and proceeds. To manually recover, run `tmux kill-session -t <session-name>` for any remaining sessions, then `claude-slack-channel-bots stop && claude-slack-channel-bots start`.
