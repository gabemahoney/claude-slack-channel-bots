/** names-only scratch-config admission, using synthetic TOML only. */
import { describe, expect, spyOn, test } from 'bun:test'
import {
  CODEX_CONFIG_KEYS_MAX_BYTES, CODEX_CONFIG_MAX_BYTES, CODEX_CONFIG_MAX_KEYS,
  CODEX_HOST_CONFIG_KEYS_ENV, CODEX_NATIVE_CONFIG_LEAVES,
  checkCodexScratchConfigKeys, codexConfigKeyName, decodeCodexHostConfigKeys,
  encodeCodexHostConfigKeys, readCodexConfigModel, scanCodexConfigKeyPaths,
} from '../src/codex-config-keys.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'

const nativeKeys = ['tui.screen_reader_detection_done', 'tui']
const hostKeys = encodeCodexHostConfigKeys([['model']])
const marker = 'tui.screen_reader_detection_done = true\n'

/** Every failed parser/projection path must discard its underlying diagnostic. */
function projectionError(operation: () => unknown): Error {
  let error: unknown
  try { operation() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  assertNoLeak(error)
  expect((error as Error).message).toBe('Codex config key projection is invalid or exceeds its limits')
  return error as Error
}

describe('Codex scratch config key policy', () => {
  test('pins the evidence-backed native leaf and the transport name', () => {
    expect(CODEX_NATIVE_CONFIG_LEAVES).toEqual([['tui', 'screen_reader_detection_done']])
    expect(CODEX_HOST_CONFIG_KEYS_ENV).toBe('CODEX_HOST_CONFIG_KEYS')
  })

  test.each([
    ['absent', undefined, []],
    ['empty', '', []],
    ['comments', '# model = "not a key"\n', []],
    ['empty native namespace', '[tui]\n', ['tui']],
    ['table', '[tui]\nscreen_reader_detection_done = true\n', nativeKeys],
    ['dotted', marker, nativeKeys],
    ['quoted', '"tui"."screen_reader_detection_done" = false\n', nativeKeys],
    ['literal quoted', "'tui'.'screen_reader_detection_done' = true\n", nativeKeys],
    ['escaped key', '"t\\u0075i"."screen_reader_detection_done" = true\n', nativeKeys],
    ['inline table', 'tui = { screen_reader_detection_done = true }\n', nativeKeys],
  ] as const)('admits %s with only native names', (_name, text, names) => {
    const result = checkCodexScratchConfigKeys(text, hostKeys)
    expect(result).toEqual({ allowed: true, unknownKeyCount: 0, keyNames: names })
    assertNoLeak(result)
  })

  test.each([
    ['model', 'model = "private"', ['model'], 1],
    ['reasoning', 'model_reasoning_effort = "private"', ['model_reasoning_effort'], 1],
    ['profile', 'profile = "private"', ['profile'], 1],
    ['empty profiles table', '[profiles]', ['profiles'], 1],
    ['provider', 'model_provider = "private"', ['model_provider'], 1],
    ['provider table', '[model_providers.private]', ['model_providers.private', 'model_providers'], 2],
    ['auth', 'auth = "private"', ['auth'], 1],
    ['nested auth', 'tui.auth_token = "private"', ['tui.auth_token', 'tui'], 1],
    ['case variant', 'tui.MODEL = "private"', ['tui.MODEL', 'tui'], 1],
    ['unknown leaf', 'tui.future_marker = true', ['tui.future_marker', 'tui'], 1],
    ['observed optional tooltip counter', 'tui.model_availability_nux."gpt-6.1-sol" = 1', ['tui.model_availability_nux."gpt-6.1-sol"', 'tui.model_availability_nux', 'tui'], 2],
    ['empty unknown table', '[future]', ['future'], 1],
    ['empty inline table', 'future = {}', ['future'], 1],
    ['empty array table', '[[future]]', ['future'], 1],
    ['quoted literal dot', '"tui.screen_reader_detection_done" = true', ['"tui.screen_reader_detection_done"'], 1],
    ['empty key', '"" = true', ['""'], 1],
  ] as const)('rejects %s and records names plus their count', (_name, text, keyNames, unknownKeyCount) => {
    const result = checkCodexScratchConfigKeys(text, hostKeys)
    expect(result).toEqual({ allowed: false, keyNames, unknownKeyCount })
    assertNoLeak(result)
  })

  test.each([
    ['exact native leaf', 'tui.screen_reader_detection_done = false'],
    ['namespace alone', 'tui = {}'],
    ['namespace of another host key', 'tui.other = 1'],
    ['native key as host namespace', '[tui.screen_reader_detection_done]\nchild = 1'],
  ] as const)('amended policy admits native names despite host overlap: %s', (_name, host) => {
    const projection = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths(`model = "test-model"\n${host}\n`))
    const result = checkCodexScratchConfigKeys(marker, projection)
    expect(result).toEqual({ allowed: true, keyNames: nativeKeys, unknownKeyCount: 0 })
    assertNoLeak(result)
  })

  test.each([
    ['tui = true', ['tui']], ['tui = "private"', ['tui']], ['tui = []', ['tui']],
    ['tui = [{screen_reader_detection_done = true}]', nativeKeys], ['[[tui]]\nscreen_reader_detection_done = true', nativeKeys],
    ['[tui]\nscreen_reader_detection_done = true\nother = 1', ['tui.other', ...nativeKeys]],
    ['tui = {screen_reader_detection_done = true, other = {}}', ['tui.other', ...nativeKeys]],
  ] as const)('rejects a non-table native namespace or an extra descendant: row %#', (text, keyNames) => {
    const projection = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths('model="test-model"\n[tui]\nscreen_reader_detection_done=false\nother=1'))
    const result = checkCodexScratchConfigKeys(text, projection)
    expect(result).toEqual({ allowed: false, keyNames, unknownKeyCount: 1 })
    assertNoLeak(result)
  })

  test.each(['[tui]', 'tui = {}', 'tui = {screen_reader_detection_done = true}', marker])('admits only real native parent tables under overlap: row %#', text => {
    const projection = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths('model="test-model"\n[tui]\nscreen_reader_detection_done=false'))
    expect(checkCodexScratchConfigKeys(text, projection).allowed).toBe(true)
  })

  test.each(['ordinary = 1', 'model = "other"', 'model_reasoning_effort = "high"', '[profiles]', '[model_providers]', 'auth = {}', 'unknown = {}'])('host overlap never permits other keys: row %#', text => {
    const projection = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths(`model="test-model"\nordinary=0\n[profiles]\n[model_providers]\n[auth]\n[unknown]\n`))
    const result = checkCodexScratchConfigKeys(`${marker}${text}`, projection)
    expect(result.allowed).toBe(false)
    expect(result.unknownKeyCount).toBeGreaterThan(0)
    assertNoLeak(result)
  })

  test('literal dotted names cannot collide with nested host paths in either direction', () => {
    const literal = '"tui.screen_reader_detection_done" = true\n'
    const projection = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths(`model = "test-model"\n${literal}`))
    expect(decodeCodexHostConfigKeys(projection)).toEqual([['model'], ['tui.screen_reader_detection_done']])
    expect(checkCodexScratchConfigKeys(marker, projection)).toEqual({ allowed: true, keyNames: nativeKeys, unknownKeyCount: 0 })
    expect(checkCodexScratchConfigKeys(literal, hostKeys)).toEqual({ allowed: false, keyNames: ['"tui.screen_reader_detection_done"'], unknownKeyCount: 1 })
  })

  test.each([
    'true', 'false', '0', '-9_223_372_036_854_775_808', '9_223_372_036_854_775_807',
    '0x7fff_ffff_ffff_ffff', '0o777', '0b101', '1.5e+10', '-inf', '+nan',
    '2024-02-29', '2000-02-29T23:59:59.123Z', '12:34:56',
    '["model = 1", "auth = 2", "profile = 3"]',
    '"[profiles.fake]\\nmodel = \\"ignored\\""',
    "'''model = 1\n[auth]\nvalue = 'ignored'\n'''",
    '"""model = 1\n[profiles.fake]\nauth = \\"ignored\\"\n"""',
  ])('skips a native key scalar or scalar array without inventing keys: row %#', value => {
    const result = checkCodexScratchConfigKeys(`tui.screen_reader_detection_done = ${value}\n`, hostKeys)
    expect(result).toEqual({ allowed: true, keyNames: nativeKeys, unknownKeyCount: 0 })
    assertNoLeak(result)
  })

  test('only keys and constant placeholders reach the TOML parser; no scalar text is retained', () => {
    const secret = fakeToken('', 'config-value')
    const parse = Bun.TOML.parse
    const documents: string[] = []
    const spy = spyOn(Bun.TOML, 'parse').mockImplementation(text => { documents.push(text); return parse(text) })
    let result: ReturnType<typeof checkCodexScratchConfigKeys>
    try {
      result = checkCodexScratchConfigKeys(`tui = {screen_reader_detection_done = ["${secret}", '''model = 1\n[auth]''', 2024-01-01]}\n`, hostKeys)
    } finally { spy.mockRestore() }
    expect(result!).toEqual({ allowed: true, keyNames: nativeKeys, unknownKeyCount: 0 })
    expect(documents).toEqual(['"tui"={"screen_reader_detection_done"=[0,0,0]}\n'])
    assertNoLeak({ documents, result: result! })
  })

  test('sanitizes both parser diagnostics and malformed scalar values', () => {
    const secret = fakeToken('', 'malformed-value')
    projectionError(() => checkCodexScratchConfigKeys(`${marker}tui.screen_reader_detection_done = "${secret}"\n`, hostKeys))
    projectionError(() => checkCodexScratchConfigKeys(`tui.screen_reader_detection_done = "${secret}`, hostKeys))
    projectionError(() => checkCodexScratchConfigKeys(`tui.screen_reader_detection_done = ${secret}`, hostKeys))
  })

  test('rejected unknown and forbidden keys expose their names and counts without their values', () => {
    const secret = fakeToken('', 'rejected-config-value')
    const result = checkCodexScratchConfigKeys(`${marker}tui.future_marker = "${secret}"\nauth = { token = "${secret}" }\n`, hostKeys)
    expect(result).toEqual({ allowed: false, unknownKeyCount: 3, keyNames: ['auth.token', 'auth', 'tui.future_marker', ...nativeKeys] })
    assertNoLeak(result)
  })
})

