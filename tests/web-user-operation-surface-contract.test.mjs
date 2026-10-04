import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOAL_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  SYNC_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { PUBLIC_OPERATION_ACCESS } from '../apps/nanocore/src/auth/operation-access.ts';
import { SURFACES } from '../apps/web/src/app/surfaces.ts';

const EXPECTED_CATALOG_SIZE = 237;
const EXPECTED_SERVER_SIZE = 56;
const EXPECTED_GATEWAY_SIZE = 2;
const EXPECTED_INCLUDED_SIZE = 179;

/** Included operations whose current Web projection is explicitly deferred to a Roadmap owner. */
const NON_RELEASE_READY_ROADMAP = new Map([
  ['automation.create', 'R092'],
  ['automation.delete', 'R092'],
  ['workspace.delete', 'R049'],
  ['downloadWorkspaceExportArchive', 'R008'],
  ['knowledge.proposal.draft', 'R070'],
  ['dryRunWorkspaceArchiveImport', 'R008'],
  ['importWorkspaceArchive', 'R008'],
  ['automation.list', 'R092'],
  ['workspace.deleted-recover', 'R049'],
  ['knowledge.proposal.reverse', 'R072'],
  ['automation.update', 'R092'],
]);

/** Published Tier-A titles from the live surface catalog. Unpublished B/C names are rejected. */
const WEB_SURFACES = new Set(
  SURFACES.filter((surface) => surface.tier === 'A').map((surface) => surface.title)
);

/**
 * Explicit grouped Web dispositions for every included catalog operation.
 *
 * This object is the coverage inventory. It is not a production owner.
 * The guard admits catalog membership, disposition, and a published surface title.
 * It does not prove UI behavior.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, WebOperationDisposition>>>>}
 */
