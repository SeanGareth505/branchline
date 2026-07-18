use crate::infrastructure::git2_repo::{self, RepoStatus};
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPathInput {
    pub path: String,
}

#[command]
pub fn get_repo_status(input: RepoPathInput) -> AppResult<RepoStatus> {
    let path = PathBuf::from(&input.path);
    git2_repo::repo_status(&path)
}
