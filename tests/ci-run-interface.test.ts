/**
 * tests/ci-run-interface.test.ts — The sharded `/ci` runner's interface
 * (`scripts/ci-run.ts`, b.uqm SR-21.6).
 *
 * E1 region: the runner's module properties (b.uqm SR-1.3); command lines,
 * argument rules and run kinds (SR-2.1, SR-2.2, SR-2.5; the argument half of
 * PRD AC 15); fault forms, normalization, de-duplication and the faults that
 * are bad arguments (SR-2.4, the argument stage); canonical order (SR-3.3);
 * child process environments, the secret-credential set and the base-build
 * token lookup (SR-15.4, SR-15.1); and one pin case per runner constant
 * (SR-21.5).
 *
 * E2 region: validation stages 2–8 (SR-2.3, SR-2.6, SR-3.1, SR-3.2, SR-3.4,
 * SR-15.1), added by E2.
 *
 * Everything runs in process through the runner's exports and injected
 * dependencies: no child process, no docker, no `/proc` or cgroup read
 * (b.uqm SR-21.7). Spawns are answered by the spawn recorder and the fake
 * container interface (`tests/test-helpers/ci-run.ts`); credentials are built
 * with `fakeToken`; real script names come from the repository's
 * `tests/integration` listing, looked up by number. Only the constants block
 * types a runner constant's value; every other case imports it, except the
 * b.uqm SR-2.2 example message case, which types 1 and 6 as the SRD's example
 * line does.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import {
  ADMISSION_MARGIN_BYTES,
  BASE_BUILD_ALLOWANCE_MINUTES,
  BASE_DOCKERFILE_PATH,
  BUILD_ALLOWANCE_MINUTES,
  CANARY_FILE_NAME,
  CANARY_LENGTH,
  CAP_MARGIN_BYTES,
  CAP_ROUNDING_STEP_BYTES,
  CI_CPUS,
  CI_LABEL,
  CI_LABEL_VALUE,
  CI_LIVE_RUNNER_ALLOWANCE_BYTES,
  CI_REQUIRES_KEYWORD,
  CPUS_PER_SHARD,
  DEFAULT_ESTIMATE_SECONDS,
  DEFAULT_TEMP_DIR,
  DEPENDENCY_FINGERPRINT_FILE_NAME,
  DISK_CHECK_ALLOWANCE_BYTES,
  DISK_LINE_PERCENT,
  DOCKER_LOG_FILE_NAME,
  DOCKER_NO_SUCH_CONTAINER_TEXT,
  DOCKER_NO_SUCH_IMAGE_TEXT,
  DURATION_TABLE_PATH,
  FAIL_PREFIX,
  FAILURE_EXIT_STATUS,
  FAULT_LABEL,
  FAULT_LABEL_VALUES,
  FAULT_POLL_INTERVAL_MS,
  GH_AUTH_TOKEN_ARGV,
  GH_PERSONAL_CONFIG_SUBPATH,
  GIB_BYTES,
  INJECTED_FAILURE_TEXT,
  INSPECTION_REREAD_DELAY_MS,
  INTEGRATION_DIR_PATH,
  LIMIT_ADDEND_MINUTES,
  LIMIT_FACTOR,
  LIMIT_FLOOR_MINUTES,
  LOCK_WAIT_MS,
  MARKER_REFUSAL_EXIT_STATUS,
  MARKER_REFUSAL_LINE,
  MAX_SHARD_TIMEOUT_MINUTES,
  MAX_SHARDS,
  MEMORY_CEILING_PERCENT,
  MERGE_ALLOWANCE_MINUTES,
  MIN_SHARD_MEMORY_CAP_BYTES,
  NOT_RUN_PREFIX,
  NUMBER_FORM_PATTERN,
  OPTION_RANGE_MIN,
  OWNER_LABEL,
  PACKAGE_DIR_NAME,
  PACKAGE_SHA256_FILE_NAME,
  PRUNE_ALREADY_RUNNING_TEXT,
  PRUNE_RETRIES,
  PRUNE_RETRY_INTERVAL_MS,
  RAW_KEY_PREFIX,
  REAL_PASSWORD_FILE,
  REDACTION_PLACEHOLDER,
  REFUSAL_EXIT_STATUS,
  RESERVATION_FILE_SUFFIX,
  RESERVATION_FORMAT_VERSION,
  RESULT_FILE_NAME,
  RESULT_SECONDS_PATTERN,
  RESULT_WORD_DONE,
  RESULT_WORD_END,
  RESULT_WORD_FAIL,
  RESULT_WORD_NOTRUN,
  RESULT_WORD_PASS,
  RESULT_WORD_START,
  RESULTS_FILE_NAME,
  RESULTS_FORMAT_VERSION,
  RUN_DIR_MODE,
  RUN_DIR_PREFIX,
  RUN_ID_PATTERN,
  RUN_TAG_REPOSITORY,
  RUN_TAG_ROLES,
  RUNNER_LOG_FILE_NAME,
  RUNNER_PATH_SUFFIX,
  SAMPLE_INTERVAL_MS,
  SCRIPT_FILE_NAME_PATTERN,
  SCRIPT_LOG_SUFFIX,
  SECRET_MIN_LENGTH,
  SHA256_HEX_LENGTH,
  SHARD_DIR_PREFIX,
  SHARD_MEMORY_CAP_BYTES,
  SHARD_PIDS_LIMIT,
  SIGNAL_EXIT_STATUS_BASE,
  SLOW_FACTOR,
  SPAWN_FAILED_EXIT_STATUS,
  STATUS_FILE_NAME,
  STATUS_FORMAT_VERSION,
  STOP_LINE_OFFSET_BYTES,
  SUMMARY_FILE_NAME,
  TEST_DOCKERFILE_PATH,
  UNREADABLE_READING,
  USAGE_EXIT_STATUS,
  USAGE_PREFIX,
  VERDICT_FILE_NAME,
  WRITTEN_FILE_MODE,
  checkDockerAnswers,
  childEnvironment,
  copyOutOfContainer,
  createContainer,
  failTimeoutConflictReason,
  fileNameNumber,
  fileNameNumberForm,
  firstTokenLookupEnvironment,
  formatOwner,
  formatRunTag,
  faultText,
  injectedFaultsText,
  injectedVerdictPrefix,
  inspectContainerState,
  inspectImage,
  isCapSourceEligible,
  isDefaultFullRun,
  isFullRun,
  isGateEligible,
  isInjectedRun,
  isScriptFileName,
  isSelectiveRun,
  killContainer,
  listContainers,
  listImages,
  lookUpBaseBuildToken,
  malformedFaultReason,
  notAnOptionReason,
  notWholeNumberReason,
  optionEqualsFormReason,
  optionWithoutValueReason,
  outOfRangeReason,
  parseCiArguments,
  parseFault,
  pruneUntaggedImages,
  readContainerInspection,
  readContainerLogs,
  removeContainer,
  removeImageTag,
  repeatedOptionReason,
  runContainer,
  runKindOf,
  sameShardLeakReason,
  secretCredentialSet,
  sortCanonical,
  startDerivedImageBuild,
  startTestImageBuild,
  tagImage,
  unknownFaultReason,
  unknownOptionReason,
  type ArgumentFailure,
  type ChildEnvironmentSource,
  type DockerContext,
  type DockerSignalSender,
  type Fault,
  type Invocation,
  type Owner,
  type RunKind,
  type SpawnFn,
} from '../scripts/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import {
  buildTarArchive,
  buildWorktree,
  createFakeDocker,
  createSpawnRecorder,
  realScriptFileName,
  type FakeDockerOperationKind,
  type SpawnAnswer,
  type SpawnRecorder,
} from './test-helpers/ci-run.ts'
import { runtimeSpecifiers, stripComments } from './test-helpers/source-audit.ts'

/** The repository root: this file sits in `tests/`. */
const REPO_ROOT = join(import.meta.dir, '..')

/** The runner's source text, read when a case runs. */
function runnerSource(): string {
  return readFileSync(join(REPO_ROOT, RUNNER_PATH_SUFFIX), 'utf-8')
}

/** The repository's real file name for script number `n` (b.uqm SR-21.2). */
function scriptFile(n: number): string {
  return realScriptFileName(n)
}

/** The number form of the repository's real script number `n`, from its file name. */
function numberForm(n: number): string {
  const form = fileNameNumberForm(realScriptFileName(n))
  if (form === null) throw new Error(`no number form for script ${n}`)
  return form
}

/** The `/ci` arguments parsed, failing the case when they are refused. */
function parsedInvocation(args: readonly string[]): Invocation {
  const parsed = parseCiArguments(args)
  if (!parsed.ok) throw new Error(`refused: ${JSON.stringify(parsed.failures)}`)
  return parsed.invocation
}

/** The bad arguments of refused `/ci` arguments, failing the case when they are accepted. */
function refusedFailures(args: readonly string[]): readonly ArgumentFailure[] {
  const parsed = parseCiArguments(args)
  if (parsed.ok) throw new Error(`accepted: ${JSON.stringify(parsed.invocation)}`)
  return parsed.failures
}

// ===========================================================================
// E1 region
// ===========================================================================

// ---------------------------------------------------------------------------
// Module properties (b.uqm SR-1.3)
// ---------------------------------------------------------------------------

/** One top-level expression the audit flags: a call, a `new` or an `await` that would run at import. */
interface TopLevelFinding {
  readonly kind: 'call' | 'new' | 'await'
  readonly text: string
}

/** What the top-level audit found in one source text. */
interface TopLevelAudit {
  readonly findings: readonly TopLevelFinding[]
  /** How many `if (import.meta.main) { … }` entry blocks the top level holds. */
  readonly entryBlocks: number
  /** Whether the last top-level statement is an entry block. */
  readonly entryBlockLast: boolean
}

/** Whether a top-level statement is the main-module entry block, `if (import.meta.main) { … }` with no `else`. */
function isEntryBlock(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement !== undefined) return false
  const condition = statement.expression
  return (
    ts.isPropertyAccessExpression(condition) &&
    ts.isMetaProperty(condition.expression) &&
    condition.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    condition.name.text === 'main'
  )
}

function isStaticMember(member: ts.ClassElement): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
}

/**
 * The top-level audit of b.uqm SR-1.3: every call, `new` and `await` at the
 * top level of `source`, outside function bodies, class bodies (whose static
 * initializers and static blocks run at import, so they are audited) and the
 * main-module entry block. Parsed with the repository's `typescript`.
 */
function auditTopLevel(source: string): TopLevelAudit {
  const file = ts.createSourceFile('audit.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const findings: TopLevelFinding[] = []
  const flag = (kind: TopLevelFinding['kind'], node: ts.Node): void => {
    findings.push({ kind, text: node.getText(file).replace(/\s+/g, ' ').slice(0, 80) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) visit(clause)
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) ts.forEachChild(member.body, visit)
        else if (ts.isPropertyDeclaration(member) && isStaticMember(member) && member.initializer !== undefined) visit(member.initializer)
      }
      return
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) flag('call', node)
    else if (ts.isNewExpression(node)) flag('new', node)
    else if (ts.isAwaitExpression(node)) flag('await', node)
    ts.forEachChild(node, visit)
  }
  let entryBlocks = 0
  for (const statement of file.statements) {
    if (isEntryBlock(statement)) entryBlocks += 1
    else visit(statement)
  }
  const last = file.statements.at(-1)
  return { findings, entryBlocks, entryBlockLast: last !== undefined && isEntryBlock(last) }
}

/** The process-level listeners a fresh import must not add (docs/testing-guide.md, Process-Level Listeners). */
const PROCESS_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(PROCESS_EVENTS.map((event) => [event, process.listenerCount(event)]))
}

