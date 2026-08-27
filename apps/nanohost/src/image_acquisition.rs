//! Closed NanoHost-local image acquisition and bounded build execution.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, Instant};

use oci_client::client::{ClientConfig, ClientProtocol};
use oci_client::manifest::{
    IMAGE_MANIFEST_MEDIA_TYPE, OCI_IMAGE_MEDIA_TYPE, OciImageManifest, OciManifest,
};
use oci_client::secrets::RegistryAuth;
use oci_client::{Client, Reference, RegistryOperation};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWrite;

use crate::image_store::{IMAGE_STORE_MAX_BYTES, ImageStore, StoreLineage};

/// Hard build wall-clock ceiling.
pub const BUILD_MAX_TIME: Duration = Duration::from_secs(30 * 60);

/// Hard build OCI-output ceiling.
pub const BUILD_MAX_OUTPUT_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Hard V1 ceiling for the independently carried inline Dockerfile bytes.
const DOCKERFILE_INPUT_MAX_BYTES: usize = 256 * 1024 * 1024;

/// Hard V1 ceiling for one produced OCI manifest's layer count.
pub const BUILD_MAX_LAYERS: u32 = 128;

/// Sole V1 build-context reference accepted by NanoHost.
pub const EMPTY_BUILD_CONTEXT_REF: &str = "build-context://empty/v1";

/// SHA-256 of the sole V1 context's zero-entry empty-byte sequence.
pub const EMPTY_BUILD_CONTEXT_DIGEST: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Hard wall-clock bound for one anonymous public-registry acquisition.
const REGISTRY_MAX_TIME: Duration = Duration::from_secs(15 * 60);

/// Hard in-memory raw-manifest bound before descriptor parsing.
const REGISTRY_MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

/// The only callers authorized to initiate acquisition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquisitionTrigger {
    /// Explicit server-admin installation or maintenance action.
    DeploymentMaintenance,
    /// One already-authorized attempt carried by the control session.
    AuthorizedAttempt,
}

impl AcquisitionTrigger {
    /// Parses the closed acquisition trigger vocabulary.
    ///
    /// # Errors
    ///
    /// Returns an error for sandbox, worker, Gateway, backend, readiness, or
    /// any other caller class.
    pub fn parse(value: &str) -> Result<Self, AcquisitionError> {
        match value {
            "deployment-maintenance" => Ok(Self::DeploymentMaintenance),
            "authorized-attempt" => Ok(Self::AuthorizedAttempt),
            _ => Err(AcquisitionError::UnauthorizedTrigger),
        }
    }
}

/// Fail-closed acquisition and build error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquisitionError {
    /// The caller is outside the two accepted acquisition classes.
    UnauthorizedTrigger,
    /// A registry reference is mutable, malformed, private, or undeclared.
    InvalidRegistryReference,
    /// Returned content does not match the exact requested digest.
    DigestMismatch,
    /// A build definition or owned path is malformed or exceeds its bounds.
    InvalidBuildDefinition,
    /// The private builder cannot prove strict proxy-policy and OCI capability.
    UnsupportedBuildCapability,
    /// A direct backend command failed or exceeded its bound.
    Backend,
    /// An OCI result is malformed, oversized, over-layered, or unverifiable.
    InvalidOciResult,
    /// A private filesystem operation failed.
    Io,
}

impl From<io::Error> for AcquisitionError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

/// One exact image-effect input admitted from the outer session.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ImageEffectInput {
    /// Exact immutable public-registry reference.
    Reference(String),
    /// Immutable build-definition lineage carried without build bytes.
    Build {
        context_digest: String,
        dockerfile_digest: String,
        arguments_digest: String,
    },
}

/// Bounded image-effect request that carries reference or build lineage, never image bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEffectRequest {
    request_id: String,
    input: ImageEffectInput,
}

impl ImageEffectRequest {
    /// Creates one exact-reference acquisition request.
    pub fn reference(request_id: &str, reference: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            input: ImageEffectInput::Reference(reference.to_string()),
        }
    }

    /// Creates one immutable build-lineage request.
    pub fn build(
        request_id: &str,
        context_digest: &str,
        dockerfile_digest: &str,
        arguments_digest: &str,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            input: ImageEffectInput::Build {
                context_digest: context_digest.to_string(),
                dockerfile_digest: dockerfile_digest.to_string(),
                arguments_digest: arguments_digest.to_string(),
            },
        }
    }

    /// Validates exact reference identity or complete immutable build lineage.
    ///
    /// # Errors
    ///
    /// Rejects empty request identity, mutable references, and incomplete lineage.
    pub fn validate(&self) -> Result<(), AcquisitionError> {
        if self.request_id.is_empty() || self.request_id.contains(['\r', '\n', '\0']) {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        match &self.input {
            ImageEffectInput::Reference(reference) => {
                let parsed = Reference::try_from(reference.as_str())
                    .map_err(|_| AcquisitionError::InvalidRegistryReference)?;
                let digest = parsed
                    .digest()
                    .ok_or(AcquisitionError::InvalidRegistryReference)?;
                if parsed.tag().is_some() {
                    return Err(AcquisitionError::InvalidRegistryReference);
                }
                validate_digest(digest).map_err(|_| AcquisitionError::InvalidRegistryReference)
            }
            ImageEffectInput::Build {
                context_digest,
                dockerfile_digest,
                arguments_digest,
            } => {
                if valid_effect_lineage(context_digest)
                    && valid_effect_lineage(dockerfile_digest)
                    && valid_effect_lineage(arguments_digest)
                {
                    Ok(())
                } else {
                    Err(AcquisitionError::InvalidBuildDefinition)
                }
            }
        }
    }

    /// Returns the exact request identity carried by this image effect.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

/// Result evidence for one image effect, containing only identity and resulting digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEffectEvidence {
    request_id: String,
    resulting_digest: String,
}

impl ImageEffectEvidence {
    /// Creates non-authoritative digest evidence for one exact request.
    pub fn new(request_id: &str, resulting_digest: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            resulting_digest: resulting_digest.to_string(),
        }
    }

    /// Validates request identity and digest-shaped result evidence.
    ///
    /// # Errors
    ///
    /// Rejects empty request identity and mutable or non-digest result labels.
    pub fn validate(&self) -> Result<(), AcquisitionError> {
        if self.request_id.is_empty() || !valid_effect_lineage(&self.resulting_digest) {
            return Err(AcquisitionError::InvalidOciResult);
        }
        Ok(())
    }

    /// Returns the exact request identity for result correlation.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the resulting content digest without image bytes.
    pub fn resulting_digest(&self) -> &str {
        &self.resulting_digest
    }

    /// Verifies exact request/result correlation.
    ///
    /// # Errors
    ///
    /// Rejects evidence produced for another request identity.
    pub fn validate_result_identity(&self, request_id: &str) -> Result<(), AcquisitionError> {
        if self.request_id != request_id {
            return Err(AcquisitionError::InvalidOciResult);
        }
        self.validate()
    }
}

/// Returns whether bounded image-effect lineage carries a non-empty digest label.
fn valid_effect_lineage(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|digest| !digest.is_empty() && !digest.contains(['\r', '\n', '\0']))
}

/// Validated exact public-registry acquisition request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryAcquisition {
    reference: Reference,
    digest: String,
}

impl RegistryAcquisition {
    /// Validates one exact Docker Hub or GHCR digest reference.
    ///
    /// # Errors
    ///
    /// Rejects mutable, private, malformed, or undeclared references.
    pub fn validate(
        _trigger: AcquisitionTrigger,
        reference: &str,
        declared_registries: &BTreeSet<String>,
    ) -> Result<Self, AcquisitionError> {
        let parsed = Reference::try_from(reference)
            .map_err(|_| AcquisitionError::InvalidRegistryReference)?;
        let digest = parsed
            .digest()
            .ok_or(AcquisitionError::InvalidRegistryReference)?
            .to_string();
        validate_digest(&digest)?;
        let host = parsed.registry();
        if reference.contains(['\r', '\n', '\0', '?', '#'])
            || parsed.tag().is_some()
            || !matches!(host, "docker.io" | "ghcr.io")
            || !declared_registries.contains(host)
            || declared_registries
                .iter()
                .any(|registry| !matches!(registry.as_str(), "docker.io" | "ghcr.io"))
        {
            return Err(AcquisitionError::InvalidRegistryReference);
        }
        Ok(Self {
            reference: parsed,
            digest,
        })
    }

    /// Re-verifies returned registry bytes against the exact requested digest.
    ///
    /// # Errors
    ///
    /// Returns [`AcquisitionError::DigestMismatch`] on any mismatch.
    pub fn verify_content(&self, content: &[u8]) -> Result<String, AcquisitionError> {
        let actual = format!("sha256:{:x}", Sha256::digest(content));
        if actual == self.digest {
            Ok(actual)
        } else {
            Err(AcquisitionError::DigestMismatch)
        }
    }

