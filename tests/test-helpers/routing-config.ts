/**
 * test-helpers/routing-config.ts — Shared RoutingConfig factory for tests
 *
 * SPDX-License-Identifier: MIT
 */

import { type RoutingConfig } from '../../src/config.ts'

export function makeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  return {
    routes: {
      'C_TEST1': { cwd: '/tmp/test-cwd' },
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: '/tmp/test-mcp.json',
    ...overrides,
  }
}
