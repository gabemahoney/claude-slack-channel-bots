/**
 * reload-apply.test.ts — What a confirmed change does to the personas (b.av2
 * SR-6.1 at apply, SR-6.4, SR-6.5, SR-6.6, SR-8.6 steps 2 to 6 and every
 * table row: removal, `name`, in place, credentials, destructive modify,
 * `claude_config_dir`, `stop_hook_bootstrap` and server-wide; SR-1.4 at
 * apply; AC 19, 22, 57, 58, 59, 60, 61, 64, 68).
 *
 * Every case drives the real reload controller through `makeReloadHarness`:
 * start from a record, edit `config.json` (or a credentials file), tick to
 * write the pending file, rename it with `h.confirm()`, tick again. The
 * controller's default step bodies then fan out to the harness's lifecycle
 * recorder: step 2 tears down each removed persona, step 3 updates each
 * persona modified in place, step 4 reconnects each persona whose
 * credentials changed and that is not broken by its credentials then, and
 * step 6 brings up each added one and, as a recovery, each persona broken by
 * its credentials whose credentials changed. Cases marked "real composition" bind
 * `createPersonaLifecycle` (`opts.realLifecycle`), so the teardown, in-place
 * update and bring-up are the production code over the run's real bring-up
 * controller and connection manager, stub Slack and a stub agent-director
 * client; the others use the recorder's stand-ins. The AC 58 routing cases
 * then drive the run's real consumers (routing behind the event router, the
 * notifier and destination resolver, the MCP tools over a registered
 * session), which read the applied configuration at each use.
 *
 * The credentials cases (AC 68; b.av2 SR-8.6 step 4, step 6's extra case
 * and the credentials row, SR-3.3's reconnect bound, SR-6.4 recovery, SR-1.4
 * at apply) rotate a file with `h.rotateCredentials`, whose new token pair
 * has its own stub (`run.credentialsStub`), so the old and new connections
 * are told apart (`run.socketActivity`, `run.currentStub`); the 10 s start
 * bound and the SR-3.2 retries run on `run.clock`.
 *
 * The destructive, next-launch and server-wide rows and step 5 (AC 59, 60,
 * 61) run with the real launch path where a launch is asserted
 * (`opts.realLaunch`: `spawnForPersona` over the harness's agent-director
 * row table, the trust patch and the reply-guard steps), and with every
 * persona given its own temp `claude_config_dir` (`personaConfigDirs`), so
 * a spawn's config directory and the template's memory-read rules name
 * known temp paths. A persona's next launch after an apply is
 * `run.relaunch(name)` (the restart path) from a row seeded with
 * `h.seedRow`; the next server start is a later `h.start()` over the same
 * directories. Step 5 is read from `run.lifecycle.applyTimeline` and the
 * stub's `makeTemplate` captures.
 *
 * Confirmation processing, invalid, stale and no-op candidates and step 1
 * are pinned in `tests/reload.test.ts`; the preview's wording in
 * `tests/reload-preview.test.ts`, so a preview line is asserted here only as
 * far as it ties a row to its AC.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { PersonaConfigInput, PersonaInput } from '../src/config.ts'
import { isCredentialsBroken, type PersonaBringUpOutcome } from '../src/persona-bringup-controller.ts'
import {
  PERSONA_CONFIG_DIR_UNRESOLVABLE,
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DM_DROPPED,
  PERSONA_SLACK_UNREACHABLE,
  UNCLAIMED_CHANNEL,
} from '../src/persona-diagnostics.ts'
import { configDirLabelValue, personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import type { InPlaceSetting } from '../src/reload-plan.ts'
import { RELOAD_APPLIED, RELOAD_NOOP } from '../src/reload.ts'
import { personaConfigDirLabelValue } from '../src/session-manager.ts'
import { errTemplateMalformed, stubCallCount } from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import {
  makeChannelMessage,
  makeDm,
  mentionText,
  stubOpenedDmId,
  type StubSlackOptions,
  type StubWebCall,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import {
  makeReloadHarness,
  NO_RUN_ACTIVITY,
  SLACK_AUTH_REJECTED,
  SLACK_UNREACHABLE,
  TEMPLATE_REFRESH_KEY,
  type AgentDirectorCall,
  type ApplyTimelineEntry,
  type LifecycleTimelineEntry,
  type PreparedPersonaState,
  type ReloadHarness,
  type ReloadLifecycleRecord,
  type ReloadRun,
  type ReloadRunOptions,
} from './test-helpers/reload-harness.ts'

let h: ReloadHarness

beforeEach(() => {
  h = makeReloadHarness()
})

afterEach(async () => {
  await h.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `{ personas }` in file form. */
function configOf(...personas: PersonaInput[]): { personas: PersonaInput[] } {
  return { personas }
}

/** Top-level (server-wide) settings in file form. */
type TopLevel = Partial<Omit<PersonaConfigInput, 'personas'>>

/** `top`'s settings and `personas`, in file form. */
function configWith(top: TopLevel, personas: PersonaInput[]): PersonaConfigInput {
  return { ...top, personas }
}

/** The keys of `names`, in order. */
function keysOf(...names: string[]): string[] {
  return names.map((n) => h.key(n))
}

/** A persona of `running`: its name, alone or with its overrides over `h.persona(name)`. */
type PersonaSpec = string | [name: string, overrides: Partial<PersonaInput>]

/**
 * `running`'s options: the run's, plus `sessions` to register an MCP session
 * for every persona once it has started, and `top` for the top-level
 * settings the record and configuration file carry.
 */
interface RunningOptions extends ReloadRunOptions {
  sessions?: boolean
  top?: TopLevel
}

/** The real composition, with an MCP session registered for every persona (the AC 58 routing cases). */
const REAL_WITH_SESSIONS: RunningOptions = { realLifecycle: true, sessions: true }

/**
 * A running server over `specs`: each persona's files are created, then
 * `prepare` may break some, then the record and the configuration file are
 * written byte-equal, detection is started and its first check run (nothing
 * pending), and, with `opts.sessions`, each persona gets a registered MCP
 * session.
 */
async function running(
  specs: PersonaSpec[],
  opts: RunningOptions = {},
  prepare: (personas: PersonaInput[]) => void = () => undefined,
): Promise<{ run: ReloadRun; personas: PersonaInput[] }> {
  const { sessions, top = {}, ...runOpts } = opts
  const personas = specs.map((spec) => (typeof spec === 'string' ? h.persona(spec) : h.persona(...spec)))
  h.materialize(...personas)
  prepare(personas)
  h.writeRecord(configWith(top, personas))
  h.writeConfig(configWith(top, personas))
  const run = await h.startDetecting(runOpts)
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(false)
  if (sessions) for (const persona of personas) run.registerSession(persona.name)
  return { run, personas }
}

/**
 * Write `personas` (with the top-level settings `top`) as the configuration
 * file, check it (the pending file is written), confirm it and start the
 * tick that applies it; `applying` is that tick, not awaited.
 */
async function confirmConfig(run: ReloadRun, personas: PersonaInput[], top: TopLevel = {}): Promise<{ applying: Promise<void> }> {
  h.writeConfig(configWith(top, personas))
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  h.confirm()
  return { applying: run.ticks.tick() }
}

/** `confirmConfig`, its apply awaited. */
async function applyConfig(run: ReloadRun, personas: PersonaInput[], top: TopLevel = {}): Promise<void> {
  await (await confirmConfig(run, personas, top)).applying
}

/**
 * Write `personas` (with `top`) as the configuration file and check it: the
 * pending file is written, nothing is applied, and the pending file and log
 * are leak-checked while the file exists. Returns the pending preview's
 * lines; `h.confirm()` and a tick then apply it.
 */
async function previewConfig(run: ReloadRun, personas: PersonaInput[], top: TopLevel = {}): Promise<string[]> {
  h.writeConfig(configWith(top, personas))
  const cp = run.checkpoint()
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  expect(run.since(cp).lifecycle).toEqual([])
  assertNoLeak(run.captured())
  return h.pendingLines()!
}

/** Every closing check: nothing posted to Slack (b.av2 SR-7.2) and no token in anything captured. */
function expectNoPostNoLeak(run: ReloadRun, extra?: Record<string, unknown>): void {
  expect(run.slackPosts()).toEqual([])
  assertNoLeak(run.captured(extra))
}

/** After an apply: the next ticks find nothing pending and do nothing at all. */
async function expectNothingPendingAfter(run: ReloadRun): Promise<void> {
  expect(h.pendingExists()).toBe(false)
  expect(h.applyExists()).toBe(false)
  expect(h.readRecord()).toEqual(h.readConfig()!)
  const cp = run.checkpoint()
  await run.ticks.ticks(3)
  expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
}

/** Yield event-loop turns (no timer) until `cond` holds; fails if it never does. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i++) await new Promise((done) => setImmediate(done))
  expect(cond()).toBe(true)
}

/** A persona's Slack side as a snapshot: sockets built, closed and started, `auth.test` and other Web API calls, and client builds. */
function slackSideOf(run: ReloadRun, name: string) {
  const stub = run.stub(name)
  return {
    sockets: stub.sockets.length,
    disconnects: stub.sockets.map((s) => s.disconnectCalls),
    starts: stub.sockets.map((s) => s.startCalls),
    authTests: stub.calls.authTest.length,
    webCalls: stub.callLog.length,
    builds: run.slack.buildsOf(h.key(name)).length,
  }
}

/**
 * Watch a persona the change leaves alone: the returned check asserts it got
 * no lifecycle record from here on and that its Slack side is as it is now.
 */
function watchUntouched(run: ReloadRun, name: string): () => void {
  const cp = run.checkpoint()
  const before = slackSideOf(run, name)
  return () => {
    expect(run.since(cp).lifecycle.filter((r) => r.key === h.key(name))).toEqual([])
    expect(slackSideOf(run, name)).toEqual(before)
  }
}

/** The index in `timeline` of the first entry matching. */
function indexOf(timeline: readonly LifecycleTimelineEntry[], match: Partial<LifecycleTimelineEntry>): number {
  return timeline.findIndex((e) => Object.entries(match).every(([k, v]) => e[k as keyof LifecycleTimelineEntry] === v))
}

// ---------------------------------------------------------------------------
// Additions (AC 19, AC 22; b.av2 SR-6.1 at apply)
// ---------------------------------------------------------------------------

describe('a confirmed addition brings the persona up (b.av2 SR-6.1 at apply, SR-8.6 step 6)', () => {
  test('AC 19 / AC 22: a persona whose working directory and credentials file are created while the server runs comes up from its file, never the token environment, and nothing happens to the running persona', async () => {
    const { run, personas } = await running(['alpha'], { realLifecycle: true })
    const [alpha] = personas
    const alphaKey = h.key('alpha')
    const charlieKey = h.key('charlie')
    const env = h.poisonTokenEnvironment()
    const envBefore = { ...process.env }
    const readsBefore = env.reads.length
    const alphaBefore = slackSideOf(run, 'alpha')

    // The brand-new files, created after the start.
    const charlie = h.persona('charlie')
    h.materialize(charlie)
    const cp = run.checkpoint()
    await applyConfig(run, [alpha!, charlie])

    // Exactly one bring-up, for charlie, which came up and launched.
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: charlieKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: charlieKey, via: 'apply' },
    ])
    expect(run.bringUps.state(charlieKey)?.outcome).toBe('up')
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie'))
    // The tokens the credentials helper wrote into charlie's file reached its clients; the environment's never did.
    const tokens = h.tokens('charlie')
    const builds = run.slack.buildsOf(charlieKey)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) {
      expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    }
    expect(run.slack.builds.filter((b) => b.hasToken(env.bot) || b.hasToken(env.app))).toEqual([])
    expect(env.reads.slice(readsBefore)).toEqual([])
    expect(run.bringUps.credentialsDigest(charlieKey)).toBe(h.credentialsDigestOf(charlie))
    // Nothing for alpha: no lifecycle call, no dependency call, no agent-director call, its connection untouched.
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.composition!.calls).toEqual([
      ['storageCheck', charlieKey],
      ['bringUps.bringUp', charlieKey],
      ['launch', charlieKey],
    ])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(slackSideOf(run, 'alpha')).toEqual(alphaBefore)
    expect(run.since(cp).slackCalls.map((c) => c.method)).toEqual(['auth.test'])
    expect(run.stub('charlie').calls.authTest).toHaveLength(1)
    // No restart: one start pass, one run.
    expect(run.lifecycle.startPasses).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    const envAfter = { ...process.env }
    expect(envAfter).toEqual(envBefore)
    expectNoPostNoLeak(run)
  })

  // AC 64: a new persona that cannot be used is logged per the startup rules and touches no running persona.
  test.each<{ label: string; credentials: PreparedPersonaState['credentials']; oversized?: boolean; slack?: boolean; cls: string }>([
    { label: 'its credentials file missing', credentials: 'missing', cls: PERSONA_CREDENTIALS_MISSING },
    { label: 'its credentials file unreadable (a directory)', credentials: 'unreadable', cls: PERSONA_CREDENTIALS_UNREADABLE },
    { label: 'its credentials file unreadable (over the 64 KiB cap)', credentials: 'missing', oversized: true, cls: PERSONA_CREDENTIALS_UNREADABLE },
    { label: 'its credentials file locally invalid', credentials: 'invalid', cls: PERSONA_CREDENTIALS_INVALID },
    { label: "its tokens refused by Slack's auth.test", credentials: 'valid', slack: true, cls: PERSONA_CREDENTIALS_REFUSED },
  ])('AC 64: an added persona with $label ends broken with its startup class, launches nothing, and leaves the running personas untouched (real composition)', async ({ credentials, oversized, slack, cls }) => {
    const { run, personas } = await running(['alpha', 'bravo'], {
      realLifecycle: true,
      ...(slack ? { slack: { delta: SLACK_AUTH_REJECTED } } : {}),
    })
    const deltaKey = h.key('delta')
    const before = { alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }
    const delta = h.preparePersona('delta', { credentials })
    if (oversized) h.writeOversized(delta.credentials_file)
    const cp = run.checkpoint()

    await applyConfig(run, [...personas, delta])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: deltaKey, via: 'apply', result: expect.objectContaining({ outcome: 'broken' }) },
    ])
    expect(run.lifecycle.classes(deltaKey)).toEqual([cls])
    // Its broken line names it and its credentials path.
    const deltaLines = run.logsOf(cls)
    expect(deltaLines).toHaveLength(1)
    expect(deltaLines[0]).toContain(renderPersonaRef('delta', deltaKey))
    expect(deltaLines[0]).toContain(delta.credentials_file)
    // The running personas: no lifecycle or dependency call, their Slack side untouched.
    expect(run.composition!.calls.filter(([, key]) => key !== deltaKey)).toEqual([])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect({ alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }).toEqual(before)
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'bravo', 'delta'))
    // Held: the content that broke it, so it is not pending again.
    expect(run.bringUps.credentialsDigest(deltaKey)).toBe(h.credentialsDigestOf(delta))
    // Its only Slack call is the auth.test that refused it, when there was one; nothing is posted anywhere.
    expect(run.since(cp).slackCalls.map((c) => c.method)).toEqual(slack ? ['auth.test'] : [])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; state: PreparedPersonaState; slack?: boolean; cls: string }>([
    { label: 'its working directory missing', state: { workingDirectory: 'missing' }, cls: PERSONA_DIRECTORY_MISSING },
    { label: 'Slack unreachable', state: {}, slack: true, cls: PERSONA_SLACK_UNREACHABLE },
  ])('an added persona with $label ends retrying: the apply completes and logs reload-applied without waiting for the retry, and the running persona is untouched', async ({ state, slack, cls }) => {
    const { run, personas } = await running(['alpha'], slack ? { slack: { delta: SLACK_UNREACHABLE } } : {})
    const deltaKey = h.key('delta')
    const alphaBefore = slackSideOf(run, 'alpha')
    const delta = h.preparePersona('delta', state)
    const cp = run.checkpoint()

    await applyConfig(run, [...personas, delta])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: deltaKey, via: 'apply', result: expect.objectContaining({ outcome: 'retrying' }) },
    ])
    expect(run.lifecycle.classes(deltaKey)).toEqual([cls])
    // Its retry is still due on the clock: the apply did not wait for it.
    expect(run.clock.pendingCount()).toBe(1)
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(slackSideOf(run, 'alpha')).toEqual(alphaBefore)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// The Epic's dry-run sprint demo, first leg (a confirmed addition)
// ---------------------------------------------------------------------------

describe('the dry-run sprint demo: a confirmed addition (real composition, dry run)', () => {
  /** The preview header's and the `reload-applied` line's counts for one added persona. */
  const ONE_ADDED =
    'personas: 1 added, 0 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; ' +
    'server-wide settings: 0 changed'

  test('sprint demo: in dry run, a persona added to config.json is previewed on one check, confirmed by one rename and brought up and launched on the next, without a restart or any agent-director call; the running persona is untouched and nothing is pending afterwards', async () => {
    const { run, personas } = await running(['alpha'], { realLifecycle: true, dryRun: true })
    const [alpha] = personas
    const alphaKey = h.key('alpha')
    const charlieKey = h.key('charlie')
    expect(run.bringUps.state(alphaKey)?.outcome).toBe('up')
    const charlie = h.persona('charlie')
    h.materialize(charlie)
    const cp = run.checkpoint()

    // Edit, check: the pending file previews the addition and nothing is applied.
    h.writeConfig(configOf(alpha!, charlie))
    await run.ticks.tick()
    expect(h.pendingLines()).toEqual([
      `A configuration change is pending; nothing has been applied. ${ONE_ADDED}.`,
      `persona ${JSON.stringify('charlie')} (key=${charlieKey}) is added: it will be brought up and launched.`,
    ])
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.appliedKeys()).toEqual(keysOf('alpha'))

    // Rename, check: applied.
    h.confirm()
    await run.ticks.tick()

    // Exactly one bring-up, for charlie, which came up and launched.
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: charlieKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: charlieKey, via: 'apply' },
    ])
    expect(run.bringUps.state(charlieKey)?.outcome).toBe('up')
    expect(run.connections.manager.status(charlieKey)?.state).toBe('up')
    expect(run.since(cp).logs).toContain(`[slack] persona ${renderPersonaRef('charlie', charlieKey)}: up at apply — launching`)
    expect(run.composition!.calls).toEqual([
      ['storageCheck', charlieKey],
      ['bringUps.bringUp', charlieKey],
      ['launch', charlieKey],
    ])
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie'))
    expect(run.appliedConfigs.map((c) => c.personas.map((p) => p.key))).toEqual([keysOf('alpha', 'charlie')])
    // Dry run: no credentials file read at the checks or the bring-up, no Slack client, no Slack call.
    expect(run.tickCredentialsReads).toEqual([])
    expect(run.bringUps.credentialsDigest(charlieKey)).toBeUndefined()
    expect(run.slack.builds).toEqual([])
    expect(Object.values(run.slackCalls()).flat()).toEqual([])
    // No agent-director kill, delete or any other call, and no teardown.
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.composition!.agentDirectorOrder).toEqual([])
    expect(run.lifecycle.of('teardown')).toEqual([])
    // No restart: one start pass, one run.
    expect(run.lifecycle.startPasses).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    // Exactly one reload-applied line, naming one addition.
    const appliedLines = run.logsOf(RELOAD_APPLIED)
    expect(appliedLines).toEqual([
      `[slack] ${RELOAD_APPLIED}: applied the confirmed configuration change without a restart (${ONE_ADDED}); ` +
        `the last-applied record ${JSON.stringify(h.paths.lastApplied)} now holds it`,
    ])
    // alpha: no lifecycle record, dependency call or state change.
    expect(run.since(cp).lifecycle.filter((r) => r.key === alphaKey)).toEqual([])
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.bringUps.state(alphaKey)?.outcome).toBe('up')
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Removals (AC 57; b.av2 SR-6.5)
// ---------------------------------------------------------------------------

