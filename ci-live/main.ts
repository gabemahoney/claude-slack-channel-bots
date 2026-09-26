/**
 * main.ts — /ci-live's orchestration (see run.ts for the command line).
 *
 * Not a pure module: it wires the real file system, network, docker and
 * browser into the stages and checks. Unit tests import the modules under
 * lib/, provision/, checks/ and dry-run/ instead (never this one or
 * runtime/, which reach playwright-core).
 *
 * A run: the first stdout line names the results dir (`RESULTS_DIR=…`) →
 * the run lock (one real-mode command, and one dry run, at a time) →
 * preconditions → host snapshot → leftover containers removed (never one a
 * live run owns) → provisioning (real Slack, or the local stub in a dry run)
 * → the test human's session → pack, build, start the container → the plan's
 * checks in order → Teardown and HOST → results (verdict.txt, results.json,
 * results.md, run.log, container.log, container-logs/) → the closing secrecy
 * scan of every output. A failure of the session, image build or container
 * start is a FAIL row: HOST, the scan and the results still happen.
 *
 * Before the container is removed or stopped, on every path (Teardown, a
 * failed container start, the cleanup after a signal or the memory
 * watchdog's stop, --keep-container included), each persona's tmux pane
 * (first, while its session lives), the container's own logs (CSCB's
 * server.log and rotated generations, startup-errors.log, cron.log and
 * permission trail, the boot start's boot-start.log, agent-director's
 * errors.log and ad-trail.jsonl) and each persona's Claude transcript tail
 * are copied, redacted (a pane and a transcript also across Claude Code's
 * own hard wraps, which `tmux capture-pane -J` does not join), capped and
 * cut to whole lines, into container-logs/ (lib/container-logs.ts), once
 * per run. The closing scan covers them; a
 * failure to copy is logged and changes no verdict. A memory watchdog stop
 * waits for the copy only briefly.
 *
 * `mailbox --latest` and `mailbox --forwarding` are separate: they take no
 * lock, make no results dir and write no run.log; they only read the test
 * mailbox (rewriting mailbox.json when mail.tm wants a fresh token) and print
 * one message's sender, subject and any confirmation code it holds: the
 * newest message, or the newest Gmail forwarding confirmation with its
 * confirm link. `config-token --rotate` and `apps --list|--delete-strays`
 * (maintenance.ts) take the real lock but make no results dir either.
 *
 * A run (and `--provision-only`) runs the memory watchdog
 * (lib/memory-watchdog.ts) from its start to its end: a `watchdog:` line in
 * run.log every 30 s, the peaks at the end (run.log, results.json,
 * results.md).
 *
 * SIGINT, SIGTERM and SIGHUP (a killed tmux session) all stop the run the
 * same way: no new container is started, the test container is removed
 * (unless --keep-container), D's credentials go back to the staging dir, the
 * browser closes, the results so far are written with a FAIL row
 * "runner: interrupted by <signal>" and a run note saying what the cleanup
 * actually did, the lock is released, and the process exits 1. A second
 * signal while that runs is ignored. The memory watchdog stops a run the same
 * way when the host's working set or Chrome's PSS crosses its limit, with the
 * FAIL row "memory watchdog: <what crossed, the value and the limit>", but
 * it closes Chrome at once, alongside the copy of the container's logs and
 * the container's removal (never after it, and without waiting for a driver
 * or a sign-in), waits for that copy at most CONTAINER_LOGS_URGENT_WAIT_MS,
 * and with --keep-container it stops the container (`docker stop`: its
 * memory freed, kept for inspection) instead of leaving it running.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { CheckContext, HostCredentials, LiveIds, SecondUser } from './checks/context.ts'
import { DRY_RUN_IDS, liveIdsFrom } from './checks/context.ts'
import { fail, pass, runChecks, verdictOf, type CheckRef, type Need, type RecordedResult } from './checks/framework.ts'
import { FINAL_CHECKS, PLAN_CHECKS } from './checks/list.ts'
import { containerPromptGuardDeps, PromptGuard, type PromptGuardTarget } from './checks/prompt-guard.ts'
import { personaEntry } from './lib/apps-state.ts'
import { parseArgs, UsageError, USAGE, type RunOptions } from './lib/args.ts'
import type { BrowserDriver, BrowserStats } from './lib/browser-types.ts'
import type { ContainerExec } from './lib/container.ts'
import {
  claudeProjectSlug,
  CONTAINER_CLAUDE_PROJECTS_DIR,
  CONTAINER_CSCB_LIVE_DIR,
  CONTAINER_LOG_MAX_BYTES,
  CONTAINER_LOGS_DIR,
  CONTAINER_LOGS_INDEX,
  CONTAINER_LOGS_URGENT_WAIT_MS,
  CONTAINER_LOGS_WAIT_MS,
  ContainerLogCollector,
  containerLogsSink,
  describeLogOutcome,
  DRY_RUN_CONTAINER_LOG_MAX_BYTES,
  PANE_HISTORY_LINES,
  PERSONA_CAPTURES,
  TRANSCRIPT_TAIL_LINES,
  type LogOutcome,
  type PersonaCapture,
} from './lib/container-logs.ts'
import { claudeEnvProblem, CONTAINER_CREDENTIALS_DIR, describeContainerEnd, type ContainerEnd, type ContainerStats } from './lib/docker.ts'
import { describeError, EXIT_FAIL, EXIT_NOT_RUNNABLE, EXIT_PASS } from './lib/errors.ts'
import { describeSnapshot, procListener, snapshotHost, type HostSnapshot } from './lib/host-state.ts'
import { HumanSession } from './lib/human-session.ts'
import { CONTAINER_STATE_DIR } from './lib/live-config.ts'
import { createProcessRunLog, type RunLog } from './lib/log.ts'
import {
  addressForms,
  describeForwardingMessage,
  describeLatestMessage,
  extractGmailConfirmLink,
  extractGmailForwardingCode,
  MailboxError,
  MailTmClient,
  selectForwardingMessage,
} from './lib/mailbox.ts'
import { MemoryWatchdog, readHostCgroup } from './lib/memory-watchdog.ts'
import { dryRunLockFile, hostCredentialsFile, livePathsIn, mountedCredentialsFile, realRunLockFile, resolveConfigDir } from './lib/paths.ts'
import { APP_TOKEN_NAME } from './lib/personas.ts'
import { bunSpawn, minimalChildEnv } from './lib/proc.ts'
import { chromeTreePss } from './lib/proc-tree.ts'
import { countTokenShaped, REDACTED_SECRET, REDACTED_TOKEN, Redactor } from './lib/redact.ts'
import { writeResults, type RunSummary } from './lib/results.ts'
import { isLiveRunnerPid, lockHolder, nodeLockDeps, RunLock } from './lib/run-lock.ts'
import { describeScan, scanOutputs, scanText } from './lib/secrecy-scan.ts'
import { isInside, nodeSecureFs, NotRunnableError, SecretStore, SignInCodeNeededError } from './lib/secrets.ts'
import { realClock } from './lib/wait.ts'
import { REAL_LOCK_WHAT, runMaintenance } from './maintenance.ts'
import { appsStateForStrayDeletion, classifyListedApps, deleteStrayApps, testWorkspaceName } from './provision/app-listing.ts'
import { allValid, runProvisioning, type ProvisionReport } from './provision/index.ts'
import { ContainerRun, type Packed } from './runtime/container-run.ts'
import { openWorkspace, type Workspace } from './runtime/workspace.ts'

/** The repository root (ci-live's parent). */
export const REPO_ROOT = resolve(dirname(import.meta.path), '..')

/**
 * How long a signal's cleanup may take (the container's logs copied out, a
 * `docker run` in flight, then `docker rm -f`) before the process exits
 * anyway: the copy's wait comes on top of the removal's 200 s.
 */
const SIGNAL_CLEANUP_MS = 200_000 + CONTAINER_LOGS_WAIT_MS

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

interface RunEnv {
  options: RunOptions
  runId: string
  redactor: Redactor
  log: RunLog
  resultsDir: string
}

