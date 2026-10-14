//! Admission, provenance, and response shapes shared by all three faces.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// An adapter's stable, opaque source identity.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct SourceKey {
    /// Adapter namespace.
    pub namespace: String,
    /// Identity inside that adapter.
    pub id: String,
}

/// One caller-admitted canonical revision. Paths are relative to the startup source root.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Document {
    /// Original identity; a sidecar does not get another source key.
    pub key: SourceKey,
    /// Fixed canonical revision, including metadata changes.
    pub revision: String,
    /// Verified lowercase SHA-256 of canonical bytes, supplied by the adapter.
    pub digest: String,
    /// Canonical byte size.
    pub size: u64,
    /// Original display name.
    pub name: String,
    /// Original title, when available.
    #[serde(default)]
    pub title: String,
    /// Supplied media type; no parser is selected from it.
    pub media_type: String,
    /// The adapter declares text or an unreadable body.
    pub content: Content,
    /// Reliable language hint: zh, ja, or unicode.
    #[serde(default)]
    pub language: Option<String>,
    /// Optional canonical metadata and provenance. Unknown additive fields are tolerated.
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    /// Original source locator, such as an Item identifier.
    #[serde(default)]
    pub locator: Option<String>,
}

/// The kernel opens only declared text. Unreadable bodies remain unopened.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Content {
    /// Direct canonical UTF-8.
    Text {
        /// Confined root-relative path.
        path: String,
        /// Optional admitted byte range, such as one Item in a canonical JSONL log.
        #[serde(default)]
        range: Option<ByteRange>,
    },
    /// Canonical UTF-8 supplied by a trusted adapter, such as a decoded Item text field.
    InlineText {
        /// Request-local bytes; removed before manifest serialization and required in admitted requests.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// Identity-only sidecar; the verified digest must already exist.
    Unreadable,
    /// A discoverable source whose canonical representation is unavailable.
    Unavailable,
}

/// A contiguous canonical source unit, without a copied scan-text body.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ByteRange {
    /// Inclusive canonical-file offset.
    pub start: u64,
    /// Exclusive canonical-file offset.
    pub end: u64,
}

/// One named scope with its current, complete caller-admitted inventory.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScopeView {
    /// Opaque eligibility partition, never an authorization grant.
    pub scope: String,
    /// Current canonical revisions, including non-searchable objects.
    pub documents: Vec<Document>,
}

/// Supported modes are a closed vocabulary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Any-term BM25, one maximum-scoring chunk per source.
    Lexical,
    /// Case-sensitive literal occurrences, including across lines and chunks.
    Exact,
    /// Rust regex occurrences within individual LF-delimited lines.
    Regex,
}

/// A query names its admitted scopes before any generation or canonical file is opened.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Query {
    /// Closed query mode.
    pub mode: Mode,
    /// Nonempty bounded text, with no lexical query operators.
    pub query: String,
    /// Exact readable scope set and current inventories; an empty set reads nothing.
    pub scopes: Vec<ScopeView>,
    /// Positive response limit; lexical callers can request bounded enumeration.
    pub limit: usize,
}

/// Closed processing vocabulary from the accepted specification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextStatus {
    /// Existing canonical UTF-8 was indexed.
    TextExtracted,
    /// Work stopped before processing all declared text.
    Partial,
    /// Body is unreadable, but its identity sidecar can be complete.
    Unsupported,
    /// Malformed or unavailable canonical text.
    Failed,
    /// A named processing budget stopped work.
    ResourceLimited,
}

