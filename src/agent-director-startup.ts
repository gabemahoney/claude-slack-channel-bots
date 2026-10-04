/**
 * agent-director-startup.ts — SR-5.1 startup gate for the agent-director
 * library dependency.
 *
 * Runs the boot sequence the SRD requires before any other CSCB work:
 *
 *   1. import { Client } from 'agent-director'   — covered at module load
 *      time; module-not-found surfaces as a top-level import error caught
 *      by callers' try/catch (see runAgentDirectorStartupGate's
 *      module-load-error branch below).
 *   2. await d.createClient(opts)                — typed catches for
 *      ErrBunVersionTooOld, ErrSystemInstallNotFound,
 *      ErrSystemInstallTooOld (the client's own too-old refusal, below its
 *      minimum), ErrSystemInstallUnreachable; other throws surface verbatim.
 *      The factory resolves to a constructed Client (production injects
 *      `Client.create`). `opts` comes from `buildAdClientOptions`, the one
 *      place the client options are built; `runStartupGate`'s
 *      `callTimeoutMs` option sets the client's `callTimeoutMs` (b.jg5
 *      SRJ-213), and without it no key is passed.
 *   3. CSCB's Phase 1 floor (b.jg5 SRJ-203)      — the client's
 *      `binaryVersion` (never its `version()` method, which reports the npm
 *      package's version) must pass `meetsPhase1Floor`; below the floor or
 *      unparseable is refused as `ad-below-phase1-floor`. The check runs
 *      before the client is installed as the singleton: a refused client is
 *      closed once and never installed. `runStartupGate`'s `skipPhase1Floor`
 *      option leaves this step out; the client's too-old refusal still runs.
 *   3.5. API surface probes (SR-6.1 publish-skew defense)  — short-circuit,
 *      run in order: probeGetPermission (ad-shim-missing-get-permission) →
 *      probeErrorCatalog (ad-shim-catalog-incomplete) → probeDecideArgv
 *      (ad-shim-decide-drops-token). These exist because a passing version
 *      check does not prove the npm-shipped TS shim matches the bundled Go
 *      binary; each missing surface silently breaks the permission relay.
 *   4. stat ~/.agent-director/state.db           — compare st_uid to
 *      geteuid(). ENOENT passes (the row is created on first verb call);
 *      other stat errors are fatal.
 *
 * The persona client (b.jg5 SRJ-213): the server's gate runs before the
 * configuration is read, so its client has the client's default call
 * timeout. Once the start has resolved its configuration, the server builds a
 * second client with the configured `agent_director_call_timeout_ms`
 * (`buildPersonaClient`, exiting form `buildPersonaClientOrExit`): steps 2
 * and 3 only, shared with the gate, then installed as the singleton in place
 * of the gate's client, which is closed once.
 *
 * Each failure mode records to startup-errors.log + stderr via
 * recordStartupError, then exits non-zero. Every failure outcome carries a
 * refusal kind (`client-too-old`, `below-phase1-floor`, `other`) so callers
 * branch on the refusal itself, never on a class label or message text.
 * The gate is tested through the `deps` injection seam — production callers
 * omit it, tests pass overrides.
 *
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  Client,
  ErrBunVersionTooOld,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
} from 'agent-director'
import type { ClientOptions } from 'agent-director'

import { makeFilteredAdLogger } from './agent-director-logger.ts'
import { recordStartupError } from './startup-errors.ts'
import {
  closeClient as closeInstalledClient,
  DEFAULT_STORE_PATH,
  setClient,
  setClientForTests,
} from './agent-director-client.ts'
import { renderInstallSkillInstructions } from './install-skill-pointer.ts'
import {
  AD_BELOW_PHASE1_FLOOR,
  AD_SHIM_CATALOG_INCOMPLETE,
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  CLIENT_PACKAGE_REMEDY,
  RUNBOOK_SECTION_POINTER,
} from './install-check.ts'
import { PHASE1_ONLY_ERR_NAMES } from './agent-director-errors.ts'
import { buildBelowPhase1FloorMessage, buildSystemInstallTooOldMessage, meetsPhase1Floor } from './ad-version-gate.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where AD persists its store; tilde-expanded for the same-user stat probe. */
const AD_STATE_DB_PATH = join(os.homedir(), '.agent-director', 'state.db')

/** Supported platforms surfaced in operator-facing remediation text. */
const SUPPORTED_PLATFORMS = ['linux-x64', 'darwin-arm64'] as const

