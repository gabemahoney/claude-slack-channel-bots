/**
 * trail-cli.ts — CLI dispatch for `cscb trail`. Parses argv, validates flag
 * combinations, calls into src/trail-query.ts, and writes JSONL output to
 * stdout. The subcommand is read-only and never touches the PID file or
 * communicates with a running CSCB process (SR-V-6.2).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  queryByChannelTimerange,
  queryByToken,
  resolveTrailPathForQuery,
} from './trail-query.ts'
import type { TrailEvent } from './permission-trail.ts'

export interface TrailCliIo {
  /** Writes one line + '\n' to stdout. */
  stdout: (line: string) => void
  /** Writes one line + '\n' to stderr. */
  stderr: (line: string) => void
}

const defaultIo: TrailCliIo = {
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
}

function printHelp(io: TrailCliIo): void {
  const path = resolveTrailPathForQuery()
  io.stdout('Usage: cscb trail <flags>')
  io.stdout('')
  io.stdout('  --token <REQUEST_TOKEN>')
  io.stdout('      Print every JSONL event whose request_token matches, sorted by ts ascending.')
  io.stdout('      Example: cscb trail --token 6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd')
  io.stdout('')
  io.stdout('  --channel <CHANNEL_ID> --since <RFC3339> --until <RFC3339>')
  io.stdout('      Print every JSONL event for the channel inside the time window (inclusive).')
  io.stdout('      Example: cscb trail --channel C0B1ZJJLJ9M \\')
  io.stdout('               --since 2026-06-04T20:00:00.000Z --until 2026-06-04T21:00:00.000Z')
  io.stdout('')
  io.stdout('  --help')
  io.stdout('      Print this message.')
  io.stdout('')
  io.stdout(`Trail file (honors SLACK_STATE_DIR): ${path}`)
  io.stdout('Output: JSONL on stdout, one event per line, ts-ascending.')
  io.stdout('See docs/architecture.md "Operator queries" for join keys and SRD §10 question mapping.')
}

interface ParsedFlags {
  help: boolean
  token: string | undefined
  channel: string | undefined
  since: string | undefined
  until: string | undefined
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = {
    help: false,
    token: undefined,
    channel: undefined,
    since: undefined,
    until: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a === '--token') { flags.token = argv[++i]; }
    else if (a === '--channel') { flags.channel = argv[++i]; }
    else if (a === '--since') { flags.since = argv[++i]; }
    else if (a === '--until') { flags.until = argv[++i]; }
  }
  return flags
}

function emitEvents(events: TrailEvent[], io: TrailCliIo): void {
  for (const e of events) {
    io.stdout(JSON.stringify(e))
  }
}

/**
 * Dispatch `cscb trail`. Returns the exit code. Pure (no process.exit) so
 * tests can drive it directly.
 */
export function runTrailCli(
  argv: readonly string[],
  io: TrailCliIo = defaultIo,
  opts: { trailPath?: string } = {},
): number {
  const flags = parseFlags(argv)

  if (flags.help || (argv.length === 0)) {
    printHelp(io)
    return 0
  }

  if (flags.token !== undefined && flags.channel !== undefined) {
    io.stderr('cscb trail: --token and --channel are mutually exclusive')
    return 1
  }

  const queryOpts = opts.trailPath !== undefined ? { trailPath: opts.trailPath } : undefined

  if (flags.token !== undefined) {
    if (flags.token.length === 0) {
      io.stderr('cscb trail: --token requires a non-empty value')
      return 1
    }
    emitEvents(queryByToken(flags.token, queryOpts), io)
    return 0
  }

  if (flags.channel !== undefined) {
    if (flags.channel.length === 0) {
      io.stderr('cscb trail: --channel requires a non-empty value')
      return 1
    }
    if (flags.since === undefined || flags.until === undefined) {
      io.stderr('cscb trail: --channel requires --since <RFC3339> --until <RFC3339>')
      return 1
    }
    emitEvents(queryByChannelTimerange(flags.channel, flags.since, flags.until, queryOpts), io)
    return 0
  }

  // No recognized mode flag given.
  io.stderr('cscb trail: must specify either --token or --channel (see --help)')
  return 1
}
