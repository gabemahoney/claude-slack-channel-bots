/**
 * session-manager.test.ts — Library-backed session-manager tests.
 *
 * Replaces the deleted tmux-direct test suite. Drives spawnForPersona via the
 * agent-director-stub (no real FFI). Coverage:
 *
 *   - Fresh-spawn happy path: emits SpawnParams matching SR-1.1 and the
 *     persona identity of b.av2 SR-2.2 (relay_mode='on', template name,
 *     `cscb_<key>` / `slack_bot_<key>`, the `service` / `persona` /
 *     `config_dir` labels plus the interim `channel` label, and the persona
 *     spawn environment).
 *   - The real-path `config_dir` label (b.av2 SR-1.5, SR-2.2).
 *   - AC 3: one persona listed in two channels is spawned exactly once.
 *   - SR-1.4 idempotency: ErrInstanceIdCollision → client.get(); each state
 *     drives the documented branch. Collision fixtures build their row for
 *     the persona under test (`personaRow`), so its `cwd` and `config_dir`
 *     label match and each case stays on the path it tests.
 *   - b.av2 SR-6.2 ladder guards: a row in another directory (by real path) is
 *     killed, deleted and spawned fresh on every path; a missing or changed
 *     `config_dir` label means a fresh spawn instead of a resume (AC 48).
 *   - b.av2 SR-6.3: the fixed instance ID, one launch in flight per persona,
 *     and the start sweep (`reconcileOrphans`) keyed by the `persona` label
 *     (AC 4).
 *   - b.av2 SR-6.1 start: `startupSessionManager` with `bringUp` (a persona
 *     not brought up is counted apart; every Slack bring-up runs at once and
 *     only the launches share the pool, in readiness order; a launch that
 *     throws is one failed persona), and `launchSession`'s relaunch gate
 *     (`canLaunch` false → `'skipped'`, nothing launched or patched).
 *   - b.av2 SR-6.2 pre-launch trust patch: through the injectable seam
 *     (`setPreLaunchTrustPatcher`, empty by default and reset in afterEach,
 *     so no test installs the production patch or writes a `.claude.json`),
 *     once per ladder, before its first spawn or resume, on every launch path;
 *     never in dry run or for a joining caller; a throw is only logged.
 *   - b.av2 SR-7.4 transcript-loss diagnosis: only the persona's
 *     `delivery: all` channels are counted, and a zero count is inconclusive
 *     for a persona with a `mentions` channel or DMs on.
 *   - SR-8.6 invariant: every successful spawn call site passes
 *     relay_mode='on'.
 *   - Persona notices (b.av2 SR-7.2): spawn failure (generic, dialog-approval
 *     timeout, self-heal failure, restart cap), lost and inconclusive history,
 *     held-until-validated notices and the `spawn-failure-post` startup error,
 *     through the real per-persona notifier installed with
 *     `setSessionNotifier`.
 *
 * Most blocks use a stand-in persona keyed by its channel ID
 * (`makeStandInPersonaConfig`), so their `cscb_<channelId>` ids and outage
 * keys stay short and fixed. Every test gets a bare notice capture
 * (`notices`); the notice-routing cases replace it with the real notifier
 * over a two-persona config whose notice persona's name, key and destination
 * all differ.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  reconcileOrphans,
  reconnectMcp,
  waitForWaitingAndReconnect,
  approvePreSessionDialogs,
  spawnForPersona,
  startupSessionManager,
  launchSession,
  personaConfigDirLabelValue,
  AGENT_DIRECTOR_LIVE_STATES,
  DEV_CHANNELS_DIALOG_NEEDLE,
  TRUST_DIALOG_NEEDLE,
  _setDialogReadyTimeoutMs,
  _setDialogPollIntervalMs,
  _resetDialogReadyTimeoutMs,
  _resetDialogPollIntervalMs,
  _setWaitForWaitingTimeoutMs,
  _resetWaitForWaitingTimeoutMs,
  _setFindMissingMemoTtlMs,
  _resetFindMissingMemo,
  sweepDeadTmuxChannel,
  _setTmuxSessionKiller,
  _resetTmuxSessionKiller,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _resetTmuxDialogHelpers,
  _setDialogDeadGracePolls,
  _resetDialogDeadGracePolls,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  _resetInFlightLaunches,
  isLaunchInFlight,
  compareRowToPersona,
  setSessionNotifier,
  notifySpawnFailure,
  notifyRestartCapReached,
  setPreLaunchTrustPatcher,
  _resetPreLaunchTrustPatcher,
  type StartupPersonaOutcome,
} from '../src/session-manager.ts'
import { UNATTRIBUTABLE_ZERO_REASON } from '../src/jsonl-persistence-check.ts'
import { resolveJsonlPath } from '../src/cozempic.ts'
import type { PersonaNoticeOptions } from '../src/persona-notifier.ts'
import { makeDeferredConnect, type DeferredConnect, type StubSlackOptions, type WebApiOutcome } from './test-helpers/slack-stub.ts'
import type { PersonaConnectionManager } from '../src/persona-connections.ts'
import type { PersonaBringUpStep } from '../src/persona-start.ts'
import {
  createPersonaBringUpController,
  type PersonaBringUpController,
  type PersonaBringUpOutcome,
} from '../src/persona-bringup-controller.ts'
import { makeConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
} from './test-helpers/credentials.ts'
import { MCP_SERVER_NAME, type Persona, type PersonaConfig, resolveRealPath } from '../src/config.ts'
import { PERSONA_INSTANCE_ID_PREFIX, configDirLabelValue, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedFindMissing,
  cannedOk,
  cannedErr,
  errInstanceIdCollision,
  errNoSessionId,
  errJsonlMissing,
  errJsonlNeverWritten,
  errSpawnNotFound,
  errSpawnNotResumable,
  errGeneric,
  errSpawnNotInteractive,
  errTmuxSendKeys,
  errTmuxSessionCreate,
  holdSpawns,
  makeStubClient,
  type CannedGetResult,
  type CannedResponse,
  type PersonaGetResultOverrides,
  type StubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import { buildTempArchiveDb, messagesSince } from './test-helpers/archive-db.ts'
import {
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  _resetOutageState,
} from '../src/outage-state.ts'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
} from '../src/agent-director-errors.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function installStub(opts?: Parameters<typeof makeStubClient>[0]): StubClient {
  const stub = makeStubClient(opts)
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  return stub
}

/**
 * Per-test temp directory: `baseDir` for the persona fixtures and the parent
 * of any working, config or home directory a test creates. Removed in afterEach.
 */
let fixtureDir: string

/** The applied persona with `key`; fails the test when there is none. */
function personaOf(config: PersonaConfig, key: string): Persona {
  const persona = config.personas.find((p) => p.key === key)
  if (!persona) throw new Error(`test fixture has no persona with key ${key}`)
  return persona
}

/**
 * Point SLACK_STATE_DIR at `<fixtureDir>/state` for this test and return a
 * reader for the startup-errors.log recorded there. The directory goes with
 * fixtureDir in afterEach, which also restores the environment.
 */
function captureStartupErrors(): () => string {
  const dir = join(fixtureDir, 'state')
  process.env['SLACK_STATE_DIR'] = dir
  const logPath = join(dir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

/**
 * Create a temp home `<fixtureDir>/<name>` holding `.claude` and make the spawn
 * path resolve an unset claude_config_dir against it (`_setSpawnHomeDir`,
 * reset in afterEach), so no label depends on the process home. Returns it.
 */
function useSpawnHome(name = 'home'): string {
  const home = fixtureSubdir(name)
  mkdirSync(join(home, '.claude'))
  _setSpawnHomeDir(home)
  seamHome = home
  return home
}

/**
 * Replace `<home>/.claude` with a symlink to a new directory under the fixture
 * dir and return that directory's real path (what a spawn's `config_dir`
 * label is computed from).
 */
function linkClaudeDir(home: string): string {
  const target = fixtureSubdir('claude-dir-target')
  rmSync(join(home, '.claude'), { recursive: true, force: true })
  symlinkSync(target, join(home, '.claude'))
  return realpathSync(target)
}

/** The home the latest `useSpawnHome` of this test installed; cleared in beforeEach. */
let seamHome: string | undefined

/** This test's seam home, created with `useSpawnHome()` on first use. */
function ladderHome(): string {
  return seamHome ?? useSpawnHome()
}

/**
 * The row a spawn of persona `key` left behind, for a collision fixture:
 * `cannedGetResult` in persona form, so its `cwd` is the persona's working
 * directory, its instance ID `cscb_<key>` and its `config_dir` label the
 * persona's current one under the seam home (`ladderHome`). A ladder fixture
 * built from it stays on the state path it tests instead of meeting the `cwd`
 * or `config_dir` guard (b.av2 SR-6.2). Overrides win, so a guard case can
 * replace `cwd` or `labels`.
 */
function personaRow(cfg: PersonaConfig, key: string, overrides: PersonaGetResultOverrides = {}): CannedGetResult {
  return cannedGetResult(overrides, personaOf(cfg, key), ladderHome())
}

/** A stub `get` that answers each `cscb_<key>` with `personaRow(cfg, key, overrides)`. */
function personaRowsGet(
  cfg: PersonaConfig,
  overrides: PersonaGetResultOverrides = {},
): (params: import('agent-director').GetParams) => Promise<CannedGetResult> {
  return async (params) => personaRow(cfg, params.claude_instance_id.slice(PERSONA_INSTANCE_ID_PREFIX.length), overrides)
}

/** Capture of outage-state notices (onsets + all-clears), by persona key, across each test. */
let outageEmissions: Array<{ key: string; text: string }> = []

/**
 * Bare capture of every session-manager notice raised during the test: the
 * recording sink `beforeEach` installs through `setSessionNotifier`. Enough
 * for "no notice" assertions; routing is asserted through the real notifier
 * (`installNoticeNotifier`), which replaces this sink for its test.
 */
let notices: Array<{ key: string; text: string; options?: PersonaNoticeOptions }> = []

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  fixtureDir = mkdtempSync(join(tmpdir(), 'cscb-sm-'))
  // Keep dialog approval polling tight so the merged approvePreSessionDialogs
  // running on every fresh-spawn doesn't add seconds to the suite. Individual
  // tests can override these as needed.
  _setDialogPollIntervalMs(1)
  // Use a large-enough ready timeout that the happy path (statusQueue reaches
  // 'waiting' in 2-3 polls at 1ms interval) completes before the cap. Tests
  // that need to exercise the cap override this locally.
  _setDialogReadyTimeoutMs(200)
  // Wire the outage-state module so withOutageDetection / withSpawnDetection
  // can resolve the AD client and emit Slack onset/all-clear messages.
  outageEmissions = []
  initOutageState({
    getClient,
    notify: (key, text) => { outageEmissions.push({ key, text }) },
  })
  notices = []
  setSessionNotifier((key, text, options) => { notices.push({ key, text, options }) })
  seamHome = undefined
  // Default the raw-tmux dialog seams to safe no-ops so unit tests never shell
  // out to real tmux (b.vub). Dead-row tests override these to drive behavior.
  _setTmuxCapturePane(async () => '')
  _setTmuxSendEnter(async () => {})
  // Default the b.3ce timeout-liveness prober to "alive" so unit tests never
  // shell out to real tmux and the timeout verdict stays 'ok' unless a test
  // explicitly drives the dead-session path.
  _setTmuxSessionProber(async () => true)
})

afterEach(() => {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogReadyTimeoutMs()
  _resetWaitForWaitingTimeoutMs()
  _resetFindMissingMemo()
  _resetTmuxSessionKiller()
  _resetTmuxServerEnsurer()
  _resetTmuxSessionProber()
  _resetTmuxDialogHelpers()
  _resetDialogDeadGracePolls()
  _resetOutageState()
  _resetSpawnHomeDir()
  _resetInFlightLaunches()
  _resetPreLaunchTrustPatcher()
  setSessionNotifier(undefined)
  process.env = savedEnv as NodeJS.ProcessEnv
  rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 shared helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persona notices (b.av2 SR-7.2) — the real notifier over per-persona stubs
// ---------------------------------------------------------------------------

/** The notice persona: its name differs from its key. */
const NOTICE_NAME = 'Ops Desk'
const NOTICE_KEY = personaKey(NOTICE_NAME)
/** Its destination (`permission_prompts`): its second channel, an `all` one. */
const NOTICE_DEST = 'C0DEST001'
/** Its first channel, `mentions` only: never a notice target. */
const NOTICE_MENTIONS = 'C0MENT002'
/** The second persona, whose stub must never see a notice for the first. */
const OTHER_NAME = 'Other Bot'
const OTHER_KEY = personaKey(OTHER_NAME)
const OTHER_DEST = 'C0OTHER03'

/**
 * Two personas: the notice persona (first channel NOTICE_MENTIONS, destination
 * its second channel NOTICE_DEST, so a post to its first channel is told apart
 * from a post to its destination) and a second one with its own destination.
 */
function makeNoticeConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig(
    [
      {
        name: NOTICE_NAME,
        working_directory: '/x',
        channels: [
          { id: NOTICE_MENTIONS, delivery: 'mentions' },
          { id: NOTICE_DEST, delivery: 'all' },
        ],
        permission_prompts: NOTICE_DEST,
      },
      {
        name: OTHER_NAME,
        working_directory: '/y',
        channels: [{ id: OTHER_DEST, delivery: 'all' }],
        permission_prompts: OTHER_DEST,
      },
    ],
    fixtureDir,
    overrides,
  )
}

/**
 * Build the real persona notifier over `cfg` (`makeNotifierHarness`: one
 * `makeStubSlack` stub per persona) and install its `notify` through
 * `setSessionNotifier` (reset to no notifier in afterEach). Every persona is
 * validated unless `validated: false`; `post` scripts the notice persona's
 * `chat.postMessage` outcomes; `leakMarker` goes to every stub.
 */
function installNoticeNotifier(
  cfg: PersonaConfig,
  opts: { validated?: boolean; post?: WebApiOutcome[]; leakMarker?: string } = {},
): NotifierHarness {
  const h = makeNotifierHarness(cfg, {
    validated: opts.validated ?? true,
    post: opts.post ? { [NOTICE_KEY]: opts.post } : undefined,
    leakMarker: opts.leakMarker,
  })
  setSessionNotifier(h.notifier.notify)
  return h
}

/** Capture console.error output for the duration of `fn`, then restore. */
async function withCapturedErr(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.error = orig
  }
  return lines.join('\n')
}

