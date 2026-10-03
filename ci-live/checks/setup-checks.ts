/**
 * setup-checks.ts — testplans/b.yko Part 1 in the container: the pre-flight,
 * the install from the README (1.4), the persona setup (1.5, written by the
 * runner as the wizard's answers would be), and Checks S1–S3. After the
 * install, the image's client-under-test check (`RC_CLIENT_CHECK`) swaps
 * agent-director's release-candidate client into the installed package and
 * checks it, before the package checksums Check S2 compares against.
 *
 * These need no workspace, so a dry run runs them for real (with placeholder
 * IDs in config.json).
 */

import { SYSTEM_PROMPT_PATH, buildLiveConfig, renderConfig, systemPromptFromTemplate } from '../lib/live-config.ts'
import { CONTAINER_HOME, CONTAINER_TARBALL } from '../lib/docker.ts'
import { RC_CLIENT_CHECK, RC_CLIENT_CHECK_PASSED } from '../lib/rc-client.ts'
import type { CheckContext } from './context.ts'
import { Findings, pass, type CheckDef } from './framework.ts'
import { guarded, lines, run, S } from './helpers.ts'

const PREFLIGHT_OK = (phase: string) => `pre-flight passed (${phase})`

/**
 * How the install check's reason starts when the client-under-test check
 * fails; the check's own `ERROR:` line follows it.
 */
export const RC_CLIENT_CHECK_FAILED = 'the release-candidate client check on the installed package failed'

/** The client-under-test check's bound: a copy, a tarball unpack and three bun runs. */
const RC_CLIENT_CHECK_TIMEOUT_MS = 120_000

export const preflightCheck: CheckDef<CheckContext> = {
  id: 'preflight',
  title: 'Pre-flight (setup phase), in the container',
  needs: [],
  row: null,
  blocking: true,
  prerequisite: true,
  async run(ctx) {
    const f = new Findings()
    const r = await run(ctx, 'bash ~/cscb-live-preflight.sh setup')
    f.add(r.out.trim() || r.err.trim().split('\n')[0] || `exit ${r.code}`)
    f.expect(r.code === 0 && r.out.includes(PREFLIGHT_OK('setup')), `pre-flight failed: ${r.err.trim().split('\n')[0] ?? ''}`)
    return f.result()
  },
}

