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

## Code Quality

- **Remove dead code.** No commented-out blocks, unused exports/imports, or leftover debug `console.log`. Version control is the safety net — delete with confidence.
- **YAGNI.** Don't build abstractions for hypothetical future requirements. Three similar lines are better than a premature helper.
- **Match existing patterns.** If the codebase has a convention for something, follow it — don't introduce a second way of doing the same thing.
- **Keep functions readable.** Over ~50 lines or more than 3 levels of nesting: extract helpers.
- **Magic values.** Named constants over mystery numbers and strings (see Naming Conventions).
- **DRY.** Copying a block of code a second time means it's time for a shared function.

## Security

- Localhost-only endpoints: check `server.requestIP(req)` for `127.0.0.1`, `::1`, and `::ffff:127.*`
- Sensitive files (`access.json`): `chmod 0o600`
- No secrets in config files that don't need them (config.json); never hardcode tokens or keys in source — load from environment or config
- Gate all inbound Slack messages through the `gate()` function before processing
- Validate all external input at system boundaries (HTTP endpoints, Slack payloads, config files) before acting on it
- Error responses to external callers must not expose stack traces, internal paths, or sensitive data — log detail to stderr, return a generic message

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

## Avoiding Duplicated Effort with agent-director

agent-director owns spawn liveness, process management, and resume semantics. Before building CSCB-side logic that reimplements or works around any of those, figure out which case you're in:

- **agent-director already does it.** Use its verb (or its typed errors — see `src/agent-director-errors.ts`) instead of building a parallel implementation. Accidental duplication drifts out of sync with agent-director's actual behavior and doubles the maintenance surface.
- **Genuine capability gap on agent-director's side.** Build the *minimal* workaround CSCB needs, and flag it for removal: note the agent-director plan (or file one) that closes the gap, and reference it in the code comment so the workaround dies when the fix lands.

The precedent to follow is the b.4dk/b.m4r/b.93m/b.ecw chain, which shows how to split responsibilities cleanly rather than fork them. agent-director's `find-missing` had a degraded-mode guard that refused to answer liveness *reconciliation* queries right after a reboot. Once agent-director's own fix landed (plan b.93m: per-row, evidence-based `find-missing`, guard removed, shipped in ≥ 0.8.0), CSCB handed the reconcile responsibility back to agent-director: the dead-session recovery path in `src/session-manager.ts` (`resumeOrFreshSpawn`'s `reconcileMissingFirst` branch) calls `client.findMissing({})` before resume — no parallel *reconciliation* implementation on the CSCB side. Note the boundary here, and how it shrank once the gap fully closed. The `working`-branch `dead-session` verdict — the one from `waitForWaitingAndReconnect` — now keys on the *claude process* via AD's `findMissing` + `status`, not on a raw tmux probe: b.ecw retired the `_hasTmuxSession` probe from the two terminal branches of `waitForWaitingAndReconnect` (ended/missing returns `'dead-session'` directly; timeout runs a fresh `findMissing` sweep + `status`). (The other `dead-session` trigger that also falls through to `reconcileMissingFirst` — the `waiting`-branch `reconnectMcp` — still keys on the tmux session: its verdict comes from a double `ErrTmuxSendKeys` failure (`src/session-manager.ts`), untouched by b.ecw.) CSCB still keeps the narrow `tmux has-session` probe (`_hasTmuxSession`, `src/session-manager.ts`), but its remaining role is narrow and structural — the cases AD *cannot* answer: the poll-loop `ErrSpawnNotFound` branch (no AD row exists to reconcile or consult) and the timeout branch's AD-outage fallback (so a `status` error can't manufacture a false `'dead-session'`, the b.rmy invariant). Only the *reconcile* (which spawns are actually missing) moved to `client.findMissing({})` first; then, once b.93m Part E made per-row verdicts evidence-based, the liveness *verdict* itself handed back too — the probe stayed only where AD structurally has nothing to say. Do the same when you own a workaround: give it a cited exit path, and when agent-director closes the gap hand back exactly the responsibility it now covers — not more, not less — rather than keeping a permanent fork.

## Async Patterns

- Use `async/await` throughout — no raw Promises except where explicitly holding connections open (e.g., SSE keep-alive streams)
- SSE keep-alive pattern: hold the response open with a `Promise` that resolves on `req.signal` abort; stream events by writing to `res` directly; clean up on abort via `req.signal.addEventListener('abort', ...)`
- Always clean up on abort: `req.signal.addEventListener('abort', ...)` for held HTTP connections
- Use `settled` flag pattern to prevent double-resolution in race conditions

## Review Prioritization

Not all issues are equal. When writing or reviewing code, focus in this order:

1. **Security vulnerabilities** — fix immediately
2. **Logic errors** — fix immediately
3. **Missing tests** — add before merging
4. **Architecture problems** — address in current work if feasible
5. **Code quality** — address if touched, don't go hunting
6. **Style nits** — let the linter handle it

## Definition of Done — closing a bee

A bee may be set `finished` only when one of the following holds, and the chosen justification is stated plainly in its closure note:

- **On main.** Its commits are reachable from `main` — name the commit SHAs in the note.
- **Resolved outside the repo.** The fix is ops-only or lives in another file/host — name the file/host changed (e.g. `~/startup/start-all.sh`, `~/.claude/channels/slack/system-prompt.md`).
- **Closed without a code change.** It is explicitly no-repro, superseded, or abandoned — say which, and point at where the real work lives (or why none is needed).

