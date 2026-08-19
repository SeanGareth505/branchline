use crate::domain::undo;
use crate::infrastructure::{git2_repo, git_cli, sqlite};
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Emitter, State};

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
    #[serde(default)]
    pub all_remotes: bool,
    #[serde(default)]
    pub prune: bool,
    #[serde(default)]
    pub tags: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutput {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitProcessOutputEvent {
    path: String,
    kind: String,
    chunk: String,
}

pub(crate) fn run_git_with_process_output(
    app: &AppHandle,
    path: &Path,
    args: &[&str],
    kind: &str,
) -> AppResult<(String, String)> {
    let app = app.clone();
    let event_path = path.to_string_lossy().to_string();
    let event_kind = kind.to_string();
    git_cli::run_git_out_err_stream(path, args, move |chunk| {
        let _ = app.emit(
            "git-process-output",
            GitProcessOutputEvent {
                path: event_path.clone(),
                kind: event_kind.clone(),
                chunk,
            },
        );
    })
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
        git_cli::resolve_repo_path(&path).and_then(|resolved| {
            let mut branches = git2_repo::list_branches(&resolved)?;
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
pub fn fetch(app: AppHandle, input: RemoteActionInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let args = git_cli::fetch_args(
            input.remote.as_deref(),
            input.all_remotes,
            input.prune,
            input.tags,
        );
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (stdout, stderr) = run_git_with_process_output(&app, path, &refs, "fetch")?;
        let message = git_cli::combine_git_output(&stdout, &stderr);
        Ok(MutationOutput {
            ok: true,
            message: if message.is_empty() {
                "Already up to date".into()
            } else {
                message
            },
        })
    })
}

#[command]
pub fn pull(app: AppHandle, input: RemoteActionInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let args = git_cli::pull_args(input.remote.as_deref(), false);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_git_with_process_output(&app, path, &refs, "pull") {
            Ok((stdout, stderr)) => {
                let message = git_cli::combine_git_output(&stdout, &stderr);
                Ok(MutationOutput {
                    ok: true,
                    message: if message.is_empty() {
                        "Pulled".into()
                    } else {
                        message
                    },
                })
            }
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

fn resolve_push_branch(path: &PathBuf, requested: Option<&str>) -> AppResult<String> {
    git_cli::ensure_repo(path)?;
    Ok(requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(git2_repo::current_branch(path)?))
}

fn push_inner(
    app: AppHandle,
    input: RemoteActionInput,
    branch: String,
) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
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

    let mut args = Vec::with_capacity(8);
    args.push("push");
    args.push("--progress");
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
        let (stdout, stderr) = run_git_with_process_output(&app, path, &args, "push")?;
        let out = git_cli::combine_git_output(&stdout, &stderr);
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

#[command]
pub async fn push(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RemoteActionInput,
) -> AppResult<MutationOutput> {
    let repo_path = input.path.clone();
    let requested_branch = input.branch.clone();
    let branch = run_blocking(move || {
        resolve_push_branch(&PathBuf::from(&repo_path), requested_branch.as_deref())
    })
    .await?;
    ensure_not_locked(&state, &input.path, &branch)?;
    run_blocking(move || push_inner(app, input, branch)).await
}
