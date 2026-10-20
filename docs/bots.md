# What a bot can do

Tools, receiving messages, injecting a message, permission prompts and the Slack Reply Guard. See also [Scheduled Prompts](scheduled-prompts.md).

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to a channel (in declarative mode one of the persona's configured channels; in fungible mode any channel ID) or, when the persona's `dm.enabled` is `true`, to a DM conversation ID (`D…`) or a Slack user ID (`U…`/`W…`). A user ID opens a DM with that user and posts there as the persona; the result names the DM conversation ID to use for later calls. Splits long text into several messages by the server-wide `reply_chunk_limit` and `reply_chunk_mode` settings. With `message_id` (the message being answered), removes this persona's acknowledgement reaction from that message. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `edit_message` | Edit a previously sent message (bot's own messages only) in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `fetch_messages` | Fetch message history from a channel (a configured channel in declarative mode; any channel ID in fungible mode), a DM conversation (`D…`, with `dm.enabled` `true`) or a thread in either. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message in a channel (a configured channel in declarative mode; any channel ID in fungible mode) or, with `dm.enabled` `true`, a DM conversation (`D…`). Saves files to `STATE_DIR/inbox/`. Returns local file paths. Only files hosted by Slack are downloaded; external files are refused. |
| `set_channel_delivery` | Set the persona's [channel delivery](channel-modes.md#channel-delivery-in-fungible-mode) for one channel. Two inputs: `channel`, a channel ID, and `delivery`, `mentions` or `all`. The persona's agent calls it when someone in that channel asks. It works only in fungible mode: every call is refused in declarative mode, and while `channel-delivery.json` is unreadable. It accepts only a channel the persona has heard a message from in fungible mode since it came up, or one it holds a stored choice for. It makes no Slack call. The choice persists in `channel-delivery.json` and applies from the next message in that channel; the result names the persona's channel delivery there, and says so when the loop guard holds the channel at `mentions`. Each accepted call logs one `persona-channel-delivery-set` line. It changes no configuration and applies no reload. |

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

