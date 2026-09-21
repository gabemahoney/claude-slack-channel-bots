/**
 * getclient-allowlist-audit.ts — pure core for the getClient() call-site audit
 * (tests/outage-state.test.ts test 22).
 *
 * The audit anchors each sanctioned getClient() site by CONTENT, not by line
 * number, so that inserting/removing comment or JSDoc lines above a site never
 * churns tests/getclient-allowlist.txt. An anchor is a triple:
 *
 *     path | enclosing-scope-name | normalized-line-content
 *
 * - normalized-line-content: the matched source line, trimmed and with runs of
 *   internal whitespace collapsed to single spaces.
 * - enclosing-scope-name: the nearest enclosing named declaration, found by an
 *   indentation walk (see enclosingScope). `(module)` if none.
 *
 * The pure functions here take SYNTHETIC inputs (no fs / execSync), so the
 * behavioural directions (AC-1 comment insertion is inert, AC-2 new site fails,
 * AC-3 relocation fails) can be exercised in-process. The real test enumerates
 * src/**\/*.ts via fs, builds the Map, and calls auditGetClientAllowlist.
 *
 * SPDX-License-Identifier: MIT
 */

/** A single grep-equivalent hit for `\bgetClient\(\)`. */
export interface GetClientHit {
  path: string
  /** 1-based line number — used only in failure messages, never for matching. */
  line: number
  /** Enclosing scope name (or `(module)`). */
  scope: string
  /** Normalized (trimmed, whitespace-collapsed) line content. */
  content: string
}

/** A parsed allowlist entry. */
export interface AllowlistEntry {
  path: string
  scope: string
  content: string
  /** Raw reason text (everything after `#`), for round-tripping / diagnostics. */
  reason: string
  /** 1-based line number within the allowlist file, for stale-entry messages. */
  sourceLine: number
}

export interface AuditResult {
  /** Grep hits with no matching allowlist entry. Each is a ready-to-paste line. */
  violations: string[]
  /** Allowlist entries that matched no grep hit. */
  staleEntries: string[]
}

/** Trim and collapse internal whitespace runs to single spaces. */
export function normalizeContent(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/**
 * Mirror of the historical grep comment filter: drop lines whose content
 * begins with optional whitespace then `*` (JSDoc continuation) or `//`
 * (line comment). Single-line `/** ... *\/` JSDoc is NOT dropped (it does not
 * start with `*` or `//`), matching the original behaviour exactly.
 */
export function isFilteredCommentLine(line: string): boolean {
  return /^\s*(\*|\/\/)/.test(line)
}

const GETCLIENT_RE = /\bgetClient\(\)/

/** Leading-whitespace width of a line (tabs counted as single columns). */
function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)
  return m ? m[0].length : 0
}

/**
 * Does `trimmed` (an already-trimmed source line) begin a NAMED declaration?
 * Returns the captured name, or null. Recognizes:
 *   - function foo(          / export [async] function foo(
 *   - interface Foo          / export interface Foo
 *   - class Foo              / export class Foo
 *   - const foo = (...) =>   / export const foo = ... =>   / let/var
 *   - foo(...) {  method     (also foo: (...) => {  object-property arrow /
 *                            async foo(...) {  and get/set foo(...) {)
 */
export function declarationName(trimmed: string): string | null {
  let m: RegExpMatchArray | null

  m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/)
  if (m) return m[1]

  m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)
  if (m) return m[1]

  m = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)
  if (m) return m[1]

  m = trimmed.match(/^(?:export\s+)?(?:type)\s+([A-Za-z_$][\w$]*)\s*=/)
  if (m) return m[1]

  // const/let/var name = ...   (any binding: arrow, object literal, call, …).
  // Covers `const prodDeps: TemplateInstallDeps = {` (object opener) as well as
  // `const foo = (...) => {`.
  m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/)
  if (m) return m[1]

  // Object-literal / class property assigned an arrow:  name: (...) => {
  //   e.g.  directorStatus: async (channelId) => {
  m = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?\(.*\)\s*(?::[^=]*)?=>/)
  if (m) return m[1]

  // Method / interface-method shorthand:  name(...) {   or   name(...): T {
  //   e.g.  installSlackChannelBotTemplate(  ,  getClient(): Client
  //   Guard against control keywords (if/for/while/switch/catch/return...).
  m = trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/)
  if (m && !CONTROL_KEYWORDS.has(m[1])) return m[1]

  return null
}

/**
 * Is `trimmed` a multi-line-declaration continuation/close fragment — a line
 * that shares its opener's indent but is not itself the opener? Matches lines
 * that begin by closing a parameter list / open a body, e.g. `) {`,
 * `): Promise<T> {`, `): void {`, or a lone `{`.
 */
export function isSignatureContinuation(trimmed: string): boolean {
  return /^\)/.test(trimmed) || trimmed === '{'
}

/**
 * Does `trimmed` — already known to be a declarationName match — OPEN a scope
 * (a block body) rather than being a leaf member? A scope opener is a real
 * function/class/interface/type declaration, or any declaration line ending in
 * `{` (its body brace) or `=>` (an arrow whose body is on the next line). Leaf
 * members — an interface method (`getClient(): Client`), a single-line arrow
 * property (`getClient: () => getClient(),`) — do NOT, so they walk up to their
 * enclosing construct.
 */
export function opensOwnScope(trimmed: string): boolean {
  return /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type)\b/.test(trimmed)
}

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'throw',
  'else', 'do', 'with', 'new', 'typeof', 'void', 'delete', 'yield', 'super',
])

