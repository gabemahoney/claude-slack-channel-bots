/** Real AD fresh/resume lifecycle and an unanswered startup hold. No native UI reads. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
const PKG = process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'
const { runAgentDirectorStartupGate } = await import(`${PKG}/src/agent-director-startup.ts`)
const { initOutageState } = await import(`${PKG}/src/outage-state.ts`)
const { installSlackChannelBotTemplate } = await import(`${PKG}/src/agent-director-template.ts`)
const { spawnForPersona, setSystemPromptPreparer } = await import(`${PKG}/src/session-manager.ts`)
const { personaInstanceId, personaKey } = await import(`${PKG}/src/persona-identity.ts`)
const { resolvePersonaConfig, resolveServerStateDir } = await import(`${PKG}/src/config.ts`)
const { prepareBotSystemPrompt } = await import(`${PKG}/src/bot-system-prompt.ts`)
const { getClient } = await import(`${PKG}/src/agent-director-client.ts`)
const PERSONA_NAME = process.env.DRIVER_PERSONA ?? 'resume_test'
const PERSONA_CHANNEL = process.env.DRIVER_PERSONA_CHANNEL ?? 'C0RESUME1'
const WORKING_DIRECTORY = process.env.DRIVER_WORKING_DIRECTORY ?? '/tmp/test-repo-resume'
const UNUSED_CREDENTIALS_FILE = '/tmp/test-4-unused-credentials.json'
function driverFail(reason: string): never { console.log(`DRIVER_FAIL: ${reason}`); process.exit(1) }
function expectAction(phase: string, action: string, expected: string) {
  if (action !== expected) driverFail(`${phase} unexpected launch action`)
}
async function waitState(instance: string, allowed: string[]) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const row = await getClient().get({ instance_id: instance })
    if (allowed.includes(row.state)) return row
    await Bun.sleep(250)
  }
  driverFail('AD row never reached the expected state')
}
async function main() {
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

  // Exercise the same template and prompt preparation as the daemon.
  setSystemPromptPreparer(() => prepareBotSystemPrompt(personaCfg, resolveServerStateDir()))
  await installSlackChannelBotTemplate(personaCfg)


  const instanceId = personaInstanceId(key)
  const fresh = await spawnForPersona(persona, personaCfg, true)
  expectAction('phase1', fresh.action, 'spawned')
  const first = await waitState(instanceId, ['waiting'])
  if (!first.session_id) driverFail('fresh launch has no AD session identity')
  console.log('DRIVER: PHASE1_OK')
  await getClient().sendKeys({ instance_id: instanceId, text: '__CSCB_TEST_EXIT__' })
  const ended = await waitState(instanceId, ['ended', 'missing'])
  if (!ended.session_id) driverFail('terminal row has no AD session identity')
  console.log('DRIVER: PRECONDITION_OK')
  const resumed = await spawnForPersona(persona, personaCfg, true)
  expectAction('phase2', resumed.action, 'resumed')
  await waitState(instanceId, ['waiting'])
  console.log('DRIVER: PHASE2_OK')
  await getClient().sendKeys({ instance_id: instanceId, text: '__CSCB_TEST_EXIT__' })
  await waitState(instanceId, ['ended', 'missing'])
  const modeFile = process.env.DRIVER_STUB_MODES_FILE
  if (!modeFile) driverFail('missing private stub mode file')
  writeFileSync(modeFile, `unrecognised-dialog\t${WORKING_DIRECTORY}\n`)
  const trailPath = join(homedir(), '.config', 'agent-director', 'ad-trail.jsonl')
  const before = readFileSync(trailPath, 'utf8').split('\n').length
  const held = await spawnForPersona(persona, personaCfg, false)
  expectAction('phase3', held.action, 'resumed')
  await waitState(instanceId, ['pending'])
  // No startup handler should type or read UI, including after its former first poll.
  await Bun.sleep(2000)
  const row = await getClient().get({ instance_id: instanceId })
  if (row.state !== 'pending') driverFail('unanswered startup hold unexpectedly reported in')
  const calls = readFileSync(trailPath, 'utf8').split('\n').slice(before - 1).filter(Boolean).map(line => JSON.parse(line))
  if (calls.some(r => r.instance_id === instanceId && ['ad.send_keys.called', 'ad.read_pane.called'].includes(r.event)))
    driverFail('startup hold caused native pane access or automatic keys')
  console.log('DRIVER: STARTUP_HOLD_UNANSWERED_OK')
  await getClient().kill({ instance_id: instanceId })
  console.log('DRIVER: DONE')
  process.exit(0)
}
main().catch(() => driverFail('AD lifecycle driver failed'))
