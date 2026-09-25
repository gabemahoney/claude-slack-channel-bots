/**
 * reload-preview.test.ts — Tests for the structured change plan and the
 * pending-change preview (b.av2 SR-8.4, SR-8.6, SR-10.3) in
 * src/reload-plan.ts: `buildChangePlan`, `changePlanCounts`,
 * `renderChangePlanCounts`, `renderPreviewLines`, `renderPreview`,
 * `renderPreviewLogLines`, `renderInvalidLogLine` and `isCredentialsBroken`,
 * plus the plan's `configDirsChanged` flag (the agent-director template
 * refresh, SR-8.6 step 5, never rendered) and facts the caller could not
 * gather (`FACT_UNKNOWN`).
 *
 * Every function here is pure, so the tests call them directly: configs are
 * resolved from file-form JSON with `parsePersonaConfigBytes` (defaults and
 * inheritance as the loader applies them), and every I/O fact (real paths,
 * credentials digests, bring-up states, why an added persona cannot come up)
 * is injected as data. One row per SR-8.6 change kind pins its class, its
 * effect wording, the `DESTRUCTIVE:` prefix exactly when the instance is
 * destroyed, and its header count. What the detection tick gathers and when
 * it writes and logs the preview is covered in tests/reload.test.ts.
 *
 * Every rendered output (preview lines, the joined text and both log forms)
 * goes through `render`, which runs `assertNoLeak` over it; fixtures carry
 * sentinel-bearing fake tokens (credentials causes, a malformed config, a
 * token pasted as a key name) so a leak would fail.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parsePersonaConfigBytes,
  type PersonaConfig,
  type PersonaConfigInput,
  type PersonaInput,
} from '../src/config.ts'
import type { PersonaBringUpState } from '../src/persona-bringup-controller.ts'
import { credentialsReadProblem } from '../src/persona-credentials.ts'
import {
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_SLACK_UNREACHABLE,
} from '../src/persona-diagnostics.ts'
import {
  buildChangePlan,
  changePlanCounts,
  FACT_UNKNOWN,
  isCredentialsBroken,
  renderChangePlanCounts,
  renderInvalidLogLine,
  renderPreview,
  renderPreviewLines,
  renderPreviewLogLines,
  PENDING_PREVIEW_TITLE,
  type AddedPersonaCause,
  type ChangePlan,
  type ChangePlanCandidate,
  type ChangePlanCounts,
  type ChangePlanFacts,
  type InPlaceSetting,
  type InvalidChangePlan,
  type NextLaunchSetting,
  type ValidChangePlan,
} from '../src/reload-plan.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, makeCredentials } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig, makePersona } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string
let home: string
let configPath: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reload-preview-')))
  home = join(root, 'home')
  configPath = join(root, 'config.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A file-form persona named (and keyed) `name`, in its own `all` channel, with paths under the root. */
function persona(name: string, channel: string, overrides: Partial<PersonaInput> = {}): PersonaInput {
  return makePersona({ name, channels: [{ id: channel, delivery: 'all' }], permission_prompts: channel, ...overrides }, root)
}

/**
 * The applied file-form config: alpha and charlie inherit the top-level
 * `claude_config_dir`; bravo has two channels, a DM contact with DMs off and
 * its own `claude_config_dir`.
 */
function baseInput(): PersonaConfigInput {
  return {
    personas: [
      persona('alpha', 'C0A0001'),
      persona('bravo', 'C0B0001', {
        channels: [
          { id: 'C0B0001', delivery: 'all' },
          { id: 'C0B0002', delivery: 'mentions' },
        ],
        dm: { enabled: false, contact: 'U0B0001' },
        claude_config_dir: join(root, 'bravo-claude'),
      }),
      persona('charlie', 'C0C0001'),
    ],
    claude_config_dir: join(root, 'claude-default'),
  }
}

type EditableInput = PersonaConfigInput & Record<string, unknown>

/** Resolve a file-form config as the loader does in default mode (`~` under the temp home). */
function parse(input: unknown, text: string = JSON.stringify(input, null, 2)): PersonaConfig {
  return parsePersonaConfigBytes(text, configPath, root, { home })
}

/** The applied config: `baseInput()` resolved. */
function applied(): PersonaConfig {
  return parse(baseInput())
}

/** `baseInput()` with `mutate` applied, resolved. */
function edited(mutate: (c: EditableInput) => void): PersonaConfig {
  const input = structuredClone(baseInput()) as EditableInput
  mutate(input)
  return parse(input)
}

/** The file-form entry of `name` in an input being edited. */
function entry(c: PersonaConfigInput, name: string): PersonaInput {
  const found = c.personas.find((p) => p.name === name)
  if (found === undefined) throw new Error(`no persona ${name} in the fixture`)
  return found
}

const valid = (config: PersonaConfig): ChangePlanCandidate => ({ kind: 'valid', config })

/** The candidate's credentials file of a base persona, as the config names it. */
const credentialsOf = (name: string): string => join(root, 'personas', name, 'credentials.json')

/** Paths `realPath` resolves elsewhere (a symlink, say); any other path is its own real path. */
let aliases: Map<string, string>
beforeEach(() => {
  aliases = new Map()
})

/** Facts with the alias-map real path, the temp home and whatever else the case sets. */
function facts(extra: Partial<ChangePlanFacts> = {}): ChangePlanFacts {
  return { realPath: (p) => aliases.get(p) ?? p, home, ...extra }
}

/**
 * Credentials facts: digests held by key and current by path, why the content
 * at a path cannot be used, and the keys broken by their credentials now.
 */
function credentialsFacts(opts: {
  held?: Record<string, string>
  current?: Record<string, string>
  problems?: Record<string, string>
  broken?: string[]
  dryRun?: boolean
}): ChangePlanFacts {
  return facts({
    dryRun: opts.dryRun,
    heldCredentialsDigest: (key) => opts.held?.[key],
    currentCredentialsDigest: (path) => opts.current?.[path],
    credentialsProblem: (path) => opts.problems?.[path],
    bringUpState: (key) =>
      opts.broken?.includes(key)
        ? {
            outcome: 'broken',
            causes: { credentials: { step: 'credentials', class: PERSONA_CREDENTIALS_INVALID, cause: 'x' } },
          }
        : { outcome: 'up', causes: {} },
  })
}

/** Fake digests: never shown in any output. */
const DIGEST_OLD = `sha256:${'a'.repeat(64)}`
const DIGEST_NEW = `sha256:${'b'.repeat(64)}`

/**
 * bravo's credentials rotated in place: held and current digests differ at the
 * same path. With `problem`, the new content cannot be used, for that cause.
 */
function bravoRotated(extra: { broken?: string[]; problem?: string } = {}): ChangePlanFacts {
  const { problem, ...rest } = extra
  return credentialsFacts({
    held: { bravo: DIGEST_OLD },
    current: { [credentialsOf('bravo')]: DIGEST_NEW },
    problems: problem === undefined ? undefined : { [credentialsOf('bravo')]: problem },
    ...rest,
  })
}

/** A plan with every class empty, then `overrides`. */
function planWith(overrides: Partial<ValidChangePlan>): ValidChangePlan {
  return {
    valid: true,
    added: [],
    removed: [],
    destructive: [],
    inPlace: [],
    credentials: [],
    nextLaunch: [],
    unchanged: [],
    settings: [],
    noEffectiveChange: false,
    configDirsChanged: false,
    ...overrides,
  }
}

/** A plan persona reference; base personas' indexes are their candidate positions. */
const ref = (key: string, index: number) => ({ key, name: key, index })

