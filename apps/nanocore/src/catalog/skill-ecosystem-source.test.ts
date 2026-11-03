import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { type Header, pack } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRemoteEcosystemSkill } from './skill-ecosystem-source.js';
import { SkillSourceInputError } from './skill-source.js';

const header = Buffer.from(
  '\uFEFF---\r\nname: Plain Skill\r\ndescription: Keep original bytes.\r\n---\r\nRead references/data.bin.\r\n'
);
// Real Unix ZIP fixtures produced by Python's standard zipfile writer, without a test-time tool.
const zip = Buffer.from(
  'UEsDBBQAAAAIAAAAIQCnBx0TWwAAAF4AAAAaAAAAcmVwby9za2lsbHMvcGxhaW4vU0tJTEwubWQdy7ENgCAQBdCehB1uAbRnBRujE5zwNRfxNEDjbBaO5Aoa65f3XLdzzhrlDZ76xKI0rpKSNRElZDmq7OqpAw7asyyinGg6K0pjzV8HcKSMGRkaUNrIlZtJ9PMXUEsDBBQAAAAIAAAAIQAAAAAAAgAAAAAAAAAYAAAAcmVwby9za2lsbHMvcGxhaW4vZW1wdHkvAwBQSwMEFAAAAAgAAAAhADZ2OOkaAAAAGAAAABgAAAByZXBvL3NraWxscy9wbGFpbi9ydW4uc2hTVtRPyszTL87gSk3OyFdILC3JyC9KTeECAFBLAwQUAAAACAAAACEAiAyeTAcAAAAFAAAAJQAAAHJlcG8vc2tpbGxzL3BsYWluL3JlZmVyZW5jZXMvZGF0YS5iaW5j+M/IywUAUEsBAhQDFAAAAAgAAAAhAKcHHRNbAAAAXgAAABoAAAAAAAAAAAAAAKSBAAAAAHJlcG8vc2tpbGxzL3BsYWluL1NLSUxMLm1kUEsBAhQDFAAAAAgAAAAhAAAAAAACAAAAAAAAABgAAAAAAAAAAAAAAO1BkwAAAHJlcG8vc2tpbGxzL3BsYWluL2VtcHR5L1BLAQIUAxQAAAAIAAAAIQA2djjpGgAAABgAAAAYAAAAAAAAAAAAAADpgcsAAAByZXBvL3NraWxscy9wbGFpbi9ydW4uc2hQSwECFAMUAAAACAAAACEAiAyeTAcAAAAFAAAAJQAAAAAAAAAAAAAApIEbAQAAcmVwby9za2lsbHMvcGxhaW4vcmVmZXJlbmNlcy9kYXRhLmJpblBLBQYAAAAABAAEACcBAABlAQAAAAA=',
  'base64'
);
const unsafeZip = Buffer.from(
  'UEsDBBQAAAAIAGIeUV16SNOCPwAAAD8AAAAOAAAAc2tpbGwvU0tJTEwubWTT1dXlykvMTbVSCE5MS+VKSS1OLsosKMnMzwOKpOakJpcolGRkFisUJCZnJ6an6nHpAjU4lpZk5BelpuhxAQBQSwMEFAAAAAgAYh5RXYqo6mwyAAAAMQAAAA4AAAAuLi9vdXRzaWRlLnR4dAvNK05MS1VILErOyCxLVShILMlQyC8tKc5MSVUoyUhVKE7NSU0uSU0ByiRnJ6an6gEAUEsBAhQDFAAAAAgAYh5RXXpI04I/AAAAPwAAAA4AAAAAAAAAAAAAAIABAAAAAHNraWxsL1NLSUxMLm1kUEsBAhQDFAAAAAgAYh5RXYqo6mwyAAAAMQAAAA4AAAAAAAAAAAAAAIABawAAAC4uL291dHNpZGUudHh0UEsFBgAAAAACAAIAeAAAAMkAAAAAAA==',
  'base64'
);
// Invalid UTF-8 in both stored ZIP filename records; payload bytes and CRC remain valid.
const malformedNameZip = Buffer.from(
  'UEsDBBQAAAAIAIkgUV16SNOCPwAAAD8AAAAOAAAAc2tpbGwvU0tJTEwubWTT1dXlykvMTbVSCE5MS+VKSS1OLsosKMnMzwOKpOakJpcolGRkFisUJCZnJ6an6nHpAjU4lpZk5BelpuhxAQBQSwMEFAAACAgAiSBRXaEznCESAAAAEAAAAA4AAABvdXRzaWRlL/+pLnR4dPNOTS1QKEgsyVBIqixJLdYDAFBLAQIUAxQAAAAIAIkgUV16SNOCPwAAAD8AAAAOAAAAAAAAAAAAAACAAQAAAABza2lsbC9TS0lMTC5tZFBLAQIUAxQAAAgIAIkgUV2hM5whEgAAABAAAAAOAAAAAAAAAAAAAACAAWsAAABvdXRzaWRlL/+pLnR4dFBLBQYAAAAAAgACAHgAAACpAAAAAAA=',
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

interface RecordedRequest {
  authorization: string | undefined;
  cookie: string | undefined;
}

/** Exercises actual HTTP framing and fetch decoding rather than replacing acquisition transport. */
async function serve(body: Buffer, headers: Record<string, string> = {}) {
  const requests: RecordedRequest[] = [];
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
  return { url, locator: url.slice(0, url.indexOf('?')), requests };
}

/** Uses the maintained TAR writer to preserve real headers, PAX Unicode names and entry types. */
async function tar(
  entries: readonly { header: Partial<Header> & Pick<Header, 'name'>; body?: Buffer }[]
) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) {
      if (!(chunk instanceof Uint8Array)) throw new Error('TAR fixture emitted non-byte content.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  })();
  for (const entry of entries) archive.entry(entry.header, entry.body ?? Buffer.alloc(0));
  archive.finalize();
  return collected;
}

/** Asserts the operation's bounded public refusal and returns the error for content checks. */
async function refusal(promise: Promise<unknown>): Promise<SkillSourceInputError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillSourceInputError);
    expect(error instanceof Error ? error.message : '').toBe(
      'Skill source or metadata is invalid.'
    );
    return error as SkillSourceInputError;
  }
  throw new Error('Skill acquisition unexpectedly succeeded.');
}