/** Let fire-and-forget notice posts (and their rejection handlers) settle. */
async function settleNotices(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Assert exactly one notice was posted, to the notice persona's destination
 * only, through its own client, as a top-level message whose text names the
 * persona in rendered form and never identifies it by a channel ID; nothing
 * is posted through the other persona's client. Returns the posted text.
 */
function expectOneNoticeToDestination(h: NotifierHarness): string {
  const posts = h.posts(NOTICE_KEY)
  expect(posts).toHaveLength(1)
  const post = posts[0]!
  expect(post.channel).toBe(NOTICE_DEST)
  // Top-level, the persona's own identity: exactly channel + text.
  expect(Object.keys(post).sort()).toEqual(['channel', 'text'])
  expect(post.text.startsWith(`Persona ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)}: `)).toBe(true)
  expect(post.text).not.toContain(NOTICE_DEST)
  expect(post.text).not.toContain(NOTICE_MENTIONS)
  expect(h.posts(OTHER_KEY)).toHaveLength(0)
  return post.text
}

/** Number of `[<classLabel>]` entries in a startup-errors.log body. */
function countStartupEntries(log: string, classLabel: string): number {
  return log.split('\n').filter((line) => line.includes(`] [${classLabel}] `)).length
}

/** Pre-raise all three outage flags for a persona key so success-clear tests start with full bad-stretch. */
function preSetAllFlags(key: string): void {
  setOutageFlag(key, 'cwd-unreachable', '/test/cwd')
  setOutageFlag(key, 'ad-unreachable', '/bin/ad')
  setOutageFlag(key, 'tmux-unavailable')
}

// ---------------------------------------------------------------------------
// SR-1.1 / b.av2 SR-2.2 — fresh spawn parameters
// ---------------------------------------------------------------------------
//
// Spawns are keyed by persona: `cscb_<key>`, `slack_bot_<key>`, the labels
// `service=cscb`, `persona=<key>`, `config_dir=<12 hex of the REAL effective
// claude_config_dir>` and nothing else (no `channel` label since E3 Task 6),
// and the env `CSCB_PERSONA` / `CLAUDE_MANAGED_CHANNEL` (the key),
// `CSCB_CRONTABLE_PATH`, and `CLAUDE_CONFIG_DIR` only when a directory is
// configured.
//
// extra_env always carries CSCB_CRONTABLE_PATH — the resolved, absolute
// cron_table_path from the config — for every persona, whether or not a
// (per-persona or top-level) claude_config_dir is present. buildSpawnParams
// copies the field verbatim; it never recomputes or re-resolves the path, so a
// distinctive absolute override on the config must appear untouched in
// extra_env (see the pass-through test below).
//
// There is deliberately no "cron_table_path missing" case here: cron_table_path
// is a required field on the resolved config type, and the env-var fallback
// server mode has no config at all — server.ts guards every spawn on a loaded
// config, so buildSpawnParams is never reached without one. A missing-field
// case is therefore unrepresentable, not merely untested.

/** Create `name` under the per-test fixture dir and return its path. */
function fixtureSubdir(name: string): string {
  const dir = join(fixtureDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Expected `config_dir=` label for a configured directory that exists. */
function configDirLabelFor(dir: string): string {
  return `config_dir=${configDirLabelValue(realpathSync(dir))}`
}

describe('spawnForPersona: SR-1.1 / SR-2.2 fresh spawn parameters', () => {
  test('emits SpawnParams with the persona instance id, tmux name, exact labels and env', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const configDir = fixtureSubdir('claude-corp')
    const workDir = fixtureSubdir('work')
    const cfg = makeMultiPersonaConfig(
      [{ name: 'Ops Bot', working_directory: workDir, claude_config_dir: configDir }],
      fixtureDir,
    )
    const key = personaKey('Ops Bot')
    expect(key).not.toBe('Ops Bot') // the name needs normalisation, so name and key differ

    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result).toEqual({ key, action: 'spawned' })
    expect(spawnCalls).toHaveLength(1)
    const params = spawnCalls[0]
    expect(params.template).toBe('slack-channel-bot')
    expect(params.cwd).toBe(workDir)
    expect(params.claude_instance_id).toBe(`cscb_${key}`)
    expect(params.tmux_session_name).toBe(`slack_bot_${key}`)
    expect(params.relay_mode).toBe('on')
    expect(params.label).toEqual(['service=cscb', `persona=${key}`, configDirLabelFor(configDir)])
    // The interim `channel=<key>` label is no longer written (E3 Task 6).
    expect(params.label!.some((l) => l.startsWith('channel='))).toBe(false)
    expect(params.extra_env).toEqual({
      CLAUDE_CONFIG_DIR: configDir,
      CSCB_PERSONA: key,
      CLAUDE_MANAGED_CHANNEL: key,
      CSCB_CRONTABLE_PATH: join(fixtureDir, 'crontab'),
    })
    expect(params.claude_args).toBeUndefined()
  })

  test('no claude_config_dir configured → CLAUDE_CONFIG_DIR absent (not empty), label is that of <home>/.claude', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    expect(cfg.claude_config_dir).toBeUndefined()

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    const env = spawnCalls[0].extra_env!
    expect(env).toEqual({ CSCB_PERSONA: 'C', CLAUDE_MANAGED_CHANNEL: 'C', CSCB_CRONTABLE_PATH: cfg.cron_table_path })
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
    expect(spawnCalls[0].label).toEqual([
      'service=cscb',
      'persona=C',
      `config_dir=${personaConfigDirLabelValue(undefined, home)}`,
    ])
    // Independent of the helper: the hash of the real <home>/.claude.
    expect(spawnCalls[0].label).toContain(`config_dir=${configDirLabelValue(join(realpathSync(home), '.claude'))}`)
  })

  test('the seam home is followed through a symlink: a linked home gives the label of its target', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const target = fixtureSubdir('real-home')
    mkdirSync(join(target, '.claude'))
    const linkedHome = join(fixtureDir, 'linked-home')
    symlinkSync(target, linkedHome)
    _setSpawnHomeDir(linkedHome)
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    const label = spawnCalls[0].label!.find((l) => l.startsWith('config_dir='))
    expect(label).toBe(`config_dir=${personaConfigDirLabelValue(undefined, target)}`)
    expect(label).toBe(`config_dir=${configDirLabelValue(join(realpathSync(target), '.claude'))}`)
    // The lexical hash under the link differs, so equality proves the real path was hashed.
    expect(label).not.toBe(`config_dir=${configDirLabelValue(join(linkedHome, '.claude'))}`)
    expect('CLAUDE_CONFIG_DIR' in spawnCalls[0].extra_env!).toBe(false)
  })

  test('a configured absolute claude_config_dir ignores the seam home', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const configured = fixtureSubdir('absolute-config')
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: configured } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(spawnCalls[0].label).toContain(configDirLabelFor(configured))
    expect(spawnCalls[0].label).not.toContain(`config_dir=${personaConfigDirLabelValue(undefined, home)}`)
    expect(spawnCalls[0].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configured)
  })

  test('a ~-prefixed claude_config_dir expands against the seam home for the label; env keeps it as configured', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const expanded = join(home, 'tilde-config')
    mkdirSync(expanded)
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: '~/tilde-config' } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(spawnCalls[0].label).toContain(configDirLabelFor(expanded))
    // Not expanded against the process home.
    expect(spawnCalls[0].label).not.toContain(`config_dir=${configDirLabelValue(join(homedir(), 'tilde-config'))}`)
    expect(spawnCalls[0].extra_env?.['CLAUDE_CONFIG_DIR']).toBe('~/tilde-config')
  })

  test('extra_env passes the already-resolved cron_table_path through untouched (no recomputation)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { cron_table_path: '/srv/resolved/absolute/crontable.md' })
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(spawnCalls[0].extra_env).toEqual({
      CSCB_PERSONA: 'C',
      CLAUDE_MANAGED_CHANNEL: 'C',
      CSCB_CRONTABLE_PATH: '/srv/resolved/absolute/crontable.md',
    })
  })

  test('extra_env carries the crontable path alongside a per-persona claude_config_dir', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const perPersona = fixtureSubdir('per-persona')
    const cfg = makeStandInPersonaConfig(
      { C: { working_directory: '/x', claude_config_dir: perPersona } },
      fixtureDir,
      { cron_table_path: '/srv/resolved/absolute/crontable.md' },
    )
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(spawnCalls[0].extra_env).toEqual({
      CLAUDE_CONFIG_DIR: perPersona,
      CSCB_PERSONA: 'C',
      CLAUDE_MANAGED_CHANNEL: 'C',
      CSCB_CRONTABLE_PATH: '/srv/resolved/absolute/crontable.md',
    })
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-2.2, SR-1.5 — the `config_dir` label hashes the REAL path of the
// effective claude_config_dir, falling back to the lexical path when it cannot
// be resolved.
// ---------------------------------------------------------------------------

describe('spawnForPersona: config_dir label (SR-2.2, SR-1.5)', () => {
  /** Spawn every persona of `cfg` once and return the spawn params by key. */
  async function spawnAll(cfg: PersonaConfig): Promise<Map<string, import('agent-director').SpawnParams>> {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    for (const persona of cfg.personas) await spawnForPersona(persona, cfg)
    return new Map(spawnCalls.map((p) => [String(p.claude_instance_id).slice('cscb_'.length), p]))
  }

  test('a per-persona directory overrides the top-level one in the label and the env', async () => {
    const top = fixtureSubdir('top-level')
    const per = fixtureSubdir('per-persona')
    const cfg = makeMultiPersonaConfig(
      [{ name: 'ops_bot', working_directory: '/x', claude_config_dir: per }],
      fixtureDir,
      { claude_config_dir: top },
    )
    const params = (await spawnAll(cfg)).get('ops_bot')!
    expect(params.label).toContain(configDirLabelFor(per))
    expect(params.label).not.toContain(configDirLabelFor(top))
    expect(params.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(per)
  })

  test('two different directories give different labels', async () => {
    const one = fixtureSubdir('dir-one')
    const two = fixtureSubdir('dir-two')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: '/x/a', claude_config_dir: one },
        { name: 'beta', working_directory: '/x/b', claude_config_dir: two },
      ],
      fixtureDir,
    )
    const byKey = await spawnAll(cfg)
    const alpha = byKey.get('alpha')!.label!.find((l) => l.startsWith('config_dir='))
    const beta = byKey.get('beta')!.label!.find((l) => l.startsWith('config_dir='))
    expect(alpha).toBe(configDirLabelFor(one))
    expect(beta).toBe(configDirLabelFor(two))
    expect(alpha).not.toBe(beta)
  })

  test('a symlink to a directory gives the same label as the directory (env keeps the path as configured)', async () => {
    const target = fixtureSubdir('real-config')
    const link = join(fixtureDir, 'config-link')
    symlinkSync(target, link)
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'direct', working_directory: '/x/d', claude_config_dir: target },
        { name: 'via_link', working_directory: '/x/l', claude_config_dir: link },
      ],
      fixtureDir,
    )
    const byKey = await spawnAll(cfg)
    const direct = byKey.get('direct')!.label!.find((l) => l.startsWith('config_dir='))
    const viaLink = byKey.get('via_link')!.label!.find((l) => l.startsWith('config_dir='))
    expect(viaLink).toBe(direct)
    expect(viaLink).toBe(configDirLabelFor(target))
    // The lexical hash of the link path differs, so equality proves the real path was hashed.
    expect(viaLink).not.toBe(`config_dir=${configDirLabelValue(link)}`)
    expect(byKey.get('via_link')!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(link)
  })

  test('a configured path that does not exist falls back to its lexical form', async () => {
    const missing = join(fixtureDir, 'not-created', 'claude')
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: missing } }, fixtureDir)
    const params = (await spawnAll(cfg)).get('C')!
    expect(params.label).toContain(`config_dir=${configDirLabelValue(missing)}`)
  })

  test('no directory configured: the label is that of .claude under an injected temp home', () => {
    const home = fixtureSubdir('home')
    mkdirSync(join(home, '.claude'))
    const expected = configDirLabelValue(resolveRealPath(join(realpathSync(home), '.claude')), home)
    expect(personaConfigDirLabelValue(undefined, home)).toBe(expected)
    // Unset equals an explicit <home>/.claude, in absolute and tilde form.
    expect(personaConfigDirLabelValue(join(home, '.claude'), home)).toBe(expected)
    expect(personaConfigDirLabelValue('~/.claude', home)).toBe(expected)
    // A symlinked home resolves to the same real directory.
    const linkedHome = join(fixtureDir, 'home-link')
    symlinkSync(home, linkedHome)
    expect(personaConfigDirLabelValue(undefined, linkedHome)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-2.2 — spawn identity is the persona key, never the name
// ---------------------------------------------------------------------------

describe('spawnForPersona: persona identity (SR-2.2)', () => {
  test('an in-form name is its own key', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeMultiPersonaConfig([{ name: 'ops_bot', working_directory: '/repo/ops' }], fixtureDir)

    await spawnForPersona(personaOf(cfg, 'ops_bot'), cfg)

    expect(spawnCalls[0].claude_instance_id).toBe('cscb_ops_bot')
    expect(spawnCalls[0].tmux_session_name).toBe('slack_bot_ops_bot')
    expect(spawnCalls[0].label).toContain('persona=ops_bot')
  })

  test('a persona whose key is set directly (a channel-ID stand-in) spawns byte-identically as cscb_<key>', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const topLevel = fixtureSubdir('top-level')
    const cfg = makeStandInPersonaConfig(
      { C0AMDDZEHCY: { working_directory: '/repo/general' } },
      fixtureDir,
      { claude_config_dir: topLevel },
    )

    const result = await spawnForPersona(personaOf(cfg, 'C0AMDDZEHCY'), cfg)

    expect(result).toEqual({ key: 'C0AMDDZEHCY', action: 'spawned' })
    const params = spawnCalls[0]
    expect(params.claude_instance_id).toBe('cscb_C0AMDDZEHCY')
    expect(params.tmux_session_name).toBe('slack_bot_C0AMDDZEHCY')
    expect(params.cwd).toBe('/repo/general')
    expect(params.label).toEqual([
      'service=cscb',
      'persona=C0AMDDZEHCY',
      configDirLabelFor(topLevel),
    ])
    // The top-level claude_config_dir reaches the env of a stand-in with none of its own.
    expect(params.extra_env).toEqual({
      CLAUDE_CONFIG_DIR: topLevel,
      CSCB_PERSONA: 'C0AMDDZEHCY',
      CLAUDE_MANAGED_CHANNEL: 'C0AMDDZEHCY',
      CSCB_CRONTABLE_PATH: cfg.cron_table_path,
    })
  })

  test('collision handling addresses the same cscb_<key> for get and resume', async () => {
    const getCalls: import('agent-director').GetParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const key = personaKey('General Chat')
    const cfg = makeMultiPersonaConfig([{ name: 'General Chat', working_directory: '/x' }], fixtureDir)
    installStub({
      getCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, key, { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result.action).toBe('resumed')
    expect(getCalls[0].claude_instance_id).toBe(`cscb_${key}`)
    expect(resumeCalls[0].claude_instance_id).toBe(`cscb_${key}`)
  })
})

// ---------------------------------------------------------------------------
// SR-1.4 — idempotency dispatch on ErrInstanceIdCollision
// ---------------------------------------------------------------------------

describe('spawnForPersona: SR-1.4 collision-then-act', () => {
  test('ended state + resume_enabled → resume()', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
  })

  test('ended state + ErrNoSessionId on resume → delete + fresh spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].claude_instance_id).toEqual(['cscb_C'])
  })

  test('ended state + resume_enabled=false → kill + delete + fresh spawn (no resume)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      resumeCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'missing' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  test('waiting state → reconnectMcp (sendKeys with /mcp reconnect)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
  })

  test('pending/check_permission/ask_user → no-op', async () => {
    for (const state of ['pending', 'check_permission', 'ask_user']) {
      const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
      installStub({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state }),
      })
      const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      expect(result.action).toBe('no-op')
      resetClientForTests()
    }
  })

  // b.2oy — resume rejects with ErrSpawnNotFound (row vanished between the
  // dead-session verdict and resume: operator delete, expire, race). Recovery
  // must fresh-spawn directly with the original params — NO kill, NO delete,
  // no spawn-failure notice — and report 'spawned'. Pre-fix this fell
  // into the generic resume-catch, which posted a Slack "spawn failure" and
  // returned action: 'failed'.
  test('b.2oy: ErrSpawnNotFound on resume → fresh spawn (no kill, no delete, no spawn-failure notice)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const home = useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errSpawnNotFound(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result).toEqual({ key: 'C', action: 'spawned' })
    // initial collision spawn + the fresh spawn after ErrSpawnNotFound
    expect(spawnCalls).toHaveLength(2)
    // fresh spawn carries the original params (same persona labels / id)
    expect(spawnCalls[1].claude_instance_id).toBe('cscb_C')
    expect(spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', `config_dir=${personaConfigDirLabelValue(undefined, home)}`])
    // row was already gone — no kill and no delete of a missing row
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    // no spawn-failure notice
    expect(notices).toHaveLength(0)
  })

  // b.2oy — ErrSpawnNotFound recovery still surfaces genuine spawn failures.
  // Resume throws ErrSpawnNotFound, then the fresh spawn fails with a generic
  // error → 'failed' and a spawn-failure notice goes to the persona's
  // destination (b.av2 SR-7.2).
  test('b.2oy: ErrSpawnNotFound on resume + fresh spawn fails → failed + spawn-failure notice to the persona destination', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken')),
      ],
      resumeError: errSpawnNotFound(),
      getResult: personaRow(cfg, NOTICE_KEY, { state: 'ended' }),
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()
    expect(result.action).toBe('failed')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(0)
    // generic spawn failure is surfaced to the persona's destination only
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `ErrSpawnBroken`')
    expect(text).toContain('Remediation: Check server.log for details.')
    // startup-error side effect is part of the tested contract
    expect(readLog()).toContain('[spawn-failed]')
  })

  test('ErrSpawnNotFound after collision → single retry-spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / SR-6.3 — row-vs-persona comparison (compareRowToPersona)
// ---------------------------------------------------------------------------

describe('compareRowToPersona (b.av2 SR-6.2, SR-6.3)', () => {
  /** Paths for one case, all under this test's fixture dir; `home` is real-pathed. */
  interface CompareFixture {
    work: string
    config: string
    home: string
  }

  function compareFixture(): CompareFixture {
    const home = realpathSync(fixtureSubdir('home'))
    mkdirSync(join(home, '.claude'))
    return { work: fixtureSubdir('work'), config: fixtureSubdir('claude-config'), home }
  }

  // agent-director stores the real path a spawn ran in, so in practice the
  // symlink is on the persona side: its configured working_directory or
  // claude_config_dir. Row-side links are covered too.
  test.each<[string, boolean, (f: CompareFixture) => { rowCwd: string | undefined; personaWork: string }]>([
    ['equal', true, (f) => ({ rowCwd: f.work, personaWork: f.work })],
    [
      'the real directory, persona working_directory a symlink to it',
      true,
      (f) => {
        const link = join(fixtureDir, 'work-link')
        symlinkSync(f.work, link)
        return { rowCwd: realpathSync(f.work), personaWork: link }
      },
    ],
    [
      'a symlink to the working directory',
      true,
      (f) => {
        const link = join(fixtureDir, 'work-link')
        symlinkSync(f.work, link)
        return { rowCwd: link, personaWork: f.work }
      },
    ],
    ['a different existing directory', false, (f) => ({ rowCwd: fixtureSubdir('elsewhere'), personaWork: f.work })],
    ['a nonexistent path (lexical fallback, differs)', false, (f) => ({ rowCwd: join(fixtureDir, 'never-created'), personaWork: f.work })],
    [
      'a nonexistent path (lexical fallback, same after normalisation)',
      true,
      () => ({ rowCwd: join(fixtureDir, 'absent-work') + '/./', personaWork: join(fixtureDir, 'absent-work') }),
    ],
    ['absent', false, (f) => ({ rowCwd: undefined, personaWork: f.work })],
    ['empty', false, (f) => ({ rowCwd: '', personaWork: f.work })],
  ])('row cwd %s → cwdMatches=%p', (_label, expected, build) => {
    const f = compareFixture()
    const { rowCwd, personaWork } = build(f)
    const persona = { working_directory: personaWork, claude_config_dir: f.config }
    const row = { cwd: rowCwd, labels: { config_dir: personaConfigDirLabelValue(f.config, f.home) } }
    expect(compareRowToPersona(row, persona, f.home).cwdMatches).toBe(expected)
  })

  test.each<[string, boolean, (f: CompareFixture) => { label: string | undefined; configDir: string | undefined }]>([
    ['equal', true, (f) => ({ label: configDirLabelValue(realpathSync(f.config)), configDir: f.config })],
    ['missing', false, (f) => ({ label: undefined, configDir: f.config })],
    ['different', false, (f) => ({ label: configDirLabelValue(realpathSync(fixtureSubdir('other-config'))), configDir: f.config })],
    [
      'the one its spawn wrote (the real directory), persona claude_config_dir a symlink to it',
      true,
      (f) => {
        const link = join(fixtureDir, 'config-link')
        symlinkSync(f.config, link)
        return { label: configDirLabelValue(realpathSync(f.config)), configDir: link }
      },
    ],
    [
      'equal, persona with no claude_config_dir (the injected home’s .claude)',
      true,
      (f) => ({ label: configDirLabelValue(join(f.home, '.claude')), configDir: undefined }),
    ],
    [
      'the one its spawn wrote (the real directory), no claude_config_dir and the injected home’s .claude a symlink',
      true,
      (f) => ({ label: configDirLabelValue(linkClaudeDir(f.home)), configDir: undefined }),
    ],
  ])('config_dir label %s → configDirMatches=%p', (_label, expected, build) => {
    const f = compareFixture()
    const { label, configDir } = build(f)
    const labels: Record<string, string> = { service: 'cscb', persona: 'C' }
    if (label !== undefined) labels['config_dir'] = label
    const result = compareRowToPersona({ cwd: f.work, labels }, { working_directory: f.work, claude_config_dir: configDir }, f.home)
    expect(result.configDirMatches).toBe(expected)
    expect(result.configDirLabel).toBe(label)
    // The expected label is the one a spawn of the persona writes.
    expect(result.expectedConfigDirLabel).toBe(personaConfigDirLabelValue(configDir, f.home))
    expect(result.cwdMatches).toBe(true)
  })
})

/** Calls captured by a collision-ladder stub (the cwd and config_dir guard blocks). */
interface LadderCalls {
  spawnCalls: import('agent-director').SpawnParams[]
  killCalls: import('agent-director').KillParams[]
  deleteCalls: import('agent-director').DeleteParams[]
  resumeCalls: import('agent-director').ResumeParams[]
  sendKeysCalls: import('agent-director').SendKeysParams[]
  findMissingCalls: import('agent-director').FindMissingParams[]
}

function newLadderCalls(): LadderCalls {
  return { spawnCalls: [], killCalls: [], deleteCalls: [], resumeCalls: [], sendKeysCalls: [], findMissingCalls: [] }
}

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / AC 4 — a row in another directory is replaced on every
// ladder path (kill + delete + fresh spawn in the persona's working directory)
// ---------------------------------------------------------------------------

describe('collision ladder: cwd guard (b.av2 SR-6.2, AC 4)', () => {
  const COLLISION_STATES = ['ended', 'missing', 'waiting', 'working', 'pending', 'check_permission', 'ask_user'] as const

  /** Persona `C` with working_directory `work` (a real temp directory by default), the seam home installed. */
  function guardConfig(work = fixtureSubdir('work')): { cfg: PersonaConfig; work: string } {
    useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: work } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    return { cfg, work }
  }

  /** A colliding spawn whose `get` returns `row`; a second spawn succeeds. */
  function installCollision(row: CannedGetResult, calls: LadderCalls, extra: Parameters<typeof makeStubClient>[0] = {}): StubClient {
    return installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: row,
      ...extra,
    })
  }

  test.each([...COLLISION_STATES])('state=%s, row cwd another existing directory → kill + delete + one fresh spawn, no resume or reconnect', async (state) => {
    const { cfg, work } = guardConfig()
    const elsewhere = fixtureSubdir('elsewhere')
    const calls = newLadderCalls()
    installCollision(personaRow(cfg, 'C', { state, cwd: elsewhere }), calls)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    // The colliding spawn plus exactly one fresh spawn, in the persona's directory.
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].claude_instance_id).toBe('cscb_C')
    expect(calls.spawnCalls[1].cwd).toBe(work)
    // Never resumed, reconnected or reconciled-then-resumed.
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.sendKeysCalls.filter((s) => String(s.text).includes('/mcp reconnect'))).toHaveLength(0)
    expect(calls.findMissingCalls).toHaveLength(0)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=${elsewhere} differs from working_directory=${work} (state=${state}) — replacing the row: kill+delete+fresh`,
    )
  })

  test.each([
    ['ended', 'resumed'],
    ['waiting', 'reconnected'],
    ['pending', 'no-op'],
  ] as const)('control: state=%s, persona working_directory a symlink and the row cwd its real directory → normal path (%s), nothing killed or deleted', async (state, action) => {
    const real = fixtureSubdir('work-real')
    const link = join(fixtureDir, 'work-link')
    symlinkSync(real, link)
    const { cfg } = guardConfig(link)
    const calls = newLadderCalls()
    // agent-director records the real path the spawn ran in.
    installCollision(personaRow(cfg, 'C', { state, cwd: realpathSync(real) }), calls)

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action })
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(state === 'ended' ? 1 : 0)
    expect(calls.sendKeysCalls.filter((s) => String(s.text).includes('/mcp reconnect'))).toHaveLength(state === 'waiting' ? 1 : 0)
  })

  test('control: a row cwd that does not exist falls back to lexical comparison and is a mismatch', async () => {
    const { cfg, work } = guardConfig()
    const absent = join(fixtureDir, 'never-created')
    const calls = newLadderCalls()
    installCollision(personaRow(cfg, 'C', { state: 'ended', cwd: absent }), calls)

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].cwd).toBe(work)
  })

  test.each(['empty', 'absent'] as const)('a row with an %s cwd is a mismatch; the log prints cwd=<none>, never cwd=undefined', async (variant) => {
    const { cfg, work } = guardConfig()
    const calls = newLadderCalls()
    const base = personaRow(cfg, 'C', { state: 'ended' })
    const { cwd: _cwd, ...withoutCwd } = base
    installCollision(variant === 'empty' ? { ...base, cwd: '' } : (withoutCwd as CannedGetResult), calls)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.spawnCalls[1].cwd).toBe(work)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=<none> differs from working_directory=${work} (state=ended) — replacing the row`,
    )
    expect(errLog).not.toContain('cwd=undefined')
  })

  test('a failed delete on the mismatch path → failed, no fresh spawn (never two instances)', async () => {
    const readLog = captureStartupErrors()
    const { cfg } = guardConfig()
    const calls = newLadderCalls()
    installCollision(personaRow(cfg, 'C', { state: 'waiting', cwd: fixtureSubdir('elsewhere') }), calls, {
      deleteError: errGeneric('delete', 'ErrDeleteBroken'),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[spawn-failed]')
    expect(log).toContain(`delete failed for ${renderPersonaRef('C', 'C')}: ErrDeleteBroken`)
    expect(notices).toHaveLength(1)
    expect(notices[0].key).toBe('C')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / AC 48 — before any resume, a missing or changed `config_dir`
// label means delete + fresh spawn (a resume would keep the old config dir)
// ---------------------------------------------------------------------------

/** The four ways the ladder reaches a resume. */
const RESUME_ENTRIES = ['ended', 'missing', 'waiting (dead session)', 'working (dead session)'] as const
type ResumeEntry = (typeof RESUME_ENTRIES)[number]

/**
 * Persona `C` with a real working directory and a real per-persona
 * claude_config_dir; `overrides` go to the server-wide settings.
 */
function labelConfig(
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): { cfg: PersonaConfig; home: string; configDir: string } {
  const home = useSpawnHome()
  const configDir = fixtureSubdir('claude-config')
  const cfg = makeStandInPersonaConfig(
    { C: { working_directory: fixtureSubdir('work'), claude_config_dir: configDir } },
    fixtureDir,
    { agent_director_poll_interval_ms: 1, ...overrides },
  )
  return { cfg, home, configDir }
}

/**
 * Drive `entry` to its resume decision. `ended` / `missing` resolve straight
 * to it; `waiting` meets a dead session through persistent ErrTmuxSendKeys;
 * `working` through the up-front findMissing sweep reconciling the row to
 * `missing`. The resumed or fresh session reports `waiting`, so the dialog
 * approver returns at once. Returns the installed stub.
 */
function installResumeEntry(entry: ResumeEntry, row: CannedGetResult, calls: LadderCalls): StubClient {
  const state = entry.split(' ')[0] as 'ended' | 'missing' | 'waiting' | 'working'
  if (state === 'waiting' || state === 'working') _setTmuxServerEnsurer(async () => {})
  if (state === 'working') _setWaitForWaitingTimeoutMs(30)
  return installStub({
    ...calls,
    spawnQueue: [
      cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
    ],
    getResult: { ...row, state },
    sendKeysError: state === 'waiting' ? errTmuxSendKeys() : undefined,
    findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    statusFn: () =>
      ({
        state:
          calls.resumeCalls.length > 0 || calls.spawnCalls.length > 1
            ? 'waiting'
            : state === 'working' && calls.findMissingCalls.length > 0
              ? 'missing'
              : state,
      }) as import('agent-director').StatusResult,
  })
}

describe('collision ladder: config_dir guard before resume (b.av2 SR-6.2, AC 48)', () => {
  /** How the row's `config_dir` label relates to the persona's current one. */
  const LABEL_VARIANTS = ['matching', 'changed', 'missing'] as const
  type LabelVariant = (typeof LABEL_VARIANTS)[number]

  /** The row's labels for `variant`. */
  function labelsFor(variant: LabelVariant, cfg: PersonaConfig, home: string): Record<string, string> {
    const base = { ...personaRow(cfg, 'C').labels }
    switch (variant) {
      case 'matching':
        return base
      case 'changed':
        return { ...base, config_dir: personaConfigDirLabelValue(fixtureSubdir('earlier-config'), home) }
      case 'missing': {
        delete base['config_dir']
        return base
      }
    }
  }

  const CASES = RESUME_ENTRIES.flatMap((entry) => LABEL_VARIANTS.map((variant) => [entry, variant] as const))

  test.each(CASES)('%s row, %s config_dir label', async (entry, variant) => {
    const readLog = captureStartupErrors()
    const { cfg, home, configDir } = labelConfig()
    const expectedLabel = personaConfigDirLabelValue(configDir, home)
    const labels = labelsFor(variant, cfg, home)
    const calls = newLadderCalls()
    installResumeEntry(entry, personaRow(cfg, 'C', { labels }), calls)
    const dead = entry.includes('dead session')

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    if (variant === 'matching') {
      // Resumed as before the guard existed.
      expect(result).toEqual({ key: 'C', action: 'resumed' })
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1)
      expect(errLog).not.toContain('config_dir label')
      return
    }

    // No resume: the row is deleted (and killed first when it may still be
    // live) and exactly one fresh spawn follows, carrying the current label
    // and CLAUDE_CONFIG_DIR.
    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(dead ? 1 : 0)
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', `config_dir=${expectedLabel}`])
    expect(calls.spawnCalls[1].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configDir)
    // A fresh spawn, not amnesia: no transcript diagnosis, record or notice.
    const log = readLog()
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
    expect(log).not.toContain('jsonl-diagnosis-inconclusive')
    expect(notices).toHaveLength(0)
    const ref = renderPersonaRef('C', 'C')
    if (variant === 'missing') {
      expect(errLog).toContain(
        `spawnForPersona: ${ref} config_dir label missing (label absent, now=${expectedLabel} for claude_config_dir=${configDir}) — not resuming; spawning fresh`,
      )
    } else {
      expect(errLog).toContain(
        `spawnForPersona: ${ref} config_dir label changed (was=${labels['config_dir']}, now=${expectedLabel} for claude_config_dir=${configDir}) — not resuming; spawning fresh`,
      )
    }
  })

  // agent-director stores the label a spawn wrote, computed from the REAL
  // effective directory; the symlink is on the persona side.
  test.each(['claude_config_dir a symlink', 'no claude_config_dir and the seam home’s .claude a symlink'] as const)(
    'ended row carrying the label its spawn wrote, persona %s → resumed',
    async (variant) => {
      const home = useSpawnHome()
      let configDir: string | undefined
      let real: string
      if (variant === 'claude_config_dir a symlink') {
        real = realpathSync(fixtureSubdir('claude-config'))
        configDir = join(fixtureDir, 'config-link')
        symlinkSync(real, configDir)
      } else {
        real = linkClaudeDir(home)
      }
      const cfg = makeStandInPersonaConfig(
        { C: { working_directory: fixtureSubdir('work'), claude_config_dir: configDir } },
        fixtureDir,
        { agent_director_poll_interval_ms: 1 },
      )
      const labels = { ...personaRow(cfg, 'C').labels, config_dir: configDirLabelValue(real) }
      const calls = newLadderCalls()
      installResumeEntry('ended', personaRow(cfg, 'C', { labels }), calls)

      let result!: Awaited<ReturnType<typeof spawnForPersona>>
      const errLog = await withCapturedErr(async () => {
        result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      })

      expect(result).toEqual({ key: 'C', action: 'resumed' })
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1)
      expect(errLog).not.toContain('config_dir label')
    },
  )

  test('a live waiting row with a matching cwd and a stale label still reconnects (the check applies only before a resume)', async () => {
    const { cfg, home } = labelConfig()
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting', labels: labelsFor('changed', cfg, home) }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'reconnected' })
    expect(calls.sendKeysCalls.map((s) => s.text)).toEqual([`/mcp reconnect ${MCP_SERVER_NAME}`])
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
  })

  test('resume_enabled: false with a stale label keeps its kill + delete + fresh path', async () => {
    const { cfg, home } = labelConfig({ resume_enabled: false })
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended', labels: labelsFor('changed', cfg, home) }),
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(2)
    expect(errLog).toContain(`resume_enabled=false — kill+delete+fresh for ${renderPersonaRef('C', 'C')}`)
    expect(errLog).not.toContain('config_dir label')
  })

  // AC 48 (b.av2 SR-14 "session-manager"): a persona inheriting the top-level
  // claude_config_dir runs; its effective directory then changes through a
  // per-persona override. The row still carries the earlier label, so the
  // ladder deletes it and spawns fresh with the new CLAUDE_CONFIG_DIR.
  test('AC 48: a changed effective claude_config_dir (inherited, then overridden) gives a fresh spawn with the new CLAUDE_CONFIG_DIR', async () => {
    const home = useSpawnHome()
    const work = fixtureSubdir('work')
    const earlier = fixtureSubdir('top-level-config')
    const later = fixtureSubdir('persona-config')
    const before = makeStandInPersonaConfig({ C: { working_directory: work } }, fixtureDir, { claude_config_dir: earlier })
    expect(personaOf(before, 'C').claude_config_dir).toBe(earlier) // inherited
    const after = makeStandInPersonaConfig({ C: { working_directory: work, claude_config_dir: later } }, fixtureDir, { claude_config_dir: earlier })
    expect(personaOf(after, 'C').claude_config_dir).toBe(later) // overridden
    // The row a spawn under the earlier configuration left behind.
    const row = personaRow(before, 'C', { state: 'ended' })
    expect(row.labels['config_dir']).toBe(personaConfigDirLabelValue(earlier, home))

    // Control: under the unchanged configuration the same row resumes.
    const controlResume: import('agent-director').ResumeParams[] = []
    installStub({
      resumeCalls: controlResume,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: row,
    })
    expect(await spawnForPersona(personaOf(before, 'C'), before)).toEqual({ key: 'C', action: 'resumed' })
    expect(controlResume).toHaveLength(1)
    resetClientForTests()

    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnCalls,
      deleteCalls,
      resumeCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: row,
    })

    const result = await spawnForPersona(personaOf(after, 'C'), after)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(later)
    expect(spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', configDirLabelFor(later)])
    expect(spawnCalls[1].label).not.toContain(configDirLabelFor(earlier))
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 — the pre-launch trust patch precedes every launch
// ---------------------------------------------------------------------------
//
// The seam is empty by default (and reset in afterEach), so no test here
// installs the production trust patch or writes a `.claude.json`. Order is
// read from one shared event log: the recording patcher and the stub's
// `spawn` / `resume` all append to it.

/** One entry of the shared launch-order log. */
type LaunchEvent = 'patch' | 'spawn' | 'resume'

/**
 * Append 'spawn' / 'resume' to `events` on each such call through `stub`, then
 * delegate to the stub's own verb, so its call captures and queues still apply.
 */
function recordLaunchCalls(stub: StubClient, events: LaunchEvent[]): StubClient {
  const spawn = stub.spawn.bind(stub)
  const resume = stub.resume.bind(stub)
  stub.spawn = (params) => {
    events.push('spawn')
    return spawn(params)
  }
  stub.resume = (params) => {
    events.push('resume')
    return resume(params)
  }
  return stub
}

/**
 * Install a recording pre-launch trust patcher: each call appends 'patch' to
 * `events`. Returns the personas it was called with, in order.
 */
function installRecordingPatcher(events: LaunchEvent[]): Persona[] {
  const patched: Persona[] = []
  setPreLaunchTrustPatcher((persona) => {
    events.push('patch')
    patched.push(persona)
  })
  return patched
}

describe('pre-launch trust patch (b.av2 SR-6.2)', () => {
  /** One launch path: how to reach it, what it returns and the expected launch-order log. */
  interface LaunchPath {
    install: (cfg: PersonaConfig, calls: LadderCalls) => StubClient
    launch: (cfg: PersonaConfig) => Promise<unknown>
    expected: unknown
    events: LaunchEvent[]
  }

  const spawnC = (cfg: PersonaConfig) => spawnForPersona(personaOf(cfg, 'C'), cfg)

  /**
   * One row per way a ladder reaches agent-director: a fresh spawn, a resume
   * (straight, and after a dead session), the restart adapter, and the two
   * paths that spawn again after a first launch call.
   */
  const LAUNCH_PATHS: Array<[string, LaunchPath]> = [
    ['fresh spawn', {
      install: (_cfg, calls) => installStub({ ...calls }),
      launch: spawnC,
      expected: { key: 'C', action: 'spawned' },
      events: ['patch', 'spawn'],
    }],
    ['resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls),
      launch: spawnC,
      expected: { key: 'C', action: 'resumed' },
      events: ['patch', 'spawn', 'resume'],
    }],
    ['dead-session recovery from a waiting row that resumes', {
      install: (cfg, calls) => installResumeEntry('waiting (dead session)', personaRow(cfg, 'C'), calls),
      launch: spawnC,
      expected: { key: 'C', action: 'resumed' },
      events: ['patch', 'spawn', 'resume'],
    }],
    ['restart launchSession adapter, resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls),
      launch: (cfg) => launchSession('C', cfg),
      expected: true,
      events: ['patch', 'spawn', 'resume'],
    }],
    ['delete then fresh spawn after resume ErrJsonlMissing', {
      install: (cfg, calls) =>
        installStub({
          ...calls,
          spawnQueue: [
            cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
            cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
          ],
          getResult: personaRow(cfg, 'C', { state: 'ended' }),
          resumeError: errJsonlMissing(),
        }),
      launch: spawnC,
      expected: { key: 'C', action: 'fresh-after-inconclusive-amnesia' },
      events: ['patch', 'spawn', 'resume', 'spawn'],
    }],
    ['self-heal after ErrTmuxSessionCreate', {
      install: (_cfg, calls) => {
        _setTmuxSessionKiller(async () => {})
        return installStub({
          ...calls,
          spawnQueue: [
            cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
            cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
          ],
        })
      },
      launch: spawnC,
      expected: { key: 'C', action: 'spawned' },
      events: ['patch', 'spawn', 'spawn'],
    }],
  ]

  test.each(LAUNCH_PATHS)('%s: patched once, for the persona, before its first spawn or resume', async (_name, path) => {
    captureStartupErrors()
    const { cfg, configDir } = labelConfig()
    const persona = personaOf(cfg, 'C')
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    recordLaunchCalls(path.install(cfg, newLadderCalls()), events)

    let result: unknown
    await withCapturedErr(async () => {
      result = await path.launch(cfg)
    })

    expect(result).toEqual(path.expected)
    // Exactly one patch, and it comes before every agent-director launch call.
    expect(events).toEqual(path.events)
    expect(patched).toHaveLength(1)
    // For the persona being launched: its effective config dir and working directory.
    expect(patched[0]).toBe(persona)
    expect(patched[0]!.claude_config_dir).toBe(configDir)
    expect(patched[0]!.working_directory).toBe(persona.working_directory)
  })

  test('a persona whose claude_config_dir overrides the top-level one is patched for its own directory; one that inherits gets the top-level one', async () => {
    useSpawnHome()
    const topLevel = fixtureSubdir('top-level-config')
    const own = fixtureSubdir('persona-config')
    const cfg = makeStandInPersonaConfig(
      {
        C: { working_directory: fixtureSubdir('work-c'), claude_config_dir: own },
        D: { working_directory: fixtureSubdir('work-d') },
      },
      fixtureDir,
      { claude_config_dir: topLevel },
    )
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const patched = installRecordingPatcher([])

    expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'spawned' })
    expect(await spawnForPersona(personaOf(cfg, 'D'), cfg)).toEqual({ key: 'D', action: 'spawned' })

    expect(patched.map((p) => [p.key, p.claude_config_dir, p.working_directory])).toEqual([
      ['C', own, personaOf(cfg, 'C').working_directory],
      ['D', topLevel, personaOf(cfg, 'D').working_directory],
    ])
    // The patched directory is the one the launch runs under.
    expect(spawnCalls.map((p) => p.extra_env?.['CLAUDE_CONFIG_DIR'])).toEqual([own, topLevel])
  })

  test('dry run: the patcher is never called and nothing is launched', async () => {
    process.env['SLACK_DRY_RUN'] = '1'
    const { cfg } = labelConfig()
    const calls = newLadderCalls()
    installStub({ ...calls })
    const patched = installRecordingPatcher([])

    await withCapturedErr(async () => {
      expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'no-op' })
      expect(await launchSession('C', cfg)).toBe(true)
    })

    expect(patched).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(0)
    expect(calls.resumeCalls).toHaveLength(0)
  })

  test('a caller that joins a launch in flight does not patch again; the next ladder patches once more', async () => {
    const { cfg } = labelConfig()
    const persona = personaOf(cfg, 'C')
    let spawnsSeen = 0
    const stub = installStub({})
    // Hold only the first spawn open, so the second caller joins that ladder.
    const held = holdSpawns(stub, () => spawnsSeen++ === 0)
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    recordLaunchCalls(stub, events)

    let results!: Awaited<ReturnType<typeof spawnForPersona>>[]
    const errLog = await withCapturedErr(async () => {
      const a = spawnForPersona(persona, cfg)
      const b = spawnForPersona(persona, cfg)
      await held.entered('cscb_C')
      held.release('cscb_C')
      results = await Promise.all([a, b])
    })

    expect(results[1]).toBe(results[0])
    expect(errLog).toContain(`launch already in flight for ${renderPersonaRef('C', 'C')} — joining it`)
    expect(events).toEqual(['patch', 'spawn'])
    expect(patched).toEqual([persona])

    // A later call is a new ladder: patched once, before its spawn.
    expect(await spawnForPersona(persona, cfg)).toEqual({ key: 'C', action: 'spawned' })
    expect(events).toEqual(['patch', 'spawn', 'patch', 'spawn'])
  })

  test.each([
    ['fresh spawn', 'spawned'],
    ['resume of an ended row', 'resumed'],
  ] as const)('a patcher that throws is logged and the launch goes on (%s → %s)', async (path, action) => {
    const readLog = captureStartupErrors()
    const { cfg } = labelConfig()
    const calls = newLadderCalls()
    if (path === 'fresh spawn') installStub({ ...calls })
    else installResumeEntry('ended', personaRow(cfg, 'C'), calls)
    let attempts = 0
    setPreLaunchTrustPatcher(() => {
      attempts++
      throw Object.assign(new Error('trust patch exploded'), { code: 'EACCES' })
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    // The ladder outcome is what it would be with no patcher at all.
    expect(result).toEqual({ key: 'C', action })
    expect(attempts).toBe(1)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(action === 'resumed' ? 1 : 0)
    expect(errLog).toContain(
      `spawnForPersona: pre-launch trust patch failed for ${renderPersonaRef('C', 'C')} — launching anyway: `,
    )
    // Described the safe-to-log way: its type and code.
    expect(errLog).toContain('launching anyway: Error code=EACCES')
    // Logged only: no startup error, no spawn-failure notice.
    expect(readLog()).toBe('')
    expect(notices).toHaveLength(0)
  })

  test("with no patcher installed (the default, and after the test-only reset) no patch runs and the persona's .claude.json is untouched", async () => {
    const { cfg, configDir } = labelConfig()
    // A patchable file in the persona's config dir: any trust patch would add
    // the working directory to `projects`.
    const claudeJson = join(configDir, '.claude.json')
    writeFileSync(claudeJson, '{"projects":{}}')
    const before = readFileSync(claudeJson)
    const patched = installRecordingPatcher([])
    _resetPreLaunchTrustPatcher()
    const calls = newLadderCalls()
    installStub({ ...calls })

    expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'spawned' })

    expect(patched).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(readFileSync(claudeJson).equals(before)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// launchSession's relaunch gate (b.av2 SR-6.1: a persona whose Slack
// connection is not serving is not relaunched). The server passes
// `createPersonaRelaunchGate` as `canLaunch`; tests/persona-relaunch-gate.test.ts
// covers the gate itself.
// ---------------------------------------------------------------------------

describe('launchSession: the relaunch gate (canLaunch)', () => {
  /** Persona C with a recording trust patcher and a stub whose spawn and resume calls are logged with the patch. */
  function gateFixture() {
    const readLog = captureStartupErrors()
    const { cfg } = labelConfig()
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    const calls = newLadderCalls()
    recordLaunchCalls(installStub({ ...calls }), events)
    return { cfg, events, patched, calls, readLog }
  }

  test('canLaunch false: \'skipped\' — the gate is asked once with the key; no trust patch, no agent-director call, no notice, no startup error', async () => {
    const f = gateFixture()
    const asked: string[] = []

    let result: boolean | 'skipped' | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchSession('C', f.cfg, { canLaunch: (key) => (asked.push(key), false) })
    })

    expect(result).toBe('skipped')
    expect(asked).toEqual(['C'])
    expect(f.events).toEqual([])
    expect(f.patched).toEqual([])
    expect(f.calls).toEqual(newLadderCalls())
    expect(notices).toEqual([])
    expect(f.readLog()).toBe('')
    expect(errLog).toBe('')
  })

  test('canLaunch true: launched as without a gate — patched once, then spawned; true', async () => {
    const f = gateFixture()

    let result: boolean | 'skipped' | undefined
    await withCapturedErr(async () => {
      result = await launchSession('C', f.cfg, { canLaunch: () => true })
    })

    expect(result).toBe(true)
    expect(f.events).toEqual(['patch', 'spawn'])
    expect(f.calls.spawnCalls.map((p) => p.claude_instance_id)).toEqual(['cscb_C'])
  })

  test('an unknown key is false before the gate is asked', async () => {
    const f = gateFixture()
    const asked: string[] = []

    expect(await launchSession('C_UNKNOWN', f.cfg, { canLaunch: (key) => (asked.push(key), true) })).toBe(false)

    expect(asked).toEqual([])
    expect(f.events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 / AC 4 — the fixed instance ID and one in-flight launch per persona
// ---------------------------------------------------------------------------

describe('spawnForPersona: fixed instance ID and one launch in flight per persona (b.av2 SR-6.3, AC 4)', () => {
  test('the same persona spawned twice in turn: both spawns use cscb_<key>; the second meets ErrInstanceIdCollision and resolves through the ladder', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const getCalls: import('agent-director').GetParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      spawnCalls,
      getCalls,
      sendKeysCalls,
      spawnQueue: [
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })

    const first = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    const second = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(first).toEqual({ key: 'C', action: 'spawned' })
    expect(second).toEqual({ key: 'C', action: 'reconnected' })
    // No second instance ID is ever requested.
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual(['cscb_C', 'cscb_C'])
    expect(getCalls.map((g) => g.claude_instance_id)).toEqual(['cscb_C'])
    expect(sendKeysCalls.map((s) => s.text)).toEqual([`/mcp reconnect ${MCP_SERVER_NAME}`])
  })

  test('two overlapping calls for one persona make exactly one spawn and both get the same result', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))
    const persona = personaOf(cfg, 'C')

    let results!: Awaited<ReturnType<typeof spawnForPersona>>[]
    const errLog = await withCapturedErr(async () => {
      const a = spawnForPersona(persona, cfg)
      const b = spawnForPersona(persona, cfg)
      await held.entered('cscb_C')
      held.release('cscb_C')
      results = await Promise.all([a, b])
    })

    expect(held.calls).toHaveLength(1)
    expect(results[0]).toEqual({ key: 'C', action: 'spawned' })
    expect(results[1]).toBe(results[0])
    expect(errLog).toContain(`spawnForPersona: launch already in flight for ${renderPersonaRef('C', 'C')} — joining it`)
  })

  test('a launchSession for K issued while startupSessionManager is launching K joins that launch: one spawn in total', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    const start = startupSessionManager(cfg, { concurrency: 1 })
    await held.entered('cscb_C')
    const restart = launchSession('C', cfg)
    held.release('cscb_C')
    const [startResult, launched] = await Promise.all([start, restart])

    expect(held.calls).toHaveLength(1)
    expect(launched).toBe(true)
    expect(startResult.perPersona).toEqual([{ key: 'C', action: 'spawned' }])
  })

  test('overlapping calls for two personas make one spawn each, and neither waits for the other', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' }, L: { working_directory: '/x/l' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    const k = spawnForPersona(personaOf(cfg, 'K'), cfg)
    const l = spawnForPersona(personaOf(cfg, 'L'), cfg)
    // L's spawn starts while K's is still held open.
    await held.entered('cscb_K')
    await held.entered('cscb_L')
    // L settles while K is still in flight.
    held.release('cscb_L')
    expect(await l).toEqual({ key: 'L', action: 'spawned' })
    let kSettled = false
    void k.then(() => { kSettled = true })
    await settleNotices()
    expect(kSettled).toBe(false)
    held.release('cscb_K')
    expect(await k).toEqual({ key: 'K', action: 'spawned' })

    expect(held.calls.map((p) => p.claude_instance_id).sort()).toEqual(['cscb_K', 'cscb_L'])
  })

  test('isLaunchInFlight is true for a persona only while its launch is unsettled; other keys stay false', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' }, L: { working_directory: '/x/l' } }, fixtureDir)
    const held = holdSpawns(installStub({}))
    expect(isLaunchInFlight('K')).toBe(false)

    const k = spawnForPersona(personaOf(cfg, 'K'), cfg)
    await held.entered('cscb_K')
    expect(isLaunchInFlight('K')).toBe(true)
    expect(isLaunchInFlight('L')).toBe(false)

    held.release('cscb_K')
    expect(await k).toEqual({ key: 'K', action: 'spawned' })
    expect(isLaunchInFlight('K')).toBe(false)
  })

  test.each(['success', 'failed', 'a throw'] as const)('after a launch settles (%s), the next call for the persona starts a new ladder', async (settlement) => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const first =
      settlement === 'success'
        ? cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' })
        : settlement === 'failed'
          ? cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken'))
          : cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())
    const stub = installStub({
      spawnCalls,
      spawnQueue: [first, cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' })],
    })
    // 'a throw': the collision get returns no row, so the ladder throws while reading it.
    stub.get = async () => undefined as unknown as import('agent-director').GetResult
    const persona = personaOf(cfg, 'C')

    if (settlement === 'a throw') {
      await expect(spawnForPersona(persona, cfg)).rejects.toThrow()
    } else {
      expect((await spawnForPersona(persona, cfg)).action).toBe(settlement === 'success' ? 'spawned' : 'failed')
    }
    const again = await spawnForPersona(persona, cfg)

    expect(again).toEqual({ key: 'C', action: 'spawned' })
    expect(spawnCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// E3 Task 3: resume_enabled: false now replaces the row through the shared
// kill+delete+fresh path, which self-heals ErrTmuxSessionCreate (b.vub)
// ---------------------------------------------------------------------------

describe('resume_enabled: false fresh spawn self-heals ErrTmuxSessionCreate', () => {
  test('ErrTmuxSessionCreate on the fresh spawn → kill orphan tmux by name, retry once → spawned, no notice', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(killedSessions).toEqual(['slack_bot_C'])
    expect(spawnCalls).toHaveLength(3) // collision + fresh (tmux-create) + self-heal retry
    expect(notices).toHaveLength(0)
  })

  test('the self-heal retry also fails → failed, spawn-failed recorded and a spawn-failure notice', async () => {
    const readLog = captureStartupErrors()
    _setTmuxSessionKiller(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(readLog()).toContain(`self-heal spawn after ErrTmuxSessionCreate failed for ${renderPersonaRef('C', 'C')}: ErrTmuxSessionCreate`)
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('ErrTmuxSessionCreate')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.4 — a directory-broken persona's working directory
// ---------------------------------------------------------------------------

/**
 * The ways a directory-broken persona's working directory cannot be resolved
 * to a real path, each with the `cwd` its surviving row carries. A missing
 * directory's row holds the configured path. A dangling symlink's row holds
 * either the link or the link's old real target (what agent-director recorded
 * when the spawn ran there): the second compares lexically unequal to the
 * configured path.
 */
const UNRESOLVABLE_WORKDIRS = [
  'a missing directory, row cwd the configured path',
  'a dangling symlink, row cwd the link',
  'a dangling symlink, row cwd its old real target',
] as const
type UnresolvableWorkdir = (typeof UNRESOLVABLE_WORKDIRS)[number]

interface BrokenWorkdir {
  /** The persona's configured working_directory; it has no real path yet. */
  workingDirectory: string
  /** The `cwd` of the row the persona's last spawn left behind. */
  rowCwd: string
  /** Create the missing directory (or the link's target) at the same path, so the working directory resolves. */
  recreate: () => void
}

/** Build `variant` under this test's fixture dir (named `name`); nothing resolves until `recreate()`. */
function brokenWorkdir(variant: UnresolvableWorkdir, name = 'broken'): BrokenWorkdir {
  if (variant === 'a missing directory, row cwd the configured path') {
    const dir = join(fixtureDir, `${name}-work`)
    return { workingDirectory: dir, rowCwd: dir, recreate: () => void fixtureSubdir(`${name}-work`) }
  }
  const target = fixtureSubdir(`${name}-target`)
  const realTarget = realpathSync(target)
  const link = join(fixtureDir, `${name}-link`)
  symlinkSync(target, link)
  rmSync(target, { recursive: true })
  return {
    workingDirectory: link,
    rowCwd: variant === 'a dangling symlink, row cwd the link' ? link : realTarget,
    recreate: () => void fixtureSubdir(`${name}-target`),
  }
}

/** The start sweep's line for a persona whose `cwd` check it defers. */
function deferredSweepLine(name: string, key: string, workingDirectory: string): string {
  return (
    `reconcileOrphans: persona ${renderPersonaRef(name, key)} working_directory="${workingDirectory}" ` +
    'cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch'
  )
}

/** Number of deferred-check lines in a captured log. */
function countDeferredLines(errLog: string): number {
  return errLog.split('\n').filter((line) => line.includes('the cwd check is deferred to its launch')).length
}

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 (formerly SR-1.6) — the start sweep
// ---------------------------------------------------------------------------

describe('reconcileOrphans: the start sweep by persona (b.av2 SR-6.3, AC 4)', () => {
  /**
   * Three applied personas in real temp working directories, except that
   * beta's configured working_directory is a symlink to `betaReal` (the path
   * agent-director records for beta's spawn).
   */
  function sweepConfig(): { cfg: PersonaConfig; home: string; betaReal: string } {
    const home = useSpawnHome()
    const betaReal = realpathSync(fixtureSubdir('beta-work'))
    const betaLink = join(fixtureDir, 'beta-link')
    symlinkSync(betaReal, betaLink)
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: fixtureSubdir('alpha-work') },
        { name: 'beta', working_directory: betaLink },
        { name: 'gamma', working_directory: fixtureSubdir('gamma-work') },
      ],
      fixtureDir,
    )
    return { cfg, home, betaReal }
  }

  test('kills and deletes exactly the rows with no persona label, an absent persona, a wrong instance ID or a wrong cwd; keeps correct rows', async () => {
    const { cfg, home, betaReal } = sweepConfig()
    const alpha = personaOf(cfg, 'alpha')
    const beta = personaOf(cfg, 'beta')
    const gamma = personaOf(cfg, 'gamma')
    const elsewhere = fixtureSubdir('elsewhere')
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const listCalls: import('agent-director').ListParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listCalls,
      listResult: {
        spawns: [
          // Kept: correct row for an applied persona.
          cannedListRow({}, alpha, home),
          // Kept: the persona's working_directory is a symlink; the row's cwd is its real directory.
          cannedListRow({ cwd: betaReal }, beta, home),
          // Swept: only the interim `channel` label, no `persona` label.
          cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb', channel: 'alpha' } }, alpha, home),
          // Swept: names a persona absent from the applied configuration.
          cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed', channel: 'departed' } }, alpha, home),
          // Swept: right persona label, another instance ID.
          cannedListRow({ claude_instance_id: 'cscb_alpha_old' }, alpha, home),
          // Swept: right label and instance ID, another cwd.
          cannedListRow({ cwd: elsewhere }, gamma, home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(listCalls).toEqual([{ label: ['service=cscb'] }])
    expect(result).toEqual({ found: 4, killed: 4, failed: 0 })
    const swept = ['cscb_alpha_old', 'cscb_departed', 'cscb_gamma', 'cscb_legacy']
    expect(killCalls.map((k) => k.claude_instance_id).sort()).toEqual(swept)
    expect(deleteCalls.map((d) => d.claude_instance_id).sort()).toEqual(swept.map((id) => [id]))
    // Each row is swept for its own reason, named in the log.
    expect(errLog).toContain('reconcileOrphans: sweeping row (no persona label) persona=<no persona label> instanceId=cscb_legacy state=waiting — killing and deleting')
    expect(errLog).toContain('reconcileOrphans: sweeping row (absent persona) persona=departed instanceId=cscb_departed state=waiting — killing and deleting')
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong instance ID) persona=${renderPersonaRef('alpha', 'alpha')} instanceId=cscb_alpha_old state=waiting — killing and deleting`)
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('gamma', 'gamma')} instanceId=cscb_gamma state=waiting cwd=${elsewhere} — killing and deleting`)
    expect(errLog).not.toContain('instanceId=cscb_alpha state=')
    expect(errLog).not.toContain('instanceId=cscb_beta ')
    // Every working directory resolves, so nothing is deferred.
    expect(countDeferredLines(errLog)).toBe(0)
  })

  // b.av2 SR-6.4: the sweep runs before any bring-up, so it cannot compare a
  // directory-broken persona's rows by real path. It keeps them and defers the
  // cwd check to the launch; the other three conditions still apply, to that
  // persona and to every other row in the same sweep.
  test.each([...UNRESOLVABLE_WORKDIRS])(
    'working directory %s: its row is kept (neither found nor failed) with one deferred-check line; the other conditions still kill and delete',
    async (variant) => {
      const home = useSpawnHome()
      const broken = brokenWorkdir(variant)
      const cfg = makeMultiPersonaConfig(
        [
          { name: 'alpha', working_directory: fixtureSubdir('alpha-work') },
          { name: 'delta', working_directory: broken.workingDirectory },
          { name: 'gamma', working_directory: fixtureSubdir('gamma-work') },
        ],
        fixtureDir,
      )
      const alpha = personaOf(cfg, 'alpha')
      const delta = personaOf(cfg, 'delta')
      const gamma = personaOf(cfg, 'gamma')
      const elsewhere = fixtureSubdir('elsewhere')
      const killCalls: import('agent-director').KillParams[] = []
      const deleteCalls: import('agent-director').DeleteParams[] = []
      installStub({
        killCalls,
        deleteCalls,
        listResult: {
          spawns: [
            // Kept, check deferred: the directory-broken persona's own row.
            cannedListRow({ cwd: broken.rowCwd }, delta, home),
            // Swept: the directory-broken persona's label, another instance ID.
            cannedListRow({ claude_instance_id: 'cscb_delta_old', cwd: broken.rowCwd }, delta, home),
            // Swept: an absent persona.
            cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed' } }, alpha, home),
            // Swept: no persona label.
            cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb' } }, alpha, home),
            // Kept: a correct row for a resolvable persona.
            cannedListRow({}, alpha, home),
            // Swept: a resolvable persona's row in another directory.
            cannedListRow({ cwd: elsewhere }, gamma, home),
          ],
        },
      })

      let result!: Awaited<ReturnType<typeof reconcileOrphans>>
      const errLog = await withCapturedErr(async () => {
        result = await reconcileOrphans(cfg)
      })

      expect(result).toEqual({ found: 4, killed: 4, failed: 0 })
      const swept = ['cscb_delta_old', 'cscb_departed', 'cscb_gamma', 'cscb_legacy']
      expect(killCalls.map((k) => k.claude_instance_id).sort()).toEqual(swept)
      expect(deleteCalls.map((d) => d.claude_instance_id).sort()).toEqual(swept.map((id) => [id]))
      expect(errLog).toContain(deferredSweepLine('delta', 'delta', broken.workingDirectory))
      expect(countDeferredLines(errLog)).toBe(1)
      expect(errLog).toContain(
        `reconcileOrphans: sweeping row (wrong instance ID) persona=${renderPersonaRef('delta', 'delta')} instanceId=cscb_delta_old state=waiting — killing and deleting`,
      )
      expect(errLog).toContain('reconcileOrphans: sweeping row (absent persona) persona=departed instanceId=cscb_departed')
      expect(errLog).toContain('reconcileOrphans: sweeping row (no persona label) persona=<no persona label> instanceId=cscb_legacy')
      expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('gamma', 'gamma')} instanceId=cscb_gamma state=waiting cwd=${elsewhere}`)
      expect(errLog).not.toContain('instanceId=cscb_delta state=')
    },
  )

  test('two directory-broken personas: one deferred-check line each, and neither row is swept', async () => {
    const home = useSpawnHome()
    const first = brokenWorkdir('a missing directory, row cwd the configured path', 'first')
    const second = brokenWorkdir('a dangling symlink, row cwd its old real target', 'second')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'delta', working_directory: first.workingDirectory },
        { name: 'epsilon', working_directory: second.workingDirectory },
      ],
      fixtureDir,
    )
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({ cwd: first.rowCwd }, personaOf(cfg, 'delta'), home),
          cannedListRow({ cwd: second.rowCwd }, personaOf(cfg, 'epsilon'), home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(result).toEqual({ found: 0, killed: 0, failed: 0 })
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    expect(errLog).toContain(deferredSweepLine('delta', 'delta', first.workingDirectory))
    expect(errLog).toContain(deferredSweepLine('epsilon', 'epsilon', second.workingDirectory))
    expect(countDeferredLines(errLog)).toBe(2)
  })

  // A directory-broken persona's row whose cwd resolves to an existing
  // directory (here another persona's) is not deferred: it is swept as wrong
  // cwd, so the persona can never adopt that instance. A row with no real
  // path in the same sweep is still deferred.
  test('a directory-broken persona whose row cwd is an existing directory elsewhere: swept as wrong cwd, no deferred line for it', async () => {
    const home = useSpawnHome()
    const alphaWork = fixtureSubdir('alpha-work')
    const delta = brokenWorkdir('a missing directory, row cwd the configured path', 'delta')
    const epsilon = brokenWorkdir('a dangling symlink, row cwd its old real target', 'epsilon')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: alphaWork },
        { name: 'delta', working_directory: delta.workingDirectory },
        { name: 'epsilon', working_directory: epsilon.workingDirectory },
      ],
      fixtureDir,
    )
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({}, personaOf(cfg, 'alpha'), home),
          // Swept: delta's row sits in alpha's existing directory.
          cannedListRow({ cwd: alphaWork }, personaOf(cfg, 'delta'), home),
          // Kept, check deferred: epsilon's row cwd has no real path.
          cannedListRow({ cwd: epsilon.rowCwd }, personaOf(cfg, 'epsilon'), home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(result).toEqual({ found: 1, killed: 1, failed: 0 })
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_delta'])
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_delta']])
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('delta', 'delta')} instanceId=cscb_delta state=waiting cwd=${alphaWork}`)
    expect(errLog).toContain(deferredSweepLine('epsilon', 'epsilon', epsilon.workingDirectory))
    expect(countDeferredLines(errLog)).toBe(1)
  })

  test.each([
    ['kill', 'killed 1, failed 0', { found: 1, killed: 1, failed: 0 }],
    ['delete', 'killed 0, failed 1', { found: 1, killed: 0, failed: 1 }],
  ] as const)('a %s failure records orphan-cleanup; the delete is still attempted (%s)', async (verb, _label, expected) => {
    const readLog = captureStartupErrors()
    const { cfg, home } = sweepConfig()
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_alpha_old' }, personaOf(cfg, 'alpha'), home)] },
      killError: verb === 'kill' ? errGeneric('kill', 'ErrKillBroken') : undefined,
      deleteError: verb === 'delete' ? errGeneric('delete', 'ErrDeleteBroken') : undefined,
    })

    const result = await reconcileOrphans(cfg)

    expect(result).toEqual(expected)
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_alpha_old'])
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_alpha_old']])
    const log = readLog()
    expect(countStartupEntries(log, 'orphan-cleanup')).toBe(1)
    expect(log).toContain(
      `${verb} failed for orphan instanceId=cscb_alpha_old persona=${renderPersonaRef('alpha', 'alpha')}: Err${verb === 'kill' ? 'Kill' : 'Delete'}Broken`,
    )
  })

  test('list failure → recorded + zero counts (no crash)', async () => {
    const readLog = captureStartupErrors()
    installStub({ listError: new Error('AD down') })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await reconcileOrphans(cfg)
    expect(result.found).toBe(0)
    expect(result.killed).toBe(0)
    expect(readLog()).toContain('[orphan-cleanup-list-failed]')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.4 — the collision ladder keeps a row while the persona's
// working directory cannot be resolved, and reuses it once the persona is up
// ---------------------------------------------------------------------------

describe('collision ladder: a directory-broken persona keeps its row (b.av2 SR-6.4)', () => {
  /** Persona `C` in `workingDirectory`, the seam home installed. */
  function brokenConfig(workingDirectory: string): PersonaConfig {
    useSpawnHome()
    return makeStandInPersonaConfig({ C: { working_directory: workingDirectory } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
  }

  /** `n` colliding spawns, then one that succeeds (for a fresh spawn after kill + delete). */
  function collisionsThenOk(n: number): CannedResponse<import('agent-director').SpawnResult>[] {
    return [
      ...Array.from({ length: n }, () => cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())),
      cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
    ]
  }

  async function launch(cfg: PersonaConfig): Promise<{ result: Awaited<ReturnType<typeof spawnForPersona>>; errLog: string }> {
    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })
    return { result, errLog }
  }

  // A working directory that stops resolving between the persona's directory
  // check and its launch, with a row `cwd` that has no real path either and
  // differs lexically from the configured path (a lexically equal one never
  // reaches the cwd guard). The guard runs before the ladder branches on
  // state, so two states that would otherwise reuse the row are enough.
  test.each(['ended', 'waiting'] as const)(
    'a dangling symlink, row cwd its old real target, state=%s: no kill, delete, resume or reconnect; cwd-unreachable and failed (the spawn-failure path)',
    async (state) => {
      const { workingDirectory, rowCwd } = brokenWorkdir('a dangling symlink, row cwd its old real target')
      const cfg = brokenConfig(workingDirectory)
      const calls = newLadderCalls()
      installStub({ ...calls, spawnQueue: collisionsThenOk(1), getResult: personaRow(cfg, 'C', { state, cwd: rowCwd }) })

      const { result, errLog } = await launch(cfg)

      expect(result).toEqual({ key: 'C', action: 'failed' })
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
      expect(calls.resumeCalls).toHaveLength(0)
      expect(calls.sendKeysCalls).toHaveLength(0)
      expect(calls.findMissingCalls).toHaveLength(0)
      // As a spawn in a missing directory fails: the cwd-unreachable onset
      // naming the working directory, and no spawn-failure notice.
      expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
      expect(outageEmissions.filter((e) => e.key === 'C' && e.text.includes(workingDirectory))).toHaveLength(1)
      expect(notices).toHaveLength(0)
      expect(errLog).toContain(
        `spawnForPersona: ${renderPersonaRef('C', 'C')} working_directory=${workingDirectory} cannot be resolved to a real path — ` +
          `keeping its row (cwd=${rowCwd}, state=${state}); the launch fails and is retried by the restart path`,
      )
      expect(errLog).not.toContain('replacing the row')
    },
  )

  // The common case: the row holds the configured path itself, which matches
  // lexically, so the ladder reaches the row's own branch. Its resume fails
  // on the missing directory as a spawn would, and the row is never removed.
  test('a removed directory whose row cwd is the configured path: the resume fails with ErrCwdNotFound → cwd-unreachable and failed, no kill or delete', async () => {
    const work = fixtureSubdir('work')
    const cfg = brokenConfig(work)
    rmSync(work, { recursive: true })
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: collisionsThenOk(1),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: new ErrCwdNotFound('resume', 'ErrCwdNotFound', `cwd ${work} does not exist`),
    })

    const { result } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // A row whose cwd resolves to an existing directory elsewhere is not
  // deferred even while the persona's own directory is missing: it may be
  // another persona's instance, so it is replaced, never adopted. The fresh
  // spawn then fails on the missing directory as any spawn there would.
  test('a removed directory whose row cwd is another existing directory: killed, deleted and spawned fresh; the fresh spawn fails with ErrCwdNotFound → cwd-unreachable', async () => {
    const work = fixtureSubdir('work')
    const cfg = brokenConfig(work)
    rmSync(work, { recursive: true })
    const elsewhere = fixtureSubdir('elsewhere')
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${work} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended', cwd: elsewhere }),
    })

    const { result, errLog } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.resumeCalls).toHaveLength(0)
    // The colliding spawn, then the fresh one in the persona's directory.
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].cwd).toBe(work)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=${elsewhere} differs from working_directory=${work} (state=ended) — replacing the row: kill+delete+fresh`,
    )
    expect(errLog).not.toContain('cannot be resolved')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // The persona's retry launch once its directory is usable goes through
  // spawnForPersona (the bring-up controller's launch). Its row first survives
  // the start sweep, then the ladder reuses it: the history is kept. The row
  // holds the old real target, the one shape that compares lexically unequal
  // (the other shapes are covered by the sweep table).
  test.each([
    ['waiting', 'reconnected'],
    ['working', 'reconnected'],
    ['ended', 'resumed'],
    ['missing', 'resumed'],
  ] as const)(
    'a dangling symlink, row cwd its old real target, kept by the sweep, then created: a %s row is reused (%s) — no kill, delete or fresh spawn',
    async (state, action) => {
      const broken = brokenWorkdir('a dangling symlink, row cwd its old real target')
      const cfg = brokenConfig(broken.workingDirectory)
      const calls = newLadderCalls()
      installStub({
        ...calls,
        listResult: { spawns: [cannedListRow({ cwd: broken.rowCwd, state }, personaOf(cfg, 'C'), ladderHome())] },
        spawnQueue: collisionsThenOk(1),
        getResult: personaRow(cfg, 'C', { state, cwd: broken.rowCwd }),
        // A working row reaches waiting on the second poll.
        statusQueue: state === 'working' ? [cannedOk<import('agent-director').StatusResult>({ state: 'working' })] : undefined,
      })

      let sweep!: Awaited<ReturnType<typeof reconcileOrphans>>
      const sweepLog = await withCapturedErr(async () => {
        sweep = await reconcileOrphans(cfg)
      })
      expect(sweep).toEqual({ found: 0, killed: 0, failed: 0 })
      expect(sweepLog).toContain(deferredSweepLine('C', 'C', broken.workingDirectory))

      broken.recreate()
      const { result, errLog } = await launch(cfg)

      expect(result).toEqual({ key: 'C', action })
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(action === 'resumed' ? ['cscb_C'] : [])
      expect(calls.sendKeysCalls.map((s) => s.text)).toEqual(action === 'reconnected' ? [`/mcp reconnect ${MCP_SERVER_NAME}`] : [])
      // The resume passed the config_dir check; neither guard fired.
      expect(errLog).not.toContain('config_dir label')
      expect(errLog).not.toContain('cannot be resolved')
      expect(errLog).not.toContain('replacing the row')
      expect(getOutageFlags('C').has('cwd-unreachable')).toBe(false)
    },
  )

  test('a persona come up with an ended row carrying a stale config_dir label: the config_dir check still runs → delete + fresh spawn, no resume', async () => {
    const broken = brokenWorkdir('a dangling symlink, row cwd its old real target')
    const cfg = brokenConfig(broken.workingDirectory)
    const stale = personaConfigDirLabelValue(fixtureSubdir('earlier-config'), ladderHome())
    const row = personaRow(cfg, 'C', { state: 'ended', cwd: broken.rowCwd })
    const calls = newLadderCalls()
    installStub({ ...calls, spawnQueue: collisionsThenOk(1), getResult: { ...row, labels: { ...row.labels, config_dir: stale } } })

    broken.recreate()
    const { result, errLog } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.spawnCalls).toHaveLength(2)
    expect(errLog).toContain(`spawnForPersona: ${renderPersonaRef('C', 'C')} config_dir label changed (was=${stale}`)
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager — iterate personas (b.av2 SR-6.3)
// ---------------------------------------------------------------------------

describe('startupSessionManager', () => {
  test('counts succeeded/failed per persona', async () => {
    captureStartupErrors()
    let callIdx = 0
    const stub = installStub({})
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      callIdx++
      if (callIdx === 2) throw new Error('boom')
      return realSpawn(params)
    }
    const cfg = makeMultiPersonaConfig(
      [
        // alpha is listed in two channels and still counts once.
        {
          name: 'alpha',
          working_directory: '/x1',
          channels: [
            { id: 'C0HOME01', delivery: 'all' },
            { id: 'C0SHARED1', delivery: 'mentions' },
          ],
        },
        { name: 'beta', working_directory: '/x2' },
        { name: 'gamma', working_directory: '/x3' },
      ],
      fixtureDir,
    )
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.succeeded + result.failed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(2)
    // One outcome per persona, keyed by persona; concurrency 1 makes the second (beta) the failure.
    expect(result.perPersona).toEqual([
      { key: 'alpha', action: 'spawned' },
      { key: 'beta', action: 'failed' },
      { key: 'gamma', action: 'spawned' },
    ])
  })

  // AC 3 (b.av2 SR-14 "session-manager: one spawn"): a persona listed in two
  // channels is ONE instance — exactly one spawn, never one per channel.
  test('AC 3: one persona listed in two channels produces exactly one spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeMultiPersonaConfig(
      [
        {
          name: 'alpha',
          working_directory: '/x/alpha',
          channels: [
            { id: 'C0HOME01', delivery: 'all' },
            { id: 'C0SHARED1', delivery: 'mentions' },
          ],
          permission_prompts: 'C0HOME01',
        },
        {
          name: 'beta',
          working_directory: '/x/beta',
          channels: [{ id: 'C0SHARED1', delivery: 'mentions' }],
          permission_prompts: 'C0SHARED1',
        },
      ],
      fixtureDir,
    )

    const result = await startupSessionManager(cfg)

    const ids = spawnCalls.map((p) => p.claude_instance_id)
    expect(spawnCalls).toHaveLength(2)
    expect(ids.filter((id) => id === 'cscb_alpha')).toHaveLength(1)
    expect(ids.filter((id) => id === 'cscb_beta')).toHaveLength(1)
    // No spawn is keyed by a channel.
    expect(ids.some((id) => String(id).includes('C0HOME01') || String(id).includes('C0SHARED1'))).toBe(false)
    // Each spawn carries its own persona's working directory and persona label.
    const byId = new Map(spawnCalls.map((p) => [p.claude_instance_id, p]))
    expect(byId.get('cscb_alpha')!.cwd).toBe('/x/alpha')
    expect(byId.get('cscb_alpha')!.label).toEqual(['service=cscb', 'persona=alpha', expect.stringMatching(/^config_dir=/)])
    expect(byId.get('cscb_beta')!.cwd).toBe('/x/beta')
    expect(byId.get('cscb_beta')!.label).toEqual(['service=cscb', 'persona=beta', expect.stringMatching(/^config_dir=/)])
    // Result counts are per persona.
    expect(result.succeeded).toBe(2)
    expect(result.freshSpawned).toBe(2)
    expect(result.failed).toBe(0)
    expect([...result.perPersona].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'alpha', action: 'spawned' },
      { key: 'beta', action: 'spawned' },
    ])
  })

  // b.av2 SR-2.2: logs and errors name the persona in rendered form — the name
  // JSON-quoted with the key beside it.
  test('a startup spawn failure names the persona in rendered form (JSON-quoted name plus key)', async () => {
    const readLog = captureStartupErrors()
    installStub({ spawnError: errGeneric('spawn', 'ErrSpawnBroken') })
    const name = 'Ops "Prod" Bot'
    const key = personaKey(name)
    const cfg = makeMultiPersonaConfig([{ name, working_directory: '/x/ops' }], fixtureDir)
    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    try {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    } finally {
      console.error = realError
    }

    expect(result.failed).toBe(1)
    const rendered = `"Ops \\"Prod\\" Bot" (key=${key})`
    expect(rendered).toBe(renderPersonaRef(name, key))
    const log = readLog()
    expect(log).toContain('[spawn-failed]')
    expect(log).toContain(`spawn failed for ${rendered}: ErrSpawnBroken`)
    expect(lines.some((l) => l.includes(`spawnForPersona: spawn failed for ${rendered}`))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager with the SR-6.1 bring-up (b.av2 SR-6.1, SR-11)
//
// The server passes its bring-up controller as `bringUp`: each persona goes
// through its credentials, working-directory and Slack steps and ends `up`,
// `broken` or `retrying`; only an `up` persona is launched by the pool. The
// procedure and the controller are tested in tests/persona-bringup.test.ts and
// tests/persona-connections.test.ts; these cases pin the start pool's
// bookkeeping: a `broken` or `retrying` persona is "not brought up", never a
// failed spawn, a startup error or a notice, and a retrying persona that
// comes up later is launched outside the pool.
// ---------------------------------------------------------------------------

describe('startupSessionManager: SR-6.1 bring-up', () => {
  let managers: PersonaConnectionManager[] = []
  let controllers: PersonaBringUpController[] = []

  beforeEach(() => {
    managers = []
    controllers = []
    // This block handles credentials: an accidental environment read gets fakes (restored by the file's afterEach).
    process.env['SLACK_BOT_TOKEN'] = fakeToken(BOT_TOKEN_PREFIX, 'env')
    process.env['SLACK_APP_TOKEN'] = fakeToken(APP_TOKEN_PREFIX, 'env')
    delete process.env['SLACK_DRY_RUN']
  })

  afterEach(async () => {
    for (const c of controllers) c.cancelAll()
    await Promise.all(managers.map((m) => m.stopAll()))
  })

  /**
   * Personas named `names` (A and B by default; names differ from keys), each
   * with its own working directory and credentials file under fixtureDir, on
   * the real connection manager over the stub factory and a fake clock
   * (`makeConnectionHarness` with `files: true`). `slack` scripts each
   * persona's stub by name. `bringUp` is what the server passes to
   * `startupSessionManager`: the real bring-up controller over the harness's
   * recording `connections` (which records `slack:<key>` in `order`) and the
   * manager's status, on the harness's fake clock, with the manager's status
   * listener wired to it and `spawnForPersona(persona, cfg, false)` as its
   * launch after a retry, as server.ts wires it. `lines` holds the manager's
   * and the controller's lines.
   */
  function bringUpFixture(slackA: StubSlackOptions = {}, names = ['Alpha Desk', 'Beta Ops'], slack: Record<string, StubSlackOptions> = {}) {
    const h = makeConnectionHarness(names.map((name) => ({ name })), fixtureDir, {
      files: true,
      stubOptions: { [names[0]!]: slackA, ...slack },
    })
    managers.push(h.manager)
    const [a, b] = h.personas as [Persona, Persona]
    const lines = h.lines
    const cfg = h.config!
    const bringUp = createPersonaBringUpController({
      connections: { bringUp: h.connections.bringUp, status: (key) => h.manager.status(key) },
      dryRun: false,
      log: (line) => void lines.push(line),
      launch: (persona) => spawnForPersona(persona, cfg, false),
      clock: h.clock,
    })
    controllers.push(bringUp)
    h.onStatus = (key, status) => bringUp.onConnectionStatus(key, status)
    return { h, cfg, a, b, lines, order: h.order, bringUp }
  }

  /** Poll `cond` (real time, 1 ms steps) for at most `ms`; the caller asserts afterwards. */
  async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
    for (let waited = 0; !cond() && waited < ms; waited++) await new Promise((r) => setTimeout(r, 1))
  }

  // b.av2 SR-6.1: each cause gives A its outcome — credentials-broken is
  // `broken`; directory-broken and Slack-unreachable are `retrying` (their
  // retries run on the persona's own timers, which these cases never fire).
  test.each<[string, (f: ReturnType<typeof bringUpFixture>) => void, StubSlackOptions, Exclude<PersonaBringUpOutcome, 'up'>, PersonaBringUpStep, string]>([
    ['credentials file missing (step 1) → broken', (f) => rmSync(f.a.credentials_file), {}, 'broken', 'credentials', 'persona-credentials-missing'],
    ['working directory missing (step 2) → retrying', (f) => rmSync(f.a.working_directory, { recursive: true }), {}, 'retrying', 'working-directory', 'persona-directory-missing'],
    ['Slack refuses A\'s bot token (step 3) → broken', () => {}, { authTest: [{ kind: 'platform', error: 'invalid_auth' }] }, 'broken', 'slack', 'persona-credentials-refused'],
    ['Slack unreachable for A (step 3) → retrying', () => {}, { authTest: [{ kind: 'network' }] }, 'retrying', 'slack', 'persona-slack-unreachable'],
  ])('%s: A is not brought up — no spawn, no failed count, no startup error, no notice; B is launched', async (_label, arrange, slackA, outcome, step, cls) => {
    const readLog = captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const f = bringUpFixture(slackA)
    arrange(f)

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'not-brought-up', outcome, failures: [{ step, class: cls, cause: expect.any(String) }] },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.notBroughtUp).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(result.freshSpawned).toBe(1)
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${f.b.key}`])
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    expect(outageEmissions).toEqual([])
    expect(errLog).toContain(
      'startupSessionManager: complete — 2 persona(s): 0 resumed, 1 fresh-spawned, 0 fresh-after-amnesia, ' +
        '0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 1 not brought up',
    )
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  test('a persona brought up goes on to the collision ladder after its connection is up: its ended row is resumed', async () => {
    captureStartupErrors()
    const f = bringUpFixture()
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${f.b.key}` }),
      ],
      getResult: personaRow(f.cfg, f.a.key, { state: 'ended' }),
    })
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      f.order.push(`spawn:${params.claude_instance_id}`)
      return realSpawn(params)
    }

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    // Both Slack bring-ups start at once; only the launches are pooled (here one at a time, in readiness order).
    expect(f.order).toEqual([`slack:${f.a.key}`, `slack:${f.b.key}`, `spawn:cscb_${f.a.key}`, `spawn:cscb_${f.b.key}`])
    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'resumed' },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.notBroughtUp).toBe(0)
    expect(result.resumed).toBe(1)
    expect(errLog).toContain('0 failed, 0 not brought up')
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // A launch that throws (not a failed ladder: spawnForPersona itself rejects)
  // is caught per persona; the next persona in the pool still launches.
  test('concurrency 1: A\'s launch throws — A is counted failed with a startup error, and B is still spawned', async () => {
    const readLog = captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const f = bringUpFixture()
    // Building A's spawn parameters throws, so A's launch rejects outright.
    Object.defineProperty(f.a, 'claude_config_dir', {
      get() {
        throw new Error('launch exploded for A')
      },
    })

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'failed' },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.notBroughtUp).toBe(0)
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${f.b.key}`])
    expect(errLog).toContain(`startupSessionManager: unexpected error for ${renderPersonaRef(f.a.name, f.a.key)}`)
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(1)
    expect(readLog()).toContain(`unexpected error spawning ${renderPersonaRef(f.a.name, f.a.key)}`)
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // The launch pool: steps 1–3 run for every persona at once; only the
  // launches share `concurrency` slots, taken in the order personas become
  // ready. Each persona's socket open is deferred so the test picks the
  // readiness order, and every spawn is held so no launch settles until the
  // test releases it.
  test('pool (5 personas, concurrency 3, launches held): every Slack bring-up finishes before any launch settles; at most 3 launches run, in readiness order; a persona not brought up takes no slot', async () => {
    captureStartupErrors()
    const names = ['Alpha Desk', 'Beta Ops', 'Gamma Hub', 'Delta Bay', 'Echo Den']
    const connects = new Map<string, DeferredConnect>(names.map((name) => [name, makeDeferredConnect()]))
    const f = bringUpFixture({}, names, Object.fromEntries(names.map((name) => [name, { connect: [connects.get(name)!.outcome] }])))
    const [alpha, beta, gamma, delta, echo] = f.h.personas as Persona[]
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)
    const id = (p: Persona) => `cscb_${p.key}`
    const settle = async (p: Persona, outcome?: Parameters<DeferredConnect['settle']>[0]) => {
      connects.get(p.name)!.settle(outcome)
      await waitFor(() => f.h.manager.status(p.key)?.state !== 'connecting')
    }

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      const start = startupSessionManager(f.cfg, { concurrency: 3, bringUp: f.bringUp })

      // Every persona's Slack step starts at once, before any launch.
      await waitFor(() => f.order.length === names.length)
      expect(f.order).toEqual(f.h.personas.map((p) => `slack:${p.key}`))
      expect(launched()).toEqual([])

      // Ready in the order Delta, (Beta refused), Echo, Alpha, Gamma.
      await settle(delta)
      await waitFor(() => launched().length === 1)
      await settle(beta, { kind: 'platform', error: 'invalid_auth' })
      await settle(echo)
      await waitFor(() => launched().length === 2)
      await settle(alpha)
      await waitFor(() => launched().length === 3)
      await settle(gamma)
      await waitFor(() => launched().length > 3, 50)

      // Beta took no slot: the three slots are Delta, Echo and Alpha, all held; Gamma waits.
      expect(launched()).toEqual([id(delta), id(echo), id(alpha)])
      expect(held.held()).toEqual([id(delta), id(echo), id(alpha)])
      // Every Slack bring-up has finished while no launch has settled.
      expect(f.h.personas.map((p) => [p.key, f.h.manager.status(p.key)?.state])).toEqual([
        [alpha.key, 'up'], [beta.key, 'broken'], [gamma.key, 'up'], [delta.key, 'up'], [echo.key, 'up'],
      ])

      // A slot frees: the next ready persona (Gamma) takes it; still at most 3 running.
      held.release(id(echo))
      await waitFor(() => launched().length === 4)
      expect(launched()).toEqual([id(delta), id(echo), id(alpha), id(gamma)])
      expect(held.held()).toEqual([id(delta), id(alpha), id(gamma)])

      held.releaseAll()
      result = await start
    })

    expect(result.notBroughtUp).toBe(1)
    expect(result.freshSpawned).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.perPersona.find((o) => o.key === beta.key)).toEqual({
      key: beta.key,
      action: 'not-brought-up',
      outcome: 'broken',
      failures: [{ step: 'slack', class: 'persona-credentials-refused', cause: expect.any(String) }],
    })
    expect(launched()).not.toContain(id(beta))
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // b.av2 SR-6.1: retries run outside the pool. A (Slack unreachable at start)
  // is `retrying` and B (credentials file missing) is `broken`; neither takes a
  // slot or counts as failed. With the single slot held by C and D queued, A's
  // manager retry (fake clock) brings it up and the controller launches it at
  // once, not behind the pool; the pass then returns while A's launch is still
  // held, and A's later launch never enters the pass's counts.
  test('concurrency 1, launches held: a retrying persona that comes up later is launched outside the pool — it neither waits for the pass nor blocks it; broken and retrying take no slot and are not failures', async () => {
    const readLog = captureStartupErrors()
    const names = ['Alpha Desk', 'Beta Ops', 'Gamma Hub', 'Delta Bay']
    const f = bringUpFixture({ authTest: [{ kind: 'network' }] }, names)
    const [alpha, beta, gamma, delta] = f.h.personas as Persona[]
    rmSync(beta.credentials_file)
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)
    const id = (p: Persona) => `cscb_${p.key}`

    let result: Awaited<ReturnType<typeof startupSessionManager>> | undefined
    const errLog = await withCapturedErr(async () => {
      const start = startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
      void start.then((r) => { result = r })

      // Gamma holds the only slot; Delta queues; Alpha is retrying, Beta broken.
      await waitFor(() => launched().length === 1)
      await waitFor(() => launched().length > 1, 50)
      expect(launched()).toEqual([id(gamma)])
      expect(f.h.manager.status(alpha.key)).toMatchObject({ state: 'retrying', phase: 'bring-up' })
      expect(f.bringUp.state(beta.key)?.outcome).toBe('broken')

      // Alpha's retry succeeds: its launch starts at once, beside the held slot.
      await f.h.clock.runNext()
      await waitFor(() => launched().length === 2)
      expect(f.h.manager.status(alpha.key)?.state).toBe('up')
      expect(launched()).toEqual([id(gamma), id(alpha)])
      expect(held.held()).toEqual([id(gamma), id(alpha)])
      expect(result).toBeUndefined()

      // The pool finishes Gamma then Delta; the pass returns with Alpha's launch still held.
      held.release(id(gamma))
      await waitFor(() => launched().length === 3)
      held.release(id(delta))
      await waitFor(() => result !== undefined)
      expect(result).toBeDefined()
      expect(held.held()).toEqual([id(alpha)])
      expect(isLaunchInFlight(alpha.key)).toBe(true)

      held.release(id(alpha))
      await waitFor(() => !isLaunchInFlight(alpha.key))
    })

    expect(isLaunchInFlight(alpha.key)).toBe(false)
    expect(launched()).toEqual([id(gamma), id(alpha), id(delta)])
    const byKey = (x: { key: string }, y: { key: string }) => x.key.localeCompare(y.key)
    const expected: StartupPersonaOutcome[] = [
      { key: gamma.key, action: 'spawned' },
      { key: delta.key, action: 'spawned' },
      {
        key: alpha.key,
        action: 'not-brought-up',
        outcome: 'retrying',
        failures: [{ step: 'slack', class: 'persona-slack-unreachable', cause: expect.any(String) }],
      },
      {
        key: beta.key,
        action: 'not-brought-up',
        outcome: 'broken',
        failures: [{ step: 'credentials', class: 'persona-credentials-missing', cause: expect.any(String) }],
      },
    ]
    expect([...result!.perPersona].sort(byKey)).toEqual(expected.sort(byKey))
    expect(result!.notBroughtUp).toBe(2)
    expect(result!.failed).toBe(0)
    expect(result!.succeeded).toBe(2)
    expect(result!.freshSpawned).toBe(2)
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    expect(errLog).toContain('0 failed, 2 not brought up')
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  test('without bringUp: launches go through the same pool in config order, at most `concurrency` at once', async () => {
    const cfg = makeMultiPersonaConfig(
      ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, working_directory: `/x/${name}` })),
      fixtureDir,
    )
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    await withCapturedErr(async () => {
      const start = startupSessionManager(cfg, { concurrency: 3 })
      await waitFor(() => launched().length === 3)
      await waitFor(() => launched().length > 3, 50)
      expect(launched()).toEqual(['cscb_alpha', 'cscb_beta', 'cscb_gamma'])

      held.release('cscb_beta')
      await waitFor(() => launched().length === 4)
      expect(launched()).toEqual(['cscb_alpha', 'cscb_beta', 'cscb_gamma', 'cscb_delta'])
      expect(held.held()).toEqual(['cscb_alpha', 'cscb_gamma', 'cscb_delta'])

      held.releaseAll()
      result = await start
    })

    expect(result.freshSpawned).toBe(4)
    expect(result.notBroughtUp).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// b.rmy — ErrTmuxSendKeys self-heal + accurate reconnect outcome reporting
