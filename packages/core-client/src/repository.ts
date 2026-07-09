import {
  type ExecuteGitPushRequest,
  ExecuteGitPushRequestSchema,
  type ExecuteGitPushResponse,
  ExecuteGitPushResponseSchema,
  type GetGitPushRecordResponse,
  GetGitPushRecordResponseSchema,
  type ListGitPushRecordsResponse,
  ListGitPushRecordsResponseSchema,
  type ListWorkspaceRepositoriesResponse,
  ListWorkspaceRepositoriesResponseSchema,
  type RequestGitPushApprovalRequest,
  RequestGitPushApprovalRequestSchema,
  type RequestGitPushApprovalResponse,
  RequestGitPushApprovalResponseSchema,
  type SetWorkspaceRepositoryRequest,
  SetWorkspaceRepositoryRequestSchema,
  type SetWorkspaceRepositoryResponse,
  SetWorkspaceRepositoryResponseSchema,
  type WorkspaceRepositoryDiagnosticsResponse,
  WorkspaceRepositoryDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import type { ClientTransport } from './transport.js';

/** Client for NanoCore workspace repository resource App API routes. */
export interface WorkspaceRepositoryClient {
  /**
   * Lists redacted repository resources for one workspace.
   *
   * @param workspaceId Workspace that owns the resources.
   * @returns Redacted repository resource list and default resource summary.
   */
  list(workspaceId: string): Promise<ListWorkspaceRepositoriesResponse>;
  /**
   * Reads redacted repository diagnostics for one workspace.
   *
   * @param workspaceId Workspace that owns the resources.
   * @returns Repository readiness diagnostics without raw local paths.
   */
  diagnostics(workspaceId: string): Promise<WorkspaceRepositoryDiagnosticsResponse>;
  /**
   * Lists durable Git push records for one workspace.
   *
   * @param workspaceId Workspace that owns the records.
   * @returns Redacted Git push record list.
   */
  listGitPushRecords(workspaceId: string): Promise<ListGitPushRecordsResponse>;
  /**
   * Reads one durable Git push record by id.
   *
   * @param workspaceId Workspace that owns the record.
   * @param pushRecordId Git push record id.
   * @returns Redacted Git push record.
   */
  getGitPushRecord(workspaceId: string, pushRecordId: string): Promise<GetGitPushRecordResponse>;
  /**
   * Opens one approval-gated Git push action for a linked repository.
   *
   * @param workspaceId Workspace that owns the repository.
   * @param resourceId Repository resource id.
   * @param input Redacted Git push approval request payload.
   * @returns Created approval gate and linked policy decision ids.
   */
  requestGitPushApproval(
    workspaceId: string,
    resourceId: string,
    input: RequestGitPushApprovalRequest
  ): Promise<RequestGitPushApprovalResponse>;
  /**
   * Executes one approved Git push for a linked repository.
   *
   * @param workspaceId Workspace that owns the repository.
   * @param resourceId Repository resource id.
   * @param input Approved Git push request payload.
   * @returns Durable Git push record.
   */
  executeGitPush(
    workspaceId: string,
    resourceId: string,
    input: ExecuteGitPushRequest
  ): Promise<ExecuteGitPushResponse>;
  /**
   * Creates or updates the default repository resource for one workspace.
   *
   * @param workspaceId Workspace that owns the default repository resource.
   * @param input Repository display name and local path command payload.
   * @returns Redacted repository resource read model.
   */
  setDefault(
    workspaceId: string,
    input: SetWorkspaceRepositoryRequest
  ): Promise<SetWorkspaceRepositoryResponse>;
}

/** Creates the workspace repository resource App API client. */
export function createWorkspaceRepositoryClient(
  transport: ClientTransport
): WorkspaceRepositoryClient {
  return {
    diagnostics: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/repositories/diagnostics`,
        WorkspaceRepositoryDiagnosticsResponseSchema
      ),
    executeGitPush: (workspaceId, resourceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/repositories/${resourceId}/git-push`,
        ExecuteGitPushRequestSchema.parse(input),
        ExecuteGitPushResponseSchema
      ),
    getGitPushRecord: (workspaceId, pushRecordId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/repositories/git-push-records/${pushRecordId}`,
        GetGitPushRecordResponseSchema
      ),
    listGitPushRecords: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/repositories/git-push-records`,
        ListGitPushRecordsResponseSchema
      ),
    list: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/repositories`,
        ListWorkspaceRepositoriesResponseSchema
      ),
    requestGitPushApproval: (workspaceId, resourceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/repositories/${resourceId}/git-push/approval`,
        RequestGitPushApprovalRequestSchema.parse(input),
        RequestGitPushApprovalResponseSchema
      ),
    setDefault: (workspaceId, input) =>
      transport.putJson(
        `/api/app/workspaces/${workspaceId}/repositories/default`,
        SetWorkspaceRepositoryRequestSchema.parse(input),
        SetWorkspaceRepositoryResponseSchema
      ),
  };
}
