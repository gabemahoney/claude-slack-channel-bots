/** Private inspection boundary: only a scratch fake docker can execute. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { safeDockerInspect } from '../scripts/safe-docker-inspect.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const inspectScript = resolve(import.meta.dir, '../scripts/safe-docker-inspect.ts')
const id = 'a'.repeat(64)
const otherId = `sha256:${'b'.repeat(64)}`
const secrets = {
  ANTHROPIC_API_KEY: fakeToken('', 'key'),
  ANTHROPIC_AUTH_TOKEN: fakeToken('', 'auth'),
  ANTHROPIC_BASE_URL: `https://${fakeToken('', 'gateway')}.invalid/path`,
  ANTHROPIC_MODEL: fakeToken('', 'model'),
  ANTHROPIC_FUTURE_SETTING: `${fakeToken('', 'future')}\n"quoted"\\tail`,
  CI_ANTHROPIC_API_KEY: fakeToken('', 'ci-key'),
  CI_ANTHROPIC_MODEL: fakeToken('', 'ci-model'),
  anthropic_lowercase: fakeToken('', 'lowercase'),
}
const nestedSecret = fakeToken('', 'nested-env')
const namedSecret = fakeToken('', 'named-field')
const genericSecret = fakeToken('', 'password')
const allSecrets = [...Object.values(secrets), nestedSecret, namedSecret, genericSecret]
const inspected = () => [{
  Id: id, Name: '/safe-container', State: { Status: 'running', ExitCode: 0 },
  Config: { Env: [...Object.entries(secrets).map(([k, v]) => `${k}=${v}`), 'SAFE_FLAG=1'],
    Labels: { ordinary: 'keep-me', copied: Object.values(secrets).join(' '),
      embeddedJson: JSON.stringify({ copied: secrets.ANTHROPIC_FUTURE_SETTING }),
      [`label-${nestedSecret}`]: namedSecret } },
  Nested: [{ eNv: [`ANTHROPIC_OTHER=${nestedSecret}`, `SERVICE_PASSWORD=${genericSecret}`],
    ANTHROPIC_AUTH_TOKEN: namedSecret, note: `${nestedSecret} ${genericSecret}` }],
}]

describe('safe Docker inspection CLI with fake executable', () => {
  let root: string, bin: string, fixture: string, argvFile: string
  let answer: { stdout: string; stderr: string; code: number; invalidUtf8?: boolean }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'safe-inspect-test-'))
    bin = join(root, 'bin'); mkdirSync(bin)
    fixture = join(root, 'answer.json'); argvFile = join(root, 'argv.json')
    // Absolute Bun shebang and a PATH holding only this directory: no daemon or host tool.
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const answer = await Bun.file(process.env.INSPECT_TEST_FIXTURE).json()
await Bun.write(process.env.INSPECT_TEST_ARGV, JSON.stringify(process.argv.slice(2)))
process.stdout.write(answer.stdout)
if (answer.invalidUtf8) process.stdout.write(Buffer.from([0xff]))
process.stderr.write(answer.stderr)
process.exitCode = answer.code
`, { mode: 0o700 })
    answer = { stdout: JSON.stringify(inspected()), stderr: allSecrets.join('\n'), code: 0 }
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function run(argv: readonly string[], options?: { maxOutputBytes: number }) {
    writeFileSync(fixture, JSON.stringify(answer))
    const script = options === undefined ? [inspectScript, ...argv] : ['--eval', `
      import { safeDockerInspect } from ${JSON.stringify(inspectScript)}
      const result = await safeDockerInspect(${JSON.stringify(argv)}, ${JSON.stringify(options)})
      if (result.code === 0) process.stdout.write(result.text)
      process.exitCode = result.code
    `]
    const child = Bun.spawnSync([process.execPath, ...script], {
      cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
      env: hostSafeChildEnv(root, { tools: [], pathDirs: [bin], extras: {
        ...secrets, INSPECT_TEST_FIXTURE: fixture, INSPECT_TEST_ARGV: argvFile,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      } }),
    })
    const captured = { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
    // Both pipes, including diagnostics and parse failures, are checked before any output assertion.
    assertNoLeak(captured)
    for (const secret of allSecrets) {
      const text = captured.stdout + captured.stderr
      expect(text.includes(secret)).toBe(false)
      expect(text.includes(JSON.stringify(secret).slice(1, -1))).toBe(false)
    }
    expect(child.signalCode ?? null).toBeNull()
    return captured
  }

  test.each([
    ['inspect', ['inspect']], ['container inspect', ['container', 'inspect']], ['image inspect', ['image', 'inspect']],
  ] as const)(
    '%s removes every Env and masks copies in values, keys and embedded JSON while retaining metadata', (_name, command) => {
      const captured = run(['docker', ...command, 'test-object'])
      expect(captured.code).toBe(0)
      expect(captured.stderr).toBe('')
      const objects = JSON.parse(captured.stdout)
      expect(objects).toEqual([{
        Id: id, Name: '/safe-container', State: { Status: 'running', ExitCode: 0 },
        Config: { Labels: { ordinary: 'keep-me', copied: Object.keys(secrets).map(() => '[REDACTED]').join(' '),
          embeddedJson: JSON.stringify({ copied: '[REDACTED]' }), 'label-[REDACTED]': '[REDACTED]' } },
        Nested: [{ note: '[REDACTED] [REDACTED]' }],
      }])
      expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([...command, 'test-object'])
    },
  )

  test.each([
    ['--format', '{{.Id}}', false], ['-f', '{{json .Id}}', true],
    ['--format={{json .Id}}', undefined, true], ['-f={{.Id}}', undefined, false],
  ] as const)('projects safe IDs locally with %s and never passes a child template', (flag, value, quoted) => {
    answer.stdout = JSON.stringify([...inspected(), { Id: otherId, Config: { Env: null } }])
    const captured = run(['docker', 'image', 'inspect', 'first', 'second', flag, ...(value ? [value] : [])])
    expect(captured).toEqual({ code: 0, stdout: [id, otherId].map(v => quoted ? JSON.stringify(v) : v).join('\n') + '\n', stderr: '' })
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['image', 'inspect', 'first', 'second'])
  })

  test('retains supported size and type options while dropping null and empty Env fields', () => {
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: null }, HostConfig: { Env: [] }, SizeRw: 42 }])
    const captured = run(['docker', 'inspect', '--type=container', '--size', 'safe-name'])
    expect(captured.code).toBe(0)
    expect(JSON.parse(captured.stdout)).toEqual([{ Id: id, Config: {}, HostConfig: {}, SizeRw: 42 }])
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['inspect', '--type', 'container', '--size', 'safe-name'])
  })

  test.each(['unset', 'empty'] as const)('%s Config.Env entry retains the strict inspection boundary', kind => {
    answer.stdout = JSON.stringify([{ Id: id, Config: {
      Env: [kind === 'unset' ? 'CSCB_INSPECT_PROBE' : 'CSCB_INSPECT_PROBE='],
    } }])
    answer.stderr = ''
    const captured = run(['docker', 'container', 'inspect', 'safe-name'])
    expect(captured).toEqual(kind === 'unset'
      ? { code: 65, stdout: '', stderr: '' }
      : { code: 0, stdout: JSON.stringify([{ Id: id, Config: {} }], null, 2) + '\n', stderr: '' })
  })

  test('masks inherited ANTHROPIC values even when Docker copies them only outside Env', () => {
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [] },
      Labels: Object.fromEntries(Object.values(secrets).map((value, i) => [`copy-${i}-${value}`, JSON.stringify({ value })])),
    }])
    const captured = run(['docker', 'inspect', 'safe-name'])
    expect(captured.code).toBe(0)
    expect(JSON.parse(captured.stdout)[0].Labels).toEqual(Object.fromEntries(Object.values(secrets)
      .map((_value, i) => [`copy-${i}-[REDACTED]`, JSON.stringify({ value: '[REDACTED]' })])))
  })

  test.each<[string, () => string]>([
    ['empty stdout', () => ''], ['not JSON', () => allSecrets.join(' ')],
    ['partial JSON', () => JSON.stringify(inspected()).slice(0, -1)],
    ['trailing bytes', () => JSON.stringify(inspected()) + nestedSecret],
    ['non-array root', () => JSON.stringify(inspected()[0])], ['empty array', () => '[]'],
    ['missing Id', () => JSON.stringify([{ Config: { Env: [] }, note: nestedSecret }])],
    ['invalid Id', () => JSON.stringify([{ ...inspected()[0], Id: nestedSecret }])],
    ['missing Config', () => JSON.stringify([{ Id: id, note: nestedSecret }])],
    ['missing Env', () => JSON.stringify([{ Id: id, Config: { note: nestedSecret } }])],
    ['object Env', () => JSON.stringify([{ Id: id, Config: { Env: { ANTHROPIC_API_KEY: nestedSecret } } }])],
    ['non-string Env entry', () => JSON.stringify([{ Id: id, Config: { Env: [123] } }])],
    ['malformed Env entry', () => JSON.stringify([{ Id: id, Config: { Env: [nestedSecret] } }])],
    ['invalid nested Env', () => JSON.stringify([{ ...inspected()[0], nested: { Env: nestedSecret } }])],
    ['non-string named secret', () => JSON.stringify([{ ...inspected()[0], ANTHROPIC_OTHER: { value: nestedSecret } }])],
    ['partially valid array', () => JSON.stringify([...inspected(), { Id: otherId }])],
    ['redacted key collision', () => JSON.stringify([{ ...inspected()[0], [nestedSecret]: 1, [namedSecret]: 2 }])],
  ])('rejects %s with no stdout or stderr, including no partial safe prefix', (_name, body) => {
    answer.stdout = body()
    expect(run(['docker', 'inspect', 'safe-name'])).toEqual({ code: 65, stdout: '', stderr: '' })
  })

  test('discards valid-looking stdout and secret-bearing stderr on a child failure', () => {
    answer.code = 17
    expect(run(['docker', 'container', 'inspect', 'safe-name'])).toEqual({ code: 1, stdout: '', stderr: '' })
  })

  test('retains the actual failed command exit and sanitized stderr privately, including secrets known only from Env', async () => {
    answer.code = 17
    answer.stderr = 'forced-inspect-failure: ' + allSecrets.map(value => `${value}|${JSON.stringify(value).slice(1, -1)}`).join(' ')
    writeFileSync(fixture, JSON.stringify(answer))
    const result = await safeDockerInspect(['docker', 'container', 'inspect', 'safe-name'], {
      cwd: root, env: hostSafeChildEnv(root, { tools: [], pathDirs: [bin], extras: {
        INSPECT_TEST_FIXTURE: fixture, INSPECT_TEST_ARGV: argvFile,
      } }),
    })
    assertNoLeak(result)
    for (const value of allSecrets) {
      expect(result.stderr.includes(value)).toBe(false)
      expect(result.stderr.includes(JSON.stringify(value).slice(1, -1))).toBe(false)
    }
    expect(result).toEqual({ code: 1, text: '', actualExitCode: 17,
      stderr: 'forced-inspect-failure: ' + allSecrets.map(() => '[REDACTED]|[REDACTED]').join(' '),
      timedOut: false, outputTruncated: false })
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['container', 'inspect', 'safe-name'])
    expect(run(['docker', 'container', 'inspect', 'safe-name'])).toEqual({ code: 1, stdout: '', stderr: '' })
  })

  test('withholds a truncated diagnostic ending inside a credential instead of exposing its prefix', async () => {
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [`CUSTOM_TOKEN=${genericSecret}`] } }])
    answer.stderr = 'forced-bound-failure: ' + genericSecret
    answer.code = 17
    writeFileSync(fixture, JSON.stringify(answer))
    const result = await safeDockerInspect(['docker', 'inspect', 'safe-name'], {
      cwd: root, maxOutputBytes: Buffer.byteLength(answer.stdout) + Buffer.byteLength('forced-bound-failure: ') + 12,
      env: hostSafeChildEnv(root, { tools: [], pathDirs: [bin], extras: {
        INSPECT_TEST_FIXTURE: fixture, INSPECT_TEST_ARGV: argvFile,
      } }),
    })
    // Check a boolean before any diff/assertNoLeak can print the leaked prefix.
    expect(result.stderr.includes(genericSecret.slice(0, 12))).toBe(false)
    assertNoLeak(result)
    expect(result.code).toBe(75)
    expect(result.text).toBe('')
    expect(result.outputTruncated).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.stderr.startsWith('Docker stderr withheld:')).toBe(true)
  })

  test('withholds stderr when partial inspection leaves an unknown Env secret and bounds escaped descendant pipes', async () => {
    const pidFile = join(root, 'escaped-pid.json')
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
process.stdout.write(${JSON.stringify(JSON.stringify(inspected()).slice(0, -1))})
process.stderr.write(${JSON.stringify('partial-inspect-failure ' + nestedSecret)})
const child = Bun.spawn([process.execPath, '--eval', 'setInterval(() => {}, 1000)'], {
  env: {}, detached: true, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
})
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(child.pid))
await child.exited
`, { mode: 0o700 })
    const started = performance.now()
    try {
      const result = await safeDockerInspect(['docker', 'inspect', 'safe-name'], {
        cwd: root, timeoutMs: 250,
        env: hostSafeChildEnv(root, { tools: [], pathDirs: [bin] }),
      })
      assertNoLeak(result)
      expect(result.stderr.includes(nestedSecret)).toBe(false)
      expect(result.stderr.includes(JSON.stringify(nestedSecret).slice(1, -1))).toBe(false)
      expect(result).toEqual({ code: 124, text: '', actualExitCode: null,
        stderr: 'Docker stderr withheld: incomplete inspection cannot certify credential redaction',
        timedOut: true, outputTruncated: false })
      expect(performance.now() - started).toBeLessThan(1_500)
      expect(existsSync(pidFile)).toBe(true)
    } finally {
      if (existsSync(pidFile)) { try { process.kill(JSON.parse(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch {} }
    }
  })

  test('rejects invalid UTF-8 after otherwise valid JSON without partial output', () => {
    answer.invalidUtf8 = true
    expect(run(['docker', 'inspect', 'safe-name'])).toEqual({ code: 65, stdout: '', stderr: '' })
  })

  test.each([
    ['--format', '{{json .Config.Env}}'], ['-f', '{{.Config.Env}}'], ['--format={{json .}}'],
    ['--format', '{{.Id}}', '-f', '{{.Id}}'], ['--format'], ['--unknown'],
    ['--type', 'network'], ['--', 'safe-name'], ['-unsafe-name'],
  ].map(args => ({ args })))('refuses unsafe options %j without starting even the fake docker', ({ args }) => {
    expect(run(['docker', 'inspect', 'safe-name', ...args])).toEqual({ code: 64, stdout: '', stderr: '' })
    expect(existsSync(argvFile)).toBe(false)
  })

  test.each([
    ['global option', ['docker', '--context', 'elsewhere', 'inspect', 'safe-name']],
    ['unsupported object', ['docker', 'network', 'inspect', 'safe-name']],
    ['missing reference', ['docker', 'inspect']], ['non-inspect', ['docker', 'ps']],
  ] as const)('refuses %s without executing a child', (_name, argv) => {
    expect(run(argv)).toEqual({ code: 64, stdout: '', stderr: '' })
    expect(existsSync(argvFile)).toBe(false)
  })

  test.each(['stdout', 'stderr', 'combined', 'sanitized expansion'] as const)('bounds %s bytes without exposing captured data', kind => {
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [] }, note: nestedSecret }])
    answer.stderr = ''
    let maxOutputBytes = 1_024
    if (kind === 'stdout') answer.stdout += ' '.repeat(2_000)
    if (kind === 'stderr') answer.stderr = nestedSecret.repeat(100)
    if (kind === 'combined') { maxOutputBytes = Buffer.byteLength(answer.stdout) + 10; answer.stderr = nestedSecret }
    if (kind === 'sanitized expansion') {
      answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [] }, Labels: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`safe-${i}`, 'x'])) }])
      maxOutputBytes = Buffer.byteLength(answer.stdout)
    }
    expect(run(['docker', 'inspect', 'safe-name'], { maxOutputBytes })).toEqual({ code: 75, stdout: '', stderr: '' })
  })

  test('bounds replacement growth from eight one-character routing values without cascading markers', () => {
    const values = [...'REDACT0x']
    answer.stdout = JSON.stringify([{ Id: id, Config: {
      Env: values.map((value, i) => `ANTHROPIC_SETTING_${i}=${value}`),
      Labels: { copied: values.join('').repeat(1_024) },
    } }])
    answer.stderr = ''
    expect(Buffer.byteLength(answer.stdout)).toBeLessThan(32 * 1_024)
    expect(run(['docker', 'inspect', 'safe-name'], { maxOutputBytes: 32 * 1_024 }))
      .toEqual({ code: 75, stdout: '', stderr: '' })
  })

  test('masks the longest original overlap in keys, values and embedded JSON without leaving a suffix', () => {
    const short = fakeToken('', 'overlap'), long = `${short}-tail`
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [
      `ANTHROPIC_FIRST=${short}`, `ANTHROPIC_SECOND=${long}`,
    ] }, Labels: { [`copy-${long}`]: `${short}|${long}`, embedded: JSON.stringify({ copied: long }) } }])
    const captured = run(['docker', 'inspect', 'safe-name'])
    expect(captured.code).toBe(0)
    expect(JSON.parse(captured.stdout)).toEqual([{ Id: id, Config: {}, Labels: {
      'copy-[REDACTED]': '[REDACTED]|[REDACTED]', embedded: JSON.stringify({ copied: '[REDACTED]' }),
    } }])
  })

  test.each([
    ['replacement marker', 'REDACTED', 'REDACTED'],
    ['JSON syntax', '"', 'copied quote: "'],
    ['pretty-print newline', '\n', 'ordinary'],
    ['escape introduced by JSON serialization', '\\n', '\n'],
  ])('refuses a final result still containing a short value in %s', (_name, value, note) => {
    answer.stdout = JSON.stringify([{ Id: id, Config: { Env: [`ANTHROPIC_SETTING=${value}`] }, note }])
    answer.stderr = ''
    expect(run(['docker', 'inspect', 'safe-name'])).toEqual({ code: 65, stdout: '', stderr: '' })
  })

  test('preserves a Unicode pair across a serialization chunk boundary in both keys and values', () => {
    const text = 'u'.repeat(1_023) + '🦋' + 'z'.repeat(1_024)
    const expected = [{ Id: id, Config: {}, Labels: { [text]: text } }]
    answer.stdout = JSON.stringify([{ ...expected[0], Config: { Env: [] } }])
    const captured = run(['docker', 'inspect', 'safe-name'])
    expect(captured).toEqual({ code: 0, stdout: JSON.stringify(expected, null, 2) + '\n', stderr: '' })
  })

  test.each(['SIGINT', 'SIGTERM'] as const)('%s to the actual CLI emits nothing and stops its fake Docker descendants', async signal => {
    const socketPath = join(root, 'ready.sock')
    const pidFile = join(root, 'signal-pids.json')
    const sockets = new Set<Socket>()
    const deadline = performance.now() + 2_000
    async function bounded<T>(pending: Promise<T>, phase: string, until = deadline): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Signal harness deadline: ${phase}`)), Math.max(0, until - performance.now()))
        })])
      } finally { clearTimeout(timer) }
    }
    let pids: number[] = []
    let ready!: (pids: number[]) => void, closed!: () => void
    const readiness = new Promise<number[]>(resolve => { ready = resolve })
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const server = createServer(socket => {
      sockets.add(socket)
      let data = ''
      socket.on('data', chunk => {
        data += chunk.toString()
        if (data.endsWith('\n')) { pids = JSON.parse(data); ready(pids) }
      })
      socket.on('close', () => { sockets.delete(socket); closed() })
    })
    const helper = resolve(import.meta.dir, 'test-helpers/host-safe-env.ts')
    const grandchildHome = join(root, 'grandchild-home')
    mkdirSync(grandchildHome)
    const grandchild = `
      import { connect } from 'node:net'
      const socket = connect(${JSON.stringify(socketPath)}, () => {
        socket.write(JSON.stringify([process.ppid, process.pid]) + '\\n')
      })
      setInterval(() => {}, 1000)
    `
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
import { hostSafeChildEnv } from ${JSON.stringify(helper)}
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid]))
process.stdout.write(${JSON.stringify(JSON.stringify(inspected()))})
process.stderr.write(${JSON.stringify(allSecrets.join('\n'))})
const child = Bun.spawn([process.execPath, '--eval', ${JSON.stringify(grandchild)}], {
  env: hostSafeChildEnv(${JSON.stringify(grandchildHome)}, { tools: [], pathDirs: [${JSON.stringify(bin)}] }),
  stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
})
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]))
await child.exited
`, { mode: 0o700 })
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    let output: Promise<string[]> = Promise.resolve([])
    try {
      await bounded(new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) }), 'listen')
      child = Bun.spawn([process.execPath, inspectScript, 'docker', 'inspect', 'safe-name'], {
        cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
        env: hostSafeChildEnv(root, { tools: [], pathDirs: [bin], extras: secrets }),
      })
      output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      await bounded(Promise.race([readiness, child.exited.then(() => { throw new Error('Fake Docker readiness was not reached before CLI exit') })]), 'readiness')
      child.kill(signal)
      const code = await bounded(child.exited, 'CLI exit')
      const [stdout, stderr] = await bounded(output, 'output')
      assertNoLeak({ stdout, stderr })
      for (const value of allSecrets) {
        expect((stdout + stderr).includes(value)).toBe(false)
        expect((stdout + stderr).includes(JSON.stringify(value).slice(1, -1))).toBe(false)
      }
      expect({ code, stdout, stderr, signal: child.signalCode ?? null })
        .toEqual({ code: 130, stdout: '', stderr: '', signal: null })
      await bounded(disconnected, 'descendant disconnect')
      // A killed orphan can remain a zombie until the container's init reaps it.
      // Either absent or zombie proves there is no executing descendant left.
      for (const pid of pids) {
        const stat = `/proc/${pid}/stat`
        expect(!existsSync(stat) || readFileSync(stat, 'utf8').split(') ')[1]!.startsWith('Z ')).toBe(true)
      }
    } finally {
      // Cleanup must work even if the wrapper's group kill or readiness fails.
      try { child?.kill('SIGKILL') } catch {}
      const recorded: number[] = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : []
      if (recorded[0]) { try { process.kill(-recorded[0], 'SIGKILL') } catch {} }
      for (const pid of new Set([...recorded, ...pids])) { try { process.kill(pid, 'SIGKILL') } catch {} }
      for (const socket of sockets) socket.destroy()
      const cleanupDeadline = performance.now() + 1_000
      const cleanup = [
        bounded(new Promise<void>(resolve => server.close(() => resolve())), 'server close', cleanupDeadline),
        bounded(output.then(captured => { assertNoLeak(captured) }), 'cleanup output', cleanupDeadline),
      ]
      if (child) cleanup.push(bounded(child.exited.then(() => {}), 'cleanup CLI exit', cleanupDeadline))
      const results = await Promise.allSettled(cleanup)
      for (const result of results) if (result.status === 'rejected') throw result.reason
    }
  })
})

describe('private inspection cancellation with captured process output', () => {
  test('enforces a synchronous sanitization deadline even before the timer can fire', async () => {
    const clock = createFakeClock(), captured: string[] = []
    let parsed = false
    const parseJSON = JSON.parse
    const parse = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      const value = parseJSON(text, reviver)
      parsed = true
      return value
    })
    const now = spyOn(performance, 'now').mockImplementation(() => parsed ? 1_000 : clock.now())
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => clock.setTimeout(callback, ms)) as unknown as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => clock.clearTimeout(handle))
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(inspected()))); c.close() } }),
      stderr: new ReadableStream({ start(c) { c.close() } }),
      exited: Promise.resolve(0), kill() {}, unref() {},
    })) as unknown as typeof Bun.spawn)
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((value: unknown) => { captured.push(String(value)); return true }) as typeof process.stdout.write)
    const stderr = spyOn(process.stderr, 'write').mockImplementation(((value: unknown) => { captured.push(String(value)); return true }) as typeof process.stderr.write)
    try {
      const result = await safeDockerInspect(['docker', 'inspect', 'safe-name'], { timeoutMs: 1_000, env: {} })
      assertNoLeak({ result, captured })
      expect(parsed).toBe(true)
      expect(result).toEqual({ code: 124, text: '', actualExitCode: 0,
        stderr: 'Docker stderr withheld: incomplete inspection cannot certify credential redaction', timedOut: true, outputTruncated: false })
      expect(captured).toEqual([])
      expect(clock.firedCount()).toBe(0)
      expect(clock.pendingCount()).toBe(0)
    } finally {
      stderr.mockRestore(); stdout.mockRestore(); spawn.mockRestore(); clear.mockRestore(); timer.mockRestore(); now.mockRestore(); parse.mockRestore()
    }
  })

  test.each(['timeout', 'pipe drain timeout', 'failed child retaining pipes', 'abort', 'already aborted'] as const)('%s returns no data and cancels both private pipes', async kind => {
    const clock = createFakeClock(), abort = new AbortController(), captured: string[] = [], killed: string[] = []
    let cancelled = 0
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((value: unknown) => { captured.push(String(value)); return true }) as typeof process.stdout.write)
    const stderr = spyOn(process.stderr, 'write').mockImplementation(((value: unknown) => { captured.push(String(value)); return true }) as typeof process.stderr.write)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => clock.setTimeout(callback, ms)) as unknown as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => clock.clearTimeout(handle))
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(inspected()))) }, cancel() { cancelled++ } }),
      stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(allSecrets.join('\n'))) }, cancel() { cancelled++ } }),
      exited: kind === 'pipe drain timeout' ? Promise.resolve(0) : kind === 'failed child retaining pipes' ? Promise.resolve(7) : new Promise(() => {}),
      kill(signal: string) { killed.push(signal) }, unref() {},
    })) as unknown as typeof Bun.spawn)
    try {
      if (kind === 'already aborted') abort.abort()
      let settled = false
      const pending = safeDockerInspect(['docker', 'inspect', 'safe-name'], {
        timeoutMs: 1_000, env: {}, signal: abort.signal,
      }).then(result => { settled = true; return result })
      await clock.flush()
      if (kind === 'timeout' || kind === 'pipe drain timeout') {
        await clock.advance(999); expect(settled).toBe(false)
        await clock.advance(1)
      } else if (kind === 'abort') abort.abort()
      else if (kind === 'failed child retaining pipes') await clock.advance(25)
      const result = await pending
      assertNoLeak({ result, captured })
      const code = kind.includes('timeout') ? 124 : kind === 'failed child retaining pipes' ? 1 : 130
      expect(result).toEqual({ code, text: '',
        actualExitCode: kind === 'pipe drain timeout' ? 0 : kind === 'failed child retaining pipes' ? 7 : null,
        stderr: kind === 'already aborted' ? 'Docker inspection aborted before launch' : 'Docker stderr withheld: incomplete inspection cannot certify credential redaction',
        timedOut: code === 124, outputTruncated: false })
      expect(captured).toEqual([])
      expect(spawn).toHaveBeenCalledTimes(kind === 'already aborted' ? 0 : 1)
      expect(cancelled).toBe(kind === 'already aborted' ? 0 : 2)
      expect(killed).toEqual(kind === 'already aborted' ? [] : ['SIGKILL'])
      expect(clock.pendingCount()).toBe(0)
    } finally {
      spawn.mockRestore(); clear.mockRestore(); timer.mockRestore(); stderr.mockRestore(); stdout.mockRestore()
    }
  })

  test.each(['cap', 'deadline', 'abort', 'read failure', 'cancel rejection', 'cancel never settles'] as const)(
    '%s withholds a credential fragment even when inspection stdout is complete', async kind => {
      const clock = createFakeClock(), abort = new AbortController()
      const fragment = genericSecret.slice(0, 12)
      let cancelled = 0, pulls = 0
      const raw = JSON.stringify([{ Id: id, Config: { Env: [`CUSTOM_TOKEN=${genericSecret}`] } }])
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => clock.setTimeout(callback, ms)) as unknown as typeof setTimeout)
      const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => clock.clearTimeout(handle))
      const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
        stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close() } }),
        stderr: new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('failure-marker ' + fragment)) },
          pull(c) { if (kind === 'read failure' && ++pulls > 0) c.error(new Error('synthetic read failure')) },
          cancel() {
            cancelled++
            if (kind === 'cancel rejection') return Promise.reject(new Error('synthetic cancellation failure'))
            if (kind === 'cancel never settles') return new Promise<void>(() => {})
          },
        }),
        exited: ['cancel rejection', 'cancel never settles'].includes(kind) ? Promise.resolve(17) : new Promise(() => {}),
        kill() {}, unref() {},
      })) as unknown as typeof Bun.spawn)
      try {
        let settled = false
        const pending = safeDockerInspect(['docker', 'inspect', 'safe-name'], {
          timeoutMs: 1_000, env: {}, signal: abort.signal,
          maxOutputBytes: kind === 'cap' ? Buffer.byteLength(raw) + 1 : undefined,
        }).then(result => { settled = true; return result })
        await clock.flush()
        if (kind === 'deadline') { await clock.advance(999); expect(settled).toBe(false); await clock.advance(1) }
        if (kind === 'abort') abort.abort()
        if (kind.startsWith('cancel')) { await clock.advance(24); expect(settled).toBe(false); await clock.advance(1) }
        const result = await pending
        // Only boolean assertions run before a diff printer can see a secret prefix.
        expect(JSON.stringify(result).includes(fragment)).toBe(false)
        assertNoLeak(result)
        const code = kind === 'cap' ? 75 : kind === 'deadline' ? 124 : kind === 'abort' ? 130 : 1
        expect(result).toEqual({ code, text: '', actualExitCode: kind.startsWith('cancel') ? 17 : null,
          stderr: 'Docker stderr withheld: incomplete inspection cannot certify credential redaction',
          timedOut: kind === 'deadline', outputTruncated: kind === 'cap' })
        expect(cancelled).toBe(kind === 'read failure' ? 0 : 1)
        expect(clock.pendingCount()).toBe(0)
      } finally { spawn.mockRestore(); clear.mockRestore(); timer.mockRestore() }
    },
  )

})