describe('a confirmed removal tears the persona down (b.av2 SR-6.5, SR-8.6 step 2)', () => {
  test('AC 57: removing bravo from alpha, bravo and charlie tears down bravo only through the real composition: it kills then deletes cscb_<bravo> only, closes only its connection, forgets its bring-up, leaves the applied set, and posts nothing', async () => {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie'], { realLifecycle: true })
    const [alpha, , charlie] = personas
    const bravoKey = h.key('bravo')
    const bravoRef = renderPersonaRef('bravo', bravoKey)
    const before = { alpha: slackSideOf(run, 'alpha'), charlie: slackSideOf(run, 'charlie') }
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, charlie!])

    expect(run.since(cp).lifecycle).toEqual([{ op: 'teardown', key: bravoKey, via: 'apply' }])
    const composition = run.composition!
    expect(composition.agentDirectorOrder).toEqual([`kill ${personaInstanceId(bravoKey)}`, `delete ${personaInstanceId(bravoKey)}`])
    expect(stubCallCount(composition.agentDirector)).toBe(2)
    // Every dependency call is for bravo, except the Stop-hook pass, which re-evaluates against the personas still applied.
    expect(composition.calls.filter(([member, key]) => member !== 'replyGuard.launchPass' && key !== bravoKey)).toEqual([])
    expect(composition.calls.filter(([member]) => member === 'replyGuard.launchPass')).toEqual([
      ['replyGuard.launchPass', keysOf('alpha', 'charlie').join(',')],
    ])
    expect(run.stub('bravo').socket.disconnectCalls).toBe(1)
    expect(run.connections.manager.status(bravoKey)).toBeUndefined()
    expect(run.bringUps.state(bravoKey)).toBeUndefined()
    expect({ alpha: slackSideOf(run, 'alpha'), charlie: slackSideOf(run, 'charlie') }).toEqual(before)
    // No teardown line names another persona, and no apply step failed.
    const teardownLines = run.since(cp).logs.filter((l) => l.startsWith('[slack] persona teardown of '))
    expect(teardownLines.filter((l) => !l.startsWith(`[slack] persona teardown of ${bravoRef}: `))).toEqual([])
    expect(run.logsOf('reload')).toEqual([])
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie'))
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; breakBravo: (bravo: PersonaInput) => void; outcome: PersonaBringUpOutcome }>([
    { label: 'broken by its credentials', breakBravo: (bravo) => h.deleteCredentials(bravo), outcome: 'broken' },
    { label: 'retrying on a missing working directory', breakBravo: (bravo) => h.deleteWorkingDirectory(bravo), outcome: 'retrying' },
  ])('a persona that is not up ($label) is still torn down, and nothing brings it up or launches it afterwards (real composition)', async ({ breakBravo, outcome }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true }, ([, bravo]) => breakBravo(bravo!))
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe(outcome)
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!])

    expect(run.since(cp).lifecycle).toEqual([{ op: 'teardown', key: bravoKey, via: 'apply' }])
    expect(run.composition!.agentDirectorOrder).toEqual([`kill ${personaInstanceId(bravoKey)}`, `delete ${personaInstanceId(bravoKey)}`])
    // Its retry timer is gone: with its directory back, far past every retry, nothing runs for it.
    expect(run.clock.pendingCount()).toBe(0)
    h.materialize(bravo!)
    const after = run.checkpoint()
    await run.clock.advance(3_600_000)
    expect(run.since(after).lifecycle).toEqual([])
    expect(run.since(after).slackBuilds).toBe(0)
    expect(run.bringUps.state(bravoKey)).toBeUndefined()
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; trigger: (run: ReloadRun) => Promise<unknown> }>([
    { label: 'its Slack retry comes due', trigger: (run) => run.clock.advance(3_600_000) },
    {
      label: 'an up status for its connection reaches the bring-up controller',
      trigger: async (run) => {
        run.bringUps.onConnectionStatus(h.key('bravo'), { state: 'up', identity: run.stub('bravo').identity })
        await run.clock.advance(3_600_000)
      },
    },
  ])('after the removal of bravo, retrying on Slack, is applied, a launch trigger for it ($label) records no bring-up, launch or Slack call for it (real composition)', async ({ trigger }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true, slack: { bravo: SLACK_UNREACHABLE } })
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('retrying')
    await applyConfig(run, [personas[0]!])
    expect(run.lifecycle.keys('teardown')).toEqual([bravoKey])
    const bravoAuthTests = run.stub('bravo').calls.authTest.length
    const cp = run.checkpoint()

    await trigger(run)

    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.since(cp).slackBuilds).toBe(0)
    expect(run.stub('bravo').calls.authTest).toHaveLength(bravoAuthTests)
    expect(run.composition!.calls.filter(([member]) => member === 'launch')).toEqual([])
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// A name change (b.av2 SR-8.6: removal plus addition)
// ---------------------------------------------------------------------------

describe('a name change is a removal of the old key and an addition of the new one (b.av2 SR-8.6)', () => {
  test('renaming bravo tears down its old key, then brings up the new key, and does nothing for alpha (real composition)', async () => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true })
    const [alpha, bravo] = personas
    const oldKey = h.key('bravo')
    const newKey = h.key('bravo2')
    expect(newKey).not.toBe(oldKey)
    const alphaBefore = slackSideOf(run, 'alpha')
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, { ...bravo!, name: 'bravo2' }])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: oldKey, via: 'apply' },
      { op: 'bring-up', key: newKey, via: 'apply', result: expect.objectContaining({ outcome: 'up' }) },
      { op: 'launch', key: newKey, via: 'apply' },
    ])
    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: oldKey, phase: 'start' },
      { op: 'teardown', key: oldKey, phase: 'settled' },
      { op: 'bring-up', key: newKey, phase: 'start' },
      { op: 'bring-up', key: newKey, phase: 'settled' },
    ])
    expect(run.composition!.agentDirectorOrder).toEqual([`kill ${personaInstanceId(oldKey)}`, `delete ${personaInstanceId(oldKey)}`])
    expect(run.composition!.calls.filter(([, key]) => key === h.key('alpha'))).toEqual([])
    expect(slackSideOf(run, 'alpha')).toEqual(alphaBefore)
    expect(run.appliedKeys()).toEqual([h.key('alpha'), newKey])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Step order (b.av2 SR-8.6, SR-6.6)
// ---------------------------------------------------------------------------

describe('step order: every teardown settles before any bring-up starts (b.av2 SR-8.6, SR-6.6)', () => {
  /** alpha, bravo and delta running; the change removes bravo and delta, rotates alpha's token and adds echo and foxtrot. */
  async function removeTwoAddTwo() {
    const { run, personas } = await running(['alpha', 'bravo', 'delta'])
    h.rotateCredentials(personas[0]!)
    const echo = h.persona('echo')
    const foxtrot = h.persona('foxtrot')
    h.materialize(echo, foxtrot)
    return { run, next: [personas[0]!, echo, foxtrot] }
  }

  test("with bravo's teardown held, delta's still runs and settles while no reconnect or bring-up starts; once bravo's is released alpha's reconnect runs and settles, then both bring-ups run, and reload-applied comes last", async () => {
    const { run, next } = await removeTwoAddTwo()
    const [alphaKey, bravoKey, deltaKey, echoKey, foxtrotKey] = keysOf('alpha', 'bravo', 'delta', 'echo', 'foxtrot')
    const gate = run.lifecycle.hold('teardown', bravoKey)

    const { applying } = await confirmConfig(run, next)
    await gate.entered
    await until(() => indexOf(run.lifecycle.timeline, { key: deltaKey, phase: 'settled' }) >= 0)
    // Give a premature step 6 every chance to start.
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))

    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: bravoKey, phase: 'start' },
      { op: 'teardown', key: deltaKey, phase: 'start' },
      { op: 'teardown', key: deltaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.keys('bring-up').filter((k) => k === echoKey || k === foxtrotKey)).toEqual([])
    expect(run.lifecycle.keys('reconnect')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])

    gate.release()
    await applying

    const timeline = run.lifecycle.timeline
    const firstBringUp = indexOf(timeline, { op: 'bring-up', phase: 'start' })
    // Step 4 between them: alpha's reconnect starts right after the last teardown settled and settles before any bring-up.
    expect(indexOf(timeline, { key: bravoKey, phase: 'settled' })).toBe(firstBringUp - 3)
    expect(timeline.slice(firstBringUp - 2, firstBringUp)).toEqual([
      { op: 'reconnect', key: alphaKey, phase: 'start' },
      { op: 'reconnect', key: alphaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.of('reconnect')).toEqual([{ op: 'reconnect', key: alphaKey, via: 'apply', change: { kind: 'swapped' } }])
    expect(timeline.slice(firstBringUp).map((e) => [e.op, e.key, e.phase]).sort()).toEqual(
      [
        ['bring-up', echoKey, 'settled'],
        ['bring-up', echoKey, 'start'],
        ['bring-up', foxtrotKey, 'settled'],
        ['bring-up', foxtrotKey, 'start'],
      ].sort(),
    )
    expect(run.lifecycle.outcome(echoKey)).toBe('up')
    expect(run.lifecycle.outcome(foxtrotKey)).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.logs.at(-1)).toStartWith(`[slack] ${RELOAD_APPLIED}: `)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// In-place updates (AC 58; b.av2 SR-8.6 step 3)
// ---------------------------------------------------------------------------

/** Channel IDs no persona has at the start (`h.persona` assigns `C0RLD001`, `C0RLD002`, …). */
const EXTRA_CHANNEL = 'C0RLDEXTRA1'
const OTHER_CHANNEL = 'C0RLDEXTRA2'
/** DM contacts (`dm.contact`). */
const CONTACT = 'U0RLDCONTACT1'
const NEW_CONTACT = 'U0RLDCONTACT2'

/** The in-place settings whose change forgets the persona's cached DM conversation (Director decision 11). */
const DM_DESTINATION_SETTINGS: readonly InPlaceSetting[] = ['permission_prompts', 'dm.enabled', 'dm.contact']

/** The channel `h.persona(name)` gives the persona (its own `all` channel and destination). */
function ownChannel(name: string): string {
  return h.persona(name).channels![0]!.id
}

/** Web API calls as `<method> <channel or users>`, in order. */
function callTargets(calls: readonly StubWebCall[]): string[] {
  return calls.map((c) => {
    const args = c.args as { channel?: string; users?: string }
    return `${c.method} ${args.channel ?? args.users ?? ''}`
  })
}

/** The persona's Web API calls made from `from` (a `callLog` length taken earlier) on. */
function callsSince(run: ReloadRun, name: string, from: number): string[] {
  return callTargets(run.stub(name).callLog.slice(from))
}

/** What the routing delivered to the persona from `from` (a `deliveries` length taken earlier) on, as `{chat_id, via}`. */
function deliveredSince(run: ReloadRun, name: string, from: number): Array<{ chat_id: string; via: string | undefined }> {
  return run.deliveries(name).slice(from).map(({ chat_id, via }) => ({ chat_id, via }))
}

/** Deliver `event` on the persona's socket and return what the routing delivered to it for that event. */
async function deliverTo(run: ReloadRun, name: string, event: Parameters<ReloadRun['deliver']>[1]) {
  const from = run.deliveries(name).length
  await run.deliver(name, event)
  return deliveredSince(run, name, from)
}

/** Raise a notice for the persona and return the Web API calls it made on the persona's stub. */
async function noticeCalls(run: ReloadRun, name: string): Promise<string[]> {
  const from = run.stub(name).callLog.length
  await run.notice(name, 'a server notice')
  return callsSince(run, name, from)
}

/** The start of the composition's in-place line for a persona and its changed settings. */
function inPlaceLineStart(name: string, settings: readonly InPlaceSetting[]): string {
  return `[slack] persona ${renderPersonaRef(name, h.key(name))}: updated in place (${settings.join(', ')})`
}

/** An MCP tool's posting-scope refusal naming the persona and `target` (b.av2 SR-5.1); its reason sentences are `tests/registry.test.ts`'s. */
function expectRefused(result: { isError: boolean; text: string }, name: string, target: string): void {
  expect(result.isError).toBe(true)
  expect(result.text).toStartWith(`Persona ${renderPersonaRef(name, h.key(name))} may not target ${JSON.stringify(target)}`)
}

/** One b.av2 SR-8.6 in-place row: bravo's settings before and after, as overrides over `h.persona('bravo')` given its own channel. */
interface InPlaceRow {
  label: string
  before: (own: string) => Partial<PersonaInput>
  after: (own: string) => Partial<PersonaInput>
  settings: InPlaceSetting[]
}

const IN_PLACE_ROWS: InPlaceRow[] = [
  {
    label: 'a channel added',
    before: () => ({}),
    after: (own) => ({ channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }),
    settings: ['channels'],
  },
  {
    label: 'a channel removed',
    before: (own) => ({ channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }),
    after: () => ({}),
    settings: ['channels'],
  },
  {
    label: "a channel's delivery flipped",
    before: () => ({}),
    after: (own) => ({ channels: [{ id: own, delivery: 'mentions' }] }),
    settings: ['delivery'],
  },
  {
    label: 'permission_prompts moved between two channels',
    before: (own) => ({ channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }),
    after: (own) => ({
      channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }],
      permission_prompts: EXTRA_CHANNEL,
    }),
    settings: ['permission_prompts'],
  },
  {
    label: 'permission_prompts moved from a channel to dm',
    before: () => ({ dm: { enabled: true, contact: CONTACT } }),
    after: () => ({ dm: { enabled: true, contact: CONTACT }, permission_prompts: 'dm' }),
    settings: ['permission_prompts'],
  },
  {
    label: 'dm.contact changed',
    before: () => ({ dm: { enabled: true, contact: CONTACT }, permission_prompts: 'dm' }),
    after: () => ({ dm: { enabled: true, contact: NEW_CONTACT }, permission_prompts: 'dm' }),
    settings: ['dm.contact'],
  },
  {
    label: 'dm.enabled turned off',
    before: () => ({ dm: { enabled: true } }),
    after: () => ({}),
    settings: ['dm.enabled'],
  },
  {
    label: 'dm.enabled turned on',
    before: () => ({}),
    after: () => ({ dm: { enabled: true } }),
    settings: ['dm.enabled'],
  },
  {
    label: 'every in-place setting changed in one edit',
    before: () => ({}),
    after: (own) => ({
      channels: [{ id: own, delivery: 'mentions' }, { id: EXTRA_CHANNEL, delivery: 'all' }],
      dm: { enabled: true, contact: CONTACT },
      permission_prompts: 'dm',
    }),
    settings: ['channels', 'delivery', 'permission_prompts', 'dm.enabled', 'dm.contact'],
  },
]

describe('AC 58: an in-place change keeps the instance (b.av2 SR-8.6 step 3, the in-place row)', () => {
  test.each(IN_PLACE_ROWS)('AC 58: $label on bravo beside alpha records exactly one in-place update, for bravo, and nothing else: no teardown, bring-up, launch, agent-director call, socket close or re-validation, the same MCP session, and alpha untouched (real composition)', async ({ before, after, settings }) => {
    const own = ownChannel('bravo')
    const { run, personas } = await running(['alpha', ['bravo', before(own)]], REAL_WITH_SESSIONS)
    const [alpha] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const sessions = { alpha: run.session('alpha'), bravo: run.session('bravo') }
    const sides = { alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, h.persona('bravo', after(own))])

    // One in-place update, for bravo, with the settings that changed; no other lifecycle call.
    expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: bravoKey, via: 'apply', settings }])
    expect(run.lifecycle.timeline).toEqual([
      { op: 'update-in-place', key: bravoKey, phase: 'start' },
      { op: 'update-in-place', key: bravoKey, phase: 'settled' },
    ])
    // The composition only forgets bravo's cached DM conversation, and only when a DM destination setting changed.
    const forgets = settings.some((s) => DM_DESTINATION_SETTINGS.includes(s))
    expect(run.composition!.calls).toEqual(forgets ? [['destinations.forget', bravoKey]] : [])
    // Its instance is kept: no agent-director call at all (no spawn, resume, kill, delete or send-keys).
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    // The same registered MCP session for both, still connected.
    expect(run.session('bravo')).toBe(sessions.bravo!)
    expect(run.session('alpha')).toBe(sessions.alpha!)
    expect(sessions.bravo!.connected).toBe(true)
    // No socket closed or reopened, no auth.test, no client built, no Web API call.
    expect({ alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }).toEqual(sides)
    expect(run.since(cp).slackBuilds).toBe(0)
    expect(run.since(cp).slackCalls).toEqual([])
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    // One in-place line, for bravo; nothing for alpha; no step failed.
    const personaLines = run.since(cp).logs.filter((l) => l.startsWith('[slack] persona '))
    expect(personaLines).toHaveLength(1)
    expect(personaLines[0]).toStartWith(`${inPlaceLineStart('bravo', settings)}; `)
    expect(run.since(cp).logs.filter((l) => l.includes(renderPersonaRef('alpha', alphaKey)))).toEqual([])
    expect(run.logsOf('reload')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.appliedKeys()).toEqual([alphaKey, bravoKey])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

