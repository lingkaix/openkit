import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCredentialHelper } from './credential-helper-protocols.js';

// Independent wire oracle; synthetic fixtures only. See api.md and sources.md.
const LIMIT = 65_536;
const PRIVATE = 'synthetic-private-marker';
const EXPIRY = '2099-01-02T03:04:05Z';
const V1 = 'client.authentication.k8s.io/v1';
const BETA = 'client.authentication.k8s.io/v1beta1';
const ID = 'urn:ietf:params:oauth:token-type:id_token';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';
const SAML = 'urn:ietf:params:oauth:token-type:saml2';
const CERT = 'synthetic-certificate-value';
const KEY = 'synthetic-key-value';
/** Build injected exec-info without reading the process environment. */
const kubeInput = (apiVersion = V1, interactive = false) =>
  JSON.stringify({ apiVersion, kind: 'ExecCredential', spec: { interactive } });
/** Build native long-term AWS output with synthetic fields. */
const aws = () => ({ Version: 1, AccessKeyId: 'synthetic-access', SecretAccessKey: PRIVATE });
/** Build native OIDC output without an output-file cache. */
const google = () => ({
  version: 1,
  success: true,
  token_type: ID,
  id_token: 'synthetic.token.value',
});
/** Build token-only output in the negotiated Kubernetes version. */
const kube = (apiVersion = V1) => ({
  apiVersion,
  kind: 'ExecCredential',
  status: { token: PRIVATE },
});
const cases = [
  { protocol: 'git', operation: 'get', input: 'protocol=https\npath=scope\n\n' },
  { protocol: 'docker', operation: 'get', input: 'registry-key\n' },
  { protocol: 'aws', input: '' },
  { protocol: 'kubernetes', input: kubeInput() },
  { protocol: 'google', input: '' },
] as const;

/** Assert the fixed, non-secret refusal contract. */
function failure(reply: { exitCode: number; stdout: string; stderr: string }, protocol: string) {
  expect(reply.exitCode).toBe(1);
  if (protocol === 'google') {
    expect(JSON.parse(reply.stdout)).toEqual({
      version: 1,
      success: false,
      code: 'credential_error',
      message: 'Credential unavailable',
    });
    expect(reply.stderr).toBe('');
  } else {
    expect(reply.stdout).toBe('');
    expect(reply.stderr).toBe('Credential unavailable\n');
  }
  expect(JSON.stringify(reply)).not.toContain(PRIVATE);
}

