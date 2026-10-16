import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_OPERATION_DEFINITIONS,
  type BootReadinessSnapshot,
  CATALOG_OPERATION_DEFINITIONS,
  type OperationId,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as catalogOwner from './resource-catalog.js';
import { loadWorkspaceResourceCatalog, skillSnapshotPath } from './resource-catalog.js';

/** Real local identity, Workspace admission and immutable catalog owners. */
function fixture(
  getBootReadiness?: () => BootReadinessSnapshot,
  mode: 'local' | 'server' = 'local'
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b5-projections-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('B5 projection');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: userId,
    workspaceId: workspace.id,
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode,
    ...(mode === 'server'
      ? {
          auth: {
            api: { getSession: async () => null },
            handler: async () => new Response(null, { status: 404 }),
          },
        }
      : {}),
    ...(getBootReadiness ? { getBootReadiness } : {}),
    agentManifests: [createTestAgentSetup().manifest],
  });
  return { app, coreDb, dataRoot, userId, workspace, store };
}

/** Posts complete logical input through the real operation admission and native owner. */
function call(f: ReturnType<typeof fixture>, id: OperationId, input: unknown, secret?: string) {
  return f.app.request(
    ...operationRequest(
      id,
      {},
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(input),
      }
    )
  );
}

const tree = (text: string) => [
  {
    kind: 'file',
    path: 'SKILL.md',
    contentBase64: Buffer.from(
      `---\nname: proof\ndescription: Exercise catalog operations.\n---\n${text}`
    ).toString('base64'),
  },
];

