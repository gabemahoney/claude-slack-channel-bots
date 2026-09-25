/**
 * reload.test.ts — The reload controller's start rules (b.av2 SR-8.7), the
 * record-start real-path collisions (SR-1.5, record-start part) and the
 * SR-5.2 guard source, driven end to end through `makeReloadHarness`: the
 * real controller over a temp configuration directory, the real bring-up
 * controller and connection manager over stub Slack, a fake clock and a
 * manual tick driver. No real timer, home, Slack client or agent-director.
 *
 * Parse and validation details are `config.test.ts`'s and the durable write
 * itself is `atomic-write.test.ts`'s; this file asserts what a start does
 * with them: which file it applies, what it writes, what it brings up and
 * what it logs. Every test runs `assertNoLeak` over what the run captured.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_PERSONA_CONFIG_FS,
  prePersonaConversionMessage,
  type PersonaConfigFs,
  type PersonaInput,
} from '../src/config.ts'
import { RELOAD_RECORD_WRITE_FAILED } from '../src/reload.ts'
import { assertNoLeak, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'

const CONFIG_REFUSAL = '[slack] Fatal: configuration error — '
const RECORD_REFUSAL = '[slack] Fatal: last-applied record error — '

let h: ReloadHarness

beforeEach(() => {
  h = makeReloadHarness()
})

afterEach(async () => {
  await h.cleanup()
})

/** `{ personas }` in file form. */
function configOf(...personas: PersonaInput[]): { personas: PersonaInput[] } {
  return { personas }
}

/** Personas with credentials files and working directories on disk. */
function materialized(...names: string[]): PersonaInput[] {
  const personas = names.map((name) => h.persona(name))
  h.materialize(...personas)
  return personas
}

/** The keys the start pass brought up, sorted. */
function broughtUp(run: ReloadRun): string[] {
  return run.lifecycle.keys('bring-up').sort()
}

/** The keys of `names`, sorted. */
function keysOf(...names: string[]): string[] {
  return names.map((n) => h.key(n)).sort()
}

/** A malformed file whose first invalid character (line 3, column 5) is the sentinel. */
function malformedWithSentinel(): string {
  return `{\n  "personas": [\n    ${LEAK_SENTINEL}\n  ]\n}\n`
}

/** The deletion hint every record refusal carries. */
function deletionHint(): string {
  return (
    `Deleting the last-applied record "${h.paths.lastApplied}" makes the next start ` +
    `apply the configuration file "${h.paths.config}" as it stands.`
  )
}

/**
 * Assert the applied outcome's `config` is the very object the start pass
 * received, holding exactly the personas named, in order.
 */
function expectOutcomeConfigIsStartPass(run: ReloadRun, ...names: string[]): void {
  const config = run.outcome?.kind === 'applied' ? run.outcome.config : undefined
  expect(run.lifecycle.startPasses).toHaveLength(1)
  expect(config).toBe(run.lifecycle.startPasses[0]!)
  expect(config?.personas.map((p) => p.key)).toEqual(names.map((n) => h.key(n)))
}

/** Assert the run refused: nothing written, applied, brought up or launched. */
function expectNothingApplied(run: ReloadRun): void {
  expect(run.outcome?.kind).toBe('refused')
  expect(run.controller.applied()).toBeUndefined()
  expect(run.lifecycle.startPasses).toEqual([])
  expect(run.lifecycle.records).toEqual([])
  expect(run.slack.builds).toEqual([])
  expect(Object.values(run.slackCalls()).flat()).toEqual([])
}

// ---------------------------------------------------------------------------
// No record (AC 71)
// ---------------------------------------------------------------------------

