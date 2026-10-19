import {
  WORKSPACE_RESOURCE_POLICY_FEATURE,
  WorkspaceConfigSchema,
  type WorkspacePolicySubject,
  type WorkspaceResourceAccessEntry,
} from '@openkit/config-schema';
import { applyEdits, modify, parse } from 'jsonc-parser';

/** Validates that every managed boundary names a canonical shared Thread included in the same export. */
export function assertPortableResourcePolicy(
  entries: readonly WorkspaceResourceAccessEntry[],
  threads: readonly { readonly id: string; readonly visibility: string }[]
): void {
  for (const entry of entries) {
    if (
      !threads.some(
        (thread) => thread.id === entry.resource.id && thread.visibility === 'workspace'
      )
    )
      throw new Error('Workspace resource Policy has no portable shared Thread owner.');
  }
}

/** Remints resource references while preserving restrictions; unverified source principals never acquire target rights. */
export function remintResourcePolicyConfig(input: {
  readonly content: string;
  readonly threadIds: ReadonlyMap<string, string>;
  readonly threads: readonly { readonly id: string; readonly visibility: string }[];
  readonly manifestFeatures: readonly string[];
  readonly subjectEligible?: (subject: WorkspacePolicySubject) => boolean;
}): string {
  const config = WorkspaceConfigSchema.parse(parse(input.content));
  const entries = config.workspace.policy?.resourceAccess ?? [];
  if (!entries.length) return input.content;
  if (!input.manifestFeatures.includes(WORKSPACE_RESOURCE_POLICY_FEATURE))
    throw new Error('Workspace export omits its resource Policy required feature.');
  assertPortableResourcePolicy(entries, input.threads);
  const reminted = entries.map((entry) => {
    const id = input.threadIds.get(entry.resource.id);
    if (!id) throw new Error('Workspace resource Policy has no imported Thread identity.');
    for (const allocation of [...entry.grants, ...entry.prohibitions]) {
      if (input.subjectEligible?.(allocation.subject) !== true)
        throw new Error('Workspace resource Policy target principal binding is not validated.');
    }
    return { ...entry, resource: { ...entry.resource, id } };
  });
  return applyEdits(
    input.content,
    modify(input.content, ['workspace', 'policy', 'resourceAccess'], reminted, {})
  );
}
