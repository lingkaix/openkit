// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { publishedErrorMessage } from '../api-errors.js';
import { OperationError } from '../operation-error.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  importAgentEnvironmentPackageSnapshots,
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
  snapshotDigest,
} from './aep-snapshot-ledger.js';
import { createEnvironmentOperationImplementations } from './environment-operation-implementations.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';
import {
  answerPendingRequest,
  claimOrRefuseGrant,
  finishPendingExecution,
  freezeReadyOutcomes,
  frozenPendingOutcomeInput,
  raisePendingRequest,
  readPendingRequest,
  releaseFrozenOutcomes,
} from './pending-requests.js';

/**
 * Creates one migrated workspace database for AEP snapshot ledger tests.
 *
 * @returns Open workspace database.
 */
function createWorkspaceDb() {
  const workspaceDb = openWorkspaceDb(
    mkdtempSync(join(tmpdir(), 'openkit-aep-snapshot-ledger-')),
    'ws_1'
  );
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates the safe redacted AEP fixture shared by ledger tests.
 *
 * @returns Parsed AEP without secret or host-path material.
 */
function createEnvironmentPackage(): AgentEnvironmentPackage {
  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agent: {
        id: 'agent_codex_host',
        name: 'Codex Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: null,
        skillIds: [],
        profiles: [
          {
            id: 'default',
            displayName: 'Default',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [],
        sandboxSummary: null,
        config: {
          adapterType: 'codex',
          command: null,
          baseUrl: null,
          workspaceRoot: '/workspace',
          environment: {},
          capabilities: [],
        },
      },
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_1',
      triggerActor: { kind: 'user', id: 'user_local' },
      backend: {
        kind: 'openshell',
      },
      requestId: 'req_1',
      turn: {
        id: 'turn_1',
        workspaceId: 'ws_1',
        threadId: 'th_1',
        items: [],
        status: 'running',
        error: null,
        configVersion: null,
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        durationMs: null,
        triggerActor: { kind: 'user', id: 'user_local' },
      },
      turnInput: 'Run tests',
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );
}

/**
 * Resolves the canonical AEP snapshot path from workspace database ownership metadata.
 *
 * @param workspaceDb Workspace database that owns the snapshot.
 * @param environmentPackage AEP whose session and snapshot ids name the file.
 * @returns Absolute canonical snapshot path.
 */
function snapshotPath(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage
): string {
  return join(
    workspaceDb.dataRoot,
    'workspaces',
    workspaceDb.workspaceId,
    'runtime',
    'agent-sessions',
    environmentPackage.scope.agentSessionId,
    'aep-snapshots',
    `${environmentPackage.snapshotId}.json`
  );
}

describe('AEP snapshot ledger', () => {
  it.each([
    'outcome',
    'user-message',
  ] as const)('preserves ordinary %s input through storage and public projections', (kind) => {
    const db = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const literal = 'ghp_public-test-fixture';
    const input =
      kind === 'outcome'
        ? JSON.stringify({
            triggerInput: 'Deliver frozen result',
            pendingOutcomes: [
              {
                request: {
                  call: {
                    toolName: 'push_files',
                    arguments: {
                      files: [{ content: `expect(value).toBe("${literal}");\n`.repeat(3000) }],
                    },
                  },
                },
                result: { content: [{ type: 'text', text: 'Published fixture' }] },
              },
            ],
          })
        : `Explain this public test literal: ${literal}`;
    environmentPackage.extensions.openkit = { turnInput: input, publicNote: literal };
    try {
      const record = recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage,
        createdAt: '2026-07-06T00:00:01.000Z',
      });
      const path = snapshotPath(db, environmentPackage);
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      expect(stored.snapshot.extensions.openkit.turnInput).toBe(input);
      expect(snapshotDigest(stored.snapshot)).toBe(record.contentDigest);
      const { dataRoot, workspaceId } = db;
      db.sqlite.close();
      const reopened = openWorkspaceDb(dataRoot, workspaceId);
      try {
        const read = requireAgentEnvironmentPackageSnapshot(
          reopened,
          workspaceId,
          environmentPackage.snapshotId
        );
        expect(read.snapshot.extensions.openkit).toEqual({ turnInput: input, publicNote: literal });
        const operations = createEnvironmentOperationImplementations({
          repositoryWorkspaceDb: () => openWorkspaceDb(dataRoot, workspaceId),
        });
        const publicRead = GetAgentEnvironmentPackageSnapshotResponseSchema.parse(
          JSON.parse(
            JSON.stringify(
              operations['environment.snapshot-read']({
                workspaceId,
                snapshotId: environmentPackage.snapshotId,
              })
            )
          )
        );
        const publicList = ListAgentEnvironmentPackageSnapshotsResponseSchema.parse(
          operations['environment.snapshot-list']({ workspaceId })
        );
        for (const projected of [publicRead, publicList.items[0]!]) {
          expect(projected.snapshot.extensions.openkit).toEqual({
            turnInput: input,
            publicNote: literal,
          });
          expect(projected.contentDigest).toBe(record.contentDigest);
          expect(snapshotDigest(projected.snapshot)).toBe(record.contentDigest);
        }
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      if (db.sqlite.open) db.sqlite.close();
    }
  });

  it('carries a large frozen captured call, answers and result exactly through AEP preparation', () => {
    const db = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const now = '2026-07-06T00:00:01.000Z';
    const actor = { kind: 'user' as const, id: 'user_local' };
    const content = 'public fixture ghp_public-test-fixture "\\🙂'.repeat(3000);
    const args = {
      owner: 'fixture',
      repo: 'fixture',
      files: [{ path: 'fixture.test.ts', content }],
    };
    const result = {
      content: [{ type: 'text', text: 'Published fixture without truncation' }],
      isError: false,
    };
    const trigger = 'Independent trigger ghp_public-test-fixture';
    try {
      const common = {
        workspaceId: 'ws_1',
        threadId: 'th_1',
        raisingTurnId: 'turn_raising',
        requesterKind: 'worker' as const,
        agentId: 'agent_codex_host',
        responsibleUserId: 'user_local',
        now,
      };
      raisePendingRequest(db.sqlite, {
        ...common,
        requestId: 'ap_large',
        requestItemId: 'it_ap_large',
        kind: 'approval',
        approval: {
          kind: 'permission',
          title: 'Publish fixture',
          description: 'One exact captured call',
        },
        call: {
          serverId: 'github',
          catalogRevision: 'sha256:fixture',
          schemaSnapshotId: 'schema_fixture',
          toolName: 'push_files',
          canonicalArgumentsJson: JSON.stringify(args),
          argumentsDigest: mcpToolArgumentsContentDigest(args),
          packageDigest: null,
          policyDecisionId: null,
          authorizationContext: {
            threadId: 'th_1',
            turnId: 'turn_raising',
            agentSessionId: null,
            agentId: 'agent_codex_host',
            responsibleUserId: 'user_local',
            packageDigest: null,
            policyDecisionId: null,
          },
        },
      });
      expect(
        claimOrRefuseGrant(db.sqlite, 'ap_large', actor, now, () => ({ outcome: 'claim' })).applied
      ).toBe('claimed');
      expect(
        finishPendingExecution(
          db.sqlite,
          'ap_large',
          'approved-executed',
          'fixture-result',
          result,
          now
        )
      ).not.toBeNull();
      const questions = [
        {
          id: 'q',
          header: 'Question',
          question: 'Keep ghp_public-test-fixture exactly?',
          options: [],
        },
      ];
      const answers = { q: ['Yes ghp_public-test-fixture'] };
      raisePendingRequest(db.sqlite, {
        ...common,
        requestId: 'uq_large',
        requestItemId: 'it_uq_large',
        kind: 'user-input',
        questions,
      });
      answerPendingRequest(db.sqlite, 'uq_large', actor, answers, now);
      const freeze = (turnId: string) =>
        freezeReadyOutcomes(db.sqlite, {
          workspaceId: 'ws_1',
          threadId: 'th_1',
          turnId,
          executor: 'worker',
          agentId: 'agent_codex_host',
          cause: 'carried',
          now,
        });
      expect(freeze('turn_1')).toHaveLength(2);
      const input = frozenPendingOutcomeInput(db.sqlite, 'turn_1', trigger);
      expect(input.length).toBeGreaterThan(90000);
      const decoded = JSON.parse(input);
      expect(decoded.triggerInput).toBe(trigger);
      expect(decoded.pendingOutcomes[0]).toMatchObject({
        requestId: 'ap_large',
        requestItemId: 'it_ap_large',
        publicationTurnId: 'turn_1',
        request: { call: { serverId: 'github', toolName: 'push_files', arguments: args } },
        resolution: 'granted',
        disposition: 'approved-executed',
        reason: 'fixture-result',
        result,
      });
      expect(decoded.pendingOutcomes[1]).toMatchObject({ request: { questions }, answers });
      environmentPackage.extensions.openkit = { turnInput: input };
      const record = recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage,
        createdAt: now,
      });
      expect(record.snapshot.extensions.openkit).toEqual({ turnInput: input });
      expect(
        requireAgentEnvironmentPackageSnapshot(db, 'ws_1', record.snapshotId).snapshot.extensions
          .openkit
      ).toEqual({ turnInput: input });
      const { dataRoot, workspaceId } = db;
      db.sqlite.close();
      const reopened = openWorkspaceDb(dataRoot, workspaceId);
      try {
        expect(frozenPendingOutcomeInput(reopened.sqlite, 'turn_1', trigger)).toBe(input);
        releaseFrozenOutcomes(reopened.sqlite, 'turn_1', now);
        expect(
          freezeReadyOutcomes(reopened.sqlite, {
            workspaceId,
            threadId: 'th_1',
            turnId: 'turn_retry',
            executor: 'worker',
            agentId: 'agent_codex_host',
            cause: 'carried',
            now,
          })
        ).toHaveLength(2);
        expect(
          JSON.parse(frozenPendingOutcomeInput(reopened.sqlite, 'turn_retry', trigger))
        ).toEqual(decoded);
        expect(readPendingRequest(reopened.sqlite, 'ap_large')?.publicationTurnId).toBe('turn_1');
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      if (db.sqlite.open) db.sqlite.close();
    }
  });

  it.each([
    'credential-field',
    'native-environment',
  ] as const)('rejects forbidden %s during preparation without writing', (variant) => {
    const db = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    if (variant === 'credential-field')
      environmentPackage.extensions.fixture = { password: 'synthetic-value' };
    else
      environmentPackage.runtime.environment = {
        imageDigest: 'invalid-native-digest',
        defaultsDigest: 'invalid-native-digest',
        values: {},
      };
    try {
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(db, {
          environmentPackage,
          createdAt: '2026-07-06T00:00:01.000Z',
        })
      ).toThrow('The agent environment snapshot could not be prepared.');
      expect(existsSync(snapshotPath(db, environmentPackage))).toBe(false);
    } finally {
      db.sqlite.close();
    }
  });

  it('preserves public snapshot read refusal code and fixed text for corrupt retained JSON', () => {
    const db = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const operations = createEnvironmentOperationImplementations({
      repositoryWorkspaceDb: () => openWorkspaceDb(db.dataRoot, 'ws_1'),
    });
    try {
      recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage,
        createdAt: '2026-07-06T00:00:01.000Z',
      });
      writeFileSync(snapshotPath(db, environmentPackage), 'ROW_SECRET_X9');
      for (const read of [
        () =>
          operations['environment.snapshot-read']({
            workspaceId: 'ws_1',
            snapshotId: environmentPackage.snapshotId,
          }),
        () => operations['environment.snapshot-list']({ workspaceId: 'ws_1' }),
      ]) {
        try {
          read();
          throw new Error('Expected corrupt retained read refusal.');
        } catch (error) {
          expect(error).toBeInstanceOf(OperationError);
          expect(error).toMatchObject({
            code: 'not_found',
            status: 404,
            message: 'The retained record could not be read.',
          });
          expect(JSON.stringify(error)).not.toContain('ROW_SECRET_X9');
        }
      }
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    'construction',
    'record-validation',
  ] as const)('publishes truthful fixed %s and retained-read messages through nested causes and aggregates', (phase) => {
    const db = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const marker = 'ROW_SECRET_X9';
    const caught = (operation: () => unknown): Error => {
      try {
        operation();
      } catch (error) {
        return error as Error;
      }
      throw new Error('Expected failure');
    };
    try {
      const invalid = { ...environmentPackage, schemaVersion: marker } as never;
      const preparation = caught(() =>
        recordAgentEnvironmentPackageSnapshot(db, {
          environmentPackage: phase === 'construction' ? invalid : environmentPackage,
          createdAt: phase === 'record-validation' ? '' : '2026-07-06T00:00:01.000Z',
        })
      );
      expect(preparation.constructor.name).toBe('AgentEnvironmentSnapshotPreparationError');
      expect(preparation.cause).toBeInstanceOf(Error);
      expect(existsSync(snapshotPath(db, environmentPackage))).toBe(false);
      recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage,
        createdAt: '2026-07-06T00:00:01.000Z',
      });
      const path = snapshotPath(db, environmentPackage);
      writeFileSync(path, marker);
      const read = caught(() =>
        requireAgentEnvironmentPackageSnapshot(db, 'ws_1', environmentPackage.snapshotId)
      );
      for (const [error, message] of [
        [preparation, 'The agent environment snapshot could not be prepared.'],
        [read, 'The retained record could not be read.'],
      ] as const) {
        for (const wrapped of [
          error,
          new Error(marker, { cause: error }),
          new AggregateError(
            [new SyntaxError(marker), new Error(marker, { cause: error })],
            marker
          ),
          new AggregateError([error, new SyntaxError(marker)], marker),
        ]) {
          expect(publishedErrorMessage(wrapped)).toBe(message);
          expect(publishedErrorMessage(wrapped)).not.toContain(marker);
        }
      }
      expect(readFileSync(path, 'utf8')).toBe(marker);
    } finally {
      db.sqlite.close();
    }
  });

  it('persists and reloads the redacted record from its canonical session path', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    const path = snapshotPath(workspaceDb, environmentPackage);
    const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: '2026-07-06T00:00:01.000Z',
      environmentPackage,
    });

    expect.soft(existsSync(path)).toBe(true);
    expect.soft(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null).toEqual(record);
    expect(record).toMatchObject({
      snapshotId: environmentPackage.snapshotId,
      workspaceId: 'ws_1',
      turnId: 'turn_1',
      agentSessionId: 'as_1',
      agentId: 'agent_codex_host',
      packageId: environmentPackage.packageId,
    });
    expect(record.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record.snapshot)).not.toContain('sk-');

    const { dataRoot, workspaceId } = workspaceDb;
    workspaceDb.sqlite.close();
    const reopened = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(reopened);

    try {
      expect(
        requireAgentEnvironmentPackageSnapshot(reopened, 'ws_1', environmentPackage.snapshotId)
      ).toEqual(record);
      expect(listExportableAgentEnvironmentPackageSnapshots(reopened, 'ws_1')).toEqual([record]);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('keeps current-writer stored and parsed snapshot digests identical', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const stored = JSON.parse(
        readFileSync(snapshotPath(workspaceDb, environmentPackage), 'utf8')
      );
      const parsed = AgentEnvironmentPackageSchema.parse(stored.snapshot);
      const storedDigest = createHash('sha256')
        .update(JSON.stringify(stored.snapshot))
        .digest('hex');
      const parsedDigest = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');

      expect(storedDigest).toBe(record.contentDigest);
      expect(parsedDigest).toBe(storedDigest);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(stored.snapshot));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('validates retained snapshot identity before stripping an ignored transcript field', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      retained.snapshot.control.transcript.artifactsPath = '/openkit/session/artifacts.jsonl';
      retained.contentDigest = createHash('sha256')
        .update(JSON.stringify(retained.snapshot))
        .digest('hex');
      const originalBytes = `${JSON.stringify(retained, null, 2)}\n`;
      writeFileSync(path, originalBytes);

      const read = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        'ws_1',
        environmentPackage.snapshotId
      );

      expect(read.contentDigest).toBe(retained.contentDigest);
      expect(read.retainedSnapshot).toEqual(retained.snapshot);
      expect(snapshotDigest(read.retainedSnapshot)).toBe(retained.contentDigest);
      expect(JSON.parse(JSON.stringify(read))).not.toHaveProperty('retainedSnapshot');
      expect(
        listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')[0]!.snapshot
      ).toEqual(read.snapshot);
      expect(read.snapshot.control.transcript).not.toHaveProperty('artifactsPath');
      expect(read.snapshot.control.transcript.itemsPath).toBe(
        environmentPackage.control.transcript.itemsPath
      );
      expect(readFileSync(path, 'utf8')).toBe(originalBytes);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rewrites and reopens a valid extended snapshot without invalidating its retained digest', () => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const retained = JSON.parse(readFileSync(snapshotPath(source, environmentPackage), 'utf8'));
      retained.snapshot.control.transcript.retiredDescription = 'inert';
      retained.contentDigest = snapshotDigest(retained.snapshot);
      writeFileSync(snapshotPath(source, environmentPackage), JSON.stringify(retained));
      const read = requireAgentEnvironmentPackageSnapshot(
        source,
        'ws_1',
        environmentPackage.snapshotId
      );
      expect(read.snapshot.control.transcript).not.toHaveProperty('retiredDescription');
      importAgentEnvironmentPackageSnapshots(target, [read]);
      const written = JSON.parse(readFileSync(snapshotPath(target, environmentPackage), 'utf8'));
      expect(snapshotDigest(written.snapshot)).toBe(written.contentDigest);
      expect(written.snapshot).toEqual(retained.snapshot);
      const { dataRoot, workspaceId } = target;
      target.sqlite.close();
      const reopened = openWorkspaceDb(dataRoot, workspaceId);
      try {
        const reread = requireAgentEnvironmentPackageSnapshot(
          reopened,
          workspaceId,
          environmentPackage.snapshotId
        );
        expect(reread.contentDigest).toBe(retained.contentDigest);
        expect(reread.snapshot).toEqual(read.snapshot);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      source.sqlite.close();
      if (target.sqlite.open) target.sqlite.close();
    }
  });

  it.each([
    ['password', 'synthetic-review-password'],
    ['backendSessionId', 'synthetic-private-handle'],
    ['annotation', '/Users/synthetic/private-location'],
  ])('refuses digest-valid unsafe original %s before read, publication or export', (key, value) => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(source, environmentPackage);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      retained.snapshot.scope[key] = value;
      retained.contentDigest = snapshotDigest(retained.snapshot);
      const unsafeBytes = JSON.stringify(retained);
      writeFileSync(path, unsafeBytes);
      expect(() =>
        requireAgentEnvironmentPackageSnapshot(source, 'ws_1', environmentPackage.snapshotId)
      ).toThrow();
      expect(() => importAgentEnvironmentPackageSnapshots(target, [retained])).toThrow();
      expect(existsSync(snapshotPath(target, environmentPackage))).toBe(false);
      expect(() => listExportableAgentEnvironmentPackageSnapshots(source, 'ws_1')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(unsafeBytes);
      expect(snapshotDigest(JSON.parse(readFileSync(path, 'utf8')).snapshot)).toBe(
        retained.contentDigest
      );
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it.each([
    ['root', 'password', 'synthetic-review-password'],
    ['root', 'annotation', '/Users/synthetic/private-location'],
    ['root', 'annotation', 'runtime://synthetic/private-ref'],
    ['runtime', 'password', 'synthetic-review-password'],
    ['runtime', 'annotation', '/Users/synthetic/private-location'],
    ['runtime', 'annotation', 'runtime://synthetic/private-ref'],
  ])('refuses digest-valid dotted %s key with unsafe %s value %s', (location, key, value) => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(source, environmentPackage);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      if (location === 'root') retained.snapshot['runtime.environment.values'] = { [key!]: value };
      else retained.snapshot.runtime['environment.values'] = { [key!]: value };
      retained.contentDigest = snapshotDigest(retained.snapshot);
      const unsafeBytes = JSON.stringify(retained);
      writeFileSync(path, unsafeBytes);
      expect(snapshotDigest(retained.snapshot)).toBe(retained.contentDigest);
      expect
        .soft(() =>
          requireAgentEnvironmentPackageSnapshot(source, 'ws_1', environmentPackage.snapshotId)
        )
        .toThrow();
      expect.soft(() => importAgentEnvironmentPackageSnapshots(target, [retained])).toThrow();
      expect.soft(existsSync(snapshotPath(target, environmentPackage))).toBe(false);
      expect.soft(() => listExportableAgentEnvironmentPackageSnapshots(source, 'ws_1')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(unsafeBytes);
      expect(snapshotDigest(JSON.parse(readFileSync(path, 'utf8')).snapshot)).toBe(
        retained.contentDigest
      );
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it('preserves public native-environment literals through original safety checks and publication', () => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    environmentPackage.runtime.environment = {
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${'b'.repeat(64)}`,
      values: {
        token: 'public literal',
        PATH: '/Users/public/tools',
        VENDOR: 'runtime://public/literal',
      },
    };
    try {
      const record = recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      importAgentEnvironmentPackageSnapshots(target, [record]);
      expect(
        listExportableAgentEnvironmentPackageSnapshots(target, 'ws_1')[0]!.snapshot.runtime
          .environment
      ).toEqual(environmentPackage.runtime.environment);
      expect(
        snapshotDigest(
          JSON.parse(readFileSync(snapshotPath(target, environmentPackage), 'utf8')).snapshot
        )
      ).toBe(record.contentDigest);
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it('refuses a changed supplied core alongside an unchanged retained-original round trip', () => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(source, environmentPackage);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      retained.snapshot.scope.annotation = 'inert';
      retained.contentDigest = snapshotDigest(retained.snapshot);
      writeFileSync(path, JSON.stringify(retained));
      const read = requireAgentEnvironmentPackageSnapshot(
        source,
        'ws_1',
        environmentPackage.snapshotId
      );
      importAgentEnvironmentPackageSnapshots(target, [read]);
      const publishedBytes = readFileSync(snapshotPath(target, environmentPackage), 'utf8');
      Object.assign(read.snapshot, { packageId: 'aep_changed' });
      expect(() => importAgentEnvironmentPackageSnapshots(target, [read])).toThrow(
        'retained core mismatch'
      );
      expect(readFileSync(snapshotPath(target, environmentPackage), 'utf8')).toBe(publishedBytes);
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it.each([
    ['scope'],
    ['scope', 'triggerActor'],
    ['agent'],
    ['agent', 'instructions', 0],
    ['agent', 'instructions', 0, 'integrity'],
    ['observability'],
    ['observability', 'captureCoverage'],
    ['observability', 'audit'],
    ['runtime'],
    ['runtime', 'image'],
    ['control', 'transcript'],
  ])('reads and republishes descriptive AEP annotations at %j', (...path) => {
    const source = createWorkspaceDb();
    const target = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    environmentPackage.agent.instructions = [
      {
        id: 'instruction_fact',
        kind: 'reference',
        sourceRef: 'instructions://fact',
        workerPath: '/openkit/instructions/fact.md',
        integrity: { sha256: 'a'.repeat(64) },
      },
    ];
    try {
      recordAgentEnvironmentPackageSnapshot(source, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const retained = JSON.parse(readFileSync(snapshotPath(source, environmentPackage), 'utf8'));
      let annotated = retained.snapshot;
      for (const key of path) annotated = annotated[key];
      annotated.annotation = 'inert';
      retained.annotation = 'record';
      retained.retainedSnapshot = { ignored: 'untrusted metadata cannot replace snapshot bytes' };
      retained.contentDigest = snapshotDigest(retained.snapshot);
      writeFileSync(snapshotPath(source, environmentPackage), JSON.stringify(retained));
      const read = requireAgentEnvironmentPackageSnapshot(
        source,
        'ws_1',
        environmentPackage.snapshotId
      );
      expect(read).not.toHaveProperty('annotation');
      expect(read.snapshot).toEqual(environmentPackage);
      importAgentEnvironmentPackageSnapshots(target, [read]);
      const reread = requireAgentEnvironmentPackageSnapshot(
        target,
        'ws_1',
        environmentPackage.snapshotId
      );
      expect(reread.retainedSnapshot).toEqual(retained.snapshot);
      expect(
        snapshotDigest(
          JSON.parse(readFileSync(snapshotPath(target, environmentPackage), 'utf8')).snapshot
        )
      ).toBe(retained.contentDigest);
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it('rejects altered stored content even when the altered transcript field would be ignored', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();
    try {
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      retained.snapshot.control.transcript.artifactsPath = '/openkit/session/artifacts.jsonl';
      retained.contentDigest = createHash('sha256')
        .update(JSON.stringify(retained.snapshot))
        .digest('hex');
      writeFileSync(path, `${JSON.stringify(retained)}\n`);
      // Establish the valid retained record before testing a mutation hidden from the live projection.
      requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId);
      retained.snapshot.control.transcript.artifactsPath = '/openkit/session/changed.jsonl';
      writeFileSync(path, `${JSON.stringify(retained)}\n`);

      expect(() =>
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toThrow('Agent environment package snapshot digest mismatch');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects V1 snapshots through every normal ledger path', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const legacyScope = { ...record.snapshot.scope } as Record<string, unknown>;
      delete legacyScope.triggerActor;
      legacyScope.userId = 'user_local';
      const legacyRecord = {
        ...record,
        snapshot: { ...record.snapshot, schemaVersion: 1, scope: legacyScope },
      };
      legacyRecord.contentDigest = snapshotDigest(legacyRecord.snapshot);
      writeFileSync(
        snapshotPath(workspaceDb, environmentPackage),
        `${JSON.stringify(legacyRecord)}\n`
      );

      for (const operation of [
        () =>
          requireAgentEnvironmentPackageSnapshot(
            workspaceDb,
            'ws_1',
            environmentPackage.snapshotId
          ),
        () =>
          recordAgentEnvironmentPackageSnapshot(workspaceDb, {
            createdAt: '2026-07-06T00:00:02.000Z',
            environmentPackage: legacyRecord.snapshot as never,
          }),
      ]) {
        try {
          operation();
          throw new Error('Expected V1 rejection.');
        } catch (error) {
          expect((error as Error).cause).toMatchObject({
            issues: expect.arrayContaining([expect.objectContaining({ path: ['schemaVersion'] })]),
          });
        }
      }

      expect(() =>
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toThrow('The retained record could not be read.');
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow(
        'The retained record could not be read.'
      );
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-07-06T00:00:02.000Z',
          environmentPackage: legacyRecord.snapshot as never,
        })
      ).toThrow('The agent environment snapshot could not be prepared.');
      expect(() =>
        importAgentEnvironmentPackageSnapshots(workspaceDb, [legacyRecord as never])
      ).toThrow(/schemaVersion/);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('fails closed when canonical snapshot content, lineage, or digest is tampered', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const tamperedRecords = [
        {
          ...record,
          snapshot: { ...record.snapshot, packageId: 'aep_tampered' },
        },
        { ...record, agentSessionId: 'as_tampered' },
        { ...record, contentDigest: '0'.repeat(64) },
      ];

      mkdirSync(dirname(path), { recursive: true });
      for (const tamperedRecord of tamperedRecords) {
        writeFileSync(path, `${JSON.stringify(tamperedRecord, null, 2)}\n`);

        expect
          .soft(() =>
            requireAgentEnvironmentPackageSnapshot(
              workspaceDb,
              'ws_1',
              environmentPackage.snapshotId
            )
          )
          .toThrow();
        expect
          .soft(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1'))
          .toThrow();
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects symbolic links for canonical snapshot and session entries', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const record = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const path = snapshotPath(workspaceDb, environmentPackage);
      const linkedSnapshotTarget = `${path}.target`;

      writeFileSync(linkedSnapshotTarget, `${JSON.stringify(record, null, 2)}\n`);
      rmSync(path);
      symlinkSync(linkedSnapshotTarget, path);
      expect(() =>
        requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_1', environmentPackage.snapshotId)
      ).toThrow();
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow();

      const sessionRoot = dirname(dirname(path));
      const linkedSessionTarget = join(dirname(dirname(sessionRoot)), 'aep-session-symlink-target');

      rmSync(sessionRoot, { recursive: true, force: true });
      mkdirSync(join(linkedSessionTarget, 'aep-snapshots'), { recursive: true });
      writeFileSync(
        join(linkedSessionTarget, 'aep-snapshots', `${environmentPackage.snapshotId}.json`),
        `${JSON.stringify(record, null, 2)}\n`
      );
      symlinkSync(linkedSessionTarget, sessionRoot, 'dir');
      expect(() => listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_1')).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('is idempotent for the same snapshot and rejects conflicting content for the same id', () => {
    const workspaceDb = createWorkspaceDb();
    const environmentPackage = createEnvironmentPackage();

    try {
      const first = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:01.000Z',
        environmentPackage,
      });
      const replay = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-06T00:00:02.000Z',
        environmentPackage,
      });
      const conflictingPackage = AgentEnvironmentPackageSchema.parse({
        ...environmentPackage,
        scope: { ...environmentPackage.scope, requestId: 'req_conflict' },
      });

      expect(replay).toEqual(first);
      expect(() =>
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-07-06T00:00:03.000Z',
          environmentPackage: conflictingPackage,
        })
      ).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
