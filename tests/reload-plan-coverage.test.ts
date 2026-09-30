/**
 * reload-plan-coverage.test.ts — Every key the loader accepts has a place in
 * the change plan (b.av2 SR-8.4, SR-8.6).
 *
 * `src/reload-plan.ts` hand-lists the persona settings it compares in three
 * classes (`DESTRUCTIVE_SETTINGS`, `IN_PLACE_SETTINGS`,
 * `NEXT_LAUNCH_SETTINGS`), and compares server-wide settings by reading each
 * top-level key off the resolved config by name. A persona field the lists
 * leave out, or a top-level key the resolved config carries under another
 * name, would never be compared: an edit of it would read `no effective
 * change` and the apply would treat it as a no-op. These tests hold the
 * loader's key lists (`PERSONA_ENTRY_KEYS`, `PERSONA_DM_KEYS`,
 * `CHANNEL_ENTRY_KEYS`, `PERSONA_TOP_LEVEL_KEYS` in src/config.ts) against
 * the plan, so adding a key to the loader fails here until the plan
 * classifies it.
 *
 * The wording of each class's preview line is pinned in
 * tests/reload-preview.test.ts; this file asserts only which class and which
 * setting name a change lands in. Configs are resolved from file-form JSON
 * with `parsePersonaConfigBytes`, which reads no file; every path sits under
 * a `mkdtempSync` root and nothing is written to it.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHANNEL_ENTRY_KEYS,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  parsePersonaConfigBytes,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
  type PersonaConfig,
  type PersonaConfigInput,
} from '../src/config.ts'
import {
  buildChangePlan,
  DESTRUCTIVE_SETTINGS,
  IN_PLACE_SETTINGS,
  NEXT_LAUNCH_SETTINGS,
  type ValidChangePlan,
} from '../src/reload-plan.ts'
import { makePersona } from './test-helpers/persona-config.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reload-plan-coverage-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The loader's top-level keys other than `personas`: the server-wide settings. */
const SERVER_WIDE_KEYS = PERSONA_TOP_LEVEL_KEYS.filter((key) => key !== 'personas')

/** The plan's persona setting classes, by name. */
const CLASSES: Record<string, readonly string[]> = {
  DESTRUCTIVE_SETTINGS,
  IN_PLACE_SETTINGS,
  NEXT_LAUNCH_SETTINGS,
}

/**
 * The plan setting each channel-entry key is compared as: a channel's `id`
 * is membership in the persona's channel set (`channels`), its `delivery` a
 * kept channel's mode (`delivery`).
 */
const CHANNEL_FIELD_SETTING: Record<string, string> = { id: 'channels', delivery: 'delivery' }

/**
 * Persona fields that no plan class compares on purpose: a change to one is
 * rightly `no effective change`. Empty today (`name` is destructive).
 */
const UNCOMPARED_PERSONA_FIELDS: readonly string[] = []

/**
 * Every leaf field of a persona entry, named as the plan names its setting:
 * a top-level entry key as itself, a `dm` key as `dm.<key>` and a channel
 * key through `CHANNEL_FIELD_SETTING` (`channels[].<key>` when unmapped, so
 * it matches no class).
 */
function personaLeafSettings(): string[] {
  return PERSONA_ENTRY_KEYS.flatMap((key): string[] => {
    if (key === 'dm') return PERSONA_DM_KEYS.map((k) => `dm.${k}`)
    if (key === 'channels') return CHANNEL_ENTRY_KEYS.map((k) => CHANNEL_FIELD_SETTING[k] ?? `channels[].${k}`)
    return [key]
  })
}

describe('every persona field the loader accepts is classified', () => {
  // When this fails after a key was added to PERSONA_ENTRY_KEYS,
  // PERSONA_DM_KEYS or CHANNEL_ENTRY_KEYS: decide what an edit of the new
  // field does to a running persona (SR-8.6) and add it to exactly one of
  // DESTRUCTIVE_SETTINGS (instance torn down and brought up),
  // IN_PLACE_SETTINGS (applied in place, with its comparison in
  // inPlaceChanges) or NEXT_LAUNCH_SETTINGS (takes effect at the next
  // launch), then give it a preview line in tests/reload-preview.test.ts. A
  // new channel-entry key also needs its entry in CHANNEL_FIELD_SETTING. Only
  // a field whose change genuinely has no effect goes in
  // UNCOMPARED_PERSONA_FIELDS. When it fails after a class list gained or
  // lost a name, the list and the loader disagree: fix whichever is wrong.
  test('the entry, dm and channel keys map exactly onto the three setting classes', () => {
    const classified = Object.values(CLASSES).flat()
    expect([...personaLeafSettings()].sort()).toEqual([...classified, ...UNCOMPARED_PERSONA_FIELDS].sort())
  })

  test('no setting is in two classes', () => {
    const all = [...Object.values(CLASSES).flat(), ...UNCOMPARED_PERSONA_FIELDS]
    expect(all.filter((setting, i) => all.indexOf(setting) !== i)).toEqual([])
  })
})

