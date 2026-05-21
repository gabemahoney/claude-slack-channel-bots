/**
 * dependency-check.test.ts — Tests for claude-director startup gates.
 *
 * Covers:
 *   - CE1: runVersionProbe / assertClaudeDirectorPresentFatal
 *   - CE2: assertClaudeDirectorStateDbSameUserFatal
 *   - Ordering / short-circuit via runStartupGates
 *
 * No real subprocesses, no real $HOME reads, no real process.exit.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  runVersionProbe,
  assertClaudeDirectorPresentFatal,
  assertClaudeDirectorStateDbSameUserFatal,
  runStartupGates,
  type DepProbeDeps,
} from '../src/claude-director-probe.ts'

// ---------------------------------------------------------------------------
// Sentinel error thrown by the exit stub so short-circuit tests work
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

// ---------------------------------------------------------------------------
// Capture arrays (reset in beforeEach)
// ---------------------------------------------------------------------------

let recordedErrors: Array<{ classLabel: string; message: string; cause?: unknown }>
let exitCodes: number[]
let checkPidConflictCalls: string[]
let capturedArgvCalls: Array<[string, ...string[]]>

beforeEach(() => {
  recordedErrors = []
  exitCodes = []
  checkPidConflictCalls = []
  capturedArgvCalls = []
})

// ---------------------------------------------------------------------------
// makeStubExec — returns an argv-recording exec stub
// ---------------------------------------------------------------------------

function makeStubExec(opts: {
  exitCode: number | null
  stdout: string
  stderr: string
  throwError?: NodeJS.ErrnoException
}): DepProbeDeps['exec'] {
  return (argv: [string, ...string[]]) => {
    capturedArgvCalls.push(argv)
    if (opts.throwError) throw opts.throwError
    return { exitCode: opts.exitCode, stdout: opts.stdout, stderr: opts.stderr }
  }
}

// ---------------------------------------------------------------------------
// makeDeps — full injectable deps bundle with sensible defaults
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<DepProbeDeps>): DepProbeDeps {
  const defaults: DepProbeDeps = {
    // Success exec: exit 0, parseable stdout
    exec: makeStubExec({ exitCode: 0, stdout: 'claude-director 1.2.3\n', stderr: '' }),

    // statSync: returns uid matching default geteuid (1000)
    statSync: (_path: string) => ({ uid: 1000 }),

    // geteuid: returns fixed UID 1000
    geteuid: () => 1000,

    // userInfo: returns uid 1000
    userInfo: () => ({ uid: 1000 }),

    // recordStartupError spy
    recordStartupError: (classLabel: string, message: string, cause?: unknown) => {
      recordedErrors.push({ classLabel, message, cause })
    },

    // exit spy — throws ExitError so short-circuit tests work naturally
    exit: (code: number): never => {
      exitCodes.push(code)
      throw new ExitError(code)
    },

    // checkPidConflict spy
    checkPidConflict: (pidFile: string) => {
      checkPidConflictCalls.push(pidFile)
    },

    // startupTrace for ordering tests
    startupTrace: [],
  }

  return overrides ? { ...defaults, ...overrides } : defaults
}

/** Run fn, catching ExitError. Returns the ExitError or null. */
function catchExit(fn: () => void): ExitError | null {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof ExitError) return e
    throw e
  }
}

// ===========================================================================
// SECTION 1: Version probe (CE1)
// ===========================================================================

describe('runVersionProbe — success', () => {
  test('returns ok:true when exit 0 and non-empty stdout', () => {
    const deps = makeDeps()
    const result = runVersionProbe(deps)
    expect(result.ok).toBe(true)
  })

  test('does not invoke recordStartupError on success', () => {
    const deps = makeDeps()
    runVersionProbe(deps)
    expect(recordedErrors).toHaveLength(0)
  })
})

describe('runVersionProbe — non-zero exit code', () => {
  test('returns ok:false with reason nonzero-exit', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: 'command failed' }),
    })
    const result = runVersionProbe(deps)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('nonzero-exit')
  })

  test('details field references the exit code', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 2, stdout: '', stderr: '' }),
    })
    const result = runVersionProbe(deps)
    expect(result.details).toContain('2')
  })
})

describe('runVersionProbe — ENOENT (missing binary)', () => {
  test('returns ok:false with reason "missing" on ENOENT', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    const result = runVersionProbe(deps)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing')
  })

  test('details identifies missing-binary / ENOENT', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    const result = runVersionProbe(deps)
    expect(result.details).toContain('ENOENT')
  })
})

