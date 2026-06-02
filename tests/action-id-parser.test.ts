/**
 * action-id-parser.test.ts — SR-2.2 invariant tests for the
 * permission action_id encoder/decoder.
 *
 * Covers:
 *   - Standard cases (uppercase channel, single underscore segment).
 *   - claude_instance_ids containing additional underscores.
 *   - Malformed inputs (wrong prefix, non-UUID trailing token, missing
 *     parts) return null rather than throwing.
 *   - Round-trip: encode → parse yields the same components.
 *   - UUID-specific edge cases (backward-compat null, encoder rejection,
 *     UUID round-trip, underscore-bearing instance id with UUID).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import {
  encodePermissionActionId,
  parsePermissionActionId,
  PERMISSION_ACTION_ID_RE,
} from '../src/permission-action-id.ts'

const UUID0 = '550e8400-e29b-41d4-a716-446655440000'
const UUID1 = '550e8400-e29b-41d4-a716-446655440001'
const UUID2 = '550e8400-e29b-41d4-a716-446655440002'

describe('parsePermissionActionId — standard cases', () => {
  test('allow + simple channel id', () => {
    const r = parsePermissionActionId(`perm_allow_cscb_C012345_${UUID0}`)
    expect(r).toEqual({ decision: 'allow', claudeInstanceId: 'cscb_C012345', requestToken: UUID0 })
  })

  test('deny + simple channel id', () => {
    const r = parsePermissionActionId(`perm_deny_cscb_C012345_${UUID1}`)
    expect(r).toEqual({ decision: 'deny', claudeInstanceId: 'cscb_C012345', requestToken: UUID1 })
  })

  test('allow + uppercase channel id', () => {
    const r = parsePermissionActionId(`perm_allow_cscb_CXYZ_${UUID0}`)
    expect(r?.requestToken).toBe(UUID0)
  })
})

describe('parsePermissionActionId — instance_ids containing underscores', () => {
  test('multi-segment claude_instance_id keeps the trailing UUID boundary', () => {
    const r = parsePermissionActionId(`perm_allow_cscb_C_FOO_BAR_BAZ_${UUID0}`)
    // UUID tail is unambiguous — no underscores in UUIDs — so greedy match
    // correctly sets instance_id to everything before the UUID.
    expect(r).toEqual({ decision: 'allow', claudeInstanceId: 'cscb_C_FOO_BAR_BAZ', requestToken: UUID0 })
  })

  test('instance_id with many trailing letters but only one trailing UUID segment', () => {
    const r = parsePermissionActionId(`perm_deny_cscb_a_b_c_d_e_f_g_${UUID0}`)
    expect(r?.claudeInstanceId).toBe('cscb_a_b_c_d_e_f_g')
    expect(r?.requestToken).toBe(UUID0)
  })

  test('instance_id whose body contains digit-bearing segments', () => {
    // Even though the body contains digits, the UUID tail is unambiguous.
    const r = parsePermissionActionId(`perm_allow_cscb_42_C012345_${UUID0}`)
    expect(r?.claudeInstanceId).toBe('cscb_42_C012345')
    expect(r?.requestToken).toBe(UUID0)
  })
})

describe('parsePermissionActionId — malformed inputs', () => {
  test('returns null for wrong prefix', () => {
    expect(parsePermissionActionId(`foo_allow_cscb_C1_${UUID0}`)).toBeNull()
  })

  test('returns null when decision is unknown', () => {
    expect(parsePermissionActionId(`perm_yes_cscb_C1_${UUID0}`)).toBeNull()
  })

  test('returns null when instance_id missing cscb_ prefix', () => {
    expect(parsePermissionActionId(`perm_allow_other_C1_${UUID0}`)).toBeNull()
  })

  test('returns null when trailing token is not a UUID', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_abc')).toBeNull()
  })

  test('returns null when input is empty', () => {
    expect(parsePermissionActionId('')).toBeNull()
  })

  test('returns null when the trailing token is missing', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_')).toBeNull()
  })

  test('returns null when the input has trailing garbage after UUID', () => {
    expect(parsePermissionActionId(`perm_allow_cscb_C1_${UUID0}_extra`)).toBeNull()
  })

  test('returns null for naive split-style attack: stale "perm_…" mid-instance', () => {
    // A claude_instance_id literally containing "perm_allow_" earlier in the
    // string. The UUID tail is the only valid anchor — the regex won't be
    // fooled by the embedded 'perm_'.
    const malicious = `perm_allow_cscb_perm_allow_xyz_${UUID0}`
    expect(parsePermissionActionId(malicious)?.claudeInstanceId).toBe('cscb_perm_allow_xyz')
    expect(parsePermissionActionId(malicious)?.requestToken).toBe(UUID0)
  })
})

describe('encodePermissionActionId', () => {
  test('round-trips via parse', () => {
    const encoded = encodePermissionActionId('deny', 'cscb_C012345', UUID0)
    expect(encoded).toBe(`perm_deny_cscb_C012345_${UUID0}`)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'deny',
      claudeInstanceId: 'cscb_C012345',
      requestToken: UUID0,
    })
  })

  test('round-trips an underscore-bearing instance id', () => {
    const encoded = encodePermissionActionId('allow', 'cscb_a_b_c', UUID2)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'allow',
      claudeInstanceId: 'cscb_a_b_c',
      requestToken: UUID2,
    })
  })

  test('rejects invalid decisions', () => {
    expect(() => encodePermissionActionId('maybe' as never, 'cscb_C1', UUID0)).toThrow(/invalid decision/)
  })

  test('rejects claude_instance_id that does not start with cscb_', () => {
    expect(() => encodePermissionActionId('allow', 'foo_C1', UUID0)).toThrow(/must start with 'cscb_'/)
  })

  test('rejects bare "cscb_" prefix', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_', UUID0)).toThrow(/must start with 'cscb_'/)
  })
})

describe('PERMISSION_ACTION_ID_RE — invariant', () => {
  test('exposed regex matches the SR-2.2 anchored UUID shape', () => {
    expect(PERMISSION_ACTION_ID_RE.source).toContain('^perm_')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('(allow|deny)')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('cscb_')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('[0-9a-f]{8}')
  })
})

describe('UUID-specific edge cases', () => {
  test('backward-compat null: old numeric format returns null (allow)', () => {
    expect(parsePermissionActionId('perm_allow_cscb_C1_42')).toBeNull()
  })

  test('backward-compat null: old numeric format returns null (deny)', () => {
    expect(parsePermissionActionId('perm_deny_cscb_C012345_7')).toBeNull()
  })

  test('encoder rejects non-UUID requestToken: not-a-uuid', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', 'not-a-uuid')).toThrow()
  })

  test('encoder rejects non-UUID requestToken: plain digits', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', '12345')).toThrow()
  })

  test('encoder rejects non-UUID requestToken: empty string', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_C1', '')).toThrow()
  })

  test('UUID round-trip preserves requestToken string', () => {
    const token = UUID0
    const encoded = encodePermissionActionId('deny', 'cscb_C012345', token)
    const parsed = parsePermissionActionId(encoded)
    expect(parsed?.requestToken).toBe(token)
  })

  test('UUID with underscore-bearing instance id round-trips both fields', () => {
    const token = '00000000-0000-0000-0000-000000000001'
    const encoded = encodePermissionActionId('allow', 'cscb_a_b_c', token)
    const parsed = parsePermissionActionId(encoded)
    expect(parsed?.claudeInstanceId).toBe('cscb_a_b_c')
    expect(parsed?.requestToken).toBe(token)
  })
})
