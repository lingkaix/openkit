# Persistent Live Acceptance

Use this recipe for ordinary L6 and Agent task/benchmark work against an explicitly authorized persistent internal deployment. [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) owns the contract; [L6](../specs/20260529-l6_story_acceptance.md) owns Actor isolation and adjudication. Installation, cold-start, destructive recovery and containment qualification use their own recipes.

## Prepare Once, Observe Each Attempt

Choose the deployment through operator-supplied connection information. Use its normal installation/update procedure and current protected Provider configuration; do not invoke a fixture bring-up or teardown against it. For a source deployment use the existing toolchain and build commands; for the app image follow [Docker App Image](docker-app.md). Record the actual checked-out commit plus dirty state or deployed image digest, not only a version label. Coordinate an upgrade with ongoing work and hold the selected build fixed during the attempt.

Use HTTPS or an explicitly authorized SSH loopback tunnel when remote access otherwise lacks a protected transport. The SSH alias comes from local operator configuration; keep ordinary host-key verification. A typical tunnel shape is `ssh -N -L <local-port>:127.0.0.1:<service-port> <alias>`; resolve the actual service port from the deployment rather than copying a fixture port. The tunnel is an operator tool, not a Skill capability or new service.

Build the current public Skill with `pnpm build:openkit` under the normal repository toolchain, then install the complete `skills/openkit/` artifact into the chosen Agent host. Use [Skill setup](../../skills/openkit/references/setup.md) for the existing endpoint and protected credential mechanism. Do not copy a token into a prompt, shell argument, report or committed file. Refresh the artifact when its public contract changes rather than editing an installed script in place.

Run `scripts/openkit doctor` from the installed Skill. With the appropriate access, discover and read `diagnostics`, `nanohost runtime-target`, and the relevant workspace/worker operations. A reachable API, configured Provider or ready target is a precondition observation, not completed Worker evidence. Do not create a fresh Provider subscription merely to run another attempt.

## Mode One: Work Inside OpenKit

Choose a small real user task with an output that can be checked independently, or a small task set with declared inputs and outcome checks. Create identifiable scenario state through public operations. Submit it through normal Task/Goal Mode to a real Worker; preserve returned Workspace/Thread/Turn ids and follow durable progress through public reads. A request accepted by the scheduler is not a completed workload.

Inspect the actual terminal result and meaningful output, then retrieve only the relevant Artifacts, Evidence, Audit and Usage. Store the report as ordinary evidence or an Artifact. Benchmark reports additionally identify input/check revisions, model/configuration, budget and sample count; do not claim improvement from a single noisy sample. An unavailable Worker remains an unmet mode-one observation, even if an internal chat reply works.

## Mode Two: External Agent Uses The Product

Start a fresh Skill-capable Agent session outside the source checkout with the packaged Skill and secure connection already available. Provide only the user persona and goal; do not provide the story assertions, implementation guidance, expected answer or a fixed sequence of operations. Normal host instructions and public documentation are allowed. Keep engineering SSH tools out of the Actor's product flow; the Agent in a separate authorized operator phase, or another operator, can use them for diagnosis after the attempt.

For L6, select an admitted story under `tests/stories/`, preserve the prompt and relevant redacted observations, and have an independent Judge inspect the story and evidence. The Judge recomputes a deciding public fact. Apply the existing repeated-run admission rule when admitting or materially revising a story. Reuse the same deployment between repetitions; vary only scenario-owned names/inputs where necessary.

## Observe, Repair, Repeat

Use current public records first. Inspect optional telemetry only for the missing diagnostic question; telemetry absence does not override a proved product result. Preserve a collector or judge error and its inputs before correction. Complete retained evidence may be re-adjudicated without rerunning the product; missing observations cannot be reconstructed into a pass.

If authorized SSH diagnosis identifies a repair, record the failure and perform the repair through the existing owner. A product upgrade or state repair starts a new attempt. Reduce a deterministic defect into its lowest sufficient regression rather than repeatedly expanding L6. Leave the deployment, Provider account and unrelated resources in place. Remove only attempt-owned temporary resources, and report cleanup failures separately.

Map the retained observations to the acceptance conditions of each relevant change plan. One run may support several conditions, but a successful deployment or unrelated workload cannot close an untested plan. Keep a short record of build, input/story, times, public ids, observed outcome, deciding evidence and remaining limitations; no new execution database is needed.
