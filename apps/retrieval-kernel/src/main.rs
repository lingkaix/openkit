//! Directory CLI, startup-bound MCP, and trusted local stdio service.
use retrieval_kernel::{directory::Directory, *};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::PathBuf;

/// Dispatch one face. Runtime performs no network operations or subprocess launches.
fn main() {
    if let Err(error) = run() {
        eprintln!("{}", serde_json::to_string(&error).unwrap());
        std::process::exit(1);
    }
}
/// Local bounded error constructor.
fn error(code: &str, message: &str) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}
/// Parse flags without an alternate command framework or a second search path.
fn run() -> Result<()> {
    process_limits()?;
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--version") {
        println!("retrieval-kernel {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.is_empty() {
        return Err(error(
            "invalid-request",
            "usage: retrieval-kernel index|search|mcp|service [arguments]",
        ));
    }
    let command = args.remove(0);
    let store_flag = flag(&mut args, "--store")?;
    let source_flag = flag(&mut args, "--sources")?;
    let limit = flag(&mut args, "--limit")?
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| error("invalid-request", "limit must be a positive integer"))?
        .unwrap_or(20);
    if command == "service" {
        if !args.is_empty() {
            return Err(error("invalid-request", "unexpected service arguments"));
        }
        let root = source_flag
            .ok_or_else(|| error("invalid-request", "service requires a startup source root"))?;
        let store = store_flag.ok_or_else(|| {
            error(
                "invalid-request",
                "service requires an owner-assigned derived store",
            )
        })?;
        let kernel = Kernel::new(&PathBuf::from(root), &PathBuf::from(store))?;
        return stdio(|request| service(&kernel, request), true);
    }
    if source_flag.is_some() {
        return Err(error("invalid-request", "sources flag is service-only"));
    }
    let query_args = if command == "search" {
        if args.len() < 2 {
            return Err(error("invalid-request", "search requires mode and query"));
        }
        let mode = serde_json::from_value(json!(args.remove(0)))
            .map_err(|_| error("invalid-request", "unknown query mode"))?;
        Some((mode, args.remove(0)))
    } else {
        None
    };
    if !["index", "search", "mcp"].contains(&command.as_str()) || args.len() > 1 {
        return Err(error(
            "invalid-request",
            "unknown command or extra arguments",
        ));
    }
    let root = args.pop().map(PathBuf::from).unwrap_or(
        std::env::current_dir().map_err(|_| error("io", "current directory unavailable"))?,
    );
    let store = store_flag
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".retrieval-kernel"));
    let kernel = Kernel::new(&root, &store)?;
    let directory = Directory::new(&root, &store)?;
    match command.as_str() {
        "index" => {
            let view = directory.inventory()?;
            let expected = kernel.generation(&view.scope)?;
            let generation = kernel.publish(view, expected)?;
            println!(
                "{}",
                json!({"generation":generation,"scope":directory.scope()})
            );
            Ok(())
        }
        "search" => {
            let (mode, query) = query_args.unwrap();
            let result = directory.search(&kernel, mode, query, limit)?;
            println!("{}", serde_json::to_string(&result).unwrap());
            Ok(())
        }
        "mcp" => stdio(|request| mcp(&kernel, &directory, request), false),
        _ => unreachable!(),
    }
}
/// Remove one exact flag/value; duplicate flags and missing values fail closed.
fn flag(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let Some(index) = args.iter().position(|s| s == name) else {
        return Ok(None);
    };
    args.remove(index);
    if index >= args.len() || args[index].starts_with("--") {
        return Err(error("invalid-request", "flag requires a value"));
    }
    let value = args.remove(index);
    if args.iter().any(|s| s == name) {
        return Err(error("invalid-request", "duplicate flag"));
    }
    Ok(Some(value))
}
/// Consume newline-delimited JSON with bounded frame storage and stdout reserved for replies.
fn stdio(mut handle: impl FnMut(Value) -> Option<Value>, local_service: bool) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    while let Some(frame) = frame(&mut input)? {
        cpu_limit()?;
        let reply = match frame.and_then(|b| {
            serde_json::from_slice::<Value>(&b)
                .map_err(|_| error("invalid-request", "invalid JSON frame"))
        }) {
            Ok(value) => handle(value),
            Err(e) => Some(if local_service {
                json!({"version":1,"id":null,"error":e})
            } else {
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":e.message}})
            }),
        };
        if let Some(reply) = reply {
            let bytes = serde_json::to_vec(&reply)
                .map_err(|_| error("io", "response serialization failed"))?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(error("resource-limited", "response byte budget exhausted"));
            }
            output
                .write_all(&bytes)
                .and_then(|_| output.write_all(b"\n"))
                .and_then(|_| output.flush())
                .map_err(|_| error("io", "stdio output failed"))?;
        }
    }
    Ok(())
}
/// An oversized frame is discarded through its LF without an unbounded line allocation.
fn frame(input: &mut impl BufRead) -> Result<Option<Result<Vec<u8>>>> {
    const MAX: usize = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let available = input
            .fill_buf()
            .map_err(|_| error("io", "stdio input failed"))?;
        if available.is_empty() {
            if bytes.is_empty() && !oversized {
                return Ok(None);
            }
            break;
        }
        let end = available
            .iter()
            .position(|&b| b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(available.len());
        let finished = available[end - 1] == b'\n';
        if bytes.len() + end > MAX {
            oversized = true;
            bytes.clear();
        }
        if !oversized {
            bytes.extend_from_slice(&available[..end]);
        }
        input.consume(end);
        if finished {
            break;
        }
    }
    Ok(Some(if oversized {
        Err(error("resource-limited", "stdio frame exceeds byte budget"))
    } else {
        Ok(bytes)
    }))
}

