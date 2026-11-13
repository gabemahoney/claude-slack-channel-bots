/**
 * server-post.ts — The Server Post Marker and the origin classifier.
 *
 * A Server Post is a message CSCB posts under a Bot's identity on its own
 * behalf: a server notice, a permission prompt or a storage-warning
 * correction. Every such `chat.postMessage` carries Slack message metadata
 * whose `event_type` is `SERVER_POST_EVENT_TYPE` and whose `event_payload` is
 * empty. Tool Posts (the `reply` tool's text posts and uploads) carry none,
 * and `chat.update` calls omit `metadata` so Slack keeps a message's origin.
 *
 * `isServerPost` reads a message as Slack returns it (for example from
 * `conversations.replies` with `include_all_metadata`): the marker, or an open
 * permission prompt's decision button, makes it a Server Post. An open prompt
 * posted before the marker existed still has its buttons, so it counts too;
 * an unmarked ordinary notice or closed prompt does not (decision D1).
 *
 * Pure module: no I/O, timers, logging or module state.
 *
 * SPDX-License-Identifier: MIT
 */

import { parsePermissionActionId } from './permission-action-id.ts'
import { isRecord } from './record.ts'

/** The `metadata.event_type` every Server Post carries. */
export const SERVER_POST_EVENT_TYPE = 'cscb_server_post'

/** The read-back payload is not checked: only writes promise it is empty. */
function hasServerPostMarker(message: Record<string, unknown>): boolean {
  const metadata = message.metadata
  return isRecord(metadata) && metadata.event_type === SERVER_POST_EVENT_TYPE
}

function hasPermissionAction(message: Record<string, unknown>): boolean {
  const blocks = message.blocks
  if (!Array.isArray(blocks)) return false
  for (const block of blocks) {
    if (!isRecord(block) || !Array.isArray(block.elements)) continue
    for (const element of block.elements) {
      if (!isRecord(element)) continue
      const actionId = element.action_id
      if (typeof actionId === 'string' && parsePermissionActionId(actionId) !== null) return true
    }
  }
  return false
}

/**
 * Whether `message` is a Server Post: it carries the Server Post Marker, or a
 * block element's `action_id` is a permission decision `parsePermissionActionId`
 * decodes. Every other value, malformed ones included, is a Tool Post. Pure.
 */
export function isServerPost(message: unknown): boolean {
  if (!isRecord(message)) return false
  return hasServerPostMarker(message) || hasPermissionAction(message)
}
