/**
 * Test-only CPU profile of the packed server over a script's measured waves.
 * Diagnostic only: it prints `recorded:` lines and never sets a verdict.
 *
 * Only tests 44, 45 and 32 opt in, each for one measured server start, which
 * runs with BUN_OPTIONS="--preload cpu-profile-preload.ts" and
 * CSCB_TEST_CPU_PROFILE_DIR; each wave's name is appended to <dir>/waves:
 *   test-44's burst case: sr8-evidence's burst (SR8_PROFILE_DIR), per wave.
 *   test-45's first-hang case: sr8-evidence's fault-burst (SR8_PROFILE_DIR),
 *     per wave; the ordered writes fall in its waves, and the script marks
 *     `end` after them.
 *   test-32's thread phases: the script, one `thread-samples` wave over all
 *     20 samples, so no cut falls inside a sample unless the phase outlasts
 *     its cap. Its <dir>/interval-us samples every 100 ms and its
 *     <dir>/max-seconds caps the profile, so a long phase on a large server
 *     stays small in memory. It writes each sample's push-to-delivery interval to
 *     <dir>/samples.tsv (wave TAB start TAB end, epoch ms; wave `sample`, `delayed-lookup` or
 *     `hung-lookup`), and the summary delimits the samples by those intervals.
 * The preload samples only the daemon child, from the first wave mark until
 * `end`, every <dir>/interval-us µs (CPU_PROFILE_INTERVAL_US without it),
 * saving one part-<n>-<wave>.json per wave; parts of one wave name are
 * summarized together. With <dir>/max-seconds, its first poll that many
 * seconds after a start's request stops sampling for good, saving the wave
 * in progress (`capped`); `end` then completes the profile, whose outcome is
 * `capped`. The profile stays in scenario scratch; only the
 * summary reaches the script log.
 *
 * The server sees a mark only when its poll timer runs, so each cut records
 * its lag: the time from the last read of <dir>/waves that lacked the mark to
 * the cut, an upper bound on how late the cut is. A busy event loop delays
 * the timer; past CPU_PROFILE_SPLIT_LAG_MS the per-wave split is reported
 * `unreliable`, because a wave's work may sit in the part before it.
 *
 *   stop <dir> <wait-s>
 *     Marks `end` (unless burst already did) and waits for complete.json or
 *     error.txt. One line: recorded: cpu-profile-stop outcome=… parts=…
 *   summary <dir> <scenario> <mode> <population> <recipients>
 *     The outcome (`complete`, or `capped`, only when the declared parts are
 *     the marked waves, each with samples) and split, then per wave and for all waves:
 *     samples, weight and duration, and the top functions and files by self
 *     and total share of samples, then of weight. A sample's weight is the
 *     profiler's time delta before it (elapsed time, not exact on-CPU time).
 *     With samples.tsv: the slices line (interval count, the profile clock,
 *     and how many intervals overlap a checkpoint: a part's start, from its
 *     request to Profiler.start's answer, or its stop, from its request to
 *     the part's save), then the same rows per slice (`parts` counts its
 *     intervals, per profile part; `between` is every sample outside them).
 *     Function names and source locations only; no event, message or log content.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { isAbsolute, join } from 'node:path'

export const CPU_PROFILE_DIR_ENV = 'CSCB_TEST_CPU_PROFILE_DIR'
export const CPU_PROFILE_IMAGE_MARKER = '/etc/cscb-ci-image'
export const CPU_PROFILE_END = 'end'
export const CPU_PROFILE_TOP = 10
export const CPU_PROFILE_POLL_MS = 50
export const CPU_PROFILE_SPLIT_LAG_MS = 250
export const CPU_PROFILE_INTERVAL_US = 1000
export const CPU_PROFILE_MAX_INTERVAL_US = 100_000
export const CPU_PROFILE_LONGEST_CAP_S = 3600

/** The profile directory when this process is the CI image's daemon child
 * started with the opt-in; otherwise undefined, and nothing is profiled. */
