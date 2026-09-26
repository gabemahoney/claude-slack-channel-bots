/**
 * app-listing.ts — the test workspace's apps, as the apps list page
 * (api.slack.com/apps, scraped by browser/apps-list.flow.ts) shows them,
 * against apps.json: for `bun ci-live/run.ts apps --list` and
 * `apps --delete-strays`, and for the apps stage's unfinished-create check.
 * Pure but for the injected Slack calls, so tests import it.
 *
 * A stray is an app named exactly "CSCB Test A" … "CSCB Test D" whose ID
 * apps.json does not record: a leftover of a create whose answer was lost,
 * or of an earlier apps.json. `--delete-strays` runs only when apps.json is
 * there, parses as a JSON object and records at least one app ID (else every
 * test app, live ones another VM records included, would look like a stray),
 * and deletes one (with `apps.manifest.delete`, the configuration token) only
 * when all of these hold, and never an app apps.json records:
 * - its name is exactly one of the four;
 * - apps.json (read again just before, and still recording an app ID) does
 *   not record its ID;
 * - one cell of its row on the apps list is exactly the test workspace's
 *   name (a cell less the app's own name);
 * - `apps.manifest.export` with the configuration token (which is the test
 *   workspace's) answers for it, with the same name.
 * An app whose export failed for a reason that proves nothing (a Slack error
 * other than "no such app", no answer, no manifest name) is kept.
 *
 * Every Slack or page value reaching a line is an ID, a checked name or a
 * safe Slack error code.
 */

import { recordedAppIds, type AppsState } from '../lib/apps-state.ts'
import type { HumanApi, ListedApp } from '../lib/browser-types.ts'
import { appDisplayName, PERSONA_LETTERS, type PersonaLetter } from '../lib/personas.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { safeErrorCode, SlackTransportError, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'

export type CallManifest = (method: string, params: SlackParams) => Promise<SlackResponse>

/** Export answers that mean the app does not exist for the configuration token (gone, or another workspace's). */
export const APP_MISSING_CODES = new Set(['app_not_found', 'invalid_app_id', 'invalid_app', 'app_deleted'])

// ---------------------------------------------------------------------------
// The apps list page
// ---------------------------------------------------------------------------

