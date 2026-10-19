//! Generic bounded digest comparisons. Source owners retain admission and interpretation.
use crate::Kernel;
use crate::model::{Result, error, io_error};
use crate::text::open_source;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::Metadata;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, Instant};

/// Maximum range bytes, independent of a source owner's whole-file limit.
pub const DIGEST_SCAN_BYTES: u64 = 16 * 1024 * 1024;
const BUFFER_BYTES: usize = 64 * 1024;
const WINDOW_BYTES: usize = 1024;
const PATTERNS: usize = 4;
const DIGESTS: usize = 64;
const MATCHES: usize = 1024;
const WALL_MS: u64 = 30_000;

/// One generic transformation before digest comparison. No proof identity crosses this boundary.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowEncoding {
    /// Hash every byte window unchanged.
    Bytes,
    /// Hash only unpadded base64url-alphabet windows, unchanged.
    Base64urlText,
    /// Decode only canonical unpadded base64url windows, then hash the decoded bytes.
    Base64urlDecoded,
}
/// A fixed window width and generic SHA-256 comparison set.
#[derive(Debug, Deserialize)]
pub struct DigestWindowPattern {
    /// Encoded source width, in bytes.
    pub window_bytes: usize,
    /// Exact transform, without normalization or replacement.
    pub encoding: WindowEncoding,
    /// Lowercase SHA-256 digests; neither values nor product identities are accepted.
    pub digests: Vec<String>,
}
/// Explicit caller bounds may tighten, but cannot raise, implementation limits.
#[derive(Debug, Deserialize)]
pub struct DigestWindowBounds {
    /// Maximum bytes read from the selected source range.
    pub max_bytes: u64,
    /// Exceeding the result capacity fails; no truncated clean result is returned.
    pub max_matches: usize,
    /// Cooperative deadline checked per fixed block of candidate windows.
    pub timeout_ms: u64,
}
/// A confined source range. Adjacent calls need overlap if a match may cross their boundary.
#[derive(Debug, Deserialize)]
pub struct DigestWindowRequest {
    /// Startup-root-relative regular-file path.
    pub path: String,
    /// Expected whole-file byte length, verified before and after the scan.
    pub source_bytes: u64,
    /// Inclusive range start.
    pub start: u64,
    /// Exclusive range end.
    pub end: u64,
    /// At most four window transformations and 64 comparison digests in total.
    pub patterns: Vec<DigestWindowPattern>,
    /// Hard request bounds; reaching a bound without complete coverage fails closed.
    pub bounds: DigestWindowBounds,
}
/// One end-exclusive source byte range, with no source bytes or digest identity in the reply.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct DigestWindowMatch {
    /// First matching source byte.
    pub start: u64,
    /// Byte after the match.
    pub end: u64,
}
/// Complete proof for this range only. This does not claim a whole-file digest or authorization.
#[derive(Debug, Serialize)]
pub struct DigestWindowResult {
    /// Inclusive scanned start.
    pub start: u64,
    /// Exclusive scanned end.
    pub end: u64,
    /// Exact bytes read.
    pub bytes: u64,
    /// SHA-256 of the selected range, independently of the comparison transformation.
    pub range_digest: String,
    /// Sorted, unique matches. An overflow returns an error instead of this result.
    pub matches: Vec<DigestWindowMatch>,
}

