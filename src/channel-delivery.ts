/**
 * channel-delivery.ts — The stored-choice store (b.deo SRI-401 to SRI-407):
 * each persona's per-channel choice of channel delivery (`mentions` or
 * `all`), stored by its agent with `set_channel_delivery`, kept in
 * `channel-delivery.json` in the server's state directory so that it lasts
 * across restarts without ever touching `config.json`.
 *
 * What this module owns:
 *   - b.deo SRI-401: the file's name and its one path function
 *     ({@link channelDeliveryPath}).
 *   - b.deo SRI-402: the format, with one serialiser
 *     ({@link serializeChannelDelivery}) and one strict parser
 *     ({@link parseChannelDelivery}), the only way its bytes are made or read.
 *   - b.deo SRI-403 and SRI-904: the read once per start
 *     ({@link loadChannelDeliveryStore}), the unreadable state and its line.
 *   - b.deo SRI-404: whole-record writes, atomic and durable, and their
 *     failure rules.
 *   - b.deo SRI-405: drops and unwritten drops.
 *   - b.deo SRI-407: the start rules ({@link loadChannelDeliveryAtStart}).
 *   - b.deo SRI-502: the retiring keys, held in memory only.
 *   - b.deo SRI-901: the store's closed class list
 *     ({@link CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES}).
 *   - b.deo SRI-905: the `[slack] channel-delivery:` lines.
 *
 * Ownership (b.deo SRI-401; b.av2 SR-8.1). Only the server reads or writes
 * `channel-delivery.json`, always through this module: `main()` loads one
 * store at start and hands it to the routing, the session tools and the
 * reload controller. The CLI never reads, writes, creates or removes the file.
 *
 * The read (b.deo SRI-403; b.av2 SR-8.7). Once per start, whole, through the
 * configuration reader's open-then-fstat rule (`readPersonaConfigBytes`) with
 * no size cap: only the server writes the file, it is read once at start, and
 * its bytes are parsed only, never hashed or compared. It is the third
 * sanctioned read without the cap, beside `credentialsFilesToProtect` and
 * `loadRetiredKeyStore`. A missing file is an empty record; a file that cannot
 * be read, parsed or validated is left in place, logs one
 * `channel-delivery-unreadable` line, and makes the store unreadable for the
 * run: no stored choice, no write, no drop. No startup-errors entry is written
 * and nothing is posted to Slack.
 *
 * Writes (b.deo SRI-404, SRI-405). Every operation is synchronous, so no two
 * writes interleave. Every write writes the whole record held in memory,
 * through `durableWriteFileSync` (or the injected writer). A stored choice
 * changes memory only once its write has succeeded; a drop changes memory at
 * once, whatever its write does, and a drop whose write fails leaves its keys
 * with an unwritten drop, which the next successful write carries. A drop
 * only ever moves a channel toward `mentions`.
 *
 * Importable with no side effect: nothing reads a file or the environment,
 * arms a timer or logs at import. The module starts no process, touches no
 * session, imports nothing from agent-director, the startup-errors module or
 * the registry, and makes no Slack call.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'

import {
  DurableUnlinkUnsyncedError,
  DurableWriteUnsyncedError,
  durableUnlinkSync,
  durableWriteFileSync,
} from './atomic-write.ts'
import {
  CHANNEL_ID_RE,
  DELIVERY_MODES,
  isMissingConfigCode,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  resolveRealPath,
  resolveServerStateDir,
  type DeliveryMode,
  type Persona,
  type PersonaConfigFs,
} from './config.ts'
import { jsonSyntaxErrorOffset, positionAt } from './json-position.ts'
import { errnoSuffix } from './persona-credentials.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import type { DestructiveSetting } from './reload-plan.ts'
import type { RetiredKeyStore } from './retired-keys.ts'

// ---------------------------------------------------------------------------
// Constants (b.deo SRI-401, SRI-402, SRI-901, SRI-904, SRI-905)
// ---------------------------------------------------------------------------

/** The file's name, in the server's state directory (b.deo SRI-401). */
export const CHANNEL_DELIVERY_FILE_NAME = 'channel-delivery.json'

/** The format version this server reads and writes (b.deo SRI-402). */
export const CHANNEL_DELIVERY_FORMAT_VERSION = 1

/**
 * The name of the MCP tool that stores a choice (b.deo SRI-501). Spelled once,
 * here: the registry imports it as the tool's name, and this module's lines
 * name the tool through it.
 */
export const SET_CHANNEL_DELIVERY_TOOL = 'set_channel_delivery'

/** The store's own class: the file could not be read, parsed or validated at start (b.deo SRI-403, SRI-904). */
export const CHANNEL_DELIVERY_UNREADABLE = 'channel-delivery-unreadable'

/**
 * Every class label the store logs, a closed list kept apart from the persona
 * and reload classes (b.deo SRI-901), as `RELOAD_DIAGNOSTIC_CLASSES` is in
 * `src/reload.ts`. Its lines go to `server.log` in the `[slack]` stream only.
 */
export const CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES = [CHANNEL_DELIVERY_UNREADABLE] as const

/** A store class label (closed set). */
export type ChannelDeliveryDiagnosticClass = (typeof CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES)[number]

/** The start of every drop and failed-write line the store logs (b.deo SRI-905). */
export const CHANNEL_DELIVERY_LOG_PREFIX = '[slack] channel-delivery:'

/**
 * The file's path: {@link CHANNEL_DELIVERY_FILE_NAME} in `stateDir`, the
 * server's state directory (`resolveServerStateDir()` when omitted, read at
 * call time, so `SLACK_STATE_DIR` is honoured). The one path function of the
 * file (b.deo SRI-401).
 */
export function channelDeliveryPath(stateDir: string = resolveServerStateDir()): string {
  return join(stateDir, CHANNEL_DELIVERY_FILE_NAME)
}

