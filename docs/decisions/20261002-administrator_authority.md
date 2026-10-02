---
status: Accepted
date: "2026-10-02"
decider: Engineer, on the coordinator's recommendation
---
# Administrator Authority

## Decision

The engineer ruled on 2026-10-02 that the deployment administrator may perform every operation.

1. A currently usable administrator credential is eligible for every operation, including operations on other users' resources: recovering a Workspace or other resource another user deleted, reading other users' private Threads and private-derived content, answering approvals raised to other users, archive export and import of any Workspace, and managing the administrator's own access tokens. The administrator's Web session carries the same authority as an administrator bearer token; the authority follows the administrator, not the credential kind.
2. This is one rule in the existing authorizer, not a second permission model. It replaces the scattered exclusions that today keep the administrator from other users' private content, human approvals, Vault-backed effects, deleted-Workspace recovery, deletion without membership, and archive source authority. The Policy Kernel later refines administrator authority with fine-grained policy.
3. Three constraints stay, because they are truthfulness and safety boundaries rather than permission limits. Attribution is truthful: audit and request lineage record the administrator as the responsible actor and never impersonate the affected user, and a recovered resource returns to its original owner rather than becoming the administrator's. Per-effect authority objects, such as approval records and Vault grants, still exist and are checked at execution, but the administrator may create or issue them, so an answered approval records the administrator's decision. Credential limits and the execution environment are unchanged: a read-only credential stays read-only, revocation and expiry apply, and the sandbox boundary applies to every actor.

The Multi-User Workspace specification, the Remote Auth specification, the Workspace Backup, Export and Import specification, the Pending Requests specification (who may read, resolve and withdraw a request, with the actual deciding actor recorded), and Core Permissions and Identity take these rules as their amendments land.

## Reason

Translated from Chinese. The engineer: "I think the admin should be given every operation permission, including restoring resources that other people deleted. This part is indeed sensitive, and later we may make it finer-grained and more secure. For now I consider two points. First, our Policy Kernel is not formally launched or in use, so I do not want to build another permission model and system. Second, consider the product we are designing: a shared workbench for small core teams. Other members of these teams may be non-technical, and only the admin, who is also the owner of this server, takes on all configuration and maintenance. So we should let the admin perform all of these operations conveniently, to better help teammates."

The coordinator agreed and added that a self-hosted administrator can already reach the Data Root and its SQLite files, so restricting the administrator inside the product does not stop a determined administrator and only makes legitimate help harder; truthful attribution keeps the administrator's actions visible to the team. The engineer agreed with every addition, including that "every operation" covers teammates' private Threads and approvals and that the administrator's Web session carries the same authority.

Consequence accepted with the ruling: an administrator credential is a master key for the deployment, so an external agent holding it can perform any operation. Existing protections stay: the operator CLI writes one-time secrets to local secret-safe sinks, and tokens can be revoked, expire, and be issued read-only.

Source: change record 202610020440000000-interface_unification.

## Rejected Alternatives

- Administrator eligibility limited to the administrator's own principal, with other users' resources still requiring that user. Rejected by the engineer as unhelpful for a small team in which the administrator maintains the deployment for non-technical teammates.
- A separate, finer-grained administrator permission model now. Rejected because the Policy Kernel is the intended owner of fine-grained permissions and is not yet in use.
- Administrator authority only through a presented bearer token, with the administrator's Web session treated as an ordinary user. Rejected; the authority follows the administrator.

## Revisit When

- The Policy Kernel implementation lands, which can refine administrator authority with fine-grained policy.
- OpenKit targets deployments in which the administrator is not trusted by the team, such as hosted multi-tenant service.
- Independent agent identities are designed, which may give an agent operating the deployment its own narrower credential.

## Affected Owners

- docs/specs/20260715-multi_user_workspace_system.md
- docs/specs/20260704-remote_auth_credential_bootstrap.md
- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20260930-pending_requests.md
- docs/core/permissions.md
- docs/core/identity.md
