/**
 * persona-lifecycle.test.ts — The persona teardown and the apply bring-up
 * (`createPersonaLifecycle`, src/persona-lifecycle.ts; b.av2 SR-6.1, SR-6.2,
 * SR-6.5, SR-6.6).
 *
 * Every lifecycle here runs through a real `createPersonaSerializer`. The
 * dependencies are recorders by default (each call appends `<dep>:<arg>` to
 * one shared trail, so order and the key are both asserted), replaced by the
 * real module where the case is about that module:
 * - the agent-director kill and delete: the real `killPersonaInstance` /
 *   `deletePersonaInstance` over `makeStubClient`, with the real outage state
 *   (`resetAllToHealthy`) and the real notifier, destination resolver and
 *   destination hold (`makeNotifierHarness`, fake clock);
 * - serialization behind a restart: the real restart module
 *   (`initRestart` with `serialize`, real `cancelRestartTimer`). Its timer is
 *   a real `setTimeout` (1 ms here; it takes no fake clock), waited for by a
 *   1 ms-step poll;
 * - serialization behind a bring-up retry: the real bring-up controller over
 *   the real connection manager (`makeConnectionHarness`, fake clock).
 *
 * Isolation (b.av2 SR-13.2): persona paths under a per-test `mkdtempSync`
 * directory, fake tokens only, no real agent-director, no Slack post.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import { ErrSystemInstallDisappeared } from '../src/agent-director-errors.ts'
import { _resetBackoffState } from '../src/backoff.ts'
import { _resetOutageState, getOutageFlags, initOutageState, resetAllToHealthy, setOutageFlag } from '../src/outage-state.ts'
import { createPersonaBringUpController, type PersonaBringUpController, type PersonaBringUpResultSummary } from '../src/persona-bringup-controller.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaLifecycle, type PersonaLifecycle, type PersonaLifecycleDeps } from '../src/persona-lifecycle.ts'
import { createPersonaSerializer, type PersonaSerializer } from '../src/persona-serializer.ts'
import { _resetRestartState, cancelAllRestartTimers, cancelRestartTimer, initRestart, isRestartPendingOrActive, scheduleRestart } from '../src/restart.ts'
import { deletePersonaInstance, killPersonaInstance } from '../src/session-manager.ts'
import { errGeneric, errSpawnNotFound, makeStubCallLog, makeStubClient, stubCallCount } from './test-helpers/agent-director-stub.ts'
import { BOT_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import type { WebApiOutcome } from './test-helpers/slack-stub.ts'

// ---------------------------------------------------------------------------
// Temp directory, console capture and module state
// ---------------------------------------------------------------------------

let dir: string
/** Silences console.error (the restart module logs there). */
let consoleSpy: ReturnType<typeof spyOn> | undefined
/** Controllers and harnesses built in the running test: cancelled and stopped after it. */
const cleanups: Array<() => void | Promise<void>> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-lifecycle-'))
  consoleSpy = spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  cancelAllRestartTimers()
  _resetRestartState()
  _resetBackoffState()
  _resetOutageState()
  resetClientForTests()
  consoleSpy?.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

