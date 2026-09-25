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
- **Server wiring** stays in server.ts — building the connection manager and registering the per-persona event handler with it, HTTP routing, startup/shutdown, process lifecycle. Slack clients are created only by the connection manager through its injected `PersonaSlackClientFactory` (see Security), never at module scope and never in server.ts; server.ts reads a persona's client only through `clientFor(key)`. Importing server.ts must stay free of Slack clients, token reads and directory creation: that work belongs in `main()`
- **Per-persona start and event routing** live in importable, side-effect-free modules: the SR-6.1 bring-up steps (`checkPersonaLocalSteps` for steps 1–2, `connectPersonaSlack` for step 3) and the connection seams (`clientFor`, the identity lookup, the up-flush listener, the up predicate `createPersonaUpPredicate`, the relaunch gate) in `src/persona-start.ts`, the per-persona outcomes, retries, launch after a retry, leaving-up listener and not-up session dropper (`createNotUpSessionDropper`) in `src/persona-bringup-controller.ts`, and the handler every persona connection forwards its `message`, `app_mention` and `interactive` events to in `src/persona-event-router.ts`. Put new start steps or event handling there, with dependencies injected, not in server.ts
- **Inbound delivery** lives in `src/persona-routing.ts`, which is importable and side-effect-free, with every client and source injected through `createPersonaRouting`. The event router only logs the RAW line and hands the event to its `receive` with the receiving persona's key; put drop logging and lost-message handling (the recovery decision and raising the lost-message notice through the injected `notify`) in the module, not in the router or server.ts, so tests drive the real code. The lost-message state and notice text live in the pure `src/lost-message.ts` (`decideLostMessageState`, `buildLostMessageNotice`); change a state or its wording there. The delivery rules themselves, channel and DM alike, live only in the pure `src/delivery-decision.ts` (`decideDelivery`); add or change a rule there, not in the pipeline. Inbound dedupe (b.av2 SR-4.1) lives in the pure `src/inbound-dedupe.ts`: the routing keeps one store per persona key, built with its injected `dedupeClock`; the store counts and limits nothing, so don't add a rate or count check to it

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
- Only start-wide failures exit the process with a clear message. The start rules (b.av2 SR-8.7) decide which configuration failures those are, and each is logged before any port, PID file, Slack connection or spawn:
  - With no last-applied record, a missing, unreadable, pre-persona or invalid config file (`[slack] Fatal: configuration error — …`), or a record that can't be written (`reload-record-write-failed`).
  - With a record, only a record that can't be read or validated (`[slack] Fatal: last-applied record error — …`, naming the record and saying that deleting it makes the next start apply the config file). The config file's validity doesn't gate such a start. Never fall back from a bad record to the config file.
  - The other start-wide steps: the startup gate, a PID conflict, the template refresh. The server loads no token, so there is no token failure to exit on
- A per-persona bring-up failure (credentials, working directory, Slack validation or connection) never exits the process: it is logged through the persona diagnostics below and isolated to that persona, which ends `broken` or `retrying` while the others and the server carry on (see Persona Bring-Up Retries). Don't add a `process.exit` or a thrown startup error on a per-persona path
- Persona diagnostic lines (b.av2 SR-10.3) go through `src/persona-diagnostics.ts`. Add a new class to its closed label set, build the line with `formatPersonaDiagnostic()` or `personaCheckFailure()`, and emit it only through an injected logger, never with a direct `console` call in a pure module. The cause is one line, names a bad token by its key and the rule it breaks, never by its value, and never quotes file contents
- Reload diagnostic classes (the last-applied record, the pending change) are a separate closed set, `RELOAD_DIAGNOSTIC_CLASSES` in `src/reload.ts`. Add a reload class there, not to `PERSONA_DIAGNOSTIC_CLASSES`: a reload line is about the server's configuration, not one persona's bring-up. Reload output goes to the server log only, never to Slack (b.av2 SR-7.2)
- On persona connection paths, log a thrown or rejected value only through `describeThrownValue()` in `src/persona-connection-errors.ts`, never the error object or its message: a Slack library error's message, request and headers can hold a token. For a failed Slack Web API call, end the log line with `describeSlackCallFailure()` from the same module, which adds the Slack platform reason when it is a safe identifier

## Configuration

