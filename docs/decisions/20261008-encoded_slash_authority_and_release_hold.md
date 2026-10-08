---
status: Accepted
date: "2026-10-08"
decider: "Engineer, on a Consultant-reviewed proposal"
---
# Encoded-Slash Authority And Release Hold

## Decision

The engineer chose these three options verbatim on 2026-10-08, as preserved in the writer dispatch:

1. Route: 「(a) manifest 授权显式字段 allowEncodedSlash（只读、无路径规则的 REST 授权才能用，缺省 false），内置 npm 模板设为 true」.
2. Existing deployment: 「授权，只改这一条 npm 授权」 in answer to whether the A2 operator may, after the new code is deployed and through the supported configuration workflow, add `"allowEncodedSlash": true` only to the `registry.npmjs.org:443` read-only grant of A2's existing authored Codex manifest, leaving every other field unchanged, then reload and verify.
3. Release: 「等：修复并在候选版本上验证后再发布」.

The English translation of ruling 1 is: “Use route (a): an explicit manifest authorization field, allowEncodedSlash, available only on read-only REST grants without path rules, defaulting to false; set it to true in the built-in npm template.” The English translation of ruling 2 is: “Authorized; change only this npm grant.” The English translation of ruling 3 is: “Wait: publish after the fix and verification on the candidate.” The quotations above remain the source wording.

[Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md#manifest-shape) owns the field's closed boolean validation, immutable authorization, composition conflict refusal and lifecycle. Its [Built-In Development Grant Templates](../specs/20260703-agent_manifest_aep_resolution.md#built-in-development-grant-templates) owns npm's explicit opt-in and unchanged existing authored configuration. [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md#network-model) owns native enforcement and the [development-baseline acceptance](../specs/20260709-worker_sandbox_freedom_policy.md#built-in-development-baseline). [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md#built-in-development-grants) owns tool supply without image-derived authorization.

The A2 ruling is explicit authorization for one additive edit to one existing qualifying npm grant after the new code is deployed. It authorizes the supported configuration validation, reload and verification for that edit, with every other manifest field unchanged. It is not authorization to replace the manifest, modify another grant, opt in other deployments, or run a general migration. No migration may set `true` without a separately accepted design and explicit authorization for the affected authored grants under [Manifest Evolution Rules](../specs/20260703-agent_manifest_aep_resolution.md#manifest-evolution-rules).

The release ruling holds `v0.1.0-rc.1` until the fix is implemented and proved on the candidate under [Release Management](../specs/20260829-release_management.md#release-exit-criterion). It grants no waiver of other required passes or reserved engineer gates. Documentation amendments and local structural checks do not qualify the candidate or authorize publication. This writer change performs no A2 edit, deployment or runtime verification.

## Reason

The Consultant recommended explicit opt-in because the needed outcome is ordinary scoped and unscoped npm metadata and archive downloads through the declared registry and executable scope. One optional field preserves authored control, strict defaults elsewhere, copy-on-init semantics and immutable AEPs without a new policy service, format migration, permanent older-shape reader or dual write. The engineer selected that route; no separate engineer rationale was recorded.

The option relaxes one path-parser restriction across the explicitly granted endpoint. Preserved `%2F` may still be interpreted differently by a proxy and upstream service. Read-only is an HTTP-method restriction, not a proof that every GET, HEAD or OPTIONS handler is free of application side effects. Forbidding the field on path-rule grants and refusing conflicting same-destination settings preserves those boundaries; it introduces no semantic write detector or script-level isolation within a granted interpreter's observed descendant scope. These are the Consultant's stated consequences of the selected route, not additional engineer quotations.

Existing authored manifests do not inherit later template edits. The A2 authorization supplies the deliberate one-grant edit that new executable deployment alone cannot perform. Retained data continuity requires continued usability, not inferred consent to wider request syntax. A migration making omitted strict behavior explicit would preserve authorization but is unnecessary; setting `true` increases accepted request syntax.

The scoped metadata failure defeats an ordinary part of the stated development baseline. The Consultant therefore recommended waiting for a repaired candidate and direct proof, rather than treating diagnosis or a recorded known defect as successful workflow evidence. The engineer selected the release hold without a reduced-baseline waiver.

Source material is the 2026-10-08 writer dispatch at `temp/interface-unification/build/write-spec-encslash.md` and the independent Consultant report at `temp/reports/consult-encslash/consult.md`, held in the repository's temporary work area. Exact proposed owner amendments, DOC-017 coverage, and Delivery and existing deployments supply the approved contract and delivery criteria. The report's diagnosis and source inspection do not prove successful downloads through the changed product; the linked owners state the rules and required observations.

## Rejected Alternatives

- Route (b), enabling encoded slashes in NanoHost for every access-preset endpoint without path rules: preserves manifest bytes and host, binary and method bounds, but changes effective request syntax for every such retained grant, including GitHub REST, PyPI and potentially read-write grants. That broader semantic change needs an explicit governing decision; an npm-specific defect does not justify inferred consent.
- Route (c), replacing npm's access preset with native encoded-slash opt-in plus npm method/path rules, endpoint path selectors or deny rules: rules apply after parsing and cannot rescue a parse rejection alone. The boolean remains endpoint-wide, while an npm URL grammar adds path discovery, normalization, maintenance and proof burden, may remove valid reads, and would require an accepted authorized edit of retained intent. No current evidence warrants it. TLS inspection skip or passthrough would sacrifice required method enforcement.
- Route (d), retaining strict rejection and shipping with disclosure: leaves the scoped-package failure and incomplete npm development purpose. It would require an explicit reduced-baseline and release-risk disposition; the engineer selected a fix and candidate proof before release.
- Automatic migration to `true`, including inference from a template-like id or purpose: increases authorization without the separately accepted design and affected-grant authorization. Replacing A2's whole manifest would exceed the one-grant ruling and risk operator customization.

## Revisit When

Return to the engineer if the complete manifest-to-native-policy path cannot enforce the admitted boolean while retaining exact destination, executable scope, read-only methods, strict path-rule grants and conflict refusal. A need for an upstream fork, broader HTTP methods, native policy bypass or permission on path-restricted grants materially changes the selected route. A new need to opt in other authored grants or deployments requires its own explicit authorization; a migration setting `true` also requires a separately accepted design. Changing the release hold requires a new engineer ruling, while the existing release owner continues to govern candidate identity, clean rounds and publication.

## Affected Owners

- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Release Management](../specs/20260829-release_management.md#release-exit-criterion)