const WEB_OPERATION_GROUPS = {
  Synchronization: Object.fromEntries(
    Object.keys(SYNC_OPERATION_DEFINITIONS).map((id) => [
      id,
      { disposition: 'live', surface: 'Workspace changes' },
    ])
  ),
  'Agent environment': {
    'environment.snapshot-read': { disposition: 'live', surface: 'Debug' },
    'environment.snapshot-list': { disposition: 'live', surface: 'Debug' },
  },
  Agents: {
    'agent.read': { disposition: 'workflow', surface: 'Agents' },
    'agent.list': { disposition: 'live', surface: 'Agents' },
    'worker.list': { disposition: 'workflow', surface: 'Agents' },
  },
  Administration: {
    'administration.configuration-apply': { disposition: 'workflow', surface: 'Administration' },
    'worker-environment.status': { disposition: 'live', surface: 'Administration' },
    'worker-environment.list': { disposition: 'live', surface: 'Administration' },
    'worker-environment.purge': { disposition: 'live', surface: 'Administration' },
    'administration.conversation-submit': { disposition: 'live', surface: 'Administration' },
  },
  'App utilities': {
    'chat.quick': { disposition: 'workflow', surface: 'Chat' },
    'agent.health-refresh': { disposition: 'live', surface: 'Agents' },
    'app.search': { disposition: 'workflow', surface: 'Overview' },
    'turn.feedback': { disposition: 'live', surface: 'Chat' },
  },
  Artifacts: {
    'artifact.import': { disposition: 'live', surface: 'Artifacts' },
    'artifact.introduce': { disposition: 'live', surface: 'Artifacts' },
  },
  recovery: {
    'recovery.worker-list': { disposition: 'live', surface: 'Recovery' },
    'recovery.checkpoint-retry': { disposition: 'live', surface: 'Recovery' },
  },
  scheduler: {
    'scheduler.list': { disposition: 'live', surface: 'Recovery' },
    'scheduler.retry': { disposition: 'live', surface: 'Recovery' },
    'scheduler.cancel': { disposition: 'live', surface: 'Recovery' },
  },
  automation: {
    'automation.create': { disposition: 'roadmap', roadmap: 'R092' },
    'automation.delete': { disposition: 'roadmap', roadmap: 'R092' },
    'automation.list': { disposition: 'roadmap', roadmap: 'R092' },
    'automation.update': { disposition: 'roadmap', roadmap: 'R092' },
  },
  Catalog: {
    'catalog.mcp-create': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-candidate-decide': { disposition: 'live', surface: 'Catalog' },
    'catalog.read': { disposition: 'live', surface: 'Catalog' },
    'catalog.plugin-import': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-import': { disposition: 'live', surface: 'Catalog' },
    'catalog.mcp-list': { disposition: 'live', surface: 'Catalog' },
    'catalog.plugin-list': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-list': { disposition: 'live', surface: 'Catalog' },
    'catalog.mcp-select': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-select': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-pin': { disposition: 'live', surface: 'Catalog' },
    'catalog.skill-candidate-submit': { disposition: 'workflow', surface: 'Catalog' },
    'catalog.mcp-binding': { disposition: 'live', surface: 'Catalog' },
  },
  'Generative apps': {
    'kernel.records.batch': { disposition: 'workflow', surface: 'Chat' },
    'kernel.apps.create': { disposition: 'workflow', surface: 'Chat' },
    'generative-ui.get': { disposition: 'live', surface: 'Chat' },
    'generative-ui.resource': { disposition: 'live', surface: 'Chat' },
    'kernel.records.get': { disposition: 'workflow', surface: 'Chat' },
    ...Object.fromEntries(
      Object.keys(KERNEL_OPERATION_DEFINITIONS).map((id) => [
        id,
        { disposition: 'workflow', surface: 'Chat' },
      ])
    ),
    'kernel.records.list': { disposition: 'workflow', surface: 'Chat' },
    'kernel.apps.list': { disposition: 'workflow', surface: 'Chat' },
    'generative-ui.publish': { disposition: 'workflow', surface: 'Chat' },
    'generative-ui.refresh': { disposition: 'live', surface: 'Chat' },
    'kernel.apps.retire': { disposition: 'workflow', surface: 'Chat' },
    'generative-ui.action': { disposition: 'live', surface: 'Chat' },
    'kernel.records.update': { disposition: 'workflow', surface: 'Chat' },
    'kernel.schema.update': { disposition: 'workflow', surface: 'Chat' },
  },
  Dashboards: {
    'conversation.targets': { disposition: 'live', surface: 'Chat' },
    'conversation.navigation': { disposition: 'live', surface: 'Chat' },
    'thread.dashboard': { disposition: 'live', surface: 'Chat' },
    'workspace.dashboard': { disposition: 'live', surface: 'Overview' },
    'attention.list': { disposition: 'live', surface: 'Overview' },
    'thread.items': { disposition: 'live', surface: 'Chat' },
  },
  'Diagnostics and evidence': {
    'usage.read': { disposition: 'live', surface: 'Usage & audit' },
    'audit.workspace-list': { disposition: 'live', surface: 'Usage & audit' },
    'evidence.bundle-list': { disposition: 'live', surface: 'Debug' },
    'permission.workspace-list': { disposition: 'live', surface: 'Usage & audit' },
    'evidence.runtime-list': { disposition: 'live', surface: 'Debug' },
  },
  'Knowledge Manager': {
    'knowledge.answer': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.health.check': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.proposal.draft': { disposition: 'roadmap', roadmap: 'R070' },
    'knowledge.claim.list': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.conflict.list': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.observation.list': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.source.list': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.context.prepare': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.indexes': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.source.read': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.claim.record': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.conflict.record': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.observation.record': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.source.register': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.conflict.resolve': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.retrieval': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.repair.suggest': { disposition: 'live', surface: 'Knowledge' },
  },
  Materials: {
    'material.bind': { disposition: 'live', surface: 'Material' },
    'material.create': { disposition: 'live', surface: 'Material' },
    'material.exclude': { disposition: 'live', surface: 'Material' },
    'material.thread-read': { disposition: 'live', surface: 'Material' },
    'material.read': { disposition: 'live', surface: 'Material' },
    'material.revision-read': { disposition: 'live', surface: 'Material' },
    'material.revision-list': { disposition: 'live', surface: 'Material' },
    'material.list': { disposition: 'live', surface: 'Material' },
    'material.restore': { disposition: 'live', surface: 'Material' },
    'material.revision-save': { disposition: 'live', surface: 'Material' },
    'material.unbind': { disposition: 'live', surface: 'Material' },
  },
  Modes: {
    ...Object.fromEntries(
      Object.keys(GOAL_OPERATION_DEFINITIONS).map((id) => [
        id,
        { disposition: 'workflow', surface: 'Goal' },
      ])
    ),
    'worker-environment.select': { disposition: 'live', surface: 'Chat' },
    'conversation.submit': { disposition: 'live', surface: 'Chat' },
    'task.start': { disposition: 'live', surface: 'Task' },
  },
  Reviews: {
    'artifact.review-list': { disposition: 'live', surface: 'Artifact review' },
    'knowledge.proposal.reverse': { disposition: 'roadmap', roadmap: 'R072' },
    'artifact.review.decide': { disposition: 'live', surface: 'Artifact review' },
    'knowledge.proposal.decide': { disposition: 'live', surface: 'Knowledge' },
  },
  Portability: {
    downloadWorkspaceExportArchive: { disposition: 'roadmap', roadmap: 'R008' },
    dryRunWorkspaceArchiveImport: { disposition: 'roadmap', roadmap: 'R008' },
    'workspace.import-dry-run': { disposition: 'live', surface: 'Portability' },
    'workspace.export': { disposition: 'live', surface: 'Portability' },
    importWorkspaceArchive: { disposition: 'roadmap', roadmap: 'R008' },
    'workspace.import': { disposition: 'live', surface: 'Portability' },
  },
  Vault: {
    'vault.grant-create': { disposition: 'live', surface: 'Vault backend' },
    'vault.secret-create': { disposition: 'live', surface: 'Vault backend' },
    'vault.grant-list': { disposition: 'live', surface: 'Vault' },
    'vault.injection-plan-list': { disposition: 'live', surface: 'Vault' },
    'vault.injection-receipt-list': { disposition: 'live', surface: 'Vault' },
    'vault.reference-list': { disposition: 'live', surface: 'Vault' },
    'vault.use-list': { disposition: 'live', surface: 'Vault' },
    'vault.reference-rebind': { disposition: 'live', surface: 'Portability' },
    'vault.grant-revoke': { disposition: 'live', surface: 'Vault backend' },
    'vault.secret-revoke': { disposition: 'live', surface: 'Vault backend' },
    'vault.secret-rotate': { disposition: 'live', surface: 'Vault backend' },
  },
  'Workspace sharing': {
    'workspace.my-invitation-accept': { disposition: 'live', surface: 'Account' },
    'workspace.member-access-change': { disposition: 'live', surface: 'Account' },
    'workspace.invitation-create': { disposition: 'live', surface: 'Account' },
    'workspace.my-invitation-decline': { disposition: 'live', surface: 'Account' },
    'workspace.delete': { disposition: 'roadmap', roadmap: 'R049' },
    'workspace.leave': { disposition: 'live', surface: 'Account' },
    'workspace.list': { disposition: 'live', surface: 'Account' },
    'workspace.my-invitation-list': { disposition: 'live', surface: 'Account' },
    'workspace.invitation-list': { disposition: 'live', surface: 'Account' },
    'workspace.member-list': { disposition: 'live', surface: 'Account' },
    'workspace.member-remove': { disposition: 'live', surface: 'Account' },
    'workspace.deleted-recover': { disposition: 'roadmap', roadmap: 'R049' },
    'workspace.invitation-revoke': { disposition: 'live', surface: 'Account' },
    'workspace.ownership-transfer': { disposition: 'live', surface: 'Account' },
  },
  'My admin access': {
    listMyAdminAccessTokens: { disposition: 'live', surface: 'My admin access' },
    setMyAdminAccessTokenDefault: { disposition: 'live', surface: 'My admin access' },
  },
  'Core approval': {
    'approval.respond': { disposition: 'live', surface: 'Overview' },
    'question.answer': {
      disposition: 'live',
      surface: 'Chat',
    },
    'pending-request.withdraw': {
      disposition: 'live',
      surface: 'Overview',
    },
  },
  'Core artifacts': {
    'artifact.list': {
      disposition: 'live',
      surface: 'Artifacts',
    },
    'artifact.read': {
      disposition: 'live',
      surface: 'Artifact review',
    },
  },
  'Core Knowledge CRUD': {
    'knowledge.delete': {
      disposition: 'live',
      surface: 'Knowledge',
    },
    'knowledge.list': { disposition: 'live', surface: 'Knowledge' },
    'knowledge.update': {
      disposition: 'live',
      surface: 'Knowledge',
    },
    'knowledge.create': { disposition: 'live', surface: 'Knowledge' },
  },
  'Core thread reads': {
    'thread.list': { disposition: 'live', surface: 'Chat' },
    'thread.read': { disposition: 'live', surface: 'Chat' },
    'GET /api/workspaces/:workspaceId/threads/:threadId/events': {
      disposition: 'live',
      surface: 'Chat',
    },
    'turn.read': {
      disposition: 'workflow',
      surface: 'Chat',
    },
  },
  'Core turn commands': {
    'turn.start': { disposition: 'live', surface: 'Chat' },
    'turn.interrupt': {
      disposition: 'live',
      surface: 'Chat',
    },
  },
  'Core workspace lifecycle and reads': {
    'workspace.read': { disposition: 'live', surface: 'General' },
    'workspace.resources': { disposition: 'workflow', surface: 'Overview' },
    'workspace.update': { disposition: 'live', surface: 'General' },
  },
  'Core workspace and Thread writes': {
    'thread.update': {
      disposition: 'live',
      surface: 'Chat',
    },
    'workspace.create': { disposition: 'live', surface: 'New workspace' },
    'thread.create': { disposition: 'live', surface: 'Chat' },
    'thread.archive': {
      disposition: 'live',
      surface: 'Chat',
    },
  },
};

