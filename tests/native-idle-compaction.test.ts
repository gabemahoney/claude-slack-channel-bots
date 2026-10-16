/** Decision 16's read-only capability/refusal and own-launch observation contract.
 * Real native binaries are checked separately in the container self-check.
 */
import { describe, expect, test } from 'bun:test'
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