describe('runVersionProbe — empty stdout', () => {
  test('returns ok:false with reason "empty-output" when stdout is whitespace only', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 0, stdout: '   \n', stderr: '' }),
    })
    const result = runVersionProbe(deps)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('empty-output')
  })
})

// ---------------------------------------------------------------------------
// Argv-style assertions
// ---------------------------------------------------------------------------

describe('runVersionProbe — argv-style execution', () => {
  test('exec is called with argv array starting with ["claude-director", "version"]', () => {
    const deps = makeDeps()
    runVersionProbe(deps)
    expect(capturedArgvCalls).toHaveLength(1)
    expect(capturedArgvCalls[0][0]).toBe('claude-director')
    expect(capturedArgvCalls[0][1]).toBe('version')
  })

  test('no argv element contains shell metacharacters (; && $()', () => {
    const deps = makeDeps()
    runVersionProbe(deps)
    const argv = capturedArgvCalls[0]
    for (const element of argv) {
      expect(element).not.toMatch(/[;]/)
      expect(element).not.toContain('&&')
      expect(element).not.toContain('$(')
    }
  })
})

// ===========================================================================
// SECTION 2: assertClaudeDirectorPresentFatal (CE1 fatal wrapper)
// ===========================================================================

describe('assertClaudeDirectorPresentFatal — success', () => {
  test('returns without error when probe succeeds', () => {
    const deps = makeDeps()
    expect(() => assertClaudeDirectorPresentFatal(deps)).not.toThrow()
  })

  test('does not invoke recordStartupError on success', () => {
    const deps = makeDeps()
    assertClaudeDirectorPresentFatal(deps)
    expect(recordedErrors).toHaveLength(0)
  })

  test('does not invoke exit on success', () => {
    const deps = makeDeps()
    assertClaudeDirectorPresentFatal(deps)
    expect(exitCodes).toHaveLength(0)
  })
})

describe('assertClaudeDirectorPresentFatal — non-zero exit code', () => {
  test('calls recordStartupError exactly once with class "dep-probe"', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: 'failed' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe')
  })

  test('calls exit exactly once with a non-zero code', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).not.toBe(0)
  })

  test('logged message identifies claude-director', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors[0].message).toContain('claude-director')
  })

  test('logged message identifies non-zero exit failure mode', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    // Should mention non-zero or exit code context
    expect(recordedErrors[0].message).toMatch(/non-zero|exit code|exited/i)
  })
})

describe('assertClaudeDirectorPresentFatal — ENOENT (missing binary)', () => {
  test('calls recordStartupError exactly once with class "dep-probe"', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe')
  })

  test('calls exit exactly once with non-zero code on ENOENT', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).not.toBe(0)
  })

  test('logged message identifies missing-binary condition', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors[0].message).toMatch(/not found|missing|binary/i)
  })
})

describe('assertClaudeDirectorPresentFatal — empty stdout (presence-only probe)', () => {
  test('calls recordStartupError exactly once with class "dep-probe" on empty stdout', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 0, stdout: '   ', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe')
  })

  test('calls exit exactly once with non-zero code on empty stdout', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 0, stdout: '', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).not.toBe(0)
  })

  test('logged message identifies empty-output / parse failure', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 0, stdout: '', stderr: '' }),
    })
    catchExit(() => assertClaudeDirectorPresentFatal(deps))
    expect(recordedErrors[0].message).toMatch(/empty|output|version|corrupt/i)
  })
})

// ===========================================================================
// SECTION 3: assertClaudeDirectorStateDbSameUserFatal (CE2)
// ===========================================================================

describe('assertClaudeDirectorStateDbSameUserFatal — happy path (UIDs match)', () => {
  test('does not call recordStartupError when UIDs match', () => {
    const deps = makeDeps()  // geteuid=1000, statSync uid=1000
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(recordedErrors).toHaveLength(0)
  })

  test('does not call exit when UIDs match', () => {
    const deps = makeDeps()
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(exitCodes).toHaveLength(0)
  })
})

describe('assertClaudeDirectorStateDbSameUserFatal — ENOENT pass (no state.db)', () => {
  test('does not call recordStartupError when state.db is absent (ENOENT)', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      statSync: () => { throw enoentErr },
    })
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(recordedErrors).toHaveLength(0)
  })

  test('does not call exit when state.db is absent (ENOENT)', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      statSync: () => { throw enoentErr },
    })
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(exitCodes).toHaveLength(0)
  })
})

