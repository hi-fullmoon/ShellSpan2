//! Private length-prefixed stdio protocol. Stdout is exclusively protocol data.
use crate::desktop::{AppHandle, Manager, TerminalRecord};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
#[path = "dispatch.rs"]
mod dispatch;
const MAX_FRAME: usize = 64 * 1024 * 1024;
pub(crate) fn serialize_error(error: impl Serialize) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| json!("error serialization failed"))
}
#[path = "arguments.rs"]
mod arguments;
pub(crate) use arguments::argument;
fn read_frame(reader: &mut impl Read) -> std::io::Result<Option<Value>> {
    let mut header = [0; 4];
    match reader.read(&mut header[..1])? {
        0 => return Ok(None),
        _ => reader.read_exact(&mut header[1..])?,
    }
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid frame length",
        ));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
fn write_frame(writer: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}
static DROPPED_LOGS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct Logger(crossbeam_channel::Sender<Value>);
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Debug
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata())
            && self.0.try_send(json!({"type":"log","level":r.level().to_string().to_lowercase(),"message":format!("{}",r.args()),"target":r.target()})).is_err()
        {
            DROPPED_LOGS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    fn flush(&self) {}
}
pub(crate) async fn run() -> Result<(), String> {
    let (output, rx) = crossbeam_channel::bounded::<Value>(256);
    let writer = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        for value in rx {
            if write_frame(&mut stdout, &value).is_err() {
                std::process::exit(1);
            }
        }
    });
    // A separate inherited/private pipe carries terminal events. Stdout stays
    // available for control responses; arbitrary stderr diagnostics cannot alter
    // terminal frame boundaries.
    let (terminal, terminal_rx) = crossbeam_channel::bounded::<TerminalRecord>(32);
    let (logs, logs_rx) = crossbeam_channel::bounded::<Value>(256);
    let terminal_path = std::env::var("SHELLSPAN_TERMINAL_PIPE").ok();
    let terminal_output = output.clone();
    #[cfg(unix)]
    let pipe = terminal_path.map(|path| {
        std::os::unix::net::UnixStream::connect(path)
            .map(|pipe| Box::new(pipe) as Box<dyn Write + Send>)
    });
    #[cfg(windows)]
    let pipe = terminal_path.map(|path| {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map(|pipe| Box::new(pipe) as Box<dyn Write + Send>)
    });
    let dedicated_terminal = pipe.is_some();
    std::thread::spawn(move || {
        match pipe {
            Some(Ok(mut pipe)) => {
                let mut sequence = 0_u64;
                for value in terminal_rx {
                    match value {
                        TerminalRecord::Event(mut value) => {
                            sequence += 1;
                            value["terminalSeq"] = json!(sequence);
                            if write_frame(&mut pipe, &value).is_err() {
                                break;
                            }
                        }
                        TerminalRecord::Flush(ack) => {
                            let _ = ack.send(());
                        }
                    }
                }
            }
            Some(Err(error)) => {
                log::error!("terminal pipe unavailable: {error}");
                std::process::exit(1);
            }
            // Standalone protocol probes retain the original stdout contract.
            None => {
                for value in terminal_rx {
                    match value {
                        TerminalRecord::Event(value) => {
                            if terminal_output.send(value).is_err() {
                                break;
                            }
                        }
                        TerminalRecord::Flush(ack) => {
                            let _ = ack.send(());
                        }
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        for value in logs_rx {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.push(b'\n');
            let mut stderr = std::io::stderr().lock();
            if stderr
                .write_all(&bytes)
                .and_then(|_| stderr.flush())
                .is_err()
            {
                break;
            }
            let dropped = DROPPED_LOGS.swap(0, std::sync::atomic::Ordering::Relaxed);
            if dropped > 0 {
                let warning = json!({"type":"log","level":"warn","message":format!("native diagnostic queue full: {dropped} records omitted")});
                let _ = writeln!(stderr, "{warning}");
            }
        }
    });
    let logger = Box::leak(Box::new(Logger(logs)));
    log::set_logger(logger).map_err(|e| e.to_string())?;
    // A panic hook must not synchronously wait on a stopped diagnostic reader
    // before catch_unwind can produce the command's error envelope.
    std::panic::set_hook(Box::new(|info| log::error!("native command panic: {info}")));
    log::set_max_level(if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
    let mut app = AppHandle::new(output.clone()).with_terminal(terminal);
    let startup_output = output.clone();
    let mut last_progress = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut sequence: u64 = 0;
    crate::data_migration::with_progress(
        move || {
            if last_progress.elapsed() >= std::time::Duration::from_secs(1) {
                sequence += 1;
                let _ = startup_output.send(json!({"type":"initializing","protocol":1,"phase":"migration","sequence":sequence}));
                last_progress = std::time::Instant::now();
            }
        },
        || crate::initialize(&mut app),
    )?;
    output
        .send(json!({"type":"ready","protocol":1,"terminalChannel":dedicated_terminal,"version":env!("CARGO_PKG_VERSION")}))
        .map_err(|e| e.to_string())?;
    let (input, mut requests) = tokio::sync::mpsc::channel(256);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            match read_frame(&mut stdin) {
                Ok(Some(v)) => {
                    if input.blocking_send(v).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    log::error!("invalid native request: {e}");
                    break;
                }
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(request) = requests.recv().await {
        if request.get("type").and_then(Value::as_str) == Some("shutdown") {
            break;
        }
        let id = request.get("id").cloned().ok_or("missing request id")?;
        let command = request
            .get("command")
            .and_then(Value::as_str)
            .ok_or("missing command")?
            .to_string();
        let args = request.get("args").cloned().unwrap_or(json!({}));
        let migration_read = request.get("type").and_then(Value::as_str) == Some("migration-read");
        let validate_only = request.get("type").and_then(Value::as_str) == Some("validate");
        let app = app.clone();
        let output = output.clone();
        let runtime = tokio::runtime::Handle::current();
        tasks.spawn_blocking(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if migration_read {
                    use crate::desktop::Manager;
                    let key = args
                        .get("key")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Value::String("Invalid migration key".into()))?;
                    let offset = args
                        .get("offset")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| Value::String("Invalid migration offset".into()))?;
                    app.state::<crate::db::Database>()
                        .migration_read(key, offset)
                        .map_err(Value::String)
                } else if validate_only {
                    arguments::validate_desktop(&command, &args)
                } else {
                    runtime.block_on(dispatch::dispatch(app, &command, args))
                }
            }));
            let response = match result {
                Ok(Ok(value)) => json!({"type":"response","id":id,"ok":true,"value":value}),
                Ok(Err(error)) => json!({"type":"response","id":id,"ok":false,"error":error}),
                Err(_) => {
                    json!({"type":"response","id":id,"ok":false,"error":"native command panicked"})
                }
            };
            let _ = output.send(response);
        });
        while tasks.try_join_next().is_some() {}
    }
    // Cleanup and event sends can block behind a stalled stdout consumer. Once
    // the parent closes input, no worker may keep this private core alive forever.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(5));
        log::error!("native shutdown deadline exceeded");
        std::process::exit(1);
    });
    if let Some(sessions) = app.try_state::<crate::SessionManager>() {
        sessions.close_all();
    }
    if let Some(forwards) = app.try_state::<crate::port_forward::PortForwardManager>() {
        let _ = forwards.cancel_all();
    }
    if let (Some(runtime), Some(sessions)) = (
        app.try_state::<crate::agent_runtime::AgentRuntime>(),
        app.try_state::<crate::SessionManager>(),
    ) {
        let _ = runtime.prepare_for_shutdown(&sessions);
    }
    app.drain_terminals(std::time::Duration::from_secs(3))?;
    let _ = output.send(json!({"type":"stopped"}));
    // Exit is controlled by the parent after the flushed stopped frame. Workers may
    // still own the event sink; dropping the main sender alone cannot end them.
    drop(writer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_roundtrip_and_concatenate() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({"text":"汉\n字"})).unwrap();
        write_frame(&mut bytes, &json!([1, 2])).unwrap();
        let mut input = &bytes[..];
        assert_eq!(
            read_frame(&mut input).unwrap(),
            Some(json!({"text":"汉\n字"}))
        );
        assert_eq!(read_frame(&mut input).unwrap(), Some(json!([1, 2])));
        assert_eq!(read_frame(&mut input).unwrap(), None);
    }
    #[test]
    fn rejects_invalid_and_truncated_frames() {
        assert!(read_frame(&mut &[0, 0, 0, 0][..]).is_err());
        assert!(read_frame(&mut &[0, 0, 0, 5, b'{'][..]).is_err());
        assert!(read_frame(&mut &[255, 255, 255, 255][..]).is_err());
    }
    #[test]
    fn nested_baseline_inputs_use_serde_without_business_side_effects() {
        use crate::models::{SessionCreateRequest, UploadLocalPathsRequest};
        let base = json!({"name":"local","host":"","port":22,"username":"",
            "authMethod":"password","terminalCols":80,"terminalRows":24});
        let request: SessionCreateRequest =
            argument(&json!({"request":base}), "request", "probe").unwrap();
        assert_eq!(request.password, None);
        for (key, value) in [
            ("port", json!(65536)),
            ("terminalCols", json!(-1)),
            ("authMethod", json!("unknown")),
            ("jumpHost", json!({"port":"22"})),
        ] {
            let mut invalid = base.clone();
            invalid[key] = value;
            assert!(argument::<SessionCreateRequest>(
                &json!({"request":invalid}),
                "request",
                "probe"
            )
            .is_err());
        }
        let mut upload = base.clone();
        upload["localPaths"] = json!(["/tmp/a"]);
        upload["destinationDirectory"] = json!(".");
        upload["operationId"] = json!("op");
        assert!(argument::<UploadLocalPathsRequest>(
            &json!({"request":upload}),
            "request",
            "probe"
        )
        .is_ok());
        upload["localPaths"] = json!([{"path":"/tmp/a"}]);
        assert!(argument::<UploadLocalPathsRequest>(
            &json!({"request":upload}),
            "request",
            "probe"
        )
        .is_err());
        assert!(argument::<Vec<(String, String)>>(
            &json!({"entries":[["k", "v"]]}),
            "entries",
            "probe"
        )
        .is_ok());
        assert!(argument::<Vec<(String, String)>>(
            &json!({"entries":[["k", 1]]}),
            "entries",
            "probe"
        )
        .is_err());
    }

    #[test]
    fn arguments_preserve_missing_optional_and_structured_errors() {
        assert_eq!(
            argument::<Option<String>>(&json!({}), "x", "probe").unwrap(),
            None
        );
        assert!(argument::<String>(&json!({}), "x", "probe").is_err());
        assert_eq!(
            serialize_error(json!({"type":"Other","payload":{"message":"x"}})),
            json!({"type":"Other","payload":{"message":"x"}})
        );
    }
}
