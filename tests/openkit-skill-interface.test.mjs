// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as appSchemas from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import * as protocol from '@openkit/protocol';
import { z } from 'zod';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = join(repoRoot, 'skills', 'openkit-ops');
const cliPath = join(skillRoot, 'scripts', 'openkit');
const sourceCliPath = join(repoRoot, 'skills', 'openkit-cli.mjs');
const protocolExports = new Map(Object.entries(protocol));

test('App update CLI admits only exact release requests and strips retained status annotations', async () => {
  const { operationCatalog } = await operations();
  const prepare = operationCatalog.find((entry) => entry.id === 'app-update.prepare');
  const status = operationCatalog.find((entry) => entry.id === 'app-update.status');
  const source = {
    tag: 'v0.1.0',
    sourceCommit: 'a'.repeat(40),
    appDigest: `sha256:${'b'.repeat(64)}`,
  };
  const request = { source, expectedCurrentImageId: source.appDigest };
  assert.deepEqual(prepare.inputSchema.parse(request), request);
  for (const rejected of [
    { kind: 'commit', sourceCommit: source.sourceCommit },
    { ...source, kind: 'release' },
  ]) {
    assert.equal(prepare.inputSchema.safeParse({ ...request, source: rejected }).success, false);
  }
  const receipt = {
    candidateBoot: null,
    candidateImageId: null,
    completedAt: null,
    error: null,
    expectedCurrentImageId: source.appDigest,
    jobId: null,
    outcome: 'prepared',
    predicates: null,
    preparedAt: '2026-10-10T00:00:00.000Z',
    previousAppRestored: null,
    previousBoot: null,
    previousImageId: null,
    requestId: '11111111-1111-4111-8111-111111111111',
    source,
    stage: 'prepared',
    startedAt: null,
  };
  assert.deepEqual(
    status.outputSchema.parse({ ...receipt, source: { ...source, kind: 'release' } }),
    receipt
  );
  assert.equal(
    status.outputSchema.safeParse({
      ...receipt,
      source: { kind: 'commit', sourceCommit: source.sourceCommit },
    }).success,
    false
  );
});

test('App update preflight maps one strict empty-input administrator read', async () => {
  const { operationCatalog } = await operations();
  const preflight = operationCatalog.find((entry) => entry.id === 'app-update.preflight');
  assert.equal(preflight.mutating, false);
  assert.deepEqual(preflight.inputSchema.parse({}), {});
  assert.equal(
    preflight.inputSchema.safeParse({ workspaceId: 'ws_00000000-0000-762a-9808-5bd4bc2f5b3f' })
      .success,
    false
  );
  assert.equal(preflight.inputSchema.safeParse({ requestId: 'not-an-input' }).success, false);
  let captured;
  const observation = {
    observedAt: '2026-10-14T00:00:00.000Z',
    workspaceCount: 2,
    state: 'idle',
    counts: {
      runningTurns: 0,
      pendingTurns: 0,
      queuedAdmissions: 0,
      openAttempts: 0,
      closingAttempts: 0,
      inFlightCommands: 0,
    },
  };
  const result = await preflight.handler(
    {
      client: {
        operations: {
          'app-update.preflight': async (input) => {
            captured = input;
            return observation;
          },
        },
      },
    },
    {}
  );
  assert.deepEqual(captured, {});
  assert.deepEqual(result, observation);
});

test('pending request commands forward exact path identities and bodies', async () => {
  const { operationCatalog } = await operations();
  const answer = operationCatalog.find((entry) => entry.id === 'question.answer');
  const withdraw = operationCatalog.find((entry) => entry.id === 'pending-request.withdraw');
  assert.ok(answer);
  assert.ok(withdraw);
  assert.equal(answer.clientMethod, 'operations.question.answer');
  assert.equal(withdraw.clientMethod, 'operations.pending-request.withdraw');
  const scope = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000003',
  };
  const answers = { choice: ['left'] };
  const answerInput = answer.inputSchema.parse({
    ...scope,
    userInputRequestId: 'question_demo',
    answers,
  });
  const withdrawInput = withdraw.inputSchema.parse({ ...scope, pendingRequestId: 'pending_demo' });
  const calls = [];
  const response = { state: 'resolved' };
  const client = {
    operations: {
      'question.answer': async (...args) => {
        calls.push(['answer', ...args]);
        return response;
      },
      'pending-request.withdraw': async (...args) => {
        calls.push(['withdraw', ...args]);
        return response;
      },
    },

    core: {},
  };
  assert.equal(await answer.handler({ client }, answerInput), response);
  assert.equal(await withdraw.handler({ client }, withdrawInput), response);
  assert.deepEqual(calls, [
    ['answer', answerInput],
    ['withdraw', withdrawInput],
  ]);
  assert.equal(answer.inputSchema.safeParse({ ...answerInput, arbitrary: true }).success, false);
  assert.equal(
    withdraw.inputSchema.safeParse({ ...withdrawInput, arbitrary: true }).success,
    false
  );
});

test('Provider removal forwards exact file identity and revision through the existing client', async () => {
  const { operationCatalog } = await import('../skills/openkit-operations.mjs');
  const operation = operationCatalog.find((entry) => entry.id === 'runtime.file-delete');
  const input = {
    id: 'providers/exact.provider.jsonc',
    kind: 'provider',
    expectedRevision: 'exact-revision',
  };
  assert.equal(operation.appOperationId, 'runtime.file-delete');
  assert.equal(operation.mutating, true);
  assert.deepEqual(operation.inputSchema.parse(input), input);
  assert.equal(operation.inputSchema.safeParse({ ...input, force: true }).success, false);
  const calls = [];
  await operation.handler(
    {
      client: {
        operations: {
          'runtime.file-delete': async (command) => {
            calls.push(command);
          },
        },
      },
    },
    input
  );
  assert.deepEqual(calls, [input]);
});

test('native environment administration maps exact public reads and revision-bound edits', async () => {
  const { operationCatalog } = await operations();
  const read = operationCatalog.find((entry) => entry.id === 'runtime.agent-environment-read');
  const update = operationCatalog.find((entry) => entry.id === 'runtime.agent-environment-update');
  assert.ok(read);
  assert.ok(update);
  assert.equal(read.appOperationId, 'runtime.agent-environment-read');
  assert.equal(update.appOperationId, 'runtime.agent-environment-update');
  assert.equal(read.mutating, false);
  assert.equal(update.mutating, true);
  const readInput = read.inputSchema.parse({ fileId: 'agents/codex.agent.jsonc' });
  const updateInput = update.inputSchema.parse({
    ...readInput,
    expectedRevision: `sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'b'.repeat(64)}`,
    defaultsDigest: `sha256:${'c'.repeat(64)}`,
    environment: { COLOR: 'always', OPTIONAL: null },
  });
  const calls = [];
  const response = { persistedRevision: 'updated' };
  const client = {
    operations: {
      'runtime.agent-environment-read': async (...args) => {
        calls.push(['read', ...args]);
        return response;
      },
      'runtime.agent-environment-update': async (...args) => {
        calls.push(['update', ...args]);
        return response;
      },
    },
  };
  assert.equal(await read.handler({ client }, readInput), response);
  assert.equal(await update.handler({ client }, updateInput), response);
  assert.deepEqual(calls, [
    ['read', readInput],
    ['update', updateInput],
  ]);
  assert.equal(
    read.inputSchema.safeParse({
      ...readInput,
      workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580',
    }).success,
    false
  );
  assert.equal(
    update.inputSchema.safeParse({ ...updateInput, defaultsDigest: undefined }).success,
    false
  );
  assert.equal(update.inputSchema.safeParse({ ...updateInput, arbitrary: true }).success, false);
});

test('Worker environment discovery preserves admin scope and exact target routing', async () => {
  const { operationCatalog } = await operations();
  const status = operationCatalog.find((entry) => entry.id === 'worker-environment.status');
  assert.ok(status);
  assert.match(status.requiredAccess, /deployment admin.*Workspace.*source-audience/);
  const storageRef = 'wst_00000000-0000-7000-8000-000000000001';
  const input = status.inputSchema.parse({
    workspaceId: 'ws_00000000-0000-7a39-a8d3-cf329f50118b',
    storageRef,
  });
  let observed;
  const result = await status.handler(
    {
      client: {
        operations: {
          'worker-environment.status': async (...args) => {
            observed = args;
            return { inspected: true };
          },
        },
      },
    },
    input
  );
  assert.deepEqual(observed, [
    { workspaceId: 'ws_00000000-0000-7a39-a8d3-cf329f50118b', storageRef },
  ]);
  assert.deepEqual(result, { inspected: true });
  assert.equal(
    status.inputSchema.safeParse({ ...input, hostPath: '/private/other' }).success,
    false
  );
  assert.equal(status.inputSchema.safeParse({ ...input, storageRef: '../other' }).success, false);
  const administration = operationCatalog.find(
    (entry) => entry.id === 'administration.conversation-submit'
  );
  assert.ok(administration);
  assert.match(administration.requiredAccess, /deployment admin.*private Quick Chat/);
  assert.equal(
    administration.inputSchema.safeParse({
      requestId: '11111111-1111-4111-8111-111111111111',
      input: 'inspect',
      adminToken: 'supplied',
    }).success,
    false
  );
});