impl Kernel {
    /// Scan one bounded range without index access, publication, or product proof selection.
    pub fn digest_windows(&self, request: DigestWindowRequest) -> Result<DigestWindowResult> {
        let bounds = &request.bounds;
        if request.start > request.end
            || request.end > request.source_bytes
            || request.patterns.is_empty()
            || request.patterns.len() > PATTERNS
            || bounds.max_matches == 0
            || bounds.max_matches > MATCHES
            || bounds.timeout_ms == 0
            || bounds.timeout_ms > WALL_MS
        {
            return Err(error("invalid-request", "invalid digest-window bounds"));
        }
        if bounds.max_bytes > DIGEST_SCAN_BYTES || request.end - request.start > bounds.max_bytes {
            return Err(error(
                "resource-limited",
                "digest-window byte limit reached",
            ));
        }
        let mut digest_count = 0usize;
        let mut patterns = Vec::with_capacity(request.patterns.len());
        for pattern in &request.patterns {
            if pattern.window_bytes == 0
                || pattern.window_bytes > WINDOW_BYTES
                || pattern.digests.is_empty()
            {
                return Err(error("invalid-request", "invalid digest-window pattern"));
            }
            digest_count += pattern.digests.len();
            if digest_count > DIGESTS {
                return Err(error(
                    "resource-limited",
                    "digest-window comparison limit reached",
                ));
            }
            let digests = pattern
                .digests
                .iter()
                .map(|s| decode_digest(s))
                .collect::<Result<BTreeSet<_>>>()?;
            patterns.push((pattern, digests));
        }
        let deadline = Instant::now() + Duration::from_millis(bounds.timeout_ms);
        let check = || {
            if Instant::now() >= deadline {
                Err(error("resource-limited", "digest-window deadline reached"))
            } else {
                Ok(())
            }
        };
        check()?;
        let mut source = open_source(&self.source, &request.path)?;
        let before = source.metadata().map_err(io_error)?;
        if before.len() != request.source_bytes || before.nlink() != 1 {
            return Err(error(
                "unavailable",
                "digest-window source identity unavailable",
            ));
        }
        source
            .seek(SeekFrom::Start(request.start))
            .map_err(io_error)?;
        let overlap = request
            .patterns
            .iter()
            .map(|p| p.window_bytes - 1)
            .max()
            .unwrap();
        let mut buffer = [0u8; BUFFER_BYTES + WINDOW_BYTES];
        let mut decoded = [0u8; WINDOW_BYTES];
        let mut retained = 0;
        let mut read_bytes = 0;
        let mut hash = Sha256::new();
        let mut matches = BTreeSet::new();
        while read_bytes < request.end - request.start {
            check()?;
            let count =
                (request.end - request.start - read_bytes).min(BUFFER_BYTES as u64) as usize;
            source
                .read_exact(&mut buffer[retained..retained + count])
                .map_err(io_error)?;
            hash.update(&buffer[retained..retained + count]);
            let available = retained + count;
            let base = request.start + read_bytes - retained as u64;
            for (pattern, digests) in &patterns {
                // Only windows ending in newly read bytes are visited, including block-boundary matches.
                for end in (retained + 1).max(pattern.window_bytes)..=available {
                    if end % 1024 == 0 {
                        check()?;
                    }
                    let window = &buffer[end - pattern.window_bytes..end];
                    let value: &[u8] = match pattern.encoding {
                        WindowEncoding::Bytes => window,
                        WindowEncoding::Base64urlText => {
                            if !window.iter().all(|b| base64_value(*b).is_some()) {
                                continue;
                            }
                            window
                        }
                        WindowEncoding::Base64urlDecoded => {
                            let Some(length) = decode_base64url(window, &mut decoded) else {
                                continue;
                            };
                            &decoded[..length]
                        }
                    };
                    let digest: [u8; 32] = Sha256::digest(value).into();
                    if digests.contains(&digest) {
                        matches.insert(DigestWindowMatch {
                            start: base + (end - pattern.window_bytes) as u64,
                            end: base + end as u64,
                        });
                        if matches.len() > bounds.max_matches {
                            return Err(error(
                                "resource-limited",
                                "digest-window match limit reached",
                            ));
                        }
                    }
                }
            }
            read_bytes += count as u64;
            retained = available.min(overlap);
            buffer.copy_within(available - retained..available, 0);
        }
        check()?;
        if !unchanged(&before, &source.metadata().map_err(io_error)?) {
            return Err(error("conflict", "digest-window source changed"));
        }
        Ok(DigestWindowResult {
            start: request.start,
            end: request.end,
            bytes: read_bytes,
            range_digest: format!("{:x}", hash.finalize()),
            matches: matches.into_iter().collect(),
        })
    }
}

