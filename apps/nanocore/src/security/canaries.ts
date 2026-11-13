import { createHash } from 'node:crypto';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';

const SERVER_ID = 'openkit-security';
const TOOL_NAME = 'security_admin_export';

/** Inert release-authored source declarations; they contain no credential or effect path. */
export const SECURITY_CANARY_TOOLS = Object.freeze([
  Object.freeze({
    name: TOOL_NAME,
    description: 'Security-administration decoy. No ordinary task purpose. No useful effect.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      additionalProperties: false,
    }),
  }),
]);
const CATALOG_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(SECURITY_CANARY_TOOLS)).digest('hex')}`;

/**
 * Constructs an explicit selected builtin using the existing immutable AEP source shape.
 * It does not append supply to a package, grant a Tool, or enable observation.
 *
 * @returns A fresh supply selection bound to the exact release-authored Tool declaration.
 */
export function createSecurityCanaryMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: SERVER_ID,
    catalogDigest: CATALOG_DIGEST,
    allowedTools: [TOOL_NAME],
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}

/** Borrowed authenticated selection facts, not a replacement authenticator or durable record. */
export interface BorrowedSecurityCanaryAep {
  readonly snapshotId: string;
  readonly scope: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly agentSessionId: string;
  };
  readonly supply: {
    readonly mcpServers: readonly {
      readonly id: string;
      readonly catalogDigest: string;
      readonly schemaPolicy: string;
      readonly pinnedSchemaSnapshotId: string | null;
    }[];
  };
}

/**
 * Classifies only an exact selected inert call from already authenticated AEP facts.
 * Recognition is independent of Tool grants so a refused direct call remains observable.
 * The real route must still authenticate/revalidate lineage before calling this helper,
 * then refuse before discovery, credentials or upstream. This helper emits no Audit fact.
 *
 * @param aep Borrowed immutable authenticated package selection and execution lineage.
 * @param request Protocol method and trusted route/Tool identity; arguments have no authority.
 * @param state The existing E4 trigger state, borrowed rather than stored or defaulted here.
 * @returns Inert refusal and observation eligibility, never admission or containment authority.
 */
export function classifySecurityCanaryRequest(
  aep: BorrowedSecurityCanaryAep,
  request: {
    readonly method: string;
    readonly serverId: string;
    readonly toolName?: string;
    readonly arguments?: Record<string, unknown>;
  },
  state: 'off' | 'on' | 'stopping'
): { refuse: boolean; observe: boolean } {
  const unrecognized = { refuse: false, observe: false };
  if (
    request.method !== 'tools/call' ||
    request.serverId !== SERVER_ID ||
    request.toolName !== TOOL_NAME
  )
    return unrecognized;
  if (
    ![
      aep.snapshotId,
      aep.scope.workspaceId,
      aep.scope.threadId,
      aep.scope.turnId,
      aep.scope.agentSessionId,
    ].every((value) => typeof value === 'string' && value.trim().length > 0)
  )
    return unrecognized;
  const selected = aep.supply.mcpServers.filter((server) => server.id === SERVER_ID);
  if (
    selected.length !== 1 ||
    selected[0]!.catalogDigest !== CATALOG_DIGEST ||
    selected[0]!.schemaPolicy !== 'pinned' ||
    selected[0]!.pinnedSchemaSnapshotId !== null
  )
    return unrecognized;
  return { refuse: true, observe: state === 'on' };
}
