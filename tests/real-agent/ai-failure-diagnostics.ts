/** Failure-only evidence. Never supplies an oracle answer or changes a wait. */
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'
import { taskNotificationFields } from './native-task-notification.ts'

export const AI_FAILURE_PREFIX = 'real-agent-failure-evidence: '
export function scrubDiagnosticText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = Object.entries(env).filter(([key, value]) => value && /key|token|secret|password|credential/i.test(key)).map(([, value]) => value!)
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    for (const spelling of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) text = text.split(spelling).join('[REDACTED]')
  }
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|id_token|api_key|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
}

/** Metadata errors must never serialize arbitrary objects or message content. */
export function diagnosticValue(value: unknown): unknown {
  if (value === undefined) return '<undefined>'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return /^[A-Za-z0-9_.:/<>-]{0,256}$/.test(value) ? scrubDiagnosticText(value) : '<string withheld>'
  return Array.isArray(value) ? '<array>' : `<${typeof value}>`
}

export function reportFailureOnce(path: string, message: string, emit: (message: string) => void): void {
  const seen: string[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  if (seen.includes(message)) return
  writeFileSync(path, JSON.stringify([...seen, message]), { mode: 0o600 })
  emit(message)
}

const fields = (value: any, names: readonly string[]) => Object.fromEntries(names.filter(key => value?.[key] !== undefined).map(key => [key, diagnosticValue(value[key])]))
const errorScalarFields = ['type', 'name', 'code', 'error_type', 'errorType', 'status', 'status_code', 'statusCode',
  'http_status', 'httpStatus', 'http_status_code', 'httpStatusCode', 'retryable', 'is_retryable', 'isRetryable',
  'retry_after', 'retryAfter', 'retry_after_ms', 'retryAfterMs', 'attempt', 'retry_attempt', 'errno', 'turn_kind'] as const
// Codex 0.159.2's externally tagged variants (protocol/src/codex_error_info.rs).
// Unit variants are strings; these variants carry non-text metadata objects.
const codexErrorVariants = ['http_connection_failed', 'response_stream_connection_failed', 'response_stream_disconnected',
  'response_too_many_failed_attempts', 'active_turn_not_steerable'] as const
const nestedErrorFields = ['error', 'cause', 'response', 'codex_error_info', ...codexErrorVariants] as const
function errorMetadata(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return diagnosticValue(value)
  if (depth >= 8) return '<error depth limit>'
  return errorFields(value, depth + 1)
}
/** Keep error classification/status/retry facts, never messages, response bodies,
 * headers or arbitrary object keys. This is diagnostic evidence, not a retry rule. */
function errorFields(value: any, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...fields(value, errorScalarFields),
    ...Object.fromEntries(nestedErrorFields.filter(key => value[key] !== undefined)
      .map(key => [key, errorMetadata(value[key], depth)])),
    ...Object.fromEntries(['message', 'details', 'additional_details', 'stack'].filter(key => value[key] !== undefined)
      .map(key => [key, '<text withheld>'])) }
}
const identityFields = ['type', 'subtype', 'uuid', 'parentUuid', 'sessionId', 'session_id', 'agentId', 'agent_id', 'parentAgentId', 'isSidechain',
  'requestedModel', 'isMeta', 'isApiErrorMessage', 'error', 'isSynthetic', 'refusedUserMessageUuid', 'sourceToolAssistantUUID',
  'toolDenialKind', 'toolDenialEndsTurn', 'toolDenialMonitorBlocked', 'toolDenialUnanswered', 'toolEndsTurn', 'permissionMode',
  'stop_reason', 'terminal_reason', 'is_error', 'toolUseID', 'parentToolUseID'] as const
function contentMetadata(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === 'string' ? '<text withheld>' : diagnosticValue(content)
  return content.map(b => fields(b, ['type', 'id', 'name', 'tool_use_id', 'is_error']))
}
/** Native notification linkage is metadata; summary/result/body text is never retained. */
export function notificationMetadata(content: unknown) {
  const notification = taskNotificationFields(content)
  return notification && Object.fromEntries(Object.entries(notification).map(([key, value]) => [key, diagnosticValue(value)]))
}
export function projectClaudeFailure(entry: TranscriptEntry) {
  const v = entry.value, m = v?.message
  return { stream: basename(entry.path), sidechain: entry.path.includes('/subagents/'), offset: entry.offset,
    at: Number.isFinite(entry.at) ? entry.at : null, ...fields(v, identityFields), ...errorFields(v),
    origin: fields(v?.origin, ['kind', 'subkind', 'producer', 'runId']),
    toolUseResult: fields(v?.toolUseResult, ['agentId', 'status', 'isAsync', 'resolvedModel', 'canContinueAgent']),
    permissionDecision: typeof v?.permissionDecision === 'object' ? fields(v.permissionDecision, ['behavior', 'type', 'decision']) : diagnosticValue(v?.permissionDecision),
    toolResultRemedy: fields(v?.toolResultRemedy, ['kind']),
    data: fields(v?.data, ['type', 'subtype', 'agentId', 'status', 'tool_name', 'tool_use_id', 'decision', 'behavior']),
    attachment: fields(v?.attachment, ['type', 'agentId', 'taskId', 'status', 'commandMode', 'source_uuid']),
    request: fields(v?.request, ['subtype', 'tool_name', 'tool_use_id', 'request_id']),
    permission_denials: Array.isArray(v?.permission_denials) ? v.permission_denials.map((d: unknown) => fields(d, ['tool_name', 'tool_use_id'])) : undefined,
    notification: notificationMetadata(v?.type === 'attachment' && v.attachment?.type === 'queued_command' ? v.attachment.prompt : m?.content),
    message: { ...fields(m, ['id', 'role', 'model', 'stop_reason']), ...errorFields(m), content: contentMetadata(m?.content) } }
}
export function projectCodexFailure(entry: TranscriptEntry) {
  const v = entry.value, p = v?.payload
  return { stream: basename(entry.path), offset: entry.offset, at: Number.isFinite(entry.at) ? entry.at : null,
    ...fields(v, identityFields), ...errorFields(v), payload: { ...fields(p, [...identityFields, 'id', 'role', 'model', 'turn_id', 'call_id', 'name',
      'status', 'decision', 'approval', 'request_id', 'thread_id', 'parent_thread_id']), ...errorFields(p), content: contentMetadata(p?.content) } }
}
/** Preserve the final pane's rows and UI markers, never conversation or draft text.
 * Unknown text is withheld, including history, menu labels and tool arguments. */
