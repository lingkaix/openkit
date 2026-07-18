---
name: openkit
description: Operate OpenKit as an agent helping an end user through its public NanoCore interface. Use for end-user setup, connection diagnostics, workspace and repository operation, Chat Mode, Task Mode, Goal Mode, bounded loop coordination, Action Center decisions, artifacts, evidence, knowledge, recovery, runtime configuration, vault administration, audit, usage, automations, Git operations, backup, export, import, and workspace portability. Do not use for OpenKit source development, repository self-improvement, arbitrary shell or HTTP access, private NanoCore internals, or worker-side capability supply.
---

# OpenKit

Use the bundled `scripts/openkit` executable to operate OpenKit through public NanoCore contracts. Resolve the executable relative to this installed Skill directory; do not require an OpenKit source checkout or package installation.

## Discover and call operations

Use only these command families:

```text
scripts/openkit doctor
scripts/openkit ops search <query>
scripts/openkit ops describe <operation-id>
scripts/openkit ops call <operation-id> --input -
```

Run `doctor` before product work and after connection, authentication, readiness, or compatibility failures.

Search before describing an operation when its identifier is unknown. Describe before calling when its input contract, mutation status, sensitivity, or required access is unknown. Send one strict flat JSON object through stdin for every call; never put secret input in command arguments.

Read the single JSON envelope from stdout and use the exit status to classify the result. Keep stderr as diagnostic output, and never copy credentials or one-time secret material into conversation, logs, artifacts, evidence, or knowledge.

## Respect system authority

Treat NanoCore durable records as authoritative for workflow state, authorization, approvals, idempotency, audit, recovery, scheduling, artifacts, evidence, and worker execution. Treat local validation as input checking, not proof that an action is authorized or accepted.

Perform one bounded operation at a time. Re-read durable state after every mutation before deciding what to do next. Never bypass an approval, review, recovery, or authorization gate.

Present human decisions without resolving them unless the user gives explicit direction. Ask before approvals, rejections, destructive changes, external side effects, provider spending, repository writes, Git publication, deployment, credential changes, or operator actions.

Treat SIGINT and transport abort as stopping only the local wait. Confirm product cancellation, interruption, or completion through an explicit operation and a durable read.

## Follow the default loop

1. Run `doctor` and resolve connection or authentication blockers.
2. Select or create a workspace and inspect its resources.
3. Link or verify required repositories and data sources after the user confirms them.
4. Create or resume a thread.
5. Select Chat Mode for a lightweight answer, Task Mode for one bounded delegated task, or Goal Mode for planned multi-step work.
6. Draft the Goal Mode plan and obtain required human approval before execution.
7. Execute one bounded action or step.
8. Read durable thread state, Action Center, artifacts, evidence, and relevant audit or usage summaries.
9. Present required decisions and resolve them only from explicit user direction.
10. Continue, steer, refine, recover, or stop from durable NanoCore state.

Adapt this sequence to the task, but preserve its authority and safety boundaries.

## Load only the relevant reference

- Load [setup.md](references/setup.md) for first connection, endpoint configuration, credential storage, bootstrap, `doctor`, or connection and authentication diagnosis.
- Load [loop.md](references/loop.md) for workspace work, mode selection, plans, bounded execution, Action Center decisions, artifacts, evidence, review, or completion.
- Load [knowledge.md](references/knowledge.md) for knowledge sources, observations, claims, conflicts, retrieval, context packages, proposals, repair, or knowledge health.
- Load [recovery.md](references/recovery.md) for interrupted or unknown work, retries, checkpoints, restarts, stale state, `recovery_required`, or local aborts.
- Load [administration.md](references/administration.md) for runtime configuration, access administration, vault operations, audit, usage, automations, Git administration, backup, export, import, or workspace portability.
- Load [capability-map.md](references/capability-map.md) when the user intent does not clearly identify a capability group or when an operation cannot be found.

Do not load all references or enumerate the complete operation catalog by default. Let CLI search and description provide the current machine-readable operation contract.
