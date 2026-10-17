/** Read-only native capability and observation adapter (b.omv decision 16).
 * No rollout flags, transcripts or queue records are manufactured here.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type TranscriptEntry } from './transcript-receipts.ts'

export const IDLE_OBSERVATION_MAX_MS = 45 * 60_000
export interface IdleCapabilityProof {
  profile: 'native-idle-return-policy-302'
  mode: 'off' | 'log' | 'compact' | 'compact_on_return'
  conclusion: 'eligible' | 'settings-disabled' | 'rollout-inactive' | 'precompute-disabled' | 'remote-precompute-disabled' | 'timer-outside-bound' | 'cache-ttl-ineligible'
  observationMaxMs: number
  minTokens?: number; fireAfterMs?: number; applicationNotBeforeMs?: number; precomputeAfterMs?: number
  backgroundNoStartEvent?: true; cacheTtl?: '1h' | '5m'
  disabledBy?: ('idleCompaction' | 'autoCompactEnabled' | 'DISABLE_AUTO_COMPACT' | 'DISABLE_COMPACT' | 'precomputeCompactionEnabled' | 'tengu_reactive_compact_remote')[]; precomputeEnabled?: false; remotePrecomputeEnabled?: false
}
export interface IdleCapability {
  supported: boolean; reason: string; minTokens?: number; fireAfterMs?: number; binarySha256: string
  proof?: IdleCapabilityProof
}
// Decision 21: the audited return-policy implementation changed its mode
// selector, rollout-key indirection and typed environment access. Fingerprint
// its actual policy AND the settings/rollout/cache/parser dependencies audited
// beside it. A changed fragment requires investigation, never a passing skip.
// Captured source fragments are ~18 KiB; the compiled binary is not a fixture.
const AUDITED_IDLE_RETURN_POLICY = [
  ["var i1o=200000,", "var Ext=new lt(()=>new J2t);", "41c89bdfaaf804e7d33598b16233d32b067bb5a103afef32bbd55eb9d97e68b8"],
  ["function uh(){return Boolean(Ne(process.env.DISABLE_COMPACT)", "function dFs(){", "e5258fac052b94dc221ae6cb26c6ad694617b8ff3676a318d8db027365523b3d"],
  ["var g=/^[+-]?", "function JW(e){", "9091af4fa258032951da7468f05828db076931322f33d2868f3cd33208b7df17"],
  ["function i(n){return{parse:(e)=>n(u(e))}}", "export{u6s,H};", "c29f2ce20942a512f7edfd14191997eabf493e3f2708580f543695fb93bbea14"],
  ["function Ne(e){if(!e)return!1;if(typeof e===", "function fE(e){", "cd5df39c7e0a5ad6316000a8a3d2ace4e09ba838bf15fbdc807fb8f559cfd101"],
  ["function F7(e){return a.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", "function lpe(e,", "742e333e2ae864de7c4df32222b355af1daa1d5f4bb5592dd22181e6d53b0516"],
  ["var FU=300000,wx=3600000;", "var RLs=", "c06d3b21f535cc12f94cc04b71dbaa4204757d15afe5c455a907e0b69777ca57"],
  ["summary(e){let n=this.cacheReadTokens", "class M{#e=new Map;", "1efd612abb9a62d3fcf83fc57577b50b36064be6aea2001d7a4a002a6f66a125"],
  ["getFeatureValueWithSource(e,n){", "async checkGateCachedOrBlocking(e){", "1ca20dc6617d4fd62c492114a753fd65a68bc9e585a00af79f59aac03a6b19f3"],
  ["var AEe=[\"theme\",\"editorMode\"", "export{AEe,bs,Nq};", "4b47b14da8fbcd245b438c5362dd6dc8b2d4db9cf96068c558b3a9a2e5b377a5"],
  ["async function Jys(e,n){", "class zet extends Error", "809ebaaf46ccc235a0bcc9b4046b5193d5c36f02bd4bdc6515ada51b4eff9a63"],
  ["CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS:()=>gc,", "CLAUDE_CODE_IDLE_THRESHOLD_MINUTES:()=>Si,", "b083889a7837169891847d33fe3146db6984bde761bb1b9a30f8a54a8387243c"],
  ["gc=H.int({min:1,wholeValue:!0})", ",vc=H.str()", "6ddf7dd443ce03056a24909c822d99d1356e4ed4f63c21c2e439e3ced21dc979"],
  ["CLAUDE_CODE_PROMPT_CACHE_TTL:()=>$C,", "CLAUDE_CODE_PROPAGATE_TRACEPARENT:()=>CC,", "b1a3729009f92fa3f473b35cd0c9de0f9379ee2bd52bcccde8321c26ce96517c"],
  ["$C=H.enum(RZe),", "qC=H.enum(RZe),", "08cb2818e0c1176d6df1597f4ab41ebd47bae3f26510dc1dd8c2df8b946731b5"],
  ["var RZe=[\"5m\",\"1h\"];", "var q_=H.triBool()", "527f83c80d37e08911c1251da04f432c2da01605cc847dab046c4008477e6e7e"],
  ["idleCompaction:()=>M().optional().describe(", "switchModelsOnFlag:()=>", "98a4beff1ab34ad123e1f2ecf1a61e8210d9997cc8b2de62047327d7df76bcf2"],
  ["function Bqr(e,n){return{...e,abortController:n,onCompactEvent:void 0,onRetryStatus:void 0}}", "function wuo(e){", "d1d6abcc541e463c8ff1d8d9a868b0e5c95122a12d4883e2212d16cef96226f9"],
  ["function gbr(e){", ";return H.put(K,jt),!0}", "d28a86a5237df3e7125b3267b36b5c72e324fe5bdc6f20b5e659097ac9642b8d"],
  ["function Gqe(e,n){", "function qao(e){", "4888b0d9dba0680e27bf1bd44de269650753b53e0efc70810541b70f1153312f"],
  ["async function Euo(e){", "function Wqr(e,n,r,s){", "4b53152e2ca7f2d360efc4df0ef8fac4906b83c3a09aa9cda2a8a9981c97ecb0"],
  ["function X4(){", "function LDe(){", "c5bff88e53960c63af73537c95ff3ac39f27f29ab9fd9fdfae27df1682f8fea1"],
  ["CLAUDE_CODE_REMOTE:()=>TS,", "CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE:", "0d0c6a60ba20f8b93da53ad47761f7d6309abc5d0cb7a5d2f8a4d3dbb19e3c81"],
  ["TS=H.bool(),", "LS=H.bool(),", "a0836e10128312bff27305e8588cb3f995c73398312a4d190e41b0126b6fca5a"],
  ["DISABLE_AUTO_COMPACT:()=>UC,", "DISABLE_BRIEF_MODE_STOP_HOOK:", "4eaed1d729cc062e1d0b2f4741272e9f57408403e74ade29199558e462508bf5"],
  ["UC=H.bool(),", "xC=H.bool(),", "91566d1b3770c53a4af8dabcf835c00dd92a94694f99b37783f8a4d63a7e693e"],
  ["FORCE_PROMPT_CACHING_5M:()=>sD,", "FORCE_VCR:", "f9ee11aeef5061d1df1688fd3128a55a8ee358a38500854d8aa684e423948b11"],
  ["sD=H.bool(),", "CD=H.bool(),", "d52e7f6df95dc86b299c99e4252841a64ef8d470339b0e25c48859a7e5571d16"],
  ["CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL:()=>tD,", "CLAUDE_CODE_MODEL_CAPABILITIES:", "326d21a782c6b497a475b39945cff3a081c1bea66f38dc5321306cc3af377f59"],
  ["tD=H.enum([\"5m\"]),", "oD=H.bool(),", "988dcb99c646ff61960ab6e7c6061130941409e5fc0b68c255320cef54fa1283"],
  ["function SYr(e){", "async function*xRn(", "c312e962bbfb45e0e7ff8dfdaf96c12311acfb1340d6574287138024e7b29995"],
  ["iR=lbe(Q.querySource,{agentCacheTtlOverride:Q.agentCacheTtlOverride,", "let wL=!1,mT=", "a7c02cea35083d278016c31a7b91f2848de7f5f15538d0694c790f45ad258a43"],
] as const
function isAuditedIdleReturnPolicy(code: string): boolean {
  return AUDITED_IDLE_RETURN_POLICY.every(([start, end, sha256]) => {
    const offset = code.indexOf(start)
    if (offset < 0 || code.indexOf(start, offset + 1) !== -1) return false
    const finish = code.indexOf(end, offset)
    if (finish < 0 || finish + end.length - offset > 12_000) return false
    return createHash('sha256').update(Buffer.from(code.slice(offset, finish + end.length), 'latin1')).digest('hex') === sha256
  })
}
// Mirror the audited typed getter: a whole positive integer, including integer
// scientific notation and consistently grouped thousands, or undefined. An
// invalid override falls through to the genuine rollout value, not to zero.
function idleMinimumOverride(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  let parsed: number | undefined
  if (/^[+-]?\d+$/.test(text)) parsed = Number.parseInt(text, 10)
  else if (text.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text)) {
    const numeric = Number(text)
    if (Number.isInteger(numeric)) parsed = numeric
  } else if (text.length <= 32 && /^[+-]?\d{1,3}([_,\u00a0\u202f ])\d{3}(?:\1\d{3})*$/.test(text)) parsed = Number.parseInt(text.replace(/[_,\u00a0\u202f ]/g, ''), 10)
  return parsed !== undefined && Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined
}
const nativeBoolean = (value: string | undefined): boolean => ['1','true','yes','on'].includes((value ?? '').trim().toLowerCase())

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
  // Preserve the earlier structural policy recognizer; the changed policy
  // additionally requires all captured implementation dependencies above.
  const code = binary.toString('latin1')
  const policy = code.match(/var ([\w$]+)=200000,([\w$]+)=1e5,([\w$]+)=0\.9,([\w$]+)=0\.5,([\w$]+)=0\.95,[\w$]+=60000;/)
  const body = policy ? code.slice(policy.index, policy.index! + 1100) : ''
  const returnPolicy = isAuditedIdleReturnPolicy(code)
  const legacyPolicy = !!policy && body.includes('k("tengu_sunny_locket",null)')
    && body.includes(`Math.max(${policy[2]},`) && body.includes(`Math.min(${policy[5]},Math.max(${policy[4]},`)
    && code.includes('Setting it to true does not turn idle compaction on.')
    && /lastRequest\?\.ttl!=="1h"/.test(code) && /lastActivityAt\+\([^)]*expiresAt-[^)]*lastActivityAt\)\*/.test(code)
    && /mode:[\w$]+\?\.mode==="log"\|\|[\w$]+\?\.mode==="compact"\?[\w$]+\.mode:"off"/.test(code)
  if (!returnPolicy && !legacyPolicy) throw new Error('Installed native idle implementation changed; capability needs investigation')
  const features = globalConfig?.cachedGrowthBookFeatures
  if (returnPolicy && (!features || typeof features !== 'object' || !Object.hasOwn(features, 'tengu_sunny_locket'))) throw new Error('Native idle rollout value unavailable; capability needs investigation')
  const flag = features?.tengu_sunny_locket
  const mode: IdleCapabilityProof['mode'] = flag?.mode === 'compact' || flag?.mode === 'log' || returnPolicy && flag?.mode === 'compact_on_return' ? flag.mode : 'off'
  const proof = (conclusion: IdleCapabilityProof['conclusion'], extra: Partial<IdleCapabilityProof> = {}): IdleCapabilityProof | undefined => returnPolicy
    ? { profile: 'native-idle-return-policy-302', mode, conclusion, observationMaxMs: IDLE_OBSERVATION_MAX_MS, ...extra } : undefined
  const refuse = (reason: string, conclusion: IdleCapabilityProof['conclusion'], extra: Partial<IdleCapabilityProof> = {}) => skip(reason, {
    ...(extra.minTokens !== undefined && { minTokens: extra.minTokens }),
    ...(extra.fireAfterMs !== undefined && { fireAfterMs: extra.fireAfterMs }),
    ...(returnPolicy && { proof: proof(conclusion, extra) }),
  })
  const autoCompactEnabled = returnPolicy && typeof settings?.autoCompactEnabled !== 'boolean' ? globalConfig?.autoCompactEnabled : settings?.autoCompactEnabled
  const boolean = returnPolicy ? nativeBoolean : (value: string | undefined) => /^(1|true|yes)$/i.test(value ?? '')
  const disabledBy = [settings?.idleCompaction === false && 'idleCompaction', autoCompactEnabled === false && 'autoCompactEnabled',
    boolean(env.DISABLE_AUTO_COMPACT) && 'DISABLE_AUTO_COMPACT', boolean(env.DISABLE_COMPACT) && 'DISABLE_COMPACT'].filter((value): value is NonNullable<IdleCapabilityProof['disabledBy']>[number] => typeof value === 'string')
  if (disabledBy.length) return refuse('scenario settings disable native idle compaction', 'settings-disabled', { disabledBy })
  const compactOnReturn = mode === 'compact_on_return'
  if (mode !== 'compact' && !compactOnReturn) return refuse(`native interactive idle rollout mode is ${mode}; idleCompaction=true does not enable it`, 'rollout-inactive')
  if (compactOnReturn && settings?.precomputeCompactionEnabled === false) return refuse('native compact_on_return requires precomputeCompactionEnabled', 'precompute-disabled', { precomputeEnabled: false, disabledBy: ['precomputeCompactionEnabled'] })
  if (compactOnReturn && nativeBoolean(env.CLAUDE_CODE_REMOTE)) {
    if (!Object.hasOwn(features, 'tengu_reactive_compact_remote')) throw new Error('Native remote idle rollout value unavailable; capability needs investigation')
    if (!features.tengu_reactive_compact_remote) return refuse('native compact_on_return is disabled by the remote precompute rollout', 'remote-precompute-disabled', { remotePrecomputeEnabled: false, disabledBy: ['tengu_reactive_compact_remote'] })
  }
  const raw = returnPolicy ? idleMinimumOverride(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) ?? flag.minTokens
    : env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS === undefined ? flag.minTokens : Number(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS)
  const minTokens = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(100_000, raw) : 200_000
  const fraction = typeof flag.fireAtFraction === 'number' && Number.isFinite(flag.fireAtFraction) ? Math.min(.95, Math.max(.5, flag.fireAtFraction)) : .9
  const fireAfterMs = 60 * 60_000 * fraction
  if (returnPolicy) {
    const ttlOverride = env.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim()
    const requestedTtl = nativeBoolean(env.FORCE_PROMPT_CACHING_5M) ? '5m'
      : ttlOverride === '1h' || ttlOverride === '5m' ? ttlOverride : settings?.promptCacheTtl
    // The message-level typed override downgrades the actual request journal
    // TTL to 5m at the native request boundary, preventing the idle timer.
    const ttl = env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL?.trim() === '5m' ? '5m' : requestedTtl
    if (ttl !== '1h' && ttl !== '5m') throw new Error('Native idle prompt cache TTL unavailable; capability needs investigation')
    if (ttl !== '1h') return refuse('native interactive idle timer requires the scenario to request a 1h prompt cache', 'cache-ttl-ineligible', { minTokens, fireAfterMs, ...(ttl === '5m' && { cacheTtl: ttl }) })
  } else if (env.CLAUDE_CODE_PROMPT_CACHE_TTL !== '1h' && settings?.promptCacheTtl !== '1h') return skip('native interactive idle timer requires the scenario to request a 1h prompt cache', { minTokens, fireAfterMs })
  // Background summaries intentionally suppress compact events. The native
  // return path discards even a ready idle summary until lastWarmAt + 1h.
  // It cannot satisfy an observed compaction start within this trial bound.
  if (compactOnReturn) return refuse('native compact_on_return applies only after the required 1h cache expires; background summary emits no compaction-start event, beyond the 45 minute observation bound', 'timer-outside-bound', { minTokens, fireAfterMs: 60 * 60_000, applicationNotBeforeMs: 60 * 60_000, precomputeAfterMs: fireAfterMs, backgroundNoStartEvent: true, cacheTtl: '1h' })
  if (fireAfterMs > IDLE_OBSERVATION_MAX_MS) return refuse(`native 1h cache timer fires after ${fireAfterMs / 60_000} minutes, beyond the 45 minute observation bound`, 'timer-outside-bound', { minTokens, fireAfterMs, ...(returnPolicy && { cacheTtl: '1h' as const }) })
  return { supported: true, reason: 'native interactive idle rollout and timer can fire within 45 minutes', minTokens, fireAfterMs, binarySha256, ...(returnPolicy && { proof: proof('eligible', { minTokens, fireAfterMs, cacheTtl: '1h' }) }) }
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
