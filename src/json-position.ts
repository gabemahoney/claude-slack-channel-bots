/**
 * json-position.ts — Where a JSON text first breaks the JSON grammar, as a
 * 1-based line and column, without echoing any of the text.
 *
 * Bun's `JSON.parse` error carries no position and can quote file content,
 * such as a token pasted into the configuration file (b.av2 SR-10.3). The
 * persona loader therefore drops the parser's message and reports only where
 * the text first stops being JSON, found here by a small validating scan of
 * the RFC 8259 grammar. The result holds numbers only.
 *
 * Pure (b.av2 SR-13.1): no I/O, no module-scope side effects. The scan is
 * iterative, so deep nesting cannot overflow the stack.
 *
 * SPDX-License-Identifier: MIT
 */

/** A 1-based line and column in a text. The column counts code points. */
export interface TextPosition {
  line: number
  column: number
}

/** JSON whitespace (RFC 8259): space, tab, line feed, carriage return. */
function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch)
}

/** Characters allowed after a backslash in a JSON string, other than `u`. */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])

/** The end of a scanned token, or the offset of its first invalid character. */
type ScanResult = { end: number } | { error: number }

/** Scan the string starting at `start` (a `"`). */
function scanString(text: string, start: number): ScanResult {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') return { end: i + 1 }
    if (ch.charCodeAt(0) < 0x20) return { error: i }
    if (ch !== '\\') {
      i++
      continue
    }
    const escape = text[i + 1]
    if (escape === undefined) return { error: text.length }
    if (SIMPLE_ESCAPES.has(escape)) {
      i += 2
      continue
    }
    if (escape !== 'u') return { error: i + 1 }
    for (let k = 2; k < 6; k++) {
      if (i + k >= text.length) return { error: text.length }
      if (!isHexDigit(text[i + k])) return { error: i + k }
    }
    i += 6
  }
  return { error: text.length }
}

/** Scan one or more digits from `i`; the first non-digit is an error when there is none. */
function scanDigits(text: string, i: number): ScanResult {
  if (!isDigit(text[i])) return { error: i }
  while (isDigit(text[i])) i++
  return { end: i }
}

/** Scan the number starting at `start` (a `-` or a digit). */
function scanNumber(text: string, start: number): ScanResult {
  let i = start
  if (text[i] === '-') i++
  if (text[i] === '0') {
    i++
  } else {
    const int = scanDigits(text, i)
    if ('error' in int) return int
    i = int.end
  }
  if (text[i] === '.') {
    const frac = scanDigits(text, i + 1)
    if ('error' in frac) return frac
    i = frac.end
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++
    if (text[i] === '+' || text[i] === '-') i++
    const exp = scanDigits(text, i)
    if ('error' in exp) return exp
    i = exp.end
  }
  return { end: i }
}

/** Scan the literal `word` at `start`: the first character that differs is the error. */
function scanLiteral(text: string, start: number, word: string): ScanResult {
  for (let k = 0; k < word.length; k++) {
    if (start + k >= text.length) return { error: text.length }
    if (text[start + k] !== word[k]) return { error: start + k }
  }
  return { end: start + word.length }
}

/** Scan a string, number or literal at `i`. */
function scanScalar(text: string, i: number): ScanResult {
  const ch = text[i]
  if (ch === '"') return scanString(text, i)
  if (ch === '-' || isDigit(ch)) return scanNumber(text, i)
  if (ch === 't') return scanLiteral(text, i, 'true')
  if (ch === 'f') return scanLiteral(text, i, 'false')
  if (ch === 'n') return scanLiteral(text, i, 'null')
  return { error: i }
}

/** What the scan expects next. */
type Expect = 'value' | 'valueOrClose' | 'key' | 'keyOrClose' | 'colon' | 'afterValue'

/**
 * The offset (in UTF-16 code units) of the first character at which `text`
 * stops being a JSON text (RFC 8259), `text.length` when it ends too early,
 * or undefined when it is valid JSON. A byte order mark is not whitespace, so
 * a leading one is reported at offset 0, as `JSON.parse` rejects it.
 */
export function jsonSyntaxErrorOffset(text: string): number | undefined {
  const containers: Array<'{' | '['> = []
  let expect: Expect = 'value'
  let i = 0
  for (;;) {
    while (isJsonWhitespace(text[i])) i++
    if (i >= text.length) return expect === 'afterValue' && containers.length === 0 ? undefined : text.length
    const ch = text[i]!
    const top = containers[containers.length - 1]

    if ((expect === 'valueOrClose' && ch === ']') || (expect === 'keyOrClose' && ch === '}')) {
      containers.pop()
      i++
      expect = 'afterValue'
      continue
    }
    if (expect === 'value' || expect === 'valueOrClose') {
      if (ch === '{' || ch === '[') {
        containers.push(ch)
        i++
        expect = ch === '{' ? 'keyOrClose' : 'valueOrClose'
        continue
      }
      const scalar = scanScalar(text, i)
      if ('error' in scalar) return scalar.error
      i = scalar.end
      expect = 'afterValue'
      continue
    }
    if (expect === 'key' || expect === 'keyOrClose') {
      if (ch !== '"') return i
      const key = scanString(text, i)
      if ('error' in key) return key.error
      i = key.end
      expect = 'colon'
      continue
    }
    if (expect === 'colon') {
      if (ch !== ':') return i
      i++
      expect = 'value'
      continue
    }
    // afterValue
    if (top === undefined) return i
    if (ch === ',') {
      i++
      expect = top === '{' ? 'key' : 'value'
      continue
    }
    if ((top === '{' && ch === '}') || (top === '[' && ch === ']')) {
      containers.pop()
      i++
      continue
    }
    return i
  }
}

/**
 * The 1-based line and column of `offset` in `text`. Lines are split at line
 * feeds; the column counts code points from the start of the line, so a
 * character outside the Basic Multilingual Plane counts once.
 */
export function positionAt(text: string, offset: number): TextPosition {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lineStart = before.lastIndexOf('\n') + 1
  const line = before.split('\n').length
  return { line, column: Array.from(before.slice(lineStart)).length + 1 }
}
