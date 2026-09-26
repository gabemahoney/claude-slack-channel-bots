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
import type { PersonaLetter } from '../lib/personas.ts'
import type { ScanReport } from '../lib/secrecy-scan.ts'
import type { Clock } from '../lib/wait.ts'

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

/** Values one check leaves for a later one. */
export interface SharedState {
  /** Part 1.2: did the human have a DM with C before the run? */
  cDmBeforeRun?: boolean
  aDm?: string
  bDm?: string
  cDm?: string
  /** Check 25 step 1: the A, B and C instance IDs. */
  rowsAtCheck25?: string[]
  /** Check 24 setup: the original session_restart_delay (JSON), for the teardown. */
  origDelay?: string
  /** The installed package version and the tarball it came from. */
  packageVersion?: string
  /** The personas brought up in this run (Check 1: A, B, C; Check 25: D), for Check 29a's transcripts. */
  broughtUp?: PersonaLetter[]
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
  shared: SharedState
  /** `docker restart` of the test container (Check 28's reboot). */
  restartContainer(): Promise<void>
  /** The host-side token scan over the results dir (Check 29a). */
  hostScan(): ScanReport
  hostBefore: HostSnapshot
  hostNow(): Promise<HostSnapshot>
  /** Remove the test container (the Teardown row); returns false when it could not. */
  removeContainer(): Promise<boolean>
}
