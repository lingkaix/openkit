import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRegisteredRequiredFeatures } from '@openkit/config-schema';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps literal writer families and required-feature declarations registered', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const layout = readFileSync(join(root, 'apps/nanocore/src/storage/fs-layout.ts'), 'utf8');
  const families = layout
    .split('DATA_ROOT_SUPPORTED_CANONICAL_RECORD_TYPES = new Set([')[1]!
    .split(']);')[0]!;
  const roots = [
    join(root, 'apps/nanocore/src'),
    ...readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, 'packages', entry.name, 'src'))
      .filter(existsSync),
  ];
  for (const directory of roots) {
    for (const name of readdirSync(directory, { recursive: true })) {
      if (!name.endsWith('.ts') || /\.(test|spec|d)\.ts$/.test(name)) continue;
      const path = join(directory, name);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      /** Checks static declarations, not schema literals or derived payloads. */
      function visit(node: ts.Node): void {
        if (ts.isPropertyAssignment(node)) {
          const key = node.name.getText(source);
          const value = node.initializer;
          if (key === 'requiredFeatures' && ts.isArrayLiteralExpression(value)) {
            const features = value.elements.filter(ts.isStringLiteral).map((item) => item.text);
            expect(() => assertRegisteredRequiredFeatures(features), path).not.toThrow();
          }
          if (key === 'recordType' && ts.isStringLiteral(value)) {
            const keys = node.parent.properties.map((property) => property.name?.getText(source));
            if (
              ['schemaVersion', 'ownerScope', 'lineage', 'requiredFeatures'].every((k) =>
                keys.includes(k)
              )
            ) {
              // Memory suppression is a full envelope, but its writer appends JSONL, not JSON.
              if (value.text !== 'memory-suppression') {
                expect(families, path).toContain(`'${value.text}'`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
});
