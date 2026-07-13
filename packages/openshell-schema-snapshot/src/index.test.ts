import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertOpenShellCliCommandConformant,
  assertOpenShellPolicyConformant,
  assertOpenShellProviderProfileConformant,
  assertRequiredOpenShellVersion,
  OPEN_SHELL_CLI_SURFACE,
  OPEN_SHELL_MAPPING_VERSION,
  OPEN_SHELL_POLICY_SURFACE,
  OPEN_SHELL_PROVIDER_PROFILE_SURFACE,
  OPEN_SHELL_SCHEMA_SNAPSHOT,
  OPEN_SHELL_SCHEMA_SNAPSHOT_ID,
  OPEN_SHELL_UPSTREAM_POLICY_SURFACE,
  OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE,
} from './index.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const snapshotRoot = join(packageRoot, 'snapshots', '2026-07-11');

describe('OpenShell schema snapshot', () => {
  it('pins metadata and checksums for every snapshot artifact', () => {
    expect(OPEN_SHELL_SCHEMA_SNAPSHOT_ID).toBe('openshell-0.0.80-2026-07-11');
    expect(OPEN_SHELL_MAPPING_VERSION).toBe('openshell-v4');

    for (const [fileName, checksum] of Object.entries(OPEN_SHELL_SCHEMA_SNAPSHOT.checksums)) {
      expect(sha256File(join(snapshotRoot, fileName))).toBe(checksum);
    }
  });

  it('accepts only the pinned OpenShell version', () => {
    expect(OPEN_SHELL_CLI_SURFACE.requiredVersion).toBe('0.0.80');
    expect(() => assertRequiredOpenShellVersion('0.0.80')).not.toThrow();
    expect(() => assertRequiredOpenShellVersion('0.0.79')).toThrow('requires exactly 0.0.80');
    expect(() => assertRequiredOpenShellVersion('0.0.81')).toThrow('requires exactly 0.0.80');
    expect(() => assertRequiredOpenShellVersion('0.1.0')).toThrow('requires exactly 0.0.80');
  });

  it('separates the upstream provider and policy surface from the OpenKit mapping', () => {
    expect(OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.categories).toContain('source_control');
    expect(OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.categories).toContain('inference');
    expect(OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.authStyles).toContain('bearer');
    expect(OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.builtInProfileIds).toContain('codex');
    expect(OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.genericProviderType).toBe('generic');
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.categories).toEqual(['inference']);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.requiredFields).toEqual([
      'id',
      'display_name',
      'category',
      'credentials',
      'endpoints',
      'binaries',
      'inference_capable',
    ]);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.credentialFields).toEqual([
      'name',
      'description',
      'env_vars',
      'required',
      'auth_style',
      'header_name',
      'query_param',
    ]);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.credentialPlaceholderPrefix).toBe(
      'openshell:resolve:env:'
    );
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.authStyles).toEqual(['bearer']);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.ruleFields).toEqual(['allow']);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.restAllowRuleFields).toEqual(['method', 'path']);
    expect(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.workerInferenceRules).toEqual([
      {
        allow: {
          method: 'POST',
          path: '/api/worker-inference/v1/chat/completions',
        },
      },
      {
        allow: {
          method: 'POST',
          path: '/api/worker-inference/v1/responses',
        },
      },
    ]);
    expect(OPEN_SHELL_UPSTREAM_POLICY_SURFACE.protocols).toContain('websocket');
    expect(OPEN_SHELL_UPSTREAM_POLICY_SURFACE.accessModes).toContain('full');
    expect(OPEN_SHELL_POLICY_SURFACE.protocols).toEqual(['rest']);
    expect(OPEN_SHELL_POLICY_SURFACE.accessModes).toEqual(['read-only', 'read-write']);
    expect(OPEN_SHELL_POLICY_SURFACE.endpointKeys).toContain('rules');
    expect(OPEN_SHELL_POLICY_SURFACE.restAllowRuleKeys).toEqual(['method', 'path']);
  });

  it('validates the real OpenShell 0.0.80 relay profile shape', () => {
    const relayProfile = {
      binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
      category: 'inference',
      credentials: [
        {
          auth_style: 'bearer',
          description: 'Package-bound scheduler lease token',
          env_vars: ['OPENKIT_WORKER_INFERENCE_TOKEN'],
          header_name: 'Authorization',
          name: 'session_token',
          query_param: '',
          required: true,
        },
      ],
      description: 'Package-bound NanoCore worker inference relay',
      display_name: 'OpenKit Worker Inference',
      endpoints: [
        {
          enforcement: 'enforce',
          host: 'host.openshell.internal',
          port: 54002,
          protocol: 'rest',
          rules: [
            {
              allow: {
                method: 'POST',
                path: '/api/worker-inference/v1/chat/completions',
              },
            },
            {
              allow: {
                method: 'POST',
                path: '/api/worker-inference/v1/responses',
              },
            },
          ],
        },
      ],
      id: 'okp-local-worker-inference-0123456789abcdef',
      inference_capable: false,
    } as const;

    expect(() => assertOpenShellProviderProfileConformant(relayProfile)).not.toThrow();
    expect(() =>
      assertOpenShellProviderProfileConformant({
        ...relayProfile,
        category: 'mcp',
      })
    ).toThrow('Unsupported OpenShell provider profile category');
    expect(() =>
      assertOpenShellProviderProfileConformant({
        ...relayProfile,
        credentials: [
          {
            ...relayProfile.credentials[0],
            env_vars: ['v1_OPENKIT_WORKER_INFERENCE_TOKEN'],
          },
        ],
      })
    ).toThrow('reserved prefix');
    expect(() =>
      assertOpenShellProviderProfileConformant({
        ...relayProfile,
        id: 'github',
      })
    ).toThrow('reserved');
    expect(() =>
      assertOpenShellProviderProfileConformant({
        ...relayProfile,
        endpoints: [
          {
            enforcement: 'enforce',
            host: 'host.openshell.internal',
            port: 54002,
            protocol: 'rest',
            rules: [],
          },
        ],
      })
    ).toThrow('exact worker inference POST rules');
    expect(() =>
      assertOpenShellProviderProfileConformant({
        ...relayProfile,
        endpoints: [
          {
            ...relayProfile.endpoints[0],
            access: 'read-write',
          },
        ],
      })
    ).toThrow('must not declare broad access');
    for (const rules of [
      [
        {
          allow: {
            method: 'GET',
            path: '/api/worker-inference/v1/chat/completions',
          },
        },
        relayProfile.endpoints[0].rules[1],
      ],
      [
        ...relayProfile.endpoints[0].rules,
        { allow: { method: 'POST', path: '/api/worker-inference/v1/models' } },
      ],
    ]) {
      expect(() =>
        assertOpenShellProviderProfileConformant({
          ...relayProfile,
          endpoints: [{ ...relayProfile.endpoints[0], rules }],
        })
      ).toThrow('exact worker inference POST rules');
    }
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
    expect(() =>
      assertOpenShellCliCommandConformant(['provider', 'delete', 'worker-relay'])
    ).not.toThrow();
    expect(() =>
      assertOpenShellCliCommandConformant(['provider', 'profile', 'export', 'worker-relay'])
    ).not.toThrow();
    expect(() =>
      assertOpenShellCliCommandConformant([
        'provider',
        'profile',
        'import',
        '--file',
        'profile.yaml',
      ])
    ).not.toThrow();
    expect(() =>
      assertOpenShellCliCommandConformant([
        'provider',
        'profile',
        'update',
        '--file',
        'profile.yaml',
        'worker-relay',
      ])
    ).toThrow('outside the pinned surface');
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
