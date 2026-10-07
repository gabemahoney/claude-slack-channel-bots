/**
 * upgrade-0-11-1.test.ts — An upgrade from 0.11.1 stays declarative (b.deo
 * SRI-1307, SRI-106, SRI-1204).
 *
 * What this suite proves: a 0.11.1 `config.json`, with neither the
 * `allow_invited_channels` switch nor any `invited` section, loads unchanged
 * and behaves as 0.11.1 did. Each fixture below, written into a temp state
 * directory:
 *
 * - keeps its bytes, through `loadPersonaConfig` and through a reload-harness
 *   start, a start over its last-applied record and a confirmed 0.11.1-style
 *   edit; the record is a byte copy of the file at each step;
 * - runs in declarative mode, with no fungible destination and no `invited`
 *   section on any persona;
 * - never gets a stored-choice file (`CHANNEL_DELIVERY_FILE_NAME`);
 * - logs, previews and posts nothing that names the switch, fungible mode or
 *   a class this work adds (the term list below), so no line suggests
 *   fungible mode (SRI-106) and, with the switch absent, no recorded line
 *   can appear (SRI-804);
 * - previews a 0.11.1-style edit as the counted header and the persona's
 *   in-place line, and once it is confirmed updates only that persona in
 *   place, with the edit in effect for the next event;
 * - posts each notice to the persona's `permission_prompts` destination;
 * - decides sample events from listed and unlisted channels as SRI-308 says;
 * - lists `set_channel_delivery` and refuses it with the declarative
 *   refusal, and sends `MCP_INSTRUCTIONS` as the session instructions: the
 *   two agent-visible additions SRI-106 allows.
 *
 * Fixtures (SRI-1204), owned by this suite and pinned by SHA-256 so an edit
 * to either fails:
 *
 * - `tests/fixtures/upgrade-0.11.1/readme-example.json`: the json block
 *   under "#### Example" in "### Personas (config.json)" of the README at
 *   `619a67a` (0.11.1), byte for byte: the lines between the opening and
 *   closing fences, fence lines excluded, the last line's newline included.
 *   Its `"port": 3100` is as the README has it; no case binds or reaches a
 *   port.
 * - `tests/fixtures/upgrade-0.11.1/two-personas.json`: the shape of
 *   SRI-1405's phase A, the configuration test-29's declarative phase
 *   writes, with fixed IDs and `~/` paths: `alpha` in A1 (`all`) and A2
 *   (`mentions`), DMs off, prompts to A1; `bravo` in B1 (`mentions`), DMs on
 *   with a contact, prompts by `"dm"`; SRI-1401's server-wide keys.
 *
 * Every `~/` path expands under a temp home inside the test's own
 * `mkdtempSync` root, never the operator's home (SRI-1201). Tokens are the
 * fakes of `tests/test-helpers/credentials.ts`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES,
  CHANNEL_DELIVERY_FILE_NAME,
  CHANNEL_DELIVERY_LOG_PREFIX,
  SET_CHANNEL_DELIVERY_TOOL,
} from '../src/channel-delivery.ts'
import {
  CHANNEL_MODES,
  channelModeOf,
  DM_DESTINATION,
  loadPersonaConfig,
  PERSONA_TOP_LEVEL_KEYS,
  type ChannelEntryInput,
  type PersonaDmInput,
} from '../src/config.ts'
import type { Via } from '../src/delivery-decision.ts'
import { FUNGIBLE_MODE_ZERO_REASON } from '../src/jsonl-persistence-check.ts'
import { FUNGIBLE_DESTINATION_SETTING } from '../src/persona-destination.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  FUNGIBLE_REFUSAL_TEXTS,
  formatPersonaDiagnostic,
  PERSONA_CHANNEL_DELIVERY_SET,
  PERSONA_INVITED_CHANNEL,
  PERSONA_START,
  UNCLAIMED_CHANNEL,
  unclaimedChannelCause,
} from '../src/persona-diagnostics.ts'
import {
  channelDeliveryDeclarativeRefusal,
  createSessionServer,
  FUNGIBLE_TARGET_REFUSAL,
  MCP_INSTRUCTIONS,
  type SessionToolDeps,
} from '../src/registry.ts'
import { RELOAD_APPLIED } from '../src/reload-apply.ts'
import {
  MODE_SWITCH_SETTING,
  modeSwitchLine,
  PENDING_PREVIEW_TITLE,
  RECORDED_SECTION_KEYS,
  RELOAD_PREVIEW,
  recordedLine,
  renderChangePlanCounts,
  type ChangePlanCounts,
  type InPlaceSetting,
  type RecordedSectionKey,
} from '../src/reload-plan.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  makeReloadHarness,
  NO_RUN_ACTIVITY,
  type ReloadHarness,
  type ReloadRun,
  type StartedReloadRun,
} from './test-helpers/reload-harness.ts'
import { makeAppMention, makeChannelMessage, mentionText, stubOpenedDmId, type SlackEvent } from './test-helpers/slack-stub.ts'

// ---------------------------------------------------------------------------
// The fixtures (b.deo SRI-1204): paths and bytes, read once
// ---------------------------------------------------------------------------

/** A persona entry as a 0.11.1 fixture writes it. */
interface FixturePersona {
  name: string
  credentials_file: string
  working_directory: string
  channels?: ChannelEntryInput[]
  dm?: PersonaDmInput
  permission_prompts: string
}

