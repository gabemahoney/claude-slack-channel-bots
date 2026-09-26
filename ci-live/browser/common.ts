/**
 * common.ts — small Playwright helpers the flows share: find the first
 * visible match among fallback locators, click by role/text, wait for one of
 * several page states.
 *
 * Selectors are role- and text-based with fallbacks. The real Slack DOM is
 * verified only on a real run; the dry run proves the flows against the local
 * fixture pages. No helper takes screenshots, traces or logs page content.
 */

import type { Locator, Page } from 'playwright-core'

import { FlowError } from '../lib/browser-types.ts'

export const STEP_TIMEOUT_MS = 30_000

/** The first of `candidates` that becomes visible within `timeoutMs`, or null. */
export async function firstVisible(candidates: Locator[], timeoutMs = STEP_TIMEOUT_MS): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = c.first()
      if (await loc.isVisible().catch(() => false)) return loc
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/** A button (or a link styled as one) whose accessible name matches `name`. */
export function buttonLike(scope: Page | Locator, name: RegExp): Locator[] {
  return [scope.getByRole('button', { name }), scope.getByRole('link', { name }), scope.locator('button, a, [role="button"]').filter({ hasText: name })]
}

/** Click the first visible button-like element named `name`; throw a flow error naming `what` otherwise. */
export async function clickButton(scope: Page | Locator, name: RegExp, what: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const el = await firstVisible(buttonLike(scope, name), timeoutMs)
  if (!el) throw new FlowError(`${what}: no "${name.source}" button`)
  await el.click()
}

/** A flow step failed (defined with the browser interfaces, so catching it needs no playwright-core). */
export { FlowError }

/** Wait until one of `states` reports true; its key, or null at the deadline. */
export async function waitForState<K extends string>(states: Record<K, () => Promise<boolean>>, timeoutMs: number): Promise<K | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const [key, probe] of Object.entries(states) as [K, () => Promise<boolean>][]) {
      if (await probe().catch(() => false)) return key
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** The page's URL without its query or fragment (for decisions; never logged with a query). */
export function bareUrl(page: Page): string {
  const url = page.url()
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}