/**
 * One inventory row: a published Web surface or a named Roadmap owner.
 *
 * @typedef {{ disposition: 'live' | 'workflow', surface: string, roadmap?: undefined } | { disposition: 'roadmap', roadmap: string, surface?: undefined }} WebOperationDisposition
 */

/**
 * Partitions the runtime public-operation catalog by Web inclusion.
 *
 * @param {Readonly<Record<string, { authentication?: string, scope: string }>>} catalog
 * Runtime `PUBLIC_OPERATION_ACCESS` value.
 * @returns {{ gateway: string[], included: string[], server: string[], total: number }}
 * Sorted operation-key partitions.
 */
function partitionCatalog(catalog) {
  const entries = Object.entries(catalog);
  const gateway = [];
  const included = [];
  const server = [];

  for (const [operationKey, access] of entries) {
    if (access.scope === 'server') {
      server.push(operationKey);
      continue;
    }
    if (access.authentication === 'gateway-actor') {
      gateway.push(operationKey);
      continue;
    }
    if (access.scope === 'user' || access.scope === 'workspace') {
      included.push(operationKey);
    }
  }

  gateway.sort();
  included.sort();
  server.sort();
  return { gateway, included, server, total: entries.length };
}

/**
 * Flattens the grouped inventory and records any repeated operation keys.
 *
 * @param {Readonly<Record<string, Readonly<Record<string, WebOperationDisposition>>>>} groups
 * Grouped disposition inventory.
 * @returns {{ duplicates: string[], operations: Map<string, WebOperationDisposition> }}
 * Deduped operation map plus duplicate keys.
 */