describe('module properties (b.uqm SR-1.3)', () => {
  test('the runner has no top-level call, new or await outside function and class bodies and its one entry block, which is last', () => {
    const audit = auditTopLevel(runnerSource())

    expect(audit.findings).toEqual([])
    expect(audit.entryBlocks).toBe(1)
    expect(audit.entryBlockLast).toBe(true)
  })

  test.each([
    ['a top-level call', 'setUp()\n', 'call'],
    ['a top-level new', "new Worker('w.ts')\n", 'new'],
    ['a top-level await', 'await ready\n', 'await'],
    ['a call inside a top-level initializer', 'export const handle = register(process)\n', 'call'],
    ['an immediately invoked function', '(() => undefined)()\n', 'call'],
    ['a static class field initializer', 'class Holder {\n  static instance = make()\n}\n', 'call'],
    ['a call in an if block that is not the entry block', "if (process.env.X) start()\n", 'call'],
  ] as const)('the audit flags %s', (_label, snippet, kind) => {
    expect(auditTopLevel(snippet).findings.map((finding) => finding.kind)).toContain(kind)
  })

  test('the audit passes calls, new and await inside function and class bodies and the entry block', () => {
    const snippet = [
      "import { readFileSync } from 'node:fs'",
      'export function run(): void { start(); new Map() }',
      'export const lazy = (): number => compute()',
      'export async function later(): Promise<void> { await work() }',
      'class Holder { value = make(); method(): void { go() } }',
      'if (import.meta.main) { main() }',
    ].join('\n')

    expect(auditTopLevel(snippet)).toEqual({ findings: [], entryBlocks: 1, entryBlockLast: true })
  })

  test('a fresh import adds no SIGINT, SIGTERM, SIGHUP, uncaughtException or unhandledRejection listener', async () => {
    const before = listenerCounts()

    await import(`../scripts/ci-run.ts?fresh=${crypto.randomUUID()}`)

    expect(listenerCounts()).toEqual(before)
  })

  test('the runtime loads are only node: built-ins, bun and bun:ffi, and nothing from src/ or ci-live/', () => {
    const specifiers = runtimeSpecifiers(stripComments(runnerSource()))
    const allowed = (specifier: string): boolean => specifier.startsWith('node:') || specifier === 'bun' || specifier === 'bun:ffi'

    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => !allowed(specifier))).toEqual([])
    expect(specifiers.filter((specifier) => /(^|\/)(src|ci-live)\//.test(specifier))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Arguments, command lines and run kinds (b.uqm SR-2.1, SR-2.2, SR-2.5)
// ---------------------------------------------------------------------------

/** The run-kind predicates of an invocation (b.uqm Terms, SR-2.5, SR-6.2). */
interface RunKinds {
  readonly defaultFull: boolean
  readonly full: boolean
  readonly selective: boolean
  readonly injected: boolean
  readonly gateEligible: boolean
  readonly capSourceEligible: boolean
  readonly kind: RunKind
}

function runKinds(invocation: Invocation): RunKinds {
  return {
    defaultFull: isDefaultFullRun(invocation),
    full: isFullRun(invocation),
    selective: isSelectiveRun(invocation),
    injected: isInjectedRun(invocation),
    gateEligible: isGateEligible(invocation),
    capSourceEligible: isCapSourceEligible(invocation),
    kind: runKindOf(invocation),
  }
}

/** What argument order must not change: the options, the set of SCRIPT arguments, the run kinds and the set of faults. */
function orderFreeView(invocation: Invocation): unknown {
  return {
    shards: invocation.shards,
    shardTimeoutMinutes: invocation.shardTimeoutMinutes,
    scripts: [...invocation.scripts].sort(),
    kinds: runKinds(invocation),
    faults: invocation.faults.map(faultText).sort(),
  }
}

/** Values just outside each option's range, from the runner's bounds. */
const BELOW_RANGE = String(OPTION_RANGE_MIN - 1)
const SHARDS_ABOVE_RANGE = String(MAX_SHARDS + 1)
const TIMEOUT_ABOVE_RANGE = String(MAX_SHARD_TIMEOUT_MINUTES + 1)

/**
 * The rules of b.uqm SR-2.2 a bad argument's reason must name. The two value
 * ranges are built from the runner's bounds; the others are short phrases of
 * SR-2.2's wording that the reason states.
 */
const SHARDS_RANGE_RULE = `from ${OPTION_RANGE_MIN} to ${MAX_SHARDS}`
const SHARD_TIMEOUT_RANGE_RULE = `from ${OPTION_RANGE_MIN} to ${MAX_SHARD_TIMEOUT_MINUTES}`
/** SR-2.2: each option takes the next argument as its value. */
const NEXT_ARGUMENT_RULE = 'the next argument'
/** SR-2.2: an unknown option is a bad argument. */
const UNKNOWN_OPTION_RULE = 'an unknown option'
/** SR-2.2: any other argument beginning `-` is a bad argument. */
const NOT_AN_OPTION_RULE = 'argument beginning -'
/** SR-2.2: `--shards` and `--shard-timeout` may each appear once. */
const GIVEN_ONCE_RULE = 'once'

/** One bad-argument row: the arguments, the failures in argument order, the argument the reason must name, and the rule it must name. */
interface BadArgumentsRow {
  readonly label: string
  readonly args: readonly string[]
  readonly failures: readonly ArgumentFailure[]
  readonly names: string
  readonly rule: string
}

const BAD_ARGUMENT_ROWS: readonly BadArgumentsRow[] = [
  { label: '--shards=3', args: ['--shards=3'], failures: [{ position: 0, reason: optionEqualsFormReason('--shards=3', '--shards') }], names: '--shards=3', rule: NEXT_ARGUMENT_RULE },
  { label: '--shard-timeout=45', args: ['--shard-timeout=45'], failures: [{ position: 0, reason: optionEqualsFormReason('--shard-timeout=45', '--shard-timeout') }], names: '--shard-timeout=45', rule: NEXT_ARGUMENT_RULE },
  { label: '--inject=retag', args: ['--inject=retag'], failures: [{ position: 0, reason: optionEqualsFormReason('--inject=retag', '--inject') }], names: '--inject=retag', rule: NEXT_ARGUMENT_RULE },
  { label: '--shards given last', args: ['--shards'], failures: [{ position: 0, reason: optionWithoutValueReason('--shards') }], names: '--shards', rule: NEXT_ARGUMENT_RULE },
  { label: '--shard-timeout given last', args: ['--shards', '3', '--shard-timeout'], failures: [{ position: 2, reason: optionWithoutValueReason('--shard-timeout') }], names: '--shard-timeout', rule: NEXT_ARGUMENT_RULE },
  { label: '--inject given last', args: ['--inject', 'retag', '--inject'], failures: [{ position: 2, reason: optionWithoutValueReason('--inject') }], names: '--inject', rule: NEXT_ARGUMENT_RULE },
  { label: 'an unknown option', args: ['--verbose'], failures: [{ position: 0, reason: unknownOptionReason('--verbose') }], names: '--verbose', rule: UNKNOWN_OPTION_RULE },
  { label: 'an unknown option joined with =', args: ['--verbose=1'], failures: [{ position: 0, reason: unknownOptionReason('--verbose=1') }], names: '--verbose=1', rule: UNKNOWN_OPTION_RULE },
  { label: 'a single-dash argument', args: ['-s'], failures: [{ position: 0, reason: notAnOptionReason('-s') }], names: '-s', rule: NOT_AN_OPTION_RULE },
  { label: 'a lone dash', args: ['-'], failures: [{ position: 0, reason: notAnOptionReason('-') }], names: '-', rule: NOT_AN_OPTION_RULE },
  { label: '--shards twice with different values', args: ['--shards', '2', '--shards', '3'], failures: [{ position: 2, reason: repeatedOptionReason('--shards', '3') }], names: '--shards 3', rule: GIVEN_ONCE_RULE },
  { label: '--shards twice with the same value', args: ['--shards', '3', '--shards', '3'], failures: [{ position: 2, reason: repeatedOptionReason('--shards', '3') }], names: '--shards 3', rule: GIVEN_ONCE_RULE },
  { label: '--shard-timeout twice with the same value', args: ['--shard-timeout', '5', '--shard-timeout', '5'], failures: [{ position: 2, reason: repeatedOptionReason('--shard-timeout', '5') }], names: '--shard-timeout 5', rule: GIVEN_ONCE_RULE },
  { label: '--shards below its range', args: ['--shards', BELOW_RANGE], failures: [{ position: 0, reason: outOfRangeReason('--shards', BELOW_RANGE) }], names: `--shards ${BELOW_RANGE}`, rule: SHARDS_RANGE_RULE },
  { label: '--shards above its range', args: ['--shards', SHARDS_ABOVE_RANGE], failures: [{ position: 0, reason: outOfRangeReason('--shards', SHARDS_ABOVE_RANGE) }], names: `--shards ${SHARDS_ABOVE_RANGE}`, rule: SHARDS_RANGE_RULE },
  { label: '--shards x', args: ['--shards', 'x'], failures: [{ position: 0, reason: notWholeNumberReason('--shards', 'x') }], names: '--shards x', rule: SHARDS_RANGE_RULE },
  { label: '--shards with a leading zero', args: ['--shards', '03'], failures: [{ position: 0, reason: notWholeNumberReason('--shards', '03') }], names: '--shards 03', rule: SHARDS_RANGE_RULE },
  { label: '--shards with a plus sign', args: ['--shards', '+3'], failures: [{ position: 0, reason: notWholeNumberReason('--shards', '+3') }], names: '--shards +3', rule: SHARDS_RANGE_RULE },
  { label: '--shards with a minus sign', args: ['--shards', '-3'], failures: [{ position: 0, reason: notWholeNumberReason('--shards', '-3') }], names: '--shards -3', rule: SHARDS_RANGE_RULE },
  { label: '--shards with a decimal point', args: ['--shards', '3.0'], failures: [{ position: 0, reason: notWholeNumberReason('--shards', '3.0') }], names: '--shards 3.0', rule: SHARDS_RANGE_RULE },
  { label: '--shards with an empty value', args: ['--shards', ''], failures: [{ position: 0, reason: notWholeNumberReason('--shards', '') }], names: '--shards ""', rule: SHARDS_RANGE_RULE },
  { label: '--shard-timeout below its range', args: ['--shard-timeout', BELOW_RANGE], failures: [{ position: 0, reason: outOfRangeReason('--shard-timeout', BELOW_RANGE) }], names: `--shard-timeout ${BELOW_RANGE}`, rule: SHARD_TIMEOUT_RANGE_RULE },
  { label: '--shard-timeout above its range', args: ['--shard-timeout', TIMEOUT_ABOVE_RANGE], failures: [{ position: 0, reason: outOfRangeReason('--shard-timeout', TIMEOUT_ABOVE_RANGE) }], names: `--shard-timeout ${TIMEOUT_ABOVE_RANGE}`, rule: SHARD_TIMEOUT_RANGE_RULE },
  { label: '--shard-timeout 1.5', args: ['--shard-timeout', '1.5'], failures: [{ position: 0, reason: notWholeNumberReason('--shard-timeout', '1.5') }], names: '--shard-timeout 1.5', rule: SHARD_TIMEOUT_RANGE_RULE },
  { label: '--shard-timeout with a leading zero', args: ['--shard-timeout', '045'], failures: [{ position: 0, reason: notWholeNumberReason('--shard-timeout', '045') }], names: '--shard-timeout 045', rule: SHARD_TIMEOUT_RANGE_RULE },
]

/** One run-kind row (b.uqm SR-2.5); its arguments are built when the case runs, from the repository's listing. */
interface RunKindRow {
  readonly label: string
  readonly args: () => readonly string[]
  readonly kinds: RunKinds
}

const DEFAULT_FULL: RunKinds = { defaultFull: true, full: true, selective: false, injected: false, gateEligible: true, capSourceEligible: true, kind: 'full' }
const FULL: RunKinds = { ...DEFAULT_FULL, defaultFull: false, capSourceEligible: false }
const FULL_INJECTED: RunKinds = { ...FULL, injected: true, gateEligible: false }
const SELECTIVE: RunKinds = { defaultFull: false, full: false, selective: true, injected: false, gateEligible: false, capSourceEligible: false, kind: 'selective' }

const RUN_KIND_ROWS: readonly RunKindRow[] = [
  { label: 'no arguments: a default full run', args: () => [], kinds: DEFAULT_FULL },
  { label: '--shards alone: a full run', args: () => ['--shards', '3'], kinds: FULL },
  { label: '--shard-timeout alone: a full run', args: () => ['--shard-timeout', '45'], kinds: FULL },
  { label: '--shards and --shard-timeout: a full run', args: () => ['--shard-timeout', '45', '--shards', '3'], kinds: FULL },
  { label: '--inject alone: an injected full run', args: () => ['--inject', 'retag'], kinds: FULL_INJECTED },
  { label: '--inject with --shards: an injected full run', args: () => ['--shards', '3', '--inject', 'kill:1'], kinds: FULL_INJECTED },
  { label: 'a SCRIPT by number form: a selective run', args: () => [numberForm(3)], kinds: SELECTIVE },
  { label: 'a SCRIPT by file name with --shards: a selective run', args: () => ['--shards', '3', scriptFile(4)], kinds: SELECTIVE },
  { label: 'an empty SCRIPT argument: a selective run', args: () => [''], kinds: SELECTIVE },
  { label: 'a SCRIPT and --inject: an injected selective run', args: () => [scriptFile(3), '--inject', `fail:${numberForm(3)}`], kinds: { ...SELECTIVE, injected: true } },
]

describe('arguments and command lines (b.uqm SR-2.1, SR-2.2)', () => {
  test('a SCRIPT before or after --shards parses to the same invocation', () => {
    const before = parsedInvocation([numberForm(3), '--shards', '2'])
    const after = parsedInvocation(['--shards', '2', numberForm(3)])

    expect(orderFreeView(after)).toEqual(orderFreeView(before))
    expect(before.scripts).toEqual([numberForm(3)])
    expect(before.shards).toBe(2)
  })

  test('interleaving options, faults and SCRIPTs changes nothing but the order of the faults', () => {
    const fail = `fail:${numberForm(3)}`
    const one = parsedInvocation(['--inject', fail, numberForm(3), '--shard-timeout', '45', '--inject', 'kill:2', '--shards', '3', scriptFile(4)])
    const other = parsedInvocation([scriptFile(4), '--shards', '3', '--inject', 'kill:2', '--shard-timeout', '45', numberForm(3), '--inject', fail])

    expect(orderFreeView(other)).toEqual(orderFreeView(one))
    expect(injectedFaultsText(one.faults)).toBe([fail, 'kill:2'].join(' '))
    expect(injectedFaultsText(other.faults)).toBe(['kill:2', fail].join(' '))
  })

  test('the invocation keeps the arguments as given, and the SCRIPT arguments in their order', () => {
    const args = [scriptFile(4), '--shards', '3', numberForm(2), '--inject', 'retag']
    const invocation = parsedInvocation(args)

    expect(invocation.args).toEqual(args)
    expect(invocation.scripts).toEqual([scriptFile(4), numberForm(2)])
  })

  test.each([...BAD_ARGUMENT_ROWS])('$label is a bad argument, its reason naming the argument and the rule', ({ args, failures, names, rule }) => {
    const refused = refusedFailures(args)

    expect(refused).toEqual(failures)
    for (const failure of refused) {
      expect(failure.reason).toContain(names)
      expect(failure.reason).toContain(rule)
    }
  })

  test('--shards 7 is refused with b.uqm SR-2.2 example reason', () => {
    expect(refusedFailures(['--shards', '7'])).toEqual([{ position: 0, reason: '--shards 7 is out of range: N must be a whole number from 1 to 6' }])
  })

  test.each([
    ['--shards', OPTION_RANGE_MIN],
    ['--shards', MAX_SHARDS],
    ['--shard-timeout', OPTION_RANGE_MIN],
    ['--shard-timeout', MAX_SHARD_TIMEOUT_MINUTES],
  ] as const)('%s %d is accepted at the edge of its range', (option, value) => {
    const invocation = parsedInvocation([option, String(value)])

    expect(option === '--shards' ? invocation.shards : invocation.shardTimeoutMinutes).toBe(value)
  })

  test('several bad arguments come back in argument order', () => {
    expect(refusedFailures(['--verbose', '--shards', BELOW_RANGE, numberForm(3), '--inject', 'bogus', '--shard-timeout'])).toEqual([
      { position: 0, reason: unknownOptionReason('--verbose') },
      { position: 1, reason: outOfRangeReason('--shards', BELOW_RANGE) },
      { position: 4, reason: unknownFaultReason('bogus') },
      { position: 6, reason: optionWithoutValueReason('--shard-timeout') },
    ])
  })

  test('a fail:/timeout: conflict takes its place in argument order, at the later fault', () => {
    const fail = `fail:${numberForm(3)}`
    const timeout = `timeout:${scriptFile(3)}`

    expect(refusedFailures(['--inject', fail, '--inject', timeout, '-x'])).toEqual([
      { position: 2, reason: failTimeoutConflictReason(fail, timeout, numberForm(3)) },
      { position: 4, reason: notAnOptionReason('-x') },
    ])
  })

  test('run options come only from the arguments: the same arguments parse the same under another environment', () => {
    const args = ['--shards', '3', numberForm(3)]
    const plain = parseCiArguments(args)
    const optionLike: Record<string, string> = {
      SHARDS: '1',
      CI_SHARDS: '1',
      CSCB_CI_SHARDS: '1',
      SHARD_TIMEOUT: '1',
      CI_SHARD_TIMEOUT: '1',
      CI_INJECT: 'retag',
      CI_SCRIPTS: numberForm(2),
    }
    const saved = Object.fromEntries(Object.keys(optionLike).map((name) => [name, process.env[name]]))
    let underOptionLike: ReturnType<typeof parseCiArguments>
    try {
      Object.assign(process.env, optionLike)
      underOptionLike = parseCiArguments(args)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(underOptionLike).toEqual(plain)
  })
})

describe('run kinds and gate eligibility (b.uqm SR-2.5)', () => {
  test.each([...RUN_KIND_ROWS])('$label', ({ args, kinds }) => {
    expect(runKinds(parsedInvocation(args()))).toEqual(kinds)
  })

  test('/ci with no arguments activates no fault', () => {
    const invocation = parsedInvocation([])

    expect(invocation.faults).toEqual([])
    expect(invocation.givenFaults).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Faults: forms, normalization, de-duplication and bad arguments (b.uqm SR-2.4)
// ---------------------------------------------------------------------------

/** One accepted fault form; built when the case runs, from the repository's listing. */
interface FaultFormRow {
  readonly label: string
  readonly value: () => string
  readonly fault: () => Fault
}

const FAULT_FORM_ROWS: readonly FaultFormRow[] = [
  { label: 'fail: by number form', value: () => `fail:${numberForm(3)}`, fault: () => ({ kind: 'fail', script: numberForm(3) }) },
  { label: 'fail: by file name, normalized to its number form', value: () => `fail:${scriptFile(3)}`, fault: () => ({ kind: 'fail', script: numberForm(3) }) },
  { label: 'timeout: by number form', value: () => `timeout:${numberForm(4)}`, fault: () => ({ kind: 'timeout', script: numberForm(4) }) },
  { label: 'timeout: by file name, normalized to its number form', value: () => `timeout:${scriptFile(4)}`, fault: () => ({ kind: 'timeout', script: numberForm(4) }) },
  { label: 'leak:<k>,<j>', value: () => 'leak:1,2', fault: () => ({ kind: 'leak', sourceShard: 1, targetShard: 2 }) },
  { label: 'image-drift:<k>', value: () => 'image-drift:2', fault: () => ({ kind: 'image-drift', shard: 2 }) },
  { label: 'kill:<k>', value: () => 'kill:2', fault: () => ({ kind: 'kill', shard: 2 }) },
  { label: 'retag', value: () => 'retag', fault: () => ({ kind: 'retag' }) },
  { label: 'kill:0, out of range but left to validation stage 7', value: () => `kill:${BELOW_RANGE}`, fault: () => ({ kind: 'kill', shard: OPTION_RANGE_MIN - 1 }) },
  { label: 'image-drift above the maximum N, left to validation stage 7', value: () => `image-drift:${SHARDS_ABOVE_RANGE}`, fault: () => ({ kind: 'image-drift', shard: MAX_SHARDS + 1 }) },
]

/** A whole number past 2^53, whose digits a `Number` would not keep. */
const HUGE_DIGITS = '9'.repeat(20)

describe('fault forms and normalization (b.uqm SR-2.4)', () => {
  test.each([...FAULT_FORM_ROWS])('$label parses', ({ value, fault }) => {
    const given = value()
    const invocation = parsedInvocation(['--inject', given])

    expect(parseFault(given)).toEqual({ ok: true, fault: fault() })
    expect(invocation.faults).toEqual([fault()])
    expect(invocation.givenFaults).toEqual([{ position: 0, value: given, fault: fault() }])
  })

  test("a fault's number form keeps the digits as typed, past 2^53", () => {
    const script = `test-${HUGE_DIGITS}`

    expect(parseFault(`fail:${script}`)).toEqual({ ok: true, fault: { kind: 'fail', script } })
  })

  test("leak shards are compared as typed digits: two numbers past 2^53 that share one Number are different shards", () => {
    const k = String(2n ** 53n + 1n)
    const j = String(2n ** 53n)

    expect(k).not.toBe(j)
    expect(Number(k)).toBe(Number(j))
    expect(parseFault(`leak:${k},${j}`).ok).toBe(true)
  })

  test('de-duplication keeps the first occurrence in its place; the wrapper shows the faults in that order with single spaces', () => {
    const fail = `fail:${numberForm(3)}`
    const args = ['--inject', 'kill:2', '--inject', `fail:${scriptFile(3)}`, '--inject', 'retag', '--inject', fail, '--inject', 'kill:2']
    const invocation = parsedInvocation(args)
    const wrapperText = ['kill:2', fail, 'retag'].join(' ')

    expect(invocation.faults).toEqual([{ kind: 'kill', shard: 2 }, { kind: 'fail', script: numberForm(3) }, { kind: 'retag' }])
    expect(injectedFaultsText(invocation.faults)).toBe(wrapperText)
    expect(injectedVerdictPrefix(invocation.faults)).toBe(`INJECTED (${wrapperText}): `)
    expect(invocation.givenFaults.map((given) => [given.position, given.value])).toEqual([
      [0, 'kill:2'],
      [2, `fail:${scriptFile(3)}`],
      [4, 'retag'],
      [6, fail],
      [8, 'kill:2'],
    ])
  })
})

/** One bad `--inject` value and the reason it gives. */
const BAD_FAULT_ROWS: readonly (readonly [string, string, string])[] = [
  ['an unknown fault name', 'bogus:1', unknownFaultReason('bogus:1')],
  ['an empty fault', '', unknownFaultReason('')],
  ['fail with no operand', 'fail', malformedFaultReason('fail', 'fail')],
  ['fail with an empty operand', 'fail:', malformedFaultReason('fail:', 'fail')],
  ['timeout naming no script form', 'timeout:x', malformedFaultReason('timeout:x', 'timeout')],
  ['kill with no operand', 'kill:', malformedFaultReason('kill:', 'kill')],
  ['image-drift with no operand', 'image-drift', malformedFaultReason('image-drift', 'image-drift')],
  ['leak with no operand', 'leak:', malformedFaultReason('leak:', 'leak')],
  ['kill with a non-whole number', 'kill:x', malformedFaultReason('kill:x', 'kill')],
  ['kill with a leading zero', 'kill:01', malformedFaultReason('kill:01', 'kill')],
  ['kill with a sign', 'kill:-1', malformedFaultReason('kill:-1', 'kill')],
  ['image-drift with a decimal point', 'image-drift:1.5', malformedFaultReason('image-drift:1.5', 'image-drift')],
  ['leak with one shard', 'leak:1', malformedFaultReason('leak:1', 'leak')],
  ['leak with three shards', 'leak:1,2,3', malformedFaultReason('leak:1,2,3', 'leak')],
  ['leak with a non-whole shard', 'leak:1,x', malformedFaultReason('leak:1,x', 'leak')],
  ['leak with an empty first shard', 'leak:,2', malformedFaultReason('leak:,2', 'leak')],
  ['retag with a value', 'retag:1', malformedFaultReason('retag:1', 'retag')],
  ['leak:2,2', 'leak:2,2', sameShardLeakReason('leak:2,2')],
]

/** fail:/timeout: pairs naming the same script; built when the case runs. */
const FAIL_TIMEOUT_ROWS: readonly (readonly [string, () => readonly string[], () => ArgumentFailure])[] = [
  [
    'fail: by number form, then timeout: by file name',
    () => ['--inject', `fail:${numberForm(3)}`, '--inject', `timeout:${scriptFile(3)}`],
    () => ({ position: 2, reason: failTimeoutConflictReason(`fail:${numberForm(3)}`, `timeout:${scriptFile(3)}`, numberForm(3)) }),
  ],
  [
    'timeout: by number form, then fail: by file name',
    () => ['--inject', `timeout:${numberForm(3)}`, '--inject', `fail:${scriptFile(3)}`],
    () => ({ position: 2, reason: failTimeoutConflictReason(`timeout:${numberForm(3)}`, `fail:${scriptFile(3)}`, numberForm(3)) }),
  ],
  [
    'both by file name',
    () => ['--inject', `timeout:${scriptFile(4)}`, '--inject', `fail:${scriptFile(4)}`],
    () => ({ position: 2, reason: failTimeoutConflictReason(`timeout:${scriptFile(4)}`, `fail:${scriptFile(4)}`, numberForm(4)) }),
  ],
  [
    'a repeated fail: dropped before the conflict, which names the first',
    () => ['--inject', `fail:${numberForm(3)}`, '--inject', `fail:${scriptFile(3)}`, '--inject', `timeout:${numberForm(3)}`],
    () => ({ position: 4, reason: failTimeoutConflictReason(`fail:${numberForm(3)}`, `timeout:${numberForm(3)}`, numberForm(3)) }),
  ],
]

describe('faults that are bad arguments (b.uqm SR-2.4)', () => {
  test.each(BAD_FAULT_ROWS)('%s is a bad argument', (_label, value, reason) => {
    expect(parseFault(value)).toEqual({ ok: false, reason })
    expect(refusedFailures(['--inject', value])).toEqual([{ position: 0, reason }])
  })

  test.each(FAIL_TIMEOUT_ROWS)('fail: and timeout: naming the same script are a bad argument: %s', (_label, args, failure) => {
    expect(refusedFailures(args())).toEqual([failure()])
  })
})

// ---------------------------------------------------------------------------
// Canonical order (b.uqm SR-3.3)
// ---------------------------------------------------------------------------

/** Script numbers in canonical order, as b.uqm SR-3.3 states it: test-1; test-2 to test-4 when present; then the rest ascending. */
function expectedCanonicalNumbers(numbers: readonly number[]): number[] {
  const early = [2, 3, 4].filter((n) => numbers.includes(n))
  const rest = numbers.filter((n) => n !== 1 && !early.includes(n)).sort((a, b) => a - b)
  return [...(numbers.includes(1) ? [1] : []), ...early, ...rest]
}

/** The script file names of a directory listing, in the order the listing gave them reversed, so no listing order can pass for canonical order. */
function scriptListing(dir: string): string[] {
  return readdirSync(dir).filter(isScriptFileName).reverse()
}

describe('canonical order (b.uqm SR-3.3)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-interface-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('on the repository listing: test-1, then test-2 to test-4, then by ascending number, test-0 after test-4 and test-10 after test-9', () => {
    const numbers = sortCanonical(scriptListing(join(REPO_ROOT, INTEGRATION_DIR_PATH))).map((name) => fileNameNumber(name) as number)

    expect(numbers).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 9, 10]))
    expect(numbers).toEqual(expectedCanonicalNumbers(numbers))
    expect(numbers.slice(0, 5)).toEqual([1, 2, 3, 4, 0])
    expect(numbers.indexOf(10)).toBe(numbers.indexOf(9) + 1)
  })

  test('on a tree without test-2 to test-4: test-0 follows test-1', () => {
    const worktree = buildWorktree(root, { without: [2, 3, 4] })
    const numbers = sortCanonical(scriptListing(worktree.integrationDir)).map((name) => fileNameNumber(name) as number)

    expect(numbers.filter((n) => n >= 2 && n <= 4)).toEqual([])
    expect(numbers).toEqual(expectedCanonicalNumbers(numbers))
    expect(numbers.slice(0, 2)).toEqual([1, 0])
  })

  test('number forms and file names sort together by number; a name of neither form sorts after every script', () => {
    const names = ['not-a-script', numberForm(10), scriptFile(0), scriptFile(1), numberForm(4), scriptFile(2), numberForm(9)]

    expect(sortCanonical(names)).toEqual([scriptFile(1), scriptFile(2), numberForm(4), scriptFile(0), numberForm(9), numberForm(10), 'not-a-script'])
  })
})

// ---------------------------------------------------------------------------
// Child process environments, the secret set and the token lookup (b.uqm SR-15.4, SR-15.1)
// ---------------------------------------------------------------------------

/** Fake credentials, each with its own suffix (b.uqm SR-21.2). */
function credentials(): { rawKey: string; gatewayKey: string; ghToken: string; baseBuildToken: string; tooShort: string; shardKey: string } {
  return {
    rawKey: fakeToken(RAW_KEY_PREFIX, 'raw'),
    gatewayKey: fakeToken('gw-', 'gateway'),
    ghToken: fakeToken('', 'gh'),
    baseBuildToken: fakeToken('', 'base-build'),
    tooShort: fakeToken('', 'short').slice(0, SECRET_MIN_LENGTH - 1),
    shardKey: fakeToken('', 'shard'),
  }
}

const GATEWAY_URL = 'https://gateway.example.invalid'
const GATEWAY_MODEL = 'gateway-model'

/** A `gh auth token` child that prints `stdout` and exits with `exitCode`. */
function lookupAnswer(stdout: string, exitCode = 0): SpawnAnswer {
  return { stdout, exitCode }
}

/** Scripts the two `gh auth token` lookups in order: the first answer serves the first spawn, the second the next. */
function scriptLookups(recorder: SpawnRecorder, first: SpawnAnswer, second?: SpawnAnswer): void {
  if (second !== undefined) recorder.answer(GH_AUTH_TOKEN_ARGV, second, { times: 1 })
  recorder.answer(GH_AUTH_TOKEN_ARGV, first, { times: 1 })
}

describe('child process environments, the secret set and the token lookup (b.uqm SR-15.4, SR-15.1)', () => {
  let root: string
  let recorder: SpawnRecorder

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-interface-'))
    recorder = createSpawnRecorder({ clock: createFakeClock() })
  })

  afterEach(() => {
    try {
      recorder.assertNoFailures()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** The runner's environment as `RunnerDeps.env` holds it, with one unset entry. */
  function runnerEnvironment(): ChildEnvironmentSource {
    const c = credentials()
    return { HOME: join(root, 'home'), PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: c.rawKey, GH_TOKEN: c.ghToken, LANG: 'C.UTF-8', CSCB_UNSET: undefined }
  }

  /** The same environment with its unset entry left out, built by hand. */
  function setEntries(env: ChildEnvironmentSource): Record<string, string> {
    const { CSCB_UNSET: _unset, ...rest } = env
    return rest as Record<string, string>
  }

  test('a child environment is the runner environment unchanged, its unset entries left out', () => {
    const env = runnerEnvironment()

    expect(childEnvironment(env)).toStrictEqual(setEntries(env))
  })

  test('every docker-layer spawn reaches the spawn recorder with the injected environment unchanged', async () => {
    const env = runnerEnvironment()
    const docker = createFakeDocker(recorder)
    const context: DockerContext = { spawn: recorder.spawn, env: childEnvironment(env), cwd: root }
    const owner: Owner = { runId: '20261008t120000z-envcheck', pid: 4242 }
    const [testRole, driftRole, retagRole] = RUN_TAG_ROLES
    const testTag = formatRunTag(owner, testRole)
    const imageId = docker.addImage({ tags: [testTag], labels: { [OWNER_LABEL]: formatOwner(owner) }, archives: { '/srv/out': buildTarArchive({ out: 'x' }) } })
    docker.addContainer({ name: 'env-check-1', image: testTag, logs: { stdout: 'started\n' } })
    const noSignal: DockerSignalSender = () => 'no-such-process'
    const logLines: string[] = []
    const log = (line: string): void => {
      logLines.push(line)
    }
    const labels = { [OWNER_LABEL]: formatOwner(owner) }

    const answers = [
      await checkDockerAnswers(context),
      await listContainers(context),
      await inspectContainerState(context, 'env-check-1'),
      await readContainerInspection(context, 'env-check-1'),
      await readContainerLogs(context, 'env-check-1'),
      await killContainer(context, 'env-check-1', 'SIGKILL'),
      await createContainer(context, 'env-check-2', labels, testTag),
      await copyOutOfContainer(context, 'env-check-2', '/srv/out'),
      await removeContainer(context, 'env-check-2'),
      await runContainer(context, ['--name', 'env-check-3', testTag], () => ({ ok: true }), log),
      await inspectImage(context, testTag),
      await listImages(context, [{ kind: 'label', key: OWNER_LABEL, value: formatOwner(owner) }]),
      await tagImage(context, imageId, formatRunTag(owner, retagRole)),
      await removeImageTag(context, formatRunTag(owner, retagRole)),
      await startTestImageBuild(context, noSignal, { dockerfilePath: join(root, TEST_DOCKERFILE_PATH), contextDir: root, labels, tag: formatRunTag(owner, retagRole) }, log).result,
      await startDerivedImageBuild(context, noSignal, { from: testTag, labels, tag: formatRunTag(owner, driftRole) }, log).result,
      await pruneUntaggedImages(context, formatOwner(owner)),
    ]
    const everyKind: FakeDockerOperationKind[] = [
      'version',
      'container-list',
      'container-state',
      'container-inspection',
      'container-create',
      'container-copy',
      'container-kill',
      'container-logs',
      'container-remove',
      'container-run',
      'image-inspect',
      'image-list',
      'image-remove',
      'image-tag',
      'image-build',
      'image-prune',
    ]

    expect(new Set(docker.operations().map((operation) => operation.kind))).toEqual(new Set(everyKind))
    expect(recorder.spawns().length).toBe(docker.operations().length)
    for (const spawn of recorder.spawns()) {
      expect(spawn.env).toStrictEqual(setEntries(env))
      expect(spawn.cwd).toBe(root)
    }
    assertNoLeak({ answers, logLines })
  })

  test('the first gh auth token lookup adds exactly GH_CONFIG_DIR under the environment HOME, in the given working directory', async () => {
    const env = runnerEnvironment()
    const c = credentials()
    scriptLookups(recorder, lookupAnswer(`${c.baseBuildToken}\n`))

    const token = await lookUpBaseBuildToken(recorder.spawn, env, root)

    expect(token).toBe(c.baseBuildToken)
    expect(recorder.spawns().map((spawn) => ({ argv: spawn.argv, env: spawn.env, cwd: spawn.cwd, ownProcessGroup: spawn.ownProcessGroup }))).toStrictEqual([
      { argv: [...GH_AUTH_TOKEN_ARGV], env: { ...setEntries(env), GH_CONFIG_DIR: `${env.HOME}/${GH_PERSONAL_CONFIG_SUBPATH}` }, cwd: root, ownProcessGroup: false },
    ])
  })

  test('with HOME unset, the first lookup GH_CONFIG_DIR is the subpath below the root', () => {
    const { HOME: _home, ...withoutHome } = runnerEnvironment()

    expect(firstTokenLookupEnvironment(withoutHome)).toStrictEqual({ ...setEntries(withoutHome), GH_CONFIG_DIR: `/${GH_PERSONAL_CONFIG_SUBPATH}` })
  })

  test.each([
    ['the first lookup fails', lookupAnswer('', 1)],
    ['the first lookup prints nothing', lookupAnswer('')],
    ['the first lookup prints only line feeds', lookupAnswer('\n\n')],
    ['the first lookup could not be started', { notStarted: 'gh: not found' } satisfies SpawnAnswer],
  ] as const)('the plain fallback runs with the environment unchanged when %s', async (_label, first) => {
    const env = runnerEnvironment()
    const c = credentials()
    scriptLookups(recorder, first, lookupAnswer(`${c.baseBuildToken}\n\n`))

    const token = await lookUpBaseBuildToken(recorder.spawn, env, root)

    expect(token).toBe(c.baseBuildToken)
    expect(recorder.spawns().map((spawn) => spawn.env)).toStrictEqual([{ ...setEntries(env), GH_CONFIG_DIR: `${env.HOME}/${GH_PERSONAL_CONFIG_SUBPATH}` }, setEntries(env)])
    expect(recorder.spawns().map((spawn) => spawn.cwd)).toEqual([root, root])
  })

  test('a first lookup whose spawn throws counts as a failing gh: the fallback runs', async () => {
    const env = runnerEnvironment()
    const c = credentials()
    scriptLookups(recorder, lookupAnswer(`${c.baseBuildToken}\n`))
    let spawned = 0
    const throwingFirst: SpawnFn = (request) => {
      spawned += 1
      if (spawned === 1) throw new Error('spawn failed')
      return recorder.spawn(request)
    }

    expect(await lookUpBaseBuildToken(throwingFirst, env, root)).toBe(c.baseBuildToken)
    expect(spawned).toBe(2)
    expect(recorder.spawns().map((spawn) => spawn.env)).toStrictEqual([setEntries(env)])
  })

  test.each([
    ['both lookups print nothing', lookupAnswer(''), lookupAnswer('')],
    ['both lookups fail', lookupAnswer('', 1), lookupAnswer('', 1)],
  ] as const)('%s: no credential, and none joins the secret set', async (_label, first, second) => {
    const env = runnerEnvironment()
    scriptLookups(recorder, first, second)

    const token = await lookUpBaseBuildToken(recorder.spawn, env, root)

    expect(token).toBeNull()
    expect(recorder.spawns().length).toBe(2)
    expect(secretCredentialSet(env, { baseBuildToken: token })).toEqual(new Set([env.ANTHROPIC_API_KEY as string, env.GH_TOKEN as string]))
  })

  test('a first lookup that gives a token: no fallback runs', async () => {
    const c = credentials()
    scriptLookups(recorder, lookupAnswer(c.baseBuildToken))

    expect(await lookUpBaseBuildToken(recorder.spawn, runnerEnvironment(), root)).toBe(c.baseBuildToken)
    expect(recorder.spawns().length).toBe(1)
  })

  test.each([
    ['a raw key alone', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey }, extras: {}, secrets: [c.rawKey] })],
    [
      'a gateway key, its base URL and model never secret',
      (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.gatewayKey, ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_MODEL: GATEWAY_MODEL }, extras: {}, secrets: [c.gatewayKey] }),
    ],
    ['GH_TOKEN when set', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey, GH_TOKEN: c.ghToken }, extras: {}, secrets: [c.rawKey, c.ghToken] })],
    ['no GH_TOKEN when it is empty', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey, GH_TOKEN: '' }, extras: {}, secrets: [c.rawKey] })],
    ['no GH_TOKEN when it is unset', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey, GH_TOKEN: undefined }, extras: {}, secrets: [c.rawKey] })],
    ['a too-short GH_TOKEN, still a secret', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey, GH_TOKEN: c.tooShort }, extras: {}, secrets: [c.rawKey, c.tooShort] })],
    ['the base-build token when it was looked up and found', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey }, extras: { baseBuildToken: c.baseBuildToken }, secrets: [c.rawKey, c.baseBuildToken] })],
    ['no base-build token when none was found', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey }, extras: { baseBuildToken: null }, secrets: [c.rawKey] })],
    ['no base-build token when it is empty', (c: ReturnType<typeof credentials>) => ({ env: { ANTHROPIC_API_KEY: c.rawKey }, extras: { baseBuildToken: '' }, secrets: [c.rawKey] })],
    [
      'a shard variable holding a key, but never ANTHROPIC_BASE_URL, ANTHROPIC_MODEL or an empty value',
      (c: ReturnType<typeof credentials>) => ({
        env: { ANTHROPIC_API_KEY: c.rawKey },
        extras: { shardVariables: { SHARD_API_KEY: c.shardKey, ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_MODEL: GATEWAY_MODEL, EMPTY_KEY: '' } },
        secrets: [c.rawKey, c.shardKey],
      }),
    ],
    ['nothing for an empty ANTHROPIC_API_KEY', () => ({ env: { ANTHROPIC_API_KEY: '' }, extras: {}, secrets: [] })],
    ['nothing for an unset ANTHROPIC_API_KEY', () => ({ env: {}, extras: {}, secrets: [] })],
  ] as const)('the secret set holds %s', (_label, row) => {
    const { env, extras, secrets } = row(credentials())

    expect(secretCredentialSet(env, extras)).toEqual(new Set<string>(secrets))
  })
})

