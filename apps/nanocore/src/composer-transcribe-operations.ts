import { randomUUID } from 'node:crypto';
import type { COMPOSER_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { GatewayRouteLineageEntry } from '@openkit/protocol';
import { auditAuthenticationFromActor } from './auth/audit-attribution.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
  writeGatewayRouteLineage,
} from './capability/usage-ledger.js';
import {
  decodeTranscriptionAudio,
  postAudioTranscription,
  TranscriptionRequestError,
} from './llm/audio-transcription.js';
import {
  executeGatewayPlan,
  GatewayAttemptFailure,
  type GatewaySelection,
  planLogicalModel,
} from './llm/gateway-execution.js';
import {
  type ResolvedLogicalModelRoute,
  type ResolvedTranscriptionRoute,
  resolveTranscriptionRoute,
} from './llm/logical-models.js';
import type { PiAiFailureKind } from './llm/pi-ai-failure.js';
import { LOCAL_SPEECH_ATTEMPT_TIMEOUT_MS } from './local-ai/supervisor.js';
import { probeLocalSupply } from './local-ai/supply.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';

/** Admits one transcription through the existing Gateway credential and usage owners. */
export function createComposerOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'repositoryWorkspaceDb'
    | 'resolveGatewayProvider'
    | 'runtimeConfigManager'
    | 'providerCredentialConfigured'
    | 'providerSubscriptionAccountManager'
  >
): FamilyImplementations<typeof COMPOSER_OPERATION_DEFINITIONS> {
  return {
    'composer.transcribe': async (input, context) => {
      const audio = decodeTranscriptionAudio(input.audio);
      const actor = publicOperationActor(context);
      const snapshot = dependencies.runtimeConfigManager?.current();
      if (
        !snapshot ||
        !dependencies.repositoryWorkspaceDb ||
        !dependencies.resolveGatewayProvider
      ) {
        throw new OperationError('transcription_unavailable', 'Transcription is unavailable.', 503);
      }
      const resolveChain = () =>
        resolveTranscriptionRoute(
          dependencies.runtimeConfigManager?.current()?.gatewayConfig ?? snapshot.gatewayConfig,
          dependencies.runtimeConfigManager?.current()?.providerRegistry ??
            snapshot.providerRegistry,
          dependencies.providerSubscriptionAccountManager,
          dependencies.providerCredentialConfigured,
          false
        );
      const initial = requireTranscriptionChain(resolveChain());
      const workspaceDb = dependencies.repositoryWorkspaceDb(input.workspaceId);
      let callId: string | undefined;
      let settled = false;
      const callerSignal = context.signal ?? new AbortController().signal;
      try {
        const call = await startCapabilityCall({
          workspaceDb,
          workspaceId: input.workspaceId,
          authorityActor: context.actorRef,
          authentication: auditAuthenticationFromActor(actor),
          family: 'llm',
          operation: 'llm.audio_transcriptions',
          capabilityId: 'llm.audio_transcriptions',
          threadId: input.threadId ?? null,
          turnId: null,
          providerRef: initial.routes[0]?.providerProfileId ?? 'transcription',
          serviceRef: 'llm-gateway',
          redactionClass: 'metadata-only',
          summary: 'Audio transcription.',
          requestId: randomUUID(),
          sourceIds: [],
        });
        callId = call.id;
        const writeEntry = (entry: GatewayRouteLineageEntry) =>
          writeGatewayRouteLineage({
            workspaceDb,
            call,
            logicalModelId: 'transcription',
            entry,
          });
        const text = await executeGatewayPlan({
          autoFailover: initial.autoFailover,
          signal: callerSignal,
          selections: async () => {
            await context.recheckAdmission?.();
            assertSnapshot(snapshot, dependencies);
            const chain = requireTranscriptionChain(resolveChain());
            const selections = planLogicalModel(chain, [], () => true);
            for (const selection of selections) {
              if (selection.selected) continue;
              await writeEntry({
                kind: 'unavailable',
                routeMemberId: selection.route.id,
                providerProfileId: selection.route.providerProfileId,
                providerModel: selection.route.providerModel,
                selectionReason: selection.reason,
                failureKind: 'provider_unavailable',
                unavailableReason: selection.route.unavailableReason ?? selection.reason,
              });
            }
            return selections;
          },
          attempt: async (selection, execution) => {
            const member = selection.route;
            const provider = await dependencies.resolveGatewayProvider!(
              member.providerProfileId,
              member.providerModel,
              {
                actor: context.actorRef,
                consumerWorkspaceId: input.workspaceId,
                capabilityCallId: call.id,
              }
            );
            await context.recheckAdmission?.();
            assertSnapshot(snapshot, dependencies);
            const current = requireTranscriptionChain(resolveChain());
            const still = current.routes.find((route) => sameMember(route, member));
            if (!still?.available) {
              throw new OperationError(
                still?.unavailableReason ?? 'transcription_unavailable',
                'Transcription is unavailable.',
                still?.unavailableReason === 'gateway_disabled' ? 403 : 503
              );
            }
            const localSpeech = probeLocalSupply('sherpa-onnx-asr', member.providerModel);
            const speechDeadline =
              localSpeech.baseUrl !== null && localSpeech.baseUrl === provider.baseUrl
                ? AbortSignal.timeout(LOCAL_SPEECH_ATTEMPT_TIMEOUT_MS)
                : undefined;
            const signal = speechDeadline
              ? AbortSignal.any([callerSignal, speechDeadline])
              : callerSignal;
            const measurement = {
              category: 'llm' as const,
              modelId: member.providerModel,
              providerModel: member.providerModel,
              providerRef: member.providerProfileId,
              source: 'measured',
            };
            try {
              const result = await postAudioTranscription({
                provider,
                model: member.providerModel,
                audio,
                mimeType: input.mimeType,
                ...(input.language ? { language: input.language } : {}),
                signal,
                callerSignal,
              });
              const usageRecordIds = await recordUsage({
                workspaceDb,
                call,
                records: [
                  { ...measurement, unit: 'requests', quantity: 1 },
                  ...(result.seconds === undefined
                    ? []
                    : [{ ...measurement, unit: 'seconds' as const, quantity: result.seconds }]),
                ],
              });
              await writeEntry(attemptEntry(selection, execution, 'succeeded', usageRecordIds));
              return result.text;
            } catch (error) {
              if (error instanceof TranscriptionRequestError) {
                const usageRecordIds = error.received
                  ? await recordUsage({
                      workspaceDb,
                      call,
                      records: [
                        { ...measurement, unit: 'requests', quantity: 1 },
                        ...(error.seconds === undefined
                          ? []
                          : [
                              {
                                ...measurement,
                                unit: 'seconds' as const,
                                quantity: error.seconds,
                              },
                            ]),
                      ],
                    })
                  : [];
                await writeEntry(
                  attemptEntry(selection, execution, 'failed', usageRecordIds, error.failure.kind)
                );
              }
              throw error;
            }
          },
        });
        await finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
        settled = true;
        return { text };
      } catch (error) {
        if (callId && !settled) {
          const aborted =
            callerSignal.aborted === true ||
            (error instanceof TranscriptionRequestError && error.failure.kind === 'cancelled') ||
            (error instanceof GatewayAttemptFailure && error.failure.kind === 'cancelled');
          await finishCapabilityCall({
            workspaceDb,
            callId,
            status: aborted ? 'aborted' : 'failed',
            errorCode: operationCode(error),
          }).catch(() => undefined);
          settled = true;
        }
        if (error instanceof OperationError) throw error;
        if (
          (error instanceof GatewayAttemptFailure && error.failure.kind === 'cancelled') ||
          (error instanceof TranscriptionRequestError && error.failure.kind === 'cancelled')
        ) {
          throw new OperationError('transcription_aborted', 'Transcription was cancelled.', 400, {
            cause: error,
          });
        }
        throw new OperationError('transcription_failed', 'Transcription failed.', 502, {
          cause: error,
        });
      } finally {
        audio.fill(0);
        workspaceDb.sqlite.close();
      }
    },
  };
}