describe('AC 58: routing, posting scope and destinations follow the new values from the next event or post (real composition)', () => {
  test("AC 58 channels: bravo gets events in its added channel and not in its removed one (unclaimed-channel logged), and the reply tool refuses the removed channel naming bravo and it while posting to the added one", async () => {
    const own = ownChannel('bravo')
    const { run, personas } = await running(
      ['alpha', ['bravo', { channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }]],
      REAL_WITH_SESSIONS,
    )
    const [alpha] = personas
    const bravoRef = renderPersonaRef('bravo', h.key('bravo'))
    // Before: the old channel is delivered and the new one is not, and the tools (the MCP server built now) allow the old one.
    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: EXTRA_CHANNEL }))).toEqual([
      { chat_id: EXTRA_CHANNEL, via: 'receive_all' },
    ])
    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: OTHER_CHANNEL }))).toEqual([])
    const allowedBefore = await run.callTool('bravo', 'reply', { chat_id: EXTRA_CHANNEL, text: 'to the old channel' })
    expect(allowedBefore.isError).toBe(false)

    await applyConfig(run, [alpha!, h.persona('bravo', { channels: [{ id: own, delivery: 'all' }, { id: OTHER_CHANNEL, delivery: 'all' }] })])
    const cp = run.checkpoint()
    const bravoCalls = run.stub('bravo').callLog.length

    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: OTHER_CHANNEL }))).toEqual([
      { chat_id: OTHER_CHANNEL, via: 'receive_all' },
    ])
    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: EXTRA_CHANNEL }))).toEqual([])
    expect(run.deliveries('alpha')).toEqual([])
    const unclaimed = run.since(cp).logs.filter((l) => l.startsWith(`[slack] ${UNCLAIMED_CHANNEL}: `))
    expect(unclaimed).toHaveLength(1)
    expect(unclaimed[0]).toContain(bravoRef)
    expect(unclaimed[0]).toContain(EXTRA_CHANNEL)

    const refused = await run.callTool('bravo', 'reply', { chat_id: EXTRA_CHANNEL, text: 'to the removed channel' })
    expectRefused(refused, 'bravo', EXTRA_CHANNEL)
    const posted = await run.callTool('bravo', 'reply', { chat_id: OTHER_CHANNEL, text: 'to the added channel' })
    expect(posted.isError).toBe(false)
    // The only posts since the apply: the one reply, in the added channel, on bravo's client.
    expect(callsSince(run, 'bravo', bravoCalls).filter((c) => c.startsWith('chat.postMessage'))).toEqual([
      `chat.postMessage ${OTHER_CHANNEL}`,
    ])
    expect(callTargets(run.slackPosts())).toEqual([`chat.postMessage ${EXTRA_CHANNEL}`, `chat.postMessage ${OTHER_CHANNEL}`])
    assertNoLeak(run.captured({ allowedBefore, refused, posted }))
  })

  test.each<{ from: 'all' | 'mentions'; to: 'all' | 'mentions' }>([
    { from: 'all', to: 'mentions' },
    { from: 'mentions', to: 'all' },
  ])('AC 58 delivery: after bravo\'s channel goes from $from to $to, the next plain message is delivered or dropped by the new mode, and a mention is delivered', async ({ from, to }) => {
    const own = ownChannel('bravo')
    const { run, personas } = await running(['alpha', ['bravo', { channels: [{ id: own, delivery: from }] }]], REAL_WITH_SESSIONS)
    const plainExpected = (mode: 'all' | 'mentions') => (mode === 'all' ? [{ chat_id: own, via: 'receive_all' }] : [])
    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: own }))).toEqual(plainExpected(from))

    await applyConfig(run, [personas[0]!, h.persona('bravo', { channels: [{ id: own, delivery: to }] })])

    expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: own }))).toEqual(plainExpected(to))
    const mention = makeChannelMessage({ channel: own, text: `${mentionText(run.stub('bravo').identity.botUserId)} are you there` })
    expect(await deliverTo(run, 'bravo', mention)).toEqual([{ chat_id: own, via: 'mention' }])
    expect(run.deliveries('alpha')).toEqual([])
    expectNoPostNoLeak(run)
  })

  test("AC 58 delivery: after bravo's copy of a channel it shares with alpha goes from all to mentions, alpha's next plain message there arrives as receive_all, not receive_all_shared, though alpha itself was not updated", async () => {
    const shared = ownChannel('alpha')
    const bravoWith = (delivery: 'all' | 'mentions'): Partial<PersonaInput> => ({
      channels: [{ id: ownChannel('bravo'), delivery: 'all' }, { id: shared, delivery }],
    })
    const { run, personas } = await running(['alpha', ['bravo', bravoWith('all')]], REAL_WITH_SESSIONS)
    // Before: bravo also receives every message there, so alpha's delivery is shared.
    expect(await deliverTo(run, 'alpha', makeChannelMessage({ channel: shared }))).toEqual([
      { chat_id: shared, via: 'receive_all_shared' },
    ])
    const cp = run.checkpoint()

    await applyConfig(run, [personas[0]!, h.persona('bravo', bravoWith('mentions'))])

    // Only bravo was updated in place; alpha's own entry is unchanged.
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'update-in-place', key: h.key('bravo'), via: 'apply', settings: ['delivery'] },
    ])
    expect(await deliverTo(run, 'alpha', makeChannelMessage({ channel: shared }))).toEqual([
      { chat_id: shared, via: 'receive_all' },
    ])
    expect(run.deliveries('bravo')).toEqual([])
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; before: (own: string) => Partial<PersonaInput>; after: (own: string) => Partial<PersonaInput>; old: (own: string) => string[]; next: (own: string) => string[] }>([
    {
      label: 'another channel',
      before: (own) => ({ channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }),
      after: (own) => ({ channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }], permission_prompts: EXTRA_CHANNEL }),
      old: (own) => [`chat.postMessage ${own}`],
      next: () => [`chat.postMessage ${EXTRA_CHANNEL}`],
    },
    {
      label: 'dm from a channel',
      before: () => ({ dm: { enabled: true, contact: CONTACT } }),
      after: () => ({ dm: { enabled: true, contact: CONTACT }, permission_prompts: 'dm' }),
      old: (own) => [`chat.postMessage ${own}`],
      next: () => [`conversations.open ${CONTACT}`, `chat.postMessage ${stubOpenedDmId(CONTACT)}`],
    },
    {
      label: 'a channel from dm',
      before: () => ({ dm: { enabled: true, contact: CONTACT }, permission_prompts: 'dm' }),
      after: (own) => ({ dm: { enabled: true, contact: CONTACT }, permission_prompts: own }),
      old: () => [`conversations.open ${CONTACT}`, `chat.postMessage ${stubOpenedDmId(CONTACT)}`],
      next: (own) => [`chat.postMessage ${own}`],
    },
  ])('AC 58 permission_prompts: after bravo\'s destination moves to $label, the next notice posts to the new destination through bravo\'s client and nothing goes to the old one', async ({ before, after, old, next }) => {
    const own = ownChannel('bravo')
    const { run, personas } = await running(['alpha', ['bravo', before(own)]], REAL_WITH_SESSIONS)
    expect(await noticeCalls(run, 'bravo')).toEqual(old(own))

    await applyConfig(run, [personas[0]!, h.persona('bravo', after(own))])

    expect(await noticeCalls(run, 'bravo')).toEqual(next(own))
    expect(run.stub('alpha').callLog.map((c) => c.method)).toEqual(['auth.test'])
    assertNoLeak(run.captured())
  })

  test("AC 58 dm.contact: the apply opens no conversation; the next notice opens the DM with the new contact on bravo's client and posts there, never to the conversation cached for the old contact", async () => {
    const dmTo = (contact: string): Partial<PersonaInput> => ({ dm: { enabled: true, contact }, permission_prompts: 'dm' })
    const { run, personas } = await running(['alpha', ['bravo', dmTo(CONTACT)]], REAL_WITH_SESSIONS)
    const oldDm = stubOpenedDmId(CONTACT)
    const newDm = stubOpenedDmId(NEW_CONTACT)
    expect(newDm).not.toBe(oldDm)
    // Before: the first notice opens the old contact's DM, the second reuses it (cached).
    expect(await noticeCalls(run, 'bravo')).toEqual([`conversations.open ${CONTACT}`, `chat.postMessage ${oldDm}`])
    expect(await noticeCalls(run, 'bravo')).toEqual([`chat.postMessage ${oldDm}`])
    const cp = run.checkpoint()

    await applyConfig(run, [personas[0]!, h.persona('bravo', dmTo(NEW_CONTACT))])

    // The apply itself makes no Slack call: the DM is opened on the next post, not eagerly.
    expect(run.since(cp).slackCalls).toEqual([])
    expect(run.lifecycle.keys('update-in-place')).toEqual([h.key('bravo')])
    expect(await noticeCalls(run, 'bravo')).toEqual([`conversations.open ${NEW_CONTACT}`, `chat.postMessage ${newDm}`])
    expect(await noticeCalls(run, 'bravo')).toEqual([`chat.postMessage ${newDm}`])
    expect(run.stub('alpha').callLog.map((c) => c.method)).toEqual(['auth.test'])
    assertNoLeak(run.captured())
  })

  test("AC 58 permission_prompts: after bravo's destination moves from dm to a channel and back to dm, the next notice opens the DM again: an apply forgets the conversation cached before it (Director decision 11)", async () => {
    const own = ownChannel('bravo')
    const dmOn = { enabled: true, contact: CONTACT }
    const dm = stubOpenedDmId(CONTACT)
    const { run, personas } = await running(['alpha', ['bravo', { dm: dmOn, permission_prompts: 'dm' }]], { realLifecycle: true })
    // Before: the first notice opens the DM, the second reuses the cached conversation.
    expect(await noticeCalls(run, 'bravo')).toEqual([`conversations.open ${CONTACT}`, `chat.postMessage ${dm}`])
    expect(await noticeCalls(run, 'bravo')).toEqual([`chat.postMessage ${dm}`])

    await applyConfig(run, [personas[0]!, h.persona('bravo', { dm: dmOn, permission_prompts: own })])
    expect(await noticeCalls(run, 'bravo')).toEqual([`chat.postMessage ${own}`])
    await applyConfig(run, [personas[0]!, h.persona('bravo', { dm: dmOn, permission_prompts: 'dm' })])

    // Same contact, yet the conversation is opened again rather than taken from the cache.
    expect(await noticeCalls(run, 'bravo')).toEqual([`conversations.open ${CONTACT}`, `chat.postMessage ${dm}`])
    expect(run.lifecycle.keys('update-in-place')).toEqual(keysOf('bravo', 'bravo'))
    expect(run.stub('alpha').callLog.map((c) => c.method)).toEqual(['auth.test'])
    assertNoLeak(run.captured())
  })

  test('AC 58 dm.enabled off: a DM on bravo\'s connection is dropped with one persona-dm-dropped line naming bravo, and the reply tool refuses a DM conversation and a user ID with no conversations.open', async () => {
    const { run, personas } = await running(['alpha', ['bravo', { dm: { enabled: true, contact: CONTACT } }]], REAL_WITH_SESSIONS)
    const dm = makeDm().channel as string
    expect(await deliverTo(run, 'bravo', makeDm())).toEqual([{ chat_id: dm, via: 'dm' }])
    // Before: the tools (the MCP server built now) may reply in the DM.
    const allowedBefore = await run.callTool('bravo', 'reply', { chat_id: dm, text: 'in the DM, DMs on' })
    expect(allowedBefore.isError).toBe(false)

    await applyConfig(run, [personas[0]!, h.persona('bravo', { dm: { enabled: false, contact: CONTACT } })])
    const cp = run.checkpoint()
    const bravoCalls = run.stub('bravo').callLog.length

    expect(await deliverTo(run, 'bravo', makeDm())).toEqual([])
    const dropped = run.since(cp).logs.filter((l) => l.startsWith(`[slack] ${PERSONA_DM_DROPPED}: `))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain(renderPersonaRef('bravo', h.key('bravo')))
    const toDm = await run.callTool('bravo', 'reply', { chat_id: dm, text: 'in the DM' })
    const toUser = await run.callTool('bravo', 'reply', { chat_id: CONTACT, text: 'to the contact' })
    expectRefused(toDm, 'bravo', dm)
    expectRefused(toUser, 'bravo', CONTACT)
    // No Slack call on bravo's client since the apply: no open, no post.
    expect(callsSince(run, 'bravo', bravoCalls)).toEqual([])
    expect(callTargets(run.slackPosts())).toEqual([`chat.postMessage ${dm}`])
    assertNoLeak(run.captured({ allowedBefore, toDm, toUser }))
  })

  test('AC 58 dm.enabled on: a DM on bravo\'s connection, dropped before the apply, is delivered after it with via "dm"', async () => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_WITH_SESSIONS)
    const dm = makeDm().channel as string
    expect(await deliverTo(run, 'bravo', makeDm())).toEqual([])
    expect(run.logsOf(PERSONA_DM_DROPPED)).toHaveLength(1)

    await applyConfig(run, [personas[0]!, h.persona('bravo', { dm: { enabled: true } })])

    expect(await deliverTo(run, 'bravo', makeDm())).toEqual([{ chat_id: dm, via: 'dm' }])
    expect(run.logsOf(PERSONA_DM_DROPPED)).toHaveLength(1)
    expect(run.deliveries('alpha')).toEqual([])
    expectNoPostNoLeak(run)
  })
})

describe('step order with teardowns, in-place updates and bring-ups (b.av2 SR-8.6 steps 2, 3 and 6)', () => {
  /** alpha, bravo and charlie running; the change removes charlie, adds a channel to bravo and adds delta. */
  async function removeModifyAdd() {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie'])
    const own = ownChannel('bravo')
    const delta = h.persona('delta')
    h.materialize(delta)
    const bravo = h.persona('bravo', { channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] })
    return { run, next: [personas[0]!, bravo, delta] }
  }

  /** Yield event-loop turns so a premature next step would have started. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))
  }

  test("AC 58: with charlie's teardown held, bravo's in-place update does not start; with bravo's update held, delta's bring-up does not start; releasing each runs the next step, and reload-applied comes last", async () => {
    const { run, next } = await removeModifyAdd()
    const [bravoKey, charlieKey, deltaKey] = keysOf('bravo', 'charlie', 'delta')
    const teardown = run.lifecycle.hold('teardown', charlieKey)
    const update = run.lifecycle.hold('update-in-place', bravoKey)

    const { applying } = await confirmConfig(run, next)
    await teardown.entered
    await settle()
    expect(run.lifecycle.timeline).toEqual([{ op: 'teardown', key: charlieKey, phase: 'start' }])
    expect(run.lifecycle.keys('update-in-place')).toEqual([])

    teardown.release()
    await update.entered
    await settle()
    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: charlieKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'settled' },
      { op: 'update-in-place', key: bravoKey, phase: 'start' },
    ])
    expect(run.lifecycle.keys('bring-up').filter((k) => k === deltaKey)).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])

    update.release()
    await applying

    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: charlieKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'settled' },
      { op: 'update-in-place', key: bravoKey, phase: 'start' },
      { op: 'update-in-place', key: bravoKey, phase: 'settled' },
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.of('update-in-place')).toEqual([{ op: 'update-in-place', key: bravoKey, via: 'apply', settings: ['channels'] }])
    expect(run.lifecycle.outcome(deltaKey)).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.logs.at(-1)).toStartWith(`[slack] ${RELOAD_APPLIED}: `)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("AC 68: a removal, an in-place change, a credentials rotation and an addition in one apply run as teardown, then in-place update, then reconnect, then bring-up; with alpha's reconnect held, delta's bring-up does not start", async () => {
    const { run, next } = await removeModifyAdd()
    const [alphaKey, bravoKey, charlieKey, deltaKey] = keysOf('alpha', 'bravo', 'charlie', 'delta')
    h.rotateCredentials(next[0]!)
    const reconnect = run.lifecycle.hold('reconnect', alphaKey)

    const { applying } = await confirmConfig(run, next)
    await reconnect.entered
    await settle()
    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: charlieKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'settled' },
      { op: 'update-in-place', key: bravoKey, phase: 'start' },
      { op: 'update-in-place', key: bravoKey, phase: 'settled' },
      { op: 'reconnect', key: alphaKey, phase: 'start' },
    ])
    expect(run.lifecycle.keys('bring-up').filter((k) => k === deltaKey)).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])

    reconnect.release()
    await applying

    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: charlieKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'settled' },
      { op: 'update-in-place', key: bravoKey, phase: 'start' },
      { op: 'update-in-place', key: bravoKey, phase: 'settled' },
      { op: 'reconnect', key: alphaKey, phase: 'start' },
      { op: 'reconnect', key: alphaKey, phase: 'settled' },
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.of('reconnect')).toEqual([{ op: 'reconnect', key: alphaKey, via: 'apply', change: { kind: 'swapped' } }])
    expect(run.lifecycle.outcome(deltaKey)).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.logs.at(-1)).toStartWith(`[slack] ${RELOAD_APPLIED}: `)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  /**
   * alpha, bravo, charlie, delta, golf and hotel running; the change removes
   * bravo and delta (step 2), adds a channel to alpha and to charlie (step
   * 3), rotates golf's and hotel's tokens (step 4), and adds echo and foxtrot
   * (step 6): two personas in each step.
   */
  async function twoOfEach() {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie', 'delta', 'golf', 'hotel'])
    const withExtra = (name: string, extra: string) =>
      h.persona(name, { channels: [{ id: ownChannel(name), delivery: 'all' }, { id: extra, delivery: 'all' }] })
    const [, , , , golf, hotel] = personas
    h.rotateCredentials(golf!)
    h.rotateCredentials(hotel!)
    const echo = h.persona('echo')
    const foxtrot = h.persona('foxtrot')
    h.materialize(echo, foxtrot)
    expect(personas.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'golf', 'hotel'])
    return { run, next: [withExtra('alpha', EXTRA_CHANNEL), withExtra('charlie', OTHER_CHANNEL), golf!, hotel!, echo, foxtrot] }
  }

  /** The apply step each timeline op belongs to, in step order. */
  const STEP_OF: Record<LifecycleTimelineEntry['op'], number> = { teardown: 2, 'update-in-place': 3, reconnect: 4, 'bring-up': 6 }

  // Each row fails the step's second persona, so the line must name the one that failed.
  // Either way the failure is one controller line with no message, the step's other
  // persona still settles, every later step still runs, and the apply finishes.
  test.each<{ label: string; op: LifecycleTimelineEntry['op']; failing: string; step: string }>([
    { label: 'step 2', op: 'teardown', failing: 'delta', step: '2 (teardowns)' },
    { label: 'AC 58: step 3', op: 'update-in-place', failing: 'charlie', step: '3 (in-place-updates)' },
    { label: 'AC 68: step 4', op: 'reconnect', failing: 'hotel', step: '4 (credentials-reconnects)' },
    { label: 'step 6', op: 'bring-up', failing: 'foxtrot', step: '6 (bring-ups)' },
  ])("$label: when one $op rejects, it is logged once by the controller without its message, the step's other persona still settles, the later steps still run, and the apply finishes", async ({ op, failing, step }) => {
    const { run, next } = await twoOfEach()
    const [alphaKey, bravoKey, charlieKey, deltaKey, echoKey, foxtrotKey, golfKey, hotelKey] = keysOf(
      'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    )
    const failingKey = h.key(failing)
    // A failure whose message holds a fake token: only its class may be logged.
    run.lifecycle.hold(op, failingKey).fail(new Error(`lifecycle op exploded ${fakeToken(APP_TOKEN_PREFIX, 'failure')}`))

    await applyConfig(run, next)

    // Every entry of a step, start and end, comes before any entry of the next step; each call ended once.
    const timeline = run.lifecycle.timeline
    const steps = timeline.map((e) => STEP_OF[e.op])
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    const ended = (callOp: typeof op, key: string) => (callOp === op && key === failingKey ? 'rejected' : 'settled')
    const call = (callOp: typeof op, key: string) => [
      [callOp, key, 'start'],
      [callOp, key, ended(callOp, key)],
    ]
    expect(timeline.map((e) => [e.op, e.key, e.phase]).sort()).toEqual(
      [
        ...call('teardown', bravoKey),
        ...call('teardown', deltaKey),
        ...call('update-in-place', alphaKey),
        ...call('update-in-place', charlieKey),
        ...call('reconnect', golfKey),
        ...call('reconnect', hotelKey),
        ...call('bring-up', echoKey),
        ...call('bring-up', foxtrotKey),
      ].sort(),
    )
    expect(run.lifecycle.outcome(echoKey)).toBe('up')
    expect(run.lifecycle.outcome(foxtrotKey)).toBe(op === 'bring-up' ? undefined : 'up')
    const failed = run.logsOf('reload')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(
      `[slack] reload: apply step ${step} failed for persona ${renderPersonaRef(failing, failingKey)}: Error`,
    )
    expect(failed[0]).not.toContain('exploded')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie', 'golf', 'hotel', 'echo', 'foxtrot'))
    expect(run.lifecycle.of('reconnect').find((r) => r.key === golfKey)!.change).toEqual({ kind: 'swapped' })
    if (op === 'reconnect') {
      // The rejected reconnect never ran, so hotel's change is pending again.
      await expectCredentialsPending(run, next[3]!)
    } else {
      await expectNothingPendingAfter(run)
    }
    expectNoPostNoLeak(run)
  })
})

