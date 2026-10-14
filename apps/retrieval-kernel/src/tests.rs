//! Kernel contract fixtures; expectations are independent of the returned data.
/// The issue #222 body terms must survive segmentation on the shipped dictionaries.
#[test]
fn regression_222_segmentation() {
    let chinese = crate::tokens("zh", "我们完成了测试，并修复了缺陷。").unwrap();
    assert!(
        chinese.contains(&"测试".into()),
        "Chinese body term lost: {chinese:?}"
    );
    assert!(chinese.contains(&"修复".into()));
    let japanese = crate::tokens("ja", "検索機能を改善しました。").unwrap();
    assert!(
        japanese.contains(&"検索".into()),
        "Japanese body term lost: {japanese:?}"
    );
    assert!(japanese.contains(&"改善".into()));
}

use crate::store::*;
use crate::text::*;
use crate::*;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use tempfile::TempDir;

/// A fixture owns separate canonical and derived roots; it never changes repository data.
struct Fixture {
    root: TempDir,
    store: TempDir,
    kernel: Kernel,
}
impl Fixture {
    /// Prepare empty local roots.
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let store = TempDir::new().unwrap();
        let kernel = Kernel::new(root.path(), store.path()).unwrap();
        Self {
            root,
            store,
            kernel,
        }
    }
    /// Supply a fixed direct-text revision and independent expected SHA-256.
    fn text(&self, id: &str, text: &str) -> Document {
        fs::write(self.root.path().join(id), text).unwrap();
        document(
            id,
            text.as_bytes(),
            Content::Text {
                path: id.into(),
                range: None,
            },
        )
    }
    /// Construct a complete admitted inventory without opening any other scope.
    fn view(&self, scope: &str, documents: Vec<Document>) -> ScopeView {
        ScopeView {
            scope: scope.into(),
            documents,
            unavailable_objects: 0,
        }
    }
    /// Query a fixed current inventory through the public kernel boundary.
    fn search(
        &self,
        mode: Mode,
        query: &str,
        scopes: Vec<ScopeView>,
        limit: usize,
    ) -> SearchResult {
        self.kernel
            .search(Query {
                mode,
                query: query.into(),
                scopes,
                limit,
            })
            .unwrap()
    }
}
/// Fixed canonical identity from fixture bytes; unreadable content need not exist on disk.
fn document(id: &str, bytes: &[u8], content: Content) -> Document {
    Document {
        key: SourceKey {
            namespace: "fixture".into(),
            id: id.into(),
        },
        revision: digest(bytes),
        digest: digest(bytes),
        size: bytes.len() as u64,
        name: id.into(),
        title: "unrelated".into(),
        media_type: "application/octet-stream".into(),
        content,
        language: None,
        metadata: BTreeMap::new(),
        locator: None,
    }
}
/// Compare results while allowing independently built generation identifiers.
fn comparable(mut result: SearchResult) -> SearchResult {
    result.generations.clear();
    result
}

/// The #222 terms find body Documents, including mixed scripts and one-character fallback.
#[test]
fn regression_222_body_retrieval_and_language_cases() {
    let f = Fixture::new();
    let chinese = f.text(
        "chinese",
        "我们完成了测试，并修复了缺陷。 API_v2 傳統中文測試 龘 한글",
    );
    let japanese = f.text("japanese", "検索機能を改善しました。 Rust検索 エンジン");
    let view = f.view("public", vec![chinese, japanese]);
    f.kernel.publish(view.clone(), None).unwrap();
    for (query, expected) in [
        ("测试", "chinese"),
        ("修复", "chinese"),
        ("検索", "japanese"),
        ("改善", "japanese"),
        ("API_v2", "chinese"),
        ("傳統", "chinese"),
        ("測試", "chinese"),
        ("エンジン", "japanese"),
        ("龘", "chinese"),
        ("한글", "chinese"),
    ] {
        let result = f.search(Mode::Lexical, query, vec![view.clone()], 20);
        assert!(result.complete, "{query}: {:?}", result.coverage);
        assert!(
            result.hits.iter().any(|h| h.key.id == expected),
            "{query}: {:?}",
            result.hits
        );
    }
}

/// Title preference and stable source-key ties are kernel rules, independent of product selection.
#[test]
fn title_preference_and_deterministic_ties() {
    let f = Fixture::new();
    let a = f.text("a", "testing testing");
    let b = f.text("b", "testing testing");
    let mut title = f.text("title", "unrelated unrelated");
    title.title = "testing testing".into();
    let view = f.view("public", vec![b, title, a]);
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Lexical, "testing", vec![view.clone()], 20);
    assert_eq!(result.hits[0].key.id, "title");
    assert_eq!(result.hits[1].key.id, "a");
    assert_eq!(result.hits[2].key.id, "b");
    assert_eq!(result.hits[1].score, result.hits[2].score);
    assert_eq!(result, f.search(Mode::Lexical, "testing", vec![view], 20));
}

/// Healthy and poisoned unrequested scopes cannot affect public scores, coverage, or access.
#[test]
fn scope_isolation_before_open_and_scope_score_equality() {
    let f = Fixture::new();
    let public = f.view("public", vec![f.text("public", "same term marker")]);
    f.kernel.publish(public.clone(), None).unwrap();
    let before: Vec<_> = [Mode::Lexical, Mode::Exact, Mode::Regex]
        .into_iter()
        .map(|m| f.search(m, "term", vec![public.clone()], 20))
        .collect();
    let private = f.view(
        "private",
        vec![f.text("private", "same term SECRET_PRIVATE")],
    );
    let private_id = f.kernel.publish(private.clone(), None).unwrap();
    let owner = f.search(Mode::Lexical, "term", vec![private], 20);
    assert!(owner.complete && owner.hits.len() == 1);
    for (mode, expected) in [Mode::Lexical, Mode::Exact, Mode::Regex]
        .into_iter()
        .zip(&before)
    {
        take_access();
        let result = f.search(mode, "term", vec![public.clone()], 20);
        assert_eq!(&result, expected);
        assert!(
            take_access()
                .iter()
                .all(|(_, identity)| identity == "public")
        );
    }
    fs::remove_dir_all(
        f.kernel
            .scope_path("private")
            .join(&private_id)
            .join("index"),
    )
    .unwrap();
    fs::write(f.kernel.scope_path("private").join("CURRENT"), b"corrupt").unwrap();
    fs::remove_file(f.root.path().join("private")).unwrap();
    std::os::unix::fs::symlink("/unavailable/PRIVATE", f.root.path().join("private")).unwrap();
    let restarted = Kernel::new(f.root.path(), f.store.path()).unwrap();
    for (mode, expected) in [Mode::Lexical, Mode::Exact, Mode::Regex]
        .into_iter()
        .zip(before)
    {
        take_access();
        let result = restarted
            .search(Query {
                mode,
                query: "term".into(),
                scopes: vec![public.clone()],
                limit: 20,
            })
            .unwrap();
        assert_eq!(result, expected);
        let opened = take_access();
        assert!(
            opened.iter().all(|(_, identity)| identity == "public"),
            "{opened:?}"
        );
        assert!(opened.iter().any(|(kind, _)| kind == "generation-open"));
        assert!(opened.iter().any(|(kind, _)| kind == "canonical-open"));
        assert_eq!(
            result.generations.keys().collect::<Vec<_>>(),
            vec!["public"]
        );
        assert_eq!(result.coverage.admitted_objects, 1);
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SECRET_PRIVATE")
        );
        let empty = restarted
            .search(Query {
                mode,
                query: "term".into(),
                scopes: vec![],
                limit: 20,
            })
            .unwrap();
        assert!(empty.complete && empty.hits.is_empty() && empty.generations.is_empty());
        assert!(take_access().is_empty());
    }
}

