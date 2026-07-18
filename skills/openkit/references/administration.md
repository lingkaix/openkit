# Administration

Load this reference for runtime configuration, access administration, vault operations, audit, usage, automations, Git administration, backup, export, import, or workspace portability.

## Confirm authority and scope

Identify the deployment, workspace, target resource, requested effect, and acting user before selecting an operation. Use `ops search` and `ops describe` to inspect the operation's mutation status, sensitivity, and required access.

Ask for explicit user direction before changing runtime configuration, invalidating sessions, revoking access, unlocking or rebinding a vault, changing grants, scheduling an automation, writing to a repository, pushing Git state, exporting data, importing data, restoring data, or creating another external effect.

Invoke one bounded administration operation at a time. Re-read the owning status, audit, usage, repository, automation, vault, or portability record before reporting success.

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
