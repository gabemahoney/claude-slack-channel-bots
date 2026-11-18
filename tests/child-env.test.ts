/** CSCB removes Slack credentials, inherited AD caller identity and its marker. */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { CLIENT_MIN_VERSION } from './test-helpers/agent-director-versions.ts'

const SECRET_NAMES = [
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_SIGNING_SECRET',
  'SLACK_FOO_TOKEN', 'SLACK_X_SECRET', 'slack_bot_token', 'sLaCk_FoO_sEcReT',
]
const PUBLIC_ENV = {
  SLACK_STATE_DIR: '/scratch/state', SLACK_DRY_RUN: '1', GH_TOKEN: 'fake-not-a-token',
  AWS_SECRET_ACCESS_KEY: 'fake-not-a-token', ANTHROPIC_API_KEY: 'fake-not-a-token',
  PATH: '/scratch/bin', HOME: '/scratch/home',
  SLACK_TOKEN_SUFFIX: 'ordinary', SLACK_SECRET_SUFFIX: 'ordinary',
  NOT_SLACK_BOT_TOKEN: 'ordinary', SLACK_CHANNEL: 'ordinary',
}
// Lazy load so controls and source regressions still execute before the new module exists.
const loadModule = () => import('../src/child-env.ts')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('b.c13 child environment policy', () => {
  test.each([undefined, false, true])('b.z5q childEnv drops the inherited caller ID (daemonChild=%s)', async daemonChild => {
    const { childEnv } = await loadModule()
    const source = { ...PUBLIC_ENV, AGENT_DIRECTOR_INSTANCE_ID: 'cscb_starter' }
    const before = { ...source }
    const result = childEnv(source, { daemonChild })
    expect(result).not.toHaveProperty('AGENT_DIRECTOR_INSTANCE_ID')
    expect(result).toEqual({ ...PUBLIC_ENV, ...(daemonChild ? { _CLI_DAEMON_CHILD: '1' } : {}) })
    expect(source).toEqual(before)
  })

  test.each([undefined, false, true])('b.z5q scrubProcessEnv drops the inherited caller ID (keepDaemonMarker=%s)', async keepDaemonMarker => {
    const { scrubProcessEnv } = await loadModule()
    const env: NodeJS.ProcessEnv = { ...PUBLIC_ENV, AGENT_DIRECTOR_INSTANCE_ID: 'cscb_starter', _CLI_DAEMON_CHILD: '1' }
    scrubProcessEnv(env, { keepDaemonMarker })
    expect(env).not.toHaveProperty('AGENT_DIRECTOR_INSTANCE_ID')
    expect(env).toEqual({ ...PUBLIC_ENV, ...(keepDaemonMarker ? { _CLI_DAEMON_CHILD: '1' } : {}) })
  })

  test.each(SECRET_NAMES)('%s is recognized case-insensitively and removed from a child', async name => {
    const { childEnv, isCscbSecretName } = await loadModule()
    expect(isCscbSecretName(name)).toBe(true)
    const source = { ...PUBLIC_ENV, [name]: 'fake-not-a-token' }
    const before = { ...source }
    const result = childEnv(source)
    expect(Object.keys(result)).not.toContain(name)
    expect(result).toEqual(PUBLIC_ENV)
    expect(source).toEqual(before)
    expect(result).not.toBe(source)
  })

  test.each(Object.keys(PUBLIC_ENV))('%s passes through and is not a CSCB secret', async name => {
    const { childEnv, isCscbSecretName } = await loadModule()
    expect(isCscbSecretName(name)).toBe(false)
    expect(childEnv(PUBLIC_ENV)).toEqual(PUBLIC_ENV)
  })

  test.each([undefined, false, true])('only daemonChild=true sets the marker (%s)', async daemonChild => {
    const { childEnv } = await loadModule()
    for (const marker of [undefined, '', 'leaked-marker']) {
      const source = { ...PUBLIC_ENV, _CLI_DAEMON_CHILD: marker, SLACK_APP_TOKEN: 'fake-not-a-token' }
      const before = { ...source }
      const result = childEnv(source, { daemonChild })
      expect(result).toEqual({ ...PUBLIC_ENV, ...(daemonChild ? { _CLI_DAEMON_CHILD: '1' } : {}) })
      expect(source).toEqual(before)
      expect(result).not.toBe(source)
    }
  })

  test('scrubProcessEnv deletes in place, including the marker by default', async () => {
    const { scrubProcessEnv } = await loadModule()
    const env: NodeJS.ProcessEnv = { ...PUBLIC_ENV, _CLI_DAEMON_CHILD: '1',
      ...Object.fromEntries(SECRET_NAMES.map(name => [name, 'fake-not-a-token'])) }
    const alias = env
    scrubProcessEnv(env)
    expect(alias).toBe(env)
    expect(alias).toEqual(PUBLIC_ENV)
    scrubProcessEnv(env)
    expect(env).toEqual(PUBLIC_ENV)
  })

  test('CLI entry can explicitly preserve its marker until start checks it', async () => {
    const { scrubProcessEnv } = await loadModule()
    const env: NodeJS.ProcessEnv = { ...PUBLIC_ENV, _CLI_DAEMON_CHILD: '1', SLACK_BOT_TOKEN: 'fake-not-a-token' }
    scrubProcessEnv(env, { keepDaemonMarker: true })
    expect(env).toEqual({ ...PUBLIC_ENV, _CLI_DAEMON_CHILD: '1' })
    scrubProcessEnv(env)
    expect(env).toEqual(PUBLIC_ENV)
  })

  test('default scrub targets process.env without replacing it', async () => {
    const { scrubProcessEnv } = await loadModule()
    const saved = { ...process.env }
    const names = [...SECRET_NAMES, '_CLI_DAEMON_CHILD', 'SLACK_CUSTOM_TOKEN']
    const original = process.env
    try {
      for (const name of names) process.env[name] = 'fake-not-a-token'
      scrubProcessEnv()
      expect(process.env).toBe(original)
      expect(Object.keys(process.env).filter(name => names.includes(name))).toEqual([])
    } finally {
      // The scrub removes arbitrary matching names, including inherited names
      // this case did not seed. Restore the entire original object in place.
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, saved)
    }
  })
})