/** A fixture's top level as written. */
interface FixtureInput {
  personas: FixturePersona[]
  [setting: string]: unknown
}

interface UpgradeFixture {
  /** The file name under `tests/fixtures/upgrade-0.11.1/`. */
  readonly file: string
  readonly path: string
  /** The committed bytes, read once. */
  readonly bytes: Buffer
  /** The bytes parsed: the expected values come from here, never retyped. */
  readonly input: FixtureInput
}

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'upgrade-0.11.1')

function readFixture(file: string): UpgradeFixture {
  const path = join(FIXTURE_DIR, file)
  const bytes = readFileSync(path)
  return { file, path, bytes, input: JSON.parse(bytes.toString('utf-8')) as FixtureInput }
}

/** The README at `619a67a`, "#### Example": planner, reviewer and helpdesk. */
const README_EXAMPLE = readFixture('readme-example.json')
/** SRI-1405's phase A: alpha and bravo. */
const TWO_PERSONAS = readFixture('two-personas.json')
const FIXTURES = [README_EXAMPLE, TWO_PERSONAS] as const

/**
 * Each fixture's SHA-256, computed once from the committed bytes. An edit to
 * either fixture fails its pin case; a deliberate change updates the digest
 * in the same change.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  'readme-example.json': '246d9980ce8e9c8ace2e1a3dd210079d6cd673f4430f2f62aedc231a59c914a2',
  'two-personas.json': '899bea04546bbc87425dc2ccace7ba719efb2a77903626695036a62c288a92b4',
}

/** The fixture's channel personas: those that list at least one channel. */
function channelPersonas(fixture: UpgradeFixture): FixturePersona[] {
  return fixture.input.personas.filter((p) => (p.channels ?? []).length > 0)
}

// ---------------------------------------------------------------------------
// The term list (b.deo SRI-106, SRI-1307) and its checker
// ---------------------------------------------------------------------------

/** One term: a label naming its `src/` export, and the text. */
interface Term {
  readonly label: string
  readonly text: string
}

/**
 * The start every switch preview line shares for `mode`, whichever personas
 * it names: the common prefix of `modeSwitchLine`'s two forms.
 */
function modeSwitchLineHead(mode: (typeof CHANNEL_MODES)[number]): string {
  const none = modeSwitchLine(mode, [])
  const some = modeSwitchLine(mode, [{ name: 'p', key: 'p' }])
  let i = 0
  while (i < none.length && none[i] === some[i]) i++
  return none.slice(0, i)
}

/**
 * What no log line, preview or pending-file text, or Slack-posted text of a
 * 0.11.1 configuration may carry. Every entry is imported from `src/`. It
 * does not apply to `set_channel_delivery`'s listing, its declarative
 * refusal or the session instructions: SRI-106 allows those additions, and
 * they are checked by equality with their exported texts.
 */
const TERM_LIST: readonly Term[] = [
  { label: 'PERSONA_INVITED_CHANNEL', text: PERSONA_INVITED_CHANNEL },
  { label: 'PERSONA_CHANNEL_DELIVERY_SET', text: PERSONA_CHANNEL_DELIVERY_SET },
  ...CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES.map((text) => ({ label: `CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES ${text}`, text })),
  { label: 'CHANNEL_DELIVERY_LOG_PREFIX', text: CHANNEL_DELIVERY_LOG_PREFIX },
  { label: 'CHANNEL_DELIVERY_FILE_NAME', text: CHANNEL_DELIVERY_FILE_NAME },
  { label: 'FUNGIBLE_DESTINATION_SETTING', text: FUNGIBLE_DESTINATION_SETTING },
  // The switch's key. Its membership in the top-level keys is pinned below,
  // so a rename fails the suite instead of leaving this entry checking nothing.
  { label: 'MODE_SWITCH_SETTING', text: MODE_SWITCH_SETTING },
  ...CHANNEL_MODES.map((mode) => ({ label: `modeSwitchLine(${mode})`, text: modeSwitchLineHead(mode) })),
  ...Object.entries(FUNGIBLE_REFUSAL_TEXTS).map(([refusal, text]) => ({ label: `FUNGIBLE_REFUSAL_TEXTS ${refusal}`, text })),
  { label: 'FUNGIBLE_TARGET_REFUSAL', text: FUNGIBLE_TARGET_REFUSAL },
  { label: 'FUNGIBLE_MODE_ZERO_REASON', text: FUNGIBLE_MODE_ZERO_REASON },
]

/**
 * Beside the list: the words "fungible" and "invited", in any case. SRI-106
 * says no line may suggest fungible mode, and the 0.11.1 source holds
 * neither word.
 */
const SUGGESTIVE_WORDS = /fungible|invited/i

/** Which term-list entries `text` carries (by label), and the word check's hit; `[]` when none. */
function termsIn(text: string): string[] {
  const hits = TERM_LIST.filter((t) => text.includes(t.text)).map((t) => t.label)
  const word = SUGGESTIVE_WORDS.exec(text)
  if (word !== null) hits.push(`word "${word[0]}"`)
  return hits
}

