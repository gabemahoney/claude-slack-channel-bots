import { expect, test } from 'bun:test'
import { SharedFragmentBytes } from '../src/shared-fragment-bytes.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSharedAuthority, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'

/** The cache accepts canonical members supplied by its caller. Compare every
 * complete result directly with native JSON at the same indentation depth. */
function fixture() {
  const cache = new SharedFragmentBytes()
  const bases = new WeakMap<object, object>()
  function encode(value: unknown, depth = 0): Buffer | undefined {
    if (typeof value !== 'object' || value === null) {
      const text = JSON.stringify(value)
      return text === undefined ? undefined : Buffer.from(text)
    }
    const list = Array.isArray(value)
    const keys = list ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value)
    return cache.encode(value, depth, list, keys, key => (value as Record<string, unknown>)[key], encode, bases.get(value))
  }
  function check(value: object, base?: object, depth = 0) {
    if (base) bases.set(value, base)
    const expected = JSON.stringify(value, null, 2).replaceAll('\n', '\n' + '  '.repeat(depth))
    const actual = encode(value, depth)!
    expect(actual.equals(Buffer.from(expected))).toBe(true)
    expect(cache.get(value, depth)).toBe(actual)
    assertNoLeak(actual)
    return value
  }
  return { cache, check }
}

test('record splices preserve Unicode, escapes, changed entries and every unchanged run', () => {
  const f = fixture(), shared = Object.freeze({ text: '雪😀 "quoted" \\ slash\n\t' })
  let current: Record<string, unknown> = f.check({ a: shared, b: 'old', c: shared, d: true, e: shared }) as Record<string, unknown>
  for (const next of [
    { ...current, b: 'new', d: false },
    { a: shared, c: shared, e: shared },
    { inserted: shared, a: shared, c: shared, e: shared, last: null },
    { e: shared, c: shared, a: shared },
    {},
    { fresh: shared },
  ]) current = f.check(next, current) as Record<string, unknown>
})

test('integer-like key insertion/deletion follows the supplied native key order', () => {
  const f = fixture(), shared = Object.freeze({ n: 1 })
  const first = f.check({ '10': shared, text: shared, '2': shared, '01': shared })
  const second = f.check({ ...first, '1': shared, '3': 'changed', '4294967295': shared }, first)
  const third: Record<string, unknown> = { ...second }
  delete third['2']; delete third['text']; third['text'] = shared
  f.check(third, second)
})

test('array splices preserve changed, inserted, deleted and undefined/null members', () => {
  const f = fixture(), shared = Object.freeze({ nested: [] })
  const first = f.check([shared, 'old', shared, undefined, shared])
  const second = f.check([shared, 'new', shared, null, shared], first)
  const third = f.check([shared, shared], second)
  f.check([], third)
})

test('identity caches separate indentation depths and opaque saved fragments', () => {
  const f = fixture(), value = { a: { nested: 'é' }, b: [] }
  for (const depth of [0, 1, 4, 2, 0]) f.check(value, undefined, depth)
  const bytes = Buffer.from(JSON.stringify(value, null, 2))
  f.cache.keep(value, 0, bytes)
  f.check({ ...value, c: 'after opaque cache' }, value)
})

test('omitted properties, empty objects and separators match native bytes across splices', () => {
  const f = fixture()
  const first = f.check({ omitted: undefined, a: 0, b: false, c: null, last: undefined })
  const second = f.check({ a: 0, omitted: undefined, b: false }, first)
  f.check({ omitted: undefined }, second)
  f.check({ negativeZero: -0, nan: NaN, infinity: Infinity })
})

test('canonical bytes after a native fallback never resurrect a saved map hook discarded by the new draft', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-fragment-native-'))
  try {
    const input = makePersonaConfigInput({ personas: [makePersona({ name: 'alpha',
      channels: [{ id: SHARED_CHANNEL_IDS.primary, delivery: 'all' }], permission_prompts: SHARED_CHANNEL_IDS.primary }, root)] }, root)
    const authority = makeSharedAuthority(root, input)
    let valid = true
    expect(authority.transactMembership('alpha', authority.revision, state => {
      Object.defineProperty(state.personas['alpha']!.assignments, 'toJSON', { value() {
        if (!valid) throw new Error('Discarded native hook ran again')
        return { ...this }
      } })
    }).kind).toBe('applied')
    const expected = authority.snapshot()
    expected.revision++
    const bytes = Buffer.from(JSON.stringify(expected, null, 2) + '\n')
    valid = false
    expect(authority.transactMembership('alpha', authority.revision, () => {}).kind).toBe('applied')
    const actual = readFileSync(authority.path)
    expect(actual.equals(bytes)).toBe(true)
    assertNoLeak({ actual, bytes })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
