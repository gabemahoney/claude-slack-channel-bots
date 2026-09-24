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
| config.ts | config.test.ts | applyDefaults, validateConfig, expandTilde, resolveConfig, loadConfig; resolveRealPath (real path, lexical fallback, injected realpath); persona loader (resolvePersonaConfig, loadPersonaConfig), cross-persona rejections (duplicate name or key, shared working_directory or credentials_file), non-collision controls, SR-14 rejection table; every persona rejection passes `assertNoLeak` |
| registry.ts | registry.test.ts | Session registry CRUD, routing, pending sessions |
| server.ts (DM routing) | dm-routing.test.ts | DM routing via gate() + registry |
| server.ts (permission relay) | permission-poller.test.ts, permission-click-handler.test.ts | SR-2.1 poller loop and Block Kit click handler |
| persona-identity.ts | persona-identity.test.ts | persona key rule, derived identifiers, persona-name rendering |
| persona-credentials.ts, persona-bringup.ts, persona-diagnostics.ts | persona-connections.test.ts | checkPersonaCredentials (valid, missing, unreadable and each invalid shape), checkPersonaWorkingDirectory (missing, not a directory, unreadable, unsearchable), checkPersonaLocalBringUp (both causes reported), real-path collisions with another applied persona, no environment token read, no file written, diagnostic class labels and line format (causes escaped to one line), success values that never print a token |
| persona-slack-validation.ts, persona-retry-schedule.ts, persona-slack-episodes.ts | persona-connections.test.ts | classifySlackValidationError on each leg an outcome applies to (`auth.test`, `socket-mode` or both) and botIdentityFromAuthTest on the `auth.test` leg: up, Slack-unreachable (with reason) or credentials-refused for every scripted Slack outcome; createPersonaRetrySchedule (5 s doubling to 300 s, no cap, reset, per-persona isolation, `retryAfter` honoured); createSlackEpisodeTracker (one start line and one cleared line per episode, class changes, per-persona isolation) |
| backoff.ts | backoff.test.ts | Per-channel failure counts, nextBackoffDelay, doublingBackoffDelay (doubling per prior attempt, clamped to the ceiling), isAtCap, shouldNotifyCap, per-channel isolation |

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

New persona-loader tests use the shared persona-config helper, `tests/test-helpers/persona-config.ts`, instead of local route factories. Route-loader tests keep using the route helpers until E3 removes the route loader:

```
makePersona(overrides?, baseDir?) — one PersonaInput entry in file form; default paths sit under baseDir
makePersonaConfigInput(overrides?, baseDir?) — a PersonaConfigInput file-form config with one default persona
makePersonaConfig(overrides?, baseDir?) — a resolved PersonaConfig, as loadPersonaConfig returns it, except mcp_config_path (see below)
writeConfigFile(dir, input) — writes input as JSON to <dir>/config.json and returns the path
```

`baseDir` defaults to the OS temp directory; pass the test's own `mkdtempSync` directory when paths must exist or be unique to the test. `writeConfigFile` writes only into the caller-supplied temp directory and has no default location. Pass `loadPersonaConfig` a temp home as well, so `~` never expands to the real home. Remove both the temp directory and the temp home in `afterEach`.

`makePersonaConfig` puts `mcp_config_path` under `baseDir`, but the loader defaults it to `~/.claude/slack-mcp.json` under the home you pass. When comparing against loader output, override `mcp_config_path` with the loader's value (e.g. `join(home, '.claude', 'slack-mcp.json')`).

### Credentials Fixtures and Leak Checks

Any test that touches Slack tokens or a persona credentials file uses the shared helper `tests/test-helpers/credentials.ts`. It builds fake tokens that all carry one marker, `LEAK_SENTINEL`, and checks captured output for that marker or any token-like value. A leak then fails a test instead of reaching a log.

| Export | Use it for |
|--------|------------|
| `LEAK_SENTINEL` | The marker every fake token embeds. It uses identifier characters only, so an error that quotes an identifier quotes the whole sentinel. Refer to the constant; never copy its value into a test. |
| `BOT_TOKEN_PREFIX`, `APP_TOKEN_PREFIX` | The Slack token prefixes, for building fakes and for asserting on rule text. A bare prefix is not a token. |
| `fakeToken(prefix, suffix?)` | One fake token built at runtime: the prefix, then the sentinel, then an optional suffix. Use distinct suffixes to tell two fakes apart; pass a wrong prefix or none for bad-prefix cases. |
| `makeCredentials(overrides?)` | A credentials object. By default it is valid (exactly `bot_token` and `app_token`, distinct fakes); an override set to `undefined` removes that key, and any other override adds or replaces one. |
| `writeCredentialsFile(dir, name?, overrides?)` | Writes a credentials file with mode 0600 inside `dir` and returns its path. An object override merges over the valid defaults; a string override is the whole file content, for non-JSON or non-object cases. `dir` is required and `name` must stay inside it. |
| `writtenFile(path)` | Marks a file or directory the code under test wrote, so `assertNoLeak` checks its content. This is the only way to check a file: a plain string is always checked as text, never read as a path. |
| `assertNoLeak(captured, label?)` | Fails if the sentinel (any case) or a token-like value appears anywhere in `captured`. Strings, errors (message, stack, properties, `cause`, aggregated errors), arrays, objects, maps, sets, buffers and `writtenFile` marks are all checked, recursively. |

