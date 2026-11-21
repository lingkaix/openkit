import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import { nanoHostSandboxCompatibilityKey } from './nanohost-compatibility.js';

const packageFor = (
  turnId: string,
  overrides: {
    readonly actorId?: string;
    readonly mountLabel?: string;
    readonly sensitivity?: string;
  } = {}
) =>
  ({
    agent: { runtimeKind: 'codex', runtimeVersion: '0.153.4' },
    backend: {},
    capabilities: {},
    control: { adapter: { targetRuntime: 'codex' } },
    credentials: { declarations: [] },
    extensions: {
      openkit: {
        workerStorage: {
          workSlotRef: 'work-slot-fixture',
        },
      },
    },
    llm: {},
    policy: {
      filesystem: {
        rules: [
          {
            access: 'read-only',
            id: 'openkit-context-package',
            workerPath: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/context`,
          },
        ],
      },
    },
    resources: {},
    runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
    schemaVersion: 1,
    scope: {
      agentSessionId: testEntityId('as', `agent-session-${turnId}`),
      threadId: testEntityId('th', `thread-${turnId}`),
      triggerActor: {
        kind: 'user',
        id: overrides.actorId ?? 'usr_00000000-0000-762e-acbb-d80b6f0e8f34',
      },
      turnId: testEntityId('tu', `turn-${turnId}`),
      workspaceId: 'ws_00000000-0000-7b28-a22f-e9264be03c98',
    },
    snapshotId: `snapshot-${turnId}`,
    supply: { services: [] },
    vault: {},
    workspace: {
      generatedFiles: [
        {
          access: 'read-only',
          contentRef: `agent-environment-package://snapshot-${turnId}`,
          id: 'agent-environment-package',
          target: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/config/package.json`,
        },
      ],
      inputs: [
        {
          access: 'read-only',
          id: `context_${testEntityId('tu', `turn-${turnId}`)}`,
          kind: 'generated',
          materialization: {
            contentDigest: `sha256:${turnId.repeat(64).slice(0, 64)}`,
            slotId: 'context',
            strategy: 'filesystem',
          },
          source: {
            kind: 'generated',
            pathRef: `threads/${testEntityId('th', `thread-${turnId}`)}/turns/${testEntityId('tu', `turn-${turnId}`)}/context-package`,
          },
          target: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/context`,
        },
        {
          access: 'read-only',
          id: 'workspace-source',
          kind: 'directory',
          mount: { label: overrides.mountLabel ?? 'primary' },
          source: {
            kind: 'workspace-dir',
            pathRef: 'workspace-root://source',
            sensitivity: overrides.sensitivity ?? 'internal',
          },
          target: '/workspace/inputs/source',
        },
      ],
      outputs: [
        {
          id: 'turn-output-root',
          path: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/outputs`,
          registerAsArtifacts: true,
          retention: 'sync-on-turn-end',
        },
      ],
      root: '/workspace',
    },
  }) as AgentEnvironmentPackage;

describe('Sandbox compatibility with unprovable required inputs', () => {
  it('refuses a missing isolation identity', () => {
    const pkg = packageFor('a');
    pkg.scope.agentSessionId = '';
    expect(() => nanoHostSandboxCompatibilityKey(pkg)).toThrow(
      'exact AgentSession and Thread identities'
    );
  });

  it.each([
    'declared Harness set',
    'Sandbox Integration version',
    'admitted trust class',
    'sensitivity class',
  ])('refuses cross-Thread co-residency when %s is unprovable', () => {
    const first = packageFor('a');
    const second = packageFor('b');
    expect(nanoHostSandboxCompatibilityKey(first)).not.toBe(
      nanoHostSandboxCompatibilityKey(second)
    );
  });

  it('refuses a missing Thread isolation identity', () => {
    const pkg = packageFor('a');
    pkg.scope.threadId = '';
    expect(() => nanoHostSandboxCompatibilityKey(pkg)).toThrow(
      'exact AgentSession and Thread identities'
    );
  });

  it('keeps sequential same-Thread successors in the same physical scope', () => {
    const first = packageFor('a');
    const successorId = testEntityId('as', 'successor');
    const next = JSON.parse(
      JSON.stringify(first).replaceAll(first.scope.agentSessionId, successorId)
    ) as AgentEnvironmentPackage;
    next.snapshotId = 'successor-package';
    expect(nanoHostSandboxCompatibilityKey(first)).toBe(nanoHostSandboxCompatibilityKey(next));
  });

  it('retains the same binding across ordinary Turn changes', () => {
    const first = packageFor('a');
    const next = structuredClone(first);
    next.scope.turnId = testEntityId('tu', 'next-turn');
    next.snapshotId = 'snapshot-next';
    next.workspace.inputs[0]!.id = `context_${next.scope.turnId}`;
    next.workspace.inputs[0]!.source.pathRef =
      `threads/${next.scope.threadId}/turns/${next.scope.turnId}/context-package`;
    expect(nanoHostSandboxCompatibilityKey(first)).toBe(nanoHostSandboxCompatibilityKey(next));
  });
});
