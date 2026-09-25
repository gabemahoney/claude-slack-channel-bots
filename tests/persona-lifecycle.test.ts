/**
 * persona-lifecycle.test.ts — The persona teardown, the apply bring-up (and
 * the recovery bring-up of a credentials-broken persona), the credentials
 * change and the in-place update (`createPersonaLifecycle`,
 * src/persona-lifecycle.ts; b.av2 SR-6.1, SR-6.2, SR-6.4, SR-6.5, SR-6.6,
 * SR-8.6).
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
 * - serialization behind a bring-up retry, the recovery bring-up of a
 *   persona broken by its credentials, and confirmed credentials changes
 *   (the controller's `changeCredentials` called directly, and through the
 *   lifecycle): the real bring-up controller over the real connection manager
 *   (`makeControllerStack` over `makeConnectionHarness`, fake clock), each
 *   rewritten credentials file registered as its own stub credential set.
 *
 * Isolation (b.av2 SR-13.2): persona paths under a per-test `mkdtempSync`
 * directory, fake tokens only, no real agent-director, no Slack post.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { MakeTemplateParams } from 'agent-director'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import { ErrSystemInstallDisappeared } from '../src/agent-director-errors.ts'
import { _resetBackoffState } from '../src/backoff.ts'
import { _resetOutageState, getOutageFlags, initOutageState, resetAllToHealthy, setOutageFlag } from '../src/outage-state.ts'
import {
  createPersonaBringUpController,
  type CredentialsChangeConnections,
  type CredentialsChangeHooks,
  type CredentialsSwap,
  type PersonaBringUpController,
  type PersonaBringUpResultSummary,
  type PersonaBringUpState,
  type PersonaCredentialsChangeResult,
} from '../src/persona-bringup-controller.ts'
import { credentialsDigest, readCredentialsFile } from '../src/persona-credentials.ts'
import {
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_SLACK_UNREACHABLE,
} from '../src/persona-diagnostics.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaLifecycle, type PersonaLifecycle, type PersonaLifecycleDeps } from '../src/persona-lifecycle.ts'
import { createPersonaSerializer, type PersonaSerializer } from '../src/persona-serializer.ts'
import type { InPlaceApplyInput } from '../src/reload-apply.ts'
import type { InPlaceSetting } from '../src/reload-plan.ts'
import { _resetRestartState, cancelAllRestartTimers, cancelRestartTimer, initRestart, isRestartPendingOrActive, scheduleRestart } from '../src/restart.ts'
import { deletePersonaInstance, killPersonaInstance } from '../src/session-manager.ts'
import { errGeneric, errSpawnNotFound, makeStubCallLog, makeStubClient, stubCallCount } from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken, writeCredentialsFile } from './test-helpers/credentials.ts'
import { makeConnectionHarness, type ConnectionHarness, type ConnectionHarnessOptions } from './test-helpers/persona-connection-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { INITIAL_CREDENTIALS, makeDeferredWebApiCall, type WebApiOutcome } from './test-helpers/slack-stub.ts'

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
  | 'bringUps.cancel' | 'bringUps.bringUp' | 'bringUps.state' | 'bringUps.changeCredentials' | 'cancelRestartTimer' | 'whenLaunchSettled' | 'connections.stop'
  | 'routing.forget' | 'destinations.forget' | 'destinationHold.cancel' | 'notifier.forget' | 'forgetPersonaPrompts'
  | 'dropSession' | 'resetOutageState' | 'killInstance' | 'deleteInstance' | 'forgetFailures'
  | 'forgetDisconnectedStreak' | 'replyGuard.launchedWithDir' | 'replyGuard.teardown' | 'replyGuard.launchPass'
  | 'storageCheck' | 'launch' | 'connections.reconnectCredentials' | 'connections.replaceRetryTokens'

/** Dependencies whose production form returns a promise: their failure is a rejection, the others' a throw. */
const ASYNC_DEPS = new Set<DepName>([
  'bringUps.bringUp', 'bringUps.changeCredentials', 'whenLaunchSettled', 'connections.stop', 'connections.reconnectCredentials',
  'dropSession', 'killInstance', 'deleteInstance', 'launch',
])

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
  /** What the recording `bringUps.state` returns, read at each call (default: undefined, an unknown persona). */
  state?: () => PersonaBringUpState | undefined
  /** What the recording `bringUps.changeCredentials` resolves with (default: `swapped`). It never calls the hook itself. */
  changeResult?: PersonaCredentialsChangeResult
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
  /** The connections the lifecycle was given (its `deps.connections`). */
  connections: PersonaLifecycleDeps['connections']
  /** Every recording `bringUps.changeCredentials` call's connections and hooks, in order. */
  changeCalls: Array<{ connections: CredentialsChangeConnections; hooks: CredentialsChangeHooks | undefined }>
  /** Every `makeTemplate` call the template refresh made on its stub agent-director client, in order. */
  templateCalls: MakeTemplateParams[]
}

/**
 * What the boot install wrote (the template refresh's `installed`): every
 * field but `allow` must reach the refresh unchanged. Its fields differ from
 * what `buildTemplateParams` would give, so a refresh built from anything
 * else shows.
 */
const INSTALLED_TEMPLATE: MakeTemplateParams = {
  name: 'slack-channel-bot',
  label: ['app=cscb'],
  relay_mode: 'on',
  claude_args: ['--dangerously-load-development-channels', 'server:slack-channel-router', '--mcp-config', '/start/mcp.json'],
  allow: ['Read(//start/claude/projects/*/memory/**)'],
  deny: ['Read(//start/secret/**)'],
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const config = makeConfig()
  const [a, b] = config.personas as [Persona, Persona]
  const trail: string[] = []
  const lines: string[] = []
  const submitted: string[] = []
  const changeCalls: Fixture['changeCalls'] = []
  const templateCalls: MakeTemplateParams[] = []
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
      state: rec('bringUps.state', byKey, () => opts.state?.()),
      changeCredentials: rec(
        'bringUps.changeCredentials',
        (p: Persona, set: readonly Persona[], _connections: CredentialsChangeConnections, _hooks?: CredentialsChangeHooks) =>
          `${p.key}:[${set.map((x) => x.key).join(',')}]`,
        async (_p: Persona, _set: readonly Persona[], connections: CredentialsChangeConnections, hooks?: CredentialsChangeHooks) => {
          changeCalls.push({ connections, hooks })
          return opts.changeResult ?? { kind: 'swapped' as const }
        },
      ),
    },
    connections: {
      stop: rec('connections.stop', byKey, async () => undefined),
      // Handed to the controller's changeCredentials only: the lifecycle never calls them itself.
      reconnectCredentials: rec('connections.reconnectCredentials', byKey, async () => ({ kind: 'cancelled' as const })),
      replaceRetryTokens: rec('connections.replaceRetryTokens', byKey, () => false),
    },
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
    templateRefresh: {
      installed: INSTALLED_TEMPLATE,
      getClient: () => makeStubClient({ makeTemplateCalls: templateCalls }),
    },
    ...opts.overrides,
  }
  return {
    lifecycle: createPersonaLifecycle(deps), serializer, config, a, b, applied, trail, lines, submitted,
    connections: deps.connections, changeCalls, templateCalls,
  }
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

/**
 * The teardown trail for a key still applied when it is submitted (the old
 * half of a destructive modify): its bring-up retries and restart timer
 * cancelled at submit, before its turn, then the full trail with its held
 * notices dropped again right after the agent-director calls.
 */
