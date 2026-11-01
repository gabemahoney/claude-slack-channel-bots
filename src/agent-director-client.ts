/**
 * agent-director-client.ts — Module-level singleton wrapper for the
 * `agent-director` library Client.
 *
 * Public API:
 *   - getClient(): Client                          — sync cached accessor for the singleton
 *   - setClient(client): void                       — install a pre-built Client (the startup module only)
 * - closeClient: void — idempotent shutdown for Event 11 and the persona-client swap
 *   - DEFAULT_STORE_PATH / DEFAULT_TEMPLATE_NAME    — paths CSCB pins
 *   - resetClientForTests(): void                   — test-only handle reset
 *
 * Construction: AD 0.7.0+ exposes an async `Client.create()` factory; the
 * subprocess constructor is protected and `new Client(...)` is a compile-time
 * TS error. The startup gate (src/agent-director-startup.ts) awaits
 * `Client.create()` with the options built by the one options builder in that
 * module (store path, create-if-missing, the filtered logger, plus
 * `callTimeoutMs` when a call timeout is given) and hands the resolved
 * instance to `setClient()`. Once the start has resolved its configuration,
 * the server's persona client replaces the gate's client
 * through the same `setClient()` path. Verb call sites pull the
 * installed singleton through `getClient()`; calling `getClient()` before the
 * gate has installed a Client throws an internal bug-marker error (it
 * indicates a caller-site bug, not a runtime condition).
 *
 * Displayed states: AD 0.16 and 0.17.0 can show `needs_intelligence` over a
 * raw `check_permission` row and `idle_screen` over a raw `working` row, in
 * `state`. Both are reports only, and a `list` state filter matches the shown
 * state alone (AD `docs/caller-contract.md`, "Needs-intelligence and
 * idle-screen rows"). From AD 0.17.1 `state` is always the raw state, the
 * Displayed States come in `displayed_state`, which CSCB does not read, and a
 * `list` state filter matches `state` or `displayed_state`.
 * `normaliseDisplayedStates` normalises a client in place, keeping its
 * identity: `get`, `status` and `list` answer each row's raw state, and a
 * `list` state filter also asks for the displayed states shown over the raw
 * states it names (AD before 0.16 ignores the unknown values). When it widens
 * a filter, `list` then keeps only the rows whose raw state the caller named,
 * so from AD 0.17.1, where normalising changes nothing, the rows answered are
 * exactly the raw-state rows asked for. A `list` limit counts rows before
 * that drop (CSCB passes no limit with a state filter). Every other field
 * and verb passes through unchanged. The startup module's one client
 * construction (the gate's, the persona client's and each delivery client's)
 * applies it, and installing a client (`setClient`, `setClientForTests`)
 * applies it again, idempotently, for clients built elsewhere such as test
 * stubs. A verb assigned on the client after that is not normalised.
 *
 * Concurrency: AD's Client is internally safe for concurrent verb calls
 * (the subprocess-CLI transport serializes its own dispatch),
 * so CSCB does NOT add its own mutex.
 *
 * SPDX-License-Identifier: MIT
 */

import { AgentDirectorError, Client } from 'agent-director'
import type {
  DecideParams as ADDecideParams,
  DecideResult,
  GetPermissionParams as ADGetPermissionParams,
  GetPermissionResult as ADGetPermissionResult,
} from 'agent-director'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default AD store path; tilde-expanded library-side. */
export const DEFAULT_STORE_PATH = '~/.config/agent-director/state.db'

/** Name of the CSCB-shipped template. */
export const DEFAULT_TEMPLATE_NAME = 'slack-channel-bot'

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let singleton: Client | null = null

// ---------------------------------------------------------------------------
// Displayed-state normalisation
// ---------------------------------------------------------------------------

/** AD's Displayed States, each mapped to the raw state it is shown over. */
const RAW_STATE_OF_DISPLAYED: Readonly<Record<string, string>> = {
  needs_intelligence: 'check_permission',
  idle_screen: 'working',
}

