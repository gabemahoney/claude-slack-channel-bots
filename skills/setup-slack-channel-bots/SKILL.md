---
name: setup-slack-channel-bots
description: Interactive setup wizard for claude-slack-channel-bots — adds personas one at a time (a Slack app from the manifest, its name and avatar, its credentials file written by a terminal command so tokens never enter the chat, its channels and DMs, its entry in config.json), then checks the system prompt, agent-director and legacy hooks and explains how the change takes effect.
version: 1.0.0
license: MIT
user-invocable: true
argument-hint: ""
allowed-tools: [Read, Write, Edit, Bash, Glob]
---

# /setup-slack-channel-bots

Interactive setup wizard for `claude-slack-channel-bots`. Each bot is a
**persona**: its own Slack app, its own credentials file, one Claude instance
with its own working directory, and the channels it is configured into. The
wizard adds personas one at a time, then checks the rest of the setup. It
skips anything already done.

The README's persona configuration reference is the authority. This skill
links to its sections instead of repeating them.

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

### Step 1 — Read the README

Find the installed package:

```bash
for d in "$HOME/.bun/install/global/node_modules/claude-slack-channel-bots" \
         "$(npm root -g 2>/dev/null)/claude-slack-channel-bots"; do
  [ -f "$d/README.md" ] && echo "$d"
done
```

The directory printed is the package root: it holds `README.md`,
`slack-app-manifest.yml` and `skills/`. Read the README's
`### Personas (config.json)` section (its subsections are the persona
reference) and the `## Reload` section, and use them as the authority for every
later step. If the package isn't found, continue with this skill and point the
operator at the README on the package's GitHub page.

---

### Step 2 — State directory and config.json

The state directory is `SLACK_STATE_DIR` when it is set and non-empty, else
`~/.claude/channels/slack`:

```bash
STATE_DIR="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
ls -l "$STATE_DIR/config.json" 2>/dev/null || echo "NOT_FOUND"
```

- **Missing:** postinstall writes a skeleton with an empty `personas` array.
  Ask the operator to run `bun src/postinstall.ts` from the package root, or to
  re-run the install's `bun pm -g trust claude-slack-channel-bots` step (README
  Quick Start). An empty `{"personas": []}` is also a valid start.
- **Present:** read it and list the personas already declared, by `name`, with
  their `working_directory`, `credentials_file` and channel IDs. Step 4 uses
  these to reject clashes.

---

### Step 3 — Detect the server state

Before any edit, record whether a server is running and whether the
last-applied record exists. Step 9 uses both.

```bash
STATE_DIR="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
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

### Step 4 — Add a persona

Ask how many personas the operator wants to add, then run 4.1 to 4.10 once for
each. One persona is one Slack app; never share an app or a credentials file
between personas.

#### 4.1 Name

Ask for the persona's `name`. It is the persona's identity in `config.json`,
logs and targets, not its Slack display name (that comes from its app). Any
non-empty name is accepted. The server derives a **key** from the name, used
for its agent-director instance and in targets, and shows it on the persona's
`persona-start` line in `server.log`. See the README's
`#### Persona name and key` for the rule.

Reject a name that equals an existing persona's name or key. A name of 1–40
lower-case letters, digits and `_` is its own key, so compare it directly.
Other names get a derived key with a hash; a clash there is still rejected
when the configuration is checked, as an `INVALID` pending change or a failed
first start.

Also reject a name whose key starts with an existing persona's key, or is the
start of one: `dev` beside `dev_2`, `horde` beside `horde_admin`, or `dev`
beside `"Dev Bot"` (key `dev_bot_…`). The server rejects such a pair, because
agent-director could act on the wrong persona's tmux session. Keys that only
share a start, such as `dev_a` and `dev_b`, are fine. When a name clashes
this way, propose the shorter one with `_main` appended (`horde_main`), or
`_main_2`, `_main_3`, … if that still starts with, or is the start of,
another key, and ask for another name if none fits. Rename an existing
persona only if the operator wants that.
When the operator names personas after the channels their earlier bots
served, check every pair of names this way before writing any entry.

#### 4.2 Slack app: create, name, avatar, install

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
terminal command in 4.10.

**Reusing an existing app** for this persona: an app created from an earlier
manifest lacks the `im:write` scope and must gain it and be re-installed. Point
to the debugging skill's entry "A persona can't open a DM: re-install its app
to gain `im:write`" (`skills/debug-slack-channel-bots/SKILL.md`) for the steps.
An app already used by another persona can't be reused.

