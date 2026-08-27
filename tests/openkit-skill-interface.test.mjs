import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as appSchemas from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import * as protocol from '@openkit/protocol';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = join(repoRoot, 'skills', 'openkit');
const cliPath = join(skillRoot, 'scripts', 'openkit');
const protocolExports = new Map(Object.entries(protocol));

test('the OpenKit Skill ships only the accepted release tree', () => {
  assert.deepEqual(listFiles(skillRoot), [
    'SKILL.md',
    'agents/openai.yaml',
    'references/administration.md',
    'references/capability-map.md',
    'references/knowledge.md',
    'references/loop.md',
    'references/recovery.md',
    'references/setup.md',
    'scripts/openkit',
  ]);

  const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter);
  assert.deepEqual(
    frontmatter[1]
      .split('\n')
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')))
      .sort(),
    ['description', 'name']
  );
  assert.ok(skill.split('\n').length < 500);

  for (const name of [
    'administration',
    'capability-map',
    'knowledge',
    'loop',
    'recovery',
    'setup',
  ]) {
    assert.match(skill, new RegExp(`references/${name}\\.md`));
  }

  assert.equal(statSync(cliPath).mode & 0o111, 0o111);
});

test('provider-subscription operations reuse the App API provider-id schema', async () => {
  const { operationCatalog } = await operations();
  const [providerList, ...accountOperations] = operationCatalog.filter((entry) =>
    entry.id.startsWith('provider-subscription.')
  );

  assert.equal(providerList.id, 'provider-subscription.provider-list');
  assert.equal(providerList.inputSchema.shape.subscriptionProviderId, undefined);
  for (const entry of accountOperations) {
    assert.strictEqual(
      entry.inputSchema.shape.subscriptionProviderId,
      appSchemas.SubscriptionProviderIdSchema,
      entry.id
    );
  }
});

