/**
 * context.ts — what every check receives. The runner builds it; unit tests
 * build one from fakes (every member is an interface or plain data).
 */

import type { AppsState } from '../lib/apps-state.ts'
import type { BrowserDriver } from '../lib/browser-types.ts'
import type { ContainerExec } from '../lib/container.ts'
import type { HostSnapshot } from '../lib/host-state.ts'
import type { HumanSession } from '../lib/human-session.ts'
import type { WorkspaceIds } from '../lib/live-config.ts'
import type { JsonObject } from '../lib/manifest.ts'
import type { PersonaLetter } from '../lib/personas.ts'
import type { ScanReport } from '../lib/secrecy-scan.ts'
import type { Clock } from '../lib/wait.ts'
import type { AppAction } from '../provision/apps.ts'
import type { InstallAction } from '../provision/install.ts'
import type { CheckPromptGuard } from './prompt-guard.ts'

export interface PersonaIds {
  userId: string
  botId: string
  appId: string
}

export interface LiveIds extends WorkspaceIds {
  bots: Record<PersonaLetter, PersonaIds>
}

/** Placeholder IDs for a dry run (no workspace): shaped like Slack IDs, owned by nobody. */
export const DRY_RUN_IDS: LiveIds = {
  teamId: 'T0DRYRUN00',
  humanUserId: 'U0DRYHUMAN',
  aHome: 'C0DRYAHOME',
  coordination: 'C0DRYCOORD',
  dHome: 'C0DRYDHOME',
  bots: {
    a: { userId: 'U0DRYBOTA0', botId: 'B0DRYBOTA0', appId: 'A0DRYAPPA0' },
    b: { userId: 'U0DRYBOTB0', botId: 'B0DRYBOTB0', appId: 'A0DRYAPPB0' },
    c: { userId: 'U0DRYBOTC0', botId: 'B0DRYBOTC0', appId: 'A0DRYAPPC0' },
    d: { userId: 'U0DRYBOTD0', botId: 'B0DRYBOTD0', appId: 'A0DRYAPPD0' },
  },
}

/** The IDs from apps.json, or `null` naming what is missing. */
export function liveIdsFrom(state: AppsState): LiveIds | string {
  const missing: string[] = []
  const bot = (l: PersonaLetter) => {
    const p = state.personas[l]
    if (!p?.app_id || !p.bot_user_id || !p.bot_id) missing.push(`persona ${l}`)
    return { userId: p?.bot_user_id ?? '', botId: p?.bot_id ?? '', appId: p?.app_id ?? '' }
  }
  const ids: LiveIds = {
    teamId: state.team_id ?? '',
    humanUserId: state.human_user_id ?? '',
    aHome: state.channels['a-home'] ?? '',
    coordination: state.channels.coordination ?? '',
    dHome: state.channels['d-home'] ?? '',
    bots: { a: bot('a'), b: bot('b'), c: bot('c'), d: bot('d') },
  }
  if (!ids.teamId) missing.push('team_id')
  if (!ids.humanUserId) missing.push('human_user_id')
  if (!ids.aHome || !ids.coordination || !ids.dHome) missing.push('channels')
  return missing.length > 0 ? `apps.json is incomplete (${missing.join(', ')}): run the provisioning first` : ids
}

/** The second workspace user (Checks 14, 16 and 20), when live.json configures one. */
export interface SecondUser {
  human: HumanSession
  userId: string
}

/** Host-side operations on the credentials files the container mounts. */
export interface HostCredentials {
  /** Check 25: move D's file from the staging dir into the mounted dir (it appears in the container). */
  moveDIntoMount(): void
  /** Check 28: rewrite B's file with a new app-level token (validated first); the bot token is kept. */
  rewriteBAppToken(appToken: string): Promise<void>
  /** How many credentials files the container sees now (for leakcount's `tokens checked`). */
  mountedCount(): number
  /** The recorded name of B's current app-level token. */
  bAppTokenName(): string
  /** Record B's current app-level token name. */
  setBAppTokenName(name: string): void
}

/**
 * What this run's provisioning did for one persona. A member is `undefined`
 * when its stage didn't run or didn't report the persona (a `--stage` run, a
 * failed stage, or provisioning that threw).
 */
