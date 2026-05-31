/**
 * agent-director-stub.ts — Test helper that mints fake `agent-director`
 * `Client` instances for unit tests (SR-8.3).
 *
 * Epic 1 scope: only the verbs the foundation needs are wired up — the
 * `Client` constructor's throw-injection points (the four typed Err* classes
 * the SR-5.1 startup gate branches on), `version()` for the version-gate
 * sub-case matrix, and `makeTemplate()` for the SR-3.2 template install path.
 * Epic 2 extends this helper to cover the full spawn / list / get / decide
 * surface CSCB uses at runtime.
 *
 * The stub does NOT extend `Client` — instantiating the real class would call
 * Bun FFI. Instead it satisfies the structural-typed verb surface CSCB calls.
 * Production code under test injects the stub via the `getClient` factory
 * passed to the startup gate (see src/agent-director-startup.ts).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrAlreadyDecided,
  ErrBunVersionTooOld,
  ErrCallTimeout,
  ErrCliNotExecutable,
  ErrInstanceIdCollision,
  ErrJsonlMissing,
  ErrNoOpenPermissionRequest,
  ErrNoSessionId,
  ErrPauseTimeout,
  ErrPlatformPackageMissing,
  ErrRelayModeOff,
  ErrSpawnNotFound,
  ErrSpawnNotInteractive,
  ErrSpawnNotResumable,
  ErrTemplateExists,
  ErrTemplateMalformed,
  ErrTemplateNameUnsafe,
  ErrUnsupportedPlatform,
} from 'agent-director'
import type {
  DecideParams,
  DecideResult,
  DeleteParams,
  DeleteResult,
  GetParams,
  GetResult,
  KillParams,
  KillResult,
  ListParams,
  ListResult,
  ListRow,
  MakeTemplateParams,
  MakeTemplateResult,
  PauseParams,
  PauseResult,
  ReadPaneParams,
  ReadPaneResult,
  ResumeParams,
  ResumeResult,
  SendKeysParams,
  SendKeysResult,
  SpawnParams,
  SpawnResult,
  StatusParams,
  StatusResult,
  VersionParams,
  VersionResult,
} from 'agent-director'
import type { PermissionRequestRow } from '../../src/permission-poller.ts'

// ---------------------------------------------------------------------------
// Canned-result and canned-rejection factories
// ---------------------------------------------------------------------------

/** Build a canned VersionResult. */
export function cannedVersion(version: string, commit: string = 'deadbeef'): VersionResult {
  return { version, commit }
}

/** Build a canned MakeTemplateResult. */
export function cannedMakeTemplate(path: string): MakeTemplateResult {
  return { path }
}

/** Build an ErrPlatformPackageMissing (Client-constructor failure mode). */
export function errPlatformPackageMissing(pkg: string = '@agent-director/linux-x64', detail?: string): ErrPlatformPackageMissing {
  return new ErrPlatformPackageMissing(pkg, detail)
}

/** Build an ErrUnsupportedPlatform (Client-constructor failure mode). */
export function errUnsupportedPlatform(tuple: string = 'win32-x64'): ErrUnsupportedPlatform {
  return new ErrUnsupportedPlatform(tuple)
}

/** Build an ErrBunVersionTooOld (Client-constructor failure mode). */
export function errBunVersionTooOld(actual: string = '0.9.0', minimum: string = '1.0.21'): ErrBunVersionTooOld {
  return new ErrBunVersionTooOld(actual, minimum)
}

/** Build an ErrCliNotExecutable (Client-constructor failure mode). */
export function errCliNotExecutable(path: string = '/path/to/agent-director-bin'): ErrCliNotExecutable {
  return new ErrCliNotExecutable(path)
}

/** Build an ErrCallTimeout (any verb; per-call timeout exceeded). */
export function errCallTimeout(verb: string = 'version', elapsedMs: number = 35000, timeoutMs: number = 30000): ErrCallTimeout {
  return new ErrCallTimeout(verb, elapsedMs, timeoutMs)
}

/** Build an ErrTemplateExists (makeTemplate failure mode pre-overwrite). */
export function errTemplateExists(): ErrTemplateExists {
  return new ErrTemplateExists('make-template', 'ErrTemplateExists', 'template already exists')
}

