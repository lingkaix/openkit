//! Closed physical-close observations preserve typed provenance without private error bytes.

use std::io::{self, ErrorKind};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

use super::format_h2_driver_close;

const PRIVATE_IO_TEXT: &str = "PRIVATE_FIXTURE_IO\nokt_not_a_real_fixture_credential";
const PRIVATE_DEBUG_BYTES: &[u8] = b"PRIVATE_FIXTURE_DEBUG\nokt_not_a_real_fixture_credential";
const DEADLINE: Duration = Duration::from_secs(5);

/// Assert the complete prior grammar, including its single-line and value-free boundary.
fn assert_observation(result: &Result<(), h2::Error>, fields: &str) {
    let observed = format_h2_driver_close(result);
    assert_eq!(
        observed,
        format!("nanohost physical connection ended: {fields}")
    );
    assert!(!observed.contains(['\n', '\r']));
    assert!(!observed.contains("PRIVATE_FIXTURE"));
    assert!(!observed.contains("okt_"));
}

/// Inject an OS error only after the actual H2 client handshake has completed.
struct ArmedIoFailure {
    armed: Arc<AtomicBool>,
    kind: ErrorKind,
    on_write: bool,
}

impl AsyncRead for ArmedIoFailure {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.armed.load(Ordering::SeqCst) && !self.on_write {
            Poll::Ready(Err(io::Error::new(self.kind, PRIVATE_IO_TEXT)))
        } else {
            Poll::Pending
        }
    }
}

