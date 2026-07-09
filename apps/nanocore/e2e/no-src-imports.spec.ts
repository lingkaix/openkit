import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const e2eRoot = new URL('.', import.meta.url);

/**
 * Lists TypeScript files under the e2e directory.
 */
function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) {
      return listTypeScriptFiles(path);
    }

    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('nanocore e2e import boundary', () => {
  it('does not import nanocore source internals', () => {
    const offenders = listTypeScriptFiles(e2eRoot.pathname).filter((path) => {
      const source = readFileSync(path, 'utf8');
      const importStatements = source
        .split('\n')
        .filter((line) => line.trim().startsWith('import '))
        .join('\n');

      return /\bfrom\s+['"][^'"]*(?:\.\.\/src\/|apps\/nanocore\/src\/)/.test(importStatements);
    });

    expect(offenders).toEqual([]);
  });
});
