/** Import-safe independent audit of the actual queue, shim and native rollout.
 * Delivery assertions never require assistant prose or turn completion. */
import { shimWords } from '../integration/fixtures/transcript-receipts.ts'
import type { CodexRollout } from './codex-evidence.ts'
import { requireEvidence } from './codex-ai.ts'

export function assertCodexObservationInventory(panes: { label: string; agent: string; version: string; state: string; screen: { kind: string } }[], noTurn: boolean) {
  const required = ['idle-empty', 'slash-popup', 'at-popup', 'dollar-popup', 'shortcuts-overlay',
    'idle-one-line-draft', 'idle-multiline-draft', 'busy-one-line-draft', 'busy-multiline-draft']
  for (const label of required) {
    const own = panes.filter(p => p.label === label)
    requireEvidence(own.length === 1, 'native observation inventory incomplete or ambiguous')
    const p = own[0]!
    requireEvidence(p.agent === 'codex' && p.version === '0.159.2', 'native observation version/agent differs')
    requireEvidence(p.screen.kind === (label === 'idle-empty' ? 'empty' : /popup|overlay/.test(label) ? 'menu' : 'input'), 'native observation classification differs')
    requireEvidence(p.state === (label.startsWith('busy-') ? 'working' : 'waiting'), 'native observation activity differs')
  }
  requireEvidence(noTurn, 'native no-new-turn observation missing')
}

export function codexShimCalls(log: string) {
  return log.split('\n').filter(line => line.startsWith('call\t')).map(line => {
    const fields = line.split('\t')
    requireEvidence(fields.length === 6 && Number.isFinite(Number(fields[1])), 'invalid shim call')
    const words = shimWords(fields[5]!)
    const arg = (key: string) => { const i = words.indexOf(key); return i < 0 ? undefined : words[i + 1] }
    return { at: Number(fields[1]) * 1000, pid: Number(fields[2]), parent: Number(fields[3]), words,
      instance: arg('--instance-id'), text: arg('--text'), key: arg('--key'), noEnter: words.includes('--no-enter') }
  })
}

