import { describe, expect, it } from 'vitest';
import {
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
} from './generative-operations.js';
import {
  ARTIFACT_OPERATION_DEFINITIONS,
  composeOperationTables,
  KERNEL_OPERATION_DEFINITIONS,
  operationHttpPath,
  operationModelInput,
  operationToolName,
  PRODUCT_OPERATION_DEFINITIONS,
} from './operation-definitions.js';
import { WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS } from './workspace-lifecycle-operations.js';

it('rejects duplicate operation ids instead of silently overwriting an included family', () => {
  expect(() =>
    composeOperationTables(KERNEL_OPERATION_DEFINITIONS, KERNEL_OPERATION_DEFINITIONS)
  ).toThrow('Duplicate operation id: kernel.apps.get');
});

describe('operation definitions', () => {
  it('derives model views from complete schemas without bound identities', () => {
    for (const [id, definition] of Object.entries(KERNEL_OPERATION_DEFINITIONS)) {
      expect(operationHttpPath(id)).toBe(`/api/app/operations/${id}`);
      expect(operationToolName(id)).toBe(id.replaceAll('.', '_').replaceAll('-', '_'));
      expect(definition.inputSchema.safeParse({}).success).toBe(false);
      const model = operationModelInput(definition.inputSchema, ['workspaceId', 'requestId']);
      expect(model.shape).not.toHaveProperty('workspaceId');
      expect(model.shape).not.toHaveProperty('requestId');
      for (const [key, schema] of Object.entries(model.shape)) {
        expect(schema).toBe(
          definition.inputSchema.shape[key as keyof typeof definition.inputSchema.shape]
        );
      }
    }
    expect(new Set(Object.keys(KERNEL_OPERATION_DEFINITIONS).map(operationToolName)).size).toBe(
      Object.keys(KERNEL_OPERATION_DEFINITIONS).length
    );
  });
});

it('derives Artifact model views with bound identity omitted and content and feedback refinements retained', () => {
  const imported = operationModelInput(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.import'].inputSchema,
    ['workspaceId', 'requestId']
  );
  expect(imported.shape.content).toBe(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.import'].inputSchema.shape.content
  );
  expect(imported.shape.requestId).toBeUndefined();
  expect(
    imported.safeParse({
      title: 'Exact JSON',
      mediaType: 'application/json',
      content: 'invalid json',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }).success
  ).toBe(false);
  expect(
    imported.safeParse({
      title: 'Exact JSON',
      mediaType: 'application/json',
      content: '{"ok":true}',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }).success
  ).toBe(true);
  const decision = operationModelInput(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.review.decide'].inputSchema,
    ['workspaceId', 'requestId']
  );
  expect(
    decision.safeParse({ artifactId: 'ar_review', artifactVersion: 1, decision: 'redo' }).success
  ).toBe(false);
  expect(
    decision.safeParse({
      artifactId: 'ar_review',
      artifactVersion: 1,
      decision: 'redo',
      feedback: 'Try again.',
    }).success
  ).toBe(true);
});

describe('automation, scheduler and recovery definitions', () => {
  it('uses strict complete inputs and preserves model-view validation and mutation posture', () => {
    const cases = [
      ['automation.list', {}, false],
      [
        'automation.create',
        { workspaceId: 'ws_demo', name: 'Morning', cron: '*', prompt: 'Work' },
        true,
      ],
      ['automation.update', { automationId: 'auto_one', status: 'enabled' }, true],
      ['automation.delete', { automationId: 'auto_one' }, true],
      ['scheduler.list', { workspaceId: 'ws_demo' }, false],
      ['scheduler.retry', { workspaceId: 'ws_demo', queueEntryId: 'queue_one' }, true],
      ['scheduler.cancel', { workspaceId: 'ws_demo', queueEntryId: 'queue_one' }, true],
      ['recovery.worker-list', {}, false],
      [
        'recovery.checkpoint-retry',
        { workspaceId: 'ws_demo', threadId: 'th_one', turnId: 'tu_one', requestId: 'req_one' },
        true,
      ],
    ] as const;
    for (const [id, input, mutating] of cases) {
      const definition = PRODUCT_OPERATION_DEFINITIONS[id];
      expect(definition.mutating).toBe(mutating);
      expect(definition.inputSchema.safeParse(input).success).toBe(true);
      expect(definition.inputSchema.safeParse({ ...input, userId: 'caller' }).success).toBe(false);
      expect(
        operationModelInput(definition.inputSchema, []).safeParse({ ...input, invented: true })
          .success
      ).toBe(false);
    }
    expect(PRODUCT_OPERATION_DEFINITIONS['automation.delete'].outputSchema.parse(null)).toBeNull();
    expect(PRODUCT_OPERATION_DEFINITIONS['automation.delete'].successStatus).toBe(204);
  });
});

