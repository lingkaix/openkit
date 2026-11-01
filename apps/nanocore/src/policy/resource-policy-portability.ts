import type { PolicyDocumentV1 } from '@openkit/protocol';

/** Refuses a portable restriction whose shared Thread is absent from the same export. */
export function assertPortableResourcePolicy(
  document: PolicyDocumentV1,
  threads: readonly { readonly id: string; readonly visibility: string }[]
): void {
  for (const statement of document.statements)
    for (const resource of statement.scope.resources) {
      if (
        resource.kind !== 'container' ||
        resource.container.kind !== 'thread' ||
        !threads.some(
          (thread) => thread.id === resource.container.id && thread.visibility === 'workspace'
        )
      )
        throw new Error('Workspace resource Policy has no portable shared Thread owner.');
    }
}
