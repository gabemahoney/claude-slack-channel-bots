/**
 * ci-live-membership-setup.test.ts — Tests for the /ci-live runner's
 * membership setup readiness (`ci-live/checks/membership-setup.ts`, SRD
 * t1.tad.5i SR-3.4): the evidence rules, the client of the server's local
 * `/membership-readiness` route, and the two checks `membershipSetupCheck`
 * (`setup-ready`) and `membershipSetupRestartCheck` (`setup-restart`).
 *
 * The rules under test:
 * - setup evidence comes from this run's provisioning, apps.json's
 *   `needs_reinstall` and the manifest export only; the inventory is never an
 *   input, and what can't be inspected is `unknown` with a fixed limit
 *   sentence, never verified;
 * - the one-time reinstall rule flags exactly an updated app not reinstalled,
 *   a new app reinstalled, and a redundant reinstall;
 * - a check passes only on `verified`; `unknown` is SKIPPED as not run; a
 *   missing subscription or a pending reinstall FAILs with the server's
 *   diagnostic; another installation, or none, FAILs with nothing recorded;
 *   a record for another app's installation is refused; the restart check
 *   passes only on the earlier, unchanged record;
 * - the route's answer is projected to its listed fields; a silent,
 *   non-JSON, empty or token-shaped answer is a failure, never a state.
 *
 * The container is real bash (with jq, curl and the container's own `mark`,
 * `since` and `showsafe` from `docker/live/cscb-live-helpers.sh`) over a
 * scratch state directory, its environment from `hostSafeChildEnv`; `guard`
 * is scripted. Its server is the real one: `handleMembershipReadiness` over
 * `createMembershipReadiness` and a real shared authority whose
 * `config.json.last-applied` the checks' jq reads, behind a loopback
 * `Bun.serve` that the route script's curl reaches through `server.port`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DRY_RUN_IDS, type AppSetupSource, type CheckContext, type LiveIds, type ManifestExport, type ProvisionedApp, type SharedState } from '../ci-live/checks/context.ts'
import type { CheckResult } from '../ci-live/checks/framework.ts'
import { q } from '../ci-live/checks/helpers.ts'
import {
  DOWNTIME_LEAVE_LIMIT,
  DRIFT_AT_CHECK_LIMIT,
  EXPORT_UNAVAILABLE_REINSTALL_LIMIT,
  expectedSetupState,
  installationKey,
  installationMatches,
  membershipSetupCheck,
  membershipSetupRestartCheck,
  NO_PROVISIONING_LIMIT,
  NO_RESTART_LIMIT,
  OTHER_APP_PROVISIONED_LIMIT,
  readinessAnswerOf,
  readinessRead,
  readinessRecord,
  reinstallConsistency,
  savedChoices,
  setupEvidence,
  subscriptionsUninspectableLimit,
  TOKENLESS_REUSE_LIMIT,
  UPDATED_NOT_REINSTALLED_LIMIT,
  type InstallationIds,
  type ReinstallEvidence,
  type SubscriptionEvidence,
} from '../ci-live/checks/membership-setup.ts'
import type { ProcResult } from '../ci-live/lib/proc.ts'
import { buildLiveConfig, CONTAINER_STATE_DIR, renderConfig } from '../ci-live/lib/live-config.ts'
import { parseManifestYaml, personaManifest, type JsonObject } from '../ci-live/lib/manifest.ts'
import { personaName } from '../ci-live/lib/personas.ts'
import { createMembershipReadiness, handleMembershipReadiness, type MembershipReadiness } from '../src/channel-membership-readiness.ts'
import type { MembershipScanStatus } from '../src/channel-membership-scan.ts'
import { parsePersonaConfigBytes } from '../src/config.ts'
import { createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState, serializeSharedChannelState, type SharedChannelAuthority } from '../src/shared-channels.ts'
import { virtualClock } from './test-helpers/ci-live.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dir, '..')
const HELPERS = readFileSync(join(REPO, 'docker', 'live', 'cscb-live-helpers.sh'), 'utf-8')
const MANIFEST_C = personaManifest(parseManifestYaml(readFileSync(join(REPO, 'slack-app-manifest.yml'), 'utf-8')), 'c')
const C_KEY = personaName('c')
const C_IDS: InstallationIds = { teamId: DRY_RUN_IDS.teamId, appId: DRY_RUN_IDS.bots.c.appId, botUserId: DRY_RUN_IDS.bots.c.userId, botId: DRY_RUN_IDS.bots.c.botId }
const A_IDS: InstallationIds = { teamId: DRY_RUN_IDS.teamId, appId: DRY_RUN_IDS.bots.a.appId, botUserId: DRY_RUN_IDS.bots.a.userId, botId: DRY_RUN_IDS.bots.a.botId }
const TOKEN = fakeToken(BOT_TOKEN_PREFIX, 'setup')
/** A message-body sentinel (not token-shaped, so it passes showsafe and must be dropped by the projection). */
const BODY_SENTINEL = `body ${LEAK_SENTINEL}`

/** One `name() { … }` definition from the container's helpers: a one-line one, or up to its closing `}` line. */
function helperDef(name: string): string {
  const start = HELPERS.indexOf(`\n${name}() {`)
  if (start < 0) throw new Error(`no ${name}() in the helpers`)
  const first = HELPERS.slice(start + 1, HELPERS.indexOf('\n', start + 1))
  return first.trimEnd().endsWith('}') ? first : HELPERS.slice(start + 1, HELPERS.indexOf('\n}\n', start) + 2)
}
const HELPER_DEFS = ['mark', 'since', 'tokcount', 'showsafe'].map(helperDef).join('\n')
/** What the route script, savedChoices and the helpers run by name. */
const CONTAINER_TOOLS = ['bash', 'cat', 'jq', 'curl', 'grep', 'stat', 'wc', 'tail']

/** C's manifest with sentinels in fields the evidence must never copy. */
function exportedManifest(events: readonly string[] = ['message.channels', 'message.im', 'message.groups', 'app_mention', 'member_joined_channel', 'channel_left', 'reaction_added', 'reaction_removed']): JsonObject {
  const m = structuredClone(MANIFEST_C) as Record<string, any>
  m.display_information = { ...m.display_information, long_description: `${BODY_SENTINEL} ${TOKEN}` }
  m.settings = { ...m.settings, event_subscriptions: { ...m.settings.event_subscriptions, bot_events: [...events] } }
  return m as JsonObject
}

const KEPT: ProvisionedApp = { appId: C_IDS.appId, apps: 'reused', drift: [], unchecked: false, install: 'kept' }
const UNREPORTED: ProvisionedApp = { appId: undefined, apps: undefined, drift: undefined, unchecked: undefined, install: undefined }

interface SetupFacts {
  provisioned: ProvisionedApp
  needsReinstall: boolean
  exported: ManifestExport
}

