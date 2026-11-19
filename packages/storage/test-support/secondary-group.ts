import { chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Qualifies the fixture group on the test filesystem before declaring the case inventory. */
export function secondaryFixtureGroup(): string {
  const groups = process.getgroups?.().filter((group) => group !== process.getgid?.()) ?? [];
  if (groups.length > 0) {
    const root = mkdtempSync(join(tmpdir(), 'storage-secondary-group-'));
    try {
      const path = join(root, 'record');
      writeFileSync(path, '', { mode: 0o600 });
      const { uid, gid } = statSync(path);
      for (const group of groups) {
        if (group === gid) continue;
        try {
          chownSync(path, uid, group);
          if (statSync(path).gid === group) return String(group);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EPERM' && code !== 'ENOTSUP') throw error;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.warn(
    'Skipping the Storage secondary-group ownership case. The fixture has no usable secondary group.'
  );
  return 'unavailable';
}
