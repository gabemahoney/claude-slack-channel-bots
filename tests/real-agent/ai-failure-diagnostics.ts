/** Failure-only evidence. Never supplies an oracle answer or changes a wait. */
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'
import { taskNotificationFields } from './native-task-notification.ts'

export const AI_FAILURE_PREFIX = 'real-agent-failure-evidence: '
const sensitiveCredentialKey = /key|token|secret|password|credential/i
export function scrubDiagnosticText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = Object.entries(env).filter(([key, value]) => value && sensitiveCredentialKey.test(key)).map(([, value]) => value!)
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
const MAX_RETAINED_TEXT_CHARS = 4096
function retainedText(value: unknown): unknown {
  if (typeof value !== 'string') return diagnosticValue(value)
  // Scrub before bounding: slicing a credential first could hide its spelling
  // from both this scrubber and the coordinator's final redaction pass.
  const text = scrubDiagnosticText(value), suffix = '[truncated]'
  return text.length <= MAX_RETAINED_TEXT_CHARS ? text : text.slice(0, MAX_RETAINED_TEXT_CHARS - suffix.length) + suffix
}
const MAX_TOOL_INPUT_DEPTH = 4
const MAX_TOOL_INPUT_ENTRIES = 16
const MAX_TOOL_INPUT_NODES = 64
const MAX_TOOL_INPUT_JSON_CHARS = 16384
const MAX_RECORD_JSON_CHARS = 32768
const MAX_RECORD_BLOCKS = 32
function isSensitiveToolText(text: string): boolean {
  return sensitiveCredentialKey.test(text) || /authorization|cookie/i.test(text)
}
function retainedToolString(value: string): unknown {
  const scrubbed = scrubDiagnosticText(value)
  // Do not interpret shell quoting or partial assignments. Withhold the entire
  // credential-bearing string/key before a cut could hide its context.
  return isSensitiveToolText(scrubbed) ? '[REDACTED: credential-bearing string]' : retainedText(scrubbed)
}
function retainedToolInput(input: unknown): unknown {
  let remaining = MAX_TOOL_INPUT_NODES
  function project(value: unknown, depth: number, sensitive = false): unknown {
    if (remaining-- <= 0) return '[truncated]'
    // Hide a sensitive field's entire scalar/subtree before any serialization
    // or cut, including opaque credentials unknown to the environment scrubber.
    if (sensitive) return '[REDACTED]'
    if (typeof value === 'string') return retainedToolString(value)
    if (value === null || typeof value !== 'object') return diagnosticValue(value)
    if (depth >= MAX_TOOL_INPUT_DEPTH) return '[truncated]'
    const entries = Object.entries(value), kept: [string, unknown][] = []
    for (const [key, item] of entries.slice(0, MAX_TOOL_INPUT_ENTRIES)) {
      if (remaining <= 0) break
      const scrubbedKey = scrubDiagnosticText(key)
      kept.push([String(retainedToolString(scrubbedKey)), project(item, depth + 1, isSensitiveToolText(scrubbedKey))])
    }
    const limited = kept.length < entries.length
    return Array.isArray(value) ? [...kept.map(([, item]) => item), ...(limited ? ['[truncated]'] : [])]
      : Object.fromEntries([...kept, ...(limited ? [['[truncated]', true]] : [])])
  }
  // Preserve the existing textual scrub too, but fail closed if it damages JSON.
  const serialized = scrubDiagnosticText(JSON.stringify(project(input, 0)))
  if (serialized.length <= MAX_TOOL_INPUT_JSON_CHARS) {
    try { return JSON.parse(serialized) }
    catch { /* No preview: malformed redacted JSON has no safe retained text. */ }
  }
  return { truncated: true }
}
/** One aggregate cap covers metadata and every text/tool block together.
 * Keep whole scrubbed blocks in order; never slice serialized JSON. */