// ---------------------------------------------------------------------------
// The record (b.deo SRI-402)
// ---------------------------------------------------------------------------

/**
 * A persona's declaration (b.deo SRI-402, SRI-407): its `name`,
 * `credentials_file` and `working_directory` as the configuration in effect
 * resolved them, exactly the settings of `DESTRUCTIVE_SETTINGS`
 * (`src/reload-plan.ts`).
 */
export interface ChannelDeliveryDeclaration {
  readonly name: string
  readonly credentials_file: string
  readonly working_directory: string
}

/** The declaration's fields, in the format's order. */
export const CHANNEL_DELIVERY_DECLARATION_FIELDS = ['name', 'credentials_file', 'working_directory'] as const

/** Whether two string unions hold the same members. */
type SameMembers<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Whether both checks hold. */
type BothHold<A, B> = [A, B] extends [true, true] ? true : false
/** Compiles only when its argument is `true`. */
type Holds<T extends true> = T
/**
 * Keeps the declaration in step with `DESTRUCTIVE_SETTINGS`: the type check
 * fails when either the type or the field list gains or loses a setting
 * `DESTRUCTIVE_SETTINGS` does not have.
 */
type DeclarationInStep = Holds<
  BothHold<
    SameMembers<keyof ChannelDeliveryDeclaration, DestructiveSetting>,
    SameMembers<(typeof CHANNEL_DELIVERY_DECLARATION_FIELDS)[number], DestructiveSetting>
  >
>

/** One channel's stored choice (b.deo SRI-402). */
export interface ChannelDeliveryChannelEntry {
  /** The stored choice: one of `DELIVERY_MODES` (`src/config.ts`). */
  readonly delivery: DeliveryMode
  /** When the choice was stored: RFC 3339 UTC, ending in `Z`. */
  readonly set_at: string
}

/** One persona key's entry (b.deo SRI-402). */
export interface ChannelDeliveryPersonaEntry {
  /** The persona's declaration when its entry was last written. */
  readonly declaration: ChannelDeliveryDeclaration
  /** Its stored choices, keyed by channel ID. */
  readonly channels: ReadonlyMap<string, ChannelDeliveryChannelEntry>
}

/**
 * The stored-choice record: each persona key's entry, keyed by its key. A
 * `Map`, so a key such as `__proto__` (a valid persona key) is an ordinary key.
 */
export type ChannelDeliveryRecord = ReadonlyMap<string, ChannelDeliveryPersonaEntry>

/** The declaration of a resolved persona (b.deo SRI-402, SRI-504): its three declared settings. Pure. */
export function channelDeliveryDeclarationOf(
  persona: Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>,
): ChannelDeliveryDeclaration {
  return {
    name: persona.name,
    credentials_file: persona.credentials_file,
    working_directory: persona.working_directory,
  }
}

// ---------------------------------------------------------------------------
// Serialiser and parser (b.deo SRI-402)
// ---------------------------------------------------------------------------

/**
 * The record's bytes (b.deo SRI-402): UTF-8 JSON, two-space indented with a
 * final newline, `version` then `personas`; the persona keys sorted, each
 * entry `declaration` (`name`, `credentials_file`, `working_directory`) then
 * `channels`; the channel IDs sorted, each entry `delivery` then `set_at`. A
 * key with no channels is omitted. Pure: the same record always gives the
 * same bytes. The one writer of the format; a test writes a record only
 * through it.
 */
export function serializeChannelDelivery(record: ChannelDeliveryRecord): Uint8Array {
  // Object.fromEntries defines each key as an own property, `__proto__` included.
  const personas = Object.fromEntries(
    [...record.keys()].sort().flatMap((key) => {
      const entry = record.get(key)!
      if (entry.channels.size === 0) return []
      const channels = Object.fromEntries(
        [...entry.channels.keys()].sort().map((id) => {
          const choice = entry.channels.get(id)!
          return [id, { delivery: choice.delivery, set_at: choice.set_at }]
        }),
      )
      const { name, credentials_file, working_directory } = entry.declaration
      return [[key, { declaration: { name, credentials_file, working_directory }, channels }]]
    }),
  )
  return new TextEncoder().encode(JSON.stringify({ version: CHANNEL_DELIVERY_FORMAT_VERSION, personas }, null, 2) + '\n')
}

/** The bytes are not UTF-8 or not JSON. */
export const CHANNEL_DELIVERY_PROBLEM_PARSE = 'parse'
/** The JSON breaks a rule of the format. */
export const CHANNEL_DELIVERY_PROBLEM_VALIDATE = 'validate'

/** Which stage refused the bytes. */
export type ChannelDeliveryProblemStage = typeof CHANNEL_DELIVERY_PROBLEM_PARSE | typeof CHANNEL_DELIVERY_PROBLEM_VALIDATE

/**
 * What {@link parseChannelDelivery} answers: the record, or the problem and
 * the stage that found it. The problem is worded as the predicate after the
 * file's name ("is not valid JSON at line 1, column 1", "is invalid: entry 2
 * of `personas` has no `declaration`") and carries no file content, no key
 * text and no value.
 */
export type ChannelDeliveryParseResult =
  | { readonly ok: true; readonly record: ChannelDeliveryRecord }
  | { readonly ok: false; readonly stage: ChannelDeliveryProblemStage; readonly problem: string }

/** The fields of the top level, in the format's order. */
const TOP_LEVEL_FIELDS: readonly string[] = ['version', 'personas']
/** The fields of a persona key's entry, in the format's order. */
const PERSONA_ENTRY_FIELDS: readonly string[] = ['declaration', 'channels']
/** The fields of a channel entry, in the format's order. */
const CHANNEL_ENTRY_FIELDS: readonly string[] = ['delivery', 'set_at']