/**
 * err_names the client's dist must declare a class for. The structural-drift
 * indicator we guard against is whether the `agent-director` dist file ships
 * a class declaration for each — i.e. matches `class <Name>\s`. The class
 * declaration is the defining symptom of a shim that's caught up to the
 * bundled Go binary: when one is missing, the client's runtime decode path
 * (`throwFromEnvelope`) cannot build that error's own class and throws
 * `ErrUnknownErrorName` instead, and CSCB can no longer classify it. A
 * bare-identifier match in the dist source is too loose because the shipped
 * shim also carries a metadata array (`{ name: "ErrPermissionRequestNotFound", ... }`)
 * that mentions the names even when the class is absent — so the match must
 * anchor on the class declaration.
 *
 * The three Phase-1-only names (`PHASE1_ONLY_ERR_NAMES`, b.jg5 SRJ-102) are
 * required: CSCB recognises those errors by the client's own classes
 * (`src/agent-director-errors.ts`), and a client without them turns a Phase 1
 * binary's errors into `ErrUnknownErrorName`, which the classifier would
 * misclassify, and leaves CSCB on its stand-in classes. The check reads names
 * in the dist text and imports none of them (b.jg5 SRJ-101).
 */
export const REQUIRED_ERR_NAMES = [
  'ErrInvalidFlags',
  'ErrPermissionRequestNotFound',
  'ErrAmbiguousRequest',
  ...PHASE1_ONLY_ERR_NAMES,
] as const

/** Answer of the error-catalogue check: ok, or the required names missing. */
export type ErrorCatalogCheckResult = { ok: true } | { ok: false; missing: string[] }

/**
 * Check supplied `agent-director` dist text for a class declaration
 * (`class <Name>\s`) of every name in {@link REQUIRED_ERR_NAMES}. Pure: reads
 * nothing and imports nothing. A name that appears only in a metadata entry,
 * with no class declaration, counts as missing. The missing names are listed
 * in `REQUIRED_ERR_NAMES` order.
 */
