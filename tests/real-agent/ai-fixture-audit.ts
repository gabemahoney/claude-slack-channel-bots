/** Decision 18's reviewed AI inputs. No model calls or production imports.
 * The AI copy is explicit; this audit never rewrites a delivered input.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export const incidentalBait = /pwn(?:ed)?|hack|exploit|inject|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|malware|ransomware|payload|jailbreak|exfiltrat|backdoor|reverse\s+shell|curl\s.*\|\s*(?:ba)?sh/i

export function auditedAICorpus(tests = resolve(dirname(import.meta.path), '..')) {
  const manifest = JSON.parse(readFileSync(join(tests, 'real-agent/fixtures/input-audit.json'), 'utf8'))
  const canonicalBytes = readFileSync(join(tests, 'fixtures/delivery-wrapper/wrapper-cases.json'))
  check(sha256(canonicalBytes) === manifest.canonical_sha256, 'canonical wrapper corpus SHA changed')
  const canonical = JSON.parse(canonicalBytes.toString())
  const aiBytes = readFileSync(join(tests, 'real-agent/fixtures/wrapper-cases.json'))
  const ai = JSON.parse(aiBytes.toString())
  check(canonical.length === 15 && ai.length === canonical.length && manifest.cases.length === canonical.length, 'AI audit case inventory changed')
  for (const [i, original] of canonical.entries()) {
    const review = manifest.cases[i], row = ai[i]
    check(review.name === original.name && row.name === original.name && review.reason?.length, 'AI audit case order/name/reason changed')
    const allowed = structuredClone(original)
    if (review.change) {
      check(original.name === 'hz_bang' && review.change.from === '!echo PWNED-BANG' && review.change.to === '!echo BANG-OK', 'unapproved AI body neutralization')
      check(original.msg.text === review.change.from, 'AI neutralization source changed')
      const openerEnd = original.typed.indexOf('>') + 1
      check(original.typed.slice(openerEnd, -'</channel>'.length) === review.change.from, 'AI neutralization typed source changed')
      allowed.msg.text = review.change.to
      allowed.typed = original.typed.slice(0, openerEnd) + review.change.to + '</channel>'
      allowed.typed_len = allowed.typed.length
    }
    check(JSON.stringify(row) === JSON.stringify(allowed), 'undocumented AI fixture drift: ' + original.name)
    check(row.typed_len === row.typed.length, 'AI typed_len differs: ' + row.name)
    check(!incidentalBait.test(row.msg.text) && !incidentalBait.test(row.typed), 'unreviewed classifier bait: ' + row.name)
  }
  check(ai[3].msg.text === '!echo BANG-OK', 'AI bang neutralization missing')
  check(JSON.stringify(ai[2]) === JSON.stringify(canonical[2]) && ai[2].name === 'ex3_peer_bot_spoof', 'original case_03 spoof changed')
  check(sha256(aiBytes) === manifest.ai_sha256, 'reviewed AI fixture bytes changed')
  // These snapshots cover the complete scenario and seven entry points,
  // including inline/generated bodies, prompts, label and sender adaptations.
  // A change requires reviewing the full input inventory again, never silently
  // adding a broad replacement or treating this scan as classifier acceptance.
  const sources = ['real-agent/ai-scenario.sh', 'integration/lib/real-scenario.sh',
    ...[111, 112, 115, 120, 123, 191, 206].map((n, i) => `real-agent/test-${n}-fmk-real-ai-ac${[11, 12, 15, 20, 23, 91, 106][i]}.sh`)]
  check(JSON.stringify(manifest.prompt_input_sources.map((s: any) => s.path)) === JSON.stringify(sources), 'AI prompt/input source inventory changed')
  for (const source of manifest.prompt_input_sources) {
    check(source.reason?.length && sha256(readFileSync(join(tests, source.path))) === source.sha256, 'reviewed AI prompt/input source changed: ' + source.path)
  }
  check(JSON.stringify(manifest.criteria.map((c: any) => c.ac)) === '[11,12,15,20,23,91,106]'
    && manifest.criteria.every((c: any) => c.inputs?.length && c.review?.length), 'AI criteria audit inventory changed')
  return { canonical, ai, manifest }
}

if (import.meta.main) {
  try {
    const { manifest } = auditedAICorpus()
    console.log('recorded: AI input audit ' + JSON.stringify({ decision: 18, canonical_sha256: manifest.canonical_sha256,
      reviewed_cases: 15, changed_cases: ['hz_bang'], criteria: manifest.criteria.map((c: any) => c.ac) }))
  } catch (error) { console.error(error instanceof Error ? error.message : 'AI fixture audit failed'); process.exitCode = 1 }
}
