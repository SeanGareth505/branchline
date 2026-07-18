use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreFileInput {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreFileOutput {
    pub kind: String,
    pub file_path: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveIgnoreFileInput {
    pub path: String,
    pub kind: String,
    pub content: String,
}

fn resolve_ignore_path(repo: &Path, kind: &str) -> AppResult<(String, PathBuf)> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "gitignore" | "root" => Ok(("gitignore".into(), repo.join(".gitignore"))),
        "exclude" | "local" => {
            let (ok, git_dir, err) = git_cli::run_git_allow_fail(repo, &["rev-parse", "--git-dir"]);
            if !ok {
                return Err(crate::AppError::msg(if err.trim().is_empty() {
                    "Could not resolve git directory".into()
                } else {
                    err.trim().to_string()
                }));
            }
            let git_dir = PathBuf::from(git_dir.trim());
            let abs = if git_dir.is_absolute() {
                git_dir
            } else {
                repo.join(git_dir)
            };
            Ok(("exclude".into(), abs.join("info/exclude")))
        }
        other => Err(crate::AppError::msg(format!(
            "Unknown ignore kind: {other}. Use gitignore or exclude."
        ))),
    }
}

#[command]
pub fn get_ignore_file(input: IgnoreFileInput) -> AppResult<IgnoreFileOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (kind, file_path) = resolve_ignore_path(path, &input.kind)?;
        let exists = file_path.exists();
        let content = if exists {
            fs::read_to_string(&file_path)
                .map_err(|e| crate::AppError::msg(format!("Failed to read ignore file: {e}")))?
        } else {
            String::new()
        };
        Ok(IgnoreFileOutput {
            kind,
            file_path: file_path.to_string_lossy().to_string(),
            content,
            exists,
        })
    })
}

#[command]
pub fn save_ignore_file(input: SaveIgnoreFileInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (kind, file_path) = resolve_ignore_path(path, &input.kind)?;
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| crate::AppError::msg(format!("Failed to create ignore directory: {e}")))?;
        }
        let content = if input.content.ends_with('\n') || input.content.is_empty() {
            input.content.clone()
        } else {
            format!("{}\n", input.content)
        };
        fs::write(&file_path, content)
            .map_err(|e| crate::AppError::msg(format!("Failed to write ignore file: {e}")))?;
        Ok(MutationOutput {
            ok: true,
            message: format!("Saved {kind}"),
        })
    })
}
