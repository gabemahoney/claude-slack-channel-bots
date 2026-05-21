/**
 * claude-director-cli.ts — Typed wrappers for every claude-director verb CSCB needs.
 *
 * ## SR-1.1 argv-style discipline
 *
 * ALL shell-outs use `spawnSync('claude-director', [...argv], { stdio: ['ignore', 'pipe', 'pipe'] })`.
 * NEVER `shell: true`. NEVER `bash -c`. NEVER template-string interpolation into a shell command.
 * argv is assembled as a plain string array; each element is a separate token.
 *
 * ## Test seam (CE4)
 *
 * A module-level `spawnRunner` variable holds the current spawn implementation.
 * Tests call `_setSpawnRunner(stubRunner)` in `beforeEach` and `_resetSpawnRunner()` in `afterEach`.
 * Production callers use the default real runner — no DI needed at the call site.
 *
 * ## bigint / SR-2.2 discipline
 *
 * `permission_request.request_id` in `get` and `list` responses is parsed via
 * `lossless-json` and surfaced as a **string** at the wrapper boundary. This
 * avoids silent precision loss for request_ids > 2^53. All other numeric fields
 * may be coerced to JavaScript `number` safely; we use `lossless-json` for the
 * full `get`/`list` parse for simplicity, converting `LosslessNumber` to string
 * only at the wrapper's output boundary.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import { parse as losslessParse, LosslessNumber } from 'lossless-json'

// ---------------------------------------------------------------------------
// SpawnRunner type + seam (CE4)
// ---------------------------------------------------------------------------

/**
 * A typed function matching the subset of spawnSync's return value that
 * our wrappers need. Tests substitute this with a stub runner.
 */
export type SpawnRunner = (
  cmd: string,
  args: string[],
) => {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

/** The real production runner — calls spawnSync directly. */
function realSpawnRunner(cmd: string, args: string[]): {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
} {
  const result = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error as NodeJS.ErrnoException | undefined,
  }
}

/** Module-private runner — replaced by tests via _setSpawnRunner. */
let spawnRunner: SpawnRunner = realSpawnRunner

/**
 * Test-only seam. Replace the spawn runner with a stub.
 * Call in beforeEach; pair with _resetSpawnRunner() in afterEach.
 */
export function _setSpawnRunner(runner: SpawnRunner): void {
  spawnRunner = runner
}

/**
 * Test-only seam. Restore the real spawn runner.
 * Call in afterEach after _setSpawnRunner().
 */
export function _resetSpawnRunner(): void {
  spawnRunner = realSpawnRunner
}

// ---------------------------------------------------------------------------
// Error tokens (CE3 — exported so stub and tests can reuse them)
// ---------------------------------------------------------------------------

/**
 * Exact error-token substrings emitted by claude-director on stderr (JSON field "err_name").
 * The wrapper matches these via substring check against the raw stderr string.
 */
export const CLAUDE_DIRECTOR_ERROR_TOKENS = {
  ErrInstanceIdCollision: 'ErrInstanceIdCollision',
  ErrNoSessionId: 'ErrNoSessionId',
  ErrJsonlMissing: 'ErrJsonlMissing',
  ErrSpawnNotFound: 'ErrSpawnNotFound',
  ErrAlreadyDecided: 'ErrAlreadyDecided',
  ErrNoOpenPermissionRequest: 'ErrNoOpenPermissionRequest',
  ErrRelayModeOff: 'ErrRelayModeOff',
  ErrSpawnFailure: 'ErrSpawnFailure',
} as const

// ---------------------------------------------------------------------------
// ClaudeDirectorError discriminated union
// ---------------------------------------------------------------------------

export type ClaudeDirectorError =
  | { kind: 'ErrInstanceIdCollision'; message: string }
  | { kind: 'ErrNoSessionId'; message: string }
  | { kind: 'ErrJsonlMissing'; message: string }
  | { kind: 'ErrSpawnNotFound'; message: string }
  | { kind: 'ErrAlreadyDecided'; message: string }
  | { kind: 'ErrNoOpenPermissionRequest'; message: string }
  | { kind: 'ErrRelayModeOff'; message: string }
  | { kind: 'ErrSpawnFailure'; message: string }
  | { kind: 'ErrBinaryMissing'; message: string }
  | { kind: 'ErrNonZeroExit'; exitCode: number; stderr: string }
  | { kind: 'ErrUnparseableOutput'; stderr: string; stdout: string }
  | { kind: 'ErrUnknown'; message: string }

// ---------------------------------------------------------------------------
// Result<T> discriminated union
// ---------------------------------------------------------------------------

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ClaudeDirectorError }

// ---------------------------------------------------------------------------
// Shared data shapes
// ---------------------------------------------------------------------------