function flattenInventory(groups) {
  const operations = new Map();
  const duplicates = [];

  for (const dispositions of Object.values(groups)) {
    for (const [operationKey, disposition] of Object.entries(dispositions)) {
      if (operations.has(operationKey)) {
        duplicates.push(operationKey);
        continue;
      }
      operations.set(operationKey, disposition);
    }
  }

  return { duplicates, operations };
}

/**
 * Asserts one inventory row is live/workflow with a known surface, or an accepted Roadmap exception.
 *
 * @param {string} operationKey Catalog operation key.
 * @param {WebOperationDisposition} disposition Inventory row.
 */
function assertDisposition(operationKey, disposition) {
  if (disposition.disposition === 'live' || disposition.disposition === 'workflow') {
    assert.equal(
      typeof disposition.surface,
      'string',
      `${operationKey} live/workflow disposition requires a Web surface`
    );
    assert.ok(
      WEB_SURFACES.has(disposition.surface),
      `${operationKey} surface is not a published Web surface: ${disposition.surface}`
    );
    assert.equal(
      disposition.roadmap,
      undefined,
      `${operationKey} live/workflow disposition must not carry a Roadmap id`
    );
    return;
  }

  assert.equal(
    disposition.disposition,
    'roadmap',
    `${operationKey} has unknown disposition ${disposition.disposition}`
  );
  assert.ok(
    NON_RELEASE_READY_ROADMAP.has(operationKey),
    `${operationKey} has no accepted roadmap-only disposition`
  );
  assert.equal(
    disposition.roadmap,
    NON_RELEASE_READY_ROADMAP.get(operationKey),
    `${operationKey} roadmap disposition must match its accepted owner`
  );
  assert.equal(
    disposition.surface,
    undefined,
    `${operationKey} roadmap disposition must not carry a Web surface`
  );
}