describe('B5 catalog operation projections', () => {
  it('reaches all thirteen catalog owned outcomes with exact immutable selection and revisions', async () => {
    const f = fixture();
    const requestId = () => crypto.randomUUID();
    try {
      const empty = await call(f, 'catalog.read', { workspaceId: f.workspace.id });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({
        candidates: [],
        mcp: [],
        plugins: [],
        revision: 0,
        skills: [],
      });
      const imported = await call(f, 'catalog.skill-import', {
        workspaceId: f.workspace.id,
        ...{
          id: 'proof',
          displayName: 'Proof',
          expectedRevision: 0,
          requestId: requestId(),
          tree: tree('# Proof'),
        },
      });
      expect(imported.status, await imported.clone().text()).toBe(201);
      const skill = await imported.json();
      expect(skill.entry.currentDigest).toBe(skill.version.digest);
      const list = await call(f, 'catalog.skill-list', { workspaceId: f.workspace.id });
      expect(list.status).toBe(200);
      expect((await list.json()).items).toEqual([skill.entry]);
      const candidateResponse = await call(f, 'catalog.skill-candidate-submit', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        ...{
          baseDigest: skill.version.digest,
          expectedRevision: 1,
          requestId: requestId(),
          summary: 'Improve',
          tree: tree('# Improved'),
        },
      });
      expect(candidateResponse.status).toBe(201);
      const { candidate } = await candidateResponse.json();
      const decide = await call(f, 'catalog.skill-candidate-decide', {
        workspaceId: f.workspace.id,
        candidateId: candidate.id,
        ...{
          decision: 'promoted',
          expectedCurrentDigest: skill.version.digest,
          expectedRevision: 2,
          requestId: requestId(),
        },
      });
      expect(decide.status).toBe(200);
      expect(await decide.json()).toEqual({ revision: 3 });
      const select = await call(f, 'catalog.skill-select', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        ...{
          digest: skill.version.digest,
          expectedCurrentDigest: candidate.candidateDigest,
          expectedRevision: 3,
          requestId: requestId(),
        },
      });
      expect(select.status).toBe(200);
      expect(await select.json()).toEqual({ revision: 4 });
      const pin = await call(f, 'catalog.skill-pin', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        ...{
          digest: candidate.candidateDigest,
          expectedPinDigest: null,
          expectedRevision: 4,
          requestId: requestId(),
        },
      });
      expect(pin.status).toBe(200);
      expect(await pin.json()).toEqual({ revision: 5 });
      const mcpResponse = await call(f, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        ...{
          id: 'echo',
          displayName: 'Echo',
          allowedTools: ['echo'],
          declaration: { kind: 'http', endpoint: 'https://example.test/mcp' },
          expectedRevision: 5,
          requestId: requestId(),
        },
      });
      expect(mcpResponse.status).toBe(201);
      const mcp = await mcpResponse.json();
      const mcpList = await call(f, 'catalog.mcp-list', { workspaceId: f.workspace.id });
      expect(mcpList.status).toBe(200);
      expect((await mcpList.json()).items).toEqual([mcp.entry]);
      const mcpSelect = await call(f, 'catalog.mcp-select', {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        ...{
          digest: mcp.versionDigest,
          expectedRevision: 6,
          requestId: requestId(),
        },
      });
      expect(mcpSelect.status).toBe(200);
      expect(await mcpSelect.json()).toEqual({ revision: 7 });
      const binding = await call(f, 'catalog.mcp-binding', {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        ...{
          allowedTools: ['echo'],
          enabled: true,
          schemaPolicy: 'tracking',
          bindingRevision: 1,
          expectedRevision: 7,
          requestId: requestId(),
        },
      });
      expect(binding.status).toBe(200);
      expect(await binding.json()).toEqual({ revision: 8 });
      const plugin = await call(f, 'catalog.plugin-import', {
        workspaceId: f.workspace.id,
        ...{
          expectedRevision: 8,
          requestId: requestId(),
          tree: [
            {
              kind: 'file',
              path: 'plugin.json',
              contentBase64: Buffer.from(
                JSON.stringify({ name: 'proof-pack', version: '1.0.0' })
              ).toString('base64'),
            },
          ],
        },
      });
      expect(plugin.status).toBe(201);
      const pluginBody = await plugin.json();
      const pluginList = await call(f, 'catalog.plugin-list', { workspaceId: f.workspace.id });
      expect(pluginList.status).toBe(200);
      expect((await pluginList.json()).items).toEqual([pluginBody.entry]);
      const retained = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      expect(retained.revision).toBe(9);
      expect(retained.skills.entries[0]?.currentDigest).toBe(skill.version.digest);
      expect(retained.skills.pins[0]?.digest).toBe(candidate.candidateDigest);
      expect(retained.mcp.bindings[0]?.enabled).toBe(true);
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it('projects exact Skill inspection, comparison, removal and retained-version refusal', async () => {
    const f = fixture();
    try {
      const invalid = await call(f, 'catalog.skill-import', {
        workspaceId: f.workspace.id,
        displayName: 'Invalid',
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
        tree: [
          {
            kind: 'file',
            path: 'notes.md',
            contentBase64: Buffer.from('# Notes').toString('base64'),
          },
        ],
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'invalid_request' });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(0);
      const imported = await call(f, 'catalog.skill-import', {
        workspaceId: f.workspace.id,
        id: 'proof',
        displayName: 'Proof',
        tree: tree('# Original'),
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      });
      expect(imported.status, await imported.clone().text()).toBe(201);
      const original = await imported.json();
      const identity = {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        digest: original.version.digest,
      };
      const read = await call(f, 'catalog.skill-version-read', identity);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ version: original.version });
      expect(original.version.producer).toEqual({ id: f.userId, kind: 'user' });
      const listed = await call(f, 'catalog.skill-version-list', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ items: [original.version] });
      const content = await call(f, 'catalog.skill-content-read', {
        ...identity,
        path: 'SKILL.md',
      });
      expect(content.status).toBe(200);
      expect(await content.json()).toEqual({
        contentBase64: tree('# Original')[0]!.contentBase64,
        digest: identity.digest,
        entryId: 'proof',
        path: 'SKILL.md',
      });
      const revised = await call(f, 'catalog.skill-import', {
        workspaceId: f.workspace.id,
        id: 'proof',
        displayName: 'Proof',
        activate: false,
        tree: tree('# Revised'),
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
      });
      expect(revised.status).toBe(201);
      const second = await revised.json();
      const diff = await call(f, 'catalog.skill-diff', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        baseDigest: identity.digest,
        candidateDigest: second.version.digest,
      });
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({
        baseDigest: identity.digest,
        candidateDigest: second.version.digest,
        entryId: 'proof',
        changes: [
          {
            path: 'SKILL.md',
            before: original.version.inventory[0],
            after: second.version.inventory[0],
          },
        ],
      });
      const pinned = await call(f, 'catalog.skill-pin', {
        ...identity,
        expectedPinDigest: null,
        expectedRevision: 2,
        requestId: crypto.randomUUID(),
      });
      expect(pinned.status).toBe(200);
      const removed = await call(f, 'catalog.skill-remove', {
        workspaceId: f.workspace.id,
        skillId: 'proof',
        expectedRevision: 3,
        requestId: crypto.randomUUID(),
      });
      expect(removed.status).toBe(200);
      const refused = await call(f, 'catalog.skill-select', {
        ...identity,
        expectedCurrentDigest: null,
        expectedRevision: 4,
        requestId: crypto.randomUUID(),
      });
      expect(refused.status).toBe(404);
      const historical = await call(f, 'catalog.skill-content-read', {
        ...identity,
        path: 'SKILL.md',
      });
      expect(historical.status).toBe(200);
      const purge = await call(f, 'catalog.skill-purge', {
        ...identity,
        expectedRevision: 4,
        requestId: crypto.randomUUID(),
      });
      expect(purge.status).toBe(409);
      expect(await purge.json()).toMatchObject({
        code: 'resource_retained',
        details: { references: ['skill_pin:proof'] },
      });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(4);
      rmSync(skillSnapshotPath(f.dataRoot, f.workspace.id, 'proof', identity.digest), {
        recursive: true,
        force: true,
      });
      const unavailable = await call(f, 'catalog.skill-content-read', {
        ...identity,
        path: 'SKILL.md',
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ code: 'resource_unavailable' });
      const lineage = await call(f, 'catalog.skill-version-read', identity);
      expect(lineage.status).toBe(200);
      expect(await lineage.json()).toEqual({ version: original.version });
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it('reaches Agent inventory, detail, health and worker owned outcomes', async () => {
    const f = fixture();
    try {
      const list = await f.app.request(
        ...operationRequest(
          'agent.list',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }
        )
      );
      expect(list.status).toBe(200);
      expect((await list.json()).items).toEqual([
        expect.objectContaining({ id: 'agent_codex_host' }),
      ]);
      const detail = await f.app.request(
        ...operationRequest(
          'agent.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agentId: 'agent_codex_host' }),
          }
        )
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: 'agent_codex_host', kind: null });
      const refresh = await f.app.request(
        ...operationRequest(
          'agent.health-refresh',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: f.workspace.id }),
          }
        )
      );
      expect(refresh.status).toBe(200);
      expect((await refresh.json()).items).toEqual([
        expect.objectContaining({ agentId: 'agent_codex_host', status: 'unknown' }),
      ]);
      const workers = await f.app.request(
        ...operationRequest(
          'worker.list',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: f.workspace.id }),
          }
        )
      );
      expect(workers.status).toBe(200);
      expect(await workers.json()).toEqual({ items: [], workspaceId: f.workspace.id });
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });
});

