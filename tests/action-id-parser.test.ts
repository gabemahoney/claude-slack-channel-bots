/**
 * action-id-parser.test.ts — SR-2.2 / SR-8.6 invariant tests for the
 * permission action_id encoder/decoder.
 *
 * Covers:
 *   - Standard cases (uppercase channel, single underscore segment).
 *   - claude_instance_ids containing additional underscores.
 *   - request_id widths from 1 digit through Number.MAX_SAFE_INTEGER.
 *   - Malformed inputs (wrong prefix, non-numeric request_id, missing
 *     parts) return null rather than throwing.
 *   - Round-trip: encode → parse yields the same components.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import {
  encodePermissionActionId,
  parsePermissionActionId,
  PERMISSION_ACTION_ID_RE,
} from '../src/permission-action-id.ts'

describe('parsePermissionActionId — standard cases', () => {
  test('allow + simple channel id', () => {
    const r = parsePermissionActionId('perm_allow_cscb_C012345_42')
    expect(r).toEqual({ decision: 'allow', claudeInstanceId: 'cscb_C012345', requestId: 42 })
  })

  test('deny + simple channel id', () => {
    const r = parsePermissionActionId('perm_deny_cscb_C012345_7')
    expect(r).toEqual({ decision: 'deny', claudeInstanceId: 'cscb_C012345', requestId: 7 })
  })

  test('single-digit request id', () => {
    const r = parsePermissionActionId('perm_allow_cscb_CXYZ_1')
    expect(r?.requestId).toBe(1)
  })
})

describe('parsePermissionActionId — instance_ids containing underscores', () => {
  test('multi-segment claude_instance_id keeps the trailing request_id boundary', () => {
    const r = parsePermissionActionId('perm_allow_cscb_C_FOO_BAR_BAZ_99')
    // The trailing `_99` boundary forces the instance_id to be `cscb_C_FOO_BAR_BAZ`.
    expect(r).toEqual({ decision: 'allow', claudeInstanceId: 'cscb_C_FOO_BAR_BAZ', requestId: 99 })
  })

  test('instance_id with many trailing letters but only one trailing numeric segment', () => {
    const r = parsePermissionActionId('perm_deny_cscb_a_b_c_d_e_f_g_1234')
    expect(r?.claudeInstanceId).toBe('cscb_a_b_c_d_e_f_g')
    expect(r?.requestId).toBe(1234)
  })

  test('instance_id whose body contains digit-bearing segments', () => {
    // Even though `42` is digits, the regex greedily consumes it as part of
    // the instance_id because it's not the trailing segment.
    const r = parsePermissionActionId('perm_allow_cscb_42_C012345_99')
    expect(r?.claudeInstanceId).toBe('cscb_42_C012345')
    expect(r?.requestId).toBe(99)
  })
})

describe('parsePermissionActionId — varying request_id widths', () => {
  test('two-digit request_id', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_42')?.requestId).toBe(42)
  })

  test('seven-digit request_id', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_1234567')?.requestId).toBe(1_234_567)
  })

  test('Number.MAX_SAFE_INTEGER round-trips losslessly', () => {
    const maxSafe = Number.MAX_SAFE_INTEGER // 9007199254740991
    const encoded = encodePermissionActionId('allow', 'cscb_CX', maxSafe)
    const parsed = parsePermissionActionId(encoded)
    expect(parsed?.requestId).toBe(maxSafe)
  })
})

describe('parsePermissionActionId — malformed inputs', () => {
  test('returns null for wrong prefix', () => {
    expect(parsePermissionActionId('foo_allow_cscb_C1_1')).toBeNull()
  })

  test('returns null when decision is unknown', () => {
    expect(parsePermissionActionId('perm_yes_cscb_C1_1')).toBeNull()
  })

  test('returns null when instance_id missing cscb_ prefix', () => {
    expect(parsePermissionActionId('perm_allow_other_C1_1')).toBeNull()
  })

  test('returns null when request_id is non-numeric', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_abc')).toBeNull()
  })

  test('returns null when input is empty', () => {
    expect(parsePermissionActionId('')).toBeNull()
  })

  test('returns null when trailing request_id is missing', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_')).toBeNull()
  })

  test('returns null when the input has trailing garbage', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_42_extra')).toBeNull()
  })

  test('returns null for naive split-style attack: stale "perm_…" mid-instance', () => {
    // A claude_instance_id literally containing "perm_allow_" earlier in the
    // string. The trailing-numeric anchor still constrains the request_id
    // to the rightmost digits — the regex won't be fooled by the embedded
    // 'perm_'.
    const malicious = 'perm_allow_cscb_perm_allow_xyz_99'
    expect(parsePermissionActionId(malicious)?.claudeInstanceId).toBe('cscb_perm_allow_xyz')
    expect(parsePermissionActionId(malicious)?.requestId).toBe(99)
  })
})

describe('encodePermissionActionId', () => {
  test('round-trips via parse', () => {
    const encoded = encodePermissionActionId('deny', 'cscb_C012345', 99)
    expect(encoded).toBe('perm_deny_cscb_C012345_99')
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'deny',
      claudeInstanceId: 'cscb_C012345',
      requestId: 99,
    })
  })

  test('round-trips an underscore-bearing instance id', () => {
    const encoded = encodePermissionActionId('allow', 'cscb_a_b_c', 7)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'allow',
      claudeInstanceId: 'cscb_a_b_c',
      requestId: 7,
    })
  })

  test('rejects invalid decisions', () => {
    expect(() => encodePermissionActionId('maybe' as never, 'cscb_C1', 1)).toThrow(/invalid decision/)
  })

  test('rejects claude_instance_id that does not start with cscb_', () => {
    expect(() => encodePermissionActionId('allow', 'foo_C1', 1)).toThrow(/must start with 'cscb_'/)
  })

  test('rejects bare "cscb_" prefix', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_', 1)).toThrow(/must start with 'cscb_'/)
  })

  test('rejects negative request_id', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', -1)).toThrow(/non-negative safe integer/)
  })

  test('rejects non-integer request_id', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', 1.5)).toThrow(/non-negative safe integer/)
  })

  test('rejects request_id above MAX_SAFE_INTEGER', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', Number.MAX_SAFE_INTEGER + 2)).toThrow(/non-negative safe integer/)
  })
})

describe('PERMISSION_ACTION_ID_RE — invariant', () => {
  test('exposed regex matches the SR-2.2 anchored shape', () => {
    expect(PERMISSION_ACTION_ID_RE.source).toContain('^perm_')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('(allow|deny)')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('cscb_')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('(\\d+)$')
  })
})
