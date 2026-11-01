/**
 * The manual-upgrade fixtures (b.tad SR-8.1, SR-8.2): the committed tree is
 * exactly what the generator writes, and only its write command rewrites
 * it; every prepared baseline loads with the
 * production loader, and every invalid one fails as its manifest entry says;
 * queue journals read back intact; the manifest names each case's operator
 * choices; the materializer fills --home into every current-format config, so
 * its paths never depend on the server's HOME; the materializer and the image
 * entry need only `node:` and the committed tree, and the entry refuses
 * outside the image first.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { loadPersonaConfig, PERSONA_TOP_LEVEL_KEYS, TEST_MCP_DROP_ENDPOINT_KEY, TEST_TIMER_OVERRIDES_KEY, type PersonaConfig } from '../src/config.ts'
import { parseQueueRecord, type QueueRecord } from '../src/delivery-queue.ts'
import { readAppliedPersonaConfig } from '../src/reload.ts'
import { parseSharedChannelState } from '../src/shared-channels.ts'
import { THREAD_MEMORY_SEAL_FILE } from '../src/thread-memory-seal.ts'
import { assertNoLeak, TOKEN_LIKE, writtenFile } from './test-helpers/credentials.ts'
import { makeQueue, queuePath, readQueue } from './test-helpers/delivery-queue.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import {
  buildUpgradeCases, fillHome, guardScratchDir, listFixtureFiles, materializeUpgradeCase, OLD_PERSONA_KEYS, OLD_TOP_LEVEL_KEYS, oldConfigBytes018, oldReloadFingerprint018, readUpgradeManifest, runUpgradeCaseCommand,
  UPGRADE_FIXTURE_DIR, UPGRADE_MANIFEST_FILE, UPGRADE_REFUSED_SETTINGS, UPGRADE_SETTING_KEYS, writeUpgradeFixtures,
  type MaterializedCase, type MaterializeOptions, type OldPersona018, type UpgradeChannelRow, type UpgradeManifestCase, type UpgradeSettingValue,
} from './test-helpers/shared-channel-upgrade.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const GENERATOR = join(REPO_ROOT, 'tests', 'test-helpers', 'shared-channel-upgrade.ts')
const ENTRY = join(REPO_ROOT, 'tests', 'integration', 'fixtures', 'shared-channel-upgrade-case.ts')
const IMAGE_MARKER = '/etc/cscb-ci-image'
const AC_U_ROWS = ['AC-U01', 'AC-U02', 'AC-U03', 'AC-U04', 'AC-U05', 'AC-U06', 'AC-U07', 'AC-U08', 'AC-U09', 'AC-U11', 'AC-U12', 'AC-U13']
const manifest = readUpgradeManifest()

let scratch: string
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'cscb-upgrade-fixtures-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

/** Paths under `actual` that differ from `expected`: missing, extra, or with other bytes. */
function fixtureDrift(expected: string, actual: string): string[] {
  const want = listFixtureFiles(expected), have = listFixtureFiles(actual)
  return [
    ...want.filter(p => !have.includes(p)).map(p => `missing ${p}`),
    ...have.filter(p => !want.includes(p)).map(p => `not generated ${p}`),
    ...want.filter(p => have.includes(p) && !readFileSync(join(expected, p)).equals(readFileSync(join(actual, p)))).map(p => `differs ${p}`),
  ]
}
function materialize(entry: UpgradeManifestCase, extra: Pick<MaterializeOptions, 'settings' | 'personaPrefix'> = {}, materializer = materializeUpgradeCase): MaterializedCase {
  const root = join(scratch, entry.name)
  mkdirSync(root)
  return materializer({ fixtureDir: UPGRADE_FIXTURE_DIR, caseName: entry.name, root, stateDir: join(root, 'state'), home: join(root, 'home'), ...extra })
}
function load(configPath: string, home: string): { config?: PersonaConfig; error?: string } {
  try { return { config: readAppliedPersonaConfig(configPath, home) } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)])
  return []
}
const fileOf = (entry: UpgradeManifestCase, suffix: string) => entry.files.find(f => f.path === `${entry.name}/${suffix}`)

/**
 * Each baseline variant of a materialized case loads, or fails as its
 * manifest entry says, with the loader's home set to `home`; the state dir
 * matches the default.
 */
function checkVariants(c: UpgradeManifestCase, done: MaterializedCase, home = done.home): void {
  for (const b of c.baselines) {
    const configPath = join(done.dirs.baseline, b.name, 'config.json')
    const result = load(configPath, home)
    if (b.expect.loads) {
      expect(result.error).toBeUndefined()
      expect(result.config!.channel_mode).toBe(b.expect.channel_mode)
      expect(keysDeep(JSON.parse(readFileSync(configPath, 'utf8')))).not.toEqual(expect.arrayContaining(['allow_invited_channels']))
      expect(keysDeep(JSON.parse(readFileSync(configPath, 'utf8')))).not.toEqual(expect.arrayContaining(['invited']))
    } else {
      expect(result.config).toBeUndefined()
      for (const name of b.expect.names) expect(result.error).toContain(name)
      expect(result.error).toContain(join(done.dirs.baseline, b.name, b.expect.fails_in))
    }
  }
  const fromState = load(join(done.stateDir, 'config.json'), home)
  const defaultVariant = load(join(done.dirs.baseline, done.defaultBaseline, 'config.json'), home)
  expect(fromState.config === undefined).toBe(defaultVariant.config === undefined)
}

/** Each queue journal reads back as generated, and the queue opens with its open items' text, via, emoji, reminder facts, source and order. */
async function checkQueues(c: UpgradeManifestCase, done: MaterializedCase, named: (persona: string) => string = p => p): Promise<void> {
  const { queues } = await buildUpgradeCases()
  for (const summary of c.queues) {
    const records = queues.get(c.name)!.find(q => q.persona === summary.persona)!.records
    const persona = named(summary.persona)
    const path = queuePath(done.stateDir, persona)
    expect(path).toBe(join(done.stateDir, named(summary.path)))
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    expect(raw.map(line => parseQueueRecord(line))).toEqual(records)
    expect(readQueue(done.stateDir, persona)).toEqual(records)
    const queue = await makeQueue(done.stateDir, { now: () => Date.parse('2026-06-01T12:00:00Z') })
    try {
      const open = queue.items(persona)
      const accepted = records.filter((r): r is Extract<QueueRecord, { kind: 'accepted'; text: string }> => r.kind === 'accepted' && !('compact' in r))
      const openSeqs = summary.items.filter(i => !i.delivered).map(i => i.seq)
      expect(open.map(item => item.accepted.seq)).toEqual(openSeqs)
      for (const item of open) {
        const original = accepted.find(r => r.seq === item.accepted.seq)!
        expect(item.accepted.text).toBe(original.text)
        expect(item.accepted.via).toBe(original.via)
        expect(item.accepted.queued_ack_reaction).toBe(original.queued_ack_reaction)
        expect(item.accepted.reminder_for).toBe(original.reminder_for)
        expect(item.accepted.source).toBe(original.source)
      }
      expect(summary.items.map(i => i.seq)).toEqual(accepted.map(r => r.seq))
    } finally {
      await queue.stop()
    }
  }
}

