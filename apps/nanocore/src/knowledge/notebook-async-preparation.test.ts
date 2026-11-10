import childProcess from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { KnowledgeNotebook, NotebookError } from './notebook.js';

/** Native objects are created through the same immutable owner as production. */
function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'notebook-async-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const files = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `page-${index}.md`,
      `\uFEFF# Exact ${index}\r\n${'Original bytes.\n'.repeat(32)}\0`,
    ])
  );
  const source = allocateEntityId('ks');
  const sourcePointers = { [source]: '\uFEFF# Source\r\nOriginal pointer bytes.\n' };
  const metadata = {
    summary: 'Prepare immutable reads',
    changeRequest: { requestId: 'async-fixture', inputDigest: `sha256:${'1'.repeat(64)}` },
    producer: { kind: 'user' as const, id: allocateEntityId('usr') },
    authority: { kind: 'direct' as const, instructionReference: 'fixture:async' },
    sourceReferences: [],
  };
  const revision = notebook.initialize({ files, sourcePointers, metadata });
  return { root, repositoryPath, notebook, files, sourcePointers, source, metadata, revision };
}

/** Count real children without replacing their result or scheduling. */
function observe() {
  const synchronous = vi.spyOn(childProcess, 'execFileSync');
  const asynchronous = vi.spyOn(childProcess, 'execFile');
  syncBuiltinESMExports();
  onTestFinished(() => {
    synchronous.mockRestore();
    asynchronous.mockRestore();
    syncBuiltinESMExports();
  });
  return { synchronous, asynchronous };
}

it.each([20, 200])(
  'asynchronously inspects %s Pages with two real children and exact bytes',
  async (count) => {
    const f = fixture(count);
    const calls = observe();
    expect((await f.notebook.readRevisionAsync(f.revision)).files).toMatchObject(f.files);
    expect(calls.synchronous).not.toHaveBeenCalled();
    expect(
      calls.asynchronous.mock.calls.map(([, args]) =>
        args!.filter((arg) => arg === 'ls-tree' || arg === 'cat-file')
      )
    ).toEqual([['ls-tree'], ['cat-file']]);
    calls.asynchronous.mockClear();
    expect(await f.notebook.readSourcePointersAsync(f.revision)).toEqual(f.sourcePointers);
    expect(calls.asynchronous).toHaveBeenCalledTimes(2);
    expect(calls.synchronous).not.toHaveBeenCalled();
  }
);

it('keeps omitted damaged objects unread and preserves missing selected-path refusal', async () => {
  const f = fixture();
  const object = childProcess
    .execFileSync(
      'git',
      [`--git-dir=${f.repositoryPath}`, 'rev-parse', `${f.revision}:pages/page-1.md`],
      { encoding: 'utf8' }
    )
    .trim();
  unlinkSync(join(f.repositoryPath, 'objects', object.slice(0, 2), object.slice(2)));
  expect((await f.notebook.readRevisionAsync(f.revision, ['page-0.md'])).files).toEqual({
    'page-0.md': f.files['page-0.md'],
  });
  await expect(f.notebook.readSourcePointersAsync(f.revision)).resolves.toEqual(f.sourcePointers);
  await expect(
    f.notebook.readRevisionAsync(f.revision, ['page-0.md', 'absent.md', 'page-1.md'])
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.notebook.readRevisionAsync(f.revision)).rejects.toBeInstanceOf(NotebookError);
});

it('serves prepared exact bytes with no child, isolated metadata, and no cross-call cache', async () => {
  const f = fixture();
  const prepared = await f.notebook.withPreparedReadsAsync([f.revision]);
  const calls = observe();
  const returned = prepared.readRevision(f.revision);
  (returned.metadata as { summary: string }).summary = 'Caller mutation';
  (returned.files as Record<string, string>)['page-0.md'] = 'Caller mutation';
  expect(prepared.readRevision(f.revision).files).toMatchObject(f.files);
  expect(prepared.inspectRevision(f.revision).metadata.summary).toBe(f.metadata.summary);
  expect(prepared.readSourcePointers(f.revision)).toEqual(f.sourcePointers);
  expect(calls.asynchronous).not.toHaveBeenCalled();
  expect(calls.synchronous).not.toHaveBeenCalled();
  await f.notebook.withPreparedReadsAsync([f.revision]);
  expect(calls.asynchronous).toHaveBeenCalledTimes(2);
});

it('refuses physical root replacement after immutable preparation', async () => {
  const f = fixture();
  const prepared = await f.notebook.withPreparedReadsAsync([f.revision]);
  renameSync(f.repositoryPath, join(f.root, 'original.git'));
  const replacement = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
  replacement.initialize({ metadata: f.metadata });
  expect(() => prepared.readRevision(f.revision)).toThrow(NotebookError);
});

