import { randomUUID } from 'node:crypto';
import { ButtonApi, ListApi, TextApi, TextFieldApi } from '@a2ui/web_core/v0_9/basic_catalog';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { KernelCommandError } from '../generative-kernel/errors.js';
import {
  admitProducerMessages,
  assertExpandedSourceInstances,
  countExpandedInstances,
} from './admit.js';

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

  it('rejects declarations the official v0.9 component schemas reject', () => {
    const source = {
      kind: 'item' as const,
      itemId: randomUUID(),
      contentDigest: DIGEST,
    };
    const cases = [
      {
        name: 'Text boolean',
        official: TextApi.schema.safeParse({ text: true }).success,
        components: [
          { id: 'root', component: 'Column', children: ['body'] },
          { id: 'body', component: 'Text', text: true },
        ],
      },
      {
        name: 'invalid Text variant',
        official: TextApi.schema.safeParse({ text: 'Hello', variant: 'banana' }).success,
        components: [
          { id: 'root', component: 'Column', children: ['body'] },
          { id: 'body', component: 'Text', text: 'Hello', variant: 'banana' },
        ],
      },
      {
        name: 'TextField missing label',
        official: TextFieldApi.schema.safeParse({ value: 'hello' }).success,
        components: [
          { id: 'root', component: 'Column', children: ['note'] },
          { id: 'note', component: 'TextField', value: 'hello' },
        ],
      },
      {
        name: 'Button legacy text',
        official: ButtonApi.schema.safeParse({
          text: 'Save',
          action: { event: { name: 'save' } },
        }).success,
        components: [
          { id: 'root', component: 'Column', children: ['save'] },
          {
            id: 'save',
            component: 'Button',
            text: 'Save',
            action: { event: { name: 'save' } },
          },
        ],
      },
      {
        name: 'List missing template path',
        official: ListApi.schema.safeParse({ children: { componentId: 'row' } }).success,
        components: [
          { id: 'root', component: 'List', children: { componentId: 'row' } },
          { id: 'row', component: 'Text', text: 'Hello' },
        ],
      },
    ];
    for (const testCase of cases) {
      expect(testCase.official, testCase.name).toBe(false);
      expect(
        () =>
          admitProducerMessages({
            threadId: 'th_demo',
            turnId: 'turn_demo',
            title: 'View',
            fallbackText: 'Fallback',
            messages: messages(testCase.components),
            source,
            actions: [],
          }),
        testCase.name
      ).toThrow(KernelCommandError);
    }
  });

  it('counts List template copies against the expanded-instance ceiling', () => {
    const admitted = admitProducerMessages({
      threadId: 'th_demo',
      turnId: 'turn_demo',
      title: 'View',
      fallbackText: 'Fallback',
      messages: messages([
        { id: 'root', component: 'List', children: { componentId: 'row', path: '/records' } },
        { id: 'row', component: 'Column', children: ['body'] },
        { id: 'body', component: 'Text', text: { path: '/membership_id' } },
      ]),
      source: { kind: 'item', itemId: randomUUID(), contentDigest: DIGEST },
      actions: [],
    });
    const records = Array.from({ length: 50 }, (_, index) => ({ id: String(index) }));
    expect(countExpandedInstances(admitted.components, { records })).toBe(101);
    const relative = admitProducerMessages({
      threadId: 'th_demo',
      turnId: 'turn_demo',
      title: 'View',
      fallbackText: 'Fallback',
      messages: messages([
        { id: 'root', component: 'List', children: { componentId: 'row', path: 'records' } },
        { id: 'row', component: 'Column', children: ['body'] },
        { id: 'body', component: 'Text', text: { path: '/membership_id' } },
      ]),
      source: { kind: 'item', itemId: randomUUID(), contentDigest: DIGEST },
      actions: [],
    });
    expect(countExpandedInstances(relative.components, { records })).toBe(101);
    expect(() =>
      assertExpandedSourceInstances(admitted.components, {
        records: Array.from({ length: 250 }, (_, index) => ({ id: String(index) })),
      })
    ).toThrow(KernelCommandError);
    const nested = admitProducerMessages({
      threadId: 'th_demo',
      turnId: 'turn_demo',
      title: 'View',
      fallbackText: 'Fallback',
      messages: messages([
        { id: 'root', component: 'List', children: { componentId: 'n1', path: 'records' } },
        { id: 'n1', component: 'List', children: { componentId: 'n2', path: '/records' } },
        { id: 'n2', component: 'List', children: { componentId: 'leaf', path: '/records' } },
        { id: 'leaf', component: 'Text', text: 'Hello' },
      ]),
      source: { kind: 'item', itemId: randomUUID(), contentDigest: DIGEST },
      actions: [],
    });
    expect(() =>
      assertExpandedSourceInstances(nested.components, {
        records: Array.from({ length: 8 }, (_, index) => ({ id: String(index) })),
      })
    ).toThrow(KernelCommandError);
  });
});
