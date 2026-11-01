/**
 * packaging-completeness.test.ts — regression guard.
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
 *      without anyone noticing. A hermetic companion checks package.json's
 *      inclusion and exclusion patterns for every runtime source file, including
 *      the tag-wrapper, delivery-queue, delivery-intake and delivery-notices modules. The npm
 *      probe gives the authoritative file list and skips only if npm is absent.
 *
 * guard: the shipped debugging skill
 * `skills/debug-slack-channel-bots/SKILL.md` must be in the npm pack list
 * (same probe and skip/error contract as guard 2), with a hermetic companion
 * that needs no npm (the file exists with a `name` matching its directory and
 * a `description`, and package.json `files` covers the skill's path with no
 * `!` entry excluding it), and a class-coverage check: every label in
 * PERSONA_DIAGNOSTIC_CLASSES (imported, side-effect free) names a `##`–`####`
 * heading in the skill (the skill gives each class a `###` heading naming it),
 * so a class added without a skill entry, or an entry cut down to a passing
 * mention, fails here. DELIVERY_DIAGNOSTIC_CLASSES,
 * THREAD_MEMORY_DIAGNOSTIC_CLASSES and SHARED_STATE_DIAGNOSTIC_CLASSES
 * also require nonempty Line, Meaning, Cause and Fix bullets plus their log
 * label; the five Thread Memory reports and three shared-state report
 * entries quote the notice titles rendered by their production builders.
 * In-memory omission controls use the same check as the shipped document.
 * RELOAD_DIAGNOSTIC_CLASSES (src/reload.ts, imported,
 * side-effect free) gets the same heading check in its own `test.each`, plus
 * a non-empty, duplicate-free check on the list. The stored-choice store's
 * own closed list, CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES (src/channel-delivery.ts,
 * imported), gets the same heading check in its own
 * `test.each`, behind a non-empty guard; the list's exact content is pinned
 * in tests/channel-delivery.test.ts, not here. The forbidden-term audit and
 * the exception over all shipped text live in
 * tests/shipped-docs.test.ts.
 *
 * : the debugging skill's open-mode content, read
 * by heading title through the markdown helper, with every class label, drop
 * reason, `unclaimed-channel` reason text, file name and setting name
 * imported from `src/`:
 *   - the entries for `persona-invited-channel`, `persona-channel-delivery-set`
 *     and `channel-delivery-unreadable` each quote their `[slack] <label>:`
 *     line and have a Line, Meaning, Cause and Fix bullet;
 *   - `unclaimed-channel` has a strict-mode and a open-mode part: the
 *     declarative Fix offers open mode as a second fix for a public or
 *     private channel that is not externally shared, and never for a group
 *     DM; the fungible part quotes its line and has a table row with a fix
 *     for each open-mode reason;
 *   - `### \`channel-delivery-unreadable\`` and the store's
 *     `[slack] channel-delivery:` lines subsection sit inside the
 *     stored-choice file's section, and the subsection has a row for each
 *     drop reason;
 *   - the entry for a persona silent in a channel its app was invited to is
 *     a heading exactly once;
 *   - each passage that describes a destination as the `permission_prompts`
 *     value (a file-local list, located by heading, table row or bullet
 *     lead) also names `invited.permission_prompts` and its `"dm"` default
 *     (`DM_DESTINATION`, quoted or bare as a log line renders it); a passage
 *     naming the setting a confirmed change moves the destination by names
 *     `invited.permission_prompts`.
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
 * the setup wizard's credentials script,
 * `scripts/write-credentials.sh` (which `claude-slack-channel-bots
 * credentials` runs), is in the npm pack list, with the same hermetic
 * companion (the file exists and package.json `files` covers it).
 *
 * the TOML parser CSCB reads agent-director's settings file
 * with, `smol-toml`, is a runtime dependency pinned at exactly one version
 * (no range): `package.json` `dependencies` names it with that exact spec
 * (never in `devDependencies`), and `bun.lock` records the same spec for the
 * root workspace and resolves the package to that version. Hermetic: both
 * files are read from the tree, with no npm call and no child process. Its
 * bun.lock half reads through `lockPin`, the file's bun.lock pin reader
 * (the root workspace's spec, the other sections naming the package, and the
 * resolved entry with its source).
 *
 * part of the contract merge check: the shipped `package.json`
 * depends on agent-director at exactly the Phase 1 release's version — one
 * exact version, with no range operator, pre-release suffix or build
 * metadata, equal to CSCB's floor (`PHASE1_FLOOR_VERSION`) — and
 * `bun.lock` resolves to it. `clientPinVerdict` is that rule as a pure,
 * file-local checker: given a spec and the floor it answers whether the spec
 * is the pin, and names the first rule broken (a range, a dist-tag such as
 * `latest`, a file, git or URL source, a pre-release, build metadata or
 * another version). Its fixture specs are all built from the floor or the
 * versions helper (`tests/test-helpers/agent-director-versions.ts`), never
 * typed; `lockPin`'s fixture lock objects show it reports a mismatched
 * workspace spec, a release-candidate resolution and a file source.
 *
 * The real files are checked with both: `package.json` names agent-director
 * in `dependencies` and in no other section, with a spec `clientPinVerdict`
 * accepts against the floor; `bun.lock`'s root workspace names the same
 * spec, in `dependencies` only; and its `packages` entry resolves
 * `agent-director@<floor>` from the default registry, with an integrity hash.
 *
 * Every npm-backed test shares one memoised pack probe per file load. Each npm
 * child's environment is a direct `hostSafeChildEnv` call: the probe's temp dir as HOME, only `npm` and `node` on PATH, and a
 * throwaway cache and user config inside that dir as extras, so it never reads
 * or writes the real HOME and inherits nothing else from the
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
  DELIVERY_DIAGNOSTIC_CLASSES,
  THREAD_MEMORY_DIAGNOSTIC_CLASSES,
  SHARED_STATE_DIAGNOSTIC_CLASSES,
  SHARED_STATE_UNRESOLVED,
  MEMBERSHIP_EVIDENCE_UNRESOLVED,
  SHARED_STATE_RECOVERED,
  THREAD_MEMORY_NOT_SAVED,
  THREAD_MEMORY_UNREADABLE,
  THREAD_MEMORY_JOINS_LOST,
  THREAD_MEMORY_CHANGED_WHILE_STOPPED,
  THREAD_MEMORY_RECOVERED,
  PERSONA_INVITED_CHANNEL,
  UNCLAIMED_CHANNEL,
  channelDeliverySetCause,
  formatPersonaDiagnostic,
  fungibleUnclaimedChannelCause,
  invitedChannelCause,
  NO_STORED_CHOICE,
  type PersonaDiagnosticClass,
} from '../src/persona-diagnostics.ts'
import { RELOAD_DIAGNOSTIC_CLASSES, RELOAD_RECORD_WRITE_FAILED } from '../src/reload.ts'
import { modeSwitchLine } from '../src/reload-plan.ts'
import { CHANNEL_DELIVERY_FILE_NAME, SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import {
  channelDeliveryAttemptResultText,
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
import {
  stateDirFailedLine,
  stateDirLegacyServerRunningLine,
  stateDirLegacyUnusableLine,
  stateDirLinkFailedLine,
  stateDirMergedLine,
  stateDirPendingLine,
  stateDirRenamedLine,
  stateDirRepointedLine,
  stateDirRepointFailedLine,
} from '../src/state-dir-migration.ts'
import { DELIVERY_MODES, DM_DESTINATION, type ChannelMode } from '../src/config.ts'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { HostSafetyError, hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { deliveryResultSamples, sharedChannelPath, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { THREAD_PERSONAS, THREAD_CHANNELS, THREAD_ROOTS, threadPath } from './test-helpers/thread-memory.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  THREAD_MEMORY_OWN_POST_LOSS_WARNING,
  buildThreadMemoryNotSavedNotice,
  buildThreadMemoryUnreadableNotice,
  buildThreadMemoryJoinsLostNotice,
  buildThreadMemoryChangedWhileStoppedNotice,
  buildThreadMemoryRecoveredNotice,
} from '../src/thread-memory-reports.ts'
import {
  buildSharedStateUnresolvedNotice,
  buildMembershipEvidenceUnresolvedNotice,
  buildSharedStateRecoveredNotice,
} from '../src/shared-state-reports.ts'
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

describe('version gate for the cron feature', () => {
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

describe('npm pack ships every runtime src file', () => {
  const probe = packProbe()

  // Skip ONLY when the npm toolchain is absent. With npm present, a pack or
  // parse failure is surfaced as a hard failure below — a skip must never hide
  // a real packaging fault.
  test.skipIf(probe.kind === 'skip')(
    // Superset over ALL runtime src/*.ts, so the five cron files that motivated
    // (cron-bootstrap, cron-dispatch, cron-log, cron-scheduler, crontable)
    // are covered as a special case, along with any future new src file.
    'the packed file set is a superset of the repo runtime src/*.ts files',
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      const packedSet = new Set(probe.kind === 'ok' ? probe.files : [])
      const missing = runtimeSrcFiles().filter((rel) => !packedSet.has(rel))
      expect(missing).toEqual([])
    },
  )

  test.each([
    'src/channel-delivery-attempt.ts',
    'src/file-upload-observation.ts',
    'src/thread-memory.ts',
    'src/own-post.ts',
    'src/own-post-joins.ts',
    'src/own-post-lookup.ts',
  ])('%s is inventoried, included, and an explicit exclusion fails coverage', path => {
    const files = readPkg().files ?? []
    expect(runtimeSrcFiles()).toContain(path)
    expect(filesCover(files, path)).toBe(true)
    expect(filesCover([...files, `!${path}`], path)).toBe(false)
  })

  test('(hermetic): package.json files covers every runtime src/*.ts file with no ! entry excluding it', () => {
    const runtimeFiles = runtimeSrcFiles()
    expect(runtimeFiles.length).toBeGreaterThan(0)
    const files = readPkg().files ?? []
    expect(runtimeFiles.filter((rel) => !filesCover(files, rel))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. the debugging skill ships
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

describe('the debugging skill ships in the package', () => {
  const probe = packProbe()

  // Same contract as guard 2: skip only when npm is absent; a pack or parse
  // error is a hard failure.
  test.skipIf(probe.kind === 'skip')(
    `the npm pack file list includes ${SKILL_REL}`,
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      expect(probe.kind === 'ok' ? probe.files : []).toContain(SKILL_REL)
    },
  )

  // Hermetic companion: guards where npm is unavailable.
  test('(hermetic): the skill file exists, is non-empty and has name and description frontmatter', () => {
    const path = resolve(REPO_ROOT, SKILL_REL)
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    expect(text.trim().length).toBeGreaterThan(0)
    const fm = skillFrontmatter(text)
    expect(fm).not.toBeNull()
    expect(fm?.name).toBe(SKILL_NAME)
    expect(fm?.description ?? '').not.toBe('')
  })

  test(`(hermetic): package.json files covers ${SKILL_REL} and no ! entry excludes it`, () => {
    expect(filesCover(readPkg().files ?? [], SKILL_REL)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3b. The setup wizard's credentials script ships
// ---------------------------------------------------------------------------

/** The script `claude-slack-channel-bots credentials` runs, from the package root. */
const CREDENTIALS_SCRIPT_REL = 'scripts/write-credentials.sh'

