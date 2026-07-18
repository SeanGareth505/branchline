use crate::infrastructure::{git_cli, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocksInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockBranchInput {
    pub path: String,
    pub name: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockBranchInput {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchLockInfo {
    pub branch_name: String,
    pub reason: Option<String>,
    pub locked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutput {
    pub ok: bool,
    pub message: String,
}

#[command]
pub fn list_branch_locks(
    state: State<'_, AppState>,
    input: ListLocksInput,
) -> AppResult<Vec<BranchLockInfo>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let locks = sqlite::list_branch_locks(&db, &input.path)?;
    Ok(locks
        .into_iter()
        .map(|row| BranchLockInfo {
            branch_name: row.branch_name,
            reason: row.reason,
            locked_at: row.locked_at,
        })
        .collect())
}

#[command]
pub fn lock_branch(
    state: State<'_, AppState>,
    input: LockBranchInput,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name is required"));
    }
    if name.contains('/') && name.starts_with("origin/") {
        return Err(AppError::msg("Lock local branches only"));
    }
    let reason = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    let locked_at = chrono::Utc::now().to_rfc3339();
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::lock_branch(&db, &input.path, name, reason, &locked_at)?;
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Locked branch {name}"),
    })
}

#[command]
pub fn unlock_branch(
    state: State<'_, AppState>,
    input: UnlockBranchInput,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name is required"));
    }
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if !sqlite::is_branch_locked(&db, &input.path, name)? {
            return Ok(MutationOutput {
                ok: true,
                message: format!("Branch {name} was not locked"),
            });
        }
        sqlite::unlock_branch(&db, &input.path, name)?;
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Unlocked branch {name}"),
    })
}
