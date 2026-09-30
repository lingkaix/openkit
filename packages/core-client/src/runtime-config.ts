import {
  type AgentNativeEnvironmentResponse,
  AgentNativeEnvironmentResponseSchema,
  type RuntimeConfigFileListResponse,
  RuntimeConfigFileListResponseSchema,
  type RuntimeConfigFileReadResponse,
  RuntimeConfigFileReadResponseSchema,
  type RuntimeConfigFileWriteRequest,
  RuntimeConfigFileWriteRequestSchema,
  type RuntimeConfigFileWriteResponse,
  RuntimeConfigFileWriteResponseSchema,
  type RuntimeConfigReloadRequest,
  RuntimeConfigReloadRequestSchema,
  type RuntimeConfigReloadResponse,
  RuntimeConfigReloadResponseSchema,
  type RuntimeConfigSchemaCatalogResponse,
  RuntimeConfigSchemaCatalogResponseSchema,
  type RuntimeConfigValidationRequest,
  RuntimeConfigValidationRequestSchema,
  type RuntimeConfigValidationResponse,
  RuntimeConfigValidationResponseSchema,
  type UpdateAgentNativeEnvironmentRequest,
  UpdateAgentNativeEnvironmentRequestSchema,
} from '@openkit/app-api-schemas';
import type { ClientTransport } from './transport.js';

/** Runtime config App API client. */
export interface RuntimeConfigClient {
  /** Views the private Agent configuration and acknowledged native application. */
  getAgentNativeEnvironment(fileId: string): Promise<AgentNativeEnvironmentResponse>;
  /** Uses exact file and image evidence CAS for later-Turn public environment edits. */
  updateAgentNativeEnvironment(
    input: UpdateAgentNativeEnvironmentRequest
  ): Promise<AgentNativeEnvironmentResponse>;
  /** Reloads runtime config. */
  reload(input?: Partial<RuntimeConfigReloadRequest>): Promise<RuntimeConfigReloadResponse>;
  /** Lists runtime config files available to the Settings editor. */
  listFiles(): Promise<RuntimeConfigFileListResponse>;
  /** Reads one runtime config file source by file id. */
  getFile(id: string): Promise<RuntimeConfigFileReadResponse>;
  /** Creates one supported runtime config file from source or a template. */
  createFile(input: RuntimeConfigFileWriteRequest): Promise<RuntimeConfigFileWriteResponse>;
  /** Updates one runtime config file with revision protection. */
  updateFile(input: RuntimeConfigFileWriteRequest): Promise<RuntimeConfigFileWriteResponse>;
  /** Validates draft runtime config source without writing it to disk. */
  validate(input: RuntimeConfigValidationRequest): Promise<RuntimeConfigValidationResponse>;
  /** Reads editor JSON Schema catalog entries for runtime config files. */
  getSchemas(): Promise<RuntimeConfigSchemaCatalogResponse>;
}

/** Creates the runtime config App API client. */
export function createRuntimeConfigClient(transport: ClientTransport): RuntimeConfigClient {
  return {
    getAgentNativeEnvironment: (fileId) =>
      transport.getJson(
        `/api/admin/config/agent-environment?fileId=${encodeURIComponent(fileId)}`,
        AgentNativeEnvironmentResponseSchema
      ),
    updateAgentNativeEnvironment: (input) =>
      transport.putJson(
        '/api/admin/config/agent-environment',
        UpdateAgentNativeEnvironmentRequestSchema.parse(input),
        AgentNativeEnvironmentResponseSchema
      ),
    reload: (input = {}) =>
      transport.postJson(
        '/api/admin/config/reload',
        RuntimeConfigReloadRequestSchema.parse(input),
        RuntimeConfigReloadResponseSchema
      ),
    listFiles: () =>
      transport.getJson('/api/admin/config/files', RuntimeConfigFileListResponseSchema),
    getFile: (id) =>
      transport.getJson(
        `/api/admin/config/file?id=${encodeURIComponent(id)}`,
        RuntimeConfigFileReadResponseSchema
      ),
    createFile: (input) =>
      transport.postJson(
        '/api/admin/config/file',
        RuntimeConfigFileWriteRequestSchema.parse(input),
        RuntimeConfigFileWriteResponseSchema
      ),
    updateFile: (input) =>
      transport.putJson(
        '/api/admin/config/file',
        RuntimeConfigFileWriteRequestSchema.parse(input),
        RuntimeConfigFileWriteResponseSchema
      ),
    validate: (input) =>
      transport.postJson(
        '/api/admin/config/validate',
        RuntimeConfigValidationRequestSchema.parse(input),
        RuntimeConfigValidationResponseSchema
      ),
    getSchemas: () =>
      transport.getJson('/api/admin/config/schemas', RuntimeConfigSchemaCatalogResponseSchema),
  };
}
