---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Native Environment Managed Outside The Sandbox

## Decision

Use the existing Server Agent configuration as the sole authored owner of bounded non-secret native environment overrides and removals, with final verified image Config.Env supplying digest-bound read-only defaults after exact non-secret preparation admission. NanoCore resolves these inputs before compatibility admission into one immutable AEP and delivers the public map separately from Vault credentials through `session.open.nativeEnvironment`. The user views and edits the same revision-checked configuration through NanoCore and the App API, with desired, reloaded and acknowledged applied state distinguished. The trusted sanitized bootstrap retains `env -i` and fixed control bindings; effective child-only changes apply at the next Turn through a fenced successor and exact native resume. Built-in-agent modification through an MCP tool remains pending and is not activated.

## Reason

The engineer asked whether environment variables inside the Sandbox could be exposed outside it so the user can view and change them from NanoCore, with NanoHost or OpenShell recognizing image declarations such as Dockerfile environment settings. The recorded approval was 「我大体认同这个设计的思路和方向。其中细节，你与 consultant 一起来商定。按照这个思路与方向推进。」 (English translation: “I broadly agree with the direction; settle the details with the consultant and proceed.”). The explicit exclusion was 「唯独其中你提到的 assistant 和 coordinator 这类 nanocore 内置的 agents，通过一个 MCP 工具修改 这个细节的设计，这一点本身我们待定，因为我正在重新设计整个。 NanoCore 内置 Agents 的工具系统与工具集。」 (English translation: “Only the part where NanoCore's built-in agents such as the assistant and coordinator modify it through an MCP tool stays pending, because I am redesigning the built-in agents' whole tool system.”).

The settled details avoid conflating public values with the private credential map and credential redaction, resolving image defaults after the compatibility key, automatically publishing arbitrary image bytes that may contain credentials, changing trusted bootstrap through untrusted startup settings, and treating child-only settings as shared Harness identity. Existing configuration, image preparation, package, transport and continuity owners supply the mechanism without another environment database or lifecycle.

The engineer's approval was conditional: 「除非遇到不可克服的技术性的 blocker，或者在审议当中发现不能弥补的设计缺陷。」 (English translation: ‘Unless an insurmountable technical blocker appears, or review discovers an unrepairable design defect.’). The primary and Consultant settled the mechanism details under that delegation. The scoped public-environment wording and the distinction between platform-supplied credentials and user-authored inert Image Store content were later primary instructions, not additional engineer rulings.

## Rejected Alternatives

- Parsing Dockerfile text: final-stage verified OCI Config.Env supplies actual runtime defaults, including inherited and expanded values; Dockerfile ARG and discarded stages do not.
- Per-request, per-Thread or profile override layers: this slice has one Agent-scoped authored map, and task-specific settings use a distinct selected Agent configuration with explicit shared-Agent impact.
- Growing launcher or Harness allowlists or forwarding the host environment: package-specific inheritance remains lossy and host settings cannot become native authority; the admitted map uses the existing session operation after trusted bootstrap.
- Reusing the private `runtimeEnvironment` map for public values: that map owns exact Vault declarations, secret redaction and injection receipts, which ordinary values do not satisfy.
- Mutating a running process in place: native process environment is session-static, so effective changes require next-Turn successor application and exact native resume after predecessor cleanup.

## Revisit When

The built-in-agent tool redesign settles, or a concrete per-Thread environment override need is demonstrated.

## Affected Owners

- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md)
- [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md)
- [AgentSession Continuity](../specs/20260704-agent_session_continuity.md)
- [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Sandbox Model](../core/sandbox.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
