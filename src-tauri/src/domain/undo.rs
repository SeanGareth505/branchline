use crate::infrastructure::sqlite::{self, Db, UndoJournalRow};
use crate::AppResult;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntry {
    pub id: String,
    pub repo_path: String,
    pub action: String,
    pub label: String,
    pub payload: Value,
    pub created_at: String,
    pub restored: bool,
}

impl From<UndoJournalRow> for UndoEntry {
    fn from(row: UndoJournalRow) -> Self {
        let payload = serde_json::from_str(&row.payload_json).unwrap_or(Value::Null);
        Self {
            id: row.id,
            repo_path: row.repo_path,
            action: row.action,
            label: row.label,
            payload,
            created_at: row.created_at,
            restored: row.restored,
        }
    }
}

pub fn push_entry(
    db: &Db,
    repo_path: &str,
    action: &str,
    label: &str,
    payload: Value,
) -> AppResult<UndoEntry> {
    let entry = UndoEntry {
        id: Uuid::new_v4().to_string(),
        repo_path: repo_path.to_string(),
        action: action.to_string(),
        label: label.to_string(),
        payload: payload.clone(),
        created_at: Utc::now().to_rfc3339(),
        restored: false,
    };
    let row = UndoJournalRow {
        id: entry.id.clone(),
        repo_path: entry.repo_path.clone(),
        action: entry.action.clone(),
        label: entry.label.clone(),
        payload_json: serde_json::to_string(&payload)?,
        created_at: entry.created_at.clone(),
        restored: false,
    };
    sqlite::insert_undo_entry(db, &row)?;
    Ok(entry)
}

pub fn list_entries(db: &Db, repo_path: Option<&str>, limit: i64) -> AppResult<Vec<UndoEntry>> {
    let rows = sqlite::list_undo_entries(db, repo_path, limit)?;
    Ok(rows.into_iter().map(UndoEntry::from).collect())
}

pub fn undo_last(db: &Db, repo_path: &str) -> AppResult<Option<UndoEntry>> {
    let Some(row) = sqlite::latest_undo_entry(db, repo_path)? else {
        return Ok(None);
    };
    let entry = UndoEntry::from(row);
    restore(db, &entry)?;
    sqlite::mark_undo_restored(db, &entry.id)?;
    Ok(Some(UndoEntry {
        restored: true,
        ..entry
    }))
}

fn restore(db: &Db, entry: &UndoEntry) -> AppResult<()> {
    use crate::infrastructure::git_cli;
    use std::path::Path;
    let path = Path::new(&entry.repo_path);
    match entry.action.as_str() {
        "commit" => {
            let _ = db;
            let amend = entry
                .payload
                .get("amend")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if amend {
                if let Some(previous) = entry.payload.get("previousHead").and_then(|v| v.as_str()) {
                    git_cli::run_git(path, &["reset", "--soft", previous])?;
                } else {
                    return Err(crate::AppError::msg(
                        "Cannot undo amend — previous HEAD was not recorded",
                    ));
                }
            } else {
                git_cli::run_git(path, &["reset", "--soft", "HEAD~1"])?;
            }
        }
        "stage" => {
            if let Some(paths) = entry.payload.get("paths").and_then(|v| v.as_array()) {
                let list: Vec<&str> = paths.iter().filter_map(|v| v.as_str()).collect();
                if !list.is_empty() {
                    let mut args = vec!["restore", "--staged"];
                    args.extend(list);
                    git_cli::run_git(path, &args)?;
                }
            }
        }
        "unstage" => {
            if let Some(paths) = entry.payload.get("paths").and_then(|v| v.as_array()) {
                let list: Vec<&str> = paths.iter().filter_map(|v| v.as_str()).collect();
                if !list.is_empty() {
                    let mut args = vec!["add", "--"];
                    args.extend(list);
                    git_cli::run_git(path, &args)?;
                }
            }
        }
        "discard" => {
            if let Some(stash_ref) = entry.payload.get("stashRef").and_then(|v| v.as_str()) {
                git_cli::run_git(path, &["stash", "apply", stash_ref])?;
            }
        }
        "stage_patch" => {
            if let Some(patch) = entry.payload.get("patch").and_then(|v| v.as_str()) {
                git_cli::run_git_with_stdin(
                    path,
                    &["apply", "--cached", "-R", "--whitespace=nowarn", "-"],
                    &format!("{patch}\n"),
                )?;
            }
        }
        "unstage_patch" => {
            if let Some(patch) = entry.payload.get("patch").and_then(|v| v.as_str()) {
                git_cli::run_git_with_stdin(
                    path,
                    &["apply", "--cached", "--whitespace=nowarn", "-"],
                    &format!("{patch}\n"),
                )?;
            }
        }
        "discard_patch" => {
            if let Some(patch) = entry.payload.get("patch").and_then(|v| v.as_str()) {
                git_cli::run_git_with_stdin(
                    path,
                    &["apply", "--whitespace=nowarn", "-"],
                    &format!("{patch}\n"),
                )?;
            }
        }
        "hard_reset" => {
            if let Some(backup) = entry.payload.get("backupBranch").and_then(|v| v.as_str()) {
                git_cli::run_git(path, &["reset", "--hard", backup])?;
            } else if let Some(previous) = entry.payload.get("previousHead").and_then(|v| v.as_str()) {
                git_cli::run_git(path, &["reset", "--hard", previous])?;
            }
        }
        "branch_create" => {
            if let Some(name) = entry.payload.get("name").and_then(|v| v.as_str()) {
                git_cli::run_git(path, &["branch", "-D", name])?;
            }
        }
        "branch_rename" => {
            if let (Some(from), Some(to)) = (
                entry.payload.get("from").and_then(|v| v.as_str()),
                entry.payload.get("to").and_then(|v| v.as_str()),
            ) {
                git_cli::run_git(path, &["branch", "-m", to, from])?;
            }
        }
        _ => {}
    }
    Ok(())
}