test('one catalog covers the checked App API and public Core projection', async () => {
  const { operationCatalog, operationExclusions } = await operations();
  const client = createCoreClient({ baseUrl: 'http://127.0.0.1' });
  const appOperationIds = readAppOperationIds();
  const appMappings = operationCatalog
    .filter((entry) => entry.source === 'app-api')
    .map((entry) => entry.appOperationId);
  const appExclusions = operationExclusions
    .filter((entry) => entry.source === 'app-api')
    .map((entry) => entry.name);
  assert.equal(new Set(appMappings).size, appMappings.length);
  assert.equal(new Set(appExclusions).size, appExclusions.length);
  assert.ok(appMappings.every((name) => !appExclusions.includes(name)));
  assert.deepEqual(new Set([...appMappings, ...appExclusions]), new Set(appOperationIds));

  const coreMethods = Object.entries(client.core)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name);
  const coreMappings = operationCatalog
    .filter((entry) => entry.clientMethod?.startsWith('core.'))
    .map((entry) => entry.clientMethod.slice('core.'.length));
  const coreExclusions = operationExclusions
    .filter((entry) => entry.source === 'core-projection')
    .map((entry) => entry.name);
  assert.equal(new Set(coreMappings).size, coreMappings.length);
  assert.equal(new Set(coreExclusions).size, coreExclusions.length);
  assert.ok(coreMappings.every((name) => !coreExclusions.includes(name)));
  assert.deepEqual(new Set([...coreMappings, ...coreExclusions]), new Set(coreMethods));

  assert.deepEqual(operationExclusions.map(({ source, name }) => `${source}:${name}`).sort(), [
    'app-api:acceptWorkspaceInvitation',
    'app-api:createOpenKitAccessToken',
    'app-api:declineWorkspaceInvitation',
    'app-api:getNanoHostRuntimeTargetStatus',
    'app-api:getThreadDashboard',
    'app-api:getWorkspaceDashboard',
    'app-api:leaveWorkspace',
    'app-api:listMyWorkspaceInvitations',
    'app-api:rotateOpenKitAccessToken',
    'app-api:searchApp',
    'core-projection:listWorkspaces',
    'core-projection:subscribeTurnEvents',
  ]);
  assert.equal(new Set(operationCatalog.map((entry) => entry.id)).size, operationCatalog.length);
  assert.ok(!operationCatalog.some((entry) => entry.id === 'knowledge.claim-promote'));
  assert.ok(operationCatalog.some((entry) => entry.id === 'knowledge.context-prepare'));
  for (const id of [
    'knowledge.context-trace',
    'knowledge.context-materialization',
    'knowledge.context-materialize',
  ]) {
    assert.ok(!operationCatalog.some((entry) => entry.id === id));
  }
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'turn.read')?.protocolSchema,
    'TurnReadProjectionSchema'
  );
  assert.equal(operationCatalog.filter((entry) => entry.id === 'thread.items').length, 1);
  assert.deepEqual(
    operationCatalog.filter((entry) => entry.source === 'local-only').map((entry) => entry.id),
    ['credential.store', 'credential.delete']
  );
  assert.deepEqual(
    operationCatalog
      .filter((entry) => entry.id.startsWith('provider-subscription.'))
      .map((entry) => [
        entry.id,
        entry.appOperationId,
        entry.clientMethod,
        entry.mutating,
        Object.keys(entry.inputSchema.shape).sort(),
      ]),
    [
      [
        'provider-subscription.provider-list',
        'listSubscriptionProviders',
        'providerSubscriptions.listProviders',
        false,
        [],
      ],
      [
        'provider-subscription.account-list',
        'listProviderSubscriptionAccounts',
        'providerSubscriptions.listAccounts',
        false,
        ['subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-create',
        'createProviderSubscriptionAccount',
        'providerSubscriptions.createAccount',
        true,
        ['accountSlotId', 'displayName', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-update',
        'updateProviderSubscriptionAccount',
        'providerSubscriptions.updateAccount',
        true,
        ['accountSlotId', 'displayName', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-delete',
        'deleteProviderSubscriptionAccount',
        'providerSubscriptions.deleteAccount',
        true,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-status',
        'getProviderSubscriptionAccountStatus',
        'providerSubscriptions.getAccountStatus',
        false,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-login-start',
        'startProviderSubscriptionAccountLogin',
        'providerSubscriptions.startAccountLogin',
        true,
        ['accountSlotId', 'mode', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-login-cancel',
        'cancelProviderSubscriptionAccountLogin',
        'providerSubscriptions.cancelAccountLogin',
        true,
        ['accountSlotId', 'interactionId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-logout',
        'logoutProviderSubscriptionAccount',
        'providerSubscriptions.logoutAccount',
        true,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-quota',
        'getProviderSubscriptionAccountQuota',
        'providerSubscriptions.getAccountQuota',
        false,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
    ]
  );
  assert.equal(operationCatalog.filter((entry) => entry.id.startsWith('oauth.')).length, 0);

  for (const entry of operationCatalog) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    assert.ok(['app-api', 'core-projection', 'local-only'].includes(entry.source));
    assert.equal(typeof entry.group, 'string');
    assert.equal(typeof entry.summary, 'string');
    assert.equal(typeof entry.mutating, 'boolean');
    assert.equal(typeof entry.inputSchema?.safeParse, 'function');
    assert.equal(typeof entry.inputSensitivity, 'string');
    assert.equal(typeof entry.outputSensitivity, 'string');
    assert.equal(typeof entry.requiredAccess, 'string');
    assert.ok(entry.redaction);
    assert.equal(typeof entry.handler, 'function');

    if (entry.source === 'local-only') {
      assert.equal(entry.clientMethod, null);
      assert.equal(typeof entry.localReason, 'string');
    } else {
      assert.equal(typeof resolvePath(client, entry.clientMethod), 'function');
      assert.ok(
        String(entry.handler).includes(`client.${entry.clientMethod}`),
        `${entry.id} handler must invoke ${entry.clientMethod}`
      );
    }
    if (entry.source === 'app-api') {
      assert.ok(appOperationIds.includes(entry.appOperationId));
    }
    if (entry.source === 'core-projection') {
      assert.equal(typeof protocolExports.get(entry.protocolSchema)?.safeParse, 'function');
    }
  }

  for (const exclusion of operationExclusions) {
    assert.ok(exclusion.reason);
    assert.ok(exclusion.owner);
  }

  const proposalOperationIds = operationCatalog
    .filter((entry) => entry.id.startsWith('knowledge.proposal-'))
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(proposalOperationIds, [
    'knowledge.proposal-decide',
    'knowledge.proposal-draft',
    'knowledge.proposal-reverse',
  ]);
  assert.ok(!operationCatalog.some((entry) => entry.id === 'knowledge.reflect'));
  const proposalDecision = operationCatalog.find(
    (entry) => entry.id === 'knowledge.proposal-decide'
  );
  const proposalDecisionInput = {
    workspaceId: 'workspace_1',
    proposalId: 'proposal_1',
    requestId: '00000000-0000-4000-8000-000000000001',
    decision: 'accepted',
  };
  assert.deepEqual(
    Object.keys(proposalDecision.inputSchema.shape).sort(),
    Object.keys(proposalDecisionInput).sort()
  );
  assert.deepEqual(
    proposalDecision.inputSchema.parse(proposalDecisionInput),
    proposalDecisionInput
  );
  assert.equal(
    proposalDecision.inputSchema.safeParse({
      workspaceId: 'workspace_1',
      proposalId: 'proposal_1',
      decision: 'accepted',
    }).success,
    false
  );
  const [proposalReverse] = operationCatalog.filter(
    (entry) => entry.id === 'knowledge.proposal-reverse'
  );
  const proposalReverseInput = {
    workspaceId: 'workspace_1',
    proposalId: 'proposal_1',
    requestId: '00000000-0000-4000-8000-000000000002',
    reviewId: 'review_1',
    knowledgePageId: 'lessons/release-review',
    expectedContentDigest: `sha256:${'a'.repeat(64)}`,
  };
  assert.equal(proposalReverse.clientMethod, 'app.reverseKnowledgeProposal');
  assert.equal(proposalReverse.appOperationId, 'reverseKnowledgeProposal');
  assert.deepEqual(
    Object.keys(proposalReverse.inputSchema.shape).sort(),
    Object.keys(proposalReverseInput).sort()
  );
  assert.deepEqual(proposalReverse.inputSchema.parse(proposalReverseInput), proposalReverseInput);

  const idsWithAccess = (requiredAccess) =>
    operationCatalog
      .filter((entry) => entry.requiredAccess === requiredAccess)
      .map((entry) => entry.id)
      .sort();
  assert.deepEqual(
    idsWithAccess('deployment admin: implicit local actor or server-admin bearer token'),
    [
      'audit.server-list',
      'backup.create',
      'backup.verify',
      'diagnostics.app',
      'diagnostics.setup',
      'nanohost.decommission',
      'nanohost.enroll',
      'nanohost.token-issue',
      'nanohost.token-list',
      'nanohost.token-revoke',
      'nanohost.token-rotate',
      'nanohost.token-rotation-abort',
      'permission.server-list',
      'provider-subscription.account-create',
      'provider-subscription.account-delete',
      'provider-subscription.account-list',
      'provider-subscription.account-login-cancel',
      'provider-subscription.account-login-start',
      'provider-subscription.account-logout',
      'provider-subscription.account-quota',
      'provider-subscription.account-status',
      'provider-subscription.account-update',
      'provider-subscription.provider-list',
      'runtime.file-create',
      'runtime.file-list',
      'runtime.file-read',
      'runtime.file-update',
      'runtime.reload',
      'runtime.schemas',
      'runtime.validate',
      'storage.layout-report',
      'user.disable',
      'vault.bootstrap-codex-auth',
      'vault.lock',
      'vault.server-use-list',
      'vault.status',
      'vault.unlock',
      'workspace.access-recover',
      'workspace.access-recovery-read',
    ]
  );
  assert.deepEqual(idsWithAccess('server-admin bearer token in server mode'), [
    'token.list',
    'token.revoke',
  ]);
  assert.deepEqual(idsWithAccess('local credential-store access; no NanoCore actor'), [
    'credential.delete',
    'credential.store',
  ]);
  assert.deepEqual(idsWithAccess('public metadata read; no authenticated actor'), [
    'connection.meta',
  ]);
  assert.deepEqual(
    idsWithAccess('one-time server bootstrap token over HTTPS or loopback; no authenticated actor'),
    ['bootstrap.consume']
  );
  assert.ok(operationCatalog.some((entry) => entry.requiredAccess === 'authenticated user'));
});

test('the catalog projects the bearer-reachable Workspace sharing subset', async () => {
  const { operationCatalog, operationExclusions } = await operations();
  const sharingMappings = {
    'user.disable': ['disableUser', 'app.disableUser'],
    'workspace.access-recover': ['recoverWorkspaceAccess', 'app.recoverWorkspaceAccess'],
    'workspace.access-recovery-read': [
      'getWorkspaceAccessRecoveryState',
      'app.getWorkspaceAccessRecoveryState',
    ],
    'workspace.invitation-create': ['createWorkspaceInvitation', 'app.createWorkspaceInvitation'],
    'workspace.invitation-list': ['listWorkspaceInvitations', 'app.listWorkspaceInvitations'],
    'workspace.invitation-revoke': ['revokeWorkspaceInvitation', 'app.revokeWorkspaceInvitation'],
    'workspace.list': ['listAuthorizedWorkspaces', 'app.listAuthorizedWorkspaces'],
    'workspace.member-access-change': [
      'changeWorkspaceMemberAccess',
      'app.changeWorkspaceMemberAccess',
    ],
    'workspace.member-list': ['listWorkspaceMembers', 'app.listWorkspaceMembers'],
    'workspace.member-remove': ['removeWorkspaceMember', 'app.removeWorkspaceMember'],
    'workspace.ownership-transfer': [
      'transferWorkspaceOwnership',
      'app.transferWorkspaceOwnership',
    ],
  };
  assert.deepEqual(
    Object.fromEntries(
      operationCatalog
        .filter((entry) => entry.id in sharingMappings)
        .map((entry) => [entry.id, [entry.appOperationId, entry.clientMethod]])
    ),
    sharingMappings
  );
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'workspace.invitation-create')?.inputSensitivity,
    'secret stdin'
  );
  assert.deepEqual(
    operationExclusions
      .filter((entry) => entry.owner === 'docs/specs/20260715-multi_user_workspace_system.md')
      .map(({ source, name }) => `${source}:${name}`)
      .sort(),
    [
      'app-api:acceptWorkspaceInvitation',
      'app-api:declineWorkspaceInvitation',
      'app-api:leaveWorkspace',
      'app-api:listMyWorkspaceInvitations',
      'core-projection:listWorkspaces',
    ]
  );
});

test('the catalog projects the approved Artifact, Material, and Goal steering operations', async () => {
  const { operationCatalog } = await operations();
  const expectedMappings = {
    'artifact.import': 'importWorkspaceArtifact',
    'artifact.introduce': 'introduceWorkspaceArtifact',
    'artifact.review-decide': 'submitArtifactReviewDecision',
    'artifact.review-list': 'listArtifactReviews',
    'material.list': 'listWorkspaceMaterials',
    'material.create': 'createWorkspaceMaterial',
    'material.read': 'getWorkspaceMaterial',
    'material.revision-list': 'listWorkspaceMaterialRevisions',
    'material.revision-read': 'getWorkspaceMaterialRevision',
    'material.revision-save': 'saveWorkspaceMaterialRevision',
    'material.thread-read': 'getThreadMaterial',
    'material.bind': 'bindThreadMaterial',
    'material.unbind': 'unbindThreadMaterial',
    'material.exclude': 'excludeThreadMaterial',
    'material.restore': 'restoreThreadMaterial',
    'goal.steering-send': 'submitThreadGoalSteering',
    'goal.steering-follow-up': 'convertGoalSteeringToFollowUp',
    'goal.steering-cancel': 'cancelGoalSteering',
  };
  const mapped = Object.fromEntries(
    operationCatalog
      .filter((entry) => entry.id in expectedMappings)
      .map((entry) => [entry.id, entry.appOperationId])
  );

  assert.deepEqual(mapped, expectedMappings);
  const artifactReviewDecision = operationCatalog.find(
    (entry) => entry.id === 'artifact.review-decide'
  );
  assert.equal(
    artifactReviewDecision?.inputSchema.safeParse({
      workspaceId: 'ws_demo',
      artifactId: 'artifact_demo',
      artifactVersion: 1,
      requestId: 'request_review',
      decision: 'accepted',
    }).success,
    true
  );
  assert.equal(
    artifactReviewDecision?.inputSchema.safeParse({
      workspaceId: 'ws_demo',
      artifactId: 'artifact_demo',
      artifactVersion: 0,
      requestId: 'request_review',
      decision: 'accepted',
    }).success,
    false
  );
  assert.equal(
    operationCatalog
      .find((entry) => entry.id === 'goal.steering-send')
      .inputSchema.safeParse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_material',
        materialId: 'material_demo',
        revisionId: 'revision_demo',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      }).success,
    true
  );
});

