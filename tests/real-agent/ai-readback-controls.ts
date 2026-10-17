/** Unpaid, case-local controls for the AI read-back scenario. Run only in the
 * CI image with /tests and the installed package; never launches an agent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
check(existsSync('/etc/cscb-ci-image'), 'AI read-back controls require the CI image')
const tests = resolve(dirname(import.meta.path), '..')
const scenario = readFileSync(join(tests, 'real-agent/ai-scenario.sh'), 'utf8')
const corpusPath = join(tests, 'fixtures/delivery-wrapper/wrapper-cases.json')
const originalBytes = readFileSync(corpusPath)
const originals = JSON.parse(originalBytes.toString())
const inputs = scenario.match(/<<'INPUTS'\n([\s\S]*?)\nINPUTS/)?.[1]
check(inputs, 'scenario INPUTS generator missing')
const diagnostic = scenario.match(/^        CASE_DIAGNOSTIC=.*\n        printf .*$/m)?.[0]
check(diagnostic, 'scenario case diagnostic missing')
const { TAG_ATTRIBUTE_ORDER, TAG_SOURCE } = await import(join(resolve(process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots'), 'src/tag-wrapper.ts'))
const scratch = mkdtempSync(join(tmpdir(), 'ai-readback-controls-'))
function run(argv: string[], extra: Record<string, string> = {}) {
  return Bun.spawnSync(argv, { env: { ...process.env, ...extra }, stdout: 'pipe', stderr: 'pipe' })
}
function succeeded(result: ReturnType<typeof run>, context: string) {
  check(result.exitCode === 0, context + ': ' + result.stderr.toString())
}
function same(actual: unknown, expected: unknown, reason: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), reason)
}
try {
  for (const ac of [11, 12, 20]) {
    const expectedDir = join(scratch, String(ac)), work = join(expectedDir, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'CLAUDE.md'), '')
    succeeded(run(['python3', '-c', inputs, String(ac), corpusPath, expectedDir, work, 'U0CONTROLRECIPIENT']), 'generate AC' + ac)
    const rows = JSON.parse(readFileSync(join(expectedDir, 'corpus.json'), 'utf8'))
    const labels = JSON.parse(readFileSync(join(expectedDir, 'case-labels.json'), 'utf8'))
    same(labels, rows.map((row: any, i: number) => ({ case: `case_${String(i + 1).padStart(2, '0')}`, fixture: row.name })), 'opaque one-to-one labels differ')
    check(new Set(labels.map((row: any) => row.case)).size === rows.length, 'duplicate correlation labels')
    const prompt = readFileSync(join(work, 'CLAUDE.md'), 'utf8')
    same(prompt, '\nCase labels in sequence: ' + JSON.stringify(labels.map((row: any) => row.case)).replaceAll(',', ', ') + '.\n', 'model labels differ')
    check(!originals.some((row: any) => prompt.includes(row.name)), 'semantic fixture label leaked into model prompt')
    if (ac === 11) same(rows, originals, 'AC11 changed original corpus fields or order')
    else if (ac === 12) {
      same(rows.slice(0, -1), originals.filter((row: any) => ['hz_bang', 'hz_slash', 'hz_question', 'hz_tab', 'hz_backslash'].includes(row.name)), 'AC12 changed existing selected inputs')
      check(rows.at(-1).name === 'hz_question_prefix' && rows.length === 6, 'AC12 prefix case missing')
    } else {
      check(rows.length === 2 && rows[0].name === 'ex3_peer_bot_spoof', 'AC20 selected inputs differ')
      same(rows[1], originals.find((row: any) => row.name === 'hz_attr_quotes'), 'AC20 display-name case changed')
      const senderCase = structuredClone(originals.find((row: any) => row.name === 'ex3_peer_bot_spoof'))
      senderCase.msg.user_id = 'U0REAL20'; senderCase.msg.user = 'E6 Real Sender'; delete senderCase.msg.bot_id
      senderCase.typed = senderCase.typed.replace('user="horde_dev_apiary" bot_id="B0APIARY01"', 'user="E6 Real Sender" user_id="U0REAL20"')
      same(rows[0], senderCase, 'AC20 true-sender adaptation changed')
    }
    for (const [i, row] of rows.entries()) {
      const expected = JSON.parse(readFileSync(join(expectedDir, `${i + 1}.json`), 'utf8'))
      const attrs: Record<string, string> = { source: TAG_SOURCE }
      for (const name of TAG_ATTRIBUTE_ORDER) if (row.msg[name]) attrs[name] = row.msg[name]
      same(expected, { case: labels[i].case, attributes: attrs, body: row.typed.slice(row.typed.indexOf('>') + 1, -'</channel>'.length) }, 'generated read-back fields changed for ' + row.name)
      const result = run(['bash', '-c', diagnostic], { EXPECTED: expectedDir, n: String(i + 1), AI_CRITERION: String(ac), REAL_AGENT_TRIAL: '1' })
      succeeded(result, 'original fixture diagnostic')
      check(result.stdout.toString().includes(`case=${labels[i].case} fixture=${row.name}`), 'original fixture absent from diagnostic')
    }
    console.log(`PASS: AC${ac} generated ${rows.length} unchanged payloads/expectations with opaque labels and original diagnostics`)
  }

  const promptLines = scenario.split('\n').filter(line => /^\s*PROMPT[=+]/.test(line)).join('\n')
  const promptResult = run(['bash', '-c', promptLines + '\nprintf "%s" "$PROMPT"'])
  succeeded(promptResult, 'scenario read-back prompt')
  const prompt = promptResult.stdout.toString()
  for (const phrase of ['received BODY verbatim', 'every character, whitespace and entity spelling', 'only JSON string escaping', 'do not reconstruct the original Slack text before delivery']) check(prompt.includes(phrase), 'generic transcription instruction missing: ' + phrase)
  check(!originals.some((row: any) => prompt.includes(row.name)), 'semantic case name in transcription instruction')

  const expectedPath = join(scratch, '11/9.json')
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const transcripts = join(scratch, 'transcripts'); mkdirSync(transcripts)
  const transcript = join(transcripts, 'control.jsonl')
  const variants: [string, any, string | null][] = [
    ['exact received body', expected, null],
    ['original tabs instead of received spaces', { ...expected, body: originals[8].msg.text }, 'AI read-back field differs'],
    ['wrong attributes', { ...expected, attributes: { ...expected.attributes, user_id: 'U0WRONG' } }, 'AI read-back field differs'],
    ['another fixture case', { ...expected, case: 'case_08' }, 'no JSON read-back for this case'],
    ['semantic original case', { ...expected, case: originals[8].name }, 'no JSON read-back for this case'],
  ]
  for (const [name, value, failure] of variants) {
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'control', sessionId: 'control', timestamp: '2026-10-16T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } }) + '\n')
    const result = run([process.execPath, join(tests, 'integration/fixtures/real-case-assertions.ts'), 'readback', scratch, 'control', join(scratch, 'unused-shim'), transcripts, expectedPath])
    if (failure === null) succeeded(result, name)
    else check(result.exitCode !== 0 && result.stderr.toString().includes(failure), name + ' accepted or failed for the wrong reason: ' + result.stderr.toString())
    console.log('PASS: unchanged actual read-back comparator ' + name + (failure ? ' rejected' : ' accepted'))
  }
  check(readFileSync(corpusPath).equals(originalBytes), 'original corpus bytes changed')
  console.log('PASS: original 15-case corpus remains byte-identical; no agent/model calls')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