/** Each of `texts` that carries a term, with what it carries: `{}` when none does. */
function termHits(texts: readonly string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {}
  texts.forEach((text, i) => {
    const found = termsIn(text)
    if (found.length > 0) hits[`${i}: ${text}`] = found
  })
  return hits
}

// ---------------------------------------------------------------------------
// The rig: one mkdtempSync root per test, holding a temp home
// ---------------------------------------------------------------------------

interface Rig {
  readonly root: string
  /** The temp home every `~/` expands under. */
  readonly home: string
  /** The temp state directory a direct load reads `config.json` from. */
  readonly stateDir: string
}

let rig: Rig | undefined
let harness: ReloadHarness | undefined
const listingClients: Client[] = []

function makeRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-0-11-1-'))
  const home = join(root, 'home')
  const stateDir = join(root, 'state')
  mkdirSync(home)
  mkdirSync(stateDir)
  rig = { root, home, stateDir }
  return rig
}

/** A reload harness under this test's rig root. */
function makeHarness(): ReloadHarness {
  harness = makeReloadHarness({ parentDir: (rig ?? makeRig()).root })
  return harness
}

/** Close every listing client, each in its own `try`, so one throwing close never skips the next or the cleanup. */
async function closeListingClients(clients: readonly Client[]): Promise<void> {
  const [client, ...rest] = clients
  if (client === undefined) return
  try {
    await client.close()
  } finally {
    await closeListingClients(rest)
  }
}

afterEach(async () => {
  try {
    await closeListingClients(listingClients.splice(0))
  } finally {
    try {
      if (harness !== undefined) await harness.cleanup()
    } finally {
      harness = undefined
      if (rig !== undefined) rmSync(rig.root, { recursive: true, force: true })
      rig = undefined
    }
  }
})

/** Every file named `name` anywhere under `dir`. */
function filesNamed(dir: string, name: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesNamed(path, name))
    else if (entry.name === name) found.push(path)
  }
  return found
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `~/…` expanded under `home`; a fixture writes only `~/` paths. */
function underHome(home: string, path: string): string {
  if (!path.startsWith('~/')) throw new Error(`upgrade fixture path is not a ~/ path: ${JSON.stringify(path)}`)
  return join(home, path.slice(2))
}

/** The resolved `dm` a 0.11.1 entry gives: `enabled` false when unset, the contact when written. */
function resolvedDm(entry: FixturePersona): { enabled: boolean; contact?: string } {
  const contact = entry.dm?.contact
  return { enabled: entry.dm?.enabled === true, ...(contact === undefined ? {} : { contact }) }
}

// ---------------------------------------------------------------------------
// The switch key's pin, the fixtures' pins and the direct load
// ---------------------------------------------------------------------------

describe('upgrade fixtures and the term list (b.deo SRI-1204, SRI-1201, SRI-106)', () => {
  test('the switch key in the term list is a top-level key the loader accepts (its single pin, SRI-1201)', () => {
    expect(PERSONA_TOP_LEVEL_KEYS).toContain(MODE_SWITCH_SETTING)
  })

  // Positive controls: the checker reports each term, and each suggestive word in mixed case, inside other text.
  test.each(TERM_LIST.map((t) => [t.label, t] as const))('the checker reports term %s inside other text', (_label, t) => {
    expect(termsIn(`x ${t.text} y`)).toContain(t.label)
  })

  test.each([
    ['fungible', 'a FunGible mode', 'FunGible'],
    ['invited', 'an InViTed channel', 'InViTed'],
  ])('the checker reports the word "%s" in mixed case', (_word, text, hit) => {
    expect(termsIn(text)).toEqual([`word "${hit}"`])
  })

  test.each(FIXTURES.map((f) => [f.file, f] as const))('%s has its pinned SHA-256', (_file, fixture) => {
    expect(sha256(readFileSync(fixture.path))).toBe(PINNED_SHA256[fixture.file]!)
  })

  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s holds neither the switch nor an invited section',
    (_file, fixture) => {
      expect(termsIn(fixture.bytes.toString('utf-8'))).toEqual([])
    },
  )
})

describe('a 0.11.1 configuration loaded directly stays declarative (b.deo SRI-1307, SRI-106)', () => {
  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s loads through loadPersonaConfig in declarative mode with its bytes unchanged, no load-time message and no stored-choice file',
    (_file, fixture) => {
      const { home, stateDir } = makeRig()
      const configPath = join(stateDir, 'config.json')
      writeFileSync(configPath, fixture.bytes)
      const messages: unknown[][] = []
      const spies = (['error', 'warn', 'log', 'info'] as const).map((method) =>
        spyOn(console, method).mockImplementation((...args: unknown[]) => void messages.push(args)),
      )
      let config: ReturnType<typeof loadPersonaConfig>
      try {
        config = loadPersonaConfig(configPath, home)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }

      expect(readFileSync(configPath).equals(fixture.bytes)).toBe(true)
      expect(channelModeOf(config)).toBe('declarative')
      expect(config.personas.map((p) => ({ fungible: p.fungible_destination, invited: p.sections.invited }))).toEqual(
        fixture.input.personas.map(() => ({ fungible: undefined, invited: undefined })),
      )
      expect(
        config.personas.map((p) => ({ name: p.name, channels: p.channels, dm: p.dm, permission_prompts: p.permission_prompts })),
      ).toEqual(
        fixture.input.personas.map((entry) => ({
          name: entry.name,
          channels: entry.channels ?? [],
          dm: resolvedDm(entry),
          permission_prompts: entry.permission_prompts,
        })),
      )
      expect(filesNamed(rig!.root, CHANNEL_DELIVERY_FILE_NAME)).toEqual([])
      // The loader prints nothing for a valid configuration, so the check is
      // that nothing was printed at all, which also rules out every term.
      expect(messages).toEqual([])
      assertNoLeak({ config, messages })
    },
  )
})