/** Header counts: zero unless given. */
function counts(c: Partial<ChangePlanCounts>): ChangePlanCounts {
  return { added: 0, removed: 0, destructive: 0, inPlace: 0, credentials: 0, settings: 0, ...c }
}

/** The preview header line for `c`. */
const header = (c: Partial<ChangePlanCounts>): string => `${PENDING_PREVIEW_TITLE} ${renderChangePlanCounts(counts(c))}.`

const NO_EFFECT_LINE =
  'A configuration change is pending; nothing has been applied. no effective change: applying it would change no persona and no server-wide setting.'

const PENDING_FILE = '/state/config.json.pending'

/** Build and render a plan, leak-checking the plan and every rendered form. */
function render(plan: ChangePlan): string[] {
  const lines = renderPreviewLines(plan)
  const text = renderPreview(plan)
  const log = plan.valid ? renderPreviewLogLines(plan, PENDING_FILE) : [renderInvalidLogLine(plan, PENDING_FILE)]
  assertNoLeak({ plan, lines, text, log }, 'preview')
  return lines
}

/** The plan of `candidate` against the applied base config, rendered. */
function preview(candidate: PersonaConfig, f: ChangePlanFacts = facts()): { plan: ValidChangePlan; lines: string[] } {
  const plan = buildChangePlan(applied(), valid(candidate), f)
  if (!plan.valid) throw new Error('expected a valid plan')
  return { plan, lines: render(plan) }
}

const destructiveLines = (lines: string[]): string[] => lines.filter((l) => l.startsWith('DESTRUCTIVE:'))

// ---------------------------------------------------------------------------
// Added
// ---------------------------------------------------------------------------

describe('added personas', () => {
  test('an added persona beside unchanged ones is the only change, with a line saying it will be brought up', () => {
    const { plan, lines } = preview(edited((c) => c.personas.push(persona('delta', 'C0D0001'))))

    expect(plan).toEqual(
      planWith({
        added: [{ ...ref('delta', 3), cannotComeUp: [] }],
        unchanged: [ref('alpha', 0), ref('bravo', 1), ref('charlie', 2)],
      }),
    )
    expect(changePlanCounts(plan)).toEqual(counts({ added: 1 }))
    expect(lines).toEqual([
      header({ added: 1 }),
      'persona "delta" (key=delta) is added: it will be brought up and launched.',
    ])
  })

  const credentialsCause = (content: string): AddedPersonaCause => {
    const cause = credentialsReadProblem({ ok: true, bytes: Buffer.from(content) })
    if (cause === undefined) throw new Error('fixture content is valid')
    return { step: 'credentials', cause }
  }
  const missingCredentials: AddedPersonaCause = { step: 'credentials', cause: 'credentials file does not exist' }
  const missingDirectory: AddedPersonaCause = { step: 'working-directory', cause: 'working directory does not exist' }

  test.each<[string, () => AddedPersonaCause[], string[]]>([
    [
      'a credentials file of the wrong shape',
      () => [credentialsCause(JSON.stringify([makeCredentials()]))],
      ['credentials file is invalid: not a JSON object'],
    ],
    [
      'a bad token prefix (named by key and rule, never by value)',
      () => [credentialsCause(JSON.stringify(makeCredentials({ bot_token: fakeToken('xoxp-') })))],
      [`credentials file is invalid: bot_token must start with ${BOT_TOKEN_PREFIX}`],
    ],
    [
      'both causes',
      () => [missingCredentials, missingDirectory],
      ['credentials file does not exist', 'working directory does not exist'],
    ],
  ])('an added persona with %s says it cannot come up and why', (_label, causes, expected) => {
    const cannotComeUp = causes()
    const { plan, lines } = preview(
      edited((c) => c.personas.push(persona('delta', 'C0D0001'))),
      facts({ addedCannotComeUp: new Map([['delta', cannotComeUp]]) }),
    )

    expect(plan.added).toEqual([{ ...ref('delta', 3), cannotComeUp }])
    expect(lines).toEqual([
      header({ added: 1 }),
      `persona "delta" (key=delta) is added but cannot come up: ${expected.join('; ')}.`,
    ])
  })

  test('an entry with no causes, or for another persona, leaves the added persona able to come up', () => {
    const { plan, lines } = preview(
      edited((c) => c.personas.push(persona('delta', 'C0D0001'))),
      facts({ addedCannotComeUp: new Map([['delta', []], ['echo', [missingDirectory]]]) }),
    )

    expect(plan.added).toEqual([{ ...ref('delta', 3), cannotComeUp: [] }])
    expect(lines[1]).toBe('persona "delta" (key=delta) is added: it will be brought up and launched.')
  })
})

// ---------------------------------------------------------------------------
// Removed and renamed
// ---------------------------------------------------------------------------

describe('removed and renamed personas', () => {
  test('a removal is one DESTRUCTIVE: line saying the live session will be destroyed', () => {
    const { plan, lines } = preview(edited((c) => c.personas.splice(1, 1)))

    // bravo was the only user of its own config dir.
    expect(plan).toEqual(
      planWith({ removed: [ref('bravo', 1)], unchanged: [ref('alpha', 0), ref('charlie', 1)], configDirsChanged: true }),
    )
    expect(lines).toEqual([
      header({ removed: 1 }),
      'DESTRUCTIVE: persona "bravo" (key=bravo) is removed: its live session will be destroyed (its instance is torn down).',
    ])
  })

  test('a name change that changes the key is a removal of the old key and an addition of the new', () => {
    const { plan, lines } = preview(edited((c) => (entry(c, 'bravo').name = 'bravo_two')))

    expect(plan.removed).toEqual([ref('bravo', 1)])
    expect(plan.added).toEqual([{ ...ref('bravo_two', 1), cannotComeUp: [] }])
    expect(plan.destructive).toEqual([])
    expect(changePlanCounts(plan)).toEqual(counts({ added: 1, removed: 1 }))
    expect(destructiveLines(lines)).toEqual([
      'DESTRUCTIVE: persona "bravo" (key=bravo) is removed: its live session will be destroyed (its instance is torn down).',
    ])
    expect(lines).toContain('persona "bravo_two" (key=bravo_two) is added: it will be brought up and launched.')
  })

  test('a name change that keeps the key is a destructive modify', () => {
    const paths = { key: 'ops', credentials_file: join(root, 'ops.json'), working_directory: join(root, 'ops') }
    const before = makeMultiPersonaConfig([{ name: 'Ops', ...paths }], root)
    const after = makeMultiPersonaConfig([{ name: 'Ops Bot', ...paths }], root)
    const plan = buildChangePlan(before, valid(after), facts())
    if (!plan.valid) throw new Error('expected a valid plan')

    expect(plan.destructive.map((p) => [p.key, p.settings])).toEqual([['ops', ['name']]])
    expect(render(plan)).toEqual([
      header({ destructive: 1 }),
      'DESTRUCTIVE: persona "Ops Bot" (key=ops) name changed: its live session will be destroyed, then it is brought up fresh.',
    ])
  })
})

// ---------------------------------------------------------------------------
// Destructive modify
// ---------------------------------------------------------------------------

