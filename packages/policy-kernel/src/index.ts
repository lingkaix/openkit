/**
 * Supported NGAC policy element kinds.
 */
export type PolicyElementKind =
  | 'user'
  | 'object'
  | 'userAttribute'
  | 'objectAttribute'
  | 'policyClass';

/**
 * Node in the NGAC policy element graph.
 */
export interface PolicyElement {
  /** Stable policy element identifier. */
  id: string;
  /** NGAC policy element kind. */
  kind: PolicyElementKind;
}

/**
 * Directed NGAC assignment relation from contained element to containing element.
 */
export interface PolicyAssignment {
  /** Contained policy element identifier. */
  child: string;
  /** Containing policy element identifier. */
  parent: string;
}

/**
 * NGAC operation with the access rights required to perform it.
 */
export interface PolicyOperation {
  /** Stable operation identifier. */
  id: string;
  /** Access rights required to perform the operation. */
  accessRights: readonly string[];
}

/**
 * NGAC process-to-user mapping.
 */
export interface PolicyProcessUser {
  /** Process identifier. */
  process: string;
  /** User identifier the process operates for. */
  user: string;
}

/**
 * NGAC association relation from a user attribute to a target attribute.
 */
export interface PolicyAssociation {
  /** Stable association identifier used in decision traces. */
  id: string;
  /** User attribute that receives the access right allocation. */
  userAttribute: string;
  /** Access rights allocated by this association. */
  accessRights: readonly string[];
  /** Target attribute in AT = UA union OA. */
  targetAttribute: string;
}

/**
 * Supported NGAC prohibition subject kinds.
 */
export type PolicyProhibitionKind = 'user' | 'process' | 'userAttribute';

/**
 * Supported NGAC prohibition range form.
 */
export type PolicyProhibitionRangeType = 'disjunctive' | 'conjunctive';

/**
 * NGAC prohibition range over inclusion and exclusion attribute sets.
 */
export interface PolicyProhibitionRange {
  /** Whether the inclusion and exclusion sets are interpreted disjunctively or conjunctively. */
  type: PolicyProhibitionRangeType;
  /** Inclusion attribute set. */
  include?: readonly string[];
  /** Exclusion attribute set. */
  exclude?: readonly string[];
}

/**
 * NGAC prohibition relation tuple for user, process, or user-attribute restrictions.
 */
export interface PolicyProhibition {
  /** Stable prohibition identifier used in decision traces. */
  id: string;
  /** Prohibition subject kind. */
  kind: PolicyProhibitionKind;
  /** User, process, or user attribute affected by the prohibition. */
  subject: string;
  /** Access rights denied by this prohibition. */
  accessRights: readonly string[];
  /** Policy element range affected by this prohibition. */
  range: PolicyProhibitionRange;
}

/**
 * Immutable policy facts consumed by the evaluator.
 */
export interface PolicyState {
  /** NGAC policy graph elements. */
  elements: readonly PolicyElement[];
  /** Directed NGAC assignment containment edges. */
  assignments: readonly PolicyAssignment[];
  /** Operations and their required access rights. */
  operations: readonly PolicyOperation[];
  /** Optional process-to-user mappings. */
  processUsers?: readonly PolicyProcessUser[];
  /** Positive authorization associations. */
  associations: readonly PolicyAssociation[];
  /** Optional NGAC prohibitions. */
  prohibitions?: readonly PolicyProhibition[];
}

/**
 * Access request evaluated against policy state.
 */
export interface AccessRequest {
  /** User identifier, or the user resolved from the process. */
  user?: string;
  /** Process identifier when the request is process-mediated. */
  process?: string;
  /** Requested operation. */
  operation: string;
  /** Protected policy element identifier. */
  target: string;
}

/**
 * Stable decision effect.
 */
export type PolicyDecisionEffect = 'allow' | 'deny';

/**
 * Reason explaining why a decision was allowed or denied.
 */
