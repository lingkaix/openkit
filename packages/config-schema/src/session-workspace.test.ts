import { describe, expect, it } from 'vitest';

import {
  computeSessionCompatibilityKey,
  planSessionWorkspaceMaterialization,
  SessionWorkspaceLayoutSchema,
} from './index.js';

/**
 * Creates a minimal package-like input for session workspace planning tests.
 *
 * @param overrides Package field overrides.
 * @returns Package-like input accepted by the planner.
 */
function packageFixture(overrides: Record<string, unknown> = {}) {
  return {
    packageId: 'aepkg_demo',
    snapshotId: 'aepsnap_demo',
    scope: {
      threadId: 'th_demo',
      turnId: 'turn_demo',
    },
    agent: {
      agentId: 'agent_codex',
      profileId: 'coder',
      runtimeKind: 'codex',
    },
    runtime: {
      image: {
        kind: 'reference',
        ref: 'ghcr.io/openkit/codex-worker:test',
        digest: 'sha256:demo',
      },
      command: {
        argv: ['codex', 'app-server'],
        workingDirectory: '/workspace',
      },
      process: {
        user: 'openkit-worker',
        group: 'openkit-worker',
        umask: '0022',
      },
    },
    workspace: {
      root: '/workspace',
      inputs: [
        {
          id: 'repo',
          kind: 'repository',
          source: { kind: 'git', ref: 'main' },
          target: '/workspace/worktrees/main',
          access: 'read-write',
        },
        {
          id: 'attachment',
          kind: 'attachment',
          source: { kind: 'openkit-upload', ref: 'file_1' },
          target: '/workspace/inputs/file_1.txt',
          access: 'read-only',
        },
      ],
      outputs: [{ id: 'out', path: '/workspace/outputs', registerAsArtifacts: true }],
    },
    control: {
      mode: 'sidecar',
      transcript: { root: '/openkit/session' },
    },
    providers: {
      attachments: [{ id: 'provider_github', providerInstanceId: 'github' }],
    },
    vault: {
      references: [{ id: 'vault_github', kind: 'secret-ref', secretRef: 'secret://github' }],
    },
    policy: { snapshotId: 'policy_1' },
    backend: {
      preferred: 'openshell',
      allowedKinds: ['openshell'],
      requiredCapabilities: ['git-materialization', 'file-upload-download'],
    },
    ...overrides,
  };
}

describe('session workspace layout schema', () => {
  it('accepts the default worker skeleton and rejects unsafe slots', () => {
    const planned = planSessionWorkspaceMaterialization({ environmentPackage: packageFixture() });

    expect(planned.layout.slots.map((slot) => slot.id)).toEqual(
      expect.arrayContaining(['main-worktree', 'turn-inputs', 'external-data', 'turn-output'])
    );
    expect(planned.layout.workingDirectory).toBe('/workspace');
    expect(() =>
      SessionWorkspaceLayoutSchema.parse({
        ...planned.layout,
        slots: [
          {
            id: 'wide-write',
            kind: 'scratch',
            path: '/workspace',
            access: 'read-write',
            allowedSourceKinds: ['generated'],
            allowedMaterializationModes: ['create-empty'],
            writeBack: 'discard',
            retention: 'session',
            lineageRequired: false,
          },
          {
            id: 'readonly-child',
            kind: 'input',
            path: '/workspace/inputs',
            access: 'read-only',
            allowedSourceKinds: ['generated'],
            allowedMaterializationModes: ['copy'],
            writeBack: 'discard',
            retention: 'turn',
            lineageRequired: true,
          },
        ],
      })
    ).toThrow();
    expect(() =>
      SessionWorkspaceLayoutSchema.parse({
        ...planned.layout,
        slots: [
          {
            ...planned.layout.slots[0],
            path: '/Users/m5pro/private-host-path',
          },
        ],
      })
    ).toThrow();
    expect(() =>
      SessionWorkspaceLayoutSchema.parse({
        ...planned.layout,
        slots: [planned.layout.slots[0]!, planned.layout.slots[0]!],
      })
    ).toThrow();
  });
});

