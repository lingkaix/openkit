# Administration

Load this reference for runtime configuration, access administration, vault operations, audit, usage, automations, Git administration, backup, export, import, or workspace portability.

## Confirm authority and scope

Identify the deployment, workspace, target resource, requested effect, and acting user before selecting an operation. Use `ops search` and `ops describe` to inspect the operation's mutation status, sensitivity, and required access.

Ask for explicit user direction before changing runtime configuration, invalidating sessions, revoking access, unlocking or rebinding a vault, changing grants, scheduling an automation, writing to a repository, pushing Git state, exporting data, importing data, restoring data, or creating another external effect.

Invoke one bounded administration operation at a time. Re-read the owning status, audit, usage, repository, automation, vault, or portability record before reporting success.

## Manage shared Workspace access

For owner-directed sharing, list the current members or invitations before creating or revoking an invitation, changing member access, removing a member, or transferring ownership. Pass an invitee email only through stdin, confirm the exact target and expected revision before each mutation, and re-read the owning collection afterward.

The bearer-only CLI intentionally does not expose the current user's own invitation list, invitation acceptance or decline, or Workspace leave. These operations require a canonical session-capable client or implicit local identity; report the known partial and do not bypass it through raw HTTP, cookie persistence, invitation secrets, or another token mechanism.

Use Workspace access recovery or user disable only with explicit deployment-administrator direction. Recovery exposes no Workspace content and supports only the actions described by the selected operation; user disable preserves durable identity and history.

## Protect access and vault material

Pass secret input through stdin or a platform credential mechanism, and keep it out of arguments and agent-visible output. Never request raw provider credentials, vault contents, injection payloads, process handles, or private runtime records through the operation catalog.

Use access-token listing or revocation only when required. Do not work around the intentional absence of generic token creation or rotation, and do not overwrite the endpoint administration credential with an unnamed token.

Use vault status, bootstrap, unlock, lock, grant, injection-record, use-record, and rebind capabilities only through their public operations. Treat a successful local schema check as neither vault authorization nor evidence that a secret was injected or used.

## Operate runtime and scheduled work

Read current runtime configuration and stale-session state before changing it. Report any restart, stale-session, or reconnect consequence returned by NanoCore without inventing a compatibility or hot-reload guarantee.

Read an automation's current definition and status before creating, changing, or deleting it. Confirm external effects and provider spending separately from schedule configuration.

## Operate repositories and portable data

Confirm repository identity, branch or target, and the requested Git effect before a write or push. Treat repository diagnostics and approvals as gates, not suggestions.

For backup, export, import, or workspace portability, confirm the source, destination, workspace scope, overwrite behavior, and sensitive-data handling described by the operation. Verify the durable result after completion and report partial, rejected, or recovery-required outcomes without local repair.

Use audit and usage reads to explain recorded effects and consumption. Do not treat those projections as permission to repeat an operation or as a substitute for the owning durable record.
