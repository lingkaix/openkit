import { ToolSchema } from '@modelcontextprotocol/core';
import { Server } from '@modelcontextprotocol/server';
import {
  assertOperationNames,
  type BootReadinessSnapshot,
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  operationMcpEligible,
  operationToolName,
  ReadSkillContentResponseSchema,
  ReadSkillVersionResponseSchema,
} from '@openkit/app-api-schemas';
import { compareCodeUnits, WorkspaceIdSchema } from '@openkit/protocol';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auditAuthenticationFromActor } from './auth/audit-attribution.js';
import type { AuthVariables } from './auth/middleware.js';
import { isUsablePresentedCredential } from './auth/operation-authorizer.js';
import { serveStatelessMcp } from './mcp-stateless-http.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from './operation-composition.js';
import {
  OperationError,
  projectOperationError,
  WORKSPACE_ACCESS_DENIED,
} from './operation-error.js';
import { recordRemoteMcpAudit } from './remote-mcp-audit.js';
import { compactInputContract } from './remote-mcp-input-contract.js';

const SEARCH_LIMIT = 20;
const PROMOTION_LIMIT = 10;
const definitions: Readonly<Record<string, OperationDefinition>> = OPERATION_DEFINITIONS;
const FIXED_IDS = [
  'openkit.search',
  'openkit.describe',
  'openkit.guide',
  'openkit.read',
  'openkit.call',
];
const promoted = Object.entries(definitions).filter(
  ([, definition]) => definition.remoteMcp === 'native'
);
if (promoted.length > PROMOTION_LIMIT) throw new Error('Too many native remote MCP operations.');
assertOperationNames([...FIXED_IDS, ...promoted.map(([id]) => id)]);
const nativeByName = new Map(
  promoted.map(([id, definition]) => {
    const name = operationToolName(id);
    if (FIXED_IDS.includes(id) || !operationMcpEligible(definition)) {
      throw new Error(`Invalid native remote MCP operation: ${id}`);
    }
    return [
      name,
      {
        id,
        tool: {
          name,
          description: definition.description,
          inputSchema: mcpInputSchema(definition.inputSchema),
          annotations: effectAnnotations(definition.mutating),
        },
      },
    ] as const;
  })
);