const APP_HREF_RE = /\/apps\/(A[A-Z0-9]{6,20})(?:[/?#]|$)/
const MAX_NAME = 100
const MAX_CELL = 100
const MAX_CELLS = 8
/** Joins a row's cells in `ListedApp.rowText` (cleaned cells hold no control character). */
export const ROW_CELL_SEPARATOR = '\t'

function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** One link to an app's page, as the page gave it: its href, its text, and the cells of the row holding it (`null`: no row). */
export interface AppLink {
  href: string
  text: string
  cells: readonly string[] | null
}

/**
 * The page's links into listed apps: one per app ID, named by its first link
 * with text; the row's non-empty cells, each cleaned and capped, joined by
 * ROW_CELL_SEPARATOR.
 */
export function listedAppsFrom(links: readonly AppLink[]): ListedApp[] {
  const byId = new Map<string, ListedApp>()
  for (const link of links) {
    const id = APP_HREF_RE.exec(link.href)?.[1]
    if (!id) continue
    const name = clean(link.text, MAX_NAME)
    const cells = link.cells === null ? null : link.cells.map((c) => clean(c, MAX_CELL)).filter((c) => c !== '').slice(0, MAX_CELLS)
    const rowText = cells === null ? null : cells.join(ROW_CELL_SEPARATOR)
    const known = byId.get(id)
    if (!known) byId.set(id, { id, name, rowText })
    else if (known.name === '' && name !== '') byId.set(id, { id, name, rowText: known.rowText ?? rowText })
  }
  return [...byId.values()]
}

/** The test workspace's name, from the test human's `auth.test`; `null` when Slack does not say. */
export async function testWorkspaceName(browser: { humanApi(): Promise<HumanApi> }): Promise<string | null> {
  const answer = await (await browser.humanApi()).call('auth.test')
  return answer.ok && typeof answer.team === 'string' && answer.team.trim() !== '' ? answer.team : null
}

// ---------------------------------------------------------------------------
// The listed apps against apps.json
// ---------------------------------------------------------------------------

export interface ClassifiedApp {
  app: ListedApp
  /** The persona apps.json records this app ID for, or `null`. */
  recordedAs: PersonaLetter | null
  /** The persona whose test app name this app has exactly, or `null`. */
  namedAs: PersonaLetter | null
  /** Whether its row shows the test workspace's name as a cell; `null` when that name is not known. */
  inTestWorkspace: boolean | null
}

/** The persona whose app name is exactly `name`, or `null`. */
export function personaNamed(name: string): PersonaLetter | null {
  return PERSONA_LETTERS.find((l) => appDisplayName(l) === name) ?? null
}

/**
 * Whether the app's row shows the workspace `teamName`: one of its cells,
 * less the app's own name (so a team name inside the app name proves
 * nothing), is exactly that name. "CSCB Test" is not shown by a row of
 * "CSCB Test 2".
 */
export function rowShowsWorkspace(app: ListedApp, teamName: string): boolean {
  if (app.rowText === null) return false
  const team = clean(teamName, teamName.length)
  return app.rowText.split(ROW_CELL_SEPARATOR).some((cell) => clean(cell.replace(app.name, ' '), cell.length) === team)
}

/** The listed apps against apps.json and the test workspace's name (from the human session's `auth.test`). */
export function classifyListedApps(listed: readonly ListedApp[], state: AppsState, teamName: string | null): ClassifiedApp[] {
  const recorded = recordedAppIds(state)
  return listed.map((app) => ({
    app,
    recordedAs: recorded.get(app.id) ?? null,
    namedAs: personaNamed(app.name),
    inTestWorkspace: teamName === null || teamName.trim() === '' ? null : rowShowsWorkspace(app, teamName),
  }))
}

/** A name for a line, JSON-quoted (the scraper already dropped control characters). */
function quoted(name: string): string {
  return JSON.stringify(name)
}

/** `apps --list`'s line for one app: its ID, its name, and what apps.json says of it. */
export function describeListedApp(c: ClassifiedApp): string {
  const where = c.inTestWorkspace === null ? '' : c.inTestWorkspace ? '; test workspace' : '; not shown in the test workspace'
  const status = c.recordedAs
    ? `in apps.json (persona ${c.recordedAs.toUpperCase()})`
    : c.namedAs
      ? 'NOT in apps.json: a stray test app'
      : 'not in apps.json'
  return `${c.app.id}  ${quoted(c.app.name)}  ${status}${where}`
}

// ---------------------------------------------------------------------------
// Checking an app with the configuration token
// ---------------------------------------------------------------------------

/** What `apps.manifest.export` with the configuration token says of an app. */
export type TestAppCheck =
  /** The token manages the app, and its manifest's display name is the one asked for. */
  | { kind: 'verified' }
  /** Not the app asked for: the export says there is no such app (gone, or another workspace's), or the manifest names another app. */
  | { kind: 'not-candidate'; why: string }
  /** Nothing is known: another Slack error, no answer, or no manifest name. Never taken as "not the app". */
  | { kind: 'unverified'; why: string }

/**
 * Whether the configuration token (the test workspace's) manages app `id`
 * under exactly `name`. Only an export answer in APP_MISSING_CODES, or a
 * manifest naming another app, says it is not; any other failure leaves it
 * unverified. The token's own refusal throws (`ConfigTokenUnavailableError`).
 */
export async function verifyTestApp(callManifest: CallManifest, id: string, name: string): Promise<TestAppCheck> {
  let exported: SlackResponse
  try {
    exported = await callManifest('apps.manifest.export', { app_id: id })
  } catch (err) {
    if (!(err instanceof SlackTransportError)) throw err
    const kind = `${err.kind}${err.status !== undefined ? ` ${err.status}` : ''}`
    return { kind: 'unverified', why: `apps.manifest.export with the configuration token got no answer (${kind})` }
  }
  if (!exported.ok) {
    const code = safeErrorCode(exported)
    const failed = `apps.manifest.export with the configuration token failed: ${code}`
    return APP_MISSING_CODES.has(code) ? { kind: 'not-candidate', why: failed } : { kind: 'unverified', why: `${failed}, which does not say the app is missing` }
  }
  const manifest = exported.manifest
  const shown = manifest && typeof manifest === 'object' ? (manifest as { display_information?: { name?: unknown } | null }).display_information?.name : undefined
  if (typeof shown !== 'string') return { kind: 'unverified', why: 'apps.manifest.export with the configuration token returned no manifest name' }
  return shown === name ? { kind: 'verified' } : { kind: 'not-candidate', why: 'its manifest names another app' }
}

/** An unfinished create's candidates on the apps list. */
export interface PendingCandidates {
  /** Unrecorded apps of the name that the configuration token manages under it. */
  matched: ListedApp[]
  /** Unrecorded apps of the name whose check proved nothing (`unverified`), with why. */
  unverified: { app: ListedApp; why: string }[]
}

/** The unrecorded apps named `name`, checked with the configuration token (an unfinished create's candidates). */
export async function unrecordedTestApps(listed: readonly ListedApp[], state: AppsState, name: string, callManifest: CallManifest): Promise<PendingCandidates> {
  const recorded = recordedAppIds(state)
  const out: PendingCandidates = { matched: [], unverified: [] }
  for (const app of listed) {
    if (app.name !== name || recorded.has(app.id)) continue
    const check = await verifyTestApp(callManifest, app.id, name)
    if (check.kind === 'verified') out.matched.push(app)
    else if (check.kind === 'unverified') out.unverified.push({ app, why: check.why })
  }
  return out
}

// ---------------------------------------------------------------------------
// apps --delete-strays
// ---------------------------------------------------------------------------

const NO_RECORDED_APP =
  'records no app ID, so every test app, live ones another VM records included, would look like a stray: ' +
  'apps --delete-strays deletes nothing until apps.json records the apps (copy it from the VM that made them; apps --list shows them)'

/**
 * apps.json as `--delete-strays` needs it: there, a JSON object (a malformed
 * one throws from `load`) and recording at least one app ID. Anything less
 * is not runnable, before any app is listed or deleted.
 */
export function appsStateForStrayDeletion(file: { exists(): boolean; load(): AppsState; readonly path: string }): AppsState {
  if (!file.exists()) {
    throw new NotRunnableError(
      `${file.path} does not exist, so every test app, live ones another VM records included, would look like a stray: ` +
        'apps --delete-strays deletes nothing without it (copy it from the VM that made the apps; apps --list shows them)',
    )
  }
  const state = file.load()
  if (recordedAppIds(state).size === 0) throw new NotRunnableError(`${file.path} ${NO_RECORDED_APP}`)
  return state
}

export interface DeleteStraysDeps {
  callManifest: CallManifest
  appsFile: { load(): AppsState }
  log: { info(message: string): void }
}

export interface StrayOutcome {
  deleted: ListedApp[]
  kept: { app: ListedApp; why: string }[]
}

/**
 * Delete the strays among `classified` (see the module comment); report what
 * was deleted and what was kept, and why. Throws (not runnable) when
 * apps.json, read again before a delete, records no app ID any more (or no
 * longer parses): nothing more is deleted.
 */
export async function deleteStrayApps(deps: DeleteStraysDeps, classified: readonly ClassifiedApp[]): Promise<StrayOutcome> {
  const outcome: StrayOutcome = { deleted: [], kept: [] }
  for (const c of classified) {
    if (c.recordedAs !== null || c.namedAs === null) continue
    const keep = (why: string): void => {
      outcome.kept.push({ app: c.app, why })
      deps.log.info(`apps: kept ${c.app.id} ${quoted(c.app.name)}: ${why}`)
    }
    if (c.inTestWorkspace !== true) {
      keep(c.inTestWorkspace === false ? 'the app list does not show it in the test workspace' : 'the test workspace name is unknown, so its workspace is unproven')
      continue
    }
    // Read again: never delete an app apps.json records, even one recorded since the list was read.
    const recordedNow = recordedAppIds(deps.appsFile.load())
    if (recordedNow.size === 0) throw new NotRunnableError(`apps.json ${NO_RECORDED_APP}`)
    if (recordedNow.has(c.app.id)) {
      keep('apps.json records it')
      continue
    }
    const check = await verifyTestApp(deps.callManifest, c.app.id, c.app.name)
    if (check.kind !== 'verified') {
      keep(check.why)
      continue
    }
    const answer = await deps.callManifest('apps.manifest.delete', { app_id: c.app.id })
    if (!answer.ok) {
      keep(`apps.manifest.delete failed: ${safeErrorCode(answer)}`)
      continue
    }
    outcome.deleted.push(c.app)
    deps.log.info(`apps: deleted stray ${c.app.id} ${quoted(c.app.name)} (not in apps.json) with apps.manifest.delete`)
  }
  return outcome
}
