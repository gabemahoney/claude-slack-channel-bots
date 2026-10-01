/**
 * secrecy-audit.test.ts — Repo-level credential-secrecy audit (b.av2 SR-10.3
 * closing audit, SR-13.2; AC 20).
 *
 * A static audit of the repository's test and source files, in the pattern
 * of the getClient() allowlist audit (tests/outage-state.test.ts case 22). It
 * reads files under tests/ and src/ only (never the home, never a config or
 * credentials file) and runs no other suite. Every check is anchored on
 * content (imports, identifiers, call sites, log-line text) in
 * comment-stripped code, never on line numbers.
 *
 * Rules:
 *
 * 1. Named legs (AC 20). The config, connection (`persona-connections`),
 *    reload and reload-apply suites each import `assertNoLeak` from the
 *    credentials helper and call it. On top of that: `config` rejects a
 *    persona entry holding a fake token under `bot_token` and under
 *    `app_token` (its `persona({ bot_token: fakeToken(…) })` and
 *    `persona({ app_token: fakeToken(…) })` rows) and one with a computed,
 *    token-named key (`persona({ [<name>]: … })`); `persona-connections` asserts `attachOriginalToWebAPIRequestError`
 *    false on a socket client's `clientOptions` and on a Web API client's own
 *    options, drives `createUnhandledRejectionHandler` and has its rejected
 *    Web API calls block; reload and reload-apply leak-check a run's
 *    `captured()` artifacts. A named leg can't be exempted.
 * 2. Every touching suite. Each `tests/**\/*.test.ts` that touches config,
 *    credentials or reload calls `assertNoLeak` (imported from the credentials
 *    helper). A suite touches them when it has a value import (not
 *    `import type`, not a `type` specifier, not a SCREAMING_CASE constant)
 *    from one of the `SOURCE_SURFACES` modules (the config, credentials,
 *    bring-up, connection, Slack client and logger, diagnostics, start,
 *    lifecycle, redaction and reload modules, plus the modules that log or
 *    post agent-director and Slack failures: the MCP registry, the session
 *    manager, restart, the permission poller and click handler, the persona
 *    notifier and destinations, the health check, the CLI, the template
 *    install, the agent-director error classifier, the agent-director
 *    settings reader, the UNAVAILABLE retry timer, the persona episodes
 *    with their tmux-unresponsive condition, the outage state, whose
 *    config-file onset quotes agent-director, and the conflict latch, whose
 *    lines and record carry agent-director's CONFLICT description), a value
 *    import of one
 *    of the `HELPER_SURFACES` helpers (the token builders and sentinel, the
 *    config-file writer, the agent-director settings-file writer, the reload,
 *    connection, routing and recovery harnesses, the Slack client factory
 *    stub), or sets a stub's `leakMarker`. A suite that matches but has no
 *    secret-bearing surface is listed in `EXEMPT` with its reason; an
 *    exemption that no longer matches
 *    such a suite (missing file, no longer touching, or now calling
 *    `assertNoLeak`) fails as stale.
 * 3. Reload harness. A suite that builds `makeReloadHarness` passes a run's
 *    `captured()` artifacts to `assertNoLeak` (the testing guide's Reload
 *    Tests rule), so its logs and every reload file it wrote are checked.
 * 4. No token literal. No file under tests/ (sources, helpers, fixtures,
 *    scripts, this file included) holds a token-like value by `TOKEN_LIKE`,
 *    the matcher `assertNoLeak` applies, and `LEAK_SENTINEL`'s value (any
 *    letter case) appears only in tests/test-helpers/credentials.ts. This file
 *    builds its patterns from identifiers and imported constants, so it holds
 *    neither.
 * 5. A caught error's text reaches a log line only redacted (E14 Task 0,
 *    operator decision B1, replacing E13 Director decision 16's "messages
 *    dropped"). Log lines keep an error's message, but only through
 *    `redactSlackLogText` (URL-like and token-like text replaced) or a safe
 *    describer that applies it (`SAFE_DESCRIBERS`: `describeThrownValue` and
 *    `describeLogMessage` render it as `message="…"`, the
 *    `describeAgentDirectorFailure` copies and `describeRefreshFailure` the
 *    same). In every file under src/, a log call (a console method, or `log`,
 *    `logFailure`, `logViaDeps`, `logDeps`, `safeLog`, `recordStartupError`
 *    or `fatal`, bare or on an object) therefore never passes a caught error
 *    as an argument,
 *    interpolates it, reads its message or stack outside a describer call,
 *    hands it to a function that is not a safe describer (`String(err)`),
 *    logs an `errDescription` not through `redactSlackLogText` or an
 *    `errName` not checked by `isSafeIdentifier`. Every describer call (its
 *    arguments included) is blanked before the rules run, so
 *    `redactSlackLogText(err.message)` passes and a bare `err.message` beside
 *    it is still flagged. A caught error is a `catch` or `.catch(…)` binding,
 *    a name like `e`, `err`, `error` or `getErr`, or a name set from a raw use
 *    of one; a local sink function that describes its error parameter is not
 *    a sink. The deliberate exceptions (paths that are not Slack or
 *    agent-director ones, or text CSCB wrote) are listed in
 *    `RAW_ERROR_ALLOWED` by file, anchor and reason; an entry that matches no
 *    flagged call fails as stale.
 *
 * Failure lists name the offending file and rule, never a matched value, and
 * are themselves passed through `assertNoLeak` before they are compared.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { LEAK_SENTINEL, TOKEN_LIKE, assertNoLeak } from './test-helpers/credentials.ts'
import { balancedAfter, callArguments, callsOf, splitTopLevel, stripComments } from './test-helpers/source-audit.ts'

/** The repository root (the parent of tests/). */
const ROOT = resolve(import.meta.dir, '..')

