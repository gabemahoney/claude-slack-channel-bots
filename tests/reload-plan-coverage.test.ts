/**
 * reload-plan-coverage.test.ts — Every key the loader accepts has a place in
 * the change plan (b.av2 SR-8.4, SR-8.6; b.deo SRI-101, SRI-802, SRI-803).
 *
 * `src/reload-plan.ts` hand-lists the persona settings it compares in three
 * classes (`DESTRUCTIVE_SETTINGS`, `IN_PLACE_SETTINGS`,
 * `NEXT_LAUNCH_SETTINGS`), and compares server-wide settings by reading each
 * top-level key off the resolved config by name. A persona field the lists
 * leave out, or a top-level key the resolved config carries under another
 * name, would never be compared: an edit of it would read `no effective
 * change` and the apply would treat it as a no-op. These tests hold the
 * loader's key lists (`PERSONA_ENTRY_KEYS`, `PERSONA_DM_KEYS`,
 * `PERSONA_INVITED_KEYS`, `CHANNEL_ENTRY_KEYS`, `PERSONA_TOP_LEVEL_KEYS` in
 * src/config.ts) against the plan, so adding a key to the loader fails here
 * until the plan classifies it.
 *
 * The plan classifies a persona change by the candidate's section in force
 * (b.deo SRI-802): the rows below give each class a change lands in when
 * both configurations are in one mode, show that a change of the switch
 * alone, in each direction, modifies no persona, and that `false` written for
 * an absent switch is no change (SRI-101).
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
  channelModeOf,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  parsePersonaConfigBytes,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_INVITED_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
  type PersonaConfig,
  type PersonaConfigInput,
  type PersonaInput,
} from '../src/config.ts'
import {
  buildChangePlan,
  DESTRUCTIVE_SETTINGS,
  IN_PLACE_SETTINGS,
  MODE_SWITCH_SETTING,
  NEXT_LAUNCH_SETTINGS,
  RECORDED_SECTION_KEYS,
  type ServerSettingChange,
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

/**
 * The one persona both configurations hold, with `overrides` on its entry; it
 * sets no default of its own. It is valid in both channel modes, so a
 * candidate that changes only `allow_invited_channels` is valid: its channel
 * fungible destination needs no DMs, and declarative mode does not read it.
 */
function input(top: Record<string, unknown> = {}, overrides: Partial<PersonaInput> = {}): PersonaConfigInput {
  const alpha = makePersona(
    {
      name: 'alpha',
      channels: [{ id: 'C0A0001', delivery: 'all' }],
      permission_prompts: 'C0A0001',
      invited: { permission_prompts: 'C0A0001' },
      ...overrides,
    },
    root,
  )
  return { personas: [alpha], ...top }
}

function parse(file: PersonaConfigInput): PersonaConfig {
  return parsePersonaConfigBytes(JSON.stringify(file), join(root, 'config.json'), root, { home: join(root, 'home') })
}

/** The one persona, as the plan names it. */
const ALPHA_REF = { key: 'alpha', name: 'alpha', index: 0 }

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
 * a top-level entry key as itself, a `dm` key as `dm.<key>`, an `invited`
 * key as `invited.<key>` and a channel key through `CHANNEL_FIELD_SETTING`
 * (`channels[].<key>` when unmapped, so it matches no class).
 */
function personaLeafSettings(): string[] {
  return PERSONA_ENTRY_KEYS.flatMap((key): string[] => {
    if (key === 'dm') return PERSONA_DM_KEYS.map((k) => `dm.${k}`)
    if (key === 'invited') return PERSONA_INVITED_KEYS.map((k) => `invited.${k}`)
    if (key === 'channels') return CHANNEL_ENTRY_KEYS.map((k) => CHANNEL_FIELD_SETTING[k] ?? `channels[].${k}`)
    return [key]
  })
}

