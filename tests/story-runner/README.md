# Story Runner

This directory contains deterministic executable adapters for OpenKit L6 story acceptance tests.

The detailed L6 design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

Stories live under `tests/stories/` as versioned Markdown artifacts with scalar front matter.

The default runner uses Playwright for the visible Web UI story. Separate opt-in runners exercise real providers and workers only after explicit quota acknowledgement.

Future runners may add an `executor: agentic` path that lets an AI agent operate the same story contract through Playwright or Chrome DevTools MCP.

Any defect discovered by an L6 story must be reduced into the lowest-layer deterministic regression test that can catch it: L1 unit, L2 contract, L3 NanoCore black-box e2e, L4 Web browser e2e, or L5 smoke.

## How It Works

Deterministic adapters read a story file, validate the front matter, start the required isolated environment, operate the declared product entrypoint, and attach or write a story assertion summary.

The current local stack helper starts built NanoCore with a disposable data root and runs Web against it on a dynamic localhost port.

The story body remains the acceptance contract. The adapter is only the deterministic execution path for stories that are stable enough to automate.

## Commands

Run all deterministic story acceptance checks from the workspace root:

```bash
pnpm -w test:stories
```

Run the explicit deterministic alias:

```bash
pnpm -w test:stories:deterministic
```

Run the Web package story suite directly:

```bash
pnpm --filter @openkit/web e2e:stories
```

Run parser tests only when changing story metadata parsing:

```bash
node --test tests/story-runner/story-metadata.test.mjs
```

Run the real pi-ai provider gateway L6 runner manually:

```bash
pnpm -w test:stories:real-provider
```

That command is skipped by default.

It writes redacted evidence only when `OPENKIT_L6_REAL_PROVIDER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_GATEWAY_BASE_URL`, `OPENKIT_L6_GATEWAY_PROVIDER_ID`, `OPENKIT_L6_GATEWAY_MODEL`, `OPENKIT_L6_GATEWAY_WORKSPACE_ID`, and `OPENKIT_L6_EVIDENCE_DIR` are set.

Run the real OpenShell/Codex Task Mode L6 runner manually:

```bash
pnpm -w test:stories:real-task-mode
```

That command is skipped by default.

It executes only when `OPENKIT_L6_TASK_REAL_WORKER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_TASK_NANOCORE_URL`, `OPENKIT_L6_NANOCORE_DATA_ROOT`, `OPENKIT_L6_TASK_REPO_ROOT`, `OPENKIT_L6_TASK_WORKER_IMAGE_REF`, and `OPENKIT_L6_EVIDENCE_DIR` are set. The runner uses the public Core Client, creates a dedicated acceptance workspace, streams the A1 Codex OAuth file into the server-owned `0600` account slot only when absent, and stops for a strict NanoCore restart before quota use when configuration changes require one. It reuses the small shared real-Codex credential, runtime-config, deadline, evidence-write, and redaction support while keeping Task provenance assertions local. Success writes owner-only result and redaction files; failure writes one exclusive owner-only structured failure file whose controlled assertions remain useful while provider and transport errors are generalized.

Run the A1 NanoCore restart reconnection L6 story manually:

```bash
pnpm --filter @openkit/core-client build
pnpm --filter @openkit/nanocore build
pnpm -w test:stories:a1-restart
```

That command is skipped by default.

It executes only when `OPENKIT_L6_A1_RESTART=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_CONTAINER_BACKEND=openshell`, `OPENKIT_CONTAINER_PLACEMENT=remote`, `OPENKIT_L6_NANOCORE_DATA_ROOT`, and `OPENKIT_L6_TASK_REPO_ROOT` are set. The data root must be fresh and the repository must be disposable. `OPENKIT_L6_A1_RESTART_PORT` selects the fixed local listener and defaults to `4317`; `OPENKIT_L6_A1_RESTART_TASK_INPUT` may replace the bounded default request.

Configure the local NanoCore child with `OPENKIT_WORKER_RUNTIME=container`, the fixed `OPENKIT_OPENSHELL_CELL_SSH_TARGET`, the operator-managed loopback `OPENKIT_OPENSHELL_GATEWAY_URL`, the A1-built `OPENKIT_OPENSHELL_WORKER_IMAGE`, and the sandbox-reachable `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL`. The runner securely streams `a1:/home/ubuntu/.codex/auth.json` into the fresh server-owned OAuth account slot; it does not pass credential content through argv, environment variables, logs, or the worker sandbox. The runner starts one public Task Mode request, uses one read-only durable query to wait for the sequence-zero key hash and `lastWorkerSequence >= 1` post-launch boundary, kills and restarts only the local NanoCore process group with the same data root and port, waits for the public assistant result, then verifies that the same `workerSessionId` reached `cleaned`. It does not parse staged patches, write evidence files, supervise nested children, or use a forked or patched OpenShell artifact.

If the local sandbox cannot bind localhost or launch Chromium, rerun the affected command in a permitted environment before changing product code.

## Files

- `story-metadata.mjs`: scalar front matter parser and metadata validator.
- `story-metadata.test.mjs`: parser and validator tests.
- `real-codex-support.mjs`: shared credential streaming, strict runtime-config, deadline, owner-only evidence, build, and redaction guards used by the surviving real-worker runners.
- `real-codex-support.test.mjs`: focused security, runtime-config, and process-deadline coverage for the shared support.
- `pi-ai-real-provider-runner.mjs`: opt-in real provider gateway L6 runner for public Chat Completions, streaming, capability usage evidence, and redaction checks against an existing NanoCore deployment.
- `pi-ai-real-provider-runner.test.mjs`: skip, opt-in, story metadata, fake gateway, and evidence-file coverage for the real provider runner.
- `task-mode-real-worker-runner.mjs`: opt-in Core Client real OpenShell/Codex Task Mode L6 runner that creates its acceptance workspace and verifies the pinned runtime forest, AEP-bound Gateway attribution, cache routing, cached-token telemetry, one canonical outer result, and public-surface redaction against an existing NanoCore deployment.
- `task-mode-real-worker-runner.test.mjs`: skip, opt-in, prerequisite, critical provenance, cache, telemetry, and leak-guard coverage for the real Task Mode runner.
- `a1-nanocore-restart-runner.mjs`: thin opt-in Core Client runner for one direct local NanoCore kill/restart against a surviving stock remote OpenShell worker.
- `a1-nanocore-restart-runner.test.mjs`: opt-in, configuration, and injected happy-flow coverage for the A1 restart runner.
- `web-stack.mjs`: isolated local NanoCore and Web stack helper.
- `openkit-local-self-check.spec.ts`: deterministic Workspace, Thread, and diagnostics adapter for `tests/stories/openkit-local-self-check.story.md`.
