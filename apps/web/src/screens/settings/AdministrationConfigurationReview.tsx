import type {
  ApplyAdministrationConfigurationResponse,
  ConfigurationCandidateArtifact,
} from '@openkit/app-api-schemas';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  ErrorBanner,
  Modal,
  StatusChip,
  type StatusTone,
} from '../../primitives';
import { chatKeys } from '../chat/data';

/** Exact private catalog candidate bound to one Artifact version and digest. */
export interface ConfigurationCandidate {
  candidate: {
    artifactId: string;
    artifactVersion: 1;
    contentDigest: string;
  };
  details: ConfigurationCandidateArtifact;
  outcome: ApplyAdministrationConfigurationResponse | null;
}

const applyKey = (candidate: ConfigurationCandidate['candidate']) =>
  [
    'settings',
    'administration',
    'apply-configuration',
    candidate.artifactId,
    candidate.artifactVersion,
    candidate.contentDigest,
  ] as const;

/** Human review and one-shot apply for an exact catalog candidate Artifact. */
export function AdministrationConfigurationReview({
  candidate,
  confirmationBlocked,
  threadId,
  workspaceId,
}: {
  candidate: ConfigurationCandidate;
  confirmationBlocked: boolean;
  threadId: string;
  workspaceId: string;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const mutationKey = applyKey(candidate.candidate);
  const apply = useMutation({
    mutationKey,
    mutationFn: async () =>
      client.app.applyAdministrationConfiguration({
        candidate: candidate.candidate,
        confirmation: {
          action: 'administration.configuration.apply',
          contentDigest: candidate.candidate.contentDigest,
        },
        requestId: await configurationRequestId(workspaceId, threadId, candidate.candidate),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.items(workspaceId, threadId),
      });
    },
  });
  const priorAttempts = useMutationState({
    filters: { exact: true, mutationKey },
    select: (mutation) => mutation.state.status,
  });
  const recorded = candidate.outcome ?? apply.data ?? null;
  const attempted = priorAttempts.length > 0 || recorded !== null;
  const blocked = confirmationBlocked || attempted;
  const status = configurationStatus(recorded, attempted);

  function submitApply() {
    if (blocked) return;
    apply.mutate();
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-extrabold text-fg-strong">Prepared configuration change</h2>
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
          </div>
          <p className="mt-1 text-sm text-fg">
            {targetLabel(candidate.details)} · base revision {candidate.details.expectedRevision}
          </p>
        </div>
        <Modal trigger={<Button isDisabled={blocked}>Review configuration</Button>}>
          <Dialog title="Apply configuration?">
            <CandidateFacts candidate={candidate} />
            <p className="break-all text-xs text-fg-muted">
              Exact confirmation: administration.configuration.apply ·{' '}
              {candidate.candidate.contentDigest}
            </p>
            <p className="font-bold text-negative-fg">
              This writes the exact catalog metadata shown below. Persistence is not a live reload,
              and an unknown reload requires inspection of a fresh candidate.
            </p>
            <div className="flex justify-end gap-2">
              <Button slot="close" variant="quiet">
                Cancel
              </Button>
              <Button slot="close" variant="negative" isDisabled={blocked} onPress={submitApply}>
                Apply configuration
              </Button>
            </div>
          </Dialog>
        </Modal>
      </div>
      <CandidateFacts candidate={candidate} />
      {apply.isError ? (
        <ErrorBanner message="Configuration application could not be confirmed. Inspect persistence and reload, then prepare a fresh candidate." />
      ) : null}
      {recorded ? <ApplyResultCard result={recorded} /> : null}
    </Card>
  );
}

/** Displays the exact preview whose identity is confirmed by Apply. */
function CandidateFacts({ candidate }: { candidate: ConfigurationCandidate }) {
  const { candidate: identity, details } = candidate;
  return (
    <div className="flex flex-col gap-2 text-xs text-fg-muted">
      <p className="break-all">
        Configuration Artifact {identity.artifactId} v{identity.artifactVersion} ·{' '}
        {identity.contentDigest}
      </p>
      <p>{targetLabel(details)}</p>
      <p className="break-all">Base revision {details.expectedRevision}</p>
      <p>{details.restartRequired ? 'Restart required' : 'No restart required'}</p>
      <MetadataBlock label="Before" value={details.before} />
      <MetadataBlock label="After" value={details.after} />
    </div>
  );
}

/** Renders existing editable catalog metadata as text, preserving long values. */
function MetadataBlock({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div>
      <p className="font-bold text-fg">{label}</p>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** Separates persistence from reload and restart outcomes without implying readiness. */
function ApplyResultCard({ result }: { result: ApplyAdministrationConfigurationResponse }) {
  const unknownReload = result.reload !== 'applied';
  return (
    <div className="rounded-ok border border-border bg-sunken p-3">
      <p className="text-sm font-bold text-fg-strong">Configuration command result</p>
      <p className="text-xs text-fg-muted">
        {result.persisted
          ? 'Configuration write persisted'
          : 'Configuration write was not persisted'}
      </p>
      {result.revision ? (
        <p className="break-all text-xs text-fg-muted">Revision {result.revision}</p>
      ) : (
        <p className="text-xs text-fg-muted">No confirmed revision.</p>
      )}
      <p className="text-xs text-fg-muted">Reload {result.reload}</p>
      <p className="text-xs text-fg-muted">
        {result.restartRequired ? 'Restart required' : 'No restart required'}
      </p>
      {unknownReload ? (
        <p className="mt-2 text-sm font-bold text-negative-fg">
          Reload did not confirm a live configuration. Inspect the persisted revision and prepare a
          fresh candidate; do not retry this Apply.
        </p>
      ) : null}
    </div>
  );
}

/** Projects recorded application facts without marking an attempted command as ready. */
function configurationStatus(
  recorded: ApplyAdministrationConfigurationResponse | null,
  attempted: boolean
): { label: string; tone: StatusTone } {
  if (recorded) {
    if (recorded.persisted && recorded.reload === 'applied') {
      return { label: 'Applied', tone: 'positive' };
    }
    if (recorded.persisted) return { label: 'Persisted', tone: 'notice' };
    return { label: 'Not persisted', tone: 'negative' };
  }
  if (attempted) return { label: 'Apply not confirmed', tone: 'negative' };
  return { label: 'Ready for review', tone: 'notice' };
}

/** Names the deployment catalog affected by the candidate. */
function targetLabel(details: ConfigurationCandidateArtifact): string {
  return details.targetFamily === 'provider'
    ? `Provider ${details.targetId}`
    : `Gateway ${details.targetId}`;
}

/** Keeps a fresh-render confirmation on the same server receipt, including unknown outcomes. */
async function configurationRequestId(
  workspaceId: string,
  threadId: string,
  candidate: ConfigurationCandidate['candidate']
): Promise<string> {
  const identity = JSON.stringify([
    'administration.configuration.apply',
    workspaceId,
    threadId,
    candidate.artifactId,
    candidate.artifactVersion,
    candidate.contentDigest,
  ]);
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity)
  );
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
