/** Consumed native task notifications, not queue bookkeeping or assistant prose.
 * Shapes audited in 2.1.280/296/302; see fixtures/native-denial-completion. */
export function nativeTaskNotificationContent(value: any): unknown {
  if (value?.type === 'user') return value.message?.content
  if (value?.type === 'attachment' && value.attachment?.type === 'queued_command') return value.attachment.prompt
  return undefined
}

/** Only notification header fields are identity evidence. A result/summary may
 * quote another notification, and must never supply its parent's linkage. */
export function taskNotificationFields(content: unknown): Record<string, string | undefined> | undefined {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : ''
  const notifications = [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)]
  if (notifications.length !== 1) return undefined
  const header = notifications[0]![1]!.split(/<(?:summary|result|usage)>/, 1)[0]!
  if (header.includes('<task-notification>')) return undefined
  const fields: Record<string, string | undefined> = {}
  for (const tag of ['task-id', 'tool-use-id', 'status']) {
    const values = [...header.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))]
    if (values.length > 1) return undefined
    fields[tag] = values[0]?.[1]
  }
  return fields
}
