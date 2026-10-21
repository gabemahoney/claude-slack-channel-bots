---
name: setup-slack-channel-bots
description: Interactive setup wizard for claude-slack-channel-bots — states or changes the channel mode (strict or open), adds personas one at a time (a Slack app from the manifest, its name and avatar, its credentials file written by a terminal command so tokens never enter the chat, its channels or the channels its app is invited to, its DMs and destination, its entry in config.json), then checks the system prompt, agent-director and legacy hooks and explains how the change takes effect.
version: 1.0.0
license: MIT
user-invocable: true
argument-hint: ""
allowed-tools: [Read, Write, Edit, Bash, Glob]
---

# /setup-slack-channel-bots

Interactive setup wizard for `claude-slack-channel-bots`. Each bot is a
**persona**: its own Slack app, its own credentials file, one Claude instance
with its own working directory, and the channels it serves: in strict
mode, the default, the channels it is configured into; in open mode, the
channels with applied non-off choices where its app is invited. The wizard states the channel mode, or sets
it, adds personas one at a time, then checks the rest of the setup. It skips
anything already done.

The persona configuration reference, `docs/configuration.md` in the package,
is the authority. This skill links to its sections instead of repeating them.

## Constraints

- NEVER start, stop or restart the server (`claude-slack-channel-bots start`,
  `stop`, `clean_restart`, or `bun server.ts`).
- NEVER modify the package's source files.
- NEVER ask the operator to paste, type or show a token in the chat. Tokens go
  only into the [Credentials command](#credentials-command), which the
  operator runs in their own terminal. If the operator offers a token in the
  chat anyway, don't use it, repeat it or check it: tell them to regenerate
  the token in Slack, because a token posted in the chat is already in the
  session transcript, and to put the new one into the credentials command.
- NEVER read, print, copy or `cat` a credentials file. Check only that it
  exists and its mode (`ls -lL`).
- NEVER run the credentials command through the Bash tool. The operator runs it.
- NEVER write `config.json.pending`, `config.json.apply` or
  `config.json.last-applied`. The one exception: rename `config.json.pending`
  to `config.json.apply` when, and only when, the operator explicitly directs
  you to.
- Apart from that rename, write only `config.json` and the optional
  system-prompt file, both in the state directory.
- `config.json` holds no tokens. If a value in it starts with `xoxb-` or
  `xapp-`, don't display it; tell the operator a token was pasted into the
  configuration and must move to a credentials file.

---

## Setup Steps

Work through each step in order. If a step is already complete, say so briefly
and move on.

---

### Step 1 — Read the configuration reference

Find the installed package:

```bash
for d in "$HOME/.bun/install/global/node_modules/claude-slack-channel-bots" \
         "$(npm root -g 2>/dev/null)/claude-slack-channel-bots"; do
  [ -f "$d/README.md" ] && echo "$d"
done
```

The directory printed is the package root: it holds `README.md`, `docs/`,
`slack-app-manifest.yml` and `skills/`. Read `docs/configuration.md`
(the persona reference), `docs/server-settings.md`, `docs/channel-modes.md`
and `docs/reload.md`, and the debug skill's `### The load-time rules`
(`skills/debug-slack-channel-bots/SKILL.md`), and use them as the authority
for every later step. If the package isn't found, continue with this skill
and point the operator at those pages in the package's GitHub repository.

---

### Step 2 — State directory and config.json

The state directory is `SLACK_STATE_DIR` when it is set and non-empty, else
`~/.config/claude-slack-channel-bots` (`$XDG_CONFIG_HOME/claude-slack-channel-bots` when the shell's `XDG_CONFIG_HOME`
is an absolute path):

```bash
STATE_DIR="${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}"
ls -l "$STATE_DIR/config.json" 2>/dev/null || echo "NOT_FOUND"
```

- **Missing, with `SLACK_STATE_DIR` unset and a `config.json` in
  `~/.config/cscb` or `~/.claude/channels/slack`:** the host kept its state
  there under an earlier release and its server has not started since the
  upgrade, which moves it to the new folder. Don't create a configuration in
  the new folder. Tell the operator to run `claude-slack-channel-bots stop` (it
  finds the old directory), then `claude-slack-channel-bots start`, and offer to
  continue afterwards.
- **Missing:** postinstall writes a skeleton with an empty `personas` array.
  Ask the operator to run `bun src/postinstall.ts` from the package root, or to
  re-run the install's `bun pm -g trust claude-slack-channel-bots` step (README
  Quick Start). An empty `{"personas": []}` is also a valid start.
