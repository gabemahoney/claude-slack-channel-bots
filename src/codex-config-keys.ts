/** Import-safe, names-only TOML projection.
 * Scalar text is lexically skipped; names-only callers send only keys and zero
 * placeholders to the TOML parser for duplicate/table-definition validation.
 * The model reader separately decodes only the authorized top-level model.
 * No other source values or parser diagnostics can escape this module.
 */
export const CODEX_HOST_CONFIG_KEYS_ENV = 'CODEX_HOST_CONFIG_KEYS'
export const CODEX_CONFIG_MAX_BYTES = 1024 * 1024
export const CODEX_CONFIG_MAX_KEYS = 2048
export const CODEX_CONFIG_KEYS_MAX_BYTES = 128 * 1024
const MAX_DEPTH = 32
const MAX_SEGMENT_BYTES = 256
export type CodexConfigKeyPath = readonly string[]

// Exact rust-v0.159.2 / ff6aec96948b70d94983af2641a6b67c94faeff5:
// codex-rs/tui/src/screen_reader.rs:33-109 persists this native startup marker;
// codex-rs/tui/src/startup_orchestration.rs:327-336 calls its initializer.
// https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/tui/src/screen_reader.rs
export const CODEX_NATIVE_CONFIG_LEAVES: readonly CodexConfigKeyPath[] = Object.freeze([
  Object.freeze(['tui', 'screen_reader_detection_done']),
])

function invalid(): never { throw new Error('Codex config key projection is invalid or exceeds its limits') }
function wellFormed(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
}
function validSegment(segment: unknown): segment is string {
  return typeof segment === 'string' && Buffer.byteLength(segment) <= MAX_SEGMENT_BYTES
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(segment) && wellFormed(segment)
}
function pathId(path: CodexConfigKeyPath): string { return JSON.stringify(path) }
/** Safe, unambiguous display: a literal dot inside a quoted key stays quoted. */
export function codexConfigKeyName(path: CodexConfigKeyPath): string {
  return path.map(segment => /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)).join('.')
}
function quotedPath(path: CodexConfigKeyPath): string { return path.map(segment => JSON.stringify(segment)).join('.') }

/** Conservative TOML 1.0 lexer. Bounds also cap recursion and reconstruction.
 * Strings, arrays, inline tables, dotted/quoted keys and array tables retain
 * their structure; scalar payloads never enter the reconstructed document.
 */
