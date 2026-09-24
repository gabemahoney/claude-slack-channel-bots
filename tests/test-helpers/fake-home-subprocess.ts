/**
 * test-helpers/fake-home-subprocess.ts — Run a source module's entry point in
 * a fresh Bun subprocess whose launch-time HOME is a fake home.
 *
 * Bun snapshots HOME at process launch, so mutating `process.env.HOME` inside
 * a test does not move `node:os` `homedir()`. Code that falls back to, or
 * refuses, a path under the home dir is therefore tested in a child process
 * launched with HOME set to the test's own `mkdtempSync` directory: if the
 * code regresses, only that fake home can be written to.
 *
 * - The child env carries only PATH, HOME and SLACK_STATE_DIR, plus the JSON
 *   input. Nothing else from the parent env is passed on, so the Slack token
 *   variables and any other ambient credential never reach the child.
 * - The child prints one control line, `HOMEDIR::<path>`, before running the
 *   entry point. The caller asserts `observedHomedir` equals the fake home
 *   before trusting anything else the child did.
 * - `spawnSync` gets a timeout (30 s by default). A child that hangs, or is
 *   killed by any signal, throws an error naming the signal instead of
 *   blocking the run or passing unnoticed.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Default bound on one child run. */
export const FAKE_HOME_SUBPROCESS_TIMEOUT_MS = 30_000

export interface FakeHomeRunOptions {
  /** Absolute path of the source module to import in the child. */
  modulePath: string
  /**
   * JavaScript run in the child after the import, with `mod` (the imported
   * module) and `input` (the parsed `input` option) in scope. May use `await`.
   */
  call: string
  /** JSON-serialisable value handed to `call` as `input`. */
  input: unknown
  /** Launch-time HOME for the child: the test's own temp dir. */
  home: string
  /** SLACK_STATE_DIR for the child: where startup-errors.log lands. */
  stateDir: string
  /** Bound on the child run in ms; defaults to FAKE_HOME_SUBPROCESS_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface FakeHomeRunResult {
  status: number | null
  stdout: string
  stderr: string
  /** The child's `homedir()`, from its `HOMEDIR::` control line ('' if absent). */
  observedHomedir: string
}

export function runInFakeHome(opts: FakeHomeRunOptions): FakeHomeRunResult {
  if (resolve(opts.home) === resolve(homedir())) {
    throw new Error('runInFakeHome: home must be a temp dir, not the real home dir')
  }
  const timeoutMs = opts.timeoutMs ?? FAKE_HOME_SUBPROCESS_TIMEOUT_MS
  const script = `
    const { homedir } = require('node:os');
    process.stdout.write('HOMEDIR::' + homedir() + '\\n');
    const input = JSON.parse(process.env.FAKE_HOME_INPUT_JSON);
    const mod = await import(${JSON.stringify(opts.modulePath)});
    ${opts.call}
  `
  const res = spawnSync('bun', ['-e', script], {
    env: {
      // PATH so `bun` and `sh` resolve; nothing else from the parent env.
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: opts.home,
      SLACK_STATE_DIR: opts.stateDir,
      FAKE_HOME_INPUT_JSON: JSON.stringify(opts.input),
    },
    encoding: 'utf-8',
    timeout: timeoutMs,
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  if (res.signal !== null || res.error !== undefined) {
    throw new Error(
      `runInFakeHome: child did not exit normally (signal=${res.signal ?? 'none'}, ` +
        `error=${res.error?.message ?? 'none'}, timeout=${timeoutMs} ms)\nstderr:\n${stderr}`,
    )
  }
  const m = stdout.match(/^HOMEDIR::(.*)$/m)
  return { status: res.status, stdout, stderr, observedHomedir: m ? m[1]! : '' }
}
