/**
 * persona-web-api-watch.ts — Watch a persona's long-lived Web API client for
 * a revoked bot token (bug b.ujn).
 *
 * A persona's Socket Mode connection runs on its app token, so a bot token
 * revoked while the server runs (app reinstalled, token rotated, app removed)
 * leaves the socket up while every Web API call fails. `watchWebClientAuth`
 * wraps the client the connection manager hands out, so the manager hears of
 * the first such failure and marks the persona credentials-broken.
 *
 * The wrapper is an object whose prototype is the client, so every property
 * it does not wrap reads through to the client. It has its own wrapped copy
 * of every method (the client's own function-valued properties and the
 * methods on its prototype chain: `apiCall`, `filesUploadV2`, …) and of every
 * plain-object method namespace (`chat`, `reactions`, `conversations`,
 * `users`, `files`, `admin.apps`, …, recursively, each again an object whose
 * prototype is the original namespace). A wrapped method calls the original
 * with the original holder as `this` and returns its result unchanged; its
 * prototype is the original, so the original's properties read through. A
 * result that is a promise is observed: when it rejects with a Web API
 * platform error whose Slack error is exactly `invalid_auth`,
 * `token_revoked`, `account_inactive` or `not_authed`
 * (`classifyWebApiAuthFailure`), the watch latches and `onRefused` is told,
 * synchronously in that rejection's handler, with the method name (the
 * property path, e.g. `chat.postMessage`, or the method an `apiCall` names).
 * The caller still gets the original promise, so it sees the original
 * rejection, unchanged, and its own error handling stands. Every other
 * outcome (another Slack error, a network or HTTP error, a success, a
 * synchronous throw) is ignored. `@slack/web-api` binds its namespace methods
 * to `apiCall` when the client is built, so overriding `apiCall` on an
 * instance would not see them; the wrapper sees every call made through it.
 *
 * Latch (first refusal only): `onRefused` is told at most once per watch,
 * for the first refused call; a refusal of another call already in flight is
 * not reported again. From then on every Web API method called through the
 * wrapper (a namespace method such as `chat.postMessage`, `apiCall`,
 * `filesUploadV2`) is refused locally: the original is not called, so
 * nothing reaches Slack, and the call returns a promise rejected with a
 * `WebApiCallRefusedLocallyError` (`data.error` is the latched Slack error,
 * so a caller's existing handling reads it as it would Slack's answer). The
 * client's other methods (its event-emitter methods, …) still run. The latch
 * belongs to one wrapper: a new client (a credentials reconnect's, a fresh
 * bring-up's) starts unlatched.
 *
 * Plain wrapper objects rather than a `Proxy`, so a test's `spyOn` on the
 * handed-out client or one of its namespaces installs as usual. Accessor
 * properties, symbols and non-function, non-plain-object values are not
 * copied: they read through to the original. No `paginate` or async-iterator
 * use exists in `src/`; an iterator is not a promise and is not observed, and
 * `paginate` is not refused by the latch.
 *
 * Secrecy: the wrapper never logs, stores or modifies an error; `onRefused`
 * gets only the classifier's outcome (the Slack error code, the token key and
 * the method name), and the local refusal's error carries only the Slack
 * error code and a method name that matches `SLACK_METHOD_NAME_RE`.
 *
 * Pure module (b.av2 SR-13.1): nothing runs at import; a watch holds nothing
 * but its wrappers and its latch.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  SLACK_METHOD_NAME_RE,
  classifyWebApiAuthFailure,
  type SlackCredentialsRefusedOutcome,
} from './persona-slack-validation.ts'

/** Told of a Web API call refused for a revoked or invalid bot token. */
export type WebApiRefusedListener = (outcome: SlackCredentialsRefusedOutcome) => void

type AnyFunction = (...args: unknown[]) => unknown

/** The `code` of a `WebApiCallRefusedLocallyError`. */
export const WEB_API_CALL_REFUSED_LOCALLY = 'persona_web_api_refused_locally'

/**
 * The client's top-level methods that are Web API calls, refused by the latch
 * like every namespace method. `paginate` is left out (unused in `src/`).
 */
const ROOT_WEB_API_METHODS: ReadonlySet<string> = new Set(['apiCall', 'filesUploadV2'])

