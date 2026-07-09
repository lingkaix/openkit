import { describe, expect, it } from 'vitest';
import { renderOpenShellWorkerPolicy } from './openshell-policy.js';

describe('renderOpenShellWorkerPolicy', () => {
  it('renders the real OpenShell policy schema for the worker control relay endpoint', () => {
    const policy = renderOpenShellWorkerPolicy({
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('version: 1');
    expect(policy).toContain('filesystem_policy:');
    expect(policy).toContain('read_write:');
    expect(policy).toContain('- /sandbox');
    expect(policy).not.toContain('    - /workspace\n');
    expect(policy).toContain('landlock:');
    expect(policy).toContain('network_policies:');
    expect(policy).toContain('openkit_worker_control_relay:');
    expect(policy).toContain('binaries:');
    expect(policy).toContain('path: /usr/local/bin/node');
    expect(policy).toContain('path: /usr/local/bin/openkit-worker-sidecar');
    expect(policy).toContain('host: host.openshell.internal');
    expect(policy).toContain('port: 3000');
    expect(policy).toContain('protocol: rest');
    expect(policy).toContain('enforcement: enforce');
    expect(policy).toContain('access: read-write');
    expect(policy).not.toContain('rules:');
  });

  it('can override authorized binaries when the OpenShell image path changes', () => {
    const policy = renderOpenShellWorkerPolicy({
      binaries: ['/usr/bin/curl'],
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('path: /usr/bin/curl');
    expect(policy).not.toContain('path: /usr/local/bin/node');
  });

  it('renders narrowly scoped additional network endpoints for research workers', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          access: 'read-only',
          binaries: ['/usr/bin/git', '/usr/bin/curl', '/usr/lib/git-core/git-remote-https'],
          host: 'github.com',
          name: 'github_source',
          port: 443,
          protocol: 'rest',
        },
      ],
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('github_source:');
    expect(policy).toContain('name: github_source');
    expect(policy).toContain('path: /usr/bin/git');
    expect(policy).toContain('path: /usr/bin/curl');
    expect(policy).toContain('path: /usr/lib/git-core/git-remote-https');
    expect(policy).toContain('host: github.com');
    expect(policy).toContain('port: 443');
    expect(policy).toContain('protocol: rest');
    expect(policy).toContain('access: read-only');
  });

  it('renders additional filesystem grants into the derived OpenShell policy', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalFilesystemGrants: [
        {
          access: 'read-only',
          path: '/opt/toolchains',
        },
        {
          access: 'read-write',
          path: '/sandbox/.cache/npm',
        },
      ],
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('    - /opt/toolchains');
    expect(policy).toContain('    - /sandbox/.cache/npm');
  });

  it('does not grant broad writable workspace access over read-only workspace roots', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalFilesystemGrants: [
        {
          access: 'read-only',
          path: '/workspace/vendor-sdk',
        },
      ],
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });
    const readWriteSection = policy.split('  read_write:')[1] ?? '';

    expect(policy).toContain('    - /workspace/vendor-sdk');
    expect(readWriteSection).not.toContain('    - /workspace\n');
    expect(readWriteSection).not.toContain('    - /workspace/vendor-sdk');
  });

  it('allows both the Codex wrapper and bundled Codex binary by default for extra endpoints', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          host: 'chatgpt.com',
          name: 'chatgpt_account',
          port: 443,
        },
      ],
      relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('path: /usr/local/bin/codex');
    expect(policy).toContain('path: /usr/local/lib/codex/codex/codex');
  });

  it('uses default ports for HTTP and HTTPS relay upstreams', () => {
    expect(renderOpenShellWorkerPolicy({ relayUpstream: 'https://nanocore.local/api' })).toContain(
      'port: 443'
    );
    expect(renderOpenShellWorkerPolicy({ relayUpstream: 'http://nanocore.local/api' })).toContain(
      'port: 80'
    );
  });

  it('rejects relay upstreams that OpenShell cannot authorize as HTTP endpoints', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        relayUpstream: 'unix:///tmp/openkit-control.sock',
      })
    ).toThrow('OpenShell worker relay upstream must be an HTTP or HTTPS URL.');
  });

  it('rejects invalid additional network endpoint names', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        additionalNetworkEndpoints: [
          {
            host: 'github.com',
            name: 'github/source',
            port: 443,
          },
        ],
        relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
      })
    ).toThrow('OpenShell additional network endpoint name must be an identifier.');
  });

  it('blocks policy output that falls outside the pinned OpenShell snapshot', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        additionalNetworkEndpoints: [
          {
            host: 'github.com',
            name: 'github_source',
            port: 443,
            protocol: 'grpc',
          },
        ],
        relayUpstream: 'http://host.openshell.internal:3000/api/worker-control',
      })
    ).toThrow('Unsupported OpenShell policy protocol');
  });
});