describe('Web user operation surface contract', () => {
  it('accounts for every included catalog operation and excludes server and Gateway-actor operations', () => {
    const catalog = partitionCatalog(PUBLIC_OPERATION_ACCESS);
    const inventory = flattenInventory(WEB_OPERATION_GROUPS);
    const inventoried = [...inventory.operations.keys()].sort();

    assert.equal(catalog.total, EXPECTED_CATALOG_SIZE);
    assert.equal(catalog.server.length, EXPECTED_SERVER_SIZE);
    assert.equal(catalog.gateway.length, EXPECTED_GATEWAY_SIZE);
    assert.equal(catalog.included.length, EXPECTED_INCLUDED_SIZE);
    assert.deepEqual(catalog.gateway, ['POST /v1/chat/completions', 'POST /v1/responses']);
    assert.deepEqual(inventory.duplicates, []);
    assert.deepEqual(
      inventoried.filter((operationKey) => catalog.server.includes(operationKey)),
      []
    );
    assert.deepEqual(
      inventoried.filter((operationKey) => catalog.gateway.includes(operationKey)),
      []
    );
    assert.deepEqual(
      inventoried.filter((operationKey) => !catalog.included.includes(operationKey)),
      []
    );
    assert.deepEqual(
      catalog.included.filter((operationKey) => !inventory.operations.has(operationKey)),
      []
    );
    assert.deepEqual(inventoried, catalog.included);

    const remainingRoadmapOnly = inventoried.filter((operationKey) => {
      const disposition = inventory.operations.get(operationKey);
      return disposition?.disposition === 'roadmap' && !NON_RELEASE_READY_ROADMAP.has(operationKey);
    });
    assert.deepEqual(remainingRoadmapOnly, []);

    for (const [operationKey, disposition] of inventory.operations) {
      assertDisposition(operationKey, disposition);
    }
  });
});
