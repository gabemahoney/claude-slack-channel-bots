---
name: claude-slack-channels-config
description: Manage Slack channel bot access control — pairing, allowlist, channel opt-in, ack reactions, chunking
version: 1.0.0
author: Gabe Mahoney
license: MIT
user-invocable: true
argument-hint: "pair <code> | policy <mode> | add <user_id> | remove <user_id> | channel <id> [opts] | ack <emoji|off> | chunking <limit> [mode] | status"
allowed-tools: [Read, Write, Edit, Bash]
---

# /claude-slack-channels-config

Manage who can reach Claude Code sessions through Slack, and configure
message handling (ack reactions, chunking).

## Usage

```
/claude-slack-channels-config pair <code>                          # Approve a pending pairing
/claude-slack-channels-config policy <pairing|allowlist|disabled>   # Set DM policy
/claude-slack-channels-config add <slack_user_id>                   # Add user to allowlist
/claude-slack-channels-config remove <slack_user_id>                # Remove from allowlist
/claude-slack-channels-config channel <channel_id> [--mention] [--allow <user_id,...>]  # Opt in a channel
/claude-slack-channels-config channel remove <channel_id>           # Remove channel opt-in
/claude-slack-channels-config ack <emoji|off>                       # Set or clear ack reaction
/claude-slack-channels-config chunking <limit> [length|newline]     # Set text chunk limit and mode
/claude-slack-channels-config status                                # Show current config
```

## State File

```bash
STATE_DIR="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
# access.json lives at $STATE_DIR/access.json
# config.json lives at $STATE_DIR/config.json
```

Always resolve the state directory using `$SLACK_STATE_DIR` with fallback to
`~/.claude/channels/slack/`.

## Instructions

Parse `$ARGUMENTS` and execute the matching subcommand:

### `pair <code>`
1. Load `access.json`
2. Find the pending entry matching `<code>` (case-insensitive)
3. If not found: show "No pending pairing with that code."
4. If found:
   - Add `entry.senderId` to `allowFrom`
   - Remove the pending entry
   - Save `access.json` with permissions 0o600
   - Show: `Approved! User <senderId> can now DM this session.`
   - Send a confirmation message to the user in Slack via the reply tool

### `policy <mode>`
1. Validate mode is one of: `pairing`, `allowlist`, `disabled`
2. Update `dmPolicy` in `access.json`
3. Save with 0o600
4. Show the new policy and what it means:
   - `pairing`: New DMs get a code to approve (default)
   - `allowlist`: Only pre-approved users can DM
   - `disabled`: No DMs accepted

### `add <user_id>`
1. Add the Slack user ID to `allowFrom` (deduplicate)
2. Save with 0o600
3. Show confirmation

### `remove <user_id>`
1. Remove from `allowFrom`
2. Also remove from any channel-level `allowFrom` lists
3. Save with 0o600
4. Show confirmation

### `channel <channel_id> [--mention] [--allow <ids>]`
1. Parse options:
   - `--mention`: require @mention to trigger (default: false)
   - `--allow <id1,id2>`: restrict to specific users in that channel
2. Add/update `channels[channel_id]` in `access.json`
3. Save with 0o600
4. Show the channel policy

### `channel remove <channel_id>`
1. Delete `channels[channel_id]`
2. Save with 0o600
3. Show confirmation

### `ack <emoji|off>`
1. If argument is `off`: remove `ackReaction` from `access.json`
2. Otherwise: set `ackReaction` to the provided emoji name (without colons)
3. Save with 0o600
4. Show confirmation: "Ack reaction set to :<emoji>:" or "Ack reaction disabled."

### `chunking <limit> [length|newline]`
1. Parse `<limit>` as a positive integer — this sets `textChunkLimit`
2. If a second argument is provided, validate it is `length` or `newline` — this sets `chunkMode`
3. If no second argument, leave `chunkMode` unchanged
4. Save with 0o600
5. Show confirmation with the new values

### `status`
1. Load `access.json`
2. Load `config.json` from the same state directory
3. Display:
   - DM policy
   - Allowlisted user IDs
   - Opted-in channels with their policies, showing two categories:
     - **Implicit** — channels present in `config.json` routes (automatically opted-in)
     - **Explicit** — channels configured in `access.json` channels (with their `requireMention` and `allowFrom` settings)
   - Pending pairings (code + sender ID + expiry)
   - Ack reaction setting (or "not set")
   - Text chunk limit (or "not set, default: 4000")
   - Chunk mode (or "not set, default: newline")

## Security

- Always use atomic writes (write to .tmp then rename) for `access.json`
- Always set 0o600 permissions on `access.json`
- If `access.json` is corrupt, move it aside and start fresh
