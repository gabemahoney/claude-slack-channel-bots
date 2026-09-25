/**
 * reload-wiring.test.ts — Static audit of the reload detection tick's wiring
 * in src/server.ts (b.av2 SR-8.2, SR-8.3, SR-7.2).
 *
 * SR-8.2: one serialized, self-re-arming 5 s timer (no file watcher) reads
 * config.json and, unless in dry run, every credentials file it references,
 * and keeps config.json.pending in step. It starts when the start's bring-up
 * pass returns, like the health check. SR-8.3: a credentials change is pending
 * only against the digest a persona connected, retried or broke with, which
 * the bring-up controller holds; SR-8.6 step 6: the preview reads the
 * bring-up controller's state to tell a persona broken by its credentials
 * from one to reconnect; SR-8.6 step 1: `onApplied` swaps the server's
 * applied config to the confirmed persona set over the start-time
 * server-wide values. These assertions fail if main() arms the timer
 * before the start bring-up returns (or before the refused-start exit), from
 * more than one call site or not at all; if shutdown() stops calling it off;
 * or if the controller is built with anything but the production tick driver,
 * `isDryRun()` and the bring-up controller's held digests and states, or is
 * passed a file watcher.
 *
 * SR-6.5 / SR-6.1 / SR-6.6 (E12 Task 2): a confirmed apply's teardowns (step
 * 2) and bring-ups (step 6) are the controller's default fan-out over its
 * lifecycle members `teardown` and `bringUp`; its in-place updates (step 3,
 * E12 Task 3) over `updateInPlace`; its credentials reconnects (step 4, E13
 * Task 1) over `reconnectCredentials`, and the recovery of a
 * credentials-broken persona (step 6, SR-6.4) over `bringUp` with its
 * `recovery` option. The audit pins that production binds all four, every
 * argument forwarded, to the one `PersonaLifecycle` main() composes with
 * `createPersonaLifecycle` (declared before the controller, assigned once
 * after the bring-up controller exists and before detection is armed), passes
 * no `applySteps` override (which would replace that fan-out), and that the
 * restart timers, the connection manager (the deferred socket close after a
 * Web API auth error, b.ujn), the bring-up retries and the lifecycle share
 * one per-persona serializer. What the default step bodies do with those members
 * is tested in tests/reload-apply.test.ts; what the teardown, the apply
 * bring-up and the in-place update do is tested behaviourally against
 * `createPersonaLifecycle`.
 *
 * AC 58 (SR-8.6 step 3): an in-place change takes effect from the next event
 * or post because its consumers read the applied config holder `onApplied`
 * reassigns, at call time. The audit pins the consumers no other audit
 * covers: the persona routing's `getPersonaConfig`, the by-key lookup
 * `getAppliedPersona`, and the notifier's and the MCP tools' `getPersona`
 * (the event router's, the permission poller's and the destination hold's
 * are pinned in tests/permission-relay-wiring.test.ts).
 *
 * What the timer and the tick do is tested behaviourally in
 * tests/reload-timer.test.ts and tests/reload.test.ts. Only the wiring that
 * cannot be driven by a behaviour test is audited here: main() cannot run in
 * a unit test (the agent-director startup gate, a real port, real Slack
 * connections). This follows tests/cron-scheduler-wiring.test.ts and
 * tests/start-sweep-wiring.test.ts: it reads the source with comments
 * stripped and anchors on content, never on line numbers. It reads no file
 * but src/server.ts and touches no home directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  atMainTopLevel,
  balancedAfter,
  callsOf,
  importSource,
  indicesOf,
  insideMain,
  loadedConfigName,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
  splitTopLevel,
  startResolution,
  stripComments,
} from './test-helpers/source-audit.ts'

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync('src/server.ts', 'utf-8'))

/** Every call of `method`, on any receiver or none (`x.m(`, `x?.m(`, `x!.m(`, `m(`). */
function anyCallOf(method: string): number[] {
  return indicesOf(new RegExp(`(?<![\\w$])${method}\\s*\\(`, 'g'), SERVER_CODE)
}

