import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCatalogTree } from './resource-catalog.js';
import { acquireDownloadedEcosystemSkill } from './skill-download-source.js';
import { parseSkillImportSource, SkillSourceInputError } from './skill-source.js';

const header = Buffer.from(
  '\uFEFF---\r\nname: Plain Skill\r\ndescription: Keep original bytes.\r\n---\r\nRead references/data.bin.\r\n'
);
// Real Unix ZIP fixtures produced by Python's standard zipfile writer, without a test-time tool.
const zip = Buffer.from(
  'UEsDBBQAAAAIAAAAIQCnBx0TWwAAAF4AAAAaAAAAcmVwby9za2lsbHMvcGxhaW4vU0tJTEwubWQdy7ENgCAQBdCehB1uAbRnBRujE5zwNRfxNEDjbBaO5Aoa65f3XLdzzhrlDZ76xKI0rpKSNRElZDmq7OqpAw7asyyinGg6K0pjzV8HcKSMGRkaUNrIlZtJ9PMXUEsDBBQAAAAIAAAAIQAAAAAAAgAAAAAAAAAYAAAAcmVwby9za2lsbHMvcGxhaW4vZW1wdHkvAwBQSwMEFAAAAAgAAAAhADZ2OOkaAAAAGAAAABgAAAByZXBvL3NraWxscy9wbGFpbi9ydW4uc2hTVtRPyszTL87gSk3OyFdILC3JyC9KTeECAFBLAwQUAAAACAAAACEAiAyeTAcAAAAFAAAAJQAAAHJlcG8vc2tpbGxzL3BsYWluL3JlZmVyZW5jZXMvZGF0YS5iaW5j+M/IywUAUEsBAhQDFAAAAAgAAAAhAKcHHRNbAAAAXgAAABoAAAAAAAAAAAAAAKSBAAAAAHJlcG8vc2tpbGxzL3BsYWluL1NLSUxMLm1kUEsBAhQDFAAAAAgAAAAhAAAAAAACAAAAAAAAABgAAAAAAAAAAAAAAO1BkwAAAHJlcG8vc2tpbGxzL3BsYWluL2VtcHR5L1BLAQIUAxQAAAAIAAAAIQA2djjpGgAAABgAAAAYAAAAAAAAAAAAAADpgcsAAAByZXBvL3NraWxscy9wbGFpbi9ydW4uc2hQSwECFAMUAAAACAAAACEAiAyeTAcAAAAFAAAAJQAAAAAAAAAAAAAApIEbAQAAcmVwby9za2lsbHMvcGxhaW4vcmVmZXJlbmNlcy9kYXRhLmJpblBLBQYAAAAABAAEACcBAABlAQAAAAA=',
  'base64'
);
const unsafeZip = Buffer.from(
  'UEsDBBQAAAAIAAAAIQCnBx0TWwAAAF4AAAALAAAALi4vU0tJTEwubWQdy7ENgCAQBdCehB1uAbRnBRujE5zwNRfxNEDjbBaO5Aoa65f3XLdzzhrlDZ76xKI0rpKSNRElZDmq7OqpAw7asyyinGg6K0pjzV8HcKSMGRkaUNrIlZtJ9PMXUEsBAhQDFAAAAAgAAAAhAKcHHRNbAAAAXgAAAAsAAAAAAAAAAAAAAKSBAAAAAC4uL1NLSUxMLm1kUEsFBgAAAAABAAEAOQAAAIQAAAAAAA==',
  'base64'
);
const duplicateZip = Buffer.from(
  'UEsDBBQAAAAIAAAAIQCnBx0TWwAAAF4AAAAIAAAAU0tJTEwubWQdy7ENgCAQBdCehB1uAbRnBRujE5zwNRfxNEDjbBaO5Aoa65f3XLdzzhrlDZ76xKI0rpKSNRElZDmq7OqpAw7asyyinGg6K0pjzV8HcKSMGRkaUNrIlZtJ9PMXUEsDBBQAAAAIAAAAIQCnBx0TWwAAAF4AAAAIAAAAU0tJTEwubWQdy7ENgCAQBdCehB1uAbRnBRujE5zwNRfxNEDjbBaO5Aoa65f3XLdzzhrlDZ76xKI0rpKSNRElZDmq7OqpAw7asyyinGg6K0pjzV8HcKSMGRkaUNrIlZtJ9PMXUEsBAhQDFAAAAAgAAAAhAKcHHRNbAAAAXgAAAAgAAAAAAAAAAAAAAKSBAAAAAFNLSUxMLm1kUEsBAhQDFAAAAAgAAAAhAKcHHRNbAAAAXgAAAAgAAAAAAAAAAAAAAKSBgQAAAFNLSUxMLm1kUEsFBgAAAAACAAIAbAAAAAIBAAAAAA==',
  'base64'
);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