/**
 * Nearest enclosing named declaration for the match at `lineIndex` (0-based)
 * in `lines`, via an indentation walk.
 *
 * Check the match line ITSELF first: if it is a top-level declaration (e.g.
 * `export function getClient(): Client {`), its scope is its own name.
 * Otherwise start at the match line's indent and scan upward; a non-blank,
 * non-comment line with STRICTLY smaller indent is an enclosing construct — if
 * it is a declaration, capture its name and stop; otherwise adopt its indent
 * and keep scanning. `(module)` if the walk reaches the top.
 */
export function enclosingScope(lines: string[], lineIndex: number): string {
  // Self-check: the match line claims its OWN name only if it OPENS a scope
  // (`export function getClient(): Client {` → `getClient`). A leaf member with
  // no body brace (an interface method `getClient(): Client`, an object arrow
  // property) does NOT open a scope — it walks up to its enclosing construct
  // (→ `OutageStateDeps`). This keeps the four non-call entries honest.
  const selfTrimmed = lines[lineIndex].trim()
  const selfName = declarationName(selfTrimmed)
  if (selfName !== null && opensOwnScope(selfTrimmed)) return selfName

  let currentIndent = indentOf(lines[lineIndex])
  for (let i = lineIndex - 1; i >= 0; i--) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (isFilteredCommentLine(raw)) continue
    // Also skip single-line /** ... */ and /* ... */ JSDoc/block openers and
    // `*/` closers when scanning for structure — they are not declarations and
    // must not be adopted as indent reference points that mask the real parent.
    if (/^\/\*/.test(trimmed) || trimmed === '*/') continue

    const ind = indentOf(raw)
    if (ind >= currentIndent) continue

    const name = declarationName(trimmed)
    if (name !== null) return name

    // A non-declaration line at a strictly smaller indent means we've stepped
    // out one block. Multi-line declarations put their signature CLOSE line
    // (`): Promise<T> {`, `) {`, `}: Foo = {`, a lone `{`) at the same indent
    // as their opener (`function name(`), so when the smaller line is such a
    // continuation fragment we keep the CURRENT indent (don't lower) so the
    // opener — which shares that new indent — is still tested on the next
    // iteration. Otherwise lower the reference indent to this line's indent.
    if (isSignatureContinuation(trimmed)) {
      currentIndent = ind + 1 // test lines at `ind` next; opener resolves here
    } else {
      currentIndent = ind
    }
  }
  return '(module)'
}

/**
 * Scan one file's content for `\bgetClient\(\)` hits, applying the comment
 * filter, and resolve each hit's enclosing scope + normalized content.
 */
export function scanFile(path: string, content: string): GetClientHit[] {
  const lines = content.split('\n')
  const hits: GetClientHit[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!GETCLIENT_RE.test(raw)) continue
    if (isFilteredCommentLine(raw)) continue
    hits.push({
      path,
      line: i + 1,
      scope: enclosingScope(lines, i),
      content: normalizeContent(raw),
    })
  }
  return hits
}

/**
 * Parse the allowlist text. Lines are either blank, `#`-comment, or an entry:
 *
 *     path | scope | normalized content  # reason
 */
export function parseAllowlist(text: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    // Split off the trailing `# reason`. The reason may itself contain `#`, so
    // split on the FIRST ` #` (space-hash) that follows the third field.
    const hashIdx = trimmed.indexOf(' #')
    const anchor = hashIdx >= 0 ? trimmed.slice(0, hashIdx).trim() : trimmed
    const reason = hashIdx >= 0 ? trimmed.slice(hashIdx + 2).trim() : ''
    const parts = anchor.split('|').map((p) => p.trim())
    if (parts.length < 3) {
      // Malformed entry — surface it as its own (unparseable) entry so the
      // audit fails loudly rather than silently ignoring it.
      entries.push({ path: anchor, scope: '(unparseable)', content: '', reason, sourceLine: i + 1 })
      continue
    }
    entries.push({ path: parts[0], scope: parts[1], content: parts[2], reason, sourceLine: i + 1 })
  }
  return entries
}

/** Anchor key for exact one-to-one matching. */
function anchorKey(path: string, scope: string, content: string): string {
  return `${path} ${scope} ${content}`
}

/**
 * Pure audit core. `sources` maps path → file content; `allowlistText` is the
 * raw allowlist file. Performs an exact one-to-one assignment between grep
 * hits and allowlist entries keyed on (path, scope, content), enforcing counts
 * (a duplicate identical call consumes a second entry or is reported).
 */
export function auditGetClientAllowlist(
  sources: Map<string, string>,
  allowlistText: string,
): AuditResult {
  const hits: GetClientHit[] = []
  for (const [path, content] of sources) {
    hits.push(...scanFile(path, content))
  }

  const entries = parseAllowlist(allowlistText)

  // Bucket unconsumed allowlist entries by anchor key.
  const buckets = new Map<string, AllowlistEntry[]>()
  for (const e of entries) {
    const key = anchorKey(e.path, e.scope, e.content)
    const arr = buckets.get(key)
    if (arr) arr.push(e)
    else buckets.set(key, [e])
  }

  const violations: string[] = []
  for (const hit of hits) {
    const key = anchorKey(hit.path, hit.scope, hit.content)
    const arr = buckets.get(key)
    if (arr && arr.length > 0) {
      arr.shift() // consume exactly one entry
    } else {
      violations.push(`${hit.path}:${hit.line} (scope: ${hit.scope}): ${hit.content}`)
    }
  }

  const staleEntries: string[] = []
  for (const arr of buckets.values()) {
    for (const leftover of arr) {
      staleEntries.push(
        `${leftover.path} | ${leftover.scope} | ${leftover.content}` +
          (leftover.reason ? `  # ${leftover.reason}` : ''),
      )
    }
  }

  return { violations, staleEntries }
}