test('restricted Material content operations fail before content-bearing transport', async () => {
  const { operationCatalog } = await operations();
  const contentCalls = [];
  const client = {
    app: {
      createWorkspaceMaterial() {
        contentCalls.push('create');
      },
      async getWorkspaceMaterial() {
        return { material: { sensitivity: 'restricted' } };
      },
      getWorkspaceMaterialRevision() {
        contentCalls.push('read');
      },
      saveWorkspaceMaterialRevision() {
        contentCalls.push('save');
      },
    },
  };
  const cases = [
    [
      'material.create',
      {
        workspaceId: 'ws_demo',
        requestId: 'req_create',
        title: 'Restricted notes',
        kind: 'markdown',
        sensitivity: 'restricted',
      },
    ],
    [
      'material.revision-read',
      { workspaceId: 'ws_demo', materialId: 'material_demo', revisionId: 'revision_demo' },
    ],
    [
      'material.revision-save',
      {
        workspaceId: 'ws_demo',
        materialId: 'material_demo',
        requestId: 'req_save',
        expectedRevisionId: 'revision_demo',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        content: 'Restricted notes',
      },
    ],
  ];

  for (const [id, input] of cases) {
    const operation = operationCatalog.find((entry) => entry.id === id);
    await assert.rejects(
      Promise.resolve().then(() => operation.handler({ client }, input)),
      (error) => error.status === 409 && error.code === 'sensitive_content'
    );
  }
  assert.deepEqual(contentCalls, []);
});

