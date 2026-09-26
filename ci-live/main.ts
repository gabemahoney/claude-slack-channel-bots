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
 * results.md, run.log) → the closing secrecy scan of every output. A failure
 * of the session, image build or container start is a FAIL row: HOST, the
 * scan and the results still happen.
 *
 * `mailbox --latest` and `mailbox --forwarding` are separate: they take no
 * lock, make no results dir and write no run.log; they only read the test
 * mailbox (rewriting mailbox.json when mail.tm wants a fresh token) and print
 * one message's sender, subject and any confirmation code it holds: the
 * newest message, or the newest Gmail forwarding confirmation with its
 * confirm link.
 *
 * SIGINT, SIGTERM and SIGHUP (a killed tmux session) all stop the run the
 * same way: no new container is started, the test container is removed
 * (unless --keep-container), D's credentials go back to the staging dir, the
 * browser closes, the results so far are written with a FAIL row
 * "runner: interrupted by <signal>", the lock is released, and the process
 * exits 1. A second signal while that runs is ignored.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { CheckContext, HostCredentials, SecondUser } from './checks/context.ts'
import { DRY_RUN_IDS, liveIdsFrom } from './checks/context.ts'
import { fail, pass, runChecks, verdictOf, type Need, type RecordedResult } from './checks/framework.ts'
import { FINAL_CHECKS, PLAN_CHECKS } from './checks/list.ts'
import { personaEntry } from './lib/apps-state.ts'
import { parseArgs, UsageError, USAGE, type RunOptions } from './lib/args.ts'
import type { BrowserDriver } from './lib/browser-types.ts'
import { claudeEnvProblem } from './lib/docker.ts'
import { describeError } from './lib/errors.ts'
import { describeSnapshot, procListener, snapshotHost, type HostSnapshot } from './lib/host-state.ts'
import { HumanSession } from './lib/human-session.ts'
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
import { dryRunLockFile, hostCredentialsFile, livePathsIn, mountedCredentialsFile, realRunLockFile, resolveConfigDir } from './lib/paths.ts'
import { APP_TOKEN_NAME } from './lib/personas.ts'
import { bunSpawn, minimalChildEnv } from './lib/proc.ts'
import { Redactor } from './lib/redact.ts'
import { writeResults, type RunSummary } from './lib/results.ts'
import { isLiveRunnerPid, lockHolder, RunLock } from './lib/run-lock.ts'
import { describeScan, scanOutputs, scanText } from './lib/secrecy-scan.ts'
import { isInside, nodeSecureFs, NotRunnableError, SecretStore, SignInCodeNeededError } from './lib/secrets.ts'
import { realClock } from './lib/wait.ts'
import { allValid, runProvisioning, type ProvisionReport } from './provision/index.ts'
import { ContainerRun, type Packed } from './runtime/container-run.ts'
import { openWorkspace, type Workspace } from './runtime/workspace.ts'

/** The repository root (ci-live's parent). */
export const REPO_ROOT = resolve(dirname(import.meta.path), '..')

export const EXIT_PASS = 0
export const EXIT_FAIL = 1
export const EXIT_NOT_RUNNABLE = 2

/** How long a signal's cleanup may take (a `docker run` in flight, then `docker rm -f`) before the process exits anyway. */
const SIGNAL_CLEANUP_MS = 200_000

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

/** What the running command has started, for a signal to stop. */
interface Interruptible {
  /** Called first: from here on the command leaves writing the results to `finishInterrupted`. */
  interrupted?(signal: string): void
  /** Stop and undo what the command started (container, D's file, browser). */
  cleanup(): Promise<void>
  /** Write the results so far, with the interruption as a FAIL row. */
  finishInterrupted?(signal: string): void
}