/** The host settings test-47 passes (b.tad t3.yiv.sf.39.63). */
const SCENARIO_SETTINGS: Record<string, UpgradeSettingValue> = {
  bind: '127.0.0.1', port: 4100, health_check_interval: 0, session_restart_delay: 0, exit_timeout: 5, mcp_config_path: '/scenario/slack-mcp.json',
}
const settingArgs = (settings: Record<string, UpgradeSettingValue>) => Object.entries(settings).flatMap(([k, v]) => ['--setting', `${k}=${v}`])
const PREFIX = 't47_'
const PERSONA_NAMES = [...new Set(manifest.cases.flatMap(c => [...c.personas.map(p => p.name), ...c.identities.map(i => i.name)]))]
const plainName = () => new RegExp(`\\b(${PERSONA_NAMES.join('|')})\\b`, 'g')
const renamed = (text: string, prefix: string) => text.replace(plainName(), name => prefix + name)
const SETTING_GROUPS = ['baseline', 'pending']
const committedBytes = (path: string) => readFileSync(join(UPGRADE_FIXTURE_DIR, path))
const targetDirs = (done: MaterializedCase): Record<string, string> => ({ state: done.stateDir, ...done.dirs })
/** Read a materialized file, first making a mode-0000 copy readable (scratch only). */
function readMaterialized(path: string): Buffer {
  if ((statSync(path).mode & 0o777) === 0) chmodSync(path, 0o600)
  return readFileSync(path)
}

/** Each config and applied baseline the case commits identical that the materialization no longer has identical. */
function pairProblems(c: UpgradeManifestCase, done: MaterializedCase): string[] {
  const problems: string[] = []
  for (const b of c.baselines) {
    const config = fileOf(c, `new-baseline/${b.name}/config.json`)!, applied = fileOf(c, `new-baseline/${b.name}/config.json.last-applied`)
    if (!applied || !committedBytes(config.path).equals(committedBytes(applied.path))) continue
    const pairDiffers = (dir: string) => !readFileSync(join(dir, 'config.json')).equals(readFileSync(join(dir, 'config.json.last-applied')))
    if (pairDiffers(join(done.dirs.baseline, b.name))) problems.push(`pair differs new-baseline/${b.name}`)
    if (b.default && pairDiffers(done.stateDir)) problems.push('pair differs state')
  }
  return problems
}

/**
 * Where a materialization under `settings` falls short: a current-format
 * target without a setting or with another change than the home fill, a
 * reference or old state file that differs from the committed one, or a
 * config and applied baseline the case has identical that no longer are.
 */
function settingProblems(c: UpgradeManifestCase, done: MaterializedCase, settings: Record<string, UpgradeSettingValue>): string[] {
  const problems: string[] = []
  const dirs = targetDirs(done)
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !Object.hasOwn(settings, k)))
  for (const f of c.files) for (const t of f.targets) {
    const where = `${t.to}/${t.path}`
    const path = join(dirs[t.to]!, t.path)
    if (!existsSync(path)) { problems.push(`missing ${where}`); continue }
    const bytes = readMaterialized(path), committed = committedBytes(f.path)
    if (!SETTING_GROUPS.includes(f.group)) {
      const want = f.home_relative ? Buffer.from(fillHome(committed.toString('utf8'), done.home)) : committed
      if (!bytes.equals(want)) problems.push(`changed ${where}`)
      continue
    }
    const got = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, before = JSON.parse(fillHome(committed.toString('utf8'), done.home)) as Record<string, unknown>
    for (const [key, value] of Object.entries(settings)) if (got[key] !== value) problems.push(`no ${key} in ${where}`)
    if (!Bun.deepEquals(strip(got), strip(before)) || Object.keys(strip(got)).join() !== Object.keys(strip(before)).join()) problems.push(`other change in ${where}`)
  }
  return [...problems, ...pairProblems(c, done)]
}

/** Every string in a JSON value, depth first. */
function stringsDeep(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsDeep)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsDeep)
  return []
}

/**
 * Where a materialization falls short of filling the home: a current-format
 * target (new-baseline/, pending-edits/ and the state dir's copies) that
 * still names `"~/`, names an absolute path outside --home (setting values
 * aside), or differs from the committed file filled with --home (settings
 * and prefix applied); a config and applied baseline the case has identical
 * that no longer are; a 0.18.0 file that is not home_relative but lost its
 * `~/` (or, with no prefix, any change to a 0.18.0 or old state file); or
 * printed `credentials` and `workdir` lines that are not exactly the paths
 * the filled configs name, or a working directory not created.
 */
function homeProblems(c: UpgradeManifestCase, done: MaterializedCase, settings: Record<string, UpgradeSettingValue> = {}, prefix = ''): string[] {
  const problems: string[] = []
  const dirs = targetDirs(done)
  const settingValues = new Set(Object.values(settings).filter(v => typeof v === 'string'))
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !Object.hasOwn(settings, k)))
  const named = { credentials: new Set<string>(), workdirs: new Set<string>() }
  for (const f of c.files) for (const t of f.targets) {
    const rel = renamed(t.path, prefix)
    const where = `${t.to}/${rel}`
    const path = join(dirs[t.to]!, rel)
    if (!existsSync(path)) { problems.push(`missing ${where}`); continue }
    const text = readMaterialized(path).toString('utf8'), committed = committedBytes(f.path).toString('utf8')
    if (!SETTING_GROUPS.includes(f.group)) {
      if (!f.home_relative && committed.includes('"~/') && (!text.includes('"~/') || text.includes(done.home))) problems.push(`home filled in 0.18.0 file ${where}`)
      if (!prefix && text !== (f.home_relative ? fillHome(committed, done.home) : committed)) problems.push(`changed ${where}`)
      continue
    }
    if (text.includes('"~/')) problems.push(`~/ left in ${where}`)
    const got = JSON.parse(text) as Record<string, unknown>
    for (const s of stringsDeep(got)) if (s.startsWith('/') && !settingValues.has(s) && !s.startsWith(`${done.home}/`)) problems.push(`outside --home in ${where}: ${s}`)
    const want = JSON.parse(renamed(fillHome(committed, done.home), prefix)) as Record<string, unknown>
    if (!Bun.deepEquals(strip(got), strip(want))) problems.push(`not the committed file filled with --home: ${where}`)
    for (const p of (got.personas ?? []) as { credentials_file?: string; working_directory?: string }[]) {
      if (p.credentials_file) named.credentials.add(p.credentials_file)
      if (p.working_directory) named.workdirs.add(p.working_directory)
    }
  }
  const printed = { credentials: new Set(done.credentials.map(x => x.path)), workdirs: new Set(done.workdirs.map(x => x.path)) }
  for (const kind of ['credentials', 'workdirs'] as const) {
    for (const p of printed[kind]) if (!named[kind].has(p)) problems.push(`printed ${kind} path no config names: ${p}`)
    for (const p of named[kind]) if (!printed[kind].has(p)) problems.push(`${kind} path a config names is not printed: ${p}`)
  }
  for (const w of done.workdirs) if (!existsSync(w.path) || !statSync(w.path).isDirectory()) problems.push(`working directory not created: ${w.path}`)
  return [...problems, ...pairProblems(c, done)]
}

/**
 * Where a materialization under `prefix` falls short: a plain persona name
 * left in any file or path under the root or in the printed names and paths,
 * an occurrence count that differs from the committed file's, or a 0.18.0
 * pending fingerprint that is not 0.18.0's over the materialized config.json.
 */
