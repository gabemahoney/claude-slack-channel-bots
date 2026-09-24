/**
 * route-persona-adapter.ts — TRANSITIONAL route→persona adapter (b.av2 E3).
 *
 * Until the persona loader switch (E3 Task 9), the server still loads the
 * route config. This adapter turns each route into a stand-in persona so the
 * consumers already moved onto persona keys can run against it. Each stand-in
 * is keyed by its channel ID verbatim, so `cscb_<key>`, `slack_bot_<key>`, the
 * restart and outage keys and `CLAUDE_MANAGED_CHANNEL` stay byte-identical for
 * the modules not yet converted.
 *
 * A channel ID is not in the persona key form, so the key is set directly:
 * this module never derives a key from a name and never runs the persona
 * loader's validation or real-path rules on the stand-ins.
 *
 * Deleted in E3 Task 9, together with the route loader.
 *
 * Pure module: no I/O and no import-time side effects.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  DEFAULT_REPLY_CHUNK_LIMIT,
  DEFAULT_REPLY_CHUNK_MODE,
  type Persona,
  type PersonaConfig,
  type RoutingConfig,
} from './config.ts'

/**
 * Placeholder `credentials_file` for a stand-in persona. It names no real
 * file: nothing reads a persona's credentials file before E3 Task 9.
 */
export const STAND_IN_CREDENTIALS_FILE = '/dev/null/cscb-route-stand-in-has-no-credentials-file'

/**
 * Map a route config to a persona config: one stand-in persona per route, in
 * route order. Each stand-in has name and key equal to the channel ID, the
 * route's `cwd` as its working directory, one `delivery: all` channel (that
 * channel), prompts to that channel, and DMs off. `claude_config_dir` and
 * `stop_hook_bootstrap` are the route's value, else the top-level value;
 * `claude_config_dir` is omitted when neither is set. Server-wide settings are
 * copied; the persona-only settings take their defaults and no acknowledgement
 * reaction. `default_route` and `default_dm_session` are not represented.
 */
export function routesToPersonaConfig(config: RoutingConfig): PersonaConfig {
  const { routes, default_route: _defaultRoute, default_dm_session: _defaultDm, ...settings } = config
  const personas: Persona[] = Object.entries(routes).map(([channelId, route], index) => {
    const claudeConfigDir = route.claude_config_dir ?? config.claude_config_dir
    return {
      index,
      name: channelId,
      key: channelId,
      credentials_file: STAND_IN_CREDENTIALS_FILE,
      working_directory: route.cwd,
      channels: [{ id: channelId, delivery: 'all' }],
      dm: { enabled: false },
      permission_prompts: channelId,
      ...(claudeConfigDir !== undefined ? { claude_config_dir: claudeConfigDir } : {}),
      stop_hook_bootstrap: route.stop_hook_bootstrap ?? config.stop_hook_bootstrap,
    }
  })
  return {
    ...settings,
    personas,
    reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT,
    reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE,
  }
}
