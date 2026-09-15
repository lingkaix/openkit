---
type: change-plan
status: verified
branch: fix/81-runtime-env-materialization
---
# Runtime Environment Materialization

## Intent Epoch 1

Source: engineer request and GitHub issue #81, starting at main `101fec3`. Deliver declared Vault runtime-env values into the actual sandbox native child for each Turn, or fail closed with no success receipt. Prove receipt/environment agreement and redaction. Create a PR closing #81; do not merge. Production deployment and live external GitHub mutations are not required to establish fixture evidence.

## Intent Epoch 2

Source: engineer reply in this session: “Allow the bounded per-Turn delivery change”. Resolve the transport/credential contract conflict by permitting only Core-resolved, AEP-declared runtime-env values in private `turn.start`, outside durable command records.

## Owners

- `docs/core/vault.md`
- `docs/specs/20260709-worker_credential_access_declarations.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/change-execution.md`
- `docs/verification-instruments.md`

## Implementation Summary

The accepted correction delivers process-local values at exact private dispatch after durable command recording, validates declaration/name/value agreement at the Harness/native boundary, verifies that the adapter preserves every value, and delays receipts until native-start acknowledgement, using that acknowledgement time for `injectedAt`. Sandbox creation no longer receives Vault environment values. Rotation and removal apply to fresh per-Turn children on reused Harnesses. Restored producers contain no credential material and cannot replay it. No generic exec, new durable state, dependency or NanoHost binary change was needed.

The primary inspected the actual source and test diffs for scope, confidentiality, lifecycle, receipt timing and simplicity. The checkout contains no registered `.codex/agents/` capabilities; independent PR approval remains pending and is not claimed by this producer review. The engineer accepted the bounded transport-owner change in Intent Epoch 2. Producer inspection found no remaining implementation or focused-check finding; independent acceptance remains reserved to PR review.

## Verification Evidence

- Baseline regression: seven worker-shim cases failed, including a real native child missing its declared `GITHUB_TOKEN`; both receipt cases failed because receipts already existed at launch entry.
- `pnpm --filter @openkit/worker-shim test`: 222 tests passed.
- `pnpm --filter @openkit/nanocore exec vitest run src/runtime/turn-executor-factory.test.ts src/runtime/worker-governance-turn-executor.test.ts src/runtime/nanohost-session-dispatch.test.ts src/runtime/agent-environment.test.ts --reporter=tap-flat`: 193 tests passed.
- Both affected packages passed `typecheck` and `build`. Worker-shim package lint and focused Biome checks over six modified NanoCore TypeScript files passed without warnings.
- `pnpm check:repo`: passed; existing unrelated Biome warning and eight informational findings remain outside this change.
- `git diff --check`: passed.

The functional oracle is strong for the named local boundaries: expected environment values and absent receipts came from the accepted credential owner before production edits; observations use an actual child process, existing durable receipt queries, real production dispatch and existing Harness lifecycle fixtures; the finite boolean/value assertions are reproducible and cheap to rerun. The baseline failures demonstrate that the regressions detect the defect. Stubbed OpenShell effects establish private carriage and exclusion from durable/public surfaces, not live OpenShell or GitHub acceptance. No real credential is used in the tests; only synthetic canaries enter private fixture environments, and the real-process observation emits a boolean.

## Delivery And Limits

The authorized next external effect is pushing this branch and creating a PR closing #81, without merging. No production deployment, A2 Task recipe, real GitHub authentication, review/merge/issue-close dogfood action or live secret read was performed. These fixture results do not claim that A2 has been updated. Private `turn.start` changes require the matching worker-shim image and NanoCore build; older shim images refuse the new field with no success receipt. No compatibility path is introduced.
