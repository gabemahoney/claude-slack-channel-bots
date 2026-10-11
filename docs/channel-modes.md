# Channel modes

The top-level setting `allow_invited_channels` picks the channel mode for every persona at once. The mode decides which channels a persona serves, how each channel's delivery is set, and where the persona's permission prompts and notices go.

## What each mode serves

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

## Who can reach a persona in fungible mode

Read this before turning fungible mode on. Each persona's Claude worker runs with tool access on the host, and in fungible mode the workspace's members, not the operator, choose the channels it serves.

- **An invite changes a persona's audience.** Any workspace member can point a persona's worker at any channel they are in by inviting the persona's app there. This includes private channels, which the operator may not be able to see.
- **Anyone who can reach the persona can switch a channel to `all`.** In any channel it serves, or by DM, anyone can ask the persona to switch any channel it serves to `all`, including a channel they are not in. From then on, every message in that channel reaches the worker.
- **`fetch_messages` reads every channel the app is in.** The persona's `fetch_messages` can read the history of every channel its app is a member of, so content can be carried from one channel to another.
- **Slack Connect channels are never served.** An externally shared channel is never served in fungible mode; serve it in declarative mode, with the channel listed.
- **Enterprise Grid: Slack's flag decides.** A channel shared between workspaces of one Enterprise Grid organization is served when Slack marks it as not externally shared, and then members of every workspace sharing it can reach the persona.

The audit lines in `server.log` are `persona-invited-channel`, logged the first time a persona hears a channel in fungible mode (naming the channel, `public` or `private`, and its channel delivery), and `persona-channel-delivery-set`, logged for each stored `set_channel_delivery` choice. The debugging skill explains both ([`persona-invited-channel`](../skills/debug-slack-channel-bots/SKILL.md#persona-invited-channel), [`persona-channel-delivery-set`](../skills/debug-slack-channel-bots/SKILL.md#persona-channel-delivery-set)). To list them:

```sh
grep -E 'persona-(invited-channel|channel-delivery-set)' ~/.config/cscb/server.log*
```

A persona logs a channel's `persona-invited-channel` line only once until the server restarts or the persona is brought up fresh, so on a long-running server, log rotation can discard a channel's only audit line (see [Server log rotation](troubleshooting.md#server-log-rotation)). After a restart, the first event from each channel a persona hears in fungible mode logs its line again.

## Turning fungible mode on or off

Before you turn fungible mode on, read [Who can reach a persona in fungible mode](#who-can-reach-a-persona-in-fungible-mode): an invite then changes who can reach a persona's worker.

The switch changes through a confirmed edit, like every other setting:

1. Edit `config.json`. To turn fungible mode on, add `"allow_invited_channels": true` and give each persona the `invited` section it needs (see [Load-time rules](configuration.md#load-time-rules)). To turn it off, remove the setting or set it to `false`.
2. Read the pending preview. The switch has its own line, naming the mode it turns on and every persona it affects (see [Reading the preview](reload.md#reading-the-preview)).
3. Confirm the change (see [Confirming a change](reload.md#confirming-a-change)). It applies in place, at once, from the next event, tool call, prompt and notice, with no restart, and every session is kept (see [What a confirmation applies](reload.md#what-a-confirmation-applies)).

**Turning it on.** From each channel's next message, fungible mode serves every public or private channel each persona's app is already in that is not externally shared. Each channel is served at `mentions` unless a stored choice applies. Listed `delivery` values are not carried over: a channel listed with `delivery: all` is served at `mentions` unless the persona's agent stores `all` for it.

Before you turn it on, review each persona's app's channel memberships in Slack, private channels included: each one becomes a channel the persona serves. Past `unclaimed-channel` lines in `server.log` show channels whose messages reached a persona's app with no persona serving them:

```sh
grep unclaimed-channel ~/.config/cscb/server.log*
```

**Turning it off.** The change is checked by the declarative rules, so each persona needs a valid declarative section: a persona whose `channels` or `permission_prompts` breaks a declarative-mode rule makes the change `INVALID` (see [Load-time rules](configuration.md#load-time-rules)). From the next event, each persona serves its listed channels again, each at its `delivery`. Turning it off changes no stored choice on disk: the choices stop applying, and they apply again when fungible mode is turned back on.

## Channel delivery in fungible mode

In fungible mode, a persona's channel delivery for a channel sets which messages there reach it, as `delivery` does in declarative mode: `mentions` (only messages that @mention the persona directly, and `@here` / `@channel` broadcasts) or `all` (every message).

- **`mentions` is the default.** A channel is at `all` only when the persona's agent stored `all` for it with `set_channel_delivery` (see [Tools](bots.md#tools)). The agent calls the tool when someone in that channel asks it to listen to everything there, or to answer only when mentioned. Whether any persona lists the channel in `channels` plays no part.
- **The loop guard.** A channel that is another persona's fungible destination (its `invited.permission_prompts` channel) is held at `mentions` for every other persona, whatever they stored, so no other persona receives every message where that persona's prompts and notices are posted. A persona's own destination channel is not held for it, and a `"dm"` destination holds nothing.
- **Stored choices persist.** Each choice is kept in `channel-delivery.json` beside `config.json` (see [Files beside the config file](reload.md#files-beside-the-config-file)), across server restarts and persona relaunches, and applies from the next message after the call. A persona that is removed, renamed, or whose `credentials_file` or `working_directory` changes loses its stored choices and comes up at `mentions` everywhere.
- **`receive_all_shared` is an approximation.** A persona at `all` in a channel receives a message there as `receive_all_shared` when at least one other persona's channel delivery for that channel, computed by the same rule, is `all`. A stored choice says nothing about whether the other persona's app remains in the channel, so a persona whose app has left the channel counts too.
- **Don't keep two personas at `all` in one channel.** Each receives every message there, the other's posts included, so each answer one persona posts reaches the other, which can answer it in turn: the two can keep answering each other with no human involved. If one should listen to everything, keep the other at `mentions`.

## Permission prompts in fungible mode

In fungible mode, a persona's destination is its `invited.permission_prompts`, `"dm"` when it is absent. Its permission prompts and its server notices, such as lost-message notices and restart-limit warnings, are posted there as the persona. See the `invited.permission_prompts` row in [Persona fields](configuration.md#persona-fields).

- **A channel ID:** any channel; it needs no listing and no DMs. Invite the persona's app to it, or Slack refuses the posts (see "A permission prompt or notice doesn't arrive" in [Troubleshooting](troubleshooting.md#troubleshooting)). Everyone in that channel sees the prompts and notices.
- **`"dm"`, written or by default:** a DM from the persona's app to its `dm.contact`. It needs `dm.enabled: true` and a `dm.contact`.

Because of the loop guard, no other persona receives every message in a fungible destination channel. After a confirmed switch change, the next prompt and the next notice, held notices included, go to the destination of the mode turned on; prompts already posted stay where they are and stay answerable.

## Example in fungible mode

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
