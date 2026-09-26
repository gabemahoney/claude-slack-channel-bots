/**
 * apps-state.ts — `apps.json`, the runner's record of the test workspace:
 * app IDs, bot user IDs, bot IDs, the team ID, the channel IDs and the test
 * human's user ID. It holds no secret.
 *
 * The apps stage records a pending-create intent (`pending_create`) for a
 * persona before it calls `apps.manifest.create`, and writes the app ID the
 * moment the call returns it, clearing the intent in the same write. A crash
 * in between leaves the intent with no app ID, and the next run looks for
 * the app in the workspace's app list instead of creating a second one.
 *
 * Parsing is tolerant of fields (an unknown or malformed field is dropped,
 * never echoed), never of the file: one that is there but is no JSON object
 * throws `MalformedAppsStateError` (not runnable), since reading it as empty
 * would make every app it records look unrecorded (a stray to delete, an
 * app to create again). Only a missing file loads empty. Writes are atomic
 * (temp file + rename, mode 600, like every file in the config dir).
 */

import type { SecureFs } from './secrets.ts'
import { NotRunnableError, writePrivateFile } from './secrets.ts'
import { CHANNEL_NAMES, PERSONA_LETTERS, type ChannelName, type PersonaLetter } from './personas.ts'

/** An `apps.manifest.create` that was started and not seen through (no app ID recorded yet). */
export interface PendingCreate {
  /** ISO time the create was started. */
  started_at: string
}

export interface PersonaAppState {
  app_id?: string
  /** Set before `apps.manifest.create`; cleared in the write that records the app ID. */
  pending_create?: PendingCreate
  bot_user_id?: string
  bot_id?: string
  /** Set when the manifest was updated: the install stage re-installs the app. */
  needs_reinstall?: boolean
  /** The name of the app-level token in the credentials file (not the token). */
  app_token_name?: string
}

export interface AppsState {
  version: 1
  team_id?: string
  human_user_id?: string
  personas: Partial<Record<PersonaLetter, PersonaAppState>>
  channels: Partial<Record<ChannelName, string>>
}

const APP_ID_RE = /^A[A-Z0-9]{6,20}$/
const USER_ID_RE = /^[UW][A-Z0-9]{6,20}$/
const BOT_ID_RE = /^B[A-Z0-9]{6,20}$/
const TEAM_ID_RE = /^T[A-Z0-9]{6,20}$/
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,20}$/
const TOKEN_NAME_RE = /^[a-z0-9-]{1,48}$/
const ISO_TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/

export function isAppId(v: unknown): v is string {
  return typeof v === 'string' && APP_ID_RE.test(v)
}
export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && USER_ID_RE.test(v)
}
export function isBotId(v: unknown): v is string {
  return typeof v === 'string' && BOT_ID_RE.test(v)
}
export function isTeamId(v: unknown): v is string {
  return typeof v === 'string' && TEAM_ID_RE.test(v)
}
export function isChannelId(v: unknown): v is string {
  return typeof v === 'string' && CHANNEL_ID_RE.test(v)
}

export function emptyAppsState(): AppsState {
  return { version: 1, personas: {}, channels: {} }
}

/**
 * apps.json is there but is no JSON object (not runnable). The message names
 * the file and never quotes it.
 */
export class MalformedAppsStateError extends NotRunnableError {
  constructor(where: string, problem: 'does not parse as JSON' | 'is not a JSON object') {
    super(
      `${where} ${problem}: fix it, or restore it from a backup or from the VM that made the apps. ` +
        'The runner never reads it as empty, since every app it records would then look unrecorded. ' +
        'Or move it aside: bun ci-live/run.ts apps --list then shows the apps, and a real run with --create-apps creates new ones',
    )
    this.name = 'MalformedAppsStateError'
  }
}

/**
 * Parse `apps.json` text (`where` names it in an error). Bad fields are
 * dropped; text that is no JSON object throws `MalformedAppsStateError`.
 */
export function parseAppsState(text: string, where = 'apps.json'): AppsState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new MalformedAppsStateError(where, 'does not parse as JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MalformedAppsStateError(where, 'is not a JSON object')
  const r = raw as Record<string, unknown>
  const state = emptyAppsState()
  if (isTeamId(r.team_id)) state.team_id = r.team_id
  if (isUserId(r.human_user_id)) state.human_user_id = r.human_user_id
  const personas = r.personas && typeof r.personas === 'object' ? (r.personas as Record<string, unknown>) : {}
  for (const letter of PERSONA_LETTERS) {
    const p = personas[letter]
    if (!p || typeof p !== 'object') continue
    const pr = p as Record<string, unknown>
    const entry: PersonaAppState = {}
    if (isAppId(pr.app_id)) entry.app_id = pr.app_id
    const pending = pr.pending_create
    if (pending && typeof pending === 'object' && typeof (pending as PendingCreate).started_at === 'string' && ISO_TIME_RE.test((pending as PendingCreate).started_at)) {
      entry.pending_create = { started_at: (pending as PendingCreate).started_at }
    }
    if (isUserId(pr.bot_user_id)) entry.bot_user_id = pr.bot_user_id
    if (isBotId(pr.bot_id)) entry.bot_id = pr.bot_id
    if (pr.needs_reinstall === true) entry.needs_reinstall = true
    if (typeof pr.app_token_name === 'string' && TOKEN_NAME_RE.test(pr.app_token_name)) entry.app_token_name = pr.app_token_name
    if (Object.keys(entry).length > 0) state.personas[letter] = entry
  }
  const channels = r.channels && typeof r.channels === 'object' ? (r.channels as Record<string, unknown>) : {}
  for (const name of CHANNEL_NAMES) {
    if (isChannelId(channels[name])) state.channels[name] = channels[name] as string
  }
  return state
}

export function serializeAppsState(state: AppsState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** Load/save `apps.json` through the secure fs (the config dir is private). */
export class AppsStateFile {
  constructor(
    private readonly fs: SecureFs,
    readonly path: string,
  ) {}

  /** Whether apps.json exists (a missing one on a real run means the apps may exist elsewhere). */
  exists(): boolean {
    return this.fs.stat(this.path) !== null
  }

  /** The state: empty only when the file is missing; a malformed one throws `MalformedAppsStateError`. */
  load(): AppsState {
    if (!this.fs.stat(this.path)) return emptyAppsState()
    return parseAppsState(this.fs.readFile(this.path), this.path)
  }

  save(state: AppsState): void {
    writePrivateFile(this.fs, this.path, serializeAppsState(state))
  }

  /** Load, apply `change`, save, and return the saved state. */
  update(change: (state: AppsState) => void): AppsState {
    const state = this.load()
    change(state)
    this.save(state)
    return state
  }
}

/** Every app ID apps.json records, with its persona. */
export function recordedAppIds(state: AppsState): Map<string, PersonaLetter> {
  const out = new Map<string, PersonaLetter>()
  for (const letter of PERSONA_LETTERS) {
    const id = state.personas[letter]?.app_id
    if (id) out.set(id, letter)
  }
  return out
}

/** The persona's entry, created when missing. */
export function personaEntry(state: AppsState, letter: PersonaLetter): PersonaAppState {
  const existing = state.personas[letter]
  if (existing) return existing
  const created: PersonaAppState = {}
  state.personas[letter] = created
  return created
}
