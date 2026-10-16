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
 * same width, and the observed manual footer at the bottom. The residue
 * is never removed from composer text or accepted around a draft.
 */
function observedEmptyClaudeLowerRule(lines: readonly string[], index: number): boolean {
  const lower = lines[index]!
  return /^l>─{8,}$/.test(lower)
    && lines[index - 2] === '─'.repeat(lower.length)
    && lines[index - 1] === '❯\u00a0'
    && index + 2 === lines.length
    && lines[index + 1]!.trim() === '⏸ manual mode on · ? for shortcuts · ← for agents'
}
const menuFooter = /esc to cancel|enter to select|enter to confirm|to navigate/i
const runningLine = /^[✢✳✶✻✽·*].*…(?:\s|$)|^[✢✳✶✻✽·*].*[……].*(?:\(|tokens|thinking)|esc to interrupt|interrupt.*esc/i
/** Native Claude wraps the current composer at a column or a word boundary.
 * Resolve only those observed display breaks against the known complete
 * item; an unrelated draft sharing a tag's first visual line is not ours.
 * This is a screen ownership rule, never transcript normalization.
 */
function renderedOwnText(displayed: string, own: string): boolean {
  const lines = displayed.split('\n')
  let offsets = new Set([0])
  for (let index = 0; index < lines.length; index++) {
    const next = new Set<number>(), line = lines[index]!
    for (const offset of offsets) {
      for (const separator of index === 0 ? [''] : ['', ' ', '\n']) {
        const start = offset + separator.length
        if (own.startsWith(separator, offset) && own.startsWith(line, start)) next.add(start + line.length)
      }
    }
    if (!next.size) return false
    offsets = next
  }
  return offsets.has(own.length)
}
function observation(text: string, own: string | undefined, running: boolean, claude: boolean): DeliveryScreen {
  const empty = text.trim() === '' || (claude
    ? /^(?:Try ["“].*["”]|Press up to edit queued messages|Message @\S+…)\s*$/.test(text.trim())
    : /^(?:Ask Codex to do anything|Ask a follow-up question)\s*$/.test(text.trim()))
  if (empty) return { kind: 'empty', running }
  // Prefix recognition is deliberately conservative: it must start at the
  // composer, never at a quoted historical prompt. Long-paste drawing is SR-5.4.
  const prefix = own?.split('\n')[0]
  if (own && ((prefix && text.startsWith(prefix)) || (claude && (text.startsWith('[Pasted text') || renderedOwnText(text, own))))) return { kind: 'own', text, running }
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
  const block = lines.slice(composer)
  if (block.some(line => menuFooter.test(line) || /Viewing sub-agent — direct input is disabled/i.test(line))) return { kind: 'menu', running: false }
  const text = [block[0]!.replace(/^\s*› ?/, '')]
  // Codex reserves the bottom row for its footer, whose configured text is
  // arbitrary. It is a position, not the '? for shortcuts' string anchor.
  for (const line of block.slice(1, block.length > 1 ? -1 : undefined)) {
    if (/\? for shortcuts|context left|\d+% left|^\s*(?:gpt-|codex-|model:)|esc to interrupt/i.test(line)) break
    if (line.trim()) text.push(line.replace(/^  /, ''))
  }
  return observation(text.join('\n'), ownText, lines.slice(0, composer).some(line => runningLine.test(line) || /esc to interrupt/i.test(line)), false)
}
