/**
 * redact.ts — the one redaction step every /ci-live log, progress line and
 * report writer goes through.
 *
 * It masks two things:
 * - every exact secret value the process knows (the test password, the app
 *   configuration token and its refresh token, the tokens the run generates,
 *   the web client's session token, the Claude gateway key, an emailed
 *   sign-in code), registered with `addSecret` as soon as the value is read
 *   or generated, in each form it can take in an output (`secretForms`: as it
 *   is, JSON-escaped in the ways JSON encoders escape it, JSON inside JSON,
 *   and Markdown-escaped);
 * - any token-shaped text, known or not: `xox?-…` (bot, user, session and
 *   cookie tokens), `xapp-…` (app-level tokens) and `xoxe.…` / `xoxe-…`
 *   (configuration and refresh tokens).
 *
 * `redactWrapped` adds a pass for a terminal's text (a tmux pane), where
 * Claude Code hard-wraps a long line itself, a line break then indentation
 * or a `│` / `⎿` border, so no value there can be trusted to be whole: it
 * also masks every fragment of 10 or more characters of a registered form,
 * and a registered value or token-shaped text split across rows.
 *
 * The counting side (`countTokenShaped`) is what the closing secrecy scan
 * uses on every output: it never returns a match, only a number.
 *
 * Pure: no I/O. Tests import it directly.
 */

/** What a masked known secret is replaced with. */
export const REDACTED_SECRET = '<redacted>'

/** What masked token-shaped text is replaced with. */
export const REDACTED_TOKEN = '<redacted-token>'

/**
 * Token-shaped text, for masking: a Slack token prefix followed by at least
 * one token character. A bare prefix (`xoxb-` alone, as a rule's wording
 * names it) is left as it is.
 */
const TOKEN_SHAPED_MASK_RE = /xox[a-z]-[A-Za-z0-9%._-]+|xapp-[A-Za-z0-9._-]+|xoxe[.-][A-Za-z0-9%._-]+/g

/**
 * Token-shaped text, for counting: a prefix followed by at least four token
 * characters, the first of them a digit or a letter. This is stricter than
 * the testplan's in-container `tokcount` (prefix plus a digit) only in that
 * it also counts configuration tokens (`xoxe.`) and session tokens whose
 * first character after the prefix is a letter.
 */
const TOKEN_SHAPED_COUNT_RE = /xox[a-z]-[A-Za-z0-9%][A-Za-z0-9%._-]{3,}|xapp-[A-Za-z0-9][A-Za-z0-9._-]{3,}|xoxe[.-][A-Za-z0-9][A-Za-z0-9%._-]{3,}/g

/**
 * Shortest value `addSecret` registers. Four characters, so the six-character
 * sign-in code Slack emails is masked and counted; shorter strings would mask
 * ordinary words.
 */
export const MIN_SECRET_LENGTH = 4

/** `value` inside a JSON string as `JSON.stringify` writes it, without the quotes. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * JSON string text with each UTF-16 unit past ASCII as `\uXXXX`, in lower-
 * or upper-case hex (a character past U+FFFF as its two surrogates), as
 * Python's `json.dumps` and PHP's `json_encode` write it by default.
 */
