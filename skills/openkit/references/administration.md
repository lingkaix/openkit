# Administration

Load this reference for runtime configuration, access administration, NanoHost execution-host credentials, vault operations, audit, usage, automations, Git administration, backup, export, import, or workspace portability.

## Confirm authority and scope

Identify the deployment, workspace, target resource, requested effect, and acting user before selecting an operation. Use `ops search` and `ops describe` to inspect the operation's mutation status, sensitivity, and required access.

Use existing explicit user direction, or obtain it when absent, before changing runtime configuration, invalidating sessions, revoking access, unlocking or rebinding a vault, changing grants, scheduling an automation, writing to a repository, pushing Git state, exporting data, importing data, restoring data, or creating another external effect.

Invoke one bounded administration operation at a time. Re-read the owning status, audit, usage, repository, automation, vault, or portability record before reporting success.

## Manage shared Workspace access

For owner-directed sharing, list the current members or invitations before creating or revoking an invitation, changing member access, removing a member, or transferring ownership. Pass an invitee email only through stdin, confirm the exact target and expected revision before each mutation, and re-read the owning collection afterward.

The bearer-only CLI intentionally does not expose the current user's own invitation list, invitation acceptance or decline, or Workspace leave. These operations require a canonical session-capable client or implicit local identity; report the known partial and do not bypass it through raw HTTP, cookie persistence, invitation secrets, or another token mechanism.

Use Workspace access recovery or user disable only with explicit deployment-administrator direction. Recovery exposes no Workspace content and supports only the actions described by the selected operation; user disable preserves durable identity and history.

## Protect access and vault material

Pass secret input through stdin or a platform credential mechanism, and keep it out of arguments and agent-visible output. Never request raw provider credentials, vault contents, injection payloads, process handles, or private runtime records through the operation catalog.

For a locked-out or stopped server, use the separately installed `openkit-ops` Skill and its deployment/recovery reference. This public Skill cannot stop NanoCore or run host recovery. After an authorized operator produces a protected recovery envelope, pass the complete envelope directly through stdin to `credential.store`; the operation stores only its token field. Never copy the envelope into conversation or inspect its token.

Use access-token listing or revocation only when required. Do not work around the intentional absence of generic token creation or rotation, and do not overwrite the endpoint administration credential with an unnamed token.

Ask for explicit deployment-administrator direction before enrolling, issuing, rotating, aborting rotation, revoking, or decommissioning NanoHost transport credentials. Those operations write secrets only to the named execution-host slot and return redacted inventory; they do not return raw tokens through the CLI. Re-read the token list after each mutation and do not invent a second delivery path.

Use vault status, bootstrap, unlock, lock, grant, injection-record, use-record, and rebind capabilities only through their public operations. Treat a successful local schema check as neither vault authorization nor evidence that a secret was injected or used.

## Operate runtime and scheduled work

Read current runtime configuration and stale-session state before changing it. Report any restart, stale-session, or reconnect consequence returned by NanoCore without inventing a compatibility or hot-reload guarantee.

Read an automation's current definition and status before creating, changing, or deleting it. Confirm external effects and provider spending separately from schedule configuration.

For retained Worker environments, discover `worker-environment` and describe the exact operation before calling it. Technical preparation, activation and storage maintenance require current deployment-administrator authority plus independent access to the Agent configuration and every affected Workspace and source audience. Listing or selecting an environment is not attachment authority. Preserve the exact prepared candidate, observed revisions and affected group; human activation confirms that complete payload. A stale or unknown result requires status inspection, not a new blind activation. Whole-storage purge is separate from normal Worker close and image replacement.

Preparation and activation are global operations for one exact Server Agent manifest; do not add a Workspace path or profile target. Initial preparation uses `mode: "prepare"`, target `{ "kind": "agent", "agentId": "..." }`, an authored runtime image declaration, and configuration `{ "fileId": "agents/...agent.jsonc", "expectedRevision": "<sha256>" }`. Use `replaceNow` only for immediate replacement of current resident work. Its nonempty `prompt` is the actual successor Turn input and must come from the administrator's words or explicit adoption; never synthesize hidden user speech. Without `replaceNow`, the change applies only to later admissions. Preserve the separate immutable version-1 authored and resolved candidate Artifact references. Result-only recovery uses `mode: "recover"`, a fresh request id, and the exact authored candidate reference; it resolves the original result without rebasing or repeating image effects.

Activation sends the exact resolved candidate, Agent target, configuration revision, affected storage revisions, optional `replaceNow`, and the payload-bound confirmation. Display and review the complete prepared response first. After the human approves that exact payload, copy its `activationConfirmation` preview unchanged into the activation request; the preview is not approval or authorization. A changed field requires a new preparation and review. List, select, status, and purge remain Workspace-scoped.

Use `administration.conversation-submit` for the private built-in administration Assistant. Retain its returned Thread identity for subsequent administration submissions. Ordinary conversation and administration are separate entry paths; the Assistant may inspect and prepare, while activation and purge remain human-confirmed public commands. It never needs an administrator token in its prompt. The separately installed `openkit-ops` Skill explains image changes, whole-volume retention, backups and authorized host recovery without adding host privileges to this client.

## Operate repositories and portable data

Confirm repository identity, branch or target, and the requested Git effect before a write or push. Treat repository diagnostics and approvals as gates, not suggestions.

For backup, export, import, or workspace portability, confirm the source, destination, workspace scope, overwrite behavior, and sensitive-data handling described by the operation. Verify the durable result after completion and report partial, rejected, or recovery-required outcomes without local repair.

Use `workspace.archive-download`, `workspace.archive-import-dry-run`, and `workspace.archive-import` for the supported local-mode portable archive path. Download writes only a new exact destination and never overwrites a file or link; a failed transfer leaves that partial destination for explicit inspection or removal rather than racing pathname cleanup. Dry-run and import read one exact regular non-link source as a one-shot stream, so preserve the original archive and invoke a new operation for each retry.

Use audit and usage reads to explain recorded effects and consumption. Do not treat those projections as permission to repeat an operation or as a substitute for the owning durable record.
