/**
 * test-helpers/credentials.ts — Shared credentials fixtures and leak checks
 * (b.av2 SR-13.4).
 *
 * - `LEAK_SENTINEL` is a marker every fake token embeds, so a leaked value is
 *   easy to spot in any captured artifact.
 * - `fakeToken` builds a sentinel-bearing fake token at runtime from a prefix,
 *   so no file (this one included) needs a token literal (b.av2 SR-13.2).
 * - `makeCredentials` / `writeCredentialsFile` build and write a credentials
 *   file: by default a valid SR-1.4 object, with overrides for every invalid
 *   shape the credentials tests need.
 * - `assertNoLeak` fails the test when the sentinel or a token-like value
 *   appears in captured log lines, errors, results or files the code wrote.
 * - `TOKEN_LIKE` / `isTokenLike` are the one definition of "token-like" that
 *   `assertNoLeak` applies, exported so a repo-level audit (e.g. no token
 *   literal in any test file) uses exactly the same rule.
 *
 * Isolation (b.av2 SR-13.2): the helper writes only into the directory the
 * caller passes, which must be the test's own `mkdtempSync` directory, and
 * reads only the paths the caller marks with `writtenFile`. It never touches
 * the real home and imports no source module.
 *
 * SPDX-License-Identifier: MIT
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

/**
 * Distinctive marker embedded in every fake token value. Letters and digits
 * only: a runtime's JSON parse error quotes an unexpected identifier only up
 * to its first non-identifier character, so any other character would let a
 * leaked parse message carry just part of the sentinel and slip past
 * `assertNoLeak`.
 */
export const LEAK_SENTINEL = 'LEAKSENTINEL7Q2X9'

/** Prefix a `bot_token` must start with (SR-1.4). A bare prefix is not a token. */
export const BOT_TOKEN_PREFIX = 'xoxb-'

/** Prefix an `app_token` must start with (SR-1.4). A bare prefix is not a token. */
export const APP_TOKEN_PREFIX = 'xapp-'

/** File name `writeCredentialsFile` uses when the caller passes none. */
const DEFAULT_FILE_NAME = 'credentials.json'

/**
 * A token-like value: a Slack token prefix (`xox` plus one lower-case letter,
 * e.g. `xoxb-`, `xoxp-`, `xoxe-`, or `xapp-`) that starts the text or follows
 * a character other than an ASCII letter or digit, followed by at least one
 * token character (a letter or a digit), anywhere in the text. A bare prefix,
 * as in the rule text "bot_token must start with xoxb-", a word such as
 * "Xoxo bot", or a prefix glued to a word (`inboxapp-bot`) does not match.
 *
 * The same boundary as the source matcher `looksLikeSlackToken`
 * (`src/persona-identity.ts`), but wider after the dash (a letter as well as a
 * digit), so every value the loader rejects is token-like here too and
 * `assertNoLeak` stays at least as strict (E13 Director decision 14). Not
 * global, so `test` keeps no state between calls; build a global copy from
 * `TOKEN_LIKE.source` to find every occurrence.
 */
export const TOKEN_LIKE = /(?<![A-Za-z0-9])(?:xox[a-z]|xapp)-[A-Za-z0-9]/

/** Whether `text` holds a token-like value (see `TOKEN_LIKE`). */
export function isTokenLike(text: string): boolean {
  return TOKEN_LIKE.test(text)
}

/**
 * A sentinel-bearing fake token: `prefix`, then a digit, then
 * `LEAK_SENTINEL`, then `-<suffix>` when a suffix is given. The digit right
 * after the prefix gives the fake the real format (every Slack token has a
 * digit after its dash), so the source-side matcher `looksLikeSlackToken`
 * sees it as a token. Pass any prefix (`BOT_TOKEN_PREFIX`, `APP_TOKEN_PREFIX`,
 * a wrong one, or '' for no prefix); use distinct suffixes to tell two fake
 * tokens apart (e.g. 'env' vs 'file').
 */
