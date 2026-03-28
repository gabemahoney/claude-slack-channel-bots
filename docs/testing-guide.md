# Test Writing Guide

## Framework

- Bun Test (`bun:test`) — `describe`, `test`, `expect`, `beforeEach`
- Run all tests: `bun test`
- Run one file: `bun test <file>`

## Test File Organization

Each source module has a corresponding test file in the project root:

| Source | Test File | What It Tests |
|--------|-----------|---------------|
| lib.ts | server.test.ts | gate(), assertSendable, assertOutboundAllowed, chunkText, sanitizeFilename |
| config.ts | config.test.ts | applyDefaults, validateConfig, expandTilde, resolveConfig, loadConfig |
| registry.ts | registry.test.ts | Session registry CRUD, routing, pending sessions |
| server.ts (DM routing) | dm-routing.test.ts | DM routing via gate() + registry |
| server.ts (permission relay) | permission-relay.test.ts | /permission endpoint with stubbed server |

New features that add significant logic should get their own test file (e.g., `session-manager.test.ts`).

## Fixture Patterns

### Factory Functions

Every test file defines factory functions that create fixtures with sensible defaults and optional overrides:

```
makeRoutingConfig(opts?) — builds a RoutingConfig with two test routes
makeRoute(cwd?) — builds a single RouteEntry
makeAccess(overrides?) — builds an Access config
makeOpts(overrides?) — builds GateOptions with stubs
makeTransport() — minimal transport stub
makeServer() — minimal MCP server stub
```

Always use factory functions instead of hardcoding fixture values in individual tests. When a new field is added to a type, update the factory function — all tests automatically pick up the default.

### State Reset

Use `beforeEach` to reset module-scoped state between tests:

- Registry: `_resetRegistry()` (exported from registry.ts)
- Test-local Maps/Sets: reassign in `beforeEach`

### Stubbing External Dependencies

- **WebClient**: Create stub functions (e.g., `stubPostMessage`, `stubChatUpdate`) that record calls to a capture array and return mock responses
- **SocketModeClient**: Simulate events by directly calling the handler logic with mock payloads
- **server.ts side effects**: Cannot import server.ts in tests (module-scope side effects). Instead, replicate the relevant logic in a self-contained test server or test the extracted pure functions

### Self-Contained Test Servers

When testing HTTP endpoints that live in server.ts, create a minimal Bun.serve() in the test file that replicates the endpoint logic with stubbed dependencies. This pattern is used by permission-relay.test.ts:

- Bind to port 0 (random available port) to avoid conflicts
- Share Maps between test code and server handler via closure
- Stop the server in afterAll()

## Assertions

- Use `expect(x).toBe(y)` for primitives
- Use `expect(x).toEqual(y)` for objects/arrays
- Use `expect(x).toBeUndefined()` / `toBeDefined()` for presence checks
- Avoid `.toBeTruthy()` / `.toBeFalsy()` — be specific about expected values
- When testing async behavior through closures, use non-null assertions (`resolved!`) if TypeScript narrows incorrectly

## What to Test

- Happy path for each public function
- Error cases (invalid input, missing data, API failures)
- Edge cases from the SRD/PRD
- Concurrent operations (e.g., multiple pending requests)
- Cleanup on abort/disconnect
- State isolation between tests (no leaking via module-scoped Maps)

## What NOT to Test

- Internal implementation details (private helper functions)
- Exact log output (test behavior, not logging)
- Timing-dependent behavior with real delays — use short configurable timeouts in tests
