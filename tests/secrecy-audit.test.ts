/**
 * secrecy-audit.test.ts — Repo-level credential-secrecy audit (
 * closing audit).
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
 * 1. Named legs. The config, connection (`persona-connections`),
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
 *    config-file onset quotes agent-director, the conflict latch, whose
 *    lines and record carry agent-director's CONFLICT description, the kill
 *    modules (the checked kill, its bounded retry and the kill-failure
 *    alert's texts), the read-pane outcome, the CLI precheck's verdict and
 *    failure lines, the persona routing, the live-row sequence, whose step
 *    lines carry agent-director failure text, the old-life wait's round
 *    end, whose notice texts carry agent-director's CONFLICT and
 *    unusable-name answers, the pending-row rule, whose lines quote
 *    the lap's and the run's agent-director outcomes, the clear-latch
 *    route, whose clear-failed line carries a clear by hand's rejection, and
 * the stored-choice store, whose record holds each
 *    persona's declaration, a credentials file's path among them, and which
 *    logs its read and write failures), a value import of one
 *    of the `HELPER_SURFACES` helpers (the token builders and sentinel, the
 *    config-file writer, the agent-director settings-file writer, the
 *    stored-choice file writer, the reload,
 *    connection, routing and recovery harnesses, the Slack client factory
 *    stub and its marker-planting rejection factories, the upgrade fixture
 *    generator's config builders and writers), or sets a stub's
 *    `leakMarker`. A suite that matches but has no
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
 * 5. A caught error's text reaches a log line only redacted ( section 0,
 * operator decision B1, replacing The current rule's "messages
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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { BOT_TOKEN_PREFIX, LEAK_SENTINEL, TOKEN_LIKE, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { serializeTestMeasurement, queueEventMeasurement, postHoldEventMeasurement, type TestMeasurementRecord } from '../src/test-measurements.ts'
import { ackVerdict, storeVerdict, postHoldVerdict, n2Verdict, lookupFaultVerdicts, printResults, envelopeTimings } from './integration/fixtures/sr8-evidence.ts'
import { percentile } from './integration/fixtures/transcript-receipts.ts'
import { balancedAfter, callArguments, callsOf, splitTopLevel, stripComments } from './test-helpers/source-audit.ts'

/** b.c13: process starts use the shared filter; entries scrub before dispatch.
 * Follow the two CLI adapters as well as direct starts. Adapter parameters are
 * accepted only at their named boundary; every deps call is audited separately.
 * This scans AST calls, so comments and literals cannot satisfy the rule.
 */
function childEnvironmentViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // Bind this file only: symbols distinguish imports, nested locals and
  // parameters without loading any project module or running startup code.
  const compilerOptions: ts.CompilerOptions = { noResolve: true, noLib: true, types: [] }
  const host = ts.createCompilerHost(compilerOptions)
  host.getSourceFile = path => path === file ? sf : undefined
  const checker = ts.createProgram([file], compilerOptions, host).getTypeChecker()
  const symbol = (node: ts.Node) => ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
  const failures: string[] = []
  const processFunctions = new Set<string>()
  const namespaces = new Set<string>()
  const envBuilders = new Set<ts.Symbol>()
  const scrubbers = new Set<ts.Symbol>()
  const processVerbs = /^(?:spawn(?:Sync)?|exec(?:Sync|File|FileSync)?|fork)$/
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    if (/^(?:node:)?child_process$/.test(specifier)) {
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (processVerbs.test((item.propertyName ?? item.name).text)) processFunctions.add(item.name.text)
      }
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text)
    }
    if (/^\.\.?\/child-env(?:\.ts)?$/.test(specifier) && bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        const name = (item.propertyName ?? item.name).text
        const binding = symbol(item.name)
        if (binding && name === 'childEnv') envBuilders.add(binding)
        if (binding && name === 'scrubProcessEnv') scrubbers.add(binding)
      }
    }
  }
  const importedCall = (node: ts.Node | undefined, imports: Set<ts.Symbol>): node is ts.CallExpression =>
    !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && !!symbol(node.expression) && imports.has(symbol(node.expression)!)
  const directBuilder = (node: ts.Node | undefined): boolean => importedCall(node, envBuilders)
  const isProcessEnv = (node: ts.Node | undefined): boolean => !!node && ts.isPropertyAccessExpression(node)
    && node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process'
    && !symbol(node.expression) // a local `process` would scrub a different object
  function processCall(node: ts.CallExpression): boolean {
    const callee = node.expression
    return ts.isIdentifier(callee) && processFunctions.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && processVerbs.test(callee.name.text)
        && (namespaces.has(callee.expression.getText(sf)) || callee.expression.getText(sf) === 'Bun')
  }
  function depsCall(node: ts.CallExpression, name: string): boolean {
    return ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sf) === 'deps'
      && node.expression.name.text === name
  }
  // An environment may only flow straight to an audited process boundary.
  // Any other reference could mutate it or hand an alias to unknown code.
  function envUse(node: ts.Identifier): boolean {
    let property: ts.Node = node.parent
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'env') property = property.parent
    else if (ts.isPropertyAssignment(property) && property.initializer === node && property.name.getText(sf) === 'env') property = property.parent
    if (ts.isObjectLiteralExpression(property) && ts.isCallExpression(property.parent)
      && property.parent.arguments.includes(property)) {
      return processCall(property.parent) || depsCall(property.parent, 'spawnDaemon')
    }
    return ts.isCallExpression(node.parent)
      && (depsCall(node.parent, 'spawnSync') && node.parent.arguments[2] === node
        || depsCall(node.parent, 'runCredentialsScript') && node.parent.arguments[1] === node)
  }
  function onlyEnvUses(binding: ts.Symbol, declaration: ts.Identifier): boolean {
    let safe = true
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && node !== declaration && symbol(node) === binding && !envUse(node)) safe = false
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return safe
  }
  function builtEnv(node: ts.Node | undefined): boolean {
    if (directBuilder(node)) return true
    if (!node || !ts.isIdentifier(node)) return false
    const binding = symbol(node)
    if (!binding || binding.declarations?.length !== 1) return false
    const declaration = binding.declarations[0]!
    return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
      && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
      && declaration.end < node.pos && directBuilder(declaration.initializer)
      && onlyEnvUses(binding, declaration.name)
  }
  function realDepsProperty(node: ts.Node, name: string): boolean {
    if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) || node.name.getText(sf) !== name) return false
    const object = node.parent
    const declaration = object.parent
    if (!ts.isObjectLiteralExpression(object) || !ts.isVariableDeclaration(declaration)
      || declaration.initializer !== object || declaration.name.getText(sf) !== 'realDeps') return false
    // These are precisely the production adapters inside the main entry,
    // never another object or a nested function with a familiar name.
    const statement = declaration.parent.parent
    return ts.isVariableStatement(statement) && ts.isBlock(statement.parent)
      && ts.isIfStatement(statement.parent.parent) && statement.parent.parent.parent === sf
      && statement.parent.parent.expression.getText(sf) === 'import.meta.main'
  }
  function credentialsAdapter(declaration: ts.FunctionDeclaration): boolean {
    if (declaration.parent !== sf || declaration.name?.text !== 'runCredentialsScript') return false
    const binding = symbol(declaration.name)
    let safe = true
    function references(node: ts.Node) {
      if (ts.isIdentifier(node) && node !== declaration.name && symbol(node) === binding
        && !realDepsProperty(node.parent, 'runCredentialsScript')) safe = false
      ts.forEachChild(node, references)
    }
    references(sf)
    return safe
  }
  function adapterParameter(node: ts.Node, value: ts.Node): boolean {
    if (!ts.isIdentifier(value) || file !== 'src/cli.ts') return false
    const binding = symbol(value)
    if (!binding) return false
    const matches = (parameter: ts.ParameterDeclaration | undefined): boolean => !!parameter
      && ts.isIdentifier(parameter.name) && symbol(parameter.name) === binding && onlyEnvUses(binding, parameter.name)
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isArrowFunction(parent) && realDepsProperty(parent.parent, 'spawnSync') && matches(parent.parameters[2])) return true
      if (ts.isFunctionDeclaration(parent) && credentialsAdapter(parent)
        && matches(parent.parameters[1])) return true
    }
    return false
  }
  function optionsClean(node: ts.Node | undefined): boolean {
    if (!node || !ts.isObjectLiteralExpression(node)) return false
    const envs = node.properties.filter(prop => !ts.isSpreadAssignment(prop) && prop.name?.getText(sf) === 'env')
    if (envs.length !== 1 || node.properties.some(ts.isSpreadAssignment)) return false
    const prop = envs[0]!
    const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined
    return builtEnv(value) || !!value && adapterParameter(node, value)
  }
  function daemonForwarder(call: ts.CallExpression): boolean {
    const arrow = call.parent
    return file === 'src/cli.ts' && ts.isArrowFunction(arrow)
      && realDepsProperty(arrow.parent, 'spawnDaemon')
      && call.arguments.length === 3 && arrow.parameters.length === 3
      && call.arguments.every((arg, i) => ts.isIdentifier(arg) && arg.text === arrow.parameters[i]?.name.getText(sf))
  }
  const report = (rule: string) => failures.push(`${file}: ${rule}`)
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const direct = ts.isIdentifier(callee) && processFunctions.has(callee.text)
      const method = ts.isPropertyAccessExpression(callee) && processVerbs.test(callee.name.text)
        && (namespaces.has(callee.expression.getText(sf)) || callee.expression.getText(sf) === 'Bun')
      if (direct || method) {
        const options = node.arguments.find(ts.isObjectLiteralExpression)
        if (!optionsClean(options) && !daemonForwarder(node)) report('child process without childEnv')
      }
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'deps') {
        if (callee.name.text === 'spawnDaemon' && !optionsClean(node.arguments[2])) report('daemon env without childEnv')
        if (callee.name.text === 'spawnSync' && !builtEnv(node.arguments[2])) report('CLI rerun env without childEnv')
        if (callee.name.text === 'runCredentialsScript' && !builtEnv(node.arguments[1])) report('credentials env without childEnv')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (file === 'src/cli.ts' || file === 'src/server.ts') {
    const entries = sf.statements.filter((s): s is ts.IfStatement => ts.isIfStatement(s) && s.expression.getText(sf) === 'import.meta.main')
    if (entries.length !== 1) report('missing main entry scrub')
    for (const entry of entries) {
      const first = ts.isBlock(entry.thenStatement) ? entry.thenStatement.statements[0] : undefined
      const call = first && ts.isExpressionStatement(first) && ts.isCallExpression(first.expression) ? first.expression : undefined
      if (!importedCall(call, scrubbers) || call.arguments.length > 2
        || call.arguments.length > 0 && !isProcessEnv(call.arguments[0])) report('entry must scrub process.env before dispatch')
    }
  }
  return failures
}

