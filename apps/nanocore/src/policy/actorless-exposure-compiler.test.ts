import { expect, it } from 'vitest';
import * as workspaceAccess from './workspace-access.js';

it('compiles source-only exposure availability without inventing a requester, principal, process or allow association', () => {
  const compile = Reflect.get(workspaceAccess, 'compilePolicyGraph');
  expect(compile).toBeTypeOf('function');
  if (typeof compile !== 'function') throw new Error('The shared Policy compiler is unavailable.');
  const result = compile({
    exposure: {
      group: 'llm-gateway',
      document: { schemaVersion: 1, statements: [] },
    },
  });
  expect(result).toHaveProperty('policy');
  expect(result).not.toHaveProperty('request');
  expect(result).not.toHaveProperty('decision');
  expect(result).not.toHaveProperty('kernel');
  expect(
    result.policy.elements.filter(
      (element: { kind: string }) => element.kind === 'user' || element.kind === 'process'
    )
  ).toEqual([]);
  expect(Object.keys(result.policy.processUsers ?? {})).toEqual([]);
  expect(
    result.policy.assignments.filter(
      (assignment: { parent: string }) => assignment.parent === 'ua:current-subject'
    )
  ).toEqual([]);
  expect(result.policy.associations).toEqual([]);
});