test('conversation.submit forwards the exact Worker storage choice on the shared request body', async () => {
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'conversation.submit');
  assert.ok(operation);
  assert.equal(operation.appOperationId, 'conversation.submit');
  assert.equal(operation.clientMethod, 'operations.conversation.submit');
  const storageRef = 'wst_00000000-0000-7000-8000-000000000001';
  const workerStorageChoice = {
    expectedRevision: 4,
    kind: 'selected',
    purpose: 'work',
    storageRef,
  };
  const input = {
    artifactRefs: [],
    input: 'Implement the focused Task Mode fix.',
    requestId: '11111111-1111-4111-8111-111111111111',
    targetRef: 'new-task-worker',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    workerStorageChoice,
  };
  assert.deepEqual(operation.inputSchema.parse(input).workerStorageChoice, workerStorageChoice);
  assert.equal(
    operation.inputSchema.safeParse({
      ...input,
      workerStorageChoice: { ...workerStorageChoice, goalId: 'goal_forged' },
    }).success,
    false
  );
  let observed;
  await operation.handler(
    {
      client: {
        operations: {
          'conversation.submit': async (...args) => {
            observed = args;
            return { outcome: 'accepted' };
          },
        },

        app: {},
      },
    },
    operation.inputSchema.parse(input)
  );
  assert.deepEqual(observed, [input]);
  const omitted = operation.inputSchema.parse({
    artifactRefs: [],
    input: 'Implement the focused Task Mode fix.',
    requestId: '11111111-1111-4111-8111-111111111111',
    targetRef: 'new-task-worker',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  assert.equal('workerStorageChoice' in omitted, false);
});

test('catalog configuration application requires exact human confirmation and forwards the shared payload', async () => {
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find(
    (entry) => entry.id === 'administration.configuration-apply'
  );
  assert.ok(operation);
  assert.match(operation.requiredAccess, /deployment admin.*exact human confirmation/);
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const input = {
    requestId: '11111111-1111-4111-8111-111111111111',
    candidate: {
      artifactId: 'ar_00000000-0000-7000-8000-000000000088',
      artifactVersion: 1,
      contentDigest,
    },
    confirmation: { action: 'administration.configuration.apply', contentDigest },
  };
  assert.equal(
    operation.inputSchema.safeParse({
      ...input,
      confirmation: { ...input.confirmation, contentDigest: `sha256:${'b'.repeat(64)}` },
    }).success,
    false
  );
  let observed;
  await operation.handler(
    {
      client: {
        operations: {
          'administration.configuration-apply': async (value) => {
            observed = value;
            return { persisted: true };
          },
        },
      },
    },
    operation.inputSchema.parse(input)
  );
  assert.deepEqual(observed, input);
});

test('Worker environment preparation and activation use the global Agent contract', async () => {
  const { operationCatalog } = await operations();
  const prepare = operationCatalog.find((entry) => entry.id === 'worker-environment.prepare');
  const recover = operationCatalog.find((entry) => entry.id === 'worker-environment.recover');
  assert.ok(recover);
  const activate = operationCatalog.find((entry) => entry.id === 'worker-environment.activate');
  assert.ok(prepare);
  assert.ok(activate);
  assert.match(
    prepare.requiredAccess,
    /deployment admin: implicit local actor or server-admin bearer token/
  );
  assert.match(
    activate.requiredAccess,
    /deployment admin: implicit local actor or server-admin bearer token/
  );

  const configuration = {
    expectedRevision: `sha256:${'c'.repeat(64)}`,
    fileId: 'agents/codex.agent.jsonc',
  };
  const target = { agentId: 'codex', kind: 'agent' };
  const requestId = '11111111-1111-4111-8111-111111111111';
  const prepareInput = prepare.inputSchema.parse({
    administrationThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
    configuration,
    declaration: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'d'.repeat(64)}` },
    replaceNow: {
      prompt: 'Continue the current work with browser support.',
      threadId: 'th_00000000-0000-7112-bb40-3c1f2ad81e88',
      workspaceId: 'ws_00000000-0000-7a39-a8d3-cf329f50118b',
    },
    requestId,
    target,
  });
  let observedPrepare;
  assert.deepEqual(
    await prepare.handler(
      {
        client: {
          operations: {
            'worker-environment.prepare': async (...args) => {
              observedPrepare = args;
              return { prepared: true };
            },
          },
        },
      },
      prepareInput
    ),
    { prepared: true }
  );
  assert.deepEqual(observedPrepare, [prepareInput]);
  assert.equal(
    prepare.inputSchema.safeParse({
      ...prepareInput,
      workspaceId: 'ws_00000000-0000-7f29-bd5e-f9ef21ea57f9',
    }).success,
    false
  );
  assert.equal(
    prepare.inputSchema.safeParse({
      ...prepareInput,
      configuration: { ...configuration, expectedRevision: 7 },
    }).success,
    false
  );
  assert.equal(
    prepare.inputSchema.safeParse({
      ...prepareInput,
      target: { agentId: 'codex', kind: 'worker-profile', profileId: 'default' },
    }).success,
    false
  );

  const recoverInput = recover.inputSchema.parse({
    administrationThreadId: 'th_00000000-0000-7517-9a5a-1c5686fe112c',
    recoverFrom: {
      artifactId: 'ar_00000000-0000-765f-9e4b-f410cda62de6',
      artifactVersion: 1,
      contentDigest: `sha256:${'e'.repeat(64)}`,
    },
    requestId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(Object.hasOwn(recoverInput, 'mode'), false);
  assert.equal(
    recover.inputSchema.safeParse({ ...recoverInput, declaration: prepareInput.declaration })
      .success,
    false
  );
  assert.equal(
    prepare.inputSchema.safeParse({
      ...recoverInput,
      recoverFrom: { ...recoverInput.recoverFrom, artifactVersion: 2 },
    }).success,
    false
  );

  const activation = {
    affectedStorage: [
      { expectedRevision: 4, storageRef: 'wst_00000000-0000-7000-8000-000000000001' },
    ],
    configuration,
    replaceNow: prepareInput.replaceNow,
    resolvedCandidate: {
      artifactId: 'ar_00000000-0000-7fd1-9bc1-cf5509dbe80c',
      artifactVersion: 1,
      contentDigest: `sha256:${'f'.repeat(64)}`,
    },
    target,
  };
  const activateInput = activate.inputSchema.parse({
    ...activation,
    confirmation: appSchemas.workerEnvironmentActivationConfirmation({
      ...activation,
      image: {
        digest: `sha256:${'d'.repeat(64)}`,
        environmentDefaults: { defaultsDigest: `sha256:${'b'.repeat(64)}` },
      },
    }),
    requestId,
  });
  let observedActivate;
  assert.deepEqual(
    await activate.handler(
      {
        client: {
          operations: {
            'worker-environment.activate': async (...args) => {
              observedActivate = args;
              return { activated: true };
            },
          },
        },
      },
      activateInput
    ),
    { activated: true }
  );
  assert.deepEqual(observedActivate, [activateInput]);
  assert.equal(
    activate.inputSchema.safeParse({
      ...activateInput,
      affectedStorage: [{ ...activateInput.affectedStorage[0], expectedRevision: 5 }],
    }).success,
    false
  );
});

test('the operations Skill includes the standalone administrator CLI and the public package is absent', () => {
  assert.equal(existsSync(join(repoRoot, 'skills', 'openkit')), false);
  assert.deepEqual(listFiles(skillRoot), [
    'SKILL.md',
    'THIRD-PARTY-NOTICES.md',
    'references/getting-started.en.md',
    'references/nanocore-data-root-config.en.md',
    'references/nanocore-deployment-modes.en.md',
    'references/nanocore-operations.en.md',
    'references/sandbox-container-tests.en.md',
    'references/using-openkit.en.md',
    'scripts/openkit',
  ]);
  assert.equal(statSync(cliPath).mode & 0o111, 0o111);
});

test('provider-subscription CLI selectors reuse the canonical family definition schemas', async () => {
  const { operationCatalog } = await operations();
  const [providerList, ...accountOperations] = operationCatalog.filter((entry) =>
    entry.id.startsWith('provider-subscription.')
  );

  assert.equal(providerList.id, 'provider-subscription.provider-list');
  assert.equal(providerList.inputSchema.shape.subscriptionProviderId, undefined);
  for (const entry of accountOperations) {
    assert.strictEqual(
      entry.inputSchema.shape.subscriptionProviderId,
      appSchemas.PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS[entry.id].inputSchema.shape
        .subscriptionProviderId,
      entry.id
    );
  }
});

test('one catalog covers the checked App API and public Core projection', async () => {
  const { operationCatalog, operationExclusions } = await operations();
  const client = createCoreClient({ baseUrl: 'http://127.0.0.1' });
  const appOperationIds = readAppOperationIds();
  assert.deepEqual(
    new Set(appOperationIds),
    new Set(Object.keys(appSchemas.OPERATION_DEFINITIONS))
  );
  assert.deepEqual(
    Object.entries(appSchemas.OPERATION_DEFINITIONS)
      .filter(([, definition]) => !appSchemas.operationMcpEligible(definition))
      .map(([id]) => id)
      .sort(),
    [
      'artifact.download',
      'artifact.import',
      'bootstrap.consume',
      'token.create',
      'token.rotate',
      'workspace.archive-download',
      'workspace.archive-import',
      'workspace.archive-import-dry-run',
    ]
  );
  for (const exclusion of operationExclusions) {
    assert.ok(exclusion.reason);
    assert.ok(exclusion.owner);
  }
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
    'core-projection:meta',
    'core-projection:subscribeTurnEvents',
  ]);
  assert.equal(new Set(operationCatalog.map((entry) => entry.id)).size, operationCatalog.length);
  assert.ok(!operationCatalog.some((entry) => entry.id === 'knowledge.claim-promote'));
  assert.ok(operationCatalog.some((entry) => entry.id === 'knowledge.context.prepare'));
  for (const id of [
    'knowledge.context-trace',
    'knowledge.context-materialization',
    'knowledge.context-materialize',
  ]) {
    assert.ok(!operationCatalog.some((entry) => entry.id === id));
  }
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'turn.read')?.outputSchema,
    appSchemas.TURN_OPERATION_DEFINITIONS['turn.read'].outputSchema
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
        'provider-subscription.provider-list',
        'operations.provider-subscription.provider-list',
        false,
        [],
      ],
      [
        'provider-subscription.account-list',
        'provider-subscription.account-list',
        'operations.provider-subscription.account-list',
        false,
        ['subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-create',
        'provider-subscription.account-create',
        'operations.provider-subscription.account-create',
        true,
        ['accountSlotId', 'displayName', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-update',
        'provider-subscription.account-update',
        'operations.provider-subscription.account-update',
        true,
        ['accountSlotId', 'displayName', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-delete',
        'provider-subscription.account-delete',
        'operations.provider-subscription.account-delete',
        true,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-status',
        'provider-subscription.account-status',
        'operations.provider-subscription.account-status',
        false,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.login-start',
        'provider-subscription.login-start',
        'operations.provider-subscription.login-start',
        true,
        ['accountSlotId', 'mode', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.login-cancel',
        'provider-subscription.login-cancel',
        'operations.provider-subscription.login-cancel',
        true,
        ['accountSlotId', 'interactionId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-logout',
        'provider-subscription.account-logout',
        'operations.provider-subscription.account-logout',
        true,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-quota',
        'provider-subscription.account-quota',
        'operations.provider-subscription.account-quota',
        false,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
      [
        'provider-subscription.account-auto-topup',
        'provider-subscription.account-auto-topup',
        'operations.provider-subscription.account-auto-topup',
        false,
        ['accountSlotId', 'subscriptionProviderId'],
      ],
    ]
  );
  assert.equal(operationCatalog.filter((entry) => entry.id.startsWith('oauth.')).length, 0);

  for (const entry of operationCatalog) {
    if (Object.hasOwn(appSchemas.OPERATION_DEFINITIONS, entry.id)) {
      assert.match(entry.id, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
    } else {
      assert.match(entry.id, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    }
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
        appSchemas.OPERATION_DEFINITIONS[entry.id]?.binding === 'json'
          ? entry.clientMethod === `operations.${entry.id}` &&
              String(entry.handler).includes('client.operations[id]')
          : String(entry.handler).includes(`client.${entry.clientMethod}`),
        `${entry.id} handler must invoke ${entry.clientMethod}`
      );
    }
    if (Object.hasOwn(appSchemas.OPERATION_DEFINITIONS, entry.id)) {
      const definition = appSchemas.OPERATION_DEFINITIONS[entry.id];
      const { destination, ...sharedShape } = entry.inputSchema.shape;
      const namedSecretSink =
        definition.returnsOneTimeSecret && !appSchemas.operationUsesBootstrapSecret(definition);
      assert.equal(
        Boolean(destination),
        namedSecretSink,
        `${entry.id} adds a local destination only for named secret delivery`
      );
      const localFields =
        definition.binding === 'streaming'
          ? [entry.id.endsWith('download') ? 'destinationPath' : 'sourcePath']
          : [];
      assert.deepEqual(
        Object.keys(sharedShape).sort(),
        [...Object.keys(definition.inputSchema.shape), ...localFields].sort(),
        `${entry.id} CLI view may add only its retained stream's local-file selector`
      );
      for (const [field, schema] of Object.entries(definition.inputSchema.shape)) {
        assert.equal(entry.inputSchema.shape[field], schema, `${entry.id} must preserve ${field}`);
      }
      assert.equal(
        entry.inputSchema.def.checks,
        appSchemas.OPERATION_DEFINITIONS[entry.id].inputSchema.def.checks,
        `${entry.id} strict CLI view must preserve shared refinements`
      );
      assert.equal(
        entry.inputSchema.def.catchall?.def.type,
        'never',
        `${entry.id} CLI view must reject unknown fields`
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

  const runtimeTarget = operationCatalog.find((entry) => entry.id === 'nanohost.runtime-target');
  assert.equal(runtimeTarget?.appOperationId, 'nanohost.runtime-target');
  assert.equal(runtimeTarget?.clientMethod, 'operations.nanohost.runtime-target');
  assert.equal(runtimeTarget?.mutating, false);
  assert.equal(runtimeTarget?.group, 'nanohost');

  assert.equal(
    operationExclusions.filter((entry) =>
      ['workspace.dashboard', 'getThreadDashboard', 'app.search'].includes(entry.name)
    ).length,
    0
  );

  const proposalOperationIds = operationCatalog
    .filter((entry) => entry.id.startsWith('knowledge.proposal.'))
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(proposalOperationIds, [
    'knowledge.proposal.decide',
    'knowledge.proposal.draft',
    'knowledge.proposal.read',
    'knowledge.proposal.reverse',
  ]);
  assert.ok(!operationCatalog.some((entry) => entry.id === 'knowledge.reflect'));
  const proposalDecision = operationCatalog.find(
    (entry) => entry.id === 'knowledge.proposal.decide'
  );
  const proposalDecisionInput = {
    workspaceId: 'ws_00000000-0000-7588-a4ef-fda698630734',
    proposalId: 'proposal_1',
    baseRevision: '1'.repeat(40),
    candidateRevision: '2'.repeat(40),
    proposalDigest: `sha256:${'b'.repeat(64)}`,
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
      workspaceId: 'ws_00000000-0000-7588-a4ef-fda698630734',
      proposalId: 'proposal_1',
      decision: 'accepted',
    }).success,
    false
  );
  const [proposalReverse] = operationCatalog.filter(
    (entry) => entry.id === 'knowledge.proposal.reverse'
  );
  const proposalReverseInput = {
    workspaceId: 'ws_00000000-0000-7588-a4ef-fda698630734',
    proposalId: 'proposal_1',
    baseRevision: '2'.repeat(40),
    requestId: '00000000-0000-4000-8000-000000000002',
    reviewId: 'kr_00000000-0000-5000-8000-000000000001',
    knowledgePageId: 'lessons/release-review',
    expectedContentDigest: `sha256:${'a'.repeat(64)}`,
    confirmRemoval: true,
  };
  assert.equal(proposalReverse.clientMethod, 'operations.knowledge.proposal.reverse');
  assert.equal(proposalReverse.appOperationId, 'knowledge.proposal.reverse');
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
      'administration.cleanup-read',
      'administration.mcp-discovery-preview',
      'administration.server-mcp-create',
      'administration.server-mcp-list',
      'administration.server-mcp-read',
      'administration.server-mcp-remove',
      'administration.server-mcp-select-version',
      'administration.server-mcp-stage-version',
      'administration.server-mcp-update-binding',
      'app-update.preflight',
      'app-update.prepare',
      'app-update.start',
      'app-update.status',
      'audit.server-list',
      'backup.create',
      'backup.verify',
      'diagnostics.app',
      'diagnostics.setup',
      'nanohost.decommission',
      'nanohost.enroll',
      'nanohost.runtime-target',
      'nanohost.token-issue',
      'nanohost.token-list',
      'nanohost.token-revoke',
      'nanohost.token-rotate',
      'nanohost.token-rotation-abort',
      'permission.server-list',
      'provider-subscription.account-auto-topup',
      'provider-subscription.account-create',
      'provider-subscription.account-delete',
      'provider-subscription.account-list',
      'provider-subscription.account-logout',
      'provider-subscription.account-quota',
      'provider-subscription.account-status',
      'provider-subscription.account-update',
      'provider-subscription.login-cancel',
      'provider-subscription.login-start',
      'provider-subscription.provider-list',
      'runtime.agent-environment-read',
      'runtime.agent-environment-update',
      'runtime.file-create',
      'runtime.file-delete',
      'runtime.file-list',
      'runtime.file-read',
      'runtime.file-update',
      'runtime.reload',
      'runtime.schemas',
      'runtime.validate',
      'storage.layout-report',
      'token.list',
      'token.revoke',
      'user.disable',
      'vault.bootstrap-codex-auth',
      'vault.lock',
      'vault.provider-api-key-set',
      'vault.server-mcp-grant-create',
      'vault.server-mcp-grant-list',
      'vault.server-mcp-grant-narrow',
      'vault.server-mcp-grant-revoke',
      'vault.server-mcp-injection-plan-list',
      'vault.server-mcp-injection-receipt-list',
      'vault.server-mcp-reference-list',
      'vault.server-mcp-secret-create',
      'vault.server-mcp-secret-revoke',
      'vault.server-mcp-secret-rotate',
      'vault.server-use-list',
      'vault.status',
      'vault.unlock',
      'worker-environment.activate',
      'worker-environment.prepare',
      'worker-environment.recover',
      'workspace.access-recover',
      'workspace.access-recovery-read',
    ]
  );
  assert.deepEqual(idsWithAccess('server-admin bearer token in server mode'), []);
  assert.deepEqual(idsWithAccess('local credential-store access; no NanoCore actor'), [
    'credential.delete',
    'credential.store',
  ]);
  assert.deepEqual(
    idsWithAccess(
      'canonical user: implicit local actor or server-admin bearer token; secret-safe local archive files'
    ),
    ['workspace.archive-download', 'workspace.archive-import', 'workspace.archive-import-dry-run']
  );
  assert.deepEqual(
    idsWithAccess('implicit local actor; bundled CLI operation is local-mode only'),
    []
  );
  assert.deepEqual(idsWithAccess('public metadata read; no authenticated actor'), []);
  assert.ok(!operationCatalog.some(({ id }) => id === 'connection.meta'));
  assert.deepEqual(
    idsWithAccess('one-time server bootstrap token over HTTPS or loopback; no authenticated actor'),
    ['bootstrap.consume']
  );
  assert.ok(operationCatalog.some((entry) => entry.requiredAccess === 'authenticated user'));
});

test('the catalog projects the bearer-reachable Workspace sharing subset', async () => {
  const { operationCatalog, operationExclusions } = await operations();
  const sharingMappings = {
    'user.disable': ['user.disable', 'operations.user.disable'],
    'workspace.access-recover': ['workspace.access-recover', 'operations.workspace.access-recover'],
    'workspace.access-recovery-read': [
      'workspace.access-recovery-read',
      'operations.workspace.access-recovery-read',
    ],
    'workspace.delete': ['workspace.delete', 'operations.workspace.delete'],
    'workspace.deleted-recover': [
      'workspace.deleted-recover',
      'operations.workspace.deleted-recover',
    ],
    'workspace.invitation-create': [
      'workspace.invitation-create',
      'operations.workspace.invitation-create',
    ],
    'workspace.invitation-list': [
      'workspace.invitation-list',
      'operations.workspace.invitation-list',
    ],
    'workspace.invitation-revoke': [
      'workspace.invitation-revoke',
      'operations.workspace.invitation-revoke',
    ],
    'workspace.list': ['workspace.list', 'operations.workspace.list'],
    'workspace.member-list': ['workspace.member-list', 'operations.workspace.member-list'],
    'workspace.member-remove': ['workspace.member-remove', 'operations.workspace.member-remove'],
    'workspace.ownership-transfer': [
      'workspace.ownership-transfer',
      'operations.workspace.ownership-transfer',
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
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'vault.provider-api-key-set')?.inputSensitivity,
    'secret stdin'
  );
  for (const id of ['vault.secret-create', 'vault.secret-rotate']) {
    assert.equal(
      operationCatalog.find((entry) => entry.id === id)?.inputSensitivity,
      'secret stdin'
    );
  }
  const providerInput = { providerId: 'provider-b6', apiKey: 'synthetic-b6-key' };
  const providerSchema = operationCatalog.find(
    (entry) => entry.id === 'vault.provider-api-key-set'
  )?.inputSchema;
  assert.deepEqual(
    providerSchema.parse(providerInput),
    appSchemas.OPERATION_DEFINITIONS['vault.provider-api-key-set'].inputSchema.parse(providerInput)
  );
  assert.deepEqual(
    Object.keys(providerSchema.shape).sort(),
    Object.keys(
      appSchemas.OPERATION_DEFINITIONS['vault.provider-api-key-set'].inputSchema.shape
    ).sort()
  );
  assert.equal(providerSchema.safeParse({ ...providerInput, arbitrary: true }).success, false);
  assert.deepEqual(
    operationExclusions
      .filter((entry) => entry.owner === 'docs/specs/20260715-multi_user_workspace_system.md')
      .map(({ source, name }) => `${source}:${name}`)
      .sort(),
    []
  );
});

