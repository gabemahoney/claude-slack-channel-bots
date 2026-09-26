/**
 * message.flow.ts — clicking a permission prompt's button in the web client.
 *
 * Opens the conversation in the web client (`openConversation`: the
 * client's first load may land on the workspace's default channel), then
 * finds the button: by its Block Kit id (`<ts>-<action id>`, with the
 * action id `perm_allow_…` / `perm_deny_…` for Allow / Deny), or inside the
 * message found by its ts (`data-item-key` / `data-msg-ts` /
 * `id="message-list_<ts>"`) by role and name. The message list is virtual:
 * a message outside the rendered window is not in the page, so the flow
 * scrolls the list toward it (up when it is older than every rendered
 * message, down when it is newer), a bounded number of times. The caller
 * then verifies through `conversations.history` that the message updated
 * (`*Permission* — Allowed` / `— Denied by operator`).
 */

import type { Locator, Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { dismissCookieBanner, firstVisible, FlowError, onConversation, openConversation } from './common.ts'

/** How long a freshly opened conversation has to render its messages. */
const FIRST_RENDER_MS = 20_000
/** How long each look for the message waits once messages are rendered. */
const LOOK_MS = 3_000
/** Scroll steps through the message list before giving up. */
const SCROLL_STEPS = 20
/** How long a found message has to show the button. */
const BUTTON_WAIT_MS = 15_000
/** Times the flow opens the conversation again when the client leaves it mid-search. */
const REOPENS = 1

/** The action id prefix of CSCB's permission buttons, by button name. */
const ACTION_PREFIX: Record<string, string> = { allow: 'perm_allow_', deny: 'perm_deny_' }

const TS_RE = /^\d+\.\d+$/

function exactName(name: string): RegExp {
  return new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

/** Order two message ts values (`<seconds>.<micros>`) without floating-point rounding. */
function compareTs(a: string, b: string): number {
  const [as = '0', au = ''] = a.split('.')
  const [bs = '0', bu = ''] = b.split('.')
  return Number(as) - Number(bs) || Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'))
}

function messageLocators(page: Page, ts: string): Locator[] {
  return [
    page.locator(`[data-item-key="${ts}"]`),
    page.locator(`[data-msg-ts="${ts}"]`),
    page.locator(`[id="message-list_${ts}"]`),
    page.locator(`[data-ts="${ts}"]`),
  ]
}

/** Any rendered message of the list (not the sidebar, whose items carry `data-item-key` too). */
function anyMessageLocators(page: Page): Locator[] {
  return [page.locator('[id^="message-list_"]'), page.locator('[data-msg-ts]')]
}

/** The button by its Block Kit id (`<ts>-<action id>`): by action id prefix, then by name. */
function buttonByIdLocators(page: Page, ts: string, buttonName: string): Locator[] {
  const prefix = ACTION_PREFIX[buttonName.toLowerCase()]
  const out: Locator[] = []
  if (prefix) out.push(page.locator(`button[id^="${ts}-"][data-qa-action-id^="${prefix}"]`))
  out.push(page.locator(`button[id^="${ts}-"]`).filter({ hasText: exactName(buttonName) }))
  return out
}

/** The button inside a found message, by role and name. */
function buttonInMessageLocators(message: Locator, buttonName: string): Locator[] {
  return [message.getByRole('button', { name: buttonName, exact: true }), message.locator('button').filter({ hasText: exactName(buttonName) })]
}

/** Where `ts` lies against the rendered messages: older than all, newer than all, among them, or unknown (none rendered). */
async function whereIs(page: Page, ts: string): Promise<'above' | 'below' | 'within' | 'unknown'> {
  const keys = await page
    .locator('[id^="message-list_"], [data-msg-ts], [data-item-key]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-msg-ts') ?? e.getAttribute('data-item-key') ?? e.id.replace(/^message-list_/, '')))
    .catch(() => [] as string[])
  const rendered = keys.filter((k) => TS_RE.test(k)).sort(compareTs)
  const oldest = rendered[0]
  const newest = rendered.at(-1)
  if (oldest === undefined || newest === undefined) return 'unknown'
  if (compareTs(ts, oldest) < 0) return 'above'
  if (compareTs(ts, newest) > 0) return 'below'
  return 'within'
}

/** Scroll the message list one step: the wheel over the list, then Page Up / Page Down. */
async function scrollMessages(page: Page, direction: 'up' | 'down'): Promise<void> {
  const list = await firstVisible([...anyMessageLocators(page), page.locator('[data-qa="message_pane"]'), page.locator('.p-message_pane')], 1_000)
  if (list) {
    await list.hover({ timeout: 5_000 }).catch(() => undefined)
    await page.mouse.wheel(0, direction === 'up' ? -1_500 : 1_500).catch(() => undefined)
  }
  await page.keyboard.press(direction === 'up' ? 'PageUp' : 'PageDown').catch(() => undefined)
}

/** Wait for the opened conversation to render its messages (or the wanted one). */
async function awaitFirstRender(page: Page, ts: string, buttonName: string): Promise<void> {
  await firstVisible([...buttonByIdLocators(page, ts, buttonName), ...messageLocators(page, ts), ...anyMessageLocators(page)], FIRST_RENDER_MS)
}

/** The visible button, scrolling the list toward the message while it is not rendered; null when the message shows without it. */
async function findButton(page: Page, urls: SlackUrls, teamId: string, conversationId: string, ts: string, buttonName: string): Promise<Locator | null> {
  let reopens = 0
  let steps = 0
  await awaitFirstRender(page, ts, buttonName)
  for (;;) {
    await dismissCookieBanner(page)
    const direct = await firstVisible(buttonByIdLocators(page, ts, buttonName), LOOK_MS)
    if (direct) return direct
    const message = await firstVisible(messageLocators(page, ts), 500)
    if (message) {
      await message.scrollIntoViewIfNeeded().catch(() => undefined)
      await message.hover().catch(() => undefined)
      return firstVisible([...buttonByIdLocators(page, ts, buttonName), ...buttonInMessageLocators(message, buttonName)], BUTTON_WAIT_MS)
    }
    if (!onConversation(page, conversationId)) {
      // The client left the conversation (a late redirect): open it again and look afresh.
      if (reopens >= REOPENS) throw new FlowError(`button: the web client left conversation ${conversationId}`)
      reopens++
      await openConversation(page, urls, teamId, conversationId)
      await awaitFirstRender(page, ts, buttonName)
      continue
    }
    if (steps >= SCROLL_STEPS) break
    const where = await whereIs(page, ts)
    if (where === 'within') throw new FlowError(`button: message ${ts} is not shown in conversation ${conversationId}, though messages on both sides of it are`)
    await scrollMessages(page, where === 'below' ? 'down' : 'up')
    steps++
  }
  throw new FlowError(`button: message ${ts} not found in conversation ${conversationId} (scrolled ${SCROLL_STEPS} times)`)
}

export async function clickMessageButton(page: Page, urls: SlackUrls, teamId: string, conversationId: string, ts: string, buttonName: string): Promise<void> {
  await openConversation(page, urls, teamId, conversationId)
  const button = await findButton(page, urls, teamId, conversationId, ts, buttonName)
  if (!button) throw new FlowError(`button: no "${buttonName}" button on message ${ts}`)
  await dismissCookieBanner(page)
  await button.scrollIntoViewIfNeeded().catch(() => undefined)
  await button.click()
  await page.waitForTimeout(1_000)
}
