import { createHash } from 'node:crypto';
import {
  type NativeOperationDefinition,
  OPERATION_REGISTRY,
  type OperationDefinition,
} from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import {
  canonicalIdentifierName,
  type PolicyAgentPrincipalV1,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  type PolicyResourceV1Schema,
  type PolicyStageV1Schema,
  type PolicySubjectV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';

/** Safe current references supplied by each native operation owner, never caller material. */
export interface PolicyProposal {
  readonly operation: string;
  readonly workspaceId: string;
  readonly resource: z.infer<typeof PolicyResourceV1Schema>;
  readonly inputReferences: Readonly<Record<string, string | null>>;
  readonly inputAttributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly capabilityCallId: string | null;
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
}

/** Derives supported points from the same operation definition, without another registry. */
export function policyOperationDefinition(operation: string): {
  readonly policyOperation: NativeOperationDefinition['policyOperation'];
  readonly points: Pick<
    NativeOperationDefinition,
    'stages' | 'modes' | 'participantKinds' | 'gateResults' | 'gateFailures'
  >;
} {
  if (!Object.hasOwn(OPERATION_REGISTRY, operation))
    throw new Error('Policy operation is unavailable.');
  const definition = (
    OPERATION_REGISTRY as Readonly<Record<string, OperationDefinition | NativeOperationDefinition>>
  )[operation]!;
  const points = definition.binding === 'native' ? definition : definition.insertionPoints;
  if (!points) throw new Error('Policy insertion points are unavailable.');
  return { policyOperation: definition.policyOperation, points };
}

/** The currently supported exact selectors share one Workspace transaction owner. */
export function policyResourceWorkspace(
  resource: z.infer<typeof PolicyResourceV1Schema>
): string | null {
  if (resource.kind === 'mcp-tool') return resource.workspaceId;
  const container = resource.container;
  return container.kind === 'workspace' &&
    container.owner.kind === 'workspace' &&
    container.id === container.owner.workspaceId
    ? container.owner.workspaceId
    : null;
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
    if (
      statement.kind === 'permission' &&
      statement.authority.kind === 'delegation' &&
      statement.grant.kind === 'ordinary'
    ) {
      const anchor = statement.lifetime.anchor;
      const subject = statement.scope.subjects[0];
      const workspaceId = anchor.owner.kind === 'workspace' ? anchor.owner.workspaceId : null;
      if (
        statement.effect !== 'allow' ||
        statement.author.kind !== 'agent' ||
        statement.author.id !== 'goal-coordinator' ||
        statement.scope.subjects.length !== 1 ||
        subject?.kind !== 'agent' ||
        subject.id === statement.author.id ||
        anchor.owner.kind !== 'workspace' ||
        !['goal', 'thread', 'turn'].includes(anchor.kind) ||
        statement.scope.actions.some(
          (action) => !Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, action)
        ) ||
        statement.scope.resources.some((resource) =>
          resource.kind === 'mcp-tool'
            ? resource.workspaceId !== workspaceId
            : resource.container.owner.kind !== 'workspace' ||
              resource.container.owner.workspaceId !== workspaceId
        )
      )
        throw new Error(
          'Delegated Goal permission requires its native Coordinator and Workspace scope.'
        );
      // The native reader checks the exact current root. A withdrawn or replaced
      // root suspends this permission; it must not prevent that root's withdrawal.
      continue;
    }
    if (
      statement.kind === 'permission' &&
      statement.grant.kind === 'ordinary' &&
      statement.authority.kind === 'human'
    ) {
      const anchor = statement.lifetime.anchor;
      const workspaceId = anchor.owner.kind === 'workspace' ? anchor.owner.workspaceId : null;
      if (
        !['prohibit', 'require_approval'].includes(statement.effect) ||
        statement.author.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        anchor.owner.kind !== 'workspace' ||
        anchor.kind !== 'workspace' ||
        anchor.id !== anchor.owner.workspaceId ||
        statement.lifetime.uses !== undefined ||
        statement.scope.actions.some((action) => action !== 'tool.use') ||
        statement.scope.resources.some(
          (resource) => resource.kind !== 'mcp-tool' || resource.workspaceId !== workspaceId
        )
      )
        throw new Error(
          'Human Tool conditions require exact Workspace Tool scope without finite uses.'
        );
      continue;
    }
    // Other forms stay declarations until their native authority consumer exists.
    if (statement.kind !== 'binding') throw new Error('This Policy form must remain inactive.');
    const { points: native, policyOperation } = policyOperationDefinition(statement.operation);
    if (native.modes.length === 0) throw new Error('Policy binding operation is unavailable.');
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
    if (
      native.participantKinds.includes('agent') &&
      statement.scope.subjects.some((subject) => subject.kind !== 'human')
    )
      throw new Error('Agent principal authority is not active.');
    if (
      statement.mode === 'gate' &&
      !native.gateFailures.includes(statement.failure as 'error' | 'escalate-to-human')
    )
      throw new Error('Policy gate failure disposition is unavailable.');
    const resources = statement.scope.resources;
    const workspaceIds = new Set(resources.map(policyResourceWorkspace));
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
    if (statement.scope.actions.some((action) => action !== policyOperation))
      throw new Error('Policy binding requires its registered action.');
    if (!policyScopeContains(statement.scope, statement.inputDisclosure))
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
  if (
    document.statements.some(
      (statement) =>
        statement.authority.kind === 'delegation' &&
        (statement.kind !== 'permission' ||
          statement.grant.kind !== 'ordinary' ||
          statement.author.kind !== 'agent' ||
          statement.author.id !== 'goal-coordinator')
    )
  )
    throw new Error('This delegated Policy form is unavailable.');
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
        !policyScopeContains(
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
  classification: 'unchanged' | 'narrowing' | 'widening';
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
  // Only the author's passive observer reductions prove narrower disclosure.

  const changed = diff.added.length || diff.changed.length || diff.removed.length;
  const narrowing =
    diff.added.length === 0 &&
    diff.removed.every((id) => isNarrowedObservation(current.get(id), undefined, input.userId)) &&
    diff.changed.every((id) =>
      isNarrowedObservation(
        current.get(id),
        document.statements.find((statement) => statement.id === id),
        input.userId
      )
    );
  const classification = !changed ? 'unchanged' : narrowing ? 'narrowing' : 'widening';
  return { document, diff, classification };
}

/** Proves less observation disclosure while keeping participant, author and lifetime authority bounded. */
function isNarrowedObservation(
  before: PolicyDocumentV1['statements'][number] | undefined,
  after: PolicyDocumentV1['statements'][number] | undefined,
  userId: string
): boolean {
  if (
    before?.kind !== 'binding' ||
    before.mode !== 'observe' ||
    before.author.kind !== 'human' ||
    before.author.id !== userId ||
    before.authority.kind !== 'human' ||
    before.authority.userId !== userId
  )
    return false;
  if (!after) return true;
  if (
    after.kind !== 'binding' ||
    after.mode !== 'observe' ||
    after.author.kind !== 'human' ||
    after.author.id !== userId ||
    (after.state !== before.state && after.state !== 'inactive') ||
    before.lifetime.uses !== undefined ||
    after.lifetime.uses !== undefined
  )
    return false;
  const fixedContent = (statement: PolicyBindingV1) => {
    const {
      author: _author,
      authoredAt: _at,
      scope: _scope,
      inputDisclosure: _input,
      lifetime: _lifetime,
      state: _state,
      ...fixed
    } = statement;
    return fixed;
  };
  const expiry = (value: string | undefined) =>
    value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return (
    policyDigest(fixedContent(before)) === policyDigest(fixedContent(after)) &&
    policyDigest(before.lifetime.anchor) === policyDigest(after.lifetime.anchor) &&
    expiry(after.lifetime.notAfter) <= expiry(before.lifetime.notAfter) &&
    policyScopeContains(before.scope, after.scope) &&
    policyScopeContains(before.inputDisclosure, after.inputDisclosure)
  );
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
    scope.actions.includes(policyOperationDefinition(proposal.operation).policyOperation) &&
    policyResourceWorkspace(proposal.resource) === proposal.workspaceId &&
    scope.resources.some((resource) => policyDigest(resource) === policyDigest(proposal.resource))
  );
}

/** Selects only exact-scope bindings; history or a responsible human supplies no grant. */
export function selectPolicyBindings(input: {
  readonly document: PolicyDocumentV1;
  readonly proposal: PolicyProposal;
  readonly stage?: z.infer<typeof PolicyStageV1Schema>;
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
        statement.operation !== proposal.operation ||
        (input.stage !== undefined && statement.stage !== input.stage)
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
export function policyScopeContains(
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
    const resource = proposal.resource;
    const operation = policyOperationDefinition(proposal.operation).policyOperation;
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
      operations: [{ id: operation, accessRights: [operation] }],
      associations:
        current.scope.subjects.some((s) => s.kind === 'agent' && s.id === current.agentId) &&
        current.scope.resources.some((r) => policyDigest(r) === policyDigest(resource)) &&
        current.scope.actions.includes(operation)
          ? [
              {
                id: current.id,
                userAttribute: 'domain',
                targetAttribute: 'resources',
                accessRights: [operation],
              },
            ]
          : [],
    };
    if (evaluateAccess(policy, { user: 'agent', operation, target: 'target' }).effect !== 'allow')
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