test('my admin-token operations use strict canonical-user schemas and client methods', async () => {
  const { operationCatalog } = await operations();
  for (const [action, method] of [
    ['list', 'token.my-admin-list'],
    ['default', 'token.my-admin-default'],
  ]) {
    const operation = operationCatalog.find((entry) => entry.id === `token.my-admin-${action}`);
    assert.ok(operation);
    assert.equal(operation.appOperationId, method);
    assert.equal(operation.clientMethod, `operations.${method}`);
    assert.equal(operation.source, 'app-api');
    assert.equal(operation.group, 'token');
    assert.equal(operation.mutating, action === 'default');
    assert.equal(
      operation.requiredAccess,
      'canonical user: implicit local actor or server-admin bearer token'
    );
    const input = action === 'list' ? {} : { tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629' };
    for (const extra of [{ cookie: 'session' }, { authorization: 'bearer' }, { unknown: true }]) {
      assert.equal(operation.inputSchema.safeParse({ ...input, ...extra }).success, false);
    }
    if (action === 'list') {
      assert.equal(
        operation.inputSchema.safeParse({ tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629' })
          .success,
        false
      );
    } else {
      assert.deepEqual(
        Object.keys(operation.inputSchema.shape),
        Object.keys(appSchemas.SetMyAdminAccessTokenDefaultRequestSchema.shape)
      );
      assert.equal(operation.inputSchema.safeParse({}).success, false);
      assert.equal(operation.inputSchema.safeParse({ tokenId: '' }).success, false);
    }
    let observed;
    const response = { items: [], defaultTokenId: null };
    assert.equal(
      await operation.handler(
        {
          client: {
            operations: {
              [method]: async (...args) => {
                observed = args;
                return response;
              },
            },
          },
        },
        operation.inputSchema.parse(input)
      ),
      response
    );
    assert.deepEqual(observed, [input]);
  }
});

test('bundled my admin-token calls preserve typed transport and canonical auth denials', async () => {
  const response = {
    items: [
      {
        tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'server-admin',
        workspaceIds: [],
        status: 'active',
        issuedAt: '2026-09-14T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
        revokedAt: null,
        predecessorTokenId: null,
        rotatedGraceExpiresAt: null,
        lastUsedAt: null,
        lastUsedChannel: null,
        lastUsedSource: null,
      },
    ],
    defaultTokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
  };
  for (const action of ['list', 'default']) {
    const args = ['ops', 'call', `token.my-admin-${action}`, '--input', '-'];
    const input = action === 'list' ? {} : { tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629' };
    const url = `http://127.0.0.1:3456/api/app/operations/token.my-admin-${action}`;
    const method = 'POST';
    const env = { OPENKIT_NANOCORE_URL: 'http://127.0.0.1:3456', OPENKIT_NANOCORE_TOKEN: '' };
    const result = await runCli(args, env, JSON.stringify(input), [
      dataModule(`
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers);
        if (headers.has('authorization') || headers.has('cookie')) throw new Error('unexpected credential');
        if (url !== ${JSON.stringify(url)} || options.method !== '${method}') throw new Error('unexpected transport');
        if (options.body !== ${JSON.stringify(JSON.stringify(input))}) throw new Error('unexpected operation body');
        return new Response(${JSON.stringify(JSON.stringify(response))}, { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `),
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, response);
    for (const [status, code, token] of [
      [401, 'unauthorized', ''],
      [401, 'unauthorized', 'okt_not_a_session'],
      [403, 'workspace_access_denied', 'okt_not_a_session'],
    ]) {
      const denied = await runCli(
        args,
        { ...env, OPENKIT_NANOCORE_TOKEN: token },
        JSON.stringify(input),
        [
          dataModule(`
        globalThis.fetch = async (url, options) => {
          const headers = new Headers(options.headers);
          if (url !== ${JSON.stringify(url)} || options.method !== '${method}') throw new Error('unexpected transport');
          if (headers.has('cookie')) throw new Error('unexpected session');
          if (headers.get('authorization') !== ${JSON.stringify(token ? `Bearer ${token}` : null)}) throw new Error('credential changed');
          return new Response(JSON.stringify({ code: '${code}', message: 'Canonical user required.', protocolVersion: '0.4.0' }), { status: ${status}, headers: { 'content-type': 'application/json' } });
        };
      `),
        ]
      );
      assert.equal(denied.code, 3, denied.stdout);
      assert.equal(JSON.parse(denied.stdout).error.code, code);
      assert.doesNotMatch(denied.stdout + denied.stderr, /okt_not_a_session/);
    }
  }
});

test('workspace leave uses the canonical-user schema and client method', async () => {
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'workspace.leave');
  assert.ok(operation);
  assert.equal(operation.appOperationId, 'workspace.leave');
  assert.equal(operation.clientMethod, 'operations.workspace.leave');
  assert.equal(operation.group, 'workspace');
  assert.equal(operation.source, 'app-api');
  assert.equal(operation.mutating, true);
  assert.equal(
    operation.requiredAccess,
    'canonical user: implicit local actor or server-admin bearer token'
  );
  const requestId = '11111111-1111-4111-8111-111111111111';
  const input = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    expectedRevision: 1,
    requestId,
  };
  for (const extra of [
    { userId: 'other' },
    { cookie: 'session' },
    { authorization: 'bearer' },
    { unknown: true },
  ]) {
    assert.equal(operation.inputSchema.safeParse({ ...input, ...extra }).success, false);
  }
  assert.equal(
    operation.inputSchema.safeParse({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      requestId,
    }).success,
    false
  );
  assert.equal(operation.inputSchema.safeParse({ expectedRevision: 1, requestId }).success, false);
  assert.equal(operation.inputSchema.safeParse({ ...input, expectedRevision: 0 }).success, false);
  let observed;
  const response = { member: {} };
  assert.equal(
    await operation.handler(
      {
        client: {
          operations: {
            'workspace.leave': async (...args) => {
              observed = args;
              return response;
            },
          },
        },
      },
      operation.inputSchema.parse(input)
    ),
    response
  );
  assert.deepEqual(observed, [input]);
});

test('bundled workspace leave preserves typed transport, request IDs, and auth denials', async () => {
  const response = {
    member: {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      userId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      invitationId: null,
      status: 'removed',

      isOwner: false,
      revision: 2,
      joinedAt: '2026-09-14T00:00:00.000Z',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:01:00.000Z',
      removedAt: '2026-09-14T00:01:00.000Z',
    },
  };
  const args = ['ops', 'call', 'workspace.leave', '--input', '-'];
  const env = { OPENKIT_NANOCORE_URL: 'http://127.0.0.1:3456', OPENKIT_NANOCORE_TOKEN: '' };
  const requestId = '11111111-1111-4111-8111-111111111111';
  for (const supplied of [undefined, requestId]) {
    const input = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      expectedRevision: 1,
      ...(supplied ? { requestId: supplied } : {}),
    };
    const result = await runCli(args, env, JSON.stringify(input), [
      dataModule(`
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers);
        if (headers.has('authorization') || headers.has('cookie')) throw new Error('unexpected credential');
        if (url !== 'http://127.0.0.1:3456/api/app/operations/workspace.leave') throw new Error('unexpected URL');
        if (options.method !== 'POST') throw new Error('unexpected method');
        const body = JSON.parse(options.body);
        if (JSON.stringify(Object.keys(body).sort()) !== '["expectedRevision","workspaceId"]') throw new Error('unexpected body');
        if (body.expectedRevision !== 1 || !/^[0-9a-f-]{36}$/.test(headers.get('x-openkit-request-id'))) throw new Error('invalid mutation');
        if (${JSON.stringify(supplied ?? null)} !== null && headers.get('x-openkit-request-id') !== '${requestId}') throw new Error('request ID changed');
        return new Response(${JSON.stringify(JSON.stringify(response))}, { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': headers.get('x-openkit-request-id') } });
      };
    `),
    ]);
    assert.equal(result.code, 0, result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.data, response);
    assert.match(envelope.requestId, /^[0-9a-f-]{36}$/);
    if (supplied) assert.equal(envelope.requestId, supplied);
  }
  for (const [status, code, token] of [
    [401, 'unauthorized', ''],
    [401, 'unauthorized', 'okt_not_a_session'],
    [403, 'workspace_access_denied', 'okt_not_a_session'],
  ]) {
    const denied = await runCli(
      args,
      { ...env, OPENKIT_NANOCORE_TOKEN: token },
      JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        expectedRevision: 1,
        requestId,
      }),
      [
        dataModule(`
        globalThis.fetch = async (url, options) => {
          const headers = new Headers(options.headers);
          if (url !== 'http://127.0.0.1:3456/api/app/operations/workspace.leave' || options.method !== 'POST') throw new Error('unexpected transport');
          if (headers.has('cookie')) throw new Error('unexpected session');
          if (headers.get('authorization') !== ${JSON.stringify(token ? `Bearer ${token}` : null)}) throw new Error('credential changed');
          return new Response(JSON.stringify({ code: '${code}', message: 'Canonical user required.', protocolVersion: '0.4.0' }), { status: ${status}, headers: { 'content-type': 'application/json' } });
        };
      `),
      ]
    );
    assert.equal(denied.code, 3, denied.stdout);
    assert.equal(JSON.parse(denied.stdout).error.code, code);
    assert.doesNotMatch(denied.stdout + denied.stderr, /okt_not_a_session/);
  }
});

test('own invitation operations use canonical-user schemas and client methods', async () => {
  const { operationCatalog } = await operations();
  const requestId = '11111111-1111-4111-8111-111111111111';
  for (const [action, method] of [
    ['list', 'workspace.my-invitation-list'],
    ['accept', 'workspace.my-invitation-accept'],
    ['decline', 'workspace.my-invitation-decline'],
  ]) {
    const operation = operationCatalog.find(
      (entry) => entry.id === `workspace.my-invitation-${action}`
    );
    assert.ok(operation);
    assert.equal(operation.appOperationId, method);
    assert.equal(operation.clientMethod, `operations.${method}`);
    assert.match(
      operation.requiredAccess,
      /canonical user.*implicit local actor.*server-admin bearer/
    );
    assert.equal(operation.mutating, action !== 'list');
    const input =
      action === 'list'
        ? {}
        : {
            invitationId: 'inv_00000000-0000-75d6-adfc-c104d2055220',
            requestId,
            expectedRevision: 1,
          };
    for (const extra of [
      { workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' },
      { userId: 'other' },
      { cookie: 'session' },
    ]) {
      assert.equal(operation.inputSchema.safeParse({ ...input, ...extra }).success, false);
    }
    if (action !== 'list') {
      assert.equal(
        operation.inputSchema.safeParse({
          invitationId: 'inv_00000000-0000-75d6-adfc-c104d2055220',
          requestId,
        }).success,
        false
      );
      assert.equal(
        operation.inputSchema.safeParse({ ...input, expectedRevision: 0 }).success,
        false
      );
    }
    let observed;
    const response = { items: [] };
    assert.equal(
      await operation.handler(
        {
          client: {
            operations: {
              [method]: async (...args) => {
                observed = args;
                return response;
              },
            },
          },
        },
        operation.inputSchema.parse(input)
      ),
      response
    );
    assert.deepEqual(observed, [input]);
  }
});

test('bundled own invitation calls preserve typed transport and canonical auth denials', async () => {
  for (const action of ['list', 'accept', 'decline']) {
    const invitation = {
      invitationId: 'inv_00000000-0000-75d6-adfc-c104d2055220',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      inviteeUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',

      inviterUserId: 'usr_00000000-0000-7000-8000-000000000088',
      revision: 2,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      expiresAt: '2026-09-21T00:00:00.000Z',
      effectiveStatus: action === 'accept' ? 'accepted' : 'declined',
      acceptedAt: action === 'accept' ? '2026-09-14T00:00:00.000Z' : null,
      declinedAt: action === 'decline' ? '2026-09-14T00:00:00.000Z' : null,
      revokedAt: null,
    };
    const response = action === 'list' ? { items: [] } : { invitation };
    const input =
      action === 'list'
        ? {}
        : { invitationId: 'inv_00000000-0000-75d6-adfc-c104d2055220', expectedRevision: 1 };
    const args = ['ops', 'call', `workspace.my-invitation-${action}`, '--input', '-'];
    const env = { OPENKIT_NANOCORE_URL: 'http://127.0.0.1:3456', OPENKIT_NANOCORE_TOKEN: '' };
    const result = await runCli(args, env, JSON.stringify(input), [
      dataModule(`
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers);
        if (headers.has('authorization') || headers.has('cookie')) throw new Error('unexpected credential');
        if (url !== 'http://127.0.0.1:3456/api/app/operations/workspace.my-invitation-${action}') throw new Error('unexpected URL');
        if (options.method !== 'POST') throw new Error('unexpected method');
        if ('${action}' !== 'list') {
          const body = JSON.parse(options.body);
          if (JSON.stringify(Object.keys(body).sort()) !== '["expectedRevision","invitationId"]') throw new Error('unexpected body');
          if (body.expectedRevision !== 1 || !/^[0-9a-f-]{36}$/.test(headers.get('x-openkit-request-id'))) throw new Error('invalid mutation');
        }
        return new Response(${JSON.stringify(JSON.stringify(response))}, { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `),
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, response);
    for (const [status, code, token] of [
      [401, 'unauthorized', ''],
      [403, 'workspace_access_denied', 'okt_not_a_session'],
    ]) {
      const denied = await runCli(
        args,
        { ...env, OPENKIT_NANOCORE_TOKEN: token },
        JSON.stringify(input),
        [
          dataModule(`
        globalThis.fetch = async (url, options) => {
          const headers = new Headers(options.headers);
          if (headers.has('cookie')) throw new Error('unexpected session');
          if (headers.get('authorization') !== ${JSON.stringify(token ? `Bearer ${token}` : null)}) throw new Error('credential changed');
          return new Response(JSON.stringify({ code: '${code}', message: 'Canonical user required.', protocolVersion: '0.4.0' }), { status: ${status}, headers: { 'content-type': 'application/json' } });
        };
      `),
        ]
      );
      assert.equal(denied.code, 3, denied.stdout);
      assert.equal(JSON.parse(denied.stdout).error.code, code);
      assert.doesNotMatch(denied.stdout + denied.stderr, /okt_not_a_session/);
    }
  }
});

test('the catalog projects the approved Artifact, Material, and Goal steering operations', async () => {
  const { operationCatalog } = await operations();
  const expectedMappings = {
    'artifact.import': 'artifact.import',
    'artifact.download': 'artifact.download',
    'artifact.introduce': 'artifact.introduce',
    'artifact.review.decide': 'artifact.review.decide',
    'artifact.review-list': 'artifact.review-list',
    'material.list': 'material.list',
    'material.create': 'material.create',
    'material.read': 'material.read',
    'material.revision-list': 'material.revision-list',
    'material.revision-read': 'material.revision-read',
    'material.revision-save': 'material.revision-save',
    'material.thread-read': 'material.thread-read',
    'material.bind': 'material.bind',
    'material.unbind': 'material.unbind',
    'material.exclude': 'material.exclude',
    'material.restore': 'material.restore',
  };
  const mapped = Object.fromEntries(
    operationCatalog
      .filter((entry) => entry.id in expectedMappings)
      .map((entry) => [entry.id, entry.appOperationId])
  );

  assert.deepEqual(mapped, expectedMappings);
  const artifactReviewDecision = operationCatalog.find(
    (entry) => entry.id === 'artifact.review.decide'
  );
  assert.equal(
    artifactReviewDecision?.inputSchema.safeParse({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      artifactVersion: 1,
      requestId: 'request_review',
      decision: 'accepted',
    }).success,
    true
  );
  assert.equal(
    artifactReviewDecision?.inputSchema.safeParse({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      artifactVersion: 0,
      requestId: 'request_review',
      decision: 'accepted',
    }).success,
    false
  );
});

test('restricted Material content operations fail before content-bearing transport', async () => {
  const { operationCatalog } = await operations();
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'material.revision-save').inputSensitivity,
    'workspace content'
  );
  assert.equal(
    operationCatalog.find((entry) => entry.id === 'material.revision-read').outputSensitivity,
    'workspace content'
  );
  const contentCalls = [];
  const metadataCalls = [];
  const client = {
    operations: {
      'material.create'() {
        contentCalls.push('create');
      },
      async 'material.read'(input) {
        metadataCalls.push(input);
        return { material: { sensitivity: 'restricted' } };
      },
      'material.revision-read'() {
        contentCalls.push('read');
      },
      'material.revision-save'() {
        contentCalls.push('save');
      },
    },
  };
  const cases = [
    [
      'material.create',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId: 'req_create',
        title: 'Restricted notes',
        kind: 'markdown',
        sensitivity: 'restricted',
      },
    ],
    [
      'material.revision-read',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        revisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
      },
    ],
    [
      'material.revision-save',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        requestId: 'req_save',
        expectedRevisionId: 'mrev_00000000-0000-7444-8d8f-e35a7aaa68ab',
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
  assert.deepEqual(
    metadataCalls,
    Array(2).fill({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
    })
  );
});

