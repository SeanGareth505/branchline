use crate::domain::undo;
use crate::infrastructure::{git2_repo, git_cli, sqlite};
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPathInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameInput {
    pub path: String,
    pub name: String,
    pub checkout: Option<bool>,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutBranchInput {
    pub path: String,
    pub name: String,
    pub create: Option<bool>,
    /// keep (default) | merge | force — Git Extensions local-changes modes
    #[serde(default)]
    pub local_changes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchInput {
    pub path: String,
    pub name: String,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchInput {
    pub path: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteActionInput {
    pub path: String,
    pub force_with_lease: Option<bool>,
    pub remote: Option<String>,
    #[serde(default)]
    pub set_upstream: Option<bool>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub skip_hooks: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutput {
    pub ok: bool,
    pub message: String,
}

fn ensure_not_locked(state: &AppState, repo_path: &str, branch_name: &str) -> AppResult<()> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(lock) = sqlite::get_branch_lock(&db, repo_path, branch_name)? {
        return Err(AppError::msg(sqlite::lock_block_message(
            branch_name,
            lock.reason.as_deref(),
        )));
    }
    Ok(())
}

#[command]
pub async fn list_branches(
    state: State<'_, AppState>,
    input: RepoPathInput,
) -> AppResult<Vec<git2_repo::BranchInfo>> {
    let path = PathBuf::from(&input.path);
    let (locks, tickets) = {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        (
            sqlite::list_branch_locks(&db, &input.path)?,
            sqlite::list_branch_tickets(&db, &input.path)?,
        )
    };
    run_blocking(move || {
        git_cli::with_repo_lock(&path, |resolved| {
            let mut branches = git2_repo::list_branches(resolved)?;
            let lock_map: std::collections::HashMap<String, Option<String>> = locks
                .into_iter()
                .map(|l| (l.branch_name, l.reason))
                .collect();
            let ticket_map: std::collections::HashMap<String, String> = tickets
                .into_iter()
                .map(|t| (t.branch_name, t.issue_key))
                .collect();
            for branch in &mut branches {
                if let Some(reason) = lock_map.get(&branch.name) {
                    branch.locked = true;
                    branch.lock_reason = reason.clone();
                }
                if let Some(key) = ticket_map.get(&branch.name) {
                    branch.jira_key = Some(key.clone());
                }
            }
            Ok(branches)
        })
    })
    .await
}

#[command]
pub fn create_branch(
    state: State<'_, AppState>,
    input: BranchNameInput,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let start = input.start_point.as_deref();
    if input.checkout.unwrap_or(false) {
        if let Some(sp) = start {
            git_cli::run_git(&path, &["checkout", "-b", &input.name, sp])?;
        } else {
            git_cli::run_git(&path, &["checkout", "-b", &input.name])?;
        }
    } else if let Some(sp) = start {
        git_cli::run_git(&path, &["branch", &input.name, sp])?;
    } else {
        git_cli::run_git(&path, &["branch", &input.name])?;
    }
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let recorded = undo::try_push_entry(
            &db,
            &input.path,
            "branch_create",
            "Create branch",
            json!({ "name": input.name, "startPoint": start }),
        );
        Ok(MutationOutput {
            ok: true,
            message: undo::message_with_undo(format!("Created branch {}", input.name), recorded),
        })
    }
}

#[command]
pub fn checkout_branch(input: CheckoutBranchInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    if input.create.unwrap_or(false) {
        git_cli::run_git(&path, &["checkout", "-b", &input.name])?;
    } else {
        let mode = input
            .local_changes
            .as_deref()
            .unwrap_or("keep")
            .trim()
            .to_ascii_lowercase();
        match mode.as_str() {
            "merge" => {
                git_cli::run_git(&path, &["checkout", "-m", &input.name])?;
            }
            "force" | "reset" => {
                git_cli::run_git(&path, &["checkout", "-f", &input.name])?;
            }
            _ => {
                git_cli::run_git(&path, &["checkout", &input.name])?;
            }
        }
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Checked out {}", input.name),
    })
}

#[command]
pub fn delete_branch(
    state: State<'_, AppState>,
    input: DeleteBranchInput,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    ensure_not_locked(&state, &input.path, &input.name)?;

    if git2_repo::is_remote_tracking_name(&path, &input.name) {
        let (remote, branch) = git2_repo::parse_remote_tracking_name(&input.name)
            .ok_or_else(|| AppError::msg(format!("Invalid remote-tracking ref '{}'", input.name)))?;
        git_cli::run_git(&path, &["push", &remote, "--delete", &branch])?;
        let _ = git_cli::run_git(&path, &["branch", "-dr", &input.name]);
        return Ok(MutationOutput {
            ok: true,
            message: format!("Deleted '{remote}/{branch}' on remote"),
        });
    }

    let flag = if input.force.unwrap_or(false) {
        "-D"
    } else {
        "-d"
    };
    git_cli::run_git(&path, &["branch", flag, &input.name])?;
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = sqlite::unlock_branch(&db, &input.path, &input.name);
        let _ = sqlite::unlink_branch_ticket(&db, &input.path, &input.name);
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Deleted branch {}", input.name),
    })
}

