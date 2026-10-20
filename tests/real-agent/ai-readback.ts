/** AI-local response oracle. Only an own, receipt-backed completed turn can
 * supply JSON; the shared transport comparator is deliberately unchanged. */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { auditReceipts, packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type ReceiptAdapters, type TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'
import { parseReadbackJSON, readbackMismatch } from './ai-mismatch-diagnostics.ts'
import { AI_FAILURE_PREFIX, diagnosticValue, reportFailureOnce, scrubDiagnosticText } from './ai-failure-diagnostics.ts'

function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
export function safeSelectedModel(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value) && !/[\r\n]/.test(value) }
const stable = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : v)

// SR-6.2 also records human queued commands as attachments. Reuse the packed
// production parser so other attachments, tool results and origins stay out.
function nativeTakeIn(entry: TranscriptEntry, adapters: ReceiptAdapters): boolean {
  if (entry.value?.type !== 'user' && !(entry.value?.type === 'attachment' && entry.value.attachment?.type === 'queued_command')) return false
  const parsed = adapters.parseDeliveryTranscriptRecord('claude', entry.value)
  return parsed.kind === 'take-in' && parsed.uuid === entry.uuid && typeof parsed.text === 'string' && parsed.text === entry.text
}

// Native session metadata has no temporal or ancestry identity. Only the five
// observed three-field shapes are informational; added evidence stays checked.
// api-request-blob is not a blanket informational exclusion. AC15 separately
// validates its request-echo structure and all embedded actions below.
export function nativeInformation(entry: TranscriptEntry, adapters: ReceiptAdapters): boolean {
  const value = entry.value, field = new Map([
    ['mode', 'mode'], ['permission-mode', 'permissionMode'], ['atis-latch', 'atis'],
    ['last-prompt', 'leafUuid'], ['ai-title', 'aiTitle'],
  ]).get(value.type)
  if (!field || !Number.isNaN(entry.at) || typeof value.sessionId !== 'string' || typeof value[field] !== 'string'
    || Object.keys(value).length !== 3 || !Object.keys(value).every(k => k === 'type' || k === 'sessionId' || k === field)) return false
  const parsed = adapters.parseDeliveryTranscriptRecord('claude', value)
  return parsed.kind === 'other' && parsed.uuid === undefined && parsed.text === undefined
    && entry.kind === 'other' && entry.uuid === undefined && entry.text === undefined
}

