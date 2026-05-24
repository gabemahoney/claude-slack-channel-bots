/**
 * agent-director-stub.ts — Test helper that mints fake `agent-director`
 * `Client` instances for unit tests (SR-8.3).
 *
 * Epic 1 scope: only the verbs the foundation needs are wired up — the
 * `Client` constructor's throw-injection points (the four typed Err* classes
 * the SR-5.1 startup gate branches on), `version()` for the version-gate
 * sub-case matrix, and `makeTemplate()` for the SR-3.2 template install path.
 * Epic 2 extends this helper to cover the full spawn / list / get / decide
 * surface CSCB uses at runtime.
 *
 * The stub does NOT extend `Client` — instantiating the real class would call
 * Bun FFI. Instead it satisfies the structural-typed verb surface CSCB calls.
 * Production code under test injects the stub via the `getClient` factory
 * passed to the startup gate (see src/agent-director-startup.ts).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrBunVersionTooOld,
  ErrPlatformPackageMissing,
  ErrTemplateExists,
  ErrTemplateMalformed,
  ErrTemplateNameUnsafe,
  ErrUnsupportedPlatform,
} from 'agent-director'
import type {
  MakeTemplateParams,
  MakeTemplateResult,
  VersionParams,
  VersionResult,
} from 'agent-director'

// ---------------------------------------------------------------------------
// Canned-result and canned-rejection factories
// ---------------------------------------------------------------------------

/** Build a canned VersionResult. */
export function cannedVersion(version: string, commit: string = 'deadbeef'): VersionResult {
  return { version, commit }
}

/** Build a canned MakeTemplateResult. */
export function cannedMakeTemplate(path: string): MakeTemplateResult {
  return { path }
}

/** Build an ErrPlatformPackageMissing (Client-constructor failure mode). */
export function errPlatformPackageMissing(pkg: string = '@agent-director/linux-x64', detail?: string): ErrPlatformPackageMissing {
  return new ErrPlatformPackageMissing(pkg, detail)
}

/** Build an ErrUnsupportedPlatform (Client-constructor failure mode). */
export function errUnsupportedPlatform(tuple: string = 'win32-x64'): ErrUnsupportedPlatform {
  return new ErrUnsupportedPlatform(tuple)
}

/** Build an ErrBunVersionTooOld (Client-constructor failure mode). */
export function errBunVersionTooOld(actual: string = '0.9.0', minimum: string = '1.0.21'): ErrBunVersionTooOld {
  return new ErrBunVersionTooOld(actual, minimum)
}

/** Build an ErrTemplateExists (makeTemplate failure mode pre-overwrite). */
export function errTemplateExists(): ErrTemplateExists {
  return new ErrTemplateExists('make-template', 'ErrTemplateExists', 'template already exists')
}

/** Build an ErrTemplateMalformed (makeTemplate fatal failure mode). */
export function errTemplateMalformed(): ErrTemplateMalformed {
  return new ErrTemplateMalformed('make-template', 'ErrTemplateMalformed', 'template malformed')
}

/** Build an ErrTemplateNameUnsafe (makeTemplate fatal failure mode). */
export function errTemplateNameUnsafe(): ErrTemplateNameUnsafe {
  return new ErrTemplateNameUnsafe('make-template', 'ErrTemplateNameUnsafe', 'unsafe template name')
}

/** Build a plain AgentDirectorError (catch-all path). */
export function errGeneric(verb: string, errName: string, message: string = 'oops'): AgentDirectorError {
  return new AgentDirectorError(verb, errName, message)
}

// ---------------------------------------------------------------------------
// Stub Client
// ---------------------------------------------------------------------------

/**
 * Injection points for `makeStubClient`. Every verb method on the stub is
 * driven by these knobs — set a `Result` to make the verb resolve with that
 * value, or set the matching `Error` to make it reject with that error.
 *
 * Verbs not listed here throw a marker error if called — that way Epic 1's
 * sub-set is enforced and Epic 2 extensions appear obvious.
 */
export interface StubClientOptions {
  /** Resolution for version(). Mutually exclusive with versionError. */
  versionResult?: VersionResult
  /** Rejection for version(). Mutually exclusive with versionResult. */
  versionError?: Error
  /** Resolution for makeTemplate(). Mutually exclusive with makeTemplateError. */
  makeTemplateResult?: MakeTemplateResult
  /** Rejection for makeTemplate(). Mutually exclusive with makeTemplateResult. */
  makeTemplateError?: Error
  /** Capture array: every makeTemplate(params) call appends params here. */
  makeTemplateCalls?: MakeTemplateParams[]
  /** Capture array: every version(params) call appends params here. */
  versionCalls?: VersionParams[]
}

/**
 * Structural-typed `Client` stub. Only the verbs in the Epic 1 surface are
 * implemented — calling any other verb throws a clear marker error so Epic 2
 * additions show up loudly when missing.
 *
 * Use `setClientForTests(makeStubClient(opts))` from
 * src/agent-director-client.ts to install the stub as the singleton.
 */
export type StubClient = {
  version(params: VersionParams): Promise<VersionResult>
  makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult>
  close(): void
  [Symbol.dispose](): void
} & Record<string, unknown>

/** Build a stub Client driven by the supplied knobs. */
export function makeStubClient(opts: StubClientOptions = {}): StubClient {
  const stub: StubClient = {
    async version(params: VersionParams): Promise<VersionResult> {
      opts.versionCalls?.push(params)
      if (opts.versionError) throw opts.versionError
      return opts.versionResult ?? cannedVersion('v0.4.3')
    },
    async makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult> {
      opts.makeTemplateCalls?.push(params)
      if (opts.makeTemplateError) throw opts.makeTemplateError
      return (
        opts.makeTemplateResult ?? cannedMakeTemplate(`~/.agent-director/templates/${params.name}.toml`)
      )
    },
    close(): void {
      // no-op
    },
    [Symbol.dispose](): void {
      // no-op
    },
  }

  // Stub the not-yet-implemented Epic 2 verbs with a loud marker. Tests that
  // accidentally exercise them will fail with a clear "extend the stub" hint.
  const epic2Verbs = [
    'spawn', 'status', 'get', 'sendKeys', 'readPane', 'kill',
    'decide', 'resume', 'findMissing', 'expire', 'delete', 'list', 'pause',
  ]
  for (const verb of epic2Verbs) {
    stub[verb] = async (_params: unknown) => {
      throw new Error(
        `agent-director-stub: '${verb}' is not implemented in the Epic 1 stub surface. Extend tests/test-helpers/agent-director-stub.ts when wiring Epic 2.`,
      )
    }
  }

  return stub
}
