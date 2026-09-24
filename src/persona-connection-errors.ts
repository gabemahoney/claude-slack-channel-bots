/**
 * persona-connection-errors.ts — Token-safe description of thrown values, and
 * the process-level `unhandledRejection` handler (b.av2 SR-3.3, SR-10.3).
 *
 * A Slack library error can hold secrets beyond its code: its message, its
 * `original` (the raw request error, Authorization header included), request
 * headers, request config and `data`. `describeThrownValue` therefore keeps
 * only three things:
 *
 * - the value's constructor name (for an `Error`) or its type (anything else:
 *   `undefined`, `null`, `string`, `object`, …);
 * - the `code`, only when it is a short identifier (letters, digits and `_`;
 *   a Slack token always contains `-`, so it can never pass);
 * - the stack's frame lines (`at …`), after the message has been cut out of
 *   the stack, so no line of a multi-line message survives, even one shaped
 *   like a frame.
 *
 * Nothing else is read, and the value is never serialised.
 *
 * `createUnhandledRejectionHandler(log)` returns a listener for the process's
 * `unhandledRejection` event that logs one `[slack]` line built with the
 * describer and returns: it never throws, rethrows or exits, so one persona's
 * stray rejection cannot take the process down. This module never installs
 * it (no `process.on`); E3 does.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, no environment access,
 * no file writes, nothing runs at import.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A `code` or constructor name that is safe to log: a short identifier, no `-`. */
const SAFE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

/** A stack frame line (`    at fn (file:1:2)`). */
const STACK_FRAME_RE = /^\s*at\s/

/** Most stack frames a description keeps. */
const MAX_STACK_FRAMES = 10

/** Separator between frames in a one-line description. */
const FRAME_SEPARATOR = ' <- '

// ---------------------------------------------------------------------------
// Describer
// ---------------------------------------------------------------------------

/**
 * Describe any thrown or rejected value in one line that is safe to log:
 * `<Type>[ code=<code>][ <frame> <- <frame> …]`. See the module comment for
 * what is kept. Never throws.
 */
export function describeThrownValue(value: unknown): string {
  try {
    if (!(value instanceof Error)) return value === null ? 'null' : typeof value
    const parts = [constructorName(value)]
    const code = readProp(value, 'code')
    if (typeof code === 'string' && SAFE_IDENTIFIER_RE.test(code)) parts.push(`code=${code}`)
    const frames = stackFrames(value)
    if (frames.length > 0) parts.push(frames.join(FRAME_SEPARATOR))
    return parts.join(' ')
  } catch {
    return 'unknown'
  }
}

/** The constructor name of an `Error`, when it is a safe identifier; otherwise `Error`. */
function constructorName(error: Error): string {
  const ctor = readProp(Object.getPrototypeOf(error), 'constructor')
  const name = readProp(ctor, 'name')
  return typeof name === 'string' && SAFE_IDENTIFIER_RE.test(name) ? name : 'Error'
}

/** Line breaks a stack or message can contain. */
const LINE_BREAK_RE = /\r\n|[\n\r\u2028\u2029]/

/**
 * The stack's frame lines, trimmed. The message is cut out first: the stack
 * up to the end of the message's first occurrence (the `Name: message`
 * header) is dropped; when the message does not occur in the stack, every
 * occurrence of each of its lines is removed instead. Only then are
 * non-frame lines dropped, so a message line shaped like a frame cannot
 * survive.
 */
function stackFrames(error: Error): string[] {
  const stack = readProp(error, 'stack')
  if (typeof stack !== 'string') return []
  const message = readProp(error, 'message')
  let body = stack
  if (typeof message === 'string' && message !== '') {
    const at = stack.indexOf(message)
    if (at !== -1) {
      body = stack.slice(at + message.length)
    } else {
      for (const part of message.split(LINE_BREAK_RE)) {
        if (part.trim() !== '') body = body.split(part).join('')
      }
    }
  }
  return body
    .split(LINE_BREAK_RE)
    .filter(line => STACK_FRAME_RE.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map(line => line.trim())
}

/** `obj[prop]`, or `undefined` when `obj` is not an object or the read throws. */
function readProp(obj: unknown, prop: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined
  try {
    return (obj as Record<string, unknown>)[prop]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// unhandledRejection handler
// ---------------------------------------------------------------------------

/** A listener for the process's `unhandledRejection` event. */
export type UnhandledRejectionHandler = (reason: unknown, promise?: Promise<unknown>) => void

/**
 * Build an `unhandledRejection` listener that logs one line through `log`,
 * `[slack] unhandled rejection (process keeps running): <description>`, and
 * returns. It never throws (a throwing `log` is swallowed), never rethrows
 * and never exits. Not installed here; the caller passes it to `process.on`.
 */
export function createUnhandledRejectionHandler(log: (line: string) => void): UnhandledRejectionHandler {
  return (reason: unknown): void => {
    try {
      log(`[slack] unhandled rejection (process keeps running): ${describeThrownValue(reason)}`)
    } catch {
      /* a failing logger must not turn a logged rejection into a crash */
    }
  }
}
