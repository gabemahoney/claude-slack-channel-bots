/**
 * test-helpers/host-safety-preload.ts — The `bun test` preload guard
 * (b.jg5 SRJ-1301). The `[test]` preload of `bunfig.toml` (the repository
 * root's, and that of each directory holding test files, for a run started
 * there) loads it once, before any test file; it runs for its side effects
 * only, exports nothing, and no test file imports it.
 *
 * The agent-director client's `Client.create()` and
 * `resolveSystemBinary()` read `process.env.HOME` and `process.env.PATH` when
 * called, so after this guard a test that forgot its stub fails in process
 * with `ErrSystemInstallNotFound` instead of reaching the host's real install
 * and store. Bun fixes `os.homedir()` (and `os.userInfo().homedir`) at
 * start-up from the launch-time HOME, and the guard cannot move it: every
 * `homedir()` call during the run (the start gate's `state.db` path, the
 * state-directory resolvers' fallback, `~` expansion) answers the launch-time
 * home. That is why the guard refuses to start when that home could reach the
 * operator's real state, and why the run is started with a scratch HOME (see
 * `tests/README.md`).
 *
 * What it does, in order:
 * 1. refuses to start, before anything else: for each launch-time home
 *    (`launchTimeHomes()`), the shared, pure
 *    `launchHomeRefusal(launchHome, passwdHome(), LIVE_LAUNCH_HOME_PROBE)`
 *    decides (see its doc in `host-safe-env.ts`: a home that is not
 *    absolute; the real home or a path under it; a home holding
 *    `.claude/channels/slack`; a home one of whose `homedir()`-derived paths,
 *    `LAUNCH_HOME_DERIVED_PATHS`, resolves through a symlink into the real
 *    home; a home holding an agent-director install; and, when the account
 *    has no `/etc/passwd` entry, a home or derived path that does not resolve
 *    strictly under the OS temp directory). On a refusal it writes
 *    `launchHomeRefusalMessage(reason, launchHome)` (the reason label and the
 *    launch-time home, never the environment) to stderr and exits with
 *    `LAUNCH_HOME_REFUSED_EXIT_CODE`, so no test file loads, no directory is
 *    made and nothing under that home is read beyond the probe's lstat,
 *    realpath and readlink of the paths the rules name (none at all for a
 *    home that is or lies lexically under the real home);
 * 2. makes a new, empty `mkdtempSync` HOME directly under the OS temp
 *    directory (`osTempDir()`), named with `PRELOAD_HOME_PREFIX`. It is never
 *    removed: Bun's test runner fires no `exit` or `beforeExit` listener, and
 *    a child may still be using it when the run ends, so each run leaves one
 *    such directory in the OS temp directory;
 * 3. takes the process's one fenced `TMUX_TMPDIR` directory from
 *    `childTmuxTmpDir()` (the inherited one when the run was started with a
 *    valid one, else a new `CHILD_TMUX_TMPDIR_PREFIX` directory directly under
 *    the OS temp directory; never removed, a child may still be running tmux).
 *    `hostSafeChildEnv` hands the same directory to every child;
 * 4. computes the redirected variables with the shared, side-effect-free
 *    `preloadRedirectedEnv(process.env, home, tmuxTmpDir)` (see its doc in
 *    `host-safe-env.ts`: `HOME`, the cleaned `PATH`, `TMUX_TMPDIR`,
 *    `SLACK_STATE_DIR` under the new HOME; `TMUX`, `TMUX_PANE` and
 *    `CLAUDE_CONFIG_DIR` unset) and applies it to `process.env`: each of
 *    `PRELOAD_ENV_NAMES` is set to its value or deleted when it has none.
 *    Nothing else in `process.env` is touched. `SLACK_STATE_DIR` is set
 *    rather than unset because the state-directory resolvers in `src/` fall
 *    back to `os.homedir()` (the launch-time HOME) when it is unset.
 *    `CLAUDE_CONFIG_DIR` is unset because it names a Claude configuration
 *    directory (a run started from a bot's session can inherit its
 *    persona's) that Claude Code, a hook or any code honouring it would read
 *    and write;
 * 5. runs the shared `preloadCheckFailures` on the result (the same check the
 *    host-safety test runs on the live environment) and throws, failing the
 *    run before any test file loads, when it reports anything. The message
 *    names the failed checks (`PRELOAD_CHECK` labels) and HOME, and never
 *    prints the environment.
 *
 * The `bunfig.toml` of the repository root and of every directory holding
 * test files (`tests/`, `tests/integration/`) loads it: Bun reads
 * `bunfig.toml` only from the working directory `bun test` starts in and
 * resolves a relative preload path against that directory, so each file
 * names the guard relative to its own directory. A run started in a
 * directory with no such `bunfig.toml` (one outside the repository, such as
 * the directory holding the checkout, or one inside it holding no test file)
 * runs without the guard. Only `bun test` loads it: a `bun -e` or
 * `bun <file>` child a test starts (`runInFakeHome`, say) runs without it,
 * under the fake home `hostSafeChildEnv` gave it.
 *
 * Isolation: it starts no process and imports no value from
 * `agent-director`. Its only reads are the helper's (`/etc/passwd`, the
 * launch-home probe's lstat, realpath and readlink, the `agent-director`
 * entry name in each inherited `PATH` directory, the new HOME's install
 * entries, the `TMUX_TMPDIR` directory); it reads nothing else under the
 * real home. Its
 * only writes are the new HOME and, when none was inherited, the
 * `TMUX_TMPDIR` directory, both under the OS temp directory, and neither is
 * made for a refused run.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import {
  LAUNCH_HOME_REFUSED_EXIT_CODE,
  LIVE_LAUNCH_HOME_PROBE,
  PRELOAD_ENV_NAMES,
  PRELOAD_HOME_PREFIX,
  childTmuxTmpDir,
  launchHomeRefusal,
  launchHomeRefusalMessage,
  launchTimeHomes,
  osTempDir,
  passwdHome,
  preloadCheckFailures,
  preloadRedirectedEnv,
} from './host-safe-env.ts'

for (const launchHome of launchTimeHomes()) {
  const refusal = launchHomeRefusal(launchHome, passwdHome(), LIVE_LAUNCH_HOME_PROBE)
  if (refusal !== undefined) {
    process.stderr.write(`${launchHomeRefusalMessage(refusal, launchHome)}\n`)
    process.exit(LAUNCH_HOME_REFUSED_EXIT_CODE)
  }
}

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