it('retires all seventeen formerly authorized bindings without changing canonical catalog authority', async () => {
  const f = fixture();
  const root = `/api/app/workspaces/${f.workspace.id}`;
  try {
    const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    const bindings = [
      ['GET', '/api/app/agents'],
      ['GET', '/api/app/agents/agent_codex_host'],
      ['POST', `${root}/agents/health/refresh`],
      ['GET', `${root}/workers`],
      ['GET', `${root}/catalog`],
      ['GET', `${root}/catalog/skills`],
      ['POST', `${root}/catalog/skills`],
      ['POST', `${root}/catalog/skills/proof/candidates`],
      ['POST', `${root}/catalog/candidates/candidate/decide`],
      ['POST', `${root}/catalog/skills/proof/select`],
      ['POST', `${root}/catalog/skills/proof/pin`],
      ['GET', `${root}/catalog/mcp`],
      ['POST', `${root}/catalog/mcp`],
      ['POST', `${root}/catalog/mcp/echo/select`],
      ['POST', `${root}/catalog/mcp/echo/binding`],
      ['GET', `${root}/catalog/plugins`],
      ['POST', `${root}/catalog/plugins`],
    ];
    expect(bindings).toHaveLength(17);
    for (const [method, path] of bindings) {
      const response = await f.app.request(path!, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
    }
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
  } finally {
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { force: true, recursive: true });
  }
});

/** Exercises the remote MCP framer with an explicit credential and complete logical input. */
async function mcp(
  f: ReturnType<typeof fixture>,
  operation: OperationId,
  input: unknown,
  secret: string
) {
  const response = await f.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call', arguments: { operation, input } },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.error).toBeUndefined();
  return body.result;
}