#### 4.3 Credentials file path

Agree the `credentials_file` path: absolute or starting with `~/`, one file
per persona. Suggest `~/.config/cscb/<key>-credentials.json`. Use the
persona's key when the name is its own key (4.1); otherwise use a lower-case
form of the name with only `a-z`, `0-9` and `_`, as keys have. Reject a path
another persona already uses. The operator writes the file in 4.10, once the
persona is declared: the credentials command finds it in `config.json`.

#### 4.4 Working directory

Ask for the persona's `working_directory` (absolute, `~` or `~/…`): the
directory its Claude instance works in. Check that it exists:

```bash
test -d "<expanded path>" && echo "ok" || echo "not found"
```

A persona whose directory is missing stays down until the directory exists.
If another persona already uses the same directory (compare real paths, for
example with `(cd "<path>" && pwd -P)`), warn the operator: two personas can't
share one, and the configuration is rejected.

#### 4.5 Channels

For each channel the persona is in, collect:

- **`id`**: the channel ID (`C` or `G` followed by capital letters and digits,
  pattern `^[CG][A-Z0-9]+$`), not its name. In Slack, click the channel name;
  the ID is at the bottom of the **About** tab.
- **`delivery`**: `all` (every message in the channel) or `mentions` (only
  messages that @mention the persona directly, and `@here` / `@channel`
  broadcasts).

Tell the operator to invite the persona's app to each channel, in that
channel:

```
/invite @<the persona's bot display name>
```

A persona may have no channels only when its DMs are on (4.6). See the
README's `#### Channel entries` and `#### Channel delivery`.

#### 4.6 Direct messages

Ask whether the persona takes DMs (`dm.enabled`, off by default). If it does,
or if its prompts will go by DM (4.7), ask for `dm.contact`: the Slack user ID
of the person who receives its prompts and notices, pattern `^[UW][A-Z0-9]+$`.
In Slack, open that person's profile, then **⋮** → **Copy member ID**.

A persona with no channels must have DMs on. See the README's
"Direct messages" subsection.

#### 4.7 Permission prompts

Ask where the persona's permission prompts and server notices go
(`permission_prompts`, required):

- one of the persona's own channel IDs from 4.5, or
- `dm`, which needs `dm.enabled: true` and a `dm.contact`.

See the README's `#### Permission prompts`.

#### 4.8 Optional next-launch settings

Offer these only if the operator wants to override the top-level defaults
(README `#### Next-launch settings`):

- **`claude_config_dir`**: the persona's own Claude config directory, so it can
  use a different Claude account. Never `~/.claude`. The operator populates it
  before the persona first launches:

  ```bash
  CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai
  ```

  (`--console` for a Console account.) If a persona doesn't come up because
  its `claude_config_dir` can't be resolved, point to the debugging skill's
  `persona-config-dir-unresolvable` entry.
- **`stop_hook_bootstrap`**: `false` turns the Slack Reply Guard reminder off
  for this persona.

#### 4.9 Declare the persona

Show the operator the entry, for example:

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

Add `"dm": { "enabled": true, "contact": "<user ID>" }` and the 4.8 settings
only when chosen; leave `channels` out of a DM-only persona. Check the entry
against the README's `#### Load-time rules`, together with the personas
already in the file:

- the name and key, `working_directory` and `credentials_file` are each
  unique across personas;
- no persona's key starts with another persona's key (4.1);
- channel IDs and `dm.contact` match their patterns, and no channel is listed
  twice;
- `permission_prompts` is one of the persona's channels, or `dm` with DMs on
  and a contact;
- a persona with no channels has DMs on;
- every path is absolute, `~` or `~/…`;
- no key outside the README's `#### Persona fields` table.

On the operator's approval, append the entry to `personas` in `config.json`,
keeping every other field and persona unchanged.

#### 4.10 Write its credentials file