describe('AC 58: a persona that is not up is still updated in place, and nothing brings it up (b.av2 SR-8.6)', () => {
  test.each<{ label: string; breakBravo: (bravo: PersonaInput) => void; outcome: PersonaBringUpOutcome }>([
    { label: 'retrying on a missing working directory', breakBravo: (bravo) => h.deleteWorkingDirectory(bravo), outcome: 'retrying' },
    { label: 'broken by a missing credentials file', breakBravo: (bravo) => h.deleteCredentials(bravo), outcome: 'broken' },
  ])('AC 58: bravo $label, given a new channel, records one in-place update and no bring-up, teardown or retry reset; once up it routes by the new values (real composition)', async ({ breakBravo, outcome }) => {
    const own = ownChannel('bravo')
    const { run, personas } = await running(['alpha', 'bravo'], REAL_WITH_SESSIONS, ([, bravo]) => breakBravo(bravo!))
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe(outcome)
    const pendingBefore = run.clock.pending()
    const cp = run.checkpoint()
    const edited = h.persona('bravo', { channels: [{ id: own, delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] })

    await applyConfig(run, [personas[0]!, edited])

    expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: bravoKey, via: 'apply', settings: ['channels'] }])
    expect(run.composition!.calls).toEqual([])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    // Its retry (if any) is exactly as it was: not reset, cancelled or rescheduled.
    expect(run.clock.pending()).toEqual(pendingBefore)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe(outcome)
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)

    if (outcome === 'retrying') {
      // Its pending re-check still fires on the fake clock and brings it up with no confirmation.
      h.makeWorkingDirectory(edited)
      const retry = run.checkpoint()
      await run.clock.runNext()
      expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
      expect(run.since(retry).lifecycle).toEqual([{ op: 'launch', key: bravoKey, via: 'retry' }])
      // Up, it routes by the new values: its added channel is delivered.
      expect(await deliverTo(run, 'bravo', makeChannelMessage({ channel: EXTRA_CHANNEL }))).toEqual([
        { chat_id: EXTRA_CHANNEL, via: 'receive_all' },
      ])
    } else {
      expect(pendingBefore).toEqual([])
    }
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("AC 58 permission_prompts: a notice raised while bravo retries on a missing working directory is held; after the apply moves its destination and the directory appears, the retry brings it up and the notice posts once, to the new destination, never the old (real composition)", async () => {
    const own = ownChannel('bravo')
    const channels = [{ id: own, delivery: 'all' as const }, { id: EXTRA_CHANNEL, delivery: 'all' as const }]
    const { run, personas } = await running(['alpha', ['bravo', { channels }]], { realLifecycle: true }, ([, bravo]) =>
      h.deleteWorkingDirectory(bravo!),
    )
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('retrying')
    // Raised before the apply: bravo has no validated client, so the notifier holds it.
    await run.notice('bravo', 'a notice raised before the apply')
    expect(run.slackPosts()).toEqual([])
    const edited = h.persona('bravo', { channels, permission_prompts: EXTRA_CHANNEL })

    await applyConfig(run, [personas[0]!, edited])

    expect(run.lifecycle.keys('update-in-place')).toEqual([bravoKey])
    expect(run.slackPosts()).toEqual([])
    // The directory appears; the pending retry brings bravo up and its up status flushes the held notice.
    h.makeWorkingDirectory(edited)
    await run.clock.runNext()
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    await until(() => run.slackPosts().length > 0)
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))
    const posts = run.slackPosts()
    expect(callTargets(posts)).toEqual([`chat.postMessage ${EXTRA_CHANNEL}`])
    expect(posts[0]!.args).toMatchObject({ text: expect.stringContaining('a notice raised before the apply') })
    // On bravo's own client.
    expect(run.stub('bravo').callLog.filter((c) => c.method === 'chat.postMessage')).toEqual(posts)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Credentials changes (AC 68; b.av2 SR-8.6 step 4, step 6's extra case and the
// credentials row, SR-3.3 reconnect part, SR-6.4 recovery, SR-1.4 apply part)
// ---------------------------------------------------------------------------

/** A persona's bot identity as the manager and a stub name it. */
function identityOf(stub: { identity: { botUserId: string; botId: string } }) {
  return { botUserId: stub.identity.botUserId, botId: stub.identity.botId }
}

/** The start of a preview's credentials line for `persona` (its wording is `tests/reload-preview.test.ts`'s). */
function credentialsLineStart(persona: PersonaInput): string {
  return `persona ${renderPersonaRef(persona.name, h.key(persona.name))}: credentials file ${JSON.stringify(persona.credentials_file)} changed`
}

/** The `persona-credentials-change-failed` lines naming `persona` at entry `index`, with its credentials path. */
function changeFailedLines(run: ReloadRun, persona: PersonaInput, index: number): string[] {
  const start = `[slack] ${PERSONA_CREDENTIALS_CHANGE_FAILED}: personas[${index}] ${renderPersonaRef(persona.name, h.key(persona.name))} path=${JSON.stringify(persona.credentials_file)}: `
  return run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED).filter((l) => l.startsWith(start))
}

/**
 * The change is pending again: the next check writes `config.json.pending`
 * with `persona`'s credentials line (checked for leaks while it exists).
 */
async function expectCredentialsPending(run: ReloadRun, persona: PersonaInput): Promise<void> {
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  expect(h.pendingLines()!.filter((l) => l.startsWith(credentialsLineStart(persona)))).toHaveLength(1)
  assertNoLeak(run.captured())
}

/** The persona's socket activity from `from` (a `socketActivity` length taken earlier) on. */
function socketActivitySince(run: ReloadRun, name: string, from: number): string[] {
  return run.socketActivity(name).slice(from)
}

describe('AC 68: a confirmed token rotation reconnects only that persona (b.av2 SR-8.6 step 4, the credentials row)', () => {
  test("AC 68: bravo's token rotated in the same file and confirmed records exactly one reconnect for bravo: the new connection opens before the old closes, its identity comes from the new auth.test (another bot and app), its instance and MCP session are kept, and alpha gets no lifecycle call and no auth.test (real composition)", async () => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_WITH_SESSIONS)
    const [, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const oldLabel = h.credentialsLabel('bravo')
    const oldStub = run.stub('bravo')
    const oldIdentity = identityOf(oldStub)
    const sessions = { alpha: run.session('alpha'), bravo: run.session('bravo') }
    const alphaBefore = slackSideOf(run, 'alpha')
    const activityFrom = run.socketActivity('bravo').length
    const oldAuthTests = oldStub.calls.authTest.length

    const { tokens, label } = h.rotateCredentials(bravo!)
    const cp = run.checkpoint()
    await (await run.confirmPending()).applying

    // Only a reconnect, for bravo, and it swapped: no teardown, bring-up or launch.
    expect(run.since(cp).lifecycle).toEqual([{ op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'swapped' } }])
    expect(run.lifecycle.timeline).toEqual([
      { op: 'reconnect', key: bravoKey, phase: 'start' },
      { op: 'reconnect', key: bravoKey, phase: 'settled' },
    ])
    expect(run.composition!.calls).toEqual([
      ['bringUps.changeCredentials', bravoKey],
      ['connections.reconnectCredentials', bravoKey],
      ['destinations.forget', bravoKey],
    ])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    // The new connection opened, then the old one closed.
    expect(socketActivitySince(run, 'bravo', activityFrom)).toEqual([
      `built ${label}`,
      `started ${label}`,
      `connected ${label}`,
      `discarded ${oldLabel}`,
      `disconnected ${oldLabel}`,
    ])
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    // Every client built for the change took the new file's tokens; the identity is the new auth.test's.
    const newBuilds = run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)
    expect(newBuilds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of newBuilds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.credentialsStub('bravo', label).calls.authTest).toHaveLength(1)
    expect(oldStub.calls.authTest).toHaveLength(oldAuthTests)
    const newIdentity = identityOf(run.credentialsStub('bravo', label))
    expect(newIdentity.botUserId).not.toBe(oldIdentity.botUserId)
    expect(newIdentity.botId).not.toBe(oldIdentity.botId)
    expect(run.connections.manager.identity(bravoKey)).toEqual(newIdentity)
    // Instance and conversation kept: the same MCP session, still up and admitted.
    expect(run.session('bravo')).toBe(sessions.bravo!)
    expect(run.session('alpha')).toBe(sessions.alpha!)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.isUp('bravo')).toBe(true)
    // Its next event arrives on the new connection, and the new client names the author.
    const own = ownChannel('bravo')
    const usersInfoFrom = run.credentialsStub('bravo', label).calls.usersInfo.length
    await run.credentialsStub('bravo', label).socket.deliver(makeChannelMessage({ channel: own }))
    expect(deliveredSince(run, 'bravo', 0)).toEqual([{ chat_id: own, via: 'receive_all' }])
    expect(run.credentialsStub('bravo', label).calls.usersInfo).toHaveLength(usersInfoFrom + 1)
    // alpha: nothing at all.
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(slackSideOf(run, 'alpha')).toEqual(alphaBefore)
    expect(run.since(cp).logs.filter((l) => l.includes(renderPersonaRef('alpha', alphaKey)))).toEqual([])
    // The held content is the new file's, so nothing is left pending.
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(bravo!))
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([])
    expect(run.logsOf('reload')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; slack?: StubSlackOptions; swapped: boolean }>([
    { label: 'succeeds', swapped: true },
    { label: 'is refused by Slack', slack: SLACK_AUTH_REJECTED, swapped: false },
  ])("the DM-destination cache: after bravo's credentials change $label, its next notice to its dm destination opens the conversation again through the new client, or reuses the cached one on the old client when the change failed (real composition)", async ({ slack, swapped }) => {
    const dmTo: Partial<PersonaInput> = { dm: { enabled: true, contact: CONTACT }, permission_prompts: 'dm' }
    const { run, personas } = await running(['alpha', ['bravo', dmTo]], { realLifecycle: true })
    const bravoKey = h.key('bravo')
    const dm = stubOpenedDmId(CONTACT)
    // Before: the first notice opens the DM on the old client, which caches it.
    expect(await noticeCalls(run, 'bravo')).toEqual([`conversations.open ${CONTACT}`, `chat.postMessage ${dm}`])
    const oldFrom = run.stub('bravo').callLog.length
    const { label } = h.rotateCredentials(personas[1]!, { slack })

    await (await run.confirmPending()).applying
    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: swapped ? { kind: 'swapped' } : { kind: 'failed', cause: expect.any(String) } },
    ])
    expect(run.composition!.calls.filter(([member]) => member === 'destinations.forget')).toEqual(
      swapped ? [['destinations.forget', bravoKey]] : [],
    )
    await run.notice('bravo', 'after the change')

    const newCalls = callTargets(run.credentialsStub('bravo', label).callLog.filter((c) => c.method !== 'auth.test'))
    if (swapped) {
      expect(newCalls).toEqual([`conversations.open ${CONTACT}`, `chat.postMessage ${dm}`])
      expect(callsSince(run, 'bravo', oldFrom)).toEqual([])
    } else {
      expect(newCalls).toEqual([])
      expect(callsSince(run, 'bravo', oldFrom)).toEqual([`chat.postMessage ${dm}`])
    }
    expect(run.stub('alpha').callLog.map((c) => c.method)).toEqual(['auth.test'])
    assertNoLeak(run.captured())
  })

  test("AC 68: a reconnect whose start() never settles holds the apply at step 4 until 10 s on the fake clock, while alpha keeps delivering its events; then it is abandoned, the old connection stays open and in use, the reconnect retries (complete for step order), step 5 refreshes the template once (the added persona brings a new config directory), step 6 then brings up the persona added in the same apply, alpha gets no lifecycle call and its Slack side is untouched, and a later tick detects and previews a further edit", async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const [bravoKey, deltaKey] = keysOf('bravo', 'delta')
    run.registerSession('alpha')
    const oldLabel = h.credentialsLabel('bravo')
    const oldIdentity = identityOf(run.stub('bravo'))
    const { label } = h.rotateCredentials(bravo!, { slack: { connect: [{ kind: 'open-never-answers' }] } })
    // Its own config directory changes the set of effective config directories, so the apply runs step 5.
    const delta = h.persona('delta', { claude_config_dir: h.configDir('delta') })
    h.materialize(delta)
    h.writeConfig(configOf(alpha!, bravo!, delta))
    const activityFrom = run.socketActivity('bravo').length
    const t0 = run.clock.now()
    const alphaUntouched = watchUntouched(run, 'alpha')

    const { applying } = await run.confirmPending()
    await until(() => run.socketActivity('bravo').includes(`started ${label}`))
    // Just short of the bound: still at step 4, so step 6 has not started.
    await run.clock.advanceTo(t0 + 9_999)
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))
    expect(run.lifecycle.timeline).toEqual([{ op: 'reconnect', key: bravoKey, phase: 'start' }])
    expect(run.lifecycle.keys('bring-up').filter((k) => k === deltaKey)).toEqual([])
    // Step 5 has not been asked either: no template refresh before the bound.
    expect(run.lifecycle.applyTimeline).toEqual([{ op: 'reconnect', key: bravoKey, phase: 'start' }])
    expect(run.lifecycle.of('template-refresh')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])
    // Nothing of bravo's hang reaches alpha: untouched so far, and its next event is delivered while step 4 still holds.
    alphaUntouched()
    expect(await deliverTo(run, 'alpha', makeChannelMessage({ channel: ownChannel('alpha') }))).toEqual([
      { chat_id: ownChannel('alpha'), via: 'receive_all' },
    ])
    expect(run.lifecycle.timeline).toEqual([{ op: 'reconnect', key: bravoKey, phase: 'start' }])
    // The delivery's one users.info call is alpha's only Slack call; watch again from here.
    const alphaStillUntouched = watchUntouched(run, 'alpha')

    // At 10 s the attempt is abandoned; the reconnect is left retrying, and the apply moves on.
    await run.clock.advanceTo(t0 + 10_000)
    await applying

    expect(run.lifecycle.timeline).toEqual([
      { op: 'reconnect', key: bravoKey, phase: 'start' },
      { op: 'reconnect', key: bravoKey, phase: 'settled' },
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    // Exactly one refresh, after the abandoned reconnect settled and before step 6.
    expect(run.lifecycle.applyTimeline).toEqual([
      { op: 'reconnect', key: bravoKey, phase: 'start' },
      { op: 'reconnect', key: bravoKey, phase: 'settled' },
      { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, phase: 'start' },
      { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, phase: 'settled' },
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.of('template-refresh')).toHaveLength(1)
    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'kept' } },
    ])
    expect(run.lifecycle.outcome(deltaKey)).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    // The old connection stays open and in use: never closed, same identity, its client posts.
    const activity = socketActivitySince(run, 'bravo', activityFrom)
    expect(activity).not.toContain(`connected ${label}`)
    expect(activity.filter((a) => a.endsWith(` ${oldLabel}`))).toEqual([])
    expect(run.stub('bravo').socket.disconnectCalls).toBe(0)
    expect(run.connections.manager.status(bravoKey)?.state).toBe('up')
    expect(run.connections.manager.identity(bravoKey)).toEqual(oldIdentity)
    expect(run.currentStub('bravo')).toBe(run.stub('bravo'))
    expect(await noticeCalls(run, 'bravo')).toEqual([`chat.postMessage ${ownChannel('bravo')}`])
    // Its next attempt is due on the SR-3.2 backoff's first step.
    expect(run.clock.pending().map((t) => t.dueAt)).toContain(t0 + 15_000)
    alphaStillUntouched()

    // Later ticks run: nothing is pending (the confirmed content is held), and a further edit is previewed.
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    h.writeConfig(configOf(h.persona('alpha', { channels: [{ id: ownChannel('alpha'), delivery: 'mentions' }] }), bravo!, delta))
    await run.ticks.tick()
    expect(h.pendingHeader()).toStartWith('A configuration change is pending; nothing has been applied. ')
    expect(h.pendingHeader()).toContain('1 modified in place')
    assertNoLeak(run.captured())
  })

  test.each<{ label: string; spoil: (bravo: PersonaInput) => void }>([
    { label: 'missing', spoil: (bravo) => h.deleteCredentials(bravo) },
    { label: 'unreadable (a directory at its path)', spoil: (bravo) => h.makeCredentialsUnreadable(bravo) },
    { label: 'locally invalid (no bot_token)', spoil: (bravo) => void h.writeCredentialsContent(bravo, { bot_token: undefined }) },
    { label: 'refused by Slack', spoil: (bravo) => void h.rotateCredentials(bravo, { slack: SLACK_AUTH_REJECTED }) },
  ])("a confirmed credentials file that is $label keeps bravo's old connection, logs one persona-credentials-change-failed line naming bravo, its entry and path, and stays pending, while alpha's in-place change in the same apply is applied", async ({ spoil }) => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const oldIdentity = identityOf(run.stub('bravo'))
    const alphaEdited = h.persona('alpha', { channels: [{ id: ownChannel('alpha'), delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] })
    spoil(bravo!)
    h.writeConfig(configOf(alphaEdited, bravo!))
    const cp = run.checkpoint()

    await (await run.confirmPending()).applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'update-in-place', key: alphaKey, via: 'apply', settings: ['channels'] },
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'failed', cause: expect.any(String) } },
    ])
    // The old connection stays: never closed, same identity, still up.
    expect(run.stub('bravo').socket.disconnectCalls).toBe(0)
    expect(run.currentStub('bravo')).toBe(run.stub('bravo'))
    expect(run.connections.manager.identity(bravoKey)).toEqual(oldIdentity)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    // One failed-change line, for bravo, naming its entry and credentials path.
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toHaveLength(1)
    expect(changeFailedLines(run, bravo!, 1)).toHaveLength(1)
    // alpha's change was applied.
    expect(run.appliedConfigs.at(-1)!.personas.find((p) => p.key === alphaKey)!.channels.map((c) => c.id)).toEqual([
      ownChannel('alpha'),
      EXTRA_CHANNEL,
    ])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    // The credentials change is pending again.
    await expectCredentialsPending(run, bravo!)
    expect(run.slackPosts()).toEqual([])
  })

  test.each<{ label: string; later: WebApiOutcome; swaps: boolean }>([
    { label: 'answers', later: { kind: 'ok' }, swaps: true },
    { label: 'refuses the new token', later: { kind: 'platform', error: 'invalid_auth' }, swaps: false },
  ])("Slack unreachable for bravo's new file: the old connection stays while the new one retries on the SR-3.2 backoff and nothing is pending; when a later attempt $label, the swap completes or the change fails and is pending again, and alpha gets no lifecycle call and its Slack side is untouched", async ({ later, swaps }) => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [, bravo] = personas
    const bravoKey = h.key('bravo')
    const oldIdentity = identityOf(run.stub('bravo'))
    const oldDigest = run.bringUps.credentialsDigest(bravoKey)
    const { label } = h.rotateCredentials(bravo!, { slack: { authTest: [{ kind: 'network' }, later] } })
    const newStub = run.credentialsStub('bravo', label)
    const t0 = run.clock.now()
    const alphaUntouched = watchUntouched(run, 'alpha')

    await (await run.confirmPending()).applying

    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'kept' } },
    ])
    expect(run.currentStub('bravo')).toBe(run.stub('bravo'))
    expect(run.connections.manager.identity(bravoKey)).toEqual(oldIdentity)
    expect(run.clock.pending().map((t) => t.dueAt)).toEqual([t0 + 5_000])
    // The confirmed content is held while it retries, so the change is not left pending.
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(bravo!))

    await run.clock.advanceTo(t0 + 5_000)
    expect(newStub.calls.authTest).toHaveLength(2)

    if (swaps) {
      expect(run.currentStub('bravo')).toBe(newStub)
      expect(run.connections.manager.identity(bravoKey)).toEqual(identityOf(newStub))
      expect(run.stub('bravo').socket.disconnectCalls).toBe(1)
      expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([])
      await run.ticks.tick()
      expect(h.pendingExists()).toBe(false)
    } else {
      expect(run.currentStub('bravo')).toBe(run.stub('bravo'))
      expect(run.connections.manager.identity(bravoKey)).toEqual(oldIdentity)
      expect(run.stub('bravo').socket.disconnectCalls).toBe(0)
      expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
      expect(changeFailedLines(run, bravo!, 1)).toHaveLength(1)
      expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toHaveLength(1)
      expect(run.bringUps.credentialsDigest(bravoKey)).toBe(oldDigest)
      await expectCredentialsPending(run, bravo!)
    }
    expect(run.lifecycle.of('bring-up').filter((r) => r.via === 'apply')).toEqual([])
    alphaUntouched()
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; opts: RunningOptions; prepare: (personas: PersonaInput[]) => void; bringBack: (run: ReloadRun, bravo: PersonaInput) => Promise<unknown> }>([
    {
      label: 'Slack-unreachable',
      opts: { slack: { bravo: SLACK_UNREACHABLE } },
      prepare: () => undefined,
      bringBack: (run) => run.clock.runNext(),
    },
    {
      label: 'directory-broken',
      opts: {},
      prepare: ([, bravo]) => h.deleteWorkingDirectory(bravo!),
      bringBack: (run, bravo) => {
        h.makeWorkingDirectory(bravo)
        return run.clock.runNext()
      },
    },
  ])('bravo retrying ($label) whose credentials change is confirmed retries with the new content: once it comes up, every client it builds has the new tokens, and alpha gets no lifecycle call and its Slack side is untouched', async ({ opts, prepare, bringBack }) => {
    const { run, personas } = await running(['alpha', 'bravo'], opts, prepare)
    const [, bravo] = personas
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('retrying')
    const oldTokens = h.tokens('bravo')
    const oldAuthTests = run.stub('bravo').calls.authTest.length
    const buildsFrom = run.slack.buildsOf(bravoKey).length
    const alphaUntouched = watchUntouched(run, 'alpha')
    const { tokens, label } = h.rotateCredentials(bravo!)

    await (await run.confirmPending()).applying

    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'none' } },
    ])
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(bravo!))
    const cp = run.checkpoint()
    await bringBack(run, bravo!)

    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.since(cp).lifecycle).toEqual([{ op: 'launch', key: bravoKey, via: 'retry' }])
    expect(run.connections.manager.identity(bravoKey)).toEqual(identityOf(run.credentialsStub('bravo', label)))
    const builds = run.slack.buildsOf(bravoKey).slice(buildsFrom)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) {
      expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
      expect(build.hasToken(oldTokens.appToken) || build.hasToken(oldTokens.botToken)).toBe(false)
    }
    expect(run.stub('bravo').calls.authTest).toHaveLength(oldAuthTests)
    alphaUntouched()
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test('a later confirmed removal of bravo, whose reconnect is still retrying, cancels the reconnect: no further auth.test or start() for it on the fake clock, and alpha gets no lifecycle call from either apply and its Slack side is untouched', async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    const alphaUntouched = watchUntouched(run, 'alpha')
    const { label } = h.rotateCredentials(bravo!, { slack: { connect: Array.from({ length: 50 }, () => ({ kind: 'network' as const })) } })
    const newStub = run.credentialsStub('bravo', label)
    await (await run.confirmPending()).applying
    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'kept' } },
    ])
    await run.clock.runNext()
    expect(newStub.calls.authTest).toHaveLength(2)

    await applyConfig(run, [alpha!])
    expect(run.lifecycle.keys('teardown')).toEqual([bravoKey])
    // Its next attempt's timer went with it.
    expect(run.clock.pendingCount()).toBe(0)
    const authTests = newStub.calls.authTest.length
    const starts = newStub.sockets.map((s) => s.startCalls)
    const cp = run.checkpoint()
    await run.clock.advance(3_600_000)

    expect(newStub.calls.authTest).toHaveLength(authTests)
    expect(newStub.sockets.map((s) => s.startCalls)).toEqual(starts)
    expect(run.since(cp).slackBuilds).toBe(0)
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.clock.pendingCount()).toBe(0)
    alphaUntouched()
    expectNoPostNoLeak(run)
  })

  test("bravo's old connection's reopen is refused while its confirmed reconnect retries: it stops being up, its MCP session dropped and its instance kept; when the reconnect later succeeds it comes up with no second confirmation and is launched again, while alpha gets no lifecycle or dependency call, keeps its session and its Slack side is untouched (real composition)", async () => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_WITH_SESSIONS)
    const [, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const alphaSession = run.session('alpha')
    const alphaUntouched = watchUntouched(run, 'alpha')
    const { label } = h.rotateCredentials(bravo!, { slack: { authTest: [{ kind: 'network' }] } })
    await (await run.confirmPending()).applying
    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'kept' } },
    ])
    const ticksRun = run.ticks.ticksRun

    await run.refuseReopen('bravo')

    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    expect(run.isUp('bravo')).toBe(false)
    expect(run.session('bravo')).toBeUndefined()
    expect(run.admitSession('bravo').kind).toBe('not-up')
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    const cp = run.checkpoint()

    // The pending reconnect's next attempt succeeds.
    await run.clock.runNext()

    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.isUp('bravo')).toBe(true)
    expect(run.since(cp).lifecycle).toEqual([{ op: 'launch', key: bravoKey, via: 'retry' }])
    // No kill, delete or fresh start of its instance: the launch reaches it.
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.admitSession('bravo').kind).toBe('admitted')
    // No second confirmation: no tick ran, nothing is pending.
    expect(run.ticks.ticksRun).toBe(ticksRun)
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    // alpha: nothing.
    alphaUntouched()
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.session('alpha')).toBe(alphaSession!)
    expect(run.isUp('alpha')).toBe(true)
    expectNoPostNoLeak(run)
  })
})

