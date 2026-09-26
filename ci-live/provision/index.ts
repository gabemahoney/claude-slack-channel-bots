/**
 * index.ts — the provisioning run: apps → (login) → install → tokens →
 * channels → validate. Every stage re-verifies what exists and skips what is
 * already right, so a rerun on the same workspace changes nothing.
 *
 * The browser is created lazily (only the install and tokens stages, and the
 * channels stage's human session, need it) and signed in on first use.
 */

import type { AppsStateFile } from '../lib/apps-state.ts'
import type { Stage } from '../lib/args.ts'
import type { BrowserDriver } from '../lib/browser-types.ts'
import type { JsonObject } from '../lib/manifest.ts'
import { appDisplayName, PERSONA_LETTERS, type PersonaLetter } from '../lib/personas.ts'
import type { SecretStore } from '../lib/secrets.ts'
import type { SlackParams, SlackResponse } from '../lib/slack-api.ts'
import { runAppTokenStage, type AppTokenAction } from './app-tokens.ts'
import { runAppsStage, type AppOutcome } from './apps.ts'
import type { BotApi } from './bot-api.ts'
import { runChannelsStage } from './channels.ts'
import { runInstallStage, type InstallAction } from './install.ts'

export interface ProvisionDeps {
  store: SecretStore
  appsFile: AppsStateFile
  bots: BotApi
  callManifest: (method: string, params: SlackParams) => Promise<SlackResponse>
  manifestFor: (letter: PersonaLetter) => JsonObject
  /** The signed-in browser (created on first call). */
  browser: () => Promise<BrowserDriver>
  log: { info(message: string): void; detail(message: string): void }
  /** The name the tokens stage gives a generated app-level token (the runner makes it unique per run). */
  appTokenName?: string
  /**
   * A real run without `--create-apps`: when apps.json does not exist, the
   * apps stage creates no app (the four apps may exist already, created from
   * another VM) and stops, not runnable.
   */
  requireAppsJsonToCreate?: boolean
}

/** Why a real run with no apps.json creates no app, and what the operator does about it. */
export function missingAppsJsonMessage(path: string): string {
  return (
    `${path} does not exist, so the apps stage would create the four test apps "CSCB Test A"–"D". ` +
    'They may exist already (created from another VM): copy apps.json from that VM to this path (mode 600), ' +
    'or rerun with --create-apps to create new ones'
  )
}

export type ValidationStatus = 'ok' | 'failed'

export interface ProvisionReport {
  apps?: AppOutcome[]
  install?: Record<string, InstallAction>
  tokens?: Record<string, AppTokenAction>
  channels?: Record<string, string>
  validate?: Record<PersonaLetter, { bot: ValidationStatus; app: ValidationStatus }>
}

/** Which stages a request runs, in order: one stage, or all of them plus validation. */
export function stagesToRun(stage: Stage | null): { stages: Stage[]; validate: boolean } {
  if (stage !== null) return { stages: [stage], validate: false }
  return { stages: ['apps', 'install', 'tokens', 'channels'], validate: true }
}

/** Validate every persona's credentials file: `auth.test` and `apps.connections.open`. */
export async function validateCredentials(
  deps: Pick<ProvisionDeps, 'store' | 'bots' | 'log'>,
  letters: readonly PersonaLetter[] = PERSONA_LETTERS,
): Promise<Record<PersonaLetter, { bot: ValidationStatus; app: ValidationStatus }>> {
  const out = {} as Record<PersonaLetter, { bot: ValidationStatus; app: ValidationStatus }>
  for (const letter of letters) {
    const creds = deps.store.readCredentials(letter)
    const bot = creds ? await deps.bots.checkBotToken(creds.bot_token) : { ok: false as const, error: 'no_file' }
    const app = creds ? await deps.bots.checkAppToken(creds.app_token) : { ok: false as const, error: 'no_file' }
    out[letter] = { bot: bot.ok ? 'ok' : 'failed', app: app.ok ? 'ok' : 'failed' }
    const detail = (r: { ok: boolean; error?: string }): string => (r.ok ? 'ok' : `failed (${r.error})`)
    deps.log.info(`validate: ${appDisplayName(letter)}: bot_token ${detail(bot)}, app_token ${detail(app)}`)
  }
  return out
}

export function allValid(report: ProvisionReport['validate']): boolean {
  return report !== undefined && Object.values(report).every((v) => v.bot === 'ok' && v.app === 'ok')
}

export async function runProvisioning(deps: ProvisionDeps, stage: Stage | null): Promise<ProvisionReport> {
  const { stages, validate } = stagesToRun(stage)
  const report: ProvisionReport = {}
  const creds = {
    readCredentials: (l: PersonaLetter) => deps.store.readCredentials(l),
    writeCredentials: (l: PersonaLetter, c: { bot_token: string; app_token: string }) => deps.store.writeCredentials(l, c),
  }
  for (const s of stages) {
    deps.log.info(`provision: stage ${s}`)
    switch (s) {
      case 'apps':
        report.apps = await runAppsStage({
          callManifest: deps.callManifest,
          appsFile: deps.appsFile,
          manifestFor: deps.manifestFor,
          letters: PERSONA_LETTERS,
          log: deps.log,
          refuseCreate: deps.requireAppsJsonToCreate && !deps.appsFile.exists() ? missingAppsJsonMessage(deps.appsFile.path) : null,
        })
        break
      case 'install':
        report.install = await runInstallStage({
          letters: PERSONA_LETTERS,
          appsFile: deps.appsFile,
          creds,
          bots: deps.bots,
          browser: deps.browser,
          log: deps.log,
        })
        break
      case 'tokens':
        report.tokens = await runAppTokenStage({
          letters: PERSONA_LETTERS,
          appsFile: deps.appsFile,
          creds,
          bots: deps.bots,
          browser: deps.browser,
          log: deps.log,
          tokenName: deps.appTokenName,
        })
        break
      case 'channels': {
        const browser = await deps.browser()
        report.channels = await runChannelsStage({ human: await browser.humanApi(), appsFile: deps.appsFile, log: deps.log })
        break
      }
    }
  }
  if (validate) report.validate = await validateCredentials(deps)
  return report
}
