/**
 * message.flow.ts — clicking a permission prompt's button in the web client.
 *
 * Opens the conversation in the web client, finds the message by its ts
 * (`data-item-key` / `data-msg-ts` / `id="message-list_<ts>"` in the web
 * client's message list), and clicks the button by its role and name. The
 * caller then verifies through `conversations.history` that the message
 * updated (`*Permission* — Allowed` / `— Denied by operator`).
 */

import type { Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { firstVisible, FlowError } from './common.ts'

export async function clickMessageButton(page: Page, urls: SlackUrls, teamId: string, conversationId: string, ts: string, buttonName: string): Promise<void> {
  await page.goto(urls.conversation(teamId, conversationId), { waitUntil: 'domcontentloaded' })
  const message = await firstVisible(
    [
      page.locator(`[data-item-key="${ts}"]`),
      page.locator(`[data-msg-ts="${ts}"]`),
      page.locator(`[id="message-list_${ts}"]`),
      page.locator(`[data-ts="${ts}"]`),
    ],
    60_000,
  )
  if (!message) throw new FlowError(`button: message ${ts} not found in the web client`)
  await message.scrollIntoViewIfNeeded().catch(() => undefined)
  await message.hover().catch(() => undefined)
  const button = await firstVisible([message.getByRole('button', { name: buttonName, exact: true }), message.locator('button').filter({ hasText: buttonName })], 15_000)
  if (!button) throw new FlowError(`button: no "${buttonName}" button on message ${ts}`)
  await button.click()
  await page.waitForTimeout(1_000)
}
