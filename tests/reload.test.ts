/**
 * reload.test.ts — The reload controller's start rules (b.av2 SR-8.7), the
 * record-start real-path collisions (SR-1.5, record-start part), the SR-5.2
 * guard source and pending-change detection (SR-8.2, SR-8.3: the pending
 * file's lifecycle, its fingerprint and the held credentials compare),
 * driven end to end through `makeReloadHarness`: the
 * real controller over a temp configuration directory, the real bring-up
 * controller and connection manager over stub Slack, a fake clock and a
 * manual tick driver. No real timer, home, Slack client or agent-director.
 *
 * Parse and validation details are `config.test.ts`'s and the durable write
 * itself is `atomic-write.test.ts`'s; this file asserts what a start does
 * with them: which file it applies, what it writes, what it brings up and
 * what it logs. Detection cases assert pending state, the pending file's
 * presence and fingerprint, lifecycle calls and log counts; the preview's
 * wording is Task 3's, except the credentials line AC 67 pins. Every test runs
 * `assertNoLeak` over what each run captured and checks no Slack post.
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
import type { PersonaBringUpOutcome } from '../src/persona-bringup-controller.ts'
import { RELOAD_NOTHING_PENDING, RELOAD_PREVIEW, RELOAD_RECORD_WRITE_FAILED } from '../src/reload.ts'
import { composePendingFile, PENDING_FILE_HEADER, reloadFingerprint } from '../src/reload-fingerprint.ts'
import { createReloadTickDriver } from '../src/reload-timer.ts'
import { assertNoLeak, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'
import {
  makeReloadHarness,
  mkfifoAvailable,
  NO_RUN_ACTIVITY,
  SLACK_AUTH_REJECTED,
  SLACK_UNREACHABLE,
  type ReloadHarness,
  type ReloadRun,
  type ReloadRunActivity,
  type ReloadRunOptions,
} from './test-helpers/reload-harness.ts'
import type { StubSlackOptions } from './test-helpers/slack-stub.ts'

const CONFIG_REFUSAL = '[slack] Fatal: configuration error — '
const RECORD_REFUSAL = '[slack] Fatal: last-applied record error — '

/** `reload-nothing-pending` when there was no pending file to remove. */
const NOTHING_PENDING =
  `[slack] ${RELOAD_NOTHING_PENDING}: the configuration file and the credentials files it references match ` +
  'what is applied; no change is pending'

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

/** Every test's closing check, per run: nothing posted to Slack (b.av2 SR-7.2) and no token in anything captured. */
function expectNoPostNoLeak(...runs: ReloadRun[]): void {
  for (const run of runs) {
    expect(run.slackPosts()).toEqual([])
    assertNoLeak(run.captured())
  }
}

/** Yield event-loop turns (no timer) until `cond` holds; fails if it never does. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i++) await new Promise((done) => setImmediate(done))
  expect(cond()).toBe(true)
}

/** `reload-nothing-pending` when the check removed the pending file. */
function nothingPendingRemoved(): string {
  return `${NOTHING_PENDING}, and the pending-change file "${h.paths.pending}" is removed`
}

/** Matches one `reload-preview` line (its wording is Task 3's). */
function previewLine(): string {
  return expect.stringMatching(new RegExp(`^\\[slack\\] ${RELOAD_PREVIEW}: `))
}

/** A stretch of checks that wrote the pending file once and logged `line` (one preview line by default), nothing else. */
function pendingWritten(line: string = previewLine()): ReloadRunActivity {
  return { ...NO_RUN_ACTIVITY, logs: [line], writes: [{ path: h.paths.pending, ok: true }] }
}

/** A stretch of checks that removed the pending file once and logged `logs` (`reload-nothing-pending`, file removed, by default), nothing else. */
function pendingRemoved(logs: string[] = [nothingPendingRemoved()]): ReloadRunActivity {
  return { ...NO_RUN_ACTIVITY, logs, removes: [{ path: h.paths.pending, ok: true, removed: true, unsynced: false }] }
}

/** Matches a pending-file write or delete failure line: the `[slack] reload:` prefix, the pending path and the errno code (not its wording). */
function fileFailureLine(code: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return expect.stringMatching(new RegExp(`^\\[slack\\] reload: .*"${escape(h.paths.pending)}".*\\(${code}\\)`))
}

/**
 * Run `body` (statements over `h`, a harness under this test's root, and
 * `spawnSync`) in a child `bun` process with a 10 s bound, so a blocking
 * FIFO open fails the test instead of hanging the suite. `body` prints one
 * JSON line; returns it parsed, and the child's stderr.
 */
