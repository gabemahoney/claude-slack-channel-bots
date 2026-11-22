/** Immutable attempt dictionaries. Only exports/full fallback enumerate history.
 * A radix tree shares unchanged records and JSON fragments between revisions;
 * replacing one binding never copies or encodes the other retained attempts.
 * The read-only facade has the same JSON object shape as the persisted map. */
import type { SharedBotAttempt } from './channel-delivery-attempt.ts'

interface Node {
  prefix: string
  children: readonly Node[]
  key?: string
  value?: SharedBotAttempt
  text: string
  byteLength: number
  count: number
}
interface BytePatch { bytes: Buffer; offset: number; removed: number; inserted: Buffer }
const roots = new WeakMap<object, { root?: Node; bytes?: Buffer; patch?: BytePatch }>()
function branch(prefix: string, children: readonly Node[]): Node {
  let text = ''
  for (const child of children) text += (text ? ',\n' : '') + child.text
  return { prefix, children, text, byteLength: children.reduce((n, child) => n + child.byteLength, 0) + Math.max(0, children.length - 1) * 2,
    count: children.reduce((n, child) => n + child.count, 0) }
}
function leaf(prefix: string, key: string, value: SharedBotAttempt, text: string): Node {
  return { prefix, key, value, text, children: [], byteLength: Buffer.byteLength(text), count: 1 }
}
/** Compressed hexadecimal radix tree: at most 64 identifier characters and
 * 16 children per node, independent of the retained record population. */
function insert(root: Node | undefined, key: string, value: SharedBotAttempt, text: string, offset = 0): Node {
  if (!root) return leaf(key.slice(offset), key, value, text)
  let common = 0
  while (common < root.prefix.length && root.prefix[common] === key[offset + common]) common++
  if (common < root.prefix.length) {
    const old = { ...root, prefix: root.prefix.slice(common) }, added = leaf(key.slice(offset + common), key, value, text)
    return branch(root.prefix.slice(0, common), old.prefix < added.prefix ? [old, added] : [added, old])
  }
  offset += common
  if (offset === key.length) return leaf(root.prefix, key, value, text)
  const children = root.children.slice(), at = children.findIndex(child => child.prefix[0]! >= key[offset]!)
  if (at < 0) children.push(leaf(key.slice(offset), key, value, text))
  else if (children[at]!.prefix[0] === key[offset]) children[at] = insert(children[at], key, value, text, offset)
  else children.splice(at, 0, leaf(key.slice(offset), key, value, text))
  return branch(root.prefix, children)
}
function find(root: Node | undefined, key: string): SharedBotAttempt | undefined {
  let offset = 0
  while (root) {
    if (!key.startsWith(root.prefix, offset)) return undefined
    offset += root.prefix.length
    if (offset === key.length) return root.value
    root = root.children.find(child => child.prefix[0] === key[offset])
  }
  return undefined
}
function keys(root: Node | undefined, out: string[]): string[] {
  if (root?.key !== undefined) out.push(root.key)
  if (root) for (const child of root.children) keys(child, out)
  return out
}
function facade(root?: Node, patch?: BytePatch): Record<string, SharedBotAttempt> {
  const immutable = () => { throw new TypeError('Committed attempt history is immutable.') }
  const value = new Proxy<Record<string, SharedBotAttempt>>({}, {
    get: (target, key, receiver) => (typeof key === 'string' ? find(root, key) : undefined) ?? Reflect.get(target, key, receiver),
    has: (target, key) => (typeof key === 'string' && find(root, key) !== undefined) || Reflect.has(target, key),
    ownKeys: () => keys(root, []),
    getOwnPropertyDescriptor: (_, key) => {
      const value = typeof key === 'string' ? find(root, key) : undefined
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false }
    },
    set: immutable, defineProperty: immutable, deleteProperty: immutable,
    setPrototypeOf: immutable, preventExtensions: immutable,
  })
  roots.set(value, { root, patch })
  return value
}
function entry(key: string, value: SharedBotAttempt): string {
  // Attempts are nested at depth three in the unchanged authority envelope.
  return '      ' + JSON.stringify(key) + ': ' + JSON.stringify(value, null, 2).replaceAll('\n', '\n      ')
}
export function isSharedAttemptMap(value: object): boolean { return roots.has(value) }
export function sharedAttemptMap(records: Record<string, SharedBotAttempt>): Record<string, SharedBotAttempt> {
  if (roots.has(records)) return records
  let root: Node | undefined
  for (const [key, value] of Object.entries(records)) root = insert(root, key, value, entry(key, value))
  return facade(root)
}
export function withSharedAttempt(records: Record<string, SharedBotAttempt>, key: string, value: SharedBotAttempt): Record<string, SharedBotAttempt> {
  const tree = roots.get(records)
  if (!tree) throw new Error('Attempt history was not prepared.')
  const text = entry(key, value)
  let patch: BytePatch | undefined
  if (tree.bytes && tree.root) {
    const at = bytePosition(tree.root, key)
    const end = at.count === tree.root.count
    const offset = end ? tree.root.byteLength : at.offset
    const inserted = Buffer.from(at.removed ? text : end ? ',\n' + text : text + ',\n')
    patch = { bytes: tree.bytes, offset: 2 + offset, removed: at.removed, inserted }
  }
  return facade(insert(tree.root, key, value, text), patch)
}
/** Byte position and rank without walking old entries. At the end of a
 * subtree the offset includes the separator leading to its next sibling. */
function bytePosition(root: Node, key: string, chars = 0): { offset: number; count: number; removed: number } {
  const before = { offset: 0, count: 0, removed: 0 }
  const after = { offset: root.byteLength + 2, count: root.count, removed: 0 }
  if (!key.startsWith(root.prefix, chars)) return key.slice(chars) < root.prefix ? before : after
  if (root.key !== undefined) return root.key === key ? { ...before, removed: root.byteLength } : after
  chars += root.prefix.length
  let offset = 0, count = 0
  for (const child of root.children) {
    if (child.prefix[0]! > key[chars]!) return { offset, count, removed: 0 }
    if (child.prefix[0] === key[chars]) {
      const at = bytePosition(child, key, chars)
      return { offset: offset + at.offset, count: count + at.count, removed: at.removed }
    }
    offset += child.byteLength + 2
    count += child.count
  }
  return after
}
/** Reusing the tree's string ropes does no history traversal. Flattening into
 * the writer's byte buffer remains proportional to the permitted file bytes. */
export function sharedAttemptEncoding(value: object, depth: number): string | undefined {
  const tree = roots.get(value)
  if (!tree || depth !== 2) return undefined
  return tree.root ? '{\n' + tree.root.text + '\n    }' : '{}'
}
/** The same flat object bytes, encoded once per immutable dictionary revision.
 * Metadata-only writes reuse them without flattening history again. */
export function sharedAttemptBytes(value: object, depth: number): Buffer | undefined {
  const tree = roots.get(value)
  if (!tree || depth !== 2) return undefined
  if (!tree.bytes && tree.patch) {
    const { bytes, offset, removed, inserted } = tree.patch
    const encoded = Buffer.allocUnsafe(bytes.length - removed + inserted.length)
    bytes.copy(encoded, 0, 0, offset)
    inserted.copy(encoded, offset)
    bytes.copy(encoded, offset + inserted.length, offset + removed)
    tree.bytes = encoded
    tree.patch = undefined
  }
  return tree.bytes ??= Buffer.from(sharedAttemptEncoding(value, depth)!)
}