/// A file without a verified identity is coverage only; readable neighbors remain searchable.
#[test]
fn directory_unavailable_file_preserves_search_and_hides_identity() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.text("public", "needle");
    f.text("SECRET_PRIVATE", "needle");
    let directory = crate::directory::Directory::new(f.root.path(), f.store.path()).unwrap();
    f.kernel
        .publish(directory.inventory().unwrap(), None)
        .unwrap();
    fs::set_permissions(
        f.root.path().join("SECRET_PRIVATE"),
        fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    for mode in [Mode::Lexical, Mode::Exact, Mode::Regex] {
        let result = directory
            .search(&f.kernel, mode, "needle".into(), 20)
            .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].key.id, "public");
        assert_eq!(result.coverage.admitted_objects, 2);
        assert!(!result.complete && !result.coverage.inventory_complete);
        assert_eq!(result.coverage.reasons.get("source-unavailable"), Some(&1));
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SECRET_PRIVATE")
        );
    }
    let view = directory.inventory().unwrap();
    assert_eq!(view.documents.len(), 1);
    assert_eq!(view.unavailable_objects, 1);
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("SECRET_PRIVATE")
    );
    let prior = f.kernel.generation(directory.scope()).unwrap();
    let id = f.kernel.publish(view.clone(), prior).unwrap();
    let pin = f.kernel.pin(directory.scope()).unwrap();
    assert_eq!(pin.manifest.unavailable_objects, 1);
    assert_eq!(pin.manifest.documents.len(), 1);
    drop(pin);
    assert_eq!(f.kernel.publish(view, Some(id.clone())).unwrap(), id);
    for mode in [Mode::Lexical, Mode::Exact, Mode::Regex] {
        let result = directory
            .search(&f.kernel, mode, "needle".into(), 20)
            .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.coverage.admitted_objects, 2);
        assert_eq!(result.coverage.reasons.get("source-unavailable"), Some(&1));
        assert!(!result.complete && !result.coverage.inventory_complete);
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SECRET_PRIVATE")
        );
    }
    fs::set_permissions(
        f.root.path().join("SECRET_PRIVATE"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let restored = directory.inventory().unwrap();
    assert_eq!(restored.unavailable_objects, 0);
    let restored_id = f.kernel.publish(restored, Some(id.clone())).unwrap();
    assert_ne!(id, restored_id);
    let result = directory
        .search(&f.kernel, Mode::Exact, "needle".into(), 20)
        .unwrap();
    assert!(result.complete && result.hits.len() == 2);
}

/// Lexical matching admits either query term, including a source that has only one term.
#[test]
fn lexical_any_term_matching() {
    let f = Fixture::new();
    let view = f.view(
        "scope",
        vec![
            f.text("first", "alpha"),
            f.text("second", "beta"),
            f.text("neither", "gamma"),
        ],
    );
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Lexical, "alpha beta", vec![view], 20);
    assert!(result.complete && result.coverage.enumeration_complete);
    assert_eq!(result.coverage.matching_documents, 2);
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| h.key.id.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
}

/// A bounded line failure retains earlier canonical matches with explicit incomplete coverage.
#[test]
fn regex_scan_stop_preserves_prior_document_hits() {
    let f = Fixture::new();
    let view = f.view(
        "scope",
        vec![f.text(
            "source",
            &format!("needle\n{}\n", "x".repeat(LINE_BYTES + 1)),
        )],
    );
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Regex, "needle", vec![view], 20);
    assert_eq!(result.hits.len(), 1);
    assert!(matches!(
        result.hits[0].locator,
        Locator::Text {
            start: 0,
            end: 6,
            ..
        }
    ));
    assert_eq!(result.coverage.matching_documents, 1);
    assert_eq!(result.coverage.reasons.get("resource-limited"), Some(&1));
    assert!(
        !result.complete
            && !result.coverage.representations_complete
            && !result.coverage.matches_complete
    );
}

/// Replacement publication and clean rebuild have identical live BM25 statistics and provenance.
#[test]
fn rebuild_equivalence_without_tombstones_and_deterministic_merge() {
    let f = Fixture::new();
    let a = f.text("a", "alpha term term");
    let b = f.text("b", "obsolete term");
    let initial = f.view("scope", vec![a, b]);
    let id = f.kernel.publish(initial, None).unwrap();
    let live = f.view(
        "scope",
        vec![f.text("a", "new term term"), f.text("c", "term gamma")],
    );
    f.kernel.publish(live.clone(), Some(id)).unwrap();
    let other_store = TempDir::new().unwrap();
    let clean = Kernel::new(f.root.path(), other_store.path()).unwrap();
    clean.publish(live.clone(), None).unwrap();
    for mode in [Mode::Lexical, Mode::Exact, Mode::Regex] {
        let updated = f.search(mode, "term", vec![live.clone()], 20);
        let rebuilt = clean
            .search(Query {
                mode,
                query: "term".into(),
                scopes: vec![live.clone()],
                limit: 20,
            })
            .unwrap();
        assert_eq!(comparable(updated), comparable(rebuilt));
    }
    for kernel in [&f.kernel, &clean] {
        let pin = kernel.pin("scope").unwrap();
        let index = tantivy::Index::open_in_dir(pin.path.join("index")).unwrap();
        let reader = index.reader().unwrap();
        assert_eq!(reader.searcher().num_docs(), 2);
        for segment in reader.searcher().segment_readers() {
            assert_eq!(segment.max_doc(), segment.num_docs());
        }
    }
    let second = f.view("second", vec![f.text("z", "term term")]);
    f.kernel.publish(second.clone(), None).unwrap();
    assert_eq!(
        f.search(
            Mode::Lexical,
            "term",
            vec![second.clone(), live.clone()],
            20
        ),
        f.search(Mode::Lexical, "term", vec![live, second], 20)
    );
}

/// An exhaustive byte-window oracle decides literal offsets across chunks, lines, and Unicode.
#[test]
fn exact_exhaustive_completeness_and_limits() {
    let f = Fixture::new();
    let text = format!(
        "{}跨\n界\r\n低分 跨\n界 aaa Unicode é 測試",
        "x".repeat(CHUNK_BYTES - 3)
    );
    let doc = f.text("literal", &text);
    let view = f.view("scope", vec![doc]);
    f.kernel.publish(view.clone(), None).unwrap();
    for query in ["跨\n界", "\r\n", "aa", "é", "測試", "absent"] {
        let expected: Vec<_> = text
            .as_bytes()
            .windows(query.len())
            .enumerate()
            .filter_map(|(i, b)| (b == query.as_bytes()).then_some(i as u64))
            .collect();
        let result = f.search(Mode::Exact, query, vec![view.clone()], 20);
        let actual: Vec<_> = result
            .hits
            .iter()
            .map(|h| match h.locator {
                Locator::Text { start, .. } => start,
                _ => panic!(),
            })
            .collect();
        assert_eq!(actual, expected, "{query}");
        assert!(result.complete);
    }
    let limited = f.search(Mode::Exact, "aa", vec![view], 1);
    assert_eq!(limited.hits.len(), 1);
    assert_eq!(limited.coverage.omitted_matches, 1);
    assert!(!limited.complete && !limited.coverage.matches_complete);
}

