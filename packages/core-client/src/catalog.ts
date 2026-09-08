import {
  type CatalogMutationResponse,
  CatalogMutationResponseSchema,
  type CreateMcpConfigRequest,
  CreateMcpConfigRequestSchema,
  type CreateMcpConfigResponse,
  CreateMcpConfigResponseSchema,
  type DecideSkillCandidateRequest,
  DecideSkillCandidateRequestSchema,
  type GetWorkspaceCatalogResponse,
  GetWorkspaceCatalogResponseSchema,
  type ImportPluginRequest,
  ImportPluginRequestSchema,
  type ImportPluginResponse,
  ImportPluginResponseSchema,
  type ImportSkillRequest,
  ImportSkillRequestSchema,
  type ImportSkillResponse,
  ImportSkillResponseSchema,
  type ListMcpCatalogResponse,
  ListMcpCatalogResponseSchema,
  type ListPluginCatalogResponse,
  ListPluginCatalogResponseSchema,
  type ListSkillCatalogResponse,
  ListSkillCatalogResponseSchema,
  type SelectMcpVersionRequest,
  SelectMcpVersionRequestSchema,
  type SelectSkillVersionRequest,
  SelectSkillVersionRequestSchema,
  type SkillCandidateResponse,
  SkillCandidateResponseSchema,
  type SubmitSkillCandidateRequest,
  SubmitSkillCandidateRequestSchema,
  type UpdateMcpBindingRequest,
  UpdateMcpBindingRequestSchema,
} from '@openkit/app-api-schemas';
import { type OptionalRequestId, withRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Product-facing Workspace Skill, MCP, and Agent Plugin catalog client. */
export interface ResourceCatalogClient {
  /** Reads the Workspace catalog summary. */
  get(workspaceId: string): Promise<GetWorkspaceCatalogResponse>;
  /** Lists Skill catalog entries. */
  listSkills(workspaceId: string): Promise<ListSkillCatalogResponse>;
  /** Imports one Skill tree. */
  importSkill(
    workspaceId: string,
    input: OptionalRequestId<ImportSkillRequest>
  ): Promise<ImportSkillResponse>;
  /** Submits one Skill candidate. */
  submitSkillCandidate(
    workspaceId: string,
    skillId: string,
    input: OptionalRequestId<SubmitSkillCandidateRequest>
  ): Promise<SkillCandidateResponse>;
  /** Promotes, rejects, or withdraws one Skill candidate. */
  decideSkillCandidate(
    workspaceId: string,
    candidateId: string,
    input: OptionalRequestId<DecideSkillCandidateRequest>
  ): Promise<CatalogMutationResponse>;
  /** Selects the current Skill default digest. */
  selectSkillDefault(
    workspaceId: string,
    skillId: string,
    input: OptionalRequestId<SelectSkillVersionRequest>
  ): Promise<CatalogMutationResponse>;
  /** Sets or clears the Workspace pin for one Skill. */
  setSkillPin(
    workspaceId: string,
    skillId: string,
    input: OptionalRequestId<SelectSkillVersionRequest>
  ): Promise<CatalogMutationResponse>;
  /** Lists MCP catalog entries. */
  listMcp(workspaceId: string): Promise<ListMcpCatalogResponse>;
  /** Creates an inactive MCP configuration version. */
  createMcpConfig(
    workspaceId: string,
    input: OptionalRequestId<CreateMcpConfigRequest>
  ): Promise<CreateMcpConfigResponse>;
  /** Selects the current MCP configuration version. */
  selectMcpVersion(
    workspaceId: string,
    mcpId: string,
    input: OptionalRequestId<SelectMcpVersionRequest>
  ): Promise<CatalogMutationResponse>;
  /** Updates MCP enablement, tool policy, and timeout. */
  updateMcpBinding(
    workspaceId: string,
    mcpId: string,
    input: OptionalRequestId<UpdateMcpBindingRequest>
  ): Promise<CatalogMutationResponse>;
  /** Lists Agent Plugin catalog entries. */
  listPlugins(workspaceId: string): Promise<ListPluginCatalogResponse>;
  /** Imports one Agent Plugin package tree. */
  importPlugin(
    workspaceId: string,
    input: OptionalRequestId<ImportPluginRequest>
  ): Promise<ImportPluginResponse>;
}

/**
 * Creates the product-facing Workspace resource catalog client.
 *
 * @param transport Shared Core Client transport.
 * @returns Catalog operations backed directly by their public routes.
 */
export function createResourceCatalogClient(transport: ClientTransport): ResourceCatalogClient {
  return {
    createMcpConfig: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/mcp`,
        CreateMcpConfigRequestSchema.parse(withRequestId(input)),
        CreateMcpConfigResponseSchema
      ),
    decideSkillCandidate: (workspaceId, candidateId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/candidates/${encodeURIComponent(candidateId)}/decide`,
        DecideSkillCandidateRequestSchema.parse(withRequestId(input)),
        CatalogMutationResponseSchema
      ),
    get: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/catalog`,
        GetWorkspaceCatalogResponseSchema
      ),
    importPlugin: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/plugins`,
        ImportPluginRequestSchema.parse(withRequestId(input)),
        ImportPluginResponseSchema
      ),
    importSkill: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/skills`,
        ImportSkillRequestSchema.parse(withRequestId(input)),
        ImportSkillResponseSchema
      ),
    listMcp: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/catalog/mcp`,
        ListMcpCatalogResponseSchema
      ),
    listPlugins: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/catalog/plugins`,
        ListPluginCatalogResponseSchema
      ),
    listSkills: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/catalog/skills`,
        ListSkillCatalogResponseSchema
      ),
    selectMcpVersion: (workspaceId, mcpId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/mcp/${encodeURIComponent(mcpId)}/select`,
        SelectMcpVersionRequestSchema.parse(withRequestId(input)),
        CatalogMutationResponseSchema
      ),
    selectSkillDefault: (workspaceId, skillId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/skills/${encodeURIComponent(skillId)}/select`,
        SelectSkillVersionRequestSchema.parse(withRequestId(input)),
        CatalogMutationResponseSchema
      ),
    setSkillPin: (workspaceId, skillId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/skills/${encodeURIComponent(skillId)}/pin`,
        SelectSkillVersionRequestSchema.parse(withRequestId(input)),
        CatalogMutationResponseSchema
      ),
    submitSkillCandidate: (workspaceId, skillId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/skills/${encodeURIComponent(skillId)}/candidates`,
        SubmitSkillCandidateRequestSchema.parse(withRequestId(input)),
        SkillCandidateResponseSchema
      ),
    updateMcpBinding: (workspaceId, mcpId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/catalog/mcp/${encodeURIComponent(mcpId)}/binding`,
        UpdateMcpBindingRequestSchema.parse(withRequestId(input)),
        CatalogMutationResponseSchema
      ),
  };
}