/** The credentials helper, repo-relative: the one home of the sentinel's value and of `assertNoLeak`. */
const CREDENTIALS_HELPER = 'tests/test-helpers/credentials.ts'

/**
 * Source modules whose value exports expose config, credentials or reload
 * surfaces, with what they are. A value import of anything but a
 * SCREAMING_CASE constant from one of them makes a suite touching.
 */
const SOURCE_SURFACES: [RegExp, string][] = [
  [/^src\/config\.ts$/, 'the persona config loader and record validation'],
  [/^src\/persona-credentials\.ts$/, 'the credentials reader and classifier'],
  [/^src\/persona-bringup\.ts$/, 'the local bring-up checks, which read the credentials file'],
  [/^src\/persona-bringup-controller\.ts$/, 'the bring-up controller, which reads credentials and holds their digests'],
  [/^src\/persona-slack-[\w-]+\.ts$/, 'the Slack credentials classifier or the Slack client options and loggers'],
  [/^src\/persona-connections\.ts$/, 'the connection manager'],
  [/^src\/persona-connection-errors\.ts$/, 'the Slack error and unhandled-rejection descriptions'],
  [/^src\/persona-web-api-watch\.ts$/, 'the Web API auth-error watch'],
  [/^src\/persona-diagnostics\.ts$/, 'the credentials diagnostic lines'],
  [/^src\/persona-start\.ts$/, "the start bring-up, which checks a persona's credentials and hands its tokens to the connection manager"],
  [/^src\/persona-lifecycle\.ts$/, 'the persona lifecycle, which tears down, brings up and reconnects personas on a confirmed change'],
  [/^src\/slack-log-redaction\.ts$/, 'the Slack log redactor, whose input can hold tokens and URLs'],
  [/^src\/reload[\w-]*\.ts$/, 'the reload controller, preview or apply'],
  // The modules the E13 raw-error sweep touched whose output carries an agent-director or Slack failure's text (now
  // kept, redacted) to a log, a startup error, a Slack post or an MCP tool result (E13 carry, E14 Task 0).
  [/^src\/registry\.ts$/, "the MCP registry, whose tool results carry a Slack call's failure text back to the session"],
  [/^src\/session-manager\.ts$/, "the session manager, whose launch lines, startup errors and spawn-failure notices carry agent-director failure text"],
  [/^src\/restart\.ts$/, "the restart path, whose lines and notices carry agent-director failure text"],
  [/^src\/permission-poller\.ts$/, "the permission poller, which posts through a persona's client and logs agent-director and Slack failure text"],
  [/^src\/permission-click-handler\.ts$/, "the click handler, which updates through a persona's client and logs and trails agent-director failure text"],
  [/^src\/persona-notifier\.ts$/, "the persona notifier, which posts notices through a persona's client and logs Slack failure text"],
  [/^src\/persona-destination[\w-]*\.ts$/, "the destination resolver and hold, which open DMs through a persona's client and describe Slack failures"],
  [/^src\/health-check\.ts$/, 'the health check, whose lines carry agent-director failure text'],
  [/^src\/cli\.ts$/, 'the CLI, which loads the config and logs agent-director failure text'],
  [/^src\/agent-director-template\.ts$/, "the template install and refresh, whose lines and startup error carry agent-director failure text"],
  [/^src\/ad-error-class\.ts$/, "the agent-director error classifier, whose reported message carries agent-director failure text (an error's description) to log lines"],
  [/^src\/ad-settings\.ts$/, "the agent-director settings reader, which reads agent-director's config.toml and logs a refused read's reason"],
  [/^src\/unavailable-retry\.ts$/, "the UNAVAILABLE retry timer, whose lines can carry agent-director failure text (a cause or a failed retry, described)"],
  [/^src\/persona-episodes\.ts$/, "the persona episodes and the tmux-unresponsive condition, whose start line carries agent-director failure text (the refusing verb's error, described)"],
  [/^src\/outage-state\.ts$/, "the outage flags and their notices, whose ad-config-malformed onset carries agent-director's description (its error's message) to Slack"],
  [/^src\/conflict-latch\.ts$/, "the conflict latch, whose latch and relatch lines and stored record carry text from agent-director's CONFLICT description (the quoted session and the description, redacted)"],
]

/** Test helpers whose named exports build tokens, credentials or config files, or plant the sentinel. */
const HELPER_SURFACES: Record<string, Record<string, string>> = {
  [CREDENTIALS_HELPER]: {
    fakeToken: 'builds fake tokens',
    makeCredentials: 'builds credentials objects',
    writeCredentialsFile: 'writes a credentials file',
    LEAK_SENTINEL: 'plants the leak sentinel',
    sentinelInMessage: 'plants the leak sentinel in an error message (in a fake token and a ticket URL)',
    sentinelTicketUrl: 'plants the leak sentinel in a ticket URL',
  },
  'tests/test-helpers/persona-config.ts': { writeConfigFile: 'writes a config file' },
  'tests/test-helpers/ad-settings.ts': { writeAgentDirectorConfig: "writes agent-director's config.toml" },
  'tests/test-helpers/reload-harness.ts': { makeReloadHarness: 'builds the reload harness' },
  'tests/test-helpers/persona-connection-harness.ts': { makeConnectionHarness: 'builds the connection manager over credentials files' },
  'tests/test-helpers/persona-routing-harness.ts': { makeRoutingHarness: 'builds sentinel-bearing Slack stubs' },
  'tests/test-helpers/recovery-harness.ts': { makeRecoveryHarness: "builds the recovery harness, which writes agent-director's config.toml and captures the retry timer's, settings reader's and tmux-unresponsive condition's lines" },
  'tests/test-helpers/slack-stub.ts': { makeStubSlackFactory: 'builds Slack clients from tokens' },
}

/**
 * Suites that match the touching rule but have no secret-bearing surface:
 * nothing they log, throw, return or write can hold a token. Each entry must
 * still match such a suite, or it fails as stale.
 */
