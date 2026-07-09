import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertCompatibleOpenShellVersion,
  assertOpenShellCliCommandConformant,
  assertOpenShellPolicyConformant,
  assertOpenShellProviderProfileConformant,
  OPEN_SHELL_MAPPING_VERSION,
  OPEN_SHELL_SCHEMA_SNAPSHOT,
  OPEN_SHELL_SCHEMA_SNAPSHOT_ID,
} from './index.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const snapshotRoot = join(packageRoot, 'snapshots', '2026-07-05');

describe('OpenShell schema snapshot', () => {
  it('pins metadata and checksums for every snapshot artifact', () => {
    expect(OPEN_SHELL_SCHEMA_SNAPSHOT_ID).toBe('openshell-0.0.63-2026-07-05');
    expect(OPEN_SHELL_MAPPING_VERSION).toBe('openshell-v1');

    for (const [fileName, checksum] of Object.entries(OPEN_SHELL_SCHEMA_SNAPSHOT.checksums)) {
      expect(sha256File(join(snapshotRoot, fileName))).toBe(checksum);
    }
  });

  it('accepts only the pinned OpenShell CLI compatibility range', () => {
    expect(() => assertCompatibleOpenShellVersion('0.0.63')).not.toThrow();
    expect(() => assertCompatibleOpenShellVersion('0.0.62')).toThrow('outside the pinned range');
    expect(() => assertCompatibleOpenShellVersion('0.1.0')).toThrow('outside the pinned range');
  });

  it('validates generated provider profiles against reserved namespaces', () => {
    expect(() =>
      assertOpenShellProviderProfileConformant({
        category: 'mcp',
        credentials: {
          token: {
            authStyle: 'bearer',
            envVar: 'GITHUB_TOKEN',
          },
        },
        displayName: 'GitHub MCP',
        endpoints: {
          api: { host: 'api.github.com' },
        },
        id: 'okp-local-github-mcp-v1',
        refresh: {
          materialKeys: ['refresh_token'],
          strategy: 'oauth2_refresh_token',
        },
      })
    ).not.toThrow();
    expect(() =>
      assertOpenShellProviderProfileConformant({
        category: 'mcp',
        credentials: {
          token: {
            envVar: 'v1_GITHUB_TOKEN',
          },
        },
        displayName: 'GitHub MCP',
        endpoints: {},
        id: 'okp-local-github-mcp-v1',
      })
    ).toThrow('reserved prefix');
    expect(() =>
      assertOpenShellProviderProfileConformant({
        category: 'mcp',
        credentials: {},
        displayName: 'Built-in GitHub',
        endpoints: {},
        id: 'github',
      })
    ).toThrow('reserved');
  });

  it('validates OpenShell policy YAML enum values and required sections', () => {
    expect(() =>
      assertOpenShellPolicyConformant(`version: 1
filesystem_policy:
  include_workdir: true
landlock:
  compatibility: best_effort
process:
  run_as_user: sandbox
network_policies:
  openkit_worker_control_relay:
    name: openkit_worker_control_relay
    binaries:
      - path: /usr/local/bin/node
    endpoints:
      - host: control.local
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-write
`)
    ).not.toThrow();
    expect(() =>
      assertOpenShellPolicyConformant(`version: 1
filesystem_policy:
landlock:
process:
network_policies:
  bad:
    endpoints:
      - host: example.com
        port: 443
        protocol: grpc
        enforcement: enforce
        access: read-write
`)
    ).toThrow('Unsupported OpenShell policy protocol');
  });

  it('validates NanoCore OpenShell CLI commands against the pinned surface', () => {
    expect(() =>
      assertOpenShellCliCommandConformant(['sandbox', 'create', 'worker', '--provider', 'github'])
    ).not.toThrow();
    expect(() => assertOpenShellCliCommandConformant(['provider', 'refresh', 'logs'])).toThrow(
      'outside the pinned surface'
    );
  });
});

/**
 * Calculates a SHA-256 checksum for one file.
 *
 * @param path File path.
 * @returns Hex digest.
 */
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
