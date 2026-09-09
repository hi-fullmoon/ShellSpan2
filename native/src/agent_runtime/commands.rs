use std::sync::Arc;

use crate::desktop::{AppHandle, Emitter, Manager, State};
use serde::Deserialize;

use crate::keychain::CredentialManager;

use super::{
    AgentArtifactRequest, AgentArtifactResponse, AgentChildInputRequest, AgentChildInspection,
    AgentChildRequest, AgentCommittedEventsRequest, AgentFleetControlRequest, AgentFleetInspection,
    AgentFleetPlanRequest, AgentFleetReconcileRequest, AgentInboxMutationInput,
    AgentRecoveryCheckpoint, AgentRecoveryReconcileInput, AgentRecoverySessionInput, AgentRuntime,
    AgentSessionEventPage, AgentSessionEventsRequest, AgentSessionListPage,
    AgentSessionListRequest, AgentSessionRenameInput, AgentSessionSnapshot,
    AgentSubagentSpawnRequest, AgentToolDecisionInput, CreateAgentSessionRequest,
};

pub(crate) const AGENT_RUNTIME_SESSION_EVENT: &str = "agent-runtime-session-event";

pub(crate) async fn agent_runtime_prepare_images(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    images: Vec<super::images::ImageUpload>,
) -> Result<Vec<super::images::ImageUpload>, String> {
    configure_runtime(&app, &runtime)?;
    runtime.prepare_images(images).await
}

