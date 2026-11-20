import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { nanoHostStoreDescriptor } from '../storage/nanohost-store-descriptor.js';
import { disposeTestStore } from '../test-support/store.js';
import {
  admitWorkerImageEnvironment,
  readAdmittedWorkerImageEnvironment,
  WorkerImageSettlementConflict,
  writeWorkerImageSettlement,
} from './worker-image-settlements.js';
import {
  admitWorkerImageEnvironment as admitNativeWorkerImageEnvironment,
  insertWorkerImageSettlementInTransaction,
  readWorkerImageSettlement,
  type WorkerImageSettlement,
} from './worker-image-settlements-records.js';

const imageDigest = `sha256:${'d'.repeat(64)}`;
const defaultsDigest = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const candidate = {
  authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
  authoredArtifactVersion: 1 as const,
  authoredContentDigest: `sha256:${'a'.repeat(64)}`,
  inputDigest: `sha256:${'b'.repeat(64)}`,
};

describe('confirmed image environment settlement', () => {
  it('withholds defaults until exact confirmation and carries admission across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-native-env-'));
    let db = openCoreDb(root);
    try {
      applyMigrations(db);
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: {},
          })
      ).rejects.toThrow(WorkerImageSettlementConflict);
      await writeWorkerImageSettlement(db, {
        ...candidate,
        requestId: '1'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await expect(
        async () =>
          await admitWorkerImageEnvironment(
            db,
            { ...candidate, authoredContentDigest: `sha256:${'c'.repeat(64)}` },
            { imageDigest, defaultsDigest, values: {} }
          )
      ).rejects.toThrow(WorkerImageSettlementConflict);
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: { CHANGED: 'x' },
          })
      ).rejects.toThrow();
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      db.sqlite.close();
      db = openCoreDb(root);
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual({
        imageDigest,
        defaultsDigest,
        values: {},
      });
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: { CHANGED: 'x' },
          })
      ).rejects.toThrow();
      const extended = JSON.stringify(
        { imageDigest, defaultsDigest, values: {}, note: 'inert future metadata' },
        null,
        2
      );
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(extended, '1'.repeat(64));
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      expect(
        db.sqlite
          .prepare(
            'SELECT native_environment_json AS bytes FROM worker_image_settlements WHERE request_id = ?'
          )
          .get('1'.repeat(64))
      ).toEqual({ bytes: extended });
    } finally {
      await disposeTestStore(root, db);
    }
  });
  it('refuses conflicting second admission before writing and revalidates durable bytes on read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-native-env-conflict-'));
    const db = openCoreDb(root);
    try {
      applyMigrations(db);
      const second = {
        ...candidate,
        authoredArtifactId: 'ar_00000000-0000-7715-a7ab-a9e022886a62',
      };
      await writeWorkerImageSettlement(db, {
        ...candidate,
        requestId: '1'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      await writeWorkerImageSettlement(db, {
        ...second,
        requestId: '2'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      const values = { CHANGED: 'literal' };
      const changedDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, second, {
            imageDigest,
            defaultsDigest: changedDigest,
            values,
          })
      ).rejects.toThrow();
      expect(
        db.sqlite
          .prepare(
            'SELECT native_environment_json AS environment FROM worker_image_settlements WHERE request_id = ?'
          )
          .get('2'.repeat(64))
      ).toEqual({ environment: null });
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(
          JSON.stringify({ imageDigest: `sha256:${'e'.repeat(64)}`, defaultsDigest, values: {} }),
          '1'.repeat(64)
        );
      expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow();
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(
          JSON.stringify({ imageDigest, defaultsDigest, values: { CHANGED: 'x' } }),
          '1'.repeat(64)
        );
      expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow();
    } finally {
      await disposeTestStore(root, db);
    }
  });
});

const acquisition = {
  ...candidate,
  requestId: '1'.repeat(64),
  operation: 'image.acquire',
  outcome: { kind: 'success', imageDigest },
} satisfies WorkerImageSettlement;
const failedBuild = {
  ...candidate,
  requestId: '2'.repeat(64),
  operation: 'image.build',
  outcome: { kind: 'failure', failureCode: 'effect_failed' },
} satisfies WorkerImageSettlement;