- The config is the persona config at `config.json` in the state directory, but what runs is the last-applied record beside it, `config.json.last-applied` (b.av2 SR-8.1, SR-8.7). Saving `config.json` changes nothing that runs until a change is applied, and every start runs the record when it exists; the config file is validated, recorded and applied only at a start with no record. Nothing but the operator's confirmation (E12) applies a change: the detection tick (see [Reload Detection Tick](#reload-detection-tick)) only notices one and reports it in `config.json.pending` and the server log, and makes no lifecycle call; a bring-up retry doesn't pick it up either. The start rules live in the reload controller in `src/reload.ts` (`createReloadController`, every dependency injected); put reload work there, not in server.ts. Code that needs the applied config reads it from the controller or from `personaConfig` in server.ts, never from `config.json` directly (the SR-5.2 file guard's current-file read, `protectedCredentialsFiles()`, is the one exception)
- The CLI takes every setting it uses (such as `stop_timeout`) and its persona set only through the shared record-first resolver, `readAppliedPersonaConfig` in `src/reload.ts`: the record when it exists, otherwise the config file. Don't read `config.json` in CLI code with the persona loader, and never write, rewrite or delete any SR-8.1 file (`config.json.pending`, `config.json.apply`, `config.json.last-applied`) from the CLI. Why: `stop --stop-bots` and `clean_restart` must act on the personas that run, not on an edit that was never applied
- Parse configuration JSON only through `parsePersonaConfigBytes` in `src/config.ts`, from the bytes that were read, so the bytes recorded or applied are the bytes that were checked. It reports malformed JSON by line and column (`src/json-position.ts`) and never echoes the parser's message or any file content: a token pasted into the file must never reach a log. Don't add a second `JSON.parse` of a config or record file. The one exception is `referencedCredentialsPaths` in `src/config.ts`, the one extraction of the credentials paths a config file names, used by the SR-5.2 file guard (`credentialsFilesToProtect`) and the reload detection tick's fingerprint. It must stay tolerant, so a file with an invalid edit still yields the credentials paths it names; it discards any parse error rather than reporting it, and returns only paths. Get referenced credentials paths from it; don't parse the config file for them anywhere else
- Read the config file and the last-applied record only through `readPersonaConfigBytes` in `src/config.ts`. It is stat-first, like the credentials check: open read-only and non-blocking, `fstat` the descriptor, and read only a regular file through it. Why: a FIFO at either path would otherwise hang the start or the CLI, and a device such as `/dev/zero` would never end. Tests reach it through its `PersonaConfigFs` seam
- Resolve both locations only with `resolveServerStateDir()` / `resolveServerConfigPath()` in `src/config.ts` (state directory `~/.claude/channels/slack/`, overridable via `SLACK_STATE_DIR`); don't join the path by hand
- New config fields go into the persona config types, defaults and validation (the pre-persona keys exist only in `PRE_PERSONA_KEYS`, for the conversion error). Put each field where its scope says:
  - Server-wide keys: `ServerSettingsInput` (optional) and `ServerSettings` (resolved), a default in `applyServerDefaults()`, the key in `SHARED_TOP_LEVEL_KEYS`, and a rule in the shared validation helpers (`validateServerTimingsAndModes()` / `validateServerPollAndCron()`). A server-wide key that holds a path also goes in `SERVER_PATH_SETTINGS`, the one list of path-valued settings: `resolveServerPaths()` expands exactly these (its `satisfies` check fails the typecheck until the two agree), and the reload change plan compares exactly these by real path
  - Persona-only top-level keys: `PersonaConfigInput` and `PersonaConfig`, plus the key in `PERSONA_ONLY_SERVER_KEYS`
  - Persona-entry keys: `PersonaInput` and `Persona`, plus the key in `PERSONA_ENTRY_KEYS`; parse it in `parsePersonaEntry()`, the per-entry path `resolvePersonaConfig()` calls. `name`, `credentials_file`, `working_directory` and `permission_prompts` are required
  - A key missing from these key lists is rejected as unknown
  - Every new key also needs a reload effect: see "A new config field needs a reload effect" in [Reload Detection Tick](#reload-detection-tick)
  - Errors report the first violation only, render the persona with `renderPersonaRef()` from `src/persona-identity.ts`, and name the setting. Never echo a rejected value: an error may repeat only the persona name, IDs and paths that already passed their format rule
  - Never echo file text that could be a token, and that includes key names. Name an unknown key only when it is a plain setting name (`ECHOABLE_KEY_NAME_RE` in `src/config.ts`: letters and underscores, up to 48 characters); count the rest. Build every unknown-key error with `describeUnknownKeys`, which does both. Why: the running server's detection tick writes loader errors into `config.json.pending` and `server.log` every 5 s, so a token pasted as a key name would otherwise leak there (b.av2 SR-10.3)
- New "same path" checks compare configured paths through `resolveRealPath()` in `src/config.ts`: the real path, or the lexical `path.resolve` form when realpath fails. Tilde-expand the path first; tests inject the realpath function. Import it; don't write a second realpath-with-fallback helper, so these checks agree. One intentional exception stays as it is: the pure, lexical `configDirLabelValue` in `src/persona-identity.ts`. Spawns and any later `config_dir` label comparison use `personaConfigDirLabelValue` in `src/session-manager.ts`, which real-paths the dir through `resolveRealPath()` before hashing; don't hash a `config_dir` label from `configDirLabelValue` directly. To compare an agent-director row with a persona (its `cwd` against the working directory, its `config_dir` label against the persona's current one), call `compareRowToPersona` in `src/session-manager.ts`, as the collision ladder and the start sweep do, and pass the same home the spawn labels use; don't compare `cwd` strings or labels inline. When a check must know that a path has no real path (rather than silently fall back to its lexical form), use `tryResolveRealPath()`, which `resolveRealPath()` delegates to; `compareRowToPersona` reports it for the working directory as `workingDirectoryResolved`, and reports `cwdCheckDeferred` when neither the working directory nor the row's `cwd` has a real path (or the row's `cwd` equals the configured path lexically). A caller that acts on `cwdMatches` must check `cwdCheckDeferred` first; a row whose `cwd` resolves to an existing directory elsewhere is not deferred and is still a mismatch (see Serve Only Personas That Are Up). The same goes for E1's `personaLabels` in `src/persona-identity.ts`: it hashes the dir lexically and nothing in `src/` calls it. Spawns build their labels in `src/session-manager.ts` with `personaConfigDirLabelValue`; don't use `personaLabels` for spawn labels
- File writes that a reader may see mid-write are atomic, and those whose loss across a crash matters are also durable. The helpers live in `src/atomic-write.ts`; use them, don't write another:
  - `durableWriteFileSync` (b.av2 SR-8.1): writes a uniquely named temp file beside the target, fsyncs it, renames it over the target, then fsyncs the directory. Use it for every server write of the reload files (`config.json.pending`, `config.json.apply`, `config.json.last-applied`) and for any new file whose loss or rollback after a crash or power cut would matter. It logs nothing and rethrows every failure: before the rename the target is untouched, the temp file is removed and the error is thrown as raised; a failure to open or fsync the directory comes after the rename and is thrown as `DurableWriteUnsyncedError` (`path`, `code`, `syncError`), since the new bytes are already in place. A failure to close the directory after a successful fsync is ignored. A caller that must know the write is durable (the start's record write) treats either as a failure, and tells them apart with `instanceof DurableWriteUnsyncedError` so its log line says what is on disk. Tests pass a `DurableWriteFs` to observe the call order or fail one call, since permission-based failures aren't reliable when tests run as root
  - `durableUnlinkSync`: the delete counterpart. It unlinks the file, then fsyncs the directory, and returns `false` when the file was already gone. Every server delete of a reload file (such as removing `config.json.pending` when nothing is pending) uses it; don't `unlinkSync` or `rmSync` a reload file. It logs nothing and rethrows every other failure. An unlink failure is thrown as raised and leaves the file in place, so the caller logs it and retries at its next pass. A failure to open or fsync the directory comes after the unlink and is thrown as `DurableUnlinkUnsyncedError` (`path`, `code`, `syncError`), the counterpart of `DurableWriteUnsyncedError`: the file is gone, but the removal may not survive a crash. Tell the two apart with `instanceof DurableUnlinkUnsyncedError` and treat that case as removed; there is nothing left to retry
  - `atomicWriteFileSync`: writes a fixed `<path>.tmp`, then renames it; no fsync. Keep it for the files that already use it (the Stop-hook `settings.json` edits and the reply-guard records in `src/stop-hook-bootstrap.ts` and `src/reply-guard-record.ts`), which the pre-launch pass rewrites at every start; don't use it for a reload file
- A file named after a persona key: check the key against `PERSONA_KEY_RE` from `src/persona-identity.ts` before building the path (as `src/reply-guard-record.ts` does). `PERSONA_KEY_IN_FORM_RE` only says whether a name is its own key and rejects hashed keys

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
- No secrets in config files that don't need them (config.json); never hardcode tokens or keys in source
- Slack tokens come only from the credentials file each persona names (`credentials_file`, read by `src/persona-credentials.ts` during its bring-up). Never read a Slack token from the environment, and never write, copy, cache or log a token. The CLI reads no token and checks no token variable; don't add a token prerequisite to `start`
- Read a credentials file only through `readCredentialsFile` in `src/persona-credentials.ts`, the one stat-first reader (it reads only a regular file, so a FIFO or a device can't hang the server; there is no size cap on a regular file). The bring-up check and the reload detection tick both use it; never read a credentials file any other way
- Compare credentials content only by digest (`credentialsDigest`, a SHA-256 or a missing/unreadable marker), held in memory by the bring-up controller for the tick to compare with. Outside dry run every brought-up persona holds one, whatever its outcome; a persona broken by a credentials file another applied persona shares holds the digest of its own path's bytes, which are hashed only: never parse them or take a token from them. Never persist a credentials digest, never log a digest or the fingerprint (the fingerprint's only home is the `fingerprint:` line of `config.json.pending`), and don't keep the bytes a tick read past its pass. No token or credentials content appears in `config.json.pending`, the preview or any log line; name a changed credentials file by its persona and path only. The change plan holds no digest and the preview renders no value derived from credentials content; an added persona's can't-come-up cause comes from `credentialsReadProblem`, which names keys and rules only. The preview's `INVALID` line repeats the loader's error, so it never contains a key name that could be a token (see Configuration, `describeUnknownKeys`)
- Reload output (the pending-change preview, `reload-*` lines, write and remove failures) goes to the server log and `config.json.pending` only, never to Slack under any identity (b.av2 SR-7.2)
- Build every persona Slack client through the connection manager's injected `PersonaSlackClientFactory` with the option builders in `src/persona-slack-clients.ts`; never construct a `WebClient` or `SocketModeClient` for a persona elsewhere, and never add a client that attaches the original request to its errors
- Every inbound Slack event goes through the receiving persona's pipeline in `src/persona-routing.ts` (`receive`, with the rules in `decideDelivery` in `src/delivery-decision.ts`) before delivery. Don't add a sender allowlist, pairing, cross-persona arbitration or throttling, or any other sender filter beyond the persona's self-exclusion (messages from its own bot user ID or bearing its own bot ID are dropped): who a persona hears is set only by its configured channels, each channel's `delivery` setting and its `dm.enabled` switch (b.av2 SR-4.2, SR-4.3)
- Every MCP tool resolves the calling session's persona and its client at call time (never cached at session creation) and passes `checkPersonaTarget` for its Slack target before any Slack call, dry run included, with the tool's action from `TOOL_TARGET` (`post` for `reply`, `act` for the others); a refusal or a failed Slack call is a tool error (`isError: true`), never a thrown protocol error. Every file a tool sends passes `assertSendable` before the first Slack call
- DM targets are gated by the persona's `dm.enabled`, read per call. With DMs off a persona has no DM target at all: a `D…` conversation or a user ID is refused before any Slack call, including a `conversations.open` or a post to a user ID that would open a DM implicitly. With DMs on, only `reply` accepts a user ID, and it opens the DM with `conversations.open` on the persona's own client and posts to the returned `D…` ID; never pass a user ID to a Slack write, and never let a read, edit or reaction open a DM (the `act` tools refuse a user ID whatever the switch)
- Server-initiated posts to a persona's destination (permission prompts, the stuck-prompt warning, notices) go through the one `PersonaDestinations` instance from `src/persona-destination.ts` that `server.ts` shares between the notifier and the poller. It opens a `dm` destination with `conversations.open` on the persona's own client and posts to the returned `D…` ID, never the contact's user ID; don't open a destination DM or resolve a persona's destination anywhere else (the `reply` tool's DM open above is the MCP tools' own path), and don't build a second instance in production, or the per-persona DM cache splits. An update to a prompt already posted (a click or the poller's closing update) goes to the conversation recorded when it was posted, through that persona's client; never resolve the destination again or read `dm.enabled` for it. With DMs off, such an update in a DM still happens: an update is not a post (b.av2 SR-5.1)
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

Consecutive relaunch failures are tracked per persona, keyed by persona key (b.av2 SR-6.3), by `src/backoff.ts` — a pure, import-free module with no timers or I/O (see SR-25). The module exposes a simple counter API consumed one-way by restart/health-check/server wiring. `restart.ts` counts at a single site: the `launchSession` boolean outcome (SR-25.1). A successful launch — or a successful MCP reconnect on the alive-but-disconnected path — calls `recordSuccess`; the failing `launchSession` branch calls `recordFailure`. A `'skipped'` launch (the relaunch gate refused it because the persona is not up) calls neither, so a persona that cannot be launched never burns its failure budget or trips the cap. Most not-up personas never get that far, because `restart.ts` asks the same gate earlier (see [Not-up guard](#not-up-guard-bav2-sr-64)). Any new launch path that can decline to launch returns `'skipped'` rather than `false`. The reconnect path never calls `recordFailure`: an `'escalate-dead'` or `'transient'` reconnect does not re-enter `scheduleRestart`, so counting stays tied to actual launch attempts rather than a non-launch reconnect site. On `'escalate-dead'` restart.ts still returns without re-entering, but the verdict is no longer a silent dead end — the `_buildReconnectSessionAdapter` mapping first awaits `sweepDeadTmuxChannel` (an operator log line plus the memoized `reconcileMissingSweep`, b.m4r), reconciling the dead-tmux row to `missing` so the next tick relaunches it internally rather than waiting on the external `~/startup/find-missing-loop.sh` (now belt-and-braces). The sweep records neither success nor failure, so SR-25.1 (counting only at `launchSession`) is unchanged. That is not a dead end (b.9a7): the periodic health-check tick is the retry driver, re-observing the persona each interval and calling `scheduleRestart` again while it is still alive-but-disconnected or once it goes dead, so a failed or deferred reconnect is retried on a bounded cadence.

#### Exponential backoff

Each successive failure doubles the restart delay, starting from `session_restart_delay` (default 60 s), capped at 900 s (15 minutes):

| Pre-failure count | Delay (base = 60 s) |
|---|---|
| 0 | 60 s |
| 1 | 120 s |
| 2 | 240 s |
| 3 | 480 s |
| 4 | 900 s |
| 5+ | 900 s |

Formula: `min(base * 2^preFailureCount, 900)`. `nextBackoffDelay(key, baseDelaySeconds)` returns this value for persona `key` using the count recorded before the current failure attempt.

The arithmetic is also exported statelessly as `doublingBackoffDelay(base, priorAttempts, ceiling)` for callers that keep their own attempt count; `nextBackoffDelay` delegates to it with the 900 s ceiling. The session-restart ladder above, its 5-failure cap and its counters are keyed by persona key.

Persona bring-up retries (b.av2 SR-3.2: Slack-unreachable and directory-broken) use a separate schedule in `src/persona-retry-schedule.ts`: 5 s doubling to 300 s, no attempt cap, and never shorter than Slack's `retryAfter`. Create one schedule per persona and retry purpose with `createPersonaRetrySchedule`. Don't use the session-restart counters for bring-up retries: both are per persona, but they count different failures and share no state. See [Persona Bring-Up Retries](#persona-bring-up-retries).

#### Cap at 5 consecutive failures

After 5 consecutive failures, `isAtCap(key, RESTART_FAILURE_CAP)` returns `true` (`RESTART_FAILURE_CAP = 5` is exported from `restart.ts` and referenced by `src/persona-routing.ts` and the health-check wiring in `server.ts` — no hardcoded literal). Capped personas are skipped by the health-check tick — the poller calls `isAtCap` before `scheduleRestart` and skips the persona when it is true.

A capped persona recovers **only via a server restart**. The in-process counter is lost on restart by design; startup reconcile then re-runs for every persona, giving each a fresh attempt.

Sending a message in the channel does **not** revive a capped persona. A persona capped by 5 consecutive `launchSession` failures has no registered session, so an inbound message it receives hits the no-session branch in `src/persona-routing.ts` (`[slack] No live session for persona <ref> chat_id=<C…> — dropping message`). As of b.kvq that branch *can* trigger a recovery `scheduleRestart`, but the shared guard `decideLostMessageState` (`src/lost-message.ts`, fed the persona's real restart state) checks `isAtCap(key, RESTART_FAILURE_CAP)` and, at the cap, answers `restart-limit-reached` and does **not** fire — the persona's destination gets a lost-message notice saying automatic restarts are suspended and the server must be restarted. The cap is therefore still honored on the inbound path; firing a restart would only burn a spawn attempt against a persona that cannot come up. Only a server restart clears the in-process counter and gives the persona a fresh attempt.

There are two message-triggered restart sites, both in `src/persona-routing.ts`, neither of which bypasses the cap for a capped-dead persona:

- The streamless trigger (b.9cj) fires for a session that is *registered* for the persona yet missing its `_GET_stream` (`hasSessionStream(key)` false). A capped-dead persona has no such registered session, so this never applies to it. The branch does **not** call `notification()` — with the stream gone the SDK's `send()` evaporates silently, so the message is provably undeliverable; it triggers recovery with `scheduleRestart(key, session.cwd, undefined, { humanTrigger: true })` and raises a lost-message notice at the persona's destination instead of staying silent. Recovery actually fires because `restart.ts` doesn't wave a connected-but-streamless session through as "already reconnected" (it skips only when connected AND `hasSessionStream`).
- The no-session trigger (b.kvq) fires for a persona with **no** registered, connected session, calling `scheduleRestart(key, persona.working_directory, undefined, { humanTrigger: true })`.

Both branches go through `handleLostMessage`, which asks `decideLostMessageState`, so `scheduleRestart` fires only in the `starting-now` state: no restart pending or active, auto-restart enabled and the persona under the cap. `humanTrigger` clamps the computed backoff delay **down** to `HUMAN_TRIGGER_DELAY_CEILING = 5` s (never up) but does not touch the failure counter or the re-entrancy guard, so the cap and backoff accounting are unchanged.

Key every guard and the `scheduleRestart` call on the receiving persona's key. The session is looked up by that key (`getSessionByPersona`), so the persona that received the message is always the one that owns the session: there is no owner resolution, and a recovery can never spawn a second instance on another persona's directory. Report the lost message with one notice through the routing's injected `notify` (the per-persona notifier's `notify`, wired in `server.ts`), never with a post of your own. The notifier prefixes the persona reference and takes the notice down the one notice path: the pre-validation hold while the persona has no validated client, its channel or `dm` destination (the DM opened when the notice is attempted), and the shared destination hold's retry and once-per-episode `persona-destination-failed` line when the destination refuses. Nothing else is posted in the source conversation (when the destination is that conversation, the notice is the one post there); see [Report Delivery Failures Only to the Persona's Destination](#report-delivery-failures-only-to-the-personas-destination). Await the notice inside `try`/`catch`: a failing `notify` logs one `[slack] persona-routing: lost-message notice for persona <ref> failed: …` line (built with `describeThrownValue`, no message text) and never throws out of dispatch.

Resolve the author label, read the session and probe the stream before anything else; only a message that will be sent gets the ack-tracker entry and the reaction (issued, not awaited), then the send. A lost message gets no reaction. Nothing is awaited between the session read and the send (b.9cj).

The notice names the sender (the same `resolveAuthorLabel` label the meta uses, with `&`, `<` and `>` escaped so a bot `username` can't ping anyone) and the recovery state, and never the message text. The dropped message itself is always lost — recovery starts a session but never delivers or replays it. There are four recovery states (`LostMessageState`), decided in this order, first match wins:

1. **`restarting`** — `isRestartPendingOrActive(key)`: a restart is already pending or running. No restart is fired, so no second launch is stacked.
2. **`auto-restart-disabled`** — `session_restart_delay: 0`. `scheduleRestart` would early-return, so it is not called; the notice says to restart the server.
3. **`restart-limit-reached`** — `isAtCap(key, RESTART_FAILURE_CAP)`. No restart is fired; the notice says automatic restarts are suspended and to restart the server.
4. **`starting-now`** — under the cap, auto-restart enabled, nothing pending: fires the human-clamped `scheduleRestart`. Both branches report this state.

#### SpawnCapReached notification (once per episode)

On the transition to 5 consecutive failures, the `launchSession`-failure branch calls `shouldNotifyCap(key, RESTART_FAILURE_CAP)`; on its single `true` return it invokes `deps.onCapReached(key)` and schedules **no** further timer. `onCapReached` calls the session manager's cap-notice function, `notifyRestartCapReached(key)`, which raises a distinct `SpawnCapReached` notice through the per-persona notifier (`src/persona-notifier.ts`). The notifier posts it to the persona's destination under the persona's identity, as one top-level message with no `thread_ts`, and prefixes it with the persona reference. Raise restart, spawn, outage and transcript notices through the notifier; never post them from `restart.ts`, `server.ts` or `session-manager.ts` directly. Subsequent failures in the same capped episode are silent. `shouldNotifyCap` implements this latch: it returns `true` on the first call at cap, then latches to `false` until the counter is reset.

#### Counter reset semantics

`recordSuccess(key)` resets the persona's consecutive-failure count and clears the cap-notified latch. It is called on any successful launch or successful MCP reconnect. Both state values reset together — a fresh episode starts from 0 failures with the cap-notification latch cleared.

#### State lifetime

The backoff state is in-process only — no persistence. A server restart resets all counters. This is intentional: the server re-runs startup reconcile on start, so each persona gets a clean shot at reconnection after a process restart.

#### Not-up guard (b.av2 SR-6.4)

A persona that is not up (its bring-up is broken or retrying, or its Slack connection is not serving) is never restarted: its instance and agent-director row are left alone and its failure count is unchanged. `RestartDeps.canRestart(key)` (the server passes the relaunch gate) is asked at `scheduleRestart` entry (after the delay=0 and shutdown checks), at the top of the timer callback before `isSessionAlive`, and again right after `isSessionAlive` returns, before `reconnectSession` or `killSession` (`skipIfNotUp`). `launchSession`'s own gate is the backstop for a flip during the kill; its `'skipped'` counts as neither success nor failure.

- **Check shutdown before the gate.** During shutdown every bring-up is cancelled, so the gate would answer false for every persona and log healthy ones as not relaunched. `scheduleRestart` returns on `isShuttingDown()` without asking it, and the timer callback checks shutdown first too.

- **Ask the gate after every await, before touching the instance.** The liveness probe is an async agent-director call, and the persona can stop being up while it runs. A new step that awaits before a reconnect, kill or launch gets its own `skipIfNotUp` check after the await.
- **A refusal records nothing.** Never call `recordFailure` or `recordSuccess` on a not-up skip; the persona's next restart after it comes up counts normally.

### Log Messages

All restart activity is logged to stderr with the `[slack]` prefix. `<key>` is the persona key:

| Message | Meaning |
|---|---|
| `[slack] Scheduling restart for persona=<key> in <N>s (backoff)` | Restart timer queued; delay is the backoff ladder value |
| `[slack] Auto-restart disabled (delay=0) — skipping restart for persona=<key>` | Restart skipped; feature disabled |
| `[slack] Session already reconnected — skipping restart for persona=<key>` | Session re-established MCP on its own; no action needed |
| `[slack] Session alive but disconnected — reconnecting MCP for persona=<key>` | Alive session; sending `/mcp reconnect` instead of relaunching |
| `[slack] Relaunching session for persona=<key> cwd="<path>"` | Relaunch attempt starting |
| `[slack] Session relaunch failed for persona=<key>` | Relaunch failed; failure counter incremented |
| `[slack] Cap reached for persona=<key> — notifying and stopping restarts` | 5th consecutive failure; `SpawnCapReached` notice raised through the notifier, no more timers scheduled |
| `[slack] health-check: persona=<key> is at cap — skipping tick (SR-25.3/25.4)` | Poller skipped a capped persona on this tick |
| `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)` | A tick-driven reconnect declined to poke a mid-long-turn (`working`) session; the next tick retries once the turn settles |
| `[slack] Skipping restart — server is shutting down (persona=<key>)` | `scheduleRestart` called, or a timer fired, during shutdown; no timer armed, gate not asked |
| `[slack] Not scheduling restart for persona=<key> — the persona is not up (its bring-up has not succeeded, or its Slack connection is not serving)` | `canRestart` refused; no timer armed, nothing recorded |
| `[slack] Skipping restart for persona=<key> — the persona is no longer up; its instance is left as it is` | `canRestart` refused when the timer fired (before the liveness probe) or right after the probe; no further probe, reconnect, kill or launch, nothing recorded |
| `[slack] Cancelled restart timer for persona=<key>` | Pending timer cleared on graceful shutdown |

The persona bring-up lines (`persona-start`, the broken-persona classes, directory cleared lines, the launch after a retry) are not restart lines. They're listed in docs/architecture.md, Logging, Persona bring-up lines.

### Persona Bring-Up Retries

A persona's bring-up ends `up`, `broken` or `retrying` (b.av2 SR-6.1). Slack-unreachable and directory-broken personas are retried; credentials-broken ones aren't. This is a second retry mechanism with different rules from auto-restart. It lives in `src/persona-bringup-controller.ts` (directory re-checks, the launch after a retry) and `src/persona-connections.ts` (Slack retries). See docs/architecture.md, Server-Managed Startup step 5.

- **Never touch the restart counter or cap.** Bring-up retries use their own `createPersonaRetrySchedule` (5 s doubling to 300 s, no cap), never `backoff.ts`, `scheduleRestart` or `RESTART_FAILURE_CAP`. A missing directory is an operator fix that can take hours; a cap would leave the persona down after the fix, and counting it as a restart failure would cap a persona that never launched (AC 66).
- **Keep retries on per-persona timers, outside `startupSessionManager`'s pool.** The start pass must return once every persona has an outcome; never await a retry there or give a retrying persona a pool slot. One slow or broken persona must not delay a healthy one (AC 23, 24).
- **No timer, lock, queue or promise chain spans two personas.** Keep all retry state in the persona's own entry, and schedule the next re-check only after the previous one finished. A shared structure lets one persona's stall block another.
- **Reuse the credentials read at the original bring-up.** A retry hands the manager the tokens held from the first read (or the last confirmed change, once confirmed changes exist); never re-read the file. An edit made meanwhile is detected as a pending change (see Reload Detection Tick in `docs/architecture.md`) for the operator to confirm (E12), not something a retry picks up silently (AC 66).
- **Launch from the retry, once.** A persona that reaches `up` through a retry is launched from its own retry path through `spawnForPersona`, so it shares the one-launch-in-flight guard with restarts. Don't wait for the health check: until the launch, an inbound message would take the lost-message path.
- **Keep the running-persona path separate.** A persona that is running and whose directory later disappears is not a bring-up retry: it keeps the restart backoff, cap and `cwd-unreachable` notice (b.av2 SR-11). Don't route it through the bring-up controller, and don't route a bring-up retry through restart.
- **Log, never post.** Broken-persona and retry failures go to the server log only, through the injected logger: never to Slack under any identity, never held for a later flush and never to `startup-errors.log`. A persona that isn't up has no validated identity to post as, and posting under another persona's identity would leak one persona's state into another's channel.
- **Log when a cause starts and when it clears, not on every attempt.** A retry that runs every 300 s for days would otherwise flood the log. A class change between attempts is the same episode and logs nothing.
- **No token value in any line.** Name the persona, its `personas[i]` entry, its key and the file path; describe a bad token only by its key and the rule it breaks.

### Serve Only Personas That Are Up

A persona that is not up (b.av2 SR-6.4: its bring-up is `broken` or `retrying`, or its Slack connection is not serving) may still have an agent-director row and a running instance. Keep the instance, but don't serve it until the persona is up. See docs/architecture.md, Session Lifecycle, Connection and Disconnection.

- **Check the persona is up before delivering work to its instance or relaying work from it.** Ask the one shared predicate, `createPersonaUpPredicate` in `src/persona-start.ts`, which `server.ts` builds once as `isPersonaUp` and injects. The current paths are MCP registration (`decideSessionAdmission` in `src/registry.ts`), the permission poller (`PollerDeps.isPersonaUp`) and `/interject` (`InterjectDeps.isPersonaUp`, 503). A new endpoint, tool or poller that serves an instance takes the same function as an injected dependency. Don't keep a second copy of the up state, and don't use "`clientFor` returned a client" as the check: `clientFor` answers on the connection status alone, not on the bring-up outcome. Why: work sent to or relayed from a persona whose Slack identity is down is lost, or posted under no identity or the wrong one (AC 23, 24).
- **Never kill or delete a not-up persona's row or instance for being not up.** Leave the row for the launch that follows its coming up, which reaches it through the collision ladder, so the conversation history survives the outage (AC 23, 24). In particular, when the `cwd` check can't be evaluated it is not a `cwd` mismatch: check `compareRowToPersona`'s `cwdCheckDeferred` before acting on `cwdMatches`. It is true only when the persona's working directory has no real path and the row's `cwd` has none either (absent, missing, a dangling symlink's old target) or equals the configured `working_directory` lexically. Only then does the start sweep keep the row and defer the check to the launch, and the ladder keep it and fail the launch. A row whose `cwd` resolves to an existing directory elsewhere is still replaced, even while the working directory is missing, and so is a row whose `cwd` differs by real path from a resolvable working directory (b.av2 SR-6.2, SR-6.3). Keep the deferral to the `cwd` guard: the ladder's `resume_enabled=false`, `config_dir`, `ErrNoSessionId` and `ErrJsonl*` paths replace the row whatever the directory's state. Why: a missing directory is a temporary operator fault, and the lexical fallback can't prove the row is elsewhere; but a row in an existing directory provably is, and keeping it would let a persona adopt another persona's directory.
- **When a persona stops being up, drop its MCP session and do nothing else.** The controller's `onLeftUp` fires once per change from `up` to `broken` or `retrying`; the server's listener (`createNotUpSessionDropper` over `dropPersonaSession`) removes the registry entry and session-ID mappings before closing the transport, so the close schedules no restart. No restart, kill, delete or Slack post. A Slack connection being reopened (`lost`, or `retrying` in the `reopen` phase) keeps the persona `up`: don't drop on it. Why: the persona can't be served while down, but its instance and history must be there when it comes back (AC 23, 24).

### Post to a Persona's Destination Through the Hold

A persona's destination is its `permission_prompts` channel or its DM with `dm.contact`. Every post there goes through the one shared destination hold, `personaDestinationHold` in `server.ts` (`createPersonaDestinationHold` in `src/persona-destination-hold.ts`), which posts through the shared destination resolver.

- **Take the shared hold, don't build one.** The notifier and the permission poller get the same instance, so a persona's prompts and notices share one episode and one retry schedule. A new poster takes it as an injected dependency: a re-derived item asks `begin(key)` for an attempt and gets nothing while the persona is held; a one-off message is handed to `deliver`. Posting through the resolver directly bypasses the hold: the failure is then neither retried nor logged once.
- **Keep it side-effect-free and cancel it at shutdown.** `server.ts` builds it at module scope with no Slack call and no timer; timers start only when a notice is held. `shutdown()` calls `personaDestinationHold.cancelAll()`. Code that removes a persona (none yet) calls `cancel(key)` beside `personaDestinations.forget(key)`.
- **Don't log destination failures per attempt.** The hold logs one `persona-destination-failed` line when an episode starts and one when it clears; that is the diagnostic. A poster logs only a failure the hold doesn't retry: a payload error about the message itself (`MESSAGE_PAYLOAD_ERRORS`). Why: a retry every 300 s for days would otherwise flood the log, as for bring-up retries.

### Report Delivery Failures Only to the Persona's Destination

Report a message that couldn't be delivered (the lost-message notice) only to the persona's permission-prompt destination, through the notifier. Never post a server message in the conversation the message came from, channel or DM, to report a delivery failure. When that conversation is also the destination, the destination's one notice is the only post there; it goes there because it is the destination, never because the message came from there. Why: a persona may pass as a person in a shared channel, and a server message there would give it away. The rule binds future delivery or queueing work too (for example b.4vj, guaranteed inbound delivery): report saved, queued or undeliverable messages to the destination as well.

### Keep the Debugging Skill Complete

`skills/debug-slack-channel-bots/SKILL.md` is the operator's catalogue of persona failures. It ships in the npm package.

- **Update the skill in the same change.** Adding or renaming a persona diagnostic class (`PERSONA_DIAGNOSTIC_CLASSES` in `src/persona-diagnostics.ts`) or a reload diagnostic class (`RELOAD_DIAGNOSTIC_CLASSES` in `src/reload.ts`), a start refusal over the config file or the last-applied record, a `config.json` load-time rejection (`src/config.ts`) or an operator-visible persona failure mode (a refusal, skip or retry line) requires a matching entry in the skill: its meaning, cause and fix, with the class or message spelled as the code spells it. Removing one removes its entry. Why: the operator diagnoses from shipped material only (b.av2 SR-12, AC 27), and a missing entry leaves them with a log line nothing explains.
- **Never show a token value in the skill.** Describe a bad token by its key and the rule it breaks, and use obviously fake placeholders (`xoxb-…`) where a shape must be shown. A shape check may report key names and prefixes, never values.
- **Name pre-persona keys only in the SR-1.7 entry.** That entry, under its own heading, is the one place in any shipped description allowed to name the rejected pre-persona keys, and only to say they're rejected and must be rewritten as personas.

## Health-Check Poller

`health-check.ts` runs a `setInterval` loop that checks every applied persona on a fixed cadence and schedules recovery for sessions that are dead — and, as of b.9a7, for sessions that are alive (AD live state) but MCP-disconnected — when they are not already being recovered. Both cases route through `scheduleRestart`, which then reconnects or relaunches per case. The alive-but-disconnected case requires `!connected` on two consecutive ticks before firing, to avoid poking a freshly-launched session that has not yet registered its MCP connection.

### Configuration

`health_check_interval` in `config.json` sets the polling interval in seconds. Type: `number`. Default: `120`. Set to `0` to disable the poller entirely — `startHealthCheck()` returns immediately without creating an interval.

### Async Interval Pattern

Each tick fires an `async` callback. The callback iterates the persona work list sequentially to keep concurrent `client.status(...)` traffic predictable. `HealthCheckDeps.getPersonas()` supplies it as persona key → working directory; production wires the pure `buildPersonaWorkList(personaConfig, canRelaunch)`, one entry per persona that is up, however many channels it lists. Errors on a single persona are caught and logged; they do not abort the rest of the iteration. agent-director's library Client is internally safe for concurrent verb calls (see SR-0.1).

```typescript
intervalId = setInterval(async () => {
  for (const [key, cwd] of Object.entries(deps.getPersonas())) {
    try {
      // check and maybe scheduleRestart
    } catch (err) {
      console.error(`[slack] health-check: error checking persona=${key}:`, err)
    }
  }
}, intervalSeconds * 1000)
```

### Coordination with restart.ts and backoff.ts

The work list already leaves out every persona that is not up (its bring-up is broken or retrying, or its Slack connection is not serving), so the tick never raises `cwd-unreachable` for, reconnects or relaunches such a persona; its bring-up retry owns it until it is up. Don't add a tick path that bypasses the work list. A persona left out of a tick's work list also loses its disconnected streak, as the pending-restart and cap skips do, so a persona that comes back up starts a fresh two-tick count instead of inheriting an observation from before it went down.

Before calling `scheduleRestart`, the poller queries two guards, both keyed by persona key:

- `isRestartPendingOrActive(key)` from `restart.ts` — returns `true` if a restart timer is queued or a launch is in flight; skip to avoid double-launching.
- `isAtCap(key, RESTART_FAILURE_CAP)` from `backoff.ts`, injected as `HealthCheckDeps.isAtCap` — returns `true` if the persona has reached the consecutive-failure cap; skip the tick for this persona. A capped persona recovers only via a server restart (see SR-25). The tick guard only stops the *poller* from re-scheduling. The `scheduleRestart` path is itself cap-exempt, but neither message trigger in `src/persona-routing.ts` revives a capped-dead persona: the b.9cj streamless trigger reaches `scheduleRestart` only for a session that is registered yet missing its `_GET_stream` (which a capped-dead persona does not have), and both it and the b.kvq no-session trigger ("No live session for persona … — dropping message") go through `decideLostMessageState`, which checks `isAtCap(key, RESTART_FAILURE_CAP)` and declines to fire at the cap, reporting `restart-limit-reached` in the lost-message notice at the persona's destination. Both key every guard and the `scheduleRestart` call on the receiving persona's key.

When neither guard fires, the poller checks liveness, connectedness, and stream presence via `isSessionAlive(key)`, `isSessionConnected(key)` (added in b.9a7, wrapping the same registry-`connected` adapter restart.ts uses), and `hasSessionStream(key)` (added in b.9cj). `hasSessionStream` is exported from `src/persona-routing.ts` (`getSessionByPersona` → `hasGetStreamKey(transport)`); it is the one `_GET_stream` probe shared by the dispatch path, the restart guard (`RestartDeps`) and the health check (`HealthCheckDeps`), so all three agree on whether a session can receive a message:

- **Dead** (`!alive`) → `scheduleRestart(key, cwd)` immediately — the same function used by the reactive `onsessionclosed` path.
- **Alive but not deliverable** (`alive && (!connected || !hasSessionStream)`) → increment a per-persona consecutive-failing streak; `scheduleRestart` fires only once the streak reaches two consecutive ticks (the freshly-launched false-positive guard). Both the MCP-disconnected (b.9a7) and connected-but-streamless (b.9cj) cases share this one branch and streak: a session between `registerSession` and its stream re-open is legitimately streamless for a moment and must not be poked mid-boot, the same hazard the disconnected case already debounced. restart.ts then reconnects a disconnected row (deferring a `working` row — `reconnectSession` returns `'transient'` on `working` — so a mid-long-turn session is not poked, b.rmy invariant preserved) or recovers a streamless one.
- **Alive, connected, AND stream present** → healthy; reset the streak.

The capped-persona skip above covers the alive-but-not-deliverable path too: a capped persona gets no tick-driven reconnect, deliberately, so the operator contract carried by the lost-message notice's `restart-limit-reached` state (automatic restarts are suspended; restart the server to recover) is not quietly contradicted.

## Reload Detection Tick

The reload controller in `src/reload.ts` checks every 5 s whether `config.json`, or a credentials file it references, differs from what is applied, and keeps `config.json.pending` in step (b.av2 SR-8.2, SR-8.3). Its driver is `createReloadTickDriver` in `src/reload-timer.ts`.

- **Use a serialized, self-re-arming timer for new periodic work**, as `src/cron-scheduler.ts` and `src/reload-timer.ts` do: arm the next pass only after the previous one settles, so passes never overlap and one timer is pending between them. Never `setInterval` (the health check's loop above predates this rule; don't copy it) and never a file watcher: a single-file watch drops the atomic-save rename editors use, and a pass can only act at a tick anyway.
- **Start it after the start's bring-up pass returns, stop it at shutdown.** `startDetection()` is the last statement of `main()`, after `startHealthCheck`; `stopDetection()` runs in `shutdown()` after `stopHealthCheck()`. `start` itself runs no pass. Why: the tick compares credentials with the digests the bring-up pass records; before that there is nothing to compare with, and a change would go unnoticed.
- **A pass notices and reports, nothing else.** It writes or removes `config.json.pending` and logs; it applies nothing, makes no lifecycle call and posts nothing to Slack. Log the preview only when the pending state changes, not on every pass, and each write or remove failure once per episode. An episode ends at the next success or when the derived state changes (to nothing pending or to another pending fingerprint), so a failure that repeats within one state is logged once and each new state logs its first failure.
- **Read files only through the stat-first readers**: the config file through `readPersonaConfigBytes`, each referenced credentials file (deduplicated, none in dry run) through `readCredentialsFile`. See Configuration and Security.
- **Classify and render a change only in `src/reload-plan.ts`.** `buildChangePlan` is the one place a candidate is diffed against the applied config and each field's SR-8.6 effect (destructive, in place, next launch, server-wide at the next start) is decided; the preview, its log lines and the header counts are rendered from that plan. The apply (E12, E13) must call `buildChangePlan` and `changePlanCounts` too; never diff the configs a second time. Why: the apply must do exactly what the preview said.
- **Keep the plan and the renderers pure and deterministic.** Gather every I/O fact in the tick (real paths, digests, the bring-up state, the added personas' local checks) and pass it in as `ChangePlanFacts`; the same inputs always give the same plan and the same text. When a fact can't be gathered, pass `FACT_UNKNOWN` so the preview says it could not be checked; never substitute a default answer.
- **Derive a persona set's config directories only through `effectiveClaudeConfigDirs`** (`src/persona-identity.ts`). The template's memory-read rules and the plan's `configDirsChanged` both use it, so the apply refreshes the template exactly when its rules would change.
- **Let the plan alone decide a credentials change.** A credentials change is pending exactly when the plan lists one; don't compare digests anywhere else in the tick.
- **A new config field needs a reload effect.** Add it to the right class in `src/reload-plan.ts` (`DESTRUCTIVE_SETTINGS`, `IN_PLACE_SETTINGS`, `NEXT_LAUNCH_SETTINGS`, or a server-wide key through `PERSONA_TOP_LEVEL_KEYS`), with a preview test. A persona field left out of every class is never reported as changed. A server-wide path key must also be in `SERVER_PATH_SETTINGS` (`src/config.ts`), or the plan compares it by string and reports a respelled path as changed.
- **Tests drive it through the injected tick driver** (`ReloadControllerDeps.tickDriver`; the reload harness in `tests/test-helpers/reload-harness.ts` has a manual one), and the driver itself through an injected clock; no real timer runs in a test.

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
- Bound any Slack `start()` or call that may never settle with a timer on the injected clock (as `src/persona-connections.ts` does). On expiry, abandon it, and disconnect or catch whatever it settles to later
- Per-persona work keeps its state in that persona's own entry: no lock, queue, promise chain or timer is shared between personas

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
- **Resolved outside the repo.** The fix is ops-only or lives in another file/host, so no commit on `main` can ever land it. Carry the explicit heading `## +closed:out-of-repo <path>` in the closure note, naming the artifact that was changed — e.g. `## +closed:out-of-repo ~/startup/start-all.sh`. The operand is required (a bare `## +closed:out-of-repo` does not qualify) and is never checked on disk: the marker is a signed statement by the closer, auditable by reading the ticket, not a filesystem probe that would give different verdicts on different machines. Prose alone does not qualify — describing a `~/` path near fix language used to pass the audit and let a ticket that said the out-of-repo change was *declined* read as closed.
- **Documents-only, outside any git repo.** The ticket's product is markdown/docs whose files live outside any git repository (e.g. Apiary ticket markdown under the non-repo project root), so no commit on `main` can ever land it. Carry the explicit heading `## +closed:docs-only` in the closure note — a deliberate, greppable marker, not loose prose. Phrases like "documents only" in body text do not qualify; only the heading does.
- **Closed without a code change.** It is explicitly no-repro, won't-fix, not-a-bug, superseded, abandoned, or satisfied by other work — say which, and point at where the real work lives (or why none is needed). A bare, reasonless `## Closed` heading does **not** count — a closure needs a stated reason.

The audit recognizes these closure phrasings (case-insensitive, matched as whole words anywhere in the body):

| Verdict | Accepted phrasings |
| --- | --- |
| Could not be observed | `no-repro`, `no repro`, `not reproducible`, `cannot reproduce` |
| Observed, fix declined | `won't fix`, `won't-fix`, `wont fix`, `wont-fix` (straight `'` or typographic `’`, any case) |
| Observed, behavior is correct | `not a bug`, `not-a-bug`, `by design`, `works as intended` |
| Covered elsewhere | `closed as superseded`, `closed as abandoned`, `superseded by`, `fully satisfied by`, `already satisfied` |

Pick the verdict that is true. The first three rows are distinct claims — no-repro means the behavior could not be observed, won't-fix means it was observed and a fix was declined, not-a-bug/by-design/works-as-intended mean it was observed and is correct — and the audit accepts all of them, so a closure note never has to misstate what was decided to satisfy the gate.

**"Pending merge/release" is NOT a valid finished state.** A fix that only exists on an unmerged branch is stranded, not done — `main` still carries the bug. Those exact words were in b.qps's closure note while its fix sat on an unmerged branch for months and the root cause stayed live on `main`; the fix was nearly re-implemented from scratch before the stranded branch was noticed. If work is on a branch and not yet on `main`, the bee stays open.

`scripts/audit-finished-tickets.sh` enforces this. It is read-only: for every `finished` bee in the Bugs hive, the Plans hive (`Ideas/Plans/`), and the Ideas hive's top-level bees (`Ideas/<id>/`, excluding the `Plans/` subdirectory so nothing is double-reported) it flags tickets whose work is neither reachable from `main` nor covered by a recognized closure marker, branches referencing finished tickets whose heads are not ancestors of `main`, and any unmerged branch that references no known ticket at all. Recognized closure markers are: the explicit `## +closed:out-of-repo <path>` heading naming the artifact changed outside this repo, an explicit reasoned closure note drawn from the closure vocabulary table above (each matched only as a word-bounded phrase, so a bare `## Closed` heading with no stated reason does not qualify), and the explicit `## +closed:docs-only` heading for documents-only work outside any git repo. Both `+closed:` headings are deliberate, greppable tokens that cannot be produced by accident; the closure vocabulary is prose-level by design, so it will also match the phrase used incidentally in body text — the anti-marker check and the main-commit requirement, not the vocabulary, are what guard a wrongly-finished ticket. A closure note that says "pending merge/release" or "fixed on branch X" is treated as an anti-marker and forces a flag — disqualifying every closure marker above. It exits non-zero when stranded work exists and runs at release preflight as gate SR-2.6 (see below), so a release cannot ship while finished work is silently stranded. Idea-hive top-level bees are held to the same standard as bugs and plans: an idea can legitimately be `finished` by being absorbed into an Epic/plan that landed, but that must be stated explicitly with the same closure vocabulary (a "fully satisfied by \<plan\>" / "superseded by \<id\>" note pointing at where the work went), not left implicit.

## Releasing CSCB

Releases are cut with the `/publish` skill from a Claude Code session whose CWD is any checkout of the `claude-slack-channel-bots` repo on `main`. The skill is **invocation-location-neutral** for its npm-publishing steps — those run identically from the primary checkout of the main clone, from any feature worktree (so long as that worktree's HEAD is `main` and in sync with `origin/main`), or from a throwaway `git clone` under `/tmp` or anywhere else. The one exception is the SR-2.6 stranded-work audit: it needs the hives locatable one level above the repo checkout (`<project>/Bugs`, `<project>/Ideas/Plans`, `<project>/Ideas`, `<project>/<repo-checkout>/`). A throwaway `/tmp` clone with no hives beside it cannot run the audit — it fails the setup-failure diagnostic (SR-2.6 exit 17, see below) rather than passing. Run `/publish` from the canonical checkout that sits beside the hives.

> **SR-2.6 is green today.** The stranded-work audit exits zero with no findings in either class — no stranded finished tickets, no stranded branches. There is no known expected debt, so a non-zero SR-2.6 now means genuinely new stranded work: fix it, do not wave past it. Resolving a stranded branch is push-class (publish an `archive/<name>` tag **first**, then delete the remote ref, then `git fetch --prune`) and is reserved for the repo owner. Do not re-list findings here — the audit's own output is the inventory, and the tracking ticket for a given finding is the source of truth for expected vs new.

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

1. **Phase 1 — Local preflight (SR-2.1–SR-2.6).** Clean tree on `main` in sync with origin; frozen-lockfile install; at least one `*.test.ts` file under `tests/`; `bun test` and `bun run typecheck` pass; `npm whoami` succeeds; the next version is not already on npm; the host's `agent-director` satisfies the range declared in `package.json` (SR-2.5); no stranded finished work (SR-2.6 — `scripts/audit-finished-tickets.sh` exits zero; audit exit 1 → stranded work, preflight exit 16; audit exit 2 → setup failure such as unlocatable hives/repo/main, preflight exit 17). **Abort behavior:** the skill exits before any side-effecting step. The working tree is untouched.
2. **Phase 2 — `/ci` integration gate (SR-2.7).** The `/ci` skill runs the full Docker-based integration suite. It must report PASS. **Abort behavior:** identical to Phase 1 — no side-effecting step has run yet.
3. **Phase 3a — Bump and smoke test (SR-3.1, SR-4.1–SR-4.3).** `npm version <bump> --no-git-tag-version` applies the bump; `bun pm pack` produces the release tarball; the tarball is scratch-installed into a temp `BUN_INSTALL`; the installed bin is invoked with no args and must exit non-zero with `Usage:` in stderr. **Abort behavior:** the working tree is rolled back (`git checkout -- package.json bun.lock`). Nothing is committed, pushed, or published.
4. **Phase 3b — Real release (SR-5.1–SR-5.4, SR-6.1, SR-7.0–SR-7.5).** Commit `Release v<version>`, create the annotated `v<version>` tag locally, push the commit to `origin/main`, publish the smoke-tested tarball with `npm publish <tarball-path>` (the byte-identical artifact, not a repack), push the tag to `origin`, poll the npm registry until the version is visible (5s cadence, 10-minute window, progress line every ~30s), sanitize the global `package.json` of the bun-1.3.13 empty-string-dependency-key poison, check for a shadowing install in another bun prefix (SR-7.0), remove any pre-existing global install, run `bun install -g claude-slack-channel-bots@<version>`, verify the install resolves under `${BUN_INSTALL:-$HOME/.bun}/install/global/` at the published version (SR-7.4), and ensure the postinstall actually ran (SR-7.4b).

The SR-5.1 → SR-5.4 ordering is load-bearing: the tag is pushed only after `npm publish` succeeds, so the git remote and npm never disagree about whether `v<version>` exists.

#### Phase 7's two prefix assumptions

`${BUN_INSTALL:-$HOME/.bun}/install/global` is the **correct** expansion of bun's global prefix (with `BUN_INSTALL` unset, `~/.bun` is bun's default) — it is not a bug and must not be "fixed". What Phase 7 cannot assume is that it is the *only* prefix on the host: an install performed with `BUN_INSTALL` pointed elsewhere leaves a second global prefix, and a PATH shim (e.g. `~/.local/bin/claude-slack-channel-bots`) can make that stale copy win `command -v` even after a correct install here.

- **SR-7.0 (pre-install shadow check)** resolves `command -v claude-slack-channel-bots` plus `readlink -f` *before* the remove/install, and warns when the result is outside `${GLOBAL_DIR}/`. It **warns and continues** — aborting before the install would leave the host with the stale copy and no new install, which is strictly worse.
- **SR-7.4** fails with exit 72 if the shadow still wins after the install, printing the same shadow report: the path on PATH, the hop-by-hop symlink chain, the expected prefix, the derived stale prefix, and the exact manual remediation.
- Both share one report builder so the pre- and post-install diagnostics cannot drift.
- Promote **reports, never deletes**, an install in another prefix. It does not own other prefixes on the host, and a wrong `rm -rf` there is unrecoverable. Two rules the emitted remediation always carries: never touch any `install/cache` directory (bun's shared download cache, used by every package on the box), and **repoint** the PATH shim with `ln -sfn` rather than deleting it — `~/.bun/bin` is often not on the interactive PATH, so deleting the shim makes the command unresolvable.
- **SR-7.4b (postinstall trust)** closes the fresh-prefix trust gap: a brand-new global prefix has no `trustedDependencies` entry, so bun silently blocks `src/postinstall.ts` and the failure surfaces much later as `start` dying with `missing prerequisite: config.json`. It runs `bun pm -g trust claude-slack-channel-bots` when the global manifest lacks the entry, then verifies the three scaffolded artifacts exist (`${SLACK_STATE_DIR:-~/.claude/channels/slack}/{config.json,access.json}` and `~/.claude/slack-mcp.json`). Missing artifacts are a loud warning, **non-fatal** — the release is published, tagged and verified by then, so failing here would misreport a delivered release as broken.
- `scripts/sanitize-global.sh` is deliberately scoped to the canonical prefix only and carries a comment saying so. It is best-effort and always exits 0, so it must not mutate state outside the one directory it owns; shadow detection is publish-promote's job.

### Diagnostic contract in the release scripts

Every non-zero exit from a release script must carry an `SR-X.Y` diagnostic on stderr naming the failing step and the operator's recovery action. The driving LLM relays that stderr verbatim and stops, so the stderr is the whole artifact the human gets — it must be unambiguous.

Two mechanisms enforce this in `publish-prepare.sh`, `publish-promote.sh`, `preflight.sh`, `smoke-check.sh`, and `install-local.sh`; new code in those scripts must honor both:

- **Guarded exits.** Print the `SR-X.Y` line, then exit via `sr_exit <code>` rather than a bare `exit <code>`. `sr_exit` raises a one-way `SR_GUARDED_EXIT` flag before exiting, which tells the backstop this failure is already described.
- **The SR-99.0 backstop.** Each script installs an EXIT trap that prints `SR-99.0 (uncaught)` when it exits non-zero *with the flag unset* — i.e. a `set -e` death at a site nobody wrapped. It preserves the failing command's exit code and reports the command text, so the unguarded site can be found and wrapped.

Consequences worth knowing before editing these scripts:

- Do not use an exit-code allowlist instead of the flag. An allowlist silently rots the moment a new SR code is added; the flag needs no bookkeeping.
- `sr_exit` must run in the script's own shell. Inside a subshell or command substitution the flag would be set in the child only, and the backstop would fire anyway. A helper that must fail from a subshell should `return 1` and let its call site do `|| sr_exit <code>`.
- A correct run therefore produces exactly one SR block. Seeing `SR-99.0` alongside a per-step `SR-X.Y` means the guard was bypassed, not that two things failed.

`scripts/sanitize-global.sh` is exempt: all of its deliberate exits are 0 (it is belt-and-suspenders by design), so it has nothing to guard. `scripts/install-local.sh` is a developer helper outside the release path, so its one guarded failure prints an `[install-local]` diagnostic rather than an `SR-X.Y` one — but it still routes that exit through `sr_exit`, for the same reason.

### Recovery actions by failure mode

Every failure path in `/publish` emits a diagnostic identifying the failing SR sub-step and the operator's recovery action — the operator should not need to read the skill source. Common modes:

| Failure | Diagnostic prefix | Recovery |
|---|---|---|
| Dirty tree / wrong branch / diverged main | `SR-2.1 (preflight)` | Commit/stash, checkout main, or sync with `git pull --ff-only origin main`; rerun `/publish`. |
| Lockfile out of sync | `SR-2.2 (preflight)` | Run `bun install`, commit the updated `bun.lock` to main, rerun. |
| No tests / failing tests / failing typecheck | `SR-2.3 (preflight)` | Add or fix tests / types, commit to main, rerun. |
| `npm whoami` fails | `SR-2.4 (preflight)` | `npm login`, rerun. |
| Version already on npm | `SR-2.4 (preflight)` | Pull latest main (or pick a larger bump), rerun. |
| npm registry is non-canonical (would publish to the wrong registry) | `SR-2.4a (preflight)` | `npm config set registry https://registry.npmjs.org/` (or confirm intent — e.g., this is deliberately a fork), rerun. |
| `bun pm whoami` fails (no bun identity for the post-publish `bun install -g`, SR-7.3) | `SR-2.4b (preflight)` | `bun pm login` (note: bun's auth is separate from npm's; both must be in place), rerun. |
| Host's agent-director missing/broken, its version unparseable, or its version does not satisfy the range declared in `package.json` (also fires if `package.json` is malformed / `jq` is broken) | `SR-2.5 (preflight)` (exit 15) | Either (a) upgrade the host's agent-director to a version satisfying `package.json`'s declared range, or (b) edit `package.json`'s declared range to include the installed version and commit to main; then rerun. (If instead `package.json` failed to parse, fix the JSON defect on main and commit first.) |
| `/ci` not runnable or non-PASS | `SR-2.7 (/ci gate)` | Start Docker / export `ANTHROPIC_API_KEY` (plus `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` for a gateway credential), or fix the integration regression, then rerun. |
| Stranded finished work (a finished bee's fix is neither on main nor explicitly closed, an unmerged branch references a finished ticket, or an unmerged branch references no known ticket at all) — audit exit 1 | `SR-2.6 (preflight)` (exit 16) | For each flagged ticket, land its fix on main or explicitly close it (a stated reason — no-repro / won't-fix / not-a-bug / by design / works as intended / superseded / abandoned / satisfied-by-other-work, with a pointer to where the work lives — or an anchored `## +closed:out-of-repo <path>` / `## +closed:docs-only` heading); for each flagged branch, merge it, or abandon it by pushing an `archive/<name>` tag at its head **before** deleting the remote ref. Re-close the tickets, then rerun. The gate is read-only — it never mutates tickets or git. |
| Audit could not run — the hives (Bugs, Plans, Ideas), a git repo, or a `main` ref were not locatable from this checkout (e.g. a throwaway `/tmp` clone with no hives beside it) — audit exit 2 or other. This is a **setup failure, not stranded work**; the release is still blocked (fail closed). | `SR-2.6 (preflight)` (exit 17) | Rerun `/publish` from the canonical checkout that sits beside the hives (the main working clone), not a throwaway/`/tmp` clone. |
| Bump / pack / scratch-install / smoke failure | `SR-3.1` or `SR-4.x` | Working tree is rolled back automatically. Investigate the upstream error, then rerun. |
| `git push origin main` failure | `SR-5.2 (push commit)` | The release commit + tag are local-only; resolve the push issue and re-run `git push origin main` manually + `npm publish <tarball>` + `git push origin v<version>`, OR `git reset --hard HEAD~1 && git tag -d v<version>` to abandon and rerun `/publish`. |
| `npm publish` failure | `SR-5.3 (npm publish)` | Commit is on origin; npm does not have the version. Fix the publish issue (e.g., `npm login`) and re-run `npm publish <tarball>` manually, then `git push origin v<version>`. The smoke-tested tarball is preserved in CWD for the manual re-publish. |
| `git push origin v<version>` failure | `SR-5.4 (push tag)` | The release is otherwise complete — only the tag is missing. Resolve the push issue and re-run `git push origin v<version>` manually. Do not rerun `/publish`. |
| Registry not visible within 10 minutes | `SR-6.1 (registry verification)` | Propagation lag only; the release succeeded. Re-confirm with `npm view claude-slack-channel-bots@<version> version`, then proceed manually with `bun install -g` and `clean_restart`. |
| Post-publish install failure | `SR-7.3 (post-publish install)` | Dev box has no global install. Re-run `bun install -g claude-slack-channel-bots@<version>` manually until it succeeds, then `clean_restart`. |
| Post-publish verification failure — wrong version, or bin not on PATH | `SR-7.4 (post-publish verification)` | The release is published; only the local install is wrong. `bun remove -g claude-slack-channel-bots && bun install -g claude-slack-channel-bots@<version>`, then `clean_restart`. |
| Post-publish verification failure — the bin on PATH resolves **outside** `${BUN_INSTALL:-$HOME/.bun}/install/global/` (an install in another bun prefix, or a worktree symlink farm, shadowing this one) | `SR-7.4 (post-publish verification)`, exit 72 — preceded by an `SR-7.0` warning at the top of Phase 7 | The release is published **and correctly installed**; only PATH resolution is wrong, so reinstalling changes nothing. Follow the shadow report in the diagnostic verbatim: it names the shadowing path, the symlink chain, and the exact `rm -rf <stale-prefix>/install/global` + `ln -sfn` repoint + `bun pm -g trust` sequence. Never touch any `install/cache` directory; repoint the PATH shim rather than deleting it. Then `clean_restart` and delete the manifest. Do not rerun `/publish promote`. |
| Postinstall did not run — `config.json` / `access.json` / `slack-mcp.json` still missing after install (fresh global prefix with no `trustedDependencies` entry) | `SR-7.4b (postinstall trust)` — **warning only, exit code unchanged** | The release is fully delivered. Run `bun pm -g trust claude-slack-channel-bots` and confirm a `✓ [postinstall]` line, then re-check the listed paths. `trust` swallows the postinstall's stdout, so the files existing on disk is the observable proof — not the script's log. |
| A release script died at a site with no SR wrapper (backstop) | `SR-99.0 (uncaught)` | State of the release is indeterminate. Relay the trap output verbatim — it names the script and the failing command — and do not rerun `/publish` until a human has assessed. Wrap the identified site with a real SR-X.Y diagnostic before the next release. |

### Post-publish

`/publish` ends with a success summary listing the published version, npm URL, GitHub tag URL, the resolved local install path, and a final instruction. Run that final instruction to swap the running CSCB daemon onto the new binary:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See `clean_restart` in the README for behavior details.
