/**
 * server-post.test.ts — the Server Post Marker and the origin classifier
 * (`src/server-post.ts`), SR-2.3 and decision D1.
 *
 * A message is a Server Post when its metadata carries the marker's
 * `event_type`, or when a block element's `action_id` is one
 * `parsePermissionActionId` decodes (an open permission prompt, marked or
 * not). Everything else, malformed input included, is a Tool Post. Data
 * fixtures only: the classifier is pure.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { SERVER_POST_EVENT_TYPE, isServerPost } from '../src/server-post.ts'
import { encodePermissionActionId } from '../src/permission-action-id.ts'
import { STUB_INSTANCE_ID, cannedPermissionRequest } from './test-helpers/agent-director-stub.ts'

const TOKEN = cannedPermissionRequest().request_token
const ALLOW_ID = encodePermissionActionId('allow', STUB_INSTANCE_ID, TOKEN)
const DENY_ID = encodePermissionActionId('deny', STUB_INSTANCE_ID, TOKEN)

const MARKER = { event_type: SERVER_POST_EVENT_TYPE, event_payload: {} }
const SECTION = { type: 'section', text: { type: 'mrkdwn', text: '🤖🛠️ *Bash*' } }

function button(actionId: unknown): Record<string, unknown> {
  return { type: 'button', text: { type: 'plain_text', text: 'Allow' }, action_id: actionId }
}

/** A message as `conversations.replies` returns it. */
function message(extra: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', ts: '1700000000.000100', bot_id: 'B0STUB', text: 'hello', ...extra }
}

describe('the Server Post Marker', () => {
  test('pin: the marker event type is cscb_server_post', () => {
    expect(SERVER_POST_EVENT_TYPE).toBe('cscb_server_post')
  })
})

describe('isServerPost: Server Posts', () => {
  test.each([
    ['a marked server notice', message({ metadata: MARKER })],
    ['a marked post whose read-back payload is not empty', message({ metadata: { event_type: SERVER_POST_EVENT_TYPE, event_payload: { x: 1 } } })],
    ['a marked post whose read-back metadata has no payload', message({ metadata: { event_type: SERVER_POST_EVENT_TYPE } })],
    ['an open prompt posted before the marker (allow and deny buttons, no metadata)', message({
      blocks: [SECTION, { type: 'actions', elements: [button(ALLOW_ID), button(DENY_ID)] }],
    })],
    ['an unmarked block holding only a deny button', message({ blocks: [{ type: 'actions', elements: [button(DENY_ID)] }] })],
    ['an open prompt whose metadata is another app\'s', message({
      metadata: { event_type: 'other_app_event', event_payload: {} },
      blocks: [{ type: 'actions', elements: [button(ALLOW_ID)] }],
    })],
    ['a valid element after malformed blocks and elements', message({
      blocks: [
        null, 'text', 7, [], { type: 'actions' }, { type: 'actions', elements: 'nope' },
        { type: 'actions', elements: [null, 'x', [], {}, button(42), button(null), button('perm_allow_junk'), button(ALLOW_ID)] },
      ],
    })],
  ])('%s', (_name, msg) => {
    expect(isServerPost(msg)).toBe(true)
  })
})

describe('isServerPost: Tool Posts and malformed input', () => {
  const uuid = TOKEN
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'cscb_server_post'],
    ['a message array carrying valid metadata', Object.assign([], message({ metadata: MARKER }))],
    ['an empty object', {}],
    ['an ordinary reply-tool post', message({})],
    ['an old unmarked server notice (text only)', message({ text: 'Persona A (key=a): restart cap reached' })],
    ['an old closed prompt (its buttons replaced by a verdict)', message({
      blocks: [SECTION, { type: 'context', elements: [{ type: 'mrkdwn', text: '✅ Allowed' }] }],
    })],
    ['a different event type with no permission button', message({ metadata: { event_type: 'other_app_event', event_payload: {} } })],
    ['metadata that is null', message({ metadata: null })],
    ['metadata that is a string', message({ metadata: SERVER_POST_EVENT_TYPE })],
    ['a metadata array carrying the marker event type', message({ metadata: Object.assign([], MARKER) })],
    ['a non-string event type', message({ metadata: { event_type: 1, event_payload: {} } })],
    ['the marker in the payload, not the event type', message({ metadata: { event_type: 'x', event_payload: { event_type: SERVER_POST_EVENT_TYPE } } })],
    ['blocks that are not an array', message({ blocks: { type: 'actions', elements: [button(ALLOW_ID)] } })],
    ['elements that are not an array', message({ blocks: [{ type: 'actions', elements: button(ALLOW_ID) }] })],
    ['a block array carrying valid elements', message({ blocks: [Object.assign([], { type: 'actions', elements: [button(ALLOW_ID)] })] })],
    ['an element array carrying a valid permission action', message({ blocks: [{ type: 'actions', elements: [Object.assign([], button(ALLOW_ID))] }] })],
    ['a non-string action_id', message({ blocks: [{ type: 'actions', elements: [button({ id: ALLOW_ID })] }] })],
    ['an unknown decision', message({ blocks: [{ type: 'actions', elements: [button(`perm_maybe_${STUB_INSTANCE_ID}_${uuid}`)] }] })],
    ['an instance id without the cscb_ prefix', message({ blocks: [{ type: 'actions', elements: [button(`perm_allow_bot_x_${uuid}`)] }] })],
    ['a token that is not UUID-shaped', message({ blocks: [{ type: 'actions', elements: [button(`perm_allow_${STUB_INSTANCE_ID}_not-a-token`)] }] })],
    ['a valid id with trailing text', message({ blocks: [{ type: 'actions', elements: [button(`${ALLOW_ID} `)] }] })],
    ['a valid id behind leading text', message({ blocks: [{ type: 'actions', elements: [button(`x${ALLOW_ID}`)] }] })],
  ])('%s', (_name, msg) => {
    expect(isServerPost(msg)).toBe(false)
  })
})
