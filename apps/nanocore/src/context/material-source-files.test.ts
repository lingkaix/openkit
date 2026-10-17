import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import { prepareMaterialSourceInput } from './material-source-files.js';
import type { WorkerContextPackageMaterialSelectionInput } from './worker-context-package.js';

/** Captures an existing immutable revision without inventing a lifecycle for the projection. */
function fixture(content: string) {
  const selection: WorkerContextPackageMaterialSelectionInput = {
    materialId: testEntityId('mat', 'original-material'),
    revisionId: testEntityId('mrev', 'original-material-revision'),
    parentRevisionId: null,
    mediaType: 'text/markdown',
    contentDigest: sha256(Buffer.from(content)),
    content,
    inclusionReason: 'thread_binding',
    bindingMutationRequestId: 'selected-binding',
    sensitivity: 'internal',
  };
  let allowed = true;
  const input = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    selection,
    assertCurrent: () => {
      if (!allowed) throw new Error('Source access revoked.');
    },
  };
  return {
    selection,
    input,
    revoke: () => {
      allowed = false;
    },
  };
}

it('delivers one bounded excerpt while retaining and streaming every original byte', async () => {
  const content = '漢字の原本\n'.repeat(20_000);
  const state = fixture(content);
  const prepared = await prepareMaterialSourceInput(state.input);
  expect(prepared.source.source).toEqual({
    kind: 'material',
    reference: {
      scopeId: 'material/workspace/ws_00000000-0000-7000-8000-000000000001',
      objectId: state.selection.materialId,
    },
    revisionId: state.selection.revisionId,
  });
  const delivered = Buffer.from(prepared.source.deliveredBytes).toString('utf8');
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(2048);
  expect(delivered.split('\n').length - 1).toBeLessThanOrEqual(50);
  expect(content.startsWith(delivered)).toBe(true);
  expect(prepared.selection.content).toBe(content);
  expect(prepared.selection.contentDigest).toBe(state.selection.contentDigest);
  expect(prepared.selection.deliveredContent).toBe(delivered);
  expect(prepared.selection.projection).toEqual(prepared.source.projection);
  expect(prepared.source.projection).toMatchObject({
    kind: 'excerpt',
    originalSnapshotPath:
      `originals/materials/${state.selection.materialId}/${state.selection.revisionId}/payload`,
    deliveredDigest: sha256(Buffer.from(delivered)),
    representationDigest: sha256(Buffer.from(content)),
    truncated: true,
    availability: 'incomplete',
  });
  const chunks: Uint8Array[] = [];
  for await (const bytes of prepared.source.open(new AbortController().signal)) {
    expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
    chunks.push(bytes);
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
});

it.each([
  '',
  '\ufefforiginal\r\n',
])('retains exact small original text without normalization', async (content) => {
  const prepared = await prepareMaterialSourceInput(fixture(content).input);
  expect(Buffer.from(prepared.source.deliveredBytes)).toEqual(Buffer.from(content));
  expect(prepared.source.projection).toMatchObject({
    kind: 'body',
    availability: 'available',
    truncated: false,
  });
});

it('captures immutable selected metadata and does not expose its backing original to consumers', async () => {
  const state = fixture('original');
  const prepared = await prepareMaterialSourceInput(state.input);
  Object.assign(state.selection, {
    content: 'changed',
    contentDigest: sha256(Buffer.from('changed')),
  });
  const iterator = prepared.source.open(new AbortController().signal)[Symbol.asyncIterator]();
  const first = (await iterator.next()).value!;
  first.fill(0);
  await iterator.return(undefined);
  const chunks: Uint8Array[] = [];
  for await (const bytes of prepared.source.open(new AbortController().signal)) chunks.push(bytes);
  expect(Buffer.concat(chunks).toString()).toBe('original');
  expect(prepared.selection.content).toBe('original');
});

it('refuses revoked source authority and cancellation before supplying more bytes', async () => {
  const state = fixture('x'.repeat(200_000));
  const prepared = await prepareMaterialSourceInput(state.input);
  const control = new AbortController();
  const iterator = prepared.source.open(control.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value!.byteLength).toBe(65_536);
  control.abort();
  await expect(iterator.next()).rejects.toThrow();
  state.revoke();
  expect(() => prepared.source.assertUnchanged()).toThrow(/revoked/);
  await expect(
    prepared.source.open(new AbortController().signal)[Symbol.asyncIterator]().next()
  ).rejects.toThrow(/revoked/);
});

it.each([
  'digest',
  'restricted',
  'invalid_unicode',
  'resource_bound',
] as const)('refuses %s without a full-body fallback', async (kind) => {
  const state = fixture('original');
  const changes =
    kind === 'digest'
      ? { contentDigest: sha256(Buffer.from('other')) }
      : kind === 'restricted'
        ? { sensitivity: 'restricted' }
        : kind === 'invalid_unicode'
          ? { content: '\ud800', contentDigest: sha256(Buffer.from('\ud800')) }
          : { content: 'x'.repeat(16_777_217) };
  await expect(
    prepareMaterialSourceInput({
      ...state.input,
      selection: { ...state.selection, ...changes } as WorkerContextPackageMaterialSelectionInput,
    })
  ).rejects.toThrow();
});

/** An independent digest of exact fixture or observed bytes. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