// ---------------------------------------------------------------------------

describe('b.rmy: ErrTmuxSendKeys self-heal + reconnect outcome', () => {
  test('reconnectMcp: ErrTmuxSendKeys → ensure tmux server + retry once → success', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('ok')
    expect(ensureCalls).toBe(1)
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls[1].text).toContain('/mcp reconnect')
    // Retry succeeded — no failure notice
    expect(notices).toHaveLength(0)
  })

  test('reconnectMcp: retry after ErrTmuxSendKeys also fails → dead-session (b.3ce: caller recovers, no failure notice)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errTmuxSendKeys(), // persistent — first attempt AND retry fail
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('dead-session')
    expect(ensureCalls).toBe(1) // self-heal attempted exactly once (single retry)
    expect(sendKeysCalls).toHaveLength(2)
    // b.3ce: dead-session hands recovery to the caller — no premature failure notice
    expect(notices).toHaveLength(0)
  })

  test('reconnectMcp: non-tmux sendKeys error → no self-heal, no retry', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errGeneric('send-keys', 'ErrSomethingElse'),
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(ensureCalls).toBe(0)
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('spawnForPersona waiting branch: self-heal retry succeeds → reconnected', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    _setTmuxServerEnsurer(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(2)
  })

  test('spawnForPersona waiting branch (b.3ce): persistent ErrTmuxSendKeys → resume recovery, not failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent — self-heal retry fails too (dead session)
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    // b.3ce: pre-fix this reported 'failed' and gave up; now the dead session
    // falls through to the ended/missing recovery logic (resume-first).
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(readLog()).toBe('')
  })

  test('spawnForPersona waiting branch (b.3ce): dead session + resume not resumable → kill+delete+fresh spawn', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errSpawnNotResumable(), // stale `waiting` row rejects resume
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2) // initial collision + fresh spawn
  })

  test('spawnForPersona waiting branch: dead session and recovery also fails → action=failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errGeneric('resume', 'ErrResumeBroken'), // recovery fails too
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(readLog()).toBe('') // resume-failure path raises a spawn-failure notice; no reconnect-failed startup entry
  })

  test('startupSessionManager: unrecoverable channels are counted (no false "0 failed")', async () => {
    captureStartupErrors() // keep startup-errors.log in a temp dir
    _setTmuxServerEnsurer(async () => {})
    // Both routes collide into `waiting` rows whose reconnect send-keys fails
    // persistently — the 2026-09-18 post-reboot outage shape — AND the b.3ce
    // resume recovery fails, so both must land in the failed bucket.
    const cfg = makeStandInPersonaConfig({ C1: { working_directory: '/x1' }, C2: { working_directory: '/x2' } }, fixtureDir)
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      sendKeysError: errTmuxSendKeys(),
      resumeError: errGeneric('resume', 'ErrResumeBroken'),
    })
    // Each persona's collision get returns its own `waiting` row.
    stub.get = personaRowsGet(cfg, { state: 'waiting' })
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.failed).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.perPersona.every((p) => p.action === 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// b.3ce — waitForWaitingAndReconnect timeout liveness verdict + working-branch
// dead-session recovery
// ---------------------------------------------------------------------------

describe('b.3ce: waitForWaitingAndReconnect timeout liveness + dead-session recovery', () => {
  // b.ecw: the timeout branch now keys on the claude PROCESS via a fresh
  // findMissing sweep + one status call, NOT the raw tmux probe. A process
  // merely mid-long-turn reports a live state and stays 'ok' — the tmux prober
  // is never consulted on the happy/live path.
  test('timeout with claude process alive (status working) → ok, tmux NOT probed (long turns are not errors — regression guard)', async () => {
    _setWaitForWaitingTimeoutMs(30)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing(), // b.m4r: empty sweep — a genuinely-alive long-turn row is untouched
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // process mid-long-turn
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
    // b.ecw: the live-status verdict is authoritative — the raw tmux probe is
    // NOT called on this path.
    expect(probed).toEqual([])
    expect(findMissingCalls).toHaveLength(1)
  })

  // b.ecw: at the 10-minute deadline the 10s memo has expired, so a FRESH
  // whole-store findMissing sweep fires before the timeout status call. TTL=0
  // forces the memo to expire so the second (timeout) sweep is observable.
  test('timeout fires a FRESH findMissing sweep before the timeout status call', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0) // memo expired by the deadline → timeout re-sweeps
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing(),
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // stays live → up-front sweep does not short-circuit the loop
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok') // status live at timeout → ok
    // Up-front sweep + fresh timeout sweep = 2 (TTL=0 defeats memo reuse).
    expect(findMissingCalls).toHaveLength(2)
  })

  // b.ecw: the timeout status reports the process is gone (`missing`) → provably
  // dead → 'dead-session', with NO tmux probe. The poll loop stays `working`
  // (frozen mid-turn) until the deadline; only the timeout status flips to
  // `missing`, so the timeout branch (not the ended/missing loop branch) decides.
  test('timeout with claude process gone (status missing at deadline) → dead-session, tmux NOT probed', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0) // memo expired by the deadline → the timeout re-sweeps
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true }) // even an "alive" tmux shell must not save a dead process
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      // Poll loop (after the up-front sweep, findMissingCalls===1) still sees a
      // frozen `working`; only after the FRESH timeout sweep (findMissingCalls===2)
      // does the row reconcile to `missing`, so the timeout branch decides.
      statusFn: () =>
        ({ state: findMissingCalls.length >= 2 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // process verdict is authoritative; tmux never consulted
  })

  // b.ecw: at the TIMEOUT CALL AD reports a status error — either ErrSpawnNotFound
  // (no row to reconcile) or any other status error (an AD outage at the deadline).
  // Either way CSCB must NOT manufacture a verdict from the AD gap; it falls back
  // to the raw tmux probe (b.rmy invariant): tmux gone → dead-session, tmux alive
  // → ok. The poll loop stays `working` and exits on the deadline; only the timeout
  // status call throws (TTL=0 makes the timeout sweep bump findMissingCalls to 2,
  // which flips statusFn into its error branch).
  test.each([
    ['ErrSpawnNotFound', () => errSpawnNotFound(), false, 'dead-session'],
    ['ErrSpawnNotFound', () => errSpawnNotFound(), true, 'ok'],
    ['generic status error', () => errGeneric('status', 'ErrTimeout'), true, 'ok'],
    ['generic status error', () => errGeneric('status', 'ErrTimeout'), false, 'dead-session'],
  ] as const)(
    'timeout with %s + tmux %s → %s (tmux fallback)',
    async (_label, errorFactory, tmuxAlive, expected) => {
      _setWaitForWaitingTimeoutMs(30)
      _setFindMissingMemoTtlMs(0)
      const probed: string[] = []
      _setTmuxSessionProber(async (name) => { probed.push(name); return tmuxAlive })
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      installStub({
        findMissingCalls,
        findMissingResult: cannedFindMissing(),
        statusFn: () =>
          findMissingCalls.length >= 2
            ? errorFactory()
            : ({ state: 'working' } as import('agent-director').StatusResult),
      })
      const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
      const result = await waitForWaitingAndReconnect('C', cfg)
      expect(result).toBe(expected)
      expect(probed).toEqual(['slack_bot_C']) // fell back to tmux
    },
  )

  // b.ecw: the poll loop's ended/missing branch aborts early. `statusFn` flips to
  // `missing` on the FIRST poll after the up-front sweep (findMissingCalls >= 1),
  // so waitForWaitingAndReconnect returns dead-session from the loop branch WITHOUT
  // ever reaching the deadline — the timeout branch never runs. spawnForPersona then
  // drives the dead-session recovery (findMissing-before-resume → resume).
  test('spawnForPersona working branch: loop ended/missing early-abort → dead-session → resume recovery', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      // Up-front sweep reconciles the frozen row; the first poll then sees `missing`,
      // so the loop's ended/missing branch returns dead-session before the deadline.
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () =>
        ({ state: findMissingCalls.length >= 1 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
  })

  test('spawnForPersona working branch: timeout + session alive → reconnected (no kill/resume/spawn)', async () => {
    _setWaitForWaitingTimeoutMs(30)
    // The timeout live path decides on the fresh status call alone and never
    // consults tmux; capture the prober to prove it is not called.
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnCalls,
      killCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      statusResult: { state: 'working' } as import('agent-director').StatusResult,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('reconnected')
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(0)
    expect(spawnCalls).toHaveLength(1) // only the initial colliding spawn
    expect(probed).toEqual([]) // live timeout verdict never consults tmux
  })
})