export interface SpawnRow {
  claudeInstanceId: string
  state: string
  labels: Record<string, string>
  // Additional fields from the full DB row — callers that only need the above
  // three fields can ignore these.
  cwd?: string
  tmuxSessionName?: string
  relayMode?: string
  startedAt?: string
  lastSeenAt?: string
}

export interface PermissionRequest {
  /** Always a string — bigint-safe per SR-2.2. */
  requestId: string
  toolName: string
  /** Raw JSON string per SR-2.1. CSCB parses this downstream. */
  toolInput: string
}

// ---------------------------------------------------------------------------
// Verb argument interfaces (CE2)
// ---------------------------------------------------------------------------

export interface SpawnArgs {
  channelId: string
  cwd: string
  extraEnv?: Record<string, string>
}

/**
 * Verbs that accept either channelId or claudeInstanceId.
 * Precedence: claudeInstanceId wins when both are provided.
 * At least one must be present — runtime error if neither is given.
 */
export type InstanceRef =
  | { channelId: string; claudeInstanceId?: string }
  | { channelId?: string; claudeInstanceId: string }

export type ResumeArgs = InstanceRef
export type KillArgs = InstanceRef
export type DeleteArgs = InstanceRef
export type StatusArgs = InstanceRef
export type GetArgs = InstanceRef
export type SendKeysArgs = InstanceRef & { keys: string[] }
export type PauseArgs = InstanceRef
export type DecideArgs = InstanceRef & {
  requestId: string
  decision: 'allow' | 'deny'
}

export interface ListArgs {
  state?: string
  /**
   * Labels to filter by.
   * - `undefined` (not passed): defaults to `--label service=cscb` (poller SR-2.1 default).
   * - `{}` (empty object explicitly passed): NO label filter — returns all spawns.
   * - `{ key: value }`: one `--label key=value` per entry.
   */
  labels?: Record<string, string>
}

export type VersionArgs = Record<string, never>

// ---------------------------------------------------------------------------
// Verb-specific result data shapes
// ---------------------------------------------------------------------------

export interface SpawnResultData {
  claudeInstanceId: string
}

export interface GetResultData {
  claudeInstanceId: string
  state: string
  labels: Record<string, string>
  permissionRequest: PermissionRequest | null
}

export interface StatusResultData {
  claudeInstanceId: string
  state: string
}

export interface VersionResultData {
  version: string
}

// Result aliases for each verb
export type SpawnResult = Result<SpawnResultData>
export type ResumeResult = Result<Record<string, never>>
export type ListResult = Result<SpawnRow[]>
export type GetResult = Result<GetResultData>
export type StatusResult = Result<StatusResultData>
export type KillResult = Result<Record<string, never>>
export type DeleteResult = Result<Record<string, never>>
export type SendKeysResult = Result<Record<string, never>>
export type PauseResult = Result<Record<string, never>>
export type VersionResult = Result<VersionResultData>
export type DecideResult = Result<Record<string, never>>

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the --claude-instance-id value from an InstanceRef.
 * claudeInstanceId wins; falls back to `cscb_${channelId}`.
 * Throws if neither is provided.
 */
function resolveInstanceId(ref: InstanceRef): string {
  if (ref.claudeInstanceId) return ref.claudeInstanceId
  if (ref.channelId) return `cscb_${ref.channelId}`
  throw new Error(
    'claude-director-cli: InstanceRef requires either channelId or claudeInstanceId'
  )
}

/**
 * Classify a non-zero-exit result into a ClaudeDirectorError.
 * Inspects stderr for known error tokens. Falls back to ErrNonZeroExit.
 */
function classifyError(exitCode: number, stderr: string): ClaudeDirectorError {
  // Check each known token via substring match against stderr
  for (const token of Object.values(CLAUDE_DIRECTOR_ERROR_TOKENS) as Array<keyof typeof CLAUDE_DIRECTOR_ERROR_TOKENS>) {
    if (stderr.includes(token)) {
      return { kind: token as ClaudeDirectorError['kind'], message: stderr } as ClaudeDirectorError
    }
  }
  return { kind: 'ErrNonZeroExit', exitCode, stderr }
}

/**
 * Run the spawn runner and handle ENOENT / non-zero exits uniformly.
 * Returns the raw result, or a ClaudeDirectorError on failure.
 */
function run(
  args: string[],
): { ok: true; status: number; stdout: string; stderr: string } | { ok: false; error: ClaudeDirectorError } {
  let raw: ReturnType<SpawnRunner>
  try {
    raw = spawnRunner('claude-director', args)
  } catch (err) {
    // spawnRunner itself should not throw — but guard defensively
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return { ok: false, error: { kind: 'ErrBinaryMissing', message: 'claude-director binary not found (ENOENT)' } }
    }
    return { ok: false, error: { kind: 'ErrUnknown', message: String(err) } }
  }

  if (raw.error) {
    if (raw.error.code === 'ENOENT') {
      return { ok: false, error: { kind: 'ErrBinaryMissing', message: 'claude-director binary not found (ENOENT)' } }
    }
    return { ok: false, error: { kind: 'ErrUnknown', message: raw.error.message ?? String(raw.error) } }
  }

  const status = raw.status ?? 1
  if (status !== 0) {
    return { ok: false, error: classifyError(status, raw.stderr) }
  }

  return { ok: true, status, stdout: raw.stdout, stderr: raw.stderr }
}

