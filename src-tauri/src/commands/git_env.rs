use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEnvSnapshot {
    pub credential_helper: String,
    pub core_editor: String,
    pub diff_tool: String,
    pub merge_tool: String,
    pub ssh_keys_found: bool,
    pub ssh_key_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGitConfigInput {
    pub key: String,
    pub value: String,
}

const ALLOWED_CONFIG_KEYS: &[&str] = &[
    "credential.helper",
    "core.editor",
    "diff.tool",
    "merge.tool",
    "user.name",
    "user.email",
];

fn ssh_key_paths() -> Vec<String> {
    let mut paths = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return paths;
    };
    let ssh = home.join(".ssh");
    for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
        let path = ssh.join(name);
        if path.exists() {
            paths.push(path.to_string_lossy().to_string());
        }
    }
    paths
}

fn key_allowed(key: &str) -> bool {
    ALLOWED_CONFIG_KEYS
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(key))
}

#[command]
pub fn get_git_env() -> AppResult<GitEnvSnapshot> {
    let keys = ssh_key_paths();
    Ok(GitEnvSnapshot {
        credential_helper: git_cli::config_get("credential.helper")?.unwrap_or_default(),
        core_editor: git_cli::config_get("core.editor")?.unwrap_or_default(),
        diff_tool: git_cli::config_get("diff.tool")?.unwrap_or_default(),
        merge_tool: git_cli::config_get("merge.tool")?.unwrap_or_default(),
        ssh_keys_found: !keys.is_empty(),
        ssh_key_paths: keys,
    })
}

#[command]
pub fn set_git_config(input: SetGitConfigInput) -> AppResult<GitEnvSnapshot> {
    let key = input.key.trim();
    let value = input.value.trim();
    if key.is_empty() {
        return get_git_env();
    }
    if !key_allowed(key) {
        return Err(crate::AppError::msg(format!(
            "Git config key '{key}' is not writable from Branchline. Allowed: {}",
            ALLOWED_CONFIG_KEYS.join(", ")
        )));
    }
    if value.is_empty() {
        let _ = git_cli::run_git_global(&["config", "--global", "--unset", key]);
    } else {
        git_cli::config_set(key, value)?;
    }
    get_git_env()
}