/** A scripted `ctx.setup`: `facts` is read at each call, and every export is counted. */
function fakeSetup(over: Partial<SetupFacts> = {}) {
  const facts: SetupFacts = { provisioned: KEPT, needsReinstall: false, exported: { kind: 'exported', manifest: exportedManifest() }, ...over }
  const exports: string[] = []
  const setup: AppSetupSource = {
    provisioned: () => facts.provisioned,
    needsReinstall: () => facts.needsReinstall,
    exportManifest: async (appId) => (exports.push(appId), facts.exported),
    wantedManifest: () => MANIFEST_C,
  }
  return { setup, facts, exports }
}

// ---------------------------------------------------------------------------
// The scripted container over the real server
// ---------------------------------------------------------------------------

interface World {
  home: string
  state: string
  authority: SharedChannelAuthority
  readiness: MembershipReadiness
  /** C's authenticated installation (the provenance's identity), or null for none. */
  cIdentity: (InstallationIds & { enterpriseId?: string }) | null
  inventory: MembershipScanStatus
  guardRefuses: boolean
  /** In place of the real handler's answer (a broken or silent server). */
  answer: ((body: unknown) => Response) | null
  /** Rewrite a record for another installation to C's (a server that fails to refuse it). */
  acceptMismatch: boolean
  /** Rewrite each server log line before it is written (an empty list drops it). */
  logHook: (line: string) => string[]
  /** How far the server's clock moves at each reading (0 freezes it). */
  nowStep: number
  /** Every container script run, and every request body the server got. */
  scripts: string[]
  requests: unknown[]
  ids: LiveIds
  container: CheckContext['container']
  /** The running server's PID, as server.pid and server.port name it (this process until a restart). */
  pid: number
  /**
   * An ordinary restart: the authority reopened from its file, a fresh
   * readiness (which reports at start, as the server does), and a new server
   * PID (a live stand-in process) in server.pid and server.port.
   */
  restart(): void
  close(): void
}

const worlds: World[] = []
afterEach(() => {
  for (const w of worlds.splice(0)) w.close()
})