// ---------------------------------------------------------------------------
// Constants (b.uqm SR-21.5): one pin case per constant
// ---------------------------------------------------------------------------
//
// The only place E1's constant values are typed. Byte figures are written
// from the PRD's GiB figures through `gib`, on the pinned `GIB_BYTES`.

/** `n` GiB in bytes. */
function gib(n: number): number {
  return n * GIB_BYTES
}

/** One pin: the constant's name, its value as the runner exports it, and the PRD's or SRD's value. */
const CONSTANT_PINS: readonly (readonly [string, unknown, unknown])[] = [
  // Section 1: entry and dependencies.
  ['REAL_PASSWORD_FILE', REAL_PASSWORD_FILE, '/etc/passwd'],
  ['SPAWN_FAILED_EXIT_STATUS', SPAWN_FAILED_EXIT_STATUS, 127],
  // Memory.
  ['GIB_BYTES', GIB_BYTES, 2 ** 30],
  ['SHARD_MEMORY_CAP_BYTES', SHARD_MEMORY_CAP_BYTES, gib(2)],
  ['MIN_SHARD_MEMORY_CAP_BYTES', MIN_SHARD_MEMORY_CAP_BYTES, gib(2)],
  ['CAP_MARGIN_BYTES', CAP_MARGIN_BYTES, gib(1)],
  ['CAP_ROUNDING_STEP_BYTES', CAP_ROUNDING_STEP_BYTES, gib(0.5)],
  ['ADMISSION_MARGIN_BYTES', ADMISSION_MARGIN_BYTES, gib(1)],
  ['MEMORY_CEILING_PERCENT', MEMORY_CEILING_PERCENT, 85],
  ['DISK_LINE_PERCENT', DISK_LINE_PERCENT, 85],
  ['DISK_CHECK_ALLOWANCE_BYTES', DISK_CHECK_ALLOWANCE_BYTES, gib(1)],
  ['STOP_LINE_OFFSET_BYTES', STOP_LINE_OFFSET_BYTES, gib(0.5)],
  ['CI_LIVE_RUNNER_ALLOWANCE_BYTES', CI_LIVE_RUNNER_ALLOWANCE_BYTES, gib(1)],
  // CPUs and ranges.
  ['CI_CPUS', CI_CPUS, 12],
  ['CPUS_PER_SHARD', CPUS_PER_SHARD, 2],
  ['OPTION_RANGE_MIN', OPTION_RANGE_MIN, 1],
  ['MAX_SHARDS', MAX_SHARDS, 6],
  ['MAX_SHARD_TIMEOUT_MINUTES', MAX_SHARD_TIMEOUT_MINUTES, 720],
  // Timing.
  ['SAMPLE_INTERVAL_MS', SAMPLE_INTERVAL_MS, 30_000],
  ['FAULT_POLL_INTERVAL_MS', FAULT_POLL_INTERVAL_MS, 1_000],
  ['INSPECTION_REREAD_DELAY_MS', INSPECTION_REREAD_DELAY_MS, 1_000],
  ['PRUNE_RETRIES', PRUNE_RETRIES, 3],
  ['PRUNE_RETRY_INTERVAL_MS', PRUNE_RETRY_INTERVAL_MS, 1_000],
  ['PRUNE_ALREADY_RUNNING_TEXT', PRUNE_ALREADY_RUNNING_TEXT, 'a prune operation is already running'],
  ['LOCK_WAIT_MS', LOCK_WAIT_MS, 30_000],
  ['DEFAULT_ESTIMATE_SECONDS', DEFAULT_ESTIMATE_SECONDS, 2400],
  ['LIMIT_FACTOR', LIMIT_FACTOR, 2],
  ['LIMIT_ADDEND_MINUTES', LIMIT_ADDEND_MINUTES, 15],
  ['LIMIT_FLOOR_MINUTES', LIMIT_FLOOR_MINUTES, 30],
  ['SLOW_FACTOR', SLOW_FACTOR, 1.5],
  ['BUILD_ALLOWANCE_MINUTES', BUILD_ALLOWANCE_MINUTES, 30],
  ['BASE_BUILD_ALLOWANCE_MINUTES', BASE_BUILD_ALLOWANCE_MINUTES, 60],
  ['MERGE_ALLOWANCE_MINUTES', MERGE_ALLOWANCE_MINUTES, 15],
  // Shard figures.
  ['SECRET_MIN_LENGTH', SECRET_MIN_LENGTH, 8],
  ['SHARD_PIDS_LIMIT', SHARD_PIDS_LIMIT, 2048],
  ['CANARY_LENGTH', CANARY_LENGTH, 32],
  // Run-directory names.
  ['RUN_DIR_PREFIX', RUN_DIR_PREFIX, 'cscb-ci-'],
  ['STATUS_FILE_NAME', STATUS_FILE_NAME, 'status.json'],
  ['RUNNER_LOG_FILE_NAME', RUNNER_LOG_FILE_NAME, 'runner.log'],
  ['PACKAGE_DIR_NAME', PACKAGE_DIR_NAME, 'package'],
  ['RESULTS_FILE_NAME', RESULTS_FILE_NAME, 'results.json'],
  ['SUMMARY_FILE_NAME', SUMMARY_FILE_NAME, 'summary.txt'],
  ['VERDICT_FILE_NAME', VERDICT_FILE_NAME, 'verdict.txt'],
  ['SHARD_DIR_PREFIX', SHARD_DIR_PREFIX, 'shard-'],
  // In-shard names and words.
  ['CANARY_FILE_NAME', CANARY_FILE_NAME, 'canary.txt'],
  ['PACKAGE_SHA256_FILE_NAME', PACKAGE_SHA256_FILE_NAME, 'package.sha256'],
  ['RESULT_FILE_NAME', RESULT_FILE_NAME, 'result.txt'],
  ['DEPENDENCY_FINGERPRINT_FILE_NAME', DEPENDENCY_FINGERPRINT_FILE_NAME, 'dependency-fingerprint.txt'],
  ['DOCKER_LOG_FILE_NAME', DOCKER_LOG_FILE_NAME, 'docker.log'],
  ['SCRIPT_LOG_SUFFIX', SCRIPT_LOG_SUFFIX, '.log'],
  ['RESULT_WORD_START', RESULT_WORD_START, 'start'],
  ['RESULT_WORD_END', RESULT_WORD_END, 'end'],
  ['RESULT_WORD_PASS', RESULT_WORD_PASS, 'pass'],
  ['RESULT_WORD_FAIL', RESULT_WORD_FAIL, 'fail'],
  ['RESULT_WORD_NOTRUN', RESULT_WORD_NOTRUN, 'notrun'],
  ['RESULT_WORD_DONE', RESULT_WORD_DONE, 'done'],
  // Fixed texts.
  ['INJECTED_FAILURE_TEXT', INJECTED_FAILURE_TEXT, 'injected failure'],
  ['MARKER_REFUSAL_LINE', MARKER_REFUSAL_LINE, 'runner.sh: /etc/cscb-ci-image is absent: this runner runs only in a cscb-ci image (/ci); refusing to run'],
  ['MARKER_REFUSAL_EXIT_STATUS', MARKER_REFUSAL_EXIT_STATUS, 2],
  ['USAGE_PREFIX', USAGE_PREFIX, 'usage: '],
  ['NOT_RUN_PREFIX', NOT_RUN_PREFIX, 'NOT RUN: '],
  ['FAIL_PREFIX', FAIL_PREFIX, 'FAIL: '],
  ['REDACTION_PLACEHOLDER', REDACTION_PLACEHOLDER, '<redacted>'],
  // Labels and tags.
  ['CI_LABEL', CI_LABEL, 'cscb-ci'],
  ['CI_LABEL_VALUE', CI_LABEL_VALUE, '1'],
  ['OWNER_LABEL', OWNER_LABEL, 'cscb-ci-owner'],
  ['FAULT_LABEL', FAULT_LABEL, 'cscb-ci-fault'],
  ['FAULT_LABEL_VALUES', FAULT_LABEL_VALUES, ['drift', 'retag']],
  ['RUN_TAG_REPOSITORY', RUN_TAG_REPOSITORY, 'cscb-ci-run'],
  ['RUN_TAG_ROLES', RUN_TAG_ROLES, ['test', 'drift', 'retag']],
  // Formats and exits.
  ['STATUS_FORMAT_VERSION', STATUS_FORMAT_VERSION, 1],
  ['RESERVATION_FORMAT_VERSION', RESERVATION_FORMAT_VERSION, 1],
  ['RESULTS_FORMAT_VERSION', RESULTS_FORMAT_VERSION, 1],
  ['UNREADABLE_READING', UNREADABLE_READING, 'unreadable'],
  ['RUNNER_PATH_SUFFIX', RUNNER_PATH_SUFFIX, 'scripts/ci-run.ts'],
  ['USAGE_EXIT_STATUS', USAGE_EXIT_STATUS, 64],
  ['REFUSAL_EXIT_STATUS', REFUSAL_EXIT_STATUS, 2],
  ['FAILURE_EXIT_STATUS', FAILURE_EXIT_STATUS, 1],
  // Name patterns.
  ['SCRIPT_FILE_NAME_PATTERN', SCRIPT_FILE_NAME_PATTERN, /^test-(0|[1-9][0-9]*)-[a-z0-9-]+\.sh$/],
  ['NUMBER_FORM_PATTERN', NUMBER_FORM_PATTERN, /^test-(0|[1-9][0-9]*)$/],
  // Files and owners.
  ['RUN_ID_PATTERN', RUN_ID_PATTERN, /^([0-9]{4})([0-9]{2})([0-9]{2})t([0-9]{2})([0-9]{2})([0-9]{2})z-[a-z0-9]{8}$/],
  ['DEFAULT_TEMP_DIR', DEFAULT_TEMP_DIR, '/tmp'],
  ['RESERVATION_FILE_SUFFIX', RESERVATION_FILE_SUFFIX, '.json'],
  ['SHA256_HEX_LENGTH', SHA256_HEX_LENGTH, 64],
  ['RESULT_SECONDS_PATTERN', RESULT_SECONDS_PATTERN, /^(0|[1-9][0-9]*)\.[0-9]{3}$/],
  // Credential lookup.
  ['GH_AUTH_TOKEN_ARGV', GH_AUTH_TOKEN_ARGV, ['gh', 'auth', 'token']],
  ['GH_PERSONAL_CONFIG_SUBPATH', GH_PERSONAL_CONFIG_SUBPATH, '.config/gh-personal'],
  // Docker answers.
  ['DOCKER_NO_SUCH_IMAGE_TEXT', DOCKER_NO_SUCH_IMAGE_TEXT, 'No such image'],
  ['DOCKER_NO_SUCH_CONTAINER_TEXT', DOCKER_NO_SUCH_CONTAINER_TEXT, 'No such container'],
  // Worktree paths and the prerequisite keyword.
  ['INTEGRATION_DIR_PATH', INTEGRATION_DIR_PATH, 'tests/integration'],
  ['DURATION_TABLE_PATH', DURATION_TABLE_PATH, 'tests/ci-durations.tsv'],
  ['TEST_DOCKERFILE_PATH', TEST_DOCKERFILE_PATH, 'docker/Dockerfile.test'],
  ['BASE_DOCKERFILE_PATH', BASE_DOCKERFILE_PATH, 'docker/Dockerfile.test.base'],
  ['CI_REQUIRES_KEYWORD', CI_REQUIRES_KEYWORD, 'ci-requires:'],
  // Modes and child exits.
  ['RUN_DIR_MODE', RUN_DIR_MODE, 0o700],
  // No PRD or SRD value: the runner's choice for the files it writes, owner-only.
  ['WRITTEN_FILE_MODE', WRITTEN_FILE_MODE, 0o600],
  ['SIGNAL_EXIT_STATUS_BASE', SIGNAL_EXIT_STATUS_BASE, 128],
  // Credentials.
  ['RAW_KEY_PREFIX', RAW_KEY_PREFIX, 'sk-ant-'],
]