describe('remote ecosystem Skill acquisition', () => {
  it('retains direct original SKILL.md bytes and sanitized download provenance', async () => {
    const fixture = await serve(header);
    const result = await acquireRemoteEcosystemSkill({ source: fixture.url });
    expect(result).toEqual({
      tree: [
        {
          path: 'SKILL.md',
          kind: 'file',
          executable: false,
          contentBase64: header.toString('base64'),
        },
      ],
      sourceCommit: null,
      sourceLocator: fixture.locator,
      sourceSubpath: null,
    });
    expect(result.sourceLocator).not.toContain('token');
    expect(fixture.requests).toEqual([{ authorization: undefined, cookie: undefined }]);
  });

  it('discovers an extensionless hosted ZIP wrapper with binary support, executable and empty directory', async () => {
    const fixture = await serve(zip);
    const result = await acquireRemoteEcosystemSkill({ source: fixture.url });
    expect(result).toEqual({
      tree: [
        {
          path: 'SKILL.md',
          kind: 'file',
          executable: false,
          contentBase64: header.toString('base64'),
        },
        { path: 'empty', kind: 'directory' },
        {
          path: 'run.sh',
          kind: 'file',
          executable: true,
          contentBase64: Buffer.from('#!/bin/sh\necho authored\n').toString('base64'),
        },
        {
          path: 'references/data.bin',
          kind: 'file',
          executable: false,
          contentBase64: Buffer.from([0, 255, 1, 13, 10]).toString('base64'),
        },
      ],
      sourceCommit: null,
      sourceLocator: fixture.locator,
      sourceSubpath: 'repo/skills/plain',
    });
  });

  it('refuses ambiguous TAR supply without an explicit subpath or matching name', async () => {
    const bytes = await tar([
      { header: { name: 'repo/skills/.curated/category/group/one/SKILL.md' }, body: header },
      { header: { name: 'repo/skills/two/SKILL.md' }, body: header },
    ]);
    const fixture = await serve(bytes);
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url, sourceSubpath: 'absent' }));
    await refusal(
      acquireRemoteEcosystemSkill({ source: fixture.url, sourceSkillName: 'Plain Skill' })
    );
    await refusal(
      acquireRemoteEcosystemSkill({ source: fixture.url, sourceSkillName: 'Missing Skill' })
    );
  });

  it('selects one TAR package by subpath with Unicode paths from plain and gzip TAR', async () => {
    const bytes = await tar([
      { header: { name: 'repo/skills/.curated/category/group/one/SKILL.md' }, body: header },
      {
        header: { name: 'repo/skills/.curated/category/group/one/référence.txt' },
        body: Buffer.from('authored\r\n'),
      },
      { header: { name: 'repo/skills/.curated/category/group/one/empty/', type: 'directory' } },
      { header: { name: 'repo/skills/two/SKILL.md' }, body: header },
    ]);
    const plain = await serve(bytes);
    const selected = await acquireRemoteEcosystemSkill({
      source: plain.url,
      sourceSubpath: 'repo/skills/.curated/category/group/one',
    });
    expect(selected).toEqual({
      tree: [
        {
          path: 'SKILL.md',
          kind: 'file',
          executable: false,
          contentBase64: header.toString('base64'),
        },
        {
          path: 'référence.txt',
          kind: 'file',
          executable: false,
          contentBase64: Buffer.from('authored\r\n').toString('base64'),
        },
        { path: 'empty', kind: 'directory' },
      ],
      sourceCommit: null,
      sourceLocator: plain.locator,
      sourceSubpath: 'repo/skills/.curated/category/group/one',
    });
    const compressed = await serve(gzipSync(bytes));
    const selectedGzip = await acquireRemoteEcosystemSkill({
      source: compressed.url,
      sourceSubpath: 'repo/skills/.curated/category/group/one',
    });
    expect(selectedGzip).toEqual({ ...selected, sourceLocator: compressed.locator });
  });

  it('selects one TAR package by sourceSkillName and refuses an unmatched name', async () => {
    const one = Buffer.from('---\nname: One\ndescription: First package.\n---\nOne body.\n');
    const two = Buffer.from('---\nname: Two\ndescription: Second package.\n---\nTwo body.\n');
    const fixture = await serve(
      await tar([
        { header: { name: 'repo/skills/one/SKILL.md' }, body: one },
        { header: { name: 'repo/skills/one/notes.txt' }, body: Buffer.from('one\n') },
        { header: { name: 'repo/skills/two/SKILL.md' }, body: two },
        {
          header: { name: 'repo/skills/two/data.bin' },
          body: Buffer.from([0, 255, 1, 13, 10]),
        },
      ])
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url, sourceSkillName: 'Missing' }));
    const selected = await acquireRemoteEcosystemSkill({
      source: fixture.url,
      sourceSkillName: 'two',
    });
    expect(selected).toEqual({
      tree: [
        {
          path: 'SKILL.md',
          kind: 'file',
          executable: false,
          contentBase64: two.toString('base64'),
        },
        {
          path: 'data.bin',
          kind: 'file',
          executable: false,
          contentBase64: Buffer.from([0, 255, 1, 13, 10]).toString('base64'),
        },
      ],
      sourceCommit: null,
      sourceLocator: fixture.locator,
      sourceSubpath: 'repo/skills/two',
    });
  });

  it('refuses unsafe ZIP paths, malformed names and duplicate archive identities', async () => {
    const unsafe = await serve(unsafeZip);
    await refusal(acquireRemoteEcosystemSkill({ source: unsafe.url, sourceSubpath: 'skill' }));
    const malformedName = await serve(malformedNameZip);
    await refusal(
      acquireRemoteEcosystemSkill({ source: malformedName.url, sourceSubpath: 'skill' })
    );
    const duplicate = await serve(duplicateZip);
    await refusal(acquireRemoteEcosystemSkill({ source: duplicate.url }));
    const unsafeTar = await serve(
      await tar([
        { header: { name: 'skill/SKILL.md' }, body: header },
        { header: { name: '../outside' }, body: Buffer.from('Outside the selected package.') },
      ])
    );
    await refusal(acquireRemoteEcosystemSkill({ source: unsafeTar.url, sourceSubpath: 'skill' }));
  });

  it('refuses TAR link entries even outside the selected package', async () => {
    const fixture = await serve(
      await tar([
        { header: { name: 'skill/SKILL.md' }, body: header },
        { header: { name: 'outside', type: 'symlink', linkname: '/host/path' } },
      ])
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url, sourceSubpath: 'skill' }));
  });

  it('refuses a TAR file entry that carries link metadata', async () => {
    const fixture = await serve(
      await tar([
        { header: { name: 'skill/SKILL.md' }, body: header },
        { header: { name: 'skill/linked', type: 'file', linkname: '/host/path' } },
      ])
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url, sourceSubpath: 'skill' }));
  });

  it('refuses sparse TAR metadata rather than retaining packed extents as original bytes', async () => {
    const fixture = await serve(
      await tar([
        { header: { name: 'SKILL.md' }, body: header },
        {
          header: { name: 'sparse', pax: { 'GNU.sparse.realsize': '1024' } },
          body: Buffer.from('extent'),
        },
      ])
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
  });

  it('bounds actual streamed HTTP bytes despite a small compressed Content-Length', async () => {
    // This is a valid Skill below the selected-tree cap, so only the download cap refuses it.
    const encoded = gzipSync(
      Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 + 1 - header.length, 65)])
    );
    const fixture = await serve(encoded, {
      'content-encoding': 'gzip',
      'content-length': String(encoded.length),
    });
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
  });

  it('refuses archive expansion beyond the bounded inflated size', async () => {
    const fixture = await serve(
      gzipSync(
        await tar([
          { header: { name: 'skill/SKILL.md' }, body: header },
          { header: { name: 'outside' }, body: Buffer.alloc(25 * 1024 * 1024 + 1) },
        ])
      )
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url, sourceSubpath: 'skill' }));
  });

  it('refuses regular-file inventory beyond the bounded archive count', async () => {
    const fixture = await serve(
      gzipSync(
        await tar([
          { header: { name: 'SKILL.md' }, body: header },
          ...Array.from({ length: 1_000 }, (_, index) => ({ header: { name: `file-${index}` } })),
        ])
      )
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
  });

  it('refuses malformed content and corrupt ZIP declarations without exposing source content', async () => {
    const corrupted = Buffer.from(zip);
    const central = corrupted.indexOf(Buffer.from('504b0102', 'hex'));
    corrupted.writeUInt32LE(1, central + 24);
    const fixture = await serve(corrupted);
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
    const checksum = Buffer.from(zip);
    checksum.writeUInt32LE(0, central + 16);
    const corruptChecksum = await serve(checksum);
    await refusal(acquireRemoteEcosystemSkill({ source: corruptChecksum.url }));
    const invalid = await serve(Buffer.from('---\nname: missing-description\n---\nPrivate body.'));
    const error = await refusal(acquireRemoteEcosystemSkill({ source: invalid.url }));
    expect(error.message).not.toContain('Private body.');
  });

  it('applies the selected catalog tree bound after bounded archive acquisition', async () => {
    const fixture = await serve(
      gzipSync(
        await tar([
          { header: { name: 'SKILL.md' }, body: header },
          { header: { name: 'support' }, body: Buffer.alloc(16 * 1024 * 1024) },
        ])
      )
    );
    await refusal(acquireRemoteEcosystemSkill({ source: fixture.url }));
  });
});