function prefixProblems(c: UpgradeManifestCase, done: MaterializedCase, prefix: string): string[] {
  const problems: string[] = []
  const root = dirname(done.caseRoot)
  const hasPlain = (text: string) => plainName().test(text)
  for (const rel of listFixtureFiles(root)) {
    if (hasPlain(rel)) problems.push(`plain name in path ${rel}`)
    if (hasPlain(readMaterialized(join(root, rel)).toString('utf8').split(root).join('<root>'))) problems.push(`plain name in ${rel}`)
  }
  const dirs = targetDirs(done)
  const prefixed = new RegExp(`\\b${prefix}(${PERSONA_NAMES.join('|')})\\b`, 'g')
  for (const f of c.files) for (const t of f.targets) {
    const path = join(dirs[t.to]!, renamed(t.path, prefix))
    if (!existsSync(path)) { problems.push(`missing ${t.to}/${renamed(t.path, prefix)}`); continue }
    const want = committedBytes(f.path).toString('utf8').match(plainName())?.length ?? 0
    const got = readMaterialized(path).toString('utf8').split(root).join('<root>').match(prefixed)?.length ?? 0
    if (got !== want) problems.push(`${got} of ${want} names renamed in ${t.to}/${t.path}`)
  }
  const pending = join(done.dirs.reference, 'config.json.pending')
  if (existsSync(pending) && !readFileSync(pending, 'utf8').includes(`fingerprint: sha256:${oldReloadFingerprint018(readFileSync(join(done.dirs.reference, 'config.json')))}\n`)) problems.push('stale fingerprint in config.json.pending')
  for (const p of done.personas) if (p.name !== prefix + p.manifestName) problems.push(`persona ${p.manifestName} printed as ${p.name}`)
  for (const w of [...done.workdirs, ...done.credentials]) if (hasPlain(w.persona) || hasPlain(w.path.slice(root.length))) problems.push(`plain name printed: ${w.persona} ${w.path}`)
  return problems
}

/**
 * A copy of the generator in scratch, with `from` replaced by `to` when given,
 * beside its node:-only host-safe-env.ts. Its own committed tree is
 * `<copy>/fixtures/shared-channel-upgrade`, under the OS temp dir, and absent.
 */
function generatorCopy(from?: string, to = ''): string {
  const dir = join(mkdtempSync(join(scratch, 'copy-')), 'test-helpers')
  mkdirSync(dir)
  const source = readFileSync(GENERATOR, 'utf8')
  if (from !== undefined) expect(source.split(from)).toHaveLength(2)
  writeFileSync(join(dir, 'shared-channel-upgrade.ts'), from === undefined ? source : source.replace(from, to))
  cpSync(join(REPO_ROOT, 'tests', 'test-helpers', 'host-safe-env.ts'), join(dir, 'host-safe-env.ts'))
  return join(dir, 'shared-channel-upgrade.ts')
}

/** A copy of the generator in scratch with one change, loaded beside its node:-only host-safe-env.ts. */
async function mutant(from: string, to: string): Promise<typeof materializeUpgradeCase> {
  return (await import(generatorCopy(from, to))).materializeUpgradeCase
}

describe('the committed tree is what the generator writes', () => {
  test('a fresh generation matches every committed path and byte, and nothing else is committed', async () => {
    const out = join(scratch, 'generated')
    const written = await writeUpgradeFixtures(out)
    expect(written).toEqual(listFixtureFiles(out))
    expect(fixtureDrift(out, UPGRADE_FIXTURE_DIR)).toEqual([])
  })

  test('the drift check reports a changed byte and a file the generator does not write', async () => {
    const out = join(scratch, 'generated')
    await writeUpgradeFixtures(out)
    const copy = join(scratch, 'copy')
    cpSync(UPGRADE_FIXTURE_DIR, copy, { recursive: true })
    const victim = manifest.cases[0]!.files[0]!.path
    const bytes = readFileSync(join(copy, victim))
    bytes[0] = bytes[0]! ^ 1
    writeFileSync(join(copy, victim), bytes)
    writeFileSync(join(copy, manifest.cases[1]!.name, 'stray.json'), '{}\n')
    expect(fixtureDrift(out, copy).sort()).toEqual([`differs ${victim}`, `not generated ${manifest.cases[1]!.name}/stray.json`].sort())
  })

  test('the generator refuses a directory outside the OS temp dir', async () => {
    await expect(writeUpgradeFixtures(join(REPO_ROOT, 'tests', 'fixtures', 'not-the-upgrade-tree'))).rejects.toThrow('refused')
  })

  const COMMITTED_REFUSAL = 'refused: it is, holds or lies under the committed fixture tree'

  test('no test can rewrite the committed tree: the generator refuses it before the scratch guard', async () => {
    await expect(writeUpgradeFixtures(UPGRADE_FIXTURE_DIR)).rejects.toThrow(COMMITTED_REFUSAL)
  })

  test('a copy whose committed tree the scratch guard admits still refuses it, its parent and a path under it, even with a forged pass', async () => {
    const copy: typeof import('./test-helpers/shared-channel-upgrade.ts') = await import(generatorCopy())
    const committed = copy.UPGRADE_FIXTURE_DIR
    expect(guardScratchDir(committed, 'the copy\'s committed tree')).toBeTruthy()
    for (const dir of [committed, dirname(committed), join(committed, 'nested')]) {
      await expect(copy.writeUpgradeFixtures(dir)).rejects.toThrow(COMMITTED_REFUSAL)
    }
    await expect(copy.writeUpgradeFixtures(committed, Symbol('shared-channel-upgrade write'))).rejects.toThrow(COMMITTED_REFUSAL)
    expect(existsSync(dirname(committed))).toBe(false)
  })

  test('the write command still rewrites the committed tree where the scratch guard would refuse it', () => {
    const stubbed = generatorCopy('const { manifest, files } = await buildUpgradeCases()', "const { manifest, files } = { manifest: {}, files: new Map([['stub/file.json', Buffer.from('{}\\n')]]) }")
    const committed = resolve(dirname(stubbed), '..', 'fixtures', 'shared-channel-upgrade')
    const home = join(scratch, 'home'), otherTmp = join(scratch, 'other-tmp')
    mkdirSync(home)
    mkdirSync(otherTmp)
    const probe = join(scratch, 'probe.ts')
    writeFileSync(probe, `await import(${JSON.stringify(stubbed)}).then(m => m.writeUpgradeFixtures(m.UPGRADE_FIXTURE_DIR + '-sibling')).then(() => console.log('wrote'), e => console.log(e.message))`)
    const guarded = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10_000, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: otherTmp } }) })
    expect(guarded.stdout).toContain('refused: not under the OS temp dir or SCENARIO_ROOT')
    const child = spawnSync(process.execPath, [stubbed, 'write'], { encoding: 'utf8', timeout: 10_000, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: otherTmp } }) })
    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    expect(listFixtureFiles(committed)).toEqual(['manifest.json', 'stub/file.json'])
  })
})