export type PolicyDecisionReason =
  | {
      /** A matching association granted the request. */
      code: 'association-grant';
      /** Matched association identifier. */
      associationId: string;
    }
  | {
      /** No privilege granted a required access right. */
      code: 'missing-privilege';
      /** Required access right that was not granted. */
      accessRight: string;
    }
  | {
      /** A derived restriction denied the request. */
      code: 'restriction';
      /** Matched prohibition identifier. */
      prohibitionId: string;
    }
  | {
      /** The requested operation is not defined in policy state. */
      code: 'missing-operation';
      /** Missing operation identifier. */
      operation: string;
    }
  | {
      /** The policy state is invalid under the implemented NGAC subset. */
      code: 'invalid-policy';
      /** Validation failure message. */
      message: string;
    }
  | {
      /** The access request is not valid for the implemented NGAC subset. */
      code: 'invalid-request';
      /** Validation failure message. */
      message: string;
    };

/**
 * Structural explanation for a policy decision.
 */
export interface PolicyDecisionTrace {
  /** Resolved NGAC user identifier. */
  user?: string;
  /** Request process identifier when present. */
  process?: string;
  /** Access rights required by the operation. */
  requiredAccessRights: readonly string[];
  /** Transitive containment closure for the resolved user. */
  userClosure: readonly string[];
  /** Transitive containment closure for the request target. */
  targetClosure: readonly string[];
  /** Policy classes containing the request target. */
  policyClasses: readonly string[];
  /** Association identifiers that matched the request. */
  matchedAssociations: readonly string[];
  /** Prohibition identifiers that matched the request. */
  matchedProhibitions: readonly string[];
}

/**
 * Result of policy evaluation.
 */
export interface PolicyDecision {
  /** Final allow or deny result. */
  effect: PolicyDecisionEffect;
  /** Machine-readable decision reasons. */
  reasons: readonly PolicyDecisionReason[];
  /** Structural trace for debugging, tests, and redacted audit projection. */
  trace: PolicyDecisionTrace;
}

/**
 * Evaluates a request against NGAC policy facts.
 *
 * @param policy Policy facts to evaluate.
 * @param request Process or user, operation, and target request.
 * @returns Policy decision with a structural trace.
 */
export function evaluateAccess(policy: PolicyState, request: AccessRequest): PolicyDecision {
  const elementsById = indexElements(policy.elements);
  const assignmentParents = indexAssignmentParents(policy.assignments);
  const policyError = validatePolicy(policy, elementsById, assignmentParents);
  if (policyError) {
    return deny([{ code: 'invalid-policy', message: policyError }], emptyTrace(request));
  }

  const operation = policy.operations.find((entry) => entry.id === request.operation);
  if (!operation) {
    return deny([{ code: 'missing-operation', operation: request.operation }], emptyTrace(request));
  }

  const userResult = resolveRequestUser(policy, request, elementsById);
  if (typeof userResult !== 'string') {
    return deny(
      [{ code: 'invalid-request', message: userResult.message }],
      emptyTrace(request, operation.accessRights)
    );
  }

  const target = elementsById.get(request.target);
  if (!target || target.kind === 'policyClass') {
    return deny(
      [{ code: 'invalid-request', message: `Invalid NGAC request target ${request.target}.` }],
      emptyTrace(request, operation.accessRights, userResult)
    );
  }

  const userClosure = computeContainmentClosure(userResult, assignmentParents);
  const targetClosure = computeContainmentClosure(request.target, assignmentParents);
  const policyClasses = [...targetClosure].filter(
    (id) => elementsById.get(id)?.kind === 'policyClass'
  );
  const trace: PolicyDecisionTrace = {
    ...emptyTrace(request, operation.accessRights, userResult),
    userClosure: [...userClosure],
    targetClosure: [...targetClosure],
    policyClasses,
  };

  const matchedAssociations = new Set<string>();
  for (const accessRight of operation.accessRights) {
    for (const policyClass of policyClasses) {
      const association = policy.associations.find((entry) => {
        return grantsAccessRight(
          entry,
          accessRight,
          policyClass,
          userClosure,
          targetClosure,
          assignmentParents
        );
      });
      if (!association) {
        return deny([{ code: 'missing-privilege', accessRight }], {
          ...trace,
          matchedAssociations: [...matchedAssociations],
        });
      }
      matchedAssociations.add(association.id);
    }
  }

  const matchedProhibitions = (policy.prohibitions ?? []).filter((prohibition) => {
    return matchesRestriction(
      prohibition,
      request,
      userResult,
      userClosure,
      request.target,
      operation.accessRights,
      assignmentParents
    );
  });

  const finalTrace: PolicyDecisionTrace = {
    ...trace,
    matchedAssociations: [...matchedAssociations],
    matchedProhibitions: matchedProhibitions.map((prohibition) => prohibition.id),
  };
  const firstProhibition = matchedProhibitions[0];
  if (firstProhibition) {
    return deny([{ code: 'restriction', prohibitionId: firstProhibition.id }], finalTrace);
  }

  const firstAssociation = finalTrace.matchedAssociations[0];
  return {
    effect: 'allow',
    reasons: [{ code: 'association-grant', associationId: firstAssociation ?? '' }],
    trace: finalTrace,
  };
}