export function cpuProfileOptIn(env: Record<string, string | undefined>, argv: readonly string[],
  marker = CPU_PROFILE_IMAGE_MARKER): string | undefined {
  const dir = env[CPU_PROFILE_DIR_ENV]
  if (!dir || !isAbsolute(dir) || env['_CLI_DAEMON_CHILD'] !== '1' || argv[2] !== 'start') return undefined
  return existsSync(marker) && existsSync(dir) ? dir : undefined
}

/** The wave names written to <dir>/waves, in order; a malformed name is skipped. */
export function waveMarks(dir: string): string[] {
  try { return readFileSync(join(dir, 'waves'), 'utf8').split('\n').filter(w => /^[a-z-]+$/.test(w)) } catch { return [] }
}

/** The sampling interval in <dir>/interval-us: a whole number of µs from
 * CPU_PROFILE_INTERVAL_US to CPU_PROFILE_MAX_INTERVAL_US; otherwise the default. */
export function samplingIntervalUs(dir: string): number {
  let text = ''
  try { text = readFileSync(join(dir, 'interval-us'), 'utf8').trim() } catch { return CPU_PROFILE_INTERVAL_US }
  const us = /^\d{1,6}$/.test(text) ? Number(text) : NaN
  return us >= CPU_PROFILE_INTERVAL_US && us <= CPU_PROFILE_MAX_INTERVAL_US ? us : CPU_PROFILE_INTERVAL_US
}

/** The profile's cap in <dir>/max-seconds: a whole number of seconds from 1
 * to CPU_PROFILE_LONGEST_CAP_S; otherwise undefined, and nothing caps it. */
export function profileCapS(dir: string): number | undefined {
  let text = ''
  try { text = readFileSync(join(dir, 'max-seconds'), 'utf8').trim() } catch { return undefined }
  const s = /^\d{1,4}$/.test(text) ? Number(text) : NaN
  return s >= 1 && s <= CPU_PROFILE_LONGEST_CAP_S ? s : undefined
}

export function savePart(dir: string, part: number, wave: string, data: object): string {
  const name = `part-${String(part).padStart(4, '0')}-${wave}.json`
  writeFileSync(join(dir, `${name}.tmp`), JSON.stringify({ wave, ...data }), { mode: 0o600 })
  renameSync(join(dir, `${name}.tmp`), join(dir, name))
  return name
}

export interface ProfilerSession {
  connect(): void
  disconnect(): void
  post(method: string, params: object, callback: (error: unknown, answer: any) => void): void
}
/** What the profiler touches outside its own state, so tests can fail each part. */
export interface ProfilerIo {
  session(): ProfilerSession
  every(tick: () => Promise<void>, ms: number): unknown
  cancel(timer: unknown): void
  write(file: string, text: string): void
  append(file: string, text: string): void
  now(): number
}
export const nodeProfilerIo: ProfilerIo = {
  session: () => new Session() as unknown as ProfilerSession,
  every: (tick, ms) => { const timer = setInterval(tick, ms); timer.unref(); return timer },
  cancel: timer => clearInterval(timer as ReturnType<typeof setInterval>),
  write: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
  append: (file, text) => appendFileSync(file, text, { mode: 0o600 }),
  now: () => performance.now(),
}

/** Samples this process between the wave marks: one part per wave,
 * `complete.json` after `end`, `error.txt` on any profiler failure. Never
 * rejects and never throws: every failure, the error marker's own included,
 * ends profiling, with the timer cancelled and the session disconnected. */