function asciiJson(json: string, upper: boolean): string {
  return json.replace(/[^\x00-\x7f]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${upper ? hex.toUpperCase() : hex}`
  })
}

/**
 * The forms a secret can take in an output: as it is; JSON-escaped (inside a
 * JSON string in results.json or a transcript), also with `/` as `\/` and
 * with the characters past ASCII as `\uXXXX` (and both), as other encoders
 * write it, and each of those escaped again (JSON inside a JSON string: `"`
 * as `\\\"`, `\` as `\\\\`); and Markdown-table-escaped (`|` as `\|` in a
 * results.md cell). Each once.
 */
export function secretForms(value: string): string[] {
  const json = jsonEscaped(value)
  const slashed = json.replace(/\//g, '\\/')
  const jsonForms = [json, slashed, ...[json, slashed].flatMap((j) => [asciiJson(j, false), asciiJson(j, true)])]
  const markdown = value.replace(/\|/g, '\\|')
  return [...new Set([value, json, markdown, ...jsonForms, ...jsonForms.map(jsonEscaped)])]
}

/**
 * The shortest fragment of a registered form `redactWrapped` masks wherever
 * it appears: 10 characters. A form shorter than that is masked only whole.
 */
export const MIN_FRAGMENT_LENGTH = 10

/** What may come before a row's text: indentation and the borders Claude Code draws, `│` and `⎿`. */
const ROW_LEAD = new Set([' ', '\t', '│', '⎿'])

/** What may come after a row's text: trailing spaces and a box's right border, `│`. */
const ROW_TRAIL = new Set([' ', '\t', '│'])

/**
 * In the rows rejoined: a token-shaped mask followed by more token
 * characters (the rest of a token a row break split after its first piece
 * was masked), or token-shaped text (one split before it was token-shaped,
 * even inside its prefix).
 */
const WRAPPED_TOKEN_RE = new RegExp(`(${REDACTED_TOKEN})[A-Za-z0-9%._-]+|${TOKEN_SHAPED_MASK_RE.source}`, 'g')

interface RejoinedRows {
  /** Every row's text, its leading indentation and borders and its trailing spaces and border left out, one straight after another; an empty row stays a line break. */
  text: string
  /** Where each character of `text` is in the source; -1 for an empty row's line break. */
  at: Int32Array
}

/** The rows of `text` rejoined, as if every row break had been a hard wrap. */
function rejoinRows(text: string): RejoinedRows {
  const at = new Int32Array(text.length + 1)
  const parts: string[] = []
  let n = 0
  for (let start = 0; ; ) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl
    let from = start
    while (from < end && ROW_LEAD.has(text.charAt(from))) from++
    let to = end
    while (to > from && ROW_TRAIL.has(text.charAt(to - 1))) to--
    if (to > from) {
      parts.push(text.slice(from, to))
      for (let i = from; i < to; i++) at[n++] = i
    } else {
      parts.push('\n')
      at[n++] = -1
    }
    if (nl === -1) break
    start = nl + 1
  }
  return { text: parts.join(''), at: at.subarray(0, n) }
}

/** A stretch of the source to mask, `[from, to)`, and with which mask. */
interface Mask {
  from: number
  to: number
  secret: boolean
}

/** The stretches of the source that `[from, to)` of the rejoined rows covers: one per row it reaches. */
function sourceStretches(rows: RejoinedRows, from: number, to: number, secret: boolean): Mask[] {
  const out: Mask[] = []
  let start = -1
  let prev = -2
  const close = (): void => {
    if (start >= 0) out.push({ from: start, to: prev + 1, secret })
  }
  for (let i = from; i < to; i++) {
    const p = rows.at[i] as number
    if (p < 0 || p !== prev + 1) {
      close()
      start = p
    }
    prev = p < 0 ? -2 : p
  }
  close()
  return out
}

/** `text` with each of `masks` (in any order, overlapping or not) replaced: one mask per merged stretch, a registered value's when any of it is one. */
function applyMasks(text: string, masks: Mask[]): string {
  if (masks.length === 0) return text
  masks.sort((a, b) => a.from - b.from)
  const out: string[] = []
  let done = 0
  let cur: Mask | null = null
  const flush = (): void => {
    if (!cur) return
    out.push(text.slice(done, cur.from), cur.secret ? REDACTED_SECRET : REDACTED_TOKEN)
    done = cur.to
  }
  for (const m of masks) {
    if (cur && m.from <= cur.to) {
      cur = { from: cur.from, to: Math.max(cur.to, m.to), secret: cur.secret || m.secret }
      continue
    }
    flush()
    cur = { ...m }
  }
  flush()
  out.push(text.slice(done))
  return out.join('')
}

export class Redactor {
  private readonly secrets = new Set<string>()
  private readonly forms = new Set<string>()
  private ordered: string[] = []
  /** Every MIN_FRAGMENT_LENGTH-character fragment of every form, and the forms shorter than that; rebuilt after a secret is added. */
  private fragments: { windows: Set<string>; short: string[] } | null = null

  /** Register a secret value; later output never shows it. Short or empty values are ignored. */
  addSecret(value: string | undefined | null): void {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    for (const v of new Set([value, trimmed])) {
      if (v.length < MIN_SECRET_LENGTH || this.secrets.has(v)) continue
      this.secrets.add(v)
      for (const form of secretForms(v)) this.forms.add(form)
      // Longest first, so a secret containing another is masked whole.
      this.ordered = [...this.forms].sort((a, b) => b.length - a.length)
      this.fragments = null
    }
  }

  /** How many distinct secret values are registered (never the values). */
  get secretCount(): number {
    return this.secrets.size
  }

  /**
   * Every form of every registered value (`secretForms`: as it is, each
   * JSON escape and Markdown-escaped), for the secrecy scan's exact-value
   * count. Never print them.
   */
  knownSecrets(): readonly string[] {
    return this.ordered
  }

  /** `text` with every known secret and all token-shaped text masked. */
  redact(text: string): string {
    let out = text
    for (const secret of this.ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED_SECRET)
    }
    return out.replace(TOKEN_SHAPED_MASK_RE, REDACTED_TOKEN)
  }

  /**
   * `redact(text)`, then a pass for a terminal's text, where Claude Code
   * hard-wraps a long line itself (a line break, then indentation or a `│`
   * / `⎿` border), which no capture undoes. The rows are rejoined, each
   * row's text straight after the last's (its indentation, borders and
   * trailing spaces left out; an empty row still breaks), and there:
   * - every fragment of MIN_FRAGMENT_LENGTH or more characters of a
   *   registered form is masked, wherever it is (a value cut short or
   *   split), and a shorter form whole, even split;
   * - token-shaped text split across rows is masked, even when the split
   *   falls inside its prefix, and so are the token characters that carry on
   *   from a token masked at the end of a row onto the next.
   * A mask is mapped back onto every row it reaches, each piece masked. The
   * cost is some over-masking: a row that ends with a token takes the next
   * row's leading run of token characters (a word, say) with it, and a
   * common 10-character run of a registered value (of an e-mail address,
   * say) is masked wherever it is.
   */
  redactWrapped(text: string): string {
    const once = this.redact(text)
    const rows = rejoinRows(once)
    const masks: Mask[] = []
    const mark = (from: number, to: number, secret: boolean): void => {
      masks.push(...sourceStretches(rows, from, to, secret))
    }
    const { windows, short } = this.fragmentIndex()
    const n = MIN_FRAGMENT_LENGTH
    let from = -1
    let to = -1
    for (let i = 0; windows.size > 0 && i + n <= rows.text.length; i++) {
      if (!windows.has(rows.text.slice(i, i + n))) continue
      if (i > to) {
        if (to > from) mark(from, to, true)
        from = i
      }
      to = i + n
    }
    if (to > from) mark(from, to, true)
    for (const form of short) {
      for (let at = rows.text.indexOf(form); at !== -1; at = rows.text.indexOf(form, at + 1)) mark(at, at + form.length, true)
    }
    for (const m of rows.text.matchAll(WRAPPED_TOKEN_RE)) {
      const skip = m[1]?.length ?? 0
      mark(m.index + skip, m.index + m[0].length, false)
    }
    return applyMasks(once, masks)
  }

  private fragmentIndex(): { windows: Set<string>; short: string[] } {
    if (this.fragments) return this.fragments
    const windows = new Set<string>()
    const short: string[] = []
    for (const form of this.forms) {
      if (form.length < MIN_FRAGMENT_LENGTH) short.push(form)
      else for (let i = 0; i + MIN_FRAGMENT_LENGTH <= form.length; i++) windows.add(form.slice(i, i + MIN_FRAGMENT_LENGTH))
    }
    this.fragments = { windows, short }
    return this.fragments
  }
}

/** How many token-shaped strings `text` holds. */
export function countTokenShaped(text: string): number {
  return (text.match(TOKEN_SHAPED_COUNT_RE) ?? []).length
}

/** How many times any of `secrets` occurs in `text` (each occurrence counted once per secret). */
export function countKnownSecrets(text: string, secrets: readonly string[]): number {
  let n = 0
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue
    n += text.split(secret).length - 1
  }
  return n
}