/// An independent split-by-LF oracle decides line anchors and retained CR bytes.
#[test]
fn regex_line_exhaustive_completeness_and_rejected_features() {
    let f = Fixture::new();
    let text = "needle\r\nneedle\nnot needle\n測試\r\n";
    let view = f.view("scope", vec![f.text("regex", text)]);
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Regex, "^needle", vec![view.clone()], 20);
    let mut offset = 0;
    let mut expected = vec![];
    for line in text.split_inclusive('\n') {
        if line.starts_with("needle") {
            expected.push(offset);
        }
        offset += line.len() as u64;
    }
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| match h.locator {
                Locator::Text { start, .. } => start,
                _ => panic!(),
            })
            .collect::<Vec<_>>(),
        expected
    );
    assert!(result.complete);
    assert_eq!(
        f.search(Mode::Regex, "needle\\r$", vec![view.clone()], 20)
            .hits
            .len(),
        1
    );
    assert_eq!(
        f.search(Mode::Regex, "needle$", vec![view.clone()], 20)
            .hits
            .len(),
        2
    );
    for pattern in [
        "(?=needle)",
        "(a)\\1",
        "a*",
        "^",
        "needle\\n",
        "needle\\x0a",
        "needle\n",
        "[",
    ] {
        let error = f
            .kernel
            .search(Query {
                mode: Mode::Regex,
                query: pattern.into(),
                scopes: vec![f.view("missing", vec![])],
                limit: 20,
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid-request", "{pattern}");
    }
    assert!(!f.search(Mode::Regex, "needle", vec![view], 1).complete);
}

/// Metadata fields are searchable units, and binary body bytes are never opened or parsed.
#[test]
fn direct_text_without_sidecars_and_identity_sidecar_discovery() {
    let f = Fixture::new();
    let mut docs = vec![];
    for id in ["text.txt", "markdown.md", "json.json", "item", "knowledge"] {
        docs.push(f.text(id, "stored canonical term"));
    }
    let mut binary = document("binary.pdf", b"BINARY_BODY_SECRET", Content::Unreadable);
    binary.name = "report-discovery.pdf".into();
    binary.media_type = "application/pdf".into();
    binary
        .metadata
        .insert("producer".into(), "original producer".into());
    docs.push(binary.clone());
    let view = f.view("scope", docs);
    f.kernel.publish(view.clone(), None).unwrap();
    let pin = f.kernel.pin("scope").unwrap();
    assert_eq!(fs::read_dir(pin.path.join("sidecars")).unwrap().count(), 1);
    assert_eq!(
        pin.manifest
            .documents
            .iter()
            .filter(|r| r.sidecar.is_some())
            .count(),
        1
    );
    for query in [
        "report-discovery",
        "application/pdf",
        &binary.digest,
        "producer",
        "binary.pdf",
        &format!("\"{}\"", binary.size),
    ] {
        let result = f.search(Mode::Exact, query, vec![view.clone()], 20);
        assert!(result.complete);
        assert_eq!(result.hits.len(), 1, "{query}: {:?}", result.hits);
        assert_eq!(result.hits[0].key, binary.key);
        assert_eq!(result.hits[0].representation, "sidecar");
        assert!(matches!(result.hits[0].locator, Locator::Metadata { .. }));
        assert_eq!(result.hits[0].processor.as_deref(), Some(PROCESSOR));
    }
    let absent = f.search(Mode::Exact, "BINARY_BODY_SECRET", vec![view.clone()], 20);
    assert!(absent.complete && absent.hits.is_empty());
    assert_eq!(absent.coverage.unsupported_bodies, 1);
    // A false literal must not be formed by joining adjacent metadata fields.
    assert!(
        f.search(Mode::Exact, "pdf\"\n\n##", vec![view], 20)
            .hits
            .is_empty()
    );
}

/// Changed canonical revisions withhold old hits and make an empty result unable to prove absence.
#[test]
fn stale_partial_failed_resource_limited_and_unsupported_statuses() {
    let f = Fixture::new();
    let original = f.view("scope", vec![f.text("source", "old marker")]);
    let id = f.kernel.publish(original.clone(), None).unwrap();
    let current = f.view("scope", vec![f.text("source", "new marker")]);
    for mode in [Mode::Lexical, Mode::Exact, Mode::Regex] {
        let result = f.search(mode, "old", vec![current.clone()], 20);
        assert!(!result.complete && result.hits.is_empty());
        assert_eq!(result.coverage.stale_revisions, 1);
        assert!(!f.search(mode, "old", vec![original.clone()], 20).complete);
    }
    let invalid = document(
        "invalid",
        b"UTF8\xff",
        Content::Text {
            path: "invalid".into(),
            range: None,
        },
    );
    fs::write(f.root.path().join("invalid"), b"UTF8\xff").unwrap();
    let broken = f.view("scope", vec![invalid]);
    f.kernel.publish(broken.clone(), Some(id)).unwrap();
    let result = f.search(Mode::Exact, "UTF8", vec![broken], 20);
    assert!(!result.complete && result.hits.is_empty());
    let pin = f.kernel.pin("scope").unwrap();
    assert_eq!(pin.manifest.documents[0].status, TextStatus::Failed);
    assert_eq!(fs::read_dir(pin.path.join("sidecars")).unwrap().count(), 0);
    drop(pin);
    let partial = f.view("partial", vec![f.text("partial", "readable term")]);
    let mut budget = Budget::new();
    budget.cancelled = true;
    f.kernel
        .publish_inner(partial.clone(), None, &budget, INDEX_BYTES, |_| Ok(()))
        .unwrap();
    assert_eq!(
        f.kernel.pin("partial").unwrap().manifest.documents[0].status,
        TextStatus::Partial
    );
    assert!(!f.search(Mode::Exact, "term", vec![partial], 20).complete);
    let limited = f.view("limited", vec![f.text("limited", "readable term")]);
    f.kernel
        .publish_inner(limited.clone(), None, &Budget::new(), 1024 * 1024, |_| {
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.kernel.pin("limited").unwrap().manifest.documents[0].status,
        TextStatus::ResourceLimited
    );
    assert!(!f.search(Mode::Exact, "term", vec![limited], 20).complete);
}

/// A conflicting writer or expected generation fails before index mutation; identical publication is a no-op.
#[test]
fn writer_expected_generation_and_identity_conflicts_are_idempotent() {
    use fs2::FileExt;
    let f = Fixture::new();
    let view = f.view("scope", vec![f.text("source", "term")]);
    let id = f.kernel.publish(view.clone(), None).unwrap();
    assert_eq!(
        f.kernel.publish(view.clone(), Some(id.clone())).unwrap(),
        id
    );
    assert_eq!(
        f.kernel.publish(view.clone(), None).unwrap_err().code,
        "conflict"
    );
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.kernel.scope_path("scope").join("LOCK"))
        .unwrap();
    lock.lock_exclusive().unwrap();
    assert_eq!(
        f.kernel
            .publish(view.clone(), Some(id.clone()))
            .unwrap_err()
            .code,
        "conflict"
    );
    drop(lock);
    let mut contradiction = view.clone();
    contradiction.documents[0].digest = digest(b"other bytes");
    assert_eq!(
        f.kernel
            .publish(contradiction, Some(id.clone()))
            .unwrap_err()
            .code,
        "conflict"
    );
    let empty = f.view("scope", vec![]);
    let removed = f.kernel.publish(empty.clone(), Some(id)).unwrap();
    assert_eq!(
        f.kernel.publish(empty, Some(removed.clone())).unwrap(),
        removed
    );
}

/// Cache replacement retains pinned old bytes, reuses valid entries, repairs corruption, and removes retired entries.
#[test]
fn sidecar_cache_lifecycle_and_reader_pins() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let binary = document("binary", b"bytes", Content::Unreadable);
    let view = f.view("scope", vec![binary.clone()]);
    let first = f.kernel.publish(view.clone(), None).unwrap();
    let old = f.kernel.pin("scope").unwrap();
    let old_path = old
        .path
        .join(old.manifest.documents[0].sidecar.as_ref().unwrap());
    let old_bytes = fs::read(&old_path).unwrap();
    let mut next_view = view.clone();
    next_view.documents.push(f.text("text", "direct term"));
    let next = f.kernel.publish(next_view, Some(first)).unwrap();
    let new = f.kernel.pin("scope").unwrap();
    let new_path = new
        .path
        .join(new.manifest.documents[0].sidecar.as_ref().unwrap());
    assert_eq!(
        fs::metadata(&old_path).unwrap().ino(),
        fs::metadata(&new_path).unwrap().ino(),
        "valid cache was not reused"
    );
    drop(new);
    let mut changed = binary;
    changed.name = "new name".into();
    changed.revision = "metadata-revision-2".into();
    let changed_view = f.view("scope", vec![changed]);
    let changed_id = f.kernel.publish(changed_view.clone(), Some(next)).unwrap();
    assert_eq!(fs::read(&old_path).unwrap(), old_bytes);
    assert!(old.path.exists());
    drop(old);
    f.kernel.collect("scope").unwrap();
    assert!(!old_path.exists());
    let current = f.kernel.pin("scope").unwrap();
    let bad = current
        .path
        .join(current.manifest.documents[0].sidecar.as_ref().unwrap());
    fs::write(&bad, b"corrupt").unwrap();
    drop(current);
    assert!(
        !f.search(Mode::Exact, "new name", vec![changed_view.clone()], 20)
            .complete
    );
    let repaired = f
        .kernel
        .publish(changed_view.clone(), Some(changed_id))
        .unwrap();
    assert!(
        f.search(Mode::Exact, "new name", vec![changed_view], 20)
            .complete
    );
    f.kernel
        .publish(f.view("scope", vec![]), Some(repaired))
        .unwrap();
    let pin = f.kernel.pin("scope").unwrap();
    assert_eq!(fs::read_dir(pin.path.join("sidecars")).unwrap().count(), 0);
}