describe('destructive modify', () => {
  test.each(['credentials_file', 'working_directory'] as const)(
    'a %s whose real path changed is DESTRUCTIVE: torn down, then brought up fresh',
    (setting) => {
      const moved = join(root, 'moved', setting)
      const { plan, lines } = preview(edited((c) => (entry(c, 'bravo')[setting] = moved)))

      expect(plan.destructive).toEqual([
        {
          ...ref('bravo', 1),
          settings: [setting],
          credentials_file: setting === 'credentials_file' ? moved : credentialsOf('bravo'),
          working_directory: setting === 'working_directory' ? moved : join(root, 'personas', 'bravo', 'work'),
        },
      ])
      expect(plan.unchanged).toEqual([ref('alpha', 0), ref('charlie', 2)])
      expect(lines).toEqual([
        header({ destructive: 1 }),
        `DESTRUCTIVE: persona "bravo" (key=bravo) ${setting} changed to ${JSON.stringify(moved)}: ` +
          'its live session will be destroyed, then it is brought up fresh.',
      ])
    },
  )

  test('both destructive paths changed give one line naming both', () => {
    const { plan, lines } = preview(
      edited((c) => {
        entry(c, 'bravo').credentials_file = join(root, 'new-creds.json')
        entry(c, 'bravo').working_directory = join(root, 'new-work')
      }),
    )

    expect(plan.destructive.map((p) => p.settings)).toEqual([['credentials_file', 'working_directory']])
    expect(lines).toEqual([
      header({ destructive: 1 }),
      `DESTRUCTIVE: persona "bravo" (key=bravo) credentials_file changed to ${JSON.stringify(join(root, 'new-creds.json'))} ` +
        `and working_directory changed to ${JSON.stringify(join(root, 'new-work'))}: ` +
        'its live session will be destroyed, then it is brought up fresh.',
    ])
  })
})

// ---------------------------------------------------------------------------
// In place
// ---------------------------------------------------------------------------