/**
 * Convert a LosslessNumber (or any value) to a string without going through
 * Number() — preserving full precision for values > 2^53.
 */
function losslessToString(v: unknown): string {
  if (v instanceof LosslessNumber) return v.toString()
  return String(v)
}

// ---------------------------------------------------------------------------
// Wrappers (CE3 + CE4 + CE7)
// ---------------------------------------------------------------------------

/**
 * spawn — Launch a tracked Claude Code instance.
 *
 * Argv grammar (SR-1.1):
 *   spawn --template slack-channel-bot --cwd <cwd>
 *         --claude-instance-id cscb_<channelId>
 *         --relay-mode on
 *         --tmux-session-name slack_bot_<channelId>
 *         --label service=cscb --label channel=<channelId>
 *         [--extra-env KEY=VALUE ...]
 *
 * --relay-mode on is hard-coded: no caller can omit or override it (SR-8.6).
 * No trailing --. No post-`--` claude args (those live in the template per SR-1.1).
 */
export function spawn(args: SpawnArgs): SpawnResult {
  const instanceId = `cscb_${args.channelId}`
  const argv: string[] = [
    'spawn',
    '--template', 'slack-channel-bot',
    '--cwd', args.cwd,
    '--claude-instance-id', instanceId,
    '--relay-mode', 'on',
    '--tmux-session-name', `slack_bot_${args.channelId}`,
    '--label', 'service=cscb',
    '--label', `channel=${args.channelId}`,
  ]
  if (args.extraEnv) {
    for (const [k, v] of Object.entries(args.extraEnv)) {
      argv.push('--extra-env', `${k}=${v}`)
    }
  }

  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }

  // Parse stdout JSON for the spawned instance id
  let claudeInstanceId = instanceId
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    if (typeof parsed['claude_instance_id'] === 'string') {
      claudeInstanceId = parsed['claude_instance_id']
    }
  } catch {
    // spawn stdout may be empty or non-JSON — fall back to derived instanceId
  }

  return { ok: true, data: { claudeInstanceId } }
}

/**
 * resume — Bring a terminated Spawn back to life.
 */
export function resume(args: ResumeArgs): ResumeResult {
  const argv = ['resume', '--claude-instance-id', resolveInstanceId(args)]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * list — Enumerate Spawn rows with optional state/label filters.
 *
 * Label defaults:
 *   - labels === undefined → defaults to --label service=cscb (poller SR-2.1 default)
 *   - labels === {} → NO label flag (explicit "no filter")
 *   - labels === { key: val } → --label key=val per entry
 */
export function list(args: ListArgs = {}): ListResult {
  const argv: string[] = ['list']
  if (args.state !== undefined) {
    argv.push('--state', args.state)
  }
  if (args.labels === undefined) {
    // Default: filter by service=cscb (SR-2.1 poller default)
    argv.push('--label', 'service=cscb')
  } else {
    // Empty object means no label filter; non-empty means one --label per entry
    for (const [k, v] of Object.entries(args.labels)) {
      argv.push('--label', `${k}=${v}`)
    }
  }

  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }

  let parsed: unknown
  try {
    parsed = losslessParse(result.stdout)
  } catch {
    return { ok: false, error: { kind: 'ErrUnparseableOutput', stdout: result.stdout, stderr: result.stderr } }
  }

  const raw = parsed as Record<string, unknown>
  const spawnsRaw = Array.isArray(raw['spawns']) ? raw['spawns'] : []

  const rows: SpawnRow[] = (spawnsRaw as Array<Record<string, unknown>>).map((row) => ({
    claudeInstanceId: String(row['claude_instance_id'] ?? ''),
    state: String(row['state'] ?? ''),
    labels: (typeof row['labels'] === 'object' && row['labels'] !== null)
      ? Object.fromEntries(
          Object.entries(row['labels'] as Record<string, unknown>).map(([k, v]) => [
            k,
            v instanceof LosslessNumber ? v.toString() : String(v),
          ])
        )
      : {},
    cwd: typeof row['cwd'] === 'string' ? row['cwd'] : undefined,
    tmuxSessionName: typeof row['tmux_session_name'] === 'string' ? row['tmux_session_name'] : undefined,
    relayMode: typeof row['relay_mode'] === 'string' ? row['relay_mode'] : undefined,
    startedAt: typeof row['started_at'] === 'string' ? row['started_at'] : undefined,
    lastSeenAt: typeof row['last_seen_at'] === 'string' ? row['last_seen_at'] : undefined,
  }))

  return { ok: true, data: rows }
}

