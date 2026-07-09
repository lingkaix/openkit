import type { Item } from '../lib/app-types';

type ApprovalRequestItem = Extract<Item, { type: 'approval-request' }>;
type ApprovalDecision = 'granted' | 'denied';

/**
 * Props for one inline approval request card.
 */
export interface ApprovalCardProps {
  disabled: boolean;
  item: ApprovalRequestItem;
  onRespond(approvalRequestId: string, decision: ApprovalDecision): void;
}

/**
 * Renders an inline approval request and response controls.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  return (
    <section class="approval-placeholder">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span class="badge badge-outline badge-sm">{props.item.kind}</span>
          <h3 class="mt-2 font-semibold">{props.item.title}</h3>
          <p class="mt-1 text-sm opacity-70">{props.item.description}</p>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="btn btn-success btn-sm"
          disabled={props.disabled}
          onClick={() => props.onRespond(props.item.approvalRequestId, 'granted')}
          type="button"
        >
          Approve
        </button>
        <button
          class="btn btn-error btn-sm"
          disabled={props.disabled}
          onClick={() => props.onRespond(props.item.approvalRequestId, 'denied')}
          type="button"
        >
          Deny
        </button>
      </div>
    </section>
  );
}