/// Actual SIGKILL at each boundary proves recovery without destructor cleanup.
#[test]
fn crash_recovery_at_every_publication_boundary() {
    use std::os::unix::process::ExitStatusExt;
    if let Ok(boundary) = std::env::var("RETRIEVAL_CRASH_BOUNDARY") {
        let root = std::env::var("RETRIEVAL_CRASH_ROOT").unwrap();
        let store = std::env::var("RETRIEVAL_CRASH_STORE").unwrap();
        let view: ScopeView =
            serde_json::from_str(&std::env::var("RETRIEVAL_CRASH_VIEW").unwrap()).unwrap();
        let kernel = Kernel::new(Path::new(&root), Path::new(&store)).unwrap();
        let expected = kernel.generation("scope").unwrap();
        kernel
            .publish_inner(view, expected, &Budget::new(), INDEX_BYTES, |name| {
                if name == boundary {
                    unsafe {
                        libc::raise(libc::SIGKILL);
                    }
                }
                Ok(())
            })
            .unwrap();
        panic!("crash checkpoint not reached");
    }
    for boundary in [
        "prepare",
        "chunk",
        "inventory",
        "commit",
        "durable",
        "before-pointer",
        "after-pointer",
    ] {
        let f = Fixture::new();
        let prior = f.view(
            "scope",
            vec![
                f.text("source", "old term"),
                f.text("remove", "removed term"),
                document("binary", b"old binary", Content::Unreadable),
            ],
        );
        let id = f.kernel.publish(prior, None).unwrap();
        let updated = f.view(
            "scope",
            vec![
                f.text("source", "new term"),
                document("binary", b"new binary", Content::Unreadable),
            ],
        );
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::crash_recovery_at_every_publication_boundary",
                "--nocapture",
            ])
            .env("RETRIEVAL_CRASH_BOUNDARY", boundary)
            .env("RETRIEVAL_CRASH_ROOT", f.root.path())
            .env("RETRIEVAL_CRASH_STORE", f.store.path())
            .env(
                "RETRIEVAL_CRASH_VIEW",
                serde_json::to_string(&updated).unwrap(),
            )
            .output()
            .unwrap()
            .status;
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{boundary}: {status}");
        let restarted = Kernel::new(f.root.path(), f.store.path()).unwrap();
        let pin = restarted.pin("scope").unwrap();
        if boundary == "after-pointer" {
            assert_ne!(pin.id, id);
            assert_eq!(pin.manifest.documents.len(), 2);
            assert_eq!(
                pin.manifest.documents[1].document.digest,
                digest(b"new term")
            );
        } else {
            assert_eq!(pin.id, id);
            assert_eq!(pin.manifest.documents.len(), 3);
        }
        for record in &pin.manifest.documents {
            if let Some(path) = &record.sidecar {
                assert_eq!(
                    digest(&fs::read(pin.path.join(path)).unwrap()),
                    record.representation_digest
                );
            }
        }
        drop(pin);
        let current = restarted.generation("scope").unwrap();
        restarted.publish(updated.clone(), current).unwrap();
        assert_eq!(
            restarted
                .search(Query {
                    mode: Mode::Exact,
                    query: "new term".into(),
                    scopes: vec![updated],
                    limit: 20
                })
                .unwrap()
                .hits
                .len(),
            1
        );
    }
}

