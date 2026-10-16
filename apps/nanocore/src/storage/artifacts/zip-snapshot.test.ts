import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yauzl';
import { FileStorageAdmission } from './file-admission.js';
import { stageZipSnapshot, ZipExtractionBudget } from './zip-snapshot.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

/** Frozen parser bytes and expected dispositions prepared before production implementation. */
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../tests/fixtures/large-context/cases.json', import.meta.url),
    'utf8'
  )
) as {
  archives: Array<{
    id: string;
    base64: string;
    expected: string;
    entries: Array<{ name: string; actualSize: number; bodySha256: string }>;
  }>;
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Keeps hostile bytes and every extraction attempt within one disposable filesystem. */
async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-zip-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspaces', 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const archivePath = join(root, 'original.zip');
  const item = corpus.archives.find((entry) => entry.id === id)!;
  const original = Buffer.from(item.base64, 'base64');
  await writeFile(archivePath, original);
  const reservation = new FileStorageAdmission(root, () => 0n).reserve({
    stagingBytes: 0n,
    extractionBytes: 4_000_000_000n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  return {
    root,
    workspaceRoot,
    archivePath,
    original,
    budget: new ZipExtractionBudget(),
    reservation,
  };
}

describe('bounded ZIP folder snapshots', () => {
  it.each([
    'valid-empty',
    'valid-file',
    'compressed',
  ])('extracts %s without changing its original', async (id) => {
    const state = await fixture(id);
    const staged = await stageZipSnapshot(state);
    expect(await readFile(state.archivePath)).toEqual(state.original);
    if (id === 'valid-empty') expect(staged.files).toEqual([]);
    else {
      expect(staged.files).toHaveLength(1);
      const file = staged.files[0]!;
      const expected = corpus.archives.find((entry) => entry.id === id)!.entries[0]!;
      const bytes = await readFile(join(staged.root, file.relativePath));
      expect(file).toEqual({
        relativePath: expected.name,
        byteLength: expected.actualSize,
        contentDigest: expected.bodySha256,
      });
      expect(bytes.length).toBe(expected.actualSize);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
        expected.bodySha256
      );
    }
    await staged.remove();
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it.each(
    corpus.archives.filter((entry) => !['valid', 'no-automatic-recursion'].includes(entry.expected))
  )('refuses the frozen $id archive and publishes no partial tree', async ({ id }) => {
    const state = await fixture(id);
    await expect(stageZipSnapshot(state)).rejects.toThrow();
    expect(await readFile(state.archivePath)).toEqual(state.original);
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
    expect(await readdir(state.root)).toEqual(['original.zip', 'workspaces']);
  });

  it('owns source errors and closes the source when cancellation wins during destination open', async () => {
    const state = await fixture('valid-file');
    const controller = new AbortController();
    let releaseOpen!: () => void;
    let reachedOpen!: () => void;
    const entered = new Promise<void>((resolve) => {
      reachedOpen = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let source!: Readable;
    const actualSource = ZipFile.prototype.openReadStreamPromise;
    vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementationOnce(
      async function (entry, options) {
        source = await actualSource.call(this, entry, options);
        return source;
      }
    );
    vi.mocked(open).mockImplementation(async (...args) => {
      if (typeof args[1] === 'number' && args[1] & constants.O_WRONLY) {
        reachedOpen();
        await gate;
      }
      return actualFs.open(...args);
    });
    const work = stageZipSnapshot({ ...state, budget: new ZipExtractionBudget(controller.signal) });
    const refused = expect(work).rejects.toThrow();
    await entered;
    const ownedErrorHandlers = source.listenerCount('error');
    // Keep a failed regression from terminating the test process before reporting its assertion.
    source.on('error', () => {});
    controller.abort(new Error('cancelled during destination open'));
    releaseOpen();
    await refused;
    expect(ownedErrorHandlers).toBeGreaterThan(0);
    expect(source.destroyed).toBe(true);
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it('destroys a source acquired after cancellation without leaving an extraction directory', async () => {
    const state = await fixture('valid-file');
    const controller = new AbortController();
    let releaseSource!: (source: Readable) => void;
    let reachedSource!: () => void;
    const entered = new Promise<void>((resolve) => {
      reachedSource = resolve;
    });
    vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementationOnce(() => {
      reachedSource();
      return new Promise<Readable>((resolve) => {
        releaseSource = resolve;
      });
    });
    const work = stageZipSnapshot({ ...state, budget: new ZipExtractionBudget(controller.signal) });
    const refused = expect(work).rejects.toThrow();
    await entered;
    controller.abort(new Error('cancelled during source acquisition'));
    await refused;
    const lateSource = Readable.from([Buffer.from('late bytes')]);
    releaseSource(lateSource);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateSource.destroyed).toBe(true);
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it('retains a nested archive as an ordinary file without recursive extraction', async () => {
    const state = await fixture('nested');
    const staged = await stageZipSnapshot(state);
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]?.relativePath).toMatch(/\.zip$/);
    expect(await readdir(staged.root)).toHaveLength(1);
    await staged.remove();
  });

  it('refuses actual expansion above the shared budget despite an otherwise valid archive', async () => {
    const state = await fixture('compressed');
    state.budget.consume(4_000_000_000);
    await expect(stageZipSnapshot(state)).rejects.toThrow('expansion byte limit');
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it('counts real parser entries against the cumulative entry limit', async () => {
    const state = await fixture('valid-file');
    for (let entry = 0; entry < 100_000; entry += 1) state.budget.admitEntry('x');
    await expect(stageZipSnapshot(state)).rejects.toThrow('entry or inventory');
    expect(await readdir(join(state.root, 'workspaces', '.staging'))).toEqual([]);
  });

  it('admits exactly the byte ceiling and refuses one additional expanded byte', () => {
    const budget = new ZipExtractionBudget();
    budget.consume(3_999_999_999);
    budget.consume(1);
    expect(() => budget.consume(1)).toThrow('expansion byte limit');
  });

  it('refuses cancellation before creating extraction staging', async () => {
    const state = await fixture('compressed');
    const controller = new AbortController();
    controller.abort();
    await expect(
      stageZipSnapshot({ ...state, budget: new ZipExtractionBudget(controller.signal) })
    ).rejects.toThrow();
    expect(await readdir(join(state.root, 'workspaces'))).toEqual(['workspace']);
  });
});