Give the operator the [Credentials command](#credentials-command) with the
persona's name filled in, and have them run it in their own terminal. After
they report success, check only that the file exists and has mode 0600:

```bash
ls -lL "<expanded credentials file path>"
```

`-rw-------` is mode 0600. Never open the file.

On a running server, the preview the server writes after 4.9 first reads
`is added but cannot come up: credentials file does not exist`. Once the file
is written the server writes a new preview; the operator confirms only after
it (Step 9). Then ask whether to add another persona.

---

### Step 5 — Server-wide settings (optional)

Only if the operator asks, set top-level settings such as `ack_reaction`,
`reply_chunk_limit`, `reply_chunk_mode`, `port` or `session_restart_delay`.
The README's `#### Server-wide settings` table lists each field, its type and
default. Write only the fields the operator sets.

---

### Step 6 — System prompt for the personas

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

Both are server-wide settings (Step 9 says when they take effect).

---

### Step 7 — Verify agent-director is installed

```bash
agent-director version
```

If `agent-director` isn't on `PATH`, or is older than the version the server
needs, point the operator to the `install-cscb` skill
(`skills/install-cscb/SKILL.md` in the package), which checks the install with
`bun run install-check` and walks through the fix. The server registers its
agent-director template at start; an `ad-template-install` line in
`$STATE_DIR/startup-errors.log` means that failed.

---

### Step 8 — Check settings.json for orphan legacy hook entries

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

### Step 9 — How the change takes effect

Explain the case that matches Step 3. Link to the README's `## Reload` section.

- **No last-applied record** (a fresh install): the first
  `claude-slack-channel-bots start` applies `config.json` as it stands. The
  operator starts it; you don't.
- **Server running:** within about 5 seconds the server writes
  `config.json.pending`, a preview of the change, and logs it in `server.log`.
  The operator reads it, including any `INVALID` or `DESTRUCTIVE:` line, then
  confirms by renaming `config.json.pending` to `config.json.apply`:

  ```bash
  cd "${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
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
  configuration, and the new persona stays pending. After the start, confirm
  as above.

A change to a server-wide setting is recorded when confirmed and takes effect
at the next server start (README `### When next-launch and server-wide changes
take effect`). `append_system_prompt_file` and `system_prompt_mode` from Step 6
are part of the agent-director template the server registers once, at start.
On a running server, a confirmation doesn't change that template: every
persona, including one the same change adds, keeps launching with the system
prompt settings the server started with. So whenever Step 6 changed anything
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
channels (or DM it) and wait for its answer.

```bash
grep -F 'persona-start:' "$STATE_DIR/server.log" | tail -n 20
grep -F '(key=<key>)' "$STATE_DIR/server.log" | tail -n 20
```

---

### Step 10 — Summary

Report:

- Each persona added: name, key if known, credentials file present with mode
  0600 or not, channels with their `delivery`, DMs on or off with the contact,
  and the `permission_prompts` destination.
- `append_system_prompt_file` configured, `system_prompt_mode: "none"`, or
  skipped.
- agent-director: installed (version) or missing.
- settings.json orphan legacy hooks: none, or found (needs cleanup).
- The next action from Step 9: start the server, or read and confirm
  `config.json.pending`. On a running server where Step 6 changed
  `append_system_prompt_file`, the system-prompt file or `system_prompt_mode`,
  add: after `reload-applied`, run `claude-slack-channel-bots clean_restart`.
- How to confirm each new persona came up (Step 9).

If a persona doesn't come up or doesn't answer, point the operator to
`/debug-slack-channel-bots`: `server.log` names the cause on the persona's
lines.

---

## Credentials command

The operator runs this one line in their own terminal (bash or zsh, on
linux-x64 or darwin-arm64), once the persona is declared in `config.json`
(4.9). Never paste a token into the chat. Before handing it over, replace
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
  revoked. Copy it again from the app's settings (4.2).
- `not_allowed_token_type` on `apps.connections.open`: the token given as the
  app-level token isn't one; generate an app-level token.
- An app-level token without the `connections:write` scope, or an app that
  isn't installed to the workspace, also fails: fix it in the app's settings
  (4.2) and run the command again.
- `could not reach Slack`: check the network, then run it again.

The `debug-slack-channel-bots` skill covers the server-side lines for a
persona whose tokens Slack refuses (`persona-credentials-refused`).

Replacing an existing persona's file on a running server makes a pending
credentials change: the server writes `config.json.pending`, and the change
takes effect only once the operator confirms it (Step 9, README `## Reload`).

---

## Rotate a persona's tokens

To replace an existing persona's tokens (for example after regenerating them
in Slack), give the operator the [Credentials command](#credentials-command)
with that persona's name. It asks before replacing the file. If the
persona's `credentials_file` is a symlink, the command replaces the link with
a regular file and leaves the old tokens in the file it pointed to: tell the
operator to delete that file by hand afterwards. On a running server, the
server then writes `config.json.pending` naming the persona's credentials
change; once the operator confirms it by the rename (Step 9), only that
persona reconnects. No restart is needed. On a stopped server, the next start
reads the new file as it stands. See the README's `## Reload` section.