/** The banner that opens the runner's section 3; every constant this block pins is exported above it. */
const DATA_MODEL_BANNER = /^\/\/ 3\. Data model \(E1\)$/m

/** The names of the `export const` declarations above section 3 of the runner (sections 1 and 2). */
function exportedConstantsAboveDataModel(source: string): string[] {
  const end = source.search(DATA_MODEL_BANNER)
  if (end < 0) throw new Error('the runner has no section 3 banner')
  const file = ts.createSourceFile('ci-run.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names: string[] = []
  for (const statement of file.statements) {
    if (statement.getStart(file) >= end || !ts.isVariableStatement(statement)) continue
    const exported = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    }
  }
  return names
}

describe('constants (b.uqm SR-21.5)', () => {
  test.each(CONSTANT_PINS)('pins %s', (_name, actual, expected) => {
    expect(actual).toEqual(expected)
  })

  test('every exported constant of the runner sections 1 and 2 has exactly one pin case', () => {
    const pinned = CONSTANT_PINS.map(([name]) => name)
    const exported = exportedConstantsAboveDataModel(runnerSource())

    expect(new Set(pinned).size).toBe(pinned.length)
    expect([...exported].sort()).toEqual([...pinned].sort())
  })
})

// ===========================================================================
// E2 region
// ===========================================================================
//
// Validation stages 2–8 (b.uqm SR-2.3, SR-2.6, SR-3.1, SR-3.2, SR-3.4,
// SR-15.1; stage 7 of SR-2.4), PRD AC 15's validation half, AC 40 and AC 69.
// Each case builds its worktree under its own `mkdtempSync` root with E1's
// worktree builder; texts the builder has no variant for (CRLF line ends, a
// prerequisite line on line 1, an uppercase keyword, an unlistable directory,
// an unreadable script) are written by this region's own factories, and a
// FIFO by the shared `makeFifo`. Every refusal case also shows its reasons
// name their values (`expectNamed`), so a reason builder that dropped an
// argument fails even though both sides of the `toEqual` use it. Runs are
// driven in process: a valid run through the exported `validateRun`, a
// refused one through `main` with injected dependencies, its refusal read
// back from `status.json`.

