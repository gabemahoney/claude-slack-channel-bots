/**
 * agent-director-client.ts — Module-level singleton wrapper for the
 * `agent-director` library Client (SR-0.1).
 *
 * Public API:
 *   - getClient(): Client                          — sync cached accessor for the singleton
 *   - setClient(client): void                       — install a pre-built Client (startup gate only)
 *   - closeClient(): void                           — idempotent shutdown for SR-11 Event 11
 *   - DEFAULT_STORE_PATH / DEFAULT_TEMPLATE_NAME    — paths CSCB pins
 *   - resetClientForTests(): void                   — test-only handle reset
 *
 * Construction: AD 0.7.0+ exposes an async `Client.create()` factory; the
 * subprocess constructor is protected and `new Client(...)` is a compile-time
 * TS error. The SR-5.1 startup gate (src/agent-director-startup.ts) awaits
 * `Client.create({ storePath, createIfMissing: true, logger: console })` and
 * then hands the resolved instance to `setClient()`. Verb call sites pull the
 * installed singleton through `getClient()`; calling `getClient()` before the
 * gate has installed a Client throws an internal bug-marker error (it
 * indicates a caller-site bug, not a runtime condition).
 *
 * Concurrency: AD's Client is internally safe for concurrent verb calls
 * (the subprocess-CLI transport serializes its own dispatch) per SR-0.1,
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
export const DEFAULT_STORE_PATH = '~/.agent-director/state.db'

/** Name of the CSCB-shipped template (SR-3.1). */
export const DEFAULT_TEMPLATE_NAME = 'slack-channel-bot'

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let singleton: Client | null = null

/**
 * Return the singleton Client installed by the SR-5.1 startup gate.
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
 * Called from SR-11 Event 11 (graceful shutdown) inside a try/finally.
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
 * Install a pre-built Client into the singleton slot. Called once by the
 * startup gate (src/agent-director-startup.ts) after `await Client.create(opts)`
 * resolves. Production verb call sites never invoke this — they go through
 * `getClient()`. Lexically distinct from `setClientForTests` so the test
 * helper stays grep-discoverable.
 */
export function setClient(client: Client): void {
  singleton = client
}

/**
 * Test-only helper: install a pre-built Client (typically a stub) as the
 * singleton. Skip the Client construction path entirely.
 *
 * @internal
 */
export function setClientForTests(client: Client): void {
  singleton = client
}

// ---------------------------------------------------------------------------
// decide-wire wrapper (SR-4.1, SR-7.2)
// ---------------------------------------------------------------------------

/**
 * CSCB decide params — extends `DecideParams` with the `request_token` field
 * (SR-7.2). The snake-case JSON field flows through the subprocess-CLI
 * transport without further marshaling on this side.
 *
 * Typing `request_token` as a required field at the wrapper boundary is how
 * SR-4.1 (unconditional pass-through) is enforced statically — every CSCB
 * decide call site must construct one of these.
 */
export interface DecideParamsWithToken extends ADDecideParams {
  request_token: string
}

/**
 * Always-include-token decide wrapper. The `agent-director` package.json pin
 * is at `^0.6.0`+, which carries `request_token` on `DecideParams` natively.
 * The structural cast is retained because, until the lockfile is refreshed to
 * resolve the bumped pin, the imported `DecideParams` type still comes from
 * the locked `0.5.6` package — same lockfile-lag pattern as
 * `GetResultWithPermissionRequests`.
 *
 * Routing the single CSCB decide call site through this function gives the
 * codebase one definitive serializer for the decide wire shape (SR-7.2).
 */
export async function decideWithToken(
  client: Pick<Client, 'decide'>,
  params: DecideParamsWithToken,
): Promise<DecideResult> {
  return client.decide(params as unknown as ADDecideParams)
}

// ---------------------------------------------------------------------------
// get-permission wrapper (SR-7.1)
// ---------------------------------------------------------------------------

/**
 * Params + result for AD's `get-permission` verb (shipped in `^0.6.1`+).
 * Re-exported from `agent-director` so the local consumers
 * (`permission-poller`, `permission-click-handler`, tests) reference one
 * source of truth. `decision` / `decision_reason` / `decided_at` are
 * optional + nullable on AD's type because the same row shape covers both
 * open and closed states; `classifyVerdict` collapses any non-canonical
 * combination into the SR-5.2 fail-closed generic-deny path.
 */
export type GetPermissionParams = ADGetPermissionParams
export type GetPermissionResult = ADGetPermissionResult

/**
 * Local sentinel matcher for AD's `ErrPermissionRequestNotFound`. Matches on
 * `errName` so both the typed class (`^0.6.0`+ exposes it) and the stub's
 * AgentDirectorError-shape resolve cleanly. The errName-based predicate keeps
 * working with the typed class when the lockfile catches up to the bumped
 * pin (same pattern as `ErrInvalidFlags`).
 */
export function isErrPermissionRequestNotFound(err: unknown): boolean {
  return err instanceof AgentDirectorError && err.errName === 'ErrPermissionRequestNotFound'
}

/**
 * `get-permission` wrapper (SR-7.1). The `agent-director` package.json pin is
 * at `^0.6.0`+, which carries the verb; the SR-6.1 startup gate is the
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
