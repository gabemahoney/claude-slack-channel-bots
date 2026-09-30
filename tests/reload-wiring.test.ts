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
 * applied config to `configInEffect(<start-time config>, <confirmed>)`, the
 * confirmed persona set over the start-time server-wide values (AC 61, the
 * server-wide row: nothing in server.ts reads the controller's own applied
 * config, and `configInEffect` itself is tested as a pure function at the end
 * of this file; the ack reaction and reply chunk settings reach the routing
 * and the MCP tools through `getReplySettings`, whose body is pinned to
 * config.ts's pure `replySettingsOf` over that holder, and `replySettingsOf`
 * is tested over the holder's value after the swap). These assertions fail if main() arms the timer
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
 * Task 1) over `reconnectCredentials`, its template refresh (step 5, E13
 * Task 2) over `refreshTemplate`, and the recovery of a
 * credentials-broken persona (step 6, SR-6.4) over `bringUp` with its
 * `recovery` option. The audit pins that production binds all five, every
 * argument forwarded, to the one `PersonaLifecycle` main() composes with
 * `createPersonaLifecycle` (declared before the controller, assigned once
 * after the bring-up controller exists and before detection is armed), passes
 * no `applySteps` override (which would replace that fan-out), and that the
 * restart timers, the connection manager (the deferred socket close after a
 * Web API auth error, b.ujn), the bring-up retries and the lifecycle share
 * one per-persona serializer (the UNAVAILABLE retry controller reaches it only
 * through the restart module's retry entry, never directly), that the
 * teardown stops a key's UNAVAILABLE retry timer through the one retry
 * controller main() builds (b.jg5 SRJ-305) and, in the same binding, cancels
 * the key's tmux-unresponsive alert check on the one condition main() builds
 * (b.jg5 SRJ-309), and that the refresh gets the server-wide
 * template arguments the boot install wrote (a value captured once at start,
 * never re-read at apply) and the agent-director client. What the default step bodies do with those members
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
 * but src/server.ts, imports only the pure `configInEffect` from
 * src/reload.ts and the pure `replySettingsOf`, constants and types from
 * src/config.ts, runs no server code, and touches no home directory.
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
import { makePersonaConfig } from './test-helpers/persona-config.ts'
import { configInEffect } from '../src/reload.ts'
import {
  DEFAULT_REPLY_CHUNK_LIMIT,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_REPLY_CHUNK_MODE,
  replySettingsOf,
  type PersonaConfig,
  type ReplySettings,
} from '../src/config.ts'

/** server.ts with every comment removed (see stripComments). */
const SERVER_CODE = stripComments(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8'))

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
 * The start-time applied config the controller's `onApplied` keeps the
 * server-wide values of. Its body must be exactly a guard that throws while
 * that config is still unset, then the swap
 * `<loaded> = configInEffect(<start-time>, <applied>)` (start-time first:
 * `configInEffect` keeps its first argument's server-wide values and takes
 * only the second's personas); fails the test otherwise.
 */
function startTimeConfig(): string {
  const { loaded } = startResolution(SERVER_CODE)
  const onApplied = (controllerProps().get('onApplied') ?? '').replace(/\s+/g, ' ')
  const swap = onApplied.match(
    new RegExp(
      `^\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\\{\\s*` +
        `if\\s*\\(\\s*(\\w+)\\s*===\\s*undefined\\s*\\)\\s*throw\\s+new\\s+Error\\s*\\(\\s*'[^']*'\\s*\\)\\s*;?\\s*` +
        `${loaded}\\s*=\\s*configInEffect\\s*\\(\\s*\\2\\s*,\\s*\\1\\s*\\)\\s*;?\\s*\\}$`,
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
    // The swap is reload.ts's configInEffect (tested as a pure function
    // below), not a local stand-in of the same name.
    expect(importSource(SERVER_CODE, 'configInEffect')).toBe('./reload.ts')
    expect(indicesOf(/\b(?:let|const|var|function)\s+configInEffect\b/g, SERVER_CODE)).toEqual([])
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
 * `reconnectCredentials`, `refreshTemplate` and `bringUp` members forward to
 * (see the first test below).
 */
function lifecycleHolder(): string {
  const lifecycle = objectProperties(controllerProps().get('lifecycle') ?? '')
  const teardown = forwardingHolder(lifecycle, 'teardown', 1)
  // All five on the same holder. bringUp forwards its third parameter, the
  // options carrying `recovery` (SR-8.6 step 6, SR-6.4): a binding that drops
  // it typechecks, but would bring a credentials-broken persona up as new.
  expect(forwardingHolder(lifecycle, 'updateInPlace', 1)).toBe(teardown)
  expect(forwardingHolder(lifecycle, 'reconnectCredentials', 2)).toBe(teardown)
  expect(forwardingHolder(lifecycle, 'refreshTemplate', 1)).toBe(teardown)
  expect(forwardingHolder(lifecycle, 'bringUp', 3)).toBe(teardown)
  return teardown
}

describe('server.ts binds the confirmed apply\'s teardown, in-place update, credentials change, template refresh and bring-up (b.av2 SR-6.1, SR-6.4, SR-6.5, SR-6.6, SR-8.6 steps 3 to 6)', () => {
  // ReloadLifecycleOps.teardown, .updateInPlace, .reconnectCredentials,
  // .refreshTemplate and .bringUp are required, so the typecheck catches a
  // missing member; it cannot catch one bound to something that does
  // nothing, to another member, or one that drops an optional argument.
  // Without these bindings a
  // confirmed removal would leave the persona's connection, session and
  // instance running, a confirmed addition would never come up, a confirmed
  // routing change would be recorded as applied while the persona's cached
  // DM conversation stayed and no line was logged, a rotated token would
  // never reach the persona's connection, a confirmed config-directory
  // change would leave the template's memory-read rules on the old
  // directories, and a credentials-broken persona would never recover.
  test('the controller\'s lifecycle members teardown, updateInPlace, reconnectCredentials, refreshTemplate and bringUp (with its options) forward their arguments to one lifecycle holder, beside the start bring-up', () => {
    const lifecycle = objectProperties(controllerProps().get('lifecycle') ?? '')
    expect([...lifecycle.keys()].sort()).toEqual(['bringUp', 'reconnectCredentials', 'refreshTemplate', 'startBringUp', 'teardown', 'updateInPlace'])
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
      // b.f2b: optional in the deps, so only this pin makes sure a production
      // teardown cancels a launch's wait for a working row instead of waiting
      // it out (up to 10 minutes).
      ['cancelLaunchWait', 'cancelWorkingRowWait'],
      ['cancelRestartTimer', 'cancelRestartTimer'],
      ['forgetFailures', 'forgetFailures'],
      ['forgetDisconnectedStreak', 'forgetDisconnectedStreak'],
      // b.f2b: optional in the deps, so only this pin makes sure production
      // ends a torn-down key's not-connected episode (notice latch, pane evidence).
      ['forgetNotConnectedEpisode', 'forgetNotConnectedEpisode'],
      // The silent per-key reset (never the boot reset of every persona).
      ['resetOutageState', 'resetAllToHealthy'],
      ['forgetPersonaPrompts', 'forgetPersonaPrompts'],
      // The silent per-key ack-tracker forget, so a key added again starts clean.
      ['forgetAcks', 'forgetPersonaAcks'],
      ['dropSession', 'dropPersonaSessionAndKeepAlive'],
      ['killInstance', 'killPersonaInstance'],
      ['deleteInstance', 'deletePersonaInstance'],
    ])
    // Functions and objects with a parameter name of the source's choosing.
    // (`templateRefresh` is pinned in the test after this one.)
    const shaped = ['log', 'replyGuard', 'storageCheck', 'launch', 'templateRefresh', 'stopRetryTimer', 'forgetNoticeEpisodes']
    expect([...props.keys()].sort()).toEqual([...expected.keys(), ...shaped].sort())
    for (const [dep, value] of expected) expect([dep, props.get(dep)]).toEqual([dep, value])

    // The imported production functions, each from its own module and not
    // shadowed by a local declaration of the same name.
    const imports: Record<string, string> = {
      whenLaunchSettled: './session-manager.ts',
      cancelWorkingRowWait: './session-manager.ts',
      killPersonaInstance: './session-manager.ts',
      deletePersonaInstance: './session-manager.ts',
      cancelRestartTimer: './restart.ts',
      forgetFailures: './backoff.ts',
      forgetDisconnectedStreak: './health-check.ts',
      forgetNotConnectedEpisode: './session-manager.ts',
      resetAllToHealthy: './outage-state.ts',
      forgetPersonaPrompts: './permission-poller.ts',
      forgetPersonaAcks: './ack-tracker.ts',
      getLaunchedWithDir: './stop-hook-bootstrap.ts',
      teardownPersonaReplyGuard: './stop-hook-bootstrap.ts',
      stopHookLaunchPass: './stop-hook-bootstrap.ts',
      runPersonaStorageCheck: './jsonl-persistence-check.ts',
      createUnavailableRetryController: './unavailable-retry.ts',
      UNAVAILABLE_RETRY_STOP_TORN_DOWN: './unavailable-retry.ts',
      createPersonaEpisodes: './persona-episodes.ts',
      createTmuxUnresponsiveCondition: './persona-episodes.ts',
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

    // b.jg5 SRJ-305: the teardown stops the key's UNAVAILABLE retry timer on
    // the server's one retry controller (the one installed as the outage
    // state's trigger sink; pinned in tests/server-startup-wiring.test.ts),
    // with the torn-down reason: not a stub, not the restart timer's cancel,
    // not another controller, and never every persona's timer. b.jg5
    // SRJ-309: with the timer stopped, "CSCB keeps retrying" no longer holds,
    // so the same binding cancels the key's tmux-unresponsive alert check on
    // the server's one condition (not a local shadow, not another key's).
    const retryTimers = constOf('createUnavailableRetryController')
    const condition = constOf('createTmuxUnresponsiveCondition')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${condition}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
    const stopRetry = (props.get('stopRetryTimer') ?? '').match(
      new RegExp(
        `^\\(?(\\w+)\\)? => \\{ ${retryTimers}\\.stop\\((\\w+), UNAVAILABLE_RETRY_STOP_TORN_DOWN\\);? ` +
          `${condition}\\.cancelAlert\\((\\w+)\\);? \\}$`,
      ),
    )
    expect(stopRetry).not.toBeNull()
    expect([stopRetry![2], stopRetry![3]]).toEqual([stopRetry![1], stopRetry![1]])

    // b.jg5 SRJ-1016: the teardown silently forgets the key's notice
    // episodes on the server's one episodes instance (its shutdown wiring is
    // pinned in tests/server-startup-wiring.test.ts): not a stub, not another
    // instance or module's forget, not a local shadow of the instance, and
    // never every persona's episodes.
    const noticeEpisodes = constOf('createPersonaEpisodes')
    expect(indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${noticeEpisodes}\\b`, 'g'), SERVER_CODE)).toHaveLength(1)
    const forgetEpisodes = (props.get('forgetNoticeEpisodes') ?? '').match(
      new RegExp(`^\\(?(\\w+)\\)? => ${noticeEpisodes}\\.forget\\((\\w+)\\)$`),
    )
    expect(forgetEpisodes).not.toBeNull()
    expect(forgetEpisodes![2]).toBe(forgetEpisodes![1])

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

  // SR-8.6 step 5: the refresh rewrites only the memory-read rules; the
  // template's server-wide arguments keep their start-time values (the
  // server-wide row). `templateRefresh` is required, so the typecheck
  // catches it missing; it cannot catch arguments rebuilt from the applied
  // config at apply (a confirmed server-wide change would then reach the
  // template at once), taken from a second install, or a stand-in client.
  test('step 5\'s template refresh gets exactly the params the one boot install wrote, captured at start, and the agent-director client', () => {
    const refresh = objectProperties(onlyCallProps('createPersonaLifecycle').get('templateRefresh') ?? '')
    expect([...refresh.keys()].sort()).toEqual(['getClient', 'installed'])
    expect(refresh.get('getClient')).toBe('getClient')

    // `installed` is `<boot install>.params`, where the boot install is
    // `const <name> = await installSlackChannelBotTemplate(<applied config>)`:
    // the only install, run on every start in main()'s own statement list,
    // after the start set the applied config and before detection is armed
    // (so before any apply could change it), and a `const`, so nothing
    // replaces it later.
    const installs = [...SERVER_CODE.matchAll(/\bconst\s+(\w+)\s*=\s*await\s+installSlackChannelBotTemplate\s*\(/g)]
    expect(installs).toHaveLength(1)
    const installed = installs[0]![1]!
    expect(refresh.get('installed')).toBe(`${installed}.params`)
    const installAt = installs[0]!.index!
    expect(callsOf(SERVER_CODE, 'installSlackChannelBotTemplate')).toEqual([installAt + installs[0]![0].lastIndexOf('installSlackChannelBotTemplate')])
    expect(onlyCallArguments(SERVER_CODE, 'installSlackChannelBotTemplate').trim()).toBe(loadedConfigName(SERVER_CODE))
    expect(atMainTopLevel(SERVER_CODE, installAt)).toBe(true)
    expect(installAt).toBeGreaterThan(startResolution(SERVER_CODE).assignAt)
    expect(installAt).toBeLessThan(onlyMethodCall('startDetection').at)
    expect(installAt).toBeLessThan(callsOf(SERVER_CODE, 'createPersonaLifecycle')[0]!)

    // The production functions, not local stand-ins; server.ts never
    // refreshes or rebuilds the template itself (the lifecycle does).
    expect(importSource(SERVER_CODE, 'installSlackChannelBotTemplate')).toBe('./agent-director-template.ts')
    expect(importSource(SERVER_CODE, 'getClient')).toBe('./agent-director-client.ts')
    for (const name of ['installSlackChannelBotTemplate', 'getClient']) {
      expect([name, indicesOf(new RegExp(`\\b(?:let|const|var|function)\\s+${name}\\b`, 'g'), SERVER_CODE)]).toEqual([name, []])
    }
    expect(anyCallOf('refreshSlackChannelBotTemplate')).toEqual([])
    expect(anyCallOf('buildTemplateParams')).toEqual([])
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

// ---------------------------------------------------------------------------
// Server-wide settings keep their start-time values until the next start (AC 61)
// ---------------------------------------------------------------------------

describe('AC 61: server-wide settings keep their start-time values after a confirmed apply (b.av2 SR-8.6, the server-wide row)', () => {
  // Every consumer of a server-wide setting reads the applied config holder
  // (at call time, as the AC 58 consumers above, or once at start, as the
  // listener's bind and port). After an apply that holder is exactly what
  // configInEffect makes of the start-time config and the confirmed one, so
  // no consumer can see a confirmed server-wide value before the next start.
  // The acknowledgement reaction and the reply chunk settings reach their
  // consumers (the routing's ack step and the reply tool) through the one
  // accessor getReplySettings, which reads the same holder at call time
  // (pinned by the last tests of this block).
  test('configInEffect keeps every server-wide setting of the start-time config and takes only the confirmed persona set', () => {
    const startTime = makePersonaConfig({ claude_config_dir: '/start/claude' }, '/start-base')
    const persona = startTime.personas[0]!
    // Every server-wide setting changed, one added (ack_reaction) and one
    // dropped (claude_config_dir), and the persona set replaced.
    const applied = makePersonaConfig(
      {
        personas: [{ ...persona, key: 'other', name: 'Other', claude_config_dir: '/applied/claude' }],
        bind: '0.0.0.0',
        port: 4200,
        session_restart_delay: 5,
        health_check_interval: 30,
        exit_timeout: 7,
        stop_timeout: 9,
        cozempic_prescription: 'aggressive',
        system_prompt_mode: 'replace',
        resume_enabled: false,
        stop_hook_bootstrap: false,
        agent_director_poll_interval_ms: 12_345,
        agent_director_call_timeout_ms: MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
        ack_reaction: 'eyes',
        reply_chunk_limit: 1000,
        reply_chunk_mode: 'length',
      },
      '/applied-base',
    )
    const serverWide = Object.keys(startTime).filter((key) => key !== 'personas').sort()
    // The fixture changes every server-wide setting the start has.
    for (const key of serverWide) {
      expect([key, applied[key as keyof typeof applied]]).not.toEqual([key, startTime[key as keyof typeof startTime]])
    }
    const before = structuredClone({ startTime, applied })

    const inEffect = configInEffect(startTime, applied)
    expect(Object.keys(inEffect).sort()).toEqual([...serverWide, 'personas'].sort())
    for (const key of serverWide) {
      expect([key, inEffect[key as keyof typeof inEffect]]).toEqual([key, startTime[key as keyof typeof startTime]])
    }
    // A setting the start did not have stays absent until the next start.
    expect('ack_reaction' in inEffect).toBe(false)
    // The confirmed persona set itself, each persona's resolved (inherited)
    // values included.
    expect(inEffect.personas).toBe(applied.personas)
    // Pure: neither input is changed, and the result is a new object.
    expect({ startTime, applied }).toEqual(before)
    expect(inEffect).not.toBe(startTime)
    expect(inEffect).not.toBe(applied)
  })

  test('the applied config holder is written only by the start and by onApplied\'s configInEffect, and nothing reads the reload controller\'s own applied config', () => {
    const { loaded, outcome, assignAt } = startResolution(SERVER_CODE)
    const writes = [...SERVER_CODE.matchAll(new RegExp(`(?<![\\w.$])${loaded}\\s*(?:[-+*/|&?]{1,2})?=(?![=>])\\s*([^\\n;]*)`, 'g'))]
    const startTime = startTimeConfig()
    const param = (controllerProps().get('onApplied') ?? '').match(/^\(?\s*(\w+)/)![1]!
    expect(writes.map((w) => w[1]!.trim()).sort()).toEqual([`${outcome}.config`, `configInEffect(${startTime}, ${param})`].sort())
    expect(writes.find((w) => w[1]!.trim() === `${outcome}.config`)!.index).toBe(assignAt)
    // The controller's applied() carries a confirmed change's server-wide
    // values; a consumer bound to it would apply them at once.
    expect(indicesOf(/\.\s*applied\s*\(/g, SERVER_CODE)).toEqual([])
  })

  // E13 carry: the ack reaction and the reply chunking must not follow a
  // confirmed server-wide change before the next start. Both consumers get
  // the accessor itself (not a value taken once, not a stand-in), so each
  // use reads it again.
  test.each([
    ['the persona routing (the inbound ack reaction)', () => onlyCallProps('createPersonaRouting')],
    ['the MCP session tools (the reply tool\'s chunking and ack removal)', () => constObjectProps('sessionToolDeps')],
  ])('%s get getReplySettings: getReplySettings, the one accessor', (_consumer, props) => {
    expect(props().get('getReplySettings')).toBe('getReplySettings')
    // Nothing in server.ts calls it (a value read once and handed on): the
    // only `getReplySettings(` is its declaration.
    expect(anyCallOf('getReplySettings')).toEqual(indicesOf(/(?<=\bfunction\s+)getReplySettings\s*\(/g, SERVER_CODE))
    expect(anyCallOf('getReplySettings')).toHaveLength(1)
  })

  test('getReplySettings, declared once at module scope, is exactly `return replySettingsOf(<applied config holder>)`, with config.ts\'s replySettingsOf', () => {
    const decls = indicesOf(/\bfunction\s+getReplySettings\s*\(/g, SERVER_CODE)
    expect(decls).toHaveLength(1)
    expect(insideMain(SERVER_CODE, decls[0]!)).toBe(false)
    expect(indicesOf(/\b(?:let|const|var)\s+getReplySettings\b/g, SERVER_CODE)).toEqual([])
    const [paramsStart, paramsEnd] = balancedAfter(SERVER_CODE, decls[0]!, '(', ')')
    expect(SERVER_CODE.slice(paramsStart, paramsEnd).trim()).toBe('')
    const [bodyStart, bodyEnd] = balancedAfter(SERVER_CODE, paramsEnd, '{', '}')
    expect(SERVER_CODE.slice(paramsEnd + 1, bodyStart - 1).replace(/\s+/g, ' ').trim()).toBe(': ReplySettings')
    // The whole body: the holder onApplied swaps (read at call time), never
    // the reload controller's applied config, a copy taken at start or a
    // hand-written merge of the three keys.
    const holder = loadedConfigName(SERVER_CODE)
    expect(SERVER_CODE.slice(bodyStart, bodyEnd).replace(/\s+/g, ' ').trim()).toMatch(
      new RegExp(`^return replySettingsOf\\s*\\(\\s*${holder}\\s*\\)\\s*;?$`),
    )
    // config.ts's pure function (tested below), not a local stand-in.
    expect(importSource(SERVER_CODE, 'replySettingsOf')).toBe('./config.ts')
    expect(indicesOf(/\b(?:function|let|const|var)\s+replySettingsOf\b/g, SERVER_CODE)).toEqual([])
  })

  test('replySettingsOf over the holder after a confirmed apply that changes ack_reaction, reply_chunk_limit and reply_chunk_mode yields the start-time values', () => {
    const startTime = makePersonaConfig({ ack_reaction: 'eyes', reply_chunk_limit: 2000, reply_chunk_mode: 'length' }, '/start-base')
    const applied = makePersonaConfig({ ack_reaction: 'thumbsup', reply_chunk_limit: 1000, reply_chunk_mode: 'newline' }, '/applied-base')
    const startValues: ReplySettings = { ack_reaction: 'eyes', reply_chunk_limit: 2000, reply_chunk_mode: 'length' }
    // The fixture changes all three.
    expect(replySettingsOf(applied)).toEqual({ ack_reaction: 'thumbsup', reply_chunk_limit: 1000, reply_chunk_mode: 'newline' })

    // onApplied's `<holder> = configInEffect(<start-time>, <confirmed>)` (pinned above).
    const inEffect = configInEffect(startTime, applied)

    expect(replySettingsOf(inEffect)).toEqual(startValues)
  })

  test('replySettingsOf over the holder after a confirmed apply that adds an ack_reaction the start had none of yields no reaction and the start\'s chunking', () => {
    const startTime = makePersonaConfig({}, '/start-base')
    const applied = makePersonaConfig({ ack_reaction: 'eyes', reply_chunk_limit: 1000, reply_chunk_mode: 'length' }, '/applied-base')

    const settings = replySettingsOf(configInEffect(startTime, applied))

    expect(settings.ack_reaction).toBeUndefined()
    expect(settings).toEqual({ ack_reaction: undefined, reply_chunk_limit: startTime.reply_chunk_limit, reply_chunk_mode: startTime.reply_chunk_mode })
    expect([settings.reply_chunk_limit, settings.reply_chunk_mode]).not.toEqual([1000, 'length'])
  })
})

// ---------------------------------------------------------------------------
// replySettingsOf: the server-wide reply settings of a config (b.av2 SR-1.6)
// ---------------------------------------------------------------------------

describe('replySettingsOf (b.av2 SR-1.6)', () => {
  const DEFAULTS: ReplySettings = { ack_reaction: undefined, reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT, reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE }

  test.each([
    ['null (before the start resolves)', null],
    ['undefined', undefined],
  ])('with no config (%s): no reaction and the default chunking', (_label, config) => {
    const settings = replySettingsOf(config)

    expect(settings).toEqual(DEFAULTS)
    expect(settings.ack_reaction).toBeUndefined()
  })

  test('a config with all three keys: exactly its three values, and the config is not changed', () => {
    const config = makePersonaConfig({ ack_reaction: 'eyes', reply_chunk_limit: 1234, reply_chunk_mode: 'length' }, '/base')
    // Not the defaults, so a default can't stand in for a value read.
    expect([config.reply_chunk_limit, config.reply_chunk_mode]).not.toEqual([DEFAULT_REPLY_CHUNK_LIMIT, DEFAULT_REPLY_CHUNK_MODE])
    const before = structuredClone(config)

    const settings = replySettingsOf(config)

    expect(settings).toEqual({ ack_reaction: 'eyes', reply_chunk_limit: 1234, reply_chunk_mode: 'length' })
    expect(Object.keys(settings).sort()).toEqual(['ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode'])
    expect(config).toEqual(before)
  })

  test('a config missing all three keys: no reaction and the default chunking', () => {
    const { ack_reaction: _a, reply_chunk_limit: _l, reply_chunk_mode: _m, ...rest } = makePersonaConfig({}, '/base')
    const config = rest as PersonaConfig
    expect(['ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode'].filter((key) => key in config)).toEqual([])

    expect(replySettingsOf(config)).toEqual(DEFAULTS)
  })

  test('a config with a reaction but no chunk keys: its reaction, and the defaults fill the missing chunking', () => {
    const { reply_chunk_limit: _l, reply_chunk_mode: _m, ...rest } = makePersonaConfig({ ack_reaction: 'eyes' }, '/base')

    expect(replySettingsOf(rest as PersonaConfig)).toEqual({ ...DEFAULTS, ack_reaction: 'eyes' })
  })
})