// ---------------------------------------------------------------------------
// Reload-harness starts: the fixture-start helper
// ---------------------------------------------------------------------------

/** A fixture placed in a reload harness: what the operator wrote besides `config.json`. */
interface PlacedFixture {
  /** Each persona's credentials file (fake tokens), expanded under `h.home`. */
  readonly credentialsFiles: string[]
}

/**
 * Place `fixture` in the harness as an operator would before a start: its raw
 * bytes as `config.json`, and each persona's credentials file (fake tokens)
 * and working directory at the fixture's paths. The harness's file helpers
 * resolve a relative path against its root, so each `~/` path is expanded
 * under `h.home` first.
 */
function placeFixture(h: ReloadHarness, fixture: UpgradeFixture): PlacedFixture {
  h.writeConfigBytes(fixture.bytes)
  const credentialsFiles: string[] = []
  for (const entry of fixture.input.personas) {
    const files = {
      name: entry.name,
      credentials_file: underHome(h.home, entry.credentials_file),
      working_directory: underHome(h.home, entry.working_directory),
    }
    h.writeCredentials(files)
    h.makeWorkingDirectory(files)
    credentialsFiles.push(files.credentials_file)
  }
  return { credentialsFiles }
}

/** Place `fixture` (see `placeFixture`) and start a server over it with no last-applied record. */
async function startFixture(h: ReloadHarness, fixture: UpgradeFixture): Promise<{ run: StartedReloadRun; placed: PlacedFixture }> {
  const placed = placeFixture(h, fixture)
  const run = await h.start()
  return { run, placed }
}

/**
 * The facts every step leaves (b.deo SRI-1307): `config.json` holds `bytes`,
 * the last-applied record is a byte copy of them, the configuration the
 * server runs is in declarative mode with no fungible destination, and no
 * stored-choice file exists, at `h.channelDeliveryFile` or by its name
 * anywhere under the harness root.
 */
function expectDeclarativeAndUnchanged(h: ReloadHarness, run: ReloadRun, bytes: Buffer): void {
  expect({
    config: h.readConfig()?.equals(bytes),
    record: h.readRecord()?.equals(bytes),
    mode: channelModeOf(run.serverConfig()),
    fungibleDestinations: run.serverConfig()?.personas.filter((p) => p.fungible_destination !== undefined).map((p) => p.name),
    storedChoiceFile: existsSync(h.channelDeliveryFile),
    namedAnywhere: filesNamed(h.root, CHANNEL_DELIVERY_FILE_NAME),
  }).toEqual({
    config: true,
    record: true,
    mode: 'declarative',
    fungibleDestinations: [],
    storedChoiceFile: false,
    namedAnywhere: [],
  })
}

/** The text of the notice each case raises for every persona, the run's Slack-posted text. */
const PROBE_NOTICE = 'a probe notice'

/**
 * Where a persona's notice goes in declarative mode: its `permission_prompts`
 * channel, or, for `"dm"`, the DM the stub opens with its contact.
 */
function noticeTargetOf(entry: FixturePersona): string {
  if (entry.permission_prompts !== DM_DESTINATION) return entry.permission_prompts
  const contact = entry.dm?.contact
  if (contact === undefined) throw new Error(`${entry.name} sends prompts by DM but has no contact`)
  return stubOpenedDmId(contact)
}

/** The conversations the persona's stub posted to (`chat.postMessage`), in order. */
function postTargetsOf(run: ReloadRun, name: string): unknown[] {
  return run
    .stub(name)
    .callLog.filter((c) => c.method === 'chat.postMessage')
    .map((c) => (c.args as { channel?: unknown }).channel)
}

/** What the run posted to Slack, each call's arguments as text. */
function postedTexts(run: ReloadRun): string[] {
  return run.slackPosts().map((call) => JSON.stringify(call.args))
}

/**
 * No log line and no Slack-posted text of the run carries a term-list entry.
 * `control` is a class or label the run must have logged by now: its line
 * shows the capture checked is the run's real log (the positive control).
 * The first-start case's notices are the posted-text check's positive
 * control; every other case posts nothing and says so.
 */
function expectNoTerms(run: ReloadRun, control: string): void {
  expect(run.logsOf(control).length).toBeGreaterThan(0)
  expect(termHits(run.logs)).toEqual({})
  expect(termHits(postedTexts(run))).toEqual({})
}

