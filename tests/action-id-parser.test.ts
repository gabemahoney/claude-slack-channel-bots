import { describe, test, expect } from 'bun:test'
import { parsePermissionActionId } from '../src/permission-action-id.ts'

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — happy path', () => {
  test('allow with simple claudeInstanceId', () => {
    const result = parsePermissionActionId('perm_allow_cscb_C12345_42')
    expect(result).toEqual({
      ok: true,
      decision: 'allow',
      claudeInstanceId: 'cscb_C12345',
      requestId: '42',
    })
  })

  test('deny with simple claudeInstanceId', () => {
    const result = parsePermissionActionId('perm_deny_cscb_C12345_42')
    expect(result).toEqual({
      ok: true,
      decision: 'deny',
      claudeInstanceId: 'cscb_C12345',
      requestId: '42',
    })
  })

  test('claudeInstanceId with underscores', () => {
    const result = parsePermissionActionId('perm_deny_cscb_chan_with_under_scores_99')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.claudeInstanceId).toBe('cscb_chan_with_under_scores')
    expect(result.requestId).toBe('99')
    expect(result.decision).toBe('deny')
  })

  test('bigint round-trip: requestId > Number.MAX_SAFE_INTEGER is preserved exactly', () => {
    const BIG = '9007199254740993' // 2^53 + 1, loses precision through Number()
    const result = parsePermissionActionId(`perm_allow_cscb_C1_${BIG}`)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.requestId).toBe(BIG)
    // Verify the string value would lose precision if coerced — confirms the test catches a bug
    expect(Number(BIG).toString()).not.toBe(BIG)
  })

  test('requestId is returned as a string, not a number', () => {
    const result = parsePermissionActionId('perm_allow_cscb_C1_0')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(typeof result.requestId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// decision is strictly 'allow' or 'deny'
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — decision values', () => {
  test('decision is allow (not block, ignore, etc.)', () => {
    const result = parsePermissionActionId('perm_allow_cscb_X_1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.decision).toBe('allow')
  })

  test('decision is deny', () => {
    const result = parsePermissionActionId('perm_deny_cscb_X_1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.decision).toBe('deny')
  })

  test('block is not a valid decision — not-permission-action (no perm_ prefix)', () => {
    // 'block' doesn't start with perm_ so it's not-permission-action
    const result = parsePermissionActionId('perm_block_cscb_X_1')
    expect(result.ok).toBe(false)
  })

  test('ignore is not a valid decision', () => {
    const result = parsePermissionActionId('perm_ignore_cscb_X_1')
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Not a perm action (strings that don't start with 'perm_')
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — not-permission-action', () => {
  test('empty string', () => {
    const result = parsePermissionActionId('')
    expect(result).toEqual({ ok: false, reason: 'not-permission-action' })
  })

  test('arbitrary string', () => {
    const result = parsePermissionActionId('foo')
    expect(result).toEqual({ ok: false, reason: 'not-permission-action' })
  })

  test('perm_ prefix only', () => {
    // 'perm_' starts with perm_ so it goes to regex matching → malformed
    const result = parsePermissionActionId('perm_')
    if (!result.ok) expect(result.reason).toBe('malformed')
    else throw new Error('expected ok: false')
  })

  test('wrong decision word (allowed instead of allow)', () => {
    const result = parsePermissionActionId('perm_allowed_cscb_x_1')
    expect(result.ok).toBe(false)
  })

  test('no cscb_ prefix on instanceId', () => {
    const result = parsePermissionActionId('perm_allow_foo_1')
    if (!result.ok) expect(result.reason).toBe('malformed')
    else throw new Error('expected ok: false')
  })
})

// ---------------------------------------------------------------------------
// Malformed (starts with perm_ but fails anchored regex)
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — malformed', () => {
  test('missing requestId digits (trailing underscore only)', () => {
    const result = parsePermissionActionId('perm_allow_cscb_X_')
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  test('non-digit characters in requestId', () => {
    const result = parsePermissionActionId('perm_allow_cscb_X_abc')
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })
})

// ---------------------------------------------------------------------------
// Anchored regex — leading/trailing noise must fail
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — anchored regex', () => {
  test('leading whitespace → not-permission-action (no perm_ prefix after space)', () => {
    const result = parsePermissionActionId(' perm_allow_cscb_X_1')
    if (!result.ok) expect(result.reason).toBe('not-permission-action')
    else throw new Error('expected ok: false')
  })

  test('trailing whitespace → malformed (starts with perm_ but regex fails)', () => {
    const result = parsePermissionActionId('perm_allow_cscb_X_1 ')
    if (!result.ok) expect(result.reason).toBe('malformed')
    else throw new Error('expected ok: false')
  })

  test('leading character before perm_ → not-permission-action', () => {
    const result = parsePermissionActionId('xperm_allow_cscb_X_1')
    if (!result.ok) expect(result.reason).toBe('not-permission-action')
    else throw new Error('expected ok: false')
  })

  test('trailing character after requestId → malformed', () => {
    const result = parsePermissionActionId('perm_allow_cscb_X_1y')
    if (!result.ok) expect(result.reason).toBe('malformed')
    else throw new Error('expected ok: false')
  })
})
