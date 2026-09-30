/**
 * markdown-helper.test.ts — the shared Markdown reader the shipped-doc tests
 * use (tests/test-helpers/markdown.ts): headings outside fenced code only,
 * sections ended by the next heading of the same or a higher level, a missing
 * required section throwing with the file and heading named, fences split out
 * by kind, GitHub-style anchors, and the `###` heading naming a class label.
 *
 * Pure: in-memory strings only, nothing read or written.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { classHeading, findSection, headingAnchors, headingSlug, headings, requiredSection, sectionRange, splitFences } from './test-helpers/markdown.ts'

const DOC = [
  '# Title', //                0
  '## One', //                 1
  'one body', //               2
  '```bash', //                3
  '# a shell comment', //      4
  '```', //                    5
  '~~~', //                    6
  '```', //                    7  a backtick run inside a tilde fence
  '## not a heading', //       8
  '~~~', //                    9
  '### One A', //              10
  'nested', //                 11
  '## Two', //                 12
  'two body', //               13
].join('\n')

describe('headings and sections', () => {
  test('headings skip every line inside a ``` or ~~~ fence, including a ``` line inside ~~~', () => {
    expect(headings(DOC).map((h) => h.text)).toEqual(['# Title', '## One', '### One A', '## Two'])
  })

  test('a section runs to the next heading of the same or a higher level, nested ones included', () => {
    expect(sectionRange(DOC, '## One')).toEqual({ start: 1, end: 12 })
    expect(findSection(DOC, '### One A')).toBe('nested')
    expect(findSection(DOC, /^## Tw/)).toBe('two body')
  })

  test('a string names a heading exactly, level included', () => {
    expect(findSection(DOC, '### Two')).toBeUndefined()
    expect(findSection(DOC, '## On')).toBeUndefined()
  })

  test('an inline ```code``` line opens no fence', () => {
    expect(headings('```x``` inline\n## After').map((h) => h.text)).toEqual(['## After'])
  })

  test.each([
    ['## Missing', 'DOC.md has no heading "## Missing"'],
    [/^## Miss/, 'DOC.md has no heading matching /^## Miss/'],
  ] as const)('requiredSection throws naming the file and %p', (match, message) => {
    expect(() => requiredSection(DOC, match, 'DOC.md')).toThrow(message)
  })
})

describe('splitFences', () => {
  test('separates prose from each block, with its info word and exact body', () => {
    const { prose, blocks } = splitFences(DOC)
    expect(blocks).toEqual([
      { info: 'bash', body: '# a shell comment' },
      { info: '', body: '```\n## not a heading' },
    ])
    expect(prose).not.toContain('shell comment')
    expect(prose).toContain('two body')
  })

  test('an unclosed block runs to the end', () => {
    expect(splitFences('text\n```json\n{}').blocks).toEqual([{ info: 'json', body: '{}' }])
  })
})

describe('anchors', () => {
  test("headingSlug is GitHub's: lower case, punctuation dropped, spaces to hyphens", () => {
    expect(headingSlug("Rotate a persona's tokens")).toBe('rotate-a-personas-tokens')
    expect(headingSlug('Step 4 — Add a persona')).toBe('step-4--add-a-persona')
    expect(headingSlug('`persona-credentials-refused`')).toBe('persona-credentials-refused')
  })

  test('a repeated heading gets -1, -2 as on GitHub', () => {
    expect(headingAnchors('## Notes\n## Notes\n## Notes')).toEqual(['notes', 'notes-1', 'notes-2'])
  })
})

describe('classHeading', () => {
  test('matches the `###` heading naming the label as a code span, bare or with a title after it', () => {
    expect(classHeading('a.b-c').test('### `a.b-c`')).toBe(true)
    expect(classHeading('a.b-c').test('### `a.b-c` — the binary is too old')).toBe(true)
  })

  test('matches the label literally, at level 3 only, and never a longer label', () => {
    expect(classHeading('a.b-c').test('### `aXb-c`')).toBe(false)
    expect(classHeading('a.b-c').test('### `a.b-c-d`')).toBe(false)
    expect(classHeading('a.b-c').test('## `a.b-c`')).toBe(false)
    expect(classHeading('a.b-c').test('#### `a.b-c`')).toBe(false)
  })

  test('finds its section through the Markdown reader', () => {
    expect(findSection('## Refusals\n### `a.b-c` — title\nbody\n### `other`\nnext', classHeading('a.b-c'))).toBe('body')
  })
})