function makeResultsDir(runId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cscb-ci-live-${runId}-`))
  chmodSync(dir, 0o700)
  return dir
}

function writeVerdict(env: RunEnv, verdict: string): void {
  writeFileSync(join(env.resultsDir, 'verdict.txt'), `${env.redactor.redact(verdict)}\n`, { mode: 0o600 })
}

function hasVerdict(env: RunEnv): boolean {
  try {
    return readFileSync(join(env.resultsDir, 'verdict.txt'), 'utf-8').trim() !== ''
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Signals and the run lock
// ---------------------------------------------------------------------------

/** Why a run is stopped from outside its own flow: a signal, or the memory watchdog. */
interface StopCause {
  /** What the log lines name: the signal, or `memory watchdog`. */
  label: string
  /** The FAIL row the results get (the verdict is `FAIL: <rowId>: <reason>`). */
  rowId: string
  rowTitle: string
  reason: string
  /** What stopped the run: the run note's start (what the cleanup actually did follows it). */
  noteHead: string
  /**
   * The memory watchdog's stop: Chrome is closed at once, alongside the
   * container's removal, and a kept container (--keep-container) is stopped
   * with `docker stop` rather than left running.
   */
  memory: boolean
}

function signalStop(signal: string): StopCause {
  return {
    label: signal,
    rowId: 'runner',
    rowTitle: 'The run was interrupted',
    reason: `interrupted by ${signal}`,
    noteHead: `interrupted by ${signal}`,
    memory: false,
  }
}

/** The watchdog's stop: its verdict is `FAIL: memory watchdog: <what crossed, the value and the limit>`. */
function watchdogStop(reason: string): StopCause {
  return {
    label: 'memory watchdog',
    rowId: 'memory watchdog',
    rowTitle: 'The memory watchdog stopped the run',
    reason,
    noteHead: `stopped by the memory watchdog (${reason})`,
    memory: true,
  }
}

/** What a stopped run's cleanup got done: the container's end, and whether the browser closed. */
interface CleanupEnd {
  container: ContainerEnd | null
  browserClosed: boolean
}

/** A stopped run's note: what stopped it, then what its cleanup actually did. */
function stopNote(cause: StopCause, ended: CleanupEnd, containerName: string): string {
  const browser = ended.browserClosed ? (cause.memory ? 'Chrome was closed at once' : 'the browser was closed') : 'the browser may still be open (its close did not finish)'
  return `${cause.noteHead}; ${describeContainerEnd(ended.container, containerName)}; ${browser}; the results so far written`
}

/** What the running command has started, for a signal (or the watchdog) to stop. */
interface Interruptible {
  /** Called first: from here on the command leaves writing the results to `finishInterrupted`. */
  interrupted?(cause: StopCause): void
  /** Stop and undo what the command started (container, D's file, browser), as `cause` asks. */
  cleanup(cause: StopCause): Promise<void>
  /** Write the results so far, with the stop as a FAIL row. */
  finishInterrupted?(cause: StopCause): void
}

interface SignalControl {
  setActive(active: Interruptible | null): void
  setLock(lock: RunLock | null): void
  /** Stop the run the way a signal does (the memory watchdog's abort). */
  abort(cause: StopCause): void
  /** When a stop is being handled, never resolves (the handler exits the process); otherwise resolves at once. */
  waitIfStopping(): Promise<void>
  dispose(): void
}

function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cleanup did not finish within ${Math.round(ms / 1000)} s`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** What a stop is about to do, for its first log line. */
function stopActions(cause: StopCause, keep: boolean): string {
  if (cause.memory) return `closing Chrome at once, ${keep ? 'stopping the kept test container (docker stop)' : 'removing the test container'}`
  return `${keep ? 'keeping the test container (--keep-container)' : 'removing the test container'}, closing the browser`
}

function installSignalHandlers(env: RunEnv): SignalControl {
  let active: Interruptible | null = null
  let lock: RunLock | null = null
  let stopping = false
  /** Stop the run: clean up, write the results so far with the cause's FAIL row, release the lock, exit 1. Once. */
  const stopRun = (cause: StopCause): void => {
    if (stopping) {
      env.log.error(`${cause.label}: already stopping; the cleanup is still running`)
      return
    }
    stopping = true
    // The command's own flow may still run on (and clear `active`): act on what was active now.
    const current = active
    current?.interrupted?.(cause)
    void (async () => {
      env.log.error(`${cause.label}: stopping the run: ${stopActions(cause, env.options.keepContainer)}`)
      try {
        if (current) await withDeadline(current.cleanup(cause), SIGNAL_CLEANUP_MS)
      } catch (err) {
        env.log.error(`cleanup after ${cause.label}: ${describeError(err)}`)
      }
      try {
        current?.finishInterrupted?.(cause)
      } catch (err) {
        env.log.error(`writing the results after ${cause.label}: ${describeError(err)}`)
      }
      if (!hasVerdict(env)) writeVerdict(env, `FAIL: ${cause.rowId}: ${cause.reason}`)
      lock?.release()
      env.log.error(`${cause.label}: stopped; results in ${env.resultsDir}`)
      process.exit(EXIT_FAIL)
    })()
  }
  const handler = (signal: NodeJS.Signals): void => stopRun(signalStop(signal))
  for (const signal of STOP_SIGNALS) process.on(signal, handler)
  return {
    setActive: (a) => {
      active = a
    },
    setLock: (l) => {
      lock = l
    },
    abort: stopRun,
    waitIfStopping: () => (stopping ? new Promise<void>(() => {}) : Promise.resolve()),
    dispose: () => {
      for (const signal of STOP_SIGNALS) process.off(signal, handler)
    },
  }
}

/** The lock of this command's mode: the config dir's for real-mode commands, the temp dir's for a dry run. */
function acquireRunLock(env: RunEnv): RunLock {
  const uid = process.getuid?.() ?? 0
  const warn = (warning: string): void => env.log.info(warning)
  if (env.options.dryRun) return RunLock.acquire(dryRunLockFile(tmpdir(), uid), '/ci-live dry run', nodeLockDeps, warn)
  const configDir = resolveConfigDir(process.env, homedir())
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  return RunLock.acquire(realRunLockFile(configDir), REAL_LOCK_WHAT, nodeLockDeps, warn)
}

// ---------------------------------------------------------------------------
// The memory watchdog
// ---------------------------------------------------------------------------

/**
 * Start the run's memory watchdog: the host cgroup, the test container
 * (when running), Chrome's process tree PSS (the runner's descendants) with
 * the browser's contexts and pages, and the runner's own RSS. Crossing a limit
 * stops the run the way a signal does.
 */
function startWatchdog(
  env: RunEnv,
  signals: SignalControl,
  sources: { container: () => Promise<ContainerStats | null>; browserStats: () => BrowserStats | null },
): MemoryWatchdog {
  const watchdog = new MemoryWatchdog({
    sources: {
      host: () => readHostCgroup(),
      container: sources.container,
      chrome: () => ({ ...chromeTreePss(process.pid), browser: sources.browserStats() }),
      runnerRssBytes: () => process.memoryUsage().rss,
    },
    log: env.log,
    onAbort: (reason) => signals.abort(watchdogStop(reason)),
  })
  watchdog.start()
  return watchdog
}

/**
 * Stop the watchdog and log its peaks; the report. The caller has awaited
 * `watchdog.stop()` first, so no sample's line comes after the peaks.
 */
function stopWatchdog(env: RunEnv, watchdog: MemoryWatchdog): ReturnType<MemoryWatchdog['report']> {
  void watchdog.stop()
  const report = watchdog.report()
  for (const line of report.lines) env.log.info(`watchdog peaks: ${line}`)
  return report
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function provision(env: RunEnv, ws: Workspace): Promise<ProvisionReport> {
  return runProvisioning(
    {
      store: ws.store,
      appsFile: ws.appsFile,
      bots: ws.bots,
      callManifest: ws.callManifest,
      manifestFor: ws.manifestFor,
      browser: () => ws.browser(),
      log: env.log,
      // Unique per run, so Check 28's revoke-by-name never meets two tokens of one name.
      appTokenName: `${APP_TOKEN_NAME}-${env.runId}`,
      requireAppsJsonToCreate: !env.options.dryRun && env.options.createApps !== true,
      // Read only for an unfinished create (apps.json's pending_create).
      listApps: async () => (await ws.browser()).listApps(),
    },
    env.options.stage,
  )
}

/**
 * Dry run only: the test human's sign-in asked for an emailed code, and the
 * run read it from the stub mailbox (the seeded stale token refreshed after a
 * 401 and mailbox.json rewritten mode 600, a 429 backed off; the recipient
 * read from the message source's headers, since the stub's mail.tm lists
 * only the mailbox as `to`; the older code, the decoy sent to another
 * account of the same inbox and the look-alike from a non-Slack domain left
 * alone) and typed it. The prompt refused that first code and a newer one
 * came: the run typed the newer one into the cleared field, not taking the
 * refusal still shown for the first as the answer, and was signed in. Then
 * the mailbox's Gmail forwarding confirmation, selected past the newer mail
 * as `mailbox --forwarding` selects it, gives its number and its confirm
 * link (not its cancel link).
 */
async function dryRunMailboxSelfTest(ws: Workspace): Promise<string[]> {
  const stub = ws.stub
  if (!stub) return []
  const w = stub.workspace
  const box = w.mailbox
  if (w.codeCounts.accepted < 1) throw new Error('dry-run mailbox self-test: the emailed sign-in code was not answered from the mailbox')
  if (w.codeCounts.superseded < 1) throw new Error('dry-run mailbox self-test: the prompt never refused a right code, so no refused-then-accepted sign-in was proven')
  if (w.codeCounts.refused > 0) {
    throw new Error('dry-run mailbox self-test: a code the run should have skipped (an older one, the decoy sent to another address, the look-alike) was typed')
  }
  if (w.decoyMailIds.length < 1 || !w.decoyMailIds.every((id) => box.sourcesRead.includes(id))) {
    throw new Error("dry-run mailbox self-test: the decoy code sent to another address was not checked against its source's recipient headers")
  }
  if (box.counts.unauthorized < 1 || box.counts.tokensIssued < 1) throw new Error('dry-run mailbox self-test: the stale token was not refreshed')
  if (box.counts.rateLimited < 1) throw new Error('dry-run mailbox self-test: no 429 was backed off')
  const st = ws.store.guardedFs().stat(ws.store.paths.mailboxJson)
  const saved = ws.store.readMailbox()
  if (!st || (st.mode & 0o077) !== 0 || !saved?.token || saved.token === box.staleToken) {
    throw new Error('dry-run mailbox self-test: mailbox.json was not rewritten (mode 600) with the fresh token')
  }
  const client = ws.openMailbox()
  if (!client) throw new Error('dry-run mailbox self-test: no mailbox')
  const list = await client.listMessages()
  // `mailbox --forwarding`'s selection: the Slack code mail that came after it is skipped.
  const forwarding = selectForwardingMessage(list)
  if (!forwarding || list[0]?.id === forwarding.id) throw new Error('dry-run mailbox self-test: the Gmail forwarding confirmation was not selected past newer mail')
  const message = await client.getMessage(forwarding.id)
  if (extractGmailForwardingCode(message) !== w.forwardingCode) throw new Error('dry-run mailbox self-test: the Gmail forwarding confirmation gave no code, or the wrong one')
  if (extractGmailConfirmLink(message) !== w.forwardingConfirmLink) throw new Error('dry-run mailbox self-test: the Gmail forwarding confirmation gave no confirm link, or not the confirm link')
  return [
    `sign-in code flow: the stub asked for an emailed code; read from the stub mailbox (stale token refreshed after a 401, mailbox.json rewritten mode 600, a 429 backed off; recipients read from ${box.sourcesRead.length} message sources; the older code, the decoy sent to another address and a look-alike sender skipped); the first code refused, the newer one typed into the cleared field past the stale refusal and accepted`,
    `mailbox: ${list.length} stub messages listed; the Gmail forwarding confirmation selected past newer mail, its number and its confirm link (not the cancel link) extracted`,
  ]
}

/** Dry run only: prove the two flows provisioning does not use (a prompt click, a token revoke) on the fixtures. */
async function dryRunFlowSelfTest(env: RunEnv, ws: Workspace): Promise<string[]> {
  const stub = ws.stub
  if (!stub) return []
  const evidence: string[] = await dryRunMailboxSelfTest(ws)
  const browser = await ws.browser()
  const state = ws.appsFile.load()
  const channel = state.channels['a-home'] as string
  const botUser = state.personas.a?.bot_user_id ?? 'U0'
  const ts = stub.workspace.addPrompt(channel, botUser)
  // Newer messages push the prompt out of the fixture client's rendered window: the flow must scroll up to it.
  const chatter = 25
  stub.workspace.addChatter(channel, botUser, chatter)
  const loadsBefore = stub.client.conversationLoads
  await browser.clickMessageButton(state.team_id ?? '', channel, ts, 'Allow')
  const clicked = stub.workspace.channels.get(channel)?.messages.find((m) => m.ts === ts)?.text === '*Permission* — Allowed'
  if (!clicked) throw new Error('dry-run flow self-test: the button click did not reach the fixture')
  const loads = stub.client.conversationLoads - loadsBefore
  if (stub.client.defaultChannelRedirects < 1 || loads < 2) {
    throw new Error("dry-run flow self-test: the fixture client's first load did not land on its default channel, so the re-open went unproven")
  }
  evidence.push(
    `button flow: the fixture client's first load landed on its default channel and the conversation was opened again (${loads} loads); scrolled up past ${chatter} newer messages; clicked Allow on fixture message ${ts}`,
  )
  const appId = state.personas.b?.app_id as string
  const name = `cscb-live-selftest-${env.runId}`
  const token = await browser.generateAppToken(appId, name)
  if (!token) throw new Error('dry-run flow self-test: no token generated')
  await browser.revokeAppToken(appId, name)
  if (stub.workspace.apps.get(appId)?.appTokens.some((t) => t.name === name)) throw new Error('dry-run flow self-test: the token was not revoked')
  evidence.push(`app-token flow: generated and revoked ${name}`)
  evidence.push(await dryRunStraysSelfTest(env, ws))
  const open = ws.browserStats()
  if (!open || open.contexts !== 1 || open.pages !== 1 || open.idlePages !== open.pages) {
    throw new Error('dry-run flow self-test: the browser is not one context with one page, idle on about:blank, after its flows')
  }
  evidence.push('browser: one Chrome with 1 context and 1 page, back on about:blank after every flow')
  return evidence
}

/**
 * Dry run only: `apps --delete-strays` on the fixture apps list. A stray
 * "CSCB Test B" (not in apps.json) is deleted with apps.manifest.delete; the
 * four recorded apps and the "CSCB Test C" of another workspace (from the
 * unfinished-create seed) are kept.
 */
async function dryRunStraysSelfTest(env: RunEnv, ws: Workspace): Promise<string> {
  const stub = ws.stub
  if (!stub) return ''
  const stray = stub.workspace.createApp(ws.manifestFor('b')).id
  const browser = await ws.browser()
  const classified = classifyListedApps(await browser.listApps(), appsStateForStrayDeletion(ws.appsFile), await testWorkspaceName(browser))
  const outcome = await deleteStrayApps({ callManifest: ws.callManifest, appsFile: ws.appsFile, log: env.log }, classified)
  const recorded = Object.values(ws.appsFile.load().personas).map((p) => p?.app_id)
  const recordedKept = recorded.length === 4 && recorded.every((id) => id !== undefined && stub.workspace.apps.has(id))
  const deleted = outcome.deleted.map((a) => a.id)
  if (deleted.length !== 1 || deleted[0] !== stray || stub.workspace.apps.has(stray) || !recordedKept || outcome.kept.length !== 1) {
    throw new Error('dry-run strays self-test: apps --delete-strays did not delete exactly the stray, keeping the recorded apps and the other workspace\'s')
  }
  return (
    `apps list: ${classified.length} apps read off the fixture apps page (${classified.filter((c) => c.recordedAs).length} in apps.json); ` +
    `the stray ${stray} "CSCB Test B" deleted with apps.manifest.delete; the recorded apps and a "CSCB Test C" of another workspace kept`
  )
}

/**
 * Dry run only: the configuration token's rotation on the stub, twice: forced
 * (as `config-token --rotate` does), then on a manifest call the stub refuses
 * as `token_expired` (rotated and retried). Each time both files must be
 * rewritten, mode 600, with the new pair, and the retried call must go
 * through with the new token.
 */
async function dryRunRotationSelfTest(ws: Workspace): Promise<string> {
  const stub = ws.stub
  if (!stub) return ''
  const fs = ws.store.guardedFs()
  const paths = [ws.store.paths.configTokenFile, ws.store.paths.refreshTokenFile]
  const saved = (): { token: string; refreshToken: string | null; private: boolean } => {
    const tokens = ws.store.readConfigTokens()
    return { ...tokens, private: paths.every((p) => ((fs.stat(p)?.mode ?? 0o777) & 0o777) === 0o600) }
  }
  const before = saved()
  await ws.configTokens.rotateNow()
  const forced = saved()
  stub.workspace.expireConfigToken()
  const appId = ws.appsFile.load().personas.a?.app_id ?? ''
  const answer = await ws.callManifest('apps.manifest.export', { app_id: appId })
  const expired = saved()
  const w = stub.workspace
  const rotatedTo = (s: ReturnType<typeof saved>, prev: ReturnType<typeof saved>): boolean =>
    s.private && s.token !== prev.token && s.refreshToken !== prev.refreshToken
  if (!rotatedTo(forced, before) || !rotatedTo(expired, forced) || expired.token !== w.configToken || expired.refreshToken !== w.refreshToken) {
    throw new Error('dry-run rotation self-test: a rotation did not rewrite both token files (mode 600) with the new pair')
  }
  if (!answer.ok || w.calls.get('tooling.tokens.rotate') !== 2) throw new Error('dry-run rotation self-test: the call refused as token_expired was not rotated and retried')
  return 'config token: rotated twice on the stub, forced (as config-token --rotate does) and on a token_expired manifest call (retried with the new token); both files rewritten mode 600 each time'
}

/**
 * Dry run only: the app "CSCB Test C" that a create made before its run
 * stopped (apps.json keeps only the pending-create intent), and a same-named
 * app of another workspace. Provisioning must adopt the first from the apps
 * list, leave the second alone, and create no second "CSCB Test C".
 */
function seedDryRunUnfinishedCreate(ws: Workspace): { made: string; foreign: string } | null {
  const stub = ws.stub
  if (!stub) return null
  const made = stub.workspace.createApp(ws.manifestFor('c')).id
  const foreign = stub.workspace.createApp(ws.manifestFor('c'), { foreign: true }).id
  ws.appsFile.save({ version: 1, personas: { c: { pending_create: { started_at: new Date(Date.now() - 60_000).toISOString() } } }, channels: {} })
  return { made, foreign }
}

function dryRunAdoptionEvidence(ws: Workspace, report: ProvisionReport, seeded: { made: string; foreign: string }): string {
  const c = report.apps?.find((o) => o.letter === 'c')
  const creates = ws.stub?.workspace.calls.get('apps.manifest.create') ?? 0
  if (c?.action !== 'adopted' || c.appId !== seeded.made) throw new Error('dry-run unfinished-create self-test: provisioning did not adopt the app the unfinished create made')
  if (creates !== 3) throw new Error(`dry-run unfinished-create self-test: ${creates} apps were created, not the other 3`)
  if (ws.appsFile.load().personas.c?.pending_create) throw new Error('dry-run unfinished-create self-test: the intent is still in apps.json')
  return (
    `unfinished create: apps.json held only the intent for CSCB Test C; of the two such apps on the apps list, ${seeded.made} (the test workspace's) was adopted ` +
    `and ${seeded.foreign} (another workspace's) left alone; the other 3 apps were created`
  )
}

/** Dry run only: what `seedDryRunContainerLogs` planted, for `dryRunContainerLogsCheck`. */
interface ContainerLogsSeed {
  /** A fixture value registered with the redactor (not token-shaped), planted in server.log, the permission trail, A's pane and A's transcript. */
  secret: string
  /** server.log.1's unterminated last line (as a line mid-write): it holds the first half of `secret`, which no redactor knows. */
  unterminated: string
  /** A's planted transcript (its path in the container), and its unterminated last line, which holds the first half of `secret` too. */
  transcript: { path: string; unterminated: string }
  /** What A's pane shows hard-wrapped, as Claude Code wraps a long line itself (`dryPaneWrappedRows`). */
  wrapped: DryWrapped
}

/** A token-shaped fixture no redactor knows, and a registered fixture value (not token-shaped), each shown split across rows in A's pane. */
interface DryWrapped {
  token: string
  secret: string
}

/** The fixture line every planted server log holds. */
const DRY_LOG_MARKER = '[slack] dry-run fixture: the container-logs self-test'

/** server.log.1's whole line: all its copy may hold. */
const DRY_ROTATED_LINE = `${DRY_LOG_MARKER} (a rotated generation)\n`

/** cron.log's fixture: numbered 50-byte lines, 1,100,000 bytes in all, so the dry run's 1 MiB cap cuts it inside a line. */
const DRY_CRON_LINES = 22_000
const DRY_CRON_LINE_BYTES = 50

function dryCronLine(n: number): string {
  return `dry-run fixture cron.log line ${String(n).padStart(9, '0')} .........`
}

/** The persona whose pane and transcript the dry run plants (A); B, C and D get none, so theirs are noted as not there. */
const DRY_SESSION = PERSONA_CAPTURES[0] as PersonaCapture

/** The pane fixture's first line. */
const DRY_PANE_MARKER = 'dry-run fixture: the tmux pane of the container-logs self-test'

/** The fixture pane's width, and the padding before the secret on one of its lines: the pane wraps that line inside the secret. */
const DRY_PANE_WIDTH = 80
const DRY_PANE_PAD = 'x'.repeat(60)

/** The pane fixture's last line: the fixture session is ready once its pane shows it. */
const DRY_PANE_END = '(fixture) end of the tmux pane of the container-logs self-test'

/**
 * A's pane rows that split the token and the secret as Claude Code's hard
 * wrap does: a line break, then indentation (spaces, `  ⎿  `) or a `│ `
 * border. Once in the middle of each, once inside the token's prefix and
 * once before the secret's last 6 characters (a piece too short to be a
 * fragment by itself). `masked`: each row as the copy must show it, every
 * piece masked. Each row is shorter than the pane, so tmux wraps none of them
 * (a row after a split token starts with `(`, not a token character).
 */
function dryPaneWrappedRows(w: DryWrapped): { raw: string[]; masked: string[]; pieces: string[] } {
  const { token: t, secret: s } = w
  const rows: Array<[string, string, boolean]> = [
    ['(fixture) hard-wrapped token: ', t.slice(0, 25), false],
    ['      ', t.slice(25), false],
    ['│ (fixture) hard-wrapped secret: ', s.slice(0, 25), true],
    ['│ ', s.slice(25), true],
    ['(fixture) a token wrapped inside its prefix: ', t.slice(0, 2), false],
    ['│ ', t.slice(2), false],
    ['(fixture) short tail: ', s.slice(0, -6), true],
    ['  ⎿  ', s.slice(-6), true],
  ]
  return {
    raw: [...rows.map(([lead, piece]) => `${lead}${piece}`), DRY_PANE_END],
    masked: [...rows.map(([lead, , secret]) => `${lead}${secret ? REDACTED_SECRET : REDACTED_TOKEN}`), DRY_PANE_END],
    pieces: rows.map(([, piece]) => piece),
  }
}

/** A's planted transcript: this many whole lines (the copy keeps the last TRANSCRIPT_TAIL_LINES), then an unterminated one. */
const DRY_TRANSCRIPT_LINES = 250

/** What each transcript that must not be picked holds (an older one, a subagent's, the parent working directory's). */
const DRY_TRANSCRIPT_DECOY = 'dry-run fixture: not the persona transcript to copy'

/** Line `n` of A's planted transcript; the last one holds `extra`. */
function dryTranscriptLine(n: number, extra = ''): string {
  return JSON.stringify({ type: 'fixture', n, cwd: DRY_SESSION.workingDirectory, ...(extra ? { message: extra } : {}) })
}

/**
 * Plants, in the container, A's tmux session and transcripts; the planted
 * transcript's path and its unterminated last line.
 *
 * - The session `slack_bot_persona_a`, 80 columns wide, shows a marker line,
 *   the secret, a line padded so the pane wraps it inside the secret, a
 *   token-shaped string, then the token and the secret of `wrapped` split
 *   across rows as Claude Code hard-wraps a long line (`dryPaneWrappedRows`).
 * - A's project dir holds the transcript to copy (DRY_TRANSCRIPT_LINES whole
 *   lines, the secret and the token-shaped string in the last, then an
 *   unterminated line holding the secret's first half), modified 10 minutes
 *   ago; beside it an older transcript, a newer one in a subagent's
 *   subdirectory and a symlink named `*.jsonl` to a decoy transcript outside
 *   it, which is newer (touched now, and checked: `-nt` follows a symlink,
 *   so a target older than the transcript to copy would prove nothing). The
 *   parent working directory's project dir (`~/cscb-live`, whose slug A's
 *   starts with) holds a newer one.
 */
async function seedDryRunSessions(tc: ContainerExec, secret: string, tokenShaped: string, wrapped: DryWrapped): Promise<ContainerLogsSeed['transcript']> {
  const dir = DRY_SESSION.transcriptDir
  const parentDir = `${CONTAINER_CLAUDE_PROJECTS_DIR}/${claudeProjectSlug(CONTAINER_CSCB_LIVE_DIR)}`
  const name = `${randomUUID()}.jsonl`
  const subagent = `${dir}/${randomUUID()}/subagents/agent-fixture.jsonl`
  const linkTarget = `${CONTAINER_CSCB_LIVE_DIR}/dry-run-symlinked-transcript.jsonl`
  const decoys = [`${dir}/older-${name}`, subagent, `${parentDir}/${name}`, linkTarget]
  const panePath = `${CONTAINER_CSCB_LIVE_DIR}/dry-run-pane-fixture.txt`
  const made = await tc.exec(['bash', '-c', 'mkdir -p -- "$@"', 'mkdir', dir, dirname(subagent), parentDir])
  if (made.code !== 0) throw new Error(`the transcripts' fixture dirs could not be made (exit ${made.code})`)
  const unterminated = `{"type":"fixture-mid-write","message":"${secret.slice(0, Math.ceil(secret.length / 2))}`
  const lines = Array.from({ length: DRY_TRANSCRIPT_LINES }, (_, i) =>
    dryTranscriptLine(i + 1, i + 1 === DRY_TRANSCRIPT_LINES ? `fixture secret: ${secret}; fixture token-shaped text: ${tokenShaped}` : ''),
  )
  await tc.writeFile(`${dir}/${name}`, `${lines.join('\n')}\n${unterminated}`, '600')
  for (const decoy of decoys) await tc.writeFile(decoy, `${JSON.stringify({ type: 'fixture', message: DRY_TRANSCRIPT_DECOY })}\n`, '600')
  const pane = [DRY_PANE_MARKER, `fixture secret: ${secret}`, `${DRY_PANE_PAD}${secret}`, `fixture token-shaped text: ${tokenShaped}`, ...dryPaneWrappedRows(wrapped).raw]
  await tc.writeFile(panePath, `${pane.join('\n')}\n`, '600')
  const r = await tc.exec([
    'bash',
    '-c',
    [
      'set -e',
      'touch -d "10 minutes ago" -- "$1"; touch -d "1 hour ago" -- "$2"; touch -- "$3"',
      'ln -s -- "$3" "$4"',
      // -nt follows the symlink: its target must be newer than the transcript to copy, or skipping the symlink proves nothing.
      '[ "$4" -nt "$1" ] || exit 3',
      'tmux new-session -d -s "$5" -x "$6" -y 24 bash -c \'cat -- "$1"; exec sleep infinity\' pane-fixture "$7"',
      'for i in $(seq 1 50); do if tmux capture-pane -p -t "$5" | grep -qF -- "$8"; then exit 0; fi; sleep 0.1; done',
      'exit 1',
    ].join('\n'),
    'seed-sessions',
    `${dir}/${name}`,
    decoys[0] as string,
    linkTarget,
    `${dir}/link-to-newer-transcript.jsonl`,
    DRY_SESSION.session,
    String(DRY_PANE_WIDTH),
    panePath,
    DRY_PANE_END,
  ])
  if (r.code === 3) throw new Error('the symlinked decoy transcript is not newer than the one to copy: skipping it would prove nothing')
  if (r.code !== 0) throw new Error(`the fixture tmux session and transcript times could not be planted (exit ${r.code})`)
  return { path: `${dir}/${name}`, unterminated }
}

/**
 * Dry run only, after the plan's checks (S2 and 29a have read the state dir)
 * and before Teardown copies the container's logs: a server.log holding a
 * registered fixture secret and a token-shaped string, a rotated
 * server.log.1 ending in an unterminated line that holds the first half of
 * the secret, a server.log.2 that is a symlink to A's credentials file, a
 * permission trail holding the secret, and a cron.log over the dry run's cap.
 * startup-errors.log stays missing. Then A's tmux session and transcripts
 * (`seedDryRunSessions`), its pane also showing a second token-shaped string
 * and a second registered value hard-wrapped.
 */
async function seedDryRunContainerLogs(tc: ContainerExec, redactor: Redactor): Promise<ContainerLogsSeed> {
  const secret = `dry-run-log-secret-${randomUUID()}`
  redactor.addSecret(secret)
  const tokenShaped = `${['xox', 'b-'].join('')}1234567890-1234567890-${'B'.repeat(24)}`
  const wrapped: DryWrapped = { token: `${['xox', 'b-'].join('')}2345678901-2345678901-${'C'.repeat(24)}`, secret: `dry-run-wrap-${randomUUID()}` }
  redactor.addSecret(wrapped.secret)
  const unterminated = `fixture line mid-write: ${secret.slice(0, Math.ceil(secret.length / 2))}`
  const s = CONTAINER_STATE_DIR
  await tc.writeFile(`${s}/server.log`, `${DRY_LOG_MARKER}\nfixture secret: ${secret}\nfixture token-shaped text: ${tokenShaped}\n`, '600')
  await tc.writeFile(`${s}/server.log.1`, `${DRY_ROTATED_LINE}${unterminated}`, '600')
  await tc.writeFile(`${s}/permission-trail.jsonl`, `${JSON.stringify({ fixture: 'dry-run', raw_error_message: `refused: ${secret}` })}\n`, '600')
  const r = await tc.exec([
    'bash',
    '-c',
    'set -e; ln -s "$1" "$2"; seq -f "dry-run fixture cron.log line %09.0f ........." 1 "$3" > "$4"',
    'seed',
    `${CONTAINER_CREDENTIALS_DIR}/persona_a-credentials.json`,
    `${s}/server.log.2`,
    String(DRY_CRON_LINES),
    `${s}/cron.log`,
  ])
  if (r.code !== 0) throw new Error(`the symlinked server.log.2 and the oversized cron.log could not be planted (exit ${r.code})`)
  return { secret, unterminated, wrapped, transcript: await seedDryRunSessions(tc, secret, tokenShaped, wrapped) }
}

/**
 * Dry run only: A's pane and transcript tail in Teardown's copy; the
 * evidence. The pane: captured, the line tmux wrapped at the pane's width
 * inside the secret joined into one line by -J and the secret masked there
 * too (no half of it left), the token-shaped text masked, and the rows that
 * split the second token and the second secret as Claude Code's hard wrap
 * does (which -J can't join) each masked, no piece of either left. The
 * transcript: the planted one (not the older one, the subagent's, the
 * symlink or the parent directory's), its last TRANSCRIPT_TAIL_LINES whole
 * lines exactly, the secret and the token-shaped text masked, its
 * unterminated last line left out. B's, C's and D's noted as not there.
 */
function dryRunSessionCopiesEvidence(seed: ContainerLogsSeed, outcomes: readonly LogOutcome[], copy: (name: string) => string, index: string): string[] {
  const outcome = (name: string) => outcomes.find((o) => o.name === name)
  const masked = (text: string): boolean =>
    !text.includes(seed.secret) && !text.includes(seed.secret.slice(0, 20)) && !text.includes(seed.secret.slice(-20)) && text.includes(REDACTED_SECRET) && text.includes(REDACTED_TOKEN) && countTokenShaped(text) === 0
  const pane = copy(DRY_SESSION.paneCopy)
  // -J keeps a row's trailing spaces: the joined line is the padding and the masked secret, then perhaps spaces.
  const rows = pane.split('\n').map((l) => l.trimEnd())
  const joined = rows.includes(`${DRY_PANE_PAD}${REDACTED_SECRET}`)
  if (outcome(DRY_SESSION.paneCopy)?.status !== 'copied' || !pane.includes(DRY_PANE_MARKER) || !masked(pane) || !joined) {
    throw new Error(`${DRY_SESSION.paneCopy} was not captured with its wrapped line joined and the secret and the token-shaped text masked`)
  }
  // Claude Code's own hard wraps, which -J can't join: each piece masked on its row, none left (the 2-character one only by its row).
  const wrapped = dryPaneWrappedRows(seed.wrapped)
  const survivors = wrapped.pieces.filter((piece) => piece.length >= 6 && pane.includes(piece)).length
  if (!rows.join('\n').includes(wrapped.masked.join('\n')) || survivors > 0) {
    throw new Error(`${DRY_SESSION.paneCopy}: the token and the registered value split across rows (a row break, then indentation or a border) were not masked in every piece (${survivors} piece(s) left)`)
  }
  const transcript = copy(DRY_SESSION.transcriptCopy)
  const t = outcome(DRY_SESSION.transcriptCopy)
  const first = DRY_TRANSCRIPT_LINES - TRANSCRIPT_TAIL_LINES + 1
  const lines = transcript.split('\n')
  const tailRight =
    t?.status === 'copied' && t.path === seed.transcript.path && t.older === first - 1 && t.unterminated === Buffer.byteLength(seed.transcript.unterminated) && !t.cut
  if (!tailRight || lines.length !== TRANSCRIPT_TAIL_LINES + 1 || lines[0] !== dryTranscriptLine(first) || lines.at(-1) !== '' || !masked(transcript) || transcript.includes(DRY_TRANSCRIPT_DECOY)) {
    throw new Error(`${DRY_SESSION.transcriptCopy} is not the last ${TRANSCRIPT_TAIL_LINES} whole lines of the planted transcript, masked, without its unterminated last line`)
  }
  const others = PERSONA_CAPTURES.filter((p) => p !== DRY_SESSION)
  const noted = [
    ...[DRY_SESSION.paneCopy, DRY_SESSION.transcriptCopy].map((name) => describeLogOutcome(outcome(name) as LogOutcome)),
    ...others.flatMap((p) => [`${p.paneCopy}: not there (tmux session ${p.session})`, `${p.transcriptCopy}: not there (${p.transcriptDir}/*.jsonl)`]),
  ]
  if (noted.some((n) => !index.includes(n))) throw new Error(`${CONTAINER_LOGS_INDEX} does not note A's pane and transcript tail, and the other personas' as not there`)
  return [
    `${DRY_SESSION.paneCopy}: the fixture tmux session's pane captured (tmux capture-pane -p -J -S -${PANE_HISTORY_LINES}); the line tmux wrapped at the ${DRY_PANE_WIDTH}-column pane's width inside the secret joined by -J and masked whole; the token-shaped text masked`,
    `${DRY_SESSION.paneCopy}: rows split as Claude Code hard-wraps a long line (a row break, then indentation, "│ " or "  ⎿  "), which -J does not join: a token-shaped string split in its middle and inside its prefix, and a registered value split in its middle and before its last 6 characters, each of the ${wrapped.pieces.length} pieces masked on its own row, none of either left`,
    `${DRY_SESSION.transcriptCopy}: of the transcripts in ${DRY_SESSION.transcriptDir}, the newest regular one copied (not an older one, a subagent's, a symlink to a newer one or the parent directory's); its last ${TRANSCRIPT_TAIL_LINES} of ${DRY_TRANSCRIPT_LINES} whole lines, the secret and the token-shaped text masked, its unterminated last line (${Buffer.byteLength(seed.transcript.unterminated)} bytes holding the first half of the secret) left out`,
    `the other ${others.length} personas' panes and transcripts noted as not there; ${CONTAINER_LOGS_INDEX} lists each`,
  ]
}

/**
 * Dry run only: the copy Teardown made before removing the container. Every
 * copy mode 600 in a mode-700 container-logs/; server.log and the trail with
 * the secret and the token-shaped text masked; server.log.1 copied without
 * its unterminated last line; the symlinked server.log.2 skipped, not
 * followed; cron.log cut to its last whole lines within the dry run's cap
 * (the partial line at the cut dropped); startup-errors.log noted as not
 * there; A's pane and transcript tail (`dryRunSessionCopiesEvidence`);
 * index.txt noting each.
 */
function dryRunContainerLogsCheck(env: RunEnv, seed: ContainerLogsSeed | string, collector: ContainerLogCollector, t0: number): RecordedResult {
  const title =
    "Dry run: the container's own logs, a persona's tmux pane and its transcript tail copied into the results before its removal (redacted, capped, whole lines only, a missing file noted, a symlink skipped)"
  try {
    if (typeof seed === 'string') throw new Error(seed)
    const outcomes = collector.outcomes
    if (!outcomes) throw new Error("the container's logs were not copied before its removal")
    const dir = join(env.resultsDir, CONTAINER_LOGS_DIR)
    const mode = (path: string): number => statSync(path).mode & 0o777
    const files = readdirSync(dir).sort()
    if (mode(dir) !== 0o700 || files.some((f) => mode(join(dir, f)) !== 0o600)) throw new Error(`${CONTAINER_LOGS_DIR}/ is not mode 700 with every copy mode 600`)
    const copy = (name: string): string => readFileSync(join(dir, name), 'utf-8')
    const outcome = (name: string) => outcomes.find((o) => o.name === name)
    const server = copy('server.log')
    const trail = copy('permission-trail.jsonl')
    const masked = (text: string): boolean => !text.includes(seed.secret) && text.includes(REDACTED_SECRET) && countTokenShaped(text) === 0
    if (!server.includes(DRY_LOG_MARKER) || !masked(server) || !server.includes(REDACTED_TOKEN) || !masked(trail)) {
      throw new Error('server.log or the permission trail was not copied with the secret and the token-shaped text masked')
    }
    const rotated = outcome('server.log.1')
    if (copy('server.log.1') !== DRY_ROTATED_LINE || rotated?.status !== 'copied' || rotated.unterminated !== Buffer.byteLength(seed.unterminated)) {
      throw new Error('the rotated server.log.1 was not copied without its unterminated last line')
    }
    if (files.includes('server.log.2') || outcome('server.log.2')?.status !== 'skipped') throw new Error('the symlinked server.log.2 was not skipped')
    if (outcome('startup-errors.log')?.status !== 'missing') throw new Error('the missing startup-errors.log was not noted as not there')
    // The cut falls inside a line: the copy starts at the next whole line and keeps every line after it.
    const total = DRY_CRON_LINES * DRY_CRON_LINE_BYTES
    const firstWhole = Math.floor((total - DRY_RUN_CONTAINER_LOG_MAX_BYTES - 1) / DRY_CRON_LINE_BYTES) + 2
    const keptBytes = total - (firstWhole - 1) * DRY_CRON_LINE_BYTES
    const cron = copy('cron.log')
    const cronOutcome = outcome('cron.log')
    const cutRight =
      cronOutcome?.status === 'copied' && cronOutcome.cut && cronOutcome.cap === DRY_RUN_CONTAINER_LOG_MAX_BYTES && cronOutcome.size === total && cronOutcome.kept === keptBytes
    if (!cutRight || cron.length !== keptBytes || !cron.startsWith(`${dryCronLine(firstWhole)}\n`) || !cron.endsWith(`${dryCronLine(DRY_CRON_LINES)}\n`)) {
      throw new Error(`cron.log was not cut to its last whole lines within the dry run's ${DRY_RUN_CONTAINER_LOG_MAX_BYTES}-byte cap`)
    }
    const index = copy(CONTAINER_LOGS_INDEX)
    const noted = ['startup-errors.log: not there', 'cron.log: cut', 'server.log.2: skipped', `server.log.1: copied, ${Buffer.byteLength(DRY_ROTATED_LINE)} bytes; its unterminated last line`]
    if (noted.some((n) => !index.includes(n))) {
      throw new Error(`${CONTAINER_LOGS_INDEX} does not note the cut, the missing and the skipped file, and the unterminated last line left out`)
    }
    const sessions = dryRunSessionCopiesEvidence(seed, outcomes, copy, index)
    return {
      id: 'container-logs',
      title,
      row: null,
      durationMs: Date.now() - t0,
      ...pass([
        `${files.length} files in ${CONTAINER_LOGS_DIR}/ (dir mode 700, files mode 600): ${files.join(', ')}`,
        'server.log and permission-trail.jsonl copied with the planted secret and token-shaped text masked; the symlinked server.log.2 skipped, not followed',
        `server.log.1 copied without its unterminated last line (${Buffer.byteLength(seed.unterminated)} bytes holding the first half of the secret, as a line mid-write)`,
        `cron.log (${total} bytes) cut to its last ${keptBytes} bytes, from line ${firstWhole}, the first whole line within the dry run's ${DRY_RUN_CONTAINER_LOG_MAX_BYTES}-byte cap (a real run's is ${CONTAINER_LOG_MAX_BYTES})`,
        `startup-errors.log noted as not there; ${CONTAINER_LOGS_INDEX} lists every file`,
        ...sessions,
      ]),
    }
  } catch (err) {
    return runnerRow('container-logs', title, `dry-run container-logs self-test: ${describeError(err)}`, t0)
  }
}

/**
 * Dry run only: the prompt guard's target, its clicks going to the stub (the
 * fixture client, signed in by provisioning) and its waits reading the stub's
 * human API. Without them (a sign-in that failed) the guard has no browser,
 * and the self-test fails.
 */
async function dryRunGuardTarget(env: RunEnv, ws: Workspace, tc: ContainerExec, ids: LiveIds): Promise<PromptGuardTarget> {
  try {
    const browser = await ws.browser()
    return { container: tc, clock: realClock, ids, browser, human: new HumanSession(await browser.humanApi(), realClock) }
  } catch (err) {
    env.log.error(`dry run: the prompt guard gets no browser: ${describeError(err)}`)
    return { container: tc, clock: realClock, ids, browser: null, human: null }
  }
}

/** The dry run's prompt: A's, for a command no check expects, as CSCB's section block shows it. */
function dryPromptSection(command: string): string {
  return `🤖🛠️ *Bash*\n\`${command}\``
}

/**
 * Dry run only, after the plan's checks: the prompt guard denies a prompt no
 * check expects. A fixture prompt from A in a-home (the stub's message with
 * Allow and Deny buttons in CSCB's shape) and its `cscb.chat_post.attempted`
 * line in the container's permission trail, posted a minute ago (past the
 * grace), its command holding a registered fixture value. One read of the
 * guard must click Deny on it in the fixture client (the stub's message then
 * shows "Denied by operator"), and record one denial of persona_a's
 * unexpected prompt, with the command redacted, in its report and as a run
 * note.
 */
async function dryRunPromptGuardSelfTest(env: RunEnv, ws: Workspace, tc: ContainerExec, ids: LiveIds, guard: PromptGuard, runNotes: readonly string[]): Promise<RecordedResult> {
  const t0 = Date.now()
  const title = 'Dry run: the prompt guard denies a prompt no check expects (Deny clicked on the stub; a run note and the promptGuard report, the command redacted)'
  try {
    const stub = ws.stub
    if (!stub) throw new Error('no stub')
    const secret = `dry-run-prompt-secret-${randomUUID()}`
    env.redactor.addSecret(secret)
    const command = `env | grep -i -E 'cscb|slack' # ${secret}`
    const token = randomUUID()
    const channel = ids.aHome
    const ts = stub.workspace.addPrompt(channel, ids.bots.a.userId, 'cscb_persona_a', token)
    const line = {
      ts: new Date(Date.now() - 60_000).toISOString(),
      event: 'cscb.chat_post.attempted',
      claude_instance_id: 'cscb_persona_a',
      request_token: token,
      channel,
      text: '🤖🛠️ permission request: Bash',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: dryPromptSection(command) } },
        { type: 'actions', elements: [] },
      ],
      ok: true,
      slack_ts: ts,
    }
    // The guard's own loop may read the line first: a note from then on counts.
    const notesBefore = runNotes.length
    await tc.writeFile(`${CONTAINER_STATE_DIR}/permission-trail.jsonl`, `${JSON.stringify(line)}\n`, '600')
    await guard.tick()
    const denied = stub.workspace.channels.get(channel)?.messages.find((m) => m.ts === ts)?.text === '*Permission* — Denied by operator'
    if (!denied) throw new Error('the stub prompt was not denied (its message does not show "Denied by operator")')
    const report = guard.report()
    const entries = report.entries.filter((e) => e.persona === 'persona_a' && e.why === 'unexpected')
    const entry = entries[0]
    if (report.denied !== 1 || entries.length !== 1 || entry?.how !== 'Deny clicked') {
      throw new Error(`the report does not hold one denial of persona_a's unexpected prompt by a Deny click (denied ${report.denied})`)
    }
    const redacted = (text: string): boolean => text.includes(REDACTED_SECRET) && !text.includes(secret)
    if (!entry.command.startsWith("Bash: env | grep -i -E 'cscb|slack' # ") || !redacted(entry.command)) {
      throw new Error("the report's command is not the prompt's, with the registered value redacted")
    }
    const notes = runNotes.slice(notesBefore).filter((n) => n.startsWith("prompt guard: denied persona_a's unexpected prompt"))
    if (notes.length !== 1 || !redacted(notes[0] as string) || !(notes[0] as string).endsWith('; Deny clicked')) {
      throw new Error('no single run note of the denial, with the command redacted')
    }
    return {
      id: 'prompt-guard',
      title,
      row: null,
      durationMs: Date.now() - t0,
      ...pass([
        `a stub prompt from persona_a in ${channel} (${ts}) and its trail line, posted a minute ago, for a command no check declared`,
        `the guard read it from the container's permission trail and clicked Deny in the fixture client: the stub message shows "Denied by operator"`,
        `report: ${report.seen} seen, ${report.denied} denied (${entry.check}, ${entry.persona}, ${entry.why}: ${entry.command}); one run note, the registered value in the command redacted`,
      ]),
    }
  } catch (err) {
    return runnerRow('prompt-guard', title, `dry-run prompt guard self-test: ${describeError(err)}`, t0)
  }
}