describe('the credentials script ships in the package', () => {
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
    `(?<![\\w-])${escapeRegExp(label)}(?![\\w-])`,
  )
  return headings(text).some((heading) => heading.level >= 2 && heading.level <= 4 && re.test(heading.title))
}

/** The parts required of each full diagnostic entry. */
const ENTRY_PARTS = ['Line', 'Meaning', 'Cause', 'Fix'] as const

/** Use the same rule for the real document and its omission controls. */
function fullDiagnosticEntryProblems(text: string, label: string): string[] {
  const entry = requiredSection(text, classHeading(label), SKILL_REL)
  const { prose } = splitFences(entry)
  return [
    ...ENTRY_PARTS.filter(part => !new RegExp(`^- \\*\\*${part}:\\*\\*[ \\t]+\\S`, 'm').test(prose)),
    ...(entry.includes(`[slack] ${label}:`) ? [] : ['the line']),
  ]
}

// Only the five report labels have notices. Log-only labels are still audited
// through the entire exported class list above, including future additions.
const THREAD_REPORT_SAMPLES: ReadonlyArray<readonly [string, () => string]> = [
  [THREAD_MEMORY_NOT_SAVED, () => buildThreadMemoryNotSavedNotice(threadReportRef(), [THREAD_CHANNELS.primary], threadPath('<state dir>'), 'journal-append', new Error('fixture storage failure'))],
  [THREAD_MEMORY_UNREADABLE, () => buildThreadMemoryUnreadableNotice(threadReportRef(), [THREAD_CHANNELS.primary], threadPath('<state dir>'))],
  [THREAD_MEMORY_JOINS_LOST, () => buildThreadMemoryJoinsLostNotice(
    { name: THREAD_PERSONAS.primary, key: THREAD_PERSONAS.primary },
    { threads: [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary }], messages: [] },
  ).text],
  [THREAD_MEMORY_CHANGED_WHILE_STOPPED, () => buildThreadMemoryChangedWhileStoppedNotice(threadReportRef(), [THREAD_CHANNELS.primary], 'changed')],
  [THREAD_MEMORY_RECOVERED, () => buildThreadMemoryRecoveredNotice(threadReportRef(), [THREAD_CHANNELS.primary])],
]