describe('step 6 brings up a credentials-broken persona whose credentials changed (b.av2 SR-8.6 step 6, SR-6.4 recovery)', () => {
  interface RecoveryRow {
    label: string
    opts: RunningOptions
    prepare: (personas: PersonaInput[]) => void
    /** Break bravo after the start (before the change), if the row does. */
    breakRunning?: (run: ReloadRun) => Promise<void>
  }

  const RECOVERY_ROWS: RecoveryRow[] = [
    {
      label: 'broken at start by a missing credentials file, then created',
      opts: REAL_WITH_SESSIONS,
      prepare: ([, bravo]) => h.deleteCredentials(bravo!),
    },
    {
      label: 'broken at start by locally invalid content, then fixed',
      opts: REAL_WITH_SESSIONS,
      prepare: ([, bravo]) => void h.writeCredentialsContent(bravo!, { bot_token: undefined }),
    },
    {
      label: 'broken at start by Slack refusing its token',
      opts: { ...REAL_WITH_SESSIONS, slack: { bravo: SLACK_AUTH_REJECTED } },
      prepare: () => undefined,
    },
    {
      label: 'revoked while running (a refused reopen)',
      opts: REAL_WITH_SESSIONS,
      prepare: () => undefined,
      breakRunning: (run) => run.refuseReopen('bravo'),
    },
  ]

  // The agent-director stub holds no row for bravo, and the harness only
  // records a launch: these rows show the recovery makes no agent-director
  // call (no kill or delete) and asks for a launch, not what the launch does
  // with an existing row.
  test.each(RECOVERY_ROWS)('bravo $label: a confirmed good file brings it up at step 6 as a recovery (no reconnect), with the new tokens, no agent-director call and a launch recorded, its MCP registration accepted again, and alpha untouched (real composition)', async ({ opts, prepare, breakRunning }) => {
    const { run, personas } = await running(['alpha', 'bravo'], opts, prepare)
    const [, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    if (breakRunning !== undefined) await breakRunning(run)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    const alphaBefore = slackSideOf(run, 'alpha')
    const { tokens, label } = h.rotateCredentials(bravo!)
    const cp = run.checkpoint()

    await (await run.confirmPending()).applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: bravoKey, via: 'apply', recovery: true, result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    expect(run.lifecycle.timeline).toEqual([
      { op: 'bring-up', key: bravoKey, phase: 'start' },
      { op: 'bring-up', key: bravoKey, phase: 'settled' },
    ])
    // Its leftover state is cleared first, then the same bring-up and a recorded launch; no agent-director call (no kill or delete).
    expect(run.composition!.calls).toEqual([
      ['bringUps.cancel', bravoKey],
      ['connections.stop', bravoKey],
      ['destinations.forget', bravoKey],
      ['storageCheck', bravoKey],
      ['bringUps.bringUp', bravoKey],
      ['launch', bravoKey],
    ])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    // Up with the new file's tokens, on the new set's clients.
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    const builds = run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.isUp('bravo')).toBe(true)
    expect(run.admitSession('bravo').kind).toBe('admitted')
    // alpha: nothing.
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(slackSideOf(run, 'alpha')).toEqual(alphaBefore)
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("Director decision 4: bravo, up when the apply's plan was built (a reconnect), is revoked while step 2 runs; step 4 re-checks it at step time and leaves it, and step 6 brings it up as a recovery with the new tokens (real composition)", async () => {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie'], REAL_WITH_SESSIONS)
    const [alpha, bravo] = personas
    const [bravoKey, charlieKey] = keysOf('bravo', 'charlie')
    const { tokens, label } = h.rotateCredentials(bravo!)
    const teardown = run.lifecycle.hold('teardown', charlieKey)
    const cp = run.checkpoint()

    // Up when the applying check builds its plan, so the plan lists bravo for a reconnect.
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    const { applying } = await confirmConfig(run, [alpha!, bravo!])
    await teardown.entered
    await run.refuseReopen('bravo')
    teardown.release()
    await applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: charlieKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', recovery: true, result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    expect(run.lifecycle.keys('reconnect')).toEqual([])
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    for (const build of run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)) {
      expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    }
    expect(run.isUp('bravo')).toBe(true)
    expect(run.admitSession('bravo').kind).toBe('admitted')
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("Director decision 4, at the reconnect itself: bravo, up when step 4 chose it for a reconnect, is revoked by a Web API call while that reconnect waits to start; the reconnect finds it credentials-broken and leaves it, and step 6 brings it up as a recovery with the new tokens (real composition)", async () => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_WITH_SESSIONS)
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const { tokens, label } = h.rotateCredentials(personas[1]!)
    const reconnect = run.lifecycle.hold('reconnect', bravoKey)
    const alphaUntouched = watchUntouched(run, 'alpha')
    const cp = run.checkpoint()

    const { applying } = await run.confirmPending()
    // Step 4 chose bravo (up at its filter) and its reconnect is recorded, its body not yet run.
    await reconnect.entered
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    // Now bravo's bot token is revoked, and its next Web API call (a tool call) finds it so: credentials-broken.
    run.revokeBotToken('bravo')
    // The tool handler's failure line goes to console.error: captured for the leak check, not printed.
    const consoleLines: string[] = []
    const consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(' ')))
    let refused: { isError: boolean; text: string }
    try {
      refused = await run.callTool('bravo', 'react', { chat_id: ownChannel('bravo'), message_id: '1700000000.000100', emoji: 'eyes' })
    } finally {
      consoleSpy.mockRestore()
    }
    expect(refused.isError).toBe(true)
    expect(consoleLines).toHaveLength(1)
    expect(isCredentialsBroken(run.bringUps.state(bravoKey))).toBe(true)
    reconnect.release()
    await applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'credentials-broken' } },
      { op: 'bring-up', key: bravoKey, via: 'apply', recovery: true, result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    expect(run.lifecycle.timeline).toEqual([
      { op: 'reconnect', key: bravoKey, phase: 'start' },
      { op: 'reconnect', key: bravoKey, phase: 'settled' },
      { op: 'bring-up', key: bravoKey, phase: 'start' },
      { op: 'bring-up', key: bravoKey, phase: 'settled' },
    ])
    // The reconnect built nothing; the recovery cleared bravo's state and brought it up on the new set's clients.
    expect(run.composition!.calls).toEqual([
      ['bringUps.changeCredentials', bravoKey],
      ['bringUps.cancel', bravoKey],
      ['connections.stop', bravoKey],
      ['destinations.forget', bravoKey],
      ['storageCheck', bravoKey],
      ['bringUps.bringUp', bravoKey],
      ['launch', bravoKey],
    ])
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    const builds = run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.isUp('bravo')).toBe(true)
    expect(run.admitSession('bravo').kind).toBe('admitted')
    // alpha: nothing.
    alphaUntouched()
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run, { refused, console: consoleLines })
  })

  test('a credentials-broken persona whose file did not change gets no bring-up and no auth.test from an apply that changes something else (real composition)', async () => {
    const { run } = await running(['alpha', 'bravo'], { realLifecycle: true, slack: { bravo: SLACK_AUTH_REJECTED } })
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    const bravoBefore = slackSideOf(run, 'bravo')
    const cp = run.checkpoint()

    await applyConfig(run, [
      h.persona('alpha', { channels: [{ id: ownChannel('alpha'), delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }),
      h.persona('bravo'),
    ])

    expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: alphaKey, via: 'apply', settings: ['channels'] }])
    expect(run.composition!.calls.filter(([, key]) => key === bravoKey)).toEqual([])
    expect(slackSideOf(run, 'bravo')).toEqual(bravoBefore)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

describe('b.av2 SR-1.4 at apply: a credentials file whose real path is another applied persona\'s', () => {
  test('recovery after a record-start collision: alpha and bravo share a credentials file, so both are broken; a confirmed removal of alpha leaves bravo broken and untouched, and a byte change to the file, confirmed, brings bravo up at step 6 (real composition)', async () => {
    const [alpha, charlie] = [h.persona('alpha'), h.persona('charlie')]
    h.materialize(alpha, charlie)
    const bravo = h.persona('bravo', { credentials_file: alpha.credentials_file })
    h.makeWorkingDirectory(bravo)
    h.writeRecord(configOf(alpha, bravo, charlie))
    h.writeConfig(configOf(alpha, bravo, charlie))
    const run = await h.startDetecting({ realLifecycle: true })
    await run.ticks.tick()
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    for (const key of [alphaKey, bravoKey]) {
      expect(run.lifecycle.outcome(key)).toBe('broken')
      expect(run.lifecycle.classes(key)).toEqual([PERSONA_CREDENTIALS_INVALID])
    }

    // The removal of alpha: bravo stays broken and gets nothing.
    const removal = run.checkpoint()
    await applyConfig(run, [bravo, charlie])
    expect(run.since(removal).lifecycle).toEqual([{ op: 'teardown', key: alphaKey, via: 'apply' }])
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    expect(run.slack.buildsOf(bravoKey)).toEqual([])
    await expectNothingPendingAfter(run)

    // A re-save with a byte change, confirmed: bravo comes up at step 6.
    const { tokens } = h.rotateCredentials(bravo)
    const cp = run.checkpoint()
    await (await run.confirmPending()).applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: bravoKey, via: 'apply', recovery: true, result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    for (const build of run.slack.buildsOf(bravoKey)) {
      expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    }
    expect(run.lifecycle.of('bring-up').filter((r) => r.key === h.key('charlie') && r.via === 'apply')).toEqual([])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  /**
   * alpha up with its own file; bravo's credentials_file is a symlink
   * (`link`) to its own file (`target`), created by `prepare` or left
   * dangling. Detection started and its first check run.
   */
  async function linkedBravo(opts: RunningOptions, writeTarget: boolean) {
    const alpha = h.persona('alpha')
    h.materialize(alpha)
    const own = h.persona('bravo')
    const link = join(dirname(own.credentials_file), 'credentials-link.json')
    const bravo = h.persona('bravo', { credentials_file: link })
    h.makeWorkingDirectory(bravo)
    h.makeWorkingDirectory({ working_directory: dirname(link) })
    if (writeTarget) h.writeCredentials(own)
    symlinkSync(own.credentials_file, link)
    h.writeRecord(configOf(alpha, bravo))
    h.writeConfig(configOf(alpha, bravo))
    const run = await h.startDetecting(opts)
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(false)
    /** Point the symlink at alpha's credentials file. */
    const retarget = () => {
      rmSync(link)
      symlinkSync(alpha.credentials_file, link)
    }
    return { run, alpha, bravo, own, retarget }
  }

  test("a collision created after validation (the symlink retargeted at step 1): the step-6 recovery bring-up of credentials-broken bravo ends credentials-broken with persona-credentials-invalid naming alpha (real composition)", async () => {
    const { run, bravo, own, retarget } = await linkedBravo({ realLifecycle: true }, false)
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('broken')
    h.writeCredentials(own)
    run.beforeApplySteps(retarget)
    const cp = run.checkpoint()

    await (await run.confirmPending()).applying

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'bring-up', key: bravoKey, via: 'apply', recovery: true, result: expect.objectContaining({ outcome: 'broken' }) },
    ])
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('broken')
    const invalid = run.since(cp).logs.filter((l) => l.startsWith(`[slack] ${PERSONA_CREDENTIALS_INVALID}: `))
    expect(invalid).toHaveLength(1)
    expect(invalid[0]).toContain(renderPersonaRef('bravo', bravoKey))
    expect(invalid[0]).toContain(`of ${renderPersonaRef('alpha', alphaKey)}`)
    expect(invalid[0]).toContain(JSON.stringify(bravo.credentials_file))
    expect(run.slack.buildsOf(bravoKey)).toEqual([])
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.bringUps.state(alphaKey)?.outcome).toBe('up')
    expectNoPostNoLeak(run)
  })

  test("a collision created after validation (the symlink retargeted at step 1): up bravo's confirmed credentials change logs persona-credentials-change-failed naming alpha, keeps its old connection and stays pending", async () => {
    const { run, bravo, own, retarget } = await linkedBravo({}, true)
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('up')
    const oldIdentity = identityOf(run.stub('bravo'))
    h.rotateCredentials(own)
    run.beforeApplySteps(retarget)

    await (await run.confirmPending()).applying

    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'failed', cause: expect.stringContaining(`of ${renderPersonaRef('alpha', alphaKey)}`) } },
    ])
    const failed = changeFailedLines(run, bravo, 1)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain(`of ${renderPersonaRef('alpha', alphaKey)}`)
    expect(run.stub('bravo').socket.disconnectCalls).toBe(0)
    expect(run.currentStub('bravo')).toBe(run.stub('bravo'))
    expect(run.connections.manager.identity(bravoKey)).toEqual(oldIdentity)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    await expectCredentialsPending(run, bravo)
    expectNoPostNoLeak(run)
  })

  test("the reconnect's re-check uses the applied set after step 1's swap: alpha removed in the same apply frees its credentials file, and up bravo's symlink retargeted to it at step 1 is no collision, so the reconnect swaps to the tokens read there (real composition)", async () => {
    const { run, alpha, bravo, own, retarget } = await linkedBravo({ realLifecycle: true }, true)
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe('up')
    const oldLabel = h.credentialsLabel('bravo')
    const { tokens, label } = h.rotateCredentials(own)
    h.writeConfig(configOf(bravo))
    // At step 1, after the swap (alpha no longer applied): alpha's file gets bravo's new bytes and bravo's symlink points at it.
    run.beforeApplySteps(() => {
      h.writeCredentialsContent(alpha, h.readCredentialsBytes(own)!.toString('utf-8'))
      retarget()
    })
    const activityFrom = run.socketActivity('bravo').length
    const cp = run.checkpoint()

    await (await run.confirmPending()).applying

    expect(run.appliedKeys()).toEqual([bravoKey])
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: alphaKey, via: 'apply' },
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'swapped' } },
    ])
    // No collision was found: no change-failed or invalid line.
    expect(run.logsOf(PERSONA_CREDENTIALS_CHANGE_FAILED)).toEqual([])
    expect(run.logsOf(PERSONA_CREDENTIALS_INVALID)).toEqual([])
    // The new connection, on the tokens read through the retargeted symlink, opened before the old one closed.
    expect(socketActivitySince(run, 'bravo', activityFrom)).toEqual([
      `built ${label}`,
      `started ${label}`,
      `connected ${label}`,
      `discarded ${oldLabel}`,
      `disconnected ${oldLabel}`,
    ])
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    const builds = run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.connections.manager.identity(bravoKey)).toEqual(identityOf(run.credentialsStub('bravo', label)))
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    // What it holds is what its path now reads, so nothing is left pending.
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(bravo))
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test('control: a credentials file freed by a persona removed in the same apply is used by a persona added in it, because the check runs against the new applied set (real composition)', async () => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true })
    const [alpha, bravo] = personas
    const [bravoKey, charlieKey] = keysOf('bravo', 'charlie')
    const charlie = h.persona('charlie', { credentials_file: bravo!.credentials_file })
    h.makeWorkingDirectory(charlie)
    const { tokens } = h.rotateCredentials(charlie)
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, charlie])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: charlieKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: charlieKey, via: 'apply' },
    ])
    for (const build of run.slack.buildsOf(charlieKey)) {
      expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    }
    expect(run.logsOf(PERSONA_CREDENTIALS_INVALID)).toEqual([])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})