export async function startCpuProfile(dir: string, io: ProfilerIo = nodeProfilerIo): Promise<void> {
  let session: ProfilerSession | undefined, timer: unknown, done = false
  const quietly = (step: () => void) => { try { step() } catch { /* best effort: profiling is diagnostic */ } }
  const finish = (file: string, body: object) => {
    if (done) return
    done = true
    quietly(() => { if (timer !== undefined) io.cancel(timer) })
    quietly(() => session?.disconnect())
    quietly(() => io.write(join(dir, file), JSON.stringify(body)))
  }
  const post = (method: string, params = {}) => new Promise<any>((resolve, reject) =>
    session!.post(method, params, (error, answer) => error ? reject(error) : resolve(answer)))
  const event = (phase: string, extra = {}) => quietly(() => io.append(join(dir, 'observer.jsonl'),
    JSON.stringify({ phase, pid: process.pid, ts: new Date().toISOString(), ...extra }) + '\n'))
  let wave: string | undefined, startRequestedAt = '', startedAt = '', startLagMs = 0, seen = 0, part = 0, busy = false, lastRead = 0
  let startRequestedMs = 0, capped = false
  const intervalUs = samplingIntervalUs(dir), capS = profileCapS(dir)
  const save = async (stopLagMs: number, extra = {}) => {
    const stopRequestedAt = new Date().toISOString(), { profile } = await post('Profiler.stop')
    const name = savePart(dir, part++, wave!, { pid: process.pid, intervalUs, startRequestedAt, startedAt, stopRequestedAt,
      stoppedAt: new Date().toISOString(), startLagMs, stopLagMs, ...extra, profile })
    event('saved', { wave, name })
    wave = undefined
    return name
  }
  const tick = async () => {
    if (busy || done) return
    busy = true
    try {
      const since = lastRead
      lastRead = io.now()
      const marks = waveMarks(dir)
      while (!done && seen < marks.length) {
        const next = marks[seen++]!, lagMs = Math.round(io.now() - since)
        if (wave !== undefined) await save(lagMs)
        if (next === CPU_PROFILE_END) return finish('complete.json', capped ? { parts: part, capped: true } : { parts: part })
        if (capped) continue
        startRequestedAt = new Date().toISOString(); startRequestedMs = io.now()
        await post('Profiler.start')
        wave = next; startedAt = new Date().toISOString(); startLagMs = lagMs
        event('started', { wave, lagMs })
      }
      const sampledMs = io.now() - startRequestedMs
      if (!done && wave !== undefined && capS !== undefined && sampledMs >= capS * 1000) {
        const capWave = wave, name = await save(Math.round(sampledMs - capS * 1000), { cappedAfterMs: Math.round(sampledMs) })
        capped = true
        event('capped', { wave: capWave, name, afterMs: Math.round(sampledMs) })
      }
    } catch {
      finish('error.txt', { error: 'profiler checkpoint failed' })
    } finally { busy = false }
  }
  try {
    session = io.session()
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: intervalUs })
    event('ready', { intervalUs })
    lastRead = io.now()
    timer = io.every(() => tick().catch(() => finish('error.txt', { error: 'profiler checkpoint failed' })), CPU_PROFILE_POLL_MS)
  } catch { finish('error.txt', { error: 'profiler initialization failed' }) }
}

interface CallFrame { functionName?: string; url?: string; lineNumber?: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; startTime?: number; endTime?: number }
export interface ProfilePart {
  wave: string; profile: CpuProfile; startLagMs?: number; stopLagMs?: number
  /** ISO times of the part's checkpoints, and its file name; absent in older parts. */
  startRequestedAt?: string; startedAt?: string; stopRequestedAt?: string; file?: string
}
/** Sample counts and weights (µs) of one function or file. */
export interface FrameShare { name: string; self: number; total: number; selfUs: number; totalUs: number }
export interface WaveSummary {
  wave: string; parts: number; samples: number; weightUs: number; durationMs: number
  startLagMs?: number; stopLagMs?: number; functions: FrameShare[]; files: FrameShare[]
}

