//! One immutable, tombstone-free publication tuple per scope.
use crate::model::*;
use crate::text::*;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tantivy::schema::{Field, IndexRecordOption, STORED, Schema, TextFieldIndexing, TextOptions};
use tantivy::{Index, TantivyDocument};

/// Output-changing machinery is part of every derived generation identity.
pub(crate) fn machinery() -> String {
    digest(format!("schema=5;text-ranges=disjoint-v1;source-representation=v1;word-filter=any-alnum;token-bytes=49152;sidecar=identity-markdown-v1;chunks={CHUNK_BYTES};score=max-bm25-title2-gram0.1;normalization=lowercase;grams=1-3;dictionary={DICTIONARY_SHA256};lock={}", digest(include_bytes!("../../../Cargo.lock"))).as_bytes())
}
/// Identity-only phase-1 processor; changes require fresh representations.
pub(crate) const PROCESSOR: &str = "identity-markdown-v1";

/// All members of a committed scope generation are bound by this manifest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub machinery: String,
    pub nonce: u128,
    pub scope: String,
    pub documents: Vec<Record>,
    pub unavailable_objects: usize,
}
/// Derived state for one canonical source revision.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    pub document: Document,
    pub status: TextStatus,
    pub language: String,
    pub representation_digest: String,
    pub sidecar: Option<String>,
    pub units: Vec<Unit>,
}
/// A searchable unit preserves admitted text or identity metadata boundaries.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct Unit {
    pub field: Option<String>,
    pub start: u64,
    pub end: u64,
}

/// A reader pin protects the exact committed generation during concurrent publication.
pub(crate) struct Pin {
    pub id: String,
    pub path: PathBuf,
    pub manifest: Manifest,
    _lock: LockFile,
}

