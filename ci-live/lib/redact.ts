/**
 * redact.ts — the one redaction step every /ci-live log, progress line and
 * report writer goes through.
 *
 * It masks two things:
 * - every exact secret value the process knows (the test password, the app
 *   configuration token and its refresh token, the tokens the run generates,
 *   the web client's session token, the Claude gateway key, an emailed
 *   sign-in code), registered with `addSecret` as soon as the value is read
 *   or generated, in each form it can take in an output (as it is, JSON- and
 *   Markdown-escaped);
 * - any token-shaped text, known or not: `xox?-…` (bot, user, session and
 *   cookie tokens), `xapp-…` (app-level tokens) and `xoxe.…` / `xoxe-…`
 *   (configuration and refresh tokens).
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

/**
 * The forms a secret can take in an output: as it is, JSON-escaped (inside a
 * JSON string in results.json) and Markdown-table-escaped (`|` as `\|` in a
 * results.md cell).
 */
export function secretForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1)
  const markdown = value.replace(/\|/g, '\\|')
  return [...new Set([value, json, markdown])]
}

export class Redactor {
  private readonly secrets = new Set<string>()
  private readonly forms = new Set<string>()
  private ordered: string[] = []

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
    }
  }

  /** How many distinct secret values are registered (never the values). */
  get secretCount(): number {
    return this.secrets.size
  }

  /**
   * Every form of every registered value (as it is, JSON- and
   * Markdown-escaped), for the secrecy scan's exact-value count. Never print
   * them.
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
