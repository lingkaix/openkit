import type { JudgementRecord } from '@openkit/app-api-schemas';
import { createRequestId } from '@openkit/core-client';
import { useState } from 'react';
import { Button, ErrorBanner, Skeleton, TextField } from '../../primitives';
import {
  type AssessmentInput,
  judgementError,
  judgementRefused,
  judgementRetryable,
  useAddJudgement,
  useArtifactJudgements,
} from './judgement-data';

/** Shared human assessment fields retain explicit rating bounds and never select actor or time. */
export function AssessmentForm(props: {
  target: JudgementRecord['target'] | null;
  disabled: boolean;
  onRecord: (judgement: AssessmentInput['judgement']) => void;
}) {
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const rating = { value: Number(value), lowerBound: Number(lower), upperBound: Number(upper) };
  const validRating =
    [value, lower, upper].every((text) => text.trim() !== '') &&
    Object.values(rating).every(Number.isFinite) &&
    rating.lowerBound < rating.upperBound &&
    rating.value >= rating.lowerBound &&
    rating.value <= rating.upperBound;
  const blocked = props.disabled || !props.target;
  function record(kind: 'accept' | 'reject' | 'rate') {
    if (!props.target || blocked || (kind === 'rate' && !validRating)) return;
    const shared = { target: props.target, note: note.trim() || null, extensions: {} };
    props.onRecord(
      kind === 'rate' ? { ...shared, kind, choice: rating } : { ...shared, kind, choice: null }
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <TextField
        label="Assessment note"
        value={note}
        onChange={setNote}
        isDisabled={props.disabled}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" isDisabled={blocked} onPress={() => record('accept')}>
          Record accept assessment
        </Button>
        <Button size="sm" variant="outline" isDisabled={blocked} onPress={() => record('reject')}>
          Record reject assessment
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <TextField
          label="Rating value"
          inputMode="decimal"
          value={value}
          onChange={setValue}
          isDisabled={props.disabled}
        />
        <TextField
          label="Scale lower bound"
          inputMode="decimal"
          value={lower}
          onChange={setLower}
          isDisabled={props.disabled}
        />
        <TextField
          label="Scale upper bound"
          inputMode="decimal"
          value={upper}
          onChange={setUpper}
          isDisabled={props.disabled}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        isDisabled={blocked || !validRating}
        onPress={() => record('rate')}
      >
        Record rating
      </Button>
      <p className="text-xs text-fg-muted">
        Assessments record your judgement. They do not accept a proposal or start work. Rating
        scales have no implied equivalence.
      </p>
    </div>
  );
}

/** Displays retained server attribution and typed effects without interpreting a rating as absolute quality. */
export function JudgementHistory({ items }: { items: JudgementRecord[] }) {
  return (
    <ol aria-label="Judgement history" className="flex flex-col gap-3">
      {items.length === 0 ? (
        <li className="text-sm text-fg-muted">No assessments recorded.</li>
      ) : null}
      {items.map((entry) => (
        <li key={entry.requestId} className="rounded-ok border border-border p-3 text-sm text-fg">
          <p>
            {entry.kind === 'correct'
              ? entry.choice.outcome === 'apply'
                ? 'Applied correction'
                : 'Rejected correction'
              : entry.kind}
          </p>
          <p>
            <span>{entry.actor.id}</span> ·{' '}
            <time dateTime={entry.recordedAt}>{entry.recordedAt}</time>
          </p>
          <p className="break-all text-xs text-fg-muted">Request {entry.requestId}</p>
          {entry.target.kind === 'artifact-version' ? (
            <p className="break-all">
              {entry.target.artifactId} · version {entry.target.artifactVersion} ·{' '}
              {entry.target.contentDigest}
            </p>
          ) : entry.target.kind === 'material-range' ? (
            <>
              <p className="break-all">
                {entry.target.materialId} · {entry.target.revisionId} · {entry.target.contentDigest}{' '}
                · UTF-16 {entry.target.start}–{entry.target.end}
              </p>
              <pre className="whitespace-pre-wrap">{entry.target.originalText}</pre>
            </>
          ) : (
            <p>{entry.target.candidateSetId}</p>
          )}
          {entry.kind === 'rate' ? (
            <p>
              {entry.choice.value} on scale {entry.choice.lowerBound}–{entry.choice.upperBound}
            </p>
          ) : null}
          {entry.kind === 'correct' ? (
            <>
              <p>Replacement</p>
              <pre className="whitespace-pre-wrap">
                {entry.choice.replacementText || '(empty text)'}
              </pre>
              {entry.choice.outcome === 'apply' ? (
                <dl>
                  <dt>Resulting revision</dt>
                  <dd>{entry.choice.resultingRevision.revisionId}</dd>
                  <dt>Resulting digest</dt>
                  <dd className="break-all">{entry.choice.resultingRevision.contentDigest}</dd>
                </dl>
              ) : (
                <p>No content change.</p>
              )}
            </>
          ) : null}
          {entry.note ? <p className="whitespace-pre-wrap">{entry.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}

/** A command result offers only explicit same-request replay while its outcome is uncertain. */
export function JudgementCommandStatus(props: {
  pending: boolean;
  failed: boolean;
  error: unknown;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {props.pending ? (
        <p role="status" className="text-sm text-fg-muted">
          Recording judgement…
        </p>
      ) : null}
      {props.failed ? <ErrorBanner message={judgementError(props.error)} /> : null}
      {props.failed && judgementRetryable(props.error) ? (
        <Button size="sm" variant="outline" isDisabled={props.disabled} onPress={props.onRetry}>
          Retry same request
        </Button>
      ) : null}
    </>
  );
}

/** Exact Artifact-version assessments, rendered within version inspection. */
export function ArtifactJudgements(props: {
  workspaceId: string;
  artifactId: string;
  artifactVersion: number;
  contentDigest: string;
  disabled: boolean;
  unavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Artifact version assessments" className="flex flex-col gap-3">
      <Button
        size="sm"
        variant="outline"
        isDisabled={props.disabled || props.unavailable}
        onPress={() => setOpen(true)}
      >
        Assess exact version
      </Button>
      {open ? (
        <ArtifactAssessment
          key={`${props.workspaceId}:${props.artifactId}:${props.artifactVersion}:${props.contentDigest}`}
          {...props}
        />
      ) : null}
    </section>
  );
}

/** Reads current authorization before displaying retained Review assessments for this exact version. */
function ArtifactAssessment(props: Parameters<typeof ArtifactJudgements>[0]) {
  const history = useArtifactJudgements(
    props.workspaceId,
    props.artifactId,
    props.artifactVersion,
    props.contentDigest
  );
  const command = useAddJudgement();
  const ready = history.isSuccess && !history.isFetching && !props.unavailable;
  const target = {
    kind: 'artifact-version' as const,
    artifactId: props.artifactId,
    artifactVersion: props.artifactVersion,
    contentDigest: props.contentDigest,
  };
  const items = history.isSuccess ? history.data : [];
  const receipt = command.data;
  const displayed =
    receipt && !items.some((entry) => entry.requestId === receipt.requestId)
      ? [...items, receipt]
      : items;
  return (
    <>
      {props.unavailable ? (
        <p className="text-sm text-fg-muted">
          The exact version is unavailable. Refresh its original before continuing.
        </p>
      ) : history.isError ? (
        <ErrorBanner
          message="Couldn't load assessment history."
          onRetry={() => void history.refetch()}
        />
      ) : !history.isSuccess ? (
        <Skeleton lines={3} />
      ) : null}
      {history.isSuccess && !props.unavailable ? <JudgementHistory items={displayed} /> : null}
      <AssessmentForm
        target={target}
        disabled={props.disabled || !ready || command.isPending || command.isError}
        onRecord={(judgement) =>
          command.mutate({
            workspaceId: props.workspaceId,
            requestId: createRequestId(),
            judgement,
          })
        }
      />
      <JudgementCommandStatus
        pending={command.isPending}
        failed={command.isError}
        error={command.error}
        disabled={props.disabled || !ready}
        onRetry={() => {
          if (command.variables) command.mutate(command.variables);
        }}
      />
      {command.isError && judgementRefused(command.error) ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || props.unavailable || history.isFetching}
          onPress={async () => {
            const current = await history.refetch();
            if (current.isSuccess) command.reset();
          }}
        >
          Refresh before editing refused request
        </Button>
      ) : null}
    </>
  );
}
