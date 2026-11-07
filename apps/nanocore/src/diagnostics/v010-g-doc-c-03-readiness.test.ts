// openkit-test-platform: posix
import { describe, expect, it } from 'vitest';

import { projectAgentCatalogEntry } from '../agents/catalog-projection.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDiagnosticsSnapshot } from './snapshot.js';

/**
 * DOC-C-03. Readiness is launchability (docs/specs/20260703-agent_manifest_aep_resolution.md
 * Readiness States; docs/core/agent-supply.md). An omitted readiness field is not proof.
 * The deciding setup owner already blocks a manifest that declares unenforceable resources.
 * Catalog health stays unknown (docs/core/agent-supply.md readiness summary).
 */
describe('DOC-C-03 diagnostics readiness', () => {
  it('reports launchability on the diagnostics snapshot and leaves catalog health unknown', () => {
    const unlaunchable = {
      ...createTestAgentSetup({
        agentId: 'agent_unlaunchable',
        displayName: 'Unlaunchable Agent',
      }).manifest,
      resources: { sessions: 1 },
    };
    const launchable = createTestAgentSetup({
      agentId: 'agent_launchable',
      displayName: 'Launchable Agent',
    }).manifest;

    expect(unlaunchable).not.toHaveProperty('readiness');
    expect(launchable).not.toHaveProperty('readiness');

    const snapshot = createDiagnosticsSnapshot({
      agentManifests: [unlaunchable, launchable],
      mode: 'local',
      providerRegistry: new ProviderRegistry([]),
    });

    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: 'agent_unlaunchable',
        readiness: 'blocked',
      }),
      expect.objectContaining({
        id: 'agent_launchable',
        readiness: 'unknown',
      }),
    ]);
    expect(snapshot.agents[0]?.reasons.join('\n')).toMatch(/resource/i);
    expect(snapshot.agents[0]?.readiness).not.toBe('ready');

    for (const manifest of [unlaunchable, launchable]) {
      expect(projectAgentCatalogEntry(manifest).health).toEqual({
        checkedAt: null,
        message: null,
        status: 'unknown',
      });
      expect(projectAgentCatalogEntry(manifest).id).toBe(manifest.id);
    }
  });
});
