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
 * - the notifier's startup-errors recorder (b.jg5 SRJ-1003, SRJ-1013) is the
 *   real `recordStartupError` over `h.logDir`, a `startup-errors` directory
 *   under the harness's own temp root, which is made at the first entry
 *   written (a harness that writes none makes no directory) and removed by
 *   `h.cleanup()`; `h.startupEntries()` answers the entries written there,
 *   in order, each parsed into its class and text. `recordStartupError:
 *   null` builds the notifier with no recorder, and a function replaces the
 *   default one;
 * - `h.openTeardown(persona)` drives the persona teardown window as
 *   `runTeardown` does (`src/persona-lifecycle.ts`): the submit, then the
 *   window opened; the handle's `close()` closes the window and ends the
 *   submit. `h.duringTeardown(persona, body)` runs `body` inside one.
 *
 * `readStartupEntries(logDir)` is the one reader of a test's startup-errors
 * entries: the entries in `<logDir>/startup-errors.log`, in order, each as
 * its class and text (`StartupEntry`); `h.startupEntries()` reads the
 * harness's own `logDir` with it.
 *
 * `teardownNoticeLine(persona, text, occasion?, classLabel?)` is the window's
 * log line for that notice (`personaTeardownNoticeWrittenLine`), with the
 * same arguments as `teardownNoticeEntry` below.
 *
 * `teardownNoticeEntry(persona, text, occasion?)` is the parsed entry the
 * window writes for a notice: the class `persona-teardown-notice` and the
 * text `personaTeardownNoticeEntryText` builds from the persona reference,
 * the occasion and the notice's text, flattened to one line as the recorder
 * writes it; `teardownNoticeEntry(persona, text, occasion, classLabel)`
 * gives another class (the survivor version's `persona-kill-survivor`).
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
 * Isolation (b.av2 SR-13.2): no module-scope state, no real timers, no token
 * literal, and no I/O but the startup-errors entries, written only under the
 * harness's own temp root (a test that can open a teardown window calls
 * `h.cleanup()` after it). The stubs' failures carry `leakMarker` when given.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebClient } from '@slack/web-api'

import type { Persona, PersonaConfig } from '../../src/config.ts'
import { createPersonaDestinationHold, type PersonaDestinationHold } from '../../src/persona-destination-hold.ts'
import { createPersonaDestinations, type PersonaDestinations } from '../../src/persona-destination.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'
import {
  PERSONA_TEARDOWN_NOTICE_LABEL,
  PERSONA_TEARDOWN_NOTICE_RAISED,
  createPersonaNotifier,
  personaTeardownNoticeEntryText,
  personaTeardownNoticeWrittenLine,
  type PersonaNotifier,
  type PersonaStartupErrorRecorder,
  type PersonaTeardownNoticeOccasion,
} from '../../src/persona-notifier.ts'
import { recordStartupError } from '../../src/startup-errors.ts'
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
  /** The notifier's startup-errors recorder (b.jg5 SRJ-1003). Default: none installed. */
  recordStartupError?: PersonaStartupErrorRecorder
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
    ...(deps.recordStartupError !== undefined ? { recordStartupError: deps.recordStartupError } : {}),
  })
  return { notifier, hold, destinations, clock }
}

/** One parsed `startup-errors.log` entry: its class and its text (after the timestamp and the class). */
export interface StartupEntry {
  classLabel: string
  text: string
}

/** The one-line form `recordStartupError` writes a message in (its line breaks become spaces). */
function flattenEntryText(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
}

/**
 * The parsed entry the persona teardown window writes for a notice of
 * `persona` (b.jg5 SRJ-1003, SRJ-1013): `classLabel` (default
 * `persona-teardown-notice`) and the text `personaTeardownNoticeEntryText`
 * builds from the persona reference (`persona "<name>" (key=<key>)`), the
 * occasion (default "raised during its teardown") and `text`, on one line.
 */
export function teardownNoticeEntry(
  persona: Pick<Persona, 'name' | 'key'>,
  text: string,
  occasion: PersonaTeardownNoticeOccasion = PERSONA_TEARDOWN_NOTICE_RAISED,
  classLabel: string = PERSONA_TEARDOWN_NOTICE_LABEL,
): StartupEntry {
  return {
    classLabel,
    text: flattenEntryText(personaTeardownNoticeEntryText(`persona ${renderPersonaRef(persona.name, persona.key)}`, text, occasion)),
  }
}

/**
 * The one log line the persona teardown window writes for a notice of
 * `persona` whose entry was written (b.jg5 SRJ-1003, SRJ-1002): the builder
 * `personaTeardownNoticeWrittenLine`, with `teardownNoticeEntry`'s arguments
 * and defaults (the occasion "raised during its teardown", the class
 * `persona-teardown-notice`).
 */