pub(crate) async fn agent_runtime_submit_images(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImageSubmission,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.submit_images(input).await
}
pub(crate) fn agent_runtime_cancel_image_submission(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImageOperation,
) -> Result<bool, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel_image_submission(input)
}
pub(crate) async fn agent_runtime_image_preview(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::images::ImagePreviewRequest,
) -> Result<String, String> {
    configure_runtime(&app, &runtime)?;
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || runtime.image_preview(input))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn configure_runtime(app: &AppHandle, runtime: &AgentRuntime) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve Agent runtime root: {error}"))?;
    runtime.configure(root)?;
    runtime.configure_llm(
        app.state::<crate::llm::runtime::LlmRuntime>()
            .inner()
            .clone(),
    )?;
    runtime.configure_native(app.clone())?;
    let emitter = app.clone();
    runtime.set_event_publisher(Arc::new(move |event| {
        if let Err(error) = emitter.emit(AGENT_RUNTIME_SESSION_EVENT, event) {
            log::warn!("Failed to publish committed Agent Session event: {error}");
        }
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionInput {
    session_id: String,
    message_id: String,
    #[serde(default)]
    client_submission_id: Option<String>,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeStartInput {
    session_id: String,
    selection: crate::llm::routes::ModelSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeModelSelectionInput {
    session_id: String,
    selection: crate::llm::routes::ModelSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeInjectionInput {
    session_id: String,
    message_id: String,
    label: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionIdInput {
    session_id: String,
}

pub(crate) fn agent_runtime_create_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: CreateAgentSessionRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.create_session(request)
}

pub(crate) async fn agent_runtime_spawn_subagent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    request: AgentSubagentSpawnRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.spawn_subagent(request).await
}

pub(crate) async fn agent_runtime_send_child_input(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    request: AgentChildInputRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.send_child_input(request).await
}

pub(crate) fn agent_runtime_inspect_child_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentChildRequest,
) -> Result<AgentChildInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inspect_child_agent(request)
}

pub(crate) async fn agent_runtime_cancel_child_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentChildRequest,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel_child_agent(request).await
}

pub(crate) fn agent_runtime_fleet_plan(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetPlanRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.plan_fleet(request)
}

pub(crate) async fn agent_runtime_fleet_start(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.start_fleet(request).await
}

pub(crate) async fn agent_runtime_fleet_resume(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.start_fleet(request).await
}

pub(crate) fn agent_runtime_fleet_pause(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.pause_fleet(request)
}

pub(crate) async fn agent_runtime_fleet_abort(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetControlRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.abort_fleet(request).await
}

pub(crate) fn agent_runtime_fleet_reconcile(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentFleetReconcileRequest,
) -> Result<AgentFleetInspection, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reconcile_fleet(request)
}

pub(crate) fn agent_runtime_start(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    input: AgentRuntimeStartInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    let selected = runtime.session(&input.session_id)?.header.model_selection;
    let selection = selected
        .map(|s| crate::llm::routes::ModelSelection {
            route_id: s.route_id,
            model_id: s.model_id,
            reasoning_effort: s.reasoning_effort,
        })
        .unwrap_or(input.selection);
    let llm = app.state::<crate::llm::runtime::LlmRuntime>();
    let routes = llm.routes.snapshot()?;
    let route = routes.route(&selection.route_id)?;
    let provider = route.provider(&selection)?;
    let api_key = llm.routes.credential(route)?;
    runtime.start(&input.session_id, provider, api_key)
}

pub(crate) fn agent_runtime_select_model(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    _credentials: State<'_, CredentialManager>,
    input: AgentRuntimeModelSelectionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let llm = app.state::<crate::llm::runtime::LlmRuntime>();
    let snapshot = llm.routes.snapshot()?;
    let route = snapshot.route(&input.selection.route_id)?;
    let provider = route.provider(&input.selection)?;
    let api_key = llm.routes.credential(route)?;
    runtime.select_model(&input.session_id, provider, api_key)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPermissionInput {
    session_id: String,
    mode: super::AgentSessionPermissionMode,
}

pub(crate) fn agent_runtime_set_permission(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentPermissionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.set_permission_mode(&input.session_id, input.mode)
}

pub(crate) fn agent_runtime_answer_question(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    credentials: State<'_, CredentialManager>,
    input: super::user_questions::AnswerQuestionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.configure_credentials(credentials.inner().clone())?;
    runtime.answer_question(input, Some(credentials.inner()))
}

pub(crate) fn agent_runtime_followup(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let client_submission_id = input
        .client_submission_id
        .unwrap_or_else(|| input.message_id.clone());
    runtime.followup_submission(
        &input.session_id,
        input.message_id,
        client_submission_id,
        input.content,
    )
}

pub(crate) fn agent_runtime_steer(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    let client_submission_id = input
        .client_submission_id
        .unwrap_or_else(|| input.message_id.clone());
    runtime.steer_submission(
        &input.session_id,
        input.message_id,
        client_submission_id,
        input.content,
    )
}

pub(crate) fn agent_runtime_mutate_inbox(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentInboxMutationInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.mutate_inbox(input)
}

pub(crate) fn agent_runtime_rename_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionRenameInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.rename_session(input)
}

pub(crate) fn agent_runtime_inject(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRuntimeInjectionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inject(
        &input.session_id,
        input.message_id,
        input.label,
        input.content,
    )
}

pub(crate) async fn agent_runtime_interrupt(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.interrupt(&input.session_id).await
}

pub(crate) async fn agent_runtime_resume(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.resume(&input.session_id).await
}

pub(crate) async fn agent_runtime_cancel(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.cancel(&input.session_id).await
}

pub(crate) async fn agent_runtime_approve_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentToolDecisionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.approve_tool(input).await
}

pub(crate) async fn agent_runtime_reject_tool(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentToolDecisionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reject_tool(input).await
}

pub(crate) fn agent_runtime_get_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.session(&input.session_id)
}

pub(crate) fn agent_runtime_list_sessions(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionListRequest,
) -> Result<AgentSessionListPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.sessions(request)
}

pub(crate) fn agent_runtime_archive_session(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.archive_session(&input.session_id)
}

pub(crate) fn agent_runtime_get_events(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentSessionEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.events(request)
}

pub(crate) fn agent_runtime_get_committed_events(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentCommittedEventsRequest,
) -> Result<AgentSessionEventPage, String> {
    configure_runtime(&app, &runtime)?;
    runtime.committed_events(request)
}

pub(crate) fn agent_runtime_get_artifact(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: AgentArtifactRequest,
) -> Result<AgentArtifactResponse, String> {
    configure_runtime(&app, &runtime)?;
    runtime.artifact(request)
}