export const installCheck: CheckDef<CheckContext> = {
  id: 'install',
  title: 'Part 1.4: install from the README (the tarball, as a customer)',
  needs: [],
  row: null,
  blocking: true,
  prerequisite: true,
  async run(ctx) {
    const f = new Findings()
    const envCount = (await lines(ctx, "env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'"))[0]
    f.expect(envCount === '0', `token variables in the shell: ${envCount}`)
    const g = await run(ctx, "guard && echo 'test host'")
    f.expect(g.out.includes('test host'), 'guard refused the container shell')

    // Step 2: the published-prerelease path, with the tarball under test.
    const install = await guarded(
      ctx,
      `bun install -g --ignore-scripts ${CONTAINER_TARBALL} > ~/cscb-live/install.log 2>&1 && bun pm -g trust claude-slack-channel-bots >> ~/cscb-live/install.log 2>&1`,
      600_000,
    )
    if (!f.expect(install.ok && install.code === 0, `the install failed (exit ${install.code}; see ~/cscb-live/install.log in the container)`)) {
      return f.result()
    }
    const pkg = await lines(ctx, 'echo "PKG=$PKG"; readlink -f "$PKG"; jq -r .version "$PKG/package.json"')
    f.add(pkg.join(' | '))
    ctx.shared.packageVersion = pkg[2]
    const layout = await run(ctx, '[ -f "$PKG/README.md" ] && [ -f "$PKG/slack-app-manifest.yml" ] && [ -d "$PKG/skills" ]')
    f.expect(layout.code === 0, 'PKG does not hold README.md, slack-app-manifest.yml and skills/')

    // The client under test: the release candidate's client swapped into
    // the package's resolved agent-director and checked, before the checksums
    // S2 compares against.
    const rc = await guarded(ctx, `${RC_CLIENT_CHECK} --package "$PKG"`, RC_CLIENT_CHECK_TIMEOUT_MS)
    const passed = rc.out.split('\n').find((l) => l.startsWith(RC_CLIENT_CHECK_PASSED))
    if (passed !== undefined) f.add(passed)
    const rcError = rc.err.split('\n').find((l) => l.startsWith('ERROR:')) ?? (rc.ok ? `exit ${rc.code}` : 'the guard refused the container shell')
    if (!f.expect(rc.ok && rc.code === 0 && passed !== undefined, `${RC_CLIENT_CHECK_FAILED}: ${rcError}`)) {
      return f.result()
    }

    // Step 3: what postinstall wrote, and the package checksums for S2.
    const state = await lines(ctx, 'ls -A "$S"')
    f.add(`ls -A $S: ${state.join(' ')}`)
    f.expect(state.length === 1 && state[0] === 'config.json', `the state dir holds ${state.join(', ') || 'nothing'}, not only config.json`)
    const cfg = (await lines(ctx, 'jq -c . "$S/config.json"'))[0]
    f.expect(cfg === '{"personas":[]}', 'config.json is not the postinstall skeleton {"personas":[]}')
    const sums = await lines(
      ctx,
      'mkdir -p ~/cscb-live && ( cd "$PKG" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum ) > ~/cscb-live/pkg-before.sha256 && wc -l < ~/cscb-live/pkg-before.sha256',
    )
    f.add(`package files checksummed: ${sums[0] ?? '?'}`)
    f.expect(Number(sums[0]) > 0, 'the package checksum file is empty')

    // Step 4: link the setup skill.
    const link = await run(ctx, 'ln -s "$PKG/skills/setup-slack-channel-bots" ~/.claude/skills/setup-slack-channel-bots && ls ~/.claude/skills/setup-slack-channel-bots/SKILL.md')
    f.expect(link.code === 0, 'the setup skill link or its SKILL.md is missing')
    return f.result()
  },
}

