/**
 * test-helpers/fifo.ts — Real FIFOs for tests, made by the `mkfifo` command
 * through a host-safe child environment (b.jg5 SRJ-1302).
 *
 * Node and Bun have no mkfifo API, so a test that needs a real FIFO (a
 * credentials, config or record path that is not a regular file) starts the
 * `mkfifo` command. This module is the one place that does it:
 *
 * - `mkfifoAvailable()`: whether `mkfifo` can be run here, probed once per
 *   process. When no `mkfifo` is on the current `PATH` it is `false` with no
 *   child started; otherwise it runs `mkfifo --version` and is `true` when
 *   that exits 0. Guard a real-FIFO case with
 *   `test.skipIf(!mkfifoAvailable())`, the reason in the test name;
 * - `makeFifo(path)`: creates a FIFO at `path` and throws when `mkfifo` does
 *   not exit 0 (an entry already there, a missing parent directory, no
 *   `mkfifo`), naming the path, the exit status or signal and `mkfifo`'s
 *   stderr. It neither removes an existing entry nor creates the parent
 *   directory: the caller arranges both.
 *
 * Each child is `MKFIFO_TOOL`, started with `spawnSync`, bounded by
 * `MKFIFO_TIMEOUT_MS`, with its `env` a direct `hostSafeChildEnv` call naming
 * only that tool. Its HOME is a new `mkdtempSync` directory under the OS temp
 * directory (`FIFO_HOME_PREFIX`), removed as soon as the child has exited,
 * whether or not it succeeded. A `HostSafetyError` from `hostSafeChildEnv`
 * (for example `mkfifo`'s `PATH` directory holding an `agent-director`) is
 * thrown, not turned into "unavailable". `mkfifoAvailable()` runs while the
 * tests are collected (inside `test.skipIf(!mkfifoAvailable())`), so such an
 * error makes the whole test file fail to load rather than its FIFO cases
 * being skipped; from `makeFifo` inside a test it fails that test.
 *
 * Isolation: it writes only the FIFO asked for, the temp HOME it removes and
 * `hostSafeChildEnv`'s per-process `TMUX_TMPDIR`; it imports nothing from
 * `src/` or `agent-director`.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hostSafeChildEnv, resolveToolDir } from './host-safe-env.ts'

/** The command this module starts, and the only tool on its children's `PATH`. */
export const MKFIFO_TOOL = 'mkfifo'

/** Upper bound on each `mkfifo` child, in milliseconds. */
export const MKFIFO_TIMEOUT_MS = 5_000

/** Prefix of each child's temp HOME under the OS temp directory. */
export const FIFO_HOME_PREFIX = 'fifo-helper-home-'

/** A new temp HOME for one `mkfifo` child. */
function newChildHome(): string {
  return mkdtempSync(join(tmpdir(), FIFO_HOME_PREFIX))
}

let mkfifoProbe: boolean | undefined

/**
 * Whether `mkfifo` is available here (probed once per process). Guard a
 * real-FIFO case with `test.skipIf(!mkfifoAvailable())`, the reason in the
 * test name.
 */
export function mkfifoAvailable(): boolean {
  if (mkfifoProbe === undefined) {
    if (resolveToolDir(MKFIFO_TOOL) === undefined) {
      mkfifoProbe = false
    } else {
      const home = newChildHome()
      try {
        const probe = spawnSync(MKFIFO_TOOL, ['--version'], {
          env: hostSafeChildEnv(home, { tools: [MKFIFO_TOOL] }),
          stdio: 'ignore',
          timeout: MKFIFO_TIMEOUT_MS,
        })
        mkfifoProbe = probe.status === 0
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
  return mkfifoProbe
}

/**
 * Create a FIFO at `path` with `mkfifo`. Throws when it does not exit 0;
 * guard the test with `mkfifoAvailable()`.
 */
export function makeFifo(path: string): void {
  const home = newChildHome()
  try {
    const made = spawnSync(MKFIFO_TOOL, [path], {
      env: hostSafeChildEnv(home, { tools: [MKFIFO_TOOL] }),
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: MKFIFO_TIMEOUT_MS,
    })
    if (made.status !== 0) {
      const how = made.error !== undefined ? made.error.message : made.signal !== null ? `signal ${made.signal}` : `status ${made.status}`
      throw new Error(`makeFifo: ${MKFIFO_TOOL} ${path} failed (${how}): ${(made.stderr ?? '').trim()} (guard the test with mkfifoAvailable())`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
