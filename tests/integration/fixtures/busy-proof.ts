/** Native busy-turn evidence. Polling changes no membership, timing or receipt oracle. */
import { basename } from 'node:path'
import type { TranscriptEntry } from './transcript-receipts.ts'
import { diagnosticValue, emitFailureEvidence, projectClaudeFailure } from '../../real-agent/ai-failure-diagnostics.ts'

export const BUSY_PROOF_WAIT_MS = 180_000
export interface BusyProofSnapshot {
  selected: any
  journal: any[]
  own: TranscriptEntry[]
}
class BusyProofAssertionError extends Error {}
function check(value: unknown, reason: string): asserts value { if (!value) throw new BusyProofAssertionError(reason) }
function blocks(e: TranscriptEntry): any[] { return e.value?.type === 'assistant' && Array.isArray(e.value.message?.content) ? e.value.message.content : [] }
function messageKey(e: TranscriptEntry): string | number { return e.value.message?.id ?? e.value.uuid ?? e.offset }
/** Only the adjacent native thinking-only retry joins two completed API messages. */
function isThinkingOnlyRetry(prior: TranscriptEntry, retry: TranscriptEntry, records: TranscriptEntry[], allowMissingCompanion: boolean) {
  if (!['end_turn', 'stop_sequence'].includes(prior.value.message?.stop_reason)) return false
  const copies = records.filter(e => e.value?.type === 'assistant' && messageKey(e) === messageKey(prior))
  if (!copies.every(e => !e.value.isApiErrorMessage && blocks(e).length > 0
    && blocks(e).every(b => b.type === 'thinking' || b.type === 'redacted_thinking'))) return false
  const between = records.filter(e => e.offset > prior.offset && e.offset < retry.offset)
  const nudge = between.at(-1)
  if (!nudge) return false
  const value = nudge.value
  // Require the native companion marker when available. The old failure projection
  // omits it throughout; only that metadata-poor evidence can use the missing-field path.
  // No text match: user text and thinking bodies are withheld in that projection.
  return value?.type === 'user' && value.isMeta === true && value.origin === undefined
    && (value.turnCompanion === true || (allowMissingCompanion && value.turnCompanion === undefined))
    && value.toolUseResult === undefined && value.sourceToolAssistantUUID === undefined && value.sourceToolUseID === undefined
    && !(Array.isArray(value.message?.content) && value.message.content.some((b: any) => b.type === 'tool_result'))
    && Number.isFinite(nudge.at) && prior.at <= nudge.at && nudge.at <= retry.at
    && between.slice(0, -1).every(e => e.value?.type === 'assistant' && messageKey(e) === messageKey(prior))
}
export function assertBusyProof(snapshot: BusyProofSnapshot, seq: number,
  auditReceipts: () => { duplicates: number }, receiptTextMatches: (actual: string, expected: string) => boolean) {
  const { selected, journal: j, own } = snapshot, item=j.find(r=>r.kind==='accepted'&&!r.compact&&r.seq===seq)
  check(item?.source==='slack'&&Number.isFinite(item.received_at),'busy message acceptance missing')
  const use=own.find(e=>e.path===selected.path&&e.offset===selected.offset&&e.value?.uuid===selected.uuid&&e.at===selected.at
    &&blocks(e).some((b:any)=>b.type==='tool_use'&&b.name==='Bash'&&b.id===selected.id&&b.input?.command===selected.command))
  check(use,'active tool does not belong to this persona/session')
  const completed=own.filter(e=>e.path===use.path&&e.value?.type==='user'&&Array.isArray(e.value.message?.content)
    &&e.value.message.content.some((b:any)=>b.type==='tool_result'&&b.tool_use_id===selected.id))
  check(completed.length===1,'named tool has no unique matching result')
  const result=completed[0]!
  check(Number.isFinite(selected.observed_at)&&use.at<=selected.observed_at&&selected.observed_at<=item.received_at
    &&Number.isFinite(result.at)&&item.received_at<result.at&&result.offset>use.offset,
    'message was not accepted while the observed tool was active (tool finished before acceptance)')
  const fixed=j.find(r=>r.kind==='fixed'&&r.seq===item.seq)
  check(fixed?.parts?.length===1,'busy message has no single fixed part')
  // The normal receipt audit supplies exact text, shim, durable receipt,
  // diagnostic and persona/session/path evidence for both messages.
  const audit=auditReceipts()
  const takes=own.filter(e=>e.kind==='take-in'&&e.text!==undefined&&e.at>=item.received_at&&receiptTextMatches(e.text,fixed.parts[0]))
  const take=takes[0]
  check(take&&take.path===use.path&&take.offset>use.offset&&Number.isFinite(take.at),'busy take-in has no same-session timestamp/identity')
  const ends=own.filter(e=>e.path===use.path&&e.offset>use.offset&&e.value?.type==='assistant'
    &&['end_turn','stop_sequence','refusal'].includes(e.value.message?.stop_reason)&&!blocks(e).some((b:any)=>b.type==='tool_use'))
  // Streaming records of one completed message are one turn boundary;
  // keep its first offset so later copies cannot hide a prior turn end.
  const byMessage=new Map<string|number,typeof ends[number]>()
  for(const e of ends) {
    const id=messageKey(e), prior=byMessage.get(id)
    if(!prior||e.offset<prior.offset)byMessage.set(id,e)
  }
  const messages=[...byMessage.values()].sort((a,b)=>a.offset-b.offset)
  check(messages.length>0&&messages.every(e=>Number.isFinite(e.at)&&e.at>=result.at),'completed tool turn evidence missing/invalid')
  const records=own.filter(e=>e.path===use.path&&e.offset>use.offset).sort((a,b)=>a.offset-b.offset)
  const allowMissingCompanion=!own.some(e=>e.path===use.path&&e.value?.type==='user'&&e.value.turnCompanion!==undefined)
  // Keep the first terminal offset even for a retry, so a later copy or nudge
  // cannot move an already-observed boundary past the take-in.
  // Native thinkingOnlyNudged permits one retry: consume a pair once, never
  // use its retried response as the prior of a second (transitive) merge.
  const boundaries: TranscriptEntry[]=[]
  for(let i=0;i<messages.length;i++) {
    const first=messages[i]!, retry=messages[i+1]
    boundaries.push(first)
    if(retry&&isThinkingOnlyRetry(first,retry,records,allowMissingCompanion))i++
  }
  const before=boundaries.filter(e=>e.offset<take.offset)
  check(before.length<=1&&messages.filter(e=>e.offset<take.offset).every(e=>e.at<=take.at),'busy message was taken in later than the next turn')
  return {tool_use_id:selected.id,tool_started_at:use.at,accepted_at:item.received_at,
    tool_result_at:result.at,taken_in_at:take.at,turn:before.length===0?'same':'next',duplicates:audit.duplicates}
}

