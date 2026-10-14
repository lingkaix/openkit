//! Scope-local BM25 and complete scans of admitted canonical representations.
use crate::model::*;
use crate::store::*;
use crate::text::*;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, Query as TantivyQuery, TermQuery};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::{Index, TantivyDocument, Term};

impl Kernel {
    /// Search only caller-named scopes. No global inventory or authorization state is consulted.
    pub fn search(&self, query: Query) -> Result<SearchResult> {
        self.search_inner(query, &Budget::new())
    }
    /// Run a query under its request-local cancellation and wall budget.
    pub(crate) fn search_inner(&self, query: Query, budget: &Budget) -> Result<SearchResult> {
        let regex = validate_query(&query)?;
        let mut result = SearchResult {
            generations: BTreeMap::new(),
            mode: query.mode,
            hits: vec![],
            coverage: Coverage {
                inventory_complete: true,
                representations_complete: true,
                matches_complete: true,
                ..Coverage::default()
            },
            complete: false,
        };
        let mut scan_occurrences = 0;
        let mut pins = Vec::new();
        for view in &query.scopes {
            if let Err(e) = budget.check() {
                result.coverage.inventory_complete = false;
                result.coverage.representations_complete = false;
                result.coverage.stopped_work += 1;
                reason(&mut result.coverage, &e.code);
                break;
            }
            // Only this exact scope is opened. Statistics belong to its independent generation.
            let pin = self.pin(&view.scope)?;
            result
                .generations
                .insert(view.scope.clone(), pin.id.clone());
            result.coverage.admitted_objects += (pin.manifest.documents.len()
                + pin.manifest.unavailable_objects)
                .max(view.documents.len() + view.unavailable_objects);
            let unavailable = view
                .unavailable_objects
                .max(pin.manifest.unavailable_objects);
            if unavailable > 0 {
                result.coverage.inventory_complete = false;
                result.coverage.stopped_work += unavailable;
                *result
                    .coverage
                    .reasons
                    .entry("source-unavailable".into())
                    .or_default() += unavailable;
            }
            let live: BTreeMap<_, _> = view.documents.iter().map(|d| (&d.key, d)).collect();
            let indexed: BTreeSet<_> = pin
                .manifest
                .documents
                .iter()
                .map(|r| &r.document.key)
                .collect();
            result.coverage.stale_revisions +=
                live.keys().filter(|k| !indexed.contains(**k)).count();
            let mut usable = BTreeSet::new();
            for (number, record) in pin.manifest.documents.iter().enumerate() {
                if live
                    .get(&record.document.key)
                    .is_none_or(|d| d.identity() != record.document)
                {
                    result.coverage.stale_revisions += 1;
                    continue;
                }
                if matches!(record.document.content, Content::Unreadable) {
                    result.coverage.unsupported_bodies += 1;
                }
                if !matches!(
                    record.status,
                    TextStatus::TextExtracted | TextStatus::Unsupported
                ) {
                    result.coverage.stopped_work += 1;
                    result.coverage.representations_complete = false;
                    reason(&mut result.coverage, status_reason(record.status));
                    // Partial indexed chunks can be returned only after full current identity verification.
                    if !matches!(
                        record.status,
                        TextStatus::Partial | TextStatus::ResourceLimited
                    ) {
                        continue;
                    }
                }
                match self.verify(&pin, record, live[&record.document.key], budget) {
                    Ok(()) => {
                        usable.insert(number);
                        result.coverage.searched_representations += 1;
                    }
                    Err(e) => {
                        result.coverage.representations_complete = false;
                        result.coverage.stopped_work += 1;
                        reason(&mut result.coverage, &e.code);
                    }
                }
            }
            if query.mode == Mode::Lexical {
                if let Err(e) = lexical(self, &pin, &query, &usable, &live, &mut result, budget) {
                    if ![
                        "partial",
                        "resource-limited",
                        "unavailable",
                        "failed",
                        "stale",
                        "io",
                    ]
                    .contains(&e.code.as_str())
                    {
                        return Err(e);
                    }
                    result.coverage.representations_complete = false;
                    result.coverage.stopped_work += 1;
                    reason(&mut result.coverage, &e.code);
                }
            } else {
                for number in usable {
                    let record = &pin.manifest.documents[number];
                    let mut local = vec![];
                    let mut occurrences = 0;
                    let scan = (|| -> Result<()> {
                        let mut file =
                            self.representation(&pin, record, live[&record.document.key])?;
                        for (unit_id, unit) in record.units.iter().enumerate() {
                            budget.check()?;
                            file.seek(SeekFrom::Start(unit.start)).map_err(io_error)?;
                            let mut emit = |start: u64, end: u64, preview: &str| {
                                occurrences += 1;
                                if local.len() < query.limit {
                                    local.push(hit(
                                        &pin,
                                        record,
                                        unit_id,
                                        start..end,
                                        0,
                                        None,
                                        bounded_preview(preview),
                                    ));
                                }
                            };
                            match query.mode {
                                Mode::Exact => literal(
                                    (&mut file).take(unit.end - unit.start),
                                    query.query.as_bytes(),
                                    unit.start,
                                    budget,
                                    &mut emit,
                                )?,
                                Mode::Regex => regex_lines(
                                    (&mut file).take(unit.end - unit.start),
                                    regex.as_ref().unwrap(),
                                    unit.start,
                                    budget,
                                    &mut emit,
                                )?,
                                Mode::Lexical => unreachable!(),
                            }
                        }
                        Ok(())
                    })();
                    // A scan stop does not invalidate evidence verified before the scan.
                    // Repeat identity verification while the request budget permits; a detected
                    // revision change or malformed current text discards hits. Other failures stay incomplete.
                    let verification = match budget.check() {
                        Ok(()) => self.verify(&pin, record, live[&record.document.key], budget),
                        Err(e) => Err(e),
                    };
                    if !verification
                        .as_ref()
                        .is_err_and(|e| e.code == "stale" || e.code == "failed")
                    {
                        if occurrences > 0 {
                            result.coverage.matching_documents += 1;
                        }
                        scan_occurrences += occurrences;
                        result.hits.extend(local);
                        result.hits.sort_by(scan_order);
                        result.hits.truncate(query.limit);
                    }
                    let outcome = match verification {
                        Err(e) if e.code != "partial" && e.code != "resource-limited" => Err(e),
                        verification => scan.and(verification),
                    };
                    match outcome {
                        Ok(()) => {}
                        Err(e) => {
                            result.coverage.representations_complete = false;
                            result.coverage.stopped_work += 1;
                            reason(&mut result.coverage, &e.code);
                        }
                    }
                }
            }
            if query.mode == Mode::Lexical {
                result.hits.sort_by(|a, b| {
                    b.score
                        .unwrap()
                        .total_cmp(&a.score.unwrap())
                        .then(a.key.cmp(&b.key))
                        .then(a.chunk.cmp(&b.chunk))
                        .then(a.scope.cmp(&b.scope))
                });
                result.hits.truncate(query.limit);
            }
            pins.push(pin);
        }
        result.coverage.inventory_complete &= result.coverage.stale_revisions == 0;
        if result.coverage.stale_revisions > 0 {
            reason(&mut result.coverage, "stale");
        }
        if query.mode == Mode::Lexical {
            result.hits.sort_by(|a, b| {
                b.score
                    .unwrap()
                    .total_cmp(&a.score.unwrap())
                    .then(a.key.cmp(&b.key))
                    .then(a.chunk.cmp(&b.chunk))
                    .then(a.scope.cmp(&b.scope))
            });
            result.hits.truncate(query.limit);
        } else {
            result.hits.sort_by(scan_order);
            result.coverage.omitted_matches = scan_occurrences - result.hits.len();
            result.coverage.matches_complete = result.coverage.omitted_matches == 0
                && result.coverage.inventory_complete
                && result.coverage.representations_complete;
        }
        // Keep transport output bounded before serialization can allocate an oversized response.
        let mut output_bytes = 0;
        let mut retained = 0;
        for candidate in &result.hits {
            let bytes = serde_json::to_vec(candidate).map_err(io_error)?.len();
            if output_bytes + bytes > FRAME_BYTES / 2 {
                break;
            }
            output_bytes += bytes;
            retained += 1;
        }
        if retained < result.hits.len() {
            result.coverage.omitted_matches += result.hits.len() - retained;
            result.hits.truncate(retained);
            result.coverage.matches_complete = false;
            reason(&mut result.coverage, "output-limit");
        }
        result.coverage.enumeration_complete = query.mode == Mode::Lexical
            && result.coverage.inventory_complete
            && result.coverage.representations_complete
            && result.coverage.matching_documents == result.hits.len();
        result.complete = result.coverage.inventory_complete
            && result.coverage.representations_complete
            && result.coverage.matches_complete;
        drop(pins);
        for scope in result.generations.keys() {
            self.collect(scope)?;
        }
        Ok(result)
    }
    /// Open direct canonical text or the exact immutable sidecar bound by this reader pin.
    fn representation(&self, pin: &Pin, record: &Record, current: &Document) -> Result<TextFile> {
        match &record.document.content {
            Content::Text { path, range } => {
                TextFile::new(open_source(&self.source, path)?, range.as_ref())
            }
            Content::InlineText { .. } => match &current.content {
                Content::InlineText { text } => TextFile::inline(text),
                _ => Err(error("stale", "canonical text handle changed")),
            },
            Content::Unreadable => {
                use std::os::unix::fs::OpenOptionsExt;
                let path = record
                    .sidecar
                    .as_ref()
                    .ok_or_else(|| error("unavailable", "committed sidecar unavailable"))?;
                if !path.starts_with("sidecars/") || path.contains("..") {
                    return Err(error("unavailable", "committed sidecar identity invalid"));
                }
                let file = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(pin.path.join(path))
                    .map_err(io_error)?;
                TextFile::new(file, None)
            }
            Content::Unavailable => Err(error("unavailable", "canonical source unavailable")),
        }
    }
    /// Verify the pinned representation before admitting any hit, then repeat after scans.
    fn verify(
        &self,
        pin: &Pin,
        record: &Record,
        current: &Document,
        budget: &Budget,
    ) -> Result<()> {
        let mut file = self.representation(pin, record, current)?;
        let (hash, size) = if record.sidecar.is_some() {
            digest_reader(&mut file, budget)?
        } else {
            let (hash, size, _) = inspect(&mut file, budget)?;
            (hash, size)
        };
        if hash != record.representation_digest
            || (record.sidecar.is_none() && size != record.document.size)
        {
            return Err(error("stale", "representation changed since publication"));
        }
        if record.sidecar.is_some() && size > SIDECAR_BYTES as u64 {
            return Err(error("unavailable", "committed sidecar exceeds budget"));
        }
        Ok(())
    }
}
/// Validate every request field and regex before opening a generation or canonical text.
pub(crate) fn validate_query(query: &Query) -> Result<Option<RegexMatcher>> {
    if query.query.is_empty()
        || query.query.len() > QUERY_BYTES
        || query.limit == 0
        || query.limit > RESULT_LIMIT
        || query.scopes.len() > 128
    {
        return Err(error(
            "invalid-request",
            "query or result limit exceeds bounds",
        ));
    }
    let mut scopes = BTreeSet::new();
    for view in &query.scopes {
        validate_view(view, true)?;
        if !scopes.insert(&view.scope) {
            return Err(error("invalid-request", "duplicate readable scope"));
        }
    }
    if query.mode != Mode::Regex {
        return Ok(None);
    }
    let ast = regex_syntax::ast::parse::Parser::new()
        .parse(&query.query)
        .map_err(|_| error("invalid-request", "unsupported or invalid Rust regex"))?;
    regex_syntax::ast::visit(&ast, RejectLf).map_err(|_| {
        error(
            "invalid-request",
            "explicit LF regex literals are unsupported",
        )
    })?;
    let hir = regex_syntax::Parser::new()
        .parse(&query.query)
        .map_err(|_| error("invalid-request", "unsupported or invalid Rust regex"))?;
    if hir.properties().minimum_len().is_none_or(|n| n == 0) {
        return Err(error(
            "invalid-request",
            "zero-length regex matches are unsupported",
        ));
    }
    let matcher = RegexMatcherBuilder::new()
        .line_terminator(Some(b'\n'))
        .size_limit(1024 * 1024)
        .dfa_size_limit(1024 * 1024)
        .build(&query.query)
        .map_err(|_| {
            error(
                "invalid-request",
                "regex exceeds bounds or contains unsupported LF",
            )
        })?;
    Ok(Some(matcher))
}
/// Build an ordinary any-term query; source language fields use their own matching analyzer.
fn lexical(
    kernel: &Kernel,
    pin: &Pin,
    query: &Query,
    usable: &BTreeSet<usize>,
    live: &BTreeMap<&SourceKey, &Document>,
    result: &mut SearchResult,
    budget: &Budget,
) -> Result<()> {
    let index = Index::open_in_dir(pin.path.join("index")).map_err(|_| {
        error(
            "unavailable",
            "committed lexical index unavailable; rebuild scope",
        )
    })?;
    #[cfg(test)]
    crate::tests::access("statistics", &pin.manifest.scope);
    if !index.validate_checksum().map_err(io_error)?.is_empty() {
        return Err(error(
            "unavailable",
            "committed lexical checksum failed; rebuild scope",
        ));
    }
    if index.load_metas().map_err(io_error)?.payload.as_deref() != Some(pin.id.as_str()) {
        return Err(error(
            "unavailable",
            "index postings disagree with the committed generation",
        ));
    }
    register(&index)?;
    let (expected_schema, fields) = schema();
    if index.schema() != expected_schema {
        return Err(error(
            "unavailable",
            "committed schema mismatch; rebuild scope",
        ));
    }
    let mut clauses: Vec<(Occur, Box<dyn TantivyQuery>)> = vec![];
    let mut literal_terms = BTreeSet::new();
    let languages: BTreeSet<_> = pin
        .manifest
        .documents
        .iter()
        .map(|r| r.language.as_str())
        .collect();
    for language in languages {
        let (body, title) = fields.language(language);
        for term in tokens(language, &query.query)? {
            clauses.push((
                Occur::Should,
                Box::new(TermQuery::new(
                    Term::from_field_text(body, &term),
                    IndexRecordOption::WithFreqs,
                )),
            ));
            clauses.push((
                Occur::Should,
                Box::new(BoostQuery::new(
                    Box::new(TermQuery::new(
                        Term::from_field_text(title, &term),
                        IndexRecordOption::WithFreqs,
                    )),
                    2.0,
                )),
            ));
            if term.chars().any(is_cjk) {
                literal_terms.insert(term);
            }
        }
    }
    let mut queries: Vec<ScoredQuery<'_>> = vec![(None, Box::new(BooleanQuery::new(clauses)))];
    // Gram postings nominate candidates only. Canonical chunk verification prevents false literals.
    for term in &literal_terms {
        let chars: Vec<_> = term.chars().collect();
        let width = chars.len().min(3);
        for (field, title, boost) in [(fields.grams, false, 0.1), (fields.title_grams, true, 0.2)] {
            let grams: Vec<(Occur, Box<dyn TantivyQuery>)> = chars
                .windows(width)
                .map(|w| {
                    (
                        Occur::Must,
                        Box::new(TermQuery::new(
                            Term::from_field_text(field, &w.iter().collect::<String>()),
                            IndexRecordOption::WithFreqs,
                        )) as Box<dyn TantivyQuery>,
                    )
                })
                .collect();
            queries.push((
                Some((term, title)),
                Box::new(BoostQuery::new(Box::new(BooleanQuery::new(grams)), boost)),
            ));
        }
    }
    let reader = index.reader().map_err(io_error)?;
    let searcher = reader.searcher();
    let count = usize::try_from(searcher.num_docs()).map_err(io_error)?;
    if count == 0 {
        return Ok(());
    }
    let mut best: BTreeMap<usize, Hit> = BTreeMap::new();
    for (literal_term, search_query) in queries {
        budget.check()?;
        let candidates = searcher
            .search(
                search_query.as_ref(),
                &TopDocs::with_limit(count).order_by_score(),
            )
            .map_err(io_error)?;
        for (score, address) in candidates {
            budget.check()?;
            let chunk: TantivyDocument = searcher.doc(address).map_err(io_error)?;
            let read = |field| {
                chunk
                    .get_first(field)
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| error("unavailable", "committed chunk identity invalid"))
            };
            let number = read(fields.document)? as usize;
            if !usable.contains(&number) {
                continue;
            }
            let record = pin.manifest.documents.get(number).ok_or_else(|| {
                error("unavailable", "committed inventory disagrees with postings")
            })?;
            let start = read(fields.start)?;
            let end = read(fields.end)?;
            if end < start || end - start > CHUNK_BYTES as u64 {
                return Err(error("unavailable", "committed chunk range invalid"));
            }
            let mut file = kernel.representation(pin, record, live[&record.document.key])?;
            file.seek(SeekFrom::Start(start)).map_err(io_error)?;
            let mut bytes = vec![0; (end - start) as usize];
            file.read_exact(&mut bytes).map_err(io_error)?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| error("failed", "canonical UTF-8 changed"))?;
            let title_only;
            if let Some((term, title)) = literal_term {
                title_only = title;
                if !tokens(&record.language, &query.query)?
                    .iter()
                    .any(|t| t == term)
                    || !(if title { &record.document.title } else { text })
                        .to_lowercase()
                        .contains(term)
                {
                    continue;
                }
            } else {
                let wanted = tokens(&record.language, &query.query)?;
                let body_terms = tokens(&record.language, text)?;
                let title_terms = tokens(&record.language, &record.document.title)?;
                title_only = !wanted.iter().any(|t| body_terms.contains(t));
                if !wanted
                    .iter()
                    .any(|t| body_terms.contains(t) || title_terms.contains(t))
                {
                    continue;
                }
            }
            let mut candidate = hit(
                pin,
                record,
                read(fields.unit)? as usize,
                start..end,
                read(fields.ordinal)?,
                Some(score),
                bounded_preview(text),
            );
            if title_only {
                candidate.locator = Locator::Title {
                    start: 0,
                    end: record.document.title.len() as u64,
                    original: record.document.locator.clone(),
                };
                candidate.snippet = bounded_preview(&record.document.title);
            }
            if best.get(&number).is_none_or(|prior| {
                score > prior.score.unwrap()
                    || (score == prior.score.unwrap() && candidate.chunk < prior.chunk)
            }) {
                best.insert(number, candidate);
            }
        }
    }
    for (number, candidate) in best {
        if kernel
            .verify(
                pin,
                &pin.manifest.documents[number],
                live[&pin.manifest.documents[number].document.key],
                budget,
            )
            .is_ok()
        {
            result.coverage.matching_documents += 1;
            result.hits.push(candidate);
        } else {
            result.coverage.representations_complete = false;
            result.coverage.stopped_work += 1;
            reason(&mut result.coverage, "stale");
        }
    }
    Ok(())
}
/// Construct provenance without exposing offsets as binary coordinates.
fn hit(
    pin: &Pin,
    record: &Record,
    unit: usize,
    range: std::ops::Range<u64>,
    chunk: u64,
    score: Option<f32>,
    snippet: String,
) -> Hit {
    let (start, end) = (range.start, range.end);
    let field = record.units.get(unit).and_then(|u| u.field.clone());
    let locator = if let Some(field) = field {
        Locator::Metadata { field, start, end }
    } else {
        Locator::Text {
            start,
            end,
            original: record.document.locator.clone(),
        }
    };
    Hit {
        key: record.document.key.clone(),
        scope: pin.manifest.scope.clone(),
        revision: record.document.revision.clone(),
        digest: record.document.digest.clone(),
        representation: if record.sidecar.is_some() {
            "sidecar"
        } else {
            "text"
        }
        .into(),
        representation_digest: record.representation_digest.clone(),
        processor: record.sidecar.as_ref().map(|_| PROCESSOR.into()),
        locator,
        chunk,
        score,
        snippet,
        provenance: record.document.metadata.clone(),
    }
}
/// Preserve UTF-8 while bounding output independently of input size.
fn bounded_preview(value: &str) -> String {
    let mut end = value.len().min(SNIPPET_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}
/// Stable representation-local scan ordering.
fn locator_order(locator: &Locator) -> (String, u64) {
    match locator {
        Locator::Title { start, .. } | Locator::Text { start, .. } => (String::new(), *start),
        Locator::Metadata { field, start, .. } => (field.clone(), *start),
    }
}
/// Record bounded aggregate stopping reasons without copying private identifiers.
fn reason(coverage: &mut Coverage, reason: &str) {
    *coverage.reasons.entry(reason.into()).or_default() += 1;
}
/// Preserve the closed text-status vocabulary in coverage reasons.
fn status_reason(status: TextStatus) -> &'static str {
    match status {
        TextStatus::TextExtracted => "text-extracted",
        TextStatus::Partial => "partial",
        TextStatus::Unsupported => "unsupported",
        TextStatus::Failed => "failed",
        TextStatus::ResourceLimited => "resource-limited",
    }
}

