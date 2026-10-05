//! Embedded OpenShell release metadata consumed by the NanoHost runtime.

use serde_json::Value;

#[cfg(target_arch = "x86_64")]
const PLATFORM: &str = "linux/amd64";
#[cfg(target_arch = "aarch64")]
const PLATFORM: &str = "linux/arm64";

const RELEASE_JSON: &str = include_str!("../openshell/release.json");

/// Returns the supported OpenShell version.
pub fn version() -> Option<String> {
    parse_release(RELEASE_JSON, PLATFORM)?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

/// Returns the exact Supervisor image for the current build architecture.
pub fn supervisor_image() -> Option<String> {
    let release = parse_release(RELEASE_JSON, PLATFORM)?;
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

/// Parses the target-selected stock Gateway pin before consuming embedded release facts.
fn parse_release(source: &str, platform: &str) -> Option<Value> {
    let archive_name = match platform {
        "linux/amd64" => "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
        "linux/arm64" => "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
        _ => return None,
    };
    let release: Value = serde_json::from_str(source).ok()?;
    let gateway = release.get("gateway")?.get("targets")?.get(platform)?;
    let archive = gateway.get("archive")?;
    let executable = gateway.get("executable")?;
    let valid_digest = |value: &Value| {
        value.as_str().is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    };
    if release.get("schemaVersion")?.as_u64()? != 2
        || archive.get("name")?.as_str()? != archive_name
        || archive.get("target")?.as_str()? != platform
        || executable.get("name")?.as_str()? != "openshell-gateway"
        || executable.get("derivedFrom")?.as_str()? != archive_name
        || !valid_digest(archive.get("sha256")?)
        || !valid_digest(executable.get("sha256")?)
    {
        return None;
    }
    Some(release)
}

#[cfg(test)]
mod tests {
    use super::{RELEASE_JSON, parse_release, supervisor_image, version};

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
    #[test]
    fn gateway_pins_are_selected_and_validated_for_each_target() {
        for target in ["linux/amd64", "linux/arm64"] {
            assert!(parse_release(RELEASE_JSON, target).is_some());
            for member in ["archive", "executable"] {
                let mut release: serde_json::Value = serde_json::from_str(RELEASE_JSON).unwrap();
                release["gateway"]["targets"][target][member]["sha256"] =
                    "COORDINATOR-PROBE-NEEDED".into();
                assert!(parse_release(&release.to_string(), target).is_none());
            }
            let mut release: serde_json::Value = serde_json::from_str(RELEASE_JSON).unwrap();
            release["gateway"]["targets"]
                .as_object_mut()
                .unwrap()
                .remove(target);
            assert!(parse_release(&release.to_string(), target).is_none());
        }
        assert!(parse_release(RELEASE_JSON, "linux/other").is_none());
    }
}
