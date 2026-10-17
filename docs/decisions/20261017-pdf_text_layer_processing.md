---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# PDF Text Layer Processing

## Decision

Use packaged PDF.js for PDF text-layer extraction in one short-lived Node child. Work Resource Interaction owns the bounded processor contract. The host and container use the same path, without a Poppler or Bubblewrap text-extraction fallback. Keep input, page, text, child heap and parent wall bounds, and an explicit environment without inherited secrets. Preserve the existing source/result contracts and truthful page coverage. This decision adds no OCR, file type, general processing framework, host security change, or container privilege change. This decision does not select or change an explicit vision processor.

## Reason

The engineer accepted D-AW-PDF to make bounded PDF text extraction work through one dependency-owned path in both supported deployment forms. A short-lived child keeps parsing and heap exhaustion outside the server. The parent can kill it at the wall deadline and wait for exit before releasing staged storage. The child heap limit bounds V8 old-generation storage; it does not claim to bound all process memory.

Pass `isEvalSupported: false` and forbid string code generation in Node. Current PDF.js removed that API option with its last evaluation path in version 5.7; the [Mozilla change record](https://bugzilla.mozilla.org/show_bug.cgi?id=2029536) records that removal. The fixed Node restriction preserves the accepted no-evaluation intent with the current packaged version. No version negotiation or compatibility branch is required.

## Rejected Alternatives

- Retain Poppler plus Bubblewrap for text extraction: native isolation remains a runtime prerequisite and blocks the intended dependency-owned path.
- Parse in the server process: parser failure or heap exhaustion could terminate the server.
- Add OCR or a general processor framework: neither is needed for the accepted text-layer feature.

## Revisit When

A measured PDF text-layer failure or resource requirement cannot be handled by the bounded child. A change to host or container security remains a separate engineer decision.

## Affected Owners

- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md#bounded-media-processors).
