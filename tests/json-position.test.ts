/**
 * json-position.ts (b.av2 SR-10.3): where a JSON text first breaks the
 * grammar, and the 1-based line and column of an offset. Pure functions over
 * strings: no files, no environment. The loader's malformed-JSON message built
 * on them is covered in tests/config.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { jsonSyntaxErrorOffset, positionAt } from '../src/json-position.ts'
import { BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'

/** Deep enough to overflow a recursive scanner. */
const DEEP = 100_000

describe('jsonSyntaxErrorOffset', () => {
  test.each([
    ['an empty object', '{}'],
    ['a surrounded number', ' \t\r\n0 '],
    ['every number form', '[-0, 1, -12.5, 1e3, 2E-7, 3.0e+10]'],
    ['every escape', '"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9 \\uD83D\\uDE00"'],
    ['literals and nesting', '{"a": [true, false, null, {"b": "c"}, []], "d": {}}'],
    ['a character outside the BMP', '"\u{1F600}"'],
    ['deep nesting, without overflowing the stack', '['.repeat(DEEP) + ']'.repeat(DEEP)],
  ])('valid JSON (%s) gives undefined, as JSON.parse accepts it', (_label, text) => {
    expect(() => JSON.parse(text)).not.toThrow()
    expect(jsonSyntaxErrorOffset(text)).toBeUndefined()
  })

  test.each([
    ['an empty text', '', 0],
    ['whitespace only', '  \n', 3],
    ['an unclosed object', '{', 1],
    ['a missing colon', '{"a" 1}', 5],
    ['a single-quoted key', "{'a': 1}", 1],
    ['a trailing comma in an object', '{"a": 1,}', 8],
    ['a trailing comma in an array', '[1,]', 3],
    ['a missing comma', '[1 2]', 3],
    ['a mismatched close', '{"a": 1]', 7],
    ['a second top-level value', '{} {}', 3],
    ['a leading zero', '01', 1],
    ['a lone minus', '-', 1],
    ['a fraction with no digits', '1.x', 2],
    ['an exponent with no digits', '1e+', 3],
    ['a misspelt literal', 'trux', 3],
    ['a truncated literal', 'nul', 3],
    ['an unknown escape', '"a\\q"', 3],
    ['a bad unicode escape', '"\\u12G4"', 5],
    ['a raw control character in a string', '"a\tb"', 2],
    ['an unterminated string', '"abc', 4],
    ['a leading byte order mark', '\uFEFF{}', 0],
    ['unclosed deep nesting, without overflowing the stack', '['.repeat(DEEP), DEEP],
  ])('%s is rejected by JSON.parse and reported at its first invalid offset', (_label, text, offset) => {
    expect(() => JSON.parse(text)).toThrow()
    expect(jsonSyntaxErrorOffset(text)).toBe(offset)
  })
})

describe('positionAt', () => {
  test.each([
    ['the first character', 'abc', 0, 1, 1],
    ['the end of the text', 'ab', 2, 1, 3],
    ['an offset past the end, clamped', 'ab', 99, 1, 3],
    ['a line feed, which ends its own line', 'ab\ncd', 2, 1, 3],
    ['the first character after a line feed', 'ab\ncd', 3, 2, 1],
    ['a later line after CRLF endings', 'a\r\nb\r\ncd', 7, 3, 2],
    ['a lone carriage return, which does not end a line', 'a\rbc', 2, 1, 3],
    ['a character after one outside the BMP, which counts once', '\u{1F600}x', 2, 1, 2],
  ])('%s', (_label, text, offset, line, column) => {
    expect(positionAt(text, offset)).toEqual({ line, column })
  })
})

// b.av2 SR-10.3: the results are numbers only, so a malformed text holding a
// pasted token yields a position that echoes none of it.
describe('a malformed text holding a pasted token', () => {
  const token = fakeToken(BOT_TOKEN_PREFIX)
  test.each([
    ['a bare sentinel value', `{\n  "bot_token": ${LEAK_SENTINEL}\n}`, 17, 2, 16],
    // The string runs to the end of the text, so the error is at the end.
    ['a fake token in a string left open', `{"bot_token": "${token}`, 15 + token.length, 1, 16 + token.length],
  ])('%s: the offset and position are found and carry no file content', (_label, text, offset, line, column) => {
    expect(() => JSON.parse(text)).toThrow()
    const found = jsonSyntaxErrorOffset(text)
    const position = positionAt(text, found ?? -1)
    assertNoLeak({ found, position }, 'position')
    expect(found).toBe(offset)
    expect(position).toEqual({ line, column })
  })
})