const ROOT_FRAME = '(root)'
const token = (text: string, fallback: string) => text.replace(/[^\x21-\x7e]+/g, '_').slice(0, 160) || fallback
/** A file as the summary names it: the path below the last node_modules, or the whole path. */
export function frameFile(url: string | undefined): string {
  const path = (url ?? '').replace(/^file:\/\//, '')
  const below = path.lastIndexOf('/node_modules/')
  return token(below < 0 ? path : path.slice(below + '/node_modules/'.length), '(native)')
}
export function frameName(frame: CallFrame): string {
  const line = Number.isInteger(frame.lineNumber) && frame.lineNumber! >= 0 ? `:${frame.lineNumber! + 1}` : ''
  return `${token(frame.functionName ?? '', '(anonymous)')}@${frameFile(frame.url)}${line}`
}
const maxLag = (lags: (number | undefined)[]) => lags.some(l => !Number.isFinite(l)) ? undefined : Math.max(0, ...lags as number[])

/** Self and total sample counts and weights per function and per file. Each
 * sample counts once toward every distinct frame on its stack, weighted by
 * its time delta; `(root)` is never ranked. */
export function summarizeWave(wave: string, parts: ProfilePart[]): WaveSummary {
  const fns = new Map<string, FrameShare>(), files = new Map<string, FrameShare>()
  let samples = 0, weightUs = 0, durationUs = 0
  const bump = (map: Map<string, FrameShare>, name: string, field: 'self' | 'total', n: number, us: number) => {
    const share = map.get(name) ?? { name, self: 0, total: 0, selfUs: 0, totalUs: 0 }
    share[field] += n; share[field === 'self' ? 'selfUs' : 'totalUs'] += us; map.set(name, share)
  }
  for (const { profile } of parts) {
    const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map<number, number>()
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const hits = new Map<number, { n: number; us: number }>()
    for (const [i, id] of (profile.samples ?? []).entries()) {
      if (!nodes.has(id)) continue
      const us = Math.max(0, Number(profile.timeDeltas?.[i]) || 0), hit = hits.get(id) ?? { n: 0, us: 0 }
      hit.n++; hit.us += us; hits.set(id, hit); samples++; weightUs += us
    }
    if (Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime)) durationUs += Math.max(0, profile.endTime! - profile.startTime!)
    for (const [id, { n, us }] of hits) {
      const leaf = nodes.get(id)!.callFrame
      if (leaf.functionName !== ROOT_FRAME) { bump(fns, frameName(leaf), 'self', n, us); bump(files, frameFile(leaf.url), 'self', n, us) }
      const seen = new Set<number>(), stackFns = new Set<string>(), stackFiles = new Set<string>()
      for (let at: number | undefined = id; at !== undefined && !seen.has(at); at = parent.get(at)) {
        seen.add(at)
        const frame = nodes.get(at)!.callFrame
        if (frame.functionName === ROOT_FRAME) continue
        stackFns.add(frameName(frame)); stackFiles.add(frameFile(frame.url))
      }
      for (const name of stackFns) bump(fns, name, 'total', n, us)
      for (const name of stackFiles) bump(files, name, 'total', n, us)
    }
  }
  return { wave, parts: parts.length, samples, weightUs, durationMs: Math.round(durationUs / 1000),
    startLagMs: maxLag(parts.map(p => p.startLagMs)), stopLagMs: maxLag(parts.map(p => p.stopLagMs)),
    functions: [...fns.values()], files: [...files.values()] }
}

const pct = (n: number, of: number) => of ? String(Math.round(1000 * n / of) / 10) : '0'
const RANKINGS = [['self', 'self'], ['total', 'total'], ['self_weight', 'selfUs'], ['total_weight', 'totalUs']] as const
const ranked = (shares: FrameShare[], by: 'self' | 'total' | 'selfUs' | 'totalUs', top: number) =>
  shares.filter(s => s[by] > 0).sort((a, b) => b[by] - a[by] || b.self - a.self || (a.name < b.name ? -1 : 1)).slice(0, top)
const lagText = (lag: number | undefined) => lag === undefined ? 'unknown' : String(lag)

