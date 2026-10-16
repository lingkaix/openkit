//! Filesystem inode reserves shared by NanoHost collection and volume seeding.

/// Applies the inode reserve only when the filesystem reports inode accounting.
///
/// Btrfs reports all three counts as zero because it has no fixed inode pool. Callers must still enforce their byte reserve and propagate allocation failures.
pub(crate) fn inode_reserve_available(facts: &libc::statvfs, growth: u64, reserve: u64) -> bool {
    if facts.f_files == 0 && facts.f_ffree == 0 && facts.f_favail == 0 {
        return true;
    }
    facts
        .f_favail
        .checked_sub(growth)
        .is_some_and(|remaining| remaining >= reserve)
}

#[cfg(test)]
#[path = "filesystem_capacity_tests.rs"]
mod tests;
