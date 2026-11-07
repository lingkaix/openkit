import type { GatewayConfig } from '@openkit/config-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { operationRequest } from '../test-support/operation-request.js';
import {
  bootInstallation,
  type LoopbackPeer,
  type OracleInstallation,
  type PeerDecision,
  refusedPeer,
  startPeer,
} from './p1-oracle-fixture.js';
import { LOCAL_SPEECH_MODEL_ID, LOCAL_SPEECH_PROFILE_ID } from './profiles.js';
import {
  attachLocalBackendLoopbackFixture,
  LOCAL_SPEECH_ATTEMPT_TIMEOUT_MS,
} from './supervisor.js';

const UPSTREAM = 'upstream-speech';
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('transcription chain evidence', () => {
  it('skips an unavailable primary with lineage and no usage, then serves local', async () => {
    const chain = await openChain(() => ({ status: 200, body: { text: 'should-not-run' } }), {
      autoFailover: true,
      primaryModel: 'not-a-listed-model',
    });
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'local words' });
    expect(chain.upstream.hits).toEqual([]);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]).toMatchObject({
      operation: 'llm.audio_transcriptions',
      family: 'llm',
      status: 'succeeded',
      owner: { kind: 'workspace', workspaceId: chain.installation.workspaceId },
      threadId: chain.installation.threadId,
    });
    expect(lineage(rows.calls[0])).toMatchObject({
      logicalModelId: 'transcription',
      entries: [
        expect.objectContaining({
          kind: 'unavailable',
          routeMemberId: 'primary',
          providerProfileId: UPSTREAM,
        }),
        expect.objectContaining({
          kind: 'attempt',
          routeMemberId: 'local',
          terminalResult: 'succeeded',
        }),
      ],
    });
    expect(usageFor(rows, UPSTREAM)).toEqual([]);
    expectMeasured(rows, LOCAL_SPEECH_PROFILE_ID, [
      { unit: 'requests', quantity: 1 },
      { unit: 'seconds', quantity: 0.4 },
    ]);
    expect(rows.usage.every((row) => row.capabilityCallId === rows.calls[0]?.id)).toBe(true);
  });

  it('advances a settled 401 and records measured usage for that received attempt', async () => {
    const chain = await openChain((index) =>
      index === 0
        ? { status: 401, body: { message: 'Unauthorized', duration: 1.5 } }
        : { status: 500, body: { message: 'unexpected' } }
    );
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'local words' });
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.status).toBe('succeeded');
    expectMeasured(rows, UPSTREAM, [
      { unit: 'requests', quantity: 1 },
      { unit: 'seconds', quantity: 1.5 },
    ]);
    expect(attemptKinds(rows.calls[0])).toEqual(['auth_rejected', undefined]);
  });

  it('keeps a generic 403 Forbidden terminal and does not advance', async () => {
    const chain = await openChain(() => ({ status: 403, body: { message: 'Forbidden' } }));
    const response = await transcribe(chain.installation);
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: 'transcription_failed' });
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toEqual([
      expect.objectContaining({ status: 'failed', operation: 'llm.audio_transcriptions' }),
    ]);
    expect(usageFor(rows, UPSTREAM)).toEqual([
      expect.objectContaining({ unit: 'requests', quantity: 1, source: 'measured' }),
    ]);
    expect(usageFor(rows, LOCAL_SPEECH_PROFILE_ID)).toEqual([]);
    expect(attemptKinds(rows.calls[0])).toEqual(['unknown']);
  });

  it('advances credential-rejection evidence that is not a generic Forbidden', async () => {
    const chain = await openChain(() => ({
      status: 403,
      body: { message: 'invalid_api_key' },
    }));
    const response = await transcribe(chain.installation);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(attemptKinds(rows.calls[0])).toEqual(['auth_rejected', undefined]);
  });

  it('retries a settled 429 on the same member and then advances', async () => {
    const chain = await openChain(() => ({
      status: 429,
      body: { message: 'rate_limited', duration: 0.2 },
      retryAfter: '0',
    }));
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(200);
    expect(chain.upstream.hits).toHaveLength(4);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(attemptKinds(rows.calls[0])).toEqual([
      'rate_limited',
      'rate_limited',
      'rate_limited',
      'rate_limited',
      undefined,
    ]);
    expectMeasured(rows, UPSTREAM, [
      { unit: 'requests', quantity: 1 },
      { unit: 'seconds', quantity: 0.2 },
    ]);
  });

  it('retries a settled 500 and then advances', async () => {
    const chain = await openChain(() => ({
      status: 500,
      body: { message: 'unavailable' },
      retryAfter: '0',
    }));
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(200);
    expect(chain.upstream.hits).toHaveLength(4);
    expect(chain.local.hits).toHaveLength(1);
    expect(chain.installation.ledger().calls).toHaveLength(1);
  });

  it('advances a proven pre-send connect refusal', async () => {
    const chain = await openChain(() => ({ status: 500, body: {} }), { closedUpstream: true });
    const response = await transcribe(chain.installation);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toEqual({ text: 'local words' });
    expect(chain.upstream.port).toBeGreaterThan(1023);
    expect(chain.upstream.hits).toEqual([]);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(usageFor(rows, UPSTREAM)).toEqual([]);
    expect(attemptEntries(rows.calls[0])).toEqual([
      ...[0, 1, 2, 3].map((retryIndex) =>
        expect.objectContaining({
          kind: 'attempt',
          routeMemberId: 'primary',
          providerProfileId: UPSTREAM,
          failureKind: 'provider_unavailable',
          terminalResult: 'failed',
          retryIndex,
        })
      ),
      expect.objectContaining({
        kind: 'attempt',
        routeMemberId: 'local',
        terminalResult: 'succeeded',
      }),
    ]);
    for (const entry of attemptEntries(rows.calls[0]).slice(0, 4)) {
      expect(entry).not.toHaveProperty('usageRecordIds');
    }
  });

  it('records a reset attempt in route lineage without measured usage', async () => {
    const chain = await openChain(() => 'reset');
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(502);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.upstream.hits[0]?.bytes).toBeGreaterThan(0);
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.status).toBe('failed');
    expect(rows.usage).toEqual([]);
    expect(attemptEntries(rows.calls[0])).toEqual([
      expect.objectContaining({
        kind: 'attempt',
        routeMemberId: 'primary',
        providerProfileId: UPSTREAM,
        failureKind: 'provider_unavailable',
        terminalResult: 'failed',
      }),
    ]);
    expect(attemptEntries(rows.calls[0])[0]).not.toHaveProperty('usageRecordIds');
  });

  it('records a cancelled attempt in route lineage without measured usage', async () => {
    const chain = await openChain(() => 'hold');
    const controller = new AbortController();
    const pending = transcribe(chain.installation, controller.signal);
    await chain.upstream.held;
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'transcription_aborted' });
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toEqual([
      expect.objectContaining({ status: 'aborted', operation: 'llm.audio_transcriptions' }),
    ]);
    expect(rows.usage).toEqual([]);
    expect(attemptEntries(rows.calls[0])).toEqual([
      expect.objectContaining({
        kind: 'attempt',
        routeMemberId: 'primary',
        providerProfileId: UPSTREAM,
        failureKind: 'cancelled',
        terminalResult: 'failed',
      }),
    ]);
    expect(attemptEntries(rows.calls[0])[0]).not.toHaveProperty('usageRecordIds');
  });

  it(
    'records a speech deadline timeout in route lineage without measured usage',
    async () => {
      const local = await startPeer((_index, url) =>
        url.includes('transcription') ? 'hold' : { status: 200, body: { ok: true } }
      );
      const installation = await bootInstallation({
        mode: 'server',
        gateway: {
          schemaVersion: 1,
          enabled: true,
          logicalModels: [],
          requiredFeatures: [],
          transcription: {
            routing: { autoFailover: false },
            routes: [
              {
                id: 'local',
                providerProfileId: LOCAL_SPEECH_PROFILE_ID,
                providerModel: LOCAL_SPEECH_MODEL_ID,
              },
            ],
          },
        },
      });
      attachLocalBackendLoopbackFixture({
        backendId: 'sherpa-onnx-asr',
        baseUrl: local.baseUrl,
        modelId: LOCAL_SPEECH_MODEL_ID,
      });
      await installation
        .supervisor()
        ?.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
      closers.push(async () => {
        await local.close();
        await installation.close();
      });
      const pending = transcribe(installation);
      await local.held;
      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: 'transcription_failed' });
      expect(local.hits.filter((hit) => hit.url.includes('transcription'))).toHaveLength(1);
      const rows = installation.ledger();
      expect(rows.calls).toHaveLength(1);
      expect(rows.calls[0]?.status).toBe('failed');
      expect(rows.usage).toEqual([]);
      expect(attemptEntries(rows.calls[0])).toEqual([
        expect.objectContaining({
          kind: 'attempt',
          routeMemberId: 'local',
          providerProfileId: LOCAL_SPEECH_PROFILE_ID,
          failureKind: 'provider_unavailable',
          terminalResult: 'failed',
        }),
      ]);
      expect(attemptEntries(rows.calls[0])[0]).not.toHaveProperty('usageRecordIds');
    },
    LOCAL_SPEECH_ATTEMPT_TIMEOUT_MS + 20_000
  );

  it('does not advance after a reset that follows a completed send', async () => {
    const chain = await openChain(() => 'reset');
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(502);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.upstream.hits[0]?.bytes).toBeGreaterThan(0);
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.status).toBe('failed');
    expect(usageFor(rows, UPSTREAM)).toEqual([]);
    expect(usageFor(rows, LOCAL_SPEECH_PROFILE_ID)).toEqual([]);
  });

  it('does not leave the primary when failover is disabled', async () => {
    const chain = await openChain(() => ({ status: 401, body: { message: 'Unauthorized' } }), {
      autoFailover: false,
    });
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(502);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toEqual([]);
    expect(chain.installation.ledger().calls).toHaveLength(1);
  });

  it('cancels the in-flight attempt and does not advance', async () => {
    const chain = await openChain(() => 'hold');
    const controller = new AbortController();
    const pending = transcribe(chain.installation, controller.signal);
    await chain.upstream.held;
    controller.abort();
    const response = await pending;
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ code: 'transcription_aborted' });
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toEqual([
      expect.objectContaining({ status: 'aborted', operation: 'llm.audio_transcriptions' }),
    ]);
    expect(usageFor(rows, LOCAL_SPEECH_PROFILE_ID)).toEqual([]);
  });

  it('exhausts both members on the same call', async () => {
    const chain = await openChain(() => ({ status: 401, body: { message: 'Unauthorized' } }), {
      localDecision: { status: 401, body: { message: 'invalid_api_key', duration: 0.3 } },
    });
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(502);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toHaveLength(1);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.status).toBe('failed');
    expectMeasured(rows, UPSTREAM, [{ unit: 'requests', quantity: 1 }]);
    expectMeasured(rows, LOCAL_SPEECH_PROFILE_ID, [
      { unit: 'requests', quantity: 1 },
      { unit: 'seconds', quantity: 0.3 },
    ]);
  });

  it('records a malformed 200 and does not advance', async () => {
    const chain = await openChain(() => ({ status: 200, body: { unexpected: true } }));
    const response = await transcribe(chain.installation);
    expect(response.status).toBe(502);
    expect(chain.upstream.hits).toHaveLength(1);
    expect(chain.local.hits).toEqual([]);
    const rows = chain.installation.ledger();
    expect(rows.calls).toHaveLength(1);
    expect(usageFor(rows, UPSTREAM)).toEqual([
      expect.objectContaining({ unit: 'requests', quantity: 1, source: 'measured' }),
    ]);
    expect(usageFor(rows, UPSTREAM).some((row) => row.unit === 'seconds')).toBe(false);
  });
});

