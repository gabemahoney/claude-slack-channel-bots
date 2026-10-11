# Troubleshooting

The `debug-slack-channel-bots` skill has an entry for every persona log class, every `config.json` rejection and each recovery step; run `/debug-slack-channel-bots` from Claude Code for a guided diagnosis. This page lists the common symptoms, then the server log and the startup-error log.

**config.json not found**
With no last-applied record, `start` exits with `missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>`. Run `bun src/postinstall.ts` from the installed package directory to create the skeleton, or create the file, and check that `SLACK_STATE_DIR` names the directory you populated. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-configjson-not-found).

**The server won't start: last-applied record error**
`server.log` shows `[slack] Fatal: last-applied record error —`: the record can't be read or is invalid. Check `config.json`, then delete the record; the next start applies `config.json` as it stands. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-the-server-wont-start-last-applied-record-error).

**The server won't start: `reload-record-write-failed`**
A start with no record could not write it, so nothing was applied. Make the directory holding `config.json` writable and not full, then start again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-the-server-wont-start-reload-record-write-failed).

**A fix to config.json is ignored after a failed first start**
The first start recorded the bad setting, such as `port` or `bind`, before it failed, and later starts run the record. Apply the fix as [When the server can't start](reload.md#when-the-server-cant-start) describes. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-fix-to-configjson-is-ignored-after-a-failed-first-start).

**Session connects but has no persona**
`server.log` shows `Session connected with CWD "<path>" — no matching persona`: the session's working directory is no persona's `working_directory`, compared by real path. A `Session refused: …` line instead means an old instance may still run in that directory (see "A persona waits on an old instance in its working directory"). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-connects-but-has-no-persona).

**A persona doesn't come up or doesn't answer**
The persona is silent, `/interject` returns 503 for it, or its scheduled prompts log `no-session`; nothing is posted to Slack. Find its key on its `persona-start` line in `server.log` and read its lines: each names a class (such as `persona-credentials-invalid` or `persona-directory-missing`) and the file or directory to fix. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-doesnt-come-up-or-doesnt-answer).

**A persona's instance waits at a startup prompt**
After each launch the server presses Enter on Claude Code's folder-trust or development-channels prompt, for at most the later of 5 minutes and `pending_grace_seconds` plus 60 s, and types nothing else. For any other prompt, attach with `tmux attach -t =slack_bot_<key>` and answer it. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-personas-instance-waits-at-a-startup-prompt).

**A persona's instance is still starting**
Normal for a short time after every launch: the server waits it out and never launches a second instance over it. If it hasn't started in time, the persona posts a *Launch stuck* or *Session not starting* notice. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-personas-instance-is-still-starting).

**A persona doesn't receive messages in a channel or DM**
Check that its Slack app is invited to the channel, that the channel is listed in `channels` with the `delivery` you want (declarative mode) or that its channel delivery there is the one you want (fungible mode), that the edit is confirmed, and for DMs that `dm.enabled` is `true`. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-doesnt-receive-messages-in-a-channel-or-dm).

**A persona is silent in a channel it was invited to**
An invite alone serves a channel only in fungible mode, and never a Slack Connect channel or a group DM. An edit that adds a mention, or a message posted before the invite, delivers nothing; the `unclaimed-channel` and `persona-invited-channel` lines in `server.log` show which case applies. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-is-silent-in-a-channel-it-was-invited-to).

**A persona receives every message in a channel**
In fungible mode its agent stored `all` there (a `persona-channel-delivery-set` line): ask it to switch back to `mentions`, remove its app from the channel, or turn fungible mode off. In declarative mode, change the channel's `delivery` to `mentions` and confirm the change. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-receives-every-message-in-a-channel).

**File attachment fails after a long wait**
Each Slack request attempt, an upload included, is limited to 30 s, so an upload that needs longer fails only after about 30 minutes of retries. Send smaller files, or split a large attachment. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-file-attachment-fails-after-a-long-wait).

**Messages in a channel no persona is configured into are not delivered**
Each such message logs an `unclaimed-channel` line naming the channel, and in fungible mode the reason. List the channel in a persona's `channels` and confirm the change, or turn fungible mode on for a public or private channel that is not externally shared. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-messages-in-a-channel-no-persona-is-configured-into-are-not-delivered).

**Permission relay not working**
Turn on the persona's app's interactivity, check the bot is in `check_permission` with `agent-director list --state check_permission --label service=cscb`, and if `permission-poller:` lines warn of skipped ticks, raise `agent_director_poll_interval_ms` (it takes effect at the next server start). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-permission-relay-not-working).

**A permission prompt or notice doesn't arrive**
Slack refused a post to the persona's destination; a `persona-destination-failed` line names its error, and the prompts and notices are held and retried. For `missing_scope` add `im:write` and re-install the app; for `not_in_channel` invite the app to its destination channel. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-permission-prompt-or-notice-doesnt-arrive).

**Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning**
The bot is stuck on a Claude Code prompt that never reached Slack. A human reads it with `agent-director read-pane --claude-instance-id <id>`, ends the session with `agent-director kill --claude-instance-id <id>` and checks the result; on an error, don't delete or respawn, and never use `send-keys`. The server then brings the persona up again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bot-appears-dead--posts-a-blocked-on-a-native-claude-code-permission-prompt-warning).

**Session not restarting after crash**
Restarts back off from `session_restart_delay`, and after 5 failed launches in a row the persona posts `SpawnCapReached` and automatic restarts stop. Fix the cause, then restart the server (`claude-slack-channel-bots stop && claude-slack-channel-bots start`) to clear the limit. Each message lost meanwhile gets one lost-message notice naming the recovery state. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-not-restarting-after-crash).

**A persona is retried after agent-director refuses it**
The server retries the persona on its own (after 30, 60, 120 and 240 s, then every 300 s) and never counts it toward the restart limit. If it never clears, check that `agent-director version` answers and fix agent-director; no server restart is needed. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-is-retried-after-agent-director-refuses-it).

**A persona waits on an old instance in its working directory**
After a removal, rename or path change, or a start whose clean-up could not end an old instance, no persona comes up in that directory until the old instance has ended; the server keeps ending it. If its kill keeps failing, a human follows the "Operator actions" section of agent-director's README. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-waits-on-an-old-instance-in-its-working-directory).

**Bot alive but silently unresponsive (MCP disconnected)**
The health check reconnects or relaunches such a bot on its own, within about 3–5 minutes at the default settings. With `session_restart_delay` set to `0`, a *Not connected* or *Not receiving messages* notice reports it instead. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bot-alive-but-silently-unresponsive-mcp-disconnected).

**Reading the start summary**
Each start logs one `[slack] startupSessionManager: complete — …` line counting its personas by outcome. `latched`, `retrying`, `waiting on a live-row sequence`, `held on invalid flags` and `fresh as retired keys` are not failures. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-reading-the-start-summary).

**A persona posts a *Waiting on a prompt*, *Not connected* or *Not receiving messages* notice**
The session runs, but messages can't reach it. A human attaches with `tmux attach -t =slack_bot_<key>`, deals with anything on screen and, if it stays disconnected, types `/mcp reconnect slack-channel-router`, or restarts the server. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-waiting-on-a-prompt-not-connected-or-not-receiving-messages-notice).

**A persona posts a *Not answering*, *Still not answering* or *Answering again* notice**
agent-director or tmux is not answering for this persona's session; the server keeps retrying and posts *Answering again* when it recovers. After *Still not answering*, a human checks tmux and agent-director with read-only commands only. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-not-answering-still-not-answering-or-answering-again-notice).

**A persona posts a *Slow recovery* notice**
agent-director has not yet marked the gone session's row ended or missing; the server relaunches the persona once it does. Nothing is needed unless it persists; then read the row with `agent-director get --claude-instance-id cscb_<key>`. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-slow-recovery-notice).

**A persona posts a *Launch stuck* or *Session not starting* notice**
The launch did not start in time. *Launch stuck*: the server ended its own launch and relaunched it, and nothing is needed. *Session not starting*: a human answers its startup prompt (`tmux attach -t =slack_bot_<key>`) or ends the launch through agent-director's "Operator actions". [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-launch-stuck-or-session-not-starting-notice).

**A persona posts a *tmux unavailable* or *tmux server changed* notice**
*tmux unavailable*: install or repair tmux. *tmux server changed*: a human follows the "Operator actions" section of agent-director's README, and leaves tmux alone. The server retries meanwhile and posts *All clear.* once tmux answers. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-tmux-unavailable-or-tmux-server-changed-notice).

**A persona posts a *Held: tmux session conflict* notice**
The server holds the persona and launches nothing for it. A human follows the "Operator actions" section of agent-director's README for the session the notice names; the server's check every 2 minutes, or `claude-slack-channel-bots clear-latch <persona>`, then ends the hold. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-held-tmux-session-conflict-notice).

**A persona posts a *Held: unusable tmux session name* notice**
The persona's row, `cscb_<key>`, records a tmux session name that can't be used (a hand edit of agent-director's store). A human follows the "Operator actions" section of agent-director's README; the hold clears once the row is gone. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-held-unusable-tmux-session-name-notice).

**A persona posts a *Held: launch start not recorded* notice**
The persona's row reads pending with no launch start (an older agent-director process or a hand edit). A human follows the "Operator actions" section of agent-director's README; the hold clears when the row reads running, ended or missing, or is gone. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-held-launch-start-not-recorded-notice).

**A persona posts a *Cannot launch* notice**
agent-director rejected the launch's flags (`ErrInvalidFlags`), so the installed agent-director may not match this release. A human checks it against the [Prerequisites](../README.md#prerequisites) and installs it as the docs/migration.md section "Switching over to agent-director Phase 1" describes; the hold ends when the binary changes or the server restarts. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-cannot-launch-notice).