function stillAppliedTeardownTrail(p: Persona, launchPass: string): string[] {
  const full = fullTeardownTrail(p, launchPass)
  const afterAd = full.lastIndexOf(`resetOutageState:${p.key}`) + 1
  return [
    `bringUps.cancel:${p.key}`, `cancelRestartTimer:${p.key}`,
    ...full.slice(0, afterAd), `notifier.forget:${p.key}`, ...full.slice(afterAd),
  ]
}

/** The launch-pass record for B's config dir and `launchedWith`, against the applied set [A]. */
function launchPassOf(f: Fixture, launchedWith: string | undefined): string {
  return `${JSON.stringify([f.b.claude_config_dir, launchedWith])}:[${f.a.key}]`
}

/** The real bring-up controller over the real connection manager, and a lifecycle over them. */
interface ControllerStack {
  h: ConnectionHarness
  controller: PersonaBringUpController
  /** The lifecycle fixture: its `bringUps` is the controller, its `connections` the manager; the rest are recorders. */
  f: Fixture
  a: Persona
  b: Persona
  /** Keys the controller launched itself (after a retry, or once a credentials swap brought a refused persona back up). */
  launches: string[]
}

/**
 * A and B on the connection harness with their files (not brought up yet).
 * The controller reads the harness's applied set, runs its retry work
 * through `f`'s serializer and logs into `h.lines`; teardown cancels it,
 * stops the manager and asserts no fake-clock timer is left.
 */