test('catalog search is concise and describe returns one machine-readable input contract', async () => {
  const { describeOperation, searchOperations } = await operations();
  const results = searchOperations('workspace');
  assert.ok(results.some((entry) => entry.id === 'workspace.list'));
  assert.ok(results.every((entry) => !('handler' in entry) && !('inputSchema' in entry)));
  assert.ok(searchOperations('connection').some((entry) => entry.group === 'connection'));
  assert.ok(searchOperations('durable').some((entry) => /durable/i.test(entry.summary)));
  assert.deepEqual(searchOperations('   '), []);

  const description = describeOperation('workspace.list');
  assert.equal(description.id, 'workspace.list');
  assert.equal(description.mutating, false);
  assert.equal(typeof description.summary, 'string');
  assert.equal(typeof description.inputSensitivity, 'string');
  assert.equal(typeof description.outputSensitivity, 'string');
  assert.equal(typeof description.requiredAccess, 'string');
  assert.equal(description.inputSchema.type, 'object');
  assert.ok(!('handler' in description));
});

test('the encrypted-file Vault cutover removes only the obsolete NanoCore Keychain path', () => {
  const remoteCredentialStorePath = join(repoRoot, 'skills', 'openkit-secrets.mjs');
  assert.equal(existsSync(remoteCredentialStorePath), true);
  assert.match(
    readFileSync(remoteCredentialStorePath, 'utf8'),
    /export function createDefaultOpenKitCredentialStore/
  );

  const violations = [];
  for (const path of [
    'apps/nanocore/src/vault/vault-os-keychain-backend.ts',
    'apps/nanocore/src/vault/vault-os-keychain-backend.test.ts',
  ]) {
    if (existsSync(join(repoRoot, path))) {
      violations.push(`obsolete Vault Keychain file remains: ${path}`);
    }
  }

  for (const [path, forbiddenTerms] of [
    [
      'apps/nanocore/src/app.ts',
      ['vaultOsKeychainAdapter', 'osKeychainAdapter', 'localDefaultBackend', 'os-keychain'],
    ],
    [
      'apps/nanocore/src/vault/vault-unlock-state.ts',
      [
        'vault-os-keychain-backend',
        'OsKeychainVaultAdapter',
        'CreateOsKeychainVaultUnlockStateInput',
        'osKeychainBackend',
        'os-keychain',
      ],
    ],
    ['apps/nanocore/src/index.ts', ['localDefaultBackend']],
    ['apps/nanocore/src/storage/schema/vault-references.ts', ['os-keychain']],
    ['packages/config-schema/src/server.ts', ['localDefaultBackend', 'os-keychain']],
    ['apps/nanocore/src/vault/vault-backend.ts', ['os-keychain']],
  ]) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    for (const forbiddenTerm of forbiddenTerms) {
      if (source.includes(forbiddenTerm)) {
        violations.push(`obsolete Vault term ${forbiddenTerm} remains in ${path}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('credential resolution is endpoint-scoped, fail-closed, and redacted', async (t) => {
  const {
    createDefaultOpenKitCredentialStore,
    normalizeStoredOpenKitToken,
    redactPublicValue,
    resolveCredential,
  } = await import('../skills/openkit-secrets.mjs');
  const store = {
    readToken({ baseUrl }) {
      assert.equal(baseUrl, 'http://nanocore.example');
      return 'okt_stored';
    },
  };

  assert.equal(normalizeStoredOpenKitToken('  okt_value  '), 'okt_value');
  assert.deepEqual(
    resolveCredential({
      endpoint: 'http://nanocore.example',
      env: { OPENKIT_NANOCORE_TOKEN: 'okt_environment' },
      store,
    }),
    { source: 'environment', token: 'okt_environment' }
  );
  assert.throws(
    () =>
      resolveCredential({
        endpoint: 'http://nanocore.example',
        env: { OPENKIT_NANOCORE_TOKEN: 'not-an-openkit-token' },
        store,
      }),
    (error) => error?.code === 'invalid_configuration'
  );
  assert.deepEqual(
    redactPublicValue({ path: '/Users/demo/private', token: 'okt_value' }, ['okt_value']),
    {
      path: '[redacted-local-path]',
      token: '[redacted]',
    }
  );

  const configDir = mkdtempSync(join(tmpdir(), 'openkit-credential-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  const fallback = createDefaultOpenKitCredentialStore({
    configDir,
    execFile() {
      throw new Error('keychain unavailable');
    },
    machineId: 'machine-id',
    platform: 'darwin',
    warn() {},
  });
  fallback.preflightWrite({ baseUrl: 'http://nanocore.example' });
  assert.equal(
    fallback.writeToken({ baseUrl: 'http://nanocore.example', token: 'okt_fallback' }),
    'encrypted-file'
  );
  assert.equal(fallback.readToken({ baseUrl: 'http://nanocore.example' }), 'okt_fallback');
  const credentialRoot = join(configDir, 'credentials', 'nanocore');
  const credentialFile = join(credentialRoot, listFiles(credentialRoot)[0]);
  assert.doesNotMatch(readFileSync(credentialFile, 'utf8'), /okt_fallback/);
  assert.equal(statSync(credentialRoot).mode & 0o777, 0o700);
  assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
  assert.equal(fallback.deleteToken({ baseUrl: 'http://nanocore.example' }), true);
  assert.equal(fallback.readToken({ baseUrl: 'http://nanocore.example' }), null);
});

test('credential keychains keep token material out of command arguments', async () => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');

  for (const platform of ['linux', 'win32']) {
    const calls = [];
    const store = createDefaultOpenKitCredentialStore({
      execFile(command, args, options) {
        calls.push({ args, command, options });
        return 'okt_keychain';
      },
      platform,
    });
    assert.equal(store.readToken({ baseUrl: 'http://nanocore.example' }), 'okt_keychain');
    assert.equal(
      store.writeToken({ baseUrl: 'http://nanocore.example', token: 'okt_stdin_only' }),
      'os-keychain'
    );
    const write = calls.at(-1);
    assert.doesNotMatch(JSON.stringify(write.args), /okt_stdin_only/);
    assert.equal(write.options.input, 'okt_stdin_only');
  }
});

test('the bundled CLI rejects obsolete os-keychain Vault responses', async () => {
  const result = await runCli(
    ['ops', 'call', 'vault.status', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{}',
    [
      responseModule(200, {
        backendKind: 'os-keychain',
        diagnostic: 'Obsolete backend response.',
        state: 'available',
      }),
    ]
  );

  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout).error.code, 'incompatible_contract');
});

test('the bundled CLI performs one typed call with fixed audit headers', async () => {
  const fetchStub = dataModule(`
    globalThis.fetch = async (url, options) => {
      const headers = new Headers(options.headers);
      if (url !== 'http://nanocore.example/api/app/workspaces') throw new Error('unexpected URL');
      if (options.method !== 'GET') throw new Error('unexpected method');
      if (headers.get('x-openkit-client-channel') !== 'openkit-cli') throw new Error('missing channel');
      if (headers.get('x-openkit-client-source') !== 'agent-skill') throw new Error('missing source');
      if (headers.has('authorization')) throw new Error('unexpected authorization');
      return new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  const result = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{}',
    [fetchStub]
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    command: 'ops.call',
    operation: 'workspace.list',
    requestId: JSON.parse(result.stdout).requestId,
    data: { items: [] },
  });
  assert.match(JSON.parse(result.stdout).requestId, /^[0-9a-f-]{36}$/);

  const invalid = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.invalid',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{"extra":true}'
  );
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'invalid_input');
});

