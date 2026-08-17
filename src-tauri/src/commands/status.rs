use crate::infrastructure::git2_repo::{self, RepoStatus};
use crate::infrastructure::git_cli;
use crate::{run_blocking, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatusInput {
    pub path: String,
    #[serde(default)]
    pub hide_untracked: bool,
}

#[command]
pub async fn get_repo_status(input: RepoStatusInput) -> AppResult<RepoStatus> {
    run_blocking(move || {
        let path = PathBuf::from(&input.path);
        git_cli::with_repo_lock(&path, |resolved| {
            git2_repo::repo_status_with(resolved, input.hide_untracked)
        })
    })
    .await
}
