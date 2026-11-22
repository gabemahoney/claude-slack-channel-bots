/** Cached bytes of immutable canonical JSON containers. The caller owns data
 * validation and supplies native-order keys and normalized member encodings.
 * Splices copy only byte ranges whose key, value identity and depth agree. */
interface Entry { value: unknown; start: number; end: number; index: number }
interface Fragment { bytes: Buffer; list?: boolean; entries?: Map<string, Entry> }

export class SharedFragmentBytes {
  private readonly cache = new WeakMap<object, Map<number, Fragment>>()
  get(value: object, depth: number): Buffer | undefined { return this.cache.get(value)?.get(depth)?.bytes }
  keep(value: object, depth: number, bytes: Buffer): Buffer {
    this.save(value, depth, { bytes })
    return bytes
  }
  private save(value: object, depth: number, fragment: Fragment): void {
    let depths = this.cache.get(value)
    if (!depths) this.cache.set(value, depths = new Map())
    depths.set(depth, fragment)
  }
  encode(value: object, depth: number, list: boolean, keys: readonly string[], member: (key: string) => unknown,
    encode: (value: unknown, depth: number) => Buffer | undefined, base?: object): Buffer {
    const cached = this.get(value, depth)
    if (cached) return cached
    const saved = base && this.cache.get(base)?.get(depth)
    const prior = saved && saved.list === list ? saved : undefined
    const entries = new Map<string, Entry>(), out: Buffer[] = []
    const open = Buffer.from((list ? '[\n' : '{\n') + '  '.repeat(depth + 1))
    const separator = Buffer.from(',\n' + '  '.repeat(depth + 1))
    let length = 0, count = 0
    let run: { start: number; end: number; index: number } | undefined
    const append = (bytes: Buffer) => { out.push(bytes); length += bytes.length }
    const flush = () => {
      if (run) { out.push(prior!.bytes.subarray(run.start, run.end)); run = undefined }
    }
    for (const key of keys) {
      const item = member(key), old = prior?.entries?.get(key)
      if (old && Object.is(old.value, item)) {
        // Consecutive saved bodies include their original intervening
        // separators. A run's first separator comes from its new position.
        if (!run || old.index !== run.index + 1) {
          flush()
          append(count ? separator : open)
          run = { start: old.start, end: old.end, index: old.index }
        } else {
          length += old.start - run.end
          run.end = old.end
          run.index = old.index
        }
        const start = length
        length += old.end - old.start
        entries.set(key, { value: item, start, end: length, index: count++ })
        continue
      }
      const encoded = encode(item, depth + 1) ?? (list ? Buffer.from('null') : undefined)
      if (encoded === undefined) continue
      flush()
      append(count ? separator : open)
      const start = length
      if (!list) append(Buffer.from(JSON.stringify(key) + ': '))
      append(encoded)
      entries.set(key, { value: item, start, end: length, index: count++ })
    }
    flush()
    append(Buffer.from(count ? '\n' + '  '.repeat(depth) + (list ? ']' : '}') : list ? '[]' : '{}'))
    const bytes = Buffer.concat(out, length)
    this.save(value, depth, { bytes, list, entries })
    return bytes
  }
}
