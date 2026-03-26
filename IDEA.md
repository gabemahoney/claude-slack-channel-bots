# Slack Channel Router — Multi-Session Claude Code ↔ Slack Bridge

## Origin

Currently, one Claude Code session (QueenBee) connects to Slack via `claude-code-slack-channel` (https://github.com/jeremylongshore/claude-code-slack-channel) — a community MCP server that bridges Slack Socket Mode to Claude Code's channel notification protocol. It works well for a single session, but we need multiple Claude Code sessions, each scoped to a different repo directory, each with its own Slack channel.

## Problem

The existing `server.ts` uses Slack Socket Mode, which opens a WebSocket per connection. If you run multiple instances of server.ts on the same Slack app, Socket Mode distributes events round-robin across connections — messages go to random sessions instead of the right one. 
There's no way to do deterministic channel-based routing with multiple Socket Mode connections on one app.

## Architecture Decision

Fork `jeremylongshore/claude-code-slack-channel` as the starting point and modify `server.ts` to support multi-session routing. 
One process, one Socket Mode connection, multiple Claude Code sessions.

### Design

```
Slack (QueenBee app — single bot, single Socket Mode connection)
  └── Router MCP Server (modified server.ts)
       │
       │  One Socket Mode WebSocket receives ALL messages
       │  Routes by channel ID → correct Claude Code session
       │
       ├── Channel C0ALJQU9KFF → Claude Code ~/projects (QueenBee, top-level orchestrator)
       ├── Channel CXXXBEES    → Claude Code ~/projects/bees_project
       ├── Channel CXXXCHAT    → Claude Code ~/projects/chatrpg_project
       └── Channel CXXXWAGG    → Claude Code ~/projects/waggle_project
```

### How It Works

**Inbound (Slack → Claude):**
1. Router receives Slack message via Socket Mode
2. Looks up channel ID in routing config
3. Finds the Claude Code session mapped to that channel
4. Sends `notifications/claude/channel` MCP notification down that session's stdio pipe

**Outbound (Claude → Slack):**
- Each Claude Code session has reply/react/fetch_messages tools
- All use the same bot token to call the Slack API directly
- Channel ID is explicit on every API call — no routing needed outbound

### Routing Config

Lives in `~/.claude/channels/slack/routing.json`:
```json
{
  "routes": {
    "C0ALJQU9KFF": { "cwd": "~/projects", "name": "queen-bee" },
    "CXXXBEES": { "cwd": "~/projects/bees_project", "name": "bees" },
    "CXXXCHAT": { "cwd": "~/projects/chatrpg_project", "name": "chatrpg" }
  }
}
```

### Key Decisions

1. **Fork server.ts, don't build from scratch** — the existing code already handles Socket Mode, MCP protocol, gate/access control, security layers. We add routing on top.
2. **One process, one WebSocket** — avoids the Socket Mode round-robin problem entirely.
3. **Router manages Claude Code lifecycle** — spawns sessions as child processes, holds their stdio pipes, restarts on crash. Alternative: connect to pre-existing tmux sessions, but that's more complex.
4. **Shared bot token** — all sessions use the same QueenBee bot token for outbound. No per-session Slack apps.
5. **Per-session access control** — each route can have its own access.json or inherit from the global one.
6. **Existing gate() logic preserved** — channel filtering, user allowlists, mention requirements all still apply per-route.

### What Each Sub-Session Does

Each Claude Code instance in a repo directory acts as a local orchestrator:
- Receives messages from its Slack channel
- Has its own CLAUDE.md with repo-specific instructions
- Can spawn worker agents (via Agent tool / configure_worktree) into sub-repos and worktrees within its directory
- Reports status back to its Slack channel

### Components to Build

1. **Routing layer in server.ts** — channel→session mapping, per-session stdio pipes, MCP notification dispatch
2. **Session manager** — spawns Claude Code processes, monitors health, restarts on crash
3. **Routing config** — JSON file defining channel→directory mappings
4. **Per-session tool scoping** — each session's reply/react tools should know their channel context

### What We Keep From the Original

- Socket Mode connection logic
- MCP server/tool registration pattern
- gate() security logic (lib.ts)
- All outbound tools (reply, react, edit_message, fetch_messages, download_attachment)
- Token loading and .env management
- access.json and pairing flow
