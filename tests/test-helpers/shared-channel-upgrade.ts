/**
 * test-helpers/shared-channel-upgrade.ts — The manual-upgrade fixtures
 * (Ideas b.tad SR-8.1, SR-8.2): CSCB 0.18.0 old references, hand-prepared
 * new baselines, pending edits to put back, and queue journals, as cases
 * defined in data below.
 *
 * Generator: `writeUpgradeFixtures` writes every committed file under
 * tests/fixtures/shared-channel-upgrade/ and its manifest.json; running
 * `bun tests/test-helpers/shared-channel-upgrade.ts write` from the repo
 * rewrites that directory. The unit suite fails when the committed files
 * differ from what it would write. New-format files go through the current
 * builders (persona-config.ts, delivery-queue.ts, shared-channels.ts), loaded
 * by dynamic import inside the generator only.
 *
 * Materializer and image commands: `materializeUpgradeCase` and
 * `runUpgradeCaseCommand` need nothing beyond `node:` modules, host-safe-env.ts
 * (itself `node:`-only) and the committed fixture tree, so the image entry
 * (tests/integration/fixtures/shared-channel-upgrade-case.ts) loads them
 * without the repo's src/. Static imports here must stay `node:` modules,
 * host-safe-env.ts or type-only.
 *
 * 0.18.0 formats are modelled, not imported: the old builders below follow
 * 0.18.0's src/config.ts (keys and delivery values), src/channel-delivery.ts
 * (the stored-choice file), src/reload-fingerprint.ts and src/reload-plan.ts
 * (the pending file), src/reload.ts (the last-applied byte copy) and
 * src/delivery-queue.ts (the journal record set).
 *
 * Committed files hold no host path: persona paths are `~/…`. The
 * materializer fills every JSON string's leading `"~/` with the scenario's
 * home in every new-baseline/ and pending-edits/ file (and so in the state
 * dir's copies of the default variant), so those paths never depend on the
 * server's HOME; elsewhere it fills only the files the manifest marks
 * home_relative (0.18.0 stored absolute paths there), and the other
 * reference-0.18.0/ files keep `~/` as 0.18.0 wrote them.
 *
 * Host settings and persona names are the scenario's, not the case's: the
 * materializer sets each `settings` entry in every new-baseline/ and
 * pending-edits/ config (the interrupted variant's left-over 0.18.0 applied
 * baseline included; never a reference-0.18.0/ file) and puts `personaPrefix` before every persona name in every file
 * and persona-named path, refreshing the 0.18.0 pending file's fingerprint.
 * The committed files keep the plain names and no host settings.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRealHome } from './host-safe-env.ts'
import type { DeliveryMode, PersonaConfigInput, PersonaInput } from '../../src/config.ts'
import type { AcceptedInput, QueueRecord, ReplyReminderRecord } from '../../src/delivery-queue.ts'

// ---------------------------------------------------------------------------
// Layout and manifest
// ---------------------------------------------------------------------------

export const UPGRADE_FIXTURE_DIR = resolve(import.meta.dir, '..', 'fixtures', 'shared-channel-upgrade')
export const UPGRADE_MANIFEST_FILE = 'manifest.json'
export const UPGRADE_MANIFEST_FORMAT = 'cscb-shared-channel-upgrade-fixtures'
export const UPGRADE_MANIFEST_VERSION = 1
export const OLD_RELEASE = '0.18.0'
/** Committed group directories inside each case directory. */
export const UPGRADE_GROUP_DIRS = { reference: 'reference-0.18.0', baseline: 'new-baseline', pending: 'pending-edits' } as const
export type UpgradeGroup = keyof typeof UPGRADE_GROUP_DIRS
/** Where the materializer puts a file: the scenario state dir, or one of the case root's group directories. */
export type UpgradeTarget = 'state' | UpgradeGroup

export type FileCondition = 'valid' | 'malformed' | 'invalid' | 'unreadable' | 'refused'
export interface UpgradeManifestFile {
  /** Committed path, relative to the fixture directory. */
  path: string
  group: UpgradeGroup
  /** The baseline variant or pending edit the file belongs to. */
  variant?: string
  /** Each place the materializer writes the file, relative to that target's directory. */
  targets: { to: UpgradeTarget; path: string }[]
  /** Modification time the materializer applies, ISO 8601 UTC. */
  mtime: string
  /** Octal mode the materializer applies after writing. */
  mode?: string
  condition: FileCondition
  /**
   * A 0.18.0 file whose JSON strings starting `~/` stand for the absolute
   * paths 0.18.0 stored; the materializer fills them in with the home. It
   * fills every new-baseline/ and pending-edits/ file too, whatever this says.
   */
  home_relative: boolean
  about: string
}
export type ChannelChoice =
  | { action: 'transfer'; delivery: DeliveryMode }
  | { action: 'choose'; delivery: DeliveryMode }
  | { action: 'new'; delivery: DeliveryMode }
  | { action: 'retire' }
export interface UpgradeChannelRow {
  persona: string
  channel: string
  kind: string
  /** The 0.18.0 configuration's entry; `inactive` when that section was not read in the starting mode. */
  old_config?: { delivery: 'all' | 'mentions'; section: 'channels'; inactive: boolean }
  old_stored_choice?: { delivery: 'all' | 'mentions'; set_at: string }
  /** For a conflict: which old source the dates suggest (the newer one). */
  newer_source?: 'config' | 'stored_choice'
  choice: ChannelChoice
  note: string
}
export interface UpgradeIdentityRow {
  key: string
  name: string
  old: string
  disposition: 'transfer' | 'retire'
  note: string
}
export interface UpgradeDestinationRow {
  persona: string
  old_declarative?: string
  old_invited?: string
  /** Which old destination the starting mode read. */
  old_active: 'declarative' | 'invited' | 'none'
  chosen: string
  note: string
}
export type BaselineExpectation =
  | { loads: true; channel_mode: 'strict' | 'open' }
  | { loads: false; fails_in: 'config.json' | 'config.json.last-applied'; names: string[] }
export interface UpgradeBaseline {
  name: string
  /** The variant the materializer puts in the state dir. */
  default: boolean
  /** The variant that records the case's operator choices (channels, identities, destinations). */
  chosen: boolean
  about: string
  expect: BaselineExpectation
}
export interface UpgradePendingEdit { name: string; about: string; changes: string[] }
export interface UpgradeQueueSummary {
  persona: string
  path: string
  about: string
  items: { seq: number; source: string; via?: string; queued_ack_reaction?: string; reminder_for?: number; delivered: boolean }[]
  reply_reminders: { seq: number; state: string }[]
}
export interface UpgradeManifestPersona {
  name: string
  key: string
  credentials_file: string
  working_directory: string
  note?: string
}
export interface UpgradeManifestCase {
  name: string
  summary: string
  starting_mode: '0.18.0 declarative' | '0.18.0 fungible' | 'no old files'
  new_mode: 'strict' | 'open'
  ac_rows: string[]
  personas: UpgradeManifestPersona[]
  channels: UpgradeChannelRow[]
  identities: UpgradeIdentityRow[]
  destinations: UpgradeDestinationRow[]
  baselines: UpgradeBaseline[]
  pending_edits: UpgradePendingEdit[]
  queues: UpgradeQueueSummary[]
  /** Home-relative credentials paths a script writes (fake tokens) before starting; never committed. */
  credentials: { persona: string; path: string; note: string }[]
  files: UpgradeManifestFile[]
}
export interface UpgradeManifest {
  format: typeof UPGRADE_MANIFEST_FORMAT
  version: typeof UPGRADE_MANIFEST_VERSION
  old_release: typeof OLD_RELEASE
  about: string
  cases: UpgradeManifestCase[]
}

// ---------------------------------------------------------------------------
// 0.18.0 builders (modelled on the 0.18.0 npm package; never imported)
// ---------------------------------------------------------------------------

/** 0.18.0 src/config.ts DELIVERY_MODES: no `off`. */
export const OLD_DELIVERY_VALUES = ['all', 'mentions'] as const
/** 0.18.0 src/config.ts SHARED_TOP_LEVEL_KEYS, the persona-only top-level keys and its test keys. */
export const OLD_TOP_LEVEL_KEYS = [
  'personas', 'bind', 'port', 'session_restart_delay', 'health_check_interval', 'exit_timeout', 'stop_timeout',
  'mcp_config_path', 'append_system_prompt_file', 'cozempic_prescription', 'system_prompt_mode', 'fresh_system_prompt',
  'message_archive_db', 'claude_config_dir', 'resume_enabled', 'agent_director_poll_interval_ms',
  'agent_director_call_timeout_ms', 'stop_hook_bootstrap', 'cron_table_path', 'cron_log_path', 'cron_log_max_bytes',
  'allow_invited_channels', 'queued_ack_reaction', 'ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode',
  'test_timer_overrides', 'test_mcp_drop_endpoint',
] as const
/** 0.18.0 src/config.ts PERSONA_ENTRY_KEYS: `resume_enabled` is top-level only. */
export const OLD_PERSONA_KEYS = ['name', 'credentials_file', 'working_directory', 'channels', 'dm', 'permission_prompts', 'invited', 'claude_config_dir', 'stop_hook_bootstrap'] as const
const OLD_CHANNEL_ID_RE = /^[CG][A-Z0-9]+$/
const OLD_DM_CONTACT_RE = /^[UW][A-Z0-9]+$/
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export interface OldPersona018 {
  name: string
  credentials_file: string
  working_directory: string
  channels?: { id: string; delivery: 'all' | 'mentions' }[]
  dm?: { enabled?: boolean; contact?: string }
  permission_prompts?: string
  invited?: { permission_prompts?: string }
}
export interface OldConfig018 { personas: OldPersona018[]; [setting: string]: unknown }

function oldDestinationOk(value: string): boolean { return value === 'dm' || OLD_CHANNEL_ID_RE.test(value) }

/**
 * A 0.18.0 config.json as an operator wrote it: 2-space JSON and a newline.
 * Throws on a key, delivery value, channel ID or destination 0.18.0 would not accept.
 */
