/**
 * app-tokens.ts — provisioning stage 4: each persona's app-level token
 * (`connections:write`, for Socket Mode).
 *
 * Skipped for a persona whose credentials file holds an app token that
 * `apps.connections.open` accepts (called, its WebSocket URL never opened).
 * A new token is generated only when there is none or Slack refuses the saved
 * one; any other failure (network, timeout, 5xx, 429 after the retries,
 * `internal_error` …) stops the stage with a `TransientProvisionError` and
 * keeps the saved token. The browser generates the token on the app's Basic
 * Information page, under the name the caller gives (the runner makes it
 * unique per run and records it in apps.json, so Check 28's revoke-by-name
 * can never pick a same-named token), and the value goes straight into the
 * file.
 */

import { personaEntry, type AppsState } from '../lib/apps-state.ts'
import type { BrowserDriver } from '../lib/browser-types.ts'
import { APP_TOKEN_NAME, appDisplayName, type PersonaLetter } from '../lib/personas.ts'
import { isTokenRefusal, type BotApi } from './bot-api.ts'
import { ProvisionError, TransientProvisionError, type CredentialsAccess } from './install.ts'

export interface AppTokenStageDeps {
  letters: readonly PersonaLetter[]
  appsFile: { load(): AppsState; update(change: (state: AppsState) => void): AppsState }
  creds: CredentialsAccess
  bots: BotApi
  browser: () => Promise<BrowserDriver>
  log: { info(message: string): void }
  /** The name a generated token gets (default `cscb-live`). */
  tokenName?: string
}

export type AppTokenAction = 'kept' | 'generated'

export async function runAppTokenStage(deps: AppTokenStageDeps): Promise<Record<string, AppTokenAction>> {
  const out: Record<string, AppTokenAction> = {}
  const tokenName = deps.tokenName ?? APP_TOKEN_NAME
  for (const letter of deps.letters) {
    const name = appDisplayName(letter)
    const appId = deps.appsFile.load().personas[letter]?.app_id
    if (!appId) throw new ProvisionError(`${name} has no app ID in apps.json: run the apps stage first`)
    const creds = deps.creds.readCredentials(letter)
    if (!creds) throw new ProvisionError(`tokens: ${name} has no credentials file: run the install stage first`)
    if (creds.app_token !== '') {
      const check = await deps.bots.checkAppToken(creds.app_token)
      if (check.ok) {
        deps.log.info(`tokens: ${name}: kept (apps.connections.open ok)`)
        out[letter] = 'kept'
        continue
      }
      if (!isTokenRefusal(check.error)) {
        throw new TransientProvisionError(`tokens: ${name}: apps.connections.open failed (${check.error}), which is not a token refusal`)
      }
      deps.log.info(`tokens: ${name}: app token refused (${check.error}); generating a new one`)
    }
    const browser = await deps.browser()
    const appToken = await browser.generateAppToken(appId, tokenName)
    const check = await deps.bots.checkAppToken(appToken)
    if (!check.ok && isTokenRefusal(check.error)) {
      throw new ProvisionError(`tokens: ${name}: the generated app token fails apps.connections.open (${check.error})`)
    }
    // Kept even when the check failed transiently: the token is new, and a rerun checks it again.
    deps.creds.writeCredentials(letter, { bot_token: creds.bot_token, app_token: appToken })
    deps.appsFile.update((s) => {
      personaEntry(s, letter).app_token_name = tokenName
    })
    if (!check.ok) {
      throw new TransientProvisionError(`tokens: ${name}: the generated app token (${tokenName}, saved) could not be checked: apps.connections.open failed (${check.error})`)
    }
    out[letter] = 'generated'
    deps.log.info(`tokens: ${name}: generated ${tokenName}`)
  }
  return out
}
