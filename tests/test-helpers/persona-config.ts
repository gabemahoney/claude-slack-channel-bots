/**
 * test-helpers/persona-config.ts — Shared persona-configuration fixtures
 * (b.av2 SR-13.4, b.deo SRI-1203).
 *
 * Builds persona configurations in file form (`PersonaInput`,
 * `PersonaConfigInput`) and resolved form (`PersonaConfig`), and writes a
 * file-form config into a caller-owned directory. The defaults load without
 * error through `loadPersonaConfig`.
 *
 * Channel modes (b.deo SRI-101, SRI-102): every builder takes the
 * `allow_invited_channels` switch through its server-wide overrides and the
 * `invited` section through its persona overrides or specs. The defaults keep
 * declarative mode (the switch absent in file form, `false` resolved) with no
 * `invited` key. The resolved builders fill `fungible_destination` and
 * `sections` from the values they set, as the loader does in the mode the
 * switch picks (`channelModeOf`): in fungible mode the resolved `channels` are
 * empty and `permission_prompts` undefined, and `fungible_destination` is
 * `invited.permission_prompts`, `dm` when that is absent.
 *
 * Isolation (b.av2 SR-13.2): every default path sits under a base directory,
 * the OS temp directory unless the caller passes its own `mkdtempSync`
 * directory, never under the real home. The helper deals only in paths: it
 * creates no credentials file or directory (E2's credentials helper writes
 * credentials files) and holds no token-like literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  channelModeOf,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  DM_DESTINATION,
  type ChannelEntry,
  type ChannelMode,
  type Persona,
  type PersonaConfig,
  type PersonaConfigInput,
  type PersonaInput,
  type PersonaInvitedInput,
} from '../../src/config.ts'
import { personaKey } from '../../src/persona-identity.ts'

/** Name of the default persona. */
const DEFAULT_NAME = 'test_bot'

/**
 * Channel the default persona is in and sends permission prompts to; in
 * fungible mode, the default persona's fungible destination.
 */
const DEFAULT_CHANNEL_ID = 'C0TEST001'

/** File name `writeConfigFile` gives the configuration inside its directory. */
const CONFIG_FILE_NAME = 'config.json'

/**
 * Default per-persona paths: `<baseDir>/personas/<key>/…`, so personas with
 * different names never share a `credentials_file` or `working_directory`.
 */
function defaultPersonaPaths(name: unknown, baseDir: string): { credentials_file: string; working_directory: string } {
  const dir = join(baseDir, 'personas', personaKey(String(name)))
  return { credentials_file: join(dir, 'credentials.json'), working_directory: join(dir, 'work') }
}

/**
 * The channel mode a configuration's switch picks, with an absent switch
 * resolved as the loader resolves it (b.deo SRI-101).
 */
function modeOf(allowInvitedChannels: boolean | undefined): ChannelMode {
  return channelModeOf({ allow_invited_channels: allowInvitedChannels ?? false })
}

/** The three section keys of a persona entry, as written. */
interface WrittenSections {
  channels?: ChannelEntry[]
  permission_prompts?: string
  invited?: PersonaInvitedInput
}

/**
 * A persona's resolved section fields, from its section keys as written, as
 * the loader resolves them in `mode` (b.deo SRI-102): declarative mode reads
 * `channels` and `permission_prompts`; fungible mode reads `invited` only.
 * `sections` holds the three values as written, each undefined when absent,
 * in objects of its own as the loader's are. No validation runs.
 */
function resolvedSections(
  written: WrittenSections,
  mode: ChannelMode,
): Pick<Persona, 'channels' | 'permission_prompts' | 'fungible_destination' | 'sections'> {
  const sections = {
    channels: written.channels?.map((entry) => ({ ...entry })),
    permission_prompts: written.permission_prompts,
    invited: written.invited,
  }
  if (mode === 'fungible') {
    return {
      channels: [],
      permission_prompts: undefined,
      fungible_destination: written.invited?.permission_prompts ?? DM_DESTINATION,
      sections,
    }
  }
  return {
    channels: written.channels ?? [],
    permission_prompts: written.permission_prompts,
    fungible_destination: undefined,
    sections,
  }
}

/**
 * One persona entry in file form, for declarative mode. Defaults: one `all`
 * channel, prompts to that channel, DMs off, no `invited`, paths under
 * `baseDir` derived from the name. An override set to `undefined` drops the
 * key from the written JSON; an `invited` override adds the fungible section.
 */
export function makePersona(overrides: Partial<PersonaInput> = {}, baseDir: string = tmpdir()): PersonaInput {
  const name = overrides.name ?? DEFAULT_NAME
  return {
    name,
    ...defaultPersonaPaths(name, baseDir),
    channels: [{ id: DEFAULT_CHANNEL_ID, delivery: 'all' }],
    dm: { enabled: false },
    permission_prompts: DEFAULT_CHANNEL_ID,
    ...overrides,
  }
}