/**
 * A Web API call made through a watched client after its bot token was
 * refused (the watch's latch): the call was not sent. `data.error` is the
 * Slack error that latched the watch (`token_revoked`, …), so a caller that
 * reads `data.error` sees what Slack would have answered; `code` is
 * `WEB_API_CALL_REFUSED_LOCALLY`, not the library's platform-error code, so
 * the watch never classifies it again. Carries no token, request or header.
 */
export class WebApiCallRefusedLocallyError extends Error {
  readonly code = WEB_API_CALL_REFUSED_LOCALLY
  /** The Slack error that latched the watch, shaped like a platform error's `data`. */
  readonly data: { ok: false; error: string }
  /** The method called, when it matches `SLACK_METHOD_NAME_RE`. */
  readonly method: string | undefined

  constructor(method: string, slackError: string) {
    const safeMethod = SLACK_METHOD_NAME_RE.test(method) ? method : undefined
    super(
      `Web API call ${safeMethod ?? '(unnamed)'} not sent: this client's bot token was refused by Slack (${slackError})`,
    )
    this.name = 'WebApiCallRefusedLocallyError'
    this.data = { ok: false, error: slackError }
    this.method = safeMethod
  }
}

/** Whether a value is a plain object (a Web API method namespace), not a class instance or an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a value is a promise-like. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * The string-keyed data properties of `source` and of its prototype chain up
 * to (not including) `Object.prototype`, nearest first; `constructor` and
 * accessors are left out.
 */
function dataProperties(source: object, withPrototypes: boolean): Array<[string, unknown]> {
  const seen = new Set<string>()
  const found: Array<[string, unknown]> = []
  for (
    let holder: object | null = source;
    holder !== null && holder !== Object.prototype;
    holder = withPrototypes ? Object.getPrototypeOf(holder) : null
  ) {
    for (const name of Object.getOwnPropertyNames(holder)) {
      if (seen.has(name) || name === 'constructor') continue
      seen.add(name)
      const descriptor = Object.getOwnPropertyDescriptor(holder, name)
      if (descriptor !== undefined && 'value' in descriptor) found.push([name, descriptor.value])
    }
  }
  return found
}

/**
 * Wrap `client` so the first Web API call made through the wrapper that is
 * refused for its bot token tells `onRefused` and latches the watch, after
 * which the wrapper refuses every Web API call locally (see the module
 * comment). Returns the wrapper; the caller hands it out in place of
 * `client`. `onRefused` is called at most once, from the first refused
 * call's rejection handler; a throw from it is swallowed.
 */
export function watchWebClientAuth<T extends object>(client: T, onRefused: WebApiRefusedListener): T {
  /** The Slack error of the first refused call; set once, never cleared. */
  let latched: string | undefined

  function observe(result: unknown, method: string): void {
    if (!isThenable(result)) return
    // A second reaction on the caller's promise: the caller keeps the original.
    result.then(undefined, (err: unknown) => {
      try {
        if (latched !== undefined) return
        const outcome = classifyWebApiAuthFailure(err, method)
        if (outcome === undefined) return
        latched = outcome.slackError
        onRefused(outcome)
      } catch {
        /* the watch never disturbs the call or raises a rejection of its own */
      }
    })
  }

  function wrapFunction(fn: AnyFunction, holder: object, path: string): AnyFunction {
    const isWebApiMethod = path.includes('.') || ROOT_WEB_API_METHODS.has(path)
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const method = path === 'apiCall' && typeof args[0] === 'string' ? args[0] : path
      if (isWebApiMethod && latched !== undefined) {
        return Promise.reject(new WebApiCallRefusedLocallyError(method, latched))
      }
      const result = Reflect.apply(fn, holder, args)
      observe(result, method)
      return result
    }
    Object.setPrototypeOf(wrapped, fn)
    return wrapped
  }

  function wrapHolder(holder: object, path: string, withPrototypes: boolean): object {
    const wrapper: Record<string, unknown> = Object.create(holder)
    for (const [name, value] of dataProperties(holder, withPrototypes)) {
      const childPath = path === '' ? name : `${path}.${name}`
      if (typeof value === 'function') wrapper[name] = wrapFunction(value as AnyFunction, holder, childPath)
      else if (isPlainObject(value)) wrapper[name] = wrapHolder(value, childPath, false)
    }
    return wrapper
  }

  return wrapHolder(client, '', true) as T
}
