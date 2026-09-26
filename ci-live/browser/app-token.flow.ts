/**
 * app-token.flow.ts — app-level tokens on an app's Basic Information page.
 *
 * Generate: "Generate Token and Scopes" → token name → "Add Scope" →
 * `connections:write` → "Generate" → the `xapp-…` value is read from the
 * dialog into memory → "Done". Revoke: open the named token → "Revoke" →
 * confirm. Used by the tokens stage (`cscb-live`) and by Check 28 (B's
 * rotated token, then the older one's revocation).
 */

import type { Locator, Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { buttonLike, clickButton, firstVisible, FlowError } from './common.ts'
import { APP_TOKEN_RE, findToken } from './page-secrets.ts'

const SCOPE = 'connections:write'

async function dialog(page: Page): Promise<Locator> {
  const d = await firstVisible([page.getByRole('dialog'), page.locator('[role="dialog"], .modal, [data-qa*="modal"]')], 15_000)
  if (!d) throw new FlowError('app token: no dialog opened')
  return d
}

async function chooseScope(page: Page, scope: Locator): Promise<void> {
  const select = scope.locator('select')
  if (await select.first().isVisible().catch(() => false)) {
    await select.first().selectOption({ label: SCOPE }).catch(async () => select.first().selectOption(SCOPE))
    return
  }
  const option = await firstVisible(
    [page.getByRole('option', { name: SCOPE }), page.getByRole('menuitem', { name: SCOPE }), page.getByText(SCOPE, { exact: true })],
    10_000,
  )
  if (!option) throw new FlowError(`app token: no ${SCOPE} scope option`)
  await option.click()
}

export async function generateAppToken(page: Page, urls: SlackUrls, appId: string, name: string): Promise<string> {
  await page.goto(urls.basicInfoPage(appId), { waitUntil: 'domcontentloaded' })
  await clickButton(page, /generate token and scopes/i, 'app token')
  const d = await dialog(page)
  const nameField = await firstVisible([d.getByLabel(/token name/i), d.getByPlaceholder(/token name|name/i), d.locator('input[type="text"]')], 10_000)
  if (!nameField) throw new FlowError('app token: no token name field')
  await nameField.fill(name)
  await clickButton(d, /add scope/i, 'app token')
  await chooseScope(page, d)
  await clickButton(d, /^generate$/i, 'app token')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = await dialog(page).catch(() => d)
    const token = await findToken(current, APP_TOKEN_RE)
    if (token) {
      const done = await firstVisible(buttonLike(current, /^done$/i), 5_000)
      if (done) await done.click().catch(() => undefined)
      return token
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new FlowError('app token: the generated token did not appear in the dialog')
}

export async function revokeAppToken(page: Page, urls: SlackUrls, appId: string, name: string): Promise<void> {
  await page.goto(urls.basicInfoPage(appId), { waitUntil: 'domcontentloaded' })
  const entry = await firstVisible(
    [page.getByRole('button', { name, exact: true }), page.getByRole('link', { name, exact: true }), page.getByText(name, { exact: true })],
    20_000,
  )
  if (!entry) throw new FlowError('revoke: no app-level token with that name')
  await entry.click()
  const d = await dialog(page)
  await clickButton(d, /^revoke/i, 'revoke')
  // A confirmation step, when the page asks for one.
  const confirm = await firstVisible(buttonLike(page, /^(yes,? revoke|confirm)/i), 5_000)
  if (confirm) await confirm.click()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000)
    await page.goto(urls.basicInfoPage(appId), { waitUntil: 'domcontentloaded' })
    // The token list must have rendered before an absent name means anything.
    if (!(await firstVisible([page.getByText(/app-level tokens/i)], 15_000))) continue
    const still = await firstVisible([page.getByText(name, { exact: true })], 3_000)
    if (!still) return
  }
  throw new FlowError('revoke: the token is still listed')
}
