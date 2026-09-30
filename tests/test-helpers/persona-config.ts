/**
 * test-helpers/persona-config.ts — Shared persona-configuration fixtures
 * (b.av2 SR-13.4).
 *
 * Builds persona configurations in file form (`PersonaInput`,
 * `PersonaConfigInput`) and resolved form (`PersonaConfig`), and writes a
 * file-form config into a caller-owned directory. The defaults load without
 * error through `loadPersonaConfig`.
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
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  type Persona,
  type PersonaConfig,
  type PersonaConfigInput,
  type PersonaInput,
} from '../../src/config.ts'
import { personaKey } from '../../src/persona-identity.ts'

/** Name of the default persona. */
const DEFAULT_NAME = 'test_bot'

/** Channel the default persona is in and sends permission prompts to. */
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
 * One persona entry in file form. Defaults: one `all` channel, prompts to that
 * channel, DMs off, paths under `baseDir` derived from the name. An override
 * set to `undefined` drops the key from the written JSON.
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
 * A whole configuration in file form: one default persona and no server-wide
 * settings unless overridden, so the cron paths default under the directory
 * the file is written to. Never holds `routes`, `default_route` or
 * `default_dm_session` unless a test adds them.
 */
export function makePersonaConfigInput(
  overrides: Partial<PersonaConfigInput> = {},
  baseDir: string = tmpdir(),
): PersonaConfigInput {
  return { personas: [makePersona({}, baseDir)], ...overrides }
}

/**
 * A resolved configuration, as `loadPersonaConfig` returns it for
 * `makePersonaConfigInput(…, baseDir)` written into `baseDir`, except that
 * `mcp_config_path` also sits under `baseDir` rather than a home directory.
 */
export function makePersonaConfig(overrides: Partial<PersonaConfig> = {}, baseDir: string = tmpdir()): PersonaConfig {
  const input = makePersona({}, baseDir)
  const persona: Persona = {
    index: 0,
    name: input.name,
    key: personaKey(input.name),
    credentials_file: input.credentials_file,
    working_directory: input.working_directory,
    channels: input.channels ?? [],
    dm: { enabled: false },
    permission_prompts: input.permission_prompts,
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
    ...overrides,
  }
}

/**
 * One persona in `makeMultiPersonaConfig`: any resolved `Persona` field except
 * `index` (always the list position). Omitted fields take the defaults
 * described on `makeMultiPersonaConfig`.
 */
export type PersonaSpec = Partial<Omit<Persona, 'index'>>

/**
 * A resolved configuration with one persona per entry of `specs`, in order,
 * and the server-wide settings of `makePersonaConfig(overrides, baseDir)`.
 * Unlike the loader it runs no validation, so a stand-in persona can set
 * `key` to a channel ID directly.
 *
 * Per-persona defaults, for the persona at position `i`:
 * - `name`: `test_bot_<i+1>`; `key`: `personaKey(name)`.
 * - `channels`: one `all` channel `C0TEST<i+1, three digits>` (distinct per
 *   persona); `permission_prompts`: the first channel's ID, or `dm` when the
 *   persona has no channels; `dm`: off.
 * - `credentials_file` / `working_directory`: `<baseDir>/personas/<personaKey(name)>/…`.
 *   Nothing is created on disk.
 * - `claude_config_dir`: inherited from `overrides.claude_config_dir` as the
 *   loader does; absent when neither is set. A spec that sets the key to
 *   `undefined` opts out of inheritance.
 * - `stop_hook_bootstrap`: inherited from the resolved top-level value.
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
  const personas: Persona[] = specs.map((spec, index) => {
    const name = spec.name ?? `${DEFAULT_NAME}_${index + 1}`
    const channels = spec.channels ?? [{ id: `C0TEST${String(index + 1).padStart(3, '0')}`, delivery: 'all' }]
    const claudeConfigDir = 'claude_config_dir' in spec ? spec.claude_config_dir : base.claude_config_dir
    const persona: Persona = {
      index,
      name,
      key: personaKey(name),
      ...defaultPersonaPaths(name, baseDir),
      channels,
      dm: { enabled: false },
      permission_prompts: channels[0]?.id ?? 'dm',
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
 * each named and keyed by its channel ID (the record key), in that one `all`
 * channel with permission prompts there and DMs off. The record value adds
 * or overrides further fields (`working_directory`, `claude_config_dir`, …);
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
  return makeMultiPersonaConfig(
    Object.entries(personas).map(([id, spec]) => ({
      name: id,
      key: id,
      channels: [{ id, delivery: 'all' as const }],
      permission_prompts: id,
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
