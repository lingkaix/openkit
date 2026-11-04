import { type ReactNode, useEffect, useState } from 'react';
import { Button, Dialog, Modal, Select, TextField } from '../../primitives';

/** Client-side filters. These governance reads do not accept them on the wire. */
export interface ListFilter {
  outcome: 'all' | 'failed' | 'denied' | 'ok';
  query: string;
  from: string;
  until: string;
}

export const EMPTY_LIST_FILTER: ListFilter = {
  outcome: 'all',
  query: '',
  from: '',
  until: '',
};

const OUTCOMES = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failed' },
  { id: 'denied', label: 'Denied' },
  { id: 'ok', label: 'Ok' },
];

export type Attention = 'failed' | 'denied' | 'needs-decision' | 'ok';

/**
 * Classifies a recorded outcome into the summary groups.
 *
 * @param value Producer status, audit outcome, or permission result.
 * @returns Attention group. Values with no failure or decision signal are ok.
 */
export function attentionOf(value: string): Attention {
  switch (value) {
    case 'failed':
    case 'error':
    case 'failed-no-send':
      return 'failed';
    case 'denied':
    case 'deny':
      return 'denied';
    case 'require_approval':
    case 'require_escalation':
    case 'defer':
    case 'delivery-unknown':
    case 'queued':
      return 'needs-decision';
    default:
      return 'ok';
  }
}

/** True when the row belongs in the default summary. */
export function isAttention(value: string): boolean {
  return attentionOf(value) !== 'ok';
}

/** Short clause for one summary sentence. It does not name an actor. */
export function attentionClause(outcome: string): string {
  const kind = attentionOf(outcome);
  if (kind === 'denied') return 'A request was denied';
  if (kind === 'needs-decision') return 'A request needs a decision';
  return 'A request failed';
}

/**
 * Builds one summary sentence from an outcome, an object title, and a local time.
 * The sentence does not include an actor id.
 *
 * @param what What happened, already a short clause.
 * @param objectTitle Object the person can recognize.
 * @param at Recorded instant, when one exists.
 * @returns One sentence.
 */
export function attentionSentence(what: string, objectTitle: string, at?: string): string {
  const when = at ? ` at ${new Date(at).toLocaleString(undefined, { timeZoneName: 'short' })}` : '';
  return `${what} for ${objectTitle}${when}.`;
}

/** True when any control narrows the loaded page. */
export function filterIsActive(filter: ListFilter): boolean {
  return (
    filter.outcome !== 'all' ||
    filter.query.trim() !== '' ||
    filter.from !== '' ||
    filter.until !== ''
  );
}

/**
 * Applies the outcome, title, and time controls to one loaded row.
 *
 * @param filter Current controls.
 * @param row Title, outcome, and optional recorded instant.
 * @returns True when the row stays in the loaded-page view.
 */
export function matchesLoadedRow(
  filter: ListFilter,
  row: { outcome: string; title: string; at?: string }
): boolean {
  const kind = attentionOf(row.outcome);
  if (filter.outcome === 'failed' && kind !== 'failed') return false;
  if (filter.outcome === 'denied' && kind !== 'denied') return false;
  if (filter.outcome === 'ok' && kind !== 'ok') return false;
  const needle = filter.query.trim().toLowerCase();
  if (needle && !row.title.toLowerCase().includes(needle)) return false;
  if (!filter.from && !filter.until) return true;
  if (!row.at) return false;
  const time = Date.parse(row.at);
  if (Number.isNaN(time)) return false;
  if (filter.from) {
    const from = Date.parse(filter.from);
    if (!Number.isNaN(from) && time < from) return false;
  }
  if (filter.until) {
    const until = Date.parse(filter.until);
    if (!Number.isNaN(until) && time > until) return false;
  }
  return true;
}

/** Phone width matches the shell break. Absent matchMedia stays desktop so tests do. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 799px)');
    if (!media) return undefined;
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return phone;
}

/**
 * Summary first, then Records for the loaded rows.
 *
 * Necessity: usage, audit, tokens, Vault, and notifications share one shape.
 * Ablation: a copy of the summary and the disclosure in each screen drifts.
 *
 * @param props Summary and record renderers receive the loaded-page filter.
 */
export function LongList({
  summary,
  records,
}: {
  summary: (filter: ListFilter) => ReactNode;
  records: (filter: ListFilter) => ReactNode;
}) {
  const phone = usePhoneLayout();
  const [filter, setFilter] = useState<ListFilter>(EMPTY_LIST_FILTER);
  const [open, setOpen] = useState(false);
  const fields = (
    <div className="flex flex-col gap-3">
      <Select
        label="Outcome"
        items={OUTCOMES}
        selectedKey={filter.outcome}
        onSelectionChange={(key) => {
          if (key == null) return;
          const outcome = String(key);
          if (
            outcome === 'all' ||
            outcome === 'failed' ||
            outcome === 'denied' ||
            outcome === 'ok'
          ) {
            setFilter((current) => ({ ...current, outcome }));
          }
        }}
      />
      <TextField
        label="Search"
        value={filter.query}
        onChange={(query) => setFilter((current) => ({ ...current, query }))}
      />
      <TextField
        label="From"
        type="datetime-local"
        value={filter.from}
        onChange={(from) => setFilter((current) => ({ ...current, from }))}
      />
      <TextField
        label="Until"
        type="datetime-local"
        value={filter.until}
        onChange={(until) => setFilter((current) => ({ ...current, until }))}
      />
      {filterIsActive(filter) ? (
        <p className="text-sm text-fg-muted">This filter covers loaded records.</p>
      ) : null}
    </div>
  );
  const recordButton = (
    <Button
      variant="outline"
      className="min-h-11"
      aria-expanded={phone ? undefined : open}
      onPress={phone ? undefined : () => setOpen((current) => !current)}
    >
      Records
    </Button>
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-bold text-fg-strong">Failed or needs a decision</h2>
      <div className="flex flex-col gap-2 text-sm text-fg">{summary(filter)}</div>
      {phone ? (
        <Modal
          trigger={
            <Button variant="outline" className="min-h-11">
              Filters
            </Button>
          }
        >
          <Dialog title="Filters">{fields}</Dialog>
        </Modal>
      ) : (
        fields
      )}
      {phone ? (
        <Modal
          trigger={
            <Button variant="outline" className="min-h-11">
              Records
            </Button>
          }
        >
          <Dialog title="Records">{records(filter)}</Dialog>
        </Modal>
      ) : (
        <>
          {recordButton}
          {open ? <div className="overflow-x-auto">{records(filter)}</div> : null}
        </>
      )}
    </section>
  );
}