it('derives complete strict Generative model views and preserves the schema collection refinement', () => {
  const definitions = {
    ...KERNEL_REMAINING_OPERATION_DEFINITIONS,
    ...GENERATIVE_UI_OPERATION_DEFINITIONS,
  };
  expect(Object.keys(definitions)).toHaveLength(13);
  for (const definition of Object.values(definitions)) {
    const model = operationModelInput(definition.inputSchema, [
      'workspaceId',
      'requestId',
      'threadId',
      'turnId',
    ]);
    for (const key of ['workspaceId', 'requestId', 'threadId', 'turnId'])
      expect(model.shape).not.toHaveProperty(key);
    expect(model.safeParse({ unowned: true }).success).toBe(false);
  }
  const model = operationModelInput(definitions['kernel.apps.create'].inputSchema, [
    'workspaceId',
    'requestId',
  ]);
  const collection = {
    name: 'entries',
    type: 'base',
    description: 'Entries',
    fields: [{ name: 'note', type: 'text', required: true, description: 'Note' }],
    indexes: [],
  };
  const proposal = {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Proof',
    purpose: 'Proof',
    collections: [collection],
  };
  expect(model.safeParse(proposal).success).toBe(true);
  expect(model.safeParse({ ...proposal, collections: [collection, collection] }).success).toBe(
    false
  );
  expect(model.safeParse({ ...proposal, unowned: true }).success).toBe(false);
});

it('retains deletion confirmation refinements in complete and model inputs and refuses caller authority selectors', () => {
  const schema = WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS['workspace.delete'].inputSchema;
  const input = {
    workspaceId: 'ws_demo',
    requestId: '00000000-0000-4000-8000-000000000023',
    expectedRegistryRevision: 3,
    confirmation: 'permanently-delete-workspace:ws_demo:3',
  };
  expect(schema.safeParse(input).success).toBe(true);
  expect(
    schema.safeParse({ ...input, confirmation: 'permanently-delete-workspace:ws_demo:2' }).success
  ).toBe(false);
  expect(schema.safeParse({ ...input, expectedRegistryRevision: 0 }).success).toBe(false);
  expect(schema.safeParse({ ...input, administratorEligible: true }).success).toBe(false);
  const model = operationModelInput(schema, ['workspaceId', 'requestId']);
  expect(
    model.safeParse({ expectedRegistryRevision: 3, confirmation: input.confirmation }).success
  ).toBe(true);
  expect(
    model.safeParse({
      expectedRegistryRevision: 3,
      confirmation: 'permanently-delete-workspace:ws_demo:2',
    }).success
  ).toBe(false);
  const disable = WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS['user.disable'].inputSchema;
  expect(disable.safeParse({ targetUserId: 'target', requestId: input.requestId }).success).toBe(
    true
  );
  expect(disable.safeParse({ userId: 'target', requestId: input.requestId }).success).toBe(false);
});

it('rejects a bootstrap-secret credential mixed with another credential during composition', () => {
  expect(() =>
    composeOperationTables({
      'bootstrap.consume': { credentials: ['bootstrap-secret', 'deployment-administrator'] },
    })
  ).toThrow('Bootstrap-secret credential must be exclusive: bootstrap.consume');
  expect(
    composeOperationTables({
      'bootstrap.consume': { credentials: ['bootstrap-secret'] },
    })
  ).toHaveProperty('bootstrap.consume');
});