describe('authorized host model decoding', () => {
  test('parses only the top-level model value and skips every other host value lexically', () => {
    const secret = fakeToken('', 'unread-host-setting')
    const parse = Bun.TOML.parse, documents: string[] = []
    const spy = spyOn(Bun.TOML, 'parse').mockImplementation(text => { documents.push(text); return parse(text) })
    let model: unknown
    try {
      model = readCodexConfigModel(`"mo\\u0064el" = "test-\\u006dodel"\nother = ["${secret}", 2024-01-01]\n[tui]\nscreen_reader_detection_done = "${secret}"\n[profiles.private]\nmodel = "${secret}"\n`)
    } finally { spy.mockRestore() }
    expect(model).toBe('test-model')
    expect(documents).toHaveLength(2)
    expect(documents[1]).toBe('model="test-\\u006dodel"')
    expect(documents[0]).toContain('"screen_reader_detection_done"=0')
    expect(documents[0]).toContain('"other"=[0,0]')
    assertNoLeak({ documents, model })
  })
  test.each(['[profile]\nmodel="nested"', 'other={model="nested"}', 'model.name="nested"', 'model=123', 'model=["array"]'])('does not decode non-string or nested model values: row %#', text => {
    expect(readCodexConfigModel(text)).toBeUndefined()
  })
  test('model parser errors contain neither model nor unrelated host values', () => {
    const secret = fakeToken('', 'invalid-host-model')
    projectionError(() => readCodexConfigModel(`model="${secret}"\nother="unterminated`))
    projectionError(() => readCodexConfigModel(`model="${secret}"\nmodel="other"`))
  })
})

