use crate::domain::undo;
use crate::infrastructure::git_cli;
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommitInput {
    pub path: String,
    pub message: String,
    pub amend: Option<bool>,
    pub allow_empty: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommitOutput {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
}

#[command]
pub fn create_commit(
    state: State<'_, AppState>,
    input: CreateCommitInput,
) -> AppResult<CreateCommitOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let amend = input.amend.unwrap_or(false);
        let allow_empty = input.allow_empty.unwrap_or(false);
        let message = input.message.trim();
        if message.is_empty() && !allow_empty {
            return Err(AppError::msg("Commit message is required"));
        }

        let previous_head = if amend {
            Some(git_cli::run_git(path, &["rev-parse", "HEAD"])?)
        } else {
            None
        };

        let mut args: Vec<&str> = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        if allow_empty {
            args.push("--allow-empty");
        }
        if message.is_empty() {
            args.push("--allow-empty-message");
            args.push("-m");
            args.push("");
        } else {
            args.push("-m");
            args.push(message);
        }
        git_cli::run_git(path, &args)?;

        let sha = git_cli::run_git(path, &["rev-parse", "HEAD"])?;
        let short_sha = git_cli::run_git(path, &["rev-parse", "--short", "HEAD"])?;
        let repo_key = path.to_string_lossy().to_string();

        {
            let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = undo::push_entry(
                &db,
                &repo_key,
                "commit",
                if amend {
                    "Amend commit"
                } else {
                    "Create commit"
                },
                json!({
                    "sha": sha,
                    "amend": amend,
                    "previousHead": previous_head,
                }),
            );
        }

        Ok(CreateCommitOutput {
            sha,
            short_sha,
            message: message.to_string(),
        })
    })
}
