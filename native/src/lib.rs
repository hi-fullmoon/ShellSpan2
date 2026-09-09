#![allow(clippy::too_many_arguments)]
mod data_migration;
pub mod terminal_guard;

mod agent_runtime;
mod ai;
mod commands;
mod connection;
mod db;
mod desktop;
mod directory_request_registry;
mod execution;
mod health;
mod host;
mod identity_cache;
mod keychain;
mod known_hosts;
mod llm;
mod local_fs;
mod models;
mod path_utils;
mod petdex;
mod port_forward;
mod redaction;
mod remote_fs;
mod remote_health;
mod runbook;
mod session;
mod sftp_pool;

use crate::desktop::{AppHandle, Emitter, Manager};

use crate::sftp_pool::SftpPool;
use directory_request_registry::DirectoryRequestRegistry;
use models::{
    ClosedEvent, ClosedReasonKind, DeleteCancellationRegistry, PreflightCancellationRegistry,
};
use models::{
    DownloadCancellationRegistry, RemoteCopyCancellationRegistry,
    RemoteFileReadCancellationRegistry, RemoteHealthCancellationRegistry, SessionErrorEvent,
    SessionIdentity, SessionManager, SessionStatus, StatusEvent, UploadCancellationRegistry,
};

pub(crate) use connection::{
    summarize_remote_connection_request, summarize_session_request, validate_connection_fields,
};
pub(crate) use identity_cache::RemoteIdentityCache;
pub(crate) use local_fs::{
    copy_local_paths_blocking, paste_local_paths_blocking, read_local_file_blocking,
    rename_local_path_blocking, trash_local_paths_blocking,
};
pub(crate) use path_utils::{portable_local_path, posix_join, shellspan_data_dir};
pub(crate) use remote_fs::{
    copy_remote_path_blocking, copy_remote_to_remote_blocking, create_remote_entry_blocking,
    delete_remote_path_blocking, download_remote_paths_blocking, list_remote_directory_blocking,
    open_remote_file_blocking, read_remote_file_blocking, rename_remote_path_blocking,
    resolve_remote_entry_owners_blocking, update_remote_permissions_blocking,
    upload_local_paths_blocking, warm_remote_connection_blocking,
};
pub(crate) use session::{
    classify_closed_reason, is_transport_disconnect_message, run_ssh_session, session_wake_pair,
    SessionWakeSource,
};

pub(crate) const SSH_DATA_EVENT_PREFIX: &str = "ssh-data:";
pub(crate) const SSH_STATUS_EVENT: &str = "ssh-status";
pub(crate) const SSH_CLOSED_EVENT: &str = "ssh-closed";
pub(crate) const SSH_SESSION_ERROR_EVENT: &str = "ssh-session-error";
pub(crate) const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
pub(crate) const DELETE_PROGRESS_EVENT: &str = "delete-progress";
pub(crate) const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";
pub(crate) const REMOTE_COPY_PROGRESS_EVENT: &str = "remote-copy-progress";

pub(crate) fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: SessionStatus,
    message: Option<String>,
) -> Result<(), String> {
    let event = StatusEvent {
        session_id: session_id.to_string(),
        status,
        message,
    };
    if let Some(sessions) = app.try_state::<SessionManager>() {
        let _ = sessions.set_status(session_id, event.clone());
    }
    app.emit(SSH_STATUS_EVENT, event)
        .map_err(|error| format!("failed to emit status event: {error}"))
}

pub(crate) fn emit_data(app: &AppHandle, session_id: &str, chunk: String) -> Result<(), String> {
    if let Some(runtime) = app.try_state::<agent_runtime::AgentRuntime>() {
        runtime.observe_terminal_output(session_id, &chunk);
    }
    app.emit(&format!("{SSH_DATA_EVENT_PREFIX}{session_id}"), chunk)
        .map_err(|error| format!("failed to emit data event: {error}"))
}

/// On backpressure retain the chunk in its session instead of blocking controls.
pub(crate) fn try_flush_output(
    app: &AppHandle,
    session_id: &str,
    chunk: &mut String,
) -> Result<bool, String> {
    if chunk.is_empty() {
        return Ok(true);
    }
    if !app.try_emit_terminal(session_id, chunk)? {
        return Ok(false);
    }
    if let Some(runtime) = app.try_state::<agent_runtime::AgentRuntime>() {
        runtime.observe_terminal_output(session_id, chunk);
    }
    chunk.clear();
    Ok(true)
}

/// Incrementally decodes UTF-8 from `pending_bytes` into `output`. An
/// incomplete multi-byte sequence at the tail stays in `pending_bytes` for
/// the next call; invalid bytes are replaced with U+FFFD.
pub(crate) fn drain_decoded_output(pending_bytes: &mut Vec<u8>, output: &mut String) {
    loop {
        match std::str::from_utf8(pending_bytes) {
            Ok(text) => {
                output.push_str(text);
                pending_bytes.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                output.push_str(
                    std::str::from_utf8(&pending_bytes[..valid_up_to])
                        .expect("valid_up_to marks a valid UTF-8 prefix"),
                );
                match error.error_len() {
                    Some(invalid_len) => {
                        output.push('\u{FFFD}');
                        pending_bytes.drain(..valid_up_to + invalid_len);
                    }
                    None => {
                        pending_bytes.drain(..valid_up_to);
                        return;
                    }
                }
            }
        }
    }
}

