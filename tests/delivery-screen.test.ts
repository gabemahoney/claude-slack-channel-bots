/** b.omv SR-5.3/5.4: the adapter reads the bottom composer, never history. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { readDeliveryScreen } from '../src/delivery-screen.ts'
import { buildWrapper, type TagMessage } from '../src/tag-wrapper.ts'
import * as panes from './test-helpers/working-row-panes.ts'

describe('Claude screen contract', () => {
  test.each([
    ['idle', panes.IDLE_PANE, false], ['other idle', panes.OTHER_IDLE_PANE, false],
    ['Linux', panes.LINUX_IDLE_PANE, false], ['spinner', panes.SPINNER_PANE, true],
    ['custom spinner', panes.CUSTOM_VERB_SPINNER_PANE, true],
    ['quoted dialog', panes.QUOTED_DIALOG_PANE, false], ['quoted menu', panes.QUOTED_MENU_PANE, false],
  ] as const)('%s has an empty composer with its expected running state', (_name, pane, running) => {
    expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'empty', running })
  })
  test.each([
    ['permission', panes.PERMISSION_PANE], ['plan', panes.PLAN_APPROVAL_PANE],
    ['selection', panes.SELECT_MENU_PANE], ['model', panes.MODEL_PICKER_PANE],
    ['trust', panes.TRUST_DIALOG_PANE], ['channels', panes.DEV_CHANNELS_DIALOG_PANE],
    ['MCP', panes.MCP_SERVER_DIALOG_PANE], ['no composer', 'A reply only'],
  ])('%s is a menu', (_name, pane) => expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'menu', running: false }))
  test.each(['>', '❯'] as const)('marker %s supports placeholders, ANSI, drafts and multiline own text', marker => {
    for (const text of ['', '   ', 'Try "fix the build"', 'Press up to edit queued messages', 'Message @helper…']) {
      expect(readDeliveryScreen('claude', `\x1b[32m${panes.deliveryPane(text, { marker })}\x1b[0m`)).toEqual({ kind: 'empty', running: false })
    }
    const own = '<channel>one\ntwo</channel>'
    expect(readDeliveryScreen('claude', panes.deliveryPane(own, { marker }), own)).toEqual({ kind: 'own', text: own, running: false })
    expect(readDeliveryScreen('claude', panes.deliveryPane('a human draft', { marker }), own)).toEqual({ kind: 'input', text: 'a human draft', running: false })
    expect(readDeliveryScreen('claude', panes.deliveryPane('[Pasted text #1 +3 lines]', { marker }), own).kind).toBe('own')
  })
  test.each(['Esc to cancel', 'ENTER TO SELECT', 'Enter to confirm', 'arrows to navigate'])('footer %s blocks, history does not', footer => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('', { footer })).kind).toBe('menu')
    expect(readDeliveryScreen('claude', panes.deliveryPane('', { history: `${footer}\n❯ old draft\n` }))).toEqual({ kind: 'empty', running: false })
  })
  test('earlier matching text cannot make an unrelated current draft ours', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('human', { history: '❯ <channel>mine</channel>\n' }), '<channel>mine</channel>').kind).toBe('input')
    expect(readDeliveryScreen('claude', panes.withLastLine('A dialog after the box')).kind).toBe('menu')
  })
})

describe('Codex known composer contract', () => {
  test.each(['', 'Ask Codex to do anything', 'Ask a follow-up question'])('empty placeholder %p with arbitrary configured footer', text => {
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex', footer: 'custom worktree status', history: '› old draft\n' }))).toEqual({ kind: 'empty', running: false })
  })
  test.each(['human', 'first\nsecond', '\nsecond'])('draft %p is input', text => {
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex' })).kind).toBe('input')
  })
  test('own prefix, running, disabled input and menu footers', () => {
    const text = '<channel>mine\nbody</channel>'
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex', running: true }), text)).toEqual({ kind: 'own', text, running: true })
    for (const text of ['Viewing sub-agent — direct input is disabled', 'Enter to select']) {
      expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex' })).kind).toBe('menu')
    }
    expect(readDeliveryScreen('codex', 'No composer')).toEqual({ kind: 'menu', running: false })
  })
})

// Native run 20261017t212743z-ddde5cd6, model recorded in paneProvenance.
// Derived controls below exercise boundaries; they are not native evidence.
const codexIdle = panes.observedCodexPane('idle-empty')
const codexSlash = panes.observedCodexPane('slash-popup')
const codexSoftWrap = JSON.parse(readFileSync(new URL('./fixtures/codex-native-observations/0.159.2-owned-soft-wrap.json', import.meta.url), 'utf8')) as { message: TagMessage; pane: string }
const wrappedOwn = buildWrapper(codexSoftWrap.message)

describe('native Codex swallowed-Enter soft-wrap ownership', () => {
  // The expected item comes from the scenario's metadata, independently of
  // the three visual rows retained verbatim in the safe native capture.
  test('the complete observed 212-byte production wrapper belongs to the current composer', () => {
    expect(Buffer.byteLength(wrappedOwn)).toBe(212)
    expect(readDeliveryScreen('codex', codexSoftWrap.pane, wrappedOwn)).toEqual({
      kind: 'own', running: false,
      text: '<channel source="slack-channel-router" chat_id="D0CODEX" channel_name="dm"\nmessage_id="1792000100.000010" user="U0OPERATOR" user_id="U0OPERATOR"\nts="1792000100.000010" via="dm">Interleaved Slack item 0.</channel>',
    })
  })
  test.each([
    ['changed body', codexSoftWrap.pane.replace('Interleaved Slack item 0.', 'Interleaved Slack item 1.')],
    ['changed message ID', codexSoftWrap.pane.replace('message_id="1792000100.000010"', 'message_id="1792000100.000011"')],
    ['missing closing tag', codexSoftWrap.pane.replace('Interleaved Slack item 0.</channel>', 'Interleaved Slack item 0.')],
    ['missing continuation', codexSoftWrap.pane.replace('  message_id="1792000100.000010" user="U0OPERATOR" user_id="U0OPERATOR"\n', '')],
    ['unrelated draft', panes.deliveryPane('a new human draft', { agent: 'codex' })],
    ['historical match', panes.deliveryPane('a new human draft', { agent: 'codex', history: codexSoftWrap.pane })],
    ...['[Pasted text #1]', '[Pasted text #2 +59 lines]'].map(marker => [marker, panes.deliveryPane(marker, { agent: 'codex' })]),
  ])('%s cannot authorize Enter', (_label, pane) => {
    expect(readDeliveryScreen('codex', pane!, wrappedOwn).kind).toBe('input')
  })
  test.each(['I have 5% left to do', 'model: run my draft instead'])('footer-like suffix %p is part of the draft in wrapped and unwrapped composers', suffix => {
    const extraDraft = codexSoftWrap.pane.replace('\n\n  GPT-6-Astra', `\n  ${suffix}\n\n  GPT-6-Astra`)
    expect(readDeliveryScreen('codex', extraDraft, wrappedOwn).kind).toBe('input')
    const unwrapped = panes.deliveryPane(wrappedOwn, { agent: 'codex' })
    expect(readDeliveryScreen('codex', unwrapped, wrappedOwn)).toEqual({ kind: 'own', text: wrappedOwn, running: false })
    expect(readDeliveryScreen('codex', panes.deliveryPane(`${wrappedOwn}\n${suffix}`, { agent: 'codex' }), wrappedOwn).kind).toBe('input')
  })
  test('an arbitrary genuine bottom footer leaves all three owned composer rows intact', () => {
    const pane = codexSoftWrap.pane.replace('⚠ 4 warnings · f2 to view', 'custom status: checks complete')
    expect(readDeliveryScreen('codex', pane, wrappedOwn).kind).toBe('own')
  })
  test.each([
    ['word wrap', 'Interleaved Slack\n  item 0.'],
    ['column wrap', 'Interleaved Slack it\n  em 0.'],
  ])('%s is resolved against the entire known item', (_label, display) => {
    const pane = codexSoftWrap.pane.replace('Interleaved Slack item 0.', display)
    expect(readDeliveryScreen('codex', pane, wrappedOwn).kind).toBe('own')
  })
  test.each(['first line\nsecond line', 'first longword\n\n   \nsecond line'])('real newlines and whitespace-only rows in %p survive ownership matching', body => {
    const own = buildWrapper({ ...codexSoftWrap.message, text: body })
    const displayed = body.replace('longword', 'longwo\nrd').replaceAll('\n', '\n  ')
    const pane = codexSoftWrap.pane.replace('Interleaved Slack item 0.', displayed)
    expect(readDeliveryScreen('codex', pane, own).kind).toBe('own')
  })
  test.each([
    ['added blank row', 'first longwo\n  rd\n\n\n     \n  second line'],
    ['removed blank row', 'first longwo\n  rd\n     \n  second line'],
    ['removed whitespace row', 'first longwo\n  rd\n\n  second line'],
    ['changed whitespace row', 'first longwo\n  rd\n\n    \n  second line'],
    ['removed body row', 'first longwo\n  rd\n\n     '],
    ['added body row', 'first longwo\n  rd\n\n     \n  second line\n  another line'],
  ])('%s prevents ownership even with the same wrapper prefix', (_label, displayed) => {
    const own = buildWrapper({ ...codexSoftWrap.message, text: 'first longword\n\n   \nsecond line' })
    expect(readDeliveryScreen('codex', codexSoftWrap.pane.replace('Interleaved Slack item 0.', displayed), own).kind).toBe('input')
  })
})

describe('observed native Codex 0.159.2 composer boundaries', () => {
  test.each([
    ['idle-empty', 'empty', undefined, false],
    ['slash-popup', 'menu', undefined, false],
    ['at-popup', 'menu', undefined, false],
    ['dollar-popup', 'menu', undefined, false],
    ['shortcuts-overlay', 'menu', undefined, false],
    ['slash-popup-after-Escape', 'input', '/', false],
    ['at-popup-after-Escape', 'input', '@', false],
    ['dollar-popup-after-Escape', 'input', '$', false],
    ['shortcuts-overlay-after-Escape', 'empty', undefined, false],
    ['idle-one-line-draft', 'input', 'draft observation', false],
    ['idle-one-line-draft-after-Escape', 'input', 'draft observation', false],
    ['idle-multiline-draft', 'input', 'first draft line\nsecond draft line', false],
    ['idle-multiline-draft-after-Escape', 'input', 'first draft line\nsecond draft line', false],
    ['busy-one-line-draft', 'input', 'busy draft observation', true],
    ['busy-one-line-draft-after-Escape', 'input', 'busy draft observation', false],
    ['busy-multiline-draft', 'input', 'busy first line\nbusy second line', true],
    ['busy-multiline-draft-after-Escape', 'input', 'busy first line\nbusy second line', false],
    ['send-no-new-turn-after-Escape', 'input', 'unsubmitted observation draft', false],
  ] as const)('%s capture and ANSI-decorated capture retain their verdict', (label, kind, text, running) => {
    const pane = panes.observedCodexPane(label), expected = { kind, ...(text === undefined ? {} : { text }), running }
    expect(readDeliveryScreen('codex', pane, '<channel>unrelated in-flight item</channel>')).toEqual(expected)
    const colored = pane.split('\n').map(line => `\x1b[32m${line}\x1b[0m`).join('\r\n')
    expect(readDeliveryScreen('codex', `${colored}\n   \n`)).toEqual(expected)
  })
  test.each([['slash-popup', '/'], ['at-popup', '@'], ['dollar-popup', '$']] as const)('%s blocks even if its marker belongs to an in-flight item', (label, marker) => {
    expect(readDeliveryScreen('codex', panes.observedCodexPane(label), marker)).toEqual({ kind: 'menu', running: false })
  })
  test.each(['/', '/model', 'a human draft'])('historical chooser cannot hide current input %p', draft => {
    const pane = panes.deliveryPane(draft, { agent: 'codex', history: codexSlash })
    expect(readDeliveryScreen('codex', pane)).toEqual({ kind: 'input', text: draft, running: false })
  })
  test('historical chooser cannot block the current recorded idle composer', () => {
    expect(readDeliveryScreen('codex', `${codexSlash}${codexIdle}`)).toEqual({ kind: 'empty', running: false })
  })
  test('a historical command and ordinary slash draft do not prove a chooser', () => {
    const pane = panes.deliveryPane('/', { agent: 'codex', history: '› /model         choose what model and reasoning effort to use\n' })
    expect(readDeliveryScreen('codex', pane)).toEqual({ kind: 'input', text: '/', running: false })
  })
  test.each([['at-popup', '@'], ['dollar-popup', '$'], ['shortcuts-overlay', 'human draft']] as const)('historical %s cannot block a current composer or claim its text', (label, draft) => {
    const history = panes.observedCodexPane(label)
    expect(readDeliveryScreen('codex', `${history}${codexIdle}`)).toEqual({ kind: 'empty', running: false })
    expect(readDeliveryScreen('codex', panes.deliveryPane(draft, { agent: 'codex', history }), '<channel>mine</channel>')).toEqual({ kind: 'input', text: draft, running: false })
  })
  test.each([
    ['idle-multiline-draft', 'first draft line\nsecond draft line', false],
    ['busy-one-line-draft', 'busy draft observation', true],
    ['busy-multiline-draft', 'busy first line\nbusy second line', true],
  ] as const)('%s recognizes ownership only at the current composer', (label, own, running) => {
    const pane = panes.observedCodexPane(label)
    expect(readDeliveryScreen('codex', pane, own)).toEqual({ kind: 'own', text: own, running })
    // A complete historical match must never authorize Enter into new text.
    expect(readDeliveryScreen('codex', panes.deliveryPane('a new draft', { agent: 'codex', history: pane }), own)).toEqual({ kind: 'input', text: 'a new draft', running })
  })
  test.each([
    ['at-popup', '@'], ['dollar-popup', '$'],
  ] as const)('%s needs the selected block next to its current hint', (label, marker) => {
    const pane = panes.observedCodexPane(label)
    const separated = pane.replace(`\n› ${marker}\n`, `\n  unrelated intervening text\n› ${marker}\n`)
    expect(readDeliveryScreen('codex', separated)).toEqual({ kind: 'input', text: marker, running: false })
    const withoutSelection = pane.replace(/^› (?![@$]\s*$).+$/m, '  ordinary unselected row')
    expect(readDeliveryScreen('codex', withoutSelection)).toEqual({ kind: 'input', text: marker, running: false })
  })
  test('shortcuts needs both its adjacent header block and bottom close hint', () => {
    const pane = panes.observedCodexPane('shortcuts-overlay')
    expect(readDeliveryScreen('codex', pane.replace('  ? / esc close', '  custom worktree status'))).toEqual({ kind: 'empty', running: false })
    expect(readDeliveryScreen('codex', pane.replace('  /keymap customize', '› earlier prompt\n  ordinary output'))).toEqual({ kind: 'empty', running: false })
  })
  test('native draft keeps its last line while a configured footer occupies only the bottom row', () => {
    const pane = panes.observedCodexPane('idle-multiline-draft')
    const footerStart = pane.indexOf('  GPT-6-Astra')
    expect(readDeliveryScreen('codex', `${pane.slice(0, footerStart)}  custom worktree status\n`)).toEqual({ kind: 'input', text: 'first draft line\nsecond draft line', running: false })
  })
})

// b.omv SR-14.2 case 10: native 2.1.280/296 panes captured in E6.
describe('observed native Claude composer forms', () => {
  test.each([
    '⏸ manual mode on · ? for shortcuts · ← for agents         ◐ medium · /effort',
    '⏸ manual mode on                                          ◐ medium · /effort',
  ])('NBSP prompt and manual footer %p are idle', footer => {
    expect(readDeliveryScreen('claude', `────────────────
❯\u00a0
────────────────
  ${footer}
`)).toEqual({ kind: 'empty', running: false })
  })
  test.each(['[Pasted text #1]', '[Pasted text #2 +59 lines]'])('long/taller-than-read marker %p belongs only to an in-flight item', marker => {
    const pane = `────────────────
❯\u00a0${marker}
────────────────
  paste again to expand
`
    expect(readDeliveryScreen('claude', pane, '<channel>known item</channel>')).toEqual({ kind: 'own', text: marker, running: false })
    expect(readDeliveryScreen('claude', pane).kind).toBe('input')
  })
  test('soft wraps at words and columns recognize the complete item, rejecting an unrelated draft', () => {
    const own = '<channel source="slack-channel-router" chat_id="D1">longword tail</channel>'
    const shown = '<channel source="slack-channel-router"\nchat_id="D1">longwo\nrd tail</channel>'
    const pane = (text: string) => `────────────────
❯\u00a0${text.replaceAll('\n', '\n  ')}
────────────────
  ⏸ manual mode on
`
    expect(readDeliveryScreen('claude', pane(shown), own).kind).toBe('own')
    expect(readDeliveryScreen('claude', pane(shown.replace('tail', 'human draft')), own).kind).toBe('input')
    expect(readDeliveryScreen('claude', pane(shown.replace('</channel>', '</wrong>')), own).kind).toBe('input')
  })
})

// Verbatim safe read-pane capture from Test 39, full CI 20261016t203545z-4p0a3mof.
// Keep the native header/history, 80-column rules, NBSP and l> residue together.
const observedSeparatorPane = readFileSync(new URL('./fixtures/claude-observed-separator-pane.txt', import.meta.url), 'utf8')

// Verbatim 2.1.302 pane from real-1792330301504-109565, fidelity-failure-evidence.json
// (idle_diagnostic.pane). Only the variants below are derived controls.
const observedShortFooterPane = readFileSync(new URL('./fixtures/claude-2.1.302-empty-residue-pane.txt', import.meta.url), 'utf8')

describe.each([
  ['captured short footer', observedShortFooterPane],
  ['agents shortcut footer', observedShortFooterPane.replace('⏸ manual mode on · ? for shortcuts', '⏸ manual mode on · ? for shortcuts · ← for agents')],
])('native residue with %s', (_name, pane) => {
  test('the empty composer is ready', () => {
    expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'empty', running: false })
  })
  test('a draft cannot authorize Enter', () => {
    expect(readDeliveryScreen('claude', pane.replace('❯\u00a0\n', '❯\u00a0<channel>mine</channel>\n'), '<channel>mine</channel>')).toEqual({ kind: 'menu', running: false })
  })
  test('mismatched rule widths cannot prove an empty composer', () => {
    expect(readDeliveryScreen('claude', pane.replace('─'.repeat(80) + '\n', '─'.repeat(79) + '\n'))).toEqual({ kind: 'menu', running: false })
  })
  test('a current selection menu blocks even after the observed idle frame', () => {
    expect(readDeliveryScreen('claude', `${pane}\n${panes.SELECT_MENU_PANE}`)).toEqual({ kind: 'menu', running: false })
  })
})

describe('observed native empty frame after an emoji turn', () => {
  test.each([
    ['verbatim capture', observedSeparatorPane],
    ['ANSI and trailing blank pane padding', `\x1b[32m${observedSeparatorPane}\x1b[0m\n   \n\n`],
  ])('%s is an empty composer', (_name, pane) => {
    expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'empty', running: false })
  })
  test('the frame does not hide a running turn above it', () => {
    expect(readDeliveryScreen('claude', observedSeparatorPane.replace('✻ Baked for 4s · done 8:42 PM', '✻ Thinking… (2s · ↓ 100 tokens)'))).toEqual({ kind: 'empty', running: true })
  })
  test.each([
    ['human draft', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0a human draft\n')],
    ['known in-flight text', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0<channel>mine</channel>\n')],
    ['literal residue in the composer', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0l>draft\n')],
    ['numbered selection', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a01. Yes\n')],
    ['multiline draft', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0\n  a human draft\n')],
    ['extra empty composer row', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0\n\n')],
    ['different upper width', observedSeparatorPane.replace('─'.repeat(80) + '\n', '─'.repeat(79) + '\n')],
    ['missing upper rule', observedSeparatorPane.replace('─'.repeat(80) + '\n', '')],
    ['unknown residue', observedSeparatorPane.replace('l>─', 'x>─')],
    ['missing footer', observedSeparatorPane.slice(0, observedSeparatorPane.lastIndexOf('  ⏸'))],
    ['unknown footer', observedSeparatorPane.replace('⏸ manual mode on · ? for shortcuts · ← for agents', '⏸ manual mode on · unknown status')],
    ['menu overlay', `${observedSeparatorPane}Enter to select · Esc to cancel\n`],
  ])('%s supplies no empty or own-text proof', (_name, pane) => {
    expect(readDeliveryScreen('claude', pane, '<channel>mine</channel>')).toEqual({ kind: 'menu', running: false })
  })
  test('a normal lower rule preserves a literal l> draft as input', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('l>draft'))).toEqual({ kind: 'input', text: 'l>draft', running: false })
  })
  test('a historical observed frame cannot hide the current human draft', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('current human draft', { history: observedSeparatorPane }))).toEqual({ kind: 'input', text: 'current human draft', running: false })
  })
})