interface SignalControl {
  setActive(active: Interruptible | null): void
  setLock(lock: RunLock | null): void
  /** When a signal is being handled, never resolves (the handler exits the process); otherwise resolves at once. */
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

function installSignalHandlers(env: RunEnv): SignalControl {
  let active: Interruptible | null = null
  let lock: RunLock | null = null
  let stopping = false
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) {
      env.log.error(`${signal}: already stopping; the cleanup is still running`)
      return
    }
    stopping = true
    // The command's own flow may still run on (and clear `active`): act on what was active now.
    const current = active
    current?.interrupted?.(signal)
    void (async () => {
      env.log.error(`${signal}: stopping the run: removing the test container, closing the browser`)
      try {
        if (current) await withDeadline(current.cleanup(), SIGNAL_CLEANUP_MS)
      } catch (err) {
        env.log.error(`cleanup after ${signal}: ${describeError(err)}`)
      }
      try {
        current?.finishInterrupted?.(signal)
      } catch (err) {
        env.log.error(`writing the results after ${signal}: ${describeError(err)}`)
      }
      if (!hasVerdict(env)) writeVerdict(env, `FAIL: runner: interrupted by ${signal}`)
      lock?.release()
      env.log.error(`${signal}: stopped; results in ${env.resultsDir}`)
      process.exit(EXIT_FAIL)
    })()
  }
  for (const signal of STOP_SIGNALS) process.on(signal, handler)
  return {
    setActive: (a) => {
      active = a
    },
    setLock: (l) => {
      lock = l
    },
    waitIfStopping: () => (stopping ? new Promise<void>(() => {}) : Promise.resolve()),
    dispose: () => {
      for (const signal of STOP_SIGNALS) process.off(signal, handler)
    },
  }
}

/** The lock of this command's mode: the config dir's for real-mode commands, the temp dir's for a dry run. */
function acquireRunLock(env: RunEnv): RunLock {
  const uid = process.getuid?.() ?? 0
  if (env.options.dryRun) return RunLock.acquire(dryRunLockFile(tmpdir(), uid), '/ci-live dry run')
  const configDir = resolveConfigDir(process.env, homedir())
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  return RunLock.acquire(realRunLockFile(configDir), '/ci-live real-mode command (run, --provision-only or login)')
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
  const ts = stub.workspace.addPrompt(channel, state.personas.a?.bot_user_id ?? 'U0')
  await browser.clickMessageButton(state.team_id ?? '', channel, ts, 'Allow')
  const clicked = stub.workspace.channels.get(channel)?.messages.find((m) => m.ts === ts)?.text === '*Permission* — Allowed'
  if (!clicked) throw new Error('dry-run flow self-test: the button click did not reach the fixture')
  evidence.push(`button flow: clicked Allow on fixture message ${ts}`)
  const appId = state.personas.b?.app_id as string
  const name = `cscb-live-selftest-${env.runId}`
  const token = await browser.generateAppToken(appId, name)
  if (!token) throw new Error('dry-run flow self-test: no token generated')
  await browser.revokeAppToken(appId, name)
  if (stub.workspace.apps.get(appId)?.appTokens.some((t) => t.name === name)) throw new Error('dry-run flow self-test: the token was not revoked')
  evidence.push(`app-token flow: generated and revoked ${name}`)
  return evidence
}