/// Fixed fixture ceilings reject hostile inputs and preserve the last commit and canonical bytes.
#[test]
fn hostile_input_limits_cancellation_and_disk_failure() {
    let f = Fixture::new();
    let original = f.view("scope", vec![f.text("source", "term")]);
    let id = f.kernel.publish(original.clone(), None).unwrap();
    for query in ["".to_string(), "x".repeat(4097)] {
        assert_eq!(
            f.kernel
                .search(Query {
                    mode: Mode::Exact,
                    query,
                    scopes: vec![f.view("missing", vec![])],
                    limit: 20
                })
                .unwrap_err()
                .code,
            "invalid-request"
        );
    }
    let mut escape = original.clone();
    escape.documents[0].content = Content::Text {
        path: "../escape".into(),
        range: None,
    };
    assert_eq!(
        f.kernel.publish(escape, Some(id.clone())).unwrap_err().code,
        "invalid-request"
    );
    let mut huge = document("huge", b"body", Content::Unreadable);
    huge.metadata.insert("oversized".into(), "x".repeat(65_537));
    assert_eq!(
        f.kernel
            .publish(f.view("scope", vec![huge]), Some(id.clone()))
            .unwrap_err()
            .code,
        "invalid-request"
    );
    let line = "x".repeat(65_537);
    let long = f.view("long", vec![f.text("long", &line)]);
    f.kernel.publish(long.clone(), None).unwrap();
    let result = f.search(Mode::Regex, "x", vec![long], 20);
    assert!(!result.complete && result.hits.len() <= 20);
    let mut cancelled = Budget::new();
    cancelled.cancelled = true;
    let result = f
        .kernel
        .search_inner(
            Query {
                mode: Mode::Exact,
                query: "term".into(),
                scopes: vec![original.clone()],
                limit: 20,
            },
            &cancelled,
        )
        .unwrap();
    assert!(!result.complete && result.hits.is_empty());
    let disk = f
        .kernel
        .publish_inner(
            f.view("scope", vec![]),
            Some(id.clone()),
            &Budget::new(),
            1,
            |_| Ok(()),
        )
        .unwrap_err();
    assert_eq!(disk.code, "resource-limited");
    assert_eq!(f.kernel.generation("scope").unwrap(), Some(id));
    assert_eq!(fs::read(f.root.path().join("source")).unwrap(), b"term");
}

/// A guarded stream rejects any whole-file read request, while both end markers remain searchable.
#[test]
fn incremental_large_file_index_without_whole_file_allocation() {
    const FILE_BYTES: usize = 4 * 1024 * 1024;
    struct Guarded<R>(R, usize);
    impl<R: Read> Read for Guarded<R> {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            assert!(bytes.len() <= 16_384);
            self.1 = self.1.max(bytes.len());
            self.0.read(bytes)
        }
    }
    let f = Fixture::new();
    let path = f.root.path().join("large");
    let mut file = File::create(&path).unwrap();
    file.write_all(b"START_MARKER\n").unwrap();
    let block = [b'x'; 16_384];
    for _ in 0..FILE_BYTES / block.len() {
        file.write_all(&block).unwrap();
    }
    file.write_all(b"\nEND_MARKER\n").unwrap();
    drop(file);
    let mut guarded = Guarded(File::open(&path).unwrap(), 0);
    let (hash, size) = digest_reader(&mut guarded, &Budget::new()).unwrap();
    assert_eq!(guarded.1, 16_384);
    assert_eq!(size, FILE_BYTES as u64 + 25);
    let doc = Document {
        digest: hash.clone(),
        revision: hash,
        size,
        ..document(
            "large",
            b"",
            Content::Text {
                path: "large".into(),
                range: None,
            },
        )
    };
    let view = f.view("scope", vec![doc]);
    f.kernel.publish(view.clone(), None).unwrap();
    for query in ["START_MARKER", "END_MARKER"] {
        let result = f.search(Mode::Exact, query, vec![view.clone()], 20);
        assert!(result.complete);
        assert_eq!(result.hits.len(), 1);
    }
    let pin = f.kernel.pin("scope").unwrap();
    assert_eq!(fs::read_dir(pin.path.join("sidecars")).unwrap().count(), 0);
    assert!(!pin.path.join("large").exists());
}

/// Dotfiles are included, ignored text is direct, own caches and symlink targets are excluded.
#[test]
fn directory_inventory_confinement_and_incremental_digests() {
    let f = Fixture::new();
    fs::write(f.root.path().join(".hidden"), b"hidden term").unwrap();
    fs::write(f.root.path().join(".gitignore"), b"ignored.txt\n").unwrap();
    fs::write(f.root.path().join("ignored.txt"), b"readable term").unwrap();
    fs::write(f.root.path().join("binary"), b"\0BINARY_BODY_SECRET").unwrap();
    std::os::unix::fs::symlink(f.store.path(), f.root.path().join("outside")).unwrap();
    let store = f.root.path().join(".retrieval-kernel");
    let kernel = Kernel::new(f.root.path(), &store).unwrap();
    let directory = directory::Directory::new(f.root.path(), &store).unwrap();
    let view = directory.inventory().unwrap();
    assert_eq!(view.documents.len(), 4);
    assert!(view.documents.iter().any(|d| d.key.id == ".hidden"));
    assert!(view.documents.iter().any(|d| d.key.id == "ignored.txt"));
    assert!(
        view.documents
            .iter()
            .any(|d| d.key.id == "binary" && d.content == Content::Unreadable)
    );
    kernel.publish(view.clone(), None).unwrap();
    assert_eq!(view, directory.inventory().unwrap());
    fs::write(f.root.path().join("ignored.txt"), b"changed term").unwrap();
    assert!(
        !kernel
            .search(Query {
                mode: Mode::Exact,
                query: "readable".into(),
                scopes: vec![directory.inventory().unwrap()],
                limit: 20
            })
            .unwrap()
            .complete
    );
}

