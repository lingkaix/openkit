import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { KnowledgeNotebook } from './notebook.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n# Knowledge\n';

/** Trusted command facts; these fixtures do not grant current publication authority. */
function metadata(requestId = 'notebook-bootstrap', summary = 'Create notebook') {
  return {
    summary,
    changeRequest: { requestId, inputDigest: `sha256:${'1'.repeat(64)}` },
    producer: { kind: 'user' as const, id: 'user_local' },
    authority: { kind: 'direct' as const, instructionReference: `item:${requestId}` },
    sourceReferences: [],
  };
}

/** Keep page bytes distinct so partial multi-file publication is observable. */
function page(title: string, body: string) {
  return `---\ntype: KnowledgePage\ntitle: ${JSON.stringify(title)}\n---\n${body}\n`;
}

/** Each test owns a fresh real local bare repository, never a product data root. */
async function fixture(files?: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'openkit-notebook-'));
  temporaryRoots.push(root);
  const repositoryPath = path.join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const revision = await notebook.initialize({
    metadata: metadata(),
    files: files === undefined ? undefined : { 'index.md': ROOT_INDEX, ...files },
  });
  return { root, repositoryPath, notebook, revision };
}

/** Native Git supplies independent object/ref observations and corrupt-store faults. */
async function git(repositoryPath: string, args: string[], input?: string | Buffer) {
  const env = {
    PATH: process.env.PATH,
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Notebook test',
    GIT_AUTHOR_EMAIL: 'openkit',
    GIT_COMMITTER_NAME: 'Notebook test',
    GIT_COMMITTER_EMAIL: 'openkit',
  };
  if (input === undefined) {
    return (
      await execFileAsync('git', ['--git-dir', repositoryPath, ...args], { env })
    ).stdout.trimEnd();
  }
  // execFile has no input option. Feed only test-owned bytes through a pipe, with no shell.
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      ['--git-dir', repositoryPath, ...args],
      { env },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trimEnd());
      }
    );
    child.stdin?.end(input);
  });
}

