use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::{MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: i32,
    pub id: String,
    pub message: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashMessageInput {
    pub path: String,
    pub message: Option<String>,
    pub include_untracked: Option<bool>,
    /// When set, only these paths are stashed (Git Extensions–style conflict stash).
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashIndexInput {
    pub path: String,
    pub index: i32,
}

#[command]
pub fn list_stashes(input: RepoPathInput) -> AppResult<Vec<StashEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) =
        git_cli::run_git_allow_fail(&path, &["stash", "list", "--pretty=format:%gd|%H|%gs"]);
    if !ok || out.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for (i, line) in out.lines().enumerate() {
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        let id = parts[0].trim().to_string();
        let message = parts[2].trim().to_string();
        let branch = message
            .strip_prefix("WIP on ")
            .or_else(|| message.strip_prefix("On "))
            .and_then(|rest| rest.split(':').next())
            .map(|s| s.trim().to_string());
        entries.push(StashEntry {
            index: i as i32,
            id,
            message,
            branch,
        });
    }
    Ok(entries)
}

#[command]
pub fn stash_push(input: StashMessageInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let message = input
            .message
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let include_untracked = input.include_untracked.unwrap_or(false);
        let path_list: Vec<String> = input
            .paths
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if !path_list.is_empty() {
            git_cli::validate_pathspecs(&path_list)?;
        }

        let mut args: Vec<&str> = vec!["stash", "push"];
        if include_untracked {
            args.push("-u");
        }
        if let Some(msg) = message.as_deref() {
            args.push("-m");
            args.push(msg);
        }
        if !path_list.is_empty() {
            args.push("--");
            for p in &path_list {
                args.push(p.as_str());
            }
        }

        let out = git_cli::run_git(path, &args)?;
        let n = path_list.len();
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                if n == 0 {
                    "Stashed changes".into()
                } else {
                    format!("Stashed {n} conflicting file(s)")
                }
            } else {
                out
            },
        })
    })
}

#[command]
pub fn stash_pop(input: StashIndexInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let refname = format!("stash@{{{}}}", input.index);
        let out = git_cli::run_git(path, &["stash", "pop", &refname])?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Applied and dropped stash".into()
            } else {
                out
            },
        })
    })
}

#[command]
pub fn stash_apply(input: StashIndexInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let refname = format!("stash@{{{}}}", input.index);
        let out = git_cli::run_git(path, &["stash", "apply", &refname])?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Applied stash".into()
            } else {
                out
            },
        })
    })
}

#[command]
pub fn stash_drop(input: StashIndexInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let refname = format!("stash@{{{}}}", input.index);
        let out = git_cli::run_git(path, &["stash", "drop", &refname])?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Dropped stash".into()
            } else {
                out
            },
        })
    })
}