/** An RFC 3339 UTC timestamp written with `T` and `Z`, fraction optional. */
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/

/** Whether `value` is an RFC 3339 UTC timestamp ending in `Z` with an existing date and time (a leap second allowed). */
function isRfc3339UtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = RFC3339_UTC_RE.exec(value)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false
  return hour <= 23 && minute <= 59 && second <= 60
}

/** The number of days in `month` (1-12) of `year`, by the Gregorian rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Whether `value` is a JSON object (not null, not an array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is one of the delivery values (`DELIVERY_MODES`, `src/config.ts`). */
function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (DELIVERY_MODES as readonly string[]).includes(value)
}

/** The delivery values as a problem names them: `all or mentions`. */
const DELIVERY_MODES_TEXT = `${DELIVERY_MODES.slice(0, -1).join(', ')} or ${DELIVERY_MODES.at(-1)}`

/** Whether every field of `value` is in `expected` (a missing field is checked apart). */
function hasOnlyFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).every((field) => expected.includes(field))
}

/**
 * Parse and validate the file's bytes (b.deo SRI-402), strictly: valid UTF-8
 * (a byte order mark is refused); a JSON object with exactly `version` (the
 * integer 1) and `personas` (an object); each persona key matching
 * `PERSONA_KEY_RE`, its entry an object with exactly `declaration` (an object
 * of exactly the three strings `name`, `credentials_file` and
 * `working_directory`) and `channels` (an object with at least one entry);
 * each channel ID matching `CHANNEL_ID_RE`, its entry an object with exactly
 * `delivery` (one of `DELIVERY_MODES`) and `set_at` (an RFC 3339 UTC
 * timestamp ending in `Z`). A failure names the first problem, an entry by its
 * position, never by its key or ID, and carries no value. Pure; never throws.
 */
export function parseChannelDelivery(bytes: Uint8Array): ChannelDeliveryParseResult {
  const unparsed = (problem: string): ChannelDeliveryParseResult => ({ ok: false, stage: CHANNEL_DELIVERY_PROBLEM_PARSE, problem })
  const invalid = (problem: string): ChannelDeliveryParseResult => ({
    ok: false,
    stage: CHANNEL_DELIVERY_PROBLEM_VALIDATE,
    problem: `is invalid: ${problem}`,
  })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return unparsed('is not valid UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const offset = jsonSyntaxErrorOffset(text)
    if (offset === undefined) return unparsed('is not valid JSON')
    const { line, column } = positionAt(text, offset)
    return unparsed(`is not valid JSON at line ${line}, column ${column}`)
  }
  if (!isJsonObject(parsed)) return invalid('its top level is not a JSON object')
  if (!hasOnlyFields(parsed, TOP_LEVEL_FIELDS)) return invalid('it has a top-level field the format does not name')
  if (!Object.hasOwn(parsed, 'version')) return invalid('it has no `version`')
  if (parsed['version'] !== CHANNEL_DELIVERY_FORMAT_VERSION) {
    return invalid(`its \`version\` is not ${CHANNEL_DELIVERY_FORMAT_VERSION}`)
  }
  if (!Object.hasOwn(parsed, 'personas')) return invalid('it has no `personas`')
  const personas = parsed['personas']
  if (!isJsonObject(personas)) return invalid('its `personas` is not a JSON object')

  const record = new Map<string, ChannelDeliveryPersonaEntry>()
  let position = 0
  for (const [key, value] of Object.entries(personas)) {
    position++
    const entry = personaEntryOf(key, value)
    if (typeof entry === 'string') return invalid(`entry ${position} of \`personas\` ${entry}`)
    record.set(key, entry)
  }
  return { ok: true, record }
}

/** One persona key's entry, or what is wrong with it as the predicate after "entry <n> of `personas`". */
function personaEntryOf(key: string, value: unknown): ChannelDeliveryPersonaEntry | string {
  if (!PERSONA_KEY_RE.test(key)) return 'has a key that is not a persona key'
  if (!isJsonObject(value)) return 'is not a JSON object'
  if (!hasOnlyFields(value, PERSONA_ENTRY_FIELDS)) return 'has a field the format does not name'
  for (const field of PERSONA_ENTRY_FIELDS) {
    if (!Object.hasOwn(value, field)) return `has no \`${field}\``
  }
  const declaration = value['declaration']
  if (!isJsonObject(declaration)) return 'has a `declaration` that is not a JSON object'
  if (!hasOnlyFields(declaration, CHANNEL_DELIVERY_DECLARATION_FIELDS)) {
    return 'has a `declaration` with a field the format does not name'
  }
  for (const field of CHANNEL_DELIVERY_DECLARATION_FIELDS) {
    if (!Object.hasOwn(declaration, field)) return `has a \`declaration\` with no \`${field}\``
    if (typeof declaration[field] !== 'string') return `has a \`declaration\` whose \`${field}\` is not a string`
  }
  const channels = value['channels']
  if (!isJsonObject(channels)) return 'has a `channels` that is not a JSON object'
  const choices = new Map<string, ChannelDeliveryChannelEntry>()
  let position = 0
  for (const [id, choice] of Object.entries(channels)) {
    position++
    const problem = channelEntryProblem(id, choice)
    if (problem !== undefined) return `has channel ${position} of \`channels\` ${problem}`
    const fields = choice as Record<string, unknown>
    choices.set(id, { delivery: fields['delivery'] as DeliveryMode, set_at: fields['set_at'] as string })
  }
  // The writer omits a key with no channels (b.deo SRI-402).
  if (choices.size === 0) return 'has no channel in `channels`'
  return {
    declaration: {
      name: declaration['name'] as string,
      credentials_file: declaration['credentials_file'] as string,
      working_directory: declaration['working_directory'] as string,
    },
    channels: choices,
  }
}

