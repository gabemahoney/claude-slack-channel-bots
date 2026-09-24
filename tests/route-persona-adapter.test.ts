/**
 * route-persona-adapter.test.ts — Pins the TRANSITIONAL route→persona adapter
 * (b.av2 E3, removed in E3 Task 9 together with src/route-persona-adapter.ts).
 *
 * Until the persona loader switch, every persona-keyed consumer sees these
 * stand-ins, so the invariant pinned here is key = channel ID: `cscb_<key>`,
 * `slack_bot_<key>`, the restart and outage keys and `CLAUDE_MANAGED_CHANNEL`
 * stay byte-identical to the channel-keyed forms.
 *
 * Never imports src/server.ts. All paths sit under a per-test mkdtempSync dir.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  type Persona,
  type RouteEntry,
  type RoutingConfig,
} from '../src/config.ts'
import {
  personaInstanceId,
  personaSpawnEnv,
  personaTmuxSessionName,
} from '../src/persona-identity.ts'
import { routesToPersonaConfig, STAND_IN_CREDENTIALS_FILE } from '../src/route-persona-adapter.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cscb-route-persona-adapter-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A route config whose every path sits under the test's temp dir. */
function makeConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  return makeRoutingConfig({
    routes: { C0AAA1111: { cwd: join(tmp, 'work-a') } },
    mcp_config_path: join(tmp, 'mcp.json'),
    cron_table_path: join(tmp, 'crontab'),
    cron_log_path: join(tmp, 'cron.log'),
    ...overrides,
  })
}

/** What a stand-in for one route must look like, in route order. */
function expectedStandIn(
  index: number,
  channelId: string,
  cwd: string,
  claudeConfigDir: string | undefined,
  stopHookBootstrap: boolean,
): Persona {
  return {
    index,
    name: channelId,
    key: channelId,
    credentials_file: STAND_IN_CREDENTIALS_FILE,
    working_directory: cwd,
    channels: [{ id: channelId, delivery: 'all' }],
    dm: { enabled: false },
    permission_prompts: channelId,
    ...(claudeConfigDir !== undefined ? { claude_config_dir: claudeConfigDir } : {}),
    stop_hook_bootstrap: stopHookBootstrap,
  }
}

// ---------------------------------------------------------------------------
// One stand-in persona per route
// ---------------------------------------------------------------------------

interface RouteShape {
  id: string
  /** Per-route claude_config_dir, as a name under the temp dir. */
  configDir?: string
  stopHook?: boolean
  /** Expected effective claude_config_dir (name under the temp dir), or undefined for absent. */
  wantConfigDir?: string
  wantStopHook: boolean
}

interface ShapeRow {
  label: string
  /** Top-level claude_config_dir, as a name under the temp dir. */
  topConfigDir?: string
  topStopHook: boolean
  routes: RouteShape[]
}

const SHAPES: ShapeRow[] = [
  {
    label: 'no routes -> no personas',
    topStopHook: true,
    routes: [],
  },
  {
    label: 'one route, nothing configured -> claude_config_dir absent',
    topStopHook: true,
    routes: [{ id: 'C0AAA1111', wantStopHook: true }],
  },
  {
    label: 'two routes: per-route values win, the other inherits the top level',
    topConfigDir: 'cfg-top',
    topStopHook: true,
    routes: [
      { id: 'C0AAA1111', configDir: 'cfg-a', stopHook: false, wantConfigDir: 'cfg-a', wantStopHook: false },
      { id: 'C0BBB2222', wantConfigDir: 'cfg-top', wantStopHook: true },
    ],
  },
  {
    label: 'per-route claude_config_dir with no top level; the other route has none',
    topStopHook: false,
    routes: [
      { id: 'C0BBB2222', wantStopHook: false },
      { id: 'C0AAA1111', configDir: 'cfg-a', stopHook: true, wantConfigDir: 'cfg-a', wantStopHook: true },
    ],
  },
]

