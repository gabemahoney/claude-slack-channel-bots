/**
 * driver.ts — non-dry-run integration driver for test-4-resume-dialog: a
 * fresh launch and a resumed launch held at the dev-channels dialog, each
 * cleared by CSCB's dialog approver through agent-director on the launch's
 * `pending` row.
 *
 * WHY A DRIVER INSTEAD OF THE FULL DAEMON
 * ---------------------------------------
 * Launching the whole daemon non-dry-run requires each persona's real Slack
 * credentials file (auth.test + one Socket Mode connection per persona), which
 * CI does not have. The launch path under test — real agent-director + real
 * tmux, a real --dangerously-load-development-channels dialog, the dialog
 * approver that runs after the launch returns, and the resume lap — is
 * reachable by calling the SAME production function (spawnForPersona) with no
 * Slack client or notifier and WITHOUT SLACK_DRY_RUN. That is what this driver
 * does.
 *
 * It imports from the INSTALLED package (the tarball under test), so it exercises
 * shipped code, not the working tree. It builds a one-persona configuration
 * through the package's persona resolver (resolvePersonaConfig), exactly as the
 * daemon's loader does: one channel that also takes permission prompts, the
 * working directory DRIVER_WORKING_DIRECTORY, and a credentials_file path that
 * is never read (the driver opens no Slack connection). The instance ID is
 * cscb_<key>, with the key derived from the persona name.
 *
 * The approver is followed through the package's own seams: whether it runs
 * (isDialogApproverRunning), how it ended (_whenDialogApproverStopped: the stop
 * reason and the launch start it kept, in epoch ms) and the live stop reason
 * (APPROVER_STOP_LIVE). A row's raw `launch_started_at` (RFC 3339, shown on
 * `pending` rows only) is turned into epoch ms by the package's own parser
 * (parseLaunchStart), the one the approver uses, so the two compare exactly.
 *
 * The persona name is the script's own and each container run starts from a
 * new agent-director store, so the first launch finds no row. No row is ever
 * deleted: the cleanup kills the session and leaves the row ended and kept.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR               installed package dir
 *   DRIVER_PERSONA             persona name (default `resume_test`; an in-form
 *                              name, so the key equals the name)
 *   DRIVER_PERSONA_CHANNEL     the persona's one channel ID (default `C0RESUME1`)
 *   DRIVER_WORKING_DIRECTORY   the persona's working directory
 *
 * SCENARIO
 * --------
 *   Phase 1 (fresh launch past the dialog):
 *     spawnForPersona() -> real agent-director spawns a tmux pane running
 *     stub-claude, which prints the dev-channels dialog and blocks; the row
 *     is `pending`. spawnForPersona returns as soon as the launch call
 *     returns, with the persona's approver started and still running. The
 *     approver reads the row through agent-director (`status`, `read-pane`
 *     with allow_pending), sees the needle and presses Enter (`send-keys`
 *     with allow_pending); stub-claude fires SessionStart and the row goes
 *     live, which stops the approver.
 *     ASSERT: action == 'spawned'; the approver is running when
 *     spawnForPersona returns; it stops with APPROVER_STOP_LIVE and kept a
 *     launch start; `status` then reads a live state.
 *
 *   Precondition (a resumable ended row):
 *     the driver sends stub-claude its exit sentinel through agent-director
 *     `send-keys`; stub-claude fires SessionEnd and exits, so the row is
 *     `ended` (or `missing`) and keeps its claude_session_id.
 *     ASSERT: a terminal state AND a session_id present (resume is possible).
 *
 *   Phase 2 (resumed launch past the dialog again):
 *     spawnForPersona() again -> collision -> the row reads ended -> resume ->
 *     stub-claude re-prints the dialog and the resumed row is `pending` with
 *     a new launch start. The driver reads that launch start with one `get`
 *     right after spawnForPersona returns, while the row is still `pending`
 *     (the only state that shows it): the approver's first lap starts once
 *     the launch call has returned, and the row leaves `pending` only after
 *     that lap's `status`, `read-pane` and Enter `send-keys` and then
 *     stub-claude's SessionStart hook. The approver clears the dialog as in
 *     phase 1.
 *     ASSERT: action == 'resumed'; the approver is running when
 *     spawnForPersona returns; the row reads `pending` with a launch start;
 *     the approver stops with APPROVER_STOP_LIVE and kept a launch start
 *     equal to the row's; `status` then reads a live state.
 *
 *   Any other action (`latched`, `failed` or anything unexpected), an
 *   approver that is not running, that stops for another reason, keeps no
 *   launch start or does not stop within the driver's wait
 *   (approverStopWaitMs) fails the run.
 *
 * OUTPUT CONTRACT (consumed by test-4-resume-dialog.sh)
 * -----------------------------------------------------
 *   Emits `DRIVER: PHASE1_OK`, `DRIVER: PRECONDITION_OK`, `DRIVER: PHASE2_OK`
 *   and `DRIVER: DONE` on success and exits 0. On any failed assertion it
 *   prints `DRIVER_FAIL: <reason>` and exits 1. All CSCB console.error output
 *   (the approver's own lines included) goes to stderr, which the bash test
 *   writes to a log file it shows on failure.
 */