describe('bounded names-only TOML scanning', () => {
  test('projects every namespace, inline and array-table key once, without values', () => {
    const secret = fakeToken('', 'host-setting')
    const paths = scanCodexConfigKeyPaths(`model = "test-model"\n[profiles.a]\nsettings = { empty = {}, rows = [{value = "${secret}"}, {value = false}] }\n[[providers]]\nname = "${secret}"\n[[providers]]\nname = "other"\n`)
    expect(paths).toEqual([
      ['model'], ['profiles', 'a', 'settings', 'empty'], ['profiles', 'a', 'settings', 'rows', 'value'],
      ['profiles', 'a', 'settings', 'rows'], ['profiles', 'a', 'settings'], ['profiles', 'a'], ['profiles'],
      ['providers', 'name'], ['providers'],
    ])
    assertNoLeak(paths)
  })

  test('renders control-free quoted names unambiguously', () => {
    expect(codexConfigKeyName(['a.b', 'c'])).toBe('"a.b".c')
    expect(codexConfigKeyName(['a', 'b.c'])).toBe('a."b.c"')
    expect(codexConfigKeyName(['a"b', ''])).toBe('"a\\"b".""')
  })

  test.each([
    'a..b = 1', '.a = 1', 'a. = 1', 'a b = 1', 'a =', 'a = true false',
    'a = 1\ra = 2', 'a = 1\u0000', 'a = "bad\\q"', '"bad\\uD800" = 1',
    '"bad\\u000a" = 1', "'bad\nkey' = 1", 'a = "unterminated',
    'a = """unterminated', 'a = [1', 'a = {b = 1,}', 'a = {b = 1\nc = 2}',
    'a = {b = 1, b = 2}', 'a = 1\na = 2', '[a]\n[a]', 'a = 1\n[a]',
    'a.b = 1\na = 2', 'a = {b = 1}\n[a]', '[a', '[[a]',
    'a = 01', 'a = 1_', 'a = 1e', 'a = 2023-02-29', 'a = 2024-04-31',
    'a = 25:00:00', 'a = 9223372036854775808', 'a = -9223372036854775809',
    'a = 0xffffffffffffffff', 'a = 0b' + '1'.repeat(64), 'a = "\ud800"',
  ])('rejects malformed or ambiguous TOML without its diagnostic: row %#', text => {
    projectionError(() => scanCodexConfigKeyPaths(text))
  })

  test('accepts the byte limit and refuses one additional byte, including UTF-8 expansion', () => {
    const limit = '#' + 'x'.repeat(CODEX_CONFIG_MAX_BYTES - 1)
    expect(scanCodexConfigKeyPaths(limit)).toEqual([])
    projectionError(() => scanCodexConfigKeyPaths(limit + 'x'))
    projectionError(() => scanCodexConfigKeyPaths('#' + 'é'.repeat(CODEX_CONFIG_MAX_BYTES / 2)))
  })

  test('bounds source definitions and expanded path counts separately', () => {
    const rows = Array.from({ length: CODEX_CONFIG_MAX_KEYS }, (_, i) => `k${i}=0\n`).join('')
    expect(scanCodexConfigKeyPaths(rows)).toHaveLength(CODEX_CONFIG_MAX_KEYS)
    projectionError(() => scanCodexConfigKeyPaths(rows + 'extra=0\n'))
    const expanded = Array.from({ length: CODEX_CONFIG_MAX_KEYS / 2 + 1 }, (_, i) => `a${i}.b=0\n`).join('')
    projectionError(() => scanCodexConfigKeyPaths(expanded))
  })

  test('bounds namespace depth, nested values, and decoded UTF-8 key-segment bytes', () => {
    const path = Array<string>(32).fill('key')
    expect(scanCodexConfigKeyPaths(path.join('.') + '=0')).toHaveLength(32)
    projectionError(() => scanCodexConfigKeyPaths([...path, 'extra'].join('.') + '=0'))
    projectionError(() => scanCodexConfigKeyPaths('a=' + '['.repeat(33) + '0' + ']'.repeat(33)))
    expect(scanCodexConfigKeyPaths(`"${'é'.repeat(128)}"=0`)).toEqual([['é'.repeat(128)]])
    projectionError(() => scanCodexConfigKeyPaths(`"${'é'.repeat(129)}"=0`))
    projectionError(() => scanCodexConfigKeyPaths(`"${'\\u0061'.repeat(257)}"=0`))
  })
})

