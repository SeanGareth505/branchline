mod commands;
mod domain;
mod error;
mod infrastructure;
mod state;

pub use error::{AppError, AppResult};
pub use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new().expect("failed to initialize Branchline app state");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git_detect::detect_git,
            commands::identity::get_git_identity,
            commands::identity::set_git_identity,
            commands::onboarding::get_onboarding_status,
            commands::onboarding::complete_onboarding,
            commands::onboarding::skip_onboarding,
            commands::repos::list_recent_repos,
            commands::repos::add_recent_repo,
            commands::repos::remove_recent_repo,
            commands::repos::pin_repo,
            commands::repos::set_last_repo,
            commands::repos::open_repository,
            commands::status::get_repo_status,
            commands::log::get_commit_log,
            commands::log::get_commit_range,
            commands::log::get_artificial_commits,
            commands::log::get_file_blame,
            commands::log::get_file_history,
            commands::diff::get_diff,
            commands::stage::stage_paths,
            commands::stage::unstage_paths,
            commands::stage::discard_paths,
            commands::stage::apply_patch,
            commands::commit::create_commit,
            commands::branch::list_branches,
            commands::branch::create_branch,
            commands::branch::checkout_branch,
            commands::branch::delete_branch,
            commands::branch::rename_branch,
            commands::branch::fetch,
            commands::branch::pull,
            commands::branch::push,
            commands::locks::list_branch_locks,
            commands::locks::lock_branch,
            commands::locks::unlock_branch,
            commands::repos::clone_repository,
            commands::repos::init_repository,
            commands::stash::list_stashes,
            commands::stash::stash_push,
            commands::stash::stash_pop,
            commands::stash::stash_apply,
            commands::stash::stash_drop,
            commands::merge::merge_branch,
            commands::merge::rebase_onto,
            commands::merge::abort_operation,
            commands::merge::continue_operation,
            commands::merge::reset_to,
            commands::rebase::preview_interactive_rebase,
            commands::rebase::start_interactive_rebase,
            commands::worktrees::list_worktrees,
            commands::worktrees::add_worktree,
            commands::worktrees::remove_worktree,
            commands::worktrees::prune_worktrees,
            commands::ignore::get_ignore_file,
            commands::ignore::save_ignore_file,
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::remotes::list_remotes,
            commands::remotes::add_remote,
            commands::remotes::remove_remote,
            commands::remotes::pull_with_options,
            commands::advanced::list_reflog,
            commands::advanced::squash_commits,
            commands::advanced::run_git_command,
            commands::cherry_pick::cherry_pick_preview,
            commands::cherry_pick::cherry_pick,
            commands::cherry_pick::revert_commit,
            commands::safety::analyze_safety,
            commands::safety::execute_safe_action,
            commands::undo::undo_last,
            commands::undo::list_undo_journal,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::hosts::list_host_repositories,
            commands::hosts::publish_to_github,
            commands::github_auth::github_device_login_start,
            commands::github_auth::github_device_login_poll,
            commands::jira::list_jira_issues,
            commands::jira::list_jira_transitions,
            commands::jira::transition_jira_issue,
            commands::git_env::get_git_env,
            commands::git_env::set_git_config,
            commands::ssh_setup::get_ssh_setup,
            commands::ssh_setup::generate_ssh_key,
            commands::list_mock_pull_requests,
            commands::list_mock_jira_issues,
            commands::list_profiles,
            commands::workflows::list_workflows,
            commands::workflows::save_workflow,
            commands::workflows::delete_workflow,
            commands::workflows::set_workflow_enabled,
            commands::list_templates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
