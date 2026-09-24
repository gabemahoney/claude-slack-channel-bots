# Claude Slack Channel Bots

A single HTTP MCP server that runs several independent Claude Code bots, called personas. Each persona has its own Slack app and identity (name and avatar), one Claude Code instance with its own working directory, and is reachable from the Slack channels it is configured into. The server holds one Slack Socket Mode connection per persona and delivers each message to the persona whose app received it; each persona's tool calls may post only to the channels it is configured into and, when its `dm.enabled` is `true`, to its direct messages, as that persona.

---

## Quick Start

**[Bun](https://bun.sh) is required** — it is CSCB's runtime and the interpreter its install and start scripts run under. Install bun before you install CSCB. `npm install -g claude-slack-channel-bots` on a box without bun fails during postinstall (the postinstall script is a bun script).

1. **Install globally via bun:**

   ```sh
   bun install -g claude-slack-channel-bots
   ```

2. **Trust the package so postinstall runs:**

   ```sh
   bun pm -g trust claude-slack-channel-bots
   ```

   Bun blocks the lifecycle scripts of untrusted packages, so the postinstall does not run on the plain `install` above — you must trust the package for it to fire. The `-g` flag targets the global install; without it `bun pm trust` looks for a `package.json` in the current directory and errors with `No package.json was found`. (Run `bun pm -g untrusted` to confirm it is listed first.) The postinstall then creates skeleton config files in `~/.claude/channels/slack/` (or in `SLACK_STATE_DIR` when it is set and non-empty, the same directory the server reads). Skip this step and a later `start` fails with `missing prerequisite: config.json`.

3. **Run the setup skill:**

   The package includes a Claude Code skill at `skills/setup-slack-channel-bots/`. Copy or symlink it into `~/.claude/skills/`, then run:

   ```sh
   claude /setup-slack-channel-bots
   ```

   It covers the Slack app manifest, the system prompt file, `access.json`, the agent-director check and hook cleanup, and skips anything already configured. Until the skill is updated for personas, skip its token and routing steps (exporting token variables and writing `config.json`): the server reads no token from the environment and refuses a `config.json` with `routes`.

4. **Create your personas:**

   Create one Slack app per persona from `slack-app-manifest.yml`. Write each app's tokens to its own credentials file, then list the personas in `config.json`. See [Personas (config.json)](#personas-configjson) and [Credentials files](#credentials-files).

5. **Start the server:**

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

Runtime options are read from environment variables. None of them is required, and Slack tokens are never read from the environment: each persona's tokens live in its own credentials file (see [Credentials files](#credentials-files)). There is no `.env` file — export any of these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_STATE_DIR` | Override the directory where `config.json`, `access.json`, and runtime state are stored. Defaults to `~/.claude/channels/slack`. |
| `SLACK_ACCESS_MODE` | Set to `static` to load `access.json` once at startup and cache it for the lifetime of the process rather than re-reading it on every event. Useful in high-throughput environments where disk reads are a concern. |
| `SLACK_DRY_RUN` | Set to `1` (or `true` / `yes`) to start the server without Slack. No credentials file is read and no Slack call is made. Each persona runs with a placeholder identity (`U000DRY_<key>`), and MCP tool calls (`reply`, `react`, etc.) and server notices are logged instead of sent. Useful for integration testing. |
| `CSCB_LOG_MAX_BYTES` | Rotate `server.log` / `clean_restart.log` when the active file reaches this many bytes. Defaults to `10485760` (10 MiB). Values `<= 0` or non-numeric are ignored. |
| `CSCB_LOG_KEEP` | Number of rotated generations to retain (`server.log.1` … `server.log.N`). Defaults to `5`. Set to `0` to keep none (the log is truncated instead of rolled). Values `< 0` or non-numeric are ignored. |
| `CSCB_AD_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the agent-director library's per-poll `SubprocessClient: <verb> ok` success dumps in `server.log`. Off by default — these routine dumps are dropped so the log stays readable. Failures and warnings from agent-director always pass through regardless of this flag. Read once at server startup, so it takes effect on server restart. |
| `CSCB_HTTP_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the per-request MCP access line (`HTTP <method> <path> session=…`) in `server.log`. Off by default — the `/mcp` endpoint is hit on every client poll and SSE open, so these routine lines are dropped to keep the log readable. Session connect/disconnect, sessions with no matching persona, and errors are logged unconditionally regardless of this flag. Checked per request, so it takes effect without a restart. |

Shell profile example:

```sh
# Optional overrides:
export SLACK_STATE_DIR=~/.config/slack-channel-bots
export SLACK_ACCESS_MODE=static
# Dry-run mode (no Slack credentials needed):
export SLACK_DRY_RUN=1
```

---

### Personas (config.json)

`config.json` is read from `~/.claude/channels/slack/config.json` by default. Override the directory with `SLACK_STATE_DIR`. The server needs only this file and the credentials files it names.

Each bot is a **persona**: one Slack app, one Claude instance with its own working directory, and the channels it is configured into. Create one Slack app per persona (see `slack-app-manifest.yml`); that app gives the persona its own name and avatar in Slack.

Postinstall creates a skeleton with an empty persona list. An empty list is valid: the server starts with no personas.

```json
{
  "personas": []
}
```

#### Example

Two personas share the channel `C0555555555`. `planner` receives every message in its home channel `C0123456789` and only its @mentions or `@here` / `@channel` in the shared channel. `reviewer` receives only its @mentions or `@here` / `@channel` in the shared channel.

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/cscb/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [
        { "id": "C0123456789", "delivery": "all" },
        { "id": "C0555555555", "delivery": "mentions" }
      ],
      "permission_prompts": "C0123456789"
    },
    {
      "name": "reviewer",
      "credentials_file": "~/.config/cscb/reviewer-credentials.json",
      "working_directory": "~/projects/beta",
      "channels": [
        { "id": "C0555555555", "delivery": "mentions" }
      ],
      "permission_prompts": "C0555555555"
    }
  ],
  "port": 3100
}
```

#### Persona fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | The persona's name, used in logs, `/interject` and the crontable. Each persona also has a **key**: the name itself when it is 1–40 characters of `a-z`, `0-9` and `_`, otherwise a derived form. Logs show both, as `"planner" (key=planner)`. |
| `credentials_file` | yes | Path to the persona's [credentials file](#credentials-files). Absolute, `~` or `~/…`. |
| `working_directory` | yes | Working directory of the persona's Claude instance. Absolute, `~` or `~/…`. |
| `channels` | yes, unless `dm.enabled` is `true` | The channels the persona is in. Each entry is `{ "id": "<channel ID>", "delivery": "all" \| "mentions" }`: `all` delivers every message in the channel, `mentions` only messages that @mention the persona or use `@here` / `@channel`. Invite the persona's Slack app to each channel. |
| `permission_prompts` | yes | The persona's **destination**: where its permission prompts and server notices are posted. One of the persona's own channel IDs, or `"dm"`. |
| `claude_config_dir` | no | Claude config directory for this persona. Defaults to the top-level `claude_config_dir`. See [Per-persona `claude_config_dir` override](#per-persona-claude_config_dir-override). |
| `stop_hook_bootstrap` | no | Slack Reply Guard switch for this persona. Defaults to the top-level `stop_hook_bootstrap`. See [Per-persona `stop_hook_bootstrap` override](#per-persona-stop_hook_bootstrap-override). |
| `dm` | no | Direct-message settings: `{ "enabled": <boolean>, "contact": "<user ID>" }`. `enabled` defaults to `false`. `contact` is a Slack user ID such as `U0123456789` (starting with `U` or `W`), the person a `"dm"` destination addresses. With `enabled` `true`, direct messages to the persona's Slack app are delivered to it; with `false` they are dropped with a `persona-dm-dropped` log line. |

A `"dm"` destination is accepted, but in this version its prompts and notices are only written to `server.log`, not sent to Slack.

The rules that most often trip a first config:

- A persona needs at least one channel unless `dm.enabled` is `true`.
- `permission_prompts` must be `"dm"` or one of the persona's own `channels` IDs.
- A `"dm"` destination needs `dm.enabled: true` and a `dm.contact`.
- No two personas may share a `working_directory` or a `credentials_file`, compared by real path. Names and keys must be unique too.
- Channel IDs are Slack channel IDs such as `C0123456789`, not channel names.
- Unknown fields are rejected, at the top level and inside each persona.

The server checks the whole file at start. Any error stops the start, and the message names the persona (`personas[<i>]`) and the field.

#### Credentials files

Each persona's Slack tokens live in its own credentials file, and `config.json` names that file only by path. The file is a JSON object with exactly two keys:

```json
{
  "bot_token": "xoxb-PLACEHOLDER",
  "app_token": "xapp-PLACEHOLDER"
}
```

`bot_token` is the app's bot token (`xoxb-…`), granted when you install the app to the workspace. `app_token` is an app-level token (`xapp-…`) with the `connections:write` scope, generated under Basic Information → App-Level Tokens.

Use one file per persona and keep it private (`chmod 600`). Never put a token in `config.json`, a ticket or a chat.

#### Server-wide settings

These top-level fields apply to the whole server.

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. The in-process cron scheduler delivers via `127.0.0.1`, so `bind` must include loopback (the default, or `0.0.0.0`) for scheduled fires to work. |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | number | `60` | Seconds to wait before auto-restarting a dead session. Set to `0` to disable auto-restart. Must be non-negative. |
| `health_check_interval` | number | `120` | Seconds between periodic liveness polls. Set to `0` to disable. Must be non-negative. |
| `exit_timeout` | number | `120` | Seconds to wait for a managed Claude Code session to exit gracefully during `clean_restart` or `stop --stop-bots` before force-killing it through agent-director. |
| `stop_timeout` | number | `30` | Seconds to wait for the server process to exit after `SIGTERM` before escalating to `SIGKILL`. |
| `mcp_config_path` | string | `~/.claude/slack-mcp.json` | Path to the MCP config file passed to Claude Code when launching managed sessions. |
| `append_system_prompt_file` | string | — | Path to a file appended to every managed session's system prompt via `--append-system-prompt-file`. Missing file silently skipped. See `skills/EXAMPLE_CLAUDE.md` for a template. |
| `system_prompt_mode` | string | `"append"` | Controls how `append_system_prompt_file` is applied. `"append"`: the custom prompt file is appended on top of `CLAUDE.md` (default, current behavior). `"none"`: only `CLAUDE.md` is used; `append_system_prompt_file` is ignored even if set. Use `"none"` when the project's `CLAUDE.md` already contains everything the bot needs. |
| `cozempic_prescription` | string | `"standard"` | Cozempic cleaning intensity before resume. Valid values: `gentle`, `standard`, `aggressive`. Has no effect if cozempic is not installed. |
| `message_archive_db` | string | — | Path to a SQLite DB where every inbound Slack message is archived in real time. Parent directories are created if missing; schema is initialized on first open. Compatible with the `archive-messages.py` backfill script — both can write concurrently. Feature is disabled when absent. |
| `claude_config_dir` | string | — | Default Claude on-disk config directory for every persona. When a persona has one (its own or this default), its session launches with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the bot authenticates against a specific account. `~` is expanded and the path is resolved to absolute. A persona's own `claude_config_dir` overrides this value. When neither is set, Claude's own default applies. Must be non-empty when set. |
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh. When `false`, the session manager always performs a fresh launch instead of resuming, both on startup and on runtime auto-restart, even when a stored session exists. Set `false` as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on resume (a known regression in v2.1.120). Requires a system-installed `agent-director` ≥ 0.8.0 for reboot recovery to actually restore history. |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. Replaces the pre-rename `claude_director_poll_interval_ms` — the old name is rejected at startup. |
| `stop_hook_bootstrap` | boolean | `true` | Default for every persona: whether the server installs the CSCB-managed Slack Reply Guard Stop hook into `<claude_config_dir>/settings.json` at boot (see [Slack Reply Guard (Stop hook)](#slack-reply-guard-stop-hook)). Set to `false` to disable installation and to actively remove any previously-installed managed entry. A persona's own `stop_hook_bootstrap` overrides this value. Non-boolean values are rejected at startup. |
| `cron_table_path` | string | `<config dir>/crontab` | Path to the crontable for the built-in cron scheduler (`cscb_cron`). Defaults to `crontab` in the directory of the loaded `config.json`. `~` is expanded like other path keys. The resolved path is exported into every managed session as `CSCB_CRONTABLE_PATH` so bots can find the crontable and self-schedule (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)). Must be a non-empty string when set. Changing it requires a server restart. |
| `cron_log_path` | string | `<config dir>/cron.log` | Path to the `cscb_cron` log file. Defaults to `cron.log` in the directory of the loaded `config.json`. `~` is expanded like other path keys. Must be a non-empty string when set. Changing it requires a server restart. |
| `cron_log_max_bytes` | number | — | Size cap in bytes for the cron log. Must be a positive integer when set. Cron-log pruning is disabled when absent. Changing it requires a server restart. |

#### Per-persona `claude_config_dir` override

When you want different personas to authenticate as different Claude accounts (e.g. one runs as a personal Max account, another as a corporate account), set `claude_config_dir` on the individual persona. A persona's own value takes priority over the top-level `claude_config_dir`; personas without one fall back to the top-level value.

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/cscb/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [{ "id": "C0123456789", "delivery": "all" }],
      "permission_prompts": "C0123456789",
      "claude_config_dir": "~/.claude-maxauth"
    },
    {
      "name": "reviewer",
      "credentials_file": "~/.config/cscb/reviewer-credentials.json",
      "working_directory": "~/projects/beta",
      "channels": [{ "id": "C0987654321", "delivery": "all" }],
      "permission_prompts": "C0987654321"
    }
  ],
  "claude_config_dir": "~/.claude-corp"
}
```

