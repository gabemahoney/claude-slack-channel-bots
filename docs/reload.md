# Reload

Saving `config.json` doesn't change what runs. The server runs the last configuration it applied, and it shows an edit as a pending change until you confirm it (see [Confirming a change](#confirming-a-change)).

## Files beside the config file

These files sit in the same directory as `config.json` (`~/.config/claude-slack-channel-bots/` by default, or `SLACK_STATE_DIR`). Never edit them by hand.

| File | What it is |
|---|---|
| `config.json.last-applied` | The record: a byte copy of the last configuration the server applied. The server writes it. |
| `config.json.pending` | A preview of what applying the edit would do, written by the server. It exists only while a change is pending. |
| `config.json.apply` | Your confirmation: the pending file, renamed. The server deletes it at its next check (see [Confirming a change](#confirming-a-change)). |
| `retired-keys.json` | The retired-key record: the persona keys the server holds as retired. A confirmed change records the key of each removed persona (a renamed persona's old key included) and of each persona whose `name`, `credentials_file` or `working_directory` changed, before `config.json.last-applied` is rewritten. A server start also records, before its clean-up of old instances ends any of them, the key of every agent-director instance labelled with a persona that is not in the applied configuration (for example, a persona that `config.json` no longer names, at a start after `config.json.last-applied` was deleted; see [Start rules](#start-rules)), so a persona added back later with that key starts fresh. If that write fails, the start logs it in `server.log`, holds those keys as retired until the server stops, and records them again at the next start. Only the server writes it, never the CLI. It is kept across restarts and is absent until a key is first recorded. A key's entry is removed on its own once the persona's new session is running. If it can't be read, the server doesn't start; moving it aside is the fix (see `retired-keys-unreadable` under [Startup errors](troubleshooting.md#startup-errors)). |
| `channel-delivery.json` | The stored-choice file: each persona's stored channel-delivery choices (see [Channel delivery in fungible mode](channel-modes.md#channel-delivery-in-fungible-mode)), by persona key and channel, with each persona's `name`, `credentials_file` and `working_directory`. It holds no token and no message text. Only the server reads and writes it, never the CLI. It is absent until the first accepted `set_channel_delivery` call, so it is never created in declarative mode. Never edit it by hand. The server reads it once at each start. A persona's choices are dropped when a confirmed change retires its key (the persona is removed, or its `name`, `credentials_file` or `working_directory` changes), and at a start when its key is not an applied persona, its `name`, `credentials_file` or `working_directory` differs from the one stored, or `retired-keys.json` holds its key as retired and the persona's new session has not yet begun; each drop logs a `[slack] channel-delivery:` line. If the file can't be read, parsed or validated at a start, the server leaves it in place, logs one [`channel-delivery-unreadable`](../skills/debug-slack-channel-bots/SKILL.md#channel-delivery-unreadable) line, and starts and runs every persona, but for that run no stored choice applies: in fungible mode every channel is at `mentions`, `set_channel_delivery` is refused, and nothing is written to the file or dropped from it. To fix it, move the file aside, then restart the server; this discards every stored choice. If you restore that same file in place instead of moving it aside, a persona removed and added back with the same `name`, `credentials_file` and `working_directory` while it was unreadable gets its earlier choices again. |

| `queue/<key>.jsonl` | The persona’s durable queue, holding message text until delivery. Removing a persona retains its queue file; delivery resumes only when the same key returns. |

## Start rules

| At start | What happens |
|---|---|
| A record exists | The server runs the record, not `config.json`. This includes the start after a host reboot. |
| No record (a fresh install, or the first start after upgrading to this release) | The server checks `config.json`, records it and applies it. If the file is missing or invalid, the server doesn't start and `server.log` says why. |
| The record can't be read or is invalid | The server doesn't start. The log line names the record and says that deleting it makes the next start apply `config.json` as it stands. |
| The record can't be written | The server doesn't start and logs `reload-record-write-failed`. |

A configuration with zero personas is valid and starts.

CSCB ships no boot mechanism: starting the server after a host reboot is the operator's job.

Credentials files are read as they stand at every start. So a credentials change still pending when the server stopped takes effect at the next start.

`stop`, `stop --stop-bots` and `clean_restart` take their timeouts and persona set from the record when there is one, and from `config.json` otherwise.

Deleting the record discards it: the next start applies `config.json` as it stands, whatever it contains.

If the first start fails on a setting such as `port` or `bind`, see "A fix to config.json is ignored after a failed first start" in [Troubleshooting](troubleshooting.md#troubleshooting).

## Editing the configuration

While the server runs, it checks `config.json` and each credentials file the file names about every 5 seconds. It applies nothing it finds. When either differs from what is applied, the server writes `config.json.pending` and logs the same preview once in `server.log`. The change waits for your confirmation (see [Confirming a change](#confirming-a-change)). Nothing about a pending change is posted to Slack.

- Restarting the server or rebooting the host doesn't apply a pending `config.json` edit. The start brings back the recorded personas, and the edit stays pending.
- A pending credentials-file change is the exception: every start reads credentials files as they stand, so the next start applies it.
- Reverting the edit byte for byte deletes the pending file, and the server logs `reload-nothing-pending`. A revert that leaves only a whitespace difference stays pending, as `no effective change`.
- In dry run (`SLACK_DRY_RUN`), credentials files are not compared.

To see what is pending:

```sh
cat ~/.config/claude-slack-channel-bots/config.json.pending
grep -E 'reload-(preview|invalid|nothing-pending)' ~/.config/claude-slack-channel-bots/server.log | tail
```

## Reading the preview

The first line counts the personas added, removed, destructively modified, modified in place and with changed credentials, and the server-wide settings changed, the switch `allow_invited_channels` among them. A persona whose only changes are recorded ones (changes to the section not in force, see the table below) is not counted as modified. Then there is one line per affected persona, one per persona with a recorded change, and one per changed setting. For example:

```
claude-slack-channel-bots: pending configuration change (written by the server)
fingerprint: sha256:<64 hex digits>

A configuration change is pending; nothing has been applied. personas: 1 added, 1 removed, 0 destructively modified, 1 modified in place, 1 with changed credentials; server-wide settings: 2 changed.
DESTRUCTIVE: persona "scribe" (key=scribe) is removed: the persona will be retired: its session stopped and never resumed; 2 open queued items kept, delivered only if a persona with the same key is added again.
persona "helper" (key=helper) is added but cannot come up: working directory does not exist.
persona "planner" (key=planner): channels changed: applied in place immediately, instance kept.
persona "reviewer" (key=reviewer): credentials file "/home/operator/.config/claude-slack-channel-bots/reviewer-credentials.json" changed: a new connection opens, then the old one closes, instance kept.
server-wide setting port changed: once applied, it is recorded and takes effect at the next server start after that.
server-wide setting claude_config_dir changed: inherited by "planner" (key=planner), "reviewer" (key=reviewer); takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.
```

Made to the configuration in the declarative [Example](configuration.md#example), a change that turns fungible mode on, gives `planner` an `invited.permission_prompts` and edits `reviewer`'s `channels`, which fungible mode doesn't read, previews like this:

```
A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 1 modified in place, 0 with changed credentials; server-wide settings: 1 changed.
persona "planner" (key=planner): invited.permission_prompts changed: applied in place immediately, instance kept.
persona "reviewer" (key=reviewer): channels changed in the declarative section: recorded, with no effect until allow_invited_channels selects declarative mode.
server-wide setting allow_invited_channels changed: turns fungible mode on, applied in place at once, from the next event, tool call, prompt and notice, for "planner" (key=planner), "reviewer" (key=reviewer), "helpdesk" (key=helpdesk).
```

The preview describes the full effect of the change. What each kind of change does once confirmed is in [What a confirmation applies](#what-a-confirmation-applies).

Paths in the preview are absolute: a `~` in `config.json` is shown expanded. In `server.log`, each preview line (everything after the `fingerprint:` line and the blank line) is prefixed `[slack] reload-preview:`, and the first one ends with where the preview is written: ` (preview in "<path of config.json.pending>")`.

| Line | Meaning |
|---|---|
| `DESTRUCTIVE: …` | Applying it retires that persona: its session is stopped and never resumed. A removed persona is retired. A persona whose `name`, `credentials_file` or `working_directory` changed is retired and brought up fresh. |
| `… is added but cannot come up: …` | The new persona would fail to come up, for the reasons given: its credentials file, its working directory, and its `claude_config_dir` (`claude_config_dir cannot be resolved to a real path (<errno>)`, for example a symlink on its path that points to nothing). Every reason found is listed. A `claude_config_dir` that doesn't exist yet but whose parent does is fine. |
| `credentials file "<path>" changed: …` | The persona's credentials file changed at the same path. The line names the persona and the path, never a token, and says what applying it does: a persona that is up opens a new connection, then closes the old one; a persona still retrying retries with the new content; a persona down because of its credentials `will be brought up`. |
| `credentials file "<path>" changed, but it cannot be used (<cause>): …` | The new content is missing, unreadable or invalid, for example `credentials file does not exist`. A persona that is up keeps its current connection, and a persona still retrying keeps retrying with its current content; confirming logs `persona-credentials-change-failed` in `server.log`, and the change stays pending. A persona down because of its credentials stays down, and confirming logs its usual credentials line and leaves nothing pending. Every start reads the file as it stands, so after a restart the persona is down until the file is fixed and the change confirmed. |
| `claude_config_dir changed: …, which starts fresh (the conversation is not resumed)` | The persona's next launch uses the new config directory and starts a new conversation. The running instance is kept until then. |
| `…; but at that launch it cannot come up: claude_config_dir cannot be resolved to a real path (<errno>)` | A warning after a changed `claude_config_dir`: the new directory can't be resolved, for example a symlink on its path points to nothing. On a changed top-level `claude_config_dir`, the warning names the inheriting personas it stops; on a `DESTRUCTIVE:` line that also changes the directory, it reads `but it cannot come up`. Confirming still applies the change: at the persona's next launch (at once, for a destructive change) it is held, its Slack connection closed, and it comes up once the directory resolves (`persona-config-dir-unresolvable` in `server.log`). Fix the directory, or the setting, before confirming. A directory that doesn't exist yet but whose parent does is fine. |
| `… could not be checked.` | The server couldn't check whether an added persona can come up, whether a changed `claude_config_dir` can be resolved, or whether a persona is down because of its credentials. `server.log` has a `reload: cannot check …` line; report it as a bug. |
| `… changed in the declarative section: recorded, with no effect until allow_invited_channels selects declarative mode.` or `… changed in the fungible section: recorded, with no effect until allow_invited_channels selects fungible mode.` | A recorded change: the persona's section not in force changed (`channels` or `permission_prompts` in fungible mode, `invited` in declarative mode). The line names the persona and the changed fields. The change is recorded and has no effect until the switch selects that section. These lines come after every persona line and before the server-wide setting lines. A change made only of recorded changes previews as `no effective change`, followed by its recorded lines. |
| `server-wide setting allow_invited_channels changed: turns <mode> mode on, applied in place at once, from the next event, tool call, prompt and notice, for …` | The switch. The line names the mode it turns on (`fungible` or `declarative`) and every persona present in both configurations, or ends `; no persona is affected.` when there is none. Unlike other server-wide settings, it applies at once, with no restart, and every session is kept (see [Channel modes](channel-modes.md#channel-modes)). |
| `server-wide setting … inherited by …` | A changed top-level default. The line lists the personas that inherit it. If none does, it says `no persona inherits it, so no instance is affected`. |
| `server-wide setting … changed: once applied, it is recorded and takes effect at the next server start after that.` | A setting such as `port`, `bind`, `queued_ack_reaction` or `ack_reaction`. It doesn't take effect until the server starts after the change is applied. Outstanding work keeps its original queued emoji; see [Acknowledgement reactions](server-settings.md#acknowledgement-reactions). |
| `server-wide setting … changed: once applied, it is recorded, and the CLI takes it from the record from then on (the running server does not use it).` | `stop_timeout` or `exit_timeout`. Only the CLI uses them: once the change is applied, the next `stop` or `clean_restart` uses the new value, with no restart needed. |
| `server-wide setting … changed: once applied, it is recorded, the CLI takes it from the record from then on, and the running server uses it from its next start.` | `agent_director_call_timeout_ms`. Once the change is applied, the next `stop --stop-bots` or `clean_restart` uses the new value; the running server keeps its current value until it next starts. |
| `INVALID: <error> Nothing will be applied.` | The edited `config.json` is invalid or missing. Fix the file; nothing is applied until it is valid. `server.log` shows a `reload-invalid` line. |
| `… no effective change: …` | The edit changes nothing that runs (for example, whitespace, a default written out, or only recorded changes, whose lines follow). |

## Confirming a change

To apply a pending change, rename `config.json.pending` to `config.json.apply` in the same directory, with the server running:

```sh
cd "${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}" && mv config.json.pending config.json.apply
```

Read the preview first. The server picks the confirmation up at its next check, within about 5 seconds; a check still running an earlier apply delays it, so `reload-applied` can come minutes later. It deletes the confirmation and applies it without a restart; next-launch and server-wide settings are recorded and take effect later, except the switch `allow_invited_channels`, which applies in place at once (see [What a confirmation applies](#what-a-confirmation-applies)).

You can direct an agent to do the rename for you. Nothing has to be computed, copied or typed. A confirmation made while the server is stopped is processed at the first check after the next start.

Each confirmation logs one of these lines in `server.log`:

```sh
grep -E 'reload-(applied|noop|invalid|stale-confirmation|record-write-failed)' "${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}/server.log" | tail
```

| Line | Meaning |
|---|---|
| `[slack] reload-applied: applied the confirmed configuration change without a restart (personas: …); the last-applied record "<path>" now holds it` | The change is applied, and `config.json.last-applied` holds it. |
| `[slack] reload-noop: the confirmed configuration has no effective change, …` | Nothing that runs changed, as for a confirmation whose only changes are recorded ones (changes to the section not in force). The record was rewritten, and nothing is left pending. |
| `[slack] reload-invalid: the confirmed configuration is invalid, so nothing is applied: <error>` | `config.json` was invalid or missing when you confirmed. The line carries the full error. Fix the file, then confirm the new preview. |
| `[slack] reload-stale-confirmation: the confirmation "<path>" …; nothing is applied` | See [Stale confirmations](#stale-confirmations). |
| `[slack] reload-record-write-failed: … the confirmed change is not applied and stays pending…` | `config.json.last-applied` or the retired-key record (`retired-keys.json`) couldn't be written, so nothing is applied; the line also says whether the keys the confirmation recorded as retired were removed again. The line can also name the stored-choice file (`channel-delivery.json`): a confirmation that brings up a persona whose stored choices were dropped earlier, by a write that failed, first writes that file; when it can't, nothing is applied, the retired-key record is not written, and the change stays pending. Fix the state directory (permissions, free space), then confirm again. |

## What a confirmation applies

Each row is one kind of change: what happens once you confirm it, and what happens to the persona's live session (its instance and its conversation).

| Change | Once confirmed | Live session |
|---|---|---|
| `channels`, `delivery` or `permission_prompts` changes (in declarative mode), `invited.permission_prompts` changes (in fungible mode), or `dm.enabled` or `dm.contact` changes | Applied in place, immediately: from the next event or post. A changed DM contact is used for the next prompt. | Kept |
| A credentials file's content changes (same path), such as a rotated token | Only that persona reconnects: the new connection opens, then the old one closes. If the new file can't be used or Slack refuses it, the old connection keeps running, `server.log` shows `persona-credentials-change-failed`, and the change stays pending. If Slack can't be reached, the old connection stays in use while the new one retries. A persona that is retrying (Slack unreachable, its working directory unusable, or held for its `claude_config_dir` by `persona-config-dir-unresolvable`) has no connection and retries with the new content. A persona down because of its credentials comes up on the confirmed change, with no restart; if its new file can't be used, it stays down with its usual line, such as `persona-credentials-invalid`, and nothing stays pending. | Kept |
| `claude_config_dir` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it and starts a new conversation on the same instance when the directory changed: the conversation is not resumed, nothing is deleted, and the old transcript stays in the old directory. | Kept until the next launch |
| `stop_hook_bootstrap` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it. | Kept |
| A persona is removed | Torn down: its session is ended, with the result checked and retried, and its agent-director row is kept as the old life until agent-director's `expire` removes it, never resumed. Its posted permission prompts stay in Slack, and clicking one has no effect. Until its old instance has ended, no persona is brought up in its working directory (see "A persona waits on an old instance in its working directory" in [Troubleshooting](troubleshooting.md#troubleshooting)). Previewed `DESTRUCTIVE:`. | Retired: never resumed |
| A persona's `credentials_file` path or `working_directory` changes | Torn down as a removal is (its row kept, never resumed), then brought up fresh from its new entry on the same instance, with no restart: a new conversation, and the new credentials file is read. The new conversation starts only once the old instance has ended, and any other persona in the old working directory waits until then too (see "A persona waits on an old instance in its working directory" in [Troubleshooting](troubleshooting.md#troubleshooting)). Previewed `DESTRUCTIVE:`. See [Destructive changes](#destructive-changes). | Retired: never resumed |
| A persona's `name` changes | A removal plus an addition: the name sets the key. The old persona is torn down as a removal is (its row kept until agent-director's `expire` removes it, never resumed), and the new one is brought up fresh once the old one's instance has ended (see "A persona waits on an old instance in its working directory" in [Troubleshooting](troubleshooting.md#troubleshooting)). The removal half is previewed `DESTRUCTIVE:` (`DESTRUCTIVE: persona "<old name>" … is removed`), followed by an `… is added` line for the new name. | Retired: never resumed |
| The switch `allow_invited_channels` changes, turning fungible mode on or off | Applied in place, at once: from the next event, tool call, prompt and notice, with no restart. Each persona serves the channels of the mode turned on (see [Channel modes](channel-modes.md#channel-modes)). While fungible mode is on, stored channel-delivery choices apply; listed `delivery` values are not carried over, so each channel is at `mentions` unless a stored choice applies. | Kept |
| `channels` or `permission_prompts` changes in fungible mode, or `invited` changes in declarative mode: the section not in force | Recorded, with no effect until the switch selects that section. A confirmation whose only changes are recorded ones logs `reload-noop`. | Kept |
| A server-wide setting changes, such as `port` | Recorded. The running server keeps its current value, and the next server start uses the recorded one. `allow_invited_channels` is the exception: it is applied in place at once (see the switch's row above). `stop_timeout` and `exit_timeout` differ too: only the CLI uses them, and it takes them from the record at once, so the next `stop` or `clean_restart` uses them. `agent_director_call_timeout_ms` differs as well: the CLI takes it from the record at once, and the running server uses it from its next start. | Not affected |
| A persona is added | Brought up exactly as at start, including the storage check (`jsonl-non-persistent`, see [Startup errors](troubleshooting.md#startup-errors)). If its credentials file or working directory is bad, it logs the same lines as at start and never affects running personas. See "A persona doesn't come up or doesn't answer" in [Troubleshooting](troubleshooting.md#troubleshooting). | New session |

- **Inherited defaults.** A changed top-level `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. The preview lists those personas; a persona that sets its own value isn't affected.
- **Unchanged personas.** A persona whose declaration and credentials are unchanged is not touched.
- **Several changes to one persona.** A `credentials_file` path or `working_directory` change wins: the persona is brought up fresh from its new entry, which carries its other changes with it. Otherwise each change applies as its row says. The order is teardowns, in-place updates, credentials reconnects, then bring-ups.
- **Fixed on Slack's side.** A persona down because Slack refused its tokens, fixed in Slack (for example, its app re-installed) with the same tokens, has nothing pending. Re-save its credentials file with any byte change (a trailing newline is enough), wait for the pending change, then confirm it. The `debug-slack-channel-bots` skill (see [Troubleshooting](troubleshooting.md#troubleshooting)) has the details.

## When next-launch and server-wide changes take effect

A persona's next launch happens when the bot dies (a crash or a failed health check), at a `clean_restart`, at `stop --stop-bots` then `start`, or after a host reboot. A plain `stop` and `start` reconnects to the running instance, which is not a launch. Server-wide settings take effect at the next server start, except the switch `allow_invited_channels`: it takes effect when the change is confirmed, and needs no `clean_restart`. The CLI takes `stop_timeout`, `exit_timeout` and `agent_director_call_timeout_ms` from the record at once; see the table.

To make them take effect sooner, wait for the `reload-applied` line, then run `claude-slack-channel-bots clean_restart`. It reads the bot list from the record before it stops the server, so if you run it earlier it can work from the old record. The server comes back on the record, and every bot is relaunched. Conversations resume, except that a changed `claude_config_dir` starts that persona fresh.

## Destructive changes

`DESTRUCTIVE:` lines in the preview name the personas the change retires when you confirm it (see the table above). A retired persona's session is stopped and never resumed. Its queue is retained: add a persona with the same key to deliver its queued messages. Read the preview before you rename it. There is no undo. A persona removed and added again with the same key, or renamed and then renamed back, always starts a new conversation, even with a server restart in between: its old conversation is never resumed. A persona brought up from its new entry after a `credentials_file` path or `working_directory` change starts fresh the same way.

CSCB never deletes an agent-director row, and it checks the result of every kill it makes. A teardown ends the old session, checks the result, and keeps the row; a removed persona's row stays until agent-director's `expire` removes it, and is never resumed. A kill agent-director can't carry out right now is tried up to 3 times, 2 s apart. When the kill still fails (for example, the worker outlived each of its kills), `server.log` shows the teardown's line for it, which ends `— the row is kept; nothing latches and no retry timer is armed …`. The persona's new session is then not started over the old one: the bring-up after a `credentials_file` path or `working_directory` change ends the old session first and starts the new conversation only once that succeeds. A renamed persona's new name is brought up only once the old instance has ended, and so is any other persona that shares the old instance's working directory; until then a Claude Code session started from that directory is refused (see "A persona waits on an old instance in its working directory" in [Troubleshooting](troubleshooting.md#troubleshooting)). The old conversation is never resumed either way.

Nothing about the teardown is posted to Slack. Every notice raised for the persona while it runs goes to `server.log` and `startup-errors.log` as a `persona-teardown-notice` entry; see `persona-teardown-notice` under [Startup errors](troubleshooting.md#startup-errors), and "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](troubleshooting.md#troubleshooting).

## Stale confirmations

A confirmation is pinned to the exact content of `config.json` and of every credentials file it names. If any of them changed after the preview was written, nothing is applied. The confirmation is deleted, and one `reload-stale-confirmation` line is logged. The same happens for a confirmation that can't be read or isn't a pending file the server wrote.

To fix it, wait for the server to write `config.json.pending` again (within about 5 seconds), read it and rename it again. A confirmation is used once. If the same content comes back later, for example after a revert and a redo, confirm it again.

## Size limit

`config.json`, the files beside it and each credentials file are read only up to 64 KiB; a larger file is treated as unreadable. The retired-key record (`retired-keys.json`) and the stored-choice file (`channel-delivery.json`) have no size cap: only the server writes them. The queue is also read in full with no size cap (`queue/<key>.jsonl`). If a very large change makes `config.json.pending` itself larger, its rename is refused as stale, so split the change into smaller edits.

## No reload command

By design, no CLI subcommand, MCP tool or HTTP endpoint applies a change: the rename is the only way. Personas are Claude instances that read help output and tool lists, and a reload can remove a persona, so none of them advertises it; this isn't a security boundary, since a bot running as your user could rename the file itself, so only direct one to when you intend to.

## When the server can't start

A confirmation needs a running server. When the record keeps the server from starting (it can't be read or is invalid, or the first start recorded a bad `port` or `bind`), fix `config.json`, delete `config.json.last-applied`, then run `claude-slack-channel-bots start`. With no record, the start applies `config.json` as it stands and shows no preview.