export function projectFailurePane(pane: unknown) {
  if (typeof pane !== 'string') return { unavailable: true }
  const lines = pane.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').split('\n')
  return { lines: lines.map(line => {
    if (/^\s*$/.test(line) || /^\s*(?:l>)?[─━-]{8,}\s*$/.test(line)
      || /^\s*⏸ manual mode on(?: · \? for shortcuts(?: · ← for agents)?)?\s*$/.test(line)) return line
    const prompt = line.match(/^(\s*[❯›>][ \u00a0]?)(.*)$/)
    if (prompt) return prompt[1] + (prompt[2] ? '[text withheld]' : '')
    return '[text withheld]'
  }) }
}
/** Reads only JSONL below the scenario's isolated transcript directory. No
 * auth/config path or symlink is read. Partial/malformed records stay visible. */
export async function scenarioFailureRecords(root: string, agent: 'claude' | 'codex') {
  const { transcriptFiles } = await import('../integration/fixtures/transcript-receipts.ts')
  const records: unknown[] = []
  for (const path of transcriptFiles(root)) {
    let offset = 0
    let text: string
    try { text = readFileSync(path, 'utf8') }
    catch { records.push({ stream: diagnosticValue(basename(path)), unavailable: true }); continue }
    for (const line of text.split('\n')) {
      if (line) {
        try {
          const value = JSON.parse(line), at = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(value.timestamp ?? '')
          const entry = { path, offset, at, value, kind: 'other' }
          records.push({ ...((agent === 'claude' ? projectClaudeFailure : projectCodexFailure)(entry)), stream: relative(root, path).split('/').map(part => diagnosticValue(part)).join('/') })
        } catch { records.push({ stream: diagnosticValue(basename(path)), offset, malformed: true }) }
      }
      offset += Buffer.byteLength(line) + 1
    }
  }
  return records
}

/** All attempts/copies for the selected item, including late linked responses.
 * No raw prompt, tool arguments, config, login file or tool-result body leaves
 * the container. An absent send is recorded explicitly, never called a pass. */
export function claudeFailureRecords(journal: any[], entries: TranscriptEntry[], seq: number) {
  const windows = journal.filter(r => r.kind === 'sent' && r.seq === seq && typeof r.transcript_path === 'string' && Number.isFinite(r.transcript_size))
  return entries.filter(e => windows.some(w => e.path === w.transcript_path && e.offset >= w.transcript_size)).map(projectClaudeFailure)
}

export function emitFailureEvidence(scope: Record<string, unknown>, records: unknown[], emit = console.log) {
  emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, event: 'failure', records: records.length })))
  for (const record of records) emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, event: 'transcript', record })))
}

export async function captureFailureEvidence(agent: 'claude' | 'codex', root: string, scope: Record<string, unknown>, panes: string, emit = console.log) {
  emitFailureEvidence({ ...scope, agent }, await scenarioFailureRecords(root, agent), emit)
  let snapshots: unknown[] = []
  try { snapshots = readFileSync(panes, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { /* Missing panes remain explicit even when transcript capture succeeds. */ }
  for (const pane of snapshots.length ? snapshots : [{ unavailable: true }]) emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, agent, event: 'pane', pane })))
}

/** Called by the coordinator before deleting a failed job's container. The
 * coordinator's mask also knows the Codex login's original/refreshed tokens. */
export function retainFailureLine(output: string, line: string, redact: (value: string) => string, context: Record<string, unknown> = {}): boolean {
  if (!line.startsWith(AI_FAILURE_PREFIX)) return false
  const value = { ...JSON.parse(line.slice(AI_FAILURE_PREFIX.length)), ...context }
  const fd = openSync(join(output, 'real-agent-failures.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, redact(scrubDiagnosticText(JSON.stringify(value))) + '\n') }
  finally { closeSync(fd) }
  return true
}

if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    const [command, agent, root, scenario, trial, panes] = process.argv.slice(2)
    if (command === 'pane') {
      const value = JSON.parse(readFileSync(root!, 'utf8'))
      console.log(JSON.stringify({ key: diagnosticValue(scenario), ...projectFailurePane(value?.pane) }))
    } else if (command === 'capture' && (agent === 'claude' || agent === 'codex')) {
      await captureFailureEvidence(agent, root!, { scenario, trial }, panes!)
    } else throw new Error('Unknown diagnostic command')
  } catch {
    if (process.argv[2] === 'pane') console.log(JSON.stringify({ unavailable: true }))
    else emitFailureEvidence({ agent: diagnosticValue(process.argv[3]), scenario: diagnosticValue(process.argv[5]), unavailable: true }, [])
  }
}