/** Retain the snapshot actually checked, not a new transcript read after failure. */
export function emitBusyProofFailure(snapshot: BusyProofSnapshot | undefined, seq: number,
  timing: { startedAt: number; observedAt: number; attempts: number }, error: unknown, emit = console.log) {
  const selected = snapshot?.selected, item = snapshot?.journal.find(r => r.kind === 'accepted' && r.seq === seq)
  const scope = { scenario: 'test-101-fmk-real-busy', trial: process.env.REAL_AGENT_TRIAL ?? '1', agent: 'claude',
    phase: 'busy-proof-assertion', seq, ...timing, boundMs: BUSY_PROOF_WAIT_MS,
    reason: error instanceof BusyProofAssertionError ? error.message : 'busy proof prerequisite failed',
    snapshotAvailable: snapshot !== undefined,
    selected: Object.fromEntries(['uuid', 'offset', 'id', 'at', 'observed_at'].map(k => [k, diagnosticValue(selected?.[k])])),
    acceptedAt: diagnosticValue(item?.received_at),
    journal: snapshot?.journal.map(row => ({
      ...Object.fromEntries(['kind', 'seq', 'part', 'at', 'received_at', 'transcript_size', 'session_id']
        .filter(k => row[k] !== undefined).map(k => [k, diagnosticValue(row[k])])),
      ...(typeof row.transcript_path === 'string' && { stream: diagnosticValue(basename(row.transcript_path)) }),
      ...(Array.isArray(row.parts) && { partBytes: row.parts.map((part: unknown) => typeof part === 'string' ? Buffer.byteLength(part) : null) }),
    })) }

  emitFailureEvidence(scope, snapshot?.own.map(projectClaudeFailure) ?? [], emit)
}

/** The established 180 s bound includes all attempts; there is no grace or retry after timeout. */
export async function pollBusyProof<T>(read: () => Promise<BusyProofSnapshot>, prove: (snapshot: BusyProofSnapshot) => T,
  failure: (snapshot: BusyProofSnapshot | undefined, timing: { startedAt: number; observedAt: number; attempts: number }, error: unknown) => void,
  clock = { now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms), wallNow: () => Date.now() }) {
  const start = clock.now(), startedAt = clock.wallNow()
  let attempts = 0
  while (true) {
    let snapshot: BusyProofSnapshot | undefined
    let observedAt = clock.wallNow()
    try {
      snapshot = await read()
      observedAt = clock.wallNow()
      attempts++
      const result = prove(snapshot)
      if (clock.now() - start > BUSY_PROOF_WAIT_MS) throw new BusyProofAssertionError('busy proof completed after the 180 s bound')
      return result
    } catch (error) {
      if (clock.now() - start >= BUSY_PROOF_WAIT_MS) {
        failure(snapshot, { startedAt, observedAt, attempts }, error)
        throw error
      }
      await clock.sleep(Math.min(100, BUSY_PROOF_WAIT_MS - (clock.now() - start)))
    }
  }
}
