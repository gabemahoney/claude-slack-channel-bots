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
 * Replaces tests/test-helpers/routing-config.ts once E3 removes the route
 * loader; until then both exist side by side.
 *
 * SPDX-License-Identifier: MIT
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
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
    cron_table_path: join(baseDir, 'crontab'),
    cron_log_path: join(baseDir, 'cron.log'),
    reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT,
    reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE,
    ...overrides,
  }
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