// The E2 region's own imports: the names the file's first import block does not hold.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  badCredentialReason,
  badScriptNameReason,
  duplicateNumberReason,
  emptyPrerequisiteLineReason,
  extraPrerequisiteLineReason,
  faultScriptMissingReason,
  faultScriptNotInRunReason,
  faultShardOutOfRangeReason,
  integrationReadFailedText,
  main,
  matchesScriptGlob,
  missingApiKeyReason,
  missingTest1Reason,
  notRegularEntryReason,
  numberFormOf,
  prerequisiteCycleReason,
  prerequisiteOrderReason,
  readStatusFile,
  runDirPath,
  scriptReadFailedText,
  unknownPrerequisiteReason,
  unmatchedScriptReason,
  validateRun,
  type ExtraPrerequisiteLines,
  type MissingApiKeyCause,
  type Refusal,
  type RunnerDeps,
  type Script,
  type ValidatedRun,
} from '../scripts/ci-run.ts'
import {
  duplicateScriptFileName,
  minimalScriptText,
  prerequisiteLineText,
  realScriptFileNames,
  realScriptNumbers,
  type NonRegularEntry,
  type PrerequisiteLine,
  type WorktreeOptions,
} from './test-helpers/ci-run.ts'
import { writtenFile } from './test-helpers/credentials.ts'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'
import { treeSnapshot } from './test-helpers/tree-snapshot.ts'

/** Test data: the RUN_ID of every driven run, each in its own temp directory. */
const E2_RUN_ID = '20261008t120000z-e2valid1'
/** Test data: the runner's PID and user. */
const E2_RUNNER_PID = 4343
const E2_RUNNER_UID = 1000
/** Test data: the runner's start. */
const E2_START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)

/** The file names of real scripts `ns`, looked up by number in the repository's listing. */
function files(...ns: readonly number[]): string[] {
  return ns.map(scriptFile)
}

function namesOf(scripts: readonly Script[]): string[] {
  return scripts.map((script) => script.fileName)
}

/** Each unit's file names, units in order. */
function unitsOf(run: ValidatedRun): string[][] {
  return run.units.map((unit) => namesOf(unit.scripts))
}

/** The refusal a stage's failures give (b.uqm SR-2.6): kind null, the first reason the summary, each other one a detail line. */
function stageRefusalOf(reasons: readonly string[]): Refusal {
  const [summary, ...details] = reasons
  if (summary === undefined) throw new Error('stageRefusalOf: no reason')
  return { kind: null, summary, details }
}

/** A refusal's reasons in order: its summary, then each detail line. */
function reasonLinesOf(refusal: Refusal): string[] {
  return [refusal.summary, ...refusal.details]
}

/**
 * Asserts the refusal's reason lines name their values, line `i` holding each
 * of `named[i]`: a reason builder that dropped an argument would still give the
 * same refusal on both sides of a `toEqual`, so each case shows its values here.
 */
function expectNamed(refusal: Refusal, named: readonly (readonly string[])[]): void {
  const lines = reasonLinesOf(refusal)
  expect(lines.length).toBe(named.length)
  named.forEach((values, i) => {
    for (const value of values) expect(lines[i]).toContain(value)
  })
}

/** A valid script file name for a number the repository does not use, with `slug`: for entries no real script may have. */
function unusedNumberFileName(slug: string): string {
  return `${numberFormOf(Math.max(...realScriptNumbers()) + 1)}-${slug}.sh`
}

/** A file name with a real script's number form and a slug no script has (`test-3-wrong.sh`). */
function wrongSlugFileName(n: number): string {
  return `${numberForm(n)}-wrong.sh`
}