/// Shared kernel owner. Source and derived storage roots are fixed at process startup.
pub struct Kernel {
    pub(crate) source: File,
    pub(crate) store: PathBuf,
}
impl Kernel {
    /// Bind the admitted source root and caller-owned derived storage root.
    pub fn new(source: &Path, store: &Path) -> Result<Self> {
        let source = File::open(source).map_err(io_error)?;
        if !source.metadata().map_err(io_error)?.is_dir() {
            return Err(error("invalid-request", "source root must be a directory"));
        }
        private_dir(store)?;
        Ok(Self {
            source,
            store: fs::canonicalize(store).map_err(io_error)?,
        })
    }
    /// Scope identifiers select safe hashed storage locations, never caller-provided paths.
    pub(crate) fn scope_path(&self, scope: &str) -> PathBuf {
        self.store.join(digest(scope.as_bytes()))
    }
    /// Pin only a named scope. The scope lock closes the pointer-to-reader-pin cleanup race.
    pub(crate) fn pin(&self, scope: &str) -> Result<Pin> {
        #[cfg(test)]
        crate::tests::access("generation-open", scope);
        let path = self.scope_path(scope);
        if !path.is_dir() {
            return Err(error(
                "unavailable",
                "named scope has no committed generation",
            ));
        }
        let lock = lock_file(&path.join("LOCK"))?;
        FileExt::lock_shared(&lock.0).map_err(io_error)?;
        let id = current(&path)?
            .ok_or_else(|| error("unavailable", "named scope has no committed generation"))?;
        let generation = path.join(&id);
        let reader = lock_file(&generation.join("READERS"))?;
        FileExt::lock_shared(&reader.0).map_err(io_error)?;
        let manifest_bytes = bounded_read(&generation.join("manifest.json"), FRAME_BYTES)?;
        if digest(&manifest_bytes) != id {
            return Err(error(
                "unavailable",
                "committed manifest integrity failed; rebuild scope",
            ));
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| error("unavailable", "committed manifest invalid; rebuild scope"))?;
        if manifest.scope != scope || manifest.machinery != machinery() {
            return Err(error(
                "unavailable",
                "index identity mismatch; rebuild scope",
            ));
        }
        validate_view(
            &ScopeView {
                scope: manifest.scope.clone(),
                unavailable_objects: manifest.unavailable_objects,
                documents: manifest
                    .documents
                    .iter()
                    .map(|r| r.document.clone())
                    .collect(),
            },
            false,
        )
        .map_err(|_| error("unavailable", "committed inventory invalid; rebuild scope"))?;
        for record in &manifest.documents {
            let ceiling = if record.sidecar.is_some() {
                SIDECAR_BYTES as u64
            } else if let Content::Representation { size, .. } = &record.document.content {
                *size
            } else {
                record.document.size
            };
            if !["zh", "ja", "unicode"].contains(&record.language.as_str())
                || record.units.len() > 256
                || record
                    .units
                    .iter()
                    .any(|u| u.end < u.start || u.end > ceiling)
                || record.sidecar.as_ref().is_some_and(|p| {
                    *p != cache_path(&record.document, &record.representation_digest)
                })
                || (record.sidecar.is_none()
                    && matches!(
                        record.document.content,
                        Content::Text { .. }
                            | Content::InlineText { .. }
                            | Content::Representation { .. }
                    )
                    && record.units != text_units(&record.document))
            {
                return Err(error(
                    "unavailable",
                    "committed representation identity invalid; rebuild scope",
                ));
            }
        }
        Ok(Pin {
            id,
            path: generation,
            manifest,
            _lock: reader,
        })
    }
    /// Inspect the committed pointer without opening another scope or canonical content.
    pub fn generation(&self, scope: &str) -> Result<Option<String>> {
        validate_scope(scope)?;
        current(&self.scope_path(scope))
    }
    /// Rebuild one exact inventory into a fresh generation. Updates and removals are inventory replacements.
    pub fn publish(&self, view: ScopeView, expected: Option<String>) -> Result<String> {
        self.publish_inner(view, expected, &Budget::new(), INDEX_BYTES, |_| Ok(()))
    }
    /// Build and publish with a checkpoint callback used by in-module crash fixtures.
    pub(crate) fn publish_inner(
        &self,
        mut view: ScopeView,
        expected: Option<String>,
        budget: &Budget,
        disk_limit: u64,
        mut checkpoint: impl FnMut(&str) -> Result<()>,
    ) -> Result<String> {
        validate_view(&view, true)?;
        for d in &view.documents {
            if let Content::InlineText { text: Some(text) } = &d.content
                && digest(text.as_bytes()) != d.digest
            {
                return Err(error(
                    "conflict",
                    "canonical adapter text digest disagrees with its revision",
                ));
            }
        }
        view.documents.sort_by(|a, b| a.key.cmp(&b.key));
        let scope_path = self.scope_path(&view.scope);
        private_dir(&scope_path)?;
        let writer_lock = lock_file(&scope_path.join("LOCK"))?;
        FileExt::try_lock_exclusive(&writer_lock.0)
            .map_err(|_| error("conflict", "scope writer already active"))?;
        let previous = current(&scope_path)?;
        if previous != expected {
            return Err(error("conflict", "expected scope generation changed"));
        }
        let old = previous
            .as_ref()
            .and_then(|id| {
                bounded_read(&scope_path.join(id).join("manifest.json"), FRAME_BYTES)
                    .ok()
                    .filter(|b| digest(b) == *id)
            })
            .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok())
            .filter(|m| m.machinery == machinery());
        if let Some(old) = &old {
            for next in &view.documents {
                if let Some(prior) = old
                    .documents
                    .iter()
                    .find(|r| r.document.key == next.key && r.document.revision == next.revision)
                    && !same_revision_identity(&prior.document, next)
                {
                    return Err(error(
                        "conflict",
                        "canonical identity changed without a new revision",
                    ));
                }
            }
        }
        if let (Some(old), Some(id)) = (&old, &previous) {
            let same = old.unavailable_objects == view.unavailable_objects
                && old
                    .documents
                    .iter()
                    .map(|r| r.document.clone())
                    .eq(view.documents.iter().map(Document::identity));
            let healthy = old.documents.iter().all(|r| {
                matches!(
                    r.status,
                    TextStatus::TextExtracted | TextStatus::Unsupported
                ) && r.sidecar.as_ref().is_none_or(|p| {
                    bounded_read(&scope_path.join(id).join(p), SIDECAR_BYTES)
                        .is_ok_and(|b| digest(&b) == r.representation_digest)
                })
            });
            if same
                && healthy
                && Index::open_in_dir(scope_path.join(id).join("index")).is_ok_and(|i| {
                    i.schema() == schema().0
                        && i.load_metas()
                            .is_ok_and(|m| m.payload.as_deref() == Some(id.as_str()))
                        && i.validate_checksum()
                            .is_ok_and(|damaged| damaged.is_empty())
                })
            {
                collect(&scope_path, id)?;
                FileExt::unlock(&writer_lock.0).map_err(io_error)?;
                return Ok(id.clone());
            }
        }
        // A staging directory is derived state. A crash can leave it, but queries never read it.
        for entry in fs::read_dir(&scope_path).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map_err(io_error)?.is_dir()
                && name
                    .strip_prefix(".stage-")
                    .is_some_and(|suffix| suffix.bytes().all(|b| b.is_ascii_digit()))
            {
                fs::remove_dir_all(entry.path()).map_err(io_error)?;
            }
        }
        let stage_path = scope_path.join(format!(".stage-{}", std::process::id()));
        if stage_path.exists() {
            fs::remove_dir_all(&stage_path).map_err(io_error)?;
        }
        private_dir(&stage_path)?;
        let stage = Stage(stage_path.clone());
        private_dir(&stage_path.join("sidecars"))?;
        private_dir(&stage_path.join("index"))?;
        checkpoint("prepare")?;
        let (schema, fields) = schema();
        let index = Index::create_in_dir(stage_path.join("index"), schema).map_err(io_error)?;
        register(&index)?;
        let mut writer = index
            .writer_with_num_threads::<TantivyDocument>(1, WRITER_BYTES)
            .map_err(io_error)?;
        // Fresh publications contain no tombstones; disabling merges avoids duplicate temporary segment bytes.
        writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        let mut records = Vec::with_capacity(view.documents.len());
        let mut indexed_bytes = 0u64;
        for (number, document) in view.documents.into_iter().enumerate() {
            let searchable = matches!(
                document.content,
                Content::Text { .. } | Content::InlineText { .. } | Content::Representation { .. }
            );
            let representation_digest = match &document.content {
                Content::Representation { digest, .. } => digest.clone(),
                _ if searchable => document.digest.clone(),
                _ => String::new(),
            };
            let units = if searchable {
                text_units(&document)
            } else {
                vec![]
            };
            let mut record = Record {
                document,
                status: TextStatus::Failed,
                language: "unicode".into(),
                representation_digest,
                sidecar: None,
                units,
            };
            let process = (|| -> Result<()> {
                budget.check()?;
                let (mut input, detected) = match &record.document.content {
                    Content::Text { path, range } => {
                        let mut source =
                            TextFile::new(open_source(&self.source, path)?, range.as_ref())?;
                        let (hash, size, _) = inspect(&mut source, budget)?;
                        if hash != record.document.digest || size != record.document.size {
                            return Err(error(
                                "conflict",
                                "canonical bytes disagree with admitted revision",
                            ));
                        }
                        record.representation_digest = hash;
                        record.units = text_units(&record.document);
                        record.status = TextStatus::TextExtracted;
                        let detected = detected_language(&mut source, &record.units, budget)?;
                        (source, detected)
                    }
                    Content::InlineText { text } => {
                        let mut source = TextFile::inline(text)?;
                        let (hash, size, _) = inspect(&mut source, budget)?;
                        if hash != record.document.digest || size != record.document.size {
                            return Err(error(
                                "conflict",
                                "adapter text disagrees with admitted revision",
                            ));
                        }
                        record.representation_digest = hash;
                        record.units = text_units(&record.document);
                        record.status = TextStatus::TextExtracted;
                        let detected = detected_language(&mut source, &record.units, budget)?;
                        (source, detected)
                    }
                    Content::Representation {
                        path, digest, size, ..
                    } => {
                        let mut source = TextFile::new(open_source(&self.source, path)?, None)?;
                        let (actual_digest, actual_size, _) = inspect(&mut source, budget)?;
                        if actual_digest != *digest || actual_size != *size {
                            return Err(error(
                                "conflict",
                                "source representation integrity changed",
                            ));
                        }
                        record.representation_digest = actual_digest;
                        record.units = text_units(&record.document);
                        record.status = TextStatus::TextExtracted;
                        let detected = detected_language(&mut source, &record.units, budget)?;
                        (source, detected)
                    }
                    Content::Unreadable => {
                        let (bytes, units) = sidecar(&record.document)?;
                        let hash = digest(&bytes);
                        let relative = cache_path(&record.document, &hash);
                        let destination = stage_path.join(&relative);
                        // Reuse only byte-verified immutable entries. Missing or corrupt entries are rebuilt.
                        let reusable = previous
                            .as_ref()
                            .map(|id| scope_path.join(id).join(&relative))
                            .filter(|p| {
                                bounded_read(p, SIDECAR_BYTES).is_ok_and(|b| digest(&b) == hash)
                            });
                        if let Some(source) = reusable {
                            fs::hard_link(source, &destination).map_err(io_error)?;
                        } else {
                            write_sync(&destination, &bytes)?;
                        }
                        record.sidecar = Some(relative);
                        record.representation_digest = hash;
                        record.units = units;
                        record.status = TextStatus::Unsupported;
                        let mut source =
                            TextFile::new(File::open(destination).map_err(io_error)?, None)?;
                        let (_, _, lang) = inspect(&mut source, budget)?;
                        (source, lang.to_string())
                    }
                    Content::Unavailable => {
                        return Err(error("unavailable", "canonical representation unavailable"));
                    }
                };
                record.language = record.document.language.clone().unwrap_or_else(|| {
                    if detected == "ja" || record.document.title.chars().any(is_kana) {
                        "ja".into()
                    } else if detected == "zh" || record.document.title.chars().any(is_han) {
                        "zh".into()
                    } else {
                        "unicode".into()
                    }
                });
                analyzer(&record.language)?;
                let mut ordinal = 0;
                for (unit_id, unit) in record.units.iter().enumerate() {
                    use std::io::{Seek, SeekFrom};
                    input.seek(SeekFrom::Start(unit.start)).map_err(io_error)?;
                    let mut chunks = Chunks::new((&mut input).take(unit.end - unit.start));
                    while let Some((start, text)) = chunks.next(budget)? {
                        indexed_bytes += (text.len() + record.document.title.len()) as u64;
                        // Reserve room for the bounded writer and segment encoding before admitting more input.
                        if indexed_bytes
                            .saturating_mul(8)
                            .saturating_add(WRITER_BYTES as u64 * 2)
                            > disk_limit
                        {
                            return Err(error(
                                "resource-limited",
                                "temporary index disk budget exhausted",
                            ));
                        }
                        let mut chunk = TantivyDocument::new();
                        chunk.add_u64(fields.document, number as u64);
                        chunk.add_u64(fields.ordinal, ordinal);
                        chunk.add_u64(fields.start, unit.start + start);
                        chunk.add_u64(fields.end, unit.start + start + text.len() as u64);
                        chunk.add_u64(fields.unit, unit_id as u64);
                        let (body, title) = fields.language(&record.language);
                        chunk.add_text(body, &text);
                        chunk.add_text(title, &record.document.title);
                        let gram_text: String = text.chars().filter(|&c| is_cjk(c)).collect();
                        chunk.add_text(fields.grams, &gram_text);
                        chunk.add_text(
                            fields.title_grams,
                            record
                                .document
                                .title
                                .chars()
                                .filter(|&c| is_cjk(c))
                                .collect::<String>(),
                        );
                        writer.add_document(chunk).map_err(io_error)?;
                        ordinal += 1;
                        checkpoint("chunk")?;
                    }
                }
                if let Content::Text { path, range } = &record.document.content {
                    let mut now = TextFile::new(open_source(&self.source, path)?, range.as_ref())?;
                    let (hash, size) = digest_reader(&mut now, budget)?;
                    if hash != record.document.digest || size != record.document.size {
                        return Err(error(
                            "conflict",
                            "canonical source changed during indexing",
                        ));
                    }
                }
                if let Content::Representation {
                    path, digest, size, ..
                } = &record.document.content
                {
                    let mut now = TextFile::new(open_source(&self.source, path)?, None)?;
                    let (actual_digest, actual_size) = digest_reader(&mut now, budget)?;
                    if actual_digest != *digest || actual_size != *size {
                        return Err(error(
                            "conflict",
                            "source representation changed during indexing",
                        ));
                    }
                }
                Ok(())
            })();
            if let Err(e) = process {
                if e.code == "conflict" {
                    return Err(e);
                }
                record.status = match e.code.as_str() {
                    "partial" => TextStatus::Partial,
                    "resource-limited" => TextStatus::ResourceLimited,
                    "unavailable" | "failed" => TextStatus::Failed,
                    _ => return Err(e),
                };
            }
            // Stopping an unchanged unreadable source must not discard its verified identity cache.
            if record.sidecar.is_none()
                && matches!(record.document.content, Content::Unreadable)
                && matches!(
                    record.status,
                    TextStatus::Partial | TextStatus::ResourceLimited
                )
                && let (Some(old), Some(id)) = (&old, &previous)
                && let Some(prior) = old.documents.iter().find(|r| r.document == record.document)
                && let Some(relative) = &prior.sidecar
                && bounded_read(&scope_path.join(id).join(relative), SIDECAR_BYTES)
                    .is_ok_and(|b| digest(&b) == prior.representation_digest)
            {
                fs::hard_link(
                    scope_path.join(id).join(relative),
                    stage_path.join(relative),
                )
                .map_err(io_error)?;
                record.sidecar = Some(relative.clone());
                record.representation_digest = prior.representation_digest.clone();
                record.units = prior.units.clone();
                record.language = prior.language.clone();
            }
            record.document = record.document.identity();
            records.push(record);
        }
        let manifest = Manifest {
            machinery: machinery(),
            nonce: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io_error)?
                .as_nanos(),
            scope: view.scope,
            documents: records,
            unavailable_objects: view.unavailable_objects,
        };
        let bytes = serde_json::to_vec(&manifest).map_err(io_error)?;
        if bytes.len() > FRAME_BYTES {
            return Err(error(
                "resource-limited",
                "generation inventory exceeds byte budget",
            ));
        }
        let generation = digest(&bytes);
        checkpoint("inventory")?;
        let mut prepared = writer.prepare_commit().map_err(io_error)?;
        prepared.set_payload(&generation);
        prepared.commit().map_err(io_error)?;
        writer.wait_merging_threads().map_err(io_error)?;
        checkpoint("commit")?;
        drop(index);
        if directory_bytes(&stage_path)? > disk_limit {
            return Err(error(
                "resource-limited",
                "temporary index disk budget exhausted",
            ));
        }
        if directory_bytes(&stage_path)?.saturating_add(bytes.len() as u64) > disk_limit {
            return Err(error(
                "resource-limited",
                "generation manifest exceeds temporary disk budget",
            ));
        }
        write_sync(&stage_path.join("manifest.json"), &bytes)?;
        write_sync(&stage_path.join("READERS"), b"")?;
        sync_tree(&stage_path)?;
        checkpoint("durable")?;
        let final_path = scope_path.join(&generation);
        fs::rename(&stage_path, &final_path).map_err(io_error)?;
        sync_dir(&scope_path)?;
        checkpoint("before-pointer")?;
        let pointer = scope_path.join(".CURRENT.new");
        write_sync(&pointer, generation.as_bytes())?;
        fs::rename(pointer, scope_path.join("CURRENT")).map_err(io_error)?;
        sync_dir(&scope_path)?;
        checkpoint("after-pointer")?;
        drop(stage);
        collect(&scope_path, &generation)?;
        // Release the completed writer explicitly; CLOEXEC descriptors can briefly survive another thread's fork.
        FileExt::unlock(&writer_lock.0).map_err(io_error)?;
        Ok(generation)
    }
    /// Remove unreferenced derived generations after readers release their pins.
    pub fn collect(&self, scope: &str) -> Result<()> {
        validate_scope(scope)?;
        let path = self.scope_path(scope);
        let lock = lock_file(&path.join("LOCK"))?;
        if FileExt::try_lock_exclusive(&lock.0).is_ok()
            && let Some(id) = current(&path)?
        {
            collect(&path, &id)?;
        }
        Ok(())
    }
}

