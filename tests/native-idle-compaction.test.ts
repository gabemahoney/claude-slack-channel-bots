/** Decision 16's read-only capability/refusal and own-launch observation contract.
 * Real native binaries are checked separately in the container self-check.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { idleCapability, idleObservation, IDLE_OBSERVATION_MAX_MS } from './integration/fixtures/native-idle-compaction.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'
import { sentRecord } from './test-helpers/delivery-queue.ts'

// Minimal synthetic policy text for deterministic changed-semantics controls;
// this is never installed, executed or supplied to a real acceptance scenario.
const policy = Buffer.from([
  'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS', 'tengu_idle_compact_fired',
  'var A=200000,B=1e5,C=0.9,D=0.5,E=0.95,F=60000;',
  'k("tengu_sunny_locket",null)', 'Math.max(B,minTokens)', 'Math.min(E,Math.max(D,fraction))',
  'Setting it to true does not turn idle compaction on.', 'lastRequest?.ttl!=="1h"',
  'lastActivityAt+(cache.expiresAt-cache.lastActivityAt)*fraction',
  'mode:flag?.mode==="log"||flag?.mode==="compact"?flag.mode:"off"',
].join('\n'))
const env = { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }
const rollout = (flag: unknown = { mode: 'compact', fireAtFraction: .5 }) => ({ cachedGrowthBookFeatures: { tengu_sunny_locket: flag } })
const capability = (flag?: unknown, settings = {}, overrides = {}) => idleCapability(policy, rollout(flag), settings, { ...env, ...overrides })

describe('native idle capability', () => {
  test('a genuine eligible policy uses its native 100k floor and 30-minute timer, with a binary digest', () => {
    expect(IDLE_OBSERVATION_MAX_MS).toBe(45 * 60_000)
    expect(capability()).toMatchObject({ supported: true, minTokens: 100_000, fireAfterMs: 30 * 60_000 })
    expect(capability().binarySha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test.each([undefined, {}, { mode: 'off' }, { mode: 'log' }])('records rollout %j as impossible even with idleCompaction=true', flag => {
    const result = idleCapability(policy, rollout(flag ?? {}), { idleCompaction: true }, env)
    expect(result.supported).toBe(false)
    expect(result.reason).toContain('does not enable')
  })

  test.each([
    [undefined, 54, false], [.49, 30, true], [.5, 30, true], [.75, 45, true], [.751, 45.06, false], [1, 57, false],
  ])('native fraction %j records %s minutes and eligibility=%s', (fraction, minutes, supported) => {
    const result = capability({ mode: 'compact', fireAtFraction: fraction })
    expect(result.fireAfterMs).toBeCloseTo(minutes * 60_000)
    expect(result.supported).toBe(supported)
    if (!supported) expect(result.reason).toContain('45 minute')
  })

  test.each([
    ['1', 100_000], ['120000', 120_000], ['not-a-number', 200_000], [undefined, 200_000],
  ])('min-token setting %j preserves the native floor/fallback %s', (minimum, expected) => {
    expect(capability(undefined, {}, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: minimum }).minTokens).toBe(expected)
  })

  test.each([
    [{ idleCompaction: false }, {}], [{ autoCompactEnabled: false }, {}],
    [{}, { DISABLE_AUTO_COMPACT: 'true' }], [{}, { DISABLE_COMPACT: '1' }],
  ])('disabled scenario settings/environment %j %j record a refusal', (settings, overrides) => {
    expect(capability(undefined, settings, overrides)).toMatchObject({ supported: false, reason: 'scenario settings disable native idle compaction' })
  })

  test('the native one-hour TTL is required, and the setting is also recognized', () => {
    expect(capability(undefined, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: undefined }).supported).toBe(false)
    expect(capability(undefined, { promptCacheTtl: '1h' }, { CLAUDE_CODE_PROMPT_CACHE_TTL: undefined }).supported).toBe(true)
  })

  test('missing native feature symbols records unsupported; changed feature semantics fail rather than skip', () => {
    expect(idleCapability(Buffer.from('unrelated native program'), {}, {}, env)).toMatchObject({ supported: false })
    for (const altered of [Buffer.from('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'), Buffer.from(policy.toString().replace('B=1e5', 'B=5e4'))])
      expect(() => idleCapability(altered, rollout(), {}, env)).toThrow('needs investigation')
  })
})

describe('native idle current-launch observation', () => {
  const path = '/scratch/owned/current.jsonl'
  const sent = { ...sentRecord(), session_id: 'current', transcript_path: path }
  const launches = [
    '[slack] delivery-launch-observed: '+JSON.stringify({ key: 'control', session_id: 'old', at: 100 }),
    '[slack] delivery-launch-observed: '+JSON.stringify({ key: 'control', session_id: 'current', at: 200 }),
    '[slack] delivery-launch-observed: '+JSON.stringify({ key: 'other', session_id: 'foreign', at: 300 }),
  ]
  const entry = (at: number, value: any, ownPath = path): TranscriptEntry => ({ at, path: ownPath, offset: at, kind: 'other', value })
  const usage = (at: number, input: number, read = 0, created = 0, ownPath = path) => entry(at, { type: 'assistant', sessionId: 'current',
    message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: created, output_tokens: 9000 } } }, ownPath)
  const boundary = (at: number, ownPath = path) => entry(at, { type: 'system', subtype: 'compact_boundary', sessionId: 'current' }, ownPath)
  const observe = (entries: TranscriptEntry[], journal = [sent], log = launches) => idleObservation('control', journal, log, entries)

  test('uses only the latest request context, excluding output and all older calls', () => {
    expect(observe([usage(150, 999999), usage(210, 90000), usage(220, 2, 3, 5)])).toEqual({
      sessionId: 'current', contextTokens: 10, usageAt: 220, boundaries: 0, lastBoundaryAt: null,
    })
  })

  test('old launches, foreign directories/sessions and subagents cannot provide budget or a compaction boundary', () => {
    const foreign = [usage(220, 999999, 0, 0, '/scratch/owned/old.jsonl'), usage(230, 999999, 0, 0, '/scratch/foreign/current.jsonl'),
      usage(240, 999999, 0, 0, '/scratch/owned/subagents/current.jsonl'),
      { ...usage(250, 999999), value: { ...usage(250, 999999).value, sessionId: 'foreign' } },
      boundary(260, '/scratch/foreign/current.jsonl'), boundary(270, '/scratch/owned/old.jsonl'), boundary(280, '/scratch/owned/subagents/current.jsonl')]
    expect(observe([usage(210, 123), ...foreign])).toEqual({ sessionId: 'current', contextTokens: 123, usageAt: 210, boundaries: 0, lastBoundaryAt: null })
  })

  test('a new own boundary discards pre-compaction context until a new request records usage', () => {
    expect(observe([usage(210, 120000), boundary(220)])).toEqual({ sessionId: 'current', contextTokens: 0, usageAt: null, boundaries: 1, lastBoundaryAt: 220 })
    expect(observe([usage(210, 120000), boundary(220), usage(230, 300)])).toMatchObject({ contextTokens: 300, usageAt: 230, boundaries: 1, lastBoundaryAt: 220 })
  })

  test('current directory ownership must be established by an actual durable send', () => {
    expect(observe([usage(220, 120000), boundary(230)], [])).toMatchObject({ contextTokens: 0, boundaries: 0 })
    expect(() => observe([], [sent], launches.filter(l => !l.includes('"key":"control"')))).toThrow('No current native launch')
  })

  test.each([-1, NaN, 1.5, Infinity])('invalid current input usage %s fails closed', input => {
    expect(() => observe([usage(220, input)])).toThrow('Invalid native context usage')
  })
})


// Decision 21(a): exact read-only fragments from the audited official 2.1.302
// linux-x64 executable. This fixture is data; no native binary is vendored or run.
const nativeFixtureDir = join(import.meta.dir, 'fixtures/native-idle-compaction')
const captured302 = readFileSync(join(nativeFixtureDir, 'native302-captured-idle-policy.txt'))
const capturedProvenance = JSON.parse(readFileSync(join(nativeFixtureDir, 'native302-provenance.json'), 'utf8'))
type NativeFragment = { name: string; binaryOffset: number; fixtureOffset: number; bytes: number; sha256: string; start: string; end: string }
const nativeFragments = capturedProvenance.fragments as NativeFragment[]
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function capturedFragment(name: string) {
  const item = nativeFragments.find(fragment => fragment.name === name)!
  return captured302.subarray(item.fixtureOffset, item.fixtureOffset + item.bytes).toString('latin1')
}
function nativeFunctionBody(name: string) {
  const item = nativeFragments.find(fragment => fragment.name === name)!
  return capturedFragment(name).slice(0, -item.end.length)
}
const capturedBoolean = new Function(nativeFunctionBody('boolean-parser') + ';return Ne')() as (value: string | undefined) => boolean
const capturedTyped = new Function(nativeFunctionBody('boolean-parser') + nativeFunctionBody('integer-parser')
  + nativeFunctionBody('environment-parser') + ';return H')() as { int: (options: unknown) => { parse: (value: string | undefined) => number | undefined }; enum: (values: string[]) => { parse: (value: string | undefined) => string | undefined } }
const capturedMinimum = capturedTyped.int({ min: 1, wholeValue: true }).parse
const native302 = (flag: unknown = { mode: 'compact', fireAtFraction: .5 }, settings: Record<string, unknown> = {}, overrides: Record<string, string | undefined> = {}) =>
  idleCapability(captured302, rollout(flag), { promptCacheTtl: '1h', ...settings }, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000', ...overrides })

const captured303 = readFileSync(join(nativeFixtureDir, 'native303-captured-idle-policy.txt'))
const provenance303 = JSON.parse(readFileSync(join(nativeFixtureDir, 'native303-provenance.json'), 'utf8'))
const fragments303 = provenance303.fragments as NativeFragment[]

describe('captured native 2.1.303 idle policy', () => {
  test('all 32 official-release fragments preserve the audit and the single identifier-only change', () => {
    expect(sha256(readFileSync(join(nativeFixtureDir, 'native303-provenance.json')))).toBe('54c00d5edbb93baa912c2cc703084aac731aede73078328daa98388c584ef70e')
    expect(captured303.length).toBe(18_822)
    expect(sha256(captured303)).toBe('717f69dcd8cadddaa156571f5ea85cdc6bdb3a231923a1e337b2cfb9a5917636')
    const manifest = readFileSync(join(nativeFixtureDir, provenance303.releaseManifest.file))
    expect(sha256(manifest)).toBe(provenance303.releaseManifest.sha256)
    expect(JSON.parse(manifest.toString()).platforms['linux-x64']).toEqual({ binary: 'claude',
      checksum: '375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450', size: 285_809_912 })
    expect(provenance303).toMatchObject({ version: '2.1.303', captureVerifiedAgainstBinaryOffsets: true,
      binaryExecutedByFixtureCapture: false, binaryVendored: false })
    expect(fragments303).toHaveLength(32)
    for (const fragment of fragments303) {
      const bytes = captured303.subarray(fragment.fixtureOffset, fragment.fixtureOffset + fragment.bytes)
      expect(sha256(bytes)).toBe(fragment.sha256)
      expect(bytes.toString('latin1').startsWith(fragment.start)).toBe(true)
      expect(bytes.toString('latin1').endsWith(fragment.end)).toBe(true)
      expect(fragment.binaryOffset).toBeGreaterThanOrEqual(0)
      expect(fragment.binaryOffset + fragment.bytes).toBeLessThanOrEqual(provenance303.binaryBytes)
      const prior = capturedFragment(fragment.name)
      expect(bytes.toString('latin1')).toBe(fragment.name === 'environment-parser'
        ? prior.replaceAll('u6s', 'u5s') : prior)
    }
  })

  test('the pre-fix detector rejects the captured executable while the repaired detector proves its timing', () => {
    const previous = readFileSync(join(nativeFixtureDir, provenance303.previousDetector.file), 'utf8')
    expect(sha256(previous)).toBe(provenance303.previousDetector.sha256)
    const body = previous.slice(previous.indexOf('const AUDITED_IDLE_RETURN_POLICY'), previous.indexOf('/** Current launch'))
    const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(body.replace('export function idleCapability', 'function idleCapability'))
    const oldCapability = new Function('createHash', 'IDLE_OBSERVATION_MAX_MS', compiled + ';return idleCapability')(createHash, IDLE_OBSERVATION_MAX_MS) as typeof idleCapability
    expect(() => oldCapability(captured303, rollout(), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
    expect(idleCapability(captured303, rollout({ mode: 'compact_on_return' }), { promptCacheTtl: '1h' }, env)).toMatchObject({
      supported: false, proof: { profile: 'native-idle-return-policy-303', conclusion: 'timer-outside-bound',
        applicationNotBeforeMs: 3_600_000, backgroundNoStartEvent: true, observationMaxMs: 2_700_000 } })
  })

  test.each(fragments303.map(fragment => [fragment.name, fragment] as const))('a changed %s dependency still fails closed', (_name, fragment) => {
    const changed = Buffer.from(captured303)
    changed[fragment.fixtureOffset + Math.floor(fragment.bytes / 2)]! ^= 1
    expect(() => idleCapability(changed, rollout(), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
  })

  test('an unaudited parser rename, missing dependency or duplicate policy is not accepted', () => {
    const policy = fragments303[0]!
    for (const changed of [
      Buffer.from(captured303.toString('latin1').replaceAll('u5s', 'futureParser'), 'latin1'),
      captured303.subarray(policy.bytes),
      Buffer.concat([captured303, captured303.subarray(0, policy.bytes)]),
    ]) expect(() => idleCapability(changed, rollout(), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
  })

  test('the audited policy preserves every mode, bound, override and disabling-setting outcome', () => {
    for (const mode of ['off', 'log', 'compact', 'compact_on_return'])
      for (const fraction of [undefined, .5, .75, .751, 1])
        for (const overrides of [{}, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100_001' },
          { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, { DISABLE_AUTO_COMPACT: ' on ' }, { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '5m' }])
          for (const settings of [{}, { idleCompaction: false }, { precomputeCompactionEnabled: false }]) {
            const args = [rollout({ mode, fireAtFraction: fraction }), { promptCacheTtl: '1h', ...settings }, { ...env, ...overrides }] as const
            const prior = idleCapability(captured302, ...args)
            expect(idleCapability(captured303, ...args)).toEqual({ ...prior, binarySha256: sha256(captured303),
              proof: prior.proof && { ...prior.proof, profile: 'native-idle-return-policy-303' } })
          }
    expect(() => idleCapability(captured303, {}, { promptCacheTtl: '1h' }, env)).toThrow('rollout value unavailable')
  })
})

describe('captured native 2.1.302 idle policy', () => {
  test('fixture and all 32 fragments retain their audited official-release provenance', () => {
    expect(sha256(readFileSync(join(nativeFixtureDir, 'native302-provenance.json')))).toBe('56b2154ce1e63811934d7da0aca82ea1e5aa2a9fbf66d74ffa4dfe57f704802c')
    expect(captured302.length).toBe(18_822)
    expect(sha256(captured302)).toBe('1d58f5600544f1a7fae986cda3493ea212154be8796ba3255b5c63e8936c0933')
    expect(capturedProvenance.capturedFixture).toEqual({ file: 'native302-captured-idle-policy.txt', bytes: captured302.length, sha256: sha256(captured302) })
    expect(capturedProvenance).toMatchObject({ version: '2.1.302', platform: 'linux-x64', binaryBytes: 285_793_528,
      binarySha256: '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5',
      captureVerifiedAgainstBinaryOffsets: true, binaryExecutedByFixtureCapture: false, binaryVendored: false })
    const releaseBytes = readFileSync(join(nativeFixtureDir, capturedProvenance.releaseManifest.file))
    expect(sha256(releaseBytes)).toBe(capturedProvenance.releaseManifest.sha256)
    expect(JSON.parse(releaseBytes.toString()).platforms['linux-x64']).toEqual({ binary: 'claude', checksum: capturedProvenance.binarySha256, size: capturedProvenance.binaryBytes })
    expect(nativeFragments).toHaveLength(32)
    for (const item of nativeFragments) {
      const bytes = captured302.subarray(item.fixtureOffset, item.fixtureOffset + item.bytes)
      expect(bytes.length).toBe(item.bytes)
      expect(sha256(bytes)).toBe(item.sha256)
      expect(bytes.toString('latin1').startsWith(item.start)).toBe(true)
      expect(bytes.toString('latin1').endsWith(item.end)).toBe(true)
      expect(item.binaryOffset).toBeGreaterThanOrEqual(0)
      expect(item.binaryOffset + item.bytes).toBeLessThanOrEqual(capturedProvenance.binaryBytes)
    }
    expect(capturedProvenance.supersededCombinedFixtureMetadata).toMatchObject({ bytes: 9428,
      sha256: 'bc085bcecf5792f32721d2093866ac3196b7eb8050110c4fb61c51324fe0ba12' })
  })

  test('the previous detector rejects these actual native bytes; the repaired detector recognizes the live mode', () => {
    const previous = readFileSync(join(nativeFixtureDir, capturedProvenance.previousDetector.file), 'utf8')
    expect(sha256(previous)).toBe(capturedProvenance.previousDetector.sha256)
    const body = previous.slice(previous.indexOf('export function idleCapability('), previous.indexOf('/** Current launch'))
    const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(body.replace('export function', 'function'))
    const oldCapability = new Function('createHash', 'IDLE_OBSERVATION_MAX_MS', compiled + ';return idleCapability')(createHash, IDLE_OBSERVATION_MAX_MS) as typeof idleCapability
    expect(() => oldCapability(captured302, rollout({ mode: 'compact_on_return' }), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
    expect(native302({ mode: 'compact_on_return', fireAtFraction: .5 })).toMatchObject({ supported: false,
      proof: { mode: 'compact_on_return', conclusion: 'timer-outside-bound', applicationNotBeforeMs: 3_600_000 } })
  })

  test.each(nativeFragments.map(item => [item.name, item] as const))('changed audited %s dependency requires investigation', (_name, item) => {
    const changed = Buffer.from(captured302)
    changed[item.fixtureOffset + Math.floor(item.bytes / 2)]! ^= 1
    expect(() => idleCapability(changed, rollout(), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
  })

  test('a missing or duplicate captured policy cannot masquerade as a capability skip', () => {
    const item = nativeFragments[0]!
    const missing = Buffer.concat([captured302.subarray(0, item.fixtureOffset), captured302.subarray(item.fixtureOffset + item.bytes)])
    const duplicated = Buffer.concat([captured302, captured302.subarray(item.fixtureOffset, item.fixtureOffset + item.bytes)])
    for (const changed of [missing, duplicated]) expect(() => idleCapability(changed, rollout(), { promptCacheTtl: '1h' }, env)).toThrow('needs investigation')
  })

  test.each([{}, { cachedGrowthBookFeatures: {} }, { cachedGrowthBookFeatures: null },
    { cachedGrowthBookFeatures: Object.create({ tengu_sunny_locket: { mode: 'compact' } }) }])('missing actual rollout %j throws instead of passing a skip', config => {
    expect(() => idleCapability(captured302, config, { promptCacheTtl: '1h' }, env)).toThrow('rollout value unavailable')
  })

  test.each(['off', 'log', 'future-mode'])('actual inactive rollout %s retains a structured witness', mode => {
    const result = native302({ mode }, { idleCompaction: true })
    expect(result.supported).toBe(false)
    expect(result.proof).toEqual({ profile: 'native-idle-return-policy-302', mode: mode === 'future-mode' ? 'off' : mode,
      conclusion: 'rollout-inactive', observationMaxMs: 2_700_000 })
  })

  test.each([[.5, 1_800_000, true], [.75, 2_700_000, true], [.751, 2_703_600, false], [undefined, 3_240_000, false], [1, 3_420_000, false]] as const)(
    'ordinary compact fraction %s retains its actual timer and bound verdict', (fraction, timer, supported) => {
      const result = native302({ mode: 'compact', fireAtFraction: fraction })
      expect(result.supported).toBe(supported)
      expect(result.minTokens).toBe(100_000)
      expect(result.fireAfterMs).toBeCloseTo(timer)
      expect(result.proof).toEqual({ profile: 'native-idle-return-policy-302', mode: 'compact', conclusion: supported ? 'eligible' : 'timer-outside-bound',
        observationMaxMs: IDLE_OBSERVATION_MAX_MS, minTokens: result.minTokens, fireAfterMs: result.fireAfterMs, cacheTtl: '1h' })
    },
  )

  test.each([[.5, 1_800_000], [.75, 2_700_000], [undefined, 3_240_000], [1, 3_420_000]] as const)(
    'compact_on_return fraction %s is live but cannot apply before one hour', (fraction, precomputeAfterMs) => {
      const result = native302({ mode: 'compact_on_return', fireAtFraction: fraction })
      expect(result).toEqual({ supported: false, reason: expect.any(String), binarySha256: sha256(captured302), minTokens: 100_000, fireAfterMs: 3_600_000,
        proof: { profile: 'native-idle-return-policy-302', mode: 'compact_on_return', conclusion: 'timer-outside-bound', observationMaxMs: 2_700_000,
          minTokens: 100_000, fireAfterMs: 3_600_000, applicationNotBeforeMs: 3_600_000, precomputeAfterMs,
          backgroundNoStartEvent: true, cacheTtl: '1h' } })
      expect(result.fireAfterMs).toBeGreaterThan(IDLE_OBSERVATION_MAX_MS)
    },
  )

  test('all disabled settings/environment witnesses are retained, including native trimmed on', () => {
    const result = native302(undefined, { idleCompaction: false, autoCompactEnabled: false }, { DISABLE_AUTO_COMPACT: ' ON ', DISABLE_COMPACT: ' yes ' })
    expect(result.proof).toEqual({ profile: 'native-idle-return-policy-302', mode: 'compact', conclusion: 'settings-disabled', observationMaxMs: 2_700_000,
      disabledBy: ['idleCompaction', 'autoCompactEnabled', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'] })
    expect(result.supported).toBe(false)
  })

  test('explicit settings take precedence over legacy auto-compact config', () => {
    const config = { ...rollout(), autoCompactEnabled: false }
    expect(idleCapability(captured302, config, { promptCacheTtl: '1h' }, env).proof?.disabledBy).toEqual(['autoCompactEnabled'])
    expect(idleCapability(captured302, config, { autoCompactEnabled: true, promptCacheTtl: '1h' }, env).supported).toBe(true)
  })

  test('precompute and fetched remote rollout refusals carry their actual witnesses', () => {
    expect(native302({ mode: 'compact_on_return' }, { precomputeCompactionEnabled: false }).proof).toEqual({
      profile: 'native-idle-return-policy-302', mode: 'compact_on_return', conclusion: 'precompute-disabled', observationMaxMs: 2_700_000,
      precomputeEnabled: false, disabledBy: ['precomputeCompactionEnabled'] })
    const config = { cachedGrowthBookFeatures: { tengu_sunny_locket: { mode: 'compact_on_return' }, tengu_reactive_compact_remote: false } }
    expect(idleCapability(captured302, config, { promptCacheTtl: '1h' }, { CLAUDE_CODE_REMOTE: ' on ' }).proof).toEqual({
      profile: 'native-idle-return-policy-302', mode: 'compact_on_return', conclusion: 'remote-precompute-disabled', observationMaxMs: 2_700_000,
      remotePrecomputeEnabled: false, disabledBy: ['tengu_reactive_compact_remote'] })
    expect(() => native302({ mode: 'compact_on_return' }, {}, { CLAUDE_CODE_REMOTE: ' on ' })).toThrow('remote idle rollout value unavailable')
  })

  test.each([
    ['1', 1], [' +120000 ', 120000], ['1e5', 100000], ['1.5E5', 150000], ['100_000', 100000], ['100,000', 100000],
    ['100 000', 100000], ['100\u00a0000', 100000], ['100\u202f000', 100000], ['1_000_000', 1000000],
    ['0', undefined], ['-1', undefined], ['1.5', undefined], ['120000junk', undefined], ['100_000,000', undefined],
    ['1e-1', undefined], ['1e309', undefined], ['NaN', undefined], ['', undefined], [undefined, undefined],
  ] as const)('minimum override %s follows the captured typed parser and falls back to rollout', (value, expected) => {
    expect(capturedMinimum(value)).toBe(expected)
    const result = native302({ mode: 'compact', fireAtFraction: .5, minTokens: 120_000 }, {}, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: value })
    expect(result.minTokens).toBe(expected === undefined ? 120_000 : Math.max(100_000, expected))
    expect(result.proof?.minTokens).toBe(result.minTokens)
  })

  test.each(['1', 'true', ' YES ', ' On ', '0', 'false', ' no ', 'OFF', 'invalid', undefined])('boolean %s follows the captured native parser', value => {
    const disabled = capturedBoolean(value)
    const result = native302(undefined, {}, { DISABLE_AUTO_COMPACT: value })
    expect(result.supported).toBe(!disabled)
    expect(result.proof?.conclusion).toBe(disabled ? 'settings-disabled' : 'eligible')
    if (disabled) expect(result.proof?.disabledBy).toEqual(['DISABLE_AUTO_COMPACT'])
  })

  test.each([
    [{}, { CLAUDE_CODE_PROMPT_CACHE_TTL: ' 1h ' }, '1h', true],
    [{}, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, '5m', false],
    [{ promptCacheTtl: '5m' }, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, '1h', true],
    [{}, { CLAUDE_CODE_PROMPT_CACHE_TTL: 'unknown' }, '1h', true],
    [{}, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', FORCE_PROMPT_CACHING_5M: ' ON ' }, '5m', false],
  ] as const)('TTL settings/environment %j %j follow native precedence', (settings, overrides, ttl, supported) => {
    const result = native302(undefined, settings, overrides)
    expect(result.supported).toBe(supported)
    expect(result.proof?.cacheTtl).toBe(ttl)
    expect(result.proof?.conclusion).toBe(supported ? 'eligible' : 'cache-ttl-ineligible')
  })

  test.each(['compact', 'compact_on_return'])('per-message 5m TTL prevents the %s one-hour timer', mode => {
    const result = native302({ mode, fireAtFraction: .5 }, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: ' 5m ' })
    expect(result.supported).toBe(false)
    expect(result.proof).toMatchObject({ profile: 'native-idle-return-policy-302', mode, conclusion: 'cache-ttl-ineligible', cacheTtl: '5m' })
  })

  test.each(['5m', ' 5m ', '1h', 'invalid', undefined])('actual typed per-message TTL %s updates the native request journal', value => {
    let journalTtlMs = 0
    const parsed = capturedTyped.enum(['5m']).parse(value)
    const resolver = capturedFragment('cache-ttl').split('function ytn(')[0]
    const deps = { a: { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: parsed }, l: () => {}, F: (error: unknown) => error,
      TJn: (ttl: number) => { journalTtlMs = ttl }, FU: 300_000, wx: 3_600_000,
      Q: { querySource: 'sdk', agentCacheTtlOverride: undefined, model: 'isolated-native-policy' }, fi: true, Moe: false, zt: 'isolated-native-policy',
      lbe: () => ({ ttl: '1h', reason: 'fixture' }), $zo: (ttl: number) => { journalTtlMs = ttl } }
    const source = 'const {a,l,F,TJn,FU,wx,Q,fi,Moe,zt,lbe,$zo}=deps;' + resolver + nativeFunctionBody('messages-ttl-boundary')
      + 'let iR,aR,pT,YU;' + nativeFunctionBody('messages-ttl-request') + ';return {requested:aR,actual:pT,changed:YU}'
    const request = new Function('deps', source)(deps)
    const downgraded = value?.trim() === '5m'
    expect(request).toEqual({ requested: '1h', actual: downgraded ? undefined : '1h', changed: downgraded })
    expect(journalTtlMs).toBe(downgraded ? 300_000 : 3_600_000)
    const result = native302(undefined, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: value })
    expect(result.supported).toBe(!downgraded)
    expect(result.proof?.cacheTtl).toBe(downgraded ? '5m' : '1h')
  })

  test.each([undefined, 'unknown', '2h'])('an unknown actual TTL %s requires investigation', promptCacheTtl => {
    expect(() => native302(undefined, { promptCacheTtl })).toThrow('TTL unavailable')
  })

  test('captured background adapter removes both foreground event callbacks', () => {
    const withoutEvents = new Function(nativeFunctionBody('background-events') + ';return Bqr')() as (options: any, abortController: AbortController) => any
    const abortController = new AbortController(), onCompactEvent = () => {}, onRetryStatus = () => {}
    expect(withoutEvents({ onCompactEvent, onRetryStatus, ordinary: 'kept' }, abortController)).toEqual({ ordinary: 'kept', abortController,
      onCompactEvent: undefined, onRetryStatus: undefined })
  })

  test.each([[30 * 60_000, 1], [45 * 60_000, 1], [60 * 60_000 - 1, 1], [60 * 60_000, 0]] as const)(
    'actual native return gate after %s ms discards=%s', async (elapsed, expectedDiscarded) => {
      const lastWarmAt = 2000
      const expiry = new Function('cZ', 'nV', 'aSt', 'X4', nativeFunctionBody('application-expiry') + ';return cKt()')(
        () => undefined, () => 1000, () => lastWarmAt, () => 3_600_000) as number
      expect(expiry).toBe(lastWarmAt + 3_600_000)
      let entry: { status: string } | undefined = { status: 'ready' }, discarded = 0
      const deps = { Qo: () => '', sNn: () => false, KPt: () => {}, PDe: () => '', qPt: () => entry, cKt: () => expiry,
        aNn: () => { entry = undefined; discarded++ }, Date: { now: () => lastWarmAt + elapsed }, vuo: async () => null, Wqr: () => {} }
      const apply = new Function('deps', 'const {Qo,sNn,KPt,PDe,qPt,cKt,aNn,Date,vuo,Wqr}=deps;' + nativeFunctionBody('application-guard') + ';return Euo')(deps)
      await apply({ trigger: 'idle', toolUseContext: { session: { precompute: {} }, options: {}, abortController: new AbortController() }, messages: [], detectedAt: 0 })
      expect(discarded).toBe(expectedDiscarded)
      if (expectedDiscarded) expect(entry).toBeUndefined()
      else expect(entry?.status).toBe('ready')
    },
  )
})