/** Assert a single bounded JSON success document. */
function jsonSuccess(
  reply: { exitCode: number; stdout: string; stderr: string },
  expected: unknown
) {
  expect(reply.exitCode).toBe(0);
  expect(reply.stderr).toBe('');
  expect(reply.stdout.endsWith('\n')).toBe(true);
  expect(JSON.parse(reply.stdout)).toEqual(expected);
  expect(Buffer.byteLength(reply.stdout, 'utf8')).toBeLessThanOrEqual(LIMIT);
}

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  logs = ['log', 'warn', 'error'].map((method) =>
    vi.spyOn(console, method as 'log').mockImplementation(() => {})
  );
});
afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe('Git credential helper', () => {
  it('parses once, preserves equals signs and spaces, ignores unknown attributes, and emits blank-line termination', async () => {
    const resolve = vi.fn(async () => ({
      username: 'synthetic-user',
      password: 'synthetic=value',
      ignored: PRIVATE,
    }));
    const reply = await runCredentialHelper(
      {
        protocol: 'git',
        operation: 'get',
        input:
          'protocol=https\npath=scope=part two\ncustom=ignored\nstate[]=first\nstate[]=\nstate[]=second\n\n',
      },
      resolve
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      protocol: 'git',
      operation: 'get',
      attributes: { protocol: 'https', path: 'scope=part two' },
    });
    expect(reply).toEqual({
      exitCode: 0,
      stdout: 'username=synthetic-user\npassword=synthetic=value\n\n',
      stderr: '',
    });
  });

  it('accepts EOF termination and an absent credential without inventing values', async () => {
    const resolve = vi.fn(() => null);
    expect(
      await runCredentialHelper({ protocol: 'git', operation: 'get', input: 'path=scope' }, resolve)
    ).toEqual({ exitCode: 0, stdout: '\n', stderr: '' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      protocol: 'git',
      operation: 'get',
      attributes: { path: 'scope' },
    });
  });

  it.each([
    [{ username: 'synthetic-user' }, 'username=synthetic-user\n\n'],
    [{ password: PRIVATE }, `password=${PRIVATE}\n\n`],
    [{}, '\n'],
  ] as const)('permits a subset or no attributes from get: %#', async (value, stdout) => {
    expect(await runCredentialHelper(cases[0], () => value)).toEqual({
      exitCode: 0,
      stdout,
      stderr: '',
    });
  });

  it.each(['store', 'erase'] as const)(
    'supports %s with no credential output',
    async (operation) => {
      const attributes = { protocol: 'https', username: 'synthetic-user', password: PRIVATE };
      const resolve = vi.fn(() => ({ password: PRIVATE }));
      expect(
        await runCredentialHelper(
          {
            protocol: 'git',
            operation,
            input: `protocol=https\nusername=synthetic-user\npassword=${PRIVATE}\n\n`,
          },
          resolve
        )
      ).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(resolve).toHaveBeenCalledExactlyOnceWith({ protocol: 'git', operation, attributes });
    }
  );

  it.each([
    '',
    'broken\n\n',
    '=value\n\n',
    'path=a\npath=b\n\n',
    'path=a\0b\n\n',
    'path=a\r\n\n',
    'path=a\n\npassword=trailing\n',
    'custom=ignored\n\n',
    `path=${'a'.repeat(65_530)}\n`,
  ])('rejects malformed or out-of-profile input before callback: %j', async (input) => {
    const resolve = vi.fn();
    failure(
      await runCredentialHelper({ protocol: 'git', operation: 'get', input }, resolve),
      'git'
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts the exact total and per-line byte boundary', async () => {
    const input = `path=${'a'.repeat(65_529)}\n\n`;
    expect(Buffer.byteLength(input)).toBe(LIMIT);
    const resolve = vi.fn(() => null);
    expect(
      (await runCredentialHelper({ protocol: 'git', operation: 'get', input }, resolve)).exitCode
    ).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    { username: 'synthetic-user', password: `x\npassword=${PRIVATE}` },
    { username: 'synthetic-user\0', password: PRIVATE },
    { username: 7, password: PRIVATE },
    { password: 7 },
    { username: 'synthetic-user', password: 'a'.repeat(LIMIT) },
  ])('rejects unsafe callback credentials atomically', async (value) => {
    failure(await runCredentialHelper(cases[0], () => value), 'git');
  });
});

describe('Docker credential helper', () => {
  it.each(['registry-key', 'registry-key\n'])(
    'gets native JSON for raw target %j',
    async (input) => {
      const resolve = vi.fn(() => ({
        Username: '<token>',
        Secret: PRIVATE,
        ignored: 'discard-me',
      }));
      jsonSuccess(
        await runCredentialHelper({ protocol: 'docker', operation: 'get', input }, resolve),
        { Username: '<token>', Secret: PRIVATE }
      );
      expect(resolve).toHaveBeenCalledExactlyOnceWith({
        protocol: 'docker',
        operation: 'get',
        target: 'registry-key',
      });
    }
  );

  it('erases a target without printing callback data', async () => {
    const resolve = vi.fn(() => ({ Secret: PRIVATE }));
    expect(
      await runCredentialHelper(
        { protocol: 'docker', operation: 'erase', input: 'registry-key\n' },
        resolve
      )
    ).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      protocol: 'docker',
      operation: 'erase',
      target: 'registry-key',
    });
  });

  it.each([
    '',
    JSON.stringify({ ServerURL: 'registry-key', Username: 'synthetic-user', Secret: PRIVATE }),
    'a'.repeat(LIMIT + 1),
  ])('refuses store before any callback or credential parsing', async (input) => {
    const resolve = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    failure(
      await runCredentialHelper({ protocol: 'docker', operation: 'store', input }, resolve),
      'docker'
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '\n',
    '  ',
    'registry-key\nextra',
    'registry-key\n\n',
    'registry-key\0',
    'registry-key\r\n',
  ])('rejects malformed raw targets %j before callback', async (input) => {
    const resolve = vi.fn();
    failure(
      await runCredentialHelper({ protocol: 'docker', operation: 'get', input }, resolve),
      'docker'
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { Username: 'synthetic-user' },
    { Username: 1, Secret: PRIVATE },
    { Username: 'synthetic-user', Secret: 'a'.repeat(LIMIT) },
  ])('rejects malformed get results', async (value) => {
    failure(await runCredentialHelper(cases[1], () => value), 'docker');
  });
});