/**
 * One persona entry in file form, for fungible mode (b.deo SRI-102,
 * SRI-1203): no `channels` and no top-level `permission_prompts`, a channel
 * ID as its fungible destination (`invited.permission_prompts`), DMs off, and
 * paths under `baseDir` derived from the name as `makePersona` derives them.
 * Written under a switch set to `true`, it loads. Overrides apply as for
 * `makePersona`.
 */
export function makeFungiblePersona(overrides: Partial<PersonaInput> = {}, baseDir: string = tmpdir()): PersonaInput {
  const name = overrides.name ?? DEFAULT_NAME
  return {
    name,
    ...defaultPersonaPaths(name, baseDir),
    dm: { enabled: false },
    invited: { permission_prompts: DEFAULT_CHANNEL_ID },
    ...overrides,
  }
}

/**
 * A whole configuration in file form: one default persona and no server-wide
 * settings unless overridden, so the cron paths default under the directory
 * the file is written to. The switch is absent unless overridden; with
 * `allow_invited_channels: true` the default persona is `makeFungiblePersona`'s,
 * else `makePersona`'s. Never holds `routes`, `default_route` or
 * `default_dm_session` unless a test adds them.
 */
export function makePersonaConfigInput(
  overrides: Partial<PersonaConfigInput> = {},
  baseDir: string = tmpdir(),
): PersonaConfigInput {
  const persona =
    modeOf(overrides.allow_invited_channels) === 'fungible' ? makeFungiblePersona({}, baseDir) : makePersona({}, baseDir)
  return { personas: [persona], ...overrides }
}

/**
 * A resolved configuration, as `loadPersonaConfig` returns it for
 * `makePersonaConfigInput(…, baseDir)` written into `baseDir`, except that
 * `mcp_config_path` also sits under `baseDir` rather than a home directory.
 * `allow_invited_channels` resolves to `false` unless overridden; the default
 * persona's `fungible_destination` and `sections` are filled for the mode the
 * resolved switch picks, as the loader fills them.
 */
export function makePersonaConfig(overrides: Partial<PersonaConfig> = {}, baseDir: string = tmpdir()): PersonaConfig {
  const mode = modeOf(overrides.allow_invited_channels)
  const input = mode === 'fungible' ? makeFungiblePersona({}, baseDir) : makePersona({}, baseDir)
  const persona: Persona = {
    index: 0,
    name: input.name,
    key: personaKey(input.name),
    credentials_file: input.credentials_file,
    working_directory: input.working_directory,
    ...resolvedSections(input, mode),
    dm: { enabled: false },
    stop_hook_bootstrap: true,
  }
  return {
    personas: [persona],
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: join(baseDir, 'slack-mcp.json'),
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    resume_enabled: true,
    stop_hook_bootstrap: true,
    agent_director_poll_interval_ms: DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
    agent_director_call_timeout_ms: DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
    cron_table_path: join(baseDir, 'crontab'),
    cron_log_path: join(baseDir, 'cron.log'),
    reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT,
    reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE,
    allow_invited_channels: false,
    ...overrides,
  }
}

/**
 * One persona in `makeMultiPersonaConfig`: any resolved `Persona` field except
 * `index` (always the list position), plus `invited`, the fungible section as
 * written (b.deo SRI-102). Omitted fields take the defaults described on
 * `makeMultiPersonaConfig`.
 */
export type PersonaSpec = Partial<Omit<Persona, 'index'>> & { invited?: PersonaInvitedInput }

