// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeAuthoredFileSync } from './local.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates disposable bytes without configuration or credential authority. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'storage-exact-file-removal-'));
  roots.push(root);
  return root;
}

// Core Storage owns byte effects. The configuration owner keeps current admission,
// source revisions, secret revocation and partial-effect reporting.
describe('exact file physical removal', () => {
  it('removes the selected file and preserves retained sibling bytes', () => {
    const root = fixture();
    const selected = join(root, 'selected');
    const retained = join(root, 'retained');
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    writeFileSync(selected, 'selected');
    writeFileSync(retained, bytes);

    expect(removeAuthoredFileSync(selected)).toBeUndefined();

    expect(existsSync(selected)).toBe(false);
    expect(readdirSync(root)).toEqual(['retained']);
    expect(readFileSync(retained)).toEqual(bytes);
  });

  it('reports an absent selected path instead of accepting a forced retry', () => {
    const root = fixture();

    expect(() => removeAuthoredFileSync(join(root, 'absent'))).toThrow();

    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a selected directory and preserves all of its bytes', () => {
    const root = fixture();
    const selected = join(root, 'directory');
    mkdirSync(selected);
    const bytes = Buffer.from([128, 0, 255]);
    writeFileSync(join(selected, 'retained'), bytes);

    expect(() => removeAuthoredFileSync(selected)).toThrow();

    expect(readdirSync(selected)).toEqual(['retained']);
    expect(readFileSync(join(selected, 'retained'))).toEqual(bytes);
  });
});