/** What is wrong with one channel entry, as the predicate after "channel <n> of `channels`", or undefined when it is valid. */
function channelEntryProblem(id: string, value: unknown): string | undefined {
  if (!CHANNEL_ID_RE.test(id)) return 'with an ID that is not a channel ID'
  if (!isJsonObject(value)) return 'that is not a JSON object'
  if (!hasOnlyFields(value, CHANNEL_ENTRY_FIELDS)) return 'with a field the format does not name'
  for (const field of CHANNEL_ENTRY_FIELDS) {
    if (!Object.hasOwn(value, field)) return `with no \`${field}\``
  }
  if (!isDeliveryMode(value['delivery'])) return `with a \`delivery\` that is not ${DELIVERY_MODES_TEXT}`
  if (!isRfc3339UtcTimestamp(value['set_at'])) return 'with a `set_at` that is not an RFC 3339 UTC timestamp ending in Z'
  return undefined
}

// ---------------------------------------------------------------------------
// Lines (b.deo SRI-904, SRI-905)
// ---------------------------------------------------------------------------

/** The file could not be read. */
export const CHANNEL_DELIVERY_UNREADABLE_READ = 'read'

/**
 * Why the file is unreadable (b.deo SRI-904): the read failed (with its
 * errno code, when it carried one), or the parser refused the bytes (its
 * stage and its problem, which carries no file content).
 */
export type ChannelDeliveryUnreadableCause =
  | { readonly stage: typeof CHANNEL_DELIVERY_UNREADABLE_READ; readonly code: string | undefined }
  | { readonly stage: ChannelDeliveryProblemStage; readonly problem: string }

/**
 * The `channel-delivery-unreadable` line (b.deo SRI-403, SRI-904): names the
 * file; says whether it could not be read (with the errno code), parsed or
 * validated (with the parser's problem: a position, never file content); says
 * that in fungible mode every channel is served at `mentions` and
 * `set_channel_delivery` is refused; and gives the fix. Pure.
 *
 *   [slack] channel-delivery-unreadable: the stored-choice file "<path>" could not be read (<code>). It is left in place, and this run neither writes it nor drops anything from it: in fungible mode every channel is served at mentions, and set_channel_delivery is refused. To fix: move the file aside, then restart the server (b.deo SRI-403, SRI-904)
 */
export function channelDeliveryUnreadableLine(path: string, cause: ChannelDeliveryUnreadableCause): string {
  let what: string
  if (cause.stage === CHANNEL_DELIVERY_UNREADABLE_READ) {
    what = `could not be read${cause.code !== undefined ? ` (${cause.code})` : ''}`
  } else {
    what = `could not be ${cause.stage === CHANNEL_DELIVERY_PROBLEM_PARSE ? 'parsed' : 'validated'}: it ${cause.problem}`
  }
  return (
    `[slack] ${CHANNEL_DELIVERY_UNREADABLE}: the stored-choice file ${JSON.stringify(path)} ${what}. ` +
    'It is left in place, and this run neither writes it nor drops anything from it: in fungible mode every channel ' +
    `is served at mentions, and ${SET_CHANNEL_DELIVERY_TOOL} is refused. To fix: move the file aside, then restart ` +
    'the server (b.deo SRI-403, SRI-904)'
  )
}

/** A drop's reason: the key was retired by a confirmed apply (b.deo SRI-406), or held in the retired-key record without its mark at start (b.deo SRI-407). */
export const CHANNEL_DELIVERY_DROP_RETIRED = 'retired by a confirmed change'
/** A drop's reason: the key is not an applied persona's at start (b.deo SRI-407). */
export const CHANNEL_DELIVERY_DROP_NOT_APPLIED = 'not an applied persona at start'
/** A drop's reason: the applied persona's declaration differs from the recorded one at start (b.deo SRI-407). */
export const CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED = 'its declaration changed'

/** Every drop reason (b.deo SRI-905), a closed set. */
export const CHANNEL_DELIVERY_DROP_REASONS = [
  CHANNEL_DELIVERY_DROP_RETIRED,
  CHANNEL_DELIVERY_DROP_NOT_APPLIED,
  CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED,
] as const

/** Why a key's stored choices were dropped. */
export type ChannelDeliveryDropReason = (typeof CHANNEL_DELIVERY_DROP_REASONS)[number]

/** A key as a line shows it: `persona=<key>`, the key JSON-quoted unless it is a persona key. */
function keyRef(key: string): string {
  return `persona=${PERSONA_KEY_RE.test(key) ? key : JSON.stringify(key)}`
}

/**
 * The line of one key's drop (b.deo SRI-405, SRI-905): names the key, the
 * number of channels whose stored choices were dropped, and why. Never names
 * a choice. Pure.
 *
 *   [slack] channel-delivery: dropped the stored choices of persona=<key> in <n> channel(s): <reason> (b.deo SRI-405, SRI-905)
 */
export function channelDeliveryDropLine(key: string, channelCount: number, reason: ChannelDeliveryDropReason): string {
  const channels = `${channelCount} channel${channelCount === 1 ? '' : 's'}`
  return `${CHANNEL_DELIVERY_LOG_PREFIX} dropped the stored choices of ${keyRef(key)} in ${channels}: ${reason} (b.deo SRI-405, SRI-905)`
}

/**
 * The line of a failed write (b.deo SRI-404, SRI-405, SRI-506, SRI-905):
 * names the action and the file, then `detail`, what the write did (its errno
 * code, and the write-back's when that failed too), then what holds now. With
 * `carriesDrop` (a drop's write, or the write of unwritten drops) it says that
 * the dropped choices do not apply and that the next successful write carries
 * the drop; otherwise that the stored choices in memory are unchanged. Never
 * names a choice, a token or file content. Pure.
 *
 *   [slack] channel-delivery: cannot <action> in "<path>"<detail>; the stored choices in memory are unchanged (b.deo SRI-404, SRI-506)
 *   [slack] channel-delivery: cannot <action> in "<path>"<detail>; the dropped choices do not apply, and the next successful write of the file carries the drop (b.deo SRI-405)
 */