describe('every persona field the loader accepts is classified', () => {
  // When this fails after a key was added to PERSONA_ENTRY_KEYS,
  // PERSONA_DM_KEYS, PERSONA_INVITED_KEYS or CHANNEL_ENTRY_KEYS: decide what
  // an edit of the new field does to a running persona (b.av2 SR-8.6, b.deo
  // SRI-802) and add it to exactly one of
  // DESTRUCTIVE_SETTINGS (instance torn down and brought up),
  // IN_PLACE_SETTINGS (applied in place, with its comparison in
  // personaSectionChanges) or NEXT_LAUNCH_SETTINGS (takes effect at the next
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
    fresh_system_prompt: false,
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
    allow_invited_channels: true,
  })

  test('every server-wide key has a changed value to try', () => {
    expect(Object.keys(CHANGED_VALUES()).sort()).toEqual([...SERVER_WIDE_KEYS].sort())
  })

  /**
   * The setting entry a change of only `key` gives: an inherited default
   * names the persona that inherits it; the switch names the mode it turns
   * on and every persona present in both configurations (b.deo SRI-803).
   */
  function expectedSetting(key: string): ServerSettingChange {
    if ((NEXT_LAUNCH_SETTINGS as readonly string[]).includes(key)) return { name: key, inheritedBy: [ALPHA_REF] }
    if (key === MODE_SWITCH_SETTING) {
      // The mode the candidate's switch picks.
      const mode = channelModeOf(parse(input({ [key]: CHANGED_VALUES()[key] })))
      return { name: key, mode, personas: [ALPHA_REF] }
    }
    return { name: key }
  }

  // When this fails for a key: the plan reads each server-wide setting off
  // the resolved config by its top-level name, so the resolver
  // (resolvePersonaConfig in src/config.ts) must carry the key under that
  // name, and the plan's comparison must see the change.
  test.each(SERVER_WIDE_KEYS)('changing only %s is one changed setting', (key) => {
    const result = plan({ [key]: CHANGED_VALUES()[key] })

    expect(result.settings).toEqual([expectedSetting(key)])
    expect(result.noEffectiveChange).toBe(false)
  })
})

/** The plan of the `after` file-form config against the applied `before` one. */
function planBetween(before: PersonaConfigInput, after: PersonaConfigInput): ValidChangePlan {
  const result = buildChangePlan(parse(before), { kind: 'valid', config: parse(after) }, {
    realPath: (p) => p,
    home: join(root, 'home'),
  })
  if (!result.valid) throw new Error(result.error)
  return result
}

/** A plan's classes, by persona key: what each row below compares as a whole. */
interface Classes {
  added: string[]
  removed: string[]
  destructive: [string, readonly string[]][]
  inPlace: [string, readonly string[]][]
  /** Own next-launch settings. */
  nextLaunch: [string, readonly string[]][]
  recorded: [string, readonly string[]][]
  unchanged: string[]
  settings: ServerSettingChange[]
  noEffectiveChange: boolean
}

function classesOf(plan: ValidChangePlan): Classes {
  return {
    added: plan.added.map((p) => p.key),
    removed: plan.removed.map((p) => p.key),
    destructive: plan.destructive.map((p) => [p.key, p.settings]),
    inPlace: plan.inPlace.map((p) => [p.key, p.settings]),
    nextLaunch: plan.nextLaunch.map((p) => [p.key, p.own]),
    recorded: plan.recorded.map((p) => [p.key, p.fields]),
    unchanged: plan.unchanged.map((p) => p.key),
    settings: plan.settings,
    noEffectiveChange: plan.noEffectiveChange,
  }
}

/** Classes with every class empty and an effective change, then `c`. */
function classes(c: Partial<Classes>): Classes {
  return {
    added: [],
    removed: [],
    destructive: [],
    inPlace: [],
    nextLaunch: [],
    recorded: [],
    unchanged: [],
    settings: [],
    noEffectiveChange: false,
    ...c,
  }
}

/** The top-level settings of each channel mode: the switch absent, and the switch on. */
const DECLARATIVE_TOP: Record<string, unknown> = {}
const FUNGIBLE_TOP: Record<string, unknown> = { [MODE_SWITCH_SETTING]: true }

/** The plan class a row lands in, with the `src/` list that class's settings come from. */
const PLAN_CLASSES = {
  destructive: DESTRUCTIVE_SETTINGS,
  inPlace: IN_PLACE_SETTINGS,
  nextLaunch: NEXT_LAUNCH_SETTINGS,
  recorded: RECORDED_SECTION_KEYS,
} as const satisfies Record<string, readonly string[]>
type PlanClass = keyof typeof PLAN_CLASSES