/** Build an ErrTemplateMalformed (makeTemplate fatal failure mode). */
export function errTemplateMalformed(): ErrTemplateMalformed {
  return new ErrTemplateMalformed('make-template', 'ErrTemplateMalformed', 'template malformed')
}

/** Build an ErrTemplateNameUnsafe (makeTemplate fatal failure mode). */
export function errTemplateNameUnsafe(): ErrTemplateNameUnsafe {
  return new ErrTemplateNameUnsafe('make-template', 'ErrTemplateNameUnsafe', 'unsafe template name')
}

/** Build a plain AgentDirectorError (catch-all path). */
export function errGeneric(verb: string, errName: string, message: string = 'oops'): AgentDirectorError {
  return new AgentDirectorError(verb, errName, message)
}

/** Build an ErrSpawnNotFound (spawn/get/decide on missing row). */
export function errSpawnNotFound(): ErrSpawnNotFound {
  return new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'spawn not found')
}

/** Build an ErrSpawnNotInteractive (readPane/sendKeys while spawn is still pending). */
export function errSpawnNotInteractive(verb: string = 'read-pane'): ErrSpawnNotInteractive {
  return new ErrSpawnNotInteractive(verb, 'ErrSpawnNotInteractive', 'spawn not interactive — not in pending/waiting state')
}

/** Build an ErrInstanceIdCollision (spawn / SR-1.4 collision path). */
export function errInstanceIdCollision(): ErrInstanceIdCollision {
  return new ErrInstanceIdCollision('spawn', 'ErrInstanceIdCollision', 'claude_instance_id already in use')
}

/** Build an ErrNoSessionId (resume / SR-1.3 fall-through). */
export function errNoSessionId(): ErrNoSessionId {
  return new ErrNoSessionId('resume', 'ErrNoSessionId', 'no session id available')
}

/** Build an ErrJsonlMissing (resume / SR-1.3 fall-through). */
export function errJsonlMissing(): ErrJsonlMissing {
  return new ErrJsonlMissing('resume', 'ErrJsonlMissing', 'jsonl missing')
}

/** Build an ErrSpawnNotResumable (resume / SR-1.4 collision-recovery). */
export function errSpawnNotResumable(): ErrSpawnNotResumable {
  return new ErrSpawnNotResumable('resume', 'ErrSpawnNotResumable', 'row is non-terminal')
}

/** Build an ErrAlreadyDecided (decide; treated-as-success). */
export function errAlreadyDecided(): ErrAlreadyDecided {
  return new ErrAlreadyDecided('decide', 'ErrAlreadyDecided', 'permission request already decided')
}

/**
 * Build an ErrInvalidFlags (decide; missing required flag like
 * `--request-token`). The published `agent-director` library does not yet
 * export a typed subclass for this errName — the paired AD release ships it.
 * Until then, return a base `AgentDirectorError` carrying the right
 * `errName` so the click handler's `err.errName === 'ErrInvalidFlags'` match
 * fires correctly.
 */
export function errInvalidFlags(): AgentDirectorError {
  return new AgentDirectorError('decide', 'ErrInvalidFlags', 'invalid flags')
}

/**
 * Build an ErrAmbiguousRequest (decide; defense-in-depth backstop, should be
 * unreachable under contract). Same shape as `errInvalidFlags`: not yet a
 * typed subclass in the published library, so we use the base class with the
 * canonical `errName`.
 */
export function errAmbiguousRequest(): AgentDirectorError {
  return new AgentDirectorError('decide', 'ErrAmbiguousRequest', 'ambiguous request')
}

/** Build an ErrNoOpenPermissionRequest (decide / poller race). */
export function errNoOpenPermissionRequest(): ErrNoOpenPermissionRequest {
  return new ErrNoOpenPermissionRequest('decide', 'ErrNoOpenPermissionRequest', 'no open permission request')
}

/** Build an ErrRelayModeOff (spawn / SR-1.2 abort). */
export function errRelayModeOff(): ErrRelayModeOff {
  return new ErrRelayModeOff('spawn', 'ErrRelayModeOff', 'relay_mode is off')
}

/** Build an ErrPauseTimeout (pause budget exceeded). */
export function errPauseTimeout(): ErrPauseTimeout {
  return new ErrPauseTimeout('pause', 'ErrPauseTimeout', 'pause timed out')
}

