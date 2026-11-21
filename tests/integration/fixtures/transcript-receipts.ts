/** Executable evidence adapter for real scenarios (b.omv SR-14.1).
 * Legacy take-ins use the installed tarball's parser and exact matcher.
 * Covered take-ins use AD's documented Claude wrapper, only in this audit.
 * Importing this helper performs no I/O; CLI entry points require the CI image.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface TranscriptEntry { path: string; offset: number; at: number; value: any; kind: string; text?: string; uuid?: string }
export interface TokenTotals { input: number; output: number; cache_read: number; cache_creation: number }
export interface ReceiptAdapters {
  receiptTextMatches(record: string, expected: string): boolean
  parseDeliveryTranscriptRecord(agent: 'claude', value: unknown): { kind: string; text?: string; uuid?: string }
}
export async function packedReceiptAdapters(pkg = process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'): Promise<ReceiptAdapters> {
  if (!existsSync('/etc/cscb-ci-image')) throw new Error('transcript-receipts requires the CI image')
  return import(join(resolve(pkg), 'src/delivery-receipt.ts'))
}
export function jsonLines(path: string): any[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
/** Scenario ordinals count original inputs, not the reminders allocated between
 * them. Use the cumulative receipt journal so recovery cannot renumber inputs.
 * This selection never filters the journal used for receipt/FIFO assertions. */
export function workloadItems(journal: readonly any[]): any[] {
  return journal.filter(r => r.kind === 'accepted' && !r.compact && r.reminder_for === undefined)
    .sort((a, b) => a.seq - b.seq)
}
export function workloadItem(journal: readonly any[], ordinal: number): any {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('Invalid workload ordinal')
  const item = workloadItems(journal)[ordinal - 1]
  if (!item) throw new Error(`Workload item ${ordinal} has not been accepted`)
  return item
}
function queuePath(stateDir: string, key: string): string {
  if (!/^[a-z0-9_]+$/.test(key)) throw new Error('Invalid receipt persona key')
  return join(stateDir, 'queue', `${key}.jsonl`)
}
/** Preserve observations of the real durable journal before recovery replaces
 * it. This private scenario evidence is never read by CSCB or written into its
 * queue. Keep every distinct record: attempts and multipart receipts matter.
 */
export function captureReceiptJournal(stateDir: string, key: string): any[] {
  const current = jsonLines(queuePath(stateDir, key))
  const directory = join(stateDir, 'receipt-history'), path = join(directory, `${key}.jsonl`)
  const prior = existsSync(path) ? jsonLines(path) : []
  const records = new Map(prior.map(record => [JSON.stringify(record), record]))
  for (const record of current) if (!(record.kind === 'accepted' && record.compact)) records.set(JSON.stringify(record), record)
  if (records.size !== prior.length) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, [...records.keys()].join('\n') + '\n', { mode: 0o600 })
    renameSync(temp, path)
  }
  return current
}
export function captureReceiptJournals(stateDir: string): void {
  const directory = join(stateDir, 'queue')
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) if (name.endsWith('.jsonl')) captureReceiptJournal(stateDir, basename(name, '.jsonl'))
}
/** A current full item always owns its state. Restore historical records only
 * for an item the current journal proves was compacted, and only if the
 * observed durable records prove every part completed. A compact:key marker
 * alone is insufficient, and allocation never invents an injected item.
 */
export function receiptJournal(stateDir: string, key: string): any[] {
  const current = captureReceiptJournal(stateDir, key)
  const path = join(stateDir, 'receipt-history', `${key}.jsonl`)
  const history = existsSync(path) ? jsonLines(path) : []
  const full = new Set(current.filter(r => r.kind === 'accepted' && !r.compact).map(r => r.seq))
  const compact = current.filter(r => r.kind === 'accepted' && r.compact === 'key')
  const allocation = Math.max(0, ...current.filter(r => r.kind === 'accepted' && r.compact === 'allocation').map(r => r.seq))
  const highest = Math.max(allocation, 0, ...current.filter(r => r.kind === 'accepted').map(r => r.seq))
  if (!Number.isSafeInteger(highest) || highest < 0) throw new Error('Invalid queue allocation evidence')
  const restored: any[] = []
  for (let seq = 1; seq <= highest; seq++) {
    if (full.has(seq)) continue
    const marker = compact.find(r => r.seq === seq)
    if (!marker && seq > allocation) throw new Error(`Item ${seq} has no compaction evidence`)
    const records = history.filter(r => r.seq === seq)
    const accepts = records.filter(r => r.kind === 'accepted' && !r.compact)
    const accepted = accepts[0], fixed = records.find(r => r.kind === 'fixed')
    const identity = (r: any) => JSON.stringify({ ...r, attempt_high_watermark: undefined })
    if (!accepted || accepts.some(r => identity(r) !== identity(accepted))) throw new Error(`Compacted item ${seq} has no unambiguous observed acceptance`)
    if (!fixed?.parts?.length || records.filter(r => r.kind === 'fixed').some(r => JSON.stringify(r) !== JSON.stringify(fixed))) throw new Error(`Compacted item ${seq} has no unambiguous observed fixed parts`)
    const delivered = fixed.parts.map((_: string, i: number) => records.find(r => r.kind === 'delivered' && r.part === i + 1))
    if (delivered.some((r: any) => !r || !Number.isFinite(r.at))) throw new Error(`Compacted item ${seq} has no observed durable completion`)
    const slackIdentity = (r: any) => JSON.stringify([r?.chat_id, r?.ts, r?.edited_ts ?? null])
    if (marker && (accepted.source !== 'slack' || slackIdentity(marker.key) !== slackIdentity(accepted.key)
      || marker.received_at !== accepted.received_at || marker.delivered_at !== Math.max(...records.filter(r => r.kind === 'delivered').map(r => r.at)))) throw new Error(`Compacted key ${seq} disagrees with observed durable completion`)
    // Accept metadata may gain an attempt watermark across recovery. Include
    // one canonical acceptance without duplicating the logical item.
    restored.push(accepted, ...records.filter(r => r.kind !== 'accepted'))
  }
  return [...current, ...restored].sort((a, b) => a.seq - b.seq)
}
export function transcriptFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return []
    const path = join(root, entry.name)
    if (entry.isDirectory()) return transcriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  })
}
export function readTranscripts(paths: readonly string[], adapters: ReceiptAdapters, allowIncompleteTail = false): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const path of [...new Set(paths)]) {
    if (!statSync(path).isFile()) throw new Error('Transcript is not a regular file')
    let offset = 0
    const contents = readFileSync(path, 'utf8'), lines = contents.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line) {
        let value: any
        try { value = JSON.parse(line) } catch (error) {
          if (allowIncompleteTail && index === lines.length - 1 && !contents.endsWith('\n')) break
          throw error
        }
        // Subagent transcripts contribute usage, but cannot take in a
        // parent persona's item even if a subagent quotes its whole tag.
        const parsed = path.includes('/subagents/') ? { kind: 'other' } : adapters.parseDeliveryTranscriptRecord('claude', value)
        const at = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(value.timestamp ?? '')
        entries.push({ path, offset, at, value, ...parsed })
      }
      offset += Buffer.byteLength(line) + 1
    }
  }
  return entries.sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0) || a.path.localeCompare(b.path) || a.offset - b.offset)
}
/** Sum unique assistant messages' usage; repeated streaming records update,
 * rather than multiply, the same message ID's final usage. */
