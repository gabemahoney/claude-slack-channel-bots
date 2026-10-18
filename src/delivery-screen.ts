/** Agent UI details stay behind this adapter (b.omv SR-5.3/5.4). */
export type DeliveryAgent = 'claude' | 'codex'
export type DeliveryScreen = { kind: 'empty' | 'own' | 'input' | 'menu'; text?: string; running: boolean }
export const FULL_PANE_READ_LINES = 40
export function stripDeliveryAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}
const rule = (line: string): boolean => /^\s*[─━\-]{8,}\s*$/.test(line)
/** b.omv SR-5.3/14.2: native 2.1.296 left `l>` over the first two
 * columns of the lower rule after case 10's emoji turn. Recognize only
 * that empty frame: one NBSP prompt row, an intact upper rule of the
 * same width, and the observed manual footer at the bottom (2.1.302
 * also omits the agents shortcut). The residue
 * is never removed from composer text or accepted around a draft.
 */
function observedEmptyClaudeLowerRule(lines: readonly string[], index: number): boolean {
  const lower = lines[index]!
  return /^l>─{8,}$/.test(lower)
    && lines[index - 2] === '─'.repeat(lower.length)
    && lines[index - 1] === '❯\u00a0'
    && index + 2 === lines.length
    && /^⏸ manual mode on · \? for shortcuts(?: · ← for agents)?$/.test(lines[index + 1]!.trim())
}
const menuFooter = /esc to cancel|enter to select|enter to confirm|to navigate/i
const runningLine = /^[✢✳✶✻✽·*].*…(?:\s|$)|^[✢✳✶✻✽·*].*[……].*(?:\(|tokens|thinking)|esc to interrupt|interrupt.*esc/i
/** Native Codex 0.159.2, E7 run 20261017t200216z-lglgkb2l:
 * the slash chooser sits above the current `› /` composer, without a
 * menu footer. Require its adjacent selected command and option rows;
 * a slash draft or a historical command alone is not this popup.
 */
function observedCodexSlashPopup(lines: readonly string[], composer: number): boolean {
  if (!/^\s*› \/\s*$/.test(lines[composer]!)) return false
  let index = composer - 1, options = 0
  while (index >= 0 && !lines[index]!.trim()) index--
  for (; index >= 0; index--) {
    const line = lines[index]!
    if (/^  \/[a-z][a-z-]* {2,}\S/.test(line)) options++
    else if (/^› \/[a-z][a-z-]* {2,}\S/.test(line)) return options >= 2
    else if (!/^ {3,}\S/.test(line)) return false
  }
  return false
}
/** b.omv SR-5.3: native 0.159.2, E7 run 20261017t212743z-ddde5cd6.
 * The @/$ choosers put their insert/close hint immediately above the
 * current composer. Require that hint and its adjacent selected option
 * block; historical chooser text and a bare @/$ draft are not menus.
 */
function observedCodexInsertPopup(lines: readonly string[], composer: number): boolean {
  const marker = lines[composer]!.match(/^\s*› ([@$])\s*$/)?.[1]
  if (!marker) return false
  let index = composer - 1
  while (index >= 0 && !lines[index]!.trim()) index--
  const hint = marker === '@' ? 'enter/tab insert · esc close · ↑/↓ select · ←/→ filter' : 'enter insert · esc close'
  if (lines[index]?.trim() !== hint) return false
  index--
  while (index >= 0 && (!lines[index]!.trim() || lines[index]!.trim() === '↓')) index--
  const option = marker === '@' ? /^  \S.* {2,}\S.* {2,}Skill$/ : /^  \S.* {2,}\[(?:Skill|App)\] \S/
  const selected = marker === '@' ? /^› \S.* {2,}\S.* {2,}Skill$/ : /^› \S.* {2,}\[(?:Skill|App)\] \S/
  let options = 0
  for (; index >= 0; index--) {
    if (option.test(lines[index]!)) options++
    else return options >= 2 && selected.test(lines[index]!)
  }
  return false
}
/** The same native run draws shortcuts above the composer and a close
 * hint at the bottom. Both boundaries must belong to the current block.
 */
function observedCodexShortcutsOverlay(lines: readonly string[], composer: number): boolean {
  if (lines.at(-1)?.trim() !== '? / esc close') return false
  let index = composer - 1
  while (index >= 0 && !lines[index]!.trim()) index--
  if (lines[index]?.trim() !== '/keymap customize') return false
  for (index--; index >= 0; index--) {
    if (/^\s*›(?: |$)/.test(lines[index]!)) return false
    if (lines[index]!.trim() === 'Keyboard shortcuts') return true
  }
  return false
}
/** Native 0.159.2, E7 run 20261018t002342z-m45phlhp, puts its status above the
 * bottom hint row, with an empty frame row before the status. Recognize
 * that extra footer row only in this position, never by scanning drafts
 * for footer-like words. The bottom row's configured text is arbitrary.
 */
function codexFooterStart(block: readonly string[]): number {
  let footer = block.length - 1
  if (footer > 1 && block[footer - 2] === ''
    && /^\s*(?:gpt-|codex-)\S+ (?:default|minimal|low|medium|high|xhigh|max) · \S.*$/i.test(block[footer - 1]!)) footer--
  // The observed frame has one padding row; additional blank rows belong
  // to the composer and must participate in complete ownership matching.
  if (footer > 1 && block[footer - 1] === '') footer--
  return Math.max(1, footer)
}
/** Native Claude and Codex wrap the current composer at a column or word boundary.
 * Codex 0.159.2: E7 run 20261018t002342z-m45phlhp, swallowed-Enter capture.
 * Resolve only those observed display breaks against the known complete
 * item; an unrelated draft sharing a tag's first visual line is not ours.
 * This is a screen ownership rule, never transcript normalization.
 */
function renderedOwnText(displayed: string, own: string, preserveBlankLines = false): boolean {
  const lines = displayed.split('\n')
  let offsets = new Set([0])
  for (let index = 0; index < lines.length; index++) {
    const next = new Set<number>(), line = lines[index]!
    const separators = index === 0 ? [''] : preserveBlankLines && (!line.trim() || !lines[index - 1]!.trim()) ? ['\n'] : ['', ' ', '\n']
    for (const offset of offsets) {
      for (const separator of separators) {
        const start = offset + separator.length
        if (own.startsWith(separator, offset) && own.startsWith(line, start)) next.add(start + line.length)
      }
    }
    if (!next.size) return false
    offsets = next
  }
  return offsets.has(own.length)
}
function observation(text: string, own: string | undefined, running: boolean, claude: boolean, renderedText = text): DeliveryScreen {
  const empty = text.trim() === '' || (claude
    ? /^(?:Try ["“].*["”]|Press up to edit queued messages|Message @\S+…)\s*$/.test(text.trim())
    : /^(?:Ask Codex to do anything|Ask a follow-up question)\s*$/.test(text.trim()))
  if (empty) return { kind: 'empty', running }
  // Claude prefix/paste recognition stays at the current composer (SR-5.4).
  // Codex needs the complete rendered item, including every continuation.
  const prefix = own?.split('\n')[0]
  if (own && ((claude && ((prefix && text.startsWith(prefix)) || text.startsWith('[Pasted text'))) || renderedOwnText(renderedText, own, !claude))) return { kind: 'own', text, running }
  return { kind: 'input', text, running }
}
export function readDeliveryScreen(agent: DeliveryAgent, pane: string, ownText?: string): DeliveryScreen {
  const lines = stripDeliveryAnsi(pane).split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  if (agent === 'claude') {
    let lower = -1
    for (let i = lines.length - 1; i >= 0; i--) if (rule(lines[i]!) || observedEmptyClaudeLowerRule(lines, i)) { lower = i; break }
    if (lower < 0) return { kind: 'menu', running: false }
    const footer = lines.slice(lower + 1)
    if (footer.some(line => menuFooter.test(line))) return { kind: 'menu', running: false }
    // A completed prompt box is followed only by actual footer/status lines.
    // b.omv SR-14.2: native 2.1.296's default/manual-mode footer uses
    // the pause glyph. Observed via real AD read-pane in the E6 container.
    if (footer.some(line => line.trim() && !/^\s*(?:[⏵▶▸]|⏸ manual mode on|paste again to expand(?:\s+◐ medium · \/effort)?$|\?|shift\+|ctrl\+|context|\d+%|\$|auto|accept|bypass|plan mode|permission|←|!)/i.test(line))) return { kind: 'menu', running: false }
    let upper = lower - 1
    while (upper >= 0 && !rule(lines[upper]!)) upper--
    if (upper < 0) return { kind: 'menu', running: false }
    const box = lines.slice(upper + 1, lower)
    const first = box[0]?.match(/^\s*[❯>][ \u00a0]?(.*)$/)
    if (!first) return { kind: 'menu', running: false }
    // A menu cursor (❯ 1. …) inside a bordered dialog is not a composer.
    if (/^\d+[.)]\s/.test(first[1]!)) return { kind: 'menu', running: false }
    return observation([first[1]!, ...box.slice(1).map(s => s.replace(/^  /, ''))].join('\n'), ownText, lines.slice(0, upper).some(line => runningLine.test(line)), true)
  }
  let composer = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*›(?: |$)/.test(lines[i]!)) { composer = i; break }
  if (composer < 0) return { kind: 'menu', running: false }
  if (observedCodexSlashPopup(lines, composer)) return { kind: 'menu', running: false }
  if (observedCodexInsertPopup(lines, composer) || observedCodexShortcutsOverlay(lines, composer)) return { kind: 'menu', running: false }
  const block = lines.slice(composer)
  if (block.some(line => menuFooter.test(line) || /Viewing sub-agent — direct input is disabled/i.test(line))) return { kind: 'menu', running: false }
  const text = [block[0]!.replace(/^\s*› ?/, '')]
  // Keep internal blank rows for complete ownership matching: a human's
  // added blank line must not disappear as a soft wrap.
  const renderedText = [...text]
  // Establish the footer boundary before matching; a human continuation
  // mentioning a model, context or shortcuts is still composer text.
  for (const line of block.slice(1, codexFooterStart(block))) {
    renderedText.push(line.replace(/^  /, ''))
    if (line.trim()) text.push(line.replace(/^  /, ''))
  }
  return observation(text.join('\n'), ownText, lines.slice(0, composer).some(line => runningLine.test(line) || /esc to interrupt/i.test(line)), false, renderedText.join('\n'))
}
