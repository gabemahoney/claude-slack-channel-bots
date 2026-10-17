/** Decision 19 hazard isolation, checked against packed-production receipts. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { auditReceipts, packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type ReceiptAdapters, type TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'

function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
export function freshHazardSession({ seq, corpus, journal, own, adapters, previous }: {
  seq: number; corpus: any[]; journal: any[]; own: TranscriptEntry[]; adapters: ReceiptAdapters;
  previous: { seq: number; session: string }[]
}) {
  const fixture = corpus[seq - 1]
  check(Number.isSafeInteger(seq) && fixture?.name.startsWith('hz_'), 'isolation proof requires hazard case')
  const delivered = journal.filter(r => r.kind === 'delivered' && r.seq === seq && !r.compact)
  check(delivered.length === 1, 'hazard must have one exact durable receipt')
  const matches = own.filter(e => e.path === delivered[0].receipt?.path && e.uuid === delivered[0].receipt?.uuid)
  check(matches.length === 1, 'hazard native receipt missing or ambiguous')
  const receipt = matches[0]!
  check(receipt.kind === 'take-in' && typeof receipt.text === 'string'
    && adapters.receiptTextMatches(receipt.text, fixture.typed), 'hazard native receipt missing')
  const session = receipt.value.sessionId, path = receipt.path
  check(typeof session === 'string' && session === basename(path, '.jsonl')
    && receipt.value.type === 'user' && receipt.value.isSidechain !== true && receipt.value.isMeta !== true
    && !path.includes('/subagents/'), 'invalid hazard native session')
  check(journal.filter(r => r.kind === 'sent' && r.seq !== seq).every(r => r.session_id !== session), 'hazard reused earlier delivery session')
  check(previous.every(p => p.seq !== seq && p.session !== session), 'hazard session repeated')
  const native = own.filter(e => e.path === path)
  for (const [index, row] of corpus.entries()) if (index !== seq - 1) {
    check(!native.some(e => typeof e.text === 'string' && adapters.receiptTextMatches(e.text, row.typed)), 'hazard transcript contains another fixture wrapper')
    check(!native.some(e => JSON.stringify(e.value).includes(row.msg.message_id ?? row.msg.ts)), 'hazard transcript contains another fixture message identity')
  }
  // The packed matcher unwraps native pasted_content before comparing. A
  // text-prefix check would miss valid receipts or foreign pasted wrappers.
  const takes = native.filter(e => e.kind === 'take-in' && typeof e.text === 'string' && e.text.includes('<channel '))
  check(takes.length >= 1 && takes.every(e => adapters.receiptTextMatches(e.text!, fixture.typed)), 'hazard transcript contains foreign channel context')
  return { seq, fixture: fixture.name, session, path, receipt_uuid: receipt.uuid, channelTakeIns: takes.length, earlierFixtures: 0 }
}

if (import.meta.main) {
  try {
    check(existsSync('/etc/cscb-ci-image'), 'isolation proof requires CI image')
    const [state, key, shim, root, corpusPath, number, history] = process.argv.slice(2)
    const seq = Number(number), adapters = await packedReceiptAdapters(), paths = transcriptFiles(root!)
    const all = readTranscripts(paths, adapters), journal = receiptJournal(state!, key!)
    auditReceipts({ stateDir: state!, key: key!, shimLog: shim!, transcripts: paths, expectedCount: seq }, all, adapters)
    const own = personaTranscripts(key!, journal, readFileSync(join(state!, 'server.log'), 'utf8').split('\n'), all)
    const previous = existsSync(history!) ? readFileSync(history!, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const proof = freshHazardSession({ seq, corpus: JSON.parse(readFileSync(corpusPath!, 'utf8')), journal, own, adapters, previous })
    appendFileSync(history!, JSON.stringify(proof) + '\n', { mode: 0o600 })
    console.log('recorded: AI fresh session isolation ' + JSON.stringify(proof))
  } catch (error) { console.error(error instanceof Error ? error.message : 'AI isolation proof failed'); process.exitCode = 1 }
}
