/**
 * launch-home-guard.test.ts — The `bun test` preload guard refuses to start
 * when the home the run was launched with could reach the operator's real
 * Claude, Slack or agent-director state, and `/publish`'s preflight starts the
 * suite with a scratch HOME (bug b.59h).
 *
 * Bun fixes `os.homedir()` at start-up from the launch-time HOME, so code that
 * calls it during a run resolves against that home whatever the preload sets
 * `process.env.HOME` to. The guard (`tests/test-helpers/host-safety-preload.ts`)
 * therefore checks each launch-time home with the shared, pure
 * `launchHomeRefusal` before anything else.
 *
 * Sections:
 * - `passwdHomeFrom` over passwd texts: the first line whose uid field is
 *   exactly the uid decides (a uid that is a prefix of another, a gid equal to
 *   the uid, a padded uid and a shorter line do not match), giving its home
 *   only when the line has seven fields and an absolute home; a malformed first
 *   match gives `undefined` even with a well-formed one after it; no match, an
 *   invalid uid or a text that is not a string give `undefined`.
 * - `launchHomeRefusal` over a recording fake probe: each rule
 *   (`LAUNCH_HOME_REFUSAL`) and the order in which they win, with the passwd
 *   home known and, failing closed, unknown (none, or not absolute: the home
 *   and every derived path must then resolve strictly under the temp
 *   directory, which must not resolve to the file system root); every path in
 *   `LAUNCH_HOME_DERIVED_PATHS` resolving into the real home, or out of the
 *   temp directory, has its own row; nothing probed for a home that is not
 *   absolute or that is, or lies under, the real home by path text (trailing
 *   `/` and `..` spellings included); with the passwd home unknown and a temp
 *   directory resolving to the root, the probe is asked only for the temp
 *   directory and its canonical form; a temp directory that is another
 *   ancestor of a home (`/home`) lets that home through unless it holds Slack
 *   state or an install (the documented limit); and the probe is only ever
 *   asked about the launch home, the entries the rules name under it and the
 *   real home itself (with the passwd home unknown, the temp directory
 *   instead).
 * - `LIVE_LAUNCH_HOME_PROBE` on fixtures under the case's root, with a fake
 *   real home (one holding `.claude/channels/slack`) passed as the passwd
 *   home: symlinked homes, a symlinked real home, symlinks at and below
 *   `.claude` and `.agent-director` (live, dangling, relative, chained,
 *   through a symlinked parent, looping), a dangling Slack-state symlink,
 *   agent-director entries, clean homes; then with no passwd home, against
 *   the OS temp directory. The fixtures are left unchanged. An entry that
 *   cannot be looked at counts as present (skipped as root).
 * - The guard in a `bun test` child started from the repository root,
 *   `tests/` and `tests/integration/` (each `bunfig.toml`): launched with a
 *   fake home holding `.claude/channels/slack`, it exits with
 *   `LAUNCH_HOME_REFUSED_EXIT_CODE`, writes only `launchHomeRefusalMessage`'s
 *   line, loads no test file, leaves the fake home unchanged and makes no
 *   directory; launched with an empty fake home, it loads the fixture with
 *   `homedir()` the fake home and HOME the preload's own.
 * - This run: `launchTimeHomes()` holds `os.homedir()`, and the
 *   `homedir()`-derived defaults in `src/` (the server state directory with
 *   `SLACK_STATE_DIR` unset, the Claude config directory, the default JSONL
 *   transcript root, `~`, the crontable's default with `SLACK_STATE_DIR` and
 *   `XDG_CONFIG_HOME` unset, the start gate's `state.db` path,
 *   agent-director's store path) resolve under it and outside the account's passwd home (with
 *   no passwd entry, strictly under the OS temp directory). This run was
 *   accepted by the guard, so that is where every `homedir()` call in it
 *   lands.
 * - `scripts/preflight.sh`'s SR-2.3 block, read from the script and run on
 *   its own under bash with a stub `bun` that records each call: `bun test`
 *   runs once, under a new HOME directory in `TMPDIR` with `SLACK_STATE_DIR`
 *   under it and without the Slack token variables, `CSCB_PERSONA` or
 *   `CLAUDE_CONFIG_DIR`, and the directory is removed whether the suite
 *   passes or fails; a failing suite, a suite the guard refused (exit
 *   `LAUNCH_HOME_REFUSED_EXIT_CODE`) and a failing `mktemp -d` exit 13 with
 *   their SR-2.3 lines.
 *
 * No test touches the real `~/.claude`: every `homedir()`-derived path in a
 * run resolves under a launch-time home the guard accepted (this file's "this
 * run" section and the refusal rules above), and the only way a test can name
 * the real home's path, `realHome()` or `passwdHome()` from `host-safe-env.ts`,
 * is referenced only by the guard's own files (the audit in
 * `tests/host-safety.test.ts`, `REAL_HOME_FILES`).
 *
 * Isolation: every case writes only under its own `mkdtempSync` root, removed
 * in `afterEach`. Each child gets a direct `hostSafeChildEnv` call with
 * `TMPDIR` pointed at a directory under the root and a HOME under that
 * `TMPDIR`, so the guard accepts the empty home on any host (with no passwd
 * entry, a home must lie under the temp directory) and the preload HOME and
 * fenced `TMUX_TMPDIR` a child's guard makes land under the root too. The
 * only launch home that looks like an operator's is a fake one under the
 * root; no case reads anything under the real home or launches a process
 * with it. The no-passwd live rows look only at the OS temp directory itself
 * (realpath) and at absent paths outside it (lstat, readlink). The token
 * variables a child gets are fakes (`fakeToken`), and every child's output
 * goes through `assertNoLeak`. The preflight block runs with a stub `bun`
 * first on `PATH` and never reaches git, npm or a real `bun`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AGENT_DIRECTOR_INSTALL_DIR,
  AGENT_DIRECTOR_INSTALL_PATH,
  CLAUDE_DIR,
  LAUNCH_HOME_DERIVED_PATHS,
  LAUNCH_HOME_REFUSAL,
  LAUNCH_HOME_REFUSED_EXIT_CODE,
  LIVE_LAUNCH_HOME_PROBE,
  type LaunchHomeProbe,
  type LaunchHomeRefusal,
  PRELOAD_HOME_PREFIX,
  PRELOAD_STATE_DIR_PATH,
  hostSafeChildEnv,
  isUnder,
  launchHomeRefusal,
  launchHomeRefusalMessage,
  launchTimeHomes,
  osTempDir,
  passwdHome,
  passwdHomeFrom,
} from './test-helpers/host-safe-env.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makePersonaConfig } from './test-helpers/persona-config.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'
import { DEFAULT_STORE_PATH } from '../src/agent-director-client.ts'
import { DEFAULT_STATE_DB_PATH } from '../src/agent-director-startup.ts'
import { resolveDefaultCronTablePath, resolveServerStateDir } from '../src/config.ts'
import { resolveJsonlRoots } from '../src/jsonl-persistence-check.ts'
import { expandTilde, resolveClaudeConfigDir } from '../src/persona-identity.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..')
const TESTS_DIR = import.meta.dir
const PREFLIGHT_PATH = join(REPO_ROOT, 'scripts', 'preflight.sh')
const IS_ROOT = process.getuid?.() === 0
/** The account's passwd home: the real home the guard compares against. */
const PASSWD_HOME = passwdHome()
const R = LAUNCH_HOME_REFUSAL
/**
 * The paths under a home that `src/` and the agent-director client derive
 * from `homedir()`, written out here so that one dropped from
 * `LAUNCH_HOME_DERIVED_PATHS` fails its live row. All but the Slack state
 * directory, whose mere presence is its own rule (its symlinked-parent case
 * is a row of the live table).
 */