/// Stream literals with only query-length overlap. Indexed chunk boundaries have no scan meaning.
fn literal(
    mut reader: impl Read,
    needle: &[u8],
    base: u64,
    budget: &Budget,
    emit: &mut impl FnMut(u64, u64, &str),
) -> Result<()> {
    let mut tail = Vec::new();
    let mut consumed = 0u64;
    let mut buf = [0; CHUNK_BYTES];
    loop {
        budget.check()?;
        let n = reader.read(&mut buf).map_err(io_error)?;
        if n == 0 {
            break;
        }
        let prior = consumed;
        let start = consumed - tail.len() as u64;
        tail.extend_from_slice(&buf[..n]);
        consumed += n as u64;
        for (offset, candidate) in tail.windows(needle.len()).enumerate() {
            if candidate == needle && start + offset as u64 + needle.len() as u64 > prior {
                let begin = base + start + offset as u64;
                emit(
                    begin,
                    begin + needle.len() as u64,
                    std::str::from_utf8(needle).map_err(io_error)?,
                );
            }
        }
        let keep = (needle.len() - 1).min(tail.len());
        tail.drain(..tail.len() - keep);
    }
    Ok(())
}
/// Feed one bounded line at a time so grep read-ahead cannot discard earlier lines
/// when a later line exceeds its heap limit. LF is retained for grep's line semantics.
fn regex_lines(
    reader: impl Read,
    matcher: &RegexMatcher,
    mut base: u64,
    budget: &Budget,
    emit: &mut impl FnMut(u64, u64, &str),
) -> Result<()> {
    let mut reader = BufReader::with_capacity(CHUNK_BYTES, reader);
    let mut line = Vec::with_capacity(LINE_BYTES + 1);
    let mut searcher = SearcherBuilder::new()
        .bom_sniffing(false)
        .heap_limit(Some(LINE_BYTES))
        .build();
    loop {
        budget.check()?;
        let bytes = reader.fill_buf().map_err(io_error)?;
        let ended = bytes.iter().position(|&b| b == b'\n');
        let take = ended.map_or(bytes.len(), |n| n + 1);
        let content_bytes = take - usize::from(ended.is_some());
        if line.len() + content_bytes > LINE_BYTES {
            return Err(error("resource-limited", "regex line budget exhausted"));
        }
        line.extend_from_slice(&bytes[..take]);
        let eof = bytes.is_empty();
        reader.consume(take);
        if ended.is_some() || eof {
            if !line.is_empty() {
                let mut sink = RegexSink {
                    matcher,
                    base,
                    emit,
                    budget,
                };
                searcher
                    .search_slice(matcher, &line, &mut sink)
                    .map_err(|_| error("resource-limited", "regex scan budget exhausted"))?;
                base += line.len() as u64;
                line.clear();
            }
            if eof {
                return Ok(());
            }
        }
    }
}
/// The grep searcher reports matching lines; the matcher enumerates each occurrence.
struct RegexSink<'a, F> {
    matcher: &'a RegexMatcher,
    base: u64,
    emit: &'a mut F,
    budget: &'a Budget,
}
impl<F: FnMut(u64, u64, &str)> Sink for RegexSink<'_, F> {
    type Error = std::io::Error;
    fn matched(&mut self, _: &Searcher, matched: &SinkMatch<'_>) -> std::io::Result<bool> {
        self.budget.check().map_err(std::io::Error::other)?;
        let bytes = matched
            .bytes()
            .strip_suffix(b"\n")
            .unwrap_or(matched.bytes());
        let text = std::str::from_utf8(bytes).map_err(std::io::Error::other)?;
        self.matcher
            .find_iter(bytes, |m| {
                if self.budget.check().is_err() {
                    return false;
                }
                (self.emit)(
                    self.base + matched.absolute_byte_offset() + m.start() as u64,
                    self.base + matched.absolute_byte_offset() + m.end() as u64,
                    &text[m.start()..m.end()],
                );
                true
            })
            .map_err(std::io::Error::other)?;
        self.budget.check().map_err(std::io::Error::other)?;
        Ok(true)
    }
}

