pub(crate) async fn dispatch(
    app: crate::desktop::AppHandle,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    match command {
        "ai_list_routes" => crate::ai::__ipc_ai_list_routes(app, args).await,
        "ai_save_routes" => crate::ai::__ipc_ai_save_routes(app, args).await,
        "ai_list_route_models" => crate::ai::__ipc_ai_list_route_models(app, args).await,
        "ai_resolve_selection" => crate::ai::__ipc_ai_resolve_selection(app, args).await,
        "ai_convert_session_v4_to_v5" => {
            crate::ai::__ipc_ai_convert_session_v4_to_v5(app, args).await
        }
        "ai_list_session_migrations" => {
            crate::ai::__ipc_ai_list_session_migrations(app, args).await
        }
        "ai_list_models" => crate::ai::__ipc_ai_list_models(app, args).await,
        "ai_resolve_model" => crate::ai::__ipc_ai_resolve_model(app, args).await,
        "ai_model_declaration_template" => {
            crate::ai::__ipc_ai_model_declaration_template(app, args).await
        }
        "agent_runtime_create_session" => {
            crate::agent_runtime::__ipc_agent_runtime_create_session(app, args).await
        }
        "agent_runtime_start" => crate::agent_runtime::__ipc_agent_runtime_start(app, args).await,
        "agent_runtime_select_model" => {
            crate::agent_runtime::__ipc_agent_runtime_select_model(app, args).await
        }
        "agent_runtime_set_permission" => {
            crate::agent_runtime::__ipc_agent_runtime_set_permission(app, args).await
        }
        "agent_runtime_answer_question" => {
            crate::agent_runtime::__ipc_agent_runtime_answer_question(app, args).await
        }
        "agent_runtime_list_skills" => {
            crate::agent_runtime::__ipc_agent_runtime_list_skills(app, args).await
        }
        "agent_runtime_list_file_references" => {
            crate::agent_runtime::__ipc_agent_runtime_list_file_references(app, args).await
        }
        "agent_runtime_cancel_file_references" => {
            crate::agent_runtime::__ipc_agent_runtime_cancel_file_references(app, args).await
        }
        "agent_runtime_spawn_subagent" => {
            crate::agent_runtime::__ipc_agent_runtime_spawn_subagent(app, args).await
        }
        "agent_runtime_send_child_input" => {
            crate::agent_runtime::__ipc_agent_runtime_send_child_input(app, args).await
        }
        "agent_runtime_inspect_child_agent" => {
            crate::agent_runtime::__ipc_agent_runtime_inspect_child_agent(app, args).await
        }
        "agent_runtime_cancel_child_agent" => {
            crate::agent_runtime::__ipc_agent_runtime_cancel_child_agent(app, args).await
        }
        "agent_runtime_fleet_plan" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_plan(app, args).await
        }
        "agent_runtime_fleet_start" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_start(app, args).await
        }
        "agent_runtime_fleet_pause" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_pause(app, args).await
        }
        "agent_runtime_fleet_resume" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_resume(app, args).await
        }
        "agent_runtime_fleet_abort" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_abort(app, args).await
        }
        "agent_runtime_fleet_reconcile" => {
            crate::agent_runtime::__ipc_agent_runtime_fleet_reconcile(app, args).await
        }
        "agent_runtime_followup" => {
            crate::agent_runtime::__ipc_agent_runtime_followup(app, args).await
        }
        "agent_runtime_submit_images" => {
            crate::agent_runtime::__ipc_agent_runtime_submit_images(app, args).await
        }
        "agent_runtime_prepare_images" => {
            crate::agent_runtime::__ipc_agent_runtime_prepare_images(app, args).await
        }
        "agent_runtime_cancel_image_submission" => {
            crate::agent_runtime::__ipc_agent_runtime_cancel_image_submission(app, args).await
        }
        "agent_runtime_image_preview" => {
            crate::agent_runtime::__ipc_agent_runtime_image_preview(app, args).await
        }
        "agent_runtime_steer" => crate::agent_runtime::__ipc_agent_runtime_steer(app, args).await,
        "agent_runtime_mutate_inbox" => {
            crate::agent_runtime::__ipc_agent_runtime_mutate_inbox(app, args).await
        }
        "agent_runtime_rename_session" => {
            crate::agent_runtime::__ipc_agent_runtime_rename_session(app, args).await
        }
        "agent_runtime_inject" => crate::agent_runtime::__ipc_agent_runtime_inject(app, args).await,
        "agent_runtime_cancel" => crate::agent_runtime::__ipc_agent_runtime_cancel(app, args).await,
        "agent_runtime_interrupt" => {
            crate::agent_runtime::__ipc_agent_runtime_interrupt(app, args).await
        }
        "agent_runtime_resume" => crate::agent_runtime::__ipc_agent_runtime_resume(app, args).await,
        "agent_runtime_approve_tool" => {
            crate::agent_runtime::__ipc_agent_runtime_approve_tool(app, args).await
        }
        "agent_runtime_reject_tool" => {
            crate::agent_runtime::__ipc_agent_runtime_reject_tool(app, args).await
        }
        "agent_runtime_get_session" => {
            crate::agent_runtime::__ipc_agent_runtime_get_session(app, args).await
        }
        "agent_runtime_list_sessions" => {
            crate::agent_runtime::__ipc_agent_runtime_list_sessions(app, args).await
        }
        "agent_runtime_archive_session" => {
            crate::agent_runtime::__ipc_agent_runtime_archive_session(app, args).await
        }
        "agent_runtime_get_events" => {
            crate::agent_runtime::__ipc_agent_runtime_get_events(app, args).await
        }
        "agent_runtime_get_committed_events" => {
            crate::agent_runtime::__ipc_agent_runtime_get_committed_events(app, args).await
        }
        "agent_runtime_get_artifact" => {
            crate::agent_runtime::__ipc_agent_runtime_get_artifact(app, args).await
        }
        "agent_runtime_inspect_recovery" => {
            crate::agent_runtime::__ipc_agent_runtime_inspect_recovery(app, args).await
        }
        "agent_runtime_resume_recovery" => {
            crate::agent_runtime::__ipc_agent_runtime_resume_recovery(app, args).await
        }
        "agent_runtime_reconcile_recovery" => {
            crate::agent_runtime::__ipc_agent_runtime_reconcile_recovery(app, args).await
        }
        "agent_runtime_abort_recovery" => {
            crate::agent_runtime::__ipc_agent_runtime_abort_recovery(app, args).await
        }
        "petdex_set_enabled" => crate::petdex::__ipc_petdex_set_enabled(app, args).await,
        "petdex_get_status" => crate::petdex::__ipc_petdex_get_status(app, args).await,
        "petdex_test_connection" => crate::petdex::__ipc_petdex_test_connection(app, args).await,
        "create_session" => crate::commands::__ipc_create_session(app, args).await,
        "create_local_session" => crate::commands::__ipc_create_local_session(app, args).await,
        "write_session" => crate::commands::__ipc_write_session(app, args).await,
        "get_session_status" => crate::commands::__ipc_get_session_status(app, args).await,
        "mark_session_ready" => crate::commands::__ipc_mark_session_ready(app, args).await,
        "set_session_output_paused" => {
            crate::commands::__ipc_set_session_output_paused(app, args).await
        }
        "resize_session" => crate::commands::__ipc_resize_session(app, args).await,
        "close_session" => crate::commands::__ipc_close_session(app, args).await,
        "request_app_restart" => crate::commands::__ipc_request_app_restart(app, args).await,
        "request_app_exit" => crate::commands::__ipc_request_app_exit(app, args).await,
        "list_remote_directory" => crate::commands::__ipc_list_remote_directory(app, args).await,
        "supersede_remote_directory_request" => {
            crate::commands::__ipc_supersede_remote_directory_request(app, args).await
        }
        "resolve_remote_entry_owners" => {
            crate::commands::__ipc_resolve_remote_entry_owners(app, args).await
        }
        "warm_remote_connection" => crate::commands::__ipc_warm_remote_connection(app, args).await,
        "create_remote_entry" => crate::commands::__ipc_create_remote_entry(app, args).await,
        "rename_remote_path" => crate::commands::__ipc_rename_remote_path(app, args).await,
        "delete_remote_path" => crate::commands::__ipc_delete_remote_path(app, args).await,
        "copy_remote_path" => crate::commands::__ipc_copy_remote_path(app, args).await,
        "copy_remote_to_remote" => crate::commands::__ipc_copy_remote_to_remote(app, args).await,
        "cancel_remote_copy" => crate::commands::__ipc_cancel_remote_copy(app, args).await,
        "upload_local_paths" => crate::commands::__ipc_upload_local_paths(app, args).await,
        "copy_local_paths" => crate::commands::__ipc_copy_local_paths(app, args).await,
        "rename_local_path" => crate::commands::__ipc_rename_local_path(app, args).await,
        "paste_local_paths" => crate::commands::__ipc_paste_local_paths(app, args).await,
        "trash_local_paths" => crate::commands::__ipc_trash_local_paths(app, args).await,
        "cancel_upload" => crate::commands::__ipc_cancel_upload(app, args).await,
        "cancel_delete" => crate::commands::__ipc_cancel_delete(app, args).await,
        "download_remote_paths" => crate::commands::__ipc_download_remote_paths(app, args).await,
        "cancel_download" => crate::commands::__ipc_cancel_download(app, args).await,
        "disconnect_sftp" => crate::commands::__ipc_disconnect_sftp(app, args).await,
        "open_path" => crate::commands::__ipc_open_path(app, args).await,
        "open_remote_file" => crate::commands::__ipc_open_remote_file(app, args).await,
        "preview_local_file" => crate::commands::__ipc_preview_local_file(app, args).await,
        "preview_remote_file" => crate::commands::__ipc_preview_remote_file(app, args).await,
        "cancel_remote_file_read" => {
            crate::commands::__ipc_cancel_remote_file_read(app, args).await
        }
        "update_remote_permissions" => {
            crate::commands::__ipc_update_remote_permissions(app, args).await
        }
        "check_host_key" => crate::commands::__ipc_check_host_key(app, args).await,
        "preflight_connection" => crate::commands::__ipc_preflight_connection(app, args).await,
        "cancel_connection_preflight" => {
            crate::commands::__ipc_cancel_connection_preflight(app, args).await
        }
        "trust_host" => crate::commands::__ipc_trust_host(app, args).await,
        "list_known_hosts" => crate::commands::__ipc_list_known_hosts(app, args).await,
        "remove_known_host" => crate::commands::__ipc_remove_known_host(app, args).await,
        "list_log_files" => crate::commands::__ipc_list_log_files(app, args).await,
        "read_log_file" => crate::commands::__ipc_read_log_file(app, args).await,
        "list_local_directory" => crate::commands::__ipc_list_local_directory(app, args).await,
        "store_key_credential" => crate::commands::__ipc_store_key_credential(app, args).await,
        "list_key_credentials" => crate::commands::__ipc_list_key_credentials(app, args).await,
        "retrieve_key_credential" => {
            crate::commands::__ipc_retrieve_key_credential(app, args).await
        }
        "delete_key_credential" => crate::commands::__ipc_delete_key_credential(app, args).await,
        "store_profile_password" => crate::commands::__ipc_store_profile_password(app, args).await,
        "retrieve_profile_password" => {
            crate::commands::__ipc_retrieve_profile_password(app, args).await
        }
        "delete_profile_password" => {
            crate::commands::__ipc_delete_profile_password(app, args).await
        }
        "store_profile_secret" => crate::commands::__ipc_store_profile_secret(app, args).await,
        "retrieve_profile_secret" => {
            crate::commands::__ipc_retrieve_profile_secret(app, args).await
        }
        "delete_profile_secrets" => crate::commands::__ipc_delete_profile_secrets(app, args).await,
        "delete_profile_secret" => crate::commands::__ipc_delete_profile_secret(app, args).await,
        "read_text_file" => crate::commands::__ipc_read_text_file(app, args).await,
        "start_port_forward" => crate::commands::__ipc_start_port_forward(app, args).await,
        "stop_port_forward" => crate::commands::__ipc_stop_port_forward(app, args).await,
        "stop_all_port_forwards" => crate::commands::__ipc_stop_all_port_forwards(app, args).await,
        "list_port_forwards" => crate::commands::__ipc_list_port_forwards(app, args).await,
        "open_url" => crate::commands::__ipc_open_url(app, args).await,
        "list_profiles" => crate::commands::__ipc_list_profiles(app, args).await,
        "add_profile" => crate::commands::__ipc_add_profile(app, args).await,
        "update_profile" => crate::commands::__ipc_update_profile(app, args).await,
        "remove_profile" => crate::commands::__ipc_remove_profile(app, args).await,
        "load_preferences" => crate::commands::__ipc_load_preferences(app, args).await,
        "save_preferences" => crate::commands::__ipc_save_preferences(app, args).await,
        "list_recent_profiles" => crate::commands::__ipc_list_recent_profiles(app, args).await,
        "touch_recent_profile" => crate::commands::__ipc_touch_recent_profile(app, args).await,
        "remove_recent_profile" => crate::commands::__ipc_remove_recent_profile(app, args).await,
        "list_sftp_bookmarks" => crate::commands::__ipc_list_sftp_bookmarks(app, args).await,
        "add_sftp_bookmark" => crate::commands::__ipc_add_sftp_bookmark(app, args).await,
        "remove_sftp_bookmark" => crate::commands::__ipc_remove_sftp_bookmark(app, args).await,
        "load_terminal_workspace" => {
            crate::commands::__ipc_load_terminal_workspace(app, args).await
        }
        "save_terminal_workspace" => {
            crate::commands::__ipc_save_terminal_workspace(app, args).await
        }
        "clear_terminal_workspace" => {
            crate::commands::__ipc_clear_terminal_workspace(app, args).await
        }
        "load_sftp_workspace" => crate::commands::__ipc_load_sftp_workspace(app, args).await,
        "save_sftp_workspace" => crate::commands::__ipc_save_sftp_workspace(app, args).await,
        "clear_sftp_workspace" => crate::commands::__ipc_clear_sftp_workspace(app, args).await,
        "get_system_health" => crate::health::__ipc_get_system_health(app, args).await,
        "collect_remote_health_snapshot" => {
            crate::remote_health::__ipc_collect_remote_health_snapshot(app, args).await
        }
        "cancel_remote_health_snapshot" => {
            crate::remote_health::__ipc_cancel_remote_health_snapshot(app, args).await
        }
        _ => Err(serde_json::json!("unknown command")),
    }
}
