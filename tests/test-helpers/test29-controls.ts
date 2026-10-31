/** Synthetic inputs for test29's extracted diagnostic and printer controls.
 * No scenario or native agent is run by these builders. */
import { buildDeliveryDiagnostic, deliveryIdentity, MESSAGE_RECEIVED } from '../../src/persona-diagnostics.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function test29ClosingFixture(mode: string) {
  const sender = 'U1'
  const alpha = { name: 'Alpha', key: 'alpha', channel: 'C1', ts: '1.0', via: 'thread' as const }
  const bravo = { name: 'Bravo', key: 'bravo', channel: 'D1', ts: '2.0', via: 'dm' as const }
  const personas = [alpha, bravo]
  // Serialize expectations before touching actual lines. They come from the
  // accepted scenario inputs, never from parsing or mutating diagnostic output.
  const expected = Object.fromEntries(personas.map(persona => [
    `expected-queue-${persona.key}.jsonl`, jsonl([[persona.channel, persona.ts, persona.via]]),
  ]))
  const lines = personas.map(persona => buildDeliveryDiagnostic(
    MESSAGE_RECEIVED, renderPersonaRef(persona.name, persona.key),
    deliveryIdentity({ source: 'slack', channel: persona.channel, ts: persona.ts, user: sender, via: persona.via }),
  ))
  if (mode === 'missing') lines.shift()
  if (mode === 'duplicate') lines.push(lines[0]!)
  const replacements: Record<string, [string, string]> = {
    'wrong-name': [JSON.stringify(alpha.name), JSON.stringify(bravo.name)],
    'wrong-key': [`key=${alpha.key}`, `key=${bravo.key}`],
    'wrong-source': ['source=slack', 'source=cron'],
    'wrong-channel': [JSON.stringify(alpha.channel), JSON.stringify('C2')],
    'wrong-ts': [JSON.stringify(alpha.ts), JSON.stringify('3.0')],
    'wrong-sender': [JSON.stringify(sender), JSON.stringify('U2')],
    'missing-thread': [' via=thread', ''], 'unknown-suffix': ['via=thread', 'via=unknown'],
  }
  const replacement = replacements[mode]
  if (replacement) {
    if (!lines[0]!.includes(replacement[0])) throw new Error(`test29 mutation did not match: ${mode}`)
    lines[0] = lines[0]!.replace(...replacement)
  }
  if (mode === 'extra-thread') lines[1] += ' via=thread'
  if (mode === 'trailing-junk') lines[0] += ' unexpected'
  return {
    argv: [MESSAGE_RECEIVED, sender, alpha.key, bravo.key, alpha.name, bravo.name].map(shellQuote).join(' '),
    files: {
      ...expected,
      'server.log': lines.slice(0, 1).join('\n') + '\n',
      'server.log.1': lines.slice(1).join('\n') + '\n',
    },
  }
}

// Keep the real printer output operation supplied by the test. Only its
// synthetic value/argv setup lives here; imports from the image CLI stay out.
export function test29PrinterFixture(output: string, switching = false) {
  return { 'printer.ts': switching ? [
    'const [entry, failure] = process.argv.slice(2)',
    'if (entry === failure) { console.error(`assertion failed: ${entry}`); process.exit(17) }',
    "const value = entry === 'operatorReviewRequest' ? '{}' : '';", output,
  ].join('\n') : `const value = '';\n${output}\n` }
}

export function test29PrinterBindings(switching = false) {
  return [
    'SCENARIO_FIXTURES=unused', switching ? 'CONFIG="$HOME/config.json"' : 'CONFIG=unused',
    ...(switching ? ['LAST=unused'] : []), 'STORE_BEFORE_RESTART=unused', 'STORE_FILE=unused',
  ]
}

// Independent expected call order, not recovered from the captured calls.
export function test29SwitchCallOrder() {
  return ['sharedAuthorityPreserved', 'operatorReviewRequest', 'operatorReviewPending', 'sharedApplicationPreserved', 'sharedConfigurationMatches']
}

export function test29SwitchBindings() {
  return [
    'ALPHA=alpha', 'BRAVO=bravo', 'F1=F1', 'F2=F2', 'U1=U1', 'A1=A1',
    'ALPHA_REF=alpha', 'ALPHA_START=start', 'ALPHA_RELAUNCH=relaunch', 'BRAVO_REF=bravo', 'BRAVO_START=start', 'BRAVO_RELAUNCH=relaunch',
    'APPLIED_CLASS=applied', 'PENDING=unused', 'APPLY=unused', 'TICK_WAIT_S=1', 'APPLY_WAIT_S=1', 'SWITCH_ON_LINE=on', 'SWITCH_OFF_LINE=off',
  ]
}
