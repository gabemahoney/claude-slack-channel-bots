/**
 * packaging-completeness.test.ts — b.q9t regression guard.
 *
 * The bug: the declared package version (0.8.2) was one whose PUBLISHED npm
 * artifact shipped none of the cron code, while the working tree already
 * carried the five cron source files (src/cron-bootstrap.ts, cron-dispatch.ts,
 * cron-log.ts, cron-scheduler.ts, crontable.ts). A customer running
 * `npm i -g claude-slack-channel-bots` got a binary that could not run cron.
 * The fix bumped the version 0.8.2 → 0.9.0 (the first version whose artifact
 * contains cron).
 *
 * Two guards, both of which fail against the pre-fix state and pass after:
 *
 *   1. VERSION GATE — when the cron source files are present in src/, the
 *      declared package.json version must be >= 0.9.0. This fails-before: at the
 *      pre-fix 0.8.2 (with cron already in the tree) the assertion would fail.
 *
 *   2. PACKAGING COMPLETENESS — the set of files `npm pack` would ship must
 *      include every runtime src/*.ts file in the repo. This is the general
 *      guard against the whole class of bug: a future new src file silently
 *      excluded by the package.json `files` globs would ship a broken tarball
 *      without anyone noticing. Hermetic where possible; shells out to npm for
 *      the authoritative file list and skips cleanly if npm is unavailable.
 *
 * b.av2 AC 27 guard (SR-12, SR-13.5): the shipped debugging skill
 * `skills/debug-slack-channel-bots/SKILL.md` must be in the npm pack list
 * (same probe and skip/error contract as guard 2), with a hermetic companion
 * that needs no npm (the file exists with a `name` matching its directory and
 * a `description`, and package.json `files` covers the skill's path with no
 * `!` entry excluding it), and a class-coverage check: every label in
 * PERSONA_DIAGNOSTIC_CLASSES (imported, side-effect free) names a `##`–`####`
 * heading in the skill (the skill gives each class a `###` heading naming it),
 * so a class added without a skill entry, or an entry cut down to a passing
 * mention, fails here. RELOAD_DIAGNOSTIC_CLASSES (src/reload.ts, imported,
 * side-effect free) gets the same heading check in its own `test.each`, plus
 * a non-empty, duplicate-free check on the list. Content audits of shipped text (forbidden terms, the
 * SR-1.7 exception) are later Epics' work (E6/E14), not this file's.
 *
 * b.av2 SR-12: the setup wizard's credentials script,
 * `scripts/write-credentials.sh` (which `claude-slack-channel-bots
 * credentials` runs), is in the npm pack list, with the same hermetic
 * companion (the file exists and package.json `files` covers it).
 *
 * b.jg5 SRJ-209: the TOML parser CSCB reads agent-director's settings file
 * with, `smol-toml`, is a runtime dependency pinned at exactly one version
 * (no range): `package.json` `dependencies` names it with that exact spec
 * (never in `devDependencies`), and `bun.lock` records the same spec for the
 * root workspace and resolves the package to that version. Hermetic: both
 * files are read from the tree, with no npm call and no child process. Its
 * bun.lock half reads through `lockPin`, the file's bun.lock pin reader
 * (the root workspace's spec, the other sections naming the package, and the
 * resolved entry with its source).
 *
 * b.jg5 SRJ-101, part of SRJ-1203's merge check: the shipped `package.json`
 * depends on agent-director at exactly the Phase 1 release's version — one
 * exact version, with no range operator, pre-release suffix or build
 * metadata, equal to CSCB's floor (`PHASE1_FLOOR_VERSION`, SRJ-201) — and
 * `bun.lock` resolves to it. `srj101PinVerdict` is that rule as a pure,
 * file-local checker: given a spec and the floor it answers whether the spec
 * is the pin, and names the first rule broken (a range, a dist-tag such as
 * `latest`, a file, git or URL source, a pre-release, build metadata or
 * another version). Its fixture specs are all built from the floor or the
 * versions helper (`tests/test-helpers/agent-director-versions.ts`), never
 * typed; `lockPin`'s fixture lock objects show it reports a mismatched
 * workspace spec, a release-candidate resolution and a file source.
 *
 * The real files are checked with both: `package.json` names agent-director
 * in `dependencies` and in no other section, with a spec `srj101PinVerdict`
 * accepts against the floor; `bun.lock`'s root workspace names the same
 * spec, in `dependencies` only; and its `packages` entry resolves
 * `agent-director@<floor>` from the default registry, with an integrity hash.
 *
 * Every npm-backed test shares one memoised pack probe per file load. Each npm
 * child's environment is a direct `hostSafeChildEnv` call (b.jg5 SRJ-1301,
 * SRJ-1302): the probe's temp dir as HOME, only `npm` and `node` on PATH, and a
 * throwaway cache and user config inside that dir as extras, so it never reads
 * or writes the real HOME (b.av2 SR-13.2) and inherits nothing else from the
 * parent environment. The children stay local: `npm --version` and
 * `npm pack --dry-run` only.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import semver from 'semver'
import { PERSONA_DIAGNOSTIC_CLASSES } from '../src/persona-diagnostics.ts'
import { RELOAD_DIAGNOSTIC_CLASSES } from '../src/reload.ts'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { HostSafetyError, hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

/** The first published version whose artifact contains the cron feature. */
const CRON_FLOOR = '0.9.0'

