import { createHash } from 'node:crypto';
import { type NativeOperationDefinition, OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import {
  canonicalIdentifierName,
  type PolicyAgentPrincipalV1,
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
  for (const statement of document.statements) {
    if (statement.state === 'inactive') continue;
    if (statement.kind === 'agent-principal') {
      if (
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.lifetime.uses !== undefined ||
        statement.scope.subjects.length !== 1 ||
        statement.scope.subjects[0]?.kind !== 'agent' ||
        statement.scope.subjects[0].id !== statement.agentId ||
        statement.scope.actions.some((action) => action !== 'tool.use')
      )
        throw new Error(
          'Agent identity requires an explicit human root and its own finite native domain.'
        );
      const anchor = statement.lifetime.anchor;
      const workspaceId = anchor.owner.kind === 'workspace' ? anchor.owner.workspaceId : null;
      if (
        anchor.owner.kind !== 'workspace' ||
        !['workspace', 'turn'].includes(anchor.kind) ||
        (anchor.kind === 'workspace' && anchor.id !== anchor.owner.workspaceId) ||
        statement.scope.resources.some(
          (resource) => resource.kind !== 'mcp-tool' || resource.workspaceId !== workspaceId
        )
      )
        throw new Error('Agent domain requires one exact native Workspace scope.');
      continue;
    }
    // Goal activation is admitted separately against its jointly approved request.
    // Structural admission alone supplies no Goal authority to a consumer.
    if (statement.kind === 'delegation' && statement.purpose === 'goal-domain') {
      const source = statement.source!;
      const anchor = statement.lifetime.anchor;
      if (
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.delegate.kind !== 'agent' ||
        anchor.owner.kind !== 'workspace' ||
        anchor.owner.workspaceId !== source.workspaceId ||
        anchor.kind !== 'goal' ||
        anchor.id !== source.goalId
      )
        throw new Error('Active Goal domain requires its human author and exact Goal anchor.');
      continue;
    }
    if (statement.kind === 'permission' && statement.grant.kind === 'worker-git-read-maintenance') {
      const subject = statement.scope.subjects[0];
      const resource = statement.scope.resources[0];
      const anchor = statement.lifetime.anchor;
      if (
        statement.effect !== 'allow' ||
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.scope.subjects.length !== 1 ||
        subject?.kind !== 'human' ||
        statement.scope.actions.length !== 1 ||
        statement.scope.actions[0] !== 'administration.configuration.apply' ||
        statement.scope.resources.length !== 1 ||
        resource?.kind !== 'container' ||
        resource.container.owner.kind !== 'server' ||
        resource.container.kind !== 'agent' ||
        anchor.owner.kind !== 'server' ||
        anchor.kind !== 'agent' ||
        anchor.id !== resource.container.id ||
        statement.lifetime.uses !== undefined
      )
        throw new Error('Finite maintenance requires its human root and exact Server Agent scope.');
      continue;
    }
    if (statement.kind === 'permission' && statement.grant.kind === 'storage-lease') {
      const anchor = statement.lifetime.anchor;
      const expectedAction =
        statement.grant.mode === 'read-only' ? 'knowledge.read' : 'knowledge.write';
      if (
        statement.effect !== 'allow' ||
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.scope.subjects.some((subject) => subject.kind !== 'human') ||
        statement.scope.actions.some((action) => action !== expectedAction) ||
        statement.scope.resources.some(
          (resource) =>
            resource.kind !== 'container' ||
            policyDigest(resource.container) !== policyDigest(anchor)
        ) ||
        !['server', 'user', 'workspace'].includes(anchor.kind) ||
        anchor.kind !== anchor.owner.kind ||
        (anchor.owner.kind === 'workspace' && anchor.id !== anchor.owner.workspaceId) ||
        (anchor.owner.kind === 'user' && anchor.id !== anchor.owner.userId) ||
        statement.lifetime.uses !== undefined
      )
        throw new Error('Storage lease activation requires a human root and exact owner scope.');
      continue;
    }
    // Other forms stay declarations until their native authority consumer exists.
    if (statement.kind !== 'binding') throw new Error('This Policy form must remain inactive.');
    const definition = OPERATION_REGISTRY[statement.operation as keyof typeof OPERATION_REGISTRY];
    if (!definition || definition.binding !== 'native' || statement.operation !== 'mcp.call-tool')
      throw new Error('Policy binding operation is unavailable.');
    const native: NativeOperationDefinition = definition;
    if (!native.stages.includes(statement.stage) || !native.modes.includes(statement.mode))
      throw new Error('Policy binding stage or mode is unavailable.');
    const stage = { observe: 'completed', advise: 'propose', transform: 'propose', gate: 'decide' };
    if (
      !native.participantKinds.includes(statement.participant.kind) ||
      (statement.participant.kind === 'agent' &&
        (statement.mode !== 'gate' || statement.stage !== 'decide'))
    )
      throw new Error('Agent participation is only available for the I16 deciding gate.');
    if (statement.stage !== stage[statement.mode])
      throw new Error('Policy mode is at the wrong stage.');
    // I16 has no resolvable safe output owner for advice or replacement bodies.
    // Refuse both active and shadow admission before any proposal can be disclosed.
    if (statement.mode === 'transform' || statement.mode === 'advise')
      throw new Error('I16 safe participant output reference is unavailable.');
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
    const position = JSON.stringify([
      statement.operation,
      statement.stage,
      statement.mode,
      statement.order,
    ]);
    if (positions.has(position))
      throw new Error('Active binding order must be explicit and unique.');
    positions.add(position);
  }
  if (document.statements.some((statement) => statement.authority.kind === 'delegation'))
    throw new Error('Delegated Policy authority is unavailable.');
  const agents = document.statements.filter(
    (s): s is PolicyAgentPrincipalV1 => s.kind === 'agent-principal' && s.state === 'active'
  );
  if (new Set(agents.map((s) => s.agentId)).size !== agents.length)
    throw new Error('Active agent identities must be unique.');
  for (const agent of agents) {
    const seen = new Set<string>();
    let current: PolicyAgentPrincipalV1 | undefined = agent;
    while (current) {
      if (seen.has(current.agentId)) throw new Error('Agent responsibility chain is cyclic.');
      seen.add(current.agentId);
      if (current.responsibleHumanId !== agent.responsibleHumanId)
        throw new Error('Agent responsibility chain changes its terminal human.');
      if (current.responsibility.kind === 'human') {
        if (current.responsibility.id !== agent.responsibleHumanId)
          throw new Error('Agent responsibility must end at its declared human.');
        break;
      }
      current = agents.find((s) => s.agentId === current!.responsibility.id);
      if (!current) throw new Error('Agent responsibility chain is unavailable.');
    }
  }
  for (const binding of document.statements) {
    if (
      binding.kind !== 'binding' ||
      binding.state === 'inactive' ||
      binding.participant.kind !== 'agent'
    )
      continue;
    let agent = agents.find((value) => value.agentId === binding.participant.id);
    if (!agent || policyDigest(agent) !== binding.participant.version)
      throw new Error('Agent binding must pin its active declaration.');
    // The chain was checked above; every edge also limits the declared disclosure domain.
    for (;;) {
      if (
        !scopeContains(
          { ...agent.scope, subjects: binding.inputDisclosure.subjects },
          binding.inputDisclosure
        )
      )
        throw new Error('Agent input disclosure exceeds its current declared domain.');
      if (agent.responsibility.kind === 'human') break;
      const next = agents.find((value) => value.agentId === agent!.responsibility.id);
      if (!next) throw new Error('Agent responsibility chain is unavailable.');
      agent = next;
    }
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
      authority: { kind: 'human' as const, userId: input.userId },
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
  // Only references to the same submitted declaration follow native authorship stamping.
  for (const statement of statements) {
    if (
      statement.kind !== 'binding' ||
      statement.participant.kind !== 'agent' ||
      ![...diff.added, ...diff.changed].includes(statement.id)
    )
      continue;
    const source = proposed.statements.find(
      (s) => s.kind === 'agent-principal' && s.agentId === statement.participant.id
    );
    const prepared = statements.find(
      (s) => s.kind === 'agent-principal' && s.agentId === statement.participant.id
    );
    if (source && prepared && statement.participant.version === policyDigest(source))
      statement.participant = { ...statement.participant, version: policyDigest(prepared) };
  }
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
      if (statement.author.kind !== 'human') return false;
      // A required agent gate cannot disappear when its activation author loses authority.
      if (statement.participant.kind !== 'agent' && !input.authorCurrent(statement.author.id))
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

/** Resolves the current accountable agent and its explicit domain through the existing Kernel. */
export function readPolicyAgentPrincipal(input: {
  document: PolicyDocumentV1;
  binding: PolicyBindingV1;
  proposal: PolicyProposal;
  authorCurrent: (userId: string) => boolean;
  anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  now: number;
}): PolicyAgentPrincipalV1 {
  const { binding, proposal } = input;
  if (binding.participant.kind !== 'agent') throw new Error('An agent binding is required.');
  const agents = input.document.statements.filter(
    (s): s is PolicyAgentPrincipalV1 => s.kind === 'agent-principal'
  );
  const root = agents.find((s) => s.agentId === binding.participant.id);
  if (!root || policyDigest(root) !== binding.participant.version)
    throw new Error('The pinned agent declaration is unavailable.');
  const seen = new Set<string>();
  let current = root;
  for (;;) {
    const anchor = current.lifetime.anchor;
    if (
      seen.has(current.agentId) ||
      agents.filter((s) => s.agentId === current.agentId).length !== 1 ||
      current.state !== 'active' ||
      current.responsibleHumanId !== root.responsibleHumanId ||
      current.author.kind !== 'human' ||
      current.authority.kind !== 'human' ||
      current.author.id !== current.authority.userId ||
      !input.authorCurrent(current.author.id) ||
      !input.authorCurrent(root.responsibleHumanId) ||
      current.lifetime.uses !== undefined ||
      (current.lifetime.notAfter && Date.parse(current.lifetime.notAfter) <= input.now) ||
      anchor.owner.kind !== 'workspace' ||
      anchor.owner.workspaceId !== proposal.workspaceId ||
      !['workspace', 'turn'].includes(anchor.kind) ||
      (anchor.kind === 'workspace' && anchor.id !== proposal.workspaceId) ||
      (anchor.kind === 'turn' && anchor.id !== proposal.subject.process?.turnId) ||
      !input.anchorCurrent(anchor)
    )
      throw new Error('Current agent accountability is unavailable.');
    seen.add(current.agentId);
    const resource = {
      kind: 'mcp-tool',
      workspaceId: proposal.workspaceId,
      serverId: proposal.serverId,
      toolName: proposal.toolName,
    };
    const policy: PolicyState = {
      elements: [
        { id: 'agent', kind: 'user' },
        { id: 'domain', kind: 'userAttribute' },
        { id: 'target', kind: 'object' },
        { id: 'resources', kind: 'objectAttribute' },
        { id: 'scope', kind: 'policyClass' },
      ],
      assignments: [
        { child: 'agent', parent: 'domain' },
        { child: 'domain', parent: 'scope' },
        { child: 'target', parent: 'resources' },
        { child: 'resources', parent: 'scope' },
      ],
      operations: [{ id: 'tool.use', accessRights: ['tool.use'] }],
      associations:
        current.scope.subjects.some((s) => s.kind === 'agent' && s.id === current.agentId) &&
        current.scope.resources.some((r) => policyDigest(r) === policyDigest(resource)) &&
        current.scope.actions.includes('tool.use')
          ? [
              {
                id: current.id,
                userAttribute: 'domain',
                targetAttribute: 'resources',
                accessRights: ['tool.use'],
              },
            ]
          : [],
    };
    if (
      evaluateAccess(policy, { user: 'agent', operation: 'tool.use', target: 'target' }).effect !==
      'allow'
    )
      throw new Error('Current agent domain does not cover the proposal.');
    if (current.responsibility.kind === 'human') {
      if (current.responsibility.id !== root.responsibleHumanId)
        throw new Error('Agent terminal human differs.');
      return root;
    }
    const next = agents.find((s) => s.agentId === current.responsibility.id);
    if (!next) throw new Error('Agent responsibility chain is unavailable.');
    current = next;
  }
}