/** The one call of `method` in the code, with its receiver; throws unless there is exactly one call of it. */
function onlyMethodCall(method: string): { at: number; receiver: string } {
  const all = anyCallOf(method)
  if (all.length !== 1) throw new Error(`expected exactly one call of ${method}, found ${all.length}`)
  const m = [...SERVER_CODE.matchAll(new RegExp(`\\b(\\w+)\\s*[?!]?\\.\\s*(${method})\\s*\\(`, 'g'))]
  if (m.length !== 1) throw new Error(`expected ${method} to be called as <receiver>.${method}()`)
  return { at: m[0]!.index! + m[0]![0].lastIndexOf(method), receiver: m[0]![1]! }
}

/** The top-level properties of the `createReloadController({ … })` argument. */
function controllerProps(): Map<string, string> {
  return objectProperties(onlyCallArguments(SERVER_CODE, 'createReloadController'))
}

/** Offsets of every plain assignment `<name> = <value>` (not `==`, not a declaration's type). */
function assignmentsOf(name: string, value: string): number[] {
  return indicesOf(new RegExp(`(?<![\\w.$])${name}\\s*=(?![=>])\\s*${value}\\b`, 'g'), SERVER_CODE)
}

/**
 * The receiver of the controller option `prop`, which must be exactly
 * `(key) => <receiver>?.<method>(key)` (the same parameter passed through,
 * nothing else in the body); fails the test otherwise.
 */
function bringUpLookup(props: Map<string, string>, prop: string, method: string): string {
  const arrow = (props.get(prop) ?? '').match(
    new RegExp(`^\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*(\\w+)\\s*[?!]?\\.\\s*${method}\\s*\\(\\s*(\\w+)\\s*\\)$`),
  )
  expect(arrow).not.toBeNull()
  expect(arrow![3]).toBe(arrow![1])
  return arrow![2]!
}

/**
 * `receiver` is the one bring-up controller main() builds, or the
 * module-scope handle main() sets to it once, before detection is armed.
 */
function expectBringUpControllerHandle(receiver: string): void {
  const bringUpDecl = [...SERVER_CODE.matchAll(/\bconst\s+(\w+)\s*=\s*createPersonaBringUpController\s*\(/g)]
  expect(bringUpDecl).toHaveLength(1)
  const bringUpController = bringUpDecl[0]![1]!
  if (receiver === bringUpController) return
  const handoffs = assignmentsOf(receiver, bringUpController).filter((a) => insideMain(SERVER_CODE, a))
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0]!).toBeLessThan(onlyMethodCall('startDetection').at)
}

/**
 * Where the statement holding the start bring-up call ends: past the whole
 * `try { … } catch … { … } finally { … }` when the call sits in a try block,
 * else the call itself.
 */
