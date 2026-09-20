# Internal Architecture

## System Overview

The Slack Channel Router is a two-way bridge between Slack and Claude Code sessions via Socket Mode + MCP HTTP (StreamableHTTP). Each Claude Code session connects to its own MCP Server instance, assigned to a Slack channel via routing config.

## Module Map

```
cli.ts                          CLI entry point — start/stop/clean_restart subcommands. `stop --stop-bots` and clean_restart share a `teardownBots` closure that uses agent-director pause/status/kill verbs (SR-11 Event 12).
└── server.ts                   Main entry point — HTTP server, Socket Mode, message routing. Embeds the SR-5.1 startup gate, SR-3.2 template install, SR-1.6 orphan reconcile, SR-2.1 poller. `isHttpVerbose()` (b.3k6) gates the per-request `/mcp` access line behind `CSCB_HTTP_VERBOSE` (truthy: 1/true/yes/on) — off by default, checked per request.
    ├── config.ts               Routing configuration — load, validate, defaults, tilde expansion. SR-4.1 agent_director_poll_interval_ms field. SR-4.2 unknown-field rejection.
    ├── registry.ts             Session registry — pending/registered sessions, MCP Server factory, transport routing. No session-id discovery (AD owns it).
    ├── lib.ts                  Pure utilities — gate, access control, chunking, sanitization.
    ├── logging.ts              Log file setup — overrides console.error/console.log with timestamped writeSync to a log file. Size-based rotation on every write (b.brv): rotates server.log/clean_restart.log at CSCB_LOG_MAX_BYTES (default 10 MiB), keeps CSCB_LOG_KEEP generations (default 5; 0 = truncate).
    ├── agent-director-logger.ts  b.brv verbosity filter for the agent-director Client's diagnostic logger. `makeFilteredAdLogger(base)` drops routine `SubprocessClient: <verb> ok` per-poll success dumps at info/log level; warn/error always pass through. CSCB_AD_VERBOSE (truthy: 1/true/yes/on) returns the base logger unwrapped. Injected into `Client.create()` by `agent-director-startup.ts`.
    ├── startup-errors.ts       SR-5.1a startup-errors log — append-only to ~/.claude/channels/slack/startup-errors.log + stderr.
    ├── agent-director-client.ts   SR-0.1 singleton Client wrapper. `getClient()` is a sync cached accessor returning the Client previously installed by the startup gate via the production `setClient()` setter; calling `getClient()` before the gate runs throws a CSCB-internal "called before startup gate" error. CSCB no longer owns a runtime version pin — AD's library-side `Client.create()` enforces the floor from `dist/version-floor.json`. Exposes `decideWithToken` (SR-7.2 — single source of truth for the snake-case `request_token` field on the decide wire) and `getPermission` + `isErrPermissionRequestNotFound` (SR-7.1 — wraps the paired AD release's `get-permission --request-token <uuid>` verb).
    ├── agent-director-errors.ts   SR-0.2 typed Err* re-exports for instanceof branching.
    ├── agent-director-startup.ts  SR-5.1 startup gate — async `Client.create()` injection / SR-4.2 system-install typed-error branches / SR-6.1 API surface probes / same-user stat.
    ├── install-skill-pointer.ts   SR-4.5 / SR-9.3 manual-skill-install instructions block. Renders a multi-line string containing the GitHub URL of `skills/install-cscb/SKILL.md` (derived from `package.json` `repository.url`), the target path `~/.claude/skills/install-cscb/SKILL.md`, and the invocation command `/install-cscb`. The startup gate appends this block to the three `ad-system-install-*` typed-error failure messages only — never to `ErrBunVersionTooOld`, the three `ad-shim-*` branches, or the same-user check.
    ├── install-check.ts           SR-5 shared install-check module. Exposes `runInstallCheck(): Promise<Result>` — the sole source of truth for the `semver.gte` + `DEV_SENTINEL_VERSION` equality logic. Reads AD's `dist/version-floor.json` (via the `agent-director/dist/version-floor.json` subpath export), calls AD's standalone `resolveSystemBinary()`, and maps the three system-install typed errors plus the floor-mismatch case to four canonical class labels (`ad-system-install-not-found`, `ad-system-install-too-old`, `ad-system-install-unreachable`, `ad-version-floor-unreadable`). Side-effect-free: no `process.exit`, no disk writes, no stdout/stderr. Consumed by `scripts/install-check.ts` (the `bun run install-check` diagnostic) and the Epic-3 install-cscb skill. The startup gate does NOT call this module — AD's `Client.create()` enforces the same floor against the same data source.
    ├── agent-director-template.ts SR-3.1 / SR-3.2 — builds the slack-channel-bot MakeTemplateParams and calls client.makeTemplate({ overwrite: true }) at boot.
    ├── session-manager.ts      SR-1 in full — spawnForRoute (SR-1.4 collision-then-act), reconcileOrphans (SR-1.6), reconnectMcp/waitForWaitingAndReconnect, postSpawnFailureToChannel.
    ├── permission-poller.ts    SR-2.1 polling loop + SR-2.2 Block Kit emitter. Owns the live LivePermission map, keyed on the composite `(claude_instance_id, request_token)` pair, consumes AD's plural `permission_requests` projection, posts one Slack message per open row, and runs the SR-2.4 set-diff + `get-permission` closure reconciliation with four verdict-distinct chat.update renderings (operator-allow / operator-deny / timeout / find_missing) plus a fail-closed generic-deny fallback for unknown decision_reason and `ErrPermissionRequestNotFound`.
    ├── permission-click-handler.ts  SR-4 single-decide-call relay; parses the action_id, calls `decideWithToken` unconditionally (always carrying the decoded `request_token`), renders one `chat.update` carrying the same verdict text the poller's SR-2.4 reconciliation produces (`*Permission* — Allowed` / `*Permission* — Denied by operator`) when a live entry is present, calls `markHandled` on success, swallows `ErrAlreadyDecided` silently, logs `ErrInvalidFlags` / `ErrAmbiguousRequest` without retry. Never calls `get` or `getPermission`; never mutates the pending map directly.
    ├── permission-action-id.ts SR-3 encode/decode helpers; anchored regex `^perm_(allow|deny)_(cscb_.+)_(<UUIDv4>)$` where the trailing UUIDv4-shape group is an outer-structure anchor disambiguating the underscore-bearing claude_instance_id capture — NOT a token-content validator (SR-1.3).
    ├── permission-trail.ts    SR-V visibility trail emitter — append-only JSONL store at `~/.claude/channels/slack/permission-trail.jsonl`; lazy-open fd, `emitTrail()` / `emitTrailEvent()` API used by the poller, click handler, decide call, and closure render. See [permission-trail.jsonl](#permission-trailjsonl-claudechannelsslackpermission-trailjsonl).
    ├── restart.ts              Auto-restart — delayed relaunch on disconnect, failure counting, timer cancellation.
    ├── health-check.ts         Periodic liveness poller — checks routes on a timer via client.status; schedules restarts for dead sessions.
    ├── pid.ts                  PID file management — write, read, conflict detection, isProcessRunning.
    ├── cozempic.ts             Optional cozempic CLI integration — path resolution helpers retained for downstream callers.
    ├── tokens.ts               Token loading — reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from env, validates prefixes.
    ├── ack-tracker.ts          In-memory ack reaction state.
    ├── stop-hook-bootstrap.ts  SR-3 boot-time patcher for `<claude_config_dir>/settings.json` — installs (or removes) the CSCB-managed Slack Reply Guard Stop-hook group per effective config dir, aggregating routes that share a dir.
    └── message-archive.ts      Optional SQLite archive of every inbound Slack message.

stop-hooks/
└── slack-reply-guard.sh       Claude Code Stop hook — blocks a turn (exit 2) when the most recent real user message carries the `<channel source="slack…"` tag prefix and no subsequent assistant `tool_use` targets `mcp__slack-channel-router__reply`; fail-open on any error. Bootstrapped into settings.json by `src/stop-hook-bootstrap.ts`.
```