// ---------------------------------------------------------------------------
// b.4dk — findMissing-before-resume on the dead-session recovery path
//
// AD's resume verb requires a terminal (ended/missing) row. A dead-session
// verdict arrives with a LIVE-state row (waiting/working), so pre-fix resume
// was structurally guaranteed to throw ErrSpawnNotResumable → kill+delete+
// fresh, destroying the session_id resume needed. The fix runs one
// client.findMissing({}) BEFORE resume (only on the dead-session callers) so
// AD transitions the dead row to `missing` and resume can succeed.
//
// The `callLog` capture proves relative ordering; `findMissingCalls` proves
// the call count and that it carries an empty-params sweep ({}).
// ---------------------------------------------------------------------------

describe('b.4dk: findMissing-before-resume on dead-session recovery', () => {
  // Drive the WAITING-branch dead-session verdict: reconnectMcp send-keys fails
  // persistently even after the b.vub self-heal (tmux server ensurer no-op),
  // which is the 'dead-session' signal for a waiting row.
  test('waiting dead-session: findMissing runs exactly once BEFORE resume → resumed', async () => {
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent → dead session
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    expect(resumeCalls).toHaveLength(1)
    // Ordering: findMissing must be the immediately-preceding verb before resume.
    expect(callLog.indexOf('findMissing')).toBeGreaterThanOrEqual(0)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // Drive the WORKING-branch dead-session verdict: waitForWaitingAndReconnect
  // times out and the timeout status reports the claude process gone (b.ecw —
  // the timeout branch now keys on the process via a fresh findMissing sweep +
  // status, not the raw tmux probe). TTL=0 makes the timeout sweep observable
  // and lets the reconciled `missing` verdict flip in.
  test('working dead-session: findMissing runs (sweep + reconcile) BEFORE resume → resumed', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      // Poll loop stays `working`; only after the fresh timeout sweep does the
      // row reconcile to `missing` → dead-session → resume recovery.
      statusFn: () =>
        ({ state: findMissingCalls.length >= 2 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    // findMissing fires and precedes resume. (With TTL=0 the up-front sweep, the
    // timeout sweep, and resumeOrFreshSpawn's reconcileMissingFirst each sweep,
    // so the count is >1; the ordering assertion is what matters here.)
    expect(findMissingCalls.length).toBeGreaterThanOrEqual(1)
    expect(findMissingCalls[0]).toEqual({})
    expect(resumeCalls).toHaveLength(1)
    expect(callLog.indexOf('findMissing')).toBeGreaterThanOrEqual(0)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // ended/missing caller (SR-1.4 collision resolved to a terminal row) does NOT
  // set reconcileMissingFirst — the row is already terminal, straight to resume.
  test('ended/missing path: resume called with NO findMissing call', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(1)
  })

  // findMissing rejects → still attempt resume anyway → on a still-live row AD
  // throws ErrSpawnNotResumable → existing defensive kill+delete+fresh preserved.
  test('waiting dead-session: findMissing rejects → resume attempted → ErrSpawnNotResumable → kill+delete+fresh', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      findMissingError: errGeneric('find-missing', 'ErrProbeFailed'),
      resumeError: errSpawnNotResumable(), // row still live-state → resume rejects
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1)
    expect(resumeCalls).toHaveLength(1) // resume still attempted despite findMissing failure
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2)
  })

  // resume_enabled=false short-circuits BEFORE the findMissing block —
  // kill+delete+fresh as before, no findMissing, no resume.
  test('resume_enabled=false dead-session: no findMissing, no resume (kill+delete+fresh)', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  // Regression guard for b.vub self-heal: an ErrTmuxSessionCreate on resume in
  // the dead-session path must still trigger the orphan-tmux-kill self-heal and
  // a fresh respawn — unchanged by the findMissing insertion.
  test('waiting dead-session: findMissing then resume ErrTmuxSessionCreate → b.vub self-heal respawn → spawned', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errTmuxSessionCreate('resume'),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1) // findMissing still runs once, before resume
    expect(resumeCalls).toHaveLength(1) // resume attempted once, threw ErrTmuxSessionCreate
    expect(killedSessions).toHaveLength(1) // b.vub self-heal killed the orphan tmux session
    expect(spawnCalls).toHaveLength(2) // initial collision + self-heal fresh spawn
  })
})