function nativeParent(session: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry | undefined {
  const id = entry.value?.parentUuid
  return typeof id === 'string' && id.length > 0
    ? session.find(prior => prior.value?.uuid === id && prior.offset < entry.offset) : undefined
}

// UUID identity and strictly preceding file offsets establish ancestry. Resolve
// the parent before matching the target; timestamps never select the chain.
function nativeChain(session: TranscriptEntry[], entry: TranscriptEntry, target: TranscriptEntry): TranscriptEntry[] | undefined {
  const chain: TranscriptEntry[] = [], seen = new Set<TranscriptEntry>()
  let current = entry
  while (!seen.has(current)) {
    seen.add(current)
    if (current.kind === 'take-in' && current.text !== undefined) return undefined
    const parent = nativeParent(session, current)
    if (!parent) return undefined
    chain.push(current)
    if (parent === target) return chain
    current = parent
  }
  return undefined
}

function nativeSetup(entry: TranscriptEntry): boolean {
  return entry.value?.type === 'attachment'
    && ['environment', 'model', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing',
      'total_tokens_reminder', 'deferred_tools_delta', 'deferred_tools_record'].includes(entry.value.attachment?.type)
}

export function nativeTime(session: TranscriptEntry[], entry: TranscriptEntry, receipt: TranscriptEntry, adapters: ReceiptAdapters): boolean {
  if (!Number.isFinite(entry.at)) return false
  // Decision 24: setup is prepared before the user record is timestamped.
  // Membership is ancestry/file order, with the previous turn as a time floor;
  // no guessed millisecond allowance applies to these native setup types.
  if (nativeSetup(entry)) {
    const preceding = session.filter(e => e.offset < receipt.offset)
    const predecessor = preceding.at(-1)
    const previousReceipt = preceding.map(e => nativeTakeIn(e, adapters)).lastIndexOf(true)
    // Decision 24's amendment: untimed shutdown/bookkeeping records have no
    // clock. Only the last finite timestamp in the previous turn sets the floor.
    const previousLast = previousReceipt < 0 ? undefined
      : preceding.slice(previousReceipt).filter(e => Number.isFinite(e.at)).at(-1)
    return nativeChain(session, entry, receipt) !== undefined
      && (!predecessor || entry.offset > predecessor.offset)
      && (!previousLast || entry.at > previousLast.at)
  }
  // Setup can also be serialized after its response was timestamped. Validate
  // its membership, then compare clocks against the nearest non-setup parent.
  // Strictly decreasing offsets bound this walk; no elapsed-time tolerance.
  let parent = nativeParent(session, entry)
  while (parent && nativeSetup(parent)) {
    if (!nativeTime(session, parent, receipt, adapters)) return false
    parent = nativeParent(session, parent)
  }
  return entry.at >= receipt.at && (!parent || Number.isFinite(parent.at) && entry.at >= parent.at)
}

function assertAC15Action(block: any) {
  if (block.type === 'tool_use' || block.type === 'server_tool_use') check(block.type === 'tool_use'
    && ['mcp__slack-channel-router__reply', 'ToolSearch'].includes(block.name), 'AC15 non-reply tool action observed')
}

function assertAC15EmbeddedActions(value: any): void {
  if (!value || typeof value !== 'object') return
  assertAC15Action(value)
  for (const child of Object.values(value)) assertAC15EmbeddedActions(child)
}

const object = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value: any, keys: string[]): boolean => object(value) && Object.keys(value).every(k => keys.includes(k))

// Native 2.1.304 appendRequestReplayRecords writes hash-keyed copies of outgoing
// request messages, not new assistant actions. Accept only understood shapes;
// definitions inside ToolSearch results are references, not tool executions.
function requestEchoContent(content: any, toolResult = false): boolean {
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.every(block => {
    if (!object(block)) return false
    switch (block.type) {
      case 'text': return onlyKeys(block, ['type', 'text']) && typeof block.text === 'string'
      case 'tool_use': return onlyKeys(block, ['type', 'id', 'name', 'input'])
        && typeof block.id === 'string' && block.id.length > 0 && typeof block.name === 'string' && object(block.input)
      case 'tool_result': return onlyKeys(block, ['type', 'tool_use_id', 'content', 'is_error'])
        && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0
        && (block.is_error === undefined || typeof block.is_error === 'boolean')
        && (block.content === undefined || requestEchoContent(block.content, true))
      case 'tool_reference': return toolResult && onlyKeys(block, ['type', 'tool_name'])
        && typeof block.tool_name === 'string' && block.tool_name.length > 0
      default: return false
    }
  })
}

function ac15RequestEcho(entry: TranscriptEntry, adapters: ReceiptAdapters): boolean {
  const value = entry.value
  if (value.type !== 'api-request-blob') return false
  // Check actions even in malformed or nested data before considering the
  // time exemption. No hash, role or surrounding text can conceal a tool_use.
  assertAC15EmbeddedActions(value)
  check(onlyKeys(value, ['type', 'sessionId', 'hash', 'message']) && Object.keys(value).length === 4
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
    && onlyKeys(value.message, ['role', 'content']) && Object.keys(value.message).length === 2
    && ['user', 'assistant', 'system'].includes(value.message.role) && requestEchoContent(value.message.content)
    && Number.isNaN(entry.at) && entry.kind === 'other' && entry.uuid === undefined && entry.text === undefined,
  'AC15 malformed native request echo')
  const parsed = adapters.parseDeliveryTranscriptRecord('claude', value)
  check(parsed.kind === 'other' && parsed.uuid === undefined && parsed.text === undefined, 'AC15 request echo carries transcript evidence')
  return true
}

