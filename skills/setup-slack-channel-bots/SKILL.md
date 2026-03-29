---
name: setup-slack-channel-bots
description: Interactive setup wizard for claude-slack-channel-bots — checks tokens, routing.json, access.json, hooks, and Claude Code settings
version: 1.0.0
author: Jeremy Longshore <jeremy@intentsolutions.io>
license: MIT
user-invocable: true
argument-hint: ""
allowed-tools: [Read, Write, Edit, Bash, Glob]
---

# /setup-slack-channel-bots

Interactive setup wizard for `claude-slack-channel-bots`. Walks through every
required configuration step in order, skipping anything already done. Handles
partial configs gracefully — only prompts for what is missing.

## Constraints

- NEVER start the server (`claude-slack-channel-bots start` or `bun server.ts`).
- NEVER modify `.ts` source files in the package.
- NEVER write files outside `~/.claude/` paths (and the shell profile when
  adding `export` statements).
- NEVER echo raw token values back to the user after they have been entered.

---

## Setup Steps

Work through each step in order. If a step is already complete, say so briefly
and move on.

---

### Step 1 — Read the README for authoritative instructions

Locate the installed package README:

```bash
# Find the globally installed package README
bun pm ls -g 2>/dev/null | grep claude-slack-channel-bots || true
# Likely location:
ls "$(bun --print 'process.execPath' | xargs dirname)/../lib/node_modules/claude-slack-channel-bots/README.md" 2>/dev/null || true
```

If the README is found, read it and use it as the authoritative reference for
all subsequent steps. If not found, proceed using the instructions in this skill
file.

---

### Step 2 — Slack App Manifest

Before checking tokens, ensure the user has a Slack app. If they don't have
tokens yet, they need to create the app first.

Inform the user where to find the Slack App Manifest:

The manifest file is included in the installed package at:

```
<package-root>/slack-app-manifest.yml
```

To create the Slack app from it:
1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From a manifest**
3. Select your workspace
4. Switch format to **YAML**
5. Paste the contents of `slack-app-manifest.yml`
6. Review and create

This provisions all required OAuth scopes, Socket Mode, and interactivity
settings in one step.

After creation:
1. **Install to workspace** — Go to **OAuth & Permissions** → **Install to
   Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`).
2. **Generate app-level token** — Go to **Basic Information** → **App-Level
   Tokens** → **Generate Token and Scopes** → add the `connections:write`
   scope → copy the resulting `xapp-…` token.

If the user already has a Slack app and tokens, skip this step.

---

### Step 3 — Check environment variables

Check whether `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set:

```bash
echo "BOT: ${SLACK_BOT_TOKEN:+set}" ; echo "APP: ${SLACK_APP_TOKEN:+set}"
```

**If either is missing:**

1. Ask the user to provide the missing token(s).
2. Validate the format before accepting:
   - `SLACK_BOT_TOKEN` must start with `xoxb-`
   - `SLACK_APP_TOKEN` must start with `xapp-`
   If the format is wrong, explain the expected prefix and ask again.
3. Validate the token by calling the Slack API:
   ```bash
   curl -s -X POST https://slack.com/api/auth.test \
     -H "Authorization: Bearer <token>"
   ```
   Check that the response contains `"ok": true`. If not, show the `error`
   field from the response and ask the user to check the token.
4. After successful validation, show the user the exact `export` lines to add
   to their shell profile (`~/.bashrc` or `~/.zshrc`):
   ```sh
   export SLACK_BOT_TOKEN=xoxb-...
   export SLACK_APP_TOKEN=xapp-...
   ```
   Do not add these automatically; instruct the user to paste them into their
   profile and open a new terminal (or `source` the profile) before running
   `start`.

**If both are already set**, validate their formats. If a token is set but has
the wrong prefix, warn the user. Offer to validate them against the API if they
want confirmation.

---

### Step 4 — Check routing.json

State directory defaults to `~/.claude/channels/slack/`. Respect
`$SLACK_STATE_DIR` if set.

```bash
STATE_DIR="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
cat "$STATE_DIR/routing.json" 2>/dev/null || echo "NOT_FOUND"
```

**If the file does not exist:**

Run postinstall to create the skeleton, then prompt to populate it:

```bash
# Only if the package is installed globally:
bun postinstall.ts  # or: claude-slack-channel-bots postinstall
```

Or inform the user they can create it manually:

```json
{
  "routes": {}
}
```

**If the file exists but `routes` is empty or a skeleton:**

The file needs at least one route entry. For each missing route, prompt the
user for:

1. **Slack channel ID** — a string that starts with `C` (e.g. `C0123456789`).
   Explain: find it in the Slack UI by right-clicking the channel name →
   "Copy link" or "View channel details".
2. **Local project directory** — the absolute or `~/`-prefixed path to the
   repo that Claude Code session will work in.

Verify the directory exists:

```bash
test -d "<expanded-path>" && echo "ok" || echo "not found"
```

Expand `~` before checking. If the directory does not exist, warn the user and
ask whether to proceed anyway or provide a different path.

After collecting at least one route, write the updated `routing.json`.

**Optional routing fields** — after required routes are set, offer these with
their defaults. Prompt only if the user wants to customise:

| Field | Default | Description |
|---|---|---|
| `default_route` | (none) | CWD of session that handles messages from unknown channels. Must match an existing route `cwd`. |
| `default_dm_session` | (none) | CWD of session that handles direct messages. Must match an existing route `cwd`. |
| `bind` | `"127.0.0.1"` | Interface the HTTP server binds to. |
| `port` | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | `60` | Seconds before auto-restarting a crashed session. `0` disables auto-restart. |
| `mcp_config_path` | `~/.claude/slack-mcp.json` | Path to the MCP config file used when launching sessions. |