const EXEMPT: Record<string, string> = {
  'tests/config-cron.test.ts':
    'loads cron settings through the loader from makePersonaConfigInput inputs, which hold no token or credentials content, so no error or result can carry one',
  'tests/postinstall.test.ts':
    'loads the postinstall skeleton config ({"personas": []}) and checks it is not overwritten; no input holds a token or credentials content',
  'tests/reload-plan-coverage.test.ts':
    "holds the loader's key tables against the change plan's classes; inputs are makePersona entries (credentials_file is only a path) and it captures no log, error or file",
  'tests/reload-wiring.test.ts':
    "a source-text audit of src/server.ts plus the pure configInEffect and replySettingsOf over makePersonaConfig fixtures; it reads no credentials and runs no reload controller",
  'tests/persona-identity.test.ts':
    "fake tokens are inputs to the test helper's TOKEN_LIKE / isTokenLike matcher table, whose results are booleans; nothing is logged, thrown or written",
  'tests/block-action-received.test.ts':
    "the click handler's emitBlockActionReceived over encoded action IDs and fixed channel and user IDs, captured as trail events; no input holds a token or credentials content",
}

/** The AC 20 named legs: suites that must call `assertNoLeak`, with their extra content rules. */
const NAMED_LEGS = [
  'tests/config.test.ts',
  'tests/persona-connections.test.ts',
  'tests/reload.test.ts',
  'tests/reload-apply.test.ts',
]

/** A repo-relative path with forward slashes. */
function repoPath(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/')
}

/** Every file under `dir`, recursively, as absolute paths in sorted order. */
function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

const TEST_FILES = walk(join(ROOT, 'tests'))
const SUITES = TEST_FILES.filter((path) => path.endsWith('.test.ts')).map(repoPath)

const codeCache = new Map<string, string>()

/** A repo-relative file's comment-stripped code. */
function codeOf(file: string): string {
  let code = codeCache.get(file)
  if (code === undefined) {
    code = stripComments(readFileSync(join(ROOT, file), 'utf-8'))
    codeCache.set(file, code)
  }
  return code
}

/** One value binding of an import: the exported name (`default`, `*` for a namespace or dynamic import) and the local name. */
interface ImportBinding {
  module: string
  imported: string
  local: string
}

/** `spec` resolved against `file` (repo-relative) when it is relative; a bare specifier as written. */
function resolveSpecifier(file: string, spec: string): string {
  return spec.startsWith('.') ? repoPath(resolve(ROOT, dirname(file), spec)) : spec
}

/**
 * Every value binding `code` imports: static imports (default, namespace and
 * named, `import type` and `type` specifiers left out) and dynamic imports of
 * a string literal (bound as `*`).
 */