/**
 * A resolved configuration with one persona per entry of `specs`, in order,
 * and the server-wide settings of `makePersonaConfig(overrides, baseDir)`.
 * Unlike the loader it runs no validation, so a stand-in persona can set
 * `key` to a channel ID directly.
 *
 * Per-persona defaults, for the persona at position `i`, in the channel mode
 * `overrides.allow_invited_channels` picks (declarative when absent):
 * - `name`: `test_bot_<i+1>`; `key`: `personaKey(name)`.
 * - Declarative mode: `channels`: one `all` channel `C0TEST<i+1, three
 *   digits>` (distinct per persona); `permission_prompts`: the first
 *   channel's ID, or `dm` when the persona has no channels;
 *   `fungible_destination`: undefined.
 * - Fungible mode (b.deo SRI-102): `channels` empty and `permission_prompts`
 *   undefined, as the loader leaves them, unless the spec sets them;
 *   `fungible_destination`: the spec's `invited.permission_prompts`, else
 *   `dm`.
 * - `sections`: the spec's `channels`, `permission_prompts` and `invited` as
 *   written, with the declarative defaults above counted as written in
 *   declarative mode; each undefined when absent.
 * - `dm`: off.
 * - `credentials_file` / `working_directory`: `<baseDir>/personas/<personaKey(name)>/…`.
 *   Nothing is created on disk.
 * - `claude_config_dir`: inherited from `overrides.claude_config_dir` as the
 *   loader does; absent when neither is set. A spec that sets the key to
 *   `undefined` opts out of inheritance.
 * - `stop_hook_bootstrap`: inherited from the resolved top-level value.
 * A spec's own `fungible_destination` or `sections` replaces the filled one.
 *
 * Throws when two personas share a name or a key, which the loader would reject.
 * Keys where one starts with the other (`dev`, `dev_2`), which the loader also
 * rejects, are allowed here, so a test of the server's own exact tmux targets
 * can build such a pair; so is the default `test_bot_1` beside `test_bot_10`.
 * Pass the test's own `mkdtempSync` directory as `baseDir`; there is no default,
 * so paths never land in the shared OS temp directory.
 */
export function makeMultiPersonaConfig(
  specs: PersonaSpec[],
  baseDir: string,
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): PersonaConfig {
  const base = makePersonaConfig(overrides, baseDir)
  const mode = modeOf(base.allow_invited_channels)
  const personas: Persona[] = specs.map(({ invited, ...spec }, index) => {
    const name = spec.name ?? `${DEFAULT_NAME}_${index + 1}`
    let written: WrittenSections
    if (mode === 'fungible') {
      written = { channels: spec.channels, permission_prompts: spec.permission_prompts, invited }
    } else {
      const channels = spec.channels ?? [{ id: `C0TEST${String(index + 1).padStart(3, '0')}`, delivery: 'all' }]
      const permissionPrompts = 'permission_prompts' in spec ? spec.permission_prompts : (channels[0]?.id ?? DM_DESTINATION)
      written = { channels, permission_prompts: permissionPrompts, invited }
    }
    const claudeConfigDir = 'claude_config_dir' in spec ? spec.claude_config_dir : base.claude_config_dir
    const persona: Persona = {
      index,
      name,
      key: personaKey(name),
      ...defaultPersonaPaths(name, baseDir),
      ...resolvedSections(written, mode),
      dm: { enabled: false },
      stop_hook_bootstrap: base.stop_hook_bootstrap,
      ...spec,
    }
    if (claudeConfigDir !== undefined) persona.claude_config_dir = claudeConfigDir
    else delete persona.claude_config_dir
    return persona
  })
  for (const field of ['name', 'key'] as const) {
    const seen = new Set<string>()
    for (const p of personas) {
      if (seen.has(p[field])) throw new Error(`makeMultiPersonaConfig: duplicate persona ${field} ${JSON.stringify(p[field])}`)
      seen.add(p[field])
    }
  }
  return { ...base, personas }
}

/**
 * A resolved configuration of stand-in personas, each keyed by a channel ID:
 * one persona per entry of `personas`, in insertion order,
 * each named and keyed by its channel ID (the record key), with DMs off and
 * permission prompts sent to that channel: in declarative mode it is in that
 * one `all` channel with `permission_prompts` set to it; in fungible mode
 * (`overrides.allow_invited_channels: true`) it is the persona's
 * `invited.permission_prompts`. The record value adds or overrides further
 * fields (`working_directory`, `claude_config_dir`, `invited`, …);
 * everything else, including the server-wide `overrides`, is as for
 * `makeMultiPersonaConfig`. Channel IDs begin with a letter, so the record
 * keeps insertion order.
 *
 * Pass the test's own `mkdtempSync` directory as `baseDir`; there is no default.
 */
export function makeStandInPersonaConfig(
  personas: Record<string, PersonaSpec>,
  baseDir: string,
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): PersonaConfig {
  const fungible = modeOf(overrides.allow_invited_channels) === 'fungible'
  return makeMultiPersonaConfig(
    Object.entries(personas).map(([id, spec]): PersonaSpec => ({
      name: id,
      key: id,
      ...(fungible
        ? { invited: { permission_prompts: id } }
        : { channels: [{ id, delivery: 'all' as const }], permission_prompts: id }),
      ...spec,
    })),
    baseDir,
    overrides,
  )
}

/**
 * Write `input` as JSON to `<dir>/config.json` and return that path. `dir`
 * must be the caller's own temp directory; there is no default location.
 * Typed `unknown` so tests can write deliberately invalid shapes.
 */
export function writeConfigFile(dir: string, input: unknown): string {
  const path = join(dir, CONFIG_FILE_NAME)
  writeFileSync(path, JSON.stringify(input, null, 2), 'utf-8')
  return path
}
