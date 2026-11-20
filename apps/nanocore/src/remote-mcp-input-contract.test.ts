import { expect, it } from 'vitest';
import { compactInputContract } from './remote-mcp-input-contract.js';

it('matches the CLI shallow contract for scalar constraints, alternatives and nested fields', () => {
  // Expected contract captured from skills/openkit-operations.mjs for this draft-7 schema.
  const schema = {
    anyOf: [
      {
        type: 'object',
        required: ['pick', 'nested', 'items'],
        additionalProperties: false,
        properties: {
          pick: {
            anyOf: [
              { type: 'integer', minimum: 1 },
              { type: 'string', const: 'all' },
            ],
          },
          nested: { type: 'object', required: ['flag'], properties: { flag: { type: 'boolean' } } },
          items: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } },
        },
      },
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' } },
      },
    ],
  };
  expect(compactInputContract(schema)).toEqual({
    anyOf: [
      {
        type: 'object',
        required: ['pick', 'nested', 'items'],
        additionalProperties: false,
        properties: {
          pick: {
            anyOf: [
              { type: 'integer', minimum: 1 },
              { type: 'string', const: 'all' },
            ],
          },
          nested: { type: 'object' },
          items: { type: 'array', minItems: 1 },
        },
      },
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' } },
      },
    ],
  });
});

it('does not discard a representable CLI contract above 2 KiB', () => {
  const properties = Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [`field${index}`, { type: 'string', minLength: 3 }])
  );
  const expected = { type: 'object', properties };
  expect(JSON.stringify(expected).length).toBeGreaterThan(2048);
  expect(compactInputContract(expected)).toEqual(expected);
});