**Prompting for `default_route` and `default_dm_session`:**

These fields must match an existing route `cwd`. When prompting the user for
either value:

1. Collect the list of `cwd` values from the `routes` object that was just
   configured (or already present in the file).
2. Present that list as the only valid options, numbered for easy selection.
   Example:
   ```
   Available route cwds:
     1) /home/alice/project-a
     2) /home/alice/project-b
   Enter the number of your choice (or leave blank to skip):
   ```
3. Accept either the number or the exact cwd path typed in full.
4. Do not accept a free-form path that is not in the list.

**Validation before writing:**

Before writing `routing.json`, verify that any value supplied for
`default_route` or `default_dm_session` exactly matches one of the `cwd`
values in `routes`. If a value does not match:

- Warn the user: "The value `<value>` does not match any configured route cwd."
- Show the list of valid cwds again.
- Re-prompt until the user enters a valid cwd or explicitly chooses to skip
  the field (leaving it unset).

Only write the field once a valid value is confirmed.

Write the final `routing.json` with only the fields the user explicitly set
(plus the required `routes`). Do not write optional fields the user left at
their defaults unless asked.

---

### Step 5 — Check access.json

```bash
STATE_DIR="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
cat "$STATE_DIR/access.json" 2>/dev/null || echo "NOT_FOUND"
```

**If the file does not exist:**

Inform the user that postinstall creates a skeleton with safe defaults:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
```

The skeleton is created automatically on `bun install -g`. If it is still
missing, run postinstall or create the file manually with the above content
(`chmod 600`).

**If the file exists**, show a brief summary of the current settings (dm
policy, number of allowlisted users, opted-in channels). Explain
customisation options:

- `dmPolicy`: `"pairing"` (new DMs get a one-time code), `"allowlist"` (only
  pre-approved users), or `"disabled"` (all DMs dropped).
- Channels are not opted in by default. Use `/slack-channel-access channel
  <id>` at runtime to add them, or edit `access.json` directly.
- `ackReaction`: emoji name (without colons) to react with on receipt.
- `textChunkLimit` / `chunkMode`: controls how long replies are split.

Do not modify `access.json` during setup unless the user asks to.

---

### Step 6 — Check hooks

Check whether the relay hooks exist and are executable:

```bash
ls -la ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh 2>/dev/null || echo "NOT_FOUND"
```

**If either hook is missing:**

Provide the copy and chmod commands. The source path depends on how the
package was installed. Try to detect it:

```bash
# Attempt to find the package hooks directory
bun pm ls -g 2>/dev/null | grep -o "claude-slack-channel-bots.*" | head -1 || true
```

Show the user the exact commands:

```bash
mkdir -p ~/.claude/hooks

# Copy from the installed package (adjust path if needed):
cp "$(npm root -g)/claude-slack-channel-bots/hooks/permission-relay.sh" ~/.claude/hooks/
cp "$(npm root -g)/claude-slack-channel-bots/hooks/ask-relay.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh
```

Or, to keep them in sync with future package updates, symlink instead:

```bash
HOOKS_DIR="$(npm root -g)/claude-slack-channel-bots/hooks"
ln -sf "$HOOKS_DIR/permission-relay.sh" ~/.claude/hooks/permission-relay.sh
ln -sf "$HOOKS_DIR/ask-relay.sh" ~/.claude/hooks/ask-relay.sh
```

Also remind the user that `curl` and `jq` must be on `PATH` for the hooks to
work.

**If both hooks exist**, confirm they are executable (`-x`). If not, show:

```bash
chmod +x ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh
```

---

### Step 7 — Check Claude Code settings.json for hook entries

Read `~/.claude/settings.json` and check whether the `PermissionRequest` and
`PreToolUse` hook entries for the relay scripts are present.

**Check for `PermissionRequest` entry:**

Look for an entry inside `hooks.PermissionRequest` with:
```json
{ "type": "command", "command": "~/.claude/hooks/permission-relay.sh" }
```

**Check for `PreToolUse` entry:**

Look for an entry inside `hooks.PreToolUse` with:
```json
{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "~/.claude/hooks/ask-relay.sh" }] }
```

**If either entry is missing**, show the user the exact JSON to add. This is
the complete block for both entries:

```jsonc
"PermissionRequest": [
  {
    "matcher": ".*",
    "timeout": 2000000,
    "hooks": [{ "type": "command", "command": "~/.claude/hooks/permission-relay.sh" }]
  }
],
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "timeout": 2000000,
    "hooks": [{ "type": "command", "command": "~/.claude/hooks/ask-relay.sh" }]
  }
]
```

Add these under the top-level `"hooks"` key in `settings.json`. Existing
entries in those arrays should be preserved — append, do not replace.

If `settings.json` does not exist or does not have a `"hooks"` key, show the
user the full minimal structure to add.

Offer to write the missing entries automatically to `~/.claude/settings.json`.
If the user agrees, make the targeted edits, preserving all existing content.

---

### Step 8 — Summary

Print a final summary of what was checked and configured:

- Environment variables: set / missing
- Token format: valid / invalid
- routing.json: populated (N routes) / skeleton
- access.json: present / missing
- permission-relay.sh hook: present and executable / missing
- ask-relay.sh hook: present and executable / missing
- settings.json PermissionRequest hook: present / missing
- settings.json PreToolUse hook: present / missing

Remind the user:

> To start the server, run:
> ```sh
> claude-slack-channel-bots start
> ```
> The server runs in the background. Stop it with `claude-slack-channel-bots stop`.
> Claude Code sessions in each routed project directory will be launched
> automatically via tmux. Each session needs the MCP config:
> `~/.claude/slack-mcp.json` (created by postinstall).
