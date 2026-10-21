# Server settings

The top-level `config.json` settings that apply to the whole server, the environment variables CSCB reads, and `slack-mcp.json`. Each persona's own settings are in [Configuration](configuration.md); how a change is applied is in [Reload](reload.md).

## Server-wide settings

These top-level fields apply to the whole server. A confirmed change to one takes effect at the next server start, with four exceptions. `allow_invited_channels` is the one setting a confirmation applies in place, at once. A change to `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. `stop_timeout` and `exit_timeout` are used only by the CLI, which takes them from the record at once. `agent_director_call_timeout_ms` is used by both: the CLI takes it from the record at once, and the running server uses it from its next start. See [What a confirmation applies](reload.md#what-a-confirmation-applies).

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. Scheduled prompts directly enter the queue and need no HTTP or loopback. [`clear-latch`](cli.md#claude-slack-channel-bots-clear-latch) still needs loopback (the default, or `0.0.0.0`). |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | number | `60` | Seconds to wait before auto-restarting a session that crashed or disappeared. A session that ended cleanly (an `agent-director pause`, a `/exit`) is relaunched about 3 s after it disconnects instead, unless the persona's last launch failed or it had such a fast relaunch within the last `session_restart_delay` seconds (see "Session not restarting after crash" in [Troubleshooting](troubleshooting.md#troubleshooting)). Set to `0` to disable auto-restart, clean exits included, and the health check's reconnects (not the retries of a persona agent-director refused; see [Troubleshooting](troubleshooting.md#troubleshooting)); a persona whose session runs but can't receive messages then gets a *Not connected* notice at its destination (see [Troubleshooting](troubleshooting.md#troubleshooting)). A Slack message also triggers reconnect after MCP disconnect; at `0` it does not, and messages wait until reconnect or restart. At any value, a persona reported as `working` that the server can't prove idle for 10 minutes gets a *Not connected* notice. Must be non-negative. |
| `health_check_interval` | number | `120` | Seconds between periodic liveness polls. Set to `0` to disable; the retries of a persona agent-director refused still run. Must be non-negative. |
| `exit_timeout` | number | `120` | Seconds to wait for a managed Claude Code session to exit gracefully during `clean_restart` or `stop --stop-bots` before force-killing it through agent-director. |
| `stop_timeout` | number | `30` | Seconds to wait for the server process to exit after `SIGTERM` before escalating to `SIGKILL`. |
| `mcp_config_path` | string | `~/.claude/slack-mcp.json` | Path to the MCP config file passed to Claude Code when launching managed sessions. |
| `append_system_prompt_file` | string | — | One shared file supplies obedience instructions for every persona: say whose instructions each bot follows here. Its text is composed with CSCB’s tag description for `--append-system-prompt-file`. Missing file silently skipped. See `skills/EXAMPLE_CLAUDE.md` for a template. |
| `system_prompt_mode` | string | `"append"` | Controls how `append_system_prompt_file` is applied. `"append"`: the custom prompt file is appended on top of `CLAUDE.md` (default, current behavior). `"none"`: the operator file is ignored even if set. CSCB’s tag description is always carried, including in `none` mode. Use `"none"` when the project's `CLAUDE.md` already contains everything the bot needs. |
| `fresh_system_prompt` | boolean | `true` | When `true` (default), every bot launches with `--system-prompt-snapshot off`, so a restarted or resumed bot loads the current system prompt file and `CLAUDE.md` and keeps its conversation, whatever `system_prompt_mode` is. When `false`, the flag is omitted. A change takes effect at the next server start. Needs a Claude Code that has `--system-prompt-snapshot` (confirmed on 2.1.280); on an older one set it to `false`. A bot keeps the launch arguments it was started with on every resume, so a change reaches a bot only when it next starts a new conversation; a `clean_restart` that resumes conversations does not apply it to those bots. |
| `cozempic_prescription` | string | `"standard"` | Cozempic cleaning intensity before resume. Valid values: `gentle`, `standard`, `aggressive`. Has no effect if cozempic is not installed. |
| `message_archive_db` | string | — | Path to a SQLite DB where every inbound Slack message is archived in real time. Parent directories are created if missing; schema is initialized on first open. Compatible with the `archive-messages.py` backfill script — both can write concurrently. Each channel's name is looked up through the receiving persona's Slack app, which needs the `channels:read` and `groups:read` bot scopes that the shipped `slack-app-manifest.yml` grants. For channel IDs in place of names, see [The message archive shows channel IDs](../skills/debug-slack-channel-bots/SKILL.md#the-message-archive-shows-channel-ids-re-install-each-app-to-gain-channelsread-and-groupsread). A DM's rows keep the DM's `D…` ID whatever the scopes, as a DM has no name; a group DM's rows keep its ID too. Feature is disabled when absent. |
| `claude_config_dir` | string | — | Default Claude on-disk config directory for every persona. When a persona has one (its own or this default), its session launches with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the bot authenticates against a specific account. `~` is expanded and the path is resolved to absolute. A persona's own `claude_config_dir` overrides this value. When neither is set, Claude's own default applies. Must be non-empty when set. |
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh; after 2 resumes in a row that end before the session starts (a transcript Claude Code can't load), it starts fresh instead (see "Session not restarting after crash" under [Troubleshooting](troubleshooting.md#troubleshooting)). When `false`, a bot is never resumed: on startup and on runtime auto-restart it starts a new conversation on the same instance, even when a stored session exists, and its Claude row retains its AD life and prior sessions. For resume failures, see [Troubleshooting](troubleshooting.md#troubleshooting). |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. For configuration errors, see [Troubleshooting](troubleshooting.md#troubleshooting). |
| `agent_director_call_timeout_ms` | number | `60000` | How long (ms) CSCB waits on each agent-director call it makes for its personas, in the server and in `stop --stop-bots` and `clean_restart`. Must be an integer in `[1000, 3_600_000]`; out-of-range values are rejected at load. It should be greater than the need that agent-director's timing settings give; see [Sizing the agent-director call timeout](agent-director.md#sizing-the-agent-director-call-timeout). |
| `stop_hook_bootstrap` | boolean | `true` | Default for every persona: whether the persona gets the Slack Reply Guard reminder (see [Slack Reply Guard (Stop hook)](bots.md#slack-reply-guard-stop-hook)). The value applies per persona, from the persona's first launch after the change is applied (see [Reload](reload.md#reload)). A persona's own `stop_hook_bootstrap` overrides this value. Non-boolean values are rejected at startup. |
| `cron_table_path` | string | `~/.config/claude-slack-channel-bots/crontab` | Path to the crontable for the built-in cron scheduler (`cscb_cron`). When absent, it is `crontab` in the state directory, beside `config.json`: `~/.config/claude-slack-channel-bots/crontab` by default, outside `~/.claude`, so a bot's edit is not a write under `~/.claude`, which Claude Code asks the user to approve. A path you set is used as written, with `~` expanded like other path keys: the server never creates its directory or moves a crontable to it. The resolved path is exported into every managed session as `CSCB_CRONTABLE_PATH` so bots can find the crontable and self-schedule (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)). Must be a non-empty string when set. |
| `cron_log_path` | string | `<config dir>/cron.log` | Path to the `cscb_cron` log file. Defaults to `cron.log` in the directory of the loaded `config.json`, wherever the crontable is. `~` is expanded like other path keys. Must be a non-empty string when set. |
| `cron_log_max_bytes` | number | — | Size cap in bytes for the cron log. Once a line takes the log past the cap, the server drops its oldest whole lines until it fits. The newest line is always kept, even when it alone is larger than the cap. Nothing is rotated or archived, so dropped lines are gone. Absent means no cap: the log only grows. Must be a positive integer when set. |
| `queued_ack_reaction` | string | `"beehive"` | Emoji name, without colons, added under each receiving persona's own Slack identity after durable acceptance, including while its bot is busy or down. Must be non-empty when set. See [Acknowledgement reactions](#acknowledgement-reactions). |
| `ack_reaction` | string | `"spinthinking"` | Emoji name, without colons, replacing the queued reaction after transcript receipts confirm the whole message and delivery is durably recorded. Must be non-empty when set. `spinthinking` is a custom emoji; see the prerequisite below. |
| `reply_chunk_limit` | number | `4000` | Maximum characters per posted message: the `reply` tool splits longer text into several messages. Must be a positive integer. |
| `reply_chunk_mode` | `"length"` \| `"newline"` | `"newline"` | How the `reply` tool splits text longer than `reply_chunk_limit`. `length`: hard split at the limit. `newline`: split at newline boundaries within the limit; a single line longer than the limit is posted whole. |
| `allow_invited_channels` | boolean | `false` | Picks the channel mode for every persona. Absent or `false` is **declarative mode**: each persona's `channels` and top-level `permission_prompts` are in force, and its `invited` section is not read. `true` is **fungible mode**: each persona's `channels` and top-level `permission_prompts` are not read, and its `invited` section is in force. A confirmed change applies in place at once and keeps every session. Non-boolean values are rejected at load. See [Channel modes](channel-modes.md#channel-modes), and read [Who can reach a persona in fungible mode](channel-modes.md#who-can-reach-a-persona-in-fungible-mode) before turning it on. |

---

### Acknowledgement reactions

**Custom emoji must exist in the Slack workspace before you configure them.** `spinthinking` is custom; before starting, make sure both selected names are available in each persona's workspace. Omitting either setting selects its default; empty strings and `null` are invalid.

CSCB removes the queued reaction before adding the delivered reaction. Setting both names alike keeps one reaction through both stages; dropped messages and injected messages get neither. The first successful `reply` text post or file upload carrying the original `message_id` clears that persona's actual stage without delaying the rest of the reply.

Both settings take effect only at server startup after a [confirmed change](reload.md#what-a-confirmation-applies). Outstanding work retains its original queued name across restarts and setting changes, including when queued feedback is restored after reconnect; its delivered stage uses the setting in effect at delivery.

A reply before delivery suppresses later stages: early replies are remembered for 24 hours and pending/completed reaction tracking lasts 30 days in memory. Restart loses reply suppression, so already answered retained work can acquire a reaction again. For missing or lingering reactions, see [Troubleshooting](troubleshooting.md#troubleshooting).

---

## Environment Variables

Runtime options are read from environment variables. None of them is required. Slack tokens come only from each persona's credentials file (see [Credentials files](configuration.md#credentials-files)). There is no `.env` file — export any of these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_STATE_DIR` | Override the directory where `config.json` and runtime state are stored. Defaults to `~/.config/claude-slack-channel-bots` (see `XDG_CONFIG_HOME` below), outside `~/.claude`, where Claude Code asks the user before every write. The crontable defaults to `crontab` in this directory (see `cron_table_path` under [Server-wide settings](#server-wide-settings)). |
| `XDG_CONFIG_HOME` | The standard XDG configuration directory. With `SLACK_STATE_DIR` unset and `XDG_CONFIG_HOME` an absolute path, the state directory, and the crontable in it, is `$XDG_CONFIG_HOME/claude-slack-channel-bots` instead of `~/.config/claude-slack-channel-bots`. An empty or relative value is ignored. |
| `SLACK_DRY_RUN` | Set to `1` (or `true` / `yes`) to start the server without Slack. No credentials file is read and no Slack call is made. Each persona runs with a placeholder identity (`U000DRY_<key>`), and MCP tool calls (`reply`, `react`, etc.) and server notices are logged instead of sent. |
| `CSCB_LOG_MAX_BYTES` | Rotate `server.log` / `clean_restart.log` when the active file reaches this many bytes. Defaults to `10485760` (10 MiB). Values `<= 0` or non-numeric are ignored. |
| `CSCB_LOG_KEEP` | Number of rotated generations to retain (`server.log.1` … `server.log.N`). Defaults to `5`. Set to `0` to keep none (the log is truncated instead of rolled). Values `< 0` or non-numeric are ignored. |
| `CSCB_AD_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the agent-director library's per-poll `SubprocessClient: <verb> ok` success dumps in `server.log`. Off by default — these routine dumps are dropped so the log stays readable. Failures and warnings from agent-director always pass through regardless of this flag. Read once at server startup, so it takes effect on server restart. |
| `CSCB_HTTP_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the per-request MCP access line (`HTTP <method> <path> session=…`) in `server.log`. Off by default — the `/mcp` endpoint is hit on every client poll and SSE open, so these routine lines are dropped to keep the log readable. Session connect/disconnect, sessions with no matching persona, and errors are logged unconditionally regardless of this flag. Checked per request, so it takes effect without a restart. |

---

## MCP Server Config (slack-mcp.json)

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

If you change `port` or `bind` in `config.json`, the confirmed change takes effect only at the next start (see [Reload](reload.md#reload)), so update the `url` here to match at that restart. The server-managed session launcher uses `mcp_config_path` from the applied configuration to locate this file.

---

## Message text and privacy

Undelivered message text is kept until delivery, including a removed persona’s queue. Delivered text is removed within 24 hours. Typed Slack text also remains in the agent’s native transcript and prompt history file; Claude Code keeps these in its config directory.

`server.log` retains message text in received-event, dispatch and `/interject` lines. Protect the state and Claude Code config directories and any log copies accordingly.
