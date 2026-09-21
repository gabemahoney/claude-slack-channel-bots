/**
 * inbound-recovery-drop-branch.test.ts — b.kvq
 *
 * Bug: an inbound Slack message to a routed-but-sessionless channel was dropped
 * at src/server.ts's drop branch BEFORE anything called scheduleRestart, so a
 * dead/spawn-capped route could never recover from a human typing in the
 * channel. The courtesy reply ("session starting up, please retry") also lied
 * for capped/dead routes.
 *
 * The fix rewrites the drop branch to, when a route is configured, resolve the
 * OWNING channel of the session (direct route → the inbound channel;
 * default_route fallback → the direct route whose cwd === default_route), then
 * branch on the owner's restart state and either trigger a fast human-clamped
 * recovery keyed to the owner or reply honestly to the inbound channel. In
 * src/restart.ts, scheduleRestart gained an optional { humanTrigger } that
 * clamps the computed backoff delay DOWN to HUMAN_TRIGGER_DELAY_CEILING
 * (never up).
 *
 * This file owns the no-route/null-config coverage and the drop-branch reply
 * coverage that formerly lived in the retired tests/not-delivered-reply.test.ts
 * (which asserted the deleted PRE-b.kvq reply). The upstream session-resolution
 * / default_route fallback logic is covered by tests/default-route-fallback.ts.
 * A source-anchor tripwire (describe (8)) fails loudly if this mirror drifts
 * from src/server.ts.
 *
 * server.ts cannot be imported in tests (module-scope side effects:
 * loadTokens() runs at import time, src/server.ts:197). So these tests replicate
 * the exact drop-branch decision from the diff in a small local helper
 * (decideDropBranch) that drives the REAL restart.ts and backoff.ts modules
 * through their existing deps-injection seams. The recovery, no-stack, cap and
 * disabled behaviors are therefore exercised for real — not asserted as string
 * or existence checks. The delay-clamp behavior (restart.ts) is exercised
 * directly against scheduleRestart with a captured global setTimeout.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'os'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  _resetRestartState,
  HUMAN_TRIGGER_DELAY_CEILING,
  RESTART_FAILURE_CAP,
  type RestartDeps,
} from '../src/restart.ts'
import {
  _resetBackoffState,
  recordFailure,
  isAtCap as backoffIsAtCap,
} from '../src/backoff.ts'
import type { RoutingConfig } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01 // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = 9999 // large enough to never fire during a test
const WAIT_MS = 50

// ---------------------------------------------------------------------------
// restart.ts deps factory (mirrors tests/restart.test.ts makeDeps)
// ---------------------------------------------------------------------------

type DepsOpts = {
  launchSessionResult?: boolean
  restartDelay?: number
  launchSession?: (channelId: string, cwd: string, sessionId?: string) => Promise<boolean>
}

function makeRestartDeps(opts: DepsOpts = {}): RestartDeps & {
  launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }>
} {
  const launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }> = []
  return {
    launchSessionCalls,
    async isSessionAlive() { return false },
    isSessionConnected() { return false },
    hasSessionStream() { return true },
    async reconnectSession() { /* not reached — session is dead */ },
    async killSession() { /* no-op */ },
    async launchSession(channelId, cwd, sessionId) {
      launchSessionCalls.push({ channelId, cwd, sessionId })
      if (opts.launchSession) return opts.launchSession(channelId, cwd, sessionId)
      return opts.launchSessionResult ?? true
    },
    getRestartDelay: () => opts.restartDelay ?? FAST_DELAY_S,
    isShuttingDown: () => false,
    onCapReached() { /* no-op */ },
  }
}

// ---------------------------------------------------------------------------
// RoutingConfig builder
// ---------------------------------------------------------------------------

function makeRoutingConfig(opts: {
  channelId?: string
  cwd?: string
  default_route?: string
  session_restart_delay?: number
  // Extra direct routes, e.g. the OWNER of the default_route cwd. Merged into
  // routes alongside the primary { channelId: { cwd } } entry.
  extraRoutes?: Record<string, { cwd: string }>
} = {}): RoutingConfig {
  const channelId = opts.channelId ?? 'C_CONFIGURED'
  const cwd = opts.cwd ?? '/tmp/kvq-session'
  const config: RoutingConfig = {
    routes: { [channelId]: { cwd }, ...(opts.extraRoutes ?? {}) },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: opts.session_restart_delay ?? 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
    cron_table_path: `${homedir()}/.claude/channels/slack/crontab`,
    cron_log_path: `${homedir()}/.claude/channels/slack/cron.log`,
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    resume_enabled: true,
    stop_hook_bootstrap: true,
    agent_director_poll_interval_ms: 1000,
  }
  if (opts.default_route !== undefined) config.default_route = opts.default_route
  return config
}