/** Construct a malformed retained commit without using the subject's serializer. */
async function rawCommit(repositoryPath: string, base: string, message: string, tree?: string) {
  const treeId = tree ?? (await git(repositoryPath, ['rev-parse', `${base}^{tree}`]));
  return await git(repositoryPath, ['commit-tree', treeId, '-p', base], message);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('KnowledgeNotebook real Git content publication', () => {
  it('creates one root revision with a versioned empty OKF bundle and no parent', async () => {
    const { notebook, repositoryPath, revision } = await fixture();

    expect(await notebook.publishedRevision()).toBe(revision);
    expect(await notebook.readRevision(revision)).toEqual({
      revision,
      parentRevision: null,
      files: { 'index.md': expect.stringMatching(/^---\nokf_version: ["']?0\.2["']?\n---\n# /) },
      metadata: metadata(),
    });
    expect(await git(repositoryPath, ['rev-list', '--parents', revision])).toBe(revision);
    expect(await git(repositoryPath, ['ls-tree', '-r', '--name-only', revision])).toBe(
      'pages/index.md'
    );
    expect(await git(repositoryPath, ['config', '--get', 'core.bare'])).toBe('true');
  });

  it('prepares all changed files without exposing any of them, then publishes one immutable tree', async () => {
    const original = {
      'index.md': ROOT_INDEX,
      'a.md': page('A', 'old A'),
      'b.md': page('B', 'old B'),
    };
    const { notebook, repositoryPath, revision } = await fixture(original);
    const changes = {
      'a.md': page('A', 'new A'),
      'b.md': page('B', 'new B'),
      'nested/c.md': page('C', 'new C'),
    };
    const candidate = await notebook.prepare({
      baseRevision: revision,
      changes,
      metadata: metadata('edit'),
    });

    expect(candidate).not.toBe(revision);
    expect(await notebook.publishedRevision()).toBe(revision);
    expect((await notebook.readRevision(revision)).files).toEqual(original);
    expect(await git(repositoryPath, ['rev-parse', 'refs/heads/published'])).toBe(revision);
    expect(
      await notebook.publish({ baseRevision: revision, candidateRevision: candidate })
    ).toEqual({ revision: candidate });
    expect((await notebook.readRevision(await notebook.publishedRevision())).files).toEqual({
      ...original,
      ...changes,
    });
    expect((await notebook.readRevision(revision)).files).toEqual(original);
    expect(await git(repositoryPath, ['rev-list', '--parents', '-1', candidate])).toBe(
      `${candidate} ${revision}`
    );
    expect(await git(repositoryPath, ['show', `${candidate}:pages/nested/c.md`])).toBe(
      changes['nested/c.md'].trimEnd()
    );
  });

  it('edits a narrow selection in a notebook larger than the editing workspace bound', async () => {
    const retained = page('Retained', 'x'.repeat(2 * 1024 * 1024 - 100));
    const files = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`page-${index}.md`, retained])
    );
    const { notebook, repositoryPath, revision } = await fixture(files);
    const originalBlob = await git(repositoryPath, ['rev-parse', `${revision}:pages/page-16.md`]);
    const candidate = notebook.prepare({
      baseRevision: revision,
      changes: { 'page-0.md': page('Changed', 'Only this small selected page changes.') },
      metadata: metadata('narrow-edit'),
    });
    notebook.publish({ baseRevision: revision, candidateRevision: candidate });
    expect(await git(repositoryPath, ['rev-parse', `${candidate}:pages/page-16.md`])).toBe(
      originalBlob
    );
    expect(await git(repositoryPath, ['show', `${candidate}:pages/page-0.md`])).toContain(
      'Only this small selected page changes.'
    );
    expect(await git(repositoryPath, ['rev-list', '--parents', '-1', candidate])).toBe(
      `${candidate} ${revision}`
    );
  });

  it.each([
    'alternates',
    'object-symlink',
  ] as const)('rejects Git internal redirection %s before reading', async (kind) => {
    const { notebook, repositoryPath, root, revision } = await fixture({
      'a.md': page('A', 'retained'),
    });
    if (kind === 'alternates') {
      await writeFile(
        path.join(repositoryPath, 'objects/info/alternates'),
        path.join(root, 'outside-objects')
      );
    } else {
      await rename(path.join(repositoryPath, 'objects'), path.join(root, 'outside-objects'));
      await symlink(path.join(root, 'outside-objects'), path.join(repositoryPath, 'objects'));
    }
    await expect(
      Promise.resolve().then(() => notebook.readRevision(revision))
    ).rejects.toMatchObject({ code: 'recovery_required' });
  });

  it('refuses publication when an omitted retained blob has a valid encoding but a false object digest', async () => {
    const { notebook, repositoryPath, revision } = await fixture({
      'a.md': page('A', 'selected'),
      'b.md': page('B', 'untouched'),
    });
    const candidate = notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'changed') },
      metadata: metadata('changed'),
    });
    const blob = await git(repositoryPath, ['rev-parse', `${revision}:pages/b.md`]);
    const objectPath = path.join(repositoryPath, 'objects', blob.slice(0, 2), blob.slice(2));
    const corrupt = Buffer.from(page('B', 'corrupted'));
    await chmod(objectPath, 0o600);
    await writeFile(
      objectPath,
      deflateSync(Buffer.concat([Buffer.from(`blob ${corrupt.length}\0`), corrupt]))
    );
    await expect(
      Promise.resolve().then(() =>
        notebook.publish({ baseRevision: revision, candidateRevision: candidate })
      )
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await git(repositoryPath, ['rev-parse', 'refs/heads/published'])).toBe(revision);
  });

  it('uses exact-base compare-and-set so two stale writers cannot overwrite the winner', async () => {
    const { notebook, repositoryPath, revision } = await fixture({ 'a.md': page('A', 'base') });
    const first = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'first') },
      metadata: metadata('first'),
    });
    const second = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'second') },
      metadata: metadata('second'),
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        notebook.publish({ baseRevision: revision, candidateRevision: first })
      ),
      Promise.resolve().then(() =>
        notebook.publish({ baseRevision: revision, candidateRevision: second })
      ),
    ]);
    const winner = await notebook.publishedRevision();

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'conflict', currentRevision: winner }),
      }),
    ]);
    expect([first, second]).toContain(winner);
    expect(await git(repositoryPath, ['rev-parse', 'refs/heads/published'])).toBe(winner);
    expect((await notebook.readRevision(winner)).files['a.md']).toBe(
      page('A', winner === first ? 'first' : 'second')
    );
  });

  it('rejects an ABA stale base even when current page bytes match the old base', async () => {
    const content = page('A', 'same bytes');
    const { notebook, revision } = await fixture({ 'a.md': content });
    const stale = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'stale') },
      metadata: metadata('stale'),
    });
    const middle = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'middle') },
      metadata: metadata('middle'),
    });
    await notebook.publish({ baseRevision: revision, candidateRevision: middle });
    const restored = await notebook.prepare({
      baseRevision: middle,
      changes: { 'a.md': content },
      metadata: metadata('restore'),
    });
    await notebook.publish({ baseRevision: middle, candidateRevision: restored });

    await expect(
      Promise.resolve().then(() =>
        notebook.publish({ baseRevision: revision, candidateRevision: stale })
      )
    ).rejects.toMatchObject({ code: 'conflict', currentRevision: restored });
    expect(await notebook.publishedRevision()).toBe(restored);
  });

  it('reopens exact current bytes and retained history without promoting a retained candidate', async () => {
    const { notebook, repositoryPath, revision } = await fixture({ 'a.md': page('A', 'original') });
    const published = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'published') },
      metadata: metadata('published'),
    });
    await notebook.publish({ baseRevision: revision, candidateRevision: published });
    const candidate = await notebook.prepare({
      baseRevision: published,
      changes: { 'a.md': page('A', 'pending') },
      metadata: {
        ...metadata('draft'),
        authority: { kind: 'proposal', proposalId: `kp_${'2'.repeat(64)}` },
      },
    });
    await notebook.retainCandidate({
      proposalId: `kp_${'2'.repeat(64)}`,
      candidateRevision: candidate,
    });
    const reopened = new KnowledgeNotebook({ repositoryPath });

    expect(await reopened.publishedRevision()).toBe(published);
    expect((await reopened.readRevision(published)).files['a.md']).toBe(page('A', 'published'));
    expect((await reopened.readRevision(revision)).files['a.md']).toBe(page('A', 'original'));
    expect((await reopened.readRevision(candidate)).files['a.md']).toBe(page('A', 'pending'));
    expect((await reopened.history({})).map((entry) => entry.revision)).toEqual([
      published,
      revision,
    ]);
    expect(await git(repositoryPath, ['rev-parse', `refs/proposals/kp_${'2'.repeat(64)}`])).toBe(
      candidate
    );
  });

  it('preserves exact unchanged bytes and publishes removals only in the candidate tree', async () => {
    const unchanged = page('Keep', 'Unknown metadata and body remain exact.\r\n\t  ');
    const { notebook, revision } = await fixture({
      'keep.md': unchanged,
      'remove.md': page('Remove', 'retained history'),
    });
    const candidate = await notebook.prepare({
      baseRevision: revision,
      changes: { 'remove.md': null, 'new.md': page('New', 'replacement') },
      metadata: metadata('remove'),
    });

    expect((await notebook.readRevision(revision)).files['remove.md']).toBe(
      page('Remove', 'retained history')
    );
    expect((await notebook.readRevision(candidate)).files).toEqual({
      'index.md': ROOT_INDEX,
      'keep.md': unchanged,
      'new.md': page('New', 'replacement'),
    });
  });

  it('serializes the complete metadata as one JSON object despite summary injection text', async () => {
    const summary = 'Review\n{"authority":{"kind":"proposal"}}\n---\nUnicode: ☃';
    const { notebook, repositoryPath, revision } = await fixture();
    const facts = metadata('summary', summary);
    const candidate = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'content') },
      metadata: facts,
    });
    const message = await git(repositoryPath, ['show', '-s', '--format=%B', candidate]);

    expect(JSON.parse(message)).toEqual(facts);
    expect(message).toBe(JSON.stringify(facts));
    expect((await notebook.readRevision(candidate)).metadata).toEqual(facts);
    expect(await git(repositoryPath, ['show', '-s', '--format=%an', candidate])).toBe('user_local');
  });

  it.each([
    [
      'unknown authority key',
      { ...metadata(), authority: { ...metadata().authority, grant: true } },
    ],
    ['unknown authority kind', { ...metadata(), authority: { kind: 'trusted-model' } }],
    ['missing authority', { ...metadata(), authority: undefined }],
    ['unknown top-level key', { ...metadata(), approved: true }],
    [
      'invalid input digest',
      { ...metadata(), changeRequest: { requestId: 'edit', inputDigest: '1' } },
    ],
    ['oversized UTF-8 summary', metadata('large-summary', '☃'.repeat(1366))],
  ])('refuses %s before publication', async (_label, invalidMetadata) => {
    const { notebook, revision } = await fixture();

    await expect(
      Promise.resolve().then(() =>
        notebook.prepare({
          baseRevision: revision,
          changes: { 'a.md': page('A', 'denied') },
          metadata: invalidMetadata as ReturnType<typeof metadata>,
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await notebook.publishedRevision()).toBe(revision);
  });

  it.each([
    [
      'duplicate authority',
      `${JSON.stringify(metadata()).slice(0, -1)},"authority":{"kind":"direct","instructionReference":"item:forged"}}`,
    ],
    [
      'duplicate nested key',
      JSON.stringify(metadata()).replace('"kind":"direct"', '"kind":"proposal","kind":"direct"'),
    ],
    ['trailing second object', `${JSON.stringify(metadata())}\n{}`],
    ['missing metadata', 'ordinary unstructured Git message'],
    [
      'unknown authority key',
      JSON.stringify({ ...metadata(), authority: { ...metadata().authority, allow: true } }),
    ],
  ])('fails closed when retained commit metadata has %s', async (_label, message) => {
    const { notebook, repositoryPath, revision } = await fixture();
    const corrupt = await rawCommit(repositoryPath, revision, message);
    await git(repositoryPath, ['update-ref', 'refs/heads/published', corrupt, revision]);
    const reopened = new KnowledgeNotebook({ repositoryPath });

    await expect(
      Promise.resolve().then(() => reopened.readRevision(corrupt))
    ).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await git(repositoryPath, ['rev-parse', 'refs/heads/published'])).toBe(corrupt);
    expect(Object.keys((await notebook.readRevision(revision)).files)).toEqual(['index.md']);
  });

  it.each([
    '../escape.md',
    '/absolute.md',
    'a/../../escape.md',
    '.git/config',
    'a\\escape.md',
    'a//b.md',
    'a/./b.md',
    'Upper.md',
    'a.txt',
    'a\0.md',
  ])('refuses unsafe bundle path %j without changing the published ref', async (unsafePath) => {
    const { notebook, revision } = await fixture();

    await expect(
      Promise.resolve().then(() =>
        notebook.prepare({
          baseRevision: revision,
          changes: { [unsafePath]: page('Unsafe', 'denied') },
          metadata: metadata('unsafe'),
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await notebook.publishedRevision()).toBe(revision);
  });

  it.each([
    '120000',
    '100755',
    '160000',
  ])('refuses non-page Git mode %s on retained reads', async (mode) => {
    const { notebook, repositoryPath, revision } = await fixture();
    const object =
      mode === '160000'
        ? revision
        : await git(repositoryPath, ['hash-object', '-w', '--stdin'], '../../outside');
    const index = await git(repositoryPath, ['hash-object', '-w', '--stdin'], ROOT_INDEX);
    const pagesTree = await git(
      repositoryPath,
      ['mktree'],
      `100644 blob ${index}\tindex.md\n${mode} ${mode === '160000' ? 'commit' : 'blob'} ${object}\tunsafe.md\n`
    );
    const tree = await git(repositoryPath, ['mktree'], `040000 tree ${pagesTree}\tpages\n`);
    const corrupt = await rawCommit(
      repositoryPath,
      revision,
      JSON.stringify(metadata('special-file')),
      tree
    );

    await expect(
      Promise.resolve().then(() => notebook.readRevision(corrupt))
    ).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await notebook.publishedRevision()).toBe(revision);
  });

  it('refuses a candidate whose actual parent is not the asserted publication base', async () => {
    const { notebook, revision } = await fixture();
    const first = await notebook.prepare({
      baseRevision: revision,
      changes: { 'a.md': page('A', 'first') },
      metadata: metadata('first'),
    });
    const descendant = await notebook.prepare({
      baseRevision: first,
      changes: { 'b.md': page('B', 'descendant') },
      metadata: metadata('descendant'),
    });

    await expect(
      Promise.resolve().then(() =>
        notebook.publish({ baseRevision: revision, candidateRevision: descendant })
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await notebook.publishedRevision()).toBe(revision);
  });

  it('fails closed on invalid retained UTF-8 instead of replacing exact page bytes', async () => {
    const { notebook, repositoryPath, revision } = await fixture();
    const index = await git(repositoryPath, ['hash-object', '-w', '--stdin'], ROOT_INDEX);
    const invalid = await git(
      repositoryPath,
      ['hash-object', '-w', '--stdin'],
      Buffer.from([0xff])
    );
    const pagesTree = await git(
      repositoryPath,
      ['mktree'],
      `100644 blob ${index}\tindex.md\n100644 blob ${invalid}\tinvalid.md\n`
    );
    const tree = await git(repositoryPath, ['mktree'], `040000 tree ${pagesTree}\tpages\n`);
    const corrupt = await rawCommit(
      repositoryPath,
      revision,
      JSON.stringify(metadata('utf8')),
      tree
    );

    await expect(
      Promise.resolve().then(() => notebook.readRevision(corrupt))
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await notebook.publishedRevision()).toBe(revision);
  });

  it('reports recovery when an initialized published ref is missing and does not create an empty replacement', async () => {
    const { repositoryPath, revision } = await fixture({ 'a.md': page('A', 'must survive') });
    await git(repositoryPath, ['update-ref', '-d', 'refs/heads/published', revision]);
    const reopened = new KnowledgeNotebook({ repositoryPath });

    await expect(Promise.resolve().then(() => reopened.publishedRevision())).rejects.toMatchObject({
      code: 'recovery_required',
    });
    await expect(
      Promise.resolve().then(() => reopened.initialize({ metadata: metadata('repair') }))
    ).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await git(repositoryPath, ['show', `${revision}:pages/a.md`])).toBe(
      page('A', 'must survive').trimEnd()
    );
    expect(
      await git(repositoryPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/published'])
    ).toBe('');
  });

  it.each([
    ['commit', 'missing'],
    ['commit', 'corrupt'],
    ['tree', 'missing'],
    ['tree', 'corrupt'],
    ['blob', 'missing'],
    ['blob', 'corrupt'],
  ])('reports recovery for a %s object that is %s and preserves the broken ref', async (kind, fault) => {
    const { repositoryPath, revision } = await fixture({ 'a.md': page('A', 'retained') });
    const object =
      kind === 'commit'
        ? revision
        : await git(repositoryPath, [
            'rev-parse',
            kind === 'tree' ? `${revision}^{tree}` : `${revision}:pages/a.md`,
          ]);
    const objectPath = path.join(repositoryPath, 'objects', object.slice(0, 2), object.slice(2));
    const originalBytes = await readFile(objectPath);
    if (fault === 'missing') await unlink(objectPath);
    else {
      await chmod(objectPath, 0o600);
      await writeFile(objectPath, 'not a Git object');
    }
    const reopened = new KnowledgeNotebook({ repositoryPath });

    await expect(
      Promise.resolve().then(() => reopened.readRevision(revision))
    ).rejects.toMatchObject({
      code: 'recovery_required',
    });
    await expect(
      Promise.resolve().then(() => reopened.initialize({ metadata: metadata('repair') }))
    ).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect((await readFile(path.join(repositoryPath, 'refs/heads/published'), 'utf8')).trim()).toBe(
      revision
    );
    // Restore only the test-owned fault so cleanup never leaves a deliberately corrupt repository.
    await writeFile(objectPath, originalBytes);
    expect((await reopened.readRevision(revision)).files['a.md']).toBe(page('A', 'retained'));
  });
});
