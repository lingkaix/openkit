import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import type { ComposerProps } from '../../primitives';
import type { VoiceTranscribe } from '../../primitives/voice-input';

const ROUTE_REASON: Record<string, string> = {
  provider_profile_absent: 'profile missing',
  provider_model_delisted: 'model not listed',
  provider_not_dispatchable: 'profile not dispatchable',
  provider_api_key_missing: 'missing key',
  subscription_vault_unavailable: 'slot/Vault check',
  subscription_account_absent: 'account slot missing',
  subscription_account_logged_out: 'slot not signed in',
  subscription_account_integrity_unavailable: 'slot/Vault check',
  gateway_disabled: 'Gateway disabled',
  provider_base_url_missing: 'missing base URL',
};

/** User-facing reason for a configured transcription route that cannot be used. */
export function transcriptionUnavailableText(reason: string | null): string {
  if (!reason) return 'Voice input is unavailable.';
  const label = ROUTE_REASON[reason];
  return label ? `Voice input is unavailable: ${label}.` : 'Voice input is unavailable.';
}

/**
 * Supplies the composer mic from the conversation catalog.
 *
 * No route member hides the control. A blocked route shows the existing reason.
 * The returned callback appends through the composer and does not send the draft.
 */
export function composerVoice(input: {
  readonly client: CoreClient;
  readonly workspaceId: string | null;
  readonly threadId?: string | null;
  readonly catalog: ConversationTargetCatalog | null | undefined;
}): ComposerProps['voice'] | undefined {
  const transcription = input.catalog?.transcription;
  if (!input.workspaceId || !transcription) return undefined;
  if (!transcription.available) {
    return { unavailableReason: transcriptionUnavailableText(transcription.unavailableReason) };
  }
  const workspaceId = input.workspaceId;
  const threadId = input.threadId;
  const transcribe: VoiceTranscribe = ({ audioBase64, mimeType, language }) => {
    const audioMime =
      mimeType === 'audio/webm' || mimeType === 'audio/webm;codecs=opus' || mimeType === 'audio/mp4'
        ? mimeType
        : null;
    if (!audioMime) return Promise.reject(new Error('Unsupported audio type.'));
    return input.client.operations['composer.transcribe']({
      workspaceId,
      ...(threadId ? { threadId } : {}),
      audio: audioBase64,
      mimeType: audioMime,
      ...(language ? { language } : {}),
    });
  };
  return { transcribe };
}
