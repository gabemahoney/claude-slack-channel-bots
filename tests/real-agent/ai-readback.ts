/** AI-local response oracle. Only an own, receipt-backed completed turn can
 * supply JSON; the shared transport comparator is deliberately unchanged. */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { auditReceipts, packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type ReceiptAdapters, type TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'

function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
export function safeSelectedModel(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value) && !/[\r\n]/.test(value) }
const stable = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : v)

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
      check(typeof copy.uuid === 'string' && copy.value.type === 'user' && copy.value.uuid === copy.uuid
        && copy.value.isMeta !== true && copy.value.sessionId === basename(copy.path, '.jsonl') && Number.isFinite(copy.at) && copy.at >= acceptedAt,
      'AC15 copy has no exact own native receipt')
      check(sends.some(r => r.transcript_path === copy.path && r.session_id === copy.value.sessionId
        && adapters.receiptTextMatches(copy.text!, parts[r.part - 1]) && Number.isFinite(r.at) && r.at >= acceptedAt && r.at <= copy.at
        && Number.isSafeInteger(r.transcript_size) && r.transcript_size >= 0 && r.transcript_size <= copy.offset),
      'AC15 copy has no native send window')
      const next = session.find(e => e.offset > copy.offset && e.kind === 'take-in' && e.text !== undefined)
      const linked = (entry: TranscriptEntry): boolean => {
        const seen = new Set<string>(); let current = entry
        while (typeof current.value?.parentUuid === 'string' && !seen.has(current.value.parentUuid)) {
          const parent = current.value.parentUuid
          if (parent === copy.uuid) return true
          seen.add(parent)
          // Discover ancestry from native identity and file order. Bad times
          // must invalidate linked evidence, never hide it from this exchange.
          const prior = session.find(e => e.value?.uuid === parent && e.offset < current.offset)
          if (!prior || prior.kind === 'take-in' && prior.text !== undefined) return false
          current = prior
        }
        return false
      }
      for (const e of session.filter(e => e.offset > copy.offset && ((!next || e.offset < next.offset) || linked(e)
        || e.value?.type === 'system' && e.value.refusedUserMessageUuid === copy.uuid))) {
        check(!(e.value.type === 'system' && /(?:refusal|fallback|api_error|api_retry)/.test(e.value.subtype ?? '')),
          'AC15 exchange has refusal/API failure')
        const parent = session.find(prior => prior.value?.uuid === e.value.parentUuid && prior.offset < e.offset)
        check(Number.isFinite(e.at) && e.at >= copy.at && (!linked(e)
          || parent && Number.isFinite(parent.at) && parent.at <= e.at), 'AC15 exchange has invalid/stale time')
        if (e.value.type !== 'assistant') continue
        check(Array.isArray(e.value.message?.content), 'AC15 has malformed native assistant content')
        for (const block of e.value.message.content) {
          check(block && typeof block === 'object' && typeof block.type === 'string', 'AC15 has malformed native response block')
          if (block.type === 'tool_use' || block.type === 'server_tool_use') check(block.type === 'tool_use'
            && block.name === 'mcp__slack-channel-router__reply', 'AC15 non-reply tool action observed')
        }
      }
    }
  }
}

export function completedAIReadback({ seq, expected, journal, own, adapters, model }: {
  seq: number; expected: any; journal: any[]; own: TranscriptEntry[]; adapters: ReceiptAdapters; model: string
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
      && take.value?.type === 'user' && take.value.isSidechain !== true && take.value.isMeta !== true
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
  const linked = (entry: TranscriptEntry, target = receipt.uuid): boolean => {
    const seen = new Set<string>(); let current = entry
    while (typeof current.value.parentUuid === 'string' && !seen.has(current.value.parentUuid)) {
      const parent = current.value.parentUuid
      if (parent === target) return true
      seen.add(parent)
      const prior = session.find(e => e.value.uuid === parent && e.offset < current.offset && e.at <= current.at)
      if (!prior || prior.kind === 'take-in' && prior.text !== undefined) return false
      current = prior
    }
    return false
  }
  const readbacks: TranscriptEntry[] = []
  let completion: TranscriptEntry | undefined
  for (const e of turn) {
    check(!(e.value.type === 'system' && /(?:refusal|fallback|api_error|api_retry)/.test(e.value.subtype ?? '')), 'AI readback turn has refusal/API failure')
    if (e.value.type !== 'assistant') continue
    check(Number.isFinite(e.at) && e.at >= receipt.at, 'AI readback response has invalid/stale time')
    const v = e.value, message = v.message
    check(linked(e) && typeof v.uuid === 'string' && v.isMeta !== true && !v.isApiErrorMessage && !v.error
      && !v.isSynthetic && message?.role === 'assistant' && message.model === model
      && (v.requestedModel === undefined || v.requestedModel === model)
      && Array.isArray(message.content) && message.content.every((b: any) => b && typeof b === 'object' && typeof b.type === 'string')
      && (message.stop_reason === null || message.stop_reason === 'tool_use' || message.stop_reason === 'end_turn'),
    'AI readback has invalid native assistant response')
    for (const block of message.content) {
      const text = block.type === 'text' ? block.text : block.type === 'tool_use' && block.name === 'mcp__slack-channel-router__reply' ? block.input?.text : undefined
      if (text === undefined) continue
      check(typeof text === 'string', 'AI readback has malformed response text')
      let value: any
      try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { continue }
      if (value?.case !== expected.case) continue
      check(Object.keys(expected).every(k => stable(value[k]) === stable(expected[k])), 'AI read-back field differs')
      readbacks.push(e)
    }
    completion = message.stop_reason === 'end_turn' ? e : undefined
  }
  check(completion && readbacks.some(e => e === completion || linked(completion!, e.value.uuid)
    || typeof e.value.message.id === 'string' && e.value.message.id.length > 0 && e.value.message.id === completion!.value.message.id),
  'no completed current-turn AI readback for durable receipt')
  return { seq, part: fixed.parts.length, receipt_uuid: receipt.uuid, session_id: receipt.value.sessionId, actual_model: completion.value.message.model }
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
      journal, own, adapters, model: process.env.REAL_AGENT_MODEL_PIN ?? '' })
    console.log('recorded: AI current-turn field comparison ' + JSON.stringify({ criterion: process.env.AI_CRITERION,
      trial: process.env.REAL_AGENT_TRIAL, case: expected.case, ...result }))
  } catch (error) { console.error(error instanceof Error ? error.message : 'AI readback unavailable'); process.exitCode = 1 }
}