// ---------------------------------------------------------------------------
// b.m4r — waitForWaitingAndReconnect probes tmux first via an up-front
// findMissing sweep, instead of spinning `status` for the full 10-minute window
//
// A bot killed mid-turn never fires SessionEnd, so its AD row freezes at
// `working`. Pre-fix, waitForWaitingAndReconnect polled `status` (which stays
// `working`) until WAIT_FOR_WAITING_TIMEOUT_MS (10 min) before the tmux probe
// finally decided. The fix runs ONE evidence-based findMissing sweep up front
// (t1.93m.hp): a genuinely-dead row reconciles to `missing`, so the FIRST
// status poll hits the ended/missing tmux-confirm branch and returns
// 'dead-session' in seconds. A genuinely-alive long-turn row is untouched by
// the sweep (empty result) and keeps today's polling behavior (b.rmy guard).
// ---------------------------------------------------------------------------

describe('b.m4r: waitForWaitingAndReconnect up-front findMissing sweep → fast dead-session', () => {
  // Fast path (ticket acceptance criterion): working-row collision, tmux gone.
  // Models the real frozen row — a bot killed mid-turn: AD reports `working`
  // on every status poll UNTIL the up-front findMissing sweep reconciles the
  // dead row to `missing`. Post-fix the sweep runs first, so the FIRST status
  // poll already sees `missing` → tmux-confirm (prober false) → 'dead-session'
  // after exactly ONE poll, NOT after the timeout window.
  //
  // REGRESSION GUARD (must FAIL pre-fix): without the up-front sweep the row
  // stays `working` forever, so the loop spins `status` until the timeout fires
  // — statusCalls balloons well past 1 (verified by stashing the src change).
  test('working row, tmux gone: up-front findMissing sweep reconciles → dead-session in exactly 1 status poll, sweep runs once before the poll', async () => {
    // A timeout large enough that, pre-fix, the poll loop would rack up many
    // status calls before giving up — the assertions below then fail loudly.
    _setWaitForWaitingTimeoutMs(2_000)
    _setTmuxSessionProber(async () => false) // tmux session is gone
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const statusCalls: import('agent-director').StatusParams[] = []
    // The dead row only becomes `missing` once findMissing has reconciled it;
    // until then AD keeps reporting the frozen `working` state.
    installStub({
      callLog,
      findMissingCalls,
      statusCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    const result = await waitForWaitingAndReconnect('C', cfg)

    expect(result).toBe('dead-session')
    // Post-fix: the sweep ran before the loop, so the very first status poll
    // already sees `missing`. Pre-fix: row stays `working` → many polls → fail.
    expect(statusCalls).toHaveLength(1)
    // The sweep runs exactly once, is a full evidence-based sweep ({}), and
    // precedes the first status poll (callLog instruments both verbs).
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    const firstFindMissing = callLog.indexOf('findMissing')
    const firstStatus = callLog.indexOf('status')
    expect(firstFindMissing).toBe(0)
    expect(firstStatus).toBeGreaterThan(firstFindMissing)
  })

  // findMissing rejects → logged, poll loop proceeds exactly as today. Here the
  // row then transitions working→waiting and reconnectMcp succeeds → 'ok'. No
  // crash, no behavior change from the sweep failure.
  test('findMissing rejects → poll loop proceeds → working→waiting → reconnect ok', async () => {
    _setWaitForWaitingTimeoutMs(60_000)
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingError: errGeneric('find-missing', 'ErrProbeFailed'),
      statusQueue: [
        cannedOk<import('agent-director').StatusResult>({ state: 'working' }),
        cannedOk<import('agent-director').StatusResult>({ state: 'waiting' }),
      ],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(1) // attempted once, rejected
    expect(result).toBe('ok') // reconnectMcp succeeded on the waiting transition
  })

  // -------------------------------------------------------------------------
  // Memo (single-flight + short-TTL) around reconcileMissingSweep (b.m4r).
  // The sweep is idempotent, so back-to-back callers within the TTL must share
  // ONE actual client.findMissing({}); past the TTL a caller re-sweeps; a failed
  // sweep is never memoized, so the next caller retries.
  // -------------------------------------------------------------------------

  // Two back-to-back callers within the TTL share one sweep. Each call reconciles
  // the dead row, so both return 'dead-session', but findMissing fires only once.
  test('memo: back-to-back callers within TTL share one findMissing sweep', async () => {
    _setWaitForWaitingTimeoutMs(2_000)
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    const first = await waitForWaitingAndReconnect('C', cfg)
    const second = await waitForWaitingAndReconnect('C', cfg)

    expect(first).toBe('dead-session')
    expect(second).toBe('dead-session')
    expect(findMissingCalls).toHaveLength(1) // second caller reused the memoized sweep
  })

  // TTL=0 disables reuse: the second caller re-sweeps.
  test('memo: second caller past the TTL re-sweeps', async () => {
    _setWaitForWaitingTimeoutMs(2_000)
    _setFindMissingMemoTtlMs(0)
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    await waitForWaitingAndReconnect('C', cfg)
    await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(2) // TTL=0 → no reuse, each caller sweeps
  })

  // A failed sweep is NOT memoized: the next caller retries.
  test('memo: a failed sweep is not memoized → next caller retries', async () => {
    _setWaitForWaitingTimeoutMs(60_000)
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingError: errGeneric('find-missing', 'ErrProbeFailed'),
      statusQueue: [
        cannedOk<import('agent-director').StatusResult>({ state: 'working' }),
        cannedOk<import('agent-director').StatusResult>({ state: 'waiting' }),
      ],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    await waitForWaitingAndReconnect('C', cfg)
    await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(2) // failure not cached → both callers hit AD
  })
})

// ---------------------------------------------------------------------------
// t1.tkk.e4 / b.sv7 — sweepDeadTmuxChannel: the exported escalate-dead wrapper
//
// The wrapper bundles an UNCONDITIONAL operator log line (emitted before/outside
// the memoized helper — memo hits return silently, so the log must not live
// inside reconcileMissingSweep) plus a call into the still-private memoized
// reconcileMissingSweep (b.m4r). Exercised here through its exported surface.
//
// Coverage:
//   - Log content: the operator line names the channel id, the dead-tmux
//     verdict, and that reconciliation was triggered — emitted UNCONDITIONALLY,
//     including on a memo hit (Epic AC 3, I1).
//   - b.nk5 fleet shape: several distinct channel ids escalate concurrently in
//     one tick window → exactly ONE client.findMissing sweep (in-flight sharing),
//     all callers resolve; a caller past the TTL re-sweeps.
//   - b.m4r contract pins through the wrapper: one memoized TTL-guarded
//     in-flight-shared sweep; failures NOT memoized; never a second sweep pattern.
// ---------------------------------------------------------------------------

describe('t1.tkk.e4: sweepDeadTmuxChannel escalate-dead wrapper', () => {
  // Capture console.error to assert on the operator-visible log line. The
  // wrapper (and reconcileMissingSweep) log via console.error; we restore it in
  // afterEach so no capture leaks into later tests.
  let errLog: string[]
  let realError: typeof console.error

  beforeEach(() => {
    errLog = []
    realError = console.error
    console.error = (...args: unknown[]) => { errLog.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = realError
  })

  // The escalate-dead operator line names the channel, the dead-tmux verdict,
  // and that reconciliation was triggered — the recovery-no-longer-silently-
  // blocked signal an operator must see on every escalate-dead verdict.
  test('log: operator line names channel id, dead-tmux verdict, reconciliation triggered', async () => {
    installStub({ findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    await sweepDeadTmuxChannel('C', 'dead-session')

    const line = errLog.find((l) => l.includes('escalate-dead: persona=C'))
    expect(line).toBeDefined()
    expect(line).toContain('persona=C')
    expect(line).toContain('verdict=dead-session')
    expect(line!.toLowerCase()).toContain('reconciliation')
  })

  // The log is emitted UNCONDITIONALLY — before/outside the memoized helper —
  // so a memo HIT (which returns silently from reconcileMissingSweep, firing no
  // findMissing) still produces the operator line. This is the I1 contract: the
  // log lives in the wrapper, not the memoized sweep.
  test('log: emitted even on a memo hit (unconditional), no second findMissing', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    // First escalate primes the memo (one real sweep).
    await sweepDeadTmuxChannel('C', 'dead-session')
    expect(findMissingCalls).toHaveLength(1)

    errLog.length = 0 // isolate the memo-hit call's emissions
    // Second escalate within the (default, non-zero) TTL: memo hit → no sweep,
    // but the wrapper's operator line must still fire.
    await sweepDeadTmuxChannel('D', 'dead-session')

    expect(findMissingCalls).toHaveLength(1) // memo hit → NO second sweep
    const line = errLog.find((l) => l.includes('escalate-dead: persona=D'))
    expect(line).toBeDefined()
    expect(line).toContain('verdict=dead-session')
    expect(line!.toLowerCase()).toContain('reconciliation')
  })

  // b.nk5 post-reboot fleet shape: every channel's tmux session is dead, so the
  // health-check tick escalates them all in one window. The sweep is whole-store
  // and single-flight, so N concurrent wrapper calls must collapse to exactly
  // ONE client.findMissing({}) — the fleet is served by one in-flight-shared
  // sweep, not N. All callers resolve (the wrapper never throws).
  test('b.nk5: N channels escalating concurrently in one tick share ONE findMissing', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 3, ids: ['cscb_A', 'cscb_B', 'cscb_C'] }) })

    // Start all wrappers WITHOUT awaiting between them: the first synchronously
    // stakes the in-flight slot before any await resolves, so the rest reuse it.
    const settled = await Promise.allSettled([
      sweepDeadTmuxChannel('A', 'dead-session'),
      sweepDeadTmuxChannel('B', 'dead-session'),
      sweepDeadTmuxChannel('C', 'dead-session'),
      sweepDeadTmuxChannel('D', 'dead-session'),
    ])

    // All callers resolve (single in-flight-shared sweep, wrapper never throws).
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true)
    // Exactly one real sweep for the whole fleet (in-flight sharing).
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    // Every escalating channel got its own unconditional operator line.
    for (const c of ['A', 'B', 'C', 'D']) {
      expect(errLog.some((l) => l.includes(`escalate-dead: persona=${c}`))).toBe(true)
    }
  })

  // Past the TTL, a later escalate re-sweeps — the memo is a short-TTL cache, not
  // a latch. TTL=0 defeats reuse so the second wrapper call issues a fresh sweep.
  test('b.nk5/b.m4r: a caller past the TTL re-sweeps', async () => {
    _setFindMissingMemoTtlMs(0)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    await sweepDeadTmuxChannel('C', 'dead-session')
    await sweepDeadTmuxChannel('C', 'dead-session')

    expect(findMissingCalls).toHaveLength(2) // TTL=0 → no reuse, each escalate sweeps
  })

  // b.m4r contract pin through the wrapper: a FAILED sweep is not memoized, so
  // the next escalate retries. The wrapper still never throws on the failure.
  test('b.m4r pin: a failed sweep is not memoized → next escalate retries, wrapper never throws', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingError: errGeneric('find-missing', 'ErrProbeFailed') })

    await sweepDeadTmuxChannel('C', 'dead-session') // must not throw
    await sweepDeadTmuxChannel('C', 'dead-session') // must not throw

    expect(findMissingCalls).toHaveLength(2) // failure not cached → both hit AD
  })
})