const PKG = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

const { runAgentDirectorStartupGate } = await import(`${PKG}/src/agent-director-startup.ts`)
const { initOutageState } = await import(`${PKG}/src/outage-state.ts`)
const { installSlackChannelBotTemplate } = await import(`${PKG}/src/agent-director-template.ts`)
const {
  spawnForPersona,
  isDialogApproverRunning,
  _whenDialogApproverStopped,
  APPROVER_STOP_LIVE,
  DIALOG_SLOW_POLL_INTERVAL_MS,
} = await import(`${PKG}/src/session-manager.ts`)
const { adGraceMsInEffect, adLaunchBoundMsInEffect } = await import(`${PKG}/src/ad-settings.ts`)
const { parseLaunchStart } = await import(`${PKG}/src/pending-row.ts`)
const { personaInstanceId, personaKey } = await import(`${PKG}/src/persona-identity.ts`)
const { resolvePersonaConfig } = await import(`${PKG}/src/config.ts`)
const { getClient } = await import(`${PKG}/src/agent-director-client.ts`)

const LIVE_STATES = new Set(['waiting', 'working', 'ask_user', 'check_permission'])
const PENDING_STATE = 'pending'

/** Slack over G plus the slow pace, for the agent-director calls of the approver's last lap. */
const APPROVER_STOP_WAIT_MARGIN_MS = 25_000

/**
 * How long the driver waits for an approver to stop, from the package's own
 * values in effect (read at the call, as the approver reads them): G plus
 * the approver's slow pace plus APPROVER_STOP_WAIT_MARGIN_MS (90 s at the
 * defaults). The stub's SessionStart hook can be held up to G before
 * agent-director applies it, and once G has passed the approver's laps slow
 * to DIALOG_SLOW_POLL_INTERVAL_MS, so the lap that reads the row live can
 * come one slow pace after that. B (the approver's own bound) is at least G
 * plus a minute, so this wait ends before a `bound` stop could; the run
 * fails at once if it would not (or if G never ends).
 */
function approverStopWaitMs(phase: string): number {
  const graceMs = adGraceMsInEffect()
  const boundMs = adLaunchBoundMsInEffect()
  const waitMs = graceMs + DIALOG_SLOW_POLL_INTERVAL_MS + APPROVER_STOP_WAIT_MARGIN_MS
  if (!Number.isFinite(waitMs) || waitMs >= boundMs) {
    driverFail(`${phase} the driver's approver wait (${waitMs} ms, from G ${graceMs} ms) is not below B (${boundMs} ms)`)
  }
  return waitMs
}

const PERSONA_NAME = process.env['DRIVER_PERSONA'] ?? 'resume_test'
const PERSONA_CHANNEL = process.env['DRIVER_PERSONA_CHANNEL'] ?? 'C0RESUME1'
const WORKING_DIRECTORY = process.env['DRIVER_WORKING_DIRECTORY'] ?? '/tmp/test-repo-resume'
/** Never read: the driver opens no Slack connection. Outside the working directory. */
const UNUSED_CREDENTIALS_FILE = '/tmp/test-4-unused-credentials.json'