test('credential.store accepts one token or one complete recovery envelope and stores only token', async () => {
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'credential.store');
  const token = `okt_${'a'.repeat(43)}`;
  const envelope = {
    kind: 'openkit-admin-recovery',
    requestId: '07a6f7d1-7375-5cf7-8705-270d269c22c9',
    tokenId: 'tok_019957ff-2000-5000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    expiresAt: '2026-09-02T12:00:00.000Z',
    token,
  };

  assert.equal(operation.inputSchema.safeParse({ token }).success, true);
  assert.equal(operation.inputSchema.safeParse(envelope).success, true);
  assert.equal(operation.inputSchema.safeParse({ ...envelope, tokenId: undefined }).success, false);
  assert.equal(operation.inputSchema.safeParse({ ...envelope, extra: true }).success, false);

  const writes = [];
  const result = operation.handler(
    {
      credentialStore: {
        writeToken(input) {
          writes.push(input);
          return 'encrypted-file';
        },
      },
      endpoint: 'https://openkit.example.test',
    },
    envelope
  );
  assert.deepEqual(writes, [{ baseUrl: 'https://openkit.example.test', token }]);
  assert.deepEqual(result, { credentialStorageBackend: 'encrypted-file' });
  assert.doesNotMatch(JSON.stringify(result), /requestId|tokenId|ownerUserId|expiresAt|okt_/u);
});

test('catalog search is concise and describe returns one machine-readable input contract', async () => {
  const { describeOperation, searchOperations } = await operations();
  const results = searchOperations('workspace');
  assert.ok(results.some((entry) => entry.id === 'workspace.list'));
  assert.ok(results.every((entry) => Object.keys(entry).sort().join(',') === 'id,summary'));
  assert.equal(
    searchOperations('connection').some((entry) => entry.id === 'connection.meta'),
    false
  );
  assert.ok(searchOperations('diagnostics').some((entry) => entry.id === 'diagnostics.app'));
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

for (const [label, executable] of [
  ['source', sourceCliPath],
  ['bundled', cliPath],
]) {
  for (const args of [
    ['--help'],
    ['help'],
    ['help', 'doctor'],
    ['help', 'ops'],
    ['help', 'ops', 'search'],
    ['help', 'ops', 'describe'],
    ['help', 'ops', 'call'],
    ['doctor', '--help'],
    ['ops', '--help'],
    ['ops', 'search', '--help'],
    ['ops', 'describe', '--help'],
    ['ops', 'call', '--help'],
  ]) {
    test(`${label} CLI local help succeeds without endpoint, credentials or network: ${args.join(' ')}`, async () => {
      const result = await runCli(
        args,
        {
          OPENKIT_NANOCORE_URL: 'invalid endpoint that help must not resolve',
          OPENKIT_NANOCORE_TOKEN: 'invalid credential that help must not resolve',
        },
        'not JSON; help must not read stdin',
        [
          dataModule(
            "globalThis.fetch = async () => { process.stderr.write('help-network-attempt\\n'); throw new Error('help made a network request'); };"
          ),
        ],
        undefined,
        executable
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.command, 'help');
      assert.equal(Object.hasOwn(envelope, 'operation'), false);
      assert.equal(Object.hasOwn(envelope, 'requestId'), false);
      assert.equal(result.stderr, '');
      const topic = (args[0] === 'help' ? args.slice(1) : args.slice(0, -1)).join(' ');
      if (topic) assert.ok(JSON.stringify(envelope.data).includes(topic));
      if (args.length === 1) {
        const help = JSON.stringify(envelope.data);
        for (const command of ['doctor', 'ops search', 'ops describe', 'ops call', '--input -'])
          assert.ok(help.includes(command), `Help must show ${command}.`);
        for (const operation of ['app-update.preflight', 'app-update.prepare', 'app-update.start'])
          assert.ok(help.includes(operation), `Help must show the update sequence's ${operation}.`);
      }
    });
  }

  test(`${label} CLI compact discovery keeps concise search and shallow input constraints`, async () => {
    const search = await runCli(
      ['ops', 'search', 'workspace'],
      {},
      '{}',
      [],
      undefined,
      executable
    );
    assert.equal(search.code, 0, search.stdout + search.stderr);
    const results = JSON.parse(search.stdout).data;
    assert.ok(results.some((entry) => entry.id === 'workspace.list'));
    for (const entry of results) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'summary']);
      assert.equal(typeof entry.summary, 'string');
      assert.doesNotMatch(entry.summary, /[\r\n]/);
    }
    const descriptions = new Map();
    for (const id of ['runtime.file-create', 'knowledge.answer', 'runtime.validate']) {
      const result = await runCli(['ops', 'describe', id], {}, '{}', [], undefined, executable);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.command, 'ops.describe');
      assert.equal(envelope.data.id, id);
      for (const field of ['summary', 'inputSensitivity', 'outputSensitivity', 'requiredAccess'])
        assert.equal(typeof envelope.data[field], 'string', `${id}.${field}`);
      assert.equal(envelope.data.summary, appSchemas.OPERATION_DEFINITIONS[id].description);
      assert.equal(envelope.data.mutating, appSchemas.OPERATION_DEFINITIONS[id].mutating);
      assert.ok(envelope.data.requiredAccess.trim().length > 0);
      assert.equal(Object.hasOwn(envelope.data, 'outputSchema'), false);
      assert.equal(envelope.data.inputSchema.type, 'object');
      for (const property of Object.values(envelope.data.inputSchema.properties)) {
        for (const nested of ['properties', 'required', 'items', '$defs', 'definitions'])
          assert.equal(Object.hasOwn(property, nested), false, `${id} expands ${nested}.`);
      }
      descriptions.set(id, envelope.data.inputSchema);
    }
    const create = descriptions.get('runtime.file-create');
    assert.deepEqual([...create.required].sort(), ['id', 'kind']);
    assert.equal(create.properties.id.type, 'string');
    assert.equal(create.properties.id.minLength, 1);
    assert.equal(create.properties.content.type, 'string');
    assert.equal(create.properties.kind.type, 'string');
    assert.deepEqual(create.properties.kind.enum, [
      'server',
      'gateway',
      'model-catalog',
      'internal-role',
      'provider',
      'agent',
      'user',
      'workspace',
      'data-source',
    ]);
    const answer = descriptions.get('knowledge.answer');
    assert.deepEqual([...answer.required].sort(), ['query', 'workspaceId']);
    assert.equal(answer.properties.query.minLength, 1);
    assert.equal(answer.properties.limit.type, 'integer');
    assert.equal(answer.properties.limit.maximum, 10);
    assert.ok(
      answer.properties.limit.minimum === 1 || answer.properties.limit.exclusiveMinimum === 0,
      'The optional integer limit must remain positive.'
    );
    const validation = descriptions.get('runtime.validate');
    assert.equal(validation.properties.files.type, 'array');
    assert.equal(validation.required?.includes('files') ?? false, false);
  });

  test(`${label} CLI full-schema opt-in returns shared JSON schemas without Zod state`, async () => {
    const id = 'runtime.validate';
    const definition = appSchemas.OPERATION_DEFINITIONS[id];
    const expectedInput = z.toJSONSchema(definition.inputSchema.strict(), {
      target: 'draft-7',
      io: 'input',
    });
    const expectedOutput = z.toJSONSchema(definition.outputSchema, { target: 'draft-7' });
    const described = await runCli(
      ['ops', 'describe', id, '--schema'],
      {},
      '{}',
      [],
      undefined,
      executable
    );
    assert.equal(described.code, 0, described.stdout + described.stderr);
    const description = JSON.parse(described.stdout).data;
    assert.deepEqual(description.inputSchema, expectedInput);
    assert.ok(description.inputSchema.properties.files.items.properties.content);
    const searched = await runCli(
      ['ops', 'search', id, '--schema'],
      {},
      '{}',
      [],
      undefined,
      executable
    );
    assert.equal(searched.code, 0, searched.stdout + searched.stderr);
    const entry = JSON.parse(searched.stdout).data.find((candidate) => candidate.id === id);
    assert.ok(entry, 'Schema search must retain the matching canonical operation.');
    assert.deepEqual(entry.inputSchema, expectedInput);
    assert.deepEqual(entry.outputSchema, expectedOutput);
  });

  test(`${label} CLI compact discovery preserves both flat credential input alternatives`, async () => {
    const id = 'credential.store';
    const result = await runCli(['ops', 'describe', id], {}, '{}', [], undefined, executable);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const compact = JSON.parse(result.stdout).data.inputSchema;
    const variants = compact.anyOf ?? compact.oneOf;
    assert.equal(variants?.length, 2);
    const required = variants.map((variant) => [...(variant.required ?? [])].sort());
    assert.deepEqual(
      required.sort((left, right) => left.length - right.length),
      [['token'], ['expiresAt', 'kind', 'ownerUserId', 'requestId', 'token', 'tokenId']]
    );
    for (const variant of variants) {
      assert.equal(variant.type, 'object');
      assert.equal(variant.additionalProperties, false);
      assert.equal(variant.properties.token.type, 'string');
      assert.equal(variant.properties.token.pattern, '^okt_[A-Za-z0-9_-]+$');
      for (const property of Object.values(variant.properties)) {
        for (const nested of ['properties', 'required', 'items', '$defs', 'definitions'])
          assert.equal(Object.hasOwn(property, nested), false);
      }
    }
    const recovery = variants.find((variant) => variant.properties.kind);
    assert.equal(recovery.properties.kind.const, 'openkit-admin-recovery');
    assert.equal(recovery.properties.requestId.type, 'string');
    assert.equal(recovery.properties.requestId.format, 'uuid');
    assert.equal(
      new RegExp(recovery.properties.tokenId.pattern).test(
        'tok_019957ff-2000-5000-8000-000000000001'
      ),
      true
    );
    assert.equal(
      new RegExp(recovery.properties.tokenId.pattern).test('019957ff-2000-5000-8000-000000000001'),
      false
    );
    assert.equal(
      new RegExp(recovery.properties.ownerUserId.pattern).test(
        'usr_00000000-0000-7000-8000-000000000001'
      ),
      true
    );
    assert.equal(new RegExp(recovery.properties.ownerUserId.pattern).test('user_active'), false);
    assert.equal(recovery.properties.expiresAt.format, 'date-time');

    const { operationCatalog } = await operations();
    const credential = operationCatalog.find((entry) => entry.id === id);
    const full = await runCli(
      ['ops', 'describe', id, '--schema'],
      {},
      '{}',
      [],
      undefined,
      executable
    );
    assert.equal(full.code, 0, full.stdout + full.stderr);
    assert.deepEqual(
      JSON.parse(full.stdout).data.inputSchema,
      z.toJSONSchema(credential.inputSchema, { target: 'draft-7', io: 'input' })
    );
    assert.equal(credential.inputSchema.safeParse({ token: 'okt_fixture' }).success, true);
    assert.equal(
      credential.inputSchema.safeParse({ token: 'okt_fixture', body: {} }).success,
      false
    );
    assert.equal(
      credential.inputSchema.safeParse({ body: { token: 'okt_fixture' } }).success,
      false
    );
  });

  test(`${label} CLI discovers and invokes the canonical caller read with exact optional scope`, async () => {
    for (const query of ['whoami', 'caller identity']) {
      const result = await runCli(['ops', 'search', query], {}, '{}', [], undefined, executable);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(JSON.parse(result.stdout).data.some((entry) => entry.id === 'caller.read'));
    }
    for (const input of [{}, { workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9' }]) {
      const data = {
        userId: 'usr_00000000-0000-796a-8487-52dc9d36188f',
        credential: { kind: 'token', scope: 'server-admin' },
        ...(input.workspaceId
          ? {
              workspace: {
                workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
                ownerUserId: 'usr_00000000-0000-796a-8487-52dc9d36188f',
                membershipStatus: null,
                accessCause: 'administrator',
                observedAt: '2026-10-15T00:00:00.000Z',
                counts: { threads: 1, turns: 2, items: 3, artifacts: 4 },
              },
            }
          : {}),
      };
      const result = await runCli(
        ['ops', 'call', 'caller.read', '--input', '-'],
        {
          OPENKIT_NANOCORE_URL: 'http://caller.test',
          OPENKIT_NANOCORE_TOKEN: 'okt_caller_fixture',
        },
        JSON.stringify(input),
        [
          dataModule(`
          globalThis.fetch = async (url, options) => {
            if (url !== 'http://caller.test/api/app/operations/caller.read' || options.method !== 'POST') throw new Error('Noncanonical caller route');
            if (JSON.stringify(JSON.parse(options.body)) !== ${JSON.stringify(JSON.stringify(input))}) throw new Error('Changed caller selection');
            if (new Headers(options.headers).get('authorization') !== 'Bearer okt_caller_fixture') throw new Error('Missing caller credential');
            return new Response(${JSON.stringify(JSON.stringify(data))}, { headers: { 'content-type': 'application/json' } });
          };
        `),
        ],
        undefined,
        executable
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.command, 'ops.call');
      assert.equal(envelope.operation, 'caller.read');
      assert.deepEqual(envelope.data, data);
      assert.doesNotMatch(result.stdout + result.stderr, /okt_caller_fixture/);
    }
    const rejected = await runCli(
      ['ops', 'call', 'caller.read', '--input', '-'],
      {},
      '{"userId":"usr_00000000-0000-73d4-904a-d4c4b905df7c"}',
      [
        dataModule(
          "globalThis.fetch = async () => { process.stderr.write('caller-invalid-input-network\\n'); throw new Error('Invalid caller input reached network'); };"
        ),
      ],
      undefined,
      executable
    );
    assert.equal(rejected.code, 2);
    assert.equal(JSON.parse(rejected.stdout).error.code, 'invalid_input');
    assert.doesNotMatch(rejected.stderr, /caller-invalid-input-network/);
  });

  test(`${label} CLI bounded discovery aliases retain canonical operation identities`, async () => {
    for (const [query, expected] of [
      [
        'update',
        ['app-update.preflight', 'app-update.prepare', 'app-update.start', 'app-update.status'],
      ],
      ['preflight', ['app-update.preflight']],
      ['connection', ['diagnostics.app']],
      ['version', ['diagnostics.app']],
    ]) {
      const result = await runCli(['ops', 'search', query], {}, '{}', [], undefined, executable);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const entries = JSON.parse(result.stdout).data;
      for (const id of expected)
        assert.ok(
          entries.some((entry) => entry.id === id),
          `${query} must discover ${id}.`
        );
      for (const entry of entries) {
        assert.ok(Object.hasOwn(appSchemas.OPERATION_DEFINITIONS, entry.id));
        assert.deepEqual(Object.keys(entry).sort(), ['id', 'summary']);
      }
    }
    const aliasCall = await runCli(
      ['ops', 'call', 'update', '--input', '-'],
      {},
      '{}',
      [],
      undefined,
      executable
    );
    assert.equal(aliasCall.code, 2);
    assert.equal(JSON.parse(aliasCall.stdout).error.code, 'operation_not_found');
  });
}

test('Artifact CLI transfers import and download originals through the bundled command', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-cli-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = JSON.parse(
    readFileSync(join(repoRoot, 'tests/fixtures/large-context/cases.json'), 'utf8')
  ).originals.find((entry) => entry.id === 'binary-invalid-utf8');
  const bytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
  const sourcePath = join(root, 'source.bin');
  const destinationPath = join(root, 'original.bin');
  writeFileSync(sourcePath, bytes);
  const workspaceId = protocol.allocateEntityId('ws');
  const artifactId = protocol.allocateEntityId('ar');
  const env = {
    OPENKIT_NANOCORE_URL: 'http://127.0.0.1:3456',
    OPENKIT_NANOCORE_TOKEN: 'okt_artifact_fixture',
  };
  const fetchModule = dataModule(`
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url);
      const headers = new Headers(options.headers);
      if (headers.get('authorization') !== 'Bearer okt_artifact_fixture') throw new Error('missing credential');
      if (parsed.searchParams.has('sourcePath') || parsed.searchParams.has('destinationPath')) throw new Error('local path leaked');
      if (parsed.pathname === '/api/app/operations/artifact.import') {
        if (options.method !== 'POST') throw new Error('unexpected upload method');
        if (headers.get('x-openkit-request-id') !== 'cli-raw-import') throw new Error('request identity changed');
        const body = Buffer.from(await new Response(options.body).arrayBuffer());
        if (!body.equals(Buffer.from('${bytes.toString('hex')}', 'hex'))) throw new Error('original changed');
        return Response.json({ artifactId: '${artifactId}', artifactVersion: 1 }, { status: 201 });
      }
      if (parsed.pathname !== '/api/app/operations/artifact.download' || options.method !== 'GET') throw new Error('unexpected download');
      if (parsed.searchParams.get('artifactVersion') !== '1' || parsed.searchParams.has('requestId')) throw new Error('selector changed');
      return new Response(Buffer.from('${bytes.toString('hex')}', 'hex'), { headers: { 'content-type': 'application/octet-stream', 'content-length': '${original.size}', 'x-openkit-content-digest': '${original.sha256}' } });
    };
  `);
  const uploaded = await runCli(
    ['ops', 'call', 'artifact.import', '--input', '-'],
    env,
    JSON.stringify({
      workspaceId,
      requestId: 'cli-raw-import',
      title: 'Original',
      mediaType: 'application/octet-stream',
      byteLength: original.size,
      contentDigest: original.sha256,
      sourcePath,
    }),
    [fetchModule]
  );
  assert.equal(uploaded.code, 0, uploaded.stdout + uploaded.stderr);
  assert.deepEqual(JSON.parse(uploaded.stdout).data, { artifactId, artifactVersion: 1 });
  const downloaded = await runCli(
    ['ops', 'call', 'artifact.download', '--input', '-'],
    env,
    JSON.stringify({
      workspaceId,
      artifactId,
      artifactVersion: 1,
      destinationPath,
    }),
    [fetchModule]
  );
  assert.equal(downloaded.code, 0, downloaded.stdout + downloaded.stderr);
  assert.deepEqual(JSON.parse(downloaded.stdout).data, { downloaded: true });
  assert.deepEqual(readFileSync(destinationPath), bytes);
  assert.equal(statSync(destinationPath).mode & 0o777, 0o600);
  assert.doesNotMatch(
    uploaded.stdout + downloaded.stdout + uploaded.stderr + downloaded.stderr,
    /okt_artifact_fixture/
  );
});

