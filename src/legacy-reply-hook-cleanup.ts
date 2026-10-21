/** Remove the retired transcript-reading hook from configured bot directories. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readPersonaConfigBytes, resolveRealPath } from './config.ts'
import { durableWriteFileSync } from './atomic-write.ts'

const LEGACY_HOOK_MARKER = 'slack-reply-guard.sh'
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only the historic executable invocation, bare or POSIX single-quoted. */
function legacyCommand(hook: unknown): boolean {
  if (!object(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return false
  // Bootstrap emitted an absolute guard path and, in later versions, one
  // absolute reply-guard directory. Never recognize a shell expression or
  // another hook type merely because it mentions the script's filename.
  const words = hook.command.match(/^('(?:[^']|'\\'')*'|\/[^\s'"\\`$;&|<>()]+)(?:[ \t]+('(?:[^']|'\\'')*'|\/[^\s'"\\`$;&|<>()]+))?$/)
  if (!words || /[\r\n]/.test(hook.command)) return false
  const unquote = (word: string): string => word.startsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word
  const executable = unquote(words[1]!)
  const directory = words[2] === undefined ? undefined : unquote(words[2])
  return executable.startsWith('/') && executable.endsWith(`/${LEGACY_HOOK_MARKER}`)
    && (directory === undefined || (directory.startsWith('/') && directory.endsWith('/reply-guard')))
}

/** Migration only: never creates a file or installs a hook; preserves unrelated settings. */
export function removeLegacyReplyHooks(dirs: readonly (string | undefined)[], log: (line: string) => void = console.error): void {
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!dir?.trim()) continue
    const real = resolveRealPath(dir)
    if (seen.has(real)) continue
    seen.add(real)
    if (real === resolveRealPath(join(homedir(), '.claude'))) {
      log('[slack] reply-reminder: refusing to clean legacy hooks in the operator config directory')
      continue
    }
    const path = join(real, 'settings.json')
    try {
      const doc: unknown = JSON.parse(readPersonaConfigBytes(path).toString('utf8'))
      if (!object(doc) || !object(doc.hooks) || !Array.isArray(doc.hooks.Stop)) continue
      let changed = false
      const groups: unknown[] = []
      for (const group of doc.hooks.Stop) {
        if (!object(group) || !Array.isArray(group.hooks)) { groups.push(group); continue }
        const kept = group.hooks.filter(hook => !legacyCommand(hook))
        if (kept.length === group.hooks.length) { groups.push(group); continue }
        changed = true
        if (kept.length) groups.push({ ...group, hooks: kept })
      }
      if (!changed) continue
      const updated = { ...doc, hooks: { ...doc.hooks, Stop: groups } }
      durableWriteFileSync(path, Buffer.from(JSON.stringify(updated, null, 2) + '\n'))
      log('[slack] reply-reminder: removed the legacy Stop hook')
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') continue
      // Parser/library errors can contain settings values. Report no contents.
      log('[slack] reply-reminder: legacy hook cleanup failed; retrying on the next launch')
    }
  }
}
