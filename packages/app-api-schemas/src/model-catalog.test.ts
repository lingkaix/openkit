import { expect, it } from 'vitest';
import { RuntimeConfigFileWriteRequestSchema } from './runtime-config.js';

it('admits model catalog writes through the generic runtime config contract', () => {
  expect(
    RuntimeConfigFileWriteRequestSchema.safeParse({
      id: 'model-catalog.jsonc',
      kind: 'model-catalog',
      content: '{"schemaVersion":1,"providers":{}}',
    }).success
  ).toBe(true);
});
