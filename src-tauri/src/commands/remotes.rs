use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::{MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteInput {
    pub path: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRemoteInput {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullInput {
    pub path: String,
    pub remote: Option<String>,
    pub rebase: Option<bool>,
}

#[command]
pub fn list_remotes(input: RepoPathInput) -> AppResult<Vec<RemoteInfo>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) = git_cli::run_git_allow_fail(&path, &["remote", "-v"]);
    if !ok || out.trim().is_empty() {
        return Ok(vec![]);
    }

    let mut map: std::collections::BTreeMap<String, RemoteInfo> = std::collections::BTreeMap::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].to_string();
        let url = parts[1].to_string();
        let kind = parts[2].trim_matches(|c| c == '(' || c == ')');
        let entry = map.entry(name.clone()).or_insert(RemoteInfo {
            name,
            fetch_url: String::new(),
            push_url: String::new(),
        });
        if kind == "fetch" {
            entry.fetch_url = url;
        } else if kind == "push" {
            entry.push_url = url;
        }
    }
    Ok(map.into_values().collect())
}

#[command]
pub fn add_remote(input: AddRemoteInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    let url = input.url.trim();
    if name.is_empty() || url.is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Remote name and URL are required".into(),
        });
    }
    git_cli::run_git(&path, &["remote", "add", name, url])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Added remote {name}"),
    })
}

#[command]
pub fn remove_remote(input: RemoveRemoteInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    git_cli::run_git(&path, &["remote", "remove", &input.name])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Removed remote {}", input.name),
    })
}

#[command]
pub fn pull_with_options(input: PullInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let remote = input.remote.as_deref().unwrap_or("origin");
    let out = if input.rebase.unwrap_or(false) {
        git_cli::run_git(&path, &["pull", "--rebase", remote])?
    } else {
        git_cli::run_git(&path, &["pull", remote])?
    };
    Ok(MutationOutput {
        ok: true,
        message: if out.is_empty() {
            if input.rebase.unwrap_or(false) {
                "Pulled with rebase".into()
            } else {
                "Pulled".into()
            }
        } else {
            out
        },
    })
}