/**
 * decide — Orchestrator's allow/deny verdict on an open PermissionRequest.
 *
 * requestId is passed verbatim as a string — never parsed through Number.
 * Argv: decide --claude-instance-id <id> --request-id <requestId> --decision <allow|deny>
 */
export function decide(args: DecideArgs): DecideResult {
  const argv = [
    'decide',
    '--claude-instance-id', resolveInstanceId(args),
    '--request-id', args.requestId,
    '--decision', args.decision,
  ]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * kill — Terminate a Spawn's tmux session.
 */
export function kill(args: KillArgs): KillResult {
  const argv = ['kill', '--claude-instance-id', resolveInstanceId(args)]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * delete — Admin batch removal by claude_instance_id.
 * Returns ok=true even if the instance wasn't found (delete returns per-row result map).
 */
export function deleteSpawn(args: DeleteArgs): DeleteResult {
  const argv = ['delete', '--claude-instance-id', resolveInstanceId(args)]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * status — Return current state of a tracked Spawn.
 */
export function status(args: StatusArgs): StatusResult {
  const argv = ['status', '--claude-instance-id', resolveInstanceId(args)]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: { kind: 'ErrUnparseableOutput', stdout: result.stdout, stderr: result.stderr } }
  }

  const raw = parsed as Record<string, unknown>
  return {
    ok: true,
    data: {
      claudeInstanceId: String(raw['claude_instance_id'] ?? resolveInstanceId(args)),
      state: String(raw['state'] ?? ''),
    },
  }
}

/**
 * get — Return the full DB row for a tracked Spawn.
 *
 * Uses lossless-json to parse stdout so that permission_request.request_id
 * values > 2^53 are preserved as strings (SR-2.2 bigint discipline).
 */
export function get(args: GetArgs): GetResult {
  const instanceId = resolveInstanceId(args)
  const argv = ['get', '--claude-instance-id', instanceId]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }

  let parsed: unknown
  try {
    parsed = losslessParse(result.stdout)
  } catch {
    return { ok: false, error: { kind: 'ErrUnparseableOutput', stdout: result.stdout, stderr: result.stderr } }
  }

  const raw = parsed as Record<string, unknown>

  // Parse permission_request — request_id is surfaced as string (bigint-safe)
  let permissionRequest: PermissionRequest | null = null
  const pr = raw['permission_request']
  if (pr !== null && typeof pr === 'object' && !Array.isArray(pr)) {
    const prRaw = pr as Record<string, unknown>
    permissionRequest = {
      // lossless-json gives us a LosslessNumber here for large integers
      requestId: losslessToString(prRaw['request_id']),
      toolName: String(prRaw['tool_name'] ?? ''),
      toolInput: String(prRaw['tool_input'] ?? ''),
    }
  }

  const labelsRaw = raw['labels']
  const labels: Record<string, string> =
    (typeof labelsRaw === 'object' && labelsRaw !== null && !Array.isArray(labelsRaw))
      ? Object.fromEntries(
          Object.entries(labelsRaw as Record<string, unknown>).map(([k, v]) => [
            k,
            v instanceof LosslessNumber ? v.toString() : String(v),
          ])
        )
      : {}

  return {
    ok: true,
    data: {
      claudeInstanceId: String(raw['claude_instance_id'] ?? instanceId),
      state: String(raw['state'] ?? ''),
      labels,
      permissionRequest,
    },
  }
}

/**
 * sendKeys — Send text into a tracked Spawn's tmux pane.
 */
export function sendKeys(args: SendKeysArgs): SendKeysResult {
  const argv = ['send-keys', '--claude-instance-id', resolveInstanceId(args)]
  for (const key of args.keys) {
    argv.push('--text', key)
  }
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * pause — Politely shut down a waiting Spawn by sending /exit.
 */
export function pause(args: PauseArgs): PauseResult {
  const argv = ['pause', '--claude-instance-id', resolveInstanceId(args)]
  const result = run(argv)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: {} }
}

/**
 * version — Print the binary's version stamp.
 */
export function version(_args: VersionArgs = {}): VersionResult {
  const result = run(['version'])
  if (!result.ok) return { ok: false, error: result.error }

  let versionStr = result.stdout.trim()
  // Try to parse JSON in case the output is {"version":"v0.2.3","commit":"..."}
  try {
    const parsed = JSON.parse(versionStr) as Record<string, unknown>
    if (typeof parsed['version'] === 'string') {
      versionStr = parsed['version']
    }
  } catch {
    // stdout is plain text; use as-is
  }

  return { ok: true, data: { version: versionStr } }
}