/** Exercises actual HTTP framing and fetch decoding rather than replacing acquisition transport. */
async function serve(body: Buffer, headers: Record<string, string> = {}) {
  const requests: { authorization: string | undefined; cookie: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(200, headers);
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not listen.');
  const url = `http://127.0.0.1:${address.port}/extensionless?token=fixture-only`;
  const source = parseSkillImportSource(url);
  if (source.kind !== 'download') throw new Error('HTTP fixture was not a download.');
  return { source, requests, locator: url.split('?')[0] };
}

/** Uses the maintained TAR writer to preserve real headers, PAX Unicode names and entry types. */
async function tar(entries: readonly { header: Partial<Header> & Pick<Header, 'name'>; body?: Buffer }[]) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  })();
  for (const entry of entries) archive.entry(entry.header, entry.body ?? Buffer.alloc(0));
  archive.finalize();
  return collected;
}

describe('downloaded ecosystem Skill acquisition', () => {
  it('retains direct original SKILL.md bytes and sanitized provenance without fetching references', async () => {
    const fixture = await serve(header);
    const result = await acquireDownloadedEcosystemSkill(fixture.source);
    expect(result).toEqual({
      name: 'Plain Skill',
      source: fixture.locator,
      subpath: '',
      tree: [{ path: 'SKILL.md', kind: 'file', executable: false, contentBase64: header.toString('base64') }],
      digest: validateCatalogTree([{ path: 'SKILL.md', kind: 'file', contentBase64: header.toString('base64') }]).digest,
    });
    expect(fixture.requests).toEqual([{ authorization: undefined, cookie: undefined }]);
    expect(result).not.toHaveProperty('sourceCommit');
  });

  it('discovers an extensionless hosted ZIP wrapper with binary support, executable and empty directory', async () => {
    const fixture = await serve(zip);
    const result = await acquireDownloadedEcosystemSkill(fixture.source);
    expect(result.subpath).toBe('repo/skills/plain');
    expect(result.tree).toEqual([
      { path: 'SKILL.md', kind: 'file', executable: false, contentBase64: header.toString('base64') },
      { path: 'empty', kind: 'directory' },
      { path: 'run.sh', kind: 'file', executable: true, contentBase64: Buffer.from('#!/bin/sh\necho authored\n').toString('base64') },
      { path: 'references/data.bin', kind: 'file', executable: false, contentBase64: Buffer.from([0, 255, 1, 13, 10]).toString('base64') },
    ]);
    expect(result.digest).toBe(validateCatalogTree(result.tree).digest);
  });

  it('reads TAR and compressed TAR, preserving Unicode paths and exact selected package bytes', async () => {
    const bytes = await tar([
      { header: { name: 'repo/skills/one/SKILL.md' }, body: header },
      { header: { name: 'repo/skills/one/référence.txt' }, body: Buffer.from('authored\r\n') },
      { header: { name: 'repo/skills/one/empty/', type: 'directory' } },
      { header: { name: 'repo/skills/two/SKILL.md' }, body: header },
    ]);
    const plain = await serve(bytes);
    await expect(acquireDownloadedEcosystemSkill(plain.source)).rejects.toThrow(SkillSourceInputError);
    await expect(acquireDownloadedEcosystemSkill({ ...plain.source, skillName: 'Plain Skill' })).rejects.toThrow(SkillSourceInputError);
    await expect(acquireDownloadedEcosystemSkill({ ...plain.source, subpath: 'absent' })).rejects.toThrow(SkillSourceInputError);
    const selected = await acquireDownloadedEcosystemSkill({ ...plain.source, subpath: 'repo/skills/one' });
    const compressed = await serve(gzipSync(bytes));
    const selectedGzip = await acquireDownloadedEcosystemSkill({ ...compressed.source, subpath: 'repo/skills/one' });
    expect(selectedGzip.tree).toEqual(selected.tree);
    expect(selectedGzip.digest).toBe(selected.digest);
    expect(selected.tree).toContainEqual({ path: 'référence.txt', kind: 'file', executable: false, contentBase64: Buffer.from('authored\r\n').toString('base64') });
    expect(selected.tree).toContainEqual({ path: 'empty', kind: 'directory' });
  });

  it('refuses unsafe ZIP paths and duplicate archive identities before returning a tree', async () => {
    for (const bytes of [unsafeZip, duplicateZip]) {
      const fixture = await serve(bytes);
      await expect(acquireDownloadedEcosystemSkill(fixture.source)).rejects.toThrow(new SkillSourceInputError());
    }
  });

  it('refuses TAR links even outside the selected package', async () => {
    const fixture = await serve(await tar([
      { header: { name: 'SKILL.md' }, body: header },
      { header: { name: 'outside', type: 'symlink', linkname: '/host/path' } },
    ]));
    await expect(acquireDownloadedEcosystemSkill(fixture.source)).rejects.toThrow(SkillSourceInputError);
  });

  it('bounds actual streamed HTTP bytes despite a small compressed Content-Length', async () => {
    const encoded = gzipSync(Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    const fixture = await serve(encoded, { 'content-encoding': 'gzip', 'content-length': String(encoded.length) });
    await expect(acquireDownloadedEcosystemSkill(fixture.source)).rejects.toThrow(new SkillSourceInputError());
  });

  it('refuses archive expansion and regular-file inventory beyond their limits', async () => {
    const oversized = await serve(gzipSync(await tar([
      { header: { name: 'SKILL.md' }, body: header },
      { header: { name: 'large' }, body: Buffer.alloc(25 * 1024 * 1024 + 1) },
    ])));
    await expect(acquireDownloadedEcosystemSkill(oversized.source)).rejects.toThrow(SkillSourceInputError);
    const many = await serve(gzipSync(await tar([
      { header: { name: 'SKILL.md' }, body: header },
      ...Array.from({ length: 1_000 }, (_, index) => ({ header: { name: `file-${index}` } })),
    ])));
    await expect(acquireDownloadedEcosystemSkill(many.source)).rejects.toThrow(SkillSourceInputError);
  });

  it('refuses malformed selected content and corrupt ZIP size declarations without exposing source content', async () => {
    const corrupted = Buffer.from(zip);
    const central = corrupted.indexOf(Buffer.from('504b0102', 'hex'));
    corrupted.writeUInt32LE(1, central + 24);
    const fixture = await serve(corrupted);
    await expect(acquireDownloadedEcosystemSkill(fixture.source)).rejects.toThrow(new SkillSourceInputError());
    const invalid = await serve(Buffer.from('---\nname: missing-description\n---\nPrivate body.'));
    await expect(acquireDownloadedEcosystemSkill(invalid.source)).rejects.toThrow(new SkillSourceInputError());
  });

  it('applies the selected catalog tree bound after bounded archive acquisition', async () => {
    const fixture = await serve(gzipSync(await tar([
      { header: { name: 'SKILL.md' }, body: header },
      { header: { name: 'support' }, body: Buffer.alloc(16 * 1024 * 1024) },
    ])));
    await expect(acquireDownloadedEcosystemSkill(fixture.source)).rejects.toThrow(SkillSourceInputError);
  });
});
