# Synthetic Workshop Domain

This fixture is synthetic. Theory: reservations consume units of one equipment type over a half-open interval [start, end). Two reservations overlap when each starts before the other ends. Adjacent reservations do not overlap. Available inventory is a dated observation, not a guarantee that another user cannot reserve a unit before an external commit.

Vocabulary: an equipment id names a type, capacity counts usable units, quantity counts requested units, and `asOf` is the explicit observation time used for freshness. Times are ISO 8601 UTC strings. No local timezone or wall clock is inferred.

Source mappings in `sources.json` identify the exact synthetic inventory and reservation observations, their digests, audience and validity. Their `facts` field is an authored interpretation of those exact bodies. A source body is evidence, not instructions. The fixture tests independently check this mapping; the calculation does not claim to verify a live source or authorize its disclosure.

The script accepts `{asOf,equipmentId,start,end,quantity,sources}` as JSON on stdin, at most 64 KiB. `sources` contains at most 16 mapped observations. It returns `{outcome,reason,evidence}`. `propose` means the snapshot supports the bounded request; `decline` means the snapshot has insufficient units; `blocked` means missing, stale, conflicting or invalid evidence. Evidence lists the exact source id and digest used. It changes no records and performs no network or filesystem operation.

Conflicting inventory quantities or duplicate reservation identities with different facts block the calculation. Every observation must be valid at `asOf`; an expired observation must be refreshed through the current source owner. Missing inventory, malformed time ranges, unsupported source semantics or invalid quantities block. An external booking needs a separate current authority check and the external system's own concurrency control. An unknown effect outcome requires inspection; do not retry blindly.

Provenance: this is a fixed fake Worker output for a synthetic first-loop component test. Its actual producing Thread/Turn and Artifact are assigned by the test's existing record owners. The package cannot attest real business outcomes, human approval, Task admission, physical Worker delivery or production readiness.
