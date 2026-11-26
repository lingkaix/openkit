//! Identical lifecycle cases for the deterministic model and the pinned stock Gateway.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{MetadataExt, chown};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use openshell_sdk::{SandboxPhase, SandboxRef, SandboxSpec};
use tokio::sync::{Mutex, Notify, mpsc};
use tokio::time::{Instant, sleep, timeout};

use super::*;
use crate::epoch_coordinator::DockerImageBackend;
use crate::openshell_client::NanoHostOpenShellClient;
use crate::openshell_policy::render_sandbox_policy;
use crate::persistent_volume::{PERSISTENT_VOLUME_ROOT, StorageMount};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Seen {
    name: String,
    id: String,
    ready: bool,
}

type Order<P> = KeepPresent<
    <P as EnvironmentProvider>::Template,
    <P as EnvironmentProvider>::Envelope,
    <P as EnvironmentProvider>::Attachment,
    <P as EnvironmentProvider>::CarrierOrder,
>;

/// Test controls sit outside the provider contract. A fake advances its accepted
/// operations explicitly. Stock independently advances Docker while the caller waits.
trait Fixture {
    type Provider: EnvironmentProvider;
    fn provider(&self) -> &Self::Provider;
    fn provision(&self, name: &str) -> Order<Self::Provider>;
    fn view(sandbox: &<Self::Provider as EnvironmentProvider>::Sandbox) -> Seen;
    async fn accepted(&self, name: &str) -> Seen;
    fn advance_receiver(&self);
    fn has_writer(&self, name: &str) -> bool;
    async fn verify_stays_absent(&self, name: &str);
}

#[derive(Default)]
struct FakeProvider {
    entries: RefCell<BTreeMap<String, Seen>>,
    progressed: Notify,
}

impl EnvironmentProvider for FakeProvider {
    type Template = String;
    type Envelope = ();
    type Attachment = ();
    type CarrierOrder = ();
    type Sandbox = Seen;
    type Bridge = ();
    type Monitor = ();

    async fn keep_present(
        &self,
        operation_id: &str,
        order: Order<Self>,
    ) -> Result<Present<Seen, (), ()>, LifecycleEffectError> {
        match order {
            KeepPresent::Carry(()) => Ok(Present::Carried {
                bridge: (),
                monitor: (),
            }),
            KeepPresent::Provision { template: name, .. } => {
                {
                    let mut entries = self.entries.borrow_mut();
                    let original = entries.entry(name.clone()).or_insert_with(|| Seen {
                        name: name.clone(),
                        id: operation_id.to_owned(),
                        ready: false,
                    });
                    if original.id != operation_id {
                        return Err(EpochFault::IdentityMismatch.into());
                    }
                }
                loop {
                    let changed = self.progressed.notified();
                    match self.entries.borrow().get(&name) {
                        Some(sandbox) if sandbox.ready => {
                            return Ok(Present::Provisioned(sandbox.clone()));
                        }
                        Some(_) => {}
                        None => return Err(EpochFault::MemberExited(None).into()),
                    }
                    changed.await;
                }
            }
        }
    }

    async fn keep_absent(&self, order: KeepAbsent<'_, ()>) -> Result<Absent, EpochFault> {
        match order {
            KeepAbsent::Carrier(()) => Ok(Absent::CarrierClosed),
            KeepAbsent::Sandbox {
                name,
                expected_native_id,
                ..
            } => {
                let mut entries = self.entries.borrow_mut();
                if entries
                    .get(name)
                    .is_some_and(|entry| entry.id != expected_native_id)
                {
                    return Err(EpochFault::IdentityMismatch);
                }
                entries.remove(name);
                self.progressed.notify_waiters();
                Ok(Absent::AwaitingPhysicalProof)
            }
        }
    }

    async fn report_inventory(&self) -> Result<ProviderInventory<Seen>, EpochFault> {
        Ok(ProviderInventory {
            observed: self.entries.borrow().values().cloned().collect(),
            absence: AbsenceProof::EpochRenewalOnly,
        })
    }
}

impl Fixture for FakeProvider {
    type Provider = Self;

    fn provider(&self) -> &Self {
        self
    }

    fn provision(&self, name: &str) -> Order<Self> {
        KeepPresent::Provision {
            template: name.to_owned(),
            envelope: (),
            attachment: (),
        }
    }

