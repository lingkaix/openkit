// openkit-test-platform: posix
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removePrivateTreeInventory } from './local.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Physical fixtures contain caller-selected private bytes, without domain records or authority. */
async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'storage-private-inventory-'));
  roots.push(parent);
  const root = join(parent, 'private');
  await mkdir(root);
  await writeFile(join(root, 'ready.json'), 'ready');
  return root;
}

// Characterizes the validated removal tail of filesystem-workspace-sync.ts.
// Storage owns physical cleanup; the caller retains validation and inventory selection.
describe('caller-selected private tree removal', () => {
  it('removes selected files and empty directories in dependency order', async () => {
    const root = await fixture();
    await mkdir(join(root, 'files', 'parent', 'child'), { recursive: true });
    await mkdir(join(root, 'files', 'empty'));
    await writeFile(join(root, 'files', 'parent', 'child', 'nested'), 'nested bytes');
    await writeFile(join(root, 'files', 'top'), 'top bytes');

    await removePrivateTreeInventory(
      root,
      true,
      ['top', 'parent/child/nested'],
      ['parent', 'empty', 'parent/child']
    );

    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a marker-only root without a files inventory', async () => {
    const root = await fixture();
    await removePrivateTreeInventory(root, false, [], []);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('accepts an absent root with filesPresent=%s', async (filesPresent) => {
    const root = await fixture();
    await rm(root, { recursive: true });
    await expect(
      removePrivateTreeInventory(root, filesPresent, ['missing'], ['missing/child', 'missing'])
    ).resolves.toBeUndefined();
  });

  it('accepts already absent selected files, directories and files root', async () => {
    const root = await fixture();
    await removePrivateTreeInventory(root, true, ['missing'], ['missing', 'missing/child']);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a directory selected as a file without recursively deleting its bytes', async () => {
    const root = await fixture();
    await mkdir(join(root, 'files', 'selected'), { recursive: true });
    const retained = join(root, 'files', 'selected', 'retained');
    await writeFile(retained, 'keep');

    await expect(removePrivateTreeInventory(root, true, ['selected'], [])).rejects.toThrow();
    expect(await readFile(retained, 'utf8')).toBe('keep');
    expect(await readFile(join(root, 'ready.json'), 'utf8')).toBe('ready');
  });

  it.each([
    'nested',
    'files-root',
  ])('refuses unselected residue at %s before marker removal', async (location) => {
    const root = await fixture();
    await mkdir(join(root, 'files', 'nested'), { recursive: true });
    const retained = join(root, 'files', ...(location === 'nested' ? ['nested'] : []), 'retained');
    await writeFile(retained, 'keep');

    await expect(removePrivateTreeInventory(root, true, [], ['nested'])).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    });
    expect(await readFile(retained, 'utf8')).toBe('keep');
    expect(await readFile(join(root, 'ready.json'), 'utf8')).toBe('ready');
  });

  it('does not remove an unselected files root and propagates final root refusal', async () => {
    const root = await fixture();
    await mkdir(join(root, 'files'));
    await expect(removePrivateTreeInventory(root, false, [], [])).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    });
    expect((await stat(join(root, 'files'))).isDirectory()).toBe(true);
    await expect(stat(join(root, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates a non-ENOENT directory error and keeps the marker', async () => {
    const root = await fixture();
    await mkdir(join(root, 'files'));
    const wrongKind = join(root, 'files', 'selected');
    await writeFile(wrongKind, 'keep');
    await expect(removePrivateTreeInventory(root, true, [], ['selected'])).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    expect(await readFile(wrongKind, 'utf8')).toBe('keep');
    expect(await readFile(join(root, 'ready.json'), 'utf8')).toBe('ready');
  });
});
