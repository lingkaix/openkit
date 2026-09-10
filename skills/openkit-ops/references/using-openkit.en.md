---
status: Accepted
---
# Using OpenKit

Use Web for ordinary conversation, delegated work, human decisions and outputs. A desktop Agent uses the separate `openkit` Skill to discover and invoke supported public operations; it may have broader public operation coverage than Web. Both operate the same durable product records and current user authority.

Select the intended Workspace and inspect its configured repositories, Agent and model before a source task. Quick conversation is for short assistance; use a Worker task for bounded execution and Goal Mode for planned work requiring coordination. In the current Web composer, the Worker target may be presented as **New Shard + Worker**, which creates a linked execution Thread. Follow that receiving Thread rather than treating submission as completion.

State the outcome, constraints and independently checkable output. For repository engineering, the Worker should read that repository's `AGENTS.md` and accepted owners. Do not turn one repository's engineering workflow into a universal OpenKit rule. A separate review or verification needs an actually separate Agent context examining the relevant artifacts and evidence; an Agent's self-report or a stored verification label does not prove independence.

Inspect progress, human-attention requests and resulting artifacts. Supply reserved user decisions from actual user direction. Review the changed bytes and named check results before accepting work. Product records and source artifacts decide the outcome; telemetry and logs help explain failures but do not replace those records.

Use the public Skill's recovery reference for interrupted or unknown work. Re-read current state before retrying an external effect. Use [operations](nanocore-operations.en.md) when the product itself is unavailable, and [container-dependent tests](sandbox-container-tests.en.md) when a check needs an effect outside the Worker sandbox.

The work, human-attention, Artifact, Knowledge and permission contracts are owned by `docs/core/` and their specifications in the selected source revision. This reference describes usable surfaces and does not declare unimplemented roadmap features complete.