function projectCodexConfig(text: string, readModel = false): {
  paths: CodexConfigKeyPath[]; tables: ReadonlySet<string>; model: unknown
} {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > CODEX_CONFIG_MAX_BYTES || !wellFormed(text)) invalid()
    let at = 0, definitions = 0
    const length = text.length
    const horizontal = () => { while (text[at] === ' ' || text[at] === '\t') at++ }
    const newline = () => {
      if (text[at] === '\r') { at++; if (text[at] !== '\n') invalid() }
      if (text[at] !== '\n') invalid()
      at++
    }
    const comment = () => {
      if (text[at] !== '#') return
      while (at < length && text[at] !== '\r' && text[at] !== '\n') {
        const c = text.charCodeAt(at++)
        if ((c < 32 && c !== 9) || c === 127) invalid()
      }
    }
    const whitespace = () => {
      while (true) {
        horizontal(); comment()
        if (text[at] !== '\n' && text[at] !== '\r') return
        newline()
      }
    }
    // Decode escapes only for a key. For scalar strings, even escaped content
    // is skipped without accumulating or returning any part of the payload.
    const string = (key: boolean): string => {
      const quote = text[at++]!
      const multi = !key && text[at] === quote && text[at + 1] === quote
      if (multi) at += 2
      let name = ''
      while (at < length) {
        const c = text[at++]!
        if (c === quote) {
          if (!multi) return name
          let run = 1
          while (text[at] === quote) { at++; run++ }
          if (run >= 3) { if (run > 5) invalid(); return name }
          continue
        }
        if (c === '\r' || c === '\n') {
          if (!multi) invalid()
          at--; newline(); continue
        }
        if ((c.charCodeAt(0) < 32 && c !== '\t') || c.charCodeAt(0) === 127) invalid()
        if (quote === '"' && c === '\\') {
          const escaped = text[at++]
          if (multi && (escaped === ' ' || escaped === '\t' || escaped === '\n' || escaped === '\r')) {
            at--; horizontal(); newline()
            while (true) { horizontal(); if (text[at] !== '\n' && text[at] !== '\r') break; newline() }
          } else if (escaped === 'u' || escaped === 'U') {
            const digits = escaped === 'u' ? 4 : 8
            let codepoint = 0
            for (let i = 0; i < digits; i++) {
              const hex = text.charCodeAt(at++)
              const digit = hex >= 48 && hex <= 57 ? hex - 48 : hex >= 65 && hex <= 70 ? hex - 55 : hex >= 97 && hex <= 102 ? hex - 87 : -1
              if (digit < 0) invalid()
              codepoint = codepoint * 16 + digit
            }
            if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) invalid()
            if (key) name += String.fromCodePoint(codepoint)
          } else {
            if (!escaped || !'btnfr"\\'.includes(escaped)) invalid()
            if (key) name += ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[escaped]
          }
        } else if (key) name += c
        if (key && name.length > MAX_SEGMENT_BYTES) invalid()
      }
      return invalid()
    }
    const keyPath = (): string[] => {
      const path: string[] = []
      while (true) {
        horizontal()
        let segment: string
        if (text[at] === '"' || text[at] === "'") segment = string(true)
        else {
          const start = at
          while (at < length && /[A-Za-z0-9_-]/.test(text[at]!)) at++
          if (at === start) invalid()
          segment = text.slice(start, at)
        }
        if (!validSegment(segment)) invalid()
        path.push(segment)
        if (path.length > MAX_DEPTH) invalid()
        horizontal()
        if (text[at] !== '.') return path
        at++
      }
    }
    // No capture groups or slices: test advances the cursor over scalar text.
    // Calendar ranges are lexical, including leap days; fractional/exponent
    // digits and underscores follow TOML's grammar rather than JS coercion.
    const day = '(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)'
    const time = '(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?'
    const decimal = '(?:0|[1-9](?:_?[0-9])*)'
    const fraction = '(?:\\.[0-9](?:_?[0-9])*)'
    const exponent = '(?:[eE][+-]?[0-9](?:_?[0-9])*)'
    // Compile constant signed-64-bit bounds into a lexical pattern. No scalar
    // is converted to a number, captured or retained to validate its range.
    const boundedDecimal = (limit: string): string => {
      const choices = ['0', '[1-9](?:_?[0-9]){0,17}', [...limit].join('_?')]
      for (let index = 0; index < limit.length; index++) {
        const low = index ? 0 : 1, high = Number(limit[index]) - 1
        if (high < low) continue
        choices.push([...limit.slice(0, index), `[${low}-${high}]`, ...Array<string>(limit.length - index - 1).fill('[0-9]')].join('_?'))
      }
      return `(?:${choices.join('|')})`
    }
    const integer = `(?:\\+?${boundedDecimal('9223372036854775807')}|-${boundedDecimal('9223372036854775808')}|0x(?:[0-9A-Fa-f](?:_?[0-9A-Fa-f]){0,14}|[0-7](?:_?[0-9A-Fa-f]){15})|0o[0-7](?:_?[0-7]){0,20}|0b[01](?:_?[01]){0,62})`
    const scalar = new RegExp(`(?:${day}(?:[Tt ]${time}(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?)?|${time}|true|false|[+-]?(?:inf|nan)|[+-]?${decimal}(?:${fraction}(?:${exponent})?|${exponent})|${integer})(?=$|[ \\t\\r\\n#,\\]\\}])`, 'y')
    const value = (depth: number): string => {
      if (depth > MAX_DEPTH) invalid()
      horizontal()
      if (text[at] === '"' || text[at] === "'") { string(false); return '0' }
      if (text[at] === '[') {
        at++; whitespace()
        const parts: string[] = []
        while (text[at] !== ']') {
          if (at >= length) invalid()
          parts.push(value(depth + 1)); whitespace()
          if (text[at] === ']') break
          if (text[at++] !== ',') invalid()
          whitespace()
        }
        at++
        return `[${parts.join(',')}]`
      }
      if (text[at] === '{') {
        at++; horizontal()
        const parts: string[] = []
        while (text[at] !== '}') {
          if (++definitions > CODEX_CONFIG_MAX_KEYS) invalid()
          const path = keyPath()
          if (text[at++] !== '=') invalid()
          parts.push(`${quotedPath(path)}=${value(depth + 1)}`); horizontal()
          if (text[at] === '}') break
          if (text[at++] !== ',') invalid()
          horizontal()
          if (text[at] === '}') invalid()
        }
        at++
        return `{${parts.join(',')}}`
      }
      scalar.lastIndex = at
      if (!scalar.test(text)) invalid()
      at = scalar.lastIndex
      return '0'
    }
    const document: string[] = []
    let root = true, modelText: string | undefined
    whitespace()
    while (at < length) {
      if (++definitions > CODEX_CONFIG_MAX_KEYS) invalid()
      if (text[at] === '[') {
        root = false
        at++
        const array = text[at] === '['
        if (array) at++
        const path = keyPath()
        if (text[at++] !== ']' || (array && text[at++] !== ']')) invalid()
        document.push(`${array ? '[[' : '['}${quotedPath(path)}${array ? ']]' : ']'}\n`)
      } else {
        const path = keyPath()
        if (text[at++] !== '=') invalid()
        horizontal()
        // The runner is authorized to read only the top-level model value.
        // Retain its string token alone; every other scalar stays lexical.
        const modelStart = readModel && root && path.length === 1 && path[0] === 'model'
          && (text[at] === '"' || text[at] === "'") ? at : undefined
        document.push(`${quotedPath(path)}=${value(0)}\n`)
        if (modelStart !== undefined) modelText = text.slice(modelStart, at)
      }
      horizontal(); comment()
      if (at < length) newline()
      whitespace()
    }
    // Only key names and fixed constants enter this object, never values.
    const skeleton: unknown = Bun.TOML.parse(document.join(''))
    const paths = new Map<string, CodexConfigKeyPath>()
    const tables = new Set<string>()
    const visit = (node: unknown, prefix: CodexConfigKeyPath, depth: number): void => {
      if (depth > MAX_DEPTH) invalid()
      if (Array.isArray(node)) { for (const element of node) visit(element, prefix, depth + 1); return }
      if (!node || typeof node !== 'object') return
      for (const key of Object.keys(node)) {
        const path = [...prefix, key]
        if (path.length > MAX_DEPTH) invalid()
        paths.set(pathId(path), path)
        if (paths.size > CODEX_CONFIG_MAX_KEYS) invalid()
        const child = (node as Record<string, unknown>)[key]
        if (child && typeof child === 'object' && !Array.isArray(child)) tables.add(pathId(path))
        visit(child, path, depth + 1)
      }
    }
    visit(skeleton, [], 0)
    const model = modelText === undefined ? undefined : (Bun.TOML.parse(`model=${modelText}`) as Record<string, unknown>).model
    return { paths: [...paths].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, path]) => path), tables, model }
  } catch { return invalid() }
}