/// Persisted field addresses; text is indexed but never stored as a second scan-text body.
pub(crate) struct Fields {
    pub document: Field,
    pub ordinal: Field,
    pub start: Field,
    pub end: Field,
    pub unit: Field,
    pub bodies: [Field; 3],
    pub titles: [Field; 3],
    pub grams: Field,
    pub title_grams: Field,
}
impl Fields {
    /// Resolve one Document's selected language fields.
    pub fn language(&self, language: &str) -> (Field, Field) {
        let i = match language {
            "zh" => 0,
            "ja" => 1,
            _ => 2,
        };
        (self.bodies[i], self.titles[i])
    }
}
/// One schema with separate analyzer fields, never separate ranking implementations.
pub(crate) fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let document = b.add_u64_field("document", STORED);
    let ordinal = b.add_u64_field("ordinal", STORED);
    let start = b.add_u64_field("start", STORED);
    let end = b.add_u64_field("end", STORED);
    let unit = b.add_u64_field("unit", STORED);
    let mut bodies = Vec::new();
    let mut titles = Vec::new();
    for language in ["zh", "ja", "unicode"] {
        let options = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(language)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        );
        bodies.push(b.add_text_field(&format!("body_{language}"), options.clone()));
        titles.push(b.add_text_field(&format!("title_{language}"), options));
    }
    let title_grams = b.add_text_field(
        "title_grams",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("grams")
                .set_index_option(IndexRecordOption::WithFreqs),
        ),
    );
    let grams = b.add_text_field(
        "grams",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("grams")
                .set_index_option(IndexRecordOption::WithFreqs),
        ),
    );
    (
        b.build(),
        Fields {
            document,
            ordinal,
            start,
            end,
            unit,
            bodies: bodies.try_into().unwrap(),
            titles: titles.try_into().unwrap(),
            grams,
            title_grams,
        },
    )
}
/// Register the exact analyzer identities used by indexing and queries.
pub(crate) fn register(index: &Index) -> Result<()> {
    for language in ["zh", "ja", "unicode"] {
        index.tokenizers().register(language, analyzer(language)?);
    }
    use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
    index.tokenizers().register(
        "grams",
        TextAnalyzer::builder(NgramTokenizer::new(1, 3, false).map_err(io_error)?)
            .filter(LowerCaser)
            .build(),
    );
    Ok(())
}
/// Validate an opaque scope before selecting any storage path.
pub(crate) fn validate_scope(scope: &str) -> Result<()> {
    if scope.is_empty() || scope.len() > 1024 {
        Err(error(
            "invalid-request",
            "scope identifier must be nonempty and bounded",
        ))
    } else {
        Ok(())
    }
}