export interface ProvisionedApp {
  /** The app the apps stage reported. */
  appId: string | undefined
  /** The apps stage's action. */
  apps: AppAction | undefined
  /** The apps stage's drifted manifest paths. */
  drift: string[] | undefined
  /** The apps stage reused the recorded app with no usable configuration token (no export, drift check or update). */
  unchecked: boolean | undefined
  /** The install stage's action. */
  install: InstallAction | undefined
}

/**
 * One `apps.manifest.export` with the configuration token. `why` is a safe
 * Slack error code, a transport kind or "no usable configuration token",
 * never a token or a response body.
 */
export type ManifestExport = { kind: 'exported'; manifest: JsonObject } | { kind: 'unavailable'; why: string }

/**
 * This run's current-app setup facts, read only (the runner's, from
 * provisioning and the configuration token): the server's runtime credentials
 * can't inspect Slack app settings, and the checks get no new credentials.
 */
export interface AppSetupSource {
  /** This run's apps-stage and install-stage outcomes for the persona. */
  provisioned(letter: PersonaLetter): ProvisionedApp
  /** apps.json's `needs_reinstall` for the persona, read now. */
  needsReinstall(letter: PersonaLetter): boolean
  /** One `apps.manifest.export` of `appId`; never throws for a missing or refused token, no answer or `ok: false`. */
  exportManifest(appId: string): Promise<ManifestExport>
  /** The manifest generated for the persona from the shipped `slack-app-manifest.yml`. */
  wantedManifest(letter: PersonaLetter): JsonObject
}

/** Values one check leaves for a later one. */
export interface SharedState {
  /** Part 1.2: did the human have a DM with C before the run? */
  cDmBeforeRun?: boolean
  aDm?: string
  bDm?: string
  cDm?: string
  /** Check 25 step 1: the A, B and C instance IDs. */
  rowsAtCheck25?: string[]
  /**
   * Check 27: whether D's row was there before the removal (its teardown
   * kills the row and keeps it), for Check 28's kept rows.
   */
  dRowKept?: boolean
  /** Check 24 setup: the original session_restart_delay (JSON), for the teardown. */
  origDelay?: string
  /** Check 24: the original accepted item, retained through the guarded recovery restart. */
  waitingMessage?: { ts: string; seq?: number; mark: string }
  /** The installed package version and the tarball it came from. */
  packageVersion?: string
  /** The personas brought up in this run (Check 1: A, B, C; Check 25: D), for Check 29a's transcripts. */
  broughtUp?: PersonaLetter[]
  /**
   * Check 30: where in the container it copied config.json before its
   * switch-on edit; set as soon as the copy exists (Check 34 restores it).
   */
  invitedConfigCopy?: string
  /** Check 30: the public channel it created for the run; set as soon as it exists (Checks 31–34). */
  invitedChannel?: { id: string; name: string }
  /** Check 30: the ts of C's answer in that channel (Check 33 asks C to edit it). */
  invitedCAnswerTs?: string
  /**
   * membershipSetupCheck: C's readiness record as read back (its
   * installation key, order, recordedAt and setup state) and the running
   * server's PID, for membershipSetupRestartCheck after Checks 24 and 28's
   * restarts (which must find another PID).
   */
  membershipSetup?: { installation: string; order: number; recordedAt: number; state: string; pid: number }
}

export interface CheckContext {
  mode: 'real' | 'dry-run'
  runId: string
  container: ContainerExec
  /** The container's hostname (the testplan's TEST_HOST). */
  hostName: string
  clock: Clock
  log: { info(message: string): void; detail(message: string): void }
  /** Run-level notes for the Results row. */
  runNotes: string[]
  ids: LiveIds
  human: HumanSession | null
  second: SecondUser | null
  browser: BrowserDriver | null
  creds: HostCredentials
  /** This run's app setup facts (provisioning's outcomes, apps.json, the manifest export), for the setup-readiness checks. */
  readonly setup: AppSetupSource
  shared: SharedState
  /**
   * The run's prompt guard (prompt-guard.ts): a check that raises a
   * permission prompt declares it here before it posts, and the guard denies
   * any prompt no running check expects.
   */
  promptGuard: CheckPromptGuard
  /** `docker restart` of the test container (Check 28's reboot). */
  restartContainer(): Promise<void>
  /** The host-side token scan over the results dir (Check 29a). */
  hostScan(): ScanReport
  hostBefore: HostSnapshot
  hostNow(): Promise<HostSnapshot>
  /** Remove the test container (the Teardown row); returns false when it could not. */
  removeContainer(): Promise<boolean>
}
