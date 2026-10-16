import { describe, expect, it } from 'vitest';
import {
  AgentEnvironmentVaultGrantSchema,
  AgentEnvironmentVaultReferenceSchema,
} from './agent-environment.js';
import { SkillCandidateRecordSchema } from './resource-catalog.js';

const uuid = '01890f3e-0000-7000-8000-000000000001';
describe('Core identities retained in configuration projections', () => {
  it.each([
    { kind: 'vault', schema: AgentEnvironmentVaultReferenceSchema.shape.id },
    { kind: 'grant', schema: AgentEnvironmentVaultGrantSchema.shape.id },
    { kind: 'vault', schema: AgentEnvironmentVaultGrantSchema.shape.vaultRefId },
    { kind: 'cand', schema: SkillCandidateRecordSchema.shape.id },
  ])('uses the shared independent $kind rule', ({ kind, schema }) => {
    expect(schema.safeParse(`${kind}_${uuid}`).success).toBe(true);
    for (const invalid of [
      `other_${uuid}`,
      `${kind}_old`,
      `${kind}_${uuid.replace('-7000-', '-5000-')}`,
      `${kind}_${uuid}\n`,
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
  });
});
