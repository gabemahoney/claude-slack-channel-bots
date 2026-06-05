/**
 * block-action-received.test.ts — SR-V-2.9 unit tests for
 * `emitBlockActionReceived` in src/permission-click-handler.ts. The helper
 * is the diagnostically critical surface for "I clicked Allow and nothing
 * happened" — every inbound `block_actions` action_id produces one event
 * regardless of decode outcome.
 *
 * server.ts has module-load side effects (HTTP listener, Socket Mode), so
 * we test the extracted helper directly rather than importing server.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { emitBlockActionReceived } from '../src/permission-click-handler.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import type { TrailEventBase } from '../src/permission-trail.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTANCE_C = 'cscb_demo_C0B1ZJJLJ9M'
const CHANNEL_CH = 'C0B1ZJJLJ9M'
const MSG_TS = '1780600244.439969'
const USER = 'U_OPERATOR'
const TOKEN_A = '11111111-1111-4111-8111-111111111111'

type CapturedTrailEvent = Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }

function makeCapture(): {
  emit: (partial: CapturedTrailEvent) => void
  events: CapturedTrailEvent[]
} {
  const events: CapturedTrailEvent[] = []
  return { events, emit: (p) => { events.push(p) } }
}

function makeContext(overrides?: { channel?: string; messageTs?: string; user?: string }) {
  return {
    channel: overrides?.channel ?? CHANNEL_CH,
    messageTs: overrides?.messageTs ?? MSG_TS,
    user: overrides?.user ?? USER,
  }
}

// ---------------------------------------------------------------------------
// Decode-success path
// ---------------------------------------------------------------------------

describe('emitBlockActionReceived — decode success', () => {
  test('well-formed allow action_id emits decoded fields, no parse_failure_reason', () => {
    const cap = makeCapture()
    const actionId = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
    emitBlockActionReceived(actionId, makeContext(), cap.emit)
    expect(cap.events).toHaveLength(1)
    const e = cap.events[0]!
    expect(e.event).toBe('cscb.block_action.received')
    expect(e.channel).toBe(CHANNEL_CH)
    expect(e.message_ts).toBe(MSG_TS)
    expect(e['user']).toBe(USER)
    expect(e['raw_action_id']).toBe(actionId)
    expect(e.claude_instance_id).toBe(INSTANCE_C)
    expect(e.request_token).toBe(TOKEN_A)
    expect(e['decision']).toBe('allow')
    expect('parse_failure_reason' in e).toBe(false)
  })

  test('well-formed deny action_id records decision="deny"', () => {
    const cap = makeCapture()
    const actionId = encodePermissionActionId('deny', INSTANCE_C, TOKEN_A)
    emitBlockActionReceived(actionId, makeContext(), cap.emit)
    expect(cap.events[0]!['decision']).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Decode-failure paths
// ---------------------------------------------------------------------------

describe('emitBlockActionReceived — decode failure', () => {
  test('action_id with no perm_ prefix → parse_failure_reason="foreign_action_id"', () => {
    const cap = makeCapture()
    emitBlockActionReceived('some_other_bot_action', makeContext(), cap.emit)
    expect(cap.events).toHaveLength(1)
    const e = cap.events[0]!
    expect(e['parse_failure_reason']).toBe('foreign_action_id')
    expect(e['raw_action_id']).toBe('some_other_bot_action')
    expect('claude_instance_id' in e).toBe(false)
    expect('request_token' in e).toBe(false)
    expect('decision' in e).toBe(false)
  })

  test('perm_allow_* but malformed body → parse_failure_reason="malformed_token"', () => {
    const cap = makeCapture()
    emitBlockActionReceived('perm_allow_not_cscb_garbage', makeContext(), cap.emit)
    expect(cap.events[0]!['parse_failure_reason']).toBe('malformed_token')
  })

  test('perm_deny_* but non-UUID trailing segment → parse_failure_reason="malformed_token"', () => {
    const cap = makeCapture()
    emitBlockActionReceived(`perm_deny_${INSTANCE_C}_42`, makeContext(), cap.emit)
    expect(cap.events[0]!['parse_failure_reason']).toBe('malformed_token')
  })
})

// ---------------------------------------------------------------------------
// Multi-action / envelope-passthrough
// ---------------------------------------------------------------------------

describe('emitBlockActionReceived — multi-action / context passthrough', () => {
  test('two distinct calls produce two distinct events', () => {
    const cap = makeCapture()
    const a1 = encodePermissionActionId('allow', INSTANCE_C, TOKEN_A)
    emitBlockActionReceived(a1, makeContext(), cap.emit)
    emitBlockActionReceived('foreign_action', makeContext(), cap.emit)
    expect(cap.events).toHaveLength(2)
    expect(cap.events[0]!['raw_action_id']).toBe(a1)
    expect(cap.events[1]!['raw_action_id']).toBe('foreign_action')
  })

  test('context fields are passed through verbatim on every event', () => {
    const cap = makeCapture()
    emitBlockActionReceived(
      encodePermissionActionId('allow', INSTANCE_C, TOKEN_A),
      makeContext({ channel: 'CDIFF', messageTs: '99.0', user: 'UDIFF' }),
      cap.emit,
    )
    const e = cap.events[0]!
    expect(e.channel).toBe('CDIFF')
    expect(e.message_ts).toBe('99.0')
    expect(e['user']).toBe('UDIFF')
  })

  test('omitted context fields land as undefined (open envelope)', () => {
    const cap = makeCapture()
    emitBlockActionReceived('foreign', { }, cap.emit)
    const e = cap.events[0]!
    expect(e.channel).toBeUndefined()
    expect(e.message_ts).toBeUndefined()
    expect(e['user']).toBeUndefined()
  })
})