impl AsyncWrite for ArmedIoFailure {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.armed.load(Ordering::SeqCst) && self.on_write {
            Poll::Ready(Err(io::Error::new(self.kind, PRIVATE_IO_TEXT)))
        } else {
            Poll::Ready(Ok(bytes.len()))
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Drive the real H2 connection over its failing async I/O boundary, without a socket.
async fn io_driver_close(kind: ErrorKind, on_write: bool) -> Result<(), h2::Error> {
    let armed = Arc::new(AtomicBool::new(false));
    let io = ArmedIoFailure {
        armed: armed.clone(),
        kind,
        on_write,
    };
    let (requests, driver) = h2::client::handshake(io)
        .await
        .expect("fixture handshake must precede the injected I/O failure");
    armed.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(DEADLINE, driver)
        .await
        .expect("injected driver failure must complete within the fixture deadline");
    drop(requests);
    result
}

/// Encode a finite fixture frame; the production h2 decoder supplies all error classification.
fn frame(kind: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("fixture payload length fits u32");
    assert!(length < (1 << 24));
    let mut bytes = Vec::with_capacity(9 + payload.len());
    bytes.extend_from_slice(&length.to_be_bytes()[1..]);
    bytes.extend_from_slice(&[kind, 0]);
    bytes.extend_from_slice(&stream.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// Supply SETTINGS and one deciding wire frame to the actual client driver in memory.
async fn wire_driver_close(deciding_frame: Vec<u8>) -> Result<(), h2::Error> {
    let (client_io, mut peer_io) = tokio::io::duplex(4096);
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let peer = tokio::spawn(async move {
        peer_io
            .write_all(&frame(4, 0, &[]))
            .await
            .expect("fixture SETTINGS write");
        peer_io
            .write_all(&deciding_frame)
            .await
            .expect("fixture deciding-frame write");
        peer_io.flush().await.expect("fixture frame flush");
        // Keep the peer open so EOF cannot replace the deciding protocol observation.
        let _ = released.await;
    });
    let (requests, driver) = h2::client::handshake(client_io)
        .await
        .expect("fixture client handshake");
    let result = tokio::time::timeout(DEADLINE, driver)
        .await
        .expect("wire close must complete within the fixture deadline");
    drop(requests);
    let _ = release.send(());
    peer.await.expect("fixture peer completion");
    result
}

#[test]
fn physical_close_clean_end_has_no_failure_fields() {
    assert_observation(
        &Ok(()),
        "source=h2_driver outcome=clean_end initiator=none reason=none io=none",
    );
}

#[test]
fn physical_close_bare_reason_names_are_closed_and_independent_of_display_text() {
    for (reason, name) in [
        (h2::Reason::NO_ERROR, "no_error"),
        (h2::Reason::PROTOCOL_ERROR, "protocol_error"),
        (h2::Reason::INTERNAL_ERROR, "internal_error"),
        (h2::Reason::FLOW_CONTROL_ERROR, "flow_control_error"),
        (h2::Reason::SETTINGS_TIMEOUT, "settings_timeout"),
        (h2::Reason::STREAM_CLOSED, "stream_closed"),
        (h2::Reason::FRAME_SIZE_ERROR, "frame_size_error"),
        (h2::Reason::REFUSED_STREAM, "refused_stream"),
        (h2::Reason::CANCEL, "cancel"),
        (h2::Reason::COMPRESSION_ERROR, "compression_error"),
        (h2::Reason::CONNECT_ERROR, "connect_error"),
        (h2::Reason::ENHANCE_YOUR_CALM, "enhance_your_calm"),
        (h2::Reason::INADEQUATE_SECURITY, "inadequate_security"),
        (h2::Reason::HTTP_1_1_REQUIRED, "http_1_1_required"),
    ] {
        let result = Err(h2::Error::from(reason));
        assert_observation(
            &result,
            &format!(
                "source=h2_driver outcome=protocol_error initiator=other reason={name} io=none"
            ),
        );
    }
    assert_observation(
        &Err(h2::Error::from(h2::Reason::from(0xdead_beef))),
        "source=h2_driver outcome=protocol_error initiator=other reason=unknown io=none",
    );
}

#[tokio::test]
async fn physical_close_async_io_preserves_only_the_closed_kind() {
    for (kind, name, on_write) in [
        (ErrorKind::ConnectionReset, "connection_reset", false),
        (ErrorKind::ConnectionAborted, "connection_aborted", false),
        (ErrorKind::UnexpectedEof, "unexpected_eof", false),
        (ErrorKind::TimedOut, "timed_out", false),
        (ErrorKind::BrokenPipe, "broken_pipe", true),
        (ErrorKind::NotConnected, "not_connected", false),
        (ErrorKind::InvalidData, "invalid_data", false),
        (ErrorKind::Interrupted, "interrupted", false),
        (ErrorKind::WouldBlock, "would_block", false),
        (ErrorKind::PermissionDenied, "other", false),
    ] {
        let result = io_driver_close(kind, on_write).await;
        let error = result
            .as_ref()
            .expect_err("fixture must produce an actual H2 I/O error");
        assert!(error.is_io());
        let io = error.get_io().expect("typed I/O origin");
        assert_eq!(io.kind(), kind);
        assert!(io.to_string().contains("PRIVATE_FIXTURE_IO"));
        assert_observation(
            &result,
            &format!("source=h2_driver outcome=io_error initiator=none reason=none io={name}"),
        );
    }
}

#[tokio::test]
async fn physical_close_remote_goaway_redacts_real_peer_debug_bytes() {
    for (reason, expected) in [(11_u32, "enhance_your_calm"), (0xdead_beef, "unknown")] {
        let mut payload = 0_u32.to_be_bytes().to_vec();
        payload.extend_from_slice(&reason.to_be_bytes());
        payload.extend_from_slice(PRIVATE_DEBUG_BYTES);
        let result = wire_driver_close(frame(7, 0, &payload)).await;
        let error = result
            .as_ref()
            .expect_err("fixture peer GOAWAY must reach the driver");
        assert!(error.is_go_away());
        assert!(error.is_remote());
        assert!(!error.is_library());
        assert_eq!(error.reason(), Some(h2::Reason::from(reason)));
        assert!(format!("{error:?}").contains("PRIVATE_FIXTURE_DEBUG"));
        assert_observation(
            &result,
            &format!("source=h2_driver outcome=goaway initiator=remote reason={expected} io=none"),
        );
    }
}

#[tokio::test]
async fn physical_close_library_protocol_detection_is_not_claimed_as_remote_goaway() {
    // PING is connection-scoped; a complete payload on stream 1 is a protocol error.
    let result = wire_driver_close(frame(6, 1, &[0; 8])).await;
    let error = result
        .as_ref()
        .expect_err("invalid PING must fail the actual H2 decoder");
    assert!(error.is_go_away());
    assert!(error.is_library());
    assert!(!error.is_remote());
    assert_eq!(error.reason(), Some(h2::Reason::PROTOCOL_ERROR));
    assert_observation(
        &result,
        "source=h2_driver outcome=goaway initiator=library reason=protocol_error io=none",
    );
}

#[tokio::test]
async fn physical_close_real_stream_reset_has_remote_origin_and_closed_reason() {
    let (client_io, server_io) = tokio::io::duplex(4096);
    let server = tokio::spawn(async move {
        let mut connection = h2::server::handshake(server_io)
            .await
            .expect("fixture server handshake");
        let (_, mut response) = connection
            .accept()
            .await
            .expect("fixture request")
            .expect("fixture request decoding");
        response.send_reset(h2::Reason::CANCEL);
        // Poll the real server connection to flush RST_STREAM to its client.
        let _ = connection.accept().await;
    });
    let (requests, connection) = h2::client::handshake(client_io)
        .await
        .expect("fixture client handshake");
    let driver = tokio::spawn(connection);
    let mut requests = requests.ready().await.expect("fixture client readiness");
    let request = http::Request::builder()
        .uri("https://fixture.invalid/")
        .body(())
        .expect("fixture request shape");
    let (response, _) = requests
        .send_request(request, true)
        .expect("fixture request submission");
    let result = tokio::time::timeout(DEADLINE, response)
        .await
        .expect("fixture reset deadline")
        .map(|_| ());
    drop(requests);
    driver.abort();
    server.abort();
    let _ = driver.await;
    let _ = server.await;
    let error = result
        .as_ref()
        .expect_err("the real peer reset must reach the client");
    assert!(error.is_reset());
    assert!(error.is_remote());
    assert!(!error.is_library());
    assert_observation(
        &result,
        "source=h2_driver outcome=reset initiator=remote reason=cancel io=none",
    );
}
