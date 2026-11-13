import { workerSessionInputPaths, workerTurnCapturePaths } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import {
  AgentEnvironmentCredentialDeclarationSchema,
  AgentEnvironmentCredentialRequirementSchema,
  AgentEnvironmentPackageSchema,
} from './index.js';

// Authority: coord-ruling-20261113-overlap-shape.md and the accepted on-demand channel owner.
// These are schema inputs, not admitted Core records, authenticated contexts or effect receipts.
const GRANT = 'grant_00000000-0000-7d98-b1e4-8d2f442e5137';
const REFERENCE = 'vault_00000000-0000-7d14-9747-33948cb59d1e';
const SESSION = 'as_00000000-0000-7860-9e37-d1a60b30c856';
const THREAD = 'th_00000000-0000-7000-8000-000000000001';
const TURN = 'tu_00000000-0000-77e3-bfde-66477d556f64';
const V1 = 'client.authentication.k8s.io/v1';
const BETA = 'client.authentication.k8s.io/v1beta1';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';
const SAML = 'urn:ietf:params:oauth:token-type:saml2';
const targets = [
  { protocol: 'git', scheme: 'https', host: 'opaque-target', path: 'scope' },
  { protocol: 'docker', serverUrl: 'registry-key' },
  { protocol: 'aws' },
  { protocol: 'kubernetes', apiVersion: V1 },
  { protocol: 'google', audience: 'synthetic-audience', subjectTokenType: ID_TOKEN },
] as const;

/** Build a resolved declaration shape without asserting any actual grant authority. */
function declaration(helper: unknown) {
  return {
    id: 'native-helper',
    requirementId: 'native-helper',
    vaultGrantId: GRANT,
    visibility: 'runtime-token',
    consumer: 'credential-helper',
    helper,
  };
}

/** Build the corresponding reusable authored requirement without a concrete grant. */
function requirement(helper: unknown) {
  return {
    id: 'native-helper',
    requirementId: 'native-helper',
    purpose: 'Use an admitted native credential protocol',
    visibility: 'runtime-token',
    consumer: 'credential-helper',
    helper,
  };
}

/** Build a small Gateway AEP shape; all filesystem values come from existing path owners. */
function gatewayPackage(declarations: unknown[] = []) {
  const inputs = workerSessionInputPaths(SESSION);
  const capture = workerTurnCapturePaths(THREAD, 'codex', TURN);
  return {
    schemaVersion: 4,
    packageId: 'synthetic-package',
    snapshotId: 'synthetic-snapshot',
    createdAt: '2099-01-02T03:04:05.000Z',
    scope: {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: THREAD,
      turnId: TURN,
      agentSessionId: SESSION,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
    },
    agent: {
      agentId: 'synthetic-agent',
      profileId: null,
      displayName: 'Synthetic schema fixture',
      runtimeKind: 'codex',
      runtimeVersion: 'synthetic-version',
    },
    runtime: {
      image: { kind: 'reference', ref: 'synthetic-image', pullPolicy: 'if-not-present' },
      binaries: [{ id: 'schema-only-binary', path: inputs.packagePath }],
      command: { argv: ['openkit-worker-shim'], workingDirectory: inputs.root },
    },
    workspace: { root: inputs.root },
    supply: {},
    control: {
      protocol: 'openkit-worker-control-v1',
      mode: 'sandbox-integration',
      bindings: {
        capabilities: {
          pathPrefix: '/capabilities/',
          tokenRef: 'runtime://openkit/capability-token',
        },
        inference: { pathPrefix: '/inference/', tokenRef: 'runtime://openkit/inference-token' },
        workerControl: {
          pathPrefix: '/worker-control/',
          tokenRef: 'runtime://openkit/worker-control-token',
        },
      },
      transcript: {
        root: capture.root,
        eventsPath: capture.eventsPath,
        itemsPath: capture.itemsPath,
      },
      channels: { events: 'batch', artifacts: 'batch', heartbeats: true, logs: 'none' },
      adapter: { kind: 'openkit-worker-shim', targetRuntime: 'codex' },
    },
    credentials: { declarations },
    vault: {
      references: [{ id: REFERENCE, kind: 'grant-ref' }],
      grants: [{ id: GRANT, vaultRefId: REFERENCE, scope: 'workspace' }],
    },
    policy: { snapshotId: 'synthetic-policy' },
    llm: {
      mode: 'gateway',
      preferredLogicalModelId: 'synthetic-model',
      routes: [
        {
          id: 'synthetic-route',
          providerInstanceId: 'synthetic-provider',
          model: 'synthetic-model',
          endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
          credentialVisibility: 'placeholder',
        },
      ],
    },
    resources: {},
    observability: { captureCoverage: { scope: 'server', value: 'off' }, audit: {} },
    backend: { preferred: 'openshell', allowedKinds: ['openshell'], requiredCapabilities: [] },
  };
}