async function runProvisionOnly(env: RunEnv, signals: SignalControl): Promise<number> {
  const ws = openWorkspace({ repoRoot: REPO_ROOT, runId: env.runId, redactor: env.redactor, log: env.log }, env.options.dryRun ? 'dry-run' : 'real')
  signals.setActive({ cleanup: () => ws.close() })
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
  /** The signal being handled: the run's own end then leaves the results to the handler. */
  interrupted?: string
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
  const state: RunState = { results: [], runNotes: [], packed: null, hostName: container.name, containerLog: '', finished: false }
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
  // One cleanup, however many callers (the run's end and a signal): they all wait for the same work.
  let cleaning: Promise<void> | null = null
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      await container.stopAndRemove(env.options.keepContainer)
      if (!dry) restoreDLogged(ws, env.log)
      await ws.close()
      if (state.packed) rmSync(state.packed.dir, { recursive: true, force: true })
    })())
  signals.setActive({
    interrupted: (signal) => {
      state.interrupted = signal
    },
    cleanup,
    finishInterrupted: (signal) => {
      if (state.finished) return
      state.results.unshift(runnerRow('runner', 'The run was interrupted', `interrupted by ${signal}`, Date.now()))
      state.runNotes.push(`interrupted by ${signal}; the test container was removed and the results so far written`)
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
      const report = await provision(env, ws)
      const evidence = Object.entries(report.validate ?? {}).map(([l, v]) => `persona ${l}: bot_token ${v.bot}, app_token ${v.app}`)
      if (dry) {
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
      } catch (err) {
        if (err instanceof NotRunnableError) throw err
        record(runnerRow('container', 'The live image and the test container', `container setup failed: ${describeError(err)}`, tc))
        state.containerLog = await container.logs().catch(() => '')
        await container.stopAndRemove(env.options.keepContainer).catch(() => undefined)
        ready = false
      }
    }

    if (ready && started) {
      const tc = started
      const available = new Set<Need>(dry ? [] : ['workspace', 'claude', ...(sessions?.second ? (['second-user'] as const) : [])])
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
        restartContainer: () => container.restart(),
        hostScan: () => scanOutputs([env.resultsDir], [], env.redactor.knownSecrets()),
        hostBefore,
        hostNow,
        removeContainer: async () => {
          state.containerLog = await container.logs().catch(() => '')
          if (env.options.keepContainer) {
            state.runNotes.push(`container ${container.name} kept (--keep-container)`)
            return true
          }
          return container.remove()
        },
      }
      const needReasons = sessions?.secondSkip ? { 'second-user': sessions.secondSkip } : undefined
      const options = { available, now: () => Date.now(), log: env.log, onResult: record, needReasons }
      await runChecks(PLAN_CHECKS, ctx, { ...options, only: env.options.only })
      await runChecks(FINAL_CHECKS, ctx, { ...options, only: [] })
    } else {
      const hostCtx = { hostBefore, hostNow } as unknown as CheckContext
      await runChecks(FINAL_CHECKS.filter((c) => c.id === 'HOST'), hostCtx, { available: new Set(), only: [], now: () => Date.now(), log: env.log, onResult: record })
    }
    if (dry) state.runNotes.push('dry run: local Slack stub and fixture pages; no workspace secret read')
    return finish(env, ws, state)
  } finally {
    signals.setActive(null)
    await cleanup()
  }
}

/** The scanner finds a runtime-built token-shaped string and (when any is known) a known secret value. */
function scanControl(secrets: readonly string[]): boolean {
  const planted = `${['xox', 'b-'].join('')}1234567890-1234567890-${'A'.repeat(24)}`
  const shaped = scanText('control', `before ${planted} after`, []).tokenShaped === 1
  const known = secrets.length === 0 || scanText('control', `x${secrets[0]}x`, secrets).knownSecrets >= 1
  return shaped && known
}

/** Write the results and run the closing scan, once; the exit code. `interruption` is the signal handler's call. */
function finish(env: RunEnv, ws: Workspace, state: RunState, interruption = false): number {
  if (state.finished || (state.interrupted !== undefined && !interruption)) return EXIT_FAIL
  state.finished = true
  const runNotes = [...state.runNotes]
  for (const r of state.results) for (const n of r.notes ?? []) runNotes.push(n)
  if (state.containerLog) writeFileSync(join(env.resultsDir, 'container.log'), env.redactor.redact(state.containerLog), { mode: 0o600 })
  if (ws.stub) for (const t of ws.stub.workspace.allTokens()) env.redactor.addSecret(t)
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
  }
  const writer = { write: (name: string, content: string) => writeFileSync(join(env.resultsDir, name), content, { mode: 0o600 }) }
  writeResults(summary, writer, env.redactor)
  // The closing secrecy scan: every output of the run, and the container's logs.
  const scan = scanOutputs([env.resultsDir], [{ source: 'docker logs', text: state.containerLog }], env.redactor.knownSecrets())
  const scanLines = describeScan(scan)
  // A positive control: the scanner must see a planted token-shaped string and a known secret.
  const control = scanControl(env.redactor.knownSecrets())
  scanLines.push(`scanner control: ${control ? 'detects planted token-shaped and known-secret strings' : 'FAILED to detect planted strings'}`)
  scanLines.push(`known secret values checked: ${env.redactor.secretCount}`)
  for (const line of scanLines) env.log.info(line)
  const title = 'Closing secrecy scan of every output (results dir, run.log, docker logs)'
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