pub(crate) fn agent_runtime_inspect_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentRecoveryCheckpoint, String> {
    configure_runtime(&app, &runtime)?;
    runtime.inspect_recovery(&input.session_id)
}

pub(crate) async fn agent_runtime_resume_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.resume_recovery(&input.session_id).await
}

pub(crate) fn agent_runtime_reconcile_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoveryReconcileInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.reconcile_recovery(input)
}

pub(crate) async fn agent_runtime_abort_recovery(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentRecoverySessionInput,
) -> Result<AgentSessionSnapshot, String> {
    configure_runtime(&app, &runtime)?;
    runtime.abort_recovery(&input.session_id).await
}

pub(crate) async fn agent_runtime_list_skills(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentSessionIdInput,
) -> Result<super::skill_runtime::SkillUserList, String> {
    configure_runtime(&app, &runtime)?;
    runtime.list_skills(&input.session_id).await
}

pub(crate) async fn agent_runtime_list_file_references(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::file_references::FileReferenceInput,
) -> Result<super::file_references::FileReferenceList, String> {
    configure_runtime(&app, &runtime)?;
    runtime.file_references.list(input).await
}
pub(crate) fn agent_runtime_cancel_file_references(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: super::file_references::FileReferenceCancel,
) -> Result<(), String> {
    configure_runtime(&app, &runtime)?;
    runtime.file_references.cancel(input)
}

