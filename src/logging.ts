import { closeSync, openSync, writeSync } from 'node:fs'

// --- Logging ---

let fd: number | null = null
const originalConsoleError = console.error
const originalConsoleLog = console.log

function formatArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`
      if (arg !== null && typeof arg === 'object') return JSON.stringify(arg)
      return String(arg)
    })
    .join(' ')
}

function makeLogFn(original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const timestamp = new Date().toISOString()
    const message = formatArgs(args)
    const line = `[${timestamp}] ${message}`
    if (fd !== null) {
      try {
        writeSync(fd, line + '\n')
        return
      } catch {
        // fall through to original
      }
    }
    original(...args)
  }
}

export function initLogging(logFilePath: string): void {
  if (fd !== null) {
    try { closeSync(fd) } catch { /* ignore */ }
  }
  fd = openSync(logFilePath, 'a')
  console.error = makeLogFn(originalConsoleError) as typeof console.error
  console.log = makeLogFn(originalConsoleLog) as typeof console.log
}
