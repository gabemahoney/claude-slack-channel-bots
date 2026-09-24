/**
 * shipped-docs.test.ts — audits files the package ships to the operator
 * (b.av2 SR-13.5). One `describe` per shipped file.
 *
 * Starts with the Slack app manifest (b.av2 AC 39, SR-4.3, SR-12). E14 extends
 * it into the full shipped-docs audit (README, skills, MCP instructions).
 *
 * Reads repo files only, resolved from this file's location so the working
 * directory doesn't matter. No temp files, no real HOME, no server, no CLI
 * (SR-13.2).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

/** A quote may open a YAML scalar only at its start: line start or after `:`, `-`, `[`, `{`, `,`. */
function opensQuotedScalar(before: string): boolean {
  const prev = before.trimEnd()
  return prev === '' || /[:\-[{,]$/.test(prev)
}

/**
 * The text of every YAML comment (full-line `#` comments and inline ` # …`
 * tails), joined with spaces so a phrase wrapped across comment lines still
 * matches a `\s+`-separated pattern.
 *
 * A `#` inside a quoted scalar (which may span lines) or inside a block scalar
 * (`|` / `>`) body is value text, not a comment, and is skipped.
 */
function yamlComments(text: string): string {
  const comments: string[] = []
  let quote: '"' | "'" | null = null
  let blockParentIndent: number | null = null
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (blockParentIndent !== null) {
      if (line.trim() === '' || indent > blockParentIndent) continue
      blockParentIndent = null
    }
    let content = line
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote === '"') {
        if (ch === '\\') i++
        else if (ch === '"') quote = null
      } else if (quote === "'") {
        if (ch === "'" && line[i + 1] === "'") i++
        else if (ch === "'") quote = null
      } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        comments.push(line.slice(i + 1))
        content = line.slice(0, i)
        break
      } else if ((ch === '"' || ch === "'") && opensQuotedScalar(line.slice(0, i))) {
        quote = ch
      }
    }
    if (quote === null && /(?:^|[:-])\s*[|>][-+1-9]*\s*$/.test(content)) {
      blockParentIndent = indent
    }
  }
  return comments.join(' ')
}

describe('slack-app-manifest.yml', () => {
  const text = readRepoFile('slack-app-manifest.yml')
  const manifest = Bun.YAML.parse(text) as {
    features: { app_home: Record<string, unknown> }
    oauth_config: { scopes: { bot: string[] } }
    settings: { event_subscriptions: { bot_events: string[] } }
  }
  const comments = yamlComments(text)

  test('AC 39: the bot scopes include im:write', () => {
    expect(manifest.oauth_config.scopes.bot).toContain('im:write')
  })

  test('SR-4.3: message.im stays subscribed and message.mpim is not (group DMs unsubscribed)', () => {
    const events = manifest.settings.event_subscriptions.bot_events
    expect(events).toContain('message.im')
    expect(events).not.toContain('message.mpim')
  })

  test('the bot scopes are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual(
      [
        'app_mentions:read',
        'channels:history',
        'chat:write',
        'files:read',
        'files:write',
        'groups:history',
        'im:history',
        'im:write',
        'reactions:write',
        'users:read',
      ].sort(),
    )
  })

  test('the bot events are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual(
      ['app_mention', 'message.channels', 'message.groups', 'message.im'].sort(),
    )
  })

  test('the Messages tab is on and writable, so a user can DM the persona', () => {
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true)
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
  })

  test.each([
    ['SLACK_APP_TOKEN', /SLACK_APP_TOKEN/],
    ['SLACK_BOT_TOKEN', /SLACK_BOT_TOKEN/],
    ['an environment variable', /environment\s+variable|\benv\s+var/i],
  ])('SR-12: no comment names %s', (_label, pattern) => {
    expect(comments).not.toMatch(pattern)
  })

  test.each([
    ['one app per persona', /one\s+app\s+per\s+persona/i],
    ['the credentials_file setting', /\bcredentials_file\b/],
    ['the bot_token key', /\bbot_token\b/],
    ['the app_token key', /\bapp_token\b/],
    ['im:write', /\bim:write\b/],
    ['re-installing existing apps', /\bre-?install/i],
  ])('SR-12: the comments name %s', (_label, pattern) => {
    expect(comments).toMatch(pattern)
  })
})