/// Convert the adapter's direct-text ranges into persisted searchable units.
fn text_units(document: &Document) -> Vec<Unit> {
    let mut units: Vec<_> = document
        .searchable_ranges()
        .into_iter()
        .map(|range| Unit {
            field: None,
            start: range.start,
            end: range.end,
        })
        .collect();
    if units.is_empty() {
        units.push(Unit {
            field: None,
            start: 0,
            end: 0,
        });
    }
    units
}

/// Select one analyzer from title plus only the caller-declared searchable ranges.
fn detected_language(
    input: &mut (impl Read + std::io::Seek),
    units: &[Unit],
    budget: &Budget,
) -> Result<String> {
    use std::io::SeekFrom;
    let mut detected = "unicode";
    for unit in units {
        input.seek(SeekFrom::Start(unit.start)).map_err(io_error)?;
        let mut selected = (&mut *input).take(unit.end - unit.start);
        let (_, _, language) = inspect(&mut selected, budget).map_err(|failure| {
            if failure.code == "failed" {
                error(
                    "invalid-request",
                    "text range must preserve canonical UTF-8 boundaries",
                )
            } else {
                failure
            }
        })?;
        if language == "ja" {
            detected = "ja";
            break;
        }
        if language == "zh" {
            detected = "zh";
        }
    }
    input.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok(detected.to_string())
}