test('Artifact version CLI publication sends exact local bytes through the existing file client', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-skill-artifact-version-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const sourcePath = join(root, 'replacement.bin');
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(sourcePath, bytes);
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'artifact.version-file-commit');
  assert.ok(operation, 'the streaming version operation needs its CLI file binding');
  assert.equal(operation.clientMethod, 'artifactFiles.commitVersion');
  const input = {
    workspaceId: protocol.allocateEntityId('ws'),
    artifactId: protocol.allocateEntityId('ar'),
    threadId: protocol.allocateEntityId('th'),
    expectedArtifactVersion: 1,
    requestId: 'artifact-cli-next-version',
    title: 'Exact replacement',
    summary: null,
    mediaType: 'application/octet-stream',
    byteLength: bytes.length,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const calls = [];
  const client = {
    artifactFiles: {
      async commitVersion(metadata, body) {
        calls.push({ metadata, bytes: Buffer.from(await new Response(body).arrayBuffer()) });
        return { committed: true };
      },
    },
  };
  assert.deepEqual(
    await operation.handler({ client }, operation.inputSchema.parse({ ...input, sourcePath })),
    { committed: true }
  );
  assert.deepEqual(calls, [{ metadata: input, bytes }]);
});

test('Artifact CLI transfers use file bindings, exact bytes, and exclusive local destinations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-skill-artifact-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const original = JSON.parse(
    readFileSync(join(repoRoot, 'tests/fixtures/large-context/cases.json'), 'utf8')
  ).originals.find((entry) => entry.id === 'binary-invalid-utf8');
  const bytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
  const sourcePath = join(root, 'source.bin');
  const destinationPath = join(root, 'download.bin');
  writeFileSync(sourcePath, bytes);
  const { operationCatalog } = await operations();
  const upload = operationCatalog.find((entry) => entry.id === 'artifact.import');
  const download = operationCatalog.find((entry) => entry.id === 'artifact.download');
  assert.equal(upload.clientMethod, 'artifactFiles.import');
  assert.equal(download.clientMethod, 'artifactFiles.download');
  assert.equal(download.mutating, true, 'writing the destination is a local mutation');
  const workspaceId = protocol.allocateEntityId('ws');
  const artifactId = protocol.allocateEntityId('ar');
  const metadata = {
    workspaceId,
    requestId: 'artifact-cli-import',
    title: 'Exact binary',
    mediaType: 'application/octet-stream',
    byteLength: original.size,
    contentDigest: original.sha256,
  };
  const selector = { workspaceId, artifactId, artifactVersion: 1 };
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (url.pathname === '/api/app/operations/artifact.import') {
        assert.equal(init.method, 'POST');
        assert.equal(headers.get('x-openkit-request-id'), metadata.requestId);
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          workspaceId: metadata.workspaceId,
          title: metadata.title,
          mediaType: metadata.mediaType,
          byteLength: String(original.size),
          contentDigest: original.sha256,
        });
        assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), bytes);
        return Response.json(
          { artifactId: selector.artifactId, artifactVersion: 1 },
          { status: 201 }
        );
      }
      assert.equal(url.pathname, '/api/app/operations/artifact.download');
      assert.equal(init.method, 'GET');
      assert.deepEqual(Object.fromEntries(url.searchParams), { ...selector, artifactVersion: '1' });
      return new Response(bytes, {
        headers: {
          'content-length': String(original.size),
          'content-type': 'application/octet-stream',
          'x-openkit-content-digest': original.sha256,
        },
      });
    },
  });
  assert.equal(Object.hasOwn(client.operations, 'artifact.import'), false);
  assert.equal(Object.hasOwn(client.operations, 'artifact.download'), false);
  assert.deepEqual(
    await upload.handler({ client }, upload.inputSchema.parse({ ...metadata, sourcePath })),
    { artifactId, artifactVersion: 1 }
  );
  assert.deepEqual(
    await download.handler(
      { client },
      download.inputSchema.parse({ ...selector, destinationPath })
    ),
    { downloaded: true }
  );
  assert.deepEqual(readFileSync(destinationPath), bytes);
  assert.equal(statSync(destinationPath).mode & 0o777, 0o600);
  await assert.rejects(
    download.handler({ client }, { ...selector, destinationPath }),
    (error) => error.code === 'artifact_destination_exists'
  );
  assert.deepEqual(readFileSync(destinationPath), bytes);
  const linkedSource = join(root, 'source-link');
  symlinkSync(sourcePath, linkedSource);
  for (const path of [linkedSource, root]) {
    await assert.rejects(
      async () => upload.handler({ client }, { ...metadata, sourcePath: path }),
      (error) => error.code === 'invalid_artifact_source'
    );
  }
  const linkedDestination = join(root, 'download-link');
  symlinkSync(sourcePath, linkedDestination);
  await assert.rejects(
    download.handler({ client }, { ...selector, destinationPath: linkedDestination }),
    (error) => error.code === 'artifact_destination_exists'
  );
  assert.deepEqual(readFileSync(sourcePath), bytes);
  for (const failure of ['digest', 'length', 'stream']) {
    const path = join(root, `${failure}.bin`);
    const failedClient = {
      artifactFiles: {
        async download() {
          return {
            body:
              failure === 'stream'
                ? new ReadableStream({
                    start(controller) {
                      controller.error(new Error('Fixture interrupted stream.'));
                    },
                  })
                : new Response(bytes).body,
            byteLength: failure === 'length' ? bytes.length + 1 : bytes.length,
            contentDigest: failure === 'digest' ? `sha256:${'0'.repeat(64)}` : original.sha256,
            mediaType: 'application/octet-stream',
          };
        },
      },
    };
    await assert.rejects(
      download.handler({ client: failedClient }, { ...selector, destinationPath: path }),
      (error) => error.code === 'artifact_download_failed'
    );
    // The exclusive destination may retain partial bytes after a failed transfer. It is never an accepted download.
    if (existsSync(path)) assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('portable archive operations stream bytes and refuse local path replacement', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-skill-archive-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bytes = Buffer.from([40, 181, 47, 253]);
  const destinationPath = join(root, 'workspace.openkit-workspace.tar.zst');
  const sourcePath = join(root, 'source.openkit-workspace.tar.zst');
  const linkedSourcePath = join(root, 'linked.openkit-workspace.tar.zst');
  const uploads = [];
  const { operationCatalog } = await operations();
  const download = operationCatalog.find((entry) => entry.id === 'workspace.archive-download');
  const dryRun = operationCatalog.find((entry) => entry.id === 'workspace.archive-import-dry-run');
  const importArchive = operationCatalog.find((entry) => entry.id === 'workspace.archive-import');
  const client = {
    app: {
      downloadWorkspaceExportArchive() {
        return Promise.resolve(new Response(bytes).body);
      },
      async dryRunWorkspaceArchiveImport(body) {
        uploads.push(Buffer.from(await new Response(body).arrayBuffer()));
        return { mode: 'dry-run' };
      },
      async importWorkspaceArchive(body, requestId) {
        uploads.push(Buffer.from(await new Response(body).arrayBuffer()));
        return { mode: 'imported', requestId };
      },
    },
  };

  await download.handler(
    { client },
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      destinationPath,
    }
  );
  assert.deepEqual(readFileSync(destinationPath), bytes);
  assert.equal(statSync(destinationPath).mode & 0o777, 0o600);
  await assert.rejects(
    download.handler(
      { client },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        destinationPath,
      }
    ),
    (error) => error.code === 'archive_destination_exists'
  );
  assert.deepEqual(readFileSync(destinationPath), bytes);

  for (const outcome of ['failure', 'success']) {
    const raceDestination = join(root, `${outcome}-race.openkit-workspace.tar.zst`);
    const movedDestination = `${raceDestination}.owned`;
    const replacement = Buffer.from(`${outcome}-replacement`);
    let pulled = false;
    const raceClient = {
      app: {
        downloadWorkspaceExportArchive() {
          return Promise.resolve(
            new ReadableStream(
              {
                pull(controller) {
                  if (pulled) return;
                  pulled = true;
                  controller.enqueue(bytes);
                  renameSync(raceDestination, movedDestination);
                  writeFileSync(raceDestination, replacement);
                  if (outcome === 'failure') {
                    controller.error(new Error('injected transfer failure'));
                  } else {
                    controller.close();
                  }
                },
              },
              { highWaterMark: 0 }
            )
          );
        },
      },
    };

    await assert.rejects(
      download.handler(
        { client: raceClient },
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
          destinationPath: raceDestination,
        }
      ),
      (error) => error.code === 'archive_download_failed'
    );
    assert.deepEqual(readFileSync(raceDestination), replacement);
    assert.equal(existsSync(movedDestination), true);
    if (outcome === 'success') assert.deepEqual(readFileSync(movedDestination), bytes);
  }

  const partialDestination = join(root, 'partial.openkit-workspace.tar.zst');
  const partialClient = {
    app: {
      downloadWorkspaceExportArchive() {
        return Promise.resolve(
          new ReadableStream(
            {
              pull(controller) {
                controller.error(new Error('injected transfer failure'));
              },
            },
            { highWaterMark: 0 }
          )
        );
      },
    },
  };
  await assert.rejects(
    download.handler(
      { client: partialClient },
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        destinationPath: partialDestination,
      }
    ),
    (error) => error.code === 'archive_download_failed'
  );
  assert.equal(existsSync(partialDestination), true);
  assert.equal(statSync(partialDestination).mode & 0o777, 0o600);

  writeFileSync(sourcePath, bytes);
  assert.deepEqual(await dryRun.handler({ client }, { sourcePath }), { mode: 'dry-run' });
  assert.deepEqual(
    await importArchive.handler(
      { client },
      { sourcePath, requestId: '00000000-0000-4000-8000-000000000001' }
    ),
    { mode: 'imported', requestId: '00000000-0000-4000-8000-000000000001' }
  );
  assert.deepEqual(uploads, [bytes, bytes]);

  symlinkSync(sourcePath, linkedSourcePath);
  await assert.rejects(
    Promise.resolve().then(() => dryRun.handler({ client }, { sourcePath: linkedSourcePath })),
    (error) => error.code === 'invalid_archive_source'
  );
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

