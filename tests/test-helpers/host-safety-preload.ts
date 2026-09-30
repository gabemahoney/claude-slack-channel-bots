/**
 * test-helpers/host-safety-preload.ts — The `bun test` preload guard
 * (b.jg5 SRJ-1301). `bunfig.toml`'s `[test]` preload loads it once, before
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
 * What it sets, in `process.env`, and nothing else (`CLAUDE_CONFIG_DIR` is
 * not touched: `src/` never reads it from the environment):
 * - `HOME`: a new, empty `mkdtempSync` directory directly under the OS temp
 *   directory, named with `PRELOAD_HOME_PREFIX`. It is never removed: Bun's
 *   test runner fires no `exit` or `beforeExit` listener, and a child may
 *   still be using it when the run ends, so each run leaves one such
 *   directory in the OS temp directory;
 * - `PATH`: the absolute entries of the inherited `PATH`
 *   (`absolutePathEntries`; empty and relative entries are dropped because
 *   the client resolves them against the working directory), in order,
 *   duplicates dropped, without every directory that holds an
 *   `agent-director` entry (`dirHoldsAgentDirector`). With no entry left it
 *   is `EMPTY_CHILD_PATH`, so no lookup searches the working directory;
 * - `TMUX` and `TMUX_PANE`: unset, so nothing in the run is inside the host's
 *   tmux session;
 * - `TMUX_TMPDIR`: the process's one directory from `childTmuxTmpDir()` (the
 *   inherited one when the run was started with a valid one, else a new
 *   `CHILD_TMUX_TMPDIR_PREFIX` directory directly under the OS temp
 *   directory). `hostSafeChildEnv` hands the same directory to every child,
 *   and a `bun` child that loads the helper reuses it
 *   (`inheritedChildTmuxTmpDir`), so a run makes one such directory. It is
 *   never removed (a child may still be running tmux);
 * - `SLACK_STATE_DIR`: `<HOME>/.claude/channels/slack` under the new HOME
 *   (not created). It is set rather than unset because the state-directory
 *   resolvers in `src/` fall back to `os.homedir()` (the launch-time HOME)
 *   when it is unset.
 *
 * It then checks the result and throws, failing the run before any test file
 * loads, when: HOME is not that new directory, is the real home
 * (`isRealHome`) or holds an agent-director install
 * (`homeHoldsAgentDirectorInstall`); a `PATH` entry is empty or relative or
 * holds an `agent-director`; `TMUX` or `TMUX_PANE` is set; `TMUX_TMPDIR` is
 * not a directory `inheritedChildTmuxTmpDir` accepts; or `SLACK_STATE_DIR` is
 * not under the new HOME. The message names the check and the path at fault
 * and never prints the environment.
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
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path'
import {
  EMPTY_CHILD_PATH,
  PRELOAD_HOME_PREFIX,
  absolutePathEntries,
  childTmuxTmpDir,
  dirHoldsAgentDirector,
  homeHoldsAgentDirectorInstall,
  inheritedChildTmuxTmpDir,
  isRealHome,
} from './host-safe-env.ts'

function fail(check: string, detail: string): never {
  throw new Error(`host-safety preload: ${check}: ${detail}`)
}

// --- Redirect -----------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), PRELOAD_HOME_PREFIX))

const pathDirs = [...new Set(absolutePathEntries(process.env['PATH']))].filter((dir) => !dirHoldsAgentDirector(dir))

// Read before TMUX_TMPDIR is replaced: a valid inherited directory is reused.
const tmuxTmpDir = childTmuxTmpDir()

process.env['HOME'] = home
process.env['PATH'] = pathDirs.length === 0 ? EMPTY_CHILD_PATH : pathDirs.join(delimiter)
delete process.env['TMUX']
delete process.env['TMUX_PANE']
process.env['TMUX_TMPDIR'] = tmuxTmpDir
process.env['SLACK_STATE_DIR'] = join(home, '.claude', 'channels', 'slack')

// --- Verify -------------------------------------------------------------------

const newHome = process.env['HOME']
if (newHome !== home || !isAbsolute(newHome) || dirname(newHome) !== tmpdir()) {
  fail('home-not-temp', `HOME ${String(newHome)} is not the preload's directory under the OS temp directory`)
}
if (isRealHome(newHome)) {
  fail('real-home', `HOME ${newHome} is the real home`)
}
if (homeHoldsAgentDirectorInstall(newHome)) {
  fail('home-holds-install', `HOME ${newHome} holds an agent-director install`)
}

const finalPath = process.env['PATH']
if (finalPath !== EMPTY_CHILD_PATH) {
  for (const dir of (finalPath ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) {
      fail('path-entry-not-absolute', `PATH entry ${JSON.stringify(dir)} is empty or relative`)
    }
    if (dirHoldsAgentDirector(dir)) {
      fail('path-dir-holds-agent-director', `PATH directory ${dir} holds agent-director`)
    }
  }
}

if (process.env['TMUX'] !== undefined || process.env['TMUX_PANE'] !== undefined) {
  fail('tmux-session-set', 'TMUX or TMUX_PANE is still set')
}
if (inheritedChildTmuxTmpDir(process.env['TMUX_TMPDIR']) !== tmuxTmpDir) {
  fail('tmux-tmpdir-not-temp', `TMUX_TMPDIR ${String(process.env['TMUX_TMPDIR'])} is not the process's fenced temp directory`)
}

const stateDir = process.env['SLACK_STATE_DIR']
if (stateDir === undefined || !stateDir.startsWith(newHome + sep)) {
  fail('state-dir-not-under-home', `SLACK_STATE_DIR ${String(stateDir)} is not under HOME ${newHome}`)
}