/// Emits whatever decoded output remains when a session ends, lossy-decoding
/// any bytes still stuck in the incremental decode buffer. Emit failures are
/// logged and swallowed: the session is ending anyway, so a dead frontend
/// listener must not mask the real session result.
pub(crate) fn flush_pending_output(
    app: &AppHandle,
    session_id: &str,
    pending_bytes: &mut Vec<u8>,
    pending_output: &mut String,
) {
    if !pending_bytes.is_empty() {
        pending_output.push_str(&String::from_utf8_lossy(pending_bytes));
        pending_bytes.clear();
    }
    if !pending_output.is_empty() {
        if let Err(error) = emit_data(app, session_id, std::mem::take(pending_output)) {
            log::warn!("Failed to emit final session output session_id={session_id}: {error}");
        }
    }
}

pub(crate) fn emit_closed(
    app: &AppHandle,
    session_id: &str,
    identity: Option<SessionIdentity>,
    reason: Option<String>,
    reason_kind: ClosedReasonKind,
    retryable: bool,
) -> Result<(), String> {
    app.emit(
        SSH_CLOSED_EVENT,
        ClosedEvent {
            session_id: session_id.to_string(),
            identity,
            reason,
            reason_kind,
            retryable,
        },
    )
    .map_err(|error| format!("failed to emit closed event: {error}"))
}

pub(crate) fn emit_session_error(app: &AppHandle, event: SessionErrorEvent) -> Result<(), String> {
    app.emit(SSH_SESSION_ERROR_EVENT, event)
        .map_err(|error| format!("failed to emit session error event: {error}"))
}

pub fn run() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime
        .block_on(async { host::run().await })
        .unwrap_or_else(|error| {
            eprintln!("ShellSpan core failed: {error}");
            std::process::exit(1);
        });
    // Blocking requests cannot be aborted by JoinSet. Do not wait forever on EOF.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}

pub(crate) fn initialize(app: &mut AppHandle) -> Result<(), String> {
    let home_dir = app.path().home_dir()?;
    let shellspan_dir = shellspan_data_dir(&home_dir);
    let guard = data_migration::DataGuard::acquire(&shellspan_dir, &app.path().app_data_dir()?)?;
    guard.prepare()?;
    app.manage(guard);
    let database =
        db::Database::open(&shellspan_dir.join("shellspan.db")).map_err(|e| e.to_string())?;
    let credentials = keychain::CredentialManager::new();
    ai::migrate_inline_api_keys(&credentials, &database).map_err(|error| {
        format!("failed to migrate inline AI API keys to the system keychain: {error}")
    })?;
    app.manage(petdex::PetdexAdapter::new(home_dir));
    app.manage(credentials.clone());
    let routes = llm::routes::RouteStore::open(database.clone(), credentials.clone())?;
    app.manage(llm::runtime::LlmRuntime { routes });
    app.manage(database);
    app.manage(SessionManager::default());
    app.manage(agent_runtime::AgentRuntime::default());
    app.manage(UploadCancellationRegistry::default());
    app.manage(DeleteCancellationRegistry::default());
    app.manage(PreflightCancellationRegistry::default());
    app.manage(RemoteHealthCancellationRegistry::default());
    app.manage(execution::ExecutionCancellationRegistry::default());
    app.manage(DownloadCancellationRegistry::default());
    app.manage(RemoteCopyCancellationRegistry::default());
    app.manage(RemoteFileReadCancellationRegistry::default());
    app.manage(DirectoryRequestRegistry::default());
    app.manage(port_forward::PortForwardManager::default());
    app.manage(SftpPool::default());
    app.manage(RemoteIdentityCache::default());
    app.manage(health::HealthState::default());
    let runtime = app.state::<agent_runtime::AgentRuntime>();
    agent_runtime::configure_runtime(app, &runtime)?;
    runtime.configure_credentials(credentials)?;
    Ok(())
}

/// Offline recovery requires explicit paths, never a fallback to personal data.
pub fn restore_migration_backup() -> Result<(), String> {
    let home = std::env::var_os("SHELLSPAN_HOME").ok_or("SHELLSPAN_HOME is required")?;
    let app = std::env::var_os("SHELLSPAN_APP_DATA").ok_or("SHELLSPAN_APP_DATA is required")?;
    let data = shellspan_data_dir(std::path::Path::new(&home));
    data_migration::DataGuard::acquire(&data, std::path::Path::new(&app))?.restore()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_decoded_output_holds_split_multibyte_sequence() {
        let mut pending_bytes = Vec::new();
        let mut output = String::new();
        // U+6C49 (汉) is three bytes; feed it split across two drains.
        pending_bytes.extend_from_slice(&[0xE6, 0xB1]);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "");
        assert_eq!(pending_bytes, vec![0xE6, 0xB1]);

        pending_bytes.extend_from_slice(&[0x89, b'!']);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "汉!");
        assert!(pending_bytes.is_empty());
    }

    #[test]
    fn drain_decoded_output_replaces_invalid_bytes() {
        let mut pending_bytes = vec![b'a', 0xFF, b'b'];
        let mut output = String::new();
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "a\u{FFFD}b");
        assert!(pending_bytes.is_empty());
    }
}
