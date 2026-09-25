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
  balancedAfter,
  callsOf,
  indicesOf,
  insideMain,
  objectProperties,
  onlyCallArguments,
  shutdownBody,
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
    const onApplied = (controllerProps().get('onApplied') ?? '').replace(/\s+/g, ' ')
    // The body is exactly: a guard that throws while the start-time config is
    // still unset, then the swap spreading that same config.
    const swap = onApplied.match(
      new RegExp(
        `^\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\\{\\s*` +
          `if\\s*\\(\\s*(\\w+)\\s*===\\s*undefined\\s*\\)\\s*throw\\s+new\\s+Error\\s*\\(\\s*'[^']*'\\s*\\)\\s*;?\\s*` +
          `${loaded}\\s*=\\s*\\{\\s*\\.\\.\\.\\2\\s*,\\s*personas\\s*:\\s*\\1\\s*\\.\\s*personas\\s*,?\\s*\\}\\s*;?\\s*\\}$`,
      ),
    )
    expect(swap).not.toBeNull()
    // The spread is the start-time config: declared once, inside main(),
    // before the controller whose onApplied closes over it (no temporal dead
    // zone), and assigned once, from the holder, after the start resolution
    // set it and before detection is armed (the only point after which
    // onApplied can run).
    const startTime = swap![2]!
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
