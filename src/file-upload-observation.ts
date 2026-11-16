/**
 * file-upload-observation.ts — Observe each nested file-upload completion at
 * a persona's real Web API client.
 *
 * `filesUploadV2` completes each upload group through
 * `this.files.completeUploadExternal` on the client itself and returns only
 * after every group settles (`Promise.all`), so one group's rejection hides
 * another's success, and the auth watch's wrapper never sees the inner call.
 * `observeFileCompletions` therefore wraps that one method on the raw client
 * before it is handed out. Each completion that resolves reaches the listener
 * bound with `withFileCompletions` around the caller's own upload, in the
 * completion's own reaction and before the SDK's aggregate continues, so
 * concurrent operations and personas never see each other's completions.
 * Rejections and calls made outside a bound upload are left untouched.
 *
 * The listener receives the completion response as Slack returned it; it
 * must not throw (a throw is swallowed) and must not await.
 *
 * Pure module: nothing runs at import.
 *
 * SPDX-License-Identifier: MIT
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Told synchronously of each resolved `files.completeUploadExternal` response. */
export type FileCompletionListener = (response: unknown) => void

const uploads = new AsyncLocalStorage<FileCompletionListener>()
const OBSERVED = Symbol('cscb-file-completions-observed')

/**
 * Wrap `client.files.completeUploadExternal` so completions made inside
 * `withFileCompletions` reach its listener. Idempotent; a client without that
 * method (a test stub) is left as it is.
 */
export function observeFileCompletions(client: object): void {
  const files = (client as { files?: unknown }).files
  if (typeof files !== 'object' || files === null) return
  const holder = files as Record<string | symbol, unknown>
  const original = holder['completeUploadExternal']
  if (holder[OBSERVED] === true || typeof original !== 'function') return
  holder['completeUploadExternal'] = function (this: unknown, ...args: unknown[]): unknown {
    const listener = uploads.getStore()
    const result: unknown = Reflect.apply(original, this, args)
    if (listener && typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      (result as PromiseLike<unknown>).then(response => {
        try { listener(response) } catch { /* observation cannot change the upload */ }
      }, () => { /* the caller sees the rejection unchanged */ })
    }
    return result
  }
  Object.defineProperty(holder, OBSERVED, { value: true })
}

/** Run one upload with `listener` bound to the completions it makes. */
export function withFileCompletions<T>(listener: FileCompletionListener, run: () => T): T {
  return uploads.run(listener, run)
}
