import { createHash } from 'node:crypto';
import {
  type NativeOperationDefinition,
  NON_API_EXPOSURE_DEFINITIONS,
  OPERATION_REGISTRY,
  type OperationDefinition,
} from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import {
  canonicalIdentifierName,
  compareCodeUnits,
  type PolicyAgentPrincipalV1,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  type PolicyPermissionV1Schema,
  type PolicyResourceV1Schema,
  type PolicyStageV1Schema,
  type PolicySubjectV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { SECURITY_CONTAINMENT_LIMITS } from '../storage/core-journal-codecs.js';
import { evaluatePolicyKernel } from './workspace-access.js';

/** Safe current references supplied by each native operation owner, never caller material. */
export interface PolicyProposal {
  readonly operation: string;
  readonly workspaceId: string | null;
  readonly resource: z.infer<typeof PolicyResourceV1Schema>;
  readonly inputReferences: Readonly<Record<string, string | null>>;
  readonly inputAttributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly capabilityCallId: string | null;
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  /** Verified current issuer selectors narrow gates and Tool conditions, never grants or observers. */
  readonly restrictingPrincipals?: readonly PolicyProposal['subject']['principal'][];
}

/** Derives supported points from the same operation definition, without another registry. */
export function policyOperationDefinition(operation: string): {
  readonly policyOperation: NativeOperationDefinition['policyOperation'];
  readonly points: Pick<
    NativeOperationDefinition,
    'stages' | 'modes' | 'participantKinds' | 'gateResults' | 'gateFailures'
  >;
} {
  if (operation === 'mcp.definition.approve')
    return {
      policyOperation: OPERATION_REGISTRY['approval.respond'].policyOperation,
      points: {
        ...policyOperationDefinition('mcp.call-tool').points,
        stages: ['decide'],
        modes: ['gate'],
        participantKinds: ['agent'],
        gateFailures: ['escalate-to-human'],
      },
    };
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

/** Exact User containers select the existing User home; other non-Workspace shapes do not. */
export function policyResourceUser(
  resource: z.infer<typeof PolicyResourceV1Schema>
): string | null {
  if (resource.kind !== 'container') return null;
  const container = resource.container;
  return container.kind === 'user' &&
    container.owner.kind === 'user' &&
    container.id === container.owner.userId
    ? container.owner.userId
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

/** Reserved Server controls activate fixed narrowing templates, never a requesting Agent grant. */
function serverControl(statement: PolicyDocumentV1['statements'][number]): {
  kind: 'route-group-switch' | 'context-preset';
  id: string;
} | null {
  const resources = [...statement.scope.resources];
  if (statement.kind === 'binding') resources.push(...statement.inputDisclosure.resources);
  const kinds = new Set(
    [
      statement.lifetime.anchor,
      ...resources.flatMap((r) => (r.kind === 'container' ? [r.container] : [])),
    ]
      .map((container) => container.kind)
      .filter((kind) => kind === 'route-group-switch' || kind === 'context-preset')
  );
  if (!kinds.size) return null;
  const kind = kinds.has('context-preset') ? 'context-preset' : 'route-group-switch';
  const label = kind === 'context-preset' ? 'Context presets' : 'Route-group switches';
  if (statement.kind !== 'permission')
    throw new Error(`${label} require an ordinary human permission.`);
  const subject = statement.scope.subjects[0];
  const resource = statement.scope.resources[0];
  const anchor = statement.lifetime.anchor;
  if (
    kinds.size !== 1 ||
    !['active', 'inactive'].includes(statement.state) ||
    statement.effect !== (kind === 'context-preset' ? 'allow' : 'prohibit') ||
    statement.grant.kind !== 'ordinary' ||
    statement.author.kind !== 'human' ||
    statement.authority.kind !== 'human' ||
    statement.author.id !== statement.authority.userId ||
    statement.scope.subjects.length !== 1 ||
    subject?.kind !== 'human' ||
    subject.id !== statement.author.id ||
    statement.scope.actions.length !== 1 ||
    statement.scope.actions[0] !== 'workspace.configure' ||
    statement.scope.resources.length !== 1 ||
    resource?.kind !== 'container' ||
    resource.container.owner.kind !== 'server' ||
    resource.container.kind !== kind ||
    anchor.owner.kind !== 'server' ||
    anchor.kind !== 'server' ||
    anchor.id !== 'server' ||
    (kind === 'route-group-switch' && statement.lifetime.notAfter !== undefined) ||
    statement.lifetime.uses !== undefined
  )
    throw new Error(`${label} require exact human Server control scope and lifetime.`);
  const id = resource.container.id;
  if (kind === 'context-preset') {
    if (!['owner-direct', 'workspace-members', 'agent-initiated'].includes(id))
      throw new Error('Context preset is unavailable.');
  } else if (
    ![...Object.values(OPERATION_REGISTRY), ...Object.values(NON_API_EXPOSURE_DEFINITIONS)].some(
      (descriptor) =>
        descriptor.exposure.kind === 'switchable' &&
        descriptor.exposure.owner.length > 0 &&
        descriptor.exposure.group === id
    )
  )
    throw new Error('Route-group switch group is unavailable.');
  return { kind, id };
}

/** The restrict-only Server reviewer has no Turn lifetime or ordinary agent approval authority. */
function isServerSecurityReviewBinding(binding: PolicyBindingV1): boolean {
  const anchor = binding.lifetime.anchor;
  return (
    binding.participant.kind === 'agent' &&
    binding.participant.id === 'security-review' &&
    binding.mode === 'gate' &&
    binding.stage === 'decide' &&
    binding.failure === 'escalate-to-human' &&
    anchor.owner.kind === 'server' &&
    anchor.kind === 'server' &&
    anchor.id === 'server'
  );
}

/** Checks the native subset before an authored Policy collection can be admitted. */
export function validatePolicyDocument(input: unknown): PolicyDocumentV1 {
  const document = PolicyDocumentV1Schema.parse(input);
  const positions = new Set<string>();
  const exposureGroups = new Set<string>();
  const contextPresets = new Set<string>();
  for (const statement of document.statements) {
    const scopes =
      statement.kind === 'binding'
        ? [statement.scope, statement.inputDisclosure]
        : [statement.scope];
    if (
      scopes.some((scope) => scope.subjects.some((subject) => subject.kind === 'process')) &&
      (statement.kind !== 'permission' || statement.effect !== 'prohibit')
    )
      throw new Error('Process selectors are only available for prohibitions.');
    const quarantine = statement.lifetime.anchor.kind === 'quarantine';
    if (
      quarantine &&
      (statement.kind !== 'permission' ||
        statement.effect !== 'prohibit' ||
        statement.grant.kind !== 'ordinary' ||
        statement.lifetime.notAfter !== undefined ||
        statement.lifetime.uses !== undefined)
    )
      throw new Error('Quarantine requires an ordinary prohibition without expiry or uses.');
    if (
      statement.scope.resources.some(
        (resource) =>
          resource.kind === 'container' && resource.container.kind === 'containment-template'
      )
    ) {
      const subject = statement.scope.subjects[0];
      const resource = statement.scope.resources[0];
      const anchor = statement.lifetime.anchor;
      if (
        statement.kind !== 'permission' ||
        statement.effect !== 'allow' ||
        statement.grant.kind !== 'ordinary' ||
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.scope.subjects.length !== 1 ||
        subject?.kind !== 'human' ||
        subject.id !== statement.author.id ||
        statement.scope.actions.length !== 1 ||
        statement.scope.actions[0] !== 'security.containment' ||
        statement.scope.resources.length !== 1 ||
        resource?.kind !== 'container' ||
        resource.container.owner.kind !== 'server' ||
        resource.container.id !== policyDigest(SECURITY_CONTAINMENT_LIMITS) ||
        anchor.owner.kind !== 'server' ||
        anchor.kind !== 'server' ||
        anchor.id !== 'server' ||
        statement.lifetime.uses !== undefined
      )
        throw new Error(
          'Containment requires its exact reviewed human Server permission template.'
        );
      continue;
    }
    const control = serverControl(statement);
    if (control) {
      if (control.kind === 'route-group-switch') {
        if (exposureGroups.has(control.id))
          throw new Error('Duplicate route-group switch control.');
        exposureGroups.add(control.id);
      } else if (statement.state === 'active') {
        if (contextPresets.has(control.id)) throw new Error('Duplicate active context preset.');
        contextPresets.add(control.id);
      }
      continue;
    }
    // The native containment producer validates activation authority. Reading its committed
    // restriction must not depend on a delegation or author that can later be withdrawn.
    if (quarantine || statement.state === 'inactive') continue;
    if (statement.kind === 'agent-principal') {
      if (
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        statement.lifetime.uses !== undefined ||
        statement.scope.subjects.length !== 1 ||
        statement.scope.subjects[0]?.kind !== 'agent' ||
        statement.scope.subjects[0].id !== statement.agentId
      )
        throw new Error(
          'Agent identity requires an explicit human root and its own finite native domain.'
        );
      const anchor = statement.lifetime.anchor;
      const workspaceId = anchor.owner.kind === 'workspace' ? anchor.owner.workspaceId : null;
      const server =
        anchor.owner.kind === 'server' && anchor.kind === 'server' && anchor.id === 'server';
      const workspace =
        anchor.owner.kind === 'workspace' &&
        ['workspace', 'turn'].includes(anchor.kind) &&
        (anchor.kind !== 'workspace' || anchor.id === workspaceId) &&
        statement.scope.actions.every((action) => action === 'tool.use') &&
        statement.scope.resources.every(
          (resource) => resource.kind === 'mcp-tool' && resource.workspaceId === workspaceId
        );
      if (
        !workspace &&
        !(
          server &&
          statement.scope.resources.every(
            (resource) =>
              resource.kind === 'container' &&
              ((resource.container.owner.kind === 'server' &&
                resource.container.kind === 'server' &&
                resource.container.id === 'server') ||
                (statement.agentId === 'security-review' &&
                  (policyResourceWorkspace(resource) !== null ||
                    policyResourceUser(resource) !== null)))
          )
        )
      )
        throw new Error('Agent domain requires one exact native scope.');
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
      statement.effect === 'prohibit' &&
      statement.scope.subjects.some((subject) => subject.kind === 'process')
    ) {
      const anchor = statement.lifetime.anchor;
      const workspaceId = anchor.owner.kind === 'workspace' ? anchor.owner.workspaceId : null;
      if (
        statement.author.kind !== 'human' ||
        statement.authority.kind !== 'human' ||
        statement.author.id !== statement.authority.userId ||
        anchor.owner.kind !== 'workspace' ||
        anchor.kind !== 'workspace' ||
        anchor.id !== anchor.owner.workspaceId ||
        statement.lifetime.uses !== undefined ||
        statement.scope.subjects.some(
          (subject) => subject.kind === 'process' && subject.workspaceId !== workspaceId
        ) ||
        statement.scope.resources.some(
          (resource) => policyResourceWorkspace(resource) !== workspaceId
        )
      )
        throw new Error('Process prohibitions require their exact human-authored Workspace scope.');
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
    const userIds = new Set(resources.map(policyResourceUser));
    const serverReview = isServerSecurityReviewBinding(statement);
    const userOwner =
      userIds.size === 1 &&
      !userIds.has(null) &&
      (serverReview ||
        (anchor.owner.kind === 'user' &&
          userIds.has(anchor.owner.userId) &&
          anchor.kind === 'user' &&
          anchor.id === anchor.owner.userId &&
          statement.participant.kind !== 'agent'));
    const workspaceOwner =
      workspaceIds.size === 1 &&
      !workspaceIds.has(null) &&
      (serverReview ||
        (anchor.owner.kind === 'workspace' &&
          workspaceIds.has(anchor.owner.workspaceId) &&
          ['workspace', 'turn'].includes(anchor.kind) &&
          (anchor.kind !== 'workspace' || anchor.id === anchor.owner.workspaceId)));
    if (!userOwner && !workspaceOwner)
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
        statement.lifetime.anchor.kind !== 'quarantine' &&
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
  proposal: PolicyProposal,
  restrictOnly = false
): boolean {
  return (
    scope.subjects.some(
      (principal) =>
        policyDigest(principal) === policyDigest(proposal.subject.principal) ||
        (restrictOnly &&
          (proposal.restrictingPrincipals ?? []).some(
            (issuer) => policyDigest(principal) === policyDigest(issuer)
          ))
    ) &&
    scope.actions.includes(policyOperationDefinition(proposal.operation).policyOperation) &&
    (proposal.workspaceId === null
      ? policyResourceUser(proposal.resource) !== null
      : policyResourceWorkspace(proposal.resource) === proposal.workspaceId) &&
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
      const userId = policyResourceUser(proposal.resource);
      const serverReview = isServerSecurityReviewBinding(statement);
      if (
        !serverReview &&
        (proposal.workspaceId === null
          ? userId === null ||
            anchor.owner.kind !== 'user' ||
            anchor.owner.userId !== userId ||
            anchor.kind !== 'user' ||
            anchor.id !== userId ||
            statement.participant.kind === 'agent'
          : anchor.owner.kind !== 'workspace' ||
            anchor.owner.workspaceId !== proposal.workspaceId ||
            (anchor.kind === 'turn' && anchor.id !== proposal.subject.process?.turnId) ||
            (anchor.kind === 'workspace' && anchor.id !== proposal.workspaceId))
      )
        return false;
      // The Server itself has no closeable Workspace/Turn anchor. Its exact admitted
      // reviewer still has the binding's expiry, scope and pinned accountability checks.
      if (!serverReview && !input.anchorCurrent(anchor)) return false;
      if (lifetime.notAfter && Date.parse(lifetime.notAfter) <= input.now) return false;
      if (statement.author.kind !== 'human') return false;
      // A required agent gate cannot disappear when its activation author loses authority.
      if (statement.participant.kind !== 'agent' && !input.authorCurrent(statement.author.id))
        return false;
      return policyScopeIncludesProposal(statement.scope, proposal, statement.mode === 'gate');
    })
    .sort((a, b) => a.order - b.order || compareCodeUnits(a.id, b.id));
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
  participant: PolicyBindingV1['participant'];
  proposal: Pick<PolicyProposal, 'subject' | 'workspaceId' | 'resource'>;
  /** Semantic operation supplied by its native metadata/effect owner. */
  operation: string;
  authorCurrent: (userId: string) => boolean;
  anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  now: number;
}): PolicyAgentPrincipalV1 {
  const { participant, proposal } = input;
  if (participant.kind !== 'agent') throw new Error('An agent declaration is required.');
  const agents = input.document.statements.filter(
    (s): s is PolicyAgentPrincipalV1 => s.kind === 'agent-principal'
  );
  const root = agents.find((s) => s.agentId === participant.id);
  if (!root || policyDigest(root) !== participant.version)
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
      !(
        (anchor.owner.kind === 'server' && anchor.kind === 'server' && anchor.id === 'server') ||
        (anchor.owner.kind === 'workspace' &&
          anchor.owner.workspaceId === proposal.workspaceId &&
          ['workspace', 'turn'].includes(anchor.kind) &&
          (anchor.kind !== 'workspace' || anchor.id === proposal.workspaceId) &&
          (anchor.kind !== 'turn' || anchor.id === proposal.subject.process?.turnId))
      ) ||
      !input.anchorCurrent(anchor)
    )
      throw new Error('Current agent accountability is unavailable.');
    seen.add(current.agentId);
    const decision = evaluatePolicyKernel({
      subject: { principal: { kind: 'agent', id: current.agentId }, process: null },
      operation: input.operation,
      resource: proposal.resource,
      domain: { id: current.id, scope: current.scope },
      policy: {
        document: input.document,
        now: input.now,
        authorCurrent: input.authorCurrent,
        anchorCurrent: input.anchorCurrent,
      },
    });
    if (decision.effect !== 'allow')
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

/** Exact, current human-authored Tool conditions; supply and baseline authority remain separate. */
export function selectHumanToolConditions(input: {
  readonly document: PolicyDocumentV1;
  readonly proposal: {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly toolName: string;
    readonly subject: PolicyProposal['subject'];
    readonly restrictingPrincipals?: PolicyProposal['restrictingPrincipals'];
  };
  readonly authorCurrent: (userId: string) => boolean;
  readonly now?: number;
}): z.infer<typeof PolicyPermissionV1Schema>[] {
  const now = input.now ?? Date.now();
  return input.document.statements.filter(
    (statement): statement is z.infer<typeof PolicyPermissionV1Schema> => {
      if (
        statement.kind !== 'permission' ||
        statement.state !== 'active' ||
        statement.grant.kind !== 'ordinary' ||
        statement.authority.kind !== 'human' ||
        statement.author.kind !== 'human' ||
        !['prohibit', 'require_approval'].includes(statement.effect)
      )
        return false;
      const anchor = statement.lifetime.anchor;
      if (
        anchor.owner.kind !== 'workspace' ||
        anchor.owner.workspaceId !== input.proposal.workspaceId ||
        anchor.kind !== 'workspace' ||
        anchor.id !== input.proposal.workspaceId ||
        (statement.lifetime.notAfter && Date.parse(statement.lifetime.notAfter) <= now)
      )
        return false;
      if (
        !statement.scope.subjects.some(
          (subject) =>
            policyDigest(subject) === policyDigest(input.proposal.subject.principal) ||
            (input.proposal.restrictingPrincipals ?? []).some(
              (issuer) => policyDigest(subject) === policyDigest(issuer)
            )
        ) ||
        !statement.scope.actions.includes('tool.use') ||
        !statement.scope.resources.some(
          (resource) =>
            resource.kind === 'mcp-tool' &&
            resource.workspaceId === input.proposal.workspaceId &&
            resource.serverId === input.proposal.serverId &&
            resource.toolName === input.proposal.toolName
        )
      )
        return false;
      // Lost author authority cannot silently turn a mandatory restriction into permission.
      if (!input.authorCurrent(statement.author.id))
        throw new Error('MCP Policy author no longer has current authority.');
      return true;
    }
  );
}