Rules:

- **Fakes only.** Tests use only tokens from `fakeToken`, `makeCredentials` or `writeCredentialsFile`, so every token embeds `LEAK_SENTINEL`. No test file contains a token literal, not even a fake one; build it at runtime from the prefix constants.
- **Check everything captured.** Every test that handles credentials runs `assertNoLeak` over its captured log lines, errors and results, including rejected calls and failure paths. Pass them together as one object so a failure names the leaking item (for example `captured.lines[2]`). Wrap any file the code wrote in `writtenFile`.
- **Override the token environment.** A suite that touches `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` sets both to fakes for its whole run and restores the previous values afterwards, so an ambient real token can never reach a failure message.
- **Why the failure is safe.** `assertNoLeak` reports which item leaked and whether it held the sentinel or a token-like value, never the leaked text. Rule text such as "must start with" a bare prefix passes.

Isolation (SR-13.2) applies to credentials files and working-directory fixtures exactly as it does to config files:

- Create them only under the test's own `mkdtempSync` directory, pass every path explicitly, and remove the directory in `afterEach`. `writeCredentialsFile` has no default location and refuses a name that escapes `dir`.
- Never read or write `~/.claude/channels/slack` or `~/.agent-director`, and never point a credentials path at the real home.
- When a test compares real paths (for example a symlinked credentials file shared with another persona), resolve the temp directory with `realpathSync` first; the OS temp directory may itself be a symlink.

Permission cases (an unreadable credentials file, an unreadable or unsearchable working directory) inject a failing operation through the check's file-system seam, so they pass under root in docker CI. A variant that uses real permission bits is marked `test.skipIf(isRoot)`, with the reason in the test name. Restore any mode a test changed before `afterEach` removes the directory.

### Slack Stub

New persona and connection suites fake Slack with the shared helper `tests/test-helpers/slack-stub.ts`, not with hand-rolled WebClient or SocketModeClient stubs. `makeStubSlack(opts?)` builds one independent fake Slack for one persona. It has no module-scope state, network, file system, environment access or timers, and its error shapes follow the installed `@slack/web-api` and `@slack/socket-mode` libraries.

| Member | What it gives a test |
|--------|----------------------|
| `identity` | The bot user ID, bot ID and team ID a successful `auth.test` returns. The bot user ID and bot ID default to random values, distinct per stub; the team ID defaults to a fixed value. Override them through `botUserId`, `botId` and `teamId`. |
| `script` | Outcome queues `authTest`, `connect` (socket `start()`) and `post` (`chat.postMessage`). Seed them through the options of the same names, or push onto them at any time. Each call takes the next outcome; an empty queue means success. |
| `calls` | Capture arrays of call arguments: `authTest`, `postMessage`, `update`, `reactionsAdd`, `reactionsRemove`, `conversationsOpen`, `usersInfo`. Every Web API client of the stub shares them. |
| `web` | A ready Web API client with default options, for direct calls. |
| `createWebClient(token?, options?)` | Builds a Web API client as the real constructor would; recorded in `options.web`. |
| `createSocketClient(options?)` | Builds a socket client; recorded in `options.socket` and `sockets`. Throws on an empty app token, as the real constructor does. |
| `options` | The options every client was built with, in build order (`web`, `socket`). |
| `sockets`, `socket` | Every socket client built, and the latest one (`socket` throws if none was built). |

The socket stub behaves like `SocketModeClient` with auto-reconnect off:

- `start()` takes the next `connect` outcome and first runs the connect leg (`apps.connections.open`). A failure there (the Web API kinds, `no-url` or `reject`) rejects `start()` with no lifecycle event.
- Otherwise `start()` emits `authenticated` and `connecting`, and the WebSocket phase settles on a later microtask according to the outcome. `startCalls` counts calls, and `start()` can be called again after a drop, so a test can drive a reopen.
- `drop()` is Slack closing the connection, the case the connection manager reopens: it emits `close` and `disconnected`, and a `start()` still waiting for `hello` rejects with no value. `disconnect()` is the client's own close, which is not reopened: it is counted in `disconnectCalls` and emits `disconnecting`, then `close` (if a WebSocket phase ever began) and `disconnected`.
- `deliver(event)` sends an Events API event and `deliverInteractive(payload)` an interactive payload, in the shape `server.ts` consumes. Both need a connected socket and resolve once every listener settles.
- `acks` records each ack in order; `lifecycle` records every lifecycle event emitted, in order.

