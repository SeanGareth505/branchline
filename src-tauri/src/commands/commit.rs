use super::branch::run_git_with_process_output;
use crate::domain::undo;
use crate::infrastructure::git_cli;
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::{command, AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommitInput {
    pub path: String,
    pub message: String,
    pub amend: Option<bool>,
    pub allow_empty: Option<bool>,
    #[serde(default)]
    pub skip_hooks: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommitOutput {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
}

struct CreatedCommit {
    output: CreateCommitOutput,
    amend: bool,
    previous_head: Option<String>,
    repo_key: String,
}

fn create_commit_inner(app: &AppHandle, input: CreateCommitInput) -> AppResult<CreatedCommit> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let amend = input.amend.unwrap_or(false);
        let allow_empty = input.allow_empty.unwrap_or(true);
        let message = input.message.trim().to_string();
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
        args.push("--allow-empty");
        if input.skip_hooks.unwrap_or(false) {
            args.push("--no-verify");
        }
        if message.is_empty() {
            args.push("--allow-empty-message");
            args.push("-m");
            args.push("");
        } else {
            args.push("-m");
            args.push(message.as_str());
        }
        run_git_with_process_output(app, path, &args, "commit")?;

        let sha = git_cli::run_git(path, &["rev-parse", "HEAD"])?;
        let short_sha = git_cli::run_git(path, &["rev-parse", "--short", "HEAD"])?;

        Ok(CreatedCommit {
            output: CreateCommitOutput {
                sha,
                short_sha,
                message,
            },
            amend,
            previous_head,
            repo_key: path.to_string_lossy().to_string(),
        })
    })
}

#[command]
pub async fn create_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateCommitInput,
) -> AppResult<CreateCommitOutput> {
    let created = run_blocking(move || create_commit_inner(&app, input)).await?;
    {
        let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
        let _ = undo::try_push_entry(
            &db,
            &created.repo_key,
            "commit",
            if created.amend {
                "Amend commit"
            } else {
                "Create commit"
            },
            json!({
                "sha": created.output.sha,
                "amend": created.amend,
                "previousHead": created.previous_head,
            }),
        );
    }
    Ok(created.output)
}
