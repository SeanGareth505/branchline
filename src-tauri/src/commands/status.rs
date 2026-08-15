use crate::infrastructure::git2_repo::{self, RepoStatus};
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
        git2_repo::repo_status_with(&path, input.hide_untracked)
    })
    .await
}