**Scripted outcomes.** Each queue entry is one outcome kind:

| Kind | Result |
|------|--------|
| `ok` | Success. On `auth.test` and `post`, an optional `result` is merged over the default response; a key set to `undefined` is removed. |
| `platform` | A named Slack error (an `ok: false` answer) with that `error`, and an optional `retryAfter` in the response metadata. |
| `network`, `dns`, `timeout`, `http`, `rate-limited` | Slack unreachable: a request error, an HTTP error with a status, or a rate-limited error with `retryAfter` in seconds. |
| `no-url` | Connect only: `apps.connections.open` answered without a URL. `start()` rejects with a plain error on the connect leg, with no lifecycle event. |
| `closed-before-hello`, `websocket-error` | Connect only: the WebSocket closes before `hello`. `start()` rejects with no value after `close` and `disconnected`; `websocket-error` emits `error` first. |
| `never` | The call never settles. A pending `start()` ends only on `drop()` or `disconnect()`. |
| `reject` | The call rejects with the given value exactly as given (a plain error, a string, `undefined` and so on). |

Set `leakMarker` to `LEAK_SENTINEL` and every error the stub builds carries the marker wherever a real error can hold secrets: the message, the wrapped `original` error and its headers, HTTP headers and body, fields of `data`, and the error the socket's `error` event carries. `data.error` stays exactly as scripted, so classification still sees the real Slack error code.

Not every failure carries the marker. A rejection with no value carries nothing: `closed-before-hello`, and the `start()` rejection after `websocket-error`. `reject` passes its value unchanged, so plant the sentinel in the value if the row needs it. Run `assertNoLeak` over what the code under test produced (see Credentials Fixtures and Leak Checks).

**Event factories.** `makeChannelMessage`, `makeDm`, `makeBotMessage`, `makeWebhookPost` and `makeAppMention` build Slack events with defaults and overrides (a key set to `undefined` is removed). `mentionText(userId)` and `broadcastText(kind?)` build mention and broadcast text for message bodies; pass the stub's `identity.botUserId` to mention that stub's bot.

**Reference example.** The `Slack validation classification (both legs, sentinel-bearing errors)` describe block in `tests/persona-connections.test.ts` is a table test. Each row scripts one outcome and runs it against a fresh sentinel-bearing stub on each leg it applies to: `auth.test`, `socket-mode` or both. It checks the class, the reason fields and `assertNoLeak` on everything captured.

### Backoff and Retry Tests

Backoff, retry and timeout tests never wait in real time.

- **Pure schedules are called, not timed.** `createPersonaRetrySchedule` holds no timer and reads no clock: it returns the next wait. Tests drive it by calling `nextDelayMs` and asserting on the returned sequence, as the `backoff schedule` describe block does.
- **Timers and clocks are injected.** Code that schedules a wait, or abandons a call that never settles, takes its clock and timers as parameters. Tests pass fakes and advance them; they never sleep past a real delay.
- **Never-settling cases.** A `never` outcome stays pending for good, so the test ends it through the stub (`drop()`, `disconnect()`) or through the injected clock, never by waiting for it.
- **`retryAfter` rows.** Script `retryAfter` values above and below the current step, and assert that the wait is never shorter than `retryAfter`. The outcome carries `retryAfter` in seconds and the schedule returns milliseconds, so convert before comparing. The `retryAfter` describe block is the reference.
- **Leak checks still apply.** Every captured log line and error passes through `assertNoLeak`.

### Parametrization

When 3+ tests follow the same structure with different inputs, collapse them with `test.each`:

```typescript
test.each([
  ['', 'empty string'],
  ['no-prefix', 'missing type prefix'],
])('rejects invalid id %s (%s)', (id) => {
  expect(() => validateId(id)).toThrow()
})
```

Don't wrap simple domain strings in constants (`const STATUS_OPEN = 'open'`) — inline them. Constants earn their keep only for complex formats or values used in 5+ places.

### State Reset

Use `beforeEach` to reset module-scoped state between tests:

- Registry: `_resetRegistry()` (exported from registry.ts)
- Test-local Maps/Sets: reassign in `beforeEach`

### Stubbing External Dependencies