const querySchema = z
  .object({
    query: z.string().max(500),
    kind: z.enum(['operation', 'skill']).optional(),
    workspaceId: WorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(({ kind, workspaceId }) => workspaceId === undefined || kind === 'skill');
const SKILL_INSTRUCTIONS = 'Search OpenKit Skills before acting.';
const describeSchema = z.object({ operation: z.string() }).strict();
const guideSchema = z.object({}).strict();
const callSchema = z
  .object({ operation: z.string(), input: z.record(z.string(), z.unknown()) })
  .strict();

/** Admits the generated object schema through the SDK's actual Tool contract. */
function mcpInputSchema(schema: z.ZodObject) {
  return ToolSchema.shape.inputSchema.parse(z.toJSONSchema(schema, { io: 'input' }));
}

function effectAnnotations(mutating: boolean) {
  return {
    readOnlyHint: !mutating,
    destructiveHint: mutating,
    ...(mutating ? { idempotentHint: false, openWorldHint: true } : {}),
  };
}

/** Product guidance for plain MCP clients; tool presence and client approval never grant authority. */
const GUIDE = `Search OpenKit Skills before acting: use openkit_search with kind: "skill" and your task terms; include workspaceId if you already know the target Workspace. Pick an authorized entry and call catalog_skill-content-read with its Workspace, Skill id, exact digest and path: "SKILL.md" to see the document and file inventory. Read only needed references using the same tool and digest. Do not install a Skill or execute its scripts. A Skill does not grant permission.

Use a listed native tool when it fits. Otherwise search operations, use the compact input contract, and send the exact id and input to openkit_read for reads or openkit_call for mutations. Use openkit_describe when you need the full contract. Discovery and client approval never grant server authority. If your client supports approval rules, allow only the read tools you intend to trust and ask on mutations. An OpenKit human decision still requires the responsible person's explicit decision on the exact proposal. Remote MCP omits operations that return one-time secrets, require person-only credentials, or use a streaming binding.

NanoCore owns authorization, durable state, approval, idempotency, audit, recovery and execution. Ask the user for each server-required human approval and convey only their explicit decision for the exact proposal and Pending Request identity. A client approval prompt is not an OpenKit human decision. Existing authorization for a bounded action remains valid; do not repeatedly request it. Never answer a secret question or infer approval, spending authority, review acceptance or budget extension.

Follow the product loop: select a Workspace, inspect authorized resources and data sources, select or create a Thread, and read its durable state. Inspect repositories only when a Git source or code host is selected. Use Chat for a lightweight answer, Task for bounded delegated work, or Goal for a continuous outcome with immutable Plan approval and completion acceptance. Describe Goal operations before use; card and intent edits do not steer running workers, and there is no Goal step, pause or resume. Formal Task/Goal Threads use workspace visibility explicitly. Read Action Center, the exact receiving Thread and Turn, artifacts, evidence, audit and usage before reporting completion. Command acceptance and configured Worker health do not prove Worker success. Private audiences and credential limits remain enforced even when operation metadata is visible.

Read durable state after a mutation. A transport failure does not prove that an effect did not happen. Inspect the owner outcome before retrying; reuse the exact requestId only for an exact replay with unchanged input. Never claim cancellation from a disconnected client. Follow long work through bounded reads with a deadline. For recovery_required, stale lineage, denied admission or contradictory evidence, retain the typed refusal and inspect the owning records; do not manufacture receipts, edit storage, silently substitute Worker storage or automatically rerun work. Worker storage selection is an eligibility preview, not attachment or retained work-slot recovery. Preserve exact storage revisions and predecessor work-slot lineage. Administrator-originated Tasks retain the presented credential for later effect revalidation.

Use knowledge discovery for sources, observations, claims, retrieval, context packages, conflicts and proposals. Read provenance and health, preserve contradictory evidence, and request the responsible user's exact decision before accepting, rejecting or reversing proposals. Artifacts and evidence are review inputs; compare their actual content with the user's objective and constraints. Artifact introduction alone starts no work. Restricted Material content remains unavailable to model delivery even for administrators; use the authorized human Web path. App update is discoverable but model delivery remains refused until its owner admits exact approval binding; administrators use Web or the administrator CLI.

Keep credentials and one-time secrets out of conversation, logs, artifacts and knowledge. Token issuance, rotation and bootstrap secret responses are unavailable over MCP. Authorized operators use the openkit-ops administrator CLI with preflighted local secret-safe sinks; bootstrap and offline host recovery need their separate authority. Bytes from streaming-only operations do not enter JSON MCP arguments or results. Host diagnosis, source editing, installation and process replacement use separately authorized host tools, never arbitrary MCP routes or shell calls. Desktop Skill discovery and reads use this MCP surface; Worker-side Skill supply and admission are separate.

For real-use acceptance, reuse the persistent deployment and normal public operations. Keep the user's objective open-ended; do not inspect story answers, seed hidden state, or require a fixed call trajectory. Independently read back meaningful results and distinguish product, environment, tool and insufficient-evidence outcomes. Optional telemetry is diagnostic support. Preserve unknown effects and attempt attribution; a repair or upgrade begins a new attempt. Report actual identifiers, evidence and remaining limitations without closing untested work or user-reserved gates.

Deposit — you did the work here. Select the authorized Workspace and appropriate Thread when the result belongs to one. Create the Material with material_create (material.create), choosing its title, kind and sensitivity. Save the actual text or summary with material.revision-save through openkit_call, using the Material id, exact content, its contentDigest and the current expectedRevisionId (null for a new Material with no revision). Independently read the returned Material and revision ids with material.revision-read through openkit_read and compare content and digest to what you intended to save. Creation alone is not a deposit. If model delivery refuses restricted content, preserve the refusal and use the authorized human Web path; do not downgrade sensitivity or use metadata as proof. For knowledge, discover knowledge.tell and include source/provenance through its contract. For structured records use the target app's admitted Kernel record operations, such as kernel.records.create, and read back the saved record. Do not start a Task just to claim credit for work you did locally. For files, use the existing authenticated streaming App API binding for artifact.import, artifact.version-file-commit or artifact.download as appropriate, not JSON MCP. Use it from your shell only when the same bearer is already available via a supported protected delivery mechanism and the owner admits it; never copy it into prompts, argv or logs. Otherwise use authorized Web file controls (or the administrator CLI if admitted). Verify the resulting Artifact/version; file transfer alone starts no work.

Hand-off — a Workspace Worker should do the work. Select the Workspace and the intended Workspace-visible Thread (discover the existing thread.create if needed). State the bounded objective, constraints and inputs, obtain any exact human decision required, then call task_start (task.start). Keep the submitted requestId plus the returned turn.threadId and turn.id; acceptance is not completion. Later use turn_read on the exact Workspace, Thread and Turn with a bounded polling deadline. Inspect relevant Action Center decisions and the actual output, Artifacts and evidence before reporting success. Report pending, failed or unknown honestly; do not start duplicate work when the outcome is unclear. A disconnected client does not cancel a Task.`;

/** Truthful operation metadata derived from the single definition, never a grant. */
function descriptor(id: string, definition: OperationDefinition) {
  return {
    id,
    description: definition.description,
    stability: definition.stability,
    mutating: definition.mutating,
    credentials: definition.credentials,
    annotations: { readOnlyHint: !definition.mutating, destructiveHint: definition.mutating },
    inputSchema: z.toJSONSchema(definition.inputSchema, { io: 'input' }),
    outputSchema: z.toJSONSchema(definition.outputSchema),
  };
}

/** Tokenizes semantic ids and prose so multiple query terms rank independent of word order. */
function terms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    ),
  ];
}

