/** Independent expectations for Server Posts and metadata-free tool calls. */
import { expect } from 'bun:test'
import type { NoticePost } from './persona-notifier.ts'

export const SERVER_POST_METADATA = { event_type: 'cscb_server_post', event_payload: {} }

export const noticePost = (channel: string, text: string): NoticePost => ({ channel, text, metadata: SERVER_POST_METADATA })

/** No metadata key, even one set to undefined; lists must contain a call. */
export function expectNoMetadata(args: object | readonly object[]): void {
  const calls = Array.isArray(args) ? args : [args]
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) expect(Object.hasOwn(call, 'metadata')).toBe(false)
}
