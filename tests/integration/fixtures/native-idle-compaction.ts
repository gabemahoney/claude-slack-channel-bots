/** Read-only native capability and observation adapter (b.omv decision 16).
 * No rollout flags, transcripts or queue records are manufactured here.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type TranscriptEntry } from './transcript-receipts.ts'

export const IDLE_OBSERVATION_MAX_MS = 45 * 60_000
export interface IdleCapability {
  supported: boolean; reason: string; minTokens?: number; fireAfterMs?: number; binarySha256: string
}
/** Recognize the installed program's native interactive idle implementation,
 * rather than treating its version number as a capability. Unknown changed
 * implementations fail closed for investigation, never become passing skips.
 * The native setting is a kill switch; only the actual fetched rollout value
 * can enable it. Default .9 of its required 1h cache is 54 minutes.
 */
export function idleCapability(binary: Buffer, globalConfig: any, settings: any, env: Record<string, string | undefined> = {}): IdleCapability {
  const binarySha256 = createHash('sha256').update(binary).digest('hex')
  const skip = (reason: string, extra = {}): IdleCapability => ({ supported: false, reason, binarySha256, ...extra })
  if (!binary.includes(Buffer.from('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS')) && !binary.includes(Buffer.from('tengu_idle_compact_fired'))) return skip('installed native binary has no interactive idle compaction setting or timer')
  // These fragments identify the audited semantics without assuming minified
  // variable names, a release number or the separate remote SleepCompactor.
  const code = binary.toString('latin1')
  const policy = code.match(/var ([\w$]+)=200000,([\w$]+)=1e5,([\w$]+)=0\.9,([\w$]+)=0\.5,([\w$]+)=0\.95,[\w$]+=60000;/)
  const body = policy ? code.slice(policy.index, policy.index! + 1100) : ''
  if (!policy || !body.includes('k("tengu_sunny_locket",null)')
    || !body.includes(`Math.max(${policy[2]},`) || !body.includes(`Math.min(${policy[5]},Math.max(${policy[4]},`)
    || !code.includes('Setting it to true does not turn idle compaction on.')
    || !/lastRequest\?\.ttl!=="1h"/.test(code) || !/lastActivityAt\+\([^)]*expiresAt-[^)]*lastActivityAt\)\*/.test(code)
    || !/mode:[\w$]+\?\.mode==="log"\|\|[\w$]+\?\.mode==="compact"\?[\w$]+\.mode:"off"/.test(code)) throw new Error('Installed native idle implementation changed; capability needs investigation')
  if (settings?.idleCompaction === false || settings?.autoCompactEnabled === false
    || /^(1|true|yes)$/i.test(env.DISABLE_AUTO_COMPACT ?? '') || /^(1|true|yes)$/i.test(env.DISABLE_COMPACT ?? '')) return skip('scenario settings disable native idle compaction')
  const flag = globalConfig?.cachedGrowthBookFeatures?.tengu_sunny_locket
  if (flag?.mode !== 'compact') return skip(`native interactive idle rollout mode is ${flag?.mode === 'log' ? 'log' : 'off'}; idleCompaction=true does not enable it`)
  const raw = env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS === undefined ? flag.minTokens : Number(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS)
  const minTokens = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(100_000, raw) : 200_000
  const fraction = typeof flag.fireAtFraction === 'number' && Number.isFinite(flag.fireAtFraction) ? Math.min(.95, Math.max(.5, flag.fireAtFraction)) : .9
  const fireAfterMs = 60 * 60_000 * fraction
  if (fireAfterMs > IDLE_OBSERVATION_MAX_MS) return skip(`native 1h cache timer fires after ${fireAfterMs / 60_000} minutes, beyond the 45 minute observation bound`, { minTokens, fireAfterMs })
  if (env.CLAUDE_CODE_PROMPT_CACHE_TTL !== '1h' && settings?.promptCacheTtl !== '1h') return skip('native interactive idle timer requires the scenario to request a 1h prompt cache', { minTokens, fireAfterMs })
  return { supported: true, reason: 'native interactive idle rollout and timer can fire within 45 minutes', minTokens, fireAfterMs, binarySha256 }
}
/** Current launch only: old usage/compactions cannot prepare or satisfy a new
 * idle trial. Usage is the latest real request's context, never summed calls.
 */
export function idleObservation(key: string, journal: readonly any[], log: readonly string[], entries: readonly TranscriptEntry[]) {
  const launches = log.flatMap(line => {
    const marker = '[slack] delivery-launch-observed: ', index = line.indexOf(marker)
    if (index < 0) return []
    const value = JSON.parse(line.slice(index + marker.length))
    return value.key === key ? [value] : []
  })
  const launch = launches.at(-1)
  if (!launch?.session_id) throw new Error('No current native launch observation')
  const own = personaTranscripts(key, journal, log, entries).filter(e => basename(e.path, '.jsonl') === launch.session_id && e.at >= launch.at)
  const boundaries = own.filter(e => e.value?.type === 'system' && (e.value.subtype === 'compact_boundary' || e.value.compactMetadata))
  const lastBoundaryAt = boundaries.at(-1)?.at ?? -Infinity
  const latest = own.filter(e => e.value?.type === 'assistant' && e.value.message?.usage && e.at >= lastBoundaryAt).at(-1)
  const usage = latest?.value.message.usage
  const contextTokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 0) throw new Error('Invalid native context usage')
  return { sessionId: launch.session_id, contextTokens, usageAt: latest?.at ?? null,
    boundaries: boundaries.length, lastBoundaryAt: boundaries.at(-1)?.at ?? null }
}
if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('native idle observations require the CI image')
    const [command, first, second, third] = process.argv.slice(2)
    if (command === 'capability' && first && second) {
      const global = join(second, '.claude.json'), settings = join(second, '.claude/settings.json')
      console.log(JSON.stringify(idleCapability(readFileSync(first), existsSync(global) ? JSON.parse(readFileSync(global, 'utf8')) : {}, existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}, process.env)))
    } else if (command === 'observe' && first && second && third) {
      const adapters = await packedReceiptAdapters()
      console.log(JSON.stringify(idleObservation(second, receiptJournal(first, second), readFileSync(join(first, 'server.log'), 'utf8').split('\n'), readTranscripts(transcriptFiles(third), adapters))))
    } else throw new Error('Usage: native-idle-compaction <capability binary HOME|observe state-dir key transcript-root>')
  } catch (error) { console.error(`native-idle-compaction: ${error instanceof Error ? error.message : 'unknown failure'}`); process.exit(1) }
}