export function transcriptTokens(entries: readonly TranscriptEntry[]): TokenTotals {
  const messages = new Map<string, TokenTotals>()
  for (const e of entries) {
    const usage = e.value?.message?.usage
    if (!usage) continue
    const id = e.value.message.id ?? e.uuid ?? `${e.path}:${e.offset}`
    messages.set(id, {
      input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0, cache_creation: usage.cache_creation_input_tokens ?? 0,
    })
  }
  return [...messages.values()].reduce((sum, u) => ({ input: sum.input + u.input, output: sum.output + u.output,
    cache_read: sum.cache_read + u.cache_read, cache_creation: sum.cache_creation + u.cache_creation }),
  { input: 0, output: 0, cache_read: 0, cache_creation: 0 })
}
/** Decode only bash printf %q's word language; no eval, expansions or commands. */
export function shimWords(input: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < input.length) {
    while (input[i] === ' ') i++
    if (i === input.length) break
    let word = ''
    if (input.startsWith("$'", i)) {
      i += 2
      const chunks: Buffer[] = []
      let literal = ''
      const flush = () => { if (literal) { chunks.push(Buffer.from(literal, 'utf8')); literal = '' } }
      while (i < input.length && input[i] !== "'") {
        if (input[i] !== '\\') { literal += input[i++]; continue }
        flush()
        const escape = input[++i]!
        i++
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' }
        if (escape in simple) chunks.push(Buffer.from(simple[escape]!))
        else if (/[0-7]/.test(escape)) { const tail = input.slice(i).match(/^[0-7]{0,2}/)![0]; chunks.push(Buffer.from([parseInt(escape + tail, 8)])); i += tail.length }
        else if (escape === 'x' || escape === 'u' || escape === 'U') {
          const max = escape === 'x' ? 2 : escape === 'u' ? 4 : 8
          const hex = input.slice(i).match(new RegExp(`^[0-9a-fA-F]{1,${max}}`))?.[0]
          if (!hex) throw new Error('Invalid quoted shim escape')
          chunks.push(escape === 'x' ? Buffer.from([parseInt(hex, 16)]) : Buffer.from(String.fromCodePoint(parseInt(hex, 16)))); i += hex.length
        } else throw new Error('Unsupported quoted shim escape')
      }
      flush()
      word = Buffer.concat(chunks).toString('utf8')
      if (input[i++] !== "'") throw new Error('Unclosed shim quote')
    } else if (input.startsWith("''", i)) i += 2
    else {
      while (i < input.length && input[i] !== ' ') {
        if (input[i] === '\\') { i++; if (i === input.length) throw new Error('Trailing shim escape'); word += input[i++] }
        else { if (/[`$'";]/.test(input[i]!)) throw new Error('Unquoted shell syntax in shim log'); word += input[i++] }
      }
    }
    result.push(word)
    if (i < input.length && input[i] !== ' ') throw new Error('Malformed shim word boundary')
  }
  return result
}
export interface ShimSend { at: number; text: string; words: string[]; instanceId?: string }
/** The unterminated tail of a captured append may still be being written. */
export function completeShimLog(log: string): string {
  return log.slice(0, log.lastIndexOf('\n') + 1)
}
export function readShimLog(path: string): string {
  return completeShimLog(readFileSync(path, 'utf8'))
}
function argument(words: readonly string[], flag: string): string | undefined {
  const index = words.indexOf(flag)
  return index >= 0 ? words[index + 1] : words.find(w => w.startsWith(flag + '='))?.slice(flag.length + 1)
}
export function shimSends(log: string): ShimSend[] {
  return log.split('\n').filter(Boolean).flatMap(line => {
    const fields = line.split('\t')
    if (fields[0] !== 'call') return []
    if (fields.length !== 6) throw new Error('Malformed shim record')
    const words = shimWords(fields[5]!)
    let verb = 0
    while (['--store-path', '--home', '--tmux-command', '--create-if-missing'].some(flag => words[verb] === flag || words[verb]?.startsWith(flag + '='))) verb += words[verb]!.includes('=') ? 1 : 2
    const text = argument(words, '--text')
    if (words[verb] !== 'send-keys' || text === undefined) return []
    return [{ at: Number(fields[1]) * 1000, text, words, instanceId: argument(words, '--instance-id') }]
  })
}
/** Session ownership comes from this persona's durable attempts and engine
 * observations, never from a delivered record pointing at an arbitrary file.
 * Session IDs survive resume, and each new launch adds its own identity. */
export function personaTranscripts(key: string, journal: readonly any[], log: readonly string[], entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const sessions = new Set<string>(), directories = new Set<string>()
  // Covered attempts have no transcript_path. Their independently recorded
  // conversation ID binds the native file and its embedded session identity;
  // a delivered record alone never establishes transcript ownership.
  const coveredSessions = new Set(journal.filter(r => r.kind === 'submitted' && r.instance_id === `cscb_${key}`
    && typeof r.session_id === 'string' && r.session_id).map(r => r.session_id))
  for (const record of journal) if (record.kind === 'sent' && !record.unknown_outcome) {
    if (record.session_id) sessions.add(record.session_id)
    if (typeof record.transcript_path === 'string' && record.transcript_path && basename(record.transcript_path, '.jsonl') === record.session_id) directories.add(dirname(resolve(record.transcript_path)))
  }
  for (const line of log) {
    const referenceMarker = '[slack] delivery-transcript-reference: '
    const referenceIndex = line.indexOf(referenceMarker)
    if (referenceIndex >= 0) {
      const reference = JSON.parse(line.slice(referenceIndex + referenceMarker.length))
      if (reference.key === key && reference.instance_id === `cscb_${key}` && sessions.has(reference.session_id) &&
        typeof reference.jsonl_path === 'string' && basename(reference.jsonl_path, '.jsonl') === reference.session_id) {
        directories.add(dirname(resolve(reference.jsonl_path)))
      }
    }
    const marker = '[slack] delivery-launch-observed: '
    const index = line.indexOf(marker)
    if (index < 0) continue
    const observation = JSON.parse(line.slice(index + marker.length))
    if (observation.key === key && typeof observation.session_id === 'string' && observation.session_id) sessions.add(observation.session_id)
  }
  return entries.filter(entry => {
    if (entry.path.includes('/subagents/')) return false
    const session = basename(entry.path, '.jsonl')
    if (coveredSessions.has(session) && entry.value?.sessionId === session &&
      (entry.value?.session_id === undefined || entry.value.session_id === session)) return true
    return sessions.has(session) && directories.has(dirname(resolve(entry.path)))
      && (entry.value?.sessionId === undefined || entry.value.sessionId === session)
  })
}
const jsonString = '"(?:[^"\\\\]|\\\\.)*"'
const diagnostic = new RegExp(`^\\[([^\\]]+)\\] \\[slack\\] (message-received|message-delivered): persona=(.*?) source=(slack|interject|cron) (chat_id|sender)=(${jsonString}) ts=(${jsonString}) sender_id=(${jsonString})(?: |$)`)
function diagnosticTime(log: readonly string[], kind: string, key: string, item: any): number {
  const matches = log.flatMap(line => {
    const match = line.match(diagnostic)
    if (!match || match[2] !== kind || !(match[3]!.endsWith(`(key=${key})`) || match[3] === `key=${key}`)
      || match[4] !== item.source || match[5] !== (item.source === 'slack' ? 'chat_id' : 'sender')
      || JSON.parse(match[6]!) !== (item.source === 'slack' ? item.channel ?? '' : item.sender ?? '')
      || JSON.parse(match[7]!) !== item.ts || JSON.parse(match[8]!) !== (item.user ?? item.bot_id ?? item.sender ?? 'unknown')) return []
    return [Date.parse(match[1]!)]
  })
  if (!matches.length || matches.some(at => !Number.isFinite(at) || at < 0)) throw new Error(`Item ${item.seq} has no valid ${kind} timestamp`)
  return Math.min(...matches)
}
export interface AuditOptions { stateDir: string; key: string; shimLog: string; transcripts: string[]; expectedCount?: number; noRetype?: boolean }
// AD 8e95f63a: internal/store/busy_send_capabilities.go:119-126,190-194;
// internal/hook/busy_send_claude.go:35-54. No trimming, guessed envelopes or
// decoding ambiguous escapes. This is test evidence, never agent state.
const claudeWakePrefix = '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "FileChanged": '
const claudeWakeSuffix = '\n</system-reminder>'
function coveredTexts(entry: TranscriptEntry): string[] {
  const v = entry.value
  if (v?.type !== 'user' || v.isSidechain === true || v.isMeta || v.message?.role !== 'user' ||
    v.origin?.kind !== 'task-notification' || v.origin?.producer !== 'session-task' || typeof v.message.content !== 'string') return []
  const text = v.message.content
  if (!text.startsWith(claudeWakePrefix) || !text.endsWith(claudeWakeSuffix)) return []
  const body = text.slice(claudeWakePrefix.length, -claudeWakeSuffix.length)
  if (['</system-reminder>', '&lt;/system-reminder>', '</task-notification>', '<\\/task-notification>'].some(tag => body.includes(tag))) return []
  const first = body.match(/^\[agent-director: message 1 of ([1-9]\d*)\]\n/)
  if (!first) return []
  const count = Number(first[1])
  // Every separator consumes bytes, bounding malicious counts by the body.
  if (!Number.isSafeInteger(count) || count > body.length) return []
  const texts: string[] = []
  let rest = body.slice(first[0].length)
  for (let n = 2; n <= count; n++) {
    const separator = `\n\n[agent-director: message ${n} of ${count}]\n`
    const at = rest.indexOf(separator)
    if (at < 0 || rest.indexOf(separator, at + 1) >= 0) return []
    texts.push(rest.slice(0, at)); rest = rest.slice(at + separator.length)
  }
  texts.push(rest)
  // An unexpected separator is an ambiguous batch, never a substring match.
  return texts.some(t => !t || /(?:^|\n\n)\[agent-director: message \d+ of \d+\]\n/.test(t)) ? [] : texts
}
function receiptTakes(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.flatMap(e => {
    const covered = coveredTexts(e)
    if (covered.length) return covered.map(text => ({ ...e, kind: 'covered-take-in', text }))
    return e.kind === 'take-in' && e.text !== undefined ? [e] : []
  })
}
function coveredPart(journal: readonly any[], seq: number, part: number, delivered: any): boolean {
  return delivered?.ad !== undefined || delivered?.receipt?.path === 'agent-director:get-delivery'
    || journal.some(r => r.kind === 'submitted' && r.seq === seq && r.part === part
      && !journal.some(other => other.kind === 'refused' && other.seq === seq && other.attempt === r.attempt))
}
function textMatches(e: TranscriptEntry, text: string, covered: boolean, adapters: ReceiptAdapters): boolean {
  return covered ? e.kind === 'covered-take-in' && e.text === text
    : e.kind === 'take-in' && adapters.receiptTextMatches(e.text!, text)
}
function durableCoveredReceipt(journal: readonly any[], key: string, delivered: any, take: TranscriptEntry): boolean {
  if (delivered?.receipt?.path !== 'agent-director:get-delivery' || typeof delivered.receipt.uuid !== 'string' || !delivered.receipt.uuid
    || typeof delivered.ad?.session_id !== 'string' || !delivered.ad.session_id
    || delivered.ad?.session_id !== take.value?.sessionId || basename(take.path, '.jsonl') !== delivered.ad.session_id) return false
  return journal.some(r => r.kind === 'submitted' && r.seq === delivered.seq && r.part === delivered.part
    && r.instance_id === `cscb_${key}` && r.session_id === delivered.ad.session_id && r.delivery_request_id === delivered.receipt.uuid
    && Number.isFinite(r.at) && take.at >= r.at
    && !journal.some(other => other.kind === 'refused' && other.seq === r.seq && other.attempt === r.attempt))
}
/** Only distinct original-workload parts with a durable, exact, own-session
 * take-in advance the functional watchdog. Retries, reminders and duplicates
 * cannot keep a stuck batch alive. Success still requires auditReceipts. */
export function receiptProgress(options: AuditOptions, entries: readonly TranscriptEntry[], adapters: ReceiptAdapters): number {
  const journal = receiptJournal(options.stateDir, options.key)
  const log = readFileSync(join(options.stateDir, 'server.log'), 'utf8').split('\n')
  const takes = receiptTakes(personaTranscripts(options.key, journal, log, entries))
  const used = new Set<number>()
  let completed = 0
  for (const item of workloadItems(journal)) {
    const fixed = journal.find(r => r.kind === 'fixed' && r.seq === item.seq)
    for (const [index, text] of (fixed?.parts ?? []).entries()) {
      const delivered = journal.find(r => r.kind === 'delivered' && r.seq === item.seq && r.part === index + 1)
      const covered = coveredPart(journal, item.seq, index + 1, delivered)
      const match = takes.findIndex((e, i) => !used.has(i) && e.at >= item.received_at && textMatches(e, text, covered, adapters)
        && (covered ? durableCoveredReceipt(journal, options.key, delivered, e) : e.path === delivered?.receipt?.path &&
          (delivered.receipt.uuid ? e.uuid === delivered.receipt.uuid : e.offset === delivered.receipt?.offset)))
      if (match >= 0 && (!covered || [...used].every(i => i < match))) { used.add(match); completed++ }
    }
  }
  return completed
}
/** How many of a part's shim text sends AD refused, so nothing was typed
 * (b.88t). A send counts only when it lies inside one refused attempt's
 * window: that attempt's durable `sent` text record (written before the keys)
 * at or before the send, and its `refused` record at or after it. Each refused
 * attempt accounts for at most one send; any other send stays typed. */
function refusedTextSends(journal: readonly any[], seq: number, part: number, typed: readonly ShimSend[]): number {
  const used = new Set<number>()
  for (const sent of journal) {
    if (sent.kind !== 'sent' || sent.seq !== seq || sent.part !== part || sent.send_kind !== 'text' || !Number.isFinite(sent.at)) continue
    const refused = journal.find(r => r.kind === 'refused' && r.seq === seq && r.attempt === sent.attempt)
    if (!refused || !Number.isFinite(refused.at)) continue
    const send = typed.findIndex((s, i) => !used.has(i) && s.at >= sent.at && s.at <= refused.at)
    if (send >= 0) used.add(send)
  }
  return used.size
}
export function auditReceipts(options: AuditOptions, entries: readonly TranscriptEntry[], adapters: ReceiptAdapters) {
  const journal = receiptJournal(options.stateDir, options.key)
  const accepted = journal.filter(r => r.kind === 'accepted' && !r.compact).sort((a, b) => a.seq - b.seq)
  // Scenario counts describe original Slack/cron/interject inputs; reminders still need full receipt/FIFO proof.
  const inputs = workloadItems(journal), reminders = accepted.filter(r => r.reminder_for !== undefined)
  if (!inputs.length || (options.expectedCount !== undefined && inputs.length !== options.expectedCount)) throw new Error('Accepted item count differs')
  const reminded = new Set<number>()
  for (const item of reminders) {
    const original = inputs.find(r => r.seq === item.reminder_for), fixed = journal.find(r => r.kind === 'fixed' && r.seq === original?.seq)
    if (item.source !== 'interject' || item.sender !== 'reply-reminder' || original?.source !== 'slack' || original.seq >= item.seq
      || reminded.has(original.seq) || !fixed?.parts?.length
      || !fixed.parts.every((_: unknown, i: number) => journal.some(r => r.kind === 'delivered' && r.seq === original.seq && r.part === i + 1 && r.at <= item.received_at))) throw new Error('Invalid reply reminder provenance')
    reminded.add(original.seq)
  }
  const log = readFileSync(join(options.stateDir, 'server.log'), 'utf8').split('\n')
  const ownEntries = personaTranscripts(options.key, journal, log, entries)
  const takes = receiptTakes(ownEntries)
  const sends = shimSends(readShimLog(options.shimLog)).filter(s => s.instanceId === `cscb_${options.key}`)
  let previousAppearance = -1, previousDelivered = -Infinity, duplicates = 0
  const timings: { seq: number; typing_ms: number; delivery_ms: number }[] = []
  for (const item of accepted) {
    // Internal acceptance bypasses Slack intake's received diagnostic.
    const receivedAt = item.reminder_for === undefined ? diagnosticTime(log, 'message-received', options.key, item) : item.received_at
    if (!Number.isFinite(receivedAt) || receivedAt < 0) throw new Error('Invalid reminder acceptance timestamp')
    const loggedAt = diagnosticTime(log, 'message-delivered', options.key, item)
    const fixed = journal.find(r => r.seq === item.seq && r.kind === 'fixed')
    if (!fixed?.parts?.length) throw new Error(`Item ${item.seq} has no fixed parts`)
    let firstTyped = Infinity, partDelivered = previousDelivered
    for (let part = 1; part <= fixed.parts.length; part++) {
      const text = fixed.parts[part - 1]
      const delivered = journal.find(r => r.seq === item.seq && r.kind === 'delivered' && r.part === part)
      const covered = coveredPart(journal, item.seq, part, delivered)
      const matches = takes.flatMap((r, i) => textMatches(r, text, covered, adapters) && r.at >= item.received_at ? [i] : [])
      if (!matches.length) throw new Error(`Item ${item.seq} part ${part} has no exact transcript receipt`)
      const first = matches[0]!
      if (first <= previousAppearance) throw new Error(`Item ${item.seq} first appearance is out of accept order`)
      previousAppearance = first
      duplicates += matches.length - 1
      if (!delivered) throw new Error(`Item ${item.seq} part ${part} is still open`)
      const receipt = covered ? undefined : takes.find(r => r.kind === 'take-in' && r.path === delivered.receipt?.path &&
        (delivered.receipt.uuid ? r.uuid === delivered.receipt.uuid : r.offset === delivered.receipt?.offset))
      const validReceipt = covered ? durableCoveredReceipt(journal, options.key, delivered, takes[first]!)
        : receipt && adapters.receiptTextMatches(receipt.text!, text)
      if (!validReceipt) throw new Error('Durable receipt does not identify matching take-in')
      const typed = sends.filter(s => s.text === text)
      if (!typed.length) throw new Error(`Item ${item.seq} part ${part} has no shim send`)
      if (typed.some(s => !Number.isFinite(s.at) || s.at < receivedAt)) throw new Error('Missing, invalid or negative typing measurement')
      if (typed.some(s => s.at < partDelivered)) throw new Error('Successor send preceded prior receipt/delivery log')
      if (options.noRetype && typed.length - refusedTextSends(journal, item.seq, part, typed) !== 1) throw new Error('Text fidelity case retyped')
      if (options.noRetype && matches.length !== 1) throw new Error('Text fidelity case taken in more than once')
      if (options.noRetype && journal.some(r => r.kind === 'sent' && r.seq === item.seq && r.part === part && r.send_kind === 'enter')) {
        throw new Error('Text fidelity case needed Enter-only recovery')
      }
      firstTyped = Math.min(firstTyped, typed[0]!.at)
      if (!Number.isFinite(delivered.at)) throw new Error('Invalid durable delivery timestamp')
      partDelivered = delivered.at
    }
    if (loggedAt < firstTyped || loggedAt < receivedAt) throw new Error('Negative or inconsistent delivery measurement')
    previousDelivered = loggedAt
    if (item.reminder_for === undefined) timings.push({ seq: item.seq, typing_ms: firstTyped - receivedAt, delivery_ms: loggedAt - receivedAt })
  }
  return { items: inputs.length, reminders: reminders.length, duplicates, tokens: transcriptTokens(ownEntries), timings }
}
/** The `recorded: receipts` line every full receipt audit command prints. */
export function receiptsRecord(result: { items: number; reminders: number; timings: unknown[] }, transcripts: number): string {
  return `recorded: receipts ${JSON.stringify({ items: result.items, reminders: result.reminders, transcripts, timings: result.timings })}`
}
export function percentile(values: number[], quantile: number): number {
  if (!values.length) throw new Error('No latency samples')
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]!
}
export const THREAD_N2_MIN_SAMPLES = 20
export const THREAD_N2_TYPING_MS = 2_000
export const THREAD_N2_DELIVERY_MS = 10_000
export interface ThreadLatencyOptions {
  key: string; channel: string; samples: string[]; delayed: string; hung: string
  scenario: string; mode: 'strict' | 'open'
}
/** Project actual shared_queue_snapshot observations onto the explicitly named
 * N2 workload. Completion is the latest durable part receipt, never a poll's
 * return time. concurrent-overlap separately binds these rows to the N2 verdict.
 */
export function threadSampleIntervals(key: string, channel: string, samples: readonly string[], journal: readonly any[]): string {
  if (!/^[a-z0-9_]+$/.test(key) || !samples.length || new Set(samples).size !== samples.length) throw new Error('Invalid thread interval selection')
  return samples.map(ts => {
    const accepted = workloadItems(journal).filter(r => r.source === 'slack' && r.channel === channel && r.ts === ts
      && r.key?.chat_id === channel && r.key?.ts === ts && r.key?.edited_ts === undefined)
    const item = accepted[0], fixed = journal.filter(r => r.kind === 'fixed' && r.seq === item?.seq)
    if (accepted.length !== 1 || item.via !== 'thread' || !Number.isSafeInteger(item.seq) || item.seq < 1
      || !Number.isFinite(item.received_at) || item.received_at < 0 || fixed.length !== 1 || !fixed[0].parts?.length)
      throw new Error('Missing thread interval acceptance/fixation')
    const completed = fixed[0].parts.map((_: unknown, i: number) => {
      const rows = journal.filter(r => r.kind === 'delivered' && r.seq === item.seq && r.part === i + 1)
      if (rows.length !== 1 || !Number.isFinite(rows[0].at) || rows[0].at < item.received_at)
        throw new Error('Missing thread interval part completion')
      return rows[0].at as number
    })
    return [key, item.seq, item.received_at, Math.max(...completed)].join('\t')
  }).join('\n') + '\n'
}
/** Select exact Slack keys, never the last N timings. The caller must first
 * pass auditReceipts over the WHOLE journal, including reminders and roots.
 * Name evidence is the first own AD send of the first fixed part; a later
 * retry or a name cached after the timeout cannot repair that observation.
 * N4's interval belongs to sr8-evidence's same-process measurement records.
 */
export function threadLatency(options: ThreadLatencyOptions, timings: { seq: number; typing_ms: number; delivery_ms: number }[],
  journal: readonly any[], sends: readonly ShimSend[], print: (line: string) => void = console.log): number {
  const { key, channel, samples, delayed, hung, scenario, mode } = options
  if (!/^[a-z0-9_]+$/.test(key) || !/^[CG][A-Z0-9]+$/.test(channel) || !/^[\w-]+$/.test(scenario)
    || !['strict', 'open'].includes(mode) || [...samples, delayed, hung].some(ts => !/^\d+\.\d+$/.test(ts))) throw new Error('Invalid thread latency arguments')
  let missing = samples.length < THREAD_N2_MIN_SAMPLES
  let invalid = new Set(samples).size !== samples.length || delayed === hung || !samples.includes(delayed) || !samples.includes(hung)
  const selected: typeof timings = []
  for (const ts of samples) {
    const items = workloadItems(journal).filter(r => r.source === 'slack' && r.channel === channel && r.ts === ts
      && r.key?.chat_id === channel && r.key?.ts === ts && r.key?.edited_ts === undefined)
    const item = items[0], matches = timings.filter(t => t.seq === item?.seq)
    const fixed = journal.filter(r => r.kind === 'fixed' && r.seq === item?.seq)
    const first = sends.filter(s => s.instanceId === `cscb_${key}` && s.text === fixed[0]?.parts?.[0]).sort((a, b) => a.at - b.at)[0]
    const header = first?.text.match(/^<channel\b[^>]*>/)?.[0]
    const name = header?.match(/\buser="([^"]*)"/)?.[1]
    const lookup = ts === hung ? 'hung' : ts === delayed ? 'delayed' : 'none'
    const named = name ? name === item?.user ? 'fallback' : 'resolved' : 'missing'
    const timing = matches[0]
    const complete = items.length === 1 && matches.length === 1 && fixed.length === 1 && first !== undefined
      && Number.isFinite(first.at) && name !== undefined && name !== ''
      && timing && [timing.typing_ms, timing.delivery_ms].every(n => Number.isFinite(n) && n >= 0)
    if (!complete) missing = true
    else selected.push(timing)
    const valid = item?.via === 'thread' && !!item.thread_ts
      && header?.includes(`chat_id="${channel}"`) && header.includes('via="thread"')
      && header.includes(`user_id="${item.user}"`) && header.includes(`message_id="${ts}"`)
      && (lookup !== 'hung' || named === 'fallback') && (lookup !== 'delayed' || named === 'resolved')
    if (complete && !valid) invalid = true
    print(`recorded: sr8 n2-sample key=${key} seq=${item?.seq ?? 'missing'} typing_ms=${timing?.typing_ms ?? 'missing'} delivery_ms=${timing?.delivery_ms ?? 'missing'} via=${item?.via === 'thread' ? 'thread' : 'other'} lookup=${lookup} name=${named} verdict=${!complete ? 'missing' : valid ? 'pass' : 'fail'}`)
  }
  const typing = selected.length ? percentile(selected.map(t => t.typing_ms), .95) : NaN
  const delivery = selected.length ? percentile(selected.map(t => t.delivery_ms), .95) : NaN
  const verdict = missing ? 'missing' : invalid || typing > THREAD_N2_TYPING_MS || delivery > THREAD_N2_DELIVERY_MS ? 'fail' : 'pass'
  print(`recorded: sr8 n2 scenario=${scenario} mode=${mode} population=100000 key=${key} samples=${selected.length} typing_p95_ms=${Number.isFinite(typing) ? typing : 'missing'} delivery_p95_ms=${Number.isFinite(delivery) ? delivery : 'missing'} typing_limit_ms=${THREAD_N2_TYPING_MS} delivery_limit_ms=${THREAD_N2_DELIVERY_MS} verdict=${verdict}`)
  return verdict === 'pass' ? 0 : 1
}
/** Failure-only projection: no message bodies, paths, IDs, raw errors or AD
 * objects escape. All counters are bounded independently of queue size. */
export function deliveryFailureEvidence(options: AuditOptions, entries: readonly TranscriptEntry[], adapters: ReceiptAdapters,
  row: any = {}) {
  const numeric = (n: any) => Number.isSafeInteger(n) && n >= 0 ? n : null
  let reason = 'audit-unavailable'
  try { auditReceipts(options, entries, adapters); reason = 'audit-now-ready-after-deadline' } catch (error) {
    const message = error instanceof Error ? error.message : ''
    // Only audit-owned, complete fixed strings survive, never arbitrary error
    // messages (JSON/parser and filesystem errors can contain private bytes).
    if (/^Accepted item count differs$/.test(message)) reason = 'accepted-count-differs'
    else if (message === 'Invalid reply reminder provenance') reason = 'invalid-reminder-provenance'
    else if (/^Item \d+ has no valid message-(received|delivered) timestamp$/.test(message)) reason = message.includes('message-delivered') ? 'missing-delivery-log' : 'missing-receive-log'
    else if (/^Item \d+ has no fixed parts$/.test(message)) reason = 'missing-fixed-parts'
    else if (/^Item \d+ part \d+ has no exact transcript receipt$/.test(message)) reason = 'missing-exact-receipt'
    else if (/^Item \d+ part \d+ is still open$/.test(message)) reason = 'open-part'
    else if (/^Item \d+ first appearance is out of accept order$/.test(message)) reason = 'receipt-order'
    else if (/^Item \d+ part \d+ has no shim send$/.test(message)) reason = 'missing-shim-send'
    else if (message === 'Text fidelity case retyped') reason = 'retyped'
    else if (message === 'Text fidelity case taken in more than once') reason = 'duplicate-take-in'
    else if (message === 'Text fidelity case needed Enter-only recovery') reason = 'enter-only-recovery'
    else if (message === 'Durable receipt does not identify matching take-in') reason = 'durable-receipt-mismatch'
  }
  let journal: any[] = [], journalReadable = true
  try { journal = receiptJournal(options.stateDir, options.key) } catch { journalReadable = false }
  const accepted = journal.filter(r => r.kind === 'accepted' && !r.compact).sort((a, b) => a.seq - b.seq)
  const parts = (item: any): string[] => journal.find(r => r.kind === 'fixed' && r.seq === item.seq)?.parts ?? []
  const delivered = (seq: number, part: number) => journal.some(r => r.kind === 'delivered' && r.seq === seq && r.part === part)
  const open = accepted.filter(item => !parts(item).length || parts(item).some((_, i) => !delivered(item.seq, i + 1)))
  const head = open[0], fixed = head ? parts(head) : [], part = head ? fixed.findIndex((_, i) => !delivered(head.seq, i + 1)) + 1 : 0
  const own = part > 0 ? fixed[part - 1] : undefined
  let ownEntries: TranscriptEntry[] = [], sessionEvidenceReadable = true
  try { ownEntries = personaTranscripts(options.key, journal, readFileSync(join(options.stateDir, 'server.log'), 'utf8').split('\n'), entries) } catch { sessionEvidenceReadable = false }
  const attempts = head ? journal.filter(r => (r.kind === 'sent' || r.kind === 'submitted') && r.seq === head.seq) : []
  return { reason, journalReadable, accepted: accepted.filter(r => r.reminder_for === undefined).length,
    reminders: accepted.filter(r => r.reminder_for !== undefined).length, expected: numeric(options.expectedCount), open: open.length,
    head: head ? { seq: numeric(head.seq), parts: fixed.length, part, attempts: attempts.length,
      recentAttempts: attempts.slice(-8).map(r => ({ attempt: numeric(r.attempt), part: numeric(r.part), at: numeric(r.at),
        kind: r.kind === 'submitted' ? 'covered' : ['text', 'enter', 'retype'].includes(r.send_kind) ? r.send_kind : 'unknown', unknownOutcome: r.unknown_outcome === true,
        refused: journal.some(other => other.kind === 'refused' && other.seq === head.seq && other.attempt === r.attempt) })),
      exactReceipts: own === undefined ? 0 : receiptTakes(ownEntries).filter(e => e.at >= head.received_at &&
        textMatches(e, own, coveredPart(journal, head.seq, part, undefined), adapters)).length } : null,
    sessionEvidenceReadable, sessionEntries: ownEntries.length,
    sessionTakeins: ownEntries.filter(e => e.kind === 'take-in' || coveredTexts(e).length > 0).length,
    rowState: ['pending', 'waiting', 'working', 'ended', 'paused'].includes(row?.state) ? row.state : 'unreadable' }
}
/** Failure-safe accounting does not require a completed receipt audit. */
export function reportUsage(stateDir: string, entries: readonly TranscriptEntry[], adapters: ReceiptAdapters, keys: readonly string[] = []) {
  const logPath = join(stateDir, 'server.log')
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : []
  let duplicates = 0
  const queue = join(stateDir, 'queue')
  const personaKeys = keys.length ? keys : existsSync(queue) ? readdirSync(queue).filter(name => name.endsWith('.jsonl')).map(name => basename(name, '.jsonl')) : []
  for (const key of new Set(personaKeys)) {
    const path = join(queue, `${key}.jsonl`)
    if (!existsSync(path)) continue
    const journal = receiptJournal(stateDir, key), own = receiptTakes(personaTranscripts(key, journal, log, entries))
    for (const item of journal.filter(r => r.kind === 'accepted' && !r.compact)) {
      const fixed = journal.find(r => r.seq === item.seq && r.kind === 'fixed')
      for (const [i, text] of (fixed?.parts ?? []).entries()) {
        const delivered = journal.find(r => r.kind === 'delivered' && r.seq === item.seq && r.part === i + 1)
        const matches = own.filter(r => r.at >= item.received_at && textMatches(r, text, coveredPart(journal, item.seq, i + 1, delivered), adapters))
        duplicates += Math.max(0, matches.length - 1)
      }
    }
  }
  return { duplicates, tokens: transcriptTokens(entries) }
}
if (import.meta.main) {
  try {
    // thread-intervals <key> <channel> <shared-queue-snapshot> <sample-ts>...
    if (process.argv[2] === 'thread-intervals') {
      if (!existsSync('/etc/cscb-ci-image')) throw new Error('thread intervals require the CI image')
      const [key, channel, snapshot, ...samples] = process.argv.slice(3)
      process.stdout.write(threadSampleIntervals(key, channel, samples, jsonLines(snapshot)))
      process.exit(0)
    }
    if (process.argv[2] === 'capture') {
      if (!existsSync('/etc/cscb-ci-image')) throw new Error('receipt capture requires the CI image')
      const stateDir = process.argv[3]
      if (!stateDir) throw new Error('capture requires state-dir')
      captureReceiptJournals(stateDir)
      process.exit(0)
    }
    if (['report', 'report-states'].includes(process.argv[2] ?? '')) {
      const [stateDir, shimLog, root, ...keys] = process.argv.slice(3)
      if (!stateDir || !shimLog || !root) throw new Error('report requires state-dir shim-log transcript-root [keys...]')
      const adapters = await packedReceiptAdapters(), transcripts = transcriptFiles(root), entries = readTranscripts(transcripts, adapters, true)
      // Emit usage even when duplicate evidence is damaged or incomplete.
      console.log(`tokens: ${JSON.stringify(transcriptTokens(entries))}`)
      const states = process.argv[2] === 'report-states' ? [stateDir, ...keys] : [stateDir]
      const duplicates = states.reduce((sum, state) => sum + reportUsage(state, entries, adapters,
        process.argv[2] === 'report-states' ? [] : keys).duplicates, 0)
      console.log(`duplicates: ${duplicates}`)
      process.exit(0)
    }
    // thread-latency <state> <key> <shim> <transcripts> <scenario> <mode>
    //   <population-channel> <delayed-ts> <hung-ts> <sample-ts>...
    if (process.argv[2] === 'thread-latency') {
      const [stateDir, key, shimLog, root, scenario, mode, channel, delayed, hung, ...samples] = process.argv.slice(3)
      const adapters = await packedReceiptAdapters(), transcripts = transcriptFiles(root)
      const audited = auditReceipts({ stateDir, key, shimLog, transcripts }, readTranscripts(transcripts, adapters), adapters)
      console.log(receiptsRecord(audited, transcripts.length))
      process.exit(threadLatency({ key, channel, samples, delayed, hung, scenario, mode: mode as ThreadLatencyOptions['mode'] },
        audited.timings, receiptJournal(stateDir, key), shimSends(readShimLog(shimLog))))
    }
    const [command, stateDir, key, shimLog, root, count, mode, statusFile] = process.argv.slice(2)
    if (!stateDir || !key || !shimLog || !root || !['audit', 'ready', 'progress', 'latency', 'diagnostic'].includes(command ?? '')) throw new Error('Usage: transcript-receipts <audit|ready|progress|latency|diagnostic> <state-dir> <key> <shim-log> <transcript-root> [count] [no-retype]')
    const adapters = await packedReceiptAdapters()
    if (command === 'diagnostic') {
      const readJSON = (path?: string) => { try { return path ? JSON.parse(readFileSync(path, 'utf8')) : {} } catch { return {} } }
      let entries: TranscriptEntry[] = [], transcripts: string[] = [], transcriptsReadable = true
      try { transcripts = transcriptFiles(root); entries = readTranscripts(transcripts, adapters) } catch { transcriptsReadable = false }
      const evidence = deliveryFailureEvidence({ stateDir, key, shimLog, transcripts, expectedCount: count ? Number(count) : undefined, noRetype: mode === 'no-retype' }, entries, adapters,
        readJSON(statusFile))
      console.log(`recorded: delivery diagnostic ${JSON.stringify({ ...evidence, transcriptsReadable })}`)
      process.exit(0)
    }
    const transcripts = transcriptFiles(root)
    const entries = readTranscripts(transcripts, adapters)
    if (command === 'progress') {
      console.log(receiptProgress({ stateDir, key, shimLog, transcripts }, entries, adapters))
      process.exit(0)
    }
    const result = auditReceipts({ stateDir, key, shimLog, transcripts, expectedCount: command !== 'latency' && count ? Number(count) : undefined, noRetype: mode === 'no-retype' }, entries, adapters)
    if (command !== 'ready') {
      console.log(receiptsRecord(result, transcripts.length))
      if (command === 'latency') {
        const n = Number(count)
        if (!Number.isSafeInteger(n) || n <= 0 || result.timings.length < n) throw new Error('Insufficient latency samples')
        const samples = result.timings.slice(-n)
        const typing = percentile(samples.map(t => t.typing_ms), .95), delivery = percentile(samples.map(t => t.delivery_ms), .95)
        console.log(`recorded: p95 typing_start_ms=${typing} delivery_ms=${delivery} samples=${samples.length}`)
        if (typing > 2000 || delivery > 10000) throw new Error('AC76 latency exceeded')
      }
    }
  } catch (error) {
    if (process.argv[2] === 'diagnostic') console.error('recorded: delivery receipt diagnostic unavailable')
    else if (!['ready', 'progress'].includes(process.argv[2] ?? '')) console.error(`FAIL: transcript-receipts: ${error instanceof Error ? error.message : 'unknown failure'}`)
    process.exit(1)
  }
}