describe('the manifest describes every case and file', () => {
  test('every committed file is in exactly one case entry, and every entry names a committed file', () => {
    const listed = manifest.cases.flatMap(c => c.files.map(f => f.path))
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed, UPGRADE_MANIFEST_FILE].sort()).toEqual(listFixtureFiles(UPGRADE_FIXTURE_DIR))
    for (const c of manifest.cases) for (const f of c.files) expect(f.path.startsWith(`${c.name}/`)).toBe(true)
    expect(readdirSync(UPGRADE_FIXTURE_DIR).sort()).toEqual([...manifest.cases.map(c => c.name), UPGRADE_MANIFEST_FILE].sort())
  })

  test('the cases cover every manual-upgrade acceptance row, and each has one default baseline', () => {
    expect([...new Set(manifest.cases.flatMap(c => c.ac_rows))].sort()).toEqual(AC_U_ROWS)
    for (const c of manifest.cases) {
      expect(c.baselines.filter(b => b.default)).toHaveLength(1)
      expect(c.baselines.filter(b => b.chosen)).toHaveLength(1)
      for (const b of c.baselines) expect(c.files.some(f => f.group === 'baseline' && f.variant === b.name && f.path.endsWith('/config.json'))).toBe(true)
      for (const e of c.pending_edits) expect(c.files.some(f => f.group === 'pending' && f.variant === e.name)).toBe(true)
    }
  })

  test.each(manifest.cases.filter(c => c.channels.length > 0).map(c => [c.name, c] as const))('%s: each channel choice follows from its old sources and the dates', (_name, c) => {
    const applied = fileOf(c, 'reference-0.18.0/config.json.last-applied')!
    for (const row of c.channels) {
      const olds = [row.old_config?.delivery, row.old_stored_choice?.delivery].filter((d): d is 'all' | 'mentions' => d !== undefined)
      expect(olds.length).toBeGreaterThan(0)
      if (row.kind === 'conflict') {
        expect(new Set(olds).size).toBe(2)
        const storeNewer = Date.parse(row.old_stored_choice!.set_at) > Date.parse(applied.mtime)
        expect(row.newer_source).toBe(storeNewer ? 'stored_choice' : 'config')
        expect(row.choice.action).toBe('choose')
      } else {
        expect(new Set(olds).size).toBe(1)
        expect(row.newer_source).toBeUndefined()
      }
      if (row.choice.action === 'transfer') expect(row.choice.delivery).toBe(olds[0]!)
      if (row.choice.action === 'choose') expect(olds).toContain(row.choice.delivery as 'all' | 'mentions')
      if (row.choice.action === 'new') expect(olds).not.toContain(row.choice.delivery as 'all' | 'mentions')
    }
  })

  test('the cases include explicit off, thread_hybrid, a retired channel, both conflict date directions and retired identities', () => {
    const rows = manifest.cases.flatMap(c => c.channels)
    const deliveries = rows.flatMap(r => r.choice.action === 'retire' ? [] : [r.choice.delivery])
    expect(deliveries).toEqual(expect.arrayContaining(['off', 'thread_hybrid', 'all', 'mentions']))
    expect(rows.some(r => r.choice.action === 'retire')).toBe(true)
    const conflicts = rows.filter(r => r.kind === 'conflict')
    expect(new Set(conflicts.map(r => r.newer_source))).toEqual(new Set(['config', 'stored_choice']))
    for (const r of conflicts) {
      const newer = r.newer_source === 'config' ? r.old_config!.delivery : r.old_stored_choice!.delivery
      expect(r.choice.action !== 'retire' && r.choice.delivery).not.toBe(newer)
    }
    expect(manifest.cases.flatMap(c => c.identities).map(i => i.disposition)).toContain('retire')
    expect(manifest.cases.map(c => c.starting_mode)).toEqual(expect.arrayContaining(['0.18.0 declarative', '0.18.0 fungible', 'no old files']))
    expect(manifest.cases.map(c => c.new_mode)).toEqual(expect.arrayContaining(['strict', 'open']))
  })

  test('the generator takes the shared channel IDs from shared-channels.ts', () => {
    const ids = new Set(manifest.cases.flatMap(c => c.channels.map(r => r.channel)))
    for (const id of Object.values(SHARED_CHANNEL_IDS)) expect(ids.has(id)).toBe(true)
  })
})

describe('new baselines with the production loader', () => {
  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: each variant loads or fails as its manifest entry says', (_name, c) => {
    checkVariants(c, materialize(c))
  })

  test.each(manifest.cases.filter(c => c.channels.length + c.destinations.length > 0).map(c => [c.name, c] as const))('%s: the chosen baseline holds exactly the manifest choices', (_name, c) => {
    const done = materialize(c)
    const config = readAppliedPersonaConfig(join(done.dirs.baseline, done.chosenBaseline, 'config.json'), done.home)
    const byKey = new Map(config.personas.map(p => [p.key, p]))
    for (const persona of new Set(c.channels.map(r => r.persona))) {
      const want = c.channels.filter((r): r is UpgradeChannelRow & { choice: { delivery: string } } => r.persona === persona && r.choice.action !== 'retire')
        .map(r => ({ id: r.channel, delivery: r.choice.delivery }))
      expect(byKey.get(persona)!.channels.map(ch => ({ id: ch.id, delivery: ch.delivery as string }))).toEqual(want)
    }
    for (const d of c.destinations) expect(byKey.get(d.persona)!.permission_prompts).toBe(d.chosen)
    for (const p of config.personas) expect(p.credentials_file).toBe(join(done.home, c.personas.find(m => m.key === p.key)!.credentials_file.slice(2)))
    const store = c.identities.length ? JSON.parse(readFileSync(join(done.dirs.reference, 'channel-delivery.json'), 'utf8')) : undefined
    for (const identity of c.identities.filter(i => i.disposition === 'retire')) {
      const persona = byKey.get(identity.key)
      if (!c.personas.some(p => p.key === identity.key)) expect(persona).toBeUndefined()
      const stored = Object.keys(store.personas[identity.key].channels)
      for (const id of stored) expect(persona?.channels.some(ch => ch.id === id) ?? false).toBe(false)
    }
  })

  test.each(manifest.cases.filter(c => c.pending_edits.length > 0).map(c => [c.name, c] as const))('%s: every pending edit loads and differs from the chosen baseline', (_name, c) => {
    const done = materialize(c)
    const chosen = readFileSync(join(done.dirs.baseline, done.chosenBaseline, 'config.json'))
    for (const edit of c.pending_edits) {
      const path = join(done.dirs.pending, edit.name, 'config.json')
      const config = loadPersonaConfig(path, done.home)
      expect(readFileSync(path).equals(chosen)).toBe(false)
      if (edit.changes.includes('channel_mode')) expect(config.channel_mode).toBe('open')
    }
  })

  test('the old references are rejected by the current loader, naming the replacement', () => {
    for (const c of manifest.cases.filter(m => fileOf(m, 'reference-0.18.0/config.json'))) {
      const done = materialize(c)
      const result = load(join(done.dirs.reference, 'config.json'), done.home)
      expect(result.error).toMatch(/(allow_invited_channels has been removed; use channel_mode|invited has been removed; use permission_prompts)/)
    }
  })
})

describe('queue journals', () => {
  test.each(manifest.cases.filter(c => c.queues.length > 0).map(c => [c.name, c] as const))('%s: each journal reads back with its text, emoji, reminder facts, via and order', async (_name, c) => {
    await checkQueues(c, materialize(c))
  })

  test('the declarative case keeps its reminder link and its multi-line and Unicode texts', () => {
    const c = manifest.cases.find(m => m.queues.some(q => q.reply_reminders.length > 0))!
    const summary = c.queues[0]!
    expect(summary.items.some(i => i.reminder_for !== undefined && summary.items.find(j => j.seq === i.reminder_for)?.delivered)).toBe(true)
    expect(new Set(summary.items.flatMap(i => i.queued_ack_reaction ?? [])).size).toBeGreaterThan(1)
    const text = readFileSync(join(UPGRADE_FIXTURE_DIR, c.name, 'reference-0.18.0', summary.path), 'utf8')
    const texts = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { text?: string }).flatMap(r => r.text ?? [])
    expect(texts.some(t => t.includes('\n'))).toBe(true)
    expect(texts.some(t => /[^\u0000-\u007f]/.test(t))).toBe(true)
  })
})

