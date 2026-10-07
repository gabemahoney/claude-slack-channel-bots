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
 * a non-empty, duplicate-free check on the list. The stored-choice store's
 * own closed list, CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES (src/channel-delivery.ts,
 * imported; b.deo SRI-901), gets the same heading check in its own
 * `test.each`, behind a non-empty guard; the list's exact content is pinned
 * in tests/channel-delivery.test.ts, not here. The forbidden-term audit and
 * the SR-1.7 exception over all shipped text live in
 * tests/shipped-docs.test.ts.
 *
 * b.deo SRI-1108 (AC 43): the debugging skill's fungible-mode content, read
 * by heading title through the markdown helper, with every class label, drop
 * reason, `unclaimed-channel` reason text, file name and setting name
 * imported from `src/`:
 *   - the entries for `persona-invited-channel`, `persona-channel-delivery-set`
 *     and `channel-delivery-unreadable` each quote their `[slack] <label>:`
 *     line and have a Line, Meaning, Cause and Fix bullet;
 *   - `unclaimed-channel` has a declarative-mode and a fungible-mode part: the
 *     declarative Fix offers fungible mode as a second fix for a public or
 *     private channel that is not externally shared, and never for a group
 *     DM; the fungible part quotes its line and has a table row with a fix
 *     for each fungible-mode reason;
 *   - `### \`channel-delivery-unreadable\`` and the store's
 *     `[slack] channel-delivery:` lines subsection sit inside the
 *     stored-choice file's section, and the subsection has a row for each
 *     drop reason;
 *   - the entry for a persona silent in a channel its app was invited to is
 *     a heading exactly once;
 *   - each passage that describes a destination as the `permission_prompts`
 *     value (a file-local list, located by heading or table row) also names
 *     `invited.permission_prompts` and its `"dm"` default (`DM_DESTINATION`,
 *     quoted or bare as a log line renders it).
 * Each check is a pure function of the skill's text and has a self-check
 * that cuts its element from an in-memory copy and sees that element alone
 * reported.
 *
 * The texts the debugging skill quotes from `src/` builders (the
 * `set_channel_delivery` refusals and failed-write texts, the store's lines,
 * the stored-choice `reload-record-write-failed` line, and the switch's and
 * the recorded change's preview lines) are rendered by their builders with
 * the skill's placeholders and must appear in the section that quotes them.
 * Importing those builders makes this suite touch config, credentials and
 * reload surfaces (tests/secrecy-audit.test.ts), so each rendered text goes
 * through `assertNoLeak` before it is compared. Every same-file anchor and
 * relative link in the skill resolves to a heading, or a file and its
 * heading.
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
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import semver from 'semver'
import {
  FUNGIBLE_REFUSAL_TEXTS,
  PERSONA_CHANNEL_DELIVERY_SET,
  PERSONA_DESTINATION_FAILED,
  PERSONA_DIAGNOSTIC_CLASSES,
  PERSONA_INVITED_CHANNEL,
  UNCLAIMED_CHANNEL,
} from '../src/persona-diagnostics.ts'
import { RELOAD_DIAGNOSTIC_CLASSES, RELOAD_RECORD_WRITE_FAILED, reloadChannelDeliveryWriteFailedLine } from '../src/reload.ts'
import { modeSwitchLine, recordedLine, type RecordedSectionKey } from '../src/reload-plan.ts'
import {
  CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES,
  CHANNEL_DELIVERY_DROP_REASONS,
  CHANNEL_DELIVERY_DROP_RETIRED,
  CHANNEL_DELIVERY_FILE_NAME,
  CHANNEL_DELIVERY_LOG_PREFIX,
  CHANNEL_DELIVERY_UNREADABLE,
  CHANNEL_DELIVERY_UNREADABLE_READ,
  SET_CHANNEL_DELIVERY_TOOL,
  channelDeliveryDropAction,
  channelDeliveryDropLine,
  channelDeliverySetAction,
  channelDeliveryUnreadableLine,
  channelDeliveryWriteFailedLine,
} from '../src/channel-delivery.ts'
import {
  channelDeliveryChannelRefusal,
  channelDeliveryDeclarativeRefusal,
  channelDeliveryNotStoredText,
  channelDeliveryUnreadableRefusal,
  channelDeliveryValueRefusal,
  channelDeliveryWriteFailedText,
  personaNotAppliedRefusal,
  sessionNotMatchedRefusal,
} from '../src/registry.ts'
import { DECLARATIVE_DESTINATION_SETTING, FUNGIBLE_DESTINATION_SETTING } from '../src/persona-destination.ts'
import { DM_DESTINATION, type ChannelMode } from '../src/config.ts'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { HostSafetyError, hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  classHeading,
  flat,
  headingAnchors,
  headings,
  requiredSection,
  sectionRange,
  splitFences,
  type HeadingMatch,
} from './test-helpers/markdown.ts'

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

describe("b.deo SRI-901: the debugging skill covers every class in the stored-choice store's closed list", () => {
  // The store's own closed class list (src/channel-delivery.ts), kept apart
  // from the persona and reload classes. Imported, never hand-copied; its
  // exact content is pinned in tests/channel-delivery.test.ts.
  test('CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES is non-empty, so the heading cases never pass on nothing', () => {
    expect(CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
  })

  test.each([...CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES])(
    'SRI-901: the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// 3c. b.deo SRI-1108 — the debugging skill's fungible-mode content (AC 43)
// ---------------------------------------------------------------------------

let skillCache: string | undefined

/** The debugging skill's text, read once, on first use inside a case. */
function debugSkill(): string {
  skillCache ??= readFileSync(resolve(REPO_ROOT, SKILL_REL), 'utf-8')
  return skillCache
}

/**
 * `text` with the body of the first section whose heading matches `match`
 * (its heading line kept) replaced by `edit(body)`: an in-memory copy for a
 * self-check. Throws when no heading matches.
 */
function editSection(text: string, match: HeadingMatch, edit: (body: string) => string): string {
  const range = sectionRange(text, match)
  if (range === undefined) throw new Error(`no heading ${String(match)} to edit`)
  const lines = text.split('\n')
  const body = lines.slice(range.start + 1, range.end).join('\n')
  return [...lines.slice(0, range.start + 1), edit(body), ...lines.slice(range.end)].join('\n')
}

/** Whether the first heading matching `inner` lies inside the section the first heading matching `outer` opens. */
function sitsInside(text: string, outer: HeadingMatch, inner: HeadingMatch): boolean {
  const out = sectionRange(text, outer)
  const at = sectionRange(text, inner)
  return out !== undefined && at !== undefined && at.start > out.start && at.start < out.end
}

/** A Markdown table row's cells, trimmed (the leading and trailing pipes dropped). */
function rowCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

/** Whether `line` is a table row (indented or not) whose first cell is `value` as a code span. */
function isRowFor(line: string, value: string): boolean {
  return line.trimStart().startsWith(`| \`${value}\` |`)
}

/** The first table row in `section` holding `has`; throws naming `where` when there is none. */
function rowHolding(section: string, has: string, where: string): string {
  const row = section.split('\n').find((line) => line.trimStart().startsWith('|') && line.includes(has))
  if (row === undefined) throw new Error(`${where} has no table row holding "${has}"`)
  return row
}

/** The classes SRI-1108 gives an entry each: the two persona classes this work adds and the store's class. */
const SRI_1108_CLASSES = [PERSONA_INVITED_CHANNEL, PERSONA_CHANNEL_DELIVERY_SET, CHANNEL_DELIVERY_UNREADABLE] as const

/** The parts SRI-1108 asks of each entry, each a bold-lead bullet (`- **Line:**`). */
const ENTRY_PARTS = ['Line', 'Meaning', 'Cause', 'Fix'] as const

/** A bullet whose bold lead is `part` (`- **Fix:**`), at the start of a line. */
function partLead(part: string): RegExp {
  return new RegExp(`^- \\*\\*${part}:\\*\\*`, 'm')
}

/**
 * What the class `label`'s entry in `text` lacks: `the line` when it never
 * quotes a `[slack] <label>:` line, and each part whose bold-lead bullet it
 * has not.
 */
function entryProblems(text: string, label: string): string[] {
  const entry = requiredSection(text, classHeading(label), SKILL_REL)
  return [
    ...(entry.includes(`[slack] ${label}:`) ? [] : ['the line']),
    ...ENTRY_PARTS.filter((part) => !partLead(part).test(entry)),
  ]
}

/** The bold leads that open `unclaimed-channel`'s two per-mode parts. */
const DECLARATIVE_LEAD = '**Declarative mode**'
const FUNGIBLE_LEAD = '**Fungible mode**'

/**
 * What `unclaimed-channel`'s entry in `text` lacks under SRI-1108: both
 * per-mode parts; in the declarative part, a Fix that offers fungible mode as
 * a second fix for a public or private channel that is not externally shared
 * and never for a group DM; in the fungible part, the line, and for each
 * fungible-mode reason (imported) a table row with a fix.
 */
function unclaimedProblems(text: string): string[] {
  const lines = requiredSection(text, classHeading(UNCLAIMED_CHANNEL), SKILL_REL).split('\n')
  const d = lines.findIndex((line) => line.startsWith(DECLARATIVE_LEAD))
  const f = lines.findIndex((line) => line.startsWith(FUNGIBLE_LEAD))
  const problems: string[] = []
  if (d < 0) problems.push('no declarative-mode part')
  if (f < 0) problems.push('no fungible-mode part')
  if (problems.length > 0) return problems

  const declarative = lines.slice(d, f > d ? f : undefined).join('\n')
  const fix = declarative.search(partLead('Fix'))
  if (fix < 0) {
    problems.push('declarative: no Fix')
  } else {
    const fixText = flat(declarative.slice(fix))
    if (!fixText.includes('fungible mode on')) problems.push('declarative Fix: no fungible mode as a second fix')
    if (!fixText.includes('public or private channel that is not externally shared')) {
      problems.push('declarative Fix: fungible mode not scoped to a public or private channel that is not externally shared')
    }
    if (!fixText.includes('never for a group DM')) problems.push('declarative Fix: no "never for a group DM"')
  }

  const fungible = lines.slice(f, d > f ? d : undefined).join('\n')
  if (!partLead('Line').test(fungible) || !fungible.includes(`[slack] ${UNCLAIMED_CHANNEL}:`)) problems.push('fungible: no line')
  for (const reason of Object.values(FUNGIBLE_REFUSAL_TEXTS)) {
    const row = fungible.split('\n').find((line) => isRowFor(line, reason))
    const cells = row === undefined ? [] : rowCells(row)
    if (cells.length < 3 || cells[2] === '') problems.push(`fungible: no row with a fix for reason "${reason}"`)
  }
  return problems
}

/** The stored-choice file's section and the store's lines subsection, built from the store's exports. */
const STORED_CHOICE_HEADING = `## The stored-choice file: \`${CHANNEL_DELIVERY_FILE_NAME}\``
const STORE_LINES_HEADING = `### The store's \`${CHANNEL_DELIVERY_LOG_PREFIX}\` lines`

/** What the store's lines subsection in `text` lacks: its place in the stored-choice section, and a row naming each drop reason (imported). */
function storeLinesProblems(text: string): string[] {
  const section = requiredSection(text, STORE_LINES_HEADING, SKILL_REL)
  return [
    ...(sitsInside(text, STORED_CHOICE_HEADING, STORE_LINES_HEADING) ? [] : ['not inside the stored-choice section']),
    ...CHANNEL_DELIVERY_DROP_REASONS.filter(
      (reason) => !section.split('\n').some((line) => isRowFor(line, reason)),
    ).map((reason) => `no row for drop reason "${reason}"`),
  ]
}

/** The silence entry's title (T18's heading, which the wizard and the triage point to). */
const SILENCE_TITLE = 'A persona is silent in a channel its app was invited to'

/** How many headings in `text`, at any level, carry the silence entry's title. */
function silenceEntryCount(text: string): number {
  return headings(text).filter((h) => h.title === SILENCE_TITLE).length
}

/** `DM_DESTINATION` as its own code span, quoted as a setting value (`"dm"`) or bare as a line renders it (`dm`). */
const DM_SPAN = `\`"?${escapeRegExp(DM_DESTINATION)}"?\``

/** The `"dm"` default stated beside `"dm"`: "default" or "absent" within one clause of the span, either side. */
const DM_DEFAULT = new RegExp(`${DM_SPAN}.{0,80}\\b(?:default|absent)\\b|\\b(?:default|absent)\\b.{0,80}${DM_SPAN}`)

/** What a destination passage lacks: the fungible destination setting, and its `"dm"` default (b.deo SRI-1108, SRI-702). */
function destinationProblems(passage: string): string[] {
  const text = flat(passage)
  return [
    ...(text.includes(FUNGIBLE_DESTINATION_SETTING) ? [] : [`names no ${FUNGIBLE_DESTINATION_SETTING}`]),
    ...(DM_DEFAULT.test(text) ? [] : [`names no "${DM_DESTINATION}" default`]),
  ]
}

/** Triage step `n` of the skill, from its `n. ` line to the next numbered step. */
function triageStep(text: string, n: number): string {
  const lines = requiredSection(text, '## Triage', SKILL_REL).split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${n}. `))
  if (start < 0) throw new Error(`${SKILL_REL}, under "## Triage", has no step ${n}`)
  const end = lines.findIndex((line, i) => i > start && /^\d+\. /.test(line))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/**
 * Every passage that describes a persona's destination as its
 * `permission_prompts` value, each located in the skill (T18's closing notes,
 * report-deo-e1 (d)). Each must also give the fungible-mode wording:
 * `invited.permission_prompts`, or `"dm"` when it is absent.
 */
const DESTINATION_PASSAGES: [string, (text: string) => string][] = [
  ['Triage step 1', (text) => triageStep(text, 1)],
  [`the \`${PERSONA_DESTINATION_FAILED}\` entry`, (text) => requiredSection(text, classHeading(PERSONA_DESTINATION_FAILED), SKILL_REL)],
  ["\"A running persona's directory disappears later\"", (text) => requiredSection(text, "### A running persona's directory disappears later", SKILL_REL)],
  [
    `the "Other lines you may see" row for a "${DM_DESTINATION}" destination without DMs or a contact`,
    (text) =>
      rowHolding(
        requiredSection(text, '## Other lines you may see', SKILL_REL),
        `has ${DECLARATIVE_DESTINATION_SETTING} set to "${DM_DESTINATION}"`,
        `${SKILL_REL}, under "## Other lines you may see",`,
      ),
  ],
  ["\"A persona can't open a DM\"", (text) => requiredSection(text, /^## A persona can't open a DM\b/, SKILL_REL)],
  ['"Two personas post lost-message notices about each other"', (text) => requiredSection(text, '### Two personas post lost-message notices about each other', SKILL_REL)],
  [
    "the silence entry's loop-guard row",
    (text) => rowHolding(requiredSection(text, `## ${SILENCE_TITLE}`, SKILL_REL), '| **The loop guard**', `${SKILL_REL}, under "## ${SILENCE_TITLE}",`),
  ],
]

describe('b.deo SRI-1108: the debugging skill describes fungible mode (AC 43)', () => {
  describe('the three entries', () => {
    test.each([...SRI_1108_CLASSES])('the entry for %s quotes its line and has its Line, Meaning, Cause and Fix', (label) => {
      expect(entryProblems(debugSkill(), label)).toEqual([])
    })

    test.each(SRI_1108_CLASSES.flatMap((label) => ENTRY_PARTS.map((part) => [label, part] as const)))(
      'self-check: the entry for %s with its %s lead cut fails on that part alone',
      (label, part) => {
        const cut = editSection(debugSkill(), classHeading(label), (body) => body.replace(partLead(part), `- ${part}:`))
        expect(entryProblems(cut, label)).toEqual([part])
      },
    )

    test.each([...SRI_1108_CLASSES])('self-check: the entry for %s with its line cut fails on the line alone', (label) => {
      const cut = editSection(debugSkill(), classHeading(label), (body) => body.replaceAll(`[slack] ${label}:`, ''))
      expect(entryProblems(cut, label)).toEqual(['the line'])
    })
  })

  describe(`\`${UNCLAIMED_CHANNEL}\`, per mode`, () => {
    test('both modes have their part; the declarative Fix offers fungible mode for a public or private channel that is not externally shared, never for a group DM; the fungible part has its line and a row with a fix for each reason', () => {
      expect(unclaimedProblems(debugSkill())).toEqual([])
    })

    test('FUNGIBLE_REFUSAL_TEXTS is non-empty, so the reason rows are never checked over nothing', () => {
      expect(Object.values(FUNGIBLE_REFUSAL_TEXTS).length).toBeGreaterThan(0)
    })

    /** An in-memory copy of the skill with `edit` applied to `unclaimed-channel`'s entry. */
    const cutEntry = (edit: (body: string) => string) => editSection(debugSkill(), classHeading(UNCLAIMED_CHANNEL), edit)

    test.each(Object.values(FUNGIBLE_REFUSAL_TEXTS))('self-check: the row for reason "%s" cut fails on that reason alone', (reason) => {
      const cut = cutEntry((body) => body.split('\n').filter((line) => !isRowFor(line, reason)).join('\n'))
      expect(unclaimedProblems(cut)).toEqual([`fungible: no row with a fix for reason "${reason}"`])
    })

    test.each(Object.values(FUNGIBLE_REFUSAL_TEXTS))('self-check: the fix of reason "%s" emptied fails on that reason alone', (reason) => {
      const cut = cutEntry((body) =>
        body
          .split('\n')
          .map((line) => (isRowFor(line, reason) ? `  | ${rowCells(line).slice(0, 2).join(' | ')} | |` : line))
          .join('\n'),
      )
      expect(unclaimedProblems(cut)).toEqual([`fungible: no row with a fix for reason "${reason}"`])
    })

    test.each<[string, (body: string) => string, string[]]>([
      ['the declarative-mode lead', (body) => body.replace(DECLARATIVE_LEAD, 'Declarative mode'), ['no declarative-mode part']],
      ['the fungible-mode lead', (body) => body.replace(FUNGIBLE_LEAD, 'Fungible mode'), ['no fungible-mode part']],
      [
        "the declarative part's Fix lead",
        (body) => body.replace(new RegExp(`(${DECLARATIVE_LEAD.replace(/\*/g, '\\*')}[\\s\\S]*?)- \\*\\*Fix:\\*\\*`), '$1- Fix:'),
        ['declarative: no Fix'],
      ],
      ['fungible mode as the second fix', (body) => body.replaceAll('fungible mode on', 'it on'), ['declarative Fix: no fungible mode as a second fix']],
      [
        "the second fix's scope",
        (body) => body.replaceAll('public or private channel that is not externally shared', 'channel'),
        ['declarative Fix: fungible mode not scoped to a public or private channel that is not externally shared'],
      ],
      ['"never for a group DM"', (body) => body.replace(/never for\s+a\s+group\s+DM/, 'not a DM'), ['declarative Fix: no "never for a group DM"']],
      ["the fungible part's line", (body) => body.replace(/^(\*\*Fungible mode\*\*[\s\S]*?)- \*\*Line:\*\*/m, '$1- Shown:'), ['fungible: no line']],
    ])('self-check: %s cut fails on it alone', (_label, edit, expected) => {
      expect(unclaimedProblems(cutEntry(edit))).toEqual(expected)
    })
  })

  describe(`the stored-choice file: \`${CHANNEL_DELIVERY_UNREADABLE}\` and the store's lines`, () => {
    test(`the \`${CHANNEL_DELIVERY_UNREADABLE}\` entry sits inside "${STORED_CHOICE_HEADING}"`, () => {
      expect(sitsInside(debugSkill(), STORED_CHOICE_HEADING, classHeading(CHANNEL_DELIVERY_UNREADABLE))).toBe(true)
    })

    test(`self-check: the \`${CHANNEL_DELIVERY_UNREADABLE}\` entry moved under another section fails`, () => {
      const heading = `### \`${CHANNEL_DELIVERY_UNREADABLE}\``
      const moved = debugSkill().replace(heading, `## Elsewhere\n\n${heading}`)
      expect(sitsInside(moved, STORED_CHOICE_HEADING, classHeading(CHANNEL_DELIVERY_UNREADABLE))).toBe(false)
    })

    test('CHANNEL_DELIVERY_DROP_REASONS is non-empty, so the drop-reason rows are never checked over nothing', () => {
      expect(CHANNEL_DELIVERY_DROP_REASONS.length).toBeGreaterThan(0)
    })

    test(`"${STORE_LINES_HEADING}" sits inside the stored-choice section and has a row for each drop reason`, () => {
      expect(storeLinesProblems(debugSkill())).toEqual([])
    })

    test.each([...CHANNEL_DELIVERY_DROP_REASONS])('self-check: the row for drop reason "%s" cut fails on that reason alone', (reason) => {
      const cut = editSection(debugSkill(), STORE_LINES_HEADING, (body) =>
        body.split('\n').filter((line) => !isRowFor(line, reason)).join('\n'),
      )
      expect(storeLinesProblems(cut)).toEqual([`no row for drop reason "${reason}"`])
    })

    test("self-check: the store's lines subsection moved under another section fails on its place alone", () => {
      const moved = debugSkill().replace(STORE_LINES_HEADING, `## Elsewhere\n\n${STORE_LINES_HEADING}`)
      expect(storeLinesProblems(moved)).toEqual(['not inside the stored-choice section'])
    })
  })

  describe('the silence entry', () => {
    test(`"${SILENCE_TITLE}" is a heading exactly once`, () => {
      expect(silenceEntryCount(debugSkill())).toBe(1)
    })

    test('self-check: with its heading cut the count is 0, and with it repeated the count is 2', () => {
      const heading = `## ${SILENCE_TITLE}`
      expect(silenceEntryCount(debugSkill().replace(heading, '## A persona is quiet'))).toBe(0)
      expect(silenceEntryCount(`${debugSkill()}\n\n${heading}\n`)).toBe(2)
    })
  })

  describe(`each destination passage gives the fungible-mode wording: ${FUNGIBLE_DESTINATION_SETTING}, or "${DM_DESTINATION}" when it is absent`, () => {
    test.each(DESTINATION_PASSAGES)('%s', (_label, passageOf) => {
      expect(destinationProblems(passageOf(debugSkill()))).toEqual([])
    })

    test.each(DESTINATION_PASSAGES)(`self-check: %s with ${FUNGIBLE_DESTINATION_SETTING} cut fails on it alone`, (_label, passageOf) => {
      expect(destinationProblems(passageOf(debugSkill()).replaceAll(FUNGIBLE_DESTINATION_SETTING, ''))).toEqual([
        `names no ${FUNGIBLE_DESTINATION_SETTING}`,
      ])
    })

    test.each(DESTINATION_PASSAGES)(`self-check: %s with its "${DM_DESTINATION}" default cut fails on it alone`, (_label, passageOf) => {
      expect(destinationProblems(passageOf(debugSkill()).replace(/\b(?:default|absent)\b/g, ''))).toEqual([
        `names no "${DM_DESTINATION}" default`,
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// 3d. The debugging skill's quoted texts are its builders' renderings
// ---------------------------------------------------------------------------

/** The placeholders the skill writes in its quoted texts. */
const NAME = '<name>'
const KEY = '<key>'
const PATH = '<path>'

/** Sample values a builder needs in a checked shape, each swapped for its placeholder after rendering. */
const SAMPLE_KEY = 'ops_bot'
const SAMPLE_CHANNEL = 'C0123456789'
const SAMPLE_VALUE = 'often'

/** The text after the persona reference (`"<name>" (key=<key>): `) of a rendered tool error. */
function afterRef(rendered: string): string {
  const ref = `(key=${KEY}): `
  return rendered.slice(rendered.indexOf(ref) + ref.length)
}

/** A recorded change's preview line for `fields`, with its fields and its section's mode as the skill's placeholders. */
function recordedTemplate(fields: RecordedSectionKey[], mode: ChannelMode): string {
  return recordedLine({ name: NAME, key: KEY, fields })
    .replace(`: ${fields.join(', ')} changed`, ': <fields> changed')
    .replace(`the ${mode} section`, 'the <declarative or fungible> section')
    .replace(`selects ${mode} mode`, 'selects <declarative or fungible> mode')
}

/** The switch's preview line turning `mode` on for one persona, with the mode and the further personas as the skill's placeholders. */
function modeSwitchTemplate(mode: ChannelMode): string {
  return modeSwitchLine(mode, [{ name: NAME, key: KEY }])
    .replace(`turns ${mode} mode on`, 'turns <fungible or declarative> mode on')
    .replace(/\.$/, ', ….')
}

/**
 * Each text the debugging skill quotes from a `src/` builder, rendered by the
 * builder with the skill's placeholders, and the section that quotes it: the
 * `set_channel_delivery` refusals and failed-write texts (b.deo SRI-502,
 * SRI-503, SRI-506), the store's lines (SRI-904, SRI-905), the stored-choice
 * `reload-record-write-failed` line (SRI-408), and the switch's and the
 * recorded change's preview lines (SRI-803, SRI-804). Rendered when a case
 * runs, never at collection.
 */
const QUOTED_TEXTS: [label: string, where: HeadingMatch, render: () => string][] = [
  ['the session-not-matched refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL)],
  ['the not-an-applied-persona refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, KEY)],
  ['the declarative-mode refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => channelDeliveryDeclarativeRefusal(NAME, KEY)],
  ['the unreadable-store refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => channelDeliveryUnreadableRefusal(NAME, KEY, PATH)],
  ['the unreadable-store refusal, in its own entry', classHeading(CHANNEL_DELIVERY_UNREADABLE), () => channelDeliveryUnreadableRefusal(NAME, KEY, PATH)],
  [
    'the bad-value refusal naming the value',
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => channelDeliveryValueRefusal(NAME, KEY, SAMPLE_VALUE).replace(JSON.stringify(SAMPLE_VALUE), '"<value>"'),
  ],
  ['the bad-value refusal not showing the value', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => `… ${afterRef(channelDeliveryValueRefusal(NAME, KEY, 42))}`],
  [
    'the unknown-channel refusal naming the channel',
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => channelDeliveryChannelRefusal(NAME, KEY, SAMPLE_CHANNEL).replace(JSON.stringify(SAMPLE_CHANNEL), '"<channel>"'),
  ],
  [
    'the unknown-channel refusal not showing the channel, up to its reason',
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => {
      const tail = afterRef(channelDeliveryChannelRefusal(NAME, KEY, 42))
      return `… ${tail.slice(0, tail.indexOf('): ') + 3)}…`
    },
  ],
  ['the failed-write tool error', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => channelDeliveryWriteFailedText(NAME, KEY, PATH)],
  ['the failed-write tool error, under the store\'s lines', STORE_LINES_HEADING, () => channelDeliveryWriteFailedText(NAME, KEY, PATH)],
  [
    'the not-stored tool error',
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => channelDeliveryNotStoredText(NAME, KEY, 'set_at').replace('its set_at)', 'its <field>)'),
  ],
  [
    `the ${CHANNEL_DELIVERY_UNREADABLE} line`,
    classHeading(CHANNEL_DELIVERY_UNREADABLE),
    () =>
      channelDeliveryUnreadableLine(PATH, { stage: CHANNEL_DELIVERY_UNREADABLE_READ, code: undefined }).replace(
        `${JSON.stringify(PATH)} could not be read.`,
        `${JSON.stringify(PATH)} <what>.`,
      ),
  ],
  [
    "the store's drop line",
    STORE_LINES_HEADING,
    () =>
      channelDeliveryDropLine(SAMPLE_KEY, 2, CHANNEL_DELIVERY_DROP_RETIRED)
        .replace(`persona=${SAMPLE_KEY}`, `persona=${KEY}`)
        .replace('in 2 channels', 'in <n> channels')
        .replace(CHANNEL_DELIVERY_DROP_RETIRED, '<reason>'),
  ],
  [
    "the store's failed-write line for a stored choice",
    STORE_LINES_HEADING,
    () =>
      channelDeliveryWriteFailedLine(PATH, channelDeliverySetAction(SAMPLE_KEY, SAMPLE_CHANNEL), '', false)
        .replace(`persona=${SAMPLE_KEY}`, `persona=${KEY}`)
        .replace(`channel ${SAMPLE_CHANNEL}`, 'channel <id>')
        .replace(`${JSON.stringify(PATH)};`, `${JSON.stringify(PATH)}<detail>;`),
  ],
  [
    "the store's failed-write line for a drop",
    STORE_LINES_HEADING,
    () =>
      channelDeliveryWriteFailedLine(PATH, channelDeliveryDropAction([SAMPLE_KEY]), '', true)
        .replace(`persona=${SAMPLE_KEY}`, `persona=${KEY}`)
        .replace(`${JSON.stringify(PATH)};`, `${JSON.stringify(PATH)}<detail>;`),
  ],
  [
    `the stored-choice ${RELOAD_RECORD_WRITE_FAILED} line`,
    classHeading(RELOAD_RECORD_WRITE_FAILED),
    () => reloadChannelDeliveryWriteFailedLine(PATH, '<record path>'),
  ],
  ['the recorded line for the declarative section', '### Pending changes', () => recordedTemplate(['channels', 'permission_prompts'], 'declarative')],
  ['the recorded line for the fungible section', '### Pending changes', () => recordedTemplate(['invited'], 'fungible')],
  ["the switch's line turning fungible mode on", '### Pending changes', () => modeSwitchTemplate('fungible')],
  ["the switch's line turning declarative mode on", '### Pending changes', () => modeSwitchTemplate('declarative')],
  [
    "the switch line's ending with no persona affected",
    '### Pending changes',
    () => {
      const line = modeSwitchLine('fungible', [])
      return `\`${line.slice(line.lastIndexOf('; '))}\``
    },
  ],
]

/** Whether `section` quotes `text`, compared with whitespace runs collapsed so a wrapped quote still counts. */
function quotes(section: string, text: string): boolean {
  return flat(section).includes(flat(text))
}

describe("the debugging skill's quoted texts are their builders' renderings (b.deo SRI-1108)", () => {
  test.each(QUOTED_TEXTS)('%s', (label, where, render) => {
    const rendered = render()
    assertNoLeak(rendered, label)
    expect(rendered).not.toContain('\n')
    expect(quotes(requiredSection(debugSkill(), where, SKILL_REL), rendered)).toBe(true)
  })

  test.each(QUOTED_TEXTS)('self-check: %s cut from its section is no longer found', (_label, where, render) => {
    const section = flat(requiredSection(debugSkill(), where, SKILL_REL))
    expect(quotes(section.replaceAll(flat(render()), ''), render())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3e. The debugging skill's own links resolve
// ---------------------------------------------------------------------------

/** Every inline link target in the prose of `text` (fenced blocks skipped), as written. */
function linkTargets(text: string): string[] {
  return [...splitFences(text).prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
}

/**
 * Every link in `text` (the skill's text) that resolves nowhere: a same-file
 * anchor that is no heading's anchor in `text`, or a relative path (from the
 * skill's directory) to no file, or with an anchor that is no heading's
 * anchor in that file. Links with a scheme (`https:`) are not followed.
 */
function brokenSkillLinks(text: string): { checked: number; broken: string[] } {
  const own = headingAnchors(text)
  const anchorsOf = new Map<string, string[]>()
  const targets = linkTargets(text).filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target))
  const broken = targets.filter((target) => {
    const hash = target.indexOf('#')
    const path = hash < 0 ? target : target.slice(0, hash)
    const anchor = hash < 0 ? '' : target.slice(hash + 1)
    if (path === '') return !own.includes(anchor)
    const file = resolve(REPO_ROOT, dirname(SKILL_REL), path)
    if (!existsSync(file)) return true
    if (anchor === '') return false
    if (!anchorsOf.has(file)) anchorsOf.set(file, headingAnchors(readFileSync(file, 'utf-8')))
    return !anchorsOf.get(file)!.includes(anchor)
  })
  return { checked: targets.length, broken }
}

describe("the debugging skill's links resolve", () => {
  test('every same-file anchor names a skill heading, and every relative link an existing file and, with an anchor, one of its headings', () => {
    const { checked, broken } = brokenSkillLinks(debugSkill())
    expect(broken).toEqual([])
    expect(checked).toBeGreaterThan(0)
  })

  test.each([
    ['a same-file anchor with no heading', '[gone](#no-such-heading-in-the-skill)', '#no-such-heading-in-the-skill'],
    ['a relative link to no file', '[gone](../../NO_SUCH_FILE.md)', '../../NO_SUCH_FILE.md'],
    ['a README link to no heading', '[gone](../../README.md#no-such-heading-in-the-readme)', '../../README.md#no-such-heading-in-the-readme'],
  ])('self-check: %s added to a copy is reported', (_label, link, target) => {
    expect(brokenSkillLinks(`${debugSkill()}\n\nSee ${link}.\n`).broken).toEqual([target])
  })
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