describe('in-place changes', () => {
  test.each<[InPlaceSetting, (b: PersonaInput) => void]>([
    ['channels', (b) => b.channels!.push({ id: 'C0B0003', delivery: 'all' })],
    ['channels', (b) => b.channels!.splice(1, 1)],
    // One channel swapped for another: the count is unchanged, the set is not.
    ['channels', (b) => (b.channels![1] = { id: 'C0B0003', delivery: 'mentions' })],
    ['delivery', (b) => (b.channels![1]!.delivery = 'all')],
    ['permission_prompts', (b) => (b.permission_prompts = 'C0B0002')],
    ['dm.enabled', (b) => (b.dm = { enabled: true, contact: 'U0B0001' })],
    ['dm.contact', (b) => (b.dm = { enabled: false, contact: 'U0B0002' })],
  ])('a %s change is applied in place immediately and keeps the instance', (setting, mutate) => {
    const { plan, lines } = preview(edited((c) => mutate(entry(c, 'bravo'))))

    expect(plan).toEqual(
      planWith({
        inPlace: [{ ...ref('bravo', 1), settings: [setting] }],
        unchanged: [ref('alpha', 0), ref('charlie', 2)],
      }),
    )
    expect(lines).toEqual([
      header({ inPlace: 1 }),
      `persona "bravo" (key=bravo): ${setting} changed: applied in place immediately, instance kept.`,
    ])
  })

  test('several in-place settings of one persona share one line, in the fixed setting order', () => {
    const { lines } = preview(
      edited((c) => {
        const b = entry(c, 'bravo')
        b.dm = { enabled: true, contact: 'U0B0002' }
        b.channels![1]!.delivery = 'all'
      }),
    )

    expect(lines).toEqual([
      header({ inPlace: 1 }),
      'persona "bravo" (key=bravo): delivery, dm.enabled, dm.contact changed: applied in place immediately, instance kept.',
    ])
  })
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credentials changed', () => {
  test('a rotated file at the same path is one non-destructive line naming the persona and path', () => {
    const { plan, lines } = preview(applied(), bravoRotated())

    expect(plan).toEqual(
      planWith({
        credentials: [
          { ...ref('bravo', 1), path: credentialsOf('bravo'), credentialsBroken: false, retrying: false, problem: undefined },
        ],
        unchanged: [ref('alpha', 0), ref('charlie', 2)],
      }),
    )
    expect(lines).toEqual([
      header({ credentials: 1 }),
      `persona "bravo" (key=bravo): credentials file ${JSON.stringify(credentialsOf('bravo'))} changed: ` +
        'a new connection opens, then the old one closes, instance kept.',
    ])
    expect(JSON.stringify({ plan, lines })).not.toContain('sha256:')
  })

  test('a persona broken by its credentials now will be brought up', () => {
    const { plan, lines } = preview(applied(), bravoRotated({ broken: ['bravo'] }))

    expect(plan.credentials).toEqual([
      { ...ref('bravo', 1), path: credentialsOf('bravo'), credentialsBroken: true, retrying: false, problem: undefined },
    ])
    expect(lines).toEqual([
      header({ credentials: 1 }),
      `persona "bravo" (key=bravo): credentials file ${JSON.stringify(credentialsOf('bravo'))} changed: ` +
        'it is broken by its credentials now, so it will be brought up.',
    ])
  })

  const failure = (step: 'credentials' | 'working-directory' | 'slack', cls: string) => ({ step, class: cls, cause: 'x' })

  /** The bring-up states a credentials-changed persona can be in. */
  const STATES = {
    brokenLocally: { outcome: 'broken', causes: { credentials: failure('credentials', PERSONA_CREDENTIALS_INVALID) } },
    brokenRefused: { outcome: 'broken', causes: { slack: failure('slack', PERSONA_CREDENTIALS_REFUSED) } },
    brokenOther: { outcome: 'broken', causes: { slack: failure('slack', 'error') } },
    retryingSlack: { outcome: 'retrying', causes: { slack: failure('slack', PERSONA_SLACK_UNREACHABLE) } },
    retryingDirectory: {
      outcome: 'retrying',
      causes: { directory: failure('working-directory', PERSONA_DIRECTORY_MISSING) },
    },
    up: { outcome: 'up', causes: {} },
    /** Its first Slack attempt is in flight: no outcome yet, so no connection yet. */
    firstAttempt: { outcome: undefined, causes: {} },
  } satisfies Record<string, PersonaBringUpState>

  test.each<[string, PersonaBringUpState | undefined, boolean, boolean]>([
    ['broken by a locally invalid credentials file', STATES.brokenLocally, true, false],
    ['broken because Slack refused its token', STATES.brokenRefused, true, false],
    ['broken by another Slack error', STATES.brokenOther, false, false],
    ['retrying: Slack unreachable', STATES.retryingSlack, false, true],
    ['retrying: working directory missing', STATES.retryingDirectory, false, true],
    ['up', STATES.up, false, false],
    ['in its first Slack attempt (no outcome yet)', STATES.firstAttempt, false, true],
    ['the controller does not know', undefined, false, false],
  ])('a persona %s is credentials-broken and retrying exactly as its state says', (_label, state, broken, retrying) => {
    const { plan } = preview(applied(), { ...bravoRotated(), bringUpState: () => state })

    expect(isCredentialsBroken(state)).toBe(broken)
    expect(plan.credentials.map((p) => [p.credentialsBroken, p.retrying, p.problem])).toEqual([[broken, retrying, undefined]])
  })

  /** A credentials cause the check gives for `content` (sentinel-bearing), so a leak through the cause would show. */
  const causeOf = (content: string): string => {
    const cause = credentialsReadProblem({ ok: true, bytes: Buffer.from(content) })
    if (cause === undefined) throw new Error('fixture content is valid')
    return cause
  }
  const MISSING = 'credentials file does not exist'
  const DIRECTORY = 'credentials file is a directory'
  const NOT_REGULAR = 'credentials file is not a regular file'
  const NOT_JSON = (): string => causeOf(`{"bot_token": ${JSON.stringify(fakeToken(BOT_TOKEN_PREFIX))}`)
  const BAD_PREFIX = (): string => causeOf(JSON.stringify(makeCredentials({ bot_token: fakeToken('xoxp-') })))
  const EXTRA_KEY = (): string => causeOf(JSON.stringify(makeCredentials({ [fakeToken(BOT_TOKEN_PREFIX)]: 'pasted' })))

  /**
   * Every credentials effect (b.av2 SR-8.6, credentials row): the bring-up
   * state (`FACT_UNKNOWN` when it could not be queried) by whether the new
   * content can be used (`problem`, undefined when it can). `rest` is the
   * line after `credentials file "<path>" changed`, spelled out in full.
   */
  test.each<[string, PersonaBringUpState | undefined | typeof FACT_UNKNOWN, (() => string) | undefined, (cause: string) => string]>([
    ['up, content valid', STATES.up, undefined, () => ': a new connection opens, then the old one closes, instance kept.'],
    ['up, file missing', STATES.up, () => MISSING, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    ['up, a directory', STATES.up, () => DIRECTORY, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    ['up, not a regular file', STATES.up, () => NOT_REGULAR, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    ['up, malformed JSON holding a token', STATES.up, NOT_JSON, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    ['up, a bad token prefix', STATES.up, BAD_PREFIX, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    ['up, a token pasted as a key name', STATES.up, EXTRA_KEY, (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`],
    [
      'unknown to the controller (taken as not broken), content valid',
      undefined,
      undefined,
      () => ': a new connection opens, then the old one closes, instance kept.',
    ],
    [
      'unknown to the controller, file missing',
      undefined,
      () => MISSING,
      (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`,
    ],
    [
      'broken by another Slack error (not by its credentials), content valid',
      STATES.brokenOther,
      undefined,
      () => ': a new connection opens, then the old one closes, instance kept.',
    ],
    [
      'broken by another Slack error, content invalid',
      STATES.brokenOther,
      BAD_PREFIX,
      (c) => `, but it cannot be used (${c}): the current connection is kept, instance kept.`,
    ],
    [
      'retrying (Slack unreachable), content valid',
      STATES.retryingSlack,
      undefined,
      () => ': it has no connection yet, so it retries with the new content, instance kept.',
    ],
    [
      'retrying (working directory missing), content valid',
      STATES.retryingDirectory,
      undefined,
      () => ': it has no connection yet, so it retries with the new content, instance kept.',
    ],
    [
      'retrying (Slack unreachable), file missing',
      STATES.retryingSlack,
      () => MISSING,
      (c) => `, but it cannot be used (${c}): it keeps retrying with its current content, instance kept.`,
    ],
    [
      'retrying (working directory missing), malformed JSON holding a token',
      STATES.retryingDirectory,
      NOT_JSON,
      (c) => `, but it cannot be used (${c}): it keeps retrying with its current content, instance kept.`,
    ],
    [
      'in its first Slack attempt (no outcome yet), content valid',
      STATES.firstAttempt,
      undefined,
      () => ': it has no connection yet, so it retries with the new content, instance kept.',
    ],
    [
      'in its first Slack attempt (no outcome yet), file missing',
      STATES.firstAttempt,
      () => MISSING,
      (c) => `, but it cannot be used (${c}): it keeps retrying with its current content, instance kept.`,
    ],
    [
      'broken by its local credentials check, content valid',
      STATES.brokenLocally,
      undefined,
      () => ': it is broken by its credentials now, so it will be brought up.',
    ],
    [
      'broken by Slack refusing its token, content valid',
      STATES.brokenRefused,
      undefined,
      () => ': it is broken by its credentials now, so it will be brought up.',
    ],
    [
      'broken by its local credentials check, file missing',
      STATES.brokenLocally,
      () => MISSING,
      (c) => `, but it cannot be used (${c}): it stays broken by its credentials.`,
    ],
    [
      'broken by Slack refusing its token, a bad token prefix',
      STATES.brokenRefused,
      BAD_PREFIX,
      (c) => `, but it cannot be used (${c}): it stays broken by its credentials.`,
    ],
    [
      'whose state could not be queried, content valid',
      FACT_UNKNOWN,
      undefined,
      () => '; whether it is broken by its credentials now could not be checked.',
    ],
    [
      'whose state could not be queried, malformed JSON holding a token',
      FACT_UNKNOWN,
      NOT_JSON,
      (c) => `, but it cannot be used (${c}); whether it is broken by its credentials now could not be checked.`,
    ],
  ])('a persona %s: its credentials line states the effect', (_label, state, problemOf, rest) => {
    const problem = problemOf?.()
    const { plan, lines } = preview(applied(), { ...bravoRotated({ problem }), bringUpState: () => state })

    expect(plan.credentials.map((p) => p.problem)).toEqual([problem])
    expect(changePlanCounts(plan)).toEqual(counts({ credentials: 1 }))
    expect(lines).toEqual([
      header({ credentials: 1 }),
      `persona "bravo" (key=bravo): credentials file ${JSON.stringify(credentialsOf('bravo'))} changed${rest(problem ?? '')}`,
    ])
    // `render` ran assertNoLeak over the plan and every form: a cause from sentinel-bearing content leaked nothing.
  })

  test('why the content cannot be used is asked only for a credentials-changed persona, by its path, and never in dry run', () => {
    const asked: string[] = []
    const recording = (dryRun: boolean): ChangePlanFacts => ({
      ...bravoRotated(),
      dryRun,
      credentialsProblem: (path) => {
        asked.push(path)
        return MISSING
      },
    })

    const { plan } = preview(applied(), recording(false))
    expect(plan.credentials.map((p) => [p.key, p.problem])).toEqual([['bravo', MISSING]])
    expect(new Set(asked)).toEqual(new Set([credentialsOf('bravo')]))

    asked.length = 0
    const dry = preview(applied(), recording(true))
    expect(dry.plan.credentials).toEqual([])
    expect(dry.lines).toEqual([NO_EFFECT_LINE])
    expect(asked).toEqual([])
  })

  test.each<[string, () => { candidate: PersonaConfig; facts: ChangePlanFacts }]>([
    [
      'in dry run',
      () => ({
        candidate: applied(),
        facts: credentialsFacts({ dryRun: true, held: { bravo: DIGEST_OLD }, current: { [credentialsOf('bravo')]: DIGEST_NEW } }),
      }),
    ],
    [
      'when nothing is held',
      () => ({ candidate: applied(), facts: credentialsFacts({ current: { [credentialsOf('bravo')]: DIGEST_NEW } }) }),
    ],
    [
      'when the file was not read',
      () => ({ candidate: applied(), facts: credentialsFacts({ held: { bravo: DIGEST_OLD } }) }),
    ],
    [
      'when the digests are equal',
      () => ({
        candidate: applied(),
        facts: credentialsFacts({ held: { bravo: DIGEST_OLD }, current: { [credentialsOf('bravo')]: DIGEST_OLD } }),
      }),
    ],
  ])('credentials never count as changed %s', (_label, setup) => {
    const { candidate, facts: f } = setup()
    const { plan, lines } = preview(candidate, f)

    expect(plan.credentials).toEqual([])
    expect(plan.noEffectiveChange).toBe(true)
    expect(lines).toEqual([NO_EFFECT_LINE])
  })

  test('a changed credentials_file path with changed content is a destructive modify only', () => {
    const moved = join(root, 'moved-creds.json')
    const { plan, lines } = preview(
      edited((c) => (entry(c, 'bravo').credentials_file = moved)),
      credentialsFacts({ held: { bravo: DIGEST_OLD }, current: { [moved]: DIGEST_NEW, [credentialsOf('bravo')]: DIGEST_NEW } }),
    )

    expect(plan.credentials).toEqual([])
    expect(plan.destructive.map((p) => p.key)).toEqual(['bravo'])
    expect(changePlanCounts(plan)).toEqual(counts({ destructive: 1 }))
    expect(lines.filter((l) => l.includes('credentials file'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Several changes to one persona
// ---------------------------------------------------------------------------

describe('several changes to one persona', () => {
  test('an in-place and a credentials change give one line with both effects, counted in both classes', () => {
    const { plan, lines } = preview(edited((c) => (entry(c, 'bravo').channels![1]!.delivery = 'all')), bravoRotated())

    expect(changePlanCounts(plan)).toEqual(counts({ inPlace: 1, credentials: 1 }))
    expect(lines).toEqual([
      header({ inPlace: 1, credentials: 1 }),
      'persona "bravo" (key=bravo): delivery changed: applied in place immediately, instance kept; ' +
        `credentials file ${JSON.stringify(credentialsOf('bravo'))} changed: a new connection opens, then the old one closes, instance kept.`,
    ])
  })

  test('an in-place and an own next-launch change give one line, counted once as modified in place', () => {
    const { plan, lines } = preview(
      edited((c) => {
        entry(c, 'bravo').channels![1]!.delivery = 'all'
        entry(c, 'bravo').stop_hook_bootstrap = false
      }),
    )

    expect(changePlanCounts(plan)).toEqual(counts({ inPlace: 1 }))
    expect(lines).toEqual([
      header({ inPlace: 1 }),
      'persona "bravo" (key=bravo): delivery changed: applied in place immediately, instance kept; ' +
        'stop_hook_bootstrap changed: takes effect at its next launch, instance kept.',
    ])
  })

  test('a destructive change with in-place, next-launch and credentials changes counts only as destructive', () => {
    const { plan, lines } = preview(
      edited((c) => {
        const b = entry(c, 'bravo')
        b.working_directory = join(root, 'new-work')
        b.channels![1]!.delivery = 'all'
        b.stop_hook_bootstrap = false
      }),
      bravoRotated(),
    )

    expect(plan.destructive.map((p) => [p.key, p.settings])).toEqual([['bravo', ['working_directory']]])
    expect([plan.inPlace, plan.credentials, plan.nextLaunch]).toEqual([[], [], []])
    expect(changePlanCounts(plan)).toEqual(counts({ destructive: 1 }))
    expect(lines).toHaveLength(2)
    expect(lines[1]!.startsWith('DESTRUCTIVE: persona "bravo" (key=bravo) working_directory changed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Next launch: own and inherited
// ---------------------------------------------------------------------------

describe('next-launch changes', () => {
  test.each<[NextLaunchSetting[], (b: PersonaInput) => void, boolean, string]>([
    [
      ['claude_config_dir'],
      (b) => (b.claude_config_dir = join(root, 'bravo-claude-2')),
      true,
      'claude_config_dir changed: takes effect at its next launch, which starts fresh (the conversation is not resumed), ' +
        'instance kept until then.',
    ],
    [
      ['stop_hook_bootstrap'],
      (b) => (b.stop_hook_bootstrap = false),
      false,
      'stop_hook_bootstrap changed: takes effect at its next launch, instance kept.',
    ],
    [
      ['claude_config_dir', 'stop_hook_bootstrap'],
      (b) => {
        b.stop_hook_bootstrap = false
        b.claude_config_dir = join(root, 'bravo-claude-2')
      },
      true,
      'claude_config_dir, stop_hook_bootstrap changed: takes effect at its next launch, which starts fresh ' +
        '(the conversation is not resumed), instance kept until then.',
    ],
  ])('a persona\'s own %p takes effect at its next launch and counts as modified in place', (settings, mutate, dirs, effect) => {
    const { plan, lines } = preview(edited((c) => mutate(entry(c, 'bravo'))))

    expect(plan).toEqual(
      planWith({
        nextLaunch: [{ ...ref('bravo', 1), own: settings, inherited: [] }],
        unchanged: [ref('alpha', 0), ref('charlie', 2)],
        configDirsChanged: dirs,
      }),
    )
    expect(lines).toEqual([header({ inPlace: 1 }), `persona "bravo" (key=bravo): ${effect}`])
  })

  test.each<[NextLaunchSetting, (c: EditableInput) => void, boolean, string]>([
    [
      'claude_config_dir',
      (c) => (c.claude_config_dir = join(root, 'claude-default-2')),
      true,
      "takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.",
    ],
    [
      'stop_hook_bootstrap',
      (c) => {
        c.stop_hook_bootstrap = false
        entry(c, 'bravo').stop_hook_bootstrap = true
      },
      false,
      "takes effect at each one's next launch, instance kept.",
    ],
  ])(
    'a changed top-level %s is one settings line listing exactly its inheritors, with no persona line',
    (setting, mutate, dirs, effect) => {
      const { plan, lines } = preview(edited(mutate))

      expect(plan.configDirsChanged).toBe(dirs)
      expect(plan.settings).toEqual([{ name: setting, inheritedBy: [ref('alpha', 0), ref('charlie', 2)] }])
      expect(plan.nextLaunch.map((p) => [p.key, p.own, p.inherited])).toEqual([
        ['alpha', [], [setting]],
        ['charlie', [], [setting]],
      ])
      expect(changePlanCounts(plan)).toEqual(counts({ settings: 1 }))
      expect(lines).toEqual([
        header({ settings: 1 }),
        `server-wide setting ${setting} changed: inherited by "alpha" (key=alpha), "charlie" (key=charlie); ${effect}`,
      ])
    },
  )

  test('a persona that left the old default for a value of its own is marked own, not an inheritor', () => {
    const { plan, lines } = preview(
      edited((c) => {
        c.claude_config_dir = join(root, 'claude-default-2')
        entry(c, 'charlie').claude_config_dir = join(root, 'charlie-claude')
      }),
    )

    expect(plan.settings).toEqual([{ name: 'claude_config_dir', inheritedBy: [ref('alpha', 0)] }])
    expect(changePlanCounts(plan)).toEqual(counts({ inPlace: 1, settings: 1 }))
    expect(lines).toEqual([
      header({ inPlace: 1, settings: 1 }),
      'persona "charlie" (key=charlie): claude_config_dir changed: takes effect at its next launch, ' +
        'which starts fresh (the conversation is not resumed), instance kept until then.',
      'server-wide setting claude_config_dir changed: inherited by "alpha" (key=alpha); ' +
        "takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.",
    ])
  })

  test('a persona with its own value that moves to exactly the new default is marked own, not an inheritor', () => {
    const newDefault = join(root, 'claude-default-2')
    const { plan, lines } = preview(
      edited((c) => {
        c.claude_config_dir = newDefault
        entry(c, 'bravo').claude_config_dir = newDefault
      }),
    )

    // bravo's value before was its own bravo-claude, not the old default, so it did not follow the default.
    expect(plan.nextLaunch.map((p) => [p.key, p.own, p.inherited])).toEqual([
      ['alpha', [], ['claude_config_dir']],
      ['bravo', ['claude_config_dir'], []],
      ['charlie', [], ['claude_config_dir']],
    ])
    expect(plan.settings).toEqual([{ name: 'claude_config_dir', inheritedBy: [ref('alpha', 0), ref('charlie', 2)] }])
    expect(changePlanCounts(plan)).toEqual(counts({ inPlace: 1, settings: 1 }))
    expect(lines).toEqual([
      header({ inPlace: 1, settings: 1 }),
      'persona "bravo" (key=bravo): claude_config_dir changed: takes effect at its next launch, ' +
        'which starts fresh (the conversation is not resumed), instance kept until then.',
      'server-wide setting claude_config_dir changed: inherited by "alpha" (key=alpha), "charlie" (key=charlie); ' +
        "takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.",
    ])
  })

  test('a destructively modified or added persona is not listed as inheriting a changed default', () => {
    const { plan } = preview(
      edited((c) => {
        c.claude_config_dir = join(root, 'claude-default-2')
        entry(c, 'charlie').working_directory = join(root, 'new-work')
        c.personas.push(persona('delta', 'C0D0001'))
      }),
    )

    expect(plan.settings).toEqual([{ name: 'claude_config_dir', inheritedBy: [ref('alpha', 0)] }])
  })

  test.each<[NextLaunchSetting, (c: EditableInput) => void]>([
    [
      'claude_config_dir',
      (c) => {
        c.claude_config_dir = join(root, 'claude-default-2')
        entry(c, 'alpha').claude_config_dir = join(root, 'claude-default')
        entry(c, 'charlie').claude_config_dir = join(root, 'claude-default')
      },
    ],
    [
      'stop_hook_bootstrap',
      (c) => {
        c.stop_hook_bootstrap = false
        for (const p of c.personas) p.stop_hook_bootstrap = true
      },
    ],
  ])('a changed default %s that no persona inherits is recorded and says no instance is affected', (setting, mutate) => {
    const plan = buildChangePlan(applied(), valid(edited(mutate)), facts())
    if (!plan.valid) throw new Error('expected a valid plan')

    expect(plan.configDirsChanged).toBe(false)
    expect(plan.settings).toEqual([{ name: setting, inheritedBy: [] }])
    expect(plan.nextLaunch).toEqual([])
    expect(render(plan)).toEqual([
      header({ settings: 1 }),
      `server-wide setting ${setting} changed: once applied, it is recorded; no persona inherits it, so no instance is affected.`,
    ])
  })
})

// ---------------------------------------------------------------------------
// Server-wide settings
// ---------------------------------------------------------------------------

describe('server-wide settings', () => {
  test('a changed port is recorded for the next server start and changes no persona', () => {
    const { plan, lines } = preview(edited((c) => (c.port = 3200)))

    expect(plan).toEqual(
      planWith({ settings: [{ name: 'port' }], unchanged: [ref('alpha', 0), ref('bravo', 1), ref('charlie', 2)] }),
    )
    expect(lines).toEqual([
      header({ settings: 1 }),
      'server-wide setting port changed: once applied, it is recorded and takes effect at the next server start after that.',
    ])
  })

  test.each<[string, (c: EditableInput) => void, string[]]>([
    ['a path setting moved to another real path', (c) => (c.cron_log_path = join(root, 'other.log')), ['cron_log_path']],
    ['a path setting that was unset', (c) => (c.message_archive_db = join(root, 'archive.db')), ['message_archive_db']],
    [
      'several settings, in the fixed key order',
      (c) => {
        c.stop_timeout = 45
        c.reply_chunk_limit = 2000
        c.bind = '0.0.0.0'
      },
      ['bind', 'stop_timeout', 'reply_chunk_limit'],
    ],
  ])('%s is a changed setting', (_label, mutate, names) => {
    const { plan, lines } = preview(edited(mutate))

    expect(plan.settings).toEqual(names.map((name) => ({ name })))
    expect(changePlanCounts(plan)).toEqual(counts({ settings: names.length }))
    expect(lines.slice(1)).toEqual(
      names.map(
        (name) =>
          `server-wide setting ${name} changed: once applied, it is recorded and takes effect at the next server start after that.`,
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// No effective change, and paths by real path
// ---------------------------------------------------------------------------

describe('no effective change', () => {
  test.each<[string, () => PersonaConfig]>([
    ['a whitespace-only edit', () => parse(baseInput(), JSON.stringify(baseInput()))],
    [
      'a key-reorder edit',
      () => {
        const input = baseInput()
        const reversed = (o: object) => Object.fromEntries(Object.entries(o).reverse())
        return parse(reversed({ ...input, personas: input.personas.map(reversed) }))
      },
    ],
    [
      'keys added with their default values',
      () =>
        edited((c) => {
          c.port = 3100
          c.bind = '127.0.0.1'
          c.stop_hook_bootstrap = true
          c.cron_table_path = join(root, 'crontab')
          entry(c, 'alpha').stop_hook_bootstrap = true
          entry(c, 'alpha').claude_config_dir = join(root, 'claude-default')
        }),
    ],
    ['a channel reorder', () => edited((c) => entry(c, 'bravo').channels!.reverse())],
    [
      'a credentials_file written as a symlink to the same file',
      () => {
        aliases.set(join(root, 'link-creds.json'), credentialsOf('bravo'))
        return edited((c) => (entry(c, 'bravo').credentials_file = join(root, 'link-creds.json')))
      },
    ],
    [
      'a working_directory written in a ~ form of the same directory',
      // The temp home is <root>/home, so this expands to <root>/personas/bravo/work.
      () => edited((c) => (entry(c, 'bravo').working_directory = '~/../personas/bravo/work')),
    ],
    [
      'a server-wide path setting through a symlink to the same file',
      () => {
        aliases.set(join(root, 'link-cron.log'), join(root, 'cron.log'))
        return edited((c) => (c.cron_log_path = join(root, 'link-cron.log')))
      },
    ],
  ])('%s reads no effective change, with no DESTRUCTIVE: line', (_label, candidate) => {
    const { plan, lines } = preview(candidate())

    expect(plan).toEqual(
      planWith({ unchanged: [ref('alpha', 0), ref('bravo', 1), ref('charlie', 2)], noEffectiveChange: true }),
    )
    expect(changePlanCounts(plan)).toEqual(counts({}))
    expect(lines).toEqual([NO_EFFECT_LINE])
  })

  test('a path written differently whose real path differs is compared by the injected real path, not the disk', () => {
    const target = join(root, 'personas', 'bravo', 'work')
    const link = join(root, 'link-work')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, link)
    const candidate = edited((c) => (entry(c, 'bravo').working_directory = link))

    // The real symlink on disk is ignored: identity says the paths differ.
    const differs = buildChangePlan(applied(), valid(candidate), facts({ realPath: (p) => p }))
    expect(differs.valid && differs.destructive.map((p) => p.key)).toEqual(['bravo'])

    // And an alias the disk knows nothing of makes two unrelated paths the same.
    const unrelated = join(root, 'nowhere')
    const aliased = buildChangePlan(
      applied(),
      valid(edited((c) => (entry(c, 'bravo').working_directory = unrelated))),
      facts({ realPath: (p) => (p === unrelated ? target : p) }),
    )
    expect(aliased.valid && aliased.noEffectiveChange).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// configDirsChanged: the template refresh (SR-8.6 step 5), never rendered
// ---------------------------------------------------------------------------

describe('configDirsChanged', () => {
  /** A file-form config of `personas`, with a top-level `claude_config_dir` only when `top` is given. */
  const bare = (personas: PersonaInput[], top?: string): PersonaConfigInput => ({
    personas,
    ...(top !== undefined ? { claude_config_dir: top } : {}),
  })
  const alpha = (overrides: Partial<PersonaInput> = {}): PersonaInput => persona('alpha', 'C0A0001', overrides)
  const delta = (overrides: Partial<PersonaInput> = {}): PersonaInput => persona('delta', 'C0D0001', overrides)
  /** alpha alone, with no config dir anywhere: it runs on `<home>/.claude`. */
  const defaultOnly = (): PersonaConfig => parse(bare([alpha()]))
  /** A resolved config with no personas (the loader would reject it; the plan takes it as data). */
  const empty = (): PersonaConfig => ({ ...defaultOnly(), personas: [] })

  test.each<[string, boolean, () => PersonaConfig, () => PersonaConfig]>([
    ['nothing changed', false, applied, applied],
    [
      'an explicit <home>/.claude in place of none',
      false,
      defaultOnly,
      () => parse(bare([alpha({ claude_config_dir: join(home, '.claude') })])),
    ],
    ['~/.claude in place of none', false, defaultOnly, () => parse(bare([alpha({ claude_config_dir: '~/.claude' })]))],
    ['a top-level ~/.claude in place of none', false, defaultOnly, () => parse(bare([alpha()], '~/.claude'))],
    [
      'a changed own dir',
      true,
      applied,
      () => edited((c) => (entry(c, 'bravo').claude_config_dir = join(root, 'bravo-claude-2'))),
    ],
    [
      'a changed inherited default',
      true,
      applied,
      () => edited((c) => (c.claude_config_dir = join(root, 'claude-default-2'))),
    ],
    ['an added persona on the default', false, defaultOnly, () => parse(bare([alpha(), delta()]))],
    ['an added persona inheriting a dir already in use', false, applied, () => edited((c) => c.personas.push(delta()))],
    [
      'an added persona on a new dir',
      true,
      applied,
      () => edited((c) => c.personas.push(delta({ claude_config_dir: join(root, 'delta-claude') }))),
    ],
    [
      'a removed persona that was the only user of its dir',
      true,
      applied,
      () => edited((c) => c.personas.splice(1, 1)),
    ],
    ['a removed persona whose dir another still uses', false, applied, () => edited((c) => c.personas.splice(0, 1))],
    ['an empty persona set in place of default-only', false, defaultOnly, empty],
    ['default-only in place of an empty persona set', false, empty, defaultOnly],
    [
      'a non-default dir in place of an empty persona set',
      true,
      empty,
      () => parse(bare([alpha()], join(root, 'claude-x'))),
    ],
  ])('%s: configDirsChanged is %p', (_label, expected, before, after) => {
    const plan = buildChangePlan(before(), valid(after()), facts())
    if (!plan.valid) throw new Error('expected a valid plan')

    expect(plan.configDirsChanged).toBe(expected)
    render(plan)
  })

  test('an own claude_config_dir via a symlink to the same dir reads no effective change, yet changes the dirs', () => {
    aliases.set(join(root, 'link-claude'), join(root, 'bravo-claude'))
    const { plan, lines } = preview(edited((c) => (entry(c, 'bravo').claude_config_dir = join(root, 'link-claude'))))

    // The preview compares by real path; the template is written from the lexical path.
    expect(plan).toEqual(
      planWith({
        unchanged: [ref('alpha', 0), ref('bravo', 1), ref('charlie', 2)],
        noEffectiveChange: true,
        configDirsChanged: true,
      }),
    )
    expect(lines).toEqual([NO_EFFECT_LINE])
  })

  test('the default dir is resolved under the injected home, not the OS home', () => {
    const before = defaultOnly()
    const after = parse(bare([alpha({ claude_config_dir: join(home, '.claude') })]))

    expect(buildChangePlan(before, valid(after), facts()).configDirsChanged).toBe(false)
    expect(buildChangePlan(before, valid(after), facts({ home: join(root, 'other-home') })).configDirsChanged).toBe(true)
  })

  test.each<[string, ChangePlanCandidate]>([
    ['an invalid config', { kind: 'invalid', error: 'e' }],
    ['a missing config file', { kind: 'unreadable', path: '/nowhere/config.json', missing: true, code: 'ENOENT' }],
  ])('%s never changes the dirs: nothing will be applied', (_label, candidate) => {
    // The applied set is non-default, so comparing it against no personas would read as a change.
    const plan = buildChangePlan(applied(), candidate, facts())

    expect(plan.valid).toBe(false)
    expect(plan.configDirsChanged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Facts that could not be gathered (FACT_UNKNOWN)
// ---------------------------------------------------------------------------

describe('facts that could not be gathered', () => {
  test('an added persona whose checks could not run says so, claiming neither answer', () => {
    const { plan, lines } = preview(
      edited((c) => c.personas.push(persona('delta', 'C0D0001'))),
      facts({ addedCannotComeUp: new Map([['delta', FACT_UNKNOWN]]) }),
    )

    expect(plan.added.map((p) => p.key)).toEqual(['delta'])
    expect(plan.added[0]!.cannotComeUp).toBeUndefined()
    expect(lines).toEqual([
      header({ added: 1 }),
      'persona "delta" (key=delta) is added; whether it can come up could not be checked.',
    ])
  })

  test('a credentials change whose bring-up state could not be queried says so, claiming neither answer', () => {
    const { plan, lines } = preview(applied(), { ...bravoRotated(), bringUpState: () => FACT_UNKNOWN })

    expect(plan.credentials.map((p) => [p.key, p.path])).toEqual([['bravo', credentialsOf('bravo')]])
    expect(plan.credentials[0]!.credentialsBroken).toBeUndefined()
    expect(lines).toEqual([
      header({ credentials: 1 }),
      `persona "bravo" (key=bravo): credentials file ${JSON.stringify(credentialsOf('bravo'))} changed; ` +
        'whether it is broken by its credentials now could not be checked.',
    ])
  })

  test('unknown facts leave every header count as it is', () => {
    const f: ChangePlanFacts = {
      ...bravoRotated(),
      bringUpState: () => FACT_UNKNOWN,
      addedCannotComeUp: new Map([['delta', FACT_UNKNOWN]]),
    }
    const { plan, lines } = preview(
      edited((c) => {
        c.personas.push(persona('delta', 'C0D0001'))
        entry(c, 'bravo').channels![1]!.delivery = 'all'
      }),
      f,
    )

    expect(changePlanCounts(plan)).toEqual(counts({ added: 1, inPlace: 1, credentials: 1 }))
    expect(lines).toEqual([
      header({ added: 1, inPlace: 1, credentials: 1 }),
      'persona "delta" (key=delta) is added; whether it can come up could not be checked.',
      'persona "bravo" (key=bravo): delivery changed: applied in place immediately, instance kept; ' +
        `credentials file ${JSON.stringify(credentialsOf('bravo'))} changed; ` +
        'whether it is broken by its credentials now could not be checked.',
    ])
  })
})

// ---------------------------------------------------------------------------
// Invalid candidates
// ---------------------------------------------------------------------------

describe('invalid candidates', () => {
  /** The loader's error for `text`. */
  function loaderError(text: string): string {
    try {
      parse(undefined, text)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected the loader to reject the fixture')
  }

  const tokenKeyed = (): string => {
    const input = baseInput() as EditableInput
    input[fakeToken(BOT_TOKEN_PREFIX)] = 'pasted'
    return JSON.stringify(input)
  }

  test.each<[string, () => ChangePlanCandidate, () => string]>([
    [
      'a malformed config (a pasted token in it)',
      () => ({ kind: 'invalid', error: loaderError(`{"personas": [${JSON.stringify(fakeToken(BOT_TOKEN_PREFIX))}`) }),
      () => loaderError(`{"personas": [${JSON.stringify(fakeToken(BOT_TOKEN_PREFIX))}`),
    ],
    [
      'an unknown key named with a token',
      () => ({ kind: 'invalid', error: loaderError(tokenKeyed()) }),
      () => loaderError(tokenKeyed()),
    ],
    [
      'a missing config file',
      () => ({ kind: 'unreadable', path: configPath, missing: true, code: 'ENOENT' }),
      () => `the configuration file ${JSON.stringify(configPath)} does not exist.`,
    ],
    [
      'an unreadable config file',
      () => ({ kind: 'unreadable', path: configPath, missing: false, code: 'EACCES' }),
      () => `the configuration file ${JSON.stringify(configPath)} cannot be read (EACCES).`,
    ],
    [
      'an unreadable config file with no errno code',
      () => ({ kind: 'unreadable', path: configPath, missing: false, code: undefined }),
      () => `the configuration file ${JSON.stringify(configPath)} cannot be read.`,
    ],
  ])('%s reads INVALID with the error and nothing will be applied, with no counts or persona lines', (_label, candidate, error) => {
    const plan = buildChangePlan(applied(), candidate(), facts()) as InvalidChangePlan
    const lines = render(plan)

    expect(plan.valid).toBe(false)
    expect(plan.error).toBe(error())
    expect(lines).toEqual([`INVALID: ${error()} Nothing will be applied.`])
    expect(lines[0]).not.toContain('personas:')
    expect(renderPreview(plan)).toBe(lines[0]!)
    expect(renderInvalidLogLine(plan, PENDING_FILE)).toBe(
      `[slack] reload-invalid: the pending configuration is invalid and nothing will be applied: ${error()} ` +
        `(preview in ${JSON.stringify(PENDING_FILE)})`,
    )
    expect(renderInvalidLogLine(plan)).toBe(
      `[slack] reload-invalid: the pending configuration is invalid and nothing will be applied: ${error()}`,
    )
  })

  test('the loader errors carry the parse position and do not echo a token-named key', () => {
    expect(loaderError(`{"personas": [${JSON.stringify(fakeToken(BOT_TOKEN_PREFIX))}`)).toMatch(/line 1, column \d+/)
    expect(loaderError(tokenKeyed())).toContain('whose name is not shown')
  })

  test('a multi-line error renders as one line in the preview and in the reload-invalid line', () => {
    const plan = buildChangePlan(applied(), { kind: 'invalid', error: 'first\nsecond' }, facts()) as InvalidChangePlan

    expect(render(plan)).toEqual(['INVALID: first\\nsecond Nothing will be applied.'])
    expect(renderInvalidLogLine(plan, PENDING_FILE)).not.toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// Combined edit, ordering and the header
// ---------------------------------------------------------------------------

describe('a combined edit', () => {
  /**
   * Applied: alpha, bravo, charlie, foxtrot, golf. Candidate: zulu (added),
   * golf (credentials), charlie (destructive), bravo (in place), yankee
   * (added), alpha unchanged, port changed; foxtrot removed. Candidate order
   * differs from alphabetical order in every class.
   */
  function combined(): { plan: ValidChangePlan; lines: string[] } {
    const appliedInput = baseInput()
    appliedInput.personas.push(persona('foxtrot', 'C0F0001'), persona('golf', 'C0G0001'))
    const [alpha, bravo, charlie, , golf] = structuredClone(appliedInput.personas)
    bravo!.permission_prompts = 'C0B0002'
    charlie!.working_directory = join(root, 'charlie-new-work')
    const candidateInput = {
      ...appliedInput,
      port: 3200,
      personas: [persona('zulu', 'C0Z0001'), golf!, charlie!, bravo!, persona('yankee', 'C0Y0001'), alpha!],
    }
    const plan = buildChangePlan(
      parse(appliedInput),
      valid(parse(candidateInput)),
      credentialsFacts({ held: { golf: DIGEST_OLD }, current: { [credentialsOf('golf')]: DIGEST_NEW } }),
    )
    if (!plan.valid) throw new Error('expected a valid plan')
    return { plan, lines: render(plan) }
  }

  test('every header count matches the lines below it', () => {
    const { plan, lines } = combined()

    expect(changePlanCounts(plan)).toEqual({ added: 2, removed: 1, destructive: 1, inPlace: 1, credentials: 1, settings: 1 })
    expect(renderChangePlanCounts(changePlanCounts(plan))).toBe(
      'personas: 2 added, 1 removed, 1 destructively modified, 1 modified in place, 1 with changed credentials; ' +
        'server-wide settings: 1 changed',
    )
    expect(lines[0]).toBe(header(changePlanCounts(plan)))
    expect(lines.filter((l) => l.includes(' is added'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes(' is removed:'))).toHaveLength(1)
    expect(destructiveLines(lines)).toHaveLength(2)
    expect(lines.filter((l) => l.includes('applied in place immediately'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('a new connection opens'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('server-wide setting '))).toHaveLength(1)
  })

  test('lines come in the fixed order: removals, destructive modifies, additions, other personas by candidate order, settings', () => {
    const { plan, lines } = combined()

    expect(plan.unchanged).toEqual([ref('alpha', 5)])
    expect(lines.map((l) => /\(key=(\w+)\)/.exec(l)?.[1] ?? l.split(':')[0])).toEqual([
      'A configuration change is pending; nothing has been applied. personas',
      'foxtrot',
      'charlie',
      'zulu',
      'yankee',
      'golf',
      'bravo',
      'server-wide setting port changed',
    ])
    expect(lines.filter((l) => l.includes('(key=alpha)'))).toEqual([])
  })

  test('the log form classes every line reload-preview and suffixes only the header with the pending file', () => {
    const { plan, lines } = combined()

    expect(renderPreviewLogLines(plan, PENDING_FILE)).toEqual(
      lines.map(
        (l, i) => `[slack] reload-preview: ${l}${i === 0 ? ` (preview in ${JSON.stringify(PENDING_FILE)})` : ''}`,
      ),
    )
    expect(renderPreviewLogLines(plan)).toEqual(lines.map((l) => `[slack] reload-preview: ${l}`))
  })

  test('the no-effect preview has one reload-preview log line', () => {
    const { plan } = preview(applied())

    expect(renderPreviewLogLines(plan, PENDING_FILE)).toEqual([
      `[slack] reload-preview: ${NO_EFFECT_LINE} (preview in ${JSON.stringify(PENDING_FILE)})`,
    ])
  })

  test('the same inputs give the same plan and byte-identical text; the text is the lines joined', () => {
    const first = combined()
    const second = combined()

    expect(second.plan).toEqual(first.plan)
    expect(renderPreview(second.plan)).toBe(renderPreview(first.plan))
    expect(renderPreview(first.plan)).toBe(first.lines.join('\n'))
  })

  test('building and rendering is pure: no log, no file written, inputs untouched', () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => spyOn(console, m))
    const before = readdirSync(root, { recursive: true })
    const appliedConfig = applied()
    const snapshot = structuredClone(appliedConfig)
    try {
      const plan = buildChangePlan(appliedConfig, valid(edited((c) => c.personas.splice(0, 1))), facts())
      if (!plan.valid) throw new Error('expected a valid plan')
      render(plan)
      renderInvalidLogLine(buildChangePlan(appliedConfig, { kind: 'invalid', error: 'e' }, facts()) as InvalidChangePlan)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(readdirSync(root, { recursive: true })).toEqual(before)
    expect(appliedConfig).toEqual(snapshot)
  })
})
