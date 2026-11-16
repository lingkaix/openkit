import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { assertWorkspaceArchiveFilePath, workspaceArchiveHeader } from './workspace-archive.js';

/** Decodes actual emitted framing with the existing standard TAR dependency. */
async function readEntry(path: string, type: 'file' | 'directory', content = Buffer.alloc(0)) {
  const archive = extract();
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const feeding = pipeline(
    Readable.from([
      workspaceArchiveHeader(path, type, content.length),
      content,
      padding,
      Buffer.alloc(1024),
    ]),
    archive
  );
  const entries: { path: string; type: string | null; content: Buffer }[] = [];
  for await (const stream of archive) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    entries.push({
      path: stream.header.name,
      type: stream.header.type ?? null,
      content: Buffer.concat(chunks),
    });
  }
  await feeding;
  return entries;
}

describe('Workspace archive PAX paths', () => {
  it.each([
    `workspace-files/knowledge/pages/${'a'.repeat(130)}.md`,
    `workspace-files/knowledge/pages/${'é'.repeat(70)}.md`,
    `workspace-files/knowledge/pages/${'a/'.repeat(140)}page.md`,
    `workspace-files/knowledge/pages/${'a/'.repeat(480)}page.md`,
  ])('writes a standard PAX path for %s', async (path) => {
    expect(() => assertWorkspaceArchiveFilePath(path)).not.toThrow();
    const header = workspaceArchiveHeader(path, 'file', 8);
    expect(header[156]).toBe('x'.charCodeAt(0));
    expect(header.length % 512).toBe(0);
    expect(await readEntry(path, 'file', Buffer.from('Portable'))).toEqual([
      { path, type: 'file', content: Buffer.from('Portable') },
    ]);
  });

  it('preserves a long derived directory and its directory type', async () => {
    const path = `workspace-files/knowledge/pages/${'a'.repeat(130)}/`;
    expect(await readEntry(path, 'directory')).toEqual([
      { path, type: 'directory', content: Buffer.alloc(0) },
    ]);
  });

  // Digests were captured from the unchanged rc.9 writer at 4e0fae56e.
  it.each([
    [
      'manifest.json',
      'file',
      127,
      undefined,
      'b12e5f6a404c43a292ea428326de2ef680754dd061f6f81846fd76418c70f7d1',
    ],
    [
      'workspace-files/knowledge/pages/',
      'directory',
      0,
      undefined,
      '704f69249d9263948336c06a31db62c23476a02855ea6808619cdac8c52a473c',
    ],
    [
      `workspace-files/knowledge/pages/${'a'.repeat(60)}/${'b'.repeat(60)}.md`,
      'file',
      51,
      0o600,
      'a4ab895ccfee4a92725c781714dad498059c76582620ea471e832dcca621d91d',
    ],
  ] as const)('keeps rc.9 header bytes for %s', (path, type, size, mode, digest) => {
    const header = workspaceArchiveHeader(path, type, size, mode);
    expect(header.length).toBe(512);
    expect(createHash('sha256').update(header).digest('hex')).toBe(digest);
  });

  it.each([
    '',
    '/absolute',
    '../outside',
    'a/../outside',
    './page',
    'a//page',
    'a\\page',
    'a/./page',
    'a/\u0000page',
    'a/\npage',
    'a/\u007fpage',
    'e\u0301.md',
    'page/',
  ])('still rejects unsafe file path %j', (path) => {
    expect(() => assertWorkspaceArchiveFilePath(path)).toThrow();
    expect(() => workspaceArchiveHeader(path, 'file', 0)).toThrow();
  });
});