describe('a start without a record applies the configuration file or refuses', () => {
  test('AC 71: a valid configuration file is recorded byte for byte and exactly its personas are brought up', async () => {
    const personas = materialized('alpha', 'bravo')
    const configBytes = h.writeConfig(configOf(...personas))

    const run = await h.start()

    expect(run.outcome.kind).toBe('applied')
    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('config')
    expect(h.readRecord()).toEqual(configBytes)
    expect(h.readConfig()).toEqual(configBytes)
    expect(run.writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
    // No temporary sibling (or any other file) is left beside the config.
    expect(h.configDirEntries()).toEqual(['config.json', 'config.json.last-applied'])
    expect(run.lifecycle.startPasses.map((c) => c.personas.map((p) => p.key))).toEqual([[h.key('alpha'), h.key('bravo')]])
    expectOutcomeConfigIsStartPass(run, 'alpha', 'bravo')
    expect(broughtUp(run)).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.keys('launch').sort()).toEqual(keysOf('alpha', 'bravo'))
    expect(run.logs).toContain(
      `[slack] No last-applied record: recorded the configuration file "${h.paths.config}" as "${h.paths.lastApplied}"`,
    )
    assertNoLeak(run.captured())
  })

  test.each([
    {
      label: 'a JSON syntax error (line and column, no content)',
      bytes: () => malformedWithSentinel(),
      expected: () => `malformed JSON in "${h.paths.config}" at line 3, column 5.`,
    },
    {
      label: 'an SR-1.5 violation (two personas sharing a working directory)',
      bytes: () =>
        JSON.stringify(configOf(h.persona('alpha'), h.persona('bravo', { working_directory: h.persona('alpha').working_directory }))),
      expected: () => `invalid persona config in "${h.paths.config}": `,
    },
    {
      label: 'a pre-persona file (routes, default_route, default_dm_session): the SR-1.7 conversion message',
      bytes: () => JSON.stringify({ routes: {}, default_route: 'C0OLD', default_dm_session: 'C0OLD' }),
      expected: () => prePersonaConversionMessage('routes'),
    },
  ])('AC 71: an invalid configuration file refuses the start and logs why: $label', async ({ bytes, expected }) => {
    materialized('alpha', 'bravo')
    const written = h.writeConfigBytes(bytes())

    const run = await h.start()

    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.source).toBe('config')
    expect(run.outcome.kind === 'refused' && run.outcome.class).toBeUndefined()
    expect(h.readRecord()).toBeUndefined()
    expect(run.writes).toEqual([])
    expect(h.readConfig()).toEqual(written)
    expect(run.logs).toHaveLength(1)
    expect(run.logs[0]!.startsWith(CONFIG_REFUSAL)).toBe(true)
    expect(run.logs[0]).toContain(expected())
    assertNoLeak(run.captured())
  })

  test.each([
    { label: 'missing', setUp: () => h.remove(h.paths.config), expected: 'does not exist' },
    { label: 'a directory', setUp: () => h.replaceWithDirectory(h.paths.config), expected: 'cannot be read (EISDIR)' },
  ])('AC 71: a configuration file that is $label refuses the start and names the file', async ({ setUp, expected }) => {
    setUp()

    const run = await h.start()

    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.source).toBe('config')
    expect(h.readRecord()).toBeUndefined()
    expect(run.writes).toEqual([])
    expect(run.logs).toEqual([
      `${CONFIG_REFUSAL}The configuration file "${h.paths.config}" ${expected}. The server requires the configuration file to start.`,
    ])
    assertNoLeak(run.captured())
  })

  test.each([
    { step: 'openSync', code: 'EIO', call: undefined },
    { step: 'writeSync', code: 'ENOSPC', call: undefined },
    { step: 'fsyncSync', code: 'EIO', call: 1 },
    { step: 'renameSync', code: 'EROFS', call: undefined },
  ] as const)('a record that cannot be written ($step, $code) refuses the start with reload-record-write-failed', async ({ step, code, call }) => {
    const personas = materialized('alpha')
    const configBytes = h.writeConfig(configOf(...personas))
    h.failWrites({ step, code, call })

    const run = await h.start()

    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.class).toBe(RELOAD_RECORD_WRITE_FAILED)
    expect(run.writes).toEqual([{ path: h.paths.lastApplied, ok: false }])
    expect(h.readRecord()).toBeUndefined()
    expect(h.readConfig()).toEqual(configBytes)
    expect(h.configDirEntries()).toEqual(['config.json'])
    expect(run.logs).toEqual([
      `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write the last-applied record "${h.paths.lastApplied}" (${code}); ` +
        'the server does not start and nothing is applied',
    ])
    assertNoLeak(run.captured())
  })

  test('a record written but whose directory cannot be synced refuses the start, says so, and the next start runs it', async () => {
    const personas = materialized('alpha', 'bravo')
    const configBytes = h.writeConfig(configOf(personas[0]!))
    // The second fsync is the directory's, after the rename.
    h.failWrites({ step: 'fsyncSync', code: 'EIO', call: 2 })

    const run = await h.start()

    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.source).toBe('config')
    expect(run.outcome.kind === 'refused' && run.outcome.class).toBe(RELOAD_RECORD_WRITE_FAILED)
    expect(run.writes).toEqual([{ path: h.paths.lastApplied, ok: false }])
    expect(run.logs).toEqual([
      `[slack] ${RELOAD_RECORD_WRITE_FAILED}: the last-applied record "${h.paths.lastApplied}" was written but its ` +
        'directory could not be synced (EIO), so it may not survive a crash, and the next start will run it; ' +
        'the server does not start',
    ])
    expect(h.readRecord()).toEqual(configBytes)
    expect(h.configDirEntries()).toEqual(['config.json', 'config.json.last-applied'])
    assertNoLeak(run.captured({ record: writtenFile(h.paths.lastApplied) }))

    // As the line says: the next start runs the record, whatever the config file now holds.
    h.clearWriteFailure()
    h.writeConfig(configOf(...personas))
    const next = await h.start()
    expect(next.outcome.kind === 'applied' && next.outcome.source).toBe('record')
    expectOutcomeConfigIsStartPass(next, 'alpha')
    expect(next.lifecycle.outcome(h.key('alpha'))).toBe('up')
    expect(next.writes).toEqual([])
    expect(h.readRecord()).toEqual(configBytes)
    assertNoLeak(next.captured())
  })
})

