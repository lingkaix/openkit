//! Bounded canonical reads and the one selected tokenizer for each Document.
use crate::model::{Result, error, io_error};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tantivy::tokenizer::{LowerCaser, SimpleTokenizer, TextAnalyzer, TokenStream};

/// Maximum indexing chunk; the stream keeps at most this plus one UTF-8 code point.
pub const CHUNK_BYTES: usize = 16 * 1024;
/// Maximum regex line and scanner heap.
pub const LINE_BYTES: usize = 64 * 1024;
/// Maximum query bytes, including regex syntax.
pub const QUERY_BYTES: usize = 4096;
/// Maximum response hits.
pub const RESULT_LIMIT: usize = 1000;
/// Maximum UTF-8 snippet bytes.
pub const SNIPPET_BYTES: usize = 512;
/// Maximum identity Markdown bytes per source.
pub const SIDECAR_BYTES: usize = 64 * 1024;
/// Maximum inventory and transport-frame bytes.
pub const FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Maximum admitted objects per scope.
pub const DOCUMENT_LIMIT: usize = 10_000;
/// Per-operation wall-time ceiling. Each read and chunk checks this deadline.
pub const WALL_SECONDS: u64 = 60;
/// Temporary index budget. The last committed generation is outside this budget.
pub const INDEX_BYTES: u64 = 512 * 1024 * 1024;
/// Single-thread Tantivy writer memory budget.
pub const WRITER_BYTES: usize = 32 * 1024 * 1024;
/// Exact source of the packaged IPADIC dictionary.
pub const DICTIONARY_SHA256: &str =
    "a7ba9f645ffe7094e56ae1c4a81d100df8fbb1e28bbe1792622e9728e162db3d";

/// A cooperative request deadline. Cancellation uses the same stopped-work path.
pub(crate) struct Budget {
    pub deadline: Instant,
    pub cancelled: bool,
}
impl Budget {
    /// Start a fixed operation budget.
    pub fn new() -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(WALL_SECONDS),
            cancelled: false,
        }
    }
    /// Stop before the next read, allocation, or chunk when the operation cannot continue.
    pub fn check(&self) -> Result<()> {
        if self.cancelled {
            return Err(error("partial", "operation cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(error("resource-limited", "wall-time budget exhausted"));
        }
        Ok(())
    }
}

/// Hash a bounded stream without allocating its full body.
pub(crate) fn digest_reader(reader: &mut impl Read, budget: &Budget) -> Result<(String, u64)> {
    let mut hash = Sha256::new();
    let mut bytes = [0u8; CHUNK_BYTES];
    let mut size = 0;
    loop {
        budget.check()?;
        let n = reader.read(&mut bytes).map_err(io_error)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", hash.finalize()), size))
}
/// SHA-256 of bounded metadata or serialized identity.
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Open each relative component through a held directory descriptor, refusing symlinks.
pub(crate) fn open_source(root: &File, relative: &str) -> Result<File> {
    #[cfg(test)]
    crate::tests::access("canonical-open", relative);
    use std::os::fd::{AsRawFd, FromRawFd};
    let path = Path::new(relative);
    let parts: Vec<_> = path.components().collect();
    if parts.is_empty()
        || parts.len() > 64
        || relative.len() > 4096
        || parts.iter().any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(error(
            "invalid-request",
            "source path must be confined and relative",
        ));
    }
    let mut directory = root.try_clone().map_err(io_error)?;
    for (i, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            unreachable!()
        };
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| error("invalid-request", "source path contains NUL"))?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // SAFETY: the parent descriptor and NUL-terminated component remain live for openat.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(error("unavailable", "canonical source unavailable"));
        }
        // SAFETY: openat returned a newly owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    if !directory.metadata().map_err(io_error)?.is_file() {
        return Err(error(
            "unavailable",
            "canonical source is not a regular file",
        ));
    }
    Ok(directory)
}

/// A UTF-8 chunk stream. It prefers LF boundaries and never splits a code point.
pub(crate) struct Chunks<R> {
    reader: R,
    pending: Vec<u8>,
    offset: u64,
    done: bool,
    yielded: bool,
}
impl<R: Read> Chunks<R> {
    /// Wrap an admitted reader with a fixed-size buffer.
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            pending: Vec::with_capacity(CHUNK_BYTES + 4),
            offset: 0,
            done: false,
            yielded: false,
        }
    }
    /// Return the next contiguous range, or fail on malformed declared UTF-8.
    pub fn next(&mut self, budget: &Budget) -> Result<Option<(u64, String)>> {
        budget.check()?;
        while !self.done && self.pending.len() < CHUNK_BYTES {
            let mut buf = [0u8; CHUNK_BYTES];
            let n = self
                .reader
                .read(&mut buf[..CHUNK_BYTES - self.pending.len()])
                .map_err(io_error)?;
            if n == 0 {
                self.done = true;
                break;
            }
            self.pending.extend_from_slice(&buf[..n]);
        }
        if self.pending.is_empty() {
            if !self.yielded {
                self.yielded = true;
                return Ok(Some((0, String::new())));
            }
            return Ok(None);
        }
        self.yielded = true;
        let mut end = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() && !self.done => e.valid_up_to(),
            Err(_) => return Err(error("failed", "declared text is not valid UTF-8")),
        };
        if let Some(line) = self.pending[..end].iter().rposition(|&b| b == b'\n') {
            end = line + 1;
        }
        if end == 0 {
            return Err(error("failed", "invalid UTF-8 boundary"));
        }
        let value = String::from_utf8(self.pending[..end].to_vec())
            .map_err(|_| error("failed", "declared text is not valid UTF-8"))?;
        self.pending.drain(..end);
        let offset = self.offset;
        self.offset += end as u64;
        Ok(Some((offset, value)))
    }
}

