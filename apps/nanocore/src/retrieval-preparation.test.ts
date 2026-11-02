// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type RetrievalScope,
  RetrievalService,
  RetrievalServiceError,
  retrievalExecutable,
} from './retrieval-service.js';

const roots: string[] = [];
const services: RetrievalService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  { obstruction: 'nested derived bytes exceed capacity', code: 'resource-limited' },
  { obstruction: 'nested derived entry links outside the store', code: 'unavailable' },
] as const)('refuses publication when $obstruction and permits a corrected request', async ({
  code,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-preparation-'));
  roots.push(root);
  const sourcesRoot = join(root, 'sources');
  const storeRoot = join(root, 'store');
  const blocker = join(storeRoot, 'nested', 'deeper', 'entry');
  mkdirSync(sourcesRoot);
  mkdirSync(join(storeRoot, 'nested', 'deeper'), { recursive: true });
  const text = 'original source needle\n';
  const sourcePath = join(sourcesRoot, 'source.txt');
  writeFileSync(sourcePath, text);
  // Retrieval Kernel: Searchable Representations bounds derived disk; pin admission before the run.
  const service = new RetrievalService({
    executable: resolve(process.env.OPENKIT_RETRIEVAL_KERNEL_EXECUTABLE ?? retrievalExecutable()),
    sourcesRoot,
    storeRoot,
    storeLimitBytes: 512 * 1024 * 1024 + 32 * 1024,
  });
  services.push(service);
  const view: RetrievalScope = {
    scope: 'preparation',
    documents: [
      {
        key: { namespace: 'preparation-test', id: 'source' },
        revision: '1',
        digest: createHash('sha256').update(text).digest('hex'),
        size: Buffer.byteLength(text),
        name: 'source.txt',
        media_type: 'text/plain',
        content: { kind: 'text', path: 'source.txt' },
      },
    ],
  };
  if (code === 'resource-limited') writeFileSync(blocker, Buffer.alloc(64 * 1024));
  else symlinkSync(sourcePath, blocker);
  const failure: unknown = await service.publish(view, null).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RetrievalServiceError);
  expect(failure).toMatchObject({ code, uncertain: false });
  expect(await service.inspect(view.scope)).toBeNull();
  expect(readFileSync(sourcePath, 'utf8')).toBe(text);
  unlinkSync(blocker);
  const generation = await service.publish(view, null);
  expect(await service.inspect(view.scope)).toBe(generation);
  expect(
    await service.search({ mode: 'exact', query: 'needle', scopes: [view], limit: 1 })
  ).toMatchObject({ complete: true, hits: [{ key: view.documents[0]!.key }] });
  expect(readFileSync(sourcePath, 'utf8')).toBe(text);
}, 30_000);
