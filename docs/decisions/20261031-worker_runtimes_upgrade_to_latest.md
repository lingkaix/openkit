---
status: Accepted
date: "2026-10-31"
decider: Engineer
---
# Worker Runtimes Upgrade To Latest

## Decision

On 2026-10-31 the engineer selected direct upgrades of all four worker runtimes, Codex, Pi, OpenCode and DeepSeek, to their latest published versions. Each runtime keeps its existing architecture and acceptance criteria. The other three runtime selections are recorded by their implementation owner.

The Codex upgrade moves from `@openai/codex@0.160.0` to the latest published npm version. The npm `latest` dist-tag was checked at execution start and selected `0.166.0`. The image, adapter pin, generated App Server schema snapshot, templates and fixture pins move together. No `0.160.0` compatibility path remains. This replaces the Codex selection in the [2026-10-05 worker runtime upgrade decision](20261005-worker_runtimes_upgrade_to_latest.md); the Pi, OpenCode and DeepSeek upgrades keep their separate implementation and qualification owners.

### Pi Worker Runtime

The engineer selected Pi coding-agent 1.0.2 to 1.4.0, including its worker-only pi-ai, pi-tui and pi-mcp closure. Gateway pi-ai is outside this decision. The private MCP loader/transport imports and JSONL v3 exact-session path remain available. Stock 1.4.0 still lacks the native connection-state hook needed to prove completed managed MCP registration or terminal setup failure before prompting.

Under engineer ruling Q-09, retain exactly the bounded existing two-file patch: one `onConnectionState` callback invocation in the native MCP connection handler and its matching TypeScript declaration. The patch adds no transport, discovery, retry, or policy owner. The version manifest records the re-derived patch and installed module SHA256s. Remove the patch and its patch/module identities when a stock upstream release exposes an equivalent native current-connection completion/failure callback and the existing readiness, valid-empty-catalog, setup-failure, cancellation, and pending-initialize cleanup cases pass against that unpatched release.

Pi 1.4.0 establishes busy ownership before its preflight callback. The host therefore requests pending native abort there; throwing would strand settlement. Native MCP shutdown now closes pending initialization/discovery, so the temporary retained-transport close owner is removed. The release's default SDK route restores transcript tool selection. To preserve the Pi owner's current-startup-plus-search successor contract, the host uses supported native `noTools: builtin` plus additive current startup defaults, obtained from authored defaults or public `createCodingTools`. This avoids transcript restoration without an allowlist or history merge; native extension/MCP discovery remains unrestricted. Exact successors may require rediscovery; resident turns retain activation. The original native cases and bounds decide qualification.

### OpenCode Worker Runtime

The engineer selected CLI and client 2.0.22 to 2.2.5. The adapter uses canonical `experimental.session.wait` and `experimental.mcp.add/connect` instead of deprecated aliases. Consumed session, model, message, permission, form, event and plugin interfaces otherwise retain the required shape. Existing native regressions decide qualification; no old-version branch is introduced. The release adds managed system configuration after inline content, so actual deployed `/etc/opencode` absence remains mandatory. Under the coordinator consensus ruling of 2026-10-31 08:57 UTC, its native title variant is an explicit Worker per-request override under AEP precedence. Title work stays enabled; the adapter adds no effort override or request rewrite. The independent fixture observes native request kind/selected variant through one test header, requires Turn effort for every primary request and native none for reasoning title requests, and preserves all-request effort absence on plain routes. Missing/unknown kind and wrong primary/title effort fail. Only the non-owning binary-literal proxy is retired, conditional on actual-image absence smoke passing; the image predicate is retained. Complete native gates and independent applied-diff review remain required.

### DeepSeek Worker Runtime And ACP Client

The engineer selected dsh 0.2.0-rc.2 to npm latest 0.2.1-rc.5 and client SDK 1.7.0 to 2.2.0. SDK package version2 still uses stable ACP protocol1 at its default entrypoint. It removes legacy connection classes, requiring the app builder and typed request/notify API; callbacks receive ctx.params. The adapter retains the one public ClientConnection handle, uses its agent context for RPC, and the unchanged retirement proof observes its actual closed promise. Ending the existing transport streams remains the SDK retirement path; no duplicate connection or lifecycle promise is introduced. SDK2.2 also normalizes a native session/close not-found error into successful empty output, while the Session Operations owner requires genuine correlated native acknowledgement and flush evidence. A new original-bound native regression first proved the false close acknowledgement, then passed after a bounded first-reply guard at the existing raw transport correlation seam. All three native close paths require a correlated raw success before accepting the SDK-normalized result; a native error cannot grant persistence-preserving close. No extra transport, lifecycle promise, or retirement owner is introduced.

Two actual native setup traces did not reach the close regression. A timed trace sends initialize at107ms, reaches the original8000ms exchange deadline at8128ms, and receives the first native stdout with a valid protocol1 initialize response at8929ms. No timely frame is lost by the SDK and no protocol mismatch is established; neither a timeout increase nor an SDK downgrade is justified by that evidence.

Engineer Q-179 requires completed, aborted and unknown native outcomes to remain distinguishable: an unknown abort is never completed. Actual rc.5 `@deepseek-ai/dsh-acp` maps native completed and aborted to the same `end_turn` prompt result, interrupted to `cancelled`, and missing turn-end to `cancelled`. Independent source review confirms the actual prompt settlement uses that codec and returns only stopReason; its turn/end event handling emits no correlated terminal update and no exposed ACP side channel restores the distinction. The DeepSeek template therefore stays disabled and is excluded from v0.1.0. Remove that exclusion only when a released runtime/interface exposes distinguishable correlated native terminal evidence and passes the existing outcome, interruption, and cleanup qualification. A newer SDK or an ordinary successful completion does not satisfy that condition. No template is enabled by this decision.

## Reason

Credential delivery is in v0.1.0 scope and uses App Server host-managed ChatGPT token login: `account/login/start` with type `chatgptAuthTokens`, the server request `account/chatgptAuthTokens/refresh`, and the `account/rateLimits/updated` notification. The engineer also selected current upstream fixes. This upgrade supplies the pinned protocol boundary; credential delivery remains separate work and is not enabled by this decision.

Pre-v0.1.0 data is not carried under the [existing earlier-version data decision](20260930-earlier_version_data_not_carried.md). No migration or dual reader is introduced. Runtime upgrade evidence does not close deployed Sandbox, live-provider or credential-delivery acceptance gates.

## Rejected Alternatives

- Retain `0.160.0`: the engineer selected npm latest and current upstream fixes directly.
- Keep old-pin compatibility or migrate pre-v0.1.0 data: the accepted first-release reset carries no earlier-version sessions.
- Implement credential delivery as part of the pin upgrade: the credential owner controls that behavior and its acceptance.

## Revisit When

The selected release fails an accepted adapter, credential, lifecycle or deployment criterion, or a later upgrade changes the consumed protocol or retained-data boundary. Preserve the failing criterion and resolve it with its owner.

## Affected Owners

- [Pi-ai Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)
- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Container Image Packaging And Release Publishing](../specs/20260708-container_image_packaging.md)