export function checkErrorCatalog(distText: string): ErrorCatalogCheckResult {
  const missing: string[] = []
  for (const name of REQUIRED_ERR_NAMES) {
    const re = new RegExp(`class\\s+${name}\\s`)
    if (!re.test(distText)) {
      missing.push(name)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

// ---------------------------------------------------------------------------
// Private helper: resolve + read the agent-director dist source (memoized)
// ---------------------------------------------------------------------------

/**
 * Source-text cache for the resolved `agent-director` dist entry. Probes 2
 * and 3 both grep the same file; reading it once keeps boot fast and avoids
 * surprising operators with duplicate I/O failures.
 */
let cachedAdDistSource: string | Error | null = null

/**
 * Resolve `agent-director` via `import.meta.resolve`, convert the file:// URL
 * to a filesystem path, and read the bundled JS as UTF-8. Memoized for the
 * life of the process. Returns the cached `Error` on a previous failure so
 * each probe can surface a uniform `detail` field.
 */
function readAdDistSource(): string | Error {
  if (cachedAdDistSource !== null) return cachedAdDistSource
  try {
    const resolved = import.meta.resolve('agent-director')
    const distPath = fileURLToPath(resolved)
    cachedAdDistSource = fs.readFileSync(distPath, 'utf-8')
  } catch (err) {
    cachedAdDistSource = err instanceof Error ? err : new Error(String(err))
  }
  return cachedAdDistSource
}

// ---------------------------------------------------------------------------
// Injectable dependency surface
// ---------------------------------------------------------------------------

export interface StartupGateDeps {
  /**
   * Async factory that resolves to a constructed Client. Production injects
   * `Client.create`; tests inject `makeStubCreateClient({...})` from
   * tests/test-helpers/agent-director-stub.ts to drive the catch ladder.
   */
  createClient: (opts: object) => Promise<unknown>
  /** Hook that returns the client's `close()` for the failure-path cleanup. */
  closeClient: (client: unknown) => void
  /** Stat hook for the SR-5.1 same-user check. */
  statSync: (path: string) => { uid: number }
  /** Effective UID hook. Returns undefined on platforms without geteuid. */
  geteuid: () => number | undefined
  /** Append to startup-errors.log + stderr; signature mirrors recordStartupError. */
  recordStartupError: typeof recordStartupError
  /** Process exit hook (terminates by default). */
  exit: (code: number) => never
  /**
   * Probe 1 — verify the wrapper Client exposes the `getPermission` method.
   * Production default checks `typeof client.getPermission === 'function'`.
   * Tests inject a constant boolean.
   */
  probeGetPermission: (client: unknown) => boolean
  /**
   * Probe 2 — verify the AD error catalog declares a class for every name in
   * `REQUIRED_ERR_NAMES`. Production default reads the resolved
   * `agent-director` dist file (memoized) and delegates to
   * {@link checkErrorCatalog}, which matches `class <Name>\s` for each
   * required name — the class-declaration site is the structural symptom of
   * a shim that's caught up to the bundled Go binary. The client's runtime
   * decode path (`throwFromEnvelope`) turns an err_name it has no class for
   * into `ErrUnknownErrorName`, so each required class must be declared in
   * the dist. The check reads the dist text and imports nothing; a
   * bare-identifier match would false-positive on the dist's metadata array
   * that names err_names even when the class is missing.
   */
  probeErrorCatalog: () => ErrorCatalogCheckResult
  /**
   * Probe 3 — verify the wrapper Client's `decide()` argv carries
   * `--request-token`. Production default reads the resolved
   * `agent-director` dist file and greps for the literal `request-token` —
   * a static-file probe (no subprocess, no DB write) chosen over the
   * subprocess fallback per the bug requirements. See the production
   * defaults block for the resolution + read.
   */
  probeDecideArgv: (client: unknown) => Promise<{ ok: true } | { ok: false; detail: string }>
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

const prodDeps: StartupGateDeps = {
  createClient: async (opts) => {
    return await Client.create(opts as ClientOptions)
  },
  closeClient: (client) => {
    try {
      ;(client as { close: () => void }).close()
    } catch {
      // close() never throws per the library contract; defensive in tests.
    }
  },
  statSync: (path) => fs.statSync(path),
  geteuid: () => process.geteuid?.(),
  recordStartupError,
  exit: (code) => process.exit(code),
  probeGetPermission: (client) =>
    typeof (client as { getPermission?: unknown }).getPermission === 'function',
  probeErrorCatalog: () => {
    // Static-file probe: a client without a required class turns that
    // error into `ErrUnknownErrorName` on its runtime decode path
    // (`throwFromEnvelope`), so the class declarations must be present in
    // the dist. Reading the dist text checks that without importing any of
    // the names. A bare-identifier regex is too loose: the shim
    // carries a metadata array whose `name: "Err..."` literals match every
    // err_name regardless of whether the class is declared. Anchor instead
    // on `class <Name>\s` — the class declaration site is emitted once per
    // typed error and is the defining symptom of a caught-up shim. The match
    // itself is `checkErrorCatalog`'s; this default only reads the dist.
    const src = readAdDistSource()
    if (src instanceof Error) {
      // Surface this as "all required names missing" with a diagnostic
      // detail in the first slot, so the operator sees a complete picture.
      return { ok: false, missing: [`<read-failed: ${src.message}>`, ...REQUIRED_ERR_NAMES] }
    }
    return checkErrorCatalog(src)
  },
  probeDecideArgv: async (_client) => {
    // Static-file probe: grep the resolved agent-director dist for the
    // literal `--request-token` flag. Chosen over the subprocess fallback
    // because it's faster, touches no AD state, and a stale shipped shim
    // is exactly the file-content condition we're detecting.
    const src = readAdDistSource()
    if (src instanceof Error) {
      return {
        ok: false,
        detail: `failed to read agent-director dist for argv probe: ${src.message}`,
      }
    }
    if (src.includes('--request-token')) {
      return { ok: true }
    }
    return {
      ok: false,
      detail:
        `agent-director dist does not include the literal '--request-token' — ` +
        `buildDecide() is dropping the field.`,
    }
  },
}

function mergeDeps(overrides?: Partial<StartupGateDeps>): StartupGateDeps {
  return overrides ? { ...prodDeps, ...overrides } : prodDeps
}

/**
 * The options of every agent-director client CSCB builds: the store path,
 * create-if-missing and the filtered logger (b.brv: AD's per-poll
 * `SubprocessClient: <verb> ok` success dumps stay out of server.log at
 * default verbosity; CSCB_AD_VERBOSE restores them; failures and warnings
 * still pass through), plus `callTimeoutMs` when a call timeout is given
 * (b.jg5 SRJ-213). With none, no `callTimeoutMs` key is set and the client
 * uses its own default. The gate's client and the persona client differ only
 * in that key. The 0.10.0 client fixes the timeout at construction.
 */
function buildAdClientOptions(callTimeoutMs?: number): ClientOptions {
  return {
    storePath: DEFAULT_STORE_PATH,
    createIfMissing: true,
    logger: makeFilteredAdLogger(console),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
  }
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

/** Refusal kind: the client's own too-old refusal (`ErrSystemInstallTooOld`). */
export const REFUSAL_KIND_CLIENT_TOO_OLD = 'client-too-old'

/** Refusal kind: CSCB's Phase 1 floor refused the binary (b.jg5 SRJ-203). */
export const REFUSAL_KIND_BELOW_PHASE1_FLOOR = 'below-phase1-floor'

/** Refusal kind: every other gate failure. */
export const REFUSAL_KIND_OTHER = 'other'

/**
 * Which check refused a failed gate. Callers branch on this, never on the
 * class label or message text (b.jg5 SRJ-203, SRJ-902).
 */
export type StartupGateRefusalKind =
  | typeof REFUSAL_KIND_CLIENT_TOO_OLD
  | typeof REFUSAL_KIND_BELOW_PHASE1_FLOOR
  | typeof REFUSAL_KIND_OTHER

/**
 * Per-step result tag used by the gate to drive a single switch at the call
 * site. Production callers read it: `initClient` in `cli.ts` carries
 * `classLabel`, `message` and `refusalKind` into `StartupGateFailedError`, and
 * `refusalKind` exists so callers branch on which check refused (b.jg5
 * SRJ-902). `phase` is diagnostic; tests assert on it.
 */
export type StartupGateOutcome =
  | { ok: true; client: unknown; adVersion: string }
  | {
      ok: false
      phase: 'construct' | 'version' | 'api-surface' | 'same-user' | 'unexpected'
      refusalKind: StartupGateRefusalKind
      classLabel: string
      message: string
    }

/** Behaviour options for {@link runStartupGate}. */
export interface StartupGateOptions {
  /**
   * Leave CSCB's Phase 1 floor check out (b.jg5 SRJ-203). Defaults to false:
   * the floor runs. It changes nothing else: the client's own too-old
   * refusal, the API-surface probes and the same-user check still run. Only
   * `stop --stop-bots`'s client initialization is meant to set it; the
   * server's start and `clean_restart` always run the floor.
   */
  skipPhase1Floor?: boolean
  /**
   * The call timeout, in milliseconds, the gate's client is built with, as
   * its `callTimeoutMs` (b.jg5 SRJ-213). Absent, no `callTimeoutMs` is passed
   * and the client uses its own default. The CLI passes the configured value
   * (it reads its configuration first); the server's gate, run before the
   * configuration is read, passes none (its version probe may use the
   * client's default) and later replaces its client with the persona client
   * ({@link buildPersonaClient}).
   */
  callTimeoutMs?: number
}

/** A failed gate outcome. */
export type StartupGateFailure = Extract<StartupGateOutcome, { ok: false }>

/**
 * A construction failure (step 2) as the gate's outcome: the typed catches
 * for ErrBunVersionTooOld, ErrSystemInstallNotFound, ErrSystemInstallTooOld
 * and ErrSystemInstallUnreachable, and any other throw as
 * `ad-client-construct` with its message. Shared by the gate and the persona
 * client ({@link buildPersonaClient}), so both fail with one label and one
 * message per cause.
 */
function constructFailure(err: unknown): StartupGateFailure {
  if (err instanceof ErrBunVersionTooOld) {
    return {
      ok: false,
      phase: 'construct',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: 'ad-bun-version-too-old',
      message:
        `agent-director requires Bun >= 1.0.21 but the running runtime is older. ` +
        `Upgrade Bun (https://bun.sh) and retry. Detail: ${err.errDescription}`,
    }
  }
  if (err instanceof ErrSystemInstallNotFound) {
    return {
      ok: false,
      phase: 'construct',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: AD_SYSTEM_INSTALL_NOT_FOUND,
      message:
        `agent-director system install not found. The startup gate searched ` +
        `the standard install path and PATH but did not locate the agent-director ` +
        `binary. See ${RUNBOOK_SECTION_POINTER}: its step 1 checks agent-director's version as the ` +
        `workers' user in the bot server's launcher environment, which shows whether this launcher's ` +
        `HOME or PATH differs from the workers'.` +
        renderInstallSkillInstructions(),
    }
  }
  if (err instanceof ErrSystemInstallTooOld) {
    return {
      ok: false,
      phase: 'construct',
      refusalKind: REFUSAL_KIND_CLIENT_TOO_OLD,
      classLabel: AD_SYSTEM_INSTALL_TOO_OLD,
      message:
        buildSystemInstallTooOldMessage({
          foundVersion: err.actualVersion,
          requiredVersion: err.requiredVersion,
          binaryPath: err.binaryPath,
        }) + renderInstallSkillInstructions(),
    }
  }
  if (err instanceof ErrSystemInstallUnreachable) {
    return {
      ok: false,
      phase: 'construct',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
      message:
        `agent-director system install is unreachable. ` +
        `Reason: ${err.reason}. ` +
        `Binary at ${err.binaryPath} could not be invoked successfully. ` +
        `Diagnose with the install-cscb skill; see ${RUNBOOK_SECTION_POINTER}.` +
        renderInstallSkillInstructions(),
    }
  }
  const detail = err instanceof Error ? err.message : String(err)
  return {
    ok: false,
    phase: 'construct',
    refusalKind: REFUSAL_KIND_OTHER,
    classLabel: 'ad-client-construct',
    message: `Unexpected error constructing agent-director Client. Detail: ${detail}`,
  }
}

/**
 * Step 2, shared by the gate and the persona client: build a client with
 * {@link buildAdClientOptions} through `d.createClient`, and read its
 * `binaryVersion` (populated during `Client.create()`'s version probe of the
 * resolved system binary; never the client's `version()` method, whose field
 * is the npm package's version). A throw becomes {@link constructFailure}'s
 * outcome; nothing was built, so nothing is closed.
 */
async function constructClient(
  d: StartupGateDeps,
  callTimeoutMs: number | undefined,
): Promise<{ ok: true; client: unknown; adVersion: string } | StartupGateFailure> {
  let client: unknown
  try {
    client = await d.createClient(buildAdClientOptions(callTimeoutMs))
  } catch (err) {
    return constructFailure(err)
  }
  return { ok: true, client, adVersion: (client as { binaryVersion: string }).binaryVersion }
}

/**
 * Step 3, shared by the gate and the persona client: CSCB's Phase 1 floor
 * (b.jg5 SRJ-203) on a client that is not installed yet. `Client.create()`
 * enforces only the client's own minimum, which sits below the floor and
 * admits `0.0.0-dev`. Below the floor or unparseable: the client is closed
 * once and the `ad-below-phase1-floor` outcome is answered; otherwise
 * `undefined`.
 */
function refuseBelowPhase1Floor(d: StartupGateDeps, client: unknown, adVersion: string): StartupGateFailure | undefined {
  if (meetsPhase1Floor(adVersion)) return undefined
  // Read everything the message needs before closing the client, so the
  // message never depends on a getter of a closed client.
  const message = buildBelowPhase1FloorMessage({
    foundVersion: adVersion,
    binaryPath: (client as { binaryPath: string }).binaryPath,
  })
  d.closeClient(client)
  return {
    ok: false,
    phase: 'version',
    refusalKind: REFUSAL_KIND_BELOW_PHASE1_FLOOR,
    classLabel: AD_BELOW_PHASE1_FLOOR,
    message,
  }
}

/**
 * Run the SR-5.1 startup sequence without exiting. The dispatcher
 * (runAgentDirectorStartupGate) wraps this with the recordStartupError +
 * exit() side effects so tests can inspect both the raw outcome and the
 * exit-vs-no-exit decision.
 *
 * Construction failures (step 2) come back via thrown errors caught here;
 * if the constructor is the real `Client` and the module-load itself fails
 * (e.g. `node_modules/agent-director` was wiped), the surrounding cli.ts
 * try/catch at import time handles that branch — module-not-found cannot
 * be observed from inside this function because the import resolved at
 * top-of-file load time.
 */
export async function runStartupGate(
  deps?: Partial<StartupGateDeps>,
  options?: StartupGateOptions,
): Promise<StartupGateOutcome> {
  const d = mergeDeps(deps)

  // Step 2: construct Client via async factory (Client.create in prod).
  const built = await constructClient(d, options?.callTimeoutMs)
  if (!built.ok) return built
  const { client, adVersion } = built

  // Step 3: CSCB's Phase 1 floor (b.jg5 SRJ-203), before the client is
  // installed as the singleton.
  if (options?.skipPhase1Floor !== true) {
    const refusal = refuseBelowPhase1Floor(d, client, adVersion)
    if (refusal !== undefined) return refusal
  }

  // Construction and the floor passed: install the live Client into the
  // module-level singleton so subsequent `getClient()` call sites resolve to it.
  setClient(client as Client)

  // Step 3.5: API surface probes. The version checks above confirm the AD
  // binary's version, but published agent-director npm packages
  // have shipped a stale TS shim that drops methods (getPermission), drops
  // CLI flags (--request-token in buildDecide), and misses err_names in the
  // catalog. Each of those silently breaks CSCB at click-handling time. The
  // probes run 1 → 2 → 3 and short-circuit on first failure so one operator
  // message corresponds to one fix.
  if (!d.probeGetPermission(client)) {
    d.closeClient(client)
    return {
      ok: false,
      phase: 'api-surface',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: 'ad-shim-missing-get-permission',
      message:
        `agent-director Client is missing the 'getPermission' method. ` +
        `The installed shim is stale relative to the AD binary (${adVersion}). ` +
        CLIENT_PACKAGE_REMEDY,
    }
  }

  const catalogProbe = d.probeErrorCatalog()
  if (!catalogProbe.ok) {
    d.closeClient(client)
    return {
      ok: false,
      phase: 'api-surface',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: AD_SHIM_CATALOG_INCOMPLETE,
      message:
        `agent-director TS error catalog is missing required err_names: ` +
        `${catalogProbe.missing.join(', ')}. ` +
        `Envelopes with these names would arrive as ErrUnknownErrorName and be misclassified. ` +
        CLIENT_PACKAGE_REMEDY,
    }
  }

  const argvProbe = await d.probeDecideArgv(client)
  if (!argvProbe.ok) {
    d.closeClient(client)
    return {
      ok: false,
      phase: 'api-surface',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: 'ad-shim-decide-drops-token',
      message:
        `agent-director shim's decide() does not pass --request-token to the CLI: ${argvProbe.detail} ` +
        `Permission clicks would resolve against the wrong row. ` +
        CLIENT_PACKAGE_REMEDY,
    }
  }

  // Step 4: same-user check on ~/.agent-director/state.db.
  let expectedUid = d.geteuid()
  if (expectedUid === undefined || expectedUid === -1) {
    // No platform UID — defensive log, continue. CSCB targets Linux; this
    // branch is reachable only on exotic environments.
    d.recordStartupError(
      'ad-same-user-unenforced',
      `Skipping ${AD_STATE_DB_PATH} same-user check: process.geteuid() unavailable on this platform.`,
    )
    return { ok: true, client, adVersion }
  }

  try {
    const stat = d.statSync(AD_STATE_DB_PATH)
    if (stat.uid !== expectedUid) {
      d.closeClient(client)
      return {
        ok: false,
        phase: 'same-user',
        refusalKind: REFUSAL_KIND_OTHER,
        classLabel: 'ad-same-user',
        message:
          `${AD_STATE_DB_PATH} is owned by UID ${stat.uid} but this process is running as UID ${expectedUid}. ` +
          `agent-director's state DB must be owned by the same user running claude-slack-channel-bots. ` +
          `Run the server as the user that owns ${AD_STATE_DB_PATH}; never remove or recreate the file. ` +
          `See ${RUNBOOK_SECTION_POINTER}.`,
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // First-run case — file will be created on first verb call.
      return { ok: true, client, adVersion }
    }
    d.closeClient(client)
    return {
      ok: false,
      phase: 'same-user',
      refusalKind: REFUSAL_KIND_OTHER,
      classLabel: 'ad-same-user-stat',
      message:
        `Failed to stat ${AD_STATE_DB_PATH}: OS error ${code ?? 'unknown'}. ` +
        `Cannot verify same-user invariant on agent-director state.db.`,
    }
  }

  return { ok: true, client, adVersion }
}

/**
 * Production entry point: run the gate, log failures, exit non-zero on any
 * non-`ok` outcome. Returns the live `Client` and detected AD version on
 * success. It always runs the full gate, CSCB's Phase 1 floor included: it
 * offers no way to set `skipPhase1Floor`, nor `callTimeoutMs` (the server
 * runs it before its configuration is read, and replaces its client with
 * {@link buildPersonaClientOrExit}'s once the start has resolved it). A failure makes exactly one
 * `recordStartupError` call (the server-log line and the startup-errors entry).
 *
 * Tests should call `runStartupGate(...)` directly so they can inspect the
 * raw outcome without mocking `exit`.
 */
export async function runAgentDirectorStartupGate(
  deps?: Partial<StartupGateDeps>,
): Promise<{ client: unknown; adVersion: string }> {
  const d = mergeDeps(deps)
  const outcome = await runStartupGate(deps)
  if (!outcome.ok) {
    d.recordStartupError(outcome.classLabel, outcome.message)
    d.exit(1) // never returns; the cast below silences TS narrowing
    // unreachable; satisfies TS when exit() is mocked in tests
    return { client: null, adVersion: '' }
  }
  return { client: outcome.client, adVersion: outcome.adVersion }
}

// ---------------------------------------------------------------------------
// The persona client: the server's second client, with the call timeout
// ---------------------------------------------------------------------------

/** The seams of {@link buildPersonaClient} and {@link buildPersonaClientOrExit}. */
export type PersonaClientDeps = Pick<StartupGateDeps, 'createClient' | 'closeClient' | 'recordStartupError' | 'exit'>

/**
 * Build the client the server makes its persona calls with, carrying
 * `callTimeoutMs` (b.jg5 SRJ-213, SRJ-121), and install it as the singleton.
 *
 * Why a second client: the 0.10.0 client fixes `callTimeoutMs` at
 * construction, and the server's gate builds its client before the start has
 * read the configuration that holds the setting (SRJ-213 lets the gate's
 * version probe use the client's default). Once the start has resolved its
 * configuration, this builds a client with the configured value, through the
 * gate's own construction ({@link buildAdClientOptions}, the same catches)
 * and the Phase 1 floor (b.jg5 SRJ-202) on its `binaryVersion`. It repeats no API-surface
 * probe and no same-user check: they cover the installed package and the
 * store, which the gate has already checked in this process.
 *
 * On success the installed client (the gate's) is closed exactly once,
 * through the singleton module's `closeClient`, and the new client is
 * installed as the singleton in its place, with no await between the two. Every
 * consumer reads the singleton at call time (`getClient()`), so nothing keeps
 * the gate's client past the swap. On a construct failure or a floor refusal
 * nothing is installed, the built client (if any) is closed, the gate's
 * client stays in place, and the gate's own outcome (phase, refusal kind,
 * class label and message) is answered.
 */
export async function buildPersonaClient(
  callTimeoutMs: number,
  deps?: Partial<PersonaClientDeps>,
): Promise<{ ok: true; client: unknown; adVersion: string } | StartupGateFailure> {
  const d = mergeDeps(deps)
  const built = await constructClient(d, callTimeoutMs)
  if (!built.ok) return built
  const refusal = refuseBelowPhase1Floor(d, built.client, built.adVersion)
  if (refusal !== undefined) return refusal

  // The swap, with no await between its two steps: close the installed
  // client (the gate's) once and clear the slot, then install the new one.
  try {
    closeInstalledClient()
  } catch {
    // close() never throws per the library contract; defensive in tests.
  }
  setClient(built.client as Client)
  return built
}

/**
 * Production form of {@link buildPersonaClient}, as
 * {@link runAgentDirectorStartupGate} is of the gate: a failure makes exactly
 * one `recordStartupError` call (the server-log line and the startup-errors
 * entry) and exits non-zero. Returns the installed client and its version on
 * success.
 */
export async function buildPersonaClientOrExit(
  callTimeoutMs: number,
  deps?: Partial<PersonaClientDeps>,
): Promise<{ client: unknown; adVersion: string }> {
  const d = mergeDeps(deps)
  const outcome = await buildPersonaClient(callTimeoutMs, deps)
  if (!outcome.ok) {
    d.recordStartupError(outcome.classLabel, outcome.message)
    d.exit(1) // never returns; the return below satisfies TS when exit() is mocked in tests
    return { client: null, adVersion: '' }
  }
  return { client: outcome.client, adVersion: outcome.adVersion }
}

// ---------------------------------------------------------------------------
// Re-exports for callers / tests
// ---------------------------------------------------------------------------

export {
  DEFAULT_STORE_PATH,
  AD_STATE_DB_PATH as DEFAULT_STATE_DB_PATH,
  SUPPORTED_PLATFORMS,
  setClientForTests,
}
