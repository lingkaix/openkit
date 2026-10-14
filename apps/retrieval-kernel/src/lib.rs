//! The domain-free Retrieval Kernel. Canonical files remain with their adapters.

/// Analyze text using the selected Document language and shared Latin normalization.
pub fn tokens(_language: &str, _text: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    /// The issue #222 body terms must survive segmentation on the shipped dictionaries.
    #[test]
    fn regression_222_segmentation() {
        let chinese = super::tokens("zh", "我们完成了测试，并修复了缺陷。").unwrap();
        assert!(chinese.contains(&"测试".into()), "Chinese body term lost: {chinese:?}");
        assert!(chinese.contains(&"修复".into()));
        let japanese = super::tokens("ja", "検索機能を改善しました。").unwrap();
        assert!(japanese.contains(&"検索".into()), "Japanese body term lost: {japanese:?}");
        assert!(japanese.contains(&"改善".into()));
    }
}
