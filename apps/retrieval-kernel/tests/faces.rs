//! Real executable faces operate only on test-owned canonical and derived roots.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

/// Run the actual shipped executable and parse its finite newline-delimited output.
fn execute(root: &Path, args: &[&str], frames: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_retrieval-kernel"))
        .current_dir(root)
        .args(args)
        .env("LINDERA_CONFIG_PATH", "/missing/ambient-config")
        .env(
            "LINDERA_BUILD_DICTIONARY_CACHE_DIR",
            "/missing/runtime-cache",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for frame in frames {
        writeln!(stdin, "{}", serde_json::to_string(frame).unwrap()).unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() < 64 * 1024);
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// Named and current-directory CLI searches share the same scoped result and packaged dictionaries.
#[test]
fn cli_smoke_current_and_named_directory() {
    let root = TempDir::new().unwrap();
    fs::write(
        root.path().join("chinese.txt"),
        "我们完成了测试，并修复了缺陷。",
    )
    .unwrap();
    fs::write(root.path().join("japanese.txt"), "検索機能を改善しました。").unwrap();
    fs::write(root.path().join("binary"), b"\0BINARY_BODY_SECRET").unwrap();
    let indexed = execute(root.path(), &["index"], &[]);
    assert!(indexed[0]["generation"].as_str().unwrap().len() == 64);
    for (mode, query, source) in [
        ("lexical", "测试", "chinese.txt"),
        ("lexical", "検索", "japanese.txt"),
        ("exact", "修复", "chinese.txt"),
        ("regex", "検索", "japanese.txt"),
    ] {
        let current = execute(root.path(), &["search", mode, query], &[]);
        let named = execute(
            root.path(),
            &["search", mode, query, root.path().to_str().unwrap()],
            &[],
        );
        assert_eq!(current, named);
        assert_eq!(current[0]["complete"], true);
        assert_eq!(current[0]["hits"][0]["key"]["id"], source);
    }
    let empty = execute(root.path(), &["search", "exact", "BINARY_BODY_SECRET"], &[]);
    assert!(empty[0]["hits"].as_array().unwrap().is_empty());
    assert_eq!(empty[0]["coverage"]["unsupported_bodies"], 1);
}

/// MCP uses newline JSON-RPC, exposes one search tool, and cannot widen its startup root.
#[test]
fn mcp_stdio_smoke_and_startup_root_confinement() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(root.path().join("public"), "public marker\n").unwrap();
    fs::write(outside.path().join("private"), "SECRET_OUTSIDE\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
    execute(root.path(), &["index"], &[]);
    let cli = execute(root.path(), &["search", "exact", "marker"], &[]).remove(0);
    let frames = vec![
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"mode":"exact","query":"marker","limit":20}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{"mode":"exact","query":"SECRET_OUTSIDE","limit":20,"path":outside.path()}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search","arguments":{"mode":"regex","query":"SECRET_OUTSIDE","limit":20}}}),
    ];
    let replies = execute(root.path(), &["mcp"], &frames);
    assert_eq!(replies.len(), 5);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 1);
    let found: Value =
        serde_json::from_str(replies[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(found, cli);
    assert_eq!(replies[3]["error"]["code"], -32602);
    let absent: Value =
        serde_json::from_str(replies[4]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(absent["hits"].as_array().unwrap().is_empty());
    assert_eq!(absent["coverage"]["admitted_objects"], 1);
    assert_eq!(absent["complete"], true);
}

/// Trusted service requests use explicit versions, inventories, and expected-generation conflicts.
#[test]
fn local_service_contract_smoke_and_revocation_after_restart() {
    let root = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    let bytes = b"public marker";
    fs::write(root.path().join("source"), bytes).unwrap();
    let hash = format!("{:x}", Sha256::digest(bytes));
    let view = json!({"scope":"public","documents":[{"key":{"namespace":"fixture","id":"source"},"revision":"1","digest":hash,"size":bytes.len(),"name":"source","title":"unrelated","media_type":"text/plain","content":{"kind":"text","path":"source"}}]});
    let args = [
        "service",
        "--sources",
        root.path().to_str().unwrap(),
        "--store",
        store.path().to_str().unwrap(),
    ];
    let mut frames = vec![
        json!({"version":1,"id":1,"op":"publish","view":view,"expected_generation":null}),
        json!({"version":1,"id":2,"op":"inspect","scope":"public"}),
    ];
    for (id, mode) in [(3, "lexical"), (4, "exact"), (5, "regex")] {
        frames.push(json!({"version":1,"id":id,"op":"search","request":{"mode":mode,"query":"marker","scopes":[view],"limit":20}}));
    }
    frames.extend([
        json!({"version":99,"id":6,"op":"inspect","scope":"public"}),
        json!({"version":1,"id":7,"op":"publish","view":view}),
        json!({"version":1,"id":8,"op":"search","request":{"mode":"new-core-value","query":"marker","scopes":[],"limit":20}}),
        json!({"version":1,"id":9,"op":"search","request":{"mode":"exact","query":"marker","limit":20}}),
    ]);
    let replies = execute(root.path(), &args, &frames);
    assert_eq!(
        replies[0]["result"]["generation"],
        replies[1]["result"]["generation"]
    );
    for reply in &replies[2..5] {
        assert_eq!(reply["result"]["hits"][0]["key"]["id"], "source");
        assert_eq!(reply["result"]["complete"], true);
    }
    for reply in &replies[5..] {
        assert_eq!(reply["error"]["code"], "invalid-request");
    }
    let revoked = execute(
        root.path(),
        &args,
        &[
            json!({"version":1,"id":10,"op":"search","request":{"mode":"lexical","query":"marker","scopes":[],"limit":20}}),
        ],
    );
    assert!(revoked[0]["result"]["hits"].as_array().unwrap().is_empty());
    assert_eq!(revoked[0]["result"]["coverage"]["admitted_objects"], 0);
    assert_eq!(revoked[0]["result"]["generations"], json!({}));
}

/// The executable enforces named OS ceilings before accepting a service request.
#[test]
fn executable_process_resource_limits() {
    let root = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_retrieval-kernel"))
        .args([
            "service",
            "--sources",
            root.path().to_str().unwrap(),
            "--store",
            store.path().to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.as_mut().unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"version":1,"id":1,"op":"inspect","scope":"empty"})
    )
    .unwrap();
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["version"], 1);
    let limits = fs::read_to_string(format!("/proc/{}/limits", child.id())).unwrap();
    let memory = limits
        .lines()
        .find(|l| l.starts_with("Max address space"))
        .unwrap();
    assert!(memory.contains("2147483648"), "{memory}");
    let file = limits
        .lines()
        .find(|l| l.starts_with("Max file size"))
        .unwrap();
    assert!(file.contains("536870912"), "{file}");
    let cpu = limits
        .lines()
        .find(|l| l.starts_with("Max cpu time"))
        .unwrap();
    assert!(cpu.split_whitespace().any(|v| v == "65"), "{cpu}");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

/// An actual OS file-growth failure cannot acknowledge a new generation or mutate canonical bytes.
#[test]
fn filesystem_growth_failure_preserves_last_commit() {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    let root = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    let kernel = retrieval_kernel::Kernel::new(root.path(), store.path()).unwrap();
    let empty = retrieval_kernel::ScopeView {
        unavailable_objects: 0,
        scope: "scope".into(),
        documents: vec![],
    };
    let prior = kernel.publish(empty, None).unwrap();
    fs::write(root.path().join("source"), b"canonical bytes").unwrap();
    let digest = format!("{:x}", Sha256::digest(b"canonical bytes"));
    let view = json!({"scope":"scope","documents":[{"key":{"namespace":"fixture","id":"source"},"revision":"1","digest":digest,"size":15,"name":"source","media_type":"text/plain","content":{"kind":"text","path":"source"}}]});
    let mut command = Command::new(env!("CARGO_BIN_EXE_retrieval-kernel"));
    command
        .args([
            "service",
            "--sources",
            root.path().to_str().unwrap(),
            "--store",
            store.path().to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe setrlimit runs between fork and exec, in the child alone.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: 1,
                rlim_max: 1,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"version":1,"id":1,"op":"publish","view":view,"expected_generation":prior})
    )
    .unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.signal(), Some(libc::SIGXFSZ));
    assert!(
        output.stdout.is_empty(),
        "failed publication was acknowledged"
    );
    assert_eq!(kernel.generation("scope").unwrap(), Some(prior));
    assert_eq!(
        fs::read(root.path().join("source")).unwrap(),
        b"canonical bytes"
    );
}

