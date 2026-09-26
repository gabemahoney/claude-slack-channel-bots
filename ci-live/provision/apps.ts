/**
 * apps.ts — provisioning stage 1: the four test apps "CSCB Test A" … "D".
 *
 * Per persona, idempotently:
 * - an app ID in apps.json that `apps.manifest.export` finds is reused; when
 *   its manifest drifted from the one generated from the repo's
 *   `slack-app-manifest.yml`, it is updated with `apps.manifest.update` and
 *   marked for re-install (the install stage re-installs it);
 * - otherwise the app is created with `apps.manifest.create`, and its ID is
 *   written to apps.json at once, before anything else happens, so a crash or
 *   a rerun never creates a second app for the persona.
 *
 * The create response's `credentials` block (client secret, signing secret,
 * verification token) is never read, logged or stored: only `app_id` is taken
 * from the answer.
 *
 * A create is never retried blindly: when `apps.manifest.create` gets no
 * answer (network error, timeout, 5xx), Slack may have created the app
 * anyway, so the run stops (not runnable) and tells the operator to look for
 * a duplicate at api.slack.com/apps before rerunning. The caller can also
 * forbid creating at all (`refuseCreate`: no apps.json on a real run, where
 * the apps may already exist from another VM).
 */

import { personaEntry, isAppId, type AppsState } from '../lib/apps-state.ts'
import { manifestDrift, type JsonObject } from '../lib/manifest.ts'
import { appDisplayName, type PersonaLetter } from '../lib/personas.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { safeErrorCode, SlackTransportError, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'

/** Export answers that mean the recorded app no longer exists. */
export const APP_MISSING_CODES = new Set(['app_not_found', 'invalid_app_id', 'invalid_app', 'app_deleted'])

export type AppAction = 'reused' | 'updated' | 'created'

export interface AppOutcome {
  letter: PersonaLetter
  appId: string
  action: AppAction
  /** Dotted manifest paths that drifted (only for `updated`). */
  drift: string[]
}

export interface AppsStageDeps {
  /** One manifest API call with the configuration token. */
  callManifest: (method: string, params: SlackParams) => Promise<SlackResponse>
  appsFile: { load(): AppsState; update(change: (state: AppsState) => void): AppsState }
  manifestFor: (letter: PersonaLetter) => JsonObject
  letters: readonly PersonaLetter[]
  log: { info(message: string): void; detail(message: string): void }
  /** When set, the stage creates no app: it stops (not runnable) with this reason instead. */
  refuseCreate?: string | null
}

/** The operator's next step when a create got no answer (the app may exist now). */
export function createUnansweredMessage(name: string, kind: string): string {
  return (
    `apps.manifest.create for ${name} got no answer (${kind}), so Slack may have created the app anyway. ` +
    `Before rerunning, check your apps at https://api.slack.com/apps for a "${name}" not in apps.json: ` +
    'delete it, or put its app ID in apps.json'
  )
}

/** A manifest API call failed for a reason other than the token (which throws non-runnable). */
export class AppsStageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppsStageError'
  }
}

function manifestOf(answer: SlackResponse): JsonObject | null {
  const m = answer.manifest
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as JsonObject) : null
}

async function ensureApp(deps: AppsStageDeps, letter: PersonaLetter): Promise<AppOutcome> {
  const wanted = deps.manifestFor(letter)
  const name = appDisplayName(letter)
  const recorded = deps.appsFile.load().personas[letter]?.app_id

  if (recorded) {
    const exported = await deps.callManifest('apps.manifest.export', { app_id: recorded })
    if (exported.ok) {
      const current = manifestOf(exported)
      if (!current) throw new AppsStageError(`apps.manifest.export for ${name} (${recorded}) returned no manifest`)
      const drift = manifestDrift(wanted, current)
      if (drift.length === 0) return { letter, appId: recorded, action: 'reused', drift }
      const updated = await deps.callManifest('apps.manifest.update', {
        app_id: recorded,
        manifest: JSON.stringify(wanted),
      })
      if (!updated.ok) {
        throw new AppsStageError(`apps.manifest.update for ${name} (${recorded}) failed: ${safeErrorCode(updated)}`)
      }
      deps.appsFile.update((state) => {
        personaEntry(state, letter).needs_reinstall = true
      })
      return { letter, appId: recorded, action: 'updated', drift }
    }
    const code = safeErrorCode(exported)
    if (!APP_MISSING_CODES.has(code)) {
      throw new AppsStageError(`apps.manifest.export for ${name} (${recorded}) failed: ${code}`)
    }
    deps.log.info(`apps: ${name}: recorded app ${recorded} no longer exists (${code}); creating a new one`)
  }

  if (deps.refuseCreate) throw new NotRunnableError(deps.refuseCreate)
  let created: SlackResponse
  try {
    created = await deps.callManifest('apps.manifest.create', { manifest: JSON.stringify(wanted) })
  } catch (err) {
    if (err instanceof SlackTransportError) {
      // A 4xx status (429 left after the retries included) means Slack did not take the request.
      if (err.kind === 'http' && err.status !== undefined && err.status < 500) {
        throw new AppsStageError(`apps.manifest.create for ${name} was refused (HTTP ${err.status}); no app was created: rerun later`)
      }
      throw new NotRunnableError(createUnansweredMessage(name, `${err.kind}${err.status !== undefined ? ` ${err.status}` : ''}`))
    }
    throw err
  }
  if (!created.ok) throw new AppsStageError(`apps.manifest.create for ${name} failed: ${safeErrorCode(created)}`)
  const appId = created.app_id
  if (!isAppId(appId)) throw new AppsStageError(`apps.manifest.create for ${name} returned no app ID`)
  // Persist at once: the app exists now, whatever happens next.
  deps.appsFile.update((state) => {
    state.personas[letter] = { app_id: appId }
  })
  return { letter, appId, action: 'created', drift: [] }
}

export async function runAppsStage(deps: AppsStageDeps): Promise<AppOutcome[]> {
  const outcomes: AppOutcome[] = []
  for (const letter of deps.letters) {
    const outcome = await ensureApp(deps, letter)
    const extra = outcome.action === 'updated' ? ` (drifted: ${outcome.drift.join(', ')}; marked for re-install)` : ''
    deps.log.info(`apps: ${appDisplayName(letter)}: ${outcome.action} ${outcome.appId}${extra}`)
    outcomes.push(outcome)
  }
  return outcomes
}
