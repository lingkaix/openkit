// openkit-test-platform: posix
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocatePiSessionPath,
  digestPiSessionHandle,
  encodePiSessionHandle,
  PiSessionIdentityError,
  parsePiSessionHandle,
  provePiSessionHeader,
  requireAbsentPiSession,
} from './identity.ts';

let stateRoot: string;
const cwd = '/workspace';

beforeEach(async () => {
  stateRoot = join(await realpath(await mkdtemp(join(tmpdir(), 'pi-identity-'))), 'state');
  await mkdir(stateRoot);
});

async function sessionFile(name: string, header: unknown, rest = ''): Promise<string> {
  const path = join(stateRoot, 'sessions', name, 'session.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${typeof header === 'string' ? header : JSON.stringify(header)}\n${rest}`);
  return path;
}

describe('Pi session identity', () => {
  it('allocates a fresh absent path under the state root for each binding', async () => {
    const first = await allocatePiSessionPath(stateRoot);
    const second = await allocatePiSessionPath(stateRoot);
    expect(first).not.toBe(second);
    expect(first.startsWith(join(stateRoot, 'sessions', 'binding-'))).toBe(true);
    await expect(requireAbsentPiSession(stateRoot, first)).resolves.toBeUndefined();
  });

  it('proves the exact header id and cwd without reading the history', async () => {
    const path = await sessionFile(
      'a',
      { cwd, id: 'sess-1', type: 'session', version: 3 },
      'not json\n'
    );
    await expect(provePiSessionHeader(stateRoot, path, cwd, 'sess-1')).resolves.toEqual({
      cwd,
      path,
      sessionId: 'sess-1',
    });
  });

  it.each([
    ['a missing file', async () => join(stateRoot, 'sessions', 'missing', 'session.jsonl')],
    [
      'an empty file',
      async () =>
        sessionFile('empty', '').then(async (path) => {
          await writeFile(path, '');
          return path;
        }),
    ],
    ['a malformed header', async () => sessionFile('bad', '{not json')],
    [
      'a header without a line end',
      async () => {
        const path = await sessionFile('open', '');
        await writeFile(path, JSON.stringify({ cwd, id: 'sess-1', type: 'session' }));
        return path;
      },
    ],
    ['a wrong id', async () => sessionFile('id', { cwd, id: 'sess-2', type: 'session' })],
    [
      'a wrong cwd',
      async () => sessionFile('cwd', { cwd: '/other', id: 'sess-1', type: 'session' }),
    ],
    [
      'a non-session header',
      async () => sessionFile('type', { cwd, id: 'sess-1', type: 'message' }),
    ],
    [
      'a symlinked file',
      async () => {
        const target = await sessionFile('target', { cwd, id: 'sess-1', type: 'session' });
        const link = join(stateRoot, 'sessions', 'target', 'link.jsonl');
        await symlink(target, link);
        return link;
      },
    ],
    [
      'a symlinked ancestor',
      async () => {
        await sessionFile('real', { cwd, id: 'sess-1', type: 'session' });
        await symlink(join(stateRoot, 'sessions', 'real'), join(stateRoot, 'sessions', 'alias'));
        return join(stateRoot, 'sessions', 'alias', 'session.jsonl');
      },
    ],
  ])('rejects %s', async (_name, create) => {
    const path = await create();
    await expect(provePiSessionHeader(stateRoot, path, cwd, 'sess-1')).rejects.toBeInstanceOf(
      PiSessionIdentityError
    );
  });

  it('parses only a canonical handle whose path is a strict child of the root', () => {
    const handle = { cwd, path: join(stateRoot, 'sessions', 'a', 'session.jsonl'), sessionId: 's' };
    const encoded = encodePiSessionHandle(handle);
    expect(parsePiSessionHandle(encoded, stateRoot)).toEqual(handle);
    expect(digestPiSessionHandle(encoded)).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of [
      JSON.stringify({ path: handle.path, cwd, sessionId: 's' }),
      JSON.stringify({ ...handle, extra: true }),
      encodePiSessionHandle({ ...handle, path: '/etc/passwd' }),
      encodePiSessionHandle({ ...handle, path: stateRoot }),
      encodePiSessionHandle({ ...handle, path: `${stateRoot}/sessions/../../escape.jsonl` }),
      encodePiSessionHandle({ ...handle, sessionId: ' ' }),
      'not json',
    ]) {
      expect(() => parsePiSessionHandle(bad, stateRoot)).toThrow(PiSessionIdentityError);
    }
  });

  it('refuses an existing file where a new conversation must start', async () => {
    const path = await sessionFile('exists', { cwd, id: 'sess-1', type: 'session' });
    await expect(requireAbsentPiSession(stateRoot, path)).rejects.toBeInstanceOf(
      PiSessionIdentityError
    );
  });
});