// ---------------------------------------------------------------------------
// b.c3o — waitForWaitingAndReconnect early-abort liveness verdict
// ---------------------------------------------------------------------------

describe('b.c3o: waitForWaitingAndReconnect early-abort liveness verdict', () => {
  // b.ecw: the ended/missing loop branch now keys on the claude PROCESS. After
  // the up-front evidence-based sweep, `missing`/`ended` is a provably-gone
  // process → 'dead-session' DIRECTLY, with NO raw tmux probe. The tmux prober
  // is stubbed here to blow up if touched.
  test.each([
    ['missing'],
    ['ended'],
  ])('transition to %s → dead-session directly, tmux NOT probed', async (state) => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false })
    installStub({
      statusResult: { state } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // process verdict is authoritative — no tmux probe
  })

  // b.ecw REGRESSION GUARD — FAILS on main's old code, PASSES with the fix.
  // Pre-fix, an ended/missing row with a *live* tmux shell returned 'ok' (the
  // tmux probe overruled the DB row). Post-fix a dead claude process in a
  // lingering tmux shell is a dead bot: 'dead-session', and the tmux prober is
  // NEVER called in this branch.
  test('transition to missing + tmux ALIVE → dead-session (process gone overrules a lingering tmux shell)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    installStub({
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // the ended/missing branch no longer probes tmux
  })

  test('transition to live transient state (ask_user) → ok without probing or recovery (regression guard)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false }) // even a "dead" probe must not matter
    installStub({
      statusResult: { state: 'ask_user' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
    expect(probed).toEqual([]) // live transient states never reach the prober
  })

  test('transition to live transient state (check_permission) → ok, never dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'check_permission' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
  })

  test('ErrSpawnNotFound + tmux gone → dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('ErrSpawnNotFound + tmux alive → ok', async () => {
    _setTmuxSessionProber(async () => true)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
  })

  test('spawnForPersona working branch: transition to missing + dead tmux → resume recovery instead of misreported ok', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setTmuxSessionProber(async () => false)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SR-8.6 invariant: live state set + instance-id helper
// ---------------------------------------------------------------------------

describe('SR-8.6 invariants', () => {
  test('AGENT_DIRECTOR_LIVE_STATES covers all expected SR-11 live states', () => {
    expect(AGENT_DIRECTOR_LIVE_STATES.has('pending')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('waiting')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('working')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ask_user')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('check_permission')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ended')).toBe(false)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('missing')).toBe(false)
  })

  test('every spawn call site emits relay_mode=on', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    // Both spawns (initial + retry-after-delete) must carry relay_mode='on'.
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    for (const p of spawnCalls) {
      expect(p.relay_mode).toBe('on')
    }
  })
})

// ---------------------------------------------------------------------------
// b.4ie — merged approvePreSessionDialogs (dev-channels + trust needle)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs (b.4ie)', () => {
  const DEV_CHANNELS_PANE = readFileSync(
    join(import.meta.dir, 'fixtures', 'dev-channels-pane-2.1.120.txt'),
    'utf-8',
  )
  const WELCOME_PANE = 'Listening for channel messages from: server:slack-channel-router'

  // -------------------------------------------------------------------------
  // Happy path: dialog detected → Enter sent (via spawnForPersona, the SR-1.1
  // fresh-spawn path that calls approvePreSessionDialogs).
  // statusQueue drives pending→waiting so the approver presses Enter then exits.
  // -------------------------------------------------------------------------

  test('happy path: dialog detected → Enter sent (allow_pending true, id cscb_C)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // pending → approver reads pane and presses Enter; then waiting → returns
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      readPaneResults: [
        { pane: DEV_CHANNELS_PANE },
        { pane: WELCOME_PANE },
      ],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('spawned')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C')
    // readPane should have been invoked at least once while pending
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(1)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_C')
      expect(r.n_lines).toBe(40)
      // b.98w: every readPane call must carry allow_pending=true
      expect(r.allow_pending).toBe(true)
    }
    // b.98w: the sendKeys call that presses Enter must also carry allow_pending=true
    for (const s of sendKeysCalls) {
      expect(s.allow_pending).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // needle lock-in constant test
  // -------------------------------------------------------------------------

  test('needle lock-in: matches the verified Claude Code 2.1.120 label', () => {
    expect(DEV_CHANNELS_DIALOG_NEEDLE).toBe('I am using this for local development')
    expect(DEV_CHANNELS_PANE).toContain(DEV_CHANNELS_DIALOG_NEEDLE)
  })

  // -------------------------------------------------------------------------
  // Collision/skip tests — no approvePreSessionDialogs on collision paths
  // -------------------------------------------------------------------------

  test('collision-resume path: approver runs but returns immediately when status is already live (no readPane)', async () => {
    // b.vub: the resume-success path now calls approvePreSessionDialogs. When
    // the resumed row is already live (default stub status='waiting'), the
    // approver returns before ever reading the pane.
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      statusResult: { state: 'waiting' },
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('resumed')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('skipped on collision-reconnect path (waiting state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('reconnected')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('skipped on collision-noop path (pending state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'pending' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('no-op')
    expect(readPaneCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // isStartup=false path: no startup error recorded on cap hit
  // -------------------------------------------------------------------------

  test('launchSession (restart path, isStartup=false): does not record startup error on cap hit', async () => {
    // sticky pending → cap hit; isStartup=false means no startup error
    _setDialogReadyTimeoutMs(20)
    installStub({
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: 'unrelated' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg, false)

    expect(result.action).toBe('spawned')
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // b.98w regression: readPane/sendKeys must pass allow_pending:true
  // -------------------------------------------------------------------------

  test('b.98w / allow_pending: Enter pressed with allow_pending:true while spawn is pending', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []

    // Install a baseline stub, then override readPane and sendKeys to simulate
    // the agent-director rejecting calls that lack allow_pending:true.
    const stub = installStub({ sendKeysCalls, readPaneCalls })

    stub.readPane = async (params: import('agent-director').ReadPaneParams): Promise<import('agent-director').ReadPaneResult> => {
      readPaneCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('read-pane')
      }
      // Return the dialog needle on the first detection call, then clear it.
      const callIdx = readPaneCalls.length
      if (callIdx === 1) return { pane: DEV_CHANNELS_PANE }
      return { pane: WELCOME_PANE }
    }

    stub.sendKeys = async (params: import('agent-director').SendKeysParams): Promise<import('agent-director').SendKeysResult> => {
      sendKeysCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('send-keys')
      }
      return {}
    }

    // statusQueue: pending → (readPane+sendKeys fire) → waiting → exit
    stub.status = async (_params: import('agent-director').StatusParams): Promise<import('agent-director').StatusResult> => {
      const enterCount = sendKeysCalls.length
      return { state: enterCount >= 1 ? 'waiting' : 'pending' }
    }

    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    // If allow_pending is present everywhere the spawn must complete cleanly.
    expect(result.action).toBe('spawned')
    // Exactly one sendKeys (the Enter key that dismisses the dialog).
    const enterCalls = sendKeysCalls.filter((s) => s.text === '')
    expect(enterCalls).toHaveLength(1)
    // The sendKeys call must carry allow_pending:true
    expect(enterCalls[0].allow_pending).toBe(true)
  })

  // -------------------------------------------------------------------------
  // b.ben regression: the approver addresses the persona's cscb_<key>, derived
  // from the key and never from the name (the two differ here).
  // -------------------------------------------------------------------------

  test('b.ben: dialog approval addresses cscb_<key> for a persona whose key differs from its name', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      readPaneResults: [
        { pane: DEV_CHANNELS_PANE },
        { pane: WELCOME_PANE },
      ],
    })
    const key = personaKey('My Chan')
    expect(key).not.toBe('My Chan')
    const cfg = makeMultiPersonaConfig([{ name: 'My Chan', working_directory: '/x' }], fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result.action).toBe('spawned')
    // Approver must address the persona's cscb_<key>.
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(1)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe(`cscb_${key}`)
    }
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].claude_instance_id).toBe(`cscb_${key}`)
    expect(sendKeysCalls[0].text).toBe('')
  })

  // -------------------------------------------------------------------------
  // New behavior tests for merged approver (b.4ie)
  // -------------------------------------------------------------------------

  test('cap hit: sticky pending + unrecognized pane → records dev-channels-approve-not-ready, no sendKeys, posts a spawn-failure notice to the persona destination (isStartup=true)', async () => {
    _setDialogReadyTimeoutMs(30)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      // sticky pending: never becomes live
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)
    await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()

    expect(sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-not-ready]')
    expect(log).toContain(`for ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)} —`)
    // cap path must also raise the spawn-failure notice (core requirement of b.4ie)
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `DialogApprovalTimeout`')
  })

  test('dead state: sticky ended + no needle (grace exhausted) → records dev-channels-approve-spawn-died', async () => {
    // b.vub: dead rows are driven via RAW tmux (AD refuses missing/ended panes).
    // With no needle in the raw pane and the grace streak set to 1, the first
    // ended poll exhausts the grace and records the death.
    _setDialogDeadGracePolls(1)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let rawEnterCount = 0
    _setTmuxCapturePane(async () => 'no needle here') // raw pane, no dialog
    _setTmuxSendEnter(async () => { rawEnterCount += 1 })
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'ended' }),
      ],
      readPaneResults: [{ pane: 'no needle here' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    const log = readLog()
    expect(log).toContain('[dev-channels-approve-spawn-died]')
    // No needle anywhere → neither AD nor raw Enter was pressed.
    expect(sendKeysCalls).toHaveLength(0)
    expect(rawEnterCount).toBe(0)
  })

  test('already-live: statusQueue [waiting] → no readPane, no sendKeys, no startup error', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      statusQueue: [cannedOk({ state: 'waiting' })],
    })
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(readPaneCalls).toHaveLength(0)
    expect(sendKeysCalls).toHaveLength(0)
    expect(readLog()).toBe('')
  })

  test('self-heal: statusQueue [pending, pending, waiting] + sticky dialog → Enter pressed ≥2 times', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      // sticky: every readPane returns the dialog needle
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    // Enter pressed each time the pane shows the needle while pending
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  // b.vub — pane-first / state-tolerant: press Enter despite missing/ended
  // -------------------------------------------------------------------------

  test('b.vub: dead row (missing) with needle → RAW tmux Enter, NOT agent-director sendKeys', async () => {
    // A resumed bot blocked at the dialog reports state=missing while the pane
    // still shows the needle. agent-director REFUSES read-pane/send-keys on a
    // missing row (ErrSpawnNotInteractive), so the approver must drive the
    // dialog via raw tmux keyed on the deterministic session name.
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const rawCaptured: string[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async (name) => { rawCaptured.push(name); return DEV_CHANNELS_PANE })
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    const readLog = captureStartupErrors()
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // missing (raw needle → raw Enter) → then waiting → return
      statusQueue: [
        cannedOk({ state: 'missing' }),
        cannedOk({ state: 'waiting' }),
      ],
    })

    await approvePreSessionDialogs('C', true)

    // Raw tmux was used, keyed on the deterministic session name.
    expect(rawCaptured).toContain('slack_bot_C')
    expect(rawEntered).toEqual(['slack_bot_C'])
    // agent-director's interactive verbs were NOT used on the dead row.
    expect(readPaneCalls).toHaveLength(0)
    expect(sendKeysCalls).toHaveLength(0)
    // Must NOT have recorded spawn-died — the needle was present, not dead.
    expect(readLog()).not.toContain('[dev-channels-approve-spawn-died]')
  })

  test('b.vub: dead row (ended) with needle → RAW tmux Enter clears the dialog', async () => {
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => DEV_CHANNELS_PANE)
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    installStub({
      statusQueue: [
        cannedOk({ state: 'ended' }),
        cannedOk({ state: 'waiting' }),
      ],
    })

    await approvePreSessionDialogs('C', true)

    expect(rawEntered).toEqual(['slack_bot_C'])
  })

  test('b.vub: dead row with NO needle in raw pane (grace exhausted) → terminal, no Enter', async () => {
    // Without a needle in the RAW pane, a sticky missing row exhausts the grace
    // streak and is recorded as dead — no stray Enter, AD verbs untouched.
    _setDialogDeadGracePolls(1)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => 'no needle here')
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    installStub({
      sendKeysCalls,
      statusResult: { state: 'missing' },
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', true)

    expect(sendKeysCalls).toHaveLength(0)
    expect(rawEntered).toHaveLength(0)
    expect(readLog()).toContain('[dev-channels-approve-spawn-died]')
  })

  // -------------------------------------------------------------------------
  // b.vub — resume-success path invokes the approver
  // -------------------------------------------------------------------------

  test('b.vub: resume-success path drives the dialog approver via RAW tmux (missing row)', async () => {
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => DEV_CHANNELS_PANE)
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      resumeCalls,
      // fresh spawn collides → get=missing → resume succeeds → approver runs
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'missing' }),
      // resumed bot is still `missing` while blocked at the dialog, then waiting
      statusQueue: [
        cannedOk({ state: 'missing' }),
        cannedOk({ state: 'waiting' }),
      ],
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    // The approver ran on the resume path and dismissed the dialog via raw tmux.
    expect(rawEntered).toEqual(['slack_bot_C'])
  })

  // -------------------------------------------------------------------------
  // b.vub — ErrTmuxSessionCreate self-heal (kill orphan tmux + retry once)
  // -------------------------------------------------------------------------

  test('b.vub: ErrTmuxSessionCreate on resume → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      // 1st spawn: instance-id collision → get=missing → resume throws tmux-create
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        // 2nd spawn (the self-heal retry) succeeds
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'missing' }),
      resumeError: errTmuxSessionCreate('resume'),
      // approver on the retry-spawn: already live → returns immediately
      statusResult: { state: 'waiting' },
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('spawned')
    // Orphan tmux killed by its deterministic per-channel name.
    expect(killedSessions).toEqual(['slack_bot_C'])
    // Exactly one retry spawn after the collision spawn (2 spawn calls total).
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate on fresh spawn → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      // 1st fresh spawn throws tmux-create (no instance-id collision) → self-heal
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual(['slack_bot_C'])
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate self-heal kills slack_bot_<key> for a persona whose key differs from its name', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const key = personaKey('my chan')
    expect(key).not.toBe('my chan')
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${key}` }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeMultiPersonaConfig([{ name: 'my chan', working_directory: '/x' }], fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual([`slack_bot_${key}`])
  })

  test('b.vub: ErrTmuxSessionCreate self-heal that fails on retry → spawn-failure notice to the persona destination', async () => {
    _setTmuxSessionKiller(async () => { /* orphan killed but retry still fails */ })
    const readLog = captureStartupErrors()
    installStub({
      // fresh spawn throws tmux-create; retry spawn also throws (generic)
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
    })
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()

    expect(result.action).toBe('failed')
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain(`Error: \`${errTmuxSessionCreate('spawn').errName}\``)
    expect(readLog()).toContain('[spawn-failed]')
  })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 — wrapper-migration assertions