async function openChain(
  upstreamDecision: (index: number) => PeerDecision,
  options: {
    readonly autoFailover?: boolean;
    readonly primaryModel?: string;
    readonly closedUpstream?: boolean;
    readonly localDecision?: PeerDecision;
  } = {}
): Promise<{ installation: OracleInstallation; upstream: LoopbackPeer; local: LoopbackPeer }> {
  const upstream = options.closedUpstream ? await refusedPeer() : await startPeer(upstreamDecision);
  const local = await startPeer(
    () => options.localDecision ?? { status: 200, body: { text: 'local words', duration: 0.4 } }
  );
  const installation = await bootInstallation({
    mode: 'server',
    gateway: chainGateway(options.autoFailover !== false, upstream.baseUrl, options.primaryModel),
    providers: [upstreamProfile(upstream.baseUrl)],
  });
  attachLocalBackendLoopbackFixture({
    backendId: 'sherpa-onnx-asr',
    baseUrl: local.baseUrl,
    modelId: LOCAL_SPEECH_MODEL_ID,
  });
  await installation.supervisor()?.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
  closers.push(async () => {
    await upstream.close();
    await local.close();
    await installation.close();
  });
  return { installation, upstream, local };
}

function chainGateway(
  autoFailover: boolean,
  _baseUrl: string,
  primaryModel = 'whisper-1'
): GatewayConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    logicalModels: [],
    requiredFeatures: [],
    transcription: {
      routing: { autoFailover },
      routes: [
        { id: 'primary', providerProfileId: UPSTREAM, providerModel: primaryModel },
        {
          id: 'local',
          providerProfileId: LOCAL_SPEECH_PROFILE_ID,
          providerModel: LOCAL_SPEECH_MODEL_ID,
        },
      ],
    },
  };
}

