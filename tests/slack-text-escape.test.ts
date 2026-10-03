/**
 * slack-text-escape.test.ts — `escapeSlackControlCharacters` from
 * src/slack-text-escape.ts, called directly.
 *
 * `&` → `&amp;` first, so an entity the function writes is never escaped
 * again within one call; `<` → `&lt;`; `>` → `&gt;`; nothing else changes.
 * It is not idempotent: an already-escaped text is escaped again, so the post
 * shows the entity as written. Its three callers are covered where they
 * render: the lost-message sender label (tests/inbound-recovery-drop-branch.test.ts,
 * tests/dispatch-get-stream.test.ts), the `ad-config-malformed` onset
 * (tests/outage-state.test.ts) and the unclassified-error alert's quoted
 * message in src/persona-episodes.ts (tests/persona-episodes.test.ts).
 *
 * `unescapeSlackControlCharacters` undoes it: `&lt;` → `<`, `&gt;` → `>`,
 * then `&amp;` → `&` (last, so `&amp;lt;` becomes `&lt;`); nothing else
 * changes, and escaping then unescaping gives the text back. Its caller, the
 * persona teardown window's entry and line, is covered in
 * tests/persona-notifier.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { escapeSlackControlCharacters, unescapeSlackControlCharacters } from '../src/slack-text-escape.ts'

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

  test('not idempotent: escaped text, or an entity already in the input, is escaped again as text (its & becomes &amp;)', () => {
    const once = escapeSlackControlCharacters('<!channel> & co')
    expect(once).toBe('&lt;!channel&gt; &amp; co')
    expect(escapeSlackControlCharacters(once)).toBe('&amp;lt;!channel&amp;gt; &amp;amp; co')
    expect(escapeSlackControlCharacters('&lt; &gt; &amp; &#60;')).toBe('&amp;lt; &amp;gt; &amp;amp; &amp;#60;')
  })
})

describe('unescapeSlackControlCharacters', () => {
  test.each([
    ['a lone &amp;', '&amp;', '&'],
    ['a lone &lt;', '&lt;', '<'],
    ['a lone &gt;', '&gt;', '>'],
    ['an escaped broadcast mention', '&lt;!channel&gt;', '<!channel>'],
    ['a mix, every occurrence', 'a &amp; b &lt;c&gt; &amp;&amp; &lt;&lt;d&gt;&gt;', 'a & b <c> && <<d>>'],
    ['&amp; undone last: a doubly escaped entity is undone once', '&amp;lt; &amp;gt; &amp;amp;', '&lt; &gt; &amp;'],
  ])('%s: %p → %p', (_label, input, expected) => {
    expect(unescapeSlackControlCharacters(input)).toBe(expected)
  })

  test.each([
    ['empty text', ''],
    ['plain words and punctuation', 'config.toml: [tmux] starting_session_seconds = 30, below 60 s!'],
    ['the raw characters, and entities it does not undo', 'a & b <c> > &quot; &#60; &nbsp; &amp'],
    ['line breaks and tabs', 'one\ntwo\r\nthree\tfour'],
  ])('%s: returned unchanged', (_label, input) => {
    expect(unescapeSlackControlCharacters(input)).toBe(input)
  })

  test.each([
    ['a broadcast mention and an ampersand', '<!channel> & co'],
    ['an entity written as text', '&lt; &gt; &amp; &#60;'],
    ['a mix with line breaks', 'one <a>\ntwo && <<b>>'],
  ])('the inverse of escaping: %s comes back as it was', (_label, input) => {
    expect(unescapeSlackControlCharacters(escapeSlackControlCharacters(input))).toBe(input)
  })
})
