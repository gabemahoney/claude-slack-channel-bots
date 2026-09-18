/**
 * driver.ts — non-dry-run integration driver for the b.vub regression
 * (test-4-resume-dialog).
 *
 * WHY A DRIVER INSTEAD OF THE FULL DAEMON
 * ---------------------------------------
 * The b.vub bug lives entirely in spawnForRoute / approvePreSessionDialogs.
 * Launching the whole daemon non-dry-run requires real Slack credentials
 * (web.auth.test + Socket Mode) which CI does not have. But the exact code path
 * that shipped the bug — real agent-director + real tmux, a real
 * --dangerously-load-development-channels dialog, the CSCB approver, and the
 * resume lap — is reachable by calling the SAME production functions directly
 * with web=undefined and WITHOUT SLACK_DRY_RUN. That is what this driver does.
 *
 * It imports from the INSTALLED package (the tarball under test), so it exercises
 * shipped code, not the working tree.
 *
 * SCENARIO
 * --------
 *   Phase 1 (fresh spawn past the dialog):
 *     spawnForRoute() -> real AD spawns a tmux pane running stub-claude, which
 *     prints the dev-channels dialog and blocks. approvePreSessionDialogs sees
 *     the needle, sends Enter, stub fires SessionStart -> AD row goes `waiting`.
 *     ASSERT: action != 'failed' AND AD status is a live state.
 *
 *   Force the b.vub precondition:
 *     kill the tmux pane, then findMissing -> the row goes `missing` while its
 *     session_id (recorded by the Phase-1 SessionStart hook) is preserved.
 *     ASSERT: state == 'missing' AND session_id present (resume is possible).
 *
 *   Phase 2 (resume past the dialog AGAIN — the regression):
 *     spawnForRoute() again -> collision -> get=missing -> resume -> stub-claude
 *     re-prints the dialog. PRE-FIX: the resume path never called the approver,
 *     so the dialog stuck forever and the row stayed `missing`, producing the
 *     ErrTmuxSessionCreate respawn loop. POST-FIX: approvePreSessionDialogs runs
 *     on the resume-success path and drives it past the dialog.
 *     ASSERT: action != 'failed' AND AD status is a live state again.
 *
 * OUTPUT CONTRACT (consumed by test-4-resume-dialog.sh)
 * -----------------------------------------------------
 *   Emits `DRIVER: PHASE1_OK`, `DRIVER: PRECONDITION_OK`, `DRIVER: PHASE2_OK`
 *   on success and exits 0. On any failed assertion it prints
 *   `DRIVER_FAIL: <reason>` and exits 1. All CSCB console.error output (which
 *   includes any `ErrTmuxSessionCreate`) goes to stderr, which the bash test
 *   tees into a log file for the no-loop assertion.
 */

const PKG = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

const { runAgentDirectorStartupGate } = await import(`${PKG}/src/agent-director-startup.ts`)
const { initOutageState } = await import(`${PKG}/src/outage-state.ts`)
const { installSlackChannelBotTemplate } = await import(`${PKG}/src/agent-director-template.ts`)
const { spawnForRoute, instanceIdFor } = await import(`${PKG}/src/session-manager.ts`)
const { applyDefaults } = await import(`${PKG}/src/config.ts`)
const { getClient } = await import(`${PKG}/src/agent-director-client.ts`)

const LIVE_STATES = new Set(['waiting', 'working', 'ask_user', 'check_permission'])

const CHANNEL = process.env['DRIVER_CHANNEL'] ?? 'C_RESUME'
const CWD = process.env['DRIVER_CWD'] ?? '/tmp/test-repo-resume'

function driverFail(reason: string): never {
  console.log(`DRIVER_FAIL: ${reason}`)
  process.exit(1)
}

async function statusState(instanceId: string): Promise<string> {
  try {
    const r = await getClient().status({ claude_instance_id: instanceId })
    return r.state
  } catch (err) {
    return `<status-error: ${String(err)}>`
  }
}

async function waitForLive(instanceId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await statusState(instanceId)
    if (LIVE_STATES.has(last)) return last
    await new Promise((r) => setTimeout(r, 300))
  }
  return last
}