describe('AWS credential_process Version 1', () => {
  it('emits long-term credentials without inventing expiration or session token', async () => {
    const resolve = vi.fn(() => ({ ...aws(), ignored: 'discard-me' }));
    jsonSuccess(await runCredentialHelper(cases[2], resolve), aws());
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ protocol: 'aws', operation: 'get' });
  });

  it('emits temporary credentials in native case', async () => {
    const value = { ...aws(), SessionToken: 'synthetic-session', Expiration: EXPIRY };
    jsonSuccess(await runCredentialHelper(cases[2], () => value), value);
  });

  it.each([
    null,
    {},
    { ...aws(), Version: '1' },
    { ...aws(), Version: 2 },
    { ...aws(), AccessKeyId: '' },
    { ...aws(), SecretAccessKey: 3 },
    { ...aws(), SessionToken: 7 },
    { ...aws(), Expiration: 'not-a-time' },
    { ...aws(), Expiration: '2099-13-32T00:00:00Z' },
  ])('refuses malformed callback output', async (value) => {
    failure(await runCredentialHelper(cases[2], () => value), 'aws');
  });
});

describe('Kubernetes ExecCredential', () => {
  it.each([V1, BETA])(
    'round-trips negotiated apiVersion %s without exposing input cluster data',
    async (apiVersion) => {
      const value = {
        ...kube(apiVersion),
        status: { token: PRIVATE, expirationTimestamp: EXPIRY, ignored: 'discard-me' },
        ignored: 'discard-me',
      };
      const resolve = vi.fn(() => value);
      const input = JSON.stringify({
        apiVersion,
        kind: 'ExecCredential',
        spec: { interactive: false, cluster: { ignored: PRIVATE } },
      });
      jsonSuccess(await runCredentialHelper({ protocol: 'kubernetes', input }, resolve), {
        apiVersion,
        kind: 'ExecCredential',
        status: { token: PRIVATE, expirationTimestamp: EXPIRY },
      });
      expect(resolve).toHaveBeenCalledExactlyOnceWith({
        protocol: 'kubernetes',
        operation: 'get',
        apiVersion,
        interactive: false,
      });
    }
  );

  it('passes interactive true explicitly and permits no expiry', async () => {
    const resolve = vi.fn(() => kube());
    jsonSuccess(
      await runCredentialHelper({ protocol: 'kubernetes', input: kubeInput(V1, true) }, resolve),
      kube()
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      protocol: 'kubernetes',
      operation: 'get',
      apiVersion: V1,
      interactive: true,
    });
  });

  it.each([false, true])(
    'accepts paired TLS certificate/key fields, with token present: %s',
    async (withToken) => {
      const status = {
        clientCertificateData: CERT,
        clientKeyData: KEY,
        ...(withToken ? { token: PRIVATE } : {}),
      };
      const value = { apiVersion: V1, kind: 'ExecCredential', status };
      jsonSuccess(await runCredentialHelper(cases[3], () => value), value);
    }
  );

  it.each([
    '',
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ apiVersion: 'v2', kind: 'ExecCredential', spec: { interactive: false } }),
    JSON.stringify({ apiVersion: V1, kind: 'Other', spec: { interactive: false } }),
    JSON.stringify({ apiVersion: V1, kind: 'ExecCredential', spec: {} }),
    JSON.stringify({ apiVersion: V1, kind: 'ExecCredential', spec: { interactive: 'false' } }),
  ])('refuses invalid exec-info before callback: %j', async (input) => {
    const resolve = vi.fn();
    failure(await runCredentialHelper({ protocol: 'kubernetes', input }, resolve), 'kubernetes');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    kube(BETA),
    { ...kube(), kind: 'Other' },
    { ...kube(), status: {} },
    { ...kube(), status: { token: '' } },
    { ...kube(), status: { token: PRIVATE, expirationTimestamp: 'not-a-time' } },
    { ...kube(), status: { clientCertificateData: CERT } },
    { ...kube(), status: { clientKeyData: KEY } },
    { ...kube(), status: { clientCertificateData: CERT, clientKeyData: '' } },
    { ...kube(), status: { clientCertificateData: CERT, clientKeyData: 7 } },
    { ...kube(), status: { token: PRIVATE, clientCertificateData: CERT } },
  ])('refuses wrong version or malformed credential results', async (value) => {
    failure(await runCredentialHelper(cases[3], () => value), 'kubernetes');
  });
});

