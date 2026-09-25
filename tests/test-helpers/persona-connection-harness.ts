/**
 * test-helpers/persona-connection-harness.ts — Personas on the real
 * connection manager, with the server's connection seams built from the
 * factories `src/persona-start.ts` exports (b.av2 SR-3.1, SR-3.4, SR-7.2).
 *
 * `makeConnectionHarness(specs, baseDir, opts?)` builds:
 * - a resolved persona config over `specs` (`makeMultiPersonaConfig`), read by
 *   every seam at call time (`h.config`; set it to change the applied set);
 * - the real `createPersonaConnectionManager` over the shared stub factory
 *   (`makeStubSlackFactory`, one stub per persona with the leak marker on) and
 *   a fake clock. Each persona's tokens are distinct sentinel-bearing fakes;
 *   in dry run no stub or token is registered. `opts.serialize` is handed to
 *   the manager as its `serialize`, as `server.ts` wires it (none by default);
 * - `clientFor` = `createPersonaClientLookup(manager, () => h.config)` and
 *   `identityFor` = `createPersonaIdentityLookup(manager, () => h.config)`,
 *   the lookups `server.ts` builds;
 * - late-bound `onEvent` and `onStatus` seams (`h.onEvent`, `h.onStatus`), so
 *   a test can build the event router over `h.clientFor` and then plug it in.
 *   The default `onEvent` acks and records nothing else;
 * - with `files: true`, each persona's credentials file (mode 0600, holding
 *   exactly its two fake tokens, via `writeCredentialsFile`) and its working
 *   directory, so the real start procedure (`createPersonaBringUpController`,
 *   alone or as `startupSessionManager`'s `bringUp`) passes steps 1 and 2 for
 *   it. A test breaks one by removing or replacing it afterwards;
 * - `h.connections`: a recording stand-in for the manager's `bringUp`, to pass
 *   as the start procedure's `connections`. Each call appends `slack:<key>` to
 *   `h.order` and a record to `h.bringUpCalls` (whether it got tokens, and
 *   whether they are the persona's own), then delegates to `h.manager`.
 *   `h.order` is a shared step log: a test may append its own markers.
 *
 * Call `h.manager.stopAll()` after each test (the harness schedules nothing on
 * a real timer, but a live stub socket keeps its listeners).
 *
 * Isolation (b.av2 SR-13.2): every persona path is under the caller's
 * `baseDir`, and nothing is created on disk unless `files` is set (then only
 * under those paths); no network, no environment access, no real timer, no
 * token literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync } from 'node:fs'
import { relative } from 'node:path'

import type { WebClient } from '@slack/web-api'

import type { Persona, PersonaConfig } from '../../src/config.ts'
import {
  createPersonaConnectionManager,
  type PersonaConnectionManager,
  type PersonaConnectionStatus,
  type PersonaEventHandler,
  type PersonaStatusListener,
} from '../../src/persona-connections.ts'
import { PersonaSlackTokens } from '../../src/persona-credentials.ts'
import type { PersonaSerialize } from '../../src/persona-serializer.ts'
import type { SlackBotIdentity } from '../../src/persona-slack-validation.ts'
import { createPersonaClientLookup, createPersonaIdentityLookup } from '../../src/persona-start.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeStubSlackFactory, type StubSlack, type StubSlackFactory, type StubSlackOptions } from './slack-stub.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, fakeToken, writeCredentialsFile } from './credentials.ts'

export interface ConnectionHarnessOptions {
  /** Dry run (SR-3.4): no stub is registered and no token is handed to the manager. */
  dryRun?: boolean
  /** Per-persona-name stub options, merged over the leak marker. */
  stubOptions?: Readonly<Record<string, StubSlackOptions>>
  /** Server-wide config overrides. */
  overrides?: Partial<Omit<PersonaConfig, 'personas'>>
  /** Write each persona's credentials file (its own fake tokens) and create its working directory. */
  files?: boolean
  /**
   * Per-persona-name tokens to register (and, with `files`, write) instead of
   * the default `<key>-bot` / `<key>-app` fakes, e.g. a rotated set. Each must
   * be sentinel-bearing (`fakeToken`) and distinct from every other persona's.
   */
  tokens?: Readonly<Record<string, PersonaSlackTokens>>
  /**
   * The per-persona serializer's `run` handed to the manager as its
   * `serialize` (bug b.ujn: the network close of a socket detached by a
   * refused Web API call waits for the persona's turn), so the manager is
   * wired as `server.ts` wires it (`serialize: personaLifecycle.run`). Omitted:
   * the manager gets none and that close runs at once.
   */
  serialize?: PersonaSerialize
}

/** One call of `h.connections.bringUp`. A boolean, so a failure never prints a token. */
export interface HarnessBringUpCall {
  key: string
  /** The call was handed tokens (never in dry run). */
  gotTokens: boolean
  /** The tokens handed over are exactly this persona's own. */
  ownTokens: boolean
}