export function scanCodexConfigKeyPaths(text: string): CodexConfigKeyPath[] {
  return projectCodexConfig(text).paths
}

/** Decode only the authorized top-level model; never parse other host values. */
export function readCodexConfigModel(text: string): unknown {
  return projectCodexConfig(text, true).model
}

/** Bounded, versioned plain environment payload; names are segment arrays. */
export function encodeCodexHostConfigKeys(paths: readonly CodexConfigKeyPath[]): string {
  const encoded = JSON.stringify({ version: 1, keys: paths })
  decodeCodexHostConfigKeys(encoded)
  return encoded
}
export function decodeCodexHostConfigKeys(encoded: string | undefined): CodexConfigKeyPath[] {
  try {
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > CODEX_CONFIG_KEYS_MAX_BYTES) invalid()
    const value = JSON.parse(encoded)
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'keys,version' || value.version !== 1 || !Array.isArray(value.keys) || value.keys.length > CODEX_CONFIG_MAX_KEYS) invalid()
    const keys = new Set<string>()
    for (const path of value.keys) {
      if (!Array.isArray(path) || !path.length || path.length > MAX_DEPTH || !path.every(validSegment)) invalid()
      const id = pathId(path)
      if (keys.has(id)) invalid()
      keys.add(id)
    }
    // Every admitted host config has the selected top-level model. Projection
    // also includes namespaces, so truncation cannot silently omit a parent.
    if (!keys.has(pathId(['model']))) invalid()
    for (const path of value.keys as string[][]) {
      for (let size = 1; size < path.length; size++) if (!keys.has(pathId(path.slice(0, size)))) invalid()
    }
    return value.keys
  } catch { return invalid() }
}

export interface CodexScratchConfigKeys {
  readonly keyNames: readonly string[]
  readonly unknownKeyCount: number
  readonly allowed: boolean
}
/** Caller enforces absence before first native spawn, and safe file reading.
 * Undefined means no scratch file. A missing/malformed host projection always
 * throws, including when the scratch file is absent. Invalid TOML throws a
 * fixed value-free error. Disallowed names are returned for safe recording.
 */
export function checkCodexScratchConfigKeys(text: string | undefined, hostProjection: string | undefined): CodexScratchConfigKeys {
  const host = new Set(decodeCodexHostConfigKeys(hostProjection).map(pathId))
  const { paths, tables } = text === undefined ? { paths: [], tables: new Set<string>() } : projectCodexConfig(text)
  const leaves = new Set(CODEX_NATIVE_CONFIG_LEAVES.map(pathId))
  const permitted = new Set(CODEX_NATIVE_CONFIG_LEAVES.flatMap(path => path.map((_, index) => pathId(path.slice(0, index + 1)))))
  const forbidden = (path: CodexConfigKeyPath) => path.some(segment => /^(?:model|model_reasoning_effort|profile|profiles)$|provider|auth/i.test(segment))
  const unknownKeyCount = paths.filter(path => {
    const id = pathId(path)
    // only native leaves and their actual parent tables
    // may overlap host names. Any extra descendant still rejects the file.
    const native = leaves.has(id) || (permitted.has(id) && tables.has(id))
    return forbidden(path) || (host.has(id) && !native) || !native
  }).length
  return { keyNames: paths.map(codexConfigKeyName), unknownKeyCount, allowed: unknownKeyCount === 0 }
}
