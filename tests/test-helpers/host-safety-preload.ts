/**
 * test-helpers/host-safety-preload.ts — The `bun test` preload guard
 * (b.jg5 SRJ-1301). The `[test]` preload of `bunfig.toml` (and of
 * `tests/bunfig.toml`, for a run started in `tests/`) loads it once, before
 * any test file; it runs for its side effects only, exports nothing, and no
 * test file imports it.
 *
 * The agent-director 0.10.0 client's `Client.create()` and
 * `resolveSystemBinary()` read `process.env.HOME` and `process.env.PATH` when
 * called, so after this guard a test that forgot its stub fails in process
 * with `ErrSystemInstallNotFound` instead of reaching the host's real install
 * and store. Bun fixes `os.homedir()` at start-up from the launch-time HOME,
 * so only the environment can be redirected here; that is why the run should
 * still be started with a scratch HOME (see `tests/README.md`).
 *
 * What it does, in order:
 * 1. makes a new, empty `mkdtempSync` HOME directly under the OS temp
 *    directory (`osTempDir()`), named with `PRELOAD_HOME_PREFIX`. It is never
 *    removed: Bun's test runner fires no `exit` or `beforeExit` listener, and
 *    a child may still be using it when the run ends, so each run leaves one
 *    such directory in the OS temp directory;
 * 2. takes the process's one fenced `TMUX_TMPDIR` directory from
 *    `childTmuxTmpDir()` (the inherited one when the run was started with a
 *    valid one, else a new `CHILD_TMUX_TMPDIR_PREFIX` directory directly under
 *    the OS temp directory; never removed, a child may still be running tmux).
 *    `hostSafeChildEnv` hands the same directory to every child;
 * 3. computes the redirected variables with the shared, side-effect-free
 *    `preloadRedirectedEnv(process.env, home, tmuxTmpDir)` (see its doc in
 *    `host-safe-env.ts`: `HOME`, the cleaned `PATH`, `TMUX_TMPDIR`,
 *    `SLACK_STATE_DIR` under the new HOME; `TMUX` and `TMUX_PANE` unset) and
 *    applies it to `process.env`: each of `PRELOAD_ENV_NAMES` is set to its
 *    value or deleted when it has none. Nothing else in `process.env` is
 *    touched (`CLAUDE_CONFIG_DIR` included: `src/` never reads it from the
 *    environment). `SLACK_STATE_DIR` is set rather than unset because the
 *    state-directory resolvers in `src/` fall back to `os.homedir()` (the
 *    launch-time HOME) when it is unset;
 * 4. runs the shared `preloadCheckFailures` on the result (the same check the
 *    host-safety test runs on the live environment) and throws, failing the
 *    run before any test file loads, when it reports anything. The message
 *    names the failed checks (`PRELOAD_CHECK` labels) and HOME, and never
 *    prints the environment.
 *
 * `bunfig.toml` (repository root) and `tests/bunfig.toml` both load it: Bun
 * reads `bunfig.toml` only from the working directory `bun test` starts in
 * and resolves a relative preload path against that directory, so each file
 * names the guard relative to its own directory.
 *
 * Isolation: it starts no process and imports no value from
 * `agent-director`. Its only reads are the helper's (`/etc/passwd`, the
 * `agent-director` entry name in each inherited `PATH` directory, the new
 * HOME's install entries, the `TMUX_TMPDIR` directory); it reads nothing
 * else under the real home. Its only writes are the new HOME and, when none
 * was inherited, the `TMUX_TMPDIR` directory, both under the OS temp
 * directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRELOAD_ENV_NAMES,
  PRELOAD_HOME_PREFIX,
  childTmuxTmpDir,
  osTempDir,
  preloadCheckFailures,
  preloadRedirectedEnv,
} from './host-safe-env.ts'

const home = mkdtempSync(join(osTempDir(), PRELOAD_HOME_PREFIX))

// Read before TMUX_TMPDIR is replaced: a valid inherited directory is reused.
const tmuxTmpDir = childTmuxTmpDir()

const redirected = preloadRedirectedEnv(process.env, home, tmuxTmpDir)
for (const name of PRELOAD_ENV_NAMES) {
  const value = redirected[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const failures = preloadCheckFailures(process.env)
if (failures.length > 0) {
  throw new Error(`host-safety preload: ${failures.join(', ')} (HOME ${String(process.env['HOME'])})`)
}