export const setupCheck: CheckDef<CheckContext> = {
  id: 'setup',
  title: 'Part 1.5: A, B and C declared (config.json and system prompt written by the runner as the wizard answers)',
  needs: [],
  row: null,
  blocking: true,
  prerequisite: true,
  async run(ctx) {
    const f = new Findings()
    f.note('Part 1.5 was done by the runner (config.json and system-prompt.md written as the wizard answers), not by the wizard; S1 is manual only')
    if (ctx.human) {
      const cDm = await ctx.human.existingDm(ctx.ids.bots.c.userId)
      ctx.shared.cDmBeforeRun = cDm !== null
      f.note(`C DM before the run: ${cDm !== null ? 'yes' : 'no'}`)
    }
    const mk = await run(ctx, 'mkdir -p ~/cscb-live/a ~/cscb-live/b ~/cscb-live/c ~/cscb-live/wizard')
    f.expect(mk.code === 0, 'could not create the working directories')

    const template = await ctx.container.sh('cat "$PKG/skills/EXAMPLE_CLAUDE.md"')
    if (!f.expect(template.code === 0 && template.stdout.includes('# Role'), 'the package has no skills/EXAMPLE_CLAUDE.md template')) return f.result()
    const guard = await run(ctx, 'guard')
    if (!f.expect(guard.code === 0, 'guard refused')) return f.result()
    await ctx.container.writeFile(SYSTEM_PROMPT_PATH, systemPromptFromTemplate(template.stdout))
    await ctx.container.writeFile(`${S}/config.json`, renderConfig(buildLiveConfig(ctx.ids)))

    const id = ctx.ids
    const personas = await lines(ctx, `jq -c '.personas[] | {name, channels, dm, permission_prompts}' "$S/config.json"`)
    const want = [
      `{"name":"persona_a","channels":[{"id":"${id.aHome}","delivery":"all"},{"id":"${id.coordination}","delivery":"mentions"}],"dm":null,"permission_prompts":"${id.aHome}"}`,
      `{"name":"persona_b","channels":[{"id":"${id.coordination}","delivery":"mentions"}],"dm":{"enabled":true,"contact":"${id.humanUserId}"},"permission_prompts":"dm"}`,
      `{"name":"persona_c","channels":null,"dm":{"enabled":true,"contact":"${id.humanUserId}"},"permission_prompts":"dm"}`,
    ]
    f.expect(JSON.stringify(personas) === JSON.stringify(want), 'config.json personas are not the Part 1.5 layout')
    const paths = await lines(ctx, `jq -r '.personas[] | [.name, .credentials_file, .working_directory] | @tsv' "$S/config.json"`)
    f.expect(paths.length === 3, 'config.json does not name three credentials files and working directories')
    const extra = (await lines(ctx, `jq -c '[.personas[] | keys - ["name","credentials_file","working_directory","channels","dm","permission_prompts"]]' "$S/config.json"`))[0]
    f.expect(extra === '[[],[],[]]', 'a persona has a key beyond the Part 1.5 set')
    const top = (await lines(ctx, `jq -c '{ack_reaction, session_restart_delay, append_system_prompt_file}' "$S/config.json"`))[0]
    f.expect(top === `{"ack_reaction":"eyes","session_restart_delay":null,"append_system_prompt_file":"${SYSTEM_PROMPT_PATH}"}`, 'the server-wide settings are not the Part 1.5 ones')
    const creds = await lines(ctx, 'ls -lL ~/.config/cscb/')
    for (const l of ['a', 'b', 'c']) {
      const line = creds.find((x) => x.endsWith(`persona_${l}-credentials.json`)) ?? ''
      f.expect(line.startsWith('-rw-------'), `persona_${l}-credentials.json is missing or not -rw-------`)
    }
    f.add(`config.json written for persona_a, persona_b, persona_c (A-home ${id.aHome}, coordination ${id.coordination})`)
    return f.result()
  },
}

export const s1Check: CheckDef<CheckContext> = {
  id: 'S1',
  title: 'Check S1: the credentials command in a real terminal',
  needs: [],
  row: 'S1',
  skip: 'manual only: the wizard chat',
  run: async () => pass([]),
}

export const s2Check: CheckDef<CheckContext> = {
  id: 'S2',
  title: 'Check S2: the setup is only config.json and the credentials files (AC 14)',
  needs: [],
  row: 'S2',
  async run(ctx) {
    const f = new Findings()
    const state = (await lines(ctx, 'ls -A "$S"')).sort()
    f.add(`ls -A $S: ${state.join(' ')}`)
    f.expect(JSON.stringify(state) === JSON.stringify(['config.json', 'system-prompt.md']), 'the state dir holds more than config.json and system-prompt.md')
    const unchanged = await run(ctx, `( cd "$PKG" && sha256sum -c --quiet ~/cscb-live/pkg-before.sha256 ) && echo 'package unchanged'`)
    f.expect(unchanged.out.includes('package unchanged'), 'a file of the installed package changed')
    const counts = await lines(ctx, '( cd "$PKG" && find . -path ./.git -prune -o -type f -print | wc -l ); wc -l < ~/cscb-live/pkg-before.sha256')
    f.add(`package files now/before: ${counts.join('/')}`)
    f.expect(counts.length === 2 && counts[0] === counts[1], 'the package gained or lost files')
    const creds = (await lines(ctx, 'ls -A ~/.config/cscb/')).sort()
    f.expect(
      JSON.stringify(creds) === JSON.stringify(['persona_a-credentials.json', 'persona_b-credentials.json', 'persona_c-credentials.json']),
      `~/.config/cscb/ holds ${creds.join(', ')}`,
    )
    const tok = (await lines(ctx, 'tokcount "$S/config.json"'))[0]
    f.expect(tok === '0', `token-shaped lines in config.json: ${tok}`)
    const env = (await lines(ctx, "env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'"))[0]
    f.expect(env === '0', `token variables set: ${env}`)
    return f.result()
  },
}