describe('session workspace planner', () => {
  it('routes the dedicated generated Context Package input to the existing context slot', () => {
    const planned = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({
        workspace: {
          root: '/workspace',
          inputs: [
            {
              access: 'read-only',
              id: 'context_turn_demo',
              kind: 'generated',
              materialization: {
                strategy: 'filesystem',
                contentDigest: `sha256:${'a'.repeat(64)}`,
                slotId: 'context',
              },
              source: {
                kind: 'generated',
                pathRef: 'threads/th_demo/turns/turn_demo/context-package',
              },
              target: '/openkit/context',
            },
          ],
          outputs: [],
        },
      }),
    });

    expect(planned.materialization.inputs).toEqual([
      expect.objectContaining({
        access: 'read-only',
        inputId: 'context_turn_demo',
        mode: 'copy',
        slotId: 'context',
      }),
    ]);
  });

  it.each([
    ['wrong target', { target: '/openkit/not-context' }],
    ['wrong id', { id: 'context_other_turn' }],
    [
      'wrong lineage',
      {
        source: {
          kind: 'generated',
          pathRef: 'threads/th_demo/turns/other_turn/context-package',
        },
      },
    ],
    [
      'wrong thread lineage',
      {
        source: {
          kind: 'generated',
          pathRef: 'threads/th_other/turns/turn_demo/context-package',
        },
      },
    ],
    [
      'extra source field',
      {
        source: {
          extra: true,
          kind: 'generated',
          pathRef: 'threads/th_demo/turns/turn_demo/context-package',
        },
      },
    ],
    [
      'source id',
      {
        source: {
          kind: 'generated',
          pathRef: 'threads/th_demo/turns/turn_demo/context-package',
          sourceId: 'source_context',
        },
      },
    ],
    ['mount', { mount: { type: 'bind' } }],
    [
      'invalid digest',
      {
        materialization: {
          contentDigest: 'sha256:not-a-digest',
          slotId: 'context',
          strategy: 'filesystem',
        },
      },
    ],
    [
      'extra materialization field',
      {
        materialization: {
          contentDigest: `sha256:${'a'.repeat(64)}`,
          extra: true,
          slotId: 'context',
          strategy: 'filesystem',
        },
      },
    ],
  ])('keeps a generated Context Package near-miss in turn inputs: %s', (_label, change) => {
    const contextInput = {
      access: 'read-only' as const,
      id: 'context_turn_demo',
      kind: 'generated',
      materialization: {
        strategy: 'filesystem',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        slotId: 'context',
      },
      source: {
        kind: 'generated',
        pathRef: 'threads/th_demo/turns/turn_demo/context-package',
      },
      target: '/openkit/context',
      ...change,
    };
    const planned = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({
        workspace: {
          root: '/workspace',
          inputs: [contextInput],
          outputs: [],
        },
      }),
    });

    expect(planned.materialization.inputs[0]?.slotId).toBe('turn-inputs');
  });

  it('maps turn inputs into declared slots and keeps payload refs out of the compatibility key', () => {
    const first = planSessionWorkspaceMaterialization({ environmentPackage: packageFixture() });
    const second = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({
        workspace: {
          root: '/workspace',
          inputs: [
            {
              id: 'repo',
              kind: 'repository',
              source: { kind: 'git', ref: 'feature/new-input' },
              target: '/workspace/worktrees/main',
              access: 'read-write',
            },
          ],
          outputs: [{ id: 'out', path: '/workspace/outputs', registerAsArtifacts: true }],
        },
      }),
    });
    const changedRuntime = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({
        runtime: {
          image: {
            kind: 'reference',
            ref: 'ghcr.io/openkit/codex-worker:test2',
            digest: 'sha256:changed',
          },
          command: {
            argv: ['codex', 'app-server'],
            workingDirectory: '/workspace',
          },
        },
      }),
    });

    expect(first.materialization.inputs).toEqual([
      expect.objectContaining({ inputId: 'repo', slotId: 'main-worktree' }),
      expect.objectContaining({ inputId: 'attachment', slotId: 'turn-inputs' }),
    ]);
    expect(second.compatibilityKey.digest).toBe(first.compatibilityKey.digest);
    expect(changedRuntime.compatibilityKey.digest).not.toBe(first.compatibilityKey.digest);
  });

  it('keeps package lineage ids out of the compatibility key', () => {
    const first = planSessionWorkspaceMaterialization({ environmentPackage: packageFixture() });
    const second = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({
        packageId: 'aepkg_second',
        snapshotId: 'aepsnap_second',
      }),
    });

    expect(second.layout.layoutId).toBe(first.layout.layoutId);
    expect(second.compatibilityKey.digest).toBe(first.compatibilityKey.digest);
  });

  it('uses strict compatibility key equality for V1 session reuse', () => {
    const planned = planSessionWorkspaceMaterialization({ environmentPackage: packageFixture() });
    const reusable = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture(),
      existingSession: {
        agentSessionId: 'as_existing',
        compatibilityKey: planned.compatibilityKey.digest,
        status: 'idle',
      },
    });
    const replacement = planSessionWorkspaceMaterialization({
      environmentPackage: packageFixture({ policy: { snapshotId: 'policy_2' } }),
      existingSession: {
        agentSessionId: 'as_existing',
        compatibilityKey: planned.compatibilityKey.digest,
        status: 'idle',
      },
    });

    expect(reusable.decision).toEqual({ kind: 'reuse', agentSessionId: 'as_existing' });
    expect(replacement.decision).toEqual({
      kind: 'replace',
      reason: 'session-compatibility-key-mismatch',
    });
    expect(computeSessionCompatibilityKey(planned.layout, packageFixture()).digest).toBe(
      planned.compatibilityKey.digest
    );
  });
});