async function main(): Promise<void> {
  // Build the routing config the same way the daemon does.
  const cfg = applyDefaults({
    routes: { [CHANNEL]: { cwd: CWD } },
    bind: '127.0.0.1',
    port: 3100,
  })

  // Real AD Client via the production startup gate (installs the singleton).
  await runAgentDirectorStartupGate()

  // spawnForRoute goes through withSpawnDetection/withOutageDetection, which
  // need outage-state wired. Post-to-channel is log-only (no Slack in CI).
  initOutageState({
    getClient,
    postToChannel: (channelId: string, text: string) => {
      console.error(`[driver] outage-post channel=${channelId}: ${text}`)
    },
  })

  // Install the CSCB template (carries --dangerously-load-development-channels).
  await installSlackChannelBotTemplate(cfg)

  const instanceId = instanceIdFor(CHANNEL)

  // Clean slate: remove any stale row/session from a prior run.
  try { await getClient().kill({ claude_instance_id: instanceId }) } catch { /* ignore */ }
  try { await getClient().delete({ claude_instance_id: [instanceId] }) } catch { /* ignore */ }

  // -------------------------------------------------------------------------
  // Phase 1 — fresh spawn must get PAST the dev-channels dialog.
  // -------------------------------------------------------------------------
  const r1 = await spawnForRoute(CHANNEL, { cwd: CWD }, cfg, undefined, true)
  if (r1.action === 'failed') driverFail(`phase1 spawnForRoute returned failed`)

  const s1 = await waitForLive(instanceId, 30_000)
  if (!LIVE_STATES.has(s1)) {
    driverFail(`phase1 spawn never reached a live state (last=${s1}) — dialog not cleared`)
  }
  console.log(`DRIVER: PHASE1_OK action=${r1.action} state=${s1}`)

  // -------------------------------------------------------------------------
  // Precondition — force the b.vub state: a terminal (`ended`) row that still
  // carries a session_id, so a resume is possible.
  //
  // Root cause of the earlier /ci failures (diagnosed IN the Linux container):
  // `client.kill` DOES tear down the tmux session, but `find-missing` then
  // returns count:0 and leaves the row `waiting` forever — agent-director's
  // Linux process probe / degraded-mode guard refuses to transition a row when
  // the (already-dead) process can't be correlated under gosu/testuser. This is
  // structural, not lag (verified: 30s+ never transitions in-container), even
  // though kill+find-missing works on macOS.
  //
  // Deterministic, environment-independent fix: drive the stub `claude` to EXIT
  // CLEANLY. We send a sentinel line via `agent-director send-keys` (the row is
  // `waiting` → interactive, so AD accepts it); the stub fires its SessionEnd
  // hook (a pure DB write, no /proc probe) → row `ended` with session_id intact,
  // then exits. An `ended`+session_id row is exactly the b.vub resume
  // precondition.
  // -------------------------------------------------------------------------

  // Capture the session_id while the row is still live — resume needs it and we
  // don't want to depend on it surviving the terminal transition.
  const liveRow = await getClient().get({ claude_instance_id: instanceId })
  const liveSid = (liveRow as { claude_session_id?: string }).claude_session_id ?? ''
  if (!liveSid || liveSid === 'null') {
    driverFail(`precondition: no claude_session_id on the live row (SessionStart hook did not record one) — resume would be impossible`)
  }

  // Request a clean session end. sendKeys appends Enter, so the stub reads the
  // sentinel as a full line, fires SessionEnd, and exits.
  await getClient().sendKeys({ claude_instance_id: instanceId, text: '__CSCB_TEST_EXIT__' })

  const TERMINAL = new Set(['ended', 'missing'])
  const preDeadline = Date.now() + 20_000
  let termState = ''
  let termSid = ''
  while (Date.now() < preDeadline) {
    await new Promise((r) => setTimeout(r, 300))
    const row = await getClient().get({ claude_instance_id: instanceId })
    if (TERMINAL.has(row.state)) {
      termState = row.state
      termSid = (row as { claude_session_id?: string }).claude_session_id ?? ''
      break
    }
  }
  if (!termState) {
    driverFail(`precondition: row never reached ended/missing within 20s after clean-exit sentinel (SessionEnd hook did not fire?)`)
  }
  // session_id must survive into the terminal row (fall back to the live capture,
  // which is what resume actually needs).
  const sid = termSid && termSid !== 'null' ? termSid : liveSid
  if (!sid || sid === 'null') {
    driverFail(`precondition: terminal row has no claude_session_id — resume would be impossible`)
  }
  console.log(`DRIVER: PRECONDITION_OK state=${termState} session_id_present=true`)

  // -------------------------------------------------------------------------
  // Phase 2 — the regression: resume must drive PAST the dialog again.
  // -------------------------------------------------------------------------
  const r2 = await spawnForRoute(CHANNEL, { cwd: CWD }, cfg, undefined, true)
  if (r2.action === 'failed') driverFail(`phase2 spawnForRoute returned failed (resume did not recover)`)

  const s2 = await waitForLive(instanceId, 30_000)
  if (!LIVE_STATES.has(s2)) {
    driverFail(`phase2 resume never reached a live state (last=${s2}) — dialog not re-approved (b.vub regression)`)
  }
  console.log(`DRIVER: PHASE2_OK action=${r2.action} state=${s2}`)

  // Best-effort cleanup so the pane/row don't linger.
  try { await getClient().kill({ claude_instance_id: instanceId }) } catch { /* ignore */ }
  try { await getClient().delete({ claude_instance_id: [instanceId] }) } catch { /* ignore */ }
  console.log('DRIVER: DONE')
  process.exit(0)
}

main().catch((err) => {
  driverFail(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
})