/** `assertNoLeak` over the run's captures and every server-side file (the operator's credentials files aside). */
function expectNoLeak(h: ReloadHarness, run: ReloadRun, placed: PlacedFixture, extra?: Record<string, unknown>): void {
  assertNoLeak(run.captured(extra))
  assertNoLeak(h.serverSideFiles(...placed.credentialsFiles))
}

describe('a 0.11.1 configuration through a reload-harness start stays declarative (b.deo SRI-1307, SRI-106)', () => {
  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s, first start with no record: config.json keeps its bytes, the record is a byte copy, declarative mode, no stored-choice file, and each notice posts to its permission_prompts destination',
    async (_file, fixture) => {
      const h = makeHarness()
      const { run, placed } = await startFixture(h, fixture)

      expect(run.outcome.kind).toBe('applied')
      expectDeclarativeAndUnchanged(h, run, fixture.bytes)
      expect(run.logsOf(PERSONA_START)).toHaveLength(fixture.input.personas.length)

      const personas = fixture.input.personas
      for (const entry of personas) await run.notice(entry.name, PROBE_NOTICE)
      expect(Object.fromEntries(personas.map((entry) => [entry.name, postTargetsOf(run, entry.name)]))).toEqual(
        Object.fromEntries(personas.map((entry) => [entry.name, [noticeTargetOf(entry)]])),
      )
      expect(postedTexts(run).every((text) => text.includes(PROBE_NOTICE))).toBe(true)
      expectNoTerms(run, PERSONA_START)
      expectNoLeak(h, run, placed)
    },
  )

  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s, a start over its record (a 0.11.1 host upgrading): the same facts, the record untouched, and no pending file after detection ticks (no migration, no nag)',
    async (_file, fixture) => {
      const h = makeHarness()
      const first = await startFixture(h, fixture)
      await first.run.stop()

      const run = await h.start()
      expect(run.outcome.kind).toBe('applied')
      expect(run.writes).toEqual([])
      expectDeclarativeAndUnchanged(h, run, fixture.bytes)

      expect(run.startDetection()).toBe(true)
      const cp = run.checkpoint()
      await run.ticks.ticks(3)
      expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
      expect(h.pendingExists()).toBe(false)
      expectDeclarativeAndUnchanged(h, run, fixture.bytes)
      expect(run.slackPosts()).toEqual([])
      expectNoTerms(run, PERSONA_START)
      expectNoLeak(h, run, first.placed)
      assertNoLeak(first.run.captured())
    },
  )
})

/** A channel ID no fixture lists. */
const ADDED_CHANNEL = 'C0ADDED0001'

/** A 0.11.1-style edit of a fixture's input, and the event that shows it applied. */
interface Edit {
  readonly edit: string
  /** Edit `input` (a copy) in place; answer the persona it changes and the channel its probe goes to. */
  readonly apply: (input: FixtureInput) => { name: string; channel: string }
  /** The in-place settings the edit changes for that persona. */
  readonly settings: InPlaceSetting[]
  /** The probe sent to the changed persona in that channel once confirmed, and how the edited input says it is delivered. */
  readonly probe: { kind: 'plain' | 'mention'; via: (edited: FixtureInput, name: string, channel: string) => Via }
}

/**
 * A plain message's `via` in a channel the persona takes with `all`:
 * `receive_all_shared` when another persona also takes it with `all`
 * (README's planner and reviewer once reviewer's entry is `all`).
 */
function plainVia(edited: FixtureInput, name: string, channel: string): Via {
  const shared = edited.personas.some((p) => p.name !== name && (p.channels ?? []).some((c) => c.id === channel && c.delivery === 'all'))
  return shared ? 'receive_all_shared' : 'receive_all'
}

/** 0.11.1-style edits of a fixture's input, each on a copy. */
const EDITS: readonly Edit[] = [
  {
    edit: "a channel's delivery changed",
    apply: (input) => {
      for (const persona of input.personas) {
        const entry = (persona.channels ?? []).find((c) => c.delivery === 'mentions')
        if (entry === undefined) continue
        entry.delivery = 'all'
        return { name: persona.name, channel: entry.id }
      }
      throw new Error('the fixture lists no mentions channel')
    },
    settings: ['delivery'],
    probe: { kind: 'plain', via: plainVia },
  },
  {
    edit: 'a channel added',
    apply: (input) => {
      const persona = input.personas.find((p) => (p.channels ?? []).length > 0)
      if (persona === undefined) throw new Error('the fixture has no channel persona')
      persona.channels = [...(persona.channels ?? []), { id: ADDED_CHANNEL, delivery: 'mentions' }]
      return { name: persona.name, channel: ADDED_CHANNEL }
    },
    settings: ['channels'],
    probe: { kind: 'mention', via: () => 'mention' },
  },
]

/** A preview header's counts with nothing counted. */
const NO_COUNTS: ChangePlanCounts = { added: 0, removed: 0, destructive: 0, inPlace: 0, credentials: 0, settings: 0 }

/** Every non-empty choice of the recorded section keys, in their reported order. */
function recordedFieldSets(): RecordedSectionKey[][] {
  const sets: RecordedSectionKey[][] = []
  for (let mask = 1; mask < 1 << RECORDED_SECTION_KEYS.length; mask++) {
    sets.push(RECORDED_SECTION_KEYS.filter((_k, i) => (mask & (1 << i)) !== 0))
  }
  return sets
}