thread_local! { static ACCESS: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) }; }
/// Test-only direct observation of generation, statistics, and canonical-open boundaries.
pub(crate) fn access(kind: &str, identity: &str) {
    ACCESS.with(|log| log.borrow_mut().push((kind.into(), identity.into())));
}
/// Consume observations for this query thread, keeping concurrent fixture runs independent.
fn take_access() -> Vec<(String, String)> {
    ACCESS.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

/// Count actual Rust allocation requests only during the isolated indexing measurement.
struct AllocationObserver;
static RECORD_ALLOCATIONS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static MAX_ALLOCATION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;
// SAFETY: all allocation and deallocation use the unchanged System allocator contract.
unsafe impl std::alloc::GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        observe_allocation(layout.size());
        unsafe { std::alloc::System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        observe_allocation(layout.size());
        unsafe { std::alloc::System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: std::alloc::Layout) {
        unsafe {
            std::alloc::System.dealloc(pointer, layout);
        }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: std::alloc::Layout, size: usize) -> *mut u8 {
        observe_allocation(size);
        unsafe { std::alloc::System.realloc(pointer, layout, size) }
    }
}
/// Observe a largest allocation against the frozen file-size ceiling, never against subject output.
fn observe_allocation(size: usize) {
    use std::sync::atomic::Ordering;
    if RECORD_ALLOCATIONS.load(Ordering::Relaxed) {
        MAX_ALLOCATION.fetch_max(size, Ordering::Relaxed);
    }
}

/// The actual index path must not allocate the 48 MiB source; peak process RSS stays below 512 MiB.
#[test]
fn large_file_actual_allocations_and_peak_memory() {
    const FILE_BYTES: usize = 48 * 1024 * 1024;
    if std::env::var_os("RETRIEVAL_ALLOCATION_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::large_file_actual_allocations_and_peak_memory",
                "--nocapture",
            ])
            .env("RETRIEVAL_ALLOCATION_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let output = String::from_utf8(output.stdout).unwrap();
        println!(
            "{}",
            output
                .lines()
                .find(|line| line.starts_with("allocation:"))
                .unwrap()
        );
        return;
    }
    let f = Fixture::new();
    // Dictionary initialization is separate from source ingestion; warm it before observing upload allocations.
    f.kernel.publish(f.view("warm", vec![]), None).unwrap();
    let mut file = File::create(f.root.path().join("upload")).unwrap();
    file.write_all(b"START_MARKER\n").unwrap();
    let block = [b'x'; 16_384];
    for _ in 0..FILE_BYTES / block.len() {
        file.write_all(&block).unwrap();
    }
    file.write_all(b"\nEND_MARKER\n").unwrap();
    drop(file);
    let (hash, size) = digest_reader(
        &mut File::open(f.root.path().join("upload")).unwrap(),
        &Budget::new(),
    )
    .unwrap();
    let document = Document {
        digest: hash.clone(),
        revision: hash,
        size,
        ..document(
            "upload",
            b"",
            Content::Text {
                path: "upload".into(),
                range: None,
            },
        )
    };
    let view = f.view("upload", vec![document]);
    use std::sync::atomic::Ordering;
    MAX_ALLOCATION.store(0, Ordering::Relaxed);
    RECORD_ALLOCATIONS.store(true, Ordering::Relaxed);
    f.kernel.publish(view.clone(), None).unwrap();
    RECORD_ALLOCATIONS.store(false, Ordering::Relaxed);
    let maximum = MAX_ALLOCATION.load(Ordering::Relaxed);
    assert!(maximum < FILE_BYTES, "whole-upload allocation: {maximum}");
    for marker in ["START_MARKER", "END_MARKER"] {
        let result = f.search(Mode::Exact, marker, vec![view.clone()], 20);
        assert!(result.complete);
        assert_eq!(result.hits.len(), 1);
    }
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
    assert!(
        usage.ru_maxrss < 512 * 1024,
        "RSS exceeds fixed 512 MiB ceiling"
    );
    println!(
        "allocation: file_bytes={size} maximum_single_allocation={maximum} peak_rss_kib={}",
        usage.ru_maxrss
    );
}

/// Empty direct text still has its supplied title and never gains a sidecar.
#[test]
fn empty_text_retains_title_and_gram_candidates_require_literal_verification() {
    let f = Fixture::new();
    let mut empty = f.text("empty", "");
    empty.title = "searchable title".into();
    let scattered = f.text("scattered", "甲 ASCII 乙");
    let view = f.view("scope", vec![empty, scattered]);
    f.kernel.publish(view.clone(), None).unwrap();
    let found = f.search(Mode::Lexical, "searchable", vec![view.clone()], 20);
    assert_eq!(found.hits[0].key.id, "empty");
    let absent = f.search(Mode::Lexical, "甲乙", vec![view], 20);
    assert!(absent.hits.is_empty());
}

/// Top-k lexical completeness does not certify exhaustive governed enumeration.
#[test]
fn bounded_lexical_enumeration_reports_all_matches() {
    let f = Fixture::new();
    let view = f.view("scope", vec![f.text("a", "term"), f.text("b", "term")]);
    f.kernel.publish(view.clone(), None).unwrap();
    let top = f.search(Mode::Lexical, "term", vec![view.clone()], 1);
    assert!(top.complete);
    assert_eq!(top.coverage.matching_documents, 2);
    assert!(!top.coverage.enumeration_complete);
    let all = f.search(Mode::Lexical, "term", vec![view], 20);
    assert!(all.complete && all.coverage.enumeration_complete);
}

/// Byte-range source units support canonical Item logs without copies or cross-Item false matches.
#[test]
fn canonical_source_units_do_not_join_items_or_copy_scan_text() {
    let f = Fixture::new();
    fs::write(f.root.path().join("items.jsonl"), b"FIRST\nSECOND\n").unwrap();
    let mut first = document(
        "item-1",
        b"FIRST\n",
        Content::Text {
            path: "items.jsonl".into(),
            range: Some(ByteRange { start: 0, end: 6 }),
        },
    );
    first.locator = Some("item-1".into());
    let mut second = document(
        "item-2",
        b"SECOND\n",
        Content::Text {
            path: "items.jsonl".into(),
            range: Some(ByteRange { start: 6, end: 13 }),
        },
    );
    second.locator = Some("item-2".into());
    let view = f.view("scope", vec![first, second]);
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Exact, "FIRST\nSECOND", vec![view.clone()], 20);
    assert!(result.complete && result.hits.is_empty());
    let result = f.search(Mode::Exact, "SECOND", vec![view], 20);
    assert_eq!(
        result.hits[0].locator,
        Locator::Text {
            start: 0,
            end: 6,
            original: Some("item-2".into())
        }
    );
}

/// An exact scan reaches low-ranked Documents and scope merging precedes response truncation.
#[test]
fn scans_reach_low_bm25_documents_and_merge_before_limits() {
    let f = Fixture::new();
    let mut high = f.text("z-high", "needle needle needle");
    high.title = "needle".into();
    let low = f.text("a-low", "irrelevant vocabulary filler needle");
    let high_view = f.view("high", vec![high]);
    let low_view = f.view("low", vec![low]);
    f.kernel.publish(high_view.clone(), None).unwrap();
    f.kernel.publish(low_view.clone(), None).unwrap();
    let lexical = f.search(
        Mode::Lexical,
        "needle",
        vec![high_view.clone(), low_view.clone()],
        1,
    );
    assert_eq!(lexical.hits[0].key.id, "z-high");
    for mode in [Mode::Exact, Mode::Regex] {
        let all = f.search(
            mode,
            "needle",
            vec![high_view.clone(), low_view.clone()],
            20,
        );
        assert!(all.complete && all.hits.iter().any(|h| h.key.id == "a-low"));
        let one = f.search(mode, "needle", vec![high_view.clone(), low_view.clone()], 1);
        assert_eq!(one.hits[0].key.id, "a-low");
        assert_eq!(one.coverage.omitted_matches, 3);
        assert_eq!(
            one,
            f.search(mode, "needle", vec![low_view.clone(), high_view.clone()], 1)
        );
    }
}

