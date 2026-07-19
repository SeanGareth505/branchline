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
pub struct PathsInput {
    pub path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutput {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchInput {
    pub path: String,
    pub patch: String,
    /// stage | unstage | discard
    pub mode: String,
}

#[command]
pub fn stage_paths(state: State<'_, AppState>, input: PathsInput) -> AppResult<MutationOutput> {
    git_cli::validate_pathspecs(&input.paths)?;
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if input.paths.is_empty() {
            return Err(AppError::msg("No paths to stage"));
        }
        let mut args = vec!["add", "--"];
        let path_refs: Vec<&str> = input.paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        git_cli::run_git(path, &args)?;
        let repo_key = path.to_string_lossy().to_string();
        {
            let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = undo::push_entry(
                &db,
                &repo_key,
                "stage",
                "Stage files",
                json!({ "paths": input.paths }),
            );
        }
        Ok(MutationOutput {
            ok: true,
            message: "Staged".into(),
        })
    })
}

#[command]
pub fn unstage_paths(state: State<'_, AppState>, input: PathsInput) -> AppResult<MutationOutput> {
    git_cli::validate_pathspecs(&input.paths)?;
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if input.paths.is_empty() {
            return Err(AppError::msg("No paths to unstage"));
        }
        let mut args = vec!["restore", "--staged", "--"];
        let path_refs: Vec<&str> = input.paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        git_cli::run_git(path, &args)?;
        let repo_key = path.to_string_lossy().to_string();
        {
            let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = undo::push_entry(
                &db,
                &repo_key,
                "unstage",
                "Unstage files",
                json!({ "paths": input.paths }),
            );
        }
        Ok(MutationOutput {
            ok: true,
            message: "Unstaged".into(),
        })
    })
}

#[command]
pub fn discard_paths(state: State<'_, AppState>, input: PathsInput) -> AppResult<MutationOutput> {
    git_cli::validate_pathspecs(&input.paths)?;
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if input.paths.is_empty() {
            return Err(AppError::msg("No paths to discard"));
        }

        let path_refs: Vec<&str> = input.paths.iter().map(|s| s.as_str()).collect();
        let mut stash_args = vec![
            "stash",
            "push",
            "-u",
            "-m",
            "branchline-discard-backup",
            "--",
        ];
        stash_args.extend(path_refs.iter().copied());
        let stash_ok = git_cli::run_git(path, &stash_args).is_ok();
        if !stash_ok {
            return Err(AppError::msg(
                "Could not create undo stash — discard cancelled to avoid losing work",
            ));
        }

        let stash_ref = git_cli::stash_tip_oid(path).unwrap_or_else(|_| "stash@{0}".into());
        let repo_key = path.to_string_lossy().to_string();
        {
            let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = undo::push_entry(
                &db,
                &repo_key,
                "discard",
                "Discard changes",
                json!({ "paths": input.paths, "stashRef": stash_ref }),
            );
        }

        Ok(MutationOutput {
            ok: true,
            message: "Discarded".into(),
        })
    })
}

#[command]
pub fn apply_patch(
    state: State<'_, AppState>,
    input: ApplyPatchInput,
) -> AppResult<MutationOutput> {
    let patch = input.patch.trim();
    if patch.is_empty() {
        return Err(AppError::msg("No patch to apply"));
    }
    if !patch.contains("diff --git") && !patch.contains("\n@@") && !patch.starts_with("@@") {
        return Err(AppError::msg("Invalid unified diff patch"));
    }

    let mode = input.mode.trim().to_ascii_lowercase();
    let (args, label, kind): (Vec<&str>, &str, &str) = match mode.as_str() {
        "stage" => (
            vec!["apply", "--cached", "--whitespace=nowarn", "-"],
            "Staged selected changes",
            "stage_patch",
        ),
        "unstage" => (
            vec!["apply", "--cached", "-R", "--whitespace=nowarn", "-"],
            "Unstaged selected changes",
            "unstage_patch",
        ),
        "discard" => (
            vec!["apply", "-R", "--whitespace=nowarn", "-"],
            "Discarded selected changes",
            "discard_patch",
        ),
        _ => {
            return Err(AppError::msg(
                "Invalid patch mode — use stage, unstage, or discard",
            ))
        }
    };

    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        git_cli::run_git_with_stdin(path, &args, &format!("{patch}\n"))?;
        let repo_key = path.to_string_lossy().to_string();
        {
            let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
            let _ = undo::push_entry(
                &db,
                &repo_key,
                kind,
                label,
                json!({ "mode": mode, "patch": patch }),
            );
        }
        Ok(MutationOutput {
            ok: true,
            message: label.into(),
        })
    })
}