function endOfBringUpStatement(bringUpAt: number): number {
  // The innermost try block around the call, if any.
  for (const at of indicesOf(/\btry\s*\{/g, SERVER_CODE).filter((t) => t < bringUpAt).reverse()) {
    let [, end] = balancedAfter(SERVER_CODE, at, '{', '}')
    if (end < bringUpAt) continue
    for (;;) {
      const clause = SERVER_CODE.slice(end + 1).match(/^\s*(?:catch|finally)\b/)
      if (!clause) return end
      ;[, end] = balancedAfter(SERVER_CODE, end + 1 + clause[0].length, '{', '}')
    }
  }
  return bringUpAt
}

/**
 * The start-time applied config the controller's `onApplied` spreads. Its
 * body must be exactly a guard that throws while that config is still unset,
 * then the swap `<loaded> = { ...<start-time>, personas: <applied>.personas }`;
 * fails the test otherwise.
 */
function startTimeConfig(): string {
  const { loaded } = startResolution(SERVER_CODE)
  const onApplied = (controllerProps().get('onApplied') ?? '').replace(/\s+/g, ' ')
  const swap = onApplied.match(
    new RegExp(
      `^\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\\{\\s*` +
        `if\\s*\\(\\s*(\\w+)\\s*===\\s*undefined\\s*\\)\\s*throw\\s+new\\s+Error\\s*\\(\\s*'[^']*'\\s*\\)\\s*;?\\s*` +
        `${loaded}\\s*=\\s*\\{\\s*\\.\\.\\.\\2\\s*,\\s*personas\\s*:\\s*\\1\\s*\\.\\s*personas\\s*,?\\s*\\}\\s*;?\\s*\\}$`,
    ),
  )
  expect(swap).not.toBeNull()
  return swap![2]!
}

describe('server.ts wires the reload detection tick (b.av2 SR-8.2)', () => {
  test('starts detection from exactly one call site: the start controller\'s startDetection(), inside main()', () => {
    const { controller } = startResolution(SERVER_CODE)
    const { at, receiver } = onlyMethodCall('startDetection')
    expect(receiver).toBe(controller)
    expect(insideMain(SERVER_CODE, at)).toBe(true)
  })

  test('arms detection only after the start bring-up call returns, and after the refused-start exit', () => {
    // A refused start exits before `<loaded> = <outcome>.config` (pinned in
    // tests/server-startup-wiring.test.ts), so a call after that assignment is
    // never reached on a refused start.
    const { assignAt, bringUpAt } = startResolution(SERVER_CODE)
    const { at } = onlyMethodCall('startDetection')
    expect(at).toBeGreaterThan(assignAt)
    expect(at).toBeGreaterThan(bringUpAt)
    // Outside the try/catch around the bring-up: a pass that throws is logged
    // and the start continues, so detection is still armed.
    expect(at).toBeGreaterThan(endOfBringUpStatement(bringUpAt))
  })

  test('arms detection after the health check starts, like it', () => {
    const { at } = onlyMethodCall('startDetection')
    const healthStarts = callsOf(SERVER_CODE, 'startHealthCheck').filter((h) => insideMain(SERVER_CODE, h))
    expect(healthStarts.length).toBeGreaterThan(0)
    for (const h of healthStarts) expect(at).toBeGreaterThan(h)
  })

  test('shutdown() stops detection, on the handle main() sets to the controller it arms', () => {
    const [start, end] = shutdownBody(SERVER_CODE)
    const { at, receiver } = onlyMethodCall('stopDetection')
    expect(at).toBeGreaterThan(start)
    expect(at).toBeLessThan(end)
    // The receiver shutdown() reads is the module-scope handle main() sets to
    // the start's controller before arming detection, so a shutdown after the
    // timer starts always reaches it.
    const { controller } = startResolution(SERVER_CODE)
    const handoffs = assignmentsOf(receiver, controller).filter((a) => insideMain(SERVER_CODE, a))
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!).toBeLessThan(onlyMethodCall('startDetection').at)
  })

  test('the controller gets the production tick driver, dryRun: isDryRun() and the bring-up controller\'s held credentials digests', () => {
    const props = controllerProps()
    // The whole value is one createReloadTickDriver({ … }) call.
    const driver = props.get('tickDriver') ?? ''
    expect(driver).toMatch(/^createReloadTickDriver\s*\(/)
    expect(balancedAfter(driver, 0, '(', ')')[1]).toBe(driver.length - 1)
    expect(props.get('dryRun')).toBe('isDryRun()')
    expectBringUpControllerHandle(bringUpLookup(props, 'heldCredentialsDigest', 'credentialsDigest'))
  })

  // SR-8.6 step 6: the preview tells a persona broken by its credentials
  // (brought up at apply) from one that is reconnected. Without this binding
  // every credentials change would preview as a reconnect.
  test('the controller gets the bring-up controller\'s states, on the same handle as its held digests', () => {
    const props = controllerProps()
    const receiver = bringUpLookup(props, 'bringUpState', 'state')
    expectBringUpControllerHandle(receiver)
    expect(receiver).toBe(bringUpLookup(props, 'heldCredentialsDigest', 'credentialsDigest'))
  })

  // SR-8.6 step 1: once the record holds a confirmed change, the server runs
  // its persona set, with the server-wide values it started with (they apply
  // at the next start). `onApplied` is optional in the controller's deps, so
  // only this audit makes sure production binds it; every consumer of the
  // applied set (the bring-up controller's appliedPersonas, routing, the
  // reply guard, the health work list) reads the holder it reassigns.
  test('the controller\'s onApplied swaps the applied config holder to the confirmed persona set over the start-time server-wide values', () => {
    const { loaded, assignAt, createAt } = startResolution(SERVER_CODE)
    // The spread is the start-time config: declared once, inside main(),
    // before the controller whose onApplied closes over it (no temporal dead
    // zone), and assigned once, from the holder, after the start resolution
    // set it and before detection is armed (the only point after which
    // onApplied can run).
    const startTime = startTimeConfig()
    const decls = [...SERVER_CODE.matchAll(new RegExp(`\\b(?:let|const|var)\\s+${startTime}\\b[^\\n]*`, 'g'))]
    expect(decls.map((d) => d[0].trim())).toEqual([`let ${startTime}!: PersonaConfig`])
    expect(insideMain(SERVER_CODE, decls[0]!.index!)).toBe(true)
    expect(decls[0]!.index!).toBeLessThan(createAt)
    const assignments = [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$])${startTime}\\s*=(?![=>])\\s*([^\\n;]*)`, 'g'))]
    expect(assignments.map((a) => a[1]!.trim())).toEqual([loaded])
    const at = assignments[0]!.index!
    expect(insideMain(SERVER_CODE, at)).toBe(true)
    expect(at).toBeGreaterThan(assignAt)
    expect(at).toBeLessThan(onlyMethodCall('startDetection').at)
  })

  // SR-8.2: no file watcher. Only the controller's own options are audited, so
  // unrelated server code is free to use fs.watch; that the driver chains
  // timeouts rather than an interval is tested in tests/reload-timer.test.ts.
  test('the controller is passed no file watcher, and its tickDriver is the one production driver built', () => {
    const props = controllerProps()
    expect([...props.keys()].filter((key) => /watch/i.test(key))).toEqual([])
    for (const value of props.values()) expect(value).not.toMatch(/\b(?:watch|watchFile)\s*\(|\bFSWatcher\b|['"]chokidar['"]/)
    // The one driver built is inside the controller's options, where the
    // tickDriver test above pins it as the tickDriver value.
    expect(props.get('tickDriver')).toMatch(/^createReloadTickDriver\s*\(/)
    const drivers = anyCallOf('createReloadTickDriver')
    expect(drivers).toHaveLength(1)
    const [optionsStart, optionsEnd] = balancedAfter(SERVER_CODE, callsOf(SERVER_CODE, 'createReloadController')[0]!, '(', ')')
    expect(drivers[0]!).toBeGreaterThan(optionsStart)
    expect(drivers[0]!).toBeLessThan(optionsEnd)
  })

  test('reload output goes to the server log: the controller\'s and the tick driver\'s log is console.error, never Slack (SR-7.2)', () => {
    const toServerLog = /^\(?\s*(\w+)\s*\)?\s*=>\s*console\s*\.\s*error\s*\(\s*\1\s*\)$/
    expect(controllerProps().get('log')).toMatch(toServerLog)
    const driverProps = objectProperties(onlyCallArguments(SERVER_CODE, 'createReloadTickDriver'))
    expect(driverProps.get('log')).toMatch(toServerLog)
  })
})

// ---------------------------------------------------------------------------
// The confirmed apply's teardown and bring-up (b.av2 SR-6.1, SR-6.5, SR-6.6)
// ---------------------------------------------------------------------------

/** The top-level properties of the argument of the only call of the plain function `name`. */
function onlyCallProps(name: string): Map<string, string> {
  return objectProperties(onlyCallArguments(SERVER_CODE, name))
}

/** The name the one `const <name> = <factory>(…)` binds; fails unless there is exactly one. */
function constOf(factory: string): string {
  const decls = [...SERVER_CODE.matchAll(new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${factory}\\s*\\(`, 'g'))]
  expect(decls).toHaveLength(1)
  return decls[0]![1]!
}

