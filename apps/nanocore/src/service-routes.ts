import { MetaResponseSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import type { Hono } from 'hono';

import type { AuthVariables } from './auth/middleware.js';
import type { CoreMode } from './config/mode.js';
import type { RuntimeCapabilities, TurnExecutor } from './runtime/types.js';

/**
 * Registers the Core metadata and public health routes.
 *
 * @param dependencies Hono app, deployment mode, and active turn runtime.
 */
export function registerServiceRoutes({
  app,
  mode,
  turnExecutor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly mode: CoreMode;
  readonly turnExecutor: TurnExecutor;
}): void {
  app.get('/api/meta', (c) => {
    if (mode === 'server') {
      return c.json(
        MetaResponseSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [],
          eventFamilies: [],
        })
      );
    }

    return c.json(
      MetaResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: mapRuntimeCapabilitiesToFlags(turnExecutor.capabilities),
        eventFamilies: [...turnExecutor.eventFamilies],
        itemTypes: [...(turnExecutor.itemTypes ?? [])],
        itemDeltaKinds: [...(turnExecutor.itemDeltaKinds ?? [])],
      })
    );
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'nanocore' }));
  app.get('/api/health', (c) => c.json({ status: 'ok', service: 'nanocore' }));
}

/**
 * Converts internal runtime booleans into protocol capability flags.
 *
 * @param caps Runtime capability switches.
 * @returns Stable protocol capability identifiers.
 */
export function mapRuntimeCapabilitiesToFlags(caps: RuntimeCapabilities): string[] {
  const flags: string[] = [];

  if (caps.approvals) {
    flags.push('core.approvals');
  }
  if (caps.interrupts) {
    flags.push('core.interrupt');
  }
  if (caps.artifacts) {
    flags.push('core.artifacts');
  }
  if (caps.workspaceKnowledgeEditing) {
    flags.push('core.knowledge.edit');
  }
  if (caps.questions) {
    flags.push('core.questions');
  }

  flags.push('core.agent_session.visible', 'core.stream.replay');

  return flags;
}