POST to `/interject` to store a message for a configured persona from localhost. The message is queued only for the named persona, including while it is down. Each request is an independent queued item, even with identical sender and text; requests are never merged or deduplicated. Only requests from `127.0.0.1` or `::1` are accepted — external callers are rejected with 403. The bot sees it as described in [How a persona receives messages](#how-a-persona-receives-messages); the Slack Reply Guard does not remind it to reply.

An injected message carries no Slack conversation; say in its text where to post any Slack reply.

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

After durable storage, returns HTTP 200. This acknowledges storage, not delivery:

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
| 500 | The message could not be stored (`Message not stored`). |

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

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. It runs through agent-director: there are **no hook scripts to install**.

1. When a bot's Claude Code asks for a tool permission, agent-director holds the request, and CSCB picks it up within `agent_director_poll_interval_ms` (default 1000 ms).
2. CSCB posts the prompt as the persona that owns the bot, to its destination: its destination channel (its `permission_prompts` in declarative mode, its `invited.permission_prompts` in fungible mode), or, for a `"dm"` destination, a DM from the persona's app to its `dm.contact`. The server opens that DM if none exists yet, so a DM-only persona's first prompt is delivered too. Each persona follows its own setting.
3. The operator clicks Allow / Deny in Slack, in the channel or the DM; the buttons work the same in both. CSCB passes the decision through agent-director. It shows Allowed or Denied only after delivery is confirmed. When delivery is not yet confirmed, the message stays pending while CSCB polls for delivery or closure.
4. A request that falls back to the tmux pane gets a notice without Slack buttons. Read the pane and follow the [permission recovery entry](../skills/debug-slack-channel-bots/SKILL.md#agent-director-permission-recovery); CSCB does not answer it automatically.
5. If a prompt closes for any reason other than a Slack click, the next check replaces the buttons with the verdict: "⏱ *Permission* — Timed out", "🪦 *Permission* — Session ended", "*Permission* — Allowed", "*Permission* — Denied by operator", or "*Permission* — Denied (closed)" when the reason is unknown.

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

CSCB stores accepted messages, then types their text into the bot’s terminal in a `<channel source="slack-channel-router" …>` tag. Every Slack message carries its sender’s ID; use the shared prompt file to say whose instructions to follow. The bot answers through `reply`. A message from Slack carries a `via` attribute that says how it reached the persona. An injected message (a scheduled prompt or an `/interject` message) carries no `via`. A received item is durably stored; delivered means its complete text is confirmed in the bot’s transcript. Delivery is at-least-once: an unconfirmed item is offered again, so the bot may see it more than once. Each persona uses strict FIFO across Slack, `/interject` and scheduled prompts, with one item in flight; the next waits until the previous item is confirmed delivered. There is no age cutoff. Delivery and reconnects wait until agent-director reports the bot is `waiting`. If agent-director refuses a key operation, the message stays queued and retries later. Transcript records confirm only the exact message received; they do not decide whether the bot is idle. Messages wait while MCP is disconnected, trigger the configured reconnect, and are delivered once connected again. Which channels a persona serves, and at which delivery, depends on the channel mode (see [Channel modes](channel-modes.md#channel-modes)).

A message from Slack carries these tag attributes:

| Attribute | Value |
|---|---|
| `chat_id` | The channel ID, or the DM conversation ID (`D…`) for a direct message. |
| `channel_name` | Channel name without `#`; `dm` for a DM; channel ID if the name cannot be resolved. |
| `part` | `k/n` for part k of n when a long message is split. |
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
| Every message, shared channel | A message that neither @mentions the persona nor broadcasts. In declarative mode: in a channel listed in its `channels` with `delivery: all`, when at least one other persona in the applied configuration also has `delivery: all` for that channel, whether or not that persona is up. In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is `all` (a stored choice, after the loop guard; see [Channel delivery in fungible mode](channel-modes.md#channel-delivery-in-fungible-mode)), when at least one other persona in the applied configuration has a channel delivery of `all` for that channel by the same rule, whether or not that persona's app remains in the channel. | Slack attributes | `receive_all_shared` | Yes, shared-channel wording |
| Every message, this persona alone | A message that neither @mentions the persona nor broadcasts. In declarative mode: in a channel listed in its `channels` with `delivery: all`, when no other persona in the applied configuration has `delivery: all` for that channel. In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is `all`, when no other persona in the applied configuration has a channel delivery of `all` for that channel. | Slack attributes | `receive_all` | Yes, only-you wording |
| Scheduled prompt | A crontable line naming the persona fires, and the scheduler queues it for that persona only (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)). | Only `user` = `cscb-cron:<prompt file name without its extension>` (`cscb-cron:standup` for `standup.md`) and `ts` = the fire time in seconds, with six decimals. No `chat_id`, `message_id` or `via`. | none | Never |
| `/interject` message | A localhost POST to `/interject` addressed by `persona` (see [Interject](#interject)); it reaches only that persona. | Only `user` = the request's `sender` (default `interject`) and `ts`, as for a scheduled prompt. No `chat_id`, `message_id` or `via`. | none | Never |

A "Yes" in the Reminder column means the [Slack Reply Guard](#slack-reply-guard-stop-hook) reminds the persona once if it ends its turn without replying, wherever the reminder is on for that persona. Each `via` has its own reminder wording, stating how the message arrived; that section lists them.

- **The first applicable `via` wins,** in the order `dm`, `mention`, `broadcast`, `receive_all_shared`, `receive_all`. A message that @mentions the persona in a channel it receives in full arrives as `mention`.
- **The persona's own @mention is removed from the text.** Mentions of other personas and `@here` / `@channel` stay.
- **Every author counts.** Posts by people, bots, integrations and other personas all arrive by these rules. Each persona posts as its own Slack app, so another persona's post reaches it like anyone else's.
- **Anyone in the workspace can reach a persona,** in both modes: in declarative mode in its listed channels, by each channel's `delivery`; in fungible mode in every channel its app is invited to that it serves, by its channel delivery there; and in both modes by DM when its `dm.enabled` is `true`. There is no approval step. In fungible mode an invite changes who that is (see [Who can reach a persona in fungible mode](channel-modes.md#who-can-reach-a-persona-in-fungible-mode)).
- **A persona never receives its own posts.**
- **Slack redeliveries add no second queue item, including across server restarts.** Each accepted Slack message keeps its key for at least 24 hours after intake; the paired channel @mention adds no second item.
- **In fungible mode, an @mention is delivered from its `message` event.** Of the two events Slack sends for a channel @mention, the `app_mention` event decides nothing and the `message` event carrying the same mention decides, so each @mention is delivered once, whichever event arrives first. An edit that adds a mention to an earlier message sends no new `message` event, so in fungible mode it is not delivered.
- **A message without `via` is an injected prompt.** Its `user` label is free-form, so an `/interject` sender label, even one starting with `cscb-cron:`, cannot make it look like a Slack message.
- **When the reminder is off.** A persona gets no reminder when its effective `stop_hook_bootstrap` was `false` at its last launch, when it has no `claude_config_dir` (its own or the top-level one), when that directory resolves to `~/.claude`, or when `jq` is not installed. See [Slack Reply Guard](#slack-reply-guard-stop-hook).

## Slack Reply Guard (Stop hook)

CSCB ships a Claude Code Stop hook that gives a persona a **one-time, declinable reminder** to answer in Slack. It is on for every persona whose effective `stop_hook_bootstrap` is `true` (the default), except a persona with no `claude_config_dir`, one whose directory resolves to `~/.claude`, or any persona when `jq` is missing (see [When it stays silent](#when-it-stays-silent)). When the messages that started the turn include a message from Slack and the persona ends its turn without calling the `mcp__slack-channel-router__reply` tool, the hook exits `2` and Claude Code shows the persona a reminder. The message's `via` picks the wording:

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

CSCB types the tag, including when a message arrives mid-turn or is pasted into the composer. The guard recognises these forms in the transcript.

**Only messages from Slack trigger it.** The guard recognises a message from Slack by its `via` attribute; any `via` value counts. Injected prompts (scheduled prompts and `/interject` messages) carry no `via`, so they never trigger the reminder: no Slack conversation is waiting on them. An injected message that arrives right after a Slack message does not cancel the reminder for the Slack message. [How a persona receives messages](#how-a-persona-receives-messages) lists every kind of message and its `via`.

### Turning it on or off

Set `stop_hook_bootstrap` in `config.json`: at the top level for every persona, or on a persona to override the top-level value for that persona alone. It defaults to `true`. Setting `stop_hook_bootstrap: false` on the persona, or inheriting `false` from the top level, is all an opt-out needs, even when the persona shares its `claude_config_dir` with other personas. See [Next-launch settings](configuration.md#next-launch-settings) and [Server-wide settings](server-settings.md#server-wide-settings).

A change reaches a persona at its first launch after the change is applied (see [Reload](reload.md#reload)): a running instance keeps the value it launched with, and a plain server restart reconnects to it without a launch.

### Personas that answer without `reply` — opt them out

The guard only recognises a reply made with `mcp__slack-channel-router__reply`. A persona whose only Slack surface is `edit_message` or `react` ends its turn without that call, so the guard reminds it after every Slack message, costing one useless continuation each time. Set `stop_hook_bootstrap: false` on that persona.

### When it stays silent

The guard is fail-open: when anything is missing or goes wrong, the turn ends normally with no reminder. Besides the opt-out, it stays silent for a persona with no `claude_config_dir`, one whose directory resolves to your own `~/.claude` (the server never edits `~/.claude/settings.json`), any persona while `jq` is not installed (installing it later is enough), and when the message's `<channel>` tag, which CSCB types, isn't in the shape the guard expects. After every CSCB or Claude Code upgrade, check the guard end to end with the steps in the debugging skill's ["Checking the guard after an upgrade"](../skills/debug-slack-channel-bots/SKILL.md#checking-the-guard-after-an-upgrade). How the server installs the hook and the per-persona record it reads are in ["How the guard is installed and what it reads"](../skills/debug-slack-channel-bots/SKILL.md#how-the-guard-is-installed-and-what-it-reads).
