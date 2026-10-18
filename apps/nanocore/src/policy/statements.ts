import { createHash } from 'node:crypto';
import { type NativeOperationDefinition, OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import {
  canonicalIdentifierName,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  type PolicySubjectV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';

/** Safe current proposal identity supplied by the native operation owner. */
export interface PolicyProposal {
  readonly operation: 'mcp.call-tool';
  readonly workspaceId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly catalogRevision: string;
  readonly packageDigest: string;
  /** Null means no exact Turn schema was observed; it does not mean an empty schema. */
  readonly schemaDigest: string | null;
  readonly capabilityCallId: string;
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
}

/** Uses the existing canonical JSON primitive without allocating another identity family. */
export function policyDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalIdentifierName(value)).digest('hex')}`;
}

/** Logical approval identity excludes the execution attempt's existing call identifier. */
export function policyProposalDigest(proposal: PolicyProposal): string {
  const { capabilityCallId: _attempt, ...logical } = proposal;
  return policyDigest(logical);
}

/** Empty Policy still has an exact revision and cannot supply a participant grant. */
export const EMPTY_POLICY_DOCUMENT: PolicyDocumentV1 = { schemaVersion: 1, statements: [] };

/** Checks the native subset before an authored Policy collection can be admitted. */
export function validatePolicyDocument(input: unknown): PolicyDocumentV1 {
  const document = PolicyDocumentV1Schema.parse(input);
  const positions = new Set<string>();
  const principals = new Map<
    string,
    Extract<PolicyDocumentV1['statements'][number], { kind: 'agent-principal' }>
  >();
  for (const statement of document.statements) {
    if (statement.kind === 'agent-principal') {
      if (principals.has(statement.principal.id))
        throw new Error('Duplicate agent principal declaration.');
      principals.set(statement.principal.id, statement);
    }
    if (statement.state === 'inactive') continue;
    // This format cut activates only native human-owned I16 bindings. Other forms
    // remain authored declarations until their current authority consumer exists.
    if (statement.kind !== 'binding') throw new Error('This Policy form must remain inactive.');
    const definition = OPERATION_REGISTRY[statement.operation as keyof typeof OPERATION_REGISTRY];
    if (!definition || definition.binding !== 'native' || statement.operation !== 'mcp.call-tool')
      throw new Error('Policy binding operation is unavailable.');
    const native: NativeOperationDefinition = definition;
    if (!native.stages.includes(statement.stage) || !native.modes.includes(statement.mode))
      throw new Error('Policy binding stage or mode is unavailable.');
    const stage = { observe: 'completed', advise: 'propose', transform: 'propose', gate: 'decide' };
    if (statement.stage !== stage[statement.mode])
      throw new Error('Policy mode is at the wrong stage.');
    // I16 has no retained replacement body owner. Do not claim a completed
    // transformation from a digest-only summary or expose argument bodies.
    if (statement.mode === 'transform')
      throw new Error('I16 replacement ownership is unavailable.');
    if (statement.mode === 'observe' && statement.lifetime.uses !== undefined)
      throw new Error('Finite-use completed observation is unavailable.');
    if (
      statement.author.kind !== 'human' ||
      statement.authority.kind !== 'human' ||
      statement.author.id !== statement.authority.userId
    )
      throw new Error('Active participant authority requires its admitted human author.');
    if (statement.scope.subjects.some((subject) => subject.kind !== 'human'))
      throw new Error('Agent principal authority is not active.');
    const resources = statement.scope.resources;
    const workspaceIds = new Set(
      resources.map((resource) => (resource.kind === 'mcp-tool' ? resource.workspaceId : null))
    );
    const anchor = statement.lifetime.anchor;
    if (
      workspaceIds.size !== 1 ||
      workspaceIds.has(null) ||
      anchor.owner.kind !== 'workspace' ||
      !workspaceIds.has(anchor.owner.workspaceId) ||
      !['workspace', 'turn'].includes(anchor.kind) ||
      (anchor.kind === 'workspace' && anchor.id !== anchor.owner.workspaceId)
    )
      throw new Error(
        'Active binding requires one Workspace transaction owner and a current Workspace or Turn anchor.'
      );
    if (statement.scope.actions.some((action) => action !== 'tool.use'))
      throw new Error('I16 binding requires the existing Tool-use action.');
    if (!scopeContains(statement.scope, statement.inputDisclosure))
      throw new Error('Participant input disclosure exceeds its admitted binding scope.');
    const position = JSON.stringify([statement.point, statement.mode, statement.order]);
    if (positions.has(position))
      throw new Error('Active binding order must be explicit and unique.');
    positions.add(position);
  }
  const byId = new Map(document.statements.map((statement) => [statement.id, statement]));
  for (const statement of document.statements) {
    if (statement.authority.kind !== 'delegation') continue;
    const reference = statement.authority.statement;
    const envelope = byId.get(reference.id);
    if (
      envelope?.kind !== 'delegation' ||
      policyDigest(envelope) !== reference.digest ||
      !scopeContains(envelope.scope, statement.scope)
    )
      throw new Error(
        'Delegated declaration requires its exact enclosing statement and bounded scope.'
      );
  }
  for (const statement of principals.values()) {
    const visited = new Set<string>();
    let responsible = statement.responsiblePrincipal;
    visited.add(statement.principal.id);
    while (responsible.kind === 'agent') {
      if (visited.has(responsible.id))
        throw new Error('Agent responsibility chain must be acyclic.');
      visited.add(responsible.id);
      const parent = principals.get(responsible.id);
      if (!parent)
        throw new Error('Agent responsibility chain has no declared responsible principal.');
      responsible = parent.responsiblePrincipal;
    }
    // Current human/domain authority is checked by native activation/evaluation,
    // not inferred from an inactive declaration or its creator attribution.
  }
  return document;
}

/** Candidate preparation stamps actual native authorship and preserves unchanged versions. */
export function preparePolicyDocument(input: {
  readonly current: PolicyDocumentV1;
  readonly proposed: unknown;
  readonly userId: string;
  readonly now: string;
}): {
  document: PolicyDocumentV1;
  diff: { added: string[]; changed: string[]; removed: string[] };
  classification: 'unchanged' | 'widening';
} {
  const proposed = PolicyDocumentV1Schema.parse(input.proposed);
  const current = new Map(input.current.statements.map((statement) => [statement.id, statement]));
  const diff = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
  const statements = proposed.statements.map((statement) => {
    const previous = current.get(statement.id);
    const { author: _author, authoredAt: _authoredAt, ...content } = statement;
    const oldContent = previous
      ? (({ author: _a, authoredAt: _t, ...rest }) => rest)(previous)
      : null;
    if (previous && policyDigest(content) === policyDigest(oldContent)) return previous;
    (previous ? diff.changed : diff.added).push(statement.id);
    return {
      ...statement,
      author: { kind: 'human' as const, id: input.userId },
      authority:
        statement.state === 'inactive' && statement.authority.kind === 'delegation'
          ? statement.authority
          : { kind: 'human' as const, userId: input.userId },
      authoredAt: input.now,
      ...(statement.kind === 'agent-principal'
        ? {
            creator:
              previous?.kind === 'agent-principal'
                ? previous.creator
                : { kind: 'human' as const, id: input.userId },
          }
        : {}),
    };
  });
  const retained = new Set(statements.map(({ id }) => id));
  diff.removed = input.current.statements.filter(({ id }) => !retained.has(id)).map(({ id }) => id);
  const document = validatePolicyDocument({ schemaVersion: 1, statements });
  // Removing a prohibition can widen authority. Until the automatic review path
  // proves narrowing, every change uses the explicit owning-human confirmation.
  const classification =
    diff.added.length || diff.changed.length || diff.removed.length ? 'widening' : 'unchanged';
  return { document, diff, classification };
}

/** Matches the exact subject and Tool target of the closed schema-independent pilot input. */
export function policyScopeIncludesProposal(
  scope: PolicyBindingV1['scope'],
  proposal: PolicyProposal
): boolean {
  return (
    scope.subjects.some(
      (principal) => policyDigest(principal) === policyDigest(proposal.subject.principal)
    ) &&
    scope.actions.includes('tool.use') &&
    scope.resources.some(
      (resource) =>
        resource.kind === 'mcp-tool' &&
        resource.workspaceId === proposal.workspaceId &&
        resource.serverId === proposal.serverId &&
        resource.toolName === proposal.toolName
    )
  );
}

/** Selects only exact-scope bindings; history or a responsible human supplies no grant. */
export function selectPolicyBindings(input: {
  readonly document: PolicyDocumentV1;
  readonly proposal: PolicyProposal;
  readonly now: number;
  readonly authorCurrent: (authorId: string) => boolean;
  readonly anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
}): PolicyBindingV1[] {
  const { proposal } = input;
  return input.document.statements
    .filter((statement): statement is PolicyBindingV1 => {
      if (
        statement.kind !== 'binding' ||
        statement.state === 'inactive' ||
        statement.operation !== proposal.operation
      )
        return false;
      const lifetime = statement.lifetime;
      const anchor = lifetime.anchor;
      if (
        anchor.owner.kind !== 'workspace' ||
        anchor.owner.workspaceId !== proposal.workspaceId ||
        (anchor.kind === 'turn' && anchor.id !== proposal.subject.process?.turnId) ||
        (anchor.kind === 'workspace' && anchor.id !== proposal.workspaceId)
      )
        return false;
      if (!input.anchorCurrent(anchor)) return false;
      if (lifetime.notAfter && Date.parse(lifetime.notAfter) <= input.now) return false;
      if (statement.author.kind !== 'human' || !input.authorCurrent(statement.author.id))
        return false;
      return policyScopeIncludesProposal(statement.scope, proposal);
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Exact finite selectors make disclosure containment decidable without a wildcard language. */
function scopeContains(
  scope: PolicyBindingV1['scope'],
  disclosure: PolicyBindingV1['inputDisclosure']
): boolean {
  return (['subjects', 'actions', 'resources'] as const).every((key) => {
    const admitted = new Set(scope[key].map((value) => policyDigest(value)));
    return disclosure[key].every((value) => admitted.has(policyDigest(value)));
  });
}
