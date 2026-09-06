//! Embedded OpenShell release metadata consumed by the NanoHost runtime.

use serde_json::Value;

const RELEASE_JSON: &str = include_str!("../openshell/release.json");

/// Returns the supported OpenShell version.
pub fn version() -> Option<String> {
    serde_json::from_str::<Value>(RELEASE_JSON)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

/// Returns the exact Supervisor image for the current build architecture.
pub fn supervisor_image() -> Option<String> {
    #[cfg(target_arch = "x86_64")]
    const PLATFORM: &str = "linux/amd64";
    #[cfg(target_arch = "aarch64")]
    const PLATFORM: &str = "linux/arm64";

    let release = serde_json::from_str::<Value>(RELEASE_JSON).ok()?;
    let repository = release.get("supervisor")?.get("repository")?.as_str()?;
    let digest = release
        .get("supervisor")?
        .get("platformDigests")?
        .get(PLATFORM)?
        .as_str()?;
    Some(format!(
        "{repository}:{}@{digest}",
        release.get("version")?.as_str()?
    ))
}

#[cfg(test)]
mod tests {
    use super::{RELEASE_JSON, supervisor_image, version};

    #[test]
    fn embedded_release_matches_the_cargo_sdk_revision() {
        let release: serde_json::Value =
            serde_json::from_str(RELEASE_JSON).expect("valid embedded OpenShell release");
        let commit = release["source"]["commit"]
            .as_str()
            .expect("OpenShell source commit");
        let dependency = format!("rev = \"{commit}\"");
        let locked = format!("?rev={commit}#{commit}");

        assert!(include_str!("../Cargo.toml").contains(&dependency));
        assert!(include_str!("../Cargo.lock").contains(&locked));
        assert_eq!(version().as_deref(), release["version"].as_str());
        assert!(supervisor_image().is_some());
    }
}