function makeControllerStack(opts: {
  stubOptions?: ConnectionHarnessOptions['stubOptions']
  /** What the controller's launch does after recording the key. */
  launch?: (p: Persona) => Promise<unknown>
  /** Further lifecycle dependency overrides. */
  overrides?: Partial<PersonaLifecycleDeps>
} = {}): ControllerStack {
  const h = makeConnectionHarness([{ name: NAME_A }, { name: NAME_B }], dir, { files: true, stubOptions: opts.stubOptions })
  const [a, b] = h.personas as [Persona, Persona]
  const launches: string[] = []
  let controller!: PersonaBringUpController
  const f = makeFixture({
    overrides: {
      bringUps: {
        bringUp: (p, set) => controller.bringUp(p, set),
        cancel: (k) => controller.cancel(k),
        state: (k) => controller.state(k),
        changeCredentials: (...args) => controller.changeCredentials(...args),
      },
      connections: h.manager,
      ...opts.overrides,
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
    expect(h.clock.pendingCount()).toBe(0)
  })
  return { h, controller, f, a, b, launches }
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
// Persona teardown of a key still applied: the old half of a destructive
// modify (b.av2 SR-8.6, a credentials_file path or working_directory change).
// ---------------------------------------------------------------------------

describe('persona teardown of a key still applied (the old half of a destructive modify, SR-8.6)', () => {
  // Rows: whether B is still applied when its teardown is submitted, what ran
  // at submit while B's turn was held, and the whole trail once it ran.
  test.each<[string, boolean, (f: Fixture) => string[], (f: Fixture, launchPass: string) => string[]]>([
    [
      'B still applied (a destructive modify\'s old half): its bring-up retries and restart timer are cancelled at submit, before its turn; its held notices are dropped again after the agent-director calls',
      true,
      (f) => [`bringUps.cancel:${f.b.key}`, `cancelRestartTimer:${f.b.key}`],
      (f, launchPass) => stillAppliedTeardownTrail(f.b, launchPass),
    ],
    [
      'B removed (it left the applied set at step 1): nothing runs before its turn, and its notices are dropped once',
      false,
      () => [],
      (f, launchPass) => fullTeardownTrail(f.b, launchPass),
    ],
  ])('%s', async (_label, stillApplied, atSubmit, whole) => {
    const f = makeFixture()
    if (stillApplied) f.applied.push(f.b)
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.teardown(f.b)
    await flush()
    expect(f.trail).toEqual(atSubmit(f))
    expect(f.lines).toEqual([])

    blocker.resolve()
    await held
    await done
    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.applied.map((p) => p.key).join(',')}]`
    expect(f.trail).toEqual(whole(f, launchPass))
    expect(f.lines).toEqual([`${teardownPrefix(f.b)}: starting`, `${teardownPrefix(f.b)}: complete`])
    expect(f.trail.join('\n')).not.toContain(f.a.key + ':')
    expect(f.submitted).toEqual([f.b.key])
  })

  test('dry run, B still applied: the early cancels and the second notice drop still run; only the kill and delete (and the clean slate before them) are skipped', async () => {
    const f = makeFixture({ dryRun: true })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${k}]`
    const trail = stillAppliedTeardownTrail(f.b, launchPass)
    const firstReset = trail.indexOf(`resetOutageState:${k}`)
    expect(f.trail).toEqual(
      trail.filter((c, i) => c !== `killInstance:${k}` && c !== `deleteInstance:${k}` && i !== firstReset),
    )
  })

  // Rows: the early cancel that fails, its step phrase, and whether it throws or returns a rejected promise.
  test.each<[DepName, string, 'throws' | 'rejects']>([
    ['bringUps.cancel', 'cancelling its bring-up retries', 'throws'],
    ['cancelRestartTimer', 'cancelling its restart timer', 'throws'],
    ['cancelRestartTimer', 'cancelling its restart timer', 'rejects'],
  ])('%s failing at submit (%s; it %s): one token-safe "before its turn failed" line, the other early cancel still runs, and the whole teardown still runs', async (dep, phrase, how) => {
    // A throw also fails the same step in the teardown's turn; a rejection is overridden for the early call only.
    let calls = 0
    const f = makeFixture(
      how === 'throws'
        ? { fail: [dep] }
        : {
            overrides: {
              cancelRestartTimer: (key) => {
                f.trail.push(`cancelRestartTimer:${key}`)
                return calls++ === 0 ? Promise.reject(failure()) : false
              },
            },
          },
    )
    f.applied.push(f.b)

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()
    await flush()

    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${f.b.key}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass))
    const beforeTurn = f.lines.filter((l) => l.includes(' before its turn failed: '))
    expect(beforeTurn).toHaveLength(1)
    expect(beforeTurn[0]).toMatch(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} before its turn failed: Error`)}( |$)`))
    expect(f.lines).toContain(`${teardownPrefix(f.b)}: starting`)
    expect(f.lines.at(-1)).toBe(how === 'throws' ? `${teardownPrefix(f.b)}: complete, with 1 failed step(s)` : `${teardownPrefix(f.b)}: complete`)
    assertNoLeak({ lines: f.lines })
  })

  test('both early cancels failing: one line each, in order, before the teardown starts', async () => {
    const f = makeFixture({ fail: ['bringUps.cancel', 'cancelRestartTimer'] })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    expect(f.lines.slice(0, 3)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: cancelling its bring-up retries before its turn failed: Error`)}( |$)`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: cancelling its restart timer before its turn failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: starting`,
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 2 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('B still applied and dropping its notices failing: both drops are logged token-safely, the second by its own phrase, and every other step still runs', async () => {
    const f = makeFixture({ fail: ['notifier.forget'] })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${f.b.key}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass))
    expect(f.lines.slice(1, -1)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: dropping its held notices failed: Error`)}( |$)`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: dropping the notices held during its teardown failed: Error`)}( |$)`)),
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 2 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('the applied set cannot be read: B counts as not applied (no early cancel, no second notice drop), and the launch pass\'s failed read is its one failed step', async () => {
    const f = makeFixture({ overrides: { appliedPersonas: () => { throw failure() } } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, '').slice(0, -1))
    expect(f.lines.slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: re-evaluating the Stop hook in its config directories failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
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

  test('the old half of a destructive modify (B still applied, its connection stopped) with agent-director unreachable: the onset its failing kill raises is held for B, then dropped after the agent-director calls, so B\'s new half, once validated and flushed, posts nothing', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', '/opt/ad/bin')
    const r = makeReal({ killError: unreachable, deleteError: unreachable })
    const b = r.f.b
    r.f.applied.push(b) // B keeps its key applied until step 6 brings its new declaration up
    r.h.validated.delete(b.key) // its connection is stopped: no validated client, so a notice for it is held

    await r.f.lifecycle.teardown(b)
    await flush()
    expect(r.emissions.map((e) => e.key)).toEqual([b.key]) // the onset was raised for B

    // Step 6: B's new half comes up and its held notices are flushed.
    r.h.validate(b.key)
    await r.h.notifier.flush(b.key)

    expect(r.h.posts(b.key)).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
    expect([...getOutageFlags(b.key)]).toEqual([])
    expect(r.h.hold.view(b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(r.f.lines.at(-1)).toBe(`${teardownPrefix(b)}: complete, with 2 failed step(s)`)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
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
        bringUps: {
          cancel: () => undefined,
          bringUp: (p) => { bringUpCalls.push(p.key); return gate.promise },
          state: () => undefined,
          changeCredentials: async () => ({ kind: 'skipped' }),
        },
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
// Recovery bring-up (SR-6.4, SR-8.6 step 6): a persona broken by its
// credentials whose credentials file changed. Decided when it runs.
// ---------------------------------------------------------------------------

/** An applied config holding A and B. */
function appliedAB(f: Fixture): PersonaConfig {
  return { ...f.config, personas: [f.a, f.b] }
}

/** One cause of `step` and `cls` (the cause text is not read by the lifecycle). */
const causeOf = (step: 'credentials' | 'working-directory' | 'slack', cls: string) => ({ step, class: cls, cause: 'x' })

/** Bring-up states B can be in when its recovery runs. */
const STATES = {
  brokenMissing: { outcome: 'broken', causes: { credentials: causeOf('credentials', PERSONA_CREDENTIALS_MISSING) } },
  brokenInvalid: { outcome: 'broken', causes: { credentials: causeOf('credentials', PERSONA_CREDENTIALS_INVALID) } },
  brokenRefused: { outcome: 'broken', causes: { slack: causeOf('slack', PERSONA_CREDENTIALS_REFUSED) } },
  brokenOther: { outcome: 'broken', causes: { slack: causeOf('slack', 'error') } },
  retryingSlack: { outcome: 'retrying', causes: { slack: causeOf('slack', PERSONA_SLACK_UNREACHABLE) } },
  retryingDirectory: { outcome: 'retrying', causes: { directory: causeOf('working-directory', PERSONA_DIRECTORY_MISSING) } },
  firstAttempt: { outcome: undefined, causes: {} },
  up: { outcome: 'up', causes: {} },
} satisfies Record<string, PersonaBringUpState>

describe('recovery bring-up (SR-6.4, SR-8.6 step 6): a credentials-broken persona is cleared, then brought up afresh', () => {
  const recovery = { recovery: true } as const

  /** B's recovery-specific steps, then the apply bring-up's, for an `up` result. */
  const recoveredTrail = (f: Fixture) => {
    const k = f.b.key
    return [
      `bringUps.state:${k}`, `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`,
      `storageCheck:${k}`, `bringUps.bringUp:${k}:[${f.a.key},${k}]`, `launch:${k}`,
    ]
  }

  test.each<[string, PersonaBringUpState]>([
    ['its credentials file missing', STATES.brokenMissing],
    ['its credentials file locally invalid', STATES.brokenInvalid],
    ['Slack refusing its token', STATES.brokenRefused],
  ])('B broken by %s: its bring-up state cancelled, its connection stopped and its cached DM forgotten, in that order, then storage check, bring-up and launch; B alone, through the serializer', async (_label, state) => {
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const f = makeFixture({ state: () => state, bringUpResult: result })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toBe(result)

    expect(f.trail).toEqual(recoveredTrail(f))
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: up at apply — launching`,
    ])
    expect(f.submitted).toEqual([f.b.key])
  })

  /** The recovery's line for a persona no longer broken by its credentials (finding 4's fallback). */
  const notBrokenLine = (f: Fixture) =>
    `[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change`
  /** The recovery's trail when it applies the change instead: the state read, the change, then the state read for its result. */
  const appliedAsChangeTrail = (f: Fixture) => [
    `bringUps.state:${f.b.key}`, `bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`, `bringUps.state:${f.b.key}`,
  ]

  // Rows: B's state when the recovery runs, what the controller's change resolves, and the change's own line after the prefix.
  test.each<[string, PersonaBringUpState | undefined, PersonaCredentialsChangeResult, string | undefined]>([
    ['up', STATES.up, { kind: 'swapped' }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    ['retrying: Slack unreachable', STATES.retryingSlack, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['retrying: working directory missing', STATES.retryingDirectory, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['in its first Slack attempt (no outcome yet)', STATES.firstAttempt, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['broken by another Slack error', STATES.brokenOther, { kind: 'skipped' }, undefined],
    ['unknown to the controller', undefined, { kind: 'skipped' }, undefined],
  ])('B %s when the recovery runs: not cleared or brought up; its changed credentials are applied as a credentials change in the same serializer turn, and it resolves with its outcome then and no failures', async (_label, state, changeResult, changeLine) => {
    const f = makeFixture({ state: () => state, changeResult })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: state?.outcome ?? 'broken', failures: [] })

    // No cancel, stop, forget, storage check, bring-up or launch.
    expect(f.trail).toEqual(appliedAsChangeTrail(f))
    expect(f.changeCalls).toHaveLength(1)
    expect(f.changeCalls[0]!.connections).toBe(f.connections)
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([notBrokenLine(f), ...(changeLine === undefined ? [] : [`[slack] persona ${ref}: ${changeLine}`])])
    // Called directly inside the recovery's turn, never submitted again (which would wait for itself).
    expect(f.submitted).toEqual([f.b.key])
  })

  test('the state is read when the recovery runs, not when it was submitted: B coming up while it waits for B\'s turn gets its change applied, not a fresh bring-up', async () => {
    let state: PersonaBringUpState = STATES.brokenRefused
    const f = makeFixture({ state: () => state })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.bringUp(f.b, appliedAB(f), recovery)
    expect(await settled(done)).toBe(false)
    expect(f.trail).toEqual([])
    state = STATES.up
    blocker.resolve()
    await held

    expect(await done).toEqual({ outcome: 'up', failures: [] })
    expect(f.trail).toEqual(appliedAsChangeTrail(f))
  })

  test('the change finds B broken by its credentials again: the recovery goes ahead (cleared, then brought up and launched)', async () => {
    const f = makeFixture({ state: () => STATES.up, changeResult: { kind: 'credentials-broken' } })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'up', failures: [] })

    const k = f.b.key
    expect(f.trail).toEqual([
      `bringUps.state:${k}`, `bringUps.changeCredentials:${k}:[${f.a.key},${k}]`,
      `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`,
      `storageCheck:${k}`, `bringUps.bringUp:${k}:[${f.a.key},${k}]`, `launch:${k}`,
    ])
    const ref = renderPersonaRef(f.b.name, k)
    expect(f.lines).toEqual([
      notBrokenLine(f),
      `[slack] persona ${ref}: broken by its credentials now, so it is brought up again rather than reconnected`,
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: up at apply — launching`,
    ])
    expect(f.submitted).toEqual([k])
  })

  test('shutdown beginning while B\'s leftover state is cleared: nothing new is connected or launched (no storage check, bring-up or launch); the shutdown line; it resolves broken with no failures', async () => {
    let f!: Fixture
    // Shutdown begins while B's connection is being stopped.
    f = makeFixture({
      state: () => STATES.brokenRefused,
      overrides: { isShuttingDown: () => f.trail.includes(`connections.stop:${f.b.key}`) },
    })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'broken', failures: [] })

    const k = f.b.key
    expect(f.trail).toEqual([`bringUps.state:${k}`, `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`])
    const ref = renderPersonaRef(f.b.name, k)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: not brought up — the server is shutting down`,
    ])
  })

  test.each<[DepName, string]>([
    ['bringUps.cancel', 'cancelling its bring-up state'],
    ['connections.stop', 'stopping its Slack connection'],
    ['destinations.forget', 'forgetting its DM destination'],
  ])('%s failing: logged token-safely, the other clearing steps and the bring-up still run', async (dep, phrase) => {
    const f = makeFixture({ state: () => STATES.brokenMissing, fail: [dep] })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'up', failures: [] })

    expect(f.trail).toEqual(recoveredTrail(f))
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toHaveLength(3)
    expect(f.lines[1]).toMatch(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: ${phrase} before bringing it up again failed: Error`)}( |$)`))
    expect(f.lines[2]).toBe(`[slack] persona ${ref}: up at apply — launching`)
    assertNoLeak({ lines: f.lines })
  })

  test('shutting down when the recovery starts: no state read, nothing cleared or brought up; the shutdown line; it resolves broken with no failures', async () => {
    const f = makeFixture({ state: () => STATES.brokenMissing, overrides: { isShuttingDown: () => true } })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'broken', failures: [] })

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
  })

  test('without the recovery option a credentials-broken persona is not cleared: no state read, no cancel, stop or forget', async () => {
    const f = makeFixture({ state: () => STATES.brokenMissing })

    await f.lifecycle.bringUp(f.b, appliedAB(f))

    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
  })

  // Rows: how B is broken by its credentials at start, and its credentials cause class.
  test.each<[string, boolean, string]>([
    ['its credentials file missing (then written)', true, PERSONA_CREDENTIALS_MISSING],
    ['Slack refusing its token at auth.test (then accepted)', false, PERSONA_CREDENTIALS_REFUSED],
  ])('over the real bring-up controller and connection manager: B broken by %s comes up at its recovery with its file\'s tokens and is launched; A is untouched', async (_label, missing, cls) => {
    const { h, controller, f, a, b } = makeControllerStack({
      stubOptions: missing ? {} : { [NAME_B]: { authTest: [{ kind: 'platform', error: 'invalid_auth' }] } },
    })
    if (missing) unlinkSync(b.credentials_file)
    for (const p of [a, b]) await controller.bringUp(p, h.personas)
    const brokenBy = missing ? { credentials: { class: cls } } : { slack: { class: cls } }
    expect(controller.state(b.key)).toMatchObject({ outcome: 'broken', causes: brokenBy })
    const aSockets = h.stub(a).sockets.length

    writeCredentialsFile(dir, relative(dir, b.credentials_file), { bot_token: h.tokens(b).botToken, app_token: h.tokens(b).appToken })
    const got = await f.lifecycle.bringUp(b, { ...h.config!, personas: [a, b] }, recovery)

    expect(got).toEqual({ outcome: 'up', failures: [] })
    expect(controller.state(b.key)?.outcome).toBe('up')
    expect(h.manager.status(b.key)).toMatchObject({ state: 'up' })
    expect(f.trail.filter((c) => c.startsWith('launch:'))).toEqual([`launch:${b.key}`])
    const ownCall = { key: b.key, gotTokens: true, ownTokens: true }
    expect(h.bringUpCalls.filter((c) => c.key === b.key)).toEqual(missing ? [ownCall] : [ownCall, ownCall])
    expect(h.stub(a).sockets).toHaveLength(aSockets)
    expect(h.manager.status(a.key)).toMatchObject({ state: 'up' })
    assertNoLeak({ lines: h.lines, lifecycle: f.lines })
  })
})

