import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { directoryContainsFiles } from '@openkit/storage';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalArtifact, sha256Hex } from './catalog.js';
import { ensureArtifact } from './download.js';
import { localAiRoot } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('speech artifact download', () => {
  it('refuses a length or digest mismatch before publishing a file', async () => {
    const dataRoot = tempRoot();
    const artifact = pinned(Buffer.from('good'), 'models/sample');
    const fetchImpl = fetchOf(Buffer.from('no'));
    await expect(ensureArtifact(dataRoot, artifact, fetchImpl)).rejects.toThrow(/length/);
    expect(directoryContainsFiles(join(localAiRoot(dataRoot), artifact.publishPath))).toBe(false);

    const digestMiss = fetchOf(Buffer.from('bad!'));
    await expect(ensureArtifact(dataRoot, artifact, digestMiss)).rejects.toThrow(/digest/);
    expect(directoryContainsFiles(join(localAiRoot(dataRoot), artifact.publishPath))).toBe(false);
  });

  it('publishes a verified archive and does not download it again', async () => {
    const dataRoot = tempRoot();
    const body = await gzipArchive({ 'package/model.onnx': 'weights' });
    const artifact = pinned(body, 'models/sample');
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return new Response(body);
    };
    await ensureArtifact(dataRoot, artifact, fetchImpl);
    expect(directoryContainsFiles(join(localAiRoot(dataRoot), 'models/sample'))).toBe(true);
    await ensureArtifact(dataRoot, artifact, fetchImpl);
    expect(fetches).toBe(1);
  });

  it('publishes nothing when the download signal is already aborted', async () => {
    const dataRoot = tempRoot();
    const body = Buffer.from('good');
    const artifact = pinned(body, 'models/sample');
    const signal = AbortSignal.abort();
    const fetchImpl: typeof fetch = async () => new Response(body);
    await expect(ensureArtifact(dataRoot, artifact, fetchImpl, undefined, signal)).rejects.toThrow(
      /cancelled/
    );
    expect(directoryContainsFiles(join(localAiRoot(dataRoot), artifact.publishPath))).toBe(false);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-local-ai-'));
  roots.push(root);
  return root;
}

function pinned(body: Buffer, publishPath: string): LocalArtifact {
  return {
    id: 'sample',
    license: 'Apache-2.0',
    url: 'http://127.0.0.1/artifact',
    bytes: body.byteLength,
    sha256: sha256Hex(body),
    archive: 'tar.gz',
    publishPath,
  };
}

function fetchOf(body: Buffer): typeof fetch {
  return async () => new Response(body);
}

function gzipArchive(entries: Record<string, string>): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    tar.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    tar.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    tar.on('error', reject);
  });
  for (const [name, content] of Object.entries(entries)) tar.entry({ name }, Buffer.from(content));
  tar.finalize();
  return done;
}
