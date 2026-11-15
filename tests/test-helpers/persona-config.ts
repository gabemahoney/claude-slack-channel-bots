/** Shared strict/open configuration builders. Paths stay below the caller-owned temporary root. */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
  DEFAULT_ACK_REACTION,
  DEFAULT_QUEUED_ACK_REACTION,
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  DM_DESTINATION,
  type ChannelEntry,
  type Persona,
  type PersonaConfig,
  type PersonaConfigInput,
  type PersonaInput,
} from '../../src/config.ts'
import { personaKey } from '../../src/persona-identity.ts'


const DEFAULT_NAME = 'test_bot'


const DEFAULT_CHANNEL_ID = 'C0TEST001'


const CONFIG_FILE_NAME = 'config.json'


function defaultPersonaPaths(name: unknown, baseDir: string): { credentials_file: string; working_directory: string } {
  const dir = join(baseDir, 'personas', personaKey(String(name)))
  return { credentials_file: join(dir, 'credentials.json'), working_directory: join(dir, 'work') }
}


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


export function makePersonaConfigInput(
  overrides: Partial<PersonaConfigInput> = {},
  baseDir: string = tmpdir(),
): PersonaConfigInput {
  const persona = makePersona({}, baseDir)
  return { personas: [persona], ...overrides }
}


export function makePersonaConfig(overrides: Partial<PersonaConfig> = {}, baseDir: string = tmpdir()): PersonaConfig {
  const input = makePersona({}, baseDir)
  const persona: Persona = {
    index: 0,
    name: input.name,
    key: personaKey(input.name),
    credentials_file: input.credentials_file,
    working_directory: input.working_directory,
    channels: input.channels ?? [],
    permission_prompts: input.permission_prompts,
    sections: { channels: input.channels, permission_prompts: input.permission_prompts },
    dm: { enabled: false },
    stop_hook_bootstrap: true,
    reaction_notices: true,
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
    fresh_system_prompt: true,
    resume_enabled: true,
    stop_hook_bootstrap: true,
    agent_director_poll_interval_ms: DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
    agent_director_call_timeout_ms: DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
    cron_table_path: join(baseDir, 'crontab'),
    cron_log_path: join(baseDir, 'cron.log'),
    queued_ack_reaction: DEFAULT_QUEUED_ACK_REACTION,
    ack_reaction: DEFAULT_ACK_REACTION,
    reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT,
    reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE,
    channel_mode: 'strict',
    ...overrides,
  }
}


export type PersonaSpec = Partial<Omit<Persona, 'index'>>


export function makeMultiPersonaConfig(
  specs: PersonaSpec[],
  baseDir: string,
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): PersonaConfig {
  const base = makePersonaConfig(overrides, baseDir)
  const personas: Persona[] = specs.map((spec, index) => {
    const name = spec.name ?? `${DEFAULT_NAME}_${index + 1}`
    const channels = spec.channels ?? [{ id: `C0TEST${String(index + 1).padStart(3, '0')}`, delivery: 'all' as const }]
    const permissionPrompts = 'permission_prompts' in spec ? spec.permission_prompts! : (channels[0]?.id ?? DM_DESTINATION)
    const claudeConfigDir = 'claude_config_dir' in spec ? spec.claude_config_dir : base.claude_config_dir
    const persona: Persona = {
      index,
      name,
      key: personaKey(name),
      ...defaultPersonaPaths(name, baseDir),
      channels,
      permission_prompts: permissionPrompts,
      sections: { channels: structuredClone(channels), permission_prompts: permissionPrompts },
      dm: { enabled: false },
      stop_hook_bootstrap: base.stop_hook_bootstrap,
      reaction_notices: true,
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


export function makeStandInPersonaConfig(
  personas: Record<string, PersonaSpec>,
  baseDir: string,
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): PersonaConfig {
  return makeMultiPersonaConfig(
    Object.entries(personas).map(([id, spec]): PersonaSpec => ({
      name: id,
      key: id,
      channels: [{ id, delivery: 'all' as const }], permission_prompts: id,
      ...spec,
    })),
    baseDir,
    overrides,
  )
}


export function writeConfigFile(dir: string, input: unknown): string {
  const path = join(dir, CONFIG_FILE_NAME)
  writeFileSync(path, JSON.stringify(input, null, 2), 'utf-8')
  return path
}