/** Let pending promise continuations run (no timer involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** Whether `p` settled (either way) once pending continuations ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await flush()
  return done
}

/** Poll in 1 ms steps (2 s cap) until `cond` holds: only for the restart module's real timer. */
async function until(cond: () => boolean): Promise<void> {
  for (let waited = 0; !cond(); waited++) {
    if (waited > 2_000) throw new Error('until: condition not reached in 2 s')
    await Bun.sleep(1)
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NAME_A = 'Alpha Desk'
const NAME_B = 'Beta Ops'

/** Two personas under the test dir; B has its own claude_config_dir (the launch pass re-evaluates it). */
function makeConfig(): PersonaConfig {
  return makeMultiPersonaConfig(
    [{ name: NAME_A }, { name: NAME_B, claude_config_dir: join(dir, 'beta-claude') }],
    dir,
  )
}

/** Dependency names the recorder fixture can make fail. */
type DepName =
  | 'bringUps.cancel' | 'bringUps.bringUp' | 'cancelRestartTimer' | 'whenLaunchSettled' | 'connections.stop'
  | 'routing.forget' | 'destinations.forget' | 'destinationHold.cancel' | 'notifier.forget' | 'forgetPersonaPrompts'
  | 'dropSession' | 'resetOutageState' | 'killInstance' | 'deleteInstance' | 'forgetFailures'
  | 'forgetDisconnectedStreak' | 'replyGuard.launchedWithDir' | 'replyGuard.teardown' | 'replyGuard.launchPass'
  | 'storageCheck' | 'launch'

/** Dependencies whose production form returns a promise: their failure is a rejection, the others' a throw. */
const ASYNC_DEPS = new Set<DepName>(['bringUps.bringUp', 'whenLaunchSettled', 'connections.stop', 'dropSession', 'killInstance', 'deleteInstance', 'launch'])

/** A thrown value whose message carries a fake token: the log line must not show it. */
function failure(): Error {
  return new Error(`step exploded with ${fakeToken(BOT_TOKEN_PREFIX, 'lifecycle')}`)
}

interface FixtureOptions {
  dryRun?: boolean
  /** Dependencies that fail (async ones reject, the others throw) with `failure()`. */
  fail?: readonly DepName[]
  /** What the recording `launchedWithDir` returns. */
  launchedWith?: string
  /** What the recording `whenLaunchSettled` returns for a key (default: resolved). */
  launchInFlight?: (key: string) => Promise<void>
  /** What the recording `bringUps.bringUp` resolves with. */
  bringUpResult?: PersonaBringUpResultSummary
  /** Replace any dependency (real modules); the trail then records only the recorders left. */
  overrides?: Partial<PersonaLifecycleDeps>
}

interface Fixture {
  lifecycle: PersonaLifecycle
  serializer: PersonaSerializer
  config: PersonaConfig
  a: Persona
  b: Persona
  /** The applied persona set `appliedPersonas` returns; starts as [A] (B's removal applied). */
  applied: Persona[]
  /** Every recorder call, in order: `<dep>:<argument>`. */
  trail: string[]
  /** Every lifecycle log line. */
  lines: string[]
  /** Keys submitted to the serializer through the lifecycle. */
  submitted: string[]
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const config = makeConfig()
  const [a, b] = config.personas as [Persona, Persona]
  const trail: string[] = []
  const lines: string[] = []
  const submitted: string[] = []
  const applied: Persona[] = [a]
  const serializer = createPersonaSerializer()
  const fails = new Set(opts.fail ?? [])

  /** A recorder for `name`: appends `<name>:<describe(args)>`, then fails if asked, else returns `value()`. */
  function rec<A extends unknown[], R>(name: DepName, describe: (...args: A) => string, value: (...args: A) => R) {
    return (...args: A): R => {
      trail.push(`${name}:${describe(...args)}`)
      if (fails.has(name)) {
        if (ASYNC_DEPS.has(name)) return Promise.reject(failure()) as R
        throw failure()
      }
      return value(...args)
    }
  }
  const byKey = (key: string) => key
  const byPersona = (p: Persona) => p.key

  const deps: PersonaLifecycleDeps = {
    serialize: (key, op) => {
      submitted.push(key)
      return serializer.run(key, op)
    },
    bringUps: {
      cancel: rec('bringUps.cancel', byKey, () => undefined),
      bringUp: rec(
        'bringUps.bringUp',
        (p: Persona, set: readonly Persona[]) => `${p.key}:[${set.map((x) => x.key).join(',')}]`,
        async () => opts.bringUpResult ?? { outcome: 'up' as const, failures: [] },
      ),
    },
    connections: { stop: rec('connections.stop', byKey, async () => undefined) },
    routing: { forget: rec('routing.forget', byKey, () => undefined) },
    destinations: { forget: rec('destinations.forget', byKey, () => undefined) },
    destinationHold: { cancel: rec('destinationHold.cancel', byKey, () => undefined) },
    notifier: { forget: rec('notifier.forget', byKey, () => undefined) },
    appliedPersonas: () => [...applied], // a fresh array per read, as the server's getter over a swapped config
    dryRun: opts.dryRun ?? false,
    isShuttingDown: () => false,
    log: (line) => void lines.push(line),
    whenLaunchSettled: rec('whenLaunchSettled', byKey, (key: string) => opts.launchInFlight?.(key) ?? Promise.resolve()),
    cancelRestartTimer: rec('cancelRestartTimer', byKey, () => false),
    forgetFailures: rec('forgetFailures', byKey, () => undefined),
    forgetDisconnectedStreak: rec('forgetDisconnectedStreak', byKey, () => undefined),
    resetOutageState: rec('resetOutageState', (keys: string[]) => keys.join(','), () => undefined),
    forgetPersonaPrompts: rec('forgetPersonaPrompts', byKey, () => 0),
    dropSession: rec('dropSession', byKey, async () => false),
    killInstance: rec('killInstance', byKey, async () => true),
    deleteInstance: rec('deleteInstance', byKey, async () => true),
    replyGuard: {
      launchedWithDir: rec('replyGuard.launchedWithDir', byKey, () => opts.launchedWith),
      teardown: rec('replyGuard.teardown', byKey, () => undefined),
      launchPass: rec(
        'replyGuard.launchPass',
        (dirs: readonly (string | undefined)[], personas: readonly Persona[]) =>
          `${JSON.stringify(dirs)}:[${personas.map((p) => p.key).join(',')}]`,
        () => undefined,
      ),
    },
    storageCheck: rec('storageCheck', byPersona, () => undefined),
    launch: rec('launch', byPersona, async () => ({ key: 'x', action: 'spawned' })),
    ...opts.overrides,
  }
  return { lifecycle: createPersonaLifecycle(deps), serializer, config, a, b, applied, trail, lines, submitted }
}

/** The teardown line prefix for `p`. */
function teardownPrefix(p: Persona): string {
  return `[slack] persona teardown of ${renderPersonaRef(p.name, p.key)}`
}

/** The full teardown trail for `p`, outside dry run, with the recorders' defaults. */
function fullTeardownTrail(p: Persona, launchPass: string): string[] {
  const k = p.key
  return [
    `bringUps.cancel:${k}`, `cancelRestartTimer:${k}`, `whenLaunchSettled:${k}`,
    `connections.stop:${k}`, `routing.forget:${k}`, `destinations.forget:${k}`, `destinationHold.cancel:${k}`,
    `notifier.forget:${k}`, `forgetPersonaPrompts:${k}`, `dropSession:${k}`,
    `resetOutageState:${k}`, `killInstance:${k}`, `deleteInstance:${k}`, `resetOutageState:${k}`,
    `forgetFailures:${k}`, `forgetDisconnectedStreak:${k}`,
    `replyGuard.launchedWithDir:${k}`, `replyGuard.teardown:${k}`, `replyGuard.launchPass:${launchPass}`,
  ]
}

/** The launch-pass record for B's config dir and `launchedWith`, against the applied set [A]. */
function launchPassOf(f: Fixture, launchedWith: string | undefined): string {
  return `${JSON.stringify([f.b.claude_config_dir, launchedWith])}:[${f.a.key}]`
}

// ---------------------------------------------------------------------------
// Persona teardown (SR-6.5): order, failures, dry run
// ---------------------------------------------------------------------------

describe('persona teardown (SR-6.5): every step for the removed key only, in order', () => {
  test('AC 57: tearing B down runs every step for B alone, in the documented order, then the launch pass with B\'s config and launched-with dirs against the personas still applied; starting and complete lines only', async () => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ launchedWith })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, launchedWith)))
    expect(f.lines).toEqual([`${teardownPrefix(f.b)}: starting`, `${teardownPrefix(f.b)}: complete`])
    expect(f.trail.join('\n')).not.toContain(f.a.key + ':')
    expect(f.submitted).toEqual([f.b.key])
  })

  test('the launch pass reads the applied set when it runs, not when the teardown started', async () => {
    let applied: Persona[] = []
    const f = makeFixture({
      launchInFlight: async () => {
        applied.length = 0 // the applied set changes while the teardown runs
      },
    })
    applied = f.applied

    await f.lifecycle.teardown(f.b)

    expect(f.trail.at(-1)).toBe(`replyGuard.launchPass:${JSON.stringify([f.b.claude_config_dir, undefined])}:[]`)
  })

  // Rows: the dependency that fails, the step phrase its line names, and how many steps fail.
  test.each<[DepName, string, number]>([
    ['bringUps.cancel', 'cancelling its bring-up retries', 1],
    ['cancelRestartTimer', 'cancelling its restart timer', 1],
    ['whenLaunchSettled', 'waiting for its launch in flight', 1],
    ['connections.stop', 'stopping its Slack connection', 1],
    ['routing.forget', 'forgetting its inbound dedupe store', 1],
    ['destinations.forget', 'forgetting its DM destination', 1],
    ['destinationHold.cancel', 'cancelling its held destination notices', 1],
    ['notifier.forget', 'dropping its held notices', 1],
    ['forgetPersonaPrompts', 'dropping its tracked permission prompts', 1],
    ['dropSession', 'dropping its MCP session', 1],
    ['resetOutageState', 'forgetting its outage state', 2],
    ['killInstance', 'agent-director kill of cscb_<key>', 1],
    ['deleteInstance', 'agent-director delete of cscb_<key>', 1],
    ['forgetFailures', 'forgetting its restart failure count', 1],
    ['forgetDisconnectedStreak', 'forgetting its health-check streak', 1],
    ['replyGuard.launchedWithDir', 'reading its launched-with directory', 1],
    ['replyGuard.teardown', 'deleting its reply-guard record', 1],
    ['replyGuard.launchPass', 're-evaluating the Stop hook in its config directories', 1],
  ])('%s failing: its step is logged token-safely, every other step still runs, and the completion line counts the failed steps', async (dep, phrase, failed) => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ fail: [dep], launchedWith })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    // A failed launched-with read leaves the launch pass without that dir.
    const expectedWith = dep === 'replyGuard.launchedWithDir' ? undefined : launchedWith
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, expectedWith)))
    const step = phrase.replace('cscb_<key>', personaInstanceId(f.b.key))
    const failedLine = new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${step} failed: Error`)}( |$)`)
    expect(f.lines[0]).toBe(`${teardownPrefix(f.b)}: starting`)
    expect(f.lines.slice(1, -1)).toHaveLength(failed)
    for (const line of f.lines.slice(1, -1)) expect(line).toMatch(failedLine)
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with ${failed} failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('every step failing: the teardown still resolves, runs each step once and reports all of them', async () => {
    const all: DepName[] = [
      'bringUps.cancel', 'cancelRestartTimer', 'whenLaunchSettled', 'connections.stop', 'routing.forget',
      'destinations.forget', 'destinationHold.cancel', 'notifier.forget', 'forgetPersonaPrompts', 'dropSession',
      'resetOutageState', 'killInstance', 'deleteInstance', 'forgetFailures', 'forgetDisconnectedStreak',
      'replyGuard.launchedWithDir', 'replyGuard.teardown', 'replyGuard.launchPass',
    ]
    const f = makeFixture({ fail: all })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 19 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('dry run: no agent-director kill or delete (and no clean slate before them), one dry-run line naming cscb_<key>; every other step still runs', async () => {
    const f = makeFixture({ dryRun: true })

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    expect(f.trail).toEqual(
      fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter(
        (c, i) => c !== `killInstance:${k}` && c !== `deleteInstance:${k}` && !(c === `resetOutageState:${k}` && i === 10),
      ),
    )
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      `[slack] dry-run: persona teardown of ${renderPersonaRef(f.b.name, k)}: skipping the agent-director kill and delete of ${personaInstanceId(k)}`,
      `${teardownPrefix(f.b)}: complete`,
    ])
  })

  test('a throwing logger does not stop the teardown', async () => {
    const f = makeFixture({ overrides: { log: () => { throw new Error('log sink exploded') } } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
  })
})

