// openkit-test-platform: posix
// Real physical mount folders and canonical Source publication share the local raw namespace.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseJsoncObject } from '../config/jsonc.js';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { openKitConfigPath } from '../config/openkit-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import { registerServerKnowledgeSource } from './server-knowledge-owner.js';

/** Real Server authority and a fixed KB; authored mounts grant no byte permission. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-mount-collision-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  initializeScopedNotebook({
    coreDb,
    actor,
    target: { kind: 'server' },
    initialization: {
      requestId: randomUUID(),
      instructionReference: 'test:source-mount-collision',
    },
  });
  const owner = { dataRoot, scope: { kind: 'server' as const } };
  const knowledgeBaseId = readDefaultKnowledgeBaseId(owner);
  const managed = readKnowledgeMounts(owner);
  const notebookRoot = join(dataRoot, 'server', 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
  const revision = notebook.publishedRevision();
  const configPath = openKitConfigPath(dataRoot);
  const externalRoot = join(dataRoot, 'external-originals');
  mkdirSync(externalRoot);
  const externalPath = join(externalRoot, 'retained.bin');
  const externalBytes = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(externalPath, externalBytes);
  const declare = (name: string) => {
    const config = parseJsoncObject(readFileSync(configPath, 'utf8'));
    const mounts = [
      ...managed,
      { name, backend: 'local', root: externalRoot, default: false, knowledgeBaseId },
    ];
    const bytes = `${JSON.stringify({ ...config, knowledgeMounts: mounts })}\n`;
    writeFileSync(configPath, bytes);
    return { bytes, mounts };
  };
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    coreDb,
    actor,
    store,
    owner,
    knowledgeBaseId,
    notebookRoot,
    notebook,
    revision,
    configPath,
    externalPath,
    externalBytes,
    declare,
  };
}

describe('Knowledge mount namespace collisions', () => {
  it('refuses an additional mount shadowing an existing default-raw folder without changing retained bytes', () => {
    const f = fixture();
    const physicalFolder = join(f.notebookRoot, 'raw', 'archive');
    mkdirSync(physicalFolder, { recursive: true });
    const physicalOriginal = join(physicalFolder, 'retained.bin');
    const physicalBytes = Buffer.from([254, 0, 1, 13, 10]);
    writeFileSync(physicalOriginal, physicalBytes);
    const declaration = f.declare('archive');
    expect.soft(() => readKnowledgeMounts(f.owner)).toThrow();
    expect(readFileSync(f.configPath, 'utf8')).toBe(declaration.bytes);
    expect(readFileSync(physicalOriginal)).toEqual(physicalBytes);
    expect(readFileSync(f.externalPath)).toEqual(f.externalBytes);
    expect(f.notebook.publishedRevision()).toBe(f.revision);
    expect(f.notebook.readSourcePointers(f.revision)).toEqual({});
  });

  it('refuses managed Source capture into an additional mount reserved namespace before raw or Git publication', async () => {
    const f = fixture();
    const declaration = f.declare('sources');
    expect(readKnowledgeMounts(f.owner)).toEqual(declaration.mounts);
    const managedSources = join(f.notebookRoot, 'raw', 'sources');
    expect(existsSync(managedSources)).toBe(false);
    const requestId = randomUUID();
    await expect
      .soft(
        registerServerKnowledgeSource(
          { coreDb: f.coreDb, actor: f.actor, store: f.store, inflightCommands: new WeakMap() },
          {
            requestId,
            kind: 'document',
            title: 'Cannot shadow the reserved mount',
            content: 'Exact original that must not be captured here.',
          }
        )
      )
      .rejects.toThrow();
    expect.soft(existsSync(managedSources)).toBe(false);
    expect.soft(f.notebook.publishedRevision()).toBe(f.revision);
    expect.soft(f.notebook.readSourcePointers(f.notebook.publishedRevision())).toEqual({});
    expect
      .soft(
        f.coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'knowledge.source.register' AND request_id = ?"
          )
          .get(requestId)
      )
      .toEqual({ count: 0 });
    expect
      .soft(
        f.coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'knowledge.source.register' AND request_id = ?"
          )
          .get(requestId)
      )
      .toEqual({ count: 0 });
    expect(readFileSync(f.configPath, 'utf8')).toBe(declaration.bytes);
    expect(readFileSync(f.externalPath)).toEqual(f.externalBytes);
    expect(readDefaultKnowledgeBaseId(f.owner)).toBe(f.knowledgeBaseId);
  });
});
