/**
 * install.ts — provisioning stage 3: install each app into the test
 * workspace as the test human, and keep its bot token in the persona's
 * credentials file.
 *
 * Skipped for a persona whose credentials file holds a bot token that passes
 * `auth.test` and belongs to the right app (`bots.info` → `app_id`), unless
 * the apps stage marked the app for re-install. The app is re-installed only
 * when Slack refuses the saved token or it belongs to another app: a
 * transient failure (network, timeout, 5xx, 429 after the retries,
 * `internal_error` …) of `auth.test` or `bots.info` stops the stage with a
 * `TransientProvisionError` and replaces nothing, so a rerun can pass.
 * Otherwise the browser installs (or re-installs) the app and reads the Bot
 * User OAuth Token from the OAuth & Permissions page, straight into memory and
 * then the file. The file's old app-level token is dropped with it (the
 * tokens stage generates a new one), so a credentials file never mixes two
 * apps' tokens.
 */

import { personaEntry, type AppsState } from '../lib/apps-state.ts'
import type { BrowserDriver } from '../lib/browser-types.ts'
import { appDisplayName, type PersonaLetter } from '../lib/personas.ts'
import type { PersonaCredentials } from '../lib/secrets.ts'
import { isTokenRefusal, type BotApi } from './bot-api.ts'

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionError'
  }
}

/** A stage stopped on a transient Slack failure; no working token was replaced, and a rerun may pass. */
export class TransientProvisionError extends ProvisionError {
  constructor(message: string) {
    super(`${message} (transient: rerun later)`)
    this.name = 'TransientProvisionError'
  }
}

export interface CredentialsAccess {
  readCredentials(letter: PersonaLetter): PersonaCredentials | null
  writeCredentials(letter: PersonaLetter, creds: PersonaCredentials): void
}

export interface InstallStageDeps {
  letters: readonly PersonaLetter[]
  appsFile: { load(): AppsState; update(change: (state: AppsState) => void): AppsState }
  creds: CredentialsAccess
  bots: BotApi
  browser: () => Promise<BrowserDriver>
  log: { info(message: string): void }
}

export type InstallAction = 'kept' | 'installed' | 'reinstalled'

function appIdOf(state: AppsState, letter: PersonaLetter): string {
  const appId = state.personas[letter]?.app_id
  if (!appId) throw new ProvisionError(`${appDisplayName(letter)} has no app ID in apps.json: run the apps stage first`)
  return appId
}

export async function runInstallStage(deps: InstallStageDeps): Promise<Record<string, InstallAction>> {
  const out: Record<string, InstallAction> = {}
  for (const letter of deps.letters) {
    const state = deps.appsFile.load()
    const appId = appIdOf(state, letter)
    const name = appDisplayName(letter)
    const reinstall = state.personas[letter]?.needs_reinstall === true
    const existing = deps.creds.readCredentials(letter)

    if (existing && !reinstall) {
      const check = await deps.bots.checkBotToken(existing.bot_token)
      if (check.ok && check.appId === appId) {
        deps.appsFile.update((s) => {
          const entry = personaEntry(s, letter)
          entry.bot_user_id = check.userId
          entry.bot_id = check.botId
          s.team_id = check.teamId
        })
        deps.log.info(`install: ${name}: kept (bot token ok for ${appId})`)
        out[letter] = 'kept'
        continue
      }
      if (!check.ok && !isTokenRefusal(check.error)) {
        throw new TransientProvisionError(`install: ${name}: auth.test failed (${check.error}), which is not a token refusal`)
      }
      if (check.ok && check.appLookupError !== undefined && !isTokenRefusal(check.appLookupError)) {
        throw new TransientProvisionError(`install: ${name}: bots.info failed (${check.appLookupError}), which is not a token refusal`)
      }
      const why = check.ok ? (check.appLookupError ?? 'another app') : check.error
      deps.log.info(`install: ${name}: bot token not usable (${why}); installing`)
    }

    const browser = await deps.browser()
    const botToken = await browser.installApp(appId)
    const check = await deps.bots.checkBotToken(botToken)
    if (!check.ok) throw new ProvisionError(`install: ${name}: the bot token read after install fails auth.test (${check.error})`)
    if (check.appLookupError !== undefined && !isTokenRefusal(check.appLookupError)) {
      throw new TransientProvisionError(`install: ${name}: bots.info failed (${check.appLookupError}) for the bot token read after install`)
    }
    if (check.appId !== appId) throw new ProvisionError(`install: ${name}: the bot token read after install belongs to another app`)
    // A new bot token drops the old app-level token: the tokens stage generates one for this app.
    deps.creds.writeCredentials(letter, { bot_token: botToken, app_token: '' })
    if (existing?.app_token) deps.log.info(`install: ${name}: the old app-level token was dropped; the tokens stage generates a new one`)
    deps.appsFile.update((s) => {
      const entry = personaEntry(s, letter)
      entry.bot_user_id = check.userId
      entry.bot_id = check.botId
      delete entry.needs_reinstall
      s.team_id = check.teamId
    })
    out[letter] = existing ? 'reinstalled' : 'installed'
    deps.log.info(`install: ${name}: ${out[letter]} (bot user ${check.userId})`)
  }
  return out
}