describe('b.c13 source environment audit', () => {
  test('every src process boundary and both main entries use the shared filter', () => {
    const failures: string[] = []
    for (const path of walk(join(ROOT, 'src')).filter(path => path.endsWith('.ts'))) {
      failures.push(...childEnvironmentViolations(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')))
    }
    assertNoLeak(failures)
    expect(failures).toEqual([])
  })

  const imports = "import { childEnv, scrubProcessEnv } from './child-env.ts';"
  test.each([
    "import { spawn } from 'child_process'; spawn('tool', []);",
    "import { spawnSync as launch } from 'node:child_process'; launch('tool', [], {env:process.env});",
    "import * as cp from 'node:child_process'; cp.execFile('tool', [], {env:{...process.env}});",
    "import cp from 'node:child_process'; cp.execSync('tool', {env:process.env});",
    "Bun.spawn(['tool']);", "Bun.spawnSync({cmd:['tool'], env:process.env});",
    "import { spawn } from 'child_process'; spawn('tool', [], {env:childEnv(process.env), ...unsafe});",
    "import { spawn } from 'child_process'; spawn('tool', [], {env:{...childEnv(process.env), SLACK_BOT_TOKEN:'fake-not-a-token'}});",
    "deps.spawnSync('tool', [], process.env);",
    "deps.spawnDaemon('tool', [], {env:process.env});",
    "deps.runCredentialsScript(path, process.env);",
  ])('rejects planted unfiltered process boundary %#', source => {
    expect(childEnvironmentViolations('src/planted.ts', `${imports}\n${source}`)).not.toEqual([])
  })
  test.each(['src/cli.ts', 'src/server.ts'])('%s rejects absent, late, comment-only and literal-only entry scrubs', file => {
    for (const body of ['', 'dispatch(); scrubProcessEnv();', '/* scrubProcessEnv(); */ dispatch();', '"scrubProcessEnv()"; dispatch();']) {
      expect(childEnvironmentViolations(file, `${imports}\nif (import.meta.main) {${body}}`)).not.toEqual([])
    }
    expect(childEnvironmentViolations(file, `${imports}\nif (import.meta.main) { scrubProcessEnv(); dispatch(); }`)).toEqual([])
  })
  test.each([
    'let clean = childEnv(process.env); clean = process.env; Bun.spawn({cmd:[], env:clean});',
    'const clean = childEnv(process.env); function launch(clean) { Bun.spawn({cmd:[], env:clean}); }',
    'const clean = childEnv(process.env); { const clean = process.env; Bun.spawn({cmd:[], env:clean}); }',
    'function seed() { const clean = childEnv(process.env); } const clean = process.env; Bun.spawn({cmd:[], env:clean});',
    'const clean = childEnv(process.env); clean.SLACK_BOT_TOKEN = "fake-not-a-token"; Bun.spawn({cmd:[], env:clean});',
    'const clean = childEnv(process.env); Object.assign(clean, process.env); Bun.spawn({cmd:[], env:clean});',
    'const clean = childEnv(process.env); const alias = clean; alias.X = "fake-not-a-token"; Bun.spawn({cmd:[], env:clean});',
    'const clean = childEnv(process.env); const holder = {env: clean}; holder.env.X = "fake-not-a-token"; Bun.spawn({cmd:[], env:clean});',
    'function launch(childEnv) { Bun.spawn({cmd:[], env:childEnv(process.env)}); }',
    'Bun.spawn({cmd:[], env:clean}); const clean = childEnv(process.env);',
  ])('rejects a binding that cannot prove a filtered environment %#', source => {
    expect(childEnvironmentViolations('src/planted.ts', `${imports}\n${source}`)).toContain('src/planted.ts: child process without childEnv')
  })
  test.each(['src/cli.ts', 'src/server.ts'])('%s rejects a scrub of any other object or a shadowed process', file => {
    for (const argument of ['{}', 'otherEnv', 'undefined']) {
      expect(childEnvironmentViolations(file, `${imports}\nif (import.meta.main) { scrubProcessEnv(${argument}); dispatch(); }`))
        .toContain(`${file}: entry must scrub process.env before dispatch`)
    }
    expect(childEnvironmentViolations(file, `${imports}\nconst process = {env:{}}; if (import.meta.main) { scrubProcessEnv(process.env); }`))
      .toContain(`${file}: entry must scrub process.env before dispatch`)
    expect(childEnvironmentViolations(file, `${imports}\nif (import.meta.main) { scrubProcessEnv(process.env); dispatch(); }`)).toEqual([])
  })
  test.each([
    'const realDeps = { spawnSync: (cmd, args, env) => { env = process.env; return spawnSync(cmd, args, {env}); } };',
    'function runCredentialsScript(path, env) { function nested(env) { return spawnSync("bash", [path], {env}); } }',
    'function runCredentialsScript(path, env) { env.SLACK_BOT_TOKEN = "fake-not-a-token"; return spawnSync("bash", [path], {env}); }',
    'function outside() { function runCredentialsScript(path, env) { return spawnSync("bash", [path], {env}); } }',
    'const other = { spawnSync: (cmd, args, env) => spawnSync(cmd, args, {env}) };',
    'function runCredentialsScript(path, env) { return spawnSync("bash", [path], {env}); } runCredentialsScript(path, process.env);',
  ])('rejects reassigned, shadowed or mutated CLI adapter parameters %#', source => {
    expect(childEnvironmentViolations('src/cli.ts', `${imports}\nimport {spawnSync} from 'child_process';\n${source}\nif (import.meta.main) {scrubProcessEnv(process.env);}`))
      .toContain('src/cli.ts: child process without childEnv')
  })
  test('accepts direct and prebuilt filtered envs, import aliases and Bun command objects', () => {
    expect(childEnvironmentViolations('src/filtered.ts', `${imports}
      import { spawn as launch, execFileSync } from 'node:child_process';
      const clean = childEnv(process.env);
      launch('tool', [], {env: clean}); execFileSync('tool', [], {env:childEnv(process.env)});
      Bun.spawn({cmd:['tool'], env:childEnv(process.env)});
    `)).toEqual([])
  })
  test('resolves helper import aliases and separate lexical bindings', () => {
    expect(childEnvironmentViolations('src/filtered.ts', `import { childEnv as copyEnv } from './child-env.ts';
      const clean = copyEnv(process.env); Bun.spawn({cmd:[], env:clean});
      function nested() { const clean = copyEnv(process.env); Bun.spawn({cmd:[], env:clean}); }
    `)).toEqual([])
  })
})

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
  [/^src\/channel-membership(?:-scan|-readiness|-evidence)?\.ts$/, 'authenticated installation and durable membership evidence, API diagnostics and operator records'],
  [/^src\/codex-config-keys\.ts$/, 'the names-only Codex config scanner and authorized top-level host model reader'],
  [/^src\/config\.ts$/, 'the persona config loader and record validation'],
  [/^src\/shared-channels\.ts$/, 'the durable applied configuration, source input and persona identity authority'],
  [/^src\/shared-state-reports\.ts$/, 'shared-state notice builders and reporter carry authority failure text, configured identities and paths into Slack notices and diagnostic lines'],
  [/^src\/shared-recovery\.ts$/, 'damaged authority evidence, prepared input and recovery request parsing'],
  [/^src\/test-mcp-drop\.ts$/, 'the test-only MCP disconnect route, which reads applied persona config and logs and returns the configured persona key'],
  [/^src\/test-measurements\.ts$/, 'test-only records project queue and Post Hold metadata; write diagnostics carry configured paths and redacted storage failure codes'],
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
  // The modules the raw-error sweep touched whose output carries an agent-director or Slack failure's text (now
  // kept, redacted) to a log, a startup error, a Slack post or an MCP tool result ( carry, section 0).
  [/^src\/registry\.ts$/, "the MCP registry, whose tool results carry a Slack call's failure text back to the session"],
  [/^src\/session-manager\.ts$/, "the session manager, whose launch lines, startup errors and spawn-failure notices carry agent-director failure text"],
  [/^src\/restart\.ts$/, "the restart path, whose lines and notices carry agent-director failure text"],
  [/^src\/permission-poller\.ts$/, "the permission poller, which posts through a persona's client and logs agent-director and Slack failure text"],
  [/^src\/permission-click-handler\.ts$/, "the click handler, which updates through a persona's client and logs and trails agent-director failure text"],
  [/^src\/persona-notifier\.ts$/, "the persona notifier, which posts notices through a persona's client and logs Slack failure text"],
  [/^src\/notice-correction\.ts$/, 'the posted-notice correction, whose outcomes carry described Slack failure text to the logOutcome callback'],
  [/^src\/persona-destination[\w-]*\.ts$/, "the destination resolver and hold, which open DMs through a persona's client and describe Slack failures"],
  [/^src\/health-check\.ts$/, 'the health check, whose lines carry agent-director failure text'],
  [/^src\/cli\.ts$/, 'the CLI, which loads the config and logs agent-director failure text'],
  [/^src\/cli-teardown\.ts$/, "the CLI teardown commands' pure pieces, whose precheck failure lines and teardown verdicts and outcomes carry agent-director failure text (described, redacted) to the terminal and clean_restart.log"],
  [/^src\/agent-director-template\.ts$/, "the template install and refresh, whose lines and startup error carry agent-director failure text"],
  [/^src\/ad-error-class\.ts$/, "the agent-director error classifier, whose reported message carries agent-director failure text (an error's description) to log lines"],
  [/^src\/ad-settings\.ts$/, "the agent-director settings reader, which reads agent-director's config.toml and logs a refused read's reason"],
  [/^src\/unavailable-retry\.ts$/, "the UNAVAILABLE retry timer, whose lines can carry agent-director failure text (a cause or a failed retry, described)"],
  [/^src\/persona-episodes\.ts$/, "the persona episodes and the tmux-unresponsive condition, whose start line carries agent-director failure text (the refusing verb's error, described)"],
  [/^src\/outage-state\.ts$/, "the outage flags and their notices, whose ad-config-malformed onset carries agent-director's description (its error's message) to Slack"],
  [/^src\/conflict-latch\.ts$/, "the conflict latch, whose latch and relatch lines and stored record carry text from agent-director's CONFLICT description (the quoted session and the description, redacted)"],
  [/^src\/checked-kill\.ts$/, "the checked kill, whose outcome keeps the thrown agent-director error and an ErrTmuxKillFailed description raw, and whose one-line rendering carries agent-director failure text (described, redacted) to log lines and startup errors"],
  [/^src\/kill-retry\.ts$/, "the bounded retry of a live row's kill, whose per-try and per-read lines carry agent-director failure text (described, redacted) and whose alert decision keeps agent-director's kill-failure descriptions raw"],
  [/^src\/kill-failure-alert\.ts$/, "the kill-failure alert's texts, which quote agent-director's kill-failure descriptions (redacted) in Slack posts, log lines and startup-errors entries"],
  [/^src\/live-row-sequence\.ts$/, "the live-row sequence, whose step lines carry agent-director failure text (a failed get's failure and each kill's outcome, described, redacted) and whose kill results keep agent-director's kill-failure descriptions raw"],
  [/^src\/old-life-wait\.ts$/, "the old-life wait's round end, whose persona-teardown-notice texts carry agent-director's CONFLICT and unusable-name answers (described, redacted) to log lines and startup-errors entries, and whose answers keep the thrown agent-director errors and kill results raw"],
  [/^src\/pane-read\.ts$/, "the read-pane outcome, whose failure outcomes carry the described agent-director failure text (redacted) to the callers' log lines"],
  [/^src\/invalid-flags-hold\.ts$/, "the ErrInvalidFlags hold, which posts its operator alert and logs the agent-director versions a re-check reported (a version that is not a short version string is logged as unreadable) and its reactions' failures (described, redacted)"],
  [/^src\/pending-row\.ts$/, "the pending-row rule, whose round, gate and failure lines quote the lap's and the bypassing run's agent-director outcomes (described, redacted) and whose lap Enter outcomes keep the thrown agent-director error raw"],
  [/^src\/persona-routing\.ts$/, "the persona routing, which receives a persona's Slack events, archives through its client and logs Slack failure text and its lost-message row read's agent-director failure text (described, redacted)"],
  [/^src\/clear-latch\.ts$/, "the clear-latch route and the server.port record, whose clear-failed line carries a clear by hand's rejection (described, redacted), which can be agent-director failure text"],
  // the state directory move walks the directory that holds the credentials files and the config, and logs paths and errors.
  [/^src\/state-dir-migration\.ts$/, "the state directory move, which compares and moves the files of the state directory (the credentials files among them) and logs only their names and errors"],
  // the stored-choice file holds the credentials file's path, never its content.
  [/^src\/channel-delivery-attempt\.ts$/, 'logical attempt validation and hashed caller identity evidence'],
  [/^src\/channel-delivery\.ts$/, "the stored-choice store, which records each persona's declaration, a credentials file's path among them, and logs its read and write failures"],
  // Thread Memory's lookups and own-post observation: each makes or reads an authenticated Slack request on a persona's client.
  [/^src\/thread-memory\.ts$/, "the bounded metadata attempts, which run a persona's authenticated Slack requests and classify their raw failures (an error's message can hold a token) into safe codes"],
  [/^src\/own-post-lookup\.ts$/, "own-post recovery lookups, which run a persona's authenticated Slack reads, read its own upload-share Events, and classify their raw failures into safe outcomes"],
  [/^src\/thread-memory-reports\.ts$/, "Thread Memory's notice and diagnostic builders and reporter, which carry configured identities and paths plus described storage failures to Slack posts and log lines"],
  [/^src\/own-post\.ts$/, "the own-post observer, whose issues carry the issuing persona's bot identity and whose fault callback receives an owner's raw fault, own-post eligibility over the applied config and current membership, and the reading of upload completions as Slack returned them"],
  [/^src\/file-upload-observation\.ts$/, "the file-completion observation, which wraps a persona's raw Web API client and hands each completion response, as Slack returned it, to its listener"],
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
  'tests/test-helpers/shared-channels.ts': { sharedRecoveryRequest: 'binds exact damaged evidence and optional replacement input through the production grammar', deliveryAttempt: 'builds caller-retained attempt inputs', contradictoryBotHistory: 'derives malformed durable attempt evidence', deliveryResultSamples: 'builds durable attempt result variants', makeMembershipHarness: 'builds authenticated connection and durable membership composition', configBytes: 'serializes config input', initialSharedState: 'builds a shared config-state envelope', writeSharedState: 'writes the shared config-state envelope', makeSharedAuthority: 'builds and writes the shared authority' },
  'tests/test-helpers/persona-config.ts': { writeConfigFile: 'writes a config file' },
  'tests/test-helpers/ad-settings.ts': { writeAgentDirectorConfig: "writes agent-director's config.toml" },
  'tests/test-helpers/channel-delivery.ts': { writeChannelDeliveryRecord: 'writes a stored-choice file holding persona declarations' },
  'tests/test-helpers/reload-harness.ts': { makeReloadHarness: 'builds the reload harness' },
  'tests/test-helpers/thread-memory.ts': {
    populationConfig: 'builds SR-8 persona configuration through the shared channel builders',
    seedUnitPopulation: 'reads the applied shared configuration and seeds its Thread Memory journal',
    threadConfig: 'builds Thread Memory persona configuration',
    makeThreadMemoryHarness: 'builds applied configuration and captures Thread Memory reports and storage failures',
    makeThreadMembershipHarness: 'builds authenticated membership and Thread Memory composition',
  },
  'tests/test-helpers/own-post.ts': {
    makeOwnPostHarness: 'builds own-post observation over authenticated membership, applied configuration and Thread Memory',
  },
  'tests/test-helpers/persona-connection-harness.ts': { makeConnectionHarness: 'builds the connection manager over credentials files' },
  'tests/test-helpers/persona-routing-harness.ts': { makeRoutingHarness: 'builds sentinel-bearing Slack stubs' },
  'tests/test-helpers/recovery-harness.ts': { makeRecoveryHarness: "builds the recovery harness, which writes agent-director's config.toml and captures the retry timer's, settings reader's and tmux-unresponsive condition's lines" },
  'tests/test-helpers/slack-stub.ts': {
    makeStubSlackFactory: 'builds Slack clients from tokens',
    slackPlatformError: 'builds a Slack platform rejection that, given a leak marker, plants it in a fake bot token in its message',
    slackRateLimited: 'builds a Slack rate-limited rejection that, given a leak marker, plants it in a fake bot token in its message',
  },
  'tests/integration/fixtures/slack-stub-server.ts': { startSlackStub: "serves token-bearing Slack clients; records redeliveries, socket closes, lost answers and history pages without credential or connection-ticket values; only pre-existing synthetic connection markers remain" },
  'tests/test-helpers/ci-run.ts': {
    makeFakeCodexHome: 'writes fake Codex login and config files under the fixture root',
    makeFakeCodexLogin: 'builds injected Codex login dependencies with sentinel-bearing tokens',
  },
  'tests/test-helpers/shared-channel-upgrade.ts': {
    oldConfigBytes018: 'serializes a 0.18.0 config naming persona credentials files',
    oldStoredChoiceBytes018: 'serializes a 0.18.0 stored-choice file holding persona declarations',
    writeOldReference018: 'writes a 0.18.0 config file and its applied baseline',
    buildUpgradeCases: "builds every upgrade case's config, stored-choice and queue files",
    writeUpgradeFixtures: "writes the upgrade cases' config, stored-choice and queue files",
    materializeUpgradeCase: "writes a case's configs, applied baselines and stored-choice files, naming its credentials paths",
    runUpgradeCaseCommand: 'runs the materialize and reference commands, printing credentials paths',
  },
}

// These executable fixtures have no importable runtime surface: importing
// them would execute their image entrypoints. Audit their source and captured
// declaration controls instead of putting them in HELPER_SURFACES's imports.
const IMAGE_CLIENT_SURFACES = {
  'tests/integration/fixtures/shared-stub-permission.ts': 'reads registered permission outcomes and actual AD rows after the image guard; emits only bound identity, request token, decision and delivery metadata, with fixed failure text and no raw client errors',
  'tests/integration/fixtures/stub-mcp-session.ts': 'holds MCP transports and captures SDK tool results; grouping, loss and replacement-session evidence contains request/session identity and HTTP status, never transport headers or credentials',
} as const

describe('shared fixture evidence secrecy', () => {
  test('image-only client surfaces have explicit reasons and declaration evidence is leak-checked', () => {
    for (const [file, reason] of Object.entries(IMAGE_CLIENT_SURFACES)) {
      expect(existsSync(join(ROOT, file))).toBe(true)
      expect(reason.length).toBeGreaterThan(30)
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain("existsSync('/etc/cscb-ci-image')")
    }
    for (const file of ['tests/host-safety.test.ts', 'tests/fmk-source-audit.test.ts']) expect(callsAssertNoLeak(file)).toBe(true)
  })

  const source = readFileSync(join(ROOT, 'tests/integration/fixtures/slack-stub-server.ts'), 'utf8')
  const ast = ts.createSourceFile('slack-stub-server.ts', source, ts.ScriptTarget.Latest, true)
  const fields: Record<string, string[]> = {
    'socket-close': ['control', 'control_index', 'label', 'connection_id'],
    'socket-close-missed': ['control', 'control_index', 'label'],
    'fault-settled': ['request_id', 'resolution'],
    redelivery: ['control', 'label', 'original_envelope_id', 'source_envelope_id', 'envelope_id', 'event_id', 'connection_id', 'retry_attempt'],
    'push-installation': ['control', 'label', 'envelope_id', 'connection_id'],
    'connection-refused': ['control', 'control_index', 'label', 'method', 'request_id', 'remaining'],
    fault: ['control', 'fault_index', 'method', 'label', 'request_id', 'matching_call', 'outcome', 'performed', 'response_ts'],
  }
  const calls: ts.CallExpression[] = []
  function collect(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'record' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text in fields) calls.push(node)
    ts.forEachChild(node, collect)
  }
  collect(ast)
  const redactorNames = ['TOKEN_LIKE_SOURCE', 'TOKEN_LIKE_ALL', 'PUSH_FIELD_MAX', 'pushFieldText']
  const redactorSource = ast.statements.filter(n =>
    ts.isFunctionDeclaration(n) ? redactorNames.includes(n.name?.text ?? '') :
      ts.isVariableStatement(n) && n.declarationList.declarations.some(d => redactorNames.includes(d.name.getText(ast))))
    .map(n => n.getText(ast)).join('\n')
  const pushFieldText = new Function(ts.transpileModule(redactorSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nreturn pushFieldText;')() as (value: unknown) => string | null

  test('every new record kind is explicitly covered', () => {
    expect(calls.map(c => (c.arguments[0] as ts.StringLiteral).text).sort()).toEqual(Object.keys(fields).sort())
  })
  test.each(Object.keys(fields))('%s projects metadata only from credential-bearing inputs', event => {
    const call = calls.find(c => (c.arguments[0] as ts.StringLiteral).text === event)!
    const token = fakeToken(BOT_TOKEN_PREFIX, 'shared-evidence'), ticket = 'PRIVATE_CONNECTION_TICKET'
    const bindings = {
      pushFieldText, close: { label: token, ticket, token }, ws: { data: { connectionId: 'connection', ticket, token } }, index: 1,
      requestId: 'request', resolution: 'aborted', label: token, originalEnvelopeId: 'original',
      parsed: { redeliver: { envelope_id: 'source', ticket, token }, ticket, token, text: LEAK_SENTINEL },
      envelopeId: 'envelope', eventId: 'event', target: { data: { connectionId: 'connection', ticket, token } }, retryAttempt: 2,
      refusal: { index: 1, remaining: 3, ticket, token }, method: 'chat.postMessage', fields: { request_id: 'request', ticket, token },
      call: 4, fault: { outcome: 'lost', performed: true, token, ticket, text: LEAK_SENTINEL },
      body: { ts: '1234567890.000001', text: LEAK_SENTINEL, token, ticket },
    }
    const emitted: Record<string, unknown>[] = []
    const emit = (kind: string, value: Record<string, unknown>) => { expect(kind).toBe(event); emitted.push(value) }
    new Function('record', ...Object.keys(bindings), call.getText(ast))(emit, ...Object.values(bindings))
    expect(emitted).toHaveLength(1)
    expect(Object.keys(emitted[0]!).sort()).toEqual([...fields[event]!].sort())
    assertNoLeak(emitted)
    expect(JSON.stringify(emitted)).not.toContain(ticket)
    expect(Object.keys(emitted[0]!).some(key => /token|ticket|authorization|headers|text|payload/.test(key))).toBe(false)
    // The same check must reject a newly copied transport object or field.
    for (const planted of [{ ...emitted[0], ticket }, { ...emitted[0], token }, { ...emitted[0], text: LEAK_SENTINEL }]) {
      expect(Object.keys(planted).sort()).not.toEqual([...fields[event]!].sort())
    }
  })
  test.each(['users.info', 'conversations.info', 'users.conversations'].flatMap(method =>
    ['hang', 'delay', 'late'].map(outcome => [method, outcome])))('%s %s fault arrival projection contains only numeric clocks', (method, outcome) => {
    const call = calls.find(c => (c.arguments[0] as ts.StringLiteral).text === 'fault')!
    const token = fakeToken(BOT_TOKEN_PREFIX, 'arrival-evidence')
    const bindings = { pushFieldText, index: 0, method, label: token, requestId: 'request', call: 1,
      fault: { outcome, text: LEAK_SENTINEL, token, body: { channels: [{ name: LEAK_SENTINEL }], token } }, args: { user: token, channel: token },
      body: { text: LEAK_SENTINEL, token },
      arrivalMonoMs: 123.5, arrivalEpochMs: 1800000000000 }
    const emitted: Record<string, unknown>[] = []
    new Function('record', ...Object.keys(bindings), call.getText(ast))((_kind: string, row: Record<string, unknown>) => emitted.push(row), ...Object.values(bindings))
    expect(emitted).toHaveLength(1)
    expect(Object.keys(emitted[0]!).sort()).toEqual(['control', 'fault_index', 'method', 'label', 'request_id', 'matching_call', 'outcome',
      'arrival_mono_ms', 'arrival_epoch_ms', ...(method === 'users.conversations' ? [] : ['match'])].sort())
    expect(emitted[0]!.arrival_mono_ms).toBe(bindings.arrivalMonoMs)
    expect(emitted[0]!.arrival_epoch_ms).toBe(bindings.arrivalEpochMs)
    assertNoLeak(emitted)
  })
  test.each([false, true])('late settlement projects socket_open with aborted=%s and no request data', aborted => {
    const call = calls.find(c => (c.arguments[0] as ts.StringLiteral).text === 'fault-settled')!
    const token = fakeToken(BOT_TOKEN_PREFIX, 'late-settlement')
    const req = { signal: { aborted, token }, headers: { authorization: token }, body: LEAK_SENTINEL }
    const emitted: Record<string, unknown>[] = []
    new Function('record', 'requestId', 'resolution', 'req', call.getText(ast))(
      (_kind: string, row: Record<string, unknown>) => emitted.push(row), 'request', 'late', req)
    expect(emitted).toEqual([{ request_id: 'request', resolution: 'late', socket_open: !aborted }])
    assertNoLeak(emitted)
  })
})

describe('SR-8 measurement evidence secrecy', () => {
  const poison = () => ({ token: fakeToken(BOT_TOKEN_PREFIX, 'sr8-evidence'), text: LEAK_SENTINEL,
    headers: { authorization: fakeToken(BOT_TOKEN_PREFIX, 'sr8-header') }, error: new Error(LEAK_SENTINEL) })

  test('bulk envelope timings omit credential-bearing observation fields', () => {
    const extra = poison()
    const rows = [
      { ...extra, event: 'push', envelope_id: 'original', sent_mono_ms: 1, connection_id: 'old' },
      { ...extra, event: 'push', envelope_id: 'replay', sent_mono_ms: 2, connection_id: 'new' },
      { ...extra, event: 'ws-message', envelope_id: 'replay', ack_mono_ms: 3, connection_id: 'new' },
      { ...extra, event: 'api', body: extra },
    ]
    const timings = envelopeTimings(['original', 'replay'], rows)
    expect(timings).toEqual([
      { envelope_id: 'original', push: { sent_mono_ms: 1, connection_id: 'old' }, acks: [] },
      { envelope_id: 'replay', push: { sent_mono_ms: 2, connection_id: 'new' },
        acks: [{ ack_mono_ms: 3, connection_id: 'new' }] },
    ])
    assertNoLeak({ timings, lines: timings.map(row => JSON.stringify(row)) })
  })

  test.each(['stored', 'fixed-stored', 'holds-resolved', 'post-hold-resolved'] as const)('%s records only projected measurement fields', kind => {
    const extra = poison()
    const event = { ...extra, type: kind, kind, key: 'alpha', seq: 1, store: 'accepted' as const, storeMs: 2,
      atMonoMs: 10, resolutions: [{ ...extra, seq: 1, outcome: 'released' as const, at: 10 }],
      outcome: 'released' as const, cause: 'timer' as const, heldMs: 3 }
    const projected = kind === 'post-hold-resolved' ? postHoldEventMeasurement(event as Parameters<typeof postHoldEventMeasurement>[0]) :
      queueEventMeasurement(event as Parameters<typeof queueEventMeasurement>[0])
    expect(projected).toBeDefined()
    const record = { ...projected!, ...extra, v: 1, at_mono_ms: 10 } as TestMeasurementRecord
    const line = serializeTestMeasurement(record)
    const expected = kind === 'holds-resolved' ? { v: 1, kind: 'resolution-store', at_mono_ms: 10, key: 'alpha', seqs: [1], store_ms: 2 } :
      kind === 'post-hold-resolved' ? { v: 1, kind, at_mono_ms: 10, key: 'alpha', seq: 1, outcome: 'released', cause: 'timer', held_ms: 3 } :
      { v: 1, kind: 'store', at_mono_ms: 10, key: 'alpha', seq: 1, store: kind === 'stored' ? 'accepted' : 'fixed', store_ms: 2 }
    expect(JSON.parse(line)).toEqual(expected)
    assertNoLeak({ projected, line })
  })

  test.each(['pass', 'fail', 'missing'] as const)('recorded sr8 %s lines omit credential-bearing input fields', verdict => {
    const extra = poison(), accepted = [{ ...extra, key: 'alpha', seq: 1 }]
    const rows = verdict === 'missing' ? undefined : [{ ...extra, v: 1, kind: 'store', key: 'alpha', seq: 1,
      store: 'accepted', store_ms: verdict === 'fail' ? 1e6 : 1, at_mono_ms: 1 }]
    const times = verdict === 'missing' ? undefined : [{ ...extra, envelope_id: 'envelope', push: { ...extra, sent_mono_ms: 1, connection_id: 'socket' },
      acks: [{ ...extra, ack_mono_ms: verdict === 'fail' ? 1e6 : 2, connection_id: 'socket' }] }]
    const probes = [{ ...extra, key: 'alpha', method: 'users.info', outcome: 'late', match: 'sender', envelope_id: 'envelope' }]
    const faults = [{ ...extra, event: 'fault', control: 'faults', label: 'alpha', method: 'users.info', outcome: 'late', match: 'sender', arrival_mono_ms: 1 }]
    const results = [ackVerdict('ack', ['envelope'], times), storeVerdict(rows, accepted, percentile),
      postHoldVerdict(rows, accepted, 1), n2Verdict([{ ...extra, key: 'alpha', seq: 1, name: extra.token }], 1),
      ...lookupFaultVerdicts(probes, faults, times)]
    expect(results.slice(0, 2).map(r => r.verdict)).toEqual([verdict, verdict])
    const lines: string[] = []
    printResults({ scenario: 'secrecy', mode: 'open', population: 0, recipients: 1 }, results, line => lines.push(line))
    expect(lines).toHaveLength(results.length + 1)
    expect(lines.every(line => line.startsWith('recorded: sr8 '))).toBe(true)
    assertNoLeak({ results, lines })
  })
})

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

/** The named legs: suites that must call `assertNoLeak`, with their extra content rules. */
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

/** The local name `file` (whose comment-stripped code is `code`) binds `assertNoLeak` to from the credentials helper, if it imports it. */
function assertNoLeakBinding(file: string, code: string = codeOf(file)): string | undefined {
  return valueImports(file, code).find((b) => b.module === CREDENTIALS_HELPER && b.imported === 'assertNoLeak')?.local
}

/** Whether `file` (whose comment-stripped code is `code`) imports `assertNoLeak` from the credentials helper and calls it. */
function callsAssertNoLeak(file: string, code: string = codeOf(file)): boolean {
  const local = assertNoLeakBinding(file, code)
  return local !== undefined && callsOf(code, local).length > 0
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

describe('named legs (closing audit)', () => {
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

  test('membership functions and the composition helper require leak checks, while constants and types do not', () => {
    const suite = 'tests/channel-membership.test.ts'
    for (const [module, name] of [
      ['channel-membership', 'createChannelMembership'], ['channel-membership-scan', 'createMembershipScanner'],
      ['channel-membership-readiness', 'handleMembershipReadiness'], ['channel-membership-evidence', 'orderMembershipRecovery'],
    ]) {
      expect(SOURCE_SURFACES.some(([re]) => re.test(`src/${module}.ts`))).toBe(true)
      expect(touchReasonsOf(suite, `import { ${name} as use } from '../src/${module}.ts'`).length).toBe(1)
      expect(touchReasonsOf(suite, `const use = await import('../src/${module}.ts')`).length).toBe(1)
      expect(touchReasonsOf(suite, `import type { Example } from '../src/${module}.ts'`)).toEqual([])
    }
    expect(touchReasonsOf(suite, "import { MEMBERSHIP_UNRESOLVED } from '../src/channel-membership.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import { makeMembershipHarness } from './test-helpers/shared-channels.ts'").length).toBe(1)
    for (const file of ['tests/channel-membership.test.ts', 'tests/channel-membership-readiness.test.ts']) {
      expect(callsAssertNoLeak(file)).toBe(true); expect(file in EXEMPT).toBe(false)
    }
  })

  test('own-post functions require leak checks, while its constants and types do not, without exemptions', () => {
    const suite = 'tests/own-post.test.ts'
    for (const code of [
      "import { createOwnPostObserver as observer } from '../src/own-post.ts'",
      "import { ownPostEligibility } from '../src/own-post.ts'",
      "import { decideOwnPostEligibility as decide } from '../src/own-post.ts'",
      "import * as ownPost from '../src/own-post.ts'",
      "const ownPost = await import('../src/own-post.ts')",
    ]) expect(touchReasonsOf(suite, code)).toEqual([expect.stringContaining('from src/own-post.ts: the own-post observer')])
    for (const code of [
      "import { OWN_POST_SURFACES } from '../src/own-post.ts'",
      "import type { OwnPostAnswer, OwnPostObserver } from '../src/own-post.ts'",
      "import { type OwnPostObserver } from '../src/own-post.ts'",
      "import type * as OwnPost from '../src/own-post.ts'",
    ]) expect(touchReasonsOf(suite, code)).toEqual([])
    expect(callsAssertNoLeak(suite)).toBe(true)
    expect(suite in EXEMPT).toBe(false)
    expect(touchReasonsOf(suite, "import { makeOwnPostHarness } from './test-helpers/own-post.ts'")).toHaveLength(1)
  })

  test('operator request/review functions and new helpers remain secret-bearing surfaces without exemptions', () => {
    const suite = 'tests/reload-operator.test.ts'
    for (const [module, fn, constant] of [['reload-request', 'buildReviewRequest', 'REVIEW_REQUEST_FORMAT'], ['reload-review', 'createReviewObserver', 'RELOAD_REVIEW_OUTCOME']]) {
      expect(SOURCE_SURFACES.some(([re]) => re.test(`src/${module}.ts`))).toBe(true)
      for (const source of [`import { ${fn} as use } from '../src/${module}.ts'`, `const use = await import('../src/${module}.ts')`]) expect(touchReasonsOf(suite, source)).toHaveLength(1)
      expect(touchReasonsOf(suite, `import type { Any } from '../src/${module}.ts'`)).toEqual([])
      expect(touchReasonsOf(suite, `import { ${constant} } from '../src/${module}.ts'`)).toEqual([])
    }
    for (const file of ['tests/reload-operator.test.ts', 'tests/reload-request.test.ts', 'tests/reload-fixtures.test.ts']) {
      expect(callsAssertNoLeak(file)).toBe(true); expect(file in EXEMPT).toBe(false)
    }
    const factory = 'makeReloadHarness'
    expect(touchReasonsOf(suite, `import { ${factory} } from './test-helpers/reload-harness.ts'`)).toHaveLength(1)
  })

  test('damaged-start parsers, renderers and request helper require leak checks without exemptions', () => {
    const suite = 'tests/shared-channel-recovery.test.ts'
    for (const [module, fn] of [['shared-recovery', 'readSharedRecoveryRequest'], ['reload-recovery', 'renderSharedRecovery']]) {
      expect(SOURCE_SURFACES.some(([re]) => re.test(`src/${module}.ts`))).toBe(true)
      for (const source of [`import { ${fn} as use } from '../src/${module}.ts'`, `const use = await import('../src/${module}.ts')`]) expect(touchReasonsOf(suite, source)).toHaveLength(1)
      expect(touchReasonsOf(suite, `import type { Any } from '../src/${module}.ts'`)).toEqual([])
    }
    expect(touchReasonsOf(suite, "import { RELOAD_SHARED_RECOVERY } from '../src/reload-recovery.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import { sharedRecoveryRequest as request } from './test-helpers/shared-channels.ts'")).toHaveLength(1)
    expect(callsAssertNoLeak(suite)).toBe(true); expect(suite in EXEMPT).toBe(false)
  })

  test('the test-only MCP route is a source surface: handlers and key rendering touch; constants and types alone do not; every consumer leak-checks', () => {
    const suite = 'tests/test-mcp-drop.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/test-mcp-drop.ts'))).toBe(true)
    for (const code of [
      "import { handleTestMcpDrop } from '../src/test-mcp-drop.ts'",
      "import { testMcpDropLine as line } from '../src/test-mcp-drop.ts'",
      "import * as drop from '../src/test-mcp-drop.ts'",
      "const drop = await import('../src/test-mcp-drop.ts')",
    ]) expect(touchReasonsOf(suite, code).some(reason => reason.includes('src/test-mcp-drop.ts'))).toBe(true)
    for (const code of [
      "import { TEST_MCP_DROP_ROUTE, TEST_MCP_DROP_START_LINE } from '../src/test-mcp-drop.ts'",
      "import type { TestMcpDropDeps } from '../src/test-mcp-drop.ts'",
      "import { type TestMcpDropDeps } from '../src/test-mcp-drop.ts'",
    ]) expect(touchReasonsOf(suite, code)).toEqual([])
    expect(touchReasons(suite).some(reason => reason.includes('src/test-mcp-drop.ts'))).toBe(true)
    const consumers = SUITES.filter(file => touchReasons(file).some(reason => reason.includes('src/test-mcp-drop.ts')))
    expect(consumers.length).toBeGreaterThan(0)
    expect(consumers.map(file => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(consumers.map(file => [file, true, false]))
  })

  // the conflict latch's lines and record carry text from agent-director's CONFLICT description.
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

  test('no suite is exempted for src/conflict-latch.ts', () => {
    const exemptForLatch = Object.keys(EXEMPT).filter(
      (file) => SUITES.includes(file) && touchReasons(file).some((r) => r.includes('src/conflict-latch.ts')),
    )
    expect(exemptForLatch).toEqual([])
  })

  // a kill outcome keeps the thrown agent-director error and its description raw, and its
  // rendering carries the described failure text to log lines and startup errors.
  test('src/checked-kill.ts is a source surface: its functions touch, its constants alone do not, and its suite leak-checks with no exemption', () => {
    const suite = 'tests/checked-kill.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/checked-kill.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { checkedKill } from '../src/checked-kill.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { describeKillOutcome as describe } from '../src/checked-kill.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { KILL_OUTCOME_KILLED, KILL_OUTCOME_NOT_KILLED } from '../src/checked-kill.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { KillOutcome } from '../src/checked-kill.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/checked-kill.ts'))).toBe(true)
    expect([callsAssertNoLeak(suite), suite in EXEMPT]).toEqual([true, false])
    const exemptForKill = Object.keys(EXEMPT).filter((file) => SUITES.includes(file) && touchReasons(file).some((r) => r.includes('src/checked-kill.ts')))
    expect(exemptForKill).toEqual([])
  })

  // each try's and each read's line carries the described agent-director failure, and the
  // alert decision keeps the kill-failure descriptions raw for the alert to redact.
  test('src/kill-retry.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/kill-retry.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/kill-retry.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { runKillRetry } from '../src/kill-retry.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { killRetryTryLine as line } from '../src/kill-retry.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { KILL_RETRY_TRIES, KILL_RETRY_SPACING_MS } from '../src/kill-retry.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { KillRetryResult } from '../src/kill-retry.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/kill-retry.ts'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/kill-retry.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // the alert's texts quote agent-director's kill-failure descriptions (redacted) in posts,
  // log lines and startup-errors entries.
  test('src/kill-failure-alert.ts is a source surface: its builders touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/kill-failure-alert.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/kill-failure-alert.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { killFailureAlertText } from '../src/kill-failure-alert.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { killFailureOrdinaryBody as body } from '../src/kill-failure-alert.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { KILL_FAILURE_VERSION_ORDINARY, PERSONA_KILL_FAILED_LABEL } from '../src/kill-failure-alert.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { KillFailureAlertContent } from '../src/kill-failure-alert.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/kill-failure-alert.ts'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/kill-failure-alert.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // each step's line carries the described agent-director failure (a failed get, a kill's
  // outcome), and a kill's result keeps the kill-failure descriptions raw for the alert to redact.
  test('notice-correction functions touch the secrecy surface; constants and type-only imports do not', () => {
    const suite = 'tests/notice-correction-user.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/notice-correction.ts'))).toBe(true)
    for (const code of [
      "import { correctPostedNotice } from '../src/notice-correction.ts'",
      "import { correctPostedNotice as correct } from '../src/notice-correction.ts'",
      "import * as correction from '../src/notice-correction.ts'",
      "const correction = await import('../src/notice-correction.ts')",
    ]) expect(touchReasonsOf(suite, code).some(reason => reason.includes('src/notice-correction.ts'))).toBe(true)
    for (const code of [
      "import { NOTICE_CORRECTION_TIMEOUT_MS } from '../src/notice-correction.ts'",
      "import type { NoticeCorrectionOutcome } from '../src/notice-correction.ts'",
      "import { type NoticeCorrectionDeps } from '../src/notice-correction.ts'",
      "import type * as Correction from '../src/notice-correction.ts'",
    ]) expect(touchReasonsOf(suite, code)).toEqual([])
  })

  test('src/live-row-sequence.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/live-row-sequence.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/live-row-sequence.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { runLiveRowSequence } from '../src/live-row-sequence.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { liveRowSequenceGetLine as line } from '../src/live-row-sequence.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { LIVE_ROW_SEQUENCE_MAX_RUNS, LIVE_ROW_OUTCOME_ESCALATED } from '../src/live-row-sequence.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { LiveRowSequenceOutcome } from '../src/live-row-sequence.ts'")).toEqual([])
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/live-row-sequence.ts')))
    expect(touching.length).toBeGreaterThan(0)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
    expect([callsAssertNoLeak(suite), suite in EXEMPT]).toEqual([true, false])
  })

  // a round's CONFLICT and unusable-name answers reach a log line and a
  // `persona-teardown-notice` entry (described, redacted), and its answers keep the thrown errors raw.
  test('src/old-life-wait.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/some-old-life-wait-user.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/old-life-wait.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { decideOldLifeWaitEnd } from '../src/old-life-wait.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { oldLifeWaitRefusalNoticeText as notice } from '../src/old-life-wait.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { OLD_LIFE_WAIT_END_KILL_FAILED, OLD_LIFE_WAIT_LOG_PREFIX } from '../src/old-life-wait.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { OldLifeWaitEndDecision } from '../src/old-life-wait.ts'")).toEqual([])
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/old-life-wait.ts')))
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // the hold posts its operator alert and logs the versions agent-director reported, and
  // its reactions log a failing step's error, described.
  test('src/invalid-flags-hold.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/ad-version-gate.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/invalid-flags-hold.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { createInvalidFlagsHold } from '../src/invalid-flags-hold.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { invalidFlagsHoldSetLine as line } from '../src/invalid-flags-hold.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { INVALID_FLAGS_HOLD_ALERT_TEXT, INVALID_FLAGS_HOLD_END_FORGOTTEN } from '../src/invalid-flags-hold.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { InvalidFlagsHold } from '../src/invalid-flags-hold.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/invalid-flags-hold.ts'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/invalid-flags-hold.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // a read-pane failure outcome carries the described agent-director failure to its callers' log lines.
  test('src/pane-read.ts is a source surface: its mapper touches, its constants alone do not, and its suite leak-checks with no exemption', () => {
    const suite = 'tests/pane-read.test.ts'
    expect(touchReasonsOf(suite, "import { paneReadFailureOf } from '../src/pane-read.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { FULL_PANE_READ_LINES, PANE_READ_GONE } from '../src/pane-read.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/pane-read.ts'))).toBe(true)
    expect([callsAssertNoLeak(suite), suite in EXEMPT]).toEqual([true, false])
  })

  // the pending-row rule's round, gate and failure lines quote the lap's and the run's
  // agent-director outcomes (described, redacted), and a lap Enter's latching outcome keeps the thrown error raw.
  test('src/pending-row.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/pending-row.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/pending-row.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { createPendingRowRule } from '../src/pending-row.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { pendingRowRuleRoundLine as line } from '../src/pending-row.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import * as rule from '../src/pending-row.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { PENDING_ROW_RULE_HELD, PENDING_ROW_LAP_ENTER_CONFLICT } from '../src/pending-row.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { PendingRowRuleAnswer } from '../src/pending-row.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/pending-row.ts') && r.includes('the pending-row rule'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/pending-row.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // a precheck failure line, and a teardown verdict or outcome, carries the described
  // agent-director failure to the terminal and clean_restart.log.
  test('src/cli-teardown.ts is a source surface: its verdict and line builders touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/cli-teardown.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/cli-teardown.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { precheckVerdictOf } from '../src/cli-teardown.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { precheckFailureLine as line } from '../src/cli-teardown.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { pauseVerdictOf, stateReadVerdictOf, teardownErrorReportOf } from '../src/cli-teardown.ts'").length).toBe(3)
    expect(touchReasonsOf(suite, "import { PRECHECK_TRIES, PRECHECK_TRY_SPACING_MS } from '../src/cli-teardown.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { PrecheckVerdict } from '../src/cli-teardown.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/cli-teardown.ts'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/cli-teardown.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  // the stored-choice store's record holds each persona's declaration (a credentials file's path,
  // never its content), and its read and write failures reach log lines.
  test('src/channel-delivery.ts is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', () => {
    const suite = 'tests/channel-delivery.test.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test('src/channel-delivery.ts'))).toBe(true)
    expect(touchReasonsOf(suite, "import { loadChannelDeliveryStore } from '../src/channel-delivery.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { channelDeliveryUnreadableLine as line } from '../src/channel-delivery.ts'").length).toBe(1)
    expect(touchReasonsOf(suite, "import { CHANNEL_DELIVERY_FILE_NAME, SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { ChannelDeliveryStore } from '../src/channel-delivery.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import { type ChannelDeliveryRecord } from '../src/channel-delivery.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type * as ChannelDeliveryModule from '../src/channel-delivery.ts'")).toEqual([])
    expect(touchReasons(suite).some((r) => r.includes('src/channel-delivery.ts') && r.includes('the stored-choice store'))).toBe(true)
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('src/channel-delivery.ts')))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
    // The suite with its assertNoLeak calls taken out (its import kept) still touches the module and fails the rule.
    const withoutCalls = codeOf(suite).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
    expect(touchReasonsOf(suite, withoutCalls).some((r) => r.includes('src/channel-delivery.ts'))).toBe(true)
    expect(callsAssertNoLeak(suite, withoutCalls)).toBe(false)
  })

  // Authenticated observations and operator reporting can carry failure text.
  test.each([
    ['src/thread-memory.ts', 'classifyMetadataFailure', 'THREAD_MEMORY_LOOKUP_METHODS', 'MetadataFailure', 'tests/thread-memory.test.ts'],
    ['src/own-post-lookup.ts', 'createOwnPostLookups', 'OWN_POST_LOOKUP_PAGE_LIMIT', 'OwnPostLookupsDeps', 'tests/own-post-lookup.test.ts'],
    ['src/thread-memory-reports.ts', 'createThreadMemoryReporting', 'THREAD_MEMORY_DIAGNOSTIC_CLASSES', 'ThreadMemoryLoss', 'tests/thread-memory-reports.test.ts'],
    ['src/shared-state-reports.ts', 'createSharedStateReporting', 'SHARED_STATE_DIAGNOSTIC_CLASSES', 'SharedStateReportScope', 'tests/shared-state-reports.test.ts'],
    ['src/own-post.ts', 'completionFiles', 'SLACK_FILE_ID_RE', 'CompletedFile', 'tests/own-post.test.ts'],
    ['src/file-upload-observation.ts', 'observeFileCompletions', undefined, 'FileCompletionListener', 'tests/registry.test.ts'],
  ] as const)('%s is a source surface: its functions touch, its constants and types alone do not, and every suite that touches it leak-checks with no exemption', (module, fn, constant, type, suite) => {
    expect(SOURCE_FILES).toContain(module)
    expect(SOURCE_SURFACES.filter(([re]) => re.test(module))).toHaveLength(1)
    expect(touchReasonsOf(suite, `import { ${fn} } from '../${module}'`)).toHaveLength(1)
    expect(touchReasonsOf(suite, `import { ${fn} as used } from '../${module}'`)).toHaveLength(1)
    if (constant !== undefined) expect(touchReasonsOf(suite, `import { ${constant} } from '../${module}'`)).toEqual([])
    expect(touchReasonsOf(suite, `import type { ${type} } from '../${module}'`)).toEqual([])
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes(module)))
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  test('the state stores/reporters, own-post and file-completion modules are touched today, and a suite without its assertNoLeak calls fails the rule', () => {
    const touched = (module: string) => SUITES.filter((file) => touchReasons(file).some((r) => r.includes(module)))
    for (const [suite, module] of [
      ['tests/thread-memory.test.ts', 'src/thread-memory.ts'],
      ['tests/own-post-lookup.test.ts', 'src/own-post-lookup.ts'],
      ['tests/thread-memory-reports.test.ts', 'src/thread-memory-reports.ts'],
      ['tests/shared-state-reports.test.ts', 'src/shared-state-reports.ts'],
      ['tests/shared-state-reports-integration.test.ts', 'src/shared-state-reports.ts'],
      ['tests/own-post.test.ts', 'src/own-post.ts'],
      ['tests/registry.test.ts', 'src/file-upload-observation.ts'],
    ] as const) {
      expect([module, touched(module)]).toEqual([module, expect.arrayContaining([suite])])
      const withoutCalls = codeOf(suite).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
      expect(touchReasonsOf(suite, withoutCalls).some((r) => r.includes(module))).toBe(true)
      expect(callsAssertNoLeak(suite, withoutCalls)).toBe(false)
    }
  })

  test('lookup helpers and runner imports require leak assertions in either recovery suite without exemptions', () => {
    const reloadFactory = 'makeReloadHarness'
    for (const suite of ['tests/own-post-lookup.test.ts', 'tests/own-post-recovery.test.ts']) {
      expect(suite in EXEMPT).toBe(false)
      for (const name of ['ownPostLookupRange', 'ownPostLookupRequest', 'readOwnPostLookupPage', 'ownUploadShare', 'uploadShareTs',
        'classifyOwnPostLookupFailure', 'judgeOwnPostLookup', 'createOwnPostLookups']) {
        const code = `import { ${name} as used } from '../src/own-post-lookup.ts'`
        expect(touchReasonsOf(suite, code)).toHaveLength(1)
        expect(callsAssertNoLeak(suite, code)).toBe(false)
      }
      for (const code of [
        "import * as lookup from '../src/own-post-lookup.ts'",
        "const lookup = await import('../src/own-post-lookup.ts')",
        // The runner's ownMessage reads the persona's own Events.
        "import { createOwnPostLookups } from '../src/own-post-lookup.ts'\ncreateOwnPostLookups(deps).ownMessage(key, event, identity)",
        `import { ${reloadFactory} } from './test-helpers/reload-harness.ts'`,
      ]) {
        expect(touchReasonsOf(suite, code)).toHaveLength(1)
        expect(callsAssertNoLeak(suite, code)).toBe(false)
      }
      for (const code of [
        "import { OWN_POST_LOOKUP_PAGE_LIMIT } from '../src/own-post-lookup.ts'",
        "import type * as lookup from '../src/own-post-lookup.ts'",
        "import { type OwnPostLookups, type OwnPostLookupEvent, type OwnUploadShare } from '../src/own-post-lookup.ts'",
      ]) expect(touchReasonsOf(suite, code)).toEqual([])
    }
    // The global consumer scan above checks actual suites, including the reload
    // harness consumer when it lands, without requiring an unused direct import.
  })

  test('the own-post and upload-thread suites touch their modules today and leak-check them themselves, with no exemption', () => {
    for (const [suite, surface] of [
      ['tests/own-post.test.ts', 'src/own-post.ts'],
      ['tests/own-post-lookup.test.ts', 'src/own-post-lookup.ts'],
      ['tests/own-post-recovery.test.ts', 'makeReloadHarness'],
      ['tests/registry.test.ts', 'src/own-post.ts'],
    ] as const) {
      expect([suite, touchReasons(suite).some((r) => r.includes(surface)), callsAssertNoLeak(suite), suite in EXEMPT]).toEqual([suite, true, true, false])
    }
  })

  test('Thread Memory report builders and configuration helpers require leak checks without treating record-only fixtures as touching', () => {
    const suite = 'tests/thread-memory-reports.test.ts'
    for (const source of [
      "import { buildThreadMemoryNotSavedNotice as notice } from '../src/thread-memory-reports.ts'",
      "import * as reports from '../src/thread-memory-reports.ts'",
      "const reports = await import('../src/thread-memory-reports.ts')",
    ]) expect(touchReasonsOf(suite, source)).toHaveLength(1)
    const helper = 'tests/test-helpers/thread-memory.ts'
    for (const fn of ['threadConfig', 'makeThreadMemoryHarness', 'makeThreadMembershipHarness']) {
      expect(touchReasonsOf(suite, `import { ${fn} as fixture } from './test-helpers/thread-memory.ts'`)).toHaveLength(1)
      const touching = SUITES.filter(file => touchReasons(file).some(reason => reason.startsWith(`imports ${fn} from ${helper}:`)))
      expect(touching.length).toBeGreaterThan(0)
      expect(touching.map(file => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map(file => [file, true, false]))
      for (const file of touching) {
        const withoutCalls = codeOf(file).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
        expect(touchReasonsOf(file, withoutCalls).some(reason => reason.includes(helper))).toBe(true)
        expect(callsAssertNoLeak(file, withoutCalls)).toBe(false)
      }
    }
    for (const imported of ['threadPath', 'threadJoin', 'THREAD_PERSONAS', 'type ThreadMemoryHarness']) {
      expect(touchReasonsOf(suite, `import { ${imported} } from './test-helpers/thread-memory.ts'`)).toEqual([])
    }
  })

  test("the Slack stub server's startSlackStub touches, its control parser alone does not, and every suite that starts it leak-checks with no exemption", () => {
    const helper = 'tests/integration/fixtures/slack-stub-server.ts', suite = 'tests/real-ai-classifier-stop.test.ts'
    expect(touchReasonsOf(suite, "import { startSlackStub } from './integration/fixtures/slack-stub-server.ts'")).toEqual([
      `imports startSlackStub from ${helper}: ${HELPER_SURFACES[helper]!.startSlackStub}`,
    ])
    expect(touchReasonsOf(suite, "import { parseControl } from './integration/fixtures/slack-stub-server.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { StubControl } from './integration/fixtures/slack-stub-server.ts'")).toEqual([])
    const touching = SUITES.filter((file) => touchReasons(file).some((r) => r.includes(helper)))
    expect(touching).toContain(suite)
    expect(touching.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map((file) => [file, true, false]))
  })

  test("the Slack stub's marker-planting rejection factories touch, its HTTP rejection alone does not, and every suite that imports them leak-checks with no exemption", () => {
    const helper = 'tests/test-helpers/slack-stub.ts', suite = 'tests/thread-memory.test.ts'
    for (const factory of ['slackPlatformError', 'slackRateLimited']) {
      expect(touchReasonsOf(suite, `import { ${factory} as reject } from './test-helpers/slack-stub.ts'`)).toEqual([`imports ${factory} from ${helper}: ${HELPER_SURFACES[helper]![factory]}`])
    }
    expect(touchReasonsOf(suite, "import { slackHttpError } from './test-helpers/slack-stub.ts'")).toEqual([])
    const importing = SUITES.filter((file) => touchReasons(file).some((r) => /^imports slack(?:PlatformError|RateLimited) from tests\/test-helpers\/slack-stub\.ts:/.test(r)))
    expect(importing).toContain(suite)
    expect(importing.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(importing.map((file) => [file, true, false]))
  })

  test('every helper surface names a module that exists and an export it has (none stale)', async () => {
    const failures: string[] = []
    for (const [module, names] of Object.entries(HELPER_SURFACES)) {
      if (!existsSync(join(ROOT, module))) { failures.push(`${module}: stale helper surface: no such file`); continue }
      const exported = await import(join(ROOT, module)) as Record<string, unknown>
      for (const name of Object.keys(names)) if (!(name in exported)) failures.push(`${module} ${name}: stale helper surface: not exported`)
    }
    expect(checked(failures, 'stale helper surfaces')).toEqual([])
  })

  test('attempt evidence functions require leakage checks, including aliased imports and omission mutants, without exemptions', () => {
    const suite = 'tests/channel-delivery.test.ts', module = 'src/channel-delivery-attempt.ts'
    expect(SOURCE_SURFACES.some(([re]) => re.test(module))).toBe(true)
    for (const name of ['botAttemptBinding', 'botAttemptResult', 'validateBotAttempts']) {
      expect(touchReasonsOf(suite, `import { ${name} as used } from '../${module}'`)).toHaveLength(1)
    }
    expect(touchReasonsOf(suite, `import type { BotAttemptResult } from '../${module}'`)).toEqual([])
    const touching = SUITES.filter(file => touchReasons(file).some(reason => reason.includes(module)))
    expect(touching).toContain(suite)
    expect(touching.map(file => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(touching.map(file => [file, true, false]))
    const withoutCalls = codeOf(suite).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
    expect(callsAssertNoLeak(suite, withoutCalls)).toBe(false)
    expect(touchReasonsOf(suite, withoutCalls).some(reason => reason.includes(module))).toBe(true)
  })

  // the stored-choice file the helper writes holds persona declarations.
  test("the stored-choice helper's writeChannelDeliveryRecord touches, its other exports do not, and every suite that imports it leak-checks with no exemption", () => {
    const suite = 'tests/channel-delivery.test.ts'
    expect(touchReasonsOf(suite, "import { writeChannelDeliveryRecord as seed } from './test-helpers/channel-delivery.ts'")).toEqual([
      'imports writeChannelDeliveryRecord from tests/test-helpers/channel-delivery.ts: writes a stored-choice file holding persona declarations',
    ])
    expect(touchReasonsOf(suite, "import { declarationOf, readChannelDeliveryRecord, SAMPLE_SET_AT } from './test-helpers/channel-delivery.ts'")).toEqual([])
    const importing = SUITES.filter((file) => touchReasons(file).some((r) => r.includes('tests/test-helpers/channel-delivery.ts')))
    expect(importing).toContain('tests/cli.test.ts')
    expect(importing.map((file) => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(importing.map((file) => [file, true, false]))
  })

  test("the upgrade generator's config builders and writers touch, its readers and constants do not, and every suite that imports them leak-checks with no exemption", () => {
    const suite = 'tests/shared-channel-upgrade-fixtures.test.ts', helper = 'tests/test-helpers/shared-channel-upgrade.ts'
    for (const name of Object.keys(HELPER_SURFACES[helper]!)) {
      expect(touchReasonsOf(suite, `import { ${name} as used } from './test-helpers/shared-channel-upgrade.ts'`)).toEqual([`imports ${name} from ${helper}: ${HELPER_SURFACES[helper]![name]}`])
    }
    expect(touchReasonsOf(suite, "import { fillHome, listFixtureFiles, readUpgradeManifest, UPGRADE_FIXTURE_DIR } from './test-helpers/shared-channel-upgrade.ts'")).toEqual([])
    expect(touchReasonsOf(suite, "import type { MaterializeOptions } from './test-helpers/shared-channel-upgrade.ts'")).toEqual([])
    const importing = SUITES.filter(file => touchReasons(file).some(reason => reason.includes(helper)))
    expect(importing).toContain(suite)
    expect(importing.map(file => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(importing.map(file => [file, true, false]))
    const withoutCalls = codeOf(suite).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
    expect(callsAssertNoLeak(suite, withoutCalls)).toBe(false)
    expect(touchReasonsOf(suite, withoutCalls).some(reason => reason.includes(helper))).toBe(true)
  })

  test.each(['makeFakeCodexHome', 'makeFakeCodexLogin'])('%s consumers must leak-check without an exemption', helper => {
    const suite = 'tests/ci-run-admission.test.ts'
    expect(touchReasonsOf(suite, `import { ${helper} as fixture } from './test-helpers/ci-run.ts'`)).toHaveLength(1)
    expect(touchReasonsOf(suite, `import type { ${helper} } from './test-helpers/ci-run.ts'`)).toEqual([])
    const importing = SUITES.filter(file => touchReasons(file).some(reason => reason.startsWith(`imports ${helper} from tests/test-helpers/ci-run.ts:`)))
    expect(importing).toContain(suite)
    expect(importing.map(file => [file, callsAssertNoLeak(file), file in EXEMPT])).toEqual(importing.map(file => [file, true, false]))
  })

  test('Codex key/model readers and AI/gate control suites retain leak checks without exemptions', () => {
    const suite = 'tests/codex-config-keys.test.ts'
    for (const symbol of ['scanCodexConfigKeys', 'readCodexModel', 'checkCodexScratchConfigKeys']) {
      expect(touchReasonsOf(suite, `import { ${symbol} as read } from '../src/codex-config-keys.ts'`)).toHaveLength(1)
      expect(touchReasonsOf(suite, `import type { ${symbol} } from '../src/codex-config-keys.ts'`)).toEqual([])
    }
    for (const file of [suite, 'tests/codex-delivery-controls.test.ts', 'tests/codex-ai-controls.test.ts', 'tests/codex-gate-controls.test.ts']) {
      expect(SUITES).toContain(file)
      expect(callsAssertNoLeak(file)).toBe(true)
      expect(file in EXEMPT).toBe(false)
      const withoutCalls = codeOf(file).replace(/(?<![\w.$])assertNoLeak\s*\(/g, 'void (')
      expect(callsAssertNoLeak(file, withoutCalls)).toBe(false)
    }
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

describe('no token literal under tests/ (TEST-1)', () => {
  const tokenLike = new RegExp(TOKEN_LIKE.source)
  const sentinel = LEAK_SENTINEL.toLowerCase()

  test('the scan covers every file under tests/, this file and the credentials helper included', () => {
    const scanned = TEST_FILES.map(repoPath)
    expect(scanned).toEqual(
      expect.arrayContaining([
        'tests/secrecy-audit.test.ts',
        CREDENTIALS_HELPER,
        ...NAMED_LEGS,
        'tests/channel-delivery.test.ts',
        'tests/test-helpers/channel-delivery.ts',
      ]),
    )
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
// Rule 5: a caught error's text reaches a log line under src/ only redacted ( section 0, decision B1)
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
  'reviewRecoveredBringUpFailedLine',
  'reviewRecoveredLifecycleFailedLine',
  'threadMemoryLoadAtApplyFailedLine',
  'describeLogMessage',
  'describeSlackCallFailure',
  'describeAgentDirectorFailure',
  // The reported-name describers (src/ad-error-class.ts): a safe reported name and the message only through renderLogMessageText.
  'describeReportedAdFailure',
  'describeAdFailureForLog',
  // describeThrownValue without the stack's frames (src/persona-connection-errors.ts).
  'describeThrownValueWithoutStack',
  'describeCliFailure',
  'describeRefreshFailure',
  'redactSlackLogText',
  'isSafeIdentifier',
  'slackPlatformReason',
  'errnoSuffix',
  // Returns only one of CSCB's fixed launch-timeout form constants or `undefined`, never error text.
  'launchTimeoutFormOf',
]

const SAFE_CALL = new RegExp(`(?<![\\w$.])(?:${SAFE_DESCRIBERS.join('|')})\\s*\\(`)

/** Names that hold a caught error in any file: `e`, `err` or `error` (with a digit), and `<word>Err` (`getErr`, `killErr`). */
const ERROR_NAME_SOURCE = '(?:e|err|error)\\d*|[a-z][\\w$]*Err\\d*'
const ERROR_NAME = new RegExp(`^(?:${ERROR_NAME_SOURCE})$`)

/**
 * `text` with every safe describer call (its arguments included) replaced by
 * an empty string literal: a placeholder no name can match, so a local that
 * happens to share a placeholder's name never taints every described call.
 */
function withoutSafeCalls(text: string): string {
  let out = text
  for (let m = SAFE_CALL.exec(out); m; m = SAFE_CALL.exec(out)) {
    const [, end] = balancedAfter(out, m.index, '(', ')')
    out = `${out.slice(0, m.index)}""${out.slice(end + 1)}`
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
    anchor: "'[slack] Fatal:'",
    reason: "the CLI entry point's last-resort catch-all for an unexpected throw from start, stop or clean_restart",
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
]

describe("a caught error's text reaches a log line under src/ only redacted (section 0, decision B1)", () => {
  const findings = SOURCE_FILES.flatMap((file) => rawErrorFindings(codeOf(file)).map((finding) => ({ file, ...finding })))
  const allows = (entry: (typeof RAW_ERROR_ALLOWED)[number], f: (typeof findings)[number]): boolean =>
    entry.file === f.file && f.call.includes(entry.anchor)

  test('the scan reads every file under src/ and finds the log calls of the Slack and agent-director modules (it is not vacuous)', () => {
    expect(SOURCE_FILES).toEqual(
      expect.arrayContaining(['src/session-manager.ts', 'src/restart.ts', 'src/persona-connections.ts', 'src/cli.ts', 'src/server.ts', 'src/channel-delivery.ts']),
    )
    const counts = ['src/session-manager.ts', 'src/restart.ts', 'src/permission-poller.ts', 'src/persona-lifecycle.ts', 'src/persona-episodes.ts', 'src/reload.ts'].map(
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
    ['recovery bring-up describer', 'try { f() } catch (err) { log(reviewRecoveredBringUpFailedLine(err)) }', []],
    ['recovery activation describer', 'try { f() } catch (err) { log(reviewRecoveredLifecycleFailedLine(err)) }', []],
    ['Thread Memory apply-load describer', 'try { f() } catch (err) { log(threadMemoryLoadAtApplyFailedLine(persona, err)) }', []],
    ['the describer', 'try { f() } catch (err) { log(`x: ${describeThrownValue(err)}`) }', []],
    ['a redacted errDescription', 'log(`x: ${redactSlackLogText(e.errDescription)}`)', []],
    ['a checked errName', 'log(`x: ${isSafeIdentifier(e.errName) ? e.errName : describeThrownValue(e)}`)', []],
    ['a describing wrapper', 'function logFailure(what, err) { log(`${what}: ${describeThrownValue(err)}`) }\ntry { f() } catch (err) { logFailure("x", err) }', []],
    // Decision B1: a message is kept, but only redacted (a bare one is the "a caught error's message" row above).
    ['a redacted err.message', 'try { f() } catch (err) { log(`x: ${redactSlackLogText(err.message)}`) }', []],
    ['a message through describeLogMessage', 'try { f() } catch (err) { console.error(`x: ${describeLogMessage(err.message)}`) }', []],
    ['a bare err.message beside a redacted one', 'try { f() } catch (err) { log(`x: ${redactSlackLogText(err.message)} (${err.message})`) }', ["reads a caught error's message or stack"]],
    ['an agent-director describer as a startup-error cause', "try { f() } catch (err) { recordStartupError('c', `m: ${describeAgentDirectorFailure(err)}`, describeAgentDirectorFailure(err)) }", []],
    ['the reported-name describer', 'try { f() } catch (err) { log(`x: ${describeReportedAdFailure(err)}`) }', []],
    ['the log describer of an agent-director failure', 'try { f() } catch (err) { log(`x: ${describeAdFailureForLog(err)}`) }', []],
    ['the stack-free describer', 'try { f() } catch (err) { log(`x: ${describeThrownValueWithoutStack(err)}`) }', []],
    [
      'a tainted local named like a described call does not taint the described calls',
      'try { f() } catch (err) { const described = String(err); log(`x: ${described}`); log(`y: ${describeThrownValue(err)}`) }',
      ['interpolates a caught error'],
    ],
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

describe('b.c13 first tmux create provenance', () => {
  const scenario = readFileSync(join(ROOT, 'tests/integration/lib/scenario.sh'), 'utf8')
  const test21 = readFileSync(join(ROOT, 'tests/integration/test-21-fmk-teardown.sh'), 'utf8')
  const socket = '/scratch/scenario/tmux/default'
  const declaration = (name: string, source = scenario) => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
    if (!match) throw new Error(`Missing fixture declaration ${name}`)
    return match[0]
  }
  const helpers = [
    '_scenario_to_us', '_scenario_record_load', '_scenario_role_at', '_scenario_split_line',
    '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id',
    '_scenario_shim_diagnostic', '_scenario_read_log', '_scenario_query_prep',
    '_scenario_cscb_tmux_scan', 'cscb_tmux_count',
  ].map(name => declaration(name)).join('\n')
  const line = (time: string, pid: number, ppid: number, parent: string, words: string) =>
    `call\t${time}\t${pid}\t${ppid}\t${parent}\t${words}\n`
  const ad = ({ time = '100.100000', pid = 100, ppid = 42, verb = 'spawn', id = 'cscb_alpha' } = {}) =>
    line(time, pid, ppid, '/scratch/bun /scratch/src/server.ts', `${verb} --instance-id ${id}`)
  const tmux = ({ time = '100.200000', ppid = 100, parent = '/scratch/agent-director.real spawn --instance-id cscb_alpha',
    target = socket, command = 'new-session -d -s cscb_alpha' } = {}) =>
    line(time, 101, ppid, parent, `-u -S ${target} ${command}`)
  interface Evidence { ad?: string; tmux?: string; record?: string }
  // Only extracted declarations run, against synthetic shim logs and a fake
  // process record. No integration harness, AD, tmux or real process probe runs.
  function run(evidence: Evidence = {}, directCounter = false) {
    const root = mkdtempSync(join(tmpdir(), 'cscb-first-create-'))
    try {
      writeFileSync(join(root, 'ad'), evidence.ad ?? ad())
      writeFileSync(join(root, 'tmux'), evidence.tmux ?? tmux())
      writeFileSync(join(root, 'record'), evidence.record ?? 'proc\tserver\t42\t99\t99.000000\n')
      const script = `set -euo pipefail
SCENARIO_FMK=1
SCENARIO_CSCB_RECORD="$HOME/record"
_SCENARIO_REAL_CSCB_RECORD="$HOME/unused-original"
SCENARIO_AD_SHIM_LOG="$HOME/ad"
SCENARIO_TMUX_SHIM_LOG="$HOME/tmux"
A_ID=cscb_alpha B_ID=cscb_bravo
fail() { printf '%s\\n' "$*" >&2; exit 1; }
require_ci_image() { :; }
require_scenario_home() { :; }
_scenario_cscb_after() { fail 'unexpected real process probe'; }
${helpers}
${declaration('t21_assert_first_tmux_create', test21)}
${directCounter ? 'cscb_tmux_count new-session' : ''}
t21_assert_first_tmux_create '${socket}'
`
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
        env: hostSafeChildEnv(root, { tools: [] }), encoding: 'utf8', timeout: 5_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  test('accepts the CSCB server -> AD -> tmux create that the direct-parent counter counts as zero', () => {
    expect(run({}, true)).toEqual({ status: 0, stdout: '0\n', stderr: '' })
  })
  test('accepts a start-server create through the same AD-owned chain', () => {
    expect(run({ tmux: tmux({ command: 'start-server \\; source-file -' }) })).toEqual({ status: 0, stdout: '', stderr: '' })
  })
  test('accepts either of the first two persona spawns', () => {
    expect(run({ ad: ad({ id: 'cscb_bravo' }) })).toEqual({ status: 0, stdout: '', stderr: '' })
  })
  test.each<[string, Evidence, string]>([
    ['empty tmux log', { tmux: '' }, 'no scenario-socket tmux create'],
    ['empty AD log', { ad: '' }, 'no preceding CSCB-server persona spawn'],
    ['harness-owned AD', { ad: ad({ ppid: 84 }) }, 'no preceding CSCB-server persona spawn'],
    ['unrelated persona', { ad: ad({ id: 'cscb_foreign' }) }, 'no preceding CSCB-server persona spawn'],
    ['non-launch AD verb', { ad: ad({ verb: 'get' }) }, 'no preceding CSCB-server persona spawn'],
    ['AD call after create', { ad: ad({ time: '100.300000' }) }, 'no preceding CSCB-server persona spawn'],
    ['different AD PID', { ad: ad({ pid: 102 }) }, 'no preceding CSCB-server persona spawn'],
    ['expired CSCB PID', { record: 'proc\tserver\t42\t99\t99.000000\ngone\t42\t99\t100.000000\n' }, 'no preceding CSCB-server persona spawn'],
    ['direct CSCB tmux', { tmux: tmux({ ppid: 42, parent: '/scratch/bun /scratch/src/server.ts' }) }, 'no preceding CSCB-server persona spawn'],
    ['spoofed parent executable', { tmux: tmux({ parent: '/scratch/other' }) }, 'not made by agent-director'],
    ['other socket', { tmux: tmux({ target: '/foreign/socket' }) }, 'no scenario-socket tmux create'],
    ['only a read call', { tmux: tmux({ command: 'list-sessions' }) }, 'no scenario-socket tmux create'],
    ['reused AD PID now owned by harness', { ad: ad() + ad({ time: '100.150000', ppid: 84 }) }, 'no preceding CSCB-server persona spawn'],
    ['foreign first create followed by valid create', {
      ad: ad({ ppid: 84 }) + ad({ time: '100.250000', pid: 200 }),
      tmux: tmux() + tmux({ time: '100.300000', ppid: 200 }),
    }, 'no preceding CSCB-server persona spawn'],
  ])('rejects %s', (_label, evidence, message) => {
    const result = run(evidence)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
  test('the boundary retains the unseeded-socket and complete names-only environment assertions', () => {
    const boundary = declaration('t21_precheck_legs', test21).split('# The harness respawns')[0]!
    expect(boundary).toContain('[[ ! -S "${socket}" ]]')
    expect(boundary).toContain('[[ ! -s "${SCENARIO_TMUX_SHIM_LOG}" ]]')
    expect(boundary).toContain('t21_assert_first_tmux_create "${socket}"')
    expect(boundary).toContain('show-environment -g | cut -d= -f1')
    expect(boundary).toContain("'^SLACK_.*(TOKEN|SECRET)$|^_CLI_DAEMON_CHILD$'")
    expect(boundary).toContain('grep -qxF GH_TOKEN')
  })
})