function runHarnessInChild<T>(body: string): { result: T; stderr: string } {
  const harnessPath = join(import.meta.dir, 'test-helpers', 'reload-harness.ts')
  const script = `
    const { spawnSync } = await import('node:child_process')
    const { makeReloadHarness } = await import(${JSON.stringify(harnessPath)})
    const h = makeReloadHarness({ parentDir: ${JSON.stringify(h.root)} })
    try {
      ${body}
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
  return { result: JSON.parse(child.stdout.trim()) as T, stderr: child.stderr }
}

/** The preview line naming `persona` as a credentials change, by name, key and path (never content). */
function credentialsChangedLine(persona: PersonaInput): string {
  return `credentials changed: "${persona.name}" (key=${h.key(persona.name)}) credentials_file="${persona.credentials_file}"`
}

/** `bytes` with one newline appended: different bytes, the same content. */
function withNewline(bytes: Uint8Array): Buffer {
  return Buffer.concat([bytes, Buffer.from('\n')])
}

/**
 * A running server: `names` materialized and written as both the record and
 * the configuration file (byte-equal), detection started and the first check
 * run (nothing pending).
 */
async function running(
  names: string[],
  opts?: ReloadRunOptions,
): Promise<{ run: ReloadRun; personas: PersonaInput[]; recordBytes: Buffer }> {
  const personas = materialized(...names)
  const recordBytes = h.writeRecord(configOf(...personas))
  h.writeConfig(configOf(...personas))
  const run = await h.startDetecting(opts)
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(false)
  return { run, personas, recordBytes }
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

  test('the start arms no detection tick; startDetection arms exactly one, only once the start bring-up pass has returned', async () => {
    const personas = materialized('alpha')
    h.writeRecord(configOf(...personas))
    h.writeConfig(configOf(h.persona('bravo')))
    const run = h.build()

    expect(run.startDetection()).toBe(false)
    expect(run.resolveStart().kind).toBe('applied')
    expect(run.startDetection()).toBe(false)
    // The pass's bring-up and launch are done, but the pass itself has not returned.
    const release = run.lifecycle.holdStartPass()
    const pass = run.controller.runStartBringUp()
    await until(() => run.lifecycle.keys('launch').length === 1)
    expect(run.startDetection()).toBe(false)
    release()
    await pass

    // The start armed nothing on its own; the first call arms one tick, a second call nothing more.
    expect(run.ticks.startCalls).toBe(0)
    expect(run.startDetection()).toBe(true)
    expect(run.ticks.armed).toBe(true)
    expect(run.startDetection()).toBe(false)
    expect(run.ticks.startCalls).toBe(1)
    expect(run.ticks.ticksRun).toBe(0)
    expect(run.lifecycle.of('teardown')).toEqual([])
    expect(run.lifecycle.of('reconnect')).toEqual([])
    expect(run.lifecycle.of('update-in-place')).toEqual([])
    expect(run.lifecycle.startPasses).toHaveLength(1)
    expectNoPostNoLeak(run)

    // A start pass that throws has still returned (main() starts detection after a failing pass): it arms, and the first check runs.
    const failing = h.build()
    expect(failing.resolveStart().kind).toBe('applied')
    const hold = failing.lifecycle.holdStartPass()
    const failingPass = failing.controller.runStartBringUp()
    await until(() => failing.lifecycle.keys('launch').length === 1)
    expect(failing.startDetection()).toBe(false)
    hold.fail(new Error('the start pass failed'))
    await expect(failingPass).rejects.toThrow('the start pass failed')
    expect(failing.startDetection()).toBe(true)
    const beforeFirst = failing.checkpoint()
    await failing.ticks.tick()
    // The config file names bravo, the record alpha: the first check writes the pending file.
    expect(failing.since(beforeFirst)).toEqual(pendingWritten())
    expectNoPostNoLeak(failing)

    // Stopped before it was started, it never arms.
    const stoppedFirst = await h.start()
    stoppedFirst.controller.stopDetection()
    expect(stoppedFirst.startDetection()).toBe(false)
    expect(stoppedFirst.ticks.startCalls).toBe(0)
    expectNoPostNoLeak(stoppedFirst)

    // A refused start never arms.
    h.remove(h.paths.lastApplied)
    h.remove(h.paths.config)
    const refused = await h.start()
    expect(refused.outcome.kind).toBe('refused')
    expect(refused.startDetection()).toBe(false)
    expect(refused.ticks.startCalls).toBe(0)
    expectNoPostNoLeak(refused)
  })

  test('with the production tick driver on the fake clock, the first check runs 5 s after startDetection and never before it', async () => {
    const recordBytes = h.writeRecord(configOf())
    h.writeConfigBytes(Buffer.concat([recordBytes, Buffer.from('\n')]))
    const run = await h.start({ tickDriver: ({ clock, log }) => createReloadTickDriver({ clock, log }) })

    await run.clock.advance(60_000)
    expect(h.pendingExists()).toBe(false)
    expect(run.startDetection()).toBe(true)
    await run.clock.advance(4_999)
    expect(h.pendingExists()).toBe(false)
    await run.clock.advance(1)
    expect(h.pendingExists()).toBe(true)
    expect(run.pendingWrites()).toEqual([{ path: h.paths.pending, ok: true }])
    // Later passes find the file current and write nothing more.
    await run.clock.advance(20_000)
    expect(run.pendingWrites()).toHaveLength(1)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(1)
    await run.stop()
    expect(run.clock.pendingCount()).toBe(0)
    expectNoPostNoLeak(run)
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

  // In a child process with a 10 s bound: a blocking open of a FIFO with no
  // writer never returns, so in-process it would hang the whole suite instead
  // of failing this test.
  test.skipIf(!mkfifoAvailable()).each(['config', 'record'] as const)(
    'a real FIFO at the %s path: the start returns at once and refuses (child process, 10 s bound; skipped where mkfifo is unavailable)',
    (which) => {
      const { result, stderr } = runHarnessInChild<{
        paths: { config: string; lastApplied: string }
        outcome: unknown
        logs: string[]
        records: unknown[]
        writes: unknown[]
      }>(`
        const alpha = h.persona('alpha')
        h.materialize(alpha)
        const fifo = ${JSON.stringify(which)} === 'record' ? h.paths.lastApplied : h.paths.config
        if (fifo !== h.paths.config) h.writeConfig({ personas: [alpha] })
        if (spawnSync('mkfifo', [fifo]).status !== 0) throw new Error('mkfifo failed')
        const run = await h.start()
        console.log(JSON.stringify({ paths: h.paths, outcome: run.outcome, logs: run.logs, records: run.lifecycle.records, writes: run.writes }))
      `)

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
      assertNoLeak({ result, stderr })
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// Detection: the config file (b.av2 SR-8.2, SR-8.3, SR-8.7; AC 55, 62, 70)
// ---------------------------------------------------------------------------

describe('detection keeps the pending file in step with the config file and applies nothing', () => {
  test.each([
    { label: 'from the config file (no record)', withRecord: false },
    { label: 'from the record', withRecord: true },
  ])('a clean start $label (one persona up, one retrying, one broken by a missing credentials file) writes and logs nothing over many checks', async ({ withRecord }) => {
    const [alpha, bravo] = materialized('alpha', 'bravo')
    const charlie = h.persona('charlie')
    h.makeWorkingDirectory(charlie)
    if (withRecord) h.writeRecord(configOf(alpha!, bravo!, charlie))
    h.writeConfig(configOf(alpha!, bravo!, charlie))

    const run = await h.startDetecting({ slack: { bravo: SLACK_UNREACHABLE } })
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('up')
    expect(run.lifecycle.outcome(h.key('bravo'))).toBe('retrying')
    expect(run.lifecycle.outcome(h.key('charlie'))).toBe('broken')
    const cp = run.checkpoint()
    await run.ticks.ticks(30)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingExists()).toBe(false)
    expect(run.logsOf(RELOAD_PREVIEW)).toEqual([])
    expect(run.logsOf(RELOAD_NOTHING_PENDING)).toEqual([])
    expectNoPostNoLeak(run)
  })

  test('only the config bytes differing from the record (one newline added) is a pending change', async () => {
    const { run, recordBytes } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(3)

    expect(run.since(cp)).toEqual(pendingWritten())
    expect(h.readPendingText()?.startsWith(`${PENDING_FILE_HEADER}\n`)).toBe(true)
    expect(h.pendingFingerprint()).toMatch(/^[0-9a-f]{64}$/)
    expectNoPostNoLeak(run)
  })

  test.each([
    { label: 'a persona added', edit: (a: PersonaInput, b: PersonaInput) => configOf(a, b, h.persona('charlie')) },
    { label: 'a persona removed', edit: (a: PersonaInput) => configOf(a) },
    {
      label: 'a persona changed in place',
      edit: (a: PersonaInput, b: PersonaInput) => configOf({ ...a, channels: [{ id: a.channels![0]!.id, delivery: 'mentions' }] }, b),
    },
    { label: 'a server-wide setting changed', edit: (a: PersonaInput, b: PersonaInput) => ({ ...configOf(a, b), stop_timeout: 45 }) },
  ])('AC 55: an edit held over many ticks ($label) causes no lifecycle call and nothing reaches Slack', async ({ edit }) => {
    materialized('charlie')
    const { run, personas, recordBytes } = await running(['alpha', 'bravo'])
    const cp = run.checkpoint()

    h.writeConfig(edit(personas[0]!, personas[1]!))
    await run.ticks.ticks(50)

    // One pending-file write and one preview line; no teardown, bring-up,
    // launch, reconnect or in-place update, no Slack client and no Slack call.
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(h.pendingExists()).toBe(true)
    expect(h.readRecord()).toEqual(recordBytes)
    expectNoPostNoLeak(run)
  })

  test('AC 62: a revert deletes the pending file and logs reload-nothing-pending exactly once, leaving no temporary file', async () => {
    const { run, personas, recordBytes } = await running(['alpha', 'bravo'])
    h.writeConfig(configOf(personas[0]!))
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(true)
    const cp = run.checkpoint()

    h.writeConfigBytes(recordBytes)
    await run.ticks.ticks(20)

    expect(run.since(cp)).toEqual(pendingRemoved())
    expect(h.pendingExists()).toBe(false)
    expect(h.configDirEntries()).toEqual(['config.json', 'config.json.last-applied'])
    expectNoPostNoLeak(run)
  })

  test.each([
    { label: 'a persona removed', edit: (a: PersonaInput) => configOf(a) },
    {
      label: "a persona's working_directory changed",
      edit: (a: PersonaInput, b: PersonaInput) => configOf({ ...a, working_directory: join(dirname(a.working_directory), 'moved') }, b),
    },
  ])('AC 70: an unconfirmed destructive edit ($label) survives a restart: the applied set comes back and the first check leaves the edit pending', async ({ edit }) => {
    const [alpha, bravo] = materialized('alpha', 'bravo')
    h.makeWorkingDirectory({ working_directory: join(dirname(alpha!.working_directory), 'moved') })
    const recordBytes = h.writeRecord(configOf(alpha!, bravo!))
    const configBytes = h.writeConfig(edit(alpha!, bravo!))
    const run = h.build()

    expect(run.resolveStart()).toMatchObject({ kind: 'applied', source: 'record' })
    const release = run.lifecycle.holdStartPass()
    const pass = run.controller.runStartBringUp()
    await until(() => run.lifecycle.keys('launch').length === 2)
    // The start's bring-ups have run; no pending file yet, and no check can be armed.
    expect(h.pendingExists()).toBe(false)
    expect(run.startDetection()).toBe(false)
    release()
    await pass

    expect(broughtUp(run)).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.keys('launch').sort()).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.of('teardown')).toEqual([])
    expect(h.pendingExists()).toBe(false)
    expect(run.startDetection()).toBe(true)
    expect(h.pendingExists()).toBe(false)
    const cp = run.checkpoint()

    await run.ticks.tick()
    expect(h.pendingExists()).toBe(true)
    await run.ticks.ticks(20)

    expect(run.since(cp)).toEqual(pendingWritten())
    expect(h.readRecord()).toEqual(recordBytes)
    expect(h.readConfig()).toEqual(configBytes)
    expectNoPostNoLeak(run)
  })

  test('a leftover pending file is removed by the first check, logged once; a file placed later while nothing is pending is removed silently', async () => {
    const [alpha] = materialized('alpha')
    h.writeRecord(configOf(alpha!))
    h.writeConfig(configOf(alpha!))
    h.writePendingBytes(composePendingFile('0'.repeat(64), 'left over from before the restart'))

    const run = await h.startDetecting()
    expect(run.logsOf(RELOAD_NOTHING_PENDING)).toEqual([])
    const cp = run.checkpoint()
    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual(pendingRemoved())
    expect(h.pendingExists()).toBe(false)

    h.writePendingBytes('placed by hand')
    const later = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(later)).toEqual(pendingRemoved([]))
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('while a change stays pending, a missing or stale pending file is rewritten at the next check with no log line, and unchanged checks write nothing', async () => {
    const { run, recordBytes } = await running(['alpha'])
    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.tick()
    const current = h.readPending()!
    const rewritten = { ...NO_RUN_ACTIVITY, writes: [{ path: h.paths.pending, ok: true }] }

    let cp = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)

    const damage = [
      () => h.remove(h.paths.pending),
      () => void h.writePendingBytes(composePendingFile('0'.repeat(64), 'a stale preview placed by hand')),
      () => void h.writePendingBytes(Buffer.concat([current, Buffer.from('an edit to the preview\n')])),
    ]
    for (const spoil of damage) {
      spoil()
      cp = run.checkpoint()
      await run.ticks.tick()
      expect(run.since(cp)).toEqual(rewritten)
      expect(h.readPending()).toEqual(current)
      cp = run.checkpoint()
      await run.ticks.ticks(3)
      expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    }
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(1)
    expectNoPostNoLeak(run)
  })

  test('the preview is logged once per change of the pending state, not per check: a second edit logs once more, as does a return to the first', async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const cp = run.checkpoint()

    h.writeConfig(configOf(alpha!))
    await run.ticks.ticks(5)
    const first = h.pendingFingerprint()
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(1)

    h.writeConfig({ ...configOf(alpha!, bravo!), stop_timeout: 45 })
    await run.ticks.ticks(5)
    const second = h.pendingFingerprint()
    expect(second).not.toBe(first)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(2)

    h.writeConfig(configOf(alpha!))
    await run.ticks.ticks(5)
    expect(h.pendingFingerprint()).toBe(first)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(3)
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.since(cp).writes).toHaveLength(3)
    expectNoPostNoLeak(run)
  })

  // The INVALID line's class is Task 3's (reload-preview now, reload-invalid then): one line is matched, whatever its class.
  test.each([
    { label: 'missing', edit: () => h.deleteConfig() },
    { label: 'unreadable (a directory at its path)', edit: () => h.replaceWithDirectory(h.paths.config) },
    { label: 'malformed (a syntax error around a pasted token)', edit: () => void h.writeConfigBytes(malformedWithSentinel()) },
  ])('an INVALID candidate: a config file that is $label while a record exists is pending and applies nothing; the record bytes clear it', async ({ edit }) => {
    const { run, recordBytes } = await running(['alpha'])
    const cp = run.checkpoint()

    edit()
    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual(pendingWritten(expect.stringMatching(/^\[slack\] /)))
    expect(h.readPendingText()).toContain('INVALID: ')
    // The pending file (a written file) is checked for the pasted token while it still exists: the revert removes it.
    assertNoLeak(run.captured())

    h.remove(h.paths.config)
    h.writeConfigBytes(recordBytes)
    const back = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(back)).toEqual(pendingRemoved())
    expectNoPostNoLeak(run)
  })

  // Director decision 5: the tick writes loader errors into the pending file and the log on every
  // pending-state change, so a key named with a pasted token must never be echoed there.
  test.each<{ level: string; edit: (alpha: PersonaInput) => Record<string, unknown> }>([
    { level: 'top-level', edit: (alpha) => ({ ...configOf(alpha), [LEAK_SENTINEL]: 1, chanels: [] }) },
    { level: 'persona entry', edit: (alpha) => configOf({ ...alpha, [LEAK_SENTINEL]: 1, chanels: [] } as PersonaInput) },
  ])('an unknown $level key named with a pasted token is an INVALID candidate whose pending file and log never echo it, while a typo beside it is named', async ({ edit }) => {
    const { run, personas, recordBytes } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeConfigBytes(JSON.stringify(edit(personas[0]!)))
    await run.ticks.ticks(5)

    // Checked first, while the pending file exists: captured() holds it as a written file.
    assertNoLeak(run.captured())
    expect(run.since(cp)).toEqual(pendingWritten(expect.stringMatching(/^\[slack\] /)))
    const text = h.readPendingText()
    expect(text).toContain('INVALID: ')
    expect(text).toContain('"chanels", plus 1 field whose name is not shown')
    expect(run.since(cp).logs[0]).toContain('"chanels", plus 1 field whose name is not shown')

    h.writeConfigBytes(recordBytes)
    const back = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(back)).toEqual(pendingRemoved())
    expectNoPostNoLeak(run)
  })

  test('the fingerprint is stable over unchanged checks and follows the config bytes and each referenced credentials file (bytes, empty, missing, unreadable), never an unreferenced one', async () => {
    const [charlie] = materialized('charlie')
    const { run, personas, recordBytes } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.tick()
    const fingerprints = [h.pendingFingerprint()]
    const cp = run.checkpoint()

    await run.ticks.ticks(3)
    h.writeCredentials(charlie!)
    await run.ticks.ticks(3)
    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingFingerprint()).toBe(fingerprints[0])

    const edits = [
      () => void h.writeConfigBytes(withNewline(withNewline(recordBytes))),
      () => void h.writeCredentials(alpha!),
      () => void h.writeCredentialsContent(bravo!, ''),
      () => h.deleteCredentials(bravo!),
      () => h.makeCredentialsUnreadable(bravo!),
    ]
    for (const edit of edits) {
      edit()
      await run.ticks.tick()
      fingerprints.push(h.pendingFingerprint())
    }
    expect(fingerprints.every((fp) => fp !== undefined)).toBe(true)
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Detection: credentials files (b.av2 SR-8.3; AC 67 detection half, AC 72)
// ---------------------------------------------------------------------------

describe('detection compares each referenced credentials file with what its persona holds', () => {
  test("AC 67 (detection half): a token rotated inside an up persona's credentials file is pending, named by persona and path, with no reconnect and no token in the pending file or the log", async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha] = personas
    const filesBefore = readdirSync(h.root, { recursive: true }).map(String).sort()
    const cp = run.checkpoint()

    h.writeCredentials(alpha!)
    await run.ticks.ticks(20)

    const since = run.since(cp)
    expect(since).toEqual(pendingWritten())
    expect(since.logs[0]).toContain(credentialsChangedLine(alpha!))
    expect(h.readPendingText()).toContain(credentialsChangedLine(alpha!))
    expect(h.readPendingText()).not.toContain('"bravo"')
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('up')
    // Digests stay in memory: the tick wrote the pending file and nothing else, anywhere under the root.
    expect(run.writes).toEqual([{ path: h.paths.pending, ok: true }])
    expect(readdirSync(h.root, { recursive: true }).map(String).sort()).toEqual(
      [...filesBefore, join('config', 'config.json.pending')].sort(),
    )
    expectNoPostNoLeak(run)
  })

  type Edit = (persona: PersonaInput) => void
  const rotate: Edit = (p) => void h.writeCredentials(p)
  const addNewline: Edit = (p) => void h.writeCredentialsContent(p, withNewline(h.readCredentialsBytes(p)!).toString('utf-8'))
  const remove: Edit = (p) => h.deleteCredentials(p)
  const unreadable: Edit = (p) => h.makeCredentialsUnreadable(p)
  const nothing: Edit = () => undefined

  test.each<{ label: string; before: Edit; slack?: StubSlackOptions; outcome: PersonaBringUpOutcome; edit: Edit }>([
    { label: 'up, its token rotated', before: rotate, outcome: 'up', edit: rotate },
    { label: 'up, its file deleted', before: rotate, outcome: 'up', edit: remove },
    { label: 'up, its file made unreadable', before: rotate, outcome: 'up', edit: unreadable },
    { label: 'retrying (Slack unreachable), its token rotated', before: rotate, slack: SLACK_UNREACHABLE, outcome: 'retrying', edit: rotate },
    {
      label: 'broken because Slack refused its token, re-saved with only a trailing newline added',
      before: rotate,
      slack: SLACK_AUTH_REJECTED,
      outcome: 'broken',
      edit: addNewline,
    },
    { label: 'broken by invalid content, the file fixed', before: (p) => void h.writeCredentialsContent(p, 'not json'), outcome: 'broken', edit: rotate },
    { label: 'broken by a missing file, the file created', before: nothing, outcome: 'broken', edit: rotate },
    { label: 'broken by a missing file, made unreadable', before: nothing, outcome: 'broken', edit: unreadable },
    { label: 'broken by an unreadable file, the file deleted', before: unreadable, outcome: 'broken', edit: remove },
  ])('a persona $label is a pending credentials change; putting back what it holds clears it', async ({ before, slack, outcome, edit }) => {
    const [bravo] = materialized('bravo')
    const alpha = h.persona('alpha')
    h.makeWorkingDirectory(alpha)
    before(alpha)
    h.writeRecord(configOf(alpha, bravo!))
    h.writeConfig(configOf(alpha, bravo!))
    const run = await h.startDetecting({ slack: slack === undefined ? undefined : { alpha: slack } })
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe(outcome)
    await run.ticks.ticks(3)
    expect(h.pendingExists()).toBe(false)
    const restore = h.saveCredentials(alpha)
    const cp = run.checkpoint()

    edit(alpha)
    await run.ticks.ticks(10)

    const since = run.since(cp)
    expect(since).toEqual(pendingWritten())
    expect(since.logs[0]).toContain(credentialsChangedLine(alpha))
    expect(h.readPendingText()).toContain(credentialsChangedLine(alpha))
    expect(h.readPendingText()).not.toContain('"bravo"')

    restore()
    const back = run.checkpoint()
    await run.ticks.ticks(10)
    expect(run.since(back)).toEqual(pendingRemoved())
    expectNoPostNoLeak(run)
  })

  test('a credentials file the config file does not reference is never compared', async () => {
    const [charlie] = materialized('charlie')
    const { run } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeCredentials(charlie!)
    await run.ticks.ticks(5)
    h.deleteCredentials(charlie!)
    await run.ticks.ticks(5)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  /**
   * A running server whose record and config file (byte-equal) hold alpha,
   * bravo sharing alpha's credentials file (an SR-1.5 record-start
   * collision) and charlie; detection started and its first check run.
   */
  async function sharedCredentialsRunning(): Promise<{ run: ReloadRun; alpha: PersonaInput; bravo: PersonaInput; charlie: PersonaInput }> {
    const [alpha, charlie] = materialized('alpha', 'charlie')
    const bravo = h.persona('bravo', { credentials_file: alpha!.credentials_file })
    h.makeWorkingDirectory(bravo)
    h.writeRecord(configOf(alpha!, bravo, charlie!))
    h.writeConfig(configOf(alpha!, bravo, charlie!))
    const run = await h.startDetecting()
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    return { run, alpha: alpha!, bravo, charlie: charlie! }
  }

  test("decision 1 reversed: two personas broken by a shared credentials file each hold its bytes' digest, so re-saving it is pending for both; putting the bytes back clears it", async () => {
    const { run, alpha, bravo, charlie } = await sharedCredentialsRunning()
    for (const name of ['alpha', 'bravo']) {
      expect(run.lifecycle.outcome(h.key(name))).toBe('broken')
      expect(run.lifecycle.classes(h.key(name))).toEqual(['persona-credentials-invalid'])
      expect(run.bringUps.credentialsDigest(h.key(name))).toBe(h.credentialsDigestOf(alpha))
      // Hashed only: no Slack client was built for either.
      expect(run.slack.buildsOf(h.key(name))).toEqual([])
    }
    expect(run.lifecycle.outcome(h.key('charlie'))).toBe('up')
    const restore = h.saveCredentials(alpha)
    const cp = run.checkpoint()

    addNewline(alpha)
    await run.ticks.ticks(5)

    const since = run.since(cp)
    expect(since).toEqual(pendingWritten())
    for (const persona of [alpha, bravo]) {
      expect(since.logs[0]).toContain(credentialsChangedLine(persona))
      expect(h.readPendingText()).toContain(credentialsChangedLine(persona))
    }
    expect(h.readPendingText()).not.toContain(credentialsChangedLine(charlie))

    restore()
    const back = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(back)).toEqual(pendingRemoved())
    expectNoPostNoLeak(run)
  })

  // The case behind the reversal: once the collision is fixed by giving bravo its own file, alpha's
  // declaration is unchanged, so only its held digest lets a re-save of its file show as pending.
  test("decision 1 reversed: with the collision fixed in the config file (bravo given its own file), a re-save of alpha's file adds alpha's credentials change to what is pending; reverting its bytes takes it out again", async () => {
    const { run, alpha, bravo, charlie } = await sharedCredentialsRunning()
    const bravoOwn = h.persona('bravo')
    h.writeCredentials(bravoOwn)
    expect(bravoOwn.credentials_file).not.toBe(bravo.credentials_file)
    const cp = run.checkpoint()

    h.writeConfig(configOf(alpha, bravoOwn, charlie))
    await run.ticks.ticks(3)
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(h.readPendingText()).not.toContain('credentials changed')
    const configOnly = h.pendingFingerprint()

    const restore = h.saveCredentials(alpha)
    const resaved = run.checkpoint()
    addNewline(alpha)
    await run.ticks.ticks(3)
    expect(run.since(resaved)).toEqual(pendingWritten())
    expect(h.readPendingText()).toContain(credentialsChangedLine(alpha))
    // Bravo's path changed: it is pending by the config bytes only, never compared by content.
    expect(h.readPendingText()).not.toContain(`credentials changed: "bravo"`)
    expect(h.readPendingText()).not.toContain(`credentials changed: "charlie"`)
    assertNoLeak(run.captured())

    restore()
    const reverted = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(reverted)).toEqual(pendingWritten())
    expect(h.readPendingText()).not.toContain('credentials changed')
    expect(h.pendingFingerprint()).toBe(configOnly)
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })

  test("a persona whose credentials_file path changed is pending by the config bytes; its new file is not compared with the old one's held content", async () => {
    const { run, personas } = await running(['alpha'])
    const [alpha] = personas
    const moved = { ...alpha!, credentials_file: join(dirname(alpha!.credentials_file), 'moved-credentials.json') }
    h.writeCredentials(moved)
    const cp = run.checkpoint()

    h.writeConfig(configOf(moved))
    await run.ticks.ticks(3)
    const first = h.pendingFingerprint()
    expect(h.pendingExists()).toBe(true)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(1)
    expect(h.readPendingText()).not.toContain('credentials changed')

    // An edit of the new file changes the fingerprint only.
    h.writeCredentials(moved)
    await run.ticks.ticks(3)
    expect(h.pendingFingerprint()).not.toBe(first)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(2)
    expect(h.readPendingText()).not.toContain('credentials changed')

    // The old file is no longer referenced: an edit of it changes nothing.
    const quiet = run.checkpoint()
    const second = h.pendingFingerprint()
    h.writeCredentials(alpha!)
    await run.ticks.ticks(3)
    expect(run.since(quiet)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingFingerprint()).toBe(second)
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })

  test('AC 72 (pending half): the next start from the record applies a pending credentials rotation, and its first check removes the leftover pending file', async () => {
    const { run: first, personas } = await running(['alpha'])
    const rotated = h.writeCredentials(personas[0]!)
    await first.ticks.tick()
    expect(h.pendingExists()).toBe(true)
    await first.stop()

    const run = await h.startDetecting()
    const key = h.key('alpha')
    expect(run.outcome).toMatchObject({ kind: 'applied', source: 'record' })
    expect(run.lifecycle.outcome(key)).toBe('up')
    expect(run.slack.buildsOf(key, 'validation')[0]!.hasToken(rotated.botToken)).toBe(true)
    expect(run.slack.buildsOf(key, 'socket')[0]!.hasToken(rotated.appToken)).toBe(true)
    expect(h.pendingExists()).toBe(true)
    const cp = run.checkpoint()
    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual(pendingRemoved())
    expectNoPostNoLeak(first, run)
  })

  // In a child process with a 10 s bound: a blocking open of a FIFO with no
  // writer never returns, so in-process it would hang the whole suite.
  test.skipIf(!mkfifoAvailable()).each(['config file', 'credentials file'] as const)(
    'a FIFO at the referenced %s path leaves each check bounded and counts as unreadable (child process, 10 s bound; skipped where mkfifo is unavailable)',
    (which) => {
      const { result, stderr } = runHarnessInChild<{
        config: string
        alpha: PersonaInput
        pending: string | null
        since: ReloadRunActivity
      }>(`
        const alpha = h.persona('alpha')
        h.materialize(alpha)
        h.writeRecord({ personas: [alpha] })
        h.writeConfig({ personas: [alpha] })
        const run = await h.startDetecting()
        await run.ticks.tick()
        const cp = run.checkpoint()
        h.makeFifo(${JSON.stringify(which)} === 'config file' ? h.paths.config : alpha.credentials_file)
        await run.ticks.ticks(3)
        console.log(JSON.stringify({ config: h.paths.config, alpha, pending: h.readPendingText() ?? null, since: run.since(cp) }))
      `)

      // One pending-file write and one log line; no lifecycle call, Slack client or Slack call.
      expect({ ...result.since, logs: NO_RUN_ACTIVITY.logs, writes: NO_RUN_ACTIVITY.writes }).toEqual(NO_RUN_ACTIVITY)
      expect(result.since.writes).toEqual([{ path: `${result.config}.pending`, ok: true }])
      expect(result.since.logs).toHaveLength(1)
      expect(result.pending).toContain(
        which === 'config file'
          ? `INVALID: the configuration file "${result.config}" cannot be read`
          : `credentials changed: "alpha" (key=${h.key('alpha')}) credentials_file="${result.alpha.credentials_file}"`,
      )
      assertNoLeak({ result, stderr })
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// Detection in dry run (b.av2 SR-8.2)
// ---------------------------------------------------------------------------

describe('in dry run, detection ignores credentials files', () => {
  test('a credentials rotation with the config file equal to the record is never pending', async () => {
    const [alpha] = materialized('alpha')
    h.writeRecord(configOf(alpha!))
    h.writeConfig(configOf(alpha!))
    const run = await h.startDetecting({ dryRun: true })
    // A dry-run bring-up reads no credentials file, so nothing is held to compare with.
    expect(run.bringUps.credentialsDigest(h.key('alpha'))).toBeUndefined()
    const cp = run.checkpoint()

    h.writeCredentials(alpha!)
    await run.ticks.ticks(5)
    h.deleteCredentials(alpha!)
    await run.ticks.ticks(5)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('with a config edit pending, the fingerprint covers the config file alone and a credentials change rewrites nothing', async () => {
    const [alpha] = materialized('alpha')
    const recordBytes = h.writeRecord(configOf(alpha!))
    h.writeConfigBytes(withNewline(recordBytes))
    const run = await h.startDetecting({ dryRun: true })
    await run.ticks.tick()
    const fingerprint = h.pendingFingerprint()
    expect(fingerprint).toBe(reloadFingerprint(h.readConfig()!, []))
    const cp = run.checkpoint()

    h.writeCredentials(alpha!)
    await run.ticks.ticks(5)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingFingerprint()).toBe(fingerprint)
    expect(h.readPendingText()).not.toContain('credentials changed')
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Pending-file write and delete failures
// ---------------------------------------------------------------------------

describe('a pending-file write or delete that fails is logged once per episode and retried', () => {
  test.each([
    { step: 'openSync', code: 'EIO' },
    { step: 'renameSync', code: 'EROFS' },
  ] as const)('a write failing at $step ($code) is logged once over many checks, applies nothing, and succeeds at the first check after', async ({ step, code }) => {
    const { run, recordBytes } = await running(['alpha'])
    h.failWrites({ step, code })
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(10)

    const failedWrites = (n: number) => Array.from({ length: n }, () => ({ path: h.paths.pending, ok: false }))
    const since = run.since(cp)
    expect(since.logs.filter((l) => !l.startsWith(`[slack] ${RELOAD_PREVIEW}: `))).toEqual([fileFailureLine(code)])
    expect(since.logs).toHaveLength(2)
    expect(since.writes).toEqual(failedWrites(10))
    expect({ ...since, logs: NO_RUN_ACTIVITY.logs, writes: NO_RUN_ACTIVITY.writes }).toEqual(NO_RUN_ACTIVITY)
    expect(h.configDirEntries()).toEqual(['config.json', 'config.json.last-applied'])

    h.clearWriteFailure()
    const cleared = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(cleared)).toEqual({ ...NO_RUN_ACTIVITY, writes: [{ path: h.paths.pending, ok: true }] })
    expect(h.pendingExists()).toBe(true)

    // The success ended the episode: in the same pending state, the next failing write is logged again.
    h.remove(h.paths.pending)
    h.failWrites({ step, code })
    const again = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(again)).toEqual({ ...NO_RUN_ACTIVITY, logs: [fileFailureLine(code)], writes: failedWrites(5) })
    expectNoPostNoLeak(run)
  })

  test('a write whose directory sync fails is logged once and written again at the next check', async () => {
    const { run, recordBytes } = await running(['alpha'])
    // The second fsync is the directory's, after the rename.
    h.failWrites({ step: 'fsyncSync', call: 2 })
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(5)

    expect(run.since(cp).logs).toHaveLength(2)
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(1)
    expect(run.logsOf('reload')).toEqual([fileFailureLine('EIO')])
    expect(run.since(cp).writes).toEqual([
      { path: h.paths.pending, ok: false },
      { path: h.paths.pending, ok: true },
    ])
    expect(h.pendingExists()).toBe(true)
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })

  test('a delete that fails after a revert is logged once over many checks; reload-nothing-pending follows the delete that succeeds', async () => {
    const { run, recordBytes } = await running(['alpha'])
    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.tick()
    h.failRemoves()
    const cp = run.checkpoint()

    h.writeConfigBytes(recordBytes)
    await run.ticks.ticks(10)

    const failedRemoves = (n: number) =>
      Array.from({ length: n }, () => ({ path: h.paths.pending, ok: false, removed: undefined, unsynced: false }))
    expect(run.since(cp)).toEqual({ ...NO_RUN_ACTIVITY, logs: [fileFailureLine('EIO')], removes: failedRemoves(10) })
    expect(h.pendingExists()).toBe(true)

    h.clearRemoveFailure()
    const cleared = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(cleared)).toEqual(pendingRemoved())

    // The success ended the episode: with nothing pending still, the next failing delete is logged again.
    h.writePendingBytes('placed by hand')
    h.failRemoves()
    const again = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(again)).toEqual({ ...NO_RUN_ACTIVITY, logs: [fileFailureLine('EIO')], removes: failedRemoves(5) })
    expectNoPostNoLeak(run)
  })

  test('a delete whose directory sync fails counts as removed: logged once, then reload-nothing-pending, and never retried', async () => {
    const { run, recordBytes } = await running(['alpha'])
    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.tick()
    h.failRemoves({ step: 'fsyncSync' })
    const cp = run.checkpoint()

    h.writeConfigBytes(recordBytes)
    await run.ticks.ticks(5)

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [fileFailureLine('EIO'), nothingPendingRemoved()],
      removes: [{ path: h.paths.pending, ok: true, removed: true, unsynced: true }],
    })
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('each change of the pending state starts a new episode: with writes failing, an edit, a revert and the same edit again log the write failure twice', async () => {
    const { run, recordBytes } = await running(['alpha'])
    h.failWrites()
    const cannotWrite = fileFailureLine('EIO')
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(3)
    expect(run.logsOf('reload')).toEqual([cannotWrite])

    // Nothing was ever written, so the revert has nothing to remove.
    h.writeConfigBytes(recordBytes)
    await run.ticks.ticks(3)
    expect(run.logsOf(RELOAD_NOTHING_PENDING)).toEqual([NOTHING_PENDING])

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(3)
    expect(run.logsOf('reload')).toEqual([cannotWrite, cannotWrite])
    expect(run.logsOf(RELOAD_PREVIEW)).toHaveLength(2)
    expect(run.since(cp).removes).toEqual([])
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })

  test('a detection check that throws is logged once over many checks, and the next good check writes the pending file', async () => {
    let lookupFails = false
    const { run, recordBytes } = await running(['alpha'], {
      heldCredentialsDigest: (key, held) => {
        if (lookupFails) throw new Error('the held-digest lookup failed')
        return held(key)
      },
    })
    lookupFails = true
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual({ ...NO_RUN_ACTIVITY, logs: [expect.stringMatching(/^\[slack\] reload: detection check failed/)] })
    expect(h.pendingExists()).toBe(false)

    lookupFails = false
    const good = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(good)).toEqual(pendingWritten())
    expectNoPostNoLeak(run)
  })
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