// ---------------------------------------------------------------------------
// ListRow + GetResult builders
// ---------------------------------------------------------------------------

/** Build a canned ListRow with sensible defaults. Override fields as needed. */
export function cannedListRow(overrides: Partial<ListRow> & { claude_instance_id: string }): ListRow {
  return {
    parent_id: undefined,
    state: 'waiting',
    cwd: '/tmp/cwd',
    tmux_session_name: `slack_bot_${overrides.claude_instance_id}`,
    relay_mode: 'on',
    labels: { service: 'cscb', channel: 'C_TEST' },
    started_at: '2026-05-24T12:00:00Z',
    last_seen_at: '2026-05-24T12:00:00Z',
    ended_at: null,
    ...overrides,
  }
}

/**
 * Build a canned `PermissionRequestRow` for the plural-projection wire. The
 * default `request_token` is a fresh UUIDv4 (via `crypto.randomUUID()`) so
 * the encoded action_id round-trips through the SR-2.2 anchored regex. CSCB
 * test infrastructure mints opaque tokens; production CSCB code never does.
 */
export function cannedPermissionRequest(
  overrides: Partial<PermissionRequestRow> = {},
): PermissionRequestRow {
  return {
    request_token: crypto.randomUUID(),
    request_id: 1,
    tool_name: 'Bash',
    tool_input: JSON.stringify({ command: 'ls /tmp' }),
    requested_at: '2026-05-24T12:00:00Z',
    ...overrides,
  }
}

/**
 * Overrides accepted by `cannedGetResult` / `cannedGetResultPlural`. The
 * plural `permission_requests` field is not on the published agent-director
 * `GetResult`; the paired AD release replaces the legacy singular field
 * with the plural array, and CSCB consumes the new shape via a structural
 * cast inside the poller.
 */
export type GetResultOverrides =
  & Partial<GetResult>
  & { claude_instance_id: string }
  & { permission_requests?: PermissionRequestRow[] | null }

/**
 * `cannedGetResult` may carry a `permission_requests` field for check_permission
 * rows. Production code (`permission-poller.ts`,
 * `permission-click-handler.ts`) casts `GetResult` to
 * `GetResultWithPermissionRequests` at the use site, so the extra field
 * flows through without polluting the upstream type.
 */
export type CannedGetResult = GetResult & { permission_requests?: PermissionRequestRow[] | null }

/**
 * Build a canned `GetResult`. Pass `permission_requests` for check_permission
 * rows under the new plural-projection wire. For the negative-test cases
 * (poller skips when the plural field is absent), pass `null` or omit.
 */
export function cannedGetResult(overrides: GetResultOverrides): CannedGetResult {
  return {
    parent_id: '',
    state: 'waiting',
    cwd: '/tmp/cwd',
    tmux_session_name: `slack_bot_${overrides.claude_instance_id}`,
    claude_args: [],
    relay_mode: 'on',
    jsonl_path: '',
    claude_session_id: '',
    labels: { service: 'cscb', channel: 'C_TEST' },
    started_at: '2026-05-24T12:00:00Z',
    last_seen_at: '2026-05-24T12:00:00Z',
    ended_at: null,
    ...overrides,
  }
}

/**
 * Build a canned `GetResult` carrying a non-empty `permission_requests`
 * array — the typical positive-test shape for poller / click-handler tests
 * under the new wire.
 */
export function cannedGetResultPlural(
  overrides: GetResultOverrides & { permission_requests: PermissionRequestRow[] },
): CannedGetResult {
  return cannedGetResult(overrides)
}

/**
 * Build a canned plural projection with TWO open `permission_requests`
 * rows on the same spawn — the Epic-1 acceptance fixture for
 * "two concurrent prompts on one spawn each get their own Slack message
 * keyed on the composite (claude_instance_id, request_token)".
 *
 * Both rows share `claude_instance_id` and differ on `request_token`,
 * `request_id`, and `tool_name` so the test can identify them.
 */
