# Channel modes

The top-level setting `channel_mode` selects `strict` or `open` for every persona. `strict` is the default.

## What each mode serves

| | Strict mode | Open mode |
|---|---|---|
| Selector | `channel_mode` set to `strict`, the default | `channel_mode` set to `open` |
| Listening | Listed channels with non-off applied choices | Public or private channels the app is in, not externally shared, with non-off applied choices |
| Channel choices | Shared `channels` and `delivery` in both modes | The same shared choices |
| Prompts and notices | Required `permission_prompts` | The same destination |

Both modes share one list and destination. A newly verified member without a choice starts at `off` in strict or `mentions` in open, using the mode when the join is applied. Duplicate joins and mode switches preserve choices, including `off`.

DMs follow `dm.enabled` in both modes; group DMs are never served. Slack Connect channels are served only in strict mode, at a non-off choice, with current verified membership.

Listening requires current verified membership, learned from Slack's join event for the app when invited (the app needs the `member_joined_channel` subscription), or from startup catch-up. An invitation request is not proof until qualifying evidence arrives; listing a channel, hearing a message or posting alone is not evidence. Valid current positives can progress before the inventory completes; [membership readiness](../skills/debug-slack-channel-bots/SKILL.md#membership-setup-record-and-readback) reports inventory and live-event setup separately.

