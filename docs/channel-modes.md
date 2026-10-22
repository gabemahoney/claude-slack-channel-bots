# Channel modes

The top-level setting `channel_mode` selects `strict` or `open` for every persona. `strict` is the default.

## What each mode serves

| | Strict mode | Open mode |
|---|---|---|
| Selector | `channel_mode` set to `strict`, the default | `channel_mode` set to `open` |
| Listening | Listed channels with non-off applied choices | Public or private channels the app is in, not externally shared, with non-off applied choices |
| Channel choices | Shared `channels` and `delivery` in both modes | The same shared choices |
| Prompts and notices | Required `permission_prompts` | The same destination |

Both modes share one list and destination. A newly verified member without a choice starts at `off` in strict or `mentions` in open, using the mode when the join is applied. Duplicate joins and mode switches preserve choices, including `off`. DMs follow `dm.enabled` in both modes; group DMs are never served. Slack Connect channels are served only in strict mode, with the channel listed.

Listening requires current verified membership. Listing, hearing a message, posting or inviting alone supplies no such evidence. Valid current positives can progress before the inventory completes; [membership readiness](../skills/debug-slack-channel-bots/SKILL.md#membership-setup-record-and-readback) reports inventory and live-event setup separately.

Configurations using `allow_invited_channels` or `invited` are rejected; a manual edit is required.

## Who can reach a persona in fungible mode

Read this before turning open mode on. Each persona's Claude worker runs with tool access on the host, and channel assignments determine who can reach that worker.

- **Assignments change a persona's audience.** A channel invitation and an applied listening choice can expose a persona's worker to new people. In open mode, a verified join without a choice creates `mentions`. This includes private channels, which the operator may not be able to see.
- **Anyone who can reach the persona can switch a channel to `all`.** In any channel it serves, or by DM, anyone can ask the persona to switch any channel it serves to `all`, including a channel they are not in. From then on, every message in that channel reaches the worker.
- **`fetch_messages` reads every channel the app is in.** The persona's `fetch_messages` can read the history of every channel its app is a member of, so content can be carried from one channel to another.
- **Slack Connect channels are never served.** An externally shared channel is never served in open mode; serve it in strict mode, with the channel listed.
- **Enterprise Grid: Slack's flag decides.** A channel shared between workspaces of one Enterprise Grid organization can be served when Slack marks it as not externally shared, and then members of every workspace sharing it can reach the persona.

The audit lines in `server.log` are `persona-invited-channel`, logged the first time a persona hears a channel in open mode (naming the channel, `public` or `private`, and its channel delivery), and `persona-channel-delivery-set`, logged for each stored `set_channel_delivery` choice. The debugging skill explains both ([`persona-invited-channel`](../skills/debug-slack-channel-bots/SKILL.md#persona-invited-channel), [`persona-channel-delivery-set`](../skills/debug-slack-channel-bots/SKILL.md#persona-channel-delivery-set)). To list them:

```sh
grep -E 'persona-(invited-channel|channel-delivery-set)' ~/.config/claude-slack-channel-bots/server.log*
```

A persona logs a channel's `persona-invited-channel` line only once until the server restarts or the persona is brought up fresh, so on a long-running server, log rotation can discard a channel's only audit line (see [Server log rotation](troubleshooting.md#server-log-rotation)). After a restart, the first event from each channel a persona hears in open mode logs its line again.

## Turning open mode on or off

Before you turn open mode on, read [Who can reach a persona in open mode](#who-can-reach-a-persona-in-fungible-mode): assignments determine who can reach the worker.

The switch selects `strict` or `open` through a confirmed edit:

1. Set `"channel_mode": "open"` or `"channel_mode": "strict"` in `config.json`.
2. Read the pending preview, including its mode line (see [Reading the preview](reload.md#reading-the-preview)).
3. Confirm the change (see [Confirming a change](reload.md#confirming-a-change)). It applies in place with no restart and keeps every session. Mode changes preserve every applied `delivery` choice and the shared destination.

**Turning it on.** Open mode permits listening in public or private channels the app is in that are not externally shared. Listening still requires a non-off applied choice; the switch does not create assignments.

Before you turn it on, review each persona's app's channel memberships in Slack, private channels included: each one may become a listening channel when it has a non-off applied choice. Past `unclaimed-channel` lines in `server.log` show channels whose messages reached a persona's app with no persona serving them:

```sh
grep unclaimed-channel ~/.config/claude-slack-channel-bots/server.log*
```

**Turning it off.** Strict mode uses the same shared channel choices and destination. The mode switch preserves them, including choices made while open mode was active.

## Channel delivery in open mode

In both modes, the shared choices are `off`, `mentions`, `all` and `thread_hybrid`. A channel with no assignment defaults to `off`. A newly verified member gets an assignment using the mode's join default described above, preserving any existing choice. `mentions` delivers direct mentions and broadcasts, while `all` delivers every message.

- **Choices persist.** Applied choices live in `config.json.last-applied` across server restarts and persona relaunches. A mode switch preserves them. A proven leave removes the prior choice; incomplete scans cannot prove a leave, and uncertain ordering holds the channel without erasing a newer reviewed choice. A removed, renamed or replaced persona never inherits its previous incarnation’s choices.
- **The loop guard.** Another persona’s `permission_prompts` channel is held at `mentions` for other personas whose applied choice is non-off. Its own destination and a `"dm"` destination hold nothing.

- **`receive_all_shared` is an approximation.** A persona at `all` in a channel receives a message there as `receive_all_shared` when at least one other persona's channel delivery for that channel, computed by the same rule, is `all`. A stored choice says nothing about whether the other persona's app remains in the channel, so a persona whose app has left the channel counts too.
- **Don't keep two personas at `all` in one channel.** Each receives every message there, the other's posts included, so each answer one persona posts reaches the other, which can answer it in turn: the two can keep answering each other with no human involved. If one should listen to everything, keep the other at `mentions`.

## Permission prompts in both modes

`permission_prompts` is required in both modes. Prompts and server notices, including *Message not saved* notices and restart-limit warnings, use that same destination.

- **A channel ID:** a listed channel, including one set to `off`. Invite the app there so Slack can accept its posts. Everyone there sees the prompts and notices.
- **`dm`:** a DM to `dm.contact`, requiring `dm.enabled: true` and a contact.

A confirmed destination change moves the next prompt and notice, held notices included. Posted prompts stay answerable where they are.

## Example in open mode

A complete `config.json` in open mode, with two personas. `triage` has a listed destination channel set to `mentions` and takes no DMs. `concierge` takes DMs and explicitly sends prompts and notices to its contact. Invite each app to the channels it should use; listening requires a non-off applied choice.

```json
{
  "personas": [
    {
      "name": "triage",
      "credentials_file": "~/.config/claude-slack-channel-bots/triage-credentials.json",
      "working_directory": "~/projects/triage",
      "channels": [{ "id": "C0123456789", "delivery": "mentions" }],
      "permission_prompts": "C0123456789"
    },
    {
      "name": "concierge",
      "credentials_file": "~/.config/claude-slack-channel-bots/concierge-credentials.json",
      "working_directory": "~/projects/concierge",
      "dm": { "enabled": true, "contact": "U0123456789" },
      "permission_prompts": "dm"
    }
  ],
  "channel_mode": "open"
}
```

### Turning fungible mode on or off

See [Turning open mode on or off](#turning-open-mode-on-or-off).

### Channel delivery in fungible mode

See [Channel delivery in open mode](#channel-delivery-in-open-mode).

### Permission prompts in fungible mode

See [Permission prompts in both modes](#permission-prompts-in-both-modes).
