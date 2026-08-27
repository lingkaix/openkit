//! Disposable probe: proves the exact-tag OpenShell SDK exposes the sandbox
//! lifecycle methods and the raw forwarding client the NanoHost requires,
//! without linking any Gateway server crate.
use openshell_sdk::raw::proto::{ExecSandboxInput, ExecSandboxRequest, TcpForwardFrame};
use openshell_sdk::{ClientConfig, OpenShellClient};

/// Type-checks lifecycle, forwarding, and interactive-exec calls against the pinned SDK.
///
/// The client, sandbox specification, and identifier exist only to supply the exact method
/// signatures; this function is compiled but never executed.
#[allow(dead_code)]
async fn probe(c: &OpenShellClient, spec: openshell_sdk::SandboxSpec, id: &str) {
    // Typed lifecycle surface.
    let _ = c.create_sandbox(spec).await;
    let _ = c.get_sandbox(id).await;
    let _ = c
        .list_sandboxes(openshell_sdk::ListOptions::default())
        .await;
    let _ = c.delete_sandbox(id).await;

    // Raw forwarding client: the escape hatch must yield a generated client
    // carrying the three streaming RPCs the transport design consumes.
    let mut raw = c.raw_grpc();
    let (_tx, rx) = tokio::sync::mpsc::channel::<TcpForwardFrame>(1);
    let _ = raw
        .forward_tcp(tokio_stream::wrappers::ReceiverStream::new(rx))
        .await;
    let _ = raw.exec_sandbox(ExecSandboxRequest::default()).await;
    let (_exec_tx, exec_rx) = tokio::sync::mpsc::channel::<ExecSandboxInput>(1);
    let _ = raw
        .exec_sandbox_interactive(tokio_stream::wrappers::ReceiverStream::new(exec_rx))
        .await;
}

fn main() {
    let _ = ClientConfig::default();
    println!("probe compiled");
}