pub(crate) async fn __ipc_agent_runtime_prepare_images(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_prepare_images(
            app.clone(),
            app.state(),
            crate::host::argument::<Vec<super::images::ImageUpload>>(
                &args,
                "images",
                "agent_runtime_prepare_images",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_submit_images(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_submit_images(
            app.clone(),
            app.state(),
            crate::host::argument::<super::images::ImageSubmission>(
                &args,
                "input",
                "agent_runtime_submit_images",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_cancel_image_submission(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_cancel_image_submission(
            app.clone(),
            app.state(),
            crate::host::argument::<super::images::ImageOperation>(
                &args,
                "input",
                "agent_runtime_cancel_image_submission",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_image_preview(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_image_preview(
            app.clone(),
            app.state(),
            crate::host::argument::<super::images::ImagePreviewRequest>(
                &args,
                "input",
                "agent_runtime_image_preview",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_create_session(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_create_session(
            app.clone(),
            app.state(),
            crate::host::argument::<CreateAgentSessionRequest>(
                &args,
                "request",
                "agent_runtime_create_session",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_spawn_subagent(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_spawn_subagent(
            app.clone(),
            app.state(),
            app.state(),
            crate::host::argument::<AgentSubagentSpawnRequest>(
                &args,
                "request",
                "agent_runtime_spawn_subagent",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_send_child_input(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_send_child_input(
            app.clone(),
            app.state(),
            app.state(),
            crate::host::argument::<AgentChildInputRequest>(
                &args,
                "request",
                "agent_runtime_send_child_input",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_inspect_child_agent(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_inspect_child_agent(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentChildRequest>(
                &args,
                "request",
                "agent_runtime_inspect_child_agent",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_cancel_child_agent(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_cancel_child_agent(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentChildRequest>(
                &args,
                "request",
                "agent_runtime_cancel_child_agent",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_plan(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_plan(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetPlanRequest>(
                &args,
                "request",
                "agent_runtime_fleet_plan",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_start(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_start(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetControlRequest>(
                &args,
                "request",
                "agent_runtime_fleet_start",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_resume(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_resume(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetControlRequest>(
                &args,
                "request",
                "agent_runtime_fleet_resume",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_pause(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_pause(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetControlRequest>(
                &args,
                "request",
                "agent_runtime_fleet_pause",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_abort(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_abort(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetControlRequest>(
                &args,
                "request",
                "agent_runtime_fleet_abort",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_fleet_reconcile(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_fleet_reconcile(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentFleetReconcileRequest>(
                &args,
                "request",
                "agent_runtime_fleet_reconcile",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_start(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_start(
            app.clone(),
            app.state(),
            app.state(),
            crate::host::argument::<AgentRuntimeStartInput>(&args, "input", "agent_runtime_start")?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_select_model(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_select_model(
            app.clone(),
            app.state(),
            app.state(),
            crate::host::argument::<AgentRuntimeModelSelectionInput>(
                &args,
                "input",
                "agent_runtime_select_model",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_set_permission(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_set_permission(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentPermissionInput>(
                &args,
                "input",
                "agent_runtime_set_permission",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_answer_question(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_answer_question(
            app.clone(),
            app.state(),
            app.state(),
            crate::host::argument::<super::user_questions::AnswerQuestionInput>(
                &args,
                "input",
                "agent_runtime_answer_question",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_followup(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_followup(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionInput>(&args, "input", "agent_runtime_followup")?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_steer(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_steer(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionInput>(&args, "input", "agent_runtime_steer")?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_mutate_inbox(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_mutate_inbox(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentInboxMutationInput>(
                &args,
                "input",
                "agent_runtime_mutate_inbox",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_rename_session(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_rename_session(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionRenameInput>(
                &args,
                "input",
                "agent_runtime_rename_session",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_inject(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_inject(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentRuntimeInjectionInput>(
                &args,
                "input",
                "agent_runtime_inject",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_interrupt(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_interrupt(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(
                &args,
                "input",
                "agent_runtime_interrupt",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_resume(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_resume(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(&args, "input", "agent_runtime_resume")?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_cancel(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_cancel(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(&args, "input", "agent_runtime_cancel")?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_approve_tool(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_approve_tool(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentToolDecisionInput>(
                &args,
                "input",
                "agent_runtime_approve_tool",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_reject_tool(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_reject_tool(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentToolDecisionInput>(
                &args,
                "input",
                "agent_runtime_reject_tool",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_get_session(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_get_session(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(
                &args,
                "input",
                "agent_runtime_get_session",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_list_sessions(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_list_sessions(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionListRequest>(
                &args,
                "request",
                "agent_runtime_list_sessions",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_archive_session(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_archive_session(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(
                &args,
                "input",
                "agent_runtime_archive_session",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_get_events(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_get_events(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionEventsRequest>(
                &args,
                "request",
                "agent_runtime_get_events",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_get_committed_events(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_get_committed_events(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentCommittedEventsRequest>(
                &args,
                "request",
                "agent_runtime_get_committed_events",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_get_artifact(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_get_artifact(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentArtifactRequest>(
                &args,
                "request",
                "agent_runtime_get_artifact",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_inspect_recovery(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_inspect_recovery(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentRecoverySessionInput>(
                &args,
                "input",
                "agent_runtime_inspect_recovery",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_resume_recovery(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_resume_recovery(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentRecoverySessionInput>(
                &args,
                "input",
                "agent_runtime_resume_recovery",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_reconcile_recovery(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_reconcile_recovery(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentRecoveryReconcileInput>(
                &args,
                "input",
                "agent_runtime_reconcile_recovery",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_abort_recovery(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_abort_recovery(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentRecoverySessionInput>(
                &args,
                "input",
                "agent_runtime_abort_recovery",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_list_skills(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_list_skills(
            app.clone(),
            app.state(),
            crate::host::argument::<AgentSessionIdInput>(
                &args,
                "input",
                "agent_runtime_list_skills",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_list_file_references(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_list_file_references(
            app.clone(),
            app.state(),
            crate::host::argument::<super::file_references::FileReferenceInput>(
                &args,
                "input",
                "agent_runtime_list_file_references",
            )?,
        )
        .await
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}

pub(crate) async fn __ipc_agent_runtime_cancel_file_references(
    app: crate::desktop::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    use crate::desktop::Manager;
    let _ = (&app, &args);
    serde_json::to_value(
        agent_runtime_cancel_file_references(
            app.clone(),
            app.state(),
            crate::host::argument::<super::file_references::FileReferenceCancel>(
                &args,
                "input",
                "agent_runtime_cancel_file_references",
            )?,
        )
        .map_err(crate::host::serialize_error)?,
    )
    .map_err(|error| serde_json::json!(error.to_string()))
}