describe('no secrets, host paths, Thread Memory or shared authority', () => {
  test('the committed tree holds no token, sentinel or host path', () => {
    assertNoLeak(writtenFile(UPGRADE_FIXTURE_DIR), 'fixtures')
    for (const rel of listFixtureFiles(UPGRADE_FIXTURE_DIR)) {
      const text = readFileSync(join(UPGRADE_FIXTURE_DIR, rel), 'utf8')
      expect(TOKEN_LIKE.test(text)).toBe(false)
      for (const host of [homedir(), REPO_ROOT, tmpdir(), '/home/', '/tmp/', '/root/', '/run/']) expect(text.includes(host)).toBe(false)
    }
  })

  test('no case puts Thread Memory, its seal or a shared authority in the state dir', () => {
    for (const c of manifest.cases) {
      for (const f of c.files) for (const t of f.targets.filter(t => t.to === 'state')) {
        expect(t.path.split('/')[0]).not.toBe('threads')
        expect(t.path).not.toContain(THREAD_MEMORY_SEAL_FILE)
        if (t.path === 'config.json.last-applied') expect(parseSharedChannelState(readFileSync(join(UPGRADE_FIXTURE_DIR, f.path)), t.path)).toBeUndefined()
      }
      const done = materialize(c)
      expect(existsSync(join(done.stateDir, 'threads'))).toBe(false)
      expect(existsSync(join(done.stateDir, THREAD_MEMORY_SEAL_FILE))).toBe(false)
    }
  })
})

describe('the materializer', () => {
  const first = manifest.cases[0]!

  test('applies dates and modes, fills in the home, creates working directories and writes no credentials', () => {
    for (const c of manifest.cases) {
      const done = materialize(c)
      const dirOf = { state: done.stateDir, ...done.dirs }
      for (const f of c.files) for (const t of f.targets) {
        const path = join(dirOf[t.to], t.path)
        const stat = statSync(path)
        expect(stat.mtime.toISOString()).toBe(f.mtime)
        if (f.mode !== undefined) expect((stat.mode & 0o777).toString(8).padStart(4, '0')).toBe(f.mode)
        else if (f.home_relative || SETTING_GROUPS.includes(f.group)) {
          const text = readFileSync(path, 'utf8')
          expect(text).not.toContain('"~/')
          if (committedBytes(f.path).includes('"~/')) expect(text).toContain(`"${done.home}/personas/`)
        }
      }
      for (const w of done.workdirs) expect(statSync(w.path).isDirectory()).toBe(true)
      for (const cred of done.credentials) expect(existsSync(cred.path)).toBe(false)
      expect(done.written).toHaveLength(c.files.reduce((n, f) => n + f.targets.length, 0))
    }
  })

  test('refuses a root outside the OS temp dir, the home, paths outside the root and existing files, writing nothing', () => {
    const root = join(scratch, 'root')
    mkdirSync(root)
    const opts = { caseName: first.name, root, stateDir: join(root, 'state'), home: join(root, 'home') }
    expect(() => materializeUpgradeCase({ ...opts, root: homedir() })).toThrow('refused')
    expect(() => materializeUpgradeCase({ ...opts, root: '/' })).toThrow('refused')
    expect(() => materializeUpgradeCase({ ...opts, root: 'relative' })).toThrow('absolute')
    expect(() => materializeUpgradeCase({ ...opts, stateDir: join(scratch, 'elsewhere') })).toThrow('not under --root')
    expect(() => materializeUpgradeCase({ ...opts, home: join(root, '..', 'home') })).toThrow('not under --root')
    expect(() => materializeUpgradeCase({ ...opts, caseName: 'no-such-case' })).toThrow('no case')
    expect(readdirSync(root)).toEqual([])
    expect(existsSync(join(scratch, 'elsewhere'))).toBe(false)
    materializeUpgradeCase(opts)
    expect(() => materializeUpgradeCase(opts)).toThrow('already exists')
    expect(() => guardScratchDir(join(REPO_ROOT, 'tests'), 'dir')).toThrow('refused')
  })

  test('the materialize command prints its directories, baselines, credentials and working directories', () => {
    const out: string[] = [], err: string[] = []
    const root = join(scratch, 'root')
    mkdirSync(root)
    const code = runUpgradeCaseCommand(['materialize', '--case', first.name, '--root', root, '--state-dir', join(root, 'state'), '--home', join(root, 'home')], l => out.push(l), l => err.push(l))
    expect([code, err]).toEqual([0, []])
    const names = out.map(l => l.split(' ')[0])
    expect([...new Set(names)]).toEqual(['case', 'state_dir', 'case_root', 'reference_dir', 'baselines_dir', 'pending_dir', 'default_baseline', 'chosen_baseline', 'persona', 'credentials', 'workdir', 'files'])
    expect(out.filter(l => l.startsWith('persona '))).toEqual(first.personas.map(p => `persona ${p.name} ${p.name}`))
    expect(out.filter(l => l.startsWith('credentials ')).length).toBe(first.credentials.length)
    expect(out).toContain(`default_baseline ${first.baselines.find(b => b.default)!.name}`)
    assertNoLeak({ out, err })
  })

  test('usage errors exit 64 and refusals exit 1 with one FAIL line', () => {
    const run = (argv: string[]) => { const err: string[] = []; return { code: runUpgradeCaseCommand(argv, () => {}, l => err.push(l)), err } }
    expect(run([]).code).toBe(64)
    expect(run(['nonsense']).code).toBe(64)
    expect(run(['materialize', '--case']).code).toBe(64)
    expect(run(['materialize', '--case', first.name, '--bogus', 'x']).code).toBe(64)
    const refused = run(['materialize', '--case', 'no-such-case', '--root', scratch, '--state-dir', join(scratch, 's'), '--home', join(scratch, 'h')])
    expect(refused.code).toBe(1)
    expect(refused.err).toHaveLength(1)
    expect(refused.err[0]).toStartWith('FAIL: shared-channel-upgrade-case: ')
  })
})

