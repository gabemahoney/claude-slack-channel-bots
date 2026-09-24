/**
 * test-helpers/persona-notifier.ts — The real per-persona notifier over stub
 * Slack clients (b.av2 SR-7.2, SR-13.4).
 *
 * `makeNotifierHarness(config, opts?)` builds the real `createPersonaNotifier`
 * with one `makeStubSlack` stub per persona of `config`, so a test can assert
 * which persona's client posted, to which channel and with which text:
 * - `getPersona` looks the key up in `personas`, a copy of `config.personas`
 *   the test may edit (remove a persona to simulate a reload);
 * - `clientFor` returns the persona's stub `web` while its key is in
 *   `validated`, and undefined otherwise (not validated yet);
 * - `isDryRun` reads a flag the test sets with `setDryRun`;
 * - `log` appends to `logs`;
 * - the notifier's destination hold (`h.hold`, which holds and retries a
 *   notice whose destination fails) is built over its own destination
 *   resolver (`h.destinations`), the same lookups and `log`, on a fake clock
 *   (`h.clock`, or the `clock` option): never the real clock, so a held
 *   notice starts no real timer and its retries run only when the test moves
 *   the clock (`h.clock.runNext()`, `h.clock.advance(ms)`).
 *
 * The harness installs nothing: pass `h.notifier.notify` to the notice site
 * under test (`setSessionNotifier`, `initOutageState({ notify })`, the
 * safeguard's `notify` argument).
 *
 * `makeNotifierStack(deps)` is the wiring on its own: a destination resolver,
 * the destination hold over it on a fake clock, and the notifier handing
 * notices to that hold, all over the caller's persona and client lookups and
 * one log, as `src/server.ts` builds them. The harness above and the routing
 * helpers (tests/test-helpers/persona-routing-harness.ts,
 * tests/test-helpers/persona-routing-managed.ts) build their notifier with it.
 *
 * Isolation (b.av2 SR-13.2): no module-scope state, no I/O, no real timers,
 * no token literal. The stubs' failures carry `leakMarker` when given.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'

import type { Persona, PersonaConfig } from '../../src/config.ts'
import { createPersonaDestinationHold, type PersonaDestinationHold } from '../../src/persona-destination-hold.ts'
import { createPersonaDestinations, type PersonaDestinations } from '../../src/persona-destination.ts'
import { createPersonaNotifier, type PersonaNotifier } from '../../src/persona-notifier.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeStubSlack, type StubSlack, type WebApiOutcome } from './slack-stub.ts'

/** One captured `chat.postMessage` call, as the notifier makes it. */
export interface NoticePost {
  channel: string
  text: string
}

/** The lookups, clock and log `makeNotifierStack` builds the notifier over. */
export interface NotifierStackDeps {
  /** The applied persona for a key, read at call time. */
  getPersona(key: string): Persona | undefined
  /** The persona's Web API client, or undefined when it has none (not validated yet). */
  clientFor(key: string): WebClient | undefined
  /** The destination hold's clock and timers. Default: a new `createFakeClock()`. */
  clock?: FakeClock
  /** Dry-run flag, read at call time. Default: never dry run. */
  isDryRun?: () => boolean
  /** Every line the resolver, the hold and the notifier log. */
  log(line: string): void
}

/** The notifier and the pieces it was built with. */
export interface NotifierStack {
  readonly notifier: PersonaNotifier
  /** The destination hold the notifier hands notices to, on `clock`. */
  readonly hold: PersonaDestinationHold
  /** The destination resolver the hold posts through. */
  readonly destinations: PersonaDestinations
  /** The fake clock the destination hold runs on. */
  readonly clock: FakeClock
}

/**
 * The real destination resolver, destination hold (on a fake clock, never the
 * real one) and persona notifier, wired as `src/server.ts` wires them.
 */
export function makeNotifierStack(deps: NotifierStackDeps): NotifierStack {
  const { getPersona, clientFor, log } = deps
  const clock = deps.clock ?? createFakeClock()
  const destinations = createPersonaDestinations({ log })
  const hold = createPersonaDestinationHold({ destinations, getPersona, clientFor, clock, log })
  const notifier = createPersonaNotifier({
    getPersona,
    clientFor,
    destinations,
    destinationHold: hold,
    isDryRun: deps.isDryRun ?? (() => false),
    log,
  })
  return { notifier, hold, destinations, clock }
}