test('named credentials isolate endpoint admin storage, names, endpoints, and deletion', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const configDir = mkdtempSync(join(tmpdir(), 'openkit-named-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  const options = {
    configDir,
    platform: 'darwin',
    machineId: 'fake-machine',
    warn() {},
    execFile() {
      throw new Error('no keychain');
    },
  };
  const store = createDefaultOpenKitCredentialStore(options);
  const baseUrl = 'https://nanocore.example';
  store.writeToken({ baseUrl, token: 'okt_fake_admin' });
  const adminDirectory = join(configDir, 'credentials', 'nanocore');
  const adminFile = join(adminDirectory, readdirSync(adminDirectory)[0]);
  const adminBytes = readFileSync(adminFile);
  const slot = { baseUrl, destination: 'automation' };
  store.preflightNamedWrite(slot);
  assert.equal(store.readNamedToken(slot), null);
  assert.equal(store.writeNamedToken({ ...slot, token: 'okt_fake_issued' }), 'encrypted-file');
  assert.equal(store.readNamedToken(slot), 'okt_fake_issued');
  store.writeNamedToken({ ...slot, destination: 'other', token: 'okt_fake_other' });
  store.writeNamedToken({ ...slot, baseUrl: 'https://other.example', token: 'okt_fake_endpoint' });
  store.writeNamedToken({ ...slot, token: 'okt_fake_rotated' });
  const restarted = createDefaultOpenKitCredentialStore(options);
  assert.equal(restarted.readNamedToken(slot), 'okt_fake_rotated');
  assert.equal(restarted.readNamedToken({ ...slot, destination: 'other' }), 'okt_fake_other');
  assert.equal(
    restarted.readNamedToken({ ...slot, baseUrl: 'https://other.example' }),
    'okt_fake_endpoint'
  );
  assert.equal(restarted.readToken({ baseUrl }), 'okt_fake_admin');
  assert.deepEqual(readFileSync(adminFile), adminBytes);
  for (const file of listFiles(configDir)) {
    const path = join(configDir, file);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /okt_fake_/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(restarted.deleteNamedToken(slot), true);
  assert.equal(restarted.deleteNamedToken(slot), false);
  assert.equal(restarted.readNamedToken(slot), null);
  assert.equal(restarted.readToken({ baseUrl }), 'okt_fake_admin');
  restarted.deleteToken({ baseUrl });
  assert.equal(restarted.readNamedToken({ ...slot, destination: 'other' }), 'okt_fake_other');
});

test('named backend selection prevents stale replacement and deletion across outages and restart', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const configDir = mkdtempSync(join(tmpdir(), 'openkit-named-backends-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  const credentials = new Map();
  let available = true;
  const options = {
    configDir,
    platform: 'linux',
    machineId: 'fake-machine',
    warn() {},
    execFile(_command, args, execution) {
      if (!available) throw new Error('keychain unavailable');
      const key = args.slice(args.indexOf('application')).join('|');
      if (args[0] === 'store') {
        credentials.set(key, execution.input);
        return '';
      }
      if (args[0] === 'clear') {
        credentials.delete(key);
        return '';
      }
      return credentials.get(key) ?? '';
    },
  };
  const slot = { baseUrl: 'https://nanocore.example', destination: 'automation' };
  const store = createDefaultOpenKitCredentialStore(options);
  assert.equal(store.writeNamedToken({ ...slot, token: 'okt_fake_old_keychain' }), 'os-keychain');
  available = false;
  assert.equal(
    store.writeNamedToken({ ...slot, token: 'okt_fake_new_fallback' }),
    'encrypted-file'
  );
  available = true;
  const restarted = createDefaultOpenKitCredentialStore(options);
  assert.equal(restarted.readNamedToken(slot), 'okt_fake_new_fallback');
  assert.equal(
    restarted.writeNamedToken({ ...slot, token: 'okt_fake_latest_keychain' }),
    'os-keychain'
  );
  available = false;
  assert.equal(createDefaultOpenKitCredentialStore(options).readNamedToken(slot), null);
  assert.equal(restarted.deleteNamedToken(slot), true);
  available = true;
  assert.equal(createDefaultOpenKitCredentialStore(options).readNamedToken(slot), null);
  assert.equal(restarted.deleteNamedToken(slot), false);
  assert.equal(
    restarted.writeNamedToken({ ...slot, token: 'okt_fake_next_keychain' }),
    'os-keychain'
  );
  const selectionFile = join(configDir, listFiles(configDir)[0]);
  for (const invalidSelection of ['{', '{}', '{"version":2,"backend":"os-keychain"}']) {
    writeFileSync(selectionFile, invalidSelection);
    assert.equal(createDefaultOpenKitCredentialStore(options).readNamedToken(slot), null);
  }
  restarted.writeNamedToken({ ...slot, token: 'okt_fake_next_keychain' });
  available = false;
  restarted.writeNamedToken({ ...slot, token: 'okt_fake_next_fallback' });
  assert.equal(restarted.deleteNamedToken(slot), true);
  available = true;
  assert.equal(createDefaultOpenKitCredentialStore(options).readNamedToken(slot), null);
});

test('named keychain selection publication failure never reports successful delivery', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const configDir = mkdtempSync(join(tmpdir(), 'openkit-named-publication-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  let backendWritten = false;
  const store = createDefaultOpenKitCredentialStore({
    configDir,
    platform: 'linux',
    machineId: 'fake-machine',
    warn() {},
    execFile(_command, args) {
      if (args[0] === 'store') {
        backendWritten = true;
        rmSync(configDir, { recursive: true });
        writeFileSync(configDir, 'publication blocked');
      }
      return '';
    },
  });
  const slot = { baseUrl: 'https://nanocore.example', destination: 'automation' };
  store.preflightNamedWrite(slot);
  assert.throws(() => store.writeNamedToken({ ...slot, token: 'okt_fake_one_time' }));
  assert.equal(backendWritten, true);
});

test('named fallback delivery refuses links to the endpoint admin credential', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const configDir = mkdtempSync(join(tmpdir(), 'openkit-named-link-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  const store = createDefaultOpenKitCredentialStore({
    configDir,
    platform: 'darwin',
    machineId: 'fake-machine',
    warn() {},
    execFile() {
      throw new Error('no keychain');
    },
  });
  const baseUrl = 'https://nanocore.example';
  const slot = { baseUrl, destination: 'automation' };
  store.writeToken({ baseUrl, token: 'okt_fake_admin' });
  const adminFile = join(configDir, listFiles(configDir)[0]);
  store.writeNamedToken({ ...slot, token: 'okt_fake_named' });
  const namedFile = listFiles(configDir)
    .map((file) => join(configDir, file))
    .find((file) => file !== adminFile);
  rmSync(namedFile);
  symlinkSync(adminFile, namedFile);
  assert.throws(() => store.preflightNamedWrite(slot));
  assert.throws(() => store.writeNamedToken({ ...slot, token: 'okt_fake_replacement' }));
  assert.equal(store.readToken({ baseUrl }), 'okt_fake_admin');
});

test('named credential methods reject unsafe and reserved destinations before storage access', async () => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  let calls = 0;
  const store = createDefaultOpenKitCredentialStore({
    execFile() {
      calls++;
    },
  });
  for (const destination of [
    undefined,
    null,
    '',
    ' ',
    'admin',
    'endpoint',
    'default',
    'current',
    'ADMIN',
    '../admin',
    '/admin',
    'a/b',
    'a:b',
    ' a',
    'a ',
    'okt_fake_secret',
    'a'.repeat(65),
  ]) {
    for (const method of [
      'readNamedToken',
      'writeNamedToken',
      'deleteNamedToken',
      'preflightNamedWrite',
    ]) {
      assert.throws(
        () =>
          store[method]({
            baseUrl: 'https://nanocore.example',
            destination,
            token: 'okt_fake_issued',
          }),
        { code: 'invalid_credential_destination' }
      );
    }
  }
  assert.equal(calls, 0);
});

test('named keychain entries have distinct identities and stdin-only writes on supported platforms', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const configDir = mkdtempSync(join(tmpdir(), 'openkit-named-keychain-'));
  t.after(() => rmSync(configDir, { force: true, recursive: true }));
  for (const platform of ['linux', 'win32', 'darwin']) {
    const calls = [];
    const execFile = (command, args, options) => {
      calls.push({ command, args, options });
      return 'okt_fake_keychain';
    };
    const store = createDefaultOpenKitCredentialStore({ platform, configDir, execFile });
    const seed = createDefaultOpenKitCredentialStore({ platform: 'linux', configDir, execFile });
    const slot = { baseUrl: 'https://nanocore.example', destination: 'automation' };
    for (const namedSlot of [
      slot,
      { ...slot, destination: 'other' },
      { ...slot, baseUrl: 'https://other.example' },
    ]) {
      seed.writeNamedToken({ ...namedSlot, token: 'okt_fake_keychain' });
    }
    store.readToken(slot);
    const adminRead = calls.at(-1);
    assert.equal(store.readNamedToken(slot), 'okt_fake_keychain');
    const namedRead = calls.at(-1);
    assert.notDeepEqual(namedRead.args, adminRead.args);
    if (platform === 'linux') {
      assert.notEqual(namedRead.args[namedRead.args.indexOf('application') + 1], 'openkit');
    } else {
      assert.ok(!namedRead.args.includes('openkit.nanocore.token'));
    }
    store.readNamedToken({ ...slot, destination: 'other' });
    assert.notDeepEqual(calls.at(-1).args, namedRead.args);
    store.readNamedToken({ ...slot, baseUrl: 'https://other.example' });
    assert.notDeepEqual(calls.at(-1).args, namedRead.args);
    if (platform !== 'darwin') {
      assert.equal(store.writeNamedToken({ ...slot, token: 'okt_fake_stdin_only' }), 'os-keychain');
      const write = calls.at(-1);
      assert.doesNotMatch(JSON.stringify(write.args), /okt_fake_/);
      assert.equal(write.options.input, 'okt_fake_stdin_only');
      assert.deepEqual(write.options.stdio, ['pipe', 'ignore', 'ignore']);
    }
    store.deleteToken(slot);
    const adminDelete = calls.at(-1);
    store.deleteNamedToken(slot);
    assert.notDeepEqual(calls.at(-1).args, adminDelete.args);
  }
});

