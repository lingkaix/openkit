import { WorkerSandboxAccessSchema, WorkspaceMcpServerCatalogSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import type { ResolvedAgentManifest } from '../agents/setup-resolver.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  assertPublicNetworkGrants,
  canonicalPublicNetworkHost,
  type PublicNetworkDestinationFacts,
} from './public-network-grants.js';

const publicGrant = {
  id: 'public-search',
  host: 'search.example.com',
  port: 443,
  purpose: 'Public retrieval',
  binaries: ['/usr/local/bin/node'],
  protocol: 'rest',
  rules: [{ method: 'POST', path: '/mcp' }],
  publicAccess: { kind: 'credential-free-non-llm' },
};

const { publicAccess: _publicAccess, ...ordinaryGrant } = publicGrant;

/** Creates only the manifest sections read by the classification oracle. */
function manifest(
  network: unknown[] = [publicGrant],
  credentials: unknown[] = []
): ResolvedAgentManifest {
  return {
    mcp: [],
    sandbox: {
      ...WorkerSandboxAccessSchema.parse({ network }),
      credentialDeclarations: credentials,
    },
  } as ResolvedAgentManifest;
}

/** Synthetic destination facts contain no live service or credentials. */
function facts(): PublicNetworkDestinationFacts {
  return { providerRegistry: new ProviderRegistry([]), controlHosts: [] };
}

describe('public network admission', () => {
  it('admits an explicitly classified public MCP endpoint', () => {
    expect(() => assertPublicNetworkGrants(manifest(), facts())).not.toThrow();
  });

  it.each([
    'localhost.',
    '127.0.0.1.',
    '0x7f000001',
    '[::ffff:127.0.0.1]',
  ])('rejects private canonical public hosts: %s', (host) => {
    expect(() => assertPublicNetworkGrants(manifest([{ ...publicGrant, host }]), facts())).toThrow(
      /private|localhost/i
    );
  });

  it.each([
    'https://SEARCH.EXAMPLE.COM./v1',
    'https://search.example.com:8443/models',
  ])('excludes current Provider hosts across ports and paths: %s', (baseUrl) => {
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'private-provider',
          kind: 'direct',
          displayName: 'Provider',
          baseUrl,
          models: [],
          readiness: { status: 'disabled' },
        },
      ]),
    };
    expect(() => assertPublicNetworkGrants(manifest(), current)).toThrow(/excluded/i);
  });

  it('excludes configured Gateway/control hosts', () => {
    expect(() =>
      assertPublicNetworkGrants(manifest(), { ...facts(), controlHosts: ['SEARCH.EXAMPLE.COM.'] })
    ).toThrow(/excluded/i);
  });

  it('compares IPv4-mapped IPv6 destinations with configured IPv4 control identities', () => {
    expect(canonicalPublicNetworkHost('[::ffff:8.8.8.8]')).toBe('8.8.8.8');
    expect(() =>
      assertPublicNetworkGrants(manifest([{ ...publicGrant, host: '[::ffff:8.8.8.8]' }]), {
        ...facts(),
        controlHosts: ['8.8.8.8'],
      })
    ).toThrow(/excluded/i);
  });

  it('refuses unresolved Provider destination metadata', () => {
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'unknown',
          vendor: 'unknown-vendor',
          kind: 'direct',
          displayName: 'Unknown',
          models: [],
        },
      ]),
    };
    expect(() => assertPublicNetworkGrants(manifest(), current)).toThrow(/metadata/i);
  });

  it('does not guess destinations from env names, file paths or declaration ids', () => {
    const credentials = [
      {
        id: 'search',
        vaultGrantId: 'grant-search',
        visibility: 'runtime-env',
        targetEnvVarName: 'SEARCH_API_KEY',
      },
      {
        id: 'public-search',
        vaultGrantId: 'grant-file',
        visibility: 'runtime-file',
        targetPath: '/sandbox/credentials/search',
      },
    ];
    expect(() =>
      assertPublicNetworkGrants(manifest([publicGrant], credentials), facts())
    ).not.toThrow();
  });

  it('refuses ambiguous existing Provider attachments', () => {
    const credential = {
      id: 'credential',
      vaultGrantId: 'grant',
      visibility: 'sandbox-provider',
      provider: {
        profileId: 'missing',
        instanceId: 'attachment',
        type: 'custom',
        credentialKey: 'KEY',
      },
    };
    expect(() => assertPublicNetworkGrants(manifest([publicGrant], [credential]), facts())).toThrow(
      /metadata/i
    );
  });

  it.each([
    { access: 'read-write', rules: undefined },
    { access: 'read-only', rules: undefined, publicRules: [{ method: 'GET', path: '/search' }] },
    { rules: [{ method: 'POST', path: '/**' }] },
    { rules: [{ method: 'POST', path: '/m*' }] },
    { rules: [{ method: 'POST', path: '/mcp' }] },
    { rules: [{ method: 'POST', path: '/[a-z]*' }] },
  ])('refuses effective overlap: %j', ({ publicRules, ...change }) => {
    const grant = publicRules ? { ...publicGrant, rules: publicRules } : publicGrant;
    const other = { ...ordinaryGrant, id: 'broader', ...change };
    expect(() => assertPublicNetworkGrants(manifest([grant, other]), facts())).toThrow(/overlap/i);
  });

  it.each([
    { host: 'unrelated.example.com' },
    { port: 8443 },
    { binaries: ['/usr/local/bin/codex'] },
    { rules: [{ method: 'GET', path: '/mcp' }] },
    { rules: [{ method: 'POST', path: '/other/**' }] },
    { rules: [{ method: 'POST', path: '/elsewhere' }] },
    { access: 'read-only', rules: undefined },
  ])('admits provably nonoverlapping authority: %j', (change) => {
    const other = { ...ordinaryGrant, id: 'separate', ...change };
    expect(() => assertPublicNetworkGrants(manifest([publicGrant, other]), facts())).not.toThrow();
  });

  it('compares two glob allowances conservatively', () => {
    const grant = { ...publicGrant, rules: [{ method: 'POST', path: '/m*/lookup' }] };
    const other = { ...ordinaryGrant, id: 'other', rules: [{ method: 'POST', path: '/mcp/*' }] };
    expect(() => assertPublicNetworkGrants(manifest([grant, other]), facts())).toThrow(/overlap/i);
  });
});

