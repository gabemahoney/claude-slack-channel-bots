/** Observation only: never supplies an answer or changes the read-back oracle. */
import { createHash } from 'node:crypto'
import { scrubDiagnosticText } from './ai-failure-diagnostics.ts'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const stable = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))]))
  : Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : v)

export function parseReadbackJSON(text: string): any {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
}

/** Only whole fixture tokens and fixture punctuation may leave the container.
 * Mask before slicing: a clipped unknown token must not become an allowed word.
 * If any secret scrub changes the full input, withhold its entire excerpt so a
 * secret crossing the excerpt boundary cannot leak as disconnected fragments. */
function fixtureExcerpt(text: string, fixture: string, start: number, env: NodeJS.ProcessEnv): string {
  if (scrubDiagnosticText(text, env) !== text) return '<secret-bearing text withheld>'
  const words = new Set(fixture.match(/[A-Za-z0-9_]+/g) ?? [])
  const safe = text.replace(/[A-Za-z0-9_]+|[^A-Za-z0-9_]/g, token =>
    (/^[A-Za-z0-9_]+$/.test(token) ? words.has(token) : /\s/.test(token) || fixture.includes(token))
      ? token : '•'.repeat(token.length))
  return safe.slice(start, start + 80)
}

export function fixtureDifference(expected: string, actual: string, env: NodeJS.ProcessEnv = process.env) {
  let offset = 0
  while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) offset++
  const equal = expected === actual
  let suffix = 0
  while (suffix < Math.min(expected.length, actual.length) - offset
    && expected[expected.length - 1 - suffix] === actual[actual.length - 1 - suffix]) suffix++
  const removed = expected.length - offset - suffix, added = actual.length - offset - suffix
  const difference = equal ? 'equal' : expected.replace(/\s/g, '') === actual.replace(/\s/g, '') ? 'whitespace-only'
    : actual.length < expected.length && expected.startsWith(actual) ? 'truncation'
    : removed === 0 ? 'insertion' : added === 0 ? 'deletion' : 'substitution'
  const start = Math.max(0, offset - 40)
  return {
    expectedLength: expected.length, actualLength: actual.length, offsetUnit: 'UTF-16 code units',
    firstDifferenceOffset: equal ? null : offset, difference,
    expectedSha256: sha256(expected), actualSha256: sha256(actual),
    excerptStart: start,
    expectedExcerpt: equal ? '' : fixtureExcerpt(expected, expected, start, env),
    actualExcerpt: equal ? '' : fixtureExcerpt(actual, expected, start, env),
  }
}

export function readbackMismatch(expected: Record<string, unknown>, response: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  let value: any, parsedJSON = false
  if (response !== undefined) try { value = parseReadbackJSON(response); parsedJSON = true } catch { /* retained below */ }
  const object = value !== null && typeof value === 'object' && !Array.isArray(value)
  const keys = object ? Object.keys(value).sort() : []
  // Schema keys are fixture-derived too. Unknown key names can carry arbitrary
  // model text; retain their count/length and mask their spelling.
  const knownKeys = new Set([...Object.keys(expected), 'status'])
  const body = typeof expected.body === 'string'
  const expectedText = body ? expected.body as string : stable(expected)
  const actualText = body ? (typeof value?.body === 'string' ? value.body : '')
    : parsedJSON ? stable(value) : response ?? ''
  const mismatchedKeys = Object.keys(expected).filter(k => !object || !Object.prototype.hasOwnProperty.call(value, k)
    || stable(value[k]) !== stable(expected[k]))
  const record = {
    responsePresent: response !== undefined, responseLength: response?.length ?? 0,
    responseSha256: sha256(response ?? ''), parsedJSON,
    replyKind: response === undefined ? 'missing-response' : !parsedJSON ? 'invalid-json' : !object ? 'non-object-json'
      : body && typeof value.body !== 'string' ? 'missing-body' : 'readback',
    keys: keys.map(k => knownKeys.has(k) ? k : `<unknown key: ${k.length} code units>`),
    compared: body ? 'decoded body' : 'decoded JSON fields',
    bodyPresent: body ? typeof value?.body === 'string' : undefined,
    mismatchedKeys,
    ...fixtureDifference(expectedText, actualText, env),
  }
  return JSON.parse(scrubDiagnosticText(JSON.stringify(record), env)) as typeof record
}