**"Pending merge/release" is NOT a valid finished state.** A fix that only exists on an unmerged branch is stranded, not done — `main` still carries the bug. Those exact words were in b.qps's closure note while its fix sat on an unmerged branch for months and the root cause stayed live on `main`; the fix was nearly re-implemented from scratch before the stranded branch was noticed. If work is on a branch and not yet on `main`, the bee stays open.

`scripts/audit-finished-tickets.sh` enforces this. It is read-only: for every `finished` bee in the Bugs and Plans hives it flags tickets whose work is neither reachable from `main` nor covered by a recognized closure marker, branches referencing finished tickets whose heads are not ancestors of `main`, and any unmerged branch that references no known ticket at all (e.g. `origin/no-channels`). A closure note that says "pending merge/release" or "fixed on branch X" is treated as an anti-marker and forces a flag. It exits non-zero when stranded work exists and runs at release preflight as gate SR-2.6 (see below), so a release cannot ship while finished work is silently stranded.

## Releasing CSCB

Releases are cut with the `/publish` skill from a Claude Code session whose CWD is any checkout of the `claude-slack-channel-bots` repo on `main`. The skill is **invocation-location-neutral** for its npm-publishing steps — those run identically from the primary checkout of the main clone, from any feature worktree (so long as that worktree's HEAD is `main` and in sync with `origin/main`), or from a throwaway `git clone` under `/tmp` or anywhere else. The one exception is the SR-2.6 stranded-work audit: it needs the Bugs/Plans hives locatable one level above the repo checkout (`<project>/Bugs`, `<project>/Ideas/Plans`, `<project>/<repo-checkout>/`). A throwaway `/tmp` clone with no hives beside it cannot run the audit — it fails the setup-failure diagnostic (SR-2.6 exit 17, see below) rather than passing. Run `/publish` from the canonical checkout that sits beside the hives.

> **SR-2.6 is known-red today.** The stranded-work audit currently exits non-zero **by design** because known pre-existing hygiene debt exists: finished tickets `b.qps`, `b.1qs`, `b.a4d`, `b.jfk`, `b.e3f`, and unmerged branches `feature/b.e3f`, `feature/b.oaj`, `fix/b.k54-trust-dialog`, `origin/no-channels` (all tracked separately). SR-2.6 will therefore block releases until that debt is cleared or the tickets are explicitly re-closed. A red SR-2.6 on the first run is the correct, expected result — **not** a regression in the gate.

### Preconditions

Before invoking `/publish`, confirm:

- Working tree is clean and HEAD is `main`, exactly equal to `origin/main` (run `git fetch origin && git status` and `git log origin/main..HEAD` to verify).
- `bun install --frozen-lockfile`, `bun test`, and `bun run typecheck` all pass locally.
- Docker daemon is running (required by the `/ci` gate).
- `ANTHROPIC_API_KEY` is exported in the environment (required by `/ci`). A raw `sk-ant-api…` key suffices; a gateway credential (e.g. NVIDIA InferenceHub) also requires `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` to be exported so the bot Claudes spawned inside the test container hit the gateway rather than `api.anthropic.com`. `/ci` forwards all three into the container when set.
- `npm whoami` returns a `claude-slack-channel-bots` maintainer account (`npm login` if not).

If any precondition fails, `/publish` will abort at the corresponding preflight gate with an `SR-2.x` diagnostic — you do not need to pre-check by hand, but knowing the list helps diagnose a failure quickly.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with `SR-1.2 (argument)` if the argument is missing or not one of the three keywords.

### Phases of execution

`/publish` runs four phases in order. Each phase has a well-defined abort behavior:

1. **Phase 1 — Local preflight (SR-2.1–SR-2.4, SR-2.6).** Clean tree on `main` in sync with origin; frozen-lockfile install; at least one `*.test.ts` file under `tests/`; `bun test` and `bun run typecheck` pass; `npm whoami` succeeds; the next version is not already on npm; no stranded finished work (SR-2.6 — `scripts/audit-finished-tickets.sh` exits zero; audit exit 1 → stranded work, preflight exit 16; audit exit 2 → setup failure such as unlocatable hives/repo/main, preflight exit 17). **Abort behavior:** the skill exits before any side-effecting step. The working tree is untouched.
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
| `/ci` not runnable or non-PASS | `SR-2.5 (/ci gate)` | Start Docker / export `ANTHROPIC_API_KEY` (plus `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` for a gateway credential), or fix the integration regression, then rerun. |
| Stranded finished work (a finished bee's fix is neither on main nor explicitly closed, an unmerged branch references a finished ticket, or an unmerged branch references no known ticket at all — e.g. `origin/no-channels`) — audit exit 1 | `SR-2.6 (preflight)` (exit 16) | For each flagged ticket, land its fix on main or explicitly close it (no-repro / superseded / abandoned, with a pointer to where the work lives); for each flagged branch, merge or delete it. Re-close the tickets, then rerun. The gate is read-only — it never mutates tickets or git. |
| Audit could not run — the Bugs/Plans hives, a git repo, or a `main` ref were not locatable from this checkout (e.g. a throwaway `/tmp` clone with no hives beside it) — audit exit 2 or other. This is a **setup failure, not stranded work**; the release is still blocked (fail closed). | `SR-2.6 (preflight)` (exit 17) | Rerun `/publish` from the canonical checkout that sits beside the Bugs/Plans hives (the main working clone), not a throwaway/`/tmp` clone. |
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