async function runProvisionOnly(env: RunEnv, signals: SignalControl): Promise<number> {
  const ws = openWorkspace({ repoRoot: REPO_ROOT, runId: env.runId, redactor: env.redactor, log: env.log }, env.options.dryRun ? 'dry-run' : 'real')
  const watchdog = startWatchdog(env, signals, { container: async () => null, browserStats: () => ws.browserStats() })
  signals.setActive({
    // ws.close() closes Chrome first, without waiting for a driver or a sign-in in progress.
    cleanup: async () => {
      await Promise.all([watchdog.stop(), ws.close()])
    },
  })
  try {
    const report = await provision(env, ws)
    if (report.validate && !allValid(report.validate)) {
      env.log.error('provisioning finished, but a credentials file failed validation (see the validate lines)')
      return EXIT_FAIL
    }
    env.log.info('provision: done')
    return EXIT_PASS
  } finally {
    signals.setActive(null)
    await watchdog.stop()
    stopWatchdog(env, watchdog)
    await ws.close()
  }
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/** Ask on the terminal without echo; the answer is returned, never shown or logged. */
async function promptHidden(question: string): Promise<string> {
  const r = await bunSpawn(
    ['bash', '-c', 'printf "%s" "$1" > /dev/tty; IFS= read -rs v < /dev/tty; printf "\\n" > /dev/tty; printf "%s" "$v"', 'prompt', question],
    { env: minimalChildEnv(process.env), timeoutMs: 15 * 60_000 },
  )
  if (r.code !== 0) throw new NotRunnableError('no terminal to ask on: run `bun ci-live/run.ts login` in an interactive terminal')
  return r.stdout.trim()
}

/** `login` (the test human) or `login --second` (the second workspace user): sign in, answer an emailed code, save the session. */
async function runLogin(env: RunEnv, signals: SignalControl): Promise<number> {
  const ws = openWorkspace({ repoRoot: REPO_ROOT, runId: env.runId, redactor: env.redactor, log: env.log }, 'real')
  let driver: BrowserDriver | null = null
  signals.setActive({ cleanup: async () => (await driver?.close(), await ws.close()) })
  try {
    const { launchDriver } = await import('./browser/driver.ts')
    const store = ws.store
    const who = env.options.second === true ? 'second' : 'human'
    const second = ws.live.secondUser
    if (who === 'second' && !second) {
      throw new NotRunnableError(`live.json configures no second_user (email and password_file or password_env): add it to ${store.paths.liveJson}`)
    }
    const identity =
      who === 'second' && second
        ? () => ({ email: second.email, password: store.readSecondPassword(second) })
        : () => ({ email: ws.live.testEmail, password: store.readPassword() })
    const account = who === 'second' ? 'the second account' : 'the test human'
    driver = await launchDriver({ urls: ws.urls, domain: ws.live.workspaceDomain, identity, storage: store.storageState(who), redactor: env.redactor, log: env.log })
    let outcome = await driver.ensureSignedIn()
    for (let attempt = 0; outcome === 'needs-code' && attempt < 3; attempt++) {
      const code = await promptHidden(`Slack emailed ${account} a sign-in code. Type it (not shown): `)
      env.redactor.addSecret(code)
      outcome = await driver.submitSignInCode(code)
    }
    if (outcome !== 'signed-in') throw new NotRunnableError('the sign-in code was not accepted')
    await driver.saveState()
    const saved = who === 'second' ? store.paths.secondStorageState : store.paths.storageState
    env.log.info(`login: ${account} signed in; session saved to ${saved} (mode 600)`)
    return EXIT_PASS
  } finally {
    signals.setActive(null)
    await driver?.close()
    await ws.close()
  }
}

// ---------------------------------------------------------------------------
// mailbox --latest | --forwarding
// ---------------------------------------------------------------------------

/**
 * `mailbox --latest [--show-body]`: the test mailbox's newest message — when
 * it came, its sender and subject, and only a confirmation code found in it
 * (Gmail's forwarding code; Slack's sign-in code only with `--show-body`,
 * and without it the subject's code-shaped text masked); the body only with
 * `--show-body`. `mailbox --forwarding [--show-body]`: the same for the
 * newest Gmail forwarding confirmation (newer mail may have come since), plus
 * its confirm link, the one value printed on purpose. Never the mailbox's
 * token or password (both registered with the redactor, which every line
 * goes through), nor the test human's address (registered too, and every
 * other address is masked). Exit 2 when there is no mailbox or no such
 * message.
 */
async function runMailbox(options: RunOptions, redactor: Redactor): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${redactor.redact(line)}\n`)
  }
  const err = (line: string): void => {
    process.stderr.write(`${redactor.redact(line)}\n`)
  }
  const realConfigDir = resolveConfigDir(process.env, homedir())
  const store = new SecretStore({ fs: nodeSecureFs, paths: livePathsIn(realConfigDir), env: process.env, redactor, dryRun: false, realConfigDir })
  try {
    // Mail about the test human (Gmail's forwarding request) names its address, with and without the +tag.
    try {
      for (const form of addressForms(store.readLiveConfig().testEmail)) redactor.addSecret(form)
    } catch {
      /* no usable live.json: the other-address masking still applies */
    }
    const config = store.readMailbox()
    if (!config) {
      err(`not runnable: no mailbox: ${store.paths.mailboxJson} does not exist (the test mailbox's mail.tm account, mode 600)`)
      return EXIT_NOT_RUNNABLE
    }
    const client = new MailTmClient({
      config,
      fetch,
      clock: realClock,
      onSecret: (value) => redactor.addSecret(value),
      save: (next) => store.writeMailbox(next),
    })
    const list = await client.listMessages()
    const forwarding = options.mailboxView === 'forwarding'
    const chosen = forwarding ? selectForwardingMessage(list) : list[0]
    if (!chosen) {
      err(
        forwarding
          ? `not runnable: no Gmail forwarding confirmation (from google.com, subject "Forwarding Confirmation") among the ${list.length} newest messages in the mailbox ${config.address}`
          : `not runnable: no message yet in the mailbox ${config.address}`,
      )
      return EXIT_NOT_RUNNABLE
    }
    const message = await client.getMessage(chosen.id)
    const describe = forwarding ? describeForwardingMessage : describeLatestMessage
    for (const line of describe(message, config.address, options.showBody === true)) out(line)
    return EXIT_PASS
  } catch (e) {
    if (e instanceof NotRunnableError) {
      err(`not runnable: ${e.message}`)
      return EXIT_NOT_RUNNABLE
    }
    if (e instanceof MailboxError && e.kind === 'auth') {
      err(`not runnable: mail.tm refused the mailbox's address and password (${e.message}): check ${store.paths.mailboxJson}`)
      return EXIT_NOT_RUNNABLE
    }
    err(`ERROR: ${describeError(e)}`)
    return EXIT_FAIL
  }
}