function upstreamProfile(baseUrl: string): { name: string; profile: unknown } {
  return {
    name: 'upstream-speech.provider.jsonc',
    profile: {
      schemaVersion: 1,
      id: UPSTREAM,
      displayName: 'Upstream speech',
      kind: 'custom',
      baseUrl,
      models: ['whisper-1'],
      modelMetadata: { 'whisper-1': { limit: { context: 8192 } } },
      secretRef: 'env:OPENKIT_FIXTURE_SPEECH',
    },
  };
}

function transcribe(installation: OracleInstallation, signal?: AbortSignal): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'composer.transcribe',
      {
        workspaceId: installation.workspaceId,
        threadId: installation.threadId,
        audio: Buffer.from('clip').toString('base64'),
        mimeType: 'audio/webm',
      },
      { headers: { authorization: installation.ownerAuthorization }, signal }
    )
  );
}

function attemptEntries(
  call:
    | {
        extensions?: {
          'openkit.gateway/routeLineage'?: { entries?: readonly unknown[] };
        };
      }
    | undefined
): readonly unknown[] {
  return call?.extensions?.['openkit.gateway/routeLineage']?.entries ?? [];
}

function lineage(
  call: { extensions?: { 'openkit.gateway/routeLineage'?: unknown } } | undefined
): unknown {
  return call?.extensions?.['openkit.gateway/routeLineage'];
}

