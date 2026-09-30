---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Public Endpoints By Admitted Grant

## Decision

An administrator-declared credential-free, non-LLM public endpoint, including public MCP, may use an existing exact REST-rule Sandbox network grant carrying the closed `publicAccess: { kind: "credential-free-non-llm" }` marker. NanoCore classifies the composed setup at admission using current authority, authoritative destination associations, excluded Provider/Gateway/control hosts and effective-rule overlap; the existing boundary enforces host, port, binary, method and path. A credential declaration with only an environment-variable or file sink and no destination association does not target the public destination or block the class; ambiguous existing destination metadata refuses it. OpenKit supplies no credential for this route. The class is neither request-content inspection nor secret detection, and user-owned keys elsewhere in a user image do not create platform credential declarations or additional public admission tests. Catalog and built-in MCP, Gateway-held credentials and operations requiring Gateway approval/audit remain mediated, while separately accepted credentialed non-LLM REST grants are unchanged. This decision supersedes only the blanket public-endpoint aspect of the two earlier decisions below.

## Reason

The engineer chose 「精确授权的公开端点可直连」 (English translation: “An exactly granted public endpoint may be reached directly.”) and then 「准入时判定 + 现有精确 grant」 (English translation: “Determined at admission plus the existing exact grant.”) over boundary-enforced request inspection. The user needs ordinary public search/retrieval to work under an explicit grant while preserving platform inference and Gateway credential/approval/audit authority. Admission classification and the existing enforceable tuple satisfy that direction without a request language, credential scanner or new stock backend capability. The primary's destination-metadata correction preserves independently authorized credentials for other destinations rather than inferring destination associations from sink names.

Only the blanket public-endpoint aspect of [Full Permission Inside The Sandbox](20260930-full_permission_inside_the_sandbox.md) and [External Systems Through Vendor MCP](20260929-external_systems_through_vendor_mcp.md) is superseded. Their local-freedom, native prompt refusal, vendor integration and Gateway authority decisions remain applicable. The documentation model has no partial-supersession status or metadata form, so those records remain unchanged as historical decisions; this record states the limited supersession, and current owning documents carry the operative distinction.

The credential-destination settlement and the scoped treatment of user-owned image material are primary instructions under the admitted direction, not additional engineer rulings.

## Rejected Alternatives

- Gateway-only for every external MCP endpoint, the Consultant's earlier recommendation: it would force admission-classified public non-LLM use into a managed integration that the engineer did not choose.
- Boundary-enforced request inspection: the engineer selected admission-time classification and existing exact grants, without header/query/body or MCP tool inspection, a secret detector or a new backend request guard.

## Revisit When

A need for per-request enforcement or audit of public traffic is demonstrated.

## Affected Owners

- [Sandbox Model](../core/sandbox.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
- [Worker Agent Capability](../specs/20260703-worker_agent_capability.md)
- [Container Image Packaging And Release Publishing](../specs/20260708-container_image_packaging.md)
- [Communication Model](../core/communication.md)
- [Agent Supply](../core/agent-supply.md)
- [Permissions Model](../core/permissions.md)