// ---------------------------------------------------------------------------
// decideDropBranch — faithful in-test mirror of the drop branch rewritten in
// src/server.ts:631-694. It calls the REAL restart.ts/backoff.ts seams:
//   - isRestartPendingOrActive (restart.ts)
//   - backoffIsAtCap           (backoff.ts, imported as isAtCap)
//   - scheduleRestart          (restart.ts, with { humanTrigger: true })
//
// It returns the decision plus any Slack reply text, so tests can assert on
// both the real side effect (a launch was/ wasn't scheduled) and the reply.
//
// The cwd-derivation and the four-way branch below are copied verbatim in
// structure from the diff; if server.ts's ordering/text changes, these tests
// change with it.
// ---------------------------------------------------------------------------

type DropDecision = {
  triggeredRecovery: boolean
  replyText: string | null
  // The channel the reply is posted to — ALWAYS the inbound channel.
  replyChannelId: string | null
  // The channel the recovery is keyed to (guards + launch). For a direct route
  // this equals the inbound channel; for default_route it is the OWNING route.
  ownerChannelId: string | undefined
  branch: 'no-route' | 'already-restarting' | 'disabled' | 'capped' | 'triggered'
}

function decideDropBranch(
  channelId: string,
  routingConfig: RoutingConfig | null,
): DropDecision {
  // b.kvq: resolve BOTH the configured cwd and the channel that OWNS the
  // session on that cwd. Direct route → owner is the inbound channel.
  // default_route fallback → owner is the direct route whose cwd ===
  // default_route (config.ts guarantees exactly one such route). Guards and the
  // launch key on ownerChannelId; the reply still posts to the inbound channel.
  const directRoute = routingConfig?.routes[channelId]
  let cwd: string | undefined
  let ownerChannelId: string | undefined
  if (directRoute) {
    cwd = directRoute.cwd
    ownerChannelId = channelId
  } else if (routingConfig?.default_route && !routingConfig.routes[channelId]) {
    cwd = routingConfig.default_route
    for (const [ownerId, route] of Object.entries(routingConfig.routes)) {
      if (route.cwd === cwd) {
        ownerChannelId = ownerId
        break
      }
    }
    // No owning route found (should be impossible per config validation) →
    // drop silently rather than spawn a duplicate under the inbound channelId.
    if (!ownerChannelId) cwd = undefined
  }

  if (!(cwd && ownerChannelId)) {
    // No configured route (or unresolvable owner) → drop silently.
    return {
      triggeredRecovery: false,
      replyText: null,
      replyChannelId: null,
      ownerChannelId: undefined,
      branch: 'no-route',
    }
  }

  const alreadyRestarting = isRestartPendingOrActive(ownerChannelId)
  const autoRestartDisabled = (routingConfig?.session_restart_delay ?? 60) === 0
  const capped = backoffIsAtCap(ownerChannelId, RESTART_FAILURE_CAP)

  if (alreadyRestarting) {
    return {
      triggeredRecovery: false,
      replyText:
        'Your message was not delivered. The session is restarting — please retry in a moment.',
      replyChannelId: channelId,
      ownerChannelId,
      branch: 'already-restarting',
    }
  }
  if (autoRestartDisabled) {
    return {
      triggeredRecovery: false,
      replyText:
        'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ' +
        'so it will NOT recover on its own — an operator must restart the server.',
      replyChannelId: channelId,
      ownerChannelId,
      branch: 'disabled',
    }
  }
  if (capped) {
    return {
      triggeredRecovery: false,
      replyText:
        'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ' +
        'and will NOT recover on its own — an operator must restart the server.',
      replyChannelId: channelId,
      ownerChannelId,
      branch: 'capped',
    }
  }
  scheduleRestart(ownerChannelId, cwd, undefined, { humanTrigger: true })
  return {
    triggeredRecovery: true,
    replyText:
      'Your message was not delivered and was not saved. I have started the session for this channel — ' +
      'please retry in a moment.',
    replyChannelId: channelId,
    ownerChannelId,
    branch: 'triggered',
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRestartState()
  _resetBackoffState()
})

