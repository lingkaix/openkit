import { ArtifactRow, Card, Eyebrow, StatusChip } from '../../primitives';
import type { ThreadGoalSummary } from './data';

export interface CompletedViewProps {
  goal: ThreadGoalSummary;
  /** Open an artifact into the review route when provided. */
  onOpenArtifact?: (artifactId: string) => void;
}

/**
 * Goal completed closeout (board 21) — terminal summary with verification
 * evidence, artifacts produced, and suggested next work.
 */
export function CompletedView({ goal, onOpenArtifact }: CompletedViewProps) {
  const summary = goal.terminalSummary;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 bg-positive-bg px-4 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-eyebrow text-positive-fg">
              Goal completed
            </p>
            <h1 className="mt-1 text-lg font-extrabold text-fg-strong">{goal.title}</h1>
            <p className="mt-1 text-sm text-fg-muted">{goal.objective}</p>
          </div>
          <div className="ml-auto">
            <StatusChip tone="positive" dot>
              Completed
            </StatusChip>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-4 py-4">
          {summary?.verificationEvidence && summary.verificationEvidence.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Verification</Eyebrow>
              <ul className="flex flex-col gap-2">
                {summary.verificationEvidence.map((evidence) => (
                  <li
                    key={evidence.verificationId}
                    className="flex items-start gap-2 text-sm text-fg"
                  >
                    <StatusChip tone={evidence.status === 'passed' ? 'positive' : 'notice'}>
                      {evidence.status}
                    </StatusChip>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{evidence.summary}</span>
                      {evidence.command ? (
                        <span className="mt-0.5 block font-mono text-xs text-fg-muted">
                          {evidence.command}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {summary?.artifactIds && summary.artifactIds.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Artifacts</Eyebrow>
              <div className="flex flex-col gap-1">
                {summary.artifactIds.map((id) => (
                  <ArtifactRow
                    key={id}
                    name={id}
                    onOpen={onOpenArtifact ? () => onOpenArtifact(id) : undefined}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {summary?.suggestedNextWork && summary.suggestedNextWork.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Eyebrow>Suggested next</Eyebrow>
              <ul className="list-disc pl-5 text-sm text-fg">
                {summary.suggestedNextWork.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