function boundedRecord(record: any, rawContent?: unknown): any {
  if (Array.isArray(rawContent) && rawContent.length > MAX_RECORD_BLOCKS) record.truncated = true
  const blocks = record.message?.content ?? record.payload?.content
  const size = () => {
    const serialized = JSON.stringify(record)
    return Math.max(serialized.length, scrubDiagnosticText(serialized).length)
  }
  if (size() > MAX_RECORD_JSON_CHARS) {
    record.truncated = true
    if (Array.isArray(blocks)) while (blocks.length && size() > MAX_RECORD_JSON_CHARS) blocks.pop()
    // Oversized metadata alone cannot bypass the shared bound.
    if (size() > MAX_RECORD_JSON_CHARS) return { truncated: true }
  }
  return record
}
function contentMetadata(content: unknown, assistant = false): unknown {
  if (!Array.isArray(content)) return typeof content === 'string' ? '<text withheld>' : diagnosticValue(content)
  return content.slice(0, MAX_RECORD_BLOCKS).map(b => ({ ...fields(b, ['type', 'id', 'name', 'tool_use_id', 'is_error']),
    ...(assistant && b?.type === 'text' ? { text: retainedText(b.text) } : {}),
    ...(assistant && b?.type === 'tool_use' && ['mcp__slack-channel-router__reply', 'mcp__slack-channel-router__edit_message'].includes(b.name)
      ? { input: Object.fromEntries(['chat_id', 'message_id', 'text'].filter(key => b.input?.[key] !== undefined)
        .map(key => [key, retainedText(b.input[key])])) } : {}),
    ...(assistant && b?.type === 'tool_use' && !['mcp__slack-channel-router__reply', 'mcp__slack-channel-router__edit_message'].includes(b.name)
      ? { input: retainedToolInput(b.input) } : {}) }))
}
/** Native notification linkage is metadata; summary/result/body text is never retained. */
export function notificationMetadata(content: unknown) {
  const notification = taskNotificationFields(content)
  return notification && Object.fromEntries(Object.entries(notification).map(([key, value]) => [key, diagnosticValue(value)]))
}
export function projectClaudeFailure(entry: TranscriptEntry) {
  const v = entry.value, m = v?.message
  return boundedRecord({ stream: basename(entry.path), sidechain: entry.path.includes('/subagents/'), offset: entry.offset,
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
    message: { ...fields(m, ['id', 'role', 'model', 'stop_reason']), ...errorFields(m),
      content: contentMetadata(m?.content, v?.type === 'assistant' && m?.role === 'assistant') } }, m?.content)
}
export function projectCodexFailure(entry: TranscriptEntry) {
  const v = entry.value, p = v?.payload
  return boundedRecord({ stream: basename(entry.path), offset: entry.offset, at: Number.isFinite(entry.at) ? entry.at : null,
    ...fields(v, identityFields), ...errorFields(v), payload: { ...fields(p, [...identityFields, 'id', 'role', 'model', 'turn_id', 'call_id', 'name',
      'status', 'decision', 'approval', 'request_id', 'thread_id', 'parent_thread_id']), ...errorFields(p), content: contentMetadata(p?.content) } }, p?.content)
}
/** Only AD contract fields leave the container. Native pane text is never read. */
export function projectFailureState(row: unknown) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { unavailable: true }
  const value = row as Record<string, unknown>
  const state = ['pending', 'waiting', 'working', 'ask_user', 'check_permission', 'ended', 'missing', 'paused'].includes(String(value.state)) ? value.state : 'unreadable'
  return { state, ...fields(value, ['family_state', 'transcript_status']) }
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
          records.push(boundedRecord({ ...((agent === 'claude' ? projectClaudeFailure : projectCodexFailure)(entry)), stream: relative(root, path).split('/').map(part => diagnosticValue(part)).join('/') }))
        } catch { records.push({ stream: diagnosticValue(basename(path)), offset, malformed: true }) }
      }
      offset += Buffer.byteLength(line) + 1
    }
  }
  return records
}

/** All attempts/copies for the selected item, including late linked responses.
 * Bounded, scrubbed assistant text and tool inputs accompany metadata. Reply
 * and edit inputs retain only destination/text fields. Prompts, config, login
 * files and tool results stay withheld. An absent send is never a pass. */
export function claudeFailureRecords(journal: any[], entries: TranscriptEntry[], seq: number) {
  const windows = journal.filter(r => r.kind === 'sent' && r.seq === seq && typeof r.transcript_path === 'string' && Number.isFinite(r.transcript_size))
  return entries.filter(e => windows.some(w => e.path === w.transcript_path && e.offset >= w.transcript_size)).map(projectClaudeFailure)
}

export function emitFailureEvidence(scope: Record<string, unknown>, records: unknown[], emit = console.log) {
  emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, event: 'failure', records: records.length })))
  for (const record of records) emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, event: 'transcript', record })))
}

export async function captureFailureEvidence(agent: 'claude' | 'codex', root: string, scope: Record<string, unknown>, states: string, emit = console.log) {
  emitFailureEvidence({ ...scope, agent }, await scenarioFailureRecords(root, agent), emit)
  let snapshots: unknown[] = []
  try { snapshots = readFileSync(states, 'utf8').split('\n').filter(Boolean).map(line => {
    const value = JSON.parse(line)
    return { ...projectFailureState(value), ...fields(value, ['key', 'instance']) }
  }) }
  catch { /* Missing AD state remains explicit even when transcript capture succeeds. */ }
  for (const state of snapshots.length ? snapshots : [{ unavailable: true }]) emit(AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ ...scope, agent, event: 'ad-state', state })))
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
    const [command, agent, root, scenario, trial, states] = process.argv.slice(2)
    if (command === 'state') {
      const value = JSON.parse(readFileSync(root!, 'utf8'))
      console.log(JSON.stringify({ key: diagnosticValue(scenario), ...projectFailureState(value) }))
    } else if (command === 'capture' && (agent === 'claude' || agent === 'codex')) {
      await captureFailureEvidence(agent, root!, { scenario, trial }, states!)
    } else throw new Error('Unknown diagnostic command')
  } catch {
    if (process.argv[2] === 'state') console.log(JSON.stringify({ unavailable: true }))
    else emitFailureEvidence({ agent: diagnosticValue(process.argv[3]), scenario: diagnosticValue(process.argv[5]), unavailable: true }, [])
  }
}