/**
 * The controller's lifecycle member `member`, which must be exactly
 * `(<p1>, …, <pn>) => <holder>.<member>(<p1>, …, <pn>)` with `arity`
 * parameters, each passed through unchanged and in order (none dropped,
 * reordered or replaced); fails the test otherwise. Returns the holder.
 */
function forwardingHolder(lifecycle: Map<string, string>, member: string, arity: number): string {
  const params = Array.from({ length: arity }, () => '\\s*(\\w+)\\s*').join(',')
  const paramList = arity === 1 ? `\\(?${params}\\)?` : `\\(${params}\\)`
  const arrow = (lifecycle.get(member) ?? '').match(
    new RegExp(`^${paramList}\\s*=>\\s*(\\w+)\\s*\\.\\s*${member}\\s*\\(${params}\\)$`),
  )
  expect([member, arrow]).not.toEqual([member, null])
  expect([member, arrow!.slice(arity + 2)]).toEqual([member, arrow!.slice(1, arity + 1)])
  return arrow![arity + 1]!
}

/**
 * The lifecycle holder the controller's `teardown`, `updateInPlace`,
 * `reconnectCredentials` and `bringUp` members forward to (see the first test
 * below).
 */
function lifecycleHolder(): string {
  const lifecycle = objectProperties(controllerProps().get('lifecycle') ?? '')
  const teardown = forwardingHolder(lifecycle, 'teardown', 1)
  // All four on the same holder. bringUp forwards its third parameter, the
  // options carrying `recovery` (SR-8.6 step 6, SR-6.4): a binding that drops
  // it typechecks, but would bring a credentials-broken persona up as new.
  expect(forwardingHolder(lifecycle, 'updateInPlace', 1)).toBe(teardown)
  expect(forwardingHolder(lifecycle, 'reconnectCredentials', 2)).toBe(teardown)
  expect(forwardingHolder(lifecycle, 'bringUp', 3)).toBe(teardown)
  return teardown
}

