# Troubleshooting

The `debug-slack-channel-bots` skill has an entry for every persona log class, every `config.json` rejection and each recovery step; run `/debug-slack-channel-bots` from Claude Code for a guided diagnosis. This page lists the common symptoms, then the server log and the startup-error log.

**A channel request or confirmation is refused** Check current intent and review the fresh preview before confirming again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-channel-request-or-confirmation-is-refused).

**A persona posts a *Configuration change not applied* notice** Fix storage, review the fresh preview and confirm afresh. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-configuration-change-not-applied-notice).

**Installation fails or launches stay pending** Check Bun, the global package trust, the supported host, and the worker's Claude Code version and launcher. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-installation-fails-or-launches-stay-pending).

**config.json not found** With no last-applied record, `start` exits with `missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>`. Run `bun src/postinstall.ts` from the installed package directory to create the skeleton, or create the file, and check that `SLACK_STATE_DIR` names the directory you populated. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-configjson-not-found).

**The server won't start: last-applied record error** `server.log` shows `[slack] Fatal: last-applied record error —`: the record can't be read or is invalid. For a removed-key message from a hand-written record that has never started, correct both baseline files as the [removed-keys entry](../skills/debug-slack-channel-bots/SKILL.md#removed-configuration-keys) says; reviewed repair is for an adopted authority. Otherwise preserve authority and prepared input; use [reviewed restore or explicit replacement](../skills/debug-slack-channel-bots/SKILL.md#reload-shared-recovery), including the refused-start preview. A repaired `thread_hybrid` choice starts with no Joined Threads. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-the-server-wont-start-last-applied-record-error).

**The server won't start: `reload-record-write-failed`** A definite failure applied nothing: make the directory holding `config.json` writable, not full and syncable, then start again. An unresolved write may be installed: preserve the authority and prepared input and restart to recover it, using reviewed repair only if that fails. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-the-server-wont-start-reload-record-write-failed).

**A start or pending review rejects a removed configuration key** A start or a pending review rejects a key from an earlier release's configuration. Edit `config.json` by hand, and before the first start after an upgrade also `config.json.last-applied`, using the replacement the [removed-keys entry](../skills/debug-slack-channel-bots/SKILL.md#removed-configuration-keys) gives and the [upgrade procedure](migration.md#upgrading-from-018x). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-start-or-pending-review-rejects-a-removed-configuration-key).

**A fix to config.json is ignored after a failed first start** Later starts use the recorded `port` and `bind`. Resolve an external cause such as a port conflict, then start; preserve configuration edits for normal review afterward. Damaged-state replacement cannot force an edit to a valid authority's listening setting. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-fix-to-configjson-is-ignored-after-a-failed-first-start).

**Session connects but has no persona** `server.log` shows `Session connected with CWD "<path>" — no matching persona`: the session's working directory is no persona's `working_directory`, compared by real path. A `Session refused: …` line instead means an old instance may still run in that directory (see "A persona waits on an old instance in its working directory"). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-connects-but-has-no-persona).

**A persona doesn't come up or doesn't answer** The persona is silent. Accepted messages remain queued while its instance is unavailable. Find its key on its `persona-start` line in `server.log` and read its lines: each names a class (such as `persona-credentials-invalid` or `persona-directory-missing`) and the file or directory to fix. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-doesnt-come-up-or-doesnt-answer).

**A persona seems silent after its `model` was set or changed** Correct the name (or remove `model`) in `config.json`, confirm the change, then run `claude-slack-channel-bots clean_restart <bot>` to start the persona fresh. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-seems-silent-after-its-model-was-set-or-changed).

**Acknowledgement reaction missing or stuck**
Check that both configured emoji exist in the workspace and the confirmed settings took effect at server start; use `message-delivered` to confirm delivery when Slack reaction calls fail. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-acknowledgement-reaction-missing-or-stuck).

**A Reaction Notice has no thread timestamp**
Check for `reaction-message-unknown` and restore Slack read access; an unthreaded message also omits `thread_ts`. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-reaction-notice-has-no-thread-timestamp).

**A reaction in a group DM brings no Reaction Notice**
Group DMs are never served, even when listed: look for `reaction-dropped` with `reason=unserved-conversation`, and remove a listed group DM from the persona's `channels`. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-reaction-in-a-group-dm-brings-no-reaction-notice).