describe('a persona change is classified by the section in force when both configurations are in one mode (b.deo SRI-802)', () => {
  // Rows: the mode both configurations are in, alpha's entry before and
  // after, and the class and setting the change lands in. The declarative
  // rows of the 0.11.1 classes are in tests/reload-preview.test.ts; here only
  // the rows each mode adds or changes.
  test.each<[string, Record<string, unknown>, Partial<PersonaInput>, Partial<PersonaInput>, PlanClass, string]>([
    ['declarative: an invited change', DECLARATIVE_TOP, {}, { invited: { permission_prompts: 'C0A0002' } }, 'recorded', 'invited'],
    [
      'fungible: an invited.permission_prompts change',
      FUNGIBLE_TOP,
      {},
      { invited: { permission_prompts: 'C0A0002' } },
      'inPlace',
      'invited.permission_prompts',
    ],
    [
      'fungible: a channels change',
      FUNGIBLE_TOP,
      {},
      { channels: [{ id: 'C0A0001', delivery: 'all' }, { id: 'C0A0002', delivery: 'all' }] },
      'recorded',
      'channels',
    ],
    ['fungible: a top-level permission_prompts change', FUNGIBLE_TOP, {}, { permission_prompts: 'C0A0002' }, 'recorded', 'permission_prompts'],
    [
      'fungible: a dm.enabled change',
      FUNGIBLE_TOP,
      { dm: { enabled: false, contact: 'U0A0001' } },
      { dm: { enabled: true, contact: 'U0A0001' } },
      'inPlace',
      'dm.enabled',
    ],
    [
      'fungible: a dm.contact change',
      FUNGIBLE_TOP,
      { dm: { enabled: false, contact: 'U0A0001' } },
      { dm: { enabled: false, contact: 'U0A0002' } },
      'inPlace',
      'dm.contact',
    ],
    ['fungible: a working_directory change', FUNGIBLE_TOP, {}, { working_directory: '~/moved-work' }, 'destructive', 'working_directory'],
    ['fungible: a stop_hook_bootstrap change', FUNGIBLE_TOP, {}, { stop_hook_bootstrap: false }, 'nextLaunch', 'stop_hook_bootstrap'],
  ])('%s lands in its class', (_label, top, before, after, cls, setting) => {
    expect(PLAN_CLASSES[cls] as readonly string[]).toContain(setting)
    expect(channelModeOf(parse(input(top, after)))).toBe(channelModeOf(parse(input(top, before))))

    const result = planBetween(input(top, before), input(top, after))

    // A recorded change modifies no persona: alpha is unchanged and the plan has no effect.
    const recordedOnly = cls === 'recorded'
    expect(classesOf(result)).toEqual(
      classes({
        [cls]: [['alpha', [setting]]],
        unchanged: recordedOnly ? ['alpha'] : [],
        noEffectiveChange: recordedOnly,
      }),
    )
  })
})

describe('a change of the switch alone modifies no persona, in each direction (b.deo SRI-802, SRI-203)', () => {
  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['absent to true', {}, { [MODE_SWITCH_SETTING]: true }],
    ['false to true', { [MODE_SWITCH_SETTING]: false }, { [MODE_SWITCH_SETTING]: true }],
    ['true to absent', { [MODE_SWITCH_SETTING]: true }, {}],
    ['true to false', { [MODE_SWITCH_SETTING]: true }, { [MODE_SWITCH_SETTING]: false }],
  ])('the switch from %s is one effective changed setting, the switch with its personas', (_label, from, to) => {
    const mode = channelModeOf(parse(input(to)))
    expect(mode).not.toBe(channelModeOf(parse(input(from))))

    const result = planBetween(input(from), input(to))

    // No persona is modified, recorded, destructive, added or removed.
    expect(classesOf(result)).toEqual(
      classes({
        unchanged: ['alpha'],
        settings: [{ name: MODE_SWITCH_SETTING, mode, personas: [ALPHA_REF] }],
      }),
    )
  })
})

describe('writing false where the switch was absent is no effective change (b.deo SRI-101)', () => {
  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['absent to false', {}, { [MODE_SWITCH_SETTING]: false }],
    ['false to absent', { [MODE_SWITCH_SETTING]: false }, {}],
  ])('the switch from %s changes no setting and no persona', (_label, from, to) => {
    expect(classesOf(planBetween(input(from), input(to)))).toEqual(classes({ unchanged: ['alpha'], noEffectiveChange: true }))
  })
})

describe('writing true where fresh_system_prompt was absent is no effective change (b.b1j SR-1.1, SR-3)', () => {
  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['absent to true', {}, { fresh_system_prompt: true }],
    ['true to absent', { fresh_system_prompt: true }, {}],
  ])('fresh_system_prompt from %s changes no setting and no persona', (_label, from, to) => {
    expect(classesOf(planBetween(input(from), input(to)))).toEqual(classes({ unchanged: ['alpha'], noEffectiveChange: true }))
  })
})
