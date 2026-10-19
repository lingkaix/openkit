import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema, type WorkspacePolicySubject } from '@openkit/config-schema';
import type { PolicyDocumentV1 } from '@openkit/protocol';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { EMPTY_POLICY_DOCUMENT } from './statements.js';
import { parseWorkspacePolicy, workspacePolicySubject } from './workspace-resource-access.js';

/** Refuses a portable restriction whose shared Thread is absent from the same export. */
export function assertPortableResourcePolicy(document: PolicyDocumentV1, threads: readonly {readonly id:string; readonly visibility:string}[]): void {
  for (const statement of document.statements) for (const resource of statement.scope.resources) {
    if (resource.kind !== 'container' || resource.container.kind !== 'thread' || !threads.some(thread => thread.id === resource.container.id && thread.visibility === 'workspace'))
      throw new Error('Workspace resource Policy has no portable shared Thread owner.');
  }
}

/** Remints owners and Thread selectors without inferring target principal authority. */
export function remintResourcePolicyConfig(input: {
  readonly content:string; readonly sourceWorkspaceId:string; readonly targetWorkspaceId:string;
  readonly threadIds:ReadonlyMap<string,string>;
  readonly threads:readonly {readonly id:string;readonly visibility:string}[];
  readonly manifestFeatures:readonly string[];
  readonly subjectEligible?:(subject:WorkspacePolicySubject)=>boolean;
}):string {
  const config=WorkspaceConfigSchema.parse(parse(input.content));
  const document=parseWorkspacePolicy(input.sourceWorkspaceId,config.workspace.policy?.mediation ?? EMPTY_POLICY_DOCUMENT);
  if (!document.statements.length) return input.content;
  if (!input.manifestFeatures.includes(WORKSPACE_RESOURCE_POLICY_FEATURE)) throw new Error('Workspace export omits its resource Policy required feature.');
  assertPortableResourcePolicy(document,input.threads);
  const statements=document.statements.map(statement=>{
    const subject=workspacePolicySubject(statement);
    if (subject && input.subjectEligible?.(subject)!==true) throw new Error('Workspace resource Policy target principal binding is not validated.');
    const resources=statement.scope.resources.map(resource=>{
      if (resource.kind!=='container' || resource.container.kind!=='thread' || resource.container.owner.kind!=='workspace' || resource.container.owner.workspaceId!==input.sourceWorkspaceId) throw new Error('Unsupported portable Workspace Policy resource.');
      const id=input.threadIds.get(resource.container.id);
      if (!id) throw new Error('Workspace resource Policy has no imported Thread identity.');
      return {...resource,container:{...resource.container,id,owner:{kind:'workspace' as const,workspaceId:input.targetWorkspaceId}}};
    });
    const anchor=statement.lifetime.anchor;
    if (anchor.owner.kind!=='workspace' || anchor.owner.workspaceId!==input.sourceWorkspaceId || anchor.kind!=='workspace' || anchor.id!==input.sourceWorkspaceId) throw new Error('Unsupported portable Workspace Policy lifetime.');
    return {...statement,scope:{...statement.scope,resources},lifetime:{...statement.lifetime,anchor:{...anchor,id:input.targetWorkspaceId,owner:{kind:'workspace' as const,workspaceId:input.targetWorkspaceId}}}};
  });
  const reminted=parseWorkspacePolicy(input.targetWorkspaceId,{schemaVersion:1,statements});
  return applyEdits(input.content,modify(input.content,['workspace','policy','mediation'],reminted,{}));
}
