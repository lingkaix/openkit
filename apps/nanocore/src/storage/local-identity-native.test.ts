import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import {
  createSourceFile,
  isFunctionDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from 'typescript6';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser, getLocalUserId } from '../auth/identity.js';
import { type BootPhase, runBootPhases } from '../bootstrap/phases.js';
import { closeActiveLocalAiSupervisor } from '../local-ai/supervisor.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const fixtures: Array<{ root: string; db: CoreDb }> = [];
const pending: Array<Promise<unknown>> = [];
afterEach(async () => {
  releaseCommit();
  await Promise.allSettled(pending.splice(0));
  await shutdownControlStoreWorkerClient();
  await closeActiveLocalAiSupervisor();
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Creates genuine fresh Core authority, without manufacturing initialization permission. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-local-identity-native-'));
  const db = openCoreDb(root);
  fixtures.push({ root, db });
  applyMigrations(db);
  return { root, db };
}

/**
 * Executes the actual entrypoint phase without starting unrelated process services.
 * The phase body and initializer remain real; only subsequent recovery is an observer.
 */
function localIdentityPhase(db: CoreDb, mode: 'local' | 'server'): BootPhase {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const file = createSourceFile('index.ts', source, ScriptTarget.Latest, true);
  let phase: string | undefined;
  file.forEachChild(function visit(node) {
    if (
      isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          isPropertyAssignment(property) &&
          property.name.getText(file) === 'name' &&
          isStringLiteral(property.initializer) &&
          property.initializer.text === 'local-identity'
      )
    )
      phase = node.getText(file);
    node.forEachChild(visit);
  });
  const requireValue = file.statements.find(
    (node) => isFunctionDeclaration(node) && node.name?.text === 'requireBootValue'
  );
  if (!phase || !requireValue) throw new Error('Entrypoint local-identity phase was not found.');
  const javascript = transpileModule(`${requireValue.getText(file)}\nconst phase = ${phase};`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function('ensureLocalUser', 'coreDb', 'mode', `${javascript}\nreturn phase;`)(
    ensureLocalUser,
    db,
    mode
  ) as BootPhase;
}

describe('canonical local identity native boot seam', () => {
  it('refuses synchronous App construction without boot authority and creates no User', () => {
    const { root, db } = fixture();
    // App construction consumes the established User; only boot can initialize it.
    expect(() => createApp({ coreDb: db, dataRoot: root, mode: 'local' })).toThrow();
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(() => getLocalUserId(db)).toThrow();
  });

  it('initializes fresh authority with Main query-only and returns the recorded User', async () => {
    const { db } = fixture();
    db.sqlite.pragma('query_only = ON');
    // Storage, SQLite Layers: the complete family write belongs off Main.
    const id = await ensureLocalUser(db);
    expect(id).toMatch(/^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getLocalUserId(db)).toBe(id);
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([{ id }]);
    expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(db.sqlite.inTransaction).toBe(false);
  });

  it('joins the real FULL commit acknowledgement before recovery and boot admission', async () => {
    const { root, db } = fixture();
    db.sqlite.pragma('query_only = ON');
    const scope = nativeProductScope(root, { kind: 'server' });
    // Complete physical opening first so the hold selects identity, not migration SQL.
    await getControlStoreWorkerClient().open({
      database: `core:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    let recoveredUser: string | undefined;
    const phase = localIdentityPhase(db, 'local');
    const held = await heldCommit(2, () => {
      const boot = runBootPhases({
        bootId: 'local-identity-oracle',
        phases: [
          phase,
          {
            name: 'scheduler-restart-recovery',
            subsystem: 'scheduler',
            critical: true,
            run: () => {
              recoveredUser = getLocalUserId(db);
              return { status: 'ok' };
            },
          },
        ],
      });
      pending.push(boot);
      return boot;
    });
    // Bootstrap, Boot phases: identity is critical and must finish before recovery.
    // The real transaction has committed; heldCommit also checks synchronous=FULL.
    const committedUser = getLocalUserId(db);
    expect(recoveredUser).toBeUndefined();
    expect(db.sqlite.inTransaction).toBe(false);
    releaseCommit();
    const result = await held.result;
    expect(recoveredUser).toBe(committedUser);
    expect(result.outcomes.map(({ outcome }) => outcome.status)).toEqual(['ok', 'ok']);
    expect(result.readiness.acceptingProductWork).toBe(true);
    expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  });

  it('refuses missing initialized authority before recovery without minting a replacement', async () => {
    const { db } = fixture();
    const id = await ensureLocalUser(db);
    db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    const recovery = vi.fn(() => ({ status: 'ok' as const }));
    const result = await runBootPhases({
      bootId: 'local-identity-missing',
      phases: [
        localIdentityPhase(db, 'local'),
        { name: 'recovery', subsystem: 'scheduler', critical: true, run: recovery },
      ],
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.outcome.status).toBe('failed');
    expect(result.readiness.acceptingProductWork).toBe(false);
    expect(recovery).not.toHaveBeenCalled();
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
  });

  it('performs no synthetic User write in the actual server-mode identity phase', async () => {
    const { db } = fixture();
    db.sqlite.pragma('query_only = ON');
    const result = await runBootPhases({
      bootId: 'server-identity-oracle',
      phases: [localIdentityPhase(db, 'server')],
    });
    expect(result.outcomes[0]?.outcome.status).toBe('ok');
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
  });
});

describe('automatic local App fixture authority', () => {
  it('refuses a used deployment whose established local User is missing', async () => {
    const { root, db } = fixture();
    const id = await ensureLocalUser(db);
    // Core Identity, Implicit Local Human: a used empty lookup grants no replacement.
    db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    expect(db.canInitializeLocalUser).toBe(false);

    expect(() =>
      createAppWithLocalIdentity({ coreDb: db, dataRoot: root, mode: 'local' })
    ).toThrow();
    expect(db.sqlite.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(() => getLocalUserId(db)).toThrow();
  });

  it('refuses fresh local allocation when a nonlocal Human already occupies Core', async () => {
    const { root, db } = fixture();
    const scope = nativeProductScope(root, { kind: 'server' });
    const client = getControlStoreWorkerClient();
    const database = `core:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const id = allocateEntityId('usr');
    const now = new Date();
    await client.betterAuth(database, {
      kind: 'human-create',
      requireBootstrap: false,
      record: {
        id,
        displayName: 'Existing Human',
        email: 'existing-human@example.invalid',
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
        kind: 'human',
        lastSeenAt: null,
        status: 'active',
        disabledAt: null,
      },
    });
    expect(db.canInitializeLocalUser).toBe(true);
    // Fresh initialization cannot select another Human or add a synthetic replacement.
    expect(() =>
      createAppWithLocalIdentity({ coreDb: db, dataRoot: root, mode: 'local' })
    ).toThrow();
    expect(db.sqlite.prepare('SELECT id, kind FROM users').all()).toEqual([{ id, kind: 'human' }]);
    expect(() => getLocalUserId(db)).toThrow();
  });
});