test('the released Skill runs without repository sources or node_modules', async (t) => {
  const releaseRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-release-'));
  t.after(() => rmSync(releaseRoot, { force: true, recursive: true }));
  cpSync(skillRoot, releaseRoot, { recursive: true });
  const executable = join(releaseRoot, 'scripts', 'openkit');

  const search = await runCli(['ops', 'search', 'workspace'], {}, '{}', [], undefined, executable);
  assert.equal(search.code, 0);
  assert.ok(JSON.parse(search.stdout).data.some((entry) => entry.id === 'workspace.list'));
  const describe = await runCli(
    ['ops', 'describe', 'workspace.list'],
    {},
    '{}',
    [],
    undefined,
    executable
  );
  assert.equal(describe.code, 0);
  assert.equal(JSON.parse(describe.stdout).data.id, 'workspace.list');
});

test('the bundled CLI keeps discovery, typed failures, and local aborts truthful', async () => {
  const search = await runCli(['ops', 'search', 'workspace']);
  assert.equal(search.code, 0);
  assert.equal(JSON.parse(search.stdout).command, 'ops.search');
  const describe = await runCli(['ops', 'describe', 'workspace.list']);
  assert.equal(describe.code, 0);
  assert.equal(JSON.parse(describe.stdout).command, 'ops.describe');

  const rejection = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: 'okt_environment',
    },
    '{}',
    [
      responseModule(422, {
        code: 'conflict',
        details: { path: '/Users/private', token: 'okt_environment' },
        message: 'Rejected okt_environment',
        protocolVersion: '0.4.0',
        requestId: 'server_request_1',
      }),
    ]
  );
  assert.equal(rejection.code, 4);
  const rejectionEnvelope = JSON.parse(rejection.stdout);
  assert.equal(rejectionEnvelope.error.code, 'conflict');
  assert.equal(rejectionEnvelope.requestId, 'server_request_1');
  assert.doesNotMatch(`${rejection.stdout}${rejection.stderr}`, /okt_environment|\/Users\/private/);

  const masterKeyBase64 = 'master-key-value-that-must-stay-secret';
  const secretFailure = await runCli(
    ['ops', 'call', 'vault.unlock', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://secret-redaction.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    JSON.stringify({ masterKeyBase64 }),
    [
      responseModule(422, {
        code: 'vault_key_rejected',
        details: { masterKeyBase64 },
        message: `Rejected ${masterKeyBase64}`,
        protocolVersion: '0.4.0',
      }),
    ]
  );
  assert.equal(secretFailure.code, 4);
  assert.doesNotMatch(
    `${secretFailure.stdout}${secretFailure.stderr}`,
    new RegExp(masterKeyBase64)
  );

  const authFailure = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{}',
    [
      responseModule(401, {
        code: 'unauthorized',
        message: 'Authentication required.',
        protocolVersion: '0.4.0',
      }),
    ]
  );
  assert.equal(authFailure.code, 3);

  const connectionFailure = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{}',
    [dataModule("globalThis.fetch = async () => { throw new TypeError('connection failed'); };")]
  );
  assert.equal(connectionFailure.code, 3);

  const interrupted = await runCli(
    ['ops', 'call', 'workspace.list', '--input', '-'],
    {
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
      OPENKIT_NANOCORE_TOKEN: '',
    },
    '{}',
    [
      dataModule(
        "globalThis.fetch = async () => { process.stderr.write('fetch-started\\n'); return new Promise(() => {}); };"
      ),
    ],
    'fetch-started'
  );
  assert.equal(interrupted.signal, 'SIGINT');
  assert.doesNotMatch(`${interrupted.stdout}${interrupted.stderr}`, /product.{0,12}cancel/i);
});