test('token create and rotate require named delivery and preflight before the public client call', async () => {
  const { operationCatalog } = await operations();
  for (const action of ['create', 'rotate']) {
    const operation = operationCatalog.find((entry) => entry.id === `token.${action}`);
    assert.ok(operation);
    const method = `token.${action}`;
    assert.equal(operation.appOperationId, method);
    assert.equal(operation.clientMethod, `operations.${method}`);
    assert.match(operation.requiredAccess, /deployment admin.*server-admin bearer.*server mode/);
    const body =
      action === 'create'
        ? {
            scope: 'workspace',
            workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
            ownerUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
            expiresAt: '2027-01-01T00:00:00.000Z',
          }
        : { graceSeconds: 60, tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18' };
    const input = {
      ...body,
      destination: 'automation',
      ...(action === 'rotate' ? { tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18' } : {}),
    };
    for (const destination of [undefined, '', 'admin', '../admin', 'okt_fake_secret']) {
      assert.equal(operation.inputSchema.safeParse({ ...input, destination }).success, false);
    }
    assert.equal(
      operation.inputSchema.safeParse({ ...input, baseUrl: 'https://other.example' }).success,
      false
    );
    const record = { tokenId: 'tok_00000000-0000-7d69-9a9a-2f137ff87b29' };
    const rotatedRecord = { tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18' };
    const response = {
      token: 'okt_fake_issued',
      record,
      ...(action === 'rotate' ? { rotatedRecord } : {}),
    };
    const events = [];
    const slot = { baseUrl: 'https://nanocore.example', destination: 'automation' };
    const context = {
      endpoint: slot.baseUrl,
      client: {
        operations: {
          [method]: async (...args) => {
            events.push(['request', args]);
            return response;
          },
        },
      },
      credentialStore: {
        preflightNamedWrite(value) {
          events.push(['preflight', value]);
        },
        writeNamedToken(value) {
          events.push(['write', value]);
          return 'os-keychain';
        },
        writeToken() {
          assert.fail('endpoint administration credential must never be written');
        },
      },
    };
    const result = await operation.handler(context, operation.inputSchema.parse(input));
    assert.deepEqual(events, [
      ['preflight', slot],
      ['request', [body]],
      ['write', { ...slot, token: response.token }],
    ]);
    assert.deepEqual(result, {
      record,
      ...(action === 'rotate' ? { rotatedRecord } : {}),
      credentialStorageBackend: 'os-keychain',
      destination: 'automation',
    });
    assert.doesNotMatch(JSON.stringify(result), /okt_fake_|"token":/);
    for (const credentialStore of [
      undefined,
      { writeToken() {} },
      {
        preflightNamedWrite() {
          throw new Error('unwritable');
        },
        writeNamedToken() {},
      },
    ]) {
      events.length = 0;
      await assert.rejects(operation.handler({ ...context, credentialStore }, input), {
        code: 'credential_storage_unavailable',
      });
      assert.deepEqual(events, []);
    }
    events.length = 0;
    context.credentialStore.writeNamedToken = () => {
      throw new Error('okt_fake_issued');
    };
    await assert.rejects(operation.handler(context, input), (error) => {
      assert.equal(error.code, 'credential_storage_failed');
      assert.doesNotMatch(error.message, /okt_fake_/);
      return true;
    });
    assert.deepEqual(
      events.map(([event]) => event),
      ['preflight', 'request']
    );
  }
});

/**
 * Isolates bundled CLI credential storage from the host OpenKit config directory.
 *
 * @param {string} root Temporary home and XDG config root.
 * @param {NodeJS.Platform} [platform] Credential backend selected in the CLI child.
 * @returns {{configDir: string, env: NodeJS.ProcessEnv, machineId: string, imports: string[]}} Matching CLI and test-store paths.
 */
function isolatedCredentialLayout(root, platform = process.platform) {
  const darwin = platform === 'darwin';
  return {
    configDir: darwin
      ? join(root, 'Library', 'Application Support', 'OpenKit')
      : join(root, 'openkit'),
    // The child has HOME=root; the parent must decrypt with that same fallback seed.
    machineId: `${hostname()}:${root}`,
    // Model a minimal Linux image without machine-id files or keychain executables.
    imports: [
      dataModule(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      const readFileSync = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        if (path === '/etc/machine-id' || path === '/var/lib/dbus/machine-id') {
          throw Object.assign(new Error('Fixture machine-id unavailable'), { code: 'ENOENT' });
        }
        return readFileSync(path, ...args);
      };
      syncBuiltinESMExports();
    `),
    ],
    env: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      PATH: root,
    },
  };
}

test('bundled named credential selection authenticates exact calls without changing administration', async (t) => {
  const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
  const root = mkdtempSync(join(tmpdir(), 'openkit-selected-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const endpoint = 'https://nanocore.example';
  const layout = isolatedCredentialLayout(root);
  const store = createDefaultOpenKitCredentialStore({
    configDir: layout.configDir,
    machineId: layout.machineId,
    execFile() {
      throw new Error('unavailable');
    },
    warn() {},
  });
  store.writeToken({ baseUrl: endpoint, token: 'okt_fixture_admin' });
  store.writeNamedToken({ baseUrl: endpoint, destination: 'member', token: 'okt_fixture_member' });
  const originalFiles = new Map(
    listFiles(layout.configDir).map((path) => [path, readFileSync(join(layout.configDir, path))])
  );
  const env = { ...layout.env, OPENKIT_NANOCORE_URL: endpoint, OPENKIT_NANOCORE_TOKEN: '' };
  const args = ['ops', 'call', 'workspace.list', '--input', '-', '--credential', 'member'];
  const transport = dataModule(`
    globalThis.fetch = async (url, options) => {
      if (url !== '${endpoint}/api/app/operations/workspace.list') throw new Error('wrong endpoint');
      const headers = new Headers(options.headers);
      if (headers.get('authorization') !== 'Bearer okt_fixture_member') throw new Error('wrong credential');
      if (headers.get('x-openkit-client-channel') !== 'openkit-cli') throw new Error('wrong channel');
      return new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  const result = await runCli(args, env, '{}', [...layout.imports, transport]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).data, { items: [] });
  assert.doesNotMatch(result.stdout + result.stderr, /okt_fixture_/);
  for (const [path, bytes] of originalFiles)
    assert.deepEqual(readFileSync(join(layout.configDir, path)), bytes);
  for (const status of [401, 403]) {
    const code = status === 401 ? 'core.auth.unauthenticated' : 'core.auth.forbidden';
    const denied = await runCli(args, env, '{}', [
      ...layout.imports,
      dataModule(`
        let calls = 0;
        globalThis.fetch = async (_url, options) => {
          if (++calls !== 1 || new Headers(options.headers).get('authorization') !== 'Bearer okt_fixture_member') throw new Error('Unexpected credential or retry');
          return new Response(JSON.stringify({ protocolVersion: '${protocol.PROTOCOL_VERSION}', code: '${code}', message: 'Denied okt_fixture_member' }), { status: ${status}, headers: { 'content-type': 'application/json' } });
        };
      `),
    ]);
    assert.equal(denied.code, 3, denied.stdout);
    assert.equal(JSON.parse(denied.stdout).error.code, code);
    assert.doesNotMatch(denied.stdout + denied.stderr, /okt_fixture_/);
  }
  const doctor = await runCli(['doctor', '--credential', 'member'], env, '{}', [
    ...layout.imports,
    dataModule(`
      globalThis.fetch = async (url, options) => {
        if (new Headers(options.headers).get('authorization') !== 'Bearer okt_fixture_member') throw new Error('wrong credential');
        const body = url === '${endpoint}/api/meta'
          ? { protocolVersion: '${protocol.PROTOCOL_VERSION}', capabilities: [], eventFamilies: [] }
          : { code: 'core.auth.forbidden', message: 'Administrator diagnostics unavailable' };
        return new Response(JSON.stringify(body), { status: url.endsWith('/api/meta') ? 200 : 403, headers: { 'content-type': 'application/json' } });
      };
    `),
  ]);
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.equal(JSON.parse(doctor.stdout).data.authentication, 'named-store');
  assert.equal(JSON.parse(doctor.stdout).data.nanocore.productWorkReadiness, 'unknown');
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /okt_fixture_/);
  const noNetwork = dataModule(
    `globalThis.fetch = () => { throw new Error('unexpected network request'); };`
  );
  for (const [command, overrides, expected] of [
    [args.slice(0, -1).concat('missing'), {}, 'credential_unavailable'],
    [args, { OPENKIT_NANOCORE_URL: 'https://other.example' }, 'credential_unavailable'],
    [args, { OPENKIT_NANOCORE_TOKEN: 'okt_fixture_override' }, 'invalid_configuration'],
    [args.slice(0, -1).concat('admin'), {}, 'invalid_credential_destination'],
    [args.slice(0, -1).concat('../member'), {}, 'invalid_credential_destination'],
    [['doctor', '--credential', 'missing'], {}, 'credential_unavailable'],
    [['ops', 'search', 'workspace', '--credential', 'member'], {}, 'invalid_usage'],
    [
      ['ops', 'call', 'bootstrap.consume', '--input', '-', '--credential', 'member'],
      {},
      'invalid_usage',
    ],
    [args.concat('--credential', 'member'), {}, 'invalid_usage'],
    [
      ['ops', 'call', 'credential.delete', '--input', '-', '--credential', 'member'],
      {},
      'invalid_usage',
    ],
  ]) {
    const failed = await runCli(command, { ...env, ...overrides }, '{}', [
      ...layout.imports,
      noNetwork,
    ]);
    assert.notEqual(failed.code, 0);
    assert.equal(JSON.parse(failed.stdout).error.code, expected, failed.stdout);
    assert.equal(Object.hasOwn(JSON.parse(failed.stdout), 'requestId'), false);
    assert.doesNotMatch(failed.stdout + failed.stderr, /okt_fixture_/);
  }
  const namedFile = listFiles(layout.configDir).find((path) => path.includes('nanocore-named'));
  const adminFile = listFiles(layout.configDir).find((path) => !path.includes('nanocore-named'));
  writeFileSync(join(layout.configDir, namedFile), 'invalid fixture storage');
  for (const unsafe of [false, true]) {
    if (unsafe) {
      rmSync(join(layout.configDir, namedFile));
      symlinkSync(join(layout.configDir, adminFile), join(layout.configDir, namedFile));
    }
    const failed = await runCli(args, env, '{}', [...layout.imports, noNetwork]);
    assert.equal(failed.code, 2, failed.stdout);
    assert.equal(JSON.parse(failed.stdout).error.code, 'credential_unavailable');
    assert.equal(Object.hasOwn(JSON.parse(failed.stdout), 'requestId'), false);
    assert.doesNotMatch(failed.stdout + failed.stderr, /okt_fixture_|nanocore-named/);
  }
  assert.equal(store.readToken({ baseUrl: endpoint }), 'okt_fixture_admin');
});

for (const platform of ['darwin', 'linux']) {
  test(`bundled token create and rotate preserve transport, redaction, and auth denials (${platform})`, async (t) => {
    const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
    const root = mkdtempSync(join(tmpdir(), 'openkit-token-cli-'));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const endpoint = 'https://nanocore.example';
    const {
      configDir,
      env: isolatedEnv,
      machineId,
      imports,
    } = isolatedCredentialLayout(root, platform);
    const env = {
      ...isolatedEnv,
      OPENKIT_NANOCORE_URL: endpoint,
      OPENKIT_NANOCORE_TOKEN: 'okt_fake_admin',
    };
    const record = {
      tokenId: 'tok_00000000-0000-7d69-9a9a-2f137ff87b29',
      ownerUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      scope: 'workspace',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      status: 'active',
      issuedAt: '2026-09-14T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
      predecessorTokenId: null,
      rotatedGraceExpiresAt: null,
      lastUsedAt: null,
      lastUsedChannel: null,
      lastUsedSource: null,
    };
    const store = createDefaultOpenKitCredentialStore({
      configDir,
      platform,
      machineId,
      execFile() {
        throw new Error('unavailable');
      },
      warn() {},
    });
    store.writeToken({ baseUrl: endpoint, token: 'okt_fake_stored_admin' });
    for (const action of ['create', 'rotate']) {
      const body =
        action === 'create'
          ? {
              scope: 'workspace',
              workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
              expiresAt: record.expiresAt,
            }
          : { graceSeconds: 60, tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18' };
      const input = {
        ...body,
        destination: 'automation',
        ...(action === 'rotate' ? { tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18' } : {}),
      };
      const response = {
        token: `okt_fake_${action}`,
        record,
        ...(action === 'rotate'
          ? {
              rotatedRecord: {
                ...record,
                tokenId: 'tok_00000000-0000-7dac-b3c3-75dfb2fb4c18',
                status: 'rotated',
              },
            }
          : {}),
      };
      const url = `${endpoint}/api/app/operations/token.${action}`;
      const args = ['ops', 'call', `token.${action}`, '--input', '-'];
      const transport = dataModule(`
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers);
        if (url !== ${JSON.stringify(url)} || options.method !== 'POST') throw new Error('wrong route');
        if (headers.get('authorization') !== 'Bearer okt_fake_admin') throw new Error('wrong credential');
        if (headers.get('x-openkit-client-channel') !== 'openkit-cli' || headers.get('x-openkit-client-source') !== 'agent-skill') throw new Error('wrong audit metadata');
        if (JSON.stringify(JSON.parse(options.body)) !== ${JSON.stringify(JSON.stringify(body))}) throw new Error('wrong body');
        return new Response(${JSON.stringify(JSON.stringify(response))}, { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `);
      const result = await runCli(args, env, JSON.stringify(input), [...imports, transport]);
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(JSON.parse(result.stdout).data, {
        record,
        ...(action === 'rotate' ? { rotatedRecord: response.rotatedRecord } : {}),
        credentialStorageBackend: 'encrypted-file',
        destination: 'automation',
      });
      assert.match(result.stderr, /encrypted-file/);
      assert.doesNotMatch(result.stdout + result.stderr, /okt_fake_/);
      assert.equal(
        store.readNamedToken({ baseUrl: endpoint, destination: 'automation' }),
        response.token
      );
      assert.equal(store.readToken({ baseUrl: endpoint }), 'okt_fake_stored_admin');
      for (const status of [401, 403]) {
        const denied = await runCli(args, env, JSON.stringify(input), [
          ...imports,
          responseModule(status, {
            code: status === 401 ? 'core.auth.unauthenticated' : 'deployment_admin_required',
            message: 'Denied okt_fake_admin',
            protocolVersion: '0.4.0',
          }),
        ]);
        assert.equal(denied.code, 3, denied.stdout);
        assert.equal(
          JSON.parse(denied.stdout).error.code,
          status === 401 ? 'core.auth.unauthenticated' : 'deployment_admin_required'
        );
        assert.doesNotMatch(denied.stdout + denied.stderr, /okt_fake_/);
        assert.equal(
          store.readNamedToken({ baseUrl: endpoint, destination: 'automation' }),
          response.token
        );
      }
      const invalid = await runCli(args, env, JSON.stringify({ ...input, destination: 'admin' }), [
        ...imports,
        dataModule(`globalThis.fetch = async () => { throw new Error('must not request'); };`),
      ]);
      assert.equal(invalid.code, 2);
      assert.equal(JSON.parse(invalid.stdout).error.code, 'invalid_input');
    }
  });

  test(`bundled bootstrap uses only its secret input and stores its one-time result without printing credentials (${platform})`, async (t) => {
    const { createDefaultOpenKitCredentialStore } = await import('../skills/openkit-secrets.mjs');
    const root = mkdtempSync(join(tmpdir(), 'openkit-bootstrap-cli-'));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const endpoint = 'https://nanocore.example';
    const {
      configDir,
      env: isolatedEnv,
      machineId,
      imports,
    } = isolatedCredentialLayout(root, platform);
    const input = {
      token: 'okt_bootstrap_canary_do_not_print',
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      displayName: 'Owner',
      email: 'owner@example.test',
      password: 'password-canary-do-not-print',
      tokenExpiresAt: '2027-01-01T00:00:00.000Z',
    };
    const record = {
      tokenId: 'tok_00000000-0000-73ae-8509-478b478934e3',
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      scope: 'server-admin',
      workspaceIds: [],
      status: 'active',
      issuedAt: '2026-10-05T00:00:00.000Z',
      expiresAt: input.tokenExpiresAt,
      revokedAt: null,
      predecessorTokenId: null,
      rotatedGraceExpiresAt: null,
      lastUsedAt: null,
      lastUsedChannel: null,
      lastUsedSource: null,
    };
    const response = { record, token: 'okt_bootstrap_return_canary' };
    const result = await runCli(
      ['ops', 'call', 'bootstrap.consume', '--input', '-'],
      {
        ...isolatedEnv,
        OPENKIT_NANOCORE_URL: endpoint,
        OPENKIT_NANOCORE_TOKEN: 'okt_ordinary_admin_canary',
      },
      JSON.stringify(input),
      [
        ...imports,
        dataModule(`
    globalThis.fetch = async (url, options) => {
      if (url !== '${endpoint}/api/app/operations/bootstrap.consume' || options.method !== 'POST') throw new Error('wrong bootstrap route');
      const headers = new Headers(options.headers);
      if (headers.has('authorization') || headers.has('cookie')) throw new Error('ordinary credential sent');
      if (JSON.stringify(JSON.parse(options.body)) !== ${JSON.stringify(JSON.stringify(input))}) throw new Error('wrong bootstrap input');
      return Response.json(${JSON.stringify(response)}, { status: 201 });
    };
  `),
      ]
    );
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, {
      record: { ...record, ownerUserId: '[redacted]', expiresAt: '[redacted]' },
      credentialStorageBackend: 'encrypted-file',
    });
    for (const secret of [input.token, input.password, response.token, 'okt_ordinary_admin_canary'])
      assert.ok(!(result.stdout + result.stderr).includes(secret));
    const store = createDefaultOpenKitCredentialStore({
      configDir,
      platform,
      machineId,
      execFile() {
        throw new Error('unavailable');
      },
      warn() {},
    });
    assert.equal(store.readToken({ baseUrl: endpoint }), response.token);
  });
}

test('bundled token delivery reports preflight and post-issuance storage failures without secrets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-token-failure-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const { configDir, env: isolatedEnv } = isolatedCredentialLayout(root);
  const env = {
    ...isolatedEnv,
    OPENKIT_NANOCORE_URL: 'https://nanocore.example',
    OPENKIT_NANOCORE_TOKEN: 'okt_fake_admin',
  };
  const args = ['ops', 'call', 'token.create', '--input', '-'];
  const input = JSON.stringify({
    scope: 'server-admin',
    expiresAt: '2027-01-01T00:00:00.000Z',
    destination: 'automation',
  });
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const preflight = await runCli(args, { ...env, HOME: blocked, XDG_CONFIG_HOME: blocked }, input, [
    dataModule(`globalThis.fetch = async () => { throw new Error('must not request'); };`),
  ]);
  assert.equal(preflight.code, 2);
  assert.equal(JSON.parse(preflight.stdout).error.code, 'credential_storage_unavailable');
  const record = {
    tokenId: 'tok_00000000-0000-7d69-9a9a-2f137ff87b29',
    ownerUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
    scope: 'server-admin',
    workspaceIds: [],
    status: 'active',
    issuedAt: '2026-09-14T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
    predecessorTokenId: null,
    rotatedGraceExpiresAt: null,
    lastUsedAt: null,
    lastUsedChannel: null,
    lastUsedSource: null,
  };
  const response = { token: 'okt_fake_one_time', record };
  const result = await runCli(args, env, input, [
    dataModule(`
    import { rmSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async () => {
      rmSync(${JSON.stringify(configDir)}, { recursive: true });
      writeFileSync(${JSON.stringify(configDir)}, 'blocked after issuance');
      return new Response(${JSON.stringify(JSON.stringify(response))}, { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `),
  ]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'credential_storage_failed');
  assert.match(JSON.parse(result.stdout).error.message, /issued/);
  assert.doesNotMatch(
    result.stdout + result.stderr + preflight.stdout + preflight.stderr,
    /okt_fake_/
  );
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
      path: '/Users/demo/private',
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

for (const [operation, required] of [
  [
    'vault.secret-create',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', secretKind: 'github-token' },
  ],
  [
    'vault.secret-rotate',
    {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c',
    },
  ],
]) {
  test(`bundled ${operation} rejects malformed secret input without disclosure or transport`, async () => {
    const material = 'review-fake-canary';
    const result = await runCli(
      ['ops', 'call', operation, '--input', '-'],
      { OPENKIT_NANOCORE_URL: 'http://nanocore.example', OPENKIT_NANOCORE_TOKEN: 'okt_test_admin' },
      JSON.stringify({ ...required, material, [material]: true }),
      [
        dataModule(`
        globalThis.fetch = async () => {
          process.stderr.write('UNEXPECTED_TRANSPORT');
          throw new Error('Validation must reject before transport.');
        };
      `),
      ]
    );
    assert.equal(result.code, 2);
    assert.ok(!result.stdout.includes(material), 'stdout must not contain secret material');
    assert.ok(!result.stderr.includes(material), 'stderr must not contain secret material');
    assert.equal(result.stderr, '', 'invalid input must not invoke transport');
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: 'invalid_input',
      message: 'Operation input failed schema validation.',
    });
  });
}

test('bundled Vault secret writes keep material in stdin bodies and redact upstream failures', async () => {
  const material = 'generic-vault-canary-do-not-print';
  for (const [operation, input] of [
    [
      'vault.secret-create',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        secretKind: 'github-token',
        material,
      },
      '/secrets',
    ],
    [
      'vault.secret-rotate',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c',
        material,
      },
      '/secrets/vault_00000000-0000-7be8-b8c8-3d3005ec3f3c/rotate',
    ],
  ]) {
    const result = await runCli(
      ['ops', 'call', operation, '--input', '-'],
      {
        OPENKIT_NANOCORE_URL: 'http://nanocore.example',
        OPENKIT_NANOCORE_TOKEN: 'okt_test_admin',
      },
      JSON.stringify(input),
      [
        dataModule(`
      globalThis.fetch = async (url, options) => {
        if (url !== 'http://nanocore.example/api/app/operations/${operation}' || options.method !== 'POST') throw new Error('Wrong transport');
        const body = JSON.parse(options.body);
        if (body.material !== ${JSON.stringify(material)} || body.workspaceId !== 'ws_00000000-0000-7000-8000-000000000001' || (${JSON.stringify(operation)} === 'vault.secret-rotate' && body.referenceId !== 'vault_00000000-0000-7be8-b8c8-3d3005ec3f3c')) throw new Error('Wrong body');
        return Response.json({ protocolVersion: '0.6.0', code: 'vault_mutation_failed', message: body.material }, { status: 409 });
      };
    `),
      ]
    );
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'vault_mutation_failed');
    assert.ok(!result.stdout.includes(material));
    assert.ok(!result.stderr.includes(material));
  }
});

test('the bundled CLI stages one local Skill in the caller and uploads only its exact tree', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-local-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const selected = join(source, 'skills', 'sample');
  mkdirSync(join(selected, 'empty'), { recursive: true });
  const header = Buffer.from(
    '\uFEFF---\r\nname: Original Name\r\ndescription: Keep authored bytes.\r\n---\r\nOriginal instructions.\r\n'
  );
  const script = Buffer.from('#!/bin/sh\nprintf "authored\\n"\n');
  writeFileSync(join(selected, 'SKILL.md'), header);
  writeFileSync(join(selected, 'run.sh'), script);
  chmodSync(join(selected, 'run.sh'), 0o751);
  const executable = join(root, 'openkit');
  cpSync(cliPath, executable);
  const input = {
    workspaceId: protocol.allocateEntityId('ws'),
    requestId: '00000000-0000-4000-8000-000000000021',
    expectedRevision: 3,
    activate: false,
    id: 'local-skill',
    displayName: 'Retained display',
    source,
    sourceSubpath: 'skills/sample',
    sourceSkillName: 'Original Name',
  };
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'catalog.skill-import');
  assert.deepEqual(operation.inputSchema.parse(input), input);
  assert.equal(operation.inputSchema.safeParse({ ...input, hostPath: source }).success, false);
  assert.equal(
    operation.inputSchema.safeParse({ ...input, tree: [{ kind: 'directory', path: 'empty' }] })
      .success,
    false
  );
  const requests = [];
  const response = {
    revision: 4,
    entry: {
      id: input.id,
      displayName: input.displayName,
      description: null,
      availability: 'available',
      currentDigest: null,
    },
    version: {
      entryId: input.id,
      digest: `sha256:${'a'.repeat(64)}`,
      digestFormat: 'openkit-tree-v1',
      contentState: 'retained',
      createdAt: '2026-10-17T00:00:00.000Z',
      inventory: [],
      producer: { kind: 'user', id: protocol.allocateEntityId('usr') },
      publisherVersion: null,
      provenance: {
        baseDigest: null,
        pluginMemberKey: null,
        pluginVersionDigest: null,
        sourceCommit: null,
        sourceSubpath: null,
        uploadedSourceId: null,
      },
    },
  };
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    reply.writeHead(201, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  const env = {
    OPENKIT_NANOCORE_URL: `http://127.0.0.1:${server.address().port}`,
    OPENKIT_NANOCORE_TOKEN: '',
  };
  const args = ['ops', 'call', 'catalog.skill-import', '--input', '-'];
  const result = await runCli(args, env, JSON.stringify(input), [], undefined, executable);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/app/operations/catalog.skill-import');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['x-openkit-client-channel'], 'openkit-cli');
  assert.equal(requests[0].headers['x-openkit-client-source'], 'agent-skill');
  assert.equal(requests[0].headers['x-openkit-request-id'], input.requestId);
  assert.equal(JSON.parse(result.stdout).requestId, input.requestId);
  assert.deepEqual(
    {
      ...requests[0].body,
      tree: requests[0].body.tree?.toSorted((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
      ),
    },
    {
      workspaceId: input.workspaceId,
      expectedRevision: input.expectedRevision,
      activate: input.activate,
      id: input.id,
      displayName: input.displayName,
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          executable: false,
          contentBase64: header.toString('base64'),
        },
        { kind: 'directory', path: 'empty' },
        {
          kind: 'file',
          path: 'run.sh',
          executable: true,
          contentBase64: script.toString('base64'),
        },
      ],
    }
  );
  assert.equal(JSON.stringify(requests[0].body).includes(source), false);
  for (const failed of [
    { ...input, sourceSubpath: 'skills/missing' },
    { ...input, unknownField: true },
  ]) {
    const rejected = await runCli(args, env, JSON.stringify(failed), [], undefined, executable);
    assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
    assert.equal(
      requests.length,
      1,
      'Local source/schema failures must not contact the import endpoint.'
    );
    assert.equal(rejected.stdout.includes(source), false);
  }
  for (const source of ['https://example.invalid/skill.zip', 'https://github.com/example/skills']) {
    const remote = operation.inputSchema.parse({ ...input, source });
    const forwarded = [];
    await operation.handler(
      { client: { operations: { 'catalog.skill-import': async (body) => forwarded.push(body) } } },
      remote
    );
    assert.deepEqual(forwarded, [remote]);
  }
});

