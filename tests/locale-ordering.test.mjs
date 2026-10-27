import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedLocaleComparisons } from '../scripts/validate-locale-ordering.mjs';

const path = 'apps/nanocore/src/new-projection.ts';

test('locale ordering guard refuses direct and literal bracket calls', () => {
  const failures = unexpectedLocaleComparisons(
    path,
    `
    names.sort((a, b) => a.localeCompare(b));
    names.sort((a, b) => a['localeCompare'](b));
    names.sort((a, b) => a[\`localeCompare\`](b));
  `
  );
  assert.equal(failures.length, 3);
  assert.ok(failures.every((failure) => failure.includes('use compareCodeUnits')));
});

test('locale ordering guard ignores inert text and shared comparator calls', () => {
  assert.deepEqual(
    unexpectedLocaleComparisons(
      path,
      `
    // a.localeCompare(b)
    const example = 'a.localeCompare(b)';
    names.sort(compareCodeUnits);
  `
    ),
    []
  );
});

test('deferred expressions do not permit a new caller in the same owner', () => {
  assert.equal(
    unexpectedLocaleComparisons(
      'apps/nanocore/src/context/worker-context-package.ts',
      'newField.localeCompare(otherNewField)'
    ).length,
    1
  );
});

test('a named END exception has only its original path and multiplicity', () => {
  const retainedPath = 'apps/nanocore/src/runtime/nanohost-effect-identity.ts';
  const original = 'left.localeCompare(right);';
  assert.deepEqual(unexpectedLocaleComparisons(retainedPath, original), []);
  assert.equal(unexpectedLocaleComparisons(retainedPath, original.repeat(2)).length, 1);
  assert.equal(unexpectedLocaleComparisons(path, original).length, 1);
});
