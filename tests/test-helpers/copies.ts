/** Counts the deep copies source code makes, whichever copier makes them. */
import { spyOn } from 'bun:test'
import * as journal from '../../src/durable-journal.ts'

export interface CopySpy {
  /** The value each deep copy started from, in call order. */
  readonly values: unknown[]
  /** Copies made through `structuredClone` itself, whose serialisation round
   * trip copies every string, `cloneJournalData`'s own fallback included. */
  readonly serialised: number
  clear(): void
  restore(): void
}

/** Spies on `structuredClone` and `cloneJournalData`. Each deep copy counts
 * once: a `cloneJournalData` call that falls back to `structuredClone` is one
 * copy. Bun's module spies reach every importer of `cloneJournalData`. */
export function spyOnCopies(): CopySpy {
  const clone = globalThis.structuredClone, copyData = journal.cloneJournalData
  const values: unknown[] = []
  let serialised = 0, inside = 0
  const structured = spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown, options?: StructuredSerializeOptions) => {
    serialised++
    if (!inside) values.push(value)
    return clone(value, options)
  }) as typeof structuredClone)
  const data = spyOn(journal, 'cloneJournalData').mockImplementation((<T>(value: T): T => {
    values.push(value)
    inside++
    try { return copyData(value) } finally { inside-- }
  }) as typeof journal.cloneJournalData)
  return {
    values,
    get serialised() { return serialised },
    clear() { values.length = 0; serialised = 0 },
    restore() { structured.mockRestore(); data.mockRestore() },
  }
}
