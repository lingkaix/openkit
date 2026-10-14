//! The local directory is a single source-owner scope, independent of product admission.
use crate::model::*;
use crate::text::*;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Seek, SeekFrom};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Fixed local view; MCP cannot change its root through a tool argument.
pub struct Directory {
    root: PathBuf,
    store: PathBuf,
    scope: String,
}
impl Directory {
    /// Bind one canonical directory and one derived cache directory.
    pub fn new(root: &Path, store: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(io_error)?;
        let store = fs::canonicalize(store).map_err(io_error)?;
        if root == store {
            return Err(error(
                "invalid-request",
                "derived store must be separate from source root",
            ));
        }
        let scope = format!("directory:{}", digest(root.as_os_str().as_encoded_bytes()));
        Ok(Self { root, store, scope })
    }
    /// Enumerate dotfiles and regular files without Git-ignore rules or symlink traversal.
    pub fn inventory(&self) -> Result<ScopeView> {
        let mut documents = Vec::new();
        let mut unavailable_objects = 0;
        let root = File::open(&self.root).map_err(io_error)?;
        self.visit(
            &root,
            Path::new(""),
            &mut documents,
            &mut unavailable_objects,
            0,
            &Budget::new(),
        )?;
        documents.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(ScopeView {
            scope: self.scope.clone(),
            documents,
            unavailable_objects,
        })
    }
    /// Query one startup-bound scope and withhold files that changed during the operation.
    pub fn search(
        &self,
        kernel: &crate::Kernel,
        mode: Mode,
        query: String,
        limit: usize,
    ) -> Result<SearchResult> {
        self.search_inner(kernel, mode, query, limit, || {})
    }
    /// Observe a final canonical reconciliation; tests can change a source at this exact boundary.
    pub(crate) fn search_inner(
        &self,
        kernel: &crate::Kernel,
        mode: Mode,
        query: String,
        limit: usize,
        after_search: impl FnOnce(),
    ) -> Result<SearchResult> {
        crate::query::validate_query(&Query {
            mode,
            query: query.clone(),
            scopes: vec![],
            limit,
        })?;
        let before = self.inventory()?;
        let mut result = kernel.search(Query {
            mode,
            query,
            limit,
            scopes: vec![before.clone()],
        })?;
        after_search();
        let after = self.inventory()?;
        if before != after {
            let live: BTreeMap<_, _> = after.documents.iter().map(|d| (&d.key, d)).collect();
            let changed: std::collections::BTreeSet<_> = before
                .documents
                .iter()
                .filter(|d| live.get(&d.key).is_none_or(|now| **now != **d))
                .map(|d| &d.key)
                .collect();
            result.hits.retain(|h| !changed.contains(&h.key));
            result.coverage.inventory_complete = false;
            result.coverage.enumeration_complete = false;
            *result
                .coverage
                .reasons
                .entry("directory-changed".into())
                .or_default() += 1;
            result.complete = false;
        }
        Ok(result)
    }
    /// Report the startup-bound scope identity.
    pub fn scope(&self) -> &str {
        &self.scope
    }
    /// Walk through held descriptors. A renamed directory cannot redirect this walk outside the root.
    fn visit(
        &self,
        directory: &File,
        relative_dir: &Path,
        documents: &mut Vec<Document>,
        unavailable_objects: &mut usize,
        depth: usize,
        budget: &Budget,
    ) -> Result<()> {
        budget.check()?;
        if depth > 64 {
            return Err(error(
                "resource-limited",
                "directory depth budget exhausted",
            ));
        }
        let entries = match names(directory) {
            Ok(entries) => entries,
            Err(e) if e.code == "unavailable" || e.code == "io" => {
                *unavailable_objects += 1;
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        for name in entries {
            budget.check()?;
            let relative = relative_dir.join(&name);
            if self.root.join(&relative) == self.store {
                continue;
            }
            if documents.len() + *unavailable_objects >= DOCUMENT_LIMIT {
                return Err(error(
                    "resource-limited",
                    "directory object budget exhausted",
                ));
            }
            #[cfg(test)]
            crate::tests::directory_boundary("stat", &self.root.join(&relative));
            let name_c = std::ffi::CString::new(name.as_bytes()).map_err(io_error)?;
            // SAFETY: fstatat receives a live parent descriptor, initialized storage, and a C name.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name_c.as_ptr(),
                    &mut stat,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } < 0
            {
                *unavailable_objects += 1;
                continue;
            }
            let kind = stat.st_mode & libc::S_IFMT;
            if kind != libc::S_IFREG && kind != libc::S_IFDIR {
                continue;
            }
            #[cfg(test)]
            crate::tests::directory_boundary("open", &self.root.join(&relative));
            // SAFETY: openat receives a held parent and a single component; symlinks are refused.
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name_c.as_ptr(),
                    libc::O_RDONLY
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW
                        | libc::O_NONBLOCK
                        | if kind == libc::S_IFDIR {
                            libc::O_DIRECTORY
                        } else {
                            0
                        },
                )
            };
            #[cfg(test)]
            if kind == libc::S_IFREG {
                crate::tests::access("directory-open", &relative.to_string_lossy());
            }
            if fd < 0 {
                *unavailable_objects += 1;
                continue;
            }
            // SAFETY: this successful open transfers ownership of the descriptor to File.
            let mut file = unsafe { File::from_raw_fd(fd) };
            if kind == libc::S_IFDIR {
                self.visit(
                    &file,
                    &relative,
                    documents,
                    unavailable_objects,
                    depth + 1,
                    budget,
                )?;
                continue;
            }
            let relative = relative
                .to_str()
                .ok_or_else(|| error("invalid-request", "directory path is not UTF-8"))?
                .to_string();
            let name = name
                .to_str()
                .ok_or_else(|| error("invalid-request", "directory filename is not UTF-8"))?
                .to_string();
            // No Document exists until canonical bytes and metadata have been verified.
            let identity = (|| -> Result<_> {
                let before = file.metadata().map_err(io_error)?;
                if !before.is_file() {
                    return Err(error("unavailable", "source type changed"));
                }
                let (hash, size) = digest_reader(&mut file, budget)?;
                file.seek(SeekFrom::Start(0)).map_err(io_error)?;
                let mut binary = false;
                let mut chunks = Chunks::new(&mut file);
                loop {
                    match chunks.next(budget) {
                        Ok(Some((_, text))) => binary |= text.as_bytes().contains(&0),
                        Ok(None) => break,
                        Err(e) if e.code == "failed" => {
                            binary = true;
                            break;
                        }
                        Err(e) => return Err(e),
                    }
                }
                let after = file.metadata().map_err(io_error)?;
                if before.ino() != after.ino()
                    || before.dev() != after.dev()
                    || before.len() != after.len()
                    || before.mtime() != after.mtime()
                    || before.mtime_nsec() != after.mtime_nsec()
                    || before.ctime() != after.ctime()
                    || before.ctime_nsec() != after.ctime_nsec()
                {
                    return Err(error("unavailable", "source changed during verification"));
                }
                let revision_metadata = format!(
                    "{}:{}:{}:{}:{}:{}:{}",
                    before.dev(),
                    before.ino(),
                    before.len(),
                    before.mtime(),
                    before.mtime_nsec(),
                    before.ctime(),
                    before.ctime_nsec()
                );
                let content = if binary {
                    Content::Unreadable
                } else {
                    Content::Text {
                        path: relative.clone(),
                        range: None,
                    }
                };
                Ok((hash, size, revision_metadata, content))
            })();
            let (hash, size, revision_metadata, content) = match identity {
                Ok(identity) => identity,
                Err(e) if e.code == "io" || e.code == "unavailable" => {
                    *unavailable_objects += 1;
                    continue;
                }
                Err(e) => return Err(e),
            };
            let media_type = if matches!(content, Content::Text { .. }) {
                "text/plain; charset=utf-8"
            } else {
                "application/octet-stream"
            }
            .into();
            let metadata = BTreeMap::from([("path".into(), relative.clone())]);
            let revision = digest(format!("{hash}:{revision_metadata}:{name}").as_bytes());
            documents.push(Document {
                key: SourceKey {
                    namespace: "directory".into(),
                    id: relative,
                },
                revision,
                digest: hash,
                size,
                name: name.clone(),
                title: name,
                media_type,
                content,
                language: None,
                metadata,
                locator: None,
            });
        }
        Ok(())
    }
}
/// Own a native directory stream until all bounded names have been copied.
struct Names(*mut libc::DIR);
impl Drop for Names {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
/// Collect bounded names from a held descriptor, including dotfiles but excluding dot entries.
fn names(directory: &File) -> Result<Vec<std::ffi::OsString>> {
    use std::os::fd::IntoRawFd;
    let fd = directory.try_clone().map_err(io_error)?.into_raw_fd();
    // SAFETY: fdopendir takes ownership of the duplicated descriptor on success.
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(error("unavailable", "directory enumeration unavailable"));
    }
    let stream = Names(raw);
    let mut names = Vec::new();
    loop {
        // SAFETY: readdir's pointer remains valid until the next call on this live stream.
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                return Err(error("unavailable", "directory enumeration stopped"));
            }
            break;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        if names.len() == DOCUMENT_LIMIT {
            return Err(error(
                "resource-limited",
                "directory entry budget exhausted",
            ));
        }
        names.push(std::ffi::OsString::from_vec(bytes.to_vec()));
    }
    names.sort();
    Ok(names)
}
