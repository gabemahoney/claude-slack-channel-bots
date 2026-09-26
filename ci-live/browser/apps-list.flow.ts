/**
 * apps-list.flow.ts — the signed-in user's apps, read off
 * https://api.slack.com/apps (no public Web API lists them).
 *
 * Every link to an app's page (`…/apps/A…`) names one app: its ID from the
 * link, its name from the link's text, and the cells of the row that holds
 * the link (a table row's cells; for a list item or card, its lines), one of
 * which is the app's workspace. An app with several links (an icon and a
 * name) is one row. The page's links become listed apps in
 * provision/app-listing.ts (`listedAppsFrom`), which cleans and caps every
 * text; nothing is logged or kept.
 */

import type { Page } from 'playwright-core'

import type { ListedApp, SlackUrls } from '../lib/browser-types.ts'
import { listedAppsFrom } from '../provision/app-listing.ts'
import { dismissCookieBanner, FlowError, gotoWithRetry, waitForState } from './common.ts'

const APP_LINKS = 'a[href*="/apps/A"]'
/** The page says the user has no app. */
const NO_APPS_RE = /haven.t (created|built) any apps|don.t have any apps|no apps yet/i
const SIGN_IN_PATH_RE = /sign_?in|signin|\/login/i

/** How long a listed page has to finish rendering its rows. */
const SETTLE_MS = 1_500

export async function listApps(page: Page, urls: SlackUrls): Promise<ListedApp[]> {
  await gotoWithRetry(page, urls.appsList())
  await dismissCookieBanner(page)
  const state = await waitForState(
    {
      signedOut: async () => SIGN_IN_PATH_RE.test(new URL(page.url()).pathname),
      list: async () => (await page.locator(APP_LINKS).count()) > 0,
      empty: async () => page.getByText(NO_APPS_RE).first().isVisible(),
    },
    45_000,
  )
  if (state === 'signedOut') throw new FlowError('apps list: the page asked to sign in')
  if (state === 'empty') return []
  if (state === null) throw new FlowError('apps list: the page showed no app list')
  await page.waitForTimeout(SETTLE_MS)
  const links = await page.locator(APP_LINKS).evaluateAll((els) =>
    els.map((e) => {
      const row = e.closest('tr, [role="row"], li, [data-qa*="app"], .card')
      let cells: string[] | null = null
      if (row) {
        const parts = Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'))
        // No cells (a list item or card): its rendered lines stand for them.
        cells = parts.length > 0 ? parts.map((c) => c.textContent ?? '') : ((row as HTMLElement).innerText ?? row.textContent ?? '').split(/[\t\n]+/)
      }
      return { href: e.getAttribute('href') ?? '', text: e.textContent ?? '', cells }
    }),
  )
  return listedAppsFrom(links)
}