export function fakeToken(prefix: string, suffix = ''): string {
  return `${prefix}1${LEAK_SENTINEL}${suffix === '' ? '' : `-${suffix}`}`
}

/**
 * Overrides for a credentials file.
 * - An object is merged over the valid defaults. A key set to `undefined` is
 *   dropped (missing key); any other key is added (extra key); any value is
 *   written as given (non-string, wrong or swapped prefix, empty string).
 * - A string is written verbatim as the whole file content, for non-JSON
 *   (e.g. `'{' + LEAK_SENTINEL`) or JSON non-object content
 *   (e.g. `'null'`, `JSON.stringify([fakeToken(BOT_TOKEN_PREFIX)])`).
 */
export type CredentialsOverrides = Readonly<Record<string, unknown>> | string

/**
 * A credentials object: by default a valid SR-1.4 object, exactly `bot_token`
 * (`xoxb-`) and `app_token` (`xapp-`), both sentinel-bearing and distinct.
 * An override set to `undefined` removes that key.
 */
export function makeCredentials(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    bot_token: fakeToken(BOT_TOKEN_PREFIX, 'bot'),
    app_token: fakeToken(APP_TOKEN_PREFIX, 'app'),
    ...overrides,
  }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged
}

/**
 * Write a credentials file at `<dir>/<name>` with mode 0600 and return its
 * path. `dir` must be the caller's own temp directory; there is no default
 * location. `name` may hold subdirectories, which are created, but must stay
 * inside `dir`. An existing file is overwritten and reset to 0600.
 * See `CredentialsOverrides` for how to build invalid content.
 */
export function writeCredentialsFile(
  dir: string,
  name: string = DEFAULT_FILE_NAME,
  overrides: CredentialsOverrides = {},
): string {
  const path = resolve(dir, name)
  const rel = relative(resolve(dir), path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`writeCredentialsFile: name must be a file inside dir, got ${JSON.stringify(name)}`)
  }
  const content = typeof overrides === 'string' ? overrides : JSON.stringify(makeCredentials(overrides), null, 2)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/** Marks a path whose content `assertNoLeak` must check. Build with `writtenFile`. */
export class WrittenFile {
  constructor(readonly path: string) {}
}

/**
 * Mark `path` as a file (or directory) the code under test wrote, so
 * `assertNoLeak` checks its content rather than the path string. A directory
 * is checked file by file, recursively. A path that does not exist fails.
 */
export function writtenFile(path: string): WrittenFile {
  return new WrittenFile(path)
}

/**
 * Fail the test if `LEAK_SENTINEL` (any letter case) or a token-like value
 * (see `TOKEN_LIKE`: `xox<letter>-` or `xapp-`, not glued to a preceding
 * letter or digit, followed by a token character) appears in `captured`.
 * A bare prefix such as "must start with xoxb-" passes.
 *
 * What is checked, by kind of value:
 * - string: the text.
 * - `Error`: `String(err)`, message, stack, own enumerable properties (e.g. a
 *   Slack error's `data`), `cause` and an `AggregateError`'s `errors`,
 *   recursively.
 * - array or plain object: every key and element, recursively, so a
 *   collection of items can be passed at once:
 *   `assertNoLeak({ logs, error, result })` or `assertNoLeak([line, err])`.
 *   A plain object with `toJSON` is checked in its serialized form.
 * - any other object (class instance, Map, Set, …): its serialized form,
 *   `JSON.stringify` (so `toJSON` applies) and `String(value)`.
 * - `Uint8Array`/`Buffer`: the bytes decoded as UTF-8.
 * - file content: a bare string is always text, never a path. To check a file
 *   the code wrote, wrap its path: `assertNoLeak(writtenFile(path))`, or mix
 *   it in: `assertNoLeak({ logs, out: writtenFile(path) })`.
 * - numbers, booleans, null, undefined, functions, symbols: nothing to check.
 *
 * On failure the error names the leaking item by its path from `label`
 * (e.g. `captured.logs[2]`, `captured.error.cause.message`) and whether it
 * holds the sentinel or a token-like value, never the leaked text.
 */