    /// Retrieves one anonymous exact-digest image graph and admits its verified OCI archive.
    ///
    /// # Errors
    ///
    /// Fails closed on client construction, authentication, retrieval, descriptor,
    /// bound, staging, archive, cleanup, or store-admission failure.
    pub async fn acquire(
        &self,
        staging_root: &Path,
        store: &mut ImageStore,
        protected: &BTreeSet<String>,
        acquired_at: u64,
    ) -> Result<String, AcquisitionError> {
        validate_owned_path(staging_root)?;
        if staging_root.exists() {
            return Err(AcquisitionError::InvalidRegistryReference);
        }
        let archive_result = tokio::time::timeout(
            REGISTRY_MAX_TIME,
            self.retrieve_registry_archive(staging_root),
        )
        .await
        .map_err(|_| AcquisitionError::Backend)
        .and_then(|result| result);
        let cleanup_result = match fs::remove_dir_all(staging_root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AcquisitionError::Io),
        };
        cleanup_result?;
        let archive = archive_result?;
        if oci_manifest_digest(&archive)? != self.digest {
            return Err(AcquisitionError::DigestMismatch);
        }
        store
            .admit_oci(
                &self.digest,
                &archive,
                StoreLineage::Registry(self.reference.whole()),
                acquired_at,
                protected,
            )
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        Ok(self.digest.clone())
    }

    /// Retrieves and stages the exact graph without touching the store or backend.
    async fn retrieve_registry_archive(
        &self,
        staging_root: &Path,
    ) -> Result<Vec<u8>, AcquisitionError> {
        let client = Client::try_from(ClientConfig {
            protocol: ClientProtocol::Https,
            accept_invalid_certificates: false,
            platform_resolver: None,
            max_concurrent_download: 1,
            connect_timeout: Some(Duration::from_secs(10)),
            read_timeout: Some(REGISTRY_MAX_TIME),
            ..Default::default()
        })
        .map_err(|_| AcquisitionError::Backend)?;
        client
            .auth(
                &self.reference,
                &RegistryAuth::Anonymous,
                RegistryOperation::Pull,
            )
            .await
            .map_err(|_| AcquisitionError::Backend)?;
        let (raw_manifest, actual_digest) = client
            .pull_manifest_raw(
                &self.reference,
                &RegistryAuth::Anonymous,
                &[OCI_IMAGE_MEDIA_TYPE, IMAGE_MANIFEST_MEDIA_TYPE],
            )
            .await
            .map_err(|_| AcquisitionError::Backend)?;
        if actual_digest != self.digest {
            return Err(AcquisitionError::DigestMismatch);
        }
        self.verify_content(&raw_manifest)?;
        let manifest = parse_image_manifest(&raw_manifest)?;
        let descriptor_sizes =
            prepare_registry_layout(self, &raw_manifest, &manifest, staging_root)?;
        let mut downloaded = BTreeSet::new();
        for descriptor in std::iter::once(&manifest.config).chain(manifest.layers.iter()) {
            if !downloaded.insert(descriptor.digest.clone()) {
                continue;
            }
            let stem = digest_hex(&descriptor.digest)?;
            let final_path = staging_root.join("blobs/sha256").join(stem);
            let partial_path = staging_root
                .join("blobs/sha256")
                .join(format!(".{stem}.part"));
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&partial_path)?;
            let declared_size = *descriptor_sizes
                .get(&descriptor.digest)
                .ok_or(AcquisitionError::InvalidOciResult)?;
            let mut writer = BoundedBlobWriter::new(tokio::fs::File::from_std(file), declared_size);
            client
                .pull_blob(&self.reference, descriptor, &mut writer)
                .await
                .map_err(|_| AcquisitionError::Backend)?;
            writer.sync_all().await?;
            if writer.written() != declared_size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            fs::rename(partial_path, final_path)?;
        }
        archive_registry_layout(staging_root, &self.digest, &descriptor_sizes)
    }
}

/// Stages already retrieved manifest and blob bytes as one minimal verified OCI layout.
///
/// # Errors
///
/// Rejects non-image manifests, missing or extra blobs, digest or size mismatch,
/// unsafe paths, bounds overflow, and every partial filesystem result. A failure
/// removes the staging root created by this call.
pub(crate) fn stage_registry_layout(
    acquisition: &RegistryAcquisition,
    raw_manifest: &[u8],
    blobs: &[(&str, &[u8])],
    staging_root: &Path,
) -> Result<(), AcquisitionError> {
    validate_owned_path(staging_root)?;
    if staging_root.exists() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let result = (|| {
        let manifest = parse_image_manifest(raw_manifest)?;
        let expected = prepare_registry_layout(acquisition, raw_manifest, &manifest, staging_root)?;
        let mut supplied = BTreeMap::new();
        for (digest, bytes) in blobs {
            if supplied.insert(*digest, *bytes).is_some() {
                return Err(AcquisitionError::InvalidOciResult);
            }
        }
        if supplied.len() != expected.len() {
            return Err(AcquisitionError::InvalidOciResult);
        }
        for (digest, declared_size) in expected {
            let bytes = supplied
                .get(digest.as_str())
                .ok_or(AcquisitionError::InvalidOciResult)?;
            if bytes.len() as u64 != declared_size
                || format!("sha256:{:x}", Sha256::digest(bytes)) != digest
            {
                return Err(AcquisitionError::InvalidOciResult);
            }
            write_new_private_file(
                &staging_root.join("blobs/sha256").join(digest_hex(&digest)?),
                bytes,
            )?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_root);
    }
    result
}

/// Parses and restricts raw registry bytes to one concrete image manifest.
fn parse_image_manifest(raw_manifest: &[u8]) -> Result<OciImageManifest, AcquisitionError> {
    if raw_manifest.is_empty() || raw_manifest.len() > REGISTRY_MAX_MANIFEST_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifest: OciManifest =
        serde_json::from_slice(raw_manifest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let OciManifest::Image(manifest) = manifest else {
        return Err(AcquisitionError::InvalidOciResult);
    };
    if manifest.schema_version != 2
        || !matches!(
            manifest.media_type.as_deref(),
            Some(OCI_IMAGE_MEDIA_TYPE | IMAGE_MANIFEST_MEDIA_TYPE)
        )
        || manifest.artifact_type.is_some()
        || manifest.subject.is_some()
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(manifest)
}

/// Creates the fixed metadata and raw-manifest portion of one fresh OCI layout.
fn prepare_registry_layout(
    acquisition: &RegistryAcquisition,
    raw_manifest: &[u8],
    manifest: &OciImageManifest,
    staging_root: &Path,
) -> Result<BTreeMap<String, u64>, AcquisitionError> {
    acquisition.verify_content(raw_manifest)?;
    let descriptor_sizes = validated_descriptor_sizes(manifest, raw_manifest.len() as u64)?;
    if descriptor_sizes.contains_key(&acquisition.digest) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    DirBuilder::new().mode(0o700).create(staging_root)?;
    create_private_dir(&staging_root.join("blobs"))?;
    create_private_dir(&staging_root.join("blobs/sha256"))?;
    write_new_private_file(
        &staging_root.join("oci-layout"),
        b"{\"imageLayoutVersion\":\"1.0.0\"}\n",
    )?;
    let index = format!(
        "{{\"schemaVersion\":2,\"manifests\":[{{\"mediaType\":{},\"digest\":{},\"size\":{}}}]}}\n",
        serde_json::to_string(
            manifest
                .media_type
                .as_deref()
                .ok_or(AcquisitionError::InvalidOciResult)?
        )
        .map_err(|_| AcquisitionError::InvalidOciResult)?,
        serde_json::to_string(&acquisition.digest)
            .map_err(|_| AcquisitionError::InvalidOciResult)?,
        raw_manifest.len()
    );
    write_new_private_file(&staging_root.join("index.json"), index.as_bytes())?;
    write_new_private_file(
        &staging_root
            .join("blobs/sha256")
            .join(digest_hex(&acquisition.digest)?),
        raw_manifest,
    )?;
    Ok(descriptor_sizes)
}

/// Validates every unique config and layer descriptor and the whole graph bound.
fn validated_descriptor_sizes(
    manifest: &OciImageManifest,
    manifest_size: u64,
) -> Result<BTreeMap<String, u64>, AcquisitionError> {
    let mut total = manifest_size;
    let mut descriptors = BTreeMap::new();
    for descriptor in std::iter::once(&manifest.config).chain(manifest.layers.iter()) {
        if descriptor.urls.is_some() || descriptor.size < 0 {
            return Err(AcquisitionError::InvalidOciResult);
        }
        validate_digest(&descriptor.digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
        let size = descriptor.size as u64;
        if let Some(existing) = descriptors.insert(descriptor.digest.clone(), size) {
            if existing != size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            continue;
        }
        total = total
            .checked_add(size)
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if total > IMAGE_STORE_MAX_BYTES {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    Ok(descriptors)
}

/// Returns the canonical hex path component for one SHA-256 digest.
fn digest_hex(digest: &str) -> Result<&str, AcquisitionError> {
    validate_digest(digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    digest
        .strip_prefix("sha256:")
        .ok_or(AcquisitionError::InvalidOciResult)
}

/// Writes one new private staging file without following an existing path.
fn write_new_private_file(path: &Path, contents: &[u8]) -> Result<(), AcquisitionError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

/// Async file writer that rejects a registry response beyond its descriptor size.
struct BoundedBlobWriter {
    file: tokio::fs::File,
    written: u64,
    limit: u64,
}

impl BoundedBlobWriter {
    /// Wraps one fresh partial blob file with its exact descriptor ceiling.
    fn new(file: tokio::fs::File, limit: u64) -> Self {
        Self {
            file,
            written: 0,
            limit,
        }
    }

    /// Returns the successfully written byte count.
    fn written(&self) -> u64 {
        self.written
    }

    /// Flushes blob bytes and metadata to stable storage.
    async fn sync_all(&self) -> Result<(), AcquisitionError> {
        self.file.sync_all().await.map_err(Into::into)
    }
}

impl AsyncWrite for BoundedBlobWriter {
    /// Writes one response chunk without crossing the descriptor ceiling.
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buffer.len() as u64 > self.limit.saturating_sub(self.written) {
            return Poll::Ready(Err(io::Error::other(
                "registry blob exceeded descriptor size",
            )));
        }
        match Pin::new(&mut self.file).poll_write(context, buffer) {
            Poll::Ready(Ok(written)) => {
                self.written += written as u64;
                Poll::Ready(Ok(written))
            }
            result => result,
        }
    }

    /// Flushes the underlying partial blob file.
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_flush(context)
    }

    /// Shuts down the underlying partial blob file.
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_shutdown(context)
    }
}

/// Accepted immutable build-definition projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildDefinition {
    /// Exact singleton context reference preserved from the resolved AEP.
    pub context_ref: String,
    /// Digest of the separately accepted local build context.
    pub context_digest: String,
    /// Dockerfile data consumed only by the backend build operation.
    pub dockerfile: String,
    /// Declared non-secret build arguments.
    pub arguments: Vec<(String, String)>,
    /// Exact hostname or HTTPS endpoint build-only grants.
    pub egress_grants: BTreeSet<String>,
    /// Declared wall-clock bound.
    pub time_limit: Duration,
    /// Declared OCI output-size bound.
    pub output_limit_bytes: u64,
    /// Declared maximum manifest layer count.
    pub layer_limit: u32,
}

impl BuildDefinition {
    /// Returns deterministic non-secret build-definition lineage.
    pub fn lineage(&self) -> String {
        let mut hasher = Sha256::new();
        hash_field(&mut hasher, self.context_ref.as_bytes());
        hash_field(&mut hasher, self.context_digest.as_bytes());
        hash_field(&mut hasher, self.dockerfile.as_bytes());
        for (key, value) in &self.arguments {
            hash_field(&mut hasher, key.as_bytes());
            hash_field(&mut hasher, value.as_bytes());
        }
        for grant in &self.egress_grants {
            hash_field(&mut hasher, grant.as_bytes());
        }
        hash_field(&mut hasher, &self.time_limit.as_secs().to_be_bytes());
        hash_field(&mut hasher, &self.output_limit_bytes.to_be_bytes());
        hash_field(&mut hasher, &self.layer_limit.to_be_bytes());
        format!("sha256:{:x}", hasher.finalize())
    }
}

/// Exact private-builder capability snapshot proved before a build effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildCapabilities {
    /// Embedded BuildKit semantic version.
    pub buildkit_version: String,
    /// Buildx semantic version.
    pub buildx_version: String,
    /// Whether the versioned strict policy path supplies `exec.proxy`.
    pub exec_proxy: bool,
}

impl BuildCapabilities {
    /// Proves the minimum versioned strict proxy-network tuple.
    ///
    /// # Errors
    ///
    /// Fails before build execution when any required capability is absent.
    pub fn preflight(&self) -> Result<(), AcquisitionError> {
        if version_at_least(&self.buildkit_version, (0, 31, 0))
            && version_at_least(&self.buildx_version, (0, 35, 0))
            && self.exec_proxy
        {
            Ok(())
        } else {
            Err(AcquisitionError::UnsupportedBuildCapability)
        }
    }

    /// Probes the exact epoch-private Docker driver without selecting another builder.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed capability error for unavailable or ambiguous output.
    pub fn probe(docker_socket: &Path) -> Result<Self, AcquisitionError> {
        validate_owned_path(docker_socket)?;
        let buildx = Command::new("/usr/bin/docker")
            .args(["buildx", "version"])
            .env("DOCKER_HOST", format!("unix://{}", docker_socket.display()))
            .env_remove("BUILDX_BUILDER")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
        if !buildx.status.success() {
            return Err(AcquisitionError::UnsupportedBuildCapability);
        }
        let buildx_output = String::from_utf8(buildx.stdout)
            .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
        let buildx_version =
            first_semver(&buildx_output).ok_or(AcquisitionError::UnsupportedBuildCapability)?;

        let inspect = Command::new("/usr/bin/docker")
            .args(["buildx", "inspect", "--bootstrap"])
            .env("DOCKER_HOST", format!("unix://{}", docker_socket.display()))
            .env_remove("BUILDX_BUILDER")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
        if !inspect.status.success() {
            return Err(AcquisitionError::UnsupportedBuildCapability);
        }
        let inspect_output = String::from_utf8(inspect.stdout)
            .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
        let buildkit_version = inspect_output
            .lines()
            .find_map(|line| line.trim().strip_prefix("BuildKit version:").map(str::trim))
            .and_then(first_semver)
            .or_else(|| {
                inspect_output
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("Version:").map(str::trim))
                    .and_then(first_semver)
            })
            .ok_or(AcquisitionError::UnsupportedBuildCapability)?;
        let capabilities = Self {
            exec_proxy: version_at_least(&buildkit_version, (0, 31, 0)),
            buildkit_version,
            buildx_version,
        };
        capabilities.preflight()?;
        Ok(capabilities)
    }
}

