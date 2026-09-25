/**
 * reload-apply.test.ts — What a confirmed change does to the personas (b.av2
 * SR-6.1 at apply, SR-6.5, SR-6.6, SR-8.6 steps 2, 3 and 6, the removal,
 * `name` and in-place rows; AC 19, 22, 57, 58, 64).
 *
 * Every case drives the real reload controller through `makeReloadHarness`:
 * start from a record, edit `config.json`, tick to write the pending file,
 * rename it with `h.confirm()`, tick again. The controller's default step
 * bodies then fan out to the harness's lifecycle recorder: step 2 tears down
 * each removed persona, step 3 updates each persona modified in place and
 * step 6 brings up each added one. Cases marked "real composition" bind
 * `createPersonaLifecycle` (`opts.realLifecycle`), so the teardown, in-place
 * update and bring-up are the production code over the run's real bring-up
 * controller and connection manager, stub Slack and a stub agent-director
 * client; the others use the recorder's stand-ins. The AC 58 routing cases
 * then drive the run's real consumers (routing behind the event router, the
 * notifier and destination resolver, the MCP tools over a registered
 * session), which read the applied configuration at each use.
 *
 * Confirmation processing, invalid, stale and no-op candidates and step 1
 * are pinned in `tests/reload.test.ts`. Credentials reconnects, destructive
 * modifies, next-launch settings and the template refresh are left to the
 * work that binds them: nothing here asserts their presence or absence.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { PersonaInput } from '../src/config.ts'
import type { PersonaBringUpOutcome } from '../src/persona-bringup-controller.ts'
import {
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DM_DROPPED,
  PERSONA_SLACK_UNREACHABLE,
  UNCLAIMED_CHANNEL,
} from '../src/persona-diagnostics.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import type { InPlaceSetting } from '../src/reload-plan.ts'
import { RELOAD_APPLIED } from '../src/reload.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makeChannelMessage, makeDm, mentionText, stubOpenedDmId, type StubWebCall } from './test-helpers/slack-stub.ts'
import {
  makeReloadHarness,
  NO_RUN_ACTIVITY,
  SLACK_AUTH_REJECTED,
  SLACK_UNREACHABLE,
  type LifecycleTimelineEntry,
  type PreparedPersonaState,
  type ReloadHarness,
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

/** The keys of `names`, in order. */
function keysOf(...names: string[]): string[] {
  return names.map((n) => h.key(n))
}

/** A persona of `running`: its name, alone or with its overrides over `h.persona(name)`. */
type PersonaSpec = string | [name: string, overrides: Partial<PersonaInput>]

/** `running`'s options: the run's, plus `sessions` to register an MCP session for every persona once it has started. */
interface RunningOptions extends ReloadRunOptions {
  sessions?: boolean
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
  const { sessions, ...runOpts } = opts
  const personas = specs.map((spec) => (typeof spec === 'string' ? h.persona(spec) : h.persona(...spec)))
  h.materialize(...personas)
  prepare(personas)
  h.writeRecord(configOf(...personas))
  h.writeConfig(configOf(...personas))
  const run = await h.startDetecting(runOpts)
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(false)
  if (sessions) for (const persona of personas) run.registerSession(persona.name)
  return { run, personas }
}

/**
 * Write `personas` as the configuration file, check it (the pending file is
 * written), confirm it and start the tick that applies it; `applying` is
 * that tick, not awaited.
 */
async function confirmConfig(run: ReloadRun, personas: PersonaInput[]): Promise<{ applying: Promise<void> }> {
  h.writeConfig(configOf(...personas))
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  h.confirm()
  return { applying: run.ticks.tick() }
}

/** `confirmConfig`, its apply awaited. */
async function applyConfig(run: ReloadRun, personas: PersonaInput[]): Promise<void> {
  await (await confirmConfig(run, personas)).applying
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
  /** alpha, bravo and delta running; the change removes bravo and delta and adds echo and foxtrot. */
  async function removeTwoAddTwo() {
    const { run, personas } = await running(['alpha', 'bravo', 'delta'])
    const echo = h.persona('echo')
    const foxtrot = h.persona('foxtrot')
    h.materialize(echo, foxtrot)
    return { run, next: [personas[0]!, echo, foxtrot] }
  }

  test("with bravo's teardown held, delta's still runs and settles while no bring-up starts; once bravo's is released both bring-ups run, and reload-applied comes last", async () => {
    const { run, next } = await removeTwoAddTwo()
    const [bravoKey, deltaKey, echoKey, foxtrotKey] = keysOf('bravo', 'delta', 'echo', 'foxtrot')
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
    expect(run.logsOf(RELOAD_APPLIED)).toEqual([])

    gate.release()
    await applying

    const timeline = run.lifecycle.timeline
    const firstBringUp = indexOf(timeline, { op: 'bring-up', phase: 'start' })
    expect(indexOf(timeline, { key: bravoKey, phase: 'settled' })).toBe(firstBringUp - 1)
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

  /**
   * alpha, bravo, charlie and delta running; the change removes bravo and
   * delta (step 2), adds a channel to alpha and to charlie (step 3), and adds
   * echo and foxtrot (step 6): two personas in each step.
   */
  async function twoOfEach() {
    const { run, personas } = await running(['alpha', 'bravo', 'charlie', 'delta'])
    const withExtra = (name: string, extra: string) =>
      h.persona(name, { channels: [{ id: ownChannel(name), delivery: 'all' }, { id: extra, delivery: 'all' }] })
    const echo = h.persona('echo')
    const foxtrot = h.persona('foxtrot')
    h.materialize(echo, foxtrot)
    expect(personas.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    return { run, next: [withExtra('alpha', EXTRA_CHANNEL), withExtra('charlie', OTHER_CHANNEL), echo, foxtrot] }
  }

  /** The apply step each timeline op belongs to, in step order. */
  const STEP_OF: Record<LifecycleTimelineEntry['op'], number> = { teardown: 2, 'update-in-place': 3, 'bring-up': 6 }

  // Each row fails the step's second persona, so the line must name the one that failed.
  // Either way the failure is one controller line with no message, the step's other
  // persona still settles, every later step still runs, and the apply finishes.
  test.each<{ label: string; op: LifecycleTimelineEntry['op']; failing: string; step: string }>([
    { label: 'step 2', op: 'teardown', failing: 'delta', step: '2 (teardowns)' },
    { label: 'AC 58: step 3', op: 'update-in-place', failing: 'charlie', step: '3 (in-place-updates)' },
    { label: 'step 6', op: 'bring-up', failing: 'foxtrot', step: '6 (bring-ups)' },
  ])("$label: when one $op rejects, it is logged once by the controller without its message, the step's other persona still settles, the later steps still run, and the apply finishes", async ({ op, failing, step }) => {
    const { run, next } = await twoOfEach()
    const [alphaKey, bravoKey, charlieKey, deltaKey, echoKey, foxtrotKey] = keysOf('alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot')
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
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'charlie', 'echo', 'foxtrot'))
    await expectNothingPendingAfter(run)
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
