/** Live delivery evidence without loading production adapters on the host (b.omv SR-13.6). */
import { personaName, type PersonaLetter } from '../lib/personas.ts'
import { waitFor, POLL_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { q, run, sinceGrep } from './helpers.ts'

export type DeliveryDiagnostic = 'message-received' | 'message-delivered'

/** Match complete metadata fields, never a body excerpt or another conversation's timestamp. */
export async function deliveryLines(
  ctx: CheckContext,
  mark: string,
  kind: DeliveryDiagnostic,
  letter: PersonaLetter,
  channel: string,
  ts: string,
): Promise<string[]> {
  const name = personaName(letter)
  const identity = `[slack] ${kind}: persona="${name}" (key=${name}) source=slack chat_id=${JSON.stringify(channel)} ts=${JSON.stringify(ts)} sender_id=`
  return (await sinceGrep(ctx, mark, identity)).filter((line) => line.slice(line.indexOf('[slack]')).startsWith(identity))
}

/** A Slack reply can race the engine's next receipt read and durable append. */
export async function waitDeliveryLines(
  ctx: CheckContext,
  mark: string,
  kind: DeliveryDiagnostic,
  letter: PersonaLetter,
  channel: string,
  ts: string,
): Promise<string[]> {
  return await waitFor(async () => {
    const found = await deliveryLines(ctx, mark, kind, letter, channel, ts)
    return found.length > 0 ? found : null
  }, { timeoutMs: 60 * SECOND, intervalMs: POLL_MS, clock: ctx.clock }) ?? []
}

/** Only metadata leaves the container; queue text and fixed parts stay inside it. */
export interface QueueEvidence {
  accepted: number
  compacted: number
  seqs: number[]
  outstanding: number
  confirmed: number
  sent: number
  receipts: number
  totalOutstanding: number
}

/** The on-disk queue's independent projection, including restart compaction of delivered Slack keys. */
export function queueEvidenceScript(letter: PersonaLetter, channel: string, ts: string, sender: string): string {
  const filter = [
    'def complete($all): . as $item',
    '  | [$all[] | select(.seq == $item.seq and .kind == "fixed")][0] as $fixed',
    '  | ($fixed.parts | type) == "array" and ($fixed.parts | length) > 0',
    '    and all(range(1; ($fixed.parts | length) + 1); . as $part',
    '      | any($all[]; .seq == $item.seq and .kind == "delivered" and .part == $part',
    '        and (.receipt.path | type) == "string" and (.receipt.path | length) > 0',
    '        and ((.receipt.uuid | type) == "string" or (.receipt.offset | type) == "number")));',
    '. as $all',
    '| [.[] | select(.kind == "accepted" and .compact == null)] as $full',
    '| [$full[] | select(.source == "slack" and .channel == $channel and .ts == $ts',
    '    and .key.chat_id == $channel and .key.ts == $ts and .user == $sender)] as $accepted',
    '| [.[] | select(.kind == "accepted" and .compact == "key"',
    '    and .key.chat_id == $channel and .key.ts == $ts and (.delivered_at | type) == "number")] as $compacted',
    '| ([$accepted[], $compacted[]] | map(.seq) | unique) as $seqs',
    '| {accepted: ($accepted | length), compacted: ($compacted | length), seqs: $seqs,',
    '   outstanding: ([$accepted[] | select(complete($all) | not)] | length),',
    '   confirmed: (([$accepted[] | select(complete($all))] | length) + ($compacted | length)),',
    '   sent: ([$all[] | select(.kind == "sent" and (.seq as $seq | $seqs | index($seq)) != null)] | length),',
    '   receipts: ([$all[] | select(.kind == "delivered" and (.seq as $seq | $seqs | index($seq)) != null)] | length),',
    '   totalOutstanding: ([$full[] | select(complete($all) | not)] | length)}',
  ].join('\n')
  return `jq -sc --arg channel ${q(channel)} --arg ts ${q(ts)} --arg sender ${q(sender)} ${q(filter)} "$S/queue/${personaName(letter)}.jsonl"`
}

export async function queueEvidence(ctx: CheckContext, letter: PersonaLetter, channel: string, ts: string): Promise<QueueEvidence> {
  const result = await run(ctx, queueEvidenceScript(letter, channel, ts, ctx.ids.humanUserId))
  if (result.code !== 0) throw new Error('delivery queue evidence could not be read')
  let parsed: QueueEvidence
  try { parsed = JSON.parse(result.out) as QueueEvidence } catch { throw new Error('delivery queue evidence is malformed') }
  const counts = [parsed?.accepted, parsed?.compacted, parsed?.outstanding, parsed?.confirmed, parsed?.sent, parsed?.receipts, parsed?.totalOutstanding]
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(parsed.seqs) || !parsed.seqs.every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('delivery queue evidence is malformed')
  }
  return parsed
}
