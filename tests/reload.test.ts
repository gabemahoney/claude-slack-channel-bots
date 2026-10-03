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
 * presence and fingerprint, lifecycle calls and the log; the preview itself
 * (b.av2 SR-8.4) is asserted as the tick writes and logs it: the pending
 * file's body, its logged emission (the same lines, each classed
 * `reload-preview`, once per pending-state change), the INVALID form
 * (`reload-invalid`), an added persona that cannot come up, a changed
 * claude_config_dir (own or the top-level default) that cannot be resolved,
 * warned about and still applied once confirmed, and a fact the tick could
 * not gather. The plan and renderer on their own are
 * `reload-preview.test.ts`'s. Confirmation and apply (SR-8.5, SR-8.6): the
 * rename that applies (AC 73), invalid (AC 63), stale (AC 69), malformed,
 * unreadable and undeletable confirmations, step 1's record write and its
 * failures (an apply that removes a persona writes the retired-key record
 * first, b.jg5 SRJ-803, and a failed rewrite puts it back, SRJ-804: here
 * only as the writes, deletes and lines each case asserts exactly; what step
 * 1 records and restores is `reload-apply.test.ts`'s), the pending file
 * rewritten after a consumed confirmation (AC 56),
 * `reload-noop`, and the order of the step 2–6 slots. Confirmed credentials
 * changes end to end (SR-6.4, SR-8.3, SR-8.6): a persona credentials-broken
 * at start comes up once its file is fixed and the change confirmed, and
 * only then (AC 65); a failed change stays pending; the held content follows
 * the outcome. The 64 KiB read cap on
 * the start, tick and confirmation paths. Token secrecy on the reload path
 * (SR-10.3, AC 20): a Slack token pasted under a `bot_token` or `app_token`
 * key is an INVALID candidate on a running server, a confirmed one and a
 * refused start (from the config file or a hand-edited record), with every
 * server-side file under the temp root leak-checked. A token-shaped persona
 * name is not a secret (b.av2 SR-1.2, no format rule): renaming a persona to
 * one, or adding one, is a valid candidate previewed and applied with the
 * name as written, and a start from the config file or the record with one
 * starts. Every test runs `assertNoLeak` over what each run captured and
 * checks no Slack post, except the one pure case of the default step 3 body
 * (`lifecycleApplySlots` gives each persona one in-place update), which
 * builds no run and handles no token. The token-shaped-name runs' artifacts
 * are asserted to hold that name (built by `fakeToken`, so it carries the
 * sentinel), so they run `assertNoLeak` with the name and its key masked
 * (`withoutName`): the rest, credential values included, is still checked.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_PERSONA_CONFIG_FS,
  prePersonaConversionMessage,
  type Persona,
  type PersonaConfigFs,
  type PersonaInput,
} from '../src/config.ts'
import type { PersonaBringUpOutcome, PersonaCredentialsChangeResult } from '../src/persona-bringup-controller.ts'
import { CREDENTIALS_UNREADABLE_MARKER } from '../src/persona-credentials.ts'
import {
  formatCredentialsChangeFailed,
  type CredentialsChangeKept,
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
} from '../src/persona-diagnostics.ts'
import {
  RELOAD_APPLIED,
  RELOAD_INVALID,
  RELOAD_NOOP,
  RELOAD_NOTHING_PENDING,
  RELOAD_PREVIEW,
  RELOAD_RECORD_WRITE_FAILED,
  RELOAD_STALE_CONFIRMATION,
} from '../src/reload.ts'
import {
  APPLY_STEPS,
  lifecycleApplySlots,
  type ApplyLifecycleMembers,
  type ApplyStepInputs,
  type ApplyStepName,
  type ApplyStepSlots,
  type InPlaceApplyInput,
} from '../src/reload-apply.ts'
import { composePendingFile, PENDING_FILE_HEADER, reloadFingerprint } from '../src/reload-fingerprint.ts'
import { createReloadTickDriver } from '../src/reload-timer.ts'
import { DESTRUCTIVE_PREFIX, DESTRUCTIVE_RETIRED_CLAUSE, REMOVED_RETIRED_CLAUSE } from '../src/reload-plan.ts'
import { OLD_LIFE_HOLD_LOG_PREFIX, RETIRED_KEYS_LOG_PREFIX } from '../src/retired-keys.ts'
import {
  APP_TOKEN_PREFIX,
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  makeCredentials,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
  withoutName,
  writtenFile,
} from './test-helpers/credentials.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  makeReloadHarness,
  mkfifoAvailable,
  NO_RUN_ACTIVITY,
  SLACK_AUTH_REJECTED,
  SLACK_UNREACHABLE,
  type PreparedPersonaState,
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

/**
 * The loader's rejection of `alpha` then `alpha_2`, whose key starts with
 * `alpha`'s (the prefix-related key rule, b.1ix follow-up), after the
 * `Persona config validation error: ` prefix.
 */
function prefixRelatedKeysRejection(): string {
  return (
    `personas[1] "alpha_2" (key=${h.key('alpha_2')}): key alpha_2 starts with the key of personas[0] "alpha" (key=${h.key('alpha')}). ` +
    'tmux matches a session name by its start, so once slack_bot_alpha is gone, a command meant for it ' +
    '(reading its pane, typing into it, ending it) can act on slack_bot_alpha_2. ' +
    "No persona's key may start with another persona's key: rename one of the two so that neither key starts with the other. " +
    'For example, rename personas[0] "alpha" (key=alpha) to "alpha_main" (key=alpha_main).'
  )
}