function attemptKinds(
  call:
    | {
        extensions?: {
          'openkit.gateway/routeLineage'?: {
            entries: Array<{ kind: string; failureKind?: string }>;
          };
        };
      }
    | undefined
): Array<string | undefined> {
  return (call?.extensions?.['openkit.gateway/routeLineage']?.entries ?? []).map((entry) =>
    entry.kind === 'attempt' ? entry.failureKind : entry.kind
  );
}

function expectMeasured(
  rows: ReturnType<OracleInstallation['ledger']>,
  providerRef: string,
  expected: readonly { readonly unit: string; readonly quantity: number }[]
): void {
  const actual = usageFor(rows, providerRef)
    .map((row) => ({ unit: row.unit, quantity: row.quantity, source: row.source }))
    .sort((left, right) => left.unit.localeCompare(right.unit) || left.quantity - right.quantity);
  const want = expected
    .map((row) => ({ ...row, source: 'measured' }))
    .sort((left, right) => left.unit.localeCompare(right.unit) || left.quantity - right.quantity);
  expect(actual).toEqual(want);
}

function usageFor(
  rows: ReturnType<OracleInstallation['ledger']>,
  providerRef: string
): ReturnType<OracleInstallation['ledger']>['usage'] {
  return rows.usage.filter((row) => row.providerRef === providerRef);
}