A configuration still holding a removed key is rejected with an error naming its replacement (see [Removed configuration keys](../skills/debug-slack-channel-bots/SKILL.md#removed-configuration-keys)).

## Who can reach a persona in open mode

Read this before turning open mode on. Each persona's Claude worker runs with tool access on the host, and channel assignments determine who can reach that worker.

- **Assignments change a persona's audience.** A channel invitation and an applied listening choice can expose a persona's worker to new people. In open mode, a verified join without a choice creates `mentions`. This includes private channels, which the operator may not be able to see.
- **Anyone who can reach the persona can change what it hears in a channel.** In any channel it serves, or by DM, anyone can ask the persona to set any eligible channel it is a member of to any value, including a channel they are not in. At `all`, every message in that channel then reaches the worker.
- **Open-mode choices persist into strict mode.** A choice a persona sets in open mode stays in force when strict mode is turned on, so a non-off choice can start delivery in a channel that was `off`, until a later allowed write or a verified leave changes it.
- **`fetch_messages` reads every channel the app is in.** The persona's `fetch_messages` can read the history of every channel its app is a member of, so content can be carried from one channel to another.
- **Slack Connect channels are never served in open mode.** They can be served only in strict mode, at a non-off choice, with current verified membership. Open discovery saves `mentions` when no choice exists; switching to strict can activate it without another listing step (see the [preview and off-first warning](#turning-open-mode-on-or-off)).
- **Enterprise Grid: Slack's flag decides.** A channel shared between workspaces of one Enterprise Grid organization can be served when Slack marks it as not externally shared, and then members of every workspace sharing it can reach the persona.

The audit lines in `server.log` are `persona-open-channel`, logged the first time a persona hears a channel in open mode (naming the channel, `public` or `private`, and its `delivery` value), and `persona-channel-delivery-set`, logged for each choice a `set_channel_delivery` call newly applies, as `delivery choice for channel <channel> set from <none|off|mentions|all|thread_hybrid> to <value>, at channel delivery <value>`. The debugging skill explains both ([`persona-open-channel`](../skills/debug-slack-channel-bots/SKILL.md#persona-open-channel), [`persona-channel-delivery-set`](../skills/debug-slack-channel-bots/SKILL.md#persona-channel-delivery-set)). To list them:

```sh
grep -E 'persona-(open-channel|channel-delivery-set)' ~/.config/claude-slack-channel-bots/server.log*
```

A persona logs a channel's `persona-open-channel` line only once until the server restarts or the persona is brought up fresh, so on a long-running server, log rotation can discard a channel's only audit line (see [Server log rotation](troubleshooting.md#server-log-rotation)). After a restart, the first event from each channel a persona hears in open mode logs its line again.

## Turning open mode on or off

Before you turn open mode on, read [Who can reach a persona in open mode](#who-can-reach-a-persona-in-open-mode): assignments determine who can reach the worker.

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

Slack Connect memberships discovered in open mode already have `mentions` saved when no prior choice existed; with current verified membership, switching to strict can activate that choice without another manual listing step. Existing `off` choices stay off.

Review [Reading the preview](reload.md#reading-the-preview) before switching. If that external audience is unwanted, review and confirm an explicit `off` assignment **before switching to strict**.

## Delivery values in both modes

In both modes, the shared choices are `off`, `mentions`, `all` and `thread_hybrid`. A missing or unreadable assignment holds affected intake; it is not a saved `off` choice. A newly verified member gets the mode's join default described above, preserving any existing choice: `mentions` delivers direct mentions and broadcasts, `all` delivers every message, and `thread_hybrid` is described under [Threads in `thread_hybrid` channels](#threads-in-thread_hybrid-channels).

- **Saved and effective choice.** A persona's saved choice is the `delivery` value of its entry in the shared list. Its effective choice is what applies to the next message: the saved value while its app is a verified, eligible member and the shared state is readable. While membership is unverified or the state is unresolved, the channel's messages are held, and in a channel the persona can't serve, nothing is delivered; the saved value stays as it is.
- **Who writes and which choice wins.** The operator can assign through a confirmed edit in both modes; a persona can make new `set_channel_delivery` assignments only in open. The later successful durable application to that persona/channel wins, including explicit same-value assignments. Saving `config.json`, preview creation, call start, file dates and timestamps establish no precedence; copied fields and a mode-only confirmation are not assignments.
- **The file can differ from the saved choice.** Persona writes, join defaults and verified-leave removals never rewrite `config.json`, so its delivery can differ even with no pending byte change. Read the current saved choice from the preview's `Channel persona=… channel=…` line's `saved=` field, separately from `reviewed` and the effective values. To reassert a value the file already shows, [request an explicit assignment, review and confirm it](reload.md#editing-the-configuration).
- **Choices persist.** Applied choices live in `config.json.last-applied` across server restarts and persona relaunches. A mode switch preserves them. A proven leave removes the prior choice; incomplete scans cannot prove a leave, and uncertain ordering holds the channel without erasing a newer reviewed choice. A removed, renamed or replaced persona never inherits its previous incarnation’s choices.
- **`receive_all_shared` requires effective eligibility.** In either mode, a non-mention/non-broadcast message uses this reason only when this persona and another currently eligible member have effective `all` in the channel. A saved-all choice alone does not count: departed or unverified personas cannot supply it, and a persona on `thread_hybrid` never counts; otherwise the reason is `receive_all`.
- **Notice Destinations.** Each persona's `delivery` applies as written in a channel where another persona posts its permission prompts and notices. Use this on purpose: with `planner`'s `permission_prompts` set to a channel where `reviewer`'s entry is `all`, `reviewer` sees each of `planner`'s prompts and notices there and can review them.
- **Two personas hearing each other there can answer each other in a loop.** This includes `thread_hybrid` channels, because a persona's own prompts and notices put it in their threads. To avoid it, keep one of them at `mentions`, or give the other persona a different destination.
- **Don't keep two personas at `all` in one channel.** Each receives every message there, the other's posts included, so each answer one persona posts reaches the other, which can answer it in turn: the two can keep answering each other with no human involved. Two personas in one thread they are both in can keep answering each other the same way. If one should listen to everything, keep the other at `mentions`.

## Threads in `thread_hybrid` channels

At `thread_hybrid`, a persona receives its @mentions and broadcasts, plus every later message in each thread it is in, with `via` `thread`. [How a persona receives messages](bots.md#how-a-persona-receives-messages) gives the order of reasons.

### Joining a thread

- An accepted @mention or broadcast, in a thread's channel message or in a reply, joins the persona to that thread as soon as CSCB accepts it, before the persona answers. Each persona mentioned joins on its own.
- A post CSCB makes as the persona and Slack confirms joins its thread: replies, uploaded files, permission prompts and server notices.
- Nothing else joins: reactions, edits (even one adding a mention), deletions, posts the app makes outside CSCB, unconfirmed posts, DMs, and channels that are not `thread_hybrid` or that the persona isn't eligible to serve.

Joining sends no earlier message. The persona can read the whole thread with `fetch_messages` (see [Tools](bots.md#tools)).

### Staying in a thread

Threads are kept across persona and server restarts, channel mode switches and setting `thread_hybrid` again. There is no expiry, no way to leave one thread and no limit. In a channel the persona can't currently serve, its threads are kept and deliver again once it can.

### Starting over

- A persona forgets its threads in a channel when its choice there stops being `thread_hybrid` for any reason, or when its app leaves the channel (a verified leave).
- A removed, renamed or replaced persona forgets all of them (see [Destructive changes](reload.md#destructive-changes)).
- A channel switched to `thread_hybrid` starts with none. Messages already waiting are kept, and delivering them joins nothing.
- A leave and rejoin that CSCB never observes, such as both while it is stopped, is not a verified leave, so the threads stay.

Keep each persona's Slack app internal to the workspace, not distributed: a distributed app gets lower Slack rate limits, which slow whole-thread reading and recovery lookups. The Thread Memory reports a persona's destination can receive are in [Troubleshooting](troubleshooting.md#troubleshooting).

## Permission prompts in both modes

`permission_prompts` is required in both modes. Prompts and server notices, including *Message not saved* notices and restart-limit warnings, use that same destination.

- **A channel ID:** a listed channel for a fresh submission, including one set to `off`. Invite the app there so Slack can accept its posts. Everyone there sees the prompts and notices.
- **`dm`:** a DM to `dm.contact`, requiring `dm.enabled: true` and a contact.

A validated unchanged channel destination stays selected after a verified leave of that channel by the same persona incarnation, even with zero entries and DMs off; it does not recreate membership or a choice. Only a confirmed destination change moves future prompts and ordinary notices, held notices included. Posted valid prompts stay answerable in their original conversation; [Permission Relay](bots.md#permission-relay) says who may answer.

[Storage-warning recovery](../skills/debug-slack-channel-bots/SKILL.md#message-saved-after-retry) keeps both the edit and its one fallback correction in the warning's original channel or DM, even after the destination changes or DMs are turned off.

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