/** Lines as a file's text, each ended by a line feed. */
function textOf(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

/** The shebang every built script starts with. */
function shebangOf(fileName: string): string {
  return minimalScriptText(fileName).split('\n')[0]
}

/** A thrown error's message: the text a runner read failure carries, taken from the same call made here. */
function errorMessageOf(read: () => unknown): string {
  try {
    read()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('errorMessageOf: the read did not fail')
}

/** Fake credentials for a valid run (b.uqm SR-21.2). */
function validEnv(): ChildEnvironmentSource {
  return { ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw'), GH_TOKEN: fakeToken('', 'gh') }
}

/** A key that does not begin with the raw-key prefix: valid only with `ANTHROPIC_BASE_URL` set. */
function gatewayKey(): string {
  return fakeToken('gw-', 'gateway')
}

/** A secret cut from a built fake to `length` characters. */
function secretOfLength(suffix: string, length: number): string {
  return fakeToken('', suffix).slice(0, length)
}

const isRoot = process.getuid?.() === 0

describe('E2: validation stages 2–8 (b.uqm SR-2.3, SR-2.6, SR-3.1, SR-3.2, SR-3.4, SR-15.1)', () => {
  let root: string
  let recorders: SpawnRecorder[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-interface-e2-'))
    recorders = []
  })

  afterEach(() => {
    const built = recorders
    recorders = []
    try {
      for (const recorder of built) recorder.assertNoFailures()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** A worktree built under the case's root. */
  function worktree(options: WorktreeOptions = {}): string {
    return buildWorktree(root, options).root
  }

  function integrationDirOf(worktreeRoot: string): string {
    return join(worktreeRoot, INTEGRATION_DIR_PATH)
  }

  /** Replaces one script's text with `text`. */
  function writeScript(worktreeRoot: string, fileName: string, text: string): void {
    writeFileSync(join(integrationDirOf(worktreeRoot), fileName), text)
  }

  /** Main's world for one refused run: every dependency validation must not reach records its use and throws. */
  interface MainRig {
    readonly deps: RunnerDeps
    readonly recorder: SpawnRecorder
    readonly forbiddenCalls: string[]
    readonly stderr: string[]
    readonly lockDir: string
    readonly runDir: string
  }

  function mainRig(worktreeRoot: string, env: ChildEnvironmentSource): MainRig {
    const tempDir = mkdtempSync(join(root, 'tmp-'))
    const clock = createFakeClock({ start: E2_START_MS })
    const recorder = createSpawnRecorder({ clock })
    recorders.push(recorder)
    const forbiddenCalls: string[] = []
    const stderr: string[] = []
    const forbidden =
      (name: string) =>
      (): never => {
        forbiddenCalls.push(name)
        throw new Error(`${name} must not be called during validation`)
      }
    const lockDir = join(root, 'lock')
    const deps: RunnerDeps = {
      spawn: recorder.spawn,
      env: { ...env, TMPDIR: tempDir },
      pid: E2_RUNNER_PID,
      uid: E2_RUNNER_UID,
      worktreeRoot,
      lockDir,
      readPasswordFile: forbidden('readPasswordFile'),
      readCgroupFile: forbidden('readCgroupFile'),
      readProcCmdline: forbidden('readProcCmdline'),
      readProcCwd: forbidden('readProcCwd'),
      readProcCgroup: forbidden('readProcCgroup'),
      readVolume: forbidden('readVolume'),
      clock,
      randomBytes: forbidden('randomBytes'),
      sendSignal: forbidden('sendSignal'),
      onSignal: forbidden('onSignal'),
      isPidAlive: forbidden('isPidAlive'),
      writeStderr: (text) => {
        stderr.push(text)
      },
    }
    return { deps, recorder, forbiddenCalls, stderr, lockDir, runDir: runDirPath(deps.env, E2_RUN_ID) }
  }

  /**
   * The exported validated result of a run that passes every stage; fails the
   * case when it is refused, or when the result (its prerequisite map's entries
   * included) fails `assertNoLeak`.
   */
  function validated(worktreeRoot: string, args: readonly string[] = [], env: ChildEnvironmentSource = validEnv()): ValidatedRun {
    const validation = validateRun(args, worktreeRoot, env)
    if (!validation.ok) throw new Error(`refused: ${JSON.stringify(validation.refusal)}`)
    assertNoLeak({ validation, prerequisites: [...validation.validated.prerequisites] })
    return validation.validated
  }

  /** A refused run as main records it. */
  interface RefusedRun {
    readonly refusal: Refusal
    readonly rig: MainRig
    /** The runner log's lines. */
    readonly logLines: readonly string[]
  }

  /**
   * The E2 driver for a refused run: steps 1 and 2 through `main` with injected
   * dependencies over the worktree, arguments and environment. Fails the case
   * unless main exits with the refusal status, `status.json` holds phase
   * `refused` and the refusal `validateRun` gives, and nothing was spawned;
   * every output, the run directory included, passes `assertNoLeak`.
   */
  async function refused(worktreeRoot: string, args: readonly string[] = [], env: ChildEnvironmentSource = validEnv()): Promise<RefusedRun> {
    const validation = validateRun(args, worktreeRoot, env)
    if (validation.ok) throw new Error(`validated: ${JSON.stringify(namesOf(validation.validated.runScripts))}`)
    const rig = mainRig(worktreeRoot, env)
    const exit = await main([E2_RUN_ID, ...args], rig.deps)
    const status = readStatusFile(rig.runDir)
    const logText = readFileSync(join(rig.runDir, RUNNER_LOG_FILE_NAME), 'utf-8')
    assertNoLeak({ validation, status, stderr: rig.stderr, runDir: writtenFile(rig.runDir) })
    expect(exit).toBe(REFUSAL_EXIT_STATUS)
    expect(status?.phase).toBe('refused')
    expect(status?.refusal).toEqual(validation.refusal)
    expect(rig.recorder.spawns()).toEqual([])
    return { refusal: validation.refusal, rig, logLines: logText.split('\n').slice(0, -1) }
  }

  /**
   * Asserts no output of a refused run holds a credential value of `env`, a
   * value cut too short to hold the whole leak sentinel included (which
   * `assertNoLeak` alone would miss): each refusal names the variable, never its value.
   */
  function expectNoValueShown(run: RefusedRun, env: ChildEnvironmentSource): void {
    const outputs = [
      JSON.stringify(run.refusal),
      readFileSync(join(run.rig.runDir, STATUS_FILE_NAME), 'utf-8'),
      readFileSync(join(run.rig.runDir, RUNNER_LOG_FILE_NAME), 'utf-8'),
      ...run.rig.stderr,
    ]
    for (const value of [env.ANTHROPIC_API_KEY, env.GH_TOKEN]) {
      if (value === undefined || value === '') continue
      for (const output of outputs) expect(output).not.toContain(value)
    }
  }

  // -------------------------------------------------------------------------
  // T5.S1: discovery, naming, duplicate numbers and a missing test-1 (SR-2.3; stages 2–4)
  // -------------------------------------------------------------------------

  describe('discovery, naming, duplicate numbers and a missing test-1 (b.uqm SR-2.3)', () => {
    test('only regular files matching test-*.sh are scripts: other files, directories and links in tests/integration are ignored', () => {
      const wt = worktree({
        extraScripts: ['helper.sh', 'notes.txt', 'xtest-3.sh'],
        nonRegular: [
          { kind: 'directory', name: 'lib' },
          { kind: 'symlink', name: 'latest.sh', target: scriptFile(2) },
        ],
      })

      expect(namesOf(validated(wt).scripts)).toEqual(realScriptFileNames())
    })

    test('a newly added, validly named script is found by the next run with no other edit; test-0 is a valid number', () => {
      const wt = worktree()
      const added = unusedNumberFileName('added')
      expect(namesOf(validated(wt).scripts)).toEqual(realScriptFileNames())

      writeScript(wt, added, minimalScriptText(added))

      expect(namesOf(validated(wt).scripts)).toEqual([...realScriptFileNames(), added])
      expect(namesOf(validated(wt, [added]).runScripts)).toEqual([scriptFile(1), added])
      expect(namesOf(validated(wt, [numberForm(0)]).runScripts)).toEqual(files(1, 0))
    })

    test.each(['test-5.sh', 'test-05-x.sh', 'test-x-y.sh'])('%s breaks the naming rule: the run is refused naming it', async (name) => {
      const { refusal } = await refused(worktree({ extraScripts: [name] }))

      expect(refusal).toEqual(stageRefusalOf([badScriptNameReason(name)]))
      expect(refusal.summary).toContain(name)
    })

    const NON_REGULAR_ROWS: readonly (readonly [string, () => NonRegularEntry])[] = [
      ['a symbolic link to a valid script, judged as the link and never followed', () => ({ kind: 'symlink', name: unusedNumberFileName('link'), target: scriptFile(2) })],
      ['a dangling symbolic link', () => ({ kind: 'symlink', name: unusedNumberFileName('dangling'), target: unusedNumberFileName('nowhere') })],
      ['a directory named test-*.sh', () => ({ kind: 'directory', name: unusedNumberFileName('dir') })],
    ]

    test.each(NON_REGULAR_ROWS)('%s is refused, naming the entry', async (_label, entry) => {
      const nonRegular = entry()
      const { refusal } = await refused(worktree({ nonRegular: [nonRegular] }))

      expect(refusal).toEqual(stageRefusalOf([notRegularEntryReason(nonRegular.name, nonRegular.kind)]))
      expect(refusal.summary).toContain(nonRegular.name)
    })

    test.skipIf(!mkfifoAvailable())(
      'a FIFO named test-*.sh is refused naming it as a special file; the runner only lstats it, never opening it (skipped where mkfifo is unavailable)',
      async () => {
        const wt = worktree()
        const name = unusedNumberFileName('fifo')
        makeFifo(join(integrationDirOf(wt), name))

        const { refusal } = await refused(wt)

        expect(refusal).toEqual(stageRefusalOf([notRegularEntryReason(name, 'other')]))
        expect(refusal.summary).toContain(name)
        for (const kind of ['symlink', 'directory'] as const) expect(refusal.summary).not.toBe(notRegularEntryReason(name, kind))
      },
    )

    test('two scripts with one number are refused, naming both files', async () => {
      // A duplicate's name is the real name with `-duplicate` before `.sh`, so it sorts first bytewise (`-` before `.`).
      const { refusal } = await refused(worktree({ extraScripts: [duplicateScriptFileName(5)] }))

      expect(refusal).toEqual(stageRefusalOf([duplicateNumberReason(numberForm(5), [duplicateScriptFileName(5), scriptFile(5)])]))
      expectNamed(refusal, [[duplicateScriptFileName(5), scriptFile(5), numberForm(5)]])
    })

    test.each([
      ['a worktree with no test-1', (wt: string) => rmSync(join(integrationDirOf(wt), scriptFile(1)))],
      ['a worktree with no tests/integration', (wt: string) => rmSync(integrationDirOf(wt), { recursive: true })],
    ] as const)('%s is refused, naming the missing test-1', async (_label, remove) => {
      const wt = worktree()
      remove(wt)

      const { refusal } = await refused(wt)

      expect(refusal).toEqual(stageRefusalOf([missingTest1Reason()]))
      expectNamed(refusal, [[numberForm(1), INTEGRATION_DIR_PATH]])
    })

    test('a tests/integration that exists but cannot be listed is refused with the read failure, naming the directory', async () => {
      const wt = worktree()
      const dir = integrationDirOf(wt)
      rmSync(dir, { recursive: true })
      writeFileSync(dir, '')

      const { refusal } = await refused(wt)

      expect(refusal).toEqual(stageRefusalOf([integrationReadFailedText(dir, errorMessageOf(() => readdirSync(dir, { encoding: 'buffer' })))]))
    })

    test.skipIf(isRoot)('a script that cannot be read is refused with the read failure, naming its path (skipped as root, which reads any file)', async () => {
      const wt = worktree()
      const path = join(integrationDirOf(wt), scriptFile(5))
      chmodSync(path, 0)
      try {
        const { refusal } = await refused(wt)

        expect(refusal).toEqual(stageRefusalOf([scriptReadFailedText(path, errorMessageOf(() => readFileSync(path, 'utf-8')))]))
      } finally {
        chmodSync(path, 0o644)
      }
    })
  })

  // -------------------------------------------------------------------------
  // T5.S2: the selection stage and the run's scripts (SR-2.3; stage 5)
  // -------------------------------------------------------------------------

  describe("the selection and the run's scripts (b.uqm SR-2.3, Terms)", () => {
    test('a number form matches only exactly that number: test-2 selects test-2, never test-20', () => {
      expect(realScriptNumbers()).toContain(20)

      const run = validated(worktree(), [numberForm(2)])

      expect(run.selection.kind === 'selective' ? namesOf(run.selection.selected) : null).toEqual(files(2))
      expect(namesOf(run.runScripts)).toEqual(files(1, 2))
    })

    test.each([
      ['a whole file name', () => [scriptFile(5)]],
      ['the number form twice', () => [numberForm(5), numberForm(5)]],
      ['the file name twice', () => [scriptFile(5), scriptFile(5)]],
      ['both forms', () => [scriptFile(5), numberForm(5)]],
    ] as const)('a script selected by %s runs once', (_label, args) => {
      const run = validated(worktree(), args())

      expect(run.selection.kind === 'selective' ? namesOf(run.selection.selected) : null).toEqual(files(5))
      expect(namesOf(run.runScripts)).toEqual(files(1, 5))
    })

    // Each row's SCRIPTs, each matching nothing, and the text each one's reason shows it as (an empty one quoted).
    test.each([
      ['test-999', () => ['test-999'], () => ['test-999']],
      ['a well-formed file name no script has', () => [wrongSlugFileName(5)], () => [wrongSlugFileName(5)]],
      ['an empty SCRIPT', () => [''], () => [JSON.stringify('')]],
      ['test-999 twice: one failure per occurrence', () => ['test-999', 'test-999'], () => ['test-999', 'test-999']],
    ] as const)('a SCRIPT matching nothing is refused naming it as given: %s', async (_label, args, shown) => {
      const { refusal } = await refused(worktree(), args())

      expect(refusal).toEqual(stageRefusalOf(args().map((arg) => unmatchedScriptReason(arg))))
      expectNamed(refusal, shown().map((value) => [value]))
    })

    test("the run's scripts are the selected ones, their prerequisites followed through a chain of three, and test-1", () => {
      const wt = worktree({ prerequisites: { 7: [{ names: [6] }], 6: [{ names: [5] }] } })

      expect(namesOf(validated(wt, [numberForm(7)]).runScripts)).toEqual(files(1, 5, 6, 7))
      expect(namesOf(validated(wt, [scriptFile(6), numberForm(10)]).runScripts)).toEqual(files(1, 5, 6, 10))
    })

    test("a full run's scripts are every script", () => {
      const run = validated(worktree())

      expect(run.selection).toEqual({ kind: 'full' })
      expect(namesOf(run.runScripts)).toEqual(realScriptFileNames())
    })
  })

  // -------------------------------------------------------------------------
  // T5.S3: prerequisite lines and header refusals (SR-3.1, SR-3.2; stage 6)
  // -------------------------------------------------------------------------

  describe('prerequisite lines and header refusals (b.uqm SR-3.1, SR-3.2)', () => {
    const ACCEPTED_LINE_ROWS: readonly (readonly [string, () => PrerequisiteLine, readonly number[]])[] = [
      ['spaces between # and the keyword', () => ({ names: [5], afterHash: '   ' }), [5]],
      ['tabs between # and the keyword', () => ({ names: [5], afterHash: '\t\t' }), [5]],
      ['nothing between # and the keyword', () => ({ names: [5], afterHash: '' }), [5]],
      ['names separated by mixed spaces and tabs, with trailing whitespace', () => ({ names: [5, 4], separator: ' \t ', trailing: ' \t' }), [4, 5]],
      ['names given as whole file names', () => ({ names: [scriptFile(5), scriptFile(4)] }), [4, 5]],
      ['one script named in both forms', () => ({ names: [numberForm(5), scriptFile(5)] }), [5]],
      ['the line as the second line, right after the shebang', () => ({ names: [5], placement: 'second-line' }), [5]],
    ]

    test.each(ACCEPTED_LINE_ROWS)("test-6's line with %s is read", (_label, line, prerequisites) => {
      const run = validated(worktree({ prerequisites: { 6: [line()] } }))

      expect(run.prerequisites.get(scriptFile(6))).toEqual(files(...prerequisites))
    })

    test('an uppercase keyword is not a prerequisite line', () => {
      const wt = worktree()
      writeScript(wt, scriptFile(6), textOf([shebangOf(scriptFile(6)), `# ${CI_REQUIRES_KEYWORD.toUpperCase()} ${numberForm(5)}`, 'true']))

      expect(validated(wt).prerequisites.get(scriptFile(6))).toEqual([])
    })

    test('test-1 named in any script, test-1 itself included, is ignored; test-0 may name test-4, which comes first in canonical order', () => {
      const run = validated(worktree({ prerequisites: { 1: [{ names: [1] }], 6: [{ names: [1] }], 0: [{ names: [4] }] } }))

      expect(run.prerequisites.get(scriptFile(1))).toEqual([])
      expect(run.prerequisites.get(scriptFile(6))).toEqual([])
      expect(run.prerequisites.get(scriptFile(0))).toEqual(files(4))
    })

    const MISPLACED_ROWS: readonly (readonly [string, readonly PrerequisiteLine[], ExtraPrerequisiteLines])[] = [
      ['a line below the header block', [{ names: [5], placement: 'below-header' }], 'outside'],
      ['an indented line', [{ names: [5], placement: 'indented' }], 'outside'],
      ['a tab-indented line', [{ names: [5], placement: 'indented', indent: '\t' }], 'outside'],
      ['a second line in the header block', [{ names: [5] }, { names: [4] }], 'second'],
      ['a second line and one below the header block', [{ names: [5] }, { names: [4] }, { names: [4], placement: 'below-header' }], 'both'],
    ]

    test.each(MISPLACED_ROWS)('%s is refused, naming the script', async (_label, lines, extra) => {
      const { refusal } = await refused(worktree({ prerequisites: { 6: lines } }))

      expect(refusal).toEqual(stageRefusalOf([extraPrerequisiteLineReason(scriptFile(6), extra)]))
      expectNamed(refusal, [[scriptFile(6)]])
    })

    test('a prerequisite line on line 1 is outside the header block, which follows the first line', async () => {
      const wt = worktree()
      writeScript(wt, scriptFile(6), textOf([prerequisiteLineText({ names: [5] }), '# a script whose first line is a prerequisite line', 'true']))

      const { refusal } = await refused(wt)

      expect(refusal).toEqual(stageRefusalOf([extraPrerequisiteLineReason(scriptFile(6), 'outside')]))
      expectNamed(refusal, [[scriptFile(6)]])
    })

    test.each([
      ['an unknown name, naming the script and the name', [{ names: ['test-999'] }], () => [unknownPrerequisiteReason(scriptFile(6), 'test-999')], () => [[scriptFile(6), 'test-999']]],
      ['an unknown name beside a known one', [{ names: [5, 'test-999'] }], () => [unknownPrerequisiteReason(scriptFile(6), 'test-999')], () => [[scriptFile(6), 'test-999']]],
      [
        'the same unknown name twice in one line: one failure',
        [{ names: ['test-999', 'test-999'] }],
        () => [unknownPrerequisiteReason(scriptFile(6), 'test-999')],
        () => [[scriptFile(6), 'test-999']],
      ],
      ['an empty line, naming the script', [{ names: [] }], () => [emptyPrerequisiteLineReason(scriptFile(6))], () => [[scriptFile(6)]]],
    ] as const)('%s is refused', async (_label, lines, reasons, named) => {
      const { refusal } = await refused(worktree({ prerequisites: { 6: lines } }))

      expect(refusal).toEqual(stageRefusalOf(reasons()))
      expectNamed(refusal, named())
    })

    test("a CRLF script's test-2 followed by a carriage return is an unknown name, shown on one line", async () => {
      const wt = worktree()
      writeScript(wt, scriptFile(3), minimalScriptText(scriptFile(3), [{ names: [2] }]).replace(/\n/g, '\r\n'))

      const { refusal } = await refused(wt)

      expect(refusal).toEqual(stageRefusalOf([unknownPrerequisiteReason(scriptFile(3), `${numberForm(2)}\r`)]))
      expectNamed(refusal, [[scriptFile(3), numberForm(2)]])
      expect(refusal.summary).not.toMatch(/[\r\n]/)
    })

    const CYCLE_ROWS: readonly (readonly [string, Readonly<Record<number, readonly PrerequisiteLine[]>>, readonly (readonly number[])[]])[] = [
      ['two scripts', { 5: [{ names: [6] }], 6: [{ names: [5] }] }, [[5, 6]]],
      ['three scripts', { 5: [{ names: [7] }], 6: [{ names: [5] }], 7: [{ names: [6] }] }, [[5, 6, 7]]],
      ['a script other than test-1 naming itself', { 6: [{ names: [6] }] }, [[6]]],
      ['two disjoint cycles, two refusals', { 5: [{ names: [6] }], 6: [{ names: [5] }], 7: [{ names: [8] }], 8: [{ names: [7] }] }, [[5, 6], [7, 8]]],
    ]

    test.each(CYCLE_ROWS)('a cycle of %s is one refusal per cycle naming its scripts, and its links add no ordering refusal', async (_label, prerequisites, cycles) => {
      const { refusal } = await refused(worktree({ prerequisites }))

      expect(refusal).toEqual(stageRefusalOf(cycles.map((cycle) => prerequisiteCycleReason(files(...cycle)))))
      expectNamed(refusal, cycles.map((cycle) => files(...cycle)))
    })

    test.each([
      ['test-5 naming test-6', { 5: [{ names: [6] }] }, [5, 6]],
      ['test-4 naming test-0, which follows test-4 in canonical order though numerically first', { 4: [{ names: [0] }] }, [4, 0]],
      ["test-1 naming test-5 while test-5 names test-1: an ordering refusal, never a cycle", { 1: [{ names: [5] }], 5: [{ names: [1] }] }, [1, 5]],
    ] as const)('a prerequisite that sorts after its dependent is refused naming both: %s', async (_label, prerequisites, [dependent, prerequisite]) => {
      const { refusal } = await refused(worktree({ prerequisites }))

      expect(refusal).toEqual(stageRefusalOf([prerequisiteOrderReason(scriptFile(dependent), scriptFile(prerequisite))]))
      expectNamed(refusal, [[scriptFile(dependent), scriptFile(prerequisite)]])
    })

    test('/ci test-1 is refused for a cycle between two other scripts, outside its selection', async () => {
      const wt = worktree({ prerequisites: { 5: [{ names: [6] }], 6: [{ names: [5] }] } })

      const { refusal } = await refused(wt, [numberForm(1)])

      expect(refusal).toEqual(stageRefusalOf([prerequisiteCycleReason(files(5, 6))]))
      expectNamed(refusal, [files(5, 6)])
    })
  })

  // -------------------------------------------------------------------------
  // T5.S4: scheduling units, the effective N and the current tree (SR-3.4, SR-3.5)
  // -------------------------------------------------------------------------

  describe('scheduling units, the effective N and the current tree (b.uqm SR-3.4, SR-3.5)', () => {
    const UNIT_ROWS: readonly (readonly [string, Readonly<Record<number, readonly PrerequisiteLine[]>>, () => readonly string[], () => readonly (readonly number[])[]])[] = [
      [
        'scripts with no link are one unit each, and test-1 is in none',
        {},
        () => [],
        () => realScriptNumbers().filter((n) => n !== 1).map((n) => [n]),
      ],
      ['a chain of three forms one unit in canonical order', { 7: [{ names: [6] }], 6: [{ names: [5] }] }, () => [numberForm(7)], () => [[5, 6, 7]]],
      ['two scripts sharing a prerequisite form one unit holding it once', { 6: [{ names: [5] }], 7: [{ names: [5] }] }, () => [numberForm(7), numberForm(6)], () => [[5, 6, 7]]],
      [
        "a selective run's units cover only the run's scripts",
        { 7: [{ names: [6] }], 6: [{ names: [5] }], 9: [{ names: [8] }] },
        () => [numberForm(10), numberForm(7)],
        () => [[5, 6, 7], [10]],
      ],
    ]

    test.each(UNIT_ROWS)('%s', (_label, prerequisites, args, units) => {
      expect(unitsOf(validated(worktree({ prerequisites }), args()))).toEqual(units().map((unit) => files(...unit)))
    })

    test.each([
      // PRD AC 15: `/ci test-1` gets an effective N of 1, the lowest N.
      ['/ci test-1: no units, so the lowest N', () => [numberForm(1)], () => ({ requested: MAX_SHARDS, units: 0, effective: OPTION_RANGE_MIN })],
      // PRD AC 15: the inputs of `shards: 2 of 4 (2 scheduling unit(s))`.
      ['--shards 4 over 2 units: the unit count', () => ['--shards', '4', numberForm(5), numberForm(6)], () => ({ requested: 4, units: 2, effective: 2 })],
      ['--shards 2 over 3 units: the requested N', () => ['--shards', '2', numberForm(5), numberForm(6), numberForm(7)], () => ({ requested: 2, units: 3, effective: 2 })],
      ['a default run over many units: the default', () => [], () => ({ requested: MAX_SHARDS, units: realScriptNumbers().length - 1, effective: MAX_SHARDS })],
    ] as const)('the effective N is the smaller of the requested N and the unit count, at least the lowest N: %s', (_label, args, expected) => {
      const run = validated(worktree(), args())

      expect({ requested: run.requestedShards, units: run.units.length, effective: run.effectiveShards }).toEqual(expected())
    })

    test('the current tree, copied from the repository, passes every stage: 29 scripts, 27 units, test-2 and test-3 in one unit', () => {
      const source = join(REPO_ROOT, INTEGRATION_DIR_PATH)
      const entries = readdirSync(source, { withFileTypes: true }).filter((entry) => matchesScriptGlob(entry.name))
      expect(entries.filter((entry) => !entry.isFile()).map((entry) => entry.name)).toEqual([])
      const copy = join(mkdtempSync(join(root, 'current-tree-')), INTEGRATION_DIR_PATH)
      mkdirSync(copy, { recursive: true })
      for (const entry of entries) writeFileSync(join(copy, entry.name), readFileSync(join(source, entry.name)))

      const run = validated(join(copy, '..', '..'))

      expect(run.scripts.length).toBe(29)
      expect(run.units.length).toBe(27)
      expect(unitsOf(run).filter((unit) => unit.length > 1)).toEqual([files(2, 3)])
      expect(run.prerequisites.get(scriptFile(3))).toEqual(files(2))
    })
  })

  // -------------------------------------------------------------------------
  // T5.S5: stage 7, the faults' scripts and shard numbers (SR-2.4)
  // -------------------------------------------------------------------------

  describe("stage 7: the faults' scripts and shard numbers (b.uqm SR-2.4)", () => {
    /** A fault-script failure: its reason builder, the fault as typed and its script as typed. */
    type FaultScriptFailure = readonly [typeof faultScriptMissingReason, string, string]

    const FAULT_SCRIPT_ROWS: readonly (readonly [string, () => readonly string[], () => readonly FaultScriptFailure[]])[] = [
      ['fail: naming test-999', () => ['--inject', 'fail:test-999'], () => [[faultScriptMissingReason, 'fail:test-999', 'test-999']]],
      ['timeout: naming test-999', () => ['--inject', 'timeout:test-999'], () => [[faultScriptMissingReason, 'timeout:test-999', 'test-999']]],
      [
        "a real script's number with a wrong slug",
        () => ['--inject', `fail:${wrongSlugFileName(3)}`],
        () => [[faultScriptMissingReason, `fail:${wrongSlugFileName(3)}`, wrongSlugFileName(3)]],
      ],
      [
        "the wrong slug given second, after the same script's correct form",
        () => ['--inject', `timeout:${scriptFile(3)}`, '--inject', `timeout:${wrongSlugFileName(3)}`],
        () => [[faultScriptMissingReason, `timeout:${wrongSlugFileName(3)}`, wrongSlugFileName(3)]],
      ],
      [
        'the same failing fault given twice: one failure per occurrence',
        () => ['--inject', 'fail:test-999', '--inject', 'fail:test-999'],
        () => [
          [faultScriptMissingReason, 'fail:test-999', 'test-999'],
          [faultScriptMissingReason, 'fail:test-999', 'test-999'],
        ],
      ],
      [
        "an existing script outside the selective run's scripts",
        () => [numberForm(5), '--inject', `fail:${numberForm(6)}`],
        () => [[faultScriptNotInRunReason, `fail:${numberForm(6)}`, numberForm(6)]],
      ],
    ]

    test.each(FAULT_SCRIPT_ROWS)('%s is refused, naming the fault and the script as typed', async (_label, args, failures) => {
      const { refusal } = await refused(worktree(), args())

      expect(refusal).toEqual(stageRefusalOf(failures().map(([reason, fault, script]) => reason(fault, script))))
      expectNamed(refusal, failures().map(([, fault]) => [fault]))
      // Each line names the script apart from the fault holding it.
      reasonLinesOf(refusal).forEach((line, i) => expect(line.replace(failures()[i]![1], '')).toContain(failures()[i]![2]))
    })

    test('fail: naming test-1 and timeout: naming a prerequisite the run added transitively are accepted', () => {
      const wt = worktree({ prerequisites: { 7: [{ names: [6] }], 6: [{ names: [5] }] } })

      const run = validated(wt, [numberForm(7), '--inject', `fail:${numberForm(1)}`, '--inject', `timeout:${scriptFile(5)}`])

      expect(namesOf(run.runScripts)).toEqual(files(1, 5, 6, 7))
    })

    /** Each row's fault as typed, its out-of-range shard number as typed and the effective N. */
    const SHARD_ROWS: readonly (readonly [string, () => readonly string[], () => readonly [string, string, number]])[] = [
      ['--shards 3 --inject kill:4', () => ['--shards', '3', '--inject', 'kill:4'], () => ['kill:4', '4', 3]],
      ['test-2 --inject kill:2, effective N 1', () => [numberForm(2), '--inject', 'kill:2'], () => ['kill:2', '2', 1]],
      ['kill:0', () => ['--inject', 'kill:0'], () => ['kill:0', '0', MAX_SHARDS]],
      ['image-drift above the effective N', () => ['--shards', '2', '--inject', 'image-drift:3'], () => ['image-drift:3', '3', 2]],
      ['a leak whose second number alone is out of range', () => ['--shards', '2', '--inject', 'leak:1,3'], () => ['leak:1,3', '3', 2]],
      ['a shard number past 2^53, named by its typed digits', () => ['--inject', `kill:${HUGE_DIGITS}`], () => [`kill:${HUGE_DIGITS}`, HUGE_DIGITS, MAX_SHARDS]],
      [
        'kill:3 with the maximum N requested over 2 units: the effective N, not the requested N',
        () => ['--shards', String(MAX_SHARDS), numberForm(5), numberForm(6), '--inject', 'kill:3'],
        () => ['kill:3', '3', 2],
      ],
    ]

    test.each(SHARD_ROWS)('a shard number outside 1 to the effective N is refused, naming the fault, the number and the effective N: %s', async (_label, args, failure) => {
      const [fault, shard, effective] = failure()
      const { refusal } = await refused(worktree(), args())

      expect(refusal).toEqual(stageRefusalOf([faultShardOutOfRangeReason(fault, shard, effective)]))
      expectNamed(refusal, [[fault]])
      // The shard number is named apart from the fault holding it, and the effective N apart from both.
      const afterFault = refusal.summary.replace(fault, '')
      expect(afterFault).toContain(shard)
      expect(afterFault.replace(shard, '')).toContain(String(effective))
    })

    test('shard numbers equal to the effective N are accepted, and retag passes stage 7', () => {
      const run = validated(worktree(), ['--shards', '3', '--inject', 'kill:3', '--inject', 'image-drift:3', '--inject', 'leak:3,1', '--inject', 'retag'])

      expect(run.effectiveShards).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // T5.S6: the step-2 credentials (SR-15.1; stage 8)
  // -------------------------------------------------------------------------

  describe('the step-2 credentials (b.uqm SR-15.1)', () => {
    /** The variable a missing credential names. */
    const API_KEY_NAME = 'ANTHROPIC_API_KEY'

    const MISSING_ROWS: readonly (readonly [string, () => ChildEnvironmentSource, MissingApiKeyCause])[] = [
      ['unset', () => ({ GH_TOKEN: fakeToken('', 'gh') }), 'unset'],
      ['empty', () => ({ ANTHROPIC_API_KEY: '', GH_TOKEN: fakeToken('', 'gh') }), 'empty'],
      ['a key not beginning with the raw-key prefix while ANTHROPIC_BASE_URL is unset', () => ({ ANTHROPIC_API_KEY: gatewayKey(), GH_TOKEN: fakeToken('', 'gh') }), 'not-raw-key'],
      ['the same key with ANTHROPIC_BASE_URL empty, which counts as unset', () => ({ ANTHROPIC_API_KEY: gatewayKey(), ANTHROPIC_BASE_URL: '', GH_TOKEN: fakeToken('', 'gh') }), 'not-raw-key'],
      [
        'a key both missing and too short: one missing-credential failure only',
        () => ({ ANTHROPIC_API_KEY: secretOfLength('short', SECRET_MIN_LENGTH - 1), GH_TOKEN: fakeToken('', 'gh') }),
        'not-raw-key',
      ],
    ]

    test.each(MISSING_ROWS)('ANTHROPIC_API_KEY %s is a missing credential, naming the variable', async (_label, env, cause) => {
      const run = await refused(worktree(), [], env())

      expect(run.refusal).toEqual(stageRefusalOf([missingApiKeyReason(cause)]))
      expectNamed(run.refusal, [[API_KEY_NAME]])
      expectNoValueShown(run, env())
    })

    const BAD_ROWS: readonly (readonly [string, () => ChildEnvironmentSource, 'ANTHROPIC_API_KEY' | 'GH_TOKEN'])[] = [
      [
        'ANTHROPIC_API_KEY one character below the minimum',
        () => ({ ANTHROPIC_API_KEY: secretOfLength('short', SECRET_MIN_LENGTH - 1), ANTHROPIC_BASE_URL: GATEWAY_URL, GH_TOKEN: fakeToken('', 'gh') }),
        'ANTHROPIC_API_KEY',
      ],
      [
        'ANTHROPIC_API_KEY one code point below the minimum, one of them astral, so as long as the minimum in UTF-16 units',
        () => ({ ANTHROPIC_API_KEY: `${secretOfLength('astral', SECRET_MIN_LENGTH - 2)}\u{1F511}`, ANTHROPIC_BASE_URL: GATEWAY_URL, GH_TOKEN: fakeToken('', 'gh') }),
        'ANTHROPIC_API_KEY',
      ],
      ['GH_TOKEN one character below the minimum', () => ({ ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw'), GH_TOKEN: secretOfLength('short', SECRET_MIN_LENGTH - 1) }), 'GH_TOKEN'],
    ]

    test.each(BAD_ROWS)('%s is a bad credential, naming the variable', async (_label, env, variable) => {
      const run = await refused(worktree(), [], env())

      expect(run.refusal).toEqual(stageRefusalOf([badCredentialReason(variable)]))
      expectNamed(run.refusal, [[variable]])
      expectNoValueShown(run, env())
    })

    test.each([
      ['a key not beginning with the raw-key prefix with ANTHROPIC_BASE_URL set', () => ({ ANTHROPIC_API_KEY: gatewayKey(), ANTHROPIC_BASE_URL: GATEWAY_URL, GH_TOKEN: fakeToken('', 'gh') })],
      [
        'both secrets exactly at the minimum',
        () => ({ ANTHROPIC_API_KEY: secretOfLength('minimum', SECRET_MIN_LENGTH), ANTHROPIC_BASE_URL: GATEWAY_URL, GH_TOKEN: secretOfLength('minimum', SECRET_MIN_LENGTH) }),
      ],
      ['a raw key exactly at the minimum', () => ({ ANTHROPIC_API_KEY: `${RAW_KEY_PREFIX}${fakeToken('', 'raw')}`.slice(0, SECRET_MIN_LENGTH) })],
      ['GH_TOKEN unset', () => ({ ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw') })],
      ['GH_TOKEN empty', () => ({ ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw'), GH_TOKEN: '' })],
    ] as const)('%s passes stage 8', (_label, env) => {
      expect(validated(worktree(), [], env()).effectiveShards).toBe(MAX_SHARDS)
    })

    test('a run that passes every stage, GH_TOKEN unset, spawns no gh auth token lookup and no other child during validation', async () => {
      const wt = worktree()
      const env: ChildEnvironmentSource = { ANTHROPIC_API_KEY: gatewayKey(), ANTHROPIC_BASE_URL: GATEWAY_URL }
      expect(validated(wt, [], env).effectiveShards).toBe(MAX_SHARDS)
      const rig = mainRig(wt, env)

      const exit = await main([E2_RUN_ID], rig.deps)

      expect(exit).not.toBe(REFUSAL_EXIT_STATUS)
      expect(readStatusFile(rig.runDir)?.phase).not.toBe('refused')
      expect(rig.recorder.spawns()).toEqual([])
      expect(rig.forbiddenCalls).toEqual([])
      assertNoLeak({ stderr: rig.stderr, runDir: writtenFile(rig.runDir) })
    })
  })

  // -------------------------------------------------------------------------
  // T5.S7: stage order, detail-line order and the recorded refusal (SR-2.6, SR-5.3 step 2)
  // -------------------------------------------------------------------------

  describe('stage order, detail-line order and the recorded refusal (b.uqm SR-2.6, SR-5.3)', () => {
    /** A cycle between test-5 and test-6. */
    const CYCLE_5_6: Readonly<Record<number, readonly PrerequisiteLine[]>> = { 5: [{ names: [6] }], 6: [{ names: [5] }] }

    /** One run whose worktree, arguments and environment give failures; the refusal's reasons in order. */
    interface StageRow {
      readonly label: string
      readonly options: () => WorktreeOptions
      readonly args: () => readonly string[]
      readonly env?: () => ChildEnvironmentSource
      readonly reasons: () => readonly string[]
    }

    /** Each adjacent pair of stages failing together: only the earlier stage's refusal is recorded. */
    const STAGE_ORDER_ROWS: readonly StageRow[] = [
      {
        label: 'arguments before names (fail: and timeout: naming test-5, with a script file named test-5.sh)',
        options: () => ({ extraScripts: [`${numberForm(5)}.sh`] }),
        args: () => ['--inject', `fail:${numberForm(5)}`, '--inject', `timeout:${numberForm(5)}`],
        reasons: () => [failTimeoutConflictReason(`fail:${numberForm(5)}`, `timeout:${numberForm(5)}`, numberForm(5))],
      },
      {
        label: 'names before duplicates',
        options: () => ({ extraScripts: [`${numberForm(5)}.sh`, duplicateScriptFileName(6)] }),
        args: () => [],
        reasons: () => [badScriptNameReason(`${numberForm(5)}.sh`)],
      },
      {
        label: 'duplicates before a missing test-1',
        options: () => ({ without: [1], extraScripts: [duplicateScriptFileName(6)] }),
        args: () => [],
        reasons: () => [duplicateNumberReason(numberForm(6), [duplicateScriptFileName(6), scriptFile(6)])],
      },
      {
        label: 'a missing test-1 before the selection',
        options: () => ({ without: [1] }),
        args: () => ['test-999'],
        reasons: () => [missingTest1Reason()],
      },
      {
        label: 'the selection before the headers',
        options: () => ({ prerequisites: CYCLE_5_6 }),
        args: () => ['test-999'],
        reasons: () => [unmatchedScriptReason('test-999')],
      },
      {
        label: 'the headers before the faults',
        options: () => ({ prerequisites: CYCLE_5_6 }),
        args: () => ['--inject', 'kill:0'],
        reasons: () => [prerequisiteCycleReason(files(5, 6))],
      },
      {
        label: 'the faults before the credentials',
        options: () => ({}),
        args: () => ['--inject', 'kill:0'],
        env: () => ({}),
        reasons: () => [faultShardOutOfRangeReason('kill:0', '0', MAX_SHARDS)],
      },
    ]

    test.each([...STAGE_ORDER_ROWS])('$label: only the earlier stage is reported', async ({ options, args, env, reasons }) => {
      expect((await refused(worktree(options()), args(), env?.())).refusal).toEqual(stageRefusalOf(reasons()))
    })

    /** One refusal per stage, each with several failures given in an order other than the stage's: the reasons in the stage's order. */
    const DETAIL_ORDER_ROWS: readonly StageRow[] = [
      {
        label: 'stage 1, the arguments: argument order',
        options: () => ({}),
        args: () => ['--verbose', '--shards', BELOW_RANGE],
        reasons: () => [unknownOptionReason('--verbose'), outOfRangeReason('--shards', BELOW_RANGE)],
      },
      {
        label: 'stage 2, the names: bytewise file-name order, both kinds interleaved',
        options: () => ({ extraScripts: ['test-x-y.sh', 'test-05-x.sh', 'test-5.sh'], nonRegular: [{ kind: 'directory', name: `${numberForm(6)}-dir.sh` }] }),
        args: () => [],
        reasons: () => [
          badScriptNameReason('test-05-x.sh'),
          badScriptNameReason('test-5.sh'),
          notRegularEntryReason(`${numberForm(6)}-dir.sh`, 'directory'),
          badScriptNameReason('test-x-y.sh'),
        ],
      },
      {
        label: 'stage 3, duplicates: ascending number, not bytewise',
        options: () => ({ extraScripts: [duplicateScriptFileName(20), duplicateScriptFileName(6), duplicateScriptFileName(10)] }),
        args: () => [],
        reasons: () => [6, 10, 20].map((n) => duplicateNumberReason(numberForm(n), [duplicateScriptFileName(n), scriptFile(n)])),
      },
      {
        label: 'stage 4, a missing test-1',
        options: () => ({ without: [1] }),
        args: () => [],
        reasons: () => [missingTest1Reason()],
      },
      {
        label: 'stage 5, the selection: argument order',
        options: () => ({}),
        args: () => ['test-999', wrongSlugFileName(5), 'test-998'],
        reasons: () => [unmatchedScriptReason('test-999'), unmatchedScriptReason(wrongSlugFileName(5)), unmatchedScriptReason('test-998')],
      },
      {
        label: "stage 6, the headers: the declaring script's canonical order, then b.uqm SR-3.2's order, a cycle declared by its first script",
        options: () => ({
          prerequisites: {
            3: [{ names: [7, 'test-996'] }],
            7: [{ names: [3] }],
            0: [{ names: ['test-997'] }],
            5: [{ names: ['test-999', 8] }, { names: [4] }],
            6: [{ names: [] }],
          },
        }),
        args: () => [],
        reasons: () => [
          unknownPrerequisiteReason(scriptFile(3), 'test-996'),
          prerequisiteCycleReason(files(3, 7)),
          unknownPrerequisiteReason(scriptFile(0), 'test-997'),
          unknownPrerequisiteReason(scriptFile(5), 'test-999'),
          prerequisiteOrderReason(scriptFile(5), scriptFile(8)),
          extraPrerequisiteLineReason(scriptFile(5), 'second'),
          emptyPrerequisiteLineReason(scriptFile(6)),
        ],
      },
      {
        label: "stage 7, the faults: argument order, a leak's k before its j",
        options: () => ({}),
        args: () => ['--inject', 'fail:test-999', '--shards', '2', '--inject', 'leak:4,3', '--inject', 'kill:5'],
        reasons: () => [
          faultScriptMissingReason('fail:test-999', 'test-999'),
          faultShardOutOfRangeReason('leak:4,3', '4', 2),
          faultShardOutOfRangeReason('leak:4,3', '3', 2),
          faultShardOutOfRangeReason('kill:5', '5', 2),
        ],
      },
      {
        label: 'stage 8, the credentials: ANTHROPIC_API_KEY before GH_TOKEN',
        options: () => ({}),
        args: () => [],
        env: () => ({ GH_TOKEN: secretOfLength('short', SECRET_MIN_LENGTH - 1) }),
        reasons: () => [missingApiKeyReason('unset'), badCredentialReason('GH_TOKEN')],
      },
    ]

    test.each([...DETAIL_ORDER_ROWS])(
      '$label; main records it as the last act, touching nothing else',
      async ({ options, args, env, reasons }) => {
        const wt = worktree(options())
        const before = treeSnapshot(wt, { extended: true })

        const runEnv = env?.() ?? validEnv()

        const run = await refused(wt, args(), runEnv)

        expect(run.refusal).toEqual(stageRefusalOf(reasons()))
        expectNoValueShown(run, runEnv)
        for (const line of reasonLinesOf(run.refusal)) expect(line).not.toMatch(/[\r\n]/)
        expect(run.logLines.slice(1)).toEqual([`${NOT_RUN_PREFIX}${run.refusal.summary}`, ...run.refusal.details])
        expect(readdirSync(run.rig.runDir).sort()).toEqual([RUNNER_LOG_FILE_NAME, STATUS_FILE_NAME].sort())
        expect(run.rig.forbiddenCalls).toEqual([])
        expect(run.rig.stderr).toEqual([])
        expect(existsSync(run.rig.lockDir)).toBe(false)
        expect(treeSnapshot(wt, { extended: true })).toEqual(before)
      },
    )
  })
})