describe('Google external-account executable response', () => {
  it.each([ID, JWT])(
    'emits supported OIDC type %s and optional epoch expiry',
    async (token_type) => {
      const value = { ...google(), token_type, expiration_time: 4_070_908_800 };
      const resolve = vi.fn(() => ({ ...value, ignored: 'discard-me' }));
      jsonSuccess(await runCredentialHelper(cases[4], resolve), value);
      expect(resolve).toHaveBeenCalledExactlyOnceWith({ protocol: 'google', operation: 'get' });
    }
  );

  it('permits omitted expiration because no output-file cache is exposed', async () => {
    jsonSuccess(await runCredentialHelper(cases[4], google), google());
  });

  it('emits SAML using saml_response rather than id_token', async () => {
    const value = {
      version: 1,
      success: true,
      token_type: SAML,
      saml_response: 'synthetic-assertion',
      expiration_time: 4_070_908_800,
    };
    jsonSuccess(await runCredentialHelper(cases[4], () => value), value);
  });

  it('sanitizes upstream failure code/message rather than echoing callback details', async () => {
    failure(
      await runCredentialHelper(cases[4], () => ({
        version: 1,
        success: false,
        code: PRIVATE,
        message: PRIVATE,
      })),
      'google'
    );
  });

  it.each([
    null,
    {},
    { ...google(), version: 2 },
    { ...google(), version: '1' },
    { ...google(), success: 'true' },
    { ...google(), token_type: 'unsupported' },
    { ...google(), id_token: '' },
    { ...google(), id_token: 7 },
    { ...google(), expiration_time: '4070908800' },
    { ...google(), expiration_time: -1 },
    { ...google(), expiration_time: 1.5 },
    { ...google(), expiration_time: Infinity },
    { ...google(), token_type: SAML },
  ])('refuses malformed callback response', async (value) => {
    failure(await runCredentialHelper(cases[4], () => value), 'google');
  });
});

describe('shared boundaries and callback isolation', () => {
  for (const request of cases) {
    it(`${request.protocol}: catches synchronous throws and asynchronous rejection without leakage`, async () => {
      for (const resolve of [
        () => {
          throw new Error(PRIVATE);
        },
        async () => {
          throw new Error(PRIVATE);
        },
      ]) {
        failure(await runCredentialHelper(request, resolve), request.protocol);
      }
    });

    it(`${request.protocol}: rejects oversized UTF-8 input before callback`, async () => {
      for (const input of ['a'.repeat(LIMIT + 1), '\u00e9'.repeat(33_000)]) {
        const resolve = vi.fn();
        failure(await runCredentialHelper({ ...request, input }, resolve), request.protocol);
        expect(resolve).not.toHaveBeenCalled();
      }
    });

    it(`${request.protocol}: rejects unknown operation before callback`, async () => {
      const resolve = vi.fn();
      failure(
        await runCredentialHelper({ ...request, operation: 'unsupported' }, resolve),
        request.protocol
      );
      expect(resolve).not.toHaveBeenCalled();
    });
  }

  it.each(['aws', 'google'] as const)('%s accepts no stdin payload', async (protocol) => {
    const resolve = vi.fn();
    failure(await runCredentialHelper({ protocol, input: PRIVATE }, resolve), protocol);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['aws', { ...aws(), SecretAccessKey: '\u00e9'.repeat(33_000) }],
    ['kubernetes', { ...kube(), status: { token: '\u00e9'.repeat(33_000) } }],
    ['google', { ...google(), id_token: '\u00e9'.repeat(33_000) }],
  ] as const)('%s refuses oversized serialized callback output', async (protocol, value) => {
    const request = cases.find((entry) => entry.protocol === protocol)!;
    failure(await runCredentialHelper(request, () => value), protocol);
  });

  it('catches callback result access errors without printing their details', async () => {
    const value = {
      get Version(): number {
        throw new Error(PRIVATE);
      },
    };
    failure(await runCredentialHelper(cases[2], () => value), 'aws');
  });
});
