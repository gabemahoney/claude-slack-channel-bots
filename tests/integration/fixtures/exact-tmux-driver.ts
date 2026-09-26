/**
 * exact-tmux-driver.ts — driver for test-11-exact-tmux-targets (b.1ix).
 *
 * Runs ONE of the installed package's raw-tmux persona paths for persona
 * `dev` (session `slack_bot_dev`) against the container's real tmux, so the
 * scenario can check which sessions it touched. The scenario arranges the
 * sessions (`slack_bot_dev_2`, the prefix neighbour, with or without
 * `slack_bot_dev`) on a private tmux server (its own TMUX_TMPDIR) before each
 * run, and checks them after.
 *
 * agent-director is a stand-in client installed through the package's own
 * `setClientForTests` seam: each path's raw tmux call only happens after a
 * particular agent-director answer (a spawn refused with
 * ErrTmuxSessionCreate, a row read `ended`), which the real binary gives only
 * in races. The stand-in gives it every time; every tmux call is real and
 * comes from the shipped code. A verb the path is not expected to call
 * rejects, so a drift in the path fails the run.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR               installed package dir
 *   DRIVER_ACTION              `probe`     hasPersonaTmuxSession('dev')
 *                              `approver`  approvePreSessionDialogs('dev') for a row that reads `ended`
 *                                          (the raw capture-pane and Enter)
 *                              `self-heal` spawnForPersona(dev) whose first spawn is refused with
 *                                          ErrTmuxSessionCreate (the b.vub kill-session, then a retry)
 *   DRIVER_WORKING_DIRECTORY   persona dev's working directory (exists)
 *
 * OUTPUT CONTRACT (consumed by test-11-exact-tmux-targets.sh)
 * -----------------------------------------------------------
 *   `DRIVER: probe alive=<true|false>`, `DRIVER: approver done` or
 *   `DRIVER: self-heal action=<action>`, then exit 0. On any failure,
 *   `DRIVER_FAIL: <reason>` and exit 1. CSCB's own lines go to stderr.
 */

const PKG = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'
const ACTION = process.env['DRIVER_ACTION'] ?? ''
const WORKING_DIRECTORY = process.env['DRIVER_WORKING_DIRECTORY'] ?? ''
const PERSONA_NAME = 'dev'
/** Never read: the driver opens no Slack connection. */
const UNUSED_CREDENTIALS_FILE = '/tmp/test-11-unused-credentials.json'

const sm = await import(`${PKG}/src/session-manager.ts`)
const { initOutageState } = await import(`${PKG}/src/outage-state.ts`)
const { getClient, setClientForTests } = await import(`${PKG}/src/agent-director-client.ts`)
const { resolvePersonaConfig } = await import(`${PKG}/src/config.ts`)
// The package's own agent-director module (resolved from its src/, as the
// session manager's import is), so the session manager's `instanceof`
// recognises the error the stand-in throws.
const { ErrTmuxSessionCreate } = await import(Bun.resolveSync('agent-director', `${PKG}/src`))

function driverFail(reason: string): never {
  console.log(`DRIVER_FAIL: ${reason}`)
  process.exit(1)
}

/** A stand-in agent-director client: `verbs`, and a rejection for any other verb. */
function standInClient(verbs: Record<string, (params: unknown) => Promise<unknown>>): unknown {
  return new Proxy(verbs, {
    get: (target, verb) => {
      if (typeof verb !== 'string' || verb === 'then') return undefined
      return target[verb] ?? (async () => { throw new Error(`stand-in agent-director: unexpected verb ${verb}`) })
    },
  })
}

async function main(): Promise<void> {
  if (!WORKING_DIRECTORY) driverFail('DRIVER_WORKING_DIRECTORY is not set')
  initOutageState({
    getClient,
    notify: (key: string, text: string) => { console.error(`[driver] outage-notice persona=${key}: ${text}`) },
  })

  if (ACTION === 'probe') {
    console.log(`DRIVER: probe alive=${await sm.hasPersonaTmuxSession(PERSONA_NAME)}`)
    return
  }

  if (ACTION === 'approver') {
    // The row reads `ended` on every poll, so each poll reads the pane with
    // raw tmux and presses Enter only while it shows the dialog. After three
    // polls with no dialog on screen the approver gives up.
    setClientForTests(standInClient({ status: async () => ({ state: 'ended' }) }))
    sm._setDialogPollIntervalMs(100)
    sm._setDialogDeadGracePolls(3)
    sm._setDialogReadyTimeoutMs(20_000)
    await sm.approvePreSessionDialogs(PERSONA_NAME, false)
    console.log('DRIVER: approver done')
    return
  }

  if (ACTION === 'self-heal') {
    const config = resolvePersonaConfig(
      {
        personas: [
          {
            name: PERSONA_NAME,
            credentials_file: UNUSED_CREDENTIALS_FILE,
            working_directory: WORKING_DIRECTORY,
            channels: [{ id: 'C0EXACT11', delivery: 'all' }],
            permission_prompts: 'C0EXACT11',
          },
        ],
        bind: '127.0.0.1',
        port: 3100,
      },
      WORKING_DIRECTORY,
    )
    const persona = config.personas[0]
    if (config.personas.length !== 1 || persona.key !== PERSONA_NAME) driverFail(`config: expected one persona keyed ${PERSONA_NAME}`)
    let spawns = 0
    setClientForTests(standInClient({
      spawn: async () => {
        spawns++
        if (spawns === 1) throw new ErrTmuxSessionCreate('spawn', 'ErrTmuxSessionCreate', 'tmux: new-session failed: duplicate session')
        return { claude_instance_id: `cscb_${PERSONA_NAME}` }
      },
      // The approver after the retry: the row is live, so it returns at once.
      status: async () => ({ state: 'waiting' }),
    }))
    const result = await sm.spawnForPersona(persona, config, false)
    if (spawns !== 2) driverFail(`self-heal: expected the refused spawn and one retry, got ${spawns} spawn(s)`)
    console.log(`DRIVER: self-heal action=${result.action}`)
    return
  }

  driverFail(`unknown DRIVER_ACTION "${ACTION}"`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => driverFail(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