    fn view(sandbox: &Seen) -> Seen {
        sandbox.clone()
    }

    async fn accepted(&self, name: &str) -> Seen {
        see(self, name, false).await
    }

    fn advance_receiver(&self) {
        for sandbox in self.entries.borrow_mut().values_mut() {
            sandbox.ready = true;
        }
        self.progressed.notify_waiters();
    }

    fn has_writer(&self, name: &str) -> bool {
        self.entries
            .borrow()
            .get(name)
            .is_some_and(|entry| entry.ready)
    }

    async fn verify_stays_absent(&self, name: &str) {
        self.advance_receiver();
        assert!(inventory(self).await.iter().all(|item| item.name != name));
        assert!(!self.has_writer(name));
    }
}

const PRESENT: &str = "a2h-present";
const DEADLINE: &str = "a2h-deadline";
const DELETE_RACE: &str = "a2h-delete-race";
const LOST_CREATE: &str = "a2h-lost-create";

async fn inventory<F: Fixture>(fixture: &F) -> Vec<Seen> {
    let inventory = fixture.provider().report_inventory().await.unwrap();
    assert_eq!(inventory.absence, AbsenceProof::EpochRenewalOnly);
    inventory.observed.iter().map(F::view).collect()
}

async fn see<F: Fixture>(fixture: &F, name: &str, ready: bool) -> Seen {
    timeout(Duration::from_secs(120), async {
        loop {
            if let Some(item) = inventory(fixture)
                .await
                .into_iter()
                .find(|item| item.name == name && item.ready == ready)
            {
                return item;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("inventory did not expose the requested checkpoint")
}

async fn absent<F: Fixture>(fixture: &F, sandbox: &Seen) -> Absent {
    fixture
        .provider()
        .keep_absent(KeepAbsent::Sandbox {
            name: &sandbox.name,
            expected_native_id: &sandbox.id,
            timeout: Duration::from_secs(120),
        })
        .await
        .unwrap()
}

async fn finish_create<F: Fixture>(fixture: &F, name: &str) -> Seen {
    let advance = async {
        let accepted = fixture.accepted(name).await;
        fixture.advance_receiver();
        accepted
    };
    let (result, accepted) = tokio::join!(
        fixture
            .provider()
            .keep_present(name, fixture.provision(name)),
        advance,
    );
    let Present::Provisioned(sandbox) = result.unwrap() else {
        panic!("provision must return physical readiness");
    };
    let ready = F::view(&sandbox);
    assert!(ready.ready);
    assert_eq!(accepted.name, ready.name);
    assert_eq!(accepted.id, ready.id);
    assert!(fixture.has_writer(name));
    ready
}

/// The waiter's cut is after observing acceptance. Dropping this future does
/// not close the receiver's physical producer or submit a second request.
async fn stop_waiting_after_acceptance<F: Fixture>(
    fixture: &F,
    name: &str,
    wait: Duration,
) -> Seen {
    let pending = fixture
        .provider()
        .keep_present(name, fixture.provision(name));
    tokio::pin!(pending);
    tokio::select! {
        observation = async {
            let accepted = fixture.accepted(name).await;
            sleep(wait).await;
            accepted
        } => observation,
        _ = &mut pending => panic!("missed the accepted-but-not-ready boundary"),
    }
}

/// The test caller controls whether a completed reply is delivered. This is
/// deliberately independent from cancellation of the admitted operation.
async fn withhold<T>(response: impl Future<Output = T>) -> Option<T> {
    drop(response.await);
    None
}

async fn fresh_inventory<F: Fixture>(fixture: &F) {
    assert!(inventory(fixture).await.is_empty());
    println!("fresh epoch: complete empty inventory; predecessor-end evidence still required");
}

async fn contract_cases<F: Fixture>(fixture: &F) -> Seen {
    fresh_inventory(fixture).await;

    let present = finish_create(fixture, PRESENT).await;
    assert_eq!(
        inventory(fixture).await.as_slice(),
        std::slice::from_ref(&present)
    );
    assert_eq!(
        absent(fixture, &present).await,
        Absent::AwaitingPhysicalProof
    );
    assert!(inventory(fixture).await.is_empty());
    assert!(!fixture.has_writer(PRESENT));
    println!("present/absent: correlated ready, attachment observed, original writer gone");

    let accepted =
        stop_waiting_after_acceptance(fixture, DEADLINE, Duration::from_millis(35)).await;
    fixture.advance_receiver();
    let late = see(fixture, DEADLINE, true).await;
    assert_eq!(late.id, accepted.id);
    assert!(fixture.has_writer(DEADLINE));
    assert_eq!(absent(fixture, &late).await, Absent::AwaitingPhysicalProof);
    assert!(!fixture.has_writer(DEADLINE));
    println!("caller deadline: same accepted operation became ready without resubmission");

    let accepted = stop_waiting_after_acceptance(fixture, DELETE_RACE, Duration::ZERO).await;
    assert_eq!(
        absent(fixture, &accepted).await,
        Absent::AwaitingPhysicalProof
    );
    fixture.verify_stays_absent(DELETE_RACE).await;
    println!("in-flight delete: awaiting physical proof, no late original writer");

    assert!(
        withhold(finish_create(fixture, LOST_CREATE))
            .await
            .is_none()
    );
    let recovered = see(fixture, LOST_CREATE, true).await;
    assert_eq!(recovered.name, LOST_CREATE);
    assert!(withhold(absent(fixture, &recovered)).await.is_none());
    assert!(inventory(fixture).await.is_empty());
    assert!(!fixture.has_writer(LOST_CREATE));
    println!(
        "create/delete reply loss: observe by original name; empty inventory alone gives no release"
    );
    accepted
}

#[tokio::test]
async fn deterministic_environment_provider_contract() {
    contract_cases(&FakeProvider::default()).await;
    fresh_inventory(&FakeProvider::default()).await;
}

struct StockFixture {
    provider: NanoHostOpenShellClient,
    docker_socket: PathBuf,
    accepted: Mutex<mpsc::UnboundedReceiver<(String, String)>>,
}

impl StockFixture {
    async fn connect(lab: &Path) -> Self {
        assert_ne!(
            fs::metadata("/proc/self/ns/mnt").unwrap().ino(),
            fs::metadata("/proc/1/ns/mnt").unwrap().ino()
        );
        assert_ne!(
            fs::metadata("/proc/self/ns/net").unwrap().ino(),
            fs::metadata("/proc/1/ns/net").unwrap().ino()
        );
        assert!(lab.join("observer-clear").is_file());
        let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
        assert!(mounts.lines().all(|line| {
            let (fields, _) = line.split_once(" - ").unwrap();
            !fields
                .split_ascii_whitespace()
                .skip(6)
                .any(|item| item.starts_with("shared:") || item.starts_with("master:"))
        }));
        let expected = fs::metadata(lab.join("fixture-volumes")).unwrap();
        let actual = fs::metadata(PERSISTENT_VOLUME_ROOT).unwrap();
        assert_eq!(
            (actual.dev(), actual.ino()),
            (expected.dev(), expected.ino()),
            "stock fixture must see a private bind of its own Volume root"
        );
        let endpoint = fs::read_to_string(lab.join("endpoint")).unwrap();
        let run_dir = endpoint.lines().nth(2).unwrap();
        let mut provider =
            NanoHostOpenShellClient::new("https://127.0.0.1:17670".to_owned(), lab.join("auth"));
        let accepted = Mutex::new(provider.fixture_track_accepted_create());
        let namespace = OwnedFd::from(File::open("/proc/self/ns/net").unwrap());
        provider
            .bind_network_namespace(Arc::new(namespace))
            .unwrap();
        timeout(Duration::from_secs(15), async {
            while provider.connect().await.is_err() {
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("stock Gateway mTLS startup");

        Self {
            provider,
            docker_socket: Path::new(run_dir).join("docker.sock"),
            accepted,
        }
    }

    fn docker(&self, args: &[&str]) -> String {
        let output = std::process::Command::new("docker")
            .arg("--host")
            .arg(format!("unix://{}", self.docker_socket.display()))
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap()
    }

    /// A separate owner observation for the physical container, independent of Gateway List.
    fn container_id(&self, name: &str) -> String {
        self.docker(&[
            "ps",
            "-aq",
            "--filter",
            &format!("label=openshell.ai/sandbox-name={name}"),
            "--filter",
            "label=openshell.ai/isolation-role=sandbox",
        ])
    }

    async fn require_empty_runtime(&self) {
        timeout(Duration::from_secs(30), async {
            while !self.docker(&["ps", "-aq"]).trim().is_empty() {
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("private stock runtime still has containers after Gateway absence");
    }
}

impl Fixture for StockFixture {
    type Provider = NanoHostOpenShellClient;

    fn provider(&self) -> &Self::Provider {
        &self.provider
    }

    fn provision(&self, name: &str) -> Order<Self::Provider> {
        let source = Path::new(PERSISTENT_VOLUME_ROOT).join(name);
        fs::create_dir(&source).unwrap();
        chown(&source, Some(1000), Some(1000)).unwrap();
        KeepPresent::Provision {
            template: SandboxSpec {
                name: Some(name.to_owned()),
                image: Some("openkit-spike-s2-s1/worker:0fb6a42b9".to_owned()),
                labels: Default::default(),
                environment: Default::default(),
                providers: Vec::new(),
                gpu: false,
                ..Default::default()
            },
            envelope: render_sandbox_policy(&serde_json::json!({
                "additionalFilesystemGrants": [],
                "additionalNetworkEndpoints": [],
            }))
            .unwrap(),
            attachment: vec![StorageMount {
                source,
                target: "/workspace".to_owned(),
                credential: None,
            }],
        }
    }

    fn view(sandbox: &SandboxRef) -> Seen {
        Seen {
            name: sandbox.name.clone(),
            id: sandbox.id.clone(),
            ready: sandbox.phase == SandboxPhase::Ready,
        }
    }

    async fn accepted(&self, name: &str) -> Seen {
        let (observed_name, id) = timeout(Duration::from_secs(120), async {
            self.accepted.lock().await.recv().await
        })
        .await
        .expect("stock Create did not acknowledge acceptance")
        .expect("stock Create acknowledgement sender");
        assert_eq!(observed_name, name);
        Seen {
            name: observed_name,
            id,
            ready: false,
        }
    }

    fn advance_receiver(&self) {}

    fn has_writer(&self, name: &str) -> bool {
        let container = self.container_id(name);
        if container.trim().is_empty() {
            return false;
        }
        let mounts = self.docker(&["inspect", "--format", "{{json .Mounts}}", container.trim()]);
        let mounts: serde_json::Value = serde_json::from_str(&mounts).unwrap();
        let supervisor = self.docker(&[
            "ps",
            "-q",
            "--filter",
            &format!("label=openshell.ai/sandbox-name={name}"),
            "--filter",
            "label=openshell.ai/isolation-role=supervisor",
        ]);
        let pid = self.docker(&["inspect", "--format", "{{.State.Pid}}", supervisor.trim()]);
        let supervisor_ns = fs::metadata(format!("/proc/{}/ns/net", pid.trim())).unwrap();
        assert_eq!(
            supervisor_ns.ino(),
            fs::metadata("/proc/self/ns/net").unwrap().ino(),
            "stock Supervisor must use the private Gateway network namespace"
        );
        let path = Path::new(PERSISTENT_VOLUME_ROOT).join(name);
        mounts.as_array().unwrap().iter().any(|item| {
            item["Source"].as_str() == path.to_str()
                && item["Destination"] == "/workspace"
                && item["RW"] == true
        })
    }

    async fn verify_stays_absent(&self, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            assert!(inventory(self).await.iter().all(|item| item.name != name));
            assert!(self.container_id(name).trim().is_empty());
            sleep(Duration::from_secs(1)).await;
        }
    }
}

fn stock_lab_path() -> PathBuf {
    PathBuf::from(std::env::var_os("A2H_PROVIDER_CONTRACT_LAB").expect("guarded lab directory"))
}

#[tokio::test]
#[ignore = "requires the guarded dev-only stock Gateway lab"]
async fn stock_environment_provider_contract() {
    let fixture = Arc::new(StockFixture::connect(&stock_lab_path()).await);
    let subject = Arc::clone(&fixture);
    let result = tokio::spawn(async move { contract_cases(subject.as_ref()).await }).await;
    // Always clean exact fixture identities before the lab owner tears down.
    for sandbox in inventory(fixture.as_ref()).await {
        assert!([PRESENT, DEADLINE, DELETE_RACE, LOST_CREATE].contains(&sandbox.name.as_str()));
        assert_eq!(
            absent(fixture.as_ref(), &sandbox).await,
            Absent::AwaitingPhysicalProof
        );
    }
    for name in [PRESENT, DEADLINE, DELETE_RACE, LOST_CREATE] {
        assert!(fixture.container_id(name).trim().is_empty());
    }
    assert!(inventory(fixture.as_ref()).await.is_empty());
    let canceled = result.unwrap();
    let residual = fixture.docker(&[
        "ps", "-a", "--format",
        r#"{{.State}} {{.Label "openshell.ai/isolation-role"}} {{.Label "openshell.ai/sandbox-id"}} {{.Label "openshell.ai/sandbox-name"}}"#,
    ]);
    let proof = DockerImageBackend::new(fixture.docker_socket.clone())
        .prove_empty_containers(std::time::Instant::now() + Duration::from_secs(2));
    if !residual.trim().is_empty() {
        let expected = format!("created identity {} {}", canceled.id, canceled.name);
        assert_eq!(residual.trim(), expected);
        assert_eq!(proof, Err(EpochFault::DeleteOutcomeUncertain));
        println!(
            "physical proof refused for the original Create's residual identity container; epoch teardown required"
        );
        return;
    }
    proof.expect("private stock runtime is empty");
    for volume in fixture.docker(&["volume", "ls", "-q"]).split_whitespace() {
        fixture.docker(&["volume", "rm", volume]);
    }
    assert!(fixture.docker(&["volume", "ls", "-q"]).trim().is_empty());
    println!("stock cleanup: exact names absent, zero containers and volumes");
}

#[tokio::test]
#[ignore = "requires a new stock Gateway epoch after teardown of the predecessor"]
async fn stock_environment_provider_fresh_epoch() {
    let fixture = StockFixture::connect(&stock_lab_path()).await;
    fresh_inventory(&fixture).await;
    assert!(fixture.docker(&["ps", "-aq"]).trim().is_empty());
    assert!(fixture.docker(&["volume", "ls", "-q"]).trim().is_empty());
}

/// The v1 qualification uses the real SDK and a fixture-owned incarnation view.
/// The production desired-set and durable incarnation owner are separate gates.
#[tokio::test]
#[ignore = "requires the guarded dev-only stock Gateway lab"]
async fn stock_environment_provider_v1_address() {
    use crate::openshell_address::{AddressError, BoundAddress, IncarnationRow, ProviderScope};

    let lab = stock_lab_path();
    let fixture = StockFixture::connect(&lab).await;
    let second = std::env::var("A2H_LAB_SECOND_SBXI").unwrap();
    let vector = "sbxi_019af584-1234-7abc-8123-456789abcdef";
    let scope = ProviderScope {
        gateway: "stock-dev-lab",
        workspace: "default",
        host_epoch: "hepoch_019af584-8888-7abc-8123-456789abcdef",
    };
    let make_row = |incarnation| IncarnationRow {
        scope,
        incarnation,
        mapping_version: 1,
        create_intent: "first-create",
        native_id: None,
        attachment_generation: 1,
        stopped: false,
    };
    let mut rows = [make_row(vector), make_row(&second)];
    let spec = || SandboxSpec {
        image: Some("openkit-spike-s2-s1/worker:0fb6a42b9".into()),
        ..Default::default()
    };
    let policy = || {
        render_sandbox_policy(&serde_json::json!({
            "additionalFilesystemGrants": [], "additionalNetworkEndpoints": [],
        }))
        .unwrap()
    };
    let deadline = || tokio::time::Instant::now() + Duration::from_secs(45);
    let first_name = {
        let bound = BoundAddress::from_rows(scope, &mut rows, vector).unwrap();
        assert_eq!(bound.name(), "nh-keplbp5c6sa3ohuf");
        let result = fixture
            .provider
            .create_incarnation(&bound, "first-create", spec(), policy(), &[], deadline())
            .await
            .unwrap();
        // Drop the successful application-side reply before reopening the SDK
        // adapter. The original fixture row is still the unbound authority.
        drop(result);
        bound.name().to_owned()
    };
    let reopened = StockFixture::connect(&lab).await;
    let first_id = {
        let bound = BoundAddress::from_rows(scope, &mut rows, vector).unwrap();
        reopened
            .provider
            .inspect_incarnation(&bound)
            .await
            .unwrap()
            .unwrap()
            .id
    };
    let second_native = {
        let bound = BoundAddress::from_rows(scope, &mut rows, &second).unwrap();
        reopened
            .provider
            .create_incarnation(&bound, "first-create", spec(), policy(), &[], deadline())
            .await
            .unwrap()
    };
    rows[0].native_id = Some(&first_id);
    rows[1].native_id = Some(&second_native.id);
    let inventory = reopened
        .provider
        .inventory_incarnations(scope, &rows, 1)
        .await
        .unwrap();
    assert_eq!(inventory.observed.len(), 2);
    assert_eq!(inventory.absence, AbsenceProof::EpochRenewalOnly);
    println!(
        "v1 Create, Get and paged List verified both exact label pairs. Original address recovered after reply loss and adapter reopen."
    );

    let mut changed_scope = scope;
    changed_scope.workspace = "other";
    assert!(matches!(
        BoundAddress::from_rows(changed_scope, &mut rows, vector),
        Err(AddressError::Conflict)
    ));
    rows[0].mapping_version = 2;
    assert!(matches!(
        BoundAddress::from_rows(scope, &mut rows, vector),
        Err(AddressError::Conflict)
    ));
    rows[0].mapping_version = 1;

    // The second command is blocked against the still-held owner while a real
    // stock Delete runs. This tests the adapter/owner contract with a fixture lock.
    rows[0].stopped = true;
    let owned = tokio::sync::Mutex::new(rows);
    let delete = async {
        let mut guard = owned.lock().await;
        let bound = BoundAddress::from_rows(scope, &mut *guard, vector).unwrap();
        assert_eq!(
            reopened
                .provider
                .delete_incarnation(&bound, &first_id, 1, deadline())
                .await,
            Ok(Absent::AwaitingPhysicalProof)
        );
    };
    let competing = async {
        let phase = timeout(Duration::from_secs(30), async {
            loop {
                if reopened
                    .provider
                    .get_sandbox(&first_name)
                    .await
                    .is_ok_and(|row| row.phase == SandboxPhase::Deleting)
                {
                    assert!(owned.try_lock().is_err());
                    return;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            phase.is_ok(),
            "stock did not expose the dispatched-delete boundary"
        );
    };
    tokio::join!(delete, competing);
    assert!(reopened.container_id(&first_name).trim().is_empty());
    println!("Already-dispatched Delete kept replacement out under the fixture's row hold.");

    let mut rows = owned.into_inner();
    // An injected foreign recreation at the original name represents a bad
    // outside occupant. The fixture has dedicated cleanup authority for it.
    let mut foreign_spec = spec();
    foreign_spec.name = Some(first_name.clone());
    let foreign = reopened
        .provider
        .create_sandbox(foreign_spec, policy(), "foreign-fixture", &[])
        .await
        .unwrap();
    let bound = BoundAddress::from_rows(scope, &mut rows, vector).unwrap();
    assert!(matches!(
        reopened.provider.inspect_incarnation(&bound).await,
        Err(AddressError::Conflict)
    ));
    assert_eq!(
        reopened
            .provider
            .delete_incarnation(&bound, &first_id, 1, deadline())
            .await,
        Err(AddressError::Conflict)
    );
    assert_eq!(
        reopened.provider.get_sandbox(&first_name).await.unwrap().id,
        foreign.id
    );
    rows[0].native_id = Some(&foreign.id);
    let bound = BoundAddress::from_rows(scope, &mut rows, vector).unwrap();
    assert_eq!(
        reopened
            .provider
            .delete_incarnation(&bound, &first_id, 1, deadline())
            .await,
        Err(AddressError::Conflict)
    );
    assert_eq!(
        reopened.provider.get_sandbox(&first_name).await.unwrap().id,
        foreign.id
    );
    reopened
        .provider
        .delete_sandbox(&first_name, Some(&foreign.id), Duration::from_secs(45))
        .await
        .unwrap();
    println!("Stale Delete and mismatched stock labels/native ID preserved the foreign occupant.");

    rows[1].stopped = true;
    let bound = BoundAddress::from_rows(scope, &mut rows, &second).unwrap();
    assert_eq!(
        reopened
            .provider
            .delete_incarnation(&bound, &second_native.id, 1, deadline())
            .await,
        Ok(Absent::AwaitingPhysicalProof)
    );
    assert!(
        reopened
            .provider
            .inventory_incarnations(scope, &rows, 1)
            .await
            .unwrap()
            .observed
            .is_empty()
    );
    reopened.require_empty_runtime().await;
}