/** A symlink `<root>/<name>` to `<root>/<name>-target`, which does not exist; returns the link's path. */
function danglingLink(name: string): string {
  const link = join(h.root, name)
  symlinkSync(join(h.root, `${name}-target`), link)
  return link
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

/** The end of a logged preview's first line while the pending file (`h.paths.pending` unless given) holds it. */
function previewFileSuffix(pendingFile: string = h.paths.pending): string {
  return ` (preview in ${JSON.stringify(pendingFile)})`
}

/**
 * The log lines of one preview emission (b.av2 SR-8.4, SR-10.3): each of
 * `lines` (the pending file's preview body by default) classed
 * `reload-preview`, the first pointing at the pending file (`pendingFile`,
 * `h.paths.pending` by default) unless `written` is false (the write failed).
 */
function loggedPreview(lines: string[] | undefined = h.pendingLines(), written = true, pendingFile?: string): string[] {
  expect(lines).toBeDefined()
  return lines!.map((line, i) => `[slack] ${RELOAD_PREVIEW}: ${line}${i === 0 && written ? previewFileSuffix(pendingFile) : ''}`)
}

/**
 * A stretch of checks that wrote the pending file once and logged `logs`,
 * nothing else. By default `logs` is the preview the file now holds, logged
 * once: so the logged preview is the file's body, line for line.
 */
function pendingWritten(logs: string[] = loggedPreview()): ReloadRunActivity {
  return { ...NO_RUN_ACTIVITY, logs, writes: [{ path: h.paths.pending, ok: true }] }
}

/** The preview header's counts, every term defaulting to 0. */
interface PreviewCounts {
  added?: number
  removed?: number
  destructive?: number
  inPlace?: number
  credentials?: number
  settings?: number
}

/** The counts as the preview header and the `reload-applied` line word them. */
function countsText(c: PreviewCounts): string {
  return (
    `personas: ${c.added ?? 0} added, ${c.removed ?? 0} removed, ${c.destructive ?? 0} destructively modified, ` +
    `${c.inPlace ?? 0} modified in place, ${c.credentials ?? 0} with changed credentials; ` +
    `server-wide settings: ${c.settings ?? 0} changed`
  )
}

/** A valid candidate's preview header (b.av2 SR-8.4) with these counts. */
function previewHeader(c: PreviewCounts = {}): string {
  return `A configuration change is pending; nothing has been applied. ${countsText(c)}.`
}

/** The whole preview of a candidate with no effect. */
const NO_EFFECTIVE_CHANGE_PREVIEW =
  'A configuration change is pending; nothing has been applied. no effective change: applying it would change ' +
  'no persona and no server-wide setting.'

/** An INVALID candidate's whole preview body: the error and that nothing will be applied. */
function invalidPreview(error: string): string[] {
  return [`INVALID: ${error} Nothing will be applied.`]
}

/**
 * The one `reload-invalid` line of an INVALID candidate, pointing at the
 * pending file (`pendingFile`, `h.paths.pending` by default) unless the
 * write failed.
 */
function invalidLogged(error: string, written = true, pendingFile?: string): string {
  return (
    `[slack] ${RELOAD_INVALID}: the pending configuration is invalid and nothing will be applied: ${error}` +
    (written ? previewFileSuffix(pendingFile) : '')
  )
}

/** A persona's JSON-quoted name and key, as every preview line names it. */
function personaRef(name: string): string {
  return `persona ${JSON.stringify(name)} (key=${h.key(name)})`
}

/** The `DESTRUCTIVE:` line of a removed persona: it will be retired (b.jg5 SRJ-1510), from the exported clause. */
function removedLine(name: string): string {
  return `${DESTRUCTIVE_PREFIX} ${personaRef(name)} is removed: ${REMOVED_RETIRED_CLAUSE}.`
}

/**
 * The `DESTRUCTIVE:` line of a persona whose one destructive `setting`
 * changed to `path`: it will be retired and brought up fresh (b.jg5
 * SRJ-1510), from the exported clause.
 */
function destructiveLine(name: string, setting: 'credentials_file' | 'working_directory', path: string): string {
  return `${DESTRUCTIVE_PREFIX} ${personaRef(name)} ${setting} changed to ${JSON.stringify(path)}: ${DESTRUCTIVE_RETIRED_CLAUSE}.`
}

/** The line of an added persona: brought up and launched, or `causes` saying why it cannot come up. */
function addedLine(name: string, causes: string[] = []): string {
  return causes.length === 0
    ? `${personaRef(name)} is added: it will be brought up and launched.`
    : `${personaRef(name)} is added but cannot come up: ${causes.join('; ')}.`
}

/** A stretch of checks that removed the pending file once and logged `logs` (`reload-nothing-pending`, file removed, by default), nothing else. */
function pendingRemoved(logs: string[] = [nothingPendingRemoved()]): ReloadRunActivity {
  return { ...NO_RUN_ACTIVITY, logs, removes: [{ path: h.paths.pending, ok: true, removed: true, unsynced: false }] }
}

/** Matches a failure line by its opening words, the quoted `path` and the errno code (not the rest of its wording). */
function failureLine(opening: string, path: string, code: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return expect.stringMatching(new RegExp(`^${escape(opening)}.*"${escape(path)}".*\\(${code}\\)`))
}

/** Matches a pending-file write or delete failure line: the `[slack] reload:` prefix, the pending path and the errno code (not its wording). */
function fileFailureLine(code: string): string {
  return failureLine('[slack] reload: ', h.paths.pending, code)
}

/**
 * Run `body` (statements over `h`, a harness under this test's root) in a
 * child `bun` process with a 10 s bound, so a blocking FIFO open fails the
 * test instead of hanging the suite. `body` prints one JSON line; returns it
 * parsed, and the child's stderr. The child starts no process of its own
 * except `mkfifo`, through `h.makeFifo` (the shared FIFO helper), so `mkfifo`
 * is its only tool; only cases guarded by `mkfifoAvailable()` call this.
 */
function runHarnessInChild<T>(body: string): { result: T; stderr: string } {
  const harnessPath = join(import.meta.dir, 'test-helpers', 'reload-harness.ts')
  const script = `
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
    env: hostSafeChildEnv(h.home, { tools: ['mkfifo'], extras: { SLACK_STATE_DIR: join(h.home, 'state') } }),
  })
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  return { result: JSON.parse(child.stdout.trim()) as T, stderr: child.stderr }
}

/**
 * A credentials change's previewed effect (b.av2 SR-8.6, credentials row), by
 * the persona's bring-up state and whether the new content can be used:
 * - `reconnect`: up, content valid (a new connection, then the old one closes);
 * - `kept`: up, content unusable (the current connection is kept);
 * - `retry`: retrying, with no connection yet: it retries with valid new
 *   content, and keeps retrying with its current content when the new one is
 *   unusable;
 * - `bring-up`: broken by its credentials, content valid;
 * - `stays-broken`: broken by its credentials, content still unusable;
 * - `unchecked`: its bring-up state could not be checked (valid or unusable content).
 */
type CredentialsEffect = 'reconnect' | 'kept' | 'retry' | 'bring-up' | 'stays-broken' | 'unchecked'

/** The effects that only follow unusable content, and those that only follow valid content. */
const UNUSABLE_ONLY: readonly CredentialsEffect[] = ['kept', 'stays-broken']
const VALID_ONLY: readonly CredentialsEffect[] = ['reconnect', 'bring-up']

/**
 * The preview line naming `persona` as a credentials change, by its
 * JSON-quoted name and key and its credentials file's path (never content),
 * with `effect`. `cause` is why the new content cannot be used (the
 * credentials check's token-free wording), undefined when it is valid.
 */
function credentialsChangedLine(persona: PersonaInput, effect: CredentialsEffect = 'reconnect', cause?: string): string {
  if (cause === undefined ? UNUSABLE_ONLY.includes(effect) : VALID_ONLY.includes(effect)) {
    throw new Error(`credentialsChangedLine: effect ${effect} ${cause === undefined ? 'needs' : 'takes no'} cause`)
  }
  const changed = `${personaRef(persona.name)}: credentials file ${JSON.stringify(persona.credentials_file)} changed`
  const head = cause === undefined ? changed : `${changed}, but it cannot be used (${cause})`
  switch (effect) {
    case 'reconnect':
      return `${changed}: a new connection opens, then the old one closes, instance kept.`
    case 'kept':
      return `${head}: the current connection is kept, instance kept.`
    case 'retry':
      // Unusable content is not taken: the persona keeps retrying with what it holds.
      return cause === undefined
        ? `${changed}: it has no connection yet, so it retries with the new content, instance kept.`
        : `${head}: it keeps retrying with its current content, instance kept.`
    case 'bring-up':
      return `${changed}: it is broken by its credentials now, so it will be brought up.`
    case 'stays-broken':
      return `${head}: it stays broken by its credentials.`
    case 'unchecked':
      return `${head}; whether it is broken by its credentials now could not be checked.`
  }
}

/** The credentials check's causes the tick cases below produce. */
const CREDENTIALS_MISSING = 'credentials file does not exist'
const CREDENTIALS_DIRECTORY = 'credentials file is a directory'
const CREDENTIALS_NOT_JSON = 'credentials file is invalid: not valid JSON'
const CREDENTIALS_BAD_PREFIX = 'credentials file is invalid: bot_token must start with xoxb-'

/** The pending preview's lines that state a credentials change (none when there is no pending file). */
function credentialsChangeLines(): string[] {
  return (h.pendingLines() ?? []).filter((line) => line.includes('credentials file "'))
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
    expect(run.writes).toEqual([h.lastAppliedWrite()])
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
      label: 'two personas whose keys are prefix-related (alpha and alpha_2, b.1ix follow-up)',
      bytes: () => JSON.stringify(configOf(h.persona('alpha'), h.persona('alpha_2'))),
      expected: () => `invalid persona config in "${h.paths.config}": Persona config validation error: ${prefixRelatedKeysRejection()}`,
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
    {
      label: 'larger than the 64 KiB read cap',
      setUp: () => void h.writeOversized(h.paths.config, { prefix: JSON.stringify(configOf(h.persona('alpha'))) }),
      expected: 'is larger than the 64 KiB limit',
    },
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
    expect(run.writes).toEqual([h.lastAppliedWrite(false)])
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
    expect(run.writes).toEqual([h.lastAppliedWrite(false)])
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
      label: 'is larger than the 64 KiB read cap',
      setUp: () => void h.writeOversized(h.paths.lastApplied, { prefix: JSON.stringify(configOf(h.persona('alpha'))) }),
      expected: () => `The last-applied record "${h.paths.lastApplied}" is larger than the 64 KiB limit.`,
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
      label: 'breaks the prefix-related key rule, which record mode keeps (alpha and alpha_2, b.1ix follow-up)',
      setUp: () => void h.writeRecord(configOf(h.persona('alpha'), h.persona('alpha_2'))),
      expected: () => `invalid persona config in "${h.paths.lastApplied}": Persona config validation error: ${prefixRelatedKeysRejection()}`,
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
    expect(run.previewEmissionCount()).toBe(1)
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
    expect(run.writes).toEqual([h.lastAppliedWrite()])
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
    expect(run.writes).toEqual(withRecord ? [] : [h.lastAppliedWrite()])
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
        h.makeFifo(fifo)
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

  test('only the config bytes differing from the record (one newline added) is a pending change, previewed and logged once as no effective change', async () => {
    const { run, recordBytes } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeConfigBytes(withNewline(recordBytes))
    await run.ticks.ticks(20)

    expect(run.since(cp)).toEqual(pendingWritten(loggedPreview([NO_EFFECTIVE_CHANGE_PREVIEW])))
    expect(h.readPendingText()?.startsWith(`${PENDING_FILE_HEADER}\n`)).toBe(true)
    expect(h.pendingFingerprint()).toMatch(/^[0-9a-f]{64}$/)
    expect(h.pendingLines()).toEqual([NO_EFFECTIVE_CHANGE_PREVIEW])
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
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  test('the preview is logged once per change of the pending state, not per check: a second edit logs once more, as does a return to the first', async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const cp = run.checkpoint()

    h.writeConfig(configOf(alpha!))
    await run.ticks.ticks(5)
    const first = h.pendingFingerprint()
    const firstPreview = h.pendingLines()
    expect(firstPreview?.[0]).toBe(previewHeader({ removed: 1 }))
    expect(run.previewEmissionCount()).toBe(1)
    expect(run.lastPreviewText()).toEqual(firstPreview)

    const second = run.checkpoint()
    h.writeConfig({ ...configOf(alpha!, bravo!), stop_timeout: 45 })
    await run.ticks.ticks(5)
    expect(h.pendingFingerprint()).not.toBe(first)
    // The setting line's wording is reload-preview.test.ts's; here the header counts it and the log is the file's body.
    expect(h.pendingHeader()).toBe(previewHeader({ settings: 1 }))
    expect(h.pendingLines()).toHaveLength(2)
    expect(run.since(second)).toEqual(pendingWritten())
    expect(run.previewEmissionCount()).toBe(2)

    const third = run.checkpoint()
    h.writeConfig(configOf(alpha!))
    await run.ticks.ticks(5)
    expect(h.pendingFingerprint()).toBe(first)
    expect(h.pendingLines()).toEqual(firstPreview)
    expect(run.since(third)).toEqual(pendingWritten())
    expect(run.previewEmissionCount()).toBe(3)
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.since(cp).writes).toHaveLength(3)
    expectNoPostNoLeak(run)
  })

  // b.av2 SR-8.4, SR-10.3: a pending invalid candidate reads INVALID with the loader's full error (or the missing or
  // unreadable file) and logs exactly one reload-invalid line per pending-state change, never reload-preview.
  test.each<{ label: string; edit: (alpha: PersonaInput) => void; error: (alpha: PersonaInput) => string }>([
    {
      label: 'has a JSON syntax error (around a pasted token)',
      edit: () => void h.writeConfigBytes(malformedWithSentinel()),
      error: () => `loadPersonaConfig: malformed JSON in "${h.paths.config}" at line 3, column 5.`,
    },
    {
      label: 'breaks the schema (an unknown delivery mode)',
      edit: (alpha) => void h.writeConfig(configOf({ ...alpha, channels: [{ id: alpha.channels![0]!.id, delivery: 'sometimes' as 'all' }] })),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        `personas[0] "alpha" (key=${h.key('alpha')}): channels[0].delivery is invalid. Allowed values are: all, mentions.`,
    },
    {
      label: 'has the pre-persona shape (the SR-1.7 conversion text)',
      edit: () => void h.writeConfig({ routes: {}, default_route: 'C0OLD' }),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        prePersonaConversionMessage('routes'),
    },
    {
      label: 'has a real-path collision (a second persona whose working_directory is a symlink to the first one’s), rejected in default mode',
      edit: (alpha) => {
        const link = join(dirname(h.persona('bravo').working_directory), 'link-to-alpha')
        h.makeWorkingDirectory({ working_directory: dirname(link) })
        symlinkSync(alpha.working_directory, link)
        h.writeConfig(configOf(alpha, h.persona('bravo', { working_directory: link })))
      },
      error: (alpha) =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        `personas[1] "bravo" (key=${h.key('bravo')}): working_directory ` +
        `${JSON.stringify(join(dirname(h.persona('bravo').working_directory), 'link-to-alpha'))} is also the working_directory of ` +
        `personas[0] "alpha" (key=${h.key('alpha')}): its working_directory ${JSON.stringify(alpha.working_directory)} and ` +
        `this one both resolve to ${JSON.stringify(alpha.working_directory)}. Each persona needs its own working_directory.`,
    },
    {
      label: 'adds a persona whose key starts with an applied persona’s key (alpha_2 beside alpha, b.1ix follow-up)',
      edit: (alpha) => void h.writeConfig(configOf(alpha, h.persona('alpha_2'))),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        prefixRelatedKeysRejection(),
    },
    { label: 'is missing', edit: () => h.deleteConfig(), error: () => `the configuration file "${h.paths.config}" does not exist.` },
    {
      label: 'is unreadable (a directory at its path)',
      edit: () => h.replaceWithDirectory(h.paths.config),
      error: () => `the configuration file "${h.paths.config}" cannot be read (EISDIR).`,
    },
  ])('an INVALID candidate: a config file that $label while a record exists reads INVALID, logs one reload-invalid line and applies nothing; a valid edit then logs the preview once, and the record bytes clear it', async ({ edit, error }) => {
    const { run, personas, recordBytes } = await running(['alpha'])
    const [alpha] = personas
    const cp = run.checkpoint()

    edit(alpha!)
    await run.ticks.ticks(10)

    // The pending file (a written file) is checked for the pasted token while it still exists: the revert removes it.
    assertNoLeak(run.captured())
    expect(h.pendingLines()).toEqual(invalidPreview(error(alpha!)))
    expect(run.since(cp)).toEqual(pendingWritten([invalidLogged(error(alpha!))]))
    expect(run.logsOf(RELOAD_PREVIEW)).toEqual([])

    // Corrected to a different, valid edit: the preview is logged once and the file rewritten.
    h.remove(h.paths.config)
    const corrected = run.checkpoint()
    h.writeConfig({ ...configOf(alpha!), stop_timeout: 45 })
    await run.ticks.ticks(5)
    expect(h.pendingHeader()).toBe(previewHeader({ settings: 1 }))
    expect(run.since(corrected)).toEqual(pendingWritten())
    expect(run.previewEmissionCount()).toBe(1)
    expect(run.invalidLines()).toHaveLength(1)

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
    const lines = h.pendingLines()!
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`INVALID: loadPersonaConfig: invalid persona config in "${h.paths.config}": `)
    expect(lines[0]).toEndWith(' Nothing will be applied.')
    expect(lines[0]).toContain('"chanels", plus 1 field whose name is not shown')
    // The one reload-invalid line carries the same error; no reload-preview line.
    const error = lines[0]!.slice('INVALID: '.length, -' Nothing will be applied.'.length)
    expect(run.since(cp)).toEqual(pendingWritten([invalidLogged(error)]))
    expect(run.logsOf(RELOAD_PREVIEW)).toEqual([])

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
  test("AC 67: a token rotated inside an up persona's credentials file (config.json byte-equal to the record) is previewed as a credentials line naming the persona and path, with no token anywhere and no reconnect before confirmation", async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha] = personas
    const filesBefore = readdirSync(h.root, { recursive: true }).map(String).sort()
    const cp = run.checkpoint()

    h.writeCredentials(alpha!)
    await run.ticks.ticks(20)

    // Checked while the pending file exists: neither the old nor the new token set (both sentinel-bearing) is in it or the log.
    assertNoLeak(run.captured())
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha!)])
    expect(h.pendingDestructiveLines()).toEqual([])
    // Logged once, as the file's body; no teardown, bring-up, launch or reconnect over the ticks.
    const since = run.since(cp)
    expect(since).toEqual(pendingWritten())
    expect(run.lastPreviewText()).toEqual(h.pendingLines())
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
  // Unusable content that carries the leak sentinel: the preview names the cause, never the content.
  const notJson: Edit = (p) => void h.writeCredentialsContent(p, `{${LEAK_SENTINEL}`)
  const badPrefix: Edit = (p) => void h.writeCredentialsContent(p, { bot_token: fakeToken('xoxp-') })

  // The preview's effect is decided by the persona's bring-up state and whether the new content can be used (b.av2
  // SR-8.6): up is reconnected when it can, else keeps its current connection; retrying retries with the new content
  // when it can, else keeps retrying with its current content;
  // broken by its credentials (a local credentials failure, or Slack refusing a token) is brought up when it can,
  // else stays broken. The cause is the credentials check's own wording over the bytes the tick read. A persona
  // broken by a missing file that is then created, or by invalid content that is then fixed, is the AC 65 (preview
  // half) case below.
  test.each<{
    label: string
    before: Edit
    slack?: StubSlackOptions
    outcome: PersonaBringUpOutcome
    edit: Edit
    effect: CredentialsEffect
    cause?: string
  }>([
    { label: 'up, its token rotated', before: rotate, outcome: 'up', edit: rotate, effect: 'reconnect' },
    { label: 'up, its file deleted', before: rotate, outcome: 'up', edit: remove, effect: 'kept', cause: CREDENTIALS_MISSING },
    {
      label: 'up, its file made unreadable',
      before: rotate,
      outcome: 'up',
      edit: unreadable,
      effect: 'kept',
      cause: CREDENTIALS_DIRECTORY,
    },
    {
      label: 'up, its file rewritten as malformed JSON holding a token',
      before: rotate,
      outcome: 'up',
      edit: notJson,
      effect: 'kept',
      cause: CREDENTIALS_NOT_JSON,
    },
    {
      label: 'up, its bot token replaced by one with the wrong prefix',
      before: rotate,
      outcome: 'up',
      edit: badPrefix,
      effect: 'kept',
      cause: CREDENTIALS_BAD_PREFIX,
    },
    {
      label: 'retrying (Slack unreachable), its token rotated',
      before: rotate,
      slack: SLACK_UNREACHABLE,
      outcome: 'retrying',
      edit: rotate,
      effect: 'retry',
    },
    {
      label: 'retrying (Slack unreachable), its file deleted',
      before: rotate,
      slack: SLACK_UNREACHABLE,
      outcome: 'retrying',
      edit: remove,
      effect: 'retry',
      cause: CREDENTIALS_MISSING,
    },
    {
      label: 'broken because Slack refused its token, re-saved with only a trailing newline added',
      before: rotate,
      slack: SLACK_AUTH_REJECTED,
      outcome: 'broken',
      edit: addNewline,
      effect: 'bring-up',
    },
    {
      label: 'broken because Slack refused its token, its file rewritten as malformed JSON holding a token',
      before: rotate,
      slack: SLACK_AUTH_REJECTED,
      outcome: 'broken',
      edit: notJson,
      effect: 'stays-broken',
      cause: CREDENTIALS_NOT_JSON,
    },
    {
      label: 'broken by a missing file, made unreadable',
      before: nothing,
      outcome: 'broken',
      edit: unreadable,
      effect: 'stays-broken',
      cause: CREDENTIALS_DIRECTORY,
    },
    {
      label: 'broken by an unreadable file, the file deleted',
      before: unreadable,
      outcome: 'broken',
      edit: remove,
      effect: 'stays-broken',
      cause: CREDENTIALS_MISSING,
    },
  ])('a persona $label is a pending credentials change previewed as $effect; putting back what it holds clears it', async ({ before, slack, outcome, edit, effect, cause }) => {
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
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, effect, cause)])
    expect(h.readPendingText()).not.toContain('"bravo"')
    assertNoLeak(run.captured())

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
    // Both are broken by their credentials (the collision), so each would be brought up, not reconnected.
    expect(h.pendingLines()).toEqual([
      previewHeader({ credentials: 2 }),
      credentialsChangedLine(alpha, 'bring-up'),
      credentialsChangedLine(bravo, 'bring-up'),
    ])
    expect(h.readPendingText()).not.toContain(JSON.stringify(charlie.name))
    // Checked while the pending file exists: the revert below removes it.
    assertNoLeak(run.captured())

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
    expect(credentialsChangeLines()).toEqual([])
    const configOnly = h.pendingFingerprint()
    const configOnlyPreview = h.pendingLines()

    const restore = h.saveCredentials(alpha)
    const resaved = run.checkpoint()
    addNewline(alpha)
    await run.ticks.ticks(3)
    expect(run.since(resaved)).toEqual(pendingWritten())
    // Alpha is still broken by the collision, so it would be brought up. Bravo's path changed: it is pending by the
    // config bytes only (its DESTRUCTIVE line), never compared by content; charlie is unchanged.
    expect(credentialsChangeLines()).toEqual([credentialsChangedLine(alpha, 'bring-up')])
    assertNoLeak(run.captured())

    restore()
    const reverted = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(reverted)).toEqual(pendingWritten())
    expect(credentialsChangeLines()).toEqual([])
    expect(h.pendingLines()).toEqual(configOnlyPreview)
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
    expect(run.previewEmissionCount()).toBe(1)
    expect(h.pendingLines()).toEqual([
      previewHeader({ destructive: 1 }),
      destructiveLine('alpha', 'credentials_file', moved.credentials_file),
    ])
    const preview = h.pendingLines()

    // An edit of the new file changes the fingerprint only.
    h.writeCredentials(moved)
    await run.ticks.ticks(3)
    expect(h.pendingFingerprint()).not.toBe(first)
    expect(run.previewEmissionCount()).toBe(2)
    expect(h.pendingLines()).toEqual(preview)
    expect(credentialsChangeLines()).toEqual([])

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
    // Checked while the first run's pending file exists: the second run's first check removes it.
    assertNoLeak(first.captured())
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
        pending: string
        alpha: PersonaInput
        lines: string[] | null
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
        console.log(JSON.stringify({
          config: h.paths.config,
          pending: h.paths.pending,
          alpha,
          lines: h.pendingLines() ?? null,
          since: run.since(cp),
        }))
      `)

      // One pending-file write and one logged preview (or reload-invalid line); no lifecycle call, Slack client or Slack call.
      expect({ ...result.since, logs: NO_RUN_ACTIVITY.logs, writes: NO_RUN_ACTIVITY.writes }).toEqual(NO_RUN_ACTIVITY)
      expect(result.since.writes).toEqual([{ path: result.pending, ok: true }])
      if (which === 'config file') {
        expect(result.lines).toHaveLength(1)
        expect(result.lines![0]).toStartWith(`INVALID: the configuration file "${result.config}" cannot be read`)
        expect(result.lines![0]).toEndWith(' Nothing will be applied.')
        const error = result.lines![0]!.slice('INVALID: '.length, -' Nothing will be applied.'.length)
        expect(result.since.logs).toEqual([invalidLogged(error, true, result.pending)])
      } else {
        expect(result.lines).toEqual([
          previewHeader({ credentials: 1 }),
          credentialsChangedLine(result.alpha, 'kept', 'credentials file is not a regular file'),
        ])
        expect(result.since.logs).toEqual(loggedPreview(result.lines!, true, result.pending))
      }
      assertNoLeak({ result, stderr })
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// The pending-change preview (b.av2 SR-8.4, SR-10.3; AC 56, AC 65 preview half, AC 13)
// ---------------------------------------------------------------------------

describe('the pending-change preview in the pending file and the server log', () => {
  test('AC 56: removing B and moving C’s working_directory writes a preview with a DESTRUCTIVE line for each, logged once as reload-preview lines equal to the file’s body, and nothing is applied over many ticks', async () => {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie'])
    const [alpha, , charlie] = personas
    const moved = join(dirname(charlie!.working_directory), 'moved')
    h.makeWorkingDirectory({ working_directory: moved })
    const cp = run.checkpoint()

    h.writeConfig(configOf(alpha!, { ...charlie!, working_directory: moved }))
    await run.ticks.ticks(50)

    assertNoLeak(run.captured())
    const destructive = [removedLine('bravo'), destructiveLine('charlie', 'working_directory', moved)]
    expect(h.pendingLines()).toEqual([previewHeader({ removed: 1, destructive: 1 }), ...destructive])
    expect(h.pendingDestructiveLines()).toEqual(destructive)
    // Logged once, over several lines, each classed reload-preview, the header pointing at the file; nothing else
    // written, logged or applied: no teardown, bring-up, launch, reconnect or in-place update.
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(run.previewEmissions()).toEqual([loggedPreview()])
    expect(run.since(cp).logs.every((line) => line.startsWith(`[slack] ${RELOAD_PREVIEW}: `))).toBe(true)
    expect(run.since(cp).logs[0]).toEndWith(previewFileSuffix())
    expect(run.lastPreviewText()).toEqual(h.pendingLines())
    expectNoPostNoLeak(run)
  })

  test('AC 13 (tick path): a restart from the record with an unconfirmed edit brings back every recorded persona with no operator step, and its first check previews the edit', async () => {
    const [alpha, bravo] = materialized('alpha', 'bravo')
    // The first start has no record: it applies and records config.json.
    const configBytes = h.writeConfig(configOf(alpha!, bravo!))
    const first = await h.start()
    expect(first.outcome).toMatchObject({ kind: 'applied', source: 'config' })
    expect(h.readRecord()).toEqual(configBytes)
    await first.stop()

    // While the server is down, bravo is dropped from config.json. The reboot has fresh in-memory state and no pending file.
    h.writeConfig(configOf(alpha!))
    expect(h.pendingExists()).toBe(false)
    const run = await h.startDetecting()

    expect(run.outcome).toMatchObject({ kind: 'applied', source: 'record' })
    expect(broughtUp(run)).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.keys('launch').sort()).toEqual(keysOf('alpha', 'bravo'))
    expect(run.lifecycle.of('teardown')).toEqual([])
    const cp = run.checkpoint()

    await run.ticks.ticks(10)

    expect(h.pendingLines()).toEqual([previewHeader({ removed: 1 }), removedLine('bravo')])
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(h.readRecord()).toEqual(configBytes)
    expectNoPostNoLeak(first, run)
  })

  test.each<{ label: string; broken: (persona: PersonaInput) => void }>([
    { label: 'a missing credentials file, then created', broken: () => undefined },
    { label: 'invalid credentials content, then fixed', broken: (p) => void h.writeCredentialsContent(p, 'not json') },
  ])('AC 65 (preview half): a persona broken by $label is previewed as brought up, not reconnected, stays broken before confirmation, and putting the broken file back clears it', async ({ broken }) => {
    const [bravo] = materialized('bravo')
    const alpha = h.persona('alpha')
    h.makeWorkingDirectory(alpha)
    broken(alpha)
    h.writeRecord(configOf(alpha, bravo!))
    h.writeConfig(configOf(alpha, bravo!))
    const run = await h.startDetecting()
    await run.ticks.tick()
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('broken')
    expect(h.pendingExists()).toBe(false)
    const restore = h.saveCredentials(alpha)
    const cp = run.checkpoint()

    h.writeCredentials(alpha)
    await run.ticks.ticks(20)

    // Checked while the pending file exists: the new token set is in neither it nor the log.
    assertNoLeak(run.captured())
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'bring-up')])
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('broken')

    restore()
    const back = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(back)).toEqual(pendingRemoved())
    expectNoPostNoLeak(run)
  })

  test('the tick compares real paths: alpha’s working_directory rewritten as a symlink to the same directory is no effective change, never DESTRUCTIVE', async () => {
    const { run, personas } = await running(['alpha'])
    const [alpha] = personas
    const link = join(h.root, 'links', 'alpha-work')
    h.makeWorkingDirectory({ working_directory: dirname(link) })
    symlinkSync(alpha!.working_directory, link)
    const cp = run.checkpoint()

    h.writeConfig(configOf({ ...alpha!, working_directory: link }))
    await run.ticks.ticks(5)

    // The config bytes differ, so a change is pending, but the plan finds the same real path: nothing to apply.
    expect(h.pendingLines()).toEqual([NO_EFFECTIVE_CHANGE_PREVIEW])
    expect(h.pendingDestructiveLines()).toEqual([])
    expect(run.since(cp)).toEqual(pendingWritten())
    expectNoPostNoLeak(run)
  })

  test("the file is rewritten with no log line when only a fact changes: creating an added persona's missing working directory drops its cannot-come-up remark", async () => {
    const { run, recordBytes, personas } = await running(['alpha'])
    const delta = h.preparePersona('delta', { workingDirectory: 'missing' })
    const cp = run.checkpoint()

    h.writeConfig(configOf(personas[0]!, delta))
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta', ['working directory does not exist'])])
    expect(run.since(cp)).toEqual(pendingWritten())
    const fingerprint = h.pendingFingerprint()

    h.makeWorkingDirectory(delta)
    const fact = run.checkpoint()
    await run.ticks.ticks(5)

    // The fingerprint (config and credentials bytes) is unchanged, so the pending state is too: one rewrite, no log.
    expect(run.since(fact)).toEqual({ ...NO_RUN_ACTIVITY, writes: [{ path: h.paths.pending, ok: true }] })
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta')])
    expect(h.pendingFingerprint()).toBe(fingerprint)
    expect(run.previewEmissionCount()).toBe(1)
    expect(h.readRecord()).toEqual(recordBytes)
    expectNoPostNoLeak(run)
  })

  test.each([
    { label: 'a valid candidate', invalid: false },
    { label: 'an INVALID candidate', invalid: true },
  ])('$label logged while the pending file cannot be written does not point at it; the write that succeeds later logs nothing more', async ({ invalid }) => {
    const { run, personas } = await running(['alpha', 'bravo'])
    h.failWrites()
    const cp = run.checkpoint()

    if (invalid) h.writeConfigBytes(malformedWithSentinel())
    else h.writeConfig(configOf(personas[0]!))
    await run.ticks.ticks(5)

    const error = `loadPersonaConfig: malformed JSON in "${h.paths.config}" at line 3, column 5.`
    const expected = invalid ? invalidPreview(error) : [previewHeader({ removed: 1 }), removedLine('bravo')]
    const logged = invalid ? [invalidLogged(error, false)] : loggedPreview(expected, false)
    expect(run.since(cp).logs).toEqual([fileFailureLine('EIO'), ...logged])
    expect(h.pendingExists()).toBe(false)

    h.clearWriteFailure()
    const cleared = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(cleared)).toEqual({ ...NO_RUN_ACTIVITY, writes: [{ path: h.paths.pending, ok: true }] })
    expect(h.pendingLines()).toEqual(expected)
    expect(run.since(cp).lifecycle).toEqual([])
    expectNoPostNoLeak(run)
  })

  test('a fact the tick cannot gather (the bring-up state lookup throws) is logged once and previewed as not checked, never as an answer; the pass still writes and logs the preview, and the latch re-arms after a pass that gathers every fact', async () => {
    let lookupFails = false
    const { run, personas } = await running(['alpha'], {
      bringUpState: (key, state) => {
        if (lookupFails) throw new Error('the bring-up state lookup failed')
        return state(key)
      },
    })
    const [alpha] = personas
    lookupFails = true
    // Pinned by its prefix, the persona it names and its closing clause, not the whole sentence.
    const cannotCheck = expect.stringMatching(
      new RegExp(`^\\[slack\\] reload: cannot check the bring-up state of persona "alpha" \\(key=${h.key('alpha')}\\): .*; the preview `),
    )
    const unknownLine = credentialsChangedLine(alpha!, 'unchecked')
    const cp = run.checkpoint()

    h.writeCredentials(alpha!)
    await run.ticks.ticks(10)

    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), unknownLine])
    expect(run.since(cp)).toEqual(pendingWritten([cannotCheck, ...loggedPreview()]))

    // Gathered again: the file gets the answer (a fact, not a state change), with no log line.
    lookupFails = false
    const good = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(good)).toEqual({ ...NO_RUN_ACTIVITY, writes: [{ path: h.paths.pending, ok: true }] })
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha!)])

    // Failing again after a good pass is logged again, once.
    lookupFails = true
    const again = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(again)).toEqual({ ...NO_RUN_ACTIVITY, logs: [cannotCheck], writes: [{ path: h.paths.pending, ok: true }] })
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), unknownLine])
    expect(run.logsOf('reload').filter((l) => l.includes('detection check failed'))).toEqual([])
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  test('with the bring-up state unknown and the new content unusable, the line still says why the content cannot be used', async () => {
    const { run, personas } = await running(['alpha'], {
      bringUpState: () => {
        throw new Error('the bring-up state lookup failed')
      },
    })
    const [alpha] = personas
    const cp = run.checkpoint()

    h.writeCredentialsContent(alpha!, `{${LEAK_SENTINEL}`)
    await run.ticks.ticks(3)

    expect(h.pendingLines()).toEqual([
      previewHeader({ credentials: 1 }),
      credentialsChangedLine(alpha!, 'unchecked', CREDENTIALS_NOT_JSON),
    ])
    const cannotCheck = expect.stringMatching(/^\[slack\] reload: cannot check the bring-up state of persona "alpha" /)
    expect(run.since(cp)).toEqual(pendingWritten([cannotCheck, ...loggedPreview()]))
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; state: PreparedPersonaState; causes: Array<string | RegExp> }>([
    { label: 'its credentials file missing', state: { credentials: 'missing' }, causes: ['credentials file does not exist'] },
    { label: 'its credentials file invalid', state: { credentials: 'invalid' }, causes: [/^credentials file is invalid: .+/] },
    { label: 'its credentials file a directory', state: { credentials: 'unreadable' }, causes: ['credentials file is a directory'] },
    { label: 'its working directory missing', state: { workingDirectory: 'missing' }, causes: ['working directory does not exist'] },
    { label: 'its working directory a plain file', state: { workingDirectory: 'file' }, causes: ['working directory is not a directory'] },
    {
      label: 'both its credentials file and its working directory missing',
      state: { credentials: 'missing', workingDirectory: 'missing' },
      causes: ['credentials file does not exist', 'working directory does not exist'],
    },
    { label: 'nothing wrong (the control)', state: {}, causes: [] },
  ])('an added persona with $label is previewed with every cause that stops it coming up', async ({ state, causes }) => {
    const { run, personas } = await running(['alpha'])
    const delta = h.preparePersona('delta', state)
    const cp = run.checkpoint()

    h.writeConfig(configOf(personas[0]!, delta))
    await run.ticks.ticks(5)

    assertNoLeak(run.captured())
    const lines = h.pendingLines()!
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(previewHeader({ added: 1 }))
    if (causes.every((c) => typeof c === 'string')) {
      expect(lines[1]).toBe(addedLine('delta', causes as string[]))
    } else {
      const prefix = `persona "delta" (key=${h.key('delta')}) is added but cannot come up: `
      expect(lines[1]).toStartWith(prefix)
      expect(lines[1]).toEndWith('.')
      const found = lines[1]!.slice(prefix.length, -1).split('; ')
      expect(found).toHaveLength(causes.length)
      causes.forEach((cause, i) => expect(found[i]).toMatch(cause))
    }
    expect(run.since(cp)).toEqual(pendingWritten())
    expectNoPostNoLeak(run)
  })

  // Bug b.g57: the bring-up checks an added persona's claude_config_dir before
  // its Slack step (resolveRealPathStrict: no lexical fallback), so the
  // preview lists an unresolvable one, worded as the check's `problem`
  // (without the held persona's consequence), after the credentials and
  // working-directory causes. A directory not created yet under a resolvable
  // ancestor is created by the launch, so it is not listed.
  const DANGLING_CONFIG_DIR = 'claude_config_dir cannot be resolved to a real path (ENOENT: a symlink on its path points to nothing)'
  test.each<{ label: string; state: PreparedPersonaState; configDir: () => string; causes: string[] }>([
    {
      label: 'a claude_config_dir that is a symlink pointing to nothing',
      state: {},
      configDir: () => danglingLink('dangling-config'),
      causes: [DANGLING_CONFIG_DIR],
    },
    {
      label: 'a claude_config_dir under a symlink pointing to nothing',
      state: {},
      configDir: () => join(danglingLink('dangling-parent'), 'claude'),
      causes: [DANGLING_CONFIG_DIR],
    },
    {
      label: 'a claude_config_dir not created yet under an existing ancestor (the control: the launch creates it)',
      state: {},
      configDir: () => join(h.root, 'not-created-yet', 'claude'),
      causes: [],
    },
    {
      label: 'its credentials file missing and a claude_config_dir pointing to nothing',
      state: { credentials: 'missing' },
      configDir: () => danglingLink('dangling-config'),
      causes: ['credentials file does not exist', DANGLING_CONFIG_DIR],
    },
    {
      label: 'its credentials file and working directory missing and a claude_config_dir pointing to nothing',
      state: { credentials: 'missing', workingDirectory: 'missing' },
      configDir: () => danglingLink('dangling-config'),
      causes: ['credentials file does not exist', 'working directory does not exist', DANGLING_CONFIG_DIR],
    },
  ])('bug b.g57: an added persona with $label is previewed with every cause that stops it coming up', async ({ state, configDir, causes }) => {
    const { run, personas } = await running(['alpha'])
    const dir = configDir()
    const delta = h.preparePersona('delta', state, { claude_config_dir: dir })
    const cp = run.checkpoint()

    h.writeConfig(configOf(personas[0]!, delta))
    await run.ticks.ticks(5)

    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta', causes)])
    expect(run.since(cp)).toEqual(pendingWritten())
    // The preview never creates the directory it checks.
    expect(existsSync(dir)).toBe(false)
    assertNoLeak(run.captured())
    expectNoPostNoLeak(run)
  })

  test('bug b.g57: once the dangling claude_config_dir link\'s target exists, the added persona is previewed as able to come up', async () => {
    const { run, personas } = await running(['alpha'])
    const target = join(h.root, 'config-target')
    const link = join(h.root, 'config-link')
    symlinkSync(target, link)
    const delta = h.preparePersona('delta', {}, { claude_config_dir: link })

    h.writeConfig(configOf(personas[0]!, delta))
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta', [DANGLING_CONFIG_DIR])])

    mkdirSync(target)
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta')])
    expect(run.previewEmissionCount()).toBe(1)
    assertNoLeak(run.captured())
    expectNoPostNoLeak(run)
  })

  // Bug b.g57, E14 merge-prep: a confirmed claude_config_dir change to a
  // directory that cannot be resolved holds the persona at its next launch
  // (its Slack connection closed, its launch waiting), so the preview warns on
  // the change's own line, with the added persona's check and wording. It is
  // a warning, not a refusal: the confirmation still applies the change.
  const NEXT_LAUNCH_FRESH = 'takes effect at its next launch, which starts fresh (the conversation is not resumed), instance kept until then'
  test.each<{ label: string; configDir: () => string; warned: boolean }>([
    { label: 'a symlink pointing to nothing', configDir: () => danglingLink('dangling-config'), warned: true },
    { label: 'a directory under a symlink pointing to nothing', configDir: () => join(danglingLink('dangling-parent'), 'claude'), warned: true },
    { label: 'a directory not created yet under an existing ancestor (the control)', configDir: () => join(h.root, 'not-created-yet', 'claude'), warned: false },
  ])("bug b.g57: a persona's own claude_config_dir changed to $label is previewed with the warning exactly when it cannot be resolved, and the confirmation applies it", async ({ configDir, warned }) => {
    const { run, personas } = await running(['alpha'])
    const [alpha] = personas
    const dir = configDir()
    const cp = run.checkpoint()

    h.writeConfig(configOf({ ...alpha!, claude_config_dir: dir }))
    await run.ticks.ticks(3)

    const warning = warned ? `; but at that launch it cannot come up: ${DANGLING_CONFIG_DIR}` : ''
    expect(h.pendingLines()).toEqual([
      previewHeader({ inPlace: 1 }),
      `${personaRef('alpha')}: claude_config_dir changed: ${NEXT_LAUNCH_FRESH}${warning}.`,
    ])
    expect(run.since(cp)).toEqual(pendingWritten())
    // The preview never creates the directory it checks.
    expect(existsSync(dir)).toBe(false)

    h.confirm()
    await run.ticks.tick()
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ inPlace: 1 })])
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('bug b.g57: a changed top-level claude_config_dir that cannot be resolved warns on its settings line, naming every persona that inherits it', async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const dir = danglingLink('dangling-default')
    const cp = run.checkpoint()

    h.writeConfig({ ...configOf(...personas), claude_config_dir: dir })
    await run.ticks.ticks(3)

    const inheritors = `${JSON.stringify('alpha')} (key=${h.key('alpha')}), ${JSON.stringify('bravo')} (key=${h.key('bravo')})`
    expect(h.pendingLines()).toEqual([
      previewHeader({ settings: 1 }),
      `server-wide setting claude_config_dir changed: inherited by ${inheritors}; ` +
        "takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then; " +
        `but at that launch ${inheritors} cannot come up: ${DANGLING_CONFIG_DIR}.`,
    ])
    expect(run.since(cp)).toEqual(pendingWritten())
    assertNoLeak(run.captured())
    expectNoPostNoLeak(run)
  })

  test("bug b.g57: once the changed claude_config_dir's link target exists, the preview drops the warning", async () => {
    const { run, personas } = await running(['alpha'])
    const [alpha] = personas
    const target = join(h.root, 'config-target')
    const link = join(h.root, 'config-link')
    symlinkSync(target, link)

    h.writeConfig(configOf({ ...alpha!, claude_config_dir: link }))
    await run.ticks.ticks(3)
    expect(h.pendingLines()![1]).toBe(`${personaRef('alpha')}: claude_config_dir changed: ${NEXT_LAUNCH_FRESH}; but at that launch it cannot come up: ${DANGLING_CONFIG_DIR}.`)

    mkdirSync(target)
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ inPlace: 1 }), `${personaRef('alpha')}: claude_config_dir changed: ${NEXT_LAUNCH_FRESH}.`])
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  test('in dry run an added persona is never judged by its credentials: no credentials file is read and only a working-directory cause appears', async () => {
    const [alpha] = materialized('alpha')
    h.writeRecord(configOf(alpha!))
    h.writeConfig(configOf(alpha!))
    const run = await h.startDetecting({ dryRun: true })
    await run.ticks.tick()
    const delta = h.preparePersona('delta', { credentials: 'missing', workingDirectory: 'missing' })

    h.writeConfig(configOf(alpha!, delta))
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta', ['working directory does not exist'])])

    h.makeWorkingDirectory(delta)
    await run.ticks.ticks(3)
    expect(h.pendingLines()).toEqual([previewHeader({ added: 1 }), addedLine('delta')])
    expect(run.tickCredentialsReads).toEqual([])
    expect(run.tickDirectoryChecks.length).toBeGreaterThan(0)
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  test('unchanged and modified personas are not probed: each check reads each referenced credentials file once and checks only the added persona’s working directory', async () => {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie'])
    const [alpha, bravo, charlie] = personas
    const delta = h.preparePersona('delta')
    const reads = run.tickCredentialsReads.length
    const checks = run.tickDirectoryChecks.length

    // alpha unchanged, bravo modified in place, charlie unchanged, delta added.
    h.writeConfig(configOf(alpha!, { ...bravo!, channels: [{ id: bravo!.channels![0]!.id, delivery: 'mentions' }] }, charlie!, delta))
    await run.ticks.ticks(3)

    // bravo's in-place line is worded in reload-preview.test.ts; here the header counts it.
    expect(h.pendingHeader()).toBe(previewHeader({ added: 1, inPlace: 1 }))
    expect(h.pendingLines()).toHaveLength(3)
    expect(h.pendingLines()).toContain(addedLine('delta'))
    const perCheck = [alpha!, bravo!, charlie!, delta].map((p) => p.credentials_file)
    expect(run.tickCredentialsReads.slice(reads)).toEqual([...perCheck, ...perCheck, ...perCheck])
    expect(run.tickDirectoryChecks.slice(checks)).toEqual([delta.working_directory, delta.working_directory, delta.working_directory])
    expectNoPostNoLeak(run)
  })
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

    // Rotated, then unusable (malformed, deleted, a directory): no credentials line and no cause, ever.
    h.writeCredentials(alpha!)
    await run.ticks.ticks(5)
    h.writeCredentialsContent(alpha!, `{${LEAK_SENTINEL}`)
    await run.ticks.ticks(2)
    h.deleteCredentials(alpha!)
    await run.ticks.ticks(2)
    h.makeCredentialsUnreadable(alpha!)
    await run.ticks.ticks(2)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingFingerprint()).toBe(fingerprint)
    expect(h.pendingLines()).toEqual([NO_EFFECTIVE_CHANGE_PREVIEW])
    expect(run.tickCredentialsReads).toEqual([])
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
    // The failure, then the preview logged once, not pointing at a file that was never written.
    expect(since.logs).toEqual([fileFailureLine(code), ...loggedPreview([NO_EFFECTIVE_CHANGE_PREVIEW], false)])
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

    // An unsynced write still put the preview in place, so the logged preview points at it.
    expect(run.since(cp).logs).toEqual([fileFailureLine('EIO'), ...loggedPreview([NO_EFFECTIVE_CHANGE_PREVIEW])])
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
    expect(run.previewEmissionCount()).toBe(2)
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
// Confirmation and apply (b.av2 SR-8.5, SR-8.6; AC 63, AC 69, AC 73, AC 56 last clause)
// ---------------------------------------------------------------------------

/** The `reload-applied` line of a confirmed change with these counts (the preview header's terms). */
function appliedLogged(c: PreviewCounts = {}): string {
  return (
    `[slack] ${RELOAD_APPLIED}: applied the confirmed configuration change without a restart (${countsText(c)}); ` +
    `the last-applied record ${JSON.stringify(h.paths.lastApplied)} now holds it`
  )
}

/** The `reload-noop` line. */
function noopLogged(): string {
  return (
    `[slack] ${RELOAD_NOOP}: the confirmed configuration has no effective change, so no persona and no server-wide ` +
    `setting changed; the last-applied record ${JSON.stringify(h.paths.lastApplied)} was rewritten with it`
  )
}

/** The `reload-invalid` line of a confirmed invalid candidate, carrying the loader's full error. */
function confirmedInvalidLogged(error: string): string {
  return `[slack] ${RELOAD_INVALID}: the confirmed configuration is invalid, so nothing is applied: ${error}`
}

/** Why a confirmation is stale, as its `reload-stale-confirmation` line says it. */
const STALE_MISMATCH =
  'does not match the configuration as it stands (the configuration file or a credentials file it references ' +
  'changed after that preview was written)'
const STALE_MALFORMED = 'holds no well-formed fingerprint (it is not a pending-change file as the server writes it)'
const STALE_TOO_LARGE = 'is larger than the 64 KiB limit'

/** The one `reload-stale-confirmation` line. */
function staleLogged(what: string): string {
  return `[slack] ${RELOAD_STALE_CONFIRMATION}: the confirmation ${JSON.stringify(h.paths.apply)} ${what}; nothing is applied`
}

/** Matches the line of a confirmation whose delete failed with `code` (its opening words, the apply path and the code). */
function undeletableLogged(code: string): string {
  return failureLine('[slack] reload: cannot remove the confirmation ', h.paths.apply, code)
}

/** Matches the line of a confirmation removed although its directory sync failed with `code`. */
function removedUnsyncedLogged(code: string): string {
  return failureLine('[slack] reload: removed the confirmation ', h.paths.apply, code)
}

/** A durable delete that removed the confirmation, and one that failed. */
function applyRemoved(): ReloadRunActivity['removes'][number] {
  return { path: h.paths.apply, ok: true, removed: true, unsynced: false }
}
function applyNotRemoved(): ReloadRunActivity['removes'][number] {
  return { path: h.paths.apply, ok: false, removed: undefined, unsynced: false }
}

/** The retired-key record removed durably: a failed rewrite's restore to the empty record held before the apply (b.jg5 SRJ-804). */
function retiredKeysRemoved(): ReloadRunActivity['removes'][number] {
  return { path: h.retiredKeysFile, ok: true, removed: true, unsynced: false }
}

/**
 * The retired-key store's own line for `action` (`recorded`, `restored`):
 * its wording is the store's, so it is matched by the store's prefix and
 * the action only.
 */
function retiredKeysLogged(action: 'recorded' | 'restored'): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return expect.stringMatching(new RegExp(`^${escape(`${RETIRED_KEYS_LOG_PREFIX} ${action} `)}`))
}