/// Direct, fixed Buildx execution plan for one accepted build definition.
#[derive(Debug, Clone)]
pub struct BuildPlan {
    definition: BuildDefinition,
    program: PathBuf,
    env: Vec<(String, String)>,
    args: Vec<String>,
    policy_contents: String,
    allowed_egress: BTreeSet<String>,
    build_root: PathBuf,
    docker_socket: PathBuf,
}

impl BuildPlan {
    /// Validates and compiles one fixed private-backend build plan.
    ///
    /// # Errors
    ///
    /// Rejects unbounded, secret-bearing, host-authority-widening, or unsafe input.
    pub fn validate(
        definition: BuildDefinition,
        declared_registries: &BTreeSet<String>,
        docker_socket: &Path,
        build_root: &Path,
    ) -> Result<Self, AcquisitionError> {
        validate_build_definition(&definition, declared_registries)?;
        validate_owned_path(docker_socket)?;
        validate_owned_path(build_root)?;
        let allowed_egress = declared_registries
            .iter()
            .chain(definition.egress_grants.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        let image_refs = exact_from_references(&definition.dockerfile, declared_registries)?;
        let policy_contents =
            render_policy(declared_registries, &definition.egress_grants, &image_refs);
        let context_root = build_root.join("context");
        let output_path = build_root.join("result.oci.tar");
        let metadata_path = build_root.join("metadata.json");
        let mut args = vec![
            "buildx".into(),
            "build".into(),
            "--policy".into(),
            "filename=cwd://policy.rego,reset=true,strict=true".into(),
            "--network".into(),
            "default".into(),
            "--output".into(),
            format!("type=oci,dest={}", output_path.display()),
            "--metadata-file".into(),
            metadata_path.display().to_string(),
            "--progress".into(),
            "plain".into(),
            "--file".into(),
            build_root.join("Dockerfile").display().to_string(),
        ];
        for (key, value) in &definition.arguments {
            args.push("--build-arg".into());
            args.push(format!("{key}={value}"));
        }
        args.push(context_root.display().to_string());
        Ok(Self {
            definition,
            program: PathBuf::from("/usr/bin/docker"),
            env: vec![(
                "DOCKER_HOST".into(),
                format!("unix://{}", docker_socket.display()),
            )],
            args,
            policy_contents,
            allowed_egress,
            build_root: build_root.to_path_buf(),
            docker_socket: docker_socket.to_path_buf(),
        })
    }

    /// Executes the direct bounded build and verifies its OCI-only result.
    ///
    /// This method exclusively creates the build root and the accepted empty
    /// context, writes the independent Dockerfile and generated policy outside
    /// that context, and removes the exact owned root before returning.
    ///
    /// # Errors
    ///
    /// Fails closed before execution on missing capabilities, then on timeout,
    /// command failure, output overflow, layer overflow, or digest mismatch.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn execute(&self) -> Result<VerifiedOciImage, AcquisitionError> {
        let mut owns_build_root = false;
        let result = (|| {
            create_private_dir(&self.build_root)?;
            owns_build_root = true;
            let context_root = self.build_root.join("context");
            create_private_dir(&context_root)?;
            if fs::read_dir(&context_root)?.next().transpose()?.is_some() {
                return Err(AcquisitionError::InvalidBuildDefinition);
            }
            BuildCapabilities::probe(&self.docker_socket)?;
            write_private_file(
                &self.build_root.join("Dockerfile"),
                self.definition.dockerfile.as_bytes(),
            )?;
            write_private_file(
                &self.build_root.join("policy.rego"),
                self.policy_contents.as_bytes(),
            )?;
            let mut child = Command::new(&self.program)
                .args(&self.args)
                .envs(self.env.iter().cloned())
                .env_remove("BUILDX_BUILDER")
                .current_dir(&self.build_root)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|_| AcquisitionError::Backend)?;
            if !wait_for_child(&mut child, self.definition.time_limit)? {
                return Err(AcquisitionError::Backend);
            }
            verify_oci_result(
                &self.build_root.join("result.oci.tar"),
                &self.build_root.join("metadata.json"),
                self.definition.output_limit_bytes,
                self.definition.layer_limit,
            )
        })();
        if owns_build_root {
            match fs::remove_dir_all(&self.build_root) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(AcquisitionError::Io),
            }
        }
        result
    }

    /// Executes and atomically admits one verified attempt image into the store.
    ///
    /// # Errors
    ///
    /// Returns a build or store-verification failure without changing epoch health.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn execute_and_admit(
        &self,
        store: &mut ImageStore,
        protected: &BTreeSet<String>,
        acquired_at: u64,
    ) -> Result<String, AcquisitionError> {
        let result = self.execute()?;
        store
            .admit_oci(
                &result.digest,
                &result.content,
                StoreLineage::Build(self.lineage()),
                acquired_at,
                protected,
            )
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        Ok(result.digest)
    }

    /// Returns the direct Docker executable.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns the exact private-socket environment.
    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// Returns the fixed Buildx argument vector.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    /// Returns the generated strict deny-by-default Rego policy.
    pub fn policy_contents(&self) -> &str {
        &self.policy_contents
    }

    /// Returns the exact union of declared registries and build-only grants.
    pub fn allowed_egress(&self) -> &BTreeSet<String> {
        &self.allowed_egress
    }

    /// Returns no runtime sandbox egress because build authority is not projected.
    pub fn sandbox_egress_projection(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }

    /// Returns deterministic build-definition lineage.
    pub fn lineage(&self) -> String {
        self.definition.lineage()
    }

    /// Returns whether the direct plan uses a shell.
    pub fn uses_shell(&self) -> bool {
        false
    }

    /// Returns whether the plan requests the host network namespace.
    pub fn uses_host_network(&self) -> bool {
        false
    }

    /// Returns whether the plan requests a host mount.
    pub fn uses_host_mount(&self) -> bool {
        false
    }

    /// Returns whether the plan loads, tags, pushes, or publishes its result.
    pub fn publishes(&self) -> bool {
        false
    }
}