**No Reaction Notices for reactions by people or other apps**
Check both reaction event subscriptions and reinstall the receiving persona's app with the manifest's scopes. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-no-reaction-notices-for-reactions-by-people-or-other-apps).

**A persona's instance waits at a startup prompt**
agent-director pre-trusts the working directory during launch. If any startup prompt still needs an answer, attach with `tmux attach -t =slack_bot_<key>` and answer it yourself; CSCB sends no automatic startup answers. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-personas-instance-waits-at-a-startup-prompt).

**A persona's instance is still starting**
Normal for a short time after every launch: the server waits it out and never launches a second instance over it. If it hasn't started in time, the persona posts a *Launch stuck* or *Session not starting* notice. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-personas-instance-is-still-starting).

**A persona doesn't receive messages in a channel or DM**
Check that its Slack app is invited to the channel, that the channel is listed in `channels` with the `delivery` you want (strict mode) or that its channel delivery there is the one you want (open mode), that the edit is confirmed, and for DMs that `dm.enabled` is `true`. A `thread_hybrid` channel delivers only the persona's @mentions and `@here` / `@channel` Broadcasts anywhere in it, plus replies in threads the bot is in ([Threads in `thread_hybrid` channels](channel-modes.md#threads-in-thread_hybrid-channels)). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-doesnt-receive-messages-in-a-channel-or-dm).

**A persona is silent in a channel it was invited to**
A newly verified join without a choice starts `off` in strict or `mentions` in open; duplicate joins preserve choices. Check a non-off applied choice, restrictions and [membership readiness](../skills/debug-slack-channel-bots/SKILL.md#membership-setup-record-and-readback): Slack's app join event after an invite (`member_joined_channel` subscription required), or startup catch-up, can verify membership; the invite request, listing, hearing a message or posting alone cannot. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-is-silent-in-a-channel-it-was-invited-to).

**Membership inventory or app setup is unresolved**
Read inventory completeness separately from current-app subscription/reinstall evidence, and fix app setup with [Update and reinstall an existing app](../skills/setup-slack-channel-bots/SKILL.md#update-and-reinstall-an-existing-app); restore the named access/storage cause and follow the bounded idle retry, keeping unprovable history held. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-membership-inventory-or-app-setup-is-unresolved).

**A persona receives every message in a channel**
In open mode its agent set its saved choice to `all` there (a `persona-channel-delivery-set` line): ask it to switch back to `mentions`, or remove its app. In either mode, the operator can set the desired `delivery` in `config.json` and confirm; if the file already shows it, [request an explicit assignment](reload.md#editing-the-configuration). A mode switch preserves the shared choice. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-receives-every-message-in-a-channel).

**A bot's channel delivery change has no result, or a pending or unresolved outcome**
Retry with the same `attempt_id`, channel and value and `intent: retry`, never a new identifier. A *pending* or *unresolved* outcome keeps its identifier until storage repair or reviewed repair settles it. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-bots-channel-delivery-change-has-no-result-or-a-pending-or-unresolved-outcome).

**File attachment fails after a long wait**
Each Slack request attempt, an upload included, is limited to 30 s, so an upload that needs longer fails only after about 30 minutes of retries. Send smaller files, or split a large attachment. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-file-attachment-fails-after-a-long-wait).

**Messages in a channel no persona is configured into are not delivered**
Each such message logs an `unclaimed-channel` line naming the channel, and in open mode the reason. Assign a non-off shared channel choice and confirm it; open mode also requires a public or private channel that is not externally shared. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-messages-in-a-channel-no-persona-is-configured-into-are-not-delivered).

**Permission relay not working**
Turn on the persona's app's interactivity, check the bot is in `check_permission` (on agent-director 0.16 and 0.17.0 an unanswered prompt shows as `needs_intelligence` once its timeout passes) with `agent-director list --state check_permission,needs_intelligence --label service=cscb`, and if `permission-poller:` lines warn of skipped ticks, raise `agent_director_poll_interval_ms` (it takes effect at the next server start). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-permission-relay-not-working).

**A permission prompt or notice doesn't arrive**
Slack refused a post to the persona's one `permission_prompts` destination, in either mode; a `persona-destination-failed` line names its error, and the prompts and notices are held and retried. For `missing_scope` add `im:write` and re-install the app; for `not_in_channel` invite the app to its destination channel. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-permission-prompt-or-notice-doesnt-arrive).

**Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning**
The bot is stuck on a Claude Code prompt that never reached Slack. A human reads it with `agent-director read-pane --instance-id <id>`, ends the session with `agent-director kill --instance-id <id>` and checks the result; on an error, don't delete or respawn, and never use `send-keys`. The server then brings the persona up again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bot-appears-dead--posts-a-blocked-on-a-native-claude-code-permission-prompt-warning).

**Session not restarting after crash**
Restarts back off from `session_restart_delay`, and after 5 failed launches in a row the persona posts `SpawnCapReached` and automatic restarts stop. Fix the cause, then restart the server (`claude-slack-channel-bots stop && claude-slack-channel-bots start`) to clear the limit. Accepted messages remain queued while the persona cannot receive them. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-not-restarting-after-crash).

**A persona is retried after agent-director refuses it**
The server retries the persona on its own (after 30, 60, 120 and 240 s, then every 300 s) and never counts it toward the restart limit. If agent-director reports its installation disappeared, the persona stays in an unknown state until agent-director reports its state again; no kill or relaunch follows from the outage alone. If it never clears, check that `agent-director version` answers and fix agent-director; no server restart is needed. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-is-retried-after-agent-director-refuses-it).

**A persona waits on an old instance in its working directory**
After a removal, rename or path change, or a start whose clean-up could not end an old instance, no persona comes up in that directory until the old instance has ended; the server keeps ending it. If its kill keeps failing, a human follows the "Operator actions" section of agent-director's README. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-waits-on-an-old-instance-in-its-working-directory).

**Bot alive but silently unresponsive (MCP disconnected)**
Accepted messages remain queued; a Slack message triggers the configured reconnect too. The health check reconnects or relaunches such a bot on its own, within about 3–5 minutes at the default settings. With `session_restart_delay` set to `0`, a *Not connected* notice reports it instead. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bot-alive-but-silently-unresponsive-mcp-disconnected).

**Reading the start summary**
Each start logs one `[slack] startupSessionManager: complete — …` line counting its personas by outcome. `latched`, `retrying`, `waiting on a live-row sequence`, `held on invalid flags` and `fresh as retired keys` are not failures. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-reading-the-start-summary).

**Delivery notices or delivery diagnostic lines**
For *Message not saved*, check the server disk; for a [`queue-unwritable`](../skills/debug-slack-channel-bots/SKILL.md#queue-unwritable) line, fix the disk and the queued work resumes without a resend. For *Delivery stuck* or *Message not taken in*, follow the notice's remedy; for *Messages waiting*, resolve the persona's state; for *Queue record unreadable*, preserve its file and ask the senders to resend. Accepted messages stay queued in order, including when [`message-partial-receipt`](../skills/debug-slack-channel-bots/SKILL.md#message-partial-receipt) reports cut-off text. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-delivery-notices-or-delivery-diagnostic-lines).

**A persona on a Mac keeps retyping a long message**
On a macOS host CSCB types a long message in parts of at most about 880 bytes each. A message queued before an upgrade can keep larger parts, and a restart does not split it again: CSCB keeps offering it until the bot takes it in, while later messages wait. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-on-a-mac-keeps-retyping-a-long-message).

**A persona posts a *Thread Memory not saved* notice**
Check the named path's disk, mount and permissions; saving retries on its own and nothing needs resending. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-thread-memory-not-saved-notice).

**A persona posts a *Thread Memory unreadable* notice**
Restore the journal's permissions or storage, or, to start its Thread Memory empty, stop CSCB, move the journal aside and start again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-thread-memory-unreadable-notice).

**A persona posts a *Joins lost* notice**
A new @mention in a thread puts the bot back in it; send each listed message again if it was meant for the bot. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-joins-lost-notice).

**A persona posts a *Thread Memory changed while stopped* notice**
Check the threads the bot should be in; a new @mention puts it back in one. Never delete Thread Memory files to clear it. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-thread-memory-changed-while-stopped-notice).

**A persona posts a *Thread Memory recovered* notice**
No action is needed. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-thread-memory-recovered-notice).