- **Present:** read it and list the personas already declared, by `name`, with
  their `working_directory`, `credentials_file` and `dm`, and each section
  they carry: the shared channel IDs, delivery choices and `permission_prompts`. Step 4 tells which
  section is in force; Step 5 uses the names and paths to reject clashes.

---

### Step 3 — Detect the server state

Before any edit, record whether a server is running and whether the
last-applied record exists. Steps 4 and 10 use both.

```bash
STATE_DIR="${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}"
if [ -f "$STATE_DIR/server.pid" ] && kill -0 "$(cat "$STATE_DIR/server.pid")" 2>/dev/null; then
  echo "server: running"
else
  echo "server: not running"
fi
[ -f "$STATE_DIR/config.json.last-applied" ] && echo "record: present" || echo "record: absent"
[ -f "$STATE_DIR/config.json.pending" ] && echo "pending change: present" || echo "pending change: none"
```

If a change is already pending, tell the operator before adding to it: a
confirmation applies everything `config.json` holds at that moment.

---

### Step 4 — Channel mode

The top-level `channel_mode` selects `strict` (the default) or `open` for every persona. Both modes share `channels`, all four `delivery` choices and one required `permission_prompts` destination. See `docs/channel-modes.md`.

Read the mode from the applied envelope and edited input separately:

```bash
STATE_DIR="${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}"
[ ! -f "$STATE_DIR/config.json.last-applied" ] || jq '.applied.channel_mode // "strict"' "$STATE_DIR/config.json.last-applied"
jq '.channel_mode // "strict"' "$STATE_DIR/config.json"
```

On a fresh install, explain both modes, suggest `strict`, and ask which one. On an existing install, state the applied mode and ask whether to change it. An absent selector and `"strict"` mean the same mode. A differing input mode is pending until confirmed.

To change modes, edit only `channel_mode`, preserving channel choices and the shared destination. Before selecting `open`, review each app’s channel memberships, private channels included, and past `unclaimed-channel` lines in `server.log`. A channel invitation alone does not create a listening choice. Have the operator read `docs/channel-modes.md`’s `## Who can reach a persona in fungible mode` before selecting it. Check every persona against the debug skill’s `### The load-time rules`; Step 10 describes confirmation.

---

### Step 5 — Add a persona

Ask how many personas the operator wants to add, then run 5.1 to 5.10 once for
each. One persona is one Slack app; never share an app or a credentials file
between personas. Where a sub-step differs by channel mode, follow the mode
`config.json` holds after Step 4.

#### 5.1 Name

Ask for the persona's `name`. It is the persona's identity in `config.json`,
logs and targets, not its Slack display name (that comes from its app). Any
non-empty name is accepted. The server derives a **key** from the name, used
for its agent-director instance and in targets, and shows it on the persona's
`persona-start` line in `server.log`. See `docs/configuration.md`'s
`### Persona name and key` for the rule.

Reject a name that equals an existing persona's name or key. A name of 1–40
lower-case letters, digits and `_` is its own key, so compare it directly.
Other names get a derived key with a hash; a clash there is still rejected
when the configuration is checked, as an `INVALID` pending change or a failed
first start.