describe('admitted native process helper declaration and requirement shapes', () => {
  it.each(targets)('accepts the correlated $protocol target in both public schemas', (helper) => {
    expect(AgentEnvironmentCredentialDeclarationSchema.parse(declaration(helper))).toEqual(
      declaration(helper)
    );
    expect(AgentEnvironmentCredentialRequirementSchema.parse(requirement(helper))).toEqual({
      ...requirement(helper),
      required: true,
    });
  });

  it('permits absent Git path and preserves optional requirement behavior', () => {
    const helper = { protocol: 'git', scheme: 'https', host: 'opaque-target' };
    expect(AgentEnvironmentCredentialDeclarationSchema.safeParse(declaration(helper)).success).toBe(
      true
    );
    const input = { ...requirement(helper), required: false };
    expect(AgentEnvironmentCredentialRequirementSchema.parse(input)).toEqual(input);
  });

  it.each([V1, BETA])('accepts published Kubernetes response version %s', (apiVersion) => {
    const helper = { protocol: 'kubernetes', apiVersion };
    expect(AgentEnvironmentCredentialDeclarationSchema.safeParse(declaration(helper)).success).toBe(
      true
    );
    expect(AgentEnvironmentCredentialRequirementSchema.safeParse(requirement(helper)).success).toBe(
      true
    );
  });

  it.each([ID_TOKEN, JWT, SAML])(
    'accepts the exact Google subject-token type %s',
    (subjectTokenType) => {
      const helper = { protocol: 'google', audience: 'synthetic-audience', subjectTokenType };
      expect(
        AgentEnvironmentCredentialDeclarationSchema.safeParse(declaration(helper)).success
      ).toBe(true);
      expect(
        AgentEnvironmentCredentialRequirementSchema.safeParse(requirement(helper)).success
      ).toBe(true);
    }
  );

  it.each([
    undefined,
    null,
    {},
    { protocol: 'unknown' },
    { protocol: 'git', host: 'opaque-target' },
    { protocol: 'git', scheme: 'https' },
    { protocol: 'git', scheme: '', host: 'opaque-target' },
    { protocol: 'git', scheme: 'https', host: '' },
    { protocol: 'git', scheme: 'https', host: 'opaque-target', path: 7 },
    { protocol: 'docker' },
    { protocol: 'docker', serverUrl: '' },
    { protocol: 'docker', serverUrl: 7 },
    { protocol: 'aws', serverUrl: 'registry-key' },
    { protocol: 'kubernetes' },
    { protocol: 'kubernetes', apiVersion: 'v2' },
    { protocol: 'google', subjectTokenType: ID_TOKEN },
    { protocol: 'google', audience: '', subjectTokenType: ID_TOKEN },
    { protocol: 'google', audience: 'synthetic-audience' },
    { protocol: 'google', audience: 'synthetic-audience', subjectTokenType: 'unknown' },
  ])('rejects missing, malformed or cross-protocol target data: %#', (helper) => {
    expect(AgentEnvironmentCredentialDeclarationSchema.safeParse(declaration(helper)).success).toBe(
      false
    );
    expect(AgentEnvironmentCredentialRequirementSchema.safeParse(requirement(helper)).success).toBe(
      false
    );
  });

  it.each(targets)('rejects unknown authority-bearing fields in $protocol targets', (helper) => {
    const invalid = { ...helper, arbitraryAuthority: 'not-admitted' };
    expect(
      AgentEnvironmentCredentialDeclarationSchema.safeParse(declaration(invalid)).success
    ).toBe(false);
    expect(
      AgentEnvironmentCredentialRequirementSchema.safeParse(requirement(invalid)).success
    ).toBe(false);
  });

  it('does not permit a concrete grant in an authored reusable requirement', () => {
    expect(
      AgentEnvironmentCredentialRequirementSchema.safeParse({
        ...requirement(targets[2]),
        vaultGrantId: GRANT,
      }).success
    ).toBe(false);
  });

  it.each(['unknown', 'ssh-agent'])('refuses mismatched runtime-token consumer %s', (consumer) => {
    expect(
      AgentEnvironmentCredentialDeclarationSchema.safeParse({
        ...declaration(targets[2]),
        consumer,
      }).success
    ).toBe(false);
    expect(
      AgentEnvironmentCredentialRequirementSchema.safeParse({
        ...requirement(targets[2]),
        consumer,
      }).success
    ).toBe(false);
  });
});

