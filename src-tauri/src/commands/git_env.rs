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
    #[serde(default)]
    pub ssh_agent: bool,
    #[serde(default)]
    pub commit_gpgsign: bool,
    #[serde(default)]
    pub gpg_format: String,
    #[serde(default)]
    pub user_signing_key: String,
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

fn ssh_agent_present() -> bool {
    std::env::var_os("SSH_AUTH_SOCK").is_some_and(|v| !v.is_empty())
}

fn expand_ssh_path(raw: &str, home: &std::path::Path) -> std::path::PathBuf {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    if trimmed == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home.join(rest);
    }
    std::path::PathBuf::from(trimmed)
}

fn identity_file_values(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let key = parts.next().unwrap_or("");
        if !key.eq_ignore_ascii_case("identityfile") {
            continue;
        }
        let Some(value) = parts.next() else {
            continue;
        };
        let cleaned = value.trim_matches('"').trim_matches('\'').to_string();
        if !cleaned.is_empty() && !values.contains(&cleaned) {
            values.push(cleaned);
        }
    }
    values
}

fn identity_files_from_config(text: &str, home: &std::path::Path) -> Vec<String> {
    let mut paths = Vec::new();
    for value in identity_file_values(text) {
        let path = expand_ssh_path(&value, home);
        if path.is_file() {
            let value = path.to_string_lossy().to_string();
            if !paths.contains(&value) {
                paths.push(value);
            }
        }
    }
    paths
}

fn ssh_key_paths() -> Vec<String> {
    let mut paths = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return paths;
    };
    let ssh = home.join(".ssh");
    for name in ["id_ed25519", "id_rsa", "id_ecdsa", "id_ed25519_sk", "id_ecdsa_sk"] {
        let path = ssh.join(name);
        if path.is_file() {
            paths.push(path.to_string_lossy().to_string());
        }
    }
    if let Ok(text) = std::fs::read_to_string(ssh.join("config")) {
        for path in identity_files_from_config(&text, &home) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(&ssh) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".pub") || name == "config" || name.starts_with("known_hosts") {
                continue;
            }
            let pub_path = ssh.join(format!("{name}.pub"));
            if !pub_path.is_file() {
                continue;
            }
            let value = path.to_string_lossy().to_string();
            if !paths.contains(&value) {
                paths.push(value);
            }
        }
    }
    if paths.is_empty() {
        for name in ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"] {
            let path = ssh.join(name);
            if path.is_file() {
                paths.push(path.to_string_lossy().to_string());
            }
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
    let agent = ssh_agent_present();
    let gpgsign = git_cli::config_get("commit.gpgsign")?
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on"))
        .unwrap_or(false);
    Ok(GitEnvSnapshot {
        credential_helper: git_cli::config_get("credential.helper")?.unwrap_or_default(),
        core_editor: git_cli::config_get("core.editor")?.unwrap_or_default(),
        diff_tool: git_cli::config_get("diff.tool")?.unwrap_or_default(),
        merge_tool: git_cli::config_get("merge.tool")?.unwrap_or_default(),
        ssh_keys_found: !keys.is_empty() || agent,
        ssh_key_paths: keys,
        ssh_agent: agent,
        commit_gpgsign: gpgsign,
        gpg_format: git_cli::config_get("gpg.format")?.unwrap_or_default(),
        user_signing_key: git_cli::config_get("user.signingkey")?.unwrap_or_default(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn expand_tilde_identity_paths() {
        let home = Path::new("/Users/sean");
        assert_eq!(
            expand_ssh_path("~/.ssh/SeanNortjeBigly-GitHub", home),
            home.join(".ssh/SeanNortjeBigly-GitHub")
        );
        assert_eq!(
            expand_ssh_path("/Users/sean/.ssh/id_ed25519", home),
            Path::new("/Users/sean/.ssh/id_ed25519")
        );
    }

    #[test]
    fn reads_sourcetree_identityfile_entries() {
        let config = r#"
Host github.com
	HostName github.com
	User SeanNortjeBigly
	IdentityFile /Users/sean/.ssh/SeanNortjeBigly-GitHub
Host bitbucket.org
	IdentityFile ~/.ssh/seannortje1-Bitbucket
"#;
        assert_eq!(
            identity_file_values(config),
            vec![
                "/Users/sean/.ssh/SeanNortjeBigly-GitHub".to_string(),
                "~/.ssh/seannortje1-Bitbucket".to_string(),
            ]
        );
    }
}
