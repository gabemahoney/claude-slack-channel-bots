# Changelog

Release notes for `claude-slack-channel-bots`. The version number and date of each release are set when it is published.

---

## Unreleased (next major version)

This release replaces the single-bot setup with **personas**, and runs them on agent-director Phase 1. It is a breaking release: an existing install is converted by hand and switched over together with agent-director, by the runbook at the end of this entry, before the server starts again.

### Requires agent-director Phase 1

- **This release requires agent-director Phase 1 or later.** The server exits at startup on an older agent-director binary, with `ad-below-phase1-floor` or `ad-system-install-too-old` (see [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal)).
- **No older CSCB may run on the Phase 1 binary.** This release and agent-director Phase 1 are installed together, by [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1), and rolled back together, by [Rolling back the switch-over](#rolling-back-the-switch-over).
- **Every agent on the host, with every long-running agent-director process, is stopped before either binary change and started again after it.** That holds for the Phase 1 install and for the rollback's restore of the previous binary.
- **CSCB changes no agent-director code.** It works with agent-director Phase 1 as agent-director ships it. See [Prerequisites](README.md#prerequisites).
- **Row deletion moves out of `agent-director`.** agent-director 0.11.0, its Phase 1 release, moves deleting a row and ending a finished row's session into its separate `agent-director-admin` binary. CSCB uses neither: it never deletes a row and never asks agent-director to act on a finished row. Where a case needs more than a checked `agent-director kill`, CSCB's notices point a human to the "Operator actions" section of agent-director's README. See [Destructive changes](README.md#destructive-changes).

### What's new

- **One server, several personas.** Each persona is its own Slack app with its own name and avatar, runs its own Claude instance in its own working directory, and serves the channels it lists. See [Personas (config.json)](README.md#personas-configjson).
- **Per-channel delivery.** Each channel entry says whether the persona gets every message or only @mentions and broadcasts. Several personas can share a channel. See [Channel delivery](README.md#channel-delivery) and [How a persona receives messages](README.md#how-a-persona-receives-messages).
- **Direct messages per persona.** A persona's DMs switch lets anyone in the workspace DM that persona's app, and lets it start a DM itself. Permission prompts and notices can go to a named contact by DM. See [Direct messages](README.md#direct-messages-dmenabled) and [Permission prompts](README.md#permission-prompts).
- **Credentials files.** Each persona's tokens live in its own file. The setup wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command), `claude-slack-channel-bots credentials <persona>`, writes it from your own terminal without echoing the tokens, once both pass a check with Slack. See [Credentials files](README.md#credentials-files) and [`claude-slack-channel-bots credentials`](README.md#claude-slack-channel-bots-credentials).
- **Confirmed configuration changes.** Edits to `config.json` or a credentials file on a running server wait as a pending change with a preview, and apply only when you confirm them. Only the affected personas are torn down or reconnected. The preview warns when a persona couldn't come up: an added one, or one whose changed `claude_config_dir` can't be resolved. See [Reload](README.md#reload).
- **A broken persona doesn't stop the others.** A persona that can't come up (a missing working directory, a bad credentials file, a Slack app that can't connect) stays down on its own while the others serve, and nothing about it is posted to Slack. `server.log` names the cause; a persona that can't reach Slack logs the failure's message there, with URLs and tokens redacted. See [Troubleshooting](README.md#troubleshooting) and the `debug-slack-channel-bots` skill.
- **Scheduled prompts and `/interject` target personas** by name or key. See [Scheduled Prompts](README.md#scheduled-prompts-cscb_cron) and [Interject](README.md#interject).
- **`clear-latch` ends one persona's hold by hand.** `claude-slack-channel-bots clear-latch <persona>` ends a *Held: tmux session conflict*, *Held: unusable tmux session name* or *Held: launch start not recorded* hold on the running server, once a human has resolved its cause, with no restart. Ending a hold also clears that persona's restart limit, so a held persona that had reached the limit is brought up too. It reaches the server at `127.0.0.1`, so it needs a `bind` of `127.0.0.1` (the default) or `0.0.0.0`; on any other `bind` a hold ends only by the server's own check, by the persona's teardown or by a server restart. See [`claude-slack-channel-bots clear-latch`](README.md#claude-slack-channel-bots-clear-latch).
- **A clear by hand answers once it has run.** The clear runs as one piece of work for the persona, in turn with the server's other work for it: it waits behind a check of the persona's hold that is already running, and `clear-latch` answers `cleared` or `was not latched` only once the clear has run. When no answer comes within 30 s, it says the clear is queued and may still run; look for the persona's clear line in `server.log` before trying again. See [`claude-slack-channel-bots clear-latch`](README.md#claude-slack-channel-bots-clear-latch).
- **`server.port` beside `server.pid`.** The server records its process ID and the port it listens on in `server.port` once it is listening, and removes it on shutdown; `stop` removes it with the PID file, and `clear-latch` uses it to find the server. See [PID file](README.md#pid-file).
- **`agent_director_call_timeout_ms`.** A new server-wide setting (default `60000`) bounds each agent-director call CSCB makes, in the server and in `stop --stop-bots` and `clean_restart`. Once per start, `server.log` gets one warning line when it is at or below its need, computed from agent-director's timing settings; the server still starts. See [Sizing the agent-director call timeout](README.md#sizing-the-agent-director-call-timeout).
- **agent-director's timing settings are read, never set.** The server reads the nine `[tmux]` settings of `~/.agent-director/config.toml` with agent-director's own rule when it starts and every 120 s after that, and uses them for its own waits and alert thresholds; agent-director's own answers always decide. `server.log` gets one line with the nine values in effect at the first accepted read and whenever a read changes them. See [agent-director's timing settings](README.md#agent-directors-timing-settings).
- **The retired-key record.** `retired-keys.json`, beside `config.json`, holds the keys of retired personas, so a persona removed and added back later starts fresh. A record that can't be read stops the start with `retired-keys-unreadable`. See [Files beside the config file](README.md#files-beside-the-config-file) and [Startup errors](README.md#startup-errors).

### Breaking changes

- **Configuration is a list of personas.** A configuration from an earlier version is rejected at start, with an error naming the offending setting. Nothing is converted automatically. Write the persona configuration by hand as the staged file, which switch-over step 7 puts in place as `config.json`, as [Upgrading to personas](README.md#upgrading-to-personas) describes; see [Personas (config.json)](README.md#personas-configjson) for its format.
- **No persona's key may start with another persona's key.** A configuration with such a pair, such as `dev` and `dev_2` or `horde` and `horde_admin`, is rejected: it stops a first start, and on a running server it is an `INVALID` pending change. The error names both personas and suggests a new name for the one with the shorter key, such as `horde_main`. The reason: tmux matches a session target by prefix unless it is written with `=`, so a human's tmux command without `=` for one persona (for example `tmux attach -t slack_bot_dev`) could reach another persona's session. If you name the personas after the channels your bots served, check the names for such pairs. See [Persona name and key](README.md#persona-name-and-key).
- **Tokens come only from credentials files.** Slack tokens are no longer read from environment variables. Create one credentials file per persona with the wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command) (`claude-slack-channel-bots credentials <persona>`). Switch-over step 1 keeps a copy of the Slack token environment variables the old CSCB uses, for rollback; remove them from the host's environment only after that, as [Upgrading to personas](README.md#upgrading-to-personas) says.
- **One Slack app per persona.** An existing app can serve one persona; create another app for each additional persona. Re-install the existing app from the current `slack-app-manifest.yml` so it gains the `im:write` scope.
- **The access-control file is retired.** Who can reach a persona is decided only by its `channels`, each channel's `delivery` and its `dm.enabled` switch. The allowlist and pairing flow are gone, and the server never reads the file. Keep `access.json` until rollback is no longer wanted, because the previous CSCB reads it. Set the acknowledgement reaction and reply splitting in `config.json` instead (see [Server-wide settings](README.md#server-wide-settings)).
- **Crontable lines that name channels no longer match.** Such a target matches no persona and is logged `unknown-persona` each time it fires. Rewrite each target as a persona's name or key.
- **Each bot starts fresh once.** Bot instances created before the upgrade are never resumed, so each persona starts once without its prior conversation. Their agent-director rows are kept, never deleted. The switch-over runbook stops the old bots and ends their leftover sessions before the new CSCB first starts (see [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1)); a start that still finds one running ends it with a checked kill and keeps its row.
- **`/interject` requests name a persona.** A request must carry `persona` (a persona's name or key). A body that names only a `channel` is refused with 400. A successful response is `{ "ok": true, "persona": "<name>" }`; it no longer holds `channel` or `cwd`. Update every script that calls `/interject`, including host crontab `curl` lines, to send `persona`. See [Interject](README.md#interject).

### Behaviour changes you will notice

- **Bot, integration and webhook posts are delivered.** The previous version dropped posts from bots and integrations (Slack's `bot_message` posts and posts with no user). They now reach a persona like any other message; a persona ignores only its own posts. A persona with `delivery: all` in an alerting channel wakes on every alert. Use `delivery: mentions` for such a channel if that is not what you want. See [How a persona receives messages](README.md#how-a-persona-receives-messages).
- **`@here` and `@channel` wake mention-only personas.** A persona with `delivery: mentions` receives broadcasts as well as its own @mentions. `@everyone` and user-group mentions still don't count. See [Channel delivery](README.md#channel-delivery).
- **Lost messages are reported at the persona's destination.** A message that arrives while a persona's instance can't take it is still lost. The previous version replied in the conversation the message came from; now the persona posts one lost-message notice to its destination (its `permission_prompts` channel, or a DM with its contact), and nothing is posted where the message was sent. See [Troubleshooting](README.md#troubleshooting).
- **A lost-message notice names more recovery states.** Besides the earlier ones, it can report `held for a human`, `cannot launch`, `kill failed`, `not answering` and `starting`; none of them starts a restart. `auto-restart disabled` now says that a persona the server is already retrying comes back when a retry succeeds, and that otherwise a server restart recovers it. See the recovery-state table under "Session not restarting after crash" in [Troubleshooting](README.md#troubleshooting).
- **A bot killed mid-turn comes back on its own.** The previous version waited for such a bot's turn to settle, which never happened once its tmux session was gone. The server now finds the session gone through agent-director's `read-pane`, which answers that no pane of the bot's launch is there, and relaunches the persona, keeping its conversation, once agent-director has marked its row ended or missing. If agent-director is slow to mark the row, the server asks it to reconcile the row at each health check and posts one *Slow recovery* notice after the third check in a row that still finds the row live. A standalone `find-missing` sweep is no longer needed for this. The same goes for a bot that dies with a permission prompt or question open: agent-director keeps reporting it as waiting on the prompt, but the server checks the session through agent-director and relaunches it, at a start too, without posting *Waiting on a prompt*. See "Bot alive but silently unresponsive (MCP disconnected)" and "A persona posts a *Slow recovery* notice" in [Troubleshooting](README.md#troubleshooting).
- **A persona stuck on a stale `working` state reconnects.** agent-director can keep reporting a persona as `working` after its turn has ended. The previous version trusted that: a start waited 10 minutes for the turn to end, and the health check put off its reconnect for as long as the state said `working`, so the persona could stay disconnected until the server was restarted. The server now reads the persona's terminal and its conversation transcript. When for a minute the screen has stayed the same, with no busy spinner, API retry message or prompt, and the transcript has ended with a finished reply and not changed, the persona is reconnected, at a start and by the health check. A running turn, a stalled API retry included, is still never interrupted. See [Troubleshooting](README.md#troubleshooting).
- **Prompts are never typed into, and a persona that can't receive messages is reported.** The previous version could type its reconnect into a session waiting on a question or permission dialog, or, when agent-director couldn't report the session's state, into whatever the session showed. With `session_restart_delay` set to `0` it left a running but unreachable persona down silently. The health check's reconnect now types nothing in those cases. Three notices now say what is wrong and what to do; at most one of them is posted to the persona's destination until it is reachable again: *Waiting on a prompt*, *Not connected* and *Not receiving messages*. See [Troubleshooting](README.md#troubleshooting).
- **A persona whose instance died just before its reconnect comes back at once.** When agent-director found a persona's instance gone in the moment between the server reading its state and typing its reconnect (after a reboot, for example, when several personas start together), the previous version posted a spawn-failure notice and left the persona down until its next restart attempt, so messages sent to it meanwhile were lost. The server now relaunches it straight away, at a start and in the health check. The health check also no longer posts a spawn-failure notice for an instance that is still starting.
- **One stuck persona no longer delays the others at start.** The previous version's start waited up to 10 minutes for a persona whose instance was mid-turn, holding a launch slot and holding back the health check and the check for pending changes for every persona. That launch now goes on in the background, and the start summary line has a `not reconnected` count. See "Reading the start summary" in [Troubleshooting](README.md#troubleshooting).
- **Persona sessions run with Claude Code's prompt suggestions off.** Every persona's Claude now launches with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. At the end of each turn, Claude Code writes a suggested next prompt in the background, and that background work is the likely cause of agent-director reporting an idle persona as `working`, which holds back its reconnect until the server can prove it idle. When you attach to a persona's tmux session (`tmux attach -t =slack_bot_<key>`), its input box shows no suggested prompt.

### Working through agent-director

- **The server reaches a session only through agent-director.** It starts no tmux process, deletes no agent-director row and never asks agent-director to act on finished rows. See [Destructive changes](README.md#destructive-changes).
- **The startup version gate.** At start the server refuses an agent-director binary below the client's own minimum (`ad-system-install-too-old`) or below CSCB's Phase 1 floor (`ad-below-phase1-floor`); it launches, kills and deletes nothing, and both classes point to the switch-over runbook's [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal). See [Startup errors](README.md#startup-errors).
- **The 120 s runtime re-check.** While it runs, the server re-checks the agent-director binary every 120 s, whatever `health_check_interval` is, and stops on a binary that fails either check, leaving every bot running and posting nothing. That stop is not a switch-over case: its startup-errors entry names the debugging skill, which gives its own remedy under [Found while the server was running](skills/debug-slack-channel-bots/SKILL.md#found-while-the-server-was-running). A human checks the agent-director binary the server finds, then either puts agent-director Phase 1 back as that binary, with every agent on the host stopped before that binary change and started again after it, or rolls the host back by [Rolling back the switch-over](#rolling-back-the-switch-over); the old CSCB is never reinstalled onto the migrated store.
- **Install and startup texts point to the runbook.** The install check, the startup gate's agent-director messages, `/publish`'s agent-director check and the install skill no longer give their own advice for changing the host's agent-director or removing a file. They name the README section "Switching over to agent-director Phase 1", and for a host with no agent-director, or one below the agent-director client's minimum, its block [The publishing host](#the-publishing-host), except the startup gate's not-found refusal: it runs on a bot host, where the binary may only be missing from the bot server's launcher HOME or PATH, so it names the section's [step 1](#step-1-check-the-host-and-stage-the-release), whose check of agent-director's version as the workers' user in the bot server's launcher environment shows whether the launcher's HOME or PATH differs from the workers'; for the agent-director npm package they say to check the package installed with CSCB. A startup refusal leads to [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal) instead of "start the server again".
- **The install check and `/publish` pass a pre-Phase-1 binary with a note.** `bun run install-check` and `/publish`'s preflight pass a binary the agent-director client accepts that is below CSCB's Phase 1 floor, with a note pointing to the switch-over runbook; the server still refuses it at start. See [Checking your agent-director install](README.md#checking-your-agent-director-install) and [The publishing host](#the-publishing-host).
- **The startup prompt is answered through agent-director.** After each launch the server watches the instance through agent-director while it starts and presses Enter only on Claude Code's folder-trust or development-channels prompt; it runs no tmux command for this. `server.log` records agent-director's own folder-trust report (`pre_trust`) for each launch. See "A persona's instance waits at a startup prompt" in [Troubleshooting](README.md#troubleshooting).
- **A persona agent-director refuses is retried on its own.** When agent-director is unreachable or can't act right now, the server retries that persona at 30 s, then 60, 120 and 240 s more, then every 300 s, even with `session_restart_delay` and `health_check_interval` at `0`; a refusal never counts toward the restart limit, and a failed read of a persona's state is never taken as a dead worker. A launch that met a live row of the persona is retried the same way, and its log lines name the retry's cause `collision`. See "A persona is retried after agent-director refuses it" in [Troubleshooting](README.md#troubleshooting).
- **`agent-director` or tmux not answering for a persona is reported.** Its destination can get *Not answering*, *Still not answering* and *Answering again*, at most once each per episode. See "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice" in [Troubleshooting](README.md#troubleshooting).
- **tmux unavailable, or a re-bound tmux socket, is reported.** A persona for which agent-director can't use tmux gets *tmux unavailable*, or *tmux server changed* when its socket now reaches a different tmux server; the persona is retried on its own and nothing is killed or relaunched because of it. See "A persona posts a *tmux unavailable* or *tmux server changed* notice" in [Troubleshooting](README.md#troubleshooting).
- **Slack notices give only a human's agent-director steps.** Every notice that names a command, or points to the "Operator actions" section of agent-director's README, says it is for a human only: no bot acts on it, including a persona that sees the post. The previous version's permission wedge warning told a human to kill the session through tmux and respawn it; it now names only `agent-director read-pane` and `agent-director kill`, whose result the human checks, after which the server brings the persona up again on its own. The *agent-director unreachable* notice now points to the README section "Switching over to agent-director Phase 1" instead of a reinstall. See "Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning" in [Troubleshooting](README.md#troubleshooting).
- **agent-director refusing its config file is an outage, not a failure.** Each persona it refuses gets one *agent-director refuses its config file* notice, and *All clear.* naming `ad-config-malformed` once a call for it reads agent-director's store again. See "A persona posts an *agent-director refuses its config file* notice" in [Troubleshooting](README.md#troubleshooting).
- **An error the server can't classify is retried, not counted.** After it has lasted past the alert threshold the persona's destination gets one *Unclassified agent-director error* notice per episode. See "A persona posts an *Unclassified agent-director error* notice" in [Troubleshooting](README.md#troubleshooting).
- **A persona is held for a human.** A tmux session conflict, conflicting labels on the persona's own row, an unusable recorded session name or a `pending` row with no launch start holds the persona, with one *Held: tmux session conflict*, *Held: unusable tmux session name* or *Held: launch start not recorded* notice pointing to the "Operator actions" section of agent-director's README; the server attempts nothing else for it while it is held. The *Held: tmux session conflict* notice's read-only `agent-director list` command quotes the session name for the shell, and when the name cannot be shown safely the notice leaves that line out and says so. See "A persona posts a *Held: tmux session conflict* notice" in [Troubleshooting](README.md#troubleshooting).
- **Every kill's result is checked.** A kill agent-director can't carry out right now is tried up to 3 times, 2 s apart, and nothing is launched over a worker that may still run. A failed kill posts one *Kill failed* notice per episode, and a process that outlived a kill one *Process outlived kill* notice. For a persona no longer in the configuration, or an old instance a persona waits on, nothing is posted: the server writes the notice's text to `server.log` and `startup-errors.log` as a `persona-kill-failed` or `persona-kill-survivor` entry. See "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](README.md#troubleshooting) and [Startup errors](README.md#startup-errors); the `debug-slack-channel-bots` skill checks whether a session of the persona is there with the one-line `read-pane` check under [Listing instances](skills/debug-slack-channel-bots/SKILL.md#listing-instances), with its caveats.
- **An old running instance is replaced step by step.** When a persona must start a new conversation over an old instance that still runs, the server ends it with a checked kill, confirms it has ended, and only then brings the persona up on a new conversation on the same instance. See "Bots come back with no memory of the prior conversation after a reboot" in [Troubleshooting](README.md#troubleshooting).
- **A fresh start reuses the persona's instance.** A persona that starts a new conversation does so on the same agent-director instance, its old conversation kept as an earlier life; no row is deleted to make room for it, and the conversation-memory warnings say the bot was brought up fresh by a reuse spawn of the same instance. See [What a confirmation applies](README.md#what-a-confirmation-applies) and [Startup errors](README.md#startup-errors).
- **A launch with rejected flags holds the persona.** When agent-director rejects the flags of a persona's launch (`ErrInvalidFlags`), the persona is held with one *Cannot launch* notice until the agent-director binary changes, the persona is removed or changed destructively, or the server restarts. See "A persona posts a *Cannot launch* notice" in [Troubleshooting](README.md#troubleshooting).
- **Only proof that a session is gone ends a session agent-director still reads as running.** A refused reconnect, a finished row or a missing row never leads the server to end or replace a running instance. See "Bot alive but silently unresponsive (MCP disconnected)" in [Troubleshooting](README.md#troubleshooting).

### Retired personas, launches and holds

- **A retired persona is never resumed.** A persona that is removed, renamed, or whose `name`, `credentials_file` or `working_directory` changes is retired: its session is ended with a checked kill, its row is kept until agent-director's `expire` removes it, and it is never resumed. A persona added back with the same key starts fresh on the same instance. See [Destructive changes](README.md#destructive-changes).
- **The start sweep keeps every row.** A server start's clean-up of old instances checks each kill and keeps every row, records the key of each persona it finds that is not in the applied configuration as retired, and holds a persona whose own listed row shows a conflict, ending none of its instances. See "Bots come back with no memory of the prior conversation after a reboot" in [Troubleshooting](README.md#troubleshooting) and `orphan-cleanup` under [Startup errors](README.md#startup-errors).
- **Five new counts in the start summary.** The summary line now ends with `latched`, `retrying`, `waiting on a live-row sequence`, `held on invalid flags` and `fresh as retired keys`; none of them is a failure. See "Reading the start summary" in [Troubleshooting](README.md#troubleshooting).
- **An old instance holds its working directory.** While an old instance that may still be running (a renamed, removed or destructively changed persona's, or a stale one a start could not end) is there, no session from its working directory registers, nothing is typed into it, and a persona there comes up once it has ended. See "A persona waits on an old instance in its working directory" in [Troubleshooting](README.md#troubleshooting).
- **A launch that timed out or is still starting is left alone.** It is never launched over, killed or counted toward the restart limit; after a timed-out launch the startup prompt is still answered. An old or mismatched instance still starting is never typed into: it is replaced by the step-by-step sequence once agent-director's grace period has passed. See "A persona's instance is still starting" in [Troubleshooting](README.md#troubleshooting).
- **A stuck launch is reported once.** From agent-director's grace period the server checks a launch whose session has not started; at the later of 5 minutes and `pending_grace_seconds` plus 60 s it posts *Launch stuck* for its own launch, which it ends and launches again once, keeping a resumed conversation, or *Session not starting*, with a human's remedies, for any other launch, a failed fresh launch included, which it never ends. No post calls an instance-id collision a bug. See "A persona posts a *Launch stuck* or *Session not starting* notice" in [Troubleshooting](README.md#troubleshooting).
- **A held persona is checked every 2 minutes.** The server's own check reads the persona's row once and makes at most one more call, whatever `health_check_interval` is, and ends the hold on its own once its cause is gone, with one *Conflict cleared* or *Hold cleared* notice. See "How a hold ends" under "A persona posts a *Held: tmux session conflict* notice" in [Troubleshooting](README.md#troubleshooting).

### Stopping and restarting the bots

- **A precheck runs before anything is stopped.** `stop --stop-bots` and `clean_restart` first check that agent-director answers and that each persona's instance can be read; on a failure nothing is stopped and the command exits 1. See [Precheck before stopping bots](README.md#precheck-before-stopping-bots).
- **`stop --stop-bots` works on an older agent-director.** On a binary the agent-director client accepts but below CSCB's Phase 1 floor it works as usual; on one below the client's own minimum only the server is stopped, and every bot is left as it is. See [`claude-slack-channel-bots stop`](README.md#claude-slack-channel-bots-stop).
- **The CLI teardown fails loudly by class.** It decides each pause and kill error by its class, never deletes a row or asks agent-director to act on finished rows, and prints one line per persona it could not stop, also written to `server.log` and `startup-errors.log` as `cli-teardown-failed`, `persona-kill-failed` or `persona-kill-survivor`. See [What the command prints when a bot can't be stopped](README.md#what-the-command-prints-when-a-bot-cant-be-stopped).
- **`stop --stop-bots` never restarts, and `clean_restart` never leaves the fleet down while agent-director answers.** After a failed teardown `clean_restart` starts the server when agent-director answers its check, and otherwise leaves it stopped and records `clean-restart-not-restarted`. See [When `clean_restart` can't stop a bot](README.md#when-clean_restart-cant-stop-a-bot).

### Switching over to agent-director Phase 1

The README section [Switching over to agent-director Phase 1](README.md#switching-over-to-agent-director-phase-1) is the maintained copy of this runbook; this copy carries the same steps and words.

This release requires agent-director Phase 1, installed on the host together with it; CSCB changes no agent-director code. The two are installed together, by this runbook, and [rolled back together, by "Rolling back the switch-over"](#rolling-back-the-switch-over).

- Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before either binary change and started again after it.
- The old CSCB never runs against Phase 1, and the new one never against 0.10.0: no bot server runs between step 3 and step 10, and no side-by-side install under another path is used.
- The switch-over log is your own record, kept wherever you choose until rollback is no longer wanted. Each step says what to record in it.
- Run every command as the workers' user (the user the bot server launches workers as), in the tmux environment step 1 pins.
- Steps marked "operator action" are done by a human on the host; nothing in CSCB does them.

#### Arrived here from a startup refusal?

Your new CSCB is installed and its server refused to start with `ad-below-phase1-floor` or `ad-system-install-too-old`. The refusal launched, killed and deleted nothing, and left your bots as they were.

This block covers only a refusal before agent-director Phase 1 is installed on the host, by step 8 or otherwise. Act in this order:

1. If `config.json` is in persona form and no pre-persona copy of it exists, neither step 1's copy nor one you kept elsewhere, stop here and change nothing: no reinstall, no start and no step 1. Rebuild the pre-persona `config.json` by hand, as [step 8 of "Rolling back the switch-over"](#step-8-reinstall-the-previous-cscb) says. Once you have rebuilt it, follow this block again from its start.
2. Otherwise, first rebuild by hand to their pre-persona form, as [step 8 of "Rolling back the switch-over"](#step-8-reinstall-the-previous-cscb) says, the crontable targets and `/interject` callers that the conversion to personas left in persona form where step 1's copy of them is missing. Then reinstall the previous CSCB, the version step 1 recorded or else the version the host ran before, with the pre-persona `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables: from step 1's files, or a pre-persona copy of `config.json` you kept, where they exist, and otherwise from those still in place. Start it, re-enabling the host's autostart for CSCB if it was disabled, as step 8's "no go" branch does.
3. Then, if agent-director is not 0.10.0 (below 0.7.0 under `ad-system-install-too-old`; 0.7.0 to 0.9.x under `ad-below-phase1-floor`), bring it to 0.10.0 outside this runbook. This block gives no command for it.
4. Then start the runbook at [step 1](#step-1-check-the-host-and-stage-the-release). Step 3 is then the old CSCB's own stop.

**A refusal after Phase 1 was installed.** Installing agent-director Phase 1 migrates agent-director's store. A refusal at step 10, or at any later start of the new CSCB (an autostart, `clean_restart` or the restart in step 4 of "Rolling back the switch-over" included), on a host whose Phase 1 install was step 8's or agent-director's own install on a publishing host, means the server finds the wrong agent-director binary. For that refusal, and only for it:

1. Check the binary. The server finds `$HOME/.agent-director/bin/agent-director` first, then the first `agent-director` on `PATH`. Take the binary path the startup-errors entry names and run `<path> version`, as the workers' user in the bot server's launcher environment.
2. Then either put agent-director Phase 1 back as the binary the server finds, or [follow "Rolling back the switch-over", which starts the previous CSCB](#rolling-back-the-switch-over). To put it back, stop every agent on the host and every long-running agent-director process (`agent-director serve` included) before that binary change, and start them again after it. A human stops any CSCB bot still running through the item "Stopping a set of agents before a binary change" in the "Operator actions" section of agent-director's README. Once the server finds Phase 1, start the new CSCB as [step 10](#step-10-start-the-new-cscb) does.

Never reinstall the old CSCB onto the migrated store. At the restart in step 4 of "Rolling back the switch-over", an agent that could not be stopped still runs: put nothing back and don't follow the rollback again. The new CSCB stays stopped until agent-director has dealt with that agent (as [that step](#step-4-wait-for-the-new-rows-to-end) says), and then this branch applies.

**Phase 1 installed some other way.** A host where agent-director Phase 1 was installed in any other way outside this runbook is not a target of this runbook, the same way step 1 sends a host on any version but 0.10.0 outside it. [Follow "Rolling back the switch-over"](#rolling-back-the-switch-over) and the item "agent-director was installed outside the caller's switch-over" in the "Operator actions" section of agent-director's README. Don't put Phase 1 back and start the new CSCB.

**A stop by the runtime re-check** is not a switch-over case. See [Found while the server was running](skills/debug-slack-channel-bots/SKILL.md#found-while-the-server-was-running) in the debugging skill.

#### The publishing host

`/publish` checks that the publishing host has an agent-director binary the client accepts: 0.7.0, the client's minimum, or later. This runbook starts by staging a release that is already published, so the host that publishes it is covered here:

1. Publish from a host that already passes that check. This is the first choice.
2. A host with no agent-director installs agent-director's Phase 1 release by agent-director's own install, then publishes. It has no agents and nothing to back up.
3. A host below the client's minimum (0.7.0) publishes from another host, and is not a target of this runbook: it brings agent-director to 0.10.0 first, outside this runbook, since step 1 stops on any version but 0.10.0. This block gives no command for it.

A publishing host needs no install-gate go line.

#### Step 1: Check the host and stage the release

Do this beforehand, with the old CSCB running and still installed as the global package. Nothing goes down in this step.

1. **The go line.** Confirm that agent-director's Phase 1 install-gate record has this host's dated go line. It is written before the Phase 1 install and is the approval for the switch-over. If it does not, stop here, before anything goes down. This runbook never writes the go line.
2. **agent-director's version.** Run `agent-director version` in the bot server's launcher environment, as the workers' user, the same as the Claude Code check below, and confirm that it shows 0.10.0, the only supported starting point. If it does not, stop here, before anything goes down. A host on an earlier version (below 0.7.0, or 0.7.0 to 0.9.x) first brings agent-director to 0.10.0, outside this runbook; this step names no command for it.
3. **The tmux socket (operator action).** Pin the tmux socket for the bot server's launcher, the host's sweep schedule and the workers. The sweep schedule is whatever runs `agent-director find-missing` on a schedule on your host: a cron entry, a systemd timer or a loop script. Run `tmux display-message -p '#{socket_path}'` from the bot server's launcher, the sweep schedule's environment and a worker's. Confirm that all three print the same path, that it is the pinned path (a `TMUX_TMPDIR` that names a missing path falls back silently to `/tmp`), and that the three share one HOME. A host with no sweep schedule checks the other two, and runs the one step 11 adds in the same environment. Record the result in the switch-over log.
4. **tmux.** Confirm tmux 3.2 or later, with `remain-on-exit` off.
5. **Claude Code.** Run `claude --version` in the bot server's launcher environment (the same user and `PATH` the server launches workers with), and confirm that the workers' Claude Code is 2.1.280 or later: the minimum agent-director states for its exec-form hooks, and the version the fleet runs. On a Claude Code too old for exec-form hooks (older than 2.1.139), each hook prints nothing, agent-director records `ad.hook.ignored` with the reason `no_exec_form`, and every launch stays `pending`. If it is older than 2.1.280, stop here, before anything goes down.
6. **agent-director's timing settings.** Read all nine keys of the `[tmux]` table of `~/.agent-director/config.toml` (see [agent-director's timing settings](README.md#agent-directors-timing-settings); a missing file, a missing key or `0` means the default) and its `[pause] timeout_seconds` (30 s when the file or the key is missing). Record the effective values in the switch-over log. Confirm that the three windows, `pending_grace_seconds`, `stopping_window_seconds` and `starting_session_seconds`, are the values you intend and each is at or above its minimum: `starting_session_seconds` 60, `stopping_window_seconds` 30, and `pending_grace_seconds` the larger of 30 and ⌈(`create_timeout_ms` + `pipe_close_wait_ms`) / 1000⌉ + 20. A `pending_grace_seconds` above 540 s shortens agent-director's SessionStart wait to 540 s.
7. **The call timeout.** Always computing from this host's values, confirm that the `agent_director_call_timeout_ms` the persona configuration will carry (staged below; `60000` when it leaves the setting out) exceeds the need: the largest ceiling among the verbs CSCB calls, plus the 15 s margin (15000 ms). Record the computed need in the switch-over log. With Q, A, C, W and E the host's `query_timeout_ms`, `action_timeout_ms`, `create_timeout_ms`, `pipe_close_wait_ms` and `kill_exit_wait_ms`, and B its `sweep_budget_seconds` in ms, the ceilings, in ms, are:
   - `kill`: the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W;
   - `read-pane`: 3Q + A + 4W;
   - `send-keys`: 3Q + 2A + 5W;
   - `pause`: 3Q + 2A + 5W, plus `[pause] timeout_seconds` (times 1000);
   - the launch row, `resume/spawn-with-reuse/plain-spawn` (`resume`, a spawn with reuse and a plain spawn): the larger of Q + C + 2A + 4W and 2Q + C + 3W;
   - `find-missing`: B + Q + W.

   `expire` is not among them: CSCB never calls it. [Sizing the agent-director call timeout](README.md#sizing-the-agent-director-call-timeout) works through examples.
8. **Leftover sessions.** As the workers' user, on the pinned socket, compare `tmux ls` with `agent-director list`, and record in the switch-over log every `slack_bot_` session that no row names.
9. **Stage the new release without installing it.** Choose its exact version, record it in the switch-over log and confirm that it is available to install. Write the persona configuration, with `agent_director_call_timeout_ms`, in a separate file, never `config.json`, which the old CSCB reads. Prepare the Slack apps. Nothing is installed over the global package yet, so step 3's `stop --stop-bots` is the old version's own and reads the old, pre-persona `config.json`. Steps 1, 2, 3, 5 and 6 of [Upgrading to personas](README.md#upgrading-to-personas) belong here.
10. **Copies for rollback.** Keep copies of the pre-persona `config.json`, the crontable, the `/interject` callers (the host crontab's `curl` lines included), `access.json` and the Slack token environment variables the old CSCB uses. Record the old CSCB's exact version in the switch-over log beside them.
11. **The orchestrator prompt (operator action).** The shared orchestrator prompt's "ship now" wording may go out any time before the switch-over. The shared orchestrator prompt is the system prompt your orchestrator bots load, for example the file `append_system_prompt_file` names.

#### Step 2: Disable CSCB's autostart

Disable the host's autostart for CSCB until step 10 (operator action), and record it in the switch-over log.

#### Step 3: Stop the old CSCB with its bots

With the old CSCB still installed, run its own stop:

```sh
claude-slack-channel-bots stop --stop-bots
```

This is the old version's own `stop --stop-bots`, which reads the old, pre-persona `config.json`, since nothing new is installed before step 7. An operator arriving from a startup refusal has first reinstalled the previous CSCB (see [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal)), so this holds for them too. From here until step 10, no bot server runs.

#### Step 4: Wait for the old rows to end

Run `agent-director find-missing`, then wait at most 5 minutes for every `service=cscb` row to read `ended` or `missing`:

```sh
agent-director find-missing
agent-director list --label service=cscb
```

A row still live after that is handled in step 5.

#### Step 5: Check for leftover sessions

As the workers' user, on the socket pinned in step 1, run a read-only `tmux ls`. Look for any old `slack_bot_<name>_<channel>` or `slack_bot_<channel ID>` session, and any live old row. Handle each leftover by its kind:

- **A leftover with a row** (live or finished) is ended in step 6, before the Phase 1 install.
- **A leftover with no row, whose name cannot equal any new persona's `slack_bot_<key>`:** record it in the switch-over log and go on; agent-director matches session names exactly. You may end it later with the exact-name `tmux kill-session -t =<name>`.
- **A leftover with no row, whose name equals a new persona's `slack_bot_<key>`:** note its window ids with a read-only `tmux list-windows -t =<name>`, end it with the exact-name `tmux kill-session -t =<name>`, and make the gone check.

**The gone check**, as the workers' user on the pinned socket: a read-only `tmux ls` no longer shows the session, and a read-only `tmux list-windows -a` shows none of its windows in any other session. A grouped session or a linked window keeps the worker running after its session is ended.

#### Step 6: End the leftovers that have a row

Only if step 5 found a leftover with a row. End each such leftover now, with the still-installed 0.10.0 binary. After the Phase 1 install, a row from before it has no launch token or recorded socket, so no session is ever its current launch's: Phase 1's `kill` fails closed on it, and not even agent-director's option for a finished row ends its session.

For each one:

1. Note the session's window ids, as in step 5.
2. Run `agent-director kill --claude-instance-id <id>` and check its result; on an error, don't delete or respawn. Then make the gone check.
3. If the session or one of its windows remains, end the session with the exact-name `tmux kill-session -t =<name>`, and make the gone check again.
4. Run `agent-director find-missing` until the row reads `ended` or `missing`, for at most 5 minutes.

A leftover that cannot be ended this way means no Phase 1 install: take step 8's "no go" branch, and investigate the leftover with `agent-director list --tmux-session-name <name>`.

#### Step 7: Install the new CSCB without starting it

1. Install the staged package over the global install, without starting it; the autostart stays disabled from step 2:
   ```sh
   bun install -g claude-slack-channel-bots@<the version recorded in step 1>
   ```
2. Put the persona configuration in place as `config.json`.
3. Write each persona's credentials file with the new CLI (see [`claude-slack-channel-bots credentials`](README.md#claude-slack-channel-bots-credentials)).
4. Rewrite crontable targets and `/interject` callers to name personas.
5. Run the new install check (see [Checking your agent-director install](README.md#checking-your-agent-director-install)). It passes on the still-installed 0.10.0, with its note.

Steps 4, 7 and 8 of [Upgrading to personas](README.md#upgrading-to-personas) belong here. From this step the new CSCB is deployed but not started.

#### Step 8: Install agent-director Phase 1

1. **The go line.** Confirm that the install-gate record has this host's dated go line.

   **No go.** If it does not, there is no Phase 1 install. Reinstall the previous CSCB, the version step 1 recorded, with the `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables saved in step 1. Start it on 0.10.0 and re-enable its autostart (operator action). Every other agent this step already stopped is started again on 0.10.0 by its owner (operator action). The runbook stops there.
2. **Stop every other agent (operator action).** Otherwise, before the install, stop every other agent on the host: orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`. Confirm with `agent-director list` that each stopped agent's row reads `ended` or `missing` (a row that 0.10.0 left stuck live for a dead agent is expected), and with a read-only `tmux ls` that no agent session is left. Record it in the switch-over log. An agent that cannot be stopped means "no go".
3. **Back up the store.** Back up `~/.agent-director/state.db` with an online-consistent copy, sqlite3's `.backup`, not a plain file copy, because the store runs in WAL mode:
   ```sh
   sqlite3 ~/.agent-director/state.db ".backup '<backup file>'"
   ```
   The backup is for disaster recovery only. It is not the rollback path.
4. **Install agent-director Phase 1.** Its schema migration adds thirteen columns and the one-row `store_meta` table, which holds the store's id. Confirm that `agent-director version` shows the Phase 1 version.
5. **Write the `[tmux]` values.** Right after the install, before the restarts that follow and so before the new CSCB starts, write any non-default `[tmux]` values you want into `~/.agent-director/config.toml`. A long-running agent-director process reads the file only when it starts.
6. **Restart `serve` (operator action).** Restart every `agent-director serve` process and every other long-running agent-director process still running. Compare process start times to confirm that none is older than the install. Record the version and that result in the switch-over log.
7. **Check the settings again.** Read the nine timing settings and `[pause] timeout_seconds` again as in step 1, and record the effective values. Confirm them and the call timeout as in step 1; if the need has grown, raise `agent_director_call_timeout_ms` in `config.json` before step 10. Confirm that `agent-director list` answers without `ErrConfigMalformed`.

#### Step 9: Start the other agents again

Every other agent on the host is started again by its owner (operator action), which also starts its `serve` processes on the Phase 1 binary.

#### Step 10: Start the new CSCB

1. **The orchestrator prompt's worker cleanup (operator action).** Before the new CSCB starts, change worker cleanup in the shared orchestrator prompt, and in its source copy if you keep one, from row-delete cleanup to "kill, then leave the row". This change goes out in the same deploy as agent-director Phase 1. Kill-then-leave works on 0.10.0 too, so a rollback does not revert it.
2. **Start the new CSCB**, then re-enable the host's autostart for CSCB (operator action):
   ```sh
   claude-slack-channel-bots start
   ```
   The first start has no last-applied record yet, so it checks `config.json`, records it and applies it; after that, edits wait until you apply them (see [Reload](README.md#reload)). Each persona starts fresh once. Pre-persona rows are kept and never resumed.
3. **The post-install check (operator action).** Once every agent has been started again, confirm that `agent-director list --state pending` shows a `launch_started_at` on every row. Record the result in the switch-over log, and as this host's dated post-install check line in agent-director's install-gate record. A row without one is a human's to look at, and the persona whose row it is is held (see "A persona posts a *Held: launch start not recorded* notice" and "How a hold ends" in [Troubleshooting](README.md#troubleshooting)).

#### Step 11: Schedule the daily expire

Schedule a daily `agent-director expire` at the default retention, never `--older-than 0d`, as the workers' user in the tmux environment step 1 pinned (operator action). Add it to the host's sweep schedule, the one step 1's socket check names: whatever runs `agent-director find-missing` on a schedule on your host, such as a cron entry, a systemd timer or a loop script. Nothing on the host runs `expire` before this step. A host with no sweep schedule must add one now (operator action), as the workers' user in the tmux environment step 1 pinned, running both `agent-director find-missing` on a schedule ([Migration](README.md#migration) shows it as a cron entry) and the daily `expire`.

The shared orchestrator prompt's "hold until after" wording goes out now (operator action).

### Rolling back the switch-over

The README section [Rolling back the switch-over](README.md#rolling-back-the-switch-over) is the maintained copy of this runbook; this copy carries the same steps and words.

This runbook takes the host back to the previous CSCB on agent-director 0.10.0, whether agent-director Phase 1 was installed by [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1) or some other way. Both binaries are rolled back together.

- The previous agent-director is restored only with agent-director's emergency downgrade recipe, in step 6. Never restore `state.db` from the switch-over's backup: the store is shared by every agent-director user on the host, and a restore would drop the rows of other services' workers spawned since the switch-over, leaving them running with no row.
- Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before the previous binary is restored and started again after it.
- Keep using the switch-over log. Each step says what to record in it.
- Run every command as the workers' user, in the tmux environment switch-over step 1 pinned.
- Steps marked "operator action" are done by a human on the host; nothing in CSCB does them. "Operator actions" is that section of agent-director's README.

#### Step 1: Disable CSCB's autostart for the rollback

Disable the host's autostart for CSCB until step 9 (operator action), and record it in the switch-over log.

#### Step 2: Remove the daily expire from the sweep schedule

Remove the daily `agent-director expire` run that switch-over step 11 added to the host's sweep schedule, the cron entry, systemd timer or loop script that runs it (operator action), and record it in the switch-over log. This comes before the previous binary is restored, because the older `expire` does not check tmux.

#### Step 3: Stop the new CSCB with its bots

```sh
claude-slack-channel-bots stop --stop-bots
```

The command's failure lines are described in [Precheck before stopping bots](README.md#precheck-before-stopping-bots) and [What the command prints when a bot can't be stopped](README.md#what-the-command-prints-when-a-bot-cant-be-stopped).

- **A persona in CONFLICT.** If the command exits non-zero naming a persona in CONFLICT, a human follows "Operator actions" for that persona's session, checks the result, and runs `stop --stop-bots` again.
- **When the bots can't be stopped.** If that session cannot be ended that way, or the command exits non-zero because agent-director does not answer or a call stays UNAVAILABLE after its retries, stop the server with plain `stop`, and record in the switch-over log each persona and session the failed command named:
  ```sh
  claude-slack-channel-bots stop
  ```

#### Step 4: Wait for the new rows to end

Run `agent-director find-missing`, then wait at most 5 minutes for every `service=cscb` row, the rows of retired persona keys included, to read `ended` or `missing`:

```sh
agent-director find-missing
agent-director list --label service=cscb
```

A row still live after that (for example a retired key whose kill failed, which `stop --stop-bots` does not cover) is ended by a human:

1. Run `agent-director kill --claude-instance-id <id>`, and check its result; on an error, don't delete or respawn.
2. A `kill` refused with CONFLICT ("not this launch's session") has met a leftover of an earlier launch: handle it as "Operator actions" describes.
3. If these kills keep failing, follow "Operator actions" for that worker, and record it in the switch-over log.

Nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the previous binary is restored.

**When "Operator actions" cannot end it either**, the rollback stops here, with Phase 1 still installed, and the worker is taken to agent-director. So that the fleet does not stay down while agent-director investigates, start the new CSCB again, restore step 2's daily `expire` to the host's sweep schedule, and re-enable the host's autostart for CSCB (operator action). If that start is refused, the new CSCB stays stopped until agent-director has dealt with that worker; then follow "A refusal after Phase 1 was installed" in [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal).

#### Step 5: Check for leftover persona sessions

As the workers' user, on the socket switch-over step 1 pinned, run a read-only `tmux ls`, and confirm that no `slack_bot_<key>` session is left. Handle each leftover by whether it has a row and, if it has one, by that row's current state:

- **A leftover whose row is live:** end it with `agent-director kill --claude-instance-id cscb_<key>`, and check its result; on an error, don't delete or respawn. When that `kill` is refused with "not this launch's session", handle it as "Operator actions" describes.
- **A finished row's own leftover session:** handle it as "Operator actions" describes.
- **An operator action refused inside the stopping window or the starting-session bound:** retry it once the longer of the two has passed. Read all nine timing settings again, as in switch-over step 1, for the two windows' values, and record them in the switch-over log. A plain `kill` never refuses for that reason.
- **A leftover with no row:** handle it as in [switch-over step 5](#step-5-check-for-leftover-sessions), against the previous CSCB's session names (`slack_bot_<name>_<channel>` or `slack_bot_<channel ID>`) instead of the new personas'.

Check each result, then run `agent-director find-missing` and switch-over step 5's gone check again. Don't go on while a leftover remains: the previous CSCB's first start deletes every row without a `channel` label.

#### Step 6: Stop every agent and restore the previous agent-director

1. **Stop every other agent (operator action).** Before the previous binary is restored, stop every other agent on the host and every long-running agent-director process: orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`. A `serve` runs inside its Claude session, so that session is stopped too. Confirm as in [switch-over step 8](#step-8-install-agent-director-phase-1): `agent-director list` shows each stopped agent's row `ended` or `missing`, and a read-only `tmux ls` shows no agent session left. Record it in the switch-over log.

   The restore does not begin while any agent runs. If one cannot be stopped, the rollback stops as step 4 says, and every agent this step stopped is started again on Phase 1 by its owner (operator action).
2. **Restore the previous agent-director** with agent-director's emergency downgrade recipe, never from the switch-over's `state.db` backup. The recipe drops the thirteen columns the Phase 1 migration added and its `store_meta` table, which holds the store's id, and stamps schema version 4. It deletes no row or history entry, so the older binary shows every life's history again.

   A later Phase 1 install creates a new store id. A session labelled before the rollback would then read as another agent-director store's session, which agent-director never acts on: one more reason no agent may run across the restore.
3. **Start the other agents again (operator action).** Every other agent on the host is started again by its owner on the previous binary, which also starts its `serve` processes on it.

#### Step 7: Revert the orchestrator prompt's hold wording

Revert the shared orchestrator prompt's "hold until after" wording that switch-over step 11 put out (operator action). The worker cleanup switch-over step 10 changed to "kill, then leave the row" stays: it works on 0.10.0 too.

#### Step 8: Reinstall the previous CSCB

1. Move aside `config.json.last-applied` and `retired-keys.json` (see [Files beside the config file](README.md#files-beside-the-config-file)).
2. Reinstall the previous CSCB, the version switch-over step 1 recorded, or else the version the host ran before, without starting it:
   ```sh
   bun install -g claude-slack-channel-bots@<the previous version>
   ```
3. Put back what switch-over step 1 saved: the pre-persona `config.json`, the crontable, the `/interject` callers (the host crontab's `curl` lines included), `access.json` and the Slack token environment variables.
4. Where switch-over step 1's copy of a file is missing, the operator rebuilds the pre-persona file by hand from the persona configuration, reversing the manual conversion in [Upgrading to personas](README.md#upgrading-to-personas). No tooling does this: CSCB ships no conversion tooling in either direction.

#### Step 9: Start the previous CSCB

Start the previous CSCB, then re-enable the host's autostart for CSCB (operator action), and record it in the switch-over log:

```sh
claude-slack-channel-bots start
```
