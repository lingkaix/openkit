import { randomUUID } from 'node:crypto';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { KernelCommandError } from '../generative-kernel/errors.js';
import { admitProducerMessages } from './admit.js';

const DIGEST = `sha256:${'ab'.repeat(32)}`;

function messages(components: unknown[]) {
  return [
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: 'surface',
        catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
        sendDataModel: false,
      },
    },
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateComponents: { surfaceId: 'surface', components },
    },
  ];
}

describe('native A2UI admission', () => {
  it('rejects unofficial Text.usageHint, List.alignment, and literalString bindings', () => {
    const source = {
      kind: 'item' as const,
      itemId: randomUUID(),
      contentDigest: DIGEST,
    };
    expect(() =>
      admitProducerMessages({
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'View',
        fallbackText: 'Fallback',
        messages: messages([
          { id: 'root', component: 'Column', children: ['body'] },
          { id: 'body', component: 'Text', text: 'Hello', usageHint: 'h1' },
        ]),
        source,
        actions: [],
      })
    ).toThrow(KernelCommandError);
    expect(() =>
      admitProducerMessages({
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'View',
        fallbackText: 'Fallback',
        messages: messages([
          { id: 'root', component: 'List', children: ['row'], alignment: 'start' },
          { id: 'row', component: 'Text', text: 'Hello' },
        ]),
        source,
        actions: [],
      })
    ).toThrow(KernelCommandError);
    expect(() =>
      admitProducerMessages({
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'View',
        fallbackText: 'Fallback',
        messages: messages([
          { id: 'root', component: 'Column', children: ['body'] },
          { id: 'body', component: 'Text', text: { literalString: 'Hello' } },
        ]),
        source,
        actions: [],
      })
    ).toThrow(KernelCommandError);
  });

  it('admits official path bindings and List.align', () => {
    const admitted = admitProducerMessages({
      threadId: 'th_demo',
      turnId: 'turn_demo',
      title: 'View',
      fallbackText: 'Fallback',
      messages: messages([
        { id: 'root', component: 'List', children: ['row'], align: 'stretch' },
        { id: 'row', component: 'Text', text: { path: '/text' } },
      ]),
      source: { kind: 'item', itemId: randomUUID(), contentDigest: DIGEST },
      actions: [],
    });
    expect(admitted.components.get('root')?.props.align).toBe('stretch');
  });
});
