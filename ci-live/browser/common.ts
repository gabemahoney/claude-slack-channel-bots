/**
 * common.ts — small Playwright helpers the flows share: find the first
 * visible match among fallback locators, click by role/text, wait for one of
 * several page states, navigate with a retry on transient failures, and open
 * a conversation in the web client.
 *
 * Selectors are role- and text-based with fallbacks. The real Slack DOM is
 * verified only on a real run; the dry run proves the flows against the local
 * fixture pages. No helper takes screenshots, traces or logs page content.
 */

import type { Locator, Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { FlowError } from '../lib/browser-types.ts'

export const STEP_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Navigation failures a retry cures: Chrome's start-up transient
 * (ERR_CERT_VERIFIER_CHANGED on a fresh browser's first request), network
 * blips, a navigation the page itself interrupted, and timeouts.
 */
const TRANSIENT_NAVIGATION_RE =
  /net::ERR_(CERT_VERIFIER_CHANGED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)\b|interrupted by another navigation|Timeout \d+ms exceeded/i

export const GOTO_TRIES = 4
export const GOTO_RETRY_DELAY_MS = 2_000

/** True when `err` is a navigation failure worth another try (see TRANSIENT_NAVIGATION_RE). */
export function isTransientNavigationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'TimeoutError' || TRANSIENT_NAVIGATION_RE.test(err.message)
}

/**
 * `page.goto(url)` (to DOMContentLoaded), tried up to GOTO_TRIES times,
 * GOTO_RETRY_DELAY_MS apart, while it fails transiently. Another failure,
 * or the last try's, is thrown as Playwright reported it.
 */
export async function gotoWithRetry(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      return
    } catch (err) {
      if (attempt >= GOTO_TRIES || !isTransientNavigationError(err)) throw err
      await sleep(GOTO_RETRY_DELAY_MS)
    }
  }
}

/** Click the OneTrust cookie banner's accept button when it shows (slack.com pages); failures are ignored. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.locator('#accept-recommended-btn-handler, #onetrust-accept-btn-handler').first()
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 5_000 }).catch(() => undefined)
}

/** How long the web client has to load after a navigation. */
export const CLIENT_LOAD_MS = 60_000
/** Navigations to a conversation before giving up (the client's first load may send the page elsewhere). */
export const OPEN_CONVERSATION_TRIES = 3
/** How long a landed conversation must stay put (the client may redirect just after it boots). */
const OPEN_SETTLE_MS = 2_000

const SIGN_IN_PATH_RE = /sign_?in|signin|\/login/i

function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** True when the page's URL path ends with `/<conversationId>`. */
export function onConversation(page: Page, conversationId: string): boolean {
  return pathOf(page).endsWith(`/${conversationId}`)
}

/**
 * True when the web client shows a conversation's message list. Message
 * items carry `id="message-list_<ts>"` / `data-msg-ts`; `data-item-key`
 * alone is no sign, since the sidebar's channel items carry it too.
 */
export async function messageListShown(page: Page): Promise<boolean> {
  for (const selector of ['[id^="message-list_"]', '[data-msg-ts]', '[data-qa="message_pane"]', '.p-message_pane']) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true
  }
  return false
}

type ClientState = 'landed' | 'elsewhere' | 'signed-out'

/** Wait for the client to load after a navigation: on the conversation, on another one, or on a sign-in page; null at the deadline. */
async function awaitClient(page: Page, conversationId: string, timeoutMs: number): Promise<ClientState | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await dismissCookieBanner(page)
    if (SIGN_IN_PATH_RE.test(pathOf(page))) return 'signed-out'
    if (await messageListShown(page)) return onConversation(page, conversationId) ? 'landed' : 'elsewhere'
    await sleep(500)
  }
  return null
}

/**
 * Open a conversation in the web client and wait until the page is on it
 * with its message list shown. The client's first load in a page may send
 * it to the workspace's default channel instead; then (once the client has
 * loaded) it navigates again, up to OPEN_CONVERSATION_TRIES times. Each
 * navigation retries transient failures (gotoWithRetry). The cookie banner
 * is dismissed when it shows. Throws a FlowError naming the conversation
 * when the page never stays on it.
 */
export async function openConversation(page: Page, urls: SlackUrls, teamId: string, conversationId: string): Promise<void> {
  const target = urls.conversation(teamId, conversationId)
  for (let attempt = 1; attempt <= OPEN_CONVERSATION_TRIES; attempt++) {
    await gotoWithRetry(page, target)
    const state = await awaitClient(page, conversationId, CLIENT_LOAD_MS)
    if (state === 'signed-out') throw new FlowError(`open conversation ${conversationId}: the web client sent the page to sign in`)
    if (state === 'landed') {
      await sleep(OPEN_SETTLE_MS)
      if (onConversation(page, conversationId) && (await messageListShown(page))) {
        await dismissCookieBanner(page)
        return
      }
    }
    // Sent elsewhere (the client has loaded there), redirected after landing, or no client yet: navigate again.
  }
  throw new FlowError(`open conversation ${conversationId}: the web client did not stay on it after ${OPEN_CONVERSATION_TRIES} navigations`)
}

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
