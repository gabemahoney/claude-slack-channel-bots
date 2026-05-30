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

- Use `try/catch` around external calls (Slack API, file I/O, agent-director library verbs). For agent-director rejections, branch on `instanceof Err*` rather than parsing strings — see `src/agent-director-errors.ts` for the typed re-exports.
- Log errors to stderr with the `[slack]` prefix: `console.error('[slack] context: description', err)`
- Non-critical failures (reaction add, message update) use empty catch blocks with `/* non-critical */` or `/* ignore */`
- Critical failures (token loading, routing config) exit the process with a clear message

## Configuration

- Routing config lives at `~/.claude/channels/slack/config.json`
- State directory is `~/.claude/channels/slack/` (overridable via `SLACK_STATE_DIR` env var)
- New config fields: add to `RoutingConfigInput` (optional), `RoutingConfig` (with default), `applyDefaults()`, and `validateConfig()`
- Atomic file writes: write to `.tmp` file, then `renameSync` to final path

## Security

- Localhost-only endpoints: check `server.requestIP(req)` for `127.0.0.1`, `::1`, and `::ffff:127.*`
- Sensitive files (`access.json`): `chmod 0o600`
- No secrets in config files that don't need them (config.json)
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

`session_restart_delay` in `config.json` sets the delay in seconds before attempting a relaunch. Default is 60. Set to 0 to disable auto-restart entirely — the server will log `Auto-restart disabled (delay=0)` and skip all scheduling for that disconnect.

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

`health_check_interval` in `config.json` sets the polling interval in seconds. Type: `number`. Default: `120`. Set to `0` to disable the poller entirely — `startHealthCheck()` returns immediately without creating an interval.

### Async Interval Pattern

Each tick fires an `async` callback. The callback iterates routes sequentially to keep concurrent `client.status(...)` traffic predictable. Errors on a single channel are caught and logged; they do not abort the rest of the iteration. agent-director's library Client is internally safe for concurrent verb calls (see SR-0.1).

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

- Use `async/await` throughout — no raw Promises except where explicitly holding connections open (e.g., SSE keep-alive streams)
- SSE keep-alive pattern: hold the response open with a `Promise` that resolves on `req.signal` abort; stream events by writing to `res` directly; clean up on abort via `req.signal.addEventListener('abort', ...)`
- Always clean up on abort: `req.signal.addEventListener('abort', ...)` for held HTTP connections
- Use `settled` flag pattern to prevent double-resolution in race conditions

## Releasing CSCB