/**
 * The hold set's begin line for the key apply step 1 recorded, once the
 * last-applied rewrite succeeded (b.jg5 SRJ-809): its wording is pinned in
 * `tests/reload-apply.test.ts`, so it is matched by the hold set's prefix
 * only.
 */
function oldLifeHoldBeganLogged(): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return expect.stringMatching(new RegExp(`^${escape(`${OLD_LIFE_HOLD_LOG_PREFIX} began `)}`))
}

/**
 * `activity` with its lifecycle records left out: a confirmed change's
 * teardowns and bring-ups are pinned in `tests/reload-apply.test.ts`, so
 * these cases neither assert them nor their absence for a changed persona.
 */
function outsideLifecycle(activity: ReloadRunActivity): ReloadRunActivity {
  return { ...activity, lifecycle: [] }
}

/**
 * What one step's inputs name, by class: the keys of each class the step
 * binds to (b.av2 SR-8.6), or the config-directories flag for the template
 * refresh.
 */
type SlotActedOn = boolean | string[] | Record<string, string[]>

/** One call of a recording apply-step slot: its step, what it acted on, and what step 1 had done by then. */
interface SlotCall {
  step: ApplyStepName
  keys: SlotActedOn
  recordIsCandidate: boolean
  applied: string[] | undefined
}

