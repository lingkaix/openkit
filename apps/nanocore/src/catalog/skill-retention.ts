import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import type { WorkspaceDb } from '../storage/db.js';

/** Reads retained Skill references from the existing Workspace AEP and evidence owners. */
export function retainedWorkspaceSkillReferences(
  workspaceDb: WorkspaceDb,
  input: { readonly workspaceId: string; readonly entryId: string; readonly digest: string }
): readonly string[] {
  const references: string[] = [];
  for (const record of listExportableAgentEnvironmentPackageSnapshots(
    workspaceDb,
    input.workspaceId
  )) {
    if (
      record.snapshot.supply.skills.some(
        (skill) => skill.id === input.entryId && skill.integrity?.sha256 === input.digest
      )
    )
      references.push(`aep:${record.snapshotId}`);
  }
  for (const record of listStoredWorkspaceEvidenceBundles(workspaceDb, input.workspaceId)) {
    if (
      (record.importStatus !== 'expired' || record.retentionClass === 'legal-hold') &&
      record.contentDigests.includes(input.digest)
    )
      references.push(`evidence:${record.id}`);
  }
  return references;
}
