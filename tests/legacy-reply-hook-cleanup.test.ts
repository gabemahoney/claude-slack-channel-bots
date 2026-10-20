import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeLegacyReplyHooks } from '../src/legacy-reply-hook-cleanup.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'legacy-reply-cleanup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const retired = (command = '/old/package/stop-hooks/slack-reply-guard.sh /old/state/reply-guard') => ({ type: 'command', command })
function settings(name: string, value: unknown) {
  const config = join(dir, name); mkdirSync(config, { recursive: true })
  const path = join(config, 'settings.json'); writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return { config, path, bytes: () => readFileSync(path, 'utf8') }
}

test('removes legacy Stop entries from all server paths, preserving other hooks, groups and settings', () => {
  const unrelated = { type: 'command', command: '/my/stop-hook.sh' }
  const keep = { matcher: 'other', hooks: [unrelated], extra: 7 }
  const f = settings('bot', { env: { private: LEAK_SENTINEL }, hooks: {
    Stop: [{ matcher: '', hooks: [retired(), unrelated], timeout: 42 }, { hooks: [retired('/another/slack-reply-guard.sh')] }, keep, { future: true }],
    SessionStart: [{ hooks: [unrelated] }],
  }, permissions: { allow: ['Read'] } })
  const lines: string[] = []
  removeLegacyReplyHooks([f.config], line => lines.push(line))
  expect(JSON.parse(f.bytes())).toEqual({ env: { private: LEAK_SENTINEL }, hooks: {
    Stop: [{ matcher: '', hooks: [unrelated], timeout: 42 }, keep, { future: true }], SessionStart: [{ hooks: [unrelated] }],
  }, permissions: { allow: ['Read'] } })
  expect(lines).toEqual(['[slack] reply-reminder: removed the legacy Stop hook'])
  assertNoLeak(lines)
  const after = f.bytes(), inode = statSync(f.path).ino
  removeLegacyReplyHooks([f.config], line => lines.push(line))
  expect(f.bytes()).toBe(after)
  expect(statSync(f.path).ino).toBe(inode)
  expect(lines).toHaveLength(1)
})

test('real-path aliases are cleaned once and a non-existent config directory is never created', () => {
  const f = settings('bot', { hooks: { Stop: [{ hooks: [retired()] }] } })
  const alias = join(dir, 'alias'); symlinkSync(f.config, alias)
  const absent = join(dir, 'absent'), lines: string[] = []
  removeLegacyReplyHooks([undefined, '', ' ', f.config, alias, absent], line => lines.push(line))
  expect(JSON.parse(f.bytes())).toEqual({ hooks: { Stop: [] } })
  expect(lines).toHaveLength(1)
  expect(existsSync(absent)).toBe(false)
})

test.each([
  '/old/package/slack-reply-guard.sh',
  "'/old/package with spaces/slack-reply-guard.sh' '/old/state with spaces/reply-guard'",
  "'/old/it'\\''s package/slack-reply-guard.sh' '/old/it'\\''s state/reply-guard'",
])('removes the exact historical absolute invocation %s', command => {
  const f = settings('bot', { hooks: { Stop: [{ hooks: [retired(command)] }] } })
  removeLegacyReplyHooks([f.config], () => {})
  expect(JSON.parse(f.bytes()).hooks.Stop).toEqual([])
})

test.each([
  retired('echo /old/slack-reply-guard.sh'),
  retired("echo '/old/slack-reply-guard.sh'"),
  retired('/old/slack-reply-guard.sh; echo keep'),
  retired('/old/slack-reply-guard.sh && /other/hook'),
  retired('/old/slack-reply-guard.sh | /other/hook'),
  retired('/old/slack-reply-guard.sh > /other/output'),
  retired('/old/slack-reply-guard.sh # keep my hook'),
  retired('/old/slack-reply-guard.sh.backup'),
  retired('/other/hook /old/slack-reply-guard.sh'),
  retired('/old/slack-reply-guard.sh\n/other/hook'),
  retired('/old/slack-reply-guard.sh /unrelated/argument'),
  retired('relative/slack-reply-guard.sh'),
  retired('"/old/slack-reply-guard.sh"'),
  { command: '/old/slack-reply-guard.sh' },
  { type: 'prompt', command: '/old/slack-reply-guard.sh' },
].map(hook => [hook] as const))('preserves an unrelated command or unknown hook shape %j byte for byte', hook => {
  const f = settings('bot', { hooks: { Stop: [{ hooks: [hook] }] } }), before = f.bytes(), lines: string[] = []
  removeLegacyReplyHooks([f.config], line => lines.push(line))
  expect(f.bytes()).toBe(before)
  expect(lines).toEqual([])
})

test.each([null, [], {}, { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: ['future entry', { command: 4 }] }] } }].map(value => [value] as const))('unmanaged or unfamiliar settings %j remain byte-identical', value => {
  const f = settings('bot', value), before = f.bytes(), lines: string[] = []
  removeLegacyReplyHooks([f.config], line => lines.push(line))
  expect(f.bytes()).toBe(before)
  expect(lines).toEqual([])
})

test('malformed and unreadable settings fail locally without exposing values or blocking the next directory', () => {
  const malformed = settings('malformed', {})
  writeFileSync(malformed.path, '{"private":"' + LEAK_SENTINEL + '",')
  const before = malformed.bytes()
  const unreadable = join(dir, 'unreadable'); mkdirSync(join(unreadable, 'settings.json'), { recursive: true })
  const good = settings('good', { hooks: { Stop: [{ hooks: [retired()] }] } }), lines: string[] = []
  removeLegacyReplyHooks([malformed.config, unreadable, good.config], line => lines.push(line))
  expect(malformed.bytes()).toBe(before)
  expect(JSON.parse(good.bytes()).hooks.Stop).toEqual([])
  expect(lines).toEqual([
    '[slack] reply-reminder: legacy hook cleanup failed; retrying on the next launch',
    '[slack] reply-reminder: legacy hook cleanup failed; retrying on the next launch',
    '[slack] reply-reminder: removed the legacy Stop hook',
  ])
  assertNoLeak(lines)
})

test('the fake operator config and a symlink to it are refused without changing either file', () => {
  const home = join(dir, 'home'), operator = join(home, '.claude')
  mkdirSync(home)
  const f = settings('home/.claude', { hooks: { Stop: [{ hooks: [retired()] }] } }), before = f.bytes()
  const alias = join(dir, 'operator-alias'); symlinkSync(operator, alias)
  const res = runInFakeHome({ home, modulePath: join(import.meta.dir, '../src/legacy-reply-hook-cleanup.ts'), input: [operator, alias],
    call: 'mod.removeLegacyReplyHooks(input)' })
  expect(res.status).toBe(0)
  expect(res.observedHomedir).toBe(home)
  expect(res.stderr.trim()).toBe('[slack] reply-reminder: refusing to clean legacy hooks in the operator config directory')
  expect(f.bytes()).toBe(before)
})