/** The keys of `personas`, in order. */
function keysIn(personas: readonly { key: string }[]): string[] {
  return personas.map((p) => p.key)
}

/**
 * Apply-step slots that record each call, in order, with the keys of each
 * class their step acts on (step 2: `removed` and `destructiveOld`; step 3:
 * `inPlace`; step 4: `credentials` and `credentialsBroken`; step 5: the
 * config-directories flag; step 6: `added` and `destructiveNew`), whether the
 * record already held `candidate()` and the applied keys at that moment.
 * `failing` names a step whose body rejects after recording.
 */
function recordingSlots(run: () => ReloadRun, candidate: () => Buffer | undefined, failing?: ApplyStepName) {
  const calls: SlotCall[] = []
  const events: string[] = []
  const actedOn = (inputs: ApplyStepInputs, step: ApplyStepName): SlotActedOn => {
    switch (step) {
      case 'teardowns':
        return { removed: keysIn(inputs.removed), destructiveOld: keysIn(inputs.destructiveOld) }
      case 'in-place-updates':
        return keysIn(inputs.inPlace.map((u) => u.persona))
      case 'credentials-reconnects':
        return {
          credentials: keysIn(inputs.credentials.map((c) => c.persona)),
          credentialsBroken: keysIn(inputs.credentialsBroken.map((c) => c.persona)),
        }
      case 'template-refresh':
        return inputs.configDirsChanged
      case 'bring-ups':
        return { added: keysIn(inputs.added), destructiveNew: keysIn(inputs.destructiveNew) }
    }
  }
  const slot = (step: ApplyStepName) => async (inputs: ApplyStepInputs) => {
    events.push(`start ${step}`)
    const record = h.readRecord()
    calls.push({
      step,
      keys: actedOn(inputs, step),
      recordIsCandidate: record !== undefined && record.equals(candidate() ?? Buffer.alloc(0)),
      applied: run().appliedKeys(),
    })
    // A later step must not start before this one settles.
    await new Promise((done) => setImmediate(done))
    events.push(`end ${step}`)
    if (step === failing) throw new Error(`slot ${step} failed`)
  }
  const slots: ApplyStepSlots = Object.fromEntries(APPLY_STEPS.map((step) => [step, slot(step)]))
  return { slots, calls, events }
}

describe('the default step 3 body updates each persona once (lifecycleApplySlots)', () => {
  test('an in-place list naming one persona key twice gets exactly one updateInPlace for that persona, with its first entry; other personas are still updated and no other member runs', async () => {
    const previous = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'bravo' }], h.root)
    const applied = makeMultiPersonaConfig(
      [
        { name: 'alpha', channels: [{ id: 'C0TEST001', delivery: 'mentions' }] },
        { name: 'bravo', permission_prompts: 'dm', dm: { enabled: true } },
      ],
      h.root,
    )
    const [alpha, bravo] = applied.personas as [Persona, Persona]
    const [alphaPrev, bravoPrev] = previous.personas as [Persona, Persona]
    const alphaFirst: InPlaceApplyInput = { persona: alpha, previous: alphaPrev, settings: ['delivery'] }
    const bravoChange: InPlaceApplyInput = {
      persona: bravo,
      previous: bravoPrev,
      settings: ['permission_prompts', 'dm.enabled'],
    }
    const alphaAgain: InPlaceApplyInput = { persona: alpha, previous: alphaPrev, settings: ['channels'] }
    const calls: string[] = []
    const updates: InPlaceApplyInput[] = []
    const failures: string[] = []
    const members: ApplyLifecycleMembers = {
      teardown: async (persona) => void calls.push(`teardown ${persona.key}`),
      bringUp: async (persona) => void calls.push(`bringUp ${persona.key}`),
      reconnectCredentials: async (persona) => void calls.push(`reconnectCredentials ${persona.key}`),
      updateInPlace: async (change) => {
        calls.push(`updateInPlace ${change.persona.key}`)
        updates.push(change)
      },
      refreshTemplate: async () => void calls.push('refreshTemplate'),
    }
    const slots = lifecycleApplySlots(members, (step, persona) => failures.push(`${step} ${persona.key}`))
    const inputs: ApplyStepInputs = {
      previous,
      applied,
      removed: [],
      added: [],
      destructiveOld: [],
      destructiveNew: [],
      inPlace: [alphaFirst, bravoChange, alphaAgain],
      credentials: [],
      credentialsBroken: [],
      configDirsChanged: false,
    }

    await slots['in-place-updates']!(inputs)

    expect(calls).toEqual([`updateInPlace ${alpha.key}`, `updateInPlace ${bravo.key}`])
    expect(updates).toHaveLength(2)
    expect(updates[0]).toBe(alphaFirst)
    expect(updates[1]).toBe(bravoChange)
    expect(failures).toEqual([])
  })
})

/**
 * A running server over `names` (see `running`) whose config file then drops
 * the last of them, checked once so the pending file holds the removal.
 */
async function pendingRemoval(names: string[], opts?: ReloadRunOptions) {
  const started = await running(names, opts)
  const configBytes = h.writeConfig(configOf(...started.personas.slice(0, -1)))
  await started.run.ticks.tick()
  expect(h.pendingHeader()).toBe(previewHeader({ removed: 1 }))
  return { ...started, configBytes, fingerprint: h.pendingFingerprint()! }
}

