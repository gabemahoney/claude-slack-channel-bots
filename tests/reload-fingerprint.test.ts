/**
 * reload-fingerprint.test.ts — Tests for the pure parts of reload detection
 * (b.av2 SR-8.1, SR-8.3): `reloadFingerprint`, the pending file's layout
 * (`composePendingFile`, `parsePendingFingerprint`) in
 * src/reload-fingerprint.ts. `referencedCredentialsPaths`, which supplies the
 * fingerprint's credentials paths, lives in src/config.ts and is tested in
 * tests/config.test.ts.
 *
 * Every function here is pure: the tests read and write no file. The
 * credentials contents are sentinel-bearing fake credentials, so
 * `assertNoLeak` over every output proves no content reaches it. How the
 * detection tick uses these (which bytes it reads, when it writes the file)
 * is covered in tests/reload.test.ts; the fingerprint's encoding is not
 * asserted, only its behaviour.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import {
  composePendingFile,
  FINGERPRINT_MISSING,
  FINGERPRINT_UNREADABLE,
  parsePendingFingerprint,
  PENDING_FILE_HEADER,
  PENDING_FINGERPRINT_PREFIX,
  reloadFingerprint,
  type FingerprintContent,
  type FingerprintCredentialsEntry,
} from '../src/reload-fingerprint.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, makeCredentials } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Credentials file bytes holding sentinel-bearing fake tokens; `suffix` tells two apart. */
const credentialsBytes = (suffix: string): Uint8Array =>
  bytes(JSON.stringify(makeCredentials({ bot_token: fakeToken(BOT_TOKEN_PREFIX, suffix) })))

const CONFIG = bytes('{"personas": [{"name": "alpha"}, {"name": "beta"}]}\n')
const ALPHA = '/creds/alpha/credentials.json'
const BETA = '/creds/beta/credentials.json'

/** Two referenced credentials files, in declaration order. */
function baseEntries(): FingerprintCredentialsEntry[] {
  return [
    { path: ALPHA, content: credentialsBytes('alpha') },
    { path: BETA, content: credentialsBytes('beta') },
  ]
}

const FINGERPRINT = /^[0-9a-f]{64}$/

/** `n` as 8 big-endian bytes. */
function lengthBytes(n: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(n))
  return buf
}

// ---------------------------------------------------------------------------
// reloadFingerprint
// ---------------------------------------------------------------------------

