/**
 * apps.ts — provisioning stage 1: the four test apps "CSCB Test A" … "D".
 *
 * Per persona, idempotently:
 * - an app ID in apps.json that `apps.manifest.export` finds is reused; when
 *   its manifest drifted from the one generated from the repo's
 *   `slack-app-manifest.yml`, it is updated with `apps.manifest.update` and
 *   marked for re-install (the install stage re-installs it);
 * - otherwise the app is created with `apps.manifest.create`, crash-safely:
 *   a pending-create intent (`pending_create`) is written to apps.json
 *   first, and the app ID the moment the call returns it, clearing the intent
 *   in the same write;
 * - a persona whose intent is still there with no app ID (a run stopped
 *   between the two writes, or the create got no answer) is not created
 *   blindly: the apps list (api.slack.com/apps) is searched for unrecorded
 *   apps of its exact name that the configuration token manages. Exactly one
 *   is adopted (recorded, the intent cleared) and then checked like a
 *   recorded app; none clears the intent and creates; more than one is not
 *   runnable, naming them and pointing at `apps --delete-strays`. Only an
 *   export answer that the app is missing (APP_MISSING_CODES) or a manifest
 *   naming another app rules a listed app out: one whose check proved
 *   nothing (another Slack error, no answer), or an apps list that could not
 *   be read, stops the stage (`AppsStageError`) with the intent kept and
 *   nothing created.
 *
 * The create response's `credentials` block (client secret, signing secret,
 * verification token) is never read, logged or stored: only `app_id` is taken
 * from the answer.
 *
 * A create is never retried blindly: when `apps.manifest.create` gets no
 * answer (network error, timeout, 5xx), Slack may have created the app
 * anyway, so the run stops (not runnable) and keeps the intent for the next
 * run's search. A refusal (a 4xx, `ok: false`, the token refused) created
 * nothing and clears the intent. The caller can also forbid creating at all
 * (`refuseCreate`: no apps.json on a real run, where the apps may already
 * exist from another VM).
 *
 * The configuration token is optional once apps.json records all four app
 * IDs: when it is missing or refused (`ConfigTokenUnavailableError`) the
 * stage warns (never the value) and reuses the recorded apps without their
 * export, drift check or update. When an app would have to be created (or
 * an unfinished create resolved), the token's absence is not runnable as
 * before.
 */

import { isAppId, personaEntry, type AppsState, type PendingCreate } from '../lib/apps-state.ts'
import type { ListedApp } from '../lib/browser-types.ts'
import { describeError } from '../lib/errors.ts'
import { manifestDrift, type JsonObject } from '../lib/manifest.ts'
import { appDisplayName, PERSONA_LETTERS, type PersonaLetter } from '../lib/personas.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { safeErrorCode, SlackTransportError, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'
import { APP_MISSING_CODES, unrecordedTestApps, type PendingCandidates } from './app-listing.ts'
import { ConfigTokenUnavailableError } from './config-token.ts'

export type AppAction = 'reused' | 'updated' | 'created' | 'adopted'

export interface AppOutcome {
  letter: PersonaLetter
  appId: string
  action: AppAction
  /** Dotted manifest paths that drifted (for `updated`, and an `adopted` app that was updated). */
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
  /** The apps list page, for an unfinished create; without it, an unfinished create is not runnable. */
  listApps?: () => Promise<ListedApp[]>
  /** The time a pending-create intent records (default: now). */
  now?: () => number
}

/** The operator's next step when a create got no answer (the app may exist now). */
export function createUnansweredMessage(name: string, kind: string): string {
  return (
    `apps.manifest.create for ${name} got no answer (${kind}), so Slack may have created the app anyway. ` +
    `apps.json keeps the unfinished create: the next run looks for an unrecorded "${name}" in the test workspace's apps list ` +
    'and adopts it (one), creates it (none) or stops (more than one). Rerun, or see the list first with bun ci-live/run.ts apps --list'
  )
}

