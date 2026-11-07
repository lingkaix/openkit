import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { serverKnowledgeRoot } from '../storage/fs-layout.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { NotebookError } from './notebook-error.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import { admitServerKnowledgeBoot } from './server-knowledge-maintenance.js';

describe('Server Knowledge boot admission', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('accepts a fresh data root that has no Server Knowledge authority', () => {
    const coreDb = openMigratedCore(roots);
    try {
      expect(() => admitServerKnowledgeBoot(coreDb)).not.toThrow();
    } finally {
      closeTestCoreDb(coreDb);
    }
  });

  it('admits an initialized Server Knowledge notebook', () => {
    const coreDb = openMigratedCore(roots);
    try {
      const userId = ensureLocalUser(coreDb);
      initializeScopedNotebook({
        coreDb,
        actor: { kind: 'local', userId },
        target: { kind: 'server' },
        initialization: { requestId: randomUUID(), instructionReference: 'fixture' },
      });
      expect(() => admitServerKnowledgeBoot(coreDb)).not.toThrow();
    } finally {
      closeTestCoreDb(coreDb);
    }
  });

  it('refuses boot admission when expected Server Knowledge is missing or unreadable', () => {
    const missing = openMigratedCore(roots);
    try {
      mkdirSync(serverKnowledgeRoot(missing.dataRoot));
      expect(() => admitServerKnowledgeBoot(missing)).toThrow(NotebookError);
    } finally {
      closeTestCoreDb(missing);
    }

    const unreadable = openMigratedCore(roots);
    try {
      const root = serverKnowledgeRoot(unreadable.dataRoot);
      mkdirSync(root);
      writeFileSync(join(root, 'notebook.git'), 'not-a-git-repository');
      expect(() => admitServerKnowledgeBoot(unreadable)).toThrow(NotebookError);
    } finally {
      closeTestCoreDb(unreadable);
    }
  });
});

function openMigratedCore(roots: string[]) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-knowledge-'));
  roots.push(dataRoot);
  return createTestCoreDb(dataRoot);
}