// ===========================================================================
// Required behavior 1 — routed-but-sessionless channel triggers recovery
// ===========================================================================

describe('b.kvq (1) routed-but-sessionless channel triggers recovery', () => {
  test('a message to a routed channel with no session schedules a launch', async () => {
    const deps = makeRestartDeps()
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_CONFIGURED', cwd: '/tmp/kvq-session' })

    const decision = decideDropBranch('C_CONFIGURED', cfg)

    expect(decision.branch).toBe('triggered')
    expect(decision.triggeredRecovery).toBe(true)
    // Real side effect: a restart is now pending for this channel.
    expect(isRestartPendingOrActive('C_CONFIGURED')).toBe(true)

    // And the timer really fires and launches with the configured cwd.
    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_CONFIGURED')
    expect(deps.launchSessionCalls[0].cwd).toBe('/tmp/kvq-session')
  })

  test('a channel served only by default_route recovers under the OWNING route id, using the default cwd', async () => {
    const deps = makeRestartDeps()
    initRestart(deps)
    // C_UNROUTED has no direct route; default_route (/tmp/kvq-default) covers
    // it. C_OWNER is the direct route whose cwd === default_route — it OWNS the
    // session on that cwd. Recovery must key to C_OWNER, not C_UNROUTED, so the
    // launch reuses the owner's instance id / tmux name and guards.
    const cfg = makeRoutingConfig({
      channelId: 'C_OWNER',
      cwd: '/tmp/kvq-default',
      default_route: '/tmp/kvq-default',
    })

    const decision = decideDropBranch('C_UNROUTED', cfg)

    expect(decision.branch).toBe('triggered')
    // Reply still goes to the INBOUND channel …
    expect(decision.replyChannelId).toBe('C_UNROUTED')
    // … but recovery is keyed to the OWNER.
    expect(decision.ownerChannelId).toBe('C_OWNER')
    // The real pending-restart state is recorded under the owner, not inbound.
    expect(isRestartPendingOrActive('C_OWNER')).toBe(true)
    expect(isRestartPendingOrActive('C_UNROUTED')).toBe(false)

    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_OWNER')
    expect(deps.launchSessionCalls[0].cwd).toBe('/tmp/kvq-default')
  })

  test('a pending restart on the OWNER suppresses a launch triggered from the unrouted inbound channel', async () => {
    // SLOW delay keeps the owner's restart pending across the inbound message.
    const deps = makeRestartDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)
    const cfg = makeRoutingConfig({
      channelId: 'C_OWNER',
      cwd: '/tmp/kvq-default',
      default_route: '/tmp/kvq-default',
    })

    // The owner's session is already restarting (e.g. from a health tick).
    scheduleRestart('C_OWNER', '/tmp/kvq-default', undefined, { humanTrigger: true })
    expect(isRestartPendingOrActive('C_OWNER')).toBe(true)
    expect(deps.launchSessionCalls).toHaveLength(0) // SLOW delay: not fired yet

    // A human types into the UNROUTED default_route channel. The guard reads the
    // OWNER's pending state — so no second launch is stacked.
    const decision = decideDropBranch('C_UNROUTED', cfg)

    expect(decision.branch).toBe('already-restarting')
    expect(decision.triggeredRecovery).toBe(false)
    // Reply still posts to the inbound channel.
    expect(decision.replyChannelId).toBe('C_UNROUTED')
    expect(decision.ownerChannelId).toBe('C_OWNER')
    // Had the guard keyed on the inbound channel, its pending state would be
    // empty and this would have stacked a second launch.
  })

  test('a cap on the OWNER suppresses recovery triggered from the unrouted inbound channel', () => {
    initRestart(makeRestartDeps({ restartDelay: SLOW_DELAY_S }))
    const cfg = makeRoutingConfig({
      channelId: 'C_OWNER',
      cwd: '/tmp/kvq-default',
      default_route: '/tmp/kvq-default',
    })

    // Drive the OWNER (not the inbound channel) to the failure cap.
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure('C_OWNER')
    expect(backoffIsAtCap('C_OWNER', RESTART_FAILURE_CAP)).toBe(true)
    // The inbound channel is NOT at cap — keying on it would wrongly launch.
    expect(backoffIsAtCap('C_UNROUTED', RESTART_FAILURE_CAP)).toBe(false)

    const decision = decideDropBranch('C_UNROUTED', cfg)

    expect(decision.branch).toBe('capped')
    expect(decision.triggeredRecovery).toBe(false)
    expect(decision.replyChannelId).toBe('C_UNROUTED')
    expect(decision.ownerChannelId).toBe('C_OWNER')
  })
})