export function assertNoLeak(captured: unknown, label = 'captured'): void {
  scan(captured, redact(label), new WeakSet<object>())
}

/** Replace any sentinel or token-like run in a label so the label never leaks. */
function redact(text: string): string {
  return text
    .replace(new RegExp(`${TOKEN_LIKE.source}[A-Za-z0-9._-]*`, 'g'), '<token>')
    .replace(new RegExp(LEAK_SENTINEL, 'gi'), '<sentinel>')
}

/** Throw if `text` holds the sentinel or a token-like value. */
function checkText(text: string, label: string): void {
  if (text.toLowerCase().includes(LEAK_SENTINEL.toLowerCase())) {
    throw new Error(`assertNoLeak: ${label} contains LEAK_SENTINEL`)
  }
  if (isTokenLike(text)) {
    throw new Error(`assertNoLeak: ${label} contains a token-like value (xox<letter>-/xapp- followed by token characters)`)
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function scan(value: unknown, label: string, seen: WeakSet<object>): void {
  if (typeof value === 'string') return checkText(value, label)
  if (typeof value === 'bigint') return checkText(String(value), label)
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (value instanceof WrittenFile) return scanPath(value.path, label)
  if (value instanceof Uint8Array) return checkText(new TextDecoder().decode(value), label)
  if (value instanceof Error) return scanError(value, label, seen)
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, `${label}[${i}]`, seen))
    return
  }
  if (value instanceof Map) {
    let i = 0
    for (const [k, v] of value) {
      scan(k, `${label}<key ${i}>`, seen)
      scan(v, `${label}<value ${i}>`, seen)
      i++
    }
    return
  }
  if (value instanceof Set) {
    let i = 0
    for (const item of value) scan(item, `${label}<item ${i++}>`, seen)
    return
  }
  if (isPlainObject(value) && typeof (value as { toJSON?: unknown }).toJSON !== 'function') {
    for (const [key, item] of Object.entries(value)) {
      const itemLabel = `${label}.${redact(key)}`
      checkText(key, `${itemLabel} (key)`)
      scan(item, itemLabel, seen)
    }
    return
  }
  checkText(serialize(value), `${label} (serialized)`)
  checkText(stringify(value), `${label} (String)`)
}

function scanError(err: Error, label: string, seen: WeakSet<object>): void {
  checkText(err.message ?? '', `${label}.message`)
  checkText(err.stack ?? '', `${label}.stack`)
  checkText(stringify(err), `${label} (String)`)
  for (const [key, item] of Object.entries(err)) {
    if (key === 'cause' || key === 'errors') continue
    const itemLabel = `${label}.${redact(key)}`
    checkText(key, `${itemLabel} (key)`)
    scan(item, itemLabel, seen)
  }
  if ('cause' in err) scan(err.cause, `${label}.cause`, seen)
  if (err instanceof AggregateError) scan(err.errors, `${label}.errors`, seen)
}

/** Check a file's content, or every file name and content under a directory. */
function scanPath(path: string, label: string): void {
  const fileLabel = `${label} (file ${redact(path)})`
  if (!statSync(path).isDirectory()) return checkText(readFileSync(path, 'utf-8'), fileLabel)
  for (const entry of readdirSync(path)) {
    checkText(entry, `${fileLabel} entry name`)
    scanPath(join(path, entry), label)
  }
}

/** `JSON.stringify` that survives cycles and BigInt and expands nested Errors. */
function serialize(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') return String(v)
        if (v instanceof Error) {
          return { ...v, name: v.name, message: v.message, stack: v.stack, cause: (v as { cause?: unknown }).cause }
        }
        if (v !== null && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      }) ?? ''
    )
  } catch {
    return ''
  }
}

/** `String(value)`, or '' when the value has no usable string conversion. */
function stringify(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}
