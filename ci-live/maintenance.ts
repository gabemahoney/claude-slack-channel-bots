/**
 * maintenance.ts — the operator's maintenance commands (see run.ts for the
 * command line):
 *
 * - `config-token --rotate`: rotate the app configuration token pair once
 *   with `tooling.tokens.rotate`, save both files (mode 600) and print
 *   `config token: rotated with tooling.tokens.rotate; both token files
 *   rewritten (mode 600)`, so the operator can prove rotation end to end.
 * - `apps --list`: every app the test human sees at api.slack.com/apps (read
 *   in the run's one bounded Chrome, with the saved session), one line each:
 *   its ID, its name, and whether apps.json records it.
 * - `apps --delete-strays`: the same, then delete the stray test apps (named
 *   exactly "CSCB Test A"–"D", not in apps.json, in the test workspace) with
 *   `apps.manifest.delete`, printing what was deleted and what was kept
 *   (provision/app-listing.ts). An app apps.json records is never deleted,
 *   and nothing is: not runnable (exit 2), before Chrome is launched, unless
 *   apps.json is there, parses as a JSON object and records at least one
 *   app ID.
 *
 * A malformed apps.json is not runnable for both `apps` commands: it is
 * never read as empty.
 *
 * Each takes the real run lock (with a run, `--provision-only` and `login`),
 * writes no results dir or run.log, and prints only its own lines on stdout,
 * or one safe error on stderr, every line through the redactor. A signal
 * closes the browser, releases the lock and exits 1; one that comes while a
 * rotated pair is being saved waits for the save.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

import type { AppsState } from './lib/apps-state.ts'
import type { RunOptions } from './lib/args.ts'
import { describeError, EXIT_FAIL, EXIT_NOT_RUNNABLE, EXIT_PASS } from './lib/errors.ts'
import type { RunLog } from './lib/log.ts'
import { realRunLockFile, resolveConfigDir } from './lib/paths.ts'
import { PERSONA_LETTERS } from './lib/personas.ts'
import type { Redactor } from './lib/redact.ts'
import { nodeLockDeps, RunLock } from './lib/run-lock.ts'
import { NotRunnableError } from './lib/secrets.ts'
import { appsStateForStrayDeletion, classifyListedApps, deleteStrayApps, describeListedApp, testWorkspaceName } from './provision/app-listing.ts'
import { openWorkspace, type Workspace } from './runtime/workspace.ts'

/** What the real run lock is taken for, in a refusal naming its holder. */
export const REAL_LOCK_WHAT = '/ci-live real-mode command (a run, --provision-only, login, config-token or apps)'

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

async function appsCommand(ws: Workspace, action: 'list' | 'delete-strays', log: RunLog): Promise<number> {
  const readState = (): AppsState => (action === 'delete-strays' ? appsStateForStrayDeletion(ws.appsFile) : ws.appsFile.load())
  // Before Chrome is launched: apps.json must be usable (for --delete-strays: there, and recording an app ID).
  readState()
  const browser = await ws.browser()
  const team = await testWorkspaceName(browser)
  const listed = await browser.listApps()
  const state = readState()
  const classified = classifyListedApps(listed, state, team)
  log.info(`apps: ${listed.length} apps in the apps list (api.slack.com/apps); test workspace ${team === null ? 'name unknown' : JSON.stringify(team)}`)
  for (const c of classified) log.info(describeListedApp(c))
  for (const letter of PERSONA_LETTERS) {
    const pending = state.personas[letter]?.pending_create
    if (pending && !state.personas[letter]?.app_id) {
      log.info(`apps.json: an unfinished create of persona ${letter.toUpperCase()} (started ${pending.started_at}); the next run resolves it from this list`)
    }
  }
  const strays = classified.filter((c) => c.recordedAs === null && c.namedAs !== null)
  if (action === 'list') {
    log.info(strays.length === 0 ? 'apps: no stray test app' : `apps: ${strays.length} stray test app(s): delete them with bun ci-live/run.ts apps --delete-strays`)
    return EXIT_PASS
  }
  const outcome = await deleteStrayApps({ callManifest: ws.callManifest, appsFile: ws.appsFile, log }, classified)
  log.info(`apps: deleted ${outcome.deleted.length} stray test app(s), kept ${outcome.kept.length}`)
  return outcome.kept.length === 0 ? EXIT_PASS : EXIT_FAIL
}

/** `config-token --rotate` or `apps --list|--delete-strays`; the exit code. */
export async function runMaintenance(options: RunOptions, redactor: Redactor, repoRoot: string): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${redactor.redact(line)}\n`)
  }
  const err = (line: string): void => {
    process.stderr.write(`${redactor.redact(line)}\n`)
  }
  const log: RunLog = {
    redactor,
    info: out,
    detail: () => undefined,
    error: (message) => err(`ERROR: ${message}`),
    attachFile: () => undefined,
  }
  let lock: RunLock | null = null
  let ws: Workspace | null = null
  /** A rotated pair is being saved: a signal waits for it. */
  let saving = false
  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    err(`${signal}: stopping: closing the browser, releasing the lock`)
    await ws?.close().catch(() => undefined)
    lock?.release()
    process.exit(EXIT_FAIL)
  }
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    if (saving) err(`${signal}: the token pair is being rotated and saved; the command ends once it is`)
    else void stop(signal)
  }
  for (const signal of STOP_SIGNALS) process.on(signal, handler)
  try {
    const configDir = resolveConfigDir(process.env, homedir())
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    lock = RunLock.acquire(realRunLockFile(configDir), REAL_LOCK_WHAT, nodeLockDeps, err)
    ws = openWorkspace({ repoRoot, runId: String(Math.floor(Date.now() / 1000)), redactor, log }, 'real')
    if (options.command === 'config-token') {
      saving = true
      try {
        await ws.configTokens.rotateNow()
      } finally {
        saving = false
      }
      // A signal that waited for the save ends the command as it would have ended anyway.
      return EXIT_PASS
    }
    return await appsCommand(ws, options.appsAction ?? 'list', log)
  } catch (e) {
    if (e instanceof NotRunnableError) {
      err(`not runnable: ${e.message}`)
      return EXIT_NOT_RUNNABLE
    }
    err(`ERROR: ${describeError(e)}`)
    return EXIT_FAIL
  } finally {
    await ws?.close().catch(() => undefined)
    lock?.release()
    for (const signal of STOP_SIGNALS) process.off(signal, handler)
  }
}