export function channelDeliveryWriteFailedLine(path: string, action: string, detail: string, carriesDrop: boolean): string {
  const after = carriesDrop
    ? 'the dropped choices do not apply, and the next successful write of the file carries the drop (b.deo SRI-405)'
    : 'the stored choices in memory are unchanged (b.deo SRI-404, SRI-506)'
  return `${CHANNEL_DELIVERY_LOG_PREFIX} cannot ${action} in ${JSON.stringify(path)}${detail}; ${after}`
}

/** The action of a stored choice's write, as a failed-write line names it. Pure. */
export function channelDeliverySetAction(key: string, channel: string): string {
  return `store the channel delivery of ${keyRef(key)} for channel ${CHANNEL_ID_RE.test(channel) ? channel : JSON.stringify(channel)}`
}

/** The action of a drop's write, or of the write of unwritten drops, as a failed-write line names it. Pure. */
export function channelDeliveryDropAction(keys: readonly string[]): string {
  return `write the drop of ${[...new Set(keys)].sort().map(keyRef).join(', ')}`
}

// ---------------------------------------------------------------------------
// The store (b.deo SRI-403 to SRI-405, SRI-407, SRI-502)
// ---------------------------------------------------------------------------

/**
 * Writes bytes atomically and durably (`durableWriteFileSync` in production).
 * Throws on failure: a `DurableWriteUnsyncedError` when the bytes reached the
 * path but its directory could not be synced, any other error when the path
 * was left unchanged.
 */
export type ChannelDeliveryWriter = (path: string, bytes: Uint8Array) => void

/**
 * Deletes a file durably (`durableUnlinkSync` in production): true when a
 * file was removed, false when it was already absent. Throws on any other
 * failure: a `DurableUnlinkUnsyncedError` when the file was removed but its
 * directory could not be synced, any other error when the file is there.
 * Used only to put back the absence of a file a failed write created.
 */
export type ChannelDeliveryRemover = (path: string) => boolean

/** Dependencies of {@link loadChannelDeliveryStore}. */
export interface ChannelDeliveryStoreDeps {
  /** Receives each `[slack]` line the store logs (the server log). A throwing log is swallowed. */
  log: (line: string) => void
  /** The read's file-system calls (`readPersonaConfigBytes`'s seam); unset ones are the real file system's. */
  readFs?: Partial<PersonaConfigFs>
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: ChannelDeliveryWriter
  /** The durable delete; `durableUnlinkSync` by default. */
  remove?: ChannelDeliveryRemover
  /** The clock for `set_at`, in milliseconds since the epoch; `Date.now` by default. */
  now?: () => number
  /** The realpath of the start rules' path comparison (`resolveRealPath`'s seam); `fs.realpathSync` by default. */
  realpath?: (path: string) => string
}

/** The write succeeded. */
export const CHANNEL_DELIVERY_WRITTEN = 'written'
/** There was nothing to write, so nothing was written. */
export const CHANNEL_DELIVERY_NOTHING_TO_WRITE = 'nothing-to-write'
/** The write failed (an unsynced rename included). */
export const CHANNEL_DELIVERY_WRITE_FAILED = 'failed'

/** What a drop, the start rules, or the write of unwritten drops did. */
export type ChannelDeliveryWriteOutcome =
  | typeof CHANNEL_DELIVERY_WRITTEN
  | typeof CHANNEL_DELIVERY_NOTHING_TO_WRITE
  | typeof CHANNEL_DELIVERY_WRITE_FAILED

/** The choice was written and stored. */
export const CHANNEL_DELIVERY_SET_STORED = 'stored'
/** The store is unreadable: nothing was written. */
export const CHANNEL_DELIVERY_SET_UNREADABLE = 'unreadable'
/** An input the parser would refuse: nothing was written. */
export const CHANNEL_DELIVERY_SET_INVALID = 'invalid'
/** The write failed: memory is unchanged. */
export const CHANNEL_DELIVERY_SET_WRITE_FAILED = 'write-failed'

/** The input of `set` the store refused: one the parser would refuse, or a clock that gives no timestamp. */
export type ChannelDeliverySetInvalidField = 'key' | 'channel' | 'delivery' | 'declaration' | 'set_at'

/** What {@link ChannelDeliveryStore.set} answers. */
export type ChannelDeliverySetResult =
  | {
      readonly kind: typeof CHANNEL_DELIVERY_SET_STORED
      /** The choice stored for the key and channel before the call, or undefined when there was none. */
      readonly previous: DeliveryMode | undefined
    }
  | { readonly kind: typeof CHANNEL_DELIVERY_SET_UNREADABLE; readonly path: string }
  | { readonly kind: typeof CHANNEL_DELIVERY_SET_INVALID; readonly field: ChannelDeliverySetInvalidField }
  | { readonly kind: typeof CHANNEL_DELIVERY_SET_WRITE_FAILED; readonly path: string }

/** One key to drop and its reason. */
export interface ChannelDeliveryDrop {
  readonly key: string
  readonly reason: ChannelDeliveryDropReason
}

/** An applied persona as the start rules see it: its key and its declaration (b.deo SRI-407). */
export interface ChannelDeliveryAppliedPersona {
  readonly key: string
  readonly declaration: ChannelDeliveryDeclaration
}

/**
 * The start rules' view of the retired-key record (b.deo SRI-407): whether a
 * key is recorded, and whether it carries the "new life has begun" mark
 * (b.jg5 SRJ-806). A type-only view of the store `main()` loaded, so this
 * module never reads `retired-keys.json` itself.
 */