const SHARED_REPORT_SAMPLES: ReadonlyArray<readonly [string, () => string]> = [
  [SHARED_STATE_UNRESOLVED, () => buildSharedStateUnresolvedNotice(threadReportRef(), { channels: [SHARED_CHANNEL_IDS.primary] }, 'unsynced', sharedChannelPath('<state dir>'))],
  [MEMBERSHIP_EVIDENCE_UNRESOLVED, () => buildMembershipEvidenceUnresolvedNotice(threadReportRef(), { channels: [SHARED_CHANNEL_IDS.primary] }, { problem: 'deadline' })],
  [SHARED_STATE_RECOVERED, () => buildSharedStateRecoveredNotice(threadReportRef(), { channels: [SHARED_CHANNEL_IDS.primary] }, 'state')],
]
const REPORT_SAMPLES = [...THREAD_REPORT_SAMPLES, ...SHARED_REPORT_SAMPLES]
const FULL_ENTRY_CLASSES = [...DELIVERY_DIAGNOSTIC_CLASSES, ...THREAD_MEMORY_DIAGNOSTIC_CLASSES, ...SHARED_STATE_DIAGNOSTIC_CLASSES]
const ENTRY_CONTROL_CLASSES = [...THREAD_MEMORY_DIAGNOSTIC_CLASSES, ...SHARED_STATE_DIAGNOSTIC_CLASSES]

function threadReportRef(): string {
  return renderPersonaRef(THREAD_PERSONAS.primary, THREAD_PERSONAS.primary)
}

function noticeTitle(render: () => string): string {
  const notice = render()
  assertNoLeak(notice, 'documentation notice')
  const title = notice.match(/\*[^*\n]+\*/)?.[0]
  if (!title) throw new Error('notice builder returned no title')
  return title
}

function hasNoticeTitle(text: string, label: string, title: string): boolean {
  return splitFences(requiredSection(text, classHeading(label), SKILL_REL)).blocks
    .some(block => block.body.includes(title))
}

describe('the debugging skill covers every persona diagnostic class', () => {
  test('delivery diagnostic labels belong to the audited persona catalogue', () => {
    expect(DELIVERY_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(DELIVERY_DIAGNOSTIC_CLASSES).size).toBe(DELIVERY_DIAGNOSTIC_CLASSES.length)
    expect(PERSONA_DIAGNOSTIC_CLASSES).toEqual(expect.arrayContaining([...DELIVERY_DIAGNOSTIC_CLASSES]))
  })
  test('Thread Memory diagnostic labels belong to the audited persona catalogue', () => {
    expect(THREAD_MEMORY_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(THREAD_MEMORY_DIAGNOSTIC_CLASSES).size).toBe(THREAD_MEMORY_DIAGNOSTIC_CLASSES.length)
    expect(PERSONA_DIAGNOSTIC_CLASSES).toEqual(expect.arrayContaining([...THREAD_MEMORY_DIAGNOSTIC_CLASSES]))
    const reports = THREAD_REPORT_SAMPLES.map(([label]) => label)
    expect(new Set(reports).size).toBe(5)
    expect(THREAD_MEMORY_DIAGNOSTIC_CLASSES).toEqual(expect.arrayContaining(reports))
  })
  test('shared-state diagnostic labels belong to the audited persona catalogue and each has a notice sample', () => {
    expect(SHARED_STATE_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(SHARED_STATE_DIAGNOSTIC_CLASSES).size).toBe(SHARED_STATE_DIAGNOSTIC_CLASSES.length)
    expect(PERSONA_DIAGNOSTIC_CLASSES).toEqual(expect.arrayContaining([...SHARED_STATE_DIAGNOSTIC_CLASSES]))
    expect(SHARED_REPORT_SAMPLES.map(([label]) => label).sort()).toEqual([...SHARED_STATE_DIAGNOSTIC_CLASSES].sort())
  })
  // Labels come from the exported closed set, never a hand-copied list, so a
  // class added later without a skill entry fails here.
  test.each([...PERSONA_DIAGNOSTIC_CLASSES])(
    'the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
      if ((FULL_ENTRY_CLASSES as readonly string[]).includes(label)) {
        expect(fullDiagnosticEntryProblems(debugSkill(), label)).toEqual([])
      }
    },
  )

  test.each(ENTRY_CONTROL_CLASSES)('self-check: %s needs its own heading and log line', label => {
    const text = debugSkill()
    const range = sectionRange(text, classHeading(label))!
    const withoutHeading = text.split('\n').filter((_, i) => i !== range.start).join('\n')
    expect(() => fullDiagnosticEntryProblems(withoutHeading, label)).toThrow('has no heading')
    const withoutLine = editSection(text, classHeading(label), body => body.replaceAll(`[slack] ${label}:`, ''))
    expect(fullDiagnosticEntryProblems(withoutLine, label)).toEqual(['the line'])
  })

  test.each(ENTRY_CONTROL_CLASSES.flatMap(label => ENTRY_PARTS.map(part => [label, part] as const)))(
    'self-check: %s needs a nonempty %s part in its own entry', (label, part) => {
      for (const replacement of ['', `- **${part}:**`]) {
        const changed = editSection(debugSkill(), classHeading(label), body => body.replace(
          new RegExp(`^- \\*\\*${part}:\\*\\*[^\\n]*`, 'm'), replacement,
        ))
        expect(changed).not.toBe(debugSkill())
        // An inline Line bullet can also be the entry's only log marker.
        const removedLogLine = part === 'Line' && !requiredSection(changed, classHeading(label), SKILL_REL).includes(`[slack] ${label}:`)
        expect(fullDiagnosticEntryProblems(changed, label)).toEqual(removedLogLine ? [part, 'the line'] : [part])
      }
    },
  )

  test.each([
    ['Thread Memory', THREAD_MEMORY_DIAGNOSTIC_CLASSES],
    ['shared state', SHARED_STATE_DIAGNOSTIC_CLASSES],
  ] as const)('self-check: adding a %s diagnostic label without an entry fails', (_family, classes) => {
    const extra = `${classes[0]}-undocumented`
    const labels = [...classes, extra]
    expect(() => labels.map(label => fullDiagnosticEntryProblems(debugSkill(), label))).toThrow('has no heading')
  })

  test.each(REPORT_SAMPLES)('%s quotes the title rendered by its notice builder', (label, render) => {
    expect(hasNoticeTitle(debugSkill(), label, noticeTitle(render))).toBe(true)
    if (label === THREAD_MEMORY_NOT_SAVED || label === THREAD_MEMORY_UNREADABLE) {
      const notices = splitFences(requiredSection(debugSkill(), classHeading(label), SKILL_REL)).blocks
        .filter(block => block.body.includes(noticeTitle(render)))
      // The warning belongs in each quoted notice, not merely in the prose
      // or in the neighbouring outage entry.
      for (const notice of notices) expect(notice.body).toContain(THREAD_MEMORY_OWN_POST_LOSS_WARNING)
    }
  })

  test.each(REPORT_SAMPLES)('self-check: %s fails when its quoted notice title is removed', (label, render) => {
    const title = noticeTitle(render)
    const changed = editSection(debugSkill(), classHeading(label), body => body.replaceAll(title, ''))
    expect(changed).not.toBe(debugSkill())
    expect(hasNoticeTitle(changed, label, title)).toBe(false)
    expect(fullDiagnosticEntryProblems(changed, label)).toEqual([])
  })
})