/** Content-free lines: one per wave in profile order and `all`, each followed
 * by its top functions and files by self and total share of samples, then
 * by self and total share of weight. */
export function summaryLines(context: string, parts: ProfilePart[], top = CPU_PROFILE_TOP, all = true): string[] {
  const waves = [...new Set(parts.map(p => p.wave))]
  const groups = [...waves.map(w => summarizeWave(w, parts.filter(p => p.wave === w))), ...(all && parts.length ? [summarizeWave('all', parts)] : [])]
  return groups.flatMap(g => {
    const head = `recorded: cpu-profile ${context} wave=${g.wave}`
    const rows = (kind: 'function' | 'file', shares: FrameShare[], n: number) => RANKINGS.flatMap(([by, field]) =>
      ranked(shares, field, n).map((s, i) => `recorded: cpu-profile-${kind} ${context} wave=${g.wave} by=${by} rank=${i + 1}`
        + ` self_samples=${s.self} self_pct=${pct(s.self, g.samples)} total_samples=${s.total} total_pct=${pct(s.total, g.samples)}`
        + ` self_weight_us=${s.selfUs} self_weight_pct=${pct(s.selfUs, g.weightUs)} total_weight_us=${s.totalUs} total_weight_pct=${pct(s.totalUs, g.weightUs)}`
        + ` ${kind}=${s.name}`))
    return [`${head} parts=${g.parts} samples=${g.samples} weight_ms=${Math.round(g.weightUs / 1000)} duration_ms=${g.durationMs}`
      + ` start_lag_ms=${lagText(g.startLagMs)} stop_lag_ms=${lagText(g.stopLagMs)}`,
    ...rows('function', g.functions, top), ...rows('file', g.files, Math.ceil(top / 2))]
  })
}

const partFile = /^part-\d{4}-[a-z-]+\.json$/
const lagField = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const timeField = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
export function readParts(dir: string): ProfilePart[] | undefined {
  try {
    return readdirSync(dir).filter(f => partFile.test(f)).sort().map(f => {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof data?.wave !== 'string' || !Array.isArray(data?.profile?.nodes)) throw new Error('part')
      return { wave: data.wave, profile: data.profile, startLagMs: lagField(data.startLagMs), stopLagMs: lagField(data.stopLagMs),
        startRequestedAt: timeField(data.startRequestedAt), startedAt: timeField(data.startedAt), stopRequestedAt: timeField(data.stopRequestedAt), file: f }
    })
  } catch { return undefined }
}

/** One sample's push-to-delivery interval from <dir>/samples.tsv, epoch ms. */
export interface SampleInterval { wave: string; startMs: number; endMs: number }
/** undefined when there is no samples.tsv; 'unreadable' when any line is malformed. */
export function readSampleIntervals(dir: string): SampleInterval[] | 'unreadable' | undefined {
  if (!existsSync(join(dir, 'samples.tsv'))) return undefined
  try {
    const intervals = readFileSync(join(dir, 'samples.tsv'), 'utf8').split('\n').filter(Boolean).map(line => {
      const [wave, start, end, extra] = line.split('\t')
      const startMs = Number(start), endMs = Number(end)
      if (extra !== undefined || !/^[a-z-]+$/.test(wave ?? '') || !/^\d+$/.test(start ?? '') || !/^\d+$/.test(end ?? '') || endMs < startMs) throw new Error('interval')
      return { wave: wave!, startMs, endMs }
    })
    return intervals.length ? intervals : 'unreadable'
  } catch { return 'unreadable' }
}

/** The epoch-µs offset of a part's profile clock: Bun's profiles are on the
 * epoch clock already; any other clock is anchored at the part's startedAt. */
