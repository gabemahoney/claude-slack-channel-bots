/**
 * tests/test-helpers/claude-director-stub.ts — Fake claude-director CLI surface for tests.
 *
 * ## Usage
 *
 *   const stub = new ClaudeDirectorStub({ spawnRows: [...] })
 *   stub.install()              // calls _setSpawnRunner
 *   // ... run code under test ...
 *   stub.uninstall()            // calls _resetSpawnRunner
 *
 * ## Queue semantics
 *
 * For sequence-sensitive flows (e.g. decide → already-decided), use queue methods
 * so the Nth call deterministically returns the Nth response:
 *
 *   stub.setDecideResponseQueue('cscb_C123', [
 *     { ok: true },
 *     { ok: false, error: { kind: 'ErrAlreadyDecided', message: '...' } },
 *   ])
 *
 * The queue is consumed FIFO. Once exhausted, further calls fall back to the default
 * (ok: true, data: {}). No manual response-swapping needed between calls.
 *
 * ## Bigint fixture note
 *
 * makeGetPayload produces stdout with request_id as a **JSON number literal**, not a
 * string. This exercises the wrapper's lossless-json parser. We hand-format that
 * field instead of using JSON.stringify so the number is not truncated.
 * DO NOT "fix" this by switching to JSON.stringify — it would silently corrupt
 * precision for values > 2^53.
 *
 * ## Dependency direction
 *
 * This module imports ONLY from src/claude-director-cli.ts (for the seam and types).
 * It does NOT import from src/server.ts or any other production module.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  _setSpawnRunner,
  _resetSpawnRunner,
  CLAUDE_DIRECTOR_ERROR_TOKENS,
  type SpawnRunner,
  type SpawnRow,
  type GetResultData,
  type PermissionRequest,
} from '../../src/claude-director-cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One recorded invocation. */
export interface StubCall {
  verb: string
  argv: string[]
}

/** A canned response for queue-based sequence flows. */
export type QueueEntry =
  | { ok: true }
  | { ok: false; error: { kind: string; message?: string; exitCode?: number; stderr?: string } }

// ---------------------------------------------------------------------------
// Factory helpers (free functions)
// ---------------------------------------------------------------------------

/**
 * Build a SpawnRow as claude-director's list/get would return it.
 */
export function makeSpawnRow(opts: {
  channelId: string
  state?: string
  extraLabels?: Record<string, string>
}): SpawnRow {
  return {
    claudeInstanceId: `cscb_${opts.channelId}`,
    state: opts.state ?? 'waiting',
    labels: {
      'service': 'cscb',
      'channel': opts.channelId,
      ...(opts.extraLabels ?? {}),
    },
    cwd: `/tmp/test-cwd-${opts.channelId}`,
    tmuxSessionName: `slack_bot_${opts.channelId}`,
    relayMode: 'on',
  }
}

/**
 * Build a GetResultData payload as the wrapper returns it.
 * requestId defaults to '1' (a safe integer). For bigint tests pass
 * a string like '9007199254740993' — the stub emits it as a raw JSON
 * number literal so the wrapper's lossless-json parser is exercised.
 */
export function makeGetPayload(opts: {
  channelId: string
  state?: string
  requestId?: string
  toolName?: string
  toolInput?: string
}): GetResultData {
  const permissionRequest: PermissionRequest | null =
    opts.requestId !== undefined
      ? {
          requestId: opts.requestId,
          toolName: opts.toolName ?? 'bash',
          toolInput: opts.toolInput ?? '{"command":"echo hello"}',
        }
      : null

  return {
    claudeInstanceId: `cscb_${opts.channelId}`,
    state: opts.state ?? 'check_permission',
    labels: {
      service: 'cscb',
      channel: opts.channelId,
    },
    permissionRequest,
  }
}

// ---------------------------------------------------------------------------
// Stdout serializers
// ---------------------------------------------------------------------------

/**
 * Serialize a GetResultData to the JSON format claude-director's `get` verb emits.
 *
 * When permissionRequest is present, request_id is emitted as a **JSON number literal**
 * (not a JSON string) — this exercises the wrapper's bigint-safe parser.
 * Hand-formatted to avoid JSON.stringify truncating values > 2^53.
 * DO NOT replace this hand-format with JSON.stringify — it would silently corrupt
 * precision for request_id values > 2^53.
 */
function serializeGetRow(data: GetResultData): string {
  const prPart = data.permissionRequest === null
    ? '"permission_request":null'
    : `"permission_request":{"request_id":${data.permissionRequest.requestId},"tool_name":${JSON.stringify(data.permissionRequest.toolName)},"tool_input":${JSON.stringify(data.permissionRequest.toolInput)}}`

  // Build the base fields as JSON, then splice in the hand-formatted permission_request.
  // We concatenate field-by-field to avoid regex or string-replace fragility.
  const base = [
    `"claude_instance_id":${JSON.stringify(data.claudeInstanceId)}`,
    `"state":${JSON.stringify(data.state)}`,
    `"labels":${JSON.stringify(data.labels)}`,
    prPart,
  ].join(',')

  return `{${base}}`
}

