# What a bot can do

The tools each persona's Claude instance gets, how messages reach it, how to inject a message, how permission prompts reach Slack, and the Slack Reply Guard. Scheduled prompts have their own page, [Scheduled Prompts](scheduled-prompts.md).

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to a channel (in declarative mode one of the persona's configured channels; in fungible mode any channel ID) or, when the persona's `dm.enabled` is `true`, to a DM conversation ID (`D…`) or a Slack user ID (`U…`/`W…`). A user ID opens a DM with that user and posts there as the persona; the result names the DM conversation ID to use for later calls. Splits long text into several messages by the server-wide `reply_chunk_limit` and `reply_chunk_mode` settings. With `message_id` (the message being answered), removes this persona's acknowledgement reaction from that message. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `edit_message` | Edit a previously sent message (bot's own messages only) in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `fetch_messages` | Fetch message history from a channel (a configured channel in declarative mode; any channel ID in fungible mode), a DM conversation (`D…`, with `dm.enabled` `true`) or a thread in either. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). Saves files to `STATE_DIR/inbox/`. Returns local file paths. Only files hosted by Slack are downloaded; external files are refused. |
| `set_channel_delivery` | Set the persona's [channel delivery](configuration.md#channel-delivery-in-fungible-mode) for one channel. Two inputs: `channel`, a channel ID, and `delivery`, `mentions` or `all`. The persona's agent calls it when someone in that channel asks. It works only in fungible mode: every call is refused in declarative mode, and while `channel-delivery.json` is unreadable. It accepts only a channel the persona has heard a message from in fungible mode since it came up, or one it holds a stored choice for. It makes no Slack call. The choice persists in `channel-delivery.json` and applies from the next message in that channel; the result names the persona's channel delivery there, and says so when the loop guard holds the channel at `mentions`. Each accepted call logs one `persona-channel-delivery-set` line. It changes no configuration and applies no reload. |