/** Supplies valid authored inputs for each mutating B5 definition so refusal precedes its effect owner. */
function mutations(workspaceId: string) {
  const requestId = crypto.randomUUID();
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    'agent.health-refresh': { workspaceId },
    'catalog.skill-import': {
      workspaceId,
      id: 'proof',
      displayName: 'Proof',
      tree: tree('# Proof'),
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-candidate-submit': {
      workspaceId,
      skillId: 'proof',
      baseDigest: digest,
      summary: 'Blocked',
      tree: tree('# Proof'),
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-candidate-decide': {
      workspaceId,
      candidateId: testEntityId('cand', 'candidate'),
      decision: 'promoted',
      expectedCurrentDigest: digest,
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-select': {
      workspaceId,
      skillId: 'proof',
      digest,
      expectedCurrentDigest: digest,
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-pin': {
      workspaceId,
      skillId: 'proof',
      digest,
      expectedPinDigest: null,
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-remove': { workspaceId, skillId: 'proof', expectedRevision: 0, requestId },
    'catalog.skill-purge': {
      workspaceId,
      skillId: 'proof',
      digest,
      expectedRevision: 0,
      requestId,
    },
    'catalog.skill-candidate-withdraw': {
      workspaceId,
      candidateId: testEntityId('cand', 'candidate'),
      expectedRevision: 0,
      requestId,
    },
    'catalog.mcp-create': {
      workspaceId,
      displayName: 'Echo',
      id: 'echo',
      allowedTools: ['echo'],
      declaration: { kind: 'http', endpoint: 'https://example.test/mcp' },
      expectedRevision: 0,
      requestId,
    },
    'catalog.mcp-select': { workspaceId, mcpId: 'echo', digest, expectedRevision: 0, requestId },
    'catalog.mcp-binding': {
      workspaceId,
      mcpId: 'echo',
      enabled: true,
      allowedTools: ['echo'],
      bindingRevision: 0,
      schemaPolicy: 'tracking',
      expectedRevision: 0,
      requestId,
    },
    'catalog.plugin-import': {
      workspaceId,
      tree: [
        {
          kind: 'file',
          path: 'plugin.json',
          contentBase64: Buffer.from(JSON.stringify({ name: 'proof' })).toString('base64'),
        },
      ],
      expectedRevision: 0,
      requestId,
    },
  };
}

it.each([
  'readiness',
  'readonly',
] as const)('refuses every B5 mutation on HTTP and remote MCP %s admission without catalog or health effects', async (reason) => {
  let readiness = computeBootReadinessSnapshot({ bootId: 'boot_b5' });
  const f = fixture(() => readiness, 'server');
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: reason === 'readonly' ? 'workspace-readonly' : 'workspace',
    workspaceIds: [f.workspace.id],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
  const refresh = vi.spyOn(f.store, 'refreshAgentHealth');
  const inputs = mutations(f.workspace.id);
  const definitions = { ...AGENT_OPERATION_DEFINITIONS, ...CATALOG_OPERATION_DEFINITIONS };
  expect(
    Object.entries(definitions)
      .filter(([, definition]) => definition.mutating)
      .map(([id]) => id)
      .sort()
  ).toEqual(Object.keys(inputs).sort());
  if (reason === 'readiness') readiness = { ...readiness, acceptingProductWork: false };
  try {
    for (const [operation, input] of Object.entries(inputs)) {
      expect(
        definitions[operation as keyof typeof definitions].inputSchema.safeParse(input).success,
        operation
      ).toBe(true);
      const id = operation as OperationId;
      const expected = {
        code: reason === 'readiness' ? 'product_work_unavailable' : 'workspace_access_denied',
        status: reason === 'readiness' ? 503 : 403,
      };
      const http = await call(f, id, input, token.secret);
      expect(http.status, operation).toBe(expected.status);
      expect(await http.json()).toMatchObject({ code: expected.code });
      const remote = await mcp(f, id, input, token.secret);
      expect(remote.isError, operation).toBe(true);
      expect(JSON.parse(remote.content[0].text)).toMatchObject(expected);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
      expect(f.store.listCommandRequests()).toEqual([]);
      expect(refresh).not.toHaveBeenCalled();
    }
    const read = await mcp(f, 'worker.list', { workspaceId: f.workspace.id }, token.secret);
    expect(read.isError).not.toBe(true);
    expect(JSON.parse(read.content[0].text)).toEqual({ items: [], workspaceId: f.workspace.id });
  } finally {
    vi.restoreAllMocks();
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { force: true, recursive: true });
  }
});