function valueImports(file: string, code: string): ImportBinding[] {
  const bindings: ImportBinding[] = []
  for (const m of code.matchAll(/\bimport\s+(type\s+)?([\w$\s{},*]*?)\s*from\s*(['"])([^'"]+)\3/g)) {
    if (m[1]) continue
    const module = resolveSpecifier(file, m[4]!)
    const clause = m[2]!
    const named = clause.match(/\{([^}]*)\}/)
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
    const ns = head.match(/\*\s+as\s+([\w$]+)/)
    if (ns) bindings.push({ module, imported: '*', local: ns[1]! })
    else if (head !== '') bindings.push({ module, imported: 'default', local: head })
    for (const spec of (named?.[1] ?? '').split(',').map((s) => s.trim())) {
      if (spec === '' || /^type\s/.test(spec)) continue
      const parts = spec.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (parts) bindings.push({ module, imported: parts[1]!, local: parts[2] ?? parts[1]! })
    }
  }
  for (const m of code.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    bindings.push({ module: resolveSpecifier(file, m[2]!), imported: '*', local: '*' })
  }
  return bindings
}

const SCREAMING_CASE = /^[A-Z][A-Z0-9_]*$/

/** Why `file` touches config, credentials or reload (empty when it does not). */
function touchReasons(file: string): string[] {
  return touchReasonsOf(file, codeOf(file))
}

/** Why a suite at `file` whose comment-stripped code is `code` touches config, credentials or reload. */
function touchReasonsOf(file: string, code: string): string[] {
  const reasons: string[] = []
  for (const { module, imported } of valueImports(file, code)) {
    const surface = SOURCE_SURFACES.find(([re]) => re.test(module))
    if (surface && !SCREAMING_CASE.test(imported)) reasons.push(`imports ${imported} from ${module}: ${surface[1]}`)
    const helper = HELPER_SURFACES[module]?.[imported]
    if (helper !== undefined) reasons.push(`imports ${imported} from ${module}: ${helper}`)
  }
  if (/\bleakMarker\s*:/.test(code)) reasons.push("sets a Slack stub's leakMarker: plants the leak sentinel")
  return reasons
}

/** The local name `file` binds `assertNoLeak` to from the credentials helper, if it imports it. */
function assertNoLeakBinding(file: string): string | undefined {
  return valueImports(file, codeOf(file)).find((b) => b.module === CREDENTIALS_HELPER && b.imported === 'assertNoLeak')?.local
}

/** Whether `file` imports `assertNoLeak` from the credentials helper and calls it. */
function callsAssertNoLeak(file: string): boolean {
  const local = assertNoLeakBinding(file)
  return local !== undefined && callsOf(codeOf(file), local).length > 0
}

/** The argument text of every `assertNoLeak` call in `file` (none when it doesn't import it). */
function assertNoLeakArguments(file: string): string[] {
  const local = assertNoLeakBinding(file)
  if (local === undefined) return []
  const code = codeOf(file)
  return callsOf(code, local).map((at) => callArguments(code, at))
}

/** Whether some `assertNoLeak` call in `file` checks a reload run's `captured()` artifacts. */
function leakChecksCaptured(file: string): boolean {
  return assertNoLeakArguments(file).some((args) => /\.captured\s*\(/.test(args))
}

/** Pass a failure list through `assertNoLeak` (it names files and rules only), then return it for comparison. */
function checked(failures: string[], label: string): string[] {
  assertNoLeak(failures, label)
  return failures
}

const TOUCHING = SUITES.filter((file) => touchReasons(file).length > 0)

/** Matches of `expect(<path>.attachOriginalToWebAPIRequestError).toBe(false)`, capturing `<path>`. */
const ATTACH_ORIGINAL_FALSE = /\bexpect\(\s*([\w$.?]+)\.attachOriginalToWebAPIRequestError\s*\)\s*\.toBe\(\s*false\s*\)/g

/**
 * Whether `code` builds a persona entry through the unknown-keys table's
 * `persona({ … })` whose first key is `key` holding a `fakeToken(…)` value.
 */
function personaEntryWith(code: string, key: string): boolean {
  return new RegExp(`\\bpersona\\(\\s*\\{\\s*${key}\\s*:\\s*fakeToken\\s*\\(`).test(code)
}

/** Named-leg content rules beyond importing and calling `assertNoLeak`: [rule, holds]. */
const LEG_RULES: Record<string, [string, (code: string, file: string) => boolean][]> = {
  'tests/config.test.ts': [
    ['a persona entry holding a fake bot token under bot_token is rejected (a persona({ bot_token: fakeToken(…) }) row)', (code) => personaEntryWith(code, 'bot_token')],
    ['a persona entry holding a fake app token under app_token is rejected (a persona({ app_token: fakeToken(…) }) row)', (code) => personaEntryWith(code, 'app_token')],
    ['a persona entry with a computed, token-named key is rejected (a persona({ [<name>]: … }) row)', (code) => /\bpersona\(\s*\{\s*\[/.test(code)],
  ],
  'tests/persona-connections.test.ts': [
    [
      "a socket client's clientOptions are asserted attachOriginalToWebAPIRequestError false",
      (code) => [...code.matchAll(ATTACH_ORIGINAL_FALSE)].some((m) => /\bclientOptions\??$/.test(m[1]!)),
    ],
    [
      "a Web API client's own options (validation and long-lived) are asserted attachOriginalToWebAPIRequestError false",
      (code) => [...code.matchAll(ATTACH_ORIGINAL_FALSE)].some((m) => !/\bclientOptions\??$/.test(m[1]!)),
    ],
    [
      'the unhandled-rejection handler from src/persona-connection-errors.ts is driven',
      (code, file) =>
        valueImports(file, code).some((b) => b.module === 'src/persona-connection-errors.ts' && b.imported === 'createUnhandledRejectionHandler') &&
        callsOf(code, 'createUnhandledRejectionHandler').length > 0,
    ],
    ['rejected Web API calls have their own block', (code) => /\bdescribe\(\s*(['"`])rejected Web API calls\b/.test(code)],
  ],
  'tests/reload.test.ts': [["a run's captured() artifacts are leak-checked", (_code, file) => leakChecksCaptured(file)]],
  'tests/reload-apply.test.ts': [["a run's captured() artifacts are leak-checked", (_code, file) => leakChecksCaptured(file)]],
}

describe('AC 20 named legs (b.av2 SR-10.3 closing audit)', () => {
  test.each(NAMED_LEGS)('%s imports assertNoLeak from the credentials helper, calls it, and holds its leg', (file) => {
    const failures = SUITES.includes(file)
      ? [
          ...(callsAssertNoLeak(file) ? [] : [`${file}: does not import and call assertNoLeak`]),
          ...(LEG_RULES[file] ?? []).filter(([, holds]) => !holds(codeOf(file), file)).map(([rule]) => `${file}: missing: ${rule}`),
        ]
      : [`${file}: missing`]
    expect(checked(failures, 'named-leg failures')).toEqual([])
  })

  test('no named leg is exempted', () => {
    expect(NAMED_LEGS.filter((file) => file in EXEMPT)).toEqual([])
  })
})

describe('every suite that touches config, credentials or reload calls assertNoLeak', () => {
  test('the touching rule finds every named leg (it is not vacuous)', () => {
    expect(NAMED_LEGS.filter((file) => !TOUCHING.includes(file))).toEqual([])
  })

  test('each touching suite, bar the exemptions, imports assertNoLeak from the credentials helper and calls it', () => {
    const failures = TOUCHING.filter((file) => !(file in EXEMPT) && !callsAssertNoLeak(file)).map(
      (file) => `${file}: never calls assertNoLeak, yet ${touchReasons(file)[0]}`,
    )
    expect(checked(failures, 'touching-suite failures')).toEqual([])
  })

  test('every exemption has a reason and still names a touching suite that does not call assertNoLeak (none stale)', () => {
    const failures = Object.entries(EXEMPT).flatMap(([file, reason]) => {
      if (reason.trim() === '') return [`${file}: exemption has no reason`]
      if (!SUITES.includes(file)) return [`${file}: stale exemption: no such suite`]
      if (!TOUCHING.includes(file)) return [`${file}: stale exemption: no longer touches config, credentials or reload`]
      if (callsAssertNoLeak(file)) return [`${file}: stale exemption: it now calls assertNoLeak`]
      return []
    })
    expect(checked(failures, 'exemption failures')).toEqual([])
  })

  test('every source surface has a reason and still names a module under src/ (none stale)', () => {
    const failures = SOURCE_SURFACES.flatMap(([re, reason]) => [
      ...(reason.trim() === '' ? [`${re.source}: surface has no reason`] : []),
      ...(SOURCE_FILES.some((file) => re.test(file)) ? [] : [`${re.source}: stale surface: matches no module under src/`]),
    ])
    expect(checked(failures, 'source-surface failures')).toEqual([])
  })

  // b.jg5 SRJ-501, SRJ-507: the conflict latch's lines and record carry text from agent-director's CONFLICT description.
  const LATCH_SUITE = 'tests/some-latch-user.test.ts'
  test.each<[string, string, boolean]>([
    ['a named value import of its factory', "import { createConflictLatch } from '../src/conflict-latch.ts'", true],
    ['a renamed value import of a function', "import { recogniseConflictCase as recognise } from '../src/conflict-latch.ts'", true],
    ['a namespace import', "import * as latch from '../src/conflict-latch.ts'", true],
    ['a dynamic import', "const latch = await import('../src/conflict-latch.ts')", true],
    ['only SCREAMING_CASE constants', "import { LATCH_CASE_LEFTOVER, REFUSED_OPERATION_RESUME } from '../src/conflict-latch.ts'", false],
    ['an import type', "import type { ConflictLatchRecord } from '../src/conflict-latch.ts'", false],
    ['a type specifier only', "import { type ConflictLatch } from '../src/conflict-latch.ts'", false],
  ])('src/conflict-latch.ts is a source surface: a suite with %s touches it (%p)', (_label, code, touches) => {
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/conflict-latch.ts'))).toBe(true)
    const reasons = touchReasonsOf(LATCH_SUITE, code)
    expect(reasons.length > 0).toBe(touches)
    if (touches) expect(reasons.every((r) => r.includes('src/conflict-latch.ts') && r.includes('the conflict latch'))).toBe(true)
  })

  test('src/conflict-latch.ts exists, so its surface is not stale, and no suite is exempted for it', () => {
    expect(SOURCE_FILES).toContain('src/conflict-latch.ts')
    const exemptForLatch = Object.keys(EXEMPT).filter(
      (file) => SUITES.includes(file) && touchReasons(file).some((r) => r.includes('src/conflict-latch.ts')),
    )
    expect(exemptForLatch).toEqual([])
  })

  test("each suite that builds the reload harness leak-checks a run's captured() artifacts", () => {
    const harnessSuites = SUITES.filter((file) =>
      valueImports(file, codeOf(file)).some((b) => b.module === 'tests/test-helpers/reload-harness.ts' && b.imported === 'makeReloadHarness'),
    )
    expect(harnessSuites).toEqual(expect.arrayContaining(['tests/reload.test.ts', 'tests/reload-apply.test.ts']))
    const failures = harnessSuites
      .filter((file) => !leakChecksCaptured(file))
      .map((file) => `${file}: builds makeReloadHarness but never passes a run's captured() to assertNoLeak`)
    expect(checked(failures, 'reload-harness failures')).toEqual([])
  })
})

describe('no token literal under tests/ (b.av2 SR-13.2, TEST-1)', () => {
  const tokenLike = new RegExp(TOKEN_LIKE.source)
  const sentinel = LEAK_SENTINEL.toLowerCase()

  test('the scan covers every file under tests/, this file and the credentials helper included', () => {
    const scanned = TEST_FILES.map(repoPath)
    expect(scanned).toEqual(expect.arrayContaining(['tests/secrecy-audit.test.ts', CREDENTIALS_HELPER, ...NAMED_LEGS]))
  })

  test('no file holds a token-like value by the matcher assertNoLeak applies', () => {
    const failures = TEST_FILES.filter((path) => tokenLike.test(readFileSync(path, 'utf-8'))).map(
      (path) => `${repoPath(path)}: holds a token-like literal; build it with fakeToken`,
    )
    expect(checked(failures, 'token-literal failures')).toEqual([])
  })

  test("LEAK_SENTINEL's value appears literally only in the credentials helper", () => {
    const failures = TEST_FILES.filter(
      (path) => repoPath(path) !== CREDENTIALS_HELPER && readFileSync(path, 'utf-8').toLowerCase().includes(sentinel),
    ).map((path) => `${repoPath(path)}: holds LEAK_SENTINEL's value; import the constant instead`)
    expect(checked(failures, 'sentinel-literal failures')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rule 5: a caught error's text reaches a log line under src/ only redacted (E14 Task 0, decision B1)
// ---------------------------------------------------------------------------

/** Every `.ts` file under src/, repo-relative, in sorted order. */
const SOURCE_FILES = walk(join(ROOT, 'src')).map(repoPath).filter((file) => file.endsWith('.ts'))

/** Console methods whose arguments reach a log line verbatim. */
const CONSOLE_METHODS = ['error', 'warn', 'log', 'info', 'debug']

/**
 * Functions whose arguments reach a log line or startup-errors.log verbatim
 * (`recordStartupError` writes an `Error` cause as its name and message),
 * called bare or on an object (`deps.log`, `d.recordStartupError`; the click
 * handler's `logDeps(deps, …)`; the persona episodes' `safeLog(deps.log, …)`).
 * A local declaration that passes its last parameter only through a describer
 * is a describing wrapper instead, and its calls are not sinks
 * (`describingWrappers`).
 */
const SINK_FUNCTIONS = ['log', 'logFailure', 'logViaDeps', 'logDeps', 'safeLog', 'recordStartupError', 'fatal']

/** A log call: a console method or a sink function, bare or on an object. Built at runtime. */
const SINK_CALL = new RegExp(
  `(?<![\\w$])(?:console\\s*\\.\\s*(?:${CONSOLE_METHODS.join('|')})|(?:[\\w$]+\\.)?(?:${SINK_FUNCTIONS.join('|')}))\\s*\\(`,
  'g',
)

/**
 * Functions that turn a thrown value (or text taken from one) into
 * token-safe text: an error's message only through `redactSlackLogText`
 * (`describeLogMessage` renders it as `message="…"`). Their own suites pin
 * what they keep. Each must still be declared under src/.
 */
const SAFE_DESCRIBERS = [
  'describeThrownValue',
  'describeLogMessage',
  'describeSlackCallFailure',
  'describeAgentDirectorFailure',
  'describeCliFailure',
  'describeRefreshFailure',
  'redactSlackLogText',
  'isSafeIdentifier',
  'slackPlatformReason',
  'errnoSuffix',
]

const SAFE_CALL = new RegExp(`(?<![\\w$.])(?:${SAFE_DESCRIBERS.join('|')})\\s*\\(`)

/** Names that hold a caught error in any file: `e`, `err` or `error` (with a digit), and `<word>Err` (`getErr`, `killErr`). */
const ERROR_NAME_SOURCE = '(?:e|err|error)\\d*|[a-z][\\w$]*Err\\d*'
const ERROR_NAME = new RegExp(`^(?:${ERROR_NAME_SOURCE})$`)

/** `text` with every safe describer call (its arguments included) replaced by a placeholder. */
function withoutSafeCalls(text: string): string {
  let out = text
  for (let m = SAFE_CALL.exec(out); m; m = SAFE_CALL.exec(out)) {
    const [, end] = balancedAfter(out, m.index, '(', ')')
    out = `${out.slice(0, m.index)}described${out.slice(end + 1)}`
  }
  return out
}

/** A regex alternation matching any error reference: the fixed error names plus `extra`. */
function errorRef(extra: Iterable<string>): string {
  return `(?:${[ERROR_NAME_SOURCE, ...[...extra].map((name) => name.replace(/\$/g, '\\$'))].join('|')})`
}

/**
 * The raw-error rules over a log call's argument text: [rule, holds]. `text`
 * has its safe describer calls blanked, `original` is the argument text as
 * written, `err` the error reference alternation.
 */
const RAW_ERROR_RULES: [string, (text: string, err: string, original: string) => boolean][] = [
  ['passes a caught error as a log argument', (text, err) => splitTopLevel(text).some((arg) => new RegExp(`^${err}$`).test(arg))],
  ['interpolates a caught error', (text, err) => new RegExp(`\\$\\{\\s*${err}\\s*\\}`).test(text)],
  ["reads a caught error's message or stack", (text, err) => new RegExp(`(?<![\\w$.])${err}\\s*\\??\\.\\s*(?:message|stack|toString)\\b`).test(text)],
  [
    'passes a caught error to a function that is not a describer (e.g. String(err))',
    (text, err) => new RegExp(`[\\w$.]+\\s*\\([^()]*?(?<![\\w$.])${err}\\s*[,)]`).test(text),
  ],
  ['logs an errDescription not through redactSlackLogText', (text) => /\.\s*errDescription\b/.test(text)],
  [
    'logs an errName not checked by isSafeIdentifier',
    (text, _err, original) =>
      [...text.matchAll(/([\w$.]+?)\s*\??\.\s*errName\b/g)].some(
        (m) => !new RegExp(`\\bisSafeIdentifier\\(\\s*${m[1]!.replace(/[.$]/g, '\\$&')}\\s*\\??\\.\\s*errName\\s*\\)`).test(original),
      ),
  ],
]

/** The first raw-error rule `args` breaks, if any. */
function rawErrorRule(args: string, err: string): string | undefined {
  const text = withoutSafeCalls(args)
  return RAW_ERROR_RULES.find(([, holds]) => holds(text, err, args))?.[0]
}

/**
 * The names that hold a caught error in `code`, beyond `ERROR_NAME`: `catch`
 * bindings, inline `.catch(…)` handler parameters, and (to a fixed point) a
 * `const` or `let` set from a raw use of one (`const cause = err instanceof
 * Error ? err.message : String(err)`).
 */
function errorNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(/(?<!\.)\bcatch\s*\(\s*([\w$]+)/g)) names.add(m[1]!)
  for (const m of code.matchAll(/\.catch\(\s*(?:async\s*)?(?:\(\s*([\w$]+)[^)]*\)|([\w$]+))\s*=>/g)) names.add((m[1] ?? m[2])!)
  for (let grew = true; grew; ) {
    grew = false
    for (const m of code.matchAll(/\b(?:const|let)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*([^\n;]+)/g)) {
      const name = m[1]!
      if (names.has(name) || ERROR_NAME.test(name)) continue
      // A plain alias (`const failure = err`) or any raw use taints the name.
      const rhs = m[2]!
      if (new RegExp(`^${errorRef(names)}$`).test(rhs.trim()) || rawErrorRule(rhs, errorRef(names)) !== undefined) {
        names.add(name)
        grew = true
      }
    }
  }
  return names
}

/**
 * The sink functions `code` declares as describing wrappers: a `function`
 * or arrow declaration whose block body no longer mentions its last
 * parameter once the safe describer calls are blanked (persona-connections'
 * `logFailure`, which logs `describeThrownValue(err)`).
 */
function describingWrappers(code: string): Set<string> {
  const wrappers = new Set<string>()
  for (const name of SINK_FUNCTIONS) {
    const decl = new RegExp(`\\bfunction\\s+${name}\\s*\\(|\\b(?:const|let)\\s+${name}\\b[^=\\n]*=\\s*(?:async\\s*)?\\(`, 'g')
    for (const m of code.matchAll(decl)) {
      const [paramsStart, paramsEnd] = balancedAfter(code, m.index! + m[0].length - 1, '(', ')')
      const param = splitTopLevel(code.slice(paramsStart, paramsEnd)).at(-1)?.match(/^(?:\.\.\.)?([\w$]+)/)?.[1]
      if (param === undefined || !/^\s*(?::[^={]+)?(?:=>\s*)?\{/.test(code.slice(paramsEnd + 1))) continue
      // A spread (`...args`) is a use of the parameter too.
      const body = code.slice(...balancedAfter(code, paramsEnd, '{', '}')).replace(/\.\.\./g, ' ')
      if (!new RegExp(`(?<![\\w$.])${param.replace(/\$/g, '\\$')}(?![\\w$])`).test(withoutSafeCalls(body))) wrappers.add(name)
    }
  }
  return wrappers
}

/** One log call that breaks a raw-error rule: the rule and the call's text, whitespace collapsed. */
interface RawErrorFinding {
  rule: string
  call: string
}

/** Every log call in comment-stripped `code` (declarations and describing-wrapper calls left out), as its collapsed text. */
function logCalls(code: string): { call: string; args: string }[] {
  const wrappers = describingWrappers(code)
  const calls: { call: string; args: string }[] = []
  for (const m of code.matchAll(SINK_CALL)) {
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index! - 20), m.index!))) continue
    const callee = m[0].replace(/\s*\($/, '').replace(/\s+/g, '')
    if (wrappers.has(callee)) continue
    const args = callArguments(code, m.index!)
    calls.push({ call: `${callee}(${args})`.replace(/\s+/g, ' '), args })
  }
  return calls
}

/** Every log call in comment-stripped `code` that breaks a raw-error rule. */
function rawErrorFindings(code: string): RawErrorFinding[] {
  const err = errorRef(errorNames(code))
  return logCalls(code).flatMap(({ call, args }) => {
    const rule = rawErrorRule(args, err)
    return rule === undefined ? [] : [{ rule, call }]
  })
}

/**
 * The deliberate exceptions: log calls that pass an error's own text on a
 * path that is not a Slack or agent-director one, or whose text CSCB wrote.
 * Each is a file, an anchor (a stable fragment of the call's text, never a
 * line number) and the reason; an entry that matches no flagged call fails
 * as stale.
 */
const RAW_ERROR_ALLOWED: { file: string; anchor: string; reason: string }[] = [
  {
    file: 'src/agent-director-template.ts',
    anchor: "'ad-template-install'",
    reason:
      "the boot template install's fatal startup error keeps agent-director's name and description verbatim (describeTemplateFailure) as the operator's diagnosis; it runs once at boot, before any persona's credentials are read",
  },
  {
    file: 'src/cli.ts',
    anchor: 'stop --stop-bots: could not load config',
    reason: "the config loader's error, which never echoes a credential value (the config leg); the CLI reads no credentials file",
  },
  {
    file: 'src/cli.ts',
    anchor: 'stop: could not load the applied configuration',
    reason: "the last-applied record reader's error (the same loader, the same guarantee); the CLI reads no credentials file",
  },
  {
    file: 'src/cli.ts',
    anchor: 'Could not read PID file',
    reason: 'a file-system error reading server.pid; no Slack or agent-director call',
  },
  {
    file: 'src/cli.ts',
    anchor: 'clean_restart: failed to load config:',
    reason: "the config loader's error, which never echoes a credential value (the config leg)",
  },
  {
    file: 'src/cli.ts',
    anchor: 'credentials: cannot read the personas in',
    reason:
      "the config loader's error (loadPersonaConfig on config.json), which never echoes a credential value (the config leg); the CLI process reads no credentials file and no token",
  },
  {
    file: 'src/cli.ts',
    anchor: 'clean_restart: agent-director initialization failed:',
    reason:
      "the startup gate's failure (StartupGateFailedError: CSCB's message naming versions, paths and the fix) in a short-lived CLI process that reads no credentials",
  },
  {
    file: 'src/cli.ts',
    anchor: 'clean_restart: bot teardown failed',
    reason: "teardownBots' TeardownIncompleteError, whose message CSCB wrote (a persona count and retry advice); each persona's error was already logged described",
  },
  {
    file: 'src/cli.ts',
    anchor: "'[slack] Fatal:'",
    reason: "the CLI entry point's last-resort catch-all for an unexpected throw from start, stop or clean_restart",
  },
  {
    file: 'src/cozempic.ts',
    anchor: 'cozempic: spawn error',
    reason: 'the cozempic subprocess failing to spawn; no Slack or agent-director call',
  },
  {
    file: 'src/cron-log.ts',
    anchor: 'cron-log: append failed',
    reason: 'a file-system error appending to the cron log',
  },
  {
    file: 'src/cron-scheduler.ts',
    anchor: 'cron-scheduler:',
    reason: "the crontable's read, compile and tick isolation; the dispatcher it fires never throws (a Slack failure is its own, described)",
  },
  {
    file: 'src/permission-trail.ts',
    anchor: 'permission-trail: write failed',
    reason: 'a file-system error writing the permission trail',
  },
  {
    file: 'src/server.ts',
    anchor: 'Error in roots handler',
    reason: "an MCP SDK error from a Claude session's roots handler; no Slack or agent-director call",
  },
  {
    file: 'src/server.ts',
    anchor: 'Error connecting MCP server',
    reason: "an MCP SDK error connecting a Claude session's transport; no Slack or agent-director call",
  },
  {
    file: 'src/server.ts',
    anchor: 'roots/list failed',
    reason: "an MCP SDK error from a Claude session's roots/list request; no Slack or agent-director call",
  },
  {
    file: 'src/server.ts',
    anchor: 'failed to initialize message archive',
    reason: 'a SQLite error opening the message archive',
  },
  {
    file: 'src/server.ts',
    anchor: 'cron scheduler failed to start',
    reason: "the cron scheduler's start (crontable path and parse), not a Slack or agent-director call",
  },
  {
    file: 'src/server.ts',
    anchor: "'[slack] Fatal:'",
    reason: "the server entry point's last-resort catch-all for an unexpected throw from main()",
  },
  {
    file: 'src/stop-hook-bootstrap.ts',
    anchor: "'stop-hook-bootstrap-init'",
    reason: "a file-system error resolving the reply-guard hook script; no Slack or agent-director call",
  },
  {
    file: 'src/stop-hook-bootstrap.ts',
    anchor: 'unexpected top-level error in stopHookBootstrap',
    reason: "the settings.json hook patch's catch-all (file system and JSON only)",
  },
  {
    file: 'src/trust-bootstrap.ts',
    anchor: 'unexpected error for',
    reason: "the .claude.json trust patch's catch-all (file system and JSON only), recorded at start and logged per launch",
  },
]

describe("a caught error's text reaches a log line under src/ only redacted (E14 Task 0, decision B1)", () => {
  const findings = SOURCE_FILES.flatMap((file) => rawErrorFindings(codeOf(file)).map((finding) => ({ file, ...finding })))
  const allows = (entry: (typeof RAW_ERROR_ALLOWED)[number], f: (typeof findings)[number]): boolean =>
    entry.file === f.file && f.call.includes(entry.anchor)

  test('the scan reads every file under src/ and finds the log calls of the Slack and agent-director modules (it is not vacuous)', () => {
    expect(SOURCE_FILES).toEqual(expect.arrayContaining(['src/session-manager.ts', 'src/restart.ts', 'src/persona-connections.ts', 'src/cli.ts', 'src/server.ts']))
    const counts = ['src/session-manager.ts', 'src/restart.ts', 'src/permission-poller.ts', 'src/persona-lifecycle.ts', 'src/persona-episodes.ts'].map(
      (file) => logCalls(codeOf(file)).length,
    )
    expect(counts.every((n) => n > 0)).toBe(true)
  })

  test.each<[string, string, string[]]>([
    ['a caught error as an argument', "try { f() } catch (err) { console.error('x:', err) }", ['passes a caught error as a log argument']],
    ['a caught error interpolated', 'try { f() } catch (err) { log(`x: ${err}`) }', ['interpolates a caught error']],
    ["a caught error's message", 'try { f() } catch (failure) { deps.log(`x: ${failure.message}`) }', ["reads a caught error's message or stack"]],
    ['String(err)', 'try { f() } catch (err) { log(`x: ${String(err)}`) }', ['passes a caught error to a function that is not a describer (e.g. String(err))']],
    ['a name set from the message', 'try { f() } catch (err) { const cause = err instanceof Error ? err.message : String(err); log(`x: ${cause}`) }', ['interpolates a caught error']],
    ['a raw startup-error cause', "try { f() } catch (getErr) { recordStartupError('c', 'm', getErr) }", ['passes a caught error as a log argument']],
    ["a caught error through the click handler's logDeps", 'try { f() } catch (err) { logDeps(deps, `x: ${err}`) }', ['interpolates a caught error']],
    ['an unredacted errDescription', 'log(`x: ${e.errDescription}`)', ['logs an errDescription not through redactSlackLogText']],
    ['an unchecked errName', 'console.error(`x: ${e.errName}`)', ['logs an errName not checked by isSafeIdentifier']],
    ['a wrapper that logs its error raw', 'function logFailure(what, err) { log(`${what}: ${err}`) }\ntry { f() } catch (err) { logFailure("x", err) }', ['interpolates a caught error', 'passes a caught error as a log argument']],
    ['the describer', 'try { f() } catch (err) { log(`x: ${describeThrownValue(err)}`) }', []],
    ['a redacted errDescription', 'log(`x: ${redactSlackLogText(e.errDescription)}`)', []],
    ['a checked errName', 'log(`x: ${isSafeIdentifier(e.errName) ? e.errName : describeThrownValue(e)}`)', []],
    ['a describing wrapper', 'function logFailure(what, err) { log(`${what}: ${describeThrownValue(err)}`) }\ntry { f() } catch (err) { logFailure("x", err) }', []],
    // Decision B1: a message is kept, but only redacted (a bare one is the "a caught error's message" row above).
    ['a redacted err.message', 'try { f() } catch (err) { log(`x: ${redactSlackLogText(err.message)}`) }', []],
    ['a message through describeLogMessage', 'try { f() } catch (err) { console.error(`x: ${describeLogMessage(err.message)}`) }', []],
    ['a bare err.message beside a redacted one', 'try { f() } catch (err) { log(`x: ${redactSlackLogText(err.message)} (${err.message})`) }', ["reads a caught error's message or stack"]],
    ['an agent-director describer as a startup-error cause', "try { f() } catch (err) { recordStartupError('c', `m: ${describeAgentDirectorFailure(err)}`, describeAgentDirectorFailure(err)) }", []],
  ])('rule check: %s', (_label, code, rules) => {
    expect(rawErrorFindings(code).map((f) => f.rule)).toEqual(rules)
  })

  test('no log call passes a caught error, its unredacted message, an unredacted errDescription or an unchecked errName, bar the allow-list', () => {
    const failures = findings
      .filter((f) => !RAW_ERROR_ALLOWED.some((entry) => allows(entry, f)))
      .map((f) => `${f.file}: ${f.rule}: ${f.call.slice(0, 120)}`)
    expect(checked(failures, 'raw-error failures')).toEqual([])
  })

  test('every allow-list entry has a reason and still matches a flagged log call in its file (none stale)', () => {
    const failures = RAW_ERROR_ALLOWED.flatMap((entry) => {
      if (entry.reason.trim() === '') return [`${entry.file} "${entry.anchor}": allow-list entry has no reason`]
      if (!SOURCE_FILES.includes(entry.file)) return [`${entry.file} "${entry.anchor}": stale allow-list entry: no such file`]
      if (!findings.some((f) => allows(entry, f))) return [`${entry.file} "${entry.anchor}": stale allow-list entry: matches no flagged log call`]
      return []
    })
    expect(checked(failures, 'allow-list failures')).toEqual([])
  })

  test('every safe describer is still declared under src/', () => {
    const declared = (name: string): boolean =>
      SOURCE_FILES.some((file) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(codeOf(file)))
    expect(SAFE_DESCRIBERS.filter((name) => !declared(name))).toEqual([])
  })
})
