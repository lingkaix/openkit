import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { requireShardResults, shardPlan } from '../scripts/ci-l0-l2.mjs';
import { testOwners, verifyExecutionInventory } from '../scripts/release-tests.mjs';

test('execution inventory refuses missing and repeated files or cases', () => {
  const expected = [{ file: '/example/subject.test.ts', name: 'suite > case' }];
  const result = {
    name: expected[0].file,
    assertionResults: [{ ancestorTitles: ['suite'], title: 'case' }],
  };
  assert.equal(verifyExecutionInventory(expected, { success: true, testResults: [result] }), 1);
  for (const testResults of [
    [],
    [result, result],
    [{ ...result, assertionResults: [] }],
    [{ ...result, assertionResults: [...result.assertionResults, ...result.assertionResults] }],
  ])
    assert.throws(() => verifyExecutionInventory(expected, { success: true, testResults }));
  assert.throws(() =>
    verifyExecutionInventory(expected, { success: false, testResults: [result] })
  );
});

test('every deterministic package belongs to exactly one complete-suite shard', () => {
  const owners = testOwners(process.cwd());
  const plan = shardPlan();
  assert.equal(new Set(plan.map((s) => s.id)).size, plan.length);
  assert.deepEqual(plan.flatMap((s) => s.owners).sort(), owners.map((o) => o.name).sort());
  assert.equal(plan.filter((s) => s.kind === 'root').length, 1);
  assert.equal(plan.filter((s) => s.kind === 'static').length, 1);
  for (const owner of owners.filter((o) => o.vitest)) {
    const matches = plan.filter((s) => s.owners.includes(owner.name));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].kind, 'coverage');
    assert.deepEqual(matches[0].owners, [owner.name]);
  }
});

test('aggregate refuses every missing, duplicate, failed, cancelled and skipped shard', () => {
  const names = shardPlan().map((s) => s.id);
  const results = names.map((id) => ({ id, conclusion: 'success' }));
  assert.doesNotThrow(() => requireShardResults(results, names));
  for (const name of names) {
    assert.throws(() =>
      requireShardResults(
        results.filter((r) => r.id !== name),
        names
      )
    );
    assert.throws(() =>
      requireShardResults([...results, results.find((r) => r.id === name)], names)
    );
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', undefined])
      assert.throws(() =>
        requireShardResults(
          results.map((r) => (r.id === name ? { ...r, conclusion } : r)),
          names
        )
      );
  }
});

test('workflow matrix derives its complete membership and aggregate fails closed', () => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(jobs['l0-l2-shards'].strategy['fail-fast'], false);
  assert.equal(
    jobs['l0-l2-shards'].strategy.matrix,
    '$' + '{{ fromJSON(needs.l0-l2-plan.outputs.matrix) }}'
  );
  assert.ok(jobs['l0-l2'].needs.includes('l0-l2-shards'));
  assert.match(jobs['l0-l2'].if, /always\(\)/);
  assert.ok(
    jobs['l0-l2'].steps.some(
      (s) =>
        /needs\.l0-l2-shards\.result/.test(s.env?.SHARDS_RESULT ?? '') &&
        /success/.test(s.run ?? '')
    )
  );
});