/// Versioned trusted-local request envelope. Unknown additive members are ignored.
#[derive(Deserialize)]
struct Request {
    version: u64,
    id: Value,
    #[serde(flatten)]
    operation: Operation,
}
/// Closed local operations; complete replacement inventories also express updates and removals.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Operation {
    Publish {
        view: ScopeView,
        #[serde(deserialize_with = "required_expected")]
        expected_generation: Option<String>,
    },
    Search {
        request: Query,
    },
    Inspect {
        scope: String,
    },
}
/// Project local requests into the same kernel used by CLI and MCP.
fn service(kernel: &Kernel, value: Value) -> Option<Value> {
    let id = value
        .get("id")
        .filter(|id| valid_id(id))
        .cloned()
        .unwrap_or(Value::Null);
    let result = (|| -> Result<Value> {
        let request: Request = serde_json::from_value(value)
            .map_err(|_| error("invalid-request", "invalid service envelope or operation"))?;
        if request.version != 1
            || !(request.id.is_number() || request.id.as_str().is_some_and(|s| s.len() <= 256))
        {
            return Err(error(
                "invalid-request",
                "unsupported service version or request id",
            ));
        }
        match request.operation {
            Operation::Publish {
                view,
                expected_generation,
            } => Ok(json!({"generation":kernel.publish(view, expected_generation)?})),
            Operation::Search { request } => serde_json::to_value(kernel.search(request)?)
                .map_err(|_| error("io", "response serialization failed")),
            Operation::Inspect { scope } => Ok(json!({"generation":kernel.generation(&scope)?})),
        }
    })();
    Some(match result {
        Ok(result) => json!({"version":1,"id":id,"result":result}),
        Err(error) => json!({"version":1,"id":id,"error":error}),
    })
}
/// MCP search arguments expose no path, scope, write, or index-preparation operation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
    mode: Mode,
    query: String,
    limit: usize,
}
/// The sole MCP tool projects the bound directory's admitted scope into the shared search path.
fn mcp(kernel: &Kernel, directory: &Directory, value: Value) -> Option<Value> {
    let id = value.get("id").filter(|id| valid_id(id)).cloned();
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    if id.is_none() && method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    let result = (|| -> Result<Value> {
        if value.get("jsonrpc") != Some(&json!("2.0")) {
            return Err(error("invalid-request", "MCP requires JSON-RPC 2.0"));
        }
        match method {
            "initialize" => {
                let requested = value
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&requested) {
                    requested
                } else {
                    "2025-06-18"
                };
                Ok(
                    json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"retrieval-kernel","version":env!("CARGO_PKG_VERSION")}}),
                )
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(
                json!({"tools":[{"name":"search","description":"Search the startup-bound directory's prepared index and current text or identity sidecars.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["lexical","exact","regex"]},"query":{"type":"string","minLength":1,"maxLength":4096},"limit":{"type":"integer","minimum":1,"maximum":1000}},"required":["mode","query","limit"],"additionalProperties":false}}]}),
            ),
            "tools/call" => {
                if value.pointer("/params/name").and_then(Value::as_str) != Some("search") {
                    return Err(error("invalid-request", "unknown MCP tool"));
                }
                let args: SearchArguments = serde_json::from_value(
                    value
                        .pointer("/params/arguments")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|_| {
                    error(
                        "invalid-request",
                        "invalid search arguments; root is fixed at startup",
                    )
                })?;
                let result = directory.search(kernel, args.mode, args.query, args.limit);
                match result {
                    Ok(result) => Ok(
                        json!({"content":[{"type":"text","text":serde_json::to_string(&result).unwrap()}],"isError":false}),
                    ),
                    Err(error) => Ok(
                        json!({"content":[{"type":"text","text":serde_json::to_string(&error).unwrap()}],"isError":true}),
                    ),
                }
            }
            _ => Err(error("method-not-found", "unknown MCP method")),
        }
    })();
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":if error.code == "method-not-found" {-32601} else {-32602},"message":error.message}})
        }
    })
}

