//! Framework-independent state and event boundary shared by native services.
use serde::Serialize;
use std::{
    any::{Any, TypeId},
    collections::HashMap,
    ops::Deref,
    path::PathBuf,
    sync::Arc,
};

#[derive(Clone)]
pub(crate) struct AppHandle {
    states: Arc<HashMap<TypeId, Box<dyn Any + Send + Sync>>>,
    output: crossbeam_channel::Sender<serde_json::Value>,
    terminal: Option<crossbeam_channel::Sender<TerminalRecord>>,
    workers: Arc<std::sync::atomic::AtomicUsize>,
}
pub(crate) struct State<'a, T>(&'a T);
impl<T> Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
impl<'a, T> State<'a, T> {
    pub fn inner(&self) -> &'a T {
        self.0
    }
}
pub(crate) trait Manager {
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T>;
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>>;
}
impl Manager for AppHandle {
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state().expect("native state not initialized")
    }
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        self.states
            .get(&TypeId::of::<T>())
            .and_then(|v| v.downcast_ref())
            .map(State)
    }
}
pub(crate) trait Emitter {
    fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), String>;
}
pub(crate) enum TerminalRecord {
    Event(serde_json::Value),
    Flush(crossbeam_channel::Sender<()>),
}
pub(crate) struct TerminalWorker(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for TerminalWorker {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
fn is_terminal_event(event: &str) -> bool {
    event.starts_with("ssh-data:")
        || matches!(event, "ssh-status" | "ssh-closed" | "ssh-session-error")
}
impl Emitter for AppHandle {
    fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), String> {
        let value = serde_json::json!({"type":"event","event":event,"payload":payload});
        if let Some(terminal) = self.terminal.as_ref().filter(|_| is_terminal_event(event)) {
            terminal
                .send(TerminalRecord::Event(value))
                .map_err(|e| e.to_string())
        } else {
            self.output.send(value).map_err(|e| e.to_string())
        }
    }
}
impl AppHandle {
    pub fn new(output: crossbeam_channel::Sender<serde_json::Value>) -> Self {
        Self {
            states: Arc::new(HashMap::new()),
            output,
            terminal: None,
            workers: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
    pub fn with_terminal(mut self, terminal: crossbeam_channel::Sender<TerminalRecord>) -> Self {
        self.terminal = Some(terminal);
        self
    }
    pub fn terminal_worker(&self) -> TerminalWorker {
        self.workers
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        TerminalWorker(self.workers.clone())
    }
    pub fn drain_terminals(&self, timeout: std::time::Duration) -> Result<(), String> {
        let deadline = std::time::Instant::now() + timeout;
        while self.workers.load(std::sync::atomic::Ordering::SeqCst) != 0 {
            if std::time::Instant::now() >= deadline {
                return Err("terminal workers did not finish".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if let Some(terminal) = &self.terminal {
            let (ack, rx) = crossbeam_channel::bounded(1);
            terminal
                .send_deadline(TerminalRecord::Flush(ack), deadline)
                .map_err(|e| e.to_string())?;
            rx.recv_deadline(deadline).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    /// Full means the caller retains its text and stops reading the PTY/socket,
    /// while continuing to service input, resize and close commands.
    pub fn try_emit_terminal(&self, session_id: &str, text: &str) -> Result<bool, String> {
        let event = format!("ssh-data:{session_id}");
        let value = serde_json::json!({"type":"event","event":event,"payload":text});
        if let Some(terminal) = &self.terminal {
            match terminal.try_send(TerminalRecord::Event(value)) {
                Ok(()) => Ok(true),
                Err(crossbeam_channel::TrySendError::Full(_)) => Ok(false),
                Err(error) => Err(error.to_string()),
            }
        } else {
            match self.output.try_send(value) {
                Ok(()) => Ok(true),
                Err(crossbeam_channel::TrySendError::Full(_)) => Ok(false),
                Err(error) => Err(error.to_string()),
            }
        }
    }

    pub fn manage<T: Send + Sync + 'static>(&mut self, value: T) {
        Arc::get_mut(&mut self.states)
            .expect("register state before cloning context")
            .insert(TypeId::of::<T>(), Box::new(value));
    }
    pub fn path(&self) -> Paths {
        Paths
    }
    pub fn package_info(&self) -> PackageInfo {
        PackageInfo {
            version: env!("CARGO_PKG_VERSION"),
        }
    }
    pub fn exit(&self, code: i32) {
        let _ = self.emit("desktop-exit", code);
    }
    pub fn request_restart(&self) {
        let _ = self.emit("desktop-restart", ());
    }
}
pub(crate) struct PackageInfo {
    pub version: &'static str,
}
pub(crate) struct Paths;
impl Paths {
    fn env(name: &str) -> Result<PathBuf, String> {
        std::env::var_os(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("missing desktop path: {name}"))
    }
    pub fn home_dir(&self) -> Result<PathBuf, String> {
        Self::env("SHELLSPAN_HOME")
            .or_else(|_| Self::env(if cfg!(windows) { "USERPROFILE" } else { "HOME" }))
    }
    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        Self::env("SHELLSPAN_APP_DATA")
    }
    pub fn app_log_dir(&self) -> Result<PathBuf, String> {
        Self::env("SHELLSPAN_LOG_DIR")
    }
}

/// External launchers must never read or write the core's RPC streams.
/// Keep diagnostics on stderr and reap the short-lived launcher asynchronously.
pub(crate) fn spawn_external(command: &mut std::process::Command) -> std::io::Result<()> {
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A process-wide executor preserves the original native scheduling semantics,
/// including when a caller is inside a single-threaded test runtime.
pub(crate) mod async_runtime {
    use std::{future::Future, sync::LazyLock};
    static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("native worker runtime")
    });
    pub fn handle() -> tokio::runtime::Handle {
        RUNTIME.handle().clone()
    }
    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        RUNTIME.spawn(future)
    }
    pub fn spawn_blocking<F, R>(function: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        RUNTIME.spawn_blocking(function)
    }
}