/**
 * Serialize an array of SpawnRows to the JSON format claude-director's `list` verb emits.
 */
function serializeListRows(rows: SpawnRow[]): string {
  const spawns = rows.map((row) => ({
    claude_instance_id: row.claudeInstanceId,
    state: row.state,
    labels: row.labels,
    cwd: row.cwd,
    tmux_session_name: row.tmuxSessionName,
    relay_mode: row.relayMode,
    started_at: row.startedAt,
    last_seen_at: row.lastSeenAt,
  }))
  return JSON.stringify({ spawns })
}

/**
 * Build an error stderr token in the format claude-director emits.
 */
function makeErrorStderr(kind: string, description?: string): string {
  return JSON.stringify({ err_name: kind, err_description: description ?? kind })
}

// ---------------------------------------------------------------------------
// ClaudeDirectorStub
// ---------------------------------------------------------------------------

export interface StubOptions {
  /** Initial set of rows returned by `list`. */
  spawnRows?: SpawnRow[]
  /** Per-instance overrides for `get` payloads. Key is claude_instance_id. */
  getPayloads?: Record<string, GetResultData>
}

export class ClaudeDirectorStub {
  /** All recorded invocations in order. */
  public calls: StubCall[] = []

  private spawnRows: SpawnRow[]
  private getPayloads: Map<string, GetResultData>

  // Per-verb error queues (FIFO)
  private spawnErrorQueue: QueueEntry[] = []
  private resumeErrorQueues: Map<string, QueueEntry[]> = new Map()
  private decideQueues: Map<string, QueueEntry[]> = new Map()
  private statusQueues: Map<string, QueueEntry[]> = new Map()
  private killQueues: Map<string, QueueEntry[]> = new Map()
  private pauseQueues: Map<string, QueueEntry[]> = new Map()

  // ENOENT simulation flag
  private simulateEnoent = false

  constructor(opts: StubOptions = {}) {
    this.spawnRows = opts.spawnRows ?? []
    this.getPayloads = new Map(Object.entries(opts.getPayloads ?? {}))
  }

  // -------------------------------------------------------------------------
  // State controls
  // -------------------------------------------------------------------------

  setSpawnRows(rows: SpawnRow[]): void { this.spawnRows = rows }
  setGetPayload(instanceId: string, payload: GetResultData): void {
    this.getPayloads.set(instanceId, payload)
  }

  /**
   * Queue a response for the next spawn call.
   * Use `{ ok: false, error: { kind: 'ErrInstanceIdCollision', message: '...' } }` for error cases.
   */
  setNextSpawnError(entry: QueueEntry): void {
    this.spawnErrorQueue.push(entry)
  }

  /**
   * Queue responses for resume calls on a specific instance.
   */
  setNextResumeError(instanceId: string, entry: QueueEntry): void {
    if (!this.resumeErrorQueues.has(instanceId)) this.resumeErrorQueues.set(instanceId, [])
    this.resumeErrorQueues.get(instanceId)!.push(entry)
  }

  /**
   * Set a FIFO queue of decide responses for a specific instance.
   * e.g. first decide → ok, second → ErrAlreadyDecided.
   */
  setDecideResponseQueue(instanceId: string, queue: QueueEntry[]): void {
    this.decideQueues.set(instanceId, [...queue])
  }

  setStatusResponseQueue(instanceId: string, queue: QueueEntry[]): void {
    this.statusQueues.set(instanceId, [...queue])
  }

  setKillResponseQueue(instanceId: string, queue: QueueEntry[]): void {
    this.killQueues.set(instanceId, [...queue])
  }

  setPauseResponseQueue(instanceId: string, queue: QueueEntry[]): void {
    this.pauseQueues.set(instanceId, [...queue])
  }

  /** Simulate ENOENT (binary missing) on the next call. */
  setSimulateEnoent(value: boolean): void {
    this.simulateEnoent = value
  }

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  install(): void {
    _setSpawnRunner(this.runner)
  }

  uninstall(): void {
    _resetSpawnRunner()
  }

  // -------------------------------------------------------------------------
  // Runner (the actual stub logic)
  // -------------------------------------------------------------------------

  /**
   * Arrow function so `this` is bound when passed to _setSpawnRunner.
   */
  runner: SpawnRunner = (cmd: string, argv: string[]) => {
    if (this.simulateEnoent) {
      this.simulateEnoent = false
      const err = new Error('ENOENT: spawn error') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      return { status: null, stdout: '', stderr: '', error: err }
    }

    const verb = argv[0] ?? ''
    this.calls.push({ verb, argv })

    switch (verb) {
      case 'spawn': return this.handleSpawn(argv)
      case 'resume': return this.handleResume(argv)
      case 'list': return this.handleList(argv)
      case 'get': return this.handleGet(argv)
      case 'status': return this.handleStatus(argv)
      case 'kill': return this.handleKill(argv)
      case 'delete': return this.handleDelete(argv)
      case 'decide': return this.handleDecide(argv)
      case 'send-keys': return this.handleSendKeys(argv)
      case 'pause': return this.handlePause(argv)
      case 'version': return this.handleVersion()
      default:
        return { status: 1, stdout: '', stderr: makeErrorStderr('ErrUnknownVerb', verb) }
    }
  }