// ---------------------------------------------------------------------------
// Destructive modifies, next-launch and server-wide settings, and step 5
// (AC 59, 60, 61; b.av2 SR-8.6 table rows and step 5)
// ---------------------------------------------------------------------------

/**
 * Replace `h` with a harness whose every persona gets its own temp
 * `claude_config_dir` (`personaConfigDirs`), so a spawn's config directory
 * and the template's memory-read rules name known temp paths.
 */
async function useConfigDirs(): Promise<void> {
  await h.cleanup()
  h = makeReloadHarness({ personaConfigDirs: true })
}

/** The real launch path (`spawnForPersona` over the row table; implies the real composition). */
const REAL_LAUNCH: RunningOptions = { realLaunch: true }

/** The temp `claude_config_dir` `personaConfigDirs` gives the persona named `name`. */
function ownConfigDir(name: string): string {
  return h.configDir(h.key(name))
}

/** A symlink named `name` among the temp config directories, pointing at `target`; returns its path. */
function configDirLink(name: string, target: string): string {
  const path = join(dirname(ownConfigDir('alpha')), name)
  symlinkSync(target, path)
  return path
}

/** The memory-read rules the template holds for `dirs`: one per distinct directory, sorted, scoped to project memory (b.av2 SR-11). */
function memoryRules(...dirs: string[]): string[] {
  return [...new Set(dirs)].sort().map((dir) => `Read(/${dir}/projects/*/memory/**)`)
}

/** The agent-director calls made from `from` (an `agentDirectorCalls` length taken earlier) on. */
function adCallsSince(run: ReloadRun, from: number): AgentDirectorCall[] {
  return run.composition!.agentDirectorCalls.slice(from)
}

/** The persona's instance calls (spawn, resume, kill, delete) from `from` on, as `<verb> <result>`. */
function instanceCallsSince(run: ReloadRun, name: string, from: number): string[] {
  return run.composition!.instanceCallsOf(name).slice(from).map((c) => `${c.verb} ${c.result}`)
}

/** The persona's last spawn call. */
function lastSpawnOf(run: ReloadRun, name: string): AgentDirectorCall | undefined {
  return run.composition!.instanceCallsOf(name).filter((c) => c.verb === 'spawn').at(-1)
}

/** Every `makeTemplate` call the stub received (step 5's refreshes; nothing is installed at the start). */
function templateCalls(run: ReloadRun) {
  return run.composition!.agentDirector.makeTemplateCalls
}

/** The step-5 record of a refresh that settled as `refresh` (the stand-in's has none). */
function refreshRecord(refresh?: 'refreshed' | 'failed'): ReloadLifecycleRecord {
  const settled = refresh === 'refreshed' ? { kind: 'refreshed' as const, path: expect.any(String) } : { kind: 'failed' as const }
  return { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, via: 'apply', ...(refresh === undefined ? {} : { refresh: settled }) }
}

/** A `applyTimeline` entry of step 5. */
function refreshEntry(phase: ApplyTimelineEntry['phase']): ApplyTimelineEntry {
  return { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, phase }
}

/** The apply step each `applyTimeline` op belongs to. */
const APPLY_STEP_OF: Record<ApplyTimelineEntry['op'], number> = {
  teardown: 2,
  'update-in-place': 3,
  reconnect: 4,
  'template-refresh': 5,
  'bring-up': 6,
}

/** Yield event-loop turns (no timer), so a step that should wait would have started. */
async function turns(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))
}

/** bravo's working directory moved to a new directory beside its old one, created unless `create` is false. */
function movedDirectory(bravo: PersonaInput, create = true): PersonaInput {
  const moved = h.persona(bravo.name, { working_directory: join(dirname(bravo.working_directory), 'moved') })
  if (create) h.makeWorkingDirectory(moved)
  return moved
}

/** bravo's `credentials_file` moved to a new path, written there with a new token set unless `write` is false. */
function movedCredentials(bravo: PersonaInput, write = true): PersonaInput {
  const moved = h.persona(bravo.name, { credentials_file: join(dirname(bravo.credentials_file), 'credentials-moved.json') })
  if (write) h.rotateCredentials(moved)
  return moved
}

describe('AC 60: a destructive modify tears the persona down at step 2 and brings it up fresh at step 6 (b.av2 SR-8.6, the credentials_file path and working_directory rows)', () => {
  beforeEach(useConfigDirs)

  test.each<{ setting: 'working_directory' | 'credentials_file'; move: (bravo: PersonaInput) => PersonaInput }>([
    { setting: 'working_directory', move: (bravo) => movedDirectory(bravo) },
    { setting: 'credentials_file', move: (bravo) => movedCredentials(bravo) },
  ])("AC 60: bravo's $setting moved, beside alpha, is previewed DESTRUCTIVE:, then exactly one teardown and one bring-up for bravo: its old row killed and deleted and a fresh spawn (never a resume) from the new declaration, its old connection closed before the new one opened, and no call of any kind for alpha (real launch)", async ({ setting, move }) => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_LAUNCH)
    const [alpha, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const bravoId = personaInstanceId(bravoKey)
    expect(h.rowOf('bravo')?.state).toBe('waiting')
    const oldLabel = h.credentialsLabel('bravo')
    const moved = move(bravo!)
    const newLabel = h.credentialsLabel('bravo')
    expect(newLabel === oldLabel).toBe(setting === 'working_directory')
    const tokens = h.tokens('bravo')
    const alphaUntouched = watchUntouched(run, 'alpha')
    const alphaInstanceCalls = run.composition!.instanceCallsOf('alpha').length
    const bravoInstanceCalls = run.composition!.instanceCallsOf('bravo').length
    const adFrom = run.composition!.agentDirectorCalls.length
    const activityFrom = run.socketActivity('bravo').length
    const buildsFrom = run.slack.buildsOf(bravoKey).length
    const cp = run.checkpoint()

    // Before confirmation: one DESTRUCTIVE: line, for bravo's setting; nothing applied.
    await previewConfig(run, [alpha!, moved])
    expect(h.pendingDestructiveLines()).toHaveLength(1)
    expect(h.pendingDestructiveLines()![0]).toStartWith(`DESTRUCTIVE: persona ${renderPersonaRef('bravo', bravoKey)} ${setting} changed`)
    h.confirm()
    await run.ticks.tick()

    // One teardown at step 2, then one bring-up at step 6, launched as a fresh spawn; nothing else.
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply', action: 'spawned' },
    ])
    expect(run.lifecycle.applyTimeline).toEqual([
      { op: 'teardown', key: bravoKey, phase: 'start' },
      { op: 'teardown', key: bravoKey, phase: 'settled' },
      { op: 'bring-up', key: bravoKey, phase: 'start' },
      { op: 'bring-up', key: bravoKey, phase: 'settled' },
    ])
    // Its old row killed and deleted, then spawned fresh from the new declaration: never resumed.
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(['kill ok', 'delete ok', 'spawn ok'])
    expect(lastSpawnOf(run, 'bravo')).toMatchObject({ id: bravoId, cwd: moved.working_directory, claudeConfigDir: ownConfigDir('bravo') })
    expect(h.rowOf('bravo')).toMatchObject({ state: 'waiting', cwd: moved.working_directory })
    // The old connection closed before the new one opened, and the new one has the new declaration's tokens.
    expect(run.socketActivity('bravo').slice(activityFrom)).toEqual([
      `discarded ${oldLabel}`,
      `disconnected ${oldLabel}`,
      `built ${newLabel}`,
      `started ${newLabel}`,
      `connected ${newLabel}`,
    ])
    const builds = run.slack.buildsOf(bravoKey).slice(buildsFrom)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(moved))
    // alpha: no lifecycle record, dependency call, agent-director call or Slack activity; no template refresh either.
    alphaUntouched()
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.composition!.instanceCallsOf('alpha')).toHaveLength(alphaInstanceCalls)
    expect(adCallsSince(run, adFrom).filter((c) => c.id !== bravoId)).toEqual([])
    expect(run.logsOf('reload')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; move: (bravo: PersonaInput) => PersonaInput; outcome: PersonaBringUpOutcome; cls: string; timers: number }>([
    { label: 'a new working directory that is missing', move: (bravo) => movedDirectory(bravo, false), outcome: 'retrying', cls: PERSONA_DIRECTORY_MISSING, timers: 1 },
    { label: 'a new credentials path that is missing', move: (bravo) => movedCredentials(bravo, false), outcome: 'broken', cls: PERSONA_CREDENTIALS_MISSING, timers: 0 },
  ])('AC 60: bravo moved to $label is still torn down (its instance killed and deleted), and its fresh bring-up ends $outcome under the startup rules, launching nothing, while alpha is untouched and nothing is pending (real composition)', async ({ move, outcome, cls, timers }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true })
    const [alpha, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const moved = move(bravo!)
    const alphaUntouched = watchUntouched(run, 'alpha')
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, moved])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome }) },
    ])
    expect(run.lifecycle.classes(bravoKey)).toEqual([cls])
    expect(run.composition!.agentDirectorOrder).toEqual([`kill ${personaInstanceId(bravoKey)}`, `delete ${personaInstanceId(bravoKey)}`])
    expect(run.clock.pendingCount()).toBe(timers)
    alphaUntouched()
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("AC 60: bravo's working directory moved and its token rotated in the same credentials file, confirmed together, records only a teardown and a bring-up (no reconnect), and the bring-up connects with the new tokens (real composition)", async () => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true })
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    const { tokens, label } = h.rotateCredentials(bravo!)
    const moved = movedDirectory(bravo!)
    const alphaUntouched = watchUntouched(run, 'alpha')
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, moved])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    expect(run.composition!.calls.filter(([member]) => member.includes('Credentials'))).toEqual([])
    expect(run.currentStub('bravo')).toBe(run.credentialsStub('bravo', label))
    const builds = run.slack.buildsOf(bravoKey).filter((b) => b.credentials === label)
    expect(builds.map((b) => b.kind).sort()).toEqual(['socket', 'validation', 'web'])
    for (const build of builds) expect(build.hasToken(build.kind === 'socket' ? tokens.appToken : tokens.botToken)).toBe(true)
    expect(run.bringUps.credentialsDigest(bravoKey)).toBe(h.credentialsDigestOf(moved))
    alphaUntouched()
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; breakBravo: (bravo: PersonaInput) => void; outcome: PersonaBringUpOutcome; timers: number; fix: (bravo: PersonaInput) => void }>([
    {
      label: 'credentials-broken (its file missing) with its instance row kept',
      breakBravo: (bravo) => h.deleteCredentials(bravo),
      outcome: 'broken',
      timers: 0,
      fix: (bravo) => void h.writeCredentials(bravo),
    },
    {
      label: 'retrying on its missing working directory, with its instance row kept',
      breakBravo: (bravo) => h.deleteWorkingDirectory(bravo),
      outcome: 'retrying',
      timers: 1,
      fix: () => undefined,
    },
  ])("AC 60: bravo $label, whose working directory is moved, is still torn down (its kept row killed and deleted, any retry timer cancelled) and brought up fresh in the new directory; its old declaration never comes back (real launch)", async ({ breakBravo, outcome, timers, fix }) => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_LAUNCH, ([, bravo]) => {
      breakBravo(bravo!)
      h.seedRow(bravo!, { state: 'ended' })
    })
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe(outcome)
    expect(run.clock.pendingCount()).toBe(timers)
    expect(h.rowOf('bravo')?.state).toBe('ended')
    fix(bravo!)
    const moved = movedDirectory(bravo!)
    const bravoInstanceCalls = run.composition!.instanceCallsOf('bravo').length
    const alphaUntouched = watchUntouched(run, 'alpha')
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, moved])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply', action: 'spawned' },
    ])
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(['kill ok', 'delete ok', 'spawn ok'])
    expect(lastSpawnOf(run, 'bravo')).toMatchObject({ cwd: moved.working_directory })
    expect(run.clock.pendingCount()).toBe(0)
    // With its old directory back, far past every retry, nothing runs for its old declaration.
    h.makeWorkingDirectory(bravo!)
    const after = run.checkpoint()
    const spawns = run.composition!.instanceCallsOf('bravo').length
    await run.clock.advance(3_600_000)
    expect(run.since(after).lifecycle).toEqual([])
    expect(run.since(after).slackBuilds).toBe(0)
    expect(run.composition!.instanceCallsOf('bravo')).toHaveLength(spawns)
    alphaUntouched()
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("AC 60: bravo's credentials reconnect from an earlier apply, still retrying, is cancelled by a later working-directory change's teardown: after its fresh bring-up, no further auth.test or start() for it on the fake clock", async () => {
    const { run, personas } = await running(['alpha', 'bravo'])
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    const { label } = h.rotateCredentials(bravo!, { slack: { authTest: [{ kind: 'network' }] } })
    const newStub = run.credentialsStub('bravo', label)
    await (await run.confirmPending()).applying
    expect(run.lifecycle.of('reconnect')).toEqual([
      { op: 'reconnect', key: bravoKey, via: 'apply', change: { kind: 'retrying', connection: 'kept' } },
    ])
    expect(run.clock.pendingCount()).toBe(1)
    const alphaUntouched = watchUntouched(run, 'alpha')
    const cp = run.checkpoint()

    await applyConfig(run, [alpha!, movedDirectory(bravo!)])

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    // The bring-up read the file as it stands: the rotated set, its one further auth.test.
    expect(newStub.calls.authTest).toHaveLength(2)
    expect(run.currentStub('bravo')).toBe(newStub)
    expect(run.clock.pendingCount()).toBe(0)
    const authTests = newStub.calls.authTest.length
    const starts = newStub.sockets.map((s) => s.startCalls)
    const after = run.checkpoint()
    await run.clock.advance(3_600_000)
    expect(newStub.calls.authTest).toHaveLength(authTests)
    expect(newStub.sockets.map((s) => s.startCalls)).toEqual(starts)
    expect(run.since(after).slackBuilds).toBe(0)
    expect(run.since(after).lifecycle).toEqual([])
    alphaUntouched()
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; prepare: (personas: PersonaInput[]) => void; outcome: PersonaBringUpOutcome; trigger: (run: ReloadRun, bravo: PersonaInput) => Promise<unknown> }>([
    {
      label: 'a restart of its instance through the restart path',
      prepare: () => undefined,
      outcome: 'up',
      trigger: async (run) => expect(await run.relaunch('bravo')).toBe('skipped'),
    },
    {
      label: 'its bring-up retry, with its old directory back and the clock far past every retry',
      prepare: ([, bravo]) => h.deleteWorkingDirectory(bravo!),
      outcome: 'retrying',
      trigger: async (run, bravo) => {
        h.makeWorkingDirectory(bravo)
        await run.clock.advance(3_600_000)
      },
    },
  ])("AC 60: between the halves (bravo's step-2 teardown settled, its step-6 bring-up held), $label launches, reconnects and registers nothing; once released, exactly one spawn for its instance (real launch)", async ({ prepare, outcome, trigger }) => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_LAUNCH, prepare)
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    expect(run.lifecycle.outcome(bravoKey)).toBe(outcome)
    const moved = movedDirectory(bravo!)
    const bravoInstanceCalls = run.composition!.instanceCallsOf('bravo').length
    const gate = run.lifecycle.hold('bring-up', bravoKey)

    const { applying } = await confirmConfig(run, [alpha!, moved])
    await gate.entered
    expect(run.lifecycle.timeline).toEqual([
      { op: 'teardown', key: bravoKey, phase: 'start' },
      { op: 'teardown', key: bravoKey, phase: 'settled' },
      { op: 'bring-up', key: bravoKey, phase: 'start' },
    ])
    const between = run.checkpoint()
    await trigger(run, bravo!)
    await turns()

    // Nothing started it: no launch or bring-up, no client, no connection, and its instance would not be admitted.
    expect(run.since(between).lifecycle.filter((r) => r.via !== 'restart')).toEqual([])
    expect(run.since(between).slackBuilds).toBe(0)
    expect(run.connections.manager.status(bravoKey)).toBeUndefined()
    expect(run.isUp('bravo')).toBe(false)
    expect(run.admitSession('bravo').kind).toBe('not-up')
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(['kill ok', 'delete ok'])

    gate.release()
    await applying

    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(['kill ok', 'delete ok', 'spawn ok'])
    expect(lastSpawnOf(run, 'bravo')).toMatchObject({ cwd: moved.working_directory })
    expect(run.isUp('bravo')).toBe(true)
    expect(run.admitSession('bravo').kind).toBe('admitted')
    expectNoPostNoLeak(run)
  })

  test.each<{ setting: 'working_directory' | 'credentials_file'; move: (bravo: PersonaInput) => PersonaInput }>([
    { setting: 'working_directory', move: (bravo) => movedDirectory(bravo) },
    // Dry run reads no credentials file, so the new path need not exist.
    { setting: 'credentials_file', move: (bravo) => movedCredentials(bravo, false) },
  ])("AC 60 in dry run: bravo's $setting moved in the configuration file is still a destructive modify: previewed DESTRUCTIVE:, then one teardown that skips the agent-director kill and delete and one bring-up under the dry-run rules (no credentials read, no Slack client, a launch recorded), and alpha is untouched (real composition, dry run)", async ({ setting, move }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true, dryRun: true })
    const [alpha, bravo] = personas
    const [alphaKey, bravoKey] = keysOf('alpha', 'bravo')
    const moved = move(bravo!)
    const cp = run.checkpoint()

    await previewConfig(run, [alpha!, moved])
    expect(h.pendingDestructiveLines()).toHaveLength(1)
    expect(h.pendingDestructiveLines()![0]).toStartWith(`DESTRUCTIVE: persona ${renderPersonaRef('bravo', bravoKey)} ${setting} changed`)
    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: bravoKey, via: 'apply' },
      { op: 'bring-up', key: bravoKey, via: 'apply', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: bravoKey, via: 'apply' },
    ])
    // The teardown skipped the agent-director calls, saying so once.
    expect(stubCallCount(run.composition!.agentDirector)).toBe(0)
    expect(run.composition!.agentDirectorOrder).toEqual([])
    expect(run.logs.filter((l) => l.startsWith(`[slack] dry-run: persona teardown of ${renderPersonaRef('bravo', bravoKey)}: `))).toHaveLength(1)
    // The bring-up under the dry-run rules: no credentials file read, no Slack client or call.
    expect(run.tickCredentialsReads).toEqual([])
    expect(run.bringUps.credentialsDigest(bravoKey)).toBeUndefined()
    expect(run.slack.builds).toEqual([])
    expect(Object.values(run.slackCalls()).flat()).toEqual([])
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.appliedConfigs.at(-1)!.personas.find((p) => p.key === bravoKey)![setting]).toBe(moved[setting])
    // alpha: no lifecycle record, dependency call or state change (no Slack client exists in dry run).
    expect(run.since(cp).lifecycle.filter((r) => r.key === alphaKey)).toEqual([])
    expect(run.composition!.calls.filter(([, key]) => key === alphaKey)).toEqual([])
    expect(run.bringUps.state(alphaKey)?.outcome).toBe('up')
    const applied = run.logsOf(RELOAD_APPLIED)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('1 destructively modified')
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ setting: 'working_directory' | 'credentials_file' }>([{ setting: 'working_directory' }, { setting: 'credentials_file' }])(
    "AC 60 control:bravo's $setting written as a symlink to the same real path is no change: previewed with no effective change, and confirmed it records no teardown and no bring-up and logs reload-noop",
    async ({ setting }) => {
      const { run, personas } = await running(['alpha', 'bravo'])
      const [alpha, bravo] = personas
      const link = join(dirname(bravo![setting]), `link-${setting}`)
      symlinkSync(bravo![setting], link)
      const cp = run.checkpoint()

      await previewConfig(run, [alpha!, h.persona('bravo', { [setting]: link })])
      expect(h.pendingHeader()).toContain('no effective change')
      expect(h.pendingDestructiveLines()).toEqual([])
      h.confirm()
      await run.ticks.tick()

      expect(run.since(cp).lifecycle).toEqual([])
      expect(run.since(cp).slackCalls).toEqual([])
      expect(run.since(cp).slackBuilds).toBe(0)
      expect(run.logsOf(RELOAD_NOOP)).toHaveLength(1)
      expect(run.logsOf(RELOAD_APPLIED)).toEqual([])
      await expectNothingPendingAfter(run)
      expectNoPostNoLeak(run)
    },
  )
})