// ---------------------------------------------------------------------------
// The full run (real or dry)
// ---------------------------------------------------------------------------

function hostProbe() {
  const env = minimalChildEnv(process.env)
  return {
    run: (argv: readonly string[]) => bunSpawn(argv, { env, timeoutMs: 30_000 }),
    readFile: (path: string) => {
      try {
        return readFileSync(path)
      } catch {
        return null
      }
    },
    listener: procListener,
  }
}

function hostCredentials(ws: Workspace): HostCredentials {
  const store = ws.store
  const paths = store.paths
  return {
    moveDIntoMount() {
      store.move(hostCredentialsFile(paths, 'd'), mountedCredentialsFile(paths, 'd'))
    },
    async rewriteBAppToken(appToken) {
      const current = store.readCredentials('b')
      if (!current) throw new Error("B's credentials file is missing")
      const bot = await ws.bots.checkBotToken(current.bot_token)
      const app = await ws.bots.checkAppToken(appToken)
      if (!bot.ok || !app.ok) throw new Error("B's rewritten credentials would not validate")
      store.writeCredentials('b', { bot_token: current.bot_token, app_token: appToken })
    },
    mountedCount() {
      return store
        .guardedFs()
        .readdir(paths.credentialsDir)
        .filter((f) => f.endsWith('-credentials.json')).length
    },
    bAppTokenName() {
      return ws.appsFile.load().personas.b?.app_token_name ?? APP_TOKEN_NAME
    },
    setBAppTokenName(name) {
      ws.appsFile.update((s) => {
        personaEntry(s, 'b').app_token_name = name
      })
    },
  }
}