/** Bounded metadata search over every currently composed definition family. */
function search(query: string) {
  const wanted = terms(query);
  const matches = Object.entries(definitions)
    .filter(
      ([, definition]) => operationMcpEligible(definition) && definition.remoteMcp !== 'native'
    )
    .map(([id, definition]) => {
      const tokens = terms(`${id} ${definition.description}`);
      return {
        id,
        description: definition.description,
        stability: definition.stability,
        mutating: definition.mutating,
        // An exact id must remain reachable even when many descriptions share its terms.
        score:
          id === query.trim().toLowerCase()
            ? wanted.length + 1
            : wanted.filter((term) => tokens.some((token) => token.startsWith(term))).length,
      };
    })
    .filter((entry) => wanted.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));
  return {
    items: matches.slice(0, SEARCH_LIMIT).map(({ score: _score, ...entry }) => ({
      ...entry,
      inputContract: compactInputContract(
        z.toJSONSchema(definitions[entry.id]!.inputSchema, {
          target: 'draft-7',
          io: 'input',
        })
      ),
    })),
    total: matches.length,
    hasMore: matches.length > SEARCH_LIMIT,
  };
}

/** Searches admitted metadata without loading Skill bytes or using an alternate authority. */
async function searchSkills(
  { query, workspaceId }: z.infer<typeof querySchema>,
  invoke: ReturnType<typeof createOperationInvocation>,
  context: Extract<Parameters<ReturnType<typeof createOperationInvocation>>[2], { kind: 'public' }>,
  coreDb: OperationInvocationDependencies['coreDb']
) {
  const scoped = workspaceId !== undefined;
  const { actor, signal } = context;
  const credentialCurrent = () =>
    coreDb !== undefined && isUsablePresentedCredential(coreDb, actor);
  const workspaceIds = scoped
    ? [workspaceId]
    : (await invoke('workspace.list', {}, context)).items
        .map(({ workspace }) => workspace.id)
        .filter((id) =>
          actor.tokenScope === 'workspace' || actor.tokenScope === 'workspace-readonly'
            ? actor.tokenWorkspaceIds?.includes(id)
            : true
        );
  const wanted = terms(query);
  const read = async (id: string) => {
    try {
      const catalog = await invoke('catalog.read', { workspaceId: id }, context);
      return catalog.skills.flatMap((entry) => {
        const digest = entry.pinDigest ?? entry.currentDigest;
        if (
          entry.availability !== 'available' ||
          !digest ||
          !entry.versions.some(
            (version) => version.digest === digest && version.contentState === 'retained'
          )
        )
          return [];
        const tokens = terms(`${entry.id} ${entry.displayName} ${entry.description ?? ''}`);
        const score =
          entry.id === query.trim().toLowerCase()
            ? wanted.length + 1
            : wanted.filter((term) => tokens.some((token) => token.startsWith(term))).length;
        return wanted.length && !score
          ? []
          : [
              {
                workspaceId: id,
                skillId: entry.id,
                name: entry.displayName,
                description: entry.description,
                digest,
                pinDigest: entry.pinDigest,
                score,
              },
            ];
      });
    } catch (error) {
      if (
        !scoped &&
        error instanceof OperationError &&
        error.code === WORKSPACE_ACCESS_DENIED.code &&
        credentialCurrent()
      )
        return [];
      throw error;
    }
  };
  const matches: Awaited<ReturnType<typeof read>> = [];
  const concurrency = 4;
  for (let i = 0; i < workspaceIds.length; i += concurrency) {
    signal?.throwIfAborted();
    const batch = await Promise.all(workspaceIds.slice(i, i + concurrency).map(read));
    for (const rows of batch) matches.push(...rows);
  }
  signal?.throwIfAborted();
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      compareCodeUnits(a.workspaceId, b.workspaceId) ||
      compareCodeUnits(a.skillId, b.skillId)
  );
  // No previously admitted rows may leave a request whose bearer is no longer usable.
  if (!credentialCurrent()) {
    const { code, message, status } = WORKSPACE_ACCESS_DENIED;
    throw new OperationError(code, message, status);
  }
  return {
    items: matches.slice(0, SEARCH_LIMIT).map(({ score: _score, ...row }) => row),
    total: matches.length,
    hasMore: matches.length > SEARCH_LIMIT,
  };
}