// AC15 may acknowledge a part, but retrieval or any other action cannot
// supply missing context. Inspect every copy's turn and its late descendants;
// completion/JSON provenance remains the ordinary final-part oracle below.
function assertAC15Exchange(parts: string[], acceptedAt: number, seq: number, journal: any[], own: TranscriptEntry[], adapters: ReceiptAdapters) {
  const sends = journal.filter(r => r.kind === 'sent' && r.seq === seq && !r.unknown_outcome)
  const sessions = new Map<string, TranscriptEntry[]>()
  for (const send of sends) {
    const key = JSON.stringify([send.transcript_path, send.session_id])
    if (!sessions.has(key)) sessions.set(key, own.filter(e => e.path === send.transcript_path && e.value?.sessionId === send.session_id
      && e.value.isSidechain !== true && !e.path.includes('/subagents/')).sort((a, b) => a.offset - b.offset))
  }
  for (const session of sessions.values()) {
    const copies = session.filter(e => e.kind === 'take-in' && e.text !== undefined
      && parts.some(text => adapters.receiptTextMatches(e.text!, text)))
    if (!copies.length) continue
    const ids = session.map(e => e.value?.uuid).filter(id => typeof id === 'string')
    check(new Set(ids).size === ids.length, 'AC15 has ambiguous native UUID')
    for (const copy of copies) {
      check(typeof copy.uuid === 'string' && nativeTakeIn(copy, adapters) && copy.value.uuid === copy.uuid
        && copy.value.isMeta !== true && copy.value.sessionId === basename(copy.path, '.jsonl') && Number.isFinite(copy.at) && copy.at >= acceptedAt,
      'AC15 copy has no exact own native receipt')
      check(sends.some(r => r.transcript_path === copy.path && r.session_id === copy.value.sessionId
        && adapters.receiptTextMatches(copy.text!, parts[r.part - 1]) && Number.isFinite(r.at) && r.at >= acceptedAt && r.at <= copy.at
        && Number.isSafeInteger(r.transcript_size) && r.transcript_size >= 0 && r.transcript_size <= copy.offset),
      'AC15 copy has no native send window')
      const next = session.find(e => e.offset > copy.offset && e.kind === 'take-in' && e.text !== undefined)
      // Queued commands start their own exchange even if their timestamp is
      // earlier than the previous acknowledgement; their send checks apply.
      const linked = (entry: TranscriptEntry) => nativeChain(session, entry, copy) !== undefined
      for (const e of session.filter(e => e.offset > copy.offset && ((!next || e.offset < next.offset) || linked(e)
        || e.value?.type === 'system' && e.value.refusedUserMessageUuid === copy.uuid))) {
        if (nativeInformation(e, adapters)) continue
        if (ac15RequestEcho(e, adapters)) continue
        check(!(e.value.type === 'system' && /(?:refusal|fallback|api_error|api_retry)/.test(e.value.subtype ?? '')),
          'AC15 exchange has refusal/API failure')
        check(nativeTime(session, e, copy, adapters), 'AC15 exchange has invalid/stale time')
        if (e.value.type !== 'assistant') continue
        check(Array.isArray(e.value.message?.content), 'AC15 has malformed native assistant content')
        for (const block of e.value.message.content) {
          check(block && typeof block === 'object' && typeof block.type === 'string', 'AC15 has malformed native response block')
          // Claude's native ToolSearch discovers deferred tool definitions; it
          // does not execute them. Check every subsequent action independently.
          assertAC15Action(block)
        }
      }
    }
  }
}