function clockOffsetUs(part: ProfilePart): { offsetUs: number; clock: 'epoch' | 'anchored' } | undefined {
  const start = part.profile.startTime, startedMs = part.startedAt === undefined ? NaN : Date.parse(part.startedAt)
  if (!Number.isFinite(start) || !Number.isFinite(startedMs)) return undefined
  return Math.abs(start! / 1000 - startedMs) <= 60_000 ? { offsetUs: 0, clock: 'epoch' } : { offsetUs: startedMs * 1000 - start!, clock: 'anchored' }
}

/** Each part's samples cut by the intervals: one synthetic part per part and
 * interval, named by the interval's wave, then `between` for each part's
 * samples outside them. A sample belongs to the half-open interval holding
 * its own time; a synthetic part's duration is its overlap with the part. */
export function sliceParts(parts: ProfilePart[], intervals: SampleInterval[]): { clock: string; slices: ProfilePart[] } {
  const clocks = parts.map(clockOffsetUs)
  if (!parts.length || clocks.some(c => c === undefined)) return { clock: 'unavailable', slices: [] }
  const sliced = parts.map((part, p) => {
    const { profile } = part, offsetUs = clocks[p]!.offsetUs
    const from = profile.startTime! + offsetUs, to = Number.isFinite(profile.endTime) ? profile.endTime! + offsetUs : from
    const views = [...intervals, undefined].map(v => ({ wave: v?.wave ?? 'between', samples: [] as number[], timeDeltas: [] as number[],
      durationUs: v ? Math.max(0, Math.min(to, v.endMs * 1000) - Math.max(from, v.startMs * 1000)) : 0 }))
    views.at(-1)!.durationUs = Math.max(0, to - from - views.slice(0, -1).reduce((n, v) => n + v.durationUs, 0))
    let at = from
    for (const [i, id] of (profile.samples ?? []).entries()) {
      const delta = Math.max(0, Number(profile.timeDeltas?.[i]) || 0)
      at += delta
      const k = intervals.findIndex(v => at >= v.startMs * 1000 && at < v.endMs * 1000)
      views.at(k)!.samples.push(id); views.at(k)!.timeDeltas.push(delta)
    }
    return views.map(v => ({ wave: v.wave, profile: { nodes: profile.nodes, samples: v.samples, timeDeltas: v.timeDeltas, startTime: 0, endTime: v.durationUs } }))
  })
  // Intervals in file order, then `between`, across parts.
  return { clock: clocks.some(c => c!.clock === 'anchored') ? 'anchored' : 'epoch',
    slices: intervals.map((_, k) => k).concat(intervals.length).flatMap(k => sliced.map(views => views[k]!)) }
}

/** How many intervals overlap a checkpoint: a part's start (startRequestedAt
 * to startedAt) or its stop (stopRequestedAt to the observer's `saved` time);
 * `unknown` when any checkpoint time is missing. */
