---
name: openkit-ops
description: Install, configure, inspect, upgrade and recover OpenKit deployments using an Agent's authorized host tools. Use for prerequisites, NanoCore and Web deployment, provider/model configuration, data-root maintenance, backups, stopped-server access recovery, and diagnosing a deployment that cannot answer. Routine App updates exclude NanoHost maintenance. Use the separate openkit Skill for public product operations.
---

# OpenKit Operations

Resolve references relative to this installed Skill directory. The package is guidance for your existing tools; it supplies no SSH permission, credential, privileged shell, running Agent or NanoHost access.

## Work From The Requested Effect

1. Identify the user's target deployment, requested change and current authority. Reuse existing authorization; ask only for a missing decision or effect permission.
2. Inspect current identity and the smallest relevant state before modifying it. Keep credentials in protected files or established stores, never prompts, command arguments, logs or reports.
3. Load the relevant reference below. Use public NanoCore operations when the service is available; use separately authorized host tools for installation, process replacement and offline recovery.
4. Perform the smallest owned operation, preserving data, credentials and unrelated services. An App update replaces NanoCore and Web; NanoHost maintenance is separate work.
5. Verify the actual result and retain the deciding non-secret evidence. A running container, successful HTTP request or submitted task does not prove completed user work. Unknown outcomes require inspection before retry.

Use the existing `openkit` Skill for its public operation discovery, configuration and durable records. It is a separate installable client, not a required dependency for reading these references or doing host-only recovery. An internal Agent without the required host tools delegates through an authorized capability or reports that capability unavailable; do not add tools or bypass containment to make an instruction executable.

## Load One Reference

- [Getting started](references/getting-started.en.md): choose a release/source installation, establish prerequisites and verify the first real task.
- [Deployment modes](references/nanocore-deployment-modes.en.md): NanoCore local/server modes, App images, initial NanoHost setup, its accepted OpenShell Supervisor/GHCR bootstrap dependency, and stopped-server credential recovery.
- [Configuration](references/nanocore-data-root-config.en.md): authored JSONC scopes, Providers, model metadata, Agent defaults, Vault references and revision-checked reload.
- [Operations](references/nanocore-operations.en.md): inspect health, update the App, prepare and reuse Worker environments, preserve whole execution volumes, back up, diagnose and recover.
- [Product use](references/using-openkit.en.md): delegate bounded work, use human decisions and inspect outputs through Web or the public Skill.
- [Container-dependent tests](references/sandbox-container-tests.en.md): place container effects outside Worker sandboxes.

English references are canonical. Load a corresponding translated reference only when present. Do not load the entire corpus before a task.
