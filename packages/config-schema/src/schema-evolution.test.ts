import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertRegisteredRequiredFeatures,
  listRequiredFeatureDefinitions,
  parseRecordEnvelope,
  rewriteRecordEnvelope,
} from './schema-evolution.js';

/**
 * Creates one valid envelope fixture for schema-evolution tests.
 *
 * @returns Record envelope fixture with one unknown optional field.
 */
function envelopeFixture(): unknown {
  return {
    schemaVersion: 1,
    recordType: 'workspace',
    id: 'ws_demo',
    ownerScope: 'workspace',
    lineage: {
      workspaceId: 'ws_demo',
      requestId: 'req_demo',
    },
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    contentDigest: 'sha256:demo',
    redactionLevel: 'product',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {
      storage: { note: 'optional' },
    },
    futureOptionalField: 'preserve me',
  };
}

describe('schema evolution record envelope', () => {
  it('accepts unknown optional fields while validating known envelope fields', () => {
    const parsed = parseRecordEnvelope(envelopeFixture());

    expect(parsed.futureOptionalField).toBe('preserve me');
    expect(parsed.lineage.workspaceId).toBe('ws_demo');
  });

  it('fails closed for unsupported required features', () => {
    expect(() =>
      parseRecordEnvelope(
        {
          ...envelopeFixture(),
          requiredFeatures: ['workspace.mount.fuse'],
        },
        { supportedFeatures: [] }
      )
    ).toThrow('Unsupported required feature: workspace.mount.fuse');
    expect(() =>
      parseRecordEnvelope({
        ...envelopeFixture(),
        requiredFeatures: ['workspace.mount.fuse'],
      })
    ).toThrow('Unsupported required feature: workspace.mount.fuse');
  });

  it('rejects writer-required features that are not in the registry', () => {
    expect(() => assertRegisteredRequiredFeatures(['workspace.mount.telepathy'])).toThrow(
      'Unregistered required feature: workspace.mount.telepathy'
    );
  });

  it('keeps the required-feature registry aligned with the accepted spec table', () => {
    const spec = readFileSync(
      new URL('../../../docs/specs/20260703-schema_evolution_record_envelope.md', import.meta.url),
      'utf8'
    );
    const table = spec.slice(spec.indexOf('| Feature |'), spec.indexOf('## Extension Namespaces'));
    const specFeatures = [...table.matchAll(/^\| `([^`]+)` \| (active|withdrawn) \| (.+) \|$/gm)]
      .map((match) => ({
        id: match[1],
        status: match[2],
        description: match[3],
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    expect(specFeatures).toEqual(listRequiredFeatureDefinitions());
  });

  it('preserves unknown optional fields during same-record rewrites', () => {
    const rewritten = rewriteRecordEnvelope(envelopeFixture(), {
      updatedAt: '2026-07-04T01:00:00.000Z',
      extensions: {
        storage: { note: 'updated' },
      },
    });

    expect(rewritten).toMatchObject({
      id: 'ws_demo',
      updatedAt: '2026-07-04T01:00:00.000Z',
      futureOptionalField: 'preserve me',
      extensions: {
        storage: { note: 'updated' },
      },
    });
  });
});