/** Every line `recordedLine` can build for a persona of `fixture`. */
function recordedLinesOf(h: ReloadHarness, fixture: UpgradeFixture): string[] {
  return fixture.input.personas.flatMap((p) =>
    recordedFieldSets().map((fields) => recordedLine({ name: p.name, key: h.key(p.name), fields })),
  )
}

describe("a 0.11.1-style edit is previewed and confirmed as in 0.11.1 (b.deo SRI-1307, SRI-106, SRI-804's switch-absent half)", () => {
  test.each(FIXTURES.flatMap((f) => EDITS.map((e) => [f.file, e.edit, f, e] as const)))(
    '%s, %s: the preview is the header and the in-place line, with no recorded line, no switch line and no term; the confirmation updates that persona in place, records the edited bytes and stays declarative',
    async (_file, _edit, fixture, edit) => {
      const h = makeHarness()
      const { run, placed } = await startWithSessions(h, fixture)
      expect(run.startDetection()).toBe(true)
      const edited = structuredClone(fixture.input)
      const { name, channel } = edit.apply(edited)
      const editedBytes = Buffer.from(`${JSON.stringify(edited, null, 2)}\n`, 'utf-8')
      h.writeConfigBytes(editedBytes)

      const beforeConfirm = run.checkpoint()
      await run.ticks.tick()
      const preview = h.pendingLines()
      expect(preview).toEqual([
        `${PENDING_PREVIEW_TITLE} ${renderChangePlanCounts({ ...NO_COUNTS, inPlace: 1 })}.`,
        startingWith(`persona ${renderPersonaRef(name, h.key(name))}: ${edit.settings.join(', ')} changed: `),
      ])
      expect(run.lastPreviewText()).toEqual(preview)
      expect(run.previewEmissionCount()).toBe(1)
      expect(run.since(beforeConfirm).lifecycle).toEqual([])
      const recorded = new Set(recordedLinesOf(h, fixture))
      expect(preview!.filter((line) => recorded.has(line))).toEqual([])
      expect(preview!.filter((line) => CHANNEL_MODES.some((mode) => line.startsWith(modeSwitchLineHead(mode))))).toEqual([])
      expect(termHits([h.readPendingText()!])).toEqual({})
      expectNoTerms(run, RELOAD_PREVIEW)
      expectNoLeak(h, run, placed)

      const atConfirm = run.checkpoint()
      h.confirm()
      await run.ticks.tick()
      expect(run.logsOf(RELOAD_APPLIED)).toHaveLength(1)
      expect(run.since(atConfirm).lifecycle).toEqual([{ op: 'update-in-place', key: h.key(name), via: 'apply', settings: edit.settings }])
      expectDeclarativeAndUnchanged(h, run, editedBytes)
      expect(h.pendingExists()).toBe(false)

      // The edit's effect: the probe reaches only the changed persona, as its edited entry says.
      const outcome = await deliverSample(run, fixture, { event: edit.edit, to: name, kind: edit.probe.kind, channel })
      expect(outcome).toEqual({ event: edit.edit, deliveries: deliveredTo(fixture, name, channel, edit.probe.via(edited, name, channel)), dropLines: [] })
      expect(run.slackPosts()).toEqual([])
      expectNoTerms(run, RELOAD_APPLIED)
      expectNoLeak(h, run, placed, { outcome })
    },
  )
})

// ---------------------------------------------------------------------------
// Sample events, set_channel_delivery and the session instructions
// ---------------------------------------------------------------------------

/** A channel ID neither fixture lists. */
const UNLISTED_CHANNEL = 'C0UNLISTED1'

/** What reached a persona's session for one sample event. */
type Delivered = Array<{ chat_id: string; via: string | undefined }>

/** One sample event's outcome: what reached every channel persona's session, and the drop lines it logged. */
interface SampleOutcome {
  readonly event: string
  readonly deliveries: Record<string, Delivered>
  readonly dropLines: string[]
}

/** A sample event: its title, the persona whose connection receives it, and its one or two Slack events. */
interface SampleEvent {
  readonly event: string
  readonly to: string
  readonly kind: 'plain' | 'mention'
  readonly channel: string
  /** Send a mention as both its events (`app_mention`, then `message` with the same ts). */
  readonly bothEvents?: boolean
}

/**
 * Whether `line` is a drop line: `unclaimed-channel`, or the plain `dropped
 * message` line. The second pins the 0.11.1 line shape of
 * `src/persona-routing.ts`, which exports no builder or prefix for it.
 */
function isDropLine(line: string): boolean {
  return line.startsWith(`[slack] ${UNCLAIMED_CHANNEL}: `) || line.includes(' dropped message from ')
}

