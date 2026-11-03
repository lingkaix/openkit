import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb, openWorkspaceReadDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  acceptWorkspaceBaseline as publishAcceptedBaseline,
  authorizeWorkspaceBaselineInitialization as publishBaselineInitialization,
} from './workspace-baseline-publication.js';
import {
  acceptAppliedWorkspaceSnapshot,
  acceptWorkspaceBaseline,
  acceptWorkspaceCapture,
  authorizeWorkspaceBaselineInitialization,
  linkWorkspaceSnapshotReview,
  readWorkspaceBaselineIdentity,
  readWorkspaceCollection,
  readWorkspaceSnapshotCursor,
  requireWorkspaceBaselineInitialization,
  type WorkspaceCollectionIdentity,
  workspaceSnapshotAcceptedCommitIsKnown,
  workspaceSnapshotReviewIsStale,
} from './workspace-snapshot-chain.js';

const identity: WorkspaceCollectionIdentity = {
  workspaceId: 'ws_00000000-0000-72e6-b64c-541357b6c42e',
  storageRef: 'wst_01890f3e-0000-7000-8000-000000000001',
  scopeDigest: `sha256:${'1'.repeat(64)}`,
  attachmentGeneration: 1,
  sandboxId: 'sandbox',
  workSlot: 'slot',
  collectionId: 'baseline',
  agentSessionId: 'as_01890f3e-0000-7000-8000-000000000001',
  threadId: 'th_01890f3e-0000-7000-8000-000000000001',
  turnId: 'tu_01890f3e-0000-7000-8000-000000000001',
  packageSnapshotId: 'package',
};
const base = { tree: '1'.repeat(40), manifest: '2'.repeat(40) };
const next = { tree: '3'.repeat(40), manifest: '4'.repeat(40) };
function fixture() {
  const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'snapshot-chain-')), identity.workspaceId);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  return db;
}
describe('durable snapshot chain', () => {
  it('refuses a retained collection whose storage reference has the wrong kind', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const capture = { ...identity, collectionId: 'kind-boundary' };
      acceptWorkspaceCapture(db, capture, { outcome: 'no_new_head', unstable: false }, null);
      const invalid = { ...capture, storageRef: identity.storageRef.replace('wst_', 'ws_') };
      db.sqlite
        .prepare('UPDATE workspace_snapshot_collections SET storage_ref = ?, identity_json = ?')
        .run(invalid.storageRef, JSON.stringify(invalid));
      expect(() => readWorkspaceCollection(db, invalid)).toThrow();
    } finally {
      db.sqlite.close();
    }
  });
  it('compares stored identity core while tolerating additive collection and baseline members', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      db.sqlite
        .prepare('UPDATE workspace_snapshot_cursors SET baseline_identity_json = ?')
        .run(JSON.stringify({ ...identity, futureDescription: 'harmless' }));
      expect(() => requireWorkspaceBaselineInitialization(db, identity)).not.toThrow();
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const capture = { ...identity, collectionId: 'additive' };
      const receipt = acceptWorkspaceCapture(
        db,
        capture,
        { outcome: 'no_new_head', unstable: false },
        null
      );
      db.sqlite
        .prepare('UPDATE workspace_snapshot_collections SET identity_json = ?')
        .run(JSON.stringify({ ...capture, futureDescription: 'harmless' }));
      expect(readWorkspaceCollection(db, capture)).toEqual(receipt);
      for (const bad of [
        { ...capture, scopeDigest: 'bad' },
        { ...capture, attachmentGeneration: 0 },
        { ...capture, turnId: 'foreign' },
        { ...capture, turnId: undefined },
      ]) {
        db.sqlite
          .prepare('UPDATE workspace_snapshot_collections SET identity_json = ?')
          .run(JSON.stringify(bad));
        expect(() => readWorkspaceCollection(db, capture)).toThrow();
        if (bad.scopeDigest === 'bad' || bad.attachmentGeneration === 0) {
          expect(() => readWorkspaceCollection(db, bad as typeof capture)).toThrow();
        }
        db.sqlite
          .prepare('UPDATE workspace_snapshot_cursors SET baseline_identity_json = ?')
          .run(JSON.stringify({ ...bad, collectionId: identity.collectionId }));
        expect(() => requireWorkspaceBaselineInitialization(db, identity)).toThrow();
        if (bad.scopeDigest === 'bad' || bad.attachmentGeneration === 0) {
          expect(() =>
            requireWorkspaceBaselineInitialization(db, {
              ...bad,
              collectionId: identity.collectionId,
            } as typeof identity)
          ).toThrow();
        }
      }
    } finally {
      db.sqlite.close();
    }
  });
  it('replays exact bytes after a cold database reopen and refuses damaged credential evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-restart-'));
    let db = openWorkspaceDb(root, identity.workspaceId);
    applyScopedMigrations(db, undefined, 'pre-knowledge');
    const capture = { ...identity, collectionId: 'cold' };
    const result = {
      outcome: 'candidate',
      head: next,
      previousHead: base,
      acceptedBase: base,
      unstable: false,
    };
    const bytes = Buffer.from('exact cumulative bytes');
    authorizeWorkspaceBaselineInitialization(db, identity);
    acceptWorkspaceBaseline(db, identity, base, base.tree, 'a'.repeat(40));
    const receipt = acceptWorkspaceCapture(db, capture, result, bytes);
    db.sqlite.close();
    db = openWorkspaceDb(root, identity.workspaceId);
    try {
      expect(readWorkspaceCollection(db, capture)).toEqual(receipt);
      expect(() => acceptWorkspaceCapture(db, capture, result, bytes)).not.toThrow();
      expect(acceptWorkspaceCapture(db, capture, result, bytes)).toEqual(receipt);
      expect(readWorkspaceSnapshotCursor(db, capture)).toEqual({
        acceptedBase: base,
        head: next,
        acceptedCommit: 'a'.repeat(40),
      });
      for (const corrupted of [
        { ...receipt.result, credentialCheck: 'unknown' },
        { ...receipt.result, collectedAt: 'unknown-time' },
        { ...receipt.result, outcome: 'future_capture' },
        { ...receipt.result, head: { tree: next.tree, manifest: 'broken' } },
      ]) {
        db.sqlite
          .prepare('UPDATE workspace_snapshot_collections SET result_json = ?')
          .run(JSON.stringify(corrupted));
        expect(() => readWorkspaceCollection(db, capture)).toThrow();
      }
      db.sqlite
        .prepare('UPDATE workspace_snapshot_collections SET result_json = ?, candidate = ?')
        .run(JSON.stringify(receipt.result), Buffer.from('tampered bytes'));
      expect(() => readWorkspaceCollection(db, capture)).toThrow('committed candidate');
      db.sqlite
        .prepare('UPDATE workspace_snapshot_collections SET candidate = ?, is_link = 2')
        .run(bytes);
      expect(() => readWorkspaceCollection(db, capture)).toThrow('link evidence');
      db.sqlite.prepare('UPDATE workspace_snapshot_cursors SET head_json = NULL').run();
      expect(() => readWorkspaceSnapshotCursor(db, capture)).toThrow('partially initialized');
      db.sqlite
        .prepare('UPDATE workspace_snapshot_cursors SET head_json = ?, accepted_commit = ?')
        .run(JSON.stringify(next), 'unknown-commit');
      expect(() => readWorkspaceSnapshotCursor(db, capture)).toThrow();
    } finally {
      db.sqlite.close();
    }
  });

  it('freezes pending earlier review links in the cumulative candidate receipt', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const first = { ...identity, collectionId: 'first-pending' };
      acceptWorkspaceCapture(
        db,
        first,
        {
          outcome: 'candidate',
          head: next,
          previousHead: base,
          acceptedBase: base,
          unstable: false,
        },
        Buffer.from('first')
      );
      linkWorkspaceSnapshotReview(db, first, 'first-review');
      db.sqlite
        .prepare(
          "INSERT INTO staged_workspace_reviews (review_id, workspace_id, change_set_id, artifact_id, status, payload_json, created_at, updated_at) VALUES ('review', ?, 'first-review', 'artifact', 'pending', '{}', 'now', 'now')"
        )
        .run(identity.workspaceId);
      const later = { ...identity, collectionId: 'later-cumulative' };
      const result = {
        outcome: 'candidate',
        head: { tree: '5'.repeat(40), manifest: '6'.repeat(40) },
        previousHead: next,
        acceptedBase: base,
        unstable: false,
      };
      const bytes = Buffer.from('first and second changes');
      const receipt = acceptWorkspaceCapture(db, later, result, bytes);
      expect(receipt.result.pendingEarlierLinks).toEqual(['first-pending']);
      db.sqlite.prepare("UPDATE staged_workspace_reviews SET status = 'accepted'").run();
      expect(acceptWorkspaceCapture(db, later, result, bytes)).toEqual(receipt);
    } finally {
      db.sqlite.close();
    }
  });
  it('does not authorize baseline for an unrelated retained slot', () => {
    const db = fixture();
    try {
      expect(() => requireWorkspaceBaselineInitialization(db, identity)).toThrow(
        'accepted_base_unknown'
      );
      authorizeWorkspaceBaselineInitialization(db, identity);
      expect(() =>
        requireWorkspaceBaselineInitialization(db, { ...identity, packageSnapshotId: 'unrelated' })
      ).toThrow('accepted_base_unknown');
      expect(() => acceptWorkspaceBaseline(db, identity, base, 'bad')).toThrow(
        'baseline_source_unavailable'
      );
    } finally {
      db.sqlite.close();
    }
  });
  it('keeps capture and review heads independent while successful apply moves only the accepted base', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree, 'a'.repeat(40));
      const first = { ...identity, collectionId: 'first' };
      const later = { ...identity, collectionId: 'later' };
      const third = { tree: '5'.repeat(40), manifest: '6'.repeat(40) };
      acceptWorkspaceCapture(
        db,
        first,
        {
          outcome: 'candidate',
          head: next,
          previousHead: base,
          acceptedBase: base,
          unstable: false,
        },
        Buffer.from('first')
      );
      linkWorkspaceSnapshotReview(db, first, 'review-first');
      acceptWorkspaceCapture(
        db,
        later,
        {
          outcome: 'candidate',
          head: third,
          previousHead: next,
          acceptedBase: base,
          unstable: false,
        },
        Buffer.from('cumulative later')
      );
      linkWorkspaceSnapshotReview(db, later, 'review-later');
      expect(workspaceSnapshotReviewIsStale(db, identity.workspaceId, 'review-first')).toBe(false);
      acceptAppliedWorkspaceSnapshot(db, identity.workspaceId, 'review-first', 'b'.repeat(40));
      expect(readWorkspaceSnapshotCursor(db, identity)).toEqual({
        acceptedBase: next,
        head: third,
        acceptedCommit: 'b'.repeat(40),
      });
      expect(workspaceSnapshotReviewIsStale(db, identity.workspaceId, 'review-later')).toBe(true);
      expect(() =>
        acceptAppliedWorkspaceSnapshot(db, identity.workspaceId, 'review-later', 'c'.repeat(40))
      ).toThrow('accepted base changed');
      expect(() => linkWorkspaceSnapshotReview(db, first, 'different')).toThrow(
        'identity conflicts'
      );
      expect(() =>
        linkWorkspaceSnapshotReview(db, { ...identity, collectionId: 'missing' }, 'none')
      ).toThrow('no committed candidate');
      expect(readWorkspaceCollection(db, later)?.candidate).toEqual(
        Buffer.from('cumulative later')
      );
      expect(readWorkspaceCollection(db, later)?.result.credentialCheck).toBe('passed');
    } finally {
      db.sqlite.close();
    }
  });
  it.each([
    [
      { outcome: 'candidate', head: next, previousHead: base, acceptedBase: next, unstable: false },
      Buffer.from('patch'),
      'accepted_base_unknown',
    ],
    [
      { outcome: 'candidate', head: base, previousHead: base, acceptedBase: base, unstable: false },
      Buffer.from('patch'),
      'no new head',
    ],
    [
      { outcome: 'candidate', head: next, previousHead: base, acceptedBase: base, unstable: false },
      null,
      'empty',
    ],
    [
      { outcome: 'empty', head: next, previousHead: base, acceptedBase: base, unstable: false },
      null,
      'disagrees',
    ],
    [{ outcome: 'no_new_head', unstable: false }, Buffer.from('patch'), 'invalid candidate'],
    [{ outcome: 'credential_hit' }, null, 'cannot advance'],
    [
      {
        outcome: 'candidate',
        head: next,
        previousHead: base,
        acceptedBase: base,
        unstable: false,
        byteLength: 900,
      },
      Buffer.from('patch'),
      'identity disagrees',
    ],
    [
      {
        outcome: 'candidate',
        head: next,
        previousHead: base,
        acceptedBase: base,
        unstable: false,
        sha256: `sha256:${'a'.repeat(64)}`,
      },
      Buffer.from('patch'),
      'identity disagrees',
    ],
  ])('refuses contradictory capture %j', (result, candidate, message) => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      expect(() =>
        acceptWorkspaceCapture(db, { ...identity, collectionId: 'refused' }, result, candidate)
      ).toThrow(String(message));
      expect(readWorkspaceSnapshotCursor(db, identity)?.head).toEqual(base);
    } finally {
      db.sqlite.close();
    }
  });
  it('initializes both pairs only after expected-tree agreement and rejects unrelated re-baseline', () => {
    const db = fixture();
    try {
      expect(() => acceptWorkspaceBaseline(db, identity, base, next.tree)).toThrow(
        'baseline_mismatch'
      );
      expect(readWorkspaceSnapshotCursor(db, identity)).toBeNull();
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      expect(readWorkspaceSnapshotCursor(db, identity)).toEqual({
        acceptedBase: base,
        head: base,
        acceptedCommit: null,
      });
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      expect(() => acceptWorkspaceBaseline(db, identity, next, next.tree)).toThrow(
        'baseline identity conflicts'
      );
      expect(() =>
        acceptWorkspaceBaseline(
          db,
          { ...identity, agentSessionId: 'as_01890f3e-0000-7000-8000-000000000002' },
          base,
          base.tree
        )
      ).toThrow('accepted_base_unknown');
    } finally {
      db.sqlite.close();
    }
  });
  it('keeps the accepted base across cumulative candidates, preserves exact replay and rejects gaps', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const capture = { ...identity, collectionId: 'end' };
      const result = {
        outcome: 'candidate',
        previousHead: base,
        acceptedBase: base,
        head: next,
        unstable: true,
      };
      const bytes = Buffer.from('immutable cumulative patch');
      const first = acceptWorkspaceCapture(db, capture, result, bytes);
      expect(readWorkspaceSnapshotCursor(db, identity)).toEqual({
        acceptedBase: base,
        head: next,
        acceptedCommit: null,
      });
      expect(readWorkspaceCollection(db, capture)).toEqual(first);
      expect(acceptWorkspaceCapture(db, capture, result, bytes)).toEqual(first);
      expect(() => acceptWorkspaceCapture(db, capture, result, Buffer.from('altered'))).toThrow(
        'replay'
      );
      expect(() =>
        acceptWorkspaceCapture(db, { ...capture, collectionId: 'gap' }, result, bytes)
      ).toThrow('previous_head_mismatch');
      expect(() => readWorkspaceCollection(db, { ...capture, sandboxId: 'foreign' })).toThrow(
        'identity conflicts'
      );
    } finally {
      db.sqlite.close();
    }
  });
  it('records unstable unchanged observations, empty transitions and permission-only pairs independently', () => {
    const db = fixture();
    try {
      authorizeWorkspaceBaselineInitialization(db, identity);
      acceptWorkspaceBaseline(db, identity, base, base.tree);
      const mode = { ...base, manifest: next.manifest };
      acceptWorkspaceCapture(
        db,
        { ...identity, collectionId: 'mode' },
        {
          outcome: 'candidate',
          head: mode,
          previousHead: base,
          acceptedBase: base,
          unstable: true,
        },
        Buffer.from('mode delta')
      );
      const observation = { ...identity, collectionId: 'unstable' };
      const noChange = { outcome: 'no_new_head', unstable: true };
      expect(acceptWorkspaceCapture(db, observation, noChange, null)).toMatchObject({
        isLink: true,
        result: { head: mode, previousHead: mode },
      });
      expect(acceptWorkspaceCapture(db, observation, noChange, null)).toEqual(
        readWorkspaceCollection(db, observation)
      );
      const storedObservation = readWorkspaceCollection(db, observation)!;
      const corruptObservation = { ...storedObservation.result };
      delete corruptObservation.head;
      db.sqlite
        .prepare(
          'UPDATE workspace_snapshot_collections SET result_json = ? WHERE collection_id = ?'
        )
        .run(JSON.stringify(corruptObservation), observation.collectionId);
      expect(() => readWorkspaceCollection(db, observation)).toThrow();
      db.sqlite
        .prepare(
          'UPDATE workspace_snapshot_collections SET result_json = ? WHERE collection_id = ?'
        )
        .run(JSON.stringify(storedObservation.result), observation.collectionId);
      expect(readWorkspaceSnapshotCursor(db, identity)?.head).toEqual(mode);
      acceptWorkspaceCapture(
        db,
        { ...identity, collectionId: 'return' },
        { outcome: 'empty', head: base, previousHead: mode, acceptedBase: base, unstable: false },
        null
      );
      expect(readWorkspaceSnapshotCursor(db, identity)?.head).toEqual(base);
      expect(
        acceptWorkspaceCapture(
          db,
          { ...identity, collectionId: 'stable' },
          { outcome: 'no_new_head', unstable: false },
          null
        ).isLink
      ).toBe(false);
    } finally {
      db.sqlite.close();
    }
  });
});

