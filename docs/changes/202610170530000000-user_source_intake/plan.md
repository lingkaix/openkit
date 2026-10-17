---
type: change-plan
status: in-progress
---
# Explicit User Source Intake

## Intent

Continue the accepted [Personal Memory rollout](../../specs/20260909-personal_memory_and_knowledge_learning.md#rollout--migration-plan) after explicit page management with bounded explicit Source registration. [Knowledge Store](../../specs/20260703-knowledge_store_implementation.md), [Storage](../../core/storage.md), [Permissions](../../core/permissions.md) and the [record envelope](../../specs/20260703-schema_evolution_record_envelope.md) own semantics. This plan records execution, not new authority.

## Scope

Expose the existing Source registration, list and read operations under the current authenticated User through the existing memory family. One literal document producer retains exact UTF-8 bytes and their digest in the sibling User sources family. Canonical identity, owner, request lineage, timestamps and digest have one S31 header authority; the literal capture has one actual creation event. The existing User command receipts and Audit own retries. No request chooses another User, filesystem root or conversation, URL or file provenance. Lost established storage returns recovery_required without an empty replacement. No notebook initialization, model, new database, Source service, size ceiling or compatibility reader is added.

Source-backed Memory pages, candidate creation, conversation capture, private recall, generated maintenance and automatic learning remain separate accepted rollout steps. This increment makes no full Memory acceptance claim.

## Ownership And Verification

The parent owns public schemas, handlers, HTTP regression, operator instructions and generation. One built-in Sol builder owns only the new scoped native Source module and its regression; another owns documentation. An independent Sol reviewer inspects actual source and deciding evidence. Each uses a separate worktree and branch; components merge normally.

The public HTTP regression first returned404 for both cases before implementation. The joined complete native and public files passed12cases with Native typecheck in the external memory-source-public-green.log. They exercise exact bytes and original receipt replay after a later capture, changed-input conflict, canonical owner isolation, no Notebook creation and refusal of fabricated transcript provenance. Native tests cover restart, current credentials, lost storage and envelope semantics with actual SQLite and files. Regenerate OpenAPI and the standalone CLI, then run the exact-head express local gate with complete affected owner-module and changed-package suites. No Web path, host, provider, account, release or remote branch CI action belongs to this increment.

## Checkpoint

The implementation and joined regression are complete; final generated projections, independent exact-head approval and complete owner-module gate remain pending. First explicit Memory management is an independently reviewed earlier candidate; this Source increment must merge its landing before its own express landing. Retain exact gate logs and review under the coordinator evidence folder, acquire the landing window only when ready, and watch main-push CI after landing.
