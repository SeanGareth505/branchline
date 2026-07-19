pub mod advanced;
pub mod branch;
pub mod cherry_pick;
pub mod commit;
pub mod diff;
pub mod git_detect;
pub mod git_env;
pub mod github_auth;
pub mod hosts;
pub mod identity;
pub mod jira;
pub mod ignore;
pub mod locks;
pub mod log;
pub mod merge;
pub mod onboarding;
pub mod rebase;
pub mod remotes;
pub mod repos;
pub mod safety;
pub mod settings;
pub mod stage;
pub mod stash;
pub mod status;
pub mod tags;
pub mod undo;
pub mod workflows;
pub mod worktrees;

use crate::infrastructure::mock_providers;
use crate::AppResult;
use tauri::command;

#[command]
pub fn list_mock_pull_requests() -> AppResult<Vec<mock_providers::MockPullRequest>> {
    Ok(mock_providers::list_mock_pull_requests())
}

#[command]
pub fn list_mock_jira_issues() -> AppResult<Vec<mock_providers::MockJiraIssue>> {
    Ok(mock_providers::list_mock_jira_issues())
}

#[command]
pub fn list_profiles() -> AppResult<Vec<mock_providers::ProfileInfo>> {
    Ok(mock_providers::list_profiles())
}

#[command]
pub fn list_templates() -> AppResult<Vec<mock_providers::TemplateInfo>> {
    Ok(mock_providers::list_templates())
}