Also reject a name whose key starts with an existing persona's key, or is the
start of one: `dev` beside `dev_2`, `team` beside `team_admin`, or `dev`
beside `"Dev Bot"` (key `dev_bot_…`). The server rejects such a pair. The
reason: tmux matches a session target by prefix unless it is written with
`=`, so a human's tmux command without `=` for one persona (for example
`tmux attach -t slack_bot_dev`) could reach another persona's session. See
the docs/configuration.md section "Persona name and key". Keys that only
share a start, such as `dev_a` and `dev_b`, are fine. When a name clashes
this way, propose the shorter one with `_main` appended (`team_main`), or
`_main_2`, `_main_3`, … if that still starts with, or is the start of,
another key, and ask for another name if none fits. Rename an existing
persona only if the operator wants that.
When the operator names personas after the channels their earlier bots
served, check every pair of names this way before writing any entry.

#### 5.2 Slack app: create, name, avatar, install

Create one Slack app for this persona from the shipped manifest,
`<package-root>/slack-app-manifest.yml`:

1. Before pasting, offer to set the app's name (`display_information.name`)
   and its bot's display name (`features.bot_user.display_name`) to the
   persona's Slack name. If the operator wants that, read the shipped manifest
   and show them the edited manifest text in the chat for them to paste; don't
   write a file. Both names can also be changed later in the app's settings.
