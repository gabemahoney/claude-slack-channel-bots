/**
 * phase1-client-check.ts — the image-side check that an installed CSCB
 * package uses the Phase 1 agent-director client's own error classes (b.jg5
 * SRJ-101, SRJ-103, SRJ-104).
 *
 * Two parts:
 *
 *   - {@link checkPhase1Client}, a pure exported checker. It takes every
 *     module it checks as an argument ({@link Phase1ClientCheckModules}: the
 *     package's `src/agent-director-errors.ts`, `src/ad-error-class.ts` and
 *     `src/ad-description-phrases.ts`, and the `agent-director` module that
 *     package resolves) and returns the problems it finds, one
 *     {@link Phase1ClientCheckProblem} each, named by kind. An empty list
 *     means every check passed. It never throws, starts no process, calls no
 *     agent-director verb, never calls `Client.create()` or
 *     `resolveSystemBinary()`, and reads no file. Host unit tests drive it
 *     with fake namespaces.
 *   - An entry point that runs only when this file is executed directly
 *     (`import.meta.main`), in a cscb-ci image after the release-candidate
 *     client swap: it refuses to run without the image marker
 *     `/etc/cscb-ci-image`, imports the installed package's three modules
 *     from `CSCB_PKG_DIR` (default `/test-repo/node_modules/claude-slack-channel-bots`)
 *     and the `agent-director` module that package's `src/` resolves, all at
 *     run time, runs the checker, and prints `FAIL: phase1-client-check: <kind>: <detail>`
 *     on stderr per problem and exits 1, or prints `PASS: phase1-client-check`
 *     and exits 0. Importing this module does nothing: no marker read, no
 *     package path resolved.
 *
 * What the checker checks:
 *   - the package's presence flag (`PHASE1_ERROR_CLASSES_FROM_CLIENT`) is
 *     true, so no stand-in class is in use;
 *   - each of SRJ-103's seven exports of `src/agent-director-errors.ts`
 *     (`ErrTmuxKillFailed`, `ErrTmuxUnresponsive`, `ErrTmuxSessionConflict`,
 *     `ErrTmuxSendKeys`, `ErrTmuxCaptureFailed`, `ErrTmuxSessionCreate`,
 *     `ErrUnknownErrorName`) is the client's own export, by identity;
 *   - for each of the three Phase-1-only names, the client's own
 *     `errorFromEnvelope(verb, name, description)` builds an instance of the
 *     package's export, which the package's classifier classes as SRJ-104
 *     says (`ErrTmuxSessionConflict` CONFLICT, `ErrTmuxKillFailed` and
 *     `ErrTmuxUnresponsive` UNAVAILABLE);
 *   - `conflictDescriptionOf` and `killFailedDescriptionOf` return the
 *     envelope's description of the client-built CONFLICT and kill failure;
 *   - the launch-timeout predicate holds for a client-built
 *     `ErrTmuxUnresponsive` from a launch verb carrying
 *     `LAUNCH_TIMEOUT_PHRASE`, in the `ErrTmuxUnresponsive` form;
 *   - `isDifferentTmuxServerError` holds for a client-built
 *     `ErrTmuxNotAvailable` carrying `DIFFERENT_TMUX_SERVER_PHRASE`.
 * Every description, phrase, class label and Phase-1-only name is taken from
 * the package's own modules, never written here.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Inputs and problems
// ---------------------------------------------------------------------------

/** A module namespace as the checker reads it: named exports, any value. */
export type ModuleNamespace = Readonly<Record<string, unknown>>

/** The modules {@link checkPhase1Client} checks, each a module namespace. */
export interface Phase1ClientCheckModules {
  /** The installed package's `src/agent-director-errors.ts`. */
  readonly errors: ModuleNamespace
  /** The installed package's `src/ad-error-class.ts`. */
  readonly errorClass: ModuleNamespace
  /** The installed package's `src/ad-description-phrases.ts`. */
  readonly phrases: ModuleNamespace
  /** The `agent-director` module the installed package resolves. */
  readonly client: ModuleNamespace
}

