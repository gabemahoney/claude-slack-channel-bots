/**
 * Durable-step seams over real files for the shared durable journal.
 *
 * Journal writers wait for the disk with callback `fs.fsync` and `fs.rename`
 * on the I/O pool; only Thread Memory's read-time quarantine uses the blocking
 * `fsyncSync`/`renameSync`. `durableIo` intercepts both forms, so one fault,
 * record or hold covers whichever form the production code uses, and each
 * recorded step names its form. Every other call goes to `base` unchanged.
 *
 * A callback step whose `before` hook returns a promise is held until that
 * promise settles; a rejection fails the step without its syscall. Steps in
 * flight (not held) are counted, so `createFakeClock().settleOn(io)` can make
 * `flush()` wait for the real disk work the code under test started.
 *
 * A seam's `fs`, or an object spread from it, carries a mark. A `durableIo`
 * over a marked base passes its callback steps through uncounted, and reports
 * the base's in-flight and held steps as its own, so a step the inner seam holds
 * never counts as in flight. A base that spreads a seam but replaces its
 * `fsync` or `rename` must not keep the mark; that step would be counted by neither.
 */
import * as fs from 'node:fs'

export type DurableStepForm = 'callback' | 'sync'
export interface DurableStep {
  op: 'fsync' | 'rename'
  form: DurableStepForm
  /** The synced descriptor's path as opened through this seam, or the rename source. */
  path: string
  fd?: number
  to?: string
}
export interface DurableIoOptions {
  /** Every non-durable call, and the real durable syscalls. Default `node:fs`. */
  base?: typeof fs
  /** Runs before each step's syscall. Throw to fail the step without it. */
  before?: (step: DurableStep) => void | Promise<void>
}
/** What a fake clock waits on: whether a step is in flight, and its next completion. */
export interface DurableIoSettle {
  busy(): boolean
  next(): Promise<void>
}

const SEAM = Symbol('durableIo seam')
interface SeamState extends DurableIoSettle { held(): number }

export function durableIo(options: DurableIoOptions = {}) {
  const base = options.base ?? fs
  const inner = (base as unknown as { [SEAM]?: SeamState })[SEAM]
  const paths = new Map<number, string>(), steps: DurableStep[] = []
  let inflight = 0, held = 0, waiters: Array<() => void> = []
  const settled = () => { inflight--; const wake = waiters; waiters = []; for (const w of wake) w() }
  const pathOf = (fd: number) => paths.get(fd) ?? '<unknown-fd>'
  function blocking(step: DurableStep, perform: () => void): void {
    steps.push(step)
    const hold = options.before?.(step)
    if (hold instanceof Promise) throw new Error(`durableIo: a blocking ${step.op} cannot be held`)
    perform()
  }
  function callback(step: DurableStep, perform: (done: (error: NodeJS.ErrnoException | null) => void) => void, cb: (error: NodeJS.ErrnoException | null) => void): void {
    steps.push(step)
    const start = () => {
      if (inner) { perform(cb); return }
      inflight++; perform(error => { settled(); cb(error) })
    }
    // Real callbacks never run synchronously; neither does an injected failure.
    const fail = (error: unknown) => { inflight++; setImmediate(() => { settled(); cb(error as NodeJS.ErrnoException) }) }
    let hold: void | Promise<void>
    try { hold = options.before?.(step) } catch (error) { fail(error); return }
    if (!(hold instanceof Promise)) { start(); return }
    held++
    hold.then(() => { held--; start() }, error => { held--; fail(error) })
  }
  const busy = () => inflight > 0 || inner?.busy() === true
  const next = () => {
    const own = new Promise<void>(resolve => { waiters.push(resolve) })
    return inner ? Promise.race([own, inner.next()]) : own
  }
  const state: SeamState = { busy, next, held: () => held + (inner?.held() ?? 0) }
  const seam = {
    ...base,
    [SEAM]: state,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = base.openSync(...args); paths.set(fd, String(args[0])); return fd },
    closeSync(fd: number) { base.closeSync(fd); paths.delete(fd) },
    fsyncSync(fd: number) { blocking({ op: 'fsync', form: 'sync', path: pathOf(fd), fd }, () => base.fsyncSync(fd)) },
    renameSync(from: fs.PathLike, to: fs.PathLike) { blocking({ op: 'rename', form: 'sync', path: String(from), to: String(to) }, () => base.renameSync(from, to)) },
    fsync(fd: number, cb: (error: NodeJS.ErrnoException | null) => void) {
      callback({ op: 'fsync', form: 'callback', path: pathOf(fd), fd }, done => base.fsync(fd, done), cb)
    },
    rename(from: fs.PathLike, to: fs.PathLike, cb: (error: NodeJS.ErrnoException | null) => void) {
      callback({ op: 'rename', form: 'callback', path: String(from), to: String(to) }, done => base.rename(from, to, done), cb)
    },
  } as unknown as typeof fs
  return {
    fs: seam,
    /** Every durable step in call order, held and failed ones included. */
    steps,
    /** Open descriptors' paths, as opened through this seam. */
    paths,
    busy,
    /** Callback steps waiting on a `before` hold, a marked base's included. */
    held: state.held,
    next,
    /** Resolves once no step is in flight; held steps do not count. */
    async idle(): Promise<void> { while (busy()) await next() },
  }
}
export type DurableIo = ReturnType<typeof durableIo>

/** Real files whose file syncs (never directory syncs) fail, in either form, while `when()` holds. */
export function failFileSyncs(when: () => boolean, message: string, base?: typeof fs): typeof fs {
  return durableIo({ base, before(step) {
    if (step.op === 'fsync' && when() && fs.fstatSync(step.fd!).isFile()) throw new Error(message)
  } }).fs
}

/** A gate a `before` hook can return: the step waits until `release()` or `fail(error)`. */
export function heldStep() {
  let release!: () => void, fail!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
  promise.catch(() => {})
  return { promise, release, fail }
}

/** A seam holding the first callback fsync whose path `match` accepts while `state.armed`
 * (armed unless `armed: false`); every other step runs. `reached()` resolves once it is held. */
export function holdFirstSync(match: (path: string) => boolean, options: { armed?: boolean; base?: typeof fs } = {}) {
  const gate = heldStep(), state = { armed: options.armed ?? true, path: '' }, reached = Promise.withResolvers<void>()
  const io = durableIo({ base: options.base, before(step) {
    if (!state.armed || step.op !== 'fsync' || !match(step.path)) return
    state.armed = false; state.path = step.path; reached.resolve()
    return gate.promise
  } })
  return { io, gate, state, reached: () => reached.promise }
}