describe('AC 59: a claude_config_dir or stop_hook_bootstrap change costs no session and takes effect at the next launch (b.av2 SR-8.6, SR-6.2, SR-9.4)', () => {
  beforeEach(useConfigDirs)

  test.each<{
    setting: 'claude_config_dir' | 'stop_hook_bootstrap'
    what: string
    change: () => Partial<PersonaInput>
    refresh: boolean
    nextLaunch: string[]
    record: string
    /** The `config_dir` label the next launch must carry; default the strict label of the new directory. */
    label?: () => string
    /** Asserted before the next launch: the new directory is still not created. */
    uncreated?: boolean
  }>([
    {
      setting: 'claude_config_dir',
      what: 'claude_config_dir, moved to an existing directory,',
      change: () => ({ claude_config_dir: h.configDir('bravo-moved') }),
      refresh: true,
      // From an `ended` row labelled with the old directory: deleted, then spawned fresh with the new one.
      nextLaunch: ['spawn ErrInstanceIdCollision', 'delete ok', 'spawn ok'],
      record: 'true',
    },
    {
      setting: 'claude_config_dir',
      what: 'claude_config_dir, moved to a directory not created yet under a symlinked parent,',
      change: () => ({ claude_config_dir: join(configDirLink('bravo-parent-link', h.configDir('bravo-parent')), 'fresh', 'nested') }),
      refresh: true,
      nextLaunch: ['spawn ErrInstanceIdCollision', 'delete ok', 'spawn ok'],
      record: 'true',
      // The nearest existing ancestor's real path (the link's target) plus the rest, never the path as written.
      label: () => configDirLabelValue(join(h.configDir('bravo-parent'), 'fresh', 'nested'), h.home),
      uncreated: true,
    },
    {
      setting: 'stop_hook_bootstrap',
      what: 'stop_hook_bootstrap',
      change: () => ({ stop_hook_bootstrap: false }),
      refresh: false,
      // The row's label still matches: resumed.
      nextLaunch: ['spawn ErrInstanceIdCollision', 'resume ok'],
      record: 'false',
    },
  ])("AC 59: bravo's own $what changed records no teardown, bring-up or reconnect and no agent-director instance call, keeps its connection, MCP session, row and reply-guard record; its next launch uses the new value, and running alpha is unaffected (real launch)", async ({ setting, change, refresh, nextLaunch, record, label: expectedLabel, uncreated }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { ...REAL_LAUNCH, sessions: true })
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    const edited = h.persona('bravo', change())
    const records = () => ({ alpha: h.readReplyGuardRecord('alpha'), bravo: h.readReplyGuardRecord('bravo') })
    const recordsBefore = records()
    expect(recordsBefore).toEqual({ alpha: 'true', bravo: 'true' })
    const rows = () => ({ alpha: h.rowOf('alpha'), bravo: h.rowOf('bravo') })
    const rowsBefore = rows()
    const sessions = { alpha: run.session('alpha'), bravo: run.session('bravo') }
    const sides = { alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }
    const compositionFrom = run.composition!.calls.length
    const adFrom = run.composition!.agentDirectorCalls.length
    const alphaInstanceCalls = run.composition!.instanceCallsOf('alpha').length
    const cp = run.checkpoint()

    // Before confirmation: bravo's line says the change waits for its next launch; nothing destructive.
    const lines = await previewConfig(run, [alpha!, edited])
    const nextLaunchLine = `persona ${renderPersonaRef('bravo', bravoKey)}: ${setting} changed: takes effect at its next launch`
    expect(lines.filter((l) => l.startsWith(nextLaunchLine))).toHaveLength(1)
    expect(h.pendingDestructiveLines()).toEqual([])
    h.confirm()
    await run.ticks.tick()

    // No lifecycle record for either persona; only step 5's one refresh when the directory set changed.
    expect(run.since(cp).lifecycle).toEqual(refresh ? [refreshRecord('refreshed')] : [])
    expect(run.composition!.calls.slice(compositionFrom)).toEqual([])
    expect(adCallsSince(run, adFrom).map((c) => `${c.verb} ${c.result}`)).toEqual(refresh ? ['makeTemplate ok'] : [])
    // Kept: the connection (no socket closed, client built or Slack call), the MCP session, the row and both records.
    expect({ alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }).toEqual(sides)
    expect(run.session('bravo')).toBe(sessions.bravo!)
    expect(run.session('alpha')).toBe(sessions.alpha!)
    expect(rows()).toEqual(rowsBefore)
    expect(records()).toEqual(recordsBefore)
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)

    // Its next launch, through the restart path from an ended row: the new value.
    if (uncreated) expect(existsSync(edited.claude_config_dir!)).toBe(false)
    h.seedRow(bravo!, { state: 'ended' })
    const bravoInstanceCalls = run.composition!.instanceCallsOf('bravo').length
    const next = run.checkpoint()
    expect(await run.relaunch('bravo')).toBe(true)
    expect(run.since(next).lifecycle).toEqual([{ op: 'launch', key: bravoKey, via: 'restart', restart: true }])
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(nextLaunch)
    const label = expectedLabel?.() ?? personaConfigDirLabelValue(edited.claude_config_dir, h.home)
    expect(lastSpawnOf(run, 'bravo')).toMatchObject({ claudeConfigDir: edited.claude_config_dir, configDirLabel: label })
    expect(h.rowOf('bravo')).toMatchObject({ state: 'waiting', labels: expect.objectContaining({ config_dir: label }) })
    expect(h.readReplyGuardRecord('bravo')).toBe(record)
    // Never held as unresolvable, at the apply or the launch.
    expect(run.logsOf(PERSONA_CONFIG_DIR_UNRESOLVABLE)).toEqual([])
    expect(run.isUp('bravo')).toBe(true)
    // No lost-history or transcript-loss warning for it: no notice, no post.
    expect(run.sessionNotices).toEqual([])
    // alpha, running beside it: no instance call, its row and its record unchanged.
    expect(run.composition!.instanceCallsOf('alpha')).toHaveLength(alphaInstanceCalls)
    expect(h.rowOf('alpha')).toEqual(rowsBefore.alpha)
    expect(h.readReplyGuardRecord('alpha')).toBe(recordsBefore.alpha)
    expect(run.session('alpha')).toBe(sessions.alpha!)
    expectNoPostNoLeak(run)
  })

  test("b.g57: bravo, held because its claude_config_dir stopped resolving (a symlink whose target was removed), is launched once a confirmed change moves it to a directory that resolves: its 5 s re-check reads the applied declaration, not the one it was held with, and spawns it fresh in the new directory; alpha is untouched (real launch)", async () => {
    const target = h.configDir('bravo-target')
    const link = configDirLink('bravo-link', target)
    const { run, personas } = await running(['alpha', ['bravo', { claude_config_dir: link }]], REAL_LAUNCH)
    const [alpha, bravo] = personas
    const bravoKey = h.key('bravo')
    const alphaUntouched = watchUntouched(run, 'alpha')
    const alphaInstanceCalls = run.composition!.instanceCallsOf('alpha').length
    expect(run.isUp('bravo')).toBe(true)

    // The link's target goes: the next launch finds the directory unresolvable and holds bravo.
    rmSync(target, { recursive: true })
    h.seedRow(bravo!, { state: 'ended' })
    const bravoInstanceCalls = run.composition!.instanceCallsOf('bravo').length
    expect(await run.relaunch('bravo')).toBe('skipped')
    expect(run.bringUps.state(bravoKey)).toMatchObject({ outcome: 'retrying', causes: { configDir: expect.anything() } })
    expect(run.isUp('bravo')).toBe(false)
    expect(run.logsOf(PERSONA_CONFIG_DIR_UNRESOLVABLE)).toHaveLength(1)
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual([])
    expect(run.clock.pendingCount()).toBe(1)

    // A confirmed move to a directory that resolves: a next-launch change, so nothing is done to bravo at the apply.
    const fresh = h.configDir('bravo-fresh')
    const cp = run.checkpoint()
    await applyConfig(run, [alpha!, h.persona('bravo', { claude_config_dir: fresh })])
    expect(run.since(cp).lifecycle).toEqual([refreshRecord('refreshed')])
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual([])
    expect(run.isUp('bravo')).toBe(false)

    // Its re-check, 5 s after the hold: the new directory resolves, so one cleared line and one fresh spawn there.
    await run.clock.advance(4_999)
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual([])
    const recheck = run.checkpoint()
    await run.clock.advance(1)
    expect(run.since(recheck).lifecycle).toEqual([{ op: 'launch', key: bravoKey, via: 'retry', action: 'spawned' }])
    expect(instanceCallsSince(run, 'bravo', bravoInstanceCalls)).toEqual(['spawn ErrInstanceIdCollision', 'delete ok', 'spawn ok'])
    const label = personaConfigDirLabelValue(fresh, h.home)
    expect(lastSpawnOf(run, 'bravo')).toMatchObject({ claudeConfigDir: fresh, configDirLabel: label })
    expect(h.rowOf('bravo')).toMatchObject({ state: 'waiting', labels: expect.objectContaining({ config_dir: label }) })
    const lines = run.logsOf(PERSONA_CONFIG_DIR_UNRESOLVABLE)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('cleared')
    expect(run.bringUps.state(bravoKey)?.outcome).toBe('up')
    expect(run.isUp('bravo')).toBe(true)
    expect(run.clock.pendingCount()).toBe(0)
    alphaUntouched()
    expect(run.composition!.instanceCallsOf('alpha')).toHaveLength(alphaInstanceCalls)
    expectNoPostNoLeak(run)
  })
})

describe('AC 61: a changed inherited default leaves every instance undisturbed and reaches each inheriting persona at its next launch (b.av2 SR-8.6)', () => {
  beforeEach(useConfigDirs)

  test.each<{
    setting: 'claude_config_dir' | 'stop_hook_bootstrap'
    before: () => TopLevel
    after: () => TopLevel
    /** alpha's and bravo's overrides: they inherit the default. */
    inherit: Partial<PersonaInput>
    /** charlie's overrides: its own value. */
    own: Partial<PersonaInput>
    refresh: boolean
    /** Each inheriting persona's next launch, and charlie's. */
    inheritorLaunch: string[]
    ownLaunch: string[]
    /** What each persona's next launch used: its spawn's config directory and its reply-guard record. */
    launched: (name: string) => { claudeConfigDir: string | undefined; record: string | undefined }
  }>([
    {
      setting: 'claude_config_dir',
      before: () => ({ claude_config_dir: h.configDir('default') }),
      after: () => ({ claude_config_dir: h.configDir('default-new') }),
      inherit: { claude_config_dir: undefined },
      own: {},
      refresh: true,
      inheritorLaunch: ['spawn ErrInstanceIdCollision', 'delete ok', 'spawn ok'],
      ownLaunch: ['spawn ErrInstanceIdCollision', 'resume ok'],
      launched: (name) => ({ claudeConfigDir: name === 'charlie' ? ownConfigDir('charlie') : h.configDir('default-new'), record: 'true' }),
    },
    {
      setting: 'stop_hook_bootstrap',
      before: () => ({ stop_hook_bootstrap: true }),
      after: () => ({ stop_hook_bootstrap: false }),
      inherit: {},
      own: { stop_hook_bootstrap: true },
      refresh: false,
      inheritorLaunch: ['spawn ErrInstanceIdCollision', 'resume ok'],
      ownLaunch: ['spawn ErrInstanceIdCollision', 'resume ok'],
      launched: (name) => ({ claudeConfigDir: ownConfigDir(name), record: name === 'charlie' ? 'true' : 'false' }),
    },
  ])('AC 61: the top-level $setting changed, inherited by alpha and bravo and overridden by charlie, is previewed as one line listing exactly alpha and bravo, records no teardown, bring-up or reconnect, and each inheritor\'s next launch uses the new default while charlie\'s keeps its own (real launch)', async ({ setting, before, after, inherit, own, refresh, inheritorLaunch, ownLaunch, launched }) => {
    const names = ['alpha', 'bravo', 'charlie']
    const { run, personas } = await running([['alpha', inherit], ['bravo', inherit], ['charlie', own]], { ...REAL_LAUNCH, top: before() })
    const snapshot = () =>
      Object.fromEntries(names.map((n) => [n, { row: h.rowOf(n), record: h.readReplyGuardRecord(n), side: slackSideOf(run, n) }]))
    const kept = snapshot()
    const adFrom = run.composition!.agentDirectorCalls.length
    const cp = run.checkpoint()

    // Before confirmation: one line for the default, naming exactly the inheritors.
    const lines = await previewConfig(run, personas, after())
    const settingLines = lines.filter((l) => l.startsWith(`server-wide setting ${setting} changed:`))
    expect(settingLines).toHaveLength(1)
    expect(settingLines[0]).toStartWith(
      `server-wide setting ${setting} changed: inherited by ${renderPersonaRef('alpha', h.key('alpha'))}, ${renderPersonaRef('bravo', h.key('bravo'))}; `,
    )
    expect(settingLines[0]).not.toContain(renderPersonaRef('charlie', h.key('charlie')))
    h.confirm()
    await run.ticks.tick()

    // Nothing done to any persona; only step 5's refresh when the directory set changed.
    expect(run.since(cp).lifecycle).toEqual(refresh ? [refreshRecord('refreshed')] : [])
    expect(adCallsSince(run, adFrom).map((c) => `${c.verb} ${c.result}`)).toEqual(refresh ? ['makeTemplate ok'] : [])
    expect(snapshot()).toEqual(kept)
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)

    // Each one's next launch, from an ended row.
    for (const persona of personas) h.seedRow(persona, { state: 'ended' })
    for (const name of names) {
      const from = run.composition!.instanceCallsOf(name).length
      expect(await run.relaunch(name)).toBe(true)
      expect(instanceCallsSince(run, name, from)).toEqual(name === 'charlie' ? ownLaunch : inheritorLaunch)
      const { claudeConfigDir, record } = launched(name)
      expect(lastSpawnOf(run, name)?.claudeConfigDir).toBe(claudeConfigDir)
      expect(h.readReplyGuardRecord(name)).toBe(record)
    }
    expect(run.sessionNotices).toEqual([])
    expectNoPostNoLeak(run)
  })
})

