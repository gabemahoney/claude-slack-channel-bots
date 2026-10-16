/** Shared appended system prompt, regenerated before launches (b.omv SR-7.2). */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PersonaConfig } from './config.ts'
import { TAG_DESCRIPTION } from './tag-description.ts'

export const BOT_SYSTEM_PROMPT_FILENAME = 'bot-system-prompt.md'
export function botSystemPromptPath(stateDir: string): string {
  return join(stateDir, BOT_SYSTEM_PROMPT_FILENAME)
}

export interface BotSystemPromptDeps {
  readFile: (path: string) => string
  writeFile: (path: string, content: string) => void
  log: (line: string) => void
}

/** A unique, exclusively created 0600 sibling; rename never follows a stale target symlink. */
function writeProtectedPrompt(path: string, content: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, path)
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* rename succeeded, or best-effort cleanup */ }
  }
}

/** Throws on any write failure, even if an old readable prompt remains. No import-time I/O. */
export function prepareBotSystemPrompt(
  config: Pick<PersonaConfig, 'system_prompt_mode' | 'append_system_prompt_file'>,
  stateDir: string,
  overrides: Partial<BotSystemPromptDeps> = {},
): string {
  const d: BotSystemPromptDeps = {
    readFile: path => fs.readFileSync(path, 'utf8'),
    writeFile: writeProtectedPrompt,
    log: line => console.error(line),
    ...overrides,
  }
  let content = TAG_DESCRIPTION
  if (config.system_prompt_mode === 'append' && config.append_system_prompt_file !== undefined) {
    try {
      content += '\n\n' + d.readFile(config.append_system_prompt_file)
    } catch {
      d.log(`[slack] template: append_system_prompt_file not readable, omitting flag: ${config.append_system_prompt_file}`)
    }
  }
  const path = botSystemPromptPath(stateDir)
  d.writeFile(path, content)
  return path
}