export function auditCodexDelivery(options: {
  journal: any[]; rollout: CodexRollout; path: string; instance: string; shim: string; events: any[]; key: string; log: string
}) {
  const { journal, rollout, path, instance, events } = options
  requireEvidence(!rollout.incomplete, 'partial native transcript')
  const accepted = journal.filter(r => r.kind === 'accepted' && !r.compact)
  requireEvidence(accepted.length > 0, 'empty delivery audit')
  const calls = codexShimCalls(options.shim).filter(c => c.instance === instance && c.words.includes('send-keys'))
  const firstReceipts: number[] = []
  let duplicates = 0, previousJournalIndex = -1, previousEventAt = -Infinity, previousReceipt = -1
  for (const a of accepted) {
    const fixed = journal.filter(r => r.seq === a.seq && r.kind === 'fixed')
    requireEvidence(fixed.length === 1 && fixed[0].parts.length > 0, 'missing/ambiguous fixed item')
    let lastDeliveredAt = -Infinity
    for (const [index, text] of fixed[0].parts.entries()) {
      const part = index + 1
      const sends = journal.filter(r => r.seq === a.seq && r.part === part && r.kind === 'sent' && !r.unknown_outcome)
      const delivered = journal.filter(r => r.seq === a.seq && r.part === part && r.kind === 'delivered')
      requireEvidence(sends.length && delivered.length === 1, 'open item or missing send')
      const d = delivered[0]
      requireEvidence(d.receipt.path === path, 'foreign receipt path')
      const receipt = rollout.records.find(r => r.offset === d.receipt.offset)
      requireEvidence(receipt?.type === 'response_item' && receipt.role === 'user' && receipt.text === text
        && receipt.at !== undefined && receipt.at >= a.received_at && receipt.at <= d.at, 'receipt is not exact own user take-in')
      requireEvidence(sends.some(s => s.session_id === rollout.session && s.transcript_path === path
        && s.transcript_size <= receipt.offset && s.at <= receipt.at! && s.at >= a.received_at), 'receipt has no own send window')
      const copies = rollout.records.filter(r => r.type === 'response_item' && r.role === 'user' && r.text === text
        && sends.some(s => s.session_id === rollout.session && r.offset >= s.transcript_size && r.at !== undefined && r.at >= s.at))
      requireEvidence(copies.length > 0 && copies[0]!.offset > previousReceipt, 'first receipts are out of acceptance order')
      firstReceipts.push(copies[0]!.offset); previousReceipt = copies[0]!.offset; duplicates += copies.length - 1
      for (const send of sends) {
        requireEvidence(send.session_id === rollout.session && send.transcript_path === path
          && Number.isSafeInteger(send.transcript_size) && send.transcript_size >= 0 && send.transcript_size <= rollout.size
          && Number.isFinite(send.at) && send.at >= a.received_at && send.at <= d.at, 'foreign or invalid send window')
        requireEvidence(journal.indexOf(send) > previousJournalIndex && send.at >= previousEventAt, 'next send preceded predecessor message-delivered')
        if (send.send_kind !== 'enter') requireEvidence(calls.some(c => c.text === text && c.noEnter && c.at >= send.at
          && c.at >= previousEventAt && c.at <= d.at), 'durable text has no actual shim send')
      }
      const actual = calls.filter(c => c.text === text)
      requireEvidence(actual.every(c => c.at >= previousEventAt), 'actual next text preceded predecessor message-delivered')
      previousJournalIndex = journal.indexOf(d)
      lastDeliveredAt = Math.max(lastDeliveredAt, d.at)
    }
    const deliveredEvents = events.filter(e => e.type === 'item-delivered' && e.seq === a.seq && e.instance === instance)
    requireEvidence(deliveredEvents.length === 1 && deliveredEvents[0].at >= lastDeliveredAt, 'message-delivered event missing')
    const location = a.source === 'slack' ? `chat_id=${JSON.stringify(a.channel)}` : `sender=${JSON.stringify(a.sender)}`
    const logs = options.log.split('\n').filter(line => line.includes('[slack] message-delivered:')
      && line.includes(`(key=${options.key})`) && line.includes(`source=${a.source} ${location} ts=${JSON.stringify(a.ts)} `))
    requireEvidence(logs.length === 1 && logs[0]!.includes(` at=${deliveredEvents[0].at} `), 'official message-delivered diagnostic missing or ambiguous')
    const loggedAt = Date.parse(/^\[([^\]]+)\]/.exec(logs[0]!)?.[1] ?? '')
    requireEvidence(Number.isFinite(loggedAt) && loggedAt >= deliveredEvents[0].at, 'official diagnostic time invalid')
    previousEventAt = loggedAt
  }
  return { duplicates, firstReceipts, items: accepted.length }
}

export function assertCodexRecovery(journal: any[], seq: number, kind: 'enter' | 'retype' | 'no-retype', shim: string, instance: string) {
  const sends = journal.filter(r => r.seq === seq && r.kind === 'sent' && !r.unknown_outcome)
  const fixed = journal.find(r => r.seq === seq && r.kind === 'fixed')
  const calls = codexShimCalls(shim).filter(c => c.instance === instance)
  requireEvidence(fixed && sends.length, 'recovery item missing')
  const texts = calls.filter(c => fixed.parts.includes(c.text))
  const delivered = journal.find(r => r.seq === seq && r.kind === 'delivered' && r.part === 1)
  requireEvidence(delivered, 'recovery delivery missing')
  if (kind === 'enter') requireEvidence(sends.some(r => r.send_kind === 'enter') && texts.length === 1
    && calls.some(c => c.key === 'Enter' && c.at <= delivered.at && sends.some(r => r.send_kind === 'enter' && c.at >= r.at)), 'Enter-only recovery missing or retyped')
  if (kind === 'retype') requireEvidence(sends.some(r => r.send_kind === 'retype') && texts.length >= 2
    && texts.some(c => c.at <= delivered.at && sends.some(r => r.send_kind === 'retype' && c.at >= r.at)), 'lost text was not retyped')
  if (kind === 'no-retype') requireEvidence(sends.every(r => r.send_kind !== 'retype') && texts.length === 1, 'trailing popup body was retyped')
}
