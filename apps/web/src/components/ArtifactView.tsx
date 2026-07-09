import type { Artifact } from '../lib/app-types';

/**
 * Props for the artifact detail renderer.
 */
export interface ArtifactViewProps {
  artifact: Artifact;
  onBack(): void;
}

/**
 * Formats artifact body content for display.
 */
function artifactBody(artifact: Artifact): string {
  if (artifact.content.format !== 'json') {
    return artifact.content.body;
  }

  try {
    return JSON.stringify(JSON.parse(artifact.content.body) as unknown, null, 2);
  } catch {
    return artifact.content.body;
  }
}

/**
 * Renders one artifact detail page.
 */
export function ArtifactView(props: ArtifactViewProps) {
  return (
    <section class="workspace-panel">
      <div class="ui-section-header mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-[0.2em] opacity-60">Artifact</p>
          <h2 class="font-display text-2xl font-semibold text-base-content">
            {props.artifact.title}
          </h2>
          <p class="mt-2 text-sm opacity-70">{props.artifact.summary}</p>
        </div>
        <button class="btn btn-outline btn-sm" onClick={props.onBack} type="button">
          Back
        </button>
      </div>
      <div class="flex flex-wrap gap-2">
        <span class="badge badge-outline">{props.artifact.kind}</span>
        <span class="badge badge-outline">{props.artifact.status}</span>
        <span class="badge badge-outline">v{props.artifact.version}</span>
      </div>
      <pre class="mt-5 whitespace-pre-wrap rounded-lg bg-base-200 p-4 text-sm leading-7">
        {artifactBody(props.artifact)}
      </pre>
    </section>
  );
}