/** Registers stateless Streamable HTTP after Token admission, gating mutations on the shared current boot readiness. */
export function registerRemoteMcpRoutes({
  app,
  getBootReadiness,
  exposureAvailable,
  ...dependencies
}: OperationInvocationDependencies & {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly getBootReadiness: () => BootReadinessSnapshot;
  readonly exposureAvailable?: () => boolean;
}): void {
  const assertExposureAvailable = () => {
    if (exposureAvailable && !exposureAvailable())
      throw new OperationError('route_group_unavailable', 'MCP resource is unavailable.', 403);
  };
  app.all('/mcp', async (c) => {
    const actor = c.get('actor');
    if (exposureAvailable && !exposureAvailable()) {
      if (dependencies.coreDb)
        await recordRemoteMcpAudit(dependencies.coreDb, {
          userId: actor.userId,
          ...(actor.tokenId === undefined ? {} : { tokenId: actor.tokenId }),
          authentication: auditAuthenticationFromActor(actor),
          requestId: null,
          outcome: 'denied',
        });
      return c.json(
        { error: { code: 'route_group_unavailable', message: 'MCP resource is unavailable.' } },
        403
      );
    }
    let refused = false;
    let operationId: string | undefined;
    let requestId: string | undefined;
    const server = new Server(
      { name: 'openkit', version: '0.0.0' },
      {
        capabilities: { tools: {} },
        instructions: SKILL_INSTRUCTIONS,
      }
    );
    server.setRequestHandler('tools/list', async () => {
      assertExposureAvailable();
      return {
        tools: [
          {
            name: operationToolName('openkit.search'),
            description: `${SKILL_INSTRUCTIONS} Use kind "skill" for Workspace Skills (prefer workspaceId if known); omit kind for fallback operations. Discovery is not permission.`,
            inputSchema: mcpInputSchema(querySchema),
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: operationToolName('openkit.describe'),
            description:
              'Read one operation contract and its mutation annotations from the definition table.',
            inputSchema: mcpInputSchema(describeSchema),
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: operationToolName('openkit.guide'),
            description: 'Read product workflow, human-decision and recovery guidance.',
            inputSchema: mcpInputSchema(guideSchema),
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: operationToolName('openkit.read'),
            description:
              'Invoke one unpromoted nonmutating operation as the authenticated Token user.',
            inputSchema: mcpInputSchema(callSchema),
            annotations: effectAnnotations(false),
          },
          {
            name: operationToolName('openkit.call'),
            description:
              'Invoke one unpromoted mutating operation as the authenticated Token user. Ask the user for every server-required human decision.',
            inputSchema: mcpInputSchema(callSchema),
            annotations: effectAnnotations(true),
          },
          ...Array.from(nativeByName.values(), ({ tool }) => tool),
        ],
      };
    });
    server.setRequestHandler('tools/call', async (request) => {
      try {
        assertExposureAvailable();
        const args = request.params.arguments ?? {};
        const resolveInvocation = (operation: string, input: Record<string, unknown>) => {
          const definition = definitionFor(operation);
          operationId = operation;
          // Only the canonical id and UUID correlate audit; never record arbitrary tool input.
          requestId = z.uuid().safeParse(input.requestId).data;
          return definition;
        };
        const context = {
          kind: 'public',
          actor,
          delivery: 'model',
          signal: c.req.raw.signal,
          recheckEntry: async () => assertExposureAvailable(),
        } as const;
        const invoke = async (
          operation: string,
          definition: OperationDefinition,
          input: Record<string, unknown>
        ) => {
          if (definition.mutating && !getBootReadiness().acceptingProductWork) {
            throw new OperationError(
              'product_work_unavailable',
              'NanoCore is not accepting product work during the current boot readiness state.',
              503
            );
          }
          return createOperationInvocation(dependencies)(
            operation as JsonOperationId,
            input,
            context
          );
        };
        let result: unknown;
        switch (request.params.name) {
          case 'openkit_search': {
            const query = querySchema.parse(args);
            result =
              query.kind === 'skill'
                ? await searchSkills(
                    query,
                    createOperationInvocation(dependencies),
                    context,
                    dependencies.coreDb
                  )
                : search(query.query);
            break;
          }
          case 'openkit_guide':
            guideSchema.parse(args);
            return { content: [{ type: 'text', text: GUIDE }] };
          case 'openkit_describe': {
            const { operation } = describeSchema.parse(args);
            const definition = definitionFor(operation);
            assertFallback(operation, definition);
            result = descriptor(operation, definition);
            break;
          }
          case 'openkit_read':
          case 'openkit_call': {
            const { operation, input } = callSchema.parse(args);
            const definition = resolveInvocation(operation, input);
            assertFallback(operation, definition);
            if (definition.mutating !== (request.params.name === 'openkit_call')) {
              const correct = definition.mutating ? 'openkit_call' : 'openkit_read';
              throw new OperationError(
                'unsupported_operation',
                `Use ${correct} for this operation.`,
                400
              );
            }
            result = await invoke(operation, definition, input);
            break;
          }
          default: {
            const native = nativeByName.get(request.params.name);
            if (!native) throw new OperationError('unsupported_operation', 'Unknown tool.', 400);
            result = await invoke(native.id, resolveInvocation(native.id, args), args);
            if (native.id === 'catalog.skill-content-read' && args.path === 'SKILL.md') {
              const root = ReadSkillContentResponseSchema.parse(result);
              const { version } = ReadSkillVersionResponseSchema.parse(
                await createOperationInvocation(dependencies)(
                  'catalog.skill-version-read',
                  {
                    workspaceId: args.workspaceId,
                    skillId: args.skillId,
                    digest: args.digest,
                  },
                  context
                )
              );
              if (version.contentState !== 'retained') {
                throw new OperationError(
                  'resource_unavailable',
                  'The exact Skill content is unavailable.',
                  503
                );
              }
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result) },
                  {
                    type: 'text',
                    text: Buffer.from(root.contentBase64, 'base64').toString('utf8'),
                  },
                  {
                    type: 'text',
                    text: JSON.stringify({
                      inventory: version.inventory.filter((entry) => entry.kind === 'file'),
                    }),
                  },
                ],
              };
            }
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        refused = true;
        const result =
          projectOperationError(error) ??
          (error instanceof z.ZodError
            ? { code: 'invalid_request', message: 'Invalid tool input.' }
            : {
                code: 'operation_failed',
                message: 'Operation failed. Inspect the owner outcome before retrying.',
              });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    });
    const response = await serveStatelessMcp(c.req.raw, undefined, () => server);
    if (dependencies.coreDb)
      await recordRemoteMcpAudit(dependencies.coreDb, {
        userId: actor.userId,
        ...(actor.tokenId === undefined ? {} : { tokenId: actor.tokenId }),
        authentication: auditAuthenticationFromActor(actor),
        ...(operationId === undefined ? {} : { operationId }),
        requestId: requestId ?? null,
        outcome: refused ? 'denied' : response.ok ? 'succeeded' : 'failed',
      });
    return response;
  });
}

/** Resolves only the composed tables and refuses excluded contracts before dispatch. */
function definitionFor(id: string) {
  if (!Object.hasOwn(definitions, id))
    throw new OperationError('unsupported_operation', 'Unknown operation.', 400);
  const definition = definitions[id]!;
  if (!operationMcpEligible(definition))
    throw new OperationError(
      definition.returnsOneTimeSecret
        ? 'mcp_secret_returning_operation'
        : definition.binding === 'json'
          ? 'mcp_person_only_operation'
          : 'mcp_streaming_operation',
      definition.returnsOneTimeSecret
        ? 'One-time secret operations are unavailable over MCP.'
        : definition.binding === 'json'
          ? 'Person-only operations require an actual local person or user session, not MCP.'
          : 'Streaming operations are unavailable over MCP. Use Web or the administrator CLI file-transfer interface.',
      400
    );
  return definition;
}

function assertFallback(id: string, definition: OperationDefinition): void {
  if (definition.remoteMcp === 'native') {
    throw new OperationError(
      'unsupported_operation',
      `Use the listed ${operationToolName(id)} tool.`,
      400
    );
  }
}
