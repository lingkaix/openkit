import { useMemo, useState } from 'react';
import { TextField as AriaTextField, Label, Text, TextArea } from 'react-aria-components';
import { Button, TextField } from '../../primitives';
import type { ArtifactReviewDecisionInput } from '../goal/data';

/** Exact range shape owned by the existing decision operation. */
type RangeFeedback = NonNullable<ArtifactReviewDecisionInput['rangeFeedback']>;
/** Immutable Material content and identity needed by source selection. */
type FeedbackRevision = Pick<RangeFeedback, 'materialId' | 'revisionId' | 'contentDigest'> & {
  content: string;
};

/** Maps one displayed newline offset to the original source without allocating a per-character index. */
function originalOffset(content: string, displayedOffset: number) {
  let sourceOffset = 0;
  for (let displayed = 0; displayed < displayedOffset; displayed += 1) {
    sourceOffset += content[sourceOffset] === '\r' && content[sourceOffset + 1] === '\n' ? 2 : 1;
  }
  return sourceOffset;
}

/** Rejects a UTF-16 boundary between the two code units of one surrogate pair. */
function splitsSurrogate(content: string, offset: number) {
  const before = content.charCodeAt(offset - 1);
  const after = content.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Selects optional exact-source feedback without editing, normalizing or applying Material text. */
export function MaterialRangeFeedback({
  revision,
  value,
  onChange,
  isDisabled = false,
}: {
  revision: FeedbackRevision;
  value: RangeFeedback | null;
  onChange: (value: RangeFeedback | null) => void;
  isDisabled?: boolean;
}) {
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const displayedText = useMemo(() => revision.content.replace(/\r\n?/g, '\n'), [revision.content]);
  const start = /^\d+$/.test(startText) ? Number(startText) : Number.NaN;
  const end = /^\d+$/.test(endText) ? Number(endText) : Number.NaN;
  const valid =
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < end &&
    end <= revision.content.length &&
    !splitsSurrogate(revision.content, start) &&
    !splitsSurrogate(revision.content, end);

  return (
    <section
      aria-label="Material feedback range"
      className="mx-auto mt-5 flex max-w-[760px] flex-col gap-3"
    >
      <AriaTextField isReadOnly isDisabled={isDisabled} className="flex flex-col gap-2">
        <Label className="text-sm font-bold text-fg">Feedback base text</Label>
        <Text slot="description" className="text-xs text-fg-muted">
          Optional: select text from the recorded base, or enter its original UTF-16 offsets below.
          The end offset is exclusive. This does not edit the Material.
        </Text>
        <TextArea
          value={displayedText}
          onSelect={(event) => {
            setStartText(
              String(originalOffset(revision.content, event.currentTarget.selectionStart))
            );
            setEndText(String(originalOffset(revision.content, event.currentTarget.selectionEnd)));
          }}
          className="min-h-32 w-full rounded-ok border border-border bg-card p-3 font-mono text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-focus disabled:text-disabled-fg"
        />
      </AriaTextField>
      <p className="font-mono text-xs text-fg-muted">
        {revision.revisionId} · {revision.contentDigest}
      </p>
      <div className="flex flex-wrap gap-3">
        <TextField
          label="Range start"
          value={startText}
          onChange={setStartText}
          isDisabled={isDisabled}
        />
        <TextField
          label="Range end"
          value={endText}
          onChange={setEndText}
          isDisabled={isDisabled}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          isDisabled={isDisabled || !valid}
          onPress={() =>
            onChange({
              materialId: revision.materialId,
              revisionId: revision.revisionId,
              contentDigest: revision.contentDigest,
              start,
              end,
              originalText: revision.content.slice(start, end),
            })
          }
        >
          Use feedback range
        </Button>
        {value ? (
          <Button size="sm" variant="quiet" isDisabled={isDisabled} onPress={() => onChange(null)}>
            Clear feedback range
          </Button>
        ) : null}
      </div>
      {value ? (
        <div role="status" className="text-sm text-fg">
          <p>
            Feedback range: {value.start}–{value.end}
          </p>
          <pre className="whitespace-pre-wrap font-sans">{value.originalText}</pre>
        </div>
      ) : null}
      {(startText || endText) && !valid ? (
        <p className="text-xs text-negative-fg">
          Choose a nonempty range within the original text, with no split Unicode character.
        </p>
      ) : null}
    </section>
  );
}