// ---------------------------------------------------------------------------
// Credentials change (SR-8.6 step 4, credentials row): the controller's
// changeCredentials over the lifecycle's connections, under the serializer.
// ---------------------------------------------------------------------------

describe('credentials change (SR-8.6 step 4): the controller\'s change over the connection manager, one line per outcome', () => {
  const lineOf = (f: Fixture, rest: string) => `[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: ${rest}`
  /** The reconnected line of a persona held for its claude_config_dir (bug b.g57): no MCP session, its launch still waits. */
  const HELD_RECONNECTED = 'reconnected with its changed credentials; its session is kept, and its launch waits until its claude_config_dir resolves'

  // Rows: the controller's result, and the lifecycle's line after the persona prefix (none for failed and skipped).
  test.each<[string, PersonaCredentialsChangeResult, string | undefined]>([
    ['swapped', { kind: 'swapped' }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    [
      'swapped, up again (its current connection was refused during the attempt)',
      { kind: 'swapped', cameBackUp: true },
      'reconnected with its changed credentials and up again; its instance is kept',
    ],
    ['swapped, held for its claude_config_dir (bug b.g57)', { kind: 'swapped', held: true }, HELD_RECONNECTED],
    ['swapped, up again and held for its claude_config_dir: held wins', { kind: 'swapped', cameBackUp: true, held: true }, HELD_RECONNECTED],
    [
      'retrying, the current connection kept',
      { kind: 'retrying', connection: 'kept' },
      'its changed credentials cannot reach Slack yet; the new connection retries and the current one stays in use',
    ],
    [
      'retrying, its current connection refused during the attempt',
      { kind: 'retrying', connection: 'broken' },
      'its changed credentials cannot reach Slack yet; the new connection retries, and it stays broken by its credentials until that connection is in use',
    ],
    ['retrying with no connection yet', { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['credentials-broken now', { kind: 'credentials-broken' }, 'broken by its credentials now, so it is brought up again rather than reconnected'],
    ['failed (the controller logged it)', { kind: 'failed', cause: 'credentials file does not exist' }, undefined],
    ['skipped', { kind: 'skipped' }, undefined],
  ])('%s: B\'s change against the applied set over the lifecycle\'s own connections, its result returned as is, and its line; nothing else done by the lifecycle', async (_label, result, rest) => {
    const f = makeFixture({ changeResult: result })

    expect(await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))).toBe(result)

    // The DM cache is forgotten only through the swap hook, never by the lifecycle itself.
    expect(f.trail).toEqual([`bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`])
    expect(f.changeCalls).toHaveLength(1)
    expect(f.changeCalls[0]!.connections).toBe(f.connections)
    expect(f.lines).toEqual(rest === undefined ? [] : [lineOf(f, rest)])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('its before-swap hook forgets B\'s cached DM conversation (only B\'s) when the controller calls it, and not before; the swapped hook forgets nothing', async () => {
    const f = makeFixture({ changeResult: { kind: 'retrying', connection: 'kept' } })

    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    const hooks = f.changeCalls[0]!.hooks!
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([])

    hooks.onSwapped!({ late: true, wasUp: true })
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([])

    hooks.beforeSwap!() // the new connection is about to come into use
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([`destinations.forget:${f.b.key}`])
  })

  // Rows: the swap the controller reports, and the line it logs after the persona prefix (none for the operation's own swap).
  test.each<[string, CredentialsSwap, string | undefined]>([
    ['at once, up before it', { late: false, wasUp: true }, undefined],
    ['at once, refused before it', { late: false, wasUp: false }, undefined],
    ['later, up before it', { late: true, wasUp: true }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    ['later, refused before it', { late: true, wasUp: false }, 'reconnected with its changed credentials and up again; its instance is kept'],
    ['at once, held for its claude_config_dir', { late: false, wasUp: true, held: true }, undefined],
    ['later, up before it and held for its claude_config_dir: held wins', { late: true, wasUp: true, held: true }, HELD_RECONNECTED],
    ['later, refused before it and held for its claude_config_dir: held wins', { late: true, wasUp: false, held: true }, HELD_RECONNECTED],
  ])('a swap %s: the swapped hook logs the reconnected line only for a late swap, worded by whether B is held, else by whether it was up before it', async (_label, swap, rest) => {
    const f = makeFixture({ changeResult: { kind: 'retrying', connection: 'kept' } })
    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    const before = f.lines.length

    f.changeCalls[0]!.hooks!.onSwapped!(swap)

    expect(f.lines.slice(before)).toEqual(rest === undefined ? [] : [lineOf(f, rest)])
  })

  test('forgetting the cached DM throws in the before-swap hook: one token-safe line, and the hook does not throw', async () => {
    const f = makeFixture({ fail: ['destinations.forget'] })

    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    expect(() => f.changeCalls[0]!.hooks!.beforeSwap!()).not.toThrow()

    expect(f.trail.at(-1)).toBe(`destinations.forget:${f.b.key}`)
    expect(f.lines.at(-1)).toMatch(
      new RegExp(`^${RegExp.escape(lineOf(f, 'forgetting its cached DM conversation failed: Error'))}( |$)`),
    )
    assertNoLeak({ lines: f.lines })
  })

  test('shutting down when the change starts (the flag set while it waited for B\'s turn): no change asked for; one line; it resolves skipped', async () => {
    let shuttingDown = false
    const f = makeFixture({ overrides: { isShuttingDown: () => shuttingDown } })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    shuttingDown = true
    blocker.resolve()
    await held

    expect(await done).toEqual({ kind: 'skipped' })
    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([lineOf(f, 'credentials change not applied — the server is shutting down')])
  })

  test('serialized per key: B\'s change waits behind an operation running for B; A\'s change does not', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    await f.lifecycle.reconnectCredentials(f.a, appliedAB(f))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`bringUps.changeCredentials:${f.a.key}:[${f.a.key},${f.b.key}]`])

    blocker.resolve()
    await held
    expect(await forB).toEqual({ kind: 'swapped' })
    expect(f.trail).toEqual([
      `bringUps.changeCredentials:${f.a.key}:[${f.a.key},${f.b.key}]`,
      `bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`,
    ])
    expect(f.submitted).toEqual([f.b.key, f.a.key])
  })

  test('a rejecting change rejects the operation (the apply\'s fan-out reports it) with no line of the lifecycle\'s own', async () => {
    const f = makeFixture({ fail: ['bringUps.changeCredentials'] })

    await expect(f.lifecycle.reconnectCredentials(f.b, appliedAB(f))).rejects.toThrow(/^step exploded with /)
    expect(f.lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Confirmed credentials changes over the real bring-up controller and
// connection manager (b.av2 SR-8.3, SR-8.6 step 4): the content held after
// superseded and late reconnects, the failed line's "kept" wording, and the
// results worded from B's state after the attempt. B is up on its original
// file (O); each rotation writes B's file with a new token pair registered
// as its own credential set, so each set's auth.test is scripted apart.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
/** A reconnect left retrying tries again after 5 s (the SR-3.2 schedule's first step). */
const FIRST_RETRY_MS = 5_000

interface CredentialsStack extends ControllerStack {
  /** Every hook call of the changes made through `change`, in order. */
  hookCalls: Array<'beforeSwap' | CredentialsSwap>
  /**
   * Write B's credentials file with a new token pair, registered as the
   * credential set `label` whose auth.test answers `authTest` in turn (then
   * ok); returns the digest of the file as written.
   */
  rotate(label: string, authTest?: WebApiOutcome[]): string
  /** The digest the controller holds for B (what detection compares the file with). */
  held(): string | undefined
  /** The controller's change of B, against the applied set, over the manager, with recording hooks. */
  change(): Promise<PersonaCredentialsChangeResult>
  /** A Web API call on B's current client refused with token_revoked: the manager marks B broken at once. */
  revokeCurrent(): Promise<void>
  /** The credential set B's own connection uses now (`INITIAL_CREDENTIALS` for O). */
  connectedWith(): string | undefined
  /** The controller's persona-credentials-change-failed lines. */
  changeFailedLines(): string[]
}

/**
 * `makeControllerStack` with A and B brought up on their original files: up,
 * unless `stubOptions` script B's original set otherwise.
 */
async function makeCredentialsStack(stubOptions?: ConnectionHarnessOptions['stubOptions']): Promise<CredentialsStack> {
  const stack = makeControllerStack({ stubOptions })
  const { h, controller, b } = stack
  for (const p of [stack.a, b]) await controller.bringUp(p, h.personas)
  expect(controller.state(b.key)?.outcome).toBe(stubOptions === undefined ? 'up' : 'retrying')
  const labels = [INITIAL_CREDENTIALS]
  const hookCalls: CredentialsStack['hookCalls'] = []
  const connectedWith = () =>
    labels.find((l) => h.slack.credentials(b.key, l).identity.botUserId === h.manager.identity(b.key)?.botUserId)
  return {
    ...stack,
    hookCalls,
    rotate(label, authTest = []) {
      const botToken = fakeToken(BOT_TOKEN_PREFIX, `${b.key}-${label}-bot`)
      const appToken = fakeToken(APP_TOKEN_PREFIX, `${b.key}-${label}-app`)
      h.slack.addCredentials(b.key, label, { botToken, appToken }, { leakMarker: LEAK_SENTINEL, authTest })
      writeCredentialsFile(dir, relative(dir, b.credentials_file), { bot_token: botToken, app_token: appToken })
      labels.push(label)
      return credentialsDigest(readCredentialsFile(b.credentials_file))
    },
    held: () => controller.credentialsDigest(b.key),
    change: () =>
      controller.changeCredentials(b, h.personas, h.manager, {
        beforeSwap: () => void hookCalls.push('beforeSwap'),
        onSwapped: (swap) => void hookCalls.push(swap),
      }),
    async revokeCurrent() {
      h.slack.credentials(b.key, connectedWith()!).script.reactionsAdd.push({ kind: 'platform', error: 'token_revoked' })
      await h.manager.webClient(b.key)!.reactions.add({ channel: b.channels[0]!.id, timestamp: '1700000000.000100', name: 'eyes' })
        .catch(() => undefined)
      expect(h.manager.status(b.key)).toMatchObject({ state: 'broken', phase: 'running' })
    },
    connectedWith,
    changeFailedLines: () => h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_CHANGE_FAILED}:`)),
  }
}

describe('the controller\'s credentials change (SR-8.3, SR-8.6 step 4): any refusal holds the content B\'s own connection uses', () => {
  const KEPT_CONNECTION = '; the current connection stays in use, and the change stays pending'
  const KEPT_BROKEN = '; it stays broken by its credentials, and the change stays pending'

  test('change A left retrying, then change B refused at once: B holds O again (not A), A\'s superseded reconnect never swaps, and one failed line says the current connection stays in use', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    const a = s.rotate('A', [{ kind: 'network' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    expect(s.held()).toBe(a)

    s.rotate('B', [{ kind: 'platform', error: 'invalid_auth' }])
    const got = await s.change()

    expect(got).toMatchObject({ kind: 'failed' })
    expect(s.held()).toBe(o)
    await s.h.clock.advance(HOUR_MS)
    expect(s.held()).toBe(o)
    expect(s.connectedWith()).toBe(INITIAL_CREDENTIALS)
    expect(s.h.slack.credentials(s.b.key, 'A').calls.authTest).toHaveLength(1)
    expect(s.hookCalls).toEqual([])
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    assertNoLeak({ lines: s.h.lines, got })
  })

  test('change A left retrying, then change B left retrying and refused later: B holds B while it retries, then O again, with one failed line; A never swaps', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    s.rotate('A', [{ kind: 'network' }])
    await s.change()
    const b = s.rotate('B', [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    expect(s.held()).toBe(b)
    expect(s.changeFailedLines()).toEqual([])

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.held()).toBe(o)
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    await s.h.clock.advance(HOUR_MS)
    expect(s.held()).toBe(o)
    expect(s.connectedWith()).toBe(INITIAL_CREDENTIALS)
    expect(s.hookCalls).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('change A left retrying swaps later, then change C refused at once: B holds A (what its connection now uses), not O', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A', [{ kind: 'network' }])
    await s.change()
    await s.h.clock.advance(FIRST_RETRY_MS)
    expect(s.connectedWith()).toBe('A')
    expect(s.hookCalls).toEqual(['beforeSwap', { late: true, wasUp: true }])

    s.rotate('C', [{ kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toMatchObject({ kind: 'failed' })

    expect(s.held()).toBe(a)
    expect(s.connectedWith()).toBe('A')
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B retrying its bring-up takes change A, comes up on it, then change C is refused at once: B holds A (what its connection uses), not O', async () => {
    const s = await makeCredentialsStack({ [NAME_B]: { authTest: [{ kind: 'network' }] } })
    const a = s.rotate('A')
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'none' })
    expect(s.held()).toBe(a)
    await s.h.clock.advance(FIRST_RETRY_MS)
    await flush()
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')

    s.rotate('C', [{ kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toMatchObject({ kind: 'failed' })

    expect(s.held()).toBe(a)
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A refused: the failed line says B stays broken by its credentials (not that its connection stays in use), and B holds O', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    const deferred = makeDeferredWebApiCall()
    s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle({ kind: 'platform', error: 'invalid_auth' })
    const got = await pending

    expect(got).toMatchObject({ kind: 'failed' })
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_BROKEN)])
    expect(s.changeFailedLines()[0]).not.toContain('the current connection stays in use')
    expect(s.held()).toBe(o)
    expect(s.controller.state(s.b.key)).toMatchObject({ outcome: 'broken', causes: { slack: { class: PERSONA_CREDENTIALS_REFUSED } } })
    assertNoLeak({ lines: s.h.lines, got })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A unreachable: retrying with connection \'broken\' and A held; A\'s later swap brings B up again (a late swap, not up before it) and the controller launches it', async () => {
    const s = await makeCredentialsStack()
    const deferred = makeDeferredWebApiCall()
    const a = s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle({ kind: 'network' })
    expect(await pending).toEqual({ kind: 'retrying', connection: 'broken' })
    expect(s.held()).toBe(a)
    expect(s.controller.state(s.b.key)?.outcome).toBe('broken')
    expect(s.launches).toEqual([])

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.hookCalls).toEqual(['beforeSwap', { late: true, wasUp: false }])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([s.b.key])
    expect(s.changeFailedLines()).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A swaps: swapped with cameBackUp, the swap reported as not up before it, A held, and the controller launches B', async () => {
    const s = await makeCredentialsStack()
    const deferred = makeDeferredWebApiCall()
    const a = s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle()
    expect(await pending).toEqual({ kind: 'swapped', cameBackUp: true })
    await flush()

    expect(s.hookCalls).toEqual(['beforeSwap', { late: false, wasUp: false }])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([s.b.key])
    assertNoLeak({ lines: s.h.lines })
  })

  test('a plain swap reports up before it and no cameBackUp: swapped, and nothing launched', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A')

    expect(await s.change()).toEqual({ kind: 'swapped' })
    await flush()

    expect(s.hookCalls).toEqual(['beforeSwap', { late: false, wasUp: true }])
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('change A left retrying, B\'s current connection then refused, and A refused later: B stays broken by its credentials with A held (nothing pending), logged as its refusal, not as a failed change', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A', [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    await s.revokeCurrent()
    const refusedBefore = s.h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_REFUSED}:`)).length

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.held()).toBe(a)
    expect(s.changeFailedLines()).toEqual([])
    expect(s.h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_REFUSED}:`))).toHaveLength(refusedBefore + 1)
    expect(s.controller.state(s.b.key)?.outcome).toBe('broken')
    assertNoLeak({ lines: s.h.lines })
  })
})

describe('credentials change over the real controller and manager: the DM forget before the swap, and the lines worded after the attempt', () => {
  /**
   * B up on O, with the manager's status reports for B recorded on the
   * lifecycle trail (`status:<state>`) beside the recorders, so the DM
   * forget's order against the swap's `up` report shows.
   */
  async function makeStatusStack(): Promise<CredentialsStack> {
    const s = await makeCredentialsStack()
    s.h.onStatus = (key, status) => {
      if (key === s.b.key) s.f.trail.push(`status:${status.state}`)
      s.controller.onConnectionStatus(key, status)
    }
    return s
  }
  const lineOf = (s: ControllerStack, rest: string) => `[slack] persona ${renderPersonaRef(s.b.name, s.b.key)}: ${rest}`

  // Rows: A's auth.test script, whether B's current connection is refused before A's retry, the lifecycle's line for the
  // operation's result and for a late swap (fragments after the persona prefix), and whether the controller launches B.
  test.each<[string, WebApiOutcome[], boolean, string, string | undefined, boolean]>([
    ['A swaps at once', [], false, 'reconnected with its changed credentials; its instance and MCP session are kept', undefined, false],
    ['A swaps later, B up meanwhile', [{ kind: 'network' }], false, 'the current one stays in use', 'reconnected with its changed credentials; its instance and MCP session are kept', false],
    ['A swaps later, B refused meanwhile', [{ kind: 'network' }], true, 'the current one stays in use', 'reconnected with its changed credentials and up again; its instance is kept', true],
  ])('%s: B\'s cached DM is forgotten right before the swap\'s up report (never at the operation\'s result), and the lines are worded by B\'s state then', async (_label, authTest, revoke, resultLine, lateLine, launched) => {
    const s = await makeStatusStack()
    s.rotate('A', authTest)

    await s.f.lifecycle.reconnectCredentials(s.b, { ...s.h.config!, personas: [s.a, s.b] })
    if (revoke) await s.revokeCurrent()
    await s.h.clock.advance(FIRST_RETRY_MS)
    await flush()

    const k = s.b.key
    // The forget comes right before the up report of the swap, and only once.
    expect(s.f.trail.filter((c) => c.startsWith('destinations.') || c === 'status:up')).toEqual([`destinations.forget:${k}`, 'status:up'])
    expect(s.connectedWith()).toBe('A')
    expect(s.f.lines).toHaveLength(lateLine === undefined ? 1 : 2)
    expect(s.f.lines[0]!.startsWith(lineOf(s, ''))).toBe(true)
    expect(s.f.lines[0]).toContain(resultLine)
    if (lateLine !== undefined) expect(s.f.lines[1]).toBe(lineOf(s, lateLine))
    expect(s.launches).toEqual(launched ? [k] : [])
    assertNoLeak({ lines: s.h.lines, lifecycle: s.f.lines })
  })

  test('step 6\'s recovery of B, broken by its credentials when step 4 ran, finds it up again (an earlier change\'s pending reconnect swapped meanwhile): the confirmed change C is applied as a credentials change, so B ends on C with no fresh bring-up', async () => {
    const s = await makeStatusStack()
    const applied = { ...s.h.config!, personas: [s.a, s.b] }
    // An earlier confirmed change A is left retrying; then B's own connection is refused.
    s.rotate('A', [{ kind: 'network' }])
    await s.f.lifecycle.reconnectCredentials(s.b, applied)
    await s.revokeCurrent()

    // A later confirmed change C: step 4 leaves B to step 6 ...
    const c = s.rotate('C')
    expect(await s.f.lifecycle.reconnectCredentials(s.b, applied)).toEqual({ kind: 'credentials-broken' })
    // ... and A's reconnect swaps before step 6 runs.
    await s.h.clock.advance(FIRST_RETRY_MS)
    expect(s.connectedWith()).toBe('A')
    await flush()
    const linesBefore = s.f.lines.length

    expect(await s.f.lifecycle.bringUp(s.b, applied, { recovery: true })).toEqual({ outcome: 'up', failures: [] })

    expect(s.connectedWith()).toBe('C')
    expect(s.held()).toBe(c)
    expect(s.f.lines.slice(linesBefore)).toEqual([
      expect.stringContaining('not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change'),
      lineOf(s, 'reconnected with its changed credentials; its instance and MCP session are kept'),
    ])
    // Not cleared or brought up afresh: no storage check or apply launch, and no second Slack bring-up of B.
    expect(s.f.trail.filter((entry) => /^(storageCheck|launch):/.test(entry))).toEqual([])
    expect(s.h.bringUpCalls.filter((call) => call.key === s.b.key)).toHaveLength(1)
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    assertNoLeak({ lines: s.h.lines, lifecycle: s.f.lines })
  })
})

// ---------------------------------------------------------------------------
// In-place update (SR-8.6, AC 58, apply step 3): the DM-cache forget and one
// line, under the serializer; nothing else about the persona is touched.
// ---------------------------------------------------------------------------

describe('in-place update (SR-8.6, AC 58): forget the cached DM when its destination settings changed, one line, nothing else', () => {
  /** The step-3 input for `p` with `settings` changed (`previous` is not read by the operation). */
  function change(p: Persona, settings: InPlaceSetting[]): InPlaceApplyInput {
    return { persona: p, previous: p, settings }
  }

  /** The exact update line for `p`, with the optional DM-cache suffix. */
  function updatedLine(p: Persona, settings: readonly InPlaceSetting[], suffix = ''): string {
    return (
      `[slack] persona ${renderPersonaRef(p.name, p.key)}: updated in place (${settings.join(', ')}); ` +
      `its instance, Slack connection and MCP session are kept${suffix}`
    )
  }

  const FORGOTTEN = '; its cached DM conversation is forgotten'

  /** A fixture with B still applied (an in-place update leaves it in the set). */
  function makeInPlaceFixture(opts: FixtureOptions = {}): Fixture {
    const f = makeFixture(opts)
    f.applied.push(f.b)
    return f
  }

  // Rows: the changed settings, and whether B's cached DM is forgotten (Director decision 11).
  test.each<[InPlaceSetting[], boolean]>([
    [['channels'], false],
    [['delivery'], false],
    [['channels', 'delivery'], false],
    [['permission_prompts'], true],
    [['dm.enabled'], true],
    [['dm.contact'], true],
    [['delivery', 'dm.contact'], true],
    [['channels', 'delivery', 'permission_prompts', 'dm.enabled', 'dm.contact'], true],
  ])('AC 58: %j changed: forgets B\'s cached DM only when a DM destination setting changed, logs one line, and touches no other state of B (no bring-up, retry, restart, connection, session, prompts, held notice or reply guard), live and in dry run alike', async (settings, forgets) => {
    for (const dryRun of [false, true]) {
      const f = makeInPlaceFixture({ dryRun })

      await expect(f.lifecycle.updateInPlace(change(f.b, settings))).resolves.toBeUndefined()

      expect(f.trail).toEqual(forgets ? [`destinations.forget:${f.b.key}`] : [])
      expect(f.lines).toEqual([updatedLine(f.b, settings, forgets ? FORGOTTEN : '')])
      expect(f.submitted).toEqual([f.b.key])
    }
  })

  test('forgetting the cached DM throws: the line carries the token-safe failure suffix instead, and the update still resolves', async () => {
    const f = makeInPlaceFixture({ fail: ['destinations.forget'] })

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([`destinations.forget:${f.b.key}`])
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0]).toMatch(
      new RegExp(`^${RegExp.escape(updatedLine(f.b, ['dm.contact'], '; forgetting its cached DM conversation failed: Error'))}( |$)`),
    )
    expect(f.lines[0]).not.toContain(FORGOTTEN)
    assertNoLeak({ lines: f.lines })
  })

  test('a key no longer applied when the update runs (removed by a later apply): nothing is forgotten and no line is logged', async () => {
    const f = makeFixture() // applied: [A]

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('the applied set is read when the update runs, not when it was submitted: B leaving it while the update waits for B\'s turn gets nothing', async () => {
    const f = makeInPlaceFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))
    f.applied.splice(f.applied.indexOf(f.b), 1)
    blocker.resolve()
    await held
    await done

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([])
  })

  test('reading the applied set throws: one token-safe failure line, nothing forgotten, and the update resolves (no rejection)', async () => {
    const f = makeInPlaceFixture({ overrides: { appliedPersonas: () => { throw failure() } } })

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([])
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0]).toMatch(
      new RegExp(`^${RegExp.escape(`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: in-place update failed: Error`)}( |$)`),
    )
    assertNoLeak({ lines: f.lines })
  })

  test('serialized per key: B\'s update waits behind an operation running for B; A\'s update does not', async () => {
    const f = makeInPlaceFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))
    await f.lifecycle.updateInPlace(change(f.a, ['dm.enabled']))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`destinations.forget:${f.a.key}`])
    expect(f.lines).toEqual([updatedLine(f.a, ['dm.enabled'], FORGOTTEN)])

    blocker.resolve()
    await held
    await forB
    expect(f.trail).toEqual([`destinations.forget:${f.a.key}`, `destinations.forget:${f.b.key}`])
    expect(f.lines).toEqual([updatedLine(f.a, ['dm.enabled'], FORGOTTEN), updatedLine(f.b, ['dm.contact'], FORGOTTEN)])
    expect(f.submitted).toEqual([f.b.key, f.a.key])
  })

  describe('over the real destination resolver (makeNotifierHarness): the next DM notice after the update', () => {
    // Rows: the changed settings (B's DM contact itself unchanged), and how many opens B's two notices make.
    test.each<[InPlaceSetting[], number]>([
      [['channels', 'delivery'], 1],
      [['dm.enabled'], 2],
      [['permission_prompts'], 2],
    ])('%j changed: B\'s next DM notice makes %i conversations.open in all, and both notices post to the opened DM through B\'s own client', async (settings, opens) => {
      const config = makeConfig()
      const [a, b0] = config.personas as [Persona, Persona]
      const b: Persona = { ...b0, dm: { enabled: true, contact: 'U0BETA001' }, permission_prompts: 'dm' }
      const h = makeNotifierHarness({ personas: [a, b] })
      cleanups.push(() => h.hold.cancelAll())
      const f = makeFixture({ overrides: { destinations: h.destinations } })
      f.applied.splice(0, f.applied.length, a, b)

      await h.notifier.notify(b.key, 'first notice')
      await f.lifecycle.updateInPlace(change(b, settings))
      await h.notifier.notify(b.key, 'second notice')

      const stubB = h.stub(b.key)
      expect(stubB.calls.conversationsOpen).toHaveLength(opens)
      for (const args of stubB.calls.conversationsOpen) expect(args).toMatchObject({ users: 'U0BETA001' })
      const posts = h.posts(b.key)
      expect(posts).toHaveLength(2)
      expect(posts[0]!.channel).toMatch(/^D/)
      expect(posts[1]!.channel).toBe(posts[0]!.channel)
      expect(h.posts(a.key)).toEqual([])
      expect(h.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: f.lines, logs: h.logs, posts: h.allPosts() })
    })
  })
})

// ---------------------------------------------------------------------------
// Template refresh (SR-8.6 step 5) through the lifecycle: its dependencies
// passed through, not serialized. The refresh itself (the `allow`
// replacement, the exact lines, token safety, a rejection) is pinned in
// agent-director-template.test.ts.
// ---------------------------------------------------------------------------

describe('template refresh (SR-8.6 step 5) through the lifecycle: the start-time template and client passed through; not serialized', () => {
  /** The applied config: B alone, whose own config dir gives the only rule (no default dir, so no home is read). */
  const appliedOf = (f: Fixture): PersonaConfig => ({ ...f.config, personas: [f.b] })

  test.each<[string, boolean]>([['live', false], ['dry run', true]])('%s: one makeTemplate call through templateRefresh.getClient with templateRefresh.installed\'s fields; its line goes to deps.log; no persona operation', async (_label, dryRun) => {
    const f = makeFixture({ dryRun })

    const result = await f.lifecycle.refreshTemplate(appliedOf(f))

    expect(result).toEqual({ kind: 'refreshed', path: expect.stringMatching(/slack-channel-bot\.toml$/) })
    expect(f.templateCalls).toEqual([{ ...INSTALLED_TEMPLATE, allow: expect.any(Array), overwrite: true }])
    expect(f.lines).toEqual([expect.stringMatching(/^\[slack\] template refresh: rewrote /)])
    expect(f.trail).toEqual([])
    expect(f.submitted).toEqual([])
  })

  test('not serialized: it resolves while an operation holds A\'s and B\'s turns', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = [f.serializer.run(f.a.key, () => blocker.promise), f.serializer.run(f.b.key, () => blocker.promise)]

    const done = f.lifecycle.refreshTemplate(appliedOf(f))
    expect(await settled(done)).toBe(true)
    expect(f.templateCalls).toHaveLength(1)

    blocker.resolve()
    await Promise.all(held)
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
      // A is still applied (the old half of a destructive modify): its early cancels and second notice drop.
      ...stillAppliedTeardownTrail(f.a, `${JSON.stringify([f.a.claude_config_dir, undefined])}:[${f.a.key}]`),
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
    function initRestartFor(f: Fixture, launch: () => Promise<boolean>, up: () => boolean = () => true, delaySeconds = 0.001): void {
      initRestart({
        canRestart: (key) => { f.trail.push(`restart.canRestart:${key}`); return up() },
        isSessionAlive: async () => false,
        isSessionConnected: () => false,
        hasSessionStream: () => true,
        reconnectSession: async () => undefined,
        killSession: async () => undefined,
        launchSession: async (key) => { f.trail.push(`restart.launchSession:${key}`); return launch() },
        getRestartDelay: () => delaySeconds,
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
    // Rows: whether B is still applied (a destructive modify's old half) or removed, and whether its
    // restart timer is still pending once the teardown is submitted and before its turn.
    test.each<[string, boolean, boolean]>([
      ['still applied: cancelled at submit, before its turn', true, false],
      ['removed: left for its turn (the relaunch gate refuses its work anyway)', false, true],
    ])('B\'s pending restart timer, with B %s', async (_label, stillApplied, pendingBeforeTurn) => {
      const f = makeFixture({ overrides: { cancelRestartTimer } })
      if (stillApplied) f.applied.push(f.b)
      initRestartFor(f, async () => true, () => true, 60) // a timer that never fires in the test
      scheduleRestart(f.b.key, '/cwd/b')
      expect(isRestartPendingOrActive(f.b.key)).toBe(true)
      const blocker = Promise.withResolvers<void>()
      const held = f.serializer.run(f.b.key, () => blocker.promise)

      const done = f.lifecycle.teardown(f.b)
      await flush()
      expect(isRestartPendingOrActive(f.b.key)).toBe(pendingBeforeTurn)
      expect(f.lines).toEqual([])

      blocker.resolve()
      await held
      await done
      expect(isRestartPendingOrActive(f.b.key)).toBe(false)
      expect(restartOnly(f)).toEqual([`restart.canRestart:${f.b.key}`])
    })
  })

  describe('behind a bring-up retry (real bring-up controller over the real connection manager)', () => {
    /**
     * `makeControllerStack` with both brought up; B's first auth.test fails
     * (network), so B is retrying its Slack bring-up.
     */
    async function makeRetry(opts: { launch?: (p: Persona) => Promise<unknown>; whenLaunchSettled?: PersonaLifecycleDeps['whenLaunchSettled'] } = {}): Promise<ControllerStack> {
      const stack = makeControllerStack({
        stubOptions: { [NAME_B]: { authTest: [{ kind: 'network' }] } },
        launch: opts.launch,
        overrides: opts.whenLaunchSettled ? { whenLaunchSettled: opts.whenLaunchSettled } : {},
      })
      for (const p of [stack.a, stack.b]) await stack.controller.bringUp(p, stack.h.personas)
      expect(stack.controller.state(stack.b.key)?.outcome).toBe('retrying')
      return stack
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

    test('the old half of a destructive modify (B still applied): B\'s Slack retry comes up while B\'s turn is held, and its launch, queued ahead of the teardown, launches nothing, since the teardown cancelled B\'s bring-up at submit', async () => {
      const r = await makeRetry()
      const blocker = Promise.withResolvers<void>()
      const held = r.f.serializer.run(r.b.key, () => blocker.promise)
      await r.h.clock.advance(5_000) // B's retry comes up: its launch waits behind the blocker
      expect(r.h.manager.status(r.b.key)).toMatchObject({ state: 'up' })
      expect(r.launches).toEqual([])

      r.f.applied.push(r.b) // B's key stays applied (its new declaration is brought up at step 6)
      const done = r.f.lifecycle.teardown(r.b)
      await flush()
      expect(r.controller.state(r.b.key)).toBeUndefined()

      blocker.resolve()
      await held
      await done
      await r.h.clock.advance(3_600_000)

      expect(r.launches).toEqual([])
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.a.key)).toMatchObject({ state: 'up' })
      expect(r.h.clock.pendingCount()).toBe(0)
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