/** Deliver `sample` on its persona's connection; return what every channel persona's session got and the drop lines. */
async function deliverSample(run: ReloadRun, fixture: UpgradeFixture, sample: SampleEvent): Promise<SampleOutcome> {
  const names = channelPersonas(fixture).map((p) => p.name)
  const before = Object.fromEntries(names.map((name) => [name, run.deliveries(name).length]))
  const fromLog = run.logs.length
  const text = sample.kind === 'mention' ? `${mentionText(run.stub(sample.to).identity.botUserId)} a probe` : 'a probe'
  const message = makeChannelMessage({ channel: sample.channel, text })
  const events: SlackEvent[] = sample.bothEvents === true
    ? [makeAppMention({ channel: sample.channel, text, ts: message['ts'] }), message]
    : [message]
  for (const event of events) await run.deliver(sample.to, event)
  return {
    event: sample.event,
    deliveries: Object.fromEntries(
      names.map((name) => [name, run.deliveries(name).slice(before[name]).map(({ chat_id, via }) => ({ chat_id, via }))]),
    ),
    dropLines: run.logs.slice(fromLog).filter(isDropLine),
  }
}

/** Nothing reached any channel persona's session. */
function noDelivery(fixture: UpgradeFixture): Record<string, Delivered> {
  return Object.fromEntries(channelPersonas(fixture).map((p) => [p.name, []]))
}

/** Only `name` got one message in `channel`, with `via`. */
function deliveredTo(fixture: UpgradeFixture, name: string, channel: string, via: Via): Record<string, Delivered> {
  return { ...noDelivery(fixture), [name]: [{ chat_id: channel, via }] }
}

/** The persona entry named `name` with its index, from the fixture's own bytes. */
function entryOf(fixture: UpgradeFixture, name: string): { entry: FixturePersona; index: number } {
  const index = fixture.input.personas.findIndex((p) => p.name === name)
  if (index < 0) throw new Error(`no persona ${JSON.stringify(name)} in ${fixture.file}`)
  return { entry: fixture.input.personas[index]!, index }
}

/** The `n`-th channel the persona lists, from the fixture's own bytes. */
function listed(fixture: UpgradeFixture, name: string, n: number): string {
  const channel = entryOf(fixture, name).entry.channels?.[n]?.id
  if (channel === undefined) throw new Error(`${name} lists no channel ${n} in ${fixture.file}`)
  return channel
}

/** The declarative `unclaimed-channel` line for the persona and channel, from its builders. */
function unclaimedLine(h: ReloadHarness, fixture: UpgradeFixture, name: string, channel: string): string {
  return formatPersonaDiagnostic({
    class: UNCLAIMED_CHANNEL,
    name,
    key: h.key(name),
    index: entryOf(fixture, name).index,
    cause: unclaimedChannelCause(channel),
  })
}

/**
 * A `not-mentioned` drop line of the persona in `channel` (the reason is the
 * line's last word). It pins the 0.11.1 line shape of
 * `src/persona-routing.ts`, which exports no builder or prefix for it.
 */