export type ChannelDeliveryRetiredKeyView = Pick<RetiredKeyStore, 'isRecorded' | 'isMarked'>

/** What the start rules run over (b.deo SRI-407). */
export interface ChannelDeliveryStart {
  /** The applied personas of the configuration the start runs. */
  readonly applied: readonly ChannelDeliveryAppliedPersona[]
  /** The loaded retired-key store, through its view. */
  readonly retiredKeys: ChannelDeliveryRetiredKeyView
}

/**
 * One server's stored choices (b.deo SRI-401 to SRI-407, SRI-502). Every
 * member is synchronous and never throws, but `drop` on an unknown reason.
 */
export interface ChannelDeliveryStore {
  /** The file's path. */
  readonly path: string
  /** Whether the file was readable at start (b.deo SRI-403). Decided once, for the run. */
  readonly readable: boolean
  /** The stored choice of `key` for `channel`, or undefined when none is stored or the store is unreadable. */
  storedChoice(key: string, channel: string): DeliveryMode | undefined
  /** The channel IDs with a stored choice of `key`, sorted; none when the store is unreadable. */
  storedChannels(key: string): string[]
  /** The record held in memory (empty when the store is unreadable). */
  record(): ChannelDeliveryRecord
  /**
   * Store `delivery` for `key` and `channel` (b.deo SRI-404, SRI-504): write
   * the whole record held in memory with the change, `set_at` now and
   * `declaration` as the key's declaration, in one write; memory changes only
   * once that write succeeded, and the write carries every unwritten drop. A
   * value already stored is written like any other. A failed write leaves
   * memory as it was, logs one failed-write line, and, after an unsynced
   * rename, writes the replaced bytes back (or removes the file again when it
   * was absent before), best effort. Refused with no write on an unreadable
   * store or an input the parser would refuse. Only an accepted call creates
   * a missing file.
   */
  set(key: string, channel: string, delivery: DeliveryMode, declaration: ChannelDeliveryDeclaration): ChannelDeliverySetResult
  /**
   * Drop the stored choices of each key of `batch` (b.deo SRI-405): memory
   * loses them at once, whatever the write does; one drop line per key that
   * lost entries; then one write of the whole record for the batch. A key
   * named twice keeps its first reason. Writes and logs nothing when no key
   * had entries, never creates a missing file, and does nothing on an
   * unreadable store. A failed write (an unsynced rename included) writes
   * nothing back, leaves each dropped key with an unwritten drop and logs one
   * failed-write line. Throws a `RangeError` on an unknown reason, before any
   * change.
   */
  drop(batch: readonly ChannelDeliveryDrop[]): ChannelDeliveryWriteOutcome
  /** Whether `key` has a drop no successful write has carried yet (b.deo SRI-405, SRI-408). */
  hasUnwrittenDrop(key: string): boolean
  /**
   * Write the record held in memory when any unwritten drop exists (b.deo
   * SRI-405, SRI-408). An unsynced rename is a failure and keeps the
   * unwritten drops; a failure logs one failed-write line.
   */
  writeUnwrittenDrops(): ChannelDeliveryWriteOutcome
  /**
   * The start rules (b.deo SRI-407), run once right after the read: drop, in
   * one write, the entries of every key that is not an applied persona's, of
   * every applied key whose recorded declaration differs from the applied one
   * (`name` exactly; each path equal as written or by `resolveRealPath`), and
   * of every key the retired-key record holds without its mark. A key several
   * rules match is dropped once, with the first reason in that order. Runs
   * nothing on an unreadable store, and writes and logs nothing when no entry
   * is dropped.
   */
  applyStartRules(start: ChannelDeliveryStart): ChannelDeliveryWriteOutcome
  /** Mark `keys` as retiring (b.deo SRI-502). Memory only: never written, never logged. */
  beginRetiring(keys: Iterable<string>): void
  /** Clear `keys` from the retiring set (b.deo SRI-502). Memory only. */
  endRetiring(keys: Iterable<string>): void
  /** Whether `key` is retiring (b.deo SRI-502). Every store begins with none. */
  isRetiring(key: string): boolean
}

/** What one write did, for the caller's line. */
type WriteAttempt = { readonly ok: true } | { readonly ok: false; readonly detail: string }

/** Log `line`, swallowing a throwing log. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what the store does */
  }
}

/** Whether `reason` is one of the drop reasons. */
function isDropReason(reason: unknown): reason is ChannelDeliveryDropReason {
  return typeof reason === 'string' && (CHANNEL_DELIVERY_DROP_REASONS as readonly string[]).includes(reason)
}

/**
 * Load the stored-choice file at `stateDir` and build the store over it
 * (b.deo SRI-401, SRI-403): read once, whole, through the configuration
 * reader's open-then-fstat rule with no size cap, and parsed only. A missing
 * file is an empty, readable record, and nothing is written or logged. A file
 * that cannot be read (a directory, a FIFO or other non-regular file, an
 * errno), parsed or validated is left in place, logs one
 * `channel-delivery-unreadable` line, and gives an unreadable store for the
 * run. Never throws; always answers a store.
 */
export function loadChannelDeliveryStore(stateDir: string, deps: ChannelDeliveryStoreDeps): ChannelDeliveryStore {
  const path = channelDeliveryPath(stateDir)
  const unreadable = (cause: ChannelDeliveryUnreadableCause): ChannelDeliveryStore => {
    safeLog(deps.log, channelDeliveryUnreadableLine(path, cause))
    return createChannelDeliveryStore(path, false, new Map(), null, deps)
  }
  let bytes: Uint8Array | null
  try {
    bytes = readPersonaConfigBytes(path, deps.readFs, { uncapped: true })
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    if (!isMissingConfigCode(code)) return unreadable({ stage: CHANNEL_DELIVERY_UNREADABLE_READ, code })
    bytes = null
  }
  let entries: ChannelDeliveryRecord = new Map()
  if (bytes !== null) {
    const parsed = parseChannelDelivery(bytes)
    if (!parsed.ok) return unreadable({ stage: parsed.stage, problem: parsed.problem })
    entries = parsed.record
  }
  return createChannelDeliveryStore(path, true, entries, bytes, deps)
}