/// Original evidence coordinates. Sidecar byte offsets never claim binary-body positions.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Locator {
    /// Canonical title range; these offsets do not refer to the body stream.
    Title {
        /// Inclusive UTF-8 title offset.
        start: u64,
        /// Exclusive UTF-8 title offset.
        end: u64,
        /// Original source coordinate, when supplied.
        original: Option<String>,
    },
    /// Direct canonical UTF-8 byte range, with optional owner locator.
    Text {
        /// Inclusive byte offset.
        start: u64,
        /// Exclusive byte offset.
        end: u64,
        /// Original owner coordinate, when supplied.
        original: Option<String>,
    },
    /// One identity metadata field; offsets are within its Markdown representation.
    Metadata {
        /// Identity field that matched.
        field: String,
        /// Inclusive representation offset.
        start: u64,
        /// Exclusive representation offset.
        end: u64,
    },
}

/// One source-linked ranked hit or scan occurrence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    /// Original adapter source key.
    pub key: SourceKey,
    /// Scope that was admitted and opened.
    pub scope: String,
    /// Pinned source revision.
    pub revision: String,
    /// Pinned canonical digest.
    pub digest: String,
    /// Direct text or sidecar.
    pub representation: String,
    /// Digest of the actual searched representation.
    pub representation_digest: String,
    /// Sidecar processor identity, absent for direct text.
    pub processor: Option<String>,
    /// Original coordinate or metadata coordinate.
    pub locator: Locator,
    /// Highest-scoring chunk ordinal for lexical hits.
    pub chunk: u64,
    /// BM25 score for lexical mode; scans have no score.
    pub score: Option<f32>,
    /// UTF-8 preview bounded independently of canonical file size.
    pub snippet: String,
    /// Supplied canonical provenance.
    pub provenance: BTreeMap<String, String>,
}

/// Counts and completeness come only from named generation inventories.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Coverage {
    /// Objects in the named committed inventories.
    pub admitted_objects: usize,
    /// Successfully verified searchable representations.
    pub searched_representations: usize,
    /// Changed, added, or removed canonical revisions.
    pub stale_revisions: usize,
    /// Objects whose declared text is incomplete or unavailable.
    pub stopped_work: usize,
    /// Bodies omitted because only identity sidecars are searchable.
    pub unsupported_bodies: usize,
    /// Whether the committed inventories match the caller's current inventories.
    pub inventory_complete: bool,
    /// Whether all declared searchable representations were processed.
    pub representations_complete: bool,
    /// Whether the requested results were returned without scan truncation.
    pub matches_complete: bool,
    /// Aggregated stopping reasons; no inaccessible identities are emitted.
    pub reasons: BTreeMap<String, usize>,
    /// Number of known scan occurrences omitted by the response limit.
    pub omitted_matches: usize,
    /// Number of verified lexical matching Documents before the response limit.
    pub matching_documents: usize,
    /// Whether every lexical match was returned; governed adapters must require this in addition to complete.
    pub enumeration_complete: bool,
}

/// Shared CLI, MCP, and service response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    /// Scope-to-generation pins.
    pub generations: BTreeMap<String, String>,
    /// Mode that produced these hits.
    pub mode: Mode,
    /// Deterministic bounded results.
    pub hits: Vec<Hit>,
    /// Search extent and all completeness dimensions.
    pub coverage: Coverage,
    /// True only when all three completeness dimensions are true.
    pub complete: bool,
}

/// A machine-readable local error. Details never contain source text or query text.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Error {
    /// invalid-request, conflict, unavailable, resource-limited, or io.
    pub code: String,
    /// Bounded explanation of the violated boundary.
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
/// Kernel operation result.
pub type Result<T> = std::result::Result<T, Error>;
/// Construct a value-free boundary error.
pub(crate) fn error(code: &str, message: &str) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}
/// Convert system/library failures without copying untrusted content into diagnostics.
pub(crate) fn io_error(_: impl std::fmt::Display) -> Error {
    error(
        "io",
        "retrieval operation failed; inspect the admitted store",
    )
}

impl Document {
    /// Projection identity omits request-local canonical text; index storage never retains that body.
    pub(crate) fn identity(&self) -> Self {
        let mut document = self.clone();
        if let Content::InlineText { text } = &mut document.content {
            *text = None;
        }
        document
    }
}