  // -------------------------------------------------------------------------
  // Per-verb handlers
  // -------------------------------------------------------------------------

  private handleSpawn(_argv: string[]): ReturnType<SpawnRunner> {
    const entry = this.spawnErrorQueue.shift()
    if (entry && !entry.ok) {
      return this.entryToError(entry)
    }
    // Extract --claude-instance-id from argv
    const instanceIdIdx = _argv.indexOf('--claude-instance-id')
    const instanceId = instanceIdIdx >= 0 ? (_argv[instanceIdIdx + 1] ?? 'unknown') : 'unknown'
    return {
      status: 0,
      stdout: JSON.stringify({ claude_instance_id: instanceId }),
      stderr: '',
    }
  }

  private handleResume(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const queue = this.resumeErrorQueues.get(instanceId)
    const entry = queue?.shift()
    if (entry && !entry.ok) return this.entryToError(entry)

    return { status: 0, stdout: '', stderr: '' }
  }

  private handleList(_argv: string[]): ReturnType<SpawnRunner> {
    return {
      status: 0,
      stdout: serializeListRows(this.spawnRows),
      stderr: '',
    }
  }

  private handleGet(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const payload = this.getPayloads.get(instanceId) ?? this.defaultGetPayload(instanceId)
    return {
      status: 0,
      stdout: serializeGetRow(payload),
      stderr: '',
    }
  }

  private handleStatus(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const queue = this.statusQueues.get(instanceId)
    const entry = queue?.shift()
    if (entry && !entry.ok) return this.entryToError(entry)

    const row = this.spawnRows.find((r) => r.claudeInstanceId === instanceId)
    return {
      status: 0,
      stdout: JSON.stringify({
        claude_instance_id: instanceId,
        state: row?.state ?? 'waiting',
      }),
      stderr: '',
    }
  }

  private handleKill(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const queue = this.killQueues.get(instanceId)
    const entry = queue?.shift()
    if (entry && !entry.ok) return this.entryToError(entry)

    return { status: 0, stdout: '', stderr: '' }
  }

  private handleDelete(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    // delete returns a per-row result map; not-found is a per-row error, not a top-level failure
    const found = this.instanceExists(instanceId)
    return {
      status: 0,
      stdout: JSON.stringify({ results: { [instanceId]: found ? 'ok' : 'ErrSpawnNotFound' } }),
      stderr: '',
    }
  }

  private handleDecide(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const queue = this.decideQueues.get(instanceId)
    const entry = queue?.shift()
    if (entry && !entry.ok) return this.entryToError(entry)

    return { status: 0, stdout: '', stderr: '' }
  }

  private handleSendKeys(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    return { status: 0, stdout: '', stderr: '' }
  }

  private handlePause(argv: string[]): ReturnType<SpawnRunner> {
    const instanceId = this.extractFlag(argv, '--claude-instance-id')
    if (!instanceId) return this.missingFlag('--claude-instance-id')
    if (!this.instanceExists(instanceId)) return this.notFound(instanceId)

    const queue = this.pauseQueues.get(instanceId)
    const entry = queue?.shift()
    if (entry && !entry.ok) return this.entryToError(entry)

    return { status: 0, stdout: '', stderr: '' }
  }

  private handleVersion(): ReturnType<SpawnRunner> {
    return {
      status: 0,
      stdout: JSON.stringify({ version: 'v0.0.0-stub', commit: 'stub' }),
      stderr: '',
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private extractFlag(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag)
    return idx >= 0 ? argv[idx + 1] : undefined
  }

  private instanceExists(instanceId: string): boolean {
    return this.spawnRows.some((r) => r.claudeInstanceId === instanceId) ||
      this.getPayloads.has(instanceId)
  }

  private defaultGetPayload(instanceId: string): GetResultData {
    return {
      claudeInstanceId: instanceId,
      state: 'waiting',
      labels: { service: 'cscb' },
      permissionRequest: null,
    }
  }

  private notFound(instanceId: string): ReturnType<SpawnRunner> {
    return {
      status: 1,
      stdout: '',
      stderr: makeErrorStderr(CLAUDE_DIRECTOR_ERROR_TOKENS.ErrSpawnNotFound, instanceId),
    }
  }

  private missingFlag(flag: string): ReturnType<SpawnRunner> {
    return {
      status: 1,
      stdout: '',
      stderr: makeErrorStderr('ErrInvalidFlags', `${flag} is required`),
    }
  }

  private entryToError(entry: QueueEntry & { ok: false }): ReturnType<SpawnRunner> {
    const e = entry.error
    if (e.kind === 'ErrBinaryMissing') {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      return { status: null, stdout: '', stderr: '', error: err }
    }
    return {
      status: (e.exitCode ?? 1),
      stdout: '',
      stderr: makeErrorStderr(e.kind, e.message),
    }
  }
}