/// Inspect and verify direct text incrementally before indexing it.
pub(crate) fn inspect(
    file: &mut (impl Read + Seek),
    budget: &Budget,
) -> Result<(String, u64, &'static str)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut han = false;
    let mut kana = false;
    let mut chunks = Chunks::new(&mut *file);
    while let Some((_, text)) = chunks.next(budget)? {
        hash.update(text.as_bytes());
        size += text.len() as u64;
        han |= text.chars().any(is_han);
        kana |= text.chars().any(is_kana);
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok((
        format!("{:x}", hash.finalize()),
        size,
        if kana {
            "ja"
        } else if han {
            "zh"
        } else {
            "unicode"
        },
    ))
}
/// Han includes common, compatibility, and supplementary ideographs.
pub(crate) fn is_han(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c)
        || ('\u{f900}'..='\u{faff}').contains(&c)
        || ('\u{20000}'..='\u{323af}').contains(&c)
}

/// Load the Japanese dictionary once. Runtime never fetches data or reads ambient configuration.
fn japanese() -> Result<TextAnalyzer> {
    static ANALYZER: OnceLock<std::result::Result<TextAnalyzer, String>> = OnceLock::new();
    ANALYZER
        .get_or_init(|| {
            let dictionary = lindera::dictionary::load_dictionary("embedded://ipadic")
                .map_err(|_| "packaged IPADIC unavailable".to_string())?;
            let segmenter =
                lindera::segmenter::Segmenter::new(lindera::mode::Mode::Normal, dictionary, None);
            Ok(TextAnalyzer::builder(
                lindera_tantivy::tokenizer::LinderaTokenizer::from_segmenter(segmenter),
            )
            .filter(LowerCaser)
            .filter(Words)
            .build())
        })
        .clone()
        .map_err(|_| error("unavailable", "packaged IPADIC unavailable"))
}
/// The analyzer selected for one Document. No second dictionary tokenizer runs on its text.
pub(crate) fn analyzer(language: &str) -> Result<TextAnalyzer> {
    match language {
        "zh" => Ok(TextAnalyzer::builder(tantivy_jieba::JiebaTokenizer::new())
            .filter(LowerCaser)
            .filter(Words)
            .build()),
        "ja" => japanese(),
        "unicode" => Ok(TextAnalyzer::builder(SimpleTokenizer::default())
            .filter(LowerCaser)
            .filter(Words)
            .build()),
        _ => Err(error("invalid-request", "unknown source language hint")),
    }
}
/// Analyze bounded text with the same settings used for title, body, sidecar, and queries.
pub fn tokens(language: &str, text: &str) -> Result<Vec<String>> {
    if text.len() > CHUNK_BYTES {
        return Err(error(
            "resource-limited",
            "token input exceeds chunk budget",
        ));
    }
    let mut analyzer = analyzer(language)?;
    let mut stream = analyzer.token_stream(text);
    let mut terms = Vec::new();
    while stream.advance() {
        let term = &stream.token().text;
        terms.push(term.clone());
    }
    terms.sort();
    terms.dedup();
    Ok(terms)
}

