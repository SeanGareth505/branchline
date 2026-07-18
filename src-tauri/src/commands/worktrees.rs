use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::{MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub short_head: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorktreeInput {
    pub path: String,
    pub worktree_path: String,
    pub branch: Option<String>,
    pub create_branch: Option<bool>,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeInput {
    pub path: String,
    pub worktree_path: String,
    pub force: Option<bool>,
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn branch_name_from_ref(raw: &str) -> Option<String> {
    raw.strip_prefix("refs/heads/")
        .map(|s| s.to_string())
        .or_else(|| {
            if raw.is_empty() || raw == "detached" {
                None
            } else {
                Some(raw.to_string())
            }
        })
}

#[command]
pub fn list_worktrees(input: RepoPathInput) -> AppResult<Vec<WorktreeInfo>> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let out = git_cli::run_git(path, &["worktree", "list", "--porcelain"])?;
        if out.trim().is_empty() {
            return Ok(vec![]);
        }

        let main_path = path.to_string_lossy().to_string();
        let mut entries = Vec::new();
        let mut current: Option<WorktreeInfo> = None;

        for line in out.lines() {
            if line.is_empty() {
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }
                continue;
            }
            if let Some(wt_path) = line.strip_prefix("worktree ") {
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }
                let is_main = PathBuf::from(wt_path)
                    .canonicalize()
                    .ok()
                    .map(|p| p == *path)
                    .unwrap_or(wt_path == main_path);
                current = Some(WorktreeInfo {
                    path: wt_path.to_string(),
                    head: String::new(),
                    short_head: String::new(),
                    branch: None,
                    bare: false,
                    detached: false,
                    locked: false,
                    prunable: false,
                    is_main,
                });
                continue;
            }
            let Some(entry) = current.as_mut() else {
                continue;
            };
            if let Some(head) = line.strip_prefix("HEAD ") {
                entry.head = head.to_string();
                entry.short_head = short_sha(head);
            } else if let Some(branch) = line.strip_prefix("branch ") {
                entry.branch = branch_name_from_ref(branch);
            } else if line == "detached" {
                entry.detached = true;
            } else if line == "bare" {
                entry.bare = true;
            } else if line.starts_with("locked") {
                entry.locked = true;
            } else if line.starts_with("prunable") {
                entry.prunable = true;
            }
        }
        if let Some(entry) = current.take() {
            entries.push(entry);
        }

        Ok(entries)
    })
}

#[command]
pub fn add_worktree(input: AddWorktreeInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let wt = input.worktree_path.trim();
        if wt.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Worktree path is required".into(),
            });
        }

        let create_branch = input.create_branch.unwrap_or(false);
        let branch = input
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let start = input
            .start_point
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        if create_branch {
            let Some(branch_name) = branch else {
                return Ok(MutationOutput {
                    ok: false,
                    message: "Branch name is required when creating a new branch".into(),
                });
            };
            args.push("-b".into());
            args.push(branch_name);
            args.push(wt.into());
            if let Some(sp) = start {
                args.push(sp);
            }
        } else if let Some(branch_name) = branch {
            args.push(wt.into());
            args.push(branch_name);
        } else {
            args.push(wt.into());
            if let Some(sp) = start {
                args.push(sp);
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match git_cli::run_git(path, &arg_refs) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.is_empty() {
                    format!("Added worktree at {wt}")
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn remove_worktree(input: RemoveWorktreeInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let wt = input.worktree_path.trim();
        if wt.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Worktree path is required".into(),
            });
        }

        let resolved_main = path.to_path_buf();
        if PathBuf::from(wt)
            .canonicalize()
            .ok()
            .map(|p| p == resolved_main)
            .unwrap_or(false)
        {
            return Ok(MutationOutput {
                ok: false,
                message: "Cannot remove the main worktree".into(),
            });
        }

        let mut args = vec!["worktree", "remove"];
        if input.force.unwrap_or(false) {
            args.push("--force");
        }
        args.push(wt);

        match git_cli::run_git(path, &args) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.is_empty() {
                    format!("Removed worktree {wt}")
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn prune_worktrees(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let out = git_cli::run_git(path, &["worktree", "prune"])?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Pruned stale worktrees".into()
            } else {
                out
            },
        })
    })
}