/// Decode a fixed SHA-256 spelling without accepting alternate case or arbitrary allocation.
fn decode_digest(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error("invalid-request", "invalid comparison digest"));
    }
    let mut bytes = [0u8; 32];
    for (i, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        bytes[i] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(bytes)
}
/// Decode the exact unpadded alphabet; unused bits must be zero for canonical spelling.
fn decode_base64url(input: &[u8], output: &mut [u8]) -> Option<usize> {
    if input.len() % 4 == 1 {
        return None;
    }
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    let mut length = 0;
    for byte in input {
        accumulator = (accumulator << 6) | u32::from(base64_value(*byte)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output[length] = (accumulator >> bits) as u8;
            length += 1;
        }
    }
    if accumulator & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(length)
}
/// Map one byte of the generic unpadded base64url alphabet.
fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}
/// Compare the held source before and after reading; path replacement never redirects this read.
fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.nlink() == b.nlink()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    /// Independent fixed base64url spellings include canonical tail bits and padding refusals.
    #[test]
    fn canonical_decoding_is_exact() {
        let mut output = [0; 1024];
        for (encoded, expected) in [
            ("", ""),
            ("Zg", "f"),
            ("Zm8", "fo"),
            ("Zm9v", "foo"),
            ("AAECA_7_", ""),
        ] {
            let length = decode_base64url(encoded.as_bytes(), &mut output).unwrap();
            if encoded == "AAECA_7_" {
                assert_eq!(&output[..length], &[0, 1, 2, 3, 254, 255]);
            } else {
                assert_eq!(&output[..length], expected.as_bytes());
            }
        }
        for bad in ["Z", "Zh", "Zm9", "Zg=", "Zg==", "Z+", "Z/", "Z ", "\0g"] {
            assert!(
                decode_base64url(bad.as_bytes(), &mut output).is_none(),
                "{bad:?}"
            );
        }
    }
    /// Real sources retain exact original offsets, and neither transform joins separate calls.
    #[test]
    fn transformed_windows_and_empty_ranges() {
        let root = TempDir::new().unwrap();
        let store = TempDir::new().unwrap();
        fs::write(root.path().join("source"), b"\0Zm9v\0Zm9v\0Zm9x").unwrap();
        let kernel = Kernel::new(root.path(), store.path()).unwrap();
        let request = |start, end| DigestWindowRequest {
            path: "source".into(),
            source_bytes: 15,
            start,
            end,
            patterns: vec![DigestWindowPattern {
                window_bytes: 4,
                encoding: WindowEncoding::Base64urlDecoded,
                digests: vec![format!("{:x}", Sha256::digest(b"foo"))],
            }],
            bounds: DigestWindowBounds {
                max_bytes: 15,
                max_matches: 2,
                timeout_ms: 1000,
            },
        };
        assert_eq!(
            kernel.digest_windows(request(0, 15)).unwrap().matches,
            vec![
                DigestWindowMatch { start: 1, end: 5 },
                DigestWindowMatch { start: 6, end: 10 }
            ]
        );
        let empty = kernel.digest_windows(request(5, 5)).unwrap();
        assert!(empty.matches.is_empty());
        assert_eq!(empty.range_digest, format!("{:x}", Sha256::digest(b"")));
        assert!(
            kernel
                .digest_windows(request(2, 5))
                .unwrap()
                .matches
                .is_empty()
        );
    }
    /// FIFO, links, hardlinks, malformed patterns, drift and exhausted time are explicit refusals.
    #[test]
    fn unsafe_sources_and_resource_bounds_fail_closed() {
        let root = TempDir::new().unwrap();
        let store = TempDir::new().unwrap();
        fs::write(
            root.path().join("source"),
            vec![b'x'; DIGEST_SCAN_BYTES as usize],
        )
        .unwrap();
        let kernel = Kernel::new(root.path(), store.path()).unwrap();
        let request = |path: &str| DigestWindowRequest {
            path: path.into(),
            source_bytes: DIGEST_SCAN_BYTES,
            start: 0,
            end: DIGEST_SCAN_BYTES,
            patterns: vec![DigestWindowPattern {
                window_bytes: 43,
                encoding: WindowEncoding::Bytes,
                digests: vec!["0".repeat(64)],
            }],
            bounds: DigestWindowBounds {
                max_bytes: DIGEST_SCAN_BYTES,
                max_matches: 1,
                timeout_ms: 1000,
            },
        };
        let mut limited = request("source");
        limited.bounds.timeout_ms = 1;
        assert_eq!(
            kernel.digest_windows(limited).unwrap_err().code,
            "resource-limited"
        );
        symlink(root.path().join("source"), root.path().join("link")).unwrap();
        assert_eq!(
            kernel.digest_windows(request("link")).unwrap_err().code,
            "unavailable"
        );
        let path = std::ffi::CString::new(root.path().join("fifo").as_os_str().as_encoded_bytes())
            .unwrap();
        // SAFETY: a test-owned pathname is NUL terminated and points inside a private temporary root.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert_eq!(
            kernel.digest_windows(request("fifo")).unwrap_err().code,
            "unavailable"
        );
        fs::hard_link(root.path().join("source"), root.path().join("hard")).unwrap();
        assert_eq!(
            kernel.digest_windows(request("hard")).unwrap_err().code,
            "unavailable"
        );
        let before = fs::metadata(root.path().join("source")).unwrap();
        fs::write(root.path().join("source"), b"changed").unwrap();
        assert!(!unchanged(
            &before,
            &fs::metadata(root.path().join("source")).unwrap()
        ));
        let mut invalid = request("source");
        invalid.patterns[0].window_bytes = 0;
        assert_eq!(
            kernel.digest_windows(invalid).unwrap_err().code,
            "invalid-request"
        );
    }
}
