/**
 * app-token.flow.ts — app-level tokens on an app's Basic Information page.
 *
 * Generate: "Generate Token and Scopes" → token name → "Add Scope" →
 * `connections:write` → "Generate" → the `xapp-…` value is read from the
 * dialog into memory → "Done". Revoke: in the App-Level Tokens section's
 * list, open the named token → its dialog (titled with the name) →
 * "Revoke" → the stacked "Are you sure?" dialog → "Yes, I’m Sure" → the
 * token's dialog closes (or shows Slack's refusal) → then, after a reload,
 * the name is gone from that section's list. Used by the
 * tokens stage (`cscb-live`) and by Check 28 (B's rotated token, then the
 * older one's revocation).
 */

import type { Locator, Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { describeError } from '../lib/errors.ts'
import { buttonLike, clickButton, firstVisible, FlowError, gotoWithRetry, waitForState } from './common.ts'
import { APP_TOKEN_RE, findToken } from './page-secrets.ts'

const SCOPE = 'connections:write'

// The real page's markers (api.slack.com/apps/<id>/general), which the dry run's fixture copies.
/** The App-Level Tokens section (a card). */
const TOKEN_SECTION = '[data-qa="app_level_token_section"]'
/** The section's token list: shown once the tokens have loaded (a load error shows none), even when empty. */
const TOKEN_LIST = '[data-qa="app_level_tokens_table"]'
/** The Revoke button in a token's dialog (its accessible name is "Revoke token"). */
const REVOKE_BUTTON = '[data-qa="app_level_token_string_revoke"]'
/** The "Are you sure?" alertdialog Revoke opens over the token's dialog, and its "Yes, I’m Sure" button. */
const REVOKE_SPEEDBUMP = '[data-qa="app_level_token_revoke_speedbump"]'
const REVOKE_CONFIRM = '[data-qa="app_level_token_revoke_speedbump_go"]'
/** The token dialog's own words when the revocation fails. */
const REVOKE_REFUSED_RE = /can[’']t revoke this token/i

/** How long the section and its list have to render after a navigation. */
const TOKEN_LIST_MS = 15_000
/** How long the confirmation has to open, and to close once confirmed (the revocation request). */
const CONFIRM_OPEN_MS = 10_000
const CONFIRM_CLOSE_MS = 30_000
/** How long, once the confirmation has closed, Slack's answer (the token's dialog closing, or its refusal in it) has to show. */
const REVOKE_ANSWER_MS = 5_000
/** How long, reloading, the name may stay listed after a confirmed revocation. */
const REVOKE_VERIFY_MS = 30_000

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
  await gotoWithRetry(page, urls.basicInfoPage(appId))
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

/**
 * The App-Level Tokens section's list, once it has loaded, or null. The
 * section is its card, else the nearest block around the section's heading
 * that holds its Generate button; nothing outside it (a toast, a dialog, the
 * page's navigation) is ever read as the list.
 */
async function tokenList(page: Page): Promise<Locator | null> {
  const around = page
    .getByRole('heading', { name: /^app-level tokens$/i })
    .locator('xpath=ancestor::*[.//button[contains(normalize-space(.), "Generate Token and Scopes")]][1]')
  const section = await firstVisible([page.locator(TOKEN_SECTION), around], TOKEN_LIST_MS)
  if (!section) return null
  return firstVisible([section.locator(TOKEN_LIST), section.getByRole('table'), section.getByRole('list')], TOKEN_LIST_MS)
}

/** The list's entry named exactly `name` (a button on the real page). */
function tokenEntry(list: Locator, name: string): Locator[] {
  return [list.getByRole('button', { name, exact: true }), list.getByRole('link', { name, exact: true }), list.getByText(name, { exact: true })]
}

/** A dialog titled `name` (a token's dialog), else one that shows exactly `name`. */
function namedDialog(page: Page, name: string): Locator[] {
  const shown = page.getByText(name, { exact: true })
  return [
    page.getByRole('dialog', { name, exact: true }),
    page.getByRole('dialog').filter({ has: shown }),
    page.locator('[role="dialog"], .modal, [data-qa*="modal"]').filter({ has: shown }),
  ]
}

/** The "Are you sure?" confirmation Revoke opens (an alertdialog stacked over the token's dialog). */
function revokeConfirmation(page: Page): Locator[] {
  return [
    page.locator(REVOKE_SPEEDBUMP),
    page.getByRole('alertdialog').filter({ hasText: /are you sure/i }),
    page.getByRole('dialog').filter({ hasText: /are you sure/i }),
  ]
}

/**
 * Revoke the app-level token named `name`: find it in the App-Level Tokens
 * list, open it, check its dialog names it, press Revoke, answer the "Are
 * you sure?" confirmation, wait for that to close and for Slack's answer,
 * then reload until the section's list no longer names it. Every failure,
 * Playwright's own included (a timeout, a closed page, a failed
 * navigation), is a FlowError that names the step (`revoke: <step>: …`) and
 * the token (a name, never a value); Playwright's error only as
 * `describeError` gives it (its first line, no URL query).
 */
export async function revokeAppToken(page: Page, urls: SlackUrls, appId: string, name: string): Promise<void> {
  let step = 'find'
  try {
    await gotoWithRetry(page, urls.basicInfoPage(appId))
    const list = await tokenList(page)
    if (!list) throw new FlowError('revoke: find: the App-Level Tokens list did not render')
    const entry = await firstVisible(tokenEntry(list, name), 20_000)
    if (!entry) throw new FlowError(`revoke: find: no token named "${name}" in the App-Level Tokens list`)
    step = 'open'
    await entry.click()
    const d = await firstVisible(namedDialog(page, name), 15_000)
    if (!d) throw new FlowError(`revoke: open: no dialog naming "${name}" opened`)
    step = 'press Revoke'
    // The Revoke button shows once the dialog has loaded the token.
    const revoke = await firstVisible([d.locator(REVOKE_BUTTON), ...buttonLike(d, /^revoke( token)?$/i)])
    if (!revoke) throw new FlowError(`revoke: press Revoke: the dialog for "${name}" has no Revoke button`)
    await revoke.click()
    step = 'confirm'
    await confirmRevocation(page, d, name)
    step = 'verify'
    await verifyRevoked(page, urls, appId, name)
  } catch (err) {
    if (err instanceof FlowError) throw err
    throw new FlowError(`revoke: ${step}: ${describeError(err)}`)
  }
}

/**
 * Answer the "Are you sure?" confirmation, wait for it to close (the
 * revocation request has answered), then for Slack's answer in the token's
 * dialog `d`: the dialog closing (revoked), or Slack's refusal in it, which
 * may show a moment after the confirmation closes.
 */
async function confirmRevocation(page: Page, d: Locator, name: string): Promise<void> {
  const confirmation = await firstVisible(revokeConfirmation(page), CONFIRM_OPEN_MS)
  if (!confirmation) throw new FlowError('revoke: confirm: no "Are you sure?" confirmation opened after Revoke')
  const yes = await firstVisible([confirmation.locator(REVOKE_CONFIRM), ...buttonLike(confirmation, /^(yes\b|revoke|confirm)/i)], CONFIRM_OPEN_MS)
  if (!yes) throw new FlowError('revoke: confirm: the "Are you sure?" confirmation has no "Yes, I’m Sure" button')
  await yes.click()
  // It closes when the revocation request has answered; leaving the page before then could cancel it.
  const closed = await waitForState({ closed: async () => !(await confirmation.isVisible()) }, CONFIRM_CLOSE_MS)
  if (!closed) throw new FlowError(`revoke: confirm: the "Are you sure?" confirmation did not close within ${CONFIRM_CLOSE_MS / 1_000} s`)
  // A refusal leaves the token's dialog open with Slack's reason in it; a revocation closes it. Neither within the wait: the reload decides.
  const answer = await waitForState(
    {
      refused: () => d.getByText(REVOKE_REFUSED_RE).first().isVisible(),
      revoked: async () => !(await d.isVisible()),
    },
    REVOKE_ANSWER_MS,
  )
  if (answer === 'refused') throw new FlowError(`revoke: confirm: Slack answered that it can't revoke "${name}"`)
}

/** Reload until the App-Level Tokens list no longer names `name` (an absent name counts only in a rendered list). */
async function verifyRevoked(page: Page, urls: SlackUrls, appId: string, name: string): Promise<void> {
  const deadline = Date.now() + REVOKE_VERIFY_MS
  let listed = false
  while (Date.now() < deadline) {
    await gotoWithRetry(page, urls.basicInfoPage(appId))
    const list = await tokenList(page)
    if (list) {
      if (!(await firstVisible(tokenEntry(list, name), 3_000))) return
      listed = true
    }
    await page.waitForTimeout(2_000)
  }
  throw new FlowError(
    listed
      ? `revoke: verify: "${name}" is still listed in the App-Level Tokens section ${REVOKE_VERIFY_MS / 1_000} s after the revocation was confirmed`
      : 'revoke: verify: the App-Level Tokens list did not render after the revocation',
  )
}
