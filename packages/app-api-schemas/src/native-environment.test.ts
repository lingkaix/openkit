import { describe, expect, it } from 'vitest';
import {
  AgentNativeEnvironmentResponseSchema,
  UpdateAgentNativeEnvironmentRequestSchema,
} from './runtime-config.js';
import { WorkerEnvironmentImageInspectionSchema } from './worker-environment.js';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { imageDigest: digest, defaultsDigest: digest, values: { PUBLIC: '' } };
const request = {
  fileId: 'agents/a.agent.jsonc',
  expectedRevision: digest,
  imageDigest: digest,
  defaultsDigest: digest,
  environment: { PUBLIC: null },
};
const response = {
  agentId: 'agent',
  fileId: request.fileId,
  persistedRevision: digest,
  defaults: { PUBLIC: '' },
  overrides: { PUBLIC: null },
  managedNames: [],
  desired: identity,
  reload: { matchesDesired: true, snapshotVersion: 1 },
  applied: [
    {
      workspaceId: 'ws',
      threadId: 'thread',
      state: 'acknowledged',
      environment: identity,
      matchesDesired: true,
    },
  ],
  sharedAgentImpact: 'All later Turns using this Agent.',
};
const image = {
  digest,
  environmentDefaults: { defaultsDigest: digest, classification: 'unadmitted', names: ['PUBLIC'] },
  platform: { architecture: 'arm64', os: 'linux' },
  storageLayout: {
    family: null,
    version: null,
    uid: 1000,
    gid: 1000,
    workingDirectory: '/workspace',
    targets: [{ target: '/workspace' }],
  },
};
const cases = [
  ['request', UpdateAgentNativeEnvironmentRequestSchema, request, []],
  ['response', AgentNativeEnvironmentResponseSchema, response, []],
  ['desired', AgentNativeEnvironmentResponseSchema, response, ['desired']],
  ['reload', AgentNativeEnvironmentResponseSchema, response, ['reload']],
  ['applied', AgentNativeEnvironmentResponseSchema, response, ['applied', 0]],
  [
    'applied identity',
    AgentNativeEnvironmentResponseSchema,
    response,
    ['applied', 0, 'environment'],
  ],
  ['image', WorkerEnvironmentImageInspectionSchema, image, []],
  ['names only', WorkerEnvironmentImageInspectionSchema, image, ['environmentDefaults']],
  ['platform', WorkerEnvironmentImageInspectionSchema, image, ['platform']],
  ['layout', WorkerEnvironmentImageInspectionSchema, image, ['storageLayout']],
  ['target', WorkerEnvironmentImageInspectionSchema, image, ['storageLayout', 'targets', 0]],
] as const;

describe('native environment envelope readers', () => {
  it.each(cases)('strips inert additive metadata in %s', (_name, schema, value, path) => {
    const input = structuredClone(value);
    let envelope: unknown = input;
    for (const key of path) envelope = (envelope as Record<string, unknown>)[key];
    (envelope as Record<string, unknown>).note = { future: 'inert' };
    expect(schema.parse(input)).toEqual(schema.parse(value));
  });
  it.each(
    cases
  )('strips optional metadata names at their envelope in %s', (_name, schema, value, path) => {
    for (const key of [
      'requiredFeatures',
      'minCoreVersion',
      'command',
      'env',
      'runtimeEnvironment',
      'nativeEnvironment',
      'credentials',
      'credentialRef',
      'credentialDeclarations',
      'token',
      'process',
    ]) {
      const input = structuredClone(value);
      let envelope: unknown = input;
      for (const part of path) envelope = (envelope as Record<string, unknown>)[part];
      (envelope as Record<string, unknown>)[key] = { description: 'inert metadata' };
      if (
        (path[0] === 'desired' || path[2] === 'environment') &&
        ['requiredFeatures', 'minCoreVersion', 'env', 'runtimeEnvironment'].includes(key)
      ) {
        expect(schema.safeParse(input).success, key).toBe(false);
      } else {
        expect(schema.parse(input), key).toEqual(schema.parse(value));
      }
    }
  });
  it('keeps literal map names, values, counts, bytes and digest validation', () => {
    for (const environment of [
      { 'BAD-NAME': 'x' },
      { A: '\0' },
      { A: '\ud800' },
      { A: 1 },
      { A: 'x'.repeat(16377) },
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`A${i}`, ''])),
    ])
      expect(
        UpdateAgentNativeEnvironmentRequestSchema.safeParse({ ...request, environment }).success
      ).toBe(false);
    expect(
      UpdateAgentNativeEnvironmentRequestSchema.safeParse({ ...request, defaultsDigest: 'bad' })
        .success
    ).toBe(false);
    expect(
      WorkerEnvironmentImageInspectionSchema.safeParse({
        ...image,
        environmentDefaults: { ...image.environmentDefaults, names: ['BAD-NAME'] },
      }).success
    ).toBe(false);
    expect(
      WorkerEnvironmentImageInspectionSchema.safeParse({
        ...image,
        environmentDefaults: { ...image.environmentDefaults, names: Array(129).fill('A') },
      }).success
    ).toBe(false);
  });
});
