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
- Tests need to import the logic without triggering server-side side effects (loading .env, connecting sockets)
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
- Sensitive files (`.env`, `access.json`): `chmod 0o600`
- No secrets in config files that don't need them (routing.json, sessions.json)
- Gate all inbound Slack messages through the `gate()` function before processing

## Naming Conventions

- Module-scoped Maps: camelCase (e.g., `pendingPermissions`, `completedDecisions`)
- Interfaces: PascalCase (e.g., `PendingPermission`, `SessionEntry`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_PENDING`, `STATE_DIR`)
- Functions: camelCase, verb-first (e.g., `registerSession`, `buildPermissionBlocks`)
- Section comments: `// ---` separator with descriptive header

## Async Patterns

- Use `async/await` throughout — no raw Promises except where explicitly holding connections open (permission relay long-poll)
- Long-poll pattern: create a Promise, register a resolve callback in a waiters array, race against a setTimeout
- Always clean up on abort: `req.signal.addEventListener('abort', ...)` for held HTTP connections
- Use `settled` flag pattern to prevent double-resolution in race conditions