// Explicit b.c13 assignment: exercise the real npm client's subprocess boundary
// with an inert executable, never the installed agent-director or a tmux binary.
// The outer child has no PATH tools; it creates its own executable and sets a
// PATH containing only that scratch bin. The fake records names, never values.
describe('b.c13 bundled library environment boundary', () => {
  function runLibrary(scrub: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'cscb-env-library-'))
    roots.push(root)
    const home = join(root, 'home'), bin = join(root, 'bin'), names = join(root, 'names.json')
    mkdirSync(home); mkdirSync(bin)
    const script = join(root, 'probe.ts')
    const fake = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
if (process.argv[2] === 'version') console.log(JSON.stringify({version:${JSON.stringify(CLIENT_MIN_VERSION)}}));
else if (process.argv[2] === 'list') {
  writeFileSync(${JSON.stringify(names)}, JSON.stringify(Object.keys(process.env).sort()));
  console.log(JSON.stringify({spawns:[]}));
} else process.exit(72);
`
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(bin, 'agent-director'))}, ${JSON.stringify(fake)}, {mode:0o700});
process.env.PATH = ${JSON.stringify(bin)};
const { Client } = await import(${JSON.stringify(resolve(import.meta.dir, '../node_modules/agent-director/dist/index.js'))});
const client = await Client.create();
// Set these AFTER discovery: the probe already filters its own env, while verb
// calls read process.env afresh. A probe-only test would miss this defect.
process.env.SLACK_BOT_TOKEN = 'fake-not-a-token';
process.env.GH_TOKEN = 'fake-not-a-token';
process.env._CLI_DAEMON_CHILD = '1';
${scrub ? `const { scrubProcessEnv } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/child-env.ts'))}); scrubProcessEnv();` : ''}
try { const result = await client.list({}); if (!Array.isArray(result.spawns)) process.exit(73); }
finally { client.close(); }
`)
    const result = spawnSync(process.execPath, [script], {
      cwd: root, timeout: 5_000, encoding: 'utf8',
      env: hostSafeChildEnv(home, { tools: [], extras: { SLACK_STATE_DIR: join(root, 'state') } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    return JSON.parse(readFileSync(names, 'utf8')) as string[]
  }

  test('control: an ordinary verb inherits unsanitized names after Client.create', () => {
    expect(runLibrary(false)).toEqual(expect.arrayContaining(['SLACK_BOT_TOKEN', 'GH_TOKEN', '_CLI_DAEMON_CHILD']))
  })

  test('scrubbing process.env cleans a real library verb and preserves host GH_TOKEN', () => {
    const names = runLibrary(true)
    expect(names).not.toContain('SLACK_BOT_TOKEN')
    expect(names).not.toContain('_CLI_DAEMON_CHILD')
    expect(names).toContain('GH_TOKEN')
  })
})
