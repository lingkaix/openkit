// Verification-only composition of the unchanged P02 producer and its accepted fixture hooks.
use std::io::{BufRead, Write};
use std::process::{Child, Command};
use std::sync::Arc;

use live_inspection::{InspectionServer, InspectionState, test_support};

/// Terminates only the fixture-owned Gateway process on every ordinary exit.
struct Gateway(Child);
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Reads nonce requests while keeping the actual coordinator and measured member alive.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let root = std::path::PathBuf::from(args.next().expect("private fixture root"));
    let mode = args.next().expect("fixture scenario");
    let gateway = Gateway(Command::new("/bin/sleep").arg("60").spawn().unwrap());
    let state = InspectionState::new("2".repeat(64), gateway.0.id()).unwrap();
    state.admit("host-fixture", "deployment-fixture", 8);
    let changed = Arc::clone(&state);
    let member = gateway.0.id();
    let after_pin: Option<Arc<dyn Fn() + Send + Sync>> = match mode.as_str() {
        "observed" => None,
        "reconnect" => Some(Arc::new(move || {
            changed.clear();
            changed.admit("host-fixture", "deployment-fixture", 9);
        })),
        "replace" => Some(Arc::new(move || {
            // SAFETY: this PID belongs to the child retained by the fixture's Gateway guard.
            assert_eq!(unsafe { libc::kill(member as i32, libc::SIGKILL) }, 0);
        })),
        _ => panic!("unknown fixture scenario"),
    };
    let endpoint = format!("openkit.p29.fixture.{}", std::process::id()).into_bytes();
    // SAFETY: getuid has no arguments and changes no process state.
    let uid = unsafe { libc::getuid() };
    let properties = std::fs::read_to_string(root.join("systemd.txt")).unwrap();
    let properties = properties.replace(
        "MainPID=FIXTURE_PID",
        &format!("MainPID={}", std::process::id()),
    );
    let server = InspectionServer::start_fixture(
        state,
        test_support::Fixture {
            endpoint: endpoint.clone(),
            allowed_uid: uid,
            machine_id: root.join("machine-id"),
            unit_file: root.join("unit"),
            unit_observer: Arc::new(move || Ok(properties.clone())),
            after_pin,
        },
    )
    .unwrap();
    for line in std::io::stdin().lock().lines() {
        let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let nonce = request["nonce"].as_str().unwrap();
        let reply = test_support::inspect_at(nonce, &endpoint, uid)
            .await
            .unwrap();
        println!("{}", serde_json::to_string(&reply).unwrap());
        std::io::stdout().flush().unwrap();
    }
    drop(server);
    drop(gateway);
}
