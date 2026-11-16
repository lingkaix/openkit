import { expect, it } from 'vitest';
import { decode } from './control-store-product-records.js';
import {
  StoredEventPayloadV1Schema,
  StoredThreadSnapshotV1Schema,
} from './retained-work-events-v1.js';
import { parseWorkObservationRecord } from './work-observations.js';
import { parsePortableWorkObservations } from './workspace-export.js';
import { parseCanonicalWorkspaceHistory } from './workspace-file-records.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const timestamp = '2026-11-16T00:00:00.000Z';
const owner = { kind: 'workspace' as const, workspaceId };
const thread = {
  id: threadId,
  owner,
  name: 'History',
  preview: 'History',
  status: 'active',
  entryPath: 'conversation',
  visibility: 'workspace',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const segmentation = { maxObservationLines: 10_000, maxBytes: 100_000_000, boundaryDelayed: true };
const workspace = {
  id: workspaceId,
  name: 'History',
  kind: 'code',
  status: 'active',
  counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: timestamp,
  updatedAt: timestamp,
};

/** Exercise the canonical record graph that the portable writer and restore reader share. */
function portableThread(record: unknown) {
  return parseCanonicalWorkspaceHistory({
    workspace,
    threads: [record],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  }).threads[0];
}

it('retains segmentation in native snapshots, events and portable history while preserving absence', () => {
  for (const fields of [
    {},
    { segment: 0 },
    { segmentation },
    {
      parentThreadId: 'th_00000000-0000-7000-8000-000000000002',
      segment: 1,
      segmentation,
    },
  ]) {
    const record = { ...thread, ...fields };
    expect(StoredThreadSnapshotV1Schema.parse(record)).toEqual(record);
    expect(decode('thread', { schemaVersion: 1, ...record }, owner)).toEqual(record);
    expect(portableThread(record)).toEqual(record);
    for (const type of ['thread-created', 'thread-updated']) {
      const event = {
        protocolVersion: '0.7.0',
        event: type === 'thread-created' ? 'thread.created' : 'thread.updated',
        sequence: 1,
        requestId: null,
        timestamp,
        workspaceId,
        threadId,
        data: { type, thread: record },
      };
      const parsed = StoredEventPayloadV1Schema.parse(event);
      expect(parsed).toEqual(event);
      const canonical = JSON.stringify(parsed);
      expect(JSON.stringify(StoredEventPayloadV1Schema.parse(JSON.parse(canonical)))).toBe(
        canonical
      );
    }
  }
});

it.each([
  { segment: -1 },
  { segment: 0.5 },
  { segment: '1' },
  { segment: null },
  { segmentation: null },
  { segmentation: { ...segmentation, maxObservationLines: 0 } },
  { segmentation: { ...segmentation, maxBytes: 1.5 } },
  { segmentation: { ...segmentation, boundaryDelayed: false } },
  { segmentation: { maxObservationLines: 10_000, maxBytes: 100_000_000 } },
])('refuses malformed segmentation in native and portable readers: %j', (fields) => {
  const record = { ...thread, ...fields };
  expect(() => decode('thread', { schemaVersion: 1, ...record }, owner)).toThrow();
  expect(() => portableThread(record)).toThrow();
  expect(() =>
    StoredEventPayloadV1Schema.parse({
      protocolVersion: '0.7.0',
      event: 'thread.created',
      sequence: 1,
      requestId: null,
      timestamp,
      workspaceId,
      threadId,
      data: { type: 'thread-created', thread: record },
    })
  ).toThrow();
});

const configuredModel = {
  v: 1,
  id: 'configured-model',
  type: 'config.model',
  ts: timestamp,
  obs: 'llm-gateway',
  seq: 1,
  turnId,
  payload: { attempt: 0, providerRef: 'provider-one', model: 'physical-model', sampling: {} },
};

it('round-trips configured physical identity and exact optional sampling through retained and export readers', () => {
  for (const fields of [
    {},
    {
      cause: 'mixed/custom-cause',
      sampling: { temperature: 0, topP: null, maxOutputTokens: 1024, reasoningEffort: 'high' },
    },
  ]) {
    const record = { ...configuredModel, payload: { ...configuredModel.payload, ...fields } };
    expect(parseWorkObservationRecord(record)).toEqual(record);
    const canonical = `${JSON.stringify(parseWorkObservationRecord(record))}\n`;
    expect(parsePortableWorkObservations(canonical, turnId)).toEqual([record]);
    expect(`${JSON.stringify(parsePortableWorkObservations(canonical, turnId)[0])}\n`).toBe(
      canonical
    );
  }
  const historical = {
    ...configuredModel,
    type: 'env.bound',
    obs: 'nanocore',
    payload: {
      version: 'historical-build',
      workspaceId,
      systemPromptDigest: `sha256:${'1'.repeat(64)}`,
      tools: [],
    },
  };
  expect(parseWorkObservationRecord(historical)).toEqual(historical);
  expect(parsePortableWorkObservations(`${JSON.stringify(historical)}\n`, turnId)).toEqual([
    historical,
  ]);
});

it.each([
  { attempt: -1 },
  { providerRef: 1 },
  { model: '' },
  { sampling: null },
  { sampling: { temperature: '1' } },
  { sampling: { maxOutputTokens: 0.5 } },
  { cause: [] },
])('refuses malformed configured model payload: %j', (fields) => {
  const record = { ...configuredModel, payload: { ...configuredModel.payload, ...fields } };
  expect(() => parseWorkObservationRecord(record)).toThrow();
  expect(() => parsePortableWorkObservations(`${JSON.stringify(record)}\n`, turnId)).toThrow();
});

it('refuses a configured-model observation attributed to a different observer', () => {
  expect(() => parseWorkObservationRecord({ ...configuredModel, obs: 'nanocore' })).toThrow();
});
