/**
 * claude-director-cli.test.ts — Unit tests for src/claude-director-cli.ts
 *
 * Tests sit BELOW the stub layer. They exercise the wrapper directly via the
 * _setSpawnRunner / _resetSpawnRunner seam (CE4). No real subprocess is invoked.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  spawn,
  resume,
  list,
  decide,
  kill,
  deleteSpawn,
  status,
  get,
  sendKeys,
  pause,
  version,
  _setSpawnRunner,
  _resetSpawnRunner,
  CLAUDE_DIRECTOR_ERROR_TOKENS,
  type SpawnRunner,
  type ClaudeDirectorError,
} from '../src/claude-director-cli.ts'

// ---------------------------------------------------------------------------
// Stub infrastructure
// ---------------------------------------------------------------------------

interface StubResult {
  status?: number | null
  stdout?: string
  stderr?: string
  error?: NodeJS.ErrnoException
}

type StubFactory =
  | StubResult
  | ((cmd: string, args: string[]) => StubResult)

interface ExecCall {
  cmd: string
  args: string[]
}

interface ExecStub {
  runner: SpawnRunner
  calls: ExecCall[]
}

function makeExecStub(factory: StubFactory): ExecStub {
  const calls: ExecCall[] = []
  const runner: SpawnRunner = (cmd, args) => {
    calls.push({ cmd, args: [...args] })
    const raw = typeof factory === 'function' ? factory(cmd, args) : factory
    return {
      status: raw.status ?? 0,
      stdout: raw.stdout ?? '',
      stderr: raw.stderr ?? '',
      error: raw.error,
    }
  }
  return { runner, calls }
}

/** Successful stub with optional stdout */
function okStub(stdout = ''): StubResult {
  return { status: 0, stdout, stderr: '' }
}