/** Creates two actual native snapshot rows and removes their temporary database after each case. */
function retainedSnapshotChainFixture() {
  const root = mkdtempSync(join(tmpdir(), 'retained-snapshot-chain-'));
  const db = openWorkspaceDb(root, identity.workspaceId);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  authorizeWorkspaceBaselineInitialization(db, identity);
  acceptWorkspaceBaseline(db, identity, base, base.tree, base.tree);
  const capture = { ...identity, collectionId: 'retained-collection' };
  acceptWorkspaceCapture(db, capture, { outcome: 'no_new_head', unstable: false }, null);
  return { db, capture };
}

describe('retained Workspace snapshot SQL formats', () => {
  const families = ['workspace_snapshot_cursors', 'workspace_snapshot_collections'] as const;
  it.each(families)('writes %s v1 and reads/replays without replacing retained bytes', (table) => {
    const { db, capture } = retainedSnapshotChainFixture();
    const before = db.sqlite.prepare(`SELECT * FROM ${table}`).get();
    expect(before).toMatchObject({ schema_version: 1 });
    expect(readWorkspaceSnapshotCursor(db, identity)?.acceptedBase).toEqual(base);
    expect(readWorkspaceCollection(db, capture)?.result.outcome).toBe('no_new_head');
    expect(
      workspaceSnapshotAcceptedCommitIsKnown(
        db,
        identity.workspaceId,
        identity.workSlot,
        identity.threadId,
        base.tree
      )
    ).toBe(true);
    authorizeWorkspaceBaselineInitialization(db, identity);
    acceptWorkspaceCapture(db, capture, { outcome: 'no_new_head', unstable: false }, null);
    expect(db.sqlite.prepare(`SELECT * FROM ${table}`).get()).toEqual(before);
  });

  it.each(
    families
  )('refuses %s version 2 before JSON decode, authority lookup or replay', (table) => {
    const { db, capture } = retainedSnapshotChainFixture();
    if (table === 'workspace_snapshot_collections') {
      // The older collection is the only proof for this commit after the accepted cursor advances.
      db.sqlite.prepare('UPDATE workspace_snapshot_cursors SET accepted_commit=?').run(next.tree);
    }
    const column =
      table === 'workspace_snapshot_cursors' ? 'baseline_identity_json' : 'identity_json';
    db.sqlite.prepare(`UPDATE ${table} SET schema_version=2, ${column}='{invalid'`).run();
    const before = db.sqlite.prepare(`SELECT * FROM ${table}`).get();
    if (table === 'workspace_snapshot_cursors') {
      expect(() => readWorkspaceSnapshotCursor(db, identity)).toThrow(
        'Unsupported retained record format'
      );
      expect(() => readWorkspaceBaselineIdentity(db, identity)).toThrow(
        'Unsupported retained record format'
      );
      expect(() => authorizeWorkspaceBaselineInitialization(db, identity)).toThrow(
        'Unsupported retained record format'
      );
    } else {
      expect(() => readWorkspaceCollection(db, capture)).toThrow(
        'Unsupported retained record format'
      );
      expect(() =>
        acceptWorkspaceCapture(db, capture, { outcome: 'no_new_head', unstable: false }, null)
      ).toThrow('Unsupported retained record format');
    }
    expect(() =>
      workspaceSnapshotAcceptedCommitIsKnown(
        db,
        identity.workspaceId,
        identity.workSlot,
        identity.threadId,
        base.tree
      )
    ).toThrow('Unsupported retained record format');
    expect(db.sqlite.prepare(`SELECT * FROM ${table}`).get()).toEqual(before);
  });
});

