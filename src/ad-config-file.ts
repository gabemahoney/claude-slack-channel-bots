/**
 * ad-config-file.ts — agent-director's config file, `config.toml` under
 * `.agent-director` in a home directory, as a relative path and as the name
 * CSCB's lines give it (b.jg5 SRJ-209, SRJ-901, SRJ-316).
 *
 * The settings reader (`src/ad-settings.ts`) reads the file at
 * {@link AD_SETTINGS_RELATIVE_PATH} under the server's HOME; the CLI's
 * teardown lines (`src/cli-teardown.ts`) and the reader's refused-read line
 * name it {@link AD_CONFIG_FILE_DISPLAY_NAME}.
 *
 * Constants only: no state, no I/O.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'

/** The settings file's path relative to a home directory. */
export const AD_SETTINGS_RELATIVE_PATH = join('.agent-director', 'config.toml')

/**
 * agent-director's config file as CSCB's lines name it,
 * `~/.agent-director/config.toml` (b.jg5 SRJ-901, SRJ-316).
 */
export const AD_CONFIG_FILE_DISPLAY_NAME = join('~', AD_SETTINGS_RELATIVE_PATH)