/**
 * Creates a deny decision.
 *
 * @param reasons Deny reasons.
 * @param trace Decision trace.
 * @returns Deny decision.
 */
function deny(
  reasons: readonly PolicyDecisionReason[],
  trace: PolicyDecisionTrace
): PolicyDecision {
  return { effect: 'deny', reasons, trace };
}

/**
 * Creates an empty trace.
 *
 * @param request Access request.
 * @param requiredAccessRights Required access rights, when known.
 * @param user Resolved user, when known.
 * @returns Empty decision trace.
 */
function emptyTrace(
  request: AccessRequest,
  requiredAccessRights: readonly string[] = [],
  user?: string
): PolicyDecisionTrace {
  return {
    ...(user ? { user } : {}),
    ...(request.process ? { process: request.process } : {}),
    requiredAccessRights,
    userClosure: [],
    targetClosure: [],
    policyClasses: [],
    matchedAssociations: [],
    matchedProhibitions: [],
  };
}

/**
 * Builds an element id index.
 *
 * @param elements Policy elements.
 * @returns Map from element id to policy element.
 */
function indexElements(elements: readonly PolicyElement[]): ReadonlyMap<string, PolicyElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

/**
 * Builds a child-to-parents index for assignment traversal.
 *
 * @param assignments Directed containment assignments.
 * @returns Map from child element id to parent element ids.
 */
function indexAssignmentParents(
  assignments: readonly PolicyAssignment[]
): ReadonlyMap<string, readonly string[]> {
  const parentsByChild = new Map<string, string[]>();
  for (const assignment of assignments) {
    const parents = parentsByChild.get(assignment.child) ?? [];
    parents.push(assignment.parent);
    parentsByChild.set(assignment.child, parents);
  }
  return parentsByChild;
}

/**
 * Validates policy facts used by the implemented NGAC subset.
 *
 * @param policy Policy facts to validate.
 * @param elementsById Policy elements by id.
 * @param parentsByChild Assignment parent index.
 * @returns Validation message, or undefined when the policy is valid.
 */