describe('the debugging skill covers every reload diagnostic class', () => {
  // The reload classes are their own exported closed set, kept apart from the
  // persona classes. Imported, never hand-copied, so
  // a reload class added without a skill entry fails here.
  test('RELOAD_DIAGNOSTIC_CLASSES is non-empty and has no duplicates', () => {
    expect(RELOAD_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(RELOAD_DIAGNOSTIC_CLASSES).size).toBe(
      RELOAD_DIAGNOSTIC_CLASSES.length,
    )
  })

  test.each([...RELOAD_DIAGNOSTIC_CLASSES])(
    'the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})



// ---------------------------------------------------------------------------
// 3c. — the debugging skill's open-mode content
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

/** The classes gives an entry each: the two persona classes this work adds and the store's class. */
const INVITED_CHANNEL_CLASSES = [
PERSONA_INVITED_CHANNEL,
PERSONA_CHANNEL_DELIVERY_SET
] as const

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
const DECLARATIVE_LEAD = '**Strict mode**'
const FUNGIBLE_LEAD = '**Open mode**'

/**
 * What `unclaimed-channel`'s entry in `text` lacks under both
 * per-mode parts; in the strict part, a Fix requiring an explicit shared choice,
 * explaining that a mode change alone creates none, and restricting open mode
 * to eligible public/private channels, never group DMs; in the fungible part, the line, and for each
 * open-mode reason (imported) a table row with a fix.
 */
function unclaimedProblems(text: string): string[] {
  const lines = requiredSection(text, classHeading(UNCLAIMED_CHANNEL), SKILL_REL).split('\n')
  const d = lines.findIndex((line) => line.startsWith(DECLARATIVE_LEAD))
  const f = lines.findIndex((line) => line.startsWith(FUNGIBLE_LEAD))
  const problems: string[] = []
  if (d < 0) problems.push('no strict-mode part')
  if (f < 0) problems.push('no open-mode part')
  if (problems.length > 0) return problems

  const declarative = lines.slice(d, f > d ? f : undefined).join('\n')
  const fix = declarative.search(partLead('Fix'))
  if (fix < 0) {
    problems.push('declarative: no Fix')
  } else {
    const fixText = flat(declarative.slice(fix))
    if (!fixText.includes('explicitly assign a non-off shared channel choice')) problems.push('declarative Fix: no explicit shared choice')
    if (!fixText.includes('Selecting open mode alone does not create a choice')) problems.push('declarative Fix: no mode-only warning')
    if (!fixText.includes('public or private channels that are not externally shared')) {
      problems.push('declarative Fix: shared choice not scoped to public or private channels that are not externally shared')
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

/** What the store's lines subsection in `text` lacks: its place in the stored-choice section, and a row naming each drop reason (imported). */


/** The silence entry's title (T18's heading, which the wizard and the triage point to). */
const SILENCE_TITLE = 'A persona is silent in a channel its app was invited to'

/** How many headings in `text`, at any level, carry the silence entry's title. */
function silenceEntryCount(text: string): number {
  return headings(text).filter((h) => h.title === SILENCE_TITLE).length
}

/** `DM_DESTINATION` as its own code span, quoted as a setting value (`"dm"`) or bare as a line renders it (`dm`). */
const DM_SPAN = `\`"?${escapeRegExp(DM_DESTINATION)}"?\``

/** What a passage lacks of the fungible destination setting's name. */
function settingProblems(passage: string): string[] {
  return flat(passage).includes(FUNGIBLE_DESTINATION_SETTING) ? [] : [`names no ${FUNGIBLE_DESTINATION_SETTING}`]
}

/** What a destination passage lacks: the fungible destination setting, and its `"dm"` default. */
function destinationProblems(passage: string): string[] {
  return settingProblems(passage)
}

/**
 * The bullet in `section` whose line starts (after its indent) with `lead`,
 * with its continuation and nested lines: up to the next non-blank line
 * indented no deeper than it. Throws naming `where` when no line has the lead.
 */
function bulletLed(section: string, lead: string, where: string): string {
  const lines = section.split('\n')
  const indentOf = (line: string) => line.length - line.trimStart().length
  const start = lines.findIndex((line) => line.trimStart().startsWith(lead))
  if (start < 0) throw new Error(`${where} has no bullet led by "${lead}"`)
  const end = lines.findIndex((line, i) => i > start && line.trim() !== '' && indentOf(line) <= indentOf(lines[start]))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/** The bullet led by `lead` in the `persona-destination-failed` entry. */
function destinationFailedBullet(text: string, lead: string): string {
  return bulletLed(
    requiredSection(text, classHeading(PERSONA_DESTINATION_FAILED), SKILL_REL),
    lead,
    `${SKILL_REL}, under the \`${PERSONA_DESTINATION_FAILED}\` entry,`,
  )
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
 * report-deo-e1 (d)). Each must also give the open-mode wording:
 * `invited.permission_prompts`, or `"dm"` when it is absent.
 */
const DESTINATION_PASSAGES: [string, (text: string) => string][] = [
  [`the \`${PERSONA_DESTINATION_FAILED}\` entry's open-mode <dest>`, (text) => destinationFailedBullet(text, '- **Both modes:**')],
  [`the \`${PERSONA_DESTINATION_FAILED}\` entry's not_in_channel fix`, (text) => destinationFailedBullet(text, '- `not_in_channel`:')],
  [
    `the \`${PERSONA_DESTINATION_FAILED}\` entry's fix sending prompts and notices elsewhere`,
    (text) => destinationFailedBullet(text, "- To send the persona's prompts and notices somewhere else"),
  ],
  ["\"A running persona's directory disappears later\"", (text) => requiredSection(text, "### A running persona's directory disappears later", SKILL_REL)],
  [
    `the "Other lines you may see" row for a "${DM_DESTINATION}" destination without DMs or a contact`,
    (text) =>
      rowHolding(
        requiredSection(text, '## Other lines you may see', SKILL_REL),
        `[slack] persona-destination: <ref>`,
        `${SKILL_REL}, under "## Other lines you may see",`,
      ),
  ],
  [
    '"A persona can\'t open a DM"\'s "Same cause, prompts and notices" bullet',
    (text) =>
      bulletLed(
        requiredSection(text, /^## A persona can't open a DM\b/, SKILL_REL),
        '- **Same cause, prompts and notices:**',
        `${SKILL_REL}, under "## A persona can't open a DM",`,
      ),
  ],
]

/**
 * Passages that name the destination setting a confirmed change moves the
 * destination by, rather than the destination itself: each must name
 * `invited.permission_prompts` for open mode. An absent value and `"dm"`
 * count as the same, so no change between them moves the destination and no
 * `"dm"` default is asked of them.
 */
const SETTING_PASSAGES: [string, (text: string) => string][] = [
  [
    `the \`${PERSONA_DESTINATION_FAILED}\` entry's destination moved by a confirmed change`,
    (text) => destinationFailedBullet(text, '- the line is logged once per episode.'),
  ],
]

/**
 * The skill's text with `cut` applied to the passage `passageOf` locates (an
 * in-memory copy), and that passage located again in the copy. Asserts the
 * cut changed the copy, so a self-check never passes on an untouched text.
 */
function passageAfterCut(passageOf: (text: string) => string, cut: (passage: string) => string): string {
  const passage = passageOf(debugSkill())
  const edited = debugSkill().replace(passage, () => cut(passage))
  expect(edited).not.toBe(debugSkill())
  return passageOf(edited)
}

describe(' : the debugging skill describes open mode ', () => {
  describe('the three entries', () => {
    test.each([...INVITED_CHANNEL_CLASSES])('the entry for %s quotes its line and has its Line, Meaning, Cause and Fix', (label) => {
      expect(entryProblems(debugSkill(), label)).toEqual([])
    })

    test.each(INVITED_CHANNEL_CLASSES.flatMap((label) => ENTRY_PARTS.map((part) => [label, part] as const)))(
      'self-check: the entry for %s with its %s lead cut fails on that part alone',
      (label, part) => {
        const cut = editSection(debugSkill(), classHeading(label), (body) => body.replace(partLead(part), `- ${part}:`))
        expect(entryProblems(cut, label)).toEqual([part])
      },
    )

    test.each([...INVITED_CHANNEL_CLASSES])('self-check: the entry for %s with its line cut fails on the line alone', (label) => {
      const cut = editSection(debugSkill(), classHeading(label), (body) => body.replaceAll(`[slack] ${label}:`, ''))
      expect(entryProblems(cut, label)).toEqual(['the line'])
    })
  })

  describe(`\`${UNCLAIMED_CHANNEL}\`, per mode`, () => {
    test('both modes have their part; strict Fix requires a shared choice, mode alone creates none, only eligible channels and never a group DM; open has its line and a fix for each reason', () => {
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
      ['the strict-mode lead', (body) => body.replace(DECLARATIVE_LEAD, 'Strict mode'), ['no strict-mode part']],
      ['the open-mode lead', (body) => body.replace(FUNGIBLE_LEAD, 'Open mode'), ['no open-mode part']],
      [
        "the declarative part's Fix lead",
        (body) => body.replace(new RegExp(`(${DECLARATIVE_LEAD.replace(/\*/g, '\\*')}[\\s\\S]*?)- \\*\\*Fix:\\*\\*`), '$1- Fix:'),
        ['declarative: no Fix'],
      ],
      ['explicit shared choice', (body) => body.replaceAll('explicitly assign a non-off shared channel choice', 'select a mode'), ['declarative Fix: no explicit shared choice']],
      ['mode alone cannot create a choice', (body) => body.replaceAll('Selecting open mode alone does not create a choice', ''), ['declarative Fix: no mode-only warning']],
      [
        "the second fix's scope",
        (body) => body.replaceAll('public or private channels that are not externally shared', 'channel'),
        ['declarative Fix: shared choice not scoped to public or private channels that are not externally shared'],
      ],
      ['"never for a group DM"', (body) => body.replace(/never for\s+a\s+group\s+DM/, 'not a DM'), ['declarative Fix: no "never for a group DM"']],
      ["the fungible part's line", (body) => body.replace(/^(\*\*Open mode\*\*[\s\S]*?)- \*\*Line:\*\*/m, '$1- Shown:'), ['fungible: no line']],
    ])('self-check: %s cut fails on it alone', (_label, edit, expected) => {
      expect(unclaimedProblems(cutEntry(edit))).toEqual(expected)
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

  describe(`each destination passage names the shared ${FUNGIBLE_DESTINATION_SETTING}`, () => {
    test.each(DESTINATION_PASSAGES)('%s', (_label, passageOf) => {
      expect(destinationProblems(passageOf(debugSkill()))).toEqual([])
    })

    test.each(DESTINATION_PASSAGES)(`self-check: %s with ${FUNGIBLE_DESTINATION_SETTING} cut fails on it alone`, (_label, passageOf) => {
      expect(destinationProblems(passageAfterCut(passageOf, (p) => p.replaceAll(FUNGIBLE_DESTINATION_SETTING, '')))).toEqual([
        `names no ${FUNGIBLE_DESTINATION_SETTING}`,
      ])
    })


  })

  describe(`each passage naming the setting a confirmed change moves the destination by names ${FUNGIBLE_DESTINATION_SETTING}`, () => {
    test.each(SETTING_PASSAGES)('%s', (_label, passageOf) => {
      expect(settingProblems(passageOf(debugSkill()))).toEqual([])
    })

    test.each(SETTING_PASSAGES)(`self-check: %s with ${FUNGIBLE_DESTINATION_SETTING} cut fails`, (_label, passageOf) => {
      expect(settingProblems(passageAfterCut(passageOf, (p) => p.replaceAll(FUNGIBLE_DESTINATION_SETTING, '')))).toEqual([
        `names no ${FUNGIBLE_DESTINATION_SETTING}`,
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
const CHANNEL = '<id>'

/** Sample values a builder needs in a checked shape, each swapped for its placeholder after rendering. */
const SAMPLE_KEY = 'ops_bot'
const SAMPLE_CHANNEL = 'C0123456789'
const SAMPLE_VALUE = 'often'

/** The text after the persona reference (`"<name>" (key=<key>): `) of a rendered tool error. */
function afterRef(rendered: string): string {
  const ref = `(key=${KEY}): `
  return rendered.slice(rendered.indexOf(ref) + ref.length)
}

/** The persona line of class `label` with `cause`, its index, name and key as the skill's placeholders. */
function personaLineTemplate(label: PersonaDiagnosticClass, cause: string): string {
  return formatPersonaDiagnostic({ class: label, name: NAME, key: KEY, index: 0, cause }).replace('personas[0]', 'personas[<i>]')
}

/** The section quoting the start's `[slack] state-migrate:` lines. */
const STATE_LOCATION_HEADING = "## The state directory's location and its move at start"

/** The placeholders the skill writes in the state directory's lines. */
const OLD_STATE = '<old>'
const NEW_STATE = '<new>'
const STATE_TARGET = '<target>'
const STATE_NAME = '<name>'
const STATE_CAUSE = '<cause>'

/** The two legacy paths the skill writes literally in the repoint lines: the old server directory and the 0.15.0 default. */
const LEGACY_SERVER_DIR = '~/.claude/channels/slack'
const LEGACY_XDG_DIR = '~/.config/cscb'

/** `rendered` from the first `start` through the first `end` after it: a quote of one stretch of a line. */
function stretch(rendered: string, start: string, end: string): string {
  const from = rendered.indexOf(start)
  const to = rendered.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`"${start}" through "${end}" is not in the rendering "${rendered}"`)
  return rendered.slice(from, to + end.length)
}

/** `rendered` with what lies between `after` and `before` (both kept) written as ` … `: a quote that skips a stretch. */
function elide(rendered: string, after: string, before: string): string {
  const from = rendered.indexOf(after)
  const to = rendered.indexOf(before, from + after.length)
  if (from < 0 || to < 0) throw new Error(`"${after}" then "${before}" is not in the rendering "${rendered}"`)
  return `${rendered.slice(0, from + after.length)} … ${rendered.slice(to)}`
}

/** `rendered` up to and including the first `through`, then ` …`: a quote the skill cuts short there. */
function quotedUpTo(rendered: string, through: string): string {
  const at = rendered.indexOf(through)
  if (at < 0) throw new Error(`"${through}" is not in the rendering "${rendered}"`)
  return `${rendered.slice(0, at + through.length)} …`
}

/** The switch's preview line turning `mode` on for one persona, with the mode and the further personas as the skill's placeholders. */
function modeSwitchTemplate(mode: ChannelMode): string {
  return modeSwitchLine(mode, [{ name: NAME, key: KEY }])
    .replace(`turns ${mode} mode on`, 'turns <open or strict> mode on')
    .replace(/\.$/, ', ….')
}

/**
 * Each text the debugging skill quotes from a `src/` builder, rendered by the
 * builder with the skill's placeholders, and the section that quotes it: the
 * `set_channel_delivery` refusals and failed-write texts, the store's lines, the stored-choice
 * `reload-record-write-failed` line, and the switch's and the
 * recorded change's preview lines, and the
 * `persona-invited-channel`, `persona-channel-delivery-set` and open-mode
 * `unclaimed-channel` lines, and the start's state directory lines, `[slack] state-migrate:` and
 * `[slack] Warning: state-migrate:`. Rendered when a case runs,
 * never at collection.
 */
const QUOTED_TEXTS: [label: string, where: HeadingMatch, render: () => string][] = [
[
    `the ${PERSONA_INVITED_CHANNEL} line`,
    classHeading(PERSONA_INVITED_CHANNEL),
    () =>
      personaLineTemplate(PERSONA_INVITED_CHANNEL, invitedChannelCause(CHANNEL, 'public', 'mentions'))
        .replace('hears public channel', 'hears <public|private> channel')
        .replace('at channel delivery mentions', `at channel delivery <${DELIVERY_MODES.join('|')}>`),
  ],
[
    `the ${PERSONA_CHANNEL_DELIVERY_SET} line`,
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () =>
      personaLineTemplate(PERSONA_CHANNEL_DELIVERY_SET, channelDeliverySetCause(CHANNEL, undefined, 'all', 'all'))
        .replace(`from ${NO_STORED_CHOICE} to all,`, `from <${NO_STORED_CHOICE}|${DELIVERY_MODES.join('|')}> to <${DELIVERY_MODES.join('|')}>,`)
        .replace(/at channel delivery all$/, `at channel delivery <${DELIVERY_MODES.join('|')}>`),
  ],
[
    `the open-mode ${UNCLAIMED_CHANNEL} line`,
    classHeading(UNCLAIMED_CHANNEL),
    () =>
      personaLineTemplate(UNCLAIMED_CHANNEL, fungibleUnclaimedChannelCause(CHANNEL, 'externally-shared')).replace(
        FUNGIBLE_REFUSAL_TEXTS['externally-shared'],
        '<reason>',
      ),
  ],
['the session-not-matched refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL)],
['the not-an-applied-persona refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, KEY)],
['the strict-mode refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => channelDeliveryDeclarativeRefusal(NAME, KEY)],
['the unreadable-store refusal', classHeading(PERSONA_CHANNEL_DELIVERY_SET), () => channelDeliveryUnreadableRefusal(NAME, KEY, PATH)],
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
    'the invalid-channel refusal not showing the channel',
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => {
      const tail = afterRef(channelDeliveryChannelRefusal(NAME, KEY, 42))
      return `… ${tail}`
    },
  ],
...deliveryResultSamples()
  .filter(({ result }) => result.kind === 'not-applied' || result.kind === 'pending' || result.kind === 'unresolved')
  .map(({ form, result }): [string, HeadingMatch, () => string] => [
    `the retained attempt ${form} outcome`,
    classHeading(PERSONA_CHANNEL_DELIVERY_SET),
    () => {
      // Quote the handler's outcome clause; current facts are reported separately.
      const rendered = channelDeliveryAttemptResultText(NAME, KEY, CHANNEL, result)
      const lead = `, channel ${CHANNEL}: `
      const at = rendered.indexOf(lead)
      if (at < 0) throw new Error(`the ${form} rendering has no persona/channel lead`)
      return rendered.slice(at + lead.length)
    },
  ]),
["the switch's line turning open mode on", '### Pending changes', () => modeSwitchTemplate('open')],
["the switch's line turning strict mode on", '### Pending changes', () => modeSwitchTemplate('strict')],
[
    "the switch line's ending with no persona affected",
    '### Pending changes',
    () => {
      const line = modeSwitchLine('open', [])
      return `\`${line.slice(line.lastIndexOf('; '))}\``
    },
  ],
[
    'the state directory renamed line',
    STATE_LOCATION_HEADING,
    () => quotedUpTo(stateDirRenamedLine(OLD_STATE, NEW_STATE), 'is now a symbolic link to it,'),
  ],
[
    'the state directory merged line, naming what moved',
    STATE_LOCATION_HEADING,
    () =>
      quotedUpTo(
        stateDirMergedLine(OLD_STATE, NEW_STATE, [STATE_NAME]).replace(`moved "${STATE_NAME}" from`, `moved "${STATE_NAME}", … from`),
        `is now a symbolic link to ${NEW_STATE},`,
      ),
  ],
[
    'the state directory renamed line, for the folder renamed within ~/.config (named after the package)',
    STATE_LOCATION_HEADING,
    () => quotedUpTo(stateDirRenamedLine(OLD_STATE, NEW_STATE, true), 'is now a symbolic link to it,'),
  ],
[
    'the state directory merged line, for the folder renamed within ~/.config, naming what moved',
    STATE_LOCATION_HEADING,
    () =>
      quotedUpTo(
        stateDirMergedLine(OLD_STATE, NEW_STATE, [STATE_NAME], true).replace(`moved "${STATE_NAME}" from`, `moved "${STATE_NAME}", … from`),
        `is now a symbolic link to ${NEW_STATE},`,
      ),
  ],
[
    'the state directory merged line, when nothing needed to move',
    STATE_LOCATION_HEADING,
    () => stretch(stateDirMergedLine(OLD_STATE, NEW_STATE, []), 'nothing needed to move', 'nothing needed to move'),
  ],
[
    'the state directory conflict WARN',
    STATE_LOCATION_HEADING,
    () => quotedUpTo(stateDirPendingLine(OLD_STATE, NEW_STATE, [], [STATE_NAME], []), 'is left untouched.'),
  ],
[
    'the state directory leftover WARN',
    STATE_LOCATION_HEADING,
    () =>
      quotedUpTo(
        stateDirPendingLine(OLD_STATE, NEW_STATE, [], [], [STATE_NAME]).replace(
          ` from ${OLD_STATE} to its new default location ${NEW_STATE}:`,
          ' …:',
        ),
        'during the move.',
      ),
  ],
[
    'the state directory link-elsewhere WARN',
    STATE_LOCATION_HEADING,
    () => quotedUpTo(stateDirLegacyUnusableLine(OLD_STATE, NEW_STATE, 'link-elsewhere', STATE_TARGET), `set SLACK_STATE_DIR=${STATE_TARGET}.`),
  ],
[
    'the state directory not-a-directory WARN',
    STATE_LOCATION_HEADING,
    () => quotedUpTo(stateDirLegacyUnusableLine(OLD_STATE, NEW_STATE, 'not-directory'), `Nothing was moved to ${NEW_STATE},`),
  ],
[
    'the state directory old-server-running stop line',
    STATE_LOCATION_HEADING,
    () =>
      elide(stateDirLegacyServerRunningLine(OLD_STATE, NEW_STATE, 4242).replace('PID 4242', 'PID <pid>'), '(PID <pid>).', 'Stop that server'),
  ],
[
    'the state directory failed line for a directory that could not be created',
    STATE_LOCATION_HEADING,
    () => stretch(stateDirFailedLine(OLD_STATE, NEW_STATE, 'mkdir', STATE_CAUSE, []), '[slack] state-migrate:', `(${STATE_CAUSE})`),
  ],
[
    'the state directory failed line for an entry that could not be moved',
    STATE_LOCATION_HEADING,
    () =>
      stretch(
        stateDirFailedLine(OLD_STATE, NEW_STATE, 'move', STATE_CAUSE, [{ name: STATE_NAME, cause: STATE_CAUSE }]),
        `could not move "${STATE_NAME}"`,
        `(${STATE_CAUSE})`,
      ),
  ],
[
    'the state directory failed line for an entry that could not be looked at',
    STATE_LOCATION_HEADING,
    () => stretch(stateDirFailedLine(OLD_STATE, NEW_STATE, 'unexpected', STATE_CAUSE, []), 'could not look at an entry', `(${STATE_CAUSE})`),
  ],
[
    "the state directory failed line's reassurance",
    STATE_LOCATION_HEADING,
    () =>
      `${stretch(stateDirFailedLine(OLD_STATE, NEW_STATE, 'mkdir', STATE_CAUSE, []), 'Nothing was lost:', `is still in ${OLD_STATE}.`)} …`,
  ],
[
    'the state directory repointed line',
    STATE_LOCATION_HEADING,
    () => stateDirRepointedLine(LEGACY_SERVER_DIR, LEGACY_XDG_DIR, NEW_STATE),
  ],
[
    'the state directory repoint-failed WARN',
    STATE_LOCATION_HEADING,
    () => stateDirRepointFailedLine(LEGACY_SERVER_DIR, LEGACY_XDG_DIR, NEW_STATE, STATE_CAUSE),
  ],
[
    'the state directory link-failed WARN',
    STATE_LOCATION_HEADING,
    () =>
      elide(
        elide(stateDirLinkFailedLine(OLD_STATE, NEW_STATE, STATE_CAUSE), `${STATE_CAUSE}.`, 'To restore it,'),
        'To restore it,',
        'run:',
      ),
  ]
]

/** Whether `section` quotes `text`, compared with whitespace runs collapsed so a wrapped quote still counts. */
function quotes(section: string, text: string): boolean {
  return flat(section).includes(flat(text))
}

// These retained exports need leak coverage independently of the skill's quotations.
test.each<[string, () => string]>([
  ['channelDeliveryWriteFailedText', () => channelDeliveryWriteFailedText(NAME, KEY, PATH)],
  ['channelDeliveryNotStoredText', () => channelDeliveryNotStoredText(NAME, KEY, 'set_at')],
])('retained legacy renderer %s has no leaks', (label, render) => {
  assertNoLeak(render(), label)
})

describe("the debugging skill's quoted texts are their builders' renderings", () => {
  test.each(QUOTED_TEXTS)('%s', (label, where, render) => {
    const rendered = render()
    assertNoLeak(rendered, label)
    expect(rendered).not.toContain('\n')
    expect(quotes(requiredSection(debugSkill(), where, SKILL_REL), rendered)).toBe(true)
  })

  test.each(QUOTED_TEXTS)('self-check: %s with one word changed where its section quotes it is no longer found', (_label, where, render) => {
    const rendered = render()
    expect(rendered.trim()).not.toBe('')
    const word = rendered.match(/[A-Za-z]{3,}/)?.[0]
    if (word === undefined) throw new Error(`the rendering "${rendered}" has no word to change`)
    // Every place the section quotes the rendering, however the skill wraps it.
    const quoted = new RegExp(flat(rendered).split(' ').map(escapeRegExp).join('\\s+'), 'g')
    const edited = editSection(debugSkill(), where, (body) => body.replace(quoted, (quote) => quote.replace(word, 'XYZZY')))
    expect(edited).not.toBe(debugSkill())
    expect(quotes(requiredSection(edited, where, SKILL_REL), rendered)).toBe(false)
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
// 4. the TOML parser is pinned at exactly one version
// ---------------------------------------------------------------------------

/** The package CSCB parses agent-director's settings file with. */
const TOML_PARSER = 'smol-toml'

/**
 * pin of the third-party parser: the one version, with no range,
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

describe(`${TOML_PARSER} is a runtime dependency at exactly its pinned version (hermetic)`, () => {
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
// 5. agent-director is pinned at the Phase 1 floor
// ---------------------------------------------------------------------------

/** The agent-director npm client, CSCB's runtime dependency. */
const AD_PACKAGE = 'agent-director'

/**
 * rules for the pin, in the order they are checked:
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
 * pin check: whether `spec` is one exact version equal to `floor`,
 * with no range operator, pre-release suffix or build metadata; otherwise the
 * first {@link PinRule} it breaks.
 */
function clientPinVerdict(spec: string, floor: string): PinVerdict {
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

describe(`the pin checker gives each spec its verdict against the floor ${PHASE1_FLOOR_VERSION}`, () => {
  test('the floor itself is the pin', () => {
    expect(clientPinVerdict(PHASE1_FLOOR_VERSION, PHASE1_FLOOR_VERSION)).toEqual({ ok: true })
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
    expect(clientPinVerdict(spec, PHASE1_FLOOR_VERSION)).toEqual({ ok: false, broken })
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

describe('the bun.lock pin reader reports what each fixture lock pins', () => {
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

describe(`the real package.json and bun.lock pin ${AD_PACKAGE} at the floor ${PHASE1_FLOOR_VERSION} (hermetic)`, () => {
  test(`package.json names ${AD_PACKAGE} in dependencies and in no other section`, () => {
    const pkg = readPkg()
    expect(pkg.dependencies?.[AD_PACKAGE]).toBeDefined()
    expect(NON_RUNTIME_SECTIONS.filter((section) => Object.keys(pkg[section] ?? {}).includes(AD_PACKAGE))).toEqual([])
  })

  test(`package.json's ${AD_PACKAGE} spec is the pin: one exact version equal to the floor`, () => {
    expect(clientPinVerdict(readPkg().dependencies?.[AD_PACKAGE] ?? '', PHASE1_FLOOR_VERSION)).toEqual({ ok: true })
  })

  test(`bun.lock's root workspace names ${AD_PACKAGE} with package.json's exact spec, in dependencies only`, () => {
    const { workspaceSpec, otherSections } = lockPin(readBunLock(), AD_PACKAGE)
    expect([workspaceSpec, otherSections, clientPinVerdict(workspaceSpec ?? '', PHASE1_FLOOR_VERSION)]).toEqual([
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

/** The changed persistence contract must be explained wherever its failure recovery is shipped. */
function sharedAuthorityProblems(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ['the sole shared authority', /shared (?:channel )?authority/i],
    ['the applied envelope path', /config\.json\.last-applied/],
    ['uncertain writes preserve evidence', /(?:uncertain|unresolved)[\s\S]{0,500}preserv[\s\S]{0,100}evidence/i],
    ['removed delivery file has no authority', /channel-delivery\.json[\s\S]{0,200}(?:not read|ignored|removed)/i],
  ]
  return checks.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label)
}
describe('the debugging skill explains shared-authority recovery', () => {
  test('names the sole envelope, ignored legacy file and evidence-preserving unresolved outcome', () => {
    expect(sharedAuthorityProblems(debugSkill())).toEqual([])
  })
  test('the checker rejects a missing authority explanation', () => {
    expect(sharedAuthorityProblems('')).toEqual([
      'the sole shared authority', 'the applied envelope path', 'uncertain writes preserve evidence', 'removed delivery file has no authority',
    ])
  })
})