// ---------------------------------------------------------------------------

// Shared constants for wrapper tests
const BIN = '/usr/bin/agent-director'
const CWD = '/test/cwd'

// ---------------------------------------------------------------------------
// Group A: 13 non-dialog wrapped catch sites
// Each asserts: outage-class typed error raises the matching flag AND
// no spawn-failure notice is raised.
// ---------------------------------------------------------------------------

describe('wrapper-migration: non-dialog outage cases (Group A)', () => {
  // -------------------------------------------------------------------------
  // Site #1 — reconnectMcp → sendKeys
  // -------------------------------------------------------------------------

  test('site #1: reconnectMcp ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({ sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN) })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  test('site #1b: reconnectMcp ErrTmuxNotAvailable → tmux-unavailable, no spawn-failure notice', async () => {
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #8 — waitForWaitingAndReconnect → status
  // -------------------------------------------------------------------------

  test('site #8: waitForWaitingAndReconnect ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    _setWaitForWaitingTimeoutMs(50)
    installStub({ statusError: new ErrSystemInstallDisappeared('status', BIN) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #9 — tryKill → kill (tested via spawnForPersona collision path)
  // kill errors are silently ignored by tryKill, but the outage flag IS raised.
  // -------------------------------------------------------------------------

  test('site #9: tryKill kill ErrSystemInstallDisappeared → ad-unreachable, error ignored (no spawn-failure notice)', async () => {
    // collision → get=ended → resume_enabled=false → kill throws (flag set, ignored)
    // delete also throws so flow terminates without a fresh spawn that would clear the flag
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      killError: new ErrSystemInstallDisappeared('kill', BIN),
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #10 — tryDelete → delete
  // -------------------------------------------------------------------------

  test('site #10: tryDelete delete ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      // kill succeeds; delete fails with typed outage error
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #11 — spawnForPersona initial spawn (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #11: initial spawn ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({ spawnError: new ErrSystemInstallDisappeared('spawn', BIN) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  test('site #11b: initial spawn ErrCwdNotFound → cwd-unreachable with the persona working_directory as detail, no spawn-failure notice', async () => {
    installStub({ spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    // The detail is the persona's working_directory (withSpawnDetection's
    // workingDirectory arg), in an onset notice for the persona key
    expect(outageEmissions.some(e => e.key === 'C' && e.text.includes(CWD))).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #12 — spawnForPersona collision-get (withOutageDetection)
  // -------------------------------------------------------------------------

  test('site #12: collision-get ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getError: new ErrSystemInstallDisappeared('get', BIN),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #13 — spawnForPersona retry-spawn after ErrSpawnNotFound
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #14 — spawnForPersona fresh-spawn after kill+delete (resume_enabled=false)
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete ErrCwdNotFound → cwd-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #15 — spawnForPersona resume (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #15: resume ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: new ErrSystemInstallDisappeared('resume', BIN),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #16 — spawnForPersona spawn after ErrNoSessionId → delete → spawn
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete ErrCwdNotFound → cwd-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #17 — spawnForPersona spawn after ErrSpawnNotResumable → kill+delete → spawn
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

})

// ---------------------------------------------------------------------------
// Group B: 6 dialog wrapped catch sites (sites #2-#7)
// Each asserts: (a) dialog function returns normally, (b) ad-unreachable flag
// is raised, (c) binaryPath detail is captured in the onset emission.
// Uses poll seams to keep tests near-instant.
// ---------------------------------------------------------------------------

describe('wrapper-migration: dialog outage cases (Group B)', () => {
  const CH = 'C_DIALOG'
  const errSID = () => new ErrSystemInstallDisappeared('read-pane', BIN)

  // -------------------------------------------------------------------------
  // Merged approvePreSessionDialogs — 3 wrapped call sites: status, readPane,
  // sendKeys. Each exercises an AD-outage error at one site, asserting the
  // outage flag is raised and the function resolves normally.
  // -------------------------------------------------------------------------

  test('status outage: status always throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    installStub({ statusError: errSID() })
    // status throws every poll → transient → cap hit → resolves
    await expect(approvePreSessionDialogs(CH, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.key === CH && e.text.includes(BIN))).toBe(true)
  })

  test('readPane outage: status=pending, readPane throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    installStub({
      statusResult: { state: 'pending' },
      readPaneError: errSID(),
    })
    await expect(approvePreSessionDialogs(CH, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.key === CH && e.text.includes(BIN))).toBe(true)
  })

  test('sendKeys outage: status=pending + dialog pane, sendKeys throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    // readPane returns the dialog needle so sendKeys is reached; sendKeys throws
    installStub({
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_NEEDLE }],
      sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN),
    })
    await expect(approvePreSessionDialogs(CH, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.key === CH && e.text.includes(BIN))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group C: spawn/resume success-clear (sites #11, #13, #14, #15, #16, #17)
// Each pre-sets all three outage flags then exercises a spawn/resume success
// path, asserting flags are empty and exactly one all-clear was emitted
// naming all three classes.
// ---------------------------------------------------------------------------

describe('wrapper-migration: spawn/resume success-clear (Group C)', () => {
  const CH = 'C_CLEAR'

  function setupFlags(): void {
    preSetAllFlags(CH)
    outageEmissions = [] // reset after pre-set; only capture all-clear from success path
  }

  function assertAllClear(): void {
    expect(getOutageFlags(CH).size).toBe(0)
    const allClear = outageEmissions.filter(e => e.key === CH && e.text.includes('All clear'))
    expect(allClear).toHaveLength(1)
    expect(allClear[0].text).toContain('ad-unreachable')
    expect(allClear[0].text).toContain('cwd-unreachable')
    expect(allClear[0].text).toContain('tmux-unavailable')
  }

  // -------------------------------------------------------------------------
  // Site #11 — initial spawn success
  // -------------------------------------------------------------------------

  test('site #11: initial spawn success clears all three flags + emits all-clear', async () => {
    setupFlags()
    installStub({})
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #13 — retry-spawn after ErrSpawnNotFound success
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound success clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #14 — fresh-spawn after kill+delete (resume_enabled=false) success
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete (resume_enabled=false) clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #15 — resume success
  // -------------------------------------------------------------------------

  test('site #15: resume success clears all three flags + emits all-clear', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('resumed')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #16 — fresh-spawn after ErrNoSessionId → delete → spawn success
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete success clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #17 — fresh-spawn after ErrSpawnNotResumable → kill+delete → spawn success
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete success clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })
})

// ---------------------------------------------------------------------------
// b.wrb — ErrJsonlMissing amnesia: legible diagnostic + honest startup counters
//
// When resume throws ErrJsonlMissing, CSCB still delete+fresh-spawns (policy
// unchanged), but must now: (1) log which transcript path(s) were tried and
// their source; (2) classify never-created (quiet, lossless) vs lost
// (operator-visible) vs unknown (row fetch failed); (3) count the fresh-spawn
// as its own 'fresh-after-amnesia' bucket instead of folding it into "ok".
// ---------------------------------------------------------------------------

describe('b.wrb: ErrJsonlMissing amnesia diagnostic + honest counters', () => {
  const CH = 'C_WRB'
  const CWD = '/repo/wrb'

  // Cleanup handles for temp archive dirs built during this suite (drained in afterEach).
  const archiveCleanups: Array<() => void> = []

  afterEach(() => {
    while (archiveCleanups.length > 0) archiveCleanups.pop()!()
  })

  /** Build a temp archive DB holding `count` post-spawn messages for CH. */
  function makeArchiveWithMessagesSince(startedAt: string, count: number): string {
    const built = messagesSince(startedAt, CH, count)
    archiveCleanups.push(built.cleanup)
    return built.dbPath
  }

  /**
   * Install a stub that drives the ErrJsonlMissing amnesia path: a colliding
   * spawn resolves to an `ended` row, resume rejects with ErrJsonlMissing, then
   * delete + a fresh spawn succeeds. `getResult` is returned for both the
   * collision-recovery get and the diagnostic get.
   */
  function installAmnesia(opts: {
    /** The applied configuration; the row is `personaRow(cfg, key, …)`. */
    cfg: PersonaConfig
    jsonlDescription?: string
    getResult?: PersonaGetResultOverrides
    getError?: Error
    spawnCalls?: import('agent-director').SpawnParams[]
    deleteCalls?: import('agent-director').DeleteParams[]
    /** Persona key the row belongs to; default the stand-in CH. */
    key?: string
  }) {
    const key = opts.key ?? CH
    return installStub({
      spawnCalls: opts.spawnCalls,
      deleteCalls: opts.deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${key}` }),
      ],
      resumeError: errJsonlMissing(opts.jsonlDescription),
      getResult: opts.getError
        ? undefined
        : personaRow(opts.cfg, key, { state: 'ended', ...opts.getResult }),
      getError: opts.getError,
    })
  }

  // --- Regression requirement (designated) --------------------------------
  // Pre-fix: ErrJsonlMissing → action 'spawned', folded into succeeded/"ok",
  // and StartupSessionManagerResult had no freshAfterAmnesia field. This test
  // asserts the dedicated 'fresh-after-amnesia' action AND the separate
  // freshAfterAmnesia counter — both undefined/wrong pre-fix, so it FAILS pre-fix
  // and PASSES post-fix. (Verified by inspecting HEAD:src/session-manager.ts,
  // whose ErrJsonlMissing branch returns { action: 'spawned' } and whose result
  // shape is { succeeded, failed, perChannel } only.)
  // b.fwu: this config sets NO message_archive_db, so makeDefaultArchiveCount
  // yields null and the diagnosis is INCONCLUSIVE (case c-config: no archive is
  // configured, so there is no evidence source to consult). It must land in the
  // dedicated freshAfterInconclusiveAmnesia bucket — never folded into the
  // known-cause freshAfterAmnesia. Pre-fix (no 'inconclusive' classification,
  // no separate counter, no 'fresh-after-inconclusive-amnesia' action) this
  // FAILS; post-fix it PASSES.
  test('REGRESSION: ErrJsonlMissing fresh-spawn with no archive configured is counted as fresh-after-inconclusive-amnesia, not fresh-after-amnesia', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installAmnesia({
      cfg,
      getResult: { jsonl_path: '/data/proj/sess-1.jsonl', claude_session_id: 'sess-1', cwd: CWD },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshSpawned).toBe(0)
    expect(result.resumed).toBe(0)
    expect(result.failed).toBe(0)
    // Still counted toward liveness, but distinctly bucketed.
    expect(result.succeeded).toBe(1)
    expect(result.perPersona).toEqual([
      { key: CH, action: 'fresh-after-inconclusive-amnesia' },
    ])
  })

  // --- Honest counters tallied separately ---------------------------------
  test('startup counters: resumed / fresh-spawned / fresh-after-amnesia / failed are tallied separately', async () => {
    captureStartupErrors()
    let getIdx = 0
    const stub = installStub({
      // C1 fresh (clean spawn), C2 collision→resumed, C3 collision→ErrJsonlMissing
      // amnesia, C4 spawn throws → failed.
      spawnQueue: [
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C1' }),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C3' }),
        cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken')),
      ],
    })
    // C2 resumes cleanly; C3 resume throws ErrJsonlMissing.
    stub.resume = async (params) => {
      if (params.claude_instance_id === 'cscb_C3') throw errJsonlMissing()
      return { claude_instance_id: params.claude_instance_id }
    }
    const cfg = makeStandInPersonaConfig(
      {
        C1: { working_directory: '/x1' },
        C2: { working_directory: '/x2' },
        C3: { working_directory: '/x3' },
        C4: { working_directory: '/x4' },
      },
      fixtureDir,
    )
    // Both collision gets return an `ended` row for their own persona.
    const personaGet = personaRowsGet(cfg, { state: 'ended' })
    stub.get = async (params) => {
      getIdx++
      return personaGet(params)
    }
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.freshSpawned).toBe(1) // C1
    expect(result.resumed).toBe(1) // C2
    // C3: ErrJsonlMissing with no message_archive_db configured → the diagnosis
    // is inconclusive (c-config), so it lands in the dedicated inconclusive
    // bucket, not freshAfterAmnesia.
    expect(result.freshAfterInconclusiveAmnesia).toBe(1) // C3
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.failed).toBe(1) // C4
    expect(result.succeeded).toBe(3)
    // C2's collision recovery does one get(); C3's collision recovery plus its
    // ErrJsonlMissing diagnostic each do one → 3 get() calls total.
    expect(getIdx).toBe(3)

    // AC 3: the honest summary line reports every bucket separately (never
    // folding amnesia into a generic "ok"), splitting diagnosed
    // (fresh-after-amnesia) from undiagnosable (fresh-after-inconclusive-amnesia).
    expect(errLog).toContain(
      'startupSessionManager: complete — 4 persona(s): 1 resumed, 1 fresh-spawned, ' +
        '0 fresh-after-amnesia, 1 fresh-after-inconclusive-amnesia, ' +
        '0 reconnected, 0 no-op, 1 failed, 0 not brought up',
    )
    // Because freshAfterInconclusiveAmnesia > 0, its loud grep-friendly
    // follow-up line fires (the freshAfterAmnesia line does not — count is 0).
    expect(errLog).toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing WITHOUT a conclusive diagnosis',
    )
    expect(errLog).not.toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing (transcript could not be resumed)',
    )
  })

  // --- Message-shape coverage: all three AD source tokens (b.hcq) ---------
  // AD v0.10.0's formatJsonlAttempts stamps three source tokens — persisted,
  // fallback and history. Pre-fix the parser anchored on persisted|fallback
  // only, so every `history` candidate (the archived-session evidence that
  // distinguishes "lost" from "never written") was silently dropped.

  /** Render one AD attempt the way formatJsonlAttempts does. */
  function adAttempt(source: string, path: string): string {
    return `${source} ${path} (no such file or directory)`
  }

  /** Drive the amnesia diagnostic with `desc` and return the captured log. */
  async function logForDescription(desc: string): Promise<string> {
    return withCapturedErr(async () => {
      const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
      installAmnesia({
        cfg,
        jsonlDescription: desc,
        getResult: { jsonl_path: '/data/proj/sess-1.jsonl', claude_session_id: 'sess-1', cwd: CWD },
      })
      await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })
  }

  test('REGRESSION: all three AD source tokens are parsed, in the order AD reported them', async () => {
    captureStartupErrors()
    const attempts = [
      adAttempt('persisted', '/data/proj/sess-1.jsonl'),
      adAttempt('fallback', '/home/u/.claude/projects/-repo-wrb/sess-1.jsonl'),
      adAttempt('history', '/home/u/.claude/projects/-old-repo/sess-0.jsonl'),
    ]
    const log = await logForDescription(`no transcript found: ${attempts.join('; ')}`)
    // Exactly the three AD candidates, joined in AD's order — nothing dropped,
    // nothing reordered, no locally-computed padding.
    expect(log).toContain(
      `Transcript candidates tried (paths+sources reported by agent-director): ${attempts.join('; ')}.`,
    )
    expect(log).not.toContain('locally-computed')
  })

  test('history-only description yields exactly that one candidate', async () => {
    captureStartupErrors()
    const attempt = adAttempt('history', '/home/u/.claude/projects/-old-repo/sess-0.jsonl')
    const log = await logForDescription(`no transcript found: ${attempt}`)
    expect(log).toContain(
      `Transcript candidates tried (paths+sources reported by agent-director): ${attempt}.`,
    )
    // A single AD candidate still counts as AD detail: no local reconstruction.
    expect(log).not.toContain('locally-computed')
    expect(log).not.toContain('agent-director gave no path detail')
  })

  test.each([
    ['history: /p/sess.jsonl - missing', 'source token not followed by a path + parens'],
    ['archived /p/sess.jsonl (no such file or directory)', 'unknown source token'],
    ['history(/p/sess.jsonl)', 'no whitespace-separated path'],
  ])('malformed description (%s) parses to no AD candidates without throwing', async (desc) => {
    captureStartupErrors()
    const log = await logForDescription(desc)
    // Non-throwing: the diagnostic still ran and degraded honestly to locally
    // computed candidates rather than claiming AD reported none.
    expect(log).toContain('agent-director gave no path detail')
    expect(log).toContain('locally-computed(persisted-column) /data/proj/sess-1.jsonl')
    expect(log).not.toContain('paths+sources reported by agent-director')
  })

  // --- Message-shape coverage: plain non-enumerated format ----------------
  // A pre-b.1ba AD's ErrJsonlMissing carries no per-candidate enumeration. The
  // diagnostic must degrade to locally-computed candidates, label them
  // honestly, and never throw (spawnForPersona still completes the amnesia
  // fresh-spawn).
  test('plain non-enumerated ErrJsonlMissing message: degrades to honest locally-computed candidates, no throw', async () => {
    captureStartupErrors()
    const log = await withCapturedErr(async () => {
      const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
      installAmnesia({
        cfg,
        jsonlDescription: 'jsonl missing', // no <source> <path> (<err>) enumeration
        getResult: { jsonl_path: '/data/proj/sess-2.jsonl', claude_session_id: 'sess-2', cwd: CWD },
      })
      const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
      // Never throws — the fresh-spawn still happens. No message_archive_db is
      // configured here, so the diagnosis is inconclusive (c-config).
      expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    })
    // Honest provenance clause + locally-computed labels for both persisted
    // column and config-dir fallback.
    expect(log).toContain('agent-director gave no path detail')
    expect(log).toContain('locally-computed(persisted-column) /data/proj/sess-2.jsonl')
    expect(log).toContain('locally-computed(config-dir fallback)')
  })

  // --- Classification triad: never-created (quiet) ------------------------
  // No archived messages since spawn → lossless. Quiet: no startup-error, no
  // persona notice; action still fresh-after-amnesia.
  test('never-created: 0 archived messages since spawn → quiet (no startup-error, no persona notice)', async () => {
    const readLog = captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 0)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-3.jsonl',
        claude_session_id: 'sess-3',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    // b.fwu: evidence-based never-created is the DIAGNOSED-lossless case — it
    // stays quiet and is bucketed as the ordinary fresh-after-amnesia action,
    // NOT the undiagnosable fresh-after-inconclusive-amnesia.
    expect(result.action).toBe('fresh-after-amnesia')
    expect(notices).toHaveLength(0) // no persona notice at all
    const log = readLog()
    expect(log).not.toContain('jsonl-transcript-lost-on-resume') // quiet
    expect(log).not.toContain('jsonl-diagnosis-inconclusive') // not inconclusive
  })

  // --- Classification triad: lost (loud) ----------------------------------
  // Archived messages > 0 since spawn → real context destroyed. Loud:
  // recordStartupError('jsonl-transcript-lost-on-resume') + a persona notice to
  // the persona's destination (b.av2 SR-7.2). The startup error is recorded
  // only when isStartup=true, so this drives that.
  test('lost: archived messages since spawn > 0 → startup-error recorded + persona notice to the destination', async () => {
    const readLog = captureStartupErrors()
    // Four post-spawn messages under its destination, its only `delivery: all`
    // channel (what is counted, b.av2 SR-7.4), and four under the persona key,
    // which is not a channel of the persona and is not counted: the count is 4.
    const startedAt = '2026-09-20T05:00:00Z'
    const boundary = Date.parse(startedAt) / 1000
    const rows = [1, 2, 3, 4].flatMap((i) => [
      { ts: boundary + i, channel: NOTICE_KEY },
      { ts: boundary + i, channel: NOTICE_DEST },
    ])
    const archive = buildTempArchiveDb(rows, NOTICE_KEY)
    archiveCleanups.push(archive.cleanup)
    const cfg = makeNoticeConfig({ message_archive_db: archive.dbPath })
    installAmnesia({
      cfg,
      key: NOTICE_KEY,
      getResult: {
        jsonl_path: '/data/proj/sess-4.jsonl',
        claude_session_id: 'sess-4',
        // cwd: the notice persona's own working directory (personaRow).
        started_at: startedAt,
      },
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg, true)
    await settleNotices()

    expect(result.action).toBe('fresh-after-amnesia')
    // Operator-visible: startup-error entry embedding the archived count.
    const log = readLog()
    expect(log).toContain('jsonl-transcript-lost-on-resume')
    expect(log).toContain('4 message(s)')
    // And a persona notice to the persona's destination only.
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('message archive shows 4 message(s) since I started')
    expect(text).toContain('my conversation memory has been lost')
    expect(text).not.toContain('could not determine whether my prior')
  })

  // --- Classification triad: inconclusive (row fetch fails) ---------------
  // b.fwu case (a): the diagnostic get() rejects → the row cannot be consulted,
  // so we cannot classify loss vs never-created. Must not throw; the amnesia
  // fresh-spawn still completes, now bucketed as the dedicated
  // 'fresh-after-inconclusive-amnesia' action.
  test('inconclusive (a): diagnostic row fetch fails → no throw, fresh-after-inconclusive-amnesia', async () => {
    captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    // First get() (collision recovery) returns ended; second get() (diagnostic)
    // rejects. Drive this by flipping the stub's get after the first call.
    const stub = installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      resumeError: errJsonlMissing(),
    })
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    let getCalls = 0
    stub.get = async (params) => {
      getCalls++
      if (getCalls >= 2) throw errGeneric('get', 'ErrSpawnGone')
      return personaRowsGet(cfg, { state: 'ended' })(params)
    }
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    expect(deleteCalls).toHaveLength(1) // delete+fresh policy unchanged
    expect(spawnCalls).toHaveLength(2)
    expect(getCalls).toBeGreaterThanOrEqual(2)
  })

  // ==========================================================================
  // b.fwu requirement 6: for EACH of the three inconclusive conditions —
  // (a) row-fetch failure, (b) unparseable/absent started_at, (c) archive
  // unavailable — assert BOTH the startup counter (freshAfterInconclusiveAmnesia
  // increments, freshAfterAmnesia does not) AND the startup-error record
  // (jsonl-diagnosis-inconclusive with a condition-specific detail).
  // ==========================================================================

  // (a) row-fetch failure, driven through startupSessionManager so the counter
  // is observable. The diagnostic get() (second get) rejects; the collision
  // recovery get() (first) succeeds so the amnesia path is reached at all.
  test('inconclusive (a) via startup: row fetch fails → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      resumeError: errJsonlMissing(),
    })
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    let getCalls = 0
    stub.get = async (params) => {
      getCalls++
      if (getCalls >= 2) throw errGeneric('get', 'ErrSpawnGone')
      return personaRowsGet(cfg, { state: 'ended' })(params)
    }
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    // Detail names WHICH condition: the row could not be fetched.
    expect(log).toContain('could not fetch the agent-director row')
  })

  // (b) unparseable/absent started_at — the archive is even configured (a real
  // db), proving the short-circuit is on started_at, not on archive absence.
  test('inconclusive (b) via startup: unparseable started_at → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 3)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-b.jsonl',
        claude_session_id: 'sess-b',
        cwd: CWD,
        started_at: 'not-a-timestamp',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    // Detail names WHICH condition: started_at could not be parsed. Because it
    // is unparseable, the archive must NOT have been consulted (no lost record).
    expect(log).toContain("started_at is absent or unparseable")
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
  })

  // (c-config) archive unavailable because none is configured. Distinguished
  // from (c-other) by the actionable "no message archive is configured" hint.
  test('inconclusive (c-config) via startup: no message_archive_db → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir) // no message_archive_db
    installAmnesia({
      cfg,
      getResult: { jsonl_path: '/data/proj/sess-c1.jsonl', claude_session_id: 'sess-c1', cwd: CWD },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    expect(log).toContain('no message archive is configured')
  })

  // (c-other) archive IS configured but the file is missing / unreadable.
  // Distinguished from (c-config) by naming the configured path in the detail.
  test('inconclusive (c-other) via startup: configured archive file missing → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const missingDb = join(tmpdir(), `cscb-wrb-missing-${Date.now()}.db`)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: missingDb })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-c2.jsonl',
        claude_session_id: 'sess-c2',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    // c-other wording names the configured (but unusable) archive path, and is
    // distinct from the c-config "no message archive is configured" hint.
    expect(log).toContain(`the message archive (${missingDb})`)
    expect(log).not.toContain('no message archive is configured')
  })

  // --- Conclusive amnesia through startup: freshAfterAmnesia counter ---------
  // b.fwu review gap: no test drove freshAfterAmnesia > 0 through
  // startupSessionManager — the diagnosed 'fresh-after-amnesia' switch case and
  // its loud follow-up line ("transcript could not be resumed") were asserted
  // only in the negative. These two cover the two conclusive flavors.

  // (lost) archive has post-spawn messages → real context destroyed. Diagnosis
  // is CONCLUSIVE, so it lands in freshAfterAmnesia (not the inconclusive
  // bucket), and the loud diagnosed follow-up line fires.
  test('conclusive lost via startup: post-spawn archived messages → freshAfterAmnesia counter + diagnosed follow-up line', async () => {
    captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 4)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-lost.jsonl',
        claude_session_id: 'sess-lost',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.freshAfterAmnesia).toBe(1)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.succeeded).toBe(1)
    // Summary line reports the conclusive bucket, not the inconclusive one.
    expect(errLog).toContain(
      'startupSessionManager: complete — 1 persona(s): 0 resumed, 0 fresh-spawned, ' +
        '1 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, ' +
        '0 reconnected, 0 no-op, 0 failed, 0 not brought up',
    )
    // The diagnosed follow-up line fires; the inconclusive one does not.
    expect(errLog).toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing (transcript could not be resumed)',
    )
    expect(errLog).not.toContain(
      'fresh-spawned after ErrJsonlMissing WITHOUT a conclusive diagnosis',
    )
  })

  // (never-created) 0 post-spawn messages → lossless but still CONCLUSIVE, so it
  // is bucketed as freshAfterAmnesia (quiet: the diagnosed follow-up line still
  // fires because freshAfterAmnesia > 0, but no per-channel 'lost' record).
  test('conclusive never-created via startup: 0 post-spawn messages → freshAfterAmnesia counter, not inconclusive', async () => {
    captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 0)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-nc.jsonl',
        claude_session_id: 'sess-nc',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterAmnesia).toBe(1)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.succeeded).toBe(1)
  })

  // Notice wording for an inconclusive case must be UNCERTAINTY-shaped,
  // never the 'lost' "destroyed"/"memory has been lost" wording — a false
  // "your history was destroyed" is its own harm.
  test('inconclusive persona notice is worded as uncertainty, not the lost "destroyed" wording', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig() // no message_archive_db: c-config → inconclusive
    installAmnesia({
      cfg,
      key: NOTICE_KEY,
      // The row's cwd is the notice persona's own working directory (personaRow).
      getResult: { jsonl_path: '/data/proj/sess-u.jsonl', claude_session_id: 'sess-u' },
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg, true)
    await settleNotices()

    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    expect(readLog()).toContain('jsonl-diagnosis-inconclusive')
    const text = expectOneNoticeToDestination(h)
    // Uncertainty wording present.
    expect(text).toContain('on restart I was started fresh;')
    expect(text).toContain('could not determine whether my prior')
    // 'lost'-branch wording absent.
    expect(text).not.toContain('has been lost')
    expect(text).not.toContain('message archive shows')
  })

  // --- b.av2 SR-7.4: archive evidence follows the persona's channels -------
  // Only the persona's `delivery: all` channels are counted, and a zero count
  // proves idleness only when the archive sees all of the persona's traffic:
  // with a `mentions` channel or DMs on, zero is inconclusive. Each case drives
  // the real resume → ErrJsonlMissing → diagnosis path over a real temp
  // archive; the row is the persona's own (`personaRow`), so the ladder
  // resumes it instead of meeting the cwd / config_dir guard.

  const SR74_STARTED_AT = '2026-09-20T05:00:00Z'
  const SR74_NAME = 'Archive Bot'
  const SR74_KEY = personaKey(SR74_NAME)
  const ALL_1 = 'C0ALL0001'
  const ALL_2 = 'C0ALL0002'
  const MENTIONS = 'C0MENT003'
  /** A channel of no persona: never counted. */
  const ELSEWHERE = 'C0ELSE004'

  interface Sr74Case {
    channels: Persona['channels']
    dmEnabled: boolean
    /** Post-spawn archived messages by channel ID (the persona key included, to prove it is not counted). */
    rows: Record<string, number>
    outcome: 'never-created' | 'inconclusive' | 'lost'
    /** For 'lost': the count the record and notice name. */
    lostCount?: number
  }

  const SR74_CASES: Array<[string, Sr74Case]> = [
    ['only `all` channels, no rows in them since spawn → never-created', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: ALL_2, delivery: 'all' }],
      dmEnabled: false,
      rows: { [ELSEWHERE]: 3, [SR74_KEY]: 3 },
      outcome: 'never-created',
    }],
    ['an `all` and a `mentions` channel, rows only in the `mentions` channel → inconclusive', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: MENTIONS, delivery: 'mentions' }],
      dmEnabled: false,
      rows: { [MENTIONS]: 5 },
      outcome: 'inconclusive',
    }],
    ['DMs on, an `all` channel with no rows since spawn → inconclusive', {
      channels: [{ id: ALL_1, delivery: 'all' }],
      dmEnabled: true,
      rows: { [ELSEWHERE]: 2 },
      outcome: 'inconclusive',
    }],
    ['DMs on and no channels → inconclusive', {
      channels: [],
      dmEnabled: true,
      rows: { [ELSEWHERE]: 2, [SR74_KEY]: 2 },
      outcome: 'inconclusive',
    }],
    ['an `all` and a `mentions` channel, rows in the `all` channel → lost (only the `all` rows counted)', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: MENTIONS, delivery: 'mentions' }],
      dmEnabled: false,
      rows: { [ALL_1]: 3, [MENTIONS]: 2, [ELSEWHERE]: 7 },
      outcome: 'lost',
      lostCount: 3,
    }],
    ['rows only in the persona’s second `all` channel → lost', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: ALL_2, delivery: 'all' }],
      dmEnabled: false,
      rows: { [ALL_2]: 2 },
      outcome: 'lost',
      lostCount: 2,
    }],
    ['DMs on, rows in the `all` channel → lost', {
      channels: [{ id: ALL_1, delivery: 'all' }],
      dmEnabled: true,
      rows: { [ALL_1]: 4 },
      outcome: 'lost',
      lostCount: 4,
    }],
  ]

  test.each(SR74_CASES)('SR-7.4: %s', async (_label, c) => {
    const readLog = captureStartupErrors()
    const boundary = Date.parse(SR74_STARTED_AT) / 1000
    // Each channel's rows land strictly after started_at; one row per channel
    // before it proves the "since spawn" bound still applies.
    const rows = Object.entries(c.rows).flatMap(([channel, n]) => [
      { ts: boundary - 10, channel },
      ...Array.from({ length: n }, (_, i) => ({ ts: boundary + 1 + i, channel })),
    ])
    rows.push({ ts: boundary - 10, channel: ALL_1 })
    const archive = buildTempArchiveDb(rows, ELSEWHERE)
    archiveCleanups.push(archive.cleanup)
    const cfg = makeMultiPersonaConfig(
      [{
        name: SR74_NAME,
        channels: c.channels,
        dm: c.dmEnabled ? { enabled: true, contact: 'U0CONTACT1' } : { enabled: false },
        permission_prompts: c.channels.find((ch) => ch.delivery === 'all')?.id ?? 'dm',
      }],
      fixtureDir,
      { message_archive_db: archive.dbPath },
    )
    installAmnesia({
      cfg,
      key: SR74_KEY,
      getResult: { jsonl_path: '/data/proj/sess-sr74.jsonl', claude_session_id: 'sess-sr74', started_at: SR74_STARTED_AT },
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, SR74_KEY), cfg, true)
    })
    const log = readLog()

    if (c.outcome === 'never-created') {
      // Conclusive and quiet: no record, no notice.
      expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-amnesia' })
      expect(log).not.toContain('jsonl-transcript-lost-on-resume')
      expect(log).not.toContain('jsonl-diagnosis-inconclusive')
      expect(notices).toHaveLength(0)
      expect(errLog).toContain('transcript never created (archive consulted: 0 archived messages since spawn)')
      return
    }

    expect(notices).toHaveLength(1)
    expect(notices[0]!.key).toBe(SR74_KEY)
    const text = notices[0]!.text

    if (c.outcome === 'lost') {
      expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-amnesia' })
      expect(countStartupEntries(log, 'jsonl-transcript-lost-on-resume')).toBe(1)
      expect(log).not.toContain('jsonl-diagnosis-inconclusive')
      expect(log).toContain(`the message archive holds ${c.lostCount} message(s) since spawn`)
      expect(text).toContain(`message archive shows ${c.lostCount} message(s) since I started`)
      expect(text).toContain('my conversation memory has been lost')
      expect(text).not.toContain('could not determine whether my prior')
      return
    }

    // Inconclusive, for the new cause: an unattributable zero.
    expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-inconclusive-amnesia' })
    expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(1)
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
    expect(errLog).not.toContain('transcript never created')
    expect(text).toContain('could not determine whether my prior')
    expect(text).not.toContain('has been lost')
    expect(text).not.toContain('message archive shows')
    // The recorded cause is the new one, distinct from the existing reasons.
    expect(log).toContain(UNATTRIBUTABLE_ZERO_REASON)
    expect(log).not.toContain('no message archive is configured')
    expect(log).not.toContain('could not be consulted')
    expect(log).not.toContain('started_at is absent or unparseable')
  })

  // Carried from E3 Task 1 review: the locally computed fallback transcript
  // path is built from the persona's effective claude_config_dir. A persona
  // that overrides the top-level directory is looked up under its own.
  test('a persona overriding the top-level claude_config_dir: the fallback transcript candidate is under the persona’s directory', async () => {
    captureStartupErrors()
    const topLevel = fixtureSubdir('top-level-config')
    const own = fixtureSubdir('persona-config')
    const cfg = makeStandInPersonaConfig(
      { [CH]: { working_directory: CWD, claude_config_dir: own } },
      fixtureDir,
      { claude_config_dir: topLevel },
    )
    expect(personaOf(cfg, CH).claude_config_dir).toBe(own)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installAmnesia({
      cfg,
      spawnCalls,
      // No enumerated AD detail, so the diagnosis computes the candidates itself.
      jsonlDescription: 'jsonl missing',
      getResult: { jsonl_path: '/data/proj/sess-own.jsonl', claude_session_id: 'sess-own', cwd: CWD },
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const log = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    // The resume path was reached (the row's label matched the persona's own directory).
    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    const expected = resolveJsonlPath(CWD, 'sess-own', own)
    expect(expected.startsWith(`${own}/projects/`)).toBe(true)
    expect(log).toContain(`locally-computed(config-dir fallback) ${expected}`)
    expect(log).not.toContain(resolveJsonlPath(CWD, 'sess-own', topLevel))
    expect(log).not.toContain(`${topLevel}/projects`)
    // The fresh spawn after the delete runs under the persona's directory too.
    expect(spawnCalls[1]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(own)
  })

  // --- ErrNoSessionId sibling still 'spawned' (not amnesia) ---------------
  // Guard: only ErrJsonlMissing routes to fresh-after-amnesia. The ErrNoSessionId
  // sibling in the same branch keeps the plain 'spawned' action.
  test('ErrNoSessionId sibling keeps action=spawned (only ErrJsonlMissing is amnesia)', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    expect(result.action).toBe('spawned')
  })
})

// ---------------------------------------------------------------------------
// b.jgf — ErrJsonlNeverWritten: lossless delete + fresh spawn
//
// AD 0.10.0 split the old "resume can't find a transcript" condition into
// ErrJsonlMissing (a transcript path was recorded but is gone now — ambiguous,
// keeps the b.wrb diagnosis ceremony) and ErrJsonlNeverWritten (the session
// never wrote one — provably nothing to lose). Pre-fix the new name matched no
// branch in the resume ladder, so it hit the generic tail: action 'failed', a
// spawn-failure notice, and restart.ts retrying the same impossible resume with
// a doubling backoff forever.
// ---------------------------------------------------------------------------

describe('b.jgf: ErrJsonlNeverWritten → lossless delete + fresh spawn', () => {
  const CH = 'C_JGF'
  const CWD = '/repo/jgf'

  beforeEach(() => {
    // startupSessionManager writes startup-errors.log; keep it in the per-test dir.
    captureStartupErrors()
  })

  /**
   * Drive the wedge: colliding spawn resolves to an `ended` row, resume rejects
   * with ErrJsonlNeverWritten, then delete + fresh spawn succeeds.
   */
  function installNeverWritten(cfg: PersonaConfig, opts?: {
    spawnCalls?: import('agent-director').SpawnParams[]
    deleteCalls?: import('agent-director').DeleteParams[]
    getCalls?: import('agent-director').GetParams[]
  }) {
    return installStub({
      ...opts,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      resumeError: errJsonlNeverWritten(),
      getResult: personaRow(cfg, CH, {
        state: 'ended',
        jsonl_path: '/data/proj/sess-jgf.jsonl',
        claude_session_id: 'sess-jgf',
        cwd: CWD,
      }),
    })
  }

  // --- Regression requirement (designated) --------------------------------
  // Pre-fix this same test FAILS on every assertion that matters: the resume
  // rejection fell through to the generic tail, so action was 'failed', the
  // row was never deleted, no fresh spawn was issued (spawnCalls === 1) and
  // a spawn-failure notice was posted into the channel. Verified against
  // main:src/session-manager.ts, whose branch condition is
  // `err instanceof ErrNoSessionId || err instanceof ErrJsonlMissing`.
  test('REGRESSION: resume ErrJsonlNeverWritten → delete + fresh spawn, action=spawned, no spawn-failure notice, no diagnosis get', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const getCalls: import('agent-director').GetParams[] = []
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg, { spawnCalls, deleteCalls, getCalls })

    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    // AC-2/AC-3: plain success action — not 'failed', and not borrowed from the
    // amnesia vocabulary, because nothing was lost.
    expect(result).toEqual({ key: CH, action: 'spawned' })
    // Row deleted, then re-spawned with the original params.
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].claude_instance_id).toEqual([`cscb_${CH}`])
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].claude_instance_id).toBe(`cscb_${CH}`)
    // AC-4: no spawn-failure notice.
    expect(notices).toHaveLength(0)
    // AC-3: only the collision-recovery get ran. diagnoseJsonlMissing fetches
    // the row a second time, so a single get proves the diagnosis was skipped.
    expect(getCalls).toHaveLength(1)
  })

  // AC-5 (no retry): restart.ts reschedules with doubling backoff whenever its
  // launchSession adapter returns false. The wedge was that loop, so assert at
  // the adapter boundary rather than replicating restart.ts's timer.
  test('launchSession adapter returns true → restart.ts records success, schedules no retry', async () => {
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg)

    expect(await launchSession(CH, cfg)).toBe(true)
  })

  // The restart path's adapter looks the key up among the applied personas; an
  // unknown key reports failure and never reaches agent-director.
  test('launchSession: unknown key → false, no agent-director call', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const stub = installStub({ spawnCalls })
    // Record every client verb, not just the ones the stub captures.
    const verbs: string[] = []
    const record = stub as unknown as Record<string, unknown>
    for (const name of Object.keys(record)) {
      const fn = record[name]
      if (typeof fn !== 'function') continue
      record[name] = (...args: unknown[]) => { verbs.push(name); return (fn as (...a: unknown[]) => unknown)(...args) }
    }
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)

    expect(await launchSession('C_UNKNOWN', cfg)).toBe(false)

    expect(spawnCalls).toHaveLength(0)
    expect(verbs).toEqual([])
    expect(notices).toHaveLength(0)
  })

  // AC-3: the startup summary must stay honest — a never-written transcript is
  // an ordinary fresh spawn, not amnesia and not an undiagnosable one.
  test('startup counters: bucketed as freshSpawned, not amnesia and not failed', async () => {
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg)

    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshSpawned).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.perPersona).toEqual([{ key: CH, action: 'spawned' }])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-7.2 — persona notices: hold until validated, restart cap,
// spawn-failure-post startup error, and the notifier seam
// ---------------------------------------------------------------------------

describe('persona notices (b.av2 SR-7.2)', () => {
  /** A startup spawn whose first spawn call fails with a generic error. */
  function installGenericSpawnFailure(): void {
    installStub({ spawnError: errGeneric('spawn', 'ErrSpawnBroken') })
  }

  test('held: a startup spawn failure raised before the persona client is validated posts nothing until the flush, then exactly once', async () => {
    captureStartupErrors()
    installGenericSpawnFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false })

    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()
    expect(result.action).toBe('failed')
    // Held: nothing posted on either persona's client.
    expect(h.posts(NOTICE_KEY)).toHaveLength(0)
    expect(h.posts(OTHER_KEY)).toHaveLength(0)

    // A flush while the client is still unvalidated keeps holding it.
    await h.notifier.flush(NOTICE_KEY)
    expect(h.posts(NOTICE_KEY)).toHaveLength(0)

    // Validate the persona, then flush: exactly one notice, to its destination.
    h.validate(NOTICE_KEY)
    await h.notifier.flush(NOTICE_KEY)
    await h.notifier.flush(OTHER_KEY)
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `ErrSpawnBroken`')

    // A second flush posts nothing more.
    await h.notifier.flush(NOTICE_KEY)
    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
  })

  test('restart cap: notifyRestartCapReached posts one SpawnCapReached notice to the persona destination', async () => {
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)

    notifyRestartCapReached(NOTICE_KEY)
    await settleNotices()

    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `SpawnCapReached`')
    expect(text).toContain(`${RESTART_FAILURE_CAP} consecutive session-launch failures`)
    expect(text).toContain('automatic restarts are suspended for this persona')
  })

  // --- spawn-failure-post (b.av2 SR-11, startup-errors.log classes) --------

  // Every scripted post failure carries LEAK_SENTINEL (message, original,
  // headers, data). recordStartupError writes the same line to stderr (fd 2,
  // not console.error) and to startup-errors.log, so the log file stands for
  // the stderr line; console.error output and the notifier's lines are
  // captured and checked too.
  const LEAKY_POST_FAILURES: [string, WebApiOutcome, string][] = [
    ['network', { kind: 'network' }, 'slack_webapi_request_error'],
    ['http 503', { kind: 'http', status: 503 }, 'slack_webapi_http_error'],
    ['platform', { kind: 'platform', error: 'not_in_channel' }, 'slack_webapi_platform_error'],
  ]

  test.each(LEAKY_POST_FAILURES)(
    'spawn-failure-post: a rejected (%s) startup spawn-failure post records exactly one token-free entry',
    async (_label, outcome, code) => {
      const readLog = captureStartupErrors()
      installGenericSpawnFailure()
      const cfg = makeNoticeConfig()
      const h = installNoticeNotifier(cfg, { post: [outcome], leakMarker: LEAK_SENTINEL })

      let action: string | undefined
      const errLog = await withCapturedErr(async () => {
        action = (await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)).action
        await settleNotices()
      })

      expect(action).toBe('failed')
      expect(h.posts(NOTICE_KEY)).toHaveLength(1)
      const log = readLog()
      expect(countStartupEntries(log, 'spawn-failure-post')).toBe(1)
      // The cause is the describer's type and code, never the error message.
      expect(log).toContain(`failed to post spawn failure for persona=${NOTICE_KEY} — Error code=${code}`)
      expect(log).not.toContain('error occurred')
      // The notifier logged the failed post once; there is no retry.
      expect(h.logs.filter((l) => l.includes('failed to post notice'))).toHaveLength(1)
      assertNoLeak({ startupErrorsLog: log, errLog, logs: h.logs }, `spawn-failure-post ${_label}`)
    },
  )

  test('spawn-failure-post: a held startup notice whose flushed post is rejected records exactly one token-free entry', async () => {
    const readLog = captureStartupErrors()
    installGenericSpawnFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false, post: [{ kind: 'network' }], leakMarker: LEAK_SENTINEL })

    const errLog = await withCapturedErr(async () => {
      await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
      await settleNotices()
      expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(0)

      h.validate(NOTICE_KEY)
      await h.notifier.flush(NOTICE_KEY)
      await settleNotices()
    })

    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
    assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, 'held spawn-failure-post')
  })

  test('spawn-failure-post: a rejected restart-cap notice post records none and logs token-free', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { post: [{ kind: 'network' }], leakMarker: LEAK_SENTINEL })

    const errLog = await withCapturedErr(async () => {
      notifyRestartCapReached(NOTICE_KEY)
      await settleNotices()
    })

    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(0)
    // Outside startup the failure is logged instead.
    expect(errLog).toContain(`[slack] spawn-failure-post: failed to post spawn failure for persona=${NOTICE_KEY}`)
    assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, 'restart-cap spawn-failure-post')
  })

  test('spawn-failure-post: a rejected restart-path (launchSession) notice post records none and logs token-free', async () => {
    const readLog = captureStartupErrors()
    installGenericSpawnFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { post: [{ kind: 'network' }], leakMarker: LEAK_SENTINEL })

    let launched: boolean | 'skipped' | undefined
    const errLog = await withCapturedErr(async () => {
      launched = await launchSession(NOTICE_KEY, cfg)
      await settleNotices()
    })

    expect(launched).toBe(false)
    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
    expect(h.posts(NOTICE_KEY)[0]!.channel).toBe(NOTICE_DEST)
    expect(h.posts(OTHER_KEY)).toHaveLength(0)
    // Non-startup: no startup-errors.log entry of any class.
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(0)
    expect(readLog()).toBe('')
    expect(errLog).toContain(`[slack] spawn-failure-post: failed to post spawn failure for persona=${NOTICE_KEY}`)
    assertNoLeak({ errLog, logs: h.logs }, 'launchSession spawn-failure-post')
  })

  // --- The setSessionNotifier seam ----------------------------------------

  test('no notifier installed: a notice is logged by its first line, never thrown', async () => {
    setSessionNotifier(undefined)
    const errLog = await withCapturedErr(() => {
      notifySpawnFailure(NOTICE_KEY, errGeneric('spawn', 'ErrSpawnBroken'))
    })
    expect(errLog).toContain(
      `[slack] session-manager: no notifier installed — notice for persona=${NOTICE_KEY} not posted: Spawn failure:`,
    )
    // Only the first line of the notice is logged.
    expect(errLog).not.toContain('ErrSpawnBroken')
  })

  test.each([
    ['throws', () => { throw new Error('sink exploded') }],
    ['rejects', () => Promise.reject(new Error('sink exploded'))],
  ] as const)('a notifier that %s is contained: the spawn still reports failed and the error is logged', async (_label, sink) => {
    captureStartupErrors()
    installGenericSpawnFailure()
    const cfg = makeNoticeConfig()
    setSessionNotifier(sink)

    let action: string | undefined
    const errLog = await withCapturedErr(async () => {
      action = (await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)).action
      await settleNotices()
    })

    expect(action).toBe('failed')
    expect(errLog).toContain(`[slack] session-manager: notifier failed for persona=${NOTICE_KEY}: `)
  })

  test('the bare capture records the notice under the persona key with its body only', async () => {
    captureStartupErrors()
    installGenericSpawnFailure()
    const cfg = makeNoticeConfig()

    await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)

    expect(notices).toHaveLength(1)
    expect(notices[0].key).toBe(NOTICE_KEY)
    // The session manager passes the body; the notifier adds the persona reference.
    expect(notices[0].text.startsWith('Spawn failure:\n')).toBe(true)
    expect(notices[0].text).not.toContain(NOTICE_NAME)
    expect(typeof notices[0].options?.onPostFailure).toBe('function')
  })
})
