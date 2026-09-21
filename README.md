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
- [Claude Code](https://claude.ai/code) installed and authenticated
- [`agent-director`](https://github.com/gabemahoney/agent-director) **installed system-wide** as a prerequisite — like `git` or `docker`. CSCB no longer vendors the AD binary. The npm `agent-director` package CSCB depends on is now a thin TypeScript shim that locates the system-installed binary at startup via `resolveSystemBinary()` / `Client.create()` and refuses to start when the binary is missing, too old, or unreachable. The startup gate enforces AD's required version (declared by AD in `dist/version-floor.json`) and reports the required version on mismatch. agent-director itself requires [tmux](https://github.com/tmux/tmux) on the operator's PATH; CSCB no longer probes for it directly.
- Slack workspace admin access (to create and configure the Slack app)
- **cozempic** (optional) — Python 3.10+ and `pip install cozempic` — used by JSONL path resolution helpers retained for downstream callers.

### Supported platforms (inherited from agent-director)

| Platform | Status |
|---|---|
| `linux-x64` | Supported |
| `darwin-arm64` (Apple Silicon Mac) | Supported |
| `linux-arm64` | **Not supported** by agent-director |
| `darwin-x64` (Intel Mac) | **Not supported** by agent-director |
| Windows | **Not supported** by agent-director |

If the host is unsupported, the system-installed `agent-director` itself will refuse to install or run; CSCB's startup gate then exits non-zero with one of the `ad-system-install-*` class labels (see [Startup errors](#startup-errors)) and writes the failure to `~/.claude/channels/slack/startup-errors.log` and stderr. Consult [agent-director's documentation](https://github.com/gabemahoney/agent-director) for the canonical platform support list.

> **Note on agent-director versions.** v0.4.1 is a zombie release (the published tarball is missing `dist/` and cannot be imported). v0.4.2 lacks the `MakeTemplateParams.overwrite` field CSCB needs for the boot-time template refresh. v0.5.4 and earlier lack `allow_pending` on `readPane`/`sendKeys`, causing `ErrSpawnNotInteractive` during dev-channels dialog approval on freshly-spawned bots. v0.6.0 shipped a stale TS shim whose `Client` dropped `getPermission`, whose `buildDecide()` dropped `--request-token`, and whose error catalog omitted `ErrInvalidFlags` / `ErrPermissionRequestNotFound` / `ErrAmbiguousRequest` — each silently breaks the disambiguation relay. v0.6.1–0.6.2 still lack the full `permission_requests` plural projection + composite-key disambiguation surface CSCB depends on for concurrent open requests. From v0.7.0 onward, AD ships as a thin npm shim around a system-installed binary, and CSCB defers the minimum-AD-version decision to AD itself via `dist/version-floor.json` (AD's library-side `Client.create()` reads it). CSCB's `package.json` caret-pin on `agent-director` governs npm resolution of AD's TypeScript shim only — not the runtime floor, which is owned by the AD release the system binary belongs to.

### Checking your agent-director install

Before starting the server, you can confirm `agent-director` is installed system-wide and meets the declared minimum with:

```sh
bun run install-check
```

The script calls the same discovery + floor-comparison pipeline the startup gate uses (it reads AD's `dist/version-floor.json`, calls `resolveSystemBinary()`, and compares versions via `semver.gte`). It exits 0 on success with a single-line block naming `agent-director`, the absolute resolved binary path, the detected version, and the floor. On failure it writes one of the canonical class labels to stderr and exits non-zero:

- `ad-system-install-not-found` — no agent-director on PATH or at the standard install path. Install AD and retry. The stderr also points at the install-cscb skill for interactive remediation.
- `ad-system-install-too-old` — AD binary is below the floor. Upgrade AD and retry. The stderr points at the skill.
- `ad-system-install-unreachable` — AD discovered but the probe could not invoke it (eight `.reason` values exposed verbatim). The stderr points at the skill.
- `ad-version-floor-unreadable` — `dist/version-floor.json` is missing, malformed, or lacks `min_binary_version`. The remediation is to reinstall `agent-director` from npm; the install-cscb skill cannot fix a corrupt AD package, so this case does NOT append the skill instructions block.

The script is purely diagnostic — it never prompts, never runs an install command, never fetches the skill. The startup gate enforces the same floor automatically at server boot via AD's `Client.create()`; `install-check` is for operators who want to confirm their setup ahead of time.

### Installing the install-cscb skill

If `bun run install-check` (or the startup gate) reports one of the
`ad-system-install-*` failure classes, you can install the `install-cscb`
Claude skill for an interactive walkthrough. The skill drives the same
shared check module but walks you through install/upgrade and a
per-reason remediation flow for each of the eight
`ErrSystemInstallUnreachable.reason` values.

The skill is NOT auto-installed by `bun install` — fetch it manually
from CSCB's GitHub repo and place it in your local Claude skills
folder:

1. **Fetch** `SKILL.md` from:

   ```
   https://github.com/gabemahoney/claude-slack-channel-bots/blob/main/skills/install-cscb/SKILL.md
   ```

   (The startup gate's `ad-system-install-*` error log line includes
   this URL automatically.)

2. **Place** it at:

   ```
   ~/.claude/skills/install-cscb/SKILL.md
   ```

3. **Invoke** the skill from Claude Code:

   ```
   /install-cscb
   ```

The skill calls `bun run install-check` on each iteration, surfaces
`agent-director`'s published install/upgrade command verbatim (no
CSCB-owned install command — AD's documentation is the source of
truth), prompts before running, and loops until the check passes or
you decline. The `ad-version-floor-unreadable` class is handled
separately: the skill prints reinstall-from-npm guidance and does NOT
loop on it (the skill cannot fix a corrupt AD npm package).

The published CSCB npm tarball includes `skills/install-cscb/SKILL.md`
under its `files` array, so the skill source is also available via
`node_modules/claude-slack-channel-bots/skills/install-cscb/SKILL.md`
after `bun install`. The manual GitHub-fetch step above is for users
who haven't yet installed CSCB at all.

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
| `CSCB_LOG_MAX_BYTES` | Rotate `server.log` / `clean_restart.log` when the active file reaches this many bytes. Defaults to `10485760` (10 MiB). Values `<= 0` or non-numeric are ignored. |
| `CSCB_LOG_KEEP` | Number of rotated generations to retain (`server.log.1` … `server.log.N`). Defaults to `5`. Set to `0` to keep none (the log is truncated instead of rolled). Values `< 0` or non-numeric are ignored. |
| `CSCB_AD_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the agent-director library's per-poll `SubprocessClient: <verb> ok` success dumps in `server.log`. Off by default — these routine dumps are dropped so the log stays readable. Failures and warnings from agent-director always pass through regardless of this flag. Read once at server startup, so it takes effect on server restart. |
| `CSCB_HTTP_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the per-request MCP access line (`HTTP <method> <path> session=…`) in `server.log`. Off by default — the `/mcp` endpoint is hit on every client poll and SSE open, so these routine lines are dropped to keep the log readable. Session connect/disconnect, route mismatches, and errors are logged unconditionally regardless of this flag. Checked per request, so it takes effect without a restart. |

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
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh. When `false`, the session manager always performs a fresh launch instead of resuming, both on startup and on runtime auto-restart, even when a stored session exists. Set `false` as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on resume (a known regression in v2.1.120). Requires a system-installed `agent-director` ≥ 0.8.0 for reboot recovery to actually restore history. |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. Replaces the pre-rename `claude_director_poll_interval_ms` — the old name is rejected at startup. Unknown top-level config fields are also rejected to surface stale configs after the rename. |
| `stop_hook_bootstrap` | boolean | `true` | Controls whether the server installs the CSCB-managed Slack Reply Guard Stop hook into `<claude_config_dir>/settings.json` at boot (see [Slack Reply Guard (Stop hook)](#slack-reply-guard-stop-hook)). Set to `false` to disable installation for every route and to actively remove any previously-installed managed entry. Per-route `routes[id].stop_hook_bootstrap` overrides this top-level value. Non-boolean values are rejected by config validation at startup. |
| `cron_table_path` | string | `<config dir>/crontab` | Path to the crontable for the built-in cron scheduler (`cscb_cron`). Defaults to `crontab` in the directory of the loaded `config.json`. A pointer only — the scheduler that reads it ships in a later release. `~` is expanded like other path keys. Must be a non-empty string when set. Changing it requires a server restart. |
| `cron_log_path` | string | `<config dir>/cron.log` | Path to the `cscb_cron` log file. Defaults to `cron.log` in the directory of the loaded `config.json`. A pointer only — the scheduler that writes it ships in a later release. `~` is expanded like other path keys. Must be a non-empty string when set. Changing it requires a server restart. |
| `cron_log_max_bytes` | number | — | Size cap in bytes for the cron log. Must be a positive integer when set. Cron-log pruning is disabled when absent. Changing it requires a server restart. |

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

#### Per-route `stop_hook_bootstrap` override

Set `stop_hook_bootstrap` on an individual route to override the top-level default for that one bot. Per-route values win over the top-level value; routes without their own value inherit the top-level default (which is itself `true` when absent).

```json
{
  "routes": {
    "C_EDIT_ONLY_BOT": {
      "cwd": "~/projects/gamma",
      "claude_config_dir": "~/.claude-gamma",
      "stop_hook_bootstrap": false
    },
    "C_NORMAL_BOT": {
      "cwd": "~/projects/delta",
      "claude_config_dir": "~/.claude-delta"
    }
  }
}
```

A per-route opt-out only *fully* disables the guard for that bot when the route owns a **dedicated** `claude_config_dir` — see [Shared-dir aggregation](#shared-dir-aggregation) for the interaction when routes share a dir.

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

1. `SLACK_BOT_TOKEN` is set — fails with `missing prerequisite: SLACK_BOT_TOKEN environment variable` if absent.
2. `SLACK_APP_TOKEN` is set — fails with `missing prerequisite: SLACK_APP_TOKEN environment variable` if absent.
3. `config.json` exists at `STATE_DIR/config.json` — fails with the full path if not found.

Once the server daemonizes, the SR-5.1 startup gate runs inside the child process: it imports `agent-director`, constructs the singleton Client, runs `client.version()`, and verifies `~/.agent-director/state.db` is owned by the current user. Failures land in `startup-errors.log` (see [Startup errors](#startup-errors)). The previous `tmux -V` probe at the CLI level has been removed — agent-director enforces tmux availability at spawn time.

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

Plain `stop` leaves the managed bots running — they are meant to survive a server restart. Pass `--stop-bots` to gracefully exit the bots first:

```sh
claude-slack-channel-bots stop --stop-bots
```

This mirrors `clean_restart`'s order: the server is stopped **first**, then the bot teardown runs for each route — pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. Teardown kills but never deletes each row, preserving its `claude_session_id` so the bots can resume their conversation history on the next start. Stopping the server first prevents its `onsessionclosed`/`scheduleRestart` handler from respawning a just-exited bot mid-teardown (which would delete its `ended` row and history). Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If agent-director is unreachable, the teardown **fails loudly** — the command prints the error and exits non-zero rather than silently reporting a clean stop. (A missing config is best-effort: teardown is skipped but the server stop still succeeds, since the server is already down.)

### `claude-slack-channel-bots clean_restart`

Gracefully exits all managed Claude Code sessions, then stops and starts the server.

```sh
claude-slack-channel-bots clean_restart
```

For each configured route, calls `client.pause({claude_instance_id})` via agent-director and polls `client.status(...)` until the spawn transitions to `ended` / `missing` (or `client.list(...)` returns no row). If the spawn does not exit within `exit_timeout` seconds (default 120s), the spawn is force-killed via `client.kill(...)`. Teardown kills but never deletes each row, preserving its `claude_session_id` so bots resume their conversation history on the next start. All routes are processed in parallel. After the server restarts, the SR-1.4 collision-then-act dispatcher decides resume-vs-fresh per route — agent-director owns Claude session-id state, not CSCB.

A benign kill outcome — the row already being gone — is tolerated per-route and does not abort the restart. Any other per-route teardown failure, including a pause failure that escalates to a kill which then fails to reach agent-director, is fatal: it fails loudly and aborts the restart (non-zero exit).

Behavior by case:

- **No configured routes:** skips the shutdown phase and proceeds directly to stop/start.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **agent-director unreachable:** teardown fails loudly and the restart is aborted (non-zero exit); no new server is started. The `no spawn row` message appears only when a route genuinely has no spawn, never when the client failed to reach agent-director.

### PID file

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.claude/channels/slack/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

### Installing from a local worktree

To install the version of CSCB sitting in your working copy (so the globally-linked `claude-slack-channel-bots` binary runs your local sources), use the helper script rather than `bun install -g .`:

```sh
./scripts/install-local.sh
```

`bun install -g .` (and the equivalent `bun install -g <local-path>`) is broken on Bun 1.3.13 — it inserts an invalid empty-string dependency key into `~/.bun/install/global/package.json` and then any subsequent global op fails with `error: Package "@" has a dependency loop` (upstream: [oven-sh/bun#24207](https://github.com/oven-sh/bun/issues/24207)). The script uses `bun add -g file:<abs-path>` instead, and pre-emptively strips any empty-string entry a prior `bun install -g .` may have already left behind.

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

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. Architecture is polling-based on the `agent-director` library — there are **no hook scripts to install** and no HTTP long-poll loops.

Flow:

1. agent-director moves the spawn into `check_permission` state when Claude requests a tool permission.
2. CSCB's poller (`src/permission-poller.ts`) runs `client.list({ state: ['check_permission'], label: ['service=cscb'] })` at the `agent_director_poll_interval_ms` cadence (default 1000 ms).
3. For each new spawn, `client.get(...)` returns the open `permission_request` (tool name + tool input + integer `request_id`). CSCB `chat.postMessage`s the Block Kit prompt to the spawn's `channel` label.
4. The operator clicks Allow / Deny in Slack. CSCB's interactive handler calls `client.decide({ claude_instance_id, decision })` and `chat.update`s the message to "Allowed/Denied by <user>".
5. If a tracked prompt drops out of `check_permission` for any reason other than a Slack click (timeout, external `decide`, crash), the next poller tick replaces the buttons with "expired".

### Slack app prerequisites

The Slack app must have **interactivity enabled** with **Socket Mode** as the delivery method. Open your Slack app config → **Interactivity & Shortcuts** → toggle **Interactivity** on. No Request URL is needed; Socket Mode delivers interaction payloads over the existing socket. This is included automatically if you created the app from `slack-app-manifest.yml`.

### AskUserQuestion

The `AskUserQuestion` tool is denied for every CSCB-spawned bot via the agent-director template (`deny: ['AskUserQuestion']`). Bots respond to operator questions via the Slack `reply` MCP tool instead. There is no `ask-relay.sh` hook and no `/ask` HTTP route.

### Memory-directory reads

The template also pre-allows each bot to read its own persistent-memory directory, so those reads don't surface a permission prompt to a human. One `Read(//<config-dir>/projects/*/memory/**)` rule is derived per distinct Claude config directory in your routing config (a route's `claude_config_dir`, the top-level `claude_config_dir`, or the `~/.claude` default). The rule is scoped to `projects/*/memory/**` only — never the config-dir root, which holds live credentials — so it never pre-authorizes credential reads.

---

## Slack Reply Guard (Stop hook)

CSCB ships a Claude Code Stop hook that enforces a simple rule for every bot session it manages: **when the most recent real user message on the turn came from Slack, the assistant must call the `mcp__slack-channel-router__reply` tool before ending the turn**. If it does not, the Stop hook exits `2`, and Claude Code shows the assistant the reminder `Slack user is waiting for a reply. You must respond by calling the mcp__slack-channel-router__reply tool before ending your turn.` and re-runs it once. The retry sets `stop_hook_active=true`, which short-circuits the guard, so exactly one forced retry occurs per turn — never an infinite block loop.

### What the server writes, and where

CSCB owns installing the hook on your behalf. On every server boot, alongside the trust-folder bootstrap, the server walks every route, groups them by effective `claude_config_dir` (per-route override falls back to the top-level value), and patches `<claude_config_dir>/settings.json` in place. For each dir it ensures **exactly one** managed Stop-hook group of the shape:

```jsonc
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<absolute path>/stop-hooks/slack-reply-guard.sh" } ] }
    ]
  }
}
```

The command is an absolute path to the script inside CSCB's installed package tree. There is no `matcher` field — Stop is not a tool-scoped event. Any other Stop hooks you have configured, and every other key in `settings.json`, are preserved. Writes are atomic (`.tmp` + `rename`). A missing `settings.json` is created with just this group; a malformed `settings.json` is left untouched and a startup error is recorded.

**Recognition rule.** The server treats *any* Stop-hook `command` string containing the substring `slack-reply-guard.sh` as CSCB-managed. Duplicates from prior boots are collapsed to one canonical entry; stale entries (from an older install path) are rewritten to the current absolute path — this is the self-heal path across upgrades.

### Timing: on-disk at every boot, effective at next Claude process start

The bootstrap rewrites `settings.json` on **every** CSCB boot, so the on-disk entry always reflects the currently-installed release's absolute path. Claude Code, however, only reads hook configuration when a Claude process starts. On a CSCB restart, live sessions are reconnected and keep their already-running Claude processes — they will not pick up an updated hook path until the next fresh spawn or the next resume of a dead/missing session for that route.

### Shared-dir aggregation

The install/remove decision is per **directory**, not per route. If two routes resolve to the same `claude_config_dir`, the managed entry is installed when at least one of them has the guard enabled, and removed only when all of them have it disabled. Consequence: a per-route opt-out fully disables the guard for a bot only when that route owns a *dedicated* `claude_config_dir`. A route that shares a dir with any enabled route still gets the guard on that shared dir.

### Personal-dir refusal

The bootstrap refuses to touch the operator's own `~/.claude` directory. If a route's effective `claude_config_dir` resolves (via `realpathSync`, with a lexical fallback for paths that do not exist on disk) to your home `.claude` dir, nothing is written and a startup error is recorded. This prevents CSCB from ever installing a bot-oriented Stop hook into your interactive Claude Code config.

### Bots without a `claude_config_dir`

Routes with no effective `claude_config_dir` — neither per-route nor top-level — are skipped. Empty or whitespace-only values are treated as absent (so `resolve("")` never lands in the process cwd). If you want the guard on a bot, give its route a real `claude_config_dir`.

### v1 limitations — opt these bots out

The v1 guard only recognises a reply via `mcp__slack-channel-router__reply`. Bots whose only Slack surface is `edit_message` or `react` will end their turn without producing a matching `tool_use`, and the guard will block them and force one useless retry every turn. **Opt these bots out** by setting `stop_hook_bootstrap: false` on the route (see the field reference below), and give the route a dedicated `claude_config_dir` — see [Shared-dir aggregation](#shared-dir-aggregation).

### Opting out

The `stop_hook_bootstrap` boolean lives on the top level of `config.json` and on individual routes. It defaults to `true`. Set it to `false` at the top level to disable the bootstrap for every route; set it on an individual route to override the top-level default for one bot. See the [Field reference](#field-reference) and [Per-route `stop_hook_bootstrap` override](#per-route-stop_hook_bootstrap-override) below for the field details and the per-route-vs-shared-dir interaction.

### Tag drift — fail-open, verify after upgrades

The guard's Slack-origination predicate is a substring match on the prefix `<channel source="slack` in the transcript entry Claude Code writes for every Slack-delivered turn. CSCB only sends `{content, meta}` over MCP; the `<channel source="…">` wrapper is rendered by the **Claude Code harness itself** when it serialises the MCP tool result into the transcript, and the `source` attribute is the MCP server name (e.g. `slack-channel-router`). That tag is therefore an **external, harness-owned contract** — a future Claude Code release can rename it or restructure the wrapper without touching CSCB, and the guard's predicate would silently stop matching. Because the contract sits outside CSCB, the guard is designed to fail open on drift, and a post-upgrade verification recipe (below) exists so operators catch a silent-dark guard the next time the harness changes the tag.

The guard is **fail-open by design**: any error, missing transcript, missing `jq`, or absence of the tag results in `exit 0` (turn allowed). This means a future rename of the `<channel>` tag will silently disable the guard rather than break the bot. After every CSCB or Claude Code upgrade, verify the guard end-to-end:

1. Send the bot a Slack message that requires a reply.
2. Confirm the reply lands in Slack.
3. In the bot's transcript file (`<claude_config_dir>/projects/<slug>/*.jsonl` — guard-covered bots always run with a dedicated `claude_config_dir`, since the bootstrap refuses the operator's personal `~/.claude`), grep for `<channel source="slack` on the triggering message and for a subsequent assistant entry containing `"name":"mcp__slack-channel-router__reply"` in a `tool_use` block.

If the tag prefix no longer appears, the guard is dark — file an issue.

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
Check that the Slack app has interactivity enabled (Interactivity & Shortcuts → toggle on). Verify the bot is in `check_permission` state via `agent-director list --state check_permission --label service=cscb` (operator CLI). Inspect `server.log` for `permission-poller:` lines — skipped-tick WARNs at 5+ consecutive skips signal that the poll interval is too tight; increase `agent_director_poll_interval_ms` in `config.json`.

**Bot appears dead / posts a "blocked on a native permission prompt" warning**
The bot is wedged in `check_permission` on a native Claude Code TUI prompt that never reached Slack (a permission decision AD recorded but could not deliver). The bot stops responding, and after ~90 s the poller posts a one-shot channel warning. Recover by inspecting the native prompt with `agent-director read-pane --claude-instance-id <id>`, then killing and respawning the session (`agent-director kill <id>` or tmux-kill, then let the server restart it or `claude-slack-channel-bots stop && claude-slack-channel-bots start`). Do **not** use `send-keys` — agent-director hard-rejects it while the spawn is in this relayed permission state. The warning fires once per wedge episode; the detector re-arms if the bot later wedges again.

**Session not restarting after crash**
Auto-restart backs off exponentially on repeated launch failures — the delay doubles from `session_restart_delay` (default 60s) on each consecutive failure, up to a 15-minute ceiling. After 5 consecutive failures the route hits a cap: a `SpawnCapReached` message is posted to the channel and automatic restarts stop.

Sending a message in a channel whose session is dead but not yet capped triggers a fast recovery: the restart is scheduled immediately (the backoff delay is clamped down to 5 seconds for an explicit human trigger, never raised), and the sender is told the session is starting and to retry in a moment. The dropped message itself is **not** delivered or replayed — recovery only starts the session; you must resend after it comes up. This human trigger still counts each failed launch toward the backoff/cap, and a restart already pending or active is not stacked.

A **capped** route (or one with auto-restart disabled via `session_restart_delay: 0`) does **not** recover on an inbound message — firing another launch there would only burn a spawn attempt against a route that cannot come up. The sender is told plainly that the channel will not self-recover and an operator must restart the server. To clear the cap and retry, restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`; the failure counter is in-process and cleared on restart, giving each route a fresh attempt. To disable auto-restart entirely, set `session_restart_delay` to `0` in `config.json`.

**Bot alive but silently unresponsive (MCP disconnected)**
A bot can stay running yet lose its MCP connection to the server — the process is alive but no longer reachable, so it stops responding without ever emitting a disconnect event. The periodic health-check recovers this automatically: once a channel is seen alive-but-disconnected on two consecutive ticks, the health-check schedules a reconnect (or a relaunch if the process has since died), so a stranded channel comes back with no inbound message and no server restart. The recovery lands within roughly two `health_check_interval` periods (default 120 s each) plus the restart backoff delay (default `session_restart_delay` 60 s) before the reconnect runs — about 3–5 minutes with default settings. A bot mid-turn (`working` state) is deliberately left alone and reconnected on a later tick once its turn settles.

A closely related symptom is a bot that still *looks* connected but silently drops every inbound message — its underlying message stream went away without the connection registering as closed. The same health-check path recovers this on the same two-consecutive-tick cadence, so no inbound message or server restart is needed. If a message does arrive on such a channel before recovery lands, the sender is told the message was not delivered and to retry in a moment, rather than getting silence.

To verify recovery in the field, tail `server.log` for a stranded channel and confirm a tick-driven recovery lands — look for a `[slack] Scheduling restart for channel=<id> in <N>s (backoff)` line and a `[slack] Session alive but disconnected — reconnecting MCP for channel=<id>` line naming that channel (and, when the bot was mid-turn, a `deferring /mcp reconnect to a later tick (b.9a7/b.rmy)` line first). A **capped** route is exempt: the health-check skips it entirely, including reconnects, so a capped channel still requires a server restart (see below).

**Session stuck during clean_restart**
If a session does not exit within `exit_timeout` seconds (default 120s), `clean_restart` force-kills the spawn via `agent-director kill` and proceeds. To manually recover, run `agent-director list --label service=cscb` to find lingering spawns and `agent-director kill <claude_instance_id>` to clear them, then `claude-slack-channel-bots stop && claude-slack-channel-bots start`.

**`clean_restart` or `stop --stop-bots` exits non-zero with an agent-director teardown error**
This is intentional: when agent-director is unreachable, the teardown cannot run, so the command fails loudly rather than silently no-op'ing and (for `clean_restart`) restarting on top of bots it never touched. Confirm agent-director is installed and responsive with `agent-director version`, then re-run the command. Teardown kills but never deletes rows on any failure path, so it is always safe to retry once agent-director is reachable.

**Bots come back with no memory of the prior conversation after a reboot**
With `resume_enabled: true`, a bot whose host rebooted (or pod resumed) should return with its conversation history. If it comes back amnesiac, confirm the system-installed `agent-director` is **≥ 0.8.0** (`agent-director version`) — reboot recovery relies on capabilities added in that release. Note that `bun run install-check` does **not** confirm this: its client floor is `0.7.0`, lower than the reboot-recovery requirement, so install-check passes on a `0.7.x` binary that still yields amnesiac bots. Verify the resume requirement directly with `agent-director version`. Note: legacy sessions created before upgrading to 0.8.0 may lose history exactly once on their first post-upgrade recovery, then resume cleanly thereafter.

**Session crashes on resume with "sandbox required but unavailable"**
This is a known regression in certain Claude Code releases (e.g. v2.1.120) where `--resume` triggers a sandbox check that fails in headless environments. Set `resume_enabled: false` in `config.json` to disable `--resume` entirely — the bot will always start a fresh Claude session instead of resuming a prior conversation, both on startup and on runtime auto-restart:

```json
{
  "routes": { ... },
  "resume_enabled": false
}
```

---

## Server log rotation

The server daemon writes runtime output to `~/.claude/channels/slack/server.log` (and `clean_restart.log` for the `clean_restart` subcommand). Rotation is built into CSCB, so it applies on every machine with no per-host logrotate config: when the active file crosses `CSCB_LOG_MAX_BYTES` it is rolled to `server.log.1`, the previous `.1` → `.2`, and so on up to `CSCB_LOG_KEEP` generations; the oldest is discarded. Rotated generations are not compressed. See the environment-variable table above for the size, retention, and verbosity settings that tune this behavior.

Note this covers only `server.log` / `clean_restart.log`. `startup-errors.log` and `permission-trail.jsonl` are separate append-only files with their own retention (see below).

---

## Startup errors

CSCB writes startup errors to `~/.claude/channels/slack/startup-errors.log` (override the directory with `SLACK_STATE_DIR`) in addition to stderr. Each entry is a single timestamped line. The file is append-only and never rotated by CSCB — copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` if you want host-level rotation. Most classes below are fatal (the process exits non-zero); the JSONL-persistence warnings at the end are non-fatal and do not block startup.

Classes you may see:

- `ad-system-install-not-found` — `Client.create()` could not locate an `agent-director` binary on PATH or at the standard install path. Install agent-director system-wide and retry. The log line appends a manual-skill-install instructions block pointing at `skills/install-cscb/SKILL.md` (URL, target path under `~/.claude/skills/`, and invocation command `/install-cscb`) for the interactive install/upgrade flow.
- `ad-system-install-too-old` — the system-installed agent-director binary is below the floor declared in `dist/version-floor.json`. The log line names the detected and required versions, and appends the manual-skill-install instructions block.
- `ad-system-install-unreachable` — agent-director was discovered but the probe could not execute it (e.g. permission bits, broken symlink, runtime crash). The log line surfaces AD's supplied `err.reason` value verbatim (one of `not-executable`, `not-a-regular-file`, `probe-timeout`, `probe-nonzero-exit`, `probe-killed-by-signal`, `unparseable-version`, `spawn-failed`, `other`) and appends the manual-skill-install instructions block.
- `ad-bun-version-too-old` — agent-director needs Bun `>= 1.0.21`. Upgrade Bun.
- `ad-version-probe` — `agent-director` was loaded but the `version()` probe failed (subprocess invocation, platform binary, etc.).
- `ad-shim-missing-get-permission` — the installed `agent-director` TS shim's `Client` does not expose `getPermission`. The npm-published package is out of sync with the system-installed binary. Reinstall a matching `agent-director` version and confirm the resolved package actually ships the method.
- `ad-shim-catalog-incomplete` — the installed `agent-director` TS error catalog is missing one or more of `ErrInvalidFlags`, `ErrPermissionRequestNotFound`, `ErrAmbiguousRequest`. The log line lists the missing names. Same remediation as `ad-shim-missing-get-permission`.
- `ad-shim-decide-drops-token` — the installed `agent-director` dist does not include `--request-token` in its bundled JS, meaning `buildDecide()` would resolve permission clicks against the wrong row. Reinstall a matching `agent-director` version and confirm `buildDecide` carries the flag.
- `ad-version-floor-unreadable` — `node_modules/agent-director/dist/version-floor.json` could not be read, parsed, or is missing `.min_binary_version`. This is a packaging defect — reinstall `agent-director` from npm. Surfaced by `bun run install-check`; the startup gate itself does not emit this label (it relies on `Client.create()`, which fails differently when the AD package is corrupt).
- `ad-call-timeout` — an agent-director verb call exceeded the configured `callTimeoutMs` (default 30 s). Investigate the subprocess or increase the timeout.
- `ad-same-user` — `~/.agent-director/state.db` is owned by a different UID than the CSCB process. Reinstall agent-director as the correct user or remove the mismatched file.
- `ad-same-user-stat` — Non-ENOENT stat error on the state DB (permissions, I/O). Investigate the file before re-launching.
- `ad-template-install` — `client.makeTemplate(...)` rejected the boot-time refresh of the `slack-channel-bot` template. The line includes the agent-director `errName`.

The following classes are **non-fatal warnings** about conversation-memory loss. They are recorded to the same log but never exit the process or block startup. The first four are written by the JSONL-persistence safeguard, which runs *before* the resume path to warn about an *impending* loss; the last two (`jsonl-transcript-lost-on-resume`, `jsonl-diagnosis-inconclusive`) are written *by the resume path itself* when it tried to resume a row and either confirmed a wipe or could not determine whether one occurred:

- `jsonl-non-persistent` — a session-transcript storage root (`<claude_config_dir>/projects`) is on a `tmpfs`/`ramfs` mount, so nothing there survives a reboot and session resume is structurally impossible on this host. A warning is also posted to the affected channels — those whose transcript storage root is the flagged mount, not every routed channel. Move the config dir to a persistent filesystem.
- `jsonl-persistence-check-warning` — the safeguard could not determine the filesystem type of a transcript storage root (unreadable/unparseable `/proc/self/mountinfo`, or an unresolvable path), so persistence is unverified. No Slack post is made. Investigate the mount before relying on resume.
- `jsonl-transcript-stale-path` — a channel's saved transcript exists on disk at the resolved fallback path, but agent-director's recorded `jsonl_path` points elsewhere (missing/empty). On the next restart the resume path would treat it as missing and wipe the channel's memory. A warning is posted to that channel; an operator should reconcile the path before restarting.
- `jsonl-transcript-lost` — a channel's transcript is gone from disk (neither the recorded nor the fallback path exists), yet the message archive shows messages in that channel since the bot spawned. Conversation history has been lost and resume will start the bot fresh. A warning is posted to that channel. Requires `message_archive_db` to be configured for the archive evidence.
- `jsonl-transcript-lost-on-resume` — resume actually threw `ErrJsonlMissing` for a channel, the bot was delete+fresh-spawned, and the message archive shows messages in that channel since it spawned — so conversation history was destroyed by this recovery, not merely at risk. A warning is also posted to that channel. This is the resume path's own after-the-fact report (distinct from the pre-resume `jsonl-transcript-lost` warning above); the log line names every transcript path tried and whether each came from agent-director or was computed locally. A missing transcript on a channel that was *idle since spawn* — the archive was consulted and shows zero messages since spawn — is expected (the transcript is created lazily on first message) and produces a quiet log line only, no error class and no channel post. Requires `message_archive_db` for the archive evidence; when the archive cannot be consulted the case is instead reported as `jsonl-diagnosis-inconclusive` below.
- `jsonl-diagnosis-inconclusive` — resume threw `ErrJsonlMissing` and the bot was delete+fresh-spawned, but the diagnosis could not determine whether conversation history was lost: the agent-director row could not be fetched, `started_at` was unparseable, the message archive could not be read, or `message_archive_db` is not configured at all. Because "inconclusive" correlates with the same storage problems that cause real loss, this is surfaced (not silently downgraded to a benign never-created): the line records *why* the diagnosis failed, and a warning is posted to the channel worded as uncertainty ("restarted fresh; could not determine whether prior history was preserved") rather than as a confirmed loss. When the reason is an unconfigured archive, the message notes that diagnosis is impossible without `message_archive_db` and suggests enabling it. These channels are counted separately in the startup summary as `fresh-after-inconclusive-amnesia` (distinct from the `fresh-after-amnesia` count).

---

## Release process

CSCB releases are cut with the `/publish` skill from a clean checkout of `main` on a dev box that has `npm login` against the publishing account. The skill bumps the version, packs and smoke-tests the release tarball, commits and tags the release, pushes to GitHub, publishes to npm, polls the registry until the new version is visible, reinstalls the just-published version on the dev box, and prints a final summary.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with a usage line if the argument is missing or not one of `patch`, `minor`, `major`.

### Preflight gates

Before any side-effecting step runs, `/publish` enforces seven fail-fast gates. Any failure aborts before the version is bumped, the tarball is packed, or anything is committed:

1. **Clean working tree on `main` in sync with origin/main.** No uncommitted changes; HEAD branch is `main`; `main` is exactly equal to `origin/main` after `git fetch origin`.
2. **Tests exist and pass.** At least one `*.test.ts` file under `tests/` and `bun test` exits zero.
3. **Typecheck passes.** `bun run typecheck` exits zero.
4. **npm authenticated.** `npm whoami` exits zero (run `npm login` first if not).
5. **Next version not already published.** `npm view claude-slack-channel-bots@<next-version> version` must report nothing.
6. **No stranded finished work.** `scripts/audit-finished-tickets.sh` must exit zero. It flags any `finished` ticket whose fix is neither on `main` nor explicitly closed (ops-only / no-repro / superseded), any unmerged branch tied to a finished ticket, and any unmerged branch that references no known ticket at all (e.g. `origin/no-channels`). A release cannot ship while a fix is silently stranded on a dead branch. The gate is read-only — it never mutates tickets or git. This gate runs in Phase 1 preflight, **before** the `/ci` gate below, so a stranded-work failure aborts the release before the Docker suite ever runs. The gate splits its failure by the audit's exit code: audit exit 1 (stranded work) → preflight exit 16; audit exit 2 (setup failure — the Bugs/Plans hives, a git repo, or a `main` ref were not locatable from this checkout, e.g. a throwaway `/tmp` clone) → preflight exit 17, whose fix is to rerun `/publish` from the canonical checkout that sits beside the hives. **Note: this gate is known-red today** — it exits non-zero by design against pre-existing hygiene debt (tickets `b.qps`, `b.1qs`, `b.a4d`, `b.jfk`, `b.e3f`; branches `feature/b.e3f`, `feature/b.oaj`, `fix/b.k54-trust-dialog`, `origin/no-channels`, all tracked separately), so it will block releases until that debt is cleared or explicitly closed. A red result on first run is not a regression in the gate.
7. **`/ci` integration suite passes.** The full Docker-based integration test suite is run via the `/ci` skill and must report PASS. **`/ci` is mandatory and has no opt-out flag** — release without an unbroken integration run is not possible through this skill.

### What happens during a release

After all gates pass, the skill, in this order:

1. Bumps `package.json` and `bun.lock` to `<next-version>` (no commit, no tag yet).
2. Packs the release tarball with `bun pm pack` and verifies its internal version matches.
3. Scratch-installs the tarball into a temp `BUN_INSTALL` and runs the bin smoke check (non-zero exit + `Usage:` in stderr). Any failure here rolls back the working tree and aborts — no commit, no push, no publish.
4. Creates the `Release v<version>` commit and the annotated `v<version>` tag locally.
5. Pushes the release commit to `origin/main`.
6. Publishes the smoke-tested tarball with `npm publish <tarball-path>` (the smoke-tested artifact bytes — not a repack from CWD).
7. Pushes the `v<version>` tag to `origin`, bringing GitHub and npm into agreement.
8. Polls the npm registry every 5 seconds for up to 60 seconds until the new version is visible.
9. Sanitizes the bun-1.3.13 empty-string-dependency-key poison from the global `package.json` (see [Installing from a local worktree](#installing-from-a-local-worktree)), removes any pre-existing global install, then runs `bun install -g claude-slack-channel-bots@<version>` — the exact command an end user would run — and verifies the installed bin resolves under `~/.bun/install/global/` at the published version.
10. Prints a success summary identifying the published version, npm URL, GitHub release tag URL, resolved local install path, and the next-operator-action command.

### After the skill exits

The dev box now has the freshly-published version installed globally as a real copy, but the running CSCB daemon is still on the prior version. Swap the daemon over:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See [`clean_restart`](#claude-slack-channel-bots-clean_restart) above for full behavior.

---

## Migration

For operators upgrading from a pre-`agent-director` install:

1. **Install the new CSCB**: `bun remove claude-director` (if present) and `bun install -g claude-slack-channel-bots@^<new>`. The `agent-director` library is pulled in transitively — no separate install step.
2. **Delete any old relay hooks** — see [Upgrading from pre-Epic-2 (v0.5.x → v0.6.x)](#upgrading-from-pre-epic-2-v05x--v06x) for the cleanup commands.
3. **(Optional) Configure an agent-director `find-missing` sweep**. CSCB itself runs `find-missing` once before a resume during dead-session recovery, so a bot that died on reboot comes back with its history intact. A standalone periodic sweep is no longer required for CSCB recovery, but remains useful if you want stuck rows from non-CSCB spawns reconciled on a cadence. To add one, use a cron entry (or systemd timer):
   ```cron
   * * * * * /usr/local/bin/agent-director find-missing --timeout 30s
   ```
4. **Install the startup-errors logrotate snippet** so `~/.claude/channels/slack/startup-errors.log` doesn't grow unboundedly. Edit `USER` in the file to match the OS account running CSCB:
   ```sh
   sudo cp docs/logrotate-startup-errors.conf /etc/logrotate.d/claude-slack-channel-bots
   ```
5. **Rename your config field**. Pre-Epic-2 configs used `claude_director_poll_interval_ms`; CSCB now expects `agent_director_poll_interval_ms` and rejects the old name (no silent alias). Edit `~/.claude/channels/slack/config.json` accordingly. Unknown top-level fields are also rejected — clear any other deprecated keys.
6. **Optional cleanup**: `~/.claude/channels/slack/sessions.json` and `sessions.json.last` are no longer read or written. CSCB ignores them; you can safely `rm` them after a successful boot.
7. **`tmux` is no longer a CSCB-direct prereq** but is still required transitively via agent-director — keep it installed.

After step 1, every CSCB bot is spawned through `client.spawn(...)` with `relay_mode='on'`. The green/red Slack button UX is byte-identical to the pre-migration behavior; the action_id shape changes from `perm_(allow|deny)_<uuid>` to `perm_(allow|deny)_cscb_<channelId>_<request_token>` (where `<request_token>` is a UUIDv4 minted by agent-director) but this is invisible to end users.

---

## Upgrading from pre-Epic-2 (v0.5.x → v0.6.x)

If you installed CSCB before v0.6.0 you may have legacy artifacts on disk that are no longer needed. Clean them up manually — automatic postinstall migration is tracked under idea b.irf and not yet implemented.

### 1. Remove old relay hook files

The `.sh` relay hooks are no longer shipped by CSCB. Delete them if present:

```sh
rm -f ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh
```

### 2. Remove orphan settings.json hook entries

If you wired the hooks into `~/.claude/settings.json` by hand, remove the stale entries. Use this `jq` filter to check whether any are present:

```sh
jq '
  (.hooks.PermissionRequest // [] | map(select(.hooks[]?.command | strings | test("\\.sh$")))),
  (.hooks.PreToolUse // [] | map(select(.matcher == "AskUserQuestion" and (.hooks[]?.command | strings | test("\\.sh$")))))
' ~/.claude/settings.json 2>/dev/null
```

Any non-empty arrays in the output are orphan entries. Remove:

- Any object inside `hooks.PermissionRequest` whose `hooks[].command` ends in `permission-relay.sh`.
- Any object inside `hooks.PreToolUse` with `"matcher": "AskUserQuestion"` whose `hooks[].command` ends in `ask-relay.sh`.

The modern permission relay runs automatically via agent-director — no `PermissionRequest` or `PreToolUse` hook entries for `.sh` files are needed.

### 3. Note on automated migration

A postinstall step that performs this cleanup automatically is tracked under idea b.irf. Until that lands, the steps above are manual.