/**
 * Imports the operation catalog under test.
 *
 * @returns {Promise<typeof import('../skills/openkit-operations.mjs')>} Catalog module.
 */
async function operations() {
  return import('../skills/openkit-operations.mjs');
}

/**
 * Lists release-artifact files relative to the Skill root.
 *
 * @param {string} root Skill root directory.
 * @returns {string[]} Sorted relative file paths.
 */
function listFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Reads every checked App API operation id.
 *
 * @returns {string[]} Checked operation ids.
 */
function readAppOperationIds() {
  const document = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'nanocore', 'openapi', 'app-api.openapi.json'), 'utf8')
  );
  return Object.values(document.paths).flatMap((path) =>
    Object.values(path)
      .map((operation) => operation?.operationId)
      .filter(Boolean)
  );
}

/**
 * Resolves a dot-separated property path.
 *
 * @param {unknown} value Root object.
 * @param {string} path Dot-separated path.
 * @returns {unknown} Resolved value.
 */
function resolvePath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

/**
 * Creates one inline ESM module URL.
 *
 * @param {string} source Module source.
 * @returns {string} Data URL.
 */
function dataModule(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/**
 * Creates an inline fetch stub returning one JSON response.
 *
 * @param {number} status HTTP status.
 * @param {unknown} body JSON response body.
 * @returns {string} Data URL.
 */
function responseModule(status, body) {
  return dataModule(
    `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, ` +
      `{ status: ${status}, headers: { 'content-type': 'application/json' } });`
  );
}

/**
 * Runs the bundled CLI and captures its process contract.
 *
 * @param {string[]} args CLI arguments.
 * @param {NodeJS.ProcessEnv} [env] Environment overrides.
 * @param {string} [input] Standard input.
 * @param {string[]} [imports] ESM modules preloaded before the CLI.
 * @param {string} [interruptOn] Stderr marker after which to send SIGINT.
 * @param {string} [executable] Bundled CLI path.
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, stderr: string, stdout: string}>} Process result.
 */
function runCli(args, env = {}, input = '{}', imports = [], interruptOn, executable = cliPath) {
  return new Promise((resolve, reject) => {
    const preloads = imports.flatMap((module) => ['--import', module]);
    const child = spawn(process.execPath, [...preloads, executable, ...args], {
      cwd: dirname(executable),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 5_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (!interrupted && interruptOn && stderr.includes(interruptOn)) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, stdout });
    });
    child.stdin.end(input);
  });
}