export function oldConfigBytes018(config: OldConfig018): Buffer {
  for (const key of Object.keys(config)) {
    if (!(OLD_TOP_LEVEL_KEYS as readonly string[]).includes(key)) throw new Error(`0.18.0 has no top-level key ${key}`)
  }
  if (config.allow_invited_channels !== undefined && typeof config.allow_invited_channels !== 'boolean') throw new Error('0.18.0 allow_invited_channels is a boolean')
  for (const persona of config.personas) {
    for (const key of Object.keys(persona)) {
      if (!(OLD_PERSONA_KEYS as readonly string[]).includes(key)) throw new Error(`0.18.0 has no persona key ${key}`)
    }
    for (const channel of persona.channels ?? []) {
      if (!OLD_CHANNEL_ID_RE.test(channel.id)) throw new Error(`0.18.0 channel ID ${channel.id} is malformed`)
      if (!(OLD_DELIVERY_VALUES as readonly string[]).includes(channel.delivery)) throw new Error(`0.18.0 has no delivery ${channel.delivery}`)
    }
    if (persona.dm?.contact !== undefined && !OLD_DM_CONTACT_RE.test(persona.dm.contact)) throw new Error('0.18.0 dm.contact is malformed')
    for (const destination of [persona.permission_prompts, persona.invited?.permission_prompts]) {
      if (destination !== undefined && !oldDestinationOk(destination)) throw new Error(`0.18.0 destination ${destination} is malformed`)
    }
  }
  return Buffer.from(JSON.stringify(config, null, 2) + '\n')
}

export interface OldStoredChoice018 {
  declaration: { name: string; credentials_file: string; working_directory: string }
  channels: Record<string, { delivery: 'all' | 'mentions'; set_at: string }>
}
/**
 * A 0.18.0 channel-delivery.json, as its serializeChannelDelivery writes it:
 * version 1, persona keys and channel IDs sorted, keys with no channel left
 * out, 2-space JSON and a newline. Declarations hold `~/` paths here; the
 * materializer fills in the home, since 0.18.0 stores resolved absolute paths.
 */
export function oldStoredChoiceBytes018(personas: Record<string, OldStoredChoice018>): Buffer {
  const out: Record<string, OldStoredChoice018> = {}
  for (const key of Object.keys(personas).sort()) {
    const record = personas[key]!
    const ids = Object.keys(record.channels).sort()
    if (ids.length === 0) continue
    const channels: OldStoredChoice018['channels'] = {}
    for (const id of ids) {
      const choice = record.channels[id]!
      if (!OLD_CHANNEL_ID_RE.test(id)) throw new Error(`0.18.0 channel ID ${id} is malformed`)
      if (!(OLD_DELIVERY_VALUES as readonly string[]).includes(choice.delivery)) throw new Error(`0.18.0 has no stored delivery ${choice.delivery}`)
      if (!RFC3339_UTC_RE.test(choice.set_at)) throw new Error(`0.18.0 set_at ${choice.set_at} is not RFC 3339 UTC`)
      channels[id] = { delivery: choice.delivery, set_at: choice.set_at }
    }
    const { name, credentials_file, working_directory } = record.declaration
    out[key] = { declaration: { name, credentials_file, working_directory }, channels }
  }
  return Buffer.from(JSON.stringify({ version: 1, personas: out }, null, 2) + '\n')
}

/** 0.18.0 src/reload-fingerprint.ts reloadFingerprint over the config bytes and the given credentials entries. */
export function oldReloadFingerprint018(config: Uint8Array, credentials: readonly { path: string; content: Uint8Array }[] = []): string {
  const length = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
  const hash = createHash('sha256')
  hash.update('cscb-reload-fingerprint-v1\n', 'utf-8')
  hash.update(Buffer.of(0x42)); hash.update(length(config.length)); hash.update(config)
  hash.update(length(credentials.length))
  for (const entry of credentials) {
    const path = Buffer.from(entry.path, 'utf-8')
    hash.update(length(path.length)); hash.update(path)
    hash.update(Buffer.of(0x42)); hash.update(length(entry.content.length)); hash.update(entry.content)
  }
  return hash.digest('hex')
}

/** 0.18.0 src/reload-fingerprint.ts composePendingFile: header, fingerprint line, a blank line, the preview. */
export function oldPendingFileBytes018(configBytes: Uint8Array, previewLines: readonly string[]): Buffer {
  const text = `claude-slack-channel-bots: pending configuration change (written by the server)\nfingerprint: sha256:${oldReloadFingerprint018(configBytes)}\n\n${previewLines.join('\n')}`
  return Buffer.from(text.endsWith('\n') ? text : `${text}\n`)
}

const oldRef = (name: string, key: string): string => `${JSON.stringify(name)} (key=${key})`
/** Preview lines modelled on 0.18.0 src/reload-plan.ts renderPreviewLines and its clause builders. */
export const oldPreview018 = {
  header: (c: { added: number; removed: number; destructive: number; inPlace: number; credentials: number; settings: number }): string =>
    `A configuration change is pending; nothing has been applied. personas: ${c.added} added, ${c.removed} removed, ${c.destructive} destructively modified, ${c.inPlace} modified in place, ${c.credentials} with changed credentials; server-wide settings: ${c.settings} changed.`,
  destructive: (name: string, key: string, field: string, value: string): string =>
    `DESTRUCTIVE: persona ${oldRef(name, key)} ${field} changed to ${JSON.stringify(value)}: the persona will be retired and brought up fresh: its session stopped and never resumed.`,
  recorded: (name: string, key: string, field: string, section: 'declarative' | 'fungible', until: 'declarative' | 'fungible'): string =>
    `persona ${oldRef(name, key)}: ${field} changed in the ${section} section: recorded, with no effect until allow_invited_channels selects ${until} mode.`,
  cliRecordSetting: (setting: string): string =>
    `server-wide setting ${setting} changed: once applied, it is recorded, and the CLI takes it from the record from then on (the running server does not use it).`,
  modeSwitch: (to: 'fungible' | 'declarative', personas: readonly { name: string; key: string }[]): string =>
    `server-wide setting allow_invited_channels changed: turns ${to} mode on, applied in place at once, from the next event, tool call, prompt and notice, for ${personas.map(p => oldRef(p.name, p.key)).join(', ')}.`,
}

/** Fields and record kinds the current journal has and 0.18.0's isQueueRecord rejects. */
const NEW_ONLY_QUEUE_FIELDS = ['thread_join', 'hold', 'released_at']
const NEW_ONLY_QUEUE_KINDS = ['released', 'withdrawn', 'parked']
/** A queue journal both 0.18.0 and the current reader take: one JSON record per line. */
export function oldQueueBytes018(records: readonly QueueRecord[]): Buffer {
  for (const record of records) {
    if (NEW_ONLY_QUEUE_KINDS.includes(record.kind)) throw new Error(`0.18.0 has no queue record kind ${record.kind}`)
    for (const field of NEW_ONLY_QUEUE_FIELDS) if (field in record) throw new Error(`0.18.0 queue records have no ${field}`)
  }
  return Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''))
}

export interface OldReferenceOptions {
  out: string
  mode: 'declarative' | 'fungible'
  persona: OldPersona018
  settings: Record<string, string | number | boolean>
}
/**
 * Write a 0.18.0 config.json for one persona and its byte-identical
 * config.json.last-applied into `out` (under the OS temp dir or
 * SCENARIO_ROOT). Refuses existing files. Returns the two paths.
 */
export function writeOldReference018(options: OldReferenceOptions): { config: string; lastApplied: string } {
  const out = guardScratchDir(options.out, 'reference-0.18.0 --out')
  for (const key of Object.keys(options.settings)) {
    if (key === 'personas' || key === 'allow_invited_channels') throw new Error(`--setting ${key} is not allowed; the persona and --mode set it`)
  }
  const config: OldConfig018 = { personas: [options.persona], ...options.settings }
  if (options.mode === 'fungible') config.allow_invited_channels = true
  const bytes = oldConfigBytes018(config)
  const paths = { config: join(out, 'config.json'), lastApplied: join(out, 'config.json.last-applied') }
  for (const path of Object.values(paths)) if (existsSync(path)) throw new Error(`${path} already exists`)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  writeFileSync(paths.config, bytes, { mode: 0o600 })
  writeFileSync(paths.lastApplied, bytes, { mode: 0o600 })
  return paths
}

// ---------------------------------------------------------------------------
// Scratch guards
// ---------------------------------------------------------------------------

function realOrResolved(path: string): string {
  let probe = resolve(path)
  const rest: string[] = []
  while (!existsSync(probe) && dirname(probe) !== probe) { rest.unshift(basename(probe)); probe = dirname(probe) }
  return join(realpathSync(probe), ...rest)
}
function strictlyUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
/**
 * `dir`, resolved, when it is not the real home (`isRealHome`) and is
 * strictly under the OS temp dir, or is or lies under $SCENARIO_ROOT (itself
 * not the real home).
 */
export function guardScratchDir(dir: string, what: string): string {
  if (!isAbsolute(dir)) throw new Error(`${what} must be an absolute path`)
  const real = realOrResolved(dir)
  if (isRealHome(dir) || isRealHome(real)) throw new Error(`${what} refused: it is the real home`)
  const scenario = process.env.SCENARIO_ROOT
  const scenarioRoot = scenario && isAbsolute(scenario) && !isRealHome(scenario) ? realOrResolved(scenario) : undefined
  const underTemp = strictlyUnder(real, realOrResolved(tmpdir()))
  const underScenario = scenarioRoot !== undefined && (real === scenarioRoot || strictlyUnder(real, scenarioRoot))
  if (!underTemp && !underScenario) throw new Error(`${what} refused: not under the OS temp dir or SCENARIO_ROOT`)
  return real
}

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

export function readUpgradeManifest(fixtureDir = UPGRADE_FIXTURE_DIR): UpgradeManifest {
  const manifest = JSON.parse(readFileSync(join(fixtureDir, UPGRADE_MANIFEST_FILE), 'utf8')) as UpgradeManifest
  if (manifest.format !== UPGRADE_MANIFEST_FORMAT || manifest.version !== UPGRADE_MANIFEST_VERSION) throw new Error('manifest.json is not a version 1 upgrade fixture manifest')
  return manifest
}