export interface ConnectionHarness {
  /** The applied config every seam reads at call time; null for none. */
  config: PersonaConfig | null
  /** The personas as built (independent of later `config` edits). */
  readonly personas: readonly Persona[]
  /** The persona by name. */
  p(name: string): Persona
  /** The applied persona with this key (the server's `getAppliedPersona`), read at call time. */
  getPersona(key: string): Persona | undefined
  /** The persona's fake tokens (never print them; they are sentinel-bearing). */
  tokens(persona: Persona): PersonaSlackTokens
  /** The persona's stub: `socket` is its latest socket client. Throws in dry run. */
  stub(persona: Persona): StubSlack
  readonly slack: StubSlackFactory
  readonly clock: FakeClock
  readonly manager: PersonaConnectionManager
  /** `createPersonaClientLookup(manager, () => h.config)`. */
  clientFor(key: string): WebClient | undefined
  /** `createPersonaIdentityLookup(manager, () => h.config)`. */
  identityFor(key: string): SlackBotIdentity | undefined
  /** The manager's event handler, read at each event. */
  onEvent: PersonaEventHandler
  /** The manager's status listener, read at each status change; none by default. */
  onStatus: PersonaStatusListener | undefined
  /** Every line the manager logged. */
  readonly lines: string[]
  /** Every status the manager reported, with its key. */
  readonly statuses: Array<[string, PersonaConnectionStatus]>
  /** Bring one persona up with its tokens (none in dry run); resolves with the first attempt's status. */
  bringUp(persona: Persona): Promise<PersonaConnectionStatus>
  /** The recording `bringUp` to pass as the start procedure's `connections` (see the file comment). */
  readonly connections: Pick<PersonaConnectionManager, 'bringUp'>
  /** Every `h.connections.bringUp` call, in call order. */
  readonly bringUpCalls: HarnessBringUpCall[]
  /** Shared step log: `slack:<key>` per `h.connections.bringUp` call, plus any marker a test appends. */
  readonly order: string[]
}

/** Build the harness described in the file comment. Pass the test's own `mkdtempSync` dir as `baseDir`. */
export function makeConnectionHarness(
  specs: PersonaSpec[],
  baseDir: string,
  opts: ConnectionHarnessOptions = {},
): ConnectionHarness {
  const dryRun = opts.dryRun ?? false
  const config = makeMultiPersonaConfig(specs, baseDir, opts.overrides)
  const personas = config.personas
  const slack = makeStubSlackFactory()
  const clock = createFakeClock()
  const tokensByKey = new Map<string, PersonaSlackTokens>()
  for (const persona of personas) {
    const tokens =
      opts.tokens?.[persona.name] ??
      new PersonaSlackTokens(
        fakeToken(BOT_TOKEN_PREFIX, `${persona.key}-bot`),
        fakeToken(APP_TOKEN_PREFIX, `${persona.key}-app`),
      )
    tokensByKey.set(persona.key, tokens)
    if (!dryRun) slack.addPersona(persona.key, tokens, { leakMarker: LEAK_SENTINEL, ...opts.stubOptions?.[persona.name] })
    if (opts.files) {
      writeCredentialsFile(baseDir, relative(baseDir, persona.credentials_file), {
        bot_token: tokens.botToken,
        app_token: tokens.appToken,
      })
      mkdirSync(persona.working_directory, { recursive: true })
    }
  }

  const lines: string[] = []
  const statuses: Array<[string, PersonaConnectionStatus]> = []
  const order: string[] = []
  const bringUpCalls: HarnessBringUpCall[] = []
  const manager = createPersonaConnectionManager({
    dryRun,
    factory: slack.factory,
    clock,
    log: (line) => void lines.push(line),
    onStatus: (key, status) => {
      statuses.push([key, status])
      return h.onStatus?.(key, status)
    },
    onEvent: (key, eventName, payload) => h.onEvent(key, eventName, payload),
    ...(opts.serialize === undefined ? {} : { serialize: opts.serialize }),
  })

  const h: ConnectionHarness = {
    config,
    personas,
    p(name) {
      const found = personas.find((x) => x.name === name)
      if (!found) throw new Error(`persona-connection-harness: no persona ${name}`)
      return found
    },
    getPersona: (key) => h.config?.personas.find((x) => x.key === key),
    tokens(persona) {
      const tokens = tokensByKey.get(persona.key)
      if (!tokens) throw new Error(`persona-connection-harness: no tokens for ${persona.name}`)
      return tokens
    },
    stub: (persona) => slack.persona(persona.key),
    slack,
    clock,
    manager,
    clientFor: createPersonaClientLookup(manager, () => h.config),
    identityFor: createPersonaIdentityLookup(manager, () => h.config),
    onEvent: async (_key, _eventName, payload) => {
      await payload.ack()
    },
    onStatus: undefined,
    lines,
    statuses,
    bringUp: (persona) => manager.bringUp(persona, dryRun ? undefined : h.tokens(persona)),
    connections: {
      bringUp: (persona, tokens) => {
        order.push(`slack:${persona.key}`)
        const own = tokensByKey.get(persona.key)
        bringUpCalls.push({
          key: persona.key,
          gotTokens: tokens !== undefined,
          ownTokens: own !== undefined && tokens?.botToken === own.botToken && tokens?.appToken === own.appToken,
        })
        return manager.bringUp(persona, tokens)
      },
    },
    bringUpCalls,
    order,
  }
  return h
}
