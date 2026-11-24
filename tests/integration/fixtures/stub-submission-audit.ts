/** Fixture records, never pane contents or agent readiness. */
import { createHash } from 'node:crypto'

export interface QueueRow {
  kind: string; seq: number; compact?: string; parts?: string[]; channel?: string; ts?: string
  sender?: string; reminder_for?: unknown; part?: number; attempt?: number; send_kind?: string; at?: number; released_at?: number
  hold?: { on: 'memory' | 'post'; root_unknown?: boolean }
}
export interface HookRecord {
  command: string; text_hash?: string; at?: string; instance_id?: string; session_id?: string
}
export interface SubmissionIssue {
  reason: string; identity: string; at: string; matches: { seq: number; part: number; sent: QueueRow[] }[]
}
export function textHash(text: string): string { return createHash('sha256').update(text).digest('hex') }

function identities(queue: QueueRow[]) {
  queue = [...new Map(queue.map(row => [JSON.stringify(row), row])).values()]
  const accepted = new Set(queue.filter(r => r.kind === 'accepted' && !r.compact).map(r => r.seq))
  const parts = new Map<string, { identity: string; seq: number; part: number; sent: QueueRow[] }>()
  for (const row of queue) if (row.kind === 'fixed' && accepted.has(row.seq)) {
    row.parts?.forEach((text, i) => {
      const identity = textHash(text), key = `${row.seq}:${i + 1}:${identity}`
      parts.set(key, { identity, seq: row.seq, part: i + 1,
        sent: queue.filter(r => r.kind === 'sent' && r.seq === row.seq) })
    })
  }
  return [...parts.values()]
}
export function auditSubmissions(queue: QueueRow[], hooks: HookRecord[]): SubmissionIssue[] {
  const parts = identities(queue), submitted = hooks.filter(r => r.command === 'submitted')
  const mapped = submitted.map(row => ({ row,
    matches: parts.filter(p => p.identity === row.text_hash).map(({ identity: _, ...part }) => part) }))
  const counts = new Map<string, number>()
  for (const { matches } of mapped) if (matches.length === 1) {
    const key = `${matches[0]!.seq}:${matches[0]!.part}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return mapped.flatMap(({ row, matches }) => {
    const reason = matches.length !== 1 ? (matches.length ? 'ambiguous' : 'unmatched') :
      counts.get(`${matches[0]!.seq}:${matches[0]!.part}`)! > 1 ? 'duplicate' : undefined
    return reason ? [{ reason, identity: row.text_hash ?? 'absent', at: row.at ?? 'absent', matches }] : []
  })
}
function unfinishedAccepted(queue: QueueRow[], receipts: HookRecord[], parts: ReturnType<typeof identities>): QueueRow[] {
  const accepted = [...new Map(queue.filter(r => r.kind === 'accepted' && !r.compact).map(r => [r.seq, r])).values()]
  return accepted.filter(item => {
    const facts = queue.filter(r => r.seq === item.seq)
    if (facts.some(r => ['withdrawn', 'abandoned', 'hold-withdrawn'].includes(r.kind))) return false
    const hold = item.hold
    const resolved = facts.some(r => ['released', 'fixed', 'sent', 'delivered'].includes(r.kind) ||
      (r.kind === 'accepted' && r.released_at !== undefined))
    // Unresolved Memory Holds (including parked unknown-root Post Holds) do
    // not occupy FIFO. An unresolved Post Hold still blocks later work.
    if (hold && !resolved && (hold.on === 'memory' ||
      (hold.root_unknown && facts.some(r => r.kind === 'parked')))) return false
    const fixed = facts.find(r => r.kind === 'fixed')
    if (!fixed) return true // Preparation has not completed; the item is still unfinished.
    return parts.filter(p => p.seq === item.seq).some(p =>
      !receipts.some(h => h.text_hash === p.identity) &&
      !facts.some(r => r.kind === 'delivered' && r.part === p.part))
  }).sort((a, b) => a.seq - b.seq)
}
export function pairReceipt(queue: QueueRow[], hooks: HookRecord[], target?: { channel: string; ts: string }): HookRecord | undefined {
  const submitted = hooks.filter(r => r.command === 'submitted'), receipts = hooks.filter(r => r.command === 'receipt')
  // Check all submission identities even when older accepted rows compacted.
  if (submitted.some((r, i) => submitted.findIndex(s => s.text_hash === r.text_hash) !== i)) {
    throw new Error('already-receipted-or-duplicate submission')
  }
  const duplicates = auditSubmissions(queue, hooks).filter(issue => issue.reason === 'duplicate')
  if (duplicates.length) throw Object.assign(new Error('duplicate accepted item submission'), { issues: duplicates })
  const held = submitted.find(row => !receipts.some(receipt => receipt.text_hash === row.text_hash))
  if (!held) return undefined
  const parts = identities(queue), matches = parts.filter(p => p.identity === held.text_hash)
  if (matches.length !== 1) throw new Error('text-matching-no-unique-accepted-item')
  const wanted = target ? queue.filter(r => r.kind === 'accepted' && !r.compact && r.channel === target.channel && r.ts === target.ts) :
    unfinishedAccepted(queue, receipts, parts).slice(0, 1)
  if (new Set(wanted.map(r => r.seq)).size !== 1 || !wanted.some(r => r.seq === matches[0]!.seq)) {
    throw Object.assign(new Error('not-yet-released item held instead of requested item'), {
      issues: [{ reason: 'not-yet-released', identity: held.text_hash, at: held.at,
        matches: matches.map(({ identity: _, ...part }) => part) }],
    })
  }
  return held
}

const safe = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value :
  typeof value === 'string' && /^[A-Za-z0-9_.:+-]{1,64}$/.test(value) && !/(?:xox|xapp-)/.test(value) ? value : 'invalid'
export function formatSubmissionIssues(issues: SubmissionIssue[]): string[] {
  return issues.map(row => 'stub-submission-audit: ' + JSON.stringify({ reason: safe(row.reason), identity: safe(row.identity), at: safe(row.at),
    matches: row.matches.map(m => ({ seq: safe(m.seq), part: safe(m.part), sent: m.sent.map(s => ({
      attempt: safe(s.attempt), send_kind: safe(s.send_kind), at: safe(s.at),
    })) })) }))
}

async function runAudit(): Promise<void> {
  const { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } = await import('node:fs')
  const { join, resolve, sep } = await import('node:path')
  if (!existsSync('/etc/cscb-ci-image')) throw new Error('submission audit requires CI image')
  const [key, bin, ...paths] = process.argv.slice(2)
  const root = realpathSync(process.env.SCENARIO_ROOT!)
  const fenced = (path: string) => {
    if (!resolve(path).startsWith(root + sep) || !realpathSync(path).startsWith(root + sep) || lstatSync(path).isSymbolicLink()) {
      throw new Error('submission audit path outside scratch')
    }
    return path
  }
  const rows = (path: string) => {
    const text = readFileSync(fenced(path), 'utf8')
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  const queue: QueueRow[] = paths.filter(path => existsSync(path)).flatMap(rows)
  const hooks: HookRecord[] = readdirSync(fenced(bin!)).filter(name => /^stub-claude-hooks\.[a-f0-9-]{36}\.jsonl$/.test(name))
    .flatMap(name => rows(join(bin!, name))).filter(row => row.instance_id === `cscb_${key}`)
  const issues = auditSubmissions(queue, hooks)
  for (const line of formatSubmissionIssues(issues)) console.error(line)
  process.exitCode = issues.length ? 1 : 0
}

/** Complete fixture observations in the script log, independent of the collector.
 * Free text and unknown fields remain redacted; fixed parts keep their exact
 * SHA-256 identities so the log can still associate them with submissions. */
function invalidEvidence(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined'
  return `invalid:sha256:${textHash(text)}:bytes:${Buffer.byteLength(text)}`
}
function evidenceWord(value: unknown, redact: (text: string) => string): unknown {
  return (typeof value !== 'string' || redact(value) === value) && safe(value) !== 'invalid' ? value : invalidEvidence(value)
}
const controlCommand = /^(?:subagent|main-agent|receipt|receipt-only|receipt:[a-f0-9]{64}|stop|(?:permission|complete|fallback)-[12])$/
export function fixtureEvidenceRow(value: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> {
  const metadata = new Set(['v', 'kind', 'seq', 'compact', 'source', 'channel', 'channel_type', 'ts', 'user', 'sender',
    'via', 'key', 'received_at', 'released_at', 'delivered_at', 'item_id', 'reminder_for', 'part', 'attempt', 'send_kind',
    'at', 'receipt', 'session_id', 'transcript_path', 'transcript_size', 'unknown_outcome', 'quarantine', 'hold',
    'thread_ts', 'thread_join', 'attempt_high_watermark', 'reason', 'failed_condition', 'command', 'event',
    'instance_id', 'pid', 'text_hash'])
  const scrub = (field: unknown): unknown => typeof field === 'string' ?
    (redact(field) === field ? field : invalidEvidence(field)) : Array.isArray(field) ? field.map(scrub) :
    field && typeof field === 'object' ? Object.fromEntries(Object.entries(field).map(([key, value]) => [redact(key), scrub(value)])) : field
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (key === 'parts' && Array.isArray(field)) return [key, field.map(text => typeof text === 'string'
      ? { text_hash: textHash(text), bytes: Buffer.byteLength(text) } : invalidEvidence(text))]
    if (key === 'text' && typeof field === 'string') return [key, { text_hash: textHash(field), bytes: Buffer.byteLength(field) }]
    if (!metadata.has(key)) return [redact(key), invalidEvidence(field)]
    if (['kind', 'command', 'event', 'send_kind'].includes(key)) return [key, evidenceWord(field, redact)]
    // Redact string values before JSON encoding, including nested metadata.
    return [key, scrub(field)]
  }))
}
async function runEvidence(): Promise<void> {
  const { existsSync, readFileSync, realpathSync, lstatSync } = await import('node:fs')
  const { basename, resolve, sep } = await import('node:path')
  const [mode, requestedRoot, alpha, bravo, ...paths] = process.argv.slice(2)
  if (mode !== 'evidence') throw new Error('invalid evidence mode')
  const root = realpathSync(requestedRoot!)
  const pkg = process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'
  const { redactSlackLogText } = await import(pkg + '/src/slack-log-redaction.ts')
  for (const path of paths) {
    if (!existsSync(path)) continue // unmatched shell glob
    try {
      if (!resolve(path).startsWith(root + sep) || !realpathSync(path).startsWith(root + sep) ||
        lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('invalid evidence path')
      const file = evidenceWord(basename(path), redactSlackLogText), text = readFileSync(path, 'utf8')
      const lines = text.split('\n')
      for (const [index, line] of lines.entries()) {
        if (!line && index === lines.length - 1) continue
        let value: unknown
        if (basename(path).startsWith('stub-claude-hooks.') && !path.endsWith('.jsonl')) {
          value = { control: controlCommand.test(line) && redactSlackLogText(line) === line ? line : invalidEvidence(line) }
        } else {
          try {
            const row = JSON.parse(line)
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid row')
            if (basename(path).startsWith('stub-claude-hooks.') && row.instance_id !== alpha && row.instance_id !== bravo) continue
            value = fixtureEvidenceRow(row, redactSlackLogText)
          } catch { value = { incomplete_or_invalid: true, text_hash: textHash(line), bytes: Buffer.byteLength(line) } }
        }
        console.log('exit-observe: evidence ' + JSON.stringify({ file, line: index + 1, terminated: index < lines.length - 1, value }))
      }
    } catch { console.log('exit-observe: evidence file=unreadable') }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] === 'evidence') {
      const { existsSync } = await import('node:fs')
      if (!existsSync('/etc/cscb-ci-image')) throw new Error('evidence requires CI image')
      await runEvidence()
    } else await runAudit()
  }
  catch {
    console.error('FAIL: stub-submission-audit: unreadable or invalid fixture evidence')
    process.exitCode = 1
  }
}