Only `reply` takes a user ID; the other tools need a channel or DM conversation ID. When `dm.enabled` ([Persona fields](configuration.md#persona-fields)) is `false`, the persona has no DM target in either mode: no tool can post in, read or open a DM.

- **In declarative mode,** a tool call with any other target, a channel the persona isn't configured into included, is refused with a tool error naming the persona and the target, and nothing is sent to Slack.
- **In fungible mode,** a target that is neither a channel ID nor an allowed DM target is refused before any Slack call, with a tool error naming the persona and the target. Any other channel target goes to Slack, which decides: Slack's refusal, for example `not_in_channel` for a channel the persona's app is not in, reaches the persona as a tool error naming the persona, the channel and Slack's error code.

Known limits of the fungible-mode targets:

- CSCB makes no Slack call to learn whether a channel holds the persona's app, is externally shared or is a group DM. So in fungible mode it refuses no post, read, reaction or edit in an externally shared channel that the app belongs to, although fungible mode never delivers a message from such a channel.
- The same holds in a group DM the app belongs to, except that Slack refuses reads there: the app has no `mpim:history` scope.
- In fungible mode, `edit_message` on the persona's own earlier post in a channel its Slack app is not in, for example after the app was removed from the channel, is sent to Slack, and Slack accepts it.

On a host whose Claude Code permission settings don't allow the server's tools as a group (an allow rule such as `mcp__slack-channel-router`, rather than one rule per tool such as `mcp__slack-channel-router__reply`), the first `set_channel_delivery` call raises a permission prompt, in either mode (see [Permission Relay](#permission-relay)).

---

## Interject

POST to `/interject` to inject a message into a persona's running Claude instance from localhost. The message reaches only the named persona's instance, never any other persona. Only requests from `127.0.0.1` or `::1` are accepted — external callers are rejected with 403. The bot sees it as described in [How a persona receives messages](#how-a-persona-receives-messages); the Slack Reply Guard does not remind it to reply.

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

For recurring prompts, prefer the built-in scheduler (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)) — it needs no host cron and delivers straight to a persona. The host-crontab example below is an alternative when you already run `cron`:

```sh
# crontab -e
0 9 * * 1 curl -s -X POST http://localhost:3100/interject \
  -H "Content-Type: application/json" \
  -d '{"persona": "planner", "message": "Weekly reminder: update the changelog before standup.", "sender": "cron"}'
```

---

## Permission Relay

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. Architecture is polling-based on the `agent-director` library — there are **no hook scripts to install** and no HTTP long-poll loops.

Flow:

1. agent-director moves the spawn into `check_permission` state when Claude requests a tool permission.
2. CSCB's poller (`src/permission-poller.ts`) runs `client.list({ state: ['check_permission'], label: ['service=cscb'] })` at the `agent_director_poll_interval_ms` cadence (default 1000 ms).
3. For each new spawn, `client.get(...)` returns the open permission request (tool name, tool input and an opaque `request_token`). CSCB identifies the persona that owns the spawn from its `persona` label and posts the Block Kit prompt to the persona's destination as that persona: its destination channel (its `permission_prompts` in declarative mode, its `invited.permission_prompts` in fungible mode), or, for a `"dm"` destination, a DM from the persona's app to its `dm.contact`. The server opens that DM if none exists yet, so a DM-only persona's first prompt is delivered too. Each persona follows its own setting.
4. The operator clicks Allow / Deny in Slack, in the channel or the DM; the buttons work the same in both. CSCB resolves the click through the same persona: it calls `client.decide({ claude_instance_id, decision, request_token })` and, as that persona, updates the message to "*Permission* — Allowed" or "*Permission* — Denied by operator".
5. If a tracked prompt closes for any reason other than a Slack click, the next poller tick replaces the buttons with the verdict: "⏱ *Permission* — Timed out", "🪦 *Permission* — Session ended", "*Permission* — Allowed", "*Permission* — Denied by operator", or "*Permission* — Denied (closed)" when the reason is unknown.

The prompt names the tool and shows its input: Bash's command, Edit's or Write's file path, or for any other tool the input as JSON, up to 500 characters. An input too long for Slack's 3000-character limit on a message section is cut to fit and followed by `… (truncated, <shown> of <total> chars shown)`; the rest is not shown in Slack.

While a persona is not up (broken or retrying), its instance keeps running but its permission prompts are not posted and its already-posted prompts are left as they are. They appear, or get their verdict, on the first poll after the persona comes up.

If Slack refuses a post to the persona's destination, see "A permission prompt or notice doesn't arrive" under [Troubleshooting](troubleshooting.md#troubleshooting).

### Slack app prerequisites

Each persona's Slack app must have **interactivity enabled** with **Socket Mode** as the delivery method. In each app's config, open **Interactivity & Shortcuts** → toggle **Interactivity** on. No Request URL is needed; Socket Mode delivers interaction payloads over the existing socket. This is included automatically for an app created from `slack-app-manifest.yml`.

### AskUserQuestion

The `AskUserQuestion` tool is denied for every CSCB-spawned bot via the agent-director template (`deny: ['AskUserQuestion']`). Bots respond to operator questions via the Slack `reply` MCP tool instead. There is no `ask-relay.sh` hook and no `/ask` HTTP endpoint.

### Memory-directory reads

The template also pre-allows each bot to read its own persistent-memory directory, so those reads don't surface a permission prompt to a human. One `Read(//<config-dir>/projects/*/memory/**)` rule is derived per distinct Claude config directory across your personas (a persona's own `claude_config_dir`, the top-level `claude_config_dir`, or the `~/.claude` default). The rules follow the applied personas: when a confirmed change alters the set of config directories, the server rewrites them. If that rewrite fails, `server.log` shows a `template refresh: … failed` line. Until the directories change again or the server restarts, a persona using a new directory then asks for permission each time it reads its memory notes. The rule is scoped to `projects/*/memory/**` only — never the config-dir root, which holds live credentials — so it never pre-authorizes credential reads.

---

## How a persona receives messages

Every message reaches a persona's Claude instance as its text wrapped in a `<channel source="slack-channel-router" …>` tag. A message from Slack carries a `via` attribute that says how it reached the persona. An injected message (a scheduled prompt or an `/interject` message) carries no `via`. Which channels a persona serves, and at which delivery, depends on the channel mode (see [Channel modes](configuration.md#channel-modes)).

A message from Slack carries these tag attributes:

| Attribute | Value |
|---|---|
| `chat_id` | The channel ID, or the DM conversation ID (`D…`) for a direct message. |
| `message_id`, `ts` | The message's Slack timestamp, for example `1789936743.069939`. |
| `user` | The author's Slack display name, falling back to real name, then Slack username, then user ID. For a post by a bot or integration without a user: the post's username, else its bot profile name, else its bot ID. |
| `user_id` | The author's Slack user ID. |
| `bot_id` | The author's bot ID, in place of `user_id`, for a post without a user. |
| `via` | How the message reached the persona (see the next table). |
| `thread_ts` | The thread's timestamp, for a thread reply. |
| `attachment_count`, `attachments` | The number of attached files and each file's name, type and size, when files are attached. |

Each way a message reaches a persona:

| Kind | How it reaches the persona | Tag attributes | `via` | Reminder |
|---|---|---|---|---|
| Direct message | A DM to the persona's own Slack app, when its `dm.enabled` is `true`, whatever the text mentions. With `dm.enabled` `false` the server drops it and logs one `persona-dm-dropped` line. A group DM is never delivered. | Slack attributes; `chat_id` is the DM conversation ID | `dm` | Yes, direct-message wording |
| Direct @mention | A message that @mentions the persona. In declarative mode: in a channel listed in its `channels`, with `delivery: mentions` or `delivery: all`. In fungible mode: in a public or private channel its app is in that is not externally shared, at either channel delivery. | Slack attributes | `mention` | Yes, direct-mention wording |
| `@here` / `@channel` broadcast | A message that uses `@here` or `@channel`. In declarative mode: in a channel listed in the persona's `channels`, with either `delivery`. In fungible mode: in a public or private channel its app is in that is not externally shared, at either channel delivery. `@everyone` and user-group mentions are not broadcasts. | Slack attributes | `broadcast` | Yes, broadcast wording |
| Every message, shared channel | A message that neither @mentions the persona nor broadcasts. In declarative mode: in a channel listed in its `channels` with `delivery: all`, when at least one other persona in the applied configuration also has `delivery: all` for that channel, whether or not that persona is up. In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is `all` (a stored choice, after the loop guard; see [Channel delivery in fungible mode](configuration.md#channel-delivery-in-fungible-mode)), when at least one other persona in the applied configuration has a channel delivery of `all` for that channel by the same rule, whether or not that persona's app remains in the channel. | Slack attributes | `receive_all_shared` | Yes, shared-channel wording |
| Every message, this persona alone | A message that neither @mentions the persona nor broadcasts. In declarative mode: in a channel listed in its `channels` with `delivery: all`, when no other persona in the applied configuration has `delivery: all` for that channel. In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is `all`, when no other persona in the applied configuration has a channel delivery of `all` for that channel. | Slack attributes | `receive_all` | Yes, only-you wording |
| Scheduled prompt | A crontable line naming the persona fires, and the scheduler posts it to `/interject` for that persona only (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)). | Only `user` = `cscb-cron:<prompt file name without its extension>` (`cscb-cron:standup` for `standup.md`) and `ts` = the server clock in seconds. No `chat_id`, `message_id` or `via`. | none | Never |
| `/interject` message | A localhost POST to `/interject` addressed by `persona` (see [Interject](#interject)); it reaches only that persona. | Only `user` = the request's `sender` (default `interject`) and `ts`, as for a scheduled prompt. No `chat_id`, `message_id` or `via`. | none | Never |

A "Yes" in the Reminder column means the [Slack Reply Guard](#slack-reply-guard-stop-hook) reminds the persona once if it ends its turn without replying, wherever the reminder is on for that persona. Each `via` has its own reminder wording, stating how the message arrived; that section lists them.

- **The first applicable `via` wins,** in the order `dm`, `mention`, `broadcast`, `receive_all_shared`, `receive_all`. A message that @mentions the persona in a channel it receives in full arrives as `mention`.
- **The persona's own @mention is removed from the text.** Mentions of other personas and `@here` / `@channel` stay.
- **Every author counts.** Posts by people, bots, integrations and other personas all arrive by these rules. Each persona posts as its own Slack app, so another persona's post reaches it like anyone else's.
- **Anyone in the workspace can reach a persona,** in both modes: in declarative mode in its listed channels, by each channel's `delivery`; in fungible mode in every channel its app is invited to that it serves, by its channel delivery there; and in both modes by DM when its `dm.enabled` is `true`. There is no approval step. In fungible mode an invite changes who that is (see [Who can reach a persona in fungible mode](#who-can-reach-a-persona-in-fungible-mode)).
- **A persona never receives its own posts.**
- **Each message arrives at most once per persona,** even though Slack sends a channel @mention twice. A Slack redelivery more than 10 minutes after the first, or after a server restart, arrives again.
- **In fungible mode, an @mention is delivered from its `message` event.** Of the two events Slack sends for a channel @mention, the `app_mention` event decides nothing and the `message` event carrying the same mention decides, so each @mention is delivered once, whichever event arrives first. An edit that adds a mention to an earlier message sends no new `message` event, so in fungible mode it is not delivered.
- **A message without `via` is an injected prompt.** Its `user` label is free-form, so an `/interject` sender label, even one starting with `cscb-cron:`, cannot make it look like a Slack message.
- **When the reminder is off.** A persona gets no reminder when its effective `stop_hook_bootstrap` was `false` at its last launch, when it has no `claude_config_dir` (its own or the top-level one), when that directory resolves to `~/.claude`, or when `jq` is not installed. See [Slack Reply Guard](#slack-reply-guard-stop-hook).

### Who can reach a persona in fungible mode

Read this before turning fungible mode on. Each persona's Claude worker runs with tool access on the host, and in fungible mode the workspace's members, not the operator, choose the channels it serves.

- **An invite changes a persona's audience.** Any workspace member can point a persona's worker at any channel they are in by inviting the persona's app there. This includes private channels, which the operator may not be able to see.
- **Anyone who can reach the persona can switch a channel to `all`.** In any channel it serves, or by DM, anyone can ask the persona to switch any channel it serves to `all`, including a channel they are not in. From then on, every message in that channel reaches the worker.
- **`fetch_messages` reads every channel the app is in.** The persona's `fetch_messages` can read the history of every channel its app is a member of, so content can be carried from one channel to another.
- **Slack Connect channels are never served.** An externally shared channel is never served in fungible mode; serve it in declarative mode, with the channel listed.
- **Enterprise Grid: Slack's flag decides.** A channel shared between workspaces of one Enterprise Grid organization is served when Slack marks it as not externally shared, and then members of every workspace sharing it can reach the persona.

The audit lines in `server.log` are `persona-invited-channel`, logged the first time a persona hears a channel in fungible mode (naming the channel, `public` or `private`, and its channel delivery), and `persona-channel-delivery-set`, logged for each stored `set_channel_delivery` choice. The debugging skill explains both ([`persona-invited-channel`](../skills/debug-slack-channel-bots/SKILL.md#persona-invited-channel), [`persona-channel-delivery-set`](../skills/debug-slack-channel-bots/SKILL.md#persona-channel-delivery-set)). To list them:

```sh
grep -E 'persona-(invited-channel|channel-delivery-set)' ~/.claude/channels/slack/server.log*
```

A persona logs a channel's `persona-invited-channel` line only once until the server restarts or the persona is brought up fresh, so on a long-running server, log rotation can discard a channel's only audit line (see [Server log rotation](troubleshooting.md#server-log-rotation)). After a restart, the first event from each channel a persona hears in fungible mode logs its line again.

---

## Slack Reply Guard (Stop hook)

CSCB ships a Claude Code Stop hook that gives a persona a **one-time, declinable reminder** to answer in Slack. It is on for every persona whose effective `stop_hook_bootstrap` is `true` (the default), except a persona with no `claude_config_dir`, one whose directory resolves to `~/.claude`, or any persona when `jq` is missing (see [When the guard stays silent](#when-the-guard-stays-silent)). When the messages that started the turn include a message from Slack and the persona ends its turn without calling the `mcp__slack-channel-router__reply` tool, the hook exits `2` and Claude Code shows the persona a reminder. The message's `via` picks the wording:

| `via` | Reminder |
|---|---|
| `dm` | `This turn started from a Slack direct message (conversation <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `mention` | `This turn started from a Slack message that @mentioned you directly (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `broadcast` | `This turn started from an @here or @channel broadcast in a Slack channel (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `receive_all_shared` | `This turn started from a message in a Slack channel where you and other personas receive every message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `receive_all` | `This turn started from a message in a Slack channel where only you receive every message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| any other value, empty included | `This turn started from a Slack channel message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |

`<chat_id>` is the message's `chat_id`. When `chat_id` is absent or is not a Slack ID (capital letters and digits only), the reminder omits the parenthesis, for example:

```text
This turn started from a Slack direct message and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.
```

When several Slack messages started the turn, the last one picks the wording. A `reply` call after the earliest of them counts as a reply. The persona then continues once: it can reply, or end the turn without replying. That continuation carries `stop_hook_active=true`, which the guard always lets through, so the reminder appears at most once per turn and never loops.

**Only messages from Slack trigger it.** The guard recognises a message from Slack by its `via` attribute; any `via` value counts. Injected prompts (scheduled prompts and `/interject` messages) carry no `via`, so they never trigger the reminder: no Slack conversation is waiting on them. An injected message that arrives right after a Slack message does not cancel the reminder for the Slack message. [How a persona receives messages](#how-a-persona-receives-messages) lists every kind of message and its `via`.

### Turning it on or off

Set `stop_hook_bootstrap` in `config.json`: at the top level for every persona, or on a persona to override the top-level value for that persona alone. It defaults to `true`. Setting `stop_hook_bootstrap: false` on the persona, or inheriting `false` from the top level, is all an opt-out needs, even when the persona shares its `claude_config_dir` with other personas. See [Next-launch settings](configuration.md#next-launch-settings) and [Server-wide settings](configuration.md#server-wide-settings).

A change reaches a persona at its first launch after the change is applied (see [Reload](reload.md#reload)); see [Timing](#timing-when-the-hook-is-patched-and-the-record-written).

### Personas that answer without `reply` — opt them out

The guard only recognises a reply made with `mcp__slack-channel-router__reply`. A persona whose only Slack surface is `edit_message` or `react` ends its turn without that call, so the guard reminds it after every Slack message, costing one useless continuation each time. Set `stop_hook_bootstrap: false` on that persona.

### What the server writes, and where

**The hook.** The server patches `<claude_config_dir>/settings.json` in each applied persona's effective `claude_config_dir` (the persona's own value, else the top-level value). Where the hook is installed, the file holds **exactly one** managed Stop-hook group of this shape:

```jsonc
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "'<absolute path>/stop-hooks/slack-reply-guard.sh' '<state dir>/reply-guard'" } ] }
    ]
  }
}
```

The command is the absolute path of the script inside CSCB's installed package, then the record directory, each in single quotes. There is no `matcher` field, because Stop is not a tool-scoped event. Your other Stop hooks, and every other key in `settings.json`, are preserved. Writes are atomic (`.tmp` + `rename`). A missing `settings.json` is created with just this group. A malformed `settings.json` is left untouched and an error is recorded.

**Recognition rule.** The server treats *any* Stop-hook `command` containing `slack-reply-guard.sh` as CSCB-managed. Only the exact current command is kept: duplicates collapse to one group, and an entry with an older script path, no record directory or another record directory is replaced. This is how the hook heals itself across upgrades.

**The record.** Each persona has a record file, `reply-guard/<persona key>` in the state directory (`~/.claude/channels/slack/`, or `SLACK_STATE_DIR` when set). It holds `true` or `false`: the persona's effective `stop_hook_bootstrap`. The server writes it atomically immediately before it spawns or resumes the persona's instance. Reconnecting to an instance that is still running leaves the record as it was.

**What the guard reads.** Every persona's instance runs with its key in `CSCB_PERSONA`. The guard reads the record `<record directory>/<CSCB_PERSONA>` and reminds only when it reads exactly `true`. A missing argument, an unset `CSCB_PERSONA`, or a missing record means no reminder.

### Personas sharing a config directory

Personas that share one `claude_config_dir` each follow their own `stop_hook_bootstrap`, through their own record. The managed hook stays installed in a directory while any persona counting toward it has an effective `stop_hook_bootstrap` of `true` or a record reading `true`. A persona counts toward its effective directory and toward the directory its running instance launched with. When no such persona is left, the server removes the hook from that directory.

### Timing: when the hook is patched and the record written

- **Server start.** The server patches the hook for every applied persona before any launch.
- **Each launch.** Immediately before each spawn or resume (including a restart), the server writes the persona's record and patches the hook in the persona's new effective directory and, if it differs, the directory it last launched with.

A running instance keeps the value it launched with, because the guard reads that instance's own record, written only at its launch. The hook itself may appear in or vanish from a shared directory while an instance runs, for example when a neighbour launches; Claude Code normally picks up such edits without a restart, but the instance's own record still decides. On a plain server restart, live instances are reconnected rather than relaunched, so a changed value reaches them at their next launch.

The directory an instance launched with is kept in memory only. After a confirmed `claude_config_dir` change and a plain server restart, the server no longer counts a still-running instance toward its old directory. If every persona it still counts toward that directory has the reminder off, the next hook pass there (the restart's own, or a launch of such a persona) removes the managed hook, and the still-running instance gets no reminder until its next launch. A `clean_restart` relaunches it with its new directory.

### Personal-dir refusal

The server never installs the hook in your own `~/.claude` (it never edits `~/.claude/settings.json`). A persona whose effective `claude_config_dir` resolves to `~/.claude` (symlinks followed) gets no reminder. At server start the refusal is recorded once as the startup error `stop-hook-bootstrap-refuse-home` (see [Startup errors](troubleshooting.md#startup-errors)). At a later launch it is a server-log line only.

### Personas without a `claude_config_dir`

A persona with no effective `claude_config_dir` (neither its own nor the top-level one; an empty or whitespace-only value counts as none) gets no reminder. The server logs this as a server-log line only; no startup error is recorded. To give a persona the reminder, give it a real `claude_config_dir`.

### When the guard stays silent

The guard is **fail-open by design**: when anything is missing or goes wrong, it exits `0` and the turn ends normally. Besides the cases above, it stays silent when:

- `jq` is not installed. The server records `stop-hook-bootstrap-jq-missing` at start and installs the hook anyway, so installing `jq` later is enough.
- The record could not be written before a launch. The server removes any stale record, logs one line and launches anyway.
- The transcript is missing or unreadable, or the message's opening `<channel>` tag is not in the shape the guard expects (see below).

### Tag drift — fail-open, verify after upgrades

The guard reads the `<channel …>` tag at the very start of each message that started the turn. It treats the tag as Slack's when its `source` starts with `slack`, and reads its `via` and `chat_id`. A tag quoted later in a message's text is ignored.

CSCB sends only the message content and its attributes over MCP. The **Claude Code harness itself** renders the `<channel source="…">` tag when it writes the message into the transcript; `source` is the MCP server name (`slack-channel-router`). The tag is therefore an **external, harness-owned contract**. A future Claude Code release can rename or restructure it, and the guard would silently stop reminding.

The guard also relies on the harness escaping attribute values. `via` comes after the free-form `user` attribute, so if the harness stopped escaping `>` in attribute values, a display name containing `>` would cut the tag short before `via`, and the reminder would be silently skipped.

After every CSCB or Claude Code upgrade, verify the guard end to end:

1. Send a persona that has the reminder on a Slack message that needs a reply.
2. Confirm the reply lands in Slack.
3. Inspect the persona's most recently modified transcript. It lives in `<claude_config_dir>/projects/<folder named after the persona's working_directory>/`, where `<claude_config_dir>` is the persona's effective `claude_config_dir` (a persona the guard covers always has one, and never `~/.claude`). Claude Code names that folder (`<project_folder>` below) after the absolute `working_directory`, with every character other than a letter, a digit or `-` replaced by `-`: `/home/me/projects/alpha` becomes `-home-me-projects-alpha`. Other personas sharing the config dir have their own folders, so use this one, not `projects/*`. Replace both placeholders:

   ```sh
   f=$(ls -t <claude_config_dir>/projects/<project_folder>/*.jsonl | head -n 1)
   grep -o '<channel source=\\"slack[^>]*>' "$f" | tail -n 1
   grep -n '<channel source=\\"slack' "$f" | tail -n 1 | cut -d: -f1
   grep -n '"name":"mcp__slack-channel-router__reply"' "$f" | tail -n 1 | cut -d: -f1
   ```

   The transcript stores the tag's quotes escaped (`\"`), which is why the patterns contain `\\"`. The first `grep` prints the last Slack tag, which must carry both `via` and `chat_id`. The next two print the line numbers of the last Slack tag and of the last `mcp__slack-channel-router__reply` `tool_use`. The reply's line number must be greater than the tag's; no reply line, or a smaller number, means the reply was not recorded after the message.

If the tag, `via` or `chat_id` no longer appears, the guard is dark or misreading messages — file an issue.