**A Thread Memory line in server.log with no notice**
For storage-failure lines, check the named file's disk, mount and permissions and leave the file in place. The healthy `thread-memory-compaction-recovered`, `thread-memory-seal-saved` and `thread-memory-holds-resolved` lines need no repair. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-thread-memory-line-in-serverlog-with-no-notice).

**A persona posts a *Channel state unresolved* notice**
Follow the named cause's storage or repair step; affected messages stay held, and any message Slack stopped retrying must be sent again. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-channel-state-unresolved-notice).

**A persona posts a *Channel membership evidence unresolved* notice**
Only reviewed recovery settles a history gap; for a scan problem, make the named repair. Send again any message Slack stopped retrying. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-channel-membership-evidence-unresolved-notice).

**A persona posts a *Channel state recovered* notice**
No further repair is needed; send again any message Slack stopped retrying meanwhile. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-channel-state-recovered-notice).

**A persona posts a *Waiting on a prompt* or *Not connected* notice**
The session runs but is disconnected; accepted messages are kept until it reconnects. A human attaches with `tmux attach -t =slack_bot_<key>`, deals with anything on screen and, if it stays disconnected, types `/mcp reconnect slack-channel-router`, or restarts the server. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-waiting-on-a-prompt-or-not-connected-notice).

**A persona posts a *Not answering*, *Still not answering* or *Answering again* notice**
agent-director or tmux is not answering for this persona's session; the server keeps retrying and posts *Answering again* when it recovers. After *Still not answering*, a human checks tmux and agent-director with read-only commands only. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-not-answering-still-not-answering-or-answering-again-notice).

**A persona posts a *Slow recovery* notice**
agent-director has not yet marked the gone session's row ended or missing; the server relaunches the persona once it does. Nothing is needed unless it persists; then read the row with `agent-director get --instance-id cscb_<key>`. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-slow-recovery-notice).

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
*Kill failed*: the old worker may still run, and nothing is launched over it; a human looks with `agent-director read-pane --instance-id <id>`, ends it with `agent-director kill --instance-id <id>` and checks the result; on an error, don't delete or respawn. *Process outlived kill*: the persona comes back as usual; the process it names is for a human to check. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-a-kill-failed-or-process-outlived-kill-notice).

**A persona posts an *agent-director refuses its config file* notice**
A human fixes `~/.config/agent-director/config.toml` following agent-director's documentation; an *All clear.* notice naming `ad-config-malformed` confirms it. A working `agent-director version` proves nothing here. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-an-agent-director-refuses-its-config-file-notice).

**A persona posts an *Unclassified agent-director error* notice**
agent-director returned an error the server can't classify; the server keeps retrying. A human checks the host's agent-director and the persona's lines in `server.log`; the next retry recovers the persona once agent-director answers normally. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-a-persona-posts-an-unclassified-agent-director-error-notice).

**Session stuck during clean_restart**
A bot that doesn't exit within `exit_timeout` is force-killed (under `clean_restart <bot>…`, a bot whose pause succeeds is never force-killed, and only a refused pause leads to the force-kill); one that still can't be stopped fails the command (see "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" below). Rows are never deleted, so running `clean_restart` again is safe. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-stuck-during-clean_restart).

**`clean_restart` or `stop --stop-bots` exits non-zero with `nothing was stopped`**
The precheck failed, so the server and every bot keep running. Fix the cause each `precheck failed for persona` line names (see [Precheck before stopping bots](cli.md#precheck-before-stopping-bots)), then run the command again. For `clean_restart <bot>…`, a line naming an argument, no running server or `session_restart_delay is 0` is a refusal, not a precheck failure; it says what to run instead. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-or-stop---stop-bots-exits-non-zero-with-nothing-was-stopped).

**`clean_restart` exits 2 with `Usage:`**
It needs `--server` (the server and every bot) or the names of the bots to restart; a bare `clean_restart` stops nothing. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-exits-2-with-usage).

**The server and every bot are down after `clean_restart --server` run from a bot**
The command ended with the bot's session before it started the server. Start it from a terminal with `claude-slack-channel-bots start`; from a bot, name only other bots. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-the-server-and-every-bot-are-down-after-clean_restart---server-run-from-a-bot).

**`clean_restart <bot>…` says a bot was `not seen relaunched`**
The bot was stopped, and the server relaunches it on its own schedule; its `server.log` lines say when or why not. If `session_restart_delay` was changed from `0` since the server started, the server won't relaunch it: restart the server (`clean_restart --server` from a terminal). [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-bot-says-a-bot-was-not-seen-relaunched).

**`stop --stop-bots` exits non-zero with `only the server was stopped`**
The installed agent-director is below the client's own minimum, so only the server was stopped. Follow the docs/migration.md section "Switching over to agent-director Phase 1". [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-stop---stop-bots-exits-non-zero-with-only-the-server-was-stopped).

**`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`**
Each `could not stop persona` line names a persona, its session and the class of the failure. Fix the cause and run the command again; rows are never deleted. If `clean_restart --server` says the server was not started, start it with `claude-slack-channel-bots start` once `agent-director version` answers. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-clean_restart-or-stop---stop-bots-exits-non-zero-with-could-not-stop).