it('writes and publishes the same candidate asynchronously, rechecking immediately before ref dispatch', async () => {
  const f = fixture();
  const prepared = await f.notebook.withPreparedReadsAsync([f.revision]);
  const calls = observe();
  const candidateRevision = await prepared.prepareAsync({
    baseRevision: f.revision,
    changes: { 'page-0.md': '# Exact new bytes\r\n' },
    metadata: { ...f.metadata, summary: 'Update exact bytes' },
  });
  await prepared.preloadRevisionAsync(candidateRevision);
  let admitted = 0;
  await expect(
    prepared.publishAsync({
      baseRevision: f.revision,
      candidateRevision,
      beforePublish: () => {
        admitted++;
      },
    })
  ).resolves.toEqual({ revision: candidateRevision });
  expect(admitted).toBe(1);
  expect(calls.synchronous).not.toHaveBeenCalled();
  const actual = await f.notebook.readRevisionAsync(candidateRevision);
  expect(actual.files['page-0.md']).toBe('# Exact new bytes\r\n');
  expect(actual.files['page-1.md']).toBe(f.files['page-1.md']);
  expect(actual.metadata.summary).toBe('Update exact bytes');
});

it('refuses revoked final admission before any ref effect and never retries it', async () => {
  const f = fixture();
  const prepared = await f.notebook.withPreparedReadsAsync([f.revision]);
  const candidateRevision = await prepared.prepareAsync({
    baseRevision: f.revision,
    changes: { 'page-0.md': '# New' },
    metadata: f.metadata,
  });
  await prepared.preloadRevisionAsync(candidateRevision);
  const denial = new Error('Current permission revoked');
  let admitted = 0;
  await expect(
    prepared.publishAsync({
      baseRevision: f.revision,
      candidateRevision,
      beforePublish: () => {
        admitted++;
        throw denial;
      },
    })
  ).rejects.toBe(denial);
  expect(admitted).toBe(1);
  expect(f.notebook.publishedRevision()).toBe(f.revision);
});

it.each(['truncated', 'trailing', 'wrong type'])(
  'refuses %s asynchronous batch output before returning any Page',
  async (kind) => {
    const f = fixture();
    const original = childProcess.execFile;
    const calls = observe();
    calls.asynchronous.mockImplementation(((...args: unknown[]) => {
      if (args[0] === 'git' && (args[1] as string[]).includes('--batch')) {
        const callback = args[3] as (...values: unknown[]) => void;
        args[3] = (error: unknown, stdout: Buffer, stderr: Buffer) => {
          const changed =
            kind === 'truncated'
              ? stdout.subarray(0, stdout.length - 2)
              : kind === 'trailing'
                ? Buffer.concat([stdout, Buffer.from('extra')])
                : Buffer.from(stdout.toString('latin1').replace(' commit ', ' blob '), 'latin1');
          callback(error, changed, stderr);
        };
      }
      return Reflect.apply(original, childProcess, args);
    }) as typeof childProcess.execFile);
    await expect(f.notebook.readRevisionAsync(f.revision)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(calls.asynchronous).toHaveBeenCalledTimes(2);
    expect(calls.synchronous).not.toHaveBeenCalled();
  }
);

it('keeps Main responsive within 250 ms while one publication awaits its real fsck result', async () => {
  const f = fixture();
  const prepared = await f.notebook.withPreparedReadsAsync([f.revision]);
  const candidateRevision = await prepared.prepareAsync({
    baseRevision: f.revision,
    changes: { 'page-0.md': '# Published' },
    metadata: f.metadata,
  });
  await prepared.preloadRevisionAsync(candidateRevision);
  const original = childProcess.execFile;
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls = observe();
  calls.asynchronous.mockImplementation(((...args: unknown[]) => {
    if (args[0] === 'git' && (args[1] as string[]).includes('fsck')) {
      const callback = args[3] as (...values: unknown[]) => void;
      args[3] = (...values: unknown[]) => {
        reached.resolve();
        void release.promise.then(() => callback(...values));
      };
    }
    return Reflect.apply(original, childProcess, args);
  }) as typeof childProcess.execFile);
  const publication = prepared.publishAsync({ baseRevision: f.revision, candidateRevision });
  try {
    await reached.promise;
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(performance.now() - start).toBeLessThan(250);
    expect(calls.synchronous).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await publication;
  }
  expect(await f.notebook.publishedRevisionAsync()).toBe(candidateRevision);
});