`planner` launches with the Max account; `reviewer` falls through to the top-level value and uses the corporate account. Use `claude auth login --claudeai` (or `--console`) with `CLAUDE_CONFIG_DIR` set to the same directory to populate each config dir before starting the server.

Changing a persona's effective `claude_config_dir` or its `working_directory` makes that persona start fresh, without its prior conversation, at its next launch. The old transcript stays in the old config directory. The [Troubleshooting](#troubleshooting) entry "Bots come back with no memory of the prior conversation" says when that launch happens.

#### Per-persona `stop_hook_bootstrap` override

Set `stop_hook_bootstrap` on an individual persona to override the top-level default for that one bot. A persona's own value wins over the top-level value; personas without one inherit the top-level default (which is itself `true` when absent).

```json
{
  "personas": [
    {
      "name": "editor",
      "credentials_file": "~/.config/cscb/editor-credentials.json",
      "working_directory": "~/projects/gamma",
      "channels": [{ "id": "C0123456789", "delivery": "all" }],
      "permission_prompts": "C0123456789",
      "claude_config_dir": "~/.claude-gamma",
      "stop_hook_bootstrap": false
    },
    {
      "name": "helper",
      "credentials_file": "~/.config/cscb/helper-credentials.json",
      "working_directory": "~/projects/delta",
      "channels": [{ "id": "C0987654321", "delivery": "all" }],
      "permission_prompts": "C0987654321",
      "claude_config_dir": "~/.claude-delta"
    }
  ]
}
```