/// A canonical file unit or bounded request-local text; neither creates a stored scan-text copy.
pub(crate) enum TextFile {
    File {
        file: File,
        start: u64,
        length: u64,
        position: u64,
    },
    Inline(std::io::Cursor<Vec<u8>>),
}
impl TextFile {
    /// Bind a full canonical file or an exact caller-admitted byte range without copying it.
    pub fn new(mut file: File, range: Option<&crate::ByteRange>) -> Result<Self> {
        let size = file.metadata().map_err(io_error)?.len();
        let (start, end) = range.map(|r| (r.start, r.end)).unwrap_or((0, size));
        if end < start || end > size {
            return Err(error("unavailable", "canonical source unit unavailable"));
        }
        file.seek(SeekFrom::Start(start)).map_err(io_error)?;
        Ok(Self::File {
            file,
            start,
            length: end - start,
            position: 0,
        })
    }
    /// Hold only the bounded text admitted in this request, never in a generation manifest.
    pub fn inline(text: &Option<String>) -> Result<Self> {
        let text = text.as_ref().ok_or_else(|| {
            error(
                "invalid-request",
                "adapter text is required in the current request",
            )
        })?;
        if text.len() > FRAME_BYTES {
            return Err(error(
                "invalid-request",
                "adapter text exceeds frame budget",
            ));
        }
        Ok(Self::Inline(std::io::Cursor::new(text.as_bytes().to_vec())))
    }
}
impl Read for TextFile {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Inline(reader) => reader.read(bytes),
            Self::File {
                file,
                length,
                position,
                ..
            } => {
                let available = (*length - *position).min(bytes.len() as u64) as usize;
                let n = file.read(&mut bytes[..available])?;
                *position += n as u64;
                Ok(n)
            }
        }
    }
}
impl Seek for TextFile {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        match self {
            Self::Inline(reader) => reader.seek(from),
            Self::File {
                file,
                start,
                length,
                position,
            } => {
                let p = match from {
                    SeekFrom::Start(p) => p as i128,
                    SeekFrom::Current(p) => *position as i128 + p as i128,
                    SeekFrom::End(p) => *length as i128 + p as i128,
                };
                if p < 0 || p > *length as i128 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "seek outside admitted source unit",
                    ));
                }
                file.seek(SeekFrom::Start(*start + p as u64))?;
                *position = p as u64;
                Ok(*position)
            }
        }
    }
}

/// Normalized tokens stay bounded, while identifiers with internal punctuation remain words.
const TOKEN_BYTES: usize = 3 * CHUNK_BYTES;
#[derive(Clone)]
struct Words;
impl tantivy::tokenizer::TokenFilter for Words {
    type Tokenizer<T: tantivy::tokenizer::Tokenizer> = WordTokenizer<T>;
    fn transform<T: tantivy::tokenizer::Tokenizer>(self, tokenizer: T) -> WordTokenizer<T> {
        WordTokenizer(tokenizer)
    }
}
/// Apply the same word rule during indexing, query analysis, and title/body verification.
#[derive(Clone)]
struct WordTokenizer<T>(T);
impl<T: tantivy::tokenizer::Tokenizer> tantivy::tokenizer::Tokenizer for WordTokenizer<T> {
    type TokenStream<'a> = WordStream<T::TokenStream<'a>>;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        WordStream(self.0.token_stream(text))
    }
}
/// Preserve original offsets and positions while dropping punctuation-only tokens.
struct WordStream<T>(T);
impl<T: TokenStream> TokenStream for WordStream<T> {
    fn advance(&mut self) -> bool {
        while self.0.advance() {
            let text = &self.0.token().text;
            if text.len() <= TOKEN_BYTES && text.chars().any(char::is_alphanumeric) {
                return true;
            }
        }
        false
    }
    fn token(&self) -> &tantivy::tokenizer::Token {
        self.0.token()
    }
    fn token_mut(&mut self) -> &mut tantivy::tokenizer::Token {
        self.0.token_mut()
    }
}
/// Kana includes ordinary, extended, half-width, and supplementary kana.
pub(crate) fn is_kana(c: char) -> bool {
    ('\u{3040}'..='\u{30ff}').contains(&c)
        || ('\u{31f0}'..='\u{31ff}').contains(&c)
        || ('\u{ff66}'..='\u{ff9f}').contains(&c)
        || ('\u{1b000}'..='\u{1b16f}').contains(&c)
}
/// CJK fallback also covers Hangul identifiers without selecting another dictionary.
pub(crate) fn is_cjk(c: char) -> bool {
    is_han(c)
        || is_kana(c)
        || ('\u{1100}'..='\u{11ff}').contains(&c)
        || ('\u{3130}'..='\u{318f}').contains(&c)
        || ('\u{ac00}'..='\u{d7af}').contains(&c)
}

/// Analyze admitted text for the existing answer rule without another tokenizer implementation.
pub fn analyze(
    query: &str,
    title: &str,
    body: &str,
    hint: Option<&str>,
) -> Result<crate::Analysis> {
    if query.is_empty()
        || query.len() > QUERY_BYTES
        || title.len() > QUERY_BYTES
        || body.len() > FRAME_BYTES
    {
        return Err(error(
            "invalid-request",
            "analysis text exceeds admitted bounds",
        ));
    }
    let language = hint.unwrap_or_else(|| {
        if title.chars().chain(body.chars()).any(is_kana) {
            "ja"
        } else if title.chars().chain(body.chars()).any(is_han) {
            "zh"
        } else {
            "unicode"
        }
    });
    let query_terms = tokens(language, query)?;
    let title_terms = tokens(language, title)?;
    let mut body_terms = std::collections::BTreeSet::new();
    let budget = Budget::new();
    let mut chunks = Chunks::new(body.as_bytes());
    while let Some((_, chunk)) = chunks.next(&budget)? {
        body_terms.extend(tokens(language, &chunk)?);
        if body_terms.len() > DOCUMENT_LIMIT {
            return Err(error("resource-limited", "analysis term budget exhausted"));
        }
    }
    Ok(crate::Analysis {
        language: language.into(),
        query_terms,
        title_terms,
        body_terms: body_terms.into_iter().collect(),
    })
}
