---
status: ready
type: change-plan
---
# Worker Repository Push: Issue 84

## Intent Epoch 1

The engineer requested investigation and a focused fix for GitHub #84 in `/workspace/openkit`, followed by one PR targeting main, green CI, independent Codex review, merge, and issue closure. Worker-side repository publication must succeed or expose a real approval Gate. Persistent A2 configuration, registered user machines, secrets, and issues #71/#85 remain outside the slice. Herdr owns worker orchestration and spent panes must be closed.

## Intent Epoch 2

The engineer authorized Codex implementation and separate Codex review after Cursor rejected its authentication and Grok startup. The engineer then expressly approved the proposed narrow worker repository capability: selected tools over the existing authenticated relay, host-side Git/Vault/policy checks, coordinated human Gates, and auto-allow that keeps the worker running. Commits must already be in the host-linked checkout through the existing review/apply flow; live commit synchronization remains outside #84.

## Accepted Direction And Owners

The worker capability and selected MCP owners are `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260704-worker_mcp_tool_supply.md`. `docs/specs/20260704-git_write_workflow.md` owns publication, target authority and push recovery. The public Skill remains an external App API client; workers use the selected capability rather than a general App API tunnel or injected administrator credential. Existing repository, Vault, review-linkage, protected-target and interrupted-effect checks remain required.

## Evidence

At base `bb05e09`, the CLI reads `OPENKIT_NANOCORE_URL`, defaults to `127.0.0.1:3000`, and maps fetch TypeError to opaque `connection_failed`. Worker supply contains neither an App API endpoint nor its bearer authority. The worker relay supplies selected MCP calls and rejects App API paths. Push approval additionally inspects the host-linked checkout and changes its request Turn; forwarding that handler without worker coordination is insufficient.

The unchanged packaged CLI was executed with Node `24.18.0` in a distinct local network namespace, empty route table, fresh config directory, no inherited environment or credentials, and no mocked transport. Operation discovery succeeded; `doctor` and a schema-valid `repository.push-request-approval` call both exited 3 with `connection_failed`. A corroborating real fetch reported `ENETUNREACH`. This reproduces the failure mechanism, not an A2 deployment acceptance run. The attempt-local probe and output remain under ignored `temp/issue84-builder/`.

The initial focused regression run failed during collection because built schema dependencies were stale; it supplied no behavioral evidence. After rebuilding those dependencies, the two regressions failed on their deciding assertions: explicit built-in repository selection incorrectly required an external catalog, and automatic approval completed the active worker Turn. Named red output is retained locally by the builder. Independent Codex review accepted the corrected owning specifications and operator recipe after four findings were resolved: AEP metadata versus schema discovery, exact human-Gate actionability and partial cleanup failure, bounded repository error results, and separate editing/review/publication Tasks. Documentation-model, specification-lifecycle and Skill-reachability checks pass. Biome ignores these Markdown paths, so a Markdown-only Biome invocation processed no files and is not lint evidence.

## Checkpoint

Status: implementation in progress on `fix/84-worker-repository-push`, created from fetched main at `bb05e09`. Herdr Codex `build84` owns NanoCore and any necessary package/test implementation; the orchestrator owns specifications, Skill guidance and integration; Herdr Codex `review84` independently inspects artifacts and evidence. Each path has one writer. No persistent deployment changes or registered-host access are part of this work.

Next action: first demonstrate the absent selected repository capability with a lowest-sufficient regression, implement the accepted path, and observe the real Gate or allowed host push plus scope/selection/recovery refusals. Run focused checks against the final diff, obtain independent acceptance, open one #84 PR, wait for green CI, merge and verify issue closure. A diagnostic-only result does not satisfy the accepted outcome.


## Delivery

Focused regressions on `worker-repository-mcp`, `worker-mcp-routes`, `approval-gates`, `agent-environment`, `worker-recovery`, `resource-catalog`, and `git-push-executor` passed after implementation. Protocol schemas regenerated for the `nanocore-repo-push-policy` system grant actor. Independent Codex review accepted the owning specs earlier in the slice; Cursor finish agents were unavailable (auth), so final land is operator-executed from the completed working tree. PR lands this change for #84.
