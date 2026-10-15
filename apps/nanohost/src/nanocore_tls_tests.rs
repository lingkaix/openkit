//! Real Node native HTTPS/HTTP2 admission and durable readiness regression.

use super::*;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};

static NEXT_PEER: AtomicU64 = AtomicU64::new(0);

/// Forces a partial TLS record write followed by a writable wakeup.
struct FragmentedSocket {
    socket: TcpStream,
    fragment: bool,
    pause: bool,
}

impl AsyncRead for FragmentedSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_read(cx, buffer)
    }
}

impl AsyncWrite for FragmentedSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.pause {
            self.pause = false;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        let length = if self.fragment {
            buffer.len().min(7)
        } else {
            buffer.len()
        };
        let result = Pin::new(&mut self.socket).poll_write(cx, &buffer[..length]);
        if self.fragment && matches!(result, Poll::Ready(Ok(_))) {
            self.pause = true;
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

/// Owns only the child and temporary files created by this regression.
struct NativeTlsPeer {
    child: std::process::Child,
    root: PathBuf,
}

impl Drop for NativeTlsPeer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Starts the real NanoCore route fixture under the caller's pinned Node runtime.
async fn native_tls_peer() -> (
    NativeTlsPeer,
    tokio::io::Lines<BufReader<tokio::fs::File>>,
    serde_json::Value,
) {
    let root = std::env::temp_dir().join(format!(
        "openkit-native-tls-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_PEER.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::create_dir(&root).unwrap();
    let nanocore = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nanocore");
    let child = std::process::Command::new("node")
        .arg("--import")
        .arg(nanocore.join("node_modules/tsx/dist/loader.mjs"))
        .arg(nanocore.join("src/test-support/nanohost-native-tls-peer.ts"))
        .arg(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Node native TLS fixture must start");
    let mut peer = NativeTlsPeer { child, root };
    let stdout: std::os::fd::OwnedFd = peer.child.stdout.take().unwrap().into();
    let mut lines = BufReader::new(tokio::fs::File::from_std(stdout.into())).lines();
    let line = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
        .await
        .expect("native TLS fixture startup bound")
        .unwrap()
        .expect("native TLS fixture address");
    let input = serde_json::from_str(&line).expect("native TLS fixture input");
    (peer, lines, input)
}

#[tokio::test]
async fn native_tls_reaches_authenticated_admission_and_positive_ready_generation() {
    assert_native_tls_ready(false).await;
}

#[tokio::test]
async fn native_tls_handshake_progresses_after_partial_record_write() {
    assert_native_tls_ready(true).await;
}

/// Requires real Token admission and durable readiness on one verified native connection.
async fn assert_native_tls_ready(fragment: bool) {
    let (peer, mut lines, input) = native_tls_peer().await;
    let origin = format!("https://localhost:{}", input["port"].as_u64().unwrap());
    let transport = prepare_verified_session_transport(
        &origin,
        &TlsTrustMaterial::ConfiguredRef {
            reference: peer.root.join("ca.pem").to_str().unwrap().to_owned(),
        },
    )
    .expect("exclusive fixture CA trust");
    let (context, mut presentation) = super::tests::test_outer_credentials();
    if let CredentialPresentationOutcome::Presented { secret, .. } = &mut presentation {
        *secret = input["secret"].as_str().unwrap().to_owned();
    }
    let startup_deadline = super::tests::test_startup_deadline();
    let generation = tokio::time::timeout(Duration::from_secs(5), async {
        let VerifiedSessionIo::Tls(io) =
            connect_verified_session_transport(&origin, &transport, startup_deadline)
                .await
                .unwrap()
        else {
            panic!("HTTPS must use verified TLS");
        };
        let io = AsyncRustlsClientStream {
            socket: FragmentedSocket {
                socket: io.socket,
                fragment,
                pause: false,
            },
            connection: io.connection,
            pending_tls: io.pending_tls,
            pending_tls_offset: io.pending_tls_offset,
        };
        run_outer_session(
            io,
            &origin,
            &context,
            &presentation,
            None,
            (&"a".repeat(64), startup_deadline, || Ok(None)),
            |generation, _| async move {
                assert!(generation > 0, "dispatch requires authenticated readiness");
                Ok(())
            },
        )
        .await
    })
    .await
    .expect("native TLS must reach authenticated readiness within five seconds")
    .expect("verified native HTTP/2 admission and readiness");
    let observation = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .expect("durable readiness observation");
    let observation: serde_json::Value = serde_json::from_str(&observation).unwrap();
    assert_eq!(observation["ready"], true);
    assert_eq!(observation["generation"].as_u64(), Some(generation));
    assert!(generation > 0);
}

#[tokio::test]
async fn native_tls_offers_only_h2_for_both_trust_sources() {
    let (peer, _lines, _input) = native_tls_peer().await;
    for trust in [
        TlsTrustMaterial::Platform,
        TlsTrustMaterial::ConfiguredRef {
            reference: peer.root.join("ca.pem").to_str().unwrap().to_owned(),
        },
    ] {
        let config = build_verified_tls_client_config(&trust).expect("verified TLS config");
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec()],
            "native TLS must offer only HTTP/2"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn silent_tls_and_http2_peers_fail_within_session_startup_bound() {
    for capacity in [1, 4096] {
        for reconnect_after in [None, Some(7)] {
            let (socket, _silent_peer) = tokio::io::duplex(capacity);
            assert_silent_startup(socket, reconnect_after, Duration::ZERO).await;
            let (socket, _silent_peer) = tokio::io::duplex(capacity);
            let config = build_verified_tls_client_config(&TlsTrustMaterial::Platform).unwrap();
            assert_silent_startup(
                AsyncRustlsClientStream {
                    socket,
                    connection: ClientConnection::new(
                        config,
                        ServerName::try_from("localhost").unwrap(),
                    )
                    .unwrap(),
                    pending_tls: Vec::new(),
                    pending_tls_offset: 0,
                },
                reconnect_after,
                Duration::ZERO,
            )
            .await;
        }
    }
}

/// A silent peer cannot grant readiness or hold startup open indefinitely.
async fn assert_silent_startup<IO: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: IO,
    reconnect_after: Option<u64>,
    connection_elapsed: Duration,
) {
    let started = tokio::time::Instant::now();
    let startup_deadline = started + Duration::from_secs(120);
    tokio::time::advance(connection_elapsed).await;
    let (context, presentation) = super::tests::test_outer_credentials();
    let failure = tokio::time::timeout(
        Duration::from_secs(121) - connection_elapsed,
        run_outer_session(
            io,
            "https://localhost",
            &context,
            &presentation,
            reconnect_after,
            (&"a".repeat(64), startup_deadline, || Ok(None)),
            |_, _| async { panic!("silent peer cannot reach readiness") },
        ),
    )
    .await
    .expect("session owner must bound TLS and HTTP/2 startup")
    .expect_err("silent peer must fail closed");
    assert_eq!(
        failure.disposition(),
        if reconnect_after.is_some() {
            OuterSessionDisposition::Reconnect
        } else {
            OuterSessionDisposition::Terminal
        }
    );
    assert_eq!(failure.reconnect_after(), reconnect_after);
    assert_eq!(
        tokio::time::Instant::now() - started,
        Duration::from_secs(120)
    );
    assert_eq!(
        failure.reason(),
        "outer-session startup hard bound exceeded"
    );
}

#[tokio::test(start_paused = true)]
async fn ready_session_outlives_startup_deadline() {
    let (client, server) = tokio::io::duplex(4096);
    let peer = tokio::spawn(async move {
        let mut connection = h2::server::handshake(server).await.unwrap();
        while let Some(request) = connection.accept().await {
            let (mut request, mut response) = request.unwrap();
            while let Some(chunk) = request.body_mut().data().await {
                let chunk = chunk.unwrap();
                request
                    .body_mut()
                    .flow_control()
                    .release_capacity(chunk.len())
                    .unwrap();
            }
            if request.uri().path().ends_with("/admit") {
                let mut body = response
                    .send_response(Response::builder().status(200).body(()).unwrap(), false)
                    .unwrap();
                body.send_data(Bytes::from_static(br#"{"connectionGeneration":1,"identityId":"nanohost-a","deploymentId":"deployment-a","role":"authoritative","mayCarryWork":true}"#), true).unwrap();
            } else {
                response
                    .send_response(Response::builder().status(204).body(()).unwrap(), true)
                    .unwrap();
            }
        }
    });
    let (context, presentation) = super::tests::test_outer_credentials();
    let startup_deadline = super::tests::test_startup_deadline();
    let result = run_outer_session(
        client,
        "http://localhost",
        &context,
        &presentation,
        None,
        (&"a".repeat(64), startup_deadline, || Ok(None)),
        |_, _| async {
            tokio::time::sleep(Duration::from_secs(121)).await;
            Ok(())
        },
    )
    .await;
    assert_eq!(
        result.unwrap(),
        1,
        "ready sessions have no startup lifetime limit"
    );
    peer.abort();
}

#[tokio::test]
async fn native_tls_verifies_ca_and_server_name_before_ready() {
    let (peer, _lines, input) = native_tls_peer().await;
    for (host, trust) in [
        ("localhost", TlsTrustMaterial::Platform),
        (
            "127.0.0.1",
            TlsTrustMaterial::ConfiguredRef {
                reference: peer.root.join("ca.pem").to_str().unwrap().to_owned(),
            },
        ),
    ] {
        let origin = format!("https://{host}:{}", input["port"].as_u64().unwrap());
        let transport = prepare_verified_session_transport(&origin, &trust).unwrap();
        let (context, mut presentation) = super::tests::test_outer_credentials();
        if let CredentialPresentationOutcome::Presented { secret, .. } = &mut presentation {
            *secret = input["secret"].as_str().unwrap().to_owned();
        }
        let startup_deadline = super::tests::test_startup_deadline();
        let failure = tokio::time::timeout(Duration::from_secs(5), async {
            let io = connect_verified_session_transport(&origin, &transport, startup_deadline)
                .await
                .unwrap();
            run_outer_session(
                io,
                &origin,
                &context,
                &presentation,
                None,
                (&"a".repeat(64), startup_deadline, || Ok(None)),
                |_, _| async { panic!("untrusted CA or wrong server name cannot grant readiness") },
            )
            .await
        })
        .await
        .expect("verification rejection must be bounded")
        .expect_err("verification must fail closed");
        assert!(matches!(
            failure.stage,
            OuterSessionStage::Connect | OuterSessionStage::Admission
        ));
    }
}

#[tokio::test(start_paused = true)]
async fn elapsed_connection_budget_is_not_renewed_for_tls_or_http2() {
    let (socket, _silent_peer) = tokio::io::duplex(4096);
    assert_silent_startup(socket, None, Duration::from_secs(110)).await;
    let (socket, _silent_peer) = tokio::io::duplex(4096);
    let config = build_verified_tls_client_config(&TlsTrustMaterial::Platform).unwrap();
    assert_silent_startup(
        AsyncRustlsClientStream {
            socket,
            connection: ClientConnection::new(config, ServerName::try_from("localhost").unwrap())
                .unwrap(),
            pending_tls: Vec::new(),
            pending_tls_offset: 0,
        },
        None,
        Duration::from_secs(110),
    )
    .await;
}