type RowVerb = (this: unknown, ...args: unknown[]) => Promise<unknown>

/** The normalising verbs installed, so a reinstall does not wrap one twice. */
const normalisingVerbs = new WeakSet<RowVerb>()

/** `row` with a displayed `state` replaced by its raw state; any other value as given. */
function withRawState<T>(row: T): T {
  if (row === null || typeof row !== 'object') return row
  const raw = RAW_STATE_OF_DISPLAYED[(row as { state?: unknown }).state as string]
  return raw === undefined ? row : { ...row, state: raw }
}

/** `params` with its `state` filter widened by the displayed states shown over the raw states it names. */
function withDisplayedStateFilter(params: unknown): unknown {
  const state = (params as { state?: unknown } | null | undefined)?.state
  if (!Array.isArray(state)) return params
  const extra = Object.entries(RAW_STATE_OF_DISPLAYED)
    .filter(([displayed, raw]) => state.includes(raw) && !state.includes(displayed))
    .map(([displayed]) => displayed)
  return extra.length === 0 ? params : { ...(params as object), state: [...state, ...extra] }
}

/**
 * The `list` result with each row's displayed state replaced by its raw state
 * and, when `asked` is given, only the rows whose raw state is one of `asked`.
 */
function withRawListStates(result: unknown, asked: readonly unknown[] | null): unknown {
  const spawns = (result as { spawns?: unknown } | null | undefined)?.spawns
  if (!Array.isArray(spawns)) return result
  const raw = spawns.map(withRawState)
  const rows = asked === null
    ? raw
    : raw.filter((row) => asked.includes((row as { state?: unknown } | null | undefined)?.state))
  return rows.length === spawns.length && rows.every((row, i) => row === spawns[i])
    ? result
    : { ...(result as object), spawns: rows }
}

/** Normalise `client`'s `get`, `status` and `list` in place (see the module header); a non-object as given. */
export function normaliseDisplayedStates<T>(client: T): T {
  if (client === null || typeof client !== 'object') return client
  const verbs = client as unknown as Record<'get' | 'status' | 'list', RowVerb | undefined>
  const wrap = (verb: 'get' | 'status' | 'list', normalised: (inner: RowVerb) => RowVerb): void => {
    const inner = verbs[verb]
    if (typeof inner !== 'function' || normalisingVerbs.has(inner)) return
    const outer = normalised(inner)
    normalisingVerbs.add(outer)
    verbs[verb] = outer
  }
  wrap('get', (inner) => async (...args) => withRawState(await inner.apply(client, args)))
  wrap('status', (inner) => async (...args) => withRawState(await inner.apply(client, args)))
  wrap('list', (inner) => async (params, ...rest) => {
    const widened = withDisplayedStateFilter(params)
    const asked = widened === params ? null : (params as { state: readonly unknown[] }).state
    return withRawListStates(await inner.apply(client, [widened, ...rest]), asked)
  })
  return client
}

/**
 * Return the singleton Client installed by the startup gate.
 *
 * This is a sync cached accessor; it does NOT construct the Client. The
 * startup gate (`runAgentDirectorStartupGate`) is responsible for awaiting
 * `Client.create(...)` and installing the result via `setClient`. Calling
 * `getClient()` before the gate has run is a caller-site bug and throws
 * loudly — there is no lazy-construction fallback.
 */
export function getClient(): Client {
  if (singleton === null) {
    throw new Error(
      'agent-director-client: getClient() called before the startup gate installed a Client — caller-site bug. The startup gate must run first (via runAgentDirectorStartupGate).',
    )
  }
  return singleton
}

/**
 * Release the Client handle if open. Idempotent: a second call is a no-op.
 * `client.close()` itself never throws per the library contract.
 *
 * Called from the contract Event 11 (graceful shutdown) inside a try/finally.
 */
export function closeClient(): void {
  if (singleton !== null) {
    singleton.close()
    singleton = null
  }
}

/**
 * Test-only helper: drop the cached singleton WITHOUT closing it. Use when
 * tests construct fake Clients via the agent-director-stub and want a clean
 * slate per test. Production code must use closeClient() instead.
 *
 * @internal
 */
