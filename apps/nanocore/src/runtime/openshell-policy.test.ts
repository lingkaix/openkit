import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectOpenShellWorkerPolicy } from './openshell-policy.js';

const expectedPolicy = JSON.parse(
  readFileSync(
    new URL('../../../../tests/support/openshell-worker-policy.json', import.meta.url),
    'utf8'
  )
) as unknown;
const representativeInput = {
  additionalFilesystemGrants: [
    { access: 'read-only' as const, path: '/opt/toolchains' },
    { access: 'read-write' as const, path: '/sandbox/.cache/npm' },
  ],
  additionalNetworkEndpoints: [
    {
      binaries: ['/usr/local/bin/codex'],
      host: 'api.example.com',
      name: 'direct_api',
      port: 443,
      protocol: 'rest',
    },
    {
      binaries: ['/usr/bin/git'],
      host: 'github.com',
      name: 'github_git_read',
      port: 443,
      rules: [
        { method: 'GET' as const, path: '/**/info/refs*' },
        { method: 'POST' as const, path: '/**/git-upload-pack' },
      ],
    },
  ],
};

describe('projectOpenShellWorkerPolicy', () => {
  it('projects the canonical structured policy consumed by NanoHost', () => {
    expect(projectOpenShellWorkerPolicy(representativeInput)).toEqual(expectedPolicy);
  });

  it('grants persistent data, ephemeral control, and immutable image supply separately', () => {
    const policy = projectOpenShellWorkerPolicy({});

    expect(policy.filesystem.includeWorkdir).toBe(false);
    expect(policy.filesystem.readOnly).toContain('/opt');
    expect(policy.filesystem.readWrite).toEqual(
      expect.arrayContaining(['/sandbox', '/workspace', '/openkit', '/tmp/openkit-bootstrap'])
    );
    expect(policy.filesystem.readWrite).not.toContain('/tmp');
  });

  it('rejects filesystem paths that OpenShell cannot enforce', () => {
    expect(() =>
      projectOpenShellWorkerPolicy({
        additionalFilesystemGrants: [{ access: 'read-only', path: 'relative' }],
      })
    ).toThrow('OpenShell additional filesystem grant path must be canonical and absolute.');

    expect(() =>
      projectOpenShellWorkerPolicy({
        additionalFilesystemGrants: [{ access: 'read-write', path: '/opt/../sandbox' }],
      })
    ).toThrow('OpenShell additional filesystem grant path must be canonical and absolute.');
  });

  it.each([
    '/usr',
    '/lib',
    '/proc',
    '/dev/urandom',
    '/app',
    '/etc',
    '/opt',
    '/var/log',
  ])('rejects read-write grants that overlap fixed read-only root %s', (root) => {
    for (const path of ['/', root, `${root}/nested`]) {
      expect(() =>
        projectOpenShellWorkerPolicy({
          additionalFilesystemGrants: [{ access: 'read-write', path }],
        })
      ).toThrow(
        'OpenShell additional read-write filesystem grant overlaps a fixed read-only root.'
      );
    }
  });

  it('retains authored read-only supply and read-write data grants', () => {
    expect(() => projectOpenShellWorkerPolicy(representativeInput)).not.toThrow();
  });

  it.each([
    [
      'invalid name',
      { binaries: ['/usr/bin/git'], host: 'github.com', name: 'github/source', port: 443 },
      'OpenShell additional network endpoint name must be an identifier.',
    ],
    [
      'blank host',
      { binaries: ['/usr/bin/git'], host: ' ', name: 'github_source', port: 443 },
      'OpenShell additional network endpoint host is required.',
    ],
    [
      'invalid port',
      { binaries: ['/usr/bin/git'], host: 'github.com', name: 'github_source', port: 0 },
      'OpenShell additional network endpoint port must be between 1 and 65535.',
    ],
    [
      'unsupported protocol',
      {
        binaries: ['/usr/bin/git'],
        host: 'github.com',
        name: 'github_source',
        port: 443,
        protocol: 'grpc',
      },
      'OpenShell additional network endpoint protocol must be rest.',
    ],
    [
      'empty binaries',
      { binaries: [], host: 'github.com', name: 'github_source', port: 443 },
      'OpenShell additional network endpoint requires non-empty binary paths.',
    ],
    [
      'rules with access',
      {
        access: 'read-write' as const,
        binaries: ['/usr/bin/git'],
        host: 'github.com',
        name: 'github_source',
        port: 443,
        rules: [{ method: 'GET' as const, path: '/**/info/refs*' }],
      },
      'OpenShell network endpoint cannot combine access with exact REST rules.',
    ],
    [
      'relative rule path',
      {
        binaries: ['/usr/bin/git'],
        host: 'github.com',
        name: 'github_source',
        port: 443,
        rules: [{ method: 'GET' as const, path: 'info/refs' }],
      },
      'OpenShell exact REST rule paths must be absolute and contain no line breaks.',
    ],
  ])('rejects %s before runtime carriage', (_case, endpoint, message) => {
    expect(() => projectOpenShellWorkerPolicy({ additionalNetworkEndpoints: [endpoint] })).toThrow(
      message
    );
  });
});