describe('materialize --setting and --persona-prefix', () => {
  const declarative = manifest.cases.find(c => c.pending_edits.length > 0 && c.queues.length > 0)!
  const run = (argv: string[]) => { const out: string[] = [], err: string[] = []; return { code: runUpgradeCaseCommand(argv, l => out.push(l), l => err.push(l)), out, err } }

  test('the settings keys are the current loader\'s top-level keys less the refused ones, and 0.18.0 has each of them', () => {
    const loader = new Set([...PERSONA_TOP_LEVEL_KEYS, TEST_TIMER_OVERRIDES_KEY, TEST_MCP_DROP_ENDPOINT_KEY])
    const refusedCurrent = Object.keys(UPGRADE_REFUSED_SETTINGS).filter(k => loader.has(k))
    expect(new Set([...UPGRADE_SETTING_KEYS, ...refusedCurrent])).toEqual(loader)
    expect(Object.keys(UPGRADE_REFUSED_SETTINGS)).toEqual(expect.arrayContaining(['personas', 'channel_mode', 'allow_invited_channels', 'invited']))
    for (const key of UPGRADE_SETTING_KEYS) expect(OLD_TOP_LEVEL_KEYS as readonly string[]).toContain(key)
  })

  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: each setting reaches every baseline, applied baseline and pending edit identically; references are untouched', (_name, c) => {
    const done = materialize(c, { settings: SCENARIO_SETTINGS })
    expect(settingProblems(c, done, SCENARIO_SETTINGS)).toEqual([])
    checkVariants(c, done)
    for (const edit of c.pending_edits) expect(loadPersonaConfig(join(done.dirs.pending, edit.name, 'config.json'), done.home).port).toBe(4100)
  })

  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: the prefix renames every persona name and path, and the case still loads and reads back', async (_name, c) => {
    const done = materialize(c, { personaPrefix: PREFIX })
    expect(prefixProblems(c, done, PREFIX)).toEqual([])
    checkVariants(c, done)
    await checkQueues(c, done, p => renamed(p, PREFIX))
    const chosen = load(join(done.dirs.baseline, done.chosenBaseline, 'config.json'), done.home).config
    for (const p of chosen?.personas ?? []) {
      expect(c.personas.map(m => PREFIX + m.name)).toContain(p.name)
      expect(p.key).toBe(p.name)
      expect(p.credentials_file).toStartWith(join(done.home, 'personas', p.name) + '/')
    }
  })

  test('with both options, the derived 0.18.0 files stay derived from their renamed seeds', () => {
    const c = manifest.cases.find(m => m.files.some(f => f.condition === 'malformed'))!
    const done = materialize(c, { settings: SCENARIO_SETTINGS, personaPrefix: PREFIX })
    const ref = (rel: string) => readMaterialized(join(done.dirs.reference, rel)).toString('utf8')
    const store = ref('channel-delivery.json')
    expect(store).toContain(`"${PREFIX}alpha": {`)
    expect(store.startsWith(ref('damaged/channel-delivery.truncated.json'))).toBe(true)
    expect(ref('damaged/channel-delivery.version-2.json')).toBe(store.replace('"version": 1', '"version": 2'))
    expect(ref('damaged/channel-delivery.unreadable.json')).toBe(store)
    expect(ref('config.json.last-applied').startsWith(ref('damaged/config.json.last-applied.truncated'))).toBe(true)
    expect(readFileSync(join(done.stateDir, 'channel-delivery.json'), 'utf8')).toBe(ref('damaged/channel-delivery.truncated.json'))
    expect(prefixProblems(c, done, PREFIX)).toEqual([])
  })

  test('the command takes both options and prints the prefixed names and paths', () => {
    const root = join(scratch, 'root')
    mkdirSync(root)
    const home = join(root, 'home')
    const done = run(['materialize', '--case', declarative.name, '--root', root, '--state-dir', join(root, 'state'), '--home', home, ...settingArgs(SCENARIO_SETTINGS), '--persona-prefix', PREFIX])
    expect([done.code, done.err]).toEqual([0, []])
    expect(done.out.filter(l => l.startsWith('persona '))).toEqual(declarative.personas.map(p => `persona ${p.name} ${PREFIX}${p.name}`))
    expect(done.out.filter(l => l.startsWith('credentials '))).toEqual(declarative.credentials.map(cr => `credentials ${PREFIX}${cr.persona} ${join(home, renamed(cr.path, PREFIX).slice(2))}`))
    expect(done.out.filter(l => l.startsWith('workdir '))).toEqual(declarative.personas.map(p => `workdir ${PREFIX}${p.key} ${join(home, 'personas', PREFIX + p.name, 'work')}`))
    expect(done.out.filter(l => !l.startsWith('persona ')).join('\n')).not.toMatch(plainName())
    const config = JSON.parse(readFileSync(join(root, 'state', 'config.json'), 'utf8'))
    expect(config).toMatchObject(SCENARIO_SETTINGS)
    expect(config.personas.map((p: { name: string }) => p.name)).toEqual(declarative.personas.map(p => PREFIX + p.name))
    assertNoLeak({ out: done.out, err: done.err })
  })

  test('refused settings and prefixes fail with one FAIL line naming why, and write nothing', () => {
    const root = join(scratch, 'root')
    mkdirSync(root)
    const base = (name = declarative.name) => ['materialize', '--case', name, '--root', root, '--state-dir', join(root, 'state'), '--home', join(root, 'home')]
    const refusals: [string[], string][] = [
      ...Object.entries(UPGRADE_REFUSED_SETTINGS).map(([key, why]) => [['--setting', `${key}=x`], `--setting ${key} is refused: ${why}`] as [string[], string]),
      [['--setting', 'no_such_key=1'], '--setting no_such_key is refused: the current loader has no top-level key no_such_key'],
      [['--setting', 'stop_timeout=15'], `--setting stop_timeout is refused: case ${declarative.name} sets it in its own configs`],
      [['--persona-prefix', 'T47_'], '--persona-prefix "T47_" refused'],
      [['--persona-prefix', 't47-'], '--persona-prefix "t47-" refused'],
      [['--persona-prefix', 'p'.repeat(36)], 'would not be its own persona key'],
    ]
    for (const [args, why] of refusals) {
      const result = run([...base(), ...args])
      expect([result.code, result.err.length]).toEqual([1, 1])
      expect(result.err[0]).toStartWith('FAIL: shared-channel-upgrade-case: ')
      expect(result.err[0]).toContain(why)
      expect(readdirSync(root)).toEqual([])
      assertNoLeak(result)
    }
    expect(run([...base(), '--setting', 'port']).code).toBe(64)
    expect(readdirSync(root)).toEqual([])
    const fresh = manifest.cases.find(c => c.name === 'fresh-start')!
    expect(run([...base(fresh.name), '--setting', 'stop_timeout=15']).code).toBe(0)
  })

  test('mutation controls: a setting that skips the pending edits or the applied baselines is caught', async () => {
    const skipPending = await mutant(`const SETTING_GROUPS: readonly UpgradeGroup[] = ['baseline', 'pending']`, `const SETTING_GROUPS: readonly UpgradeGroup[] = ['baseline']`)
    const dropped = settingProblems(declarative, materialize(declarative, { settings: SCENARIO_SETTINGS }, skipPending), SCENARIO_SETTINGS)
    expect(dropped).toEqual(expect.arrayContaining(declarative.pending_edits.map(e => `no port in pending/${e.name}/config.json`)))
    rmSync(join(scratch, declarative.name), { recursive: true })
    const skipApplied = await mutant('SETTING_GROUPS.includes(file.group)) bytes', `SETTING_GROUPS.includes(file.group) && !file.path.endsWith('.last-applied')) bytes`)
    const unpaired = settingProblems(declarative, materialize(declarative, { settings: SCENARIO_SETTINGS }, skipApplied), SCENARIO_SETTINGS)
    expect(unpaired).toEqual(expect.arrayContaining(['pair differs new-baseline/prepared', 'pair differs state', 'no port in state/config.json.last-applied']))
  })

  test.each([
    ['a skipped file', 'if (rename) {', `if (rename && !file.path.endsWith('channel-delivery.json')) {`, 'plain name in upgrade-'],
    ['an unrenamed path', 'resolve(base, named(target.path))', 'resolve(base, target.path)', 'plain name in path '],
    ['a stale pending fingerprint', 'bytes = refreshPendingFingerprint(', 'refreshPendingFingerprint(', 'stale fingerprint in config.json.pending'],
  ])('mutation control: a prefix with %s is caught', async (_what, from, to, problem) => {
    const done = materialize(declarative, { personaPrefix: PREFIX }, await mutant(from, to))
    expect(prefixProblems(declarative, done, PREFIX).some(p => p.startsWith(problem))).toBe(true)
  })
})