/// Global scan ordering is independent of caller scope order.
fn scan_order(a: &Hit, b: &Hit) -> std::cmp::Ordering {
    a.key
        .cmp(&b.key)
        .then(a.representation.cmp(&b.representation))
        .then(locator_order(&a.locator).cmp(&locator_order(&b.locator)))
        .then(a.scope.cmp(&b.scope))
}

/// Inspect syntax before the grep builder removes LF from classes; removal would silently change a request.
struct RejectLf;
impl regex_syntax::ast::Visitor for RejectLf {
    type Output = ();
    type Err = ();
    fn finish(self) -> std::result::Result<(), ()> {
        Ok(())
    }
    fn visit_pre(&mut self, ast: &regex_syntax::ast::Ast) -> std::result::Result<(), ()> {
        if matches!(ast, regex_syntax::ast::Ast::Literal(literal) if literal.c == '\n') {
            return Err(());
        }
        Ok(())
    }
    fn visit_class_set_item_pre(
        &mut self,
        item: &regex_syntax::ast::ClassSetItem,
    ) -> std::result::Result<(), ()> {
        use regex_syntax::ast::ClassSetItem;
        if matches!(item, ClassSetItem::Literal(literal) if literal.c == '\n')
            || matches!(item, ClassSetItem::Range(range) if range.start.c == '\n' || range.end.c == '\n')
        {
            return Err(());
        }
        Ok(())
    }
}

/// A primary query or one field-specific gram query awaiting canonical verification.
type ScoredQuery<'a> = (Option<(&'a str, bool)>, Box<dyn TantivyQuery>);