/** Uses the existing owner fixture; only the real native writer can change its query-only Main handle. */
async function nativeBaselineFixture(initialize = false) {
  const db = fixture();
  if (initialize) await publishBaselineInitialization(db, identity);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    rmSync(db.dataRoot, { recursive: true, force: true });
  });
  return {
    db,
    async open() {
      const scope = nativeProductScope(db.dataRoot, {
        kind: 'workspace',
        workspaceId: identity.workspaceId,
      });
      await getControlStoreWorkerClient().open({
        database: `workspace:${scope.path}`,
        path: scope.path,
        dataRoot: db.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      db.sqlite.pragma('query_only = ON');
      expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      const cold = openWorkspaceReadDb(db.dataRoot, identity.workspaceId);
      onTestFinished(() => cold.sqlite.close());
      return cold;
    },
  };
}

/** Observes exact existing baseline rows, without creating durable setup records. */
function baselineRows(db: ReturnType<typeof fixture>) {
  return db.sqlite
    .prepare(
      'SELECT * FROM workspace_snapshot_cursors ORDER BY workspace_id, storage_ref, work_slot'
    )
    .all();
}

describe('native baseline owner deciding cases', () => {
  it('keeps initialization separate and accepts exact source evidence with Main query-only, replay and cold reads', async () => {
    const f = await nativeBaselineFixture();
    await f.open();
    // Storage SQLite Layers: expected pre-move RED is Main SQLITE_READONLY at the first initialization INSERT.
    await publishBaselineInitialization(f.db, identity);
    expect(readWorkspaceBaselineIdentity(f.db, identity)).toEqual(identity);
    expect(readWorkspaceSnapshotCursor(f.db, identity)).toBeNull();
    expect(readWorkspaceCollection(f.db, identity)).toBeNull();
    const initialized = baselineRows(f.db);
    const unrelated = { ...identity, turnId: 'tu_01890f3e-0000-7000-8000-000000000002' };
    // Initialization does not replace retained authority, including an unfinished original initialization.
    await publishBaselineInitialization(f.db, unrelated);
    expect(baselineRows(f.db)).toEqual(initialized);
    for (const changed of [
      unrelated,
      { ...identity, agentSessionId: 'as_01890f3e-0000-7000-8000-000000000002' },
      { ...identity, threadId: 'th_01890f3e-0000-7000-8000-000000000002' },
      { ...identity, storageRef: 'wst_01890f3e-0000-7000-8000-000000000002' },
      { ...identity, scopeDigest: `sha256:${'f'.repeat(64)}` },
      { ...identity, attachmentGeneration: 2 },
      { ...identity, sandboxId: 'other-sandbox' },
      { ...identity, workSlot: 'other-slot' },
      { ...identity, collectionId: 'other-collection' },
      { ...identity, packageSnapshotId: 'other-package' },
    ]) {
      await expect(async () =>
        publishAcceptedBaseline(f.db, changed, base, base.tree)
      ).rejects.toThrow('accepted_base_unknown');
    }
    await expect(async () =>
      publishAcceptedBaseline(f.db, identity, base, next.tree)
    ).rejects.toThrow('baseline_mismatch');
    await expect(async () => publishAcceptedBaseline(f.db, identity, base, null)).rejects.toThrow(
      'baseline_source_unavailable'
    );
    await expect(async () =>
      publishBaselineInitialization(f.db, {
        ...identity,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000002',
      })
    ).rejects.toThrow();
    expect(baselineRows(f.db)).toEqual(initialized);
    await publishAcceptedBaseline(f.db, identity, base, base.tree);
    expect(readWorkspaceSnapshotCursor(f.db, identity)).toEqual({
      acceptedBase: base,
      head: base,
      acceptedCommit: null,
    });
    const committed = baselineRows(f.db);
    await publishBaselineInitialization(f.db, identity);
    await publishAcceptedBaseline(f.db, identity, base, base.tree);
    // Original replay is pair-based; it does not rewrite the already accepted commit field.
    await publishAcceptedBaseline(f.db, identity, base, base.tree, 'c'.repeat(64));
    expect(baselineRows(f.db)).toEqual(committed);
    await expect(async () =>
      publishAcceptedBaseline(f.db, identity, next, next.tree)
    ).rejects.toThrow('baseline identity conflicts');
    expect(baselineRows(f.db)).toEqual(committed);
    // Workspace Synchronization / Snapshot Chain: Git pin format can differ from the private SHA-1 pair.
    const gitIdentity = { ...identity, workSlot: 'git-slot' };
    const pin = 'a'.repeat(64);
    await publishBaselineInitialization(f.db, gitIdentity);
    await publishAcceptedBaseline(f.db, gitIdentity, next, null, pin);
    expect(readWorkspaceSnapshotCursor(f.db, gitIdentity)).toEqual({
      acceptedBase: next,
      head: next,
      acceptedCommit: pin,
    });
    expect(readWorkspaceCollection(f.db, gitIdentity)).toBeNull();
    const final = baselineRows(f.db);
    const cold = await f.cold();
    expect(baselineRows(cold)).toEqual(final);
    expect(readWorkspaceBaselineIdentity(cold, identity)).toEqual(identity);
    expect(readWorkspaceSnapshotCursor(cold, identity)).toEqual({
      acceptedBase: base,
      head: base,
      acceptedCommit: null,
    });
    expect(readWorkspaceSnapshotCursor(cold, gitIdentity)).toEqual({
      acceptedBase: next,
      head: next,
      acceptedCommit: pin,
    });
  });

  it('preserves the separately committed initialization after definite acceptance failure and a cold read', async () => {
    // Valid prior-stage setup uses the public owner before this stage's injected fault and writer switch.
    const f = await nativeBaselineFixture(true);
    await shutdownControlStoreWorkerClient();
    const initialized = baselineRows(f.db);
    f.db.sqlite.exec(`CREATE TRIGGER reject_baseline_accept BEFORE UPDATE ON workspace_snapshot_cursors
      WHEN NEW.accepted_base_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'baseline acceptance fault'); END`);
    await f.open();
    // Control Store / Physical Commit: native savepoint refusal is definite, redacted, and leaves no accepted pair.
    // Expected pre-move RED is SQLITE_READONLY instead of this real native constraint refusal.
    await expect(async () =>
      publishAcceptedBaseline(f.db, identity, base, base.tree)
    ).rejects.toMatchObject({
      code: 'constraint',
      commit: 'not-committed',
      message: 'Control database writer operation failed.',
    });
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(baselineRows(f.db)).toEqual(initialized);
    expect(readWorkspaceBaselineIdentity(f.db, identity)).toEqual(identity);
    expect(readWorkspaceSnapshotCursor(f.db, identity)).toBeNull();
    expect(readWorkspaceCollection(f.db, identity)).toBeNull();
    const cold = await f.cold();
    expect(baselineRows(cold)).toEqual(initialized);
    expect(readWorkspaceBaselineIdentity(cold, identity)).toEqual(identity);
    expect(readWorkspaceSnapshotCursor(cold, identity)).toBeNull();
  });
});