/// Verified OCI-only build output retained outside runtime state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOciImage {
    /// Exact OCI manifest digest reported and re-verified from the archive.
    pub digest: String,
    /// Verified OCI archive bytes retained only until Image Store admission.
    pub content: Vec<u8>,
    /// Verified archive byte size.
    pub size: u64,
    /// Verified manifest layer count.
    pub layers: u32,
}

/// Validates the immutable bounded build definition.
#[allow(clippy::needless_as_bytes)]
fn validate_build_definition(
    definition: &BuildDefinition,
    declared_registries: &BTreeSet<String>,
) -> Result<(), AcquisitionError> {
    if definition.context_ref != EMPTY_BUILD_CONTEXT_REF
        || definition.context_digest != EMPTY_BUILD_CONTEXT_DIGEST
        || definition.dockerfile.is_empty()
        || definition.dockerfile.as_bytes().len() > DOCKERFILE_INPUT_MAX_BYTES
        || definition.dockerfile.contains('\0')
        || definition.time_limit.is_zero()
        || definition.time_limit > BUILD_MAX_TIME
        || definition.output_limit_bytes == 0
        || definition.output_limit_bytes > BUILD_MAX_OUTPUT_BYTES
        || definition.layer_limit == 0
        || definition.layer_limit > BUILD_MAX_LAYERS
        || definition.egress_grants.is_empty()
        || declared_registries.is_empty()
        || declared_registries
            .iter()
            .any(|host| !matches!(host.as_str(), "docker.io" | "ghcr.io"))
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    let dockerfile_lower = definition.dockerfile.to_ascii_lowercase();
    for forbidden in [
        "--mount=type=bind",
        "--network=host",
        "--mount=type=secret",
        "--mount=type=ssh",
    ] {
        if dockerfile_lower.contains(forbidden) {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for line in definition.dockerfile.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if (lower.starts_with("add ") || lower.starts_with("copy --from="))
            && (lower.contains("http://") || lower.contains("https://") || lower.contains("git://"))
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for (key, value) in &definition.arguments {
        if !valid_argument_name(key)
            || value.contains(['\0', '\r', '\n'])
            || secret_bearing_name(key)
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for grant in &definition.egress_grants {
        validate_egress_grant(grant)?;
    }
    Ok(())
}

/// Renders the closed strict Buildx policy from already validated values.
fn render_policy(
    registries: &BTreeSet<String>,
    grants: &BTreeSet<String>,
    image_refs: &BTreeSet<String>,
) -> String {
    let mut lines = vec![
        "package docker".to_string(),
        String::new(),
        "default allow := false".into(),
        "default deny_msg := []".into(),
        "default caps := {}".into(),
        String::new(),
        "caps := {\"exec.proxy\": true} if input.env.capsRequest".into(),
        "allow if input.env.capsRequest".into(),
        "allow if input.local".into(),
    ];
    for host in grants.iter().filter(|grant| !grant.starts_with("https://")) {
        let authority = if host.contains(':') {
            host.clone()
        } else {
            format!("{host}:443")
        };
        lines.extend([
            String::new(),
            "allow if {".into(),
            "\tinput.http.schema == \"https\"".into(),
            format!("\tinput.http.host == \"{authority}\""),
            "}".into(),
        ]);
    }
    for host in registries {
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.image.host == \"{host}:443\""),
            "}".into(),
        ]);
    }
    for url in grants.iter().filter(|grant| grant.starts_with("https://")) {
        let endpoint = url
            .strip_prefix("https://")
            .expect("validated HTTPS endpoint");
        let (authority, path) = endpoint
            .split_once('/')
            .expect("validated complete HTTPS endpoint");
        let policy_url = if authority.contains(':') {
            url.clone()
        } else {
            format!("https://{authority}:443/{path}")
        };
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.http.url == \"{policy_url}\""),
            "}".into(),
        ]);
    }
    for reference in image_refs {
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.image.ref == \"{reference}\""),
            "}".into(),
        ]);
    }
    lines.extend([
        String::new(),
        "deny_msg := [\"source or build egress endpoint is outside the declared ceiling\"] if not allow".into(),
        "decision := {\"allow\": allow, \"deny_msg\": deny_msg, \"caps\": caps}".into(),
        String::new(),
    ]);
    lines.join("\n")
}

/// Extracts exact immutable non-scratch `FROM` references from Dockerfile data.
fn exact_from_references(
    dockerfile: &str,
    declared_registries: &BTreeSet<String>,
) -> Result<BTreeSet<String>, AcquisitionError> {
    let mut references = BTreeSet::new();
    for line in dockerfile.lines() {
        let mut words = line.split_whitespace();
        if !words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("FROM"))
        {
            continue;
        }
        let reference = words
            .find(|word| !word.starts_with("--"))
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        if reference.eq_ignore_ascii_case("scratch") {
            continue;
        }
        let parsed =
            Reference::try_from(reference).map_err(|_| AcquisitionError::InvalidBuildDefinition)?;
        let digest = parsed
            .digest()
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        validate_digest(digest)?;
        if reference.contains(['\r', '\n', '"']) || !declared_registries.contains(parsed.registry())
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        references.insert(parsed.whole());
    }
    Ok(references)
}

/// Validates an exact hostname or complete HTTPS endpoint grant.
fn validate_egress_grant(value: &str) -> Result<(), AcquisitionError> {
    if value.is_empty()
        || value.contains(['*', '"', '\'', '\\', '\r', '\n', '\0'])
        || value.starts_with('.')
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    if let Some(endpoint) = value.strip_prefix("https://") {
        let (authority, path) = endpoint
            .split_once('/')
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        let host = authority
            .split_once(':')
            .map_or(authority, |(host, _)| host);
        if !valid_hostname(host) || path.is_empty() || path.contains('*') {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        if let Some((_, port)) = authority.split_once(':') {
            let port = port
                .parse::<u16>()
                .map_err(|_| AcquisitionError::InvalidBuildDefinition)?;
            if port == 0 {
                return Err(AcquisitionError::InvalidBuildDefinition);
            }
        }
        return Ok(());
    }
    let (host, port) = value
        .split_once(':')
        .map_or((value, None), |(host, port)| (host, Some(port)));
    if value.contains("://")
        || value.contains('/')
        || !valid_hostname(host)
        || port.is_some_and(|port| port.parse::<u16>().ok().is_none_or(|port| port == 0))
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    Ok(())
}

/// Returns whether a hostname is exact ASCII DNS syntax without suffix shorthand.
fn valid_hostname(value: &str) -> bool {
    value.len() <= 253
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// Returns whether a build argument name has closed environment-key syntax.
fn valid_argument_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Rejects build argument names likely to carry credentials.
fn secret_bearing_name(value: &str) -> bool {
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "API_KEY",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

/// Adds a length-delimited field to deterministic lineage hashing.
fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Validates a canonical lowercase SHA-256 digest.
fn validate_digest(value: &str) -> Result<(), AcquisitionError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(AcquisitionError::InvalidBuildDefinition);
    };
    if hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(AcquisitionError::InvalidBuildDefinition)
    }
}

/// Validates one absolute, traversal-free owner path.
fn validate_owned_path(path: &Path) -> Result<(), AcquisitionError> {
    if path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                Component::RootDir | Component::Normal(_) | Component::Prefix(_)
            )
        })
    {
        Ok(())
    } else {
        Err(AcquisitionError::InvalidBuildDefinition)
    }
}

/// Parses the first numeric semantic version from command output.
fn first_semver(value: &str) -> Option<String> {
    value.split_whitespace().find_map(|word| {
        let candidate = word
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '.');
        let candidate = candidate.strip_prefix('v').unwrap_or(candidate);
        parse_version(candidate).map(|version| format!("{}.{}.{}", version.0, version.1, version.2))
    })
}

/// Returns whether a semantic version meets a minimum tuple.
fn version_at_least(value: &str, minimum: (u64, u64, u64)) -> bool {
    parse_version(value).is_some_and(|version| version >= minimum)
}

/// Parses the numeric major, minor, and patch prefix.
fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim().trim_start_matches('v');
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts
        .next()?
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