**A persona posts a *Kill failed* or *Process outlived kill* notice**
*Kill failed*: the old worker may still run, and nothing is launched over it; a human looks with `agent-director read-pane --claude-instance-id <id>`, ends it with `agent-director kill --claude-instance-id <id>` and checks the result; on an error, don't delete or respawn. *Process outlived kill*: the persona comes back as usual; the process it names is for a human to check. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-kill-failed-or-process-outlived-kill-notice).

**A persona posts an *agent-director refuses its config file* notice**
A human fixes `~/.agent-director/config.toml` following agent-director's documentation; an *All clear.* notice naming `ad-config-malformed` confirms it. A working `agent-director version` proves nothing here. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-an-agent-director-refuses-its-config-file-notice).

**A persona posts an *Unclassified agent-director error* notice**
agent-director returned an error the server can't classify; the server keeps retrying. A human checks the host's agent-director and the persona's lines in `server.log`; the next retry recovers the persona once agent-director answers normally. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-an-unclassified-agent-director-error-notice).

**Session stuck during clean_restart**
A bot that doesn't exit within `exit_timeout` is force-killed; one that still can't be stopped fails the command (see "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" below). Rows are never deleted, so running `clean_restart` again is safe. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-stuck-during-clean_restart).

**`clean_restart` or `stop --stop-bots` exits non-zero with `nothing was stopped`**
The precheck failed, so the server and every bot keep running. Fix the cause each `precheck failed for persona` line names (see [Precheck before stopping bots](cli.md#precheck-before-stopping-bots)), then run the command again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-or-stop---stop-bots-exits-non-zero-with-nothing-was-stopped).

**`stop --stop-bots` exits non-zero with `only the server was stopped`**
The installed agent-director is below the client's own minimum, so only the server was stopped. Follow the docs/migration.md section "Switching over to agent-director Phase 1". [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-stop---stop-bots-exits-non-zero-with-only-the-server-was-stopped).

**`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`**
Each `could not stop persona` line names a persona, its session and the class of the failure. Fix the cause and run the command again; rows are never deleted. If `clean_restart` says the server was not started, start it with `claude-slack-channel-bots start` once `agent-director version` answers. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-or-stop---stop-bots-exits-non-zero-with-could-not-stop).

**Bots come back with no memory of the prior conversation after a reboot**
A bot starts a new conversation when its session no longer matches the applied configuration, when it was retired by a confirmed change, once after an upgrade, or after 2 resumes in a row that failed. Search `server.log` for `sweeping row`, `pre-persona row`, `replacing the row`, `not resuming; replacing its row`, `key is retired` or `not resuming its transcript again` to see which. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bots-come-back-with-no-memory-of-the-prior-conversation-after-a-reboot).

**Session crashes on resume with "sandbox required but unavailable"**
A regression in some Claude Code releases (for example v2.1.120). Set `resume_enabled: false` in `config.json`, confirm the change and restart the server; bots then always start a new conversation. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-crashes-on-resume-with-sandbox-required-but-unavailable).

---

## Server log rotation

The server daemon writes runtime output to `~/.config/cscb/server.log` (and `clean_restart.log` for the `clean_restart` subcommand). Rotation is built into CSCB, so it applies on every machine with no per-host logrotate config: when the active file crosses `CSCB_LOG_MAX_BYTES` it is rolled to `server.log.1`, the previous `.1` → `.2`, and so on up to `CSCB_LOG_KEEP` generations; the oldest is discarded. Rotated generations are not compressed. See the environment variables in [Configuration](server-settings.md#environment-variables) for the size, retention, and verbosity settings that tune this behavior.

`stop --stop-bots` and `clean_restart` append their bot-teardown lines to `server.log` while the server is stopped (see [What the command prints when a bot can't be stopped](cli.md#what-the-command-prints-when-a-bot-cant-be-stopped)); those lines take the same timestamped form and are rotated the same way.

Note this covers only `server.log` / `clean_restart.log`. `startup-errors.log` and `permission-trail.jsonl` are separate append-only files with their own retention (see below). The cron log is never rotated; `cron_log_max_bytes` caps it instead (see [The cron log](scheduled-prompts.md#the-cron-log)).

---

## Startup errors

CSCB writes startup errors to `~/.config/cscb/startup-errors.log` (under `SLACK_STATE_DIR` when it is set) and to stderr, one timestamped line each. The file is append-only and never rotated by CSCB; copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` for host-level rotation. A fatal class, such as a refused agent-director binary or `retired-keys-unreadable`, stops the process; the others are recorded and the start continues. [Every class, what it means and what to do](../skills/debug-slack-channel-bots/SKILL.md#startup-errors-startup-errorslog).