describe('every top-level key the loader accepts is compared', () => {
  // A top-level key is a persona default when a persona entry accepts it too:
  // the persona inherits it when its entry omits it. When this fails, a key
  // both levels accept is missing from NEXT_LAUNCH_SETTINGS (whose members
  // the plan treats as inherited defaults), or a next-launch setting lost its
  // top-level form: fix the loader's lists or the class.
  test('the persona defaults are exactly the next-launch settings, and each is a top-level key', () => {
    const entryKeys = new Set<string>(PERSONA_ENTRY_KEYS)
    const defaults = PERSONA_TOP_LEVEL_KEYS.filter((key) => entryKeys.has(key))
    expect([...defaults].sort()).toEqual([...NEXT_LAUNCH_SETTINGS].sort())
  })

  /** The one persona both configurations hold; it sets no default of its own. */
  function input(top: Record<string, unknown> = {}): PersonaConfigInput {
    const alpha = makePersona(
      { name: 'alpha', channels: [{ id: 'C0A0001', delivery: 'all' }], permission_prompts: 'C0A0001' },
      root,
    )
    return { personas: [alpha], ...top }
  }

  function parse(file: PersonaConfigInput): PersonaConfig {
    return parsePersonaConfigBytes(JSON.stringify(file), join(root, 'config.json'), root, { home: join(root, 'home') })
  }

  function plan(top: Record<string, unknown>): ValidChangePlan {
    const result = buildChangePlan(parse(input()), { kind: 'valid', config: parse(input(top)) }, {
      realPath: (p) => p,
      home: join(root, 'home'),
    })
    if (!result.valid) throw new Error(result.error)
    return result
  }

  /**
   * A valid value differing from the default for every server-wide key. When
   * the key-set test below fails after a key was added to the loader's
   * top-level list, add a row here; the per-key test then shows whether the
   * plan compares it under its own name.
   */
  const CHANGED_VALUES = (): Record<string, unknown> => ({
    bind: '0.0.0.0',
    port: 3200,
    session_restart_delay: 61,
    health_check_interval: 121,
    exit_timeout: 121,
    stop_timeout: 31,
    mcp_config_path: join(root, 'other-mcp.json'),
    append_system_prompt_file: join(root, 'prompt.md'),
    cozempic_prescription: 'gentle',
    system_prompt_mode: 'none',
    message_archive_db: join(root, 'archive.db'),
    claude_config_dir: join(root, 'claude-default'),
    resume_enabled: false,
    agent_director_poll_interval_ms: 2000,
    // In range: the default plus the lower bound stays well under the upper.
    agent_director_call_timeout_ms: DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS + MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
    stop_hook_bootstrap: false,
    cron_table_path: join(root, 'other-crontab'),
    cron_log_path: join(root, 'other-cron.log'),
    cron_log_max_bytes: 1024,
    ack_reaction: 'eyes',
    reply_chunk_limit: 2000,
    reply_chunk_mode: 'length',
  })

  test('every server-wide key has a changed value to try', () => {
    expect(Object.keys(CHANGED_VALUES()).sort()).toEqual([...SERVER_WIDE_KEYS].sort())
  })

  // When this fails for a key: the plan reads each server-wide setting off
  // the resolved config by its top-level name, so the resolver
  // (resolvePersonaConfig in src/config.ts) must carry the key under that
  // name, and the plan's comparison must see the change.
  test.each(SERVER_WIDE_KEYS)('changing only %s is one changed setting', (key) => {
    const result = plan({ [key]: CHANGED_VALUES()[key] })

    const inherited = (NEXT_LAUNCH_SETTINGS as readonly string[]).includes(key)
    expect(result.settings).toEqual([
      inherited ? { name: key, inheritedBy: [{ key: 'alpha', name: 'alpha', index: 0 }] } : { name: key },
    ])
    expect(result.noEffectiveChange).toBe(false)
  })
})
