# Engineering Best Practices

## Language and Runtime

- TypeScript with strict mode enabled
- Bun as the runtime and test runner
- ES2022 target, ESNext modules with bundler resolution
- Import .ts extensions explicitly (e.g., `import { foo } from './bar.ts'`)

## Module Organization

### Separation of Concerns

- **Pure logic** goes in dedicated modules (lib.ts, config.ts) — side-effect-free, importable by tests
- **Stateful registries** go in their own modules (registry.ts) — module-scoped Maps, exported CRUD functions, `_reset` functions for tests
- **Server wiring** stays in server.ts — Socket Mode handlers, HTTP routing, startup/shutdown, process lifecycle

### When to Extract

Extract to a new module when:
- A concern has its own types + state + functions (e.g., registry.ts owns session Maps)
- Tests need to import the logic without triggering server-side side effects (connecting sockets, starting listeners)
- The module is independently testable

Do NOT extract prematurely — a few related functions in server.ts are fine until they grow.

## Error Handling

- Use `try/catch` around external calls (Slack API, file I/O, tmux commands)
- Log errors to stderr with the `[slack]` prefix: `console.error('[slack] context: description', err)`
- Non-critical failures (reaction add, message update) use empty catch blocks with `/* non-critical */` or `/* ignore */`
- Critical failures (token loading, routing config) exit the process with a clear message

## Configuration

- Routing config lives at `~/.claude/channels/slack/routing.json`
- State directory is `~/.claude/channels/slack/` (overridable via `SLACK_STATE_DIR` env var)
- New config fields: add to `RoutingConfigInput` (optional), `RoutingConfig` (with default), `applyDefaults()`, and `validateConfig()`
- Atomic file writes: write to `.tmp` file, then `renameSync` to final path

## Security

- Localhost-only endpoints: check `server.requestIP(req)` for `127.0.0.1`, `::1`, and `::ffff:127.*`
- Sensitive files (`access.json`): `chmod 0o600`
- No secrets in config files that don't need them (routing.json, sessions.json)
- Gate all inbound Slack messages through the `gate()` function before processing

## Naming Conventions

- Module-scoped Maps: camelCase (e.g., `pendingPermissions`, `completedDecisions`)
- Interfaces: PascalCase (e.g., `PendingPermission`, `SessionEntry`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_PENDING`, `STATE_DIR`)
- Functions: camelCase, verb-first (e.g., `registerSession`, `buildPermissionBlocks`)
- Section comments: `// ---` separator with descriptive header

## Auto-Restart

When a managed session's MCP connection closes, `onsessionclosed` calls `scheduleRestart()` in `restart.ts` to schedule a delayed relaunch.

### Configuration

`session_restart_delay` in `routing.json` sets the delay in seconds before attempting a relaunch. Default is 60. Set to 0 to disable auto-restart entirely — the server will log `Auto-restart disabled (delay=0)` and skip all scheduling for that disconnect.

### Failure Limiting

The restart module tracks consecutive relaunch failures per channel. After 3 consecutive failures (`MAX_CONSECUTIVE_FAILURES`), the module stops retrying for that channel. The counter resets to 0 when the session successfully reconnects and registers. Restarting the server process also resets all counters — the state is module-scoped and not persisted.

### Log Messages

All restart activity is logged to stderr with the `[slack]` prefix:

| Message | Meaning |
|---|---|
| `[slack] Scheduling restart for channel=<id> in <N>s` | Restart timer queued |
| `[slack] Auto-restart disabled (delay=0) — skipping restart for channel=<id>` | Restart skipped; feature disabled |
| `[slack] Max consecutive failures (3) reached — giving up on channel=<id>` | Retry limit hit; no more attempts |
| `[slack] Session already live — skipping restart for channel=<id>` | Liveness check passed; no action needed |
| `[slack] Relaunching session for channel=<id> cwd="<path>"` | Relaunch attempt starting |
| `[slack] Session relaunch failed for channel=<id> (failure N/3)` | Relaunch failed; failure counter incremented |
| `[slack] Skipping restart — server is shutting down (channel=<id>)` | Timer fired during shutdown; abort |
| `[slack] Cancelled restart timer for channel=<id>` | Pending timer cleared on graceful shutdown |

## Health-Check Poller

`health-check.ts` runs a `setInterval` loop that checks every configured route on a fixed cadence and schedules restarts for sessions that are dead and not already being recovered.

### Configuration

`health_check_interval` in `routing.json` sets the polling interval in seconds. Type: `number`. Default: `120`. Set to `0` to disable the poller entirely — `startHealthCheck()` returns immediately without creating an interval.

### Async Interval Pattern

Each tick fires an `async` callback. The callback iterates routes sequentially (not in parallel) to avoid flooding tmux with concurrent `isClaudeRunning` calls. Errors on a single channel are caught and logged; they do not abort the rest of the iteration.

```typescript
intervalId = setInterval(async () => {
  for (const [channelId, cwd] of Object.entries(routes)) {
    try {
      // check and maybe scheduleRestart
    } catch (err) {
      console.error(`[slack] health-check: error checking channel=${channelId}:`, err)
    }
  }
}, intervalSeconds * 1000)
```

### Coordination with restart.ts

Before calling `scheduleRestart`, the poller queries two guards from `restart.ts`:

- `isRestartPendingOrActive(channelId)` — returns `true` if a restart timer is queued or a launch is in flight; skip to avoid double-launching
- `hasReachedMaxFailures(channelId)` — returns `true` if the channel has hit `MAX_CONSECUTIVE_FAILURES`; skip to respect the failure limit

When neither guard fires and the session is dead, the poller calls `scheduleRestart(channelId, cwd)` — the same function used by the reactive `onsessionclosed` path.

## Async Patterns

- Use `async/await` throughout — no raw Promises except where explicitly holding connections open (permission relay long-poll)
- Long-poll pattern: create a Promise, register a resolve callback in a waiters array, race against a setTimeout
- Always clean up on abort: `req.signal.addEventListener('abort', ...)` for held HTTP connections
- Use `settled` flag pattern to prevent double-resolution in race conditions