describe('assertClaudeDirectorStateDbSameUserFatal — UID mismatch', () => {
  test('calls recordStartupError with class "dep-probe-same-user" on mismatch', () => {
    const deps = makeDeps({
      statSync: () => ({ uid: 2000 }),
      geteuid: () => 1000,
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe-same-user')
  })

  test('calls exit exactly once with non-zero code on UID mismatch', () => {
    const deps = makeDeps({
      statSync: () => ({ uid: 2000 }),
      geteuid: () => 1000,
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).not.toBe(0)
  })

  test('logged message names both UIDs', () => {
    const deps = makeDeps({
      statSync: () => ({ uid: 2000 }),
      geteuid: () => 1000,
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    const msg = recordedErrors[0].message
    expect(msg).toContain('2000')
    expect(msg).toContain('1000')
  })

  test('logged message references the state.db path', () => {
    const deps = makeDeps({
      statSync: () => ({ uid: 2000 }),
      geteuid: () => 1000,
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    const msg = recordedErrors[0].message
    expect(msg).toContain('.claude-director')
    expect(msg).toContain('state.db')
  })
})

describe('assertClaudeDirectorStateDbSameUserFatal — non-ENOENT stat error (EACCES)', () => {
  test('calls recordStartupError with class "dep-probe-same-user" on EACCES', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const deps = makeDeps({
      statSync: () => { throw eaccesErr },
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe-same-user')
  })

  test('calls exit exactly once with non-zero code on EACCES', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const deps = makeDeps({
      statSync: () => { throw eaccesErr },
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).not.toBe(0)
  })

  test('logged message identifies the OS error code (EACCES)', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const deps = makeDeps({
      statSync: () => { throw eaccesErr },
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(recordedErrors[0].message).toContain('EACCES')
  })

  test('logged message identifies the stat failure context', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const deps = makeDeps({
      statSync: () => { throw eaccesErr },
    })
    catchExit(() => assertClaudeDirectorStateDbSameUserFatal(deps))
    expect(recordedErrors[0].message).toMatch(/stat|Failed to stat/i)
  })
})

describe('assertClaudeDirectorStateDbSameUserFatal — platform fallback (no UID available)', () => {
  test('does NOT call exit when geteuid returns undefined and userInfo uid is -1', () => {
    const deps = makeDeps({
      geteuid: () => undefined,
      userInfo: () => ({ uid: -1 }),
    })
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(exitCodes).toHaveLength(0)
  })

  test('records T-A entry with class "dep-probe-same-user-unenforced" on platform fallback', () => {
    const deps = makeDeps({
      geteuid: () => undefined,
      userInfo: () => ({ uid: -1 }),
    })
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe-same-user-unenforced')
  })

  test('platform fallback with geteuid undefined and userInfo throwing also unenforced', () => {
    const deps = makeDeps({
      geteuid: () => undefined,
      userInfo: () => { throw new Error('userInfo not available') },
    })
    assertClaudeDirectorStateDbSameUserFatal(deps)
    expect(exitCodes).toHaveLength(0)
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe-same-user-unenforced')
  })
})

// ===========================================================================
// SECTION 4: checkPidConflict NOT called on probe/same-user failure
// ===========================================================================

describe('checkPidConflict NOT called when probe fails', () => {
  test('checkPidConflict is not called when version probe fails (non-zero exit)', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(checkPidConflictCalls).toHaveLength(0)
  })

  test('checkPidConflict is not called when probe throws ENOENT', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: null, stdout: '', stderr: '', throwError: enoentErr }),
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(checkPidConflictCalls).toHaveLength(0)
  })

  test('checkPidConflict is not called when probe returns empty stdout', () => {
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 0, stdout: '', stderr: '' }),
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(checkPidConflictCalls).toHaveLength(0)
  })
})

describe('checkPidConflict NOT called when same-user check fails', () => {
  test('checkPidConflict is not called when UIDs mismatch', () => {
    const deps = makeDeps({
      statSync: () => ({ uid: 9999 }),
      geteuid: () => 1000,
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(checkPidConflictCalls).toHaveLength(0)
  })

  test('checkPidConflict is not called when stat throws EACCES', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const deps = makeDeps({
      statSync: () => { throw eaccesErr },
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(checkPidConflictCalls).toHaveLength(0)
  })
})

describe('same-user check NOT called when probe fails (via runStartupGates)', () => {
  test('recordStartupError is called exactly once (dep-probe only) when probe fails', () => {
    // If same-user ran too, we'd see two entries (dep-probe + dep-probe-same-user)
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
      })
    )
    expect(recordedErrors).toHaveLength(1)
    expect(recordedErrors[0].classLabel).toBe('dep-probe')
  })
})

// ===========================================================================
// SECTION 5: Ordering via runStartupGates
// ===========================================================================

describe('runStartupGates — ordering (all gates succeed)', () => {
  test('startupTrace shows dep-probe before dep-probe-same-user before checkPidConflict', () => {
    const trace: string[] = []
    const deps = makeDeps({ startupTrace: trace })
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test.pid',
      startupTrace: trace,
    })
    expect(trace).toEqual(['dep-probe', 'dep-probe-same-user', 'checkPidConflict'])
  })

  test('probe entry appears before same-user entry in trace', () => {
    const trace: string[] = []
    const deps = makeDeps({ startupTrace: trace })
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test.pid',
      startupTrace: trace,
    })
    const probeIdx = trace.indexOf('dep-probe')
    const sameUserIdx = trace.indexOf('dep-probe-same-user')
    expect(probeIdx).toBeGreaterThanOrEqual(0)
    expect(sameUserIdx).toBeGreaterThan(probeIdx)
  })

  test('same-user entry appears before checkPidConflict in trace', () => {
    const trace: string[] = []
    const deps = makeDeps({ startupTrace: trace })
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test.pid',
      startupTrace: trace,
    })
    const sameUserIdx = trace.indexOf('dep-probe-same-user')
    const pidIdx = trace.indexOf('checkPidConflict')
    expect(pidIdx).toBeGreaterThan(sameUserIdx)
  })

  test('checkPidConflict is called with the provided pidFile', () => {
    const deps = makeDeps()
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test-ordering.pid',
    })
    expect(checkPidConflictCalls).toEqual(['/tmp/test-ordering.pid'])
  })
})