/// Validate the admission boundary before any canonical access or index mutation.
pub(crate) fn validate_view(view: &ScopeView, require_text: bool) -> Result<()> {
    validate_scope(&view.scope)?;
    if view.unavailable_objects > DOCUMENT_LIMIT
        || view.documents.len() > DOCUMENT_LIMIT.saturating_sub(view.unavailable_objects)
        || serde_json::to_vec(view).map_err(io_error)?.len() > FRAME_BYTES
    {
        return Err(error("invalid-request", "scope inventory exceeds budget"));
    }
    let mut keys = BTreeSet::new();
    for d in &view.documents {
        if d.key.namespace.is_empty()
            || d.key.id.is_empty()
            || d.key.namespace.len() + d.key.id.len() > 4096
            || d.revision.is_empty()
            || d.revision.len() > 1024
            || d.digest.len() != 64
            || !d
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error(
                "invalid-request",
                "invalid canonical identity; verified SHA-256 required",
            ));
        }
        if !keys.insert(&d.key) {
            return Err(error(
                "invalid-request",
                "duplicate source key inside scope",
            ));
        }
        if d.title.len() > QUERY_BYTES
            || d.name.len() > QUERY_BYTES
            || d.media_type.len() > 256
            || d.metadata.len() > 64
            || d.metadata
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 16 * 1024
        {
            return Err(error(
                "invalid-request",
                "canonical metadata exceeds budget",
            ));
        }
        if let Content::InlineText { text } = &d.content
            && ((require_text && text.is_none())
                || (!require_text && text.is_some())
                || text
                    .as_ref()
                    .is_some_and(|s| s.len() > FRAME_BYTES || s.len() as u64 != d.size))
        {
            return Err(error(
                "invalid-request",
                "bounded canonical adapter text required",
            ));
        }
        if let Some(ranges) = &d.text_ranges
            && (ranges.len() > 256
                || !matches!(d.content, Content::Text { .. } | Content::InlineText { .. })
                || ranges
                    .iter()
                    .any(|range| range.end <= range.start || range.end > d.size)
                || ranges.windows(2).any(|pair| pair[0].end > pair[1].start))
        {
            return Err(error(
                "invalid-request",
                "text ranges must be bounded, sorted, disjoint direct-text ranges",
            ));
        }
        if let Some(language) = &d.language
            && !["zh", "ja", "unicode"].contains(&language.as_str())
        {
            return Err(error("invalid-request", "unknown language hint"));
        }
        if let Content::Representation {
            path,
            digest,
            size,
            processor,
            fragments,
            ..
        } = &d.content
            && (path.is_empty()
                || path.len() > 4096
                || Path::new(path)
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
                || *size > REPRESENTATION_BYTES
                || digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || processor.is_empty()
                || processor.len() > 1024
                || fragments.len() > 256
                || fragments.iter().any(|fragment| {
                    fragment.start > fragment.end
                        || fragment.end > *size
                        || fragment.locator.is_empty()
                        || fragment.locator.len() > 1024
                })
                || fragments.windows(2).any(|pair| pair[0].end > pair[1].start))
            {
                return Err(error(
                    "invalid-request",
                    "source representation exceeds its declared bounds",
                ));
            }
        if let Content::Text { path, range } = &d.content
            && (Path::new(path)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
                || path.is_empty()
                || path.len() > 4096
                || range
                    .as_ref()
                    .is_some_and(|r| r.end < r.start || r.end - r.start != d.size))
        {
            return Err(error(
                "invalid-request",
                "source path must be confined and relative",
            ));
        }
    }
    Ok(())
}
/// Deterministic Markdown escaping via JSON strings. Each field is its own searchable unit.
pub(crate) fn sidecar(document: &Document) -> Result<(Vec<u8>, Vec<Unit>)> {
    let mut fields = std::collections::BTreeMap::from([
        (
            "source-key".to_string(),
            serde_json::to_string(&document.key).map_err(io_error)?,
        ),
        ("digest".into(), document.digest.clone()),
        ("media-type".into(), document.media_type.clone()),
        ("size".into(), document.size.to_string()),
        ("name".into(), document.name.clone()),
    ]);
    if !document.title.is_empty() {
        fields.insert("title".into(), document.title.clone());
    }
    for (key, value) in &document.metadata {
        fields.insert(format!("metadata.{key}"), value.clone());
    }
    let mut bytes = b"# Source identity\n\n".to_vec();
    let mut units = Vec::new();
    for (field, value) in fields {
        let header = format!(
            "## {}\n\n```json\n",
            serde_json::to_string(&field)
                .map_err(io_error)?
                .chars()
                .flat_map(|c| if c.is_ascii_punctuation() {
                    vec!['\\', c]
                } else {
                    vec![c]
                })
                .collect::<String>()
        );
        bytes.extend_from_slice(header.as_bytes());
        let start = bytes.len() as u64;
        let value = serde_json::to_string(&value).map_err(io_error)?;
        bytes.extend_from_slice(value.as_bytes());
        units.push(Unit {
            field: Some(field),
            start,
            end: bytes.len() as u64,
        });
        bytes.extend_from_slice(b"\n```\n\n");
        if bytes.len() > SIDECAR_BYTES {
            return Err(error(
                "resource-limited",
                "identity sidecar exceeds byte budget",
            ));
        }
    }
    Ok((bytes, units))
}
/// A staging guard removes only newly derived bytes on ordinary failure.
struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
/// Create audience-private derived directories.
fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path).map_err(io_error)?;
    if fs::symlink_metadata(path)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        return Err(error(
            "invalid-request",
            "derived directory cannot be a symlink",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_error)
}
/// Lock files use kernel-managed names inside the derived root.
fn lock_file(path: &Path) -> Result<LockFile> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map(LockFile)
        .map_err(io_error)
}
/// Release locks before close, including on errors. Another thread's child may
/// retain a copied descriptor until exec; close alone would keep the flock held.
struct LockFile(File);
impl Drop for LockFile {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
/// Read the single atomically replaced durable pointer.
fn current(path: &Path) -> Result<Option<String>> {
    let pointer = path.join("CURRENT");
    if !pointer.exists() {
        return Ok(None);
    }
    match bounded_read(&pointer, 64) {
        Ok(bytes)
            if bytes.len() == 64
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            Ok(Some(String::from_utf8(bytes).map_err(io_error)?))
        }
        Ok(_) => Err(error(
            "unavailable",
            "committed pointer corrupt; inspect and rebuild derived scope",
        )),
        Err(_) => Err(error(
            "unavailable",
            "committed pointer unavailable or oversized; rebuild scope",
        )),
    }
}
/// Read bounded derived metadata, refusing oversized and symlink entries.
pub(crate) fn bounded_read(path: &Path, ceiling: usize) -> Result<Vec<u8>> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file()
        || file.metadata().map_err(io_error)?.len() > ceiling as u64
    {
        return Err(error(
            "resource-limited",
            "derived metadata exceeds byte budget",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(ceiling as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > ceiling {
        return Err(error(
            "resource-limited",
            "derived metadata exceeds byte budget",
        ));
    }
    Ok(bytes)
}
/// Make a complete derived file durable before publication.
fn write_sync(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}
/// Synchronize a directory entry boundary.
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)
}
/// Flush the complete Tantivy tuple after its commit, including merge outputs.
fn sync_tree(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if entry.file_type().map_err(io_error)?.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            File::open(entry.path())
                .map_err(io_error)?
                .sync_all()
                .map_err(io_error)?;
        }
    }
    sync_dir(path)
}
/// Observe actual derived disk bytes independently of input-byte accounting.
fn directory_bytes(path: &Path) -> Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        total += if entry.file_type().map_err(io_error)?.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            entry.metadata().map_err(io_error)?.len()
        };
    }
    Ok(total)
}
/// Drop retired generations only after exclusive reader fencing succeeds.
fn collect(path: &Path, current: &str) -> Result<()> {
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().map_err(io_error)?.is_dir()
            && name.strip_prefix(".stage-").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
            })
        {
            fs::remove_dir_all(entry.path()).map_err(io_error)?;
            continue;
        }
        if name.len() != 64
            || !name.bytes().all(|b| b.is_ascii_hexdigit())
            || !entry.file_type().map_err(io_error)?.is_dir()
            || name == current
            || name.starts_with('.')
        {
            continue;
        }
        let lock = lock_file(&entry.path().join("READERS"))?;
        if FileExt::try_lock_exclusive(&lock.0).is_ok() {
            fs::remove_dir_all(entry.path()).map_err(io_error)?;
        }
    }
    Ok(())
}

/// Cache identity pins the source, metadata revision, processor, and exact serialized bytes.
fn cache_path(document: &Document, representation_digest: &str) -> String {
    let identity = serde_json::to_vec(&(
        &document.key,
        &document.digest,
        &document.revision,
        PROCESSOR,
        representation_digest,
    ))
    .expect("bounded string tuple serialization");
    format!("sidecars/{}.md", digest(&identity))
}

/// Transport handles can move while canonical identity stays fixed, for example after JSONL compaction.
fn same_revision_identity(prior: &Document, next: &Document) -> bool {
    let mut prior = prior.identity();
    let next = next.identity();
    prior.content = next.content.clone();
    prior == next
}
