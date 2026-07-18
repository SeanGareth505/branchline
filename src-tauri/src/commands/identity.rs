use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGitIdentityInput {
    pub name: String,
    pub email: String,
}

#[command]
pub fn get_git_identity() -> AppResult<GitIdentity> {
    let name = git_cli::config_get("user.name")?.unwrap_or_default();
    let email = git_cli::config_get("user.email")?.unwrap_or_default();
    Ok(GitIdentity { name, email })
}

#[command]
pub fn set_git_identity(input: SetGitIdentityInput) -> AppResult<GitIdentity> {
    git_cli::config_set("user.name", &input.name)?;
    git_cli::config_set("user.email", &input.email)?;
    Ok(GitIdentity {
        name: input.name,
        email: input.email,
    })
}
