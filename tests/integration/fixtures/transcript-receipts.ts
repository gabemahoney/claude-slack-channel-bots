/** Executable evidence adapter for real scenarios (b.omv SR-14.1).
 * Only the installed tarball's parser and exact matcher decide take-in.
 * Importing this helper performs no I/O; CLI entry points require the CI image.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  for (const record of journal) if (record.kind === 'sent' && !record.unknown_outcome) {
    if (record.session_id) sessions.add(record.session_id)
    if (typeof record.transcript_path === 'string' && record.transcript_path && basename(record.transcript_path, '.jsonl') === record.session_id) directories.add(dirname(resolve(record.transcript_path)))
  }
  for (const line of log) {
    const marker = '[slack] delivery-launch-observed: '
    const index = line.indexOf(marker)
    if (index < 0) continue
    const observation = JSON.parse(line.slice(index + marker.length))
    if (observation.key === key && typeof observation.session_id === 'string' && observation.session_id) sessions.add(observation.session_id)
  }
  return entries.filter(entry => {
    if (entry.path.includes('/subagents/')) return false
    const session = basename(entry.path, '.jsonl')
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
export function auditReceipts(options: AuditOptions, entries: readonly TranscriptEntry[], adapters: ReceiptAdapters) {
  const journal = jsonLines(join(options.stateDir, 'queue', `${options.key}.jsonl`))
  const accepted = journal.filter(r => r.kind === 'accepted' && !r.compact).sort((a, b) => a.seq - b.seq)
  if (!accepted.length || (options.expectedCount !== undefined && accepted.length !== options.expectedCount)) throw new Error('Accepted item count differs')
  const log = readFileSync(join(options.stateDir, 'server.log'), 'utf8').split('\n')
  const ownEntries = personaTranscripts(options.key, journal, log, entries)
  const takes = ownEntries.filter(e => e.kind === 'take-in' && e.text !== undefined)
  const sends = shimSends(readFileSync(options.shimLog, 'utf8')).filter(s => s.instanceId === `cscb_${options.key}`)
  let previousAppearance = -1, previousDelivered = -Infinity, duplicates = 0
  const timings: { seq: number; typing_ms: number; delivery_ms: number }[] = []
  for (const item of accepted) {
    const receivedAt = diagnosticTime(log, 'message-received', options.key, item)
    const loggedAt = diagnosticTime(log, 'message-delivered', options.key, item)
    const fixed = journal.find(r => r.seq === item.seq && r.kind === 'fixed')
    if (!fixed?.parts?.length) throw new Error(`Item ${item.seq} has no fixed parts`)
    let firstTyped = Infinity, partDelivered = previousDelivered
    for (let part = 1; part <= fixed.parts.length; part++) {
      const text = fixed.parts[part - 1]
      const matches = takes.flatMap((r, i) => adapters.receiptTextMatches(r.text!, text) && r.at >= item.received_at ? [i] : [])
      if (!matches.length) throw new Error(`Item ${item.seq} part ${part} has no exact transcript receipt`)
      const first = matches[0]!
      if (first <= previousAppearance) throw new Error(`Item ${item.seq} first appearance is out of accept order`)
      previousAppearance = first
      duplicates += matches.length - 1
      const delivered = journal.find(r => r.seq === item.seq && r.kind === 'delivered' && r.part === part)
      if (!delivered) throw new Error(`Item ${item.seq} part ${part} is still open`)
      const receipt = takes.find(r => r.path === delivered.receipt?.path && (delivered.receipt.uuid ? r.uuid === delivered.receipt.uuid : r.offset === delivered.receipt?.offset))
      if (!receipt || !adapters.receiptTextMatches(receipt.text!, text)) throw new Error('Durable receipt does not identify matching take-in')
      const typed = sends.filter(s => s.text === text)
      if (!typed.length) throw new Error(`Item ${item.seq} part ${part} has no shim send`)
      if (typed.some(s => !Number.isFinite(s.at) || s.at < receivedAt)) throw new Error('Missing, invalid or negative typing measurement')
      if (typed.some(s => s.at < partDelivered)) throw new Error('Successor send preceded prior receipt/delivery log')
      if (options.noRetype && typed.length !== 1) throw new Error('Text fidelity case retyped')
      firstTyped = Math.min(firstTyped, typed[0]!.at)
      if (!Number.isFinite(delivered.at)) throw new Error('Invalid durable delivery timestamp')
      partDelivered = delivered.at
    }
    if (loggedAt < firstTyped || loggedAt < receivedAt) throw new Error('Negative or inconsistent delivery measurement')
    previousDelivered = loggedAt
    timings.push({ seq: item.seq, typing_ms: firstTyped - receivedAt, delivery_ms: loggedAt - receivedAt })
  }
  return { items: accepted.length, duplicates, tokens: transcriptTokens(ownEntries), timings }
}
export function percentile(values: number[], quantile: number): number {
  if (!values.length) throw new Error('No latency samples')
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]!
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
    const journal = jsonLines(path), own = personaTranscripts(key, journal, log, entries)
    for (const item of journal.filter(r => r.kind === 'accepted' && !r.compact)) {
      const fixed = journal.find(r => r.seq === item.seq && r.kind === 'fixed')
      for (const text of fixed?.parts ?? []) {
        const matches = own.filter(r => r.kind === 'take-in' && r.text !== undefined && r.at >= item.received_at && adapters.receiptTextMatches(r.text, text))
        duplicates += Math.max(0, matches.length - 1)
      }
    }
  }
  return { duplicates, tokens: transcriptTokens(entries) }
}
if (import.meta.main) {
  try {
    if (process.argv[2] === 'report') {
      const [stateDir, shimLog, root, ...keys] = process.argv.slice(3)
      if (!stateDir || !shimLog || !root) throw new Error('report requires state-dir shim-log transcript-root [keys...]')
      const adapters = await packedReceiptAdapters(), transcripts = transcriptFiles(root), entries = readTranscripts(transcripts, adapters, true)
      // Emit usage even when duplicate evidence is damaged or incomplete.
      console.log(`tokens: ${JSON.stringify(transcriptTokens(entries))}`)
      const result = reportUsage(stateDir, entries, adapters, keys)
      console.log(`duplicates: ${result.duplicates}`)
      process.exit(0)
    }
    const [command, stateDir, key, shimLog, root, count, mode] = process.argv.slice(2)
    if (!stateDir || !key || !shimLog || !root || !['audit', 'ready', 'latency'].includes(command ?? '')) throw new Error('Usage: transcript-receipts <audit|ready|latency> <state-dir> <key> <shim-log> <transcript-root> [count] [no-retype]')
    const adapters = await packedReceiptAdapters()
    const transcripts = transcriptFiles(root)
    const entries = readTranscripts(transcripts, adapters)
    const result = auditReceipts({ stateDir, key, shimLog, transcripts, expectedCount: command !== 'latency' && count ? Number(count) : undefined, noRetype: mode === 'no-retype' }, entries, adapters)
    if (command !== 'ready') {
      console.log(`recorded: receipts ${JSON.stringify({ items: result.items, transcripts: transcripts.length, timings: result.timings })}`)
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
    if (process.argv[2] !== 'ready') console.error(`FAIL: transcript-receipts: ${error instanceof Error ? error.message : 'unknown failure'}`)
    process.exit(1)
  }
}