describe('host key projection transport', () => {
  test('round-trips segment arrays and preserves a literal dotted key separately', () => {
    const paths = scanCodexConfigKeyPaths('model="test-model"\n["a.b"]\n"c.d"=1\n[a.b]\nc=2\n')
    expect(decodeCodexHostConfigKeys(encodeCodexHostConfigKeys(paths))).toEqual(paths)
    expect(paths).toContainEqual(['a.b', 'c.d'])
    expect(paths).toContainEqual(['a', 'b', 'c'])
    assertNoLeak(encodeCodexHostConfigKeys(paths))
  })

  const malformed: readonly unknown[] = [
    undefined, '', '{', 'null', '[]', 'true',
    { version: 2, keys: [['model']] }, { keys: [['model']] }, { version: 1 },
    { version: 1, keys: [] }, { version: 1, keys: [['other']] },
    { version: 1, keys: [['model']], extra: true },
    { version: 1, keys: [['model'], ['model']] },
    { version: 1, keys: [['model'], ['tui', 'other']] },
    { version: 1, keys: [['model'], ['a'], ['a', 'b', 'c']] },
    { version: 1, keys: ['model'] }, { version: 1, keys: [['model'], []] },
    { version: 1, keys: [['model'], [null]] }, { version: 1, keys: [['model'], [1]] },
    { version: 1, keys: [['model'], ['bad\nkey']] },
    { version: 1, keys: [['model'], ['bad\u2028key']] },
    { version: 1, keys: [['model'], ['\ud800']] },
    { version: 1, keys: [['model'], ['x'.repeat(257)]] },
    { version: 1, keys: [['model'], Array<string>(33).fill('deep')] },
    { version: 1, keys: [['model'], ...Array.from({ length: CODEX_CONFIG_MAX_KEYS }, (_, i) => [`k${i}`])] },
  ]
  test.each(malformed.map((value, i) => [i, value] as const))('fails closed for missing or malformed metadata row %i, even with no scratch file', (_i, value) => {
    const text = typeof value === 'string' || value === undefined ? value : JSON.stringify(value)
    projectionError(() => decodeCodexHostConfigKeys(text))
    projectionError(() => checkCodexScratchConfigKeys(undefined, text))
    projectionError(() => checkCodexScratchConfigKeys(marker, text))
  })

  test('accepts the transport byte boundary and refuses one extra byte before parsing', () => {
    const padded = hostKeys + ' '.repeat(CODEX_CONFIG_KEYS_MAX_BYTES - Buffer.byteLength(hostKeys))
    expect(decodeCodexHostConfigKeys(padded)).toEqual([['model']])
    projectionError(() => decodeCodexHostConfigKeys(padded + ' '))
  })

  test('encoder also refuses incomplete projections and payloads over the transport budget', () => {
    projectionError(() => encodeCodexHostConfigKeys([['model'], ['tui', 'other']]))
    const paths = [['model'], ...Array.from({ length: 600 }, (_, i) => [`${i}-${'x'.repeat(250)}`])]
    projectionError(() => encodeCodexHostConfigKeys(paths))
  })
})
