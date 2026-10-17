import { type CoreClient, createRequestId } from '@openkit/core-client';
import { useEffect, useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { Button, TextField } from '../../primitives';
import {
  AssessmentForm,
  JudgementCommandStatus,
  JudgementHistory,
} from '../artifacts/ArtifactJudgements';
import {
  judgementRefused,
  useAddJudgement,
  useCorrectMaterialRange,
} from '../artifacts/judgement-data';
import { MaterialRangeFeedback } from './MaterialRangeFeedback';

/** Assessments and explicit corrections for one inspected immutable Material revision. */
export function MaterialJudgements(props: {
  workspaceId: string;
  revision: Awaited<ReturnType<CoreClient['operations']['material.revision-read']>>['revision'];
  disabled: boolean;
  unavailable?: boolean;
  /** Applying advances the editor baseline; annotations and rejection have no content effect. */
  applyDisabled?: boolean;
  /** Projects the existing Apply mutation state so the main editor cannot race its revision effect. */
  onApplyBusyChange?: (busy: boolean) => void;
  onRefresh?: () => Promise<boolean>;
  onInspect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Material revision judgements" className="flex flex-col gap-3">
      <Button
        size="sm"
        variant="outline"
        isDisabled={props.disabled || props.unavailable}
        onPress={() => {
          props.onInspect?.();
          setOpen(true);
        }}
      >
        Assess selected revision
      </Button>
      {open ? (
        <MaterialAssessment
          key={`${props.workspaceId}:${props.revision.materialId}:${props.revision.revisionId}:${props.revision.contentDigest}`}
          {...props}
        />
      ) : null}
    </section>
  );
}

/** The existing range picker owns UTF-16 selection; correction never rewrites its original target. */
function MaterialAssessment(props: Parameters<typeof MaterialJudgements>[0]) {
  const [range, setRange] = useState<Parameters<typeof MaterialRangeFeedback>[0]['value']>(null);
  const [replacementText, setReplacement] = useState('');
  const [note, setNote] = useState('');
  const assessment = useAddJudgement();
  const correction = useCorrectMaterialRange();
  const applyBusy =
    correction.variables?.decision === 'apply' &&
    (correction.isPending || (correction.isError && !judgementRefused(correction.error)));
  useEffect(() => {
    props.onApplyBusyChange?.(applyBusy);
  }, [applyBusy, props.onApplyBusyChange]);
  const locked =
    assessment.isPending || assessment.isError || correction.isPending || correction.isError;
  const disabled = props.disabled || props.unavailable || locked;
  const target = range
    ? { ...range, kind: 'material-range' as const, offsetUnit: 'utf-16' as const }
    : null;
  const revision = props.revision;
  const items = revision.judgements.filter(
    (entry) =>
      entry.workspaceId === props.workspaceId &&
      entry.target.kind === 'material-range' &&
      entry.target.materialId === revision.materialId &&
      entry.target.revisionId === revision.revisionId &&
      entry.target.contentDigest === revision.contentDigest
  );
  for (const record of [assessment.data, correction.data])
    if (record && !items.some((entry) => entry.requestId === record.requestId)) items.push(record);
  function correct(decision: 'apply' | 'reject') {
    if (!target || disabled || (decision === 'apply' && props.applyDisabled)) return;
    correction.mutate({
      workspaceId: props.workspaceId,
      requestId: createRequestId(),
      target,
      replacementText,
      decision,
      note: note.trim() || null,
      extensions: {},
    });
  }
  async function refreshRefused() {
    if (await props.onRefresh?.()) {
      if (assessment.isError && judgementRefused(assessment.error)) assessment.reset();
      if (correction.isError && judgementRefused(correction.error)) correction.reset();
    }
  }
  return (
    <>
      {props.unavailable ? (
        <p className="text-sm text-fg-muted">
          The selected revision is unavailable. Refresh before continuing.
        </p>
      ) : (
        <MaterialRangeFeedback
          revision={revision}
          value={range}
          onChange={setRange}
          isDisabled={disabled}
        />
      )}
      <AssessmentForm
        target={target}
        disabled={disabled}
        onRecord={(judgement) =>
          assessment.mutate({
            workspaceId: props.workspaceId,
            requestId: createRequestId(),
            judgement,
          })
        }
      />
      <AriaTextField
        value={replacementText}
        onChange={setReplacement}
        isDisabled={disabled}
        className="flex flex-col gap-2"
      >
        <Label className="text-sm font-bold text-fg">Replacement text</Label>
        <TextArea className="min-h-24 rounded-ok border border-border bg-card p-3 text-sm text-fg outline-none focus:border-accent" />
      </AriaTextField>
      <TextField label="Correction note" value={note} onChange={setNote} isDisabled={disabled} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          isDisabled={disabled || !target || props.applyDisabled}
          onPress={() => correct('apply')}
        >
          Apply range correction
        </Button>
        <Button
          size="sm"
          variant="outline"
          isDisabled={disabled || !target}
          onPress={() => correct('reject')}
        >
          Reject range correction
        </Button>
      </div>
      {applyBusy ? (
        <p className="text-xs text-notice-fg">
          The main editor and revision selection are locked while Apply is pending or its result is
          unknown. Retry the same request after an unknown result.
        </p>
      ) : null}
      {props.applyDisabled ? (
        <p className="text-xs text-notice-fg">
          Save the main editor draft before applying a range correction.
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        Apply requests a new Material revision from this exact original range. Reject records the
        correction without changing content. Empty replacement text deletes the range.
      </p>
      <JudgementCommandStatus
        pending={assessment.isPending || correction.isPending}
        failed={assessment.isError || correction.isError}
        error={assessment.isError ? assessment.error : correction.error}
        disabled={props.disabled || props.unavailable === true}
        onRetry={() => {
          if (assessment.isError && assessment.variables) assessment.mutate(assessment.variables);
          else if (correction.isError && correction.variables)
            correction.mutate(correction.variables);
        }}
      />
      {props.onRefresh &&
      ((assessment.isError && judgementRefused(assessment.error)) ||
        (correction.isError && judgementRefused(correction.error))) ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={props.disabled || props.unavailable}
          onPress={() => void refreshRefused()}
        >
          Refresh before editing refused request
        </Button>
      ) : null}
      {!props.unavailable ? <JudgementHistory items={items} /> : null}
    </>
  );
}
