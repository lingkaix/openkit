import { describe, expect, it } from 'vitest';
import { renderOpenShellWorkerPolicy } from './openshell-policy.js';

const CONTROL_BINARIES = ['/usr/local/bin/node', '/usr/local/bin/openkit-worker-shim'];

describe('renderOpenShellWorkerPolicy', () => {
  it('renders the real OpenShell policy schema for the direct NanoCore control endpoint', () => {
    const policy = renderOpenShellWorkerPolicy({
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('version: 1');
    expect(policy).toContain('filesystem_policy:');
    expect(policy).toContain('read_write:');
    expect(policy).toContain('- /sandbox');
    expect(policy).not.toContain('    - /workspace\n');
    expect(policy).toContain('landlock:');
    expect(policy).toContain('network_policies:');
    expect(policy).toContain('openkit_worker_control:');
    expect(policy).toContain('name: openkit_worker_control');
    expect(policy).not.toContain('relay');
    expect(policy).toContain('binaries:');
    expect(policy).toContain('path: /usr/local/bin/node');
    expect(policy).toContain('path: /usr/local/bin/openkit-worker-shim');
    expect(policy).not.toContain('openkit-worker-sidecar');
    expect(policy).toContain('host: host.openshell.internal');
    expect(policy).toContain('port: 3000');
    expect(policy).toContain('protocol: rest');
    expect(policy).toContain('enforcement: enforce');
    expect(policy).not.toContain('access: read-write');
    expect(policy.match(/method: POST/g)).toHaveLength(8);
    for (const path of [
      '/api/worker-control/heartbeat',
      '/api/worker-control/artifacts',
      '/api/worker-control/commands/poll',
      '/api/worker-control/commands/ack',
      '/api/worker-control/events/append',
      '/api/worker-control/final-status',
      '/api/worker-control/supply-refresh-ack',
      '/api/worker-control/capability-summary',
    ]) {
      expect(policy).toContain(`path: ${path}`);
    }
    expect(policy).not.toContain('path: /api/worker-control/knowledge-proposal-summary');
    expect(policy).not.toContain('/api/worker-inference/');
  });

  it('can override authorized binaries when the OpenShell image path changes', () => {
    const policy = renderOpenShellWorkerPolicy({
      binaries: ['/usr/bin/curl'],
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('path: /usr/bin/curl');
    expect(policy).not.toContain('path: /usr/local/bin/node');
  });

  it('renders only AEP-derived network endpoints when no direct control URL exists', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          access: 'read-write',
          binaries: ['/usr/local/bin/codex'],
          host: 'api.example.com',
          name: 'direct_api',
          port: 443,
          protocol: 'rest',
        },
      ],
      binaries: CONTROL_BINARIES,
    });

    expect(policy).not.toContain('openkit_worker_control:');
    expect(policy).toContain('direct_api:');
    expect(policy).toContain('name: direct_api');
    expect(policy).toContain('path: /usr/local/bin/codex');
    expect(policy).toContain('host: api.example.com');
    expect(policy).toContain('port: 443');
    expect(policy).toContain('protocol: rest');
    expect(policy).toContain('access: read-write');
  });

  it('renders exact REST allow rules without a broad access preset', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
          host: 'host.openshell.internal',
          name: 'openkit_worker_inference',
          port: 3000,
          protocol: 'rest',
          rules: [
            { method: 'POST', path: '/api/worker-inference/v1/chat/completions' },
            { method: 'POST', path: '/api/worker-inference/v1/responses' },
          ],
        },
      ],
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });
    const inferencePolicy = policy.split('  openkit_worker_inference:')[1] ?? '';

    expect(inferencePolicy).toContain('rules:');
    expect(inferencePolicy).toContain('method: POST');
    expect(inferencePolicy).toContain('path: /api/worker-inference/v1/chat/completions');
    expect(inferencePolicy).toContain('path: /api/worker-inference/v1/responses');
    expect(inferencePolicy).not.toContain('access:');
  });

  it('renders Git Smart HTTP read rules with GET and wildcard paths but no push rule', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          binaries: ['/usr/bin/git'],
          host: 'github.com',
          name: 'github_git_read',
          port: 443,
          protocol: 'rest',
          rules: [
            { method: 'GET', path: '/**/info/refs*' },
            { method: 'POST', path: '/**/git-upload-pack' },
          ],
        },
      ],
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });
    const gitPolicy = policy.split('  github_git_read:')[1] ?? '';

    expect(gitPolicy).toContain('method: GET');
    expect(gitPolicy).toContain('path: /**/info/refs*');
    expect(gitPolicy).toContain('method: POST');
    expect(gitPolicy).toContain('path: /**/git-upload-pack');
    expect(gitPolicy).not.toContain('git-receive-pack');
    expect(gitPolicy).not.toContain('access:');
  });

  it('rejects network endpoints that mix exact rules with an access preset', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        additionalNetworkEndpoints: [
          {
            access: 'read-write',
            binaries: ['/usr/local/bin/codex'],
            host: 'host.openshell.internal',
            name: 'openkit_worker_inference',
            port: 3000,
            protocol: 'rest',
            rules: [{ method: 'POST', path: '/api/worker-inference/v1/responses' }],
          },
        ],
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
      })
    ).toThrow('cannot combine access with exact REST rules');
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
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
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
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });
    const readWriteSection = policy.split('  read_write:')[1] ?? '';

    expect(policy).toContain('    - /workspace/vendor-sdk');
    expect(readWriteSection).not.toContain('    - /workspace\n');
    expect(readWriteSection).not.toContain('    - /workspace/vendor-sdk');
  });

  it('uses only AEP-authorized binaries for extra endpoints', () => {
    const policy = renderOpenShellWorkerPolicy({
      additionalNetworkEndpoints: [
        {
          binaries: ['/usr/local/bin/opencode'],
          host: 'chatgpt.com',
          name: 'chatgpt_account',
          port: 443,
        },
      ],
      binaries: CONTROL_BINARIES,
      controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
    });

    expect(policy).toContain('path: /usr/local/bin/opencode');
    expect(policy).not.toContain('path: /usr/local/bin/codex');
  });

  it('uses default ports for HTTP and HTTPS control endpoints', () => {
    expect(
      renderOpenShellWorkerPolicy({
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'https://nanocore.local/api',
      })
    ).toContain('port: 443');
    expect(
      renderOpenShellWorkerPolicy({
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'http://nanocore.local/api',
      })
    ).toContain('port: 80');
  });

  it('rejects control endpoints that OpenShell cannot authorize as HTTP endpoints', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'unix:///tmp/openkit-control.sock',
      })
    ).toThrow('OpenShell worker control endpoint must be an HTTP or HTTPS URL.');
  });

  it('rejects invalid additional network endpoint names', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        additionalNetworkEndpoints: [
          {
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            name: 'github/source',
            port: 443,
          },
        ],
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
      })
    ).toThrow('OpenShell additional network endpoint name must be an identifier.');
  });

  it('blocks policy output that falls outside the pinned OpenShell snapshot', () => {
    expect(() =>
      renderOpenShellWorkerPolicy({
        additionalNetworkEndpoints: [
          {
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            name: 'github_source',
            port: 443,
            protocol: 'grpc',
          },
        ],
        binaries: CONTROL_BINARIES,
        controlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
      })
    ).toThrow('Unsupported OpenShell policy protocol');
  });
});