/** Replace every JSON string's leading `~/` with `<home>/`. */
export function fillHome(text: string, home: string): string {
  return text.split('"~/').join(`"${home}/`)
}
export function expandHomePath(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export type UpgradeSettingValue = string | number | boolean
/**
 * Current top-level keys `materialize --setting` may name: the loader's
 * (src/config.ts PERSONA_TOP_LEVEL_KEYS and its test keys) less `personas`,
 * `channel_mode` and the object-valued `test_timer_overrides`. The unit suite
 * holds this list to the loader's.
 */
export const UPGRADE_SETTING_KEYS = [
  'bind', 'port', 'session_restart_delay', 'health_check_interval', 'exit_timeout', 'stop_timeout', 'mcp_config_path',
  'append_system_prompt_file', 'cozempic_prescription', 'system_prompt_mode', 'fresh_system_prompt', 'message_archive_db',
  'claude_config_dir', 'resume_enabled', 'agent_director_poll_interval_ms', 'agent_director_call_timeout_ms',
  'stop_hook_bootstrap', 'cron_table_path', 'cron_log_path', 'cron_log_max_bytes',
  'queued_ack_reaction', 'ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode', 'test_mcp_drop_endpoint',
] as const
/** Keys `materialize --setting` refuses by name, and why: each would change what a case tests. */
export const UPGRADE_REFUSED_SETTINGS: Readonly<Record<string, string>> = {
  personas: 'the case sets the personas',
  channel_mode: 'the case sets the channel mode',
  allow_invited_channels: 'it has been removed',
  invited: 'it has been removed',
  claude_director_poll_interval_ms: 'it has been removed (renamed agent_director_poll_interval_ms)',
  test_timer_overrides: 'object values are not supported',
}
/** Groups whose files are current-format configs, which `materialize --setting` reaches. */
const SETTING_GROUPS: readonly UpgradeGroup[] = ['baseline', 'pending']
/** Groups whose `"~/` paths the materializer always fills with the home, so the server's HOME never resolves them. */
const HOME_FILL_GROUPS: readonly UpgradeGroup[] = ['baseline', 'pending']
const PERSONA_PREFIX_RE = /^[a-z0-9_]+$/
/** 0.18.0's and the current key rule: a name of 1–40 of `a-z0-9_` is its own key. */
const NAME_IS_KEY_RE = /^[a-z0-9_]{1,40}$/
const PENDING_FINGERPRINT_RE = /^fingerprint: sha256:([0-9a-f]{64})$/m

const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n')

/** The settings, checked: a key the loader takes, not refused by name, and not one the case's own configs set. */
function checkUpgradeSettings(entry: UpgradeManifestCase, settings: Record<string, UpgradeSettingValue>, committed: ReadonlyMap<string, Buffer>): Record<string, UpgradeSettingValue> {
  const own = new Set(entry.files.filter(f => SETTING_GROUPS.includes(f.group)).flatMap(f => Object.keys(JSON.parse(committed.get(f.path)!.toString('utf8')) as object)))
  for (const [key, value] of Object.entries(settings)) {
    if (Object.hasOwn(UPGRADE_REFUSED_SETTINGS, key)) throw new Error(`--setting ${key} is refused: ${UPGRADE_REFUSED_SETTINGS[key]}`)
    if (!(UPGRADE_SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`--setting ${key} is refused: the current loader has no top-level key ${key}`)
    if (own.has(key)) throw new Error(`--setting ${key} is refused: case ${entry.name} sets it in its own configs`)
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`--setting ${key} is refused: only true, false, integers and strings are supported`)
  }
  return settings
}

/** A current-format config with the settings set: an existing key keeps its place, a new one goes last. */
function withSettings(bytes: Buffer, settings: Record<string, UpgradeSettingValue>, path: string): Buffer {
  const text = bytes.toString('utf8')
  const config = JSON.parse(text) as Record<string, unknown>
  if (!jsonBytes(config).equals(bytes)) throw new Error(`${path} is not in the generator's JSON layout; --setting cannot rewrite it`)
  return jsonBytes({ ...config, ...settings })
}

/**
 * A function that puts `prefix` before every persona name the case uses (its
 * personas and its old identities), as a whole word, or undefined for no
 * prefix. Refuses a prefix that would make a name other than its own key.
 */
function personaRenamer(entry: UpgradeManifestCase, prefix: string | undefined): ((text: string) => string) | undefined {
  if (prefix === undefined) return undefined
  if (!PERSONA_PREFIX_RE.test(prefix)) throw new Error(`--persona-prefix ${JSON.stringify(prefix)} refused: use only a-z, 0-9 and _`)
  const names = [...new Set([...entry.personas.map(p => p.name), ...entry.identities.map(i => i.name)])]
  for (const name of names) {
    if (!NAME_IS_KEY_RE.test(name) || !NAME_IS_KEY_RE.test(prefix + name)) throw new Error(`--persona-prefix refused: ${JSON.stringify(prefix + name)} would not be its own persona key (1-40 of a-z, 0-9 and _)`)
  }
  for (const p of entry.personas) if (p.key !== p.name) throw new Error(`--persona-prefix refused: persona ${p.name} has key ${p.key}`)
  if (names.length === 0) return text => text
  const word = new RegExp(`\\b(${names.join('|')})\\b`, 'g')
  return text => text.replace(word, name => prefix + name)
}
function renameBytes(bytes: Buffer, rename: (text: string) => string, path: string): Buffer {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw new Error(`${path} is not UTF-8 text; --persona-prefix cannot rename it`)
  return Buffer.from(rename(text))
}

/**
 * A 0.18.0 config.json.pending whose fingerprint line follows the renamed
 * config.json: refused unless the committed fingerprint is 0.18.0's over the
 * committed config.json, so a rename never hides a stale preview.
 */
function refreshPendingFingerprint(pending: Buffer, committedConfig: Buffer, renamedConfig: Buffer, path: string): Buffer {
  const text = pending.toString('utf8')
  const found = PENDING_FINGERPRINT_RE.exec(text)?.[1]
  if (found !== oldReloadFingerprint018(committedConfig)) throw new Error(`${path}: its fingerprint is not 0.18.0's over the case's config.json; --persona-prefix cannot rename it`)
  return Buffer.from(text.replace(PENDING_FINGERPRINT_RE, `fingerprint: sha256:${oldReloadFingerprint018(renamedConfig)}`))
}

export interface MaterializeOptions {
  fixtureDir?: string
  caseName: string
  /** Scenario root: under the OS temp dir or SCENARIO_ROOT. */
  root: string
  /** Under `root`; receives the default baseline and the in-place old files. */
  stateDir: string
  /** Under `root`; the home every `~/` names, written into every new-baseline/ and pending-edits/ file. */
  home: string
  /** Top-level settings set in every current-format config (baselines and pending edits); see UPGRADE_SETTING_KEYS. */
  settings?: Record<string, UpgradeSettingValue>
  /** Put before every persona name in every file and persona-named path the case writes. */
  personaPrefix?: string
}
export interface MaterializedCase {
  caseName: string
  stateDir: string
  home: string
  caseRoot: string
  dirs: Record<UpgradeGroup, string>
  defaultBaseline: string
  chosenBaseline: string
  /** Each persona's manifest name and its materialized name (its key too). */
  personas: { manifestName: string; name: string }[]
  credentials: { persona: string; path: string }[]
  workdirs: { persona: string; path: string }[]
  written: string[]
}

/**
 * Write one case's files: the default baseline and the in-place old files
 * into `stateDir`, and every group's files under `<root>/upgrade-<case>/`.
 * Renames the personas, sets the settings in every current-format config,
 * applies the manifest's dates and modes, fills in the home (every
 * current-format config, and the home_relative 0.18.0 files), creates the
 * working directories. Writes no credentials and nothing outside `root`;
 * refuses a file that already exists, writing nothing.
 */
export function materializeUpgradeCase(options: MaterializeOptions): MaterializedCase {
  const fixtureDir = options.fixtureDir ?? UPGRADE_FIXTURE_DIR
  const manifest = readUpgradeManifest(fixtureDir)
  const entry = manifest.cases.find(c => c.name === options.caseName)
  if (!entry) throw new Error(`no case ${JSON.stringify(options.caseName)}; cases: ${manifest.cases.map(c => c.name).join(', ')}`)
  const committed = new Map<string, Buffer>()
  for (const file of entry.files) {
    const source = resolve(fixtureDir, file.path)
    if (!strictlyUnder(source, resolve(fixtureDir))) throw new Error(`manifest path ${file.path} leaves the fixture directory`)
    committed.set(file.path, readFileSync(source))
  }
  const settings = checkUpgradeSettings(entry, options.settings ?? {}, committed)
  const rename = personaRenamer(entry, options.personaPrefix)
  const named = (text: string): string => rename ? rename(text) : text
  const root = guardScratchDir(options.root, '--root')
  const inside = (path: string, what: string): string => {
    if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path`)
    const real = realOrResolved(path)
    if (!strictlyUnder(real, root)) throw new Error(`${what} refused: not under --root`)
    return real
  }
  const stateDir = inside(options.stateDir, '--state-dir')
  const home = inside(options.home, '--home')
  if (/["\\\u0000-\u001f]/.test(home)) throw new Error('--home refused: it holds a character JSON would escape')
  const caseRoot = join(root, `upgrade-${entry.name}`)
  const dirs = {
    reference: join(caseRoot, UPGRADE_GROUP_DIRS.reference),
    baseline: join(caseRoot, UPGRADE_GROUP_DIRS.baseline),
    pending: join(caseRoot, UPGRADE_GROUP_DIRS.pending),
  }
  const targetDir: Record<UpgradeTarget, string> = { state: stateDir, ...dirs }
  const referenceConfig = committed.get(`${entry.name}/${UPGRADE_GROUP_DIRS.reference}/config.json`)
  const writes: { file: UpgradeManifestFile; dest: string; bytes: Buffer }[] = []
  for (const file of entry.files) {
    let bytes = committed.get(file.path)!
    if (rename) {
      bytes = renameBytes(bytes, rename, file.path)
      if (file.group === 'reference' && basename(file.path) === 'config.json.pending') {
        if (!referenceConfig) throw new Error(`${file.path} has no config.json beside it; --persona-prefix cannot rename it`)
        bytes = refreshPendingFingerprint(bytes, referenceConfig, renameBytes(referenceConfig, rename, file.path), file.path)
      }
    }
    if (Object.keys(settings).length > 0 && SETTING_GROUPS.includes(file.group)) bytes = withSettings(bytes, settings, file.path)
    if (file.home_relative || HOME_FILL_GROUPS.includes(file.group)) bytes = Buffer.from(fillHome(bytes.toString('utf8'), home))
    for (const target of file.targets) {
      const base = targetDir[target.to]
      const dest = resolve(base, named(target.path))
      if (!strictlyUnder(dest, base)) throw new Error(`manifest target ${target.path} leaves its directory`)
      if (existsSync(dest)) throw new Error(`${dest} already exists`)
      writes.push({ file, dest, bytes })
    }
  }
  for (const { file, dest, bytes } of writes) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
    writeFileSync(dest, bytes, { mode: 0o600 })
    const at = new Date(file.mtime)
    utimesSync(dest, at, at)
    if (file.mode !== undefined) chmodSync(dest, parseInt(file.mode, 8))
  }
  const workdirs = entry.personas.map(p => ({ persona: named(p.key), path: expandHomePath(named(p.working_directory), home) }))
  for (const w of workdirs) {
    if (!strictlyUnder(resolve(w.path), root)) throw new Error(`working directory for ${w.persona} is not under --root`)
    mkdirSync(w.path, { recursive: true, mode: 0o700 })
  }
  const personas = entry.personas.map(p => ({ manifestName: p.name, name: named(p.name) }))
  const credentials = entry.credentials.map(c => ({ persona: named(c.persona), path: expandHomePath(named(c.path), home) }))
  const baseline = (pick: 'default' | 'chosen'): string => entry.baselines.find(b => b[pick])?.name ?? ''
  return { caseName: entry.name, stateDir, home, caseRoot, dirs, defaultBaseline: baseline('default'), chosenBaseline: baseline('chosen'), personas, credentials, workdirs, written: writes.map(w => w.dest) }
}

// ---------------------------------------------------------------------------
// Image commands
// ---------------------------------------------------------------------------

export const UPGRADE_COMMAND_NAME = 'shared-channel-upgrade-case'
export const UPGRADE_USAGE = [
  `usage: ${UPGRADE_COMMAND_NAME} materialize --case <name> --root <dir> --state-dir <dir> --home <dir>`,
  '         [--setting <key>=<value>]... [--persona-prefix <prefix>]',
  `       ${UPGRADE_COMMAND_NAME} reference-0.18.0 --out <dir> --mode declarative|fungible --name <name>`,
  '         --credentials-file <path> --working-directory <path> [--channel <id>=all|mentions]...',
  '         [--permission-prompts dm|<id>] [--invited-permission-prompts dm|<id>] [--dm-enabled] [--dm-contact <user>]',
  '         [--setting <key>=<value>]...',
].join('\n')

class UsageError extends Error {}
function parseFlags(argv: readonly string[], valued: readonly string[], repeated: readonly string[], bare: readonly string[]): { values: Map<string, string[]>; set: Set<string> } {
  const values = new Map<string, string[]>()
  const set = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (bare.includes(flag)) { set.add(flag); continue }
    if (!valued.includes(flag) && !repeated.includes(flag)) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`)
    const value = argv[++i]
    if (value === undefined) throw new UsageError(`${flag} needs a value`)
    const list = values.get(flag) ?? []
    if (list.length > 0 && !repeated.includes(flag)) throw new UsageError(`${flag} given twice`)
    values.set(flag, [...list, value])
  }
  return { values, set }
}
function one(flags: { values: Map<string, string[]> }, flag: string, required = true): string | undefined {
  const v = flags.values.get(flag)?.[0]
  if (v === undefined && required) throw new UsageError(`${flag} is required`)
  return v
}
function scalar(value: string): UpgradeSettingValue {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}
/** Every `--setting <key>=<value>`, in order; a later key replaces an earlier one. */
function settingsOf(flags: { values: Map<string, string[]> }): Record<string, UpgradeSettingValue> {
  const settings: Record<string, UpgradeSettingValue> = {}
  for (const spec of flags.values.get('--setting') ?? []) {
    const at = spec.indexOf('=')
    if (at <= 0) throw new UsageError(`--setting ${JSON.stringify(spec)} is not <key>=<value>`)
    settings[spec.slice(0, at)] = scalar(spec.slice(at + 1))
  }
  return settings
}