describe('confirmation and apply (b.av2 SR-8.5, SR-8.6)', () => {
  test('AC 73: one rename of the pending file applies a removal: the record becomes the config bytes, the applied set shrinks, the confirmation is gone, nothing is pending and one reload-applied line is logged', async () => {
    const { run, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedKeys()).toEqual(keysOf('alpha'))
    expect(run.appliedConfigs.map((c) => c.personas.map((p) => p.key))).toEqual([keysOf('alpha')])
    expect(run.controller.applied()?.bytes).toEqual(new Uint8Array(configBytes))
    expect(h.configDirEntries()).toEqual(['config.json', 'config.json.last-applied'])
    // No reload-nothing-pending line: the apply's own line says what happened. Step 1 writes the retired-key record first.
    expect(outsideLifecycle(run.since(cp))).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [retiredKeysLogged('recorded'), oldLifeHoldBeganLogged(), appliedLogged({ removed: 1 })],
      writes: [h.retiredKeysWrite(), h.lastAppliedWrite()],
      removes: [applyRemoved()],
    })

    // Used once: later ticks apply nothing further.
    const after = run.checkpoint()
    await run.ticks.ticks(10)
    expect(run.since(after)).toEqual(NO_RUN_ACTIVITY)
    expectNoPostNoLeak(run)
  })

  test('AC 73: a confirmed addition rewrites the record and puts the new key in the applied set, with one reload-applied line', async () => {
    const [charlie] = materialized('charlie')
    const { run, personas } = await running(['alpha'])
    const configBytes = h.writeConfig(configOf(personas[0]!, charlie!))
    await run.ticks.tick()

    h.confirm()
    await run.ticks.tick()

    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie'))
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ added: 1 })])
    expect(h.applyExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('after an apply, detection compares with the new applied set: the old config back is previewed as an addition', async () => {
    const { run, recordBytes } = await pendingRemoval(['alpha', 'bravo'])
    h.confirm()
    await run.ticks.tick()
    const cp = run.checkpoint()

    h.writeConfigBytes(recordBytes)
    await run.ticks.ticks(3)

    expect(h.pendingHeader()).toBe(previewHeader({ added: 1 }))
    expect(h.pendingLines()).toContain(addedLine('bravo'))
    expect(run.since(cp)).toEqual(pendingWritten())
    expectNoPostNoLeak(run)
  })

  test('a confirmation made while the server was down is applied by the first check after a start from the record', async () => {
    const { run, recordBytes, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    await run.stop()
    h.confirm()

    const next = await h.startDetecting()
    expect(next.outcome.kind === 'applied' && next.outcome.source).toBe('record')
    expect(broughtUp(next)).toEqual(keysOf('alpha', 'bravo'))
    expect(h.readRecord()).toEqual(recordBytes)
    await next.ticks.tick()

    expect(h.readRecord()).toEqual(configBytes)
    expect(next.appliedKeys()).toEqual(keysOf('alpha'))
    expect(next.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
    expect(h.applyExists()).toBe(false)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run, next)
  })

  test('the confirmation is deleted before anything is applied: it is gone when the record is written and when the server is told the new set', async () => {
    const seen: Array<[string, boolean]> = []
    const { run } = await pendingRemoval(['alpha', 'bravo'], {
      beforeWrite: (path) => void (path === h.paths.lastApplied && seen.push(['record write', h.applyExists()])),
      onApplied: () => void seen.push(['onApplied', h.applyExists()]),
    })

    h.confirm()
    await run.ticks.tick()

    expect(seen).toEqual([
      ['record write', false],
      ['onApplied', false],
    ])
    expectNoPostNoLeak(run)
  })

  // AC 63: an invalid candidate, confirmed, changes nothing and logs the loader's full error.
  test.each<{ label: string; edit: (alpha: PersonaInput) => void; error: () => string }>([
    {
      label: 'a JSON syntax error',
      edit: () => void h.writeConfigBytes(malformedWithSentinel()),
      error: () => `loadPersonaConfig: malformed JSON in "${h.paths.config}" at line 3, column 5.`,
    },
    {
      label: 'a schema violation',
      edit: (alpha) => void h.writeConfig(configOf({ ...alpha, channels: [{ id: alpha.channels![0]!.id, delivery: 'sometimes' as 'all' }] })),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        `personas[0] "alpha" (key=${h.key('alpha')}): channels[0].delivery is invalid. Allowed values are: all, mentions.`,
    },
    {
      label: 'the pre-persona shape',
      edit: () => void h.writeConfig({ routes: {}, default_route: 'C0OLD' }),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        prePersonaConversionMessage('routes'),
    },
    {
      label: 'an added persona whose key starts with an applied persona’s key (b.1ix follow-up)',
      edit: (alpha) => void h.writeConfig(configOf(alpha, h.persona('alpha_2'))),
      error: () =>
        `loadPersonaConfig: invalid persona config in "${h.paths.config}": Persona config validation error: ` +
        prefixRelatedKeysRejection(),
    },
    { label: 'the config file missing', edit: () => h.deleteConfig(), error: () => `the configuration file "${h.paths.config}" does not exist.` },
  ])('AC 63: a confirmed INVALID candidate ($label) applies nothing, deletes the confirmation, logs one reload-invalid line with the full error and rewrites the INVALID preview', async ({ edit, error }) => {
    let run!: ReloadRun
    const slots = recordingSlots(() => run, () => h.readConfig())
    const started = await running(['alpha'], { applySteps: slots.slots })
    run = started.run
    edit(started.personas[0]!)
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual(invalidPreview(error()))
    const pendingBytes = h.readPending()
    const applied = run.controller.applied()
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [confirmedInvalidLogged(error())],
      writes: [{ path: h.paths.pending, ok: true }],
      removes: [applyRemoved()],
    })
    expect(h.readPending()).toEqual(pendingBytes)
    expect(h.readRecord()).toEqual(started.recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(run.appliedConfigs).toEqual([])
    expect(slots.calls).toEqual([])
    expect(h.applyExists()).toBe(false)
    // Checked while the rewritten pending file exists.
    expectNoPostNoLeak(run)

    const later = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
  })

  test('AC 63: a confirmation of an INVALID candidate present at a start is logged as exactly one reload-invalid line on the first check', async () => {
    const { run, recordBytes } = await running(['alpha'])
    h.writeConfigBytes(malformedWithSentinel())
    await run.ticks.tick()
    await run.stop()
    h.confirm()

    const next = await h.startDetecting()
    await next.ticks.ticks(5)

    const error = `loadPersonaConfig: malformed JSON in "${h.paths.config}" at line 3, column 5.`
    expect(next.invalidLines()).toEqual([confirmedInvalidLogged(error)])
    expect(h.pendingLines()).toEqual(invalidPreview(error))
    expect(h.readRecord()).toEqual(recordBytes)
    expect(next.appliedConfigs).toEqual([])
    expect(next.lifecycle.records.filter((r) => r.via !== 'start')).toEqual([])
    expect(h.applyExists()).toBe(false)
    expectNoPostNoLeak(run, next)
  })

  test('AC 69: a confirmation made stale by an edit before the next check applies nothing and is logged once, and (AC 56) the pending file is rewritten on that check; a revert to its content needs a fresh rename, which then applies', async () => {
    const { run, personas, recordBytes, configBytes, fingerprint } = await pendingRemoval(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const applied = run.controller.applied()

    h.confirm()
    h.writeConfig({ ...configOf(alpha!, bravo!), stop_timeout: 45 })
    const cp = run.checkpoint()
    await run.ticks.tick()

    // AC 56 (last clause): the pending file is written again on the same check, with the current fingerprint and preview.
    expect(h.pendingHeader()).toBe(previewHeader({ settings: 1 }))
    expect(h.pendingFingerprint()).not.toBe(fingerprint)
    expect(run.since(cp)).toEqual({ ...pendingWritten([staleLogged(STALE_MISMATCH), ...loggedPreview()]), removes: [applyRemoved()] })
    expect(h.applyExists()).toBe(false)

    const later = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)

    // Back to the confirmed content: pending again, but nothing applies without a fresh rename.
    h.writeConfigBytes(configBytes)
    const reverted = run.checkpoint()
    await run.ticks.ticks(5)
    expect(h.pendingFingerprint()).toBe(fingerprint)
    expect(run.since(reverted)).toEqual(pendingWritten())
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(run.appliedConfigs).toEqual([])
    expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([staleLogged(STALE_MISMATCH)])

    h.confirm()
    await run.ticks.tick()
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedKeys()).toEqual(keysOf('alpha'))
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
    expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toHaveLength(1)
    expectNoPostNoLeak(run)
  })

  test.each([
    { label: 'makes the confirmation stale', dryRun: false },
    { label: 'is not compared in dry run, so the confirmation applies', dryRun: true },
  ])('a referenced credentials file rewritten after the pending file was written $label', async ({ dryRun }) => {
    const { run, personas, recordBytes, configBytes } = await pendingRemoval(['alpha', 'bravo'], { dryRun })

    h.confirm()
    h.writeCredentials(personas[0]!)
    await run.ticks.tick()

    if (dryRun) {
      expect(h.readRecord()).toEqual(configBytes)
      expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
      expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([])
    } else {
      expect(h.readRecord()).toEqual(recordBytes)
      expect(run.appliedConfigs).toEqual([])
      expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([staleLogged(STALE_MISMATCH)])
      expect(h.pendingHeader()).toBe(previewHeader({ removed: 1, credentials: 1 }))
    }
    expect(h.applyExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; place: () => void; what: string; opts?: () => ReloadRunOptions }>([
    {
      // Not a pending-change file at all, and token-bearing: none of its content reaches the log.
      label: 'a credentials file placed at the apply path',
      place: () => void h.writeApplyBytes(JSON.stringify(makeCredentials())),
      what: STALE_MALFORMED,
    },
    {
      label: 'the pending layout with no fingerprint line',
      place: () => void h.writeApplyBytes(`${PENDING_FILE_HEADER}\n\n${h.pendingBody()}\n`),
      what: STALE_MALFORMED,
    },
    {
      label: 'a well-formed but wrong fingerprint',
      place: () => void h.writeApplyBytes(composePendingFile('0'.repeat(64), h.pendingBody()!)),
      what: STALE_MISMATCH,
    },
    {
      label: 'a matching copy whose read fails (injected EIO)',
      place: () => void h.writeApplyBytes(h.readPending()!),
      what: 'cannot be read (EIO)',
      opts: () => ({
        configFs: {
          openFile: (path) => {
            if (path === h.paths.apply && h.applyExists()) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
            return DEFAULT_PERSONA_CONFIG_FS.openFile(path)
          },
        },
      }),
    },
    {
      label: 'a matching copy larger than the 64 KiB read cap',
      place: () => void h.writeOversized(h.paths.apply, { prefix: h.readPending()! }),
      what: STALE_TOO_LARGE,
    },
  ])('a malformed or unreadable confirmation ($label) applies nothing and logs one reload-stale-confirmation line', async ({ place, what, opts }) => {
    const { run, recordBytes } = await pendingRemoval(['alpha', 'bravo'], opts?.())
    const applied = run.controller.applied()
    place()
    const cp = run.checkpoint()

    await run.ticks.ticks(5)

    // The pending file (still current) is left as it is.
    expect(run.since(cp)).toEqual({ ...NO_RUN_ACTIVITY, logs: [staleLogged(what)], removes: [applyRemoved()] })
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(run.appliedConfigs).toEqual([])
    expect(h.applyExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('sprint demo: an older copy of the pending file (P1, kept before a second edit wrote P2) placed at the apply path applies nothing: over many checks one reload-stale-confirmation line, the record and applied set unchanged, and P2 still pending', async () => {
    let told = 0
    const { run, personas, recordBytes } = await running(['alpha', 'bravo'], { onApplied: () => void told++ })
    const [alpha, bravo] = personas
    const applied = run.controller.applied()

    // Edit 1 (bravo removed), check: P1 is pending; the operator keeps a copy.
    h.writeConfig(configOf(alpha!))
    await run.ticks.tick()
    expect(h.pendingHeader()).toBe(previewHeader({ removed: 1 }))
    const p1 = h.readPending()!
    const fingerprint1 = h.pendingFingerprint()

    // Edit 2 (bravo back, a server-wide setting changed), check: P2 replaces P1.
    h.writeConfig({ ...configOf(alpha!, bravo!), stop_timeout: 45 })
    await run.ticks.tick()
    expect(h.pendingHeader()).toBe(previewHeader({ settings: 1 }))
    const p2 = h.readPending()!
    expect(h.pendingFingerprint()).not.toBe(fingerprint1)

    // The saved P1 copy renamed into place instead of P2.
    h.writeApplyBytes(p1)
    const cp = run.checkpoint()
    await run.ticks.ticks(5)

    expect(run.since(cp)).toEqual({ ...NO_RUN_ACTIVITY, logs: [staleLogged(STALE_MISMATCH)], removes: [applyRemoved()] })
    expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([staleLogged(STALE_MISMATCH)])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'bravo'))
    expect(run.appliedConfigs).toEqual([])
    expect(told).toBe(0)
    expect(h.applyExists()).toBe(false)
    expect(h.readPending()).toEqual(p2)
    expectNoPostNoLeak(run)
  })

  test('a directory at the apply path is unreadable and undeletable: over many checks one reload-stale-confirmation line, one delete-failure line, nothing applied', async () => {
    const { run, recordBytes } = await pendingRemoval(['alpha', 'bravo'])
    const applied = run.controller.applied()
    h.replaceWithDirectory(h.paths.apply)
    const cp = run.checkpoint()

    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [undeletableLogged('EISDIR'), staleLogged('cannot be read (EISDIR)')],
      removes: Array.from({ length: 10 }, applyNotRemoved),
    })
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(h.pendingExists()).toBe(true)
    expectNoPostNoLeak(run)
  })

  test('a confirmation that cannot be deleted is applied once, then ignored with its delete retried silently, and processed again once its content changes', async () => {
    const { run, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    h.confirm()
    h.failRemoves()
    const cp = run.checkpoint()

    await run.ticks.tick()

    expect(outsideLifecycle(run.since(cp))).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [undeletableLogged('EIO'), retiredKeysLogged('recorded'), oldLifeHoldBeganLogged(), appliedLogged({ removed: 1 })],
      writes: [h.retiredKeysWrite(), h.lastAppliedWrite()],
      removes: [applyNotRemoved()],
    })
    expect(h.readRecord()).toEqual(configBytes)
    expect(h.applyExists()).toBe(true)

    const ignored = run.checkpoint()
    await run.ticks.ticks(5)
    expect(run.since(ignored)).toEqual({ ...NO_RUN_ACTIVITY, removes: Array.from({ length: 5 }, applyNotRemoved) })
    expect(run.appliedConfigs).toHaveLength(1)

    // New content: processed again (here stale), once.
    h.writeApplyBytes('not a pending-change file')
    const changed = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(changed)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [undeletableLogged('EIO'), staleLogged(STALE_MALFORMED)],
      removes: Array.from({ length: 3 }, applyNotRemoved),
    })

    // Deletable again: the retry removes it, silently.
    h.clearRemoveFailure()
    const cleared = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(cleared)).toEqual({ ...NO_RUN_ACTIVITY, removes: [applyRemoved()] })
    expect(h.applyExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('an undeletable stale confirmation still applies nothing once the config is edited back to match it, until its content changes', async () => {
    const { run, personas, recordBytes, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    h.confirm()
    h.writeConfig({ ...configOf(alpha!, bravo!), stop_timeout: 45 })
    h.failRemoves()
    await run.ticks.tick()
    expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([staleLogged(STALE_MISMATCH)])
    expect(run.logsOf('reload')).toEqual([undeletableLogged('EIO')])

    // Edited back: the current fingerprint (and the whole pending file) now matches the confirmation.
    h.writeConfigBytes(configBytes)
    await run.ticks.ticks(5)
    expect(h.readPending()).toEqual(h.readApply())
    expect(h.readRecord()).toEqual(recordBytes)
    expect(run.appliedConfigs).toEqual([])
    expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toHaveLength(1)
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])

    // Its content changes (the preview edited, the fingerprint kept): processed again, and it matches.
    h.writeApplyBytes(Buffer.concat([h.readApply()!, Buffer.from('an edit to the preview\n')]))
    await run.ticks.tick()
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
    // The delete seam fails the pending file's removal too, after the apply.
    expect(run.logsOf('reload')).toEqual([undeletableLogged('EIO'), undeletableLogged('EIO'), fileFailureLine('EIO')])
    expectNoPostNoLeak(run)
  })

  test('an undeletable confirmation that is then removed by hand is forgotten: the same bytes placed again are acted on again', async () => {
    const { run, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    h.confirm()
    const confirmation = h.readApply()!
    h.failRemoves()
    await run.ticks.tick()
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
    expect(h.applyExists()).toBe(true)

    // Gone by hand (the delete seam still failing): a check that finds no confirmation does nothing.
    rmSync(h.paths.apply)
    const gone = run.checkpoint()
    await run.ticks.tick()
    expect(run.since(gone)).toEqual(NO_RUN_ACTIVITY)

    // The same bytes again: not the ignored confirmation any more, so processed (it matches, and is a no-op now).
    h.writeApplyBytes(confirmation)
    const again = run.checkpoint()
    await run.ticks.tick()
    expect(outsideLifecycle(run.since(again))).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [undeletableLogged('EIO'), noopLogged()],
      writes: [h.lastAppliedWrite()],
      removes: [applyNotRemoved()],
    })
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedConfigs).toHaveLength(2)
    expectNoPostNoLeak(run)
  })

  test('a confirmation removed although its directory sync fails is logged once and still applied, and nothing retries the delete', async () => {
    const { run, configBytes } = await pendingRemoval(['alpha', 'bravo'])
    h.confirm()
    h.failRemoves({ step: 'fsyncSync' })
    const cp = run.checkpoint()

    await run.ticks.tick()

    expect(outsideLifecycle(run.since(cp))).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [removedUnsyncedLogged('EIO'), retiredKeysLogged('recorded'), oldLifeHoldBeganLogged(), appliedLogged({ removed: 1 })],
      writes: [h.retiredKeysWrite(), h.lastAppliedWrite()],
      removes: [{ path: h.paths.apply, ok: true, removed: true, unsynced: true }],
    })
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedKeys()).toEqual(keysOf('alpha'))
    expect(h.applyExists()).toBe(false)

    const later = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
    expectNoPostNoLeak(run)
  })

  test('AC 56: after a consumed confirmation whose change stays pending in the same state (its fingerprint line damaged after the rename), the pending file is rewritten on the same check with no second preview', async () => {
    const { run } = await pendingRemoval(['alpha', 'bravo'])
    const pendingBytes = h.readPending()!
    h.confirm()
    h.writeApplyBytes(pendingBytes.toString('utf-8').replace('fingerprint: sha256:', 'fingerprint: '))
    const cp = run.checkpoint()

    await run.ticks.tick()

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [staleLogged(STALE_MALFORMED)],
      writes: [{ path: h.paths.pending, ok: true }],
      removes: [applyRemoved()],
    })
    expect(h.readPending()).toEqual(pendingBytes)
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  // Step 1 writes the retired-key record first (b.jg5 SRJ-803): that durable write opens and fsyncs its
  // temporary file and its directory, so the last-applied write's own open is the third openSync and its
  // directory fsync the fourth fsyncSync, counted from failWrites.
  test.each([
    {
      label: 'before the rename (openSync)',
      failure: { step: 'openSync', call: 3 },
      line: () => failureLine(`[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write `, h.paths.lastApplied, 'EIO'),
      recordWrites: [false],
    },
    {
      label: 'at the directory fsync after the rename, the previous record written back',
      failure: { step: 'fsyncSync', call: 4 },
      // The restore is shown by the second record write and the record's bytes below.
      line: () => failureLine(`[slack] ${RELOAD_RECORD_WRITE_FAILED}: wrote `, h.paths.lastApplied, 'EIO'),
      recordWrites: [false, true],
    },
  ] as const)('AC 56: a record write failing $label applies nothing, logs one reload-record-write-failed line and rewrites the pending file on the same check', async ({ failure, line, recordWrites }) => {
    let run!: ReloadRun
    const slots = recordingSlots(() => run, () => h.readConfig())
    const started = await pendingRemoval(['alpha', 'bravo'], { applySteps: slots.slots })
    run = started.run
    const pendingBytes = h.readPending()
    const applied = run.controller.applied()
    h.confirm()
    h.failWrites(failure)
    const cp = run.checkpoint()

    await run.ticks.tick()

    // The retired-key record step 1 wrote is put back to the empty record held before the apply: removed (b.jg5 SRJ-804).
    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [retiredKeysLogged('recorded'), retiredKeysLogged('restored'), line()],
      writes: [
        h.retiredKeysWrite(),
        ...recordWrites.map((ok) => h.lastAppliedWrite(ok)),
        { path: h.paths.pending, ok: true },
      ],
      removes: [applyRemoved(), retiredKeysRemoved()],
    })
    expect(h.readRecord()).toEqual(started.recordBytes)
    expect(run.controller.applied()).toBe(applied)
    expect(run.appliedConfigs).toEqual([])
    expect(slots.calls).toEqual([])
    expect(h.readPending()).toEqual(pendingBytes)
    expect(run.previewEmissionCount()).toBe(1)
    assertNoLeak(run.captured({ record: writtenFile(h.paths.lastApplied) }))

    // Used once; a fresh rename, with the writer working, applies.
    h.clearWriteFailure()
    const later = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
    h.confirm()
    await run.ticks.tick()
    expect(h.readRecord()).toEqual(started.configBytes)
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1 })])
    expectNoPostNoLeak(run)
  })

  test.each([
    { label: 'reformatted whitespace', edit: (bytes: Buffer) => withNewline(bytes) },
    {
      label: 'reordered keys',
      edit: (bytes: Buffer) => {
        const parsed = JSON.parse(bytes.toString('utf-8')) as { personas: Record<string, unknown>[] }
        const reordered = { personas: parsed.personas.map((p) => Object.fromEntries(Object.entries(p).reverse())) }
        return Buffer.from(JSON.stringify(reordered))
      },
    },
  ])('a confirmed candidate with no effective change ($label) logs reload-noop only, rewrites the record, runs no step and leaves nothing pending', async ({ edit }) => {
    let run!: ReloadRun
    const slots = recordingSlots(() => run, () => h.readConfig())
    const started = await running(['alpha'], { applySteps: slots.slots })
    run = started.run
    const configBytes = h.writeConfigBytes(edit(started.recordBytes))
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([NO_EFFECTIVE_CHANGE_PREVIEW])
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [noopLogged()],
      writes: [h.lastAppliedWrite()],
      removes: [applyRemoved()],
    })
    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedConfigs).toHaveLength(1)
    expect(slots.calls).toEqual([])
    expect(h.pendingExists()).toBe(false)
    const later = run.checkpoint()
    await run.ticks.ticks(3)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
    expectNoPostNoLeak(run)
  })

  test('a confirmed server-wide-only change rewrites the record and logs reload-applied (not reload-noop), with no lifecycle call and nothing left pending', async () => {
    const { run, personas } = await running(['alpha'])
    const configBytes = h.writeConfig({ ...configOf(personas[0]!), stop_timeout: 45 })
    await run.ticks.tick()
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp)).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [appliedLogged({ settings: 1 })],
      writes: [h.lastAppliedWrite()],
      removes: [applyRemoved()],
    })
    expect(h.readRecord()).toEqual(configBytes)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test('an untouched persona gets no lifecycle call, Slack client or auth.test from a confirmed apply of another change', async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const alphaKey = h.key('alpha')
    h.writeConfig({ ...configOf(personas[0]!), stop_timeout: 45 })
    await run.ticks.tick()
    const buildsBefore = run.slack.buildsOf(alphaKey).length
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ removed: 1, settings: 1 })])
    expect(run.since(cp).lifecycle.filter((r) => r.key === alphaKey)).toEqual([])
    expect(run.slack.buildsOf(alphaKey)).toHaveLength(buildsBefore)
    expect(run.since(cp).slackCalls).toEqual([])
    expect(run.bringUps.credentialsDigest(alphaKey)).toBe(h.credentialsDigestOf(personas[0]!))
    expectNoPostNoLeak(run)
  })

  test('the apply runs steps 2–6 after step 1, in order, each settled before the next; a failing step is logged and the later ones still run', async () => {
    const charlie = h.persona('charlie', { claude_config_dir: join(h.root, 'charlie-claude') })
    h.materialize(charlie)
    let run!: ReloadRun
    let candidate: Buffer | undefined
    const slots = recordingSlots(() => run, () => candidate, 'in-place-updates')
    const started = await running(['alpha', 'bravo'], { applySteps: slots.slots })
    run = started.run
    const [alpha] = started.personas
    // alpha changed in place and its token rotated, bravo removed, charlie added under a new config directory.
    h.writeCredentials(alpha!)
    candidate = h.writeConfig(configOf({ ...alpha!, channels: [{ id: alpha!.channels![0]!.id, delivery: 'mentions' }] }, charlie))
    await run.ticks.tick()

    h.confirm()
    await run.ticks.tick()

    const after = { recordIsCandidate: true, applied: keysOf('alpha', 'charlie') }
    // Each class lands only in its own input: the removal is no destructive
    // old half, the addition no destructive new half, and alpha's rotation
    // (alpha is up) is a reconnect, not a credentials-broken bring-up.
    expect(slots.calls).toEqual([
      { step: 'teardowns', keys: { removed: [h.key('bravo')], destructiveOld: [] }, ...after },
      { step: 'in-place-updates', keys: [h.key('alpha')], ...after },
      { step: 'credentials-reconnects', keys: { credentials: [h.key('alpha')], credentialsBroken: [] }, ...after },
      { step: 'template-refresh', keys: true, ...after },
      { step: 'bring-ups', keys: { added: [h.key('charlie')], destructiveNew: [] }, ...after },
    ])
    expect(slots.events).toEqual(APPLY_STEPS.flatMap((step) => [`start ${step}`, `end ${step}`]))
    expect(run.logsOf('reload')).toEqual([expect.stringMatching(/^\[slack\] reload: apply step 3 \(in-place-updates\) failed: /)])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged({ added: 1, removed: 1, inPlace: 1, credentials: 1 })])
    expect(run.logs.at(-1)).toBe(appliedLogged({ added: 1, removed: 1, inPlace: 1, credentials: 1 }))
    expectNoPostNoLeak(run)
  })

  test('the step inputs are split by class: a destructive modify is only its two halves (old and new declaration), and a rotation of a persona broken by its credentials only credentialsBroken', async () => {
    let run!: ReloadRun
    let seen: ApplyStepInputs | undefined
    const slots = recordingSlots(() => run, () => h.readConfig())
    const started = await running(['alpha', 'bravo'], {
      slack: { bravo: SLACK_AUTH_REJECTED },
      applySteps: {
        ...slots.slots,
        teardowns: async (inputs) => {
          seen = inputs
          await slots.slots.teardowns!(inputs)
        },
      },
    })
    run = started.run
    const [alpha, bravo] = started.personas
    expect(run.lifecycle.outcome(h.key('bravo'))).toBe('broken')
    // alpha moves to a new working directory (destructive); bravo's file is rotated.
    const moved = { ...alpha!, working_directory: join(h.root, 'alpha-moved') }
    h.makeWorkingDirectory(moved)
    h.writeCredentials(bravo!)
    h.writeConfig(configOf(moved, bravo!))
    await run.ticks.tick()

    h.confirm()
    await run.ticks.tick()

    expect(slots.calls.map((c) => [c.step, c.keys])).toEqual([
      ['teardowns', { removed: [], destructiveOld: [h.key('alpha')] }],
      ['in-place-updates', []],
      ['credentials-reconnects', { credentials: [], credentialsBroken: [h.key('bravo')] }],
      ['bring-ups', { added: [], destructiveNew: [h.key('alpha')] }],
    ])
    // The old half is the previous declaration, the new half the applied one.
    expect(seen!.destructiveOld[0]).toBe(seen!.previous.personas[0]!)
    expect(seen!.destructiveNew[0]).toBe(seen!.applied.personas[0]!)
    expect(seen!.destructiveNew[0]!.working_directory).not.toBe(seen!.destructiveOld[0]!.working_directory)
    expect(seen!.credentialsBroken[0]!.change.credentialsBroken).toBe(true)
    expectNoPostNoLeak(run)
  })

  test("a throw from the server's onApplied is logged and the apply goes on: steps 2–6 run and reload-applied is logged", async () => {
    let run!: ReloadRun
    const slots = recordingSlots(() => run, () => h.readConfig())
    const started = await pendingRemoval(['alpha', 'bravo'], {
      applySteps: slots.slots,
      onApplied: () => {
        // The message is kept, through redactSlackLogText: the sentinel sits only inside a fake token and a URL (`sentinelInMessage`).
        throw new Error(`onApplied failed for ${sentinelInMessage('APPLIED')}`)
      },
    })
    run = started.run
    h.confirm()
    const cp = run.checkpoint()

    await run.ticks.tick()

    expect(outsideLifecycle(run.since(cp))).toEqual({
      ...NO_RUN_ACTIVITY,
      logs: [
        retiredKeysLogged('recorded'),
        oldLifeHoldBeganLogged(),
        expect.stringMatching(
          new RegExp(
            "^\\[slack\\] reload: updating the server's applied configuration failed: Error " +
              `message="onApplied failed for ${REDACTED_SENTINEL_TAIL}"( |$)`,
          ),
        ),
        appliedLogged({ removed: 1 }),
      ],
      writes: [h.retiredKeysWrite(), h.lastAppliedWrite()],
      removes: [applyRemoved()],
    })
    // Every step this removal runs (no config directory changed, so no template refresh), after step 1.
    expect(slots.calls.map((c) => c.step)).toEqual(['teardowns', 'in-place-updates', 'credentials-reconnects', 'bring-ups'])
    expect(slots.calls[0]).toEqual({
      step: 'teardowns',
      keys: { removed: [h.key('bravo')], destructiveOld: [] },
      recordIsCandidate: true,
      applied: keysOf('alpha'),
    })
    expect(h.readRecord()).toEqual(started.configBytes)
    expect(run.appliedKeys()).toEqual(keysOf('alpha'))
    expect(run.appliedConfigs).toHaveLength(1)
    expect(h.pendingExists()).toBe(false)
    // The thrown message is logged redacted: neither the fake token nor the URL (each holding the sentinel) survives.
    expectNoPostNoLeak(run)
  })

  test('a shutdown while an apply step runs ends the pass there: once the step settles, no pending-file write or delete follows', async () => {
    let entered!: () => void
    let release!: () => void
    const inStep = new Promise<void>((done) => (entered = done))
    const held = new Promise<void>((done) => (release = done))
    const { run, personas } = await pendingRemoval(['alpha', 'bravo'], {
      applySteps: {
        teardowns: async () => {
          entered()
          await held
        },
      },
    })
    h.confirm()
    const tick = run.ticks.tick()
    await inStep

    // An edit while the step runs: a pass that went on would write the pending file for it.
    h.writeConfig({ ...configOf(personas[0]!), stop_timeout: 45 })
    const cp = run.checkpoint()
    await run.stop()
    release()
    await tick

    const since = run.since(cp)
    expect(since.writes).toEqual([])
    expect(since.removes).toEqual([])
    expect(since.logs.filter((l) => l.startsWith('[slack] reload'))).toEqual([appliedLogged({ removed: 1 })])
    expect(h.pendingExists()).toBe(false)
    expect(run.previewEmissionCount()).toBe(1)
    expectNoPostNoLeak(run)
  })

  test('a confirmed no-op whose effective config directories changed lexically (a symlink to the same directory) runs only the template refresh and logs reload-noop', async () => {
    const configDir = join(h.home, '.claude')
    mkdirSync(configDir)
    const link = join(h.root, 'claude-link')
    symlinkSync(configDir, link)
    const alpha = h.persona('alpha', { claude_config_dir: configDir })
    h.materialize(alpha)
    h.writeRecord(configOf(alpha))
    h.writeConfig(configOf(alpha))
    let run!: ReloadRun
    let candidate: Buffer | undefined
    const slots = recordingSlots(() => run, () => candidate)
    run = await h.startDetecting({ applySteps: slots.slots })
    await run.ticks.tick()
    candidate = h.writeConfig(configOf({ ...alpha, claude_config_dir: link }))
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([NO_EFFECTIVE_CHANGE_PREVIEW])

    h.confirm()
    await run.ticks.tick()

    expect(slots.calls).toEqual([{ step: 'template-refresh', keys: true, recordIsCandidate: true, applied: keysOf('alpha') }])
    expect(run.logsOf(RELOAD_NOOP)).toEqual([noopLogged()])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])
    expect(h.readRecord()).toEqual(candidate)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Confirmed credentials changes end to end (b.av2 SR-6.4, SR-8.3, SR-8.4, SR-8.6; AC 65)