// ===========================================================================
// Required behavior 2 — no route triggers nothing
// ===========================================================================

describe('b.kvq (2) unconfigured channel triggers nothing', () => {
  test('a message to a channel with no route and no default_route schedules no launch', async () => {
    const deps = makeRestartDeps()
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_CONFIGURED' }) // no default_route

    const decision = decideDropBranch('C_UNKNOWN', cfg)

    expect(decision.branch).toBe('no-route')
    expect(decision.triggeredRecovery).toBe(false)
    expect(decision.replyText).toBeNull()
    expect(isRestartPendingOrActive('C_UNKNOWN')).toBe(false)

    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('a message with routingConfig null schedules no launch', async () => {
    const deps = makeRestartDeps()
    initRestart(deps)

    const decision = decideDropBranch('C_CONFIGURED', null)

    expect(decision.branch).toBe('no-route')
    expect(decision.replyText).toBeNull()
    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 3 — a second message while restarting does not stack
// ===========================================================================

describe('b.kvq (3) second message while restart pending/active does not stack a launch', () => {
  test('two messages in quick succession produce exactly one launch', async () => {
    // SLOW delay keeps the first restart pending across the second message so
    // isRestartPendingOrActive is true when the second arrives.
    const deps = makeRestartDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    const first = decideDropBranch('C_CONFIGURED', cfg)
    expect(first.branch).toBe('triggered')
    expect(isRestartPendingOrActive('C_CONFIGURED')).toBe(true)

    // Second message: the guard catches it — no second scheduleRestart.
    const second = decideDropBranch('C_CONFIGURED', cfg)
    expect(second.branch).toBe('already-restarting')
    expect(second.triggeredRecovery).toBe(false)
    expect(second.replyText).toContain('restarting')
  })

  test('while a launch is actively in flight, a new message does not stack another launch', async () => {
    // Hold launchSession open so the channel is in activeLaunches (not just a
    // pending timer) when the second message arrives.
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })
    const deps = makeRestartDeps({
      restartDelay: FAST_DELAY_S,
      launchSession: () => launchPromise,
    })
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    decideDropBranch('C_CONFIGURED', cfg)
    await Bun.sleep(WAIT_MS) // timer fired; launchSession is now awaiting

    expect(isRestartPendingOrActive('C_CONFIGURED')).toBe(true)
    expect(deps.launchSessionCalls).toHaveLength(1)

    const second = decideDropBranch('C_CONFIGURED', cfg)
    expect(second.branch).toBe('already-restarting')

    // Still exactly one launch despite the second message.
    expect(deps.launchSessionCalls).toHaveLength(1)

    launchResolve(true)
    await Bun.sleep(1)
  })
})

// ===========================================================================
// Required behavior 4 — reply text differs per branch; none imply delivery
// ===========================================================================

describe('b.kvq (4) user-facing reply differs correctly per branch', () => {
  test('the four branches produce distinct, honest replies; none imply delivery', () => {
    // (a) triggered-now
    let deps = makeRestartDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)
    _resetBackoffState()
    const triggered = decideDropBranch('C_A', makeRoutingConfig({ channelId: 'C_A' }))

    // (b) pending-restart (second message while C_A is pending)
    const pending = decideDropBranch('C_A', makeRoutingConfig({ channelId: 'C_A' }))

    // (c) at-cap
    _resetRestartState()
    initRestart(makeRestartDeps({ restartDelay: SLOW_DELAY_S }))
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure('C_C')
    expect(backoffIsAtCap('C_C', RESTART_FAILURE_CAP)).toBe(true)
    const capped = decideDropBranch('C_C', makeRoutingConfig({ channelId: 'C_C' }))

    // (d) auto-restart disabled
    const disabled = decideDropBranch(
      'C_D',
      makeRoutingConfig({ channelId: 'C_D', session_restart_delay: 0 }),
    )

    // All four replies are distinct.
    const texts = [triggered.replyText, pending.replyText, capped.replyText, disabled.replyText]
    expect(new Set(texts).size).toBe(4)

    // None of the replies imply the message was delivered.
    for (const t of texts) {
      expect(t).not.toBeNull()
      expect(t!.toLowerCase()).toContain('not delivered')
    }

    // Distinguishing content per branch:
    // triggered — recovery underway, retry.
    expect(triggered.replyText!.toLowerCase()).toContain('started the session')
    expect(triggered.replyText!.toLowerCase()).toContain('retry in a moment')
    // pending — restarting, retry; NOT an operator instruction.
    expect(pending.replyText!.toLowerCase()).toContain('restarting')
    expect(pending.replyText!.toLowerCase()).toContain('retry in a moment')
    expect(pending.replyText!.toLowerCase()).not.toContain('operator')
    // capped — will NOT recover; operator must restart.
    expect(capped.replyText!.toLowerCase()).toContain('will not recover')
    expect(capped.replyText!.toLowerCase()).toContain('operator')
    expect(capped.replyText!.toLowerCase()).not.toContain('retry in a moment')
    // disabled — will NOT recover; operator must restart.
    expect(disabled.replyText!.toLowerCase()).toContain('will not recover')
    expect(disabled.replyText!.toLowerCase()).toContain('operator')
    expect(disabled.replyText!.toLowerCase()).not.toContain('retry in a moment')
  })
})

// ===========================================================================
// Required behavior 5 — getRestartDelay()===0 path behaves sanely
// ===========================================================================

describe('b.kvq (5) auto-restart disabled (delay 0) path', () => {
  test('disabled branch schedules no launch and gives an honest reply', async () => {
    // Even if the branch mistakenly called scheduleRestart, restart.ts would
    // early-return on baseDelay===0. Here we assert both: no launch is scheduled
    // AND the reply does not pretend recovery is underway.
    const deps = makeRestartDeps({ restartDelay: 0 })
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_CONFIGURED', session_restart_delay: 0 })

    const decision = decideDropBranch('C_CONFIGURED', cfg)

    expect(decision.branch).toBe('disabled')
    expect(decision.triggeredRecovery).toBe(false)
    expect(isRestartPendingOrActive('C_CONFIGURED')).toBe(false)
    expect(decision.replyText!.toLowerCase()).toContain('will not recover')

    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('scheduleRestart with humanTrigger still early-returns when base delay is 0', async () => {
    // Pin the restart.ts gate directly: humanTrigger does not bypass the
    // disabled gate.
    const deps = makeRestartDeps({ restartDelay: 0 })
    initRestart(deps)

    scheduleRestart('C_CONFIGURED', '/tmp/kvq-session', undefined, { humanTrigger: true })
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('C_CONFIGURED')).toBe(false)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 6 — humanTrigger clamps delay DOWN only
//
// These tests capture the delay argument passed to global setTimeout by
// scheduleRestart, so they read the ACTUAL scheduled delay rather than waiting
// out multi-second timers. restart.ts uses the global setTimeout, so wrapping
// it here is a legitimate observation seam.
// ===========================================================================

describe('b.kvq (6) humanTrigger delay clamp (DOWN only)', () => {
  const realSetTimeout = globalThis.setTimeout
  let capturedDelayMs: number | null = null

  beforeEach(() => {
    capturedDelayMs = null
    // Capture the delay, but do NOT actually arm a real timer (return a stub
    // handle) so the launch never fires during these timing-only tests.
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      capturedDelayMs = ms ?? 0
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
  })

  test('a 900s-cap-regime backoff is clamped down to HUMAN_TRIGGER_DELAY_CEILING', () => {
    const deps = makeRestartDeps({ restartDelay: 60 })
    initRestart(deps)
    // Drive failure count high enough that nextBackoffDelay saturates at 900s:
    // 60 * 2^4 = 960 → clamped to 900 by backoff.ts.
    for (let i = 0; i < 4; i++) recordFailure('C_CAP900')

    scheduleRestart('C_CAP900', '/tmp/kvq-session', undefined, { humanTrigger: true })

    // Computed backoff was 900s; humanTrigger clamps it to the 5s ceiling.
    expect(capturedDelayMs).toBe(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })

  test('a NON-human trigger in the same 900s regime is NOT clamped', () => {
    const deps = makeRestartDeps({ restartDelay: 60 })
    initRestart(deps)
    for (let i = 0; i < 4; i++) recordFailure('C_CAP900')

    scheduleRestart('C_CAP900', '/tmp/kvq-session') // no opts → not human

    expect(capturedDelayMs).toBe(900 * 1000)
  })

  test('a delay already below the ceiling is NOT raised by humanTrigger', () => {
    // base 1s, zero failures → nextBackoffDelay = 1s, which is below the 5s
    // ceiling. Math.min must leave it at 1s (clamp DOWN only).
    const deps = makeRestartDeps({ restartDelay: 1 })
    initRestart(deps)

    scheduleRestart('C_SMALL', '/tmp/kvq-session', undefined, { humanTrigger: true })

    expect(capturedDelayMs).toBe(1 * 1000)
    expect(capturedDelayMs).toBeLessThan(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })
})

// ===========================================================================
// Required behavior 7 — regression guard
//
// REGRESSION GUARD: the test below asserts the PRE-FIX bug is gone. Before the
// fix, the drop branch never called scheduleRestart for a routed-but-sessionless
// channel (the whole point of b.kvq), so no launch was ever scheduled and the
// reply claimed "session starting up" without any recovery underway. This test
// asserts a real launch IS scheduled and fires. With the pre-fix restart.ts
// (no humanTrigger param) AND pre-fix server.ts (no scheduleRestart in the drop
// branch), decideDropBranch's triggered path would not exist / not fire.
//
// Verified by stashing the src changes and running this file: see report.
// ===========================================================================

describe('b.kvq (7) regression guard — routed-sessionless message actually launches', () => {
  test('REGRESSION: the drop branch schedules and fires a real recovery launch', async () => {
    const deps = makeRestartDeps({ restartDelay: FAST_DELAY_S })
    initRestart(deps)
    const cfg = makeRoutingConfig({ channelId: 'C_REGRESSION', cwd: '/tmp/kvq-regress' })

    // Pre-fix: no launch is ever scheduled from the drop branch.
    const decision = decideDropBranch('C_REGRESSION', cfg)
    expect(decision.triggeredRecovery).toBe(true)

    await Bun.sleep(WAIT_MS)

    // Post-fix: a real launch fired with the configured cwd.
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].cwd).toBe('/tmp/kvq-regress')
  })
})

// ===========================================================================
// Required behavior 8 — source-anchor tripwire (mirror-drift guard)
//
// decideDropBranch above is a hand-written mirror of the src/server.ts drop
// branch. If server.ts changes the owner-keyed scheduleRestart call shape or
// any of the four reply strings and this mirror is NOT updated in lockstep, the
// behavioral tests keep passing against a stale mirror and silently stop
// covering production. These static asserts read the real source and fail loudly
// on drift. Follows the existing precedent in tests/jsonl-safeguard-wiring.test.ts.
// ===========================================================================

describe('b.kvq (8) source-anchor tripwire — mirror matches src/server.ts', () => {
  const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')

  test('src schedules recovery under the owner id with a human trigger', () => {
    // The mirror calls scheduleRestart(ownerChannelId, cwd, undefined,
    // { humanTrigger: true }); the source must do the same (owner-keyed launch).
    expect(SERVER_SRC).toContain(
      'scheduleRestart(ownerChannelId, cwd, undefined, { humanTrigger: true })',
    )
  })

  test('src guards and launch are keyed on ownerChannelId, not the inbound channelId', () => {
    expect(SERVER_SRC).toContain('isRestartPendingOrActive(ownerChannelId)')
    expect(SERVER_SRC).toContain('backoffIsAtCap(ownerChannelId, RESTART_FAILURE_CAP)')
  })

  test('src contains the four reply strings this file mirrors, verbatim', () => {
    // Each string is duplicated in decideDropBranch above; drift on any one
    // would make a behavioral assertion here check text that no longer ships.
    const replies = [
      'Your message was not delivered. The session is restarting — please retry in a moment.',
      'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ',
      'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ',
      'Your message was not delivered and was not saved. I have started the session for this channel — ',
    ]
    for (const r of replies) {
      expect(SERVER_SRC).toContain(r)
    }
  })
})