/// The service consumes canonical adapter text without requiring a persisted plain-text file.
#[test]
fn local_service_adapter_text_round_trip() {
    let root = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    let text = "hello\nworld";
    let view = json!({"scope":"items","documents":[{"key":{"namespace":"items","id":"item-1"},"revision":"1","digest":format!("{:x}", Sha256::digest(text.as_bytes())),"size":text.len(),"name":"item-1","media_type":"text/plain","content":{"kind":"inline-text","text":text},"locator":"item-1"}]});
    let frames = [
        json!({"version":1,"id":1,"op":"publish","view":view,"expected_generation":null}),
        json!({"version":1,"id":2,"op":"search","request":{"mode":"lexical","query":"world","scopes":[view],"limit":20}}),
        json!({"version":1,"id":3,"op":"search","request":{"mode":"exact","query":"hello\nworld","scopes":[view],"limit":20}}),
    ];
    let replies = execute(
        root.path(),
        &[
            "service",
            "--sources",
            root.path().to_str().unwrap(),
            "--store",
            store.path().to_str().unwrap(),
        ],
        &frames,
    );
    assert!(replies[0]["result"]["generation"].is_string());
    for reply in &replies[1..] {
        assert_eq!(reply["result"]["complete"], true);
        assert_eq!(reply["result"]["hits"][0]["key"]["id"], "item-1");
    }
}