test('the bundled CLI performs one typed call with fixed audit headers', async () => {
  const fetchStub = dataModule(`
    globalThis.fetch = async (url, options) => {
      const headers = new Headers(options.headers);
      if (url !== 'http://nanocore.example/api/app/operations/workspace.list') throw new Error('unexpected URL');
      if (options.method !== 'POST') throw new Error('unexpected method');
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

test('the bundled CLI sends Worker environment preparation and activation to global routes', async () => {
  const configuration = {
    expectedRevision: `sha256:${'c'.repeat(64)}`,
    fileId: 'agents/codex.agent.jsonc',
  };
  const target = { agentId: 'codex', kind: 'agent' };
  const requestId = '11111111-1111-4111-8111-111111111111';
  const prepareInput = {
    administrationThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
    configuration,
    declaration: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'d'.repeat(64)}` },
    requestId,
    target,
  };
  const resolvedCandidate = {
    artifactId: 'ar_00000000-0000-7fd1-9bc1-cf5509dbe80c',
    artifactVersion: 1,
    contentDigest: `sha256:${'f'.repeat(64)}`,
  };
  const activation = {
    affectedStorage: [],
    configuration,
    replaceNow: null,
    resolvedCandidate,
    target,
  };
  const activationConfirmation = appSchemas.workerEnvironmentActivationConfirmation({
    ...activation,
    image: {
      digest: `sha256:${'d'.repeat(64)}`,
      environmentDefaults: { defaultsDigest: `sha256:${'b'.repeat(64)}` },
    },
  });
  const preparedResponse = {
    activationConfirmation,
    affectedStorage: [],
    authoredCandidate: {
      artifactId: 'ar_00000000-0000-765f-9e4b-f410cda62de6',
      artifactVersion: 1,
      contentDigest: `sha256:${'e'.repeat(64)}`,
    },
    configuration,
    image: {
      digest: `sha256:${'d'.repeat(64)}`,
      environmentDefaults: {
        classification: 'unadmitted',
        defaultsDigest: `sha256:${'b'.repeat(64)}`,
        names: ['COLOR'],
      },
      platform: { architecture: 'arm64', os: 'linux' },
      storageLayout: {
        family: 'openkit-worker',
        gid: 1000,
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
        uid: 1000,
        version: '1',
        workingDirectory: '/tmp/openkit-bootstrap',
      },
    },
    preparedAt: '2026-09-11T00:00:00.000Z',
    replaceNow: null,
    requestId,
    resolvedCandidate,
    target,
  };
  const prepared = await runCli(
    ['ops', 'call', 'worker-environment.prepare', '--input', '-'],
    {
      OPENKIT_NANOCORE_TOKEN: 'okt_administrator',
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
    },
    JSON.stringify(prepareInput),
    [
      dataModule(`
        globalThis.fetch = async (url, options) => {
          if (url !== 'http://nanocore.example/api/app/operations/worker-environment.prepare') throw new Error('unexpected URL');
          if (options.method !== 'POST') throw new Error('unexpected method');
          const body = JSON.parse(options.body);
          if (body.workspaceId !== undefined || body.mode !== undefined || body.target?.kind !== 'agent') throw new Error('unexpected body');
          return new Response(${JSON.stringify(JSON.stringify(preparedResponse))}, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      `),
    ]
  );
  assert.equal(prepared.code, 0, `${prepared.stdout}\n${prepared.stderr}`);
  assert.equal(JSON.parse(prepared.stdout).data.activationConfirmation, activationConfirmation);

  const activateInput = {
    ...activation,
    confirmation: activationConfirmation,
    requestId,
  };
  const activatedResponse = {
    affected: [],
    configuration: {
      fileId: configuration.fileId,
      revision: `sha256:${'a'.repeat(64)}`,
    },
    replaceNow: null,
    requestId,
    resolvedCandidate,
    target,
  };
  const activated = await runCli(
    ['ops', 'call', 'worker-environment.activate', '--input', '-'],
    {
      OPENKIT_NANOCORE_TOKEN: 'okt_administrator',
      OPENKIT_NANOCORE_URL: 'http://nanocore.example',
    },
    JSON.stringify(activateInput),
    [
      dataModule(`
        globalThis.fetch = async (url, options) => {
          if (url !== 'http://nanocore.example/api/app/operations/worker-environment.activate') throw new Error('unexpected URL');
          if (options.method !== 'POST') throw new Error('unexpected method');
          const body = JSON.parse(options.body);
          if (body.workspaceId !== undefined || body.target?.kind !== 'agent' || !body.confirmation) throw new Error('unexpected body');
          return new Response(${JSON.stringify(JSON.stringify(activatedResponse))}, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      `),
    ]
  );
  assert.equal(activated.code, 0, `${activated.stdout}\n${activated.stderr}`);
  assert.deepEqual(JSON.parse(activated.stdout).data, activatedResponse);
});

test('the bundled CLI downloads a portable archive only to a new exact destination', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-bundled-archive-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const destinationPath = join(root, 'workspace.openkit-workspace.tar.zst');
  const bytes = Buffer.from([40, 181, 47, 253]);
  const fetchStub = dataModule(`
    globalThis.fetch = async (url, options) => {
      if (url !== 'http://nanocore.example/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/exports/wsexp_00000000-0000-7693-ae39-6c3f6020c3c4/archive') throw new Error('unexpected URL');
      if (options.method !== 'GET') throw new Error('unexpected method');
      return new Response(Uint8Array.from([40, 181, 47, 253]), {
        headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      });
    };
  `);
  const args = ['ops', 'call', 'workspace.archive-download', '--input', '-'];
  const env = {
    OPENKIT_NANOCORE_URL: 'http://nanocore.example',
    OPENKIT_NANOCORE_TOKEN: '',
  };
  const input = JSON.stringify({
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
    destinationPath,
  });

  const downloaded = await runCli(args, env, input, [fetchStub]);
  assert.equal(downloaded.code, 0);
  assert.deepEqual(JSON.parse(downloaded.stdout).data, { downloaded: true });
  assert.deepEqual(readFileSync(destinationPath), bytes);
  assert.equal(statSync(destinationPath).mode & 0o777, 0o600);

  const refused = await runCli(args, env, input, [fetchStub]);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stdout).error.code, 'archive_destination_exists');
  assert.deepEqual(readFileSync(destinationPath), bytes);
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
  assert.equal(rejectionEnvelope.error.details.path, '/Users/private');
  assert.equal(rejectionEnvelope.error.details.token, '[redacted]');
  assert.doesNotMatch(`${rejection.stdout}${rejection.stderr}`, /okt_environment/);

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
  const [owner, ...parts] = path.split('.');
  const member = parts.join('.');
  if (value?.[owner] && Object.hasOwn(value[owner], member)) return value[owner][member];
  return path.split('.').reduce((current, segment) => current?.[segment], value);
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

test('dashboard and search catalog mappings replace exactly their exclusions', async () => {
  const { operationCatalog, operationExclusions } = await operations();
  for (const [id, operationId, method, input, args] of [
    [
      'workspace.dashboard',
      'workspace.dashboard',
      'workspace.dashboard',
      { workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' },
      [{ workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' }],
    ],
    [
      'thread.dashboard',
      'thread.dashboard',
      'thread.dashboard',
      {
        workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c',
        threadId: 'th_00000000-0000-74b3-a7b1-84ca4d6ac0b0',
      },
      [
        {
          workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c',
          threadId: 'th_00000000-0000-74b3-a7b1-84ca4d6ac0b0',
        },
      ],
    ],
    ['app.search', 'app.search', 'app.search', { query: 'needle' }, [{ query: 'needle' }]],
    [
      'conversation.navigation',
      'conversation.navigation',
      'conversation.navigation',
      { workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' },
      [{ workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' }],
    ],
    [
      'worker.list',
      'worker.list',
      'worker.list',
      { workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' },
      [{ workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' }],
    ],
  ]) {
    const entry = operationCatalog.find((candidate) => candidate.id === id);
    assert.ok(entry);
    assert.equal(entry.appOperationId, operationId);
    assert.equal(entry.mutating, false);
    assert.equal(
      operationExclusions.some((candidate) => candidate.name === operationId),
      false
    );
    let observed;
    const result = await entry.handler(
      {
        client: {
          [id === 'thread.dashboard' ||
          id === 'conversation.navigation' ||
          id === 'workspace.dashboard' ||
          id === 'worker.list' ||
          id === 'app.search'
            ? 'operations'
            : 'app']: {
            [method]: async (...values) => {
              observed = values;
              return { items: [] };
            },
          },
        },
      },
      entry.inputSchema.parse(input)
    );
    assert.deepEqual(observed, args);
    assert.deepEqual(result, { items: [] });
    assert.equal(
      entry.inputSchema.safeParse({
        ...input,
        privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      }).success,
      false
    );
  }
});

test('bundled dashboard and search reads retain authorization errors without leaking credentials', async () => {
  for (const [operation, input, path] of [
    [
      'workspace.dashboard',
      { workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' },
      '/api/app/operations/workspace.dashboard',
    ],
    [
      'thread.dashboard',
      {
        workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c',
        threadId: 'th_00000000-0000-7915-b626-0b698e2552dc',
      },
      '/api/app/operations/thread.dashboard',
    ],
    ['app.search', { query: 'private needle' }, '/api/app/operations/app.search'],
    [
      'worker.list',
      { workspaceId: 'ws_00000000-0000-7ff3-a4b6-e4b2e1ee8f3c' },
      '/api/app/operations/worker.list',
    ],
  ]) {
    for (const status of [401, 403, 404]) {
      const result = await runCli(
        ['ops', 'call', operation, '--input', '-'],
        {
          OPENKIT_NANOCORE_URL: 'https://openkit.example.invalid',
          OPENKIT_NANOCORE_TOKEN: 'okt_fake_visibility',
        },
        JSON.stringify(input),
        [
          dataModule(`
        globalThis.fetch = async (url, options) => {
          if (new URL(url).pathname + new URL(url).search !== ${JSON.stringify(path)} || options.method !== ${JSON.stringify(operation === 'thread.dashboard' || operation === 'workspace.dashboard' || operation === 'worker.list' || operation === 'app.search' ? 'POST' : 'GET')}) throw new Error('unexpected transport');
          if (new Headers(options.headers).get('authorization') !== 'Bearer okt_fake_visibility') throw new Error('missing actor');
          return new Response(JSON.stringify({ code: 'access_denied', message: 'Access denied.', protocolVersion: '0.6.0', token: 'okt_fake_visibility' }), { status: ${status}, headers: { 'content-type': 'application/json' } });
        };
      `),
        ]
      );
      assert.notEqual(result.code, 0);
      assert.equal(JSON.parse(result.stdout).error.code, 'access_denied');
      assert.doesNotMatch(result.stdout + result.stderr, /okt_fake_visibility/);
    }
  }
});

test('Goal publishes precisely its ten derived semantic operations and retires step and steering', async () => {
  const { operationCatalog } = await operations();
  const ids = operationCatalog
    .filter((operation) => operation.id.startsWith('goal.'))
    .map((operation) => operation.id)
    .sort();
  assert.deepEqual(
    ids,
    [
      'goal.create',
      'goal.intent.revise',
      'goal.card.create',
      'goal.card.edit',
      'goal.card.cancel',
      'goal.plan.propose',
      'goal.plan.approve',
      'goal.cancel',
      'goal.completion.accept',
      'goal.read',
    ].sort()
  );
  const read = operationCatalog.find((operation) => operation.id === 'goal.read');
  const input = {
    workspaceId: 'ws_00000000-0000-796a-8af7-97608a790532',
    threadId: 'th_00000000-0000-7264-9729-c1391de4f71e',
  };
  let observed;
  const result = await read.handler(
    {
      client: {
        operations: {
          'goal.read': async (value) => {
            observed = value;
            return { goal: null, cards: [], versions: [], tasks: [], requests: [] };
          },
        },
      },
    },
    read.inputSchema.parse(input)
  );
  assert.deepEqual(observed, input);
  assert.equal(result.goal, null);
});

test('automation deletion derives strict CLI input and maps the bodyless HTTP success to null', async () => {
  const { operationCatalog } = await operations();
  const operation = operationCatalog.find((entry) => entry.id === 'automation.delete');
  assert.equal(operation.clientMethod, 'operations.automation.delete');
  const input = { automationId: 'auto_00000000-0000-706c-8ede-0e40a6e7c886' };
  assert.deepEqual(operation.inputSchema.parse(input), input);
  assert.equal(operation.inputSchema.safeParse({ ...input, force: true }).success, false);
  const requests = [];
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: async (url, init) => {
      requests.push(new Request(url, init));
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(await operation.handler({ client }, input), null);
  assert.equal(new URL(requests[0].url).pathname, '/api/app/operations/automation.delete');
  assert.deepEqual(await requests[0].json(), input);
});
