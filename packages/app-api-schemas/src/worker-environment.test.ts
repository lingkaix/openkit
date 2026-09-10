import { describe, expect, it } from 'vitest';
import { StartThreadGoalRequestSchema } from './dashboard.js';
import { StartTaskModeRequestSchema } from './task-mode.js';

import {
  ActivateWorkerEnvironmentRequestSchema,
  ActivateWorkerEnvironmentResponseSchema,
  GetWorkerEnvironmentStatusResponseSchema,
  ListWorkerEnvironmentsResponseSchema,
  PrepareWorkerEnvironmentRequestSchema,
  PrepareWorkerEnvironmentResponseSchema,
  PurgeWorkerEnvironmentRequestSchema,
  SelectWorkerEnvironmentRequestSchema,
  WorkerEnvironmentImageDeclarationSchema,
  WorkerEnvironmentImageInspectionSchema,
  WorkerEnvironmentResolvedCandidateArtifactSchema,
  WorkerEnvironmentStorageChoiceSchema,
  WorkerEnvironmentSummarySchema,
  workerEnvironmentActivationConfirmation,
  workerEnvironmentPurgeConfirmation,
} from './worker-environment.js';

const STORAGE_REF = `wst_${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_REVISION = `sha256:${'c'.repeat(64)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TIMESTAMP = '2026-09-10T00:00:00.000Z';
const layout = {
  family: 'openkit-worker',
  gid: 1000,
  platform: { architecture: 'arm64', os: 'linux' },
  targets: [{ target: '/sandbox' }, { target: '/workspace' }],
  uid: 1000,
  version: '1',
  workingDirectory: '/tmp/openkit-bootstrap',
};
const environment = {
  attachmentGeneration: 2,
  contributors: [
    {
      attachmentGeneration: 2,
      createdAt: TIMESTAMP,
      goalId: null,
      purpose: 'work' as const,
      responsibleUserId: 'user_owner',
      taskId: 'task_related',
      threadId: 'thread_related',
    },
  ],
  createdAt: TIMESTAMP,
  layout,
  layoutDigest: DIGEST,
  revision: 4,
  state: 'idle' as const,
  storageRef: STORAGE_REF,
  updatedAt: TIMESTAMP,
  workspaceId: 'workspace_demo',
};

describe('Worker environment App API schemas', () => {
  it('accepts only exact explicit fresh or selected ordinary-work storage choices', () => {
    expect(WorkerEnvironmentStorageChoiceSchema.parse({ kind: 'fresh' })).toEqual({
      kind: 'fresh',
    });
    expect(
      WorkerEnvironmentStorageChoiceSchema.parse({
        adjudicatedThreadIds: ['thread_reviewed'],
        expectedRevision: 4,
        kind: 'selected',
        purpose: 'independent-review',
        storageRef: STORAGE_REF,
      })
    ).toMatchObject({ storageRef: STORAGE_REF, expectedRevision: 4 });
    expect(
      WorkerEnvironmentStorageChoiceSchema.safeParse({
        adjudicatedThreadIds: ['thread_reviewed', 'thread_reviewed'],
        expectedRevision: 4,
        kind: 'selected',
        purpose: 'independent-review',
        storageRef: STORAGE_REF,
      }).success
    ).toBe(false);
    expect(
      WorkerEnvironmentStorageChoiceSchema.safeParse({
        expectedRevision: 4,
        goalId: 'goal_forged',
        kind: 'selected',
        purpose: 'work',
        storageRef: STORAGE_REF,
      }).success
    ).toBe(false);
    expect(
      StartTaskModeRequestSchema.parse({
        input: 'Continue the implementation.',
        requestId: REQUEST_ID,
        workerStorageChoice: { kind: 'fresh' },
      }).workerStorageChoice
    ).toEqual({ kind: 'fresh' });
    expect(
      StartThreadGoalRequestSchema.parse({
        objective: 'Ship the feature.',
        requestId: REQUEST_ID,
        workerStorageChoice: {
          expectedRevision: 4,
          kind: 'selected',
          purpose: 'work',
          storageRef: STORAGE_REF,
        },
      }).workerStorageChoice
    ).toMatchObject({ storageRef: STORAGE_REF });
  });

  it('projects bounded environment lineage without host paths or runtime handles', () => {
    const parsed = WorkerEnvironmentSummarySchema.parse(environment);

    expect(parsed).toEqual(environment);
    expect(JSON.stringify(parsed)).not.toMatch(
      /hostPath|agentSessionId|sandboxBindingRef|credential/i
    );
    expect(
      ListWorkerEnvironmentsResponseSchema.parse({ items: [parsed], nextCursor: null }).items
    ).toHaveLength(1);
    expect(
      WorkerEnvironmentSummarySchema.safeParse({ ...environment, hostPath: '/var/lib/private' })
        .success
    ).toBe(false);
  });

  it('requires exact selection revision, layout, and work lineage', () => {
    const selection = SelectWorkerEnvironmentRequestSchema.parse({
      expectedRevision: environment.revision,
      layoutDigest: DIGEST,
      purpose: 'work',
      storageRef: STORAGE_REF,
      threadId: 'thread_successor',
    });

    expect(selection).toMatchObject({
      adjudicatedThreadIds: [],
      goalId: null,
      taskId: null,
    });
    expect(
      SelectWorkerEnvironmentRequestSchema.safeParse({
        ...selection,
        layoutDigest: 'latest',
      }).success
    ).toBe(false);
  });

  it('accepts the exact image and storage inspection shapes', () => {
    const image = WorkerEnvironmentImageInspectionSchema.parse({
      digest: DIGEST,
      platform: layout.platform,
      storageLayout: {
        family: layout.family,
        gid: layout.gid,
        targets: layout.targets,
        uid: layout.uid,
        version: layout.version,
        workingDirectory: layout.workingDirectory,
      },
    });
    const status = GetWorkerEnvironmentStatusResponseSchema.parse({
      environment,
      storage: {
        attachment: { generation: 3 },
        capacity: { availableBytes: 512, totalBytes: 1024 },
        layoutDigest: DIGEST,
        scopeDigest: DIGEST,
        state: 'available',
        storageRef: STORAGE_REF,
        targets: [
          { initialized: true, target: '/sandbox', volumeRef: 'wsv_sandbox' },
          { initialized: true, target: '/workspace', volumeRef: 'wsv_workspace' },
        ],
      },
    });

    expect(image.storageLayout.targets).toHaveLength(2);
    expect(status.storage.attachment).toEqual({ generation: 3 });
    expect(status.storage.capacity.availableBytes).toBe(512);
    expect(
      GetWorkerEnvironmentStatusResponseSchema.safeParse({
        ...status,
        storage: {
          ...status.storage,
          attachment: { generation: 3, sandboxId: 'raw-native-sandbox' },
        },
      }).success
    ).toBe(false);
    expect(
      GetWorkerEnvironmentStatusResponseSchema.safeParse({
        ...status,
        storage: { ...status.storage, capacity: { availableBytes: 2048, totalBytes: 1024 } },
      }).success
    ).toBe(false);
  });

  it('uses an immutable Artifact version as the preparation owner', () => {
    const prepared = PrepareWorkerEnvironmentRequestSchema.parse({
      administrationThreadId: 'thread_admin',
      configuration: {
        expectedRevision: CONFIG_REVISION,
        fileId: 'agents/codex.agent.jsonc',
      },
      declaration: { kind: 'reference', pullPolicy: 'never', ref: DIGEST },
      mode: 'prepare',
      requestId: REQUEST_ID,
      target: { agentId: 'codex', kind: 'agent' },
    });

    expect(prepared.declaration).toMatchObject({ kind: 'reference', ref: DIGEST });
    expect(prepared.replaceNow).toBeNull();
    expect(
      PrepareWorkerEnvironmentRequestSchema.safeParse({
        ...prepared,
        configuration: { expectedRevision: CONFIG_REVISION, fileId: '/etc/agents.jsonc' },
      }).success
    ).toBe(false);
    expect(
      PrepareWorkerEnvironmentRequestSchema.parse({
        administrationThreadId: 'thread_admin_recovery',
        mode: 'recover',
        recoverFrom: {
          artifactId: 'artifact_authored',
          artifactVersion: 1,
          contentDigest: DIGEST,
        },
        requestId: '22222222-2222-4222-8222-222222222222',
      })
    ).toMatchObject({ mode: 'recover', recoverFrom: { artifactId: 'artifact_authored' } });
    expect(
      PrepareWorkerEnvironmentRequestSchema.safeParse({
        administrationThreadId: 'thread_admin_recovery',
        declaration: prepared.declaration,
        mode: 'recover',
        recoverFrom: {
          artifactId: 'artifact_authored',
          artifactVersion: 1,
          contentDigest: DIGEST,
        },
        requestId: '22222222-2222-4222-8222-222222222222',
      }).success
    ).toBe(false);
    expect(
      PrepareWorkerEnvironmentRequestSchema.safeParse({
        administrationThreadId: 'thread_admin_recovery',
        mode: 'recover',
        recoverFrom: {
          artifactId: 'artifact_authored',
          artifactVersion: 2,
          contentDigest: DIGEST,
        },
        requestId: '22222222-2222-4222-8222-222222222222',
      }).success
    ).toBe(false);
  });

  it('validates authored build declarations without Node-only browser primitives', () => {
    const build = {
      arguments: { NODE_VERSION: '24' },
      contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      contextRef: 'build-context://empty/v1',
      egress: [{ host: 'registry.npmjs.org', port: 443 }],
      input: { content: 'FROM node:24\n', digest: DIGEST, kind: 'dockerfile' as const },
      kind: 'build' as const,
      layerLimit: 16,
      outputLimitBytes: 1_073_741_824,
      timeLimitSeconds: 600,
    };

    expect(WorkerEnvironmentImageDeclarationSchema.parse(build)).toEqual(build);
    expect(
      WorkerEnvironmentImageDeclarationSchema.safeParse({
        ...build,
        input: { ...build.input, content: '\ud800' },
      }).success
    ).toBe(false);
    expect(
      WorkerEnvironmentImageDeclarationSchema.safeParse({
        ...build,
        arguments: { API_TOKEN: 'private' },
      }).success
    ).toBe(false);
  });

  it('binds activation to the resolved candidate, target, and every affected revision', () => {
    const exact = {
      affectedStorage: [{ expectedRevision: 4, storageRef: STORAGE_REF }],
      configuration: {
        expectedRevision: CONFIG_REVISION,
        fileId: 'agents/codex.agent.jsonc',
      },
      replaceNow: {
        prompt: 'Continue the implementation with the prepared image.',
        threadId: 'thread_target',
        workspaceId: 'ws_demo',
      },
      resolvedCandidate: {
        artifactId: 'artifact_resolved',
        artifactVersion: 1,
        contentDigest: DIGEST,
      },
      target: { agentId: 'codex', kind: 'agent' as const },
    };
    const request = {
      ...exact,
      confirmation: workerEnvironmentActivationConfirmation(exact),
      requestId: REQUEST_ID,
    };

    expect(ActivateWorkerEnvironmentRequestSchema.parse(request)).toEqual(request);
    expect(
      workerEnvironmentActivationConfirmation({
        affectedStorage: [{ storageRef: STORAGE_REF, expectedRevision: 4 }],
        configuration: {
          fileId: exact.configuration.fileId,
          expectedRevision: exact.configuration.expectedRevision,
        },
        replaceNow: {
          workspaceId: exact.replaceNow.workspaceId,
          threadId: exact.replaceNow.threadId,
          prompt: exact.replaceNow.prompt,
        },
        resolvedCandidate: {
          contentDigest: exact.resolvedCandidate.contentDigest,
          artifactVersion: exact.resolvedCandidate.artifactVersion,
          artifactId: exact.resolvedCandidate.artifactId,
        },
        target: { kind: 'agent', agentId: exact.target.agentId },
      })
    ).toBe(request.confirmation);
    expect(
      ActivateWorkerEnvironmentRequestSchema.safeParse({
        ...request,
        affectedStorage: [{ expectedRevision: 5, storageRef: STORAGE_REF }],
      }).success
    ).toBe(false);
    expect(
      WorkerEnvironmentResolvedCandidateArtifactSchema.parse({
        affectedStorage: exact.affectedStorage,
        authoredCandidate: exact.resolvedCandidate,
        configuration: exact.configuration,
        image: {
          digest: DIGEST,
          platform: layout.platform,
          storageLayout: {
            family: layout.family,
            gid: layout.gid,
            targets: layout.targets,
            uid: layout.uid,
            version: layout.version,
            workingDirectory: layout.workingDirectory,
          },
        },
        kind: 'worker-environment-resolved-candidate',
        replaceNow: exact.replaceNow,
        schemaVersion: 1,
        target: exact.target,
      }).authoredCandidate.artifactId
    ).toBe('artifact_resolved');
    expect(
      ActivateWorkerEnvironmentResponseSchema.parse({
        affected: [{ expectedRevision: 4, storageRef: STORAGE_REF, disposition: 'unknown' }],
        configuration: null,
        replaceNow: exact.replaceNow,
        requestId: REQUEST_ID,
        resolvedCandidate: exact.resolvedCandidate,
        target: exact.target,
      }).configuration
    ).toBeNull();

    const response = {
      ...exact,
      activationConfirmation: workerEnvironmentActivationConfirmation(exact),
      authoredCandidate: {
        artifactId: 'artifact_authored',
        artifactVersion: 1,
        contentDigest: DIGEST,
      },
      image: {
        digest: DIGEST,
        platform: layout.platform,
        storageLayout: {
          family: layout.family,
          gid: layout.gid,
          targets: layout.targets,
          uid: layout.uid,
          version: layout.version,
          workingDirectory: layout.workingDirectory,
        },
      },
      preparedAt: '2026-09-11T00:00:00.000Z',
      requestId: REQUEST_ID,
    };
    expect(PrepareWorkerEnvironmentResponseSchema.parse(response).activationConfirmation).toBe(
      response.activationConfirmation
    );
    expect(
      PrepareWorkerEnvironmentResponseSchema.safeParse({
        ...response,
        activationConfirmation: `${response.activationConfirmation}-changed`,
      }).success
    ).toBe(false);
  });

  it('keeps config-only activation separate from immediate resident replacement', () => {
    const resolvedCandidate = {
      artifactId: 'artifact_resolved_config_only',
      artifactVersion: 1,
      contentDigest: DIGEST,
    };
    const exact = {
      affectedStorage: [],
      configuration: {
        expectedRevision: CONFIG_REVISION,
        fileId: 'agents/codex.agent.jsonc',
      },
      replaceNow: null,
      resolvedCandidate,
      target: { agentId: 'codex', kind: 'agent' as const },
    };

    expect(
      ActivateWorkerEnvironmentRequestSchema.parse({
        ...exact,
        confirmation: workerEnvironmentActivationConfirmation(exact),
        requestId: REQUEST_ID,
      }).affectedStorage
    ).toEqual([]);
    expect(
      ActivateWorkerEnvironmentRequestSchema.safeParse({
        ...exact,
        affectedStorage: [{ expectedRevision: 4, storageRef: STORAGE_REF }],
        confirmation: workerEnvironmentActivationConfirmation({
          ...exact,
          affectedStorage: [{ expectedRevision: 4, storageRef: STORAGE_REF }],
        }),
        requestId: REQUEST_ID,
      }).success
    ).toBe(false);
  });

  it('binds destructive purge confirmation to the exact ref and revision', () => {
    const request = {
      confirmation: workerEnvironmentPurgeConfirmation({
        expectedRevision: 4,
        storageRef: STORAGE_REF,
      }),
      expectedRevision: 4,
      requestId: REQUEST_ID,
      storageRef: STORAGE_REF,
    };

    expect(PurgeWorkerEnvironmentRequestSchema.parse(request)).toEqual(request);
    expect(
      PurgeWorkerEnvironmentRequestSchema.safeParse({
        ...request,
        confirmation: `purge-worker-environment:${STORAGE_REF}:3`,
      }).success
    ).toBe(false);
    expect(
      PurgeWorkerEnvironmentRequestSchema.safeParse({ ...request, hostPath: '/var/lib/private' })
        .success
    ).toBe(false);
  });
});