describe('routesToPersonaConfig: one stand-in persona per route', () => {
  test.each(SHAPES)('$label', (row) => {
    const routes: Record<string, RouteEntry> = {}
    for (const r of row.routes) {
      routes[r.id] = {
        cwd: join(tmp, `work-${r.id}`),
        ...(r.configDir !== undefined ? { claude_config_dir: join(tmp, r.configDir) } : {}),
        ...(r.stopHook !== undefined ? { stop_hook_bootstrap: r.stopHook } : {}),
      }
    }
    const config = makeConfig({
      routes,
      stop_hook_bootstrap: row.topStopHook,
      ...(row.topConfigDir !== undefined ? { claude_config_dir: join(tmp, row.topConfigDir) } : {}),
    })

    const personas = routesToPersonaConfig(config).personas

    // toStrictEqual: an unset claude_config_dir must be absent, not `undefined`.
    expect(personas).toStrictEqual(
      row.routes.map((r, i) =>
        expectedStandIn(
          i,
          r.id,
          join(tmp, `work-${r.id}`),
          r.wantConfigDir !== undefined ? join(tmp, r.wantConfigDir) : undefined,
          r.wantStopHook,
        ),
      ),
    )
    for (const [i, r] of row.routes.entries()) {
      expect('claude_config_dir' in personas[i]!).toBe(r.wantConfigDir !== undefined)
    }
  })
})

// ---------------------------------------------------------------------------
// Server-wide settings
// ---------------------------------------------------------------------------

describe('routesToPersonaConfig: server-wide settings', () => {
  test('carries every server-wide setting over; persona-only settings take the defaults and no ack reaction', () => {
    const config = makeConfig({
      bind: '0.0.0.0',
      port: 4242,
      session_restart_delay: 7,
      health_check_interval: 9,
      exit_timeout: 11,
      stop_timeout: 13,
      append_system_prompt_file: join(tmp, 'prompt.md'),
      cozempic_prescription: 'aggressive',
      system_prompt_mode: 'replace',
      message_archive_db: join(tmp, 'archive.db'),
      claude_config_dir: join(tmp, 'cfg-top'),
      resume_enabled: false,
      stop_hook_bootstrap: false,
      agent_director_poll_interval_ms: 1500,
      cron_log_max_bytes: 2048,
      default_route: join(tmp, 'work-a'),
      default_dm_session: join(tmp, 'work-a'),
    })

    const { personas, reply_chunk_limit, reply_chunk_mode, ...settings } = routesToPersonaConfig(config)
    const { routes: _routes, default_route: _dr, default_dm_session: _dm, ...expectedSettings } = config

    expect(settings).toStrictEqual(expectedSettings)
    expect(personas).toHaveLength(1)
    expect(reply_chunk_limit).toBe(DEFAULT_REPLY_CHUNK_LIMIT)
    expect(reply_chunk_mode).toBe(DEFAULT_REPLY_CHUNK_MODE)
    expect('ack_reaction' in settings).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Identity invariant: key = channel ID
// ---------------------------------------------------------------------------

describe('routesToPersonaConfig: stand-in identity equals the channel-keyed identity', () => {
  test('instance ID, tmux name and spawn env of a stand-in are keyed by the channel ID', () => {
    const channelId = 'C0AAA1111'
    const config = makeConfig({
      routes: { [channelId]: { cwd: join(tmp, 'work-a'), claude_config_dir: join(tmp, 'cfg-a') } },
    })
    const persona = routesToPersonaConfig(config).personas[0]!

    expect(personaInstanceId(persona.key)).toBe(`cscb_${channelId}`)
    expect(personaTmuxSessionName(persona.key)).toBe(`slack_bot_${channelId}`)
    const env = personaSpawnEnv({
      key: persona.key,
      crontablePath: config.cron_table_path,
      claudeConfigDir: persona.claude_config_dir,
    })
    expect(env['CSCB_PERSONA']).toBe(channelId)
    expect(env['CLAUDE_MANAGED_CHANNEL']).toBe(channelId)
  })
})

// ---------------------------------------------------------------------------
// Purity: no I/O
// ---------------------------------------------------------------------------

describe('routesToPersonaConfig: no I/O', () => {
  test('maps a config whose cwd and config dirs do not exist, creating nothing and leaving the input unchanged', () => {
    const cwd = join(tmp, 'missing-work')
    const routeConfigDir = join(tmp, 'missing-cfg-route')
    const topConfigDir = join(tmp, 'missing-cfg-top')
    const config = makeConfig({
      routes: {
        C0AAA1111: { cwd, claude_config_dir: routeConfigDir },
        C0BBB2222: { cwd: join(tmp, 'missing-work-b') },
      },
      claude_config_dir: topConfigDir,
    })
    const before = structuredClone(config)

    const personas = routesToPersonaConfig(config).personas

    expect(personas.map((p) => p.working_directory)).toEqual([cwd, join(tmp, 'missing-work-b')])
    expect(personas.map((p) => p.claude_config_dir)).toEqual([routeConfigDir, topConfigDir])
    expect(existsSync(cwd)).toBe(false)
    expect(existsSync(routeConfigDir)).toBe(false)
    expect(existsSync(topConfigDir)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
    expect(config).toStrictEqual(before)
  })
})
