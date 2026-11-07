import { randomUUID } from 'node:crypto';
import type { COMPOSER_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { auditAuthenticationFromActor } from './auth/audit-attribution.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { decodeTranscriptionAudio, postAudioTranscription } from './llm/audio-transcription.js';
import {
  type ResolvedTranscriptionRoute,
  resolveTranscriptionRoute,
} from './llm/logical-models.js';
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
      const route = requireTranscriptionRoute(
        resolveTranscriptionRoute(
          snapshot.gatewayConfig,
          snapshot.providerRegistry,
          dependencies.providerSubscriptionAccountManager,
          dependencies.providerCredentialConfigured,
          false
        )
      );
      const workspaceDb = dependencies.repositoryWorkspaceDb(input.workspaceId);
      let callId: string | undefined;
      let settled = false;
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
          providerRef: route.member.providerProfileId,
          serviceRef: 'llm-gateway',
          redactionClass: 'metadata-only',
          summary: 'Audio transcription.',
          requestId: randomUUID(),
          sourceIds: [],
        });
        callId = call.id;
        const provider = await dependencies.resolveGatewayProvider(
          route.member.providerProfileId,
          route.member.providerModel,
          {
            actor: context.actorRef,
            consumerWorkspaceId: input.workspaceId,
            capabilityCallId: call.id,
          }
        );
        // Credential resolution is awaited. Recheck authority and the admitted route
        // before dispatch, and refuse a changed selection instead of rerouting.
        await context.recheckAdmission?.();
        const current = dependencies.runtimeConfigManager?.current();
        if (
          !current ||
          current.version !== snapshot.version ||
          current.contentHash !== snapshot.contentHash
        ) {
          throw new OperationError(
            'transcription_unavailable',
            'Transcription is unavailable.',
            503
          );
        }
        const currentRoute = requireTranscriptionRoute(
          resolveTranscriptionRoute(
            current.gatewayConfig,
            current.providerRegistry,
            dependencies.providerSubscriptionAccountManager,
            dependencies.providerCredentialConfigured,
            false
          )
        );
        if (!sameTranscriptionSelection(route.member, currentRoute.member)) {
          throw new OperationError(
            'transcription_unavailable',
            'Transcription is unavailable.',
            503
          );
        }
        const result = await postAudioTranscription({
          provider,
          model: route.member.providerModel,
          audio,
          mimeType: input.mimeType,
          ...(input.language ? { language: input.language } : {}),
          signal: context.signal ?? new AbortController().signal,
        });
        const measurement = {
          category: 'llm' as const,
          modelId: route.member.providerModel,
          providerModel: route.member.providerModel,
          providerRef: route.member.providerProfileId,
          source: 'measured',
        };
        await recordUsage({
          workspaceDb,
          call,
          records: [
            { ...measurement, unit: 'requests', quantity: 1 },
            ...(result.seconds === undefined
              ? []
              : [{ ...measurement, unit: 'seconds' as const, quantity: result.seconds }]),
          ],
        });
        if (typeof result.text !== 'string') {
          throw new OperationError('transcription_failed', 'Transcription failed.', 502);
        }
        await finishCapabilityCall({
          workspaceDb,
          callId: call.id,
          status: 'succeeded',
        });
        settled = true;
        return { text: result.text };
      } catch (error) {
        if (callId && !settled) {
          const aborted =
            context.signal?.aborted === true || operationCode(error) === 'transcription_aborted';
          await finishCapabilityCall({
            workspaceDb,
            callId,
            status: aborted ? 'aborted' : 'failed',
            errorCode: operationCode(error),
          }).catch(() => undefined);
          settled = true;
        }
        if (error instanceof OperationError) throw error;
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

/** Refuses a missing or unavailable transcription route with the existing public codes. */
function requireTranscriptionRoute(
  route: ResolvedTranscriptionRoute
): Extract<ResolvedTranscriptionRoute, { configured: true }> {
  if (!route.configured) {
    throw new OperationError(
      'transcription_route_missing',
      'No transcription route is configured.',
      409
    );
  }
  if (!route.available) {
    throw new OperationError(
      route.unavailableReason ?? 'transcription_unavailable',
      'Transcription route is unavailable.',
      route.unavailableReason === 'gateway_disabled' ? 403 : 409
    );
  }
  return route;
}

/** The admitted member is the only selection the already resolved credential may serve. */
function sameTranscriptionSelection(
  admitted: { id: string; providerProfileId: string; providerModel: string },
  current: { id: string; providerProfileId: string; providerModel: string }
): boolean {
  return (
    admitted.id === current.id &&
    admitted.providerProfileId === current.providerProfileId &&
    admitted.providerModel === current.providerModel
  );
}