export function completedAIReadback({ seq, expected, journal, own, adapters, model, onMismatch }: {
  seq: number; expected: any; journal: any[]; own: TranscriptEntry[]; adapters: ReceiptAdapters; model: string
  onMismatch?: (record: ReturnType<typeof readbackMismatch> & { responseUuid?: unknown; stopReason?: unknown }) => void
}) {
  check(Number.isSafeInteger(seq) && seq > 0 && typeof expected?.case === 'string' && safeSelectedModel(model), 'AI readback identity missing')
  const one = (kind: string, part?: number) => {
    const rows = journal.filter(r => r.kind === kind && r.seq === seq && !r.compact && (part === undefined || r.part === part))
    check(rows.length === 1, 'AI readback has missing/ambiguous ' + kind)
    return rows[0]
  }
  const accepted = one('accepted'), fixed = one('fixed')
  check(Number.isFinite(accepted.received_at) && Array.isArray(fixed.parts) && fixed.parts.length > 0, 'AI readback fixed input missing')
  let take: TranscriptEntry | undefined
  for (const [index, text] of fixed.parts.entries()) {
    const part = index + 1, delivered = one('delivered', part)
    check(typeof text === 'string' && Number.isFinite(delivered.at), 'AI readback durable part missing')
    const matches = own.filter(e => e.path === delivered.receipt?.path && (delivered.receipt.uuid ? e.uuid === delivered.receipt.uuid : e.offset === delivered.receipt?.offset))
    check(matches.length === 1, 'AI readback has missing/ambiguous own receipt')
    take = matches[0]!
    check(take.kind === 'take-in' && typeof take.text === 'string' && adapters.receiptTextMatches(take.text, text)
      && nativeTakeIn(take, adapters) && take.value.isSidechain !== true && take.value.isMeta !== true
      && typeof take.uuid === 'string' && take.value.uuid === take.uuid
      && !take.path.includes('/subagents/') && take.value.sessionId === basename(take.path, '.jsonl')
      && Number.isFinite(take.at) && take.at >= accepted.received_at && delivered.at >= take.at,
    'AI readback has no exact own native receipt')
    check(journal.some(r => r.kind === 'sent' && r.seq === seq && r.part === part && !r.unknown_outcome
      && r.session_id === take!.value.sessionId && r.transcript_path === take!.path
      && Number.isFinite(r.at) && r.at >= accepted.received_at && r.at <= take!.at
      && Number.isSafeInteger(r.transcript_size) && r.transcript_size >= 0 && r.transcript_size <= take!.offset),
    'AI readback receipt has no native send window')
  }
  if (expected.case === 'AC15') assertAC15Exchange(fixed.parts, accepted.received_at, seq, journal, own, adapters)
  // Reassembly answers belong to the final delivered part. Explicit seqs also
  // preserve earlier DM checks after a later thread and across resume sessions.
  const receipt = take!
  const session = own.filter(e => e.path === receipt.path && e.value?.sessionId === receipt.value.sessionId
    && e.value.isSidechain !== true).sort((a, b) => a.offset - b.offset)
  const ids = new Set<string>()
  for (const e of session) if (typeof e.value.uuid === 'string') {
    check(!ids.has(e.value.uuid), 'AI readback has ambiguous native UUID')
    ids.add(e.value.uuid)
  }
  const next = session.find(e => e.offset > receipt.offset && e.kind === 'take-in' && e.text !== undefined)
  const turn = session.filter(e => e.offset > receipt.offset && (!next || e.offset < next.offset))
  const linked = (entry: TranscriptEntry, target = receipt) => nativeChain(session, entry, target) !== undefined
  const readbacks: TranscriptEntry[] = []
  const candidates: { text: string; entry: TranscriptEntry }[] = []
  const mismatch = (reason: string): never => {
    if (onMismatch) {
      // Diagnostic errors cannot replace the original failure or create a pass.
      try {
        if (!candidates.length) onMismatch(readbackMismatch(expected, undefined))
        for (const { text, entry } of candidates) onMismatch({ ...readbackMismatch(expected, text),
          responseUuid: diagnosticValue(entry.value.uuid), stopReason: diagnosticValue(entry.value.message?.stop_reason) })
      } catch { /* the unchanged oracle failure still follows */ }
    }
    throw new Error(reason)
  }
  let completion: TranscriptEntry | undefined
  for (const e of turn) {
    check(!(e.value.type === 'system' && /(?:refusal|fallback|api_error|api_retry)/.test(e.value.subtype ?? '')), 'AI readback turn has refusal/API failure')
    if (e.value.type !== 'assistant') continue
    check(Number.isFinite(e.at) && e.at >= receipt.at, 'AI readback response has invalid/stale time')
    const v = e.value, message = v.message
    const chain = nativeChain(session, e, receipt)
    check(chain && chain.every(record => nativeTime(session, record, receipt, adapters))
      && typeof v.uuid === 'string' && v.isMeta !== true && !v.isApiErrorMessage && !v.error
      && !v.isSynthetic && message?.role === 'assistant' && message.model === model
      && (v.requestedModel === undefined || v.requestedModel === model)
      && Array.isArray(message.content) && message.content.every((b: any) => b && typeof b === 'object' && typeof b.type === 'string')
      && (message.stop_reason === null || message.stop_reason === 'tool_use' || message.stop_reason === 'end_turn'),
    'AI readback has invalid native assistant response')
    for (const block of message.content) {
      const text = block.type === 'text' ? block.text : block.type === 'tool_use' && block.name === 'mcp__slack-channel-router__reply' ? block.input?.text : undefined
      if (text === undefined) continue
      check(typeof text === 'string', 'AI readback has malformed response text')
      candidates.push({ text, entry: e })
      let value: any
      try { value = parseReadbackJSON(text) } catch { continue }
      if (value?.case !== expected.case) continue
      if (!Object.keys(expected).every(k => stable(value[k]) === stable(expected[k]))) mismatch('AI read-back field differs')
      readbacks.push(e)
    }
    completion = message.stop_reason === 'end_turn' ? e : undefined
  }
  if (!(completion && readbacks.some(e => e === completion || linked(completion!, e)
    || typeof e.value.message.id === 'string' && e.value.message.id.length > 0 && e.value.message.id === completion!.value.message.id)))
    mismatch('no completed current-turn AI readback for durable receipt')
  return { seq, part: fixed.parts.length, receipt_uuid: receipt.uuid, session_id: receipt.value.sessionId, actual_model: completion!.value.message.model }
}