function validatePolicy(
  policy: PolicyState,
  elementsById: ReadonlyMap<string, PolicyElement>,
  parentsByChild: ReadonlyMap<string, readonly string[]>
): string | undefined {
  if (elementsById.size !== policy.elements.length) {
    return 'Policy element identifiers must be unique.';
  }
  for (const assignment of policy.assignments) {
    const child = elementsById.get(assignment.child);
    const parent = elementsById.get(assignment.parent);
    if (!child || !parent || !isAllowedAssignment(child.kind, parent.kind)) {
      return `Invalid NGAC assignment ${assignment.child} -> ${assignment.parent}.`;
    }
  }
  if (hasAssignmentCycle(policy.elements, parentsByChild)) {
    return 'NGAC assignment relation must be acyclic.';
  }
  for (const element of policy.elements) {
    if (element.kind === 'policyClass') {
      continue;
    }
    const closure = computeContainmentClosure(element.id, parentsByChild);
    if (![...closure].some((id) => elementsById.get(id)?.kind === 'policyClass')) {
      return `Policy element ${element.id} is not connected to a policy class.`;
    }
  }
  for (const operation of policy.operations) {
    if (operation.accessRights.length === 0) {
      return `Operation ${operation.id} must require at least one access right.`;
    }
  }
  for (const association of policy.associations) {
    if (elementsById.get(association.userAttribute)?.kind !== 'userAttribute') {
      return `Association ${association.id} must start from a user attribute.`;
    }
    if (!isAttributeElement(elementsById.get(association.targetAttribute))) {
      return `Association ${association.id} must target a user or object attribute.`;
    }
    if (association.accessRights.length === 0) {
      return `Association ${association.id} must allocate at least one access right.`;
    }
  }
  for (const processUser of policy.processUsers ?? []) {
    if (elementsById.get(processUser.user)?.kind !== 'user') {
      return `Process ${processUser.process} must map to an NGAC user.`;
    }
  }
  for (const prohibition of policy.prohibitions ?? []) {
    const error = validateProhibition(prohibition, policy, elementsById);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/**
 * Validates one NGAC prohibition tuple.
 *
 * @param prohibition Prohibition to validate.
 * @param policy Policy state.
 * @param elementsById Policy elements by id.
 * @returns Validation message, or undefined when the prohibition is valid.
 */
function validateProhibition(
  prohibition: PolicyProhibition,
  policy: PolicyState,
  elementsById: ReadonlyMap<string, PolicyElement>
): string | undefined {
  if (prohibition.accessRights.length === 0) {
    return `Prohibition ${prohibition.id} must deny at least one access right.`;
  }
  if (prohibition.kind === 'user' && elementsById.get(prohibition.subject)?.kind !== 'user') {
    return `Prohibition ${prohibition.id} must reference an NGAC user.`;
  }
  if (
    prohibition.kind === 'userAttribute' &&
    elementsById.get(prohibition.subject)?.kind !== 'userAttribute'
  ) {
    return `Prohibition ${prohibition.id} must reference an NGAC user attribute.`;
  }
  if (
    prohibition.kind === 'process' &&
    !(policy.processUsers ?? []).some((entry) => entry.process === prohibition.subject)
  ) {
    return `Prohibition ${prohibition.id} must reference a mapped process.`;
  }
  const include = prohibition.range.include ?? [];
  const exclude = prohibition.range.exclude ?? [];
  if (include.length === 0 && exclude.length === 0) {
    return `Prohibition ${prohibition.id} must define a non-empty range.`;
  }
  for (const attribute of [...include, ...exclude]) {
    if (!isAttributeElement(elementsById.get(attribute))) {
      return `Prohibition ${prohibition.id} range must reference only NGAC attributes.`;
    }
  }
  return undefined;
}

/**
 * Checks if an assignment pair is legal in the implemented NGAC subset.
 *
 * @param child Child element kind.
 * @param parent Parent element kind.
 * @returns True when the assignment pair is valid.
 */
function isAllowedAssignment(child: PolicyElementKind, parent: PolicyElementKind): boolean {
  if (child === 'user') {
    return parent === 'userAttribute';
  }
  if (child === 'userAttribute') {
    return parent === 'userAttribute' || parent === 'policyClass';
  }
  if (child === 'object' || child === 'objectAttribute') {
    return parent === 'objectAttribute' || parent === 'policyClass';
  }
  return false;
}

/**
 * Checks whether an element can serve as an NGAC attribute relation term.
 *
 * @param element Policy element.
 * @returns True for user attributes and object attributes, including objects.
 */
function isAttributeElement(element: PolicyElement | undefined): boolean {
  return (
    element?.kind === 'userAttribute' ||
    element?.kind === 'objectAttribute' ||
    element?.kind === 'object'
  );
}

/**
 * Detects cycles in the assignment graph.
 *
 * @param elements Policy elements.
 * @param parentsByChild Assignment parent index.
 * @returns True when a cycle exists.
 */
function hasAssignmentCycle(
  elements: readonly PolicyElement[],
  parentsByChild: ReadonlyMap<string, readonly string[]>
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const parent of parentsByChild.get(id) ?? []) {
      if (visit(parent)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return elements.some((element) => visit(element.id));
}

/**
 * Resolves the NGAC user for an access request.
 *
 * @param policy Policy facts.
 * @param request Access request.
 * @param elementsById Policy elements by id.
 * @returns Resolved user id, or a validation failure.
 */
function resolveRequestUser(
  policy: PolicyState,
  request: AccessRequest,
  elementsById: ReadonlyMap<string, PolicyElement>
): string | { message: string } {
  const mappedUser = request.process
    ? (policy.processUsers ?? []).find((entry) => entry.process === request.process)?.user
    : undefined;
  const user = request.user ?? mappedUser;
  if (!user || elementsById.get(user)?.kind !== 'user') {
    return { message: 'Access request must resolve to an NGAC user.' };
  }
  if (request.user && mappedUser && request.user !== mappedUser) {
    return { message: `Process ${request.process} is not mapped to user ${request.user}.` };
  }
  return user;
}

/**
 * Checks whether an association grants one access right under a policy class.
 *
 * @param association Association to test.
 * @param accessRight Required access right.
 * @param policyClass Policy class containing the target.
 * @param userClosure Resolved user containment closure.
 * @param targetClosure Target containment closure.
 * @param parentsByChild Assignment parent index.
 * @returns True when the association derives the requested privilege.
 */
function grantsAccessRight(
  association: PolicyAssociation,
  accessRight: string,
  policyClass: string,
  userClosure: ReadonlySet<string>,
  targetClosure: ReadonlySet<string>,
  parentsByChild: ReadonlyMap<string, readonly string[]>
): boolean {
  return (
    userClosure.has(association.userAttribute) &&
    targetClosure.has(association.targetAttribute) &&
    computeContainmentClosure(association.targetAttribute, parentsByChild).has(policyClass) &&
    association.accessRights.includes(accessRight)
  );
}

/**
 * Checks whether a prohibition derives a matching restriction.
 *
 * @param prohibition Prohibition to test.
 * @param request Access request.
 * @param user Resolved user identifier.
 * @param userClosure Resolved user containment closure.
 * @param target Target policy element.
 * @param requiredAccessRights Required access rights.
 * @param parentsByChild Assignment parent index.
 * @returns True when the prohibition restricts the request.
 */
function matchesRestriction(
  prohibition: PolicyProhibition,
  request: AccessRequest,
  user: string,
  userClosure: ReadonlySet<string>,
  target: string,
  requiredAccessRights: readonly string[],
  parentsByChild: ReadonlyMap<string, readonly string[]>
): boolean {
  const subjectMatches =
    (prohibition.kind === 'user' && prohibition.subject === user) ||
    (prohibition.kind === 'process' && prohibition.subject === request.process) ||
    (prohibition.kind === 'userAttribute' && userClosure.has(prohibition.subject));
  return (
    subjectMatches &&
    requiredAccessRights.some((accessRight) => prohibition.accessRights.includes(accessRight)) &&
    targetInRange(target, prohibition.range, parentsByChild)
  );
}

/**
 * Checks whether a target lies in a prohibition range.
 *
 * @param target Target policy element.
 * @param range Prohibition range.
 * @param parentsByChild Assignment parent index.
 * @returns True when the target is in range.
 */
function targetInRange(
  target: string,
  range: PolicyProhibitionRange,
  parentsByChild: ReadonlyMap<string, readonly string[]>
): boolean {
  const include = range.include ?? [];
  const exclude = range.exclude ?? [];
  const targetClosure = computeContainmentClosure(target, parentsByChild);
  const isContainedBy = (attribute: string) => targetClosure.has(attribute);
  if (range.type === 'disjunctive') {
    return include.some(isContainedBy) || exclude.some((attribute) => !isContainedBy(attribute));
  }
  return include.every(isContainedBy) && exclude.every((attribute) => !isContainedBy(attribute));
}

/**
 * Computes transitive containment closure from an element to all parents.
 *
 * @param start Element identifier to start from.
 * @param parentsByChild Child-to-parents assignment index.
 * @returns Set containing the start element and all reachable parents.
 */
function computeContainmentClosure(
  start: string,
  parentsByChild: ReadonlyMap<string, readonly string[]>
): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [start];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || closure.has(current)) {
      continue;
    }
    closure.add(current);
    for (const parent of parentsByChild.get(current) ?? []) {
      pending.push(parent);
    }
  }

  return closure;
}
