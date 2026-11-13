import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import type { PolicyDocumentV1 } from '@openkit/protocol';
import { afterEach } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../../storage/db.js';
import { applyScopedMigrations } from '../../storage/migrate.js';
import { type PolicyProposal, policyDigest, preparePolicyDocument } from '../statements.js';

export const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7000-8000-000000000001';
export const responsibleHumanId = 'usr_00000000-0000-7000-8000-000000000002';
export const agentId = 'policy-reviewer';
export const human = { kind: 'human' as const, id: userId };
const resource = {
  kind: 'mcp-tool' as const,
  workspaceId,
  serverId: 'issues',
  toolName: 'read',
};
const scope = {
  subjects: [human],
  actions: ['tool.use'],
  resources: [resource],
};
const lifetime = {
  anchor: {
    owner: { kind: 'workspace' as const, workspaceId },
    kind: 'workspace' as const,
    id: workspaceId,
  },
};
const cleanup: (() => void)[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const close of cleanup.splice(0)) close();
});

/** The public authoring boundary produces the agent domain consumed by interception. */
export function document(withGate: boolean): PolicyDocumentV1 {
  const declaration = {
    id: 'review-principal',
    kind: 'agent-principal',
    state: 'active',
    author: human,
    authority: { kind: 'human', userId },
    authoredAt: '2026-11-01T00:00:00.000Z',
    scope: { ...scope, subjects: [{ kind: 'agent', id: agentId }] },
    lifetime,
    agentId,
    creator: human,
    responsibility: { kind: 'human', id: responsibleHumanId },
    responsibleHumanId,
  };
  return preparePolicyDocument({
    current: { schemaVersion: 1, statements: [] },
    userId,
    now: '2026-11-01T00:00:00.000Z',
    proposed: {
      schemaVersion: 1,
      statements: [
        declaration,
        ...(withGate
          ? [
              {
                id: 'review',
                kind: 'binding',
                state: 'active',
                author: human,
                authority: { kind: 'human', userId },
                authoredAt: '2026-11-01T00:00:00.000Z',
                scope,
                lifetime,
                operation: 'mcp.call-tool',
                stage: 'decide',
                mode: 'gate',
                participant: {
                  kind: 'agent',
                  id: agentId,
                  version: policyDigest(declaration),
                },
                inputDisclosure: scope,
                order: 0,
                timeoutMs: 1000,
                failure: 'escalate-to-human',
                circuit: { failures: 2, recoveryAfterMs: 100 },
              },
            ]
          : []),
      ],
    },
  }).document;
}

/** A real Kernel allow, with the actual requested principal rather than borrowed human rights. */
function kernel(proposal: PolicyProposal) {
  const user = `${proposal.subject.principal.kind}:${proposal.subject.principal.id}`;
  const state: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: 'grant', kind: 'userAttribute' },
      { id: 'target', kind: 'object' },
      { id: 'resources', kind: 'objectAttribute' },
      { id: 'domain', kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: 'grant' },
      { child: 'grant', parent: 'domain' },
      { child: 'target', parent: 'resources' },
      { child: 'resources', parent: 'domain' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['tool.use'] }],
    associations: [
      {
        id: 'exact-read',
        userAttribute: 'grant',
        targetAttribute: 'resources',
        accessRights: ['tool.use'],
      },
    ],
    ...(proposal.subject.process
      ? { processUsers: [{ process: proposal.subject.process.turnId, user }] }
      : {}),
  };
  return evaluateAccess(state, {
    user,
    operation: 'tool.use',
    target: 'target',
  });
}

/** Real decision and Audit owners; external currentness facts are explicit callback inputs. */
export function fixture(policy: PolicyDocumentV1) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-e10-agent-'));
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  const proposal: PolicyProposal = {
    operation: 'mcp.call-tool',
    workspaceId,
    capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
    resource,
    inputReferences: {
      argumentsDigest: policyDigest({ issue: 1 }),
      catalogRevision: 'fixture',
      packageSnapshotId: 'fixture',
      schemaDigest: null,
    },
    inputAttributes: {},
    subject: {
      principal: human,
      onBehalfOf: null,
      actor: { kind: 'user', id: userId },
      process: {
        workspaceId,
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7000-8000-000000000001',
      },
      credentialKind: 'session',
      responsibleHumanId: userId,
    },
  };
  return {
    workspaceDb,
    document: policy,
    proposal,
    authorizationRevision: policyDigest({ member: userId }),
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => true,
    stillCurrent: () => true,
    finalKernel: ({ proposal: value }: { proposal: PolicyProposal }) => kernel(value),
  };
}
