/**
 * session.flow.ts — the test human's session API.
 *
 * After sign-in the web client keeps its session token (xoxc) in
 * `localStorage.localConfig_v2` on its own origin. The flow reads it once
 * into memory (registered with the redactor by the caller), and every call
 * then goes to `<workspace>/api/<method>` through the browser context's
 * request API, which sends the session cookie with it. Nothing is logged.
 */

import type { BrowserContext, Page } from 'playwright-core'

import type { HumanApi, SlackUrls } from '../lib/browser-types.ts'
import { formBody, SlackTransportError, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'
import { gotoWithRetry } from './common.ts'

const SESSION_TOKEN_RE = /^xoxc-[0-9A-Za-z-]+$/
const MAX_RATE_LIMIT_RETRIES = 4

interface LocalConfigTeam {
  token?: unknown
  domain?: unknown
}

/** The session token for `domain` from the web client's local config, or null when not signed in. */
export async function readSessionToken(page: Page, urls: SlackUrls, domain: string): Promise<string | null> {
  await gotoWithRetry(page, urls.clientHome(domain)).catch(() => undefined)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    // Sent to a sign-in page: there is no session to read.
    if (/sign_?in|signin|\/login/i.test(new URL(page.url()).pathname)) return null
    const raw = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('localConfig_v2')
      } catch {
        return null
      }
    }).catch(() => null)
    if (raw) {
      try {
        const teams = (JSON.parse(raw) as { teams?: Record<string, LocalConfigTeam> }).teams ?? {}
        const all = Object.values(teams)
        const team = all.find((t) => t.domain === domain) ?? (all.length === 1 ? all[0] : undefined)
        const token = team?.token
        if (typeof token === 'string' && SESSION_TOKEN_RE.test(token)) return token
      } catch {
        /* not JSON yet */
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** The human API over the context's request client (cookies shared with the pages). */
export function contextHumanApi(context: BrowserContext, urls: SlackUrls, domain: string, sessionToken: string): HumanApi {
  const base = urls.humanApiBase(domain)
  return {
    async call(method: string, params: SlackParams = {}): Promise<SlackResponse> {
      let response
      for (let attempt = 0; ; attempt++) {
        try {
          response = await context.request.post(new URL(method, base).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
            data: formBody({ ...params, token: sessionToken }),
            timeout: 30_000,
            maxRedirects: 0,
          })
        } catch {
          throw new SlackTransportError(method, 'network')
        }
        if (response.status() !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) break
        const wait = Math.min(Number(response.headers()['retry-after'] ?? '2') || 2, 60)
        await new Promise((r) => setTimeout(r, wait * 1000))
      }
      if (!response.ok()) throw new SlackTransportError(method, 'http', response.status())
      let json: unknown
      try {
        json = await response.json()
      } catch {
        throw new SlackTransportError(method, 'parse')
      }
      if (!json || typeof json !== 'object' || typeof (json as SlackResponse).ok !== 'boolean') throw new SlackTransportError(method, 'parse')
      return json as SlackResponse
    },
  }
}