**Bots come back with no memory of the prior conversation after a reboot**
A bot starts a new conversation when its session no longer matches the applied configuration, when it was retired by a confirmed change, once after an upgrade, or after 2 resumes in a row that failed. A persona whose `model` or `effort` differs from what its conversation started with starts a new conversation on the same instance at its next launch; this includes setting either key over a conversation from an earlier release. Nothing is deleted. Search `server.log` for `sweeping row`, `pre-persona row`, `replacing the row`, `not resuming; replacing its row`, `key is retired`, `from what its conversation started with` or `not resuming its transcript again` to see which. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-bots-come-back-with-no-memory-of-the-prior-conversation-after-a-reboot).

**Session crashes on resume with "sandbox required but unavailable"**
A regression in some Claude Code releases (for example v2.1.120). Set `resume_enabled: false` in `config.json`, confirm the change and restart the server; bots then always start a new conversation. [Full entry](../skills/debug-slack-channel-bots/SKILL.md#symptom-session-crashes-on-resume-with-sandbox-required-but-unavailable).

---

## Server log rotation

The server daemon writes runtime output to `~/.config/claude-slack-channel-bots/server.log` (and `clean_restart.log` for the `clean_restart` subcommand). Rotation is built into CSCB, so it applies on every machine with no per-host logrotate config: when the active file crosses `CSCB_LOG_MAX_BYTES` it is rolled to `server.log.1`, the previous `.1` → `.2`, and so on up to `CSCB_LOG_KEEP` generations; the oldest is discarded. Rotated generations are not compressed. See the environment variables in [Configuration](server-settings.md#environment-variables) for the size, retention, and verbosity settings that tune this behavior.

`stop --stop-bots` and `clean_restart` append their bot-teardown lines to `server.log`, while the server is stopped or, for `clean_restart <bot>…`, while it runs (see [What the command prints when a bot can't be stopped](cli.md#what-the-command-prints-when-a-bot-cant-be-stopped)); those lines take the same timestamped form and are rotated the same way.

Note this covers only `server.log` / `clean_restart.log`. `startup-errors.log` and `permission-trail.jsonl` are separate append-only files with their own retention (see below). The cron log is never rotated; `cron_log_max_bytes` caps it instead (see [The cron log](scheduled-prompts.md#the-cron-log)).

---

## Startup errors

Ordinary older agent-director releases and 0.12.0 release candidates are refused as `ad-system-install-too-old`. The unsupported development placeholder `0.0.0-dev` reaches CSCB's own guard and is refused as `ad-below-phase1-floor`. [Full entries](../skills/debug-slack-channel-bots/SKILL.md#ad-below-phase1-floor).

CSCB writes startup errors to `~/.config/claude-slack-channel-bots/startup-errors.log` (under `SLACK_STATE_DIR` when it is set) and to stderr, one timestamped line each. The file is append-only and never rotated by CSCB; copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` for host-level rotation. A fatal class, such as a refused agent-director binary or `retired-keys-unreadable`, stops the process; the others are recorded and the start continues. A refused state-directory move at the first start after an upgrade is the exception to where the file is: it is logged in the directory the CLI uses before the move, normally the old one (see [The state directory's location and its move at start](../skills/debug-slack-channel-bots/SKILL.md#the-state-directorys-location-and-its-move-at-start)). [Every class, what it means and what to do](../skills/debug-slack-channel-bots/SKILL.md#startup-errors-startup-errorslog).