/** D's credentials back into the staging dir (after a run, or a crashed one). */
function restoreD(ws: Workspace, log: RunLog): void {
  const paths = ws.store.paths
  const mounted = mountedCredentialsFile(paths, 'd')
  if (ws.store.exists(mounted)) {
    ws.store.move(mounted, hostCredentialsFile(paths, 'd'))
    log.info("credentials: D's file moved back to the staging dir")
  }
}

function restoreDLogged(ws: Workspace, log: RunLog): void {
  try {
    restoreD(ws, log)
  } catch (err) {
    log.error(`could not move D's credentials back: ${describeError(err)}`)
  }
}

/** What a run has produced so far (a signal writes it too). */
interface RunState {
  results: RecordedResult[]
  runNotes: string[]
  packed: Packed | null
  hostName: string
  containerLog: string
  /** The results were written (by the run's end or by a signal). */
  finished: boolean
  /** The stop (a signal, or the memory watchdog) being handled: the run's own end then leaves the results to the handler. */
  interrupted?: string
  /** The run's memory watchdog: stopped, and its peaks recorded, when the results are written. */
  watchdog: MemoryWatchdog | null
  /** The copy of the container's own logs: sealed when the results are written, so the scan sees every copy. */
  containerLogs: ContainerLogCollector | null
  /** The run's prompt guard (from the first plan check to the last): its report goes into the results. */
  promptGuard: PromptGuard | null
}