// ---------------------------------------------------------------------------
// Persona teardown with the real agent-director calls, outage state,
// notifier and destination hold: no wind-down, no flag and no notice left.
// ---------------------------------------------------------------------------

describe('persona teardown (SR-6.5) over the real kill and delete, outage state, notifier and destination hold', () => {
  interface RealFixture {
    f: Fixture
    h: NotifierHarness
    calls: ReturnType<typeof makeStubCallLog>
    /** Agent-director verbs in call order, with the instance they name. */
    adOrder: string[]
    /** Every outage notify call (onsets and all-clears), by key. */
    emissions: Array<{ key: string; text: string }>
  }

  /**
   * B already left the applied set (apply step 1): the notifier harness's
   * persona list no longer has it. Outage notices go through the real
   * notifier. `kill` / `delete` script the stub's errors.
   */
  function makeReal(opts: { killError?: Error; deleteError?: Error; post?: Record<string, readonly WebApiOutcome[]> } = {}): RealFixture {
    const config = makeConfig()
    const h = makeNotifierHarness(config, { post: opts.post })
    cleanups.push(() => h.hold.cancelAll())
    const calls = makeStubCallLog()
    const adOrder: string[] = []
    const stub = makeStubClient({ ...calls, killError: opts.killError, deleteError: opts.deleteError })
    const kill = stub.kill.bind(stub)
    const del = stub.delete.bind(stub)
    stub.kill = (p) => { adOrder.push(`kill:${p.claude_instance_id}`); return kill(p) }
    stub.delete = (p) => { adOrder.push(`delete:${p.claude_instance_id.join(',')}`); return del(p) }
    setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
    const emissions: Array<{ key: string; text: string }> = []
    initOutageState({
      getClient,
      notify: (key, text) => {
        emissions.push({ key, text })
        void h.notifier.notify(key, text)
      },
    })
    const f = makeFixture({
      overrides: {
        killInstance: killPersonaInstance,
        deleteInstance: deletePersonaInstance,
        resetOutageState: resetAllToHealthy,
        notifier: h.notifier,
        destinations: h.destinations,
        destinationHold: h.hold,
      },
    })
    return { f, h, calls, adOrder, emissions }
  }

  /** Step 1 of the apply: B leaves the applied set the notifier reads. */
  function removeB(r: RealFixture): void {
    const i = r.h.personas.findIndex((p) => p.key === r.f.b.key)
    r.h.personas.splice(i, 1)
  }

  test('AC 57: B\'s row is killed then deleted, cscb_B only, and no other agent-director verb is called (no graceful wind-down); A\'s outage flag is untouched', async () => {
    const r = makeReal()
    setOutageFlag(r.f.a.key, 'ad-unreachable', '/bin/ad')
    removeB(r)
    const before = r.emissions.length

    await r.f.lifecycle.teardown(r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(stubCallCount(r.calls)).toBe(2)
    expect([...getOutageFlags(r.f.a.key)]).toEqual(['ad-unreachable'])
    expect(r.emissions.slice(before)).toEqual([])
    expect(r.f.lines).toEqual([`${teardownPrefix(r.f.b)}: starting`, `${teardownPrefix(r.f.b)}: complete`])
    expect(r.h.totalPosts()).toBe(1) // A's onset, posted before the teardown
    expect(r.h.posts(r.f.b.key)).toEqual([])
  })

  test('B held an ad-unreachable flag and the kill and delete succeed: no all-clear is raised or posted, and B holds no flag afterwards', async () => {
    const r = makeReal()
    setOutageFlag(r.f.b.key, 'ad-unreachable', '/bin/ad')
    await flush()
    const postsBefore = r.h.posts(r.f.b.key).length
    removeB(r)
    const before = r.emissions.length

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    expect(r.emissions.slice(before)).toEqual([])
    expect([...getOutageFlags(r.f.b.key)]).toEqual([])
    expect(r.h.posts(r.f.b.key)).toHaveLength(postsBefore)
  })

  test('agent-director unreachable: the kill and delete fail and are logged, the other steps run, B holds no flag afterwards, and the onset raised for B is never posted or held', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', `/opt/ad/${fakeToken(BOT_TOKEN_PREFIX, 'bin')}`)
    const r = makeReal({ killError: unreachable, deleteError: unreachable })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(r.f.trail.slice(-5)).toEqual([
      `forgetFailures:${r.f.b.key}`, `forgetDisconnectedStreak:${r.f.b.key}`,
      `replyGuard.launchedWithDir:${r.f.b.key}`, `replyGuard.teardown:${r.f.b.key}`,
      `replyGuard.launchPass:${launchPassOf(r.f, undefined)}`,
    ])
    expect(r.f.lines.slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(r.f.b)}: agent-director kill of ${id} failed: ErrSystemInstallDisappeared`)}`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(r.f.b)}: agent-director delete of ${id} failed: ErrSystemInstallDisappeared`)}`)),
      `${teardownPrefix(r.f.b)}: complete, with 2 failed step(s)`,
    ])
    expect([...getOutageFlags(r.f.b.key)]).toEqual([])
    expect(r.emissions.map((e) => e.key)).toEqual([r.f.b.key])
    expect(r.h.totalPosts()).toBe(0)
    expect(r.h.hold.view(r.f.b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  test.each<[string, Error | undefined, Error | undefined, string[]]>([
    ['the row is already gone (ErrSpawnNotFound on both): success, no failed step', errSpawnNotFound(), errSpawnNotFound(), []],
    ['the kill fails with another error: logged, and the delete still runs', errGeneric('kill', 'ErrKillBroken'), undefined, ['kill']],
    ['the delete fails with another error: logged', undefined, errGeneric('delete', 'ErrDeleteBroken'), ['delete']],
  ])('%s', async (_label, killError, deleteError, failedVerbs) => {
    const r = makeReal({ killError, deleteError })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(r.f.lines.slice(1, -1)).toEqual(
      failedVerbs.map((v) => expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(r.f.b)}: agent-director ${v} of ${id} failed: AgentDirectorError`)}`))),
    )
    expect(r.f.lines.at(-1)).toBe(
      failedVerbs.length === 0 ? `${teardownPrefix(r.f.b)}: complete` : `${teardownPrefix(r.f.b)}: complete, with ${failedVerbs.length} failed step(s)`,
    )
    expect(r.emissions).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
  })

  test('a notice held for B by the destination hold is cancelled: its retry timer is gone and it is never posted, even once its retry would have come due', async () => {
    const r = makeReal()
    const b = r.f.b
    r.h.stub(b.key).script.post.push(...Array<WebApiOutcome>(1000).fill({ kind: 'platform', error: 'not_in_channel' }))
    await r.h.notifier.notify(b.key, 'a notice for B')
    expect(r.h.hold.view(b.key)).toMatchObject({ held: true, heldNotices: 1 })
    expect(r.h.clock.pendingCount()).toBe(1)
    const attempts = r.h.stub(b.key).calls.postMessage.length
    r.h.stub(b.key).script.post.length = 0
    removeB(r)

    await r.f.lifecycle.teardown(b)
    await r.h.clock.advance(3_600_000)

    expect(r.h.hold.view(b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(r.h.clock.pendingCount()).toBe(0)
    expect(r.h.stub(b.key).calls.postMessage).toHaveLength(attempts)
    expect(r.h.posts(r.f.a.key)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Apply bring-up (SR-6.1, SR-6.2)
// ---------------------------------------------------------------------------

describe('apply bring-up (SR-6.1, SR-6.2): storage check, bring-up, then a launch only when up', () => {
  /** An applied config holding A and the added persona B. */
  function appliedOf(f: Fixture): PersonaConfig {
    return { ...f.config, personas: [f.a, f.b] }
  }

  test('an added persona that comes up: its storage check, its bring-up against the applied set, then its launch; the result is the bring-up\'s', async () => {
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const f = makeFixture({ bringUpResult: result })

    const got = await f.lifecycle.bringUp(f.b, appliedOf(f))

    expect(got).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: up at apply — launching`])
    expect(f.submitted).toEqual([f.b.key])
  })

  test.each<['retrying' | 'broken']>([['retrying'], ['broken']])('an added persona whose outcome is %s is not launched and returns at once with its outcome, no line of the lifecycle\'s own', async (outcome) => {
    const result: PersonaBringUpResultSummary = { outcome, failures: [{ step: 'slack', class: 'network', cause: 'unreachable' }] }
    const f = makeFixture({ bringUpResult: result })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`])
    expect(f.lines).toEqual([])
  })

  test('the bring-up resolves only once the up persona\'s launch settled', async () => {
    const gate = Promise.withResolvers<unknown>()
    const f = makeFixture({ overrides: { launch: () => gate.promise } })

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    expect(await settled(done)).toBe(false)
    gate.resolve(undefined)
    expect(await done).toEqual({ outcome: 'up', failures: [] })
  })

  test('a failing launch is logged token-safely and the bring-up still resolves with its outcome', async () => {
    const f = makeFixture({ fail: ['launch'] })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toEqual({ outcome: 'up', failures: [] })
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: up at apply — launching`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: launch at apply failed: Error`)}( |$)`)),
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('a throwing storage check is logged token-safely and the bring-up and launch still run', async () => {
    const f = makeFixture({ fail: ['storageCheck'] })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toEqual({ outcome: 'up', failures: [] })
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines[0]).toMatch(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: storage check at apply failed: Error`)}( |$)`))
    expect(f.lines.slice(1)).toEqual([`[slack] persona ${ref}: up at apply — launching`])
    assertNoLeak({ lines: f.lines })
  })

  test('a failing bring-up rejects the apply bring-up (the controller\'s fan-out reports it) and launches nothing', async () => {
    const f = makeFixture({ fail: ['bringUps.bringUp'] })

    // The injected failure itself, not any error (a broken fixture would throw a TypeError).
    await expect(f.lifecycle.bringUp(f.b, appliedOf(f))).rejects.toThrow(/^step exploded with /)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`])
  })

  test('shutting down when the operation starts (the flag set while it waited for B\'s turn): no storage check, no bring-up, no launch; one line; it resolves broken with no failures', async () => {
    let shuttingDown = false
    const f = makeFixture({ overrides: { isShuttingDown: () => shuttingDown } })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    shuttingDown = true
    blocker.resolve()
    await held

    expect(await done).toEqual({ outcome: 'broken', failures: [] })
    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('shutdown beginning during the bring-up (the flag set before it resolves up): the bring-up ran, no launch; one line; it resolves with the bring-up\'s up result', async () => {
    let shuttingDown = false
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const gate = Promise.withResolvers<PersonaBringUpResultSummary>()
    const bringUpCalls: string[] = []
    const f = makeFixture({
      overrides: {
        isShuttingDown: () => shuttingDown,
        bringUps: { cancel: () => undefined, bringUp: (p) => { bringUpCalls.push(p.key); return gate.promise } },
      },
    })

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    await flush()
    expect(bringUpCalls).toEqual([f.b.key])
    shuttingDown = true
    gate.resolve(result)

    expect(await done).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
  })

  test('serialized per key: B\'s bring-up waits behind an operation running for B; A\'s bring-up does not', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.bringUp(f.b, appliedOf(f))
    await f.lifecycle.bringUp(f.a, appliedOf(f))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`storageCheck:${f.a.key}`, `bringUps.bringUp:${f.a.key}:[${f.a.key},${f.b.key}]`, `launch:${f.a.key}`])

    blocker.resolve()
    await held
    await forB
    expect(f.trail.filter((c) => c.startsWith('launch:'))).toEqual([`launch:${f.a.key}`, `launch:${f.b.key}`])
  })
})