describe('AC 61: a changed server-wide setting is recorded and takes effect at the next server start (b.av2 SR-8.6, the server-wide row)', () => {
  test.each<{ setting: 'port' | 'reply_chunk_limit'; before: number; after: number }>([
    { setting: 'port', before: 3101, after: 3102 },
    { setting: 'reply_chunk_limit', before: 3000, after: 1200 },
  ])('AC 61: $setting changed is listed in the preview; confirmed, it makes no lifecycle call, is recorded, counts as an effective change, and the running server keeps its start-time value until a fresh start over the same directories runs the new one', async ({ setting, before, after }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { top: { [setting]: before } as TopLevel })
    expect(run.serverConfig()![setting]).toBe(before)
    const sides = { alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }
    const cp = run.checkpoint()

    const lines = await previewConfig(run, personas, { [setting]: after } as TopLevel)
    expect(lines.filter((l) => l.startsWith(`server-wide setting ${setting} changed:`))).toHaveLength(1)
    expect(h.pendingHeader()).toContain('server-wide settings: 1 changed')
    h.confirm()
    await run.ticks.tick()

    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.since(cp).slackCalls).toEqual([])
    expect(run.since(cp).slackBuilds).toBe(0)
    expect({ alpha: slackSideOf(run, 'alpha'), bravo: slackSideOf(run, 'bravo') }).toEqual(sides)
    // Recorded, and an effective change; the running server still reads the start-time value.
    expect(JSON.parse(h.readRecord()!.toString('utf-8'))[setting]).toBe(after)
    expect(run.appliedConfigs.at(-1)![setting]).toBe(after)
    expect(run.serverConfig()![setting]).toBe(before)
    const applied = run.logsOf(RELOAD_APPLIED)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('server-wide settings: 1 changed')
    expect(run.logsOf(RELOAD_NOOP)).toEqual([])
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)

    // The next server start runs the record: the new value is in effect.
    await run.stop()
    const restarted = await h.start()
    expect(restarted.serverConfig()![setting]).toBe(after)
    expect(restarted.appliedKeys()).toEqual(keysOf('alpha', 'bravo'))
    expectNoPostNoLeak(restarted)
  })
})

describe('step 5: the agent-director template refresh (b.av2 SR-8.6 step 5, SR-11)', () => {
  beforeEach(useConfigDirs)

  /** The top-level default charlie inherits. */
  const DEFAULT_TOP = (): TopLevel => ({ claude_config_dir: h.configDir('default') })

  interface RefreshRow {
    label: string
    /** The candidate over the running alpha and bravo (own directories) and charlie (inheriting `DEFAULT_TOP`). */
    next: (personas: PersonaInput[], top: TopLevel) => { personas: PersonaInput[]; top: TopLevel }
    /** The effective config directories, as written, after it. */
    dirs: () => string[]
    /** The candidate has no effective change: the apply runs step 5 only and logs reload-noop. */
    noop?: boolean
  }

  /** delta, its files created, added to `personas`. */
  function withDelta(personas: PersonaInput[], overrides: Partial<PersonaInput> = {}): PersonaInput[] {
    const delta = h.persona('delta', overrides)
    h.materialize(delta)
    return [...personas, delta]
  }

  const REFRESH_ROWS: RefreshRow[] = [
    {
      label: "bravo's own directory moved to a new one",
      next: ([alpha, , charlie], top) => ({ personas: [alpha!, h.persona('bravo', { claude_config_dir: h.configDir('bravo-moved') }), charlie!], top }),
      dirs: () => [ownConfigDir('alpha'), h.configDir('bravo-moved'), h.configDir('default')],
    },
    {
      label: 'the top-level default charlie inherits changed',
      next: (personas) => ({ personas, top: { claude_config_dir: h.configDir('default-new') } }),
      dirs: () => [ownConfigDir('alpha'), ownConfigDir('bravo'), h.configDir('default-new')],
    },
    {
      label: 'delta added with a new directory',
      next: (personas, top) => ({ personas: withDelta(personas), top }),
      dirs: () => [ownConfigDir('alpha'), ownConfigDir('bravo'), h.configDir('default'), ownConfigDir('delta')],
    },
    {
      label: 'bravo, the only persona using its directory, removed',
      next: ([alpha, , charlie], top) => ({ personas: [alpha!, charlie!], top }),
      dirs: () => [ownConfigDir('alpha'), h.configDir('default')],
    },
    {
      // Director decision (c): the set is compared as written, so a new spelling of a used directory refreshes.
      label: "delta added whose claude_config_dir is a symlink to alpha's directory (unchanged by real path, changed as written)",
      next: (personas, top) => ({ personas: withDelta(personas, { claude_config_dir: configDirLink('delta-link', ownConfigDir('alpha')) }), top }),
      dirs: () => [ownConfigDir('alpha'), ownConfigDir('bravo'), h.configDir('default'), join(dirname(ownConfigDir('alpha')), 'delta-link')],
    },
    {
      label: "bravo's directory rewritten, on its own, as a symlink to the same real path (no effective change)",
      next: ([alpha, , charlie], top) => ({
        personas: [alpha!, h.persona('bravo', { claude_config_dir: configDirLink('bravo-link', ownConfigDir('bravo')) }), charlie!],
        top,
      }),
      dirs: () => [ownConfigDir('alpha'), join(dirname(ownConfigDir('alpha')), 'bravo-link'), h.configDir('default')],
      noop: true,
    },
  ]

  test.each(REFRESH_ROWS)('step 5: $label changes the set of effective config directories, so the apply refreshes the template exactly once, its allow rules covering exactly the new set and every other field as installed (real composition)', async ({ next, dirs, noop }) => {
    const { run, personas } = await running(['alpha', 'bravo', ['charlie', { claude_config_dir: undefined }]], { realLifecycle: true, top: DEFAULT_TOP() })
    const installed = run.composition!.installedTemplate!
    expect(installed.allow).toEqual(memoryRules(ownConfigDir('alpha'), ownConfigDir('bravo'), h.configDir('default')))
    const candidate = next(personas, DEFAULT_TOP())
    const cp = run.checkpoint()

    await applyConfig(run, candidate.personas, candidate.top)

    expect(run.lifecycle.of('template-refresh')).toEqual([refreshRecord('refreshed')])
    expect(templateCalls(run)).toEqual([{ ...installed, allow: memoryRules(...dirs()), overwrite: true }])
    expect(run.logs.filter((l) => l.startsWith('[slack] template refresh: '))).toHaveLength(1)
    if (noop) {
      expect(run.since(cp).lifecycle).toEqual([refreshRecord('refreshed')])
      expect(run.logsOf(RELOAD_NOOP)).toHaveLength(1)
      expect(run.logsOf(RELOAD_APPLIED)).toEqual([])
    } else {
      expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
      expect(run.logsOf(RELOAD_NOOP)).toEqual([])
    }
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; next: (personas: PersonaInput[]) => PersonaInput[] }>([
    { label: 'a stop_hook_bootstrap-only change', next: ([a, , c]) => [a!, h.persona('bravo', { stop_hook_bootstrap: false }), c!] },
    { label: "a destructive modify (bravo's working directory moved)", next: ([a, b, c]) => [a!, movedDirectory(b!), c!] },
    {
      label: 'an in-place change',
      next: ([a, , c]) => [a!, h.persona('bravo', { channels: [{ id: ownChannel('bravo'), delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] }), c!],
    },
    {
      label: "bravo moved into alpha's directory while charlie still uses bravo's old one",
      next: ([a, , c]) => [a!, h.persona('bravo', { claude_config_dir: ownConfigDir('alpha') }), c!],
    },
  ])('step 5: $label leaves the set of effective config directories as it was, so the apply makes no makeTemplate call (real composition)', async ({ next }) => {
    // charlie shares bravo's directory.
    const { run, personas } = await running(['alpha', 'bravo', ['charlie', { claude_config_dir: ownConfigDir('bravo') }]], { realLifecycle: true })
    const cp = run.checkpoint()

    await applyConfig(run, next(personas))

    expect(run.since(cp).lifecycle.filter((r) => r.op === 'template-refresh')).toEqual([])
    expect(run.lifecycle.applyTimeline.filter((e) => e.op === 'template-refresh')).toEqual([])
    expect(templateCalls(run)).toEqual([])
    expect(run.logs.filter((l) => l.startsWith('[slack] template refresh: '))).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("step 5 keeps the template's start-time server-wide arguments: an apply that adds delta with a new directory and also changes mcp_config_path and the system-prompt settings refreshes the allow rules only, without probing the append file again (real composition)", async () => {
    const prompt = join(h.root, 'system-prompt.md')
    writeFileSync(prompt, 'be brief\n')
    const startTop: TopLevel = { mcp_config_path: join(h.root, 'mcp-start.json'), system_prompt_mode: 'append', append_system_prompt_file: prompt }
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true, top: startTop })
    // Gone now, before anything reads the installed template: a refresh (or
    // an install captured after the start) that probed the file again would
    // drop the flag.
    rmSync(prompt)
    const installed = run.composition!.installedTemplate!
    // What the start installed: its MCP config, and the append flag (its file was readable then).
    expect(installed.claude_args).toEqual(expect.arrayContaining(['--mcp-config', startTop.mcp_config_path!, '--append-system-prompt-file', prompt]))

    await applyConfig(run, withDelta(personas), { mcp_config_path: join(h.root, 'mcp-next.json'), system_prompt_mode: 'none' })

    expect(templateCalls(run)).toEqual([
      { ...installed, allow: memoryRules(ownConfigDir('alpha'), ownConfigDir('bravo'), ownConfigDir('delta')), overwrite: true },
    ])
    expect(run.serverConfig()!.mcp_config_path).toBe(startTop.mcp_config_path!)
    expect(run.serverConfig()!.system_prompt_mode).toBe('append')
    expect(run.lifecycle.outcome(h.key('delta'))).toBe('up')
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test.each<{ label: string; err: () => Error }>([
    { label: 'a typed agent-director error', err: () => errTemplateMalformed() },
    // Its message holds a fake token: only a token-free rendering of it may be logged.
    { label: 'a generic throw', err: () => new Error(`the template store is unavailable ${fakeToken(APP_TOKEN_PREFIX, 'refresh')}`) },
  ])('step 5: a refresh rejected with $label is logged once, with no token, and is not fatal: the process does not exit, step 6 still brings up the added persona after it, reload-applied is logged and nothing stays pending (real composition)', async ({ err }) => {
    const { run, personas } = await running(['alpha', 'bravo'], { realLifecycle: true })
    const deltaKey = h.key('delta')
    const candidate = withDelta(personas)
    run.composition!.failTemplateRefresh(err())
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    let exits: number
    try {
      await applyConfig(run, candidate)
    } finally {
      exits = exit.mock.calls.length
      exit.mockRestore()
    }

    expect(exits).toBe(0)
    expect(run.lifecycle.of('template-refresh')).toEqual([refreshRecord('failed')])
    expect(templateCalls(run)).toHaveLength(1)
    const refreshLines = run.logs.filter((l) => l.startsWith('[slack] template refresh: '))
    expect(refreshLines).toHaveLength(1)
    expect(refreshLines[0]).toContain('failed')
    // Step 6 ran after it, and no step failed.
    expect(run.lifecycle.applyTimeline).toEqual([
      refreshEntry('start'),
      refreshEntry('settled'),
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    expect(run.lifecycle.outcome(deltaKey)).toBe('up')
    expect(run.logsOf('reload')).toEqual([])
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })

  test("step 5 settles before step 6: with the refresh held, delta, added with a new directory, is not brought up; released, the makeTemplate call comes before delta's spawn, so it launches with the refreshed template (real launch; E12 Task 2's interim gap closed)", async () => {
    const { run, personas } = await running(['alpha', 'bravo'], REAL_LAUNCH)
    const deltaKey = h.key('delta')
    const candidate = withDelta(personas)
    const refresh = run.lifecycle.hold('template-refresh')
    const adFrom = run.composition!.agentDirectorCalls.length

    const { applying } = await confirmConfig(run, candidate)
    await refresh.entered
    await turns()
    expect(run.lifecycle.applyTimeline).toEqual([refreshEntry('start')])
    expect(adCallsSince(run, adFrom)).toEqual([])
    expect(run.lifecycle.keys('bring-up').filter((k) => k === deltaKey)).toEqual([])

    refresh.release()
    await applying

    expect(run.lifecycle.applyTimeline).toEqual([
      refreshEntry('start'),
      refreshEntry('settled'),
      { op: 'bring-up', key: deltaKey, phase: 'start' },
      { op: 'bring-up', key: deltaKey, phase: 'settled' },
    ])
    const verbs = adCallsSince(run, adFrom).map((c) => `${c.verb}${c.id === undefined ? '' : ` ${c.id}`} ${c.result}`)
    expect(verbs[0]).toBe('makeTemplate ok')
    expect(verbs.filter((v) => v.startsWith('spawn '))).toEqual([`spawn ${personaInstanceId(deltaKey)} ok`])
    expect(run.lifecycle.of('launch').filter((r) => r.key === deltaKey)).toEqual([{ op: 'launch', key: deltaKey, via: 'apply', action: 'spawned' }])
    expectNoPostNoLeak(run)
  })

  test("step order across all six steps in one apply: bravo's removal and charlie's old half (step 2), delta's in-place change (3), golf's rotation (4), the refresh (5), then echo's addition and charlie's new half (6); held members show step 5 starts only once step 4 settled and step 6 only once step 5 settled, and alpha gets nothing", async () => {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie', 'delta', 'golf'])
    const [alpha, , charlie, , golf] = personas
    const [alphaKey, bravoKey, charlieKey, deltaKey, echoKey, golfKey] = keysOf('alpha', 'bravo', 'charlie', 'delta', 'echo', 'golf')
    const movedCharlie = movedDirectory(charlie!)
    const editedDelta = h.persona('delta', { channels: [{ id: ownChannel('delta'), delivery: 'all' }, { id: EXTRA_CHANNEL, delivery: 'all' }] })
    h.rotateCredentials(golf!)
    const echo = h.persona('echo')
    h.materialize(echo)
    const alphaUntouched = watchUntouched(run, 'alpha')
    const teardown = run.lifecycle.hold('teardown', bravoKey)
    const reconnect = run.lifecycle.hold('reconnect', golfKey)
    const refresh = run.lifecycle.hold('template-refresh')

    const { applying } = await confirmConfig(run, [alpha!, movedCharlie, editedDelta, golf!, echo])
    await teardown.entered
    await turns()
    // Step 2 holds on bravo's teardown: charlie's old half settled beside it, and nothing later started.
    expect(run.lifecycle.applyTimeline).toEqual([
      { op: 'teardown', key: bravoKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'start' },
      { op: 'teardown', key: charlieKey, phase: 'settled' },
    ])

    teardown.release()
    await reconnect.entered
    await turns()
    // Step 4 holds on golf's reconnect: step 3 settled, and step 5 has not started.
    expect(run.lifecycle.applyTimeline.slice(3)).toEqual([
      { op: 'teardown', key: bravoKey, phase: 'settled' },
      { op: 'update-in-place', key: deltaKey, phase: 'start' },
      { op: 'update-in-place', key: deltaKey, phase: 'settled' },
      { op: 'reconnect', key: golfKey, phase: 'start' },
    ])

    reconnect.release()
    await refresh.entered
    await turns()
    // Step 5 holds: step 4 settled first, and no bring-up has started.
    expect(run.lifecycle.applyTimeline.slice(7)).toEqual([
      { op: 'reconnect', key: golfKey, phase: 'settled' },
      refreshEntry('start'),
    ])

    refresh.release()
    await applying

    const timeline = run.lifecycle.applyTimeline
    expect(timeline[9]).toEqual(refreshEntry('settled'))
    expect(timeline.slice(10).map((e) => `${e.op} ${e.key} ${e.phase}`).sort()).toEqual(
      [
        `bring-up ${charlieKey} settled`,
        `bring-up ${charlieKey} start`,
        `bring-up ${echoKey} settled`,
        `bring-up ${echoKey} start`,
      ].sort(),
    )
    const steps = timeline.map((e) => APPLY_STEP_OF[e.op])
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(run.lifecycle.of('reconnect')).toEqual([{ op: 'reconnect', key: golfKey, via: 'apply', change: { kind: 'swapped' } }])
    expect(run.lifecycle.of('template-refresh')).toEqual([refreshRecord()])
    expect(run.lifecycle.outcome(charlieKey)).toBe('up')
    expect(run.lifecycle.outcome(echoKey)).toBe('up')
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie', 'delta', 'golf', 'echo'))
    expect(run.lifecycle.records.filter((r) => r.key === alphaKey && r.via === 'apply')).toEqual([])
    alphaUntouched()
    expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
    expect(run.logs.at(-1)).toStartWith(`[slack] ${RELOAD_APPLIED}: `)
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})