function runnerRow(id: string, title: string, reason: string, t0: number): RecordedResult {
  return { id, title, row: null, durationMs: Date.now() - t0, ...fail(reason, []) }
}

/** The test human's (and the second user's) session. A second account that needs a sign-in code skips its checks. */
async function openSessions(ws: Workspace, log: RunLog): Promise<{ human: HumanSession; second: SecondUser | null; browser: BrowserDriver; secondSkip: string | null }> {
  const browser = await ws.browser()
  const human = new HumanSession(await browser.humanApi(), realClock)
  let second: SecondUser | null = null
  let secondSkip: string | null = null
  try {
    const sb = await ws.secondBrowser()
    if (sb) {
      const secondHuman = new HumanSession(await sb.humanApi(), realClock)
      second = { human: secondHuman, userId: (await secondHuman.whoami()).userId }
    }
  } catch (err) {
    if (!(err instanceof SignInCodeNeededError && err.who === 'second')) throw err
    secondSkip = 'second account needs a sign-in code: run login --second'
    log.info(`session: ${secondSkip}; Checks 14, 16 and 20 are skipped`)
  }
  return { human, second, browser, secondSkip }
}

async function runFull(env: RunEnv, signals: SignalControl): Promise<number> {
  const dry = env.options.dryRun
  const mode = dry ? 'dry-run' : 'real'
  const container = new ContainerRun(bunSpawn, env.log, env.runId, REPO_ROOT)
  const state: RunState = {
    results: [],
    runNotes: [],
    packed: null,
    hostName: container.name,
    containerLog: '',
    finished: false,
    watchdog: null,
    containerLogs: null,
    promptGuard: null,
  }
  const record = (r: RecordedResult): void => {
    state.results.push(r)
  }

  // Preconditions (exit 2 on any).
  await container.assertDocker()
  container.agentDirectorBinary()
  if (!dry) {
    const problem = claudeEnvProblem(process.env)
    if (problem) throw new NotRunnableError(problem)
  }
  const ws = openWorkspace({ repoRoot: REPO_ROOT, runId: env.runId, redactor: env.redactor, log: env.log }, mode)
  // From here to the results: a watchdog sample every 30 s (in a dry run too, so it is exercised).
  const watchdog = startWatchdog(env, signals, { container: () => container.stats(), browserStats: () => ws.browserStats() })
  state.watchdog = watchdog
  const containerLogs = new ContainerLogCollector({
    redactor: env.redactor,
    sink: containerLogsSink(env.resultsDir),
    log: env.log,
    maxBytes: dry ? DRY_RUN_CONTAINER_LOG_MAX_BYTES : CONTAINER_LOG_MAX_BYTES,
  })
  state.containerLogs = containerLogs
  /**
   * Copy the container's own logs into the results, once, before it is
   * removed or stopped (every removal below awaits this first). A memory
   * watchdog stop waits for it only briefly; a failure is only logged.
   */
  const collectLogs = (urgent = false): Promise<void> => {
    registerStubTokens(env, ws)
    return containerLogs.collect(container.container, urgent ? CONTAINER_LOGS_URGENT_WAIT_MS : CONTAINER_LOGS_WAIT_MS)
  }
  // One cleanup, however many callers (the run's end and a signal): they all wait for the same work, as the first caller's cause asks.
  let cleaning: Promise<void> | null = null
  const ended: CleanupEnd = { container: null, browserClosed: false }
  const closeChrome = async (): Promise<void> => {
    await ws.closeBrowser()
    ended.browserClosed = true
  }
  const cleanup = (cause?: StopCause): Promise<void> =>
    (cleaning ??= (async () => {
      // Settles once a sample in flight has written its line: awaited before the results are written.
      const watchdogStopped = watchdog.stop()
      // No more reads or denials: the container and the browser are going.
      state.promptGuard?.halt()
      try {
        // The memory watchdog's stop closes Chrome at once, alongside the logs' copy and the container's removal, never after them.
        const chromeClosed = cause?.memory === true ? closeChrome() : Promise.resolve()
        // The container's own logs first (a memory stop waits for them only briefly), then its removal or stop.
        await collectLogs(cause?.memory === true)
        ended.container = await container.stopAndRemove(env.options.keepContainer, cause?.memory === true)
        if (!dry) restoreDLogged(ws, env.log)
        await chromeClosed
        await ws.close()
        ended.browserClosed = true
        if (state.packed) rmSync(state.packed.dir, { recursive: true, force: true })
      } finally {
        await watchdogStopped
      }
    })())
  signals.setActive({
    interrupted: (cause) => {
      state.interrupted = cause.label
    },
    cleanup,
    finishInterrupted: (cause) => {
      if (state.finished) return
      state.results.unshift(runnerRow(cause.rowId, cause.rowTitle, cause.reason, Date.now()))
      state.runNotes.push(stopNote(cause, ended, container.name))
      finish(env, ws, state, true)
    },
  })

  try {
    if (!dry && !ws.store.hasPassword() && !ws.store.storageState('human').exists()) {
      throw new NotRunnableError(`no way to sign the test human in: write ${ws.store.paths.passwordFile} (mode 600) or set env CSCB_LIVE_TEST_PASSWORD`)
    }
    const hostBefore: HostSnapshot = await snapshotHost(hostProbe(), homedir())
    env.log.info(`host before: ${describeSnapshot(hostBefore)}`)
    const hostNow = () => snapshotHost(hostProbe(), homedir())
    // An owner-less leftover (an older runner's) goes only when no run of the other mode is in progress
    // (a dry run reads only the real lock's PID, no secret or state file).
    const otherLockFile = dry ? realRunLockFile(resolveConfigDir(process.env, homedir())) : dryRunLockFile(tmpdir(), process.getuid?.() ?? 0)
    await container.removeLeftovers((pid) => isLiveRunnerPid(pid), lockHolder(otherLockFile) === null)
    if (!dry) restoreD(ws, env.log)

    // Provisioning.
    const t0 = Date.now()
    let provisionResult: RecordedResult
    try {
      const seeded = dry ? seedDryRunUnfinishedCreate(ws) : null
      const report = await provision(env, ws)
      const evidence = Object.entries(report.validate ?? {}).map(([l, v]) => `persona ${l}: bot_token ${v.bot}, app_token ${v.app}`)
      if (dry) {
        if (seeded) evidence.push(dryRunAdoptionEvidence(ws, report, seeded))
        evidence.push(await dryRunRotationSelfTest(ws))
        evidence.push(...(await dryRunFlowSelfTest(env, ws)))
        const realDir = resolveConfigDir(process.env, homedir())
        const touchedReal = ws.store.accessed.filter((p) => isInside(p, realDir)).length
        if (touchedReal > 0) throw new Error('dry run: the secret store touched the real config dir')
        evidence.push(`dry run: ${ws.store.accessed.length} secret-store accesses, none under the real config dir`)
      }
      const r = allValid(report.validate) ? pass(evidence) : fail('a credentials file failed validation', evidence)
      provisionResult = { id: 'provision', title: 'Provisioning: apps, sign-in, installs, app-level tokens, channels, validation', row: null, durationMs: Date.now() - t0, ...r }
    } catch (err) {
      if (err instanceof NotRunnableError) throw err
      provisionResult = runnerRow('provision', 'Provisioning', describeError(err), t0)
    }
    const idsOrProblem = liveIdsFrom(ws.appsFile.load())
    if (provisionResult.status === 'PASS' && typeof idsOrProblem === 'string') {
      provisionResult.status = 'FAIL'
      provisionResult.reason = idsOrProblem
    }
    const ids = typeof idsOrProblem === 'string' ? DRY_RUN_IDS : idsOrProblem
    record(provisionResult)
    env.log.info(`check provision: ${provisionResult.status}${provisionResult.reason ? ` (${provisionResult.reason})` : ''}`)
    let ready = provisionResult.status === 'PASS'

    // The test human's session (real runs).
    let sessions: Awaited<ReturnType<typeof openSessions>> | null = null
    if (!dry && ready) {
      const ts = Date.now()
      try {
        sessions = await openSessions(ws, env.log)
      } catch (err) {
        if (err instanceof NotRunnableError) throw err
        record(runnerRow('session', "The test human's browser session", `session setup failed: ${describeError(err)}`, ts))
        ready = false
      }
    }

    // The container.
    let started: Awaited<ReturnType<ContainerRun['start']>> | null = null
    if (ready) {
      const tc = Date.now()
      try {
        state.packed = await container.pack()
        env.log.info(`package: ${state.packed.version} (${state.packed.commit})`)
        await container.buildImage()
        started = await container.start({ tarball: state.packed.tarball, credentialsDir: ws.store.paths.credentialsDir, withClaude: !dry })
        // The container's first reading, at once.
        await watchdog.sample()
      } catch (err) {
        if (err instanceof NotRunnableError) throw err
        record(runnerRow('container', 'The live image and the test container', `container setup failed: ${describeError(err)}`, tc))
        state.containerLog = await container.logs().catch(() => '')
        await collectLogs()
        await container.stopAndRemove(env.options.keepContainer).catch(() => undefined)
        ready = false
      }
    }

    if (ready && started) {
      const tc = started
      const available = new Set<Need>(dry ? [] : ['workspace', 'claude', ...(sessions?.second ? (['second-user'] as const) : [])])
      // The prompt guard, from the first plan check to the last: it denies the prompts no check expects. A dry run's clicks go to the stub.
      const guardTarget: PromptGuardTarget = dry
        ? await dryRunGuardTarget(env, ws, tc, ids)
        : { container: tc, clock: realClock, ids, browser: sessions?.browser ?? null, human: sessions?.human ?? null }
      const promptGuard = new PromptGuard(
        containerPromptGuardDeps(guardTarget, { redact: (text) => env.redactor.redact(text), log: (line) => env.log.info(line), note: (line) => state.runNotes.push(line) }),
      )
      state.promptGuard = promptGuard
      const ctx: CheckContext = {
        mode,
        runId: env.runId,
        container: tc,
        hostName: tc.name,
        clock: realClock,
        log: env.log,
        runNotes: state.runNotes,
        ids,
        human: sessions?.human ?? null,
        second: sessions?.second ?? null,
        browser: sessions?.browser ?? null,
        creds: hostCredentials(ws),
        shared: {},
        promptGuard,
        restartContainer: () => container.restart(),
        hostScan: () => scanOutputs([env.resultsDir], [], env.redactor.knownSecrets()),
        hostBefore,
        hostNow,
        removeContainer: async () => {
          state.containerLog = await container.logs().catch(() => '')
          // Kept or removed, the container's own logs are copied first.
          await collectLogs()
          if (env.options.keepContainer) {
            state.runNotes.push(`container ${container.name} kept (--keep-container)`)
            return true
          }
          return container.remove()
        },
      }
      const needReasons = sessions?.secondSkip ? { 'second-user': sessions.secondSkip } : undefined
      const options = { available, now: () => Date.now(), log: env.log, onResult: record, needReasons }
      // The guard knows which check runs, and sweeps what each left open when it ends.
      const guardHooks = { beforeCheck: (c: CheckRef) => promptGuard.beforeCheck(c.id), afterCheck: (c: CheckRef) => promptGuard.afterCheck(c.id) }
      promptGuard.start()
      await runChecks(PLAN_CHECKS, ctx, { ...options, ...guardHooks, only: env.options.only })
      // Dry run only: the guard denies a stub prompt no check expects (before the fixture logs replace the trail).
      if (dry) record(await dryRunPromptGuardSelfTest(env, ws, tc, ids, promptGuard, state.runNotes))
      await promptGuard.stop()
      // Dry run only: logs for Teardown's copy to prove itself on, planted after S2 and 29a have read the state dir.
      const t0Logs = Date.now()
      const logsSeed = dry ? await seedDryRunContainerLogs(tc, env.redactor).catch((err: unknown) => `planting the container's logs failed: ${describeError(err)}`) : null
      await runChecks(FINAL_CHECKS, ctx, { ...options, only: [] })
      if (logsSeed !== null) record(dryRunContainerLogsCheck(env, logsSeed, containerLogs, t0Logs))
    } else {
      const hostCtx = { hostBefore, hostNow } as unknown as CheckContext
      await runChecks(FINAL_CHECKS.filter((c) => c.id === 'HOST'), hostCtx, { available: new Set(), only: [], now: () => Date.now(), log: env.log, onResult: record })
    }
    if (dry) state.runNotes.push('dry run: local Slack stub and fixture pages; no workspace secret read')
    // Copied at Teardown (or at a failed start) already; otherwise now, before the results and their scan.
    await collectLogs()
    // A last reading (after one in flight), then no more: the peaks are written after the last line.
    await watchdog.sample()
    await watchdog.stop()
    return finish(env, ws, state)
  } finally {
    signals.setActive(null)
    await cleanup()
  }
}

