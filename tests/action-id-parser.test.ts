/**
 * action-id-parser.test.ts — SR-2.2 / SR-8.4 invariant tests for the
 * permission action_id encoder/decoder under the request_token wire.
 *
 * Covers:
 *   - Round-trip for representative `(decision, claude_instance_id, request_token)`
 *     triples, including underscore-bearing instance ids.
 *   - Anchored decoder rejects trailing / leading garbage.
 *   - Decoder yields null (not throw) on malformed inputs.
 *   - Regex anchors on outer UUIDv4 shape only — the token's bytes are
 *     opaque to CSCB.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import {
  encodePermissionActionId,
  parsePermissionActionId,
  PERMISSION_ACTION_ID_RE,
} from '../src/permission-action-id.ts'

// ---------------------------------------------------------------------------
// Shared fixtures — no inline magic strings (SR-8.1)
// ---------------------------------------------------------------------------

/** A handful of representative UUIDv4-shaped tokens. The bytes are opaque to CSCB. */
const SAMPLE_TOKENS: ReadonlyArray<string> = [
  '00000000-0000-4000-8000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'deadbeef-cafe-4bad-9bad-feedfacef00d',
  'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
]

const INSTANCE_SIMPLE = 'cscb_C012345'
const INSTANCE_UNDERSCORED = 'cscb_C_FOO_BAR_BAZ'
const INSTANCE_LETTERS = 'cscb_a_b_c_d_e_f_g'

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — round-trip via encode', () => {
  test('allow + simple channel id round-trips for every sample token', () => {
    for (const token of SAMPLE_TOKENS) {
      const encoded = encodePermissionActionId('allow', INSTANCE_SIMPLE, token)
      expect(parsePermissionActionId(encoded)).toEqual({
        decision: 'allow',
        claudeInstanceId: INSTANCE_SIMPLE,
        requestToken: token,
      })
    }
  })

  test('deny + simple channel id round-trips', () => {
    const token = SAMPLE_TOKENS[0]
    const encoded = encodePermissionActionId('deny', INSTANCE_SIMPLE, token)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'deny',
      claudeInstanceId: INSTANCE_SIMPLE,
      requestToken: token,
    })
  })

  test('round-trips an underscore-bearing instance id (cscb_C_FOO_BAR_BAZ)', () => {
    const token = SAMPLE_TOKENS[1]
    const encoded = encodePermissionActionId('allow', INSTANCE_UNDERSCORED, token)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'allow',
      claudeInstanceId: INSTANCE_UNDERSCORED,
      requestToken: token,
    })
  })

  test('round-trips an instance id with many underscore-separated letters', () => {
    const token = SAMPLE_TOKENS[2]
    const encoded = encodePermissionActionId('deny', INSTANCE_LETTERS, token)
    expect(parsePermissionActionId(encoded)).toEqual({
      decision: 'deny',
      claudeInstanceId: INSTANCE_LETTERS,
      requestToken: token,
    })
  })
})

