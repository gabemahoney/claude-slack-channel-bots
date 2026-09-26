/**
 * login.flow.ts — signing the test human in to the test workspace with email
 * and password (`https://<domain>.slack.com/sign_in_with_password`).
 *
 * Outcomes: `signed-in`, or `needs-code` when Slack asks for a code it
 * emailed (a new device); the runner then reads the code from the test
 * mailbox when there is one (lib/sign-in-code.ts), and otherwise stops
 * (exit 2) and tells the operator to run `bun ci-live/run.ts login` once,
 * which asks for the code on the terminal without echoing it. A refused
 * password is non-runnable. Neither the email, the password nor a code is
 * logged; each is typed into its field only.
 *
 * A code (from either) is typed into the prompt's cleared fields; a refusal
 * still shown from an earlier code is no answer to it until that refusal
 * goes. A prompt gone to the signed-in client is `signed-in`.
 */

import type { ElementHandle, Locator, Page } from 'playwright-core'

import type { SignInOutcome, SlackUrls } from '../lib/browser-types.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { bareUrl, firstVisible, FlowError, waitForState } from './common.ts'

const SIGNED_IN_URL_RE = /app\.slack\.com\/client|\/ssb\/redirect|\/messages\b|\/archives\/|\/fixture\/client/

function codeInputs(page: Page) {
  return [
    page.locator('input[autocomplete="one-time-code"]'),
    page.locator('[data-qa*="confirmation_code"] input'),
    page.locator('input[aria-label*="code" i]'),
    page.locator('input[name*="code" i]'),
  ]
}

/**
 * The code prompt's fields: every visible match of the first selector that
 * shows one (one field, or Slack's one box per character), after waiting up
 * to `timeoutMs` for the prompt. Empty when there is none.
 */
async function codeFields(page: Page, timeoutMs: number): Promise<Locator[]> {
  if ((await firstVisible(codeInputs(page), timeoutMs)) === null) return []
  for (const candidate of codeInputs(page)) {
    const visible: Locator[] = []
    for (const field of await candidate.all()) if (await field.isVisible().catch(() => false)) visible.push(field)
    if (visible.length > 0) return visible
  }
  return []
}

async function outcomeAfterSubmit(page: Page): Promise<SignInOutcome> {
  const state = await waitForState(
    {
      signedIn: async () => SIGNED_IN_URL_RE.test(bareUrl(page)),
      needsCode: async () => (await firstVisible(codeInputs(page), 200)) !== null,
      refused: async () => page.getByText(/incorrect (email|password)|wrong password|doesn.t match/i).first().isVisible(),
    },
    60_000,
  )
  if (state === 'signedIn') return 'signed-in'
  if (state === 'needsCode') return 'needs-code'
  if (state === 'refused') throw new NotRunnableError("Slack refused the test human's email or password: check live.json's test_email and the test_password file")
  throw new FlowError('sign-in: no signed-in page, code prompt or error after submitting')
}

/** Sign in with email and password on the workspace's sign-in page. */
export async function signInWithPassword(page: Page, urls: SlackUrls, domain: string, email: string, password: string): Promise<SignInOutcome> {
  await page.goto(urls.signIn(domain), { waitUntil: 'domcontentloaded' })
  const emailField = await firstVisible([
    page.locator('input[type="email"]'),
    page.locator('input[name="email"]'),
    page.locator('#email'),
    page.getByLabel(/email/i),
  ])
  if (!emailField) throw new FlowError('sign-in: no email field')
  await emailField.fill(email)
  const passwordField = await firstVisible([page.locator('input[type="password"]'), page.locator('#password'), page.getByLabel(/password/i)])
  if (!passwordField) throw new FlowError('sign-in: no password field')
  await passwordField.fill(password)
  const submit = await firstVisible([
    page.locator('#signin_btn'),
    page.getByRole('button', { name: /^sign in/i }),
    page.locator('button[type="submit"]'),
  ])
  if (!submit) throw new FlowError('sign-in: no sign-in button')
  await submit.click()
  return outcomeAfterSubmit(page)
}

/** Text a code prompt shows when it refuses a code ("That code didn't work", "Invalid code", "code has expired"). */
const CODE_REFUSED_RE = /(invalid|incorrect|expired|wrong|didn.t work|not valid).{0,40}\bcode\b|\bcode\b.{0,40}(invalid|incorrect|has expired|is expired|wrong|didn.t work|not valid)/i

/** How long Slack has to answer a typed code before the prompt is taken as still asking. */
const CODE_ANSWER_MS = 45_000

/** The refusal the code prompt shows now (an earlier code's), or null. */
async function shownRefusal(page: Page): Promise<ElementHandle | null> {
  const refusal = page.getByText(CODE_REFUSED_RE).first()
  if (!(await refusal.isVisible().catch(() => false))) return null
  return refusal.elementHandle({ timeout: 1_000 }).catch(() => null)
}

/**
 * After a code is typed: `signed-in` once the page leaves for the client;
 * `needs-code` when the prompt refuses it or is still there at the deadline
 * (the prompt stays visible while Slack checks the code, so its presence
 * alone is no answer). `stale` is the refusal shown before this code was
 * typed: it is no answer to this code, so no refusal counts until it has
 * gone (hidden, removed, or its page replaced); a refusal shown after that
 * does.
 */
async function outcomeAfterCode(page: Page, stale: ElementHandle | null): Promise<SignInOutcome> {
  let staleShown = stale !== null
  const state = await waitForState(
    {
      signedIn: async () => SIGNED_IN_URL_RE.test(bareUrl(page)),
      refused: async () => {
        if (staleShown) staleShown = (await stale?.isVisible().catch(() => false)) === true
        return !staleShown && page.getByText(CODE_REFUSED_RE).first().isVisible()
      },
    },
    CODE_ANSWER_MS,
  )
  if (state === 'signedIn') return 'signed-in'
  if ((await firstVisible(codeInputs(page), 2_000)) !== null) return 'needs-code'
  // The prompt is gone: the page may have moved on to the client as the deadline passed.
  if (SIGNED_IN_URL_RE.test(bareUrl(page))) return 'signed-in'
  throw new FlowError('sign-in: no signed-in page and no code prompt after entering the code')
}

/**
 * Type an emailed confirmation code into the code prompt the page shows:
 * note a refusal still shown from an earlier code (see `outcomeAfterCode`),
 * clear the field(s) of what an earlier code left, type, submit. When the
 * prompt is gone and the page is the signed-in client (an earlier code went
 * through after all), `signed-in`.
 */
export async function submitConfirmationCode(page: Page, code: string): Promise<SignInOutcome> {
  const fields = await codeFields(page, 10_000)
  if (fields.length === 0) {
    if (SIGNED_IN_URL_RE.test(bareUrl(page))) return 'signed-in'
    throw new FlowError('sign-in: the code prompt is gone')
  }
  const stale = await shownRefusal(page)
  try {
    // Best effort: a field that will not clear leaves a wrong code, which the prompt refuses.
    for (const field of fields) await field.fill('', { timeout: 5_000 }).catch(() => undefined)
    await (fields[0] as Locator).click()
    await page.keyboard.type(code.replace(/[\s-]/g, ''), { delay: 50 })
    const submit = await firstVisible([page.getByRole('button', { name: /confirm|continue|submit|sign in/i })], 2_000)
    // The last character may submit the code already (Slack's prompt does): a button gone with the page is no error.
    if (submit) await submit.click({ timeout: 5_000 }).catch(() => undefined)
    return await outcomeAfterCode(page, stale)
  } finally {
    await stale?.dispose().catch(() => undefined)
  }
}