const S3_ERROR_PARTS = [
  '[slack] Fatal: configuration error — loadPersonaConfig: invalid persona config in',
  `personas[1] "persona_b" (key=persona_b): working_directory "${CONTAINER_HOME}/cscb-live/a" is also the working_directory of personas[0] "persona_a" (key=persona_a). Each persona needs its own working_directory.`,
]

export const s3Check: CheckDef<CheckContext> = {
  id: 'S3',
  title: "Check S3: an invalid configuration doesn't start (AC 71, invalid half)",
  needs: [],
  row: 'S3',
  async run(ctx) {
    const f = new Findings()
    const pre = await run(ctx, 'bash ~/cscb-live-preflight.sh check1')
    if (!f.expect(pre.out.includes('pre-flight passed (check1)'), `pre-flight check1 failed: ${pre.err.trim().split('\n')[0] ?? ''}`)) return f.result()
    const r = await run(
      ctx,
      [
        'SCR=$(mktemp -d ~/cscb-live/scratch-state.XXXXXX); echo "SCR=$SCR"',
        `jq '(.personas[] | select(.name == "persona_b") | .working_directory) = (.personas[] | select(.name == "persona_a") | .working_directory)' "$S/config.json" > "$SCR/config.json"`,
        'echo "WDS=$(jq -r \'.personas[].working_directory\' "$SCR/config.json" | tr "\\n" " ")"',
        'if guard; then SLACK_STATE_DIR="$SCR" claude-slack-channel-bots start > "$SCR.out" 2>&1; echo "exit=$?"; fi',
        'echo "SCRLS=$(ls -A "$SCR" | tr "\\n" " ")"',
        'echo "PGREP=$(pgrep -af \'cli\\.ts start\' | wc -l)"',
        "echo \"ROWS=$(agent-director list --label service=cscb | jq '(.spawns // []) | length')\"",
        'echo "STATELS=$(ls -A "$S" | sort | tr "\\n" " ")"',
        'cat "$SCR.out" | showsafe',
        'if guard && { [ -e "$SCR/server.pid" ] || [ -n "$(pgrep -f \'cli\\.ts start\')" ]; }; then echo "SCRATCH SERVER STARTED - stopping it"; SLACK_STATE_DIR="$SCR" claude-slack-channel-bots stop --stop-bots > /dev/null 2>&1; fi',
        'rm -rf "$SCR" "$SCR.out"',
      ].join('\n'),
      300_000,
    )
    const out = r.out
    const field = (name: string) => (new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1] ?? '').trim()
    f.add(`exit=${field('exit')}; scratch: ${field('SCRLS') || '(empty)'}; rows: ${field('ROWS')}`)
    f.expect(field('WDS') === '~/cscb-live/a ~/cscb-live/a ~/cscb-live/c', "the scratch config does not give B A's working directory")
    f.expect(field('exit') === '1', `start exited ${field('exit') || '(not run)'}, not 1`)
    f.expect(out.includes('[slack] Server failed to start (exit code 1). From ') && out.includes('/server.log:'), 'start did not print "Server failed to start (exit code 1). From <SCR>/server.log:"')
    for (const part of S3_ERROR_PARTS) f.expect(out.includes(part), `the error does not contain: ${part.slice(0, 80)}…`)
    f.expect(!/config\.json\.last-applied|server\.pid/.test(field('SCRLS')), 'the scratch dir holds a record or a server.pid')
    f.expect(field('PGREP') === '0', 'a server process remains')
    f.expect(field('ROWS') === '0', 'agent-director lists a service=cscb row')
    f.expect(field('STATELS') === 'config.json system-prompt.md', `the state dir changed: ${field('STATELS')}`)
    f.expect(!out.includes('SCRATCH SERVER STARTED'), 'SCRATCH SERVER STARTED')
    return f.result()
  },
}