/// A nullable expected generation is required, rather than silently defaulting to initial publication.
fn required_expected<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
/// Bound reflected request identifiers independently of input frames.
fn valid_id(value: &Value) -> bool {
    value.is_number() || value.as_str().is_some_and(|s| s.len() <= 256)
}
/// Enforce the executable's memory and individual derived-file ceilings before untrusted input.
fn process_limits() -> Result<()> {
    set_limit(libc::RLIMIT_AS, 2 * 1024 * 1024 * 1024)?;
    set_limit(libc::RLIMIT_FSIZE, 512 * 1024 * 1024)?;
    cpu_limit()
}
/// Give each foreground request 65 CPU seconds; the cooperative wall ceiling is 60 seconds.
fn cpu_limit() -> Result<()> {
    // SAFETY: getrusage initializes a correctly sized caller-owned structure.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return Err(error("unavailable", "CPU resource enforcement unavailable"));
    }
    set_limit(
        libc::RLIMIT_CPU,
        (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec).max(0) as u64 + 65,
    )
}
/// Preserve stricter inherited limits. Failure to install a limit is an explicit startup failure.
fn set_limit(resource: Resource, ceiling: u64) -> Result<()> {
    // SAFETY: getrlimit/setrlimit receive valid initialized resource structures.
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrlimit(resource, &mut limit) } != 0 {
        return Err(error("unavailable", "process resource limits unavailable"));
    }
    limit.rlim_cur = if resource == libc::RLIMIT_CPU {
        ceiling.min(limit.rlim_max)
    } else {
        ceiling.min(limit.rlim_cur).min(limit.rlim_max)
    };
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        return Err(error("unavailable", "process resource enforcement failed"));
    }
    Ok(())
}

/// libc uses different resource identifier types on Linux and other Unix targets.
#[cfg(target_os = "linux")]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(target_os = "linux"))]
type Resource = libc::c_int;