/**
 * The start's load (b.deo SRI-403, SRI-407): {@link loadChannelDeliveryStore},
 * followed at once by the start rules over `start`. The one entry `main()`
 * and the reload harness use, so the rules always run right after the read.
 */
export function loadChannelDeliveryAtStart(
  stateDir: string,
  start: ChannelDeliveryStart,
  deps: ChannelDeliveryStoreDeps,
): ChannelDeliveryStore {
  const store = loadChannelDeliveryStore(stateDir, deps)
  store.applyStartRules(start)
  return store
}

/**
 * The store over `path`: `readable` as the start decided, `initial` the
 * record read, and `initialBytes` what the file holds (null: no file).
 */
function createChannelDeliveryStore(
  path: string,
  readable: boolean,
  initial: ChannelDeliveryRecord,
  initialBytes: Uint8Array | null,
  deps: ChannelDeliveryStoreDeps,
): ChannelDeliveryStore {
  const write = deps.write ?? durableWriteFileSync
  const remove = deps.remove ?? durableUnlinkSync
  const now = deps.now ?? Date.now

  /** The record in memory. Replaced, never mutated. */
  let entries: ChannelDeliveryRecord = initial
  /** What the file is believed to hold (null: no file), for a write-back after an unsynced rename. */
  let fileBytes: Uint8Array | null = initialBytes
  /** Keys whose drop no successful write has carried yet (b.deo SRI-405). */
  const unwrittenDrops = new Set<string>()
  /** Keys retiring in a confirmed apply (b.deo SRI-502). Memory only; every store begins with none. */
  const retiring = new Set<string>()

  /** Now as `set_at`, or undefined when the clock gives no RFC 3339 UTC timestamp. */
  function timestamp(): string | undefined {
    try {
      const at = new Date(now()).toISOString()
      return isRfc3339UtcTimestamp(at) ? at : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Put `previous` (null: no file) back after an unsynced write of `current`,
   * best effort, and say what the file holds now.
   */
  function writeBack(previous: Uint8Array | null, current: Uint8Array): string {
    const putBack = previous === null ? 'the file, absent before, was removed again' : 'the previous record was written back'
    try {
      if (previous === null) remove(path)
      else write(path, previous)
      fileBytes = previous
      return putBack
    } catch (backErr) {
      if (backErr instanceof DurableWriteUnsyncedError || backErr instanceof DurableUnlinkUnsyncedError) {
        fileBytes = previous
        return `${putBack}, though its directory could not be synced either`
      }
      fileBytes = current
      const backCode = errnoSuffix(backErr)
      return `putting the previous state back failed too${backCode}, so the file holds the refused choice until the next successful write`
    }
  }

  /**
   * Write `next` whole, durably. On a failure before the rename the file is
   * unchanged. After an unsynced rename, `writeBackOnUnsynced` puts the
   * previous state back (a stored choice); otherwise the new bytes stay (a
   * drop, which a write-back would undo).
   */
  function writeWhole(next: ChannelDeliveryRecord, writeBackOnUnsynced: boolean): WriteAttempt {
    const bytes = serializeChannelDelivery(next)
    try {
      write(path, bytes)
      fileBytes = bytes
      return { ok: true }
    } catch (err) {
      const code = errnoSuffix(err)
      if (!(err instanceof DurableWriteUnsyncedError)) return { ok: false, detail: `${code}; the file is unchanged` }
      const unsynced = `: the record was written but its directory could not be synced${code}`
      if (!writeBackOnUnsynced) {
        fileBytes = bytes
        return { ok: false, detail: `${unsynced}, so a crash can undo it` }
      }
      return { ok: false, detail: `${unsynced}; ${writeBack(fileBytes, bytes)}` }
    }
  }

  /** The input `set` refuses, or undefined when the parser would accept it. */
  function setInputProblem(
    key: unknown,
    channel: unknown,
    delivery: unknown,
    declaration: unknown,
  ): ChannelDeliverySetInvalidField | undefined {
    if (typeof key !== 'string' || !PERSONA_KEY_RE.test(key)) return 'key'
    if (typeof channel !== 'string' || !CHANNEL_ID_RE.test(channel)) return 'channel'
    if (!isDeliveryMode(delivery)) return 'delivery'
    if (!isJsonObject(declaration)) return 'declaration'
    if (CHANNEL_DELIVERY_DECLARATION_FIELDS.some((field) => typeof declaration[field] !== 'string')) return 'declaration'
    return undefined
  }

  function set(
    key: string,
    channel: string,
    delivery: DeliveryMode,
    declaration: ChannelDeliveryDeclaration,
  ): ChannelDeliverySetResult {
    if (!readable) return { kind: CHANNEL_DELIVERY_SET_UNREADABLE, path }
    const field = setInputProblem(key, channel, delivery, declaration)
    if (field !== undefined) return { kind: CHANNEL_DELIVERY_SET_INVALID, field }
    const setAt = timestamp()
    if (setAt === undefined) return { kind: CHANNEL_DELIVERY_SET_INVALID, field: 'set_at' }

    const existing = entries.get(key)
    const previous = existing?.channels.get(channel)?.delivery
    const channels = new Map(existing?.channels ?? [])
    channels.set(channel, { delivery, set_at: setAt })
    const next = new Map(entries)
    next.set(key, { declaration: channelDeliveryDeclarationOf(declaration), channels })

    const attempt = writeWhole(next, true)
    if (attempt.ok) {
      entries = next
      unwrittenDrops.clear()
      return { kind: CHANNEL_DELIVERY_SET_STORED, previous }
    }
    safeLog(deps.log, channelDeliveryWriteFailedLine(path, channelDeliverySetAction(key, channel), attempt.detail, false))
    return { kind: CHANNEL_DELIVERY_SET_WRITE_FAILED, path }
  }

  function drop(batch: readonly ChannelDeliveryDrop[]): ChannelDeliveryWriteOutcome {
    for (const { reason } of batch) {
      if (!isDropReason(reason)) throw new RangeError('channel-delivery: a key to drop needs a known reason')
    }
    if (!readable) return CHANNEL_DELIVERY_NOTHING_TO_WRITE
    const next = new Map(entries)
    const dropped: { key: string; count: number; reason: ChannelDeliveryDropReason }[] = []
    const seen = new Set<string>()
    for (const { key, reason } of batch) {
      if (seen.has(key)) continue
      seen.add(key)
      const entry = next.get(key)
      if (entry === undefined) continue
      next.delete(key)
      dropped.push({ key, count: entry.channels.size, reason })
    }
    if (dropped.length === 0) return CHANNEL_DELIVERY_NOTHING_TO_WRITE

    // A drop applies in memory at once, whatever its write does (b.deo SRI-405).
    entries = next
    for (const { key, count, reason } of dropped) safeLog(deps.log, channelDeliveryDropLine(key, count, reason))
    // No drop creates a missing file (b.deo SRI-404): with no file, nothing on disk holds the dropped choices.
    if (fileBytes === null) return CHANNEL_DELIVERY_NOTHING_TO_WRITE

    const keys = dropped.map(({ key }) => key)
    const attempt = writeWhole(next, false)
    if (attempt.ok) {
      unwrittenDrops.clear()
      return CHANNEL_DELIVERY_WRITTEN
    }
    for (const key of keys) unwrittenDrops.add(key)
    safeLog(deps.log, channelDeliveryWriteFailedLine(path, channelDeliveryDropAction(keys), attempt.detail, true))
    return CHANNEL_DELIVERY_WRITE_FAILED
  }

  function writeUnwrittenDrops(): ChannelDeliveryWriteOutcome {
    if (!readable || unwrittenDrops.size === 0) return CHANNEL_DELIVERY_NOTHING_TO_WRITE
    if (fileBytes === null) {
      // No file holds the dropped choices, so there is nothing to carry.
      unwrittenDrops.clear()
      return CHANNEL_DELIVERY_NOTHING_TO_WRITE
    }
    const keys = [...unwrittenDrops]
    const attempt = writeWhole(entries, false)
    if (attempt.ok) {
      unwrittenDrops.clear()
      return CHANNEL_DELIVERY_WRITTEN
    }
    safeLog(deps.log, channelDeliveryWriteFailedLine(path, channelDeliveryDropAction(keys), attempt.detail, true))
    return CHANNEL_DELIVERY_WRITE_FAILED
  }

  /** Whether two paths are the same: equal as written, or equal by `resolveRealPath` (as the reload plan compares them). */
  function samePath(a: string, b: string): boolean {
    if (a === b) return true
    return deps.realpath === undefined
      ? resolveRealPath(a) === resolveRealPath(b)
      : resolveRealPath(a, deps.realpath) === resolveRealPath(b, deps.realpath)
  }

  /** Whether the recorded declaration matches the applied one (b.deo SRI-407). */
  function sameDeclaration(recorded: ChannelDeliveryDeclaration, applied: ChannelDeliveryDeclaration): boolean {
    return (
      recorded.name === applied.name &&
      samePath(recorded.credentials_file, applied.credentials_file) &&
      samePath(recorded.working_directory, applied.working_directory)
    )
  }

  function applyStartRules(start: ChannelDeliveryStart): ChannelDeliveryWriteOutcome {
    if (!readable || entries.size === 0) return CHANNEL_DELIVERY_NOTHING_TO_WRITE
    const applied = new Map(start.applied.map(({ key, declaration }) => [key, declaration]))
    const batch: ChannelDeliveryDrop[] = []
    for (const key of [...entries.keys()].sort()) {
      const declared = applied.get(key)
      // The precedence: not applied, then a changed declaration, then the retired-key record.
      if (declared === undefined) batch.push({ key, reason: CHANNEL_DELIVERY_DROP_NOT_APPLIED })
      else if (!sameDeclaration(entries.get(key)!.declaration, declared)) {
        batch.push({ key, reason: CHANNEL_DELIVERY_DROP_DECLARATION_CHANGED })
      } else if (start.retiredKeys.isRecorded(key) && !start.retiredKeys.isMarked(key)) {
        // SRI-905's closed reasons have no reason of their own for a key the
        // retired-key record holds without its "new life has begun" mark
        // (b.jg5 SRJ-806); such a key was retired by a confirmed change (or by
        // the start sweep) whose new life has not begun, so its drop uses
        // "retired by a confirmed change".
        batch.push({ key, reason: CHANNEL_DELIVERY_DROP_RETIRED })
      }
    }
    return drop(batch)
  }

  return {
    path,
    readable,
    storedChoice: (key, channel) => (readable ? entries.get(key)?.channels.get(channel)?.delivery : undefined),
    storedChannels: (key) => (readable ? [...(entries.get(key)?.channels.keys() ?? [])].sort() : []),
    record: () => entries,
    set,
    drop,
    hasUnwrittenDrop: (key) => unwrittenDrops.has(key),
    writeUnwrittenDrops,
    applyStartRules,
    beginRetiring: (keys) => {
      for (const key of keys) retiring.add(key)
    },
    endRetiring: (keys) => {
      for (const key of keys) retiring.delete(key)
    },
    isRetiring: (key) => retiring.has(key),
  }
}