/** The five cron source files that must ship for cron to work at all. */
const CRON_SRC_FILES = [
  'src/cron-bootstrap.ts',
  'src/cron-dispatch.ts',
  'src/cron-log.ts',
  'src/cron-scheduler.ts',
  'src/crontable.ts',
]

/** A package.json dependency section: package name → version spec. */
type DependencyMap = Record<string, string>

function readPkg(): {
  version: string
  files?: string[]
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
}

/**
 * Pure comparator under test. Returns true when the declared version is new
 * enough to carry cron.
 */
function versionCarriesConfiguredCron(declaredVersion: string): boolean {
  return semver.gte(declaredVersion, CRON_FLOOR)
}

// ---------------------------------------------------------------------------
// 1. Version gate — cron in the tree ⇒ version must be >= 0.9.0
// ---------------------------------------------------------------------------

describe('b.q9t: version gate for the cron feature', () => {
  test('with cron in the tree, declared version is >= 0.9.0 (FAILS-BEFORE-FIX at 0.8.2)', () => {
    // Precondition: the guard is only meaningful while the tree actually ships
    // cron. If a future change removes cron, this documents why the assertion
    // holds and stops the version gate from silently becoming vacuous.
    const cronPresent = CRON_SRC_FILES.every((rel) =>
      existsSync(resolve(REPO_ROOT, rel)),
    )
    expect(cronPresent).toBe(true)

    // The real fails-before assertion: with cron present, the declared version
    // must be >= 0.9.0. At the pre-fix 0.8.2 this fails, so any regression of
    // package.json below the cron floor is caught here.
    const { version } = readPkg()
    expect(versionCarriesConfiguredCron(version)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Packaging completeness — npm pack must ship every runtime src/*.ts
// ---------------------------------------------------------------------------

/**
 * Result of probing npm for the file list it would pack.
 *
 * The skip/fail distinction is deliberate and load-bearing (a skipped test must
 * never mask a real failure): ONLY an absent npm toolchain yields `skip`. Once
 * npm is present, every downstream problem — a non-zero `npm pack`, or a stdout
 * we cannot parse into a file list — is a genuine packaging failure and is
 * reported as `error` so the test fails loudly with the captured stderr.
 */
type PackProbe =
  | { kind: 'skip' } // npm toolchain unavailable — nothing to assert against
  | { kind: 'error'; message: string } // npm present but pack/parse failed
  | { kind: 'ok'; files: string[] }

/**
 * The npm toolchain the children run by name: `npm` is a `#!/usr/bin/env node`
 * script, so the child's PATH needs `node` as well.
 */
const NPM_TOOLS: readonly string[] = ['npm', 'node']

/**
 * The npm configuration for a child under `probeDir`: a throwaway cache and a
 * user config that is never created (npm treats a missing user config as
 * empty, so `~/.npmrc` is never read), and no update-notifier check.
 */
function npmConfigExtras(probeDir: string): Record<string, string> {
  return {
    npm_config_userconfig: join(probeDir, 'npmrc'),
    npm_config_cache: join(probeDir, 'cache'),
    npm_config_update_notifier: 'false',
  }
}

/**
 * Ask npm for the authoritative list of files it would pack, evaluated against
 * the real package.json `files` globs. npm writes progress noise to stderr, so
 * we key strictly off stdout + exit status for the file list.
 */
function npmPackProbe(): PackProbe {
  // npm writes its cache, debug logs and update-notifier stamp under ~/.npm
  // and reads ~/.npmrc by default. Point every npm child at a throwaway dir
  // (its HOME) for all of these so the test never touches the real HOME.
  const probeDir = mkdtempSync(join(tmpdir(), 'cscb-npm-probe-'))
  try {
    return npmPackProbeIn(probeDir)
  } catch (e) {
    // A host-safety refusal with npm present (e.g. an agent-director entry in
    // npm's PATH directory) is a hard failure, never a skip.
    if (e instanceof HostSafetyError) return { kind: 'error', message: e.message }
    throw e
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

function npmPackProbeIn(probeDir: string): PackProbe {
  // The toolchain is absent when npm or the node it runs on is not on PATH;
  // checked first because hostSafeChildEnv refuses a tool it cannot find.
  if (NPM_TOOLS.some((tool) => resolveToolDir(tool) === undefined)) return { kind: 'skip' }
  const probe = spawnSync('npm', ['--version'], {
    encoding: 'utf-8',
    env: hostSafeChildEnv(probeDir, { tools: NPM_TOOLS, extras: npmConfigExtras(probeDir) }),
  })
  // npm and node are on PATH from here on, so the toolchain is present: a
  // failing `npm --version` (or any failure below) is a real fault that fails
  // the npm tests loudly, never a reason to skip.
  if (probe.error || probe.status !== 0) {
    return {
      kind: 'error',
      message: `npm --version failed (status ${probe.status}): ${
        probe.error?.message ?? probe.stderr ?? '(no stderr)'
      }`,
    }
  }
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: hostSafeChildEnv(probeDir, { tools: NPM_TOOLS, extras: npmConfigExtras(probeDir) }),
    // No packfile is written in --dry-run mode; only the JSON manifest matters.
  })
  if (res.error || res.status !== 0) {
    return {
      kind: 'error',
      message: `npm pack --dry-run failed (status ${res.status}): ${
        res.error?.message ?? res.stderr ?? '(no stderr)'
      }`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch (e) {
    return {
      kind: 'error',
      message: `npm pack JSON was unparseable (${
        (e as Error).message
      }); stderr: ${res.stderr ?? '(no stderr)'}`,
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      kind: 'error',
      message: `npm pack JSON was not a non-empty array; stderr: ${
        res.stderr ?? '(no stderr)'
      }`,
    }
  }
  const files = (parsed[0] as { files?: { path: string }[] }).files
  if (!Array.isArray(files)) {
    return {
      kind: 'error',
      message: `npm pack JSON had no files[] array; stderr: ${
        res.stderr ?? '(no stderr)'
      }`,
    }
  }
  return { kind: 'ok', files: files.map((f) => f.path) }
}

let sharedProbe: PackProbe | undefined

/** One npm pack probe per file load, shared by every npm-backed test. */
function packProbe(): PackProbe {
  sharedProbe ??= npmPackProbe()
  return sharedProbe
}

/** Every runtime src/*.ts file the repo would need to ship (tests excluded). */
function runtimeSrcFiles(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'src'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `src/${name}`)
    .sort()
}

describe('b.q9t: npm pack ships every runtime src file', () => {
  const probe = packProbe()

  // Skip ONLY when the npm toolchain is absent. With npm present, a pack or
  // parse failure is surfaced as a hard failure below — a skip must never hide
  // a real packaging fault.
  test.skipIf(probe.kind === 'skip')(
    // Superset over ALL runtime src/*.ts, so the five cron files that motivated
    // b.q9t (cron-bootstrap, cron-dispatch, cron-log, cron-scheduler, crontable)
    // are covered as a special case, along with any future new src file.
    'the packed file set is a superset of the repo runtime src/*.ts files',
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      const packedSet = new Set(probe.kind === 'ok' ? probe.files : [])
      const missing = runtimeSrcFiles().filter((rel) => !packedSet.has(rel))
      expect(missing).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// 3. b.av2 AC 27 — the debugging skill ships
// ---------------------------------------------------------------------------

const SKILL_NAME = 'debug-slack-channel-bots'
const SKILL_REL = `skills/${SKILL_NAME}/SKILL.md`

/** The `key: value` lines of a leading `---` frontmatter block, or null. */
function skillFrontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    // An empty quoted value (`""`) counts as empty.
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return fields
}

/**
 * True when `pattern` (a package.json `files` glob, `!` already stripped)
 * matches `rel` or one of its ancestor directories. As in npm, an entry that
 * names a directory (`skills`, `skills/`) covers everything under it.
 */
function filesEntryMatches(pattern: string, rel: string): boolean {
  const glob = new Bun.Glob(pattern.replace(/^\.?\//, '').replace(/\/+$/, ''))
  const parts = rel.split('/')
  for (let n = parts.length; n > 0; n--) {
    if (glob.match(parts.slice(0, n).join('/'))) return true
  }
  return false
}

/**
 * True when package.json `files` would ship `rel`: some positive entry covers
 * it and no `!` entry excludes it. Stricter than npm on ordering (any matching
 * `!` entry excludes, wherever it sits), which is enough for a guard.
 */
function filesCover(files: string[], rel: string): boolean {
  const excluded = files.some(
    (f) => f.startsWith('!') && filesEntryMatches(f.slice(1), rel),
  )
  const included = files.some(
    (f) => !f.startsWith('!') && filesEntryMatches(f, rel),
  )
  return included && !excluded
}

/** A string matched literally inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('b.av2 AC 27: the debugging skill ships in the package', () => {
  const probe = packProbe()

  // Same contract as guard 2: skip only when npm is absent; a pack or parse
  // error is a hard failure.
  test.skipIf(probe.kind === 'skip')(
    `AC 27: the npm pack file list includes ${SKILL_REL}`,
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      expect(probe.kind === 'ok' ? probe.files : []).toContain(SKILL_REL)
    },
  )

  // Hermetic companion: guards AC 27 where npm is unavailable.
  test('AC 27 (hermetic): the skill file exists, is non-empty and has name and description frontmatter', () => {
    const path = resolve(REPO_ROOT, SKILL_REL)
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    expect(text.trim().length).toBeGreaterThan(0)
    const fm = skillFrontmatter(text)
    expect(fm).not.toBeNull()
    expect(fm?.name).toBe(SKILL_NAME)
    expect(fm?.description ?? '').not.toBe('')
  })

  test(`AC 27 (hermetic): package.json files covers ${SKILL_REL} and no ! entry excludes it`, () => {
    expect(filesCover(readPkg().files ?? [], SKILL_REL)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3b. The setup wizard's credentials script ships (b.av2 SR-12)
// ---------------------------------------------------------------------------

/** The script `claude-slack-channel-bots credentials` runs, from the package root. */
const CREDENTIALS_SCRIPT_REL = 'scripts/write-credentials.sh'

describe('b.av2 SR-12: the credentials script ships in the package', () => {
  const probe = packProbe()

  // Same contract as guard 2: skip only when npm is absent; a pack or parse
  // error is a hard failure.
  test.skipIf(probe.kind === 'skip')(
    `the npm pack file list includes ${CREDENTIALS_SCRIPT_REL}`,
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      expect(probe.kind === 'ok' ? probe.files : []).toContain(CREDENTIALS_SCRIPT_REL)
    },
  )

  // Hermetic companion: guards the script where npm is unavailable.
  test(`(hermetic) ${CREDENTIALS_SCRIPT_REL} exists and package.json files covers it with no ! entry excluding it`, () => {
    expect(existsSync(resolve(REPO_ROOT, CREDENTIALS_SCRIPT_REL))).toBe(true)
    expect(filesCover(readPkg().files ?? [], CREDENTIALS_SCRIPT_REL)).toBe(true)
  })
})

/**
 * True when the skill has a `##`–`####` heading naming the whole label (not a
 * prefix or suffix of a longer hyphenated word): a passing mention in body
 * text is not an entry for the class.
 */
function skillHasClassHeading(label: string): boolean {
  const text = readFileSync(resolve(REPO_ROOT, SKILL_REL), 'utf-8')
  const re = new RegExp(
    `^#{2,4} [^\\n]*(?<![\\w-])${escapeRegExp(label)}(?![\\w-])`,
    'm',
  )
  return re.test(text)
}

describe('b.av2 AC 27: the debugging skill covers every persona diagnostic class', () => {
  // Labels come from the exported closed set, never a hand-copied list, so a
  // class added later without a skill entry fails here (b.av2 SR-12).
  test.each([...PERSONA_DIAGNOSTIC_CLASSES])(
    'AC 27: the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})

describe('b.av2 SR-12: the debugging skill covers every reload diagnostic class', () => {
  // The reload classes are their own exported closed set, kept apart from the
  // persona classes (E11 Director decision 3). Imported, never hand-copied, so
  // a reload class added without a skill entry fails here.
  test('RELOAD_DIAGNOSTIC_CLASSES is non-empty and has no duplicates', () => {
    expect(RELOAD_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(RELOAD_DIAGNOSTIC_CLASSES).size).toBe(
      RELOAD_DIAGNOSTIC_CLASSES.length,
    )
  })

  test.each([...RELOAD_DIAGNOSTIC_CLASSES])(
    'SR-12: the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// 4. b.jg5 SRJ-209 — the TOML parser is pinned at exactly one version
// ---------------------------------------------------------------------------

/** The package CSCB parses agent-director's settings file with. */
const TOML_PARSER = 'smol-toml'

/**
 * SRJ-209's pin of the third-party parser: the one version, with no range,
 * that package.json and bun.lock must name. The only place it is written.
 */
const TOML_PARSER_PIN = '1.9.0'

/** The package.json (and bun.lock workspace) sections that are not runtime dependencies. */
const NON_RUNTIME_SECTIONS = ['devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** The parts of bun.lock these guards read. */
interface BunLock {
  workspaces?: Record<string, Partial<Record<'dependencies' | (typeof NON_RUNTIME_SECTIONS)[number], DependencyMap>>>
  /**
   * Package name → its entry. A registry entry is [`<name>@<version>`,
   * registry ('' for the default one), metadata, integrity]; a path, tarball,
   * git or URL entry starts `<name>@<source>`, then metadata, with no
   * registry or integrity string.
   */
  packages?: Record<string, unknown[]>
}

/** bun.lock, parsed tolerantly: it is JSONC, with trailing commas. */
function readBunLock(): BunLock {
  return Bun.JSONC.parse(readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf-8')) as BunLock
}

/** A package's `packages` entry in bun.lock, as {@link lockPin} reports it. */
interface LockResolution {
  /** The entry's `<name>@<version>`, or `<name>@<source>` for a path, tarball, git or URL entry. */
  id: string
  /** The text after `<name>@`: the version for a registry entry, else the source; undefined when the id names another package. */
  ref: string | undefined
  /** A registry entry's registry field ('' is the default registry); undefined for any other entry. */
  registry: string | undefined
  /** A registry entry's integrity hash; undefined when the entry has none. */
  integrity: string | undefined
}

/** What bun.lock pins for one package. */
interface LockPin {
  /** The spec the root workspace's `dependencies` give the package, if any. */
  workspaceSpec: string | undefined
  /** The root workspace's non-runtime sections that name the package. */
  otherSections: string[]
  /** The package's `packages` entry; undefined when there is none. */
  resolved: LockResolution | undefined
}

/**
 * bun.lock's pin of `name`: the root workspace's spec for it, the root
 * workspace's other sections that name it, and the name@version (or
 * name@source) its `packages` entry resolves, with that entry's registry and
 * integrity.
 */
function lockPin(lock: BunLock, name: string): LockPin {
  const root = lock.workspaces?.['']
  const entry = lock.packages?.[name]
  let resolved: LockResolution | undefined
  if (Array.isArray(entry) && typeof entry[0] === 'string') {
    const id = entry[0]
    resolved = {
      id,
      ref: id.startsWith(`${name}@`) ? id.slice(name.length + 1) : undefined,
      registry: typeof entry[1] === 'string' ? entry[1] : undefined,
      integrity: typeof entry[3] === 'string' ? entry[3] : undefined,
    }
  }
  return {
    workspaceSpec: root?.dependencies?.[name],
    otherSections: NON_RUNTIME_SECTIONS.filter((section) => Object.keys(root?.[section] ?? {}).includes(name)),
    resolved,
  }
}

/**
 * Whether `spec` is one exact version and nothing else: a range operator
 * (`^`, `~`, `>=`, `=`), a wildcard, a space or an alternation (`||`) makes
 * semver either refuse it or normalise it to a different string.
 */
function isExactVersion(spec: string): boolean {
  return semver.valid(spec) === spec
}

describe(`b.jg5 SRJ-209: ${TOML_PARSER} is a runtime dependency at exactly its pinned version (hermetic)`, () => {
  test(`package.json dependencies name ${TOML_PARSER} with the exact spec ${TOML_PARSER_PIN}, no range`, () => {
    const spec = readPkg().dependencies?.[TOML_PARSER]
    expect([spec, isExactVersion(spec ?? '')]).toEqual([TOML_PARSER_PIN, true])
  })

  test.each([...NON_RUNTIME_SECTIONS])(`package.json %s does not name ${TOML_PARSER}`, (section) => {
    expect(Object.keys(readPkg()[section] ?? {})).not.toContain(TOML_PARSER)
  })

  test(`bun.lock's root workspace names ${TOML_PARSER} among its dependencies with the same exact spec, and in no other section`, () => {
    const lock = readBunLock()
    expect(lock.workspaces?.['']).toBeDefined()
    const { workspaceSpec, otherSections } = lockPin(lock, TOML_PARSER)
    expect([workspaceSpec, isExactVersion(workspaceSpec ?? ''), otherSections]).toEqual([TOML_PARSER_PIN, true, []])
  })

  test(`bun.lock resolves ${TOML_PARSER} to exactly the pinned version`, () => {
    expect(lockPin(readBunLock(), TOML_PARSER).resolved?.id).toBe(`${TOML_PARSER}@${TOML_PARSER_PIN}`)
  })
})

// ---------------------------------------------------------------------------
// 5. b.jg5 SRJ-101 — agent-director is pinned at the Phase 1 floor
// ---------------------------------------------------------------------------

/** The agent-director npm client, CSCB's runtime dependency. */
const AD_PACKAGE = 'agent-director'

/**
 * SRJ-101's rules for the pin, in the order they are checked:
 *   - `version`: the spec is a version or range at all (not a dist-tag, or a
 *     file, link, tarball, git or URL source);
 *   - `no-range`: it is the bare version text — no range operator (`^`, `~`,
 *     `>=`, `=`), `v` prefix, wildcard, x-range, space or `||` alternation;
 *   - `no-pre-release`: no `-<pre-release>` suffix;
 *   - `no-build-metadata`: no `+<build>` suffix;
 *   - `equals-floor`: the version is the floor.
 */
type PinRule = 'version' | 'no-range' | 'no-pre-release' | 'no-build-metadata' | 'equals-floor'

type PinVerdict = { ok: true } | { ok: false; broken: PinRule }

/**
 * SRJ-101's pin check: whether `spec` is one exact version equal to `floor`,
 * with no range operator, pre-release suffix or build metadata; otherwise the
 * first {@link PinRule} it breaks.
 */
function srj101PinVerdict(spec: string, floor: string): PinVerdict {
  const parsed = semver.parse(spec)
  if (parsed === null) {
    return { ok: false, broken: semver.validRange(spec) === null ? 'version' : 'no-range' }
  }
  const bare = parsed.build.length > 0 ? `${parsed.version}+${parsed.build.join('.')}` : parsed.version
  if (spec !== bare) return { ok: false, broken: 'no-range' }
  if (parsed.prerelease.length > 0) return { ok: false, broken: 'no-pre-release' }
  if (parsed.build.length > 0) return { ok: false, broken: 'no-build-metadata' }
  if (parsed.version !== floor) return { ok: false, broken: 'equals-floor' }
  return { ok: true }
}

/** The floor's next minor release: a later version than the floor. */
const LATER_MINOR_VERSION = semver.inc(PHASE1_FLOOR_VERSION, 'minor')!

/** The floor's x-range (`<major>.<minor>.x`). */
const FLOOR_X_RANGE = `${semver.major(PHASE1_FLOOR_VERSION)}.${semver.minor(PHASE1_FLOOR_VERSION)}.x`

describe(`b.jg5 SRJ-101: the pin checker gives each spec its verdict against the floor ${PHASE1_FLOOR_VERSION}`, () => {
  test('the floor itself is the pin', () => {
    expect(srj101PinVerdict(PHASE1_FLOOR_VERSION, PHASE1_FLOOR_VERSION)).toEqual({ ok: true })
  })

  test.each<[string, string, PinRule]>([
    ['the caret range', `^${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the tilde range', `~${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the >= range', `>=${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the = form', `=${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the v form', `v${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the x-range', FLOOR_X_RANGE, 'no-range'],
    ['the * wildcard', '*', 'no-range'],
    ['an || alternation', `${OLD_AD_VERSION} || ${PHASE1_FLOOR_VERSION}`, 'no-range'],
    ['the latest dist-tag', 'latest', 'version'],
    ['the floor release candidate', PHASE1_RC_VERSION, 'no-pre-release'],
    ['the floor with build metadata', `${PHASE1_FLOOR_VERSION}+build.1`, 'no-build-metadata'],
    ['a file: tarball path', `file:../${AD_PACKAGE}-${PHASE1_FLOOR_VERSION}.tgz`, 'version'],
    ['a git spec', `git+https://github.com/example/${AD_PACKAGE}.git#v${PHASE1_FLOOR_VERSION}`, 'version'],
    ['a URL spec', `https://registry.npmjs.org/${AD_PACKAGE}/-/${AD_PACKAGE}-${PHASE1_FLOOR_VERSION}.tgz`, 'version'],
    ['the release before Phase 1', OLD_AD_VERSION, 'equals-floor'],
    ['a later minor version', LATER_MINOR_VERSION, 'equals-floor'],
  ])('refuses %s (%s), breaking rule %s', (_label, spec, broken) => {
    expect(srj101PinVerdict(spec, PHASE1_FLOOR_VERSION)).toEqual({ ok: false, broken })
  })
})

/** A fixture integrity hash for registry entries (not a real digest). */
const FIXTURE_INTEGRITY = 'sha512-fixture'

/** A registry `packages` entry resolving agent-director at `version`. */
function registryEntry(version: string): unknown[] {
  return [`${AD_PACKAGE}@${version}`, '', {}, FIXTURE_INTEGRITY]
}

/** A fixture bun.lock: the root workspace's sections and agent-director's `packages` entry. */
function fixtureLock(root: NonNullable<BunLock['workspaces']>[string], entry: unknown[]): BunLock {
  return { workspaces: { '': root }, packages: { [AD_PACKAGE]: entry } }
}

describe('b.jg5 SRJ-101: the bun.lock pin reader reports what each fixture lock pins', () => {
  const fileSource = `file:../${AD_PACKAGE}-${PHASE1_FLOOR_VERSION}.tgz`

  test.each<[string, BunLock, LockPin]>([
    [
      'the floor pinned and resolved from the default registry',
      fixtureLock({ dependencies: { [AD_PACKAGE]: PHASE1_FLOOR_VERSION } }, registryEntry(PHASE1_FLOOR_VERSION)),
      {
        workspaceSpec: PHASE1_FLOOR_VERSION,
        otherSections: [],
        resolved: { id: `${AD_PACKAGE}@${PHASE1_FLOOR_VERSION}`, ref: PHASE1_FLOOR_VERSION, registry: '', integrity: FIXTURE_INTEGRITY },
      },
    ],
    [
      'a workspace spec that does not match the resolution, also named in devDependencies',
      fixtureLock(
        { dependencies: { [AD_PACKAGE]: `^${OLD_AD_VERSION}` }, devDependencies: { [AD_PACKAGE]: PHASE1_FLOOR_VERSION } },
        registryEntry(PHASE1_FLOOR_VERSION),
      ),
      {
        workspaceSpec: `^${OLD_AD_VERSION}`,
        otherSections: ['devDependencies'],
        resolved: { id: `${AD_PACKAGE}@${PHASE1_FLOOR_VERSION}`, ref: PHASE1_FLOOR_VERSION, registry: '', integrity: FIXTURE_INTEGRITY },
      },
    ],
    [
      'a release-candidate resolution',
      fixtureLock({ dependencies: { [AD_PACKAGE]: PHASE1_RC_VERSION } }, registryEntry(PHASE1_RC_VERSION)),
      {
        workspaceSpec: PHASE1_RC_VERSION,
        otherSections: [],
        resolved: { id: `${AD_PACKAGE}@${PHASE1_RC_VERSION}`, ref: PHASE1_RC_VERSION, registry: '', integrity: FIXTURE_INTEGRITY },
      },
    ],
    [
      'a file tarball source',
      fixtureLock({ dependencies: { [AD_PACKAGE]: fileSource } }, [`${AD_PACKAGE}@${fileSource}`, {}]),
      {
        workspaceSpec: fileSource,
        otherSections: [],
        resolved: { id: `${AD_PACKAGE}@${fileSource}`, ref: fileSource, registry: undefined, integrity: undefined },
      },
    ],
    [
      'no root workspace and no packages entry',
      { workspaces: {}, packages: {} },
      { workspaceSpec: undefined, otherSections: [], resolved: undefined },
    ],
  ])('%s', (_label, lock, expected) => {
    expect(lockPin(lock, AD_PACKAGE)).toEqual(expected)
  })
})

describe(`b.jg5 SRJ-101: the real package.json and bun.lock pin ${AD_PACKAGE} at the floor ${PHASE1_FLOOR_VERSION} (hermetic)`, () => {
  test(`package.json names ${AD_PACKAGE} in dependencies and in no other section`, () => {
    const pkg = readPkg()
    expect(pkg.dependencies?.[AD_PACKAGE]).toBeDefined()
    expect(NON_RUNTIME_SECTIONS.filter((section) => Object.keys(pkg[section] ?? {}).includes(AD_PACKAGE))).toEqual([])
  })

  test(`package.json's ${AD_PACKAGE} spec is the pin: one exact version equal to the floor`, () => {
    expect(srj101PinVerdict(readPkg().dependencies?.[AD_PACKAGE] ?? '', PHASE1_FLOOR_VERSION)).toEqual({ ok: true })
  })

  test(`bun.lock's root workspace names ${AD_PACKAGE} with package.json's exact spec, in dependencies only`, () => {
    const { workspaceSpec, otherSections } = lockPin(readBunLock(), AD_PACKAGE)
    expect([workspaceSpec, otherSections, srj101PinVerdict(workspaceSpec ?? '', PHASE1_FLOOR_VERSION)]).toEqual([
      readPkg().dependencies?.[AD_PACKAGE],
      [],
      { ok: true },
    ])
  })

  test(`bun.lock resolves ${AD_PACKAGE}@<floor> from the default registry, with integrity`, () => {
    const resolved = lockPin(readBunLock(), AD_PACKAGE).resolved
    expect(resolved).toBeDefined()
    expect([resolved!.id, resolved!.registry]).toEqual([`${AD_PACKAGE}@${PHASE1_FLOOR_VERSION}`, ''])
    expect(resolved!.integrity).toStartWith('sha512-')
  })
})