/// Machinery mismatches and damaged postings require a fresh rebuild, never a legacy reader.
#[test]
fn committed_identity_and_posting_corruption_require_rebuild() {
    let f = Fixture::new();
    let view = f.view("scope", vec![f.text("source", "term")]);
    let id = f.kernel.publish(view.clone(), None).unwrap();
    let pin = f.kernel.pin("scope").unwrap();
    let index = tantivy::Index::open_in_dir(pin.path.join("index")).unwrap();
    let segment = index.searchable_segment_ids().unwrap()[0];
    let path = pin
        .path
        .join("index")
        .join(format!("{}.idx", segment.uuid_string()));
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 0xff;
    fs::write(&path, bytes).unwrap();
    drop(index);
    drop(pin);
    assert!(
        !f.search(Mode::Lexical, "term", vec![view.clone()], 20)
            .complete
    );
    let repaired = f.kernel.publish(view.clone(), Some(id)).unwrap();
    assert!(
        f.search(Mode::Lexical, "term", vec![view.clone()], 20)
            .complete
    );
    let pin = f.kernel.pin("scope").unwrap();
    let mut manifest = pin.manifest.clone();
    manifest.machinery = "wrong-processor".into();
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let wrong_id = digest(&bytes);
    let old_path = pin.path.clone();
    drop(pin);
    let new_path = f.kernel.scope_path("scope").join(&wrong_id);
    fs::rename(old_path, &new_path).unwrap();
    fs::write(new_path.join("manifest.json"), bytes).unwrap();
    fs::write(f.kernel.scope_path("scope").join("CURRENT"), &wrong_id).unwrap();
    assert_eq!(
        f.kernel
            .search(Query {
                mode: Mode::Exact,
                query: "term".into(),
                scopes: vec![view.clone()],
                limit: 20
            })
            .unwrap_err()
            .code,
        "unavailable"
    );
    assert_ne!(
        repaired,
        f.kernel.publish(view.clone(), Some(wrong_id)).unwrap()
    );
    assert!(f.search(Mode::Exact, "term", vec![view], 20).complete);
}

/// Concurrent directory changes invalidate sidecar hits before the directory faces return them.
#[test]
fn directory_final_revision_check_withholds_changed_sidecars() {
    let f = Fixture::new();
    fs::write(f.root.path().join("binary"), b"\0old bytes").unwrap();
    let directory = directory::Directory::new(f.root.path(), f.store.path()).unwrap();
    f.kernel
        .publish(directory.inventory().unwrap(), None)
        .unwrap();
    let result = directory
        .search_inner(&f.kernel, Mode::Exact, "binary".into(), 20, || {
            fs::write(f.root.path().join("binary"), b"\0new bytes").unwrap();
        })
        .unwrap();
    assert!(!result.complete && result.hits.is_empty());
    assert_eq!(result.coverage.reasons["directory-changed"], 1);
}

/// The scan baseline must preserve a UTF-8 BOM rather than strip or transcode it.
#[test]
fn regex_preserves_utf8_bom_and_canonical_offsets() {
    let f = Fixture::new();
    let view = f.view("scope", vec![f.text("bom", "\u{feff}needle\n")]);
    f.kernel.publish(view.clone(), None).unwrap();
    assert!(
        f.search(Mode::Regex, "^needle", vec![view.clone()], 20)
            .hits
            .is_empty()
    );
    let found = f.search(Mode::Regex, "needle", vec![view], 20);
    assert_eq!(
        found.hits[0].locator,
        Locator::Text {
            start: 3,
            end: 9,
            original: None
        }
    );
}

/// Oversized escaped Markdown and response payloads yield truthful resource-limited coverage.
#[test]
fn sidecar_and_output_byte_limits_are_explicit() {
    let f = Fixture::new();
    let mut oversized = document("binary", b"body", Content::Unreadable);
    oversized
        .metadata
        .insert("blob".into(), "\u{1}".repeat(16_380));
    let view = f.view("sidecar", vec![oversized]);
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Exact, "blob", vec![view], 20);
    assert!(!result.complete && result.hits.is_empty());
    assert_eq!(
        f.kernel.pin("sidecar").unwrap().manifest.documents[0].status,
        TextStatus::ResourceLimited
    );
    let mut scopes = vec![];
    for scope in ["a", "b"] {
        let mut docs = vec![];
        for n in 0..200 {
            let mut doc = f.text(&format!("{scope}-{n:03}"), "term");
            doc.metadata.insert("blob".into(), "x".repeat(16_380));
            docs.push(doc);
        }
        let view = f.view(scope, docs);
        f.kernel.publish(view.clone(), None).unwrap();
        scopes.push(view);
    }
    let result = f.search(Mode::Lexical, "term", scopes, 400);
    assert!(
        !result.complete
            && !result.coverage.matches_complete
            && !result.coverage.enumeration_complete
    );
    assert_eq!(result.coverage.matching_documents, 400);
    assert_eq!(result.coverage.omitted_matches + result.hits.len(), 400);
    assert!(serde_json::to_vec(&result).unwrap().len() < 8 * 1024 * 1024);
    assert_eq!(result.coverage.reasons["output-limit"], 1);
}

/// Directory faces reject malformed queries before computing any canonical digest.
#[test]
fn directory_query_validation_precedes_inventory_reads() {
    let f = Fixture::new();
    fs::write(f.root.path().join("source"), b"term").unwrap();
    let directory = directory::Directory::new(f.root.path(), f.store.path()).unwrap();
    take_access();
    for (mode, query) in [(Mode::Regex, "(?=term)"), (Mode::Exact, "")] {
        assert_eq!(
            directory
                .search(&f.kernel, mode, query.into(), 20)
                .unwrap_err()
                .code,
            "invalid-request"
        );
    }
    assert!(take_access().is_empty());
}

/// Explicit LF escapes are unsupported even inside classes; escaped backslash-n remains ordinary text.
#[test]
fn regex_explicit_lf_in_classes_is_rejected() {
    let f = Fixture::new();
    let error = f
        .kernel
        .search(Query {
            mode: Mode::Regex,
            query: r"[\n ]+".into(),
            scopes: vec![f.view("missing", vec![])],
            limit: 20,
        })
        .unwrap_err();
    assert_eq!(error.code, "invalid-request");
    let view = f.view("scope", vec![f.text("literal-escape", r"\n")]);
    f.kernel.publish(view.clone(), None).unwrap();
    assert_eq!(f.search(Mode::Regex, r"\\n", vec![view], 20).hits.len(), 1);
}

/// Cancellation keeps unchanged identity metadata discoverable while reporting partial indexing.
#[test]
fn stopped_rebuild_keeps_valid_identity_sidecar_discovery() {
    let f = Fixture::new();
    let binary = document("binary", b"bytes", Content::Unreadable);
    let initial = f.view("scope", vec![binary.clone()]);
    let id = f.kernel.publish(initial, None).unwrap();
    let updated = f.view("scope", vec![binary, f.text("new", "term")]);
    let mut budget = Budget::new();
    budget.cancelled = true;
    f.kernel
        .publish_inner(updated.clone(), Some(id), &budget, INDEX_BYTES, |_| Ok(()))
        .unwrap();
    let result = f.search(Mode::Exact, "binary", vec![updated], 20);
    assert!(!result.complete && result.hits.iter().any(|h| h.key.id == "binary"));
    assert_eq!(result.coverage.unsupported_bodies, 1);
}

