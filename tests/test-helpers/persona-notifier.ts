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
 * - `log` appends to `logs`.
 *
 * The harness installs nothing: pass `h.notifier.notify` to the notice site
 * under test (`setSessionNotifier`, `initOutageState({ notify })`, the
 * safeguard's `notify` argument).
 *
 * Isolation (b.av2 SR-13.2): no module-scope state, no I/O, no timers, no
 * token literal. The stubs' failures carry `leakMarker` when given.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'

import type { Persona, PersonaConfig } from '../../src/config.ts'
import { createPersonaNotifier, type PersonaNotifier } from '../../src/persona-notifier.ts'
import { makeStubSlack, type StubSlack, type WebApiOutcome } from './slack-stub.ts'

/** One captured `chat.postMessage` call, as the notifier makes it. */
export interface NoticePost {
  channel: string
  text: string
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
  /** The notifier's log lines, in order. */
  readonly logs: string[]
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

  const notifier = createPersonaNotifier({
    getPersona: (key) => personas.find((p) => p.key === key),
    clientFor: (key) => (validated.has(key) ? (stubs.get(key)?.web as unknown as WebClient | undefined) : undefined),
    isDryRun: () => dryRun,
    log: (line) => {
      logs.push(line)
    },
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
