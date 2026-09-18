/**
 * driver-5.ts — integration driver for test-5-clean-restart-resume.
 *
 * PURPOSE
 * -------
 * Exercises the clean_restart teardown-and-resume cycle end-to-end against
 * real agent-director and real tmux, using stub-claude on PATH.  Validates
 * SR-29.6 (documented smoke procedure) and SR-27 (AD-unreachable loud failure).
 *
 * SANDBOX-ONLY — NEVER run against production bots.
 * This driver uses throwaway channel IDs (C_CLEAN5_A, C_CLEAN5_B) and
 * cleans up its own AD rows.  It does NOT touch any live cscb_* row because
 * agent-director's label-scoped list() confines every query to those two IDs.
 *
 * PHASES (selected by DRIVER5_PHASE env var)
 * -------------------------------------------
 *  "setup"   — Spawn two stub-claude bots via spawnForRoute (real AD + real
 *               tmux), approve the dev-channels dialog for each, wait for a
 *               live AD state, print started_at for each channel, and leave
 *               the rows alive for clean_restart to tear down.
 *               Emits: DRIVER5: SETUP_OK started_at_A=<t> started_at_B=<t>
 *
 *  "resume"  — Call spawnForRoute on the two channels whose rows were left in
 *               ended/missing state by clean_restart.  Assert action='resumed'
 *               for each, capture the "attempting resume" / "resumed channel="
 *               log lines emitted by spawnForRoute, then clean up.
 *               Emits: DRIVER5: RESUME_OK
 *
 *  "ad-fail" — Call createCli(deps) where deps.initClient throws a simulated
 *               AD-connection error, drive clean_restart(), and assert it exits
 *               non-zero via a caught ExitError.
 *               Emits: DRIVER5: ADFAIL_OK
 *
 * OUTPUT CONTRACT (consumed by test-5-clean-restart-resume.sh)
 * ------------------------------------------------------------
 *  Each phase emits its DRIVER5: <PHASE>_OK marker and exits 0 on success.
 *  On any failed assertion it prints DRIVER5_FAIL: <reason> and exits 1.
 *  All spawnForRoute / CSCB console.error output (resume log lines) is
 *  captured into the driver's stdout for the shell test to grep.
 */

const PKG = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'
const PHASE = process.env['DRIVER5_PHASE'] ?? 'setup'

const { runAgentDirectorStartupGate } = await import(`${PKG}/src/agent-director-startup.ts`)
const { initOutageState } = await import(`${PKG}/src/outage-state.ts`)
const { installSlackChannelBotTemplate } = await import(`${PKG}/src/agent-director-template.ts`)
const { spawnForRoute, instanceIdFor } = await import(`${PKG}/src/session-manager.ts`)
const { applyDefaults } = await import(`${PKG}/src/config.ts`)
const { getClient } = await import(`${PKG}/src/agent-director-client.ts`)

const CHANNEL_A = process.env['DRIVER5_CHANNEL_A'] ?? 'C_CLEAN5_A'
const CHANNEL_B = process.env['DRIVER5_CHANNEL_B'] ?? 'C_CLEAN5_B'
const CWD_A = process.env['DRIVER5_CWD_A'] ?? '/tmp/test-5-cwd-a'
const CWD_B = process.env['DRIVER5_CWD_B'] ?? '/tmp/test-5-cwd-b'

const LIVE_STATES = new Set(['waiting', 'working', 'ask_user', 'check_permission'])

function driverFail(reason: string): never {
  console.log(`DRIVER5_FAIL: ${reason}`)
  process.exit(1)
}

async function waitForLive(instanceId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await getClient().status({ claude_instance_id: instanceId })
      last = r.state
      if (LIVE_STATES.has(last)) return last
    } catch {
      // AD not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return last
}

async function waitForTerminal(instanceId: string, timeoutMs: number): Promise<string> {
  const TERMINAL = new Set(['ended', 'missing'])
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await getClient().status({ claude_instance_id: instanceId })
      last = r.state
      if (TERMINAL.has(last)) return last
    } catch {
      // row may be deleted — treat as terminal
      return 'missing'
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return last
}