/** The dry run's stub tokens, registered with the redactor before a copy of the container's logs or the results are written. */
function registerStubTokens(env: RunEnv, ws: Workspace): void {
  if (ws.stub) for (const t of ws.stub.workspace.allTokens()) env.redactor.addSecret(t)
}

/** The scanner finds a runtime-built token-shaped string and (when any is known) a known secret value. */
function scanControl(secrets: readonly string[]): boolean {
  const planted = `${['xox', 'b-'].join('')}1234567890-1234567890-${'A'.repeat(24)}`
  const shaped = scanText('control', `before ${planted} after`, []).tokenShaped === 1
  const known = secrets.length === 0 || scanText('control', `x${secrets[0]}x`, secrets).knownSecrets >= 1
  return shaped && known
}

/**
 * Write the results and run the closing scan, once; the exit code.
 * `interruption` is the signal handler's call. Both callers have awaited the
 * watchdog's stop, so no watchdog line comes after its peaks or the scan, and
 * the copy of the container's logs, or stopped waiting for it: the copy is
 * sealed here, so nothing of it is written after the scan.
 */
function finish(env: RunEnv, ws: Workspace, state: RunState, interruption = false): number {
  if (state.finished || (state.interrupted !== undefined && !interruption)) return EXIT_FAIL
  state.finished = true
  // No copy of the container's logs lands after this: the closing scan must see every output.
  state.containerLogs?.seal()
  const memory = state.watchdog ? stopWatchdog(env, state.watchdog) : undefined
  const runNotes = [...state.runNotes]
  for (const r of state.results) for (const n of r.notes ?? []) runNotes.push(n)
  if (state.containerLog) writeFileSync(join(env.resultsDir, 'container.log'), env.redactor.redact(state.containerLog), { mode: 0o600 })
  registerStubTokens(env, ws)
  const results = [...state.results]
  const summary: RunSummary = {
    runId: env.runId,
    mode: env.options.dryRun ? 'dry-run' : 'real',
    date: new Date().toISOString().slice(0, 10),
    build: state.packed ? `${state.packed.version}, ${state.packed.commit}` : 'not built',
    hostUser: `${state.hostName} / testuser`,
    verdict: verdictOf(results),
    results,
    notes: runNotes,
    promptGuard: state.promptGuard?.report(),
    memory,
  }
  const writer = { write: (name: string, content: string) => writeFileSync(join(env.resultsDir, name), content, { mode: 0o600 }) }
  writeResults(summary, writer, env.redactor)
  // The closing secrecy scan: every output of the run (the copies in container-logs/ included), and the container's docker logs.
  const scan = scanOutputs([env.resultsDir], [{ source: 'docker logs', text: state.containerLog }], env.redactor.knownSecrets())
  const scanLines = describeScan(scan)
  const logsDir = join(env.resultsDir, CONTAINER_LOGS_DIR)
  scanLines.push(`container logs scanned: ${scan.counts.filter((c) => isInside(c.source, logsDir)).length} file(s) in ${CONTAINER_LOGS_DIR}/`)
  // A positive control: the scanner must see a planted token-shaped string and a known secret.
  const control = scanControl(env.redactor.knownSecrets())
  scanLines.push(`scanner control: ${control ? 'detects planted token-shaped and known-secret strings' : 'FAILED to detect planted strings'}`)
  scanLines.push(`known secret values checked: ${env.redactor.secretCount}`)
  for (const line of scanLines) env.log.info(line)
  const title = "Closing secrecy scan of every output (results dir with the container's copied logs, run.log, docker logs)"
  const scanResult: RecordedResult =
    scan.total === 0 && control
      ? { id: 'secrecy-scan', title, row: null, durationMs: 0, ...pass(scanLines) }
      : {
          id: 'secrecy-scan',
          title,
          row: null,
          durationMs: 0,
          ...fail(control ? `${scan.total} token-shaped or secret string(s) in the outputs` : 'the scanner control failed', scanLines),
        }
  summary.results = [...results, scanResult]
  summary.verdict = verdictOf(summary.results)
  writeResults(summary, writer, env.redactor)

  env.log.info('')
  for (const r of summary.results) env.log.info(`  ${r.status.padEnd(7)} ${r.id}${r.reason ? `: ${r.reason}` : ''}`)
  env.log.info(`VERDICT: ${summary.verdict}`)
  const passed = summary.verdict === 'PASS'
  if (passed && env.options.clean) {
    rmSync(env.resultsDir, { recursive: true, force: true })
    process.stdout.write('results removed (--clean)\n')
  } else {
    env.log.info(`results: ${env.resultsDir}`)
  }
  return passed ? EXIT_PASS : EXIT_FAIL
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let options: RunOptions
  try {
    options = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE}\n`)
      return EXIT_NOT_RUNNABLE
    }
    throw err
  }
  const redactor = new Redactor()
  redactor.addSecret(process.env.CI_ANTHROPIC_API_KEY)
  if (options.command === 'mailbox') return runMailbox(options, redactor)
  if (options.command === 'config-token' || options.command === 'apps') return runMaintenance(options, redactor, REPO_ROOT)
  const log = createProcessRunLog(redactor)
  const runId = String(Math.floor(Date.now() / 1000))
  const resultsDir = makeResultsDir(runId)
  log.attachFile(join(resultsDir, 'run.log'))
  // The first line: where verdict.txt will appear (an agent polling a detached run reads it from here).
  log.info(`RESULTS_DIR=${resultsDir}`)
  log.info(`ci-live: run ${runId}${options.dryRun ? ' (dry run)' : ''}; results and run.log in ${resultsDir}`)
  const env: RunEnv = { options, runId, redactor, log, resultsDir }
  const signals = installSignalHandlers(env)
  let lock: RunLock | null = null
  try {
    lock = acquireRunLock(env)
    signals.setLock(lock)
    if (options.command === 'login') return await runLogin(env, signals)
    if (options.provisionOnly) return await runProvisionOnly(env, signals)
    return await runFull(env, signals)
  } catch (err) {
    await signals.waitIfStopping()
    if (err instanceof NotRunnableError) {
      log.error(`not runnable: ${err.message}`)
      writeVerdict(env, `NOT RUNNABLE: ${err.message}`)
      return EXIT_NOT_RUNNABLE
    }
    log.error(describeError(err))
    writeVerdict(env, `FAIL: runner: ${describeError(err)}`)
    return EXIT_FAIL
  } finally {
    // A signal being handled finishes the run itself (and exits): don't race it to the exit.
    await signals.waitIfStopping()
    lock?.release()
    signals.setLock(null)
    signals.dispose()
  }
}