it('preserves missing-record classifications and lets unexpected family failures reach the HTTP handler unchanged', async () => {
  const f = fixture();
  const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
  const observed: Error[] = [];
  f.app.onError((error, context) => {
    observed.push(error);
    return context.text('Internal Server Error', 500);
  });
  try {
    const missing = vi.spyOn(f.store, 'getWorkspace').mockImplementation(() => {
      throw new StoreRecordNotFoundError('Workspace not found.');
    });
    const absent = await call(f, 'worker.list', { workspaceId: f.workspace.id });
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({
      code: 'not_found',
      message: 'Workspace not found.',
    });
    missing.mockRestore();
    for (const [id, spy, input] of [
      [
        'catalog.read',
        vi.spyOn(catalogOwner, 'loadWorkspaceResourceCatalog'),
        { workspaceId: f.workspace.id },
      ],
      ['agent.list', vi.spyOn(f.store, 'getWorkspaceResources'), {}],
      [
        'agent.health-refresh',
        vi.spyOn(f.store, 'refreshAgentHealth'),
        { workspaceId: f.workspace.id },
      ],
      ['worker.list', vi.spyOn(f.store, 'getWorkspace'), { workspaceId: f.workspace.id }],
    ] as const) {
      const failure = new Error(`Private family sentinel: ${id}`);
      spy.mockImplementation(() => {
        throw failure;
      });
      const response = await call(f, id, input);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(observed.at(-1)).toBe(failure);
      spy.mockRestore();
    }
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
    expect(f.store.listCommandRequests()).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { force: true, recursive: true });
  }
});

it('keeps real catalog conflict, missing-version and host-execution refusals exact through HTTP and remote MCP without publication', async () => {
  const f = fixture(undefined, 'server');
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'workspace',
    workspaceIds: [f.workspace.id],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  try {
    const imported = await call(
      f,
      'catalog.skill-import',
      {
        workspaceId: f.workspace.id,
        id: 'proof',
        displayName: 'Proof',
        tree: tree('# Proof'),
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      },
      token.secret
    );
    expect(imported.status, await imported.clone().text()).toBe(201);
    const host = await call(
      f,
      'catalog.mcp-create',
      {
        workspaceId: f.workspace.id,
        id: 'host',
        displayName: 'Host',
        allowedTools: ['echo'],
        declaration: { kind: 'stdio', command: '/usr/bin/true', args: [] },
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
      },
      token.secret
    );
    expect(host.status).toBe(201);
    const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    const receiptsBefore = f.store.listCommandRequests();
    for (const [operation, input, expected] of [
      [
        'catalog.skill-import',
        {
          workspaceId: f.workspace.id,
          id: 'proof',
          displayName: 'Proof',
          tree: tree('# Changed'),
          expectedRevision: 0,
          requestId: crypto.randomUUID(),
        },
        { status: 409, code: 'conflict' },
      ],
      [
        'catalog.skill-select',
        {
          workspaceId: f.workspace.id,
          skillId: 'proof',
          digest: `sha256:${'a'.repeat(64)}`,
          expectedCurrentDigest:
            before.skills.entries.find((entry) => entry.id === 'proof')?.currentDigest ?? null,
          expectedRevision: 2,
          requestId: crypto.randomUUID(),
        },
        { status: 404, code: 'skill_select_failed' },
      ],
      [
        'catalog.mcp-binding',
        {
          workspaceId: f.workspace.id,
          mcpId: 'host',
          enabled: true,
          allowedTools: ['echo'],
          bindingRevision: 1,
          schemaPolicy: 'tracking',
          expectedRevision: 2,
          requestId: crypto.randomUUID(),
        },
        { status: 403, code: 'mcp_binding_failed' },
      ],
    ] as const) {
      const http = await call(f, operation, input, token.secret);
      expect(http.status, operation).toBe(expected.status);
      expect(await http.json()).toMatchObject({ code: expected.code });
      const remote = await mcp(f, operation, input, token.secret);
      expect(remote.isError).toBe(true);
      expect(JSON.parse(remote.content[0].text)).toMatchObject(expected);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
      expect(f.store.listCommandRequests()).toEqual(receiptsBefore);
    }
  } finally {
    f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { force: true, recursive: true });
  }
});
