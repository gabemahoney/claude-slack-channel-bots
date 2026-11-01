/**
 * shared-channel-upgrade-case.ts — the manual-upgrade fixtures for the
 * scenario scripts (b.tad SR-8.1, SR-8.2): it materializes a committed case
 * from tests/fixtures/shared-channel-upgrade/ into a scenario's scratch, and
 * writes a 0.18.0 reference for a persona the script describes.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, it prints
 * `FAIL: shared-channel-upgrade-case: refused: /etc/cscb-ci-image is absent …`
 * on stderr and exits 2, before it reads an argument or loads a module. Only
 * `node:` built-ins are imported statically: the materializer
 * (`tests/test-helpers/shared-channel-upgrade.ts`, which at run time loads
 * only `node:` built-ins and `tests/test-helpers/host-safe-env.ts`) is
 * imported dynamically, after the check. Neither needs the repo's src/.
 *
 * USAGE
 * -----
 *   bun --no-install shared-channel-upgrade-case.ts materialize --case <name>
 *       --root <dir> --state-dir <dir> --home <dir>
 *       [--setting <key>=<value>]... [--persona-prefix <prefix>]
 *   bun --no-install shared-channel-upgrade-case.ts reference-0.18.0 --out <dir>
 *       --mode declarative|fungible --name <name> --credentials-file <path>
 *       --working-directory <path> [--channel <id>=all|mentions]...
 *       [--permission-prompts dm|<id>] [--invited-permission-prompts dm|<id>]
 *       [--dm-enabled] [--dm-contact <user-id>] [--setting <key>=<value>]...
 *
 * `materialize` writes one case of manifest.json (its `name`):
 *   --root       the scenario root, absolute: strictly under the OS temp dir, or
 *                $SCENARIO_ROOT itself or a directory under it; never the real home
 *   --state-dir  under --root; receives the case's default baseline
 *                (config.json, config.json.last-applied) and the old files the
 *                manifest leaves in place (channel-delivery.json, queue/<key>.jsonl)
 *   --home       under --root; the home the case's personas live in (it need
 *                not be the server's HOME). Every `"~/` path is filled in with
 *                it, the same way everywhere, in every config under
 *                new-baseline/ (applied baselines included, the interrupted
 *                variant's left-over 0.18.0 one too) and pending-edits/, and
 *                so in the state dir's config.json and config.json.last-applied:
 *                those paths never depend on the server's HOME. A config stays
 *                byte-identical to its applied baseline wherever the case has
 *                them identical, and each pending edit still previews only its
 *                own change. Of the 0.18.0 files, only the home_relative ones
 *                (channel-delivery.json and its copies, config.json.pending)
 *                are filled, as 0.18.0 stored absolute paths there; the other
 *                reference-0.18.0/ files keep `~/` as 0.18.0 wrote them. The
 *                `credentials` and `workdir` lines and the created working
 *                directories are the paths the filled configs name.
 *   --setting    (repeatable) a current top-level setting, set the same way in
 *                every config under new-baseline/ and pending-edits/ (the
 *                interrupted variant's left-over 0.18.0 applied baseline
 *                included) and in the state dir's config.json and
 *                config.json.last-applied: an
 *                existing key keeps its place, a new one goes last, so a
 *                config and its applied baseline stay byte-identical wherever
 *                the case has them identical, and putting a pending edit back
 *                previews only that edit. reference-0.18.0/ files and the
 *                state dir's old files are untouched. The value is true,
 *                false, an integer, or else a string; a later key replaces an
 *                earlier one. Refused (exit 1): personas, channel_mode,
 *                test_timer_overrides, the removed allow_invited_channels,
 *                invited and claude_director_poll_interval_ms, a key the
 *                current loader does not have, and a key the case's own
 *                configs set (stop_timeout in declarative-choices-and-queues).
 *                For a scenario: --setting bind=127.0.0.1
 *                --setting port=$SCENARIO_PORT --setting health_check_interval=0
 *                --setting session_restart_delay=0 --setting exit_timeout=5
 *                --setting mcp_config_path=<abs path>
 *   --persona-prefix  a-z, 0-9 and _ only (for example "${SCENARIO_TAG}_d_"):
 *                put before every persona name the case uses, as a whole
 *                word, in every file it writes (configs, applied baselines,
 *                pending edits, 0.18.0 references, stored-choice keys and
 *                declarations, the 0.18.0 preview, whose fingerprint line is
 *                recomputed by 0.18.0's rule) and in every persona-named path
 *                (queue/<name>.jsonl, ~/personas/<name>/…). Each prefixed name
 *                must stay its own key (at most 40 characters; the longest
 *                name, charlie, leaves room for a 33-character prefix). manifest.json
 *                keeps the plain names; the `persona` lines map them.
 * Every file also goes under <root>/upgrade-<case>/: reference-0.18.0/,
 * new-baseline/<variant>/ and pending-edits/<edit>/config.json. The
 * manifest's dates and modes are applied, the personas' working directories
 * are created, and no credentials file is written (the script writes each
 * `credentials` path with a fake token). An existing file is refused, and
 * then nothing is written. Output:
 *
 *   case <name>
 *   state_dir <dir>
 *   case_root <dir>
 *   reference_dir <dir>
 *   baselines_dir <dir>
 *   pending_dir <dir>
 *   default_baseline <variant>
 *   chosen_baseline <variant>
 *   persona <manifest-name> <name>          (one per persona; <name> is also its key)
 *   credentials <persona-key> <path>        (one per credentials file the case names)
 *   workdir <persona-key> <path>            (one per persona)
 *   files <count written>
 *
 * Persona keys and paths in these lines are the prefixed ones.
 *
 * `reference-0.18.0` writes a 0.18.0 config.json for one persona and its
 * byte-identical config.json.last-applied into --out (absolute, under the OS
 * temp dir or $SCENARIO_ROOT; existing files refused). --mode fungible adds
 * `"allow_invited_channels": true`; declarative leaves it out. Each
 * --channel adds an entry in order; --invited-permission-prompts writes the
 * fungible `invited` section. --setting adds a top-level 0.18.0 key (not
 * personas or allow_invited_channels); its value is true, false, an integer,
 * or else a string. Keys, delivery values and destinations 0.18.0 would not
 * accept are refused. It has no --persona-prefix: every persona name and
 * path it writes comes from the script's own arguments. Output:
 *
 *   config <path>
 *   last_applied <path>
 *
 * Exit status: 0 on success; 1, with one `FAIL: shared-channel-upgrade-case:
 * <why>` line on stderr, when a case, path or value is refused; 2 when
 * refused outside the image; 64 for a usage error.
 *
 * SPDX-License-Identifier: MIT
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: shared-channel-upgrade-case: refused: /etc/cscb-ci-image is absent; this fixture runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The materializer, beside this file's tree. */
const UPGRADE_MODULE = join(import.meta.dir, '..', '..', 'test-helpers', 'shared-channel-upgrade.ts')

const upgrade = await import(UPGRADE_MODULE)
process.exit(upgrade.runUpgradeCaseCommand(process.argv.slice(2)))