const LINKABLE_DERIVED_PATHS: string[] = [
  CLAUDE_DIR,
  join(CLAUDE_DIR, 'projects'),
  join(CLAUDE_DIR, 'skills'),
  join(CLAUDE_DIR, 'slack-mcp.json'),
  AGENT_DIRECTOR_INSTALL_DIR,
  join(AGENT_DIRECTOR_INSTALL_DIR, 'state.db'),
  join(AGENT_DIRECTOR_INSTALL_DIR, 'config.toml'),
  AGENT_DIRECTOR_INSTALL_PATH,
  '.config',
  join('.config', 'cscb'),
  join('.config', 'cscb', 'crontab'),
]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-home-guard-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A new directory at `name` under the case's root (parents created). */
function dirUnder(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A symlink at `name` under the case's root pointing at `target` (parents created). */
function linkUnder(name: string, target: string): string {
  const link = join(root, name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link)
  return link
}

// ---------------------------------------------------------------------------
// passwdHomeFrom over passwd texts
// ---------------------------------------------------------------------------

describe('passwdHomeFrom', () => {
  /** A seven-field passwd line: name, password, uid, gid, GECOS, home, shell. */
  const entry = (name: string, uid: string, home: string): string => `${name}:x:${uid}:${uid}:${name}:${home}:/bin/sh`
  const passwdText = (...lines: string[]): string => `${lines.join('\n')}\n`
  const OPERATOR = entry('operator', '1000', '/home/operator')
  const SECOND = entry('second', '1000', '/home/second')
  const OTHER = entry('other', '10000', '/home/other')

  const rows: [label: string, expected: string | undefined, text: string, uid: number][] = [
    ['the matching line among others', '/home/operator', passwdText(entry('root', '0', '/root'), OPERATOR, entry('nobody', '65534', '/nonexistent')), 1000],
    ['uid 0', '/root', passwdText(entry('root', '0', '/root'), OPERATOR), 0],
    ['uid 1000 after a line for uid 10000', '/home/operator', passwdText(OTHER, OPERATOR), 1000],
    ['uid 10000 after a line for uid 1000', '/home/other', passwdText(OPERATOR, OTHER), 10000],
    ['lines too short to have a uid field, then the match', '/home/operator', passwdText('operator', 'operator:x', '', OPERATOR), 1000],
    ['a line whose gid, not its uid, is the uid', undefined, passwdText('group:x:2000:1000:group:/home/group:/bin/sh'), 1000],
    ['a match with fewer than seven fields', undefined, passwdText('operator:x:1000:1000:operator:/home/operator'), 1000],
    ['a match with an empty home', undefined, passwdText(entry('operator', '1000', '')), 1000],
    ['a match with a relative home', undefined, passwdText(entry('operator', '1000', 'home/operator')), 1000],
    ['no line for the uid', undefined, passwdText(entry('root', '0', '/root'), OTHER), 1000],
    ['an empty text', undefined, '', 1000],
    ['two matching lines (the first wins)', '/home/operator', passwdText(OPERATOR, SECOND), 1000],
    ['two matching lines, the first with a relative home (it still decides)', undefined, passwdText(entry('operator', '1000', 'home/operator'), SECOND), 1000],
    ['two matching lines, the first with fewer than seven fields (it still decides)', undefined, passwdText('operator:x:1000', SECOND), 1000],
    ['a uid padded with a leading zero', undefined, passwdText(entry('operator', '01000', '/home/operator')), 1000],
    ['a uid padded with a space', undefined, passwdText(entry('operator', ' 1000', '/home/operator')), 1000],
    // Each line below would match String(uid): only the uid's own check refuses it.
    ['a negative uid', undefined, passwdText(entry('negative', '-1', '/home/negative')), -1],
    ['a fractional uid', undefined, passwdText(entry('fraction', '1.5', '/home/fraction')), 1.5],
    ['NaN as the uid', undefined, passwdText(entry('nan', 'NaN', '/home/nan')), Number.NaN],
    ['a uid past the safe integers', undefined, passwdText(entry('big', String(2 ** 53), '/home/big')), 2 ** 53],
    // As the file reads without an encoding: a Buffer, not a string.
    ['a Buffer in place of the text', undefined, Buffer.from(passwdText(OPERATOR)) as unknown as string, 1000],
    ['undefined in place of the text', undefined, undefined as unknown as string, 1000],
  ]

  test.each(rows)('%s: %p', (_label, expected, text, uid) => {
    expect(passwdHomeFrom(text, uid)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// launchHomeRefusal over a recording fake probe
// ---------------------------------------------------------------------------

describe('launchHomeRefusal (recording fake probe)', () => {
  const REAL = '/home/operator'
  /** The fake OS temp directory, for the rows with no passwd home. */
  const TEMP = '/tmp'
  /** A launch home outside the temp directory, for the rows with a passwd home. */
  const HOME = '/scratch/home'
  /** A launch home strictly under the temp directory, for the rows with no passwd home. */
  const T_HOME = join(TEMP, 'scratch-home')
  const SLACK = join(HOME, PRELOAD_STATE_DIR_PATH)
  const CLAUDE = join(HOME, CLAUDE_DIR)
  const AD_DIR = join(HOME, AGENT_DIRECTOR_INSTALL_DIR)
  const AD_BIN = join(HOME, AGENT_DIRECTOR_INSTALL_PATH)
  const T_SLACK = join(T_HOME, PRELOAD_STATE_DIR_PATH)
  const T_CLAUDE = join(T_HOME, CLAUDE_DIR)
  const T_AD_DIR = join(T_HOME, AGENT_DIRECTOR_INSTALL_DIR)

  /**
   * The fake file system a row describes: paths that exist, paths whose
   * canonical form differs from the lexical one, and the temp directory
   * (`TEMP` unless given).
   */
  interface FakeFs {
    exists?: readonly string[]
    links?: Readonly<Record<string, string>>
    tempDir?: string
  }

  /** A probe over `fs` that records every question asked of it, as `exists <path>`, `canonical <path>` or `tempDir`. */
  function recordingProbe(fs: FakeFs): { probe: LaunchHomeProbe; asked: string[] } {
    const asked: string[] = []
    const present = new Set(fs.exists ?? [])
    return {
      asked,
      probe: {
        exists: (path) => {
          asked.push(`exists ${path}`)
          return present.has(path)
        },
        canonical: (path) => {
          asked.push(`canonical ${path}`)
          return fs.links?.[path] ?? resolve(path)
        },
        tempDir: () => {
          asked.push('tempDir')
          return fs.tempDir ?? TEMP
        },
      },
    }
  }

  /**
   * The questions the probe may be asked about `launchHome`: its canonical
   * form, the entries the rules name under it, and the real home's canonical
   * form or, with the passwd home unknown, the temp directory and its
   * canonical form.
   */
  function allowedQuestions(launchHome: string, passwd: string | undefined, fs: FakeFs): Set<string> {
    const known = passwd !== undefined && isAbsolute(passwd)
    return new Set([
      `canonical ${launchHome}`,
      `exists ${join(launchHome, PRELOAD_STATE_DIR_PATH)}`,
      ...LAUNCH_HOME_DERIVED_PATHS.map((path) => `canonical ${join(launchHome, path)}`),
      `exists ${join(launchHome, AGENT_DIRECTOR_INSTALL_DIR)}`,
      `exists ${join(launchHome, AGENT_DIRECTOR_INSTALL_PATH)}`,
      ...(known ? [`canonical ${passwd}`] : ['tempDir', `canonical ${fs.tempDir ?? TEMP}`]),
    ])
  }

  // probed: false means the answer comes from the path text alone, with no question asked.
  type Row = [label: string, expected: LaunchHomeRefusal | undefined, launchHome: string, passwd: string | undefined, fs: FakeFs, probed: boolean]

  const rows: Row[] = [
    // Not absolute, whatever the passwd home.
    ['an empty path', R.notAbsolute, '', REAL, {}, false],
    ['a relative path, even one holding Slack state and an install', R.notAbsolute, 'scratch/home', REAL, {
      exists: [join('scratch/home', PRELOAD_STATE_DIR_PATH), join('scratch/home', AGENT_DIRECTOR_INSTALL_DIR)],
    }, false],
    ['a relative path, with no passwd home', R.notAbsolute, 'tmp/scratch-home', undefined, {}, false],

    // The passwd home known: the real-home rules.
    ['the real home', R.inRealHome, REAL, REAL, {}, false],
    ['the real home with a trailing /', R.inRealHome, `${REAL}/`, REAL, {}, false],
    ['the real home spelled through ..', R.inRealHome, '/scratch/../home/operator', REAL, {}, false],
    ['a path under the real home', R.inRealHome, join(REAL, 'scratch'), REAL, {}, false],
    ['a path under the real home spelled through ..', R.inRealHome, `${REAL}/a/../b`, REAL, {}, false],
    ['the real home, with the passwd home given with a trailing /', R.inRealHome, REAL, `${REAL}/`, {}, false],
    ['the real home holding Slack state and an install (the real-home rule wins)', R.inRealHome, REAL, REAL, {
      exists: [join(REAL, PRELOAD_STATE_DIR_PATH), join(REAL, AGENT_DIRECTOR_INSTALL_DIR)],
    }, false],
    ['a path under the temp directory inside the real home (the temp rules do not apply)', R.inRealHome, join(REAL, 'tmp', 'scratch-home'), REAL, {
      tempDir: join(REAL, 'tmp'),
    }, false],
    ['a symlink to the real home', R.inRealHome, HOME, REAL, { links: { [HOME]: REAL } }, true],
    ['a symlink to a path under the real home', R.inRealHome, HOME, REAL, { links: { [HOME]: join(REAL, 'scratch') } }, true],
    ['a path under the target of a real home that is a symlink', R.inRealHome, HOME, REAL, {
      links: { [REAL]: '/data/operator', [HOME]: '/data/operator/scratch' },
    }, true],
    ['a symlink to the real home holding Slack state (the real-home rule wins)', R.inRealHome, HOME, REAL, {
      exists: [SLACK],
      links: { [HOME]: REAL },
    }, true],
    ['a home holding Slack state', R.holdsSlackState, HOME, REAL, { exists: [SLACK] }, true],
    ['a home holding Slack state and an install, whose .claude leads into the real home (the Slack-state rule wins)', R.holdsSlackState, HOME, REAL, {
      exists: [SLACK, AD_DIR],
      links: { [CLAUDE]: join(REAL, CLAUDE_DIR) },
    }, true],
    ['a home whose .claude is the real home itself', R.derivedPathInRealHome, HOME, REAL, { links: { [CLAUDE]: REAL } }, true],
    ['a home whose .claude leads into the target of a real home that is a symlink', R.derivedPathInRealHome, HOME, REAL, {
      links: { [REAL]: '/data/operator', [CLAUDE]: '/data/operator/.claude' },
    }, true],
    ['a home holding an install, whose .claude leads into the real home (the derived-path rule wins)', R.derivedPathInRealHome, HOME, REAL, {
      exists: [AD_DIR],
      links: { [CLAUDE]: join(REAL, CLAUDE_DIR) },
    }, true],
    ['a home whose .agent-director is a symlink into the real home (the derived-path rule wins)', R.derivedPathInRealHome, HOME, REAL, {
      exists: [AD_DIR],
      links: { [AD_DIR]: join(REAL, AGENT_DIRECTOR_INSTALL_DIR) },
    }, true],
    ['a home holding .agent-director', R.holdsAgentDirector, HOME, REAL, { exists: [AD_DIR] }, true],
    ['a home holding only the standard install path', R.holdsAgentDirector, HOME, REAL, { exists: [AD_BIN] }, true],
    ['a clean home', undefined, HOME, REAL, {}, true],
    ['a home whose .claude leads outside the real home', undefined, HOME, REAL, { links: { [CLAUDE]: '/data/claude' } }, true],
    ['a sibling of the real home sharing its name as a prefix', undefined, `${REAL}-scratch`, REAL, {}, true],
    ['a clean home, with a temp directory that is the root (the temp-directory rules apply only with no passwd home)', undefined, HOME, REAL, { tempDir: '/' }, true],

    // The passwd home unknown: the guard fails closed, so the home and every derived path must resolve strictly under the temp directory.
    ['the would-be real home, with no passwd home', R.notUnderTempDir, REAL, undefined, {}, true],
    ['the would-be real home, with a relative passwd home (taken as none)', R.notUnderTempDir, REAL, 'home/operator', {}, true],
    ['the would-be real home, with an empty passwd home (taken as none)', R.notUnderTempDir, REAL, '', {}, true],
    ['a home outside the temp directory, with no passwd home', R.notUnderTempDir, HOME, undefined, {}, true],
    ['a home outside the temp directory holding Slack state, with no passwd home (the temp-directory rule wins)', R.notUnderTempDir, HOME, undefined, {
      exists: [SLACK],
    }, true],
    ['the temp directory itself, with no passwd home', R.notUnderTempDir, TEMP, undefined, {}, true],
    ['the temp directory with a trailing /, with no passwd home', R.notUnderTempDir, `${TEMP}/`, undefined, {}, true],
    ['a sibling of the temp directory sharing its name as a prefix, with no passwd home', R.notUnderTempDir, `${TEMP}x/home`, undefined, {}, true],
    ['a path that leaves the temp directory through .., with no passwd home', R.notUnderTempDir, `${TEMP}/../scratch/home`, undefined, {}, true],
    ['a home under the temp directory that is a symlink out of it, with no passwd home', R.notUnderTempDir, T_HOME, undefined, {
      links: { [T_HOME]: '/data/home' },
    }, true],
    ['a home under the lexical form of a temp directory that is a symlink, with no passwd home (compared resolved)', R.notUnderTempDir, T_HOME, undefined, {
      links: { [TEMP]: '/private/tmp' },
    }, true],
    ['a home under the resolved form of a temp directory that is a symlink, with no passwd home', undefined, '/private/tmp/scratch-home', undefined, {
      links: { [TEMP]: '/private/tmp' },
    }, true],
    ['a clean home under the temp directory, with no passwd home', undefined, T_HOME, undefined, {}, true],
    ['a home under the temp directory whose .claude leads elsewhere under it, with no passwd home', undefined, T_HOME, undefined, {
      links: { [T_CLAUDE]: join(TEMP, 'claude') },
    }, true],
    ['a home under the temp directory holding Slack state, with no passwd home', R.holdsSlackState, T_HOME, undefined, { exists: [T_SLACK] }, true],
    ['a home under the temp directory holding Slack state, whose .claude leads out of it, with no passwd home (the Slack-state rule wins)', R.holdsSlackState, T_HOME, undefined, {
      exists: [T_SLACK],
      links: { [T_CLAUDE]: '/data/claude' },
    }, true],
    ['a home whose .claude leads into the would-be real home, with no passwd home', R.derivedPathNotUnderTempDir, T_HOME, undefined, {
      links: { [T_CLAUDE]: join(REAL, CLAUDE_DIR) },
    }, true],
    ['a home whose .claude is the temp directory itself, with no passwd home', R.derivedPathNotUnderTempDir, T_HOME, undefined, {
      links: { [T_CLAUDE]: TEMP },
    }, true],
    ['a home holding .agent-director, whose .claude leads out of the temp directory, with no passwd home (the derived-path rule wins)', R.derivedPathNotUnderTempDir, T_HOME, undefined, {
      exists: [T_AD_DIR],
      links: { [T_CLAUDE]: '/data/claude' },
    }, true],
    ['a home under the temp directory holding .agent-director, with no passwd home', R.holdsAgentDirector, T_HOME, undefined, { exists: [T_AD_DIR] }, true],
    // The documented limit: a temp directory that is an ancestor of a home other than the root lets that home through the temp-directory rules.
    ['the would-be real home, empty, under the temp directory /home, with no passwd home (accepted)', undefined, REAL, undefined, { tempDir: '/home' }, true],
    ['the would-be real home holding Slack state, under the temp directory /home, with no passwd home', R.holdsSlackState, REAL, undefined, {
      exists: [join(REAL, PRELOAD_STATE_DIR_PATH)],
      tempDir: '/home',
    }, true],
    ['the would-be real home holding .agent-director, under the temp directory /home, with no passwd home', R.holdsAgentDirector, REAL, undefined, {
      exists: [join(REAL, AGENT_DIRECTOR_INSTALL_DIR)],
      tempDir: '/home',
    }, true],

    // Every derived path, one row each: resolving into the real home, or out of the temp directory with no passwd home.
    ...LAUNCH_HOME_DERIVED_PATHS.map((path): Row => [
      `a home whose ${path} resolves into the real home (through a symlink at or above it)`,
      R.derivedPathInRealHome,
      HOME,
      REAL,
      { links: { [join(HOME, path)]: join(REAL, 'elsewhere', path) } },
      true,
    ]),
    ...LAUNCH_HOME_DERIVED_PATHS.map((path): Row => [
      `a home under the temp directory whose ${path} resolves out of it, with no passwd home`,
      R.derivedPathNotUnderTempDir,
      T_HOME,
      undefined,
      { links: { [join(T_HOME, path)]: join('/data', path) } },
      true,
    ]),
  ]

  test.each(rows)('%s: %p', (_label, expected, launchHome, passwd, fs, probed) => {
    const { probe, asked } = recordingProbe(fs)
    const allowed = probed ? allowedQuestions(launchHome, passwd, fs) : new Set<string>()

    expect(launchHomeRefusal(launchHome, passwd, probe)).toBe(expected)
    expect(asked.filter((question) => !allowed.has(question))).toEqual([])
  })

  // With the passwd home unknown, a temp directory that resolves to the root is refused before anything about the launch home is asked.
  const rootTempRows: [label: string, launchHome: string, passwd: string | undefined, fs: FakeFs][] = [
    ['the would-be real home, with the temp directory /', REAL, undefined, { tempDir: '/' }],
    ['a home holding Slack state and an install, with the temp directory / (the root rule wins)', HOME, undefined, {
      exists: [SLACK, AD_DIR],
      tempDir: '/',
    }],
    ['a home under a temp directory that is a symlink to /', T_HOME, undefined, { links: { [TEMP]: '/' } }],
    ['a home, with the temp directory spelled /tmp/..', HOME, undefined, { tempDir: `${TEMP}/..` }],
    ['the would-be real home, with the temp directory / and a relative passwd home (taken as none)', REAL, 'home/operator', { tempDir: '/' }],
  ]

  test.each(rootTempRows)('%s: tempDirIsRoot, asking only for the temp directory and its canonical form', (_label, launchHome, passwd, fs) => {
    const { probe, asked } = recordingProbe(fs)

    expect(launchHomeRefusal(launchHome, passwd, probe)).toBe(R.tempDirIsRoot)
    expect(asked).toEqual(['tempDir', `canonical ${fs.tempDir ?? TEMP}`])
  })
})

// ---------------------------------------------------------------------------
// LIVE_LAUNCH_HOME_PROBE on fixtures
// ---------------------------------------------------------------------------

describe('launchHomeRefusal with LIVE_LAUNCH_HOME_PROBE (fixtures under the root, a fake real home)', () => {
  /** A fake real home under the root, shaped like an operator's: it holds `.claude/channels/slack`. */
  function fakeRealHome(): string {
    const real = dirUnder('real')
    mkdirSync(join(real, PRELOAD_STATE_DIR_PATH), { recursive: true })
    return real
  }

  /** A launch home under the root holding a symlink at `path` (relative to it) pointing at `target`; parents made as directories. */
  function homeWithLink(path: string, target: string): string {
    const home = dirUnder('home')
    linkUnder(join('home', path), target)
    return home
  }

  // Each row builds its fixture next to the fake real home and returns the launch home (and the passwd home, when not the fake real home).
  type LiveRow = [label: string, expected: LaunchHomeRefusal | undefined, build: (real: string) => { launchHome: string; passwd?: string }]

  const rows: LiveRow[] = [
    ['a symlink to the fake real home', R.inRealHome, (real) => ({ launchHome: linkUnder('home-link', real) })],
    ['a symlink to a directory under the fake real home', R.inRealHome, () => ({ launchHome: linkUnder('home-link', dirUnder('real/scratch')) })],
    ['a directory under the target of a passwd home that is a symlink', R.inRealHome, (real) => ({
      launchHome: dirUnder('real/scratch'),
      passwd: linkUnder('real-link', real),
    })],
    ['a home whose .claude is a symlink to the fake real home’s .claude, which holds Slack state', R.holdsSlackState, (real) => ({
      launchHome: homeWithLink(CLAUDE_DIR, join(real, CLAUDE_DIR)),
    })],
    ['a home whose .claude/channels is a symlink to the fake real home’s, which holds Slack state', R.holdsSlackState, (real) => ({
      launchHome: homeWithLink(join(CLAUDE_DIR, 'channels'), join(real, CLAUDE_DIR, 'channels')),
    })],
    ['a home holding a dangling .claude/channels/slack symlink', R.holdsSlackState, () => ({
      launchHome: homeWithLink(PRELOAD_STATE_DIR_PATH, join(root, 'no-such-state')),
    })],
    ['a home whose .claude is a symlink to a directory in the fake real home', R.derivedPathInRealHome, () => ({
      launchHome: homeWithLink(CLAUDE_DIR, dirUnder('real/claude-copy')),
    })],
    ['a home whose .claude is a relative dangling symlink into the fake real home', R.derivedPathInRealHome, () => ({
      launchHome: homeWithLink(CLAUDE_DIR, join('..', 'real', 'no-such-claude')),
    })],
    ['a home whose .claude is a chain of dangling symlinks, absolute and relative, ending in the fake real home', R.derivedPathInRealHome, (real) => {
      linkUnder('hop-1', join(root, 'hop-2'))
      linkUnder('hop-2', 'hop-3')
      linkUnder('hop-3', join(real, 'no-such-claude'))
      return { launchHome: homeWithLink(CLAUDE_DIR, join(root, 'hop-1')) }
    }],
    ['a home whose .claude/channels is a symlink to a directory in the fake real home without Slack state', R.derivedPathInRealHome, () => ({
      launchHome: homeWithLink(join(CLAUDE_DIR, 'channels'), dirUnder('real/channels-copy')),
    })],
    ['a home whose .claude/projects is a symlink to the fake real home’s .claude/projects', R.derivedPathInRealHome, (real) => {
      mkdirSync(join(real, CLAUDE_DIR, 'projects'))
      return { launchHome: homeWithLink(join(CLAUDE_DIR, 'projects'), join(real, CLAUDE_DIR, 'projects')) }
    }],
    ['a home whose .claude is a symlink to a directory outside the fake real home whose projects is a symlink into it', R.derivedPathInRealHome, () => {
      const elsewhere = dirUnder('elsewhere/claude')
      symlinkSync(dirUnder('real/projects-copy'), join(elsewhere, 'projects'))
      return { launchHome: homeWithLink(CLAUDE_DIR, elsewhere) }
    }],
    ['a home whose .claude is a symlink loop (its Slack-state path cannot be looked at, so counts as present)', R.holdsSlackState, () => {
      linkUnder(join('home', '.claude-b'), CLAUDE_DIR)
      return { launchHome: homeWithLink(CLAUDE_DIR, '.claude-b') }
    }],
    ['a home whose .claude/projects is a symlink loop (nothing can be written through it)', undefined, () => {
      linkUnder(join('home', CLAUDE_DIR, 'projects-b'), 'projects')
      return { launchHome: homeWithLink(join(CLAUDE_DIR, 'projects'), 'projects-b') }
    }],
    ['a home whose .agent-director is a symlink loop', R.holdsAgentDirector, () => {
      linkUnder(join('home', '.agent-director-b'), AGENT_DIRECTOR_INSTALL_DIR)
      return { launchHome: homeWithLink(AGENT_DIRECTOR_INSTALL_DIR, '.agent-director-b') }
    }],
    ['a home holding a .agent-director directory', R.holdsAgentDirector, () => {
      const home = dirUnder('home')
      mkdirSync(join(home, AGENT_DIRECTOR_INSTALL_DIR))
      return { launchHome: home }
    }],
    ['a home holding a dangling .agent-director symlink', R.holdsAgentDirector, () => ({
      launchHome: homeWithLink(AGENT_DIRECTOR_INSTALL_DIR, join(root, 'no-such-install')),
    })],
    ['an empty home', undefined, () => ({ launchHome: dirUnder('home') })],
    ['a home holding a real .claude with settings and no Slack state', undefined, () => {
      const home = dirUnder('home')
      writeFileSync(join(dirUnder(join('home', CLAUDE_DIR)), 'settings.json'), '{}')
      return { launchHome: home }
    }],
    ['a home whose .claude is a symlink to a directory outside the fake real home', undefined, () => ({
      launchHome: homeWithLink(CLAUDE_DIR, dirUnder('elsewhere/claude')),
    })],
  ]

  test.each(rows)('%s: %p', (_label, expected, build) => {
    const real = fakeRealHome()
    const { launchHome, passwd = real } = build(real)
    const before = treeSnapshot(root)

    expect(launchHomeRefusal(launchHome, passwd, LIVE_LAUNCH_HOME_PROBE)).toBe(expected)
    expect(treeSnapshot(root)).toEqual(before)
  })

  /** An absolute path outside the OS temp directory that does not exist, named after the case's root. */
  const outsideTemp = (): string => join('/', `no-such-dir-${basename(root)}`)

  // With no passwd home the guard fails closed: the launch home and every derived path must resolve strictly under the OS temp directory (the root lies under it).
  const noPasswdRows: [label: string, expected: LaunchHomeRefusal | undefined, build: () => string][] = [
    ['an empty home under the root', undefined, () => dirUnder('home')],
    ['the OS temp directory itself', R.notUnderTempDir, () => osTempDir()],
    ['a dangling symlink to a path outside the OS temp directory', R.notUnderTempDir, () => linkUnder('home-link', join(outsideTemp(), 'home'))],
    ['a home holding Slack state', R.holdsSlackState, () => {
      const home = dirUnder('home')
      dirUnder(join('home', PRELOAD_STATE_DIR_PATH))
      return home
    }],
    ['a home whose .claude is a dangling symlink outside the OS temp directory', R.derivedPathNotUnderTempDir, () => homeWithLink(CLAUDE_DIR, join(outsideTemp(), CLAUDE_DIR))],
    ['a home whose .claude/projects is a symlink to the OS temp directory itself', R.derivedPathNotUnderTempDir, () => homeWithLink(join(CLAUDE_DIR, 'projects'), osTempDir())],
    ['a home holding a .agent-director directory', R.holdsAgentDirector, () => {
      const home = dirUnder('home')
      mkdirSync(join(home, AGENT_DIRECTOR_INSTALL_DIR))
      return home
    }],
  ]

  test.each(noPasswdRows)('with no passwd home, %s: %p', (_label, expected, build) => {
    const launchHome = build()
    const before = treeSnapshot(root)

    expect(launchHomeRefusal(launchHome, undefined, LIVE_LAUNCH_HOME_PROBE)).toBe(expected)
    expect(treeSnapshot(root)).toEqual(before)
  })

  // .agent-director and the paths under it included: the derived-path rule wins over the install rule.
  test.each(LINKABLE_DERIVED_PATHS)('a home whose %s is a dangling symlink into the fake real home: derivedPathInRealHome', (path) => {
    const real = fakeRealHome()
    const home = homeWithLink(path, join(real, 'no-such-entry'))
    const before = treeSnapshot(root)

    expect(launchHomeRefusal(home, real, LIVE_LAUNCH_HOME_PROBE)).toBe(R.derivedPathInRealHome)
    expect(treeSnapshot(root)).toEqual(before)
  })

  test.skipIf(IS_ROOT)('an entry under the launch home that cannot be looked at counts as Slack state (skipped as root, who can look at it)', () => {
    const real = fakeRealHome()
    const home = dirUnder('home')
    const channels = dirUnder(join('home', CLAUDE_DIR, 'channels'))
    chmodSync(channels, 0o000)
    try {
      expect(launchHomeRefusal(home, real, LIVE_LAUNCH_HOME_PROBE)).toBe(R.holdsSlackState)
    } finally {
      chmodSync(channels, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// The guard in a bun test child
// ---------------------------------------------------------------------------

describe('the preload guard in a bun test child', () => {
  // Written when the file loads, before any test in it runs.
  const FIXTURE_SOURCE = [
    "import { test } from 'bun:test'",
    "import { writeFileSync } from 'node:fs'",
    "import { homedir } from 'node:os'",
    'writeFileSync(process.env.MARKER!, JSON.stringify({ homedir: homedir(), home: process.env.HOME }))',
    "test('loaded', () => {})",
    '',
  ].join('\n')

  // Each directory's bunfig.toml loads the guard.
  const START_DIRS: [label: string, cwd: string][] = [
    ['the repository root', REPO_ROOT],
    ['tests/', TESTS_DIR],
    ['tests/integration/', join(TESTS_DIR, 'integration')],
  ]

  /** The child's `TMPDIR` (under the root) and a fake home under it: under the temp directory, the guard accepts it with or without a passwd entry. */
  function childTmpAndHome(): { ownTmp: string; home: string } {
    return { ownTmp: dirUnder('tmp'), home: dirUnder(join('tmp', 'home')) }
  }

  /**
   * `bun test` on a one-file fixture under the root, started in `cwd` with
   * `home` as its launch-time HOME and `TMPDIR` `ownTmp`. The fixture writes
   * `marker` when it loads.
   */
  function runFixture(cwd: string, home: string, ownTmp: string): { status: number | null; stderr: string; marker: string; fixture: string } {
    const marker = join(root, 'loaded.json')
    const fixture = join(root, 'launch-home-probe.test.ts')
    writeFileSync(fixture, FIXTURE_SOURCE)
    const child = spawnSync(process.execPath, ['test', fixture], {
      cwd,
      env: hostSafeChildEnv(home, {
        tools: [],
        extras: {
          TMPDIR: ownTmp,
          MARKER: marker,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          SLACK_BOT_TOKEN: fakeToken(BOT_TOKEN_PREFIX, 'launch'),
          SLACK_APP_TOKEN: fakeToken(APP_TOKEN_PREFIX, 'launch'),
        },
      }),
      encoding: 'utf-8',
      timeout: 30_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    assertNoLeak([child.stdout, child.stderr], 'bun test child output')
    return { status: child.status, stderr: child.stderr, marker, fixture }
  }

  /** `stderr`'s non-empty lines, without the header Bun writes naming the file it is about to load. */
  function stderrLines(stderr: string, fixture: string): string[] {
    return stderr.split('\n').filter((line) => line !== '' && !line.endsWith(`${basename(fixture)}:`))
  }

  test.each(START_DIRS)('started from %s with a fake home holding .claude/channels/slack: refuses with its exit code and one line, loads no test file, changes nothing under the home and makes no directory', (_label, cwd) => {
    const { ownTmp, home } = childTmpAndHome()
    writeFileSync(join(dirUnder(join('tmp', 'home', PRELOAD_STATE_DIR_PATH)), 'server.log'), '')
    const before = treeSnapshot(home)

    const run = runFixture(cwd, home, ownTmp)

    expect(run.status).toBe(LAUNCH_HOME_REFUSED_EXIT_CODE)
    expect(stderrLines(run.stderr, run.fixture)).toEqual([launchHomeRefusalMessage(R.holdsSlackState, home)])
    expect(existsSync(run.marker)).toBe(false)
    expect(treeSnapshot(home)).toEqual(before)
    // Neither the preload HOME nor a fenced TMUX_TMPDIR was made beside the fake home.
    expect(readdirSync(ownTmp)).toEqual([basename(home)])
  })

  test.each(START_DIRS)('started from %s with an empty fake home: loads the fixture with homedir() the fake home and HOME the preload’s own', (_label, cwd) => {
    const { ownTmp, home } = childTmpAndHome()

    const run = runFixture(cwd, home, ownTmp)

    expect(run.status).toBe(0)
    const seen = JSON.parse(readFileSync(run.marker, 'utf-8')) as { homedir: string; home: string }
    expect(seen.homedir).toBe(home)
    expect(dirname(seen.home)).toBe(ownTmp)
    expect(basename(seen.home).startsWith(PRELOAD_HOME_PREFIX)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// This run: its launch-time homes and the homedir()-derived defaults
// ---------------------------------------------------------------------------

describe('this run: launch-time homes and the homedir()-derived defaults', () => {
  test('launchTimeHomes() holds os.homedir()', () => {
    expect(launchTimeHomes()).toContain(homedir())
  })

  const derived: [label: string, path: () => string][] = [
    ['resolveServerStateDir() with SLACK_STATE_DIR unset', () => resolveServerStateDir(undefined, {})],
    ['resolveClaudeConfigDir()', () => resolveClaudeConfigDir()],
    ['resolveJsonlRoots() with no persona (the default transcript root)', () => {
      const roots = resolveJsonlRoots(makePersonaConfig({ personas: [] }, root))
      expect(roots).toHaveLength(1)
      return roots[0]!
    }],
    ["expandTilde('~')", () => expandTilde('~')],
    ['resolveDefaultCronTablePath() with SLACK_STATE_DIR and XDG_CONFIG_HOME unset (the crontable default, bug b.avm)', () => resolveDefaultCronTablePath(resolveServerStateDir(undefined, {}), undefined, {})],
    ['DEFAULT_STATE_DB_PATH (the start gate’s state.db path)', () => DEFAULT_STATE_DB_PATH],
    ['DEFAULT_STORE_PATH expanded', () => expandTilde(DEFAULT_STORE_PATH)],
  ]

  test.each(derived)('%s resolves under os.homedir() and outside the passwd home (with no passwd entry, strictly under the OS temp directory)', (_label, path) => {
    const resolved = path()
    const canonical = LIVE_LAUNCH_HOME_PROBE.canonical(resolved)

    expect(isUnder(resolved, homedir())).toBe(true)
    if (PASSWD_HOME !== undefined) {
      expect(isUnder(resolve(resolved), resolve(PASSWD_HOME))).toBe(false)
      expect(isUnder(canonical, LIVE_LAUNCH_HOME_PROBE.canonical(PASSWD_HOME))).toBe(false)
    } else {
      const temp = LIVE_LAUNCH_HOME_PROBE.canonical(osTempDir())
      expect(canonical !== temp && isUnder(canonical, temp)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// scripts/preflight.sh SR-2.3: bun test under a scratch HOME
// ---------------------------------------------------------------------------

describe('scripts/preflight.sh SR-2.3: bun test runs under a scratch HOME', () => {
  /** A stub `bun` that appends one tab-separated line per call: its arguments, HOME, whether HOME is a directory, SLACK_STATE_DIR and which secret or persona variables are set. */
  const STUB_BUN = [
    '#!/bin/sh',
    'if [ -d "$HOME" ]; then home_dir=yes; else home_dir=no; fi',
    'printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$*" "$HOME" "$home_dir" "${SLACK_STATE_DIR-}" "${SLACK_BOT_TOKEN+set}" "${SLACK_APP_TOKEN+set}" "${CSCB_PERSONA+set}" "${CLAUDE_CONFIG_DIR+set}" >> "$STUB_RECORD"',
    'if [ "$1" = test ]; then exit "$STUB_TEST_STATUS"; fi',
    'exit 0',
    '',
  ].join('\n')

  interface BunCall {
    args: string
    home: string
    homeIsDir: string
    stateDir: string
    botToken: string
    appToken: string
    persona: string
    claudeConfigDir: string
  }

  /** The SR-2.3 block as preflight.sh holds it: from its `# SR-2.3` header up to the `# SR-2.4` one. */
  function sr23Block(): string {
    const lines = readFileSync(PREFLIGHT_PATH, 'utf-8').split('\n')
    const start = lines.findIndex((line) => line.startsWith('# SR-2.3 '))
    const end = lines.findIndex((line, i) => i > start && line.startsWith('# SR-2.4 '))
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return lines.slice(start, end).join('\n')
  }

  /**
   * The SR-2.3 block run under bash in a checkout holding one test file, with
   * the stub `bun` first on PATH, `TMPDIR` the given directory (a new one
   * under the root by default), and the Slack token variables (fakes),
   * `CSCB_PERSONA` and `CLAUDE_CONFIG_DIR` set in its environment.
   */
  function runSr23(testStatus: number, tmpDir: string = dirUnder('tmp')): { status: number | null; stderr: string; calls: BunCall[] } {
    const checkout = dirUnder('checkout')
    writeFileSync(join(dirUnder('checkout/tests'), 'a.test.ts'), '')
    const stubBin = dirUnder('stub-bin')
    writeFileSync(join(stubBin, 'bun'), STUB_BUN, { mode: 0o755 })
    const record = join(root, 'bun-calls.tsv')
    const script = ['set -euo pipefail', 'sr_exit() { exit "$1"; }', 'BUMP_KIND=patch', sr23Block()].join('\n')

    const child = spawnSync('bash', ['-c', script], {
      cwd: checkout,
      env: hostSafeChildEnv(dirUnder('home'), {
        pathDirs: [stubBin],
        tools: ['bash', 'env', 'find', 'mktemp', 'rm'],
        extras: {
          TMPDIR: tmpDir,
          STUB_RECORD: record,
          STUB_TEST_STATUS: String(testStatus),
          SLACK_BOT_TOKEN: fakeToken(BOT_TOKEN_PREFIX, 'preflight'),
          SLACK_APP_TOKEN: fakeToken(APP_TOKEN_PREFIX, 'preflight'),
          CSCB_PERSONA: 'preflight-persona',
          CLAUDE_CONFIG_DIR: join(root, 'persona-claude'),
        },
      }),
      encoding: 'utf-8',
      timeout: 30_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    const calls = existsSync(record)
      ? readFileSync(record, 'utf-8').split('\n').filter((line) => line !== '').map((line): BunCall => {
        const [args, home, homeIsDir, stateDir, botToken, appToken, persona, claudeConfigDir] = line.split('\t') as [string, string, string, string, string, string, string, string]
        return { args, home, homeIsDir, stateDir, botToken, appToken, persona, claudeConfigDir }
      })
      : []
    assertNoLeak([child.stdout, child.stderr, calls], 'preflight SR-2.3 run')
    return { status: child.status, stderr: child.stderr, calls }
  }

  test('a passing suite: bun test runs once, under a new HOME in TMPDIR with SLACK_STATE_DIR under it and no token variable, CSCB_PERSONA or CLAUDE_CONFIG_DIR, and the directory is removed', () => {
    const tmp = dirUnder('tmp')

    const run = runSr23(0, tmp)

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.calls.map((call) => call.args)).toEqual(['test', 'run typecheck'])
    const testCall = run.calls[0]!
    expect(dirname(testCall.home)).toBe(tmp)
    expect(testCall).toEqual({
      args: 'test',
      home: testCall.home,
      homeIsDir: 'yes',
      stateDir: join(testCall.home, 'state'),
      botToken: '',
      appToken: '',
      persona: '',
      claudeConfigDir: '',
    })
    expect(readdirSync(tmp)).toEqual([])
  })

  test('a failing suite: exits 13 with the SR-2.3 test line, runs no typecheck, and the directory is still removed', () => {
    const tmp = dirUnder('tmp')

    const run = runSr23(1, tmp)

    expect(run.status).toBe(13)
    expect(run.stderr).toMatch(/^SR-2\.3 \(preflight\): 'bun test' did not pass\. .*'\/publish patch'\.\n$/)
    expect(run.calls.map((call) => call.args)).toEqual(['test'])
    expect(readdirSync(tmp)).toEqual([])
  })

  test('a suite the guard refused to start (exit LAUNCH_HOME_REFUSED_EXIT_CODE): exits 13 with the SR-2.3 refusal line naming the guard’s line and the TMPDIR cause, runs no typecheck, and the directory is still removed', () => {
    const tmp = dirUnder('tmp')
    // The line the preflight points at is the one the guard writes.
    const guardLine = 'host-safety preload: refusing to start'
    expect(launchHomeRefusalMessage(R.holdsSlackState, join(tmp, 'home')).startsWith(`${guardLine}: `)).toBe(true)

    const run = runSr23(LAUNCH_HOME_REFUSED_EXIT_CODE, tmp)

    expect(run.status).toBe(13)
    expect(run.stderr).toMatch(new RegExp(`^SR-2\\.3 \\(preflight\\): the test preload guard refused to start 'bun test' \\(exit ${LAUNCH_HOME_REFUSED_EXIT_CODE}\\): .*'${guardLine}'.*TMPDIR.*'/publish patch'\\.\\n$`))
    expect(run.stderr).not.toContain('did not pass')
    expect(run.calls.map((call) => call.args)).toEqual(['test'])
    expect(readdirSync(tmp)).toEqual([])
  })

  test('mktemp -d fails: exits 13 with the SR-2.3 mktemp line and never runs bun', () => {
    const run = runSr23(0, join(root, 'no-such-tmp'))

    expect(run.status).toBe(13)
    expect(run.stderr).toMatch(/^SR-2\.3 \(preflight\): 'mktemp -d' failed, so 'bun test' could not be given a scratch HOME\. .*'\/publish patch'\.$/m)
    expect(run.calls).toEqual([])
  })
})