/// Creates a private build directory.
fn create_private_dir(path: &Path) -> Result<(), AcquisitionError> {
    validate_owned_path(path)?;
    let parent = path
        .parent()
        .filter(|parent| *parent != path)
        .ok_or(AcquisitionError::InvalidBuildDefinition)?;
    if parent.exists() {
        let metadata = fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    } else {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    DirBuilder::new().mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Writes one private generated build input without following an existing path.
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), AcquisitionError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

/// Waits for one direct child within the declared build bound.
fn wait_for_child(child: &mut Child, limit: Duration) -> Result<bool, AcquisitionError> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AcquisitionError::Backend);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(AcquisitionError::Backend)
}

/// Verifies one OCI archive, its metadata digest, size, and layer bound.
fn verify_oci_result(
    archive_path: &Path,
    metadata_path: &Path,
    output_limit: u64,
    layer_limit: u32,
) -> Result<VerifiedOciImage, AcquisitionError> {
    let size = fs::metadata(archive_path)?.len();
    if size == 0 || size > output_limit || size > BUILD_MAX_OUTPUT_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let metadata = fs::read_to_string(metadata_path)?;
    let metadata_digest = json_string(&metadata, "containerimage.digest")
        .ok_or(AcquisitionError::InvalidOciResult)?;
    validate_digest(&metadata_digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let content = fs::read(archive_path)?;
    let digest = oci_manifest_digest(&content)?;
    if digest != metadata_digest {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifest = parse_image_manifest(&oci_manifest_bytes(&content, &digest)?)?;
    let layers = manifest.layers.len() as u32;
    if layers > layer_limit {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(VerifiedOciImage {
        digest,
        content,
        size,
        layers,
    })
}

/// Returns the verified top-level OCI manifest digest from an archive.
///
/// # Errors
///
/// Rejects malformed archives, missing index/blob members, and blob mismatch.
pub(crate) fn oci_manifest_digest(content: &[u8]) -> Result<String, AcquisitionError> {
    let mut archive = Cursor::new(content);
    let index =
        tar_member(&mut archive, "index.json")?.ok_or(AcquisitionError::InvalidOciResult)?;
    let index: serde_json::Value =
        serde_json::from_slice(&index).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let index = index
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if index
        .keys()
        .any(|key| !matches!(key.as_str(), "schemaVersion" | "mediaType" | "manifests"))
        || index
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(2)
        || index.get("mediaType").is_some_and(|media_type| {
            media_type.as_str() != Some("application/vnd.oci.image.index.v1+json")
        })
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifests = index
        .get("manifests")
        .and_then(serde_json::Value::as_array)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let [descriptor] = manifests.as_slice() else {
        return Err(AcquisitionError::InvalidOciResult);
    };
    let descriptor = descriptor
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if descriptor.keys().any(|key| {
        !matches!(
            key.as_str(),
            "mediaType" | "digest" | "size" | "annotations" | "platform"
        )
    }) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let media_type = descriptor
        .get("mediaType")
        .and_then(serde_json::Value::as_str)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let digest = descriptor
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .ok_or(AcquisitionError::InvalidOciResult)?
        .to_string();
    let declared_size = descriptor
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if !matches!(media_type, OCI_IMAGE_MEDIA_TYPE | IMAGE_MANIFEST_MEDIA_TYPE) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    if let Some(annotations) = descriptor.get("annotations") {
        let annotations = annotations
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if annotations
            .iter()
            .any(|(key, value)| key.is_empty() || !value.is_string())
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    if let Some(platform) = descriptor.get("platform") {
        let platform = platform
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if platform.keys().any(|key| {
            !matches!(
                key.as_str(),
                "architecture" | "os" | "os.version" | "os.features" | "variant"
            )
        }) || !platform
            .get("architecture")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty())
            || !platform
                .get("os")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
            || platform
                .get("os.version")
                .is_some_and(|value| !value.as_str().is_some_and(|value| !value.is_empty()))
            || platform
                .get("variant")
                .is_some_and(|value| !value.as_str().is_some_and(|value| !value.is_empty()))
            || platform.get("os.features").is_some_and(|value| {
                !value.as_array().is_some_and(|features| {
                    features
                        .iter()
                        .all(|feature| feature.as_str().is_some_and(|feature| !feature.is_empty()))
                })
            })
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    validate_digest(&digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let manifest_bytes = oci_manifest_bytes(content, &digest)?;
    let manifest = parse_image_manifest(&manifest_bytes)?;
    if manifest_bytes.len() as u64 != declared_size
        || manifest.media_type.as_deref() != Some(media_type)
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let descriptors = validated_descriptor_sizes(&manifest, manifest_bytes.len() as u64)?;
    for (descriptor_digest, declared_size) in descriptors {
        let blob_name = format!("blobs/sha256/{}", digest_hex(&descriptor_digest)?);
        let mut archive = Cursor::new(content);
        let blob =
            tar_member(&mut archive, &blob_name)?.ok_or(AcquisitionError::InvalidOciResult)?;
        if blob.len() as u64 != declared_size
            || format!("sha256:{:x}", Sha256::digest(&blob)) != descriptor_digest
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    Ok(digest)
}

/// Returns and verifies the exact OCI manifest blob.
fn oci_manifest_bytes(content: &[u8], digest: &str) -> Result<Vec<u8>, AcquisitionError> {
    let blob_name = format!(
        "blobs/sha256/{}",
        digest
            .strip_prefix("sha256:")
            .ok_or(AcquisitionError::InvalidOciResult)?
    );
    let mut archive = Cursor::new(content);
    let manifest =
        tar_member(&mut archive, &blob_name)?.ok_or(AcquisitionError::InvalidOciResult)?;
    if format!("sha256:{:x}", Sha256::digest(&manifest)) != digest {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(manifest)
}

/// Archives one verified minimal layout in the fixed uncompressed OCI tar shape.
fn archive_registry_layout(
    staging_root: &Path,
    manifest_digest: &str,
    descriptor_sizes: &BTreeMap<String, u64>,
) -> Result<Vec<u8>, AcquisitionError> {
    let mut members = vec!["oci-layout".to_string(), "index.json".to_string()];
    members.push(format!("blobs/sha256/{}", digest_hex(manifest_digest)?));
    members.extend(
        descriptor_sizes
            .keys()
            .map(|digest| digest_hex(digest).map(|stem| format!("blobs/sha256/{stem}")))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let mut archive = Vec::new();
    for member in members {
        let contents = fs::read(staging_root.join(&member))?;
        append_tar_member(&mut archive, &member, &contents)?;
        if archive.len() as u64 > IMAGE_STORE_MAX_BYTES {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    archive.extend_from_slice(&[0_u8; 1024]);
    Ok(archive)
}

/// Appends one regular ustar member with deterministic metadata.
fn append_tar_member(
    archive: &mut Vec<u8>,
    name: &str,
    contents: &[u8],
) -> Result<(), AcquisitionError> {
    if !name.is_ascii() || name.len() > 100 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let required = 512_u64
        .checked_add(contents.len() as u64)
        .and_then(|size| size.checked_add((512 - contents.len() as u64 % 512) % 512))
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if (archive.len() as u64)
        .checked_add(required)
        .filter(|size| *size <= IMAGE_STORE_MAX_BYTES)
        .is_none()
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    write_tar_octal(&mut header[100..108], 0o600)?;
    write_tar_octal(&mut header[108..116], 0)?;
    write_tar_octal(&mut header[116..124], 0)?;
    write_tar_octal(&mut header[124..136], contents.len() as u64)?;
    write_tar_octal(&mut header[136..148], 0)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
    let checksum = format!("{checksum:06o}\0 ");
    if checksum.len() != 8 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    header[148..156].copy_from_slice(checksum.as_bytes());
    archive.extend_from_slice(&header);
    archive.extend_from_slice(contents);
    archive.resize(archive.len() + ((512 - contents.len() % 512) % 512), 0);
    Ok(())
}

/// Encodes one bounded ustar numeric field.
fn write_tar_octal(field: &mut [u8], value: u64) -> Result<(), AcquisitionError> {
    let encoded = format!("{value:0width$o}\0", width = field.len() - 1);
    if encoded.len() != field.len() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    field.copy_from_slice(encoded.as_bytes());
    Ok(())
}

/// Reads one regular-file member from an uncompressed POSIX tar archive.
fn tar_member<R: Read>(file: &mut R, wanted: &str) -> Result<Option<Vec<u8>>, AcquisitionError> {
    loop {
        let mut header = [0_u8; 512];
        match file.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        if header.iter().all(|byte| *byte == 0) {
            return Ok(None);
        }
        let name = tar_text(&header[0..100])?;
        let prefix = tar_text(&header[345..500])?;
        let name = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let size_text = tar_text(&header[124..136])?;
        let size = u64::from_str_radix(size_text.trim(), 8)
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        if size > BUILD_MAX_OUTPUT_BYTES {
            return Err(AcquisitionError::InvalidOciResult);
        }
        let mut contents = vec![0_u8; size as usize];
        file.read_exact(&mut contents)?;
        let padding = (512 - size % 512) % 512;
        if padding > 0 {
            let mut discard = vec![0_u8; padding as usize];
            file.read_exact(&mut discard)?;
        }
        if name == wanted {
            return Ok(Some(contents));
        }
    }
}

/// Parses a NUL-terminated UTF-8 tar header field.
fn tar_text(bytes: &[u8]) -> Result<String, AcquisitionError> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).map_err(|_| AcquisitionError::InvalidOciResult)
}

/// Extracts one JSON string field from trusted-size generated OCI JSON.
fn json_string(input: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(input)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use sha2::{Digest, Sha256};

    use super::{
        AcquisitionError, AcquisitionTrigger, BUILD_MAX_OUTPUT_BYTES, BUILD_MAX_TIME,
        BuildCapabilities, BuildDefinition, BuildPlan, ImageEffectEvidence, ImageEffectRequest,
        RegistryAcquisition, archive_registry_layout, oci_manifest_digest, stage_registry_layout,
    };

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);
    const EMPTY_CONTEXT_REF: &str = "build-context://empty/v1";
    const EMPTY_CONTEXT_DIGEST: &str =
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    /// Returns the canonical SHA-256 image address for fixture bytes.
    fn digest(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    /// Collects exact string constants used by one generated Rego equality field.
    fn exact_rego_values(policy: &str, field: &str) -> BTreeSet<String> {
        let prefix = format!("{field} == \"");
        policy
            .lines()
            .filter_map(|line| {
                let (_, value) = line.split_once(&prefix)?;
                let value = value.trim().strip_suffix('"')?;
                Some(value.to_string())
            })
            .collect()
    }

    /// Returns one process-unique temporary root without adding a fixture dependency.
    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "openkit-wp3b-{label}-{}-{}",
            std::process::id(),
            NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Returns every regular file in one generated OCI layout as a relative path.
    fn layout_files(root: &Path) -> BTreeSet<String> {
        fn visit(root: &Path, directory: &Path, files: &mut BTreeSet<String>) {
            for entry in fs::read_dir(directory).expect("read OCI layout directory") {
                let path = entry.expect("read OCI layout entry").path();
                if path.is_dir() {
                    visit(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root)
                            .expect("layout-relative path")
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }

        let mut files = BTreeSet::new();
        visit(root, root, &mut files);
        files
    }

    /// Reads one top-level JSON string field without constraining whitespace or ordering.
    fn json_string_field<'a>(document: &'a str, field: &str) -> Option<&'a str> {
        let marker = format!("\"{field}\"");
        let (_, tail) = document.split_once(&marker)?;
        let (_, tail) = tail.split_once(':')?;
        let tail = tail.trim_start().strip_prefix('"')?;
        tail.split_once('"').map(|(value, _)| value)
    }

    /// Builds raw image-manifest bytes whose formatting must survive staging unchanged.
    fn raw_image_manifest(
        media_type: &str,
        config_digest: &str,
        config_size: usize,
        layer_digest: &str,
        layer_size: usize,
    ) -> Vec<u8> {
        format!(
            "{{\n  \"schemaVersion\": 2,\n  \"mediaType\": \"{media_type}\",\n  \"config\": {{ \"mediaType\": \"application/vnd.oci.image.config.v1+json\", \"digest\": \"{config_digest}\", \"size\": {config_size} }},\n  \"layers\": [{{ \"mediaType\": \"application/vnd.oci.image.layer.v1.tar\", \"digest\": \"{layer_digest}\", \"size\": {layer_size} }}]\n}}"
        )
        .into_bytes()
    }

    #[test]
    fn wp3b_acquisition_accepts_only_two_triggers_and_declared_digest_registries() {
        assert_eq!(
            AcquisitionTrigger::parse("deployment-maintenance"),
            Ok(AcquisitionTrigger::DeploymentMaintenance)
        );
        assert_eq!(
            AcquisitionTrigger::parse("authorized-attempt"),
            Ok(AcquisitionTrigger::AuthorizedAttempt)
        );
        for rejected in ["sandbox", "worker", "gateway", "backend", "readiness", ""] {
            assert!(
                AcquisitionTrigger::parse(rejected).is_err(),
                "accepted {rejected}"
            );
        }

        let content = b"registry image archive";
        let exact_digest = digest(content);
        let declared = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        for reference in [
            format!("docker.io/library/alpine@{exact_digest}"),
            format!("ghcr.io/openkit/worker@{exact_digest}"),
        ] {
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &reference,
                &declared,
            )
            .expect("declared digest reference");
            assert_eq!(
                acquisition.verify_content(content),
                Ok(exact_digest.clone())
            );
            assert_eq!(
                acquisition.verify_content(b"mismatch"),
                Err(AcquisitionError::DigestMismatch)
            );
        }

        for rejected in [
            "docker.io/library/alpine:latest".to_string(),
            "ghcr.io/openkit/worker:v1".to_string(),
            format!("quay.io/openkit/worker@{exact_digest}"),
            format!("registry.internal/openkit/worker@{exact_digest}"),
        ] {
            assert!(
                RegistryAcquisition::validate(
                    AcquisitionTrigger::AuthorizedAttempt,
                    &rejected,
                    &declared,
                )
                .is_err(),
                "accepted undeclared or mutable reference {rejected}"
            );
        }
    }

    #[test]
    fn wp3b_registry_staging_preserves_manifest_and_fails_before_admission() {
        let declared = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        let placeholder_digest = digest(b"placeholder");
        for rejected in [
            "docker.io/library/alpine:latest".to_string(),
            format!("ghcr.io/openkit/worker?token=secret@{placeholder_digest}"),
            format!("ghcr.io/user:secret@openkit/worker@{placeholder_digest}"),
            format!("registry.internal/openkit/worker@{placeholder_digest}"),
        ] {
            assert!(
                RegistryAcquisition::validate(
                    AcquisitionTrigger::AuthorizedAttempt,
                    &rejected,
                    &declared,
                )
                .is_err(),
                "accepted tag, credentials, or private registry: {rejected}"
            );
        }

        let root = test_root("registry-staging");
        let backend_canary = root.join("epoch-backend/canary");
        let store_canary = root.join("image-store/canary");
        fs::create_dir_all(backend_canary.parent().expect("backend canary parent"))
            .expect("create backend canary parent");
        fs::create_dir_all(store_canary.parent().expect("store canary parent"))
            .expect("create store canary parent");
        fs::write(&backend_canary, b"not-called").expect("write backend canary");
        fs::write(&store_canary, b"not-admitted").expect("write store canary");

        let config = br#"{"architecture":"amd64","os":"linux"}"#;
        let layer = b"exact compressed layer bytes";
        let config_digest = digest(config);
        let layer_digest = digest(layer);
        for (index, (reference_name, media_type)) in [
            (
                "docker.io/library/alpine",
                "application/vnd.docker.distribution.manifest.v2+json",
            ),
            (
                "ghcr.io/openkit/worker",
                "application/vnd.oci.image.manifest.v1+json",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let raw_manifest = raw_image_manifest(
                media_type,
                &config_digest,
                config.len(),
                &layer_digest,
                layer.len(),
            );
            let manifest_digest = digest(&raw_manifest);
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &format!("{reference_name}@{manifest_digest}"),
                &declared,
            )
            .expect("anonymous exact-digest public-registry acquisition");
            let layout = root.join(format!("success-{index}"));
            stage_registry_layout(
                &acquisition,
                &raw_manifest,
                &[
                    (config_digest.as_str(), config.as_slice()),
                    (layer_digest.as_str(), layer.as_slice()),
                ],
                &layout,
            )
            .expect("verified image manifest stages as an OCI layout");

            let manifest_hex = manifest_digest
                .strip_prefix("sha256:")
                .expect("canonical manifest digest");
            assert_eq!(
                fs::read(layout.join(format!("blobs/sha256/{manifest_hex}")))
                    .expect("read staged manifest"),
                raw_manifest,
                "registry manifest bytes were reserialized"
            );
            assert_eq!(
                layout_files(&layout),
                BTreeSet::from([
                    "oci-layout".to_string(),
                    "index.json".to_string(),
                    format!("blobs/sha256/{manifest_hex}"),
                    format!(
                        "blobs/sha256/{}",
                        config_digest.strip_prefix("sha256:").unwrap()
                    ),
                    format!(
                        "blobs/sha256/{}",
                        layer_digest.strip_prefix("sha256:").unwrap()
                    ),
                ])
            );
            let index_document =
                fs::read_to_string(layout.join("index.json")).expect("read OCI index");
            assert_eq!(
                json_string_field(&index_document, "digest"),
                Some(manifest_digest.as_str())
            );
            assert_eq!(index_document.matches("\"digest\"").count(), 1);
            let descriptor_sizes = BTreeMap::from([
                (config_digest.clone(), config.len() as u64),
                (layer_digest.clone(), layer.len() as u64),
            ]);
            let archive = archive_registry_layout(&layout, &manifest_digest, &descriptor_sizes)
                .expect("archive generated OCI layout");
            assert_eq!(
                oci_manifest_digest(&archive),
                Ok(manifest_digest.clone()),
                "archive verifier did not select manifests[0].digest"
            );

            if index == 1 {
                let oci_index_media_type = "application/vnd.oci.image.index.v1+json";
                let standard_descriptor = format!(
                    "{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{},\"annotations\":{{\"org.opencontainers.image.created\":\"2026-08-09T02:55:29Z\"}},\"platform\":{{\"architecture\":\"arm64\",\"os\":\"linux\"}}}}",
                    raw_manifest.len()
                );
                let standard_index = format!(
                    "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}]}}"
                );
                fs::write(layout.join("index.json"), &standard_index)
                    .expect("replace stock Buildx OCI index fixture");
                let standard_archive =
                    archive_registry_layout(&layout, &manifest_digest, &descriptor_sizes)
                        .expect("archive stock Buildx OCI index fixture");
                assert_eq!(
                    oci_manifest_digest(&standard_archive),
                    Ok(manifest_digest.clone()),
                    "archive verifier rejected standard OCI index fields"
                );

                let descriptor = format!(
                    "{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{}}}",
                    raw_manifest.len()
                );
                let mismatch = digest(b"different top manifest");
                for invalid_index in [
                    format!(
                        "{{\"schemaVersion\":3,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"application/vnd.docker.distribution.manifest.list.v2+json\",\"manifests\":[{standard_descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}],\"unknown\":true}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{descriptor},{descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"digest\":\"{manifest_digest}\",\"size\":{}}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{},\"unknown\":true}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{mismatch}\",\"size\":{}}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{}}}]}}",
                        raw_manifest.len() + 1
                    ),
                ] {
                    fs::write(layout.join("index.json"), invalid_index)
                        .expect("replace invalid OCI index fixture");
                    let invalid_archive =
                        archive_registry_layout(&layout, &manifest_digest, &descriptor_sizes)
                            .expect("archive invalid-index fixture");
                    assert_eq!(
                        oci_manifest_digest(&invalid_archive),
                        Err(AcquisitionError::InvalidOciResult)
                    );
                }

                fs::write(layout.join("index.json"), standard_index)
                    .expect("restore standard OCI index fixture");
                fs::write(
                    layout.join(format!("blobs/sha256/{manifest_hex}")),
                    b"mismatched manifest blob",
                )
                .expect("replace mismatched manifest blob fixture");
                let mismatched_blob_archive =
                    archive_registry_layout(&layout, &manifest_digest, &descriptor_sizes)
                        .expect("archive mismatched manifest blob fixture");
                assert_eq!(
                    oci_manifest_digest(&mismatched_blob_archive),
                    Err(AcquisitionError::InvalidOciResult)
                );
            }
            assert_eq!(fs::read(&backend_canary).unwrap(), b"not-called");
            assert_eq!(fs::read(&store_canary).unwrap(), b"not-admitted");
        }

        let valid_manifest = raw_image_manifest(
            "application/vnd.oci.image.manifest.v1+json",
            &config_digest,
            config.len(),
            &layer_digest,
            layer.len(),
        );
        let mut failure_index = 0_u8;
        let mut assert_rejected = |raw_manifest: Vec<u8>, blobs: Vec<(String, Vec<u8>)>| {
            let manifest_digest = digest(&raw_manifest);
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &format!("ghcr.io/openkit/worker@{manifest_digest}"),
                &declared,
            )
            .expect("exact digest failure fixture");
            let layout = root.join(format!("failure-{failure_index}"));
            failure_index += 1;
            let blob_refs = blobs
                .iter()
                .map(|(blob_digest, bytes)| (blob_digest.as_str(), bytes.as_slice()))
                .collect::<Vec<_>>();
            assert!(
                stage_registry_layout(&acquisition, &raw_manifest, &blob_refs, &layout).is_err()
            );
            assert!(!layout.exists(), "failed staging left partial OCI data");
            assert_eq!(fs::read(&backend_canary).unwrap(), b"not-called");
            assert_eq!(fs::read(&store_canary).unwrap(), b"not-admitted");
        };

        for index_media_type in [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
        ] {
            assert_rejected(
                format!(
                    "{{\"schemaVersion\":2,\"mediaType\":\"{index_media_type}\",\"manifests\":[]}}"
                )
                .into_bytes(),
                vec![],
            );
        }
        assert_rejected(
            valid_manifest.clone(),
            vec![(layer_digest.clone(), layer.to_vec())],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![
                (config_digest.clone(), b"wrong config".to_vec()),
                (layer_digest.clone(), layer.to_vec()),
            ],
        );
        assert_rejected(
            raw_image_manifest(
                "application/vnd.oci.image.manifest.v1+json",
                &config_digest,
                config.len() + 1,
                &layer_digest,
                layer.len(),
            ),
            vec![
                (config_digest.clone(), config.to_vec()),
                (layer_digest.clone(), layer.to_vec()),
            ],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![(config_digest.clone(), config.to_vec())],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![
                (config_digest.clone(), config.to_vec()),
                (layer_digest.clone(), b"wrong layer".to_vec()),
            ],
        );
        assert_rejected(
            raw_image_manifest(
                "application/vnd.oci.image.manifest.v1+json",
                &config_digest,
                config.len(),
                &layer_digest,
                layer.len() + 1,
            ),
            vec![
                (config_digest, config.to_vec()),
                (layer_digest, layer.to_vec()),
            ],
        );

        fs::remove_dir_all(root).expect("remove registry staging fixture");
    }

    #[test]
    fn wp3b_build_is_fixed_bounded_contained_backend_input() {
        assert_eq!(BUILD_MAX_TIME, Duration::from_secs(30 * 60));
        assert_eq!(BUILD_MAX_OUTPUT_BYTES, 20 * 1024 * 1024 * 1024);
        let definition = BuildDefinition {
            context_ref: EMPTY_CONTEXT_REF.into(),
            context_digest: EMPTY_CONTEXT_DIGEST.into(),
            dockerfile: "FROM scratch\nCOPY app /app\n".into(),
            arguments: vec![("TARGET".into(), "release".into())],
            egress_grants: BTreeSet::from([
                "registry.npmjs.org".to_string(),
                "https://example.com/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ]),
            time_limit: Duration::from_secs(600),
            output_limit_bytes: 1024,
            layer_limit: 4,
        };
        let registries = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        let socket = Path::new("/run/openkit/nanohost/epoch/docker.sock");
        let build_root = Path::new("/run/openkit/nanohost/acquisitions/build-1");
        let plan = BuildPlan::validate(definition.clone(), &registries, socket, build_root)
            .expect("bounded build plan");

        assert_eq!(plan.program(), Path::new("/usr/bin/docker"));
        assert_eq!(
            plan.env(),
            &[(
                "DOCKER_HOST".to_string(),
                format!("unix://{}", socket.display()),
            )]
        );
        let source = include_str!("image_acquisition.rs");
        let probe_source = source
            .split_once("pub fn probe(docker_socket: &Path)")
            .expect("BuildCapabilities probe source")
            .1
            .split_once("/// Direct, fixed Buildx execution plan")
            .expect("end of BuildCapabilities implementation")
            .0;
        assert_eq!(probe_source.matches(".env(\"DOCKER_HOST\"").count(), 2);
        assert_eq!(
            probe_source
                .matches(".env_remove(\"BUILDX_BUILDER\")")
                .count(),
            2,
            "both Buildx capability commands must remove inherited builder selection"
        );
        let execute_source = source
            .split_once("pub fn execute(&self)")
            .expect("BuildPlan execute source")
            .1
            .split_once("pub fn execute_and_admit(")
            .expect("end of BuildPlan execute")
            .0;
        assert!(execute_source.contains(".envs(self.env.iter().cloned())"));
        assert!(
            execute_source.contains(".env_remove(\"BUILDX_BUILDER\")"),
            "the Buildx build command must remove inherited builder selection"
        );
        let current_dir = execute_source
            .find(".current_dir(&self.build_root)")
            .expect("Buildx policy cwd");
        let spawn = execute_source
            .find(".spawn()")
            .expect("direct Buildx spawn");
        assert!(current_dir < spawn);
        let root_create = execute_source
            .find("create_private_dir(&self.build_root)")
            .expect("exclusive private build root creation");
        let context_create = execute_source
            .find("create_private_dir(&context_root)")
            .expect("exclusive zero-entry context creation");
        let zero_entry_check = execute_source
            .find("fs::read_dir(&context_root)")
            .expect("empty context proof before Solve");
        let capability_probe = execute_source
            .find("BuildCapabilities::probe")
            .expect("pre-Solve capability probe");
        assert!(root_create < context_create);
        assert!(context_create < zero_entry_check);
        assert!(zero_entry_check < capability_probe);
        assert!(capability_probe < spawn);
        assert!(plan.args().windows(2).any(|args| {
            args[0] == "--file" && args[1] == build_root.join("Dockerfile").display().to_string()
        }));
        let context_arg = build_root.join("context").display().to_string();
        assert_eq!(plan.args().last(), Some(&context_arg));
        assert!(execute_source.contains("&self.build_root.join(\"policy.rego\")"));
        assert!(!execute_source.contains("context_root.join(\"policy.rego\")"));
        assert!(execute_source.contains("fs::remove_dir_all(&self.build_root)"));
        assert!(!plan.uses_shell());
        assert!(!plan.uses_host_network());
        assert!(!plan.uses_host_mount());
        assert!(!plan.publishes());
        assert_eq!(
            plan.allowed_egress(),
            &BTreeSet::from([
                "docker.io".to_string(),
                "ghcr.io".to_string(),
                "registry.npmjs.org".to_string(),
                "https://example.com/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ])
        );
        assert!(plan.sandbox_egress_projection().is_empty());
        assert_eq!(plan.lineage(), definition.lineage());
        assert_ne!(
            plan.lineage(),
            BuildDefinition {
                context_ref: "build-context://empty/v2".into(),
                ..definition.clone()
            }
            .lineage()
        );
        let canonicalized_definition = BuildDefinition {
            egress_grants: BTreeSet::from([
                "registry.npmjs.org:443".to_string(),
                "https://example.com:443/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ]),
            ..definition.clone()
        };
        assert_ne!(plan.lineage(), canonicalized_definition.lineage());
        assert_eq!(
            plan.args()
                .iter()
                .take(2)
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["buildx", "build"]
        );
        let policy_value = plan
            .args()
            .windows(2)
            .find_map(|args| (args[0] == "--policy").then_some(args[1].as_str()))
            .expect("strict generated Buildx policy");
        assert_eq!(
            policy_value,
            "filename=cwd://policy.rego,reset=true,strict=true"
        );
        assert!(!policy_value.contains(&build_root.display().to_string()));
        assert!(
            !plan
                .args()
                .iter()
                .any(|arg| arg.ends_with("/context/policy.rego"))
        );
        assert!(plan.args().windows(2).any(|args| {
            args[0] == "--output"
                && args[1]
                    == format!(
                        "type=oci,dest={}",
                        build_root.join("result.oci.tar").display()
                    )
        }));
        let argv = plan.args().join(" ");
        for forbidden in [
            "--network host",
            "--mount type=bind",
            "--allow",
            "--builder",
            "--load",
            "--push",
            "--tag",
            " -t ",
            "--secret",
            "--ssh",
            "nanohost-token",
            "gateway-auth",
            "docker.sock:/",
        ] {
            assert!(!argv.contains(forbidden), "build plan contains {forbidden}");
        }
        assert!(!argv.contains(&definition.dockerfile));

        let policy = plan.policy_contents();
        assert!(policy.contains("default allow := false"));
        assert!(policy.contains("input.env.capsRequest"));
        assert!(policy.contains("\"exec.proxy\": true"));
        assert_eq!(policy.matches("\"exec.proxy\": true").count(), 1);
        assert_eq!(
            exact_rego_values(policy, "input.http.host"),
            BTreeSet::from(["registry.npmjs.org:443".to_string()])
        );
        assert!(policy.contains("docker.io:443"));
        assert!(policy.contains("ghcr.io:443"));
        assert_eq!(
            exact_rego_values(policy, "input.http.url"),
            BTreeSet::from([
                "https://example.com:443/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ])
        );
        for forbidden in [
            "endswith(",
            "contains(",
            "glob.match",
            "regex.match",
            "http://",
        ] {
            assert!(
                !policy.contains(forbidden),
                "policy contains widening {forbidden}"
            );
        }
    }

    #[test]
    fn wp3b_build_rejects_missing_egress_secrets_and_excess_bounds() {
        let registries = BTreeSet::from(["docker.io".to_string()]);
        let base_digest = digest(b"accepted base image");
        let valid = BuildDefinition {
            context_ref: EMPTY_CONTEXT_REF.into(),
            context_digest: EMPTY_CONTEXT_DIGEST.into(),
            dockerfile: "FROM scratch".into(),
            arguments: vec![],
            egress_grants: BTreeSet::from(["registry.npmjs.org".to_string()]),
            time_limit: BUILD_MAX_TIME,
            output_limit_bytes: BUILD_MAX_OUTPUT_BYTES,
            layer_limit: 128,
        };
        let socket = Path::new("/run/openkit/nanohost/epoch/docker.sock");
        let build_root = test_root("build-invalid");
        for invalid in [
            BuildDefinition {
                context_ref: "workspace://build-context".into(),
                ..valid.clone()
            },
            BuildDefinition {
                context_digest: digest(b"not empty"),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::new(),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["*".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["*.example.com".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from([".example.com".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["example.com\nallow := true".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["example.com\"\nallow := true".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["https://example.com/*".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                arguments: vec![("ACCESS_TOKEN".into(), "secret".into())],
                ..valid.clone()
            },
            BuildDefinition {
                time_limit: BUILD_MAX_TIME + Duration::from_secs(1),
                ..valid.clone()
            },
            BuildDefinition {
                output_limit_bytes: BUILD_MAX_OUTPUT_BYTES + 1,
                ..valid.clone()
            },
            BuildDefinition {
                layer_limit: 0,
                ..valid.clone()
            },
            BuildDefinition {
                layer_limit: 129,
                ..valid.clone()
            },
            BuildDefinition {
                dockerfile: "RUN --mount=type=bind,source=/etc,target=/host true".into(),
                ..valid.clone()
            },
            BuildDefinition {
                dockerfile: format!("FROM undeclared.example/worker@{base_digest}"),
                ..valid.clone()
            },
        ] {
            assert!(BuildPlan::validate(invalid, &registries, socket, &build_root).is_err());
            assert!(
                !build_root.exists(),
                "invalid pair created a private build root"
            );
        }

        for (registry, reference) in [
            ("docker.io", "docker.io/library/alpine"),
            ("ghcr.io", "ghcr.io/openkit/worker"),
        ] {
            assert!(
                BuildPlan::validate(
                    BuildDefinition {
                        dockerfile: format!("FROM {reference}@{base_digest}"),
                        ..valid.clone()
                    },
                    &BTreeSet::from([registry.to_string()]),
                    socket,
                    &build_root,
                )
                .is_ok(),
                "rejected declared exact-digest FROM {reference}"
            );
        }
    }

    #[test]
    fn wp3b_build_preflight_accepts_standard_inspect_without_exporter_advertisement() {
        let supported = BuildCapabilities {
            buildkit_version: "0.31.0".into(),
            buildx_version: "0.35.0".into(),
            exec_proxy: true,
        };
        assert_eq!(supported.preflight(), Ok(()));

        for unsupported in [
            BuildCapabilities {
                buildkit_version: "0.30.9".into(),
                ..supported.clone()
            },
            BuildCapabilities {
                buildx_version: "0.34.9".into(),
                ..supported.clone()
            },
            BuildCapabilities {
                exec_proxy: false,
                ..supported.clone()
            },
        ] {
            assert_eq!(
                unsupported.preflight(),
                Err(AcquisitionError::UnsupportedBuildCapability)
            );
        }

        let production = include_str!("image_acquisition.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("image acquisition production section");
        let capability_source = production
            .split_once("pub struct BuildCapabilities")
            .expect("Buildx capability owner")
            .1
            .split_once("/// Direct, fixed Buildx execution plan")
            .expect("end of Buildx capability owner")
            .0;
        assert!(!capability_source.contains("OCI exporter"));
        assert!(!capability_source.contains("oci_exporter"));
        assert_eq!(
            capability_source
                .matches("Command::new(\"/usr/bin/docker\")")
                .count(),
            2,
            "capability proof must remain only Buildx version plus inspect"
        );
        assert!(!capability_source.contains("--dry-run"));
        assert_eq!(capability_source.matches("\"DOCKER_HOST\"").count(), 2);
        assert_eq!(capability_source.matches("\"BUILDX_BUILDER\"").count(), 2);

        let plan_source = production
            .split_once("impl BuildPlan")
            .expect("BuildPlan owner")
            .1
            .split_once("/// Verified OCI-only build output")
            .expect("end of BuildPlan owner")
            .0;
        assert_eq!(plan_source.matches("\"--output\"").count(), 1);
        assert_eq!(plan_source.matches("type=oci,dest=").count(), 1);
    }

    #[test]
    fn wp5_r8_validates_exact_dockerfile_bytes_before_build_plan() {
        let production = include_str!("image_acquisition.rs")
            .split_once("#[cfg(test)]")
            .expect("image acquisition production section")
            .0;
        assert!(
            production.contains("DOCKERFILE_INPUT_MAX_BYTES: usize = 256 * 1024 * 1024"),
            "the independent inline Dockerfile ceiling must have one exact owner"
        );
        let validation = production
            .split_once("fn validate_build_definition(")
            .expect("build-definition validation owner")
            .1
            .split_once("/// Renders the closed strict Buildx policy")
            .expect("end of build-definition validation")
            .0;
        let byte_check = validation
            .find("definition.dockerfile.as_bytes().len()")
            .expect("UTF-8 Dockerfile byte-length check");
        let empty_context = validation
            .find("definition.context_ref != EMPTY_BUILD_CONTEXT_REF")
            .expect("independent empty-context check");
        assert!(empty_context < byte_check);
        assert!(validation[byte_check..].contains("DOCKERFILE_INPUT_MAX_BYTES"));
        assert!(!validation.contains("dockerfile.len()"));
    }

    #[test]
    fn wp5_image_effect_accepts_only_exact_reference_or_build_lineage_and_digest_evidence() {
        let reference = ImageEffectRequest::reference(
            "request-reference",
            "ghcr.io/openkit/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert!(reference.validate().is_ok());
        assert!(
            ImageEffectRequest::reference("request-tag", "ghcr.io/openkit/worker:latest")
                .validate()
                .is_err()
        );
        let build = ImageEffectRequest::build(
            "request-build",
            EMPTY_CONTEXT_DIGEST,
            "sha256:dockerfile",
            "sha256:arguments",
        );
        assert!(build.validate().is_ok());
        assert!(
            ImageEffectRequest::build(
                "request-incomplete",
                "",
                "sha256:dockerfile",
                "sha256:arguments",
            )
            .validate()
            .is_err()
        );
        assert_eq!(
            ImageEffectEvidence::new("request-build", "sha256:result").request_id(),
            "request-build"
        );
        assert!(
            ImageEffectEvidence::new("request-build", "worker:latest")
                .validate()
                .is_err()
        );
        let coordinator = include_str!("epoch_coordinator.rs")
            .split_once("#[cfg(test)]")
            .expect("coordinator production section")
            .0;
        for owner in [
            "RegistryAcquisition::validate",
            "BuildPlan::validate",
            "execute_and_admit",
        ] {
            assert!(
                coordinator.contains(owner),
                "missing image effect owner {owner}"
            );
        }
    }
}
