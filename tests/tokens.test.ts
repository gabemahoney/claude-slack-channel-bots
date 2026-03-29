/**
 * tokens.test.ts — Tests for loadTokens() environment variable loading.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadTokens } from '../src/tokens.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore process.env around each test for isolation. */
let savedEnv: NodeJS.ProcessEnv

/** Capture array for console.error calls. */
let errorMessages: string[]

/** Capture array for process.exit calls (code passed). */
let exitCodes: number[]

beforeEach(() => {
  savedEnv = { ...process.env }
  // Remove Slack token vars so each test starts from a clean slate
  delete process.env['SLACK_BOT_TOKEN']
  delete process.env['SLACK_APP_TOKEN']

  errorMessages = []
  exitCodes = []

  // Stub console.error to avoid noisy output and capture messages
  jest_console_error = console.error
  console.error = (...args: unknown[]) => {
    errorMessages.push(args.map(String).join(' '))
  }

  // Stub process.exit so tests do not terminate the Bun process
  jest_process_exit = process.exit
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0)
    throw new ExitError(code ?? 0)
  }) as typeof process.exit
})

afterEach(() => {
  // Restore originals
  process.env = savedEnv as NodeJS.ProcessEnv
  console.error = jest_console_error
  process.exit = jest_process_exit
})

// Storage for the originals (module-scoped, replaced in beforeEach)
let jest_console_error: typeof console.error
let jest_process_exit: typeof process.exit

/** Sentinel error thrown by our process.exit stub so we can catch it. */
class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

/** Helper: run loadTokens() and catch ExitError, returning it or null. */
function runLoadTokens(): { result: ReturnType<typeof loadTokens> | null; exitError: ExitError | null } {
  try {
    const result = loadTokens()
    return { result, exitError: null }
  } catch (e) {
    if (e instanceof ExitError) {
      return { result: null, exitError: e }
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadTokens — happy path', () => {
  test('returns botToken when both tokens have correct prefixes', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid-bot-token'
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid-app-token'

    const { result } = runLoadTokens()

    expect(result!.botToken).toBe('xoxb-valid-bot-token')
  })

  test('returns appToken when both tokens have correct prefixes', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid-bot-token'
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid-app-token'

    const { result } = runLoadTokens()

    expect(result!.appToken).toBe('xapp-valid-app-token')
  })

  test('does not call process.exit when both tokens are valid', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid-bot-token'
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid-app-token'

    runLoadTokens()

    expect(exitCodes).toHaveLength(0)
  })

  test('returns the exact token strings provided', () => {
    const bot = 'xoxb-123-abc-XYZ'
    const app = 'xapp-456-def-QRS'
    process.env['SLACK_BOT_TOKEN'] = bot
    process.env['SLACK_APP_TOKEN'] = app

    const { result } = runLoadTokens()

    expect(result!.botToken).toBe(bot)
    expect(result!.appToken).toBe(app)
  })
})

// ---------------------------------------------------------------------------
// SLACK_BOT_TOKEN missing or invalid
// ---------------------------------------------------------------------------

describe('loadTokens — SLACK_BOT_TOKEN errors', () => {
  test('calls process.exit(1) when SLACK_BOT_TOKEN is not set', () => {
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid'

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })

  test('error message mentions SLACK_BOT_TOKEN when it is missing', () => {
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid'

    runLoadTokens()

    expect(errorMessages.some(m => m.includes('SLACK_BOT_TOKEN'))).toBe(true)
  })

  test('calls process.exit(1) when SLACK_BOT_TOKEN has wrong prefix', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxp-wrong-prefix'
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid'

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })

  test('error message mentions SLACK_BOT_TOKEN when prefix is wrong', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxp-wrong-prefix'
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid'

    runLoadTokens()

    expect(errorMessages.some(m => m.includes('SLACK_BOT_TOKEN'))).toBe(true)
  })

  test('treats empty string SLACK_BOT_TOKEN as missing — calls process.exit(1)', () => {
    process.env['SLACK_BOT_TOKEN'] = ''
    process.env['SLACK_APP_TOKEN'] = 'xapp-valid'

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SLACK_APP_TOKEN missing or invalid
// ---------------------------------------------------------------------------

describe('loadTokens — SLACK_APP_TOKEN errors', () => {
  test('calls process.exit(1) when SLACK_APP_TOKEN is not set', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid'

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })

  test('error message mentions SLACK_APP_TOKEN when it is missing', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid'

    runLoadTokens()

    expect(errorMessages.some(m => m.includes('SLACK_APP_TOKEN'))).toBe(true)
  })

  test('calls process.exit(1) when SLACK_APP_TOKEN has wrong prefix', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid'
    process.env['SLACK_APP_TOKEN'] = 'xoxb-wrong-prefix'

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })

  test('error message mentions SLACK_APP_TOKEN when prefix is wrong', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid'
    process.env['SLACK_APP_TOKEN'] = 'xoxb-wrong-prefix'

    runLoadTokens()

    expect(errorMessages.some(m => m.includes('SLACK_APP_TOKEN'))).toBe(true)
  })

  test('treats empty string SLACK_APP_TOKEN as missing — calls process.exit(1)', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-valid'
    process.env['SLACK_APP_TOKEN'] = ''

    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Both tokens missing
// ---------------------------------------------------------------------------

describe('loadTokens — both tokens missing', () => {
  test('calls process.exit(1) when both tokens are absent', () => {
    const { exitError } = runLoadTokens()

    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })
})