/** How one approver ended, as `_whenDialogApproverStopped` resolves it. */
interface ApproverOutcome {
  readonly reason: string
  readonly launchStartMs: number | undefined
}

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

/** Fails the run unless `action` is `expected`, naming `latched` and `failed` as such. */
function expectAction(phase: string, action: string, expected: string): void {
  if (action === 'latched' || action === 'failed') {
    driverFail(`${phase} spawnForPersona returned ${action}`)
  }
  if (action !== expected) driverFail(`${phase} spawnForPersona returned ${action}, not ${expected}`)
}

/** Fails the run unless the persona's approver is running; call it right after spawnForPersona returns. */
function expectApproverRunning(phase: string, key: string): void {
  if (!isDialogApproverRunning(key)) {
    driverFail(`${phase} no dialog approver was running for ${key} when spawnForPersona returned`)
  }
}

/**
 * Awaits the persona's approver's stop and fails the run unless it stopped
 * with APPROVER_STOP_LIVE and kept a launch start. Answers that launch start
 * (epoch ms).
 */
async function awaitApproverLiveStop(phase: string, key: string): Promise<number> {
  const waitMs = approverStopWaitMs(phase)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs)
  })
  const outcome = (await Promise.race([_whenDialogApproverStopped(key), timedOut])) as
    | ApproverOutcome
    | undefined
    | 'timeout'
  clearTimeout(timer)
  if (outcome === 'timeout') {
    driverFail(`${phase} the dialog approver for ${key} did not stop within ${waitMs} ms`)
  }
  if (outcome === undefined) driverFail(`${phase} no outcome recorded for ${key}'s dialog approver`)
  if (outcome.reason !== APPROVER_STOP_LIVE) {
    driverFail(`${phase} the dialog approver stopped with reason ${outcome.reason}, not ${APPROVER_STOP_LIVE} (dialog not cleared)`)
  }
  if (outcome.launchStartMs === undefined) {
    driverFail(`${phase} the dialog approver kept no launch start (no lap read the row ${PENDING_STATE} with one)`)
  }
  return outcome.launchStartMs
}

/** Fails the run unless `status` reads a live state; answers it. */
async function expectLive(phase: string, instanceId: string): Promise<string> {
  const state = await statusState(instanceId)
  if (!LIVE_STATES.has(state)) {
    driverFail(`${phase} status read ${state} after the approver stopped ${APPROVER_STOP_LIVE}, not a live state`)
  }
  return state
}

