/** AI readback syntax checks must never execute the literal command body.
 * Keep the ordinary gate's assertion intact; this also rejects a model's Bash
 * tool request even when it subsequently returns the exact expected JSON.
 */
import { existsSync } from 'node:fs'
import { packedReceiptAdapters, readTranscripts, transcriptFiles, type TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'

export function assertAIReadbackNoShell(entries: readonly TranscriptEntry[]) {
  for (const { value } of entries) {
    if (value?.type === 'user' && /<bash-(?:input|stdout|stderr)>/.test(JSON.stringify(value.message?.content) ?? '')) {
      throw new Error('AI readback body entered native bash mode')
    }
    const content = value?.message?.content
    if (value?.type === 'assistant' && Array.isArray(content) && content.some(b => b.type === 'tool_use' && b.name === 'Bash')) {
      throw new Error('AI readback requested a Bash tool action')
    }
  }
}

if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('AI no-shell observer requires the CI image')
    const root = process.argv[2]
    if (!root) throw new Error('AI no-shell observer requires transcripts')
    assertAIReadbackNoShell(readTranscripts(transcriptFiles(root), await packedReceiptAdapters()))
  } catch (error) { console.error(error instanceof Error ? error.message : 'AI no-shell observation unavailable'); process.exitCode = 1 }
}
