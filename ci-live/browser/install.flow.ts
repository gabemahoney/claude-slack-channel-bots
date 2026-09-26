/**
 * install.flow.ts — installing a test app into the workspace as the test
 * human, and reading its Bot User OAuth Token.
 *
 * 1. Open the app's install page. It shows "Install to <Workspace>" (or
 *    "Reinstall to …"), or goes straight to the OAuth consent page. Slack may
 *    redirect api.slack.com app settings to app.slack.com/app-settings/…;
 *    the flow follows whatever it is sent to.
 * 2. On the consent page, "Allow".
 * 3. Open OAuth & Permissions and read the Bot User OAuth Token (`xoxb-…`)
 *    from the page into memory.
 */

import type { Page } from 'playwright-core'

import type { SlackUrls } from '../lib/browser-types.ts'
import { buttonLike, firstVisible, FlowError, waitForState } from './common.ts'
import { BOT_TOKEN_RE, findToken } from './page-secrets.ts'

const INSTALL_RE = /^(re)?install to /i
const ALLOW_RE = /^allow$/i

export async function installAndReadBotToken(page: Page, urls: SlackUrls, appId: string): Promise<string> {
  await page.goto(urls.installApp(appId), { waitUntil: 'domcontentloaded' })
  const first = await waitForState(
    {
      install: async () => (await firstVisible(buttonLike(page, INSTALL_RE), 200)) !== null,
      consent: async () => (await firstVisible(buttonLike(page, ALLOW_RE), 200)) !== null,
    },
    45_000,
  )
  if (first === null) throw new FlowError('install: neither an Install button nor the consent page appeared')
  if (first === 'install') {
    const install = await firstVisible(buttonLike(page, INSTALL_RE), 5_000)
    if (!install) throw new FlowError('install: the Install button went away')
    await install.click()
  }
  const allow = await firstVisible(buttonLike(page, ALLOW_RE), 45_000)
  if (!allow) throw new FlowError('install: no Allow button on the consent page')
  const consentUrl = page.url()
  await allow.click()
  // Slack leaves the consent page for the app's settings (OAuth & Permissions with a success banner).
  await page.waitForURL((url) => url.toString() !== consentUrl, { timeout: 60_000 }).catch(() => undefined)
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  await page.goto(urls.oauthPage(appId), { waitUntil: 'domcontentloaded' })
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const token = await findToken(page, BOT_TOKEN_RE)
    if (token) return token
    // A masked token: reveal it.
    const reveal = await firstVisible(buttonLike(page, /^(show|reveal)$/i), 500)
    if (reveal) await reveal.click().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new FlowError('install: no Bot User OAuth Token on the OAuth & Permissions page')
}