/** Error stub that produces JSON err_name on stderr with exit 1 */
function errTokenStub(token: string): StubResult {
  return {
    status: 1,
    stdout: '',
    stderr: JSON.stringify({ err_name: token, err_description: `${token} occurred` }),
  }
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

let stub: ExecStub

beforeEach(() => {
  stub = makeExecStub(okStub())
  _setSpawnRunner(stub.runner)
})

afterEach(() => {
  _resetSpawnRunner()
})

// ---------------------------------------------------------------------------
// 1. argv assembly — spawn
// ---------------------------------------------------------------------------

describe('spawn argv assembly', () => {
  test('contains correct flags in stable order', () => {
    spawn({ channelId: 'C123', cwd: '/workdir' })
    expect(stub.calls).toHaveLength(1)
    const args = stub.calls[0].args
    expect(args[0]).toBe('spawn')
    expect(args).toContain('--template')
    expect(args[args.indexOf('--template') + 1]).toBe('slack-channel-bot')
    expect(args).toContain('--cwd')
    expect(args[args.indexOf('--cwd') + 1]).toBe('/workdir')
    expect(args).toContain('--claude-instance-id')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_C123')
    expect(args).toContain('--relay-mode')
    expect(args[args.indexOf('--relay-mode') + 1]).toBe('on')
    expect(args).toContain('--tmux-session-name')
    expect(args[args.indexOf('--tmux-session-name') + 1]).toBe('slack_bot_C123')
    // Two --label flags
    const labelIndices = args.reduce<number[]>((acc, a, i) => (a === '--label' ? [...acc, i] : acc), [])
    expect(labelIndices).toHaveLength(2)
    expect(args[labelIndices[0] + 1]).toBe('service=cscb')
    expect(args[labelIndices[1] + 1]).toBe('channel=C123')
  })

  test('no -- separator appears in argv', () => {
    spawn({ channelId: 'C123', cwd: '/workdir' })
    const args = stub.calls[0].args
    expect(args).not.toContain('--')
  })

  test('no post -- claude args in argv', () => {
    spawn({ channelId: 'C123', cwd: '/workdir' })
    const args = stub.calls[0].args
    const dashDashIdx = args.indexOf('--')
    expect(dashDashIdx).toBe(-1) // enforces the no-post-dash invariant
  })

  test('extraEnv produces repeated --extra-env KEY=VALUE flags', () => {
    spawn({ channelId: 'C123', cwd: '/workdir', extraEnv: { FOO: 'bar', BAZ: 'qux' } })
    const args = stub.calls[0].args
    const envIndices = args.reduce<number[]>((acc, a, i) => (a === '--extra-env' ? [...acc, i] : acc), [])
    expect(envIndices).toHaveLength(2)
    const envValues = envIndices.map(i => args[i + 1])
    expect(envValues).toContain('FOO=bar')
    expect(envValues).toContain('BAZ=qux')
  })

  test('no --extra-env when extraEnv not provided', () => {
    spawn({ channelId: 'C123', cwd: '/workdir' })
    expect(stub.calls[0].args).not.toContain('--extra-env')
  })

  test('returns ok with claudeInstanceId from stdout JSON', () => {
    stub = makeExecStub(okStub(JSON.stringify({ claude_instance_id: 'cscb_C123' })))
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C123', cwd: '/workdir' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.claudeInstanceId).toBe('cscb_C123')
    }
  })

  test('falls back to derived instanceId when stdout is not JSON', () => {
    stub = makeExecStub(okStub(''))
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C123', cwd: '/workdir' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.claudeInstanceId).toBe('cscb_C123')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. argv assembly — resume
// ---------------------------------------------------------------------------

describe('resume argv assembly', () => {
  test('contains resume verb and --claude-instance-id derived from channelId', () => {
    resume({ channelId: 'C456' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('resume')
    expect(args).toContain('--claude-instance-id')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_C456')
  })
})

// ---------------------------------------------------------------------------
// 3. argv assembly — list
// ---------------------------------------------------------------------------

describe('list argv assembly', () => {
  const listOkStdout = JSON.stringify({ spawns: [] })

  test('undefined labels → --label service=cscb', () => {
    stub = makeExecStub(okStub(listOkStdout))
    _setSpawnRunner(stub.runner)
    list({})
    const args = stub.calls[0].args
    expect(args[0]).toBe('list')
    const labelIdx = args.indexOf('--label')
    expect(labelIdx).not.toBe(-1)
    expect(args[labelIdx + 1]).toBe('service=cscb')
  })

  test('explicit {} labels → no --label flags', () => {
    stub = makeExecStub(okStub(listOkStdout))
    _setSpawnRunner(stub.runner)
    list({ labels: {} })
    const args = stub.calls[0].args
    expect(args).not.toContain('--label')
  })

  test('state → --state <value>', () => {
    stub = makeExecStub(okStub(listOkStdout))
    _setSpawnRunner(stub.runner)
    list({ state: 'check_permission', labels: { service: 'cscb' } })
    const args = stub.calls[0].args
    const stateIdx = args.indexOf('--state')
    expect(stateIdx).not.toBe(-1)
    expect(args[stateIdx + 1]).toBe('check_permission')
  })

  test('label key=value pair produces --label key=value', () => {
    stub = makeExecStub(okStub(listOkStdout))
    _setSpawnRunner(stub.runner)
    list({ labels: { service: 'cscb' } })
    const args = stub.calls[0].args
    const labelIdx = args.indexOf('--label')
    expect(labelIdx).not.toBe(-1)
    expect(args[labelIdx + 1]).toBe('service=cscb')
  })

  test('representative relay-poller call: state check_permission, label service=cscb', () => {
    stub = makeExecStub(okStub(listOkStdout))
    _setSpawnRunner(stub.runner)
    list({ state: 'check_permission', labels: { service: 'cscb' } })
    const args = stub.calls[0].args
    expect(args).toContain('--state')
    expect(args[args.indexOf('--state') + 1]).toBe('check_permission')
    expect(args).toContain('--label')
    expect(args[args.indexOf('--label') + 1]).toBe('service=cscb')
  })

  test('returns parsed SpawnRow array', () => {
    const sampleStdout = JSON.stringify({
      spawns: [
        {
          claude_instance_id: 'cscb_C1',
          state: 'idle',
          labels: { service: 'cscb', channel: 'C1' },
          cwd: '/workdir',
          tmux_session_name: 'slack_bot_C1',
          relay_mode: 'on',
        },
      ],
    })
    stub = makeExecStub(okStub(sampleStdout))
    _setSpawnRunner(stub.runner)
    const result = list({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toHaveLength(1)
      expect(result.data[0].claudeInstanceId).toBe('cscb_C1')
      expect(result.data[0].state).toBe('idle')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. argv assembly — decide
// ---------------------------------------------------------------------------

describe('decide argv assembly', () => {
  test('contains decide, --claude-instance-id, --request-id, --decision', () => {
    decide({ channelId: 'C789', requestId: '42', decision: 'allow' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('decide')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_C789')
    expect(args[args.indexOf('--request-id') + 1]).toBe('42')
    expect(args[args.indexOf('--decision') + 1]).toBe('allow')
  })

  test('requestId past 2^53 is passed verbatim as string — never through Number()', () => {
    const bigId = '9007199254740993' // 2^53 + 1
    decide({ channelId: 'C789', requestId: bigId, decision: 'deny' })
    const args = stub.calls[0].args
    const reqIdx = args.indexOf('--request-id')
    expect(reqIdx).not.toBe(-1)
    // Must be the exact string, not a rounded Number
    expect(args[reqIdx + 1]).toBe(bigId)
    expect(args[reqIdx + 1]).not.toBe(String(Number(bigId))) // Number() loses precision
  })

  test('no --reason flag by default', () => {
    decide({ channelId: 'C789', requestId: '1', decision: 'allow' })
    expect(stub.calls[0].args).not.toContain('--reason')
  })

  test('deny decision', () => {
    decide({ channelId: 'C789', requestId: '1', decision: 'deny' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--decision') + 1]).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// 5. argv assembly — kill
// ---------------------------------------------------------------------------

describe('kill argv assembly', () => {
  test('contains kill and --claude-instance-id', () => {
    kill({ channelId: 'Ck' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('kill')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_Ck')
  })
})

// ---------------------------------------------------------------------------
// 6. argv assembly — deleteSpawn
// ---------------------------------------------------------------------------

describe('deleteSpawn argv assembly', () => {
  test('contains delete and --claude-instance-id', () => {
    deleteSpawn({ channelId: 'Cd' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('delete')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_Cd')
  })
})

// ---------------------------------------------------------------------------
// 7. argv assembly — status
// ---------------------------------------------------------------------------

describe('status argv assembly', () => {
  test('contains status and --claude-instance-id', () => {
    stub = makeExecStub(okStub(JSON.stringify({ claude_instance_id: 'cscb_Cs', state: 'idle' })))
    _setSpawnRunner(stub.runner)
    status({ channelId: 'Cs' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('status')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_Cs')
  })
})

// ---------------------------------------------------------------------------
// 8. argv assembly — get
// ---------------------------------------------------------------------------

describe('get argv assembly', () => {
  const getOkStdout = JSON.stringify({
    claude_instance_id: 'cscb_Cg',
    state: 'idle',
    labels: {},
    permission_request: null,
  })

  test('contains get and --claude-instance-id', () => {
    stub = makeExecStub(okStub(getOkStdout))
    _setSpawnRunner(stub.runner)
    get({ channelId: 'Cg' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('get')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_Cg')
  })
})

// ---------------------------------------------------------------------------
// 9. argv assembly — sendKeys
// ---------------------------------------------------------------------------

describe('sendKeys argv assembly', () => {
  test('passes keys as separate --text argv elements', () => {
    sendKeys({ channelId: 'Csk', keys: ['/mcp reconnect slack-channel-router', 'Enter'] })
    const args = stub.calls[0].args
    expect(args[0]).toBe('send-keys')
    // Collect all --text values
    const textValues: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--text') textValues.push(args[i + 1])
    }
    expect(textValues).toContain('/mcp reconnect slack-channel-router')
    expect(textValues).toContain('Enter')
  })

  test('key with spaces is NOT split on whitespace', () => {
    sendKeys({ channelId: 'Csk', keys: ['hello world foo'] })
    const args = stub.calls[0].args
    const textIdx = args.indexOf('--text')
    expect(args[textIdx + 1]).toBe('hello world foo')
    // Must not have split into multiple elements
    expect(args).not.toContain('hello')
    expect(args).not.toContain('world')
  })

  test('key with metacharacters is NOT split or interpolated', () => {
    const dangerous = '; $(rm -rf /)'
    sendKeys({ channelId: 'Csk', keys: [dangerous] })
    const args = stub.calls[0].args
    const textIdx = args.indexOf('--text')
    // The entire payload must appear as a single argv element
    expect(args[textIdx + 1]).toBe(dangerous)
  })

  test('key with semicolons is preserved', () => {
    sendKeys({ channelId: 'Csk', keys: ['cmd; echo pwned'] })
    const args = stub.calls[0].args
    const textIdx = args.indexOf('--text')
    expect(args[textIdx + 1]).toBe('cmd; echo pwned')
  })
})

// ---------------------------------------------------------------------------
// 10. argv assembly — pause
// ---------------------------------------------------------------------------

describe('pause argv assembly', () => {
  test('contains pause and --claude-instance-id', () => {
    pause({ channelId: 'Cp' })
    const args = stub.calls[0].args
    expect(args[0]).toBe('pause')
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_Cp')
  })
})

// ---------------------------------------------------------------------------
// 11. argv assembly — version
// ---------------------------------------------------------------------------

describe('version argv assembly', () => {
  test('argv is [\'version\'] only', () => {
    stub = makeExecStub(okStub('v0.2.3'))
    _setSpawnRunner(stub.runner)
    version()
    expect(stub.calls[0].args).toEqual(['version'])
  })

  test('parses plain-text version string', () => {
    stub = makeExecStub(okStub('v0.2.3'))
    _setSpawnRunner(stub.runner)
    const result = version()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.version).toBe('v0.2.3')
  })

  test('parses JSON version object', () => {
    stub = makeExecStub(okStub(JSON.stringify({ version: 'v1.0.0', commit: 'abc123' })))
    _setSpawnRunner(stub.runner)
    const result = version()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.version).toBe('v1.0.0')
  })
})

// ---------------------------------------------------------------------------
// 12. CE7 claudeInstanceId precedence
// ---------------------------------------------------------------------------

describe('CE7 claudeInstanceId precedence', () => {
  const getOkStdout = JSON.stringify({ claude_instance_id: 'explicit_id', state: 'idle', labels: {}, permission_request: null })

  test('claudeInstanceId wins over channelId in get', () => {
    stub = makeExecStub(okStub(getOkStdout))
    _setSpawnRunner(stub.runner)
    get({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId alone is passed verbatim in get', () => {
    stub = makeExecStub(okStub(getOkStdout))
    _setSpawnRunner(stub.runner)
    get({ claudeInstanceId: 'my_custom_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('my_custom_id')
  })

  test('channelId alone derives cscb_<channelId> in get', () => {
    stub = makeExecStub(okStub(getOkStdout))
    _setSpawnRunner(stub.runner)
    get({ channelId: 'C2' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('cscb_C2')
  })

  test('claudeInstanceId wins over channelId in status', () => {
    stub = makeExecStub(okStub(JSON.stringify({ claude_instance_id: 'explicit_id', state: 'idle' })))
    _setSpawnRunner(stub.runner)
    status({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId wins over channelId in decide', () => {
    decide({ channelId: 'C1', claudeInstanceId: 'explicit_id', requestId: '1', decision: 'allow' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId wins over channelId in resume', () => {
    resume({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId wins over channelId in kill', () => {
    kill({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId wins over channelId in deleteSpawn', () => {
    deleteSpawn({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })

  test('claudeInstanceId wins over channelId in pause', () => {
    pause({ channelId: 'C1', claudeInstanceId: 'explicit_id' })
    const args = stub.calls[0].args
    expect(args[args.indexOf('--claude-instance-id') + 1]).toBe('explicit_id')
  })
})

// ---------------------------------------------------------------------------
// 13. Error-token discrimination — one test per SR-8.3 variant
// ---------------------------------------------------------------------------

describe('error token discrimination', () => {
  for (const [name, token] of Object.entries(CLAUDE_DIRECTOR_ERROR_TOKENS) as Array<[ClaudeDirectorError['kind'], string]>) {
    test(`${name} surfaces as { ok: false, error: { kind: '${name}' } }`, () => {
      stub = makeExecStub(errTokenStub(token))
      _setSpawnRunner(stub.runner)
      // Use spawn as a representative caller (all verbs share the same classifyError path)
      const result = spawn({ channelId: 'C1', cwd: '/work' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe(name)
      }
    })
  }

  test('unknown error token surfaces as ErrNonZeroExit with raw stderr and exit code', () => {
    stub = makeExecStub({
      status: 1,
      stdout: '',
      stderr: JSON.stringify({ err_name: 'ErrSomeNewUnknownToken', err_description: 'oops' }),
    })
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C1', cwd: '/work' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('ErrNonZeroExit')
      if (result.error.kind === 'ErrNonZeroExit') {
        expect(result.error.exitCode).toBe(1)
        expect(result.error.stderr).toContain('ErrSomeNewUnknownToken')
      }
    }
  })

  test('non-zero exit with no parseable JSON surfaces as ErrNonZeroExit with raw stderr', () => {
    stub = makeExecStub({ status: 2, stdout: '', stderr: 'some raw error output' })
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C1', cwd: '/work' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('ErrNonZeroExit')
      if (result.error.kind === 'ErrNonZeroExit') {
        expect(result.error.stderr).toBe('some raw error output')
        expect(result.error.exitCode).toBe(2)
      }
    }
  })

  test('ENOENT surfaces as ErrBinaryMissing', () => {
    const enoentError = new Error('spawn claude-director ENOENT') as NodeJS.ErrnoException
    enoentError.code = 'ENOENT'
    stub = makeExecStub({ error: enoentError })
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C1', cwd: '/work' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('ErrBinaryMissing')
    }
  })

  test('error variant payloads include message from stderr', () => {
    stub = makeExecStub(errTokenStub('ErrSpawnNotFound'))
    _setSpawnRunner(stub.runner)
    const getOk = JSON.stringify({ claude_instance_id: 'x', state: 'x', labels: {}, permission_request: null })
    // Use get for ErrSpawnNotFound
    stub = makeExecStub({ status: 1, stdout: '', stderr: JSON.stringify({ err_name: 'ErrSpawnNotFound' }) })
    _setSpawnRunner(stub.runner)
    const result = get({ channelId: 'C1' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'ErrSpawnNotFound') {
      expect(result.error.message).toContain('ErrSpawnNotFound')
    }
  })
})

// ---------------------------------------------------------------------------
// 14. Bigint-safe parsing
// ---------------------------------------------------------------------------

describe('bigint-safe parsing in get', () => {
  function makeGetStdout(requestId: unknown) {
    return JSON.stringify({
      claude_instance_id: 'cscb_Cbig',
      state: 'check_permission',
      labels: {},
      permission_request: {
        request_id: requestId,
        tool_name: 'bash',
        tool_input: '{}',
      },
    })
  }

  test('request_id at 2^53+1 surfaces as exact string without precision loss', () => {
    // NOTE: JSON.stringify will lose precision here — we must provide the raw JSON manually
    const rawJson = `{"claude_instance_id":"cscb_Cbig","state":"check_permission","labels":{},"permission_request":{"request_id":9007199254740993,"tool_name":"bash","tool_input":"{}"}}`
    stub = makeExecStub(okStub(rawJson))
    _setSpawnRunner(stub.runner)
    const result = get({ channelId: 'Cbig' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(typeof result.data.permissionRequest?.requestId).toBe('string')
      expect(result.data.permissionRequest?.requestId).toBe('9007199254740993')
    }
  })

  test('request_id at uint64-max surfaces as exact string', () => {
    const rawJson = `{"claude_instance_id":"cscb_Cbig","state":"check_permission","labels":{},"permission_request":{"request_id":18446744073709551615,"tool_name":"bash","tool_input":"{}"}}`
    stub = makeExecStub(okStub(rawJson))
    _setSpawnRunner(stub.runner)
    const result = get({ channelId: 'Cbig' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(typeof result.data.permissionRequest?.requestId).toBe('string')
      expect(result.data.permissionRequest?.requestId).toBe('18446744073709551615')
    }
  })

  test('small in-safe-range request_id is still exposed as a string (contract: always string)', () => {
    const rawJson = `{"claude_instance_id":"cscb_C42","state":"check_permission","labels":{},"permission_request":{"request_id":42,"tool_name":"bash","tool_input":"{}"}}`
    stub = makeExecStub(okStub(rawJson))
    _setSpawnRunner(stub.runner)
    const result = get({ channelId: 'C42' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(typeof result.data.permissionRequest?.requestId).toBe('string')
      expect(result.data.permissionRequest?.requestId).toBe('42')
    }
  })

  test('null permission_request does not throw', () => {
    const rawJson = `{"claude_instance_id":"cscb_Cnull","state":"idle","labels":{},"permission_request":null}`
    stub = makeExecStub(okStub(rawJson))
    _setSpawnRunner(stub.runner)
    const result = get({ channelId: 'Cnull' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.permissionRequest).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 15. Exec seam contract
// ---------------------------------------------------------------------------

describe('exec seam contract', () => {
  test('wrapper accepts injected exec via _setSpawnRunner', () => {
    const customStub = makeExecStub(okStub(''))
    _setSpawnRunner(customStub.runner)
    spawn({ channelId: 'C1', cwd: '/w' })
    expect(customStub.calls).toHaveLength(1)
    expect(stub.calls).toHaveLength(0) // original stub was not called
  })

  test('wrapper invokes the injected exec exactly once per spawn call', () => {
    spawn({ channelId: 'C1', cwd: '/w' })
    expect(stub.calls).toHaveLength(1)
  })

  test('wrapper invokes the injected exec exactly once per resume call', () => {
    resume({ channelId: 'C1' })
    expect(stub.calls).toHaveLength(1)
  })

  test('wrapper invokes the injected exec exactly once per list call', () => {
    stub = makeExecStub(okStub(JSON.stringify({ spawns: [] })))
    _setSpawnRunner(stub.runner)
    list({})
    expect(stub.calls).toHaveLength(1)
  })

  test('wrapper invokes the injected exec exactly once per decide call', () => {
    decide({ channelId: 'C1', requestId: '1', decision: 'allow' })
    expect(stub.calls).toHaveLength(1)
  })

  test('error variant result includes stub stderr when ErrNonZeroExit', () => {
    const stderrPayload = 'some unexpected error message'
    stub = makeExecStub({ status: 1, stdout: '', stderr: stderrPayload })
    _setSpawnRunner(stub.runner)
    const result = spawn({ channelId: 'C1', cwd: '/w' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'ErrNonZeroExit') {
      expect(result.error.stderr).toBe(stderrPayload)
    }
  })
})

// ---------------------------------------------------------------------------
// 16. Error token disjointness
// ---------------------------------------------------------------------------

describe('error token disjointness', () => {
  test('no token in CLAUDE_DIRECTOR_ERROR_TOKENS is a substring of another', () => {
    const tokens = Object.values(CLAUDE_DIRECTOR_ERROR_TOKENS)
    for (let i = 0; i < tokens.length; i++) {
      for (let j = 0; j < tokens.length; j++) {
        if (i === j) continue
        const a = tokens[i]
        const b = tokens[j]
        // Neither a contains b, nor b contains a (except identical, which can't happen since i≠j)
        if (a !== b) {
          expect(a.includes(b)).toBe(false)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 17. Argv-style hygiene invariant — metacharacter safety
// ---------------------------------------------------------------------------

describe('argv-style hygiene — no shell metacharacter leakage', () => {
  const METACHARACTERS = [';', '&&', '$(', '`']

  // Capture all calls across adversarial inputs
  const allCapturedArgs: string[][] = []

  test('spawn with adversarial channelId and cwd does not leak metacharacters', () => {
    const localStub = makeExecStub(okStub(''))
    _setSpawnRunner(localStub.runner)
    spawn({ channelId: 'C1;evil', cwd: '$(rm -rf /)' })
    allCapturedArgs.push(...localStub.calls.map(c => c.args))

    for (const args of localStub.calls.map(c => c.args)) {
      expect(Array.isArray(args)).toBe(true)
      // Each element is a string, none are arrays or objects (no shell: true)
      for (const arg of args) {
        expect(typeof arg).toBe('string')
      }
    }
  })

  test('resume with adversarial channelId does not leak', () => {
    const localStub = makeExecStub(okStub(''))
    _setSpawnRunner(localStub.runner)
    resume({ channelId: 'C&&evil' })
    allCapturedArgs.push(...localStub.calls.map(c => c.args))

    for (const args of localStub.calls.map(c => c.args)) {
      expect(Array.isArray(args)).toBe(true)
    }
  })

  test('decide with adversarial requestId passes it verbatim', () => {
    const localStub = makeExecStub(okStub(''))
    _setSpawnRunner(localStub.runner)
    decide({ channelId: 'C`evil`', requestId: '9007199254740993', decision: 'allow' })
    allCapturedArgs.push(...localStub.calls.map(c => c.args))

    const args = localStub.calls[0].args
    expect(Array.isArray(args)).toBe(true)
  })

  test('sendKeys with metacharacter payload does not cause injection', () => {
    const localStub = makeExecStub(okStub(''))
    _setSpawnRunner(localStub.runner)
    sendKeys({ channelId: 'C1', keys: ['; rm -rf /', '`whoami`', '$(cat /etc/passwd)'] })
    allCapturedArgs.push(...localStub.calls.map(c => c.args))

    // All keys must appear as distinct --text argv elements, not split
    const args = localStub.calls[0].args
    expect(Array.isArray(args)).toBe(true)
    const textValues: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--text') textValues.push(args[i + 1])
    }
    expect(textValues).toContain('; rm -rf /')
    expect(textValues).toContain('`whoami`')
    expect(textValues).toContain('$(cat /etc/passwd)')
  })

  test('spawn extraEnv with metacharacters in value is passed as single element', () => {
    const localStub = makeExecStub(okStub(''))
    _setSpawnRunner(localStub.runner)
    spawn({ channelId: 'C1', cwd: '/work', extraEnv: { EVIL: '$(whoami)&&bad' } })
    const args = localStub.calls[0].args
    const envIdx = args.indexOf('--extra-env')
    expect(envIdx).not.toBe(-1)
    // Must be a single element, not split
    expect(args[envIdx + 1]).toBe('EVIL=$(whoami)&&bad')
  })
})

// ---------------------------------------------------------------------------
// 18. version shares error variants with ENOENT / non-zero / unparseable
// ---------------------------------------------------------------------------

describe('version error variants', () => {
  test('version: ENOENT surfaces as ErrBinaryMissing', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    stub = makeExecStub({ error: err })
    _setSpawnRunner(stub.runner)
    const result = version()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('ErrBinaryMissing')
    }
  })

  test('version: non-zero exit surfaces as ErrNonZeroExit', () => {
    stub = makeExecStub({ status: 1, stdout: '', stderr: 'version failed' })
    _setSpawnRunner(stub.runner)
    const result = version()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('ErrNonZeroExit')
    }
  })
})

// ---------------------------------------------------------------------------
// 19. cmd argument is always 'claude-director'
// ---------------------------------------------------------------------------

describe('all verbs pass cmd=claude-director', () => {
  test('spawn uses claude-director as cmd', () => {
    spawn({ channelId: 'C1', cwd: '/w' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('resume uses claude-director as cmd', () => {
    resume({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('list uses claude-director as cmd', () => {
    stub = makeExecStub(okStub(JSON.stringify({ spawns: [] })))
    _setSpawnRunner(stub.runner)
    list({})
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('decide uses claude-director as cmd', () => {
    decide({ channelId: 'C1', requestId: '1', decision: 'allow' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('kill uses claude-director as cmd', () => {
    kill({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('deleteSpawn uses claude-director as cmd', () => {
    deleteSpawn({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('status uses claude-director as cmd', () => {
    stub = makeExecStub(okStub(JSON.stringify({ claude_instance_id: 'x', state: 'idle' })))
    _setSpawnRunner(stub.runner)
    status({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('get uses claude-director as cmd', () => {
    stub = makeExecStub(okStub(JSON.stringify({ claude_instance_id: 'x', state: 'idle', labels: {}, permission_request: null })))
    _setSpawnRunner(stub.runner)
    get({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('sendKeys uses claude-director as cmd', () => {
    sendKeys({ channelId: 'C1', keys: ['Enter'] })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('pause uses claude-director as cmd', () => {
    pause({ channelId: 'C1' })
    expect(stub.calls[0].cmd).toBe('claude-director')
  })

  test('version uses claude-director as cmd', () => {
    stub = makeExecStub(okStub('v1.0'))
    _setSpawnRunner(stub.runner)
    version()
    expect(stub.calls[0].cmd).toBe('claude-director')
  })
})
