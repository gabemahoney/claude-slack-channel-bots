# Changelog

Release notes for `claude-slack-channel-bots`. The version number and date of each release are set when it is published.

---

## Unreleased (next major version)

This release replaces the single-bot setup with **personas**. It is a breaking release: an existing install must be converted by hand before the server starts again. The steps are in the README under [Upgrading to personas](README.md#upgrading-to-personas).

### What's new

- **One server, several personas.** Each persona is its own Slack app with its own name and avatar, runs its own Claude instance in its own working directory, and serves the channels it lists. See [Personas (config.json)](README.md#personas-configjson).
- **Per-channel delivery.** Each channel entry says whether the persona gets every message or only @mentions and broadcasts. Several personas can share a channel. See [Channel delivery](README.md#channel-delivery) and [How a persona receives messages](README.md#how-a-persona-receives-messages).
- **Direct messages per persona.** A persona's DMs switch lets anyone in the workspace DM that persona's app, and lets it start a DM itself. Permission prompts and notices can go to a named contact by DM. See [Direct messages](README.md#direct-messages-dmenabled) and [Permission prompts](README.md#permission-prompts).
- **Credentials files.** Each persona's tokens live in its own file. The setup wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command) writes it from your own terminal without echoing the tokens. See [Credentials files](README.md#credentials-files).
- **Confirmed configuration changes.** Edits to `config.json` or a credentials file on a running server wait as a pending change with a preview, and apply only when you confirm them. Only the affected personas are torn down or reconnected. See [Reload](README.md#reload).
- **A broken persona doesn't stop the others.** A persona that can't come up (a missing working directory, a bad credentials file, a Slack app that can't connect) stays down on its own while the others serve, and nothing about it is posted to Slack. See [Troubleshooting](README.md#troubleshooting) and the `debug-slack-channel-bots` skill.
- **Scheduled prompts and `/interject` target personas** by name or key. See [Scheduled Prompts](README.md#scheduled-prompts-cscb_cron) and [Interject](README.md#interject).

### Breaking changes

- **Configuration is a list of personas.** A configuration from an earlier version is rejected at start, with an error naming the offending setting. Nothing is converted automatically; rewrite `config.json` by hand as described in [Upgrading to personas](README.md#upgrading-to-personas) and [Personas (config.json)](README.md#personas-configjson).
- **Tokens come only from credentials files.** Slack tokens are no longer read from environment variables. Create one credentials file per persona with the wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command), then remove any token environment variables you exported for the previous version.
- **One Slack app per persona.** An existing app can serve one persona; create another app for each additional persona. Re-install the existing app from the current `slack-app-manifest.yml` so it gains the `im:write` scope.
- **The access-control file is retired.** Who can reach a persona is decided only by its `channels`, each channel's `delivery` and its `dm.enabled` switch. The allowlist and pairing flow are gone. Set the acknowledgement reaction and reply splitting in `config.json` instead (see [Server-wide settings](README.md#server-wide-settings)).
- **Crontable lines that name channels no longer match.** Such a target matches no persona and is logged `unknown-persona` each time it fires. Rewrite each target as a persona's name or key.
- **Each bot starts fresh once.** Bot instances created before the upgrade are replaced at the first start, so each persona starts once without its prior conversation.
- **`/interject` requests name a persona.** A request must carry `persona` (a persona's name or key). A body that names only a `channel` is refused with 400. A successful response is `{ "ok": true, "persona": "<name>" }`; it no longer holds `channel` or `cwd`. Update every script that calls `/interject`, including host crontab `curl` lines, to send `persona`. See [Interject](README.md#interject).

### Behaviour changes you will notice

- **Bot, integration and webhook posts are delivered.** The previous version dropped posts from bots and integrations (Slack's `bot_message` posts and posts with no user). They now reach a persona like any other message; a persona ignores only its own posts. A persona with `delivery: all` in an alerting channel wakes on every alert. Use `delivery: mentions` for such a channel if that is not what you want. See [How a persona receives messages](README.md#how-a-persona-receives-messages).
- **`@here` and `@channel` wake mention-only personas.** A persona with `delivery: mentions` receives broadcasts as well as its own @mentions. `@everyone` and user-group mentions still don't count. See [Channel delivery](README.md#channel-delivery).
- **Lost messages are reported at the persona's destination.** A message that arrives while a persona's instance can't take it is still lost. The previous version replied in the conversation the message came from; now the persona posts one lost-message notice to its destination (its `permission_prompts` channel, or a DM with its contact), and nothing is posted where the message was sent. See [Troubleshooting](README.md#troubleshooting).

### Upgrade note: leftover `access.json`

An upgraded host keeps any existing `access.json` in the state directory: `~/.claude/channels/slack/`, or the directory in `SLACK_STATE_DIR` when that is set. The server never reads it, so it is an ignored file. Delete it by hand once the personas are running:

```sh
rm "${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/access.json"
```