// ---------------------------------------------------------------------------
// Record present (AC 13, AC 72)
// ---------------------------------------------------------------------------

describe('a start with a record runs the record', () => {
  /** The applied personas' keys and channels, as the start pass received them. */
  function appliedShape(run: ReloadRun): Array<[string, unknown]> {
    return run.lifecycle.startPasses[0]!.personas.map((p) => [p.key, p.channels])
  }

  test.each([
    { label: 'a persona added', config: () => configOf(h.persona('alpha'), h.persona('bravo'), h.persona('charlie')) },
    { label: 'a persona removed (AC 70, start half: the applied set comes back)', config: () => configOf(h.persona('alpha')) },
    {
      label: 'a persona modified',
      config: () =>
        configOf(h.persona('alpha', { channels: [{ id: 'C0RLDEDIT', delivery: 'mentions' }], permission_prompts: 'C0RLDEDIT' }), h.persona('bravo')),
    },
  ])('AC 13: the config file differs ($label): exactly the record set comes up and neither file changes', async ({ config }) => {
    const [alpha, bravo] = materialized('alpha', 'bravo', 'charlie')
    const recordBytes = h.writeRecord(configOf(alpha!, bravo!))
    const configBytes = h.writeConfig(config())

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('record')
    expect(run.controller.applied()?.bytes).toEqual(new Uint8Array(recordBytes))
    expect(appliedShape(run)).toEqual([
      [h.key('alpha'), [{ id: alpha!.channels![0]!.id, delivery: 'all' }]],
      [h.key('bravo'), [{ id: bravo!.channels![0]!.id, delivery: 'all' }]],
    ])
    expectOutcomeConfigIsStartPass(run, 'alpha', 'bravo')
    expect(broughtUp(run)).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.keys('launch').sort()).toEqual(keysOf('alpha', 'bravo'))
    expect(run.writes).toEqual([])
    expect(h.readRecord()).toEqual(recordBytes)
    expect(h.readConfig()).toEqual(configBytes)
    expect(run.logs).toContain(`[slack] Starting from the last-applied record "${h.paths.lastApplied}"`)
    assertNoLeak(run.captured())
  })

  test.each([
    { label: 'missing', setUp: () => h.remove(h.paths.config) },
    { label: 'malformed', setUp: () => void h.writeConfigBytes(malformedWithSentinel()) },
    { label: 'a directory', setUp: () => h.replaceWithDirectory(h.paths.config) },
  ])('AC 13: the config file is $label: the record alone suffices and the start runs it', async ({ setUp }) => {
    const personas = materialized('alpha')
    const recordBytes = h.writeRecord(configOf(...personas))
    setUp()

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('record')
    expect(broughtUp(run)).toEqual(keysOf('alpha'))
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('up')
    expect(run.writes).toEqual([])
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.logs.filter((l) => l.includes('Fatal'))).toEqual([])
    assertNoLeak(run.captured())
  })

  test('AC 72: credentials files are read as they stand at a start from the record', async () => {
    const [alpha, bravo, charlie] = materialized('alpha', 'bravo', 'charlie')
    h.writeConfig(configOf(alpha!, bravo!, charlie!))
    const first = await h.start()
    expect(first.outcome.kind === 'applied' && first.outcome.source).toBe('config')
    expect(first.lifecycle.outcome(h.key('alpha'))).toBe('up')
    expect(first.lifecycle.outcome(h.key('bravo'))).toBe('up')
    const firstCaptured = first.captured()
    await first.stop()

    // While the server is down: alpha's file gets a new valid token set,
    // bravo's is made invalid, charlie's is left alone.
    const rotated = h.writeCredentials(alpha!)
    h.writeCredentialsContent(bravo!, 'not json')

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('record')
    const alphaKey = h.key('alpha')
    expect(run.lifecycle.outcome(alphaKey)).toBe('up')
    expect(run.slack.buildsOf(alphaKey, 'validation')[0]!.hasToken(rotated.botToken)).toBe(true)
    expect(run.slack.buildsOf(alphaKey, 'socket')[0]!.hasToken(rotated.appToken)).toBe(true)
    expect(run.lifecycle.outcome(h.key('bravo'))).toBe('broken')
    expect(run.lifecycle.classes(h.key('bravo'))).toEqual(['persona-credentials-invalid'])
    expect(run.lifecycle.outcome(h.key('charlie'))).toBe('up')
    expect(run.lifecycle.keys('launch').sort()).toEqual(keysOf('alpha', 'charlie'))
    // The record holds no credentials content: it was written by the first
    // start and is checked, as a written file, for any token.
    assertNoLeak({ ...run.captured({ record: writtenFile(h.paths.lastApplied) }), firstCaptured })
  })

  test.each([
    {
      label: 'cannot be read (a directory at its path)',
      setUp: () => h.replaceWithDirectory(h.paths.lastApplied),
      expected: () => `The last-applied record "${h.paths.lastApplied}" cannot be read (EISDIR).`,
    },
    {
      label: 'has a JSON syntax error (line and column, no content)',
      setUp: () => void h.writeRecordBytes(malformedWithSentinel()),
      expected: () => `malformed JSON in "${h.paths.lastApplied}" at line 3, column 5.`,
    },
    {
      label: 'breaks an SR-1.5 rule record mode keeps (a duplicate name)',
      setUp: () => void h.writeRecord(configOf(h.persona('alpha'), h.persona('alpha', { credentials_file: join(h.root, 'other.json') }))),
      expected: () => `invalid persona config in "${h.paths.lastApplied}": `,
    },
    {
      label: 'has the pre-persona shape',
      setUp: () => void h.writeRecord({ routes: {}, default_route: 'C0OLD' }),
      expected: () => prePersonaConversionMessage('routes'),
    },
  ])('a record that $label stops the start with the deletion hint and is left in place', async ({ setUp, expected }) => {
    const personas = materialized('alpha')
    const configBytes = h.writeConfig(configOf(...personas))
    setUp()
    const recordBefore = existsSync(h.paths.lastApplied) && statSync(h.paths.lastApplied).isFile() ? h.readRecord() : undefined

    const run = await h.start()

    // No fallback to the (valid) config file: nothing is applied.
    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.source).toBe('record')
    expect(run.writes).toEqual([])
    expect(run.logs).toHaveLength(1)
    expect(run.logs[0]!.startsWith(RECORD_REFUSAL)).toBe(true)
    expect(run.logs[0]).toContain(expected())
    expect(run.logs[0]!.endsWith(deletionHint())).toBe(true)
    expect(existsSync(h.paths.lastApplied)).toBe(true)
    if (recordBefore !== undefined) expect(h.readRecord()).toEqual(recordBefore)
    expect(h.readConfig()).toEqual(configBytes)
    assertNoLeak(run.captured())

    // The hint holds: with the record deleted, the next start applies the config file.
    h.remove(h.paths.lastApplied)
    const next = await h.start()
    expect(next.outcome.kind === 'applied' && next.outcome.source).toBe('config')
    expect(broughtUp(next)).toEqual(keysOf('alpha'))
    expect(h.readRecord()).toEqual(configBytes)
    assertNoLeak(next.captured())
  })

  test('the start arms no detection tick and makes no teardown, reconnect or in-place update', async () => {
    const personas = materialized('alpha')
    h.writeRecord(configOf(...personas))
    h.writeConfig(configOf(h.persona('bravo')))

    const run = await h.start()

    expect(run.outcome.kind).toBe('applied')
    expect(run.ticks.startCalls).toBe(0)
    expect(run.ticks.armed).toBe(false)
    expect(run.lifecycle.of('teardown')).toEqual([])
    expect(run.lifecycle.of('reconnect')).toEqual([])
    expect(run.lifecycle.of('update-in-place')).toEqual([])
    expect(run.lifecycle.startPasses).toHaveLength(1)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Zero personas (AC 54)
// ---------------------------------------------------------------------------

describe('a start with zero personas runs', () => {
  test('AC 54: a config with an empty personas array and no record starts, is recorded and brings nobody up', async () => {
    const configBytes = h.writeConfig(configOf())

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('config')
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.lifecycle.startPasses.map((c) => c.personas)).toEqual([[]])
    expect(run.lifecycle.records).toEqual([])
    assertNoLeak(run.captured())
  })

  test('AC 54: a record with zero personas starts and brings nobody up, whatever the config file holds', async () => {
    materialized('alpha')
    const recordBytes = h.writeRecord(configOf())
    h.writeConfig(configOf(h.persona('alpha')))

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('record')
    expect(run.lifecycle.startPasses.map((c) => c.personas)).toEqual([[]])
    expect(run.lifecycle.records).toEqual([])
    expect(h.readRecord()).toEqual(recordBytes)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Record-start real-path collisions (b.av2 SR-1.5, record-start part)
// ---------------------------------------------------------------------------

describe('a record-start real-path collision is a bring-up failure of each persona involved', () => {
  test.each([
    { setting: 'working_directory', via: 'the same path', outcome: 'retrying', cls: 'persona-directory-unusable' },
    { setting: 'working_directory', via: 'a symlink', outcome: 'retrying', cls: 'persona-directory-unusable' },
    { setting: 'credentials_file', via: 'the same path', outcome: 'broken', cls: 'persona-credentials-invalid' },
    { setting: 'credentials_file', via: 'a symlink', outcome: 'broken', cls: 'persona-credentials-invalid' },
  ] as const)('two personas sharing a $setting through $via: both $outcome with $cls, the third comes up', async ({ setting, via, outcome, cls }) => {
    const [alpha, charlie] = materialized('alpha', 'charlie')
    const base = h.persona('bravo')
    let shared: string
    if (via === 'the same path') {
      shared = alpha![setting]
    } else {
      shared = join(dirname(base[setting]), `link-to-alpha-${setting}`)
      h.makeWorkingDirectory({ working_directory: dirname(shared) })
      symlinkSync(alpha![setting], shared)
    }
    const bravo = { ...base, [setting]: shared }
    // bravo's own other file exists, so the shared one is its only cause.
    if (setting === 'working_directory') h.writeCredentials(bravo)
    else h.makeWorkingDirectory(bravo)
    h.writeRecord(configOf(alpha!, bravo, charlie!))

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe('record')
    for (const key of [h.key('alpha'), h.key('bravo')]) {
      expect(run.lifecycle.outcome(key)).toBe(outcome)
      expect(run.lifecycle.classes(key)).toEqual([cls])
    }
    expect(run.lifecycle.outcome(h.key('charlie'))).toBe('up')
    expect(run.lifecycle.keys('launch')).toEqual([h.key('charlie')])
    // No Slack client is built for either involved persona, so nothing is posted (SR-7.2).
    expect([...new Set(run.slack.builds.map((b) => b.persona))]).toEqual([h.key('charlie')])
    expect(run.slackPosts()).toEqual([])
    // A directory collision re-checks on the fake clock; it still never comes up.
    await run.clock.advance(5_000)
    expect(run.lifecycle.keys('launch')).toEqual([h.key('charlie')])
    await run.stop()
    expect(run.clock.pendingCount()).toBe(0)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// SR-5.2 guard source
// ---------------------------------------------------------------------------

describe('the file guard source (b.av2 SR-5.2)', () => {
  test('lists the applied and the current config file credentials paths, and only the applied ones once the config is malformed', () => {
    const alpha = h.persona('alpha')
    const bravo = h.persona('bravo')
    h.writeRecord(configOf(alpha))
    h.writeConfig(configOf(alpha, bravo))
    const run = h.build()
    expect(run.resolveStart().kind).toBe('applied')

    const listed = () => [...new Set(run.controller.protectedCredentialsFiles())].sort()
    expect(listed()).toEqual([alpha.credentials_file, bravo.credentials_file].sort())

    h.writeConfigBytes(malformedWithSentinel())
    expect(listed()).toEqual([alpha.credentials_file])
    assertNoLeak(run.captured({ listed: listed() }))
  })
})

// ---------------------------------------------------------------------------
// Call order
// ---------------------------------------------------------------------------

describe('the controller enforces the start call order', () => {
  const RESOLVE_ONCE = 'reload: resolveStart may be called only once'
  const BRING_UP_ONCE = 'reload: the start bring-up runs once, after the start resolved an applied configuration'

  test('resolveStart runs once; the start bring-up runs once, only after an applied start, never after a refused one', async () => {
    const personas = materialized('alpha')
    h.writeConfig(configOf(...personas))
    const run = h.build()

    await expect(run.controller.runStartBringUp()).rejects.toThrow(BRING_UP_ONCE)
    expect(run.resolveStart().kind).toBe('applied')
    expect(() => run.resolveStart()).toThrow(RESOLVE_ONCE)
    const release = run.lifecycle.holdStartPass()
    const pass = run.controller.runStartBringUp()
    // A second call while the pass is still running; settled only after the release, so it can't deadlock.
    const during = run.controller.runStartBringUp()
    release()
    await pass
    await expect(during).rejects.toThrow(BRING_UP_ONCE)
    await expect(run.controller.runStartBringUp()).rejects.toThrow(BRING_UP_ONCE)

    expect(run.lifecycle.startPasses).toHaveLength(1)
    expect(broughtUp(run)).toEqual(keysOf('alpha'))
    expect(run.writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
    assertNoLeak(run.captured())

    h.remove(h.paths.lastApplied)
    h.remove(h.paths.config)
    const refused = h.build()
    expect(refused.resolveStart().kind).toBe('refused')
    await expect(refused.controller.runStartBringUp()).rejects.toThrow(BRING_UP_ONCE)
    expect(() => refused.resolveStart()).toThrow(RESOLVE_ONCE)
    expect(refused.logs).toHaveLength(1)
    expect(refused.lifecycle.startPasses).toEqual([])
    expect(refused.lifecycle.records).toEqual([])
    assertNoLeak(refused.captured())
  })
})

// ---------------------------------------------------------------------------
// `~` under the injected home
// ---------------------------------------------------------------------------

describe('a `~` in the applied configuration expands under the injected home', () => {
  test.each(['record', 'config'] as const)('from the %s: the persona files are found under the home and the persona comes up', async (source) => {
    const credentials = join(h.home, 'reload-home', 'alpha', 'credentials.json')
    const work = join(h.home, 'reload-home', 'alpha', 'work')
    const tokens = h.writeCredentials({ name: 'alpha', credentials_file: credentials })
    h.makeWorkingDirectory({ working_directory: work })
    const alpha = h.persona('alpha', {
      credentials_file: '~/reload-home/alpha/credentials.json',
      working_directory: '~/reload-home/alpha/work',
    })
    if (source === 'record') h.writeRecord(configOf(alpha))
    else h.writeConfig(configOf(alpha))

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe(source)
    const applied = run.lifecycle.startPasses[0]!.personas[0]!
    expect([applied.credentials_file, applied.working_directory]).toEqual([credentials, work])
    const key = h.key('alpha')
    expect(run.lifecycle.outcome(key)).toBe('up')
    expect(run.lifecycle.keys('launch')).toEqual([key])
    expect(run.slack.buildsOf(key, 'validation')[0]!.hasToken(tokens.botToken)).toBe(true)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('a dry-run start follows the same start rules', () => {
  test.each([
    { label: 'no record: the config file is recorded and applied', withRecord: false },
    { label: 'a record present: it is run and left unchanged', withRecord: true },
  ])('$label; no Slack client is built', async ({ withRecord }) => {
    const [alpha, bravo] = materialized('alpha', 'bravo')
    const recordBytes = withRecord ? h.writeRecord(configOf(alpha!)) : undefined
    const configBytes = h.writeConfig(configOf(alpha!, bravo!))

    const run = await h.start({ dryRun: true })

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe(withRecord ? 'record' : 'config')
    expect(h.readRecord()).toEqual(recordBytes ?? configBytes)
    expect(h.readConfig()).toEqual(configBytes)
    expect(run.writes).toEqual(withRecord ? [] : [{ path: h.paths.lastApplied, ok: true }])
    const names = withRecord ? ['alpha'] : ['alpha', 'bravo']
    expectOutcomeConfigIsStartPass(run, ...names)
    expect(broughtUp(run)).toEqual(keysOf(...names))
    expect(run.slack.builds).toEqual([])
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// A record or config file that is not a regular file
// ---------------------------------------------------------------------------

describe('a record or config file that is not a regular file refuses the start unread', () => {
  /**
   * A configFs seam over the real file system that reports `path` as neither
   * a file nor a directory (a FIFO or device), recording which paths were read
   * and closed.
   */
  function reportsNonRegular(path: string): { fs: Partial<PersonaConfigFs>; reads: string[]; closes: string[] } {
    const real = DEFAULT_PERSONA_CONFIG_FS
    const opened = new Map<number, string>()
    const reads: string[] = []
    const closes: string[] = []
    const fs: Partial<PersonaConfigFs> = {
      openFile(p) {
        const fd = real.openFile(p)
        opened.set(fd, p)
        return fd
      },
      fstatFile: (fd) => (opened.get(fd) === path ? { isFile: () => false, isDirectory: () => false } : real.fstatFile(fd)),
      readFileFd(fd) {
        reads.push(opened.get(fd)!)
        return real.readFileFd(fd)
      },
      closeFile(fd) {
        closes.push(opened.get(fd)!)
        real.closeFile(fd)
      },
    }
    return { fs, reads, closes }
  }

  test.each([
    {
      label: 'config.json, with no record',
      target: () => h.paths.config,
      withRecord: false,
      source: 'config',
      line: () =>
        `${CONFIG_REFUSAL}The configuration file "${h.paths.config}" cannot be read (not a regular file). ` +
        'The server requires the configuration file to start.',
    },
    {
      label: 'the record, beside a valid config.json (no fallback)',
      target: () => h.paths.lastApplied,
      withRecord: true,
      source: 'record',
      line: () => `${RECORD_REFUSAL}The last-applied record "${h.paths.lastApplied}" cannot be read (not a regular file). ${deletionHint()}`,
    },
  ] as const)('$label (injected fstat)', async ({ target, withRecord, source, line }) => {
    const personas = materialized('alpha')
    const configBytes = h.writeConfig(configOf(...personas))
    const recordBytes = withRecord ? h.writeRecord(configOf(...personas)) : undefined
    const seam = reportsNonRegular(target())

    const run = await h.start({ configFs: seam.fs })

    expectNothingApplied(run)
    expect(run.outcome.kind === 'refused' && run.outcome.source).toBe(source)
    expect(run.logs).toEqual([line()])
    // Never read, but closed; the record refusal never goes on to config.json.
    expect(seam.reads).toEqual([])
    expect(seam.closes).toEqual([target()])
    expect(run.writes).toEqual([])
    expect(h.readRecord()).toEqual(recordBytes)
    expect(h.readConfig()).toEqual(configBytes)
    assertNoLeak(run.captured())
  })

  const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0

  // In a child process with a 10 s bound: a blocking open of a FIFO with no
  // writer never returns, so in-process it would hang the whole suite instead
  // of failing this test.
  test.skipIf(!hasMkfifo).each(['config', 'record'] as const)(
    'a real FIFO at the %s path: the start returns at once and refuses (child process, 10 s bound; skipped where mkfifo is unavailable)',
    (which) => {
      const harnessPath = join(import.meta.dir, 'test-helpers', 'reload-harness.ts')
      const script = `
        const { spawnSync } = await import('node:child_process')
        const { makeReloadHarness } = await import(${JSON.stringify(harnessPath)})
        const h = makeReloadHarness({ parentDir: ${JSON.stringify(h.root)} })
        try {
          const alpha = h.persona('alpha')
          h.materialize(alpha)
          const fifo = ${JSON.stringify(which)} === 'record' ? h.paths.lastApplied : h.paths.config
          if (fifo !== h.paths.config) h.writeConfig({ personas: [alpha] })
          if (spawnSync('mkfifo', [fifo]).status !== 0) throw new Error('mkfifo failed')
          const run = await h.start()
          console.log(JSON.stringify({ paths: h.paths, outcome: run.outcome, logs: run.logs, records: run.lifecycle.records, writes: run.writes }))
        } finally {
          await h.cleanup()
        }
      `

      const child = spawnSync(process.execPath, ['-e', script], {
        timeout: 10_000,
        encoding: 'utf-8',
        env: { PATH: process.env['PATH'], HOME: h.home, SLACK_STATE_DIR: join(h.home, 'state') },
      })

      expect(child.signal).toBeNull()
      expect(child.status).toBe(0)
      const result = JSON.parse(child.stdout.trim())
      const { config, lastApplied } = result.paths
      const fifo = which === 'record' ? lastApplied : config
      const expectedLine =
        which === 'record'
          ? `${RECORD_REFUSAL}The last-applied record "${lastApplied}" cannot be read (not a regular file). ` +
            `Deleting the last-applied record "${lastApplied}" makes the next start apply the configuration file "${config}" as it stands.`
          : `${CONFIG_REFUSAL}The configuration file "${fifo}" cannot be read (not a regular file). ` +
            'The server requires the configuration file to start.'
      expect(result.outcome).toEqual({ kind: 'refused', source: which, line: expectedLine })
      expect(result.logs).toEqual([expectedLine])
      expect(result.records).toEqual([])
      expect(result.writes).toEqual([])
      assertNoLeak({ result, stderr: child.stderr })
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// No import side effects (b.av2 SR-13.1)
// ---------------------------------------------------------------------------

describe('module import', () => {
  test('importing src/reload.ts in a child with a fresh HOME exits 0, prints nothing and leaves HOME empty', () => {
    const home = h.home
    // Precondition: the harness's temp home starts empty (nothing materialized).
    expect(readdirSync(home)).toEqual([])
    const modulePath = join(import.meta.dir, '..', 'src', 'reload.ts')
    // The export check keeps the test from passing on an import that never ran.
    const script =
      `const m = await import(${JSON.stringify(modulePath)}); ` +
      `if (typeof m.readAppliedPersonaConfig !== 'function') process.exit(3)`

    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: home,
      timeout: 10_000,
      encoding: 'utf-8',
      env: {
        PATH: process.env['PATH'],
        HOME: home,
        SLACK_STATE_DIR: join(home, 'state'),
        // Bun's own runtime transpiler cache would otherwise land in $HOME/.bun.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
    })

    expect(child.signal).toBeNull()
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe('')
    expect(readdirSync(home)).toEqual([])
  }, 15_000)
})