#[command]
pub fn rename_branch(
    state: State<'_, AppState>,
    input: RenameBranchInput,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    ensure_not_locked(&state, &input.path, &input.from)?;
    git_cli::run_git(&path, &["branch", "-m", &input.from, &input.to])?;
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let recorded = undo::try_push_entry(
        &db,
        &input.path,
        "branch_rename",
        "Rename branch",
        json!({ "from": input.from, "to": input.to }),
    );
    let _ = sqlite::rename_branch_ticket(&db, &input.path, &input.from, &input.to);
    Ok(MutationOutput {
        ok: true,
        message: undo::message_with_undo(
            format!("Renamed {} → {}", input.from, input.to),
            recorded,
        ),
    })
}

#[command]
pub fn fetch(input: RemoteActionInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let args = git_cli::fetch_args(input.remote.as_deref());
        let out = git_cli::run_git_strings(path, &args)?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Fetched".into()
            } else {
                out
            },
        })
    })
}

#[command]
pub fn pull(input: RemoteActionInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let args = git_cli::pull_args(input.remote.as_deref(), false);
        match git_cli::run_git_strings(path, &args) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.is_empty() { "Pulled".into() } else { out },
            }),
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("conflict") {
                    Ok(MutationOutput {
                        ok: false,
                        message: format!(
                            "Pull conflicts — resolve files, then Continue. {msg}"
                        ),
                    })
                } else {
                    Err(e)
                }
            }
        }
    })
}

#[command]
pub fn push(state: State<'_, AppState>, input: RemoteActionInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let branch = input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(git2_repo::current_branch(&path)?);
    ensure_not_locked(&state, &input.path, &branch)?;
    let remote = input
        .remote
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| git2_repo::configured_remote(&path, &branch))
        .unwrap_or_else(|| "origin".to_string());
    let needs_upstream = !git2_repo::branch_has_upstream(&path, &branch);
    let set_upstream = needs_upstream && input.set_upstream.unwrap_or(true);

    let mut args = Vec::with_capacity(7);
    args.push("push");
    if input.force_with_lease.unwrap_or(false) {
        args.push("--force-with-lease");
    }
    if input.skip_hooks.unwrap_or(false) {
        args.push("--no-verify");
    }
    if set_upstream {
        args.push("-u");
    }
    args.push(remote.as_str());
    args.push(branch.as_str());

    git_cli::with_repo_lock(&path, |path| {
        let out = git_cli::run_git(path, &args)?;
        Ok(MutationOutput {
            ok: true,
            message: if !out.is_empty() {
                out
            } else if set_upstream {
                format!("Pushed and set upstream to {remote}/{branch}")
            } else {
                "Pushed".into()
            },
        })
    })
}