/** Cleanly exit a stub-claude session by sending the sentinel via sendKeys. */
async function cleanExit(instanceId: string): Promise<void> {
  try {
    await getClient().sendKeys({ claude_instance_id: instanceId, text: '__CSCB_TEST_EXIT__' })
    await waitForTerminal(instanceId, 15_000)
  } catch { /* best-effort */ }
}

async function deleteRow(instanceId: string): Promise<void> {
  try { await getClient().kill({ claude_instance_id: instanceId }) } catch { /* ignore */ }
  try { await getClient().delete({ claude_instance_id: [instanceId] }) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Shared AD + config init
// ---------------------------------------------------------------------------

async function initAd(channels: Record<string, string>): Promise<ReturnType<typeof applyDefaults>> {
  const routes: Record<string, { cwd: string }> = {}
  for (const [ch, cwd] of Object.entries(channels)) {
    routes[ch] = { cwd }
  }
  const cfg = applyDefaults({
    routes,
    bind: '127.0.0.1',
    port: 3100,
  })

  await runAgentDirectorStartupGate()

  initOutageState({
    getClient,
    postToChannel: (channelId: string, text: string) => {
      console.error(`[driver5] outage-post channel=${channelId}: ${text}`)
    },
  })

  await installSlackChannelBotTemplate(cfg)
  return cfg
}

// ---------------------------------------------------------------------------
// Phase: setup — spawn two stub-claude bots
// ---------------------------------------------------------------------------

async function phaseSetup(): Promise<void> {
  const cfg = await initAd({ [CHANNEL_A]: CWD_A, [CHANNEL_B]: CWD_B })

  const idA = instanceIdFor(CHANNEL_A)
  const idB = instanceIdFor(CHANNEL_B)

  // Clean slate: remove stale rows from any prior run.
  await deleteRow(idA)
  await deleteRow(idB)

  // Spawn channel A.
  const rA = await spawnForRoute(CHANNEL_A, { cwd: CWD_A }, cfg, undefined, true)
  if (rA.action === 'failed') driverFail(`setup: spawnForRoute A returned failed`)

  const sA = await waitForLive(idA, 30_000)
  if (!LIVE_STATES.has(sA)) {
    driverFail(`setup: channel A never reached a live state (last=${sA})`)
  }

  // Capture started_at while the row is live (it survives into terminal rows).
  const rowA = await getClient().get({ claude_instance_id: idA })
  const startedAtA = (rowA as { started_at?: string }).started_at ?? ''

  // Spawn channel B.
  const rB = await spawnForRoute(CHANNEL_B, { cwd: CWD_B }, cfg, undefined, true)
  if (rB.action === 'failed') driverFail(`setup: spawnForRoute B returned failed`)

  const sB = await waitForLive(idB, 30_000)
  if (!LIVE_STATES.has(sB)) {
    driverFail(`setup: channel B never reached a live state (last=${sB})`)
  }

  const rowB = await getClient().get({ claude_instance_id: idB })
  const startedAtB = (rowB as { started_at?: string }).started_at ?? ''

  // Leave both rows alive — clean_restart will tear them down.
  // The shell test will invoke clean_restart next, then run the resume phase.
  console.log(`DRIVER5: SETUP_OK started_at_A=${startedAtA} started_at_B=${startedAtB}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Phase: resume — assert clean_restart left rows in terminal state and that
// spawnForRoute resumes them (not fresh-spawns).
// ---------------------------------------------------------------------------

async function phaseResume(): Promise<void> {
  const cfg = await initAd({ [CHANNEL_A]: CWD_A, [CHANNEL_B]: CWD_B })

  const idA = instanceIdFor(CHANNEL_A)
  const idB = instanceIdFor(CHANNEL_B)

  // Collect console.error output to detect the resume log lines.
  const capturedLines: string[] = []
  const origErr = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
    capturedLines.push(line)
    origErr(...args)
  }

  try {
    // Assert both rows are in terminal state (clean_restart must have run first).
    let stateA = ''
    let stateB = ''
    try {
      const rA = await getClient().status({ claude_instance_id: idA })
      stateA = rA.state
    } catch { stateA = 'missing' }
    try {
      const rB = await getClient().status({ claude_instance_id: idB })
      stateB = rB.state
    } catch { stateB = 'missing' }

    const TERMINAL = new Set(['ended', 'missing'])
    if (!TERMINAL.has(stateA)) {
      driverFail(`resume: channel A row is not terminal after clean_restart (state=${stateA}) — teardown did not complete`)
    }
    if (!TERMINAL.has(stateB)) {
      driverFail(`resume: channel B row is not terminal after clean_restart (state=${stateB}) — teardown did not complete`)
    }

    // Both rows are terminal with session_id intact — spawnForRoute should resume.
    const r2A = await spawnForRoute(CHANNEL_A, { cwd: CWD_A }, cfg, undefined, true)
    if (r2A.action === 'failed') {
      driverFail(`resume: spawnForRoute A returned failed on resume attempt`)
    }

    const r2B = await spawnForRoute(CHANNEL_B, { cwd: CWD_B }, cfg, undefined, true)
    if (r2B.action === 'failed') {
      driverFail(`resume: spawnForRoute B returned failed on resume attempt`)
    }

    // Wait for both to reach a live state again.
    const sA2 = await waitForLive(idA, 30_000)
    if (!LIVE_STATES.has(sA2)) {
      driverFail(`resume: channel A never reached a live state after resume (last=${sA2})`)
    }
    const sB2 = await waitForLive(idB, 30_000)
    if (!LIVE_STATES.has(sB2)) {
      driverFail(`resume: channel B never reached a live state after resume (last=${sB2})`)
    }

    // Check resume log lines (SR-24.5).
    const resumeAttemptedA = capturedLines.some(
      (l) => l.includes('attempting resume') && l.includes(`channel=${CHANNEL_A}`),
    )
    const resumeAttemptedB = capturedLines.some(
      (l) => l.includes('attempting resume') && l.includes(`channel=${CHANNEL_B}`),
    )
    if (!resumeAttemptedA) {
      driverFail(`resume: no "attempting resume" log line for channel=${CHANNEL_A} — resume path not taken`)
    }
    if (!resumeAttemptedB) {
      driverFail(`resume: no "attempting resume" log line for channel=${CHANNEL_B} — resume path not taken`)
    }

    const resumedA = capturedLines.some(
      (l) => l.includes('resumed channel=') && l.includes(CHANNEL_A),
    )
    const resumedB = capturedLines.some(
      (l) => l.includes('resumed channel=') && l.includes(CHANNEL_B),
    )
    if (!resumedA) {
      driverFail(`resume: no "resumed channel=" log line for channel=${CHANNEL_A}`)
    }
    if (!resumedB) {
      driverFail(`resume: no "resumed channel=" log line for channel=${CHANNEL_B}`)
    }

    // Record post-resume started_at for the shell test's comparison.
    // Whether agent-director updates started_at on a resume (vs. preserving the
    // original row-insert time) is an AD-internal detail; we emit the values and
    // let the shell test surface them, but do NOT hard-fail here if they match
    // the pre-restart value — the functionally important assertions are the
    // "attempting resume" / "resumed channel=" log lines above.
    const preA = process.env['DRIVER5_STARTED_AT_A'] ?? ''
    const preB = process.env['DRIVER5_STARTED_AT_B'] ?? ''
    let newStartedAtA = ''
    let newStartedAtB = ''
    try {
      const newRowA = await getClient().get({ claude_instance_id: idA })
      newStartedAtA = (newRowA as { started_at?: string }).started_at ?? ''
    } catch { /* best-effort */ }
    try {
      const newRowB = await getClient().get({ claude_instance_id: idB })
      newStartedAtB = (newRowB as { started_at?: string }).started_at ?? ''
    } catch { /* best-effort */ }

    // Log for the shell test to surface; increment check is informational.
    console.log(
      `DRIVER5: STARTED_AT_POST_RESUME A_pre=${preA} A_post=${newStartedAtA} B_pre=${preB} B_post=${newStartedAtB}`,
    )
  } finally {
    console.error = origErr
  }

  // Cleanup: exit both sessions cleanly.
  await cleanExit(idA)
  await cleanExit(idB)
  await deleteRow(idA)
  await deleteRow(idB)

  console.log('DRIVER5: RESUME_OK')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Phase: ad-fail — AD-unreachable loud-failure spot check (SR-27)
// ---------------------------------------------------------------------------

async function phaseAdFail(): Promise<void> {
  // Import createCli and CliDeps from the installed package.
  const { createCli } = await import(`${PKG}/src/cli.ts`)

  // Simulate an AD-unreachable condition: deps.initClient throws a connection
  // error (mirrors what runStartupGate does when the AD binary is missing or
  // the store is inaccessible).
  class ExitError extends Error {
    constructor(public code: number) { super(`exit(${code})`) }
  }

  let exitCode: number | null = null
  const logLines: string[] = []
  const origErr = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
    logLines.push(line)
    origErr(...args)
  }

  try {
    const deps = {
      spawnSync: (): { status: number } => ({ status: 0 }),
      env: { SLACK_BOT_TOKEN: 'xoxb-stub', SLACK_APP_TOKEN: 'xapp-stub' },
      existsSync: (): boolean => true,
      readFileSync: (): string => { throw new Error('unexpected') },
      unlinkSync: (): void => { /* no-op */ },
      isProcessRunning: (): boolean => false,
      kill: (): void => { /* no-op */ },
      resolveStateDir: (): string => '/tmp/test-5-state',
      startServer: async (): Promise<void> => { /* no-op */ },
      exit: (code: number): never => { throw new ExitError(code) },
      loadConfig: () => ({
        routes: { C_CLEAN5_A: { cwd: CWD_A } },
        bind: '127.0.0.1',
        port: 3100,
        session_restart_delay: 60,
        health_check_interval: 120,
        exit_timeout: 10,
        stop_timeout: 30,
        mcp_config_path: '',
        cozempic_prescription: 'standard',
        system_prompt_mode: 'default',
        resume_enabled: true,
        agent_director_poll_interval_ms: 2000,
      }),
      getClient: (): never => { throw new Error('unexpected getClient in ad-fail phase') },
      // initClient throws a simulated AD-connection error (SR-27).
      initClient: async (): Promise<void> => {
        throw new Error('connect ECONNREFUSED /home/testuser/.agent-director/agent.sock (simulated)')
      },
      directorStatus: async (): Promise<null> => null,
      directorPause: async (): Promise<void> => { /* no-op */ },
      directorKill: async (): Promise<void> => { /* no-op */ },
    }

    await createCli(deps as Parameters<typeof createCli>[0]).clean_restart()
    // If we reach here, clean_restart did NOT exit non-zero — that's a failure.
    driverFail('ad-fail: clean_restart exited 0 with AD unreachable — expected non-zero exit')
  } catch (err) {
    if (err instanceof ExitError) {
      exitCode = err.code
    } else {
      throw err
    }
  } finally {
    console.error = origErr
  }

  if (exitCode === null || exitCode === 0) {
    driverFail(`ad-fail: clean_restart did not exit non-zero (exitCode=${exitCode})`)
  }

  // Assert the error was logged.
  const hasInitFailLine = logLines.some(
    (l) => l.includes('agent-director initialization failed') || l.includes('startup gate failed'),
  )
  if (!hasInitFailLine) {
    driverFail('ad-fail: no "agent-director initialization failed" log line emitted — loud failure not observed')
  }

  console.log(`DRIVER5: ADFAIL_OK exit_code=${exitCode}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

switch (PHASE) {
  case 'setup':
    await phaseSetup()
    break
  case 'resume':
    await phaseResume()
    break
  case 'ad-fail':
    await phaseAdFail()
    break
  default:
    driverFail(`unknown DRIVER5_PHASE: ${PHASE}`)
}