export function cannedTwoRowPluralProjection(
  claudeInstanceId: string,
  overrides: Omit<GetResultOverrides, 'claude_instance_id' | 'permission_requests'> = {},
): CannedGetResult {
  return cannedGetResult({
    claude_instance_id: claudeInstanceId,
    state: 'check_permission',
    ...overrides,
    permission_requests: [
      cannedPermissionRequest({ request_id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'ls /tmp' }) }),
      cannedPermissionRequest({ request_id: 2, tool_name: 'Edit', tool_input: JSON.stringify({ file_path: '/etc/hosts' }) }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Stub Client
// ---------------------------------------------------------------------------

/**
 * A canned response for a verb: either a `Result` to resolve with or an
 * `Error` to reject with. Tests pass an array of these to drive sequential
 * call behavior — `spawn` returns the first, then the second, etc.
 */
export type CannedResponse<T> =
  | { kind: 'resolve'; value: T }
  | { kind: 'reject'; error: Error }

export const cannedOk = <T>(value: T): CannedResponse<T> => ({ kind: 'resolve', value })
export const cannedErr = <T>(error: Error): CannedResponse<T> => ({ kind: 'reject', error })

/**
 * Injection points for `makeStubClient`. Each verb has two knobs:
 *
 *   - `<verb>Result` / `<verb>Error`: single canned response, returned for
 *     every call.
 *   - `<verb>Queue`: an array of `CannedResponse<>` — the stub shifts the
 *     next response off the front on each call. Empty queue throws a marker
 *     error. Mutually exclusive with the `<verb>Result`/`<verb>Error`.
 *
 * Plus capture arrays — `<verb>Calls` — for assertion against call shape.
 */
export interface StubClientOptions {
  // version()
  versionResult?: VersionResult
  versionError?: Error
  versionCalls?: VersionParams[]

  // makeTemplate()
  makeTemplateResult?: MakeTemplateResult
  makeTemplateError?: Error
  makeTemplateCalls?: MakeTemplateParams[]

  // spawn()
  spawnResult?: SpawnResult
  spawnError?: Error
  spawnQueue?: CannedResponse<SpawnResult>[]
  spawnCalls?: SpawnParams[]

  // status()
  statusResult?: StatusResult
  statusError?: Error
  statusQueue?: CannedResponse<StatusResult>[]
  statusCalls?: StatusParams[]

  // get()
  getResult?: GetResult
  getError?: Error
  getQueue?: CannedResponse<GetResult>[]
  getCalls?: GetParams[]

  // sendKeys()
  sendKeysResult?: SendKeysResult
  sendKeysError?: Error
  sendKeysCalls?: SendKeysParams[]

  // readPane() — FIFO sequence of canned panes; last entry sticks once
  // consumed. Mutually exclusive with `readPaneError`.
  readPaneResults?: ReadPaneResult[]
  readPaneError?: Error
  readPaneCalls?: ReadPaneParams[]

  // kill()
  killResult?: KillResult
  killError?: Error
  killCalls?: KillParams[]

  // decide()
  decideResult?: DecideResult
  decideError?: Error
  decideQueue?: CannedResponse<DecideResult>[]
  decideCalls?: DecideParams[]

  // resume()
  resumeResult?: ResumeResult
  resumeError?: Error
  resumeQueue?: CannedResponse<ResumeResult>[]
  resumeCalls?: ResumeParams[]

  // delete()
  deleteResult?: DeleteResult
  deleteError?: Error
  deleteCalls?: DeleteParams[]

  // list()
  listResult?: ListResult
  listError?: Error
  listQueue?: CannedResponse<ListResult>[]
  listCalls?: ListParams[]

  // pause()
  pauseResult?: PauseResult
  pauseError?: Error
  pauseCalls?: PauseParams[]
}

/** Structural-typed `Client` stub satisfying every verb CSCB uses. */
export type StubClient = {
  version(params: VersionParams): Promise<VersionResult>
  makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult>
  spawn(params: SpawnParams): Promise<SpawnResult>
  status(params: StatusParams): Promise<StatusResult>
  get(params: GetParams): Promise<GetResult>
  sendKeys(params: SendKeysParams): Promise<SendKeysResult>
  readPane(params: ReadPaneParams): Promise<ReadPaneResult>
  kill(params: KillParams): Promise<KillResult>
  decide(params: DecideParams): Promise<DecideResult>
  resume(params: ResumeParams): Promise<ResumeResult>
  delete(params: DeleteParams): Promise<DeleteResult>
  list(params: ListParams): Promise<ListResult>
  pause(params: PauseParams): Promise<PauseResult>
  close(): void
  [Symbol.dispose](): void
}

/** Resolve the next response: queue first (mutating), then result/error, else throw. */
function nextResponse<T>(
  verb: string,
  queue: CannedResponse<T>[] | undefined,
  result: T | undefined,
  error: Error | undefined,
  defaultValue?: T,
): T {
  if (queue && queue.length > 0) {
    const item = queue.shift()!
    if (item.kind === 'reject') throw item.error
    return item.value
  }
  if (error) throw error
  if (result !== undefined) return result
  if (defaultValue !== undefined) return defaultValue
  throw new Error(`agent-director-stub: '${verb}' called but no canned response configured`)
}

/** Build a stub Client driven by the supplied knobs. */
export function makeStubClient(opts: StubClientOptions = {}): StubClient {
  return {
    async version(params: VersionParams): Promise<VersionResult> {
      opts.versionCalls?.push(params)
      if (opts.versionError) throw opts.versionError
      return opts.versionResult ?? cannedVersion('v0.4.3')
    },
    async makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult> {
      opts.makeTemplateCalls?.push(params)
      if (opts.makeTemplateError) throw opts.makeTemplateError
      return (
        opts.makeTemplateResult ?? cannedMakeTemplate(`~/.agent-director/templates/${params.name}.toml`)
      )
    },
    async spawn(params: SpawnParams): Promise<SpawnResult> {
      opts.spawnCalls?.push(params)
      return nextResponse('spawn', opts.spawnQueue, opts.spawnResult, opts.spawnError, {
        claude_instance_id: params.claude_instance_id ?? 'cscb_test',
      })
    },
    async status(params: StatusParams): Promise<StatusResult> {
      opts.statusCalls?.push(params)
      return nextResponse('status', opts.statusQueue, opts.statusResult, opts.statusError, { state: 'waiting' })
    },
    async get(params: GetParams): Promise<GetResult> {
      opts.getCalls?.push(params)
      return nextResponse('get', opts.getQueue, opts.getResult, opts.getError, cannedGetResult({
        claude_instance_id: params.claude_instance_id,
      }))
    },
    async sendKeys(params: SendKeysParams): Promise<SendKeysResult> {
      opts.sendKeysCalls?.push(params)
      if (opts.sendKeysError) throw opts.sendKeysError
      return opts.sendKeysResult ?? {}
    },
    async readPane(params: ReadPaneParams): Promise<ReadPaneResult> {
      opts.readPaneCalls?.push(params)
      if (opts.readPaneError) throw opts.readPaneError
      const seq = opts.readPaneResults
      if (seq && seq.length > 0) {
        // FIFO; the last remaining entry sticks (do not pop the tail).
        return seq.length === 1 ? seq[0] : seq.shift()!
      }
      return { pane: '' }
    },
    async kill(params: KillParams): Promise<KillResult> {
      opts.killCalls?.push(params)
      if (opts.killError) throw opts.killError
      return opts.killResult ?? {}
    },
    async decide(params: DecideParams): Promise<DecideResult> {
      opts.decideCalls?.push(params)
      return nextResponse('decide', opts.decideQueue, opts.decideResult, opts.decideError, {})
    },
    async resume(params: ResumeParams): Promise<ResumeResult> {
      opts.resumeCalls?.push(params)
      return nextResponse('resume', opts.resumeQueue, opts.resumeResult, opts.resumeError, {
        claude_instance_id: params.claude_instance_id,
      })
    },
    async delete(params: DeleteParams): Promise<DeleteResult> {
      opts.deleteCalls?.push(params)
      if (opts.deleteError) throw opts.deleteError
      return opts.deleteResult ?? { results: Object.fromEntries(params.claude_instance_id.map((id) => [id, 'ok'])) }
    },
    async list(params: ListParams): Promise<ListResult> {
      opts.listCalls?.push(params)
      return nextResponse('list', opts.listQueue, opts.listResult, opts.listError, { spawns: [] })
    },
    async pause(params: PauseParams): Promise<PauseResult> {
      opts.pauseCalls?.push(params)
      if (opts.pauseError) throw opts.pauseError
      return opts.pauseResult ?? {}
    },
    close(): void { /* no-op */ },
    [Symbol.dispose](): void { /* no-op */ },
  }
}