if (import.meta.main) {
  try {
    check(existsSync('/etc/cscb-ci-image'), 'AI readback requires the CI image')
    const [state, key, shim, root, expectedPath, seq] = process.argv.slice(2)
    const adapters = await packedReceiptAdapters(), paths = transcriptFiles(root!)
    const all = readTranscripts(paths, adapters), journal = receiptJournal(state!, key!)
    auditReceipts({ stateDir: state!, key: key!, shimLog: shim!, transcripts: paths }, all, adapters)
    const own = personaTranscripts(key!, journal, readFileSync(join(state!, 'server.log'), 'utf8').split('\n'), all)
    const expected = JSON.parse(readFileSync(expectedPath!, 'utf8'))
    const result = completedAIReadback({ seq: Number(seq), expected,
      journal, own, adapters, model: process.env.REAL_AGENT_MODEL_PIN ?? '', onMismatch: record => {
        const line = AI_FAILURE_PREFIX + scrubDiagnosticText(JSON.stringify({ event: 'readback-mismatch',
          agent: 'claude', scenario: 'ai-readback', case: expected.case, seq: Number(seq), trial: process.env.REAL_AGENT_TRIAL, record }))
        reportFailureOnce(join(state!, 'ai-readback-mismatches.json'), line, console.log)
      } })
    console.log('recorded: AI current-turn field comparison ' + JSON.stringify({ criterion: process.env.AI_CRITERION,
      trial: process.env.REAL_AGENT_TRIAL, case: expected.case, ...result }))
  } catch (error) { console.error(error instanceof Error ? error.message : 'AI readback unavailable'); process.exitCode = 1 }
}
