use crate::domain::undo;
use crate::infrastructure::{git2_repo, git_cli, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
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
pub fn list_branches(
    state: State<'_, AppState>,
    input: RepoPathInput,
) -> AppResult<Vec<git2_repo::BranchInfo>> {
    let path = PathBuf::from(&input.path);
    let mut branches = git2_repo::list_branches(&path)?;
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let locks = sqlite::list_branch_locks(&db, &input.path)?;
    let lock_map: std::collections::HashMap<String, Option<String>> = locks
        .into_iter()
        .map(|l| (l.branch_name, l.reason))
        .collect();
    for branch in &mut branches {
        if let Some(reason) = lock_map.get(&branch.name) {
            branch.locked = true;
            branch.lock_reason = reason.clone();
        }
    }
    Ok(branches)
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
        let _ = undo::push_entry(
            &db,
            &input.path,
            "branch_create",
            "Create branch",
            json!({ "name": input.name, "startPoint": start }),
        );
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Created branch {}", input.name),
    })
}

#[command]
pub fn checkout_branch(input: CheckoutBranchInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    if input.create.unwrap_or(false) {
        git_cli::run_git(&path, &["checkout", "-b", &input.name])?;
    } else {
        git_cli::run_git(&path, &["checkout", &input.name])?;
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
    let flag = if input.force.unwrap_or(false) {
        "-D"
    } else {
        "-d"
    };
    git_cli::run_git(&path, &["branch", flag, &input.name])?;
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = sqlite::unlock_branch(&db, &input.path, &input.name);
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
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = undo::push_entry(
            &db,
            &input.path,
            "branch_rename",
            "Rename branch",
            json!({ "from": input.from, "to": input.to }),
        );
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Renamed {} → {}", input.from, input.to),
    })
}

#[command]
pub fn fetch(input: RemoteActionInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let remote = input.remote.as_deref().unwrap_or("origin");
    let out = git_cli::run_git(&path, &["fetch", remote])?;
    Ok(MutationOutput {
        ok: true,
        message: if out.is_empty() {
            "Fetched".into()
        } else {
            out
        },
    })
}

#[command]
pub fn pull(input: RemoteActionInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let remote = input.remote.as_deref().unwrap_or("origin");
    let out = git_cli::run_git(&path, &["pull", remote])?;
    Ok(MutationOutput {
        ok: true,
        message: if out.is_empty() { "Pulled".into() } else { out },
    })
}

#[command]
pub fn push(state: State<'_, AppState>, input: RemoteActionInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let branch = git2_repo::current_branch(&path)?;
    ensure_not_locked(&state, &input.path, &branch)?;
    let remote = input.remote.as_deref().unwrap_or("origin");
    let mut args = vec!["push", remote];
    if input.force_with_lease.unwrap_or(false) {
        args.insert(1, "--force-with-lease");
    }
    let out = git_cli::run_git(&path, &args)?;
    Ok(MutationOutput {
        ok: true,
        message: if out.is_empty() { "Pushed".into() } else { out },
    })
}
