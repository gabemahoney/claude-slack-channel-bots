/** Failure-only evidence. Never supplies an oracle answer or changes a wait. */
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'

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

export function projectClaudeFailure(entry: TranscriptEntry) {
  const v = entry.value, m = v?.message
  const metadata = Object.fromEntries(['type', 'subtype', 'uuid', 'parentUuid', 'sessionId', 'requestedModel', 'isMeta', 'isApiErrorMessage', 'error', 'isSynthetic', 'refusedUserMessageUuid']
    .map(key => [key, diagnosticValue(v?.[key])]))
  return { offset: entry.offset, at: Number.isFinite(entry.at) ? entry.at : null, ...metadata,
    message: { id: diagnosticValue(m?.id), role: diagnosticValue(m?.role), model: diagnosticValue(m?.model), stop_reason: diagnosticValue(m?.stop_reason),
      content: Array.isArray(m?.content) ? m.content.map((b: any) => ({ type: diagnosticValue(b?.type),
        ...(b?.type === 'tool_use' ? { name: diagnosticValue(b.name), ...(b.name === 'mcp__slack-channel-router__reply' && typeof b.input?.text === 'string' ? { reply: scrubDiagnosticText(b.input.text) } : {}) } : {}),
        ...(v?.type === 'assistant' && b?.type === 'text' && typeof b.text === 'string' ? { text: scrubDiagnosticText(b.text) } : {}),
      })) : diagnosticValue(m?.content) } }
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

/** Called by the coordinator before deleting a failed job's container. The
 * coordinator's mask also knows the Codex login's original/refreshed tokens. */
export function retainFailureLine(output: string, line: string, redact: (value: string) => string): boolean {
  if (!line.startsWith(AI_FAILURE_PREFIX)) return false
  const value = JSON.parse(line.slice(AI_FAILURE_PREFIX.length))
  const fd = openSync(join(output, 'ai-failures.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, redact(scrubDiagnosticText(JSON.stringify(value))) + '\n') }
  finally { closeSync(fd) }
  return true
}

if (import.meta.main) {
  // This is invoked by the scenario EXIT hook after the native processes stop,
  // but before their isolated HOME is removed. It never reads Codex auth.
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    const [state, key, root, sequence, criterion, trial] = process.argv.slice(2)
    const receipts = await import('../integration/fixtures/transcript-receipts.ts')
    const journal = receipts.receiptJournal(state!, key!)
    const last = Math.max(0, ...journal.filter(r => r.kind === 'accepted').map(r => r.seq))
    const seq = Math.min(Number(sequence) || last, last)
    const adapters = await receipts.packedReceiptAdapters()
    const entries = receipts.readTranscripts(receipts.transcriptFiles(root!), adapters, true)
    emitFailureEvidence({ agent: 'claude', criterion, trial, seq }, claudeFailureRecords(journal, entries, seq))
  } catch { emitFailureEvidence({ agent: 'claude', criterion: process.argv[6], trial: process.argv[7], unavailable: true }, []) }
}