describe('server.ts binds the confirmed apply\'s teardown, in-place update, credentials change and bring-up (b.av2 SR-6.1, SR-6.4, SR-6.5, SR-6.6, SR-8.6 steps 3, 4 and 6)', () => {
  // ReloadLifecycleOps.teardown, .updateInPlace, .reconnectCredentials and
  // .bringUp are required, so the typecheck catches a missing member; it
  // cannot catch one bound to something that does nothing, to another
  // member, or one that drops an optional argument. Without these bindings a
  // confirmed removal would leave the persona's connection, session and
  // instance running, a confirmed addition would never come up, a confirmed
  // routing change would be recorded as applied while the persona's cached
  // DM conversation stayed and no line was logged, a rotated token would
  // never reach the persona's connection, and a credentials-broken persona
  // would never recover.
  test('the controller\'s lifecycle members teardown, updateInPlace, reconnectCredentials and bringUp (with its options) forward their arguments to one lifecycle holder, beside the start bring-up', () => {
    const lifecycle = objectProperties(controllerProps().get('lifecycle') ?? '')
    expect([...lifecycle.keys()].sort()).toEqual(['bringUp', 'reconnectCredentials', 'startBringUp', 'teardown', 'updateInPlace'])
    expect(lifecycleHolder()).toMatch(/^\w+$/)
  })

  test('the holder is declared once, typed PersonaLifecycle, before the controller that closes over it', () => {
    const holder = lifecycleHolder()
    const decls = [...SERVER_CODE.matchAll(new RegExp(`\\b(?:let|const|var)\\s+${holder}\\b[^\\n]*`, 'g'))]
    expect(decls).toHaveLength(1)
    // `let`: it is assigned once the bring-up controller exists (next test).
    expect(decls[0]![0]).toMatch(new RegExp(`^let\\s+${holder}\\s*!?\\s*:\\s*PersonaLifecycle\\b`))
    expect(decls[0]!.index!).toBeLessThan(startResolution(SERVER_CODE).createAt)
  })

  test('the holder is assigned once, unconditionally, from the one createPersonaLifecycle({ … }), after `bringUps = <bring-up controller>` and before detection is armed', () => {
    const holder = lifecycleHolder()
    const assigns = [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$])${holder}\\s*=(?![=>])\\s*(\\w+)\\s*\\(`, 'g'))]
    expect(assigns.map((a) => a[1])).toEqual(['createPersonaLifecycle'])
    // Nothing else writes the holder (a compound or bare assignment of another shape).
    expect(indicesOf(new RegExp(`(?<![\\w.$])${holder}\\s*(?:[-+*/|&?]{1,2})?=(?![=>])`, 'g'), SERVER_CODE)).toEqual([assigns[0]!.index!])
    const at = assigns[0]!.index!
    // The one construction is this assignment's value.
    const creates = callsOf(SERVER_CODE, 'createPersonaLifecycle')
    expect(creates).toHaveLength(1)
    expect(creates[0]!).toBe(at + assigns[0]![0].lastIndexOf('createPersonaLifecycle'))
    // On every start, dry run included: in main()'s own statement list.
    expect(atMainTopLevel(SERVER_CODE, at)).toBe(true)
    // Its bring-up controller exists (the handle the manager's status listener reads is set)…
    const handoffs = assignmentsOf('bringUps', constOf('createPersonaBringUpController')).filter((a) => insideMain(SERVER_CODE, a))
    expect(handoffs).toHaveLength(1)
    expect(at).toBeGreaterThan(handoffs[0]!)
    // …and it is set before the first point an apply can run.
    expect(at).toBeLessThan(onlyMethodCall('startDetection').at)
  })

  test('no applySteps override: the controller runs its default fan-out over the lifecycle members', () => {
    // applySteps replaces the whole step 2–6 fan-out (tests only); passed in
    // production it would bypass the teardown and bring-up bound above.
    expect(controllerProps().has('applySteps')).toBe(false)
    expect(indicesOf(/\bapplySteps\b/g, SERVER_CODE)).toEqual([])
  })

  // The connection manager's serialize (b.ujn) is optional in its deps and
  // defaults to running the close at once, so only this audit makes sure
  // production passes it: without it, the deferred close of a socket whose
  // Web API call was refused for its token would not wait behind a lifecycle
  // operation holding the persona.
  test('one per-persona serializer, built once at module scope: its run is the serialize of initRestart, the connection manager, the bring-up controller and the lifecycle, and is used nowhere else', () => {
    const serializer = constOf('createPersonaSerializer')
    expect(callsOf(SERVER_CODE, 'createPersonaSerializer')).toHaveLength(1)
    const decl = SERVER_CODE.search(new RegExp(`^const\\s+${serializer}\\s*=\\s*createPersonaSerializer\\s*\\(\\s*\\)\\s*$`, 'm'))
    expect(decl).toBeGreaterThanOrEqual(0)
    expect(insideMain(SERVER_CODE, decl)).toBe(false)
    const factories = ['initRestart', 'createPersonaConnectionManager', 'createPersonaBringUpController', 'createPersonaLifecycle']
    for (const factory of factories) {
      expect([factory, onlyCallProps(factory).get('serialize')]).toEqual([factory, `${serializer}.run`])
    }
    // Beyond its declaration, the serializer is named only in those values.
    expect(indicesOf(new RegExp(`(?<![\\w.$])${serializer}\\b`, 'g'), SERVER_CODE)).toHaveLength(1 + factories.length)
  })

  // Every dependency is required, so the typecheck catches a missing one; it
  // cannot catch one bound to a stub (`() => undefined`, `async () => {}`) or
  // two same-typed ones swapped (killInstance/deleteInstance). Each value is
  // pinned to the production function or object it must be.
  test('createPersonaLifecycle gets every production dependency: nothing stubbed, nothing swapped, nothing extra', () => {
    const props = onlyCallProps('createPersonaLifecycle')
    const loaded = loadedConfigName(SERVER_CODE)
    const notifier = constOf('createPersonaNotifier')

    // The same per-persona queue as restarts and bring-up retries (test above).
    const expected = new Map<string, string>([
      ['serialize', `${constOf('createPersonaSerializer')}.run`],
      // The server's own instances, whose states, held tokens and live
      // connections the credentials change and the recovery act on
      // (`state`, `changeCredentials`; `reconnectCredentials`,
      // `replaceRetryTokens`): a separate instance would type-check but
      // change nothing the server serves.
      ['bringUps', constOf('createPersonaBringUpController')],
      ['connections', constOf('createPersonaConnectionManager')],
      ['routing', constOf('createPersonaRouting')],
      ['destinations', constOf('createPersonaDestinations')],
      ['destinationHold', constOf('createPersonaDestinationHold')],
      ['notifier', notifier],
      // The live applied set, read at call time.
      ['appliedPersonas', `() => ${loaded}?.personas ?? []`],
      // Dry run: the teardown makes no agent-director call.
      ['dryRun', 'isDryRun()'],
      ['isShuttingDown', '() => shuttingDown'],
      ['whenLaunchSettled', 'whenLaunchSettled'],
      ['cancelRestartTimer', 'cancelRestartTimer'],
      ['forgetFailures', 'forgetFailures'],
      ['forgetDisconnectedStreak', 'forgetDisconnectedStreak'],
      // The silent per-key reset (never the boot reset of every persona).
      ['resetOutageState', 'resetAllToHealthy'],
      ['forgetPersonaPrompts', 'forgetPersonaPrompts'],
      ['dropSession', 'dropPersonaSessionAndKeepAlive'],
      ['killInstance', 'killPersonaInstance'],
      ['deleteInstance', 'deletePersonaInstance'],
    ])
    // Functions and objects with a parameter name of the source's choosing.
    const shaped = ['log', 'replyGuard', 'storageCheck', 'launch']
    expect([...props.keys()].sort()).toEqual([...expected.keys(), ...shaped].sort())
    for (const [dep, value] of expected) expect([dep, props.get(dep)]).toEqual([dep, value])

    // The imported production functions, each from its own module and not
    // shadowed by a local declaration of the same name.
    const imports: Record<string, string> = {
      whenLaunchSettled: './session-manager.ts',
      killPersonaInstance: './session-manager.ts',
      deletePersonaInstance: './session-manager.ts',
      cancelRestartTimer: './restart.ts',
      forgetFailures: './backoff.ts',
      forgetDisconnectedStreak: './health-check.ts',
      resetAllToHealthy: './outage-state.ts',
      forgetPersonaPrompts: './permission-poller.ts',
      getLaunchedWithDir: './stop-hook-bootstrap.ts',
      teardownPersonaReplyGuard: './stop-hook-bootstrap.ts',
      stopHookLaunchPass: './stop-hook-bootstrap.ts',
      runPersonaStorageCheck: './jsonl-persistence-check.ts',
    }
    for (const [name, module] of Object.entries(imports)) {
      expect([name, importSource(SERVER_CODE, name)]).toEqual([name, module])
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }

    // The flag shutdown() sets, the one initRestart reads too.
    expect(props.get('isShuttingDown')).toBe(onlyCallProps('initRestart').get('isShuttingDown'))
    const [shutdownStart, shutdownEnd] = shutdownBody(SERVER_CODE)
    const raises = assignmentsOf('shuttingDown', 'true')
    expect(raises).toHaveLength(1)
    expect(raises[0]!).toBeGreaterThan(shutdownStart)
    expect(raises[0]!).toBeLessThan(shutdownEnd)

    // The session drop is the one the not-up dropper uses: a server.ts
    // function that drops the registry entry before the transport closes and
    // the keep-alive stops, so the closing stream schedules no restart.
    expect(onlyCallProps('createNotUpSessionDropper').get('drop')).toBe('dropPersonaSessionAndKeepAlive')
    expect(indicesOf(/\bfunction\s+dropPersonaSessionAndKeepAlive\s*\(/g, SERVER_CODE)).toHaveLength(1)

    // The log is the server log.
    expect(props.get('log')).toMatch(/^\(?\s*(\w+)\s*\)?\s*=>\s*console\s*\.\s*error\s*\(\s*\1\s*\)$/)

    // The reply guard's teardown and launch pass use the server's state dir,
    // the one the start's stop-hook bootstrap writes.
    const stateDir = splitTopLevel(onlyCallArguments(SERVER_CODE, 'stopHookBootstrap'))[1]
    expect(stateDir).toMatch(/^\w+$/)
    const guard = objectProperties(props.get('replyGuard') ?? '')
    expect([...guard.keys()].sort()).toEqual(['launchPass', 'launchedWithDir', 'teardown'])
    expect(guard.get('launchedWithDir')).toBe('getLaunchedWithDir')
    const teardown = (guard.get('teardown') ?? '').match(new RegExp(`^\\(?(\\w+)\\)? => teardownPersonaReplyGuard\\(${stateDir}, (\\w+)\\)$`))
    expect(teardown).not.toBeNull()
    expect(teardown![2]).toBe(teardown![1])
    const launchPass = (guard.get('launchPass') ?? '').match(
      new RegExp(`^\\((\\w+), (\\w+)\\) => stopHookLaunchPass\\((\\w+), (\\w+), ${stateDir}\\)$`),
    )
    expect(launchPass).not.toBeNull()
    expect([launchPass![3], launchPass![4]]).toEqual([launchPass![1], launchPass![2]])

    // The storage check at apply posts through the persona notifier.
    const storage = (props.get('storageCheck') ?? '').match(new RegExp(`^\\(?(\\w+)\\)? => runPersonaStorageCheck\\((\\w+), ${notifier}\\.notify\\)$`))
    expect(storage).not.toBeNull()
    expect(storage![2]).toBe(storage![1])

    // The launch at apply is the retry launch: the applied config read at
    // call time, the start-time one (the config onApplied spreads) as
    // fallback, not at startup.
    const launch = props.get('launch') ?? ''
    const m = launch.match(new RegExp(`^\\((\\w+)\\) => spawnForPersona\\(\\1, ${loaded} \\?\\? (\\w+), false\\)$`))
    expect(m).not.toBeNull()
    expect(m![2]).toBe(startTimeConfig())
    expect(launch).toBe(onlyCallProps('createPersonaBringUpController').get('launch') ?? '')
  })
})


// ---------------------------------------------------------------------------
// In-place changes reach their consumers through the live applied config (AC 58)
// ---------------------------------------------------------------------------

/** The top-level properties of the module-scope `const <name>: <Type> = { … }` object literal. */
function constObjectProps(name: string): Map<string, string> {
  const decls = indicesOf(new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*\\w+\\s*)?=\\s*\\{`, 'g'), SERVER_CODE)
  expect(decls).toHaveLength(1)
  expect(insideMain(SERVER_CODE, decls[0]!)).toBe(false)
  return objectProperties(SERVER_CODE.slice(SERVER_CODE.indexOf('=', decls[0]!)))
}

describe('AC 58: in-place consumers read the applied config onApplied swaps, at call time (b.av2 SR-8.6 step 3)', () => {
  // A confirmed channels, delivery, destination, DM contact or DMs-switch
  // change is applied by step 1's swap of the holder (pinned above); step 3
  // only clears per-persona caches. A consumer bound to a copy taken at start
  // would keep the old values until the next restart.
  test('AC 58: the applied config holder is one module-scope `let`, the one onApplied reassigns', () => {
    const loaded = loadedConfigName(SERVER_CODE)
    const decls = [...SERVER_CODE.matchAll(new RegExp(`\\b(?:let|const|var)\\s+${loaded}\\b[^\\n]*`, 'g'))]
    expect(decls.map((d) => d[0].trim())).toEqual([`let ${loaded}: PersonaConfig | null = null`])
    expect(insideMain(SERVER_CODE, decls[0]!.index!)).toBe(false)
    // onApplied's swap target is this holder (startTimeConfig fails otherwise).
    startTimeConfig()
  })

  test('AC 58: the persona routing (posting scope, delivery) reads the holder at call time', () => {
    expect(onlyCallProps('createPersonaRouting').get('getPersonaConfig')).toBe(`() => ${loadedConfigName(SERVER_CODE)}`)
  })

  test('AC 58: getAppliedPersona, declared once at module scope, looks the key up in the holder at call time', () => {
    const decls = indicesOf(/\bfunction\s+getAppliedPersona\s*\(/g, SERVER_CODE)
    expect(decls).toHaveLength(1)
    expect(insideMain(SERVER_CODE, decls[0]!)).toBe(false)
    expect(indicesOf(/\b(?:let|const|var)\s+getAppliedPersona\b/g, SERVER_CODE)).toEqual([])
    const [params, paramsEnd] = balancedAfter(SERVER_CODE, decls[0]!, '(', ')')
    const key = SERVER_CODE.slice(params, paramsEnd).match(/^\s*(\w+)\s*:\s*string\s*$/)
    expect(key).not.toBeNull()
    const [bodyStart, bodyEnd] = balancedAfter(SERVER_CODE, paramsEnd, '{', '}')
    const body = SERVER_CODE.slice(bodyStart, bodyEnd).replace(/\s+/g, ' ').trim()
    const find = body.match(
      new RegExp(`^return ${loadedConfigName(SERVER_CODE)} ?\\?\\. ?personas ?\\. ?find ?\\( ?\\(? ?(\\w+) ?\\)? ?=> ?\\1 ?\\. ?key ?=== ?(\\w+) ?\\) ?;?$`),
    )
    expect(find).not.toBeNull()
    expect(find![2]).toBe(key![1])
  })

  // The event router's, the permission poller's and the destination hold's
  // getPersona are pinned in tests/permission-relay-wiring.test.ts.
  test.each([
    ['the persona notifier (destination, DM contact and switch for notices)', () => onlyCallProps('createPersonaNotifier')],
    ['the MCP session tools (reply scope)', () => constObjectProps('sessionToolDeps')],
  ])('AC 58: %s get getPersona: getAppliedPersona', (_consumer, props) => {
    expect(props().get('getPersona')).toBe('getAppliedPersona')
  })
})
