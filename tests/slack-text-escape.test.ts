/**
 * slack-text-escape.test.ts — `escapeSlackControlCharacters` from
 * src/slack-text-escape.ts, called directly.
 *
 * `&` → `&amp;` first, so an entity the function writes is never escaped
 * again within one call; `<` → `&lt;`; `>` → `&gt;`; nothing else changes.
 * It is not idempotent: an already-escaped text is escaped again, so the post
 * shows the entity as written. Its two callers are covered where they render:
 * the lost-message sender label (tests/inbound-recovery-drop-branch.test.ts,
 * tests/dispatch-get-stream.test.ts) and the `ad-config-malformed` onset
 * (tests/outage-state.test.ts).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'

describe('escapeSlackControlCharacters', () => {
  test.each([
    ['a lone ampersand', '&', '&amp;'],
    ['a lone <', '<', '&lt;'],
    ['a lone >', '>', '&gt;'],
    ['a broadcast mention', '<!channel>', '&lt;!channel&gt;'],
    ['a user mention', '<@U0123ABCD>', '&lt;@U0123ABCD&gt;'],
    ['a labelled link', '<https://example.invalid|here>', '&lt;https://example.invalid|here&gt;'],
    ['a mix, every occurrence', 'a & b <c> && <<d>>', 'a &amp; b &lt;c&gt; &amp;&amp; &lt;&lt;d&gt;&gt;'],
    ['an ampersand next to < and >, escaped once each', '&<&>&', '&amp;&lt;&amp;&gt;&amp;'],
  ])('%s: %p → %p', (_label, input, expected) => {
    expect(escapeSlackControlCharacters(input)).toBe(expected)
  })

  test.each([
    ['empty text', ''],
    ['plain words and punctuation', 'config.toml: [tmux] starting_session_seconds = 30, below 60 s!'],
    ['quotes, pipes, emoji codes, markdown and non-ASCII', `"x" 'y' | :rotating_light: *bold* _it_ \`code\` — é ✓`],
    ['line breaks and tabs', 'one\ntwo\r\nthree\tfour'],
  ])('%s: returned unchanged', (_label, input) => {
    expect(escapeSlackControlCharacters(input)).toBe(input)
  })

  test('not idempotent: escaped text is escaped again (its & becomes &amp;)', () => {
    const once = escapeSlackControlCharacters('<!channel> & co')
    expect(once).toBe('&lt;!channel&gt; &amp; co')
    expect(escapeSlackControlCharacters(once)).toBe('&amp;lt;!channel&amp;gt; &amp;amp; co')
  })

  test('an entity already in the input is escaped as text, not kept', () => {
    expect(escapeSlackControlCharacters('&lt; &gt; &amp; &#60;')).toBe('&amp;lt; &amp;gt; &amp;amp; &amp;#60;')
  })
})