The deleted files from the pre-Epic-2 architecture (`src/tmux.ts`, `src/peer-pid.ts`, `src/sessions.ts`, `hooks/permission-relay.sh`, `hooks/ask-relay.sh`) are absent: agent-director owns the tmux integration and Claude session-id state, the SR-2.1 poller replaces the hook-based long-poll relay, and AskUserQuestion is denied at the template level (SR-3.1). The `src/trail-cli.ts` and `src/trail-query.ts` CLI query wrappers (removed in `b.8tm`) are also absent — the trail file itself is the surface; see [Trail file location and query recipes](#trail-file-location-and-query-recipes--sr-v-5--sr-v-6).

## Data Flow

### Inbound (Slack → Claude Code)

1. Slack message arrives via Socket Mode (`message` or `app_mention` event)
2. `gate()` checks access control (bot messages, subtypes, DM policy, allowlist)
3. If `ackReaction` is configured, the ack emoji is applied to the message and `trackAck(channelId, messageTs)` records the pending ack for later removal
4. Message is routed to the correct session via `getSessionByChannel()` or `getSessionByCwd()`. If the channel has an entry in `routes` but its session is not yet registered (e.g. still starting up), the message is not delivered to Claude — instead, the server posts `"Message not delivered — session starting up, please retry in a moment."` back to the channel. `default_route` does not apply for configured channels; it is only consulted for channels with no entry in `routes` at all.
5. Session's MCP Server sends `notifications/claude/channel` to the Claude Code client

### Outbound (Claude Code → Slack)

1. Claude Code calls MCP tools (`reply`, `react`, `edit_message`, etc.)
2. Tool handler checks `assertOutboundAllowed()` — session can only send to channels it has received messages from
3. Tool calls the Slack Web API (`web.chat.postMessage`, `web.reactions.add`, etc.)
4. After the first chunk posts, if `message_id` was provided and `consumeAck(channelId, messageTs)` finds a tracked entry, the ack reaction is removed via `reactions.remove`

### Permission Relay (SR-2)

Driven by polling against the agent-director Client + Block Kit click → `decide()`. The previous HTTP long-poll + hook script architecture has been deleted. Per-row Slack prompts: N concurrent `tool_use` blocks in one Claude Code assistant response produce N Slack messages, each independently allow/deny-able.

#### Wire surface (paired AD release)

CSCB consumes four AD verbs:

- `client.list({ state: ['check_permission'], label: ['service=cscb'] })` — returns spawn rows in the permission state.
- `client.get({ claude_instance_id })` — returns the row plus a plural `permission_requests` projection. Each element carries `request_token`, `request_id`, `tool_name`, `tool_input`, `requested_at`. The array may be empty (spawn has no open prompts). `null` / `undefined` in the slot is non-conforming.
- `client.decide({ claude_instance_id, decision, request_token })` — JSON snake `request_token`, CLI `--request-token`. Always required; absence yields `ErrInvalidFlags`. The wrapper `decideWithToken` in `agent-director-client.ts` is the single decide-wire serializer (SR-7.2).
- `client.getPermission({ request_token })` — single-row read, no state filter. Returns full PermissionRequestInfo plus `decision`, `decision_reason`, and `decided_at`. Not-found surfaces as `ErrPermissionRequestNotFound` (matched via `isErrPermissionRequestNotFound`).

#### In-memory state (SR-1)

`livePermissions: Map<string, LivePermission>` keyed on a composite `(claude_instance_id, request_token)` encoded by `makeCompositeKey` (null-byte separator — neither component can contain `\x00`). One entry per outstanding Slack prompt. `LivePermission` carries `claudeInstanceId`, `requestToken`, `channelId`, `messageTs`, `requestId` (log-only — never used for routing, keying, action-id encoding, or decide-wire payload per SR-1.4), and a `handled` flag. Lifecycle helpers `getLivePermission(cid, token)`, `markHandled(cid, token)`, and `dropPermission(cid, token)` all operate on the composite key. The tick is the sole owner of `dropPermission`; the click handler may only call `markHandled` (SR-1.2).

#### Per-tick flow (SR-2)

1. `list()` → spawns currently in `check_permission`.
2. For each spawn, `get()` returns the plural `permission_requests` projection.
3. Non-conforming response (`permission_requests` is `null` or `undefined`): log + skip processing for that spawn this tick. The spawn's existing live entries are excluded from the closure sweep below (no state mutation — SR-2.1).
4. For each row in `permission_requests`, compute the composite key. If not in `livePermissions`: post one `chat.postMessage` per row (no coalescing — SR-2.2) and insert one map entry. If already present: no-op (duplicate-tick safe). An empty projection produces no posting activity but does not exclude the spawn's live entries from closure reconciliation.
5. **Set-diff closure reconciliation (SR-2.4):** `tokens_in_livePermissions − tokens_seen_this_tick = newly_closed_tokens` (with non-conforming spawns' entries protected per step 3). For each newly-closed token, call `getPermission(request_token)`. On success, render the verdict (below) via one `chat.update` against `entry.messageTs`, then drop the entry. On `ErrPermissionRequestNotFound`: render generic deny, drop, do not retry. On transient error: leave the entry alive — the next tick retries.

#### Verdict rendering (SR-5)

The closure `chat.update` produces four visually-distinct surfaces driven by `decision` + `decision_reason`:

| `decision` | `decision_reason` | Rendering |
|---|---|---|
| `allow` | `null` | `*Permission* — Allowed` |
| `deny` | `'operator'` | `*Permission* — Denied by operator` |
| `deny` | `'timeout'` | `⏱ *Permission* — Timed out` |
| `deny` | `'find_missing'` | `🪦 *Permission* — Session ended` |
| anything else | anything else | `*Permission* — Denied (closed)` (fail-closed, log) |

`ErrPermissionRequestNotFound` collapses to the same generic-deny rendering (fail-closed log + drop, no retry). `decision_reason` is read verbatim from AD; CSCB does not derive, override, or infer it (SR-5.1). Unknown enum values do not crash the poller (SR-5.2). The `chat.update` targets only the closed row's `messageTs`; sibling rows are never touched in response to one row's closure (SR-5.3).

#### Click handler (SR-4)

`handlePermissionClick` decodes `(decision, claude_instance_id, request_token)` from the action_id and calls `decideWithToken(client, { claude_instance_id, decision, request_token })` unconditionally — this is the click's only AD interaction (SR-4.3). No `get` refetch, no "already decided" branch.

- `ErrAlreadyDecided` → swallowed silently. The next tick's reconciliation (SR-2.4) owns the visible Slack state.
- `ErrInvalidFlags` / `ErrAmbiguousRequest` → logged once, no retry, no operator-visible signal.
- Unknown error types → logged, no retry.

On a successful decide *and* a live entry present, the handler renders one `chat.update` against just that row's `messageTs` (SR-4.5) carrying text byte-identical to the poller's SR-2.4 verdict surface — `*Permission* — Allowed` for allow, `*Permission* — Denied by operator` for deny — then calls `markHandled`. Matching the verdict text exactly means there is no visible flicker when the next tick's reconciliation lands on the same message. A stale click (no entry in `livePermissions`) still fires the decide call with the decoded token — AD is the source of truth and returns idempotent results — but produces no `chat.update` from the click path; the next tick's verdict rendering handles the message.

The Slack user id is intentionally NOT surfaced in the rendered text. An earlier draft of this design rendered "Allowed by <user>" / "Denied by <user>" as immediate operator feedback, but the SR-2.4 reconciler overwrites the message one tick later with the user-less verdict surface, producing visible flicker for the operator who clicked. The simpler, flicker-free design renders the verdict text on both the click path and the reconciliation path.

#### Action ID encoding (SR-3)

Block Kit buttons emit `action_id` strings of the shape `perm_(allow|deny)_<claude_instance_id>_<request_token>`, where `<request_token>` is a UUIDv4. The anchored decoder regex uses the UUIDv4 character class (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`) as an outer-structure anchor — it disambiguates the rightmost boundary of the middle (underscore-bearing) `claude_instance_id` capture so embedded underscores in `cscb_<channel>` remain safe. CSCB does NOT validate the token's bytes; the regex shape only fixes the parse boundary (SR-1.3 + SR-3.1). The `request_id` field is no longer part of the action_id payload and is retained on `LivePermission` for logging only (SR-1.4).

#### Version pin (SR-6)

AD's library-side `Client.create()` reads `dist/version-floor.json` (`.min_binary_version`) and is the sole enforcement point for the runtime floor. The system-installed AD binary is probed by `resolveSystemBinary()`, compared against the declared minimum, and rejected via `ErrSystemInstallTooOld` (which the startup gate `instanceof`-matches → `ad-system-install-too-old` class label). CSCB's `package.json` caret on `agent-director` only governs npm resolution of AD's TypeScript shim; it does NOT participate in the runtime floor decision. The startup gate (`runStartupGate` in `src/agent-director-startup.ts`) is the sole compatibility boundary — no runtime code path degrades to the prior singular-projection or coalesced-prompt behavior on version mismatch (SR-6.2). The three new typed-error class labels are `ad-system-install-not-found`, `ad-system-install-too-old`, and `ad-system-install-unreachable`; see [Startup errors](../README.md#startup-errors).

Operators have an alternate diagnostic entry point via `bun run install-check` (`scripts/install-check.ts`). The script calls `runInstallCheck()` from `src/install-check.ts` — the same shared module the Epic-3 install-cscb skill consumes — and emits a single block on success or a class-labelled stderr block on failure. Beyond the three typed errors, the shared module surfaces `ad-version-floor-unreadable` when the AD package's `dist/version-floor.json` is missing, malformed, or lacks `.min_binary_version` (a packaging defect; remediation is to reinstall `agent-director` from npm, and the manual-skill-install block is intentionally NOT appended on this class).

#### API surface probe (SR-6.1)

A passing `Client.create()` proves only that the system-installed `agent-director` binary meets AD's declared `min_binary_version`. It does NOT prove the published npm package's TS shim is in sync with that binary — agent-director's `0.6.0` release shipped a stale shim whose `Client` dropped `getPermission`, whose `buildDecide()` dropped `--request-token`, and whose error catalog omitted three err_names CSCB branches on. Each defect fails silently at runtime (clicks resolve against the wrong row, error-envelope branches miss because the shim's `errorFromEnvelope` fallback constructs a base `AgentDirectorError` with `.errName` copied verbatim from the input rather than raising), so the gate runs three short-circuit probes after `Client.create()` resolves and before the same-user stat. The probes are dependency-injected via `StartupGateDeps` so tests can drive each failure path directly; the production defaults live alongside in `src/agent-director-startup.ts`.

| Probe | Default check | Failure `classLabel` |
|---|---|---|
| `probeGetPermission` | `typeof client.getPermission === 'function'` | `ad-shim-missing-get-permission` |
| `probeErrorCatalog` | Reads the resolved `agent-director` dist file and confirms each of `ErrInvalidFlags`, `ErrPermissionRequestNotFound`, `ErrAmbiguousRequest` appears as a word-boundary identifier in the bundled JS — same static-file approach as `probeDecideArgv` (a behavioral `errorFromEnvelope` round-trip cannot detect catalog drift because the shim's unknown-name fallback constructs a base `AgentDirectorError` with `.errName` copied verbatim from the input) | `ad-shim-catalog-incomplete` |
| `probeDecideArgv` | `import.meta.resolve('agent-director')` → `readFileSync` of the dist entry → string-contains `--request-token` (no subprocess, no state-DB write) | `ad-shim-decide-drops-token` |

On any probe failure, the gate closes the Client, records the operator-readable message to `startup-errors.log`, and exits non-zero — the same shape as the SR-6 version-pin failure. The remediation in every case is the same: reinstall a matching `agent-director` and confirm the resolved package actually carries the missing surface.

#### What this replaces

Three pre-Epic-4 mechanisms have been retired:

- The four-case per-spawn reconciliation matrix (and its sibling-stomping `updateNoLongerActive()` helper that edited a prior row's Slack message in response to another row's arrival) is gone. Sibling rows are now first-class state from the moment they appear in the plural projection.
- The click handler's prior get-then-stale-rerender branch (a refetch + "already decided" `chat.update` issued without calling decide) is gone. `decideWithToken` is the click's only AD interaction.
- The single-prompt coalescing of multiple concurrent `tool_use` blocks is gone. N parallel tool_uses → N Slack prompts.

AskUserQuestion is denied at the agent-director template (SR-3.1's `deny: ['AskUserQuestion']`) — the tool is unavailable to every CSCB-spawned bot and the prior `/ask` HTTP route + hook script have been removed.

## Session Lifecycle

### Connection

1. Claude Code sends POST to `/mcp` (no session ID) → `initPendingSession()` creates a pending session
2. MCP handshake completes → `server.oninitialized` fires → `handleInitialized()` calls `roots/list`
3. CWD from roots is matched against `routingConfig.routes` → session promoted from pending to registered
4. Session receives messages from its assigned Slack channel
5. A keep-alive timer is started (`startSseKeepAlive`) that writes SSE comment frames (`:ping\n\n`) every ~30 s to prevent idle connection drops from proxies or load balancers

### Server-Managed Startup (SR-11 Event 1)

Called from `main()` in `server.ts`. The order is:

1. **SR-5.1 startup gate** — `runAgentDirectorStartupGate()` awaits `createClient(opts)` (production injects `Client.create`), which runs AD's library-side discovery + floor enforcement against `dist/version-floor.json`. The opts carry `logger: makeFilteredAdLogger(console)` (b.brv) so the Client's per-poll `SubprocessClient: <verb> ok` success dumps are dropped from `server.log` unless `CSCB_AD_VERBOSE` is set — see [Logging](#logging). On success the gate installs the constructed Client into the singleton via `setClient(client)` so subsequent `getClient()` call sites resolve to it, and the success-arm `adVersion` is read from `client.binaryVersion`. The construct-step catch ladder `instanceof`-matches `ErrBunVersionTooOld` (→ `ad-bun-version-too-old`), `ErrSystemInstallNotFound` (→ `ad-system-install-not-found`), `ErrSystemInstallTooOld` (→ `ad-system-install-too-old`, message names detected + required versions), and `ErrSystemInstallUnreachable` (→ `ad-system-install-unreachable`, message surfaces AD's `err.reason` verbatim); the three `ad-system-install-*` branches append the `install-skill-pointer.ts` manual-skill-install instructions block to their `recordStartupError` output. CSCB no longer performs a post-Client floor check — AD owns it. Then runs the SR-6.1 API surface probes (`getPermission` presence, error-catalog round-trip, `--request-token` in the dist) and stats `~/.agent-director/state.db` against `geteuid()`. Failure writes to `startup-errors.log` and exits non-zero.
2. **PID conflict check** — existing `checkPidConflict(PID_FILE)` invariant. CSCB enforces one instance per host.
3. **SR-3.2 template refresh** — `installSlackChannelBotTemplate(routingConfig)` builds the SR-3.1 `MakeTemplateParams` and calls `client.makeTemplate({ ..., overwrite: true })`. Atomic replacement is the library's responsibility (sibling-tempfile + `rename(2)`). Fatal on rejection.
4. **SR-1.6 orphan reconciliation** — `reconcileOrphans(routingConfig)`. `client.list({ label: ['service=cscb'] })` enumerates every CSCB spawn; rows whose `channel` label is missing or not in `routingConfig.routes` are killed + deleted. Per-orphan failure logged to `startup-errors.log` but does not block.
4a. **b.1m9 channel-name resolution** — `resolveChannelNames(routingConfig, web)` calls Slack `conversations.info` once per route and stashes `route.name` + `route.normalizedName` (lowercased, `[^a-z0-9]+` → `_`, no leading/trailing `_`). Used to compose glanceable `cscb_<name>_<id>` / `slack_bot_<name>_<id>` ids. Per-route failure logs a single line and leaves the route nameless; downstream callers fall back to bare-ID naming.
4a-bis. **b.uhv / b.k54 trust-bootstrap** — `trustBootstrap(routingConfig)` (from `src/trust-bootstrap.ts`) patches `<claude_config_dir>/.claude.json` for every routed cwd so the Claude Code trust-folder dialog never appears at spawn. For each route it resolves the effective `claude_config_dir` (per-route override falls back to top-level), reads `<dir>/.claude.json`, and ensures `projects[<route.cwd>].hasTrustDialogAccepted` and `projects[<route.cwd>].hasCompletedProjectOnboarding` are both `true`. Idempotent: when both flags are already `true` the file is not rewritten (verifiable via unchanged `mtime`). Writes are atomic — same `.tmp` + `renameSync` pattern as `saveAccess`. Soft-skip behavior: a route with no configured `claude_config_dir` logs an info line and continues without recording an error; a missing or unreadable `.claude.json` logs an info line and calls `recordStartupError('trust-bootstrap-config-missing', …)` — the file is never auto-created. Malformed JSON records `recordStartupError('trust-bootstrap-config-parse', …)`, and any unexpected per-route failure records `recordStartupError('trust-bootstrap', …)`. The function never throws to the caller, so one bad route cannot block the rest. Runs in both real and dry-run modes — it's a config-file patch, not a session operation. The call site is in `main()` between `resolveChannelNames` (step 4a) and `reconcileInstanceIds` (step 4b), before any spawn fires.
4a-ter. **b.osj stop-hook bootstrap** — `stopHookBootstrap(routingConfig)` (from `src/stop-hook-bootstrap.ts`) patches `<claude_config_dir>/settings.json` for every routed effective config dir to install (or remove) the CSCB-managed Slack Reply Guard Stop hook. Call site: `main()` in `server.ts`, immediately after step 4a-bis (`trustBootstrap`) and before step 4b (`reconcileInstanceIds`) — before any spawn fires. Runs in both real and dry-run modes (config-file patch, not a session operation). Never throws to the caller; per-dir failures are caught and recorded via `recordStartupError`. Behavior:

    - **Grouping / aggregation (SR-3.5).** Routes are grouped by effective `claude_config_dir` (`route.claude_config_dir ?? routingConfig.claude_config_dir`). For each dir the aggregate `anyEnabled` flag is the OR of `route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap` across all routes resolving to it. `anyEnabled=true` → ensure the managed entry; `anyEnabled=false` → remove it (and prune emptied groups).
    - **Managed-entry shape.** Own group `{"hooks":[{"type":"command","command":"<abs>"}]}`, no `matcher` field (Stop is not tool-scoped). Recognition rule: any Stop-hook `command` string containing the substring `slack-reply-guard.sh` is CSCB-managed.
    - **Canonical command resolution.** `resolveManagedCommand()` resolves the script path relative to the installed package (same idiom as `src/install-skill-pointer.ts`), correct under both published-package layout and repo checkout. Stale on-disk commands from a prior install path are treated as managed and rewritten to the canonical path (self-heal).
    - **Idempotent write decision.** `scanStopGroups` returns `hasSingleCanonicalGroup=true` only when there is exactly one Stop group whose sole hook entry has `type=='command'`, `command==canonicalCmd`, no `matcher`, and no extra keys. In that state the write is skipped entirely. Any drift — stale command, duplicates, extra keys, extra hooks in the managed group — triggers a strip-all-managed + append-canonical rewrite via `.tmp` + `renameSync` (trust-bootstrap precedent).
    - **Create-missing.** ENOENT on the target `settings.json` for an enabled dir → the file is created with just the managed group.
    - **Malformed JSON soft-fail.** Non-ENOENT read errors, unparseable JSON, and non-object top levels all call `recordStartupError` with a class label of `stop-hook-bootstrap-settings-read` / `stop-hook-bootstrap-settings-parse` / `stop-hook-bootstrap-settings-shape` and leave the file untouched — never a clobber.
    - **Personal-config-dir refusal (SR-3.11).** `isForbiddenHomeClaudeDir` uses `realpathSync` to resolve both the candidate dir and `homedir()/.claude` (with a lexical `resolve()` fallback for paths that do not exist on disk), so symlinked personal dirs cannot slip past a string compare. On a match the dir is skipped and `recordStartupError('stop-hook-bootstrap-refuse-home', …)` is recorded.
    - **Skip conditions.** Routes with no effective `claude_config_dir` are logged and skipped. Empty or whitespace-only dirs are treated as absent (guards against `resolve("")` landing in the process cwd). A dir that fails `statSync` (or is not a directory) is skipped; the ensure path records `stop-hook-bootstrap-dir-missing` / `stop-hook-bootstrap-not-a-dir`, the remove path is silent.
    - **jq presence check.** A one-time `command -v jq` probe at boot: if `jq` is absent the entry is **still installed** (the hook fails open at hook time when `jq` is missing) but a `stop-hook-bootstrap-jq-missing` startup error is recorded so operators see the warning.
    - **Duplicate collapse and removal (SR-3.7, SR-3.8).** When rewriting an enabled dir, every managed `{type, command}` object across every Stop group is stripped before the canonical group is appended, so pre-existing duplicates collapse to one. Removal for a fully-disabled dir strips every managed object and prunes any group left with an empty `hooks` array.
    - **Never-throws contract.** A top-level `try/catch` around the whole entry point plus per-dir `try/catch` blocks record `stop-hook-bootstrap` / `stop-hook-bootstrap-dir` classes on unexpected failure. Other dirs continue processing. Timing note (SR-3.15): on-disk state is refreshed every boot, but Claude Code only reads the hook config at claude-process start — a live session that survives a CSCB restart via reconnect keeps its running process and picks the new entry up only on next fresh spawn or resume.
4b. **b.1m9 instance-id migration** — `reconcileInstanceIds(routingConfig, autoDelete)` flags any `service=cscb` row whose `claude_instance_id` doesn't match the expected new naming for its configured channel. Default: warn-only with the exact `agent-director delete --claude-instance-id …` command per orphan. Pass `--reconcile-instance-ids` (or `CSCB_RECONCILE_INSTANCE_IDS=1`) to auto-delete.
5. **Per-route reconcile** — `startupSessionManager(routingConfig, { concurrency: 3 })` iterates each configured route concurrently and calls `spawnForRoute` (SR-1.4 collision-then-act dispatcher):
   - Attempt `client.spawn(SR-1.1 params)` — `template: 'slack-channel-bot'`, `relay_mode: 'on'`, `label: ['service=cscb', 'channel=<id>']`, `claude_instance_id: cscb_<normalizedName>_<channelId>` (falls back to `cscb_<channelId>` when name resolution failed), `tmux_session_name: slack_bot_<normalizedName>_<channelId>` (same fallback), optional `extra_env.CLAUDE_CONFIG_DIR`.
   - On `ErrInstanceIdCollision`, call `client.get({claude_instance_id})` and branch on state per the [SR-11 substitution table](#sr-11-substitution-table):
     - `ended` / `missing` + `resume_enabled` → `client.resume(...)`; `ErrNoSessionId` / `ErrJsonlMissing` → `client.delete(...)` + fresh `client.spawn(...)`; `ErrSpawnNotFound` (row vanished between the dead-session verdict and resume — operator delete, expire, race) → fresh `client.spawn(...)` directly with no delete (the row is already gone), action `spawned`.
     - `ended` / `missing` + `resume_enabled=false` → `client.kill(...)` + `client.delete(...)` + fresh `client.spawn(...)`.
     - `waiting` → `reconnectMcp(channelId)` sends `/mcp reconnect slack-channel-router` via `client.sendKeys(...)`. If that reconnect finds the tmux session dead (`'dead-session'` verdict), fall through to `resumeOrFreshSpawn(..., { reconcileMissingFirst: true })` — see the note below.
     - `working` → `waitForWaitingAndReconnect(...)` runs an up-front `findMissing({})` sweep via the shared `reconcileMissingSweep` helper (b.m4r — see note below), then polls `client.status(...)` until `waiting`, then sendKeys; a `'dead-session'` verdict likewise falls through to `resumeOrFreshSpawn(..., { reconcileMissingFirst: true })`.
     - **b.4dk dead-session recovery — `reconcileMissingFirst`.** After a reboot/pod-resume a `waiting`/`working` row is frozen live-state but its tmux session is gone. AD's `resume` verb only accepts a terminal (`ended`/`missing`) row, so on such a row it throws `ErrSpawnNotResumable` and the defensive branch (line above) kill+delete+fresh-spawns — losing all history. When `reconcileMissingFirst` is set (only the two dead-session callers set it), `resumeOrFreshSpawn` runs a `findMissing({})` sweep via the shared `reconcileMissingSweep` helper before `resume`. AD's per-row, evidence-based sweep (requires agent-director ≥ 0.8.0, plan b.93m t1.93m.hp: degraded-mode guard removed) transitions the dead row to `missing`, so the subsequent `resume` succeeds and restores the pre-reboot transcript. Skipped when `resume_enabled=false`. A `findMissing` error → fall through to `resume` anyway (which then kill+delete+fresh-spawns, today's behavior). The `ended`/`missing` collision branch above does NOT set the flag (row already terminal).
     - **b.m4r `working`-row stall — up-front `findMissing` sweep.** A bot killed mid-turn (e.g. its tmux session dies) never fires `SessionEnd`, so its AD row freezes at `working`. Without a reconcile, `waitForWaitingAndReconnect`'s poll loop spins on `status` for the full `WAIT_FOR_WAITING_TIMEOUT_MS` window (10 min) before the timeout verdict finally returns `'dead-session'` — the channel stays down that whole time. `waitForWaitingAndReconnect` therefore runs AD's per-row, evidence-based `findMissing({})` sweep before entering the poll loop (requires agent-director ≥ 0.8.0, same b.93m t1.93m.hp capability as the `reconcileMissingFirst` path). A genuinely-dead row reconciles to `missing`, so the **first** status poll hits the ended/missing branch and returns `'dead-session'` in seconds; a genuinely-alive long-turn row is untouched by the evidence-based sweep and keeps the existing polling behavior (long-turn guard preserved). On any `findMissing` error, the sweep is logged and skipped and the poll loop proceeds unchanged (today's behavior). This prefers AD's `findMissing` verb over a CSCB-side tmux probe, mirroring `resumeOrFreshSpawn`'s `reconcileMissingFirst` branch (docs/engineering-guide.md, "Avoiding Duplicated Effort").
     - **b.ecw terminal verdicts key on the claude PROCESS, not the raw tmux session.** Once b.93m Part E landed (AD ≥ 0.8.0: degraded-mode guard removed, `findMissing` verdicts per-row and evidence-based), the two dead-session branches in `waitForWaitingAndReconnect` decide off AD's process-level verdict rather than a raw `tmux has-session` probe. AD probes the *claude process*; CSCB's `_hasTmuxSession` probes the *tmux session* — a lingering tmux shell with a dead claude process would flip the two, so each branch documents which object it keys on:
       - **ended/missing branch (in-loop):** keys on the process. `ended` means `SessionEnd` fired (process exited); `missing`, after the up-front sweep, is an evidence-based verdict that the process is provably gone. Returns `'dead-session'` directly — **no tmux probe**. A dead process in a live tmux shell is still a dead bot; routing it to `resumeOrFreshSpawn` lets b.vub's `selfHealTmuxCollisionAndRespawn` reap the orphan tmux shell on `ErrTmuxSessionCreate`. (The former tmux-alive → `'ok'` behavior deferred a dead channel to the health-check for minutes.)
       - **timeout branch:** keys on the process via a **fresh** `reconcileMissingSweep` (the 10s memo has long expired at the 10-minute deadline) + one `status` call. `ended`/`missing` → `'dead-session'`; any live state (working/waiting/ask_user/check_permission/pending) → `'ok'` (a process mid-long-turn is not an error — the b.rmy/b.3ce long-turn guard, now keyed on the process). The raw tmux probe survives here **only as a fallback**: on `ErrSpawnNotFound` (AD row gone, nothing to consult) or any other `status` error, fall back to `_hasTmuxSession` (alive → `'ok'`, gone → `'dead-session'`) so an AD outage can't manufacture a false `'dead-session'` — the b.rmy invariant.
       - **ErrSpawnNotFound branch (in-loop):** keys on the tmux session by design (b.c3o) — no AD row exists, so there is nothing to reconcile or consult; only a direct probe of the deterministic session name is available. Unchanged.
     - **b.m4r shared memoized sweep — `reconcileMissingSweep`.** Both sweep callers above (this `working`-row up-front sweep and `resumeOrFreshSpawn`'s `reconcileMissingFirst`) go through one shared `reconcileMissingSweep` helper rather than calling `client.findMissing({})` inline. Because `findMissing({})` is a whole-store, idempotent sweep, a fleet restart — `startupSessionManager` runs per-channel at `concurrency=3`, and every `working`-row collision plus each dead-path `reconcileMissingFirst` would otherwise fire its own whole-store sweep — is collapsed by single-flight (concurrent callers share one in-flight sweep promise) plus a 10s TTL memo (a caller arriving just after the last successful sweep reuses that result). This sheds the redundant N-sweep amplification without changing recovery behavior; failures are never memoized, so the next caller after an error re-sweeps, and the health-checker's later per-channel calls (spaced on the order of a minute) always fall outside the TTL and get a fresh sweep.
     - `pending` / `check_permission` / `ask_user` → no-op (poller picks it up).
   - `ErrSpawnNotFound` race after collision → single retry-spawn.
   - Other errors → `postSpawnFailureToChannel(channelId, error)` queues a Slack-channel post (drained after `socket.start()`).
   - **b.uhv / b.k54 post-spawn dialog approval (Fix B — defense-in-depth):** at every fresh-spawn site (5 total in `spawnForRoute`), `approveTrustFolderDialog` runs immediately before `approveDevChannelsDialog`. The trust approver polls `client.readPane({ n_lines: 40, allow_pending: true })` until `TRUST_DIALOG_NEEDLE` (`'Yes, I trust this folder'`) appears or the timeout elapses. The needle matches the `confirmLabel` of the `n4` confirm widget, verified against Claude Code 2.1.120 (2026-06-02): `cancelFirst` is unset (defaults to `false`), so the option order is `[confirm, cancel]` and default focus is on confirm. The accept sequence is therefore a single Enter (`sendKeys({ text: '', allow_pending: true })`) — no `<Down>` needed. After Enter, a confirm-gone loop requires `DIALOG_GONE_CONFIRMS_REQUIRED` consecutive misses before continuing. **Divergent behavior vs `approveDevChannelsDialog`:** if the needle never appears within the timeout, `approveTrustFolderDialog` returns silently with no `recordStartupError` — this is the expected happy path once step 4a-bis (trust-bootstrap) has pre-accepted the cwd. Only `trust-folder-approve-still-visible` is recorded when the needle persists after Enter. Fix A (step 4a-bis) is the primary fix; this approver is defense-in-depth for unprovisioned cwds, clobbered trust state, or future Claude Code releases that change the trust storage format.
6. **Slack auth + Socket Mode connect** — `web.auth.test()` resolves the bot user; `socket.start()` opens the WebSocket.
7. **SR-2.1 poller start** — `startPermissionPoller({ getClient, web, intervalMs: routingConfig.agent_director_poll_interval_ms })`. Single-threaded interval loop; skipped-tick WARN at 5+ consecutive skips.
8. **Drain pre-auth spawn-failure queue** — `flushSpawnFailureQueue(web)` posts any errors that surfaced during steps 1–5 to their configured channel.
9. **Health-check poller** — `startHealthCheck()` begins backstop liveness checks via `client.status(...)`.

CSCB does NOT maintain its own `sessions.json` registry. agent-director owns Claude session-id state internally, surfaced via `client.resume(...)` and the SR-11 state machine.

### Disconnection

1. Transport closes → `onsessionclosed` fires
2. Session removed from registry
3. `onsessionclosed` resolves the session's CWD back to a `channelId` via `routingConfig.routes`
4. If a `channelId` is found, `scheduleRestart(channelId, cwd)` is called

### Auto-Restart

After `scheduleRestart` is called:

1. **Delay check** — if `session_restart_delay` is 0, restart is skipped immediately.
2. **Failure guard** — if the channel has reached `MAX_CONSECUTIVE_FAILURES` (3), restart is abandoned.
3. **Timer** — a `setTimeout` fires after `session_restart_delay` seconds.
4. **Liveness check** — `isSessionAlive(channelId)` calls `client.status({claude_instance_id})` and returns true when the state is in `AGENT_DIRECTOR_LIVE_STATES`; `ErrSpawnNotFound` → dead. If alive, `reconnectSession()` calls `reconnectMcp(channelId)` which sends `/mcp reconnect slack-channel-router` via `client.sendKeys(...)`.
5. **Kill zombie** — `client.kill({claude_instance_id})` is best-effort; `ErrSpawnNotFound` is ignored.
6. **Relaunch** — `launchSession(channelId, cwd, routingConfig)` collapses `spawnForRoute`'s richer outcome to a boolean. Resume vs fresh is decided by the SR-1.4 collision-then-act dispatch (no separate `sessionId` arg from CSCB — agent-director owns resume state). On failure the per-channel failure counter increments.
7. **Success reset** — when a session successfully reconnects and registers, `resetFailureCounter()` clears the counter for that channel.

### Health-Check Poller

A periodic backstop that runs alongside the reactive disconnect path. Where `onsessionclosed` handles restarts after MCP disconnects, the health-check poller catches sessions that die without triggering a close event (e.g., an externally-killed tmux session).

On each tick:

1. **Route iteration** — for each `channelId`/`cwd` pair in `routingConfig.routes`:
   - **Skip if restart pending/active** — `isRestartPendingOrActive(channelId)` returns true; a relaunch is already in flight.
   - **Skip if max failures reached** — `hasReachedMaxFailures(channelId)` returns true; the channel has been abandoned.
   - **Liveness check** — `isSessionAlive(channelId)` calls `client.status({claude_instance_id})`; the state is checked against `AGENT_DIRECTOR_LIVE_STATES`.
2. **Dead session** — if the liveness check fails, `scheduleRestart(channelId, cwd)` is called, delegating to the same restart path used by `onsessionclosed`.

The interval is controlled by `health_check_interval` in `config.json`. If the value is `0`, `startHealthCheck()` returns immediately and no interval is created. `stopHealthCheck()` clears the interval during graceful shutdown, before `cancelAllRestartTimers()` runs.

**Ordering invariant**: `startHealthCheck()` is called only after `startupSessionManager()` returns. Moving it earlier in the startup sequence would risk the poller racing with in-progress launches.

### start command

`start` (CLI subcommand) checks prerequisites (Slack tokens, `config.json`), then **self-daemonizes**: the parent process spawns a detached background child and exits, leaving the child running as the server. Detection of parent vs. child is via the `_CLI_DAEMON_CHILD` env marker.

The parent spawn uses `detached: true` (child becomes its own session leader via `setsid`), `stdio: ['ignore', logFd, logFd]` (stdin from `/dev/null`, stdout/stderr to `STATE_DIR/server.log` — no inherited pipes), and `child.unref()`. This isolates the server from the launcher's session and process group, so killing the launching shell's group does not kill the server. The child re-execs `start` with the marker set, redirects logging to `server.log`, and calls `startServer()`.

**Marker-leak guard (b.acn)**: the `_CLI_DAEMON_CHILD` marker alone is untrusted, because it can leak from an operator wrapper script (e.g. `start-all.sh` / `cscb-up`) into the launching environment. If leaked, the parent daemonize branch would be skipped and the server would run in-place inside the launcher's session — dying when that process group is killed. A genuine daemon child is always a session leader, so `start` requires the marker **and** session-leadership to trust it. `isSessionLeader()` reads the session id (field 4 after `comm`) from `/proc/self/stat` on Linux and compares it to the pid; it fails open (treats the process as a leader) where `/proc` is unavailable, preserving prior behavior on non-Linux platforms. A set-but-not-leader marker is treated as a leak: it is deleted and `start` falls through to the parent path to re-detach properly.

### stop command

`stop` (CLI subcommand) sends SIGTERM to the running server via the PID file at `STATE_DIR/server.pid`. If the process does not exit within `stop_timeout` seconds (default 30 s, configurable in `config.json`), a SIGKILL is sent. A brief 2 s confirmation poll follows the SIGKILL. Stale PID files (process no longer running) are silently removed. A non-zero exit from this phase causes `stop` to exit 1.

Plain `stop` leaves the managed bots running (they are meant to survive server restarts — see [Graceful Shutdown](#graceful-shutdown-sr-11-event-11)). The **`--stop-bots`** flag (b.4dk) additionally exits the bots gracefully, mirroring `clean_restart`'s order: the server daemon is stopped **first**, then the shared `teardownBots` closure runs (the same per-route pause/poll/kill sequence as `clean_restart`, minus the restart phase). Stopping the server first prevents its `onsessionclosed`/`scheduleRestart` handler (`src/server.ts:381-403`) from respawning a just-exited bot mid-teardown — the respawn would delete the bot's `ended` row and history before SIGTERM lands. `directorPause` is an agent-director client subprocess that needs no live CSCB daemon (SessionEnd hooks are wired by agent-director into the spawned claude process and call the AD binary), so teardown works fine after the server is down. Teardown errors are logged and do not block the server stop. A pause-timeout kill escalation does NOT guarantee an `ended` row — that residual case is recovered later by the dead-session `findMissing`→`resume` path.

### clean_restart (SR-11 Event 12)

`clean_restart` (CLI subcommand) stops the server daemon first, then concurrently pauses every managed Claude Code spawn via agent-director, then starts a fresh server. The stop-first ordering prevents the health-check poller and auto-restart logic from interfering with the teardown. It logs to `STATE_DIR/clean_restart.log` via `initLogging()`. `CliDeps` exposes injectable `directorStatus`, `directorPause`, and `directorKill` adapters (the production implementations call `getClient().status/pause/kill`). The per-route teardown (steps 3–4 below) lives in a shared `teardownBots(routes, exit_timeout)` closure reused by `stop --stop-bots` (b.4dk).

Algorithm:

1. **Init logging + load config** — `initLogging()` redirects output to `clean_restart.log`. `loadConfig()` provides the `routes` map and `exit_timeout`. Config load failure is fatal.
2. **Stop server daemon** — shells out to `claude-slack-channel-bots stop`, which sends SIGTERM and escalates to SIGKILL after `stop_timeout`.
3. **Per-route precheck** — `directorStatus(channelId)` returns `null` on `ErrSpawnNotFound` (no row → skip); terminal states (`ended`, `missing`) → skip; otherwise proceed.
4. **Pause + poll** — `directorPause(channelId)` is called; if it rejects, escalate immediately to `directorKill(channelId)`. After a successful pause, `directorStatus(channelId)` is polled with exponential backoff (100 ms start, capped at 2 s, total budget `exit_timeout`). The first poll observing `null` / `ended` / `missing` is treated as clean exit. If the budget is exhausted, `directorKill(channelId)` force-terminates the spawn.
5. **Start new server daemon** — shells out to `claude-slack-channel-bots start`.
6. **Exit** — a non-zero exit code from `start` is propagated and the process exits with that code.

Per-channel polling cadence (100 ms → 2 s cap, `exit_timeout` total) is unrelated to the SR-2.1 permission poller's `agent_director_poll_interval_ms`.

### Graceful Shutdown (SR-11 Event 11)

On `SIGTERM` or `SIGINT`, the shutdown handler:
1. Flips the `shuttingDown` flag (idempotent guard).
2. Calls `stopPermissionPoller()` to stop the SR-2.1 tick.
3. Calls `stopHealthCheck()`, `cancelAllRestartTimers()`, `stopAllKeepAliveTimers()`.
4. Stops the HTTP server, drains pending + active MCP transports.
5. Disconnects Socket Mode.
6. Calls `closeClient()` inside a try/catch to release the agent-director Client handle. The library's `close()` is idempotent and never throws; the catch is belt-and-suspenders.
7. Removes the PID file.

The bots themselves are NOT killed or paused on shutdown — same as the prior behavior and consistent with SR-11 Event 11.

## SR-11 Substitution Table

State transitions and event triggers follow `t1.qfc.bg` SR-11 in full. Where the predecessor SRD references a CLI verb, this implementation calls the equivalent typed library method:

| `t1.fp3.63` CLI verb | This implementation's library equivalent |
|---|---|
| `claude-director spawn` | `client.spawn(SpawnParams)` |
| `claude-director resume` | `client.resume({ claude_instance_id })` |
| `claude-director kill` | `client.kill({ claude_instance_id })` |
| `claude-director pause` | `client.pause({ claude_instance_id })` |
| `claude-director delete` | `client.delete({ claude_instance_id: [...] })` |
| `claude-director list --label/--state` | `client.list({ label, state })` |
| `claude-director get` | `client.get({ claude_instance_id })` |
| `claude-director status` | `client.status({ claude_instance_id })` |
| `claude-director send-keys` | `client.sendKeys({ claude_instance_id, text })` |
| `claude-director decide` | `client.decide({ claude_instance_id, decision })` |
| `claude-director version` | `client.version({})` |
| `claude-director find-missing` | `client.findMissing({})` — called once by the dead-session recovery path before `resume` (b.4dk, `reconcileMissingFirst`). Also runnable by operators as a periodic sweep (SR-5.4). |

## Configuration

### config.json (~/.claude/channels/slack/config.json)

Maps Slack channels to project directories. The server uses CWD matching to route sessions.

Key fields:
- `routes` — `Record<channelId, { cwd: string }>` — the channel-to-directory mapping
- `bind` — HTTP server bind address (default: 127.0.0.1)
- `port` — HTTP server port (default: 3100)
- `default_route` — CWD for channels without explicit routes
- `default_dm_session` — CWD for handling direct messages
- `session_restart_delay` — seconds before auto-restarting dead sessions (default: 60, 0 = disabled)
- `health_check_interval` — seconds between health-check polls (default: 120, 0 = disabled)
- `exit_timeout` — seconds `clean_restart` waits for a Claude session to exit cleanly before force-killing it (default: 120)
- `stop_timeout` — seconds the `stop` command waits after SIGTERM before escalating to SIGKILL (default: 30)
- `mcp_config_path` — path to MCP config file for Claude launch (default: ~/.claude/slack-mcp.json)
- `append_system_prompt_file` — optional path to a file appended to every managed session's system prompt via `--append-system-prompt-file`; missing file silently skipped
- `system_prompt_mode` — controls whether `append_system_prompt_file` is applied (default: `"append"`; valid: `append`, `none`). `"append"` passes `--append-system-prompt-file` to Claude when launching sessions; `"none"` skips the flag entirely so only `CLAUDE.md` is used
- `cozempic_prescription` — cozempic cleaning intensity used before `--resume` launches (default: `"standard"`; valid: `gentle`, `standard`, `aggressive`); has no effect if cozempic is not installed
- `claude_config_dir` — optional path to a Claude on-disk config directory used for managed sessions; when set, launches are prefixed with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the route authenticates against a specific account. `~` is expanded and the path is resolved to absolute. Per-route `routes[id].claude_config_dir` overrides this top-level value. When neither is set, Claude's own default applies.
- `resume_enabled` — boolean (default: `true`). When `false`, the session manager skips `--resume` entirely and always performs a fresh launch, even when a stored session ID exists. Use this to work around versions of Claude Code that crash on `--resume` (e.g. the v2.1.120 "sandbox required but unavailable" regression). Affects both startup (step 4, **Resume** branch) and auto-restart (step 6).
- `stop_hook_bootstrap` — boolean (default: `true`). Controls whether step 4a-ter `stopHookBootstrap` installs the CSCB-managed Slack Reply Guard Stop hook into `<effective_claude_config_dir>/settings.json`. Registered in `KNOWN_TOP_LEVEL_KEYS` and `KNOWN_ROUTE_KEYS`; `applyDefaults` fills the top-level value to `true` when absent; `validateConfig` rejects a non-boolean at either scope. Per-route `routes[id].stop_hook_bootstrap` overrides the top-level value (`route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap`), and the resolved values feed the per-dir aggregation in step 4a-ter — a per-route opt-out only fully disables the guard for a bot when its route owns a dedicated `claude_config_dir`.

### agent-director state.db (~/.agent-director/state.db)

Persistent CSCB-spawn registry — owned by agent-director, not CSCB. CSCB reads this transitively via `client.list/status/get/resume(...)`. Same-user invariant verified at SR-5.1 startup gate.

### startup-errors.log (~/.claude/channels/slack/startup-errors.log)

Append-only log of fatal startup errors written by `recordStartupError` (`src/startup-errors.ts`). One timestamped line per entry; includes the agent-director `errName` when surfacing typed library errors. Rotation is operator-owned via `docs/logrotate-startup-errors.conf`.

### permission-trail.jsonl (~/.claude/channels/slack/permission-trail.jsonl)

Append-only **JSON Lines** event store for the CSCB-side visibility trail of the AD↔CSCB tool-permission relay (SRD `t1.cdb.4g`). One JSON object per newline-terminated line. The file path honors `SLACK_STATE_DIR` — default `~/.claude/channels/slack/permission-trail.jsonl`. Owned by `src/permission-trail.ts`; every emit goes through `emitTrail()` (auto-stamps `ts`) or `emitTrailEvent()` (caller-supplied `ts`).

**Line schema** (enforced at the emitter — SR-V-1 / SR-V-4.5):

| Field | Type | When present | Notes |
|---|---|---|---|
| `ts` | string | always | RFC 3339 with ≥ ms precision (SR-V-4.3, SR-V-4.5). Substituted with a `[slack]` warning if missing/invalid. |
| `event` | string | always | Stable hierarchical identifier in the `cscb.*` namespace (e.g. `cscb.chat_post.attempted`, `cscb.click_handler.invoked`, `cscb.chat_update.attempted`, `cscb.decide.attempted`, `cscb.block_actions.received`). |
| `request_token` | string | when AD has minted one | AD-side UUID (SR-V-1.1). Absent for events emitted before token assignment (SR-V-1.2). |
| `claude_instance_id` | string | whenever known | Primary join key when `request_token` is absent (SR-V-1.2). |
| `channel` | string | events touching Slack | Slack channel id (SR-V-1.3). |
| `message_ts` | string | events touching Slack | Slack message `ts` of the prompt or closure (SR-V-1.3). |
| _per-event-class fields_ | any | event-class specific | Passed through verbatim — no truncation (SR-V-3). |

**Example line** (a `chat.postMessage` attempt emitted by the SR-2.1 poller):

```json
{"ts":"2026-06-04T20:39:58.123Z","event":"cscb.chat_post.attempted","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","channel":"C0B1ZJJLJ9M","text":"*Permission* requested for `Bash`","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"…"}},{"type":"actions","elements":[{"type":"button","action_id":"perm_allow_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","text":{"type":"plain_text","text":"Allow"}},{"type":"button","action_id":"perm_deny_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","text":{"type":"plain_text","text":"Deny"}}]}],"ok":true,"slack_ts":"1717536002.000100"}
```

**No-truncation guarantee.** The canonical trail line persists every field at full fidelity (SR-V-3.1) — the full `blocks` array including every `action_id`, the full `text`, the full Slack API response. The 300-character `console.error('[slack] RAW message event:', JSON.stringify(...).slice(0, 300))` summaries at `src/server.ts:699` / `:712` are a **separate human-readable log** kept truncated intentionally per SR-V-3.2; they do not replace the canonical store and the two coexist.

**`jq` smoke-check** — confirm the file is valid JSONL and pivot by correlation key:

```sh
# Every line parses as JSON
jq -c . ~/.claude/channels/slack/permission-trail.jsonl | head -3

# Every event for one request_token, in time order
jq -c 'select(.request_token=="6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd")' \
  ~/.claude/channels/slack/permission-trail.jsonl

# Every event on a Slack channel within a time window (SR-V-5.2)
jq -c 'select(.channel=="C0B1ZJJLJ9M" and .ts>="2026-06-04T20:00:00Z" and .ts<="2026-06-04T21:00:00Z")' \
  ~/.claude/channels/slack/permission-trail.jsonl
```

**Federation.** AD emits a complementary JSONL log on its side (`t1.n4v.14`). The two logs join on `request_token` + `claude_instance_id` per SR-V-4. No shared store; the operator stitches the trail via `jq` or equivalent.

**Retention.** None. The file is append-only and the system does not self-protect against disk pressure (SR-V-5.5). Operators rotate / archive / delete out-of-band.

#### `cscb.poller.row_decision` (SR-V-2.3)

Emitted once per `permission_requests` row per tick (and once per `non_conforming_skipped` spawn per tick) from `src/permission-poller.ts`. The `action` field is one of six stable identifiers; the set is open to extension per SR-V-2.3 — new poller branches may add identifiers without an SRD edit.

| `action` | Meaning |
|---|---|
| `post_attempted` | New row seen this tick; `chat.postMessage` was issued for this `request_token`. |
| `already_tracked` | Row's composite key already in `livePermissions`; no-op this tick. |
| `reconciled_closed` | Row no longer in the tick's projection; `getPermission` returned a verdict and a closure `chat.update` was sent. |
| `not_found_generic_deny` | `getPermission` threw `ErrPermissionRequestNotFound`; the generic-deny closure was sent and the entry dropped. |
| `non_conforming_skipped` | The spawn's `permission_requests` was `null`/`undefined`; the row was excluded from the closure sweep this tick. `request_token` is **absent** on this event per SR-V-1.1. |
| `transient_retry` | Transient error on `getPermission`; the entry was left alive for the next tick to retry. |

Fields: `ts`, `event="cscb.poller.row_decision"`, `claude_instance_id`, `action`, and `request_token` (omitted on `non_conforming_skipped`). The envelope `ts` is the only timestamp on the event — there is no per-tick `tick_at` field.

#### `cscb.chat_post.attempted` (SR-V-2.4)

Emitted from `postPermissionPrompt` in `src/permission-poller.ts` for **every** permission-prompt `chat.postMessage` call — success **and** failure. Successes are trail-only; failures land in BOTH the trail (as `ok=false` with a Slack error class string) AND `server.log` via `logViaDeps` (`b.emk` defense-in-depth — the trail is for after-the-fact debugging, `server.log` is for real-time operator visibility). The pre-`b.emk` asymmetry where only failures had a console log is gone — successes are still silent in `server.log`, but failures now appear on both surfaces.

Fields:
- `ts`, `event="cscb.chat_post.attempted"`, `claude_instance_id`, `request_token`, `channel`.
- `text` — the full posted text string, untruncated (SR-V-3.1).
- `blocks` — the full posted Block Kit array, untruncated; both Allow and Deny `action_id`s are present and decodable via `parsePermissionActionId` (SR-V-1.4).
- `ok` — `true` on success, `false` on failure.
- On success: `slack_ts` — the `ts` Slack returned for the posted message (the Slack-side message id, distinct from the envelope `ts`).
- On failure: `error` — the **Slack platform error class string** (e.g. `"channel_not_found"`) from `WebAPIPlatformError.data.error`; falls back to `"network_error"` / `"unknown_error"` for non-platform exceptions. Never the JS `Error.name`.

**Combined example** — a row's first-tick emissions:

```json
{"ts":"2026-06-04T20:39:58.110Z","event":"cscb.poller.row_decision","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","action":"post_attempted","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd"}
{"ts":"2026-06-04T20:39:58.123Z","event":"cscb.chat_post.attempted","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","channel":"C0B1ZJJLJ9M","text":"🤖🛠️ permission request: Bash","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"🤖🛠️ *Bash*\n`ls`"}},{"type":"actions","elements":[{"type":"button","text":{"type":"plain_text","text":"Allow"},"style":"primary","action_id":"perm_allow_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd"},{"type":"button","text":{"type":"plain_text","text":"Deny"},"style":"danger","action_id":"perm_deny_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd"}]}],"ok":true,"slack_ts":"1780600244.439969"}
```

#### `cscb.chat_update.attempted` (SR-V-2.5)

Emitted for every `chat.update` that closes out a permission prompt. Two surfaces emit: the poller's `renderClosureUpdate` (`src/permission-poller.ts`) and the click handler's verdict-render (`src/permission-click-handler.ts`). Both success and failure emit. Successes are trail-only; failures land in BOTH the trail (as `ok=false` with the Slack platform error class string) AND `server.log` via `logViaDeps`/`logDeps` (`b.emk` defense-in-depth). Successes stay silent in `server.log`, preserving the original SR-V-2.5 asymmetric-behavior fix.

Fields:
- `ts`, `event="cscb.chat_update.attempted"`, `claude_instance_id`, `request_token`, `channel`, `message_ts` (the prompt `ts` being updated).
- `text` — the new closure text, untruncated.
- `blocks` — the new closure blocks array, untruncated.
- `verdict_tag` — one of the 8 values below.
- `triggered_by` — `"poller"` or `"click_handler"`.
- `ok` — `true` on success, `false` on failure.
- On failure: `error` — Slack platform error class string (e.g. `"message_not_found"`); never JS `Error.name`.

**Verdict tags** — closure rendering identity. The set is open to extension.

| `verdict_tag` | Emitted from | Meaning |
|---|---|---|
| `operator_allow` | poller | `decision=allow`, `decision_reason=null` — operator allowed via click or TUI. |
| `operator_deny` | poller | `decision=deny`, `decision_reason="operator"`. |
| `timeout` | poller | `decision=deny`, `decision_reason="timeout"`. |
| `find_missing` | poller | `decision=deny`, `decision_reason="find_missing"` — spawn ended before the human responded. |
| `unknown` | poller | Any other `decision`/`decision_reason` pair — fail-closed generic deny per SR-5.2. |
| `not_found` | poller | `getPermission` returned `ErrPermissionRequestNotFound`. |
| `click_handler_allow` | click handler | Allow button click whose `chat.update` rendered the verdict. |
| `click_handler_deny` | click handler | Deny button click whose `chat.update` rendered the verdict. |

**`triggered_by` values** — `"poller"` (SR-2.4 reconciliation) or `"click_handler"` (SR-4.5 verdict render). Open to extension.

**Example** — poller-reconciled `operator_allow` closure:

```json
{"ts":"2026-06-04T20:40:02.456Z","event":"cscb.chat_update.attempted","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","channel":"C0B1ZJJLJ9M","message_ts":"1780600244.439969","text":"*Permission* — Allowed","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Permission* — Allowed"}}],"verdict_tag":"operator_allow","triggered_by":"poller","ok":true}
```

#### `cscb.block_action.received` (SR-V-2.9)

Emitted once per inbound `block_actions` action from the Socket Mode interactive handler in `src/server.ts`, regardless of whether the `action_id` decodes. This is the diagnostically critical surface for **"I clicked Allow and nothing happened"** — decode-failure cases are explicitly in scope. The classification helper lives in `src/permission-click-handler.ts` (`emitBlockActionReceived`) so the server stays a thin wiring layer.

Fields:
- **Always present**: `ts`, `event="cscb.block_action.received"`, `channel`, `message_ts`, `user`, `raw_action_id`.
- **On decode success**: `claude_instance_id`, `request_token`, `decision` (`"allow"` | `"deny"`). `parse_failure_reason` is omitted.
- **On decode failure**: `parse_failure_reason` (table below). Decoded fields are omitted.

**Parse-failure reason set** — open to extension per SR-V-2.9:

| `parse_failure_reason` | Meaning |
|---|---|
| `foreign_action_id` | `action_id` does not match the `perm_(allow|deny)_*` prefix — not a CSCB permission button at all. |
| `malformed_token` | `action_id` matches the `perm_(allow|deny)_*` prefix but `parsePermissionActionId` returns `null` (body broken). |

**Not a parse failure: `stale_prompt`.** A click on a closed prompt decodes fine — the `action_id` is still well-formed. Stale clicks surface as `cscb.click_handler.invoked{live_pending: false}` instead.

#### `cscb.click_handler.invoked` (SR-V-2.6)

Emitted from `handlePermissionClick` in `src/permission-click-handler.ts` for every parsed-as-permission click. Emitted exactly once per call, after `parsePermissionActionId` succeeds and before the AD `decide` call. Decode-failure clicks (foreign or malformed action_id) do NOT emit this event — they show up only as `cscb.block_action.received{parse_failure_reason}`.

Fields: `ts`, `event="cscb.click_handler.invoked"`, `claude_instance_id`, `request_token`, `decision`, `channel`, `message_ts`, `user`, `raw_action_id`, `live_pending` (boolean).

`live_pending` is the result of `getLivePermission(claude_instance_id, request_token) !== undefined` at handler entry. `true` means a `LivePermission` entry existed (happy path); `false` means the click decoded fine but the entry had already aged out or been dropped — the operator's "I clicked but the prompt was already closed" diagnostic.

**Example sequence** — happy-path Allow click:

```json
{"ts":"2026-06-04T20:40:01.111Z","event":"cscb.block_action.received","channel":"C0B1ZJJLJ9M","message_ts":"1780600244.439969","user":"U_OPERATOR","raw_action_id":"perm_allow_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","decision":"allow"}
{"ts":"2026-06-04T20:40:01.112Z","event":"cscb.click_handler.invoked","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","channel":"C0B1ZJJLJ9M","message_ts":"1780600244.439969","user":"U_OPERATOR","raw_action_id":"perm_allow_cscb_demo_C0B1ZJJLJ9M_6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","decision":"allow","live_pending":true}
```

**Note on the `src/server.ts:699` / `:712` truncation.** The existing `console.error('[slack] RAW message event:', JSON.stringify(...).slice(0, 300))` summaries are INTENTIONALLY preserved per SR-V-3.2 — they are a separate human-readable log. The canonical store is full-fidelity by construction (no `.slice` in the trail emit path).

#### `cscb.ad_decide.attempted` (SR-V-2.7 call-side)

Emitted from `handlePermissionClick` (`src/permission-click-handler.ts`) once per `decideWithToken` invocation, on success and on every error path. This is the CSCB-side half of SR-V-2.7; AD's complementary SR-A-2.4 emission lives in `t1.n4v.14`. The two halves join on `request_token` for after-the-fact debugging.

Fields:
- `ts`, `event="cscb.ad_decide.attempted"`, `claude_instance_id`, `request_token`, `decision` (submitted — `"allow"` | `"deny"`).
- `result_class` — one of the 5 values below.
- On `result_class="other"`: additionally `raw_error_message` (the original error's `.message` string, untruncated). For the four named classes, `raw_error_message` is OMITTED.
- `submitted_decision_reason` — currently never sent on the wire from CSCB. Documented for future use per SR-V-2.7's "when present" rule.

**Response-class set** — match the AD error identifiers in `src/agent-director-errors.ts` so the trail's classification stays consistent with the rest of the codebase. Open to extension.

| `result_class` | Meaning |
|---|---|
| `ok` | `decideWithToken` returned without throwing. |
| `ErrAlreadyDecided` | The request was already closed (race with poller reconciliation or peer click). |
| `ErrInvalidFlags` | AD rejected the call shape — typically a missing required field. Should not happen under contract. |
| `ErrAmbiguousRequest` | AD couldn't uniquely identify the request — defense-in-depth backstop per SR-4.4. |
| `other` | Any other thrown value (non-AD error, transport, etc.). `raw_error_message` carries the original `.message`. |

**Example** — happy-path `ad_decide.attempted` after a click:

```json
{"ts":"2026-06-04T20:40:01.130Z","event":"cscb.ad_decide.attempted","claude_instance_id":"cscb_demo_C0B1ZJJLJ9M","request_token":"6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd","decision":"allow","result_class":"ok"}
```

**Operational logging.** The existing `[slack] permission-click: ErrInvalidFlags from decide for ...` / `ErrAmbiguousRequest` / `decide failed for ...` `console.error` lines stay alongside the trail event. They serve a different purpose — live stderr monitoring — and are intentionally not redundant with the canonical after-the-fact debugging surface.

#### Trail file location and query recipes — SR-V-5 / SR-V-6

The file is the surface; `tail`, `grep`, and `jq` are the readers. No running CSCB process is required and nothing is perturbed (SR-V-6.2).

**Path:** `~/.claude/channels/slack/permission-trail.jsonl`
**Directory override:** `SLACK_STATE_DIR` (sets the directory; file name is always `permission-trail.jsonl`)

**Single-side recipes:**

```sh
# Live stream
tail -f ~/.claude/channels/slack/permission-trail.jsonl

# SR-V-5.1: every event for one interaction
jq -c 'select(.request_token=="X")' ~/.claude/channels/slack/permission-trail.jsonl

# SR-V-5.2: events on a channel within a time window
jq -c 'select(.channel=="C..." and .ts >= "T1" and .ts <= "T2")' \
  ~/.claude/channels/slack/permission-trail.jsonl
```

**Cross-side join** (AD trail + CSCB trail, ordered by `ts`, filtered to one interaction):

```sh
cat ~/.agent-director/ad-trail.jsonl ~/.claude/channels/slack/permission-trail.jsonl \
  | jq -sc 'sort_by(.ts) | map(select(.request_token=="X"))[]'
```

**Join keys** for stitching the CSCB trail against the AD trail (SR-V-4):

| Key | Emitted by (CSCB surface) | When |
|---|---|---|
| `request_token` | every CSCB event after AD mints one | primary join key (SR-V-1.1) |
| `claude_instance_id` | every CSCB event when known | join when no token yet (SR-V-1.2) |
| `channel` + `message_ts` | every Slack-touching event (`chat_post.attempted`, `chat_update.attempted`, `block_action.received`, `click_handler.invoked`) | Slack pivot (SR-V-1.3) |

The AD trail (file owned by agent-director — see `t1.n4v.14`) emits the complementary side; the operator joins by `request_token` and orders by `ts`.

**SRD §10 question → answering event class** — CSCB side (questions 2–5; question 1 is AD's):

| SRD §10 question | Answered by |
|---|---|
| Q2: Did CSCB issue a `chat.postMessage` carrying the expected Block Kit blocks? | `cscb.chat_post.attempted` — `text` and `blocks` fields. |
| Q3: What `ts` did Slack return? | `cscb.chat_post.attempted` — `slack_ts` field. |
| Q4: Was a `block_actions` click received against that `ts`? | `cscb.block_action.received` — `message_ts` field equals the post's `slack_ts`. |
| Q5: Did the closure render on the original `ts`? | `cscb.chat_update.attempted` — `message_ts` field equals the post's `slack_ts`. |

### Removed pre-Epic-2 files

The previous tmux-direct architecture wrote `~/.claude/channels/slack/sessions.json` to persist tmux session names and discovered Claude session UUIDs. Both responsibilities have moved to agent-director — `sessions.json` and `sessions.json.last` no longer exist. Operators upgrading from a pre-Epic-2 install can safely delete the stale files; CSCB will not read them.

### server.pid (STATE_DIR/server.pid)

Written at startup with the server's process ID. Used by the CLI `stop` command to send SIGTERM (with SIGKILL escalation after `stop_timeout`) to a running server, and by startup to detect a conflicting already-running instance. Removed on graceful shutdown.

### Environment Variables

Required at startup:

- `SLACK_BOT_TOKEN` — bot user OAuth token; must begin with `xoxb-`
- `SLACK_APP_TOKEN` — app-level token for Socket Mode; must begin with `xapp-`

Both values are read directly from the process environment. When `SLACK_DRY_RUN` is set (see below), `loadTokens()` returns dummy values (`xoxb-dry-run` / `xapp-dry-run`) and validation is skipped.

Optional:

- `SLACK_DRY_RUN` — set to `1`, `true`, or `yes` to enable dry-run mode. Bypasses token validation, skips `socket.start()` and `web.auth.test()`, and stubs all MCP tool calls (`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`) — each returns a `[dry-run]` placeholder and logs the call to the server log. The HTTP/MCP server still starts normally so Claude Code sessions can connect and exercise tool calls without a Slack workspace.

Optional CLAUDE_CONFIG_DIR (set at spawn time via SpawnParams.extra_env when configured per-route or top-level) is propagated by agent-director to the spawn's tmux session, enabling per-route Claude account selection.

### access.json (~/.claude/channels/slack/access.json)

Access control policy: DM policy, allowlist, channel policies, ack reaction. chmod 600.

## Logging

### Why console.error/console.log are overridden directly

Bun bypasses `process.stderr.write` overrides — the runtime writes directly to the file descriptor, so patching `process.stderr.write` has no effect. `src/logging.ts` works around this by replacing `console.error` and `console.log` themselves before any logging occurs.

### initLogging()

`initLogging(logFilePath)` in `src/logging.ts` opens the target file in append mode and replaces both `console.error` and `console.log` with wrapper functions that:

1. Format all arguments to a single string (JSON-serializing objects)
2. Prepend an ISO-8601 timestamp: `[2024-01-01T00:00:00.000Z] message`
3. Roll the file if it has grown past the threshold (see **Rotation** below)
4. Write the line synchronously via `writeSync` to the open file descriptor
5. Fall back to the original `console.error`/`console.log` if the write fails

The originals are captured at module load time so the fallback always refers to Bun's native output.

### Rotation (b.brv)

Rotation is built into `src/logging.ts` so it applies on every machine that runs CSCB — no per-host logrotate config. `maybeRotate()` runs before each write: it `fstat`s the active fd and, when the size crosses the threshold, closes the fd, shifts `<path>.N-1 → <path>.N` down to `<path>.1`, renames the active file to `<path>.1`, discards the oldest generation beyond `CSCB_LOG_KEEP`, and reopens a fresh active file. It is best-effort — any filesystem error is swallowed rather than thrown into the caller's hot path, and a failed reopen after rotation is recovered on a subsequent write rather than disabling file logging.

| Env var | Default | Effect |
|---|---|---|
| `CSCB_LOG_MAX_BYTES` | 10 MiB (`10485760`) | Rotate when the active file reaches N bytes. Values `<= 0` or non-numeric ignored. |
| `CSCB_LOG_KEEP` | 5 | Rotated generations retained. `0` = keep none (the active file is `rm`ed on rotation, i.e. truncate). Values `< 0` or non-numeric ignored. |

Rotated generations are **not** compressed. Applies to both `server.log` and `clean_restart.log` (any file passed to `initLogging`). This is distinct from `startup-errors.log`, whose rotation remains operator-owned via `docs/logrotate-startup-errors.conf`.

### agent-director logger filter (b.brv)

The agent-director `Client` is constructed with a `logger` in `src/agent-director-startup.ts`, and since `initLogging()` patches `console`, everything the Client logs lands in `server.log`. At info level the Client emits a per-poll `SubprocessClient: <verb> ok { … }` success dump for every `list`/`status`/`get`/`decide` call — with CSCB polling continuously, these dumps historically dominated the log (2 GB / 137 MB observed in b.brv). `makeFilteredAdLogger(console)` in `src/agent-director-logger.ts` wraps the console: it drops those routine `SubprocessClient: <verb> ok` records at `log`/`info` level while passing `warn`/`error` through unfiltered. Setting `CSCB_AD_VERBOSE` to a truthy value (`1`/`true`/`yes`/`on`) returns the base logger unwrapped, restoring the full chatter for debugging.

### HTTP request access line (b.3k6)

The `/mcp` endpoint's `fetch` handler in `src/server.ts` is hit on every MCP round-trip — client polls, notifications, tool-call responses, and each SSE stream open — so its one-line-per-request access log (`[slack] HTTP <method> <path> session=…`) is the highest-frequency routine success line left in `server.log` after b.brv silenced the `SubprocessClient` dumps. It shares their signal/noise profile: routine and continuous at steady state, useful only when debugging a specific transport/session-routing problem. It is gated behind `isHttpVerbose()`, which reads `CSCB_HTTP_VERBOSE` (truthy: `1`/`true`/`yes`/`on`, case-insensitive) — off by default. Unlike `CSCB_AD_VERBOSE`, the env var is checked per request rather than once at startup, so toggling it takes effect without a restart. Real events (session connect/disconnect, route mismatch, errors) are logged unconditionally elsewhere and are unaffected by this flag.

### Log file locations

Both paths are rooted in `SLACK_STATE_DIR` (default: `~/.claude/channels/slack/`).

| Process | Log file |
|---------|----------|
| Server daemon (`server.ts`) | `STATE_DIR/server.log` |
| `clean_restart` subcommand | `STATE_DIR/clean_restart.log` |

Both files are opened in append mode — multiple restarts accumulate in the same file rather than overwriting it (subject to the size-based rotation above).

## Endpoint Inventory

### POST /interject

Injects a message directly into an active Claude session without going through Slack. Localhost-only.

**Request body** (JSON, max 32 KB)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | yes | Slack channel ID |
| `message` | string | yes | Message content to inject |
| `sender` | string | no | Display name; defaults to `"interject"` |

**Success response**

`200 OK` — `{ ok: true, channel, cwd }`

**Status codes**

| Status | Condition |
|--------|-----------|
| 200 | Notification delivered to session |
| 400 | Invalid JSON or missing required field (`channel`, `message`) |
| 403 | Non-localhost origin |
| 404 | Channel not found in `routingConfig.routes` |
| 405 | Non-POST method |
| 413 | Body exceeds 32 KB |
| 503 | No active session for the channel |

**Behavior**

- Looks up the channel in `routingConfig.routes`; 404 if absent
- Calls `getSessionByChannel()` to resolve the active session; 503 if none or not connected
- Sends `notifications/claude/channel` with `content: message` and `meta: { chat_id, message_id, user, ts }` (timestamps derived from `Date.now()`)
- Does not call `gate()`, the Slack API, or mutate `deliveredChannels`

## Security Model

- **Gate layer**: All inbound messages pass through `gate()` — drops bot messages, enforces DM policy, validates allowlist
- **Outbound scoping**: Each session can only send to channels it has received messages from (per-session `deliveredChannels` Set)
- **File exfiltration guard**: `assertSendable()` blocks uploading files from the state directory
- **Localhost restriction**: `/permission`, `/ask`, and `/interject` endpoints only accept requests from 127.0.0.1/::1/::ffff:127.*
- **Session scope guard**: agent-director enforces session scope via `relay_mode='on'` at spawn time. Permission requests are routed through agent-director's internal relay machinery (SR-2.1 poller), which is scoped to the spawned session. Sessions not spawned by CSCB have no relay route and no `PermissionRequest` or `PreToolUse` hook entries in `settings.json` — the `.sh` hook files are not shipped.
