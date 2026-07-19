use crate::infrastructure::{git2_repo, git_cli, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::command;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened_at: String,
    pub pinned: bool,
    pub is_last: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRepoInput {
    pub path: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub has_changes: bool,
}

fn repo_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[command]
pub fn list_recent_repos(state: State<'_, AppState>) -> AppResult<Vec<RecentRepo>> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let rows = sqlite::list_recent_repos(&db)?;
    Ok(rows
        .into_iter()
        .map(|r| RecentRepo {
            path: r.path,
            name: r.name,
            last_opened_at: r.last_opened_at,
            pinned: r.pinned,
            is_last: r.is_last,
        })
        .collect())
}

#[command]
pub fn add_recent_repo(state: State<'_, AppState>, input: PathInput) -> AppResult<Vec<RecentRepo>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = repo_name(&path);
    let opened_at = Utc::now().to_rfc3339();
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::upsert_recent_repo(&db, &input.path, &name, &opened_at)?;
    }
    list_recent_repos(state)
}

#[command]
pub fn remove_recent_repo(
    state: State<'_, AppState>,
    input: PathInput,
) -> AppResult<Vec<RecentRepo>> {
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::remove_recent_repo(&db, &input.path)?;
    }
    list_recent_repos(state)
}

#[command]
pub fn pin_repo(state: State<'_, AppState>, input: PinRepoInput) -> AppResult<Vec<RecentRepo>> {
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::pin_repo(&db, &input.path, input.pinned)?;
    }
    list_recent_repos(state)
}

#[command]
pub fn set_last_repo(state: State<'_, AppState>, input: PathInput) -> AppResult<Vec<RecentRepo>> {
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::set_last_repo(&db, &input.path)?;
    }
    state.set_current_repo(Some(PathBuf::from(&input.path)));
    list_recent_repos(state)
}

#[command]
pub fn open_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PathInput,
) -> AppResult<RepoSummary> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = repo_name(&path);
    let opened_at = Utc::now().to_rfc3339();
    let status = git2_repo::repo_status(&path)?;
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        sqlite::upsert_recent_repo(&db, &input.path, &name, &opened_at)?;
        sqlite::set_last_repo(&db, &input.path)?;
    }
    state.set_current_repo(Some(path.clone()));
    state.repo_watcher.watch(app, path);
    let has_changes = !status.staged.is_empty()
        || !status.unstaged.is_empty()
        || !status.untracked.is_empty()
        || !status.conflicted.is_empty();
    Ok(RepoSummary {
        path: input.path,
        name,
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        has_changes,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepoInput {
    pub url: String,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitRepoInput {
    pub path: String,
}

#[command]
pub fn clone_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CloneRepoInput,
) -> AppResult<RepoSummary> {
    let url = input.url.trim();
    let dest = PathBuf::from(input.destination.trim());
    if url.is_empty() {
        return Err(AppError::msg("Clone URL is required"));
    }
    if input.destination.trim().is_empty() {
        return Err(AppError::msg("Destination folder is required"));
    }
    if dest.exists() {
        let is_empty = std::fs::read_dir(&dest)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(AppError::msg(format!(
                "Destination is not empty: {}",
                dest.display()
            )));
        }
    } else {
        std::fs::create_dir_all(&dest)
            .map_err(|e| AppError::msg(format!("Could not create destination: {e}")))?;
    }
    let parent = dest
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let folder = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    git_cli::run_git(&parent, &["clone", url, &folder])?;
    open_repository(
        app,
        state,
        PathInput {
            path: dest.to_string_lossy().to_string(),
        },
    )
}

#[command]
pub fn init_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    input: InitRepoInput,
) -> AppResult<RepoSummary> {
    let path = PathBuf::from(input.path.trim());
    if input.path.trim().is_empty() {
        return Err(AppError::msg("Folder path is required"));
    }
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| AppError::msg(format!("Could not create folder: {e}")))?;
    }
    git_cli::run_git(&path, &["init"])?;
    open_repository(
        app,
        state,
        PathInput {
            path: path.to_string_lossy().to_string(),
        },
    )
}