// ---------------------------------------------------------------------------
// Serialization (SR-6.6): a teardown waits behind the key's restart, retry
// launch and in-flight start-pass launch; never behind another key's work.
// ---------------------------------------------------------------------------

describe('persona teardown serialization (SR-6.6)', () => {
  test('a teardown for B waits at its launch-in-flight step (the start pass\'s launch) and holds B\'s turn meanwhile; A\'s teardown and bring-up complete in the meantime', async () => {
    const launchInFlight = Promise.withResolvers<void>()
    let bKey = ''
    const f = makeFixture({ launchInFlight: (key) => (key === bKey ? launchInFlight.promise : Promise.resolve()) })
    bKey = f.b.key
    const applied = { ...f.config, personas: [f.a, f.b] }

    const forB = f.lifecycle.teardown(f.b)
    await flush()
    expect(f.trail).toEqual(fullTeardownTrail(f.b, '').slice(0, 3))

    // B's turn is held: a bring-up for B submitted now waits. A is independent.
    const bringUpB = f.lifecycle.bringUp(f.b, applied)
    await f.lifecycle.teardown(f.a)
    await f.lifecycle.bringUp(f.a, applied)
    expect(await settled(forB)).toBe(false)
    expect(await settled(bringUpB)).toBe(false)
    expect(f.trail.filter((c) => c.endsWith(`:${f.b.key}`))).toEqual(fullTeardownTrail(f.b, '').slice(0, 3))
    expect(f.lines.filter((l) => l.startsWith(teardownPrefix(f.a)))).toEqual([
      `${teardownPrefix(f.a)}: starting`, `${teardownPrefix(f.a)}: complete`,
    ])

    launchInFlight.resolve()
    await forB
    await bringUpB
    const bTeardown = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    const bringUpOf = (p: Persona) => [`storageCheck:${p.key}`, `bringUps.bringUp:${p.key}:[${f.a.key},${f.b.key}]`, `launch:${p.key}`]
    expect(f.trail).toEqual([
      ...bTeardown.slice(0, 3),
      ...fullTeardownTrail(f.a, `${JSON.stringify([f.a.claude_config_dir, undefined])}:[${f.a.key}]`),
      ...bringUpOf(f.a),
      ...bTeardown.slice(3),
      ...bringUpOf(f.b),
    ])
  })

  describe('behind the restart module (real initRestart with the serializer, real cancelRestartTimer)', () => {
    /**
     * Init the real restart module over `f`'s serializer, recording into
     * `f.trail`: `restart.canRestart:<key>` (the relaunch gate: at scheduling,
     * then twice in the work), `restart.submitted:<key>` (the fired timer
     * submits its work) and `restart.launchSession:<key>`.
     */
    function initRestartFor(f: Fixture, launch: () => Promise<boolean>, up: () => boolean = () => true): void {
      initRestart({
        canRestart: (key) => { f.trail.push(`restart.canRestart:${key}`); return up() },
        isSessionAlive: async () => false,
        isSessionConnected: () => false,
        hasSessionStream: () => true,
        reconnectSession: async () => undefined,
        killSession: async () => undefined,
        launchSession: async (key) => { f.trail.push(`restart.launchSession:${key}`); return launch() },
        getRestartDelay: () => 0.001,
        isShuttingDown: () => false,
        onCapReached: () => undefined,
        serialize: (key, op) => { f.trail.push(`restart.submitted:${key}`); return f.serializer.run(key, op) },
      })
    }

    const teardownOnly = (f: Fixture) => f.trail.filter((c) => !c.startsWith('restart.'))
    /** The full teardown trail without the recorder for `cancelRestartTimer` (the real one runs here). */
    const expectedTeardown = (f: Fixture) =>
      fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => !c.startsWith('cancelRestartTimer:'))
    const restartOnly = (f: Fixture) => f.trail.filter((c) => c.startsWith('restart.'))

    test('a teardown for B submitted while B\'s restart work is running (its launch in progress) starts only once that work settled', async () => {
      const launchGate = Promise.withResolvers<boolean>()
      const f = makeFixture({ overrides: { cancelRestartTimer } })
      initRestartFor(f, () => launchGate.promise)
      scheduleRestart(f.b.key, '/cwd/b')
      await until(() => f.trail.includes(`restart.launchSession:${f.b.key}`))

      const done = f.lifecycle.teardown(f.b)
      expect(await settled(done)).toBe(false)
      expect(f.lines).toEqual([])
      expect(teardownOnly(f)).toEqual([])

      launchGate.resolve(true)
      await done
      expect(f.trail.indexOf(`bringUps.cancel:${f.b.key}`)).toBe(f.trail.indexOf(`restart.launchSession:${f.b.key}`) + 1)
      expect(teardownOnly(f)).toEqual(expectedTeardown(f))
      expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete`)
      expect(isRestartPendingOrActive(f.b.key)).toBe(false)
    })

    test('a teardown for B queued behind B\'s fired restart runs after it; the restart work, starting after B left the applied set, is refused by the gate and launches nothing', async () => {
      let bApplied = true
      const f = makeFixture({ overrides: { cancelRestartTimer } })
      initRestartFor(f, async () => true, () => bApplied)
      const blocker = Promise.withResolvers<void>()
      const held = f.serializer.run(f.b.key, () => blocker.promise)
      scheduleRestart(f.b.key, '/cwd/b')
      // The timer fires and its work is queued behind the blocker.
      await until(() => f.trail.includes(`restart.submitted:${f.b.key}`))

      bApplied = false // apply step 1
      const done = f.lifecycle.teardown(f.b)
      blocker.resolve()
      await held
      await done

      const k = f.b.key
      expect(restartOnly(f)).toEqual([`restart.canRestart:${k}`, `restart.submitted:${k}`, `restart.canRestart:${k}`])
      expect(f.trail.indexOf(`bringUps.cancel:${k}`)).toBe(3)
      expect(teardownOnly(f)).toEqual(expectedTeardown(f))
      expect(isRestartPendingOrActive(k)).toBe(false)
    })
  })

  describe('behind a bring-up retry (real bring-up controller over the real connection manager)', () => {
    interface RetryFixture {
      h: ConnectionHarness
      controller: PersonaBringUpController
      f: Fixture
      a: Persona
      b: Persona
      /** Keys the controller launched after a retry. */
      launches: string[]
    }

    /**
     * A and B on the connection harness with their files; B's first auth.test
     * fails (network), so B is retrying its Slack bring-up. The controller
     * runs its retry launches through `f`'s serializer; the lifecycle's
     * `bringUps` and `connections` are the controller and the manager.
     */
    async function makeRetry(opts: { launch?: (p: Persona) => Promise<unknown>; whenLaunchSettled?: PersonaLifecycleDeps['whenLaunchSettled'] } = {}): Promise<RetryFixture> {
      const h = makeConnectionHarness([{ name: NAME_A }, { name: NAME_B }], dir, {
        files: true,
        stubOptions: { [NAME_B]: { authTest: [{ kind: 'network' }] } },
      })
      const [a, b] = h.personas as [Persona, Persona]
      const launches: string[] = []
      let controller!: PersonaBringUpController
      const f = makeFixture({
        overrides: {
          bringUps: { bringUp: (p, set) => controller.bringUp(p, set), cancel: (k) => controller.cancel(k) },
          connections: h.manager,
          ...(opts.whenLaunchSettled ? { whenLaunchSettled: opts.whenLaunchSettled } : {}),
        },
      })
      controller = createPersonaBringUpController({
        connections: { bringUp: h.connections.bringUp, status: (key) => h.manager.status(key) },
        clock: h.clock,
        dryRun: false,
        log: (line) => void h.lines.push(line),
        appliedPersonas: () => h.config?.personas ?? [],
        serialize: f.serializer.run,
        launch: async (p) => {
          launches.push(p.key)
          return opts.launch?.(p)
        },
      })
      h.onStatus = (key, status) => controller.onConnectionStatus(key, status)
      cleanups.push(async () => {
        controller.cancelAll()
        await h.manager.stopAll()
      })
      for (const p of [a, b]) await controller.bringUp(p, h.personas)
      expect(controller.state(b.key)?.outcome).toBe('retrying')
      return { h, controller, f, a, b, launches }
    }

    test('a teardown for B submitted while B\'s launch after its Slack retry is running waits for it; then B has no bring-up state, no connection and no pending timer', async () => {
      const launchGate = Promise.withResolvers<void>()
      const r = await makeRetry({ launch: (p) => (p.name === NAME_B ? launchGate.promise : Promise.resolve()) })
      await r.h.clock.advance(5_000)
      expect(r.launches).toEqual([r.b.key])

      r.h.config = { ...r.h.config!, personas: [r.a] } // apply step 1
      const done = r.f.lifecycle.teardown(r.b)
      expect(await settled(done)).toBe(false)
      expect(r.f.lines).toEqual([])
      expect(r.h.manager.status(r.b.key)).toMatchObject({ state: 'up' })

      launchGate.resolve()
      await done

      expect(r.f.lines.at(-1)).toBe(`${teardownPrefix(r.b)}: complete`)
      expect(r.controller.state(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.clock.pendingCount()).toBe(0)
      expect(r.h.manager.status(r.a.key)).toMatchObject({ state: 'up' })
      assertNoLeak({ lines: r.h.lines, teardown: r.f.lines })
    })

    test('B\'s Slack retry coming up while B\'s teardown is running (waiting on a launch in flight) launches nothing: the teardown cancelled B\'s bring-up first', async () => {
      const launchInFlight = Promise.withResolvers<void>()
      const r = await makeRetry({ whenLaunchSettled: () => launchInFlight.promise })
      r.h.config = { ...r.h.config!, personas: [r.a] } // apply step 1

      const done = r.f.lifecycle.teardown(r.b)
      await flush()
      await r.h.clock.advance(5_000)
      launchInFlight.resolve()
      await done
      await r.h.clock.advance(3_600_000)

      expect(r.launches).toEqual([])
      expect(r.controller.state(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: r.h.lines, teardown: r.f.lines })
    })
  })
})