export function checkpointOverlap(dir: string, parts: ProfilePart[], intervals: SampleInterval[]): string {
  let saved: Map<string, number>
  try {
    saved = new Map(readFileSync(join(dir, 'observer.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(e => e?.phase === 'saved' && typeof e.name === 'string').map(e => [e.name, Date.parse(e.ts)]))
  } catch { return 'unknown' }
  const at = (iso: string | undefined) => iso === undefined ? NaN : Date.parse(iso)
  const checkpoints = parts.flatMap(p => [[at(p.startRequestedAt), at(p.startedAt)], [at(p.stopRequestedAt), saved.get(p.file ?? '') ?? NaN]])
  if (!parts.length || checkpoints.some(([from, to]) => !Number.isFinite(from) || !Number.isFinite(to))) return 'unknown'
  // A checkpoint is closed at both ends (ms resolution), an interval half-open.
  return String(intervals.filter(v => checkpoints.some(([from, to]) => from! < v.endMs && v.startMs <= to!)).length)
}

/** `complete` (`capped` when its cap stopped sampling) only when
 * complete.json declares the saved parts, the parts are the marked waves in
 * order, and every part holds samples; `inconsistent` when complete.json
 * says otherwise. */
export function profileOutcome(dir: string, parts: ProfilePart[] | undefined): string {
  if (!parts) return 'unreadable'
  if (existsSync(join(dir, 'error.txt'))) return 'error'
  if (!existsSync(join(dir, 'complete.json'))) return 'incomplete'
  let declared: unknown, capped = false
  try {
    const complete = JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8'))
    declared = complete?.parts; capped = complete?.capped === true
  } catch { /* inconsistent below */ }
  const marks = waveMarks(dir), end = marks.indexOf(CPU_PROFILE_END)
  const expected = end < 0 ? marks : marks.slice(0, end)
  const usable = declared === parts.length && parts.length > 0 && parts.map(p => p.wave).join('\n') === expected.join('\n')
    && parts.every(p => summarizeWave(p.wave, [p]).samples > 0)
  return !usable ? 'inconsistent' : capped ? 'capped' : 'complete'
}

/** Whether each part holds its own wave's work: `unreliable` when any cut's
 * lag is unknown or over CPU_PROFILE_SPLIT_LAG_MS. */
export function profileSplit(parts: ProfilePart[]): string {
  if (!parts.length) return 'split=unavailable max_lag_ms=unknown'
  const lag = maxLag(parts.flatMap(p => [p.startLagMs, p.stopLagMs]))
  return `split=${lag !== undefined && lag <= CPU_PROFILE_SPLIT_LAG_MS ? 'reliable' : 'unreliable'} max_lag_ms=${lagText(lag)}`
}

/** Lines for the script log: the profile's outcome and split first, then its summary. */
export function summaryReport(dir: string, context: string): string[] {
  const parts = readParts(dir), intervals = readSampleIntervals(dir)
  const lines = [`recorded: cpu-profile ${context} wave=none outcome=${profileOutcome(dir, parts)} parts=${parts?.length ?? 0} ${profileSplit(parts ?? [])}`,
    ...summaryLines(context, parts ?? [])]
  if (intervals === undefined) return lines
  if (intervals === 'unreadable') return [...lines, `recorded: cpu-profile ${context} wave=none slices=unreadable clock=unavailable checkpoint_overlap=unknown`]
  const { clock, slices } = sliceParts(parts ?? [], intervals)
  return [...lines, `recorded: cpu-profile ${context} wave=none slices=${intervals.length} clock=${clock} checkpoint_overlap=${checkpointOverlap(dir, parts ?? [], intervals)}`,
    ...summaryLines(context, slices, CPU_PROFILE_TOP, false)]
}

async function stop(dir: string, waitS: number): Promise<string> {
  if (waveMarks(dir).at(-1) !== CPU_PROFILE_END) appendFileSync(join(dir, 'waves'), `${CPU_PROFILE_END}\n`, { mode: 0o600 })
  const until = performance.now() + waitS * 1000
  const outcome = () => existsSync(join(dir, 'error.txt')) ? 'error' : existsSync(join(dir, 'complete.json')) ? 'complete' : undefined
  while (!outcome() && performance.now() < until) await new Promise(r => setTimeout(r, 100))
  return `recorded: cpu-profile-stop outcome=${outcome() ?? 'timeout'} parts=${readParts(dir)?.length ?? 0}`
}

const word = /^[A-Za-z0-9._-]+$/
if (import.meta.main) {
  const [command, dir, ...rest] = process.argv.slice(2)
  if (command === 'stop' && dir && isAbsolute(dir) && existsSync(dir) && rest.length === 1 && Number(rest[0]) > 0) {
    console.log(await stop(dir, Number(rest[0])))
  } else if (command === 'summary' && dir && isAbsolute(dir) && rest.length === 4 && rest.every(r => word.test(r))) {
    const [scenario, mode, population, recipients] = rest
    console.log(summaryReport(dir, `scenario=${scenario} mode=${mode} population=${population} recipients=${recipients}`).join('\n'))
  } else { console.error('FAIL: cpu-profile invalid command arguments'); process.exitCode = 64 }
}
