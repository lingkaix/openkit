//! Request-private file carriage with bounded buffers and occupied-disk admission.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};

/// All import/export buffers use this bound independently of total file length.
pub const CHUNK_BYTES: usize = 65_536;
/// Decimal maximum for one admitted source file.
pub const FILE_BYTES: u64 = 1_000_000_000;
/// One derived ZIP member in the selected read-only Turn snapshot may use the full expansion bound.
pub const CONTEXT_SOURCE_BYTES: u64 = 4_000_000_000;
/// Terminal capture and non-file snapshot inputs keep their existing ceiling.
pub const EVIDENCE_BYTES: u64 = 256 * 1024 * 1024;
const RESERVE_BYTES: u64 = 1_000_000_000;
static RESERVED_BYTES: Mutex<u64> = Mutex::new(0);

/// Selects only an existing source owner, without widening uploads, exports or other private imports.
pub fn import_byte_limit(slot: &str) -> u64 {
    match slot {
        "context" => CONTEXT_SOURCE_BYTES,
        "artifact-input" | "turn-inputs" => FILE_BYTES,
        _ => EVIDENCE_BYTES,
    }
}


/// A private partial file. Drop removes its complete request directory on every exit.
pub struct FileStage {
    file: File,
    directory: PathBuf,
    length: u64,
    maximum: u64,
    remaining: u64,
    digest: Sha256,
}

impl FileStage {
    /// Reserves worst-case overlap before the first body write, on the supplied local disk.
    pub fn create(root: &Path, maximum: u64, overlap: u64) -> io::Result<Self> {
        let mut parent = PathBuf::new();
        for component in root.components() {
            parent.push(component);
            if !parent.exists() {
                match fs::DirBuilder::new().mode(0o700).create(&parent) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                    Err(error) => return Err(error),
                }
            }
            if !fs::symlink_metadata(&parent)?.file_type().is_dir() {
                return Err(invalid());
            }
        }
        let directory_fd = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(root)?;
        let wanted = maximum
            .checked_add(overlap)
            .and_then(|bytes| bytes.checked_add(65_536))
            .ok_or_else(invalid)?;
        let mut reserved = RESERVED_BYTES.lock().map_err(|_| invalid())?;
        let next_reserved = reserved.checked_add(wanted).ok_or_else(invalid)?;
        require_capacity(&directory_fd, next_reserved)?;
        let mut random = [0_u8; 24];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| invalid())?;
        let directory = root.join(
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        );
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("partial"))
        {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_dir(&directory);
                return Err(error);
            }
        };
        *reserved = next_reserved;
        Ok(Self {
            file,
            directory,
            length: 0,
            maximum,
            remaining: wanted,
            digest: Sha256::new(),
        })
    }

    /// Verifies a complete source before a helper or a retained result can use it.
    pub fn complete(mut self, expected: Option<(u64, &str)>) -> io::Result<VerifiedFile> {
        self.file.sync_all()?;
        require_capacity(
            &File::open(&self.directory)?,
            *RESERVED_BYTES.lock().map_err(|_| invalid())?,
        )?;
        let digest = format!("sha256:{:x}", self.digest.clone().finalize());
        if expected.is_some_and(|(length, hash)| length != self.length || hash != digest) {
            return Err(invalid());
        }
        self.file.seek(SeekFrom::Start(0))?;
        fs::rename(
            self.directory.join("partial"),
            self.directory.join("payload"),
        )?;
        File::open(&self.directory)?.sync_all()?;
        Ok(VerifiedFile {
            stage: self,
            digest,
        })
    }

    /// Returns actual bytes, used to refuse nonempty optional absence or helper refusal.
    pub fn length(&self) -> u64 {
        self.length
    }
}

impl Write for FileStage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > CHUNK_BYTES || bytes.len() as u64 > self.maximum - self.length {
            return Err(invalid());
        }
        let written = self.file.write(bytes)?;
        self.digest.update(&bytes[..written]);
        self.length += written as u64;
        self.remaining -= written as u64;
        *RESERVED_BYTES.lock().map_err(|_| invalid())? -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Drop for FileStage {
    fn drop(&mut self) {
        // Unproved cleanup keeps the remaining reservation. Restart observes occupied disk.
        if fs::remove_dir_all(&self.directory).is_ok()
            && let Ok(mut reserved) = RESERVED_BYTES.lock()
        {
            *reserved -= self.remaining;
        }
    }
}

/// Complete exact body retained on disk. This is transient carriage, never product acceptance.
pub struct VerifiedFile {
    stage: FileStage,
    digest: String,
}