Releases are cut with the `/publish` skill from a Claude Code session whose CWD is any checkout of the `claude-slack-channel-bots` repo on `main`. The skill is **invocation-location-neutral** — it runs identically from the primary checkout of the main clone, from any feature worktree (so long as that worktree's HEAD is `main` and in sync with `origin/main`), or from a throwaway `git clone` under `/tmp` or anywhere else. No step depends on a specific directory layout.

### Preconditions

Before invoking `/publish`, confirm:

- Working tree is clean and HEAD is `main`, exactly equal to `origin/main` (run `git fetch origin && git status` and `git log origin/main..HEAD` to verify).
- `bun install --frozen-lockfile`, `bun test`, and `bun run typecheck` all pass locally.
- Docker daemon is running (required by the `/ci` gate).
- `ANTHROPIC_API_KEY` is exported in the environment (required by `/ci`).
- `npm whoami` returns a `claude-slack-channel-bots` maintainer account (`npm login` if not).

If any precondition fails, `/publish` will abort at the corresponding preflight gate with an `SR-2.x` diagnostic — you do not need to pre-check by hand, but knowing the list helps diagnose a failure quickly.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with `SR-1.2 (argument)` if the argument is missing or not one of the three keywords.

### Phases of execution

`/publish` runs four phases in order. Each phase has a well-defined abort behavior:

1. **Phase 1 — Local preflight (SR-2.1–SR-2.4).** Clean tree on `main` in sync with origin; frozen-lockfile install; at least one `*.test.ts` file under `tests/`; `bun test` and `bun run typecheck` pass; `npm whoami` succeeds; the next version is not already on npm. **Abort behavior:** the skill exits before any side-effecting step. The working tree is untouched.
2. **Phase 2 — `/ci` integration gate (SR-2.5).** The `/ci` skill runs the full Docker-based integration suite. It must report PASS. **Abort behavior:** identical to Phase 1 — no side-effecting step has run yet.
3. **Phase 3a — Bump and smoke test (SR-3.1, SR-4.1–SR-4.3).** `npm version <bump> --no-git-tag-version` applies the bump; `bun pm pack` produces the release tarball; the tarball is scratch-installed into a temp `BUN_INSTALL`; the installed bin is invoked with no args and must exit non-zero with `Usage:` in stderr. **Abort behavior:** the working tree is rolled back (`git checkout -- package.json bun.lock`). Nothing is committed, pushed, or published.
4. **Phase 3b — Real release (SR-5.1–SR-5.4, SR-6.1, SR-7.1–SR-7.4).** Commit `Release v<version>`, create the annotated `v<version>` tag locally, push the commit to `origin/main`, publish the smoke-tested tarball with `npm publish <tarball-path>` (the byte-identical artifact, not a repack), push the tag to `origin`, poll the npm registry until the version is visible, sanitize the global `package.json` of the bun-1.3.13 empty-string-dependency-key poison, remove any pre-existing global install, run `bun install -g claude-slack-channel-bots@<version>`, and verify the install resolves under `${BUN_INSTALL:-$HOME/.bun}/install/global/` at the published version.

The SR-5.1 → SR-5.4 ordering is load-bearing: the tag is pushed only after `npm publish` succeeds, so the git remote and npm never disagree about whether `v<version>` exists.

### Recovery actions by failure mode

Every failure path in `/publish` emits a diagnostic identifying the failing SR sub-step and the operator's recovery action — the operator should not need to read the skill source. Common modes:

| Failure | Diagnostic prefix | Recovery |
|---|---|---|
| Dirty tree / wrong branch / diverged main | `SR-2.1 (preflight)` | Commit/stash, checkout main, or sync with `git pull --ff-only origin main`; rerun `/publish`. |
| Lockfile out of sync | `SR-2.2 (preflight)` | Run `bun install`, commit the updated `bun.lock` to main, rerun. |
| No tests / failing tests / failing typecheck | `SR-2.3 (preflight)` | Add or fix tests / types, commit to main, rerun. |
| `npm whoami` fails | `SR-2.4 (preflight)` | `npm login`, rerun. |
| Version already on npm | `SR-2.4 (preflight)` | Pull latest main (or pick a larger bump), rerun. |
| `/ci` not runnable or non-PASS | `SR-2.5 (/ci gate)` | Start Docker / export `ANTHROPIC_API_KEY`, or fix the integration regression, then rerun. |
| Bump / pack / scratch-install / smoke failure | `SR-3.1` or `SR-4.x` | Working tree is rolled back automatically. Investigate the upstream error, then rerun. |
| `git push origin main` failure | `SR-5.2 (push commit)` | The release commit + tag are local-only; resolve the push issue and re-run `git push origin main` manually + `npm publish <tarball>` + `git push origin v<version>`, OR `git reset --hard HEAD~1 && git tag -d v<version>` to abandon and rerun `/publish`. |
| `npm publish` failure | `SR-5.3 (npm publish)` | Commit is on origin; npm does not have the version. Fix the publish issue (e.g., `npm login`) and re-run `npm publish <tarball>` manually, then `git push origin v<version>`. The smoke-tested tarball is preserved in CWD for the manual re-publish. |
| `git push origin v<version>` failure | `SR-5.4 (push tag)` | The release is otherwise complete — only the tag is missing. Resolve the push issue and re-run `git push origin v<version>` manually. Do not rerun `/publish`. |
| Registry not visible within 60s | `SR-6.1 (registry verification)` | Propagation lag only; the release succeeded. Re-confirm with `npm view claude-slack-channel-bots@<version> version`, then proceed manually with `bun install -g` and `clean_restart`. |
| Post-publish install failure | `SR-7.3 (post-publish install)` | Dev box has no global install. Re-run `bun install -g claude-slack-channel-bots@<version>` manually until it succeeds, then `clean_restart`. |
| Post-publish verification failure (wrong location, wrong version, bin not on PATH) | `SR-7.4 (post-publish verification)` | The release is published; only the local install is wrong. `bun remove -g claude-slack-channel-bots && bun install -g claude-slack-channel-bots@<version>`, then `clean_restart`. |

### Post-publish

`/publish` ends with a success summary listing the published version, npm URL, GitHub tag URL, the resolved local install path, and a final instruction. Run that final instruction to swap the running CSCB daemon onto the new binary:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See `clean_restart` in the README for behavior details.