async function main(): Promise<void> {
  // Build the persona config through the same resolver the daemon's loader
  // uses (defaults applied, paths resolved). The config dir only anchors the
  // cron path defaults, which the spawn path never reads.
  const personaCfg = resolvePersonaConfig(
    {
      personas: [
        {
          name: PERSONA_NAME,
          credentials_file: UNUSED_CREDENTIALS_FILE,
          working_directory: WORKING_DIRECTORY,
          channels: [{ id: PERSONA_CHANNEL, delivery: 'all' }],
          permission_prompts: PERSONA_CHANNEL,
        },
      ],
      bind: '127.0.0.1',
      port: 3100,
    },
    WORKING_DIRECTORY,
  )
  const key = personaKey(PERSONA_NAME)
  const persona = personaCfg.personas.find((p: { key: string }) => p.key === key)
  if (personaCfg.personas.length !== 1 || !persona) {
    driverFail(`config: expected one persona with key ${key}, got ${personaCfg.personas.length}`)
  }

  // Real AD Client via the production startup gate (installs the singleton).
  await runAgentDirectorStartupGate()

  // spawnForPersona goes through withSpawnDetection/withOutageDetection, which
  // need outage-state wired. The persona notice hook is log-only (no Slack in CI).
  initOutageState({
    getClient,
    notify: (key: string, text: string) => {
      console.error(`[driver] outage-notice persona=${key}: ${text}`)
    },
  })

  // Install the CSCB template (carries --dangerously-load-development-channels)
  // from the persona config, as the daemon does. The session manager's
  // pre-launch trust patcher stays uninstalled (no patch runs): stub-claude
  // prints only the dev-channels dialog, never the trust dialog.
  await installSlackChannelBotTemplate(personaCfg)

  const instanceId = personaInstanceId(key)

  // -------------------------------------------------------------------------
  // Phase 1 — a fresh launch; the approver clears the dialog on its `pending` row.
  // -------------------------------------------------------------------------
  const r1 = await spawnForPersona(persona, personaCfg, true)
  expectAction('phase1', r1.action, 'spawned')
  expectApproverRunning('phase1', key)
  const kept1 = await awaitApproverLiveStop('phase1', key)
  const s1 = await expectLive('phase1', instanceId)
  console.log(`DRIVER: PHASE1_OK action=${r1.action} state=${s1} launch_start_ms=${kept1}`)

  // -------------------------------------------------------------------------
  // Precondition — a terminal (`ended`) row that still carries a session_id,
  // so a resume is possible. stub-claude ends cleanly on its sentinel line:
  // agent-director `send-keys` delivers it to the live row (sendKeys appends
  // Enter), stub-claude fires its SessionEnd hook, which ends the row with its
  // session_id kept, and exits.
  // -------------------------------------------------------------------------

  // Capture the session_id while the row is still live — resume needs it and we
  // don't want to depend on it surviving the terminal transition.
  const liveRow = await getClient().get({ claude_instance_id: instanceId })
  const liveSid = (liveRow as { claude_session_id?: string }).claude_session_id ?? ''
  if (!liveSid || liveSid === 'null') {
    driverFail(`precondition: no claude_session_id on the live row (SessionStart hook did not record one) — resume would be impossible`)
  }

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
  // Phase 2 — the resumed launch; the approver clears the dialog again on the
  // resumed `pending` row, and the launch start it keeps is that row's.
  // -------------------------------------------------------------------------
  const r2 = await spawnForPersona(persona, personaCfg, true)
  // The row carries this persona's cwd and config_dir label, so the ladder
  // must resume it; any other outcome means a guard replaced it.
  expectAction('phase2', r2.action, 'resumed')
  expectApproverRunning('phase2', key)

  // Read the resumed row's launch start now: the row shows it only while it
  // is `pending`, which lasts until stub-claude's SessionStart hook, after
  // the approver's first lap has read the pane and pressed Enter.
  const pendingRow = (await getClient().get({ claude_instance_id: instanceId })) as {
    state: string
    launch_started_at?: string | null
  }
  if (pendingRow.state !== PENDING_STATE) {
    driverFail(`phase2 get read the resumed row ${pendingRow.state} right after spawnForPersona returned, not ${PENDING_STATE}`)
  }
  const rowLaunchStartMs: number | undefined = parseLaunchStart(pendingRow.launch_started_at)
  if (rowLaunchStartMs === undefined) {
    driverFail(`phase2 the resumed ${PENDING_STATE} row has no launch start that parses (launch_started_at=${String(pendingRow.launch_started_at)})`)
  }

  const kept2 = await awaitApproverLiveStop('phase2', key)
  if (kept2 !== rowLaunchStartMs) {
    driverFail(`phase2 the dialog approver kept launch start ${kept2} ms, not the resumed row's ${rowLaunchStartMs} ms (launch_started_at=${String(pendingRow.launch_started_at)})`)
  }
  const s2 = await expectLive('phase2', instanceId)
  console.log(`DRIVER: PHASE2_OK action=${r2.action} state=${s2} launch_start_ms=${kept2}`)

  // Best-effort cleanup: end the session so the pane does not linger. The row
  // is kept, ended.
  try { await getClient().kill({ claude_instance_id: instanceId }) } catch { /* ignore */ }
  console.log('DRIVER: DONE')
  process.exit(0)
}

main().catch((err) => {
  driverFail(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
})