function makeWorld(): World {
  const home = mkdtempSync(join(tmpdir(), 'ci-live-membership-setup-'))
  const state = join(home, '.config', 'claude-slack-channel-bots')
  mkdirSync(state, { recursive: true })
  const recordPath = join(state, 'config.json.last-applied')
  const text = renderConfig(buildLiveConfig(DRY_RUN_IDS))
  const config = parsePersonaConfigBytes(text, `${CONTAINER_STATE_DIR}/config.json`, CONTAINER_STATE_DIR, { home: '/home/testuser' })
  const initial = initialSharedChannelState(Buffer.from(text), config)
  const deps = { home: '/home/testuser', write: (path: string, bytes: Uint8Array) => writeFileSync(path, bytes) }
  writeFileSync(recordPath, serializeSharedChannelState(initial))
  writeFileSync(join(state, 'server.log'), '')
  let now = 1_700_000_000_000

  const w: World = {
    home,
    state,
    authority: createSharedChannelAuthority(recordPath, initial, deps),
    readiness: undefined as unknown as MembershipReadiness,
    cIdentity: { ...C_IDS, enterpriseId: BODY_SENTINEL },
    inventory: { state: 'complete', pages: 1, positives: 2, slackError: BODY_SENTINEL },
    guardRefuses: false,
    answer: null,
    acceptMismatch: false,
    logHook: (line) => [line],
    nowStep: 1000,
    scripts: [],
    requests: [],
    ids: DRY_RUN_IDS,
    container: undefined as unknown as CheckContext['container'],
    pid: process.pid,
    restart: () => {
      w.readiness.close()
      w.authority = createSharedChannelAuthority(recordPath, parseSharedChannelState(readFileSync(recordPath), recordPath, deps)!, deps)
      w.readiness = newReadiness()
      // Another server process: a live stand-in PID now owns server.pid and server.port (the listener stays the same).
      const process2 = Bun.spawn([Bun.which('sleep')!, '600'], { env: hostSafeChildEnv(home, { tools: ['sleep'] }), stdout: 'ignore', stderr: 'ignore' })
      standIns.push(process2)
      writeServerFiles(process2.pid)
    },
    close: () => {
      w.readiness.close()
      server.stop(true)
      for (const p of standIns) p.kill()
      rmSync(home, { recursive: true, force: true })
    },
  }
  const standIns: { pid: number; kill(): void }[] = []
  /** `server.pid` and `server.port` for the server process `pid` (the run's PID). */
  function writeServerFiles(pid: number) {
    w.pid = pid
    writeFileSync(join(state, 'server.pid'), `${pid}\n`)
    writeFileSync(join(state, 'server.port'), JSON.stringify({ pid, port: server.port }))
  }
  function newReadiness(): MembershipReadiness {
    const r = createMembershipReadiness({
      authority: w.authority,
      provenance: (key) =>
        key === C_KEY && w.cIdentity
          ? { key, connectionId: 'conn-c', incarnation: w.authority.incarnation(key), identity: w.cIdentity, applied: true, candidate: false, isCurrent: () => true }
          : undefined,
      inventory: () => w.inventory,
      dryRun: false,
      now: () => (now += w.nowStep),
      log: (line) => {
        for (const l of w.logHook(line)) appendFileSync(join(state, 'server.log'), `${l}\n`)
      },
    })
    // The server reports each persona's reading once at start.
    r.report(C_KEY)
    return r
  }
  w.readiness = newReadiness()

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, srv) => {
      const body = await req.clone().json().catch(() => null)
      w.requests.push(body)
      if (w.answer) return w.answer(body)
      let forwarded = req
      const installation = (body as { installation?: InstallationIds } | null)?.installation
      if (w.acceptMismatch && installation && installation.appId !== C_IDS.appId) {
        forwarded = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ ...(body as object), installation: C_IDS }) })
      }
      return handleMembershipReadiness(forwarded, srv.requestIP(req)?.address, {
        getPersonaConfig: () => ({ personas: w.authority.config().personas.map((p) => ({ key: p.key, name: p.name })) }),
        readiness: w.readiness,
      })
    },
  })
  writeServerFiles(process.pid)

  w.container = {
    name: 'cscb-live-1700000000',
    exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    writeFile: async () => {},
    sh: async (script): Promise<ProcResult> => {
      w.scripts.push(script)
      const prelude = `S=${q(state)}\nLOG="$S/server.log"\nguard() { return ${w.guardRefuses ? 1 : 0}; }\n${HELPER_DEFS}`
      const proc = Bun.spawn([Bun.which('bash')!, '-c', `${prelude}\n${script}`], { env: hostSafeChildEnv(home, { tools: CONTAINER_TOOLS }), stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { code, stdout, stderr, timedOut: false }
    },
  }
  worlds.push(w)
  return w
}

function makeCtx(w: World, setup: AppSetupSource, shared: SharedState = {}): CheckContext {
  const snapshot = { adRows: [], tmuxSessions: [], port3100: '', configSha256: '' }
  return {
    mode: 'real',
    runId: '1700000000',
    container: w.container,
    hostName: 'cscb-live-1700000000',
    clock: virtualClock(),
    log: { info: () => {}, detail: () => {} },
    runNotes: [],
    ids: w.ids,
    human: null,
    second: null,
    browser: null,
    creds: { moveDIntoMount: () => {}, rewriteBAppToken: async () => {}, mountedCount: () => 3, bAppTokenName: () => 'cscb-live', setBAppTokenName: () => {} },
    setup,
    shared,
    promptGuard: {
      expect: () => {
        throw new Error('a readiness check declared a prompt')
      },
      denyLeftovers: async () => 0,
    },
    restartContainer: async () => {},
    hostScan: () => ({ counts: [], total: 0 }),
    hostBefore: snapshot,
    hostNow: async () => snapshot,
    removeContainer: async () => true,
  }
}

/** C's readiness record in the authority, as the server holds it (or undefined). */
function cRecord(w: World) {
  return Object.values(w.authority.snapshot().personas[C_KEY]?.installationReadiness ?? {})[0]
}

/** The server log's C readiness lines. */
function cLogLines(w: World): string[] {
  return readFileSync(join(w.state, 'server.log'), 'utf-8')
    .split('\n')
    .filter((l) => l.includes('[slack] channel-membership-') && l.includes(` persona=${C_KEY}: `))
}

/** The guarded scripts the world ran (every container write runs behind the guard). */
const guardedScripts = (w: World) => w.scripts.filter((s) => s.startsWith('guard || exit 90\n'))

/** Record evidence for C directly on the server, as an operator would. */
function recordDirect(w: World, subscriptions: Record<'member_joined_channel' | 'channel_left', SubscriptionEvidence>, reinstall: ReinstallEvidence) {
  const r = w.readiness.record(C_KEY, { installation: C_IDS, subscriptions, reinstall })
  if (r.kind !== 'recorded') throw new Error(`direct record failed: ${r.kind}`)
}

/** A channel C holds a saved choice for (giveCChoice). */
const SAVED_CHANNEL = 'C0SAVED001'

/** Give C a saved choice for `channel` through the production authority: a verified join, then `delivery` stored. */
function giveCChoice(w: World, channel: string, delivery: 'mentions' | 'all') {
  const incarnation = w.authority.incarnation(C_KEY)!
  const boundary = w.authority.snapshot().personas[C_KEY]!.membership[channel]?.boundary ?? 0
  if (w.authority.observeMembership(C_KEY, incarnation, { event: `scripted-join-${channel}`, identity: 'authenticated-app', channel, member: true, boundary }, w.authority.revision).kind !== 'applied') throw new Error('scripted join failed')
  if (w.authority.assign(C_KEY, incarnation, channel, delivery, w.authority.revision).kind !== 'applied') throw new Error('scripted choice failed')
}

// ---------------------------------------------------------------------------
// setupEvidence and reinstallConsistency (pure)
// ---------------------------------------------------------------------------

describe('setupEvidence: the runner\'s current-app evidence', () => {
  const input = (provisioned: ProvisionedApp, over: { needsReinstall?: boolean; exported?: ManifestExport } = {}) => ({
    appId: C_IDS.appId,
    provisioned,
    needsReinstall: over.needsReinstall ?? false,
    exported: over.exported ?? { kind: 'exported' as const, manifest: exportedManifest() },
    wanted: MANIFEST_C,
  })
  const BOTH = { member_joined_channel: 'verified', channel_left: 'verified' }

  test.each([
    ['a reused app kept', KEPT],
    ['a new app installed', { appId: C_IDS.appId, apps: 'created', drift: [], unchecked: false, install: 'installed' }],
    ['an updated app reinstalled', { appId: C_IDS.appId, apps: 'updated', drift: ['settings.event_subscriptions.bot_events'], unchecked: false, install: 'reinstalled' }],
    ['an adopted app with no drift, kept', { appId: C_IDS.appId, apps: 'adopted', drift: [], unchecked: false, install: 'kept' }],
    ['an adopted app that drifted, reinstalled', { appId: C_IDS.appId, apps: 'adopted', drift: ['display_information.name'], unchecked: false, install: 'reinstalled' }],
  ] as [string, ProvisionedApp][])('%s, with an undrifted export holding both events: verified and complete, no limit', (_what, p) => {
    const e = setupEvidence(input(p))
    expect([e.subscriptions, e.reinstall, e.limits] as unknown[]).toEqual([BOTH, 'complete', []])
  })

  test.each([
    ['member_joined_channel', { member_joined_channel: 'missing', channel_left: 'verified' }],
    ['channel_left', { member_joined_channel: 'verified', channel_left: 'missing' }],
  ] as const)('an export without %s: that event is missing', (event, want) => {
    const events = ['app_mention', 'member_joined_channel', 'channel_left'].filter((e) => e !== event)
    expect(setupEvidence(input(KEPT, { exported: { kind: 'exported', manifest: exportedManifest(events) } })).subscriptions).toEqual(want)
  })

  test('needs_reinstall set: incomplete, whatever the provisioning and export say', () => {
    for (const p of [KEPT, UNREPORTED, { ...KEPT, unchecked: true }]) {
      expect(setupEvidence(input(p, { needsReinstall: true })).reinstall).toBe('incomplete')
    }
  })

  test.each([
    ['an unavailable export', KEPT, { kind: 'unavailable', why: 'no usable configuration token' }, ['unknown', 'unknown'], [subscriptionsUninspectableLimit('no usable configuration token'), EXPORT_UNAVAILABLE_REINSTALL_LIMIT]],
    ['a tokenless reuse', { ...KEPT, unchecked: true }, undefined, ['verified', 'verified'], [TOKENLESS_REUSE_LIMIT]],
    ['no provisioning report', UNREPORTED, undefined, ['verified', 'verified'], [NO_PROVISIONING_LIMIT]],
    ['an updated app the install stage kept', { appId: C_IDS.appId, apps: 'updated', drift: ['display_information.name'], unchecked: false, install: 'kept' }, undefined, ['verified', 'verified'], [UPDATED_NOT_REINSTALLED_LIMIT]],
    ['an adopted app that drifted and was kept', { appId: C_IDS.appId, apps: 'adopted', drift: ['display_information.name'], unchecked: false, install: 'kept' }, undefined, ['verified', 'verified'], [UPDATED_NOT_REINSTALLED_LIMIT]],
  ] as [string, ProvisionedApp, ManifestExport | undefined, string[], string[]][])('%s: reinstall unknown, with its fixed limit sentence', (_what, p, exported, subs, limits) => {
    const e = setupEvidence(input(p, exported ? { exported } : {}))
    expect([e.subscriptions.member_joined_channel, e.subscriptions.channel_left, e.reinstall, e.limits] as unknown[]).toEqual([...subs, 'unknown', limits])
  })

  test('drift seen at check time: reinstall unknown with DRIFT_AT_CHECK_LIMIT, and the drifted path among the facts', () => {
    const drifted = exportedManifest() as Record<string, any>
    drifted.display_information = { ...drifted.display_information, name: 'Renamed by hand' }
    const e = setupEvidence(input(KEPT, { exported: { kind: 'exported', manifest: drifted } }))
    expect([e.reinstall, e.limits]).toEqual(['unknown', [DRIFT_AT_CHECK_LIMIT]])
    expect(e.facts).toContain('drift at check time: display_information.name')
  })

  test('facts hold IDs, event names and action words only: nothing from the manifest\'s other fields', () => {
    const e = setupEvidence(input({ appId: C_IDS.appId, apps: 'updated', drift: ['display_information.name'], unchecked: false, install: 'reinstalled' }))
    expect(e.facts).toEqual([
      `app ${C_IDS.appId}`,
      'apps stage: updated',
      'install stage: reinstalled',
      'needs_reinstall: false',
      'apps-stage drift: display_information.name',
      'exported bot_events (required): member_joined_channel,channel_left',
      'drift at check time: none',
    ])
    const unavailable = setupEvidence(input({ ...KEPT, unchecked: true }, { exported: { kind: 'unavailable', why: 'invalid_auth' } }))
    expect(unavailable.facts).toContain('apps stage: reused (unchecked: no usable configuration token)')
    assertNoLeak({ e, unavailable })
  })
})

describe("setupEvidence: provisioning reported for another app than the judged one", () => {
  const OTHER = 'A0OTHERAPP'
  const evidence = (provisioned: ProvisionedApp, needsReinstall = false) =>
    setupEvidence({ appId: C_IDS.appId, provisioned, needsReinstall, exported: { kind: 'exported', manifest: exportedManifest() }, wanted: MANIFEST_C })

  test('the limit texts are pinned', () => {
    expect(OTHER_APP_PROVISIONED_LIMIT).toBe("limit: this run's provisioning reported its outcome for another app than the one judged, so its reinstall could not be confirmed")
    expect(NO_RESTART_LIMIT).toBe('limit: no restart between record and readback in this run')
  })

  test.each([
    ['a kept reuse', { ...KEPT, appId: OTHER }],
    ['a new app installed', { appId: OTHER, apps: 'created', drift: [], unchecked: false, install: 'installed' }],
    ['an updated app reinstalled', { appId: OTHER, apps: 'updated', drift: ['display_information.name'], unchecked: false, install: 'reinstalled' }],
  ] as [string, ProvisionedApp][])("%s of another app: reinstall unknown with OTHER_APP_PROVISIONED_LIMIT and the \"(not the judged app)\" fact, never complete", (_what, p) => {
    const e = evidence(p)
    expect([e.reinstall, e.limits] as unknown[]).toEqual(['unknown', [OTHER_APP_PROVISIONED_LIMIT]])
    expect(e.facts).toContain(`apps-stage app: ${OTHER} (not the judged app)`)
    // The same outcome for the judged app is complete, with no such fact.
    const same = evidence({ ...p, appId: C_IDS.appId })
    expect([same.reinstall, same.limits, same.facts.some((f) => f.includes('not the judged app'))] as unknown[]).toEqual(['complete', [], false])
  })

  test('with needs_reinstall set it is still incomplete', () => {
    expect(evidence({ ...KEPT, appId: OTHER }, true).reinstall).toBe('incomplete')
  })

  test('setup-ready over another app\'s provisioning outcome is SKIPPED as not run with that limit, never PASS', async () => {
    const w = makeWorld()
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup({ provisioned: { ...KEPT, appId: OTHER } }).setup))
    expect(r.status).toBe('SKIPPED')
    expect(r.reason).toBe(`not run: ${OTHER_APP_PROVISIONED_LIMIT} (the plan records this as "not run", not a pass)`)
    expect(r.evidence).toContain(`apps-stage app: ${OTHER} (not the judged app)`)
  })
})