impl VerifiedFile {
    /// Reopens and rehashes the same single-link regular file before each delivery attempt.
    pub fn reader(&self) -> io::Result<File> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.stage.directory.join("payload"))?;
        let before = file.metadata()?;
        if !before.is_file() || before.nlink() != 1 || before.len() != self.length() {
            return Err(invalid());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; CHUNK_BYTES];
        let mut read = 0_u64;
        while read < self.length() {
            let wanted = (self.length() - read).min(CHUNK_BYTES as u64) as usize;
            let count = file.read(&mut buffer[..wanted])?;
            if count == 0 {
                return Err(invalid());
            }
            hash.update(&buffer[..count]);
            read += count as u64;
        }
        let after = file.metadata()?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.len() != before.len()
            || after.nlink() != 1
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || format!("sha256:{:x}", hash.finalize()) != self.digest
        {
            return Err(invalid());
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    /// Actual immutable body size.
    pub fn length(&self) -> u64 {
        self.stage.length
    }
    /// Digest of the exact body, independent of transfer framing.
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

fn invalid() -> io::Error {
    io::Error::other("File carriage integrity verification failed.")
}

/// Includes outstanding overlap and current occupied disk before accepting a private copy.
fn require_capacity(directory: &File, reserved: u64) -> io::Result<()> {
    let mut state = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // The descriptor pins the checked directory; the kernel initializes statvfs on success.
    if unsafe { libc::fstatvfs(directory.as_raw_fd(), state.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let state = unsafe { state.assume_init() };
    let available = u128::from(state.f_bavail) * u128::from(state.f_frsize);
    if available < u128::from(RESERVE_BYTES) + u128::from(reserved) {
        return Err(io::Error::other("File carriage capacity unavailable."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "openkit-file-stream-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exact_empty_and_binary_originals_survive_repeated_delivery_and_cleanup() {
        for (bytes, digest) in [
            (
                b"".as_slice(),
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                b"\x00\xff\xc3\x28\x80\x0a".as_slice(),
                "sha256:39948221138e963424a7cdbd1659e745f52303800b3954b845a13ca723c0133e",
            ),
        ] {
            let root = Fixture::new();
            let mut stage = FileStage::create(&root.0, bytes.len() as u64, 0).unwrap();
            stage.write_all(bytes).unwrap();
            let file = stage.complete(Some((bytes.len() as u64, digest))).unwrap();
            for _ in 0..2 {
                let mut result = Vec::new();
                file.reader().unwrap().read_to_end(&mut result).unwrap();
                assert_eq!(result, bytes);
            }
            assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
            drop(file);
            assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
        }
    }

    #[test]
    fn actual_stream_overflow_is_refused_before_the_next_byte_is_written() {
        let root = Fixture::new();
        let mut stage = FileStage::create(&root.0, 2, 0).unwrap();
        stage.write_all(b"ab").unwrap();
        assert!(stage.write_all(b"c").is_err());
        assert_eq!(stage.length(), 2);
        assert!(stage.complete(Some((3, "unused"))).is_err());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn changed_or_multiply_linked_retained_bytes_never_reach_a_successor() {
        let root = Fixture::new();
        let mut stage = FileStage::create(&root.0, 3, 0).unwrap();
        stage.write_all(b"abc").unwrap();
        let file = stage.complete(None).unwrap();
        let path = file.stage.directory.join("payload");
        fs::hard_link(&path, file.stage.directory.join("alias")).unwrap();
        assert!(file.reader().is_err());
        fs::remove_file(file.stage.directory.join("alias")).unwrap();
        fs::write(path, b"xyz").unwrap();
        assert!(file.reader().is_err());
    }

    #[test]
    fn one_billion_actual_bytes_use_bounded_carriage_and_match_the_independent_oracle() {
        let root = Fixture::new();
        let mut stage = FileStage::create(&root.0, FILE_BYTES, 0).unwrap();
        let buffer = [0_u8; CHUNK_BYTES];
        let mut remaining = FILE_BYTES;
        while remaining > 0 {
            let count = remaining.min(CHUNK_BYTES as u64) as usize;
            stage.write_all(&buffer[..count]).unwrap();
            remaining -= count as u64;
        }
        assert!(stage.write_all(&[0]).is_err());
        // Python hashlib independently hashed the fixture's fixed zero-byte recipe.
        let file = stage
            .complete(Some((
                FILE_BYTES,
                "sha256:bc17f06f9d9b5f6f79ca189a1772b1a3a38d6e40c45bec50f9c4f28144efddca",
            )))
            .unwrap();
        let mut reader = file.reader().unwrap();
        let mut counted = 0_u64;
        let mut buffer = [1_u8; CHUNK_BYTES];
        loop {
            let read = reader.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            assert!(buffer[..read].iter().all(|byte| *byte == 0));
            counted += read as u64;
        }
        assert_eq!(counted, FILE_BYTES);
    }
    #[test]
    fn four_billion_expanded_context_bytes_keep_bounded_buffers_and_exact_identity() {
        let root = Fixture::new();
        let mut stage = FileStage::create(&root.0, CONTEXT_SOURCE_BYTES, 0).unwrap();
        let buffer = [0_u8; CHUNK_BYTES];
        let mut remaining = CONTEXT_SOURCE_BYTES;
        while remaining > 0 {
            let count = remaining.min(CHUNK_BYTES as u64) as usize;
            stage.write_all(&buffer[..count]).unwrap();
            remaining -= count as u64;
        }
        assert!(stage.write_all(&[0]).is_err());
        // Independent Python hashlib oracle over exactly 4,000,000,000 zero bytes.
        let file = stage.complete(Some((CONTEXT_SOURCE_BYTES,
            "sha256:ddd45e35df0b676747319e4da247e7dc78b53cb99cba1411f1db51ebf4202efb"))).unwrap();
        let mut reader = file.reader().unwrap();
        let mut counted = 0_u64;
        let mut buffer = [1_u8; CHUNK_BYTES];
        loop {
            let read = reader.read(&mut buffer).unwrap();
            if read == 0 { break; }
            assert!(buffer[..read].iter().all(|byte| *byte == 0));
            counted += read as u64;
        }
        assert_eq!(counted, CONTEXT_SOURCE_BYTES);
    }

}