describe('public network destination evidence', () => {
  it('rejects a platform credential attached to the destination before any sink is called', () => {
    const credential = {
      id: 'credential',
      vaultGrantId: 'grant',
      visibility: 'sandbox-provider',
      provider: {
        profileId: 'provider',
        instanceId: 'attachment',
        type: 'custom',
        credentialKey: 'KEY',
      },
    };
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'provider',
          kind: 'direct',
          displayName: 'Provider',
          baseUrl: 'https://search.example.com/v1',
          models: [],
        },
      ]),
    };
    expect(() => assertPublicNetworkGrants(manifest([publicGrant], [credential]), current)).toThrow(
      /credential attachment/i
    );
  });

  it('uses configured native Provider endpoint metadata without an invented host registry', () => {
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        { id: 'provider', vendor: 'openai', kind: 'direct', displayName: 'Provider', models: [] },
      ]),
    };
    expect(() =>
      assertPublicNetworkGrants(manifest([{ ...publicGrant, host: 'API.OPENAI.COM.' }]), current)
    ).toThrow(/excluded/i);
    expect(() => assertPublicNetworkGrants(manifest(), current)).not.toThrow();
  });

  it('classifies unrelated Provider attachments separately from public destinations', () => {
    const credential = {
      id: 'credential',
      vaultGrantId: 'grant',
      visibility: 'sandbox-provider',
      provider: {
        profileId: 'provider',
        instanceId: 'attachment',
        type: 'custom',
        credentialKey: 'KEY',
      },
    };
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'provider',
          kind: 'direct',
          displayName: 'Provider',
          baseUrl: 'https://elsewhere.example.com/v1',
          models: [],
        },
      ]),
    };
    expect(() =>
      assertPublicNetworkGrants(manifest([publicGrant], [credential]), current)
    ).not.toThrow();
  });

  it('refuses a managed MCP destination regardless of whether it carries a credential', () => {
    const selected = { ...manifest(), mcp: [{ id: 'managed-search' }] };
    const current = {
      ...facts(),
      mcpCatalog: {
        schemaVersion: 1,
        servers: [
          {
            id: 'managed-search',
            enabled: true,
            transport: { kind: 'http', endpoint: 'https://search.example.com/mcp' },
            credentialBindings: [],
            allowedTools: ['search'],
            deniedTools: [],
            approvalRequiredTools: [],
            timeoutMs: 1000,
            schemaPolicy: 'tracking',
            pinnedSchemaSnapshotId: null,
            packageRootDigest: null,
          },
        ],
        extensions: {},
      },
    } as PublicNetworkDestinationFacts;
    expect(() => assertPublicNetworkGrants(selected, current)).toThrow(/Gateway mediation/i);
  });

  it('refuses missing selected MCP destination metadata', () => {
    expect(() =>
      assertPublicNetworkGrants({ ...manifest(), mcp: [{ id: 'missing' }] }, facts())
    ).toThrow(/metadata/i);
  });

  it.each([
    'https://search.example.com',
    'search.example.com/path',
    'search.example.com:443',
    'search.example.com?query',
    'search.example.com#fragment',
    'search.example.com\u0000',
  ])('refuses non-host destination metadata %j', (host) => {
    expect(() => canonicalPublicNetworkHost(host)).toThrow();
  });
});