// ---------------------------------------------------------------------------

describe('confirmed credentials changes: recovery of a credentials-broken persona (AC 65) and the pending state end to end', () => {
  /** How the persona starts credentials-broken, and the class of its start-time line. */
  interface StartCause {
    label: string
    prepare: (alpha: PersonaInput) => void
    slack?: StubSlackOptions
    cls: string
  }
  const MISSING_AT_START: StartCause = {
    label: 'a missing credentials file',
    prepare: () => undefined,
    cls: PERSONA_CREDENTIALS_MISSING,
  }
  const INVALID_AT_START: StartCause = {
    label: 'a locally invalid credentials file',
    // Malformed content holding the sentinel: no cause or preview may echo it.
    prepare: (p) => void h.writeCredentialsContent(p, `{${LEAK_SENTINEL}`),
    cls: PERSONA_CREDENTIALS_INVALID,
  }
  const REFUSED_AT_START: StartCause = {
    label: 'a token Slack refused',
    prepare: (p) => void h.writeCredentials(p),
    slack: SLACK_AUTH_REJECTED,
    cls: PERSONA_CREDENTIALS_REFUSED,
  }

  /**
   * A running server whose record and config file (byte-equal) hold alpha,
   * credentials-broken at start by `cause`, and bravo, healthy; detection
   * started and its first check run (nothing pending).
   */
  async function brokenBesideHealthy(
    cause: StartCause,
    opts: ReloadRunOptions = {},
  ): Promise<{ run: ReloadRun; alpha: PersonaInput }> {
    const [bravo] = materialized('bravo')
    const alpha = h.persona('alpha')
    h.makeWorkingDirectory(alpha)
    cause.prepare(alpha)
    h.writeRecord(configOf(alpha, bravo!))
    h.writeConfig(configOf(alpha, bravo!))
    const run = await h.startDetecting({ ...opts, slack: cause.slack === undefined ? undefined : { alpha: cause.slack } })
    await run.ticks.tick()
    expect(run.bringUps.state(h.key('alpha'))?.outcome).toBe('broken')
    expect(run.lifecycle.classes(h.key('alpha'))).toEqual([cause.cls])
    expect(run.isUp('alpha')).toBe(false)
    expect(run.isUp('bravo')).toBe(true)
    expect(h.pendingExists()).toBe(false)
    return { run, alpha }
  }

  /** The start-rules line of class `cls` for `persona` (declared first), by its persona and path. */
  function brokenLinePrefix(cls: string, persona: PersonaInput): string {
    return `[slack] ${cls}: personas[0] ${JSON.stringify(persona.name)} (key=${h.key(persona.name)}) path=${JSON.stringify(persona.credentials_file)}: `
  }

  /**
   * Matches alpha's one `persona-credentials-change-failed` line by its
   * persona and path, for a Slack refusal whose cause is the classifier's;
   * the rest of its wording is pinned with the diagnostics.
   */
  function changeFailedLine(persona: PersonaInput): string {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return expect.stringMatching(new RegExp(`^${escape(brokenLinePrefix(PERSONA_CREDENTIALS_CHANGE_FAILED, persona))}`))
  }

  /** personas[0]'s whole `persona-credentials-change-failed` line: its cause and what it keeps (its connection, or with none yet its content). */
  function changeFailedExact(persona: PersonaInput, cause: string, kept: CredentialsChangeKept): string {
    const path = persona.credentials_file!
    return formatCredentialsChangeFailed({ name: persona.name, key: h.key(persona.name), index: 0, path, cause, kept })
  }

  /** The `[slack] reload…` lines of a stretch (the reload controller's own classes). */
  function reloadLines(activity: ReloadRunActivity): string[] {
    return activity.logs.filter((line) => line.startsWith('[slack] reload'))
  }

  /** The bravo-side view an apply must leave alone: its lifecycle records, Slack clients and Web API calls. */
  function bravoSide(run: ReloadRun) {
    const key = h.key('bravo')
    return {
      records: run.lifecycle.records.filter((r) => r.key === key).length,
      builds: run.slack.buildsOf(key).length,
      calls: run.slackCalls()[key]?.length,
      up: run.isUp('bravo'),
    }
  }

  const notJson = (p: PersonaInput) => void h.writeCredentialsContent(p, `{${LEAK_SENTINEL}`)

  // Over the recorder's stand-in and over the real lifecycle composition (persona-lifecycle.ts's recovery).
  const AC65_ROWS = [MISSING_AT_START, INVALID_AT_START, REFUSED_AT_START].flatMap((cause) => [
    { cause, label: cause.label, realLifecycle: false, over: "the recorder's stand-in lifecycle" },
    { cause, label: cause.label, realLifecycle: true, over: 'the real lifecycle composition' },
  ])

  test.each(AC65_ROWS)(
    'AC 65: a persona credentials-broken at start by $label ($over) is previewed as brought up once a good file is placed, stays broken over many ticks and a long clock advance, and after one rename comes up with the new tokens, with no restart and nothing done to the healthy persona',
    async ({ cause, realLifecycle }) => {
      const { run, alpha } = await brokenBesideHealthy(cause, { realLifecycle })
      const key = h.key('alpha')
      const bravoBefore = bravoSide(run)
      const cp = run.checkpoint()

      const { tokens } = h.rotateCredentials(alpha)
      await run.ticks.tick()
      expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'bring-up')])
      // Checked while the pending file exists: the new token set is in neither it nor the log.
      assertNoLeak(run.captured())

      // Neither detection nor time brings it up: it is not retried, and ticks apply nothing.
      await run.ticks.ticks(50)
      await run.clock.advance(3_600_000)
      await run.ticks.ticks(50)
      expect(run.since(cp)).toEqual(pendingWritten())
      expect(run.bringUps.state(key)?.outcome).toBe('broken')
      expect(run.isUp('alpha')).toBe(false)
      const applyCp = run.checkpoint()

      h.confirm()
      await run.ticks.tick()

      // Step 6's recovery bring-up, then its launch: no reconnect, and nothing for bravo.
      expect(run.since(applyCp).lifecycle).toEqual([
        { op: 'bring-up', key, via: 'apply', recovery: true, result: { outcome: 'up', failures: [] } },
        { op: 'launch', key, via: 'apply' },
      ])
      expect(run.bringUps.state(key)?.outcome).toBe('up')
      expect(run.isUp('alpha')).toBe(true)
      expect(run.slack.buildsOf(key, 'validation').at(-1)!.hasToken(tokens.botToken)).toBe(true)
      expect(run.slack.buildsOf(key, 'socket').at(-1)!.hasToken(tokens.appToken)).toBe(true)
      expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
      // No restart: the one start pass, the same run.
      expect(run.lifecycle.startPasses).toHaveLength(1)
      expect(bravoSide(run)).toEqual(bravoBefore)
      if (realLifecycle) {
        // Its leftover state is cleared before the fresh bring-up; its instance is kept (no agent-director call).
        expect(run.composition!.calls).toEqual([
          ['bringUps.cancel', key],
          ['connections.stop', key],
          ['destinations.forget', key],
          ['storageCheck', key],
          ['bringUps.bringUp', key],
          ['launch', key],
        ])
        expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
      }
      expect(reloadLines(run.since(applyCp))).toEqual([appliedLogged({ credentials: 1 })])
      expect(h.pendingExists()).toBe(false)

      const later = run.checkpoint()
      await run.ticks.ticks(5)
      expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
      expectNoPostNoLeak(run)
    },
  )

  test("SR-6.4: a persona Slack refused at start, whose app is then fixed on Slack's side, stays broken with no auth.test retry over ticks and backoff periods; a byte-only re-save of its file, confirmed, brings it up", async () => {
    const { run, alpha } = await brokenBesideHealthy(REFUSED_AT_START)
    const key = h.key('alpha')
    const stub = run.stub('alpha')
    // The scripted refusal is used up: Slack now accepts the same token.
    expect(stub.script.authTest).toEqual([])
    expect(stub.calls.authTest).toHaveLength(1)
    const cp = run.checkpoint()

    // Well past the SR-3.2 schedule's steps (5 s doubling to 300 s), with checks in between.
    for (let i = 0; i < 12; i++) {
      await run.clock.advance(300_000)
      await run.ticks.ticks(5)
    }
    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(stub.calls.authTest).toHaveLength(1)
    expect(run.clock.pendingCount()).toBe(0)
    expect(run.bringUps.state(key)?.outcome).toBe('broken')
    expect(run.isUp('alpha')).toBe(false)

    // Same tokens, one more byte: a credentials change, previewed as a bring-up.
    h.writeCredentialsContent(alpha, withNewline(h.readCredentialsBytes(alpha)!).toString('utf-8'))
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'bring-up')])
    assertNoLeak(run.captured())
    expect(stub.calls.authTest).toHaveLength(1)
    const applyCp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(applyCp).lifecycle).toEqual([
      { op: 'bring-up', key, via: 'apply', recovery: true, result: { outcome: 'up', failures: [] } },
      { op: 'launch', key, via: 'apply' },
    ])
    expect(stub.calls.authTest).toHaveLength(2)
    expect(run.isUp('alpha')).toBe(true)
    expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; edit: (alpha: PersonaInput) => void; effect: CredentialsEffect; cause?: string }>([
    { label: 'rewritten as malformed JSON holding a token', edit: notJson, effect: 'kept', cause: CREDENTIALS_NOT_JSON },
    { label: 'deleted', edit: (p) => h.deleteCredentials(p), effect: 'kept', cause: CREDENTIALS_MISSING },
    {
      label: 'rotated to tokens Slack refuses',
      edit: (p) => void h.rotateCredentials(p, { slack: SLACK_AUTH_REJECTED }),
      effect: 'reconnect',
    },
  ])('SR-8.3: a confirmed credentials change of an up persona whose new file is $label is not used: one persona-credentials-change-failed line, the old connection keeps serving, the change stays pending with its credentials line, and a good file confirmed afresh reconnects', async ({ edit, effect, cause }) => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const alpha = personas[0]!
    const key = h.key('alpha')
    const held = run.bringUps.credentialsDigest(key)
    const sockets = run.socketActivity('alpha')
    const identity = run.connections.manager.identity(key)
    const bravoBefore = bravoSide(run)

    edit(alpha)
    await run.ticks.tick()
    const preview = [previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, effect, cause)]
    expect(h.pendingLines()).toEqual(preview)
    const fingerprint = h.pendingFingerprint()
    assertNoLeak(run.captured())
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'reconnect', key, via: 'apply', change: { kind: 'failed', cause: expect.any(String) } },
    ])
    // A local cause is pinned whole, with what an up persona keeps: its connection.
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([
      cause === undefined ? changeFailedLine(alpha) : changeFailedExact(alpha, cause, 'connection'),
    ])
    // Still pending, in the same state: the pending file is written again with the credentials line.
    expect(h.pendingLines()).toEqual(preview)
    expect(h.pendingFingerprint()).toBe(fingerprint)
    expect(run.bringUps.credentialsDigest(key)).toBe(held)
    // The old connection keeps serving: no socket opened or closed, the same identity, still up.
    expect(run.socketActivity('alpha')).toEqual(sockets)
    expect(run.connections.manager.identity(key)).toEqual(identity)
    expect(run.connections.manager.status(key)?.state).toBe('up')
    expect(run.isUp('alpha')).toBe(true)
    // Checked while the pending file exists.
    assertNoLeak(run.captured())

    // Later checks leave it pending and apply nothing.
    const quiet = run.checkpoint()
    await run.ticks.ticks(10)
    expect(run.since(quiet)).toEqual(NO_RUN_ACTIVITY)

    const { label } = h.rotateCredentials(alpha)
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'reconnect')])
    assertNoLeak(run.captured())
    const fix = run.checkpoint()
    h.confirm()
    await run.ticks.tick()

    expect(run.since(fix).lifecycle).toEqual([{ op: 'reconnect', key, via: 'apply', change: { kind: 'swapped' } }])
    expect(run.currentStub('alpha')).toBe(run.credentialsStub('alpha', label))
    expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toHaveLength(1)
    expect(h.pendingExists()).toBe(false)
    expect(bravoSide(run)).toEqual(bravoBefore)
    expectNoPostNoLeak(run)
  })

  test('SR-8.3: a retrying persona (Slack unreachable) whose confirmed new file is unusable keeps retrying with its current content and the change stays pending; a good file confirmed then is what its next retry comes up with', async () => {
    const { run, personas } = await running(['alpha', 'bravo'], { slack: { alpha: SLACK_UNREACHABLE } })
    const alpha = personas[0]!
    const key = h.key('alpha')
    const firstSet = run.stub('alpha')
    expect(run.bringUps.state(key)?.outcome).toBe('retrying')
    const held = run.bringUps.credentialsDigest(key)
    const bravoBefore = bravoSide(run)

    notJson(alpha)
    await run.ticks.tick()
    const preview = [previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'retry', CREDENTIALS_NOT_JSON)]
    expect(h.pendingLines()).toEqual(preview)
    assertNoLeak(run.captured())
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'reconnect', key, via: 'apply', change: { kind: 'failed', cause: CREDENTIALS_NOT_JSON } },
    ])
    // The whole line: with no connection yet, what it keeps is its current content.
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([changeFailedExact(alpha, CREDENTIALS_NOT_JSON, 'content')])
    expect(h.pendingLines()).toEqual(preview)
    expect(run.bringUps.credentialsDigest(key)).toBe(held)
    assertNoLeak(run.captured())
    // Its next retry still uses the content it holds: another auth.test on the first set's stub.
    const attempts = firstSet.calls.authTest.length
    await run.clock.advance(300_000)
    expect(firstSet.calls.authTest.length).toBeGreaterThan(attempts)
    expect(run.bringUps.state(key)?.outcome).toBe('retrying')

    const { tokens, label } = h.rotateCredentials(alpha)
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'retry')])
    assertNoLeak(run.captured())
    const fix = run.checkpoint()
    h.confirm()
    await run.ticks.tick()

    expect(run.since(fix).lifecycle).toEqual([
      { op: 'reconnect', key, via: 'apply', change: { kind: 'retrying', connection: 'none' } },
    ])
    // Nothing is pending: it holds the new file's content, which its retries now use.
    expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
    expect(h.pendingExists()).toBe(false)
    await run.clock.advance(300_000)
    expect(run.bringUps.state(key)?.outcome).toBe('up')
    expect(run.isUp('alpha')).toBe(true)
    expect(run.currentStub('alpha')).toBe(run.credentialsStub('alpha', label))
    expect(run.slack.buildsOf(key, 'validation').at(-1)!.hasToken(tokens.botToken)).toBe(true)
    expect(run.lifecycle.of('launch').filter((r) => r.key === key)).toEqual([{ op: 'launch', key, via: 'retry' }])
    expect(bravoSide(run)).toEqual(bravoBefore)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; slack?: StubSlackOptions; change: PersonaCredentialsChangeResult }>([
    { label: 'the new connection swapped in', change: { kind: 'swapped' } },
    {
      label: 'the new connection left retrying (Slack unreachable)',
      slack: SLACK_UNREACHABLE,
      change: { kind: 'retrying', connection: 'kept' },
    },
  ])('SR-8.3: after a confirmed rotation of an up persona with $label, it holds the new file’s content, so nothing is pending and later checks do nothing', async ({ slack, change }) => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const alpha = personas[0]!
    const key = h.key('alpha')
    const bravoBefore = bravoSide(run)
    h.rotateCredentials(alpha, { slack })
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), credentialsChangedLine(alpha, 'reconnect')])
    assertNoLeak(run.captured())
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([{ op: 'reconnect', key, via: 'apply', change }])
    expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
    expect(run.isUp('alpha')).toBe(true)
    // The apply's own line says what happened; no preview and no failure line.
    expect(reloadLines(run.since(cp))).toEqual([appliedLogged({ credentials: 1 })])
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([])
    expect(h.pendingExists()).toBe(false)

    const later = run.checkpoint()
    await run.ticks.ticks(10)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
    expect(bravoSide(run)).toEqual(bravoBefore)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; start: StartCause; edit: (alpha: PersonaInput) => void; preview: (alpha: PersonaInput) => string; cls: string }>([
    {
      label: 'broken by a missing file, given malformed JSON holding a token',
      start: MISSING_AT_START,
      edit: notJson,
      preview: (p) => credentialsChangedLine(p, 'stays-broken', CREDENTIALS_NOT_JSON),
      cls: PERSONA_CREDENTIALS_INVALID,
    },
    {
      label: 'refused by Slack, given tokens Slack refuses too',
      start: REFUSED_AT_START,
      edit: (p) => void h.rotateCredentials(p, { slack: SLACK_AUTH_REJECTED }),
      preview: (p) => credentialsChangedLine(p, 'bring-up'),
      cls: PERSONA_CREDENTIALS_REFUSED,
    },
  ])('SR-8.3: a credentials-broken persona ($label) whose confirmed new file is still bad stays credentials-broken with its start-rules line, not persona-credentials-change-failed, and holds the new file’s content, so nothing is pending', async ({ start, edit, preview, cls }) => {
    const { run, alpha } = await brokenBesideHealthy(start)
    const key = h.key('alpha')
    const bravoBefore = bravoSide(run)
    edit(alpha)
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([previewHeader({ credentials: 1 }), preview(alpha)])
    assertNoLeak(run.captured())
    const cp = run.checkpoint()

    h.confirm()
    await run.ticks.tick()

    const since = run.since(cp)
    expect(since.lifecycle.map((r) => [r.op, r.key, r.via, r.recovery, r.result?.outcome])).toEqual([
      ['bring-up', key, 'apply', true, 'broken'],
    ])
    expect(run.lifecycle.classes(key)).toEqual([cls])
    expect(run.bringUps.state(key)?.outcome).toBe('broken')
    expect(run.isUp('alpha')).toBe(false)
    expect(since.logs.filter((line) => line.startsWith(brokenLinePrefix(cls, alpha)))).toHaveLength(1)
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([])
    // The held digest is the content that broke it (b.av2 SR-8.3): nothing is pending.
    expect(run.bringUps.credentialsDigest(key)).toBe(h.credentialsDigestOf(alpha))
    expect(reloadLines(since)).toEqual([appliedLogged({ credentials: 1 })])
    expect(h.pendingExists()).toBe(false)

    const later = run.checkpoint()
    await run.ticks.ticks(10)
    expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
    expect(bravoSide(run)).toEqual(bravoBefore)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// The 64 KiB read cap on the tick and confirmation paths (b.av2 SR-8.1)
// ---------------------------------------------------------------------------

describe('a file larger than the 64 KiB read cap is unreadable to the tick', () => {
  test('an oversized config.json on a running server logs one reload-invalid line and previews INVALID naming the limit', async () => {
    const { run, recordBytes } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeOversized(h.paths.config, { prefix: '{"personas": [], "padding": "' })
    await run.ticks.ticks(5)

    const error = `the configuration file "${h.paths.config}" is larger than the 64 KiB limit.`
    assertNoLeak(run.captured())
    expect(h.pendingLines()).toEqual(invalidPreview(error))
    expect(run.since(cp)).toEqual(pendingWritten([invalidLogged(error)]))
    expect(h.readRecord()).toEqual(recordBytes)
    expectNoPostNoLeak(run)
  })

  test("an oversized referenced credentials file is previewed as an unusable credentials change and never leaks", async () => {
    const { run, personas } = await running(['alpha'])
    const cp = run.checkpoint()

    h.writeOversized(personas[0]!.credentials_file)
    await run.ticks.ticks(5)

    assertNoLeak(run.captured())
    expect(credentialsChangeLines()).toEqual([
      credentialsChangedLine(personas[0]!, 'kept', 'credentials file is larger than the 64 KiB limit'),
    ])
    expect(run.since(cp)).toEqual(pendingWritten())
    expectNoPostNoLeak(run)
  })

  test('a persona whose credentials file is oversized at the start is broken and holds the unreadable marker, so later checks find nothing pending', async () => {
    const [alpha] = materialized('alpha')
    h.writeOversized(alpha!.credentials_file)
    h.writeRecord(configOf(alpha!))
    h.writeConfig(configOf(alpha!))
    const run = await h.startDetecting()
    expect(run.lifecycle.outcome(h.key('alpha'))).toBe('broken')
    expect(run.bringUps.credentialsDigest(h.key('alpha'))).toBe(CREDENTIALS_UNREADABLE_MARKER)
    expect(h.credentialsDigestOf(alpha!)).toBe(CREDENTIALS_UNREADABLE_MARKER)
    const cp = run.checkpoint()

    await run.ticks.ticks(10)

    expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Token secrecy on the reload path (b.av2 SR-10.3; AC 20)
// ---------------------------------------------------------------------------

/** The loader's error for `source` (the config file or the record) with this validation `detail`. */
function loaderError(source: string, detail: string): string {
  return `loadPersonaConfig: invalid persona config in "${source}": Persona config validation error: ${detail}`
}

/** The one line a refused start logs: the config file's error, or the record's with the deletion hint. */
function startRefusal(source: 'config' | 'record', detail: string): string {
  return source === 'config'
    ? `${CONFIG_REFUSAL}${loaderError(h.paths.config, detail)}`
    : `${RECORD_REFUSAL}${loaderError(h.paths.lastApplied, detail)} ${deletionHint()}`
}

/**
 * A start over `file` (a whole configuration input) as the configuration
 * file with no record, or as a hand-edited record beside a valid config
 * file: it refuses with exactly `startRefusal(source, detail)`, applies and
 * writes nothing, and nothing it captured or left on disk carries a token.
 */
async function expectStartRefused(
  source: 'config' | 'record',
  file: unknown,
  detail: string,
  credentialsFiles: string[],
): Promise<ReloadRun> {
  const valid = h.persona('alpha')
  const configBytes = source === 'config' ? h.writeConfig(file) : h.writeConfig(configOf(valid))
  const recordBytes = source === 'record' ? h.writeRecord(file) : undefined

  const run = await h.start()

  expectNothingApplied(run)
  expect(run.outcome.kind === 'refused' && run.outcome.source).toBe(source)
  expect(run.logs).toEqual([startRefusal(source, detail)])
  expect(run.writes).toEqual([])
  expect(h.readRecord()).toEqual(recordBytes)
  expect(h.readConfig()).toEqual(configBytes)
  // The config file, the credentials files and the hand-edited record are the operator's; everything else is checked.
  const operatorWritten = [h.paths.config, ...credentialsFiles, ...(source === 'record' ? [h.paths.lastApplied] : [])]
  expectNoPostNoLeak(run)
  assertNoLeak({ ...run.captured(), server: h.serverSideFiles(...operatorWritten) })
  return run
}

/**
 * A running server over alpha whose config file is then edited to `file`
 * (an INVALID candidate with `detail` as its validation error): the ticks
 * write the INVALID preview and log exactly one `reload-invalid` line; a
 * confirmation of it applies nothing (no lifecycle call, the record byte for
 * byte unchanged, one `reload-invalid` line) and later ticks do nothing.
 * Every capture and every server-side file is leak-checked while the pending
 * file exists, and again after the confirmation. `edit` gets alpha.
 */
async function expectInvalidCandidateStaysClean(
  edit: (alpha: PersonaInput) => { file: unknown; credentialsFiles?: string[] },
  detail: string,
): Promise<ReloadRun> {
  const { run, personas, recordBytes } = await running(['alpha'])
  const applied = run.controller.applied()
  const { file, credentialsFiles = [] } = edit(personas[0]!)
  const operatorWritten = [h.paths.config, personas[0]!.credentials_file, ...credentialsFiles]
  const error = loaderError(h.paths.config, detail)
  const cp = run.checkpoint()

  h.writeConfig(file)
  await run.ticks.ticks(5)

  // Checked first, while the pending file exists.
  assertNoLeak({ ...run.captured(), server: h.serverSideFiles(...operatorWritten) })
  expect(h.pendingLines()).toEqual(invalidPreview(error))
  expect(run.since(cp)).toEqual(pendingWritten([invalidLogged(error)]))
  expect(run.logsOf(RELOAD_PREVIEW)).toEqual([])

  const confirmed = run.checkpoint()
  h.confirm()
  await run.ticks.tick()

  expect(run.since(confirmed)).toEqual({
    ...NO_RUN_ACTIVITY,
    logs: [confirmedInvalidLogged(error)],
    writes: [{ path: h.paths.pending, ok: true }],
    removes: [applyRemoved()],
  })
  expect(h.readRecord()).toEqual(recordBytes)
  expect(run.controller.applied()).toBe(applied)
  expect(run.appliedConfigs).toEqual([])
  expect(h.applyExists()).toBe(false)
  expect(h.pendingLines()).toEqual(invalidPreview(error))
  // The rewritten pending file is checked while it exists.
  expectNoPostNoLeak(run)
  assertNoLeak(h.serverSideFiles(...operatorWritten))

  const later = run.checkpoint()
  await run.ticks.ticks(5)
  expect(run.since(later)).toEqual(NO_RUN_ACTIVITY)
  return run
}

// A token pasted as a setting's value: the loader names the key (a plain setting name, E11 decision 5 left intact)
// and never the value; the tick carries that error into the pending file and the log, the confirmation into the log,
// and the start into its refusal. The token-named keys are the unknown-key block's above.
describe('a Slack token pasted under a bot_token or app_token key never reaches the pending file, the log, the record or a start refusal', () => {
  const placements: Array<{ label: string; place: (alpha: PersonaInput) => unknown; detail: () => string }> = [
    {
      label: 'a bot_token key in a persona entry',
      place: (alpha) => configOf({ ...alpha, bot_token: fakeToken(BOT_TOKEN_PREFIX, 'PASTED') } as PersonaInput),
      detail: () => `personas[0] "alpha" (key=${h.key('alpha')}): unknown field(s) in the persona entry: "bot_token".`,
    },
    {
      label: 'an app_token key in a persona entry',
      place: (alpha) => configOf({ ...alpha, app_token: fakeToken(APP_TOKEN_PREFIX, 'PASTED') } as PersonaInput),
      detail: () => `personas[0] "alpha" (key=${h.key('alpha')}): unknown field(s) in the persona entry: "app_token".`,
    },
    {
      label: 'a bot_token key at the top level',
      place: (alpha) => ({ ...configOf(alpha), bot_token: fakeToken(BOT_TOKEN_PREFIX, 'PASTED') }),
      detail: () => 'unknown top-level field(s) in config.json: "bot_token".',
    },
  ]

  test.each(placements)('on a running server, $label is an INVALID candidate naming the key; its confirmation applies nothing', async ({ place, detail }) => {
    await expectInvalidCandidateStaysClean((alpha) => ({ file: place(alpha) }), detail())
  })

  test.each(placements.flatMap((p) => (['config', 'record'] as const).map((source) => ({ ...p, source }))))(
    'a start from the $source with $label refuses, naming the key and never the value',
    async ({ source, place, detail }) => {
      const [alpha] = materialized('alpha')
      await expectStartRefused(source, place(alpha!), detail(), [alpha!.credentials_file])
    },
  )
})

// Operator decision A (E14 Task 0, b.av2 SR-1.2 "no format rule"): a persona name shaped like a Slack token is an
// ordinary name. It loads unmasked, and the pending file, the log, the record and the applied set carry it as written.
// The name comes from fakeToken, so it holds the sentinel: these runs' artifacts are asserted to contain it, so their
// leak check masks the name and its key first (withoutName) and checks the rest, the credentials files these runs read
// and bring the personas up with included.
describe('a token-shaped persona name is an ordinary name: previewed, applied and started as written', () => {
  /** A name that holds a whole fake bot token after a space, as a paste into the name field would. */
  const tokenShapedName = (): string => `Ops bot ${fakeToken(BOT_TOKEN_PREFIX, 'NAME')}`

  /**
   * No Slack post, and `run.captured()` plus every server-side file but the operator-written ones passes
   * `assertNoLeak` once `name` and its key are masked.
   */
  function expectNoPostNoLeakBesideName(run: ReloadRun, name: string, operatorWritten: string[]): void {
    expect(run.slackPosts()).toEqual([])
    const captured = { ...run.captured(), server: h.serverSideFiles(...operatorWritten) }
    assertNoLeak(withoutName(captured, name, h.key(name)), 'captured without the name')
  }

  test.each<{
    label: string
    edit: (alpha: PersonaInput, name: string) => PersonaInput[]
    counts: PreviewCounts
    removed: string[]
    remaining: string[]
  }>([
    {
      // The key follows the name, so a rename is alpha's removal plus the new name's addition over alpha's files.
      label: 'an existing persona renamed to one',
      edit: (alpha, name) => [{ ...alpha, name }],
      counts: { added: 1, removed: 1 },
      removed: ['alpha'],
      remaining: [],
    },
    {
      label: 'a new persona added with one',
      edit: (alpha, name) => {
        // Charlie's own files, so everything but the name is valid (paths are derived from the name otherwise).
        const [charlie] = materialized('charlie')
        return [alpha, { ...charlie!, name }]
      },
      counts: { added: 1 },
      removed: [],
      remaining: ['alpha'],
    },
  ])('on a running server, $label is a valid candidate previewed with the name as written; one confirmation applies it', async ({ edit, counts, removed, remaining }) => {
    const name = tokenShapedName()
    const { run, personas } = await running(['alpha'])
    const edited = edit(personas[0]!, name)
    const configBytes = h.writeConfig(configOf(...edited))
    const operatorWritten = [h.paths.config, ...edited.map((p) => p.credentials_file)]
    const cp = run.checkpoint()
    await run.ticks.tick()

    expect(h.pendingLines()).toEqual([previewHeader(counts), ...removed.map(removedLine), addedLine(name)])
    expect(run.since(cp)).toEqual(pendingWritten())
    expect(run.logsOf(RELOAD_INVALID)).toEqual([])
    // Checked while the pending file exists: captured() holds it as a written file.
    expectNoPostNoLeakBesideName(run, name, operatorWritten)

    h.confirm()
    await run.ticks.tick()

    expect(h.readRecord()).toEqual(configBytes)
    expect(run.appliedKeys()!.sort()).toEqual([...keysOf(...remaining), h.key(name)].sort())
    expect(run.controller.applied()!.config.personas.find((p) => p.key === h.key(name))?.name).toBe(name)
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([appliedLogged(counts)])
    expect(run.lifecycle.keys('bring-up')).toContain(h.key(name))
    expect(h.applyExists()).toBe(false)
    expect(h.pendingExists()).toBe(false)
    expectNoPostNoLeakBesideName(run, name, operatorWritten)
  })

  test.each(['config', 'record'] as const)('a start from the %s with a token-shaped persona name starts, the name as written', async (source) => {
    const [alpha, charlie] = materialized('alpha', 'charlie')
    const name = tokenShapedName()
    const file = configOf(alpha!, { ...charlie!, name })
    const bytes = source === 'config' ? h.writeConfig(file) : h.writeRecord(file)
    // A start from the record runs it whatever the config file holds.
    if (source === 'record') h.writeConfig(configOf(alpha!))

    const run = await h.start()

    expect(run.outcome.kind === 'applied' && run.outcome.source).toBe(source)
    expect(h.readRecord()).toEqual(bytes)
    expect(run.controller.applied()!.config.personas.map((p) => [p.name, p.key])).toEqual([
      ['alpha', h.key('alpha')],
      [name, h.key(name)],
    ])
    expect(broughtUp(run)).toEqual([h.key('alpha'), h.key(name)].sort())
    expect(run.lifecycle.keys('launch').sort()).toEqual([h.key('alpha'), h.key(name)].sort())
    expect(run.logs.filter((l) => l.includes('Fatal'))).toEqual([])
    // The record is operator-written only on a start from the record; from the config, CSCB writes it.
    const operatorWritten = [h.paths.config, alpha!.credentials_file, charlie!.credentials_file]
    expectNoPostNoLeakBesideName(run, name, source === 'record' ? [...operatorWritten, h.paths.lastApplied] : operatorWritten)
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
      // Started by absolute path and runs nothing by name: no tools on PATH.
      env: hostSafeChildEnv(home, {
        tools: [],
        extras: {
          SLACK_STATE_DIR: join(home, 'state'),
          // Bun's own runtime transpiler cache would otherwise land in $HOME/.bun.
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        },
      }),
    })

    expect(child.signal).toBeNull()
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe('')
    expect(readdirSync(home)).toEqual([])
  }, 15_000)
})