/// Decoded canonical Item text is transient input, with no scan-text copy in the generation.
#[test]
fn adapter_text_is_direct_transient_and_verified() {
    let f = Fixture::new();
    let text = "hello\nworld 搜索 検索機能を改善しました。";
    let mut doc = document(
        "item",
        text.as_bytes(),
        Content::InlineText {
            text: Some(text.into()),
        },
    );
    doc.locator = Some("item:1".into());
    let view = f.view("scope", vec![doc]);
    let first = f.kernel.publish(view.clone(), None).unwrap();
    assert_eq!(
        f.kernel.publish(view.clone(), Some(first.clone())).unwrap(),
        first
    );
    let pin = f.kernel.pin("scope").unwrap();
    let stored = fs::read_to_string(pin.path.join("manifest.json")).unwrap();
    assert!(!stored.contains("hello") && !stored.contains("world"));
    assert!(matches!(
        pin.manifest.documents[0].document.content,
        Content::InlineText { text: None }
    ));
    assert_eq!(fs::read_dir(pin.path.join("sidecars")).unwrap().count(), 0);
    drop(pin);
    for mode in [Mode::Lexical, Mode::Exact, Mode::Regex] {
        let result = f.search(mode, "world", vec![view.clone()], 20);
        assert!(result.complete);
        assert_eq!(result.hits[0].key.id, "item");
        assert_eq!(result.hits[0].representation, "text");
    }
    assert_eq!(
        f.search(Mode::Exact, "hello\nworld", vec![view.clone()], 20)
            .hits
            .len(),
        1
    );
    let mut changed = view.clone();
    changed.documents[0].content = Content::InlineText {
        text: Some("other text, same byte length?".into()),
    };
    changed.documents[0].size = "other text, same byte length?".len() as u64;
    changed.documents[0].digest = digest(b"other text, same byte length?");
    changed.documents[0].revision = "2".into();
    let stale = f.search(Mode::Exact, "world", vec![changed], 20);
    assert!(!stale.complete && stale.hits.is_empty());
    let mut unavailable = view;
    unavailable.documents[0].content = Content::Unavailable;
    f.kernel.publish(unavailable.clone(), Some(first)).unwrap();
    assert!(
        !f.search(Mode::Exact, "world", vec![unavailable], 20)
            .complete
    );
}

/// Language detection includes canonical titles even when direct text is empty.
#[test]
fn empty_body_uses_cjk_title_language() {
    let f = Fixture::new();
    let mut doc = f.text("empty-title", "");
    doc.title = "検索機能を改善しました。".into();
    let view = f.view("scope", vec![doc]);
    f.kernel.publish(view.clone(), None).unwrap();
    let result = f.search(Mode::Lexical, "検索", vec![view], 20);
    assert_eq!(result.hits.len(), 1);
    assert!(matches!(result.hits[0].locator, Locator::Title { .. }));
}

/// Title and Hangul one-character fallback use the selected Document's query settings.
#[test]
fn title_and_hangul_character_fallback() {
    let f = Fixture::new();
    let mut title = f.text("title-fallback", "");
    title.title = "測試".into();
    let korean = f.text("korean", "한글");
    let view = f.view("scope", vec![title, korean]);
    f.kernel.publish(view.clone(), None).unwrap();
    let found = f.search(Mode::Lexical, "測", vec![view.clone()], 20);
    assert_eq!(found.hits[0].key.id, "title-fallback");
    assert!(matches!(found.hits[0].locator, Locator::Title { .. }));
    assert_eq!(
        f.search(Mode::Lexical, "한", vec![view], 20).hits[0].key.id,
        "korean"
    );
}

/// Valid foreign engine files cannot be combined with another scope's committed inventory.
#[test]
fn engine_commit_payload_binds_the_scope_generation() {
    let f = Fixture::new();
    let a = f.view("a", vec![f.text("a", "term")]);
    let b = f.view("b", vec![f.text("b", "term PRIVATE_MARKER")]);
    f.kernel.publish(a.clone(), None).unwrap();
    f.kernel.publish(b, None).unwrap();
    let a_pin = f.kernel.pin("a").unwrap();
    let b_pin = f.kernel.pin("b").unwrap();
    let foreign = fs::read(b_pin.path.join("index/meta.json")).unwrap();
    fs::write(a_pin.path.join("index/meta.json"), foreign).unwrap();
    drop(a_pin);
    drop(b_pin);
    let result = f.search(Mode::Lexical, "term", vec![a], 20);
    assert!(!result.complete && result.hits.is_empty());
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("PRIVATE_MARKER")
    );
}

// A named filesystem race runs on this test's thread, immediately before the real syscall.
thread_local! {
    static DIRECTORY_FAULT: std::cell::RefCell<Option<(&'static str, std::path::PathBuf)>> = const { std::cell::RefCell::new(None) };
}
/// Remove one enumerated entry at the boundary; no mocked return value is used.
pub(crate) fn directory_boundary(stage: &str, path: &Path) {
    DIRECTORY_FAULT.with(|fault| {
        let mut fault = fault.borrow_mut();
        if fault
            .as_ref()
            .is_some_and(|(selected, target)| *selected == stage && target == path)
        {
            fs::remove_file(path).unwrap();
            *fault = None;
        }
    });
}
/// Disappearance before stat or open is counted once without stopping the readable inventory.
#[test]
fn directory_stat_and_open_races_are_coverage_only() {
    for stage in ["stat", "open"] {
        let f = Fixture::new();
        f.text("public", "needle");
        f.text("SECRET_PRIVATE", "needle");
        DIRECTORY_FAULT.with(|fault| {
            *fault.borrow_mut() = Some((stage, f.root.path().join("SECRET_PRIVATE")))
        });
        let directory = crate::directory::Directory::new(f.root.path(), f.store.path()).unwrap();
        let view = directory.inventory().unwrap();
        assert_eq!(view.documents.len(), 1);
        assert_eq!(view.documents[0].key.id, "public");
        assert_eq!(view.unavailable_objects, 1);
        assert!(
            !serde_json::to_string(&view)
                .unwrap()
                .contains("SECRET_PRIVATE")
        );
        f.kernel.publish(view.clone(), None).unwrap();
        let result = f.search(Mode::Exact, "needle", vec![view], 20);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.coverage.admitted_objects, 2);
        assert!(!result.complete);
        assert_eq!(result.coverage.reasons.get("source-unavailable"), Some(&1));
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SECRET_PRIVATE")
        );
    }
}

/// A failed publication releases its lock even while an unrelated child holds inherited descriptors.
#[test]
fn failed_publication_releases_inherited_writer_lock() {
    let f = Fixture::new();
    let view = f.view("scope", vec![f.text("source", "term")]);
    let mut pipe = [0; 2];
    // SAFETY: initialized descriptor storage; the child below uses only async-signal-safe calls.
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    for fd in pipe {
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    let mut child = -1;
    let failure =
        f.kernel
            .publish_inner(view.clone(), None, &Budget::new(), INDEX_BYTES, |stage| {
                if stage == "prepare" {
                    // The child keeps the inherited writer descriptor open until the parent retries.
                    child = unsafe { libc::fork() };
                    assert!(child >= 0);
                    if child == 0 {
                        unsafe {
                            libc::close(pipe[1]);
                            let mut byte = 0u8;
                            libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1);
                            libc::_exit(0);
                        }
                    }
                    return Err(error("io", "simulated publication stop"));
                }
                Ok(())
            });
    let retry = f.kernel.publish(view, None);
    let mut status = 0;
    unsafe {
        let byte = 1u8;
        libc::write(pipe[1], (&byte as *const u8).cast(), 1);
        libc::close(pipe[0]);
        libc::close(pipe[1]);
        assert_eq!(libc::waitpid(child, &mut status, 0), child);
    }
    assert_eq!(status, 0);
    assert_eq!(failure.unwrap_err().code, "io");
    assert!(retry.is_ok(), "retry after failed publication: {retry:?}");
}