describe('runStartupGates — probe failure short-circuits both gates', () => {
  test('trace is empty when probe fails (neither same-user nor checkPidConflict ran)', () => {
    const trace: string[] = []
    const deps = makeDeps({
      exec: makeStubExec({ exitCode: 1, stdout: '', stderr: '' }),
      startupTrace: trace,
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
        startupTrace: trace,
      })
    )
    // dep-probe entry is pushed AFTER assertClaudeDirectorPresentFatal returns,
    // so if it exits early the trace is empty
    expect(trace).toHaveLength(0)
    expect(checkPidConflictCalls).toHaveLength(0)
  })
})

describe('runStartupGates — same-user failure short-circuits checkPidConflict', () => {
  test('trace has dep-probe but not checkPidConflict when same-user fails', () => {
    const trace: string[] = []
    const deps = makeDeps({
      statSync: () => ({ uid: 9999 }),
      geteuid: () => 1000,
      startupTrace: trace,
    })
    catchExit(() =>
      runStartupGates({
        ...deps,
        checkPidConflict: deps.checkPidConflict!,
        pidFile: '/tmp/test.pid',
        startupTrace: trace,
      })
    )
    expect(trace).toContain('dep-probe')
    expect(trace).not.toContain('checkPidConflict')
    expect(checkPidConflictCalls).toHaveLength(0)
  })
})

// ===========================================================================
// SECTION 6: Platform fallback — checkPidConflict IS called
// ===========================================================================

describe('platform fallback — startup continues and checkPidConflict is called', () => {
  test('checkPidConflict IS called when platform fallback triggers (via runStartupGates)', () => {
    const deps = makeDeps({
      geteuid: () => undefined,
      userInfo: () => ({ uid: -1 }),
    })
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test.pid',
    })
    expect(checkPidConflictCalls).toHaveLength(1)
  })

  test('unenforced T-A entry is recorded AND exit is not called on platform fallback', () => {
    const deps = makeDeps({
      geteuid: () => undefined,
      userInfo: () => ({ uid: -1 }),
    })
    runStartupGates({
      ...deps,
      checkPidConflict: deps.checkPidConflict!,
      pidFile: '/tmp/test.pid',
    })
    expect(exitCodes).toHaveLength(0)
    const unenforced = recordedErrors.find(e => e.classLabel === 'dep-probe-same-user-unenforced')
    expect(unenforced).toBeDefined()
  })
})