describe('reloadFingerprint (b.av2 SR-8.3)', () => {
  test('is 64 lower-case hex digits, and equal inputs give the same fingerprint, whatever the byte container', () => {
    const first = reloadFingerprint(CONFIG, baseEntries())
    const again = reloadFingerprint(
      Buffer.from(CONFIG),
      baseEntries().map((e) => ({ path: e.path, content: Buffer.from(e.content as Uint8Array) })),
    )

    expect(first).toMatch(FINGERPRINT)
    expect(again).toBe(first)
    assertNoLeak({ first, again })
  })

  // Each row changes one input from the base; every fingerprint must differ
  // from the base and from every other row.
  test('changes with the config bytes, any credentials path or byte, the entry order and each missing or unreadable marker', () => {
    const [alpha, beta] = baseEntries()
    const variants: Array<[string, FingerprintContent, FingerprintCredentialsEntry[]]> = [
      ['base', CONFIG, [alpha, beta]],
      ['one config byte changed', bytes('{"personas": [{"name": "alphA"}, {"name": "beta"}]}\n'), [alpha, beta]],
      ['config empty', new Uint8Array(0), [alpha, beta]],
      ['config missing', FINGERPRINT_MISSING, [alpha, beta]],
      ['config unreadable', FINGERPRINT_UNREADABLE, [alpha, beta]],
      ['a credentials path changed, same length', CONFIG, [{ ...alpha, path: '/creds/alphA/credentials.json' }, beta]],
      ['a credentials path lengthened', CONFIG, [{ ...alpha, path: '/creds/alpha/credentials.json.new' }, beta]],
      ['one credentials byte changed', CONFIG, [{ ...alpha, content: credentialsBytes('alphA') }, beta]],
      ['a credentials file empty', CONFIG, [{ ...alpha, content: new Uint8Array(0) }, beta]],
      ['a credentials file missing', CONFIG, [{ ...alpha, content: FINGERPRINT_MISSING }, beta]],
      ['a credentials file unreadable', CONFIG, [{ ...alpha, content: FINGERPRINT_UNREADABLE }, beta]],
      ['the entries in the other order', CONFIG, [beta, alpha]],
      ['the same file named twice', CONFIG, [alpha, alpha, beta]],
      ['one entry fewer', CONFIG, [alpha]],
      ['no entries (dry run)', CONFIG, []],
    ]

    const fingerprints = variants.map(([label, config, entries]) => [label, reloadFingerprint(config, entries)] as const)

    const byFingerprint = new Map<string, string[]>()
    for (const [label, fp] of fingerprints) byFingerprint.set(fp, [...(byFingerprint.get(fp) ?? []), label])
    expect([...byFingerprint.values()].filter((labels) => labels.length > 1)).toEqual([])
    assertNoLeak(fingerprints)
  })

  // Moving bytes across a boundary (config | path | content | next entry)
  // keeps the concatenated bytes the same; the fingerprint must still differ.
  // A marker must never equal any real content, including its own name or a
  // one-byte file. The "embeds" row feeds a content whose bytes spell a
  // plausible encoding of the next entry (8-byte big-endian length, path,
  // tag, content); it asserts only inequality, so it holds under any encoding.
  test.each<[string, [FingerprintContent, FingerprintCredentialsEntry[]], [FingerprintContent, FingerprintCredentialsEntry[]]]>([
    ['path/content split moved', [CONFIG, [{ path: '/a/b', content: bytes('cd') }]], [CONFIG, [{ path: '/a/bc', content: bytes('d') }]]],
    ['config/path split moved', [bytes('{}/a'), [{ path: '/b', content: bytes('x') }]], [bytes('{}'), [{ path: '/a/b', content: bytes('x') }]]],
    ['one entry vs two entries with the same bytes', [CONFIG, [{ path: '/a', content: bytes('b/c') }]],
      [CONFIG, [{ path: '/a', content: bytes('b') }, { path: '/c', content: new Uint8Array(0) }]]],
    ['entry content moved into the next path', [CONFIG, [{ path: '/a', content: bytes('x/') }, { path: 'b', content: bytes('y') }]],
      [CONFIG, [{ path: '/a', content: bytes('x') }, { path: '/b', content: bytes('y') }]]],
    ['a path\'s last character moved to the start of the next path, both files missing',
      [CONFIG, [{ path: '/aM', content: FINGERPRINT_MISSING }, { path: '/b', content: FINGERPRINT_MISSING }]],
      [CONFIG, [{ path: '/a', content: FINGERPRINT_MISSING }, { path: 'M/b', content: FINGERPRINT_MISSING }]]],
    ['a content that embeds the encoding of the next entry',
      [CONFIG, [{ path: '/a', content: bytes('x') }, { path: '/b', content: Buffer.concat([bytes('y'), lengthBytes(2), bytes('/cM')]) }]],
      [CONFIG, [{ path: '/a', content: Buffer.concat([bytes('x'), lengthBytes(2), bytes('/bBy')]) }, { path: '/c', content: FINGERPRINT_MISSING }]]],
    ['missing marker vs a file holding "missing"', [CONFIG, [{ path: ALPHA, content: FINGERPRINT_MISSING }]],
      [CONFIG, [{ path: ALPHA, content: bytes(FINGERPRINT_MISSING) }]]],
    ['unreadable marker vs a file holding "unreadable"', [CONFIG, [{ path: ALPHA, content: FINGERPRINT_UNREADABLE }]],
      [CONFIG, [{ path: ALPHA, content: bytes(FINGERPRINT_UNREADABLE) }]]],
    ['missing marker vs a one-byte file "M"', [CONFIG, [{ path: ALPHA, content: FINGERPRINT_MISSING }]],
      [CONFIG, [{ path: ALPHA, content: bytes('M') }]]],
    ['unreadable marker vs a one-byte file "U"', [CONFIG, [{ path: ALPHA, content: FINGERPRINT_UNREADABLE }]],
      [CONFIG, [{ path: ALPHA, content: bytes('U') }]]],
    ['missing config vs a config holding "missing"', [FINGERPRINT_MISSING, []], [bytes(FINGERPRINT_MISSING), []]],
    ['missing marker vs empty file', [CONFIG, [{ path: ALPHA, content: FINGERPRINT_MISSING }]],
      [CONFIG, [{ path: ALPHA, content: new Uint8Array(0) }]]],
  ])('boundaries are unambiguous: %s gives a different fingerprint', (_label, [configA, entriesA], [configB, entriesB]) => {
    const a = reloadFingerprint(configA, entriesA)
    const b = reloadFingerprint(configB, entriesB)

    expect(a).toMatch(FINGERPRINT)
    expect(b).toMatch(FINGERPRINT)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Pending file layout
// ---------------------------------------------------------------------------

describe('composePendingFile and parsePendingFingerprint (b.av2 SR-8.1)', () => {
  const fp = reloadFingerprint(CONFIG, baseEntries())
  const other = reloadFingerprint(CONFIG, [])

  test('lays out the header, the fingerprint line, a blank line, then the body, ending in exactly one newline', () => {
    const body = 'A configuration change is pending. Nothing has been applied.\nadded: personas[1] "beta" (key=beta)'

    const text = composePendingFile(fp, body)

    expect(text).toBe(`${PENDING_FILE_HEADER}\n${PENDING_FINGERPRINT_PREFIX}${fp}\n\n${body}\n`)
    expect(composePendingFile(fp, `${body}\n`)).toBe(text)
    expect(text.startsWith('claude-slack-channel-bots: pending configuration change (written by the server)\nfingerprint: sha256:')).toBe(true)
    assertNoLeak({ text })
  })

  test.each([
    ['a one-line body', 'no effective change'],
    ['an empty body', ''],
    ['a body with CRLF lines', 'line one\r\nline two\r\n'],
    ['a body holding another fingerprint line', `${PENDING_FILE_HEADER}\n${PENDING_FINGERPRINT_PREFIX}${other}\n`],
  ])('parsing the composed file returns its fingerprint (%s)', (_label, body) => {
    expect(parsePendingFingerprint(composePendingFile(fp, body))).toBe(fp)
  })

  test('a file saved with CRLF line ends still parses to its fingerprint', () => {
    const text = composePendingFile(fp, 'body').replaceAll('\n', '\r\n')

    expect(parsePendingFingerprint(text)).toBe(fp)
  })

  test.each([
    ['upper-case hex', fp.toUpperCase()],
    ['63 digits', fp.slice(1)],
    ['65 digits', `${fp}0`],
    ['a non-hex digit', `${fp.slice(1)}g`],
    ['the sha256: prefix included', `sha256:${fp}`],
    ['empty', ''],
  ])('compose refuses a malformed fingerprint (%s)', (_label, bad) => {
    expect(() => composePendingFile(bad, 'body')).toThrow('composePendingFile: the fingerprint must be 64 lower-case hex digits')
  })

  const line2 = `${PENDING_FINGERPRINT_PREFIX}${fp}`
  test.each([
    ['empty text', ''],
    ['the header alone', `${PENDING_FILE_HEADER}\n`],
    ['the header with no newline', PENDING_FILE_HEADER],
    ['a different header', `claude-slack-channel-bots: pending change\n${line2}\n`],
    ['a truncated header', `${PENDING_FILE_HEADER.slice(0, -1)}\n${line2}\n`],
    ['an empty first line', `\n${line2}\n`],
    ['no header', `${line2}\n\nbody\n`],
    ['a blank line before the header', `\n${PENDING_FILE_HEADER}\n${line2}\n`],
    ['the fingerprint on line 3', `${PENDING_FILE_HEADER}\n\n${line2}\n`],
    ['a fingerprint line without the prefix', `${PENDING_FILE_HEADER}\n${fp}\n`],
    ['a sha1-sized fingerprint', `${PENDING_FILE_HEADER}\n${PENDING_FINGERPRINT_PREFIX}${fp.slice(0, 40)}\n`],
    ['upper-case hex', `${PENDING_FILE_HEADER}\n${PENDING_FINGERPRINT_PREFIX}${fp.toUpperCase()}\n`],
    ['a trailing space after the digits', `${PENDING_FILE_HEADER}\n${line2} \n`],
    ['65 digits', `${PENDING_FILE_HEADER}\n${line2}0\n`],
    ['an indented fingerprint line', `${PENDING_FILE_HEADER}\n ${line2}\n`],
  ])('parse returns undefined for %s, without throwing', (_label, text) => {
    expect(parsePendingFingerprint(text)).toBeUndefined()
  })
})
