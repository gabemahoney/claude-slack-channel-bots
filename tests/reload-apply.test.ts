/**
 * reload-apply.test.ts — What a confirmed change does to the personas (b.av2
 * SR-6.1 at apply, SR-6.5, SR-6.6, SR-8.6 steps 2 and 6, the removal and
 * `name` rows; AC 19, 22, 57, 64).
 *
 * Every case drives the real reload controller through `makeReloadHarness`:
 * start from a record, edit `config.json`, tick to write the pending file,
 * rename it with `h.confirm()`, tick again. The controller's default step
 * bodies then fan out to the harness's lifecycle recorder: step 2 tears down
 * each removed persona and step 6 brings up each added one. Cases marked
 * "real composition" bind `createPersonaLifecycle` (`opts.realLifecycle`),
 * so the teardown and bring-up are the production code over the run's real
 * bring-up controller and connection manager, stub Slack and a stub
 * agent-director client; the others use the recorder's stand-ins.
 *
 * Confirmation processing, invalid, stale and no-op candidates and step 1
 * are pinned in `tests/reload.test.ts`. In-place updates, credentials
 * reconnects, destructive modifies and the template refresh are left to the
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
  PERSONA_SLACK_UNREACHABLE,
} from '../src/persona-diagnostics.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { RELOAD_APPLIED } from '../src/reload.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
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

/**
 * A running server over `names`: each persona's files are created, then
 * `prepare` may break some, then the record and the configuration file are
 * written byte-equal, detection is started and its first check run (nothing
 * pending).
 */
async function running(
  names: string[],
  opts: ReloadRunOptions = {},
  prepare: (personas: PersonaInput[]) => void = () => undefined,
): Promise<{ run: ReloadRun; personas: PersonaInput[] }> {
  const personas = names.map((name) => h.persona(name))
  h.materialize(...personas)
  prepare(personas)
  h.writeRecord(configOf(...personas))
  h.writeConfig(configOf(...personas))
  const run = await h.startDetecting(opts)
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(false)
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

  // Step 2 fails delta's teardown; step 6 fails foxtrot's bring-up (each the step's second
  // persona, so the line must name the one that failed). Either way the failure is one
  // controller line with no message, the step's other persona still settles, and the apply
  // finishes.
  test.each<{ op: 'teardown' | 'bring-up'; failing: string; step: string }>([
    { op: 'teardown', failing: 'delta', step: '2 (teardowns)' },
    { op: 'bring-up', failing: 'foxtrot', step: '6 (bring-ups)' },
  ])("a $op that rejects is logged once by the controller without its message, the step's other persona still settles, and the apply finishes", async ({ op, failing, step }) => {
    const { run, next } = await removeTwoAddTwo()
    const [bravoKey, deltaKey, echoKey, foxtrotKey] = keysOf('bravo', 'delta', 'echo', 'foxtrot')
    const failingKey = h.key(failing)
    // A failure whose message holds a fake token: only its class may be logged.
    run.lifecycle.hold(op, failingKey).fail(new Error(`lifecycle op exploded ${fakeToken(APP_TOKEN_PREFIX, 'failure')}`))

    await applyConfig(run, next)

    // Every teardown settled or rejected before the first bring-up started; each call ended once.
    const timeline = run.lifecycle.timeline
    const firstBringUp = indexOf(timeline, { op: 'bring-up', phase: 'start' })
    expect(timeline.slice(0, firstBringUp).every((e) => e.op === 'teardown')).toBe(true)
    const ended = (key: string, callOp: typeof op) => (callOp === op && key === failingKey ? 'rejected' : 'settled')
    expect(timeline.map((e) => [e.op, e.key, e.phase]).sort()).toEqual(
      [
        ['teardown', bravoKey, 'start'],
        ['teardown', bravoKey, ended(bravoKey, 'teardown')],
        ['teardown', deltaKey, 'start'],
        ['teardown', deltaKey, ended(deltaKey, 'teardown')],
        ['bring-up', echoKey, 'start'],
        ['bring-up', echoKey, ended(echoKey, 'bring-up')],
        ['bring-up', foxtrotKey, 'start'],
        ['bring-up', foxtrotKey, ended(foxtrotKey, 'bring-up')],
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
    expect(run.appliedKeys()).toEqual(keysOf('alpha', 'echo', 'foxtrot'))
    await expectNothingPendingAfter(run)
    expectNoPostNoLeak(run)
  })
})