/**
 * Run one command; prints `<name> <value>` lines through `out`. Returns the
 * exit code: 0 done, 1 FAIL, 64 usage. The image entry calls this after its guard.
 */
export function runUpgradeCaseCommand(argv: readonly string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error, fixtureDir = UPGRADE_FIXTURE_DIR): number {
  const [command, ...rest] = argv
  try {
    if (command === 'materialize') {
      const flags = parseFlags(rest, ['--case', '--root', '--state-dir', '--home', '--persona-prefix'], ['--setting'], [])
      const done = materializeUpgradeCase({
        fixtureDir, caseName: one(flags, '--case')!, root: one(flags, '--root')!, stateDir: one(flags, '--state-dir')!, home: one(flags, '--home')!,
        settings: settingsOf(flags), personaPrefix: one(flags, '--persona-prefix', false),
      })
      out(`case ${done.caseName}`)
      out(`state_dir ${done.stateDir}`)
      out(`case_root ${done.caseRoot}`)
      out(`reference_dir ${done.dirs.reference}`)
      out(`baselines_dir ${done.dirs.baseline}`)
      out(`pending_dir ${done.dirs.pending}`)
      out(`default_baseline ${done.defaultBaseline}`)
      out(`chosen_baseline ${done.chosenBaseline}`)
      for (const p of done.personas) out(`persona ${p.manifestName} ${p.name}`)
      for (const c of done.credentials) out(`credentials ${c.persona} ${c.path}`)
      for (const w of done.workdirs) out(`workdir ${w.persona} ${w.path}`)
      out(`files ${done.written.length}`)
      return 0
    }
    if (command === 'reference-0.18.0') {
      const flags = parseFlags(rest,
        ['--out', '--mode', '--name', '--credentials-file', '--working-directory', '--permission-prompts', '--invited-permission-prompts', '--dm-contact'],
        ['--channel', '--setting'], ['--dm-enabled'])
      const mode = one(flags, '--mode')!
      if (mode !== 'declarative' && mode !== 'fungible') throw new UsageError('--mode is declarative or fungible')
      const channels = (flags.values.get('--channel') ?? []).map(spec => {
        const [id, delivery, extra] = spec.split('=')
        if (!id || extra !== undefined || (delivery !== 'all' && delivery !== 'mentions')) throw new UsageError(`--channel ${JSON.stringify(spec)} is not <id>=all|mentions`)
        return { id, delivery } as const
      })
      const settings = settingsOf(flags)
      const persona: OldPersona018 = { name: one(flags, '--name')!, credentials_file: one(flags, '--credentials-file')!, working_directory: one(flags, '--working-directory')! }
      if (channels.length) persona.channels = channels
      const contact = one(flags, '--dm-contact', false)
      if (flags.set.has('--dm-enabled') || contact !== undefined) persona.dm = { enabled: flags.set.has('--dm-enabled'), ...(contact === undefined ? {} : { contact }) }
      const destination = one(flags, '--permission-prompts', false)
      if (destination !== undefined) persona.permission_prompts = destination
      const invited = one(flags, '--invited-permission-prompts', false)
      if (invited !== undefined) persona.invited = { permission_prompts: invited }
      const paths = writeOldReference018({ out: one(flags, '--out')!, mode, persona, settings })
      out(`config ${paths.config}`)
      out(`last_applied ${paths.lastApplied}`)
      return 0
    }
    throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${JSON.stringify(command)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof UsageError) { err(`${UPGRADE_COMMAND_NAME}: ${message}`); err(UPGRADE_USAGE); return 64 }
    err(`FAIL: ${UPGRADE_COMMAND_NAME}: ${message}`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// Case data
// ---------------------------------------------------------------------------

/** Channel IDs beyond shared-channels.ts SHARED_CHANNEL_IDS, named by their role in the cases. */
export const UPGRADE_CHANNEL_IDS = {
  conflictOlderStore: 'C0UPGCONFA', conflictNewerStore: 'C0UPGCONFB', retired: 'C0UPGRETIRE', silenced: 'C0UPGOFF',
  absent: 'C0UPGABSENT', external: 'C0UPGEXTERNAL', added: 'C0UPGADDED',
} as const
export const UPGRADE_DM_CONTACTS = { alpha: 'U0UPGALPHA', bravo: 'U0UPGBRAVO' } as const
const HUMAN = 'U0UPGHUMAN'
const QUEUE_PERSONA_NOTE = 'holds the queued work; its bot is not up at the first start, so the queue waits for it'
/** Dates the cases use: 0.18.0 applied, its later edit, the last stored choice, the queue, the preparation. */
const DATES = {
  applied: '2026-05-20T10:00:00.000Z', edited: '2026-05-22T16:30:00.000Z', storeWritten: '2026-05-25T09:00:00.000Z',
  queued: '2026-05-26T08:15:00.000Z', prepared: '2026-06-01T12:00:00.000Z',
} as const
const ms = (iso: string): number => Date.parse(iso)

interface CaseFile { path: string; bytes: Buffer; meta: Omit<UpgradeManifestFile, 'path'> }
interface BuiltCase { manifest: UpgradeManifestCase; files: CaseFile[]; queues: { persona: string; records: QueueRecord[] }[] }

type Builders = Awaited<ReturnType<typeof loadBuilders>>
async function loadBuilders() {
  const personaConfig = await import('./persona-config.ts')
  const queue = await import('./delivery-queue.ts')
  const shared = await import('./shared-channels.ts')
  const identity = await import('../../src/persona-identity.ts')
  return { ...personaConfig, ...queue, SHARED_CHANNEL_IDS: shared.SHARED_CHANNEL_IDS, configBytes: shared.configBytes, personaKey: identity.personaKey }
}

const paths = (name: string) => ({ credentials_file: `~/personas/${name}/credentials.json`, working_directory: `~/personas/${name}/work` })

class CaseWriter {
  readonly files: CaseFile[] = []
  constructor(readonly caseName: string) {}
  add(group: UpgradeGroup, rel: string, bytes: Buffer, meta: Omit<UpgradeManifestFile, 'path' | 'group' | 'targets' | 'home_relative' | 'condition'> & { targets?: UpgradeManifestFile['targets']; condition?: FileCondition; home_relative?: boolean }): void {
    const variantDir = group === 'reference' ? '' : `${meta.variant}/`
    const committed = `${this.caseName}/${UPGRADE_GROUP_DIRS[group]}/${variantDir}${rel}`
    const targets = meta.targets ?? [{ to: group, path: `${variantDir}${rel}` }]
    this.files.push({ path: committed, bytes, meta: { ...meta, group, targets, condition: meta.condition ?? 'valid', home_relative: meta.home_relative ?? false } })
  }
  /** A baseline variant's config.json (and its applied baseline when `lastApplied` is given). */
  baseline(variant: string, isDefault: boolean, config: Buffer, lastApplied: Buffer | undefined, condition: FileCondition, about: string): void {
    const state = (name: string) => isDefault ? [{ to: 'state' as const, path: name }] : []
    this.add('baseline', 'config.json', config, { variant, mtime: DATES.prepared, condition, about,
      targets: [{ to: 'baseline', path: `${variant}/config.json` }, ...state('config.json')] })
    if (lastApplied) this.add('baseline', 'config.json.last-applied', lastApplied, { variant, mtime: DATES.prepared, condition, about: `applied baseline for ${variant}`,
      targets: [{ to: 'baseline', path: `${variant}/config.json.last-applied` }, ...state('config.json.last-applied')] })
  }
}

/** The current-format channel list a persona's choices produce, in row order. */
function chosenChannels(rows: readonly UpgradeChannelRow[], persona: string): { id: string; delivery: DeliveryMode }[] {
  return rows.filter(r => r.persona === persona && r.choice.action !== 'retire')
    .map(r => ({ id: r.channel, delivery: (r.choice as { delivery: DeliveryMode }).delivery }))
}
/** The 0.18.0 configuration's channel list for a persona, in row order. */
function oldChannels(rows: readonly UpgradeChannelRow[], persona: string): { id: string; delivery: 'all' | 'mentions' }[] {
  return rows.filter(r => r.persona === persona && r.old_config).map(r => ({ id: r.channel, delivery: r.old_config!.delivery }))
}
function oldStore(rows: readonly UpgradeChannelRow[], persona: string): OldStoredChoice018['channels'] {
  const out: OldStoredChoice018['channels'] = {}
  for (const r of rows) if (r.persona === persona && r.old_stored_choice) out[r.channel] = { ...r.old_stored_choice }
  return out
}
const declaration = (name: string) => ({ name, ...paths(name) })

function queueSummary(persona: string, records: readonly QueueRecord[], about: string): UpgradeQueueSummary {
  const delivered = new Set(records.flatMap(r => r.kind === 'delivered' ? [r.seq] : []))
  const items = records.flatMap(r => r.kind === 'accepted' && !('compact' in r)
    ? [{ seq: r.seq, source: r.source, ...(r.via === undefined ? {} : { via: r.via }), ...(r.queued_ack_reaction === undefined ? {} : { queued_ack_reaction: r.queued_ack_reaction }),
      ...(r.reminder_for === undefined ? {} : { reminder_for: r.reminder_for }), delivered: delivered.has(r.seq) }]
    : [])
  const reminders = new Map<number, string>()
  for (const r of records) if (r.kind === 'reply-reminder') reminders.set(r.seq, r.state)
  return { persona, path: `queue/${persona}.jsonl`, about, items, reply_reminders: [...reminders].map(([seq, state]) => ({ seq, state })) }
}

/** Case 1: a 0.18.0 declarative install with a pending change, conflicts, a retired channel and queued work, prepared for strict. */
function declarativeCase(b: Builders): BuiltCase {
  const ids = { ...b.SHARED_CHANNEL_IDS, ...UPGRADE_CHANNEL_IDS }
  const w = new CaseWriter('declarative-choices-and-queues')
  const channels: UpgradeChannelRow[] = [
    { persona: 'alpha', channel: ids.primary, kind: 'matching', old_config: { delivery: 'all', section: 'channels', inactive: false }, old_stored_choice: { delivery: 'all', set_at: '2026-05-14T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: 'both old sources say all' },
    { persona: 'alpha', channel: ids.secondary, kind: 'config-only', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, choice: { action: 'transfer', delivery: 'mentions' }, note: 'only the old configuration names it' },
    { persona: 'alpha', channel: ids.private, kind: 'stored-choice-only', old_stored_choice: { delivery: 'all', set_at: '2026-05-15T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: 'a private channel only the stored-choice file names; strict makes it active' },
    { persona: 'alpha', channel: ids.conflictOlderStore, kind: 'conflict', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, old_stored_choice: { delivery: 'all', set_at: '2026-05-12T09:00:00Z' }, newer_source: 'config', choice: { action: 'choose', delivery: 'all' }, note: 'the operator picks the older stored choice over the newer configuration' },
    { persona: 'alpha', channel: ids.retired, kind: 'retired', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, choice: { action: 'retire' }, note: 'left out of the new baseline' },
    { persona: 'bravo', channel: ids.conflictNewerStore, kind: 'conflict', old_config: { delivery: 'all', section: 'channels', inactive: false }, old_stored_choice: { delivery: 'mentions', set_at: '2026-05-25T09:00:00Z' }, newer_source: 'stored_choice', choice: { action: 'choose', delivery: 'all' }, note: 'the operator picks the older configuration over the newer stored choice' },
    { persona: 'bravo', channel: ids.primary, kind: 'stored-choice-only', old_stored_choice: { delivery: 'all', set_at: '2026-05-16T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: "a channel that is alpha's permission destination" },
    { persona: 'bravo', channel: ids.secondary, kind: 'new-value', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, choice: { action: 'new', delivery: 'thread_hybrid' }, note: 'a value 0.18.0 had no form for' },
    { persona: 'bravo', channel: ids.silenced, kind: 'explicit-off', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, choice: { action: 'new', delivery: 'off' }, note: '0.18.0 had no off; the operator writes an explicit off entry, which must stay' },
  ]
  const destinations: UpgradeDestinationRow[] = [
    { persona: 'alpha', old_declarative: ids.primary, old_invited: ids.primary, old_active: 'declarative', chosen: ids.primary, note: 'old destinations are identical' },
    { persona: 'bravo', old_declarative: ids.conflictNewerStore, old_invited: 'dm', old_active: 'declarative', chosen: ids.conflictNewerStore, note: 'old destinations differ; the inactive invited one was an explicit DM' },
  ]
  const oldApplied: OldConfig018 = {
    personas: [
      { name: 'alpha', ...paths('alpha'), channels: oldChannels(channels, 'alpha'), dm: { enabled: false }, permission_prompts: ids.primary, invited: { permission_prompts: ids.primary } },
      { name: 'bravo', ...paths('bravo'), channels: oldChannels(channels, 'bravo'), dm: { enabled: true, contact: UPGRADE_DM_CONTACTS.bravo }, permission_prompts: ids.conflictNewerStore, invited: { permission_prompts: 'dm' } },
    ],
    stop_timeout: 30,
  }
  const appliedBytes = oldConfigBytes018(oldApplied)
  const [oldAlpha, oldBravo] = oldApplied.personas as [OldPersona018, OldPersona018]
  const oldEdited: OldConfig018 = {
    personas: [
      { ...oldAlpha, channels: [...oldAlpha.channels!, { id: ids.added, delivery: 'mentions' }] },
      { ...oldBravo, credentials_file: '~/personas/bravo/rotated-credentials.json' },
    ],
    stop_timeout: 45,
    allow_invited_channels: true,
  }
  const editedBytes = oldConfigBytes018(oldEdited)
  const preview = [
    oldPreview018.header({ added: 0, removed: 0, destructive: 1, inPlace: 0, credentials: 0, settings: 2 }),
    oldPreview018.destructive('bravo', 'bravo', 'credentials_file', '~/personas/bravo/rotated-credentials.json'),
    oldPreview018.recorded('alpha', 'alpha', 'channels', 'declarative', 'declarative'),
    oldPreview018.cliRecordSetting('stop_timeout'),
    oldPreview018.modeSwitch('fungible', [{ name: 'alpha', key: 'alpha' }, { name: 'bravo', key: 'bravo' }]),
  ]
  w.add('reference', 'config.json', editedBytes, { mtime: DATES.edited, about: '0.18.0 config.json with an edit not yet applied: alpha adds a channel, bravo moves its credentials, stop_timeout and allow_invited_channels change' })
  w.add('reference', 'config.json.last-applied', appliedBytes, { mtime: DATES.applied, about: '0.18.0 applied baseline: declarative mode, formerly inactive invited sections, stop_timeout 30' })
  w.add('reference', 'config.json.pending', oldPendingFileBytes018(editedBytes, preview), { mtime: DATES.edited, home_relative: true, about: '0.18.0 pending preview for config.json; its fingerprint covers the config bytes only (no credentials entries)' })
  w.add('reference', 'channel-delivery.json', oldStoredChoiceBytes018({
    alpha: { declaration: declaration('alpha'), channels: oldStore(channels, 'alpha') },
    bravo: { declaration: declaration('bravo'), channels: oldStore(channels, 'bravo') },
  }), { mtime: DATES.storeWritten, home_relative: true, targets: [{ to: 'reference', path: 'channel-delivery.json' }, { to: 'state', path: 'channel-delivery.json' }], about: '0.18.0 stored choices, left in place in the state dir' })

  const t0 = ms(DATES.queued)
  const at = (minutes: number) => t0 + minutes * 60_000
  const records: QueueRecord[] = [
    b.acceptedRecord(1, b.slackInput({ text: 'Morning report:\n- build green\n- deploy at 10', channel: ids.primary, user: HUMAN, key: { chat_id: ids.primary, ts: '1779783300.000100' }, ts: '1779783300.000100', via: 'all', queued_ack_reaction: 'hourglass_flowing_sand' }), at(0)),
    b.fixedRecord(1, ['Morning report:\n- build green\n- deploy at 10']),
    b.sentRecord(1),
    b.deliveredRecord(1, at(1)),
    { v: 1, kind: 'reply-reminder', seq: 1, at: at(2), delivered_at: at(1), state: 'observed', row_state: 'waiting', session_id: 'session', delivery_attempts: [1] } satisfies ReplyReminderRecord,
    b.acceptedRecord(2, b.injectedInput({ sender: 'reply-reminder', text: 'Reminder: answer the morning report in Slack.', ts: '1779783600.000000', reminder_for: 1 }), at(5)),
    { v: 1, kind: 'reply-reminder', seq: 1, at: at(5), delivered_at: at(1), state: 'nudged', row_state: 'waiting', session_id: 'session', delivery_attempts: [1] } satisfies ReplyReminderRecord,
    b.acceptedRecord(3, b.slackInput({ text: 'Grüße aus Köln — 日本語のテキスト ✓\n🐝 second line', channel: ids.secondary, user: HUMAN, key: { chat_id: ids.secondary, ts: '1779783900.000200' }, ts: '1779783900.000200', via: 'mention', queued_ack_reaction: 'hourglass_flowing_sand' }), at(10)),
    b.acceptedRecord(4, b.slackInput({ text: 'Line one\r\nLine two\n\n  indented', channel: ids.private, channel_type: 'group', user: HUMAN, key: { chat_id: ids.private, ts: '1779784200.000300' }, ts: '1779784200.000300', via: 'all', queued_ack_reaction: 'beehive' }), at(15)),
  ]
  w.add('reference', 'queue/alpha.jsonl', oldQueueBytes018(records), { mtime: DATES.queued, targets: [{ to: 'reference', path: 'queue/alpha.jsonl' }, { to: 'state', path: 'queue/alpha.jsonl' }],
    about: 'alpha journal, left in place: one delivered item with its reply reminder, the injected reminder, two open Slack items with multi-line and Unicode text' })

  const persona = (name: 'alpha' | 'bravo', overrides: Partial<PersonaInput>): PersonaInput =>
    b.makePersona({ name, ...paths(name), channels: chosenChannels(channels, name), ...overrides }, '~')
  const chosenInput = (extra: Partial<PersonaConfigInput> = {}, personas?: PersonaInput[]): PersonaConfigInput => ({
    channel_mode: 'strict', stop_timeout: 30,
    personas: personas ?? [
      persona('alpha', { dm: { enabled: false }, permission_prompts: ids.primary }),
      persona('bravo', { dm: { enabled: true, contact: UPGRADE_DM_CONTACTS.bravo }, permission_prompts: ids.conflictNewerStore }),
    ],
    ...extra,
  })
  const chosen = b.configBytes(chosenInput())
  w.baseline('prepared', true, chosen, chosen, 'valid', 'strict baseline holding every choice in this case')
  const [alpha, bravo] = chosenInput().personas as [PersonaInput, PersonaInput]
  const edits: [string, string, PersonaConfigInput, string[]][] = [
    ['channel-edit', 'alpha adds the channel the 0.18.0 edit added', chosenInput({}, [{ ...alpha, channels: [...alpha.channels!, { id: ids.added, delivery: 'mentions' }] }, bravo]), ['personas[alpha].channels']],
    ['mode-edit', 'switch to open, the counterpart of the 0.18.0 allow_invited_channels edit', chosenInput({ channel_mode: 'open' }), ['channel_mode']],
    ['credentials-location-edit', "bravo's credentials move, as in the 0.18.0 edit", chosenInput({}, [alpha, { ...bravo, credentials_file: '~/personas/bravo/rotated-credentials.json' }]), ['personas[bravo].credentials_file']],
    ['unrelated-edit', 'stop_timeout changes, as in the 0.18.0 edit', chosenInput({ stop_timeout: 45 }), ['stop_timeout']],
  ]
  for (const [name, about, input] of edits) w.add('pending', 'config.json', b.configBytes(input), { variant: name, mtime: DATES.prepared, about })

  return {
    files: w.files,
    queues: [{ persona: 'alpha', records }],
    manifest: {
      name: w.caseName,
      summary: 'A 0.18.0 declarative install with an unapplied edit and its preview, matching, one-source, conflicting (both date directions), retired, explicit-off and thread_hybrid channels, and queued work, prepared for strict.',
      starting_mode: '0.18.0 declarative', new_mode: 'strict',
      ac_rows: ['AC-U01', 'AC-U02', 'AC-U03', 'AC-U06', 'AC-U07', 'AC-U08', 'AC-U09', 'AC-U11'],
      personas: [
        { name: 'alpha', key: 'alpha', ...paths('alpha'), note: QUEUE_PERSONA_NOTE },
        { name: 'bravo', key: 'bravo', ...paths('bravo'), note: 'credentials_file moves only in the credentials-location edit' },
      ],
      channels, identities: [], destinations,
      baselines: [{ name: 'prepared', default: true, chosen: true, about: 'every choice in this case, strict', expect: { loads: true, channel_mode: 'strict' } }],
      pending_edits: edits.map(([name, about, , changes]) => ({ name, about, changes })),
      queues: [queueSummary('alpha', records, 'in place in the state dir; open items 2, 3 and 4 keep their text, via and emoji; item 2 carries the reminder link to delivered item 1')],
      credentials: [
        { persona: 'alpha', path: paths('alpha').credentials_file, note: 'needed before the first start' },
        { persona: 'bravo', path: paths('bravo').credentials_file, note: 'needed before the first start' },
        { persona: 'bravo', path: '~/personas/bravo/rotated-credentials.json', note: 'needed once the credentials-location edit is put back' },
      ],
      files: [],
    },
  }
}

/** Case 2: a 0.18.0 fungible install with inactive sections, unknown and shared channels, stale identities and an implicit DM, prepared for open. */
function fungibleCase(b: Builders): BuiltCase {
  const ids = { ...b.SHARED_CHANNEL_IDS, ...UPGRADE_CHANNEL_IDS }
  const w = new CaseWriter('fungible-choices-and-destinations')
  const channels: UpgradeChannelRow[] = [
    { persona: 'alpha', channel: ids.primary, kind: 'matching', old_config: { delivery: 'all', section: 'channels', inactive: true }, old_stored_choice: { delivery: 'all', set_at: '2026-05-10T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: 'the inactive declarative section and the stored choice agree' },
    { persona: 'alpha', channel: ids.secondary, kind: 'conflict', old_config: { delivery: 'mentions', section: 'channels', inactive: true }, old_stored_choice: { delivery: 'all', set_at: '2026-05-24T09:00:00Z' }, newer_source: 'stored_choice', choice: { action: 'choose', delivery: 'mentions' }, note: 'the operator picks the inactive section over the newer stored choice' },
    { persona: 'alpha', channel: ids.private, kind: 'stored-choice-only', old_stored_choice: { delivery: 'mentions', set_at: '2026-05-11T09:00:00Z' }, choice: { action: 'transfer', delivery: 'mentions' }, note: 'a private channel' },
    { persona: 'alpha', channel: ids.absent, kind: 'unknown-target', old_stored_choice: { delivery: 'all', set_at: '2026-05-12T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: 'Slack does not know this channel or the bot is not in it; preparation checks no membership' },
    { persona: 'alpha', channel: ids.external, kind: 'externally-shared', old_stored_choice: { delivery: 'all', set_at: '2026-05-13T09:00:00Z' }, choice: { action: 'transfer', delivery: 'all' }, note: 'an externally shared channel' },
  ]
  const identities: UpgradeIdentityRow[] = [
    { key: 'bravo', name: 'bravo', old: 'stored choices under a declaration naming ~/personas/bravo/previous-work, which no longer matches the persona', disposition: 'retire', note: 'mismatched identity; its stored choice is not carried over' },
    { key: 'charlie', name: 'charlie', old: 'stored choices for a persona the configuration no longer has', disposition: 'retire', note: 'inactive identity' },
  ]
  const destinations: UpgradeDestinationRow[] = [
    { persona: 'alpha', old_declarative: ids.secondary, old_invited: ids.primary, old_active: 'invited', chosen: ids.primary, note: 'old destinations differ' },
    { persona: 'bravo', old_active: 'invited', chosen: 'dm', note: 'formerly an implicit DM (no invited section); now permission_prompts "dm" with dm.enabled and dm.contact' },
  ]
  const old: OldConfig018 = {
    personas: [
      { name: 'alpha', ...paths('alpha'), channels: oldChannels(channels, 'alpha'), dm: { enabled: false }, permission_prompts: ids.secondary, invited: { permission_prompts: ids.primary } },
      { name: 'bravo', ...paths('bravo'), dm: { enabled: true, contact: UPGRADE_DM_CONTACTS.bravo } },
    ],
    allow_invited_channels: true,
  }
  const oldBytes = oldConfigBytes018(old)
  w.add('reference', 'config.json', oldBytes, { mtime: DATES.applied, about: '0.18.0 config.json, fungible, no pending change' })
  w.add('reference', 'config.json.last-applied', oldBytes, { mtime: DATES.applied, about: '0.18.0 applied baseline, byte copy of config.json' })
  w.add('reference', 'channel-delivery.json', oldStoredChoiceBytes018({
    alpha: { declaration: declaration('alpha'), channels: oldStore(channels, 'alpha') },
    bravo: { declaration: { ...declaration('bravo'), working_directory: '~/personas/bravo/previous-work' }, channels: { [ids.primary]: { delivery: 'mentions', set_at: '2026-05-15T09:00:00Z' } } },
    charlie: { declaration: declaration('charlie'), channels: { [ids.secondary]: { delivery: 'all', set_at: '2026-05-09T09:00:00Z' } } },
  }), { mtime: DATES.storeWritten, home_relative: true, targets: [{ to: 'reference', path: 'channel-delivery.json' }, { to: 'state', path: 'channel-delivery.json' }], about: '0.18.0 stored choices with a mismatched and an inactive identity, left in place' })

  const input: PersonaConfigInput = {
    channel_mode: 'open',
    personas: [
      b.makePersona({ name: 'alpha', ...paths('alpha'), channels: chosenChannels(channels, 'alpha'), dm: { enabled: false }, permission_prompts: ids.primary }, '~'),
      b.makePersona({ name: 'bravo', ...paths('bravo'), channels: [], dm: { enabled: true, contact: UPGRADE_DM_CONTACTS.bravo }, permission_prompts: 'dm' }, '~'),
    ],
  }
  const bytes = b.configBytes(input)
  w.baseline('prepared', true, bytes, bytes, 'valid', 'open baseline holding every choice in this case')
  return {
    files: w.files, queues: [],
    manifest: {
      name: w.caseName,
      summary: 'A 0.18.0 fungible install: inactive declarative channels, a conflict, store-only, unknown and externally shared channels, mismatched and inactive identities, differing destinations and an implicit DM, prepared for open.',
      starting_mode: '0.18.0 fungible', new_mode: 'open',
      ac_rows: ['AC-U01', 'AC-U02', 'AC-U03', 'AC-U04', 'AC-U06', 'AC-U11'],
      personas: [
        { name: 'alpha', key: 'alpha', ...paths('alpha') },
        { name: 'bravo', key: 'bravo', ...paths('bravo'), note: 'no channels; permission prompts by DM' },
      ],
      channels, identities, destinations,
      baselines: [{ name: 'prepared', default: true, chosen: true, about: 'every choice in this case, open', expect: { loads: true, channel_mode: 'open' } }],
      pending_edits: [], queues: [],
      credentials: [
        { persona: 'alpha', path: paths('alpha').credentials_file, note: 'needed before the first start' },
        { persona: 'bravo', path: paths('bravo').credentials_file, note: 'needed before the first start' },
      ],
      files: [],
    },
  }
}

/** Case 3: an interrupted preparation, invalid new inputs, damaged old files, then the corrected baseline. */
function interruptedCase(b: Builders): BuiltCase {
  const ids = { ...b.SHARED_CHANNEL_IDS, ...UPGRADE_CHANNEL_IDS }
  const w = new CaseWriter('interrupted-and-invalid-preparation')
  const channels: UpgradeChannelRow[] = [
    { persona: 'alpha', channel: ids.primary, kind: 'config-only', old_config: { delivery: 'all', section: 'channels', inactive: false }, choice: { action: 'transfer', delivery: 'all' }, note: '' },
    { persona: 'alpha', channel: ids.secondary, kind: 'config-only', old_config: { delivery: 'mentions', section: 'channels', inactive: false }, choice: { action: 'transfer', delivery: 'mentions' }, note: '' },
    { persona: 'alpha', channel: ids.private, kind: 'stored-choice-only', old_stored_choice: { delivery: 'mentions', set_at: '2026-05-18T09:00:00Z' }, choice: { action: 'transfer', delivery: 'mentions' }, note: '' },
  ]
  const old: OldConfig018 = { personas: [{ name: 'alpha', ...paths('alpha'), channels: oldChannels(channels, 'alpha'), dm: { enabled: false }, permission_prompts: ids.primary, invited: { permission_prompts: ids.primary } }] }
  const oldBytes = oldConfigBytes018(old)
  const store = oldStoredChoiceBytes018({ alpha: { declaration: declaration('alpha'), channels: oldStore(channels, 'alpha') } })
  w.add('reference', 'config.json', oldBytes, { mtime: DATES.applied, about: '0.18.0 config.json, declarative, no pending change' })
  w.add('reference', 'config.json.last-applied', oldBytes, { mtime: DATES.applied, about: '0.18.0 applied baseline, byte copy of config.json' })
  w.add('reference', 'channel-delivery.json', store, { mtime: DATES.storeWritten, home_relative: true, about: '0.18.0 stored choices, valid' })
  const storeText = store.toString('utf8')
  w.add('reference', 'damaged/channel-delivery.truncated.json', store.subarray(0, Math.floor(store.length / 2)), { mtime: DATES.storeWritten, condition: 'malformed', home_relative: true,
    targets: [{ to: 'reference', path: 'damaged/channel-delivery.truncated.json' }, { to: 'state', path: 'channel-delivery.json' }], about: 'the valid stored-choice file cut in half; left in place as the state dir channel-delivery.json' })
  w.add('reference', 'damaged/channel-delivery.version-2.json', Buffer.from(storeText.replace('"version": 1', '"version": 2')), { mtime: DATES.storeWritten, condition: 'invalid', home_relative: true, about: 'the valid stored-choice file with version 2' })
  w.add('reference', 'damaged/channel-delivery.unreadable.json', store, { mtime: DATES.storeWritten, condition: 'unreadable', mode: '0000', home_relative: true, about: 'the valid stored-choice file with mode 0000' })
  w.add('reference', 'damaged/config.json.last-applied.truncated', oldBytes.subarray(0, Math.floor(oldBytes.length / 2)), { mtime: DATES.applied, condition: 'malformed', about: 'the 0.18.0 applied baseline cut in half' })

  const t0 = ms(DATES.queued)
  const records: QueueRecord[] = [
    b.acceptedRecord(1, b.slackInput({ text: 'Queued before the upgrade:\nplease keep me', channel: ids.primary, user: HUMAN, key: { chat_id: ids.primary, ts: '1779783300.000400' }, ts: '1779783300.000400', via: 'all', queued_ack_reaction: 'hourglass_flowing_sand' }), t0),
    b.acceptedRecord(2, b.slackInput({ text: 'Ünïcödé mention — 中文 ✓', channel: ids.secondary, user: HUMAN, key: { chat_id: ids.secondary, ts: '1779783360.000500' }, ts: '1779783360.000500', via: 'mention', queued_ack_reaction: 'hourglass_flowing_sand' }), t0 + 60_000),
  ]
  w.add('reference', 'queue/alpha.jsonl', oldQueueBytes018(records), { mtime: DATES.queued, targets: [{ to: 'reference', path: 'queue/alpha.jsonl' }, { to: 'state', path: 'queue/alpha.jsonl' }], about: 'alpha journal with two open items, left in place' })

  const persona = (overrides: Partial<PersonaInput>): PersonaInput =>
    b.makePersona({ name: 'alpha', ...paths('alpha'), channels: chosenChannels(channels, 'alpha'), dm: { enabled: false }, permission_prompts: ids.primary, ...overrides }, '~')
  const configOf = (p: PersonaInput) => b.configBytes({ channel_mode: 'strict', personas: [p] })
  const corrected = configOf(persona({}))
  const missing = persona({})
  delete (missing as Partial<PersonaInput>).permission_prompts
  const badValue = persona({ channels: [{ id: ids.primary, delivery: 'all' }, { id: ids.secondary, delivery: 'none' as DeliveryMode }, { id: ids.private, delivery: 'mentions' }] })
  w.baseline('interrupted', true, corrected, oldBytes, 'refused', 'a new config.json beside the 0.18.0 applied baseline the operator did not replace')
  w.baseline('bad-value', false, configOf(badValue), undefined, 'invalid', 'a delivery value no release has')
  w.baseline('missing-destination', false, configOf(missing), undefined, 'invalid', 'no permission_prompts')
  w.baseline('invalid-destination', false, configOf(persona({ permission_prompts: ids.retired })), undefined, 'invalid', 'permission_prompts names a channel the persona does not list')
  w.baseline('dm-destination-incomplete', false, configOf(persona({ dm: { enabled: true }, permission_prompts: 'dm' })), undefined, 'invalid', 'permission_prompts "dm" with no dm.contact')
  w.baseline('corrected', false, corrected, corrected, 'valid', 'the corrected baseline: config.json and its applied baseline')
  return {
    files: w.files, queues: [{ persona: 'alpha', records }],
    manifest: {
      name: w.caseName,
      summary: 'A preparation left half done (new config.json, old applied baseline), invalid new inputs and damaged old files, then the corrected baseline; queued work survives every refused start.',
      starting_mode: '0.18.0 declarative', new_mode: 'strict',
      ac_rows: ['AC-U05', 'AC-U06', 'AC-U07', 'AC-U09'],
      personas: [{ name: 'alpha', key: 'alpha', ...paths('alpha'), note: QUEUE_PERSONA_NOTE }],
      channels, identities: [],
      destinations: [{ persona: 'alpha', old_declarative: ids.primary, old_invited: ids.primary, old_active: 'declarative', chosen: ids.primary, note: '' }],
      baselines: [
        { name: 'interrupted', default: true, chosen: false, about: 'refused: the applied baseline is still 0.18.0', expect: { loads: false, fails_in: 'config.json.last-applied', names: ['invited', 'permission_prompts'] } },
        { name: 'bad-value', default: false, chosen: false, about: 'refused', expect: { loads: false, fails_in: 'config.json', names: ['channels[1].delivery'] } },
        { name: 'missing-destination', default: false, chosen: false, about: 'refused', expect: { loads: false, fails_in: 'config.json', names: ['permission_prompts'] } },
        { name: 'invalid-destination', default: false, chosen: false, about: 'refused', expect: { loads: false, fails_in: 'config.json', names: ['permission_prompts', ids.retired] } },
        { name: 'dm-destination-incomplete', default: false, chosen: false, about: 'refused', expect: { loads: false, fails_in: 'config.json', names: ['dm.contact'] } },
        { name: 'corrected', default: false, chosen: true, about: 'starts', expect: { loads: true, channel_mode: 'strict' } },
      ],
      pending_edits: [],
      queues: [queueSummary('alpha', records, 'in place; both items stay queued through every refused start')],
      credentials: [{ persona: 'alpha', path: paths('alpha').credentials_file, note: 'needed before the first start' }],
      files: [],
    },
  }
}

/** Case 4: removed keys alone, beside their replacements, in formerly inactive sections and in the applied baseline; channel_mode values. */
function removedKeysCase(b: Builders): BuiltCase {
  const ids = b.SHARED_CHANNEL_IDS
  const w = new CaseWriter('removed-key-rejection')
  const base = (): PersonaInput => b.makePersona({ name: 'alpha', ...paths('alpha'), channels: [{ id: ids.primary, delivery: 'all' }], dm: { enabled: false }, permission_prompts: ids.primary }, '~')
  const raw = (input: Record<string, unknown>) => Buffer.from(JSON.stringify(input, null, 2) + '\n')
  const withoutDestination = (): Record<string, unknown> => { const p: Record<string, unknown> = { ...base() }; delete p.permission_prompts; return p }
  const valid = b.configBytes({ channel_mode: 'strict', personas: [base()] })
  const variants: [string, Buffer, Buffer | undefined, BaselineExpectation, string][] = [
    ['allow-invited-only', raw({ allow_invited_channels: true, personas: [base()] }), undefined, { loads: false, fails_in: 'config.json', names: ['allow_invited_channels', 'channel_mode'] }, 'the removed switch alone'],
    ['allow-invited-beside-channel-mode', raw({ allow_invited_channels: false, channel_mode: 'strict', personas: [base()] }), undefined, { loads: false, fails_in: 'config.json', names: ['allow_invited_channels', 'channel_mode'] }, 'the removed switch beside its replacement'],
    ['invited-only', raw({ channel_mode: 'open', personas: [{ ...withoutDestination(), invited: { permission_prompts: ids.primary } }] }), undefined, { loads: false, fails_in: 'config.json', names: ['invited', 'permission_prompts'] }, 'the removed section alone'],
    ['invited-beside-permission-prompts', raw({ channel_mode: 'open', personas: [{ ...base(), invited: { permission_prompts: ids.primary } }] }), undefined, { loads: false, fails_in: 'config.json', names: ['invited', 'permission_prompts'] }, 'the removed section beside its replacement'],
    ['invited-in-formerly-inactive-section', raw({ channel_mode: 'strict', personas: [{ ...base(), invited: { permission_prompts: 'dm' } }] }), undefined, { loads: false, fails_in: 'config.json', names: ['invited', 'permission_prompts'] }, 'an invited section 0.18.0 declarative mode never read'],
    ['removed-key-in-applied-baseline', valid, raw({ allow_invited_channels: false, channel_mode: 'strict', personas: [base()] }), { loads: false, fails_in: 'config.json.last-applied', names: ['allow_invited_channels', 'channel_mode'] }, 'a valid config.json; its applied baseline still holds the removed switch'],
    ['channel-mode-invalid', raw({ channel_mode: 'fungible', personas: [base()] }), undefined, { loads: false, fails_in: 'config.json', names: ['channel_mode'] }, 'an old mode name as channel_mode'],
    ['channel-mode-omitted', b.configBytes({ personas: [base()] }), b.configBytes({ personas: [base()] }), { loads: true, channel_mode: 'strict' }, 'no channel_mode: strict'],
  ]
  variants.forEach(([name, config, applied, expect, about], i) => w.baseline(name, i === 0, config, applied, expect.loads ? 'valid' : 'refused', about))
  return {
    files: w.files, queues: [],
    manifest: {
      name: w.caseName,
      summary: 'Removed keys alone, beside their replacements, in a formerly inactive section and in the applied baseline; an invalid and an omitted channel_mode.',
      starting_mode: 'no old files', new_mode: 'strict',
      ac_rows: ['AC-U05', 'AC-U07', 'AC-U13'],
      personas: [{ name: 'alpha', key: 'alpha', ...paths('alpha') }],
      channels: [], identities: [], destinations: [],
      baselines: variants.map(([name, , , expect, about], i) => ({ name, default: i === 0, chosen: name === 'channel-mode-omitted', about, expect })),
      pending_edits: [], queues: [],
      credentials: [{ persona: 'alpha', path: paths('alpha').credentials_file, note: 'needed before the first start' }],
      files: [],
    },
  }
}

/** Case 5: a fresh start with no old files: zero personas, and a persona with an empty channel inventory. */
function freshCase(b: Builders): BuiltCase {
  const w = new CaseWriter('fresh-start')
  const zero = b.configBytes({ channel_mode: 'strict', personas: [] })
  const empty = b.configBytes({ channel_mode: 'strict', personas: [b.makePersona({ name: 'alpha', ...paths('alpha'), channels: [], dm: { enabled: true, contact: UPGRADE_DM_CONTACTS.alpha }, permission_prompts: 'dm' }, '~')] })
  w.baseline('zero-personas', true, zero, zero, 'valid', 'no personas')
  w.baseline('empty-inventory', false, empty, empty, 'valid', 'one persona, no channels, prompts by DM')
  return {
    files: w.files, queues: [],
    manifest: {
      name: w.caseName,
      summary: 'No old files: a zero-persona baseline and an empty channel inventory; neither creates Thread Memory or the shared authority before the first start.',
      starting_mode: 'no old files', new_mode: 'strict',
      ac_rows: ['AC-U12'],
      personas: [{ name: 'alpha', key: 'alpha', ...paths('alpha'), note: 'only in empty-inventory' }],
      channels: [], identities: [],
      destinations: [{ persona: 'alpha', old_active: 'none', chosen: 'dm', note: 'empty-inventory only' }],
      baselines: [
        { name: 'zero-personas', default: true, chosen: false, about: 'loads', expect: { loads: true, channel_mode: 'strict' } },
        { name: 'empty-inventory', default: false, chosen: true, about: 'loads', expect: { loads: true, channel_mode: 'strict' } },
      ],
      pending_edits: [], queues: [],
      credentials: [{ persona: 'alpha', path: paths('alpha').credentials_file, note: 'empty-inventory only' }],
      files: [],
    },
  }
}

/** Every case, built in memory: manifest entries (with files), committed bytes and queue records. */
export async function buildUpgradeCases(): Promise<{ manifest: UpgradeManifest; files: Map<string, Buffer>; queues: Map<string, { persona: string; records: QueueRecord[] }[]> }> {
  const b = await loadBuilders()
  const built = [declarativeCase(b), fungibleCase(b), interruptedCase(b), removedKeysCase(b), freshCase(b)]
  const files = new Map<string, Buffer>()
  const queues = new Map<string, { persona: string; records: QueueRecord[] }[]>()
  for (const c of built) {
    for (const p of c.manifest.personas) if (b.personaKey(p.name) !== p.key) throw new Error(`persona key for ${p.name} is ${b.personaKey(p.name)}`)
    for (const f of c.files) {
      if (files.has(f.path)) throw new Error(`duplicate fixture path ${f.path}`)
      files.set(f.path, f.bytes)
      c.manifest.files.push({ path: f.path, ...f.meta })
    }
    queues.set(c.manifest.name, c.queues)
  }
  const manifest: UpgradeManifest = {
    format: UPGRADE_MANIFEST_FORMAT, version: UPGRADE_MANIFEST_VERSION, old_release: OLD_RELEASE,
    about: 'Manual-upgrade cases (b.tad SR-8.1, SR-8.2). Generated by tests/test-helpers/shared-channel-upgrade.ts; do not edit. Each case lists its operator choices; files[] says where the materializer writes each file.',
    cases: built.map(c => c.manifest),
  }
  return { manifest, files, queues }
}

/** The manifest's bytes as the generator writes them. */
export const manifestBytes = (manifest: UpgradeManifest): Buffer => Buffer.from(JSON.stringify(manifest, null, 2) + '\n')

/** The `write` command's pass to rewrite the committed tree; not exported, so no test can hold it. */
const WRITE_COMMAND = Symbol('shared-channel-upgrade write')

/** True when `target` is the committed fixture directory, holds it or lies under it. */
function touchesCommittedTree(target: string): boolean {
  const committed = realOrResolved(UPGRADE_FIXTURE_DIR), real = realOrResolved(target)
  return real === committed || strictlyUnder(real, committed) || strictlyUnder(committed, real)
}

/**
 * Rewrite `dir` with every case's files and the manifest. Returns the written
 * paths relative to `dir`, sorted. `dir` must pass `guardScratchDir` and stay
 * clear of the committed tree, wherever the repo lives; only the `write`
 * command, holding `WRITE_COMMAND`, rewrites the committed tree itself.
 */
export async function writeUpgradeFixtures(dir: string, pass?: symbol): Promise<string[]> {
  const target = resolve(dir)
  const committed = pass === WRITE_COMMAND && target === UPGRADE_FIXTURE_DIR
  if (!committed && touchesCommittedTree(target)) throw new Error('fixture directory refused: it is, holds or lies under the committed fixture tree; only the write command rewrites it')
  if (!committed) guardScratchDir(target, 'fixture directory')
  const { manifest, files } = await buildUpgradeCases()
  rmSync(target, { recursive: true, force: true })
  for (const [rel, bytes] of files) {
    mkdirSync(dirname(join(target, rel)), { recursive: true })
    writeFileSync(join(target, rel), bytes)
  }
  writeFileSync(join(target, UPGRADE_MANIFEST_FILE), manifestBytes(manifest))
  return [...files.keys(), UPGRADE_MANIFEST_FILE].sort()
}

/** Every file under `dir`, relative and sorted, with `/` separators. */
export function listFixtureFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child)
      else out.push(child)
    }
  }
  walk('')
  return out.sort()
}

if (import.meta.main) {
  if (process.argv[2] !== 'write' || process.argv.length !== 3) {
    console.error('usage: bun tests/test-helpers/shared-channel-upgrade.ts write')
    process.exit(64)
  }
  const written = await writeUpgradeFixtures(UPGRADE_FIXTURE_DIR, WRITE_COMMAND)
  console.log(`wrote ${written.length} files under ${relative(process.cwd(), UPGRADE_FIXTURE_DIR).split(sep).join('/')}`)
}