2. At [https://api.slack.com/apps](https://api.slack.com/apps): **Create New
   App** → **From a manifest** → pick the workspace → switch to **YAML** →
   paste the manifest → create.
3. Upload the persona's avatar under **Basic Information** → **Display
   Information** (app icon).
4. **OAuth & Permissions** → **Install to Workspace**. The **Bot User OAuth
   Token** (starts with `xoxb-`) is on that page after the install.
5. **Basic Information** → **App-Level Tokens** → **Generate Token and
   Scopes**, with the `connections:write` scope. That app-level token starts
   with `xapp-`.

Tell the operator where both tokens are. Don't ask for them: they go into the
terminal command in 5.10.

**Reusing an existing app** for this persona: an app created from an earlier
manifest can lack the `im:write`, `channels:read` and `groups:read` scopes and
must gain them and be re-installed. Point to the debugging skill's entries "A
persona can't open a DM: re-install its app to gain `im:write`" and "The
message archive shows channel IDs: re-install each app to gain
`channels:read` and `groups:read`"
(`skills/debug-slack-channel-bots/SKILL.md`) for the steps. It can also lack
the `lists:read` and `lists:write` scopes, which a bot needs to use a Slack
List: add both the same way, then re-install.
An app already used by another persona can't be reused.

#### 5.3 Credentials file path

Agree the `credentials_file` path: absolute or starting with `~/`, one file
per persona. Suggest `~/.config/claude-slack-channel-bots/<key>-credentials.json`. Use the
persona's key when the name is its own key (5.1); otherwise use a lower-case
form of the name with only `a-z`, `0-9` and `_`, as keys have. Reject a path
another persona already uses. The operator writes the file in 5.10, once the
persona is declared: the credentials command finds it in `config.json`.

#### 5.4 Working directory

Ask for the persona's `working_directory` (absolute, `~` or `~/…`): the
directory its Claude instance works in. Check that it exists:

```bash
test -d "<expanded path>" && echo "ok" || echo "not found"
```

A persona whose directory is missing stays down until the directory exists.
If another persona already uses the same directory (compare real paths, for
example with `(cd "<path>" && pwd -P)`), warn the operator: two personas can't
share one, and the configuration is rejected.

#### 5.5 Channels

In both modes, collect each channel’s fields below. A persona with no channels must have DMs enabled:

- **`id`**: a Slack channel ID, pattern `^[CG][A-Z0-9]+$`. In Slack, click the channel name; the ID is at the bottom of **About**.
- **`delivery`**: explicitly choose `off`, `mentions`, `all` or `thread_hybrid`. `off` disables channel listening; `mentions` delivers direct mentions and broadcasts; `all` delivers every message. Unassigned channels default to `off`.

See `docs/configuration.md`’s `### Channel entries` and `### Channel delivery`.

In either mode, tell the operator to invite the persona's app to each channel
the persona should serve, in that channel:

```
/invite @<the persona's bot display name>
```

In open mode, listening also requires a non-off applied choice.
Invite the app to its destination channel from 5.7 too, when that is a
channel. If the persona stays silent in a channel its app was invited to,
point to the debugging skill's entry "A persona is silent in a channel its app
was invited to" (`skills/debug-slack-channel-bots/SKILL.md`).

#### 5.6 Direct messages

Ask whether the persona takes DMs (`dm.enabled`, off by default). If it does,
or if its prompts will go by DM (5.7), ask for `dm.contact`: the Slack user ID
of the person who receives its prompts and notices, pattern `^[UW][A-Z0-9]+$`.
In Slack, open that person's profile, then **⋮** → **Copy member ID**.

A persona whose destination is a channel needs no DMs. A `dm` destination needs both DMs on and a contact. See `docs/configuration.md`’s "Direct messages" subsection.

#### 5.7 Permission prompts

Ask for `permission_prompts`, required in both modes: a listed channel ID, including a channel set to `off`, or `dm` with `dm.enabled: true` and a `dm.contact`. Invite the app to a channel destination so Slack accepts posts; everyone there sees its prompts and notices. See `docs/channel-modes.md`’s `## Permission prompts in both modes`.

#### 5.8 Optional next-launch settings

Offer these only if the operator wants to override the top-level defaults
(`docs/configuration.md` `### Next-launch settings`):

- **`claude_config_dir`**: the persona's own Claude config directory, so it can
  use a different Claude account. Never `~/.claude`. The operator populates it
  before the persona first launches:

  ```bash
  CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai
  ```

  (`--console` for a Console account.) If a persona doesn't come up because
  its `claude_config_dir` can't be resolved, point to the debugging skill's
  `persona-config-dir-unresolvable` entry.
- **`stop_hook_bootstrap`**: boolean compatibility setting; `false` turns Slack
  reply reminders off for this persona. Confirmed changes apply immediately
  and keep its running session. See [Slack reply reminders](../../docs/bots.md#slack-reply-reminders).

#### 5.9 Declare the persona

Show the operator the entry. In strict mode, for example:

```json
{
  "name": "<name>",
  "credentials_file": "<credentials file path>",
  "working_directory": "<working directory>",
  "channels": [
    { "id": "<channel ID>", "delivery": "all" }
  ],
  "permission_prompts": "<channel ID>"
}
```

The same entry shape applies in both modes. Add `"dm": { "enabled": true, "contact": "<user ID>" }` and the 5.8 settings only when chosen. A DM-only persona explicitly sets `"permission_prompts": "dm"`.

Check the entry against the debug skill’s `### The load-time rules`, together with the personas already declared: unique names/keys, working directories and credentials paths; no key prefixes; valid paths and IDs; no duplicate channel IDs; explicit four-value delivery; required shared destination. Use only fields from `docs/configuration.md`’s `### Persona fields` table.

On the operator's approval, append the entry to `personas` in `config.json`,
keeping every other field and persona unchanged.

#### 5.10 Write its credentials file

Give the operator the [Credentials command](#credentials-command) with the
persona's name filled in, and have them run it in their own terminal. After
they report success, check only that the file exists and has mode 0600:

```bash
ls -lL "<expanded credentials file path>"
```

`-rw-------` is mode 0600. Never open the file.

On a running server, the preview the server writes after 5.9 first reads
`is added but cannot come up: credentials file does not exist`. Once the file
is written the server writes a new preview; the operator confirms only after
it (Step 10). Then ask whether to add another persona.

---

### Step 6 — Server-wide settings (optional)

Only if the operator asks, set top-level settings such as `queued_ack_reaction`, `ack_reaction`,
`reply_chunk_limit`, `reply_chunk_mode`, `port` or `session_restart_delay`.
`docs/server-settings.md`'s `## Server-wide settings` table lists each field, its type and
default. Write only the fields the operator sets.

Before starting, check that the selected acknowledgement emoji names are available
in each persona's Slack workspace, including when using the defaults: queued
`beehive`, delivered `spinthinking`. **Custom emoji must exist in the Slack
workspace before configuring them.** `spinthinking` is custom. If a name is
unavailable, have the operator add it in Slack or choose an available name.
Both settings require a server start after confirmation; see
[Acknowledgement reactions](../../docs/server-settings.md#acknowledgement-reactions).

The channel-mode switch, `channel_mode`, is a server-wide setting
too, but it is set only in Step 4, which collects every persona's section and
checks the rules with it. Never set or change it here.

---

### Step 7 — System prompt for the personas

`append_system_prompt_file` names a file appended to every persona's system
prompt. Without one, a persona may answer in its terminal, which nobody sees,
instead of in Slack.

1. Read the template, `<package-root>/skills/EXAMPLE_CLAUDE.md`, and show it to
   the operator.
2. Ask what the personas should do. The file is shared by every persona, so
   keep persona-specific instructions in each working directory's `CLAUDE.md`.
3. Write `$STATE_DIR/system-prompt.md` from the template, keeping its
   Communication and persona sections and adapting its Role section to the
   operator's answer.
4. Set `"append_system_prompt_file": "<path of that file>"` in `config.json`,
   keeping every other field. Show the operator the file and iterate until
   they are happy.

If each working directory's `CLAUDE.md` already tells its persona everything,
including to answer through the Slack `reply` tool, the operator can set
`"system_prompt_mode": "none"` instead: only `CLAUDE.md` is used and
`append_system_prompt_file` is ignored. If the operator skips this step, warn
them that personas may not answer in Slack.

Both are server-wide settings (Step 10 says when they take effect).

---

### Step 8 — Verify agent-director is installed

```bash
agent-director version
```

If `agent-director` isn't on `PATH`, or is older than the version the server
needs, point the operator to the `install-cscb` skill
(`skills/install-cscb/SKILL.md` in the package), which checks the install with
`bun run install-check` and walks through the diagnosis. This release needs
agent-director Phase 1, and the two are installed together through the
docs/migration.md section "Switching over to agent-director Phase 1"; this wizard
changes nothing in the agent-director install. The server registers its
agent-director template at start; an `ad-template-install` line in
`$STATE_DIR/startup-errors.log` means that failed.

---

### Step 9 — Check settings.json for orphan legacy hook entries

Hosts that ran v0.5.x may have `PermissionRequest` or `PreToolUse`
`AskUserQuestion` entries in `~/.claude/settings.json` that point at `.sh`
files that no longer exist. They are harmless but stale.

```bash
jq '
  (.hooks.PermissionRequest // [] | map(select(.hooks[]?.command | strings | test("\\.sh$")))),
  (.hooks.PreToolUse // [] | map(select(.matcher == "AskUserQuestion" and (.hooks[]?.command | strings | test("\\.sh$")))))
' ~/.claude/settings.json 2>/dev/null
```

If either array is non-empty, show the operator the entries and advise removing
by hand any `PermissionRequest` entry whose `hooks[].command` ends in
`permission-relay.sh`, and any `PreToolUse` entry with
`matcher: "AskUserQuestion"` whose `hooks[].command` ends in `ask-relay.sh`.

---

### Step 10 — How the change takes effect

Explain the case that matches Step 3. Link to `docs/reload.md`.

- **No last-applied record** (a fresh install): the first
  `claude-slack-channel-bots start` applies `config.json` as it stands. The
  operator starts it; you don't.
- **Server running:** within about 5 seconds the server writes
  `config.json.pending`, a preview of the change, and logs it in `server.log`.
  The operator reads it, including any `INVALID` or `DESTRUCTIVE:` line, then
  confirms by renaming `config.json.pending` to `config.json.apply`:

  ```bash
  cd "${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}"
  mv config.json.pending config.json.apply
  ```

  The server applies it without a restart and logs `reload-applied`. If
  `config.json` or a credentials file changes after the preview was written,
  the confirmation is stale and ignored (`reload-stale-confirmation`): wait for
  the new `config.json.pending` and rename again. Do the rename yourself only
  when the operator explicitly directs you to, and then with absolute paths
  and no `cd`:

  ```bash
  mv "<state dir>/config.json.pending" "<state dir>/config.json.apply"
  ```
- **Record present, server stopped:** the next start runs the last-applied
  configuration, and the change (a new persona, a changed switch) stays
  pending. After the start, confirm as above.

A change to the channel-mode switch from Step 4 applies in place: once
confirmed, it takes effect at once, from the next event, tool call, prompt and
notice, with no restart, and every session is kept. Its preview line reads
`server-wide setting channel_mode
changed: turns <mode> mode on, applied in place at once, from the next event,
tool call, prompt and notice, for …`, naming the mode it turns on and every
persona it affects. See `docs/channel-modes.md`'s `## Turning open mode on or off`.

Confirmed `stop_hook_bootstrap` changes, whether set on a persona or inherited
from the top level, also apply immediately to reminder checks and keep the
running session; no restart is needed. A confirmed `claude_config_dir` change
takes effect at each affected persona's next launch.

Most other server-wide changes, such as `port`, are recorded when confirmed
and take effect at the next server start. See `docs/reload.md`'s
`## When next-launch and server-wide changes take effect` for these and the
CLI timeout exceptions. `append_system_prompt_file` and `system_prompt_mode` from Step 7
are part of the agent-director template the server registers once, at start.
On a running server, a confirmation doesn't change that template: every
persona, including one the same change adds, keeps launching with the system
prompt settings the server started with. So whenever Step 7 changed anything
on a running server, the operator waits for the `reload-applied` line, then
runs:

```bash
claude-slack-channel-bots clean_restart
```

It restarts the server and relaunches every persona; conversations resume.
The operator runs it; you never do.

After the change is applied (a confirmation or a first start), confirm each
new persona came up: `server.log` has its `persona-start` line
(`[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting`)
and no later line naming `(key=<key>)` with a failure class such as
`persona-credentials-…` or `persona-directory-…`. Or @mention it in one of its
channels and wait for its answer: in strict mode, a channel listed in its
`channels`; in open mode, a channel its app was invited to. In either
mode, a persona with DMs on can be DMed instead.

```bash
grep -F 'persona-start:' "$STATE_DIR/server.log" | tail -n 20
grep -F '(key=<key>)' "$STATE_DIR/server.log" | tail -n 20
```

In open mode, the first event a persona hears from a channel logs its
`persona-invited-channel` line, naming the channel. If a persona stays silent
in a channel its app was invited to, point to the debugging skill's entry
"A persona is silent in a channel its app was invited to".

---

### Step 11 — Summary

Report:

- The channel mode `config.json` holds (strict or open), and whether
  Step 4 changed it. A changed switch applies in place, at once, once
  confirmed (Step 10).
- Each persona added: name, key if known, credentials file present with mode 0600 or not, DMs and contact, shared channels with `delivery`, and required `permission_prompts` destination.
- When Step 4 changed the mode: the new mode, with channel choices and destination preserved.

- `append_system_prompt_file` configured, `system_prompt_mode: "none"`, or
  skipped.
- agent-director: installed (version) or missing.
- settings.json orphan legacy hooks: none, or found (needs cleanup).
- The next action from Step 10: start the server, or read and confirm
  `config.json.pending`. On a running server where Step 7 changed
  `append_system_prompt_file`, the system-prompt file or `system_prompt_mode`,
  add: after `reload-applied`, run `claude-slack-channel-bots clean_restart`.
- How to confirm each new persona came up (Step 10).

If a persona doesn't come up or doesn't answer, point the operator to
`/debug-slack-channel-bots`: `server.log` names the cause on the persona's
lines.

---

## Credentials command

The operator runs this one line in their own terminal (bash or zsh, on
linux-x64 or darwin-arm64), once the persona is declared in `config.json`
(5.9). Never paste a token into the chat. Before handing it over, replace
`<persona>` with the persona's name as `config.json` declares it, or its key.
Single-quote a name that holds anything but letters, digits and `_`
(`'Dev Bot'`); a single quote inside it is written `'\''`.

```bash
claude-slack-channel-bots credentials <persona>
```

Show it as one fenced block with the name filled in, and tell the operator to
copy only the line between the fences. It is one short line, so a copy from an
80-column terminal keeps it whole; if a copy arrives split over two lines,
have the operator type it instead.

It finds the persona by name or key in `config.json` as it stands, prints the
persona and the path of its `credentials_file`, and runs the package's
credentials script (`scripts/write-credentials.sh`) for that file, on the
operator's terminal. A persona `config.json` doesn't declare, or a
`config.json` that can't be loaded, stops it before anything is asked. The
script:

- Turns off command tracing and automatic export first, then checks the path,
  then that `curl` is installed, before asking anything.
- If the file already exists, asks for `yes` to replace it. Anything else, an
  empty answer included, exits non-zero and leaves the file untouched.
- Reads the bot token, then the app-level token, without echo. An empty
  answer (a stray Enter) asks again.
- Checks that neither is empty, that `bot_token` starts with `xoxb-` and
  `app_token` with `xapp-`, and that each holds only letters, digits and
  dashes. A failure names the key and the rule, and nothing is sent to Slack.
- Validates `bot_token` with Slack `auth.test` and `app_token` with
  `apps.connections.open`, and prints `ok` or Slack's error code for each key
  (`unexpected response` when the code isn't plain letters, digits, `_` and
  `.`). A check passes only when the first field of Slack's reply is
  `"ok":true`. A check that can't reach Slack (30-second limit) fails and says
  so. A token reaches `curl` only on its standard input, never on a command
  line, and is never printed; `curl -q` ignores the operator's `~/.curlrc`.
- Only when both pass, writes the file: a JSON object with exactly
  `bot_token` and `app_token`, mode 0600 from creation whatever the umask,
  replaced in one step (a temporary file created with `mktemp` beside it, then
  renamed). The temporary file is removed on any failure or interrupt. If the
  target changed while it ran (it appeared, vanished, became or stopped being
  a symlink, or became a directory), nothing is written. It creates a missing
  parent directory, checks that the result is a regular file that isn't
  empty, and prints `Wrote <path> with mode 0600.`
- The rename replaces a symlink at the path with a regular file; the file the
  symlink pointed to keeps the old tokens.

It needs `curl`, `mktemp`, `mkdir`, `chmod`, `mv` and `rm`.

If validation fails:

- `invalid_auth` or `not_authed`: the wrong token was copied, or it was
  revoked. Copy it again from the app's settings (5.2).
- `not_allowed_token_type` on `apps.connections.open`: the token given as the
  app-level token isn't one; generate an app-level token.
- An app-level token without the `connections:write` scope, or an app that
  isn't installed to the workspace, also fails: fix it in the app's settings
  (5.2) and run the command again.
- `could not reach Slack`: check the network, then run it again.

The `debug-slack-channel-bots` skill covers the server-side lines for a
persona whose tokens Slack refuses (`persona-credentials-refused`).

Replacing an existing persona's file on a running server makes a pending
credentials change: the server writes `config.json.pending`, and the change
takes effect only once the operator confirms it (Step 10, `docs/reload.md`).

---

## Rotate a persona's tokens

To replace an existing persona's tokens (for example after regenerating them
in Slack), give the operator the [Credentials command](#credentials-command)
with that persona's name. It asks before replacing the file. If the
persona's `credentials_file` is a symlink, the command replaces the link with
a regular file and leaves the old tokens in the file it pointed to: tell the
operator to delete that file by hand afterwards. On a running server, the
server then writes `config.json.pending` naming the persona's credentials
change; once the operator confirms it by the rename (Step 10), only that
persona reconnects. No restart is needed. On a stopped server, the next start
reads the new file as it stands. See `docs/reload.md`.