describe('public network canonical identities and retained scope', () => {
  it('normalizes DNS and IPv6 identities without a remote probe', () => {
    expect(canonicalPublicNetworkHost(' SEARCH.Example.COM. ')).toBe('search.example.com');
    expect(canonicalPublicNetworkHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(canonicalPublicNetworkHost('[2001:db8::1]')).toBe('[2001:db8::1]');
  });

  it('uses the existing OAuth Provider endpoint metadata', () => {
    const current = {
      ...facts(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'account',
          vendor: 'openai-codex',
          kind: 'oauth',
          displayName: 'Account',
          models: [],
        },
      ]),
    };
    expect(() => assertPublicNetworkGrants(manifest(), current)).not.toThrow();
    expect(() =>
      assertPublicNetworkGrants(manifest([{ ...publicGrant, host: 'chatgpt.com' }]), current)
    ).toThrow(/excluded/i);
  });

  it('compares canonical destinations for overlap', () => {
    const other = {
      ...ordinaryGrant,
      id: 'other',
      host: 'SEARCH.EXAMPLE.COM.',
      rules: [{ method: 'POST', path: '/mcp' }],
    };
    expect(() => assertPublicNetworkGrants(manifest([publicGrant, other]), facts())).toThrow(
      /overlap/i
    );
  });

  it('keeps unmarked grants on their ordinary path', () => {
    expect(() =>
      assertPublicNetworkGrants(manifest([ordinaryGrant]), {
        ...facts(),
        providerRegistry: new ProviderRegistry([
          { id: 'unknown', kind: 'direct', displayName: 'Unknown', models: [] },
        ]),
      })
    ).not.toThrow();
  });
});

describe('public network route distinctions', () => {
  it('keeps built-in capability selections mediated without inventing external destinations', () => {
    expect(() =>
      assertPublicNetworkGrants(
        { ...manifest(), mcp: [{ id: 'openkit-repository' }, { id: 'openkit-generative' }] },
        facts()
      )
    ).not.toThrow();
  });

  it('does not infer a remote destination for a managed stdio selection', () => {
    const mcpCatalog = WorkspaceMcpServerCatalogSchema.parse({
      schemaVersion: 1,
      servers: [
        {
          id: 'local-index',
          enabled: true,
          transport: { kind: 'stdio', command: 'node', args: [] },
          allowedTools: ['search'],
          schemaPolicy: 'tracking',
        },
      ],
    });
    expect(() =>
      assertPublicNetworkGrants(
        { ...manifest(), mcp: [{ id: 'local-index' }] },
        { ...facts(), mcpCatalog }
      )
    ).not.toThrow();
    mcpCatalog.servers[0]!.enabled = false;
    expect(() =>
      assertPublicNetworkGrants(
        { ...manifest(), mcp: [{ id: 'local-index' }] },
        { ...facts(), mcpCatalog }
      )
    ).toThrow(/metadata/i);
  });

  it('proves disjoint literal paths despite a shared prefix', () => {
    expect(() =>
      assertPublicNetworkGrants(
        manifest([
          publicGrant,
          { ...ordinaryGrant, id: 'other', rules: [{ method: 'POST', path: '/mcp/another' }] },
        ]),
        facts()
      )
    ).not.toThrow();
  });
});