describe('materialize fills --home into every current-format config', () => {
  const declarative = manifest.cases.find(c => c.pending_edits.length > 0 && c.queues.length > 0)!
  /** test-47's per-case prefixes, `${SCENARIO_TAG}_<letter>_` (b.tad t3.yiv.sf.39.63). */
  const CASE_LETTERS: Record<string, string> = {
    'declarative-choices-and-queues': 'd', 'fungible-choices-and-destinations': 'f', 'interrupted-and-invalid-preparation': 'i', 'removed-key-rejection': 'r', 'fresh-start': 'z',
  }
  const casePrefix = (c: UpgradeManifestCase) => `t47_${CASE_LETTERS[c.name]}_`

  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: no current-format target names ~/, every filled path is under --home, pairs stay identical and references keep ~/', (_name, c) => {
    expect(homeProblems(c, materialize(c))).toEqual([])
  })

  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: with test-47\'s settings and per-case prefix the fill still holds, and every prefixed name stays a 40-character key', (_name, c) => {
    const prefix = casePrefix(c)
    const done = materialize(c, { settings: SCENARIO_SETTINGS, personaPrefix: prefix })
    expect(homeProblems(c, done, SCENARIO_SETTINGS, prefix)).toEqual([])
    expect(prefixProblems(c, done, prefix)).toEqual([])
    for (const name of [...c.personas.map(p => p.name), ...c.identities.map(i => i.name)]) expect(prefix + name).toMatch(/^[a-z0-9_]{1,40}$/)
    expect(done.personas.map(p => p.name)).toEqual(c.personas.map(p => prefix + p.name))
  })

  test('every case has a test-47 letter, and the longest fixture name leaves room for a prefix of that shape', () => {
    expect(Object.keys(CASE_LETTERS).sort()).toEqual(manifest.cases.map(c => c.name).sort())
    expect(new Set(Object.values(CASE_LETTERS)).size).toBe(manifest.cases.length)
    const longest = Math.max(...PERSONA_NAMES.map(n => n.length))
    expect('t47_d_'.length + longest).toBeLessThanOrEqual(40)
  })

  test.each(manifest.cases.map(c => [c.name, c] as const))('%s: loads through the production loader with a server HOME other than --home, every persona path resolving under --home', (_name, c) => {
    const done = materialize(c, { settings: SCENARIO_SETTINGS, personaPrefix: casePrefix(c) })
    const serverHome = join(scratch, 'server-home')
    checkVariants(c, done, serverHome)
    const printed = { credentials: done.credentials.map(x => x.path), workdirs: done.workdirs.map(x => x.path) }
    const loaded = [
      ...c.baselines.filter(b => b.expect.loads).map(b => readAppliedPersonaConfig(join(done.dirs.baseline, b.name, 'config.json'), serverHome)),
      ...c.pending_edits.map(e => loadPersonaConfig(join(done.dirs.pending, e.name, 'config.json'), serverHome)),
    ]
    expect(loaded.length).toBeGreaterThan(0)
    for (const p of loaded.flatMap(config => config.personas)) {
      expect(p.credentials_file).toStartWith(`${done.home}/`)
      expect(p.working_directory).toStartWith(`${done.home}/`)
      expect(printed.credentials).toContain(p.credentials_file)
      expect(printed.workdirs).toContain(p.working_directory)
    }
  })

  test('control: the committed, unfilled chosen baseline resolves under the server HOME, which is what the fill prevents', () => {
    const chosen = declarative.baselines.find(b => b.chosen)!.name
    const dir = join(scratch, 'unfilled')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), committedBytes(`${declarative.name}/new-baseline/${chosen}/config.json`))
    const serverHome = join(scratch, 'server-home')
    for (const p of loadPersonaConfig(join(dir, 'config.json'), serverHome).personas) expect(p.credentials_file).toStartWith(`${serverHome}/`)
  })

  test('mutation control: a fill that skips the pending edits is caught', async () => {
    const done = materialize(declarative, {}, await mutant(`const HOME_FILL_GROUPS: readonly UpgradeGroup[] = ['baseline', 'pending']`, `const HOME_FILL_GROUPS: readonly UpgradeGroup[] = ['baseline']`))
    const problems = homeProblems(declarative, done)
    expect(problems).toEqual(expect.arrayContaining(declarative.pending_edits.map(e => `~/ left in pending/${e.name}/config.json`)))
    expect(problems.some(p => p.startsWith('printed credentials path no config names: '))).toBe(true)
  })

  test('mutation control: a fill that skips the applied baselines is caught', async () => {
    const done = materialize(declarative, {}, await mutant('HOME_FILL_GROUPS.includes(file.group)) bytes', `HOME_FILL_GROUPS.includes(file.group) && !file.path.endsWith('.last-applied')) bytes`))
    expect(homeProblems(declarative, done)).toEqual(expect.arrayContaining(['~/ left in state/config.json.last-applied', 'pair differs new-baseline/prepared', 'pair differs state']))
  })

  test('mutation control: an applied baseline filled with another home is caught', async () => {
    const done = materialize(declarative, {}, await mutant(`fillHome(bytes.toString('utf8'), home))`, `fillHome(bytes.toString('utf8'), file.path.endsWith('.last-applied') ? join(root, 'other-home') : home))`))
    const problems = homeProblems(declarative, done)
    expect(problems).toEqual(expect.arrayContaining(['pair differs new-baseline/prepared', 'pair differs state']))
    expect(problems.some(p => p.startsWith('outside --home in state/config.json.last-applied: '))).toBe(true)
  })
})

