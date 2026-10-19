import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument } from './okf.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import {
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';

describe('canonical Source pointer publication', () => {
  it.each([
    'user',
    'server',
  ] as const)('publishes an admitted %s SourceSummary at its package path and reopens exact originals', async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-source-pointer-'));
    let coreDb = openCoreDb(dataRoot);
    let userDb: ReturnType<typeof openUserDb> | undefined;
    onTestFinished(() => {
      userDb?.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const actor = { kind: 'local' as const, userId };
    const initialization = {
      requestId: randomUUID(),
      instructionReference: 'test:explicit-source-capture',
    };
    if (kind === 'user') {
      userDb = openUserDb(dataRoot, userId);
      applyScopedMigrations(userDb);
      initializeScopedNotebook({
        coreDb,
        userDb,
        actor,
        target: { kind: 'user' },
        initialization,
      });
    } else {
      initializeScopedNotebook({ coreDb, actor, target: { kind: 'server' }, initialization });
    }
    const scopeRoot = kind === 'user' ? join(dataRoot, 'users', userId) : join(dataRoot, 'server');
    const notebookRoot = join(scopeRoot, kind === 'user' ? 'memory' : 'knowledge');
    const repositoryPath = join(notebookRoot, 'notebook.git');
    const request = {
      requestId: randomUUID(),
      kind: 'document' as const,
      title: 'Exact admitted original',
      content: 'Literal original.\r\nUnicode Ω 雪.\n',
    };
    const writer = {
      coreDb,
      actor,
      store: new FsStore({ dataRoot }),
      inflightCommands: new WeakMap(),
    };
    const source =
      kind === 'user'
        ? await registerUserKnowledgeSource({ ...writer, userDb: userDb! }, request)
        : await registerServerKnowledgeSource(writer, request);
    expect(source.contentDigest).toBe(
      `sha256:${createHash('sha256').update(Buffer.from(request.content)).digest('hex')}`
    );

    userDb?.sqlite.close();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    if (kind === 'user') userDb = openUserDb(dataRoot, userId);
    const reopened =
      kind === 'user'
        ? readUserKnowledgeSource({ coreDb, userDb: userDb!, actor }, source.id)
        : readServerKnowledgeSource({ coreDb, actor }, source.id);
    expect(reopened).toEqual({ source, content: request.content });

    const notebook = new KnowledgeNotebook({ repositoryPath });
    const revision = notebook.publishedRevision();
    // Git paths are the package paths; the page reader's relative view cannot prove this boundary.
    const paths = execFileSync(
      'git',
      [`--git-dir=${repositoryPath}`, 'ls-tree', '-r', '--name-only', revision],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n');
    const pointerPath = `sources/${source.id}.md`;
    expect(paths).toContain(pointerPath);
    expect(paths).toContain('pages/index.md');
    expect(paths.some((path) => path.startsWith('raw/'))).toBe(false);
    const pointer = execFileSync(
      'git',
      [`--git-dir=${repositoryPath}`, 'show', `${revision}:${pointerPath}`],
      { encoding: 'utf8' }
    );
    const parsed = parseOkfDocument({ path: pointerPath, content: pointer });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Published Source pointer must be valid OKF.');
    expect(parsed.document.frontmatter.type).toBe('SourceSummary');
    expect(existsSync(join(scopeRoot, 'sources', 'registry', `${source.id}.json`))).toBe(false);
  });
});