export interface NotifierHarnessOptions {
  /**
   * Keys whose client counts as validated at build time: `true` (default)
   * validates every persona, `false` none, a list only those keys.
   */
  validated?: boolean | readonly string[]
  /** Initial `chat.postMessage` outcomes, per persona key. */
  post?: Readonly<Record<string, readonly WebApiOutcome[]>>
  /** Leak marker for every stub's scripted failures (normally `LEAK_SENTINEL`). */
  leakMarker?: string
  /** Initial dry-run flag. Default false. */
  dryRun?: boolean
  /** The destination hold's clock and timers. Default: a new `createFakeClock()`. */
  clock?: FakeClock
}

export interface NotifierHarness {
  /** The real notifier under test. */
  readonly notifier: PersonaNotifier
  /** Applied personas `getPersona` reads; edit to simulate a reload. */
  readonly personas: Persona[]
  /** One stub per persona key of the config. */
  readonly stubs: ReadonlyMap<string, StubSlack>
  /** Keys whose client counts as validated; `validate(key)` adds one. */
  readonly validated: Set<string>
  /** The notifier's log lines, in order (the hold's and the resolver's included). */
  readonly logs: string[]
  /** The fake clock the destination hold runs on. */
  readonly clock: FakeClock
  /** The destination hold the notifier hands notices to. */
  readonly hold: PersonaDestinationHold
  /** The destination resolver the hold posts through. */
  readonly destinations: PersonaDestinations
  /** The stub for `key`; throws when the config has no such persona. */
  stub(key: string): StubSlack
  /** Mark `key`'s client validated (does not flush). */
  validate(key: string): void
  /** Set the dry-run flag. */
  setDryRun(on: boolean): void
  /** `chat.postMessage` calls made through `key`'s stub. */
  posts(key: string): NoticePost[]
  /** Every stub's `chat.postMessage` calls, per key (for `assertNoLeak`). */
  allPosts(): Record<string, NoticePost[]>
  /** Total `chat.postMessage` calls across every stub. */
  totalPosts(): number
}

/** Build the real persona notifier over one stub Slack per persona of `config`. */
export function makeNotifierHarness(
  config: Pick<PersonaConfig, 'personas'>,
  opts: NotifierHarnessOptions = {},
): NotifierHarness {
  const personas = [...config.personas]
  const stubs = new Map<string, StubSlack>()
  for (const p of personas) {
    const post = opts.post?.[p.key]
    stubs.set(p.key, makeStubSlack({ leakMarker: opts.leakMarker, ...(post ? { post } : {}) }))
  }
  const initial = opts.validated ?? true
  const validated = new Set<string>(
    initial === true ? personas.map((p) => p.key) : initial === false ? [] : initial,
  )
  const logs: string[] = []
  let dryRun = opts.dryRun ?? false
  const getPersona = (key: string): Persona | undefined => personas.find((p) => p.key === key)
  const clientFor = (key: string): WebClient | undefined =>
    validated.has(key) ? (stubs.get(key)?.web as unknown as WebClient | undefined) : undefined
  const log = (line: string): void => {
    logs.push(line)
  }
  const { notifier, hold, destinations, clock } = makeNotifierStack({
    getPersona,
    clientFor,
    clock: opts.clock,
    isDryRun: () => dryRun,
    log,
  })

  function stub(key: string): StubSlack {
    const s = stubs.get(key)
    if (!s) throw new Error(`makeNotifierHarness: no persona with key ${JSON.stringify(key)}`)
    return s
  }

  const posts = (key: string): NoticePost[] => stub(key).calls.postMessage as NoticePost[]

  return {
    notifier,
    personas,
    stubs,
    validated,
    logs,
    clock,
    hold,
    destinations,
    stub,
    validate: (key) => {
      validated.add(key)
    },
    setDryRun: (on) => {
      dryRun = on
    },
    posts,
    allPosts: () => Object.fromEntries([...stubs.keys()].map((k) => [k, posts(k)])),
    totalPosts: () => [...stubs.values()].reduce((n, s) => n + s.calls.postMessage.length, 0),
  }
}