/** Builds a confirmed environment with a valid digest for these fixture values. */
function defaults(values: Record<string, string>) {
  const digest = createHash('sha256').update(canonicalNativeEnvironment(values), 'utf8');
  return { imageDigest, defaultsDigest: `sha256:${digest.digest('hex')}`, values };
}

it('reopens exact NanoHost image records and refuses changed replays and defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-image-settlement-'));
  const path = join(root, 'server/extensions', nanoHostStoreDescriptor.owner, 'state.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  let sqlite = new Database(path);
  onTestFinished(() => {
    if (sqlite.open) sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });
  const migrationsFolder = fileURLToPath(
    new URL('../../drizzle/extensions/nanohost/', import.meta.url)
  );
  migrate(drizzle(sqlite), { migrationsFolder });

  const insert = (value: WorkerImageSettlement) =>
    sqlite
      .transaction(() => insertWorkerImageSettlementInTransaction({ sqlite }, value))
      .immediate();
  const admit = (record: ReturnType<typeof defaults>) =>
    admitNativeWorkerImageEnvironment({ sqlite }, candidate, record);

  const unordered = defaults({ Z_LAST: 'z', A_FIRST: 'a' });
  const canonical = defaults({ A_FIRST: 'a', Z_LAST: 'z' });
  expect(readWorkerImageSettlement({ sqlite }, acquisition.requestId)).toBeNull();
  expect(() => admit(unordered)).toThrow(WorkerImageSettlementConflict);
  expect(insert(failedBuild)).toStrictEqual(failedBuild);
  expect(() => admit(unordered)).toThrow(WorkerImageSettlementConflict);
  expect(insert(acquisition)).toStrictEqual(acquisition);
  expect(readAdmittedWorkerImageEnvironment({ sqlite }, imageDigest)).toBeNull();
  admit(unordered);

  sqlite.close();
  sqlite = new Database(path, { fileMustExist: true });
  expect(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name"
      )
      .pluck()
      .all()
  ).toEqual(nanoHostStoreDescriptor.requiredTables);
  expect(readWorkerImageSettlement({ sqlite }, acquisition.requestId)).toEqual(acquisition);
  expect(readWorkerImageSettlement({ sqlite }, failedBuild.requestId)).toEqual(failedBuild);
  expect(readAdmittedWorkerImageEnvironment({ sqlite }, imageDigest)).toEqual(canonical);
  expect(
    sqlite
      .prepare('SELECT native_environment_json FROM worker_image_settlements WHERE request_id = ?')
      .pluck()
      .get(acquisition.requestId)
  ).toBe(JSON.stringify(canonical));

  expect(insert(acquisition)).toBeNull();
  expect(insert(failedBuild)).toBeNull();
  admit(canonical);
  const changes = sqlite.prepare('SELECT total_changes()').pluck();
  expect(changes.get()).toBe(0);

  const changesToOriginal: Partial<WorkerImageSettlement>[] = [
    { operation: failedBuild.operation },
    { authoredArtifactId: 'ar_00000000-0000-7715-a7ab-a9e022886a62' },
    { authoredContentDigest: `sha256:${'e'.repeat(64)}` },
    { inputDigest: `sha256:${'f'.repeat(64)}` },
    { outcome: { ...acquisition.outcome, imageDigest: `sha256:${'0'.repeat(64)}` } },
    { outcome: failedBuild.outcome },
  ];
  for (const change of changesToOriginal) {
    expect(() => insert({ ...acquisition, ...change })).toThrow(WorkerImageSettlementConflict);
  }
  expect(() => admit(defaults({ A_FIRST: 'changed' }))).toThrow(WorkerImageSettlementConflict);
  expect(changes.get()).toBe(0);
  expect(readWorkerImageSettlement({ sqlite }, acquisition.requestId)).toEqual(acquisition);
  expect(readAdmittedWorkerImageEnvironment({ sqlite }, imageDigest)).toEqual(canonical);
});