/** Stable public code for a failed call. Upstream bodies stay out of this value. */
function operationCode(error: unknown): string {
  return error instanceof OperationError ? error.code : 'transcription_failed';
}

/** Refuses a missing chain or a chain with no selectable member. */
function requireTranscriptionChain(
  route: ResolvedTranscriptionRoute
): Extract<ResolvedTranscriptionRoute, { configured: true }> {
  if (!route.configured) {
    throw new OperationError(
      'transcription_route_missing',
      'No transcription route is configured.',
      409
    );
  }
  const ready = route.routes.some(
    (member, index) => member.available && (route.autoFailover || index === 0)
  );
  if (!ready) {
    const reason = route.routes[0]?.unavailableReason ?? 'transcription_unavailable';
    throw new OperationError(
      reason,
      'Transcription route is unavailable.',
      reason === 'gateway_disabled' ? 403 : 409
    );
  }
  return route;
}

function assertSnapshot(
  snapshot: { version: number; contentHash: string },
  dependencies: Pick<OperationInvocationDependencies, 'runtimeConfigManager'>
): void {
  const current = dependencies.runtimeConfigManager?.current();
  if (
    !current ||
    current.version !== snapshot.version ||
    current.contentHash !== snapshot.contentHash
  ) {
    throw new OperationError('transcription_unavailable', 'Transcription is unavailable.', 503);
  }
}

function sameMember(left: ResolvedLogicalModelRoute, right: ResolvedLogicalModelRoute): boolean {
  return (
    left.id === right.id &&
    left.providerProfileId === right.providerProfileId &&
    left.providerModel === right.providerModel
  );
}

function attemptEntry(
  selection: GatewaySelection,
  execution: { attemptOrder: number; retryIndex: number },
  terminalResult: 'succeeded' | 'failed',
  usageRecordIds: readonly string[],
  failureKind?: PiAiFailureKind
): GatewayRouteLineageEntry {
  return {
    kind: 'attempt',
    routeMemberId: selection.route.id,
    providerProfileId: selection.route.providerProfileId,
    providerModel: selection.route.providerModel,
    selectionReason: selection.reason,
    attemptOrder: execution.attemptOrder,
    retryIndex: execution.retryIndex,
    outputBegan: terminalResult === 'succeeded',
    terminalResult,
    ...(usageRecordIds.length > 0 ? { usageRecordIds: [...usageRecordIds] } : {}),
    ...(failureKind ? { failureKind } : {}),
  };
}