/** A module the checker needs lacks an export, or the export is not of the kind needed. */
export const PROBLEM_MISSING_EXPORT = 'missing-export'
/** The package's presence flag is not true: a stand-in class is in use. */
export const PROBLEM_PRESENCE_FLAG = 'presence-flag'
/** One of SRJ-103's seven exports is not the client's own export. */
export const PROBLEM_IDENTITY = 'identity'
/** The client's `errorFromEnvelope` threw, or built no instance of the package's export. */
export const PROBLEM_ENVELOPE_BUILD = 'envelope-build'
/** The package's classifier classes a client-built error other than SRJ-104 says. */
export const PROBLEM_CLASSIFICATION = 'classification'
/** `conflictDescriptionOf` did not return the client-built CONFLICT's description. */
export const PROBLEM_CONFLICT_DESCRIPTION = 'conflict-description'
/** `killFailedDescriptionOf` did not return the client-built kill failure's description. */
export const PROBLEM_KILL_FAILED_DESCRIPTION = 'kill-failed-description'
/** The launch-timeout predicate does not hold for the client-built launch timeout. */
export const PROBLEM_LAUNCH_TIMEOUT = 'launch-timeout'
/** `isDifferentTmuxServerError` does not hold for the client-built re-bound-socket error. */
export const PROBLEM_DIFFERENT_TMUX_SERVER = 'different-tmux-server'

/** Every problem kind, in the order the checker checks. */
export const PHASE1_CLIENT_CHECK_PROBLEM_KINDS = [
  PROBLEM_MISSING_EXPORT,
  PROBLEM_PRESENCE_FLAG,
  PROBLEM_IDENTITY,
  PROBLEM_ENVELOPE_BUILD,
  PROBLEM_CLASSIFICATION,
  PROBLEM_CONFLICT_DESCRIPTION,
  PROBLEM_KILL_FAILED_DESCRIPTION,
  PROBLEM_LAUNCH_TIMEOUT,
  PROBLEM_DIFFERENT_TMUX_SERVER,
] as const

/** One problem kind. */
export type Phase1ClientCheckProblemKind = (typeof PHASE1_CLIENT_CHECK_PROBLEM_KINDS)[number]

/** One problem the checker found. */
export interface Phase1ClientCheckProblem {
  readonly kind: Phase1ClientCheckProblemKind
  /** What was checked and what was found, on one line. */
  readonly detail: string
}

/** The test name in the scenario convention's `PASS:` / `FAIL:` lines. */
export const PHASE1_CLIENT_CHECK_TEST_NAME = 'phase1-client-check'

