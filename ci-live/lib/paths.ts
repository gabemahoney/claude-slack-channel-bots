/**
 * paths.ts — where /ci-live keeps its host-side secrets and state.
 *
 * Everything lives in one directory outside the repo, `~/.config/cscb-test/`
 * by default (`CSCB_LIVE_CONFIG_DIR` overrides it). A dry run uses a fresh
 * temporary directory instead and never resolves the real one's files.
 *
 * Pure: the home directory and environment are passed in.
 */

import { join } from 'node:path'

import { credentialsFileName, type PersonaLetter } from './personas.ts'

export const CONFIG_DIR_ENV = 'CSCB_LIVE_CONFIG_DIR'
export const PASSWORD_ENV = 'CSCB_LIVE_TEST_PASSWORD'
export const WORKSPACE_ENV = 'CSCB_LIVE_WORKSPACE'
export const TEST_EMAIL_ENV = 'CSCB_LIVE_TEST_EMAIL'

export interface LivePaths {
  configDir: string
  /** App configuration token (secret, operator-written). */
  configTokenFile: string
  /** Optional refresh token for the configuration token (secret). */
  refreshTokenFile: string
  /** The test human's password (secret, operator-written). */
  passwordFile: string
  /** `{workspace_domain, test_email, second_user?}` (the email is config, never logged). */
  liveJson: string
  /** Playwright storageState: session cookies (secret, runner-written). */
  storageState: string
  /** The second workspace user's storageState (Checks 14, 16, 20; secret, runner-written). */
  secondStorageState: string
  /** App, bot, team, channel and user IDs (no secret, runner-written). */
  appsJson: string
  /**
   * The test mailbox (mail.tm) the test human's mail is forwarded to, for
   * Slack's emailed sign-in codes: `{provider, api, address, password,
   * account_id, token}` (secret, operator-written; the runner rewrites the
   * token). Optional: without it an emailed code stops the run as before.
   */
  mailboxJson: string
  /** Mounted read-only into the container as ~/.config/cscb (dir 700, files 600). */
  credentialsDir: string
  /** D's credentials wait here until Check 25 moves them into `credentialsDir`. */
  stagedCredentialsDir: string
}

/** The default config dir under `home`. */
export function defaultConfigDir(home: string): string {
  return join(home, '.config', 'cscb-test')
}

/** The config dir: `CSCB_LIVE_CONFIG_DIR` when set and non-empty, else the default. */
export function resolveConfigDir(env: Record<string, string | undefined>, home: string): string {
  const override = env[CONFIG_DIR_ENV]
  return override !== undefined && override !== '' ? override : defaultConfigDir(home)
}

export function livePathsIn(configDir: string): LivePaths {
  return {
    configDir,
    configTokenFile: join(configDir, 'slack_config_token'),
    refreshTokenFile: join(configDir, 'slack_config_refresh_token'),
    passwordFile: join(configDir, 'test_password'),
    liveJson: join(configDir, 'live.json'),
    storageState: join(configDir, 'playwright-state.json'),
    secondStorageState: join(configDir, 'playwright-state-second.json'),
    appsJson: join(configDir, 'apps.json'),
    mailboxJson: join(configDir, 'mailbox.json'),
    credentialsDir: join(configDir, 'credentials'),
    stagedCredentialsDir: join(configDir, 'credentials-staged'),
  }
}

/** The lock a real-mode command (a run, `--provision-only`, `login`) holds: in the config dir. */
export function realRunLockFile(configDir: string): string {
  return join(configDir, 'run.lock')
}

/** The lock a dry run holds: in the temp dir, as a dry run never touches the real config dir. */
export function dryRunLockFile(tempDir: string, uid: number): string {
  return join(tempDir, `cscb-ci-live-dry-run-${uid}.lock`)
}

/**
 * Where a persona's credentials file lives on the host. D's lives in the
 * staging dir, so it is absent from the container's ~/.config/cscb until
 * Check 25 moves it in (AC 22: the file appears while the server runs).
 */
export function hostCredentialsFile(paths: LivePaths, letter: PersonaLetter): string {
  const dir = letter === 'd' ? paths.stagedCredentialsDir : paths.credentialsDir
  return join(dir, credentialsFileName(letter))
}

/** D's credentials file once Check 25 has moved it into the mounted dir. */
export function mountedCredentialsFile(paths: LivePaths, letter: PersonaLetter): string {
  return join(paths.credentialsDir, credentialsFileName(letter))
}
