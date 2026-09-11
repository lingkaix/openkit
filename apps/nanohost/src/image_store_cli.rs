//! Local administrator command surface for the fixed NanoHost Image Store.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::image_store::{
    ImageStore, StoreEntryStatus, StoreError, StoreLineage, open_archive_nofollow,
};

/// Result of inspecting process arguments before service initialization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageStoreCliOutcome {
    /// The arguments do not select the literal `image` command family.
    NotHandled,
    /// The local operation completed; text excludes its terminal newline.
    Completed(String),
}

/// Bounded local command failure classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageStoreCliError {
    /// The `image` command shape or canonical numeric input is invalid.
    Usage,
    /// The shared store operation failed with its closed local error class.
    Store(StoreError),
}

impl From<StoreError> for ImageStoreCliError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// Dispatches one fixed-root local Image Store command before service startup.
///
/// `args` excludes the executable name. This function starts no runtime,
/// listener, network request, environment parser, or service lifecycle action.
/// Successful text never includes a terminal newline; the caller prints one.
///
/// # Errors
///
/// Returns a bounded usage or shared store failure without partial fallback.
pub fn dispatch(args: &[String]) -> Result<ImageStoreCliOutcome, ImageStoreCliError> {
    if args.first().map(String::as_str) != Some("image") {
        return Ok(ImageStoreCliOutcome::NotHandled);
    }
    #[derive(Clone, Copy)]
    enum Command<'a> {
        Import(&'a str, &'a str),
        Remove(&'a str),
        List,
        Capacity(Option<u64>),
    }
    let command = match args.get(1).map(String::as_str) {
        Some("import") if args.len() == 4 && canonical_digest(&args[3]) => {
            Command::Import(&args[2], &args[3])
        }
        Some("remove") if args.len() == 3 && canonical_digest(&args[2]) => {
            Command::Remove(&args[2])
        }
        Some("list") if args.len() == 2 => Command::List,
        Some("capacity") if args.len() == 2 => Command::Capacity(None),
        Some("capacity") if args.len() == 3 => Command::Capacity(Some(parse_capacity(&args[2])?)),
        _ => return Err(ImageStoreCliError::Usage),
    };
    let archive = match command {
        Command::Import(path, _) => Some(open_archive_nofollow(Path::new(path))?),
        _ => None,
    };
    let store = ImageStore::open_fixed()?;
    match command {
        Command::Import(_, digest) => {
            let acquired_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| ImageStoreCliError::Store(StoreError::Io))?
                .as_secs();
            store.admit_oci_file(
                digest,
                archive.expect("validated import command owns archive"),
                StoreLineage::LocalArchive(digest.to_string()),
                acquired_at,
            )?;
            Ok(ImageStoreCliOutcome::Completed(digest.to_string()))
        }
        Command::Remove(digest) => {
            store.remove(digest)?;
            Ok(ImageStoreCliOutcome::Completed(digest.to_string()))
        }
        Command::List => {
            let lines = store
                .list()?
                .into_iter()
                .map(|entry| {
                    let status = match entry.status {
                        StoreEntryStatus::Usable => "usable",
                        StoreEntryStatus::Incomplete => "incomplete",
                    };
                    let lineage = entry.lineage.map_or_else(
                        || "unavailable".to_string(),
                        |lineage| match lineage {
                            StoreLineage::Registry(value) => format!("registry:{value}"),
                            StoreLineage::Build(value) => format!("build:{value}"),
                            StoreLineage::LocalArchive(value) => {
                                format!("local-archive:{value}")
                            }
                        },
                    );
                    format!(
                        "digest={} size={} status={status} lineage={lineage}",
                        entry.digest, entry.size
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(ImageStoreCliOutcome::Completed(lines))
        }
        Command::Capacity(limit) => {
            let capacity = match limit {
                Some(limit) => store.set_capacity(limit)?,
                None => store.capacity()?,
            };
            Ok(ImageStoreCliOutcome::Completed(format!(
                "limit={} used={}",
                capacity.limit, capacity.used
            )))
        }
    }
}

fn canonical_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn parse_capacity(value: &str) -> Result<u64, ImageStoreCliError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ImageStoreCliError::Usage);
    }
    let capacity = value
        .parse::<u64>()
        .map_err(|_| ImageStoreCliError::Usage)?;
    if capacity == 0 {
        Err(ImageStoreCliError::Usage)
    } else {
        Ok(capacity)
    }
}

#[cfg(test)]
mod tests {
    use super::{ImageStoreCliError, ImageStoreCliOutcome, dispatch, parse_capacity};

    #[test]
    fn capacity_input_is_positive_canonical_decimal() {
        assert_eq!(parse_capacity("1"), Ok(1));
        assert_eq!(parse_capacity(&u64::MAX.to_string()), Ok(u64::MAX));
        for invalid in ["", "0", "01", "+1", " 1", "1\n", "18446744073709551616"] {
            assert_eq!(parse_capacity(invalid), Err(ImageStoreCliError::Usage));
        }
    }

    #[test]
    fn unrelated_and_invalid_commands_finish_before_fixed_store_open() {
        assert_eq!(dispatch(&[]), Ok(ImageStoreCliOutcome::NotHandled));
        assert_eq!(
            dispatch(&["version".to_string()]),
            Ok(ImageStoreCliOutcome::NotHandled)
        );
        assert_eq!(
            dispatch(&["image".to_string(), "unknown".to_string()]),
            Err(ImageStoreCliError::Usage)
        );
        assert_eq!(
            dispatch(&[
                "image".to_string(),
                "capacity".to_string(),
                "01".to_string(),
            ]),
            Err(ImageStoreCliError::Usage)
        );
    }
}