describe('reinstallConsistency: the one-time reinstall rule', () => {
  const p = (apps: ProvisionedApp['apps'], install: ProvisionedApp['install'], drift: string[] = []): ProvisionedApp => ({ appId: C_IDS.appId, apps, drift, unchecked: false, install })

  test.each([
    ['an updated app kept', p('updated', 'kept', ['x']), "the apps stage updated the app's manifest, but the install stage kept it instead of reinstalling it"],
    ['an updated app installed', p('updated', 'installed', ['x']), "the apps stage updated the app's manifest, but the install stage installed it instead of reinstalling it"],
    ['an adopted app that drifted, kept', p('adopted', 'kept', ['x']), "the apps stage updated the app's manifest, but the install stage kept it instead of reinstalling it"],
    ['a new app reinstalled', p('created', 'reinstalled'), 'the apps stage created the app, but the install stage reinstalled it rather than installing it'],
    ['an undrifted reused app reinstalled', p('reused', 'reinstalled'), 'the apps stage reused the app with no drift, but the install stage reinstalled it (a redundant reinstall)'],
  ])('flags %s', (_what, provisioned, problem) => {
    expect(reinstallConsistency(provisioned)).toEqual([problem])
  })

  test.each([
    ['an updated app reinstalled', p('updated', 'reinstalled', ['x'])],
    ['a new app installed', p('created', 'installed')],
    ['a reused app kept', p('reused', 'kept')],
    ['an adopted app with no drift, kept', p('adopted', 'kept')],
    ['an adopted app that drifted, reinstalled', p('adopted', 'reinstalled', ['x'])],
    ['no apps stage', p(undefined, 'reinstalled')],
    ['no install stage', p('updated', undefined, ['x'])],
    ['nothing reported', UNREPORTED],
  ])('flags nothing for %s', (_what, provisioned) => {
    expect(reinstallConsistency(provisioned)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// expectedSetupState and the route client against the real server
// ---------------------------------------------------------------------------

describe("expectedSetupState equals the real server's state", () => {
  const VALUES: SubscriptionEvidence[] = ['verified', 'missing', 'unknown']
  const REINSTALL: ReinstallEvidence[] = ['complete', 'incomplete', 'unknown']
  const combos = VALUES.flatMap((j) => VALUES.flatMap((l) => REINSTALL.map((r) => [j, l, r] as const)))

  test('for all 27 combinations of the two subscriptions and the reinstall, recorded on createMembershipReadiness and read back', () => {
    expect(combos.length).toBe(27)
    const w = makeWorld()
    const seen = new Set<string>()
    for (const [j, l, r] of combos) {
      const subscriptions = { member_joined_channel: j, channel_left: l }
      recordDirect(w, subscriptions, r)
      const state = w.readiness.read(C_KEY).setup.state
      expect([j, l, r, expectedSetupState(subscriptions, r)]).toEqual([j, l, r, state])
      seen.add(state)
    }
    expect([...seen].sort()).toEqual(['incomplete-reinstall', 'missing-subscriptions', 'unknown', 'verified'])
  })
})

describe('installationMatches', () => {
  const view = (installation?: InstallationIds) => ({
    setup: { state: 'unknown' as const, ...(installation ? { installation } : {}), missingSubscriptions: [], unknownSubscriptions: [], reinstall: 'unknown' as const },
    inventory: { state: 'complete' },
  })

  test("is true only when all four IDs are the team's and C's app, bot user and bot", () => {
    expect(installationMatches(view(C_IDS), DRY_RUN_IDS, 'c')).toBe(true)
    for (const field of ['teamId', 'appId', 'botUserId', 'botId'] as const) {
      expect([field, installationMatches(view({ ...C_IDS, [field]: 'X0OTHER000' }), DRY_RUN_IDS, 'c')]).toEqual([field, false])
    }
    expect(installationMatches(view(A_IDS), DRY_RUN_IDS, 'c')).toBe(false)
    expect(installationMatches(view(), DRY_RUN_IDS, 'c')).toBe(false)
    expect(installationMatches(undefined, DRY_RUN_IDS, 'c')).toBe(false)
  })
})

describe('the route client over the real handler', () => {
  test("readinessRead runs no guarded command, checks the server's PID and server.port, and projects the real answer to its listed fields only", async () => {
    const w = makeWorld()
    recordDirect(w, { member_joined_channel: 'verified', channel_left: 'verified' }, 'complete')
    const record = cRecord(w)!
    const a = await readinessRead(w, C_KEY)
    expect(a).toEqual({
      kind: 'answer',
      status: 200,
      body: {
        view: {
          setup: {
            state: 'verified',
            installation: C_IDS,
            missingSubscriptions: [],
            unknownSubscriptions: [],
            reinstall: 'complete',
            record: { subscriptions: { member_joined_channel: 'verified', channel_left: 'verified' }, reinstall: 'complete', recordedAt: record.recordedAt, order: record.order },
          },
          inventory: { state: 'complete', pages: 1 },
        },
      },
      pid: process.pid,
    })
    // The real answer held `ok`, `persona`, the installation's enterpriseId and the inventory's positives and slackError: all dropped.
    assertNoLeak(a)
    expect(guardedScripts(w)).toEqual([])
    expect(w.scripts).toHaveLength(1)
    expect(w.scripts[0]!.indexOf('server.pid')).toBeLessThan(w.scripts[0]!.indexOf('server.port'))
    expect(w.scripts[0]!.indexOf('server.port')).toBeLessThan(w.scripts[0]!.indexOf('curl'))
    expect(w.requests).toEqual([{ action: 'read', persona: C_KEY }])
  })

  test('after a restart, the answer carries the new server PID the script checked (a live process that owns server.port)', async () => {
    const w = makeWorld()
    w.restart()
    expect(w.pid).not.toBe(process.pid)
    const a = await readinessRead(w, C_KEY)
    expect(a.kind === 'answer' && [a.status, a.pid]).toEqual([200, w.pid])
  })

  // The script prints PID=<pid> first and HTTP=<status> last; the PID line must be a positive decimal.
  const BODY = JSON.stringify({ ok: true, view: { setup: { state: 'unknown', missingSubscriptions: [], unknownSubscriptions: [], reinstall: 'unknown' }, inventory: { state: 'complete' } } })
  test.each([
    ['no PID= line', `${BODY}\nHTTP=200\n`],
    ['PID=0', `PID=0\n${BODY}\nHTTP=200\n`],
    ['PID= with no digits', `PID=\n${BODY}\nHTTP=200\n`],
    ['a PID that is not a number', `PID=12a\n${BODY}\nHTTP=200\n`],
    ['the PID line after the body', `${BODY}\nPID=4242\nHTTP=200\n`],
    ['a PID line and no body', 'PID=4242\nHTTP=200\n'],
  ])('readinessAnswerOf: output with %s is unparsable, never a state', (_what, out) => {
    expect(readinessAnswerOf({ code: 0, out })).toEqual({ kind: 'failed', why: 'unparsable' })
  })

  test('readinessAnswerOf: PID=<pid>, the body, then HTTP=<status> is an answer carrying that PID', () => {
    expect(readinessAnswerOf({ code: 0, out: `PID=4242\n${BODY}\nHTTP=200\n` })).toMatchObject({ kind: 'answer', status: 200, pid: 4242, body: { view: { setup: { state: 'unknown' } } } })
  })

  test.each([
    ['no server.pid', (w: World) => rmSync(join(w.state, 'server.pid'))],
    ['a server.pid of no running process', (w: World) => writeFileSync(join(w.state, 'server.pid'), '2147483646\n')],
    ['a server.port another PID owns', (w: World) => writeFileSync(join(w.state, 'server.port'), JSON.stringify({ pid: process.pid + 1, port: 1 }))],
    ['a server.port with no usable port', (w: World) => writeFileSync(join(w.state, 'server.port'), JSON.stringify({ pid: process.pid, port: 'x' }))],
  ])('%s: a no-server failure, and no request reaches the loopback listener', async (_what, arm) => {
    const w = makeWorld()
    arm(w)
    expect(await readinessRead(w, C_KEY)).toEqual({ kind: 'failed', why: 'no-server' })
    expect(w.requests).toEqual([])
  })

  test('a server that does not answer (nothing listening on its port) is a no-answer failure, never a state', async () => {
    const w = makeWorld()
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = closed.port
    closed.stop(true)
    writeFileSync(join(w.state, 'server.port'), JSON.stringify({ pid: process.pid, port }))
    expect(await readinessRead(w, C_KEY)).toEqual({ kind: 'failed', why: 'no-answer' })
  })

  test.each([
    ['a non-JSON answer', () => new Response(`not json ${BODY_SENTINEL}`), 'unparsable'],
    ['an empty answer', () => new Response(''), 'unparsable'],
    ['an answer of an unknown state', () => Response.json({ view: { setup: { state: 'ready', missingSubscriptions: [], unknownSubscriptions: [], reinstall: 'complete' }, inventory: { state: 'complete' } } }), 'unparsable'],
    ['a token-shaped answer', () => Response.json({ ok: true, note: TOKEN }), 'token-shaped'],
  ] as const)('%s is a distinct failure, never a state, and echoes nothing', async (_what, answer, why) => {
    const w = makeWorld()
    w.answer = answer
    const a = await readinessRead(w, C_KEY)
    expect(a).toEqual({ kind: 'failed', why })
    assertNoLeak(a)
  })

  test('readinessRecord runs only behind the guard: refused, it sends nothing and records nothing', async () => {
    const w = makeWorld()
    w.guardRefuses = true
    const before = readFileSync(join(w.state, 'config.json.last-applied'), 'utf-8')
    const r = await readinessRecord(w, C_KEY, C_IDS, { subscriptions: { member_joined_channel: 'verified', channel_left: 'verified' }, reinstall: 'complete' })
    expect(r).toEqual({ kind: 'failed', why: 'guard-refused' })
    expect([w.requests, guardedScripts(w).length, w.scripts.length]).toEqual([[], 1, 1])
    expect(readFileSync(join(w.state, 'config.json.last-applied'), 'utf-8')).toBe(before)

    w.guardRefuses = false
    const ok = await readinessRecord(w, C_KEY, C_IDS, { subscriptions: { member_joined_channel: 'verified', channel_left: 'missing' }, reinstall: 'complete' })
    expect(ok.kind === 'answer' && [ok.status, ok.body.kind, ok.body.view?.setup.state]).toEqual([200, 'recorded', 'missing-subscriptions'])
    expect(w.requests).toEqual([
      { action: 'record', persona: C_KEY, installation: C_IDS, subscriptions: { member_joined_channel: 'verified', channel_left: 'missing' }, reinstall: 'complete' },
    ])
  })

  test('request bodies are built and quoted, never spliced: a persona key or an ID holding a quote stays one value', async () => {
    const w = makeWorld()
    const persona = `persona_c' ; echo "$S" ; '`
    const read = await readinessRead(w, persona)
    expect(read).toEqual({ kind: 'answer', status: 404, body: {}, pid: process.pid })
    const ids = { ...C_IDS, botId: `B0'"$(touch x)` }
    const rec = await readinessRecord(w, C_KEY, ids, { subscriptions: { member_joined_channel: 'verified', channel_left: 'verified' }, reinstall: 'complete' })
    expect(rec).toEqual({ kind: 'answer', status: 400, body: { kind: 'invalid' }, pid: process.pid })
    expect(w.requests).toEqual([
      { action: 'read', persona },
      { action: 'record', persona: C_KEY, installation: ids, subscriptions: { member_joined_channel: 'verified', channel_left: 'verified' }, reinstall: 'complete' },
    ])
    expect(cRecord(w)).toBeUndefined()
  })
})

describe('savedChoices', () => {
  test("reads C's applied channels from the last-applied record as the production authority writes it", async () => {
    const w = makeWorld()
    const applied = (name: string) => (w.authority.config().personas.find((p) => p.name === name)!.channels ?? []).map(({ id, delivery }) => ({ id, delivery }))
    // A's two applied channels: every field the reader projects, from a non-empty list.
    expect(applied(personaName('a')).length).toBe(2)
    expect(JSON.parse((await savedChoices(w, personaName('a')))!)).toEqual(applied(personaName('a')))
    // C's choice, written by the authority (a verified join, then a stored delivery), and then changed.
    giveCChoice(w, SAVED_CHANNEL, 'mentions')
    expect(JSON.parse((await savedChoices(w, C_KEY))!)).toEqual([{ id: SAVED_CHANNEL, delivery: 'mentions' }])
    giveCChoice(w, SAVED_CHANNEL, 'all')
    expect(JSON.parse((await savedChoices(w, C_KEY))!)).toEqual([{ id: SAVED_CHANNEL, delivery: 'all' }])
    expect(applied(C_KEY)).toEqual([{ id: SAVED_CHANNEL, delivery: 'all' }])
    expect(await savedChoices(w, 'persona_z')).toBeNull()
    expect(guardedScripts(w)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// membershipSetupCheck (setup-ready)
// ---------------------------------------------------------------------------

describe('membershipSetupCheck (setup-ready)', () => {
  const VERIFIED_LINE = `[slack] channel-membership-setup-verified persona=${C_KEY}: missing=none unknown=none reinstall=complete`

  test('passes on verified: names the installation, both subscriptions, the reinstall with its actions, the state and the inventory reported separately; shares the record', async () => {
    const w = makeWorld()
    const { setup, exports } = fakeSetup()
    const ctx = makeCtx(w, setup)
    const r = await membershipSetupCheck.run(ctx)
    expect(r.status).toBe('PASS')
    const record = cRecord(w)!
    expect(r.evidence).toEqual(
      expect.arrayContaining([
        `installation ${installationKey(C_IDS)}`,
        'apps stage: reused',
        'install stage: kept',
        'evidence: member_joined_channel=verified channel_left=verified reinstall=complete',
        `mismatched installation (persona A's app): HTTP 409 installation-mismatch`,
        `readback: setup verified: missing=none unknown=none reinstall=complete; record order ${record.order}, recordedAt ${record.recordedAt}`,
        'inventory (reported separately, not part of this verdict): complete, 1 page(s)',
      ]),
    )
    expect(exports).toEqual([C_IDS.appId])
    expect(ctx.shared.membershipSetup).toEqual({ installation: installationKey(C_IDS), order: record.order, recordedAt: record.recordedAt, state: 'verified', pid: process.pid })
    expect(r.evidence).toContain(`server PID ${process.pid}`)
    // One recorded line and one state line since the check's mark (the start's report came before it).
    const lines = cLogLines(w)
    expect(lines.slice(1)).toEqual([
      `[slack] channel-membership-setup-recorded persona=${C_KEY}: saved manual evidence for the authenticated current installation; inventory and saved choices are unchanged.`,
      expect.stringContaining(VERIFIED_LINE),
    ])
    // The record and the probe ran behind the guard; nothing else did.
    expect(guardedScripts(w)).toHaveLength(2)
    assertNoLeak({ r, lines })
  })

  test('the mismatched-installation probe is refused (409 installation-mismatch) and leaves the record and C\'s saved choices unchanged', async () => {
    const w = makeWorld()
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect(r.status).toBe('PASS')
    const probe = w.requests.find((b) => (b as { installation?: InstallationIds }).installation?.appId === A_IDS.appId)
    expect(probe).toMatchObject({ action: 'record', persona: C_KEY, installation: A_IDS })
    const record = cRecord(w)!
    // Exactly one record was saved, at the first record's order.
    expect(Object.keys(w.authority.snapshot().personas[C_KEY]!.installationReadiness ?? {})).toEqual([installationKey(C_IDS)])
    expect(record.installation).toEqual(C_IDS)
  })

  test('a server that accepts the mismatched installation fails the check', async () => {
    const w = makeWorld()
    w.acceptMismatch = true
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain('not 409 installation-mismatch')
    expect(r.reason).toContain('the record changed after it was saved')
  })

  test.each([
    ['unavailable export, inventory complete', { exported: { kind: 'unavailable', why: 'no usable configuration token' } }, 'complete'],
    ['a tokenless reuse', { provisioned: { ...KEPT, unchecked: true } }, 'complete'],
    ['no provisioning report', { provisioned: UNREPORTED }, 'complete'],
  ] as [string, Partial<SetupFacts>, MembershipScanStatus['state']][])('unknown (%s) is SKIPPED as not run with its limits, never PASS; the record is still made and read back', async (_what, facts, inventory) => {
    const w = makeWorld()
    w.inventory = { ...w.inventory, state: inventory }
    const { setup } = fakeSetup(facts)
    const ctx = makeCtx(w, setup)
    const r = await membershipSetupCheck.run(ctx)
    const limits = setupEvidence({ appId: C_IDS.appId, provisioned: setup.provisioned('c'), needsReinstall: false, exported: await setup.exportManifest(C_IDS.appId), wanted: MANIFEST_C }).limits
    expect(r.status).toBe('SKIPPED')
    expect(r.reason).toBe(`not run: ${limits.join('; ')} (the plan records this as "not run", not a pass)`)
    expect(r.reason).not.toContain('limit: limit:')
    expect(r.notes).toEqual(limits)
    expect(cRecord(w)!.reinstall).toBe('unknown')
    expect(w.readiness.read(C_KEY).setup.state).toBe('unknown')
    expect(cLogLines(w).at(-1)).toContain(`[slack] channel-membership-setup-unknown persona=${C_KEY}: `)
    // The record is shared (no failure); setup-restart then judges against an unknown state.
    expect(ctx.shared.membershipSetup?.state).toBe('unknown')
  })

  test('inventory never decides: incomplete inventory with verified setup still passes', async () => {
    const w = makeWorld()
    w.inventory = { state: 'incomplete', pages: 0, positives: 0 }
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect(r.status).toBe('PASS')
    expect(r.evidence).toContain('inventory (reported separately, not part of this verdict): incomplete, 0 page(s)')
  })

  test.each([
    [
      'a missing event',
      { exported: { kind: 'exported', manifest: exportedManifest(['app_mention', 'member_joined_channel']) } },
      `[slack] channel-membership-subscriptions-missing persona=${C_KEY}: missing=channel_left unknown=none reinstall=unknown`,
    ],
    ['a pending reinstall', { needsReinstall: true }, `[slack] channel-membership-reinstall-incomplete persona=${C_KEY}: missing=none unknown=none reinstall=incomplete`],
  ] as [string, Partial<SetupFacts>, string][])('%s FAILs, naming the server\'s matching state and diagnostic', async (_what, facts, diagnostic) => {
    const w = makeWorld()
    const ctx = makeCtx(w, fakeSetup(facts).setup)
    const r = await membershipSetupCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(diagnostic)
    expect(cLogLines(w).at(-1)).toStartWith(diagnostic)
    expect(ctx.shared.membershipSetup).toBeUndefined()
  })

  test.each([
    ["another app's installation", (w: World) => void (w.cIdentity = { ...A_IDS }), "the server's authenticated installation for C is not apps.json's app; nothing was recorded"],
    ['another bot user on the same app', (w: World) => void (w.cIdentity = { ...C_IDS, botUserId: 'U0OTHERBOT' }), "the server's authenticated installation for C is not apps.json's app; nothing was recorded"],
    ['no authenticated installation', (w: World) => void (w.cIdentity = null), 'the server reports no authenticated installation for C (reason installation-unverified); nothing was recorded'],
  ])('%s FAILs with nothing recorded and no guarded command run', async (_what, arm, reason) => {
    const w = makeWorld()
    arm(w)
    const before = readFileSync(join(w.state, 'config.json.last-applied'), 'utf-8')
    const { setup, exports } = fakeSetup()
    const ctx = makeCtx(w, setup)
    const r = await membershipSetupCheck.run(ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', reason])
    expect([guardedScripts(w), exports, cRecord(w)] as unknown[]).toEqual([[], [], undefined])
    expect(readFileSync(join(w.state, 'config.json.last-applied'), 'utf-8')).toBe(before)
    expect(ctx.shared.membershipSetup).toBeUndefined()
  })

  test.each([
    ['a second recorded line', (line: string) => (line.includes('channel-membership-setup-recorded') ? [line, line] : [line]), 'expected one channel-membership-setup-recorded line for C, found 2'],
    ['no state line', (line: string) => (line.includes('channel-membership-setup-verified') ? [] : [line]), 'state line(s)'],
    ['a second state line', (line: string) => (line.includes('channel-membership-setup-verified') ? [line, line] : [line]), 'found 2 state line(s)'],
  ] as const)('%s since the mark FAILs', async (_what, hook, reason) => {
    const w = makeWorld()
    w.logHook = hook
    const ctx = makeCtx(w, fakeSetup().setup)
    const r = await membershipSetupCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
    expect(ctx.shared.membershipSetup).toBeUndefined()
  })

  test.each([
    ['a new app reinstalled', { appId: C_IDS.appId, apps: 'created', drift: [], unchecked: false, install: 'reinstalled' }],
    ['an updated app kept', { appId: C_IDS.appId, apps: 'updated', drift: ['display_information.name'], unchecked: false, install: 'kept' }],
    ['an adopted app that drifted, kept', { appId: C_IDS.appId, apps: 'adopted', drift: ['display_information.name'], unchecked: false, install: 'kept' }],
    ['a redundant reinstall', { appId: C_IDS.appId, apps: 'reused', drift: [], unchecked: false, install: 'reinstalled' }],
  ] as [string, ProvisionedApp][])('a reinstall-rule finding (%s) FAILs, and the record is not shared', async (_what, provisioned) => {
    const w = makeWorld()
    const ctx = makeCtx(w, fakeSetup({ provisioned }).setup)
    const r = await membershipSetupCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reinstallConsistency(provisioned)[0]!)
    expect(ctx.shared.membershipSetup).toBeUndefined()
  })

  test("a choice C holds is kept: the record and readback leave it as the authority wrote it, and the check passes", async () => {
    const w = makeWorld()
    giveCChoice(w, SAVED_CHANNEL, 'mentions')
    const before = await savedChoices(w, C_KEY)
    expect(JSON.parse(before!)).toEqual([{ id: SAVED_CHANNEL, delivery: 'mentions' }])
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(await savedChoices(w, C_KEY)).toBe(before)
  })

  test("a changed delivery of a choice C holds FAILs the check", async () => {
    const w = makeWorld()
    giveCChoice(w, SAVED_CHANNEL, 'mentions')
    // A server that changes that choice's delivery (mentions to all), through the authority, when it records.
    const realRecord = w.readiness.record
    w.readiness.record = (key, value) => {
      const result = realRecord(key, value)
      if (result.kind === 'recorded') giveCChoice(w, SAVED_CHANNEL, 'all')
      return result
    }
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain("C's saved choices changed")
    expect(JSON.parse((await savedChoices(w, C_KEY))!)).toEqual([{ id: SAVED_CHANNEL, delivery: 'all' }])
  })

  test.each([
    ['a failed read', (w: World) => void (w.answer = () => new Response('not json')), 'the readiness read failed (read: unparsable)'],
    ['a refused guard', (w: World) => void (w.guardRefuses = true), 'the readiness record failed (record: guard-refused)'],
  ])('%s is a FAIL, never a PASS or a state', async (_what, arm, reason) => {
    const w = makeWorld()
    arm(w)
    const r = await membershipSetupCheck.run(makeCtx(w, fakeSetup().setup))
    expect([r.status, r.reason]).toEqual(['FAIL', reason])
  })

  test('every evidence line, note, reason and captured log leaks nothing, with sentinels planted in the server\'s state and the manifest', async () => {
    const results = []
    for (const facts of [{}, { exported: { kind: 'unavailable', why: 'invalid_auth' } }, { needsReinstall: true }] as Partial<SetupFacts>[]) {
      const w = makeWorld()
      results.push(await membershipSetupCheck.run(makeCtx(w, fakeSetup(facts).setup)), cLogLines(w))
    }
    assertNoLeak(results)
  })
})

// ---------------------------------------------------------------------------
// membershipSetupRestartCheck (setup-restart)
// ---------------------------------------------------------------------------

describe('membershipSetupRestartCheck (setup-restart)', () => {
  /** A clean setup-ready, then an ordinary restart; the ctx for the restart check carries the shared record. */
  /** A clean setup-ready, then (unless `restart` is false) an ordinary restart under a new server PID. */
  async function afterSetupReady(facts: Partial<SetupFacts> = {}, restart = true) {
    const w = makeWorld()
    const s = fakeSetup(facts)
    const ctx = makeCtx(w, s.setup)
    const first = await membershipSetupCheck.run(ctx)
    if (restart) w.restart()
    return { w, ctx, s, first }
  }

  test('passes when the record from before the restarts is unchanged, for the same installation, verified, with no further reinstall, under a new server PID; notes the downtime limit', async () => {
    const { w, ctx, first } = await afterSetupReady()
    expect(first.status).toBe('PASS')
    const guardedBefore = guardedScripts(w).length
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('PASS')
    expect(r.notes).toEqual([DOWNTIME_LEAVE_LIMIT])
    const record = cRecord(w)!
    expect(r.evidence).toContain(`recorded before the restarts: order ${record.order}, recordedAt ${record.recordedAt}, verified`)
    expect(r.evidence).toContain(`server PID at the record ${process.pid}, at this readback ${w.pid}`)
    // Read only: nothing recorded again.
    expect(guardedScripts(w).length).toBe(guardedBefore)
    assertNoLeak(r)
  })

  test('no restart between them (the same server PID): SKIPPED as not run with NO_RESTART_LIMIT, never PASS, and nothing recorded again', async () => {
    const { w, ctx, first } = await afterSetupReady({}, false)
    expect(first.status).toBe('PASS')
    const guardedBefore = guardedScripts(w).length
    const r = await membershipSetupRestartCheck.run(ctx)
    expect([r.status, r.reason]).toEqual(['SKIPPED', `not run: ${NO_RESTART_LIMIT} (the plan records this as "not run", not a pass)`])
    expect(r.notes).toEqual(expect.arrayContaining([DOWNTIME_LEAVE_LIMIT, NO_RESTART_LIMIT]))
    expect(r.evidence).toContain(`server PID at the record ${process.pid}, at this readback ${process.pid} (the same process: no restart)`)
    expect(guardedScripts(w).length).toBe(guardedBefore)
  })

  test.each([
    ['a changed record', (w: World) => recordDirect(w, { member_joined_channel: 'verified', channel_left: 'verified' }, 'complete'), 'the record changed since it was saved before the restarts'],
    ['a pending reinstall', (_w: World, s: ReturnType<typeof fakeSetup>) => void (s.facts.needsReinstall = true), 'apps.json marks C for a further reinstall'],
  ] as [string, (w: World, s: ReturnType<typeof fakeSetup>) => void, string][])('the same server PID with a deficiency (%s) still FAILs', async (_what, arm, reason) => {
    const { w, ctx, s } = await afterSetupReady({}, false)
    arm(w, s)
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
    expect(r.evidence).toContain(`server PID at the record ${process.pid}, at this readback ${process.pid} (the same process: no restart)`)
  })

  test.each([
    ['a changed order (recorded again)', (w: World) => recordDirect(w, { member_joined_channel: 'verified', channel_left: 'verified' }, 'complete'), 'the record changed since it was saved before the restarts'],
    [
      'a changed order at the same recordedAt (recorded again within the clock tick)',
      (w: World) => {
        w.nowStep = 0
        recordDirect(w, { member_joined_channel: 'verified', channel_left: 'verified' }, 'complete')
      },
      'the record changed since it was saved before the restarts',
    ],
    ['a pending reinstall', (_w: World, s: ReturnType<typeof fakeSetup>) => void (s.facts.needsReinstall = true), 'apps.json marks C for a further reinstall'],
    ['a changed state', (w: World) => recordDirect(w, { member_joined_channel: 'verified', channel_left: 'missing' }, 'complete'), 'the setup is missing-subscriptions, not verified as recorded before the restarts'],
  ] as [string, (w: World, s: ReturnType<typeof fakeSetup>) => void, string][])('%s FAILs', async (_what, arm, reason) => {
    const { w, ctx, s } = await afterSetupReady()
    arm(w, s)
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
    expect(r.notes).toContain(DOWNTIME_LEAVE_LIMIT)
  })

  test('a new installation (another bot, which apps.json now records) FAILs: the installation changed and its record is gone', async () => {
    const { w, ctx } = await afterSetupReady()
    const moved = { ...C_IDS, botUserId: 'U0NEWBOTC0', botId: 'B0NEWBOTC0' }
    w.cIdentity = moved
    ctx.ids = { ...DRY_RUN_IDS, bots: { ...DRY_RUN_IDS.bots, c: { appId: moved.appId, userId: moved.botUserId, botId: moved.botId } } }
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain('the installation changed since the record')
    expect(r.reason).toContain('the record from before the restarts is gone')
  })

  test('an unknown record kept across the restarts is SKIPPED as not run, never PASS', async () => {
    const { ctx, first } = await afterSetupReady({ provisioned: { ...KEPT, unchecked: true } })
    expect(first.status).toBe('SKIPPED')
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('SKIPPED')
    expect(r.reason).toStartWith('not run: limit: the setup recorded before the restarts is unknown (uninspectable), not verified')
  })

  test.each([
    ['a verified setup', {}, 'SKIPPED'],
    ['a pending reinstall', { needsReinstall: true }, 'FAIL'],
    ['an unavailable export', { exported: { kind: 'unavailable', why: 'invalid_auth' } }, 'SKIPPED'],
  ] as [string, Partial<SetupFacts>, CheckResult['status']][])('without an earlier record (%s) it records as setup-ready does, notes that no restart came between, and is %s, never PASS', async (_what, facts, status) => {
    const w = makeWorld()
    const r = await membershipSetupRestartCheck.run(makeCtx(w, fakeSetup(facts).setup))
    expect(r.status).toBe(status)
    expect(r.notes).toEqual(expect.arrayContaining([DOWNTIME_LEAVE_LIMIT, 'limit: no restart between record and readback in this run']))
    expect(cRecord(w)).toBeDefined()
    expect(guardedScripts(w)).toHaveLength(2)
    if (status === 'SKIPPED') expect(r.reason).toBe('not run: limit: no restart between record and readback in this run (the plan records this as "not run", not a pass)')
    // The uninspectable setup stays a stated limit in the fallback (Deviation 4).
    if (facts.exported?.kind === 'unavailable') expect(r.notes).toEqual(expect.arrayContaining([subscriptionsUninspectableLimit('invalid_auth'), EXPORT_UNAVAILABLE_REINSTALL_LIMIT]))
  })

  test('after a failed setup-ready (nothing shared), it takes the fallback and is never PASS', async () => {
    const { ctx, first } = await afterSetupReady({ provisioned: { appId: C_IDS.appId, apps: 'reused', drift: [], unchecked: false, install: 'reinstalled' } })
    expect(first.status).toBe('FAIL')
    expect(ctx.shared.membershipSetup).toBeUndefined()
    const r = await membershipSetupRestartCheck.run(ctx)
    expect(r.status).toBe('FAIL')
    expect(r.notes).toContain('limit: no restart between record and readback in this run')
  })

  test('a silent server after the restarts is a FAIL, never a PASS', async () => {
    const { w, ctx } = await afterSetupReady()
    rmSync(join(w.state, 'server.pid'))
    const r = await membershipSetupRestartCheck.run(ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', 'the readiness read failed (read: no-server)'])
  })
})
