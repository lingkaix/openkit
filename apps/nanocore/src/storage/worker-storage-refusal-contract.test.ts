import { expect, it } from 'vitest';
import { ControlWorkerStorageRefusalSchema } from './worker-storage-binding-codecs.js';

const refusalCodes = [
  'authorization_denied',
  'cross_workspace_forbidden',
  'independent_review_conflict',
  'layout_conflict',
  'not_found',
  'occupied',
  'purge_blocked',
  'revision_conflict',
  'storage_fenced',
] as const;

const refusal = (code: string) => ({
  operation: 'worker-storage-binding',
  code,
  message: 'Storage binding refused.',
  status: 409,
});

it.each(refusalCodes)('accepts the original refusal code %s', (code) => {
  expect(ControlWorkerStorageRefusalSchema.safeParse(refusal(code)).success).toBe(true);
});

it('accepts exactly the closed original refusal code vocabulary', () => {
  expect(ControlWorkerStorageRefusalSchema.shape.code.options).toEqual(refusalCodes);
});

it('refuses an unknown refusal code', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse(refusal('authorization_expired')).success
  ).toBe(false);
});

it('refuses a refusal for another operation', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse({
      ...refusal('not_found'),
      operation: 'worker-storage-release',
    }).success
  ).toBe(false);
});

it('refuses a refusal with another status', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse({ ...refusal('not_found'), status: 403 }).success
  ).toBe(false);
});

it('refuses an empty refusal message', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse({ ...refusal('not_found'), message: '' }).success
  ).toBe(false);
});

it('refuses an overlong refusal message', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse({
      ...refusal('not_found'),
      message: 'x'.repeat(257),
    }).success
  ).toBe(false);
});

it('refuses a refusal with an extra field', () => {
  expect(
    ControlWorkerStorageRefusalSchema.safeParse({
      ...refusal('not_found'),
      reason: 'Unexpected authority-bearing field.',
    }).success
  ).toBe(false);
});
