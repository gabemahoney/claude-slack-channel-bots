# Configuration

The full reference for `config.json`, its credentials files, the environment variables CSCB reads, `slack-mcp.json` and the two channel modes. To change the configuration of a running server, see [Reload](reload.md).

## Environment Variables

Runtime options are read from environment variables. None of them is required. Slack tokens come only from each persona's credentials file (see [Credentials files](#credentials-files)). There is no `.env` file — export any of these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_STATE_DIR` | Override the directory where `config.json` and runtime state are stored. Defaults to `~/.claude/channels/slack`. When it is set, the crontable's default moves there too (see `cron_table_path` under [Server-wide settings](#server-wide-settings)). |
| `XDG_CONFIG_HOME` | The standard XDG configuration directory. With `SLACK_STATE_DIR` unset and `XDG_CONFIG_HOME` an absolute path, the crontable defaults to `$XDG_CONFIG_HOME/cscb/crontab` instead of `~/.config/cscb/crontab`. An empty or relative value is ignored. |
| `SLACK_DRY_RUN` | Set to `1` (or `true` / `yes`) to start the server without Slack. No credentials file is read and no Slack call is made. Each persona runs with a placeholder identity (`U000DRY_<key>`), and MCP tool calls (`reply`, `react`, etc.) and server notices are logged instead of sent. Useful for integration testing. |
| `CSCB_LOG_MAX_BYTES` | Rotate `server.log` / `clean_restart.log` when the active file reaches this many bytes. Defaults to `10485760` (10 MiB). Values `<= 0` or non-numeric are ignored. |
| `CSCB_LOG_KEEP` | Number of rotated generations to retain (`server.log.1` … `server.log.N`). Defaults to `5`. Set to `0` to keep none (the log is truncated instead of rolled). Values `< 0` or non-numeric are ignored. |
| `CSCB_AD_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the agent-director library's per-poll `SubprocessClient: <verb> ok` success dumps in `server.log`. Off by default — these routine dumps are dropped so the log stays readable. Failures and warnings from agent-director always pass through regardless of this flag. Read once at server startup, so it takes effect on server restart. |
| `CSCB_HTTP_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the per-request MCP access line (`HTTP <method> <path> session=…`) in `server.log`. Off by default — the `/mcp` endpoint is hit on every client poll and SSE open, so these routine lines are dropped to keep the log readable. Session connect/disconnect, sessions with no matching persona, and errors are logged unconditionally regardless of this flag. Checked per request, so it takes effect without a restart. |

Shell profile example:

```sh
# Optional overrides:
export SLACK_STATE_DIR=~/.config/slack-channel-bots
# Dry-run mode (no Slack credentials needed):
export SLACK_DRY_RUN=1
```

---

## Personas (config.json)

`config.json` is read from `~/.claude/channels/slack/config.json` by default. Override the directory with `SLACK_STATE_DIR`. The server needs only this file and the credentials files it names.

Each bot is a **persona**: one Slack app, one Claude instance with its own working directory, and the channels it serves. In declarative mode, the default, those are the channels it is configured into, and its tools may target only them; in fungible mode, they are the public and private channels its app is invited to that are not externally shared, and its tools may target any channel ID: the call goes to Slack, which decides (see [Tools](bots.md#tools) and [Channel modes](#channel-modes)). Create one Slack app per persona (see `slack-app-manifest.yml`); that app gives the persona its own name and avatar in Slack.

The top level holds a required `personas` array and the [server-wide settings](#server-wide-settings). Unknown keys are rejected at every level: the top level, each persona, its `dm` object, its `invited` object in fungible mode, and each channel entry in declarative mode (see [Load-time rules](#load-time-rules)). Only this persona format is accepted; a configuration written for an earlier major version must be rewritten by hand (see [Upgrading to personas](migration.md#upgrading-to-personas)).

The first start of an install applies the file as it stands. After that, the server runs a recorded copy, and an edit changes nothing until you confirm it; a server restart alone doesn't apply it. See [Reload](reload.md#reload), and [What a confirmation applies](reload.md#what-a-confirmation-applies) for how each kind of change is applied.

Postinstall creates a skeleton with an empty persona list. An empty list is valid: the server starts with no persona connected.

```json
{
  "personas": []
}
```

### Example

A complete `config.json` in declarative mode (`allow_invited_channels` absent), with three personas:

- `planner` receives every message in its home channel `C0123456789` and in the shared channel `C0555555555`. Its permission prompts and notices go to its home channel. It takes no DMs.
- `reviewer` receives only its @mentions and `@here` / `@channel` broadcasts in the shared channel. It takes DMs, and its prompts and notices go by DM to its contact `U0123456789`. It has its own Claude config directory and turns the [Slack Reply Guard](bots.md#slack-reply-guard-stop-hook) off for itself.
- `helpdesk` is DM-only: it is in no channel and is reached only by DM. Its prompts and notices go by DM to its contact `U0987654321`.

`planner` and `helpdesk` inherit the top-level `claude_config_dir`. The server-wide settings turn on an acknowledgement reaction and set how replies are split.

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/cscb/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [
        { "id": "C0123456789", "delivery": "all" },
        { "id": "C0555555555", "delivery": "all" }
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
      "dm": { "enabled": true, "contact": "U0123456789" },
      "permission_prompts": "dm",
      "claude_config_dir": "~/.claude-reviewer",
      "stop_hook_bootstrap": false
    },
    {
      "name": "helpdesk",
      "credentials_file": "~/.config/cscb/helpdesk-credentials.json",
      "working_directory": "~/projects/helpdesk",
      "dm": { "enabled": true, "contact": "U0987654321" },
      "permission_prompts": "dm"
    }
  ],
  "port": 3100,
  "session_restart_delay": 60,
  "claude_config_dir": "~/.claude-bots",
  "ack_reaction": "eyes",
  "reply_chunk_limit": 3000,
  "reply_chunk_mode": "newline"
}
```

Replace the channel IDs, user IDs and paths with your own. Each persona's credentials file must exist with its tokens before that persona can come up (see [Credentials files](#credentials-files)).

### Example in fungible mode

A complete `config.json` in fungible mode (`allow_invited_channels: true`), with two personas. Neither lists `channels` or a top-level `permission_prompts`: in fungible mode they are not read.

- `triage` serves every public or private channel its Slack app is in that is not externally shared. Its permission prompts and notices go to the channel `C0123456789`, set by `invited.permission_prompts`; the channel needs no listing. It takes no DMs.
- `concierge` serves every public or private channel its Slack app is in that is not externally shared, and takes DMs. It sets no `invited.permission_prompts`, so its destination is `"dm"` by default: its prompts and notices go by DM to its contact `U0123456789`.

Invite each persona's Slack app to the channels it should serve, and `triage`'s app to its destination channel. Replace the channel ID, user ID and paths with your own.

```json
{
  "personas": [
    {
      "name": "triage",
      "credentials_file": "~/.config/cscb/triage-credentials.json",
      "working_directory": "~/projects/triage",
      "invited": { "permission_prompts": "C0123456789" }
    },
    {
      "name": "concierge",
      "credentials_file": "~/.config/cscb/concierge-credentials.json",
      "working_directory": "~/projects/concierge",
      "dm": { "enabled": true, "contact": "U0123456789" }
    }
  ],
  "allow_invited_channels": true
}
```

### Persona fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Any non-empty string; no format rule. See [Persona name and key](#persona-name-and-key). |
| `credentials_file` | path | yes | — | Path to the persona's [credentials file](#credentials-files). |
| `working_directory` | path | yes | — | Working directory of the persona's Claude instance. It must exist before the persona can come up. |
| `channels` | array | in declarative mode, yes unless `dm.enabled` is `true` | none | Declarative mode only: the channels the persona is in, a list of [channel entries](#channel-entries). See [Channel delivery](#channel-delivery). Not read in fungible mode. |
| `dm.enabled` | boolean | no | `false` | The persona's DMs switch. See [Direct messages](#direct-messages-dmenabled). |
| `dm.contact` | string | when the persona's destination is `"dm"`, in either mode, including fungible mode's default `"dm"` | — | A Slack user ID such as `U0123456789`: the person a `"dm"` destination addresses. In Slack, open the person's profile, then **⋮** → **Copy member ID**. |
| `permission_prompts` | string | in declarative mode, yes | — | Declarative mode only: the persona's **destination**, where its permission prompts and server notices are posted. One of the persona's own channel IDs, or `"dm"`. See [Permission prompts](#permission-prompts). Not read in fungible mode. |
| `invited.permission_prompts` | string | no | `"dm"` | Fungible mode only: the persona's **destination**, where its permission prompts and server notices are posted. `"dm"` or a Slack channel ID such as `C0123456789`; the channel needs no listing. Not read in declarative mode. See [Permission prompts in fungible mode](#permission-prompts-in-fungible-mode). |
| `claude_config_dir` | path | no | top-level `claude_config_dir` | Claude config directory for this persona. See [Next-launch settings](#next-launch-settings). |
| `stop_hook_bootstrap` | boolean | no | top-level `stop_hook_bootstrap` | Slack Reply Guard switch for this persona. See [Next-launch settings](#next-launch-settings). |

`dm` is an object holding `enabled` and `contact`: `"dm": { "enabled": true, "contact": "U0123456789" }`. It applies in both modes. `invited` is an object holding `permission_prompts`: `"invited": { "permission_prompts": "C0123456789" }`. A path is absolute, `~` or starts with `~/`. Paths are never redacted: a log line, preview or error that names a path shows it in full, with `~` expanded.

### Channel entries

Channel entries apply in declarative mode; in fungible mode a persona serves the channels its app is invited to (see [What each mode serves](#what-each-mode-serves)). Each entry of `channels` is an object with two required fields:

| Field | Description |
|---|---|
| `id` | A Slack channel ID: `C` or `G` followed by capital letters and digits, such as `C0123456789`. Not a channel name. In Slack, click the channel name; the ID is at the bottom of the **About** tab. |
| `delivery` | `"all"` or `"mentions"`. See [Channel delivery](#channel-delivery). |

### Persona name and key

The `name` identifies the persona in `config.json`, logs and targets. It isn't its Slack display name, which comes from the persona's Slack app. Any non-empty name is accepted.

Logs, previews and Slack notices show the name JSON-quoted, with its key beside it, as `"planner" (key=planner)`. Inside a quoted error message (`message="…"`), token-like text is redacted, so a token-like name is redacted there too.

A name of 1–40 characters, all lower-case letters, digits and `_`, is its own key. Any other name gets a derived key:

1. The name is lower-cased.
2. Each run of characters other than `a-z`, `0-9` and `_` becomes one `_`.
3. Leading and trailing `_` are trimmed, and the result is cut to 40 characters.
4. `_` and an 8-character hash of the name are appended. A name with nothing left after step 3 gets the hash alone.

`"Help Desk"`, for example, has the key `help_desk_95a3a6f5`. Each persona's `persona-start` line in `server.log` shows its key.

The key is used for:

- the persona's agent-director instance, `cscb_<key>`;
- its tmux session, `slack_bot_<key>`;
- the `CSCB_PERSONA` environment variable of its Claude instance;
- targets: [`/interject`](bots.md#interject) and the [crontable](scheduled-prompts.md#scheduled-prompts-cscb_cron) accept the persona's name or its key.

**No persona's key may start with another persona's key.** The server rejects such a pair when it checks the configuration (see [Load-time rules](#load-time-rules)), with an error that names both personas and suggests a new name. tmux matches a session target by prefix unless it is written with `=`, so a human's tmux command without `=` for one persona (for example `tmux attach -t slack_bot_dev`) could reach another persona's session. With personas `dev` and `dev_2`, that command could reach `slack_bot_dev_2`.

Give the shorter name a suffix, such as `dev_main` beside `dev_2`, or `horde_main` beside `horde_admin`, or rename either so that neither key starts with the other. Keys that only share a start, such as `dev_a` and `dev_b`, are fine. A name that isn't its own key counts by its key: `"Dev Bot"` (key `dev_bot_…`) can't sit beside `dev` either.

Renaming a persona changes its key, so the old persona is removed and a new one added (see [What a confirmation applies](reload.md#what-a-confirmation-applies)).

### Credentials files

Each persona's Slack tokens live in its own credentials file, and `config.json` names that file only by path. The file is a JSON object with exactly two keys:

```json
{
  "bot_token": "<bot token, starts with xoxb->",
  "app_token": "<app-level token, starts with xapp->"
}
```

`bot_token` is the app's bot token (`xoxb-…`), shown under OAuth & Permissions once you install the app to the workspace. `app_token` is an app-level token (`xapp-…`) with the `connections:write` scope, generated under Basic Information → App-Level Tokens.

- Tokens come only from these files, never from `config.json`.
- Two personas can't share a credentials file.
- The server never writes or copies the file and doesn't check its mode. Keep it private: `chmod 600`.
- The file's content is checked when the persona comes up, not when `config.json` is checked. A missing or malformed file keeps only that persona down (see [Troubleshooting](troubleshooting.md#troubleshooting)).
- On a running server, a change to the file waits for confirmation like a `config.json` edit (see [Reload](reload.md#reload)).

The setup wizard, `setup-slack-channel-bots`, has you write this file with its [credentials command](../skills/setup-slack-channel-bots/SKILL.md#credentials-command), which you run in your own terminal once the persona is declared in `config.json`:

```sh
claude-slack-channel-bots credentials <persona>
```

`<persona>` is the persona's name or key. The command finds the persona in `config.json`, reads both tokens without echoing them, validates the bot token with Slack `auth.test` and the app token with `apps.connections.open`, and writes the persona's `credentials_file` with mode 0600 only when both pass. It asks before replacing an existing file. See [`claude-slack-channel-bots credentials`](cli.md#claude-slack-channel-bots-credentials).

To rotate a persona's tokens, run the credentials command for it again (see the wizard's [Rotate a persona's tokens](../skills/setup-slack-channel-bots/SKILL.md#rotate-a-personas-tokens)), then confirm the pending change (see [Confirming a change](reload.md#confirming-a-change)). Only that persona reconnects, and no restart is needed.

Never put a token in `config.json`, a ticket or a chat.

The shipped `slack-app-manifest.yml` also grants the `lists:read` and `lists:write` bot scopes, so a bot can read and write, with its own bot token, a Slack List it has been given access to, such as one list shared by all bots. CSCB itself makes no Lists call. An app created from an earlier manifest must have both scopes added and be re-installed; until then, every Lists call fails with `missing_scope`.

### Channel delivery

This section applies in declarative mode; for fungible mode, see [Channel delivery in fungible mode](#channel-delivery-in-fungible-mode). Each channel entry's `delivery` sets which messages in that channel reach the persona:

- **`all`**: every message in the channel.
- **`mentions`**: only messages that @mention the persona directly, and `@here` / `@channel` broadcasts.

Any number of personas may list the same channel, each with its own `delivery`. One persona can't list a channel twice. Invite the persona's Slack app to each of its channels. [How a persona receives messages](bots.md#how-a-persona-receives-messages) says how each message arrives and which `via` it carries.

### Direct messages (`dm.enabled`)

`dm.enabled` is each persona's DMs switch. It is off (`false`) by default.

- **On:** anyone in the workspace can DM the persona's own Slack app, and that persona alone receives the DM and answers in it. The persona can also start a DM with a workspace user by passing the user's ID to `reply`, and posts there as itself.
- **Off:** DMs to the persona's app are not delivered. The server logs one `persona-dm-dropped` line naming the persona and `dm.enabled`. The persona never opens, reads or posts in a DM.
- **Group DMs** (DMs with more than one person) are never delivered to any persona, whatever `dm.enabled` says.

In declarative mode, a persona with no `channels` must have `dm.enabled` set to `true`.

`dm.contact` is the person who receives the persona's prompts and notices when its destination is `"dm"`: in declarative mode when `permission_prompts` is `"dm"`, and in fungible mode when `invited.permission_prompts` is `"dm"` or unset. In either mode a `"dm"` destination needs `dm.enabled: true` and a `dm.contact`. `dm.contact` gates nothing else: it doesn't limit who can DM the persona.

Starting a DM with a user (a `reply` to a user ID, or a persona whose destination is `"dm"`) needs the `im:write` bot scope, which the shipped `slack-app-manifest.yml` grants. A `"dm"` destination always opens its DM through Slack before it first posts there, even when the DM already exists. For an app created from an earlier manifest, a `"dm"` persona's prompts and notices are not posted, and a `reply` to a user ID fails with `missing_scope`, until the scope is added and the app is re-installed.

Receiving DMs and replying in an existing DM (a `D…` ID) work without the scope. The `debug-slack-channel-bots` skill (see [Troubleshooting](troubleshooting.md#troubleshooting)) has the steps under "A persona can't open a DM".

### Permission prompts

This section applies in declarative mode, where `permission_prompts` is required; for fungible mode, see [Permission prompts in fungible mode](#permission-prompts-in-fungible-mode). It is the persona's destination: its permission prompts and its server notices, such as lost-message notices and restart-limit warnings, are posted there as the persona.

- **A channel ID:** one of the persona's own `channels`. Everyone in that channel sees the prompts and notices.
- **`"dm"`:** a DM from the persona's app to its `dm.contact`. It needs `dm.enabled: true` and a `dm.contact`.

Give each persona a destination that no other persona receives every message in, such as its own channel or `"dm"`. Don't give a persona `delivery: all` in another persona's destination channel. A notice is a Slack post like any other: when two personas each receive every message in the other's destination channel and neither persona's instance can take messages, each loses the other's lost-message notices and posts a notice about it, so they keep posting notices about each other until either instance takes messages again (see [Troubleshooting](troubleshooting.md#troubleshooting)).

[Permission Relay](bots.md#permission-relay) covers how prompts are delivered and answered, and [Troubleshooting](troubleshooting.md#troubleshooting) what happens when Slack refuses a post to the destination.

### Next-launch settings

`claude_config_dir` and `stop_hook_bootstrap` can be set on a persona or at the top level. A persona's own value wins; the top-level value is the default for every persona without one. Once a change is confirmed, it takes effect at the persona's next launch (see [When next-launch and server-wide changes take effect](reload.md#when-next-launch-and-server-wide-changes-take-effect)).

**`claude_config_dir`** is the Claude config directory the persona's instance launches with (`CLAUDE_CONFIG_DIR`), so each persona can authenticate as a different Claude account. Populate each directory before the persona first launches:

```sh
CLAUDE_CONFIG_DIR=~/.claude-reviewer claude auth login --claudeai
```

Use `--console` instead of `--claudeai` for a Console account. When neither the persona nor the top level sets one, Claude's own default applies.

- A directory that doesn't exist yet is fine when its parent exists.
- A persona whose `claude_config_dir` can't be resolved to a real path (for example, a symlink on its path that points to nothing) is held: it closes or never opens its Slack connection and receives nothing, and `server.log` shows `persona-config-dir-unresolvable`. It reconnects once the directory resolves, with no restart.
- A confirmed change to a persona's effective `claude_config_dir` makes it start a new conversation on the same instance at its next launch. Nothing is deleted: the old conversation stays in the old directory, kept as an earlier life of that instance.
- The Slack Reply Guard never installs its hook in `~/.claude`, so a persona whose directory resolves there gets no reminder (see [Personal-dir refusal](bots.md#personal-dir-refusal)).

**`stop_hook_bootstrap`** turns the [Slack Reply Guard](bots.md#slack-reply-guard-stop-hook) reminder on (`true`, the default) or off for the persona. It applies to that persona alone, even when it shares its `claude_config_dir` with other personas. A running bot keeps the value it was launched with until it is relaunched. See [Personas that answer without `reply`](bots.md#personas-that-answer-without-reply--opt-them-out) for when to turn it off.

### Server-wide settings

These top-level fields apply to the whole server. A confirmed change to one takes effect at the next server start, with four exceptions. `allow_invited_channels` is the one setting a confirmation applies in place, at once. A change to `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. `stop_timeout` and `exit_timeout` are used only by the CLI, which takes them from the record at once. `agent_director_call_timeout_ms` is used by both: the CLI takes it from the record at once, and the running server uses it from its next start. See [What a confirmation applies](reload.md#what-a-confirmation-applies).

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. The in-process cron scheduler delivers via `127.0.0.1`, and [`clear-latch`](cli.md#claude-slack-channel-bots-clear-latch) reaches the server there, so `bind` must include loopback (the default, or `0.0.0.0`) for scheduled fires and `clear-latch` to work. |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | number | `60` | Seconds to wait before auto-restarting a session that crashed or disappeared. A session that ended cleanly (an `agent-director pause`, a `/exit`) is relaunched about 3 s after it disconnects instead, unless the persona's last launch failed or it had such a fast relaunch within the last `session_restart_delay` seconds (see "Session not restarting after crash" in [Troubleshooting](troubleshooting.md#troubleshooting)). Set to `0` to disable auto-restart, clean exits included, and the health check's reconnects (not the retries of a persona agent-director refused; see [Troubleshooting](troubleshooting.md#troubleshooting)); a persona whose session runs but can't receive messages then gets a *Not connected* or *Not receiving messages* notice at its destination (see [Troubleshooting](troubleshooting.md#troubleshooting)). At any value, a persona reported as `working` that the server can't prove idle for 10 minutes gets a *Not connected* notice. Must be non-negative. |
| `health_check_interval` | number | `120` | Seconds between periodic liveness polls. Set to `0` to disable; the retries of a persona agent-director refused still run. Must be non-negative. |
| `exit_timeout` | number | `120` | Seconds to wait for a managed Claude Code session to exit gracefully during `clean_restart` or `stop --stop-bots` before force-killing it through agent-director. |
| `stop_timeout` | number | `30` | Seconds to wait for the server process to exit after `SIGTERM` before escalating to `SIGKILL`. |
| `mcp_config_path` | string | `~/.claude/slack-mcp.json` | Path to the MCP config file passed to Claude Code when launching managed sessions. |
| `append_system_prompt_file` | string | — | Path to a file appended to every managed session's system prompt via `--append-system-prompt-file`. Missing file silently skipped. See `skills/EXAMPLE_CLAUDE.md` for a template. |
| `system_prompt_mode` | string | `"append"` | Controls how `append_system_prompt_file` is applied. `"append"`: the custom prompt file is appended on top of `CLAUDE.md` (default, current behavior). `"none"`: only `CLAUDE.md` is used; `append_system_prompt_file` is ignored even if set. Use `"none"` when the project's `CLAUDE.md` already contains everything the bot needs. |
| `fresh_system_prompt` | boolean | `true` | When `true` (default), every bot launches with `--system-prompt-snapshot off`, so a restarted or resumed bot loads the current system prompt file and `CLAUDE.md` and keeps its conversation, whatever `system_prompt_mode` is. When `false`, the flag is omitted. A change takes effect at the next server start. Needs a Claude Code that has `--system-prompt-snapshot` (confirmed on 2.1.280); on an older one set it to `false`. A bot keeps the launch arguments it was started with on every resume, so a change reaches a bot only when it next starts a new conversation; a `clean_restart` that resumes conversations does not apply it to those bots. |
| `cozempic_prescription` | string | `"standard"` | Cozempic cleaning intensity before resume. Valid values: `gentle`, `standard`, `aggressive`. Has no effect if cozempic is not installed. |
| `message_archive_db` | string | — | Path to a SQLite DB where every inbound Slack message is archived in real time. Parent directories are created if missing; schema is initialized on first open. Compatible with the `archive-messages.py` backfill script — both can write concurrently. Each channel's name is looked up through the receiving persona's Slack app, which needs the `channels:read` and `groups:read` bot scopes that the shipped `slack-app-manifest.yml` grants. An app created from an earlier manifest stores the channel ID instead, until both scopes are added and the app is re-installed; the `debug-slack-channel-bots` skill has the steps under "The message archive shows channel IDs". A DM's rows keep the DM's `D…` ID whatever the scopes, as a DM has no name; a group DM's rows keep its ID too. Feature is disabled when absent. |
| `claude_config_dir` | string | — | Default Claude on-disk config directory for every persona. When a persona has one (its own or this default), its session launches with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the bot authenticates against a specific account. `~` is expanded and the path is resolved to absolute. A persona's own `claude_config_dir` overrides this value. When neither is set, Claude's own default applies. Must be non-empty when set. |
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh; after 2 resumes in a row that end before the session starts (a transcript Claude Code can't load), it starts fresh instead (see "Session not restarting after crash" under [Troubleshooting](troubleshooting.md#troubleshooting)). When `false`, a bot is never resumed: on startup and on runtime auto-restart it starts a new conversation on the same instance, even when a stored session exists, and its old conversation is kept as an earlier life of that instance. Set `false` as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on resume (a known regression in v2.1.120). |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. Replaces the pre-rename `claude_director_poll_interval_ms` — the old name is rejected at startup. |
| `agent_director_call_timeout_ms` | number | `60000` | How long (ms) CSCB waits on each agent-director call it makes for its personas, in the server and in `stop --stop-bots` and `clean_restart`. Must be an integer in `[1000, 3_600_000]`; out-of-range values are rejected at load. It should be greater than the need that agent-director's timing settings give; see [Sizing the agent-director call timeout](agent-director.md#sizing-the-agent-director-call-timeout). |
| `stop_hook_bootstrap` | boolean | `true` | Default for every persona: whether the persona gets the Slack Reply Guard reminder (see [Slack Reply Guard (Stop hook)](bots.md#slack-reply-guard-stop-hook)). The value applies per persona, from the persona's first launch after the change is applied (see [Reload](reload.md#reload)). A persona's own `stop_hook_bootstrap` overrides this value. Non-boolean values are rejected at startup. |
| `cron_table_path` | string | `~/.config/cscb/crontab` | Path to the crontable for the built-in cron scheduler (`cscb_cron`). When absent, it is `~/.config/cscb/crontab` (`$XDG_CONFIG_HOME/cscb/crontab` when `XDG_CONFIG_HOME` is an absolute path), outside `~/.claude`, so a bot's edit is not a write under `~/.claude`, which Claude Code asks the user to approve. With `SLACK_STATE_DIR` set, the default is `crontab` in the directory of the loaded `config.json` instead. A path you set is used as written, with `~` expanded like other path keys, even when it names `~/.config/cscb/crontab`: the server never creates its directory or moves a crontable to it. The resolved path is exported into every managed session as `CSCB_CRONTABLE_PATH` so bots can find the crontable and self-schedule (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)). Must be a non-empty string when set. |
| `cron_log_path` | string | `<config dir>/cron.log` | Path to the `cscb_cron` log file. Defaults to `cron.log` in the directory of the loaded `config.json`, wherever the crontable is. `~` is expanded like other path keys. Must be a non-empty string when set. |
| `cron_log_max_bytes` | number | — | Size cap in bytes for the cron log. Once a line takes the log past the cap, the server drops its oldest whole lines until it fits. The newest line is always kept, even when it alone is larger than the cap. Nothing is rotated or archived, so dropped lines are gone. Absent means no cap: the log only grows. Must be a positive integer when set. |
| `ack_reaction` | string | — | Emoji name, without colons (for example `"eyes"`), of the acknowledgement reaction. When set, each persona a message is dispatched to adds the reaction under its own Slack identity once the message has reached its instance, not on receipt, so a message that reaches several personas carries one reaction per persona. A message that isn't dispatched gets no reaction: one lost because the persona's instance is down, or one the persona doesn't receive. Messages sent through `/interject` or cron aren't Slack messages and get none either. A persona's first `reply` in that conversation carrying the message's `message_id` removes that persona's reaction only; other personas' reactions stay until they reply. Absent means no acknowledgement. Must be non-empty when set. |
| `reply_chunk_limit` | number | `4000` | Maximum characters per posted message: the `reply` tool splits longer text into several messages. Must be a positive integer. |
| `reply_chunk_mode` | `"length"` \| `"newline"` | `"newline"` | How the `reply` tool splits text longer than `reply_chunk_limit`. `length`: hard split at the limit. `newline`: split at newline boundaries within the limit; a single line longer than the limit is posted whole. |
| `allow_invited_channels` | boolean | `false` | Picks the channel mode for every persona. Absent or `false` is **declarative mode**: each persona's `channels` and top-level `permission_prompts` are in force, and its `invited` section is not read. `true` is **fungible mode**: each persona's `channels` and top-level `permission_prompts` are not read, and its `invited` section is in force. A confirmed change applies in place at once and keeps every session. Non-boolean values are rejected at load. See [Channel modes](#channel-modes), and read [Who can reach a persona in fungible mode](bots.md#who-can-reach-a-persona-in-fungible-mode) before turning it on. |

### Load-time rules

Before it applies `config.json`, the server checks the whole file and reports the first rule it breaks. It checks the server-wide settings first, `allow_invited_channels` among them, before any persona, in either mode: a non-boolean `allow_invited_channels` is rejected naming the setting. The mode that switch picks then sets which rules each persona entry is checked by.

In both modes:

- A persona's name or key equals another persona's name or key.
- A persona's key starts with another persona's key, such as `dev` and `dev_2` (see [Persona name and key](#persona-name-and-key)).
- Two personas share a `working_directory` or a `credentials_file`, compared by real path.
- A `dm.contact` is malformed. User IDs start with `U` or `W`, followed by capital letters and digits only; underscores are not allowed.
- A path isn't absolute, `~` or `~/…`.
- A required field is missing, or a key of the top level, a persona entry or `dm` is unknown.
- A value has the wrong type, isn't an allowed value, or is out of range.

In declarative mode (`allow_invited_channels` absent or `false`):

- `permission_prompts` names a channel that isn't in the persona's `channels`.
- `permission_prompts` is `"dm"` without `dm.enabled: true` or without a `dm.contact`.
- A persona has no channels and `dm.enabled` isn't `true`.
- A persona lists the same channel twice.
- A channel ID is malformed, or a channel entry has an unknown key. Channel IDs start with `C` or `G`, followed by capital letters and digits only; underscores are not allowed.

`invited` is neither checked nor read in declarative mode, so a malformed `invited` loads.

In fungible mode (`allow_invited_channels` is `true`):

- `invited` isn't an object, or holds a key other than `permission_prompts`.
- `invited.permission_prompts` is neither `"dm"` nor a well-formed channel ID.
- The persona's destination is `"dm"`, written or by default, without `dm.enabled: true` or without a `dm.contact`. The error names `invited.permission_prompts`, says whether `"dm"` is its default, and names each missing setting.

`channels` and the top-level `permission_prompts` are neither checked nor read in fungible mode, whatever they hold, and `permission_prompts` isn't required. A channel destination needs no listing and no DMs, and a persona with DMs off and a channel destination is valid.

A pending change is judged by the rules of the mode its own switch picks, not by the mode in effect. A change that turns fungible mode on is `INVALID` when a persona's `invited` section breaks the fungible-mode rules; a change that turns it off is `INVALID` when a persona's `channels` or `permission_prompts` breaks the declarative-mode rules.

For a persona error, the error names the persona (`personas[<i>]`) and the field. A value that a format, type, range or allowed-value rule rejects is never shown; a type error names only the JSON type it got. Credentials content and whether directories exist are not checked here; they are checked when each persona comes up. At a start with no last-applied record, an error stops the start. On a running server, an error shows as an `INVALID` pending change (see [Reload](reload.md#reload)). The `debug-slack-channel-bots` skill (`skills/debug-slack-channel-bots/SKILL.md`) lists every rejection with its cause and fix under "Configuration rejections".

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

## Channel modes

The top-level setting `allow_invited_channels` picks the channel mode for every persona at once. The mode decides which channels a persona serves, how each channel's delivery is set, and where the persona's permission prompts and notices go.

### What each mode serves

| | Declarative mode | Fungible mode |
|---|---|---|
| The switch | `allow_invited_channels` absent or `false`, the default | `allow_invited_channels: true` |
| Channels a persona serves | The channels listed in its `channels` | Every public or private channel its Slack app is a member of that Slack marks as not externally shared |
| Who sets a channel's delivery | The operator, with each channel entry's `delivery` | The persona's agent, with `set_channel_delivery`; `mentions` otherwise (see [Channel delivery in fungible mode](#channel-delivery-in-fungible-mode)) |
| Destination of prompts and notices | `permission_prompts` | `invited.permission_prompts`, `"dm"` when it is absent (see [Permission prompts in fungible mode](#permission-prompts-in-fungible-mode)) |
| Persona settings read | `channels` and the top-level `permission_prompts` | `invited` |

- **Each mode reads only its own section.** Neither reads nor overrides the other: in declarative mode `invited` is not read, and in fungible mode `channels` and the top-level `permission_prompts` are not read, whatever they hold. A persona may carry both sections, so switching back and forth needs no rewrite.
- **Direct messages follow `dm.enabled` in both modes.** Group DMs are never served.
- **Externally shared (Slack Connect) channels** are served only in declarative mode, with the channel listed.
- **Upgrades stay declarative.** A configuration without `allow_invited_channels` runs in declarative mode. Upgrading needs no migration, and nothing rewrites `config.json`: fungible mode begins only when you set the switch to `true`.
- **No Slack change.** Neither mode needs a Slack scope, a manifest change or an app re-install beyond the shipped `slack-app-manifest.yml`.

### Turning fungible mode on or off

Before you turn fungible mode on, read [Who can reach a persona in fungible mode](bots.md#who-can-reach-a-persona-in-fungible-mode): an invite then changes who can reach a persona's worker.

The switch changes through a confirmed edit, like every other setting:

1. Edit `config.json`. To turn fungible mode on, add `"allow_invited_channels": true` and give each persona the `invited` section it needs (see [Load-time rules](#load-time-rules)). To turn it off, remove the setting or set it to `false`.
2. Read the pending preview. The switch has its own line, naming the mode it turns on and every persona it affects (see [Reading the preview](reload.md#reading-the-preview)).
3. Confirm the change (see [Confirming a change](reload.md#confirming-a-change)). It applies in place, at once, from the next event, tool call, prompt and notice, with no restart, and every session is kept (see [What a confirmation applies](reload.md#what-a-confirmation-applies)).

**Turning it on.** From each channel's next message, fungible mode serves every public or private channel each persona's app is already in that is not externally shared. Each channel is served at `mentions` unless a stored choice applies. Listed `delivery` values are not carried over: a channel listed with `delivery: all` is served at `mentions` unless the persona's agent stores `all` for it.

Before you turn it on, review each persona's app's channel memberships in Slack, private channels included: each one becomes a channel the persona serves. Past `unclaimed-channel` lines in `server.log` show channels whose messages reached a persona's app with no persona serving them:

```sh
grep unclaimed-channel ~/.claude/channels/slack/server.log*
```

**Turning it off.** The change is checked by the declarative rules, so each persona needs a valid declarative section: a persona whose `channels` or `permission_prompts` breaks a declarative-mode rule makes the change `INVALID` (see [Load-time rules](#load-time-rules)). From the next event, each persona serves its listed channels again, each at its `delivery`. Turning it off changes no stored choice on disk: the choices stop applying, and they apply again when fungible mode is turned back on.

### Channel delivery in fungible mode

In fungible mode, a persona's channel delivery for a channel sets which messages there reach it, as `delivery` does in declarative mode: `mentions` (only messages that @mention the persona directly, and `@here` / `@channel` broadcasts) or `all` (every message).

- **`mentions` is the default.** A channel is at `all` only when the persona's agent stored `all` for it with `set_channel_delivery` (see [Tools](bots.md#tools)). The agent calls the tool when someone in that channel asks it to listen to everything there, or to answer only when mentioned. Whether any persona lists the channel in `channels` plays no part.
- **The loop guard.** A channel that is another persona's fungible destination (its `invited.permission_prompts` channel) is held at `mentions` for every other persona, whatever they stored, so no other persona receives every message where that persona's prompts and notices are posted. A persona's own destination channel is not held for it, and a `"dm"` destination holds nothing.
- **Stored choices persist.** Each choice is kept in `channel-delivery.json` beside `config.json` (see [Files beside the config file](reload.md#files-beside-the-config-file)), across server restarts and persona relaunches, and applies from the next message after the call. A persona that is removed, renamed, or whose `credentials_file` or `working_directory` changes loses its stored choices and comes up at `mentions` everywhere.
- **`receive_all_shared` is an approximation.** A persona at `all` in a channel receives a message there as `receive_all_shared` when at least one other persona's channel delivery for that channel, computed by the same rule, is `all`. A stored choice says nothing about whether the other persona's app remains in the channel, so a persona whose app has left the channel counts too.
- **Don't keep two personas at `all` in one channel.** Each receives every message there, the other's posts included, so each answer one persona posts reaches the other, which can answer it in turn: the two can keep answering each other with no human involved. If one should listen to everything, keep the other at `mentions`.

### Permission prompts in fungible mode

In fungible mode, a persona's destination is its `invited.permission_prompts`, `"dm"` when it is absent. Its permission prompts and its server notices, such as lost-message notices and restart-limit warnings, are posted there as the persona. See the `invited.permission_prompts` row in [Persona fields](#persona-fields).

- **A channel ID:** any channel; it needs no listing and no DMs. Invite the persona's app to it, or Slack refuses the posts (see "A permission prompt or notice doesn't arrive" in [Troubleshooting](troubleshooting.md#troubleshooting)). Everyone in that channel sees the prompts and notices.
- **`"dm"`, written or by default:** a DM from the persona's app to its `dm.contact`. It needs `dm.enabled: true` and a `dm.contact`.

Because of the loop guard, no other persona receives every message in a fungible destination channel. After a confirmed switch change, the next prompt and the next notice, held notices included, go to the destination of the mode turned on; prompts already posted stay where they are and stay answerable.