/** One `FAIL: phase1-client-check: <kind>: <detail>` line for `problem`. */
export function phase1ClientCheckFailLine(problem: Phase1ClientCheckProblem): string {
  return `FAIL: ${PHASE1_CLIENT_CHECK_TEST_NAME}: ${problem.kind}: ${problem.detail}`
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

/** SRJ-103's four exports every client declares, by export name. */
const SRJ103_CLIENT_EXPORTS = ['ErrTmuxSendKeys', 'ErrTmuxCaptureFailed', 'ErrTmuxSessionCreate', 'ErrUnknownErrorName'] as const

/** The client's re-bound-socket error class, by export name. */
const TMUX_NOT_AVAILABLE_EXPORT = 'ErrTmuxNotAvailable'

/** The verb the client-built CONFLICT, launch timeout and re-bound-socket error carry. */
const LAUNCH_VERB = 'spawn'

type AnyFunction = (...args: never[]) => unknown

/** `value` as a function, or undefined. */
function asFunction(value: unknown): AnyFunction | undefined {
  return typeof value === 'function' ? (value as AnyFunction) : undefined
}

/** `value` as a string, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `ns[name]`, or undefined when the read throws. */
function read(ns: ModuleNamespace, name: string): unknown {
  try {
    return ns[name]
  } catch {
    return undefined
  }
}

/** `value instanceof cls`, false when it throws. */
function isInstance(value: unknown, cls: AnyFunction): boolean {
  try {
    return value instanceof cls
  } catch {
    return false
  }
}

/** A short, one-line rendering of a thrown value or a found value for a problem's detail. */
function show(value: unknown): string {
  try {
    if (typeof value === 'string') return JSON.stringify(value)
    if (value instanceof Error) return `${value.name}: ${value.message}`.replace(/\s+/g, ' ')
    if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`
    return String(value)
  } catch {
    return 'unprintable'
  }
}

/**
 * Check the installed package's Phase 1 adoption against the client it
 * resolves (see the module comment). Answers every problem found, empty
 * when every check passes. Pure; never throws.
 */
export function checkPhase1Client(modules: Phase1ClientCheckModules): Phase1ClientCheckProblem[] {
  const problems: Phase1ClientCheckProblem[] = []
  const problem = (kind: Phase1ClientCheckProblemKind, detail: string): void => {
    problems.push({ kind, detail })
  }
  const need = <T>(ns: ModuleNamespace, module: string, name: string, as: (value: unknown) => T | undefined, kind: string): T | undefined => {
    const value = as(read(ns, name))
    if (value === undefined) problem(PROBLEM_MISSING_EXPORT, `${module} has no ${kind} export ${name}`)
    return value
  }
  const { errors, errorClass, phrases, client } = modules

  // The names, labels, phrases and functions the checks use, from the package and the client.
  const killFailedName = need(errors, 'agent-director-errors', 'ERR_TMUX_KILL_FAILED_NAME', asString, 'string')
  const unresponsiveName = need(errors, 'agent-director-errors', 'ERR_TMUX_UNRESPONSIVE_NAME', asString, 'string')
  const conflictName = need(errors, 'agent-director-errors', 'ERR_TMUX_SESSION_CONFLICT_NAME', asString, 'string')
  const conflictLabel = need(errorClass, 'ad-error-class', 'AD_ERROR_CLASS_CONFLICT', asString, 'string')
  const unavailableLabel = need(errorClass, 'ad-error-class', 'AD_ERROR_CLASS_UNAVAILABLE', asString, 'string')
  const unresponsiveForm = need(errorClass, 'ad-error-class', 'LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE', asString, 'string')
  const classifyAdError = need(errorClass, 'ad-error-class', 'classifyAdError', asFunction, 'function')
  const conflictDescriptionOf = need(errorClass, 'ad-error-class', 'conflictDescriptionOf', asFunction, 'function')
  const killFailedDescriptionOf = need(errorClass, 'ad-error-class', 'killFailedDescriptionOf', asFunction, 'function')
  const launchTimeoutFormOf = need(errorClass, 'ad-error-class', 'launchTimeoutFormOf', asFunction, 'function')
  const isDifferentTmuxServerError = need(errorClass, 'ad-error-class', 'isDifferentTmuxServerError', asFunction, 'function')
  const killVerb = need(errorClass, 'ad-error-class', 'AD_VERB_KILL', asString, 'string')
  const conflictPhrase = need(phrases, 'ad-description-phrases', 'CONFLICT_NOT_THIS_LAUNCH_PHRASE', asString, 'string')
  const retryKillLaterPhrase = need(phrases, 'ad-description-phrases', 'RETRY_KILL_LATER_PHRASE', asString, 'string')
  const launchTimeoutPhrase = need(phrases, 'ad-description-phrases', 'LAUNCH_TIMEOUT_PHRASE', asString, 'string')
  const differentServerPhrase = need(phrases, 'ad-description-phrases', 'DIFFERENT_TMUX_SERVER_PHRASE', asString, 'string')
  const errorFromEnvelope = need(client, 'agent-director', 'errorFromEnvelope', asFunction, 'function')

  // The presence flag.
  const flag = read(errors, 'PHASE1_ERROR_CLASSES_FROM_CLIENT')
  if (flag !== true) {
    problem(PROBLEM_PRESENCE_FLAG, `agent-director-errors PHASE1_ERROR_CLASSES_FROM_CLIENT is ${show(flag)}, not true: a stand-in class is in use`)
  }

  // SRJ-103's seven exports, by identity.
  const phase1Names = [killFailedName, unresponsiveName, conflictName].filter((name): name is string => name !== undefined)
  for (const name of [...phase1Names, ...SRJ103_CLIENT_EXPORTS]) {
    const packaged = read(errors, name)
    const own = read(client, name)
    if (asFunction(own) === undefined) {
      problem(PROBLEM_IDENTITY, `the client exports no class ${name} (found ${show(own)})`)
    } else if (packaged !== own) {
      problem(PROBLEM_IDENTITY, `agent-director-errors ${name} (${show(packaged)}) is not the client's own export`)
    }
  }

  /** The client-built error for (verb, name, description), when it is an instance of the package's export; else a problem. */
  const build = (verb: string, name: string, exportName: string, description: string): unknown => {
    if (errorFromEnvelope === undefined) return undefined
    let built: unknown
    try {
      built = (errorFromEnvelope as (v: string, n: string, d: string) => unknown)(verb, name, description)
    } catch (err) {
      problem(PROBLEM_ENVELOPE_BUILD, `errorFromEnvelope(${verb}, ${name}) threw ${show(err)}`)
      return undefined
    }
    const packaged = asFunction(read(errors, exportName))
    if (packaged === undefined || !isInstance(built, packaged)) {
      problem(PROBLEM_ENVELOPE_BUILD, `errorFromEnvelope(${verb}, ${name}) built ${show(built)}, not an instance of agent-director-errors ${exportName}`)
      return undefined
    }
    return built
  }

  /** Whether the package's classifier classes `built` as `expected`; a problem when not. */
  const classifies = (built: unknown, name: string, expected: string | undefined): void => {
    if (classifyAdError === undefined || expected === undefined) return
    let answered: unknown
    try {
      answered = read((classifyAdError as (v: unknown) => ModuleNamespace)(built), 'errorClass')
    } catch (err) {
      problem(PROBLEM_CLASSIFICATION, `classifyAdError(${name}) threw ${show(err)}`)
      return
    }
    if (answered !== expected) problem(PROBLEM_CLASSIFICATION, `classifyAdError(${name}) answered ${show(answered)}, not ${expected}`)
  }

  /** Call `fn(...args)`, answering what it returned, or the problem detail when it threw. */
  const call = (fn: AnyFunction, args: readonly unknown[]): { readonly value?: unknown; readonly threw?: string } => {
    try {
      return { value: (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (err) {
      return { threw: show(err) }
    }
  }

  // ErrTmuxSessionConflict: CONFLICT, its description read by conflictDescriptionOf.
  if (conflictName !== undefined && conflictPhrase !== undefined) {
    const built = build(LAUNCH_VERB, conflictName, 'ErrTmuxSessionConflict', conflictPhrase)
    if (built !== undefined) {
      classifies(built, conflictName, conflictLabel)
      if (conflictDescriptionOf !== undefined) {
        const answer = call(conflictDescriptionOf, [built])
        if (answer.threw !== undefined || answer.value !== conflictPhrase) {
          problem(PROBLEM_CONFLICT_DESCRIPTION, `conflictDescriptionOf(${conflictName}) answered ${answer.threw ?? show(answer.value)}, not the envelope's description`)
        }
      }
    }
  }

  // ErrTmuxKillFailed: UNAVAILABLE, its description read by killFailedDescriptionOf.
  if (killFailedName !== undefined && retryKillLaterPhrase !== undefined && killVerb !== undefined) {
    const built = build(killVerb, killFailedName, 'ErrTmuxKillFailed', retryKillLaterPhrase)
    if (built !== undefined) {
      classifies(built, killFailedName, unavailableLabel)
      if (killFailedDescriptionOf !== undefined) {
        const answer = call(killFailedDescriptionOf, [built])
        if (answer.threw !== undefined || answer.value !== retryKillLaterPhrase) {
          problem(PROBLEM_KILL_FAILED_DESCRIPTION, `killFailedDescriptionOf(${killFailedName}) answered ${answer.threw ?? show(answer.value)}, not the envelope's description`)
        }
      }
    }
  }

  // ErrTmuxUnresponsive: UNAVAILABLE, and a launch timeout in its own form when it carries the phrase.
  if (unresponsiveName !== undefined && launchTimeoutPhrase !== undefined) {
    const built = build(LAUNCH_VERB, unresponsiveName, 'ErrTmuxUnresponsive', launchTimeoutPhrase)
    if (built !== undefined) {
      classifies(built, unresponsiveName, unavailableLabel)
      if (launchTimeoutFormOf !== undefined && unresponsiveForm !== undefined) {
        const form = call(launchTimeoutFormOf, [built, LAUNCH_VERB])
        if (form.threw !== undefined || form.value !== unresponsiveForm) {
          problem(PROBLEM_LAUNCH_TIMEOUT, `launchTimeoutFormOf(${unresponsiveName} carrying LAUNCH_TIMEOUT_PHRASE, ${LAUNCH_VERB}) answered ${form.threw ?? show(form.value)}, not ${unresponsiveForm}`)
        }
      }
    }
  }

  // ErrTmuxNotAvailable carrying the re-bound-socket phrase.
  if (differentServerPhrase !== undefined && errorFromEnvelope !== undefined && isDifferentTmuxServerError !== undefined) {
    const built = build(LAUNCH_VERB, TMUX_NOT_AVAILABLE_EXPORT, TMUX_NOT_AVAILABLE_EXPORT, differentServerPhrase)
    if (built !== undefined) {
      const answer = call(isDifferentTmuxServerError, [built])
      if (answer.threw !== undefined || answer.value !== true) {
        problem(PROBLEM_DIFFERENT_TMUX_SERVER, `isDifferentTmuxServerError(${TMUX_NOT_AVAILABLE_EXPORT} carrying DIFFERENT_TMUX_SERVER_PHRASE) answered ${answer.threw ?? show(answer.value)}, not true`)
      }
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// The entry point (a cscb-ci image only)
// ---------------------------------------------------------------------------

/** The cscb-ci image marker; the entry point refuses to run without it. */
const IMAGE_MARKER = '/etc/cscb-ci-image'

/** The installed package the entry point checks when `CSCB_PKG_DIR` is unset. */
const DEFAULT_PACKAGE_DIR = '/test-repo/node_modules/claude-slack-channel-bots'

/** The entry point: see the module comment. Runs only when this file is executed directly. */
async function main(): Promise<number> {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const fail = (detail: string): number => {
    console.error(`FAIL: ${PHASE1_CLIENT_CHECK_TEST_NAME}: ${detail}`)
    return 1
  }
  if (!existsSync(IMAGE_MARKER)) return fail(`refused: no ${IMAGE_MARKER}; this check runs only in a cscb-ci image`)
  const packageDir = process.env['CSCB_PKG_DIR'] ?? DEFAULT_PACKAGE_DIR
  const srcDir = join(packageDir, 'src')
  let modules: Phase1ClientCheckModules
  try {
    const clientEntry = Bun.resolveSync('agent-director', srcDir)
    modules = {
      errors: await import(join(srcDir, 'agent-director-errors.ts')),
      errorClass: await import(join(srcDir, 'ad-error-class.ts')),
      phrases: await import(join(srcDir, 'ad-description-phrases.ts')),
      client: await import(clientEntry),
    }
  } catch (err) {
    return fail(`could not load the package at ${packageDir} or the agent-director client it resolves: ${show(err)}`)
  }
  const problems = checkPhase1Client(modules)
  for (const found of problems) console.error(phase1ClientCheckFailLine(found))
  if (problems.length > 0) return 1
  console.log(`PASS: ${PHASE1_CLIENT_CHECK_TEST_NAME}`)
  return 0
}

if (import.meta.main) process.exit(await main())