A per-persona opt-out only *fully* disables the guard for that bot when the persona has a **dedicated** `claude_config_dir` — see [Shared-dir aggregation](#shared-dir-aggregation) for the interaction when personas share a dir.

---

### Access Control (access.json)

`access.json` is read from `~/.claude/channels/slack/access.json` by default (same directory as `config.json`). A skeleton file with defaults is created by postinstall. The file is written with `0600` permissions.

`access.json` controls only the acknowledgement reaction and how long replies are chunked. Which messages a bot receives is set by each persona's `channels` in `config.json` (see [Messages a bot receives](#messages-a-bot-receives)).

#### Complete example

```json
{
  "ackReaction": "eyes",
  "textChunkLimit": 3000,
  "chunkMode": "newline"
}
```

#### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
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

Checks that the configuration file exists, starts the server in the background, and waits for it to get through startup.

**Prerequisite check:** `config.json` exists at `STATE_DIR/config.json`, the same file the server loads. If it does not, `start` exits 1 with:

```
missing prerequisite: config.json not found at <path>
```

`start` reads no Slack token and needs no token environment variable. The server checks the file's contents, and each persona's credentials file, once it runs.

The server first runs the agent-director startup gate: it imports `agent-director`, constructs the singleton Client, runs `client.version()`, and verifies `~/.agent-director/state.db` is owned by the current user. Failures land in `startup-errors.log` (see [Startup errors](#startup-errors)). agent-director enforces tmux availability at spawn time. The server then loads the configuration and starts listening, and only then writes its PID to `STATE_DIR/server.pid`. Conversation context is preserved across server restarts when possible.

`start` waits up to 30 seconds for that PID file. The outcomes are:

- **The server is up:** `start` prints this line and exits 0.

  ```
  [slack] Server starting in background (PID 12345)
  ```

- **The server exits during startup:** `start` exits 1. It prints why the server stopped, followed by the last lines (at most 20) the server wrote to `server.log`, which carry the server's own reason:

  ```
  [slack] Server failed to start (exit code 1). From /home/you/.claude/channels/slack/server.log:
  ```

- **The server is still starting after 30 seconds:** `start` exits 0 and leaves it running.

  ```
  [slack] Server is still starting in the background (PID 12345) after 30s — its log is /home/you/.claude/channels/slack/server.log
  ```

A configuration from before personas stops the start. The server writes the conversion error to `server.log` and exits, so `start` shows the same line on the terminal and exits 1. In `server.log`, where each line is prefixed with a timestamp, it reads:

```
[slack] Fatal: configuration error — loadPersonaConfig: invalid persona config in "<path>": Persona config validation error: "<key>" belongs to the pre-persona configuration shape, which is no longer accepted. The configuration must be converted to personas: rewrite it by hand as a "personas" array. Nothing is converted automatically and the file has not been changed.
```

`<key>` is the first pre-persona key found in the file. Any other invalid configuration fails the same way, with a message naming the persona and the field. A server that is already running makes the new one exit with `[slack] Server is already running (PID <pid>). Exiting.`, so `start` exits 1.

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

This mirrors `clean_restart`'s order: the server is stopped **first**, then the bot teardown runs for each persona in `config.json`, addressing its instance as `cscb_<key>` — pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. Teardown kills but never deletes each row, preserving its `claude_session_id` so the bots can resume their conversation history on the next start. Stopping the server first prevents its `onsessionclosed`/`scheduleRestart` handler from respawning a just-exited bot mid-teardown (which would delete its `ended` row and history). Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If agent-director is unreachable, the teardown **fails loudly** — the command prints the error and exits non-zero rather than silently reporting a clean stop. (A config that cannot be loaded, a missing or pre-persona file included, is best-effort: teardown is skipped with `[slack] stop --stop-bots: could not load config — skipping bot teardown:` and the server stop still succeeds, since the server is already down.)

### `claude-slack-channel-bots clean_restart`

Gracefully exits all managed Claude Code sessions, then stops and starts the server.

```sh
claude-slack-channel-bots clean_restart
```

For each persona in `config.json`, calls `client.pause({claude_instance_id})` via agent-director with the persona's instance ID `cscb_<key>`, and polls `client.status(...)` until the spawn transitions to `ended` / `missing` (or `client.status(...)` fails with `ErrSpawnNotFound` because the row is gone). If the spawn does not exit within `exit_timeout` seconds (default 120s), the spawn is force-killed via `client.kill(...)`. Teardown kills but never deletes each row, preserving its `claude_session_id` so bots resume their conversation history on the next start. All personas are processed in parallel. After the server restarts, the SR-1.4 collision-then-act dispatcher decides resume-vs-fresh per persona — agent-director owns Claude session-id state, not CSCB.

`clean_restart` logs its progress to `STATE_DIR/clean_restart.log`. The lines that end it with an error (config load failure, agent-director initialization failure, teardown failure, start failure) are also printed to the terminal.

`clean_restart` loads `config.json` first. If it cannot (a missing or pre-persona file included), it exits 1 with `[slack] clean_restart: failed to load config:` and the loader's error, and nothing is stopped.

A benign kill outcome — the row already being gone — is tolerated per persona and does not abort the restart. Any other per-persona teardown failure, including a pause failure that escalates to a kill which then fails to reach agent-director, is fatal: it fails loudly and aborts the restart (non-zero exit).

Behavior by case:

- **No personas** (`"personas": []`): nothing is torn down; the server is stopped and started.
- **A persona with no instance:** logs `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping` and continues.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **Server fails to start again:** `clean_restart` exits non-zero with `[slack] clean_restart: start failed with exit code <n>`; the reason is in `server.log`.
- **agent-director unreachable:** teardown fails loudly and the restart is aborted (non-zero exit); no new server is started. The `no spawn row` message appears only when a persona genuinely has no spawn, never when the client failed to reach agent-director.

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
bun src/server.ts
```

It loads the same `config.json` that `start` checks for; a missing file stops it with `[slack] Fatal: configuration error — The configuration file "<path>" does not exist. The server requires the configuration file to start.` On startup the server prints the persona count, the MCP endpoint and example config:

```
[slack] Loaded persona config: 2 persona(s)
[slack] MCP server listening on http://127.0.0.1:3100/mcp

Save this to ~/.claude/slack-mcp.json:
{
  "mcpServers": {
    "slack-channel-router": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}

Then launch Claude from a project directory with:
  claude --mcp-config ~/.claude/slack-mcp.json --dangerously-load-development-channels server:slack-channel-router
```

With `SLACK_DRY_RUN=1`, `[slack] Running in dry-run mode — Slack disabled` follows the persona count.

---

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to one of the persona's configured channels or, when the persona's `dm.enabled` is `true`, to a DM conversation ID (`D…`) or a Slack user ID (`U…`/`W…`). A user ID opens a DM with that user and posts there as the persona; the result names the DM conversation ID to use for later calls. Auto-chunks long text according to `textChunkLimit` and `chunkMode` in `access.json`. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `edit_message` | Edit a previously sent message (bot's own messages only) in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `fetch_messages` | Fetch message history from a configured channel, a DM conversation (`D…`, with `dm.enabled` `true`) or a thread in either. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). Saves files to `STATE_DIR/inbox/`. Returns local file paths. Only files hosted by Slack are downloaded; external files are refused. |

Only `reply` takes a user ID; the other tools need a channel or DM conversation ID. When `dm.enabled` ([Persona fields](#persona-fields)) is `false`, the persona has no DM target: no tool can post in, read or open a DM. A tool call with any other target is refused with a tool error naming the persona and the target, and nothing is sent to Slack.

---

## Interject

POST to `/interject` to inject a message into a persona's running Claude instance from localhost. The message reaches only the named persona's instance, never any other persona. Only requests from `127.0.0.1` or `::1` are accepted — external callers are rejected with 403. The bot sees it as described in [Messages a bot receives](#messages-a-bot-receives); the Slack Reply Guard does not remind it to reply.

An injected message carries no Slack conversation. If you want the bot to post a reply in Slack, say in the message text where to post it.

### Request

```sh
curl -X POST http://localhost:<port>/interject \
  -H "Content-Type: application/json" \
  -d '{"persona": "planner", "message": "Hello from a script", "sender": "my-cron-job"}'
```

| Field | Required | Description |
|---|---|---|
| `persona` | yes | The target persona's name or its key. A bot can address itself with the key in its `CSCB_PERSONA` environment variable. |
| `message` | yes | Text to inject into the session. |
| `sender` | no | Label attached to the injected message. Defaults to `"interject"`. |

### Response

On success, returns HTTP 200:

```json
{ "ok": true, "persona": "planner" }
```

`persona` is the target persona's name, even when the request named it by key.

### Error conditions

| Status | Meaning |
|---|---|
| 400 | Invalid JSON, or a missing, empty or non-string `persona` or `message`. |
| 403 | Request did not originate from localhost. |
| 404 | No persona in the applied configuration has that name or key. |
| 405 | Must use POST method. |
| 413 | Request body exceeds 32KB. |
| 503 | The persona is configured but not up (broken or retrying), even if its instance is running, or it has no live connected session. Nothing is delivered. The persona's lines in the server log give the cause. |

### Example: crontab reminder

For recurring prompts, prefer the built-in scheduler (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)) — it needs no host cron and delivers straight to a persona. The host-crontab example below is an alternative when you already run `cron`:

```sh
# crontab -e
0 9 * * 1 curl -s -X POST http://localhost:3100/interject \
  -H "Content-Type: application/json" \
  -d '{"persona": "planner", "message": "Weekly reminder: update the changelog before standup.", "sender": "cron"}'
```

---

## Scheduled Prompts (cscb_cron)

The server fires scheduled prompts into personas once per minute, reading them from a crontable. Each fire is delivered as an `/interject` message to the target persona, exactly as if a script had POSTed it.

### The crontable

Schedules live in the crontable file at `cron_table_path` (default `<config dir>/crontab`, where `<config dir>` is the directory of your loaded `config.json`; override it with the `cron_table_path` key in `config.json`). The server creates the file on first boot if it is absent, with a self-documenting comment header describing the line format. See [Crontable format](#crontable-format) below for the full reference. With the default config location the crontable is at `~/.claude/channels/slack/crontab`:

```sh
cat ~/.claude/channels/slack/crontab
```

### Crontable format

On first boot the server auto-creates the crontable with this self-documenting header:

```
# CSCB crontable — scheduled prompts for the Slack channel bots.
#
# One schedule per line. Fields are positional and whitespace-delimited:
#
#   <min> <hour> <dom> <mon> <dow> <prompt-path> [<persona>[,<persona>...]]
#
#   tokens 1-5 : a standard 5-field cron expression (minute hour day-of-month
#                month day-of-week).
#   token 6    : path to the prompt file to run. It must contain NO spaces — a
#                line with more than 7 whitespace-delimited tokens is a parse
#                error (a path with spaces is unrepresentable). The prompt
#                file's content is capped at 32KB (enforced when the job fires).
#   token 7    : OPTIONAL comma-separated list of personas to target, each
#                written as the persona's name or its key. Naming a persona
#                twice (by name, by key, or both) delivers to it once. A name
#                containing whitespace or a comma cannot be written here —
#                write that persona's key instead. A bot can target itself
#                with the key in its CSCB_PERSONA environment variable. A
#                target that names no persona is logged unknown-persona.
#                Omit the token entirely to target ALL bots — that omission IS
#                the all-bots form. All-bots fan-out is not delivered yet: such
#                a line is logged fanout-deferred each time it fires. There is
#                NO all-bots wildcard: a literal '*' in the target position is
#                a parse error, not "all personas".
#
# Lines beginning with '#' and blank lines are ignored. A malformed line is
# skipped on its own; sibling lines still schedule.
#
# Example (every day at 09:00, run grooming-tick.md, target two personas):
#   0 9 * * * /home/horde/prompts/grooming-tick.md planner,reviewer
#
# Example (every hour on the hour, run standup.md, target all bots):
#   0 * * * * /home/horde/prompts/standup.md
```

Each schedule is one line of **exactly 5 cron fields**, then the prompt-file path, then an optional comma-separated list of personas, each written as the persona's name or its key:

```
0 9 * * 1 /home/horde/prompts/weekly-report.md planner,reviewer
```

Rules:

- **Exactly 5 cron fields** (minute hour day-of-month month day-of-week). Croner's 6-field (seconds-precision) and `@macro` forms are **not** supported.
- **Name each persona by its name or its key.** A persona named twice — by name, by key, or both — receives the prompt once.
- **Use the key for a name with whitespace or a comma.** Such a name cannot be written in a crontable line.
- **Omit the persona list to target ALL bots** — the omission itself is the all-bots form. (All-bots delivery is currently deferred — see [Delivery semantics](#delivery-semantics).)
- **No `*` wildcard in the persona position.** A literal `*` where a persona belongs is a parse error, not "all personas".
- **Prompt paths cannot contain spaces.** A path with spaces is unrepresentable; the extra tokens make the line a parse error and it is skipped.
- **`#` comments and blank lines are allowed** and ignored.
- **A bad line is skipped and logged** (as `parse-error` in the cron log), never fatal — sibling lines still schedule.

Because the count is positional, a **6-field line silently mis-parses instead of erroring.** For example:

```
0 0 1 1 1 1 ~/prompts/p.md
```

Here the 6th field (`1`) is taken as the prompt path and the real path (`~/prompts/p.md`) is taken as the persona list. No error is raised — every slot is filled with something syntactically acceptable — so the schedule fires on a nonsense cadence against a nonsense path. Keep expressions to exactly 5 fields.

**Upgrading a crontable that names channels.** The server never rewrites an existing crontable, so channel-ID targets are not converted. Once your config defines personas, a Slack channel ID no longer names a bot, so edit each such line to a persona name or key; until you do, the target logs `unknown-persona`.

An existing crontable also keeps its old comment header, which still tells bots to write channel IDs. Replace that comment block by hand with the header shown above.

### Path resolution

The prompt-file path resolves as follows:

- A leading `~` expands to the home directory.
- A **relative** path resolves against the **crontable's own directory** — not `$HOME`. This is a deliberate divergence from system cron's convention, so you can keep a `prompts/` directory alongside the crontable and reference it as `prompts/standup.md`.
- An **absolute** path is used as-is.

### How fires appear

A scheduled fire reaches only the target persona's instance, as an `/interject` message with no Slack conversation attached. Its `sender` label is `cscb-cron:<prompt-file-basename>` — for a prompt file `standup.md` the sender is `cscb-cron:standup`. This distinguishes a cron tick from a human and from peer-bot traffic. The [Slack Reply Guard](#slack-reply-guard-stop-hook) never reminds a bot to reply to a scheduled prompt. Because a fire carries no channel, a prompt file that wants a Slack reply must say where to post it. Each schedule delivers its own message independently, so when several schedules match the same minute for the same persona each one arrives as its own `/interject` message.

### The cron log

Every fire outcome is recorded in the cron log at `cron_log_path` (default `<config dir>/cron.log`; override with the `cron_log_path` key). Each attempt writes one line per persona targeted (showing the target as first written in the crontable), plus a per-fire summary line carrying `delivered=N failed=M` counts. The log is plain text, so `grep no-session cron.log` yields readable lines.

The `outcome` field of each line is one of these classes:

| Outcome | What happened | What to do |
|---|---|---|
| `delivered` | The prompt reached the target persona's session. | Nothing — success. |
| `no-session` | The persona exists but is not up (broken or retrying) or has no live connected session, so the message was dropped. | Check the persona's lines in the server log for the cause. A retrying persona comes up on its own; otherwise bring the session up. Failed fires are **never** retried or queued (see below). |
| `unknown-persona` | No persona in the applied configuration has that name or key. | Correct the target in the crontable. |
| `prompt-missing` | The prompt file did not exist at fire time. | Create the file or correct its path in the crontable. |
| `prompt-unreadable` | The prompt file existed but could not be read (see the `errno`). | Fix file permissions or the path. |
| `prompt-oversize` | The prompt exceeds the 32KB `/interject` cap and was skipped, never truncated. | Shorten the prompt file. |
| `parse-error` | The crontable line could not be parsed. | Fix the line — see the crontable header for the format. |
| `http-error` | The localhost POST hit an unexpected HTTP status or a network failure. | Check that the server is listening on loopback (see the `bind` note below) and inspect the `errno`/`status` in the line. |
| `fanout-deferred` | A line with no persona list (all-bots) was matched but not delivered. | None — all-bots fan-out is not yet enabled; give the line an explicit persona to deliver it today. |

### Delivery semantics

- **No retry.** A failed fire is logged and dropped — never queued or re-sent. A persona that is not up, or has no live session, fails every fire until it is up and its session is running again; the server does not queue the missed prompts.
- **Missed fires are skipped, not caught up.** While the server is down, no scheduled prompts fire, and they are not replayed on restart. The `scheduler started, N schedules loaded` line in the cron log marks when scheduling resumed, bounding the outage window.
- **Edits take effect within a minute — no restart.** The scheduler checks the crontable fresh on every tick, so an edit by hand or a line appended by a bot starts (or stops) firing within about a minute. The server is never restarted for a schedule change.
- **Deleting the crontable stops all schedules.** Nothing fires from that moment, a WARN appears in the cron log, and the server re-creates the file empty (with its header) within about two minutes — detection and re-creation happen on separate once-a-minute passes, so the re-create lands up to two tick boundaries after the deletion. Add lines back and they schedule on the next check.
- **Server-local time.** Cron expressions are evaluated in the server's local timezone.
- **Lines without a persona list are deferred.** A line with no persona list is currently matched but logged `fanout-deferred` and not delivered. Give a line an explicit persona to have it fire.
- **`bind` must include loopback.** The scheduler delivers via `127.0.0.1`, so a `bind` set to a single non-loopback interface makes every fire fail with `http-error`. Use the default `127.0.0.1` or `0.0.0.0`.

### Bot self-scheduling

Every managed session carries the resolved crontable path in the `CSCB_CRONTABLE_PATH` environment variable and its own persona key in `CSCB_PERSONA`, so a bot can schedule its own prompts without being told where the crontable lives or what to call itself. Discover both from inside a session:

```sh
echo $CSCB_CRONTABLE_PATH $CSCB_PERSONA
```

To schedule a prompt for itself, a bot appends a line whose persona list is its `CSCB_PERSONA` key:

```sh
echo "0 9 * * 1-5 prompts/standup.md $CSCB_PERSONA" >> "$CSCB_CRONTABLE_PATH"
```

The crontable is the single source of truth for schedules. When adding a schedule, **append** a new line — never rewrite, reorder, or delete other lines. An appended line starts firing within about a minute; no server restart is needed.

---

## Permission Relay

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. Architecture is polling-based on the `agent-director` library — there are **no hook scripts to install** and no HTTP long-poll loops.

Flow:

1. agent-director moves the spawn into `check_permission` state when Claude requests a tool permission.
2. CSCB's poller (`src/permission-poller.ts`) runs `client.list({ state: ['check_permission'], label: ['service=cscb'] })` at the `agent_director_poll_interval_ms` cadence (default 1000 ms).
3. For each new spawn, `client.get(...)` returns the open permission request (tool name, tool input and an opaque `request_token`). CSCB identifies the persona that owns the spawn from its `persona` label and posts the Block Kit prompt to the persona's destination (its `permission_prompts` channel) as that persona.
4. The operator clicks Allow / Deny in Slack. CSCB resolves the click through the same persona: it calls `client.decide({ claude_instance_id, decision, request_token })` and, as that persona, updates the message to "*Permission* — Allowed" or "*Permission* — Denied by operator".
5. If a tracked prompt closes for any reason other than a Slack click, the next poller tick replaces the buttons with the verdict: "⏱ *Permission* — Timed out", "🪦 *Permission* — Session ended", "*Permission* — Allowed", "*Permission* — Denied by operator", or "*Permission* — Denied (closed)" when the reason is unknown.

While a persona is not up (broken or retrying), its instance keeps running but its permission prompts are not posted and its already-posted prompts are left as they are. They appear, or get their verdict, on the first poll after the persona comes up.

### Slack app prerequisites

The Slack app must have **interactivity enabled** with **Socket Mode** as the delivery method. Open your Slack app config → **Interactivity & Shortcuts** → toggle **Interactivity** on. No Request URL is needed; Socket Mode delivers interaction payloads over the existing socket. This is included automatically if you created the app from `slack-app-manifest.yml`.

### AskUserQuestion

The `AskUserQuestion` tool is denied for every CSCB-spawned bot via the agent-director template (`deny: ['AskUserQuestion']`). Bots respond to operator questions via the Slack `reply` MCP tool instead. There is no `ask-relay.sh` hook and no `/ask` HTTP endpoint.

### Memory-directory reads

The template also pre-allows each bot to read its own persistent-memory directory, so those reads don't surface a permission prompt to a human. One `Read(//<config-dir>/projects/*/memory/**)` rule is derived per distinct Claude config directory across your personas (a persona's own `claude_config_dir`, the top-level `claude_config_dir`, or the `~/.claude` default). The rule is scoped to `projects/*/memory/**` only — never the config-dir root, which holds live credentials — so it never pre-authorizes credential reads.

---

## Slack Reply Guard (Stop hook)

CSCB ships a Claude Code Stop hook that gives every bot session it manages a **one-time, declinable reminder** to answer in Slack. When the messages that started the turn include a real Slack message and the bot ends its turn without calling the `mcp__slack-channel-router__reply` tool, the hook exits `2` and Claude Code shows the bot one of these reminders:

| Message came from | Reminder |
|---|---|
| A direct message | `This turn started from a Slack direct message (conversation <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| A channel | `This turn started from a Slack channel message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |

The bot then continues once. It can reply, or end the turn without replying. That continuation carries `stop_hook_active=true`, which the guard always lets through, so the reminder appears at most once per turn and never loops.

Injected messages — cscb_cron scheduled prompts and `/interject` messages — never trigger the reminder, because no Slack conversation is waiting on them. An injected message that arrives right after a human's Slack message does not cancel the reminder for the human's message.

### Messages a bot receives

Every message reaches a bot as its text wrapped in a `<channel source="slack-channel-router" …>` tag. This table covers every source and whether the guard reminds the bot to reply to it.

| Source | How it gets to the bot | Tag attributes | Reminder? |
|---|---|---|---|
| Direct message | Goes to the persona whose Slack app received it when that persona's `dm.enabled` is `true`, whatever the text mentions. When `dm.enabled` is `false`, the server drops it and logs one `persona-dm-dropped` line naming the persona and `dm.enabled`. A group DM is never delivered. | Same as the @mention row, with `chat_id` = the DM conversation ID and `via` = `dm` | Yes, DM wording |
| Channel message that @mentions the bot | Goes to the persona when the channel is one of its `channels`, with either `delivery`. The persona's @mention is removed from the text. A message in a channel no persona is configured into is not delivered. | `chat_id` = the channel ID, `user` = the sender's Slack display name (falling back to real name, then Slack username, then user ID; for a webhook or integration post, the post's username, else its bot profile name, else its bot ID), `message_id` and `ts` = the Slack timestamp (for example `1789936743.069939`). Also `user_id` = the author's Slack user ID (or `bot_id` for a post without a user) and `via` = how the message arrived (for example `mention` or `broadcast`); `thread_ts` for a thread reply, and `attachment_count` and `attachments` when files are attached. | Yes, channel wording |
| Channel message in a `delivery: all` channel | The persona receives every message in the channel, from any sender other than itself. In a `delivery: mentions` channel it receives only messages that @mention it or use `@here` / `@channel`. | Same as the @mention row | Yes, channel wording |
| cscb_cron scheduled prompt | The server's scheduler posts it to `/interject`; it reaches only the target persona's instance. | `user="cscb-cron:<prompt-file-basename>"` and `ts` = the server clock in seconds, with at most three decimal places | No |
| `/interject` message | A localhost script POSTs it (see [Interject](#interject)); it reaches only the named persona's instance. | `user` = the request's `sender` (default `interject`) and `ts` in the same form as a scheduled prompt | No |

Points to handle in a bot's prompt:

- **`/interject` sender labels are free-form.** Any localhost caller can set any `user` value, including one that starts with `cscb-cron:`. To tell an injected message from a Slack message, check `ts`: Slack timestamps always have six decimal places, and injected ones have at most three. The guard relies on this check too.
- **Personas can see each other's Slack posts.** Each persona posts as its own Slack app, and the server drops only a persona's own messages. Another persona's post reaches it like any other message: in a `delivery: all` channel always, in a `delivery: mentions` channel when the post @mentions it or uses `@here` / `@channel`.

### What the server writes, and where

CSCB owns installing the hook on your behalf. On every server boot, alongside the trust-folder bootstrap, the server walks every persona, groups them by effective `claude_config_dir` (a persona's own value falls back to the top-level value), and patches `<claude_config_dir>/settings.json` in place. For each dir it ensures **exactly one** managed Stop-hook group of the shape:

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

The bootstrap rewrites `settings.json` on **every** CSCB boot, so the on-disk entry always reflects the currently-installed release's absolute path. Claude Code, however, only reads hook configuration when a Claude process starts. On a CSCB restart, live sessions are reconnected and keep their already-running Claude processes — they will not pick up an updated hook path until the next fresh spawn or the next resume of a dead/missing session for that persona.

### Shared-dir aggregation

The install/remove decision is per **directory**, not per persona. If two personas resolve to the same `claude_config_dir`, the managed entry is installed when at least one of them has the guard enabled, and removed only when all of them have it disabled. Consequence: a per-persona opt-out fully disables the guard for a bot only when that persona has a *dedicated* `claude_config_dir`. A persona that shares a dir with any enabled persona still gets the guard on that shared dir.

### Personal-dir refusal

The bootstrap refuses to touch the operator's own `~/.claude` directory. If a persona's effective `claude_config_dir` resolves (via `realpathSync`, with a lexical fallback for paths that do not exist on disk) to your home `.claude` dir, nothing is written and a startup error is recorded. This prevents CSCB from ever installing a bot-oriented Stop hook into your interactive Claude Code config.

### Bots without a `claude_config_dir`

Personas with no effective `claude_config_dir` — neither their own nor top-level — are skipped. Empty or whitespace-only values are treated as absent (so `resolve("")` never lands in the process cwd). If you want the guard on a bot, give its persona a real `claude_config_dir`.

### v1 limitations — opt these bots out

The v1 guard only recognises a reply via `mcp__slack-channel-router__reply`. Bots whose only Slack surface is `edit_message` or `react` end their turn without producing a matching `tool_use`, so the guard reminds them after every Slack message and costs them one extra, useless continuation each time. **Opt these bots out** by setting `stop_hook_bootstrap: false` on the persona (see [Per-persona `stop_hook_bootstrap` override](#per-persona-stop_hook_bootstrap-override)), and give the persona a dedicated `claude_config_dir` — see [Shared-dir aggregation](#shared-dir-aggregation).

### Opting out

The `stop_hook_bootstrap` boolean lives on the top level of `config.json` and on individual personas. It defaults to `true`. Set it to `false` at the top level to disable the bootstrap for every persona; set it on an individual persona to override the top-level default for one bot. See [Server-wide settings](#server-wide-settings) and [Per-persona `stop_hook_bootstrap` override](#per-persona-stop_hook_bootstrap-override) above for the field details and the per-persona-vs-shared-dir interaction.

### Tag drift — fail-open, verify after upgrades

The guard reads the `<channel …>` tag at the very start of each message that started the turn, treats it as a Slack message when its `source` starts with `slack`, and uses its `chat_id`, `user`, and `ts` attributes. A tag quoted later in a message's text is ignored. CSCB only sends `{content, meta}` over MCP; the `<channel source="…">` wrapper is rendered by the **Claude Code harness itself** when it serialises the MCP tool result into the transcript, and the `source` attribute is the MCP server name (e.g. `slack-channel-router`). That tag is therefore an **external, harness-owned contract** — a future Claude Code release can rename it or restructure the wrapper without touching CSCB, and the guard would silently stop matching. Because the contract sits outside CSCB, the guard is designed to fail open on drift, and a post-upgrade verification recipe (below) exists so operators catch a silent-dark guard the next time the harness changes the tag.

The guard is **fail-open by design**: any error, missing transcript, missing `jq`, or absence of the tag results in `exit 0` (turn allowed). This means a future rename of the `<channel>` tag will silently disable the guard rather than break the bot. After every CSCB or Claude Code upgrade, verify the guard end-to-end:

1. Send the bot a Slack message that requires a reply.
2. Confirm the reply lands in Slack.
3. In the bot's transcript file (`<claude_config_dir>/projects/<slug>/*.jsonl` — guard-covered bots always run with a dedicated `claude_config_dir`, since the bootstrap refuses the operator's personal `~/.claude`), grep for `<channel source="slack` at the start of the triggering message's text, confirm that tag still carries `chat_id`, `user`, and `ts` attributes, and look for a subsequent assistant entry containing `"name":"mcp__slack-channel-router__reply"` in a `tool_use` block.

If the tag or any of those attributes no longer appears, the guard is dark or misclassifying messages — file an issue.

---

## Troubleshooting

**config.json not found**
`start` exits with `missing prerequisite: config.json not found at <path>`. Run `bun src/postinstall.ts` from the installed package directory to create the skeleton (`{"personas": []}`), or create the file manually. Verify `SLACK_STATE_DIR` matches the directory you populated.

**Session connects but has no persona**
If a Claude Code session connects but immediately disconnects, `server.log` shows `Session connected with CWD "<path>" — no matching persona`: the session's working directory is no persona's `working_directory`. It is compared with each persona's `working_directory` by real path (after tilde expansion, with symlinks resolved), so a symlinked path to the same directory also matches. If a second session connects from the same directory, it replaces the first. Two personas with the same working directory are rejected when the configuration loads.

**A persona doesn't come up or doesn't answer**
Symptoms: the persona is silent, `/interject` returns 503 for it, or its scheduled prompts log `no-session`. One broken persona never stops the server or delays the others, and nothing about it is posted to Slack. Look in `server.log` instead. Find the persona's key on its `persona-start` line, then read its lines. Each failure line names a class, the persona's `personas[i]` entry and the file or directory at fault:

```sh
grep persona-start ~/.claude/channels/slack/server.log | tail
grep -E '\(key=<key>\)|persona=<key>\b' ~/.claude/channels/slack/server.log
```

| Class | Persona | What to do |
|---|---|---|
| `persona-credentials-*` | Stays down | Fix the credentials file, then restart the server |
| `persona-slack-unreachable` | Retries on its own | Nothing; it comes up once Slack answers |
| `persona-directory-*` | Retries on its own | Create or fix the working directory; the persona comes up with no restart |

While a persona is down, its Claude instance keeps running and keeps its history, but the server doesn't serve it until the persona is up.

The `debug-slack-channel-bots` skill has an entry for every persona log class, every `config.json` rejection and each recovery step. It ships in the package at `skills/debug-slack-channel-bots/SKILL.md` (`node_modules/claude-slack-channel-bots/skills/debug-slack-channel-bots/SKILL.md` after install). Copy it to `~/.claude/skills/debug-slack-channel-bots/SKILL.md`, then invoke `/debug-slack-channel-bots` from Claude Code.

**Bot not receiving messages in a new channel**
After inviting the bot to a channel, Slack may not deliver messages until the bot is @mentioned for the first time. This is a Slack Socket Mode behavior — the first @mention activates event delivery for that channel. After that, all messages flow normally.

**File attachment fails after a long wait**
Each attempt of a Slack request is limited to 30 s, and that includes uploading a file attached with `reply`. An upload that takes longer than 30 s fails on every attempt, so the tool returns an error only after about 30 minutes, once the standard retries are spent. This is not a hang: send smaller files, or split a large attachment into several smaller ones.

**Messages in a channel no persona is configured into are not delivered**
A channel that is in no persona's `channels` reaches no bot, even when a persona's Slack app is a member. Each such message logs an `unclaimed-channel` line naming the channel and the persona whose app received it in `server.log`:

```sh
grep unclaimed-channel ~/.claude/channels/slack/server.log
```

Add the channel to a persona's `channels` and restart the server.

**Permission relay not working**
Check that the Slack app has interactivity enabled (Interactivity & Shortcuts → toggle on). Verify the bot is in `check_permission` state via `agent-director list --state check_permission --label service=cscb` (operator CLI). Inspect `server.log` for `permission-poller:` lines — skipped-tick WARNs at 5+ consecutive skips signal that the poll interval is too tight; increase `agent_director_poll_interval_ms` in `config.json`.

**Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning**
The bot is wedged in `check_permission` on a native Claude Code TUI prompt that never reached Slack (a permission decision AD recorded but could not deliver). The bot stops responding, and after ~90 s the poller posts a one-shot warning naming the persona to the persona's destination. Recover by inspecting the native prompt with `agent-director read-pane --claude-instance-id <id>`, then killing and respawning the session (`agent-director kill <id>` or tmux-kill, then let the server restart it or `claude-slack-channel-bots stop && claude-slack-channel-bots start`). Do **not** use `send-keys` — agent-director hard-rejects it while the spawn is in this relayed permission state. The warning fires once per wedge episode; the detector re-arms if the bot later wedges again.

**Session not restarting after crash**
Auto-restart backs off exponentially on repeated launch failures — the delay doubles from `session_restart_delay` (default 60s) on each consecutive failure, up to a 15-minute ceiling. After 5 consecutive failures the persona hits a cap: a `SpawnCapReached` notice naming the persona is posted to the persona's destination (its `permission_prompts`) and automatic restarts stop.

A message delivered to a persona whose session is dead but not yet capped triggers a fast recovery: the restart is scheduled immediately (the backoff delay is clamped down to 5 seconds for an explicit human trigger, never raised), and the sender is told the session is starting and to retry in a moment. The dropped message itself is **not** delivered or replayed — recovery only starts the session; you must resend after it comes up. This human trigger still counts each failed launch toward the backoff/cap, and a restart already pending or active is not stacked.

A **capped** persona (or any persona when auto-restart is disabled via `session_restart_delay: 0`) does **not** recover on an inbound message — firing another launch there would only burn a spawn attempt against a persona that cannot come up. The sender is told plainly that the channel will not self-recover and an operator must restart the server. To clear the cap and retry, restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`; the failure counter is in-process and cleared on restart, giving each persona a fresh attempt. To disable auto-restart entirely, set `session_restart_delay` to `0` in `config.json`.

**Bot alive but silently unresponsive (MCP disconnected)**
A bot can stay running yet lose its MCP connection to the server — the process is alive but no longer reachable, so it stops responding without ever emitting a disconnect event. The periodic health-check recovers this automatically: once a persona is seen alive-but-disconnected on two consecutive ticks, the health-check schedules a reconnect (or a relaunch if the process has since died), so a stranded persona comes back with no inbound message and no server restart. The recovery lands within roughly two `health_check_interval` periods (default 120 s each) plus the restart backoff delay (default `session_restart_delay` 60 s) before the reconnect runs — about 3–5 minutes with default settings. A bot mid-turn (`working` state) is deliberately left alone and reconnected on a later tick once its turn settles.

A closely related symptom is a bot that still *looks* connected but silently drops every inbound message — its underlying message stream went away without the connection registering as closed. The same health-check path recovers this on the same two-consecutive-tick cadence, so no inbound message or server restart is needed. If a message for such a persona arrives before recovery lands, the sender is told the message was not delivered and to retry in a moment, rather than getting silence.

To verify recovery in the field, tail `server.log` for a stranded persona and confirm a tick-driven recovery lands — look for a `[slack] Scheduling restart for persona=<key> in <N>s (backoff)` line and a `[slack] Session alive but disconnected — reconnecting MCP for persona=<key>` line naming that persona's key (and, when the bot was mid-turn, a `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)` line first). A **capped** persona is exempt: the health-check skips it entirely, including reconnects, so a capped persona still requires a server restart (see above).

**Session stuck during clean_restart**
If a session does not exit within `exit_timeout` seconds (default 120s), `clean_restart` force-kills the spawn via `agent-director kill` and proceeds. To manually recover, run `agent-director list --label service=cscb` to find lingering spawns and `agent-director kill <claude_instance_id>` to clear them, then `claude-slack-channel-bots stop && claude-slack-channel-bots start`.

**`clean_restart` or `stop --stop-bots` exits non-zero with an agent-director teardown error**
This is intentional: when agent-director is unreachable, the teardown cannot run, so the command fails loudly rather than silently no-op'ing and (for `clean_restart`) restarting on top of bots it never touched. Confirm agent-director is installed and responsive with `agent-director version`, then re-run the command. Teardown kills but never deletes rows on any failure path, so it is always safe to retry once agent-director is reachable.

**Bots come back with no memory of the prior conversation after a reboot**
With `resume_enabled: true`, a bot whose host rebooted (or pod resumed) should return with its conversation history. If it comes back amnesiac, confirm the system-installed `agent-director` is **≥ 0.8.0** (`agent-director version`) — reboot recovery relies on capabilities added in that release. Note that `bun run install-check` does **not** confirm this: its client floor is `0.7.0`, lower than the reboot-recovery requirement, so install-check passes on a `0.7.x` binary that still yields amnesiac bots. Verify the resume requirement directly with `agent-director version`. Note: legacy sessions created before upgrading to 0.8.0 may lose history exactly once on their first post-upgrade recovery, then resume cleanly thereafter.

A bot also starts fresh, by design, when its session no longer matches the config. Config edits take effect only when the server starts. If you change a persona's `working_directory`, the next server start replaces the session instead of resuming it. If you change a persona's effective `claude_config_dir` (its own or the top-level default), the bot starts fresh the next time it would be resumed: after `clean_restart`, after `stop --stop-bots` then `start`, after a reboot, or when the bot dies. A bot that keeps running across a plain `stop` and `start` keeps its old config directory until then. The old transcript stays in the old config directory. The first start after upgrading from an earlier release also replaces every existing bot once, because the server removes managed sessions it cannot attribute. The log names the reason: search `server.log` for `sweeping row`, `replacing the row` or `not resuming; spawning fresh`.

**Session crashes on resume with "sandbox required but unavailable"**
This is a known regression in certain Claude Code releases (e.g. v2.1.120) where `--resume` triggers a sandbox check that fails in headless environments. Set `resume_enabled: false` in `config.json` to disable `--resume` entirely — the bot will always start a fresh Claude session instead of resuming a prior conversation, both on startup and on runtime auto-restart:

```json
{
  "personas": [ ... ],
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

- `jsonl-non-persistent` — a session-transcript storage root (`<claude_config_dir>/projects`) is on a `tmpfs`/`ramfs` mount, so nothing there survives a reboot and session resume is structurally impossible on this host. A warning is also posted to the destination of each affected persona — those whose transcript storage root is the flagged mount, not every persona. Move the config dir to a persistent filesystem.
- `jsonl-persistence-check-warning` — the safeguard could not determine the filesystem type of a transcript storage root (unreadable/unparseable `/proc/self/mountinfo`, or an unresolvable path), so persistence is unverified. No Slack post is made. Investigate the mount before relying on resume.
- `jsonl-transcript-stale-path` — a persona's saved transcript exists on disk at the resolved fallback path, but agent-director's recorded `jsonl_path` points elsewhere (missing/empty). On the next restart the resume path would treat it as missing and wipe the persona's memory. A warning is posted to the persona's destination; an operator should reconcile the path before restarting.
- `jsonl-transcript-lost` — a persona's transcript is gone from disk (neither the recorded nor the fallback path exists), yet the message archive shows messages in the persona's `delivery: all` channels since the bot spawned. Only those channels are counted. Conversation history has been lost and resume will start the bot fresh. A warning is posted to the persona's destination. Requires `message_archive_db` to be configured for the archive evidence. When the archive shows nothing, the safeguard logs a quiet line only: no transcript is expected for a persona idle since spawn, and for a persona with a `delivery: mentions` channel or DMs on a zero count proves nothing. A row the server will replace rather than resume (its working directory or config directory changed) is not checked.
- `jsonl-transcript-lost-on-resume` — resume actually threw `ErrJsonlMissing` for a persona, the bot was delete+fresh-spawned, and the message archive shows messages in the persona's `delivery: all` channels since it spawned — so conversation history was destroyed by this recovery, not merely at risk. Only those channels are counted. A warning is also posted to the persona's destination. This is the resume path's own after-the-fact report (distinct from the pre-resume `jsonl-transcript-lost` warning above); the log line names every transcript path tried and whether each came from agent-director or was computed locally. A missing transcript on a persona that was *idle since spawn* — the archive was consulted and shows zero messages since spawn, and every one of the persona's channels is `delivery: all` with DMs off — is expected (the transcript is created lazily on first message) and produces a quiet log line only, no error class and no Slack post. Requires `message_archive_db` for the archive evidence; when the archive cannot be consulted the case is instead reported as `jsonl-diagnosis-inconclusive` below.
- `jsonl-diagnosis-inconclusive` — resume threw `ErrJsonlMissing` and the bot was delete+fresh-spawned, but the diagnosis could not determine whether conversation history was lost: the agent-director row could not be fetched, `started_at` was unparseable, the message archive could not be read, `message_archive_db` is not configured at all, or the archive shows zero messages but the persona has a `delivery: mentions` channel or DMs on, so a zero count cannot show it was idle (the archive cannot attribute messages from `mentions` channels or DMs to a persona). Because "inconclusive" correlates with the same storage problems that cause real loss, this is surfaced (not silently downgraded to a benign never-created): the line records *why* the diagnosis failed, and a warning is posted to the persona's destination worded as uncertainty ("on restart I was started fresh; I could not determine whether my prior conversation history was preserved") rather than as a confirmed loss. When the reason is an unconfigured archive, the message notes that diagnosis is impossible without `message_archive_db` and suggests enabling it. These personas are counted separately in the startup summary as `fresh-after-inconclusive-amnesia` (distinct from the `fresh-after-amnesia` count).

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
6. **No stranded finished work.** `scripts/audit-finished-tickets.sh` must exit zero. It flags any `finished` ticket whose fix is neither on `main` nor explicitly closed — closure means either a stated reason (no-repro / won't-fix / not-a-bug / by design / works as intended / superseded / abandoned / satisfied by other work) or one of the anchored headings `## +closed:out-of-repo <path>` (fix landed outside this repo; the path names the artifact) and `## +closed:docs-only` (product lives outside any git repo) — any unmerged branch tied to a finished ticket, and any unmerged branch that references no known ticket at all. A release cannot ship while a fix is silently stranded on a dead branch. The gate is read-only — it never mutates tickets or git. This gate runs in Phase 1 preflight, **before** the `/ci` gate below, so a stranded-work failure aborts the release before the Docker suite ever runs. The gate splits its failure by the audit's exit code: audit exit 1 (stranded work) → preflight exit 16; audit exit 2 (setup failure — the Bugs/Plans/Ideas hives, a git repo, or a `main` ref were not locatable from this checkout, e.g. a throwaway `/tmp` clone) → preflight exit 17, whose fix is to rerun `/publish` from the canonical checkout that sits beside the hives. **This gate is green today — it exits zero with no findings.** There is no known expected debt in either class, so a non-zero result is a new, real finding to investigate before releasing. Do not re-list findings here — the audit's own output is the inventory.
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
8. Polls the npm registry every 5 seconds for up to 10 minutes until the new version is visible, printing a progress line every ~30 seconds. npm propagation commonly takes a few minutes, so a multi-minute wait here is normal.
9. Sanitizes the bun-1.3.13 empty-string-dependency-key poison from the global `package.json` (see [Installing from a local worktree](#installing-from-a-local-worktree)), removes any pre-existing global install, then runs `bun install -g claude-slack-channel-bots@<version>` — the exact command an end user would run — and verifies the installed bin resolves under `~/.bun/install/global/` at the published version. If the `claude-slack-channel-bots` on PATH resolves somewhere else (an install in another bun prefix shadowing this one), the diagnostic names the shadowing path, the symlink chain, and the manual fix.
10. Trusts the package if the global manifest does not already (`bun pm -g trust`) and checks that the postinstall's `~/.claude/channels/slack/{config.json,access.json}` and `~/.claude/slack-mcp.json` exist — a missing file is a warning, not a release failure.
11. Prints a success summary identifying the published version, npm URL, GitHub release tag URL, resolved local install path, and the next-operator-action command.

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

After step 1, every CSCB bot is spawned through `client.spawn(...)` with `relay_mode='on'`. The green/red Slack button UX is byte-identical to the pre-migration behavior; the action_id shape changes from `perm_(allow|deny)_<uuid>` to `perm_(allow|deny)_cscb_<key>_<request_token>` (where `<key>` is the persona key and `<request_token>` is a UUIDv4 minted by agent-director) but this is invisible to end users.

### Upgrading to personas

This version configures bots as personas. When you upgrade from an earlier version:

- **Rewrite `config.json` by hand.** A configuration from an earlier version is rejected at start with an error saying it must be converted to personas. Nothing is converted automatically and the file is not changed. Write a `personas` list as described in [Personas (config.json)](#personas-configjson); the server-wide settings keep their names.
- **Move the tokens into credentials files.** Slack tokens are no longer read from environment variables. Create one [credentials file](#credentials-files) per persona, then remove the token exports from your shell profile.
- **Give each persona its own Slack app.** Your existing app can serve one persona; create another app for each additional persona.
- **Expect each bot to start fresh once.** Bot instances created before this version are replaced at the first start after the upgrade, so each persona starts once without its prior conversation.

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

