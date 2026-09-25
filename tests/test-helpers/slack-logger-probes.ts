/**
 * test-helpers/slack-logger-probes.ts — Shared probes for the Slack
 * libraries' log output (E13 decisions 12 and 15): the connection-ticket URL
 * the library's error lines carry, the allowlisted pong-timeout text, the
 * server-log line a persona's socket logger writes, and a recorder of
 * everything written to the console, `process.stdout` and `process.stderr`.
 *
 * Used by tests/persona-connections.test.ts (the logger units and the
 * manager's client options) and tests/persona-connection-wiring.test.ts (the
 * production factory's real clients).
 *
 * Holds no token: the ticket URL carries `LEAK_SENTINEL` by reference, so
 * anything built from it is caught by `assertNoLeak`.
 *
 * SPDX-License-Identifier: MIT
 */

import { renderPersonaRef } from '../../src/persona-identity.ts'
import type { SlackLogPersona } from '../../src/persona-slack-clients.ts'
import { LEAK_SENTINEL, sentinelTicketUrl } from './credentials.ts'

/**
 * A WebSocket URL at `origin` as `apps.connections.open` returns it, its
 * connection ticket sentinel-bearing: `sentinelTicketUrl` with an `app_id`
 * query parameter after the ticket.
 */
export function ticketUrl(origin: string): string {
  return `${sentinelTicketUrl(origin, `${LEAK_SENTINEL}-ticket`)}&app_id=A0STUB0001`
}

/** The library's pong-timeout warning at the default client ping timeout (`SlackWebSocket.js`): an allowlisted line. */
export const PONG_TIMEOUT_TEXT = "A pong wasn't received from the server before the timeout of 5000ms!"

/** The server-log line `persona`'s socket logger writes for the forwarded `text`. */
export function socketLogLine(persona: SlackLogPersona, text: string): string {
  return `[slack] persona Socket Mode: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}: ${text}`
}

/** One call a console method, `process.stdout.write` or `process.stderr.write` received. */
export interface OutputCall {
  readonly method: string
  readonly args: unknown[]
}

const CONSOLE_METHODS = ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const

/**
 * Replace every console method and `process.stdout.write` /
 * `process.stderr.write` with a recorder; `restore` puts back whatever was
 * there before (a suite's own `console.error` spy included).
 */
function silenceOutput(): { calls: OutputCall[]; restore(): void } {
  const calls: OutputCall[] = []
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    return true
  }
  const savedConsole = CONSOLE_METHODS.map(method => [method, console[method]] as const)
  const savedStdout = process.stdout.write
  const savedStderr = process.stderr.write
  for (const method of CONSOLE_METHODS) console[method] = record(method)
  process.stdout.write = record('stdout') as typeof process.stdout.write
  process.stderr.write = record('stderr') as typeof process.stderr.write
  return {
    calls,
    restore: () => {
      for (const [method, saved] of savedConsole) console[method] = saved
      process.stdout.write = savedStdout
      process.stderr.write = savedStderr
    },
  }
}

/**
 * Every call the console methods, `process.stdout.write` and
 * `process.stderr.write` received while `fn` ran, all of them silenced. Pass
 * the result to `assertNoLeak` before any assertion that could print it.
 */
export function outputDuring(fn: () => void): OutputCall[] {
  const { calls, restore } = silenceOutput()
  try {
    fn()
  } finally {
    restore()
  }
  return calls
}

/** `outputDuring` for an `fn` that may be async: output stays silenced and recorded until it settles. */
export async function outputDuringAsync(fn: () => unknown): Promise<OutputCall[]> {
  const { calls, restore } = silenceOutput()
  try {
    await fn()
  } finally {
    restore()
  }
  return calls
}
