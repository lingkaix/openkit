//! Regression cases for filesystem inode reporting.

use super::inode_reserve_available;

/// Supplies explicit filesystem facts without depending on the test host's inode accounting.
fn inode_facts(files: u64, free: u64, available: u64) -> libc::statvfs {
    // SAFETY: statvfs has only integer fields, and zero is valid for each field.
    let mut facts = unsafe { std::mem::zeroed::<libc::statvfs>() };
    facts.f_files = files as _;
    facts.f_ffree = free as _;
    facts.f_favail = available as _;
    facts
}

#[test]
fn unreported_inode_counts_do_not_mean_exhaustion() {
    let facts = inode_facts(0, 0, 0);
    for growth in [0, 1, 16] {
        assert!(
            inode_reserve_available(&facts, growth, 1024),
            "absent inode accounting must not deny growth of {growth} inodes"
        );
    }
}

#[test]
fn reported_inode_capacity_keeps_its_exact_reserve() {
    for (available, growth, reserve, expected) in [
        (0, 0, 1024, false),
        (1023, 0, 1024, false),
        (1024, 0, 1024, true),
        (1024, 1, 1024, false),
        (1025, 1, 1024, true),
        (1025, 2, 1024, false),
        (1, 2, 0, false),
    ] {
        let facts = inode_facts(8192, 4096, available);
        assert_eq!(
            inode_reserve_available(&facts, growth, reserve),
            expected,
            "available={available} growth={growth} reserve={reserve}"
        );
    }
}

#[test]
fn partial_zero_inode_counts_with_no_availability_fail_closed() {
    for (files, free) in [(8192, 0), (8192, 4096), (0, 4096)] {
        assert!(!inode_reserve_available(
            &inode_facts(files, free, 0),
            1,
            1024
        ));
    }
}

#[test]
fn reported_inode_growth_and_reserve_cannot_wrap() {
    let facts = inode_facts(u64::MAX, u64::MAX, u64::MAX);
    for (growth, reserve, expected) in [
        (u64::MAX, 0, true),
        (u64::MAX, 1, false),
        (u64::MAX - 1024, 1024, true),
        (u64::MAX - 1023, 1024, false),
        (0, u64::MAX, true),
        (1, u64::MAX, false),
    ] {
        assert_eq!(inode_reserve_available(&facts, growth, reserve), expected);
    }
    assert!(!inode_reserve_available(
        &inode_facts(8192, 4096, 1024),
        u64::MAX,
        0
    ));
}
