/**
 * agent-director-logger.test.ts — Tests for the AD verbosity filter (b.brv).
 *
 * The agent-director Client emits per-poll `SubprocessClient: <verb> ok { ... }`
 * success dumps that flooded server.log. makeFilteredAdLogger() drops those
 * routine success dumps at default verbosity while always passing failures,
 * errors, warnings, and non-AD lines through. CSCB_AD_VERBOSE disables filtering.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import {
  makeFilteredAdLogger,
  AD_VERBOSE_ENV,
  type AdLogger,
} from '../src/agent-director-logger.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Captured {
  log: unknown[][]
  info: unknown[][]
  warn: unknown[][]
  error: unknown[][]
  logger: AdLogger
}

/** A base logger that records every call to each method. */
function makeCapturingLogger(): Captured {
  const log: unknown[][] = []
  const info: unknown[][] = []
  const warn: unknown[][] = []
  const error: unknown[][] = []
  return {
    log,
    info,
    warn,
    error,
    logger: {
      log: (...a: unknown[]) => { log.push(a) },
      info: (...a: unknown[]) => { info.push(a) },
      warn: (...a: unknown[]) => { warn.push(a) },
      error: (...a: unknown[]) => { error.push(a) },
    },
  }
}

/** Build an env with filtering active (verbose off) unless overridden. */
function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

const OK_DUMP = 'SubprocessClient: list ok'
const OK_PAYLOAD = { count: 3, elapsedMs: 12 }

// ---------------------------------------------------------------------------
// Routine success dumps are dropped at default verbosity
// ---------------------------------------------------------------------------

describe('makeFilteredAdLogger — routine success dumps dropped by default', () => {
  test.each([
    ['SubprocessClient: list ok'],
    ['SubprocessClient: status ok'],
    ['SubprocessClient: get ok'],
  ])('drops %s from log()', (msg) => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log(msg, OK_PAYLOAD)
    expect(cap.log).toHaveLength(0)
  })

  test('drops the ok dump from info() too', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.info(OK_DUMP, OK_PAYLOAD)
    expect(cap.info).toHaveLength(0)
  })

  test('drops the dump even when the ok marker is followed by trailing text', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log('SubprocessClient: list ok { full json blob elapsedMs: 9 }')
    expect(cap.log).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Failures, errors, and warnings always pass through
// ---------------------------------------------------------------------------

describe('makeFilteredAdLogger — non-routine records always pass', () => {
  test('warn() always passes through, even for a SubprocessClient message', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.warn('SubprocessClient: list ok', OK_PAYLOAD)
    // warn is never gated — forensic signal must survive.
    expect(cap.warn).toHaveLength(1)
  })

  test('error() always passes through', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.error('SubprocessClient: get error', new Error('boom'))
    expect(cap.error).toHaveLength(1)
  })

  test.each([
    ['SubprocessClient: list failed'],
    ['SubprocessClient: status error'],
  ])('log() passes failure line %s through (not an ok dump)', (msg) => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log(msg, { err: 'x' })
    expect(cap.log).toHaveLength(1)
  })

  test('log() passes a non-AD line through unchanged', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log('server started on port 4000')
    expect(cap.log).toHaveLength(1)
    expect(cap.log[0]).toEqual(['server started on port 4000'])
  })

  test('log() passes a message that merely contains "ok" but is not the AD dump', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log('health check ok')
    expect(cap.log).toHaveLength(1)
  })

  test('log() passes through when first arg is a non-string', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log({ msg: 'SubprocessClient: list ok' })
    expect(cap.log).toHaveLength(1)
  })

  test('the payload is forwarded verbatim for a passed-through log line', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log('SubprocessClient: list failed', OK_PAYLOAD)
    expect(cap.log[0]).toEqual(['SubprocessClient: list failed', OK_PAYLOAD])
  })
})

// ---------------------------------------------------------------------------
// CSCB_AD_VERBOSE disables filtering
// ---------------------------------------------------------------------------

describe('makeFilteredAdLogger — CSCB_AD_VERBOSE disables filtering', () => {
  test.each([['1'], ['true'], ['yes'], ['on'], ['TRUE'], ['On'], [' 1 ']])(
    'verbose value %p returns the base logger unwrapped (ok dumps pass)',
    (val) => {
      const cap = makeCapturingLogger()
      const filtered = makeFilteredAdLogger(cap.logger, makeEnv({ [AD_VERBOSE_ENV]: val }))
      // When verbose, the exact same object is returned unwrapped.
      expect(filtered).toBe(cap.logger)
      filtered.log(OK_DUMP, OK_PAYLOAD)
      expect(cap.log).toHaveLength(1)
    },
  )

  test.each([['0'], ['false'], ['no'], ['off'], [''], ['maybe']])(
    'non-truthy value %p leaves filtering active (ok dumps dropped)',
    (val) => {
      const cap = makeCapturingLogger()
      const filtered = makeFilteredAdLogger(cap.logger, makeEnv({ [AD_VERBOSE_ENV]: val }))
      expect(filtered).not.toBe(cap.logger)
      filtered.log(OK_DUMP, OK_PAYLOAD)
      expect(cap.log).toHaveLength(0)
    },
  )

  test('unset CSCB_AD_VERBOSE leaves filtering active', () => {
    const cap = makeCapturingLogger()
    const filtered = makeFilteredAdLogger(cap.logger, makeEnv())
    filtered.log(OK_DUMP, OK_PAYLOAD)
    expect(cap.log).toHaveLength(0)
  })
})
