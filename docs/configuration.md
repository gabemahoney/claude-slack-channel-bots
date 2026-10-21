# Configuration

The persona reference for `config.json`: every persona field, credentials files and the load-time rules. The server-wide settings, environment variables and `slack-mcp.json` are in [Server settings](server-settings.md); the two channel modes in [Channel modes](channel-modes.md). To change the configuration of a running server, see [Reload](reload.md).

## Personas (config.json)

`config.json` is read from `~/.config/claude-slack-channel-bots/config.json` by default (`$XDG_CONFIG_HOME/claude-slack-channel-bots/config.json` when `XDG_CONFIG_HOME` is an absolute path). Override the directory with `SLACK_STATE_DIR`. The server needs only this file and the credentials files it names.

Each bot is a **persona**: one Slack app, one Claude instance with its own working directory, and the channels it serves. In declarative mode, the default, those are the channels it is configured into, and its tools may target only them; in fungible mode, they are the public and private channels its app is invited to that are not externally shared, and its tools may target any channel ID: the call goes to Slack, which decides (see [Tools](bots.md#tools) and [Channel modes](channel-modes.md#channel-modes)). Create one Slack app per persona (see `slack-app-manifest.yml`); that app gives the persona its own name and avatar in Slack.

The top level holds a required `personas` array and the [server-wide settings](server-settings.md#server-wide-settings). Unknown keys are rejected at every level: the top level, each persona, its `dm` object, its `invited` object in fungible mode, and each channel entry in declarative mode (see [Load-time rules](#load-time-rules)). Only this persona format is accepted; a configuration written for an earlier major version must be rewritten by hand (see [Upgrading to personas](migration.md#upgrading-to-personas)).

The first start of an install applies the file as it stands. After that, the server runs a recorded copy, and an edit changes nothing until you confirm it; a server restart alone doesn't apply it. See [Reload](reload.md#reload), and [What a confirmation applies](reload.md#what-a-confirmation-applies) for how each kind of change is applied.

Postinstall creates a skeleton with an empty persona list, `{"personas": []}`. An empty list is valid: the server starts with no persona connected.

### Example

A complete `config.json` in declarative mode (`allow_invited_channels` absent), with three personas:

- `planner` receives every message in its home channel `C0123456789` and in the shared channel `C0555555555`. Its permission prompts and notices go to its home channel. It takes no DMs.
- `reviewer` receives only its @mentions and `@here` / `@channel` broadcasts in the shared channel. It takes DMs, and its prompts and notices go by DM to its contact `U0123456789`. It has its own Claude config directory and turns [Slack reply reminders](bots.md#slack-reply-reminders) off for itself.
- `helpdesk` is DM-only: it is in no channel and is reached only by DM. Its prompts and notices go by DM to its contact `U0987654321`.

`planner` and `helpdesk` inherit the top-level `claude_config_dir`. The server-wide settings select queued/delivered reactions and reply splitting. **Custom emoji must exist in the Slack workspace before configuration**; `spinthinking` is custom. Ensure both names below are available, or choose available names; see [Acknowledgement reactions](server-settings.md#acknowledgement-reactions).

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/claude-slack-channel-bots/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [{ "id": "C0123456789", "delivery": "all" }, { "id": "C0555555555", "delivery": "all" }],
      "permission_prompts": "C0123456789"
    },
    {
      "name": "reviewer",
      "credentials_file": "~/.config/claude-slack-channel-bots/reviewer-credentials.json",
      "working_directory": "~/projects/beta",
      "channels": [{ "id": "C0555555555", "delivery": "mentions" }],
      "dm": { "enabled": true, "contact": "U0123456789" },
      "permission_prompts": "dm",
      "claude_config_dir": "~/.claude-reviewer",
      "stop_hook_bootstrap": false
    },
    {
      "name": "helpdesk",
      "credentials_file": "~/.config/claude-slack-channel-bots/helpdesk-credentials.json",
      "working_directory": "~/projects/helpdesk",
      "dm": { "enabled": true, "contact": "U0987654321" },
      "permission_prompts": "dm"
    }
  ],
  "port": 3100,
  "session_restart_delay": 60,
  "claude_config_dir": "~/.claude-bots",
  "queued_ack_reaction": "beehive",
  "ack_reaction": "spinthinking",
  "reply_chunk_limit": 3000, "reply_chunk_mode": "newline"
}
```

Replace the channel IDs, user IDs and paths with your own. Each persona's credentials file must exist with its tokens before that persona can come up (see [Credentials files](#credentials-files)).

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
| `invited.permission_prompts` | string | no | `"dm"` | Fungible mode only: the persona's **destination**, where its permission prompts and server notices are posted. `"dm"` or a Slack channel ID such as `C0123456789`; the channel needs no listing. Not read in declarative mode. See [Permission prompts in fungible mode](channel-modes.md#permission-prompts-in-fungible-mode). |
| `claude_config_dir` | path | no | top-level `claude_config_dir` | Claude config directory for this persona. See [Next-launch settings](#next-launch-settings). |
| `stop_hook_bootstrap` | boolean | no | top-level `stop_hook_bootstrap` | Slack reply reminder switch for this persona. Confirmed changes apply immediately; see [Slack reply reminders](bots.md#slack-reply-reminders). |

`dm` is an object holding `enabled` and `contact`: `"dm": { "enabled": true, "contact": "U0123456789" }`. It applies in both modes. `invited` is an object holding `permission_prompts`: `"invited": { "permission_prompts": "C0123456789" }`. A path is absolute, `~` or starts with `~/`. Paths are never redacted: a log line, preview or error that names a path shows it in full, with `~` expanded.

### Channel entries

Channel entries apply in declarative mode; in fungible mode a persona serves the channels its app is invited to (see [What each mode serves](channel-modes.md#what-each-mode-serves)). Each entry of `channels` is an object with two required fields:

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

Write the file with `claude-slack-channel-bots credentials <persona>` in your own terminal, once the persona is declared in `config.json`: the [credentials command](../skills/setup-slack-channel-bots/SKILL.md#credentials-command) of the setup wizard, `setup-slack-channel-bots`. It checks both tokens with Slack and writes the file, mode 0600, only when both pass; see [`claude-slack-channel-bots credentials`](cli.md#claude-slack-channel-bots-credentials).

To rotate a persona's tokens, run the credentials command for it again (see the wizard's [Rotate a persona's tokens](../skills/setup-slack-channel-bots/SKILL.md#rotate-a-personas-tokens)), then confirm the pending change (see [Confirming a change](reload.md#confirming-a-change)). Only that persona reconnects, and no restart is needed.
Never put a token in `config.json`, a ticket or a chat.

The shipped `slack-app-manifest.yml` also grants the `lists:read` and `lists:write` bot scopes, so a bot can read and write, with its own bot token, a Slack List it has been given access to, such as one list shared by all bots. CSCB itself makes no Lists call. An app created from an earlier manifest must have both scopes added and be re-installed; until then, every Lists call fails with `missing_scope`.

### Channel delivery

This section applies in declarative mode; for fungible mode, see [Channel delivery in fungible mode](channel-modes.md#channel-delivery-in-fungible-mode). Each channel entry's `delivery` sets which messages in that channel reach the persona:

- **`all`**: every message in the channel.
- **`mentions`**: only messages that @mention the persona directly, and `@here` / `@channel` broadcasts.

Any number of personas may list the same channel, each with its own `delivery`. One persona can't list a channel twice. Invite the persona's Slack app to each of its channels. [How a persona receives messages](bots.md#how-a-persona-receives-messages) says how each message arrives and which `via` it carries.

### Direct messages (`dm.enabled`)

`dm.enabled` is each persona's DMs switch. It is off (`false`) by default.

- **On:** anyone in the workspace can DM the persona's own Slack app, and that persona alone receives the DM and answers in it. The persona can also start a DM with a workspace user by passing the user's ID to `reply`, and posts there as itself.
- **Off:** DMs to the persona's app are not delivered. The server logs one `persona-dm-dropped` line naming the persona and `dm.enabled`. The persona never opens, reads or posts in a DM.
- **Group DMs** (DMs with more than one person) are never delivered to any persona, whatever `dm.enabled` says.

`dm.contact` is the person who receives the persona's prompts and notices when its destination is `"dm"`: in declarative mode when `permission_prompts` is `"dm"`, and in fungible mode when `invited.permission_prompts` is `"dm"` or unset. In either mode a `"dm"` destination needs `dm.enabled: true` and a `dm.contact`. `dm.contact` gates nothing else: it doesn't limit who can DM the persona.

Starting a DM with a user (a `reply` to a user ID, or a persona whose destination is `"dm"`) needs the `im:write` bot scope, which the shipped `slack-app-manifest.yml` grants. A `"dm"` destination always opens its DM through Slack before it first posts there, even when the DM already exists. For an app created from an earlier manifest, a `"dm"` persona's prompts and notices are not posted, and a `reply` to a user ID fails with `missing_scope`, until the scope is added and the app is re-installed.

Receiving DMs and replying in an existing DM (a `D…` ID) work without the scope. The `debug-slack-channel-bots` skill (see [Troubleshooting](troubleshooting.md#troubleshooting)) has the steps under "A persona can't open a DM".

### Permission prompts

This section applies in declarative mode, where `permission_prompts` is required; for fungible mode, see [Permission prompts in fungible mode](channel-modes.md#permission-prompts-in-fungible-mode). It is the persona's destination: its permission prompts and its server notices, such as *Message not saved* notices and restart-limit warnings, are posted there as the persona.

- **A channel ID:** one of the persona's own `channels`. Everyone in that channel sees the prompts and notices.
- **`"dm"`:** a DM from the persona's app to its `dm.contact`. It needs `dm.enabled: true` and a `dm.contact`.

Choose a destination with [channel delivery](#channel-delivery) in mind. If two personas each receive every message in the other’s destination and storing fails, the notices stop after one *Message not saved* each per episode. Further failures are counted in `server.log` (see [Troubleshooting](troubleshooting.md#troubleshooting)).

[Permission Relay](bots.md#permission-relay) covers how prompts are delivered and answered, and [Troubleshooting](troubleshooting.md#troubleshooting) what happens when Slack refuses a post to the destination.

### Next-launch settings

`claude_config_dir` can be set on a persona or at the top level. A persona's own value wins; the top-level value is the default for every persona without one. Once a change is confirmed, it takes effect at the persona's next launch (see [When next-launch and server-wide changes take effect](reload.md#when-next-launch-and-server-wide-changes-take-effect)).

**`claude_config_dir`** is the Claude config directory the persona's instance launches with (`CLAUDE_CONFIG_DIR`), so each persona can authenticate as a different Claude account. Populate each directory before the persona first launches:

```sh
CLAUDE_CONFIG_DIR=~/.claude-reviewer claude auth login --claudeai
```
Use `--console` instead of `--claudeai` for a Console account. When neither the persona nor the top level sets one, Claude's own default applies.

- A directory that doesn't exist yet is fine when its parent exists.
- A persona whose `claude_config_dir` can't be resolved to a real path (for example, a symlink on its path that points to nothing) is held: it closes or never opens its Slack connection and receives nothing, and `server.log` shows `persona-config-dir-unresolvable`. It reconnects once the directory resolves, with no restart.
- A confirmed change to a persona's effective `claude_config_dir` makes it start a new conversation on the same instance at its next launch. Nothing is deleted: the old conversation stays in the old directory, with prior sessions retained in the same AD life.

### Slack reply reminders

**`stop_hook_bootstrap`** turns [Slack reply reminders](bots.md#slack-reply-reminders) on (`true`, the default) or off. This compatibility setting can be set on a persona or at the top level; a persona's own boolean overrides the default. A confirmed change applies immediately to that persona, including when it shares its `claude_config_dir` with others. See [Personas that answer without `reply`](bots.md#personas-that-answer-without-reply--opt-them-out) for when to turn it off.

### Load-time rules

Before it applies `config.json`, the server checks the whole file and reports the first rule it breaks. Besides each field's own type and allowed values (the tables above), no persona's name or key may equal another persona's name or key, no key may start with another persona's key (see [Persona name and key](#persona-name-and-key)), and no two personas may share a `working_directory` or `credentials_file`. Each mode checks only its own section: `channels` and `permission_prompts` in declarative mode, `invited` in fungible mode. The debug skill's [The load-time rules](../skills/debug-slack-channel-bots/SKILL.md#the-load-time-rules) lists every rule, and [Configuration rejections](../skills/debug-slack-channel-bots/SKILL.md#configuration-rejections) every error with its fix. At a start with no last-applied record an error stops the start; on a running server it shows as an `INVALID` pending change (see [Reload](reload.md#reload)).