export function resetClientForTests(): void {
  singleton = null
}

/**
 * Install a pre-built Client into the singleton slot, replacing any installed
 * one without closing it. Called only from src/agent-director-startup.ts: by
 * the startup gate after `await Client.create(opts)` resolves, and, in the
 * server, once more by the persona-client builder (`buildPersonaClient`),
 * which, once the start has resolved its configuration, closes the gate's
 * client through `closeClient()` and installs the client carrying the
 * configured call timeout. Production verb call sites never invoke this — they go
 * through `getClient()` at call time, so none keeps a replaced client.
 * Lexically distinct from `setClientForTests` so the test helper stays
 * grep-discoverable.
 */
export function setClient(client: Client): void {
  singleton = normaliseDisplayedStates(client)
}

/**
 * Test-only helper: install a pre-built Client (typically a stub) as the
 * singleton. Skip the Client construction path entirely. The client is
 * normalised as `setClient` normalises it.
 *
 * @internal
 */
export function setClientForTests(client: Client): void {
  singleton = normaliseDisplayedStates(client)
}

// ---------------------------------------------------------------------------
// decide-wire wrapper
// ---------------------------------------------------------------------------

/**
 * CSCB decide params — extends `DecideParams` with the `request_token` field
 * The snake-case JSON field flows through the subprocess-CLI
 * transport without further marshaling on this side.
 *
 * Typing `request_token` as a required field at the wrapper boundary is how
 * (unconditional pass-through) is enforced statically — every CSCB
 * decide call site must construct one of these.
 */
export interface DecideParamsWithToken extends ADDecideParams {
  request_token: string
}

/** Send the required request token through the released client's native type. */
export async function decideWithToken(
  client: Pick<Client, 'decide'>,
  params: DecideParamsWithToken,
): Promise<DecideResult> {
  return client.decide(params)
}

// ---------------------------------------------------------------------------
// get-permission wrapper
// ---------------------------------------------------------------------------

/**
 * Params + result for AD's `get-permission` verb (shipped in `^0.6.1`+).
 * Re-exported from `agent-director` so the local consumers
 * (`permission-poller`, `permission-click-handler`, tests) reference one
 * source of truth. `decision` / `decision_reason` / `decided_at` are
 * optional + nullable on AD's type because the same row shape covers both
 * open and closed states; `classifyVerdict` collapses any non-canonical
 * combination into the fail-closed generic-deny path.
 */
export type GetPermissionParams = ADGetPermissionParams
export type GetPermissionResult = ADGetPermissionResult

/**
 * Local sentinel matcher for AD's `ErrPermissionRequestNotFound`. Matches an
 * `AgentDirectorError` whose `errName` is `ErrPermissionRequestNotFound`, so
 * the client's typed class and the stub's base-class value both match.
 */
export function isErrPermissionRequestNotFound(err: unknown): boolean {
  return err instanceof AgentDirectorError && err.errName === 'ErrPermissionRequestNotFound'
}

/**
 * `get-permission` wrapper. The `agent-director` package.json pin is
 * at `^0.6.0`+, which carries the verb; the startup gate is the
 * compatibility boundary that keeps stale-version installs from reaching this
 * path. The wrapper takes a structural client (rather than
 * `Pick<Client, 'getPermission'>`) because the locked `0.5.6` types do not yet
 * expose the method shape, and fails loudly at runtime when the verb is
 * missing as defense-in-depth for the dev/test edge (e.g. stub clients that
 * omit it on purpose).
 */
export async function getPermission(
  client: { getPermission?: (params: GetPermissionParams) => Promise<GetPermissionResult> },
  params: GetPermissionParams,
): Promise<GetPermissionResult> {
  if (typeof client.getPermission !== 'function') {
    throw new Error(
      'agent-director-client: getPermission verb unavailable — ' +
        'confirm installed agent-director version meets the package.json pin',
    )
  }
  return client.getPermission(params)
}