export function teardownNoticeLine(
  persona: Pick<Persona, 'name' | 'key'>,
  text: string,
  occasion: PersonaTeardownNoticeOccasion = PERSONA_TEARDOWN_NOTICE_RAISED,
  classLabel: string = PERSONA_TEARDOWN_NOTICE_LABEL,
): string {
  return personaTeardownNoticeWrittenLine(persona, classLabel, occasion, text)
}

/**
 * The entries the real `recordStartupError` wrote to `startup-errors.log` in
 * `logDir`, in order, each parsed into its class and text (the timestamp
 * dropped); none when the file is absent. Throws on a line that is not an
 * entry. The one reader of a test's startup-errors entries.
 */
export function readStartupEntries(logDir: string): StartupEntry[] {
  const path = join(logDir, 'startup-errors.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = STARTUP_ENTRY_RE.exec(line)
      if (match === null) throw new Error(`readStartupEntries: not a startup-errors entry: ${JSON.stringify(line)}`)
      return { classLabel: match[1]!, text: match[2]! }
    })
}

/** A persona teardown window opened by `openTeardown`. */
export interface TeardownWindowHandle {
  /** Close the window and end the submit, as the teardown's completion does. Acts once. */
  close(): void
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
  /**
   * The notifier's startup-errors recorder. Default (undefined): the real
   * `recordStartupError` over `logDir`; `null`: none installed; a function:
   * that one.
   */
  recordStartupError?: PersonaStartupErrorRecorder | null
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
  /** The directory the default recorder writes `startup-errors.log` in (made at its first entry). */
  readonly logDir: string
  /** The `startup-errors.log` path under `logDir` (for `writtenFile`; it may not exist). */
  readonly startupErrorsPath: string
  /** The entries written to `startupErrorsPath`, in order, parsed; none when the file does not exist. */
  startupEntries(): StartupEntry[]
  /**
   * Open `persona`'s teardown window as `runTeardown` does: its submit
   * (`submitTeardown`), then the window (`openTeardownWindow`).
   */
  openTeardown(persona: Pick<Persona, 'name' | 'key'>): TeardownWindowHandle
  /** Run `body` inside `persona`'s teardown window (`openTeardown`), closed however `body` ends. */
  duringTeardown<T>(persona: Pick<Persona, 'name' | 'key'>, body: () => T | Promise<T>): Promise<T>
  /** Remove the harness's temp root (the startup-errors directory with it). Safe to call more than once. */
  cleanup(): void
}

/** `[<timestamp>] [<class>] <text>`: a `recordStartupError` line with no cause. */
const STARTUP_ENTRY_RE = /^\[[^\]]*\] \[([^\]]*)\] (.*)$/

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
  // The temp root is made at the first entry written, so a harness that
  // writes none leaves nothing behind.
  let root: string | undefined
  const rootDir = (): string => (root ??= mkdtempSync(join(tmpdir(), 'cscb-notifier-harness-')))
  const logDirName = 'startup-errors'
  let logDir: string | undefined
  const ensureLogDir = (): string => {
    if (logDir === undefined) {
      logDir = join(rootDir(), logDirName)
      mkdirSync(logDir, { recursive: true })
    }
    return logDir
  }
  const recorder: PersonaStartupErrorRecorder | undefined =
    opts.recordStartupError === null
      ? undefined
      : (opts.recordStartupError ?? ((classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir: ensureLogDir() })))
  const { notifier, hold, destinations, clock } = makeNotifierStack({
    getPersona,
    clientFor,
    clock: opts.clock,
    isDryRun: () => dryRun,
    log,
    ...(recorder !== undefined ? { recordStartupError: recorder } : {}),
  })

  function stub(key: string): StubSlack {
    const s = stubs.get(key)
    if (!s) throw new Error(`makeNotifierHarness: no persona with key ${JSON.stringify(key)}`)
    return s
  }

  const posts = (key: string): NoticePost[] => stub(key).calls.postMessage as NoticePost[]

  const startupErrorsPath = (): string => join(logDir ?? join(rootDir(), logDirName), 'startup-errors.log')

  function startupEntries(): StartupEntry[] {
    return logDir === undefined ? [] : readStartupEntries(logDir)
  }

  function openTeardown(persona: Pick<Persona, 'name' | 'key'>): TeardownWindowHandle {
    notifier.submitTeardown(persona.key)
    notifier.openTeardownWindow(persona)
    let closed = false
    return {
      close: () => {
        if (closed) return
        closed = true
        notifier.closeTeardownWindow(persona.key)
        notifier.settleTeardown(persona.key)
      },
    }
  }

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
    get logDir() {
      return logDir ?? join(rootDir(), logDirName)
    },
    get startupErrorsPath() {
      return startupErrorsPath()
    },
    startupEntries,
    openTeardown,
    duringTeardown: async (persona, body) => {
      const window = openTeardown(persona)
      try {
        return await body()
      } finally {
        window.close()
      }
    },
    cleanup: () => {
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
      root = undefined
      logDir = undefined
    },
  }
}
