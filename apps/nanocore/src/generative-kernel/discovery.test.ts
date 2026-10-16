import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { createLightApp, getLightApp, listLightApps } from './commands.js';

/** Schema discovery preserves admitted meaning and leaves absent business evidence absent. */
describe('native Light App semantic discovery', () => {
  it('discovers exact namespaces, relationships and constraints without inventing freshness', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-discovery-'));
    try {
      const store = createDemoStore({ dataRoot });
      const schema: LightAppSchemaInput = {
        format: 'openkit.light-app',
        schemaVersion: 1,
        title: 'External identity map',
        purpose:
          'The membership platform and CRM own their customer facts. This Kernel owns only mappings and local notes. Source observation freshness is unknown unless supplied with a record.',
        collections: [
          {
            name: 'tenants',
            type: 'base',
            description: 'External system instances, not credentials.',
            indexes: [],
            fields: [
              {
                name: 'source_instance',
                type: 'text',
                required: true,
                namespace: 'crm.instance',
                description: 'The immutable external CRM instance discriminator.',
              },
            ],
          },
          {
            name: 'mappings',
            type: 'base',
            description: 'An explicitly observed link between two distinct external namespaces.',
            indexes: [{ fields: ['membership_id', 'crm_id'], unique: true }],
            fields: [
              {
                name: 'membership_id',
                type: 'text',
                required: true,
                namespace: 'membership.prod',
                description:
                  'Membership platform-owned customer ID; significant digits are preserved as text.',
              },
              {
                name: 'crm_id',
                type: 'text',
                required: true,
                namespace: 'crm.prod',
                description:
                  'CRM-owned customer ID. Equal bytes in another namespace are not the same identity.',
              },
              {
                name: 'tenant',
                type: 'relation',
                required: true,
                options: { collection: 'tenants' },
                description: 'CRM instance associated with this mapping.',
              },
              {
                name: 'note',
                type: 'text',
                required: false,
                description:
                  'Kernel-owned local note; external provenance and observation time were not supplied.',
              },
            ],
          },
        ],
      };
      const created = await createLightApp(
        {
          store,
          dataRoot,
          workspaceId: 'ws_demo',
          requestId: randomUUID(),
          actor: { kind: 'user', id: 'user_local' },
          inflightCommands: new WeakMap(),
        },
        schema
      );
      const index = listLightApps(dataRoot, 'ws_demo');
      expect(index.items).toEqual([
        expect.objectContaining({
          appId: created.appId,
          purpose: schema.purpose,
          schemaRevision: 1,
          schemaDigest: created.schemaDigest,
          lifecycle: 'active',
        }),
      ]);
      expect(index.items[0]).not.toHaveProperty('records');
      const exact = getLightApp(dataRoot, 'ws_demo', created.appId);
      expect(exact.schema).toEqual(created.schema);
      const tenants = exact.schema!.collections[0]!;
      const mappings = exact.schema!.collections[1]!;
      expect(mappings.fields.slice(0, 2).map((field) => field.namespace)).toEqual([
        'membership.prod',
        'crm.prod',
      ]);
      expect(mappings.fields[2]!.options).toEqual({ collection: tenants.id });
      expect(mappings.indexes[0]).toEqual({
        unique: true,
        fields: mappings.fields.slice(0, 2).map((field) => field.id),
      });
      expect(mappings.fields[3]).not.toHaveProperty('namespace');
      expect(mappings.fields[3]).not.toHaveProperty('unit');
      expect(exact.schema!.purpose).toContain('freshness is unknown');
      expect(exact.capabilities.filterOperators).toEqual(['=', '!=', '>', '>=', '<', '<=', '&&', '||']);
      expect(exact.capabilities.maxBatchEntries).toBe(50);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