function notMentioned(h: ReloadHarness, name: string, channel: string) {
  return expect.stringMatching(
    new RegExp(`^${escapeRegExp(`[slack] persona ${renderPersonaRef(name, h.key(name))} dropped message from channel=${channel} `)}.*: not-mentioned$`),
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A matcher for a line starting with `prefix`. */
function startingWith(prefix: string) {
  return expect.stringMatching(new RegExp(`^${escapeRegExp(prefix)}`))
}

/** Start `fixture` through the fixture-start helper and register every channel persona's session. */
async function startWithSessions(h: ReloadHarness, fixture: UpgradeFixture) {
  const started = await startFixture(h, fixture)
  for (const p of channelPersonas(fixture)) started.run.registerSession(p.name)
  return started
}

/** The sample events and SRI-308's outcome for each, per fixture. */
const SAMPLES: Readonly<Record<string, (h: ReloadHarness, fixture: UpgradeFixture) => Array<readonly [SampleEvent, Omit<SampleOutcome, 'event'>]>>> = {
  // SRI-1405's phase-A set.
  'two-personas.json': (h, f) => {
    const [a1, a2, b1] = [listed(f, 'alpha', 0), listed(f, 'alpha', 1), listed(f, 'bravo', 0)]
    return [
      [{ event: 'alpha, A1, plain', to: 'alpha', kind: 'plain', channel: a1 }, { deliveries: deliveredTo(f, 'alpha', a1, 'receive_all'), dropLines: [] }],
      [{ event: 'alpha, A2, plain', to: 'alpha', kind: 'plain', channel: a2 }, { deliveries: noDelivery(f), dropLines: [notMentioned(h, 'alpha', a2)] }],
      [{ event: 'alpha, A2, mention', to: 'alpha', kind: 'mention', channel: a2 }, { deliveries: deliveredTo(f, 'alpha', a2, 'mention'), dropLines: [] }],
      [{ event: 'bravo, B1, mention', to: 'bravo', kind: 'mention', channel: b1 }, { deliveries: deliveredTo(f, 'bravo', b1, 'mention'), dropLines: [] }],
      [
        { event: 'alpha, an unlisted channel, a mention as both its events', to: 'alpha', kind: 'mention', channel: UNLISTED_CHANNEL, bothEvents: true },
        { deliveries: noDelivery(f), dropLines: [unclaimedLine(h, f, 'alpha', UNLISTED_CHANNEL)] },
      ],
    ]
  },
  // The README's planner (all in its home and the shared channel) and reviewer (mentions in the shared channel).
  'readme-example.json': (h, f) => {
    const [home, shared] = [listed(f, 'planner', 0), listed(f, 'planner', 1)]
    return [
      [{ event: 'planner, its home channel, plain', to: 'planner', kind: 'plain', channel: home }, { deliveries: deliveredTo(f, 'planner', home, 'receive_all'), dropLines: [] }],
      [{ event: 'planner, the shared channel, plain', to: 'planner', kind: 'plain', channel: shared }, { deliveries: deliveredTo(f, 'planner', shared, 'receive_all'), dropLines: [] }],
      [{ event: 'reviewer, the shared channel, plain', to: 'reviewer', kind: 'plain', channel: shared }, { deliveries: noDelivery(f), dropLines: [notMentioned(h, 'reviewer', shared)] }],
      [{ event: 'reviewer, the shared channel, mention', to: 'reviewer', kind: 'mention', channel: shared }, { deliveries: deliveredTo(f, 'reviewer', shared, 'mention'), dropLines: [] }],
      // A channel another applied persona lists logs nothing (SRI-308).
      [{ event: "reviewer, planner's home channel, mention", to: 'reviewer', kind: 'mention', channel: home }, { deliveries: noDelivery(f), dropLines: [] }],
      [{ event: 'planner, an unlisted channel, plain', to: 'planner', kind: 'plain', channel: UNLISTED_CHANNEL }, { deliveries: noDelivery(f), dropLines: [unclaimedLine(h, f, 'planner', UNLISTED_CHANNEL)] }],
    ]
  },
}

/**
 * An in-file MCP client over the persona's registered session: the session
 * server (`createSessionServer`) over that entry, linked in memory. It only
 * lists the tools and reads the instructions, so every tool dependency
 * throws if reached; tool calls go through `run.callTool`. Closed in
 * `afterEach`.
 */
async function openListingClient(run: ReloadRun, name: string): Promise<Client> {
  const entry = run.session(name)
  if (entry === undefined) throw new Error(`no session registered for ${JSON.stringify(name)}`)
  const unused = (member: string) => (): never => {
    throw new Error(`the listing client calls no tool (${member})`)
  }
  const deps: SessionToolDeps = {
    assertSendable: unused('assertSendable'),
    getReplySettings: unused('getReplySettings'),
    getPersona: unused('getPersona'),
    clientFor: unused('clientFor'),
    inboxDir: join(rig!.root, 'inbox'),
    resolveUserName: unused('resolveUserName'),
    consumeAck: unused('consumeAck'),
    serverPort: 0,
  }
  const server = createSessionServer(entry, deps)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'upgrade-0-11-1', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  listingClients.push(client)
  return client
}

describe('a 0.11.1 configuration decides sample events as SRI-308 says (b.deo SRI-1307, SRI-308, SRI-106)', () => {
  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s: listed channels deliver by their entries, an unlisted one logs one unclaimed-channel line, a channel another persona lists logs nothing',
    async (_file, fixture) => {
      const h = makeHarness()
      const { run, placed } = await startWithSessions(h, fixture)
      const samples = SAMPLES[fixture.file]!(h, fixture)

      const outcomes: SampleOutcome[] = []
      for (const [sample] of samples) outcomes.push(await deliverSample(run, fixture, sample))

      expect(outcomes).toEqual(samples.map(([sample, expected]) => ({ event: sample.event, ...expected })))
      expectDeclarativeAndUnchanged(h, run, fixture.bytes)
      // The not-mentioned and unclaimed-channel lines above are this check's positive controls.
      expectNoTerms(run, UNCLAIMED_CHANNEL)
      expect(termHits(outcomes.flatMap((o) => o.dropLines))).toEqual({})
      expectNoLeak(h, run, placed, { outcomes })
    },
  )
})

describe('set_channel_delivery is listed and refused, and the instructions are MCP_INSTRUCTIONS (b.deo SRI-1307, SRI-106, SRI-503, SRI-604)', () => {
  test.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s: every channel persona lists the tool, gets the declarative refusal for one of its channels at all, and receives MCP_INSTRUCTIONS',
    async (_file, fixture) => {
      const h = makeHarness()
      const { run, placed } = await startWithSessions(h, fixture)
      const names = channelPersonas(fixture).map((p) => p.name)

      const seen: Record<string, unknown> = {}
      const expected: Record<string, unknown> = {}
      for (const name of names) {
        const client = await openListingClient(run, name)
        const { tools } = await client.listTools()
        const result = await run.callTool(name, SET_CHANNEL_DELIVERY_TOOL, { channel: listed(fixture, name, 0), delivery: 'all' })
        seen[name] = {
          listed: tools.some((t) => t.name === SET_CHANNEL_DELIVERY_TOOL),
          result,
          instructions: client.getInstructions(),
        }
        expected[name] = {
          listed: true,
          result: { isError: true, text: channelDeliveryDeclarativeRefusal(name, h.key(name)) },
          instructions: MCP_INSTRUCTIONS,
        }
      }

      expect(seen).toEqual(expected)
      expectDeclarativeAndUnchanged(h, run, fixture.bytes)
      expectNoTerms(run, PERSONA_START)
      expectNoLeak(h, run, placed, { seen })
    },
  )
})