// ---------------------------------------------------------------------------
// Decoder anchoring
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — anchored decoder rejects garbage', () => {
  const token = SAMPLE_TOKENS[3]
  const valid = `perm_allow_${INSTANCE_SIMPLE}_${token}`

  test('rejects trailing garbage after token', () => {
    expect(parsePermissionActionId(`${valid}_extra`)).toBeNull()
    expect(parsePermissionActionId(`${valid}X`)).toBeNull()
  })

  test('rejects leading garbage before perm_', () => {
    expect(parsePermissionActionId(`X${valid}`)).toBeNull()
    expect(parsePermissionActionId(`leading_${valid}`)).toBeNull()
  })

  test('rejects whitespace padding', () => {
    expect(parsePermissionActionId(` ${valid}`)).toBeNull()
    expect(parsePermissionActionId(`${valid} `)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Malformed inputs — null sentinel, never throw
// ---------------------------------------------------------------------------

describe('parsePermissionActionId — malformed inputs return null (do not throw)', () => {
  const token = SAMPLE_TOKENS[0]

  test('wrong prefix returns null', () => {
    expect(parsePermissionActionId(`foo_allow_${INSTANCE_SIMPLE}_${token}`)).toBeNull()
  })

  test('unknown decision verb returns null', () => {
    expect(parsePermissionActionId(`perm_maybe_${INSTANCE_SIMPLE}_${token}`)).toBeNull()
    expect(parsePermissionActionId(`perm_yes_${INSTANCE_SIMPLE}_${token}`)).toBeNull()
  })

  test('instance id missing cscb_ prefix returns null', () => {
    expect(parsePermissionActionId(`perm_allow_other_C1_${token}`)).toBeNull()
  })

  test('non-UUID trailing segment returns null', () => {
    // numeric (old shape) is no longer valid
    expect(parsePermissionActionId(`perm_allow_${INSTANCE_SIMPLE}_42`)).toBeNull()
    // wrong number of hyphens
    expect(parsePermissionActionId(`perm_allow_${INSTANCE_SIMPLE}_abc-def`)).toBeNull()
    // looks UUID-ish but wrong segment widths
    expect(parsePermissionActionId(`perm_allow_${INSTANCE_SIMPLE}_0000-0000-4000-8000-000000000000`)).toBeNull()
    // uppercase hex (regex is lowercase-only — UUIDv4 wire shape)
    expect(parsePermissionActionId(`perm_allow_${INSTANCE_SIMPLE}_AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`)).toBeNull()
  })

  test('empty trailing token returns null', () => {
    expect(parsePermissionActionId(`perm_allow_${INSTANCE_SIMPLE}_`)).toBeNull()
  })

  test('empty input returns null', () => {
    expect(parsePermissionActionId('')).toBeNull()
  })

  test('returns null and does NOT throw on adversarial inputs', () => {
    const adversarial = [
      'perm_',
      'perm_allow_',
      'perm_allow_cscb_',
      // Trailing UUID present but with no instance id after `cscb_`
      `perm_allow_cscb_${token}`,
      // Two UUID-looking trailing segments — middle would have to land inside instance id
      // but the second one fails its own length anchors.
      `perm_allow_cscb_C1_not-${token}`,
    ]
    for (const s of adversarial) {
      expect(() => parsePermissionActionId(s)).not.toThrow()
      expect(parsePermissionActionId(s)).toBeNull()
    }
  })

  test('embedded "perm_…" mid-instance still parses — the trailing-UUID anchor wins', () => {
    // A `claude_instance_id` that literally contains `perm_allow_` earlier in
    // its body still round-trips: the regex's rightmost UUID-shaped boundary
    // is the only thing fixing the instance/token split.
    const embedded = `perm_allow_cscb_perm_allow_xyz_${token}`
    expect(parsePermissionActionId(embedded)).toEqual({
      decision: 'allow',
      claudeInstanceId: 'cscb_perm_allow_xyz',
      requestToken: token,
    })
  })
})

// ---------------------------------------------------------------------------
// Encoder argument validation
// ---------------------------------------------------------------------------

describe('encodePermissionActionId — argument validation', () => {
  const token = SAMPLE_TOKENS[0]

  test('rejects invalid decisions', () => {
    expect(() => encodePermissionActionId('maybe' as never, INSTANCE_SIMPLE, token)).toThrow(/invalid decision/)
  })

  test('rejects claude_instance_id that does not start with cscb_', () => {
    expect(() => encodePermissionActionId('allow', 'foo_C1', token)).toThrow(/must start with 'cscb_'/)
  })

  test('rejects bare "cscb_" prefix', () => {
    expect(() => encodePermissionActionId('allow', 'cscb_', token)).toThrow(/must start with 'cscb_'/)
  })

  test('rejects empty request_token (the only token-side validation)', () => {
    expect(() => encodePermissionActionId('allow', INSTANCE_SIMPLE, '')).toThrow(/non-empty string/)
  })

  test('accepts opaque token bytes that are NOT UUIDv4 — encoder does not validate token shape', () => {
    // SR-1.3: CSCB treats the token as opaque. The encoder does not parse
    // or validate the bytes — only the regex enforces outer UUIDv4 shape
    // at decode time, and only to fix the rightmost capture boundary.
    expect(() => encodePermissionActionId('allow', INSTANCE_SIMPLE, 'not-a-uuid')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// PERMISSION_ACTION_ID_RE — invariant
// ---------------------------------------------------------------------------

describe('PERMISSION_ACTION_ID_RE — invariant', () => {
  test('exposed regex matches the SR-2.2 anchored shape with UUIDv4 trailing group', () => {
    expect(PERMISSION_ACTION_ID_RE.source.startsWith('^perm_')).toBe(true)
    expect(PERMISSION_ACTION_ID_RE.source).toContain('(allow|deny)')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('cscb_')
    expect(PERMISSION_ACTION_ID_RE.source).toContain('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    expect(PERMISSION_ACTION_ID_RE.source.endsWith('$')).toBe(true)
  })
})