describe('SSH external-handle and unchanged Codex Login shapes', () => {
  it('accepts the SSH consumer without adding helper or key-material fields', () => {
    const resolved = {
      id: 'ssh-agent',
      requirementId: 'ssh-agent',
      vaultGrantId: GRANT,
      visibility: 'external-handle',
      consumer: 'ssh-agent',
    };
    const authored = {
      id: 'ssh-agent',
      requirementId: 'ssh-agent',
      purpose: 'Use an admitted Core signer',
      visibility: 'external-handle',
      consumer: 'ssh-agent',
    };
    expect(AgentEnvironmentCredentialDeclarationSchema.parse(resolved)).toEqual(resolved);
    expect(AgentEnvironmentCredentialRequirementSchema.parse(authored)).toEqual({
      ...authored,
      required: true,
    });
  });

  it.each(['credential-helper', 'codex-login', 'unknown'])(
    'refuses unrelated external-handle consumer %s',
    (consumer) => {
      const input = {
        id: 'ssh-agent',
        requirementId: 'ssh-agent',
        vaultGrantId: GRANT,
        visibility: 'external-handle',
        consumer,
      };
      expect(AgentEnvironmentCredentialDeclarationSchema.safeParse(input).success).toBe(false);
    }
  );

  it('preserves the exact original Codex declaration and requirement arms', () => {
    const resolved = {
      id: 'codex-login',
      requirementId: 'codex-login',
      vaultGrantId: GRANT,
      visibility: 'runtime-token',
      consumer: 'codex-login',
    };
    const authored = {
      id: 'codex-login',
      requirementId: 'codex-login',
      purpose: 'Use admitted Codex Login',
      visibility: 'runtime-token',
      consumer: 'codex-login',
    };
    expect(AgentEnvironmentCredentialDeclarationSchema.parse(resolved)).toEqual(resolved);
    expect(AgentEnvironmentCredentialRequirementSchema.parse(authored)).toEqual({
      ...authored,
      required: true,
    });
    expect(
      AgentEnvironmentCredentialDeclarationSchema.safeParse({ ...resolved, helper: targets[2] })
        .success
    ).toBe(false);
    expect(
      AgentEnvironmentCredentialRequirementSchema.safeParse({ ...authored, helper: targets[2] })
        .success
    ).toBe(false);
  });
});

describe('Gateway AEP helper versus Codex inference separation', () => {
  it('starts from a valid existing Gateway package shape', () => {
    expect(AgentEnvironmentPackageSchema.safeParse(gatewayPackage()).success).toBe(true);
  });

  it.each(targets)(
    'allows $protocol helpers without switching Gateway inference to harness',
    (helper) => {
      const result = AgentEnvironmentPackageSchema.safeParse(gatewayPackage([declaration(helper)]));
      expect(result.success).toBe(true);
      if (!result.success) throw result.error;
      expect(result.data.llm.mode).toBe('gateway');
      expect(result.data.credentials.declarations).toEqual([declaration(helper)]);
    }
  );

  it('allows the Core-only SSH handle with Gateway inference', () => {
    const resolved = {
      id: 'ssh-agent',
      requirementId: 'ssh-agent',
      vaultGrantId: GRANT,
      visibility: 'external-handle',
      consumer: 'ssh-agent',
    };
    expect(AgentEnvironmentPackageSchema.safeParse(gatewayPackage([resolved])).success).toBe(true);
  });

  it('keeps Codex Login unavailable in Gateway inference', () => {
    const resolved = {
      id: 'codex-login',
      requirementId: 'codex-login',
      vaultGrantId: GRANT,
      visibility: 'runtime-token',
      consumer: 'codex-login',
    };
    const result = AgentEnvironmentPackageSchema.safeParse(gatewayPackage([resolved]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Codex Login must remain harness-only.');
    expect(
      result.error.issues.some((issue) => issue.path[0] === 'llm' && issue.path[1] === 'mode')
    ).toBe(true);
  });
});
