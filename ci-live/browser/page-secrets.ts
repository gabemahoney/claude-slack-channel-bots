/**
 * page-secrets.ts — reading a token off a page straight into memory.
 *
 * The value is looked for in every input's value and in the text of the
 * page (or of one dialog), and returned to the caller only; nothing here
 * logs, screenshots or stores it. The caller registers it with the redactor
 * before anything else.
 */

import type { Locator, Page } from 'playwright-core'

/** Bot tokens and app-level tokens, as the settings pages show them. */
export const BOT_TOKEN_RE = /xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+/
export const APP_TOKEN_RE = /xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[a-f0-9]+/

/** The first match of `re` in the input values, then the text, of `scope`. */
export async function findToken(scope: Page | Locator, re: RegExp): Promise<string | null> {
  const root: Locator = 'goto' in scope ? scope.locator('body') : scope
  const values: string[] = await root
    .locator('input, textarea')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value ?? ''))
    .catch(() => [] as string[])
  for (const v of values) {
    const m = re.exec(v)
    if (m) return m[0]
  }
  const text = await root.innerText().catch(() => '')
  const m = re.exec(text)
  return m ? m[0] : null
}