- **WebClient**: Persona code uses the Slack stub's Web API clients and `calls` capture arrays (see Slack Stub). Pre-persona suites keep their local stub functions (e.g., `stubPostMessage`, `stubChatUpdate`) that record calls to a capture array and return mock responses, until E3 moves them over
- **SocketModeClient**: Persona code uses the Slack stub's socket clients and event factories (see Slack Stub). Pre-persona suites keep simulating events by directly calling the handler logic with mock payloads, until E3
- **server.ts side effects**: Cannot import server.ts in tests (module-scope side effects). Instead, replicate the relevant logic in a self-contained test server or test the extracted pure functions

### Module Mocks (mock.module)

**The hazard.** `bun test` runs every test file in a single process. `mock.module(...)` patches the module registry at the process level — it is process-global state. A top-level `mock.module(...)` call fires at import time and is never cleaned up, so the patched module leaks into every subsequent test file that imports the same module. If the mock factory omits an export that a later file imports, the later file crashes at runtime.

**The b.b8s incident.** A top-level mock in one file replaced `child_process` with only `{ spawn: fakeSpawn }`. A later file did `import { spawnSync } from 'child_process'` and failed with:

```text
SyntaxError: Export named 'spawnSync' not found in module 'node:child_process'
```

The root cause and class-of-bug fix are tracked in bugs b.b8s and b.5wd.

**The rule.** Every `mock.module(...)` call must live inside a `beforeEach` or `beforeAll` block, paired with a matching `afterEach` or `afterAll` that calls `mock.restore()`. Never call `mock.module(...)` or `mock.restore()` at file top-level. This includes calls inside a `describe(...)` body but outside hooks — those run at import/registration time and leak the same way.

**Don't:**

```typescript
// BAD — top-level, leaks into all subsequent test files
mock.module('child_process', () => ({ spawn: fakeSpawn }))

describe('MyTest', () => { ... })
```

**Do:**

```typescript
import { mock } from 'bun:test'

describe('MyTest', () => {
  beforeEach(async () => {
    // Spread the real module so later imports get all original exports unchanged
    const real = await import('node:child_process')
    mock.module('node:child_process', () => ({ ...real, spawn: fakeSpawn }))
  })

  afterEach(() => {
    mock.restore()
  })

  test('uses fakeSpawn', () => { ... })
})
```

**Enforcement.** `scripts/check-no-toplevel-mock-module.ts` runs as part of `pretest`. It scans all files under `tests/` and fails the test run if any line at column 0 (zero leading whitespace) contains `mock.module(` or `mock.restore(`.

### Throwaway Git Repos

Fixtures that create a throwaway git repo and commit in it use one canonical setup: declare a repo-local `identity.account` plus a neutral `user.name`/`user.email`, and wrap each commit in a retry-once. Reference implementation: `tests/publish-promote-bun-g-cwd.test.ts`.

```typescript
git('config', 'user.name', 'Test')
git('config', 'commit.gpgsign', 'false')
git('config', 'identity.account', 'work')
git('config', 'user.email', 'fixture@example.com')
...
try { git('commit', '-q', '-m', 'init') } catch { git('commit', '-q', '-m', 'init') }
```

**Why the retry.** The host's git identity hook blocks a config-sourced `user.email` mismatch exactly once: it rewrites the repo-local `user.email` to the resolved identity and tells you to re-run. The second attempt passes. On hosts without enforcement the first commit succeeds and the `catch` is dead code — harmless either way.

**Do not bypass enforcement.** No `core.hooksPath` redirects, no `--no-verify`, no `GIT_AUTHOR_*`/`GIT_COMMITTER_*` overrides. The hook staying active in fixtures is deliberate — these commits are the suite's only incidental exercise of the identity hook, so they double as its canary. Disabling it there would make the suite demonstrate the very technique b.q53 was told not to use, and would hide any future change in the hook's behavior.

### Self-Contained Test Servers

When testing HTTP endpoints that live in server.ts, create a minimal Bun.serve() in the test file that replicates the endpoint logic with stubbed dependencies. This pattern is used by interject.test.ts:

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
- Timing-dependent behavior with real delays — inject the clock and timers (see Backoff and Retry Tests); older suites use short configurable timeouts
- Test infrastructure itself (factories, stubs, reset helpers) — if a fixture breaks, the real tests that use it will fail anyway

## Keeping the Suite Lean

The goal is good coverage with as few lines of test code as possible. Apply the 80/20 rule: strong coverage of behavior does not require testing every input permutation — don't gold-plate.

- Test behavior, not implementation: assert on what a function produces (return values, state changes, captured calls), not on how it got there. A test needing 3+ stubs to run is usually testing implementation details and will break on harmless refactors.
- Prefer removing a redundant test over keeping it "just in case"
- Prefer `test.each` over copy-pasted test functions
- Prefer factory functions over repeated inline setup blocks
