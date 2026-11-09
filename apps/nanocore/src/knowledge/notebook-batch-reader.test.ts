import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { KnowledgeNotebook, NotebookError } from './notebook.js';

/** Real immutable Git fixtures; metadata is not current publication authority. */
function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'notebook-batch-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const files = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `page-${index}.md`,
      `\uFEFF# Exact Page ${index}\r\n${'Retained bytes.\n'.repeat(32)}\0`,
    ])
  );
  const sourcePointers = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      allocateEntityId('ks'),
      `\uFEFF# Exact Source ${index}\r\nRetained pointer bytes.\n`,
    ])
  );
  const revision = notebook.initialize({
    files,
    sourcePointers,
    metadata: {
      summary: 'Create exact immutable content',
      changeRequest: { requestId: 'batch-reader', inputDigest: `sha256:${'1'.repeat(64)}` },
      producer: { kind: 'user', id: allocateEntityId('usr') },
      authority: { kind: 'direct', instructionReference: 'fixture:batch-reader' },
      sourceReferences: [],
    },
  });
  return { notebook, repositoryPath, revision, files, sourcePointers };
}

/** Observe native child launches, including stdin, without replacing any Git result. */
function observeProcesses() {
  const processes = vi.spyOn(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  onTestFinished(() => {
    processes.mockRestore();
    syncBuiltinESMExports();
  });
  return processes;
}

it.each([20, 200])(
  'uses two real Git children per inspection with %s Pages and Sources',
  (count) => {
    const f = fixture(count);
    const processes = observeProcesses();
    const source = Object.keys(f.sourcePointers)[0]!;
    const operations = [
      () => expect(f.notebook.readRevision(f.revision).files).toMatchObject(f.files),
      () => expect(f.notebook.readSourcePointers(f.revision)).toEqual(f.sourcePointers),
      () =>
        expect(f.notebook.readContent(f.revision, ['page-0.md', `@sources/${source}.md`])).toEqual({
          'page-0.md': f.files['page-0.md'],
          [`@sources/${source}.md`]: f.sourcePointers[source],
        }),
      () => expect(f.notebook.inspectRevision(f.revision).revision).toBe(f.revision),
      () => expect(f.notebook.readRevision(f.revision, []).files).toEqual({}),
    ];
    for (const [index, operation] of operations.entries()) {
      processes.mockClear();
      operation();
      const commands = processes.mock.calls.map(([file, args, options]) => {
        expect(file).toBe('git');
        const directory = args!.indexOf(`--git-dir=${f.repositoryPath}`);
        expect(directory).toBeGreaterThanOrEqual(0);
        return { args: args!.slice(directory + 1), input: String(options!.input) };
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]!.args).toEqual(['ls-tree', '-r', '-z', '--full-tree', f.revision]);
      expect(commands[1]!.args).toEqual(['cat-file', '--batch']);
      const requests = commands[1]!.input.trimEnd().split('\n');
      expect(requests[0]).toBe(f.revision);
      expect(requests).toHaveLength([count + 2, count + 1, 3, 1, 1][index]!);
    }
  }
);

it('does not load omitted Page objects, and stops before the first absent selected path', () => {
  const f = fixture();
  const object = childProcess
    .execFileSync(
      'git',
      [`--git-dir=${f.repositoryPath}`, 'rev-parse', `${f.revision}:pages/page-1.md`],
      { encoding: 'utf8' }
    )
    .trim();
  unlinkSync(join(f.repositoryPath, 'objects', object.slice(0, 2), object.slice(2)));
  expect(f.notebook.readRevision(f.revision, ['page-0.md']).files).toEqual({
    'page-0.md': f.files['page-0.md'],
  });
  expect(f.notebook.readSourcePointers(f.revision)).toEqual(f.sourcePointers);
  const processes = observeProcesses();
  expect(() =>
    f.notebook.readRevision(f.revision, ['page-0.md', 'absent.md', 'page-1.md'])
  ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  expect(String(processes.mock.calls[1]![2]!.input).trimEnd().split('\n')).toHaveLength(2);
  expect(() => f.notebook.readRevision(f.revision)).toThrowError(
    expect.objectContaining({ code: 'recovery_required' })
  );
});

/** Alter only a real batch's stdout to exercise strict stream framing, not a content-owner double. */
const malformed: Record<string, (bytes: Buffer) => Buffer> = {
  empty: () => Buffer.alloc(0),
  'truncated header': (bytes) => bytes.subarray(0, 12),
  'truncated body': (bytes) => bytes.subarray(0, -2),
  'missing terminator': (bytes) => bytes.subarray(0, -1),
  'extra bytes': (bytes) => Buffer.concat([bytes, Buffer.from('\n')]),
  'extra record': (bytes) => Buffer.concat([bytes, bytes]),
  'missing records': (bytes) => {
    const boundary = bytes.indexOf(10);
    const size = Number(bytes.toString('latin1', 0, boundary).split(' ')[2]);
    return bytes.subarray(0, boundary + size + 2);
  },
  'wrong identity': (bytes) => Buffer.concat([Buffer.from('0'.repeat(40)), bytes.subarray(40)]),
  'wrong commit type': (bytes) =>
    Buffer.from(bytes.toString('latin1').replace(' commit ', ' blob '), 'latin1'),
  'wrong blob type': (bytes) =>
    Buffer.from(bytes.toString('latin1').replace(' blob ', ' commit '), 'latin1'),
  'noncanonical size': (bytes) =>
    Buffer.from(bytes.toString('latin1').replace(/ commit (\d+)\n/, ' commit 0$1\n'), 'latin1'),
  'negative size': (bytes) =>
    Buffer.from(bytes.toString('latin1').replace(/ commit \d+\n/, ' commit -1\n'), 'latin1'),
  'oversized object': (bytes) =>
    Buffer.from(
      bytes.toString('latin1').replace(/ commit \d+\n/, ` commit ${33 * 1024 * 1024 + 1}\n`),
      'latin1'
    ),
  'short size': (bytes) =>
    Buffer.from(
      bytes
        .toString('latin1')
        .replace(/ commit (\d+)\n/, (_all, size) => ` commit ${Number(size) - 1}\n`),
      'latin1'
    ),
  'long size': (bytes) =>
    Buffer.from(
      bytes
        .toString('latin1')
        .replace(/ commit (\d+)\n/, (_all, size) => ` commit ${Number(size) + 1}\n`),
      'latin1'
    ),
  'non-ASCII header': (bytes) => Buffer.concat([Buffer.from([255]), bytes.subarray(1)]),
  'blob hash mismatch': (bytes) => {
    const changed = Buffer.from(bytes);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    return changed;
  },
};

it.each(Object.keys(malformed))('refuses %s batch output without partial success', (kind) => {
  const f = fixture();
  const original = childProcess.execFileSync;
  const processes = observeProcesses();
  processes.mockImplementation(((...args: unknown[]) => {
    const result = Reflect.apply(original, childProcess, args);
    return args[0] === 'git' && (args[1] as string[]).includes('--batch')
      ? malformed[kind]!(result as Buffer)
      : result;
  }) as typeof childProcess.execFileSync);
  let result: unknown;
  let error: unknown;
  try {
    result = f.notebook.readContent(f.revision);
  } catch (caught) {
    error = caught;
  }
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(NotebookError);
  expect(error).toMatchObject({ code: 'recovery_required' });
  expect(processes.mock.calls).toHaveLength(2);
});

it('keeps the byte bound per object when the full selected batch exceeds 33 MiB', () => {
  const f = fixture(0);
  const changes = {
    'a.md': `# A\n${'a'.repeat(17 * 1024 * 1024)}`,
    'b.md': `# B\n${'b'.repeat(17 * 1024 * 1024)}`,
  };
  // Initial human content retains the existing whole-Notebook read bound, distinct from editor limits.
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(f.repositoryPath, '..', 'large.git'),
  });
  const revision = notebook.initialize({
    files: changes,
    metadata: f.notebook.inspectRevision(f.revision).metadata,
  });
  expect(notebook.readRevision(revision).files).toMatchObject(changes);
});