/** Why an unfinished create can't be resolved: several unrecorded apps have the name. */
export function ambiguousPendingMessage(name: string, ids: readonly string[]): string {
  return (
    `apps.json records an unfinished create of "${name}", and the test workspace has ${ids.length} unrecorded apps of that name ` +
    `(${ids.join(', ')}), so the run can't tell which to adopt: delete the strays with bun ci-live/run.ts apps --delete-strays, then rerun`
  )
}

/** Why an unfinished create can't be resolved now: an unrecorded app of its name could not be checked. */
export function unverifiedPendingMessage(name: string, unverified: PendingCandidates['unverified']): string {
  return (
    `apps.json records an unfinished create of "${name}", and the apps list has ${unverified.length} unrecorded app(s) of that name that could not be checked ` +
    `(${unverified.map((u) => `${u.app.id}: ${u.why}`).join('; ')}), so the run can't tell whether one is the app the create made: ` +
    'apps.json keeps the unfinished create and nothing was created: rerun'
  )
}

/** Why an unfinished create can't be resolved now: the apps list could not be read. */
export function unreadListMessage(name: string, why: string): string {
  return `apps.json records an unfinished create of "${name}", and the apps list could not be read (${why}): apps.json keeps the unfinished create and nothing was created: rerun`
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

/** A recorded app: reused, or updated when its manifest drifted; `null` when Slack no longer has it. */
async function checkRecorded(deps: AppsStageDeps, letter: PersonaLetter, recorded: string, wanted: JsonObject): Promise<AppOutcome | null> {
  const name = appDisplayName(letter)
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
  return null
}

/** Remove a persona's pending-create intent (and its entry, which holds nothing else). */
function clearIntent(deps: AppsStageDeps, letter: PersonaLetter): void {
  deps.appsFile.update((state) => {
    const entry = state.personas[letter]
    if (entry?.pending_create && !entry.app_id) delete state.personas[letter]
  })
}

/**
 * An unfinished create of `letter`'s app: the one unrecorded app of its name
 * is adopted (its ID returned, recorded and the intent cleared); with none,
 * the intent is cleared and `null` returned (create it); more than one is
 * not runnable. An apps list that can't be read, or a candidate whose check
 * proved nothing, stops the stage (`AppsStageError`) with the intent kept.
 */
async function resolvePendingCreate(deps: AppsStageDeps, letter: PersonaLetter, pending: PendingCreate): Promise<string | null> {
  const name = appDisplayName(letter)
  if (!deps.listApps) {
    throw new NotRunnableError(
      `apps.json records an unfinished create of "${name}" (started ${pending.started_at}), and this command can't read the apps list to look for it: ` +
        'run bun ci-live/run.ts apps --list',
    )
  }
  deps.log.info(`apps: ${name}: apps.json records an unfinished create (started ${pending.started_at}); looking for the app in the apps list`)
  let listed: ListedApp[]
  try {
    listed = await deps.listApps()
  } catch (err) {
    if (err instanceof NotRunnableError) throw err
    throw new AppsStageError(unreadListMessage(name, describeError(err)))
  }
  const { matched, unverified } = await unrecordedTestApps(listed, deps.appsFile.load(), name, deps.callManifest)
  const [only] = matched
  if (matched.length > 1) throw new NotRunnableError(ambiguousPendingMessage(name, matched.map((a) => a.id)))
  // One the token could not check may be the app the create made: neither adopt another nor create.
  if (unverified.length > 0) throw new AppsStageError(unverifiedPendingMessage(name, unverified))
  if (!only) {
    clearIntent(deps, letter)
    deps.log.info(`apps: ${name}: no unrecorded app of that name; the unfinished create made none, so the app is created now`)
    return null
  }
  deps.appsFile.update((state) => {
    state.personas[letter] = { app_id: only.id }
  })
  deps.log.info(`apps: ${name}: the apps list has ${only.id}, the app the unfinished create made: recorded it in apps.json`)
  return only.id
}

/** Create the app: the intent first, then the call, then the app ID with the intent cleared, in one write. */
async function createApp(deps: AppsStageDeps, letter: PersonaLetter, wanted: JsonObject): Promise<AppOutcome> {
  const name = appDisplayName(letter)
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString()
  // A crash from here on leaves the intent: the next run looks for the app instead of creating another.
  deps.appsFile.update((state) => {
    state.personas[letter] = { pending_create: { started_at: startedAt } }
  })
  let created: SlackResponse
  try {
    created = await deps.callManifest('apps.manifest.create', { manifest: JSON.stringify(wanted) })
  } catch (err) {
    if (err instanceof SlackTransportError) {
      // A 4xx status (429 left after the retries included) means Slack did not take the request.
      if (err.kind === 'http' && err.status !== undefined && err.status < 500) {
        clearIntent(deps, letter)
        throw new AppsStageError(`apps.manifest.create for ${name} was refused (HTTP ${err.status}); no app was created: rerun later`)
      }
      throw new NotRunnableError(createUnansweredMessage(name, `${err.kind}${err.status !== undefined ? ` ${err.status}` : ''}`))
    }
    // The token was refused before any create was made.
    if (err instanceof ConfigTokenUnavailableError) clearIntent(deps, letter)
    throw err
  }
  if (!created.ok) {
    clearIntent(deps, letter)
    throw new AppsStageError(`apps.manifest.create for ${name} failed: ${safeErrorCode(created)}`)
  }
  const appId = created.app_id
  if (!isAppId(appId)) {
    throw new AppsStageError(`apps.manifest.create for ${name} returned no app ID; apps.json keeps the unfinished create, so the next run looks for the app in the apps list`)
  }
  // Persist at once, clearing the intent in the same write: the app exists now, whatever happens next.
  deps.appsFile.update((state) => {
    state.personas[letter] = { app_id: appId }
  })
  return { letter, appId, action: 'created', drift: [] }
}

async function ensureApp(deps: AppsStageDeps, letter: PersonaLetter): Promise<AppOutcome> {
  const wanted = deps.manifestFor(letter)
  const entry = deps.appsFile.load().personas[letter]
  const recorded = entry?.app_id

  if (recorded) {
    const outcome = await checkRecorded(deps, letter, recorded, wanted)
    if (outcome) return outcome
  } else if (entry?.pending_create) {
    const adopted = await resolvePendingCreate(deps, letter, entry.pending_create)
    if (adopted) {
      const outcome = await checkRecorded(deps, letter, adopted, wanted)
      if (!outcome) throw new AppsStageError(`${appDisplayName(letter)}: the adopted app ${adopted} went away before it could be checked`)
      return { ...outcome, action: 'adopted' }
    }
  }

  if (deps.refuseCreate) throw new NotRunnableError(deps.refuseCreate)
  return createApp(deps, letter, wanted)
}

/** Whether apps.json records an app ID for every persona. */
function allAppsRecorded(state: AppsState): boolean {
  return PERSONA_LETTERS.every((letter) => state.personas[letter]?.app_id !== undefined)
}

function logOutcome(deps: AppsStageDeps, outcome: AppOutcome, unchecked: boolean): void {
  const drifted = outcome.drift.length > 0 ? ` (drifted: ${outcome.drift.join(', ')}; marked for re-install)` : ''
  const extra = unchecked ? ' (unchecked: no usable configuration token)' : drifted
  deps.log.info(`apps: ${appDisplayName(outcome.letter)}: ${outcome.action} ${outcome.appId}${extra}`)
}

export async function runAppsStage(deps: AppsStageDeps): Promise<AppOutcome[]> {
  const outcomes: AppOutcome[] = []
  let tokenless = false
  for (const letter of deps.letters) {
    if (!tokenless) {
      try {
        const outcome = await ensureApp(deps, letter)
        logOutcome(deps, outcome, false)
        outcomes.push(outcome)
        continue
      } catch (err) {
        if (!(err instanceof ConfigTokenUnavailableError) || !allAppsRecorded(deps.appsFile.load())) throw err
        tokenless = true
        deps.log.info(
          `WARNING: apps: the configuration token can't be used (${err.message}); apps.json records all four apps, ` +
            'so the run reuses them without their export, drift check or update',
        )
      }
    }
    const appId = deps.appsFile.load().personas[letter]?.app_id as string
    const outcome: AppOutcome = { letter, appId, action: 'reused', drift: [] }
    logOutcome(deps, outcome, true)
    outcomes.push(outcome)
  }
  return outcomes
}