describe('the reference-0.18.0 command', () => {
  const run = (argv: string[]) => { const out: string[] = [], err: string[] = []; return { code: runUpgradeCaseCommand(['reference-0.18.0', ...argv], l => out.push(l), l => err.push(l)), out, err } }
  const persona = ['--name', 'alpha', '--credentials-file', '/scenario/home/alpha/credentials.json', '--working-directory', '/scenario/work/alpha']

  test('writes a 0.18.0 config.json and a byte-identical applied baseline for the described persona', () => {
    const out = join(scratch, 'ref')
    const done = run(['--out', out, '--mode', 'declarative', ...persona, '--channel', 'C0LABEL1=all', '--channel', 'G0LABEL2=mentions',
      '--permission-prompts', 'dm', '--dm-enabled', '--dm-contact', 'U0LABEL', '--setting', 'bind=127.0.0.1', '--setting', 'port=4100',
      '--setting', 'health_check_interval=0', '--setting', 'test_mcp_drop_endpoint=true'])
    expect([done.code, done.err]).toEqual([0, []])
    expect(done.out).toEqual([`config ${join(out, 'config.json')}`, `last_applied ${join(out, 'config.json.last-applied')}`])
    const bytes = readFileSync(join(out, 'config.json'))
    expect(readFileSync(join(out, 'config.json.last-applied')).equals(bytes)).toBe(true)
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({
      personas: [{ name: 'alpha', credentials_file: '/scenario/home/alpha/credentials.json', working_directory: '/scenario/work/alpha',
        channels: [{ id: 'C0LABEL1', delivery: 'all' }, { id: 'G0LABEL2', delivery: 'mentions' }], dm: { enabled: true, contact: 'U0LABEL' }, permission_prompts: 'dm' }],
      bind: '127.0.0.1', port: 4100, health_check_interval: 0, test_mcp_drop_endpoint: true,
    })
  })

  test('fungible mode writes allow_invited_channels and the invited section, which the current loader rejects by name', () => {
    const out = join(scratch, 'ref')
    expect(run(['--out', out, '--mode', 'fungible', ...persona, '--dm-enabled', '--dm-contact', 'U0LABEL', '--invited-permission-prompts', 'dm']).code).toBe(0)
    const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'))
    expect(config.allow_invited_channels).toBe(true)
    expect(config.personas[0].invited).toEqual({ permission_prompts: 'dm' })
    expect(() => loadPersonaConfig(join(out, 'config.json'))).toThrow('allow_invited_channels has been removed; use channel_mode.')
  })

  test('the old persona keys are exactly 0.18.0 PERSONA_ENTRY_KEYS (its src/config.ts:230-240); resume_enabled is top-level only', () => {
    expect([...OLD_PERSONA_KEYS]).toEqual(['name', 'credentials_file', 'working_directory', 'channels', 'dm', 'permission_prompts', 'invited', 'claude_config_dir', 'stop_hook_bootstrap'])
    const alpha = { name: 'alpha', credentials_file: '~/c', working_directory: '~/w' }
    expect(() => oldConfigBytes018({ personas: [{ ...alpha, resume_enabled: true } as OldPersona018] })).toThrow('0.18.0 has no persona key resume_enabled')
    expect(() => oldConfigBytes018({ personas: [alpha], resume_enabled: true })).not.toThrow()
  })

  test('refuses what 0.18.0 would not accept, existing files and an output outside the temp dir', () => {
    const out = join(scratch, 'ref')
    expect(run(['--out', out, '--mode', 'declarative', ...persona, '--channel', 'C0LABEL1=off']).code).toBe(64)
    expect(run(['--out', out, '--mode', 'declarative', ...persona, '--setting', 'channel_mode=strict']).code).toBe(1)
    expect(run(['--out', out, '--mode', 'declarative', ...persona, '--setting', 'allow_invited_channels=true']).code).toBe(1)
    expect(run(['--out', out, '--mode', 'strict', ...persona]).code).toBe(64)
    expect(existsSync(out)).toBe(false)
    expect(run(['--out', join(REPO_ROOT, 'tests', 'not-here'), '--mode', 'declarative', ...persona]).code).toBe(1)
    expect(existsSync(join(REPO_ROOT, 'tests', 'not-here'))).toBe(false)
    expect(run(['--out', out, '--mode', 'declarative', ...persona]).code).toBe(0)
    const again = run(['--out', out, '--mode', 'declarative', ...persona])
    expect(again.code).toBe(1)
    expect(again.err[0]).toContain('already exists')
  })
})

describe('loading in the image', () => {
  const first = manifest.cases[0]!
  function runtimeImports(path: string): { specifier: string; typeOnly: boolean }[] {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
    return source.statements.flatMap(s => {
      if (ts.isImportDeclaration(s)) return [{ specifier: (s.moduleSpecifier as ts.StringLiteral).text, typeOnly: !!s.importClause?.isTypeOnly }]
      if (ts.isExportDeclaration(s) && s.moduleSpecifier) return [{ specifier: (s.moduleSpecifier as ts.StringLiteral).text, typeOnly: s.isTypeOnly }]
      return []
    })
  }

  test('the entry imports only node: built-ins statically and checks the image marker first', () => {
    expect(runtimeImports(ENTRY).every(i => i.specifier.startsWith('node:') && !i.typeOnly)).toBe(true)
    const source = ts.createSourceFile(ENTRY, readFileSync(ENTRY, 'utf8'), ts.ScriptTarget.ES2022, true)
    const first = source.statements.find(s => !ts.isImportDeclaration(s))!
    expect(first.getText()).toStartWith(`if (!existsSync('${IMAGE_MARKER}')) {`)
    expect(first.getText()).toContain('process.exit(2)')
  })

  test('the generator loads at run time with node: built-ins and the node:-only host-safe-env.ts', () => {
    const helper = './host-safe-env.ts'
    expect(runtimeImports(GENERATOR).filter(i => !i.typeOnly).every(i => i.specifier.startsWith('node:') || i.specifier === helper)).toBe(true)
    expect(runtimeImports(join(REPO_ROOT, 'tests', 'test-helpers', helper)).filter(i => !i.typeOnly).every(i => i.specifier.startsWith('node:'))).toBe(true)
  })

  test('a copy of the tests tree without src/ materializes a case at SCENARIO_ROOT, with HOME under it, settings and a prefix, and writes a reference', () => {
    const tree = join(scratch, 'image')
    for (const rel of ['tests/test-helpers/shared-channel-upgrade.ts', 'tests/test-helpers/host-safe-env.ts', 'tests/integration/fixtures/shared-channel-upgrade-case.ts', 'tests/fixtures/shared-channel-upgrade']) {
      cpSync(join(REPO_ROOT, rel), join(tree, rel), { recursive: true })
    }
    const scenario = join(scratch, 'scenario'), home = join(scenario, 'home'), otherTmp = join(scratch, 'other-tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(otherTmp)
    const probe = join(scratch, 'probe.ts')
    writeFileSync(probe, [
      `const m = await import(${JSON.stringify(join(tree, 'tests/test-helpers/shared-channel-upgrade.ts'))})`,
      `const root = process.env.SCENARIO_ROOT`,
      `const a = m.runUpgradeCaseCommand(['materialize', '--case', ${JSON.stringify(first.name)}, '--root', root, '--state-dir', root + '/state-1', '--home', process.env.HOME, ...${JSON.stringify([...settingArgs(SCENARIO_SETTINGS), '--persona-prefix', PREFIX])}], () => {})`,
      `const b = m.runUpgradeCaseCommand(['reference-0.18.0', '--out', root + '/ref', '--mode', 'declarative', '--name', 'alpha', '--credentials-file', '/c', '--working-directory', '/w'], () => {})`,
      `console.log(JSON.stringify([a, b]))`,
    ].join('\n'))
    const child = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10_000, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: otherTmp, SCENARIO_ROOT: scenario } }) })
    expect(child.stderr).toBe('')
    expect(child.stdout.trim()).toBe('[0,0]')
    expect(existsSync(join(tree, 'src'))).toBe(false)
    expect(existsSync(join(scenario, 'state-1', 'config.json'))).toBe(true)
    expect(readFileSync(join(scenario, 'state-1', 'channel-delivery.json'), 'utf8')).toContain(`"${home}/personas/${PREFIX}alpha/credentials.json"`)
    expect(JSON.parse(readFileSync(join(scenario, 'state-1', 'config.json'), 'utf8'))).toMatchObject(SCENARIO_SETTINGS)
    expect(existsSync(join(scenario, 'ref', 'config.json.last-applied'))).toBe(true)
  })

  test('the entry refuses outside the image before reading an argument; inside, it runs', () => {
    const home = join(scratch, 'home')
    mkdirSync(home)
    const root = join(scratch, 'root')
    mkdirSync(root)
    const child = spawnSync(process.execPath, [ENTRY, 'materialize', '--case', first.name, '--root', root, '--state-dir', join(root, 'state'), '--home', join(root, 'home')], {
      encoding: 'utf8', timeout: 10_000, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: tmpdir() } }),
    })
    if (existsSync(IMAGE_MARKER)) {
      expect(child.status).toBe(0)
      expect(existsSync(join(root, 'state', 'config.json'))).toBe(true)
    } else {
      expect(child.status).toBe(2)
      expect(child.stdout).toBe('')
      expect(child.stderr).toBe(`FAIL: shared-channel-upgrade-case: refused: ${IMAGE_MARKER} is absent; this fixture runs only in a cscb-ci image (/ci)\n`)
      expect(readdirSync(root)).toEqual([])
    }
  })
})
